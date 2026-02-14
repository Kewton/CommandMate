# Architecture Review Report: Issue #278

## Overview

| Item | Detail |
|------|--------|
| Issue | #278 - fetch Data Cache fix and update indicator |
| Focus Area | Design Principles (SOLID / KISS / YAGNI / DRY) |
| Stage | 1 (Normal Review) |
| Reviewer | Architecture Review Agent |
| Date | 2026-02-14 |
| Status | **Conditionally Approved** |
| Score | **4 / 5** |

---

## Executive Summary

Issue #278 addresses two concerns: (1) fixing Next.js fetch Data Cache causing stale GitHub API responses in the version checker, and (2) adding update notification indicators to the Info button (Desktop) and Info tab (Mobile). The design policy document demonstrates strong adherence to design principles overall, with well-reasoned decisions documented for each tradeoff. One improvement item was identified regarding potential DRY violations in badge UI patterns.

---

## Design Principles Evaluation

### SOLID Principles

#### Single Responsibility Principle (SRP) -- PASS with note

The design correctly separates concerns across files:

- `version-checker.ts`: Responsible only for GitHub API interaction and version comparison. The `cache: "no-store"` fix is a single-line change that stays within this responsibility.
- `DesktopHeader` / `MobileTabBar`: Receive `hasUpdate` as a prop and handle only the visual badge rendering. No business logic leaks into these components.
- `VersionSection` / `UpdateNotificationBanner`: Each has a single, well-defined responsibility.

**Note**: `WorktreeDetailRefactored.tsx` is already 2082 lines long and contains numerous state variables, hooks, and event handlers. Adding `useUpdateCheck()` and passing `hasUpdate` further increases its scope. While the addition itself is minimal, the cumulative weight of this file is a concern for long-term maintainability. The design document does not explicitly address this growing complexity.

#### Open/Closed Principle (OCP) -- PASS

The design extends existing components through optional props (`hasUpdate?: boolean`) without modifying their existing behavior. Existing callers of `DesktopHeader` and `MobileTabBar` are unaffected because the new prop defaults to `undefined` (falsy), meaning no badge is rendered. This is a textbook application of OCP.

The `version-checker.ts` modification adds a fetch option without changing the function signature or return type of `checkForUpdate()`, preserving backward compatibility.

#### Liskov Substitution Principle (LSP) -- Not Applicable

No inheritance hierarchies are involved in the proposed changes.

#### Interface Segregation Principle (ISP) -- PASS

The `hasUpdate?: boolean` addition to `DesktopHeaderProps` and `MobileTabBarProps` is a minimal, optional prop. Consumers that do not need this feature simply omit the prop. This avoids forcing unrelated components to depend on update-check interfaces.

#### Dependency Inversion Principle (DIP) -- PASS

The `useUpdateCheck` hook abstracts the API call behind a consistent interface (`UseUpdateCheckState`). Components consume `hasUpdate` as a simple boolean, decoupled from the underlying GitHub API details. The data flows through a clean layered architecture:

```
useUpdateCheck (hook) -> /api/app/update-check (route) -> checkForUpdate (lib) -> GitHub API
```

Each layer depends on abstractions (return types, interfaces) rather than concrete implementations.

---

### KISS (Keep It Simple, Stupid) -- PASS

The design consistently chooses the simplest viable approach:

1. **Bug fix**: Adding `cache: "no-store"` is a one-line change -- the simplest possible fix for the Next.js Data Cache issue. The design document clearly explains why `export const dynamic = "force-dynamic"` is insufficient (it only prevents static prerendering, not fetch-level caching).

2. **Props drilling over Context API**: The design explicitly justifies this choice (Section 4-3): only 1 level of prop passing is needed, and existing patterns (`hasNewOutput`, `hasPrompt`) use the same approach. Context would be overengineering.

3. **Dot badge over banner**: Using a small `w-2 h-2` dot badge reuses the existing `BranchListItem` pattern, avoiding the need for a new UI paradigm.

4. **`aria-label` in English only**: The design avoids adding new i18n keys for screen reader labels, keeping the change scope minimal.

---

### YAGNI (You Aren't Gonna Need It) -- PASS

The design makes several correct YAGNI-aligned decisions:

1. **No Context API**: A global state container for a single boolean (`hasUpdate`) would be premature. The design correctly defers this until there is a demonstrated need for multi-level state sharing.

2. **No global notification system**: The design does not build a generic "notification badge" framework. It adds `hasUpdate` specifically where needed and avoids premature generalization.

3. **No custom hook composition**: Rather than creating a `useNotificationBadge` abstraction layer, the design uses the existing `useUpdateCheck` hook directly. This avoids unnecessary indirection.

4. **`bg-blue-500` color choice**: Using blue (informational) rather than red (urgent) is a product-appropriate decision that avoids implying urgency that does not exist.

---

### DRY (Don't Repeat Yourself) -- PASS with note

**Strengths**:
- The design references the existing `BranchListItem.tsx` dot badge pattern (lines 109-116) as the template for the new indicators, maintaining UI consistency.
- The `VersionSection` component was previously extracted to eliminate duplication between `InfoModal` and `MobileInfoContent` (SF-001 DRY compliance).
- The `NO_CACHE_HEADERS` constant in `route.ts` avoids header object duplication.

**Concern (MF-001)**: The dot badge CSS classes (`w-2 h-2 rounded-full bg-blue-500`) will be copy-pasted into three locations:
1. `BranchListItem.tsx` (existing, line 113)
2. `DesktopHeader` (new, within Info button)
3. `MobileTabBar` (new, on Info tab)

If the badge style needs to change (e.g., size increase, color change for dark mode), all three locations must be updated in sync. A shared `NotificationDot` component or a badge class constant would improve maintainability.

**Concern (SF-002)**: `useUpdateCheck()` will be called in both `WorktreeDetailRefactored` (for `hasUpdate` prop drilling) and `VersionSection` (for the banner). While the design correctly notes that the globalThis cache makes this effectively cost-free, the rationale is not documented at the code level where future developers would encounter it.

---

## Risk Assessment

| Risk Type | Content | Impact | Probability | Priority |
|-----------|---------|--------|-------------|----------|
| Technical | Dot badge CSS classes duplicated across 3 files | Low | Medium | P3 |
| Technical | WorktreeDetailRefactored growing complexity (2082+ lines) | Medium | Low | P3 |
| Security | No new security risks; existing SEC-001/SEC-SF-001 protections unchanged | Low | Low | -- |
| Operational | globalThis cache ensures no API rate limit issues from dual useUpdateCheck calls | Low | Low | -- |

---

## Improvement Recommendations

### Must Fix (before implementation)

#### MF-001: Extract shared dot badge pattern

**Problem**: The `w-2 h-2 rounded-full bg-blue-500` CSS class string will exist in 3 separate files without a single source of truth.

**Recommendation**: Create one of the following:

Option A -- Shared component:
```typescript
// src/components/common/NotificationDot.tsx
export function NotificationDot({
  testId,
  ariaLabel,
  className = "bg-blue-500"
}: { testId: string; ariaLabel: string; className?: string }) {
  return (
    <span
      data-testid={testId}
      className={`w-2 h-2 rounded-full flex-shrink-0 ${className}`}
      aria-label={ariaLabel}
    />
  );
}
```

Option B -- CSS class constant:
```typescript
// src/config/badge-styles.ts
export const NOTIFICATION_DOT_CLASSES = "w-2 h-2 rounded-full flex-shrink-0";
export const NOTIFICATION_DOT_INFO = `${NOTIFICATION_DOT_CLASSES} bg-blue-500`;
```

### Should Fix (quality improvement)

#### SF-001: Document WorktreeDetailRefactored decomposition plan

The file is over 2000 lines and growing. Create a tracking Issue for decomposing it into smaller, focused modules (e.g., separating layout orchestration from data fetching, extracting file operation handlers).

#### SF-002: Add JSDoc on globalThis cache behavior for dual hook calls

In `version-checker.ts`, add a comment near the `checkForUpdate` function:
```typescript
/**
 * ...
 * NOTE: Multiple calls within the same process (e.g., from different React hooks)
 * hit the globalThis cache (1h TTL) and do NOT trigger additional network requests.
 */
```

#### SF-003: Verify aria-label i18n consistency

Confirm that English-only `aria-label` values are the established project convention. If some existing labels are i18n-aware, align the new labels accordingly.

### Consider (future improvement)

#### C-001: MobileTabBar badge extensibility

If a third tab requires a badge in the future, refactor `TabConfig` to include an optional `badge` render function rather than adding more `tab.id === 'xxx' && ...` conditionals.

#### C-002: DesktopHeader file extraction

Consider extracting `DesktopHeader` from `WorktreeDetailRefactored.tsx` into its own file to improve testability and reduce the main file's size.

#### C-003: Single useUpdateCheck call architecture

An alternative architecture where `useUpdateCheck` is called only once in `WorktreeDetailRefactored` and its result is passed to `VersionSection` as props would eliminate the dual-call pattern entirely. This would change `VersionSection`'s interface but would be a cleaner data flow.

---

## Approval Status

**Conditionally Approved** -- The design is well-reasoned and follows design principles effectively. The MF-001 finding (shared dot badge pattern) should be addressed before or during implementation to prevent DRY violations from the start. All other findings are recommendations for quality improvement and are not blockers.

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `dev-reports/design/issue-278-fetch-cache-fix-and-update-indicator-design-policy.md` | Design policy document |
| `src/lib/version-checker.ts` | Version check logic (target of cache fix) |
| `src/hooks/useUpdateCheck.ts` | Client-side update check hook |
| `src/components/worktree/VersionSection.tsx` | Version display component |
| `src/components/worktree/UpdateNotificationBanner.tsx` | Update notification banner |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Main worktree detail component |
| `src/components/mobile/MobileTabBar.tsx` | Mobile tab bar (badge target) |
| `src/components/sidebar/BranchListItem.tsx` | Existing dot badge reference pattern |
| `src/app/api/app/update-check/route.ts` | Update check API route |
| `tests/unit/lib/version-checker.test.ts` | Existing unit tests |
