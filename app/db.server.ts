import { PrismaClient } from "@prisma/client";
import { logger } from "./utils/logger.server";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

const prisma = global.prismaGlobal ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") global.prismaGlobal = prisma;

export default prisma;

export interface DbHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** Single, non-throwing connectivity probe — used by /healthz. */
export async function checkDatabase(): Promise<DbHealth> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Boot-time assertion — retries, then throws. Called once from boot.server.ts;
 * the process exits if the database never becomes reachable.
 */
export async function assertDatabaseHealthy({
  attempts = 5,
  delayMs = 2000,
}: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const health = await checkDatabase();
    if (health.ok) {
      logger.info("db.healthy", { attempt, latencyMs: health.latencyMs });
      return;
    }
    lastError = health.error;
    logger.warn("db.health_retry", { attempt, attempts, error: health.error });
    if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `Database unreachable after ${attempts} attempts: ${lastError}`,
  );
}
