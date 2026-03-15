# Architecture Review: Issue #499 Auto-Yes Polling Performance - Stage 2 (Consistency)

**Issue**: #499
**Stage**: 2 - Consistency Review
**Focus**: Design Policy Document vs Actual Codebase
**Date**: 2026-03-16
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

The design policy document for Issue #499 is largely accurate and well-referenced. Line numbers, function signatures, and architectural descriptions match the actual codebase in the majority of cases (12 out of 14 checked items). Two must-fix inconsistencies were found: the `incrementErrorCount` function signature mismatch and the `scheduleNextPoll` overrideInterval parameter already existing in code despite being described as a new addition. Several should-fix items relate to the design document not clearly distinguishing between current state and proposed changes.

---

## Detailed Findings

### Must Fix (2 items)

#### IC-001: incrementErrorCount Function Signature Mismatch

**Design Document Claim** (Section 3, Item 5):
```typescript
function incrementErrorCount(worktreeId: string, pollerState: PollerState): void {
  pollerState.consecutiveErrors++;
  pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);
  if (pollerState.consecutiveErrors >= AUTO_STOP_ERROR_THRESHOLD) {
    disableAutoYes(worktreeId, 'consecutive_errors');
    stopAutoYesPolling(worktreeId);
  }
}
```

**Actual Code** (auto-yes-poller.ts L161-167):
```typescript
function incrementErrorCount(worktreeId: string): void {
  const pollerState = getPollerState(worktreeId);
  if (pollerState) {
    pollerState.consecutiveErrors++;
    pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);
  }
}
```

The actual function takes only `worktreeId` (1 parameter) and internally calls `getPollerState()`. The design document shows a 2-parameter signature that does not match current code. Implementing the design as-written would change the function's calling convention without acknowledgment.

**Recommendation**: Update the design document code example to use the actual 1-parameter signature, or explicitly note that this is a signature change and explain why `pollerState` is being added as a parameter.

---

#### IC-002: scheduleNextPoll overrideInterval Already Exists

**Design Document Claim** (Section 3, Item 2):
```
// Current: scheduleNextPoll(worktreeId, cliToolId)
// Change: scheduleNextPoll(worktreeId, cliToolId, overrideInterval?: number)
```

**Actual Code** (auto-yes-poller.ts L441-444):
```typescript
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  overrideInterval?: number
): void {
```

The `overrideInterval` parameter already exists and is actively used (L420: `scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS)`). The design document incorrectly presents this as a new addition. The actual change needed for Item 2 is simply adding a call at L407 with `THINKING_POLLING_INTERVAL_MS` -- no signature change is required.

**Recommendation**: Correct the design document to state that `overrideInterval` is already supported, and that Item 2's change is adding `THINKING_POLLING_INTERVAL_MS` to the Thinking detection branch call only.

---

### Should Fix (3 items)

#### IC-003: AutoYesStopReason Type Change Not Clearly Marked as Addition

The design document shows `AutoYesStopReason = 'expired' | 'stop_pattern_matched' | 'consecutive_errors'` without distinguishing that `'consecutive_errors'` is a new value to be added. The current code (auto-yes-config.ts L43) only defines `'expired' | 'stop_pattern_matched'`.

**Recommendation**: Use a diff-style notation or explicit comment indicating which values are existing vs new.

---

#### IC-004: WorktreeDetailRefactored State Variable Name/Type Discrepancy

The design document proposes:
```typescript
const [pendingStopReason, setPendingStopReason] = useState<AutoYesStopReason | null>(null);
```

The actual code uses:
```typescript
const [stopReasonPending, setStopReasonPending] = useState(false);
```

The design document does not acknowledge the existing variable name (`stopReasonPending`) or its current type (`boolean`). This creates ambiguity about whether this is a rename + type change or a new variable.

**Recommendation**: Document the before/after explicitly, noting both the rename and the type change.

---

#### IC-005: THINKING_CHECK_LINE_COUNT Location vs Architecture Diagram

The architecture layer diagram places constants in the "Config Layer" with `auto-yes-config.ts`, but `THINKING_CHECK_LINE_COUNT` is actually defined and exported from `auto-yes-state.ts` (L345), which is in the "State Management Layer".

**Recommendation**: Add a note to the layer diagram or Item 2 section clarifying where each constant resides.

---

### Consider (2 items)

#### IC-006: pollerState Reference Pattern Inconsistency

The design document inconsistently refers to `pollerState` as both a function parameter (Item 5 `incrementErrorCount` example) and an internally-fetched value (actual code pattern). In the actual codebase, `detectAndRespondToPrompt` receives `pollerState` as a parameter (L309-314), while `incrementErrorCount` fetches it internally via `getPollerState()` (L162). Design changes should be aware of this dual pattern.

---

#### IC-007: Polling Flow Diagram Simplification

The design document's polling flow diagram shows `scheduleNextPoll()` at the end only, but the actual code has three `scheduleNextPoll` call sites: L407 (Thinking detected), L420 (responded with cooldown), and L432 (default/error fallthrough). The simplified diagram may lead to incorrect assumptions about control flow.

---

## Consistency Verification Matrix

| Item | Design Claim | Actual Code | Match |
|------|-------------|-------------|-------|
| Item 1: stripBoxDrawing at L318 | detectPrompt(stripBoxDrawing(cleanOutput), ...) | L318: Confirmed identical | Yes |
| Item 1: strip at L244 | captureAndCleanOutput strips at L244 | L244: stripBoxDrawing(stripAnsi(output)) | Yes |
| Item 2: scheduleNextPoll signature | Needs overrideInterval addition | L441-444: Already has overrideInterval | **No** |
| Item 3: Capture 5000 lines | captureSessionOutput 5000 | L243: Confirmed | Yes |
| Item 4: DetectPromptOptions | requireDefaultIndicator exists | L37-49: Confirmed | Yes |
| Item 4: detectPrompt signature | (output, options?) | L184: Confirmed | Yes |
| Item 4: L747 split | detectMultipleChoicePrompt splits at L747 | L747: Confirmed | Yes |
| Item 5: AutoYesStopReason | 3 values (with consecutive_errors) | L43: 2 values only | Partial |
| Item 5: incrementErrorCount sig | (worktreeId, pollerState) | L161: (worktreeId) only | **No** |
| Item 5: catch blocks L368, L423 | Two catch blocks call incrementErrorCount | L368-374, L423-428: Confirmed | Yes |
| Item 6: CACHE_TTL_MS L39 | 2000ms | L39: Confirmed | Yes |
| Item 7: validatePollingContext L217 | isAutoYesExpired check present | L217: Confirmed | Yes |
| Item 5-UI: stopReason at L391 | stop_pattern_matched only | L391: Confirmed | Yes |
| globalThis pattern | Maintained per Issue #153 | L73-80, L51-58: Confirmed | Yes |

**Match Rate**: 12/14 full match (86%), 1 partial, 1 mismatch on two items

---

## Risk Assessment

| Risk Type | Level | Notes |
|-----------|-------|-------|
| Technical | Low | Inconsistencies are in documentation, not implementation logic |
| Security | Low | No security-related claims were found to be inaccurate |
| Operational | Low | Design changes are well-scoped; doc corrections are straightforward |

---

## Approval Status

**Conditionally Approved** -- The design policy document is fundamentally sound and the proposed architecture is consistent with the existing codebase. The two must-fix items are documentation accuracy issues that should be corrected before implementation begins, to prevent developers from making incorrect assumptions about existing signatures and available features.

---

*Generated by architecture-review-agent (Stage 2: Consistency Review) for Issue #499*
