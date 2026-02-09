# Issue #191: Impact Analysis Review (Stage 3)

**Review Date**: 2026-02-08
**Review Type**: 影響範囲 (Impact Analysis / Blast Radius)
**Design Document**: `dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md`
**Result**: Conditionally Approved (4/5)

---

## 1. Review Summary

The proposed change applies windowing (last 50 lines) to the `detectThinking()` call in `auto-yes-manager.ts` `pollAutoYes()`, where it currently passes the full 5000-line buffer. The impact analysis in the design document is substantially correct. All three consumers of `detectThinking()` are properly identified, the regression risk assessment is accurate, and the modules listed as "no impact" have been individually verified.

The review identifies one Should Fix item related to the precision of the windowing comparison table, and four Nice to Have items that strengthen documentation completeness around edge cases and boundary behavior.

---

## 2. Impact Scope Verification

### 2.1 All Consumers of detectThinking() Identified

**Verdict: Correctly identified -- 3 call sites, 0 missed.**

| # | File | Line | Input Scope | Status |
|---|------|------|-------------|--------|
| 1 | `src/lib/auto-yes-manager.ts` | L284 | Full 5000-line buffer (BUG) | **Modification target** |
| 2 | `src/lib/status-detector.ts` | L99 | Last 15 lines (incl. empty) | No change needed |
| 3 | `src/app/api/worktrees/[id]/current-output/route.ts` | L83 | Last 15 non-empty lines | No change needed |

`detectThinking()` is defined and exported only from `src/lib/cli-patterns.ts` (L73). There are no re-exports, barrel files, or indirect callers. The function `getCliToolPatterns()` returns a `thinkingPattern` RegExp property, but this is used independently of `detectThinking()` in `response-poller.ts` skipPatterns context -- it does not constitute an indirect call to `detectThinking()`.

### 2.2 Indirect Callers and Re-exports

**Verdict: None missed.**

Grep analysis confirms `detectThinking` is imported in exactly 2 source files (`auto-yes-manager.ts`, `status-detector.ts`) and 1 API route (`current-output/route.ts`, aliased as `detectThinkingState`). No index.ts barrel exports or dynamic imports reference this function.

### 2.3 50-Line Window Boundary Analysis

**Verdict: No legitimate thinking states will be missed.**

Claude CLI's active thinking indicators (spinner characters + activity text + ellipsis) are rendered in real-time at the bottom of the terminal buffer. During active thinking, Claude CLI does not produce substantive output beyond the spinner line itself. Therefore:

- **Active thinking**: The indicator line is always within the last 1-5 lines of the buffer. A 50-line window captures this with a wide margin.
- **Completed thinking (summary line)**: After thinking completes, a summary line (e.g., `* Simmering... (4m 16s)`) replaces the spinner. This summary line is the root cause of Issue #191 because it also matches `CLAUDE_THINKING_PATTERN`. Once Claude begins producing output after thinking, the summary line moves upward in the buffer. It exits the 50-line window after 50 lines of new output, at which point prompts (if any) also appear within the window. This is the correct behavior -- the windowing prevents the stale summary from blocking prompt detection.
- **Edge case**: Immediately after thinking completes, the summary line is within the 50-line window AND no prompt has appeared yet. In this case, `detectThinking()` returns true and prompt detection is skipped -- but since there is no prompt to detect, this is harmless.

### 2.4 Regression Risk Assessment

**Verdict: Accurate.**

The modification narrows the search scope from 5000 lines to 50 lines. This is a reduction-only change: anything that was NOT detected before will still not be detected; the only change is that stale patterns in lines 51-5000 are excluded from detection. The `detectPrompt()` call at L290 continues to receive `cleanOutput` (full buffer) but applies its own internal windowing (10 lines for yes/no, 50 lines for multiple_choice), so it is unaffected.

### 2.5 tmux Buffer Edge Cases

**Verdict: Handled correctly by the existing code structure.**

- **ANSI escape sequences**: `tmux capture-pane -p -e` includes ANSI codes. The proposed code calls `stripAnsi()` before `split('\n')`, so ANSI sequences that span line boundaries are removed before line counting occurs. This is the same order used in `status-detector.ts` (L81-83).
- **Partial lines**: `tmux capture-pane` operates on complete terminal lines (rows). The `-p` flag outputs pane contents to stdout as complete lines. Partial-line truncation does not occur at the tmux level.
- **Empty trailing lines**: tmux buffers often contain trailing empty lines (padding). These are preserved through `split('\n').slice(-50)` and may consume some of the 50-line window. However, 50 lines provides sufficient margin even with moderate padding.

### 2.6 Fewer Than 50 Lines from captureSessionOutput

**Verdict: Handled safely by JavaScript array behavior.**

When `captureSessionOutput()` returns fewer than 50 lines (e.g., at session startup), `Array.prototype.slice(-50)` returns the entire array (JavaScript specification: if the absolute value of the negative index exceeds array length, slice starts from index 0). This means `detectThinking()` receives the full buffer contents, identical to the pre-modification behavior. No special handling is needed.

---

## 3. Unaffected Module Verification

Each module listed as "no impact" in the design document (Section 9) was individually verified against the source code:

| Module | Verified | Rationale |
|--------|----------|-----------|
| `src/lib/cli-patterns.ts` | Yes | `detectThinking()` itself is not modified. It receives `content: string` and applies regex testing. The windowing is performed at the call site. |
| `src/lib/prompt-detector.ts` | Yes | `detectPrompt()` applies its own windowing internally (L48: `slice(-10)` for yes/no, L268: `Math.max(0, lines.length - 50)` for multiple_choice). The full `cleanOutput` buffer passed at L290 is safely handled. |
| `src/lib/status-detector.ts` | Yes | Already windows to 15 lines at L83 before calling `detectThinking()` at L99. No change needed or affected. |
| `src/app/api/worktrees/[id]/current-output/route.ts` | Yes | Already windows to 15 non-empty lines at L73-74 before calling `detectThinkingState()` at L83. No change needed or affected. |
| `src/lib/auto-yes-resolver.ts` | Yes | Pure function (`resolveAutoAnswer`) operating on `PromptData` type. No dependency on buffer processing or `detectThinking()`. |
| `src/lib/session-cleanup.ts` | Yes | Facade pattern -- calls `stopAutoYesPolling()` only. Does not interact with polling internals or `detectThinking()`. |
| `src/lib/claude-session.ts` | Yes | Uses `CLAUDE_PROMPT_PATTERN` and `CLAUDE_SEPARATOR_PATTERN` directly for initialization detection. Does not call `detectThinking()`. `captureClaudeOutput()` is a thin wrapper around `capturePane()`. |
| `src/hooks/useAutoYes.ts` | Yes | Client-side hook. Receives pre-processed `promptData` and `lastServerResponseTimestamp` from `current-output/route.ts` responses. Server-side windowing changes do not propagate to the client. |
| `tests/unit/lib/auto-yes-manager.test.ts` | Yes | Existing Issue #161 tests (L428-498) use 3-line inputs. `slice(-50)` on a 3-line array returns the full array, so windowing has no effect on these tests. |

---

## 4. Findings

### 4.1 Should Fix

#### [IA-004] current-output/route.ts detectThinking Window Description Imprecision

**Severity**: Should Fix
**Location**: Design document Section 2 (windowing comparison table), Section 9 (impact analysis)

The windowing comparison table in Section 2 describes both `status-detector.ts` and `current-output/route.ts` as using "last 15 lines," but they differ qualitatively:

- `status-detector.ts` L83: `lines.slice(-STATUS_CHECK_LINE_COUNT)` -- last 15 lines **including empty lines**
- `current-output/route.ts` L73-74: `lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '').slice(-15)` -- last 15 **non-empty lines** (after ANSI stripping)

This difference means the effective scope of `detectThinking()` varies between these two call sites. While this has no impact on the current modification (which only changes `auto-yes-manager.ts`), the imprecise table description could mislead future developers when considering window size unification across modules.

**Recommendation**: Update the Section 2 table entry for `current-output/route.ts` from "last 15 lines (non-empty)" to "last 15 non-empty lines (after stripAnsi + empty-line filter)" to make the distinction explicit. In Section 9, add a note that the "no impact" assessment for `current-output/route.ts` accounts for this difference.

Note: This finding aligns with the existing C-C01 future consideration item but elevates it to Should Fix in the context of impact analysis accuracy.

### 4.2 Nice to Have

#### [IA-001] Fewer-Than-50-Lines Boundary Case Documentation

**Location**: Design document Section 3-1

The design document does not explicitly address the behavior when `captureSessionOutput` returns fewer than 50 lines. While `Array.slice(-50)` handles this correctly by returning the entire array, documenting this safe degradation behavior prevents future questions.

**Recommendation**: Add a brief note in Section 3-1 or Section 6: "When the buffer contains fewer than 50 lines (e.g., at session startup), `slice(-50)` returns the entire buffer, equivalent to pre-modification behavior."

#### [IA-002] stripAnsi-Before-Split Processing Order Significance

**Location**: Design document Section 3-1

The proposed code applies `stripAnsi()` before `split('\n').slice(-50).join('\n')`. This ordering is significant because ANSI escape sequences could theoretically span line boundaries, and removing them before line splitting ensures accurate line counting. The design document does not call attention to this ordering, though the implementation is correct.

**Recommendation**: Add a code comment or design note that `stripAnsi` is applied to the full buffer before line-based windowing, consistent with `status-detector.ts` L81-83.

#### [IA-003] Thinking Summary Line Persistence in 50-Line Window

**Location**: Design document Section 9 (regression risk)

The regression risk section states the risk is "low" but does not analyze the specific scenario where a thinking summary line (the root cause of Issue #191) falls within the 50-line window immediately after thinking completes. This is a benign scenario (no prompt exists yet, so skipping prompt detection causes no harm), but documenting this analysis strengthens the risk assessment.

**Recommendation**: Expand Section 9's regression risk narrative with this boundary analysis.

#### [IA-005] Existing Test Windowing Transparency

**Location**: Design document Section 4-2

The document correctly notes that existing tests use 3-line inputs, but does not explicitly state that these tests cannot distinguish between windowed and non-windowed behavior. Making this explicit clarifies that the new tests (Test 1, 2, 3) are the sole validators of the windowing effect.

**Recommendation**: Add to Section 4-2: "Existing tests use inputs smaller than the window size and therefore validate correctness but not the windowing mechanism itself."

---

## 5. Risk Assessment

| Category | Risk Level | Rationale |
|----------|-----------|-----------|
| Technical | Low | Single-line change narrows search scope; no new code paths introduced |
| Security | Low | No change to input validation, external input processing, or trust boundaries |
| Operational | Low | 2-second polling interval unchanged; split/slice/join on 5000-line string is negligible overhead |
| Regression | Low | Reduction-only change; existing tests unaffected; new tests cover boundary behavior |

---

## 6. Conclusion

The impact analysis in the design document is thorough and accurate. All three `detectThinking()` consumers are identified, no indirect callers or re-exports were missed, and the regression risk is correctly assessed as low. The 50-line window size is well-justified by its alignment with `detectPrompt()`'s multiple_choice scan range. The one Should Fix item (IA-004) addresses a precision issue in the documentation that could affect future maintenance decisions. The four Nice to Have items strengthen edge case documentation but require no implementation changes.

**Recommendation**: Approve for implementation after addressing IA-004 in the design document.

---

*Reviewed by: architecture-review-agent*
*Stage: 3 (Impact Analysis)*
*Result file: `dev-reports/issue/191/multi-stage-design-review/stage3-review-result.json`*
