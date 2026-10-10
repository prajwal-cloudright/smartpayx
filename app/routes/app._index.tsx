/**
 * App home — redirects merchants to Settings until SmartPayX is configured
 * (no shops row, no PG credentials, or the flag is off).
 */
import { useLoaderData, useNavigate } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  findOrCreateShop,
  getConfiguredPgs,
} from "../services/shops/settings.server";
import { getEnabledPgConfigs } from "../services/shops/shop.server";
import { useEffect } from "react";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const configured = await getConfiguredPgs(shop.id);

  return {
    needsSetup: !shop.spxEnabled || configured.length === 0,
    shopDomain: shop.shopDomain,
    enabledPgs: getEnabledPgConfigs(shop).map((c) => c.pg),
  };
}

export default function AppIndex() {
  const { shopDomain, enabledPgs, needsSetup } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  useEffect(() => {
    if (needsSetup) navigate("/app/settings");
  }, [needsSetup, navigate]);

  // Render nothing while navigating — App Bridge keeps the loading state.
  if (needsSetup) return null;

  return (
    <s-page heading="SmartPayX">
      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Checkout</s-text>
            <s-badge tone="success">Live</s-badge>
          </s-stack>
          <s-paragraph>
            SmartPayX is active on {shopDomain} with {enabledPgs.length} payment
            gateway
            {enabledPgs.length === 1 ? "" : "s"} enabled.
          </s-paragraph>
          <s-button href="/app/settings">Manage settings</s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}
