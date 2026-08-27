/**
 * GET /healthz — resource route for load balancer health checks (EB target group).
 * 200 when the database answers, 503 otherwise. No auth, no CORS (same-origin
 * infra probe, not a browser call), returns no secrets.
 */
import { checkDatabase } from "../db.server";
import { apiLoader } from "../services/http/route-utils.server";
import { apiOk } from "../services/http/responses.server";

export const loader = apiLoader(async () => {
  const db = await checkDatabase();
  return apiOk(
    {
      status: db.ok ? "ok" : "degraded",
      db,
      uptimeSec: Math.floor(process.uptime()),
    },
    { status: db.ok ? 200 : 503 },
  );
});
