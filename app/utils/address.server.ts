/** States and union territories, ISO 3166-2:IN codes as Shopify expects them. */
export const INDIAN_STATES = [
  { code: "AN", name: "Andaman and Nicobar Islands" },
  { code: "AP", name: "Andhra Pradesh" },
  { code: "AR", name: "Arunachal Pradesh" },
  { code: "AS", name: "Assam" },
  { code: "BR", name: "Bihar" },
  { code: "CH", name: "Chandigarh" },
  { code: "CT", name: "Chhattisgarh" },
  { code: "DH", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "DL", name: "Delhi" },
  { code: "GA", name: "Goa" },
  { code: "GJ", name: "Gujarat" },
  { code: "HR", name: "Haryana" },
  { code: "HP", name: "Himachal Pradesh" },
  { code: "JK", name: "Jammu and Kashmir" },
  { code: "JH", name: "Jharkhand" },
  { code: "KA", name: "Karnataka" },
  { code: "KL", name: "Kerala" },
  { code: "LA", name: "Ladakh" },
  { code: "LD", name: "Lakshadweep" },
  { code: "MP", name: "Madhya Pradesh" },
  { code: "MH", name: "Maharashtra" },
  { code: "MN", name: "Manipur" },
  { code: "ML", name: "Meghalaya" },
  { code: "MZ", name: "Mizoram" },
  { code: "NL", name: "Nagaland" },
  { code: "OR", name: "Odisha" },
  { code: "PY", name: "Puducherry" },
  { code: "PB", name: "Punjab" },
  { code: "RJ", name: "Rajasthan" },
  { code: "SK", name: "Sikkim" },
  { code: "TN", name: "Tamil Nadu" },
  { code: "TS", name: "Telangana" },
  { code: "TR", name: "Tripura" },
  { code: "UP", name: "Uttar Pradesh" },
  { code: "UT", name: "Uttarakhand" },
  { code: "WB", name: "West Bengal" },
] as const;

export const INDIAN_STATE_CODES: string[] = INDIAN_STATES.map((s) => s.code);
export const INDIAN_STATE_NAMES: string[] = INDIAN_STATES.map((s) => s.name);

/**
 * Pincode prefix → state mapping.
 *
 * The first 2–3 digits of an Indian PIN encode the postal circle, which maps
 * cleanly to state. This is effectively static — new pincodes are allocated
 * within existing circles, so the prefix ranges don't change.
 *
 * Bundled rather than fetched so the address form fills instantly and works
 * even when the India Post API is slow or down.
 */
interface PrefixRange {
  from: number; // inclusive, first 3 digits
  to: number; // inclusive
  state: string; // must match INDIAN_STATES names exactly
}

const PREFIX_RANGES: PrefixRange[] = [
  { from: 110, to: 110, state: "Delhi" },
  { from: 111, to: 118, state: "Haryana" },
  { from: 120, to: 136, state: "Haryana" },
  { from: 140, to: 160, state: "Punjab" },
  { from: 160, to: 160, state: "Chandigarh" },
  { from: 161, to: 174, state: "Punjab" },
  { from: 171, to: 177, state: "Himachal Pradesh" },
  { from: 180, to: 194, state: "Jammu and Kashmir" },
  { from: 194, to: 194, state: "Ladakh" },
  { from: 201, to: 285, state: "Uttar Pradesh" },
  { from: 244, to: 263, state: "Uttarakhand" },
  { from: 301, to: 345, state: "Rajasthan" },
  { from: 360, to: 396, state: "Gujarat" },
  { from: 396, to: 396, state: "Dadra and Nagar Haveli and Daman and Diu" },
  { from: 400, to: 445, state: "Maharashtra" },
  { from: 450, to: 488, state: "Madhya Pradesh" },
  { from: 490, to: 497, state: "Chhattisgarh" },
  { from: 500, to: 509, state: "Telangana" },
  { from: 515, to: 535, state: "Andhra Pradesh" },
  { from: 560, to: 591, state: "Karnataka" },
  { from: 600, to: 643, state: "Tamil Nadu" },
  { from: 605, to: 605, state: "Puducherry" },
  { from: 670, to: 695, state: "Kerala" },
  { from: 682, to: 682, state: "Lakshadweep" },
  { from: 700, to: 743, state: "West Bengal" },
  { from: 744, to: 744, state: "Andaman and Nicobar Islands" },
  { from: 751, to: 770, state: "Odisha" },
  { from: 781, to: 788, state: "Assam" },
  { from: 790, to: 792, state: "Arunachal Pradesh" },
  { from: 793, to: 794, state: "Meghalaya" },
  { from: 795, to: 795, state: "Manipur" },
  { from: 796, to: 796, state: "Mizoram" },
  { from: 797, to: 798, state: "Nagaland" },
  { from: 799, to: 799, state: "Tripura" },
  { from: 800, to: 855, state: "Bihar" },
  { from: 814, to: 835, state: "Jharkhand" },
  { from: 737, to: 737, state: "Sikkim" },
];

export function stateFromPincode(pincode: string): string | null {
  if (!/^[1-9]\d{5}$/.test(pincode)) return null;
  const prefix = Number(pincode.slice(0, 3));
  let match: string | null = null;
  for (const range of PREFIX_RANGES) {
    if (prefix >= range.from && prefix <= range.to) match = range.state;
  }
  return match;
}
