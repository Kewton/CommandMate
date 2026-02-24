[日本語版](../../user-guide/cmate-schedules-guide.md)

# CMATE Schedules Guide

A guide to setting up and managing scheduled executions using CMATE.md files.

---

## Overview

The CMATE schedule feature allows you to automatically execute `claude -p` (or `codex exec`) commands by defining cron expressions in the Schedules section of a `CMATE.md` file placed in your worktree root.

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
| **CLI Tool** | No | CLI tool to use (`claude` / `codex`) | `claude` |
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
| CLI Tool | Must be `claude` or `codex` |
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
