# Architecture Review: Issue #314 - Stage 3 Impact Analysis

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #314 Auto-Yes Stop Condition (Regex) |
| Stage | 3: Impact Analysis Review |
| Date | 2026-02-19 |
| Status | **conditionally_approved** |
| Score | **4/5** |
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 4 |

This Stage 3 review analyzes the ripple effects of the proposed design changes across the existing codebase. The design is well-structured with clear module boundaries, but three items require attention before implementation: the dual rendering sites of AutoYesToggle in WorktreeDetailRefactored, the local CurrentOutputResponse type update, and the atomicity of the AutoYesConfirmDialog/AutoYesToggle signature changes.

---

## 1. Type Change Impact Analysis

### 1.1 AutoYesState Interface Extension

**File**: `src/lib/auto-yes-manager.ts` (L22-29)

The current `AutoYesState` interface has 3 fields. The design adds 2 optional fields (`stopPattern?: string`, `stopReason?: 'expired' | 'stop_pattern_matched'`).

| Referencing File | Location | Impact | Risk |
|-----------------|----------|--------|------|
| `src/lib/auto-yes-manager.ts` | L22-29 (definition) | Direct change | Low |
| `src/lib/auto-yes-manager.ts` | L116-121 (`declare global`) | Auto-inherits new fields via type reference | None |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | L17 (`type AutoYesState` import) | Type used in `buildAutoYesResponse()`, no runtime breakage | Low |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L105 (`getAutoYesState`) | Returns state; response object must be updated to include `stopReason` | Low |
| `tests/unit/lib/auto-yes-manager.test.ts` | L21 (`type AutoYesState` import), L177-211 (inline literals) | Inline literals create `AutoYesState` without new fields; valid because fields are optional | None |
| `tests/integration/auto-yes-persistence.test.ts` | Indirect via `setAutoYesEnabled` | No direct type reference; backward compatible | None |

**Verdict**: Low risk. Optional fields preserve full backward compatibility. No existing code will break from the type extension.

### 1.2 CurrentOutputResponse Local Type

**File**: `src/components/worktree/WorktreeDetailRefactored.tsx` (L76-89)

This is a client-local interface that must be manually synchronized with the server response shape. The current definition:

```typescript
autoYes?: {
  enabled: boolean;
  expiresAt: number | null;
};
```

Must become:

```typescript
autoYes?: {
  enabled: boolean;
  expiresAt: number | null;
  stopReason?: 'expired' | 'stop_pattern_matched';
};
```

**[DS3-F002 - MUST FIX]**: Without this update, the toast notification logic (`data.autoYes.stopReason`) will fail TypeScript compilation. The design doc mentions this change but does not specify the exact line numbers in the client-local type.

### 1.3 AutoYesToggleParams Object Argument Pattern

**File**: `src/components/worktree/AutoYesToggle.tsx` (L18-31)

The current `onToggle` signature:

```typescript
onToggle: (enabled: boolean, duration?: AutoYesDuration) => Promise<void>;
```

Changes to:

```typescript
onToggle: (params: AutoYesToggleParams) => Promise<void>;
```

| Caller Site | File | Current Code | Required Change |
|------------|------|-------------|-----------------|
| `handleDisable` | AutoYesToggle.tsx L81 | `onToggle(false)` | `onToggle({ enabled: false })` |
| `handleConfirm` | AutoYesToggle.tsx L91 | `onToggle(true, duration)` | `onToggle({ enabled: true, duration, stopPattern })` |
| Desktop render | WorktreeDetailRefactored.tsx L1814 | `onToggle={handleAutoYesToggle}` | Type-compatible via function reference |
| Mobile render | WorktreeDetailRefactored.tsx L1953 | `onToggle={handleAutoYesToggle}` | Type-compatible via function reference |
| `handleAutoYesToggle` definition | WorktreeDetailRefactored.tsx L1188 | `async (enabled: boolean, duration?: AutoYesDuration)` | `async (params: AutoYesToggleParams)` |

**[DS3-F001 - MUST FIX]**: Both desktop (L1814) and mobile (L1953) render sites pass the same `handleAutoYesToggle` function reference. The single function definition at L1188 must change. No other call sites exist in the codebase (confirmed via grep).

---

## 2. API Signature Change Impact

### 2.1 setAutoYesEnabled() 4th Parameter Addition

**File**: `src/lib/auto-yes-manager.ts` (L213)

Current: `setAutoYesEnabled(worktreeId, enabled, duration?)`
Proposed: `setAutoYesEnabled(worktreeId, enabled, duration?, stopPattern?)`

| Call Site | File | Line | Current Args | Impact |
|-----------|------|------|-------------|--------|
| Enable | auto-yes/route.ts | L136 | `(params.id, body.enabled, duration)` | Must add `stopPattern` 4th arg |
| Enable (test) | auto-yes-manager.test.ts | L62 | `('wt-1', true)` | Backward compatible (optional) |
| Enable (test) | auto-yes-manager.test.ts | L74 | `('wt-1', true, 10800000)` | Backward compatible |
| Enable (test) | auto-yes-manager.test.ts | L86 | `('wt-1', true, 28800000)` | Backward compatible |
| Disable (test) | auto-yes-manager.test.ts | L104-105 | `('wt-1', true)` then `('wt-1', false)` | Backward compatible |
| Integration | auto-yes-persistence.test.ts | L39, 73, 102, 119, 125, 166 | Various 2-3 arg forms | All backward compatible |

**Verdict**: All 15+ existing call sites are backward compatible since `stopPattern` is optional. Only the route.ts call site needs updating to pass the new parameter.

### 2.2 AutoYesConfirmDialog.onConfirm Signature Change

**File**: `src/components/worktree/AutoYesConfirmDialog.tsx` (L27)

Current: `onConfirm: (duration: AutoYesDuration) => void`
Proposed: `onConfirm: (duration: AutoYesDuration, stopPattern?: string) => void`

**[DS3-F003 - MUST FIX]**: The onConfirm callback flows through AutoYesToggle.handleConfirm (L88-92), which must destructure and forward the stopPattern to onToggle. These two file changes must be atomic.

### 2.3 AutoYesToggle.onToggle Signature Change (Breaking)

This is the most impactful API change. See Section 1.3 above for full call site analysis.

---

## 3. New Function Impact

### 3.1 disableAutoYes()

**Purpose**: Replace direct `autoYesStates.set()` calls in the disable path.

| Caller | Context | Impact |
|--------|---------|--------|
| `setAutoYesEnabled(id, false)` | Delegated from disable path | Replaces L224-233 inline code |
| `getAutoYesState()` | Expired state handling | Replaces L197-202 inline code |
| `checkStopCondition()` | Stop pattern matched | New call site |
| `pollAutoYes()` | Existing direct Map operations | **Removes** direct `autoYesStates.set()` calls |

**Impact on existing code**: The `getAutoYesState()` function at L196-203 currently creates a new state object with spread operator and sets it directly. This will be replaced by `disableAutoYes(worktreeId, 'expired')`. The behavior is equivalent but with explicit `stopReason` tracking.

### 3.2 checkStopCondition()

**Purpose**: Extracted stop condition logic for SRP compliance.

**Insertion point**: Between thinking detection (L382-385) and prompt detection (L387-396) in `pollAutoYes()`.

**Performance impact**: One `getAutoYesState()` call + one `new RegExp()` + one `regex.test()` per poll cycle when stopPattern is set. Total overhead: ~5-10 microseconds against a 2000ms polling interval. Negligible (0.0005% of cycle time).

### 3.3 validateStopPattern()

**File**: Added to `src/config/auto-yes-config.ts`

**Import sites**: 2 (AutoYesConfirmDialog.tsx client-side, auto-yes/route.ts server-side).

**Bundle impact**: The function adds ~20 lines of code to a shared config file. Since `auto-yes-config.ts` is already imported by client components, no new chunk is created. The `new RegExp()` constructor is a built-in, adding no bundle size.

---

## 4. Test Impact Analysis

### 4.1 Breaking Test Changes (Must Modify)

| Test File | Lines | Reason | Effort |
|-----------|-------|--------|--------|
| `AutoYesToggle.test.tsx` | L45, L59, L81 | `toHaveBeenCalledWith` args change from positional to object | Low (~3 line edits) |
| `AutoYesToggle.test.tsx` | L17 | Mock `onToggle` signature must change | Low (1 edit) |

### 4.2 Backward Compatible (No Modification Required)

| Test File | Lines | Reason |
|-----------|-------|--------|
| `auto-yes-manager.test.ts` | All ~10 `setAutoYesEnabled` calls | 4th param is optional |
| `auto-yes-config.test.ts` | All existing tests | No changes to existing functions |
| `AutoYesConfirmDialog.test.tsx` | L119, L127, L135 | `onConfirm` 2nd param is optional; existing assertions pass |
| `auto-yes-persistence.test.ts` | All ~5 `setAutoYesEnabled` calls | 4th param is optional |

### 4.3 New Tests Required

| Test File | Approximate New Tests | Coverage Area |
|-----------|----------------------|---------------|
| `auto-yes-manager.test.ts` | ~12-15 cases | `disableAutoYes()`, `checkStopCondition()`, stop pattern flow, re-enable clearing |
| `auto-yes-config.test.ts` | ~5-8 cases | `validateStopPattern()`, `MAX_STOP_PATTERN_LENGTH` |
| `AutoYesConfirmDialog.test.tsx` | ~5-7 cases | stopPattern input, validation UI, reset on reopen, onConfirm with pattern |
| `AutoYesToggle.test.tsx` | ~2-3 cases | stopPattern passthrough in object args |
| `auto-yes-persistence.test.ts` | ~2-3 cases | stopPattern/stopReason persistence across reload |

**Total estimated new tests**: 26-36 test cases.

---

## 5. Build and Bundle Impact

| Aspect | Impact | Details |
|--------|--------|---------|
| `auto-yes-config.ts` size | +~30 lines | `validateStopPattern()` + `MAX_STOP_PATTERN_LENGTH` constant |
| Client bundle | Negligible | `auto-yes-config.ts` already in client bundle; no new imports |
| Server bundle | Negligible | `auto-yes-manager.ts` changes are server-only |
| TypeScript compilation | No new dependencies | All new types use built-in TypeScript constructs |
| i18n bundle | +6 keys per locale | ~200 bytes per locale file |

---

## 6. Backward Compatibility Assessment

| Scenario | Compatibility | Explanation |
|----------|--------------|-------------|
| Auto-Yes without stopPattern | Full | All new fields are optional; existing flow unchanged |
| globalThis cached old-format states | Compatible | Optional field access returns undefined = no stop condition |
| API clients not sending stopPattern | Compatible | Server normalizes `undefined` stopPattern correctly |
| API clients not reading stopReason | Compatible | Extra field in JSON response is safely ignored |
| Tests with 3-arg setAutoYesEnabled | Compatible | 4th parameter is optional |
| Re-enable after stop condition | Compatible | `setAutoYesEnabled(true)` clears stopPattern/stopReason |

---

## 7. Concurrency and Race Condition Analysis

| Scenario | Risk | Mitigation |
|----------|------|-----------|
| `pollAutoYes` + API concurrent `setAutoYesEnabled` | Low | Node.js single-threaded; `checkStopCondition` reads fresh state via `getAutoYesState()` |
| `disableAutoYes` + `getAutoYesState` concurrent calls | None | Single-threaded; Map operations are atomic |
| Multiple browser tabs polling same worktree | Low | Server-side polling is per-worktree; client polling is additive but idempotent |
| Hot reload during active polling | Low | globalThis preserves state; new module code reads existing state correctly |

---

## 8. i18n Impact

| Aspect | Impact |
|--------|--------|
| New translation keys | 6 keys (see DS2-F011 table) |
| Existing keys | Unchanged |
| Key naming convention | camelCase (consistent with existing 19 keys) |
| Namespace | `autoYes` (unchanged) |
| Loading mechanism | next-intl `getRequestConfig` - no changes needed |
| Locale files | `locales/ja/autoYes.json`, `locales/en/autoYes.json` |

---

## 9. Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | **Medium** | Breaking change in AutoYesToggle.onToggle signature affects 3 test assertions and 1 component handler. Mitigated by clear Before/After documentation in DS2-F007. |
| Security | **Low** | ReDoS mitigation via 500-char limit + 5000-char target. Defense-in-depth with client+server validation. |
| Operational | **Low** | Optional fields ensure zero downtime. No database migration. In-memory state only. |

---

## 10. Impact Summary Table

| Category | File | Change Type | Risk |
|----------|------|------------|------|
| Direct Change | `src/lib/auto-yes-manager.ts` | Type extension + 3 new functions + flow modification | Medium |
| Direct Change | `src/config/auto-yes-config.ts` | 1 new constant + 1 new function | Low |
| Direct Change | `src/components/worktree/AutoYesConfirmDialog.tsx` | Props change + new state + validation UI | Medium |
| Direct Change | `src/components/worktree/AutoYesToggle.tsx` | **Breaking**: onToggle signature change | Medium |
| Direct Change | `src/components/worktree/WorktreeDetailRefactored.tsx` | Handler signature + type + toast logic | Medium |
| Direct Change | `src/app/api/worktrees/[id]/auto-yes/route.ts` | Validation + parameter passthrough | Low |
| Direct Change | `src/app/api/worktrees/[id]/current-output/route.ts` | 1 field addition to response | Low |
| Direct Change | `locales/ja/autoYes.json` | +6 keys | Low |
| Direct Change | `locales/en/autoYes.json` | +6 keys | Low |
| Test Modification | `tests/unit/components/worktree/AutoYesToggle.test.tsx` | **Breaking**: 3 assertion changes | Medium |
| Test Addition | `tests/unit/lib/auto-yes-manager.test.ts` | ~12-15 new test cases | Low |
| Test Addition | `tests/unit/config/auto-yes-config.test.ts` | ~5-8 new test cases | Low |
| Test Addition | `tests/unit/components/worktree/AutoYesConfirmDialog.test.tsx` | ~5-7 new test cases | Low |
| Test Addition | `tests/integration/auto-yes-persistence.test.ts` | ~2-3 new test cases | Low |
| Unaffected | `src/hooks/useAutoYes.ts` | No changes needed | None |
| Unaffected | `src/lib/session-cleanup.ts` | No changes needed | None |
| Unaffected | `src/lib/prompt-key.ts` | No changes needed | None |

---

## 11. Findings Summary

### Must Fix (3)

| ID | Title |
|----|-------|
| DS3-F001 | AutoYesToggle onToggle signature change affects WorktreeDetailRefactored handleAutoYesToggle at L1188 (dual render sites L1814, L1953) |
| DS3-F002 | CurrentOutputResponse local type at L85-88 must add stopReason field for TypeScript compilation |
| DS3-F003 | AutoYesConfirmDialog.onConfirm and AutoYesToggle.handleConfirm changes must be atomic |

### Should Fix (7)

| ID | Title |
|----|-------|
| DS3-F004 | AutoYesConfirmDialog.test.tsx needs new tests for stopPattern parameter |
| DS3-F005 | AutoYesToggle.test.tsx L45, L59, L81 assertions MUST change (breaking) |
| DS3-F006 | auto-yes-manager.test.ts needs ~12-15 new test cases |
| DS3-F007 | Document that globalThis old-format states are handled by optional field access |
| DS3-F008 | Document that checkStopCondition reads fresh state via getAutoYesState |
| DS3-F009 | RegExp compilation per poll cycle is acceptable; document as future optimization |
| DS3-F010 | Six new i18n keys must maintain existing camelCase convention |

### Nice to Have (4)

| ID | Title |
|----|-------|
| DS3-F011 | Export AutoYesToggleParams from AutoYesToggle.tsx for WorktreeDetailRefactored import |
| DS3-F012 | buildAutoYesResponse helper in auto-yes/route.ts does not include stopReason (acceptable) |
| DS3-F013 | useAutoYes hook requires no changes (verify during implementation) |
| DS3-F014 | session-cleanup.ts stopAutoYesPolling import is unaffected |

---

## 12. Approval

**Status: Conditionally Approved (4/5)**

The design's impact on the existing codebase is well-contained within the Auto-Yes module boundary. The 3 must-fix items are documentation gaps rather than design flaws:

1. **DS3-F001**: Ensure the design doc explicitly acknowledges the dual render sites
2. **DS3-F002**: Add exact line numbers for the CurrentOutputResponse type update
3. **DS3-F003**: Add atomicity note for the AutoYesConfirmDialog/AutoYesToggle signature chain

Once these are addressed, the implementation can proceed with confidence that the impact scope is fully understood and all affected files have been identified.

---

*Generated by architecture-review-agent (Stage 3: Impact Analysis) on 2026-02-19*
