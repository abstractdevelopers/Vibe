/**
 * Typed-ish API client. The session token is kept in memory plus localStorage
 * so a reload keeps the user signed in during development.
 */

const TOKEN_KEY = "vibe.token";

/**
 * Where the API lives.
 *
 * In development Vite proxies `/v1` and `/health` to the API, so a relative
 * path is right. In production the client is served from the web origin and the
 * API is a separate origin (`VITE_API_URL`, e.g. https://vibeapi.example), so
 * every request has to be absolute. Baking it in at build time is what lets the
 * two tiers live on different hosts; a relative path would call the web host.
 */
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * Resolve a stored media URL for rendering.
 *
 * The API stores paths (`/v1/media/<id>`), not absolute URLs, which keeps them
 * host-independent. When the web client is on a different host from the API, a
 * bare path would resolve against the *web* origin and 404 — so a relative path
 * is resolved against the API origin here. Absolute URLs, and `data:`/`blob:`
 * previews, are returned untouched.
 */
export function mediaSrc(url: string | null | undefined): string {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return apiUrl(url);
}

/** The `wss://host` origin for the realtime socket, matching the API. */
export function realtimeUrl(token: string): string {
  const base = API_BASE || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base.replace(/^http/, "ws")}/v1/realtime?token=${encodeURIComponent(token)}`;
}

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

  const res = await fetch(apiUrl(path), {
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
