import { ValidationError } from "../services/errors.server";

/**
 * Normalize an Indian mobile to E.164 (+91XXXXXXXXXX). Accepts inputs with or
 * without +91 / 0 prefix and stray spaces/dashes. Throws ValidationError on
 * anything that isn't a valid 10-digit Indian mobile (leading 6-9).
 */
export function normalizeIndianPhone(input: string): {
  e164: string;
  local10: string;
} {
  const digits = (input ?? "").replace(/[^\d]/g, "");
  let local = digits;
  if (local.startsWith("91") && local.length === 12) local = local.slice(2);
  else if (local.startsWith("0") && local.length === 11) local = local.slice(1);

  if (!/^[6-9]\d{9}$/.test(local)) {
    throw new ValidationError("Enter a valid 10-digit Indian mobile number.");
  }
  return { e164: `+91${local}`, local10: local };
}
