# Issue #191 Review Report

**Review Date**: 2026-02-08
**Focus**: Normal Review (Consistency & Correctness)
**Iteration**: 2nd (Stage 5)

---

## Summary

| Category | Count |
|----------|-------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

---

## Previous Findings Verification

### Stage 1 Findings (7 items) -- All Resolved

| ID | Category | Original Issue | Status |
|----|----------|---------------|--------|
| SF-1 | Technical Validity | Window size 20 lines lacked justification | Resolved: Changed to 50 lines with detectPrompt() multiple_choice alignment rationale |
| SF-2 | Completeness | No rejection reasoning for Options 2/3 | Resolved: Tradeoff analysis added for both options |
| SF-3 | Consistency | status-detector.ts asymmetry not highlighted | Resolved: Added to "Problem Asymmetry" table with emphasis text |
| SF-4 | Acceptance Criteria | Missing consistency verification with status-detector.ts | Resolved: Added consistency check and 2 regression test scenarios |
| NTH-1 | Completeness | status-detector.ts missing from impact files | Resolved: Added as reference (consistency check) |
| NTH-2 | Completeness | No mention of `to interrupt)` pattern | Resolved: Added as note after residual output table |
| NTH-3 | Clarity | Prompt format not specified | Resolved: Specified as `(y/n)` format, `yes_no` pattern |

### Stage 3 Findings (6 items) -- All Resolved

| ID | Category | Original Issue | Status |
|----|----------|---------------|--------|
| MF-1 | Impact Files | Third caller current-output/route.ts not identified | Resolved: Added to both asymmetry table and impact files table |
| SF-1 | Test Coverage | Existing tests insufficient for 5000-line buffer scenario | Resolved: Regression test scenarios added to acceptance criteria |
| SF-2 | Dependencies | Window size inconsistency between Auto-Yes paths | Resolved: "Window Size Consistency Note" section added with full rationale |
| SF-3 | Breaking Changes | Codex CLI thinking detection impact not documented | Resolved: "CLI Tool Impact" section added to Option 1 |
| NTH-1 | Test Coverage | claude-poller.ts local thinkingPattern not mentioned | Resolved: Added to Related section notes |
| NTH-2 | Documentation | CLAUDE.md update needed post-implementation | Resolved: Update instructions added to Related section notes |

**Verification Result**: All 13 previous findings from Stages 1 and 3 have been properly addressed and verified against source code.

---

## New Findings

### Should Fix

#### SF-1: Option 2 Overstates Consistency with Existing Implementation

**Category**: Technical Validity
**Location**: ## Candidate Fix Approaches > Option 2

**Issue**:

Option 2's description states that it is consistent with "the `status-detector.ts` approach (L85-106: executes `detectPrompt()` before `detectThinking()`) and has existing track record." However, this overstates the alignment because `current-output/route.ts` uses the opposite order -- it executes `detectThinking()` first and gates `detectPrompt()` based on thinking state (L79-88), which is the same order as `auto-yes-manager.ts`.

Of the three existing callers of `detectThinking()`:
- `status-detector.ts` (L85-99): prompt first, then thinking
- `current-output/route.ts` (L79-88): thinking first, then prompt (gated)
- `auto-yes-manager.ts` (L284-290): thinking first, then prompt (gated)

Two out of three callers use the thinking-first approach. Stating that Option 2 has "high consistency with existing implementation" based solely on `status-detector.ts` is only partially accurate.

**Evidence**:

In `src/lib/status-detector.ts`:
```typescript
// L85-87: prompt detection FIRST
const promptDetection = detectPrompt(lastLines);
if (promptDetection.isPrompt) { ... }

// L99: thinking detection SECOND
if (detectThinking(cliToolId, lastLines)) { ... }
```

In `src/app/api/worktrees/[id]/current-output/route.ts`:
```typescript
// L83: thinking detection FIRST
const thinking = detectThinkingState(cliToolId, lastSection);

// L88: prompt detection SECOND (gated by thinking)
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput);
```

**Recommendation**:

Update Option 2's merit description to reflect that existing implementations are split on the execution order. For example: "status-detector.ts executes prompt detection before thinking detection (L85-106). However, current-output/route.ts takes the opposite approach, executing thinking detection first and gating prompt detection (L79-88). Existing implementations are divided on this approach."

---

### Nice to Have

#### NTH-1: "Status Display" Label for current-output/route.ts Is Slightly Imprecise

**Category**: Clarity
**Location**: ## Candidate Fix Approaches > Option 1 > Window Size Consistency Note

**Issue**:

In the bulleted list within the Window Size Consistency Note, `current-output/route.ts` is described as "status display use." While the route does provide status information (thinking, isGenerating flags), its primary role is also to provide the `isPromptWaiting` flag that feeds the client-side Auto-Yes hook (`useAutoYes.ts`). This dual role is correctly described in the detailed paragraph below the bulleted list but is understated in the bullet point itself.

**Recommendation**:

Consider updating the bullet point from "status display use" to "status display and client-side Auto-Yes path use" for consistency with the detailed explanation that follows.

---

#### NTH-2: Review History Section Maintenance Convention

**Category**: Completeness
**Location**: ## Review History

**Issue**:

The review history section at the bottom of the Issue is a good practice for tracking iterative improvements. It currently documents Stage 2 and Stage 4 modifications. If Stage 6 applies findings from this review, it would be natural to add a corresponding entry. No explicit convention statement is needed; the existing format is clear and self-explanatory.

**Recommendation**:

No action required unless desired. The current format is practical and sufficient. Future Stage 6 modifications can simply append a new subsection following the established pattern.

---

## Overall Assessment

Issue #191 has reached a high quality level after four review-apply cycles (Stages 1-4). The Issue is:

**Strengths**:

1. **Comprehensive Root Cause Analysis**: The "Problem Asymmetry" table now covers all three callers of `detectThinking()` with their respective windowing strategies, making the core inconsistency immediately visible.

2. **Well-Justified Window Size**: The choice of 50 lines for `auto-yes-manager.ts` is clearly motivated by alignment with `detectPrompt()`'s `multiple_choice` window size, with explicit source code references.

3. **Window Size Consistency Documentation**: The added note explaining why the three callers use different window sizes (50/15-non-empty/15) with purpose-based rationale is thorough and prevents future confusion.

4. **Concrete Acceptance Criteria**: The acceptance criteria include two specific regression test scenarios with buffer sizes, line positions, and expected behaviors. These are directly implementable.

5. **Proper Scope Management**: Codex CLI's `Ran` pattern risk is acknowledged as an existing issue, clearly marked as out-of-scope, and recommended for separate tracking.

6. **Tradeoff Analysis**: All three candidate approaches now include pros and cons, allowing the implementer to understand why Option 1 was chosen.

7. **Complete Impact File Listing**: All relevant files are listed with line numbers, change types (fix target vs. reference), and brief explanations.

**Remaining Items**:

- 1 Should Fix (SF-1): Option 2's consistency claim should be nuanced to reflect the split in existing implementations. This is a factual accuracy issue in the tradeoff analysis, not in the proposed fix itself.
- 2 Nice to Have (NTH-1, NTH-2): Minor wording and convention improvements.

None of these findings affect the correctness of the proposed fix (Option 1) or the acceptance criteria.

---

## Referenced Files

### Source Code
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/auto-yes-manager.ts` (L276-290): Bug location. Passes full 5000-line buffer to `detectThinking()`.
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/status-detector.ts` (L81-106): Reference implementation. Prompt-first order with 15-line windowing.
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/app/api/worktrees/[id]/current-output/route.ts` (L72-88): Third caller. Thinking-first order with 15-line non-empty windowing.
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/cli-patterns.ts` (L26-29, L36, L73-95): `detectThinking()` function and pattern definitions.
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/prompt-detector.ts` (L44-48, L264-268): `detectPrompt()` window sizes (10 for yes/no, 50 for multiple_choice).

### Documentation
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/CLAUDE.md`: Issue #161 section documents multi-layer defense. Post-implementation update instructions are included in the Issue.
