-- SmartPayX initial migration (hand-authored; normative DDL — spec §3)
-- Deploy with `prisma migrate deploy`. The two partial unique indexes at the
-- bottom are correctness constraints Prisma cannot express — never drop them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shopify session storage (PrismaSessionStorage shape)
-- ---------------------------------------------------------------------------
CREATE TABLE "Session" (
    "id"                  TEXT NOT NULL,
    "shop"                TEXT NOT NULL,
    "state"               TEXT NOT NULL,
    "isOnline"            BOOLEAN NOT NULL DEFAULT false,
    "scope"               TEXT,
    "expires"             TIMESTAMP(3),
    "accessToken"         TEXT NOT NULL,
    "userId"              BIGINT,
    "firstName"           TEXT,
    "lastName"            TEXT,
    "email"               TEXT,
    "accountOwner"        BOOLEAN NOT NULL DEFAULT false,
    "locale"              TEXT,
    "collaborator"        BOOLEAN DEFAULT false,
    "emailVerified"       BOOLEAN DEFAULT false,
    "refreshToken"        TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE request_status AS ENUM (
  'OPEN','ADDRESS_SET','AWAITING_PAYMENT','ATTEMPT_INITIATED',
  'CAPTURED','RECONCILING','ORDER_CREATED','CANCELLED','FAILED_TERMINAL','EXPIRED'
);
CREATE TYPE attempt_status AS ENUM ('INITIATED','CAPTURED','FAILED','ABANDONED','CANCELLED');
CREATE TYPE pg_provider   AS ENUM ('RAZORPAY','PINELABS');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE shops (
  id                BIGSERIAL PRIMARY KEY,
  shop_domain       TEXT NOT NULL,
  storefront_token  TEXT,
  spx_enabled       BOOLEAN NOT NULL DEFAULT false,
  settings          JSONB NOT NULL DEFAULT '{}',
  pg_configs        JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "shops_shop_domain_key" ON shops (shop_domain);

CREATE TABLE pg_credentials (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  shop_id     BIGINT NOT NULL,
  pg          pg_provider NOT NULL,
  enc_payload TEXT NOT NULL,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pg_credentials_pkey" PRIMARY KEY (id),
  CONSTRAINT "pg_credentials_shop_id_fkey" FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pg_credentials_shop_id_pg_key" ON pg_credentials (shop_id, pg);

CREATE TABLE customers (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  shop_id             BIGINT NOT NULL,
  phone               TEXT NOT NULL,
  email               TEXT,
  email_locked        BOOLEAN NOT NULL DEFAULT false,
  shopify_customer_id TEXT,
  last_verified_at    TIMESTAMPTZ(6),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customers_pkey" PRIMARY KEY (id),
  CONSTRAINT "customers_shop_id_fkey" FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customers_shop_id_phone_key" ON customers (shop_id, phone);

CREATE TABLE otp_challenges (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  shop_id      BIGINT NOT NULL,
  phone        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  resend_count INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ(6) NOT NULL,
  verified_at  TIMESTAMPTZ(6),
  locked_at    TIMESTAMPTZ(6),
  created_ip   INET,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "otp_challenges_pkey" PRIMARY KEY (id),
  CONSTRAINT "otp_challenges_shop_id_fkey" FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX otp_phone_recent ON otp_challenges (shop_id, phone, created_at DESC);

CREATE TABLE auth_sessions (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL,
  token_hash   TEXT NOT NULL,
  issued_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ(6) NOT NULL,
  revoked_at   TIMESTAMPTZ(6),
  ua_hash      TEXT,
  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY (id),
  CONSTRAINT "auth_sessions_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON auth_sessions (token_hash);
CREATE INDEX sessions_by_customer ON auth_sessions (customer_id);

CREATE TABLE customer_addresses (
  id          UUID NOT NULL DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  address1    TEXT NOT NULL,
  address2    TEXT,
  landmark    TEXT,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  pincode     TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'IN',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ(6),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "customer_addresses_pkey" PRIMARY KEY (id),
  CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX addresses_by_customer ON customer_addresses (customer_id);

CREATE TABLE checkout_requests (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  shop_id             BIGINT NOT NULL,
  cart_token          TEXT NOT NULL,
  items_hash          TEXT,
  cart_snapshot       JSONB,
  customer_id         UUID,
  shipping_address    JSONB,
  shipping_address_id UUID,
  amount_minor        BIGINT,
  currency            TEXT NOT NULL DEFAULT 'INR',
  pricing_breakdown   JSONB,
  status              request_status NOT NULL DEFAULT 'OPEN',
  app_order_id        TEXT,
  shopify_order_id    TEXT,
  shopify_order_name  TEXT,
  status_page_url     TEXT,
  order_snapshot      JSONB,
  oversold            BOOLEAN NOT NULL DEFAULT false,
  last_error          TEXT,
  retry_count         INT NOT NULL DEFAULT 0,
  next_retry_at       TIMESTAMPTZ(6),
  expires_at          TIMESTAMPTZ(6) NOT NULL,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  fulfillment_claimed_at TIMESTAMPTZ(6),
  CONSTRAINT "checkout_requests_pkey" PRIMARY KEY (id),
  CONSTRAINT "checkout_requests_shop_id_fkey" FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "checkout_requests_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "checkout_requests_app_order_id_key" ON checkout_requests (app_order_id);
CREATE INDEX requests_by_customer ON checkout_requests (customer_id, created_at DESC);
CREATE INDEX requests_sweepable  ON checkout_requests (status, expires_at);

CREATE TABLE payment_attempts (
  id                    UUID NOT NULL DEFAULT gen_random_uuid(),
  request_id            UUID NOT NULL,
  pg                    pg_provider NOT NULL,
  pg_order_id           TEXT NOT NULL,
  pg_payment_id         TEXT,
  amount_minor          BIGINT NOT NULL,
  amount_captured_minor BIGINT,
  currency              TEXT NOT NULL,
  status                attempt_status NOT NULL DEFAULT 'INITIATED',
  failure_code          TEXT,
  failure_reason        TEXT,
  charged               BOOLEAN,
  payment_url           TEXT,
  refund_id             TEXT,
  refund_status         TEXT,
  initiated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ(6),
  presentation          JSONB,

  CONSTRAINT "payment_attempts_pkey" PRIMARY KEY (id),
  CONSTRAINT "payment_attempts_request_id_fkey" FOREIGN KEY (request_id) REFERENCES checkout_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "payment_attempts_pg_pg_order_id_key" ON payment_attempts (pg, pg_order_id);
CREATE INDEX attempts_sweepable ON payment_attempts (status, initiated_at);

CREATE TABLE webhook_events (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  pg               pg_provider NOT NULL,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  pg_order_id      TEXT,
  payload          JSONB NOT NULL,
  signature_valid  BOOLEAN NOT NULL,
  received_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ(6),
  processing_error TEXT,
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY (id)
);
CREATE UNIQUE INDEX "webhook_events_pg_event_id_key" ON webhook_events (pg, event_id);
CREATE INDEX webhook_retryable ON webhook_events (processed_at, received_at);

-- ---------------------------------------------------------------------------
-- Correctness-critical PARTIAL unique indexes (spec §3 — SQL-only, not in Prisma)
-- ---------------------------------------------------------------------------
-- At most one non-terminal request per cart per shop (the dedup invariant).
CREATE UNIQUE INDEX one_open_request_per_cart
  ON checkout_requests (shop_id, cart_token)
  WHERE status IN ('OPEN','ADDRESS_SET','AWAITING_PAYMENT',
                   'ATTEMPT_INITIATED','CAPTURED','RECONCILING');

-- At most one live payment attempt per request (double-click / PG-switch guard).
CREATE UNIQUE INDEX one_live_attempt_per_request
  ON payment_attempts (request_id)
  WHERE status = 'INITIATED';

CREATE TABLE pincode_cache (
  pincode    TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  city       TEXT,
  district   TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);