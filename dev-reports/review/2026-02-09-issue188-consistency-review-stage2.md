# Architecture Review: Issue #188 Stage 2 - Consistency Review

**Issue**: #188 - thinking indicator false detection (spinner remains after response completion)
**Focus**: Consistency between design specifications and current implementation
**Date**: 2026-02-09
**Reviewer**: Architecture Review Agent (Stage 2)
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

The design policy document for Issue #188 demonstrates strong consistency with the actual codebase. The core architectural decisions (DR-001 through DR-004) are well-grounded in the current implementation state, and the proposed modifications correctly identify the root cause of the thinking indicator false detection bug. The window size unification strategy (Section 3.2) is accurately documented with values that match the actual code. Related Issue cross-references (#161, #180, #191, #193) are generally accurate.

A few minor inconsistencies were found in code snippet line numbers and one medium-severity concern about the differing inputs to `detectPrompt()` between `detectSessionStatus()` (15-line window) and the DR-002 alternative approach (full output). These do not block implementation but should be addressed for documentation accuracy.

---

## Detailed Consistency Analysis

### 1. DR-001: detectSessionStatus() Shared Usage

| Design Spec | Actual Implementation | Verdict |
|-------------|----------------------|---------|
| `worktrees/route.ts` already uses `detectSessionStatus()` (Issue #180) | `src/app/api/worktrees/route.ts` L58: `const statusResult = detectSessionStatus(output, cliToolId)` | MATCH |
| `worktrees/[id]/route.ts` already uses `detectSessionStatus()` | `src/app/api/worktrees/[id]/route.ts` L58: `const statusResult = detectSessionStatus(output, cliToolId)` | MATCH |
| `current-output/route.ts` uses inline thinking/prompt logic | L72-94: `detectThinkingState()` + conditional `detectPrompt()` | MATCH |

The design document's claim that `current-output/route.ts` is the only remaining route with inline logic while `worktrees/route.ts` has been migrated is fully verified.

### 2. DR-003: Window Size Constants

| Constant | Design Spec | Actual Code | Location | Verdict |
|----------|-------------|-------------|----------|---------|
| STATUS_CHECK_LINE_COUNT | 15 | 15 | `status-detector.ts` L50 | MATCH |
| THINKING_CHECK_LINE_COUNT | 50 | 50 | `auto-yes-manager.ts` L79 | MATCH |
| Multiple choice scan window | 50 | `Math.max(0, lines.length - 50)` | `prompt-detector.ts` L297 | MATCH |
| Response completion check | 20 | 20 | `response-poller.ts` L236 | MATCH |
| STATUS_THINKING_LINE_COUNT (new) | 5 | N/A (to be added) | `status-detector.ts` (proposed) | N/A |

All existing window size values in the design document are accurate. The new STATUS_THINKING_LINE_COUNT = 5 is a proposed addition.

### 3. DR-004: response-poller.ts Full-Text Thinking Check

| Design Spec | Actual Code | Verdict |
|-------------|-------------|---------|
| L353: `thinkingPattern.test(response)` checks full response | L353: `if (thinkingPattern.test(response))` | MATCH |
| Returns `{ response: '', isComplete: false, lineCount: totalLines }` | L354-358: Exact match | MATCH |

### 4. current-output/route.ts Pre-Modification State

| Design Spec | Actual Code | Verdict |
|-------------|-------------|---------|
| Non-empty line filtering: `lines.map(l => stripAnsi(l)).filter(...)` | L73: Exact match | MATCH |
| 15-line window on non-empty lines: `nonEmptyLines.slice(-15)` | L74: Exact match | MATCH |
| Thinking detection: `detectThinkingState(cliToolId, lastSection)` | L83: Exact match | MATCH |
| Conditional prompt detection: `thinking ? { isPrompt: false } : detectPrompt(cleanOutput, promptOptions)` | L90: Exact match | MATCH |
| Import: `detectThinking as detectThinkingState` from cli-patterns | L13: Exact match | MATCH |

### 5. Related Issue Cross-References

#### Issue #161 (Auto-Yes False Positive Prevention)

| Defense Layer | Design Spec | Actual Code | Verdict |
|---------------|-------------|-------------|---------|
| Layer 1: Thinking check in caller | Maintained via `detectSessionStatus()` priority | `auto-yes-manager.ts` L310-313: `detectThinking()` before `detectPrompt()` | MATCH |
| Layer 2: 2-pass cursor detection | `prompt-detector.ts` unchanged | L304-320: Pass 1 cursor check | MATCH |
| Layer 3: Consecutive number validation | `prompt-detector.ts` unchanged | L366-373: `isConsecutiveFromOne()` | MATCH |

#### Issue #180 (Status Display Inconsistency)

| Item | Design Spec | Actual Code | Verdict |
|------|-------------|-------------|---------|
| `StatusDetectionResult` interface | `hasActivePrompt: boolean` field exists | L31-44: Interface with `hasActivePrompt` | MATCH |
| Priority order: prompt > thinking > input prompt | Documented in Section 2.2 | L85-107: Correct order | MATCH |
| Raw tmux output input contract | `detectSessionStatus()` handles stripAnsi internally | L81: `const cleanOutput = stripAnsi(output)` | MATCH |

#### Issue #191 (Auto-Yes Thinking Windowing)

| Item | Design Spec | Actual Code | Verdict |
|------|-------------|-------------|---------|
| THINKING_CHECK_LINE_COUNT = 50 | Unchanged | L79: `export const THINKING_CHECK_LINE_COUNT = 50` | MATCH |
| Windowing in pollAutoYes() | Unchanged | L310: `cleanOutput.split('\n').slice(-THINKING_CHECK_LINE_COUNT)` | MATCH |
| SF-001 cross-reference test | Referenced in design doc | L76-77: Comment references SF-001 | MATCH |

#### Issue #193 (Multiple Choice Prompt Detection)

| Item | Design Spec | Actual Code | Verdict |
|------|-------------|-------------|---------|
| DetectPromptOptions interface | Unchanged | `prompt-detector.ts` L23-35 | MATCH |
| buildDetectPromptOptions() | Unchanged | `cli-patterns.ts` L204-211 | MATCH |
| Layer 5 SEC-001 guard | Unchanged | `prompt-detector.ts` L389-394 | MATCH |
| requireDefaultIndicator for Claude = false | Unchanged | `cli-patterns.ts` L208 | MATCH |

### 6. Unchanged Files Verification

| File | Design Spec | Verification | Verdict |
|------|-------------|-------------|---------|
| `auto-yes-manager.ts` | No changes | THINKING_CHECK_LINE_COUNT=50, pollAutoYes() windowing intact | MATCH |
| `prompt-detector.ts` | No changes | CLI-tool-independent design maintained, all layers intact | MATCH |
| `cli-patterns.ts` | No changes | detectThinking(), buildDetectPromptOptions() intact | MATCH |
| `worktrees/route.ts` | No changes | Already uses detectSessionStatus() | MATCH |

---

## Findings

### Must Fix (1 item)

#### MF-001: Design Document Code Snippet Line Number Range (Low Severity)

**Location**: Design policy Section 4.1.1

The design document labels the pre-modification code block as "L72-94" for `current-output/route.ts`. While the code content in the snippet is accurate, the line range is somewhat approximate. The actual code spans L72 (comment) through L94 (`const isPromptWaiting`), making the range technically correct but could be more precise in delimiting the exact modified lines vs. surrounding context.

**Recommendation**: Verify line numbers at implementation time and adjust if the file has been modified since the design was written.

### Should Fix (4 items)

#### SF-001: status-detector.ts Line Number Annotations (Low Severity)

**Location**: Design policy Section 4.1.2

The design document references "L82-107" for the `detectSessionStatus()` modifications, but the actual function body spans L75-143. The specific modifications target L83 (lastLines generation) and L100 (detectThinking call). The range "L82-107" overstates the scope. This does not affect implementation correctness but could mislead during code review.

**Recommendation**: Narrow the line range to the specific modification targets (L83, L100).

#### SF-002: response-poller.ts Line Number Off-by-One (Low Severity)

**Location**: Design policy Section 4.2.1

The design document references "L351-359" for the thinking check block. The actual code: L351 is a comment line (`// Additional check: ...`), L352 is another comment, and the actual `if (thinkingPattern.test(response))` is at L353. The block runs L351-358 (comment through closing brace). This is a minor off-by-one but demonstrates that line numbers may shift between writing and review.

**Recommendation**: Treat line numbers as approximate references and verify at implementation time.

#### SF-003: Incomplete Description of stripAnsi Flow in Pre-Modification Diagram (Low Severity)

**Location**: Design policy Section 2.1

The pre-modification flow diagram for `current-output/route.ts` summarizes step 1 as "non-empty 15 line retrieval" but omits the `stripAnsi()` application that occurs as part of the non-empty line filtering (`lines.map(l => stripAnsi(l)).filter(...)`). Section 4.2.2 correctly identifies this for removal, but the flow diagram should reflect the full processing chain for accuracy.

**Recommendation**: Update the flow diagram to include the stripAnsi step in the pre-modification flow.

#### SF-004: detectPrompt() Input Difference Between detectSessionStatus() and DR-002 Alternative (Medium Severity)

**Location**: Design policy Section 3.1 DR-002 alternative

The design document's DR-002 alternative approach shows `detectPrompt(cleanOutput, promptOptions)` in `current-output/route.ts`, passing the full cleaned output. However, inside `detectSessionStatus()`, `detectPrompt()` receives `lastLines` (a 15-line window). This creates a situation where:
- `detectSessionStatus()` checks prompts in 15 lines (for status determination)
- The DR-002 alternative re-checks prompts in the full output (for promptData extraction)

Since `detectPrompt()` internally applies its own 50-line window for multiple choice detection and 10-line window for y/n patterns, the practical difference is that `detectSessionStatus()`'s 15-line input truncates the 50-line multiple choice scan in `detectMultipleChoicePrompt()`. The DR-002 re-execution with full output would have access to the full 50 lines.

This means there could be edge cases where `detectSessionStatus()` reports `hasActivePrompt: false` (because the 15-line window missed a multiple choice prompt), but the DR-002 `detectPrompt(cleanOutput)` detects it. The `isPromptWaiting` field would use `statusResult.hasActivePrompt` (false), while `promptDetection.isPrompt` would be true.

**Recommendation**: Document this potential edge case in the design document. Consider whether `current-output/route.ts` should use `promptDetection.isPrompt` instead of `statusResult.hasActivePrompt` for the `isPromptWaiting` field, or increase the `STATUS_CHECK_LINE_COUNT` to match the 50-line multiple choice window.

### Consider (3 items)

#### C-001: Additional Full-Text Thinking Check in checkForResponse()

`response-poller.ts` L547-554 contains another `thinkingPattern.test(cleanOutput)` full-text check within `checkForResponse()`, used for marking pending prompts as answered. The design document's "6 locations with inconsistent thinking detection" (P1 problem statement) should enumerate this location explicitly. Its purpose is different from L353 (it does not block response extraction but triggers prompt cleanup), so it may not need windowing, but the design should clarify this decision.

#### C-002: Issue #180 Design Document Cross-Update

The proposed modification to `status-detector.ts` (splitting the 15-line window into 15-line + 5-line) changes the internal architecture established by Issue #180. While this is an evolution rather than a contradiction, the design document's Section 11 (Related Issue Consistency) should note that Issue #180's design assumptions about a single window are being updated.

#### C-003: Section 5.1 Terminology Ambiguity

Section 5.1's table describes the Issue #161 Layer 1 maintenance as "thinking priority = only when prompt not detected," but this phrasing is inverted. The actual priority is "prompt detection is highest priority; thinking is checked only when no prompt is detected." Section 2.2's flow diagram correctly shows this. The table wording could be clearer.

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Low | All proposed changes target well-understood code paths. Window size values are accurately documented and the modification scope is limited. |
| Security | Low | Existing security measures (Issue #161 Layer 1-3, Issue #193 Layer 5 SEC-001) are explicitly preserved. No new attack surface introduced. |
| Operational | Low | Changes affect status display logic only. Failure mode (spinner persists) is the current bug behavior, not a regression. |

---

## Window Size Summary Table

| Detection Purpose | File | Constant | Current Value | Proposed Change |
|-------------------|------|----------|---------------|-----------------|
| Thinking detection (status) | status-detector.ts | STATUS_CHECK_LINE_COUNT (shared) | 15 | NEW: STATUS_THINKING_LINE_COUNT = 5 |
| Prompt detection (status) | status-detector.ts | STATUS_CHECK_LINE_COUNT | 15 | No change |
| Thinking detection (auto-yes) | auto-yes-manager.ts | THINKING_CHECK_LINE_COUNT | 50 | No change |
| Multiple choice scan | prompt-detector.ts | (inline) | 50 | No change |
| Response completion | response-poller.ts | checkLineCount | 20 | No change |
| Thinking check (response) | response-poller.ts | (inline) | Full text | Tail 5 lines |

---

## Approval Status

**Conditionally Approved** (Score: 4/5)

The design policy document demonstrates strong consistency with the existing codebase. The architectural decisions are well-reasoned and the modification targets are accurately identified. The conditions for full approval are:

1. Address SF-004 (document the detectPrompt() input difference between detectSessionStatus() and DR-002 alternative, or adjust the implementation to avoid the potential edge case)
2. Minor line number corrections can be deferred to implementation time

All other findings are informational or low-severity documentation improvements that do not block implementation.

---

*Generated by Architecture Review Agent (Stage 2: Consistency Review)*
*Review Date: 2026-02-09*
