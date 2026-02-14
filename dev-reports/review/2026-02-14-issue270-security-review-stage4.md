# Security Architecture Review - Issue #270

**Issue**: #270 - update-check route static prerendering fix
**Stage**: 4 (Security Review)
**Date**: 2026-02-14
**Status**: Approved
**Score**: 5/5

---

## 1. Executive Summary

Issue #270 proposes a minimal change: adding `export const dynamic = 'force-dynamic'` to the `/api/app/update-check/route.ts` file to prevent Next.js from statically prerendering the route at build time. This is a one-line configuration change that does not alter any security-sensitive logic, data flow, or authentication mechanism.

The existing security controls implemented in Issue #257 are comprehensive and remain fully intact. The change aligns with five prior project precedents and introduces no new attack surface.

**Verdict**: The design policy is security-sound. No must-fix items identified. Two low-severity should-fix items and two consideration items are noted for defense-in-depth improvement.

---

## 2. OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

| Item | Status | Details |
|------|--------|---------|
| Authentication required | N/A | Public endpoint by design (version check) |
| Authorization checks | N/A | No user-specific data exposed |
| Method restriction | Pass | Only GET is exported; Next.js returns 405 for other methods |

**Assessment**: Pass. The endpoint intentionally serves public information (latest version availability).

### A02:2021 - Cryptographic Failures

| Item | Status | Details |
|------|--------|---------|
| Sensitive data in transit | Pass | GitHub API fetched over HTTPS |
| Sensitive data in response | Pass | No secrets, tokens, or PII in response |
| Data classification | Pass | Version info is public data |

**Assessment**: Pass. No cryptographic concerns apply to this feature.

### A03:2021 - Injection

| Item | Status | Details |
|------|--------|---------|
| URL validation | Pass | `validateReleaseUrl()` checks `GITHUB_RELEASE_URL_PREFIX` (SEC-SF-001) |
| Release name sanitization | Pass | `sanitizeReleaseName()` allows only `[a-zA-Z0-9.\-\s_v]` up to 128 chars (SEC-SF-001) |
| Semver validation | Pass | `SEMVER_PATTERN` validates tag_name format (SF-003) |
| updateCommand | Pass | Fixed string only: `'npm install -g commandmate@latest'` (SEC-SF-004) |
| publishedAt | Note | Passes through without format validation (SEC-S4-001) |
| latestVersion | Note | Derived from tag_name.replace() without explicit re-validation (SEC-S4-002) |

**Assessment**: Pass with notes. Core fields are validated. Two low-severity items noted for defense-in-depth.

### A04:2021 - Insecure Design

| Item | Status | Details |
|------|--------|---------|
| Threat modeling | Pass | Design policy explicitly addresses security in Section 5 |
| Graceful degradation | Pass | Always returns HTTP 200 with `status: 'degraded'` on failure |
| Rate limiting | Pass | 1-hour globalThis cache + GitHub rate limit header respect |

**Assessment**: Pass. The "always 200" pattern is appropriate for a non-critical informational endpoint.

### A05:2021 - Security Misconfiguration

| Item | Status | Details |
|------|--------|---------|
| Cache-Control headers | Pass | `no-store, no-cache, must-revalidate` (SEC-SF-003) |
| Pragma header | Pass | `no-cache` for legacy proxy support |
| Dynamic route config | Pass | `force-dynamic` prevents build-time caching (the core fix) |
| Error information leakage | Pass | Errors are caught silently; no stack traces exposed |

**Assessment**: Pass. The `force-dynamic` addition directly fixes the security misconfiguration where stale version data could persist from build time.

### A06:2021 - Vulnerable and Outdated Components

| Item | Status | Details |
|------|--------|---------|
| New dependencies | Pass | No new dependencies introduced |
| Existing dependencies | Pass | Uses Next.js built-in `NextResponse` and standard `fetch` API |

**Assessment**: Pass. Zero dependency footprint change.

### A07:2021 - Identification and Authentication Failures

**Assessment**: Not applicable. Public endpoint with no authentication requirement.

### A08:2021 - Software and Data Integrity Failures

| Item | Status | Details |
|------|--------|---------|
| API URL integrity | Pass | `GITHUB_API_URL` is a hardcoded `as const` string (SEC-001) |
| Response validation | Pass | URL prefix, name pattern, and semver all validated |
| CI/CD changes | N/A | No pipeline changes in this issue |

**Assessment**: Pass. The hardcoded URL constant prevents SSRF and supply chain attacks.

### A09:2021 - Security Logging and Monitoring Failures

| Item | Status | Details |
|------|--------|---------|
| Error logging | Pass | Silent failure is intentional for non-critical feature |
| Monitoring support | Pass | `status: 'success' | 'degraded'` field enables monitoring (SF-004) |
| Information leakage in errors | Pass | No internal details exposed in error responses |

**Assessment**: Pass. The monitoring design via status field is appropriate.

### A10:2021 - Server-Side Request Forgery (SSRF)

| Item | Status | Details |
|------|--------|---------|
| External URL origin | Pass | `GITHUB_API_URL` hardcoded as constant (SEC-001) |
| User input in URL | Pass | No user input influences the fetch target |
| Environment variable in URL | Pass | URL is NOT derived from env vars |
| DNS rebinding | Pass | URL is a well-known GitHub API endpoint |

**Assessment**: Pass. This is the strongest security control in the design. The hardcoded constant with explicit security comment is exemplary.

---

## 3. Input Validation Analysis

### Server-side (version-checker.ts)

| Input Field | Source | Validation | Status |
|-------------|--------|------------|--------|
| `tag_name` | GitHub API | `SEMVER_PATTERN` regex | Validated |
| `html_url` | GitHub API | `validateReleaseUrl()` prefix check | Validated |
| `name` | GitHub API | `sanitizeReleaseName()` allowlist regex + length | Validated |
| `published_at` | GitHub API | None | Not validated |

### Client-side (UpdateNotificationBanner.tsx)

| Field | Rendering | XSS Risk |
|-------|-----------|----------|
| `latestVersion` | React text node via `{t('update.latestVersion', { version: latestVersion })}` | None (React auto-escapes) |
| `releaseUrl` | `href` attribute on `<a>` tag | Low (validated server-side via `validateReleaseUrl`) |
| `updateCommand` | React text node in `<code>` | None (fixed string SEC-SF-004) |

---

## 4. Data Protection Analysis

| Data Category | Protection | Status |
|---------------|-----------|--------|
| Version information | Public data, no protection needed | Pass |
| Install type | Derived locally, not from user input | Pass |
| Update command | Fixed string, no dynamic data | Pass |
| GitHub API token | Not used (unauthenticated requests) | Pass |

No sensitive data flows through this endpoint.

---

## 5. Security Headers Analysis

```
Cache-Control: no-store, no-cache, must-revalidate
Pragma: no-cache
```

These headers are applied via the `NO_CACHE_HEADERS` constant (DRY) and the `buildResponse()` helper function, ensuring consistent application across both success and error paths.

The `force-dynamic` route configuration ensures that Next.js does not cache the handler output at the framework level, complementing the HTTP-level cache headers.

---

## 6. Error Handling Analysis

| Error Scenario | Handling | Information Leakage |
|----------------|----------|---------------------|
| `checkForUpdate()` throws | Caught, returns degraded response | No |
| `isGlobalInstall()` throws | Caught, returns `'unknown'` install type | No |
| Network timeout (5s) | `AbortSignal.timeout`, caught | No |
| GitHub API 403 (rate limit) | Rate limit timestamp cached, returns cached result | No |
| GitHub API 5xx | Returns cached result (or null) | No |
| JSON parse error | Caught by outer try/catch | No |

All error paths return HTTP 200 with `status: 'degraded'`, never exposing stack traces, file paths, or internal state.

---

## 7. Risk Assessment

| Risk Category | Level | Rationale |
|---------------|-------|-----------|
| Technical Risk | Low | One-line configuration addition with five project precedents |
| Security Risk | Low | No security logic changed; all existing controls preserved |
| Operational Risk | Low | Route will execute at runtime instead of serving stale build output |

---

## 8. Improvement Recommendations

### Should Fix (Low Severity)

#### SEC-S4-001: Add publishedAt format validation

**File**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-270/src/lib/version-checker.ts` (line 214)

The `published_at` field from the GitHub API is passed directly to the response without format validation. While React auto-escapes text content, a malformed string could cause unexpected behavior if used in date parsing on the client side.

**Recommendation**: Add an ISO 8601 date format validation, similar to how other fields are validated:

```typescript
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function validatePublishedAt(dateStr: string): string | null {
  return ISO_DATE_PATTERN.test(dateStr) ? dateStr : null;
}
```

#### SEC-S4-002: Add explicit latestVersion validation

**File**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-270/src/lib/version-checker.ts` (line 205)

The `latestVersion` is derived from `data.tag_name.replace(/^v/, '')` and stored in the result without re-validation. If the GitHub API returns an unexpected `tag_name` format that bypasses `isNewerVersion()` validation (which only runs for the comparison, not for the stored value), the raw string flows to the client.

**Recommendation**: Validate the stripped version against `SEMVER_PATTERN` before inclusion:

```typescript
const latestVersion = data.tag_name.replace(/^v/, '');
if (!SEMVER_PATTERN.test(data.tag_name)) {
  return cache.result; // reject invalid version format
}
```

### Consider (Future Improvement)

#### SEC-S4-C01: Add X-Content-Type-Options header

While `NextResponse.json()` sets `Content-Type: application/json` automatically, adding `X-Content-Type-Options: nosniff` to the `NO_CACHE_HEADERS` constant would provide additional defense-in-depth against MIME sniffing attacks.

#### SEC-S4-C02: Add dynamic export verification test

The design policy (Section 6) mentions adding a test to verify the `dynamic` export value. Since this is the entire purpose of Issue #270, a regression test is highly recommended:

```typescript
it('should export dynamic as force-dynamic', async () => {
  const routeModule = await import('@/app/api/app/update-check/route');
  expect(routeModule.dynamic).toBe('force-dynamic');
});
```

---

## 9. Existing Security Controls Inventory

The following security controls from Issue #257 remain unchanged and fully operational:

| Control ID | Description | Location |
|------------|-------------|----------|
| SEC-001 | SSRF prevention via hardcoded GITHUB_API_URL | version-checker.ts:27 |
| SEC-SF-001 | Response validation (URL prefix + name sanitization) | version-checker.ts:142-163 |
| SEC-SF-002 | User-Agent header for GitHub API compliance | version-checker.ts:187 |
| SEC-SF-003 | Cache-Control no-store headers | route.ts:71-74 |
| SEC-SF-004 | Fixed updateCommand string | route.ts:126-128 |

---

## 10. Impact of force-dynamic on Security

Adding `export const dynamic = 'force-dynamic'` has the following security implications:

**Positive effects**:
- Ensures the route handler runs at every request, enabling real-time version checking
- Prevents stale build-time data from being served, which could lead users to believe they are on the latest version when they are not
- Aligns with the existing cache strategy (HTTP Cache-Control + globalThis TTL cache)

**No negative effects**:
- The globalThis cache (1-hour TTL) prevents DoS via excessive GitHub API calls
- The 5-second fetch timeout prevents request hanging
- Rate limit handling prevents GitHub API abuse

---

## 11. Test Coverage Assessment

| Security Control | Test Coverage | Test File |
|------------------|---------------|-----------|
| GITHUB_API_URL hardcoded | Verified | version-checker.test.ts |
| validateReleaseUrl | 6 test cases (valid, evil domain, javascript:, data:, different repo, empty) | version-checker.test.ts |
| sanitizeReleaseName | 8 test cases (valid, spaces, special chars, HTML, length, emoji, SQL) | version-checker.test.ts |
| Cache-Control headers | 3 test cases (success, degraded, error paths) | update-check.test.ts |
| updateCommand fixed string | 3 test cases (global, local, unknown) | update-check.test.ts |
| User-Agent header | 1 test case | version-checker.test.ts |
| Rate limit handling | 4 test cases | version-checker.test.ts |
| Timeout handling | 1 test case | version-checker.test.ts |
| JSON parse error | 1 test case | version-checker.test.ts |
| Error resilience (HTTP 200 always) | 4 test cases | update-check.test.ts |

**Coverage quality**: Excellent. Security controls are well-tested with both positive and negative test cases.

---

## 12. Conclusion

The Issue #270 design policy describes a minimal, safe, and well-justified change. The one-line addition of `export const dynamic = 'force-dynamic'` introduces no new security risks and actually fixes a security misconfiguration (stale build-time data). All existing security controls are preserved. The OWASP Top 10 checklist passes on all applicable items.

The two should-fix items (publishedAt validation and latestVersion validation) are pre-existing concerns from Issue #257, not introduced by Issue #270. They are noted here for completeness and defense-in-depth improvement.

**Final Status**: Approved
