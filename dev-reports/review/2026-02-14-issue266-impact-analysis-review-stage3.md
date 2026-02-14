# Architecture Review Report: Issue #266 - Stage 3 Impact Analysis

## Summary

| Item | Detail |
|------|--------|
| Issue | #266 - Browser tab switch clears input content |
| Stage | 3 - Impact Analysis Review |
| Focus | Impact Scope (変更の波及効果分析) |
| Status | **conditionally_approved** |
| Score | **4/5** |
| Date | 2026-02-14 |

---

## 1. Executive Summary

This review analyzes the impact scope of the proposed design change for Issue #266. The change modifies the `handleVisibilityChange` function in `WorktreeDetailRefactored.tsx` to use a lightweight recovery pattern instead of calling `handleRetry()` directly, preventing unnecessary component unmount/remount that clears user input.

The change scope is well-contained within a single file (`WorktreeDetailRefactored.tsx`), affecting only the `handleVisibilityChange` callback. The design correctly identifies that the root cause is `setLoading(true/false)` triggering component tree reconstruction, and addresses it by avoiding the loading state toggle during normal visibility recovery.

One notable finding (SF-IMP-001) identifies that `fetchWorktree()` internally calls `setError()` on failure, which could bypass the lightweight recovery's try-catch and still cause component unmount -- partially defeating the design intent. This should be addressed before implementation.

---

## 2. Impact Scope Analysis

### 2-1. Direct Changes

| Category | File | Function | Change Content | Risk |
|----------|------|----------|---------------|------|
| Direct | `src/components/worktree/WorktreeDetailRefactored.tsx` | `handleVisibilityChange` (L1494-1505) | Replace `handleRetry()` call with error guard + lightweight recovery (Promise.all of 3 fetches without setLoading) | Medium |

**Details**:
- The `handleVisibilityChange` useCallback changes from synchronous to async
- New dependency `error` is added to the useCallback dependency array
- Additional dependencies `fetchWorktree`, `fetchMessages`, `fetchCurrentOutput` are added
- The error guard (`if (error)`) routes to existing `handleRetry()` for full recovery
- Normal path uses `Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()])` without loading state changes

### 2-2. Indirect Impacts (Positive)

| Category | File/Component | Impact | Risk |
|----------|---------------|--------|------|
| Positive | `src/components/worktree/MessageInput.tsx` | Input state (`useState('')` on L33) is preserved because the component is no longer unmounted/remounted during tab recovery | Low |
| Positive | `src/components/worktree/PromptPanel.tsx` | `selectedOption`, `textInputValue` states (L71-78) are preserved. User's in-progress prompt selections are maintained | Low |
| Positive | `src/components/mobile/MobilePromptSheet.tsx` | Mobile prompt input state is likewise preserved | Low |

**Mechanism**: These components are children of `WorktreeDetailRefactored`. Previously, `handleRetry()` called `setLoading(true)`, which triggered the conditional render path at L1611 (`if (loading) return <LoadingIndicator />`) to replace the entire component tree. After the change, `loading` is never set to `true` during normal visibility recovery, so the component tree remains intact and all child component state is preserved.

### 2-3. Indirect Impacts (Testing)

| Category | File | Impact | Risk |
|----------|------|--------|------|
| Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | TC-1 (L839): Verifies fetch is called on visibilitychange. Internal path changes from handleRetry to lightweight recovery, but assertion (mockFetch called) still passes | Low |
| Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | TC-2 (L866): Verifies error recovery on visibilitychange. After the change, this test operates in error state, so the `if (error)` guard routes to handleRetry as before. Test continues to pass correctly | Low |
| Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | TC-3 (L925): Hidden state test. No change in behavior. Continues to pass | None |
| Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | TC-4 (L949): Throttle test. Throttle mechanism is unchanged. Continues to pass | None |

### 2-4. Behavioral Changes in Interactions

| Interaction | Before (Current) | After (Proposed) | Impact |
|------------|-------------------|-------------------|--------|
| visibilitychange + Polling | handleRetry calls setLoading(true), polling useEffect(L1560) hits `if (loading) return` and clears interval. Temporary polling gap occurs | Lightweight recovery does not change loading. Polling interval continues without interruption. Both lightweight recovery fetch and polling fetch may run concurrently | Low - All GETrequests are idempotent (IA-002) |
| visibilitychange + Error state | handleRetry is called unconditionally, resets error via setError(null) | Error guard checks `error` first, calls handleRetry only when error exists. Non-error path uses lightweight recovery | Low - Functionally correct separation |
| visibilitychange + MessageInput | setLoading(true) unmounts MessageInput, setLoading(false) remounts it with `useState('')` clearing input | Component tree preserved, MessageInput state maintained | This is the bug fix (positive) |

### 2-5. No Impact (Confirmed Safe)

| File | Reason |
|------|--------|
| `src/app/api/worktrees/[id]/route.ts` | API endpoint unchanged. Only receives GET requests |
| `src/app/api/worktrees/[id]/messages/route.ts` | API endpoint unchanged |
| `src/app/api/worktrees/[id]/current-output/route.ts` | API endpoint unchanged |
| `src/hooks/useWorktreeUIState.ts` | State management hook unchanged. Not modified by this change |
| `src/components/worktree/WorktreeList.tsx` | Has its own independent visibilitychange handler (L151-161) using silent fetchWorktrees(). Not affected |
| `src/app/worktrees/[id]/page.tsx` | Page component simply renders WorktreeDetailRefactored. No impact |
| `src/lib/api-client.ts` | API client unchanged |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | Layout component. Not affected by visibility change logic |
| `src/components/worktree/TerminalDisplay.tsx` | Display component. State managed by parent. Not affected |
| `src/components/worktree/HistoryPane.tsx` | Display component. Messages managed by parent. Not affected |

---

## 3. Detailed Findings

### 3-1. Should Fix Items

#### SF-IMP-001: fetchWorktree() internal setError() defeats lightweight recovery's silent failure intent

**Severity**: Medium

**Description**:

The design specifies that lightweight recovery failures should be silently ignored (try-catch at the outer level). However, the existing `fetchWorktree()` function (L997-1011) contains an internal `setError(message)` call in its catch block (L1008):

```typescript
// src/components/worktree/WorktreeDetailRefactored.tsx L997-1011
const fetchWorktree = useCallback(async (): Promise<Worktree | null> => {
  try {
    const response = await fetch(`/api/worktrees/${worktreeId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch worktree: ${response.status}`);
    }
    const data: Worktree = await response.json();
    setWorktree(data);
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    setError(message);  // <-- This sets the error state BEFORE the outer catch
    return null;
  }
}, [worktreeId]);
```

When `fetchWorktree()` fails during lightweight recovery, it calls `setError(message)` internally. This happens before the Promise.all rejects and the outer try-catch can handle it. The `setError()` call triggers a re-render where the `if (error)` guard (L1616) replaces the component tree with `<ErrorDisplay>`, unmounting MessageInput and clearing its state.

This means that a transient network failure during lightweight recovery can cause the exact same input-clearing behavior the fix is designed to prevent.

**Impact Flow**:
```
Tab return -> lightweight recovery -> fetchWorktree fails
-> setError(message) [internal] -> re-render -> if (error) -> ErrorDisplay
-> MessageInput unmounted -> input cleared
```

**Recommendation**:

Wrap `fetchWorktree()` in the lightweight recovery path with individual error handling to prevent setError propagation. For example:

```typescript
try {
  await Promise.all([
    fetchWorktree().catch(() => {}),  // Suppress setError side-effect
    fetchMessages(),
    fetchCurrentOutput(),
  ]);
} catch {
  // Silent
}
```

However, this alone is insufficient because `fetchWorktree()` calls `setError()` synchronously before returning the rejected promise. A more robust approach would be:

Option A: Create a lightweight version of fetchWorktree that does not call setError:
```typescript
const fetchWorktreeSilent = useCallback(async () => {
  try {
    const response = await fetch(`/api/worktrees/${worktreeId}`);
    if (!response.ok) return null;
    const data = await response.json();
    setWorktree(data);
    return data;
  } catch {
    return null; // No setError
  }
}, [worktreeId]);
```

Option B: Clear error after lightweight recovery completes:
```typescript
try {
  await Promise.all([fetchWorktree(), fetchMessages(), fetchCurrentOutput()]);
} catch {
  // fetchWorktree may have set error state - clear it for silent recovery
  setError(null);
}
```

Option B is simpler but has a brief flash risk where the ErrorDisplay could render for one frame before setError(null) takes effect. Option A is cleaner but introduces a new function. The choice depends on KISS vs correctness priorities.

---

#### SF-IMP-002: useCallback error dependency triggers event listener re-registration

**Severity**: Low

**Description**:

The modified `handleVisibilityChange` adds `error` to its useCallback dependency array:

```typescript
// Proposed
const handleVisibilityChange = useCallback(async () => {
  // ...
  if (error) {
    handleRetry();
    return;
  }
  // ...
}, [error, handleRetry, fetchWorktree, fetchMessages, fetchCurrentOutput]);
```

Since `error` is a state variable (`useState<string | null>`), every time `error` changes (e.g., from null to an error string, or back), a new `handleVisibilityChange` function reference is created. This triggers the useEffect (L1552-1557) to run its cleanup (removeEventListener) and re-run (addEventListener).

The effect chain:
```
error changes -> handleVisibilityChange re-created
-> useEffect cleanup: removeEventListener('visibilitychange', oldHandler)
-> useEffect effect: addEventListener('visibilitychange', newHandler)
```

This is functionally correct and has negligible performance impact (addEventListener/removeEventListener are cheap operations). However, it represents a behavioral change from the current implementation where handleVisibilityChange only depends on `[handleRetry]`.

**Recommendation**: Add a brief comment in the design document acknowledging this dependency chain, so future developers understand why `error` is in the dependency array and what the re-registration consequence is.

---

### 3-2. Consider Items

#### C-IMP-001: Existing test TC-1 internal path change

The existing test TC-1 ("triggers data re-fetch when visibilitychange fires with visible state") currently verifies that `mockFetch` is called after a visibilitychange event. The test passes because `handleRetry()` internally calls fetchWorktree, fetchMessages, and fetchCurrentOutput.

After the modification, the same test passes because the lightweight recovery path also calls the same three fetch functions. However, the internal execution path is different:
- **Before**: visibilitychange -> handleRetry() -> setLoading(true) -> fetchWorktree -> fetchMessages + fetchCurrentOutput -> setLoading(false)
- **After**: visibilitychange -> Promise.all([fetchWorktree, fetchMessages, fetchCurrentOutput])

The test's docstring references `MF-001` (DRY principle via handleRetry), which will no longer be accurate for the normal path. Updating the test comment is recommended during implementation.

#### C-IMP-002: Pattern alignment with WorktreeList.tsx

`WorktreeList.tsx` (L137-161) already uses a lightweight visibilitychange pattern:
```typescript
const handleVisibilityChange = () => {
  if (document.visibilityState === 'visible') {
    fetchWorktrees(true); // Silent update
  }
};
```

After the Issue #266 fix, `WorktreeDetailRefactored.tsx` will adopt a similar "silent/lightweight" approach for the normal path. This increases consistency between the two components' visibilitychange handling strategies. No action required, but this could be a future opportunity for a shared utility.

#### C-IMP-003: Concurrent fetch behavior change with polling

Before the fix, `handleRetry()` via visibilitychange caused `setLoading(true)`, which made the polling useEffect (L1560-1574) return early (`if (loading || error) return`), effectively pausing polling during recovery. After the fix, loading is not changed, so the polling interval continues running. This means:

- A polling tick could fire simultaneously with the lightweight recovery fetch
- Both would execute the same three GET requests concurrently
- This is safe due to idempotent GET requests (as documented in IA-002)
- The throttle guard (RECOVERY_THROTTLE_MS = 5000ms) limits how often visibility recovery runs

The net effect is potentially more concurrent network requests (recovery + polling) than before (where polling was paused during recovery). The additional load is one extra set of 3 GET requests at most, which is negligible.

---

## 4. Risk Assessment

| Risk Category | Level | Description | Mitigation |
|--------------|-------|-------------|------------|
| Technical | Medium | SF-IMP-001: fetchWorktree's internal setError can cause ErrorDisplay render during lightweight recovery, defeating the fix in failure scenarios | Address per SF-IMP-001 recommendation before implementation |
| Security | Low | No new external inputs, no authentication changes. Existing fetch endpoints used as-is | None needed |
| Operational | Low | Change is confined to client-side behavior during tab switching. No server-side impact. Rollback is trivial (revert single function) | Standard deployment process |
| Regression | Low | All 4 existing visibilitychange tests (TC-1 through TC-4) continue to pass. New tests for setLoading non-invocation will add coverage | Add new unit tests as specified in design Section 9 |
| Performance | Low | Slightly more concurrent GET requests when visibility recovery and polling overlap. Throttle guard prevents excess | Existing RECOVERY_THROTTLE_MS is sufficient |

---

## 5. Component Dependency Graph

```
WorktreeDetailRefactored.tsx (MODIFIED)
|
|-- handleVisibilityChange (MODIFIED)
|   |-- [error guard] -> handleRetry() (UNCHANGED)
|   |   |-- setError(null)
|   |   |-- setLoading(true/false) -> triggers component tree reconstruction
|   |   |-- fetchWorktree() -> fetchMessages() + fetchCurrentOutput()
|   |
|   |-- [normal path] -> lightweight recovery (NEW)
|       |-- fetchWorktree() [WARNING: contains setError() internally]
|       |-- fetchMessages()
|       |-- fetchCurrentOutput()
|       |-- NO setLoading change -> component tree PRESERVED
|
|-- Render tree (loading=false, error=null):
    |-- MessageInput (STATE PRESERVED after fix)
    |-- PromptPanel (STATE PRESERVED after fix)
    |-- TerminalDisplay (state from parent, unaffected)
    |-- HistoryPane (state from parent, unaffected)
    |-- MobilePromptSheet (STATE PRESERVED on mobile)
```

---

## 6. Approval Status

**Status: conditionally_approved**

The impact analysis confirms the change is well-scoped and addresses the root cause effectively. The design correctly identifies that preventing `setLoading(true/false)` during normal visibility recovery preserves the component tree and child component state.

**Condition for approval**: SF-IMP-001 must be addressed. The design should specify how `fetchWorktree()`'s internal `setError()` call is handled in the lightweight recovery path to ensure truly silent failure behavior.

The remaining should-fix item (SF-IMP-002) and all consider items are informational and can be addressed at the implementer's discretion.

---

## 7. Checklist

| Check Item | Result | Notes |
|-----------|--------|-------|
| Direct change files identified | PASS | Single file: WorktreeDetailRefactored.tsx |
| Indirect positive impacts documented | PASS | MessageInput, PromptPanel, MobilePromptSheet |
| Indirect negative impacts assessed | PASS | SF-IMP-001 (fetchWorktree setError) identified |
| Test impact analyzed | PASS | TC-1 through TC-4 all continue to pass. New tests needed |
| API layer impact | PASS | No API changes. Existing endpoints used |
| Database impact | PASS | No database changes |
| Polling interaction analyzed | PASS | Concurrent fetch risk identified and assessed as safe |
| Cross-component impact | PASS | WorktreeList.tsx visibilitychange is independent |
| Security impact | PASS | No new attack surface |
| Rollback feasibility | PASS | Single function change, trivially revertible |
