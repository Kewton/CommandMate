/**
 * Official Skill Catalog endpoint and fetch policy (Issue #1231)
 *
 * The Catalog source is a compile-time constant, never an environment variable
 * and never anything derived from a request. Fetch limits live here so a policy
 * change is a one-line change rather than a code change in the client.
 *
 * @module config/skill-catalog-config
 */

/** Source repository that publishes the official Catalog. */
export const SKILL_CATALOG_REPOSITORY = 'Kewton/commandmate-skills' as const;

/** Branch the published Catalog is read from. */
export const SKILL_CATALOG_REF = 'main' as const;

/**
 * [SEC] SSRF prevention: the Catalog URL is a hardcoded constant.
 *
 * It MUST NOT be derived from environment variables, config files, request
 * query parameters or Catalog content. Changing it requires security review.
 * OWASP A10:2021 - Server-Side Request Forgery.
 */
export const SKILL_CATALOG_URL =
  'https://raw.githubusercontent.com/Kewton/commandmate-skills/main/catalog/v1/catalog.json' as const;

/** Every URL the Catalog client is allowed to request. */
export const SKILL_CATALOG_URL_ALLOWLIST: readonly string[] = [SKILL_CATALOG_URL];

/**
 * Allow-list check applied immediately before every request.
 *
 * Exact string equality, not a prefix or origin test: a prefix rule would admit
 * `https://raw.githubusercontent.com.evil.example/...` style look-alikes.
 */
export function isAllowedSkillCatalogUrl(url: string): boolean {
  return SKILL_CATALOG_URL_ALLOWLIST.includes(url);
}

/** Request timeout in milliseconds. */
export const SKILL_CATALOG_FETCH_TIMEOUT_MS = 5000;

/** How long a validated Catalog is served without revalidation. */
export const SKILL_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Hard cap on the Catalog response body in bytes.
 *
 * Enforced against the declared Content-Length *and* against the bytes actually
 * read, so a response that lies about or omits its length cannot exhaust memory.
 */
export const SKILL_CATALOG_MAX_BYTES = 1024 * 1024;

/** Back-off applied after the origin reports a rate limit without a reset hint. */
export const SKILL_CATALOG_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/** Longest back-off honoured from an origin-supplied reset hint (24h). */
export const SKILL_CATALOG_RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;

/** Accept header sent with the conditional GET. */
export const SKILL_CATALOG_ACCEPT = 'application/json';

/** Characters allowed in a cache revision token echoed back to clients. */
export const SKILL_CATALOG_REVISION_PATTERN = /^[A-Za-z0-9/+=_."-]{1,128}$/;

/** Build the User-Agent identifying this CommandMate build to the origin. */
export function buildSkillCatalogUserAgent(version: string): string {
  return `CommandMate/${version}`;
}
