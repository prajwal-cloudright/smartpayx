import type { PgProvider, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { openSecret } from "../../utils/crypto.server";
import { NotFoundError, ConfigError, AppError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";

export interface ShopSettings {
  inventory_check_enabled: boolean;
  splash_logo_visible: boolean;
  min_capture_pct: number;
  shipping: { mode: "FREE" | "FLAT"; flat_minor: number; label?: string };
  storefront_origin?: string;
}

const DEFAULT_SETTINGS: ShopSettings = {
  inventory_check_enabled: true,
  splash_logo_visible: true,
  min_capture_pct: 50,
  shipping: { mode: "FREE", flat_minor: 0, label: "Standard shipping" },
};

/** Never throws — malformed JSON falls back to defaults and logs. */
export function getShopSettings(shop: Shop): ShopSettings {
  try {
    const raw = (shop.settings ?? {}) as unknown as Partial<ShopSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      shipping: { ...DEFAULT_SETTINGS.shipping, ...(raw.shipping ?? {}) },
    };
  } catch (error) {
    logger.warn("shop.settings_parse_failed", {
      shopId: String(shop.id),
      ...errorFields(error),
    });
    return DEFAULT_SETTINGS;
  }
}

export interface PgConfigEntry {
  pg: PgProvider;
  enabled: boolean;
  display_order: number;
  offer_text?: string;
  public_fields?: Record<string, string>;
}

/** Never throws — drops unrecognised entries rather than failing the request. */
export function getAllPgConfigs(shop: Shop): PgConfigEntry[] {
  try {
    const configs = (shop.pgConfigs ?? []) as unknown as PgConfigEntry[];
    if (!Array.isArray(configs)) return [];
    return configs.sort(
      (a, b) => (a.display_order ?? 0) - (b.display_order ?? 0),
    );
  } catch (error) {
    logger.warn("shop.pg_configs_parse_failed", {
      shopId: String(shop.id),
      ...errorFields(error),
    });
    return [];
  }
}

export function getEnabledPgConfigs(shop: Shop): PgConfigEntry[] {
  return getAllPgConfigs(shop).filter((c) => c.enabled);
}

export async function getShopByDomain(shopDomain: string): Promise<Shop> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) throw new NotFoundError("Shop is not installed.", { shopDomain });
  return shop;
}

export interface PgCredentials {
  [key: string]: string;
}

export async function getPgCredentials(
  shopId: bigint,
  pg: PgProvider,
): Promise<PgCredentials> {
  const row = await prisma.pgCredential.findUnique({
    where: { shopId_pg: { shopId, pg } },
  });
  if (!row) {
    throw new ConfigError(`No credentials configured for ${pg}.`, {
      shopId: String(shopId),
      pg,
    });
  }
  try {
    return JSON.parse(openSecret(row.encPayload)) as PgCredentials;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new ConfigError(
      `Stored ${pg} credentials are corrupt.`,
      { shopId: String(shopId), pg },
      error,
    );
  }
}
