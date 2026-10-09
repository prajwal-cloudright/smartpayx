/**
 * Customer session tokens (spec §2 — final design, fixed TTL, no sliding).
 *  - 256-bit random, base64url; server stores sha256(pepper + raw) only.
 *  - Fixed lifetime: expires_at = issued_at + SESSION_TTL_HOURS (default 24h),
 *    set once at mint and never extended. No sliding window, no hard cap
 *    (the fixed TTL already bounds it), no silent background refresh.
 *  - Rotation happens only at OTP verify: revoke prior sessions, mint fresh.
 * The status-aware expiry leniency (pre-capture force-revoke at ≤30min,
 * terminal-success accept-past-expiry) lives in `session-auth.server.ts`,
 * not here — this module only knows about fixed-TTL tokens in isolation.
 */
import prisma from "../../db.server";
import { env } from "../../config/env.server";
import { sha256Hex, randomToken } from "../../utils/crypto.server";
import { AppError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";
import type { Prisma } from "@prisma/client";

export interface MintedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export function hashAuthToken(rawToken: string): string {
  return sha256Hex(env.SESSION_TOKEN_PEPPER + rawToken);
}

export async function revokeCustomerSessions(
  customerId: string,
): Promise<void> {
  try {
    await prisma.authSession.updateMany({
      where: { customerId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  } catch (error) {
    logger.error("auth.revoke_sessions_failed", {
      customerId,
      ...errorFields(error),
    });
    throw new AppError(
      "INTERNAL_ERROR",
      "Could not revoke existing sessions.",
      500,
      { cause: error },
    );
  }
}

export async function revokeSession(sessionId: string): Promise<void> {
  try {
    await prisma.authSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  } catch (error) {
    // A session that vanished is already effectively revoked — log, don't fail the request.
    logger.warn("auth.revoke_session_failed", {
      sessionId,
      ...errorFields(error),
    });
  }
}

export async function mintCustomerSession(
  customerId: string,
  uaHash?: string,
): Promise<MintedSession> {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  );
  try {
    const session = await prisma.authSession.create({
      data: {
        customerId,
        tokenHash: hashAuthToken(token),
        issuedAt: now,
        lastSeenAt: now,
        expiresAt,
        uaHash,
      },
    });
    return { token, sessionId: session.id, expiresAt: session.expiresAt };
  } catch (error) {
    logger.error("auth.mint_session_failed", {
      customerId,
      ...errorFields(error),
    });
    throw new AppError("INTERNAL_ERROR", "Could not create a session.", 500, {
      cause: error,
    });
  }
}

/** Mint within an existing transaction (verify uses this to make login atomic). */
export async function mintCustomerSessionTx(
  tx: Prisma.TransactionClient,
  customerId: string,
  uaHash?: string,
): Promise<MintedSession> {
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + env.SESSION_TTL_HOURS * 60 * 60 * 1000,
  );
  const session = await tx.authSession.create({
    data: {
      customerId,
      tokenHash: hashAuthToken(token),
      issuedAt: now,
      lastSeenAt: now,
      expiresAt,
      uaHash,
    },
  });
  return { token, sessionId: session.id, expiresAt: session.expiresAt };
}

/** Revoke prior sessions within a transaction. */
export async function revokeCustomerSessionsTx(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<void> {
  await tx.authSession.updateMany({
    where: { customerId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
