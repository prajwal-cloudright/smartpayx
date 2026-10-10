/**
 * Safe request body parsers. `request.json()` throws a SyntaxError on an
 * empty or malformed body — these surface that as a clean 400 rather than an
 * unhandled error, and handle the common case of a missing Content-Type.
 */
import { ValidationError } from "../services/errors.server";

export async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (!text.trim()) {
    throw new ValidationError("Request body is required.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}
