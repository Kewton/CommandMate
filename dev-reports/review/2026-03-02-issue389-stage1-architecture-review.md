# Architecture Review: Issue #389 - MarkdownEditor Auto-Save (Stage 1: Design Principles)

**Issue**: #389
**Stage**: 1 - Normal Review (Design Principles)
**Date**: 2026-03-02
**Design Doc**: `dev-reports/design/issue-389-auto-save-design-policy.md`
**Status**: Conditionally Approved

---

## Executive Summary

The design policy for Issue #389 (MarkdownEditor Auto-Save) is well-structured and demonstrates strong adherence to KISS, DRY, and YAGNI principles. The decision to reuse the existing `useAutoSave` and `useLocalStorageState` hooks is sound and minimizes implementation risk. The design correctly identifies key edge cases (initialValueRef, error fallback, beforeunload) and provides clear mitigation strategies.

**Overall Score: 4/5**

| Priority | Count |
|----------|-------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 4 |

---

## Detailed Findings

### Must Fix (1 item)

#### DR1-003: initialValueRef edge case mitigation needs test coverage reinforcement

**Category**: Consistency
**Severity**: High

**Description**:
Section 8.3 of the design document correctly identifies the `initialValueRef` edge case in `useAutoSave`, where the initial value is captured at mount time and used to skip the first save. The proposed mitigation (calling `saveNow()` on toggle ON when `isDirty=true`) is sound. However, the coverage of this mitigation is incomplete.

The `useAutoSave` hook stores the initial value at mount time (`initialValueRef = useRef(value)` at line 88 of `useAutoSave.ts`). When the component mounts, `content` is initially an empty string (before `loadContent` completes), so `initialValueRef.current` will be `''`. After file loading, `content` changes to the file contents. If the user then edits and toggles auto-save ON, `value !== initialValueRef.current` will be true, and the debounce timer will fire correctly. However, if the user clears all content (making `content === ''`), this matches `initialValueRef.current` and auto-save will not trigger.

**Relevant Code** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts`, lines 86-88):
```typescript
// Track the initial value to detect changes
const initialValueRef = useRef(value);
```

**Relevant Code** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-389/src/hooks/useAutoSave.ts`, lines 180-184):
```typescript
useEffect(() => {
    // Don't save on initial render
    if (value === initialValueRef.current) {
      return;
    }
```

**Suggestion**:
1. Add test cases for the following scenarios:
   - File loaded -> edit to non-empty -> toggle auto-save ON -> verify saveNow() fires
   - File loaded -> clear all content -> toggle auto-save ON -> verify saveNow() fires (via handleAutoSaveToggle's isDirty check)
   - Auto-save ON from mount with disabled=true -> loadContent completes -> disabled changes to false
2. Explicitly document in the design that `handleAutoSaveToggle` with `isDirty` check is the **authoritative** save trigger for the ON-toggle scenario, not `useAutoSave`'s internal debounce effect.

---

### Should Fix (3 items)

#### DR1-001: onSaveComplete callback may reference stale content state

**Category**: SRP
**Severity**: Medium

**Description**:
In Section 4.3, the `onSaveComplete` callback calls `setOriginalContent(content)`, where `content` is the React state captured at render time. However, `useAutoSave` calls `onSaveComplete` after `saveFnRef.current(valueToSave)` succeeds (line 133 of `useAutoSave.ts`). The value actually saved is `valueToSave` (from `valueRef.current`), which may differ from `content` if the user continued typing during the save operation.

This creates a timing mismatch: `originalContent` is set to the current `content` state (which includes edits made during save), while the actual saved value was the older `valueToSave`. This causes `isDirty` to become `false` prematurely, making the user believe all changes are saved when they are not.

**Relevant Code** (Design doc Section 4.3):
```typescript
onSaveComplete: () => {
    // dirty state -- onSave is not called during auto-save
    setOriginalContent(content);  // <-- captures content at render time, not the saved value
},
```

**Suggestion**:
Move `setOriginalContent(valueToSave)` into `saveToApi` directly, or extend `useAutoSave`'s `onSaveComplete` to pass the saved value as an argument. The simplest approach without modifying `useAutoSave`:

```typescript
const saveToApi = useCallback(
  async (valueToSave: string): Promise<void> => {
    const response = await fetch(...);
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error?.message || 'Failed to save file');
    }
    // Update originalContent with the actually-saved value
    setOriginalContent(valueToSave);
  },
  [worktreeId, filePath]
);
```

This approach keeps `saveToApi` responsible for the "save succeeded" side effect, which is a reasonable extension of its role.

---

#### DR1-006: handleClose lacks error handling for saveNow() failure

**Category**: Design Pattern
**Severity**: Medium

**Description**:
Section 4.8 defines `handleClose` to `await saveNow()` when auto-save is ON and there are unsaved changes. However, `saveNow()` internally calls `executeSave()` which has retry logic (up to 3 retries with exponential backoff). If all retries fail, `executeSave` sets `error` state but the Promise resolves (it does not reject). The error fallback effect (Section 4.5) then fires, setting `isAutoSaveEnabled = false` and showing a toast.

The problem is that `handleClose` then proceeds to call `onClose?.()` regardless of save failure. The user's editor closes, and unsaved data is lost without an explicit confirmation dialog.

**Relevant Code** (Design doc Section 4.8):
```typescript
const handleClose = useCallback(async () => {
  if (isAutoSaveEnabled) {
    if (isDirty || isAutoSaving) {
      await saveNow();  // <-- if this fails, editor still closes
    }
  } else {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes...');
      if (!confirmed) return;
    }
  }
  onClose?.();  // <-- always called, even after save failure
}, [...]);
```

**Suggestion**:
After `await saveNow()`, check if an error occurred and present a confirmation dialog:

```typescript
const handleClose = useCallback(async () => {
  if (isAutoSaveEnabled) {
    if (isDirty || isAutoSaving) {
      await saveNow();
      // Check if save failed (autoSaveError will be set by useAutoSave)
      // Note: need to check error ref since state may not be updated yet
      if (isDirty) {
        const confirmed = window.confirm('Auto-save failed. Close without saving?');
        if (!confirmed) return;
      }
    }
  } else {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes...');
      if (!confirmed) return;
    }
  }
  onClose?.();
}, [...]);
```

---

#### DR1-009: Ctrl+S with auto-save ON does not trigger file tree refresh

**Category**: Consistency
**Severity**: Low-Medium

**Description**:
Section 4.7 routes Ctrl+S to `saveNow()` when auto-save is ON, and Section 7.2 specifies that auto-save success does not call `onSave()` (to prevent frequent file tree refreshes). However, a deliberate Ctrl+S keystroke is a manual action, not an automatic one. Users pressing Ctrl+S expect the same behavior as clicking the Save button, which includes file tree refresh via `onSave()`.

This creates an inconsistency: in auto-save OFF mode, Ctrl+S triggers `saveContent()` which calls `onSave()`, but in auto-save ON mode, Ctrl+S triggers `saveNow()` which does not call `onSave()`.

**Suggestion**:
In `handleKeyDown`, after `saveNow()` completes, call `onSave?.(filePath)`:

```typescript
if (isAutoSaveEnabled) {
  await saveNow();
  onSave?.(filePath);  // Explicit Ctrl+S should refresh file tree
} else {
  saveContent();
}
```

Alternatively, document this as intentional behavior if file tree refresh during auto-save is considered disruptive.

---

### Nice to Have (4 items)

#### DR1-002: saveContent has 7 useCallback dependencies

**Category**: SRP
**Severity**: Low

The existing `saveContent` function carries 5 responsibilities (guard checks, API call, dirty state update, toast notification, callback notification). While this mirrors the current codebase pattern, the auto-save refactoring creates an opportunity to decompose it. No immediate action required, but consider this for future refactoring.

---

#### DR1-004: Duplicate isDirty OR isAutoSaving guard logic

**Category**: DRY
**Severity**: Low

The condition `isDirty || isAutoSaving` appears in both `beforeunload` handler (Section 4.6) and `handleClose` (Section 4.8). Extract a shared computed value:

```typescript
const hasUnsavedWork = isAutoSaveEnabled ? (isDirty || isAutoSaving) : isDirty;
```

---

#### DR1-005: Error fallback useEffect double-fire theoretical risk

**Category**: KISS
**Severity**: Low

The error fallback effect in Section 4.5 is conditioned on `autoSaveError && isAutoSaveEnabled`. React batch updates should prevent double-firing, but adding a test case for this scenario is recommended for confidence.

---

#### DR1-008: Future extensibility of auto-save settings

**Category**: OCP
**Severity**: Low

The boolean localStorage value for auto-save setting is appropriate for current requirements. If future features need debounce interval customization, the storage format will need to migrate to an object type. This is correctly deferred per YAGNI.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | onSaveComplete stale content reference (DR1-001) | Medium - isDirty shows false incorrectly | Medium | P2 |
| Technical | initialValueRef edge case with empty content (DR1-003) | Medium - auto-save may not trigger | Low | P2 |
| Operational | handleClose data loss on saveNow failure (DR1-006) | High - user loses unsaved data | Low | P2 |
| Technical | Ctrl+S inconsistency between auto-save ON/OFF (DR1-009) | Low - UX inconsistency | Medium | P3 |

---

## Design Principles Compliance

| Principle | Status | Notes |
|-----------|--------|-------|
| SRP | Pass (with notes) | saveToApi/saveContent separation is good; onSaveComplete side effect placement needs refinement |
| OCP | Pass | Existing useAutoSave hook extended via configuration, not modification |
| LSP | N/A | No inheritance hierarchy involved |
| ISP | Pass | useAutoSave interface is appropriately scoped |
| DIP | Pass | MarkdownEditor depends on useAutoSave abstraction, not implementation details |
| KISS | Pass | Design avoids new hook creation; reuses established patterns |
| YAGNI | Pass | i18n skipped, server-side settings skipped, debounce customization skipped |
| DRY | Pass (with minor note) | MemoCard pattern reuse; minor guard logic duplication noted in DR1-004 |

---

## Positive Design Aspects

1. **Excellent hook reuse**: The decision to reuse `useAutoSave` and `useLocalStorageState` without modification demonstrates mature judgment about code reuse vs. abstraction.

2. **Thorough edge case analysis**: Section 8.3 (initialValueRef), Section 8.2 (saveFn parameter usage), and the error fallback design show careful analysis of timing and state synchronization issues.

3. **Performance-conscious design**: The decision to not call `onSave()` during auto-save (Section 7.2) prevents unnecessary file tree refreshes, which is a thoughtful optimization.

4. **Clear UI state transitions**: Section 5.4's indicator state table provides unambiguous mapping between internal state and UI display.

5. **Minimal change footprint**: Only 3 files modified (MarkdownEditor.tsx, markdown-editor.ts, test file), with 0 changes to existing hooks.

---

## Conclusion

The design policy is **conditionally approved**. The 1 Must Fix item (DR1-003: test coverage for initialValueRef edge cases) should be addressed before implementation begins. The 3 Should Fix items (DR1-001, DR1-006, DR1-009) should be resolved during implementation. The overall architecture is sound, the hook reuse strategy is appropriate, and the security/performance considerations are adequate.

---

*Generated by architecture-review-agent for Issue #389*
*Stage 1: Normal Review - Design Principles*
*Date: 2026-03-02*
