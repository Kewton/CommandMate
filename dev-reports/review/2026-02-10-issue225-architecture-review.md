# Architecture Review Report: Issue #225 Auto-Yes Duration Selection

| Item | Value |
|------|-------|
| **Issue** | #225 |
| **Focus Area** | Design Principles (SOLID, KISS, YAGNI, DRY) |
| **Stage** | 1 (Standard Review) |
| **Status** | Conditionally Approved |
| **Score** | 4 / 5 |
| **Date** | 2026-02-10 |

---

## Executive Summary

The design policy for Issue #225 (Auto-Yes Duration Selection) is well-structured and demonstrates strong adherence to design principles. The feature adds user-selectable durations (1h/3h/8h) to the existing Auto-Yes mode, which was previously hardcoded to 1 hour.

Key strengths:
- Clean separation of shared config from server-only modules (Server/Client bundle boundary awareness)
- Minimal changes to existing architecture (no DB schema changes, in-memory pattern preserved)
- Explicit rejection of over-engineered alternatives (custom input, DB persistence) with documented rationale
- Type-safe duration propagation using `as const` tuple and literal union types

One must-fix item was identified regarding DRY principle compliance: the existing `AUTO_YES_TIMEOUT_MS` constant must be explicitly removed and replaced by `DEFAULT_AUTO_YES_DURATION` from the new shared config.

---

## Design Principles Evaluation

### Single Responsibility Principle (SRP) -- PASS

The design clearly separates concerns across layers:

| Layer | File | Responsibility |
|-------|------|----------------|
| Config | `src/config/auto-yes-config.ts` | Pure constants and type definitions |
| Presentation | `AutoYesConfirmDialog.tsx` | Duration selection UI |
| Presentation | `AutoYesToggle.tsx` | Duration propagation and countdown display |
| API | `route.ts` | Request validation and routing |
| Business Logic | `auto-yes-manager.ts` | State management and expiry calculation |

The decision to create a separate `src/config/auto-yes-config.ts` rather than placing constants in `auto-yes-manager.ts` is well-justified. The existing codebase follows this pattern consistently (`src/config/status-colors.ts`, `src/config/z-index.ts`, etc.), and it solves the real Next.js Server/Client bundle boundary problem documented in the design.

**Existing config pattern verification**: The proposed file structure mirrors established patterns:

```
src/config/status-colors.ts  -> exports: types + as const objects + Record mappings
src/config/z-index.ts        -> exports: as const object + derived type
src/config/auto-yes-config.ts -> exports: as const tuple + derived type + Record mapping
```

### Open/Closed Principle (OCP) -- PASS

The design supports extension without modification:

- `ALLOWED_DURATIONS` is an `as const` tuple. Adding a new duration value (e.g., 12 hours) requires only:
  1. Adding the value to `ALLOWED_DURATIONS` array
  2. Adding the label to `DURATION_LABELS` record (compiler-enforced by `Record<AutoYesDuration, string>`)
- The UI renders radio buttons dynamically from `ALLOWED_DURATIONS.map()`, so no component code changes needed for new values
- Server-side validation uses `ALLOWED_DURATIONS.includes()`, automatically accepting new values

The TypeScript compiler acts as a guard: if a developer adds a value to `ALLOWED_DURATIONS` but forgets `DURATION_LABELS`, the `Record<AutoYesDuration, string>` type will produce a compile error.

### Liskov Substitution Principle (LSP) -- NOT APPLICABLE

No inheritance hierarchies are involved. The `AutoYesState` interface is unchanged, which maintains compatibility with all existing consumers.

### Interface Segregation Principle (ISP) -- PASS

A notable design decision is that `AutoYesState` does **not** gain a `duration` field:

```typescript
// Current and proposed (unchanged):
export interface AutoYesState {
  enabled: boolean;
  enabledAt: number;
  expiresAt: number;  // Computed value only
}
```

This is the correct choice. Duration is a transient input parameter, not persistent state. The `expiresAt` field is the computed result (`enabledAt + duration`), and storing both would create redundancy and potential inconsistency. Clients need only `expiresAt` for countdown display.

### Dependency Inversion Principle (DIP) -- PASS

The dependency graph flows cleanly:

```
Client components --> src/config/auto-yes-config.ts <-- Server modules
```

Both client and server modules depend on the same shared abstraction (config constants), rather than depending on each other. This avoids the bundle contamination problem and follows the existing project pattern.

### KISS Principle -- PASS

The design prioritizes simplicity at every decision point:

1. **No DB changes**: Duration is handled entirely in-memory, consistent with existing `AutoYesState` management
2. **No new dependencies**: Radio buttons use standard HTML + Tailwind CSS
3. **Minimal API change**: One optional field (`duration`) added to existing POST body
4. **Backward compatible**: Omitting `duration` defaults to 1 hour (existing behavior)
5. **Explicit alternative rejection**: Custom time input, free-form minutes, and DB persistence were considered and rejected with documented reasoning

The `formatTimeRemaining` enhancement (MM:SS to H:MM:SS) is a necessary change to support durations exceeding 59:59, and the implementation is straightforward.

### YAGNI Principle -- PASS

The design explicitly avoids premature features:

| Rejected Feature | Reason |
|-----------------|--------|
| Custom time input (free-form minutes) | Validation complexity, UX degradation |
| Unlimited/indefinite option | Safety concern, contradicts timeout purpose |
| DB persistence of duration | Unnecessary; in-memory state is sufficient |
| `duration` field in `AutoYesState` | Redundant with `expiresAt` |

The three duration choices (1h/3h/8h) cover practical use cases without over-engineering.

### DRY Principle -- CONDITIONAL PASS

**Strengths**:
- `ALLOWED_DURATIONS` and `DURATION_LABELS` are defined once in the shared config
- The config is imported by all consumers (dialog, route, manager)
- UI text is derived from `DURATION_LABELS[selectedDuration]` rather than hardcoded

**Issue (MF-001)**: The existing `AUTO_YES_TIMEOUT_MS = 3600000` constant in `auto-yes-manager.ts` (line 68) is semantically identical to `DEFAULT_AUTO_YES_DURATION`. The design document shows the new code using `duration ?? DEFAULT_AUTO_YES_DURATION` but does not explicitly call out the removal of `AUTO_YES_TIMEOUT_MS`. If this constant is not removed during implementation, there will be two sources of truth for the default timeout value.

---

## Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|------------|--------|-------------|----------|
| Technical | AUTO_YES_TIMEOUT_MS not removed, causing DRY violation | Low | Medium | P2 |
| Technical | Existing tests using hardcoded 3600000 need update to DEFAULT_AUTO_YES_DURATION | Low | Medium | P2 |
| Security | Duration whitelist validation is server-side (correct approach) | Low | Low | P3 |
| Operational | No impact - backward compatible, no deployment changes | Low | Low | P3 |

---

## Detailed Findings

### Must Fix (1 item)

#### MF-001: AUTO_YES_TIMEOUT_MS and ALLOWED_DURATIONS Duplication (DRY)

**Current state** in `src/lib/auto-yes-manager.ts` (line 68):
```typescript
const AUTO_YES_TIMEOUT_MS = 3600000;
```

**Proposed state** in `src/config/auto-yes-config.ts`:
```typescript
export const DEFAULT_AUTO_YES_DURATION: AutoYesDuration = 3600000;
```

The design document's code example for `setAutoYesEnabled` (section 6-5) correctly uses `DEFAULT_AUTO_YES_DURATION`, but does not explicitly state that `AUTO_YES_TIMEOUT_MS` should be deleted. Implementation must ensure the old constant is removed.

Additionally, the existing test at `tests/unit/lib/auto-yes-manager.test.ts` line 64 uses `expect(state.expiresAt).toBe(now + 3600000)` -- this should reference `DEFAULT_AUTO_YES_DURATION` for consistency, as the design's test plan (section 9) correctly suggests.

**Recommendation**: Add an explicit "removal list" section to the design document, or add a comment in section 6-5's code noting `// Remove: const AUTO_YES_TIMEOUT_MS = 3600000;`.

### Should Fix (3 items)

#### SF-001: formatTimeRemaining Placement (SRP)

The `formatTimeRemaining` function currently lives in `AutoYesToggle.tsx` as a module-scope helper. The design extends it with hour support but keeps it in the same location. This is acceptable because the function is specific to the AutoYesToggle component. However, if future features (e.g., session timers, polling timeouts) need similar formatting, extraction to `src/lib/utils.ts` would be warranted.

#### SF-002: DURATION_LABELS Synchronization Guarantee (OCP)

The `Record<AutoYesDuration, string>` type ensures compile-time safety when keys diverge from `ALLOWED_DURATIONS`. This is sufficient. The design document should note this compiler enforcement as a design guarantee for future maintainers.

#### SF-003: onConfirm Callback Type Precision (KISS + Type Safety)

The design specifies `onConfirm: (duration: number) => void`, but using `AutoYesDuration` instead of `number` would provide end-to-end type safety through the component tree:

```typescript
// Proposed improvement:
onConfirm: (duration: AutoYesDuration) => void;  // Instead of (duration: number) => void
onToggle: (enabled: boolean, duration?: AutoYesDuration) => Promise<void>;
```

This ensures that only valid duration values can flow from the dialog through the toggle to the API call, without relying solely on server-side validation.

### Consider (3 items)

#### CO-001: Duration Choice Rationale Documentation (YAGNI)

The three choices (1h/3h/8h) are reasonable but the design document does not explain why these specific values were chosen. Adding a brief rationale (e.g., "1h for quick tasks, 3h for medium sessions, 8h for full workday") would help future maintainers understand the design intent.

#### CO-002: Validation Helper Extraction (DIP)

A dedicated `isValidDuration()` function in `auto-yes-config.ts` would improve testability:

```typescript
export function isValidDuration(value: unknown): value is AutoYesDuration {
  return typeof value === 'number' && (ALLOWED_DURATIONS as readonly number[]).includes(value);
}
```

This is optional -- the inline `ALLOWED_DURATIONS.includes()` in route.ts is simple and clear.

#### CO-003: Hardcoded Dialog Text Replacement Verification

The current `AutoYesConfirmDialog.tsx` line 46 contains `1時間後に自動でOFFになります。` which must be replaced with the dynamic version. The test plan should include a specific test case verifying this text changes based on the selected duration.

---

## Consistency with Existing Codebase

| Aspect | Existing Pattern | Proposed Design | Verdict |
|--------|-----------------|-----------------|---------|
| Config file location | `src/config/*.ts` | `src/config/auto-yes-config.ts` | Consistent |
| `as const` usage | `STATUS_COLORS`, `Z_INDEX` | `ALLOWED_DURATIONS` | Consistent |
| Type derivation | `typeof Z_INDEX[keyof typeof Z_INDEX]` | `typeof ALLOWED_DURATIONS[number]` | Consistent |
| Record mapping | `Record<SidebarStatusType, StatusConfig>` | `Record<AutoYesDuration, string>` | Consistent |
| Server function signature | `setAutoYesEnabled(id, enabled)` | `setAutoYesEnabled(id, enabled, duration?)` | Backward compatible |
| API optional fields | `cliToolId?: string` in POST body | `duration?: number` in POST body | Consistent |
| Whitelist validation | `ALLOWED_CLI_TOOLS.includes()` | `ALLOWED_DURATIONS.includes()` | Consistent |

The design follows the established project conventions faithfully.

---

## Implementation Order Assessment

The bottom-up order (config -> manager -> route -> dialog -> toggle -> parent -> tests -> docs) is correct and allows incremental testing at each stage. Each step builds on the previous one with clear dependency ordering.

---

## Approval

**Status**: Conditionally Approved

The design is well-crafted and demonstrates strong design principles adherence. Conditional approval is based on resolution of:

1. **MF-001** (must-fix): Explicitly plan the removal of `AUTO_YES_TIMEOUT_MS` constant to prevent DRY violation

The should-fix and consider items are recommendations for improvement but do not block implementation.

---

*Architecture Review by Claude Opus 4.6 | 2026-02-10 | Stage 1: Standard Review*
