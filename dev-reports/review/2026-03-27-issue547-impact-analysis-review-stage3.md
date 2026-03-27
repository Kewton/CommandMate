# Architecture Review: Issue #547 - Stage 3 Impact Analysis

- **Issue**: #547 Copilot CLI Default Slash Commands and Selection Window Support
- **Stage**: 3 (Impact Analysis / Impact Scope)
- **Status**: Conditionally Approved
- **Score**: 4/5
- **Date**: 2026-03-27

---

## Executive Summary

The design policy for Issue #547 has been reviewed for ripple effects across the codebase. The changes are well-scoped with minimal blast radius. The primary risk area is the `current-output/route.ts` migration from OR-chain to `SELECTION_LIST_REASONS` Set, which must be executed atomically. Frontend components require no changes due to the existing `isSelectionListActive` flag propagation. The CLI commands (`wait`, `capture`) handle new status reasons gracefully through their string-typed `sessionStatusReason` field.

---

## Impact Analysis: Directly Changed Files

| File | Change | Risk | Notes |
|------|--------|------|-------|
| `src/lib/slash-commands.ts` | Add `getCopilotBuiltinCommands()`, integrate into both branches of `getSlashCommandGroups()` | Low | Both basePath and cache branches must include builtin commands (DR2-001). Cache mechanism (`commandsCache`, `skillsCache`) is unaffected since builtins are computed fresh each call. |
| `src/lib/detection/cli-patterns.ts` | Add `COPILOT_SELECTION_LIST_PATTERN`, update placeholder patterns | Low | New pattern is consumed only by status-detector.ts (guarded by `cliToolId === 'copilot'`). Existing patterns unchanged. |
| `src/lib/detection/status-detector.ts` | Add `COPILOT_SELECTION_LIST` to STATUS_REASON, add Step 1.6 detection, add `SELECTION_LIST_REASONS` Set | Low | New detection branch is guarded. Set constant centralizes reason checking. |
| `src/app/api/worktrees/[id]/current-output/route.ts` | Replace OR-chain with `SELECTION_LIST_REASONS.has()` | Medium | Must be atomic with Set constant introduction. See IA3-001. |
| `src/lib/response-cleaner.ts` | Potentially update `COPILOT_SKIP_PATTERNS` | Low | Only affects `cleanCopilotResponse()`. |

## Impact Analysis: Indirectly Affected Files

| File | Dependency | Risk | Notes |
|------|-----------|------|-------|
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | Calls `getSlashCommandGroups(worktree.path)` | Low | Automatically picks up Copilot builtins. Source count (`sources.standard`, etc.) will not count builtins since `source` field is not set on them (IA3-003). |
| `src/app/api/slash-commands/route.ts` | Calls `getSlashCommandGroups()` (no basePath) | Low | Cache branch automatically includes builtins after fix. |
| `src/lib/command-merger.ts` | `filterCommandsByCliTool()` called by slash-commands routes | None | Existing `cmd.cliTools.includes(cliToolId)` logic handles `cliTools: ['copilot']` correctly. No changes needed (DR2-007 confirmed). |
| `src/lib/polling/response-poller.ts` | Uses copilot patterns for completion detection and response cleaning | Low | Completion detection (L369-373) groups copilot with codex/gemini/vibe-local (hasPrompt && !isThinking). Pattern updates will affect accuracy but logic is correct. |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Consumes `isSelectionListActive` from current-output API | None | No code changes needed. NavigationButtons display is driven by the boolean flag. |
| `src/cli/types/api-responses.ts` | `sessionStatusReason` is string-typed | None | New reason value `copilot_selection_list` is compatible. |
| `src/cli/commands/wait.ts` | Reads `sessionStatus` and `sessionStatusReason` | Low | Needs verification that `status=waiting` with selection_list reason is handled appropriately (IA3-002). |
| `src/lib/session/worktree-status-helper.ts` | Calls `detectSessionStatus()` | None | No copilot-specific logic; passes through results unchanged. |

---

## Findings

### Must Fix (1 item)

#### IA3-001: current-output/route.ts OR-to-Set migration must be atomic

**Current code** (L108-110):
```typescript
const isSelectionListActive = statusResult.status === 'waiting'
  && (statusResult.reason === STATUS_REASON.OPENCODE_SELECTION_LIST
    || statusResult.reason === STATUS_REASON.CLAUDE_SELECTION_LIST);
```

The design policy (DR1-004) mandates introducing `SELECTION_LIST_REASONS` Set in `status-detector.ts` and using `Set.has()` in `current-output/route.ts`. These two changes must happen in the same commit. If the Set is defined but the route file retains the old OR chain, the new `COPILOT_SELECTION_LIST` reason will not activate `isSelectionListActive`.

**Action**: Add explicit implementation step: "Replace OR chain in current-output/route.ts L108-110 with `SELECTION_LIST_REASONS.has(statusResult.reason)` in the same commit as the Set constant definition."

---

### Should Fix (3 items)

#### IA3-002: CLI wait command behavior with selection_list waiting status

The `wait` command polls `sessionStatus` to determine when an agent has completed. A new `waiting` status with reason `copilot_selection_list` could cause the wait command to behave differently (e.g., treating it as a prompt event with `--on-prompt`). The `sessionStatusReason` is string-typed so there is no type error, but behavioral correctness should be verified.

**Action**: Review `wait.ts` logic for `status === 'waiting'` handling and add a test case for selection-list waiting.

#### IA3-003: Builtin commands missing `source` field affects API source counts

The `getCopilotBuiltinCommands()` function in the design does not set a `source` field on the returned `SlashCommand` objects. The worktree slash-commands API (L120-128) counts commands by source type. Builtins will fall through all source checks and not be counted, making the `sources` response field inaccurate.

**Action**: Set `source: 'builtin'` (or similar) on `getCopilotBuiltinCommands()` return values. Optionally add a `builtin` count to the sources response.

#### IA3-004: Negative test cases for cliToolId guard condition

The test design in Section 5 lists positive tests for Copilot selection list detection but does not explicitly mention negative tests verifying the `cliToolId === 'copilot'` guard. Without negative tests, a future refactor could accidentally remove the guard, causing false detection for other CLI tools.

**Action**: Add test case: `detectSessionStatus(copilotLikeOutput, 'claude')` should NOT return `copilot_selection_list` reason.

---

### Nice to Have (3 items)

#### IA3-005: response-poller completion detection test coverage

When COPILOT_PROMPT_PATTERN is updated from placeholder to real pattern, the response-poller completion detection for copilot should be re-validated.

#### IA3-006: COPILOT_THINKING_PATTERN broad match scope

The placeholder pattern matches generic words like "Thinking", "Generating", "Processing". While guarded by `cliToolId` in `detectThinking()`, the pattern should be tightened after TUI investigation.

#### IA3-007: Frontend requires no changes (confirmed)

`WorktreeDetailRefactored.tsx` reads `isSelectionListActive` from the API response and conditionally renders `NavigationButtons`. No frontend changes are needed for this issue. The design policy's assertion of "presentation layer: no changes" is accurate.

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | Changes are additive (new pattern, new constant, new Set). Existing tool behavior is protected by cliToolId guards. |
| Security | Low | No new external inputs. Patterns are hardcoded. No ReDoS risk in proposed patterns. |
| Operational | Low | No configuration changes, no migration needed. Backward compatible. |

---

## Implementation Checklist (Impact-Derived)

- [ ] **[IA3-001]** Atomically replace OR-chain in current-output/route.ts with SELECTION_LIST_REASONS.has() when introducing the Set constant
- [ ] **[IA3-002]** Verify CLI wait command handles selection_list waiting status correctly
- [ ] **[IA3-003]** Add `source` field to getCopilotBuiltinCommands() return values
- [ ] **[IA3-004]** Add negative test: non-copilot cliToolId must not trigger copilot_selection_list
- [ ] **[IA3-005]** Validate response-poller completion tests after pattern update
- [ ] Confirm /api/slash-commands (MCBD) returns Copilot builtins via cache branch
- [ ] Confirm /api/worktrees/[id]/slash-commands returns Copilot builtins via basePath branch
- [ ] Run full test suite to check for regressions in existing OpenCode/Claude selection list tests

---

*Generated by architecture-review-agent for Issue #547*
*Stage 3: Impact Analysis Review*
*Date: 2026-03-27*
