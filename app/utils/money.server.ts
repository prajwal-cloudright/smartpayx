import { ValidationError } from "../services/errors.server";

export function toMinor(amount: string | number): bigint {
  const s =
    typeof amount === "number" ? amount.toFixed(2) : String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new ValidationError(`Invalid money amount: ${amount}`, { amount });
  }
  const [units, frac = ""] = s.split(".");
  return BigInt(units) * 100n + BigInt(frac.padEnd(2, "0") || "0");
}

export function fromMinor(minor: bigint): string {
  if (minor < 0n) throw new ValidationError(`Negative minor amount: ${minor}`);
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

export function assertMinorInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new ValidationError(
    `${label} is not a non-negative integer minor amount.`,
    { value: String(value) },
  );
}
