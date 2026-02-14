# Issue #264 Security Review (Stage 4)

**Issue**: #264 - User Feedback Link & CLI Issue/Docs Commands
**Review Type**: Security (OWASP Top 10 Compliance)
**Stage**: 4 (Security Review)
**Date**: 2026-02-14
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #264 introduces feedback links in the UI, a `commandmate issue` CLI command for GitHub Issues management via `gh` CLI, and a `commandmate docs` CLI command for local documentation access. The security design is well-considered overall, with explicit attention to SSRF prevention (SEC-001), command injection prevention via `execFile`/`spawnSync` array arguments, path traversal prevention via whitelist patterns, and XSS prevention via `rel="noopener noreferrer"` on all external links.

One must-fix item was identified: the absence of input length validation for `--title` and `--body` parameters in the `issue create` command, which could lead to denial-of-service scenarios. Three should-fix items and three consider items address secondary concerns around input sanitization, documentation security, and logging.

---

## OWASP Top 10 Compliance Checklist

### A01:2021 - Broken Access Control

**Status**: PASS

| Check Item | Result | Evidence |
|-----------|--------|----------|
| Path traversal prevention | Pass | `SECTION_MAP` whitelist in `docs-reader.ts` (Section 3-5) |
| Symlink resolution | N/A | Docs command uses whitelist; no user-supplied paths reach filesystem |
| Existing precedent | Verified | `resolveSecurePath()` in `src/cli/utils/env-setup.ts` (line 116-125) |

The design correctly employs a whitelist pattern (`SECTION_MAP`) for the `--section` parameter, mapping only predefined section names to file paths. The `isValidSection()` function rejects any input not present in the whitelist, effectively preventing path traversal attacks such as `--section "../../etc/passwd"`.

### A02:2021 - Cryptographic Failures

**Status**: PASS

No sensitive data (credentials, tokens, encryption keys) is transmitted or stored by the new functionality. All URLs in `github-links.ts` are public GitHub URLs. The `gh` CLI manages its own authentication tokens independently.

### A03:2021 - Injection

**Status**: CONDITIONAL PASS (SEC-MF-001)

| Check Item | Result | Evidence |
|-----------|--------|----------|
| Shell injection prevention | Pass | Design mandates `execFile`/`spawnSync` with array args; `shell: true` prohibited (Section 6-1) |
| Existing pattern compliance | Verified | `preflight.ts` line 25: `spawnSync(dep.command, [dep.versionArg], {...})` |
| No `shell: true` in codebase | Verified | Grep for `shell:\s*true` in `src/` returned 0 matches |
| User input length validation | **Missing** | `--title` and `--body` have no max length defined |

The command injection prevention strategy is sound. By using `execFile`/`spawnSync` with array arguments, user-supplied values for `--title`, `--body`, and `--labels` are passed as distinct process arguments without shell interpretation, preventing injection attacks.

However, the design does not specify maximum length limits for `--title` and `--body` parameters. Extremely long inputs could cause process memory issues or overwhelm the `gh` CLI subprocess. This is the primary must-fix item (SEC-MF-001).

### A04:2021 - Insecure Design

**Status**: PASS

The architecture follows established secure patterns:
- Delegation to `gh` CLI for GitHub API interaction avoids implementing custom OAuth/token management
- Static URL constants avoid dynamic URL construction from user input
- `FeedbackSection` renders only hardcoded links, no user-generated content

### A05:2021 - Security Misconfiguration

**Status**: PASS

| Check Item | Result | Evidence |
|-----------|--------|----------|
| SSRF prevention (API URL) | Pass | `GITHUB_API_URL` hardcoded in `version-checker.ts` (SEC-001) |
| SSRF prevention (Base URL) | Pass | `GITHUB_REPO_BASE_URL` hardcoded constant in `github-links.ts` |
| Environment variable URL rejection | Implicit | Design explicitly rejects env-var URL management (Section 8-2, Alternative 1) |
| `gh` CLI as optional dependency | Pass | `required: false` prevents blocking existing features |

### A06:2021 - Vulnerable and Outdated Components

**Status**: PASS

No new npm dependencies are introduced. The `gh` CLI is an external system dependency, not bundled. The design correctly treats it as an optional dependency (`required: false`).

### A07:2021 - Identification and Authentication Failures

**Status**: PASS

| Check Item | Result | Evidence |
|-----------|--------|----------|
| External link tabnabbing prevention | Pass | `rel="noopener noreferrer"` on all `target="_blank"` links (Section 4-1) |
| Existing pattern compliance | Verified | All 5 existing `target="_blank"` instances in `src/` have proper `rel` attributes |
| Authentication delegation | Pass | `gh` CLI handles GitHub authentication transparently |

### A08:2021 - Software and Data Integrity Failures

**Status**: PASS

All URLs are derived from compile-time constants (`as const` assertions). No dynamic URL construction from user input or external sources. Template URLs use hardcoded query parameters (`?template=bug_report.md`).

### A09:2021 - Security Logging and Monitoring Failures

**Status**: PASS (with consideration SEC-C-003)

The existing codebase has a `logSecurityEvent()` utility used by `init`, `start`, and `stop` commands. The `issue` command is categorized as an "information display" command using `console.log` (SF-CONS-005 pattern). While this is internally consistent, the `issue create` subcommand performs a write operation to an external service, which could benefit from security event logging.

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: PASS

| Check Item | Result | Evidence |
|-----------|--------|----------|
| GitHub API URL hardcoded | Pass | `version-checker.ts` line 27: `GITHUB_API_URL` as const |
| API URL excluded from URL centralization | Pass | Design Section 3-1 SEC-001: API endpoint separately managed |
| No user-supplied URLs in fetch calls | Pass | No new HTTP requests introduced |
| URL validation for API responses | Existing | `validateReleaseUrl()` prefix checking in `version-checker.ts` |

---

## Risk Assessment

| Risk Category | Content | Impact | Probability | Priority |
|--------------|---------|--------|-------------|----------|
| Command Injection | `execFile` array args prevent shell injection | Low | Low | - |
| DoS via Input Length | `--title`/`--body` lack max length limits | Medium | Low | P2 (SEC-MF-001) |
| Path Traversal | `SECTION_MAP` whitelist prevents traversal | Low | Low | - |
| SSRF | All URLs are hardcoded constants | Low | Low | - |
| XSS (Tabnabbing) | `rel="noopener noreferrer"` on all external links | Low | Low | - |
| Information Disclosure | docs/ included in npm package | Low | Low | P3 (SEC-C-002) |

**Overall Risk Assessment**:

| Category | Level |
|---------|-------|
| Technical Risk | Low |
| Security Risk | Low |
| Operational Risk | Low |

---

## Detailed Findings

### Must Fix (1 item)

#### SEC-MF-001: Input Length Validation for --title/--body Parameters

**OWASP**: A03:2021 - Injection
**Risk**: Medium
**File**: Design policy Section 5-1 (issue command)

The design specifies that `--title` and `--body` options are passed as array arguments to `gh` CLI via `execFile`/`spawnSync`, which correctly prevents shell injection. However, no maximum length constraint is defined for these parameters.

While `gh` CLI itself may impose limits, relying on external tool behavior for input validation is not a defense-in-depth approach. An extremely long `--body` parameter (e.g., millions of characters) could:
1. Cause memory pressure when constructing the argument array
2. Exceed OS-level argument length limits (`ARG_MAX`), causing silent failure
3. Overwhelm process spawning

**Recommendation**: Add length validation in `issue.ts` before invoking `gh` CLI:

```typescript
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 65536;

if (options.title && options.title.length > MAX_TITLE_LENGTH) {
  console.error(`Title too long (max ${MAX_TITLE_LENGTH} characters)`);
  process.exit(ExitCode.UNEXPECTED_ERROR);
}
if (options.body && options.body.length > MAX_BODY_LENGTH) {
  console.error(`Body too long (max ${MAX_BODY_LENGTH} characters)`);
  process.exit(ExitCode.UNEXPECTED_ERROR);
}
```

This follows the existing `MAX_BRANCH_NAME_LENGTH` pattern in `src/cli/utils/input-validators.ts` (line 28).

### Should Fix (3 items)

#### SEC-SF-001: Labels Input Sanitization

**OWASP**: A03:2021 - Injection
**Risk**: Low

The `--labels` option accepts a comma-separated string. While passed safely via array arguments to `gh` CLI, the design does not specify sanitization of individual label values (e.g., removing control characters, zero-width characters).

**Recommendation**: Apply `sanitizeInput()` from `env-setup.ts` (line 167-169) to each label value after splitting by comma. Add this requirement to the implementation checklist.

#### SEC-SF-002: Search Query Length Limit in searchDocs()

**OWASP**: A01:2021 - Broken Access Control
**Risk**: Low

The `searchDocs()` function uses `String.prototype.includes()` for text matching, which is safe from ReDoS. However, no maximum length limit is defined for the `query` parameter. An extremely long query could cause performance degradation during substring matching across all documentation files.

**Recommendation**: Add a maximum query length (e.g., 256 characters) in `docs-reader.ts`:

```typescript
const MAX_SEARCH_QUERY_LENGTH = 256;

export function searchDocs(query: string): Array<{ section: string; matches: string[] }> {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query too long (max ${MAX_SEARCH_QUERY_LENGTH} characters)`);
  }
  // ... existing logic
}
```

#### SEC-SF-003: Explicit Documentation of Static URL Construction

**OWASP**: A05:2021 - Security Misconfiguration
**Risk**: Low

The `FeedbackSection` component uses only hardcoded constants from `github-links.ts` for link URLs. This is secure by design. However, the design policy does not explicitly state that user input must never be interpolated into these URLs, which could lead to future regressions.

**Recommendation**: Add the following note to Section 4-1 of the design policy:

> FeedbackSection link URLs are exclusively sourced from `github-links.ts` compile-time constants. Dynamic URL construction incorporating user input is prohibited in this component.

### Consider (3 items)

#### SEC-C-001: gh auth status Pre-check

The design delegates GitHub authentication entirely to `gh` CLI. Consider adding a `gh auth status` pre-check before `issue create` operations to provide a user-friendly error message ("Please run `gh auth login` first") rather than relying on `gh`'s raw error output.

#### SEC-C-002: Documentation Content Security Review

Since `docs/` will be included in the npm package via `package.json` `files` field, consider adding a step to the implementation checklist verifying that documentation files do not contain internal IP addresses, development credentials, or other sensitive information.

#### SEC-C-003: Security Event Logging for issue create

The `issue create` subcommand performs write operations to an external service (GitHub Issues). Consider adding `logSecurityEvent()` calls for the create action, consistent with how `init`/`start`/`stop` log their operations. This is lower priority because the `issue` command follows the "information display" console.log pattern (SF-CONS-005).

---

## Cross-Reference with Existing Security Patterns

The design policy correctly references and extends existing security patterns:

| Pattern | Existing Usage | Issue #264 Application | Consistent |
|---------|---------------|----------------------|------------|
| `execFile` array args | `git-utils.ts`, `worktree-detector.ts`, `preflight.ts` | `issue.ts` gh CLI invocation | Yes |
| `shell: true` prohibition | Zero instances in codebase | Explicitly prohibited in Section 6-1 | Yes |
| `rel="noopener noreferrer"` | `UpdateNotificationBanner.tsx`, `Header.tsx`, etc. | `FeedbackSection.tsx` | Yes |
| URL hardcoding (SSRF) | `version-checker.ts` `GITHUB_API_URL` | `github-links.ts` constants | Yes |
| Whitelist validation | `input-validators.ts` `BRANCH_NAME_PATTERN` | `SECTION_MAP` for docs sections | Yes |
| `sanitizeInput()` | `env-setup.ts` line 167 | Not yet applied to issue labels | Recommendation added |
| `logSecurityEvent()` | `init.ts`, `start.ts`, `stop.ts` | Not applied to issue command | Consideration added |

---

## Approval

**Status**: Conditionally Approved (Score: 4/5)

The design demonstrates strong security awareness with proper OWASP Top 10 coverage. The architecture correctly avoids common vulnerabilities through hardcoded URLs, whitelist validation, array-based process argument passing, and proper external link attributes.

**Condition for full approval**: Address SEC-MF-001 (input length validation for `--title`/`--body` parameters) in the design policy and implementation checklist.

**Reviewer note**: The overall security posture is solid. The use of `gh` CLI delegation avoids the complexity of direct GitHub API token management, and the whitelist approach for documentation sections provides defense-in-depth against path traversal. The must-fix item is a standard input validation concern that is straightforward to address.

---

*Generated by architecture-review-agent (Stage 4: Security Review) at 2026-02-14*
