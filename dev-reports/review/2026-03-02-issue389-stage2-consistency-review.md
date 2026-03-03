# Architecture Review Report: Issue #389 - Stage 2 Consistency Review

## Overview

| Item | Value |
|------|-------|
| Issue | #389: MarkdownEditor Auto-Save |
| Stage | 2: Consistency Review |
| Focus | Design document vs actual implementation consistency |
| Date | 2026-03-02 |
| Status | Conditionally Approved |
| Score | 4/5 |

## Executive Summary

The design policy document for Issue #389 demonstrates a high degree of consistency with the actual codebase. The useAutoSave and useLocalStorageState hook APIs are accurately described, localStorage key naming follows established patterns, and the overall architecture aligns with existing implementation structures. Two Must Fix items were identified: a code snippet inconsistency within the design document itself (DR2-001) and a timing edge case in handleClose that needs documentation (DR2-002). Four Should Fix items address accuracy improvements regarding MemoCard pattern claims, ESLint dependency arrays, and debounce configuration tracking.

## Detailed Findings

### Must Fix (2 items)

#### DR2-001: onSaveComplete code snippet inconsistency between Section 4.3 and DR1-001 note

**Category**: API Consistency

**Actual Implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts`, Line 32):
```typescript
onSaveComplete?: () => void;
```

The `onSaveComplete` callback takes zero arguments. At Line 133:
```typescript
onSaveCompleteRef.current?.();
```

**Design Document (Section 4.3, Line 151-154)**:
```typescript
onSaveComplete: () => {
  setOriginalContent(content);  // <-- references closure content, not savedValue
},
```

**Design Document (DR1-001 note, Line 166-178)**:
```typescript
const saveToApi = useCallback(
  async (valueToSave: string): Promise<void> => {
    // ...
    setOriginalContent(valueToSave);  // <-- correct: uses saveFn parameter
  },
  [worktreeId, filePath]
);
```

**Issue**: The design document has two conflicting versions of the same code. Section 4.3 still contains the pre-DR1-001 version with `onSaveComplete`, while the DR1-001 note block contains the corrected version. Implementers may follow the wrong version.

**Recommendation**: Unify Section 4.2 and Section 4.3 code to reflect the DR1-001 corrected approach. Remove the `onSaveComplete` property from the useAutoSave call in Section 4.3, and update Section 4.2's saveToApi to include `setOriginalContent(valueToSave)`.

---

#### DR2-002: handleClose timing issue when error fallback fires before saveNow completes

**Category**: Interface Consistency

**Actual Implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts`):

- `saveNow` (Line 170-175): checks `if (disabled) return;` at the start
- `executeSave` (Line 117-155): sets error state after retry exhaustion, does NOT reject the Promise
- The `disabled` parameter gates `saveNow` - if disabled becomes true mid-flight, the next `saveNow` call will be a no-op

**Current MarkdownEditor** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MarkdownEditor.tsx`, Line 306):
```typescript
const handleClose = useCallback(() => {
  if (isDirty) {
    const confirmed = window.confirm('You have unsaved changes...');
    if (!confirmed) return;
  }
  if (onClose) { onClose(); }
}, [isDirty, onClose]);
```

**Design Document (Section 4.8)**: Proposes async handleClose with `await saveNow()` followed by `autoSaveError` check.

**Issue**: If the error fallback useEffect (Section 4.5) fires during or after `saveNow()`, it sets `isAutoSaveEnabled = false`, which makes `disabled = !isAutoSaveEnabled = true`. A subsequent `saveNow()` call would be gated by the `disabled` check. In practice, since `saveNow()` is already in-flight when the error occurs, the `executeSave` call completes (it does not check `disabled` mid-execution). However, the design document does not document this subtlety. The `autoSaveError` post-check will still work correctly because `executeSave` sets the error state before returning.

**Recommendation**: Add a note in Section 4.8 explaining that saveNow()'s disabled check only applies at invocation time, not during execution. The current design is functionally correct but the timing interaction should be documented for implementer clarity. Add a test case covering: "error fallback fires, then handleClose is called - saveNow is a no-op due to disabled=true, autoSaveError is already set, confirm dialog appears."

---

### Should Fix (4 items)

#### DR2-003: MemoCard does not use disabled parameter -- "MemoCard pattern" claim is partially inaccurate

**Category**: Pattern Consistency

**MemoCard Implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/components/worktree/MemoCard.tsx`, Line 90-111):
```typescript
const { isSaving: isSavingTitle, error: titleError, saveNow: saveTitle } = useAutoSave({
  value: title,
  saveFn: async (value) => { await onUpdate(memo.id, { title: value }); },
});
```

MemoCard does not pass `disabled`, `debounceMs`, or `onSaveComplete`. The design document references "MemoCard pattern" as proven, but the dynamic `disabled` toggle (true to false and vice versa) is unique to the MarkdownEditor use case with no prior precedent in this codebase.

**Recommendation**: Update design document references to clarify: "useAutoSave's basic pattern (value/saveFn) is proven in MemoCard. The disabled dynamic toggle is new behavior specific to this implementation and requires dedicated test coverage."

---

#### DR2-004: debounceMs default vs explicit specification

**Category**: API Consistency

useAutoSave default `debounceMs` is 300ms (Line 68). Design document correctly specifies `AUTO_SAVE_DEBOUNCE_MS = 3000`. MemoCard relies on the default (300ms) without explicit specification. The design document's comparison ("MemoCard's 300ms") is accurate but depends on an implicit default rather than an explicit constant.

**Recommendation**: No change to design document needed. Add to implementation checklist: "Verify AUTO_SAVE_DEBOUNCE_MS = 3000 is explicitly passed to useAutoSave."

---

#### DR2-005: localStorage key naming is fully consistent

**Category**: Constant Consistency

Existing pattern:
- `commandmate:md-editor-view-mode`
- `commandmate:md-editor-split-ratio`
- `commandmate:md-editor-maximized`

Proposed:
- `commandmate:md-editor-auto-save`

**Assessment**: Perfect alignment with existing naming convention. No changes needed.

---

#### DR2-006: saveToApi dependency array missing setOriginalContent (ESLint warning risk)

**Category**: Type Consistency

The DR1-001 corrected saveToApi calls `setOriginalContent(valueToSave)` inside useCallback but dependency array is `[worktreeId, filePath]`. While React useState setters are stable references, the ESLint `react-hooks/exhaustive-deps` rule may flag this.

**Recommendation**: Include `setOriginalContent` in the dependency array: `[worktreeId, filePath, setOriginalContent]`. This has no runtime impact but prevents lint warnings.

---

### Nice to Have (3 items)

#### DR2-007: isSaving naming and test implications

The existing `isSaving` state (manual save) coexists with `isAutoSaving` (from useAutoSave). Existing tests (Save Operations section) implicitly assume auto-save OFF. When auto-save is ON, the save-button is hidden. Tests should be annotated with their auto-save mode assumption.

#### DR2-008: useLocalStorageState validate parameter usage

The design correctly reuses `isValidBoolean` from `src/types/markdown-editor.ts` (Line 259-261), matching the pattern used for `LOCAL_STORAGE_KEY_MAXIMIZED`. No changes needed.

#### DR2-009: saveNow() Promise behavior documentation

The design document accurately documents that `saveNow()` resolves (never rejects) and error state must be checked via `autoSaveError`. This matches the implementation at Line 117-155 of useAutoSave.ts. No changes needed.

---

## Consistency Matrix

| Design Item | Design Document | Implementation | Verdict |
|------------|----------------|----------------|---------|
| useAutoSave.value | `value: content` | Generic `T` parameter | Consistent |
| useAutoSave.saveFn | `saveFn: saveToApi` where `saveToApi(valueToSave: string)` | `saveFn: (value: T) => Promise<void>` | Consistent |
| useAutoSave.debounceMs | `AUTO_SAVE_DEBOUNCE_MS = 3000` | Default 300, accepts custom value | Consistent |
| useAutoSave.disabled | `disabled: !isAutoSaveEnabled` | `disabled?: boolean` (default false) | Consistent |
| useAutoSave.onSaveComplete | Used in Section 4.3 (pre-fix) / Removed in DR1-001 note | `onSaveComplete?: () => void` | Inconsistent (DR2-001) |
| useAutoSave.maxRetries | Not specified (default 3) | `maxRetries?: number` (default 3) | Consistent |
| useAutoSave return: isSaving | `isSaving: isAutoSaving` | `isSaving: boolean` | Consistent |
| useAutoSave return: error | `error: autoSaveError` | `error: Error \| null` | Consistent |
| useAutoSave return: saveNow | `saveNow` used in toggle/close/keydown | `saveNow: () => Promise<void>` | Consistent |
| useLocalStorageState options | `{ key, defaultValue, validate }` | `UseLocalStorageStateOptions<T>` | Consistent |
| useLocalStorageState return | `{ value, setValue }` | `{ value, setValue, removeValue, isAvailable }` | Consistent (subset) |
| localStorage key naming | `commandmate:md-editor-auto-save` | `commandmate:md-editor-*` pattern | Consistent |
| isValidBoolean | Reused from types/markdown-editor | Exists at Line 259-261 | Consistent |
| MemoCard disabled usage | "MemoCard pattern" referenced | MemoCard does not use disabled | Partially inconsistent (DR2-003) |
| isDirty computation | `content !== originalContent` | Line 189: `content !== originalContent` | Consistent |
| setOriginalContent | Used as state setter | `useState` setter at Line 116 | Consistent |
| showToast | Used for notifications | From `useToast()` at Line 136 | Consistent |
| onSave callback | `onSave?: (filePath: string) => void` | EditorProps Line 83 | Consistent |
| beforeunload handler | Modified for auto-save | Existing at Lines 450-473 | Consistent |
| handleClose | Modified to async | Existing at Lines 306-316 | Consistent |
| handleKeyDown (Ctrl+S) | Modified for auto-save branch | Existing at Lines 363-387 | Consistent |

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Implementation | Code snippet inconsistency (DR2-001) leading to wrong pattern adoption | Medium | Medium | P1 |
| Technical | handleClose timing with error fallback (DR2-002) | Low | Low | P2 |
| Quality | MemoCard pattern claim inaccuracy (DR2-003) may reduce test coverage for disabled toggle | Medium | Low | P2 |
| Quality | ESLint warning from dependency array (DR2-006) | Low | High | P3 |

## Conclusion

The design policy document for Issue #389 demonstrates strong consistency with the actual codebase. The useAutoSave and useLocalStorageState APIs are accurately understood and correctly applied. The primary concern (DR2-001) is an internal inconsistency within the design document itself -- the pre-fix and post-fix versions of saveToApi/onSaveComplete coexist in different sections. Once the code snippets are unified to reflect the DR1-001 resolution, the design is ready for implementation. The remaining findings are accuracy improvements that strengthen the document as an implementation guide.

---

*Generated by architecture-review-agent for Issue #389*
*Stage: 2 - Consistency Review*
*Date: 2026-03-02*
