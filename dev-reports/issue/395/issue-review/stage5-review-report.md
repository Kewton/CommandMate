# Issue #395 Stage 5 Review Report

**Review date**: 2026-03-03
**Focus**: Consistency & Correctness (2nd iteration)
**Stage**: 5

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 4 |

## Previous Findings Verification

### Stage 1 Applied Findings (6 items)

All 6 applied findings from Stage 1 have been verified as correctly reflected in the current Issue:

| ID | Status | Notes |
|----|--------|-------|
| S1-001 (CSP documentation) | Verified | "Existing Security Controls and Their Limitations" section added with detailed CSP analysis |
| S1-002 (Auth middleware precondition) | Verified | Added to Preconditions with authenticated session requirement |
| S1-003 (X-Forwarded-* headers) | Verified | Added to Root Cause, Recommended Direction, and SENSITIVE_REQUEST_HEADERS code example |
| S1-004 (Validation Notes expansion) | Verified | Items 4-7 added covering Set-Cookie overwrite, CSP inline JS, proxy response headers, directUrl leak |
| S1-007 (iframe sandboxing) | Verified | Added to Recommended Direction with explicit "not a complete solution" caveat |
| S1-009 (next.config.js header applicability) | Verified | Added as "Critical unknown" in Impact and Validation Notes item 6 |

### Stage 1 Skipped Findings (3 items)

| ID | Status | Notes |
|----|--------|-------|
| S1-005 (Authorization header risk overstatement) | Acceptable skip | Nice to Have; current wording is not technically incorrect |
| S1-006 (directUrl info leak) | Resolved via S3-003 | Same issue elevated to should_fix in Stage 3 and applied |
| S1-008 (Line number accuracy) | Acceptable skip | Minor Nice to Have |

### Stage 3 Applied Findings (9 items)

All 9 applied findings from Stage 3 have been verified:

| ID | Status | Notes |
|----|--------|-------|
| S3-001 (Test modification plan) | Verified | Test files subsection and 5-item modification plan added |
| S3-002 (config.ts constants design) | Verified with issue (see S5-001) | Code example present but text description inconsistent |
| S3-003 (directUrl removal) | Verified with issue (see S5-008) | directUrl field addressed but message field still contains URL |
| S3-004 (UI security warning) | Verified | ExternalAppForm.tsx added to affected files with specific warning text |
| S3-005 (middleware.ts no-change clarification) | Verified | "Files requiring NO modification" subsection added |
| S3-006 (validation.ts scope clarification) | Verified | Added to no-change section with future extension note |
| S3-007 (CSP header stripping) | Verified | Added to Recommended Direction and SENSITIVE_RESPONSE_HEADERS code example |
| S3-008 (CLAUDE.md update) | Verified | Added to Acceptance Criteria |
| S3-010 (Restrictive CSP injection) | Verified with issue (see S5-005) | Scope unclear |

### Stage 3 Skipped Findings (3 items)

| ID | Status | Notes |
|----|--------|-------|
| S3-009 (security-guide.md update) | Acceptable skip | Can be addressed post-fix |
| S3-011 (Worktree proxy note) | Partially addressed | Affected Surface already contains the suggested note |
| S3-012 (Dedicated security test file) | Acceptable skip | Covered by S3-001 test plan |

---

## Should Fix (4 items)

### S5-001: SENSITIVE_RESPONSE_HEADERS content mismatch between S3-002 text and Implementation Notes code

**Category**: Consistency
**Location**: Recommended Direction "Header constants in config.ts (S3-002)" vs Implementation Notes "config.ts design (S3-002)"

**Issue**:
The Recommended Direction text for S3-002 lists SENSITIVE_RESPONSE_HEADERS as containing only `Set-Cookie`. However, the Implementation Notes code example for the same constant includes three entries: `set-cookie`, `content-security-policy`, and `x-frame-options`. This discrepancy could confuse implementers about the intended contents of the constant.

**Evidence**:
- S3-002 text: "SENSITIVE_RESPONSE_HEADERS (Set-Cookie)"
- Implementation Notes code: `['set-cookie', 'content-security-policy', 'x-frame-options']`

**Recommendation**:
Update the S3-002 text description to explicitly list all three entries: "SENSITIVE_RESPONSE_HEADERS (Set-Cookie, Content-Security-Policy, X-Frame-Options)". The Implementation Notes code example is the authoritative definition.

---

### S5-002: Acceptance Criteria missing directUrl removal test

**Category**: Insufficient information
**Location**: Acceptance Criteria vs Implementation Notes "Test modification plan (S3-001)"

**Issue**:
The Implementation Notes Test modification plan item 5 specifies "Verify proxyWebSocket() 426 response does not contain directUrl field", but this specific test is not reflected in the Acceptance Criteria. The Acceptance Criteria mention "New tests added for request header stripping, response header stripping, and safe header forwarding" but omit the directUrl removal verification test.

**Recommendation**:
Expand the Acceptance Criteria test item to: "New tests added for request header stripping, response header stripping, safe header forwarding, and directUrl removal verification".

---

### S5-005: Restrictive CSP header injection (S3-010) scope ambiguity

**Category**: Insufficient information
**Location**: Recommended Direction "Restrictive CSP header injection option (S3-010)" / Acceptance Criteria

**Issue**:
The S3-010 recommendation uses "Consider adding the ability..." phrasing, making it unclear whether this feature is in scope for Issue #395. There is no corresponding Acceptance Criteria item. Meanwhile, the basic header stripping features clearly have matching Acceptance Criteria. This ambiguity could lead to scope creep or confusion during implementation.

**Recommendation**:
Mark S3-010 as "Out of scope for this Issue" and recommend a follow-up Issue. Per-app CSP configuration involves database schema changes and UI modifications that are better handled separately. The basic SENSITIVE_RESPONSE_HEADERS stripping (which removes upstream CSP headers) provides adequate defense for this Issue.

---

### S5-008: proxyWebSocket() message field still contains internal URL after directUrl field removal

**Category**: Insufficient information
**Location**: Recommended Direction "proxyWebSocket() directUrl removal (S3-003)" / handler.ts L155

**Issue**:
The Issue specifies removing the `directUrl` field from the 426 response, but the `message` field at handler.ts L155 contains:
```
`${PROXY_ERROR_MESSAGES.UPGRADE_REQUIRED}. Configure your WebSocket client to connect directly to ${directWsUrl}`
```
This embeds the internal URL (`ws://localhost:3000/...`) into the message text. Removing only the `directUrl` JSON field does not prevent the information leak. The Test modification plan item 5 also only checks for the `directUrl` field, not the message content.

**Evidence**:
- handler.ts L150: `const directWsUrl = \`ws://${app.targetHost}:${app.targetPort}${path}\`;`
- handler.ts L155: message includes `${directWsUrl}`

**Recommendation**:
Extend S3-003 to specify: "Remove directUrl field AND remove internal URL from message field. Use a generic message such as 'WebSocket connections are not supported through the proxy Route Handler'." Update Test modification plan to verify no internal URL appears in any response field.

---

## Nice to Have (4 items)

### S5-003: Key source references contain route.ts entries despite being in "no modification" list

**Category**: Consistency
**Location**: Affected Code > Key source references

**Issue**:
`src/app/proxy/[...path]/route.ts:22` and `route.ts:83` appear in Key source references while the file is listed under "Files requiring NO modification". This could confuse implementers.

**Recommendation**:
Add "(reference only, no changes needed)" annotation to the route.ts entries in Key source references.

---

### S5-004: ExternalAppForm.tsx change description lacks implementation specifics

**Category**: Consistency
**Location**: Affected Code > Files requiring modification > ExternalAppForm.tsx

**Issue**:
handler.ts and config.ts have detailed change descriptions, but ExternalAppForm.tsx only says "Add security warning banner to the registration/edit form (see Recommended Direction)". Banner placement, data-testid, and i18n considerations are unspecified.

**Recommendation**:
Add minimal implementation notes: form top placement, amber/yellow color scheme, data-testid attribute, English-only text for this Issue.

---

### S5-006: iframe sandboxing recommendation scope also unclear

**Category**: Consistency
**Location**: Recommended Direction "iframe sandboxing" / Acceptance Criteria

**Issue**:
Same ambiguity as S5-005 -- no Acceptance Criteria item, unclear if in scope. Separating Recommended Direction items into "this Issue scope" vs "future considerations" would improve clarity.

**Recommendation**:
Tag each Recommended Direction item as "(this Issue)" or "(future consideration)" to clearly delineate implementation scope.

---

### S5-007: Key source reference handler.ts:143-166 range is coarse

**Category**: Accuracy
**Location**: Affected Code > Key source references > handler.ts:143-166

**Issue**:
Other handler.ts references point to specific lines (61, 75, 86), but 143-166 covers the entire proxyWebSocket function. The directUrl construction is at L150 and the response body at L156.

**Recommendation**:
Split into `handler.ts:150 (directWsUrl construction)` and `handler.ts:156 (directUrl in response body)`.

---

## Referenced Files

### Code
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/proxy/handler.ts` -- Primary modification target (header stripping, directUrl removal)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/proxy/config.ts` -- Constant definitions (SENSITIVE_*_HEADERS)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/components/external-apps/ExternalAppForm.tsx` -- Security warning banner target
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/app/proxy/[...path]/route.ts` -- Route handler (reference only, no changes)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/tests/unit/proxy/handler.test.ts` -- Existing tests requiring modification
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/config/auth-config.ts` -- AUTH_EXCLUDED_PATHS reference (no changes)

### Documentation
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/CLAUDE.md` -- Module descriptions requiring update per Acceptance Criteria

### Review Artifacts
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/dev-reports/issue/395/issue-review/stage1-review-result.json` -- Stage 1 findings
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/dev-reports/issue/395/issue-review/stage3-review-result.json` -- Stage 3 findings
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/dev-reports/issue/395/issue-review/stage2-apply-result.json` -- Stage 2 application results
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/dev-reports/issue/395/issue-review/stage4-apply-result.json` -- Stage 4 application results
