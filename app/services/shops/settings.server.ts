/**
 * Admin-side shop settings writes. All Shopify calls go through
 * services/shopify/admin.server.ts — this module owns persistence + policy.
 */
import type { PgProvider, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { sealSecret, openSecret } from "../../utils/crypto.server";
import { logger, errorFields } from "../../utils/logger.server";
import { AppError, ValidationError } from "../errors.server";
import type { PgConfigEntry } from "./shop.server";
import {
  createStorefrontAccessToken,
  ensureMetafieldDefinition,
  fetchShopId,
  setMetafields,
} from "../shopify/admin.server";
import {
  getPgDefinition,
  secretFieldKeys,
  publicFieldKeys,
  validatePgCredentials,
} from "../pg/registry.server";
import { toMinor } from "../../utils/money.server";
import { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export const SPX_NAMESPACE = "smartpayx";
export const SPX_ENABLED_KEY = "enabled";

export async function findOrCreateShop(shopDomain: string): Promise<Shop> {
  try {
    return await prisma.shop.upsert({
      where: { shopDomain },
      update: {},
      create: { shopDomain, spxEnabled: false },
    });
  } catch (error) {
    logger.error("settings.shop_upsert_failed", {
      shopDomain,
      ...errorFields(error),
    });
    throw new AppError("INTERNAL_ERROR", "Could not load shop record.", 500, {
      cause: error,
    });
  }
}

export async function getConfiguredPgs(shopId: bigint): Promise<PgProvider[]> {
  const rows = await prisma.pgCredential.findMany({
    where: { shopId },
    select: { pg: true },
  });
  return rows.map((r) => r.pg);
}

/**
 * Provision the Storefront access token once, then reuse. Idempotent: a shop
 * that already has a token short-circuits without an API call.
 */
export async function ensureStorefrontToken(
  admin: AdminApiContext,
  shop: Shop,
): Promise<string> {
  if (shop.storefrontToken) return shop.storefrontToken;

  const token = await createStorefrontAccessToken(
    admin,
    "SmartPayX cart reads",
  );
  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { storefrontToken: token },
    });
  } catch (error) {
    logger.error("settings.storefront_token_persist_failed", {
      shopId: String(shop.id),
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Storefront token was created but could not be saved.",
      500,
      {
        cause: error,
      },
    );
  }
  logger.info("settings.storefront_token_created", { shopId: String(shop.id) });
  return token;
}

/**
 * The theme extension reads `smartpayx.enabled` from shop metafields in liquid,
 * so the definition must exist with storefront read access before the value is
 * useful. Both calls are idempotent.
 */
export async function syncEnabledMetafield(
  admin: AdminApiContext,
  enabled: boolean,
): Promise<void> {
  await ensureMetafieldDefinition(admin, {
    name: "SmartPayX enabled",
    namespace: SPX_NAMESPACE,
    key: SPX_ENABLED_KEY,
    type: "boolean",
    ownerType: "SHOP",
    access: { storefront: "PUBLIC_READ" },
  });

  const shopGid = await fetchShopId(admin);
  await setMetafields(admin, [
    {
      ownerId: shopGid,
      namespace: SPX_NAMESPACE,
      key: SPX_ENABLED_KEY,
      type: "boolean",
      value: enabled ? "true" : "false",
    },
  ]);
  logger.info("settings.metafield_synced", { enabled });
}

/**
 * Create the order metafield definitions we depend on. The request_id
 * definition MUST be created with uniqueness/custom-ID capability, because
 * orderByIdentifier's customId lookup — our order-creation idempotency probe —
 * only works against a definition registered as a unique identifier.
 */
export async function ensureOrderMetafieldDefinitions(
  admin: AdminApiContext,
): Promise<void> {
  await ensureMetafieldDefinition(admin, {
    name: "SmartPayX request ID",
    namespace: SPX_NAMESPACE,
    key: "request_id",
    type: "id",
    ownerType: "ORDER",
    capabilities: {
      uniqueValues: { enabled: true },
      adminFilterable: {
        enabled: true,
      },
    },
  });

  await ensureMetafieldDefinition(admin, {
    name: "SmartPayX order ID",
    namespace: SPX_NAMESPACE,
    key: "app_order_id",
    type: "single_line_text_field",
    ownerType: "ORDER",
    capabilities: {
      adminFilterable: {
        enabled: true,
      },
    },
  });

  for (const [key, name] of [
    ["pg_payment_id", "SmartPayX gateway payment ID"],
    ["cart_token", "SmartPayX cart token"],
  ] as const) {
    await ensureMetafieldDefinition(admin, {
      name,
      namespace: SPX_NAMESPACE,
      key,
      type: "single_line_text_field",
      ownerType: "ORDER",
    });
  }
}

export interface PgCredentialInput {
  pg: PgProvider;
  enabled: boolean;
  displayOrder: number;
  offerText?: string;
  /** Blank secret fields mean "keep the stored value" on update. */
  credentials: Record<string, string>;
}

/**
 * Persist PG configs + sealed credentials atomically. Non-secret config goes to
 * shops.pg_configs (safe to render back); secrets are sealed into
 * pg_credentials and never returned to any client.
 */
/**
 * Persist PG configs + credentials.
 *
 * Storage split (deliberate, and note it is a DUPLICATION, not a partition):
 *  - pg_credentials.enc_payload — the COMPLETE credential set, sealed. This is
 *    the single source of truth for adapters; getPgCredentials reads only this.
 *  - shops.pg_configs[].public_fields — a plaintext MIRROR of the non-secret
 *    fields only, existing purely so the settings form can prefill them without
 *    decrypting. Never read by adapters.
 *
 * Blank secret fields on update mean "keep the stored value"; blank public
 * fields mean the same, so a merchant editing only their offer text doesn't
 * have to retype anything.
 */
export async function savePgConfigs(
  shopId: bigint,
  inputs: PgCredentialInput[],
): Promise<void> {
  if (inputs.length === 0) return;

  // Validate shape BEFORE opening the transaction so a bad field never leaves
  // a half-written config behind.
  const prepared = inputs.map((input) => {
    getPgDefinition(input.pg); // throws ConfigError on unknown PG
    if (!Number.isInteger(input.displayOrder) || input.displayOrder < 1) {
      throw new ValidationError(
        `${input.pg}: display order must be a positive whole number.`,
      );
    }
    const provided = Object.fromEntries(
      Object.entries(input.credentials ?? {}).filter(
        ([, v]) => typeof v === "string" && v.trim() !== "",
      ),
    ) as Record<string, string>;
    return { input, provided };
  });

  try {
    await prisma.$transaction(async (tx) => {
      const configs: PgConfigEntry[] = [];

      for (const { input, provided } of prepared) {
        const existing = await tx.pgCredential.findUnique({
          where: { shopId_pg: { shopId, pg: input.pg } },
        });

        // Merge over what's already sealed so blank inputs retain stored values.
        let merged: Record<string, string> = provided;
        if (existing) {
          const current = JSON.parse(openSecret(existing.encPayload)) as Record<
            string,
            string
          >;
          merged = { ...current, ...provided };
        }

        // Every field the definition requires must now be present and non-empty.
        const validated = validatePgCredentials(input.pg, merged);

        // Seal the COMPLETE set — this is what adapters will read back.
        await tx.pgCredential.upsert({
          where: { shopId_pg: { shopId, pg: input.pg } },
          update: { encPayload: sealSecret(JSON.stringify(validated)) },
          create: {
            shopId,
            pg: input.pg,
            encPayload: sealSecret(JSON.stringify(validated)),
          },
        });

        // Mirror only the non-secret fields for form prefill.
        const public_fields: Record<string, string> = {};
        for (const key of publicFieldKeys(input.pg)) {
          if (validated[key]) public_fields[key] = validated[key];
        }

        configs.push({
          pg: input.pg,
          enabled: input.enabled,
          display_order: input.displayOrder,
          ...(input.offerText ? { offer_text: input.offerText } : {}),
          ...(Object.keys(public_fields).length ? { public_fields } : {}),
        });

        logger.info("settings.pg_credentials_saved", {
          shopId: String(shopId),
          pg: input.pg,
          fieldsStored: Object.keys(validated).length,
          secretsRotated: secretFieldKeys(input.pg).some((k) => k in provided),
        });
      }

      await tx.shop.update({
        where: { id: shopId },
        data: { pgConfigs: configs as unknown as object },
      });
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error("settings.save_pg_configs_failed", {
      shopId: String(shopId),
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not save gateway settings.",
      500,
      { cause: error },
    );
  }
}

export async function setSpxEnabled(
  shopId: bigint,
  enabled: boolean,
): Promise<Shop> {
  try {
    return await prisma.shop.update({
      where: { id: shopId },
      data: { spxEnabled: enabled },
    });
  } catch (error) {
    logger.error("settings.set_enabled_failed", {
      shopId: String(shopId),
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not update the SmartPayX status.",
      500,
      { cause: error },
    );
  }
}

export interface ShopSettingsInput {
  inventoryCheckEnabled: boolean;
  shippingMode: "FREE" | "FLAT";
  shippingLabel?: string;
  shippingAmount?: string; // major units from the form, e.g. "49.00"
  storeFrontOrigin?: string;
}

export async function saveShopSettings(
  shop: Shop,
  input: ShopSettingsInput,
): Promise<void> {
  const current = (shop.settings ?? {}) as Record<string, unknown>;
  const shipping =
    input.shippingMode === "FLAT"
      ? {
          mode: "FLAT" as const,
          flat_minor: Number(toMinor(input.shippingAmount ?? "0")),
          label: (input.shippingLabel ?? "").trim() || "Shipping",
        }
      : {
          mode: "FREE" as const,
          flat_minor: 0,
          label: (input.shippingLabel ?? "").trim() || "Free shipping",
        };

  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        settings: {
          ...current,
          inventory_check_enabled: input.inventoryCheckEnabled,
          ...(input.storeFrontOrigin
            ? {
                storefront_origin: input.storeFrontOrigin,
              }
            : {}),
          shipping,
        } as object,
      },
    });
  } catch (error) {
    logger.error("settings.save_shop_settings_failed", {
      shopId: String(shop.id),
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not save store settings.",
      500,
      { cause: error },
    );
  }
}
