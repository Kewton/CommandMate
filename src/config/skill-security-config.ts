/**
 * Skill fetch/snapshot security policy (Issue #1229)
 *
 * Single source of truth for *where* CommandMate is allowed to fetch Skill
 * documents from and *how much* it is allowed to keep on disk. Every value here
 * is a hardcoded constant: none of it may be derived from environment
 * variables, config files or client input, because that is exactly the SSRF
 * lever this module exists to remove (OWASP A10:2021, same rule as
 * `GITHUB_API_URL` in src/lib/version-checker.ts).
 *
 * Catalog JSON and release assets get *separate* policies: they are served by
 * different origins with different media types, and a Catalog response must
 * never be accepted where an artifact is expected (or vice versa).
 *
 * @module config/skill-security-config
 */

import { GIT_COMMIT_SHA_PATTERN, SKILL_ARTIFACT_CONTENT_TYPE, SKILL_ARTIFACT_MAX_SIZE } from '@/lib/skills';

// =============================================================================
// Official source coordinates
// =============================================================================

/** The only repository Skills may be distributed from in schema_version 1. */
export const SKILL_OFFICIAL_REPOSITORY = 'Kewton/commandmate-skills' as const;

/** Catalog document filename at the repository root. */
export const SKILL_CATALOG_FILENAME = 'catalog.json' as const;

// =============================================================================
// Host rules
// =============================================================================

/** One allowed origin, optionally narrowed to a path prefix. */
export interface SkillHostRule {
  /** Lowercase DNS host. Matched exactly; wildcards are deliberately not supported. */
  readonly host: string;
  /** Required path prefix. Absent means any path on this host is acceptable. */
  readonly pathPrefix?: string;
}

/** Catalog JSON is served by the raw content host, pinned to the official repo. */
const CATALOG_HOSTS: readonly SkillHostRule[] = [
  { host: 'raw.githubusercontent.com', pathPrefix: `/${SKILL_OFFICIAL_REPOSITORY}/` },
];

/** Release asset downloads always start at the release download path. */
const ARTIFACT_ENTRY_HOSTS: readonly SkillHostRule[] = [
  { host: 'github.com', pathPrefix: `/${SKILL_OFFICIAL_REPOSITORY}/releases/download/` },
];

/**
 * Hosts a release asset download may be redirected to.
 *
 * GitHub hands release assets off to a storage CDN with an opaque, signed path,
 * so no path prefix can be asserted on these hops. The artifact digest check is
 * what makes that acceptable: a wrong body from an allowed host still fails.
 */
const ARTIFACT_REDIRECT_HOSTS: readonly SkillHostRule[] = [
  ...ARTIFACT_ENTRY_HOSTS,
  { host: 'objects.githubusercontent.com' },
  { host: 'release-assets.githubusercontent.com' },
];

// =============================================================================
// Source policies
// =============================================================================

/** Which document a request is for. Policies are never interchangeable. */
export type SkillSourceKind = 'catalog' | 'artifact';

/** Complete fetch policy for one document kind. */
export interface SkillSourcePolicy {
  readonly kind: SkillSourceKind;
  /** Origins accepted for the first request. */
  readonly entryHosts: readonly SkillHostRule[];
  /** Origins accepted for any redirect hop. */
  readonly redirectHosts: readonly SkillHostRule[];
  /** Value sent as `Accept`. */
  readonly accept: string;
  /** Media types accepted in the response, parameters stripped. */
  readonly contentTypes: readonly string[];
  /** Hard cap on the response body in bytes, enforced against the measured stream. */
  readonly maxBytes: number;
}

/** Maximum Catalog document size in bytes (4 MiB). */
export const SKILL_CATALOG_MAX_SIZE = 4 * 1024 * 1024;

/**
 * `raw.githubusercontent.com` serves `.json` as `text/plain`, so the Catalog
 * policy has to accept it. The document is parsed as JSON regardless of the
 * declared type, and validated by `validateSkillCatalog` afterwards.
 */
const CATALOG_CONTENT_TYPES = ['application/json', 'text/plain'] as const;

export const SKILL_SOURCE_POLICIES: Readonly<Record<SkillSourceKind, SkillSourcePolicy>> = {
  catalog: {
    kind: 'catalog',
    entryHosts: CATALOG_HOSTS,
    redirectHosts: CATALOG_HOSTS,
    accept: 'application/json',
    contentTypes: CATALOG_CONTENT_TYPES,
    maxBytes: SKILL_CATALOG_MAX_SIZE,
  },
  artifact: {
    kind: 'artifact',
    entryHosts: ARTIFACT_ENTRY_HOSTS,
    redirectHosts: ARTIFACT_REDIRECT_HOSTS,
    accept: SKILL_ARTIFACT_CONTENT_TYPE,
    contentTypes: [SKILL_ARTIFACT_CONTENT_TYPE, 'application/octet-stream'],
    maxBytes: SKILL_ARTIFACT_MAX_SIZE,
  },
};

// =============================================================================
// Transport limits
// =============================================================================

/** Maximum number of redirect hops before a fetch fails closed. */
export const SKILL_FETCH_MAX_REDIRECTS = 5;

/** Timeout for receiving response headers, in milliseconds. */
export const SKILL_FETCH_HEADER_TIMEOUT_MS = 10_000;

/** Timeout for the whole request including body transfer, in milliseconds. */
export const SKILL_FETCH_TOTAL_TIMEOUT_MS = 120_000;

/**
 * Request headers dropped when a redirect crosses an origin.
 *
 * `fetch` with `redirect: 'manual'` gives us the hop, so credential forwarding
 * is our responsibility: a signed CDN redirect must never carry a GitHub token.
 */
export const SKILL_CREDENTIAL_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'proxy-authorization',
];

/** Value sent as `User-Agent`, matching the version-checker convention. */
export const SKILL_FETCH_USER_AGENT_PREFIX = 'CommandMate' as const;

// =============================================================================
// Snapshot store limits
// =============================================================================

/** Directory name of the snapshot store under the service-owned data root. */
export const SKILL_SNAPSHOT_DIRNAME = 'skill-snapshots' as const;

/** Snapshot directory mode: service-owned, not group/world readable. */
export const SKILL_SNAPSHOT_DIR_MODE = 0o700;

/** Snapshot file mode: read-only for the owning service account. */
export const SKILL_SNAPSHOT_FILE_MODE = 0o400;

/** Lifetime of an unreferenced snapshot before sweeping, in milliseconds. */
export const SKILL_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** Total bytes the snapshot store may hold (256 MiB). */
export const SKILL_SNAPSHOT_TOTAL_QUOTA_BYTES = 256 * 1024 * 1024;

/** Maximum number of concurrently retained snapshots. */
export const SKILL_SNAPSHOT_MAX_COUNT = 64;

/** Random bytes behind an opaque snapshot ID. */
export const SKILL_SNAPSHOT_ID_BYTES = 16;

/** Opaque snapshot ID grammar: lowercase hex of {@link SKILL_SNAPSHOT_ID_BYTES}. */
export const SKILL_SNAPSHOT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * How often the background sweeper reclaims expired plans and snapshots.
 *
 * Short relative to both TTLs so an abandoned plan releases its snapshot within
 * a minute of expiring, rather than waiting for the next plan to be created.
 */
export const SKILL_PLAN_SWEEP_INTERVAL_MS = 60 * 1000;

// =============================================================================
// URL construction
// =============================================================================

/**
 * Build the Catalog URL for an immutable commit.
 *
 * Takes a resolved 40-hex commit rather than a branch so the Catalog a user
 * reviewed is the Catalog that gets installed. Callers never supply a URL.
 *
 * @throws Error when the commit is not a resolved 40-hex SHA
 */
export function buildSkillCatalogUrl(commit: string): string {
  if (!GIT_COMMIT_SHA_PATTERN.test(commit)) {
    throw new Error('Skill catalog URL requires a resolved 40-hex commit SHA');
  }
  return `https://raw.githubusercontent.com/${SKILL_OFFICIAL_REPOSITORY}/${commit}/${SKILL_CATALOG_FILENAME}`;
}
