/**
 * Slash Command Catalog reconcile — guarded HTTP fetch (Issue #1489)
 *
 * All external source fetches go through here so the SSRF policy lives in one
 * place: HTTPS only, an exact host + path-prefix allowlist, a byte cap, and a
 * timeout. Every failure is returned as `{ ok: false }` (never thrown) so the
 * reconcile stays fail-soft — a flaky source leaves the catalog untouched.
 *
 * The `fetchImpl` seam lets tests exercise success/timeout/oversize paths
 * deterministically without touching the network.
 */

export type FetchImpl = typeof fetch;

export interface FetchTextOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  fetchImpl?: FetchImpl;
}

export type FetchTextResult =
  | { ok: true; text: string }
  | { ok: false; warning: string };

/** Default per-request timeout. */
export const RECONCILE_FETCH_TIMEOUT_MS = 8000;
/** Hard cap on any single response body (guards memory on a hostile source). */
export const RECONCILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Allowed source endpoints, as (hostname, path-prefix) pairs.
 *
 * [SEC] SSRF: hostname is compared for exact equality (not suffix) so that a
 * look-alike like `raw.githubusercontent.com.evil.example` is rejected. The
 * codex raw URL carries a release tag, so only its path *prefix* is fixed here;
 * the tag itself is validated separately before the URL is built.
 */
const ALLOWED_ENDPOINTS: ReadonlyArray<{ host: string; pathPrefix: string }> = [
  { host: 'code.claude.com', pathPrefix: '/docs/en/commands.md' },
  { host: 'raw.githubusercontent.com', pathPrefix: '/openai/codex/' },
  { host: 'api.github.com', pathPrefix: '/repos/openai/codex/releases/latest' },
];

/** True when `url` is HTTPS and matches an allowed (host, path-prefix) pair. */
export function isAllowedReconcileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_ENDPOINTS.some(
    (e) => parsed.hostname === e.host && parsed.pathname.startsWith(e.pathPrefix)
  );
}

/**
 * Fetch a text body from an allowlisted URL, fail-soft.
 *
 * Returns `{ ok: false, warning }` for a disallowed URL, network error,
 * timeout, non-2xx status, or an oversized body — never throws.
 */
export async function fetchAllowedText(
  url: string,
  options: FetchTextOptions = {}
): Promise<FetchTextResult> {
  if (!isAllowedReconcileUrl(url)) {
    return { ok: false, warning: `url not allowed: ${url}` };
  }

  const timeoutMs = options.timeoutMs ?? RECONCILE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? RECONCILE_MAX_BYTES;
  const doFetch: FetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: options.headers,
    });
    if (!response.ok) {
      return { ok: false, warning: `http ${response.status} for ${url}` };
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, warning: `response too large (${declared} bytes) for ${url}` };
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, warning: `response too large for ${url}` };
    }
    return { ok: true, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, warning: `fetch failed for ${url}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}
