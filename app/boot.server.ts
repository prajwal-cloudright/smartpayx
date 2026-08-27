/**
 * App boot sequence — imported for side effects as the FIRST import in
 * entry.server.tsx, so it runs when the server bundle loads:
 *   1. env validation (config/env.server throws on invalid env)
 *   2. database health assertion (retries, then process.exit)
 *
 * Guarded by a global so dev-server module reloads don't re-run it.
 */
import { env } from "./config/env.server";
import { assertDatabaseHealthy } from "./db.server";
import { logger, errorFields } from "./utils/logger.server";

declare global {
  // eslint-disable-next-line no-var
  var __spxBootPromise: Promise<void> | undefined;
}

async function boot(): Promise<void> {
  logger.info("boot.env_validated", { nodeEnv: env.NODE_ENV });
  await assertDatabaseHealthy();
  logger.info("boot.ready");
}

if (!global.__spxBootPromise) {
  global.__spxBootPromise = boot().catch((error) => {
    logger.error("boot.failed", errorFields(error));
    process.exit(1);
  });
}

export const bootPromise: Promise<void> = global.__spxBootPromise;
