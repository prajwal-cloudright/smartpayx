/**
 * POST /apps/smartpayx/cancel-attempt — buyer abandoned the gateway UI without
 * paying (closed the SDK modal). Releases the live-attempt slot so they can
 * choose another method immediately, instead of waiting for the 5-minute sweeper.
 *
 * SAFETY: re-fetches from the PG first. "Cancel" against a payment that
 * actually captured is a promotion to CAPTURED, never a cancellation.
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { AttemptStatus, RequestStatus } from "@prisma/client";
import prisma from "../db.server";
import { apiAction } from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";
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

    const checkoutRequest = await getRequestById(body.request_id);
    assertRequestOwnership(checkoutRequest, auth);

    const live = await prisma.paymentAttempt.findFirst({
      where: { requestId: checkoutRequest.id, status: AttemptStatus.INITIATED },
    });
    if (!live)
      return apiOk({ released: false, status: checkoutRequest.status });

    // Authority is always the gateway, never the client's claim of abandonment.
    const outcome = await resolveAttempt(live.id);
    if (outcome === "CAPTURED") {
      logger.info("cancel_attempt.captured_instead", {
        requestId: checkoutRequest.id,
      });
      return apiOk({
        released: false,
        captured: true,
        status: RequestStatus.CAPTURED,
      });
    }

    // Still INITIATED at the gateway = genuinely unpaid. Mark abandoned and
    // return the request to PG selection so another method can be chosen.
    const released = await prisma.paymentAttempt.updateMany({
      where: { id: live.id, status: AttemptStatus.INITIATED },
      data: {
        status: AttemptStatus.ABANDONED,
        failureCode: "USER_DISMISSED",
        resolvedAt: new Date(),
      },
    });
    if (released.count > 0) {
      await prisma.checkoutRequest.updateMany({
        where: {
          id: checkoutRequest.id,
          status: RequestStatus.ATTEMPT_INITIATED,
        },
        data: { status: RequestStatus.AWAITING_PAYMENT },
      });
    }

    return apiOk({
      released: released.count > 0,
      status: RequestStatus.AWAITING_PAYMENT,
    });
  },
);
