# Architecture Review Report: Issue #257 Stage 3 -- Impact Analysis

## Review Summary

| Item | Detail |
|------|--------|
| **Issue** | #257 -- Version Update Notification Feature |
| **Stage** | 3/4 (Impact Analysis) |
| **Focus** | Impact Scope (affected files and modules) |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Date** | 2026-02-13 |

---

## 1. Executive Summary

The design policy for Issue #257 proposes a well-scoped version update notification feature that introduces 9 new files and modifies 6 existing files. The impact analysis confirms that the change scope is appropriately contained. The feature adds a new API endpoint (`GET /api/app/update-check`), a server-side version checker with in-memory caching, a client-side custom hook, and two new UI components -- all without modifying database schemas, CSP policies, or `src/i18n.ts`.

One must-fix item was identified: the design document does not account for the impact on existing tests of `WorktreeDetailRefactored.tsx` when the Version section DOM structure changes. Three should-fix items and three consider items were also identified, all of which are low-to-medium risk.

---

## 2. Impact Scope Analysis

### 2-1. Direct Changes (New Files)

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| Business Logic | `src/lib/version-checker.ts` | GitHub API call, semver comparison (with validation), globalThis cache | Low |
| Custom Hook | `src/hooks/useUpdateCheck.ts` | API call state management, useEffect lifecycle | Low |
| UI Component | `src/components/worktree/UpdateNotificationBanner.tsx` | Notification banner UI (self-contained) | Low |
| UI Component | `src/components/worktree/VersionSection.tsx` | Version display + banner integration (DRY extraction) | Low |
| API Route | `src/app/api/app/update-check/route.ts` | GET endpoint, toUpdateCheckResponse() mapping, isGlobalInstall() | Low |
| Test | `tests/unit/lib/version-checker.test.ts` | Version checker unit tests | Low |
| Test | `tests/unit/api/update-check.test.ts` | API endpoint tests | Low |
| Test | `tests/unit/components/worktree/update-notification-banner.test.tsx` | Banner component tests | Low |
| Test | `tests/unit/components/worktree/version-section.test.tsx` | Version section component tests | Low |

### 2-2. Direct Changes (Modified Files)

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| API Client | `src/lib/api-client.ts` | Add `appApi.checkForUpdate()` method to existing API client. Follows existing pattern (`worktreeApi`, `repositoryApi`, `slashCommandApi`, `memoApi`). Adds new exported object `appApi` at bottom of file. | Low |
| UI Component | `src/components/worktree/WorktreeDetailRefactored.tsx` (2085 lines) | Replace inline Version sections (lines 507-511 and 775-779) with `<VersionSection>` component. Remove `APP_VERSION_DISPLAY` constant if no longer used elsewhere. Add import for `VersionSection`. | Medium |
| i18n | `locales/en/worktree.json` (26 lines) | Add `update.*` nested keys (estimated 5-8 keys) | Low |
| i18n | `locales/ja/worktree.json` (26 lines) | Add corresponding Japanese translations | Low |
| Documentation | `CLAUDE.md` | Add version-checker.ts to module table | Low |
| Documentation | `docs/implementation-history.md` | Add Issue #257 entry | Low |

### 2-3. Indirect Impact (Files NOT Modified But Potentially Affected)

| Category | File | Impact Description | Risk |
|----------|------|--------------------|------|
| Existing Test | `tests/unit/components/worktree/WorktreeDetailWebSocket.test.tsx` | If this test renders WorktreeDetailRefactored and asserts on Version display DOM elements, the VersionSection extraction will change the DOM structure and break assertions. **This is the must-fix item (IMP-001).** | Medium |
| CLI Utility | `src/cli/utils/install-context.ts` | Referenced via new import from `route.ts`. The function `isGlobalInstall()` itself is unchanged. Cross-layer import documented as CONS-001. Precedent: `src/lib/db-path-resolver.ts:14`. | Low |
| Config | `next.config.js` | CSP `connect-src` does NOT need modification because GitHub API calls are server-side only. Confirmed via design document Section 6-1. | Low |
| i18n Config | `src/i18n.ts` | NOT modified because `update.*` keys are added to existing `worktree` namespace, not a new namespace. This avoids changes to the `Promise.all` import array at line 25-31. | Low |
| Dependencies | `package.json` | NOT modified because semver comparison is self-implemented (15 lines). No new npm packages added. | Low |

### 2-4. Confirmed No-Impact Modules

The following modules have been verified to have zero impact from this change:

- Database layer: `db-instance.ts`, `db-path-resolver.ts`, `db-migration-path.ts` -- no schema changes
- Session management: `claude-session.ts`, `auto-yes-manager.ts`, `response-poller.ts` -- no interaction
- Prompt detection: `prompt-detector.ts`, `status-detector.ts` -- no interaction
- CLI commands: `src/cli/commands/*` -- no changes needed
- React contexts: `src/contexts/*` -- no new context providers
- Type definitions: `src/types/models.ts` -- no model changes

---

## 3. Dependency Graph

```
[New] version-checker.ts
  <- [New] route.ts (imports checkForUpdate, getCurrentVersion)
  <- route.ts also imports isGlobalInstall() from [Existing] src/cli/utils/install-context.ts

[New] route.ts (/api/app/update-check)
  <- [Modified] api-client.ts (appApi.checkForUpdate calls this endpoint)

[Modified] api-client.ts
  <- [New] useUpdateCheck.ts (hook uses appApi.checkForUpdate)

[New] useUpdateCheck.ts
  <- [New] VersionSection.tsx (calls useUpdateCheck internally)

[New] VersionSection.tsx
  <- [New] UpdateNotificationBanner.tsx (rendered conditionally inside)
  <- [Modified] WorktreeDetailRefactored.tsx (InfoModal + MobileInfoContent)

[Modified] locales/en/worktree.json, locales/ja/worktree.json
  <- [New] UpdateNotificationBanner.tsx (uses useTranslations('worktree'))
```

---

## 4. Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical | Low | All new modules are self-contained. No database schema changes. No breaking API changes. The semver self-implementation is simple (15 lines with validation). | TDD approach ensures correctness. globalThis cache pattern has precedent in auto-yes-manager.ts. |
| Security | Low | GitHub API called server-side only. No CSP changes needed. Input validation built into isNewerVersion(). No user-controlled input to API Route (parameterless GET). | SF-003 ensures defensive validation. Sensitive data (internal paths) not exposed to client. |
| Operational | Low | Silent failure pattern ensures app continues working if GitHub API is unavailable. 1-hour cache TTL prevents excessive API calls. No new infrastructure dependencies. | Cache with 5-second timeout prevents slow responses. HTTP 200 on error simplifies client handling. |
| Test Regression | Medium | WorktreeDetailRefactored.tsx DOM structure change may break existing tests. | IMP-001 must-fix: review and update WorktreeDetailWebSocket.test.tsx. |

---

## 5. Detailed Findings

### 5-1. Must Fix

#### IMP-001: WorktreeDetailRefactored.tsx Test Impact Not Documented

**Category**: Impact scope gap

**Description**: The design document specifies that `WorktreeDetailRefactored.tsx` will be modified to use `VersionSection` component instead of inline Version display blocks (lines 507-511 in InfoModal, lines 775-779 in MobileInfoContent). However, the existing test file `tests/unit/components/worktree/WorktreeDetailWebSocket.test.tsx` may contain DOM assertions that reference the current Version display structure.

**Evidence**:
- Current inline code at line 508: `<div className="bg-gray-50 rounded-lg p-4">`
- Current inline code at line 776: `<div className="bg-white rounded-lg border border-gray-200 p-4">`
- Both display `APP_VERSION_DISPLAY` directly
- After change, these will be replaced by `<VersionSection>` component with different internal DOM structure

**Impact**: If WorktreeDetailWebSocket.test.tsx or any other test queries for "Version" text or the specific container class names, those tests will fail.

**Recommendation**: Add `tests/unit/components/worktree/WorktreeDetailWebSocket.test.tsx` to the "Modified Files" section in the design document (Section 10) if Version-related assertions exist. Add a checklist item in Section 15 to verify existing test compatibility.

### 5-2. Should Fix

#### IMP-SF-001: fetchApi Content-Type Header on GET Requests

**Category**: Indirect impact documentation

**Description**: The design document notes in CONS-004 that `fetchApi` (in `api-client.ts`, line 46) sets `Content-Type: application/json` on all requests including GET. The new `appApi.checkForUpdate()` will use `fetchApi` to call `GET /api/app/update-check`. While this is functionally harmless (the API Route does not inspect Content-Type for GET requests), it represents a minor protocol deviation. The GitHub API call in `version-checker.ts` is made independently via native `fetch`, not through `fetchApi`, so this does not affect the external API call.

**Recommendation**: No code change needed. Document this as a known characteristic of the `fetchApi` helper for future reference.

#### IMP-SF-002: New `/api/app/` Directory Naming Considerations

**Category**: Naming convention

**Description**: The proposed path `src/app/api/app/update-check/route.ts` introduces a new `app/` directory under `src/app/api/`. The existing API structure uses domain-specific names: `worktrees/`, `repositories/`, `hooks/`, `slash-commands/`, `external-apps/`. The `app/` name is unique in that it represents application-level functionality rather than a domain entity. It also creates a path `src/app/api/app/` where the two `app` directories could be confused during code navigation.

**Recommendation**: The naming is functionally valid for Next.js routing (URL path `/api/app/update-check` is clear). The CONS-C01 consider item already addresses future naming guidelines. No immediate action required, but be aware this may be raised during PR review.

#### IMP-SF-003: globalThis Declaration ESLint Compatibility

**Category**: Build pipeline

**Description**: The `declare global { var __versionCheckCache }` pattern requires `// eslint-disable-next-line no-var` comment, following the exact same pattern as `auto-yes-manager.ts` lines 99-103. The ESLint configuration must allow inline disable comments for this rule.

**Recommendation**: Copy the exact comment pattern from `auto-yes-manager.ts`. Run `npm run lint` during implementation to verify no new lint errors are introduced. The existing precedent confirms this will pass CI.

### 5-3. Consider (Future)

#### IMP-C01: Missing useUpdateCheck Hook Test in File Structure

The design document Section 10 lists test files for `version-checker.test.ts`, `update-check.test.ts` (API), `update-notification-banner.test.tsx`, and `version-section.test.tsx` -- but does not include `tests/unit/hooks/useUpdateCheck.test.ts`. All 18 existing custom hooks in `src/hooks/` have corresponding test files in `tests/unit/hooks/`. Following the established pattern, this test file should be added to the file structure.

#### IMP-C02: CLAUDE.md Documentation Scope

The design document specifies adding `version-checker.ts` to CLAUDE.md. However, `useUpdateCheck.ts`, `VersionSection.tsx`, and `UpdateNotificationBanner.tsx` are also significant new modules that should be documented in the module table for Claude Code context.

#### IMP-C03: worktree.json Namespace Growth

Adding `update.*` keys (estimated 5-8 keys) to the worktree namespace increases its size from 15 keys to approximately 20-23 keys. The C-002 guideline (split at 5+ domain-external keys) is appropriate. Current addition is within acceptable bounds.

---

## 6. Change Scope Summary

| Metric | Count |
|--------|-------|
| New source files | 5 |
| New test files | 4 |
| Modified source files | 2 |
| Modified locale files | 2 |
| Modified documentation files | 2 |
| **Total files affected** | **15** |
| Indirectly impacted files | 1 (test) |
| New npm dependencies | 0 |
| Database schema changes | 0 |
| CSP/security config changes | 0 |
| i18n config (src/i18n.ts) changes | 0 |

---

## 7. Cross-Layer Reference Analysis

The design introduces one new cross-layer reference:

| From | To | Function | Precedent | Risk |
|------|----|----------|-----------|------|
| `src/app/api/app/update-check/route.ts` (API Route layer) | `src/cli/utils/install-context.ts` (CLI layer) | `isGlobalInstall()` | `src/lib/db-path-resolver.ts:14` imports from same file | Low |

This cross-layer import is documented in CONS-001. The function `isGlobalInstall()` uses `__dirname` which is available in Node.js server-side execution. The design correctly ensures this function is only called in the API Route (server-side), never in client components.

The total cross-layer references from non-CLI modules to `src/cli/utils/install-context.ts` will increase from 1 to 2:
1. `src/lib/db-path-resolver.ts:14` (existing)
2. `src/app/api/app/update-check/route.ts` (new)

This is within the threshold where migration to `src/lib/install-context.ts` is not yet necessary, as noted in the design document.

---

## 8. Approval Status

**Conditionally Approved** (4/5)

The design's impact scope is well-defined and contained. The single must-fix item (IMP-001: existing test impact) requires verification before implementation begins but does not affect the design's architecture. All should-fix and consider items are low risk and can be addressed during implementation.

### Conditions for Full Approval

1. **IMP-001**: Verify `WorktreeDetailWebSocket.test.tsx` for Version-related assertions and add to modified files list if needed.

### Items to Address During Implementation

1. **IMP-SF-001**: Document fetchApi Content-Type behavior (no code change).
2. **IMP-SF-002**: Be prepared for PR review comments on `/api/app/` naming.
3. **IMP-SF-003**: Follow exact eslint-disable pattern from auto-yes-manager.ts.
4. **IMP-C01**: Add `tests/unit/hooks/useUpdateCheck.test.ts` to file structure.
5. **IMP-C02**: Expand CLAUDE.md documentation to include all new modules.

---

*Generated by Architecture Review Agent (Stage 3: Impact Analysis)*
*Date: 2026-02-13*
