# Architecture Review: Issue #278 - Consistency Review (Stage 2)

**Issue**: #278 - fetch Data Cache fix and Update Indicator
**Focus Area**: 整合性 (Consistency)
**Stage**: 2 - 整合性レビュー
**Date**: 2026-02-14
**Status**: approved
**Score**: 5/5

---

## Executive Summary

The design policy document for Issue #278 demonstrates strong consistency with the existing codebase in all reviewed dimensions: architecture patterns, naming conventions, error handling, component structure, and testing approaches. The design accurately references existing code locations and patterns, and the proposed changes integrate naturally into the established architecture.

Two minor implementation notes were identified (CSS positioning for DesktopHeader and mixed badge patterns in MobileTabBar), but neither requires design changes -- they are implementation details to be aware of during coding.

---

## Detailed Findings

### 1. Consistency Matrix

| Design Item | Design Document Description | Codebase Status | Consistency | Gap |
|---|---|---|---|---|
| fetch `cache: "no-store"` | Add to version-checker.ts L184 | Existing fetch at L184-190 matches description exactly | High | None |
| NotificationDot component | New in `src/components/common/` | `common/` dir has Toast.tsx, LocaleSwitcher.tsx | High | None |
| DesktopHeader `hasUpdate` prop | Optional boolean prop added to DesktopHeaderProps | Existing pattern: MobileTabBar has `hasNewOutput?`, `hasPrompt?` | High | None |
| MobileTabBar `hasUpdate` prop | Optional boolean prop added to MobileTabBarProps | Existing pattern: `hasNewOutput?`, `hasPrompt?` already present | High | None |
| Props drilling (1 level) | WorktreeDetailRefactored -> DesktopHeader/MobileTabBar | Existing: hasNewOutput/hasPrompt passed same way (L1994-1995) | High | None |
| useUpdateCheck dual call | Both VersionSection and WorktreeDetailRefactored call hook | globalThis cache documented (SF-002); VersionSection L40 already calls it | High | None |
| `bg-blue-500` color choice | Notification dot uses blue | BranchListItem unread indicator uses identical `bg-blue-500` (L113) | High | None |
| Test file locations | Tests in `tests/unit/lib/` and `tests/unit/components/` | Matches existing test directory structure | High | None |

### 2. Architecture Pattern Consistency

#### 2.1 Component Structure

The design follows the established pattern where:

- **Internal sub-components** (DesktopHeader) are defined within WorktreeDetailRefactored.tsx with their own Props interfaces. This matches the existing pattern at line 411-419 of WorktreeDetailRefactored.tsx.
- **Shared components** (NotificationDot) are placed in `src/components/common/`. This matches the existing Toast.tsx and LocaleSwitcher.tsx placement.
- **Feature-specific components** (UpdateNotificationBanner, VersionSection) remain in `src/components/worktree/`.

#### 2.2 Hook Usage Pattern

The design uses the `useUpdateCheck` hook in WorktreeDetailRefactored following the same pattern as other hooks in that component. The hook follows the established `useState`/`useEffect` pattern with cancellation cleanup (L35-61 in `useUpdateCheck.ts`), consistent with React best practices used throughout the codebase.

#### 2.3 Memoization Pattern

The design notes that DesktopHeader is wrapped with `memo()` and MobileTabBar uses `useMemo`/`useCallback`. Adding the `hasUpdate` prop to these memoized components is consistent -- the boolean value change will correctly trigger re-renders only when the update status changes.

### 3. Naming Convention Consistency

| Convention | Existing Examples | Design Proposal | Consistent? |
|---|---|---|---|
| Props interface naming | `MobileTabBarProps`, `DesktopHeaderProps` | Same naming pattern retained | Yes |
| data-testid format | `"unread-indicator"`, `"new-output-badge"`, `"prompt-badge"` | `"info-update-indicator"`, `"info-update-badge"` | Yes |
| aria-label language | English throughout (except one i18n outlier) | English: `"Update available"` | Yes |
| Component file naming | `NotificationBanner.tsx`, `LocaleSwitcher.tsx` | `NotificationDot.tsx` | Yes |
| Boolean prop naming | `hasNewOutput`, `hasPrompt`, `hasUnread` | `hasUpdate` | Yes |
| CSS utility classes | Tailwind utility classes throughout | Same Tailwind patterns | Yes |

### 4. Error Handling Consistency

The design maintains the existing error handling approach:

- **version-checker.ts**: Silent failure with `catch` block returning `cache.result` (L222-224). The `cache: "no-store"` addition does not change this behavior.
- **useUpdateCheck hook**: Error state management with `error` state variable (L46-48).
- **API route**: Returns HTTP 200 with `status: 'degraded'` on error (L150-153). No changes proposed.

This is consistent with the project's approach of graceful degradation for non-critical features (version checking is informational only).

### 5. Testing Approach Consistency

| Aspect | Existing Pattern | Design Proposal | Consistent? |
|---|---|---|---|
| Test framework | Vitest + @testing-library/react | Same | Yes |
| Mock strategy | `vi.stubGlobal('fetch', ...)` | Same for version-checker tests | Yes |
| Component testing | `render()` + `screen.getByTestId()` | Same for MobileTabBar/NotificationDot | Yes |
| Test file location | `tests/unit/lib/`, `tests/unit/components/mobile/` | Same directories | Yes |
| Test description format | `describe/it` with descriptive strings | Same | Yes |
| `@vitest-environment jsdom` | Used in MobileTabBar.test.tsx | Required for NotificationDot tests | Yes |

---

## Should Fix Items

### CONS-SF-001: DesktopHeader Info button needs `relative` class

**Severity**: Medium
**Category**: CSS positioning consistency

The design specifies:
```typescript
<NotificationDot className="absolute top-0 right-0" />
```

However, the existing Info button at `src/components/worktree/WorktreeDetailRefactored.tsx` line 553:
```typescript
className="flex items-center gap-1.5 px-3 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
```

This className does **not** include `relative`. Without it, the `absolute` positioning on NotificationDot will anchor to the nearest positioned ancestor rather than the button itself. The MobileTabBar buttons already include `relative` in their baseStyles (line 118), so the MobileTabBar implementation is correct.

**Recommendation**: During implementation, add `relative` to the Info button's className in DesktopHeader. This is an implementation detail that does not require a design document update, but implementers should be aware.

### CONS-SF-002: Mixed badge rendering patterns within MobileTabBar

**Severity**: Low
**Category**: Component pattern consistency

After this change, MobileTabBar will have two badge rendering approaches:
1. **Terminal tab badges** (hasNewOutput, hasPrompt): Inline `<span>` elements with raw className strings (L133-148)
2. **Info tab badge** (hasUpdate): `NotificationDot` component

This is acceptable for Issue #278's scope. The design document correctly notes that unifying existing badges to use NotificationDot is out of scope but recommended for future work.

---

## Consider Items

### CONS-C-001: aria-label English-only pattern confirmed

All reviewed aria-label values across `src/components/` use hardcoded English strings. The only exception is `UpdateNotificationBanner.tsx` line 53, which uses `t('update.available')`. The design's choice of English-fixed aria-labels for NotificationDot is the dominant pattern.

### CONS-C-002: NotificationDot in common/ is appropriate

The `src/components/common/` directory is the established location for reusable UI primitives. Existing files (Toast.tsx, LocaleSwitcher.tsx) validate this choice.

### CONS-C-003: Line number references are approximate

Design references to specific line numbers (e.g., "L184-190", "L109-116") are approximately correct for the current codebase but may drift. Implementation should locate code by pattern rather than line number.

---

## Risk Assessment

| Risk Type | Level | Description | Mitigation |
|---|---|---|---|
| Technical | Low | Minimal code change; single-line fetch fix plus additive UI changes | Existing test coverage; new tests planned |
| Security | Low | No new attack surface; `cache: "no-store"` improves freshness | Existing SEC-001/SEC-SF-001 protections unchanged |
| Operational | Low | Feature is informational only; failure mode is graceful degradation | globalThis cache prevents API overload |

---

## Consistency Verification Checklist

- [x] Design references match actual codebase file paths
- [x] Proposed prop names follow existing naming conventions (`has*` boolean pattern)
- [x] Proposed component location follows directory conventions (`common/` for shared)
- [x] Test approach matches existing test patterns (Vitest + @testing-library)
- [x] Error handling follows established graceful degradation pattern
- [x] CSS class patterns match Tailwind conventions used throughout
- [x] data-testid naming follows kebab-case convention
- [x] aria-label language (English) follows dominant codebase pattern
- [x] Props drilling depth (1 level) matches existing WorktreeDetailRefactored patterns
- [x] Memoization considerations documented for memo-wrapped components
- [x] Cache behavior (globalThis) documented for dual hook usage (SF-002)
- [x] Color choice (bg-blue-500) matches existing notification indicator color

---

## Approval

**Status**: Approved

The design policy document for Issue #278 is highly consistent with the existing codebase. All proposed changes follow established patterns, naming conventions, and architectural approaches. The two "should fix" items are implementation-level details (CSS `relative` class and mixed badge patterns) that do not require design revisions. The design is ready for implementation.
