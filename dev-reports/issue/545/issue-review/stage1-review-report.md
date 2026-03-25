# Issue #545 Stage 1 Review Report: Copilot-CLI Support

## Review Overview

| Item | Value |
|------|-------|
| Issue | #545 Copilot-cliに対応したい |
| Stage | 1 - 通常レビュー（1回目） |
| Focus | Consistency, Correctness, Completeness |
| Date | 2026-03-25 |

## Summary

| Severity | Count |
|----------|-------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 2 |
| **Total** | **10** |

---

## Must Fix Findings

### F1-001: D1-003 Registry Pattern Migration Threshold Triggered

**Category**: Consistency

The codebase contains a documented architecture decision at `src/lib/detection/cli-patterns.ts` line 482:

> Migration threshold: 6th tool addition triggers registry pattern migration [D1-003].

Adding copilot would be the **6th tool** (after claude, codex, gemini, vibe-local, opencode). The issue does not mention this requirement. The current switch-case approach in `detectThinking()`, `getCliToolPatterns()`, and `buildDetectPromptOptions()` was explicitly designed with a migration trigger at tool count 6.

**Recommendation**: Either include the CLIToolConfig registry migration as part of this issue, or document a deliberate decision to defer it with justification.

---

### F1-002: Missing `src/cli/config/cli-tool-ids.ts` from Implementation Tasks

**Category**: Completeness

The CLI module maintains a separate copy of `CLI_TOOL_IDS` at `src/cli/config/cli-tool-ids.ts` (Issue #518: Approach B - subset copy). A cross-validation test at `tests/unit/cli/config/cross-validation.test.ts` verifies that the CLI copy matches the server-side `CLI_TOOL_IDS`. If the server-side `types.ts` is updated but `cli-tool-ids.ts` is not, the cross-validation test will fail.

**Recommendation**: Add `src/cli/config/cli-tool-ids.ts` to the implementation task list.

---

### F1-003: Missing Response Cleaning Dispatch Points from Implementation Tasks

**Category**: Completeness

Response cleaning is dispatched in two files not listed in the issue:

1. **`src/lib/assistant-response-saver.ts`** - `cleanCliResponse()` function uses a switch statement on `cliToolId` (lines 193-207). Without a `'copilot'` case, responses fall through to `default: return output.trim()`.

2. **`src/lib/polling/response-poller.ts`** - Lines 697-709 use an if-else chain for tool-specific response cleaning. Without a copilot branch, responses are not cleaned.

The issue lists `response-cleaner.ts` (where `cleanCopilotResponse()` would be defined), but misses the two files that call the cleaner.

**Recommendation**: Add both files to the implementation task list with explicit tasks to add copilot dispatch cases.

---

## Should Fix Findings

### F1-004: Inconsistent `index.ts` Export Plan

**Category**: Completeness

The issue lists `src/lib/cli-tools/index.ts` as a change target, but the current barrel file only exports `ClaudeTool`, `CodexTool`, and `GeminiTool` -- `VibeLocalTool` and `OpenCodeTool` are NOT exported from the barrel. The newer tools follow a different pattern.

**Recommendation**: Clarify whether `CopilotTool` should be exported from `index.ts`. For consistency with VibeLocalTool/OpenCodeTool, it likely should not be.

---

### F1-005: IImageCapableCLITool Claim Requires Verification

**Category**: Correctness

The issue asserts copilot-cli supports image sending. Currently only `ClaudeTool` implements `IImageCapableCLITool`. The standard GitHub Copilot CLI (`gh copilot`) is a terminal command suggestion tool, and image input capability is not documented in its public documentation.

**Recommendation**: Verify image support before including `IImageCapableCLITool` in the implementation plan. Remove if unsupported.

---

### F1-006: CLI Command Name and Interactive Mode Clarification Needed

**Category**: Correctness

The issue assumes command name `copilot` with an interactive dialogue mode. GitHub Copilot CLI is typically invoked as `gh copilot` (a gh CLI extension), providing `gh copilot suggest` and `gh copilot explain` subcommands. These are not persistent REPL sessions like Claude/Codex/Gemini.

This fundamentally affects:
- `BaseCLITool.command` value (`'copilot'` vs `'gh'`)
- `isInstalled()` check logic
- `startSession()` -- may not be a persistent REPL
- The entire tmux session management approach

**Recommendation**: Clarify the exact invocation command and verify whether persistent interactive sessions are supported. If not REPL-based, the implementation may require a fundamentally different approach from existing tools.

---

### F1-007: MAX_SELECTED_AGENTS Decision Is Vague

**Category**: Completeness

The issue says `MAX_SELECTED_AGENTS=4` "needs review" but provides no decision. With 6 tools, 4-of-6 selection seems reasonable.

**Recommendation**: State explicitly whether `MAX_SELECTED_AGENTS` stays at 4 or changes.

---

### F1-008: status-detector.ts Complexity Underestimated

**Category**: Completeness

`status-detector.ts` has ~100 lines of tool-specific logic for OpenCode (TUI layout detection, footer boundary finding) and ~60 lines for Codex (status bar detection, content area extraction). If copilot-cli has a non-standard TUI layout, similar complexity will be required. The issue describes this as simply "add copilot case."

**Recommendation**: Add a prerequisite task to analyze copilot-cli terminal output and determine required detection complexity. Include sample terminal output captures.

---

## Nice to Have Findings

### F1-009: Missing CLAUDE.md Update Task

**Category**: Completeness

`CLAUDE.md` contains comprehensive module references and CLI tool lists that must be updated when adding a new tool.

---

### F1-010: slash-commands.ts Consideration Lacks Detail

**Category**: Completeness

Listed as a "related component" without explaining what changes (if any) are needed.

---

## Key Architectural Concern

The most significant finding is F1-006. The GitHub Copilot CLI (`gh copilot`) operates fundamentally differently from the other tools in CommandMate's CLI tool abstraction layer:

- **Claude/Codex/Gemini/OpenCode**: Launch a persistent REPL session in tmux, send messages via `sendKeys`, detect prompts/status via `capturePane` pattern matching.
- **GitHub Copilot CLI**: Provides `gh copilot suggest` and `gh copilot explain` as one-shot commands, not a persistent interactive session.

If this architectural mismatch is confirmed, the implementation approach described in the issue (extending BaseCLITool with standard session management) may not work without significant adaptation. This should be investigated and resolved before implementation begins.
