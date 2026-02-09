# Architecture Review: Issue #208 Stage 2 (Consistency Review)

## Executive Summary

| Item | Content |
|------|---------|
| Issue | #208: Auto-Yes numbered list false positive prevention |
| Review Stage | Stage 2: Consistency Review |
| Date | 2026-02-09 |
| Status | conditionally_approved |
| Score | 4/5 |
| Risk | Technical: low / Security: low / Operational: low |

Issue #208 proposes strengthening Layer 5 (SEC-001) of the multiple choice prompt detection system by adding a question line validity check (`isQuestionLikeLine()`) as SEC-001b. This review examines the consistency between the design policy document and the current implementation, existing tests, and related Issue design documents (#161, #193).

**Overall Assessment**: The design policy is well-structured and maintains strong consistency with both the current codebase and related design documents. The Layer 5 extension approach (SEC-001b) correctly builds upon the existing SEC-001a guard introduced by Issue #193, and the proposed changes do not break any existing defense layers established by Issue #161. Two items require attention before implementation: (1) the code insertion point for SEC-001b relative to existing logic, and (2) the testability of the private `isQuestionLikeLine()` function for test plan T11.

---

## 1. Consistency Analysis: Design Policy vs. Implementation Code

### 1.1 Line Number and Code Reference Verification

The design policy references specific locations in `src/lib/prompt-detector.ts`. Below is the verification matrix.

| Design Reference | Stated Location | Actual Location | Match |
|------------------|----------------|-----------------|-------|
| Layer 5 SEC-001 guard | `prompt-detector.ts:402-411` | L402-411 (SEC-001a: `if (!requireDefault && questionEndIndex === -1)`) | Match |
| `isContinuationLine()` | `L264-277` | L264-277 (function definition) | Match |
| `!line.endsWith('?')` in isContinuationLine | Referenced in Section 3.4 | L271: `!line.endsWith('?')` in hasLeadingSpaces condition | Match |
| `questionEndIndex` initialization | Implicit in Section 3.1 | L344: `let questionEndIndex = -1;` | Match |
| `questionEndIndex` assignment | Referenced in Section 3.4 (Pass 2) | L378: `questionEndIndex = i;` | Match |
| Pass 1 requireDefault gate | Section 4 Layer 2 description | L321-337: `if (requireDefault) { ... }` | Match |
| Layer 3 consecutive validation | Section 4 unchanged | L384-390: `isConsecutiveFromOne(optionNumbers)` | Match |
| Layer 4 options check | Section 4 unchanged | L394-400: `collectedOptions.length < 2 || (requireDefault && !hasDefaultIndicator)` | Match |

**Finding**: All code references in the design policy are accurate against the current codebase. The design correctly identifies the insertion point for SEC-001b modifications.

### 1.2 SEC-001b Insertion Point Analysis

The design proposes replacing the current SEC-001a block (L402-411):

```typescript
// Current (SEC-001a only):
if (!requireDefault && questionEndIndex === -1) {
  return { isPrompt: false, cleanContent: output.trim() };
}
```

With an expanded block:

```typescript
// Proposed (SEC-001a + SEC-001b):
if (!requireDefault) {
  if (questionEndIndex === -1) {
    return { isPrompt: false, cleanContent: output.trim() };
  }
  const questionLine = lines[questionEndIndex]?.trim() ?? '';
  if (!isQuestionLikeLine(questionLine)) {
    return { isPrompt: false, cleanContent: output.trim() };
  }
}
```

**IC-002 Finding**: The refactoring from a single condition (`if (!requireDefault && questionEndIndex === -1)`) to a nested block (`if (!requireDefault) { ... }`) is semantically correct. The existing code at L402-411 will be fully replaced. The question text extraction logic at L414-428 (`if (questionEndIndex >= 0)`) remains untouched, as SEC-001b is applied before reaching that point. This transformation is safe and well-bounded.

### 1.3 Existing Logic Compatibility

| Existing Feature | Impact | Verification |
|-----------------|--------|-------------|
| `isContinuationLine()` `?` exclusion (L271) | No conflict - `?`-ending lines continue to be excluded from continuation, allowing them to become `questionEndIndex` candidates | Consistent with design Section 3.4 |
| Pass 2 reverse scan for `questionEndIndex` | No change - `questionEndIndex` is set before SEC-001b is checked | Consistent with design Section 3.4 |
| `requireDefault = true` path (Codex/Gemini) | SEC-001b is inside `if (!requireDefault)` block, so it never executes for `requireDefault = true` | Consistent with design Section 2.3 |
| Layer 4 combined check (L395) | `(requireDefault && !hasDefaultIndicator)` remains unchanged; SEC-001b is evaluated after Layer 4 passes | Consistent with design Section 4 |

---

## 2. Consistency Analysis: Test Plan vs. Existing Tests

### 2.1 Existing Test Coverage Map

The test file (`tests/unit/prompt-detector.test.ts`, 1233 lines) contains comprehensive tests organized by Issue.

| Test Group | Lines | Relevance to #208 |
|-----------|-------|-------------------|
| Issue #161: False positive prevention | L523-576 | Baseline for numbered list rejection (Layer 2 protection) |
| Issue #161: Defense layer boundary tests | L583-612 | Layer 2/3/4 individual boundary tests |
| Issue #161: 50-line window boundary | L796-835 | Window edge case tests |
| Issue #193: requireDefaultIndicator option | L842-1047 | Core tests for `requireDefaultIndicator: false` behavior |
| Issue #193: SEC-001 tests (L942-985) | L942-985 | Directly relevant - tests SEC-001a guard |
| Bug fix: Bash tool indented question | L1055-1136 | Tests for `?`-ending line exclusion from isContinuationLine |
| Bug fix: trailing empty lines | L1141-1180 | Trailing line stripping tests |

### 2.2 Test Plan vs. Existing Tests Overlap Analysis

| Test ID | Design Plan | Existing Coverage | Gap |
|---------|------------|-------------------|-----|
| T1 | Heading + numbered list -> false | Partially covered by L561-566 (CLI step descriptions, but uses `requireDefaultIndicator: true` implicitly) | New test needed with `requireDefaultIndicator: false` |
| T2 | Task completion list -> false | Not covered | New test needed |
| T3 | Step explanation list -> false | Not covered | New test needed |
| T4 | Markdown heading + numbered list -> false | Not covered | New test needed |
| T5 | Question with `?` + numbered choices -> true | Covered by L853-863 (`"Which option would you like?"` with `requireDefaultIndicator: false`) | Existing test sufficient; new test adds diversity |
| T6 | Colon + keyword question -> true | Covered by L886-899 (`"Choose an action:"` with `requireDefaultIndicator: false`) | Existing test validates similar scenario |
| T7 | `choose` keyword + colon -> true | Partially covered by T6 equivalent above | New test adds explicit keyword variety |
| T8 | SEC-001a existing test -> false | Covered by L943-955 (numbered list only, no question line) | Existing test is exact match |
| T9 | Default indicator with `?` prompt -> true | Covered by L1014-1026 (cursor-indicated choices with `requireDefaultIndicator: true`) | Existing test sufficient |
| T10 | No cursor, default settings -> false | Covered by L988-999 | Existing test sufficient |
| T11 | isQuestionLikeLine() unit tests | Not directly testable (private function) | See IC-005 below |
| T12 | Full-width question mark -> true | Not covered | New edge case test needed |
| T13 | Long output + trailing list -> false | Not covered | New edge case test needed |
| T14 | Bash tool indented choices -> true | Partially covered by L1056-1073 (2-space indented question) | Existing test validates same scenario; new test confirms SEC-001b passes |

### 2.3 Key Finding: T11 isQuestionLikeLine() Testability (IC-005)

The design defines `isQuestionLikeLine()` as a module-private function (not exported). Test plan T11 lists 13 individual assertion cases for this function directly. Since it is not exported, these assertions must be implemented as integration tests through `detectPrompt()` or `isQuestionLikeLine()` must be exported for direct testing.

**Recommendation**: Either (a) export `isQuestionLikeLine()` for direct unit testing (slightly reduces encapsulation but enables precise testing), or (b) implement T11 cases as integration tests where each assertion is tested via a full `detectPrompt()` call with `requireDefaultIndicator: false` and an appropriate numbered list. Option (b) is more aligned with the design's encapsulation intent but requires more test setup.

---

## 3. Consistency Analysis: Related Issue Design Documents

### 3.1 Issue #161 Design Document Consistency

| Aspect | Issue #161 Design | Issue #208 Design | Consistency |
|--------|------------------|------------------|-------------|
| Defense layer numbering | Layer 1 (thinking) through Layer 4 (options+hasDefault) | Adds Layer 5 SEC-001b while maintaining Layers 1-4 unchanged | Consistent |
| prompt-detector.ts CLI-tool independence | Maintained (thinking detection in callers only) | Maintained (isQuestionLikeLine() is tool-agnostic) | Consistent |
| 2-pass detection (Pass 1 + Pass 2) | Introduced as core defense (Layer 2) | Referenced as unchanged | Consistent |
| `isConsecutiveFromOne()` | Introduced as Layer 3 defensive measure | Referenced as unchanged | Consistent |
| `detectMultipleChoicePrompt()` scope | Single function with multiple defense layers | SEC-001b adds logic within same function scope | Consistent |

### 3.2 Issue #193 Design Document Consistency

| Aspect | Issue #193 Design | Issue #208 Design | Consistency |
|--------|------------------|------------------|-------------|
| `DetectPromptOptions` interface | Introduced with `requireDefaultIndicator?: boolean` | Used as-is, no interface changes | Consistent |
| `buildDetectPromptOptions()` | Introduced in `cli-patterns.ts` | Referenced as unchanged, no modifications needed | Consistent |
| Layer 5 SEC-001 | Introduced: `!requireDefault && questionEndIndex === -1 -> false` | Extended: SEC-001a (existing) + SEC-001b (new isQuestionLikeLine check) | Consistent extension |
| Pass 1 skip for `requireDefault=false` | Pass 1 skipped entirely | Pass 1 skip behavior unchanged | Consistent |
| Layer 4 modification | `hasDefaultIndicator` check skipped when `requireDefault=false` | Layer 4 behavior unchanged | Consistent |
| Caller update pattern | `buildDetectPromptOptions(cliToolId)` at all call sites | No caller changes needed (SEC-001b is internal to prompt-detector.ts) | Consistent - design correctly states no caller changes needed (Section 2.3) |

### 3.3 Cross-Document Terminology Consistency

| Term | #161 | #193 | #208 | Consistent |
|------|------|------|------|-----------|
| `requireDefaultIndicator` | N/A (introduced in #193) | Defined and documented | Used correctly | Yes |
| `questionEndIndex` | Implicit in detection logic | Explicitly used in SEC-001 | Referenced accurately | Yes |
| `SEC-001` | N/A | Introduced as Layer 5 designation | Extended to SEC-001a/SEC-001b | Yes |
| `Layer 5` | N/A (Layers 1-4 only) | Introduced | Extended | Yes |
| `Pass 1` / `Pass 2` | Introduced | Referenced | Referenced | Yes |
| `QUESTION_KEYWORD_PATTERN` | N/A | N/A | Newly introduced | N/A |
| `isQuestionLikeLine()` | N/A | N/A | Newly introduced | N/A |

---

## 4. Document Internal Consistency

### 4.1 Section Cross-References

| Source Section | Referenced Section | Claim | Verified |
|---------------|-------------------|-------|----------|
| Section 3.1 (SEC-001b) | Section 3.2 (isQuestionLikeLine) | SEC-001b calls isQuestionLikeLine() | Consistent |
| Section 3.2 (Pattern 1) | Section 4.2 (full-width `?`) | Full-width question mark handled in Pattern 1 | Consistent |
| Section 3.3 (QUESTION_KEYWORD_PATTERN) | Section 3.2 (Pattern 2) | Pattern 2 uses QUESTION_KEYWORD_PATTERN for colon-ending lines | Consistent |
| Section 3.4 (isContinuationLine) | Section 3.1 (questionEndIndex) | isContinuationLine() excludes `?`-ending lines, allowing them as question candidates | Consistent |
| Section 4 (defense layers) | Section 3.1 (SEC-001b) | Layer 5 shows SEC-001a and SEC-001b in sequence | Consistent |
| Section 4.1 (false positive scenario) | Section 3.3 (QUESTION_KEYWORD_PATTERN) | "Recommendations:" does not match keyword pattern | Consistent |
| Section 6 (test plan) | Section 3 (detailed design) | Test inputs align with design scenarios | Consistent |
| Section 9.1 (change files) | Section 2.2 (modification target) | Both list prompt-detector.ts and prompt-detector.test.ts | Consistent |
| Section 11 (related issues) | Section 1.2 (root cause) | #161 and #193 correctly identified as predecessors | Consistent |
| Section 12 (review checklist) | Section 14 (review history SF-001/SF-002) | Checklist items match review finding IDs | Consistent |
| Section 13 (review history) | Section 14 (review summary) | Stage 1 score (5/5, approved) is documented in both | Consistent |

### 4.2 Numerical Consistency

| Claim | Location | Verified Value | Match |
|-------|----------|---------------|-------|
| "14 new tests" | Section 9.1 | T1-T14 in Section 6 | Match |
| "Single file change" | Section 2.1 reason 4 | Section 9.1 lists 2 files (prompt-detector.ts + test) | Minor discrepancy: "single file" refers to production code change only, test file is separate |
| "Observed keywords: 7" | Section 3.3 JSDoc | select, choose, pick, which, what, enter, confirm = 7 | Match |
| "Defensive keywords: 10" | Section 3.3 JSDoc | how, where, type, specify, approve, accept, reject, decide, preference, option = 10 | Match |
| "Total keywords: 17" | Implied by Section 3.3 | 7 + 10 = 17 keywords in regex pattern | Match |

---

## 5. Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | SEC-001b insertion refactoring may introduce subtle ordering issues if not carefully applied | Low | Low | P3 |
| Technical | isQuestionLikeLine() private function testability for T11 | Medium | Medium | P2 |
| Technical | QUESTION_KEYWORD_PATTERN lacks word boundaries (potential "Selections:" false positive) | Low | Very Low | P3 |
| Security | No new security risks introduced; SEC-001b strengthens existing defense | None | N/A | N/A |
| Operational | No operational risks; changes are internal to prompt-detector.ts | None | N/A | N/A |

---

## 6. Improvement Recommendations

### 6.1 Must Fix (2 items)

**IC-001**: Line number references are currently accurate. Add a note in Section 9.2 Step 1 that line numbers should be re-verified after implementation since adding `isQuestionLikeLine()` and `QUESTION_KEYWORD_PATTERN` before the existing SEC-001 block will shift subsequent line numbers.

**IC-002**: Clarify the exact code transformation at the SEC-001 block. The design pseudo-code in Section 3.1 shows the desired end state, but an explicit "before/after" diff format would make the implementation less ambiguous. Specifically, the existing `if (!requireDefault && questionEndIndex === -1)` on L406 should be documented as being replaced by the nested `if (!requireDefault) { SEC-001a check; SEC-001b check; }` block.

### 6.2 Should Fix (3 items)

**IC-003**: Add implementation notes to test T14 documenting the interaction between `isContinuationLine()` `?`-exclusion (L271) and the new `isQuestionLikeLine()` SEC-001b check, to ensure future maintainers understand why both mechanisms must cooperate for indented question detection.

**IC-004**: Document in Section 3.3 that `QUESTION_KEYWORD_PATTERN` uses substring matching (not word-boundary matching) and explicitly acknowledge the trade-off: substring matching is broader (lower false negative risk) but could theoretically match words containing keywords as substrings. State that this is acceptable because the pattern requires the line to also end with `:`, which narrows the false positive scope significantly.

**IC-005**: Resolve the T11 testability question. Either (a) add a note to the test plan that T11 will be implemented as integration tests through `detectPrompt()` with carefully crafted inputs that isolate `isQuestionLikeLine()` behavior, or (b) state that `isQuestionLikeLine()` will be exported with a `@internal` JSDoc tag for direct unit testing.

### 6.3 Consider (2 items)

**IC-008**: Add an inline comment in the `isQuestionLikeLine()` implementation noting that full-width colon (`：`) is intentionally not handled per YAGNI (C-002 review finding).

**IC-009**: Consider adding an explicit regression test for `requireDefaultIndicator: true` that verifies SEC-001b is never reached, to serve as a safety net against future refactoring that might accidentally remove the `if (!requireDefault)` guard.

---

## 7. Consistency Verdict

The design policy document for Issue #208 demonstrates strong consistency across all four review dimensions:

1. **Design vs. Implementation**: All code references are accurate. The proposed changes are correctly scoped to the `if (!requireDefault)` block within `detectMultipleChoicePrompt()`. No unintended side effects on the `requireDefault = true` path.

2. **Test Plan vs. Existing Tests**: The test plan correctly identifies gaps in existing coverage (numbered lists with `requireDefaultIndicator: false` that are not actual prompts). The SEC-001a existing tests (L942-985) provide a solid foundation for SEC-001b extensions.

3. **Related Issue Consistency**: Layer numbering, terminology, and architectural principles from Issues #161 and #193 are faithfully maintained. The design correctly extends (rather than replaces) existing defense mechanisms.

4. **Document Internal Consistency**: Section cross-references, numerical claims, and scenario analyses are internally consistent. The review history (Stage 1) is properly documented and its findings (SF-001, SF-002) are reflected in the design.

---

## 8. Approval Status

**Status**: Conditionally Approved (conditionally_approved)

**Conditions for full approval**:
1. Address IC-002: Clarify the exact code transformation for SEC-001 block replacement
2. Address IC-005: Resolve T11 isQuestionLikeLine() testability approach

**Conditions are non-blocking**: Implementation can proceed with awareness of these items. They should be resolved during implementation (not necessarily before).
