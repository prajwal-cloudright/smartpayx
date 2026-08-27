/**
 * Cart reads + normalization. The cart the buyer SEES and the cart we PRICE
 * come from this one server-side read (spec: single source of truth). The
 * theme layer only supplies the token.
 */
import { createHash } from "node:crypto";
import type { Shop } from "@prisma/client";
import { fetchCart, type StorefrontCart } from "../shopify/storefront.server";
import { getShopSettings } from "../shops/shop.server";
import { toMinor } from "../../utils/money.server";
import { ValidationError, ConfigError } from "../errors.server";

export interface CartLineSnapshot {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  unitMinor: string; // bigint serialized — JSON can't carry bigint
  imageUrl: string | null;
}

export interface CartSnapshot {
  cartId: string;
  totalQuantity: number;
  subtotalMinor: string; // line items only, before discounts — display only
  cartTotalMinor: string; // after cart-level discounts, before shipping — this is the charge base
  currency: string;
  lines: CartLineSnapshot[];
  discountCodes: string[];
}

export interface PricingBreakdown {
  subtotalMinor: string;
  cartTotalMinor: string;
  shippingMinor: string;
  shippingLabel: string;
  totalMinor: string; // the amount frozen at /payment
  currency: string;
}

/**
 * Stable hash of cart CONTENTS (not the token, which never rotates).
 * Two carts with the same variants+quantities hash identically regardless of
 * line ordering, so reordering alone doesn't trigger a re-price.
 */
export function computeItemsHash(lines: CartLineSnapshot[]): string {
  const canonical = lines
    .map((l) => `${l.variantId}:${l.quantity}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Read + normalize a cart by token. Returns null when the cart no longer
 * exists (expired/invalid token) — an expected condition, not an error.
 */
export async function readCart(
  shop: Shop,
  cartToken: string,
): Promise<CartSnapshot | null> {
  if (!shop.storefrontToken) {
    throw new ConfigError(
      "Storefront access token is not provisioned. Re-save settings to provision it.",
      {
        shopDomain: shop.shopDomain,
      },
    );
  }
  const cart = await fetchCart({ shop }, cartToken);
  if (!cart) return null;
  if (cart.lines.length === 0) return null; // empty cart is not checkoutable
  return normalizeCart(cart);
}

// In normalizeCart — populate both
export function normalizeCart(cart: StorefrontCart): CartSnapshot {
  return {
    cartId: cart.cartId,
    totalQuantity: cart.totalQuantity,
    subtotalMinor: toMinor(cart.subtotalAmount).toString(), // display: pre-discount
    cartTotalMinor: toMinor(cart.totalAmount).toString(), // charge base: post-discount
    currency: cart.currencyCode,
    lines: cart.lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      title: l.title,
      sku: l.sku,
      variantTitle: l.variantTitle,
      quantity: l.quantity,
      unitMinor: toMinor(l.unitAmount).toString(),
      imageUrl: l.imageUrl,
    })),
    discountCodes: cart.discountCodes,
  };
}

// In computePricing — price from cartTotalMinor, not subtotalMinor
export function computePricing(
  shop: Shop,
  snapshot: CartSnapshot,
): PricingBreakdown {
  const settings = getShopSettings(shop);
  const cartTotal = BigInt(snapshot.cartTotalMinor); // post-discount base
  const shippingMinor =
    settings.shipping.mode === "FLAT"
      ? BigInt(settings.shipping.flat_minor)
      : 0n;
  const shippingLabel =
    settings.shipping.label ??
    (settings.shipping.mode === "FLAT" ? "Shipping" : "Free shipping");

  if (cartTotal <= 0n) {
    throw new ValidationError("This cart has no payable amount.");
  }

  return {
    subtotalMinor: snapshot.subtotalMinor, // display: pre-discount line total
    cartTotalMinor: snapshot.cartTotalMinor, // display: post-discount
    shippingMinor: shippingMinor.toString(),
    shippingLabel,
    totalMinor: (cartTotal + shippingMinor).toString(), // what we charge
    currency: snapshot.currency,
  };
}
