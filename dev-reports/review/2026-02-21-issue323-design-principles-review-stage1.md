# Architecture Review: Issue #323 - auto-yes-manager.ts pollAutoYes() Refactoring

## Review Metadata

| Item | Value |
|------|-------|
| Issue | #323 |
| Stage | 1 - Design Principles Review |
| Date | 2026-02-21 |
| Status | Conditionally Approved |
| Score | 4/5 |
| Focus | SRP, DRY, KISS, YAGNI, Design Quality |

---

## Executive Summary

The design policy document for Issue #323 proposes a well-structured refactoring of the `pollAutoYes()` function from 139 lines with 7 responsibilities and 14 conditional branches into 4 named functions plus a ~30-line orchestrator. The design adheres well to SRP, DRY, KISS, and YAGNI principles. The choice of function-based approach (Option B) over class-based (Option A) aligns with the existing codebase patterns. No must-fix findings were identified. Three should-fix items relate to documentation consistency and naming clarity. Four nice-to-have items address minor design refinements.

---

## Detailed Findings

### DR001 [should_fix] - SRP: detectAndRespondToPrompt() cooldown scheduling responsibility mismatch

**Category**: SRP (Single Responsibility Principle)

**Target**: Design Policy Section 3-4 / Issue body

**Description**:

There is an inconsistency between Section 3-4 and Section 3-5. Section 3-4's step description and the Issue body text state that `detectAndRespondToPrompt()` includes cooldown scheduling as part of its responsibility. However, in the refactored `pollAutoYes()` code in Section 3-5, `scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS)` is called at the orchestrator level (line 257), not inside `detectAndRespondToPrompt()`.

Scheduling decisions (normal interval vs. cooldown interval) belong to the orchestrator, not to a function whose responsibility is prompt detection and response. Including scheduling inside `detectAndRespondToPrompt()` would violate SRP by mixing I/O response logic with polling control logic.

**Current inconsistency in Section 3-4**:

> Processing Steps: ... 7. `pollerState.lastAnsweredPromptKey = promptKey` -> `'responded'`

vs. Issue body:

> "cooldown scheduling" listed as part of the responsibility

vs. Section 3-5 code:

```typescript
const result = await detectAndRespondToPrompt(worktreeId, pollerState!, cliToolId, cleanOutput);
if (result === 'responded') {
  scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS);  // <-- orchestrator handles this
  return;
}
```

**Suggestion**: Remove cooldown scheduling from `detectAndRespondToPrompt()`'s responsibility description in Section 3-4 and the Issue body. The Section 3-5 code example already follows the correct pattern where the orchestrator handles scheduling based on the return value.

---

### DR002 [should_fix] - Function Design: validatePollingContext() has side effects despite "validate" naming

**Category**: Function Design

**Target**: Design Policy Section 3-1

**Description**:

Section 3-1 states that when `autoYesState` is invalid or expired, `validatePollingContext()` calls `stopAutoYesPolling()`. The "validate" prefix conventionally implies a pure validation function without side effects. A validate function that stops polling introduces several issues:

1. **Naming mismatch**: "validate" suggests read-only inspection, but the function modifies external state
2. **Testing complexity**: Tests for `validatePollingContext()` must account for or mock `stopAutoYesPolling()` side effects
3. **Responsibility overlap**: `getAutoYesState()` already handles expiration (auto-disabling expired states via `disableAutoYes()`). Adding `stopAutoYesPolling()` inside `validatePollingContext()` creates a secondary location for cleanup logic

In the current `pollAutoYes()` implementation (L461-464), the flow is:
```typescript
const autoYesState = getAutoYesState(worktreeId);  // auto-disables if expired
if (!autoYesState?.enabled || isAutoYesExpired(autoYesState)) {
  stopAutoYesPolling(worktreeId);  // <-- side effect in caller
  return;
}
```

**Suggestion**: Two options:
- **(A) Pure validation (recommended)**: `validatePollingContext()` returns the validation result without side effects. `pollAutoYes()` calls `stopAutoYesPolling()` when the result is `'expired'`. This aligns with the timer-independent testing goal.
- **(B) Rename**: Change to `ensurePollingContext()` or `checkAndCleanupPollingContext()` to signal side effects in the name.

---

### DR003 [should_fix] - DRY: getPollerState() wrapper has limited value and YAGNI-borderline justification

**Category**: DRY / YAGNI

**Target**: Design Policy Section 4

**Description**:

The proposed `getPollerState()` is a single-line wrapper:

```typescript
function getPollerState(worktreeId: string): AutoYesPollerState | undefined {
  return autoYesPollerStates.get(worktreeId);
}
```

The design justification includes "future log/validation additions" which is a YAGNI-borderline argument. Unlike `getAutoYesState()` which contains meaningful logic (expiration check + auto-disable), `getPollerState()` adds no logic and only introduces one level of indirection.

For the 6 call sites, replacing `autoYesPollerStates.get(worktreeId)` with `getPollerState(worktreeId)` provides:
- Marginal DRY improvement (same operation, different syntax)
- No logic centralization (pure delegation)
- One additional function to navigate when reading code

**Suggestion**: If introducing `getPollerState()`, revise the justification in Section 4 to focus on consistency with the existing `getAutoYesState()` pattern rather than future speculation. Alternatively, keep the direct `Map.get()` calls and document the decision to not abstract, since the Map is private to the module and all callers are in the same file.

---

### DR004 [nice_to_have] - Function Design: processStopConditionDelta() mutation pattern needs concrete precedent references

**Category**: Function Design

**Target**: Design Policy Section 3-3 / Section 9

**Description**:

Section 9's tradeoff table states "existing code pattern maintained" for the mutation approach, but does not specify which existing functions use this pattern. Providing concrete references strengthens the design decision.

Existing mutation-pattern functions in the same module:
- `updateLastServerResponseTimestamp()` (L317-322): mutates `pollerState.lastServerResponseTimestamp`
- `resetErrorCount()` (L329-335): mutates `pollerState.consecutiveErrors` and `pollerState.currentInterval`
- `incrementErrorCount()` (L342-348): mutates `pollerState.consecutiveErrors` and `pollerState.currentInterval`

**Suggestion**: Add these specific function references to Section 9's tradeoff entry or Section 3-3's design rationale.

---

### DR005 [nice_to_have] - Readability: Non-null assertion (!) in refactored pollAutoYes()

**Category**: Readability

**Target**: Design Policy Section 3-5

**Description**:

The refactored `pollAutoYes()` uses `pollerState!` at lines 250 and 255. While logically safe after `validatePollingContext()` returns `'valid'`, the TypeScript compiler cannot verify this. Each `!` assertion is a reviewer burden point.

**Suggestion**: Consider a discriminated union return type for `validatePollingContext()`:

```typescript
type ValidationResult =
  | { status: 'valid'; pollerState: AutoYesPollerState }
  | { status: 'stopped' | 'expired' };
```

This eliminates `!` through type narrowing. However, this increases the function's complexity, so the current approach with `!` and a code comment is also acceptable. Decide at implementation time.

---

### DR006 [nice_to_have] - KISS: detectAndRespondToPrompt() returns 5 variants but caller uses only 1

**Category**: KISS

**Target**: Design Policy Section 3-4

**Description**:

`detectAndRespondToPrompt()` returns `'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'`. In the refactored `pollAutoYes()`, only `'responded'` is checked:

```typescript
const result = await detectAndRespondToPrompt(...);
if (result === 'responded') {
  scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS);
  return;
}
```

The remaining 4 variants all fall through to `scheduleNextPoll(worktreeId, cliToolId)`. From the caller's perspective, `'responded' | 'not_responded'` would suffice.

**Suggestion**: The 5-variant design is justified for test purposes (each case can be individually asserted). Add a note to Section 3-4's design rationale: "The detailed return variants serve testing purposes; the orchestrator only distinguishes 'responded' from all other outcomes."

---

### DR007 [nice_to_have] - YAGNI: captureAndCleanOutput() extracts only 2 lines of logic

**Category**: YAGNI

**Target**: Design Policy Section 3-2

**Description**:

`captureAndCleanOutput()` wraps exactly 2 lines:

```typescript
const output = await captureSessionOutput(worktreeId, cliToolId, 5000);
const cleanOutput = stripAnsi(output);
```

This is the thinnest of the 4 extracted functions. Its individual value is limited -- tests would still need to mock `captureSessionOutput` regardless.

**Suggestion**: The extraction is justified as part of the consistent naming strategy (each step in the orchestrator maps to a named function). Document this rationale in Section 3-2: "While the function body is minimal, naming this step supports the orchestrator's readability goal where each call reads as a self-documenting step."

---

## Design Principles Evaluation

### SRP (Single Responsibility Principle)

| Function | Responsibility | SRP Compliance |
|----------|---------------|----------------|
| `validatePollingContext()` | Polling precondition check | Good (with DR002 caveat on side effects) |
| `captureAndCleanOutput()` | Output capture + ANSI cleaning | Good |
| `processStopConditionDelta()` | Delta-based stop condition | Good |
| `detectAndRespondToPrompt()` | Prompt detection + response | Acceptable (55 lines, high cohesion) |
| `pollAutoYes()` (refactored) | Orchestration only | Excellent |

Assessment: The 55-line `detectAndRespondToPrompt()` exceeds the 20-40 line target but is justified by the high cohesion of the prompt-detect-respond flow. Splitting it further would require passing intermediate state between functions, increasing complexity.

### DRY (No Duplication)

The `getPollerState()` helper addresses 6 call sites of `autoYesPollerStates.get()`. While the duplication is real, the abstraction adds minimal value since it is a pure delegation (see DR003). The overall DRY improvement from the refactoring is moderate.

### KISS (Keep It Simple)

The function-based approach (Option B) is the simplest design for this codebase. The class-based alternative (Option A) would introduce unnecessary complexity. The 5-variant return type of `detectAndRespondToPrompt()` is slightly over-engineered for the caller but serves testing (see DR006).

### YAGNI (You Aren't Gonna Need It)

The design does not introduce unnecessary future-proofing. All 4 extracted functions serve the immediate goal of testability improvement. The `getPollerState()` justification references future needs (DR003), which should be rephrased.

### @internal export Pattern Consistency

The proposed `@internal export` for 4 new functions aligns with existing patterns:
- `checkStopCondition()` in the same file (L409)
- `executeRegexWithTimeout()` in the same file (L384)
- `clearAllAutoYesStates()` in the same file (L272)
- `clearAllPollerStates()` in the same file (L294)
- `HealthCheckResult` / `isSessionHealthy()` in `claude-session.ts`
- `resolveExtractionStartIndex()` in `response-poller.ts`

The `getPollerState()` is correctly kept private (not exported) since it is an internal helper.

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | Refactoring introduces subtle behavioral differences | Low | Low | P3 |
| Technical | Existing timer-based tests become brittle with function extraction | Low | Low | P3 |
| Security | No security-relevant changes (validation, safe-regex unchanged) | None | None | N/A |
| Operational | No operational changes (polling behavior, intervals unchanged) | None | None | N/A |

The refactoring is purely structural with explicit "no functional changes" constraint. Existing integration tests serve as a regression safety net. The risk profile is very low.

---

## Recommendations Summary

### Should Fix (3 items)

1. **DR001**: Clarify `detectAndRespondToPrompt()` responsibility to exclude cooldown scheduling (documentation fix)
2. **DR002**: Address `validatePollingContext()` side effects -- either remove them or rename the function
3. **DR003**: Revise `getPollerState()` justification to avoid YAGNI-borderline "future needs" argument

### Nice to Have (4 items)

4. **DR004**: Add concrete mutation-pattern precedent references to Section 3-3/9
5. **DR005**: Consider discriminated union return for eliminating `pollerState!` assertions
6. **DR006**: Document that 5-variant return type serves testing, not caller needs
7. **DR007**: Document `captureAndCleanOutput()` extraction rationale as consistency-driven

---

*Generated by architecture-review-agent for Issue #323 Stage 1*
*Date: 2026-02-21*
