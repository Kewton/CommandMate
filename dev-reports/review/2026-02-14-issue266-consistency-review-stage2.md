# Architecture Review Report: Issue #266 - Stage 2 (Consistency Review)

## Executive Summary

| Item | Value |
|------|-------|
| **Issue** | #266 - Browser tab switch clears input content |
| **Stage** | Stage 2: Consistency Review |
| **Focus** | Design document vs. implementation consistency |
| **Score** | 4/5 |
| **Status** | Conditionally Approved |
| **Date** | 2026-02-14 |

The design document for Issue #266 is well-structured and accurately describes the current implementation state (Before code). The proposed modification (After code) is logically sound and addresses the root cause. Two minor consistency concerns were identified regarding the fetch pattern differences between the lightweight recovery and `handleRetry`, and a documentation accuracy issue in the SF-DRY-001 summary. Neither of these are blocking issues.

---

## Detailed Findings

### Consistency Matrix: Design Document vs. Current Implementation

| Design Item | Design Document Description | Current Implementation Status | Consistency |
|-------------|---------------------------|-------------------------------|-------------|
| Root cause analysis | `visibilitychange` -> `handleRetry()` -> `setLoading(true)` -> unmount -> remount -> `useState('')` clears input | `handleVisibilityChange` (L1494) calls `handleRetry()` (L1503-1504), which calls `setLoading(true)` (L1449). `if (loading)` (L1611) renders `<LoadingIndicator />` instead of `MessageInput`. | MATCH |
| Before code (Section 4-1) | `useCallback(() => { ... handleRetry(); }, [handleRetry])` at L1494-1505 | Implementation at L1494-1505 is a synchronous `useCallback` calling `handleRetry()` directly with dependency `[handleRetry]`. | MATCH |
| Change scope | Presentation layer only: `WorktreeDetailRefactored.tsx` | Only `handleVisibilityChange` in `WorktreeDetailRefactored.tsx` is targeted for change. | MATCH |
| `RECOVERY_THROTTLE_MS` constant | 5000ms throttle guard | Defined at L104 as `const RECOVERY_THROTTLE_MS = 5000` | MATCH |
| `lastRecoveryTimestampRef` | `useRef<number>(0)` throttle timestamp | Defined at L1466 as `useRef<number>(0)` | MATCH |
| `handleRetry` behavior | `setError(null)` + `setLoading(true)` + fetch + `setLoading(false)` | L1447-1455: `setError(null)`, `setLoading(true)`, `fetchWorktree()`, conditional `Promise.all([fetchMessages(), fetchCurrentOutput()])`, `setLoading(false)` | MATCH (with fetch pattern caveat - see SF-CONS-001) |
| `MessageInput` state | `useState('')` loses state on unmount | L33 of `MessageInput.tsx`: `const [message, setMessage] = useState('')` | MATCH |
| `PromptPanel` state | Input state lost on unmount | L78 of `PromptPanel.tsx`: `const [textInputValue, setTextInputValue] = useState('')` | MATCH |
| API endpoints | GET `/api/worktrees/:id`, GET `/api/worktrees/:id/messages`, GET `/api/worktrees/:id/current-output` | `fetchWorktree` (L997), `fetchMessages` (L1015), `fetchCurrentOutput` (L1030) all use these endpoints | MATCH |
| Data model changes | None | No schema changes detected | MATCH |
| Security impact | None | No new external input handling, no auth changes | MATCH |
| Related Issue | #246 introduced the visibility change handler | Comment at L1458 references Issue #246, design rationale comments reference MF-001, IA-001, IA-002 from #246 | MATCH |

### Consistency Verification: After Code (Proposed Changes)

| Design Item | Design Document Description | Feasibility | Notes |
|-------------|---------------------------|-------------|-------|
| `async useCallback` | `handleVisibilityChange` becomes async | FEASIBLE | `handleRetry` (L1447) already uses async useCallback pattern in this codebase |
| Error guard | `if (error) { handleRetry(); return; }` | FEASIBLE | `error` state defined at L952 as `useState<string \| null>(null)` |
| Lightweight recovery | `Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()])` | FEASIBLE | All three functions are defined and accessible in scope. However, see SF-CONS-001 for pattern difference with `handleRetry` |
| Silent catch | `catch { /* silent */ }` | FEASIBLE | Consistent with design decision to rely on next polling cycle |
| Dependency array | `[error, handleRetry, fetchWorktree, fetchMessages, fetchCurrentOutput]` | FEASIBLE | All values are in scope; adding `error` ensures re-creation when error state changes |
| Event listener registration | Unchanged `useEffect` with `addEventListener`/`removeEventListener` | FEASIBLE | Existing pattern at L1552-1557 requires no modification |

---

## Should Fix Items

### SF-CONS-001: Fetch Pattern Difference Between Lightweight Recovery and handleRetry

**Severity**: Medium

**Description**:

The design document's After code for lightweight recovery uses:

```typescript
await Promise.all([
  fetchWorktree(),
  fetchMessages(),
  fetchCurrentOutput(),
]);
```

However, the existing `handleRetry` implementation (L1447-1455) uses a conditional pattern:

```typescript
const worktreeData = await fetchWorktree();
if (worktreeData) {
  await Promise.all([fetchMessages(), fetchCurrentOutput()]);
}
```

This means `handleRetry` only calls `fetchMessages` and `fetchCurrentOutput` when `fetchWorktree` succeeds, while the lightweight recovery always calls all three in parallel regardless of worktree availability.

**Impact**: Low. Since all three are idempotent GET requests and the lightweight recovery's catch block silently ignores errors, the practical impact is limited to at most two unnecessary network requests when the worktree fetch fails. The next polling interval will naturally retry.

**Recommendation**: Either:
1. Add a brief note in the design document explaining why the lightweight recovery intentionally uses the simpler parallel pattern (e.g., "Since failure is silently ignored and handled by subsequent polling, the conditional check is unnecessary for the lightweight path"), or
2. Align the lightweight recovery with handleRetry's conditional pattern for exact behavioral parity.

Option 1 is recommended as it preserves the KISS principle documented in SF-002.

---

### SF-CONS-002: SF-DRY-001 Summary Describes Inaccurate handleRetry Fetch Pattern

**Severity**: Low

**Description**:

Section 13 of the design document states:

> `handleRetry()`内の`Promise.all([fetchMessages(), fetchCurrentOutput()])`

This is technically incomplete. The actual `handleRetry` implementation is:

```typescript
const worktreeData = await fetchWorktree();
if (worktreeData) {
  await Promise.all([fetchMessages(), fetchCurrentOutput()]);
}
```

The summary omits `fetchWorktree()` being called first sequentially and the conditional guard on its result. This could cause confusion when developers reference this section to understand the duplication scope.

**Recommendation**: Update the SF-DRY-001 description in Section 13 to accurately reflect the full `handleRetry` fetch pattern:

> `handleRetry()`内の`fetchWorktree()`逐次実行 + 条件付き`Promise.all([fetchMessages(), fetchCurrentOutput()])`

---

## Consider Items

### C-CONS-001: Line Number References Are Snapshot-Dependent

The design document references specific line numbers (e.g., "L1494-1505"). These match the current implementation but may drift as other changes are made to the file. This is standard practice in this project and does not require action.

### C-CONS-002: Existing Test Case TC-2 Alignment With Modified Error Guard Path

The existing test case TC-2 (`tests/unit/components/WorktreeDetailRefactored.test.tsx`, around L866) tests error recovery via visibilitychange by:
1. Making fetch fail to trigger error state
2. Restoring fetch and dispatching visibilitychange
3. Asserting error clears and data loads

After modification, this test should still pass because the `error` guard in the new code will route to `handleRetry()` when error state exists. However, the test assertions should be reviewed during implementation to ensure they properly validate the error-guarded path.

New test cases specified in the design document Section 9 (verifying `setLoading` is NOT called during normal-state visibility change) should complement the existing tests.

### C-CONS-003: async useCallback Pattern

The After code changes `useCallback(() => ...)` to `useCallback(async () => ...)`. While React does not explicitly document this pattern, it works correctly because the event listener simply ignores the returned Promise. This pattern is already used elsewhere in this codebase (e.g., `handleRetry` at L1447).

---

## Risk Assessment

| Risk Category | Level | Description | Mitigation |
|--------------|-------|-------------|------------|
| Technical Risk | Low | The modification is a straightforward guard condition addition. The fetch functions and state management are unchanged. | Existing test suite covers visibility change behavior. Design document specifies additional test cases. |
| Security Risk | Low | No new external input processing. Same idempotent GET endpoints. | No mitigation needed. |
| Operational Risk | Low | Silent failure in lightweight recovery could mask issues temporarily. | Polling interval (2-5 seconds) provides automatic recovery. Design document acknowledges this trade-off. |

---

## Consistency Checklist Summary

| Check Item | Result | Notes |
|-----------|--------|-------|
| Before code matches current implementation | PASS | L1494-1505 matches exactly |
| Root cause analysis is accurate | PASS | `setLoading(true)` -> unmount -> remount -> `useState('')` correctly identified |
| Change scope correctly identified | PASS | Only `handleVisibilityChange` in `WorktreeDetailRefactored.tsx` |
| After code is implementable with current codebase | PASS | All referenced functions/state variables exist |
| API endpoints accurately listed | PASS | Three GET endpoints match actual fetch implementations |
| Data model "no change" assertion is correct | PASS | No schema changes required |
| Security "no impact" assertion is correct | PASS | No new input handling or auth changes |
| Performance design is consistent | PASS | Throttle guard maintained, Promise.all for parallel execution |
| Test design covers the changes | PASS | Existing tests + new test cases in Section 9 |
| Related Issue reference is accurate | PASS | Issue #246 correctly identified as origin |
| SF-DRY-001 handling is documented | PASS (with caveat) | Comment approach documented; handleRetry fetch pattern description slightly inaccurate (SF-CONS-002) |

---

## Approval Status

**Status: Conditionally Approved**

The design document demonstrates strong consistency with the current implementation. The Before code, root cause analysis, change scope, and architectural impact are all accurately described. The proposed After code is implementable and logically correct.

**Conditions for full approval**:
1. Address SF-CONS-001 by adding a brief explanatory note in the design document about why the lightweight recovery uses a simpler parallel fetch pattern compared to handleRetry's conditional pattern, OR align the patterns.
2. Address SF-CONS-002 by correcting the SF-DRY-001 summary to accurately describe handleRetry's actual fetch structure.

Both conditions are documentation-level fixes and do not affect the implementation approach.

---

## Files Reviewed

| File | Path | Purpose |
|------|------|---------|
| Design Policy | `/Users/maenokota/share/work/github_kewton/commandmate-issue-266/dev-reports/design/issue-266-visibility-change-input-clear-design-policy.md` | Design document under review |
| WorktreeDetailRefactored | `/Users/maenokota/share/work/github_kewton/commandmate-issue-266/src/components/worktree/WorktreeDetailRefactored.tsx` | Primary implementation target |
| MessageInput | `/Users/maenokota/share/work/github_kewton/commandmate-issue-266/src/components/worktree/MessageInput.tsx` | Affected component (input state) |
| PromptPanel | `/Users/maenokota/share/work/github_kewton/commandmate-issue-266/src/components/worktree/PromptPanel.tsx` | Affected component (input state) |
| Test file | `/Users/maenokota/share/work/github_kewton/commandmate-issue-266/tests/unit/components/WorktreeDetailRefactored.test.tsx` | Existing visibility change tests |
