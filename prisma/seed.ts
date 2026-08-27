/**
 * Development seed — creates a test shop, customer, saved address, a live auth
 * session with a KNOWN token (printed at the end), and one OPEN checkout request.
 * Refuses to run in production.
 *
 * Run: npm run db:seed   (see SETUP.md)
 */
import { PrismaClient, PgProvider, RequestStatus } from "@prisma/client";
import { createHash, createCipheriv, randomBytes } from "node:crypto";

const prisma = new PrismaClient();

const DEV_SHOP_DOMAIN = process.env.SEED_SHOP_DOMAIN ?? "smartpayx-dev.myshopify.com";
const DEV_AUTH_TOKEN = "dev-spx-token-do-not-use-in-prod";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Mirrors utils/crypto.server.ts sealSecret (kept inline to avoid app imports in seeds). */
function sealSecret(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed a production database.");
  }
  const pepper = process.env.SESSION_TOKEN_PEPPER;
  const encKey = process.env.CREDENTIALS_ENC_KEY;
  if (!pepper || !encKey) {
    throw new Error("SESSION_TOKEN_PEPPER and CREDENTIALS_ENC_KEY must be set (see .env.example).");
  }

  const shop = await prisma.shop.upsert({
    where: { shopDomain: DEV_SHOP_DOMAIN },
    update: {},
    create: {
      shopDomain: DEV_SHOP_DOMAIN,
      spxEnabled: true,
      settings: {
        inventory_check_enabled: true,
        splash_logo_visible: true,
        min_capture_pct: 50,
        shipping: { mode: "FLAT", flat_minor: 0 },
      },
      pgConfigs: [
        { pg: "RAZORPAY", enabled: true, display_order: 1, offer_text: "5% instant discount on UPI" },
        { pg: "PINELABS", enabled: true, display_order: 2, offer_text: "No-cost EMI available" },
      ],
    },
  });

  for (const pg of [PgProvider.RAZORPAY, PgProvider.PINELABS]) {
    await prisma.pgCredential.upsert({
      where: { shopId_pg: { shopId: shop.id, pg } },
      update: {},
      create: {
        shopId: shop.id,
        pg,
        encPayload: sealSecret(
          JSON.stringify({ key_id: `test_${pg.toLowerCase()}_key`, key_secret: "test_secret", webhook_secret: "test_webhook_secret" }),
          encKey,
        ),
      },
    });
  }

  const customer = await prisma.customer.upsert({
    where: { shopId_phone: { shopId: shop.id, phone: "+919800000001" } },
    update: {},
    create: {
      shopId: shop.id,
      phone: "+919800000001",
      email: "dev-buyer@example.com",
      emailLocked: true,
      lastVerifiedAt: new Date(),
    },
  });

  const address = await prisma.customerAddress.findFirst({ where: { customerId: customer.id } })
    ?? await prisma.customerAddress.create({
      data: {
        customerId: customer.id,
        name: "Dev Buyer",
        phone: "+919800000001",
        address1: "221B Test Street",
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400001",
        isDefault: true,
      },
    });

  const tokenHash = sha256Hex(pepper + DEV_AUTH_TOKEN);
  const now = Date.now();
  await prisma.authSession.upsert({
    where: { tokenHash },
    update: { revokedAt: null, expiresAt: new Date(now + 30 * 864e5), lastSeenAt: new Date(now) },
    create: {
      customerId: customer.id,
      tokenHash,
      expiresAt: new Date(now + 30 * 864e5),
    },
  });

  const openRequest = await prisma.checkoutRequest.findFirst({
    where: { shopId: shop.id, cartToken: "seed-cart-token", status: { in: [RequestStatus.OPEN, RequestStatus.ADDRESS_SET, RequestStatus.AWAITING_PAYMENT] } },
  }) ?? await prisma.checkoutRequest.create({
    data: {
      shopId: shop.id,
      cartToken: "seed-cart-token",
      itemsHash: sha256Hex("seed-items"),
      cartSnapshot: {
        lines: [{ variant_id: "gid://shopify/ProductVariant/1", title: "Seed Product", qty: 1, unit_minor: 129900 }],
        subtotal_minor: 129900,
      },
      customerId: customer.id,
      shippingAddress: { name: address.name, phone: address.phone, address1: address.address1, city: address.city, state: address.state, pincode: address.pincode, country: "IN" },
      shippingAddressId: address.id,
      status: RequestStatus.ADDRESS_SET,
      expiresAt: new Date(now + 30 * 60_000),
    },
  });

  console.log("Seed complete:");
  console.log(`  shop:      ${shop.shopDomain} (id=${shop.id})`);
  console.log(`  customer:  ${customer.phone} (id=${customer.id})`);
  console.log(`  request:   ${openRequest.id} [${openRequest.status}]`);
  console.log(`  X-SPX-Auth dev token: ${DEV_AUTH_TOKEN}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
