/**
 * POST /apps/smartpayx/payment
 *
 * Order is load-bearing — money touches nothing until step 6:
 *  1. auth + ownership + state guards
 *  2. re-read cart server-side, recompute and FREEZE the amount
 *  3. inventory check (when enabled) — the last free refusal point
 *  4. reuse a stalled attempt or create a fresh one (unique index guards double-click)
 *  5. build the callback URL (our server) carrying the storefront return path
 *  6. create the PG session for exactly the frozen amount
 *  7. T4: request → ATTEMPT_INITIATED, presentation persisted for resume
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import {
  AttemptStatus,
  PgProvider,
  Prisma,
  RequestStatus,
  type Shop,
} from "@prisma/client";
import prisma from "../db.server";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { parseJsonBody } from "../utils/request.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  requireCustomerSession,
  assertRequestOwnership,
} from "../services/auth/guards.server";
import { getRequestById } from "../services/checkout/request.server";
import {
  readCart,
  computePricing,
  computeItemsHash,
} from "../services/checkout/cart.server";
import {
  getEnabledPgConfigs,
  getShopSettings,
  getPgCredentials,
} from "../services/shops/shop.server";
import { getAdapter } from "../services/pg/index.server";
import { checkAvailability } from "../services/shopify/admin.server";
import { unauthenticated } from "../shopify.server";
import { env } from "../config/env.server";
import { randomToken } from "../utils/crypto.server";
import { logger, errorFields } from "../utils/logger.server";

const BodySchema = z.object({
  request_id: z.uuid(),
  pg: z.enum(PgProvider),
  /**
   * PATH only (never an absolute URL) of the page the widget was opened from,
   * so the buyer returns where they started — PDP buy-now, mini-cart, or /cart.
   * Rejecting absolute URLs here closes an open-redirect hole, since this value
   * ends up in a redirect target handed to the gateway.
   */
  return_path: z
    .string()
    .max(500)
    .refine(
      (v) => v.startsWith("/") && !v.startsWith("//"),
      "must be a site-relative path",
    )
    .optional(),
});

/** Merchant's real storefront origin — custom domains are common; fall back to .myshopify.com. */
function storefrontOrigin(shop: Shop): string {
  const configured = getShopSettings(shop).storefront_origin?.trim();
  return (configured || `https://${shop.shopDomain}`).replace(/\/$/, "");
}

export const action = apiAction(
  async ({ request: httpRequest }: ActionFunctionArgs) => {
    const { shop } = await authenticateProxy(httpRequest);
    const auth = await requireCustomerSession(httpRequest);
    const body = BodySchema.parse(await parseJsonBody(httpRequest));

    const checkoutRequest = await getRequestById(body.request_id);
    assertRequestOwnership(checkoutRequest, auth);

    // 1. State guards
    const payableStatuses: RequestStatus[] = [
      RequestStatus.ADDRESS_SET,
      RequestStatus.AWAITING_PAYMENT,
    ];
    if (!payableStatuses.includes(checkoutRequest.status)) {
      return apiError(
        "INVALID_STATE",
        "This checkout is not ready for payment.",
        409,
        {
          status: checkoutRequest.status,
        },
      );
    }
    if (!checkoutRequest.shippingAddress) {
      return apiError(
        "ADDRESS_REQUIRED",
        "Add a delivery address before paying.",
        409,
      );
    }
    if (!getEnabledPgConfigs(shop).some((c) => c.pg === body.pg)) {
      return apiError(
        "PG_NOT_AVAILABLE",
        "That payment option isn't available.",
        409,
      );
    }

    // 2. Re-read + freeze. Client-supplied amounts do not exist in this API.
    const cart = await readCart(shop, checkoutRequest.cartToken);
    if (!cart)
      return apiError("CART_EMPTY", "Your cart is no longer available.", 409);
    const pricing = computePricing(shop, cart);
    const amountMinor = BigInt(pricing.totalMinor);

    // 3. Inventory — last point we can refuse for free.
    if (getShopSettings(shop).inventory_check_enabled) {
      const { admin } = await unauthenticated.admin(shop.shopDomain);
      const shortfalls = await checkAvailability(
        admin,
        cart.lines.map((l) => ({
          variantId: l.variantId,
          quantity: l.quantity,
        })),
      );
      if (shortfalls.length) {
        return apiError(
          "OUT_OF_STOCK",
          "Some items just went out of stock.",
          409,
          { lines: shortfalls },
        );
      }
    }

    // 4a. A live attempt already exists → replay its stored presentation rather
    //     than creating a duplicate. Requires `presentation` to have been saved.
    const live = await prisma.paymentAttempt.findFirst({
      where: { requestId: checkoutRequest.id, status: AttemptStatus.INITIATED },
    });
    if (live) {
      const stored = live.presentation as {
        mode: "EMBEDDED" | "REDIRECT";
        payment_url?: string;
        sdk?: unknown;
      } | null;
      if (stored?.mode) {
        return apiOk({
          attempt_id: live.id,
          resumed: true,
          amount_minor: String(live.amountMinor),
          currency: live.currency,
          ...stored,
        });
      }
      // Crashed mid-create — nothing renderable. Abandon so a fresh attempt can
      // take the single-live-attempt slot.
      await prisma.paymentAttempt.update({
        where: { id: live.id },
        data: {
          status: AttemptStatus.ABANDONED,
          failureCode: "NO_PRESENTATION",
          resolvedAt: new Date(),
        },
      });
    }

    // 4b. Reuse a previously stalled attempt for this PG instead of piling up rows
    //     when the gateway session repeatedly fails to create.
    const reusable = await prisma.paymentAttempt.findFirst({
      where: {
        requestId: checkoutRequest.id,
        pg: body.pg,
        status: AttemptStatus.ABANDONED,
        failureCode: { in: ["SESSION_CREATE_FAILED", "NO_PRESENTATION"] },
      },
      orderBy: { initiatedAt: "desc" },
    });

    let attempt;
    try {
      attempt = reusable
        ? await prisma.paymentAttempt.update({
            where: { id: reusable.id },
            data: {
              status: AttemptStatus.INITIATED,
              amountMinor,
              currency: pricing.currency,
              failureCode: null,
              failureReason: null,
              resolvedAt: null,
              initiatedAt: new Date(),
            },
          })
        : await prisma.paymentAttempt.create({
            data: {
              requestId: checkoutRequest.id,
              pg: body.pg,
              // Short placeholder; replaced with the gateway id once created.
              pgOrderId: `tmp_${randomToken(6)}`,
              amountMinor,
              currency: pricing.currency,
              status: AttemptStatus.INITIATED,
            },
          });
    } catch (error) {
      // Lost the race on one_live_attempt_per_request — another tab won.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return apiError(
          "ATTEMPT_IN_FLIGHT",
          "A payment is already in progress.",
          409,
        );
      }
      throw error;
    }

    const freshHash = computeItemsHash(cart.lines);
    if (checkoutRequest.itemsHash && checkoutRequest.itemsHash !== freshHash) {
      return apiError(
        "CART_CHANGED",
        "Your cart changed. Please review the updated total.",
        409,
      );
    }

    // 5 + 6. Callback points at OUR server; the storefront return path rides along
    //        as a query param so the callback route can 302 the buyer back.
    const callbackUrl = new URL(
      `/callbacks/${body.pg.toLowerCase()}`,
      env.SHOPIFY_APP_URL,
    );

    callbackUrl.searchParams.set("attempt", attempt.id);
    callbackUrl.searchParams.set("request", checkoutRequest.id);
    callbackUrl.searchParams.set("origin", storefrontOrigin(shop));
    if (body.return_path)
      callbackUrl.searchParams.set("path", body.return_path);

    const address = checkoutRequest.shippingAddress as any;

    try {
      const credentials = await getPgCredentials(shop.id, body.pg);

      const session = await getAdapter(body.pg).createSession({
        attemptId: attempt.id,
        requestId: checkoutRequest.id,
        amountMinor,
        currency: pricing.currency,
        callbackUrl: callbackUrl.toString(),
        customer: {
          name: address?.name ?? "Customer",
          email: auth.customer.email ?? "",
          phone: auth.customer.phone,
        },
        shippingAddress: address ?? undefined,
        lines: cart.lines.map((l) => ({
          variantId: l.variantId,
          title: [l.title, l.variantTitle].filter(Boolean).join(" - "),
          quantity: l.quantity,
          unitMinor: BigInt(l.unitMinor),
          imageUrl: l.imageUrl,
        })),
        shippingMinor: BigInt(pricing.shippingMinor),
        credentials,
      });

      // Persist the presentation so a resume (4a) can replay it verbatim.
      const presentation =
        session.mode === "REDIRECT"
          ? { mode: "REDIRECT" as const, payment_url: session.paymentUrl }
          : { mode: "EMBEDDED" as const, sdk: session.sdkOptions };

      // 7. T4 — record the gateway id and move the request.
      const [updatedAttempt] = await prisma.$transaction([
        prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: {
            pgOrderId: session.pgOrderId,
            paymentUrl: session.paymentUrl ?? null,
            presentation: presentation as unknown as object,
          },
        }),
        prisma.checkoutRequest.update({
          where: { id: checkoutRequest.id },
          data: {
            status: RequestStatus.ATTEMPT_INITIATED,
            amountMinor,
            currency: pricing.currency,
            cartSnapshot: cart as unknown as object,
            itemsHash: freshHash,
            pricingBreakdown: pricing as unknown as object,
          },
        }),
      ]);

      logger.info("payment.attempt_initiated", {
        requestId: checkoutRequest.id,
        attemptId: attempt.id,
        pg: body.pg,
        amountMinor: String(amountMinor),
      });

      return apiOk({
        attempt_id: updatedAttempt.id,
        amount_minor: String(amountMinor),
        currency: pricing.currency,
        ...presentation,
      });
    } catch (error) {
      // Session creation failed — release the live slot as ABANDONED (not FAILED:
      // no payment was ever attempted, so buyer-facing failure copy is wrong) and
      // leave it reusable by 4b on the next try.
      await prisma.paymentAttempt
        .update({
          where: { id: attempt.id },
          data: {
            status: AttemptStatus.ABANDONED,
            failureCode: "SESSION_CREATE_FAILED",
            failureReason:
              error instanceof Error ? error.message.slice(0, 500) : null,
            resolvedAt: new Date(),
          },
        })
        .catch(() => undefined);

      logger.error("payment.session_create_failed", {
        attemptId: attempt.id,
        ...errorFields(error),
      });
      throw error;
    }
  },
);
