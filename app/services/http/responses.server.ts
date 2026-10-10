/**
 * API response helpers. Error shape is stable and widget-facing:
 *   { error: { code, message, ...extra } }
 * Guards `throw` these Responses; React Router returns them as-is.
 */
export function apiError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

export function apiOk<T extends Record<string, unknown>>(
  data: T,
  init?: ResponseInit,
): Response {
  return Response.json(data, init);
}
