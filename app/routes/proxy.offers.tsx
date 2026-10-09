/**
 * GET /apps/smartpayx/offers?request_id=...
 * v1: static per-PG offer text from shop settings. Kept as its own endpoint so
 * a real offers engine can replace the body without touching /request.
 */
import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { apiLoader, getQueryParams } from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  requireCustomerSession,
  assertRequestOwnership,
} from "../services/auth/guards.server";
import { getRequestById } from "../services/checkout/request.server";
import { getEnabledPgConfigs } from "../services/shops/shop.server";

const QuerySchema = z.object({ request_id: z.string().uuid() });

export const loader = apiLoader(
  async ({ request: httpRequest }: LoaderFunctionArgs) => {
    const { shop } = await authenticateProxy(httpRequest);
    const auth = await requireCustomerSession(httpRequest);
    const { request_id } = QuerySchema.parse(getQueryParams(httpRequest));

    const checkoutRequest = await getRequestById(request_id);
    assertRequestOwnership(checkoutRequest, auth);

    return apiOk({
      offers: getEnabledPgConfigs(shop)
        .filter((c) => Boolean(c.offer_text))
        .map((c) => ({ pg: c.pg, text: c.offer_text! })),
    });
  },
);
