/**
 * Guarded fetching of official Skill Catalogs and release artifacts (Issue #1229)
 *
 * Every request this module makes is pinned to the allowlist in
 * `src/config/skill-security-config.ts`. Redirects are followed manually so
 * each hop is re-validated and credential headers are dropped when the origin
 * changes — `redirect: 'follow'` would hand both decisions to undici.
 *
 * Bodies are streamed with a running size cap and hashed as they arrive, so an
 * oversized or wrong-digest response is abandoned mid-transfer instead of being
 * buffered first. Archives are never opened here: extraction and entry
 * inspection are #1230's responsibility.
 *
 * @module lib/skills/artifact-downloader
 */

import {
  SKILL_CREDENTIAL_HEADERS,
  SKILL_FETCH_HEADER_TIMEOUT_MS,
  SKILL_FETCH_MAX_REDIRECTS,
  SKILL_FETCH_TOTAL_TIMEOUT_MS,
  SKILL_FETCH_USER_AGENT_PREFIX,
  SKILL_SOURCE_POLICIES,
  type SkillHostRule,
  type SkillSourceKind,
  type SkillSourcePolicy,
} from '@/config/skill-security-config';
import {
  SkillFetchError,
  SkillFetchErrorCode,
  assertArtifactBinding,
  createSha256Accumulator,
  verifyArtifactIntegrity,
} from '@/lib/skills/integrity';
import { getCurrentVersion } from '@/lib/version-checker';
import type { SkillCatalogVersion } from '@/types/skills';

// =============================================================================
// Types
// =============================================================================

/** Bytes received from an allowed source, with the digest measured in transit. */
export interface SkillSourcePayload {
  bytes: Uint8Array;
  /** Lowercase hex SHA-256 of {@link bytes}. */
  sha256: string;
  size: number;
}

/** A verified artifact, bound to the Catalog coordinates it was fetched for. */
export interface SkillArtifactDownload extends SkillSourcePayload {
  skillId: string;
  version: string;
  /** Resolved 40-hex commit the version was published from. */
  commit: string;
}

/** Caller-controlled knobs. No URL and no host may be supplied here by design. */
export interface SkillFetchOptions {
  signal?: AbortSignal;
}

// =============================================================================
// URL policy
// =============================================================================

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Validate a URL against a set of host rules.
 *
 * Rejects anything that could be used to reach a host the allowlist did not
 * name: non-HTTPS schemes, embedded credentials and explicit non-default ports.
 *
 * The path check runs against `URL.pathname`, which WHATWG parsing has already
 * stripped of dot segments (raw and `%2e`-encoded alike). That is what makes a
 * plain prefix comparison sufficient: `…/releases/download/../../x` normalizes
 * to a path outside the prefix and is rejected as a disallowed source.
 *
 * @throws SkillFetchError with `URL_INVALID` or `SOURCE_NOT_ALLOWED`
 */
export function assertAllowedSkillUrl(rawUrl: string, rules: readonly SkillHostRule[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SkillFetchError(SkillFetchErrorCode.URL_INVALID, { reason: 'malformed' });
  }

  if (url.protocol !== 'https:') {
    throw new SkillFetchError(SkillFetchErrorCode.URL_INVALID, { reason: 'scheme' });
  }
  if (url.username !== '' || url.password !== '') {
    throw new SkillFetchError(SkillFetchErrorCode.URL_INVALID, { reason: 'userinfo' });
  }
  if (url.port !== '') {
    throw new SkillFetchError(SkillFetchErrorCode.URL_INVALID, { reason: 'port' });
  }
  const host = url.hostname.toLowerCase();
  const rule = rules.find((candidate) => candidate.host === host);
  if (!rule) {
    throw new SkillFetchError(SkillFetchErrorCode.SOURCE_NOT_ALLOWED, { host });
  }
  if (rule.pathPrefix !== undefined && !url.pathname.startsWith(rule.pathPrefix)) {
    throw new SkillFetchError(SkillFetchErrorCode.SOURCE_NOT_ALLOWED, { host });
  }
  return url;
}

// =============================================================================
// Request scope (timeouts + abort classification)
// =============================================================================

/**
 * Owns the AbortController for one logical fetch.
 *
 * Timeouts and caller aborts both surface as the same `AbortError` from
 * `fetch`, so the reason has to be recorded when it is triggered rather than
 * inferred afterwards.
 */
class FetchScope {
  readonly controller = new AbortController();
  private timedOut = false;
  private callerAborted = false;
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private readonly callerSignal?: AbortSignal;
  private readonly onCallerAbort = (): void => {
    this.callerAborted = true;
    this.controller.abort();
  };

  constructor(callerSignal?: AbortSignal) {
    this.totalTimer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, SKILL_FETCH_TOTAL_TIMEOUT_MS);

    if (callerSignal) {
      this.callerSignal = callerSignal;
      if (callerSignal.aborted) this.onCallerAbort();
      else callerSignal.addEventListener('abort', this.onCallerAbort, { once: true });
    }
  }

  /** Run one request phase under the shorter header timeout. */
  async withHeaderTimeout<T>(run: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, SKILL_FETCH_HEADER_TIMEOUT_MS);
    try {
      return await run();
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    clearTimeout(this.totalTimer);
    this.callerSignal?.removeEventListener('abort', this.onCallerAbort);
  }

  /** Map a thrown transport error onto the reason we actually recorded. */
  translate(error: unknown): SkillFetchError {
    if (error instanceof SkillFetchError) return error;
    if (this.timedOut) return new SkillFetchError(SkillFetchErrorCode.TIMEOUT);
    if (this.callerAborted) return new SkillFetchError(SkillFetchErrorCode.ABORTED);
    return new SkillFetchError(SkillFetchErrorCode.NETWORK);
  }
}

// =============================================================================
// Guarded transport
// =============================================================================

function buildBaseHeaders(policy: SkillSourcePolicy): Record<string, string> {
  return {
    accept: policy.accept,
    'user-agent': `${SKILL_FETCH_USER_AGENT_PREFIX}/${getCurrentVersion()}`,
  };
}

/**
 * Drop every credential header before a cross-origin hop.
 *
 * CommandMate attaches none today, but a redirect to a signed CDN URL is
 * exactly where a future token would leak, so the strip is unconditional
 * rather than a property of the current header set.
 */
export function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SKILL_CREDENTIAL_HEADERS.includes(name.toLowerCase())) next[name] = value;
  }
  return next;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The socket is being discarded anyway; a cancel failure changes nothing.
  }
}

async function followToFinalResponse(
  rawUrl: string,
  policy: SkillSourcePolicy,
  scope: FetchScope
): Promise<Response> {
  let current = assertAllowedSkillUrl(rawUrl, policy.entryHosts);
  let headers = buildBaseHeaders(policy);

  for (let hop = 0; ; hop++) {
    const response = await scope.withHeaderTimeout(() =>
      fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers,
        signal: scope.controller.signal,
      })
    );

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    await discardBody(response);

    if (hop >= SKILL_FETCH_MAX_REDIRECTS) {
      throw new SkillFetchError(SkillFetchErrorCode.REDIRECT_LIMIT_EXCEEDED, {
        limit: SKILL_FETCH_MAX_REDIRECTS,
      });
    }
    if (!location) {
      throw new SkillFetchError(SkillFetchErrorCode.REDIRECT_INVALID, { reason: 'no-location' });
    }

    let candidate: URL;
    try {
      candidate = new URL(location, current);
    } catch {
      throw new SkillFetchError(SkillFetchErrorCode.REDIRECT_INVALID, { reason: 'malformed' });
    }

    const next = assertAllowedSkillUrl(candidate.toString(), policy.redirectHosts);
    if (next.origin !== current.origin) headers = stripCredentialHeaders(headers);
    current = next;
  }
}

function assertResponseHeaders(
  response: Response,
  policy: SkillSourcePolicy,
  expectedSize?: number
): void {
  if (!response.ok) {
    throw new SkillFetchError(SkillFetchErrorCode.HTTP_STATUS, { status: response.status });
  }

  const rawContentType = response.headers.get('content-type');
  const mediaType = rawContentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!policy.contentTypes.includes(mediaType)) {
    throw new SkillFetchError(SkillFetchErrorCode.CONTENT_TYPE_INVALID, {
      received: mediaType || '<absent>',
    });
  }

  const rawLength = response.headers.get('content-length');
  if (rawLength === null) return;
  const declared = Number(rawLength);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new SkillFetchError(SkillFetchErrorCode.SIZE_MISMATCH, { reason: 'content-length' });
  }
  if (declared > policy.maxBytes) {
    throw new SkillFetchError(SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED, { limit: policy.maxBytes });
  }
  if (expectedSize !== undefined && declared !== expectedSize) {
    throw new SkillFetchError(SkillFetchErrorCode.SIZE_MISMATCH, {
      expected: expectedSize,
      actual: declared,
    });
  }
}

/** Stream the body, aborting the moment the running total passes the cap. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<SkillSourcePayload> {
  const body = response.body;
  if (!body) throw new SkillFetchError(SkillFetchErrorCode.BODY_MISSING);

  const reader = body.getReader();
  const digest = createSha256Accumulator();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SkillFetchError(SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED, { limit: maxBytes });
    }
    digest.update(value);
    chunks.push(value);
  }

  return { bytes: Buffer.concat(chunks, size), sha256: digest.hex(), size };
}

/**
 * Fetch one document from its official source under the matching policy.
 *
 * Exported so the Catalog client (#1231) reuses exactly this transport rather
 * than growing a second, subtly different one.
 */
export async function fetchSkillSource(
  rawUrl: string,
  kind: SkillSourceKind,
  options: SkillFetchOptions & { expectedSize?: number } = {}
): Promise<SkillSourcePayload> {
  const policy = SKILL_SOURCE_POLICIES[kind];
  const scope = new FetchScope(options.signal);
  try {
    const response = await followToFinalResponse(rawUrl, policy, scope);
    try {
      assertResponseHeaders(response, policy, options.expectedSize);
    } catch (error) {
      await discardBody(response);
      throw error;
    }
    return await readBoundedBody(response, policy.maxBytes);
  } catch (error) {
    throw scope.translate(error);
  } finally {
    scope.dispose();
  }
}

// =============================================================================
// Artifact download with in-flight de-duplication
// =============================================================================

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (version-checker.ts precedent)
  var __skillArtifactDownloads: Map<string, Promise<SkillArtifactDownload>> | undefined;
}

const inFlight: Map<string, Promise<SkillArtifactDownload>> =
  globalThis.__skillArtifactDownloads ?? (globalThis.__skillArtifactDownloads = new Map());

/**
 * Reject as soon as the caller aborts, without cancelling a download that other
 * callers are still waiting on.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SkillFetchError(SkillFetchErrorCode.ABORTED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new SkillFetchError(SkillFetchErrorCode.ABORTED));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      }
    );
  });
}

async function runArtifactDownload(
  skillId: string,
  version: SkillCatalogVersion
): Promise<SkillArtifactDownload> {
  const { artifact } = version;
  const payload = await fetchSkillSource(artifact.url, 'artifact', {
    expectedSize: artifact.size,
  });

  verifyArtifactIntegrity({
    expectedSha256: artifact.sha256,
    expectedSize: artifact.size,
    actualSha256: payload.sha256,
    actualSize: payload.size,
  });

  return {
    ...payload,
    skillId,
    version: version.version,
    commit: version.source.commit,
  };
}

/**
 * Download and verify the artifact for one Catalog version.
 *
 * The URL comes from the validated Catalog entry, never from a client. Two
 * callers asking for the same artifact share one transfer; a caller aborting
 * only detaches itself, so a concurrent installer is not collateral damage.
 *
 * @throws SkillFetchError — see {@link SkillFetchErrorCode} for the reasons
 */
export async function downloadSkillArtifact(
  skillId: string,
  version: SkillCatalogVersion,
  options: SkillFetchOptions = {}
): Promise<SkillArtifactDownload> {
  assertArtifactBinding(skillId, version);

  const key = `${skillId}@${version.version}#${version.artifact.sha256}`;
  let shared = inFlight.get(key);
  if (!shared) {
    shared = runArtifactDownload(skillId, version);
    inFlight.set(key, shared);
    void shared
      .catch(() => undefined)
      .finally(() => {
        if (inFlight.get(key) === shared) inFlight.delete(key);
      });
  }

  return options.signal ? raceAbort(shared, options.signal) : shared;
}

/**
 * Drop the in-flight table.
 * @internal
 */
export function resetSkillDownloadsForTesting(): void {
  inFlight.clear();
}
