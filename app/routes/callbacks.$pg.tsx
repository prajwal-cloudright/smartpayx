/**
 * POST|GET /callbacks/:pg — the gateway's browser-mediated return, received
 * server-side rather than on the storefront.
 *
 * Why server-side: resolving here means state is settled BEFORE the buyer's
 * browser reaches the storefront, so the widget's first poll usually returns a
 * final answer instead of spinning. It also keeps PG-specific callback params
 * off the storefront entirely.
 *
 * This is a TRIGGER, never authority. We verify the signature, then run the
 * same resolver the webhook runs — which re-fetches status from the gateway.
 * An invalid signature is logged and skipped; the webhook and the sweeper still
 * cover that attempt, so the buyer is never stranded.
 *
 * ALWAYS 302s to the storefront. A buyer who has just paid must never see a
 * server error page, so every failure path still redirects.
 */
import { redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PgProvider } from "@prisma/client";
import prisma from "../db.server";
import { getAdapter } from "../services/pg/index.server";
import { getPgCredentials } from "../services/shops/shop.server";
import { resolveAttempt } from "../services/checkout/resolver.server";
import { logger, errorFields } from "../utils/logger.server";

/** Parse the :pg route segment into the enum, or null when unrecognised. */
function parsePg(segment: string | undefined): PgProvider | null {
  const upper = (segment ?? "").toUpperCase();
  return (Object.values(PgProvider) as string[]).includes(upper)
    ? (upper as PgProvider)
    : null;
}

/**
 * Collect callback params from BOTH the query string and the posted body.
 * Razorpay form-POSTs its fields; Pine Labs posts JSON or form data depending
 * on configuration; some gateways append to the query on GET. Merging covers
 * all three without per-PG branching.
 */
async function collectParams(request: Request): Promise<{
  ourParams: Record<string, string>;
  pgParams: Record<string, string>;
}> {
  const url = new URL(request.url);

  // These are OUR params we placed on the callback_url. Never pass to signature verification.
  const OUR_PARAM_KEYS = new Set(["attempt", "request", "origin", "path"]);

  const ourParams: Record<string, string> = {};
  const pgParams: Record<string, string> = {};

  for (const [key, value] of url.searchParams) {
    if (OUR_PARAM_KEYS.has(key)) ourParams[key] = value;
    else pgParams[key] = value;
  }

  if (request.method !== "POST") return { ourParams, pgParams };

  const contentType = request.headers.get("content-type") ?? "";
  const rawBody = await request.text().catch(() => "");
  if (!rawBody) return { ourParams, pgParams };

  try {
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(rawBody);
      const source = parsed?.data ?? parsed;
      for (const [key, value] of Object.entries(source ?? {})) {
        if (typeof value === "string" || typeof value === "number") {
          if (OUR_PARAM_KEYS.has(key)) ourParams[key] = String(value);
          else pgParams[key] = String(value);
        }
      }
    } else {
      // form-urlencoded (Razorpay default)
      for (const [key, value] of new URLSearchParams(rawBody)) {
        if (OUR_PARAM_KEYS.has(key)) ourParams[key] = value;
        else pgParams[key] = value;
      }
    }
  } catch (error) {
    logger.warn("callback.body_parse_failed", {
      contentType,
      ...errorFields(error),
    });
  }

  return { ourParams, pgParams };
}

/**
 * Build the storefront URL the buyer lands on. `origin` and `path` were placed
 * on the callback URL by /payment, so this route stays stateless and doesn't
 * need to re-read shop settings.
 */
function buildReturnUrl(params: {
  origin: string | null;
  path: string | null;
  requestId: string;
  attemptId: string;
  fallbackShopDomain: string;
}): string {
  const origin = (
    params.origin || `https://${params.fallbackShopDomain}`
  ).replace(/\/$/, "");
  // Site-relative paths only — an absolute value here would be an open redirect.
  const path =
    params.path && params.path.startsWith("/") && !params.path.startsWith("//")
      ? params.path
      : "/";
  const url = new URL(path, origin);
  url.searchParams.set("spx_resume", params.requestId);
  url.searchParams.set("txn", params.attemptId);
  return url.toString();
}

async function handleCallback(
  request: Request,
  pgSegment: string | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const pg = parsePg(pgSegment);

  const isPayu = pg === PgProvider.PAYU;
  console.log("[CB] hit", {
    pg: pgSegment,
    method: request.method,
    url: request.url,
    contentType: request.headers.get("content-type"),
  });

  // OUR_PARAM_KEYS come from the callback_url we built — read them from the URL
  // directly, before body parsing, so they're always available even on POST.
  let attemptId = url.searchParams.get("attempt");
  let originParam = url.searchParams.get("origin");
  let pathParam = url.searchParams.get("path");

  if (!pg) {
    logger.warn("callback.malformed", { pg: pgSegment, attemptId });
    return redirect(originParam || "/");
  }

  // Split: pgParams contains ONLY what the gateway sent (for signature verification).
  // (Razorpay / Pine Labs: unchanged — they still need ?attempt in the URL.)
  const { pgParams } = await collectParams(request);
  console.log("[CB] PG params ::", pgParams);

  // PayU only: its surl/furl are shortened (<=50 chars) so ?attempt/origin/path
  // are NOT on the URL. They come back in the POST body as udf1/udf2/udf3.
  // Origin is NOT trusted until the signature is verified (see below).
  let payuOrigin: string | null = null;
  if (isPayu) {
    if (!attemptId) attemptId = pgParams.udf1 || null;
    if (!pathParam) pathParam = pgParams.udf3 || null;
    payuOrigin = pgParams.udf2 || null;
    console.log("[CB][PAYU] recovered from udf", { attemptId, pathParam, payuOrigin });
  }

  if (!attemptId) {
    logger.warn("callback.malformed", { pg: pgSegment, attemptId });
    console.log("[CB] no attemptId -> redirect", originParam || "/");
    return redirect(originParam || "/");
  }

  const attempt = await prisma.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { request: { include: { shop: true } } },
  });

  if (!attempt) {
    logger.warn("callback.unknown_attempt", { pg, attemptId });
    return redirect(originParam || "/");
  }
  if (attempt.pg !== pg) {
    logger.warn("callback.pg_mismatch", {
      attemptId,
      expected: attempt.pg,
      got: pg,
    });
    return redirect(originParam || "/");
  }

  const shop = attempt.request.shop;
  let returnUrl = buildReturnUrl({
    origin: originParam,
    path: pathParam,
    requestId: attempt.requestId,
    attemptId: attempt.id,
    fallbackShopDomain: shop.shopDomain,
  });

  try {
    const credentials = await getPgCredentials(shop.id, pg);

    const rzpFailureCallback = Object.keys(pgParams).some((k) =>
      k.startsWith("error["),
    );
    const verified = rzpFailureCallback
      ? false
      : getAdapter(pg).verifyCallback(pgParams, credentials);

    console.log("[CB] verified =", verified, { pg, attemptId: attempt.id });

    // PayU only: signature covers udf1-3, so udf2 (origin) is now trustworthy.
    if (isPayu && verified && payuOrigin) {
      returnUrl = buildReturnUrl({
        origin: payuOrigin,
        path: pathParam,
        requestId: attempt.requestId,
        attemptId: attempt.id,
        fallbackShopDomain: shop.shopDomain,
      });
    }

    if (verified || (!verified && rzpFailureCallback)) {
      const outcome = await resolveAttempt(attempt.id).catch((error) => {
        logger.error("callback.resolve_failed", {
          attemptId: attempt.id,
          ...errorFields(error),
        });
        return "PENDING" as const;
      });
      logger.info("callback.processed", { pg, attemptId: attempt.id, outcome });
    } else {
      logger.warn("callback.signature_invalid", {
        pg,
        attemptId: attempt.id,
        pgParams,
      });
    }
  } catch (error) {
    logger.error("callback.failed", {
      pg,
      attemptId: attempt.id,
      ...errorFields(error),
    });
  }

  console.log("[CB] redirecting buyer ->", returnUrl);
  return redirect(returnUrl);
}

/** Gateways that POST the return (Razorpay form POST, Pine Labs callback). */
export async function action({ request, params }: ActionFunctionArgs) {
  return handleCallback(request, params.pg);
}

/** Gateways (or retries/back-navigation) that arrive as GET. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  return handleCallback(request, params.pg);
}
