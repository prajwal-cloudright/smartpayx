/** Minor-unit strings from the API → display. Never do money math client-side. */
const fmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });

export function money(minorStr, currency = "INR") {
  const minor = Number(minorStr ?? 0);
  if (!Number.isFinite(minor)) return "";
  const major = minor / 100;
  if (currency === "INR") return fmt.format(major).replace(/\.00$/, "");
  return `${currency} ${major.toFixed(2)}`;
}
