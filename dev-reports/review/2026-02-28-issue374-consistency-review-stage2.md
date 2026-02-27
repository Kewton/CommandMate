# Architecture Review Report: Issue #374 - Stage 2 (Consistency Review)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #374 - Vibe Local Context Window Size Configuration |
| Stage | 2 - Consistency Review |
| Focus | Design Document vs Codebase Consistency |
| Status | Conditionally Approved |
| Score | 4/5 |
| Reviewed At | 2026-02-28 |

The design policy document demonstrates strong alignment with the existing codebase patterns. The `vibeLocalModel` implementation introduced in Issue #368 is used as the reference pattern throughout, and the design correctly identifies all 6 SELECT statement modification points, the DB migration version scheme, the API validation structure, and the UI props propagation chain. Two must-fix items relate to test reference accuracy and API validation completeness. Overall, the design is well-prepared for implementation.

---

## Review Scope

### Reviewed Files

| File | Purpose |
|------|---------|
| `src/lib/db.ts` | DB CRUD operations - updateVibeLocalModel pattern, SELECT statements |
| `src/lib/db-migrations.ts` | Migration registry - version 19 pattern, CURRENT_SCHEMA_VERSION |
| `src/app/api/worktrees/[id]/route.ts` | API route - vibeLocalModel PATCH validation pattern |
| `src/components/worktree/AgentSettingsPane.tsx` | UI component - props interface, Ollama model selector |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | State management - useState/useCallback for vibeLocalModel |
| `src/components/worktree/NotesAndLogsPane.tsx` | Props passthrough - vibeLocalModel propagation |
| `src/types/models.ts` | Type definitions - Worktree interface |
| `src/lib/cli-tools/types.ts` | CLI tool types - OLLAMA_MODEL_PATTERN, CLIToolType |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local tool - startSession() DB access pattern |
| `locales/ja/schedule.json` | Japanese i18n keys |
| `locales/en/schedule.json` | English i18n keys |
| `tests/unit/lib/db-migrations.test.ts` | Migration tests - version assertions |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | Component test - props factory |
| `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` | Component test - props factory |

---

## Consistency Check Summary

| Category | Status | Details |
|----------|--------|---------|
| DB Pattern | Consistent | `updateVibeLocalContextWindow()` follows `updateVibeLocalModel()` signature exactly. SELECT modification points accurately identified. |
| API Pattern | Consistent | PATCH validation follows `vibeLocalModel` in-body check pattern. Shared validation function is a clean improvement. |
| UI Pattern | Consistent | Props chain (WorktreeDetailRefactored -> NotesAndLogsPane -> AgentSettingsPane) mirrors vibeLocalModel exactly. |
| Test Pattern | Consistent | Test modification points identified correctly, though line references need verification. |

---

## Detailed Findings

### Must Fix (2 items)

#### C2-001: Test Line Number References Need Verification

**Severity**: must-fix
**Category**: Test Consistency

The design document (Section 8) states: "CURRENT_SCHEMA_VERSION expected value 19->20 (L37, L430, L443)". Upon examination of the actual test file:

- **L37**: `expect(CURRENT_SCHEMA_VERSION).toBe(19)` - This is the direct version constant test. Correct to change to 20.
- **L430**: `expect(getCurrentVersion(db)).toBe(19)` - This is inside the rollbackMigrations test that verifies the version *before* rollback starts. With version 20, this should become 20.
- **L443**: `expect(getCurrentVersion(db)).toBe(19)` - Same context as L430.

The "19->20" change direction is correct, but the design should explicitly state what each line reference does, because rollbackMigrations tests will also need their `rollbackMigrations(db, 16)` calls updated to account for the new migration.

**Evidence**:
```typescript
// tests/unit/lib/db-migrations.test.ts L36-38
it('should be 18 after Migration #18', () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(19);  // L37 - change to 20
});

// L429-430
rollbackMigrations(db, 16);
expect(getCurrentVersion(db)).toBe(19);  // L430 - needs update context
```

**Suggestion**: Update the design document to specify each change with its purpose. Also note that the test description string `'should be 18 after Migration #18'` is already stale (should say 19/Migration #19) and will need updating to 20/Migration #20.

---

#### C2-002: API Validation Missing Guard for Non-null Non-number Types

**Severity**: must-fix
**Category**: DB Function Signature Consistency

The design document's API validation code (Section 4) handles two cases:
1. `ctxWindow === null` -> pass through to `updateVibeLocalContextWindow()`
2. `ctxWindow !== null` -> validate with `isValidVibeLocalContextWindow()`

However, if `ctxWindow` is a value that is neither null nor a number (e.g., `"abc"`, `true`, `undefined`), the flow reaches `isValidVibeLocalContextWindow()` which correctly returns `false` because it checks `typeof value === 'number'`. So the behavior is correct, but the pattern differs from the existing `vibeLocalModel` validation which uses explicit type checks:

```typescript
// Existing vibeLocalModel pattern (route.ts L237)
if (typeof model !== 'string' || model.length === 0 || model.length > 100) {
  return NextResponse.json(
    { error: 'vibeLocalModel must be null or a string (1-100 characters)' },
    { status: 400 }
  );
}
```

The design's approach of delegating to `isValidVibeLocalContextWindow()` is functionally correct but creates a subtle pattern inconsistency with the existing code.

**Suggestion**: Either add an explicit type guard before calling `isValidVibeLocalContextWindow()` to match the existing pattern, or document in the design that the shared validation function deliberately replaces the inline type check pattern used by vibeLocalModel.

---

### Should Fix (4 items)

#### C2-003: SELECT Statement Modification Points Are Accurate

**Severity**: should-fix
**Category**: SELECT Statement Consistency

The design correctly identifies all 6 modification points across `getWorktrees()` and `getWorktreeById()`. The current SELECT statements end with `w.vibe_local_model` at:
- `getWorktrees()`: Line 199
- `getWorktreeById()`: Line 312

The type cast arrays end with `vibe_local_model: string | null` at:
- `getWorktrees()`: Line 232
- `getWorktreeById()`: Line 336

The mapping objects end with `vibeLocalModel: row.vibe_local_model ?? null` at:
- `getWorktrees()`: Line 262
- `getWorktreeById()`: Line 362

All positions are consistent with adding `vibe_local_context_window` immediately after `vibe_local_model`.

**Suggestion**: During implementation, place `w.vibe_local_context_window` directly after `w.vibe_local_model` in all three locations (SELECT, type cast, mapping) within both functions.

---

#### C2-004: i18n Default Label Inconsistency

**Severity**: should-fix
**Category**: i18n Pattern Consistency

The design specifies:
- `vibeLocalContextWindowDefault` -> ja: "Default (auto)" / en: "Default (auto)"

The existing pattern uses:
- `vibeLocalModelDefault` -> ja: "Default" / en: "Default"

The parenthetical "(auto)" suffix creates a minor inconsistency. Both fields represent "use the tool's built-in default", so the labels should be uniform.

**Evidence**:
```json
// locales/ja/schedule.json
"vibeLocalModelDefault": "Default"
// Design proposes:
"vibeLocalContextWindowDefault": "Default (auto)"
```

**Suggestion**: Either use "Default" for both (matching existing pattern) or update `vibeLocalModelDefault` to "Default (auto)" as well to maintain consistency.

---

#### C2-005: Worktree Interface Optional vs Nullable Pattern

**Severity**: should-fix
**Category**: Type Definition Consistency

The design defines `vibeLocalContextWindow?: number | null` following the existing `vibeLocalModel?: string | null` pattern. Both are optional (`?`) AND nullable (`| null`), which creates a triple-state: `undefined` (field absent), `null` (explicitly no value), or a concrete value.

In practice, DB mapping always provides a value (`row.field ?? null`), so the field is never `undefined` on DB-sourced objects. The `?` is only needed because some code paths construct partial Worktree objects.

**Evidence**:
```typescript
// models.ts L81
vibeLocalModel?: string | null;

// db.ts L262 (always set, never undefined)
vibeLocalModel: row.vibe_local_model ?? null,
```

**Suggestion**: Maintain the existing pattern for Issue #374 scope. Consider a future refactoring to separate DB-sourced Worktree (with required fields) from partial Worktree (with optional fields).

---

#### C2-006: API Validation Pattern Divergence from vibeLocalModel

**Severity**: should-fix
**Category**: API Validation Consistency

The existing `vibeLocalModel` validation uses inline checks (typeof, length, regex), while the design proposes using a shared `isValidVibeLocalContextWindow()` function for `vibeLocalContextWindow`. This is a design improvement (DRY), but creates a pattern difference within the same PATCH handler.

**Evidence**:
```typescript
// Existing inline pattern (route.ts L237-248)
if (typeof model !== 'string' || model.length === 0 || model.length > 100) { ... }
if (!OLLAMA_MODEL_PATTERN.test(model)) { ... }

// Proposed shared function pattern (design Section 4)
if (!isValidVibeLocalContextWindow(ctxWindow)) { ... }
```

**Suggestion**: The shared function approach is superior. Document this as an intentional pattern evolution. Consider noting that `vibeLocalModel` validation could be refactored to a shared function in a future issue for full consistency.

---

### Nice to Have (3 items)

#### C2-007: Migration version 20 down() Function Not Specified

**Severity**: nice-to-have
**Category**: Migration Pattern Consistency

The design mentions "down() function: rollbackMigrations test compatibility" in the test design (Section 8) but does not provide the down() function implementation for version 20. Version 19's down() uses a minimal `console.log()` pattern since SQLite cannot drop columns easily.

**Evidence**:
```typescript
// db-migrations.ts L944-947 (version 19 pattern)
down: () => {
  console.log('No rollback for vibe_local_model column (SQLite limitation)');
}
```

**Suggestion**: Add the explicit down() function to the design document following the version 19 pattern:
```typescript
down: () => {
  console.log('No rollback for vibe_local_context_window column (SQLite limitation)');
}
```

---

#### C2-008: startSession() Context Window Retrieval Code Not Detailed

**Severity**: nice-to-have
**Category**: vibe-local.ts Consistency

The design shows the defense-in-depth validation code for the CLI layer but does not show the complete context window retrieval code within startSession(). The existing vibeLocalModel retrieval pattern (vibe-local.ts L89-97) reads from DB inside a try-catch block. The contextWindow retrieval should occur in the same block.

**Evidence**:
```typescript
// vibe-local.ts L89-97 (existing pattern)
try {
  const db = getDbInstance();
  const wt = getWorktreeById(db, worktreeId);
  if (wt?.vibeLocalModel && OLLAMA_MODEL_PATTERN.test(wt.vibeLocalModel)) {
    vibeLocalCommand = `vibe-local -y -m ${wt.vibeLocalModel}`;
  }
} catch {
  // DB read failure is non-fatal; use default model
}
```

**Suggestion**: Add concrete implementation code to the design showing contextWindow retrieval alongside vibeLocalModel in the same try-catch block.

---

#### C2-009: Multiple NotesAndLogsPane Call Sites Need Props Update

**Severity**: nice-to-have
**Category**: UI Consistency

WorktreeDetailRefactored.tsx calls NotesAndLogsPane in multiple locations:
1. Mobile layout (L900-907) - uses props from parent component
2. Desktop layout (L1941-1948) - uses local handlers
3. Additional mobile integration (L2195-2204 area)

The design should explicitly note that all call sites need the new `vibeLocalContextWindow` and `onVibeLocalContextWindowChange` props.

**Suggestion**: Add a note to Section 10 listing all NotesAndLogsPane call sites that require the new props.

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Low | All patterns are well-established in the codebase. The vibeLocalModel implementation serves as a proven template. |
| Security | Low | Defense-in-depth validation with shared function ensures command injection prevention. Number-only values limit attack surface. |
| Operational | Low | Migration is a simple ALTER TABLE ADD COLUMN. Nullable default ensures backward compatibility. |

---

## Improvement Recommendations

### Required Before Implementation

1. **[C2-001]** Verify and correct test line number references in design document Section 8
2. **[C2-002]** Clarify API validation approach for non-null non-number values - either add explicit type guard or document the shared function as an intentional pattern evolution

### Recommended Improvements

3. **[C2-004]** Harmonize i18n default labels between vibeLocalModelDefault and vibeLocalContextWindowDefault
4. **[C2-006]** Document the pattern evolution from inline validation to shared function validation

### Future Considerations

5. **[C2-005]** Separate DB-sourced Worktree type from partial Worktree type
6. **[C2-007]** Add explicit down() function code to design document
7. **[C2-008]** Add complete startSession() retrieval code to design document

---

## Approval Status

**Conditionally Approved** - The design is well-aligned with existing codebase patterns. Address the 2 must-fix items (test reference accuracy and API validation completeness) before proceeding to implementation. The 4 should-fix items are recommended but not blocking.

---

*Generated by architecture-review-agent for Issue #374 Stage 2*
*Review date: 2026-02-28*
