# Architecture Review Report: Issue #225 - Stage 2 Consistency Review

**Date**: 2026-02-10
**Issue**: #225 (Auto-Yes有効時間選択機能)
**Focus**: 整合性 (Consistency - Design Document vs Implementation)
**Stage**: 2 (整合性レビュー)
**Status**: Needs Major Changes
**Score**: 2/5

---

## Executive Summary

This review compares the design policy document (`dev-reports/design/issue-225-auto-yes-duration-selection-design-policy.md`) against the current source code to evaluate consistency. The design document is comprehensive and well-structured, having already incorporated all Stage 1 review findings (MF-001, SF-001 through SF-003, CO-001 through CO-003).

However, **the implementation is completely unstarted**. None of the 11 design items defined in the design document have been implemented in the source code. The codebase remains in its pre-Issue-225 state. This results in a consistency score of 2/5 (needs_major_changes).

This finding is expected if the implementation phase has not yet begun -- the design document exists as a blueprint for future implementation. The specific gaps documented below serve as a precise implementation checklist.

---

## Detailed Findings

### Consistency Matrix

| Design Item | Design Specification | Implementation Status | Gap |
|-------------|---------------------|----------------------|-----|
| `src/config/auto-yes-config.ts` (new file) | ALLOWED_DURATIONS, AutoYesDuration, DEFAULT_AUTO_YES_DURATION, DURATION_LABELS | **Not created** | File does not exist |
| `auto-yes-manager.ts` - setAutoYesEnabled signature | `(worktreeId, enabled, duration?: AutoYesDuration)` | **Unchanged** | `(worktreeId, enabled)` only (L181) |
| `auto-yes-manager.ts` - AUTO_YES_TIMEOUT_MS removal | Delete constant, use DEFAULT_AUTO_YES_DURATION | **Not removed** | `const AUTO_YES_TIMEOUT_MS = 3600000` still at L68 |
| `auto-yes-manager.ts` - AutoYesState JSDoc | Update to remove hardcoded value reference | **Not updated** | JSDoc says "enabledAt + 3600000ms = 1 hour" (L25) |
| `route.ts` - duration validation | ALLOWED_DURATIONS.includes() + 400 error + duration propagation | **Not implemented** | No duration handling at all |
| `AutoYesConfirmDialog` - radio button UI | 3-option radio buttons, selectedDuration state, dynamic text | **Not implemented** | Static text "1時間後に..." (L46) |
| `AutoYesConfirmDialog` - onConfirm type | `(duration: AutoYesDuration) => void` | **Unchanged** | `() => void` (L18) |
| `AutoYesToggle` - onToggle type | `(enabled: boolean, duration?: AutoYesDuration) => Promise<void>` | **Unchanged** | `(enabled: boolean) => Promise<void>` (L20) |
| `AutoYesToggle` - formatTimeRemaining | H:MM:SS for hours > 0, MM:SS otherwise | **Not implemented** | MM:SS only (L32-37) |
| `WorktreeDetailRefactored` - handleAutoYesToggle | `(enabled, duration?)` + duration in API body | **Unchanged** | `(enabled)` only, no duration in body (L1149-1154) |
| Tests - duration test cases | 3h/8h tests, backward compat, AUTO_YES_TIMEOUT_MS migration | **Not implemented** | Only hardcoded 3600000 assertion (L64) |

---

### Must Fix Items (9 items)

#### MF-001: src/config/auto-yes-config.ts not created

The core shared configuration file does not exist. This file is the foundation of the entire design -- all layers (Client components, API route, Server business logic) are designed to import constants and types from this file.

**Design specification** (Section 4):
```typescript
// src/config/auto-yes-config.ts
export const ALLOWED_DURATIONS = [3600000, 10800000, 28800000] as const;
export type AutoYesDuration = typeof ALLOWED_DURATIONS[number];
export const DEFAULT_AUTO_YES_DURATION: AutoYesDuration = 3600000;
export const DURATION_LABELS: Record<AutoYesDuration, string> = {
  3600000: '1時間',
  10800000: '3時間',
  28800000: '8時間',
};
```

**Current state**: File does not exist at `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/config/auto-yes-config.ts`.

---

#### MF-002: setAutoYesEnabled() missing duration parameter

**Design specification** (Section 6-5):
```typescript
export function setAutoYesEnabled(
  worktreeId: string,
  enabled: boolean,
  duration?: AutoYesDuration
): AutoYesState
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/lib/auto-yes-manager.ts`, L181):
```typescript
export function setAutoYesEnabled(worktreeId: string, enabled: boolean): AutoYesState
```

The optional `duration` parameter is not present. The function body at L187 uses `AUTO_YES_TIMEOUT_MS` instead of `duration ?? DEFAULT_AUTO_YES_DURATION`.

---

#### MF-003: AUTO_YES_TIMEOUT_MS constant not removed

**Design specification** (Section 6-5, [MF-001]):
- Delete `AUTO_YES_TIMEOUT_MS` from `auto-yes-manager.ts`
- Add `import { DEFAULT_AUTO_YES_DURATION } from '@/config/auto-yes-config'`
- Replace all references

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/lib/auto-yes-manager.ts`):
- L68: `const AUTO_YES_TIMEOUT_MS = 3600000;` -- still present
- L187: `expiresAt: now + AUTO_YES_TIMEOUT_MS` -- still using old constant

---

#### MF-004: AutoYesConfirmDialog onConfirm type unchanged

**Design specification** (Section 6-1, [SF-003]):
```typescript
onConfirm: (duration: AutoYesDuration) => void;
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesConfirmDialog.tsx`, L18):
```typescript
onConfirm: () => void;
```

---

#### MF-005: AutoYesConfirmDialog radio button UI not implemented

The core UI feature of Issue #225 -- duration selection via radio buttons -- is completely absent.

**Design specification** (Section 6-1):
- Radio buttons generated from `ALLOWED_DURATIONS.map()`
- Internal state: `useState<AutoYesDuration>(DEFAULT_AUTO_YES_DURATION)`
- Dynamic text: `{DURATION_LABELS[selectedDuration]}後に自動でOFFになります。`
- Confirm button: `onClick={() => onConfirm(selectedDuration)}`

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesConfirmDialog.tsx`):
- No radio buttons
- No duration selection state
- Hardcoded text at L46: `1時間後に自動でOFFになります。`
- Confirm button at L81: `onClick={onConfirm}` (no arguments)

---

#### MF-006: AutoYesToggle onToggle type unchanged

**Design specification** (Section 6-2, [SF-003]):
```typescript
onToggle: (enabled: boolean, duration?: AutoYesDuration) => Promise<void>;
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesToggle.tsx`, L20):
```typescript
onToggle: (enabled: boolean) => Promise<void>;
```

The `handleConfirm` callback at L94-98 calls `onToggle(true)` without a duration argument.

---

#### MF-007: formatTimeRemaining lacks HH:MM:SS support

**Design specification** (Section 6-3):
```typescript
function formatTimeRemaining(expiresAt: number): string {
  // ...
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/AutoYesToggle.tsx`, L32-37):
```typescript
function formatTimeRemaining(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
```

No `hours` calculation, no `H:MM:SS` branch. With 3-hour or 8-hour durations, the display would show values like `180:00` or `480:00` instead of `3:00:00` or `8:00:00`.

---

#### MF-008: WorktreeDetailRefactored handleAutoYesToggle missing duration

**Design specification** (Section 6-4):
```typescript
const handleAutoYesToggle = useCallback(async (enabled: boolean, duration?: AutoYesDuration) => {
  body: JSON.stringify({ enabled, cliToolId: activeCliTab, duration }),
});
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/components/worktree/WorktreeDetailRefactored.tsx`, L1149-1154):
```typescript
const handleAutoYesToggle = useCallback(async (enabled: boolean): Promise<void> => {
  body: JSON.stringify({ enabled, cliToolId: activeCliTab }),
});
```

The `duration` parameter is absent from both the function signature and the API request body.

---

#### MF-009: route.ts missing duration validation

**Design specification** (Section 5):
```typescript
if (body.enabled && body.duration !== undefined) {
  if (!ALLOWED_DURATIONS.includes(body.duration)) {
    return NextResponse.json(
      { error: "Invalid duration value. Allowed values: 3600000, 10800000, 28800000" },
      { status: 400 }
    );
  }
}
const duration = body.duration ?? DEFAULT_AUTO_YES_DURATION;
// ...
const state = setAutoYesEnabled(params.id, body.enabled, duration);
```

**Current implementation** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/app/api/worktrees/[id]/auto-yes/route.ts`, L104):
```typescript
const state = setAutoYesEnabled(params.id, body.enabled);
```

No duration validation, no ALLOWED_DURATIONS import, no duration propagation to `setAutoYesEnabled`.

---

### Should Fix Items (2 items)

#### SF-001: AutoYesState JSDoc references hardcoded value

At `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/lib/auto-yes-manager.ts`, L25:
```typescript
/** Timestamp when auto-yes expires (enabledAt + 3600000ms = 1 hour) */
expiresAt: number;
```

The design document (Section 4) specifies a generic comment: "計算値のみ保持、durationは保持しない". Once duration becomes variable, the hardcoded "3600000ms = 1 hour" will be misleading.

---

#### SF-002: Test code lacks duration-specific test cases

The design document (Section 9) specifies the following test cases that do not exist:

1. `setAutoYesEnabled('wt-1', true, 10800000)` -- 3-hour duration test
2. `setAutoYesEnabled('wt-1', true, 28800000)` -- 8-hour duration test
3. `setAutoYesEnabled('wt-1', true)` -- backward compatibility (default 1 hour)
4. AUTO_YES_TIMEOUT_MS migration regression test
5. AutoYesConfirmDialog dynamic text verification test [CO-003]

Current test at `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/unit/lib/auto-yes-manager.test.ts`, L64 uses hardcoded `3600000`:
```typescript
expect(state.expiresAt).toBe(now + 3600000);
```

---

### Consider Items (2 items)

#### CO-001: useAutoYes hook does not propagate duration

The `useAutoYes` hook at `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/src/hooks/useAutoYes.ts` does not handle duration, which is consistent with the design document (no changes to this hook are specified). This is noted for completeness.

#### CO-002: Integration test backward compatibility

The integration test at `/Users/maenokota/share/work/github_kewton/commandmate-issue-225/tests/integration/auto-yes-persistence.test.ts` calls `setAutoYesEnabled('test-worktree-reload', true)` without a duration parameter. After the signature change, this should continue to work due to the optional parameter, but explicit verification may be beneficial.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | All 11 design items unimplemented; 100% design-code gap | High | High | P1 |
| Security | duration validation not implemented, but feature itself is not exposed | Medium | Low | P2 |
| Operational | Design doc is mature; implementation gap will grow if not addressed | Medium | Medium | P2 |

---

## Data Flow Gap Analysis

The design specifies the following data flow for duration:

```
AutoYesConfirmDialog (radio selection)
  -> onConfirm(duration: AutoYesDuration)
    -> AutoYesToggle.handleConfirm(duration)
      -> onToggle(true, duration)
        -> WorktreeDetailRefactored.handleAutoYesToggle(true, duration)
          -> POST /api/worktrees/:id/auto-yes { enabled: true, duration }
            -> route.ts validates duration via ALLOWED_DURATIONS.includes()
              -> setAutoYesEnabled(worktreeId, true, duration)
                -> expiresAt = now + (duration ?? DEFAULT_AUTO_YES_DURATION)
```

**Current state**: None of these duration propagation points exist. The entire chain from UI selection to server-side state management is absent.

---

## Improvement Recommendations

### Implementation Priority

Follow the design document's Section 11 implementation order exactly:

1. **Step 1**: Create `src/config/auto-yes-config.ts` (MF-001)
2. **Step 2**: Update `src/lib/auto-yes-manager.ts` - add duration parameter + delete AUTO_YES_TIMEOUT_MS (MF-002, MF-003)
3. **Step 3**: Update `src/app/api/worktrees/[id]/auto-yes/route.ts` - add validation (MF-009)
4. **Step 4**: Update `src/components/worktree/AutoYesConfirmDialog.tsx` - radio UI + type change (MF-004, MF-005)
5. **Step 5**: Update `src/components/worktree/AutoYesToggle.tsx` - duration propagation + HH:MM:SS (MF-006, MF-007)
6. **Step 6**: Update `src/components/worktree/WorktreeDetailRefactored.tsx` - API call change (MF-008)
7. **Step 7**: Update tests (SF-002)
8. **Step 8**: Update JSDoc comments (SF-001) and documentation

### Verification Checklist

After implementation, verify:
- [ ] `AUTO_YES_TIMEOUT_MS` does not appear in codebase (grep confirmation)
- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run lint` passes
- [ ] `npm run test:unit` passes
- [ ] `npm run build` succeeds
- [ ] Manual test: dialog shows 3 radio options
- [ ] Manual test: 3-hour selection displays 3:00:00 countdown
- [ ] Manual test: invalid duration via curl returns 400

---

## Approval Status

**Status**: Needs Major Changes (2/5)

The design document itself is well-crafted and ready for implementation. The low score reflects the complete absence of implementation, not a flaw in the design. Once implementation begins following the documented order, the consistency score should rise rapidly as each step is completed.

---

*Generated by architecture-review-agent*
*Review type: Stage 2 - Consistency (Design vs Implementation)*
*Date: 2026-02-10*
