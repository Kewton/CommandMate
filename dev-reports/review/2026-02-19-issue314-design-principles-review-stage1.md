# Architecture Review: Issue #314 - Stage 1 Design Principles Review

## Executive Summary

| Item | Detail |
|------|--------|
| **Issue** | #314: Auto-Yes Stop condition feature (regex-based) |
| **Stage** | 1 - Design Principles Review |
| **Date** | 2026-02-19 |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |

Issue #314 proposes adding a regex-based stop condition to the Auto-Yes feature. The design is well-structured overall, with clear layered architecture, defense-in-depth validation, and thoughtful trade-off documentation. However, there are areas where SOLID and DRY principles could be better applied, primarily around state mutation patterns and function responsibility distribution.

---

## Review Scope

- **Focus Area**: Design Principles (SOLID, KISS, YAGNI, DRY, API Design, Component Design)
- **Design Document**: `dev-reports/design/issue-314-auto-yes-stop-condition-design-policy.md`
- **Key Source Files Reviewed**:
  - `src/lib/auto-yes-manager.ts` (565 lines)
  - `src/config/auto-yes-config.ts` (59 lines)
  - `src/lib/auto-yes-resolver.ts` (39 lines)
  - `src/components/worktree/AutoYesConfirmDialog.tsx` (129 lines)
  - `src/components/worktree/AutoYesToggle.tsx` (152 lines)
  - `src/components/worktree/WorktreeDetailRefactored.tsx` (2150 lines)
  - `src/app/api/worktrees/[id]/auto-yes/route.ts` (159 lines)
  - `src/app/api/worktrees/[id]/current-output/route.ts` (143 lines)
  - `src/hooks/useAutoYes.ts` (109 lines)

---

## SOLID Principles Evaluation

### Single Responsibility Principle (SRP)

| Aspect | Evaluation |
|--------|-----------|
| AutoYesState interface extension | PASS - Optional fields added without breaking existing consumers |
| auto-yes-config.ts constant extraction | PASS - MAX_STOP_PATTERN_LENGTH properly isolated |
| pollAutoYes() responsibility accumulation | CONCERN - See DS1-F001 |
| WorktreeDetailRefactored toast handling | CONCERN - See DS1-F004 |

**DS1-F001 [should_fix]**: `pollAutoYes()` already manages 7 distinct responsibilities (output capture, ANSI stripping, thinking detection, prompt detection, duplicate prevention, answer sending, error handling). Adding the Stop condition check as inline code (15+ lines including RegExp creation, test, state update, poller stop, and logging) increases this to 8 responsibilities. The design document specifies the insertion point between thinking detection and prompt detection (Section 6), but the matching logic should be extracted into a dedicated function such as `checkStopCondition(worktreeId, cleanOutput): boolean`.

### Open/Closed Principle (OCP)

| Aspect | Evaluation |
|--------|-----------|
| AutoYesState optional field addition | PASS - Existing code unaffected |
| setAutoYesEnabled() parameter addition | CONCERN - See DS1-F003 |
| AutoYesToggle.onToggle signature | CONCERN - See DS1-F006 |

**DS1-F003 [must_fix]**: The `setAutoYesEnabled()` disable path uses a conditional spread operator to preserve `stopReason` and `stopPattern` from the existing state. More critically, `pollAutoYes()` performs a two-step state mutation:

```typescript
// Step 1: Direct Map manipulation to set stopReason
autoYesStates.set(worktreeId, { ...autoYesState, stopReason: 'stop_pattern_matched' });
// Step 2: Call setAutoYesEnabled(worktreeId, false)
setAutoYesEnabled(worktreeId, false);
```

Step 2 internally reads `autoYesStates.get(worktreeId)` and spreads the result, which happens to preserve the `stopReason` set in Step 1. This ordering dependency is fragile:
- If `setAutoYesEnabled` is refactored to create a fresh state object, `stopReason` will be lost.
- If another call inserts between Steps 1 and 2, the state could be corrupted.

**Recommendation**: Introduce a `disableAutoYes(worktreeId, reason?: StopReason)` function that atomically handles the disable transition, or add a `stopReason` parameter to `setAutoYesEnabled()`.

**DS1-F006 [should_fix]**: The `AutoYesToggle.onToggle` callback grows from 2 to 3 optional parameters. Using an options object pattern would be more extensible:

```typescript
// Current (after change):
onToggle: (enabled: boolean, duration?: AutoYesDuration, stopPattern?: string) => Promise<void>;

// Recommended:
onToggle: (params: { enabled: boolean; duration?: AutoYesDuration; stopPattern?: string }) => Promise<void>;
```

### Liskov Substitution Principle (LSP)

Not applicable - no inheritance hierarchy in the affected modules.

### Interface Segregation Principle (ISP)

| Aspect | Evaluation |
|--------|-----------|
| AutoYesState interface | PASS - Optional fields maintain backward compatibility |
| AutoYesRequestBody | PASS - stopPattern is optional |
| CurrentOutputResponse.autoYes | PASS - stopReason is optional |

### Dependency Inversion Principle (DIP)

**DS1-F009 [should_fix]**: `pollAutoYes()` directly manipulates the internal `autoYesStates` Map in its Stop condition handling, bypassing the public API functions (`setAutoYesEnabled`, `getAutoYesState`). While this is within the same module, it creates a secondary mutation pathway that is inconsistent with the rest of the module's design pattern where all state changes flow through designated functions.

---

## KISS Principle Evaluation

| Aspect | Evaluation |
|--------|-----------|
| Full-text regex matching approach | PASS - Simple and appropriate for 5000-char output |
| try-catch for RegExp validation | PASS - Standard approach, no over-engineering |
| useRef-based toast dedup | ACCEPTABLE - See DS1-F004 |
| Two-step state mutation in pollAutoYes | CONCERN - See DS1-F003 |

**DS1-F004 [nice_to_have]**: The `prevAutoYesEnabledRef` pattern for toast deduplication adds minor complexity to the already large `WorktreeDetailRefactored`. Extracting to a custom hook like `useAutoYesStopNotification` would improve readability without changing behavior.

Overall, the design adheres well to KISS. The choice of full-text regex matching over differential matching, and try-catch over external validation libraries, are sound simplicity decisions documented with clear rationale.

---

## YAGNI Principle Evaluation

| Aspect | Evaluation |
|--------|-----------|
| Deferred safe-regex2 adoption | PASS - Appropriate for initial scope |
| Deferred differential matching | PASS - Full-text matching sufficient |
| No default pattern presets | PASS - Avoids scope creep |
| stopReason: 'expired' addition | CONCERN - See DS1-F005 |

**DS1-F005 [nice_to_have]**: The `stopReason: 'expired'` type is added to the union but no client-side feature consumes it in this Issue. The design document does not describe an "expired" toast notification. This is acceptable for symmetry and low implementation cost, but should be explicitly documented as a forward-looking addition.

---

## DRY Principle Evaluation

| Aspect | Evaluation |
|--------|-----------|
| MAX_STOP_PATTERN_LENGTH centralization | PASS - Properly placed in auto-yes-config.ts |
| Regex validation logic duplication | CONCERN - See DS1-F002 |

**DS1-F002 [should_fix]**: The regex validation logic (length check + `new RegExp()` syntax check) is implemented independently in the client (AutoYesConfirmDialog useEffect) and server (auto-yes/route.ts). While Defense in Depth mandates validation at both layers, the validation *rules* should be defined once. A shared function in `auto-yes-config.ts`:

```typescript
export function validateStopPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_STOP_PATTERN_LENGTH) {
    return { valid: false, error: 'Pattern too long' };
  }
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid regex syntax' };
  }
}
```

This can be imported by both client and server, ensuring validation consistency.

---

## API Design Evaluation

| Aspect | Evaluation |
|--------|-----------|
| POST /auto-yes extension | PASS - Backward compatible, optional field |
| GET /current-output extension | PASS - Optional field addition |
| stopReason semantics | CONCERN - See DS1-F007 |
| Error responses (400/404) | PASS - Proper HTTP status codes |
| Empty string normalization | PASS - trim() || undefined pattern |

**DS1-F007 [nice_to_have]**: The `stopReason` field in the current-output response is returned regardless of `enabled` state. This requires the client to interpret the combination of `enabled=false` + `stopReason='stop_pattern_matched'` as "auto-stop occurred." While functionally correct, adding a JSDoc comment or API documentation explaining this interpretation would improve developer experience.

---

## Component Design Evaluation

| Aspect | Evaluation |
|--------|-----------|
| AutoYesConfirmDialog extension | PASS - Clean state addition |
| Inline regex validation UX | PASS - Good user experience |
| Dialog state reset | CONCERN - See DS1-F008 |
| Button disable on invalid regex | PASS - Prevents invalid submission |

**DS1-F008 [nice_to_have]**: The design should specify that `stopPattern` and `regexError` states are reset when the dialog opens. The current `AutoYesConfirmDialog` is rendered as a child of `AutoYesToggle` and is always mounted (controlled by `showConfirmDialog`). Without explicit reset on open, a previously entered invalid pattern may persist across dialog open/close cycles.

Recommended addition:
```typescript
useEffect(() => {
  if (isOpen) {
    setStopPattern('');
    setRegexError(null);
  }
}, [isOpen]);
```

---

## Risk Assessment

| Risk Type | Level | Detail | Mitigation |
|-----------|-------|--------|------------|
| Technical | Medium | Two-step state mutation ordering dependency (DS1-F003) | Introduce atomic disable function |
| Security | Low | ReDoS mitigation via 500-char limit is adequate for 5000-char targets | Monitor for edge cases post-launch |
| Operational | Low | No DB migration, no breaking API changes | Backward-compatible deployment |

---

## Improvement Recommendations

### Must Fix (1 item)

| ID | Title | Priority |
|----|-------|----------|
| DS1-F003 | setAutoYesEnabled() disable path: two-step mutation is order-dependent and fragile | P1 |

### Should Fix (4 items)

| ID | Title | Priority |
|----|-------|----------|
| DS1-F001 | Extract Stop condition check from pollAutoYes() into dedicated function | P2 |
| DS1-F002 | Centralize regex validation logic in auto-yes-config.ts | P2 |
| DS1-F006 | Refactor AutoYesToggle.onToggle to use options object pattern | P2 |
| DS1-F009 | Eliminate direct Map manipulation in pollAutoYes() | P2 |

### Nice to Have (4 items)

| ID | Title | Priority |
|----|-------|----------|
| DS1-F004 | Extract toast dedup logic to custom hook | P3 |
| DS1-F005 | Document stopReason: 'expired' as forward-looking addition | P3 |
| DS1-F007 | Add API documentation for stopReason interpretation | P3 |
| DS1-F008 | Add dialog state reset on open | P3 |

---

## Design Principles Compliance Summary

| Principle | Status | Notes |
|-----------|--------|-------|
| SRP | Conditional | pollAutoYes() responsibility accumulation needs extraction |
| OCP | Conditional | Must address fragile state mutation pattern |
| LSP | N/A | No inheritance |
| ISP | Pass | Optional field additions maintain compatibility |
| DIP | Conditional | Direct Map access bypasses public API |
| KISS | Pass | Appropriate simplicity choices documented |
| YAGNI | Pass | Minimal scope with clear deferral decisions |
| DRY | Conditional | Validation logic duplication needs centralization |
| API Design | Pass | RESTful, backward compatible |
| Component Design | Pass | Clean React patterns with minor improvements needed |

---

## Approval Status

**Conditionally Approved** - The design is sound in its overall approach and trade-off analysis. One must-fix item (DS1-F003: fragile two-step state mutation) should be addressed in the design before proceeding to implementation. The four should-fix items are recommended improvements that can be addressed during implementation.

---

*Generated by architecture-review-agent for Issue #314, Stage 1*
