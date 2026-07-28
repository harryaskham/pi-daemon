import type { IncomingMessage } from "node:http";

/**
 * Shared HTTP request-contract primitives for the bearer-authenticated API
 * surface (bd-23110a).
 *
 * These are deliberately transport-level and route-agnostic: the typed request
 * error, the bounded body reader, and the value coercers used by both the
 * legacy session/ticket routes and the neutral Dashboard routes. Keeping them
 * here lets `api-server.ts` retain sole ownership of admission, response
 * envelopes, and WebSocket routing while route modules stay small and testable.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function readBoundedJson(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = /^\d+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new ApiRequestError(400, "invalid_content_length", "Content-Length is invalid");
    }
    if (parsedLength > maxBodyBytes) {
      throw new ApiRequestError(413, "body_too_large", "JSON request body exceeds byte limit");
    }
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      throw new ApiRequestError(413, "body_too_large", "JSON request body exceeds byte limit");
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ApiRequestError(400, "invalid_json", "JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw new ApiRequestError(400, "invalid_json", "request body is not valid JSON");
  }
}

export function assertMatchingRequestId(
  header: string | string[] | undefined,
  bodyRequestId: string,
): void {
  if (header !== undefined && (typeof header !== "string" || header !== bodyRequestId)) {
    throw new ApiRequestError(
      400,
      "request_id_mismatch",
      "X-Request-Id must match the mutation body requestId",
    );
  }
}

export function apiRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function apiString(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > max ||
    /[\u0000]/.test(value)
  ) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} is invalid`);
  }
  return value;
}

export function apiOptionalString(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): string | undefined {
  return value === undefined ? undefined : apiString(value, field, max, allowEmpty);
}

export function apiInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ApiRequestError(400, "invalid_session_spec", `${field} is invalid`);
  }
  return value as number;
}
