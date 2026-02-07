# Architecture Review: Issue #180 Security Review (Stage 4)

**Issue**: #180 - Status display inconsistency fix
**Review Type**: Security (OWASP Top 10 focus)
**Date**: 2026-02-07
**Reviewer**: architecture-review-agent
**Verdict**: APPROVE

---

## 1. Review Scope

### Design Document
- `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md`

### Source Files Reviewed
| File | Role in Change |
|------|---------------|
| `src/lib/status-detector.ts` | Core: add `hasActivePrompt` to `StatusDetectionResult`, already implements 15-line windowing |
| `src/app/api/worktrees/route.ts` | Replace inline status detection with `detectSessionStatus()` call |
| `src/app/api/worktrees/[id]/route.ts` | Same replacement as above |
| `src/lib/prompt-detector.ts` | Unchanged; called by `detectSessionStatus()` internally |
| `src/lib/cli-patterns.ts` | Unchanged; provides `stripAnsi()`, `detectThinking()`, patterns |
| `src/lib/cli-session.ts` | Unchanged; provides `captureSessionOutput()` |
| `src/lib/auto-yes-manager.ts` (lines 280-309) | Context: related vulnerability pattern (IS-007) |
| `src/app/api/worktrees/[id]/current-output/route.ts` (lines 80-99) | Context: related vulnerability pattern (IS-001) |
| `src/lib/__tests__/status-detector.test.ts` | Existing test coverage baseline |

---

## 2. Executive Summary

Issue #180 proposes consolidating duplicated inline status detection logic from two `route.ts` files into the existing `detectSessionStatus()` function in `status-detector.ts`. From a security perspective, this change is **LOW RISK**. No new attack surface is introduced. The primary security impact is **positive**: the consolidation reduces the risk of inconsistent security patches by centralizing the logic in one location.

The review evaluated OWASP Top 10 categories, regex safety (ReDoS), ANSI injection handling, race conditions, DoS resilience, and information disclosure. All categories either pass or are not applicable. One minor new observation is noted regarding empty line windowing behavior, which the design document already identifies and proposes test-driven mitigation for.

---

## 3. OWASP Top 10 Evaluation

### A01:2021 - Broken Access Control
**Status**: Pass (Not affected)

The change does not modify access control. The API routes continue to serve worktree data without authentication changes. Error handlers return generic messages (`'Failed to fetch worktrees'`, `'Failed to fetch worktree'`) without stack traces or internal state.

### A02:2021 - Cryptographic Failures
**Status**: Not Applicable

No cryptographic operations are involved in the status detection path.

### A03:2021 - Injection
**Status**: Pass (No new injection vectors)

Three injection sub-categories were evaluated:

1. **Command Injection**: The `captureSessionOutput()` function uses `capturePane()` from the tmux library, which operates on session names derived from database-stored worktree IDs. The proposed change does not alter how session names or worktree IDs flow through the system. The `cliToolId` parameter is constrained by TypeScript's `CLIToolType` union type (`'claude' | 'codex' | 'gemini'`).

2. **ANSI Injection**: The `stripAnsi()` function (`cli-patterns.ts` line 167-171) uses the pattern:
   ```
   /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g
   ```
   This covers standard CSI sequences, BEL-terminated OSC sequences, and orphaned SGR codes. The design correctly centralizes `stripAnsi()` calling inside `detectSessionStatus()` (DR-001), with safe ordering: strip first, then split into lines and match patterns. The pattern does not cover C1 control codes (0x80-0x9F) or ST-terminated OSC sequences, but since the input source is tmux `capture-pane` output (a trusted local process), the risk is negligible. This is a pre-existing condition.

3. **SQL Injection**: The `getMessages()` and `markPendingPromptsAsAnswered()` DB calls in the stale prompt cleanup logic use parameterized queries (better-sqlite3). The change does not modify how parameters are passed to these functions.

### A04:2021 - Insecure Design
**Status**: Pass (Design improvement)

The consolidation of duplicated logic into a single function is a security design improvement. Currently, any security fix to the status detection logic must be applied in three places. After the change, only `status-detector.ts` needs modification, reducing the risk of partial patches.

### A05:2021 through A08:2021
**Status**: Not Applicable

No configuration changes (A05), no new dependencies (A06), no auth changes (A07), no deserialization changes (A08).

### A09:2021 - Security Logging and Monitoring
**Status**: Pass

Existing logging in `detectSessionStatus()` (via `prompt-detector.ts` logger) and route.ts error handlers (`console.error`) is preserved.

### A10:2021 - SSRF
**Status**: Not Applicable

The change operates exclusively on local tmux process output. No outbound server requests are made.

---

## 4. Detailed Security Findings

### SEC-001: stripAnsi() Pattern Completeness [nice_to_have, pre-existing]

The `stripAnsi()` function adequately handles standard ANSI escape sequences for the tmux capture-pane use case. The missing coverage for C1 control codes and ST-terminated OSC sequences is a theoretical concern given the trusted input source. The consolidation in `detectSessionStatus()` ensures stripAnsi is called exactly once (DR-001/DR-005), eliminating the previous double-call in route.ts.

**No action required for Issue #180.**

### SEC-002: ReDoS Safety - Improved [nice_to_have, improvement]

The change **reduces** ReDoS exposure by decreasing the regex processing input from up to 100 lines to 15 lines (`STATUS_CHECK_LINE_COUNT`). All regex patterns in the codebase were examined:

| Pattern | Location | Anchored | Backtracking Risk |
|---------|----------|----------|-------------------|
| `DEFAULT_OPTION_PATTERN` | prompt-detector.ts:182 | `^...$` | None - linear scan |
| `NORMAL_OPTION_PATTERN` | prompt-detector.ts:189 | `^...$` | None - linear scan |
| `yesNoPattern` et al. | prompt-detector.ts:67-138 | `^...$` per line | None - bounded character classes |
| `CLAUDE_THINKING_PATTERN` | cli-patterns.ts:26-29 | Uses `m` flag, `.+` bounded by literal `...` | Minimal - bounded by line length |
| `CLAUDE_PROMPT_PATTERN` | cli-patterns.ts:47 | `^...$` per line | None |
| `ANSI_PATTERN` | cli-patterns.ts:167 | Global, character classes | None - no nested quantifiers |

All patterns are safe. The reduced input window is a bonus improvement.

### SEC-003: Error Handling / Information Disclosure [nice_to_have, pre-existing]

Both route.ts files have inner try-catch blocks (lines 96-99) that silently set `isProcessing = true` on capture failure, and outer try-catch blocks that return generic error messages. The `detectSessionStatus()` function does not throw under normal conditions (all code paths return a result). The change preserves this behavior.

### SEC-004: Race Conditions [nice_to_have, no change]

The `hasActivePrompt` boolean is derived synchronously within `detectSessionStatus()` from `detectPrompt().isPrompt`. There is no new TOCTOU window between the prompt detection and the stale prompt cleanup decision. The existing race condition window (between `captureSessionOutput` and the next API call/polling cycle) is inherent to the polling architecture and is unchanged.

### SEC-005: DoS Resilience - Improved [nice_to_have, improvement]

Processing window reduction from ~100 lines to 15 lines for regex matching directly reduces CPU cost per status check. Combined with the existing 100-line capture limit from `captureSessionOutput()`, this provides adequate DoS protection for the polling-based architecture.

### SEC-008: Security Fix Consolidation [should_fix, improvement]

This is the primary security benefit of the change. Before:
- Security-relevant logic duplicated in 3 locations (`status-detector.ts`, `route.ts`, `[id]/route.ts`)
- Risk of inconsistent patches

After:
- Single source of truth in `status-detector.ts`
- Route.ts files only handle result mapping and DB cleanup

### SEC-009: Empty Line Windowing Edge Case [should_fix, new]

The design document (IS-006, DR-003) identifies that tmux buffers can contain trailing empty lines that push meaningful content outside the 15-line window. The current route.ts code filters empty lines before windowing (`nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '')`), while `status-detector.ts` does not. After consolidation, the behavior changes to include empty lines in the window.

**Security relevance**: If a prompt is pushed outside the window, the status defaults to "running" (low confidence). This is a conservative default (false positive for "busy" rather than false negative), which is the safer failure mode. In the auto-yes context, this code path is not used (auto-yes-manager has its own detection), so misrepresentation does not lead to unintended automated actions.

**Recommendation**: Implement test case 8-2 item 7b as the design proposes. If testing reveals that empty line padding is a practical concern, apply Option B (add empty line filtering to `status-detector.ts`) or Option C (hybrid approach).

---

## 5. Input/Output Analysis

### Input Flow
```
tmux capture-pane (trusted local process)
    -> captureSessionOutput() [100-line limit, DoS protection]
        -> detectSessionStatus(rawOutput, cliToolId) [stripAnsi, 15-line window]
            -> detectPrompt(lastLines) [internal 10/50-line windows]
            -> detectThinking(cliToolId, lastLines)
            -> promptPattern.test(lastLines)
```

No user-controlled HTTP input reaches the status detection logic. The `worktreeId` comes from DB lookup, and `cliToolId` is TypeScript-constrained.

### Output Flow
```
detectSessionStatus() returns StatusDetectionResult {status, confidence, reason, hasActivePrompt}
    -> route.ts maps to {isWaitingForResponse: boolean, isProcessing: boolean}
        -> NextResponse.json() serializes to API response
            -> React components render with auto-escaping
```

The new `hasActivePrompt` field is consumed only by the stale prompt cleanup logic in route.ts (boolean check). It is not included in the API response and not rendered in the UI.

---

## 6. Security Checklist

| Category | Status | Notes |
|----------|--------|-------|
| OWASP A01 - Broken Access Control | PASS | No access control changes |
| OWASP A02 - Cryptographic Failures | N/A | No crypto operations |
| OWASP A03 - Injection | PASS | No new injection vectors; ANSI stripping adequate |
| OWASP A04 - Insecure Design | PASS | Consolidation improves security design |
| OWASP A05 - Security Misconfiguration | N/A | No config changes |
| OWASP A06 - Vulnerable Components | N/A | No new dependencies |
| OWASP A07 - Auth Failures | N/A | No auth changes |
| OWASP A08 - Data Integrity | PASS | No deserialization changes |
| OWASP A09 - Logging/Monitoring | PASS | Existing logging preserved |
| OWASP A10 - SSRF | N/A | Local process only |
| ReDoS Safety | PASS | Improved: 100 -> 15 line input reduction |
| Race Conditions | PASS | No new TOCTOU windows |
| Information Disclosure | PASS | Generic error messages maintained |
| DoS Resilience | PASS | Improved: reduced processing scope |
| ANSI Injection | PASS | Safe strip-then-parse ordering preserved |
| XSS | PASS | No new string values in API responses; React auto-escaping |

---

## 7. Risk Assessment

| Metric | Value |
|--------|-------|
| Overall Risk | LOW |
| New Risks Introduced | 1 (SEC-009, empty line windowing - minor functional concern) |
| Pre-existing Observations | 6 (not affected by change) |
| Security Improvements | 2 (SEC-005 DoS resilience, SEC-008 consolidated fix surface) |

---

## 8. Verdict

**APPROVE** - The design is sound from a security perspective.

The refactoring consolidates duplicated logic, reducing the risk of inconsistent security fixes. No new attack surface is introduced. The ANSI stripping, input validation, error handling, and output encoding postures are maintained or improved. The empty line windowing edge case (SEC-009) should be validated through the proposed test coverage.

### Implementation Recommendations

1. **[SEC-009]** Implement test case 8-2 item 7b (empty line padding pushing prompt outside 15-line window) to validate the edge case and inform the `STATUS_CHECK_LINE_COUNT` decision
2. After removing `stripAnsi`/`detectThinking`/`getCliToolPatterns`/`detectPrompt` imports from route.ts files, verify that no dead import references remain (lint check)
3. When adding `hasActivePrompt` to `StatusDetectionResult`, TypeScript strict mode will enforce that all return paths include the field -- rely on the compiler for completeness

---

*Generated by architecture-review-agent for Issue #180 Stage 4 Security Review*
