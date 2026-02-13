# Issue #257: Security Review (Stage 4) - Version Update Notification

**Date**: 2026-02-13
**Issue**: #257 - Version Update Notification Feature
**Focus**: Security (OWASP Top 10 Compliance)
**Stage**: 4/4 (Final Stage)
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

This Stage 4 security review evaluates the design policy for Issue #257 (Version Update Notification Feature) against the OWASP Top 10:2021 framework. The design introduces a server-side GitHub Releases API check with client-side notification display.

**Overall Assessment**: The design demonstrates strong security awareness. Server-side-only external API calls avoid CSP modifications, the silent failure pattern prevents feature degradation from impacting core functionality, and the absence of new dependencies eliminates supply chain risk. One must-fix item (hardcoding the GitHub API URL to prevent SSRF) and four should-fix items were identified, none of which represent critical vulnerabilities.

**Risk Profile**: Low across all dimensions. The feature is read-only, display-only, and does not trigger automatic actions.

---

## OWASP Top 10:2021 Compliance Checklist

### [PASS] A01:2021 - Broken Access Control

The `/api/app/update-check` endpoint is read-only (GET) and returns non-sensitive public version information. No authentication is required, which is appropriate for a local development tool's version check. No user-specific data is exposed. Next.js App Router automatically rejects unsupported HTTP methods with 405.

### [PASS] A02:2021 - Cryptographic Failures

GitHub API communication uses HTTPS (enforced by `api.github.com`). No sensitive data is stored, transmitted, or processed by this feature. No cryptographic operations are introduced.

### [CONDITIONAL PASS] A03:2021 - Injection

**Positive aspects**:
- `isNewerVersion()` validates input against `/^v?\d+\.\d+\.\d+$/` (SF-003), preventing injection through version strings
- No SQL operations (no DB changes in this feature)
- No command execution (no `exec`/`spawn` calls)
- No user-supplied input reaches the API endpoint (parameter-less GET)

**Concern (SEC-SF-001)**: The GitHub API response fields `html_url` and `releaseName` are passed through to the client-side response without explicit validation. While `tag_name` is validated by the semver regex, `html_url` could theoretically contain a crafted URL if the API response were tampered with. The `releaseName` is rendered in the UI via `UpdateNotificationBanner`, and without sanitization, a tampered value could contain unexpected content.

**Recommendation**: Validate `html_url` against the expected prefix `https://github.com/Kewton/CommandMate/releases/` and apply character-set restrictions to `releaseName`.

### [PASS] A04:2021 - Insecure Design

The design follows several security-by-design principles:
- **Silent failure**: External API failures never degrade core application functionality
- **Server-side only**: GitHub API calls are made server-side, avoiding CSP issues and client-side token exposure
- **Information minimization**: Only necessary fields from the GitHub API response are forwarded to the client (Section 6-3)
- **No automatic actions**: Users must manually run the update command; no auto-download or auto-install

The `installType` and `updateCommand` fields represent minimal information disclosure (SEC-SF-004), acceptable for a local development tool.

### [CONDITIONAL PASS] A05:2021 - Security Misconfiguration

**Positive aspects**:
- CSP in `next.config.js` does not need modification (server-side fetch only) - correctly identified in Section 6-1
- Existing security headers (X-Frame-Options: DENY, X-Content-Type-Options: nosniff, X-XSS-Protection, Referrer-Policy, Permissions-Policy) apply to all routes including the new endpoint
- `connect-src 'self' ws: wss:` in CSP is sufficient; no `api.github.com` needed in connect-src since the fetch is server-side

**Concern (SEC-SF-003)**: The design does not specify HTTP response caching headers for the new endpoint. Without explicit `Cache-Control: no-store` headers, intermediate proxies could cache version responses, creating stale data issues. The server-side globalThis cache already manages caching; HTTP-level caching should be explicitly disabled.

### [PASS] A06:2021 - Vulnerable and Outdated Components

No new dependencies are introduced. The self-implemented semver comparison (15 lines with validation) eliminates supply chain risk that would come with importing a third-party package. Uses built-in Node.js `fetch` (Node 18+) which is maintained as part of the runtime.

### [CONDITIONAL PASS] A07:2021 - Identification and Authentication Failures

The GitHub API is called without authentication, which is appropriate for public repository release information. The unauthenticated rate limit of 60 requests/hour is mitigated by the 1-hour cache TTL.

**Concern (SEC-SF-002)**: The design does not include a `User-Agent` header in GitHub API requests. GitHub's API policy requires or strongly recommends this header. Its absence could result in request rejection and makes it harder for GitHub to identify the source of API calls.

### [PASS] A08:2021 - Software and Data Integrity Failures

Version information is display-only with no automatic installation. The user must manually run the update command after seeing the notification. TLS protects data integrity in transit. The design correctly avoids `require('package.json').version` in favor of the build-time-embedded `NEXT_PUBLIC_APP_VERSION`, preventing runtime file tampering risks.

### [CONDITIONAL PASS] A09:2021 - Security Logging and Monitoring Failures

The silent failure pattern (Section 3-2) is correct for UX but means that security-relevant events (repeated 403 rate limits, connection failures to GitHub) go unrecorded. The existing `withLogging()` pattern (CONS-C02) could be leveraged for debug-level logging without impacting user experience. This is not a vulnerability but limits observability.

### [CONDITIONAL PASS] A10:2021 - Server-Side Request Forgery (SSRF)

**Current design**: The server makes an outbound HTTP request to `api.github.com`. This is the primary SSRF-relevant concern.

**Positive aspects**:
- The target URL appears to be fixed (not user-controlled)
- No request parameters are accepted from the client
- The endpoint is GET-only with no body

**Concern (SEC-001)**: The design document references `GITHUB_API_URL` but does not explicitly declare it as a hardcoded constant. If this value were made configurable (e.g., via environment variable) in the future, it would create an SSRF vector. The design must explicitly enforce that the URL is a compile-time constant.

**Comparison with existing codebase**: The `external-apps/[id]/health/route.ts` endpoint (which makes outbound requests to `host:port` from DB records) is a comparable SSRF surface in the codebase. The Issue #257 design is actually safer because the target URL is not derived from any stored or user-provided data.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | Read-only feature, no DB changes, no new dependencies, proven caching pattern |
| Security | Low | Server-side only external call, input validation present, no authentication data, display-only output |
| Operational | Low | Silent failure prevents impact on core features, 1-hour cache prevents API abuse |

---

## Detailed Findings

### Must Fix (1 item)

#### SEC-001: GitHub API URL Must Be Hardcoded Constant [SSRF Prevention]

**OWASP**: A10:2021 - Server-Side Request Forgery
**Severity**: High (preventive measure)
**Location**: Section 3-2 (Silent Failure Pattern), `version-checker.ts` design

**Issue**: The design references `GITHUB_API_URL` in the code example (Section 3-2, line 188) but does not explicitly define it as a hardcoded, non-configurable constant. Without this explicit constraint, a future developer might make it configurable via environment variable or database, creating an SSRF attack vector.

**Recommendation**: Add the following to the `version-checker.ts` design specification:

```typescript
/**
 * GitHub Releases API URL - HARDCODED CONSTANT
 * SECURITY: This URL must NEVER be made configurable (env var, DB, etc.)
 * to prevent SSRF attacks. See SEC-001.
 */
const GITHUB_API_URL = 'https://api.github.com/repos/Kewton/CommandMate/releases/latest' as const;
```

Add this to the implementation checklist as a security requirement.

### Should Fix (4 items)

#### SEC-SF-001: Validate GitHub API Response Fields Before Client Exposure [Injection Prevention]

**OWASP**: A03:2021 - Injection
**Severity**: Medium
**Location**: Section 4 (Data Model), `version-checker.ts`

**Issue**: While `tag_name` is validated by the semver regex, `html_url` and `releaseName` from the GitHub API response are passed to the client without explicit validation. In a supply-chain or MITM scenario (however unlikely over TLS), these could contain crafted values.

**Recommendation**: Add validation in `version-checker.ts`:
- `html_url`: Verify it matches `https://github.com/Kewton/CommandMate/releases/tag/v` prefix
- `releaseName`: Limit to alphanumeric characters, dots, hyphens, and spaces (max 100 characters)
- `published_at`: Verify ISO 8601 format

Add to implementation checklist:
```
- [ ] **[SEC-SF-001]** Validate GitHub API response fields in version-checker.ts
  - [ ] html_url must match 'https://github.com/Kewton/CommandMate/releases/' prefix
  - [ ] releaseName limited to /^[a-zA-Z0-9.\-\s]{1,100}$/
  - [ ] published_at validated as ISO 8601 format
```

#### SEC-SF-002: Add User-Agent Header to GitHub API Requests [API Best Practice]

**OWASP**: A07:2021 - Identification and Authentication Failures
**Severity**: Low
**Location**: Section 3-2 (Silent Failure Pattern)

**Issue**: The GitHub API request only includes `Accept: application/vnd.github+json`. GitHub's API documentation requires a User-Agent header.

**Recommendation**: Update the fetch call in the design:
```typescript
const response = await fetch(GITHUB_API_URL, {
  headers: {
    'Accept': 'application/vnd.github+json',
    'User-Agent': `CommandMate/${getCurrentVersion()}`,
  },
  signal: AbortSignal.timeout(5000),
});
```

#### SEC-SF-003: Add Cache-Control Response Headers [Security Misconfiguration Prevention]

**OWASP**: A05:2021 - Security Misconfiguration
**Severity**: Low
**Location**: Section 5 (API Design), `route.ts`

**Issue**: No HTTP caching headers are specified for the API response. While server-side caching via globalThis is well-designed, intermediate proxies could cache responses at the HTTP level.

**Recommendation**: Add to the API route response:
```typescript
return NextResponse.json(response, {
  status: 200,
  headers: {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  },
});
```

#### SEC-SF-004: Document updateCommand Field as Fixed String [Information Disclosure Prevention]

**OWASP**: A04:2021 - Insecure Design
**Severity**: Low
**Location**: Section 4 (Data Model), `toUpdateCheckResponse()`

**Issue**: The `updateCommand` field currently uses a fixed string, which is correct. However, the design does not explicitly constrain this to prevent future developers from including dynamic path information.

**Recommendation**: Add a JSDoc comment to the `updateCommand` field in the type definition:
```typescript
/**
 * Update command for the user. SECURITY: Must be a fixed string constant.
 * Never include dynamic paths or user-specific information.
 */
updateCommand: string | null;
```

### Consider (3 items)

#### SEC-C-001: GitHub API Response Integrity [Software and Data Integrity]

The design trusts GitHub API responses protected only by TLS. For a local development tool, this is acceptable. If CommandMate were ever deployed in a more sensitive context, consider response integrity verification.

**Action**: No action needed for current scope. Document as a known trust boundary.

#### SEC-C-002: Debug-Level Logging for Failed Version Checks [Security Monitoring]

Silent failure is correct for UX but creates a monitoring blind spot. Repeated failures could indicate DNS poisoning, network compromise, or API abuse by another local process.

**Action**: Consider applying the `withLogging()` pattern (CONS-C02) at debug level. This aligns with the existing consideration item and does not change the current implementation priority.

#### SEC-C-003: HTTP Method Restriction Test [Defense in Depth]

Next.js App Router handles method restrictions automatically. Adding explicit test coverage provides defense in depth.

**Action**: Add to test cases:
```typescript
it('should return 405 for non-GET methods', async () => {
  // Verify POST, PUT, DELETE return 405
});
```

---

## Security-Specific Design Strengths

The following aspects of the design are particularly well-considered from a security perspective:

1. **Server-side-only external calls**: By routing GitHub API calls through the server, the design avoids modifying CSP `connect-src` and prevents exposure of any future authentication tokens to the client.

2. **No new dependencies**: Self-implementing semver comparison eliminates supply chain attack surface. The 15-line implementation with built-in validation (SF-003) is more secure than importing a third-party package.

3. **Silent failure pattern**: Prevents the version check feature from becoming an attack vector against core application functionality. Even if the GitHub API is completely unreachable, the application degrades gracefully.

4. **Input validation built into core function**: The `isNewerVersion()` function validates input at the comparison boundary (SF-003), not relying on callers to validate. This is the correct defensive programming approach.

5. **Information minimization**: Section 6-3 explicitly states that GitHub API response fields are not fully forwarded to the client. Only necessary fields are included in `UpdateCheckResponse`.

6. **No automatic installation**: The feature is display-only. Users must take manual action to update, preventing auto-execution of potentially compromised update packages.

---

## Comparison with Existing Security Patterns

| Pattern | Existing Example | Issue #257 Application |
|---------|-----------------|----------------------|
| Path traversal prevention | `install-context.ts:70-74` (realpathSync + startsWith check) | Not applicable (no file paths from user input) |
| XSS prevention | `sanitize.ts` (DOMPurify), `escapeHtml` in utils.ts | External link uses `rel="noopener noreferrer"` (Section 9). GitHub response fields need validation (SEC-SF-001) |
| Input validation | `auto-yes-manager.ts:119` (worktree ID format validation) | `isNewerVersion()` regex validation (SF-003) |
| SSRF surface | `external-apps/[id]/health/route.ts` (outbound fetch to DB-stored host:port) | Hardcoded GitHub API URL (SEC-001). Safer than existing pattern. |
| globalThis security | `auto-yes-manager.ts:99-112` (in-memory state) | Same pattern for cache. No sensitive data in cache. |

---

## Implementation Checklist Additions (Security)

The following items should be added to Section 15 of the design policy document:

```
### Security Review対応

- [ ] **[SEC-001]** GitHub API URLをハードコード定数として定義
  - [ ] `const GITHUB_API_URL = 'https://api.github.com/repos/Kewton/CommandMate/releases/latest' as const;`
  - [ ] SSRF防止のため、環境変数やDB設定からの取得を禁止するコメントを追加
  - [ ] 実装時にURLが外部入力に依存しないことを確認

- [ ] **[SEC-SF-001]** GitHub APIレスポンスフィールドのバリデーション
  - [ ] `html_url`: `https://github.com/Kewton/CommandMate/releases/` プレフィックスの検証
  - [ ] `releaseName`: 文字セット制限（英数字、ドット、ハイフン、スペース、最大100文字）
  - [ ] `published_at`: ISO 8601形式の検証

- [ ] **[SEC-SF-002]** GitHub APIリクエストにUser-Agentヘッダを追加
  - [ ] `'User-Agent': 'CommandMate/<version>'` ヘッダを追加

- [ ] **[SEC-SF-003]** APIレスポンスにCache-Controlヘッダを追加
  - [ ] `Cache-Control: no-store, no-cache, must-revalidate`
  - [ ] `Pragma: no-cache`

- [ ] **[SEC-SF-004]** updateCommandフィールドの固定文字列制約をJSDocに記録
```

---

## Approval

**Status**: Conditionally Approved (4/5)

**Conditions for full approval**:
1. Address SEC-001 (hardcoded GitHub API URL constant with SSRF prevention comment)
2. Address SEC-SF-001 through SEC-SF-004 during implementation

**Rationale for conditional approval**: The design demonstrates a strong security posture with server-side-only external calls, no new dependencies, silent failure, and built-in input validation. The must-fix item (SEC-001) is a preventive measure rather than an existing vulnerability -- it ensures the design explicitly prevents a class of future regression. The should-fix items are defense-in-depth measures appropriate for production code quality.

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Reviewer focus: OWASP Top 10:2021 compliance*
*Date: 2026-02-13*
