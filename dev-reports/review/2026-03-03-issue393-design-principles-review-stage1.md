# Architecture Review: Issue #393 - Stage 1 Design Principles Review

| Item | Detail |
|------|--------|
| **Issue** | #393 - security: authenticated RCE and shell injection via /api/worktrees/[id]/terminal |
| **Stage** | 1 - Design Principles Review |
| **Focus** | SOLID / KISS / YAGNI / DRY / Defense in Depth |
| **Status** | Conditionally Approved |
| **Score** | 4/5 |
| **Date** | 2026-03-03 |

---

## Executive Summary

Issue #393 addresses a Critical/High severity security vulnerability -- shell injection via `exec()` in tmux.ts and unsafe parameter handling in `terminal/route.ts` and `capture/route.ts`. The design policy proposes a layered fix: (1) endpoint-level input validation, (2) tmux.ts `exec()` to `execFile()` full migration, (3) consolidation of direct `exec()` calls in codex.ts/claude-session.ts, and (4) comprehensive tests.

The design demonstrates strong adherence to SOLID, KISS, YAGNI, and DRY principles. The approach of reusing existing safe patterns (CLIToolManager, isCliToolType, validateSessionName) rather than inventing new abstractions is commendable. One must-fix finding relates to runtime validation gaps in `sendSpecialKey()`, and four should-fix items address DRY improvements and defense-in-depth consistency.

---

## Design Principles Evaluation

### SRP (Single Responsibility Principle) - PASS

Each module maintains a clear single responsibility:

| Module | Responsibility | SRP Assessment |
|--------|---------------|----------------|
| `tmux.ts` | tmux command execution (10 functions) | Single responsibility: tmux interaction. exec->execFile is an internal change. |
| `terminal/route.ts` | HTTP endpoint for terminal commands | Will delegate to CLIToolManager (D1-003) |
| `capture/route.ts` | HTTP endpoint for pane capture | Will delegate to CLIToolManager (D1-003) |
| `validation.ts` | Session name format validation | Focused validation module |
| `base.ts` | Common CLI tool behavior | Template method pattern for CLI tools |
| `types.ts` | Type definitions + type guards | Pure type module with runtime guards |

The design correctly avoids mixing validation concerns into tmux.ts itself. Validation remains in the endpoint layer (L1) and the CLI tool layer (L3), while tmux.ts focuses solely on command execution (L2).

**Finding R1F003**: tmux.ts has 10 public functions, but they all serve the single purpose of tmux session management. Future module splitting is not needed now (YAGNI).

### OCP (Open/Closed Principle) - PASS

**Finding R1F006**: The design explicitly preserves public interfaces:

> "Public interfaces (function signatures, exception types) are not changed -- only internal implementation migrates from exec to execFile" (D2-001)

This is verified by examining the current code:

- `hasSession(sessionName: string): Promise<boolean>` -- signature unchanged
- `sendKeys(sessionName: string, keys: string, sendEnter?: boolean): Promise<void>` -- signature unchanged
- `capturePane(sessionName: string, linesOrOptions?: number | CapturePaneOptions): Promise<string>` -- signature unchanged

All downstream consumers (cli-session.ts, gemini.ts, vibe-local.ts, opencode.ts) require zero changes. The existing test infrastructure (tmux.test.ts) only needs mock updates, not structural changes.

### DIP (Dependency Inversion Principle) - PASS with Improvements

**Finding R1F011**: The current `terminal/route.ts` directly imports and uses `tmux` module functions:

```typescript
// Current (terminal/route.ts:7) - direct low-level dependency
import * as tmux from '@/lib/tmux';
// ...
await tmux.createSession(sessionName, process.cwd());
await tmux.sendKeys(sessionName, command);
```

The design policy D1-003 correctly addresses this by mandating CLIToolManager-based access:

```typescript
// Proposed - depends on ICLITool abstraction via CLIToolManager
const manager = CLIToolManager.getInstance();
const cliTool = manager.getTool(cliToolId);
const sessionName = cliTool.getSessionName(worktreeId);
```

This aligns with the existing safe pattern in `kill-session/route.ts` (lines 49-65) and `respond/route.ts` (lines 138-142), where all tmux operations are mediated through CLIToolManager.

### KISS (Keep It Simple, Stupid) - PASS

**Finding R1F008**: The 4-layer defense architecture (isCliToolType -> getWorktreeById -> validateSessionName -> execFile) is not over-engineered:

1. Each layer serves a distinct purpose (type guard, DB existence, format validation, execution safety)
2. The pattern already exists in `kill-session/route.ts` and `respond/route.ts`
3. No new abstractions or frameworks are introduced

The decision to use `execFile()` rather than `spawn()` or a custom command builder is the simplest correct solution. `execFile()` is a drop-in replacement for `exec()` that removes shell interpretation.

The design avoids unnecessary complexity such as:
- Custom command serialization/deserialization
- Abstract command builder patterns
- External sandboxing libraries

### YAGNI (You Aren't Gonna Need It) - PASS

**Finding R1F009**: The design correctly limits scope by explicitly marking non-scope items:

| Non-Scope Item | Rationale | YAGNI Assessment |
|---------------|-----------|-----------------|
| CSRF protection | Separate attack vector, separate Issue | Correct |
| claude-session.ts fixed-string exec() (L237, L250, L417, L465) | Low risk (fixed command strings only) | Correct |
| base.ts `which` command | Constants-only input, low risk | Correct |
| spawn() migration | execFile() is sufficient | Correct |

The design does not introduce speculative abstractions. The `exec() -> execFile()` migration is the minimum necessary change to eliminate shell injection, and no additional command execution framework is proposed.

### DRY (Don't Repeat Yourself) - PASS with Improvements

**Finding R1F001** (should_fix): The most significant DRY violation identified:

```typescript
// terminal/route.ts:11 - Local duplicate
function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}

// capture/route.ts:11 - Local duplicate
function getSessionName(worktreeId: string, cliToolId: CLIToolType): string {
  return `mcbd-${cliToolId}-${worktreeId}`;
}

// base.ts:47 - Canonical implementation with validation
getSessionName(worktreeId: string): string {
  const sessionName = `mcbd-${this.id}-${worktreeId}`;
  validateSessionName(sessionName);
  return sessionName;
}
```

Three implementations of the same logic, but only `base.ts` includes validation. The design policy D1-003 correctly mandates consolidation to CLIToolManager.

**Finding R1F005** (should_fix): Two separate key validation mechanisms exist:

- `ALLOWED_SPECIAL_KEYS` (Set): `Up, Down, Left, Right, Enter, Space, Tab, Escape, BSpace, DC`
- `SpecialKey` (type): `Escape, C-c, C-d, C-m, Enter`

These overlap on `Escape` and `Enter` but are otherwise distinct sets with different validation mechanisms (runtime Set check vs. compile-time type check).

**Finding R1F002** (nice_to_have): `getErrorMessage()` helper is duplicated between codex.ts and claude-session.ts, but consolidation is out of scope per YAGNI.

### Defense in Depth - PASS

The 4-layer security architecture is well-structured:

```
Layer 1: isCliToolType()           -- Whitelist validation (CLI_TOOL_IDS)
Layer 2: getWorktreeById()         -- DB existence verification
Layer 3: validateSessionName()     -- Regex format validation
Layer 4: execFile()                -- Shell-free command execution (root defense)
```

Each layer independently prevents exploitation even if other layers are bypassed. The design correctly identifies that Layer 4 (execFile) is the root defense while Layers 1-3 provide additional protection.

---

## Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical | Low | exec->execFile is a well-understood migration; interface preservation ensures backward compatibility | Comprehensive test coverage (D4) |
| Security | Medium | sendSpecialKey() lacks runtime validation pre-migration; lines parameter unvalidated | R1F004: Add runtime validation; R1F010: Add lines validation |
| Operational | Low | No breaking changes to public APIs; existing consumers unaffected | D2-004: ensureSession() auto-covered |

---

## Detailed Findings

### Must Fix (1 item)

#### R1F004: sendSpecialKey() Runtime Validation Gap

**Principle**: Security / Defense in Depth

**Current State** (`src/lib/tmux.ts:435-448`):

```typescript
export async function sendSpecialKey(
  sessionName: string,
  key: SpecialKey  // TypeScript type constraint only
): Promise<void> {
  try {
    await execAsync(
      `tmux send-keys -t "${sessionName}" ${key}`,  // Direct shell expansion
      { timeout: DEFAULT_TIMEOUT }
    );
```

`SpecialKey` is a TypeScript union type (`'Escape' | 'C-c' | 'C-d' | 'C-m' | 'Enter'`), which provides compile-time safety only. At runtime, any string could be passed (e.g., via `as SpecialKey` cast or untyped API boundaries). While the execFile() migration in D2 will eliminate shell interpretation, adding a runtime whitelist check (mirroring sendSpecialKeys()'s ALLOWED_SPECIAL_KEYS pattern) ensures defense-in-depth.

**Recommendation**: Add a `SPECIAL_KEY_SET` constant and runtime check in `sendSpecialKey()`:

```typescript
const SPECIAL_KEY_SET = new Set<string>(['Escape', 'C-c', 'C-d', 'C-m', 'Enter']);

export async function sendSpecialKey(sessionName: string, key: SpecialKey): Promise<void> {
  if (!SPECIAL_KEY_SET.has(key)) {
    throw new Error(`Invalid special key: ${key}`);
  }
  await execFileAsync('tmux', ['send-keys', '-t', sessionName, key], { timeout: DEFAULT_TIMEOUT });
}
```

### Should Fix (4 items)

#### R1F001: getSessionName() DRY Violation

Three separate implementations of the same session name format exist across terminal/route.ts, capture/route.ts, and base.ts. Only base.ts includes validation. Design policy D1-003 addresses this, but test coverage should verify no regression.

#### R1F005: ALLOWED_SPECIAL_KEYS and SpecialKey Type Disjunction

Two overlapping but distinct key validation mechanisms create confusion. Consider a unified runtime validation approach for all key-sending functions after execFile() migration.

#### R1F010: lines Parameter Validation in capture/route.ts

The `lines` parameter currently has no type checking or range validation. The JSON body could contain non-numeric values or extreme numbers. D1-005 specifies validation but implementation must include both `Number.isInteger()` and range bounds.

#### R1F011: terminal/route.ts Direct tmux Dependency

Current direct `import * as tmux` violates DIP. D1-003/D1-004 migration to CLIToolManager resolves this and aligns with existing safe patterns.

### Nice to Have (7 items)

- **R1F002**: getErrorMessage() duplication between codex.ts and claude-session.ts
- **R1F003**: tmux.ts module future-splitting consideration
- **R1F006**: OCP compliance of interface-preserving design (positive finding)
- **R1F007**: base.ts isInstalled() exec() usage tracking for future Issue
- **R1F008**: CLIToolManager call chain complexity is appropriate (positive finding)
- **R1F009**: Non-scope items correctly limited per YAGNI (positive finding)
- **R1F012**: Test mock migration pattern clearly documented (positive finding)

---

## Design Principles Compliance Summary

| Principle | Status | Notes |
|-----------|--------|-------|
| SRP | PASS | Each module has clear single responsibility |
| OCP | PASS | Public interfaces preserved; internal implementation changes only |
| LSP | N/A | No inheritance hierarchy changes |
| ISP | N/A | No interface changes |
| DIP | PASS (with improvement) | D1-003 migration improves DIP compliance |
| KISS | PASS | Reuses existing patterns; no over-engineering |
| YAGNI | PASS | Non-scope explicitly limited; no speculative features |
| DRY | PASS (with improvement) | D1-003 eliminates local getSessionName(); minor duplications remain |
| Defense in Depth | PASS | 4-layer security architecture with independent defense at each layer |

---

## Implementation Phase Assessment

The proposed 5-phase implementation order is well-structured:

```
Phase 1: tmux.ts exec->execFile (foundation)
Phase 2: codex.ts / claude-session.ts consolidation (dependent)
Phase 3: terminal/route.ts validation (endpoint)
Phase 4: capture/route.ts validation (endpoint)
Phase 5: Tests
```

Phase 1 as the foundation is correct because all subsequent phases depend on the safe execution layer. Phase ordering minimizes risk by establishing the root defense first.

**Suggestion**: Consider running Phase 5 (tests) in parallel with each phase rather than as a final phase, following TDD principles. This ensures each migration step is immediately verified.

---

## Approval Status

**Conditionally Approved** - The design policy is well-structured and demonstrates strong adherence to SOLID/KISS/YAGNI/DRY principles. Approval is conditional on addressing:

1. **R1F004** (must_fix): Add runtime validation to `sendSpecialKey()` for defense-in-depth
2. **R1F001, R1F005, R1F010, R1F011** (should_fix): DRY improvements and parameter validation as designed

All conditions are already partially addressed in the design policy itself (D1-003, D1-005, D2), so this is primarily a confirmation that implementation follows through on the documented design.

---

*Architecture Review conducted by architecture-review-agent for Issue #393, Stage 1*
