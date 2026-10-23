
-- A paid request is an immutable record of the cart that was charged.
-- It must not prevent a buyer from starting another checkout with the same
-- Shopify cart token after adding new items while order fulfillment reconciles.

DROP INDEX IF EXISTS one_open_request_per_cart;

CREATE UNIQUE INDEX one_open_request_per_cart
  ON checkout_requests (shop_id, cart_token)
  WHERE status IN (
    'OPEN',
    'ADDRESS_SET',
    'AWAITING_PAYMENT',
    'ATTEMPT_INITIATED'
  );
