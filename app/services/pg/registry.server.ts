/**
 * PG registry — the single extensibility point for supported gateways.
 *
 * ADDING A NEW PG (the whole checklist):
 *   1. Add the value to the `PgProvider` enum in prisma/schema.prisma + a migration.
 *   2. Add an entry to PG_DEFINITIONS below with its credential fields.
 *   3. Implement its adapter in app/services/pg/<name>.server.ts.
 * The settings UI renders its form fields from this registry and the API
 * validates against the same source, so there is exactly one place to edit.
 */
import { PgProvider } from "@prisma/client";
import { z } from "zod";
import { ValidationError } from "../errors.server";

export interface PgFieldDefinition {
  /** key stored inside the sealed credential JSON */
  key: string;
  label: string;
  /** `password` fields are write-only: never returned to the client once saved */
  type: "text" | "password";
  helpText?: string;
}

export interface PgDefinition {
  pg: PgProvider;
  label: string;
  fields: PgFieldDefinition[];
  /** Validates the full credential payload for this PG. */
  schema: z.ZodType<Record<string, string>>;
}

const nonEmpty = (label: string) =>
  z.string().trim().min(1, `${label} is required`);

export const PG_DEFINITIONS: Record<PgProvider, PgDefinition> = {
  [PgProvider.RAZORPAY]: {
    pg: PgProvider.RAZORPAY,
    label: "Razorpay",
    fields: [
      {
        key: "key_id",
        label: "Key ID",
        type: "text",
        helpText: "Starts with rzp_live_ or rzp_test_",
      },
      { key: "merchant_id", label: "Merchant ID", type: "text" },
      {
        key: "key_secret",
        label: "Key secret",
        type: "password",
        helpText: "Stored encrypted; never shown again after saving",
      },
    ],
    schema: z.object({
      key_id: nonEmpty("Key ID"),
      merchant_id: nonEmpty("Merchant ID"),
      key_secret: nonEmpty("Key secret"),
    }),
  },
  [PgProvider.PINELABS]: {
    pg: PgProvider.PINELABS,
    label: "Pine Labs",
    fields: [
      { key: "merchant_id", label: "Merchant ID", type: "text" },
      {
        key: "merchant_access_code",
        label: "Merchant access code",
        type: "text",
      },
      {
        key: "secret_key",
        label: "Secret key",
        type: "password",
        helpText: "Stored encrypted; never shown again after saving",
      },
    ],
    schema: z.object({
      merchant_id: nonEmpty("Merchant ID"),
      merchant_access_code: nonEmpty("Merchant access code"),
      secret_key: nonEmpty("Secret key"),
    }),
  },
};

export const SUPPORTED_PGS: PgProvider[] = Object.keys(
  PG_DEFINITIONS,
) as PgProvider[];

export function getPgDefinition(pg: PgProvider): PgDefinition {
  const definition = PG_DEFINITIONS[pg];
  if (!definition)
    throw new ValidationError(`Unsupported payment gateway: ${pg}`);
  return definition;
}

export function validatePgCredentials(
  pg: PgProvider,
  credentials: Record<string, string>,
): Record<string, string> {
  const result = getPgDefinition(pg).schema.safeParse(credentials);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ValidationError(`${getPgDefinition(pg).label}: ${message}`, {
      pg,
      issues: result.error.issues,
    });
  }
  return result.data;
}

/** Field keys that must never be echoed back to the client. */
export function secretFieldKeys(pg: PgProvider): string[] {
  return getPgDefinition(pg)
    .fields.filter((f) => f.type === "password")
    .map((f) => f.key);
}

/** Non-secret credential field keys — safe to store in pg_configs and prefill in the UI. */
export function publicFieldKeys(pg: PgProvider): string[] {
  return getPgDefinition(pg)
    .fields.filter((f) => f.type === "text")
    .map((f) => f.key);
}

/** Client-safe registry payload for rendering the settings form. */
export function pgRegistryForClient() {
  return SUPPORTED_PGS.map((pg) => {
    const d = getPgDefinition(pg);
    return { pg: d.pg, label: d.label, fields: d.fields };
  });
}
