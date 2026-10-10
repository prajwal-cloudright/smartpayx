/**
 * Shared route-handler utilities: CORS, uniform error handling, and small
 * request helpers. Ported from a Mongoose/Express-style reference and adapted
 * to this stack — Prisma/Postgres, React Router 7 resource routes, and our
 * existing Response-based conventions (apiOk/apiError in responses.server.ts).
 *
 * IMPORTANT — CORS vs internal-route protection (read before reaching for `withCors`):
 * CORS headers are enforced by BROWSERS, not servers. Server-to-server callers
 * (EventBridge hitting /internal/tick, Razorpay/Pinelabs hitting /webhooks/*)
 * are never subject to CORS and gain nothing from these headers — they need
 * `requireInternalSecret` / signature verification instead (see below).
 * Reach for `withCors` only on routes a BROWSER calls cross-origin — e.g. the
 * embedded admin UI, or local dev where the extension's Vite server runs on a
 * different port than the backend. Proxy routes (`/apps/smartpayx/*`) are
 * same-origin to the storefront by construction and don't need it either.
 */
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { env } from "../../config/env.server";
import { logger, errorFields } from "../../utils/logger.server";
import { timingSafeEqualStr } from "../../utils/crypto.server";
import { apiError } from "./responses.server";
import { AppError } from "../errors.server";
import { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
export interface CorsOptions {
  origin?: string;
  methods?: string;
  headers?: string;
  credentials?: boolean;
}

const CORS_DEFAULTS: Required<CorsOptions> = {
  origin: "*",
  methods: "GET,POST,PUT,PATCH,OPTIONS",
  headers: "Content-Type, X-SPX-Auth",
  credentials: false,
};

function applyCors(response: Response, options?: CorsOptions): Response {
  const opts = { ...CORS_DEFAULTS, ...options };
  // Response headers are mutable on fetch-spec Response objects — no clone needed,
  // but guard defensively in case a caller passes something header-less.
  const withHeaders = response.headers
    ? response
    : new Response(response.body, response);

  withHeaders.headers.set("Access-Control-Allow-Origin", opts.origin);
  withHeaders.headers.set("Access-Control-Allow-Methods", opts.methods);
  withHeaders.headers.set("Access-Control-Allow-Headers", opts.headers);
  if (opts.credentials) {
    withHeaders.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return withHeaders;
}

type RouteArgs = LoaderFunctionArgs | ActionFunctionArgs;
type RouteHandler<Args extends RouteArgs = RouteArgs> = (
  args: Args,
) => Promise<Response> | Response;

/**
 * Wrap a handler with CORS headers, including OPTIONS preflight short-circuit.
 * The handler must already return a `Response` (our apiOk/apiError do).
 */
export function withCors<Args extends RouteArgs>(
  handler: RouteHandler<Args>,
  corsOptions?: CorsOptions,
): RouteHandler<Args> {
  return async (args: Args) => {
    if (args.request.method === "OPTIONS") {
      return applyCors(new Response(null, { status: 204 }), corsOptions);
    }
    const result = await handler(args);
    return applyCors(result, corsOptions);
  };
}

// ---------------------------------------------------------------------------
// Uniform error handling
// ---------------------------------------------------------------------------
/**
 * Wrap a handler so every route gets the same error → Response mapping.
 * Guards in this codebase (`requireCustomerSession`, `authenticateProxy`, ...)
 * signal failure by THROWING a Response built with `apiError` — those pass
 * through untouched. Everything else is a genuine unexpected error and gets
 * classified below.
 *
 * Deliberately NOT pinging the database on every request (the reference
 * implementation's `db.connect()` / `isHealthy()` per call is a Mongoose-pool
 * pattern). Prisma manages its own connection pool and reconnects
 * transparently; a dead database surfaces here as a P1001/P1017 error below,
 * which we map to 503. Live DB probing belongs to `/healthz` only
 * (`checkDatabase()` in db.server.ts), not the hot path of every API call.
 */
export function withErrorHandling<Args extends RouteArgs>(
  handler: RouteHandler<Args>,
): RouteHandler<Args> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (err) {
      // Guards throw pre-built Response objects (apiError) — pass through as-is.
      if (err instanceof AppError) {
        if (err.status >= 500) {
          logger.error("http.app_error", {
            code: err.code,
            message: err.message,
            detail: err.detail,
          });
        }
        return apiError(
          err.code,
          err.message,
          err.status,
          err.detail ? { detail: err.detail } : undefined,
        );
      }

      if (err instanceof Response) return err;

      if (err instanceof SyntaxError) {
        return apiError(
          "INVALID_JSON",
          "Request body must be valid JSON.",
          400,
        );
      }

      // Zod validation (request body/query parsing)
      if (err instanceof ZodError) {
        const message = err.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return apiError("VALIDATION_ERROR", message, 422, {
          issues: err.issues,
        });
      }

      // Prisma — known request errors (constraint violations, not-found, etc.)
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        switch (err.code) {
          case "P2002": // unique constraint — includes the two partial unique
            // indexes (one_open_request_per_cart, one_live_attempt_per_request):
            // callers should catch this specifically to fetch-and-reuse rather
            // than surface it as a generic conflict where that matters.
            return apiError("ALREADY_EXISTS", "Resource already exists.", 409, {
              target: err.meta?.target,
            });
          case "P2025": // record not found (update/delete on missing row)
            return apiError("NOT_FOUND", "Resource not found.", 404);
          case "P2003": // foreign key violation
            return apiError(
              "INVALID_REFERENCE",
              "Referenced resource does not exist.",
              422,
            );
          default:
            logger.error("http.prisma_known_error", {
              code: err.code,
              meta: err.meta,
            });
            return apiError(
              "DATABASE_ERROR",
              "A database error occurred.",
              500,
            );
        }
      }

      // Prisma — connection/init errors (database unreachable mid-request)
      if (
        err instanceof Prisma.PrismaClientInitializationError ||
        err instanceof Prisma.PrismaClientRustPanicError ||
        (err instanceof Error && /P1001|P1002|P1008|P1017/.test(err.message))
      ) {
        logger.error("http.db_unavailable", errorFields(err));
        return apiError(
          "SERVICE_UNAVAILABLE",
          "Database temporarily unavailable.",
          503,
          {
            retryAfterSec: 15,
          },
        );
      }

      // Unknown — log with full context and respond generically. Do not leak
      // internals (stack traces, query text) to the client.
      logger.error("http.unhandled_error", errorFields(err));
      return apiError("INTERNAL_ERROR", "An unexpected error occurred.", 500);
    }
  };
}

// ---------------------------------------------------------------------------
// Composed wrappers for routes
// ---------------------------------------------------------------------------
export function apiLoader<Args extends RouteArgs>(
  fn: RouteHandler<Args>,
): RouteHandler<Args> {
  return withErrorHandling(fn);
}

export function apiAction<Args extends RouteArgs>(
  fn: RouteHandler<Args>,
): RouteHandler<Args> {
  return withErrorHandling(fn);
}

export function apiLoaderWithCors<Args extends RouteArgs>(
  fn: RouteHandler<Args>,
  corsOptions?: CorsOptions,
): RouteHandler<Args> {
  return withErrorHandling(withCors(fn, corsOptions));
}

export function apiActionWithCors<Args extends RouteArgs>(
  fn: RouteHandler<Args>,
  corsOptions?: CorsOptions,
): RouteHandler<Args> {
  return withErrorHandling(withCors(fn, corsOptions));
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------
export function getQueryParams(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

/** Leftmost IP in X-Forwarded-For is the original client; falls back to platform-specific headers. */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("fly-client-ip") ??
    null
  );
}

export function getAppUrl(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host") || request.headers.get("host");
  return `${proto}://${host}`;
}

export function getRequestContext(request: Request): {
  clientIp: string | null;
  appUrl: string;
} {
  return { clientIp: getClientIp(request), appUrl: getAppUrl(request) };
}

// ---------------------------------------------------------------------------
// Internal-route protection (replaces CORS for server-to-server callers)
// ---------------------------------------------------------------------------
/**
 * Guard for /internal/tick: EventBridge calls this, not a browser, so CORS is
 * irrelevant — what matters is proving the caller holds INTERNAL_TICK_SECRET.
 * Timing-safe compare; throws apiError(401) on failure so callers can just
 * call this first and let withErrorHandling's Response-passthrough do the rest.
 */
export function requireInternalSecret(request: Request): void {
  const provided = request.headers.get("x-internal-secret");
  if (!provided || !timingSafeEqualStr(provided, env.INTERNAL_TICK_SECRET)) {
    logger.warn("http.internal_secret_rejected", {
      clientIp: getClientIp(request),
    });
    throw apiError("UNAUTHORIZED", "Invalid or missing internal secret.", 401);
  }
}
