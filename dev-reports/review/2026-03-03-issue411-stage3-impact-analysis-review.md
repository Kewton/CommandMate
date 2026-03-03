# Architecture Review Report: Issue #411 - Stage 3 Impact Analysis

## Overview

| Item | Value |
|------|-------|
| Issue | #411 |
| Stage | 3 - Impact Analysis Review |
| Focus | Impact Scope (影響範囲) |
| Date | 2026-03-03 |
| Status | conditionally_approved |
| Score | 4/5 |
| Design Document | `dev-reports/design/issue-411-react-memo-optimization-design-policy.md` |

## Executive Summary

The design document provides thorough impact analysis for React.memo/useCallback optimization of 8 components in the WorktreeDetailRefactored subtree. The props stability analysis tables, cascade re-generation chains (R2-001, R1-008), and the 27-item dependency array documentation for leftPaneMemo are particularly well-crafted. However, three should_fix items were identified:

1. Integration test files are missing from the test impact scope
2. The MobileContent component's fileSearch object reference instability is not addressed
3. handlePromptRespond's cascade influence chain is not analyzed

No must_fix items were found. The design is sound overall and can proceed to implementation with the should_fix items addressed.

---

## Impact Scope Analysis

### Directly Changed Files

| File | Change | Risk | Notes |
|------|--------|------|-------|
| `src/components/worktree/MessageInput.tsx` | memo() + 9 useCallback handlers | Medium | Largest change. submitMessage has 6-item dependency array |
| `src/components/worktree/SlashCommandSelector.tsx` | memo() wrap | Low | Already uses useCallback/useMemo internally |
| `src/components/worktree/InterruptButton.tsx` | memo() wrap | Low | Simple props, already uses useCallback |
| `src/components/worktree/PromptPanel.tsx` | memo() wrap | Low | Conditional render limits effectiveness |
| `src/components/mobile/MobilePromptSheet.tsx` | memo() wrap | Low | Only mounted when autoYesEnabled=false |
| `src/components/worktree/MarkdownEditor.tsx` | memo() wrap | Low | Conditional render (editorFilePath), YAGNI candidate |
| `src/components/worktree/FileViewer.tsx` | memo() wrap | Low | Primary benefit: skip render when isOpen=false |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | leftPane/rightPane useMemo | Medium | 27-item dependency array needs precision |

### Indirectly Affected Files

| Category | File | Impact | Risk |
|----------|------|--------|------|
| Unit Test | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | vi.mock replaces 6 components; memo transparent | Low |
| Unit Test | `tests/unit/components/worktree/MessageInput.test.tsx` | Direct import; IME composition tests (5 cases) need verification | Low |
| Unit Test | `tests/unit/components/SlashCommandSelector.test.tsx` | Direct import; no behavioral change | Low |
| Unit Test | `tests/unit/components/PromptPanel.test.tsx` | Direct import; no behavioral change | Low |
| Unit Test | `tests/unit/components/mobile/MobilePromptSheet.test.tsx` | Direct import; no behavioral change | Low |
| Unit Test | `tests/unit/components/MarkdownEditor.test.tsx` | Direct import; no behavioral change | Low |
| **Integration** | **`tests/integration/issue-266-acceptance.test.tsx`** | **vi.mock for MessageInput with mount/unmount counting; vi.mock for FileViewer, PromptPanel, MobilePromptSheet** | **Low** |
| Unit Test | `tests/unit/components/app-version-display.test.tsx` | vi.mock for FileViewer, PromptPanel, MobilePromptSheet | Low |

---

## Detailed Findings

### R3-001 [should_fix] - Integration test not listed in impact scope

**Category**: test

The design document Section 5 lists only 6 unit test files as verification targets. However, `tests/integration/issue-266-acceptance.test.tsx` (line 97-109) uses vi.mock to mock MessageInput, FileViewer, PromptPanel, and MobilePromptSheet. Notably, it tracks `messageInputMountCount` and `messageInputUnmountCount` to verify that visibility recovery does not cause unnecessary unmount/remount cycles.

While vi.mock entirely replaces the module (making the memo wrapper transparent), the completeness of impact analysis requires listing all test files that reference the changed components.

Additionally, `tests/unit/components/app-version-display.test.tsx` mocks FileViewer, PromptPanel, and MobilePromptSheet.

**Recommendation**: Add both files to Section 5's verification targets table.

### R3-002 [should_fix] - MobileContent fileSearch object reference instability

**Category**: performance

`MobileContent` (line 824, already `memo`-wrapped) receives `fileSearch` as a single object prop (line 2245: `fileSearch={fileSearch}`). The `useFileSearch` hook returns a plain object literal on every render (useFileSearch.ts lines 243-254) without `useMemo` stabilization. This means `MobileContent`'s memo is invalidated on every parent re-render, including polling cycles.

The design document addresses this for the desktop `leftPaneMemo` by destructuring fileSearch properties into the useMemo dependency array (Section D4). However, the mobile path through `MobileContent` is not covered.

**Code evidence**:

```typescript
// useFileSearch.ts lines 243-254 - returns new object every render
return {
  query,
  mode,
  isSearching,
  results,
  error,
  setQuery,
  setMode,
  clearSearch,
  filterByName,
  getMatchedPaths,
};
```

```typescript
// WorktreeDetailRefactored.tsx line 2245 - passes unstable reference
<MobileContent
  ...
  fileSearch={fileSearch}  // new object reference every render
  ...
/>
```

**Recommendation**: Either (A) stabilize useFileSearch return value with useMemo, or (B) note that MobileContent's memo ineffectiveness for fileSearch is an existing pre-Issue-411 problem outside this scope, and document it as a known limitation.

### R3-003 [should_fix] - handlePromptRespond cascade chain not analyzed

**Category**: maintenance

The design document's cascade analysis covers:
- `fetchCurrentOutput` -> `handleMessageSent` -> `MessageInput.onMessageSent` (Section [R2-001])

But does not cover:
- `state.prompt.data` change -> `handlePromptRespond` re-creation -> `PromptPanel.onRespond` / `MobilePromptSheet.onRespond` props change -> memo invalidation

`handlePromptRespond` (line 1233-1258) has dependency array `[worktreeId, actions, fetchCurrentOutput, activeCliTab, state.prompt.data]`. When `state.prompt.data` changes (prompt detection), `handlePromptRespond` is re-created, which cascades to both `PromptPanel` (line 2039) and `MobilePromptSheet` (line 2286).

This cascade occurs only during prompt state transitions (not polling cycles), so it does not undermine the optimization goal. However, for completeness of the cascade analysis documentation, it should be recorded.

**Recommendation**: Add handlePromptRespond cascade chain analysis alongside [R2-001].

### R3-004 [nice_to_have] - handleAutoYesToggle re-created on CLI tab switch

**Category**: performance

`handleAutoYesToggle` (line 1293-1314) includes `activeCliTab` in its dependency array. CLI tab switches cause re-creation, which invalidates `AutoYesToggle`'s memo. The existing `activeCliTabRef` pattern (used for `fetchMessages`/`fetchCurrentOutput`) could be applied here as well.

Tab switches are low-frequency user-initiated actions, so the practical impact is minimal.

### R3-005 [nice_to_have] - MemoExoticComponent type change documentation

**Category**: type

Components wrapped with `memo()` change their TypeScript type from `React.FunctionComponent` to `React.MemoExoticComponent`. Named export form preserves import compatibility. `MemoExoticComponent` is compatible with `ComponentType<Props>` for JSX usage. No incompatible usage patterns were found in the codebase. A brief note in Section 10 would be informative.

### R3-006 [nice_to_have] - React Strict Mode testing note

**Category**: test

React Strict Mode (development only) double-invokes function components. memo'd components handle this correctly (same props on both invocations results in skip). However, incorrect useCallback/useMemo dependency arrays could manifest as bugs in Strict Mode. The design document could recommend verifying behavior in the development server with Strict Mode enabled.

### R3-007 [nice_to_have] - leftPaneMemo 27-item dependency array maintenance risk

**Category**: maintenance

The 27-item dependency array for leftPaneMemo relies on eslint-plugin-react-hooks exhaustive-deps rule for validation. This is adequate for static analysis but does not produce compile-time errors. Future modifications to the leftPane JSX that add new state/props dependencies could easily miss the dependency array update. A code comment marking the dependency array as a maintenance-sensitive section would help.

### R3-008 [nice_to_have] - SSR/RSC boundary clarification

**Category**: performance

Section 10 correctly states all targets are `'use client'` components. The analysis could be strengthened by noting that `WorktreeDetailRefactoredProps` contains only serializable primitives (`worktreeId: string`), confirming no issues at the Server Component / Client Component boundary.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | memo/useCallback are well-understood React primitives. Named export pattern preserves all existing import paths. |
| Security | Low | No security-related changes. memo is a pure rendering optimization. |
| Operational | Low | No API, database, or infrastructure changes. All changes are client-side rendering optimizations. |

---

## Test Impact Verification Matrix

| Test File | Mock Pattern | memo Impact | Verification Status |
|-----------|-------------|-------------|-------------------|
| WorktreeDetailRefactored.test.tsx | vi.mock (module replace) | Transparent | Pass (mock replaces entire module) |
| MessageInput.test.tsx | Direct render | Transparent | Needs IME 5-case verification |
| SlashCommandSelector.test.tsx | Direct render | Transparent | Pass |
| PromptPanel.test.tsx | Direct render | Transparent | Pass |
| MobilePromptSheet.test.tsx | Direct render | Transparent | Pass |
| MarkdownEditor.test.tsx | Direct render | Transparent | Pass |
| issue-266-acceptance.test.tsx | vi.mock (module replace) + mount count | Transparent | Pass (mount counting on mock, not real component) |
| app-version-display.test.tsx | vi.mock (module replace) | Transparent | Pass |

**Conclusion**: All 8 test files use either vi.mock (full module replacement, memo-transparent) or direct render (named export preserved). No test modifications are expected.

---

## vi.mock Compatibility Analysis

The design chooses `export const X = memo(function X(...))` pattern. Here is why vi.mock remains compatible:

```typescript
// Source file (after memo)
export const MessageInput = memo(function MessageInput(props: Props) { ... });

// Test file mock (unchanged)
vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: (props: any) => <div>Mock</div>,
}));
```

`vi.mock` replaces the **entire module** at the import resolution level. The test code imports `{ MessageInput }` which resolves to the mock factory's return value. The original module's `memo()` wrapper is never loaded. Therefore:

1. `export const` vs `export function` - both produce a named export; vi.mock is indifferent
2. `React.MemoExoticComponent` type - vi.mock returns whatever the factory provides; no type checking at runtime
3. `displayName` / DevTools name - irrelevant to test execution

---

## Improvement Recommendations

### Should Fix (before implementation)

1. **R3-001**: Add `tests/integration/issue-266-acceptance.test.tsx` and `tests/unit/components/app-version-display.test.tsx` to Section 5 verification targets
2. **R3-002**: Document MobileContent's fileSearch reference instability and determine if it is in-scope or out-of-scope for Issue #411
3. **R3-003**: Add handlePromptRespond cascade chain analysis to complement [R2-001]

### Nice to Have (future consideration)

4. **R3-004**: Consider activeCliTabRef for handleAutoYesToggle
5. **R3-005**: Note MemoExoticComponent compatibility in Section 10
6. **R3-006**: Recommend Strict Mode testing in Section 5
7. **R3-007**: Add code comment for leftPaneMemo dependency maintenance
8. **R3-008**: Clarify SSR/RSC boundary non-impact in Section 10

---

## Approval

**Status**: conditionally_approved (4/5)

The design is well-analyzed with thorough props stability tables and cascade chain documentation. The three should_fix items are documentation completeness improvements that do not require architectural changes. Implementation can proceed once these items are reflected in the design document.
