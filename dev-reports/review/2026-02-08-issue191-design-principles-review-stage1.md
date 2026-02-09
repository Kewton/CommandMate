# Architecture Review: Issue #191 - Auto-Yes detectThinking() Windowing

## Review Metadata

| Item | Value |
|------|-------|
| **Issue** | #191 |
| **Focus Area** | Design Principles (SOLID/KISS/YAGNI/DRY) |
| **Stage** | Stage 1 - Normal Review |
| **Status** | Conditionally Approved |
| **Score** | 4 / 5 |
| **Date** | 2026-02-08 |

---

## Executive Summary

The design policy for Issue #191 proposes a minimal, focused fix to a real bug: stale thinking summary lines (e.g., `Simmering... (4m 16s)`) in early buffer regions cause `detectThinking()` to permanently block prompt detection in the Auto-Yes poller. The proposed solution -- applying a 50-line tail window to the `detectThinking()` call in `auto-yes-manager.ts` -- is well-scoped, follows established patterns in the codebase, and avoids unnecessary changes to shared functions.

The design is **conditionally approved** with two "Should Fix" items related to DRY principle adherence around shared windowing constants and repeated code patterns. No "Must Fix" items were identified.

---

## Detailed Findings

### SOLID Principles Evaluation

#### Single Responsibility Principle (SRP) -- PASS

The change is well-contained. `pollAutoYes()` in `auto-yes-manager.ts` is responsible for orchestrating the polling loop, and pre-processing the buffer before passing it to `detectThinking()` falls squarely within that orchestration responsibility. The `detectThinking()` function itself remains unchanged, preserving its single responsibility of pattern matching against provided content.

**Evidence**: The design explicitly states "auto-yes-manager.ts のみ修正" and "detectThinking() 関数自体は変更不要" (Section 7), demonstrating clear separation of concerns between the caller's data preparation and the detector's pattern matching.

#### Open/Closed Principle (OCP) -- PASS

The design avoids modifying `detectThinking()` (closed for modification) and instead modifies only the call site (open for extension through pre-processing). This is a pragmatic application of OCP.

**Evidence**: `detectThinking()` at `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/cli-patterns.ts` lines 73-95 remains completely untouched. The function signature `detectThinking(cliToolId: CLIToolType, content: string): boolean` does not change.

#### Liskov Substitution / Interface Segregation / Dependency Inversion -- NOT APPLICABLE

No inheritance hierarchies, interface changes, or dependency direction changes are involved in this fix. This is appropriate for the scope of the change.

---

### KISS Evaluation -- PASS

The design is admirably simple. The entire fix consists of:

1. One new constant: `THINKING_CHECK_LINE_COUNT = 50`
2. One new line of code: `const recentLines = cleanOutput.split('\n').slice(-THINKING_CHECK_LINE_COUNT).join('\n');`
3. One modified call: `detectThinking(cliToolId, recentLines)` instead of `detectThinking(cliToolId, cleanOutput)`

The alternatives that were rejected (priority inversion, summary-line exclusion patterns) would have been significantly more complex. The windowing approach is the simplest effective solution.

**Positive observation**: The design document explicitly considered and rejected two more complex alternatives (Sections 7: "Not Adopted: Case 2" and "Not Adopted: Case 3"), demonstrating thoughtful simplicity.

---

### YAGNI Evaluation -- PASS

The design does not introduce any speculative features or premature abstractions:

- No new function signatures added to `detectThinking()` (e.g., optional `windowSize` parameter)
- No shared windowing utility function created just for this one additional call site
- No changes to `detectPrompt()`, `status-detector.ts`, or `current-output/route.ts`

The scope is precisely what is needed to fix the reported bug and nothing more.

---

### DRY Evaluation -- CONDITIONAL PASS

Two DRY-related concerns were identified:

#### SF-001: Windowing constant semantic duplication (Should Fix, Medium)

The proposed `THINKING_CHECK_LINE_COUNT = 50` in `auto-yes-manager.ts` is semantically coupled to the hardcoded `50` in `prompt-detector.ts` line 268:

```typescript
// prompt-detector.ts L268
const scanStart = Math.max(0, lines.length - 50);
```

The design document explicitly acknowledges this coupling in Section 3-2: "detectPrompt()のmultiple_choice検出: prompt-detector.ts L268でslice(-50)を使用." However, this coupling is enforced only through comments, not through shared constants.

If either value is changed independently, the Layer 1 defense (thinking detection scope must be >= prompt detection scope) could be silently violated, reintroducing the Issue #161 false positive vulnerability.

**Recommendation**: Define a shared constant (e.g., `MULTIPLE_CHOICE_SCAN_WINDOW` in `cli-patterns.ts`) and import it from both `prompt-detector.ts` and `auto-yes-manager.ts`. Alternatively, add a cross-referencing test that asserts equality.

#### SF-002: Repeated split-slice-join pattern (Should Fix, Low)

The `output.split('\n').slice(-N).join('\n')` idiom now appears in at least three locations:

1. `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/lib/status-detector.ts` line 83: `lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n')`
2. `/Users/maenokota/share/work/github_kewton/commandmate-issue-191/src/app/api/worktrees/[id]/current-output/route.ts` line 74: `nonEmptyLines.slice(-15).join('\n')`
3. The proposed addition in `auto-yes-manager.ts`: `cleanOutput.split('\n').slice(-THINKING_CHECK_LINE_COUNT).join('\n')`

This is a minor concern. A utility like `getLastNLines(text: string, n: number): string` would reduce repetition and centralize the behavior, but is not critical for this issue.

---

## Risk Assessment

| Risk Type | Level | Details |
|-----------|-------|---------|
| Technical | Low | Change narrows search scope (5000 -> 50 lines), reducing false positives. Existing tests with 3-line inputs fit within 50-line window and remain valid. |
| Security | Low | No new external inputs processed. No validation changes. Search scope reduction is a security-positive change. |
| Operational | Low | No deployment changes. No configuration changes. Behavioral change is limited to preventing an existing false-positive bug. |

---

## Test Design Assessment

The proposed test design in Section 4 is adequate:

- **Test 1** (5000-line buffer with stale thinking + tail prompt): Directly validates the bug fix scenario. Good.
- **Test 2** (thinking within last 50 lines): Validates that legitimate thinking detection still works. Good.
- **Test 3** (constant value check): See C-002 below.

**Concern (C-002)**: Test 3 asserts `THINKING_CHECK_LINE_COUNT === 50` as a hardcoded value. This test would break for any valid change to the constant. A more robust test would assert that `THINKING_CHECK_LINE_COUNT` equals the scan window used by `detectMultipleChoicePrompt()` in `prompt-detector.ts`, encoding the *invariant* rather than the *value*.

The existing Issue #161 tests (lines 427-499 of the test file) use 3-line inputs that naturally fit within the 50-line window, so they are correctly identified as unaffected by this change.

---

## Improvement Recommendations

### Must Fix (0 items)

None.

### Should Fix (2 items)

| ID | Principle | Title | Severity | Effort |
|----|-----------|-------|----------|--------|
| SF-001 | DRY | Windowing constant semantic duplication between auto-yes-manager.ts and prompt-detector.ts | Medium | Low |
| SF-002 | DRY | Repeated split-slice-join pattern across 3+ files | Low | Low |

### Consider (3 items)

| ID | Principle | Title |
|----|-----------|-------|
| C-001 | KISS | Document window size difference rationale (15 vs 50) in code comments |
| C-002 | YAGNI | Replace hardcoded constant value test with invariant-based test |
| C-003 | OCP | Future consideration: detectThinking() with optional windowSize parameter |

---

## Conclusion

The design for Issue #191 is well-reasoned, minimal in scope, and correctly applies the windowing pattern already established in `status-detector.ts`. The choice to modify only the call site rather than the shared `detectThinking()` function respects the Open/Closed principle and avoids unintended side effects on the other two call sites.

The primary concern is the implicit coupling between the 50-line constant in `auto-yes-manager.ts` and the 50-line scan window in `prompt-detector.ts`. This coupling is documented in comments but not enforced through code. Addressing SF-001 (shared constant or cross-reference test) would elevate this design from "good" to "excellent" with regard to long-term maintainability.

**Overall assessment**: Conditionally approved. Proceed with implementation. The SF-001 finding should be addressed either during implementation or as an immediate follow-up.
