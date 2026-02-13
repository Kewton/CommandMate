# Architecture Review Report: Issue #257 - Stage 1 (Design Principles)

**Issue**: #257 - Version Update Notification Feature
**Focus**: Design Principles (SOLID / KISS / YAGNI / DRY)
**Stage**: 1 of 4 (Standard Review)
**Date**: 2026-02-13
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

The design policy for Issue #257 (version update notification feature) is well-structured and demonstrates strong adherence to YAGNI and KISS principles. The decision to self-implement semver comparison rather than importing a library is well-justified. The globalThis cache pattern correctly follows existing project conventions. The silent failure pattern is appropriate for a non-critical feature.

However, there is one must-fix item related to Single Responsibility Principle: the design proposes adding update notification UI directly into the already oversized WorktreeDetailRefactored.tsx (2085 lines). Additionally, there are DRY concerns with duplicated Version sections between InfoModal and MobileInfoContent, and some type design redundancy.

Overall, the design is sound and production-ready with minor adjustments.

---

## Design Principles Checklist

### SOLID Principles

| Principle | Status | Notes |
|-----------|--------|-------|
| Single Responsibility | Conditional | version-checker.ts and route.ts have clean separation. However, adding UI to the already 2085-line WorktreeDetailRefactored.tsx worsens SRP violation. |
| Open/Closed | Pass | Design notes future extensibility via strategy pattern for alternative update sources. |
| Liskov Substitution | N/A | No inheritance hierarchies involved. |
| Interface Segregation | Conditional | i18n keys added to worktree namespace are conceptually outside its domain (app-level vs worktree-level concern). |
| Dependency Inversion | Pass | API route depends on version-checker abstraction. Hook depends on API client abstraction. Acceptable layering. |

### Other Principles

| Principle | Status | Notes |
|-----------|--------|-------|
| KISS | Pass | Self-implemented semver (10 lines), silent failure without retry logic, straightforward cache pattern. |
| YAGNI | Pass | No prerelease support, no dismiss feature, no env-based disable. Correct scoping. |
| DRY | Conditional | Version display is duplicated in InfoModal and MobileInfoContent. Adding update notification doubles this duplication. |

---

## Detailed Findings

### Must Fix (1 item)

#### MF-001: WorktreeDetailRefactored.tsx SRP Violation

**Principle**: Single Responsibility
**Severity**: Must Fix

The design specifies modifying `WorktreeDetailRefactored.tsx` to add update notification UI inside both `InfoModal` (line 507-511) and `MobileInfoContent` (line 775-779). This file is already **2085 lines** and contains multiple sub-components:

- `InfoModal` (lines 345-530)
- `MobileInfoContent` (lines 611-797)
- `MobileContent` (lines 800+)
- `LoadingIndicator`, `ErrorMessage`, and more

Adding yet another UI concern (update notification with hook integration, conditional rendering, link display, and update command display) directly into this file further violates SRP.

**Recommendation**: Create a dedicated component:

```
src/components/worktree/UpdateNotificationBanner.tsx
```

This component encapsulates:
- The `useUpdateCheck` hook call
- Conditional rendering based on `hasUpdate`
- The notification banner UI (version info, release link, update command)

Then import and render it in the Version section of both `InfoModal` and `MobileInfoContent`.

---

### Should Fix (4 items)

#### SF-001: DRY Violation in Version Section Duplication

**Principle**: DRY
**Severity**: Should Fix

The Version display is currently duplicated in two places:
- `InfoModal` at line 507-511 (with `bg-gray-50` styling)
- `MobileInfoContent` at line 775-779 (with `bg-white border` styling)

The design proposes adding update notification below both. This means the update check logic, conditional rendering, and notification markup will also be duplicated.

**Recommendation**: Extract a `VersionSection` component that includes both the version display and the `UpdateNotificationBanner`. Render this single component in both locations. The minor styling difference (gray background vs white border) can be handled via a `variant` prop.

#### SF-002: Type Redundancy Between UpdateCheckResult and UpdateCheckResponse

**Principle**: DRY / KISS
**Severity**: Should Fix

`UpdateCheckResult` (6 fields) and `UpdateCheckResponse` (8 fields) share most fields but with subtle nullable differences. The API route must map between them, which is a potential source of mapping errors.

**Recommendation**: Either make `UpdateCheckResponse` compose `UpdateCheckResult`, or unify into a single type. Since the API route is the only consumer of `checkForUpdate()`, having the function return data in the final response shape reduces mapping complexity.

#### SF-003: isNewerVersion Lacks Defensive Validation

**Principle**: Open/Closed, Defensive Design
**Severity**: Should Fix

The design shows `isNewerVersion` parsing versions via `v.replace(/^v/, '').split('.').map(Number)`. If `tag_name` from GitHub has unexpected formats (e.g., `v0.3.0-beta`, `0.3`), the function produces `NaN` or undefined segments. The security section mentions regex validation (`/^v?\d+\.\d+\.\d+$/`) but this is separate from the comparison function.

**Recommendation**: Add validation inside `isNewerVersion` itself:

```typescript
function isNewerVersion(current: string, latest: string): boolean {
  const pattern = /^v?\d+\.\d+\.\d+$/;
  if (!pattern.test(current) || !pattern.test(latest)) return false;
  // ... comparison logic
}
```

#### SF-004: Always-200 Response Hinders Observability

**Principle**: KISS (operational simplicity)
**Severity**: Should Fix

Returning HTTP 200 for all cases (success, GitHub API failure, internal error) simplifies the client but makes monitoring and debugging harder. Distinguishing "no update available" from "could not check" is impossible via HTTP status alone.

**Recommendation**: Add a `checkStatus` field to the response:

```typescript
interface UpdateCheckResponse {
  // ... existing fields
  checkStatus: 'success' | 'cached' | 'error';
}
```

This preserves the HTTP 200 approach while enabling observability.

---

### Consider (3 items)

#### C-001: rateLimitResetAt May Be Over-Engineering

**Principle**: YAGNI

The 1-hour cache TTL already largely prevents hitting GitHub's rate limit (60 req/h for unauthenticated). The dedicated `rateLimitResetAt` field and `handleRateLimit`/`isRateLimited` functions add complexity for a scenario the cache already mitigates. Consider whether simply extending the cache TTL on 403 response is sufficient.

#### C-002: i18n Namespace Mismatch

**Principle**: Interface Segregation

Version update notification is an application-level concern, not a worktree concern. Adding `update.*` keys to the `worktree` namespace creates a conceptual mismatch. Acceptable for now given the small key count (26 lines currently), but establish a guideline for when to create new namespaces.

#### C-003: Direct fetch Coupling in version-checker.ts

**Principle**: Dependency Inversion

`version-checker.ts` directly calls `fetch()` to GitHub API. While abstraction is unnecessary now (YAGNI), if alternative update sources are needed later, consider extracting an `UpdateSourceProvider` interface. The design's mention of future strategy pattern (Section 11) already acknowledges this.

---

## Risk Assessment

| Risk Type | Level | Details |
|-----------|-------|---------|
| Technical | Low | Design follows established patterns (globalThis cache, API client, custom hook). No new dependencies. |
| Security | Low | Server-side only GitHub API calls. Response field filtering. Input validation on tag_name. CSP unchanged. |
| Operational | Low | Silent failure prevents feature from affecting core application. 5-second timeout limits impact. |

---

## Positive Design Decisions

The following design decisions demonstrate strong adherence to principles and deserve recognition:

1. **semver self-implementation (YAGNI)**: Correctly avoids adding a dependency for 10 lines of code. The justification (no prerelease versions) is well-documented.

2. **globalThis cache pattern (DRY/Consistency)**: Following the established `auto-yes-manager.ts` pattern ensures consistency and leverages proven hot-reload resilience.

3. **Server-side only GitHub API calls (Security/KISS)**: Eliminates CSP changes and centralizes rate limit management.

4. **InfoModal-triggered API call (Performance)**: Avoids unnecessary page-load API calls. The update check happens only when the user explicitly opens the info dialog.

5. **No DB changes**: Keeping the feature stateless (in-memory cache only) minimizes deployment risk.

6. **TDD implementation order** (Section 12): version-checker.test.ts is prioritized at step 2, right after the core logic at step 1.

---

## Approval Decision

**Status: Conditionally Approved**

The design is approved for implementation with the following conditions:

1. **Required before implementation**: Address MF-001 by extracting the update notification UI into a separate component (`UpdateNotificationBanner.tsx`) rather than embedding it directly in `WorktreeDetailRefactored.tsx`.

2. **Required during implementation**: Address SF-001 through SF-004 during the coding phase. These items do not require design document revision but should be incorporated into the implementation.

3. **Optional**: C-001 through C-003 are for future consideration and do not block this issue.

---

*Reviewed by: Architecture Review Agent*
*Stage: 1/4 (Standard Review - Design Principles)*
*Generated: 2026-02-13*
