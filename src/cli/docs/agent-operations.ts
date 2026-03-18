/**
 * Agent Operations documentation content
 * Issue #518: Embedded in CLI for npm package distribution
 *
 * This content is embedded as a string constant so that it's available
 * even when installed via `npm install -g commandmate` (where docs/ is not included).
 */

export const AGENT_OPERATIONS_GUIDE = `# CLI Agent Operations Guide

Operate agent sessions from the CommandMate CLI.
These commands enable coding agents (Claude Code, Codex, etc.) to orchestrate other agents in parallel.

## Prerequisites

- CommandMate server must be running: commandmate start --daemon
- Target worktrees must be registered (visible in browser UI sidebar)
- Use CM_PORT env var to connect to a different port (default: 3000)
- Use CM_AUTH_TOKEN env var for authenticated servers

## Commands

### commandmate ls
  List worktrees with status.

  commandmate ls                          # Table format (ID, NAME, STATUS, DEFAULT)
  commandmate ls --json                   # JSON output (for agent consumption)
  commandmate ls --quiet                  # IDs only, one per line (for piping)
  commandmate ls --branch <prefix>        # Filter by branch name prefix

  STATUS values:
    idle     - Session not started
    ready    - Session running, waiting for input (task completed)
    running  - Agent executing a task
    waiting  - Confirmation prompt active (Yes/No, etc.)

### commandmate send <worktree-id> "<message>"
  Send a message to an agent (async). Starts session automatically if not running.

  Options:
    --agent <id>           Agent type: claude (default), codex, gemini, vibe-local, opencode
    --auto-yes             Enable auto-yes before sending
    --duration <d>         Auto-yes duration: 1h, 3h, 8h (default: 1h)
    --stop-pattern <p>     Auto-yes stop condition (regex)

  Finding worktree IDs:
    WT=$(commandmate ls --branch feature/101 --quiet)
    commandmate send "$WT" "Implement this"

### commandmate wait <worktree-id...>
  Block until agent completes or prompt is detected.

  Options:
    --timeout <seconds>        Maximum wait time
    --on-prompt <mode>         agent (default) or human
    --stall-timeout <seconds>  Max time without output change

  Exit codes:
    0   - Completed (agent idle/ready)
    10  - Prompt detected (--on-prompt agent mode)
    124 - Timeout exceeded

  --on-prompt modes:
    agent  - Returns exit 10 immediately with prompt JSON on stdout
    human  - Keeps blocking until human responds via browser UI

  Prompt JSON output (exit 10):
    {"worktreeId":"...","cliToolId":"claude","type":"yes_no","question":"...","options":["yes","no"],"status":"pending"}

### commandmate respond <worktree-id> "<answer>"
  Respond to an agent's prompt.

  commandmate respond <id> "yes"          # Yes/No
  commandmate respond <id> "2"            # Multiple choice (number)
  commandmate respond <id> "custom text"  # Free text

  Exit codes:
    0  - Response sent
    99 - Prompt already dismissed (prompt_no_longer_active)

### commandmate capture <worktree-id>
  Get current terminal output.

  commandmate capture <id>                # Plain text
  commandmate capture <id> --json         # JSON with status info
  commandmate capture <id> --agent codex  # Specific agent

### commandmate auto-yes <worktree-id>
  Control auto-yes (automatic prompt response).

  commandmate auto-yes <id> --enable                    # Enable (default 1h)
  commandmate auto-yes <id> --enable --duration 3h      # With duration
  commandmate auto-yes <id> --enable --stop-pattern "error"
  commandmate auto-yes <id> --disable                   # Disable

## All Exit Codes

  0   SUCCESS          - Completed successfully
  1   DEPENDENCY_ERROR - Server not running
  2   CONFIG_ERROR     - Validation error (invalid agent, duration, etc.)
  10  PROMPT_DETECTED  - Prompt detected during wait
  99  UNEXPECTED_ERROR - Unexpected error / resource not found
  124 TIMEOUT          - Wait timeout exceeded

## Troubleshooting

  Server not running:
    commandmate start --daemon
    CM_PORT=3011 commandmate ls        # Different port

  Worktree not found:
    commandmate ls --quiet             # Check registered IDs
    curl -s -X POST http://localhost:3000/api/repositories/sync  # Sync new worktrees

  Authentication:
    CM_AUTH_TOKEN=your-token commandmate ls
`;

export const AGENT_OPERATIONS_SAMPLES = `# CLI Agent Operations - Workflow Samples

Copy and adapt these patterns for your use case.

## 1. Basic: send, wait, capture

  WT=$(commandmate ls --branch feature/101 --quiet)
  commandmate send "$WT" "Implement Issue #101 with TDD"
  commandmate wait "$WT" --timeout 600
  commandmate capture "$WT"

## 2. With Auto-Yes (unattended execution)

  WT=$(commandmate ls --branch feature/101 --quiet)
  commandmate send "$WT" "Implement Issue #101" --auto-yes --duration 3h
  commandmate wait "$WT" --timeout 1800
  commandmate auto-yes "$WT" --disable    # Disable for safety
  commandmate capture "$WT" --json

## 3. Prompt Response Loop

  WT=$(commandmate ls --branch feature/101 --quiet)
  commandmate send "$WT" "Refactor this module"

  while true; do
    commandmate wait "$WT" --timeout 600 --on-prompt agent
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      echo "Done"
      break
    elif [ $EXIT_CODE -eq 10 ]; then
      commandmate respond "$WT" "yes"
    elif [ $EXIT_CODE -eq 124 ]; then
      echo "Timeout"
      break
    fi
  done

  commandmate capture "$WT"

## 4. Parallel Worktrees

  WT1=$(commandmate ls --branch feature/101 --quiet)
  WT2=$(commandmate ls --branch feature/102 --quiet)

  commandmate send "$WT1" "Implement #101" --auto-yes
  commandmate send "$WT2" "Implement #102" --auto-yes --agent codex

  commandmate wait "$WT1" "$WT2" --timeout 1800

  commandmate capture "$WT1" --json
  commandmate capture "$WT2" --json

## 5. Check status before sending

  # Find worktrees and check status
  commandmate ls --json | python3 -c "
  import sys, json
  for wt in json.load(sys.stdin):
      if wt['name'].startswith('feature/'):
          print(f\\"{wt['id']}  {wt['name']}\\")
  "

## 6. Error handling pattern

  WT=$(commandmate ls --branch feature/101 --quiet)

  if [ -z "$WT" ]; then
    echo "Error: worktree not found"
    exit 1
  fi

  commandmate send "$WT" "Fix the bug" --auto-yes
  commandmate wait "$WT" --timeout 600
  EXIT_CODE=$?

  case $EXIT_CODE in
    0)   echo "Success"; commandmate capture "$WT" ;;
    10)  echo "Prompt detected"; commandmate respond "$WT" "yes" ;;
    124) echo "Timeout"; commandmate capture "$WT" --json ;;
    *)   echo "Error: exit $EXIT_CODE" ;;
  esac
`;
