/**
 * Typed application errors. Services throw these; `withErrorHandling`
 * (route-utils) maps them to HTTP responses. Never leak internals to clients —
 * `message` is safe to surface, `cause`/`detail` are for logs only.
 */
export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "CONFLICT"
  | "SHOPIFY_API_ERROR"
  | "PG_ERROR"
  | "CRYPTO_ERROR"
  | "CONFIG_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    status = 500,
    options?: { detail?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.detail = options?.detail;
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    detail?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super("VALIDATION_ERROR", message, 422, { detail, cause });
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("NOT_FOUND", message, 404, { detail });
    this.name = "NotFoundError";
  }
}

export class ConfigError extends AppError {
  constructor(
    message: string,
    detail?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super("CONFIG_ERROR", message, 500, { detail, cause });
    this.name = "ConfigError";
  }
}

/** Shopify Admin/Storefront GraphQL failure — transport, GraphQL errors, or userErrors. */
export class ShopifyApiError extends AppError {
  readonly operation: string;
  readonly userErrors: { field?: string[] | null; message: string }[];

  constructor(
    operation: string,
    message: string,
    options?: {
      userErrors?: { field?: string[] | null; message: string }[];
      detail?: Record<string, unknown>;
      cause?: unknown;
      status?: number;
    },
  ) {
    super("SHOPIFY_API_ERROR", message, options?.status ?? 500, {
      detail: { operation, ...options?.detail },
      cause: options?.cause,
    });
    this.name = "ShopifyApiError";
    this.operation = operation;
    this.userErrors = options?.userErrors ?? [];
  }
}

/** Narrow an unknown catch value to a message without losing non-Error throws. */
export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
