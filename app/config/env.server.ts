/**
 * Environment configuration — validated once at module load, fail-fast.
 * Import `env` everywhere instead of touching process.env directly.
 */
import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Database
    DATABASE_URL: z
      .string()
      .refine(
        (u) => u.startsWith("postgres://") || u.startsWith("postgresql://"),
        {
          message: "must be a postgres:// connection string",
        },
      ),

    // Shopify app
    SHOPIFY_API_KEY: z.string().optional(),
    SHOPIFY_API_SECRET: z.string().optional(),
    SHOPIFY_APP_URL: z.string().optional(),

    // SmartPayX secrets
    SESSION_TOKEN_PEPPER: z
      .string()
      .min(32, "at least 32 chars — used to hash customer auth tokens"),

    CREDENTIALS_ENC_KEY: z
      .string()
      .regex(
        /^[0-9a-f]{64}$/i,
        "64 hex chars (32 bytes) — AES-256-GCM key for PG credentials",
      ),

    INTERNAL_TICK_SECRET: z
      .string()
      .min(24, "shared secret for POST /internal/tick"),

    // Customer session lifetime
    SESSION_TTL_HOURS: z.coerce.number().positive().default(24),
    SESSION_NEAR_EXPIRY_GRACE_MIN: z.coerce.number().positive().default(30),

    // Providers — optional until Fast2SMS is configured
    FAST2SMS_API_KEY: z.string().optional(),
    FAST2SMS_SENDER_ID: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === "production") {
      if (!v.SHOPIFY_API_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["SHOPIFY_API_KEY"],
          message: "required in production",
        });
      }

      if (!v.SHOPIFY_API_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["SHOPIFY_API_SECRET"],
          message: "required in production",
        });
      }

      if (!v.SHOPIFY_APP_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["SHOPIFY_APP_URL"],
          message: "required in production",
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );

    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${lines.join("\n")}`);

    throw new Error("Invalid environment configuration — see log above.");
  }

  return parsed.data;
}

export const env: Env = loadEnv();
export const isProduction = env.NODE_ENV === "production";

