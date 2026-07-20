/**
 * Official Skill Catalog client (Issue #1231)
 *
 * One server-side owner of "what the Catalog says", shared by the UI and the
 * CLI so a displayed version can never disagree with an installed one.
 *
 * Guarantees, in the order they matter:
 * 1. The cached document is only ever replaced by a response that passed
 *    {@link validateSkillCatalog}. A failed fetch, an oversized body, malformed
 *    JSON or a schema violation all leave the last known good document intact.
 * 2. Anything not confirmed current within the TTL is reported with
 *    `stale: true` and a reason. Stale data is legal to *browse* (UX-07) and is
 *    never presented as fresh.
 * 3. The endpoint is a hardcoded constant behind an exact-match allow-list.
 *
 * @module lib/skills/catalog-client
 */

import {
  SKILL_CATALOG_ACCEPT,
  SKILL_CATALOG_CACHE_TTL_MS,
  SKILL_CATALOG_FETCH_TIMEOUT_MS,
  SKILL_CATALOG_MAX_BYTES,
  SKILL_CATALOG_RATE_LIMIT_COOLDOWN_MS,
  SKILL_CATALOG_RATE_LIMIT_MAX_MS,
  SKILL_CATALOG_REF,
  SKILL_CATALOG_REPOSITORY,
  SKILL_CATALOG_REVISION_PATTERN,
  SKILL_CATALOG_URL,
  buildSkillCatalogUserAgent,
  isAllowedSkillCatalogUrl,
} from '@/config/skill-catalog-config';
import { createLogger } from '@/lib/logger';
import { validateSkillCatalog } from '@/lib/skills/schema';
import type { SkillContractError } from '@/lib/skills/errors';
import type { SkillCatalog } from '@/types/skills';

const logger = createLogger('lib/skills/catalog-client');

// =============================================================================
// Result vocabulary
// =============================================================================

/** How the returned document was obtained. */
export type SkillCatalogState =
  /** Freshly fetched and validated in this call. */
  | 'fresh'
  /** Origin answered 304; the cached document is confirmed current. */
  | 'revalidated'
  /** Served from cache within the TTL, no request made. */
  | 'cached'
  /** Served from cache after revalidation failed. Always `stale: true`. */
  | 'stale';

/** Why a snapshot is stale. */
export const SkillCatalogStaleReason = {
  /** Network error, timeout or non-OK status. */
  FETCH_FAILED: 'SKILL_CATALOG_FETCH_FAILED',
  /** Origin is rate limiting; no request was attempted. */
  RATE_LIMITED: 'SKILL_CATALOG_RATE_LIMITED',
  /** Response body exceeded the size cap. */
  OVERSIZED: 'SKILL_CATALOG_OVERSIZED',
  /** Body was not parsable JSON. */
  MALFORMED: 'SKILL_CATALOG_MALFORMED',
  /** Body parsed but failed contract validation (includes unknown schema_version). */
  INVALID_SCHEMA: 'SKILL_CATALOG_INVALID_SCHEMA',
} as const;

export type SkillCatalogFailureCode =
  (typeof SkillCatalogStaleReason)[keyof typeof SkillCatalogStaleReason];

/** Source coordinates of the served document. */
export interface SkillCatalogSource {
  repository: string;
  ref: string;
  /**
   * Origin cache validator (ETag) of the served document, or null.
   *
   * The Catalog document of schema_version 1 carries no top-level commit SHA,
   * so this is the only document-level revision identifier available. The
   * trusted per-release coordinate is `versions[].source.commit`.
   */
  revision: string | null;
}

/** A Catalog document together with everything needed to judge its freshness. */
export interface SkillCatalogSnapshot {
  catalog: SkillCatalog;
  /** RFC 3339 UTC instant the served document was last validated. */
  fetchedAt: string;
  /** RFC 3339 UTC instant the document was last confirmed current with the origin. */
  revalidatedAt: string;
  state: SkillCatalogState;
  /** True whenever the document could not be confirmed current. */
  stale: boolean;
  /** True when the last attempt could not reach a usable origin response. */
  offline: boolean;
  staleReason: SkillCatalogFailureCode | null;
  source: SkillCatalogSource;
}

/** Failure returned when there is no last known good document to fall back on. */
export interface SkillCatalogFailure {
  code: SkillCatalogFailureCode;
  message: string;
  /** Contract validation errors, present only for `INVALID_SCHEMA`. */
  errors: readonly SkillContractError[];
}

export type SkillCatalogResult =
  | { ok: true; snapshot: SkillCatalogSnapshot }
  | { ok: false; failure: SkillCatalogFailure };

// =============================================================================
// Cache (globalThis, hot-reload resistant — version-checker.ts precedent)
// =============================================================================

interface SkillCatalogCache {
  /** Last document that passed validation. Never overwritten by an invalid one. */
  catalog: SkillCatalog | null;
  /** Epoch ms of the last successful validation. */
  validatedAt: number;
  /** Epoch ms the document was last confirmed current (200 or 304). */
  confirmedAt: number;
  etag: string | null;
  revision: string | null;
  rateLimitResetAt: number | null;
  /** Single-flight guard so concurrent callers share one origin request. */
  inflight: Promise<SkillCatalogResult> | null;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern (version-checker.ts:97-107 precedent)
  var __skillCatalogCache: SkillCatalogCache | undefined;
}

const cache: SkillCatalogCache = (globalThis.__skillCatalogCache ??= {
  catalog: null,
  validatedAt: 0,
  confirmedAt: 0,
  etag: null,
  revision: null,
  rateLimitResetAt: null,
  inflight: null,
});

// =============================================================================
// Internal helpers
// =============================================================================

class BoundedBodyError extends Error {}

const FAILURE_MESSAGES: Record<SkillCatalogFailureCode, string> = {
  [SkillCatalogStaleReason.FETCH_FAILED]: 'The Skill Catalog could not be retrieved.',
  [SkillCatalogStaleReason.RATE_LIMITED]: 'The Skill Catalog origin is rate limiting requests.',
  [SkillCatalogStaleReason.OVERSIZED]: 'The Skill Catalog response exceeded the allowed size.',
  [SkillCatalogStaleReason.MALFORMED]: 'The Skill Catalog response was not valid JSON.',
  [SkillCatalogStaleReason.INVALID_SCHEMA]:
    'The Skill Catalog response did not match the supported Catalog schema.',
};

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function sanitizeRevision(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return SKILL_CATALOG_REVISION_PATTERN.test(trimmed) ? trimmed : null;
}

function buildSnapshot(
  catalog: SkillCatalog,
  state: SkillCatalogState,
  staleReason: SkillCatalogFailureCode | null
): SkillCatalogSnapshot {
  return {
    catalog,
    fetchedAt: toIso(cache.validatedAt),
    revalidatedAt: toIso(cache.confirmedAt),
    state,
    stale: state === 'stale',
    offline: state === 'stale',
    staleReason,
    source: {
      repository: SKILL_CATALOG_REPOSITORY,
      ref: SKILL_CATALOG_REF,
      revision: cache.revision,
    },
  };
}

/** Serve the last known good document, or fail when there is none. */
function degrade(code: SkillCatalogFailureCode, errors: readonly SkillContractError[] = []): SkillCatalogResult {
  if (cache.catalog) {
    return { ok: true, snapshot: buildSnapshot(cache.catalog, 'stale', code) };
  }
  return { ok: false, failure: { code, message: FAILURE_MESSAGES[code], errors } };
}

function isFresh(): boolean {
  return cache.catalog !== null && Date.now() - cache.confirmedAt < SKILL_CATALOG_CACHE_TTL_MS;
}

function isRateLimited(): boolean {
  if (cache.rateLimitResetAt === null) return false;
  if (Date.now() >= cache.rateLimitResetAt) {
    cache.rateLimitResetAt = null;
    return false;
  }
  return true;
}

/**
 * Record a back-off from a rate-limited response.
 *
 * Honours `X-RateLimit-Reset` (epoch seconds) and `Retry-After` (delta seconds),
 * but clamps to {@link SKILL_CATALOG_RATE_LIMIT_MAX_MS} so a hostile or broken
 * header cannot pin the client offline indefinitely.
 */
function recordRateLimit(response: Response): void {
  const now = Date.now();
  const max = now + SKILL_CATALOG_RATE_LIMIT_MAX_MS;

  const resetHeader = response.headers.get('X-RateLimit-Reset');
  if (resetHeader !== null) {
    const seconds = Number(resetHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      cache.rateLimitResetAt = Math.min(seconds * 1000, max);
      return;
    }
  }

  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      cache.rateLimitResetAt = Math.min(now + seconds * 1000, max);
      return;
    }
  }

  cache.rateLimitResetAt = now + SKILL_CATALOG_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Read a response body with a hard byte cap.
 *
 * The declared Content-Length is checked first as a cheap reject, then the
 * bytes actually read are counted — a response that omits or understates its
 * length is still cut off at the cap.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) {
      throw new BoundedBodyError('content-length out of bounds');
    }
  }

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) {
      throw new BoundedBodyError('body exceeded size cap');
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BoundedBodyError('body exceeded size cap');
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

async function revalidate(hostVersion: string): Promise<SkillCatalogResult> {
  // Re-checked immediately before the request: the URL is a module constant, and
  // this assertion is what makes that a guarantee rather than a convention.
  if (!isAllowedSkillCatalogUrl(SKILL_CATALOG_URL)) {
    return degrade(SkillCatalogStaleReason.FETCH_FAILED);
  }

  const headers: Record<string, string> = {
    Accept: SKILL_CATALOG_ACCEPT,
    'User-Agent': buildSkillCatalogUserAgent(hostVersion),
  };
  if (cache.catalog !== null && cache.etag !== null) {
    headers['If-None-Match'] = cache.etag;
  }

  let response: Response;
  try {
    response = await fetch(SKILL_CATALOG_URL, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(SKILL_CATALOG_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Network error or timeout. No response detail is logged: it can echo the
    // request URL and, under a proxy, credentials.
    logger.warn('catalog-fetch-failed', { reason: SkillCatalogStaleReason.FETCH_FAILED });
    return degrade(SkillCatalogStaleReason.FETCH_FAILED);
  }

  if (response.status === 304 && cache.catalog !== null) {
    cache.confirmedAt = Date.now();
    return { ok: true, snapshot: buildSnapshot(cache.catalog, 'revalidated', null) };
  }

  if (response.status === 403 || response.status === 429) {
    recordRateLimit(response);
    logger.warn('catalog-rate-limited', { status: response.status });
    return degrade(SkillCatalogStaleReason.RATE_LIMITED);
  }

  if (!response.ok) {
    logger.warn('catalog-fetch-failed', { status: response.status });
    return degrade(SkillCatalogStaleReason.FETCH_FAILED);
  }

  let text: string;
  try {
    text = await readBoundedText(response, SKILL_CATALOG_MAX_BYTES);
  } catch (error) {
    const code =
      error instanceof BoundedBodyError
        ? SkillCatalogStaleReason.OVERSIZED
        : SkillCatalogStaleReason.FETCH_FAILED;
    logger.warn('catalog-body-rejected', { reason: code });
    return degrade(code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The body itself is never logged: it is untrusted remote content.
    logger.warn('catalog-malformed', { reason: SkillCatalogStaleReason.MALFORMED });
    return degrade(SkillCatalogStaleReason.MALFORMED);
  }

  const validation = validateSkillCatalog(parsed);
  if (!validation.ok) {
    logger.warn('catalog-invalid-schema', { errorCount: validation.errors.length });
    return degrade(SkillCatalogStaleReason.INVALID_SCHEMA, validation.errors);
  }

  const now = Date.now();
  cache.catalog = validation.value;
  cache.validatedAt = now;
  cache.confirmedAt = now;
  cache.etag = response.headers.get('ETag');
  cache.revision = sanitizeRevision(cache.etag);

  return { ok: true, snapshot: buildSnapshot(validation.value, 'fresh', null) };
}

// =============================================================================
// Public API
// =============================================================================

/** Options for {@link getSkillCatalog}. */
export interface GetSkillCatalogOptions {
  /** CommandMate version sent as User-Agent. Never affects the URL. */
  hostVersion?: string;
  /** Bypass the TTL and force a conditional revalidation. */
  forceRevalidate?: boolean;
}

/**
 * Get the official Catalog, revalidating against the origin when the TTL lapsed.
 *
 * Concurrent callers share a single in-flight request. Returns `ok: false` only
 * when retrieval failed *and* there is no last known good document to serve.
 */
export async function getSkillCatalog(
  options: GetSkillCatalogOptions = {}
): Promise<SkillCatalogResult> {
  const { hostVersion = '0.0.0', forceRevalidate = false } = options;

  if (!forceRevalidate && isFresh() && cache.catalog !== null) {
    return { ok: true, snapshot: buildSnapshot(cache.catalog, 'cached', null) };
  }

  if (isRateLimited()) {
    return degrade(SkillCatalogStaleReason.RATE_LIMITED);
  }

  if (cache.inflight === null) {
    cache.inflight = revalidate(hostVersion).finally(() => {
      cache.inflight = null;
    });
  }
  return cache.inflight;
}

/**
 * Reset the module cache.
 * @internal Test-only.
 */
export function resetSkillCatalogCacheForTesting(): void {
  cache.catalog = null;
  cache.validatedAt = 0;
  cache.confirmedAt = 0;
  cache.etag = null;
  cache.revision = null;
  cache.rateLimitResetAt = null;
  cache.inflight = null;
}
