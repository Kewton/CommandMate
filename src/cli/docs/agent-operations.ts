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
  commandmate ls --id <prefix>            # Filter by worktree id prefix

  Worktree ids are <repo>-<branch> slugs (e.g. anvil-develop). --id / --branch
  front-match is case-sensitive and does NOT guarantee uniqueness (e.g.
  --id anvil-develop also matches anvil-develop-2). --branch and --id combine
  as AND. Use --id to disambiguate the same branch across repositories.

  STATUS values:
    idle     - Session not started
    ready    - Session running, waiting for input (task completed)
    running  - Agent executing a task
    waiting  - Confirmation prompt active (Yes/No, etc.)

### commandmate sync
  Ask the server to re-scan repositories and sync worktrees to its database
  (same endpoint as the GUI sync button). Run it after 'git worktree add' so the
  new worktree appears in 'commandmate ls' without opening the GUI (Issue #1680).

  commandmate sync                        # Prints the server's summary message
  commandmate sync --json                 # Full API response (worktreeCount,
                                          # repositoryCount, repositories,
                                          # deletedCount, cleanupWarnings)

### commandmate send <worktree-id> "<message>"
  Send a message to an agent (async). Starts session automatically if not running.

  Options:
    --instance <id>        Agent instance ID: <agent> or <agent>-<n> (e.g. claude-2, or codex
                           for the codex primary instance). The recommended way to name a
                           target: send / wait / respond / capture / auto-yes all take it.
    --agent <id>           Ad-hoc CLI tool for an instance the roster does not know:
                           claude (default), codex, gemini, vibe-local, opencode, copilot, antigravity
    --register             Register the --instance session into the agent-instance roster
    --auto-yes             Enable auto-yes before sending (session-wide, no policy
                           guard -- for unattended runs prefer --contract with an
                           autoYes policy: mode / denyPatterns)
    --duration <d>         Auto-yes duration: 1h, 3h, 8h (default: 1h)
    --stop-pattern <p>     Auto-yes stop condition (regex; matches terminal output,
                           cannot block commands -- see auto-yes below)
    --ignore-structured-prompt
                           Send even if only the agent's hooks report an open dialog.
                           For a session whose pane looks idle but keeps refusing;
                           a dialog visible in the terminal is still refused.

  Refused while the agent is waiting on a prompt (exit 2). Keystrokes sent to
  an open dialog never reach the agent -- they pile up in the dialog's own
  input line, and the next respond then carries that text along as a message
  instead of an answer. Nudging a stalled worker is how this gets worse.
  Answer first: commandmate respond <id> <answer>. respond, special keys and
  prompt-response are never refused -- they are the way out. Timer-fired sends
  ARE refused (same service layer) and record [prompt_waiting] as their reason.
  It fails open if the pane cannot be read, so treat it as a narrowing, not a
  guarantee.

  Two layers can report the dialog: the terminal scraper, and the agent's own
  hooks. Either one is enough to refuse -- the dialog the scraper cannot read is
  exactly the one that caused this. A frame neither layer classifies is still
  wait's "unclassified" case instead.

  A hook-reported dialog is released by the agent's next event, and hooks are
  fail-open, so the record can outlive its dialog. It therefore stops blocking
  sends 5 minutes after it was reported -- and immediately with
  --ignore-structured-prompt, or CM_STRUCTURED_SEND_GUARD=off for the server.
  A session nobody can send to is worse than a missed guard. Both bypasses are
  narrow: a prompt on screen is still refused, and the payload still reports it
  (wait and the UI do not go quiet).

  Finding worktree IDs:
    WT=$(commandmate ls --branch feature/101 --quiet)
    WT=$(commandmate ls --id anvil- --quiet)   # disambiguate by repo (id prefix)
    commandmate send "$WT" "Implement this"

  Targeting a non-default agent (Issue #1638): pass --instance, not --agent. Only
  --instance is accepted by every command -- 'wait --agent' does not exist -- so a
  workflow that names the agent on 'send' and nothing on 'wait' waits on the wrong
  session in silence.
    commandmate send "$WT" "Implement this" --instance codex
    commandmate wait "$WT" --instance codex

### commandmate wait <worktree-id...>
  Block until agent completes or prompt is detected.

  Options:
    --timeout <seconds>        Maximum wait time
    --on-prompt <mode>         agent (default) or human
    --stall-timeout <seconds>  Max time without output change
    --instance <id>            Agent instance to wait on. There is no --agent here.
    --verify                   After completion, run every verification gate
    --require-work             After completion, run only the work-evidence gate

  Exit codes:
    0   - Completed (agent idle/ready), and verified when --verify was given
    10  - Prompt detected (--on-prompt agent mode)
    20  - A verification gate failed (--verify)
    21  - Nothing to verify: no commits, no uncommitted changes
    124 - Timeout exceeded

  --on-prompt modes:
    agent  - Returns exit 10 immediately with prompt JSON on stdout
    human  - Keeps blocking until human responds via browser UI

  Prompt JSON output (exit 10):
    {"worktreeId":"...","cliToolId":"claude","type":"yes_no","question":"...","options":["yes","no"],"status":"pending"}
    The payload IS the prompt -- read it from stdout before falling back to
    capture. For type "selection_list", options is empty by design and the
    question field carries the reason.

    Three "type" values share exit 10; only the first is answerable with
    respond:
      yes_no / multiple_choice  a parsed prompt        -> commandmate respond
      selection_list            arrow-key menu         -> special keys
      unclassified              the frame is interactive but detection could
                                not parse it, and it has stayed that way for
                                60s -> look at the pane: capture <id> --pane
    "unclassified" exists because a frame that slips past detection disables
    auto-yes, the contract's autoYes policy and this exit 10 all at once. It
    needs the dwell: a capture taken mid-repaint can raise the flag once.
    --on-prompt human keeps waiting for it, same as the other two.

  --verify turns "the agent stopped" into "the work passes the repository's own
  checks". Verification only runs when completion was detected: a prompt (10) or
  a timeout (124) is reported as-is and never verified. With several worktrees,
  gates run one worktree at a time because the server caps concurrent runs.

### commandmate verify <worktree-id>
  Run the gates declared in .commandmate/verify.yaml against a worktree.

  Options:
    --gates <id1,id2>     Gate ids to run (default: work-evidence + all declared)
    --instance <id>       Attribute the run to an agent instance
    --timeout <seconds>   Stop polling after N seconds (exit 124)
    --json                Print the run and its gate results as JSON on stdout

  Exit codes:
    0   - Every gate passed
    20  - A gate failed, timed out, or errored
    21  - work-evidence found nothing to verify (no commits, no changes)
    99  - The run produced no verdict (bad verify.yaml, gates skipped, cancelled)
    124 - --timeout elapsed while the run was still going

  Output (progress on stderr, verdict on stdout):
    GATE work-evidence PASS (commits=3, uncommitted=2)
    GATE lint PASS (exit=0, 12.3s)
    GATE unit FAIL (exit=1, 45.0s)
    RESULT failed

  Gates run in the worktree's own directory. Gates are skipped (run status 99,
  never 0) in the checkout the server itself runs from when verify.yaml sets
  options.skipInPrimaryCheckout, so a 'build' gate cannot replace the assets the
  live app is serving.

### commandmate verify history / commandmate verify show <run-id>
  Read past verification runs. Both are read-only and never start a run, so
  neither returns 20 or 21 — those mean "this tree failed verification", and a
  question about history is not a verdict on the current tree.

  commandmate verify history                          # every worktree, newest 50
  commandmate verify history --worktree <id>          # one worktree
  commandmate verify history --days 14 --limit 100    # window and page size
  commandmate verify history --json                   # JSON array on stdout
  commandmate verify show 42                          # gates + log tails
  commandmate verify show 42 --json

  history options:
    --worktree <id>       Restrict to one worktree (default: all)
    --days <n>            Look back n days, 1..90 (default: no lower bound)
    --limit <n>           Maximum runs, 1..500 (default: 50)

  One run per line. The leading #<run-id> is what "verify show" takes:
    #42  2026-07-31T04:12:00.000Z  myrepo-feature-101  manual  failed  failed: unit,build

  The listing carries gate verdicts but NOT gate log bodies — logTail is absent
  from the JSON, not null. Use "verify show <run-id>" when you need the log.

  Exit codes:
    0   - Read succeeded (also when nothing matched: stderr note, or [] in JSON)
    2   - Bad argument (--days/--limit out of range, bad worktree or run id)
    99  - No such run (404), or an unexpected failure

### commandmate respond <worktree-id> "<answer>"
  Respond to an agent's prompt.

  commandmate respond <id> "yes"          # Yes/No
  commandmate respond <id> "2"            # Multiple choice (number)
  commandmate respond <id> "custom text"  # Free text
  commandmate respond <id> "yes" --instance codex-2   # Specific instance

  Exit codes:
    0  - Response sent
    99 - Prompt already dismissed (prompt_no_longer_active)

### commandmate capture <worktree-id>
  Get current terminal output.

  commandmate capture <id>                   # Plain text
  commandmate capture <id> --json            # JSON with status info
  commandmate capture <id> --instance codex  # Specific instance

### commandmate auto-yes <worktree-id>
  Control auto-yes (automatic prompt response).

  commandmate auto-yes <id> --enable                    # Enable (default 1h)
  commandmate auto-yes <id> --enable --duration 3h      # With duration
  commandmate auto-yes <id> --enable --stop-pattern "error"
  commandmate auto-yes <id> --disable                   # Disable
  commandmate auto-yes <id> --enable --instance codex-2 # Scoped to one instance

  --stop-pattern matches new terminal output, not the commands an agent runs.
  It cannot block a command; a build log that merely prints the pattern
  (e.g. "rm -rf" in an npm script) also triggers it and stops auto-yes.
  To suppress auto-responses for risky prompts, use the task contract's
  autoYes.denyPatterns instead (docs/design/task-contract.md).

### commandmate instances <worktree-id> [action] [args]
  Discover and manage a worktree's agent-instance roster (1 agent, multiple sessions).

  commandmate instances <id>                            # List roster + running/auto-yes status
  commandmate instances <id> --json                     # JSON output
  commandmate instances <id> add --agent codex          # Add an instance (auto-generates ID, e.g. codex-2)
  commandmate instances <id> add --agent codex --alias "Review" --id codex-3
  commandmate instances <id> remove <instance-id>       # Remove from roster
  commandmate instances <id> remove <instance-id> --kill  # Remove and kill its session
  commandmate instances <id> alias <instance-id> "New Name"
  commandmate instances <id> kill <instance-id>         # Kill only that instance's session

  See "Multi-Session" below for the ID convention and roster semantics.

### commandmate skill <subcommand>
  Manage official Agent Skills. Every subcommand is a thin client over the same
  APIs the browser UI uses: the CLI never downloads, extracts, writes or deletes
  anything itself, and never sends a filesystem path, artifact URL, file list or
  checksum (the API rejects those outright).

  commandmate skill list [--json] [--prerelease]
  commandmate skill info <skill-id> [--version <v>] [--json]
  commandmate skill plan <skill-id> --worktree <id> [--version <v>] [--json]
  commandmate skill install <skill-id> --worktree <id> --version <exact> [--dry-run] [--yes] [--ack-risk <id>@<version>] [--json]
  commandmate skill uninstall <skill-id> --worktree <id> [--dry-run] [--yes] [--json]
  commandmate skill status <skill-id> --worktree <id> [--json]

  Confirmation contract (writes = install / uninstall):
    - A plan is always built and shown first. --dry-run stops there.
    - Without a TTY, a write REQUIRES --yes. A missing --yes is refused, never
      assumed: an environment that cannot prompt must not install silently.
    - A high-risk Skill additionally requires --ack-risk <skill-id>@<version>
      with the exact id and version. --yes alone never carries a high-risk
      install, in a TTY or out of one.

  Exit codes:
    0   success
    1   the server or the Catalog could not be reached (retryable)
    2   invalid arguments, unknown Skill or unknown version
    11  the worktree refused it (local change, conflict, lock, plan drift)
    12  the write was never confirmed (no --yes, declined, or missing --ack-risk)
    13  files changed but the operation needs reconciliation

  --json prints the API response body verbatim on stdout; diagnostics, prompts
  and errors always go to stderr, so a failed --json run leaves stdout empty.

  'skill status' reports one Skill in one worktree, read from the install
  receipt on disk. There is no per-worktree listing endpoint yet, so <skill-id>
  is required.

## Multi-Session (1 agent, multiple sessions)

  A worktree can run several sessions of the same CLI tool concurrently. Each
  session is an "instance" identified by an instance ID:
    <agent>        - the agent's primary instance (e.g. "claude")
    <agent>-<n>    - an additional instance, n >= 2 (e.g. "claude-2", "claude-3")

  --instance is accepted by send / wait / respond / capture / auto-yes.
  send --instance auto-starts the session if it is not already running.

  --instance alone is the recommended way to name a target (Issue #1638). It is
  the only flag all five commands share: --agent is rejected by 'wait'. A
  rostered instance already carries its CLI tool (Issue #1629), and an instance
  id that is itself a tool id resolves to that tool's primary instance even
  without a roster entry, so '--instance codex' needs no --agent.

  --agent remains accepted by send / respond / capture / auto-yes as the
  supplement for ad-hoc instances the roster does not know -- notably
  '--register', which cannot infer the tool from an id like codex-3. Passing an
  --agent that contradicts the roster is an error (exit 2), not an override.

  The roster (visible in the browser UI's Agent panel) is the list of known
  instances with aliases and display order. Ad-hoc sessions started via
  'send --instance' do NOT appear in the roster unless registered:
    commandmate send <id> "..." --instance claude-2 --register
  Without --register, the session still runs and responds to CLI commands,
  but it will not show up in the UI sidebar/roster until added there or via
  'commandmate instances <id> add'.

  Per-instance auto-yes: --instance scopes --auto-yes/--duration/--stop-pattern
  to that specific session, independent of other instances of the same agent.

  commandmate instances <id>                        # discover valid --instance values
  commandmate send <id> "task" --instance codex-2 --auto-yes
  commandmate wait <id> --instance codex-2 --timeout 600
  commandmate capture <id> --instance codex-2

## All Exit Codes

  0   SUCCESS          - Completed successfully
  1   DEPENDENCY_ERROR - Server not running
  2   CONFIG_ERROR     - Validation error (invalid agent, duration, etc.)
  10  PROMPT_DETECTED  - Prompt detected during wait
  20  VERIFY_FAILED    - A verification gate failed (verify, wait --verify)
  21  NOT_STARTED      - Nothing to verify: no commits, no uncommitted changes
  99  UNEXPECTED_ERROR - Unexpected error / resource not found / no verdict
  124 TIMEOUT          - Wait or verification timeout exceeded

  When one 'wait' covers several worktrees, the reported code is the highest
  priority one observed: 10 > 20 > 21 > 124.

## Troubleshooting

  Server not running:
    commandmate start --daemon
    CM_PORT=3011 commandmate ls        # Different port

  Worktree not found:
    commandmate ls --quiet             # Check registered IDs
    commandmate sync                   # Sync new worktrees (e.g. after git worktree add)

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
  commandmate send "$WT2" "Implement #102" --auto-yes --instance codex

  # One --instance covers every worktree id in the call, so worktrees on
  # different instances need one wait each. Both agents keep running while the
  # first wait blocks, so this costs no wall clock over a combined wait.
  # A bare 'wait "$WT2"' would watch WT2's DEFAULT agent, not the codex session:
  # 'wait' has no --agent to correct that with.
  commandmate wait "$WT1" --timeout 1800
  commandmate wait "$WT2" --instance codex --timeout 1800

  commandmate capture "$WT1" --json
  commandmate capture "$WT2" --instance codex --json

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

## 7. Multi-Session: run a second Codex session alongside the primary agent

  WT=$(commandmate ls --branch feature/101 --quiet)

  # Discover the roster before picking an --instance value
  commandmate instances "$WT"

  # Register a second Codex instance, then send/wait/capture scoped to it.
  # Once it is in the roster, --instance alone carries the CLI tool.
  commandmate instances "$WT" add --agent codex --alias "Review"
  commandmate send "$WT" "Review the diff" --instance codex-2 --auto-yes
  commandmate wait "$WT" --instance codex-2 --timeout 600
  commandmate capture "$WT" --instance codex-2 --json

  # Ad-hoc instance without pre-registering (still runs; register to show in UI).
  # --agent is required here: codex-3 is not in the roster yet, so nothing else
  # says which CLI tool to start.
  commandmate send "$WT" "Quick check" --agent codex --instance codex-3 --register

  # Clean up when done
  commandmate instances "$WT" remove codex-2 --kill

## 8. Verify the work instead of trusting "the agent stopped"

  WT=$(commandmate ls --branch feature/101 --quiet)
  commandmate send "$WT" "Implement Issue #101 with TDD" --auto-yes

  # One call: wait for completion, then run every gate in .commandmate/verify.yaml
  commandmate wait "$WT" --timeout 1800 --verify
  case $? in
    0)  echo "Verified" ;;
    10) commandmate respond "$WT" "yes" ;;
    20) echo "A gate failed"; commandmate verify "$WT" --json ;;
    21) echo "The agent produced nothing" ;;
  esac

  # Cheap pre-check: is there any work at all, before paying for the full suite?
  commandmate wait "$WT" --require-work || echo "no commits and no changes"

  # Re-run a subset after a fix, without waiting on the agent
  commandmate verify "$WT" --gates lint,unit
`;
