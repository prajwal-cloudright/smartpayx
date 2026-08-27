import { PgProvider } from "@prisma/client";
import type { PgAdapter } from "./types";
import { razorpayAdapter } from "./razorpay.server";
import { pinelabsAdapter } from "./pinelabs.server";
import { ConfigError } from "../errors.server";

const ADAPTERS: Record<PgProvider, PgAdapter> = {
  [PgProvider.RAZORPAY]: razorpayAdapter,
  [PgProvider.PINELABS]: pinelabsAdapter,
};

export function getAdapter(pg: PgProvider): PgAdapter {
  const adapter = ADAPTERS[pg];
  if (!adapter)
    throw new ConfigError(`No adapter implemented for ${pg}`, { pg });
  return adapter;
}
