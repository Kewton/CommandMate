# Impact Analysis Review - Issue #518: CLI Base Commands

**Date**: 2026-03-18
**Stage**: 3 (影響分析レビュー)
**Focus**: 影響範囲 (Impact Scope)
**Overall Risk**: Medium
**Design Document**: `dev-reports/design/issue-518-cli-base-commands-design-policy.md`

---

## 1. Executive Summary

Issue #518 adds 6 CLI commands (ls, send, wait, respond, capture, auto-yes) and extends middleware.ts with Bearer token authentication. The change scope is well-bounded: 18 new files (all within `src/cli/` and `tests/`) and 4 modified files. The highest risk is the middleware.ts modification, which touches the authentication flow for all requests. API load from the wait command's polling and type definition drift between CLI and server are secondary concerns.

---

## 2. Impact Matrix

### 2-1. Direct Modifications

| File | Impact Level | Change Description |
|------|-------------|-------------------|
| `src/middleware.ts` | **HIGH** | Bearer token extraction + auth failure response branching |
| `src/cli/index.ts` | LOW | 6 addCommand() registrations (purely additive) |
| `src/cli/types/index.ts` | LOW | WaitExitCode + 6 option interfaces (additive) |
| `src/lib/security/auth.ts` | LOW | Potential Bearer extraction helper (additive) |

### 2-2. New Files (18 total)

- 6 command files: `src/cli/commands/{ls,send,wait,respond,capture,auto-yes}.ts`
- 3 infrastructure files: `src/cli/utils/api-client.ts`, `src/cli/config/duration-constants.ts`, `src/cli/types/api-responses.ts`
- 1 optional file: `src/cli/utils/output-formatter.ts`
- 1 test helper: `tests/helpers/mock-api.ts`
- 7 test files: `tests/unit/cli/commands/*.test.ts`, `tests/unit/cli/utils/api-client.test.ts`, `tests/unit/cli/config/duration-constants.test.ts`

### 2-3. Indirectly Affected (No Code Changes)

| File | Reason |
|------|--------|
| `src/app/api/worktrees/[id]/current-output/route.ts` | New sustained polling consumer (wait command) |
| `src/app/api/worktrees/route.ts` | New consumer (ls command) |
| `src/app/api/worktrees/[id]/send/route.ts` | New consumer (send command) |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | New consumer (auto-yes command) |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | New consumer (respond command) |
| `src/config/auto-yes-config.ts` | Duration constants duplicated - must stay in sync |
| `src/lib/tmux/tmux-capture-cache.ts` | Increased cache pressure from CLI polling |

---

## 3. Findings

### IA3-01 [MUST FIX] middleware.ts Bearer Token - Browser Auth Regression Risk

**Risk**: HIGH

The current middleware.ts follows a linear authentication flow:
1. Check cookie (line 111-114)
2. If no valid cookie, redirect to /login (line 117-119)

The design adds Bearer token support with response-type branching (401 JSON for CLI, redirect for browser). However, the verification ORDER is not explicitly specified. If Bearer is checked before cookie, a browser request with both a cookie and an Authorization header could receive a 401 JSON response instead of a redirect.

**Recommendation**: Explicitly specify cookie-first verification order in the design:
1. Check cookie -> success -> `NextResponse.next()`
2. Check Bearer header -> success -> `NextResponse.next()`
3. Failure: if `Authorization` header present -> 401 JSON, else -> redirect to /login

This preserves backward compatibility with the existing code structure.

### IA3-02 [SHOULD FIX] wait Command Polling Load

**Risk**: MEDIUM

The wait command polls `GET /api/worktrees/:id/current-output` every 3 seconds. This endpoint performs tmux capture (10000 lines), status detection with regex matching, and multiple DB lookups. The tmux-capture-cache has a 2-second TTL, meaning a 3-second poll interval results in near-zero cache hits (each request arrives after cache expiry).

With multiple worktrees via `Promise.allSettled`, N worktrees produce N concurrent polling streams. Multiple CLI instances watching the same worktree compound this further.

**Recommendation**: Consider increasing the polling interval to 5 seconds, or document a recommended maximum concurrent wait count. For Phase 2, consider SSE or WebSocket notification to eliminate polling.

### IA3-03 [SHOULD FIX] Type Definition Drift Between CLI and Server

**Risk**: MEDIUM

`tsconfig.cli.json` includes only `src/cli/**/*`, forcing CLI-side type duplicates in `api-responses.ts`. These 6+ type definitions (WorktreeListResponse, CurrentOutputResponse, PromptResponseResult, etc.) can drift from server-side sources silently. The design acknowledges this as a Phase 2 item but provides no compile-time safety net for Phase 1.

**Recommendation**: Extend the cross-validation test pattern (DR1-09) beyond Duration constants to cover API response type shapes. A test file under `tests/` can import both CLI and server types to verify field compatibility at compile time.

### IA3-04 [SHOULD FIX] Duration Constant Duplication Uses Different Representations

**Risk**: MEDIUM

CLI's `DURATION_MAP` uses string keys ('1h', '3h', '8h') mapping to millisecond values, while the server's `ALLOWED_DURATIONS` in `auto-yes-config.ts` stores raw millisecond numbers `[3600000, 10800000, 28800000]`. These are semantically equivalent but structurally different, making manual comparison error-prone.

**Recommendation**: Elevate the DR1-09 cross-validation test from nice_to_have to should_fix. The test should verify that `Object.values(DURATION_MAP)` exactly matches `ALLOWED_DURATIONS`.

### IA3-05 [SHOULD FIX] mock-api.ts Lacks Cleanup Mechanism

**Risk**: LOW

The proposed `tests/helpers/mock-api.ts` sets `global.fetch` via `vi.fn()` but provides no `restoreFetch()` or cleanup function. Existing test helpers (logger-mock.ts, etc.) do not touch `global.fetch`, so there is no current conflict, but test isolation is not guaranteed for future tests.

**Recommendation**: Add a `restoreFetch()` export that saves and restores the original `global.fetch`. Document the expected `afterEach` cleanup pattern.

### IA3-06 [NICE TO HAVE] bin/commandmate.js - No Changes Needed

**Risk**: NONE

Verified: `bin/commandmate.js` requires `dist/cli/index.js`, and `package.json` bin field points to `./bin/commandmate.js`. The `addCommand()` pattern in `index.ts` means new commands are automatically available after `build:cli`. No entry point changes required.

### IA3-07 [NICE TO HAVE] No Command Naming Conflicts

**Risk**: NONE

Existing: init, start, stop, status, issue, docs. New: ls, send, wait, respond, capture, auto-yes. No collisions detected.

### IA3-08 [SHOULD FIX] Multiple CLI Instances Polling Same Worktree

**Risk**: LOW

The tmux-capture-cache's singleflight pattern works within a single Node.js process but not across HTTP requests from separate CLI processes. Multiple `commandmate wait <id>` processes for the same worktree will each trigger independent cache misses.

**Recommendation**: Document the expected usage pattern (1 CLI watcher per worktree). For Phase 2, consider ETag/If-None-Match conditional responses.

### IA3-09 [SHOULD FIX] handleApiError Missing HTTP Status Code Coverage

**Risk**: MEDIUM

The design maps ECONNREFUSED, 401, 404, and 500 to exit codes but omits:
- HTTP 400 (returned by current-output for invalid worktree ID)
- HTTP 429 (rate limiter in auth.ts)
- Network timeouts (distinct from ECONNREFUSED)

**Recommendation**: Extend handleApiError specification: 400 -> CONFIG_ERROR (input validation), 429 -> DEPENDENCY_ERROR (with retry message), timeout -> DEPENDENCY_ERROR.

---

## 4. Risk Summary

| ID | Severity | Category | Risk Level |
|----|----------|----------|------------|
| IA3-01 | must_fix | Middleware regression | HIGH |
| IA3-02 | should_fix | API load | MEDIUM |
| IA3-03 | should_fix | Type drift | MEDIUM |
| IA3-04 | should_fix | Duration sync | MEDIUM |
| IA3-05 | should_fix | Test cleanup | LOW |
| IA3-06 | nice_to_have | Binary entry | NONE |
| IA3-07 | nice_to_have | Name conflicts | NONE |
| IA3-08 | should_fix | Concurrent polling | LOW |
| IA3-09 | should_fix | Error mapping | MEDIUM |

**Totals**: 1 must_fix, 6 should_fix, 2 nice_to_have

---

## 5. Checklist

| Check Item | Status | Detail |
|-----------|--------|--------|
| middleware Bearer regression | WARNING | Cookie-first order not specified |
| CLI build no breakage | PASS | All new files within src/cli/ scope |
| API load acceptable | WARNING | 3s poll vs 2s cache TTL = 0% hit rate |
| No new npm dependencies | PASS | Uses Node.js built-in fetch, existing commander |
| Test helper no conflict | WARNING | mock-api.ts lacks fetch restore |
| package.json no change needed | PASS | bin entry point unchanged |
| No command naming conflict | PASS | 6 new names do not collide |
| Concurrent polling | WARNING | Multi-instance not coordinated |
| Error exit code coverage | WARNING | 400, 429, timeout unmapped |

---

*Generated by architecture-review-agent for Issue #518 Stage 3*
*Date: 2026-03-18*
