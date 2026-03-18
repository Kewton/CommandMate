# CLI Operations Guide

Guide for operating agent sessions from the CommandMate CLI.
These commands enable coding agents (Claude Code, Codex, etc.) to orchestrate other agents in parallel.

---

## Prerequisites

- CommandMate server must be running (`commandmate start --daemon`)
- Target worktrees must be registered (visible in the browser UI sidebar)

### Server Port

CLI connects to `localhost:3000` by default. Use `CM_PORT` for a different port:

```bash
CM_PORT=3011 commandmate ls
```

### Authentication

If the server was started with `--auth`, set the `CM_AUTH_TOKEN` environment variable:

```bash
CM_AUTH_TOKEN=your-token commandmate ls
```

### Running from Development Environment

No global install required:

```bash
npm run build:cli
node bin/commandmate.js ls
```

---

## Command Reference

| Command | Purpose |
|---------|---------|
| [`commandmate ls`](#commandmate-ls) | List worktrees with status |
| [`commandmate send`](#commandmate-send) | Send a message to an agent |
| [`commandmate wait`](#commandmate-wait) | Wait for agent completion |
| [`commandmate respond`](#commandmate-respond) | Respond to a prompt |
| [`commandmate capture`](#commandmate-capture) | Get terminal output |
| [`commandmate auto-yes`](#commandmate-auto-yes) | Control auto-yes |

---

## commandmate ls

List worktrees with their status.

```bash
commandmate ls                          # Table format
commandmate ls --json                   # JSON (for agents)
commandmate ls --quiet                  # IDs only (one per line)
commandmate ls --branch feature/        # Filter by branch prefix
```

### Output Example

```
ID                                               NAME                  STATUS   DEFAULT
-----------------------------------------------  --------------------  -------  ------
localllm-test-main                               main                  ready    claude
mycodebranchdesk-develop                         develop               running  claude
mycodebranchdesk-feature-518-worktree            feature/518-worktree  ready    claude
mycodebranchdesk-main                            main                  idle     claude
```

### STATUS Column

| Status | Meaning |
|--------|---------|
| `idle` | Session not started |
| `ready` | Session running, waiting for input (task completed) |
| `running` | Agent executing a task |
| `waiting` | Confirmation prompt active (Yes/No, etc.) |

---

## commandmate send

Send a message to a worktree's agent (async). Starts the session automatically if not running.

```bash
commandmate send <worktree-id> "<message>"
commandmate send <worktree-id> "<message>" --agent codex
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--agent <id>` | Agent type (claude, codex, gemini, vibe-local, opencode) | claude |
| `--auto-yes` | Enable auto-yes before sending | - |
| `--duration <d>` | Auto-yes duration (1h, 3h, 8h) | 1h |
| `--stop-pattern <p>` | Auto-yes stop condition (regex) | - |

### Finding Worktree IDs

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "Implement this"
```

---

## commandmate wait

Block until the agent completes or a prompt is detected.

```bash
commandmate wait <worktree-id> --timeout 300
commandmate wait <id1> <id2> --timeout 600          # Multiple worktrees
commandmate wait <worktree-id> --on-prompt human     # Human responds via UI
commandmate wait <worktree-id> --stall-timeout 120
```

### Exit Codes

| Code | Meaning | Next Action |
|:----:|---------|-------------|
| 0 | Completed (agent idle) | `capture` to get results |
| 10 | Prompt detected (`--on-prompt agent`) | `respond`, then `wait` again |
| 124 | Timeout | `capture` to check status |

### --on-prompt Modes

| Mode | Behavior |
|------|----------|
| `agent` (default) | Returns immediately with exit 10 + prompt JSON on stdout |
| `human` | Keeps blocking until human responds via browser UI |

### Progress Output

Progress is written to stderr. Only the final result (JSON) goes to stdout.

---

## commandmate respond

Respond to an agent's prompt.

```bash
commandmate respond <worktree-id> "yes"          # Yes/No
commandmate respond <worktree-id> "2"            # Multiple choice (number)
commandmate respond <worktree-id> "text"         # Free text
commandmate respond <worktree-id> "yes" --agent claude
```

### Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | Response sent successfully |
| 99 | Prompt already dismissed (`prompt_no_longer_active`) |

---

## commandmate capture

Get the current terminal output from a worktree.

```bash
commandmate capture <worktree-id>                # Plain text
commandmate capture <worktree-id> --json          # JSON with status info
commandmate capture <worktree-id> --agent codex
```

### JSON Output Fields

```json
{
  "isRunning": true,
  "sessionStatus": "ready",
  "cliToolId": "claude",
  "lineCount": 42,
  "isPromptWaiting": false,
  "autoYes": { "enabled": false, "expiresAt": null }
}
```

---

## commandmate auto-yes

Control auto-yes (automatic prompt response) individually.

```bash
commandmate auto-yes <worktree-id> --enable --duration 3h
commandmate auto-yes <worktree-id> --enable --stop-pattern "error"
commandmate auto-yes <worktree-id> --disable
```

---

## Typical Workflows

### Basic: send, wait, capture

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "Implement Issue #101 with TDD"
commandmate wait "$WT" --timeout 600
commandmate capture "$WT"
```

### With Auto-Yes

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "Implement Issue #101" --auto-yes --duration 3h
commandmate wait "$WT" --timeout 1800
commandmate auto-yes "$WT" --disable
commandmate capture "$WT" --json
```

### Prompt Response Loop

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "Refactor this module"

while true; do
  commandmate wait "$WT" --timeout 600 --on-prompt agent
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "Done"
    break
  elif [ $EXIT_CODE -eq 10 ]; then
    # Prompt detected — auto-respond
    commandmate respond "$WT" "yes"
  elif [ $EXIT_CODE -eq 124 ]; then
    echo "Timeout"
    break
  fi
done

commandmate capture "$WT"
```

### Parallel Worktrees

```bash
WT1=$(commandmate ls --branch feature/101 --quiet)
WT2=$(commandmate ls --branch feature/102 --quiet)

commandmate send "$WT1" "Implement #101" --auto-yes
commandmate send "$WT2" "Implement #102" --auto-yes --agent codex

commandmate wait "$WT1" "$WT2" --timeout 1800

commandmate capture "$WT1" --json
commandmate capture "$WT2" --json
```

---

## Troubleshooting

### Server not reachable

```
Error: Server is not running. Start it with: commandmate start
```

**Cause**: CommandMate server is not running, or the port is different.

**Fix**:
```bash
commandmate start --daemon

# If using a different port:
CM_PORT=3011 commandmate ls
```

### Worktree ID not found

```
Error: Resource not found. Check the worktree ID.
```

**Cause**: The specified ID is not registered in the server.

**Fix**:
```bash
# Check registered IDs
commandmate ls --quiet

# Sync worktrees (if newly created)
curl -s -X POST http://localhost:3000/api/repositories/sync
```

### wait keeps timing out

**Cause**: Agent is still processing, or has encountered an error.

**Fix**:
```bash
# Check current state
commandmate capture <id> --json

# Increase timeout
commandmate wait <id> --timeout 3600

# Check directly via browser UI at http://localhost:3000
```

### respond returns "prompt_no_longer_active"

```
Warning: Response may not have been applied. Reason: prompt_no_longer_active
```

**Cause**: The prompt has already been dismissed (auto-yes responded, or timing mismatch).

**Fix**: No action needed. The agent continues normally. Proceed with `wait`.

### Invalid duration / agent errors

```
Error: Invalid duration. Must be one of: 1h, 3h, 8h
Error: Invalid agent. Must be one of: claude, codex, gemini, vibe-local, opencode
```

**Fix**: Use one of the allowed values listed in the error message.

### Connecting to an authenticated server

If the server was started with `--auth`, pass the token via environment variable or flag:

```bash
# Recommended: environment variable (not visible in process list)
CM_AUTH_TOKEN=your-token commandmate ls

# Alternative: --token flag (visible in process list — use with caution)
commandmate ls --token your-token
```

---

## Exit Codes

| Code | Name | Meaning |
|:----:|------|---------|
| 0 | SUCCESS | Completed successfully |
| 1 | DEPENDENCY_ERROR | Server not running |
| 2 | CONFIG_ERROR | Validation error (invalid agent, duration, etc.) |
| 10 | PROMPT_DETECTED | Prompt detected during wait |
| 99 | UNEXPECTED_ERROR | Unexpected error / resource not found |
| 124 | TIMEOUT | Wait timeout exceeded |
