# Architecture Review Report: Issue #411 - Stage 1 (Design Principles)

## Executive Summary

| Item | Detail |
|------|--------|
| Issue | #411 - React memo/useCallback Optimization |
| Stage | 1 - Design Principles Review |
| Date | 2026-03-03 |
| Status | Conditionally Approved |
| Score | 4/5 |

Issue #411 proposes memo/useCallback optimization for 8 React components to reduce unnecessary re-renders caused by 2-second terminal polling. The design document is well-structured, with clear rationale for each design decision, explicit tradeoff analysis, and adherence to existing project patterns. The named export memo pattern (`export const X = memo(function X(...))`) is consistent with 25+ existing components already using this pattern in the codebase.

Four should-fix items were identified, primarily around documentation completeness for dependency array analysis and accuracy of effect descriptions. No must-fix items were found. The overall technical risk is low since the changes are purely internal React optimizations with no functional behavior changes.

---

## Design Principles Checklist

### SOLID Principles

| Principle | Compliance | Notes |
|-----------|-----------|-------|
| Single Responsibility | Pass | Each component retains its existing SRP. memo() wrapping does not alter responsibility boundaries. |
| Open/Closed | Pass | Existing components are extended (wrapped) without modification of their internal behavior. |
| Liskov Substitution | N/A | No inheritance hierarchy involved. |
| Interface Segregation | Pass | Props interfaces remain unchanged. No unnecessary props introduced. |
| Dependency Inversion | Pass | No new dependencies introduced. |

### KISS Principle

| Item | Compliance | Notes |
|------|-----------|-------|
| No custom comparison functions | Pass | All memo() wraps use default shallow comparison. Design document explicitly rejects custom areEqual functions with clear rationale. |
| useMemo over component extraction for panes | Pass with caveats | leftPane useMemo has 27 dependency items, which adds maintenance complexity. The tradeoff (vs 20+ props component extraction) is well-documented but warrants caution. |
| Uniform pattern across all components | Pass | Single D1 pattern applied consistently. |

### YAGNI Principle

| Item | Compliance | Notes |
|------|-----------|-------|
| MarkdownEditor memo | Caution | Memo wrapping a conditionally-rendered component (mounted only when editorFilePath is truthy) provides near-zero benefit. Consider omitting per YAGNI. |
| No new tests added | Pass | Appropriate decision - memo is a React internal optimization with no functional impact. |
| No forwardRef consideration | Pass | Correctly scoped out since none of the target components use forwardRef. |

### DRY Principle

| Item | Compliance | Notes |
|------|-----------|-------|
| D1 pattern consistency | Pass | Named export form `export const X = memo(function X(...))` matches 25+ existing instances in the codebase. |
| PromptPanel / MobilePromptSheet duplication | Noted | Both have near-identical internal content components (PromptPanelContent / PromptContent). Out of scope for this issue but identified as future refactoring candidate. |

---

## Detailed Findings

### R1-001: handleFreeInput useCallback - setTimeout ref capture documentation [should_fix]

**Category**: React Best Practice

**Description**: The design document specifies `handleFreeInput` with dependency array `[]`, which is correct since `textareaRef` is a stable Ref object. However, the function uses `setTimeout(() => textareaRef.current?.focus(), 50)` which is a non-obvious pattern when wrapped in useCallback. The design document should explicitly document why this is safe.

**Location**: Design Document Section 4.1, handleFreeInput row

**Suggestion**: Add a "備考" column entry: "setTimeout内のtextareaRef参照はRefオブジェクト（安定参照）のため空依存配列で安全"

---

### R1-002: leftPane useMemo dependency array maintenance risk [should_fix]

**Category**: KISS

**Description**: The leftPaneMemo dependency array contains 27 items (Section D4). While the design document acknowledges this and explains that most handlers are useCallback-stabilized, the array size creates maintenance risk: adding/removing a dependency is error-prone, and `fileSearch.results?.results` with optional chaining creates a reference instability vector (transitions between null and object cause re-computation).

**Location**: Design Document Section D4

**Suggestion**:
1. Add an explicit table listing each dependency with its stability status (stable ref / useCallback / state).
2. Mandate `eslint-plugin-react-hooks` exhaustive-deps rule verification during implementation.
3. Consider decomposing `fileSearch.results?.results` into a separate useMemo to stabilize the reference.

---

### R1-003: PromptPanel/MobilePromptSheet internal logic duplication [nice_to_have]

**Category**: DRY

**Description**: `PromptPanelContent` (PromptPanel.tsx L66-194) and `PromptContent` (MobilePromptSheet.tsx L207-313) contain nearly identical logic for `selectedOption` state management, `handleYesNoClick`, and `handleMultipleChoiceSubmit`. This is out of scope for Issue #411 but should be noted as a future DRY improvement opportunity.

**Location**: Design Document Sections 4.4 and 4.5

**Suggestion**: Record as a future refactoring candidate. The current memo-wrapping approach is correct regardless of this duplication.

---

### R1-004: FileViewer memo effectiveness analysis incomplete [should_fix]

**Category**: React Best Practice

**Description**: Section 4.7 states memo's primary effect is "isOpen=false時の再レンダースキップ" but does not analyze the props stability chain. Key facts verified from source:
- `isOpen` = `fileViewerPath !== null` (boolean primitive, stable comparison)
- `onClose` = `handleFileViewerClose` (useCallback with `[]`, stable)
- `worktreeId` = string prop (stable during polling)
- `filePath` = `fileViewerPath ?? ''` (string primitive, `''` is stable via shallow comparison)

All four props are stable during polling cycles, confirming memo is effective. This analysis should be in the design document.

**Location**: Design Document Section 4.7

**Suggestion**: Add a props stability analysis table showing each prop, its source, and stability status.

---

### R1-005: MobilePromptSheet mount/unmount description inaccuracy [nice_to_have]

**Category**: Architecture

**Description**: Section 4.5 states "visibleに関係なくマウントされる", but source code (WorktreeDetailRefactored.tsx L2281-2290) shows `MobilePromptSheet` is rendered conditionally under `!autoYesEnabled &&`. Additionally, internally it returns `null` when `!shouldRender || !promptData` (L133-135). The memo effect window is narrower than described: it only applies when `autoYesEnabled=false`, `promptData` exists, but `visible=false`.

**Location**: Design Document Section 4.5, "備考" column

**Suggestion**: Correct to: "autoYesEnabled=false時は常にコンポーネントがマウントされるが、promptData=null時は内部でnullを返すため、memo化の実効範囲はpromptData存在かつvisible=false時に限定される"

---

### R1-006: MessageInput internal hooks and memo effectiveness [nice_to_have]

**Category**: SOLID (SRP)

**Description**: `MessageInput` internally calls `useSlashCommands(worktreeId, cliToolId)` and `useIsMobile()`. React.memo only prevents re-renders from parent prop changes; internal hook state changes bypass memo. However, during polling cycles, `worktreeId` and `cliToolId` do not change, so `useSlashCommands` will not trigger re-fetches. `useIsMobile()` is based on viewport size which does not change during polling. Therefore memo is effective, but this analysis is missing from the design document.

**Location**: Design Document Section 4.1

**Suggestion**: Add a note: "内部フック(useSlashCommands, useIsMobile)はポーリングサイクルで状態変化しないため、memo化は外部propsのshallow comparison通りに有効に機能する"

---

### R1-007: MarkdownEditor memo provides negligible benefit [nice_to_have]

**Category**: YAGNI

**Description**: MarkdownEditor is rendered conditionally (`{editorFilePath && ...}` at L2061/L2300). When `editorFilePath` is null (the common case), the component is completely unmounted and memo has zero effect. When mounted, it already uses 21 internal useCallbacks. The marginal benefit of wrapping with memo is negligible. Per YAGNI, this could be removed from scope.

**Location**: Design Document Section 4.6

**Suggestion**: Explicitly document that MarkdownEditor is conditionally rendered and memo's only benefit is preventing re-renders while the editor is open during polling. Consider removing from scope as an optional low-value item.

---

### R1-008: submitMessage dependency chain undocumented [should_fix]

**Category**: React Best Practice

**Description**: The design document lists `submitMessage`'s dependency array as `[isComposing, message, sending, worktreeId, cliToolId, onMessageSent]`, with `onMessageSent` as a prop. The stability of this prop chain is critical:
- `onMessageSent` in parent = `handleMessageSent` via `useCallback([fetchMessages, fetchCurrentOutput])`
- `fetchMessages` via `useCallback([worktreeId, actions])`
- `fetchCurrentOutput` via `useCallback([worktreeId, actions, state.prompt.visible])`

The `state.prompt.visible` dependency in `fetchCurrentOutput` means `handleMessageSent` reference changes when prompt visibility changes. This could cause `submitMessage` to be recreated during prompt state transitions. The design document should analyze this chain to confirm it does not create unintended re-render cascades.

**Location**: Design Document Section 4.1, submitMessage row

**Suggestion**: Add a "Props Stability Chain" section documenting the useCallback dependency tree from WorktreeDetailRefactored down to each MessageInput prop. Identify any transitively unstable references.

---

## Risk Assessment

| Risk Type | Level | Detail | Priority |
|-----------|-------|--------|----------|
| Technical | Low | Pure React internal optimization. No functional changes. Existing tests should pass without modification. | P3 |
| Security | Low | No security-related changes. memo/useCallback are React rendering optimizations only. | N/A |
| Operational | Low | No runtime behavior changes. Worst case: memo overhead (microseconds) with no skip benefit if props change every cycle. | P3 |
| Regression | Low | Named export pattern preserves import compatibility. vi.mock compatibility confirmed by pattern matching existing memo'd components. | P3 |

---

## Improvement Recommendations

### Must Fix (0 items)

None.

### Should Fix (4 items)

1. **R1-001**: Document setTimeout ref capture safety in handleFreeInput useCallback design
2. **R1-002**: Add dependency stability table for leftPane useMemo; mandate exhaustive-deps lint verification
3. **R1-004**: Add FileViewer props stability chain analysis
4. **R1-008**: Document submitMessage dependency chain including parent useCallback hierarchy

### Consider (4 items)

1. **R1-003**: Record PromptPanel/MobilePromptSheet content duplication as future DRY candidate
2. **R1-005**: Correct MobilePromptSheet mount/unmount behavior description
3. **R1-006**: Document MessageInput internal hook stability during polling
4. **R1-007**: Consider removing MarkdownEditor from memo scope per YAGNI

---

## Positive Design Decisions

The following design decisions are commended:

1. **Consistent Pattern Selection**: The `export const X = memo(function X(...))` pattern aligns perfectly with 25+ existing components in the codebase, maintaining project-wide consistency.

2. **No Custom Comparison Functions**: The explicit decision to reject `areEqual` custom comparators in favor of upstream useCallback stabilization follows KISS and reduces the cognitive load for future maintainers.

3. **Implementation Order**: The bottom-up ordering (leaf components first, then container) correctly accounts for the dependency chain where memo effectiveness of parent components depends on child prop stability.

4. **Tradeoff Documentation**: Section 9 provides clear decision tables with alternatives and rationale, which is excellent for future architectural decisions.

5. **Test Strategy**: The decision to not add new tests for pure rendering optimizations is appropriate and follows YAGNI.

---

## Reviewed Files

| File | Path |
|------|------|
| Design Document | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/dev-reports/design/issue-411-react-memo-optimization-design-policy.md` |
| MessageInput | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/MessageInput.tsx` |
| SlashCommandSelector | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/SlashCommandSelector.tsx` |
| InterruptButton | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/InterruptButton.tsx` |
| PromptPanel | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/PromptPanel.tsx` |
| MobilePromptSheet | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/mobile/MobilePromptSheet.tsx` |
| MarkdownEditor | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/MarkdownEditor.tsx` |
| FileViewer | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/FileViewer.tsx` |
| WorktreeDetailRefactored | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/components/worktree/WorktreeDetailRefactored.tsx` |
| useFileSearch | `/Users/maenokota/share/work/github_kewton/commandmate-issue-411/src/hooks/useFileSearch.ts` |

---

## Approval

**Status: Conditionally Approved**

The design is sound and ready for implementation with the following conditions:
1. Address the 4 should-fix documentation items (R1-001, R1-002, R1-004, R1-008) before or during implementation
2. Consider the YAGNI feedback on MarkdownEditor (R1-007) -- implementer may decide to include or exclude

No blocking issues were found. The design correctly applies React performance patterns with appropriate scope and conservative approach.
