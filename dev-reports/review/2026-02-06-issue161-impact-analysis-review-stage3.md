# Architecture Review: Issue #161 Auto-Yes False Positive Fix - Stage 3 Impact Analysis

**Date**: 2026-02-06
**Issue**: #161 - Auto-Yes Multiple Choice Prompt False Positive
**Stage**: 3 - Impact Analysis (影響範囲)
**Reviewer**: Architecture Review Agent

---

## 1. Review Scope

This review analyzes the ripple effects, edge cases, race conditions, backward compatibility, user experience impact, and external dependencies of the proposed changes in the Issue #161 design policy document.

### Files Analyzed

**Direct change targets**:
- `src/lib/prompt-detector.ts` - Core detection logic (2-pass method, consecutive validation)
- `src/lib/auto-yes-manager.ts` - Thinking guard addition
- `src/lib/status-detector.ts` - Conditional execution order fix

**Callers of detectPrompt() (impact propagation)**:
- `src/lib/response-poller.ts` - Multiple call sites (L248, L556)
- `src/lib/claude-poller.ts` - Single call site with local thinkingPattern
- `src/app/api/worktrees/route.ts` - Sidebar status detection
- `src/app/api/worktrees/[id]/route.ts` - Worktree detail status
- `src/app/api/worktrees/[id]/current-output/route.ts` - Real-time output with prompt detection

**Client-side consumers**:
- `src/hooks/useAutoYes.ts` - Client-side auto-response with deduplication
- `src/components/worktree/PromptPanel.tsx` - Prompt UI rendering
- `src/components/mobile/MobilePromptSheet.tsx` - Mobile prompt UI
- `src/components/worktree/PromptMessage.tsx` - Prompt message display

**Shared pattern modules**:
- `src/lib/cli-patterns.ts` - Thinking patterns, prompt patterns
- `src/lib/auto-yes-resolver.ts` - Auto-answer resolution logic

---

## 2. Findings Summary

| Severity | Count | Description |
|----------|-------|-------------|
| Must Fix | 2 | Incomplete caller analysis, race condition documentation |
| Should Fix | 6 | Edge cases, backward compat, dependencies |
| Nice to Have | 3 | Documentation completeness |

---

## 3. Must Fix Findings

### S3-001: API routes share the detectPrompt-before-detectThinking execution order problem

**Category**: Ripple Effect

The design document (Section 7.1) lists 4 callers of `detectPrompt()`, but 3 additional callers in API routes are missing:

1. `src/app/api/worktrees/route.ts` (L62)
2. `src/app/api/worktrees/[id]/route.ts` (L62)
3. `src/app/api/worktrees/[id]/current-output/route.ts` (L79)

The first two API routes exhibit the same execution order problem as `status-detector.ts`:

```typescript
// From worktrees/[id]/route.ts (L61-72):
const promptDetection = detectPrompt(cleanOutput);
if (promptDetection.isPrompt) {
  isWaitingForResponse = true;  // <-- Early return, skips thinking check
} else {
  // ... detectThinking() called only in else branch
  if (detectThinking(cliToolId, lastLines)) {
    isProcessing = true;
  }
}
```

When a false positive `multiple_choice` detection occurs during thinking state, these routes will set `isWaitingForResponse=true`, causing incorrect sidebar status indicators for users.

**Recommendation**: Add all 3 API routes to Section 7.1. The 2-pass detection fix in `prompt-detector.ts` will resolve false positives at all call sites, so no API route code changes are strictly required. However, the impact analysis should be complete.

---

### S3-002: Server-client duplicate response risk documentation gap

**Category**: Race Condition

Both server-side polling (`auto-yes-manager.ts`) and client-side hook (`useAutoYes.ts`) can respond to prompts. The deduplication mechanism relies on `lastServerResponseTimestamp` with a 3-second window:

```typescript
// useAutoYes.ts (L67-73):
if (lastServerResponseTimestamp) {
  const timeSinceServerResponse = Date.now() - lastServerResponseTimestamp;
  if (timeSinceServerResponse < DUPLICATE_PREVENTION_WINDOW_MS) {
    return; // Skip client response
  }
}
```

The design document does not analyze whether this deduplication mechanism is affected by the proposed changes. While the changes do not worsen this scenario, the analysis should explicitly confirm this.

**Recommendation**: Add a note in Section 6 confirming the deduplication mechanism is unaffected.

---

## 4. Should Fix Findings

### S3-003: U+276F character shared between selection indicators and CLI prompts

**Category**: Edge Case

The U+276F character is used both as a selection indicator in multiple-choice prompts and as the CLI prompt character (`CLAUDE_PROMPT_PATTERN` in `cli-patterns.ts`). In tmux output containing both a prompt line and a numbered list, the prompt character could theoretically satisfy Pass 1's requirement.

The `defaultOptionPattern` (`/^\s*\u276F\s*(\d+)\.\s*(.+)$/`) requires a specific format that makes this unlikely, but a test case should verify this edge case explicitly.

**Recommendation**: Add a test case with output like:
```
\u276F /work-plan

I will do the following:
1. Create file
2. Run tests
```
This should return `isPrompt: false`.

---

### S3-004: No existing multiple_choice test cases as regression baseline

**Category**: Backward Compatibility

The existing test file `tests/unit/prompt-detector.test.ts` contains 0 test cases for `multiple_choice` prompts. All 444 lines of existing tests cover only yes/no patterns (Patterns 1-5) and `getAnswerInput()`.

This means there is no automated regression baseline for the current `detectMultipleChoicePrompt()` behavior. Section 5.2 lists 6 regression test cases that need to be created from scratch.

**Recommendation**: Before implementing code changes, add Section 5.2 regression tests against the CURRENT codebase to establish a passing baseline. This ensures backward compatibility is verified against actual behavior, not just documented expectations.

---

### S3-005: response-poller.ts has multiple detectPrompt() call sites with different contexts

**Category**: Ripple Effect

`response-poller.ts` calls `detectPrompt()` at three distinct locations:
- L248: Early permission prompt detection (full output, no prior thinking check)
- L442: End-of-extraction prompt detection (full output)
- L556: Completed response prompt classification

The early call at L248 has no preceding thinking guard and returns `isComplete: true` immediately on match. The design document lists this file as having "indirect impact" but does not differentiate between the multiple call sites.

**Recommendation**: Update Section 7.1 to note the multiple call sites and that L248 has no preceding thinking guard.

---

### S3-006: Claude CLI output format change dependency risk

**Category**: Dependency

The 2-pass detection relies on the specific Unicode character U+276F as the selection indicator. Claude CLI has already changed its prompt character from `>` to U+276F in the past. A similar change to the selection indicator would cause complete false negatives for all multiple-choice prompts.

**Recommendation**: Document this dependency in Section 6.1. Consider extracting the selection indicator character as a named constant in `cli-patterns.ts` for easier future updates.

---

### S3-007: 50-line scan window boundary conditions

**Category**: Edge Case

The 2-pass detection changes the semantic meaning of the 50-line window from "scan for options" to "verify U+276F presence + scan for options". Two boundary conditions exist:

1. Long explanations before a prompt could push the U+276F line outside the window (false negative)
2. Stale U+276F from an already-answered prompt still in the window could trigger false positives on new numbered lists

**Recommendation**: Add boundary test cases and document the window size rationale.

---

### S3-008: Thinking-to-prompt transition delay for auto-yes

**Category**: User Experience

The Layer 1 thinking guard in `auto-yes-manager.ts` will skip prompt detection when `detectThinking()` returns true. During the transition from thinking to prompt display, thinking indicators may still be present in earlier lines of the tmux output, causing a detection delay of 1-2 polling intervals (2-4 seconds).

**Recommendation**: Document as a known trade-off. The delay is preferable to false positive auto-responses.

---

## 5. Nice to Have Findings

### S3-009: UI components are downstream consumers not mentioned in impact analysis

PromptPanel.tsx, MobilePromptSheet.tsx, and PromptMessage.tsx all consume `PromptData` objects from the current-output API. They benefit from reduced false positives but require no code changes. A brief note in Section 7 would improve completeness.

### S3-010: Consecutive validation rejects gaps but Claude CLI could theoretically produce filtered lists

The `isConsecutiveFromOne()` validation would reject option sequences with gaps (e.g., 1, 2, 4). While Claude CLI currently always produces consecutive numbering, this is a defensive measure that could cause future false negatives if the behavior changes. Already appropriately classified as "Should" priority.

### S3-011: claude-poller.ts simplified thinkingPattern is existing technical debt

Already identified in S1-008 and documented in Section 10.3 as out-of-scope. No additional action needed.

---

## 6. Impact Flow Diagram

```
prompt-detector.ts (2-pass detection change)
    |
    +---> auto-yes-manager.ts (Layer 1 thinking guard + detectPrompt)
    |         |
    |         +---> resolveAutoAnswer() -> sendKeys() [auto response]
    |
    +---> response-poller.ts (L248, L442, L556)
    |         |
    |         +---> DB message creation -> WebSocket broadcast
    |
    +---> claude-poller.ts (L164)
    |         |
    |         +---> DB message creation -> WebSocket broadcast
    |
    +---> status-detector.ts (L80)
    |         |
    |         +---> SessionStatus ('waiting' | 'running' | 'ready')
    |
    +---> API: worktrees/route.ts (L62)
    |         |
    |         +---> isWaitingForResponse flag -> Sidebar status
    |
    +---> API: worktrees/[id]/route.ts (L62)
    |         |
    |         +---> isWaitingForResponse flag -> Worktree detail status
    |
    +---> API: current-output/route.ts (L79)
              |
              +---> isPromptWaiting, promptData -> Client UI
                        |
                        +---> useAutoYes.ts (client-side fallback)
                        +---> PromptPanel.tsx / MobilePromptSheet.tsx
```

---

## 7. Overall Assessment

The proposed changes have well-contained impact because the core fix is within `prompt-detector.ts`, a pure function with no side effects. The 2-pass detection change will propagate benefits to ALL 7 call sites without requiring changes at those sites. The Layer 1 thinking guard in `auto-yes-manager.ts` adds defense-in-depth specifically for the auto-yes path.

The most significant gap in the current design document is the incomplete caller inventory (S3-001), which misses 3 API route files that share the same execution order vulnerability as `status-detector.ts`. While the prompt-detector-level fix resolves the issue for these callers, the design document should acknowledge them for completeness and maintainability.

The risk of backward compatibility breaks is low, provided the regression test cases from Section 5.2 are implemented BEFORE the code changes to establish a verified baseline (S3-004).

---

## 8. Recommendations Priority

| Priority | Finding | Action |
|----------|---------|--------|
| 1 | S3-001 | Add 3 API routes to Section 7.1 caller analysis |
| 2 | S3-004 | Add regression tests before implementing changes |
| 3 | S3-002 | Document deduplication mechanism as unaffected |
| 4 | S3-003 | Add U+276F ambiguity edge case test |
| 5 | S3-005 | Detail response-poller.ts call sites |
| 6 | S3-006 | Document Claude CLI format dependency |
| 7 | S3-007 | Add 50-line window boundary tests |
| 8 | S3-008 | Document thinking-to-prompt transition delay |
