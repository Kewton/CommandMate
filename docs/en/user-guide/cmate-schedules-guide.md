[日本語版](../../user-guide/cmate-schedules-guide.md)

# CMATE Schedules Guide

A guide to setting up and managing scheduled executions using CMATE.md files.

---

## Overview

The CMATE schedule feature allows you to automatically execute `claude -p` (or `codex exec`, `gemini -p`, `vibe-local -p`, `gh copilot -p`, `agy -p`, `opencode run`) commands by defining cron expressions in the Schedules section of a `CMATE.md` file placed in your worktree root.

**How it works:**

```
Define a Schedules table in CMATE.md
  ↓
CommandMate polls CMATE.md every 60 seconds
  ↓
When a cron expression matches, claude -p is executed automatically
  ↓
Results are recorded in Execution Logs
```

---

## Creating CMATE.md

### File Location

Place `CMATE.md` in the root directory of your worktree.

```
your-project/          ← worktree root
├── CMATE.md           ← place it here
├── src/
├── package.json
└── ...
```

### Creating via UI

1. Select a worktree from the sidebar
2. Click the **CMATE** tab
3. Click the **CMATE button** to create a `CMATE.md` with a starter template

---

## Writing the Schedules Table

Create a `## Schedules` section in your `CMATE.md` and define entries using Markdown table format.

### Table Structure

```markdown
## Schedules

| Name | Cron | Message | CLI Tool | Enabled | Permission |
|------|------|---------|----------|---------|------------|
| daily-review | 0 9 * * * | Review code changes and report improvements | claude | true | acceptEdits |
```

### Column Reference

| Column | Required | Description | Default |
|--------|----------|-------------|---------|
| **Name** | Yes | Schedule name. 1-100 characters. Alphanumeric, Japanese, hyphens, and spaces allowed | - |
| **Cron** | Yes | Cron expression (5-6 fields). Defines execution timing | - |
| **Message** | Yes | Prompt sent to `claude -p`. Max 10,000 characters | - |
| **CLI Tool** | No | CLI tool to use (`claude` / `codex` / `gemini` / `vibe-local` / `opencode` / `copilot` / `antigravity`; the authority is `CLI_TOOL_IDS` in `src/lib/cli-tools/types.ts`). **Only copilot and opencode accept `--model <model-name>`** — writing it for another tool is a syntax error and the whole row is skipped | `claude` |
| **Enabled** | No | Enable/disable the schedule (`true` / `false`) | `true` |
| **Permission** | No | Execution permission level. See Permission Reference below | Tool-specific default |

### Cron Expression Quick Reference

| Pattern | Description |
|---------|-------------|
| `0 * * * *` | Every hour at :00 |
| `0 9 * * *` | Daily at 9:00 |
| `0 9 * * 1-5` | Weekdays at 9:00 |
| `0 18 * * 5` | Every Friday at 18:00 |
| `0 2 * * *` | Daily at 2:00 |
| `0 0 1 * *` | 1st of every month at 0:00 |
| `*/30 * * * *` | Every 30 minutes |

Cron expressions support 5 fields (minute hour day month weekday) or 6 fields (second minute hour day month weekday).

---

## Permission Reference

### claude (--permission-mode)

| Value | Description |
|-------|-------------|
| `default` | Default permissions. Prompts for confirmation on file changes |
| `acceptEdits` | Automatically accepts file edits (**default**) |
| `plan` | Plan mode. Does not make code changes |
| `dontAsk` | Automatically approves all permissions |
| `bypassPermissions` | Skips all permission checks |

### codex (--sandbox)

| Value | Description |
|-------|-------------|
| `read-only` | Read-only access. Cannot modify files |
| `workspace-write` | Allows file changes within the workspace (**default**) |
| `danger-full-access` | Full access to all files |

### gemini

No permission settings. The Permission column is ignored (writing a value in it is a validation error).

### copilot (--allow-all-tools / --yolo)

| Value | Description |
|-------|-------------|
| `allow-all-tools` | Allows all tool usage (**default**) |
| `yolo` | Allows all tool usage and bypasses all user confirmations |

> **Warning:** `yolo` is the maximum permission mode that bypasses all user confirmations. When combined with scheduled execution (unattended batch), there is a risk of unrestricted file system writes and arbitrary command execution without human review.

#### Copilot Model Selection

Use `copilot --model <model-name>` in the CLI Tool column to specify a model for scheduled execution.

```markdown
| copilot-task | 0 9 * * * | Analyze code changes | copilot --model claude-opus-4.6 | true | allow-all-tools |
```

Model names may contain alphanumeric characters, hyphens, dots, slashes and colons, and must start with an alphanumeric (a leading `-` is rejected because it is ambiguous with a CLI option). **In the CLI Tool column, `--model` is accepted for copilot and opencode only** — for any other tool it is not "ignored" but a **syntax error that skips the whole schedule row** (`TOOLS_WITH_MODEL_SUPPORT` in `parseCliToolColumn`). The vibe-local model comes from the worktree's Agent settings (the DB) instead, and antigravity's `--model` takes display names containing spaces, which a single CLI Tool cell cannot represent — that one belongs to `commandmate send --model`.

### antigravity (--dangerously-skip-permissions)

| Value | Description |
|-------|-------------|
| `--dangerously-skip-permissions` | Auto-approves tool use (**default**; no other value is accepted) |

> **Warning:** note that this is the only permitted value, and scheduled execution is an unattended batch.

### opencode

No permission settings, so **writing a value in the Permission column is a validation error**
(Issue #1914). Before that, Claude's `--permission-mode` values (`acceptEdits` and friends) were
accepted here and handed to a CLI that has no such option.

> **Note:** "no permission settings" means opencode has no permission *level* vocabulary, not that it
> has no flag at all. `opencode run` carries a boolean `--auto`, described by its own `--help` as
> "auto-approve permissions that are not explicitly denied" (measured on opencode 1.18.21).
> That is a different axis from claude's `--permission-mode` or codex's `--sandbox`, and CommandMate
> does not pass it today.

#### OpenCode Model Selection

Use `opencode --model <provider/model>` in the CLI Tool column and the schedule launches
`opencode run -m <provider/model> <message>`.

```markdown
| oc-task | 0 9 * * * | Analyze code changes | opencode --model ollama/qwen3:8b | true | |
```

The value is in **`provider/model` form** — that is what `opencode run --help` documents for
`-m, --model` ("model to use in the format of provider/model", measured on 1.18.21) — and
CommandMate passes it through **verbatim**. Before Issue #1914 the code prefixed it with `ollama/`,
in a branch that could never run (`resolveModelOption()` always answered `undefined` for opencode);
the prefix made every other provider unreachable and doubled up any value that already named one.
A malformed value fails inside opencode with an opaque error — measured, an unknown provider and a
bare model name produce the identical `UnknownError`, so CommandMate does not try to guess the shape
and reject it here. Check the Execution Log for the result.

> **Note:** opencode is not one of `commandmate report generate --tool`'s values
> (`SUMMARY_ALLOWED_TOOLS` is claude / codex / copilot / antigravity). `--model` became available for
> CMATE.md scheduled execution only.

### vibe-local

No permission settings. The Permission column is ignored. The `-y` flag is used for auto-approval.

> **Note:** The vibe-local model uses the Ollama model selected in the worktree's Agent settings.

---

## Practical Examples

### Daily Code Review

```markdown
| daily-review | 0 9 * * 1-5 | Review yesterday's commits and report any improvements | claude | true | acceptEdits |
```

Automatically runs a code review at 9:00 AM on weekdays.

### Nightly Test Execution

```markdown
| nightly-test | 0 2 * * * | Run npm run test:unit and summarize the results | claude | true | plan |
```

Runs tests every night at 2:00 AM and generates a report. Uses `plan` mode so no code changes are made.

### Hourly Status Check

```markdown
| hourly-status | 0 * * * * | Check git status and report any issues | claude | true | default |
```

Checks repository status at the top of every hour.

---

## Checking Results in the UI

### Schedule List

1. Select a worktree from the sidebar
2. Click the **CMATE** tab
3. Defined schedules are listed in the **Schedules** section

### Viewing Execution Logs

1. Check the **Execution Logs** section in the **CMATE** tab
2. Click on a log entry to expand it and view details:
   - **Message**: The prompt that was sent
   - **Response**: The response from the CLI tool

---

## Validation

CommandMate automatically validates the contents of CMATE.md.

### When Validation Occurs

- When you re-click the CMATE button
- During CommandMate's 60-second polling cycle

### Validation Rules

| Field | Rule |
|-------|------|
| Name | 1-100 characters, alphanumeric/Japanese/hyphens/spaces only |
| Cron | Valid cron expression with 5-6 fields |
| Message | Must not be empty. Max 10,000 characters |
| CLI Tool | Must be `claude`, `codex`, `gemini`, `vibe-local`, `opencode`, `copilot`, or `antigravity` |
| Permission | Must match an allowed value for the selected tool |

Invalid entries are skipped with a warning log. Other valid entries are processed normally.

---

## Troubleshooting

### Schedule Is Not Executing

- **Check Enabled**: Make sure it is not set to `false`
- **Check Cron Expression**: Verify the format is correct (5-6 fields)
- **Check CMATE.md Location**: Ensure it is placed in the worktree root directory
- **Check CommandMate Status**: Make sure the server is running

### Permission Confirmation Messages Appear

- Set the Permission column explicitly
- For claude, ensure the Permission level is appropriate for the operations your prompt requires (e.g., `acceptEdits` or higher for file modifications)

### Behavior When Changing Names

- Changing a schedule name causes it to be recognized as a new schedule
- The schedule with the old name is automatically stopped

### Concurrent Execution

- Concurrent execution of the same schedule is prevented (the next execution is skipped until the current one completes)
- A maximum of 100 schedules can be registered across all worktrees

---

## CLI Access

```bash
commandmate docs --section cmate-schedules
```

Use this command to view this guide from your terminal.

---

## Related Documentation

- [Quick Start Guide](./quick-start.md) - Get started in 5 minutes
- [Commands Guide](./commands-guide.md) - Command details
- [Webapp Guide](./webapp-guide.md) - Webapp UI operations
- [Workflow Examples](./workflow-examples.md) - Practical usage examples
