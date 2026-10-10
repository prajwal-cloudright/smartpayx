/**
 * Shopify Admin API service. Every Admin operation lives here — callers pass
 * the `admin` client from `authenticate.admin(request)` (or
 * `unauthenticated.admin(shopDomain)` in workers/webhooks) plus typed args.
 * No route or other service builds GraphQL strings itself.
 */
import SHOP_ID_QUERY from "../../graphql/queries/shop.details.gql";
import STOREFRONT_TOKEN_CREATE from "../../graphql/mutations/storefront.create.token.gql";
import METAFIELDS_SET from "../../graphql/mutations/metafields.set.gql";
import METAFIELD_DEFINITION_CREATE from "../../graphql/mutations/metafield.definition.create.gql";
import VARIANT_INVENTORY from "../../graphql/queries/variants.inventory.gql";
import ORDER_CREATE from "../../graphql/mutations/order.create.gql";
import FIND_ORDER from "../../graphql/queries/order.find.request_id.gql";
import CUSTOMER_QUERY from "../../graphql/queries/customer.find.id.gql";

import { fromMinor } from "../../utils/money.server";

import { ShopifyApiError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";
import { AdminApiContext } from "@shopify/shopify-app-react-router/server";

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * Execute an Admin GraphQL document with uniform error handling:
 * transport failure, non-2xx, GraphQL `errors`, and malformed bodies all
 * become ShopifyApiError. userErrors are checked separately per-operation
 * because only the caller knows which field holds them.
 */
async function executeAdmin<T>(
  admin: AdminApiContext,
  operation: string,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await admin.graphql(
      document,
      variables ? { variables } : undefined,
    );
  } catch (error) {
    logger.error("shopify.admin.transport_failed", {
      operation,
      ...errorFields(error),
    });
    throw new ShopifyApiError(
      operation,
      "Could not reach the Shopify Admin API.",
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    logger.error("shopify.admin.http_error", {
      operation,
      status: response.status,
      body: body.slice(0, 500),
    });
    throw new ShopifyApiError(
      operation,
      `Shopify Admin API returned ${response.status}.`,
      {
        status: response.status === 429 ? 429 : 500,
        detail: { httpStatus: response.status },
      },
    );
  }

  let envelope: GraphqlEnvelope<T>;
  try {
    envelope = (await response.json()) as GraphqlEnvelope<T>;
  } catch (error) {
    throw new ShopifyApiError(
      operation,
      "Shopify Admin API returned a malformed response.",
      { cause: error },
    );
  }

  if (envelope.errors?.length) {
    const message = envelope.errors.map((e) => e.message).join("; ");
    logger.error("shopify.admin.graphql_errors", { operation, message });
    throw new ShopifyApiError(
      operation,
      `Shopify rejected the request: ${message}`,
      {
        detail: { graphqlErrors: envelope.errors },
      },
    );
  }

  if (!envelope.data) {
    throw new ShopifyApiError(operation, "Shopify Admin API returned no data.");
  }
  return envelope.data;
}

/** Throw if a mutation returned userErrors. */
function assertNoUserErrors(
  operation: string,
  userErrors?: UserError[] | null,
): void {
  if (!userErrors?.length) return;
  const message = userErrors
    .map((e) => `${e.field?.join(".") ?? "?"}: ${e.message}`)
    .join("; ");
  logger.warn("shopify.admin.user_errors", { operation, userErrors });
  throw new ShopifyApiError(operation, message, { userErrors, status: 422 });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function fetchShopId(admin: AdminApiContext): Promise<string> {
  const data = await executeAdmin<{
    shop: { id: string; myshopifyDomain: string };
  }>(admin, "fetchShopId", SHOP_ID_QUERY);
  return data.shop.id;
}

export async function createStorefrontAccessToken(
  admin: AdminApiContext,
  title: string,
): Promise<string> {
  const data = await executeAdmin<{
    storefrontAccessTokenCreate: {
      storefrontAccessToken: { accessToken: string } | null;
      userErrors: UserError[];
    };
  }>(admin, "createStorefrontAccessToken", STOREFRONT_TOKEN_CREATE, {
    input: { title },
  });

  const result = data.storefrontAccessTokenCreate;
  assertNoUserErrors("createStorefrontAccessToken", result.userErrors);

  if (!result.storefrontAccessToken?.accessToken) {
    throw new ShopifyApiError(
      "createStorefrontAccessToken",
      "Shopify did not return a storefront access token.",
    );
  }
  return result.storefrontAccessToken.accessToken;
}

export interface MetafieldSetInput {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export async function setMetafields(
  admin: AdminApiContext,
  metafields: MetafieldSetInput[],
): Promise<void> {
  if (metafields.length === 0) return;
  const data = await executeAdmin<{
    metafieldsSet: { userErrors: UserError[] };
  }>(admin, "setMetafields", METAFIELDS_SET, { metafields });
  assertNoUserErrors("setMetafields", data.metafieldsSet.userErrors);
}

export interface MetafieldDefinitionInput {
  name: string;
  namespace: string;
  key: string;
  type: string;
  ownerType: "SHOP" | "ORDER";
  access?: { storefront?: "PUBLIC_READ" | "NONE"; admin?: string };
  capabilities?: {
    uniqueValues?: { enabled: boolean };
    adminFilterable?: { enabled: boolean };
  };
}

/**
 * Idempotent: a definition that already exists returns userError code
 * TAKEN, which we treat as success rather than an error.
 */
export async function ensureMetafieldDefinition(
  admin: AdminApiContext,
  definition: MetafieldDefinitionInput,
): Promise<void> {
  const data = await executeAdmin<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null;
      userErrors: UserError[];
    };
  }>(admin, "ensureMetafieldDefinition", METAFIELD_DEFINITION_CREATE, {
    definition,
  });

  const errors = data.metafieldDefinitionCreate.userErrors ?? [];
  const onlyAlreadyExists =
    errors.length > 0 && errors.every((e) => e.code === "TAKEN");
  if (onlyAlreadyExists) {
    logger.info("shopify.admin.metafield_definition_exists", {
      namespace: definition.namespace,
      key: definition.key,
    });
    return;
  }
  assertNoUserErrors("ensureMetafieldDefinition", errors);
}

/**
 * Inventory availability check. Skipped entirely when the shop has
 * settings.inventory_check_enabled = false.
 */
export interface StockShortfall {
  variantId: string;
  title: string;
  requested: number;
  available: number;
}

export async function checkAvailability(
  admin: AdminApiContext,
  lines: { variantId: string; quantity: number }[],
): Promise<StockShortfall[]> {
  const ids = lines.map((l) => l.variantId);
  const response = await admin.graphql(VARIANT_INVENTORY, {
    variables: { ids },
  });
  const body: any = await response.json();
  const nodes: any[] = body?.data?.nodes ?? [];

  const shortfalls: StockShortfall[] = [];
  for (const line of lines) {
    const node = nodes.find((n) => n?.id === line.variantId);
    if (!node) continue; // variant vanished — let orderCreate surface it

    // CONTINUE policy = oversell allowed by the merchant on Shopify's side.
    if (node.inventoryPolicy === "CONTINUE" || node.availableForSale === true) {
      const qty = Number(node.inventoryQuantity ?? 0);
      if (node.inventoryPolicy !== "CONTINUE" && qty < line.quantity) {
        shortfalls.push({
          variantId: line.variantId,
          title: `${node.product?.title ?? ""} ${node.title ?? ""}`.trim(),
          requested: line.quantity,
          available: Math.max(0, qty),
        });
      }
      continue;
    }
    shortfalls.push({
      variantId: line.variantId,
      title: `${node.product?.title ?? ""} ${node.title ?? ""}`.trim(),
      requested: line.quantity,
      available: 0,
    });
  }

  if (shortfalls.length) logger.warn("inventory.shortfall", { shortfalls });
  return shortfalls;
}

/**
 * Shopify order creation — the CAPTURED → ORDER_CREATED transition (T8/T9).
 *
 * Non-negotiables:
 *  - Runs ONLY after verified capture. Never speculatively.
 *  - Idempotent: looks for an existing order tagged with this request before
 *    creating, so a retry after a crash-between-create-and-persist adopts the
 *    existing order instead of duplicating it.
 *  - Amount comes from what was CAPTURED (which may be less than the frozen
 *    amount when a gateway offer applied), so the order总 total always equals
 *    money actually received.
 */

export interface CreatedOrder {
  id: string;
  name: string;
  statusPageUrl: string | null;
  totalAmount: string;
  currency: string;
  customerId: string | null;
  adopted: boolean;
}

export interface OrderCreateParams {
  requestId: string;
  appOrderId: string;
  pgPaymentId: string | null;
  pg: string;
  email: string;
  phone: string;
  currency: string;
  /** Amount actually captured — the order total must equal this. */
  capturedMinor: bigint;
  /** Frozen amount at payment time; differs only when a PG offer applied. */
  expectedMinor: bigint;
  lines: { variantId: string; quantity: number }[];
  shippingAddress: {
    name: string;
    phone: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
  };
  shippingMinor: bigint;
  shippingLabel: string;
  cartToken: string;
  oversold: boolean;
  shopifyCustomerId?: string | null;
}

/** Split "Test Buyer" into Shopify's first/last fields. */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1)
    return { firstName: parts[0] ?? "Customer", lastName: "" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]!,
  };
}

/**
 * Idempotency probe: has an order already been created for this request?
 *
 * Uses orderByIdentifier (custom-ID lookup) rather than orders(query:) search.
 * Direct lookup avoids two failure modes of the search path: the metafield
 * definition must have adminFilterable enabled or the filter is silently
 * IGNORED (returning an unrelated order we'd then wrongly adopt), and search
 * indexes are eventually consistent, so an order created seconds ago may not
 * appear yet — exactly the window a crash-retry lands in.
 */
type ProbeResult =
  | { outcome: "FOUND"; order: CreatedOrder }
  | { outcome: "NOT_FOUND" }
  | { outcome: "UNKNOWN"; error: string };

export async function findExistingOrder(
  admin: AdminApiContext,
  requestId: string,
): Promise<ProbeResult> {
  try {
    const response = await admin.graphql(FIND_ORDER, {
      variables: {
        identifier: {
          customId: {
            namespace: "smartpayx",
            key: "request_id",
            value: requestId,
          },
        },
      },
    });
    const body: any = await response.json();

    if (body?.errors?.length) {
      const message = body.errors.map((e: any) => e.message).join("; ");
      return { outcome: "UNKNOWN", error: message };
    }

    const node = body?.data?.orderByIdentifier;
    if (!node) return { outcome: "NOT_FOUND" };

    return {
      outcome: "FOUND",
      order: {
        id: node.id,
        name: node.name,
        statusPageUrl: node.statusPageUrl ?? null,
        totalAmount: node.totalPriceSet?.shopMoney?.amount ?? "0.00",
        currency: node.totalPriceSet?.shopMoney?.currencyCode ?? "INR",
        customerId: node.customer?.id ?? null,
        adopted: true,
      },
    };
  } catch (error) {
    return {
      outcome: "UNKNOWN",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createShopifyOrder(
  admin: AdminApiContext,
  params: OrderCreateParams,
): Promise<CreatedOrder> {
  // 1. Idempotency — adopt rather than duplicate.
  const probe = await findExistingOrder(admin, params.requestId);

  if (probe.outcome === "FOUND") {
    logger.info("order.adopted_existing", {
      requestId: params.requestId,
      orderId: probe.order.id,
    });
    return probe.order;
  }

  if (probe.outcome === "UNKNOWN") {
    // We cannot tell whether an order already exists. Creating now risks a
    // DUPLICATE order against a single payment — worse than a delay, since it
    // means double fulfilment and a refund conversation. Fail into the
    // reconciling lane; the tick retries with backoff and the buyer is already
    // on the thank-you page via app_order_id.
    throw new ShopifyApiError(
      "orderCreate.probe",
      `Idempotency probe inconclusive: ${probe.error}`,
      {
        detail: { requestId: params.requestId, retryable: true },
      },
    );
  }

  const { firstName, lastName } = splitName(params.shippingAddress.name);

  // A gateway offer means captured < expected. Represent the gap as an order
  // discount so the Shopify total equals money received, and the merchant can
  // see why it differs from list price.
  const offerDeltaMinor = params.expectedMinor - params.capturedMinor;
  const hasOffer = offerDeltaMinor > 0n;

  const address = {
    firstName,
    lastName,
    address1: params.shippingAddress.address1,
    ...(params.shippingAddress.address2
      ? { address2: params.shippingAddress.address2 }
      : {}),
    city: params.shippingAddress.city,
    province: params.shippingAddress.state,
    zip: params.shippingAddress.pincode,
    countryCode: params.shippingAddress.country || "IN",
    phone: params.shippingAddress.phone,
  };

  const order: Record<string, unknown> = {
    email: params.email,
    phone: params.phone,
    currency: params.currency,
    // Storefront prices are GST-inclusive (spec §12) — Shopify must not add tax.
    taxesIncluded: true,
    financialStatus: "PAID",
    processedAt: new Date().toISOString(),
    lineItems: params.lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
    })),
    shippingAddress: address,
    billingAddress: address,
    customer: params?.shopifyCustomerId
      ? { toAssociate: { id: params.shopifyCustomerId } }
      : {
          toUpsert: {
            email: params.email,
            phone: params.phone,
            firstName,
            lastName,
          },
        },
    shippingLines: [
      {
        title: params.shippingLabel,
        priceSet: {
          shopMoney: {
            amount: fromMinor(params.shippingMinor),
            currencyCode: params.currency,
          },
        },
      },
    ],
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        gateway: `SmartPayX (${params.pg})`,
        amountSet: {
          shopMoney: {
            amount: fromMinor(params.capturedMinor),
            currencyCode: params.currency,
          },
        },
        ...(params.pgPaymentId
          ? { authorizationCode: params.pgPaymentId }
          : {}),
      },
    ],
    // The per-request tag is the idempotency key; metafields carry the rest.
    tags: [
      "smartpayx",
      `spx-${params.appOrderId}`,
      ...(params.oversold ? ["spx-oversold"] : []),
    ],
    metafields: [
      {
        namespace: "smartpayx",
        key: "request_id",
        type: "id",
        value: params.requestId,
      },
      {
        namespace: "smartpayx",
        key: "app_order_id",
        type: "single_line_text_field",
        value: params.appOrderId,
      },
      {
        namespace: "smartpayx",
        key: "cart_token",
        type: "single_line_text_field",
        value: params.cartToken,
      },
      ...(params.pgPaymentId
        ? [
            {
              namespace: "smartpayx",
              key: "pg_payment_id",
              type: "single_line_text_field",
              value: params.pgPaymentId,
            },
          ]
        : []),
    ],
    sourceName: "smartpayx",
    ...(hasOffer
      ? {
          note: `Gateway offer applied: -${fromMinor(offerDeltaMinor)} ${params.currency}`,
        }
      : {}),
  };

  const response = await admin.graphql(ORDER_CREATE, {
    variables: {
      order,
      options: {
        sendReceipt: true,
        inventoryBehaviour: "DECREMENT_OBEYING_POLICY",
      },
    },
  });

  const body: any = await response.json();
  if (body?.errors?.length) {
    throw new ShopifyApiError("orderCreate", JSON.stringify(body.errors), {
      detail: { requestId: params.requestId },
    });
  }

  const result = body?.data?.orderCreate;
  if (result?.userErrors?.length) {
    const message = result.userErrors
      .map((e: any) => `${e.field?.join(".") ?? "?"}: ${e.message}`)
      .join("; ");
    throw new ShopifyApiError("orderCreate", message, {
      userErrors: result.userErrors,
      detail: { requestId: params.requestId },
    });
  }
  if (!result?.order?.id) {
    throw new ShopifyApiError("orderCreate", "Shopify returned no order.");
  }

  logger.info("order.created", {
    requestId: params.requestId,
    orderId: result.order.id,
    orderName: result.order.name,
    capturedMinor: String(params.capturedMinor),
    hasOffer,
  });

  return {
    id: result.order.id,
    name: result.order.name,
    statusPageUrl: result.order.statusPageUrl ?? null,
    totalAmount: result.order.totalPriceSet?.shopMoney?.amount ?? "0.00",
    currency:
      result.order.totalPriceSet?.shopMoney?.currencyCode ?? params.currency,
    customerId: result.order.customer?.id ?? null,
    adopted: false,
  };
}

export type LinkVerdict =
  | { valid: true; customerId: string }
  /** Stored id is unusable — clear it and fall back to upsert. */
  | { valid: false; reason: "NOT_FOUND" | "EMAIL_MISMATCH" }
  /** Couldn't check (API error). Keep the link; don't destroy data on a transient failure. */
  | { valid: "UNKNOWN" };

export async function validateCustomerLink(
  admin: AdminApiContext,
  shopifyCustomerId: string,
  expectedEmail: string | null,
): Promise<LinkVerdict> {
  try {
    const response = await admin.graphql(CUSTOMER_QUERY, {
      variables: { id: shopifyCustomerId },
    });
    const body: any = await response.json();

    if (body?.errors?.length) {
      logger.warn("customer.link_check_errors", {
        shopifyCustomerId,
        errors: body.errors.map((e: any) => e.message),
      });
      return { valid: "UNKNOWN" };
    }

    const customer = body?.data?.customer;
    if (!customer) return { valid: false, reason: "NOT_FOUND" };

    // No email on either side to compare — accept the id as-is.
    if (!expectedEmail || !customer.email)
      return { valid: true, customerId: customer.id };

    if (customer.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      logger.warn("customer.link_email_mismatch", {
        shopifyCustomerId,
        storedEmail: expectedEmail,
        shopifyEmail: customer.email,
      });
      return { valid: false, reason: "EMAIL_MISMATCH" };
    }

    return { valid: true, customerId: customer.id };
  } catch (error) {
    logger.warn("customer.link_check_failed", {
      shopifyCustomerId,
      ...errorFields(error),
    });
    return { valid: "UNKNOWN" };
  }
}
