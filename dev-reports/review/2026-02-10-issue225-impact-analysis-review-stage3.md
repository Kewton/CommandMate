# Architecture Review: Issue #225 - Impact Analysis (Stage 3)

**Date**: 2026-02-10
**Issue**: #225 Auto-Yes Duration Selection
**Focus Area**: Impact Scope Analysis
**Status**: Conditionally Approved (4/5)

---

## Executive Summary

This Stage 3 review analyzes the impact scope of the Issue #225 design policy for Auto-Yes duration selection. The design policy document is thorough and well-structured, identifying the 6 primary files that require direct modification and laying out a bottom-up implementation order. However, the impact analysis is missing several indirect dependencies and test files that will be affected by the changes.

The overall risk is low because: (1) all function signature changes use optional parameters preserving backward compatibility, (2) the AutoYesState interface is unchanged, (3) no database migration is needed, and (4) the change is contained within a well-bounded feature area. Two must-fix items relate to incomplete dependency tracing, and four should-fix items address documentation and test coverage gaps.

---

## Impact Scope Analysis

### Direct Changes (Identified in Design Policy)

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| New File | `src/config/auto-yes-config.ts` | ALLOWED_DURATIONS, AutoYesDuration, DEFAULT_AUTO_YES_DURATION, DURATION_LABELS | Low |
| Server Logic | `src/lib/auto-yes-manager.ts` | Delete AUTO_YES_TIMEOUT_MS, add duration param to setAutoYesEnabled, import DEFAULT_AUTO_YES_DURATION | Low |
| API Route | `src/app/api/worktrees/[id]/auto-yes/route.ts` | Add duration validation (whitelist), pass duration to setAutoYesEnabled | Low |
| UI Component | `src/components/worktree/AutoYesConfirmDialog.tsx` | Add radio button UI, update onConfirm signature | Low |
| UI Component | `src/components/worktree/AutoYesToggle.tsx` | Update onToggle signature, extend formatTimeRemaining for H:MM:SS | Low |
| UI Component | `src/components/worktree/WorktreeDetailRefactored.tsx` | Update handleAutoYesToggle to accept and pass duration | Low |

### Indirect Dependencies (Missing from Design Policy)

| Category | File | Dependency | Impact | Risk |
|----------|------|-----------|--------|------|
| API Route | `src/app/api/worktrees/[id]/current-output/route.ts` | Imports `getAutoYesState`, `getLastServerResponseTimestamp` from auto-yes-manager.ts | No change needed - AutoYesState interface unchanged, but should be verified | None |
| Server Logic | `src/lib/session-cleanup.ts` | Imports `stopAutoYesPolling` from auto-yes-manager.ts | No change needed - stopAutoYesPolling signature unchanged | None |
| Client Hook | `src/hooks/useAutoYes.ts` | Client-side auto-yes hook, calls prompt-response API (not auto-yes API) | No change needed - does not interact with duration | None |
| Server Logic | `src/lib/auto-yes-resolver.ts` | Called by pollAutoYes in auto-yes-manager.ts | No change needed - resolves prompt answers, unrelated to duration | None |

These four files were not mentioned in the design policy's impact analysis. While none require code changes, their dependencies should be documented to ensure implementers verify the no-impact assumption.

### Test Impact Analysis

| Test File | Change Needed | Status in Design |
|-----------|---------------|------------------|
| `tests/unit/lib/auto-yes-manager.test.ts` | Add duration parameter tests, update L64 hardcoded 3600000 assertion, add migration regression test | Identified |
| `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | **Breaking**: Update onConfirm assertion from no-args to expect duration arg; add radio button tests | **Missing** |
| `tests/unit/components/worktree/AutoYesToggle.test.tsx` | **Breaking**: Update onToggle assertion from `(true)` to `(true, duration)`; add H:MM:SS format tests | **Missing** |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | Verify AutoYesToggle mock compatibility with new props | **Missing** |
| `tests/integration/auto-yes-persistence.test.ts` | Add custom duration persistence test | Partially identified |

### Documentation Impact

| Document | Change Needed | Status in Design |
|----------|---------------|------------------|
| `docs/TRUST_AND_SAFETY.md` | Add maximum 8-hour duration note | Identified |
| `CLAUDE.md` | Add auto-yes-config.ts to module table, update auto-yes-manager.ts description | **Missing** |

---

## Detailed Findings

### Must-Fix Items

#### MF-001: Missing Indirect Dependency Documentation

The design policy identifies 6 files for direct modification but does not document the 4 files that have import dependencies on `auto-yes-manager.ts`:

1. **`src/app/api/worktrees/[id]/current-output/route.ts`** (L15): `import { getAutoYesState, getLastServerResponseTimestamp } from '@/lib/auto-yes-manager'`
2. **`src/lib/session-cleanup.ts`** (L12): `import { stopAutoYesPolling } from './auto-yes-manager'`
3. **`src/hooks/useAutoYes.ts`**: Uses the prompt-response API, not auto-yes API
4. **`src/lib/auto-yes-resolver.ts`**: Called by pollAutoYes

While none of these need code changes (the exported function signatures they use are not modified, and AutoYesState interface is unchanged), they should be explicitly listed in the impact analysis with a "verified no-impact" designation. This prevents implementers from discovering these dependencies during implementation and creating uncertainty.

**Recommendation**: Add an "Indirect Dependencies (No Change Needed)" table to the design policy section 11 (implementation order) or create a new section documenting verified dependencies.

#### MF-002: Existing Test Breaking Changes Not Documented

The design policy section 9 describes new tests to add but does not explicitly document which existing test assertions will break:

1. **`AutoYesConfirmDialog.test.tsx` L66**: Currently asserts `expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1)`. After the change, onConfirm will be called with a duration argument. The test should be updated to: `expect(defaultProps.onConfirm).toHaveBeenCalledWith(3600000)` (default duration since no radio button is changed).

2. **`AutoYesToggle.test.tsx` L43**: Currently asserts `expect(defaultProps.onToggle).toHaveBeenCalledWith(true)`. After the change, this will be called with `(true, 3600000)`. The test must be updated accordingly.

3. **`AutoYesToggle.test.tsx` L70**: Currently asserts `expect(defaultProps.onToggle).toHaveBeenCalledWith(false)`. The OFF-toggle path does not pass duration, so this should remain `(false)` -- but this must be verified.

**Recommendation**: Add a "Test Migration" subsection to section 9 listing each existing test assertion that will break and the required update.

### Should-Fix Items

#### SF-001: WorktreeDetailRefactored.test.tsx Mock Compatibility

`WorktreeDetailRefactored.test.tsx` mocks `AutoYesToggle` as a child component. If TypeScript strict mode catches the interface mismatch between the mock and the new `AutoYesToggleProps` (specifically the updated `onToggle` signature), the test will fail to compile.

**Recommendation**: Review and update the AutoYesToggle mock in `WorktreeDetailRefactored.test.tsx`.

#### SF-002: session-cleanup.ts Not in Impact Analysis

`src/lib/session-cleanup.ts` imports `stopAutoYesPolling` from `auto-yes-manager.ts`. While the function signature is not changing, best practice is to document verified-no-impact dependencies.

**Recommendation**: Add to impact analysis with "No change needed" status.

#### SF-003: TRUST_AND_SAFETY.md Update Lacks Specificity

The design policy mentions updating `docs/TRUST_AND_SAFETY.md` but does not specify the exact content. The current document (L48-49) mentions Auto Yes mode but does not state any specific timeout duration.

**Recommendation**: Specify the exact update content: "Auto Yes mode has a maximum selectable duration of 8 hours. Shorter durations (1 hour default) are recommended."

#### SF-004: Integration Test for Custom Duration Persistence

`tests/integration/auto-yes-persistence.test.ts` verifies that auto-yes state survives module reload. Currently it only tests the default duration. A custom duration (e.g., 3 hours) should also be tested to ensure the expiresAt calculation with a non-default duration persists correctly.

**Recommendation**: Add a test case: `setAutoYesEnabled('test-duration-reload', true, 10800000)`, then reload module and verify `state.expiresAt` reflects the 3-hour duration.

### Consider Items

#### CO-001: auto-yes-resolver.ts Verification

`src/lib/auto-yes-resolver.ts` is called by `pollAutoYes` within `auto-yes-manager.ts`. The duration change does not affect the resolver. Document as verified.

#### CO-002: Mobile Layout Visual Testing for H:MM:SS

The `formatTimeRemaining` change produces wider strings for durations over 1 hour (e.g., "8:00:00" instead of "59:59"). On mobile, `AutoYesToggle` is rendered in `inline` mode within a flex container. The wider string could potentially cause overflow.

**Recommendation**: Manual testing with 3-hour and 8-hour durations on mobile viewport.

#### CO-003: CLAUDE.md Module Table Update

`CLAUDE.md` maintains a comprehensive module table. The new `src/config/auto-yes-config.ts` file should be added, and `auto-yes-manager.ts` description should be updated.

---

## Risk Assessment

| Risk Category | Content | Severity | Probability | Priority |
|---------------|---------|----------|-------------|----------|
| Technical | Indirect dependencies not verified during implementation | Low | Medium | P2 |
| Technical | Existing tests break silently if not updated before PR | Low | High | P1 |
| Security | Max 8-hour auto-yes window (vs current 1 hour) | Low | Low | P3 |
| Operational | Mobile UI overflow with longer countdown string | Low | Low | P3 |

---

## Backward Compatibility Assessment

| Aspect | Status | Details |
|--------|--------|---------|
| REST API | Maintained | `duration` field is optional in POST body. Omitting defaults to 3600000 ms (1 hour). Response schema unchanged. |
| Internal API | Maintained | `setAutoYesEnabled()` new `duration` parameter is optional. All existing callers continue to work. |
| State Interface | Maintained | `AutoYesState` interface unchanged. No new fields. `expiresAt` continues to be the sole timing field. |
| Database | No Change | In-memory state only. No DB migration needed. |
| Client Hooks | Maintained | `useAutoYes` does not interact with duration. No changes needed. |

---

## Completeness Assessment

### Files Identified by Design Policy: 6/6 (Complete for direct changes)

### Files Missing from Design Policy:

| Category | Count | Files |
|----------|-------|-------|
| Indirect dependencies (no change needed) | 4 | current-output/route.ts, session-cleanup.ts, useAutoYes.ts, auto-yes-resolver.ts |
| Test files needing updates | 3 | AutoYesConfirmDialog.test.tsx, AutoYesToggle.test.tsx, WorktreeDetailRefactored.test.tsx |
| Documentation needing updates | 1 | CLAUDE.md |

### Test Coverage Assessment

| Test Type | Existing Coverage | New Coverage Needed | Status |
|-----------|-------------------|---------------------|--------|
| Unit: auto-yes-manager.ts | setAutoYesEnabled, getAutoYesState, polling | Duration parameter, migration regression | Planned in design |
| Unit: AutoYesConfirmDialog.tsx | Rendering, interactions | Radio button, dynamic text, duration callback | Partially planned |
| Unit: AutoYesToggle.tsx | Toggle on/off, dialog | Duration propagation, H:MM:SS format | Partially planned |
| Unit: WorktreeDetailRefactored.tsx | Full component rendering | Mock compatibility | Not planned |
| Integration: persistence | Module reload | Duration persistence across reload | Not planned |
| E2E/Manual: route.ts | N/A | Invalid duration 400 response | Planned in design |

---

## Conclusion

The design policy for Issue #225 is well-structured with clear implementation order, type-safe design decisions, and proper server/client bundle separation. The impact scope analysis is strong for direct changes but has gaps in indirect dependency documentation and test file impact assessment.

The two must-fix items (MF-001: indirect dependency documentation, MF-002: existing test breaking changes) should be addressed before implementation begins to prevent discovery-during-implementation delays. All other items are improvements to an already solid design.

**Approval**: Conditionally approved, pending documentation of indirect dependencies and test migration plan.

---

*Generated by architecture-review-agent*
*Stage: 3 (Impact Analysis)*
*Date: 2026-02-10*
