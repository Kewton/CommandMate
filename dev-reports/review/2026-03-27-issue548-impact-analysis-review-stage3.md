# Impact Analysis Review - Issue #548

## Review Metadata

| Item | Value |
|------|-------|
| Issue | #548 - Mobile file list display fix |
| Stage | 3 - Impact Analysis |
| Focus | 影響範囲 (Impact Scope) |
| Date | 2026-03-27 |
| Result | PASS_WITH_MINOR_ISSUES |
| Risk | LOW |

## Executive Summary

The design policy document for Issue #548 provides a solid impact analysis for a CSS-only change (`overflow-hidden` to `overflow-y-auto`, `pb-32` removal). The five mobile tab impact table is well-structured and the desktop non-impact is correctly identified. However, the review identified gaps in nested scroll behavior analysis, missing coverage of dynamic overlay components, and a test strategy that relies heavily on manual QA without automated regression guards.

## Findings

### should_fix (3 items)

#### IA-001: Terminal tab dual-scroll possibility not fully analyzed

The design document states terminal tab impact as "medium" with expected behavior "internal scroll continues, main scroll is not reached." However, TerminalDisplay receives only `className="h-full"` (line 804 of WorktreeDetailSubComponents.tsx) -- it does not have `flex-1 min-h-0` which is the standard pattern for preventing dual-scroll in flex containers. The document does not explain why `h-full` alone is sufficient to constrain TerminalDisplay's height within the `flex-1` main container.

In practice, `h-full` (100% of parent height) within a `flex-1` parent should resolve to the available space, so the terminal's internal `overflow-y-auto` will handle scrolling. But the design document should explicitly state this mechanism rather than asserting the outcome without rationale.

**Recommendation**: Add explanation of the height constraint mechanism (`h-full` resolving to flex-1 parent's computed height) in the nested scroll behavior section.

#### IA-002: Dynamic overlay components not analyzed

The following components are rendered conditionally in the mobile layout but are not mentioned in the impact analysis:

- **MobilePromptSheet** (L1840-1849): Conditionally rendered prompt overlay
- **FileViewer modal** (L1851+): Full-screen file viewer opened on file select
- **ToastContainer**: Toast notifications

All of these use fixed/absolute positioning and are therefore unaffected by the main container's overflow change. However, the design document should explicitly note this to demonstrate completeness of the analysis.

**Recommendation**: Add a "Dynamic/Overlay Components" subsection to Section 6 confirming these elements are unaffected.

#### IA-003: Test strategy lacks automated scroll regression detection

The unit test plan checks only for CSS class presence (`overflow-y-auto` applied, `pb-32` absent). While this is correct for verifying the code change, it cannot detect actual scroll behavior regressions. The manual QA checklist says "all 5 tabs scroll check" but lacks specific acceptance criteria (e.g., minimum file count, scroll-to-bottom verification).

**Recommendation**: Expand manual QA checklist with concrete test scenarios. Consider adding a Playwright E2E test with mobile viewport that verifies scroll-to-end behavior on the files tab.

### nice_to_have (3 items)

#### IA-004: Consider overscroll-behavior for scroll chaining prevention

With nested scroll containers (main `overflow-y-auto` containing child `overflow-y-auto` elements), scroll chaining can occur when the inner container reaches its scroll boundary. Adding `overscroll-behavior: contain` to inner scroll containers would prevent this. Not a regression from the current state (which clips content entirely), but worth noting as a UX enhancement.

#### IA-005: Landscape paddingBottom analysis incomplete

The design document notes `paddingBottom: calc(8rem + safe-area)` may occupy ~36% in landscape mode. With `overflow-y-auto`, this padding area becomes scrollable (users can scroll past it), which is actually an improvement over `overflow-hidden` where content was permanently clipped. This positive outcome should be documented in the tradeoffs section.

#### IA-006: BranchMismatchAlert layout shift not mentioned

BranchMismatchAlert is rendered as a sibling of `<main>` inside the outer flex column (L1677-1686). When it appears/disappears, the available height for `<main>` changes, which shifts the threshold at which `overflow-y-auto` activates scrolling. This is not a problem but should be acknowledged as a known dynamic behavior.

## Accuracy Assessment of Specific Review Questions

### 1. Are there missed impact areas?

Two areas are not covered:
- Dynamic overlay components (MobilePromptSheet, FileViewer) -- low risk but should be listed for completeness
- BranchMismatchAlert's effect on main container height -- cosmetic gap

### 2. Is the nested scroll behavior analysis complete and accurate?

Partially. The conclusion is correct (child components will scroll internally), but the mechanism explanation is incomplete. The document does not explain why `h-full` on child components prevents dual scrolling within a `flex-1 overflow-y-auto` parent. The history tab's wrapper div uses `h-full flex flex-col` with `flex-1 min-h-0` on sub-components, which is the correct pattern and works as described. The terminal tab uses only `h-full`, which also works but for a different reason (single content block with its own overflow).

### 3. Could the overflow change affect touch event handling on mobile?

No significant risk. The change from `overflow-hidden` to `overflow-y-auto` enables native browser scrolling on the main container. This uses the browser's built-in touch scroll handling. Since child components already have their own `overflow-y-auto`/`overflow-auto`, touch events will be captured by the innermost scrollable element first (standard browser behavior). There is no custom touch event handling in the affected components that would conflict.

### 4. Are there edge cases with dynamically shown/hidden elements?

- **NavigationButtons**: Rendered inside the fixed MessageInput container (L1812-1818), outside `<main>`. Its appearance/disappearance does not affect `<main>`'s scroll area. The design document's manual QA covers "NavigationButtons display padding check." This is adequate.
- **BranchMismatchAlert**: Rendered outside `<main>` as a flex sibling. Its conditional rendering changes `<main>`'s available height but does not cause functional issues. Not covered in the design document.
- **MobilePromptSheet**: Fixed/overlay positioning, no interaction with main's overflow. Not covered in the design document.

### 5. Is the test strategy adequate to catch regressions?

Partially adequate. Class-based unit tests verify the code change was applied correctly. Manual QA covers behavioral verification. However, there are no automated tests for actual scroll behavior, which means future CSS refactoring could reintroduce the same bug without detection. For a CSS-only change of this scope, the current strategy is acceptable but could be strengthened with E2E tests.

## Conclusion

The design policy document demonstrates a thorough understanding of the problem and proposes a minimal, correct fix. The impact analysis correctly identifies the five affected mobile tabs and their expected behaviors. The gaps identified are primarily documentation completeness issues (missing dynamic component analysis, incomplete scroll mechanism explanation) and test strategy improvements. None of the findings represent a risk of functional regression.

---

*Reviewed by architecture-review-agent (Stage 3: Impact Analysis)*
