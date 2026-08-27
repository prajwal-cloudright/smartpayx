/**
 * GET /apps/smartpayx/config — unauthenticated widget bootstrap.
 *
 * No customer session exists at this point (it runs before login), so this is
 * shop-level data only. Proxy signature verification (I5) still applies, so it
 * is only reachable through Shopify's proxy from this storefront.
 *
 * NEVER return pg_configs.public_fields here — Merchant IDs and access codes
 * are not secrets, but there's no reason to broadcast them to every visitor.
 * The widget only needs to know WHICH gateways to show, not their credentials.
 */
import type { LoaderFunctionArgs } from "react-router";
import { apiLoader } from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  getEnabledPgConfigs,
  getShopSettings,
} from "../services/shops/shop.server";
import { INDIAN_STATES } from "../utils/address.server";

export const loader = apiLoader(async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await authenticateProxy(request);
  const settings = getShopSettings(shop);

  return apiOk({
    enabled: shop.spxEnabled,
    ui: {
      splash_logo_visible: settings.splash_logo_visible,
    },
    pg_options: getEnabledPgConfigs(shop).map((c) => ({
      pg: c.pg,
      display_order: c.display_order,
      offer_text: c.offer_text ?? null,
    })),
    shipping: {
      mode: settings.shipping.mode,
      label: settings.shipping.label ?? null,
    },
    states: INDIAN_STATES,
    otp: {
      resend_cooldown_s: 30,
      code_length: 6,
    },
  });
});
