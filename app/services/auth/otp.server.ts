/**
 * OTP challenge lifecycle. We own everything security-critical: generation,
 * hashing, expiry, attempts, lockout, resend-same-challenge. fast2sms is only
 * the delivery pipe. Rules (spec §2):
 *   - 6-digit numeric, hashed at rest (sha256 + pepper), 5-min expiry, single use
 *   - send: max 3 per phone per 10 min, 30s cooldown between sends
 *   - resend: NEW code on the SAME row; attempts counter persists across resends
 *   - verify: max 5 attempts per challenge, then locked
 */
import { randomInt } from "node:crypto";
import prisma from "../../db.server";
import { env } from "../../config/env.server";
import { sha256Hex } from "../../utils/crypto.server";
import { AppError, ValidationError } from "../errors.server";
import { logger, errorFields } from "../../utils/logger.server";
import { sendOtpSms } from "../sms/fast2sms.server";

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function hashCode(shopId: bigint, phone: string, code: string): string {
  // Bind the hash to shop+phone so a code is only valid for its own challenge context.
  return sha256Hex(`${env.SESSION_TOKEN_PEPPER}:${shopId}:${phone}:${code}`);
}

export function generateCode(): string {
  return randomInt(100000, 1_000_000).toString();
}

export interface SendOtpResult {
  challengeId: string;
  resendAfterSec: number;
  resendsLeft: number;
}

/**
 * Create a new challenge OR resend on an existing one (when challengeId given).
 * @throws ValidationError (bad phone), AppError (rate limited / locked / send failure)
 */
export async function sendOtp(params: {
  shopId: bigint;
  phoneE164: string;
  mobile10: string;
  challengeId?: string;
  clientIp?: string | null;
}): Promise<SendOtpResult> {
  const { shopId, phoneE164, mobile10, challengeId, clientIp } = params;
  const now = Date.now();
  const code = generateCode();
  const codeHash = hashCode(shopId, phoneE164, code);

  // --- Resend path: same row, new code, attempts persist ---
  if (challengeId) {
    const existing = await prisma.otpChallenge.findUnique({
      where: { id: challengeId },
    });
    if (
      !existing ||
      existing.shopId !== shopId ||
      existing.phone !== phoneE164
    ) {
      throw new ValidationError(
        "This verification session is no longer valid. Please start again.",
      );
    }
    if (existing.lockedAt) {
      throw new AppError(
        "FORBIDDEN",
        "Too many attempts. Please start again in a little while.",
        423,
      );
    }
    if (now - existing.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil(
        (RESEND_COOLDOWN_MS - (now - existing.lastSentAt.getTime())) / 1000,
      );
      throw new AppError(
        "CONFLICT",
        `Please wait ${wait}s before requesting another code.`,
        429,
        {
          detail: { retryAfterSec: wait },
        },
      );
    }
    if (
      existing.resendCount + 1 >= MAX_SENDS_PER_WINDOW &&
      withinWindow(existing.createdAt, now)
    ) {
      // allow up to MAX_SENDS_PER_WINDOW total sends (1 initial + resends)
    }
    if (existing.resendCount + 1 > MAX_SENDS_PER_WINDOW - 1) {
      throw new AppError(
        "CONFLICT",
        "You've requested too many codes. Please try again later.",
        429,
      );
    }

    const updated = await prisma.otpChallenge.update({
      where: { id: existing.id },
      data: {
        codeHash,
        expiresAt: new Date(now + CODE_TTL_MS),
        lastSentAt: new Date(now),
        resendCount: { increment: 1 },
        verifiedAt: null,
      },
    });
    await deliver(mobile10, code, existing.id);
    return {
      challengeId: updated.id,
      resendAfterSec: RESEND_COOLDOWN_MS / 1000,
      resendsLeft: Math.max(0, MAX_SENDS_PER_WINDOW - 1 - updated.resendCount),
    };
  }

  // --- New challenge path: enforce per-phone send-rate over the window ---
  const recentSends = await prisma.otpChallenge.count({
    where: {
      shopId,
      phone: phoneE164,
      createdAt: { gte: new Date(now - SEND_WINDOW_MS) },
    },
  });
  if (recentSends >= MAX_SENDS_PER_WINDOW) {
    throw new AppError(
      "CONFLICT",
      "Too many code requests. Please try again in a few minutes.",
      429,
    );
  }

  const challenge = await prisma.otpChallenge.create({
    data: {
      shopId,
      phone: phoneE164,
      codeHash,
      expiresAt: new Date(now + CODE_TTL_MS),
      lastSentAt: new Date(now),
      createdIp: clientIp ?? null,
    },
  });
  await deliver(mobile10, code, challenge.id);
  return {
    challengeId: challenge.id,
    resendAfterSec: RESEND_COOLDOWN_MS / 1000,
    resendsLeft: MAX_SENDS_PER_WINDOW - 1,
  };
}

async function deliver(
  mobile10: string,
  code: string,
  challengeId: string,
): Promise<void> {
  try {
    await sendOtpSms(mobile10, code);
  } catch (error) {
    // Delivery failed — the challenge row exists but is useless. Log; surface a clean error.
    logger.error("otp.delivery_failed", { challengeId, ...errorFields(error) });
    throw error instanceof AppError
      ? error
      : new AppError(
          "INTERNAL_ERROR",
          "Could not send the verification code.",
          500,
          { cause: error },
        );
  }
}

function withinWindow(createdAt: Date, now: number): boolean {
  return now - createdAt.getTime() < SEND_WINDOW_MS;
}

export interface VerifyOtpResult {
  ok: boolean;
  attemptsLeft: number;
  locked: boolean;
}

/**
 * Verify a code against a challenge. Increments attempts on failure, locks at
 * the cap, marks verified on success (single-use). Does NOT mint the session —
 * the caller does that transactionally (verify route).
 */
export async function verifyOtp(params: {
  shopId: bigint;
  challengeId: string;
  phoneE164: string;
  code: string;
}): Promise<VerifyOtpResult> {
  const { shopId, challengeId, phoneE164, code } = params;

  const challenge = await prisma.otpChallenge.findUnique({
    where: { id: challengeId },
  });
  if (
    !challenge ||
    challenge.shopId !== shopId ||
    challenge.phone !== phoneE164
  ) {
    throw new ValidationError(
      "This verification session is no longer valid. Please start again.",
    );
  }
  if (challenge.lockedAt) {
    return { ok: false, attemptsLeft: 0, locked: true };
  }
  if (challenge.verifiedAt) {
    throw new ValidationError(
      "This code has already been used. Please request a new one.",
    );
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError(
      "This code has expired. Please request a new one.",
    );
  }

  const matches = hashCode(shopId, phoneE164, code) === challenge.codeHash;

  if (!matches) {
    const nextAttempts = challenge.attempts + 1;
    const shouldLock = nextAttempts >= MAX_VERIFY_ATTEMPTS;
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: {
        attempts: nextAttempts,
        lockedAt: shouldLock ? new Date() : null,
      },
    });
    return {
      ok: false,
      attemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - nextAttempts),
      locked: shouldLock,
    };
  }

  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { verifiedAt: new Date() },
  });
  return {
    ok: true,
    attemptsLeft: MAX_VERIFY_ATTEMPTS - challenge.attempts,
    locked: false,
  };
}
