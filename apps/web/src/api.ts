/**
 * Typed-ish API client. The session token is kept in memory plus localStorage
 * so a reload keeps the user signed in during development.
 */

const TOKEN_KEY = "vibe.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors?: Array<{ field: string; message: string }>,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

  const res = await fetch(path, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? "Request failed", err.fieldErrors);
  }
  return data as T;
}

/** A fresh idempotency key for a single logical write attempt. */
export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
