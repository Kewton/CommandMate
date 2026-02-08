# Issue #193 Stage 5 Review Report: General Review (2nd Iteration)

**Review Date**: 2026-02-08
**Focus**: Consistency & Correctness (2nd iteration)
**Stage**: 5 of multi-stage review pipeline
**Reviewer**: issue-review-agent

---

## Executive Summary

After two rounds of updates addressing Stage 1 (10 findings) and Stage 3 (10 findings), Issue #193 is now in a substantially improved state. **All 20 prior findings have been resolved.** This Stage 5 review identified 5 new findings (0 must_fix, 3 should_fix, 2 nice_to_have), all of which are minor consistency or completeness issues. The Issue is ready for implementation, with the caveat that the TUI vs text prerequisite confirmation will determine the final design path.

---

## Prior Findings Resolution Status

### Stage 1 Findings (All Resolved)

| ID | Severity | Status | Resolution |
|----|----------|--------|------------|
| S1-001 | must_fix | Resolved | All 9 detectPrompt() call sites listed with line numbers in root cause and impact tables |
| S1-002 | must_fix | Resolved | Prerequisites section added with 4 TUI vs text confirmation items |
| S1-003 | should_fix | Resolved | prompt-response/route.ts added to change targets and implementation tasks |
| S1-004 | should_fix | Resolved | auto-yes-manager.ts added to change targets and implementation tasks |
| S1-005 | should_fix | Resolved | response-poller.ts (with L248/L442/L556 distinction) and claude-poller.ts added |
| S1-006 | should_fix | Resolved | TUI alternative design path section with impact analysis added |
| S1-007 | should_fix | Resolved | Acceptance criteria include specific auto-yes behavior for default/first selection |
| S1-008 | nice_to_have | Resolved | status-detector.ts added with STATUS_CHECK_LINE_COUNT note |
| S1-009 | nice_to_have | Resolved | current-output/route.ts added to change targets |
| S1-010 | nice_to_have | Resolved | Plan B recommended with rationale and type definition example |

### Stage 3 Findings (All Resolved)

| ID | Severity | Status | Resolution |
|----|----------|--------|------------|
| S3-001 | must_fix | Resolved | claude-poller.ts added to change targets with Claude-only usage note |
| S3-002 | must_fix | Resolved | L248 (no change) vs L442/L556 (change needed) clearly distinguished |
| S3-003 | must_fix | Resolved | TUI-based alternative design path with detailed impact analysis added |
| S3-004 | should_fix | Resolved | Plan B explicitly recommended with rationale |
| S3-005 | should_fix | Resolved | respond/route.ts added to related components |
| S3-006 | should_fix | Resolved | isDefault confirmation point added to prerequisites and related components |
| S3-007 | should_fix | Resolved | STATUS_CHECK_LINE_COUNT note added to acceptance criteria |
| S3-008 | should_fix | Resolved | PromptPanel.tsx and MobilePromptSheet.tsx added to related components |
| S3-009 | nice_to_have | Resolved | Existing test file update table added |
| S3-010 | nice_to_have | Resolved | Call count corrected to 9 with full enumeration |

---

## New Findings (Stage 5)

### S5-001 [should_fix] - api-prompt-handling.test.ts does not reference detectPrompt and is unaffected by signature changes

**Category**: Correctness
**Affected Section**: Impact Scope > Existing Test File Updates

The "Existing Test File Updates (on signature change)" table lists `tests/integration/api-prompt-handling.test.ts` with the update reason "prompt processing integration test - confirm signature change impact." However, examining the actual test file code reveals that it tests `respond/route.ts` exclusively and does not import or mock `detectPrompt` at all. The `respond/route.ts` module only uses `getAnswerInput` from `prompt-detector.ts`, not `detectPrompt`. Since `getAnswerInput` is not being modified in this Issue, this test file will not be affected by the `detectPrompt` signature change.

**Recommendation**: Remove `tests/integration/api-prompt-handling.test.ts` from the existing test updates table, or revise the update reason to clarify that no direct signature impact is expected and that this is only a general operational verification target.

---

### S5-002 [should_fix] - Inconsistency between respond/route.ts import source and its test mock

**Category**: Consistency
**Affected Section**: Impact Scope > Related Components

The actual `respond/route.ts` code imports `startPolling` from `@/lib/response-poller` (L12) and calls `startPolling(params.id, cliToolId)` at L178. However, the integration test `api-prompt-handling.test.ts` mocks `@/lib/claude-poller` for `startPolling` (L54-57). This means the test may not accurately verify the behavior of the production code, which uses `response-poller.ts`. While this is outside the direct scope of Issue #193, it is a relevant observation for the operational verification phase since changes to `response-poller.ts` (which this Issue modifies) could affect `respond/route.ts` in ways not covered by the existing test.

**Recommendation**: Note this discrepancy as a known observation. If operational verification reveals issues, consider filing a separate issue to align the test mock with the actual import.

---

### S5-003 [should_fix] - Implementation task descriptions do not align with recommended Plan B (pattern parameterization)

**Category**: Completeness
**Affected Section**: Implementation Tasks

The Issue recommends Plan B (pattern parameterization with `DetectPromptOptions`) and provides a type definition example. However, the implementation task items for each calling file describe the change as "pass cliToolId to detectPrompt()" (e.g., "detectPrompt()にcliToolIdを渡す修正"). Under Plan B, the calling convention is different: each caller would obtain a pattern set from `cli-patterns.ts` based on `cliToolId` and pass it as an options object (`detectPrompt(output, { choiceIndicatorPattern, normalOptionPattern })`), rather than passing `cliToolId` directly. This discrepancy between the recommended design approach and the task descriptions could confuse the implementer about what the actual change at each call site looks like.

**Recommendation**: Either (A) update implementation task descriptions to align with Plan B (e.g., "obtain CLI-tool-specific pattern set and pass as options argument"), or (B) add a note that implementation tasks describe the conceptual change and that detailed calling convention will be determined during the design phase after prerequisite confirmation.

---

### S5-004 [nice_to_have] - Minor wording inconsistency between root cause annotations and impact scope table

**Category**: Clarity
**Affected Section**: Root Cause > Specific Problem Areas > 4

In the root cause section's call site list, item 5 (`response-poller.ts` L248) is annotated as `[Claude専用ガード内 - 変更不要の可能性]` ("possibility of no change needed"). The impact scope table for `response-poller.ts` states more definitively `L248はClaude専用ガード内のため変更不要` ("no change needed"). The "possibility" qualifier in the root cause list suggests uncertainty, while the impact table states it conclusively. This is a minor inconsistency.

**Recommendation**: Change the root cause annotation to `[Claude専用ガード内 - 変更不要]` (remove "の可能性") to match the impact scope table.

---

### S5-005 [nice_to_have] - useAutoYes.ts verification description lacks specificity

**Category**: Completeness
**Affected Section**: Impact Scope > Related Components

The related components section lists `useAutoYes.ts` with the description "Client-side Auto-Yes hook. Verify coordination with server-side polling." This is vague and does not specify what to verify. The key verification point is that when server-side polling (via `auto-yes-manager.ts`) already sends an auto-response for a Codex multiple-choice prompt, the client-side `useAutoYes.ts` hook (which consumes `isPromptWaiting` and `promptData` from `current-output` API) does not send a duplicate response. The `lastServerResponseTimestamp` mechanism is the primary duplicate prevention measure and should be explicitly called out as the verification target.

**Recommendation**: Expand the useAutoYes.ts description to: "Client-side Auto-Yes hook. Verify that when Codex multiple-choice prompts are detected (`isPromptWaiting=true` from current-output API), the `lastServerResponseTimestamp` duplicate prevention mechanism prevents client-side redundant responses."

---

## Technical Accuracy Verification

The following line number references in the updated Issue were verified against the actual source code. All references are accurate:

| File | Claimed Line | Actual Content | Status |
|------|-------------|----------------|--------|
| auto-yes-manager.ts L262 | pollAutoYes receives cliToolId | `async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType)` | Correct |
| auto-yes-manager.ts L284 | detectThinking(cliToolId) call | `if (detectThinking(cliToolId, cleanOutput))` | Correct |
| auto-yes-manager.ts L290 | detectPrompt(cleanOutput) call | `const promptDetection = detectPrompt(cleanOutput)` | Correct |
| status-detector.ts L87 | detectPrompt(lastLines) call | `const promptDetection = detectPrompt(lastLines)` | Correct |
| prompt-response/route.ts L50 | cliToolId obtained | `const cliToolId: CLIToolType = cliToolParam \|\| ...` | Correct |
| prompt-response/route.ts L75 | detectPrompt(cleanOutput) call | `const promptCheck = detectPrompt(cleanOutput)` | Correct |
| current-output/route.ts L88 | detectPrompt call | `const promptDetection = thinking ? ... : detectPrompt(cleanOutput)` | Correct |
| response-poller.ts L244 | Claude guard | `if (cliToolId === 'claude')` | Correct |
| response-poller.ts L248 | detectPrompt in Claude guard | `const promptDetection = detectPrompt(cleanFullOutput)` | Correct |
| response-poller.ts L442 | detectPrompt (all CLI tools) | `const promptDetection = detectPrompt(fullOutput)` | Correct |
| response-poller.ts L556 | detectPrompt (all CLI tools) | `const promptDetection = detectPrompt(result.response)` | Correct |
| claude-poller.ts L164 | detectPrompt call | `const promptDetection = detectPrompt(fullOutput)` | Correct |
| claude-poller.ts L232 | detectPrompt call | `const promptDetection = detectPrompt(result.response)` | Correct |
| respond/route.ts L82-113 | multiple_choice handling | Multiple choice validation block | Correct |
| respond/route.ts L149-156 | sendKeys logic | sendKeys calls | Correct |
| auto-yes-manager.test.ts L431 | detectPrompt mock | `const { detectPrompt } = await import(...)` | Correct |
| prompt-response-verification.test.ts L50 | detectPrompt mock | `detectPrompt: vi.fn().mockReturnValue(...)` | Correct |

---

## Overall Assessment

The Issue has reached a high quality level suitable for implementation. Key strengths of the updated Issue:

1. **Comprehensive call site analysis**: All 9 external `detectPrompt()` call sites are enumerated with precise line numbers and classification (Claude-only vs shared path).

2. **Dual design path documentation**: Both text-based (primary) and TUI-based (alternative) design paths are documented with respective impact analyses, enabling smooth transition after prerequisite confirmation.

3. **Clear design recommendation**: Plan B (pattern parameterization) is explicitly recommended with a concrete type definition example and rationale preserving `prompt-detector.ts` CLI-tool independence.

4. **Actionable acceptance criteria**: Each criterion is testable, including edge cases (7+ choices, STATUS_CHECK_LINE_COUNT limitation, default selection behavior).

5. **Test impact documentation**: Existing test files that mock `detectPrompt` are identified with specific line numbers.

The 3 should_fix findings are minor quality improvements. The most actionable is S5-003 (aligning implementation task descriptions with Plan B terminology), which would reduce implementer confusion. S5-001 removes an inaccurate test file reference. S5-002 is informational only and can be addressed in a separate issue.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| must_fix | 0 |
| should_fix | 3 |
| nice_to_have | 2 |
| **Total** | **5** |
