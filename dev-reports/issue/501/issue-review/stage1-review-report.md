# Issue #501 Stage 1 Review Report

**Review Date**: 2026-03-16
**Focus**: Normal Review (Consistency, Accuracy, Completeness, Clarity)
**Iteration**: 1
**Issue Title**: fix: Auto-Yes Server/Client Dual Response and Poller Recreation Causing Status Instability

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

**Overall Assessment**: Issue #501 provides an accurate and well-structured analysis of the Auto-Yes dual response problem. The root cause identification is correct, the chain-of-events diagram is clear, and the three proposed fixes address the right areas. No must-fix issues were found. The main improvements relate to line number accuracy, leveraging an existing but unused mechanism in `detectSessionStatus()`, and clarifying ambiguous file references in Fix 3.

---

## Should Fix

### F1-001: Line numbers in Problem B do not match actual code

**Category**: Accuracy
**Affected Section**: Root Cause > Problem B

**Issue**:
The Issue states `auto-yes-poller.ts` L525-528 for poller destruction and L531-540 for new poller creation. The actual code locations are L486-494 (destruction) and L496-506 (creation), a ~40 line offset.

**Evidence**:
- Issue: "L525-528: existing poller stopAutoYesPolling() destruction"
- Actual: L491-494 contains `stopAutoYesPolling(worktreeId)`
- Issue: "L531-540: new poller creation"
- Actual: L496-506 contains the `AutoYesPollerState` initialization

**Recommendation**:
Update line numbers to L486-494 and L496-506, or remove line numbers and reference by function name `startAutoYesPolling()` only (preferred, as line numbers shift with code changes).

---

### F1-002: Existing lastOutputTimestamp parameter in detectSessionStatus() not mentioned

**Category**: Completeness
**Affected Section**: Fixes > Fix 3

**Issue**:
Fix 3 describes implementing a new cooldown mechanism in `status-detector.ts` or `worktree-status-helper.ts`. However, `detectSessionStatus()` already accepts an optional `lastOutputTimestamp?: Date` parameter (L155) and implements a time-based heuristic at L404-417 (`STALE_OUTPUT_THRESHOLD_MS = 5000ms`). The mechanism exists but is not being used -- `current-output/route.ts` L86 and `worktree-status-helper.ts` L91 both call `detectSessionStatus()` without passing this parameter.

**Evidence**:
- `status-detector.ts` L152-156: `export function detectSessionStatus(output: string, cliToolId: CLIToolType, lastOutputTimestamp?: Date)`
- `status-detector.ts` L404-417: Time-based heuristic that returns `ready` when output is stale
- `current-output/route.ts` L86: `detectSessionStatus(output, cliToolId)` -- no `lastOutputTimestamp`
- `worktree-status-helper.ts` L91: `detectSessionStatus(output, cliToolId)` -- no `lastOutputTimestamp`

**Recommendation**:
Rewrite Fix 3 to explicitly state that the existing `lastOutputTimestamp` parameter should be leveraged. The fix becomes:
1. In `current-output/route.ts`, pass `lastServerResponseTimestamp` (converted to `Date`) as the third argument to `detectSessionStatus()`
2. In `worktree-status-helper.ts`, similarly pass the timestamp
3. No changes needed to `status-detector.ts` itself

This significantly reduces implementation scope.

---

### F1-003: Ambiguous "or" in Fix 3 target files

**Category**: Clarity
**Affected Section**: Fixes > Fix 3 and Related Files

**Issue**:
Fix 3 lists target files as `src/lib/detection/status-detector.ts or src/lib/session/worktree-status-helper.ts`. The "or" is ambiguous -- it is unclear whether one or both files need changes, and which one.

**Recommendation**:
If the existing `lastOutputTimestamp` parameter approach (F1-002) is adopted, the target files should be explicitly listed as:
- `src/app/api/worktrees/[id]/current-output/route.ts` (pass timestamp to detectSessionStatus)
- `src/lib/session/worktree-status-helper.ts` (pass timestamp to detectSessionStatus)
- `src/lib/detection/status-detector.ts` -- **no changes needed**

---

## Nice to Have

### F1-004: Missing impact detail for startAutoYesPolling return value change

**Category**: Completeness
**Affected Section**: Fixes > Fix 2

**Issue**:
Fix 2 proposes adding an `already_running` reason to `startAutoYesPolling()` return value. The `auto-yes/route.ts` POST handler at L170 uses `result.started` to set `pollingStarted`. If the poller is already running (not recreated), `started` would presumably be `false`, which would cause the handler to log a warning at L173. The Issue does not clarify how the API should handle this case.

**Recommendation**:
Add a note that `auto-yes/route.ts` should treat `already_running` as a success case, either by returning `started: true` or adding reason-based branching.

---

### F1-005: DUPLICATE_PREVENTION_WINDOW_MS constant value not referenced

**Category**: Completeness
**Affected Section**: Background

**Issue**:
The Issue mentions a "3-second window" but does not reference the constant `DUPLICATE_PREVENTION_WINDOW_MS` or its definition location.

**Recommendation**:
Add a reference to `DUPLICATE_PREVENTION_WINDOW_MS` (3000ms) defined in `useAutoYes.ts` for easier reviewer verification.

---

### F1-006: Minor line number drift in WorktreeDetailRefactored.tsx references

**Category**: Accuracy
**Affected Section**: Root Cause > Problem A

**Issue**:
Issue states `fetchCurrentOutput()` at L353-400 and `useAutoYes()` at L966-972. Actual locations are L352-398 and L961-967 respectively (1-5 line drift). `CurrentOutputResponse` at L116-132 is accurate.

**Recommendation**:
Update to match current code if revising the Issue, or accept the minor drift as non-critical.

---

## Code References

| File | Lines | Relevance |
|------|-------|-----------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L116-132, L352-398, L961-967 | Fix 1 target |
| `src/lib/auto-yes-poller.ts` | L486-506 | Fix 2 target |
| `src/lib/detection/status-detector.ts` | L152-156, L404-417 | Existing lastOutputTimestamp mechanism |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L86, L139 | Fix 1 (already returns timestamp), Fix 3 (pass timestamp to detectSessionStatus) |
| `src/lib/session/worktree-status-helper.ts` | L91 | Fix 3 (pass timestamp to detectSessionStatus) |
| `src/hooks/useAutoYes.ts` | L36, L54-61, L74-81 | Fix 1 indirect (no changes needed) |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | L160-177 | Fix 2 indirect (return value handling) |
