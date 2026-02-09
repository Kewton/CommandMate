# Architecture Review Report: Issue #201 - Stage 3 Impact Analysis

**Issue**: #201 - Trust Dialog Auto-Response
**Focus**: Impact Scope (影響範囲)
**Stage**: 3 (Impact Analysis Review)
**Date**: 2026-02-09
**Reviewer**: Architecture Review Agent

---

## Executive Summary

Issue #201 proposes adding automatic Enter key response to the Claude CLI "Quick safety check" trust dialog during session initialization. The impact analysis confirms that this change has a **minimal and well-contained blast radius**. Only 2 source files are modified (`cli-patterns.ts` and `claude-session.ts`), with 2 additional test files receiving new test cases. No indirect consumers require changes. No API contracts, database schemas, UI components, or configuration values are affected.

**Verdict**: Approved. The change is additive, backward-compatible, and well-scoped.

---

## Impact Analysis

### Directly Changed Files

| File | Change Type | Lines Changed (est.) | Risk |
|------|-------------|---------------------|------|
| `src/lib/cli-patterns.ts` | Addition | ~3 lines | Low |
| `src/lib/claude-session.ts` | Modification | ~15 lines | Low |
| `tests/unit/lib/claude-session.test.ts` | Addition | ~50 lines | Low |
| `src/lib/__tests__/cli-patterns.test.ts` | Addition | ~20 lines | Low |
| `CLAUDE.md` | Documentation | ~15 lines | Low |

#### 1. `src/lib/cli-patterns.ts` - Pattern Constant Addition

**Change**: Add `CLAUDE_TRUST_DIALOG_PATTERN = /Yes, I trust this folder/m` as a new `export const`.

**Impact Assessment**:
- This is a purely additive change. No existing exports are modified.
- Seven files currently import from `cli-patterns.ts`:
  - `src/lib/status-detector.ts` (imports: stripAnsi, detectThinking, getCliToolPatterns, buildDetectPromptOptions)
  - `src/lib/response-poller.ts` (imports: getCliToolPatterns, stripAnsi, buildDetectPromptOptions)
  - `src/lib/auto-yes-manager.ts` (imports: stripAnsi, detectThinking, buildDetectPromptOptions)
  - `src/lib/claude-session.ts` (imports: CLAUDE_PROMPT_PATTERN, stripAnsi)
  - `src/lib/assistant-response-saver.ts` (imports: stripAnsi)
  - `src/app/api/worktrees/[id]/prompt-response/route.ts` (imports: stripAnsi, buildDetectPromptOptions)
  - `src/app/api/worktrees/[id]/current-output/route.ts` (imports: stripAnsi, buildDetectPromptOptions)
- None of these consumers are affected because their existing imports remain unchanged.
- Only `claude-session.ts` will add `CLAUDE_TRUST_DIALOG_PATTERN` to its import statement.

#### 2. `src/lib/claude-session.ts` - Polling Loop Modification

**Change**: Add dialog detection + Enter send logic inside the `startClaudeSession()` polling loop (lines 332-354 area).

**Impact Assessment**:
- Modification is scoped entirely within the `startClaudeSession()` function.
- The new condition branch is placed **after** the existing `CLAUDE_PROMPT_PATTERN` check (L344), preserving the optimal fast-path for normal initialization.
- The `trustDialogHandled` boolean flag is function-scoped (no module-level state added).
- No function signatures change: `startClaudeSession(options: ClaudeSessionOptions): Promise<void>` remains unchanged.
- Five other exported functions in this module are completely untouched:
  - `sendMessageToClaude()` (L379-412) -- unmodified
  - `waitForPrompt()` (L257-276) -- unmodified
  - `captureClaudeOutput()` (L427-444) -- unmodified
  - `stopClaudeSession()` (L457-484) -- unmodified
  - `restartClaudeSession()` (L499-512) -- unmodified, correctly delegates to modified `startClaudeSession()`
- JSDoc update to `CLAUDE_INIT_TIMEOUT` constant (L39-49) adds documentation only.

#### 3. Test File Changes

- `tests/unit/lib/claude-session.test.ts`: 3 new test cases added in a new `describe` block. Follows existing patterns (`vi.useFakeTimers()`, mocked `capturePane`). Existing 15+ test cases remain untouched.
- `src/lib/__tests__/cli-patterns.test.ts`: 3-4 new test cases for pattern matching. Added to the existing file (currently 182 lines). Existing test suites for `CLAUDE_PROMPT_PATTERN`, `CLAUDE_THINKING_PATTERN`, `detectThinking`, `getCliToolPatterns` remain untouched.

### Indirectly Affected Files (No Changes Required)

| File | Relationship | Risk | Rationale |
|------|-------------|------|-----------|
| `src/lib/cli-tools/claude.ts` | Calls `startClaudeSession()` | None | Function signature unchanged. Dialog handling is internal. |
| `src/app/api/worktrees/[id]/send/route.ts` | Calls `cliTool.startSession()` (L100) | None | Error handling (L117-123) correctly propagates any errors from modified `startClaudeSession()`. |
| `src/lib/status-detector.ts` | Imports from `cli-patterns.ts` | None | Imports different symbols. Status detection operates post-initialization. |
| `src/lib/auto-yes-manager.ts` | Imports from `cli-patterns.ts` | None | Auto-yes polling runs post-initialization. Trust dialog never appears in this phase. |
| `src/lib/response-poller.ts` | Imports from `cli-patterns.ts` | None | Response polling starts after message send. No exposure to initialization dialog. |
| `src/lib/assistant-response-saver.ts` | Imports `stripAnsi` from `cli-patterns.ts` | None | Completely unrelated to session initialization. |
| `src/lib/claude-poller.ts` | Imports from `claude-session.ts` | None | Imports `captureClaudeOutput` and `isClaudeRunning`, both unmodified. |
| `src/lib/tmux.ts` | Provides `sendKeys()` consumed by change | None | Existing API consumed as-is. `sendKeys(sessionName, '', true)` for Enter is an established usage pattern (used at L324 and L410 already). |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | Imports from `cli-patterns.ts` | None | Different imports, post-initialization usage. |
| `src/app/api/worktrees/[id]/current-output/route.ts` | Imports from `cli-patterns.ts` | None | Different imports, post-initialization usage. |

### Areas Verified to Have Zero Impact

| Area | Verification |
|------|-------------|
| Database schema | No DB changes. Trust dialog handling is runtime logic only. |
| API contracts | No endpoint signatures, request/response formats, or status codes change. |
| UI components | No UI modifications. Auto-response is transparent to the frontend. |
| Configuration / Environment variables | No new env vars. `CLAUDE_INIT_TIMEOUT` (15s) unchanged. |
| Build / CI pipeline | Standard TypeScript additions. No build config changes needed. |
| Codex / Gemini CLI tools | Trust dialog is Claude-CLI-specific. Other tools have separate session management paths that do not call `startClaudeSession()`. |

---

## Call Chain Analysis

```
User Action: Select worktree + send first message
    |
    v
POST /api/worktrees/:id/send  (send/route.ts L100)
    |
    v
ClaudeTool.startSession()      (cli-tools/claude.ts L56)
    |
    v
startClaudeSession()           (claude-session.ts L292) [MODIFIED]
    |
    +---> capturePane()         (tmux.ts - unchanged)
    +---> stripAnsi()           (cli-patterns.ts - unchanged)
    +---> CLAUDE_PROMPT_PATTERN.test()  (cli-patterns.ts - unchanged)
    +---> CLAUDE_TRUST_DIALOG_PATTERN.test()  [NEW - cli-patterns.ts]
    +---> sendKeys('', true)    (tmux.ts - unchanged, existing pattern)
    |
    v
Session initialized (or timeout error)
    |
    v
cliTool.sendMessage()          (send/route.ts L141 - unchanged path)
```

The modification point (`startClaudeSession()`) is 3 layers deep from the API endpoint. The change is fully encapsulated -- callers at every layer see no difference in function signatures, return types, or error types.

---

## Regression Risk Analysis

| Scenario | Risk | Rationale |
|----------|------|-----------|
| Normal initialization (no dialog) | None | `CLAUDE_TRUST_DIALOG_PATTERN.test()` returns false. `trustDialogHandled` stays false but is never used. Existing fast-path is preserved. |
| Initialization timeout (no prompt detected) | None | Additional regex test per poll cycle has negligible overhead. Timeout path (L357-358) is unchanged. |
| `sendMessageToClaude()` | None | Completely unmodified (L379-412). Trust dialog only appears during initialization. |
| `waitForPrompt()` | None | Completely unmodified (L257-276). Uses `CLAUDE_PROMPT_PATTERN` only, appropriate for post-initialization. |
| `restartClaudeSession()` | None | Delegates to `stopClaudeSession()` then `startClaudeSession()`. Modified `startClaudeSession()` correctly handles dialog on restart if workspace trust resets. |
| Existing session already running | None | `hasSession()` check at L306-310 returns early before reaching the polling loop. |

---

## Test Coverage Requirements

### New Tests Required (per design doc)

| Test File | Test Cases | Purpose |
|-----------|------------|---------|
| `tests/unit/lib/claude-session.test.ts` | Dialog detection triggers Enter send | Verify `sendKeys('', true)` is called once when dialog pattern matches |
| `tests/unit/lib/claude-session.test.ts` | Double-send prevention | Verify `sendKeys` is called only once even when dialog text persists in buffer |
| `tests/unit/lib/claude-session.test.ts` | No-dialog regression | Verify existing flow is unchanged when dialog is absent |
| `src/lib/__tests__/cli-patterns.test.ts` | Full dialog text match | Verify pattern matches complete "Yes, I trust this folder" text |
| `src/lib/__tests__/cli-patterns.test.ts` | Partial match in tmux buffer | Verify pattern matches when surrounded by other tmux output |
| `src/lib/__tests__/cli-patterns.test.ts` | Non-match cases | Verify "No, exit", normal CLI output, and similar strings do not match |

### Existing Tests Not Requiring Modification

| Test File | Reason |
|-----------|--------|
| `tests/unit/lib/cli-patterns.test.ts` | Tests Codex patterns. CLAUDE_TRUST_DIALOG_PATTERN tests belong in `src/lib/__tests__/` per design doc. |
| `tests/unit/lib/status-detector.test.ts` | Status detection is unaffected. |
| `tests/unit/lib/auto-yes-manager.test.ts` | Auto-yes polling is unaffected. |
| `tests/unit/prompt-detector.test.ts` | Prompt detection is unaffected. |
| `tests/integration/api-send-cli-tool.test.ts` | Send API integration is unaffected (see C-001 for optional enhancement). |
| `tests/integration/api-prompt-handling.test.ts` | Prompt handling is unaffected. |
| `tests/integration/current-output-thinking.test.ts` | Current output/thinking detection is unaffected. |
| `tests/unit/api/prompt-response-verification.test.ts` | Prompt response verification is unaffected. |

---

## Risk Assessment

| Risk Type | Level | Details |
|-----------|-------|---------|
| Technical Risk | Low | Change is additive, scoped to 1 function body + 1 new constant. Existing test suite validates no regression. Pattern matching is deterministic. |
| Security Risk | Low | Enter key sent only once per initialization, guarded by flag. Pattern matches fixed English string only. Log output uses fixed messages (no user input). No new attack surface. |
| Operational Risk | Low | No configuration changes. No deployment steps. Backward compatible: dialog-absent sessions work identically. |
| Performance Risk | Negligible | One additional regex test per poll cycle (~300ms interval, ~50 cycles max). RegExp is a simple literal string match -- effectively O(1). |

---

## Improvement Recommendations

### Must Fix

None.

### Should Fix

None.

### Consider

| ID | Title | Details |
|----|-------|---------|
| C-001 | Integration test for send/route.ts call chain | Consider adding an integration test to `tests/integration/api-send-cli-tool.test.ts` that mocks `capturePane` to return trust dialog text, validating the full API route -> ClaudeTool -> startClaudeSession() chain. Not blocking because unit tests adequately cover the core logic. |
| C-002 | claude-poller.ts module dependency note | `claude-poller.ts` (legacy) imports `captureClaudeOutput` and `isClaudeRunning` from `claude-session.ts`. No impact from this change, but worth noting for future refactoring awareness. |

---

## Approval Status

**Status**: APPROVED

**Score**: 5/5

**Rationale**: The proposed change has an exceptionally well-defined and minimal impact scope. Only 2 production source files are modified (1 additive constant, 1 scoped function body change). No function signatures, API contracts, database schemas, UI components, or configuration values change. All 10 indirectly related files verified to require zero modifications. The test plan covers all critical paths (dialog detection, double-send prevention, regression). The design's placement of the new condition **after** the existing `CLAUDE_PROMPT_PATTERN` check ensures the normal fast-path is preserved.

---

## Review History

| Date | Stage | Focus | Score | Status |
|------|-------|-------|-------|--------|
| 2026-02-09 | Stage 1 | Design Principles | 5 | Approved |
| 2026-02-09 | Stage 2 | Consistency | 5 | Approved |
| 2026-02-09 | Stage 3 | Impact Analysis | 5 | Approved |

---

*Generated by Architecture Review Agent for Issue #201 Stage 3*
