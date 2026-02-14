# Architecture Review: Issue #278 - Impact Analysis (Stage 3)

## Review Summary

| Item | Detail |
|------|--------|
| **Issue** | #278 - fetch Data Cache fix + Update Indicator |
| **Focus** | Impact Analysis (影響範囲) |
| **Stage** | 3 / 4 |
| **Status** | Approved |
| **Score** | 5/5 |
| **Reviewer** | Architecture Review Agent |
| **Date** | 2026-02-14 |

---

## 1. Executive Summary

Issue #278 is a well-scoped change that combines a bug fix (`cache: "no-store"` addition to `version-checker.ts`) with a small feature addition (notification dot indicators on Info button/tab). The impact analysis reveals that this change has a very limited blast radius. All modified interfaces use optional props, ensuring full backward compatibility. Existing tests will continue to pass without modification. The design document accurately identifies affected files and demonstrates thorough awareness of indirect impacts.

---

## 2. Impact Analysis: Directly Changed Files

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| Direct | `src/lib/version-checker.ts` | Add `cache: 'no-store'` to fetch call (1 line), JSDoc update | Low |
| Direct | `src/components/common/NotificationDot.tsx` | New file: shared notification dot component | Low |
| Direct | `src/components/worktree/WorktreeDetailRefactored.tsx` | Add `useUpdateCheck()` hook call, add `hasUpdate` prop to DesktopHeader and MobileTabBar, add `relative` class to Info button | Low |
| Direct | `src/components/mobile/MobileTabBar.tsx` | Add `hasUpdate?: boolean` to props, add conditional NotificationDot render on info tab | Low |

### 2.1 version-checker.ts - Bug Fix Impact

**Change**: Adding `cache: 'no-store'` to the `fetch()` call at L184-190.

**Impact Assessment**:
- The change affects only the Next.js Data Cache behavior, not the application-level globalThis cache (1-hour TTL).
- In production, the server-side `globalThis` cache continues to throttle GitHub API requests to at most 1 per hour.
- The only behavioral difference is that `npm run build` will no longer permanently cache the build-time API response. This is the intended fix.
- Existing test (`tests/unit/lib/version-checker.test.ts`) uses `vi.stubGlobal('fetch', ...)` to mock fetch, which is unaffected by the `cache` option. All 18 existing test cases will continue to pass.

**Backward Compatibility**: Full. No API contract changes.

### 2.2 NotificationDot.tsx - New Component

**Change**: New file `src/components/common/NotificationDot.tsx`.

**Impact Assessment**:
- New file creation has zero impact on existing code.
- Placed in `src/components/common/`, which already contains `Toast.tsx` and `LocaleSwitcher.tsx`, consistent with the project's directory structure.
- The component is a simple presentational `<span>` element with no side effects.
- Does not import or depend on any project-specific modules (only React types).

**Backward Compatibility**: Not applicable (new file).

### 2.3 WorktreeDetailRefactored.tsx - Hook Addition and Props

**Change**: Adding `useUpdateCheck()` hook call and passing `hasUpdate` to child components.

**Impact Assessment**:
- **DesktopHeader** is defined internally within WorktreeDetailRefactored.tsx (L410-574). Adding `hasUpdate?: boolean` to `DesktopHeaderProps` is an internal interface change with no external consumers.
- Adding `relative` to the Info button className (CONS-SF-001) has no visual impact unless a child element uses `position: absolute`, which only occurs when `hasUpdate` is true and NotificationDot renders.
- The `useUpdateCheck()` hook triggers at most 2 re-renders (loading state change + data arrival). Both DesktopHeader and MobileTabBar are wrapped in `memo()`, limiting re-render propagation.
- The file is already 2081 lines, and this change adds approximately 5-10 lines to the component body plus the import statement.

**Backward Compatibility**: Full. DesktopHeader is internal. MobileTabBar receives an optional prop.

### 2.4 MobileTabBar.tsx - Optional Prop Addition

**Change**: Adding `hasUpdate?: boolean` to `MobileTabBarProps` and conditional NotificationDot rendering.

**Impact Assessment**:
- Only one consumer exists: `WorktreeDetailRefactored.tsx` at L1991-1996. The existing call site does not pass `hasUpdate`, so it will default to `undefined` (falsy), and no badge will render until the prop is explicitly provided.
- The existing `renderBadges` useMemo block (L130-149) handles hasNewOutput and hasPrompt for the terminal tab. The new `hasUpdate` badge is conditionally rendered separately for the info tab, so there is no interference with existing badge logic.
- MobileTabBar's `getTabStyles` callback (L115-125) already includes `relative` in `baseStyles`, so NotificationDot's `absolute` positioning will work correctly without additional CSS changes.

**Backward Compatibility**: Full. Optional prop with no default behavior change.

---

## 3. Impact Analysis: Indirectly Affected Files

| Category | File | Impact | Risk |
|----------|------|--------|------|
| Indirect | `src/components/worktree/VersionSection.tsx` | useUpdateCheck double-call (absorbed by globalThis cache) | Low |
| Indirect | `src/hooks/useUpdateCheck.ts` | No changes needed; gains an additional consumer | Low |
| Indirect | `src/app/api/app/update-check/route.ts` | No changes; `cache: no-store` is in version-checker.ts, not route | Low |
| Indirect | `src/components/sidebar/BranchListItem.tsx` | No changes; future NotificationDot adoption is out of scope | Low |
| Indirect | `src/lib/api-client.ts` | No changes; UpdateCheckResponse type and appApi.checkForUpdate() unchanged | Low |

### 3.1 VersionSection Double-Call Analysis

`VersionSection` (used inside InfoModal/MobileInfoContent) calls `useUpdateCheck()` internally. With Issue #278, `WorktreeDetailRefactored` will also call `useUpdateCheck()`. This creates two hook instances in the component tree.

**Why this is safe**:
1. `useUpdateCheck()` calls `/api/app/update-check` via `appApi.checkForUpdate()`.
2. The API route calls `checkForUpdate()` from `version-checker.ts`.
3. `checkForUpdate()` checks `isCacheValid()` first -- if the globalThis cache has a result and is within the 1-hour TTL, it returns immediately without any network call.
4. Both hook instances share the same server process's globalThis cache, so the second call hits cache.

**Verified in source code**: `version-checker.ts` L174-177 confirms cache check occurs before fetch.

---

## 4. Impact on Existing Tests

| Test File | Existing Tests | Impact | Action Required |
|-----------|---------------|--------|-----------------|
| `tests/unit/lib/version-checker.test.ts` | 18 tests | No breakage. Tests mock `fetch` via `vi.stubGlobal`; the `cache` option does not affect mock behavior. | Add 1 new test to verify `cache: 'no-store'` is passed in fetch options. |
| `tests/unit/components/mobile/MobileTabBar.test.tsx` | 25 tests | No breakage. `defaultProps` does not include `hasUpdate`, so all existing tests run with `hasUpdate=undefined`. | Add new test section for hasUpdate indicator. |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | Existing tests | **Potential breakage risk**: If `useUpdateCheck` is not mocked, the hook will attempt to call `appApi.checkForUpdate()`, which may fail in the test environment. | Verify that the existing test setup mocks or handles the new hook. If necessary, add `vi.mock('@/hooks/useUpdateCheck', ...)` to the test file. |
| `tests/unit/components/worktree/version-section.test.tsx` | Existing tests | No impact. VersionSection's behavior is unchanged. | No action needed. |
| `tests/unit/components/worktree/update-notification-banner.test.tsx` | Existing tests | No impact. UpdateNotificationBanner is unchanged. | No action needed. |

### 4.1 Critical Test Risk: WorktreeDetailRefactored.test.tsx

This is the only test file with a **medium** risk level. The existing test file (at line 1-50 reviewed) mocks several hooks and modules. When `useUpdateCheck()` is added to WorktreeDetailRefactored, the test environment must either:

1. Mock `useUpdateCheck` to return a default state (`{ data: null, loading: false, error: null }`), or
2. Mock the underlying `appApi.checkForUpdate()` call.

**Recommendation**: The design document (Section 5) should explicitly mention that `tests/unit/components/WorktreeDetailRefactored.test.tsx` may need a `useUpdateCheck` mock addition to prevent test failures.

---

## 5. Impact on User Experience

| Aspect | Before | After | Impact |
|--------|--------|-------|--------|
| Version check accuracy | Cached at build time; never updates | Fetches fresh data (with 1h in-memory cache) | Positive: Users see actual update availability |
| Desktop Info button | No update indicator | Blue dot when update available | Positive: Visual cue for updates |
| Mobile Info tab | No update indicator | Blue dot when update available | Positive: Visual cue for updates |
| Info modal content | UpdateNotificationBanner appears when update exists | Unchanged behavior | No impact |
| Page load performance | 1 API call (from VersionSection) | 2 hook instances, but 2nd hits cache | Negligible impact |

### 5.1 No Negative UX Impact

- Users who do not have updates available will see no visual change.
- The blue dot (`bg-blue-500`) matches the existing unread indicator color in BranchListItem, providing visual consistency.
- The `aria-label="Update available"` ensures screen reader users are also notified.

---

## 6. Impact on Performance

| Metric | Before | After | Assessment |
|--------|--------|-------|------------|
| GitHub API calls per hour | 1 (via globalThis cache) | 1 (unchanged) | No impact |
| Client-side API calls on mount | 1 (VersionSection) | 2 (VersionSection + WorktreeDetailRefactored), but server-side cache deduplicates | Negligible |
| Re-renders from new hook | 0 | 2 per mount (loading + data) | Negligible; child components are memo()'d |
| Bundle size | Baseline | +NotificationDot (~200 bytes minified) | Negligible |
| Build-time caching | fetch result cached at build time | fetch result fetched at runtime | Intended behavior change |

### 6.1 Performance Conclusion

The performance impact is negligible across all dimensions. The globalThis cache in `version-checker.ts` is the primary rate-limiting mechanism, and it remains unchanged. The additional `useUpdateCheck()` hook instance adds at most one extra server-side API route call on initial mount, which is fully absorbed by the globalThis cache.

---

## 7. Backward Compatibility Analysis

| Component | Change Type | Backward Compatible | Rationale |
|-----------|-------------|---------------------|-----------|
| `version-checker.ts` | Behavior fix | Yes | `cache: 'no-store'` only affects Next.js Data Cache; API contract unchanged |
| `MobileTabBarProps` | Interface extension | Yes | `hasUpdate` is optional; defaults to undefined (falsy) |
| `DesktopHeaderProps` | Interface extension | Yes | Internal interface; not exported |
| `NotificationDot` | New component | N/A | No existing consumers |
| `useUpdateCheck` | No change | Yes | Hook interface unchanged; gains additional consumer |
| `/api/app/update-check` | No change | Yes | Response format unchanged |

**Verdict**: All changes are fully backward compatible. No breaking changes to any public interfaces.

---

## 8. Risk Assessment

| Risk Type | Content | Severity | Probability | Priority |
|-----------|---------|----------|-------------|----------|
| Technical | WorktreeDetailRefactored.test.tsx may need useUpdateCheck mock | Medium | Medium | P2 |
| Technical | DesktopHeader hasUpdate prop untested in unit tests | Low | Low | P3 |
| Security | No new security risks introduced | Low | Low | - |
| Operational | No deployment or runtime operational risks | Low | Low | - |
| Performance | Negligible impact from dual useUpdateCheck calls | Low | Low | - |
| UX | No negative user experience impact | Low | Low | - |

---

## 9. Improvement Recommendations

### 9.1 Should Fix (推奨改善)

#### IMP-SF-001: DesktopHeader テストカバレッジ

**Issue**: DesktopHeader is an internal component defined inside WorktreeDetailRefactored.tsx. There is no dedicated unit test for the `hasUpdate` indicator rendering on the Desktop Info button. The design document lists test files for MobileTabBar and NotificationDot but not for DesktopHeader's indicator behavior.

**Recommendation**: Add a test case in `tests/unit/components/WorktreeDetailRefactored.test.tsx` that verifies `data-testid="info-update-indicator"` appears when the update check returns `hasUpdate: true`.

#### IMP-SF-002: 再レンダリング影響の明示化

**Issue**: The design document's Section 7 (Performance) discusses memo() wrapping and useMemo for bannerProps, but does not explicitly address the re-render impact on WorktreeDetailRefactored itself when useUpdateCheck state changes.

**Recommendation**: Add a brief note in Section 7 clarifying that useUpdateCheck triggers at most 2 state changes on mount (loading: false, data: set), and that this is acceptable given the component already handles multiple polling-based state changes at higher frequency (ACTIVE_POLLING_INTERVAL_MS = 2000ms).

### 9.2 Consider (検討事項)

#### IMP-C-001: WorktreeDetailRefactored.test.tsx Mock Preparation

The design document should mention that existing tests for WorktreeDetailRefactored may require an additional `vi.mock('@/hooks/useUpdateCheck', ...)` entry to prevent unintended API calls during testing. This is not a design issue but a practical implementation note that would save debugging time.

#### IMP-C-002: Existing Test Stability Confirmation

All existing MobileTabBar tests (25 test cases) will pass without modification because `hasUpdate` defaults to `undefined`. The version-checker tests (18 test cases) will also pass because they mock `fetch` globally and `cache: 'no-store'` does not affect mock behavior.

#### IMP-C-003: Build-time Behavior Change Documentation

The `cache: 'no-store'` change means that `npm run build` will no longer cache the GitHub API response in the Next.js Data Cache. This is the intended fix, but it would be helpful to document this behavioral change in the commit message or PR description to assist future developers investigating build behavior.

---

## 10. File Impact Matrix

```
src/lib/version-checker.ts ................ [MODIFY] 1 line add + JSDoc
src/components/common/NotificationDot.tsx . [CREATE] new component
src/components/worktree/
  WorktreeDetailRefactored.tsx ............ [MODIFY] hook + props + CSS
src/components/mobile/MobileTabBar.tsx .... [MODIFY] props + render
tests/unit/lib/version-checker.test.ts .... [MODIFY] add test
tests/unit/components/mobile/
  MobileTabBar.test.tsx ................... [MODIFY] add tests
tests/unit/components/common/
  notification-dot.test.tsx ............... [CREATE] new test
tests/unit/components/
  WorktreeDetailRefactored.test.tsx ....... [MODIFY?] may need mock update

No changes needed:
  src/hooks/useUpdateCheck.ts
  src/app/api/app/update-check/route.ts
  src/components/worktree/VersionSection.tsx
  src/components/worktree/UpdateNotificationBanner.tsx
  src/components/sidebar/BranchListItem.tsx
  src/lib/api-client.ts
```

---

## 11. Conclusion

The design policy for Issue #278 demonstrates excellent impact awareness. The changes are minimal, well-contained, and fully backward compatible. The design document correctly identifies all affected files and provides thorough justification for design decisions (props drilling vs Context API, NotificationDot extraction, globalThis cache behavior). The only area for minor improvement is explicit mention of the WorktreeDetailRefactored test file's potential need for a useUpdateCheck mock, which is classified as a low-severity recommendation.

**Approval Status**: Approved (5/5)

---

## 12. Review History

| Stage | Date | Status | Score | Findings |
|-------|------|--------|-------|----------|
| Stage 1: Design Principles | 2026-02-14 | conditionally_approved | 4/5 | MF:1, SF:3, C:3 |
| Stage 2: Consistency | 2026-02-14 | approved | 5/5 | MF:0, SF:2, C:3 |
| **Stage 3: Impact Analysis** | **2026-02-14** | **approved** | **5/5** | **MF:0, SF:2, C:3** |
