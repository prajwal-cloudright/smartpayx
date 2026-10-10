/**
 * POST /apps/smartpayx/cancel-request — explicit user/support action only.
 * NEVER fired by timers (the sweeper and expirer cover all automatic cases).
 *
 * Re-fetches gateway status first: "cancel" against a payment that captured in
 * the meantime is a promotion to CAPTURED, not a cancellation.
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { AttemptStatus, RequestStatus } from "@prisma/client";
import prisma from "../db.server";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk, apiError } from "../services/http/responses.server";
import { parseJsonBody } from "../utils/request.server";
import { authenticateProxy } from "../services/auth/proxy.server";
import {
  requireCustomerSession,
  assertRequestOwnership,
} from "../services/auth/guards.server";
import { getRequestById } from "../services/checkout/request.server";
import { resolveAttempt } from "../services/checkout/resolver.server";
import { logger } from "../utils/logger.server";

const BodySchema = z.object({ request_id: z.string().uuid() });

export const action = apiAction(
  async ({ request: httpRequest }: ActionFunctionArgs) => {
    await authenticateProxy(httpRequest);
    const auth = await requireCustomerSession(httpRequest);
    const body = BodySchema.parse(await parseJsonBody(httpRequest));

    let checkoutRequest = await getRequestById(body.request_id);
    assertRequestOwnership(checkoutRequest, auth);

    // Re-fetch any live attempt BEFORE cancelling — it may have captured.
    const live = await prisma.paymentAttempt.findFirst({
      where: { requestId: checkoutRequest.id, status: AttemptStatus.INITIATED },
    });
    if (live) {
      const outcome = await resolveAttempt(live.id);
      checkoutRequest = await getRequestById(checkoutRequest.id);
      if (outcome === "CAPTURED") {
        logger.info("cancel.captured_instead", {
          requestId: checkoutRequest.id,
        });
        return apiOk({
          status: checkoutRequest.status,
          cancelled: false,
          captured: true,
        });
      }
    }

    const cancellable: RequestStatus[] = [
      RequestStatus.OPEN,
      RequestStatus.ADDRESS_SET,
      RequestStatus.AWAITING_PAYMENT,
    ];
    if (!cancellable.includes(checkoutRequest.status)) {
      return apiError(
        "INVALID_STATE",
        "This checkout can no longer be cancelled.",
        409,
        {
          status: checkoutRequest.status,
        },
      );
    }

    const cancelled = await prisma.checkoutRequest.updateMany({
      where: { id: checkoutRequest.id, status: { in: cancellable } },
      data: { status: RequestStatus.CANCELLED },
    });

    return apiOk({
      status: RequestStatus.CANCELLED,
      cancelled: cancelled.count > 0,
    });
  },
);
