# Architecture Review: Issue #270 - Impact Analysis (Stage 3)

| Item | Value |
|------|-------|
| **Issue** | #270 - update-check route static prerendering fix |
| **Focus Area** | Impact Scope (影響範囲) |
| **Stage** | 3 of 4 (影響分析レビュー) |
| **Status** | Approved |
| **Score** | 5/5 |
| **Date** | 2026-02-14 |

---

## Executive Summary

The proposed change for Issue #270 has an exceptionally narrow impact scope. The modification consists of adding a single `export const dynamic = 'force-dynamic'` line to one file (`src/app/api/app/update-check/route.ts`). No function logic, type definitions, API contracts, database schemas, or configuration files are altered. The full dependency chain (upstream and downstream) has been traced and verified to be unaffected at the code level, with only positive behavioral improvements flowing through the existing component hierarchy to the end user.

---

## Impact Analysis

### Direct Changes

| File | Change | Risk |
|------|--------|------|
| `src/app/api/app/update-check/route.ts` | Add `export const dynamic = 'force-dynamic'` after import statements | Low |

This is the only file requiring modification. The addition is a module-level constant export that instructs the Next.js build system to treat this route as dynamic rather than static. No existing functions, types, interfaces, or constants in the file are modified.

### Indirect Impacts (Downstream)

| File | Impact | Rationale |
|------|--------|-----------|
| `src/lib/version-checker.ts` | None | Provides `checkForUpdate()` and `getCurrentVersion()`. Call pattern and caching behavior unchanged. The globalThis cache (1-hour TTL) continues to operate identically. |
| `src/lib/api-client.ts` | None | `appApi.checkForUpdate()` makes a GET request to the endpoint. API contract (request shape, response shape, HTTP status codes) is completely unchanged. |
| `src/hooks/useUpdateCheck.ts` | None (positive behavioral change) | Client-side hook that calls the endpoint on component mount. Will now receive fresh runtime data instead of stale build-time data. No code change required. |
| `src/components/worktree/VersionSection.tsx` | None (positive behavioral change) | Consumes `useUpdateCheck` hook output. Update notifications will now correctly appear when new versions are released. No code change required. |
| `src/components/worktree/UpdateNotificationBanner.tsx` | None (positive behavioral change) | Renders update notification when `hasUpdate` is true. Will now actually function as designed for post-build version releases. No code change required. |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | None | Contains `VersionSection` at two locations (InfoModal line 510, MobileInfoContent line 778). Behavioral improvement is inherited through the component hierarchy. |
| `tests/unit/api/update-check.test.ts` | None | Tests import and call the `GET` function directly with mocked dependencies. Module-level const exports do not affect function-level test execution. |

### Upstream Dependencies (Unchanged)

| Dependency | Status |
|------------|--------|
| GitHub Releases API (external) | Unchanged - same URL, same request format, same response parsing |
| `src/lib/version-checker.ts` | Unchanged - `checkForUpdate()`, `getCurrentVersion()`, caching, rate limiting all intact |
| `src/cli/utils/install-context.ts` | Unchanged - `isGlobalInstall()` cross-layer import is read-only |

### Unaffected Modules

| Category | Rationale |
|----------|-----------|
| Other API routes (35 files) | Completely independent. The `dynamic` export is scoped to a single route module. |
| Database layer | No schema, migration, or query changes. The update-check endpoint does not interact with the database. |
| CLI modules (`src/cli/`) | Unaffected. The `isGlobalInstall()` cross-layer import is read-only and unchanged. |
| Build configuration (`next.config.js`) | No changes required. The `dynamic` export is a per-route Next.js mechanism. |
| Internationalization | Translation keys for update notifications are unchanged. |
| Security infrastructure | Cache-Control headers (SEC-SF-003), SSRF prevention (SEC-001), response validation (SEC-SF-001), and CSP headers in `next.config.js` are all unaffected. |

---

## Dependency Chain Visualization

```
GitHub Releases API (external)
        |
        v
src/lib/version-checker.ts       src/cli/utils/install-context.ts
  (checkForUpdate, cache)           (isGlobalInstall)
        |                                  |
        +----------------------------------+
        |
        v
src/app/api/app/update-check/route.ts  <-- CHANGE HERE (add dynamic export)
        |
        v
src/lib/api-client.ts (appApi.checkForUpdate)
        |
        v
src/hooks/useUpdateCheck.ts
        |
        v
src/components/worktree/VersionSection.tsx
        |
        v
src/components/worktree/UpdateNotificationBanner.tsx
        |
        v
src/components/worktree/WorktreeDetailRefactored.tsx (InfoModal + MobileInfoContent)
```

All nodes below the change point experience only a behavioral improvement (fresh data instead of stale build-time data) with zero code changes required.

---

## Build and Runtime Impact

### Build Impact

| Aspect | Before | After |
|--------|--------|-------|
| Build output symbol | `(circle)` Static | `f` Dynamic |
| `.next/server/app/api/app/update-check.body` | Present (cached response) | Absent |
| Bundle size | Negligible difference | Negligible difference |
| Build time | No change | No change |

### Runtime Impact

| Aspect | Before | After |
|--------|--------|-------|
| Route handler execution | Never (cached build-time response) | On each request |
| GitHub API calls | Zero (build-time result only) | Max 1 per hour (globalThis cache) |
| Response latency (cache hit) | Instant (static file) | Sub-millisecond (in-memory cache) |
| Response latency (cache miss) | N/A | Up to 5 seconds (fetch timeout) |
| Memory usage | No change | No change (cache already exists in dev mode) |

The performance concern is minimal. The `version-checker.ts` module already implements a globalThis cache with 1-hour TTL and a 5-second fetch timeout. In production, at most 1 external API call per hour will occur, with all other requests served from the in-memory cache.

---

## Rollback Strategy

| Aspect | Assessment |
|--------|------------|
| Complexity | Trivial |
| Data migration | Not required |
| Breaking changes | None |
| Downtime | Not required |

### Rollback Steps

1. Remove the line: `export const dynamic = 'force-dynamic'`
2. Remove the associated comment block (`// [FIX-270] ...`)
3. Run `npm run build` to verify the route returns to static (`(circle)` symbol)
4. Remove the dynamic export unit test if it was added

The rollback restores the original static prerendering behavior. Since this is a behavioral fix (not a data model or schema change), no migration steps are needed.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | Single-line addition to one file. Established pattern with 5 prior examples in the codebase. No logic changes. |
| Security | Low | All security measures (Cache-Control, SSRF prevention, response validation) are in separate modules and completely unaffected. |
| Operational | Low | Trivial rollback. No data migration. No configuration changes. No downtime required. |

---

## Findings

### Must Fix

None.

### Should Fix

None.

### Consider

| ID | Title | Severity |
|----|-------|----------|
| IMP-C-001 | Other API routes potentially affected by the same static prerendering issue | Info |
| IMP-C-002 | Rollback path could be explicitly documented in design policy | Info |

**IMP-C-001**: The `/api/repositories/excluded` route (`GET` handler without `NextRequest` parameter or dynamic export) could theoretically be statically prerendered at build time. In practice it reads from the database which causes a runtime error during build (making it effectively dynamic), but it lacks the explicit `force-dynamic` safeguard. This is outside Issue #270 scope and aligns with Stage 1 finding C-002.

**IMP-C-002**: The design policy does not explicitly document a rollback strategy. Given the trivial nature of the change (removing one line), this is not a concern, but for completeness future design policies for more complex changes should include a rollback section.

---

## Cross-Reference with Prior Stages

| Stage | Focus | Status | Key Finding |
|-------|-------|--------|-------------|
| Stage 1 | Design Principles | Approved (5/5) | SOLID/KISS/YAGNI/DRY all pass. C-002 noted broader audit opportunity. |
| Stage 2 | Consistency | Approved (5/5) | All 13 design items verified against implementation. Zero gaps. |
| Stage 3 | Impact Analysis | Approved (5/5) | Single-file change with zero code-level impacts on dependent modules. |

---

## Conclusion

The impact scope of Issue #270 is minimal and well-contained. The change modifies exactly one file by adding one module-level constant export. The full dependency chain has been traced from the external GitHub API through the route handler, API client, React hook, and UI components, confirming that no code changes are required anywhere except the target file. The behavioral improvement (fresh update-check data at runtime) flows naturally through the existing architecture. Rollback is trivial. This change is approved for implementation.
