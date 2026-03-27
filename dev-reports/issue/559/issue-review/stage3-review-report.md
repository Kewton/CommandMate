# Issue #559 Impact Scope Review (Stage 3)

## Review Summary

Issue #559 addresses a bug where Copilot CLI slash commands (e.g., `/model`) are processed as plain text when sent via Terminal API while Copilot is not at a prompt state. The Issue's impact analysis is largely accurate, correctly identifying that the problem is limited to the Terminal API path (`/api/worktrees/:id/terminal`) and does not affect the send API path (`/api/worktrees/:id/send -> CopilotTool.sendMessage()`).

However, the review identified **8 findings** (2 must_fix, 4 should_fix, 2 nice_to_have) related to impact scope gaps, edge cases, and cross-module interactions.

---

## Findings

### MUST FIX

#### F3-001: special-keys/route.ts is missing from impact analysis

**Files**: `src/app/api/worktrees/[id]/special-keys/route.ts`

The special-keys API follows the same pattern as terminal/route.ts -- it sends keys to tmux sessions without checking Copilot state. While special keys (Up/Down/Enter/Escape) are not slash commands, the Issue's impact scope table should explicitly address whether this route is affected. The "Impact: None (confirmed)" section lists CLI paths and other CLI tools but does not mention special-keys/route.ts.

**Recommendation**: Add special-keys/route.ts to the "Impact: None" section with explicit rationale (special keys are not text input, so slash command misprocessing does not apply).

---

#### F3-008: Scope of slash commands requiring prompt wait is undefined

**Files**: `src/lib/cli-tools/copilot.ts`, `src/lib/slash-commands.ts`

The Issue uses `/model` as the example, but `getCopilotBuiltinCommands()` defines approximately 40 built-in Copilot slash commands. ALL of them require prompt wait when sent via Terminal API, not just SELECTION_LIST_COMMANDS (`model`, `agent`, `theme`). Commands like `/help`, `/version`, `/clear`, `/compact` would all be misprocessed as text if Copilot is responding.

The Issue's modification approach section implicitly assumes all slash commands need prompt wait, but this is never explicitly stated.

**Recommendation**: Explicitly state in the Issue that "all Copilot slash commands (messages starting with `/`) require prompt wait before sending." SELECTION_LIST_COMMANDS is a subset that requires additional post-send wait (for selection list UI to appear).

---

### SHOULD FIX

#### F3-002: Slash command detection method for terminal/route.ts is undefined

If Approach A or C is chosen, terminal/route.ts needs to detect whether a command is a Copilot slash command. However:
- `CopilotTool.extractSlashCommand()` is a private method
- Simple `/` prefix detection would trigger for all `/` messages, not just Copilot slash commands
- The `cliToolId` parameter is available in terminal/route.ts, so tool-specific branching is possible

**Recommendation**: Prefer Approach C (delegate to `CopilotTool.sendMessage()`) to reuse existing detection logic, or add a public `isSlashCommand()` method to CopilotTool.

---

#### F3-003: waitForPrompt timeout behavior change affects sendMessage path

The Issue lists "waitForPrompt timeout behavior review" as a modification target for `copilot.ts`. The current `waitForPrompt()` (line 182-198) does NOT throw on timeout -- it logs and continues. If this is changed to throw, the existing `sendMessage()` flow (used by `/api/worktrees/:id/send`) will also be affected.

This contradicts the acceptance criterion: "Existing sendMessage path (`/api/worktrees/:id/send`) is not affected."

**Recommendation**: Either (1) keep `waitForPrompt()` behavior unchanged and implement separate timeout handling in terminal/route.ts, or (2) update the acceptance criterion to acknowledge that `sendMessage()` behavior may intentionally change.

---

#### F3-004: Existing test files requiring updates are not listed

Two test files need updates:
1. `tests/unit/terminal-route.test.ts` -- The `isCliToolType` mock (line 12) does not include `'copilot'` in the allowed values. Any Copilot-specific logic in terminal/route.ts would fail in tests.
2. `tests/unit/cli-tools/copilot.test.ts` -- If `waitForPrompt` behavior changes, existing tests need updating.

**Recommendation**: Add these files to the impact scope table.

---

#### F3-006: Edge case -- leading whitespace in slash commands

`CopilotTool.extractSlashCommand()` calls `message.trim()` before checking for `/` prefix. However, `terminal/route.ts` does not trim the `command` parameter. If the implementation adds slash command detection in terminal/route.ts, it must apply trim consistently.

**Recommendation**: Document this edge case in the Issue implementation notes.

---

### NICE TO HAVE

#### F3-005: Other CLI tools have the same theoretical problem

The terminal/route.ts bypass pattern (sending directly via `sendKeys` without prompt wait) applies to all CLI tools, not just Copilot. For Claude CLI, `session-key-sender.ts` has `waitForPrompt()`, but this is only used by the send API path. In practice, Claude slash commands are typically sent via the send API, so this is low risk.

**Recommendation**: Create a follow-up Issue for a generic prompt-wait mechanism in terminal/route.ts.

---

#### F3-007: Response latency impact on Terminal API

Adding prompt wait (up to 15 seconds) to terminal/route.ts changes it from a near-instant API to a potentially blocking one. Frontend HTTP timeout settings and loading UI should be verified.

**Recommendation**: Verify frontend timeout configuration and consider returning wait metadata in the API response.

---

## Cross-Module Interaction Summary

| Module | Current Behavior | Impact from Issue #559 |
|--------|-----------------|----------------------|
| `terminal/route.ts` | Sends command directly via `sendKeys` | Will add Copilot slash command detection + prompt wait |
| `copilot.ts` (sendMessage) | Already has `waitForPrompt()` | Potential timeout behavior change |
| `copilot.ts` (extractSlashCommand) | Private method | May need to be exposed or duplicated |
| `status-detector.ts` | Detects Copilot thinking/prompt/selection states | No change needed (read-only consumer) |
| `session-key-sender.ts` | Claude-specific prompt wait | No change needed (not used by Copilot) |
| `special-keys/route.ts` | Sends special keys without state check | Should be analyzed but likely no change needed |
| `cli-patterns.ts` | Defines COPILOT_PROMPT_PATTERN | May need updates if detection criteria change |
| `terminal-route.test.ts` | Tests terminal/route.ts | Mock update needed (add 'copilot' to isCliToolType) |
| `copilot.test.ts` | Tests CopilotTool | Update needed if waitForPrompt behavior changes |

---

## Conclusion

The Issue's impact analysis is well-structured and correctly identifies the root cause as limited to the Terminal API path. The three approach options (A/B/C) are reasonable. The main gaps are: (1) the scope of "which slash commands need prompt wait" should explicitly cover ALL slash commands, not just selection-list-triggering ones; (2) the interaction between waitForPrompt timeout changes and the existing sendMessage path needs to be resolved before implementation; and (3) test file impacts should be enumerated.
