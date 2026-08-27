/**
 * GET /apps/smartpayx/pincode/:pincode — address autofill lookup.
 *
 * India Post is the authoritative source and returns state, district and block
 * in one call. The bundled prefix map is a FALLBACK only, for when the API is
 * slow or down — it's hand-maintained and ambiguous at state borders, so it
 * must never override a successful API response.
 */
import type { LoaderFunctionArgs } from "react-router";
import { apiLoader } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import { logger } from "../utils/logger.server";
import { INDIAN_STATE_NAMES, stateFromPincode } from "../utils/address.server";
import prisma from "app/db.server";

interface PincodeLookup {
  state: string | null;
  city: string | null;
  district: string | null;
  source: "API" | "FALLBACK" | "NONE";
}

/**
 * Normalize India Post's state name to the exact string in our state list —
 * the address schema validates against those names, so a mismatch ("Orissa"
 * vs "Odisha", "Pondicherry" vs "Puducherry") would fail validation on submit.
 */
function normalizeState(apiState: string | null | undefined): string | null {
  if (!apiState) return null;
  const trimmed = apiState.trim();

  const exact = INDIAN_STATE_NAMES.find(
    (s) => s.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exact) return exact;

  const aliases: Record<string, string> = {
    orissa: "Odisha",
    pondicherry: "Puducherry",
    uttaranchal: "Uttarakhand",
    "jammu & kashmir": "Jammu and Kashmir",
    "andaman & nicobar islands": "Andaman and Nicobar Islands",
    "dadra & nagar haveli": "Dadra and Nagar Haveli and Daman and Diu",
    "daman & diu": "Dadra and Nagar Haveli and Daman and Diu",
  };
  const aliased = aliases[trimmed.toLowerCase()];
  if (aliased) return aliased;

  logger.warn("pincode.unmapped_state_name", { apiState: trimmed });
  return null;
}

async function lookupFromApi(pincode: string): Promise<PincodeLookup | null> {
  try {
    const response = await fetch(
      `https://api.postalpincode.in/pincode/${pincode}`,
      {
        signal: AbortSignal.timeout(2500),
        headers: { accept: "application/json" },
      },
    );
    if (!response.ok) return null;

    const payload: any = await response.json();
    const entry = Array.isArray(payload) ? payload[0] : null;
    if (entry?.Status !== "Success" || !entry?.PostOffice?.length) return null;

    const office = entry.PostOffice[0];
    return {
      state: normalizeState(office.State),
      // Block/Taluk is usually closer to how people write their city; District
      // is the fallback.
      city:
        office.Block && office.Block !== "NA"
          ? office.Block
          : (office.District ?? null),
      district: office.District ?? null,
      source: "API",
    };
  } catch (error) {
    logger.warn("pincode.api_lookup_failed", { pincode });
    return null;
  }
}

export const loader = apiLoader(
  async ({ request, params }: LoaderFunctionArgs) => {
    await authenticateProxy(request);

    const pincode = (params.pincode ?? "").trim();
    if (!/^[1-9]\d{5}$/.test(pincode)) {
      return apiError("INVALID_PINCODE", "Enter a valid 6-digit pincode.", 422);
    }

    // Pincode→state data is effectively immutable, so cache indefinitely. After
    // a short warm-up this serves nearly all lookups locally, which removes
    // India Post from the checkout critical path.
    const cached = await prisma.pincodeCache.findUnique({ where: { pincode } });
    if (cached) {
      return apiOk({
        pincode,
        state: cached.state,
        city: cached.city,
        district: cached.district,
        country: "IN",
        source: "CACHE",
        serviceable: true,
      });
    }

    const fromApi = await lookupFromApi(pincode);

    if (fromApi?.state) {
      await prisma.pincodeCache
        .create({
          data: {
            pincode,
            state: fromApi.state,
            city: fromApi.city,
            district: fromApi.district,
          },
        })
        .catch(() => undefined); // race on concurrent lookups is harmless
    }

    // Fall back to the prefix map only when the API gave us nothing usable.
    const result: PincodeLookup = fromApi?.state
      ? fromApi
      : {
          state: stateFromPincode(pincode),
          city: fromApi?.city ?? null,
          district: fromApi?.district ?? null,
          source: fromApi?.state
            ? "API"
            : stateFromPincode(pincode)
              ? "FALLBACK"
              : "NONE",
        };

    return apiOk({
      pincode,
      state: result.state,
      city: result.city,
      district: result.district,
      country: "IN",
      source: result.source,
      serviceable: true, // placeholder for a future COD/courier serviceability check
    });
  },
);
