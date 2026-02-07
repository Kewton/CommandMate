# Architecture Review: Issue #180 - Impact Analysis (Stage 3)

**Date**: 2026-02-07
**Issue**: #180 - Status Display Inconsistency Fix
**Review Type**: Impact Scope Analysis
**Reviewer**: architecture-review-agent
**Design Policy**: `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md`

---

## 1. Overall Assessment

**Result**: PASS WITH OBSERVATIONS

The impact scope analysis in the design policy document is accurate and thorough. The design correctly identifies 3 directly changed files and 1 test file. Files listed as "not changed" are confirmed to be truly unaffected. The API response format is preserved, ensuring no UI regressions. Seven observations were identified, with one elevated to must_fix severity for documentation completeness.

---

## 2. Verification of Directly Changed Files

### 2.1 `src/lib/status-detector.ts` -- Confirmed

The file currently exports `detectSessionStatus()` which already implements the correct 15-line windowing logic (line 76: `lines.slice(-STATUS_CHECK_LINE_COUNT)`). The proposed change adds `hasActivePrompt: boolean` to `StatusDetectionResult`. This is additive and backward compatible because:

- Only `status-detector.test.ts` reads `StatusDetectionResult` objects
- No external code constructs `StatusDetectionResult` objects
- Existing test assertions on `{status, confidence, reason}` will continue to pass

### 2.2 `src/app/api/worktrees/route.ts` -- Confirmed

Lines 56-99 contain the exact inline logic described in the design. Key observations:
- Line 62: `detectPrompt(cleanOutput)` passes the FULL cleaned output (the root cause bug)
- Line 67: Empty line filtering before 15-line extraction (behavior difference from status-detector.ts, documented as DR-003)
- Lines 86-95: Stale prompt cleanup logic that must be preserved in the refactored code
- Imports on lines 16-17 (`detectThinking`, `stripAnsi`, `getCliToolPatterns`, `detectPrompt`) will be replaced by `detectSessionStatus` import

### 2.3 `src/app/api/worktrees/[id]/route.ts` -- Confirmed

Lines 56-99 are near-identical to the route.ts above. Uses `params.id` instead of `worktree.id`. Same bug pattern, same refactoring target. The PATCH handler (lines 143-210) is unrelated and unaffected.

### 2.4 `src/lib/__tests__/status-detector.test.ts` -- Confirmed

Existing tests (19 test cases) validate `{status, confidence, reason}` fields. Adding `hasActivePrompt` will not break these tests. New test cases (8 items from Section 8-2) will strengthen coverage for Issue #180 scenarios.

---

## 3. Verification of Unchanged Files

### 3.1 `src/lib/prompt-detector.ts` -- Confirmed: No Change Needed

A generic prompt detection function. Not modified by this change. Has its own internal windowing: y/n patterns use last 10 lines (line 48), multiple choice uses last 50 lines (line 268). The design correctly identifies this as a shared utility that should not be modified.

### 3.2 `src/lib/response-poller.ts` -- Confirmed: No Change Needed

Calls `detectPrompt()` in three locations (lines 248, 442, 556) for response extraction purposes, not status display. These are different use cases. The design correctly excludes this file.

### 3.3 `src/lib/claude-poller.ts` -- Confirmed: No Change Needed (Legacy Module)

Contains `detectPrompt()` calls on lines 164 and 232. The `startPolling()` function (line 324) is exported but not imported anywhere in the codebase. Grep search confirmed zero callers. This is effectively dead/legacy code superseded by `response-poller.ts`. DR-008 follow-up recommendation is appropriate.

### 3.4 `src/lib/auto-yes-manager.ts` -- Confirmed: No Change Needed, but Vulnerability Noted

Line 290 calls `detectPrompt(cleanOutput)` with full cleaned output (up to 5000 lines from line 276). While the thinking skip on line 284 provides Layer 1 defense, this file has the same fundamental vulnerability as the route.ts files: historical prompts in the full output could cause false positives. See Finding IS-007 below.

### 3.5 `src/app/api/worktrees/[id]/current-output/route.ts` -- Confirmed: No Change Needed

Line 88 calls `detectPrompt(cleanOutput)` on full output but with a thinking-state guard. Uses a different status detection approach (direct flags like `isPromptWaiting`, `isGenerating`) rather than the route.ts inline logic. This file serves a different purpose (real-time output streaming for client-side auto-yes). See Finding IS-001.

### 3.6 `src/app/api/worktrees/[id]/prompt-response/route.ts` -- Confirmed: No Change Needed

Line 75 calls `detectPrompt(cleanOutput)` for race-condition prevention (re-verifying prompt before sending keys). This is a correctness safeguard, not a status detection concern. The full output is appropriate here because the check is "does a prompt exist anywhere in the current output?"

### 3.7 `src/types/sidebar.ts` -- Confirmed: No Change Needed

`deriveCliStatus()` (lines 30-38) consumes `{isWaitingForResponse, isProcessing, isRunning}` from API responses. Since the API response shape is unchanged, this function is unaffected.

---

## 4. Additional Files Not Listed in Design (All Unaffected)

The following downstream consumers were identified but are not listed in the design's Section 11. All are confirmed unaffected because the API response format is preserved:

| File | Relationship | Status |
|------|-------------|--------|
| `src/types/models.ts` (lines 69-76) | Defines `Worktree` interface with `isWaitingForResponse`/`isProcessing`/`sessionStatusByCli` | Unaffected |
| `src/components/worktree/WorktreeDetailRefactored.tsx` (lines 107-128) | Consumes `sessionStatusByCli` for CLI tab status dots | Unaffected |
| `src/components/worktree/WorktreeCard.tsx` (lines 31, 160-165) | Consumes `isWaitingForResponse` for badge display | Unaffected |
| `src/contexts/WorktreeSelectionContext.tsx` (line 55) | Uses `isProcessing`/`isWaitingForResponse` for polling interval | Unaffected |

---

## 5. API Response Format Verification

Both `route.ts` and `[id]/route.ts` return the same response shape before and after the change:

```typescript
{
  ...worktree,
  isSessionRunning: boolean,     // anyRunning (unchanged)
  isWaitingForResponse: boolean, // from statusResult.status === 'waiting' (same semantics)
  isProcessing: boolean,         // from statusResult.status === 'running' (same semantics)
  sessionStatusByCli: {          // per-CLI tool status (unchanged structure)
    claude?: { isRunning, isWaitingForResponse, isProcessing },
    codex?: { isRunning, isWaitingForResponse, isProcessing },
    gemini?: { isRunning, isWaitingForResponse, isProcessing },
  }
}
```

The mapping `statusResult.status === 'waiting' -> isWaitingForResponse = true` and `statusResult.status === 'running' -> isProcessing = true` preserves the existing semantics. When neither condition is true (status is 'ready' or 'idle'), both flags remain false, matching the current behavior when `hasInputPrompt` is true.

---

## 6. Findings

### IS-001 [nice_to_have] current-output/route.ts Has Similar Vulnerability

**Location**: `src/app/api/worktrees/[id]/current-output/route.ts:88`

The file passes full `cleanOutput` to `detectPrompt()`, the same pattern that causes the bug in route.ts. While the thinking skip guard (line 88) provides partial protection, this file should be listed as a follow-up candidate in Section 9.

**Recommendation**: Add to the future consideration list alongside `response-poller.ts`.

### IS-002 [nice_to_have] UI Component Chain Not Explicitly Listed

**Location**: Design Section 11

The design states "UI components: API response format unchanged" generically. Listing the specific components (`WorktreeDetailRefactored.tsx`, `WorktreeCard.tsx`, `WorktreeSelectionContext.tsx`, `sidebar.ts`) would demonstrate thorough verification.

**Recommendation**: Enumerate specific UI consumers in the impact section.

### IS-003 [should_fix] StatusDetectionResult Type Extension Backward Compatibility

**Location**: `src/lib/status-detector.ts:31-38`

Adding `hasActivePrompt: boolean` as a required field means any code constructing `StatusDetectionResult` must provide it. Code search confirms only `status-detector.ts` itself constructs these objects. The design should explicitly state this verification result.

**Recommendation**: Add a note in Section 9 or C-006 confirming that code search validated no external constructors of `StatusDetectionResult`.

### IS-004 [nice_to_have] response-poller.ts detectPrompt Usage Confirmed Correctly Excluded

**Location**: `src/lib/response-poller.ts:248,442,556`

Three `detectPrompt` calls in response-poller.ts serve response extraction, not status display. The design's analysis is correct. No action needed.

### IS-005 [nice_to_have] claude-poller.ts Legacy Status Confirmed

**Location**: `src/lib/claude-poller.ts:164,232`

`startPolling` has zero callers in the codebase. The module is effectively dead code. DR-008 follow-up is appropriate.

**Recommendation**: Consider adding a `@deprecated` JSDoc tag to `claude-poller.ts` exports.

### IS-006 [should_fix] Empty Line Filtering Behavior Change Needs Strong Test Coverage

**Location**: `src/lib/status-detector.ts:75-76`

The transition from empty-line-filtered windowing (route.ts) to raw windowing (status-detector.ts) could cause false negatives if tmux buffers have many trailing empty lines that push the actual prompt outside the 15-line window. The test case in Section 8-2 item 7 is critical.

**Recommendation**: Ensure the test case covers a scenario with 20+ trailing empty lines after a prompt character, verifying the prompt is still detected. If the prompt falls outside the 15-line window due to empty padding, consider either increasing STATUS_CHECK_LINE_COUNT or adding empty-line trimming to status-detector.ts.

### IS-007 [must_fix] auto-yes-manager.ts Shares Same Vulnerability -- Not Listed as Follow-Up

**Location**: `src/lib/auto-yes-manager.ts:290`

`pollAutoYes()` calls `detectPrompt(cleanOutput)` with the full cleaned output (up to 5000 lines). This is the same pattern causing the bug in route.ts. While the thinking skip (Layer 1, line 284) provides protection during active processing, when Claude is idle (not thinking) and the output contains a historical y/n prompt within the last 10 lines of a long buffer, auto-yes-manager could false-positive and send an unwanted "y" response.

The design's Section 9 "Future Considerations" only mentions `response-poller.ts` and `claude-poller.ts`. `auto-yes-manager.ts` is absent from this list despite having the same vulnerability.

**Recommendation**: Add `auto-yes-manager.ts` to the "Future Considerations" table in Section 9 with the note that its `detectPrompt(cleanOutput)` call on line 290 could false-positive on historical y/n prompts when thinking skip is not active. This is particularly important because auto-yes-manager automatically sends responses, making a false positive more impactful than in the status display case.

---

## 7. Risk Assessment

| Risk Factor | Level | Mitigation |
|-------------|-------|------------|
| Empty line filtering behavior change | MEDIUM | Test case 8-2 item 7 must cover trailing empty padding scenarios |
| StatusDetectionResult type extension | LOW | Additive change, no external constructors confirmed |
| Import refactoring in route.ts files | LOW | TypeScript compiler catches missing imports |
| Stale prompt cleanup logic preservation | LOW | Design clearly documents the hasActivePrompt mapping |
| Same vulnerability in auto-yes-manager.ts | LOW (for this issue) | Out of scope, but should be documented as follow-up |

**Overall Risk**: LOW

The change is well-scoped with minimal blast radius. The three directly changed files are correctly identified, and the replacement logic preserves API semantics.

---

## 8. Summary of Findings

| ID | Severity | Title |
|----|----------|-------|
| IS-001 | nice_to_have | current-output/route.ts has similar vulnerability |
| IS-002 | nice_to_have | UI component chain not explicitly listed |
| IS-003 | should_fix | StatusDetectionResult backward compatibility verification |
| IS-004 | nice_to_have | response-poller.ts correctly excluded (confirmed) |
| IS-005 | nice_to_have | claude-poller.ts legacy status confirmed |
| IS-006 | should_fix | Empty line filtering behavior change needs strong tests |
| IS-007 | must_fix | auto-yes-manager.ts shares same vulnerability, not listed as follow-up |

**Counts**: must_fix: 1, should_fix: 2, nice_to_have: 4

---

*Generated by architecture-review-agent for Issue #180, Stage 3 (Impact Analysis Review)*
