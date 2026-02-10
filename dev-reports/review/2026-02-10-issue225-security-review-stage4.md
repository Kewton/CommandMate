# Architecture Review: Issue #225 - Security Review (Stage 4)

**Issue**: #225 Auto-Yes Duration Selection Feature
**Focus**: Security (OWASP Top 10 Compliance)
**Date**: 2026-02-10
**Status**: Conditionally Approved (4/5)
**Risk Level**: Technical=Low, Security=Low, Operational=Low

---

## Executive Summary

Issue #225 introduces duration selection (1 hour / 3 hours / 8 hours) to the Auto-Yes mode, replacing the current hardcoded 1-hour timeout. This security review evaluates the design policy document (Section 7 and related sections) and the existing codebase against OWASP Top 10 2021 criteria.

**Overall assessment**: The design demonstrates strong security awareness with a whitelist-based validation approach, type-safe callback chains (AutoYesDuration literal union), and a safe default value (1 hour). The design policy Section 7 covers the primary security concerns adequately. However, there are two must-fix items related to input validation defense-in-depth and minor gaps in the security documentation.

The implementation is pre-code (not yet started), so this review focuses on the design policy completeness and the existing codebase patterns that the implementation will extend.

---

## OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

**Status**: PASS

- Auto-Yes API performs worktree existence validation via `validateWorktreeExists()`
- Application is local-only, so authentication is out of scope
- The `params.id` from Next.js dynamic routing flows through DB lookup, which acts as an indirect authorization check
- No horizontal privilege escalation is possible (worktree IDs are not user-scoped)

### A02:2021 - Cryptographic Failures

**Status**: NOT APPLICABLE

- No cryptographic operations involved in this change
- Duration values are plain integers with no sensitivity

### A03:2021 - Injection

**Status**: CONDITIONAL PASS (2 findings)

**Positive aspects**:
- Whitelist validation for duration (`ALLOWED_DURATIONS.includes()`) is the strongest pattern for fixed-option inputs
- `AutoYesDuration` literal union type provides compile-time safety on the client side
- `isValidCliTool()` whitelist check exists for cliToolId
- `isValidWorktreeId()` exists in auto-yes-manager.ts with pattern: `/^[a-zA-Z0-9_-]+$/`
- React JSX default escaping prevents XSS from `cliToolName`, `notification`, and `DURATION_LABELS` values

**Findings**:

1. **[SEC-MF-001] worktreeId format validation not applied at route.ts level**

   The `validateWorktreeExists()` function in `route.ts` (L46-56) only performs a database lookup. It does not call `isValidWorktreeId()` for format validation before the DB query. While `startAutoYesPolling()` in `auto-yes-manager.ts` (L441) does validate the worktreeId format, `setAutoYesEnabled()` (L181) does not perform this check. This means a crafted worktreeId could reach `autoYesStates.set()` as a Map key without format validation, even if the worktree does not exist in DB (the DB check would return 404 first, but defense-in-depth requires format validation as the first layer).

   Current code flow in POST handler:
   ```
   params.id -> validateWorktreeExists() [DB check only]
             -> setAutoYesEnabled() [no format check]
             -> startAutoYesPolling() [has isValidWorktreeId() check]
   ```

   Recommended flow:
   ```
   params.id -> isValidWorktreeId() [format check - 400 if invalid]
             -> validateWorktreeExists() [DB check - 404 if not found]
             -> setAutoYesEnabled()
             -> startAutoYesPolling()
   ```

2. **[SEC-SF-002] duration typeof check missing from design**

   The design specifies `ALLOWED_DURATIONS.includes(body.duration)` as the sole validation. While `Array.includes()` uses strict equality (===) and would reject string "3600000", an explicit `typeof body.duration !== 'number'` check provides defense-in-depth against unexpected type coercion in intermediate processing.

### A04:2021 - Insecure Design

**Status**: PASS

- Whitelist pattern (fixed options) is inherently more secure than blacklist or range validation
- Maximum duration capped at 8 hours (no "unlimited" option) -- YAGNI principle also serves security
- Confirmation dialog provides informed consent before enabling Auto-Yes
- Default value (1 hour) is the minimum option, following secure-by-default principle
- `Record<AutoYesDuration, string>` type forces compile-time sync between options and labels

### A05:2021 - Security Misconfiguration

**Status**: PASS

- Default duration is 1 hour (most restrictive option)
- Error messages expose whitelist values (`Allowed values: 3600000, 10800000, 28800000`) which is acceptable since these are not sensitive (they are visible in the client UI)
- 404 error messages reflect worktreeId (existing pattern across all routes -- not a new concern specific to this issue)

### A06:2021 - Vulnerable and Outdated Components

**Status**: NOT APPLICABLE

- No new dependencies introduced. Uses only existing project components (React, Next.js, Tailwind CSS)

### A07:2021 - Identification and Authentication Failures

**Status**: NOT APPLICABLE

- Local application without authentication. When exposed via reverse proxy, authentication is handled at the proxy level (documented in TRUST_AND_SAFETY.md)

### A08:2021 - Software and Data Integrity Failures

**Status**: PASS

- Server-side whitelist validation ensures only valid duration values are accepted, regardless of client-side manipulation
- Two-layer defense: TypeScript `AutoYesDuration` type on client + `ALLOWED_DURATIONS.includes()` on server
- `expiresAt` is computed server-side from `Date.now() + duration`, preventing client-side timestamp manipulation

### A09:2021 - Security Logging and Monitoring Failures

**Status**: CONDITIONAL PASS (1 finding)

- Auto-Yes polling start/stop is logged via `console.info` (L478, L496)
- Error conditions are logged via `console.warn` (L112, L414)
- Missing: duration value is not included in the log when Auto-Yes is enabled
- Missing: structured security event logging for Auto-Yes state changes (SEC-CO-001)

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: NOT APPLICABLE

- No server-side outbound requests in this change. The polling mechanism reads from local tmux sessions only.

---

## Risk Assessment

| Risk Category | Level | Rationale |
|---------------|-------|-----------|
| Technical | Low | Whitelist validation is straightforward; minimal code surface area |
| Security | Low | Local application; whitelist enforced server-side; 8-hour max cap |
| Operational | Low | Backward compatible; default 1-hour maintains existing behavior |

---

## Detailed Findings

### Must Fix (2 items)

#### SEC-MF-001: worktreeId Format Validation at Route Level

| Attribute | Value |
|-----------|-------|
| OWASP | A03:2021 Injection |
| Severity | Medium |
| Priority | P1 |

**Issue**: `route.ts` does not call `isValidWorktreeId(params.id)` before processing the request. While `validateWorktreeExists()` performs a DB lookup (which implicitly rejects non-existent IDs), format validation should be the first defense layer.

**Current state (route.ts L83-104)**:
```typescript
export async function POST(request, { params }) {
  const notFound = validateWorktreeExists(params.id); // DB check only
  // ... no format check on params.id
  const state = setAutoYesEnabled(params.id, body.enabled); // No format check
}
```

**Recommendation**: Add `isValidWorktreeId()` check at the top of both GET and POST handlers. The design policy Section 7 should explicitly list this validation at the API layer.

**Files affected**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts`

---

#### SEC-MF-002: worktreeId Reflection in Error Responses

| Attribute | Value |
|-----------|-------|
| OWASP | A01:2021 / A05:2021 |
| Severity | Low |
| Priority | P2 |

**Issue**: `validateWorktreeExists()` (L51) returns the worktreeId in the error message: `Worktree '${worktreeId}' not found`. This is a user-input reflection pattern. While React JSX escaping prevents XSS on the client side, the API JSON response contains the raw reflected value.

**Context**: This is an existing pattern across all worktree API routes (19+ occurrences found in the codebase). It is not specific to Issue #225 but should be addressed as part of defense-in-depth when SEC-MF-001 is implemented.

**Recommendation**: Once SEC-MF-001 is implemented (format validation rejects non-alphanumeric IDs), the reflection risk is mitigated since only sanitized values reach the error message. Document this dependency in the design.

---

### Should Fix (4 items)

#### SEC-SF-001: JSON Parse Error Handling

| Attribute | Value |
|-----------|-------|
| OWASP | A03:2021 |
| Severity | Low |
| Priority | P2 |

**Issue**: `request.json()` parse failures are caught by the outer try-catch block and return a generic 500 error. The design should specify explicit handling for malformed JSON with a 400 response.

**Current code (route.ts L91)**:
```typescript
const body = await request.json(); // Throws on invalid JSON -> caught as 500
```

**Recommendation**: Add a dedicated try-catch around `request.json()` or document that the current 500 behavior is acceptable. Explicit 400 for parse errors is more informative.

**Files affected**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts`

---

#### SEC-SF-002: Explicit typeof Check for duration

| Attribute | Value |
|-----------|-------|
| OWASP | A03:2021 |
| Severity | Low |
| Priority | P3 |

**Issue**: The design specifies only `ALLOWED_DURATIONS.includes(body.duration)` without a preceding `typeof` check. While `includes()` uses strict equality, adding `typeof body.duration !== 'number'` provides explicit defense-in-depth.

**Recommended validation**:
```typescript
if (body.enabled && body.duration !== undefined) {
  if (typeof body.duration !== 'number' || !ALLOWED_DURATIONS.includes(body.duration)) {
    return NextResponse.json(
      { error: 'Invalid duration value. Allowed values: 3600000, 10800000, 28800000' },
      { status: 400 }
    );
  }
}
```

**Files affected**:
- Design policy Section 5 (validation rules)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts`

---

#### SEC-SF-003: TRUST_AND_SAFETY.md Update Completeness

| Attribute | Value |
|-----------|-------|
| OWASP | Security Documentation |
| Severity | Low |
| Priority | P3 |

**Issue**: The design policy (Section 7, Stage 3 SF-003) specifies TRUST_AND_SAFETY.md updates but does not include concrete risk scenarios or best practices for long-duration Auto-Yes usage.

**Current TRUST_AND_SAFETY.md** (L48-49): Only mentions that Auto-Yes confirmation dialog exists. No mention of duration options or associated risks.

**Recommendation**: Include in the update:
1. Concrete risk scenario: "8-hour Auto-Yes enables unattended automatic approval of file operations"
2. Best practice: "Use the shortest duration that matches your workflow"
3. Best practice: "Manually disable Auto-Yes before leaving your workstation"
4. Best practice: "Keep CM_ROOT_DIR scoped to specific repositories when using long durations"

**Files affected**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/docs/TRUST_AND_SAFETY.md`

---

#### SEC-SF-004: lastAutoResponse Display Safety Documentation

| Attribute | Value |
|-----------|-------|
| OWASP | A03:2021 (XSS) |
| Severity | Low |
| Priority | P3 |

**Issue**: `AutoYesToggle.tsx` (L78) embeds `lastAutoResponse` in a notification string displayed in JSX. While React's default escaping prevents XSS, and `resolveAutoAnswer()` only returns 'y' or numeric strings, the design policy Section 7 does not explicitly analyze this data flow.

**Data flow analysis**:
```
resolveAutoAnswer() -> 'y' | number.toString() | null
  -> useAutoYes.lastAutoResponse (state)
    -> AutoYesToggle.notification (state)
      -> JSX {notification} (React-escaped)
```

**Recommendation**: Add a note in design policy Section 7 risk evaluation confirming that auto-response values displayed in UI are constrained to safe output from `resolveAutoAnswer()` and rendered via React JSX escaping.

---

### Consider (3 items)

#### SEC-CO-001: Structured Security Event Logging for Auto-Yes State Changes

**OWASP**: A09:2021 Security Logging and Monitoring Failures

Auto-Yes enable/disable events should be logged with structured data including worktreeId, duration, cliToolId, and timestamp. The project already has `src/cli/utils/security-logger.ts` for security event logging. Consider extending this pattern for Auto-Yes events, particularly when 8-hour durations are selected.

#### SEC-CO-002: Rate Limiting for Auto-Yes Toggle

**OWASP**: Availability / DoS

The POST endpoint has no rate limiting for rapid ON/OFF toggling. While the local application context makes this low-risk, a minimum interval (e.g., 2 seconds between state changes for the same worktreeId) would prevent timer churn.

#### SEC-CO-003: Security Review Process for ALLOWED_DURATIONS Changes

**OWASP**: Security Process

Adding new values to `ALLOWED_DURATIONS` (especially larger values like 24h+) changes the security risk profile. Consider adding a comment in `auto-yes-config.ts` noting that changes to this array should trigger a security review.

---

## Design Policy Section 7 Evaluation

### Covered Topics (Adequate)

| Topic | Assessment |
|-------|-----------|
| duration whitelist validation | Well-designed using `ALLOWED_DURATIONS.includes()` |
| worktreeId format verification (existing) | Referenced but not explicit at route level |
| cliToolId whitelist (existing) | Properly delegated to existing `isValidCliTool()` |
| Client-side type constraint | `AutoYesDuration` literal union is effective |
| Maximum duration cap (8 hours) | Appropriate upper bound |
| Default fallback (1 hour) | Secure-by-default principle applied |
| User consent dialog | Informed consent before enabling |

### Missing Topics

| Topic | Recommendation |
|-------|---------------|
| Route-level worktreeId format validation | Explicitly add to validation table |
| JSON parse error handling | Document expected behavior for malformed requests |
| typeof check for duration | Add to validation rules |
| UI display safety analysis | Document React JSX escaping for displayed values |
| Security event logging | Define logging strategy for state changes |
| Duration change review process | Add process note for future modifications |

---

## Specific Security Concerns Addressed

### Duration Parameter Validation (Whitelist Enforcement)

**Assessment**: STRONG

The whitelist approach using `as const` tuple + `ALLOWED_DURATIONS.includes()` is the gold standard for fixed-option validation. The `AutoYesDuration` literal union type provides compile-time guarantees that propagate through the entire client-side call chain (AutoYesConfirmDialog -> AutoYesToggle -> WorktreeDetailRefactored -> API call). The server-side validation is the authoritative check.

### API Request Validation

**Assessment**: ADEQUATE with improvements needed

- `enabled` boolean check: Present (L92)
- `cliToolId` whitelist: Present (L100-102), with safe fallback to 'claude'
- `duration` whitelist: Designed but not yet implemented (pre-code)
- `worktreeId` format: Missing at route level (SEC-MF-001)
- JSON parsing: No explicit error handling (SEC-SF-001)

### XSS/Injection Risks in UI Components

**Assessment**: SAFE

- `cliToolName` rendered in JSX text nodes (React-escaped)
- `DURATION_LABELS[duration]` values are static strings defined in config
- `notification` content derived from `resolveAutoAnswer()` constrained output
- No use of `dangerouslySetInnerHTML`, `innerHTML`, or eval-like patterns
- Radio button values are from `ALLOWED_DURATIONS` (numeric constants)

### Information Disclosure Risks

**Assessment**: LOW

- Error messages expose whitelist values (acceptable -- visible in client code)
- worktreeId reflected in 404 errors (existing pattern, not new)
- No stack traces or internal paths in error responses

### DoS Risks from Long Durations

**Assessment**: MITIGATED

- Maximum 8 hours (no unlimited option)
- `MAX_CONCURRENT_POLLERS = 50` limits total active pollers
- Exponential backoff on errors prevents runaway polling
- Auto-disable on expiration prevents indefinite polling
- In-memory state (no DB impact from long-running state)

---

## Conclusion

The design policy for Issue #225 demonstrates solid security thinking with the whitelist validation approach, type-safe data flow, and safe defaults. The two must-fix items (worktreeId format validation at route level and error message reflection) are defense-in-depth improvements rather than critical vulnerabilities. The should-fix items are documentation and robustness enhancements.

**Approval**: Conditionally approved -- address SEC-MF-001 (worktreeId format validation) and SEC-SF-002 (typeof check) in the implementation.

---

*Reviewed by: Architecture Review Agent (Stage 4 Security)*
*Date: 2026-02-10*
