/**
 * Settings — enable SmartPayX, configure store behaviour and payment gateways.
 * Polaris web components (s-*), loaded from Shopify's CDN.
 */
import { useState } from "react";
import {
  useLoaderData,
  useActionData,
  useNavigation,
  Form,
} from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger, errorFields } from "../utils/logger.server";
import { AppError } from "../services/errors.server";
import { PgProvider } from "@prisma/client";
import {
  getPgDefinition,
  pgRegistryForClient,
  SUPPORTED_PGS,
} from "../services/pg/registry.server";
import {
  getShopSettings,
  getAllPgConfigs,
  getEnabledPgConfigs,
} from "../services/shops/shop.server";
import {
  findOrCreateShop,
  getConfiguredPgs,
  savePgConfigs,
  saveShopSettings,
  setSpxEnabled,
  ensureStorefrontToken,
  syncEnabledMetafield,
  ensureOrderMetafieldDefinitions,
  type PgCredentialInput,
} from "../services/shops/settings.server";
import { fromMinor } from "../utils/money.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const configured = await getConfiguredPgs(shop.id);
  const settings = getShopSettings(shop);

  return {
    spxEnabled: shop.spxEnabled,
    hasStorefrontToken: Boolean(shop.storefrontToken),
    settings: {
      inventoryCheckEnabled: settings.inventory_check_enabled,
      storeFrontOrigin: settings?.storefront_origin ?? null,
      shippingMode: settings.shipping.mode,
      shippingLabel: settings.shipping.label ?? "",
      shippingAmount:
        settings.shipping.mode === "FLAT"
          ? fromMinor(BigInt(settings.shipping.flat_minor))
          : "",
    },
    registry: pgRegistryForClient(),
    configuredPgs: configured,
    savedConfigs: getAllPgConfigs(shop),
    enabledCount: getEnabledPgConfigs(shop).length,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  try {
    const formData = await request.formData();
    const shop = await findOrCreateShop(session.shop);
    const spxEnabled = formData.get("spxEnabled") === "on";

    // Store behaviour settings
    const shippingMode = (
      String(formData.get("shippingMode") ?? "FREE") === "FLAT"
        ? "FLAT"
        : "FREE"
    ) as "FREE" | "FLAT";
    await saveShopSettings(shop, {
      inventoryCheckEnabled: formData.get("inventoryCheckEnabled") === "on",
      storeFrontOrigin: String(formData.get("storeFrontOrigin") ?? ""),
      shippingMode,
      shippingLabel: String(formData.get("shippingLabel") ?? ""),
      shippingAmount: String(formData.get("shippingAmount") ?? "0"),
    });

    // PG configs
    const inputs: PgCredentialInput[] = [];
    for (const pg of SUPPORTED_PGS) {
      if (formData.get(`pg.${pg}.included`) !== "on") continue;
      const credentials: Record<string, string> = {};
      for (const field of getPgDefinition(pg).fields) {
        credentials[field.key] = String(
          formData.get(`pg.${pg}.${field.key}`) ?? "",
        );
      }
      inputs.push({
        pg,
        enabled: formData.get(`pg.${pg}.enabled`) === "on",
        displayOrder: Number(formData.get(`pg.${pg}.display_order`) ?? 1),
        offerText:
          String(formData.get(`pg.${pg}.offer_text`) ?? "").trim() || undefined,
        credentials,
      });
    }

    if (spxEnabled && inputs.filter((i) => i.enabled).length === 0) {
      return {
        ok: false as const,
        error:
          "Enable at least one payment gateway before turning on SmartPayX.",
      };
    }

    await savePgConfigs(shop.id, inputs);
    const updated = await setSpxEnabled(shop.id, spxEnabled);
    if (spxEnabled) await ensureStorefrontToken(admin, updated);
    await syncEnabledMetafield(admin, spxEnabled);
    await ensureOrderMetafieldDefinitions(admin);

    return {
      ok: true as const,
      message: spxEnabled
        ? "SmartPayX is live on your storefront."
        : "Settings saved. SmartPayX is turned off.",
    };
  } catch (error) {
    logger.error("settings.save_failed", {
      shop: session.shop,
      ...errorFields(error),
    });
    return {
      ok: false as const,
      error:
        error instanceof AppError
          ? error.message
          : "Something went wrong while saving. Please try again.",
    };
  }
}

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const loading = navigation.state === "loading";

  const [enabled, setEnabled] = useState(data.spxEnabled);
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      data.registry.map((r) => [
        r.pg,
        data.configuredPgs.includes(r.pg as PgProvider),
      ]),
    ),
  );
  const [shippingMode, setShippingMode] = useState(data.settings.shippingMode);

  const savedFor = (pg: string) => data.savedConfigs.find((c) => c.pg === pg);
  const isConfigured = (pg: string) =>
    data.configuredPgs.includes(pg as PgProvider);
  const needsSetup = data.configuredPgs.length === 0;

  if (loading) {
    return (
      <s-page heading="SmartPayX settings">
        <s-box padding="large-500">
          <s-stack
            direction="block"
            gap="base"
            alignItems="center"
            justifyContent="center"
          >
            <s-spinner accessibilityLabel="Loading settings" size="large" />
            <s-text color="subdued">Loading settings…</s-text>
          </s-stack>
        </s-box>
      </s-page>
    );
  }

  return (
    <s-page heading="SmartPayX settings">
      <s-stack direction="block" gap="large">
        {needsSetup && !actionData?.ok && (
          <s-banner tone="info" heading="Finish setting up SmartPayX">
            <s-paragraph>
              Add credentials for at least one payment gateway, then turn
              SmartPayX on to serve the one-click checkout on your storefront.
            </s-paragraph>
          </s-banner>
        )}
        {actionData?.ok && (
          <s-banner tone="success" heading={actionData.message} />
        )}
        {actionData && !actionData.ok && (
          <s-banner tone="critical" heading="Couldn't save settings">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        )}

        <Form method="post" data-save-bar>
          <s-stack direction="block" gap="large">
            {/* Checkout enable */}
            <s-section heading="Checkout">
              <s-stack direction="block" gap="base">
                <s-switch
                  name="spxEnabled"
                  label="Enable SmartPayX checkout"
                  details="When on, the storefront checkout button opens the SmartPayX one-click checkout instead of Shopify checkout."
                  checked={enabled || undefined}
                  onChange={(e: Event) =>
                    setEnabled((e.target as HTMLInputElement).checked)
                  }
                />
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-text color="subdued">Storefront access token</s-text>
                  <s-badge
                    tone={data.hasStorefrontToken ? "success" : "neutral"}
                  >
                    {data.hasStorefrontToken
                      ? "Provisioned"
                      : "Created on first enable"}
                  </s-badge>
                </s-stack>
              </s-stack>
            </s-section>

            {/* Store behaviour */}
            <s-section heading="Store behaviour">
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="storeFrontOrigin"
                  label="Your Store URL"
                  placeholder="Enter your store url"
                  value={data.settings.storeFrontOrigin || undefined}
                />
                <s-switch
                  name="inventoryCheckEnabled"
                  label="Check inventory at checkout"
                  details="Verify stock before taking payment. Turn off if you manage stock elsewhere or oversell intentionally."
                  checked={data.settings.inventoryCheckEnabled || undefined}
                />
                <s-divider />
                <s-select
                  name="shippingMode"
                  label="Shipping"
                  value={shippingMode}
                  onChange={(e: Event) =>
                    setShippingMode(
                      (e.target as HTMLSelectElement).value as "FREE" | "FLAT",
                    )
                  }
                >
                  <s-option value="FREE">Free shipping</s-option>
                  <s-option value="FLAT">Flat rate</s-option>
                </s-select>
                {shippingMode === "FLAT" && (
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-text-field
                      name="shippingLabel"
                      label="Rate label"
                      placeholder="e.g. Standard shipping"
                      value={data.settings.shippingLabel || undefined}
                    />
                    <s-money-field
                      name="shippingAmount"
                      label="Shipping amount"
                      value={data.settings.shippingAmount || undefined}
                    />
                  </s-grid>
                )}
              </s-stack>
            </s-section>

            {/* Payment gateways */}
            <s-section heading="Payment gateways">
              <s-paragraph>
                Choose the gateways to offer and enter the credentials from each
                provider&#39;s dashboard. Secret keys are encrypted at rest and
                never shown again after saving.
              </s-paragraph>
              <s-stack direction="block" gap="base">
                {data.registry.map((provider) => {
                  const saved = savedFor(provider.pg);
                  const isIncluded = included[provider.pg];
                  const publicVals = saved?.public_fields ?? {};
                  return (
                    <s-box
                      key={provider.pg}
                      padding="base"
                      borderWidth="base"
                      borderRadius="base"
                    >
                      <s-stack direction="block" gap="base">
                        <s-stack
                          direction="inline"
                          gap="small-200"
                          alignItems="center"
                        >
                          <s-checkbox
                            name={`pg.${provider.pg}.included`}
                            label={provider.label}
                            checked={isIncluded || undefined}
                            onChange={(e: Event) => {
                              const checked = (e.target as HTMLInputElement)
                                .checked;
                              setIncluded((prev) => ({
                                ...prev,
                                [provider.pg]: checked,
                              }));
                            }}
                          />
                          {isConfigured(provider.pg) && (
                            <s-badge tone="success">Configured</s-badge>
                          )}
                        </s-stack>

                        {isIncluded && (
                          <s-stack direction="block" gap="base">
                            {provider.fields.map((field) =>
                              field.type === "password" ? (
                                <s-password-field
                                  key={field.key}
                                  name={`pg.${provider.pg}.${field.key}`}
                                  label={field.label}
                                  details={
                                    isConfigured(provider.pg)
                                      ? "Saved. Leave blank to keep the current value."
                                      : field.helpText
                                  }
                                />
                              ) : (
                                <s-text-field
                                  key={field.key}
                                  name={`pg.${provider.pg}.${field.key}`}
                                  label={field.label}
                                  details={field.helpText}
                                  value={publicVals[field.key] || undefined}
                                />
                              ),
                            )}
                            <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                              <s-text-field
                                name={`pg.${provider.pg}.offer_text`}
                                label="Offer text (optional)"
                                placeholder="e.g. 5% instant discount on UPI"
                                value={saved?.offer_text || undefined}
                              />
                              <s-number-field
                                name={`pg.${provider.pg}.display_order`}
                                label="Display order"
                                min={1}
                                value={String(saved?.display_order ?? 1)}
                              />
                            </s-grid>
                            <s-switch
                              name={`pg.${provider.pg}.enabled`}
                              label="Show this gateway to customers"
                              checked={(saved?.enabled ?? true) || undefined}
                            />
                          </s-stack>
                        )}
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-stack>
            </s-section>

            <s-button
              type="submit"
              variant="primary"
              loading={saving || undefined}
            >
              Save settings
            </s-button>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}
