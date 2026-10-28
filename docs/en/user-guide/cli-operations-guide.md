[日本語版](../../user-guide/cli-operations-guide.md)

# CLI Operations Guide

Guide for operating agent sessions from the CommandMate CLI.
These commands enable coding agents (Claude Code, Codex, etc.) to orchestrate other agents in parallel.

---

## Prerequisites

- CommandMate server must be running (`commandmate start --daemon`)
- Target worktrees must be registered (visible in the browser UI sidebar)

### Server Port

The target is resolved in this order (Issue #1743):

1. `CM_PORT` exported in the shell (e.g. `CM_PORT=3011 commandmate ls`)
2. `CM_PORT` in `~/.commandmate/.env`
3. The default, `3000`

```bash
# 1. Name the target for this one invocation (wins over .env)
CM_PORT=3011 commandmate ls

# 2. With no CM_PORT in the shell, the .env value is used
#    (the same port `commandmate status` reports)
commandmate ls
```

Host and protocol come from the same configuration: a `CM_BIND` of `0.0.0.0` is dialled as `127.0.0.1`, and HTTPS is used only when **both** `CM_HTTPS_CERT` and `CM_HTTPS_KEY` are set.

> **Note**: `commandmate status` reports where the server actually runs, so there `.env` takes precedence over exported variables — that is the order the server process itself is started with. Resolving a client connection answers a different question ("where should this invocation dial?"), so the shell wins, as above.

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
| [`commandmate sync`](#commandmate-sync) | Make the server rescan its worktrees (the GUI sync button) |
| [`commandmate send`](#commandmate-send) | Send a message to an agent |
| [`commandmate wait`](#commandmate-wait) | Wait for agent completion |
| [`commandmate prompt`](#commandmate-prompt) | Observe the screen an agent is stopped on (kind, options, observation token) |
| [`commandmate respond`](#commandmate-respond) | Respond to a prompt |
| [`commandmate verify`](#commandmate-verify) | Run the verification gates (`.commandmate/verify.yaml`) and read the run history |
| [`commandmate task`](#commandmate-task) | List and inspect execution contracts (`.commandmate/tasks/*.yaml`) |
| [`commandmate capture`](#commandmate-capture) | Get terminal output |
| [`commandmate reply`](#commandmate-reply) | Get a session's latest reply (from its transcript) |
| [`commandmate attach`](#commandmate-attach) | Attach this terminal to an agent's tmux session |
| [`commandmate auto-yes`](#commandmate-auto-yes) | Control auto-yes |
| [`commandmate instances`](#commandmate-instances) | List, add, remove, and rename agent instances (the roster) |
| [`commandmate report`](#commandmate-report) | Generate, show, and list daily reports; aggregate Eval metrics |
| [`commandmate skill`](#commandmate-skill) | Browse the Skill catalog; plan, install, update, uninstall, and inspect Skills |
| [`commandmate update`](#commandmate-update) | Update CommandMate itself (stop, update, restart) |
| [`commandmate remote`](#commandmate-remote) | Use CommandMate from your phone (publish over a provider tunnel and pair with a QR code) |

---

## commandmate ls

List worktrees with their status.

```bash
commandmate ls                          # Table format
commandmate ls --json                   # JSON (for agents)
commandmate ls --quiet                  # IDs only (one per line)
commandmate ls --branch feature/        # Filter by branch prefix
commandmate ls --id anvil-             # Filter by worktree id prefix
```

> **`--json` carries `tmuxSession`** (Issue #2317): the tmux session name of the worktree's **default
> agent's primary instance** — the session `commandmate attach <id>` opens. It is derived CLI-side
> from `id` and `cliToolId`, and is `null` for a row with no default agent or one naming an agent this
> CLI does not know. For the per-instance list, use `commandmate instances <id>` (`TMUX_SESSION`).
>
> ```bash
> commandmate ls --json | jq -r '.[] | "\(.id)\t\(.tmuxSession)"'
> ```

> **About `--id`**: A worktree ID is a slug derived from the **worktree directory name** (e.g. `commandmate-issue-1644`, Issue #1621; a `-<8-hex-path-hash>` suffix is added only when several repositories hold a directory of the same name). `--id` front-matches on that ID. `--branch` and `--id` are applied independently; specifying both applies both (AND). When the same branch name (e.g. `develop`) exists across multiple repositories, an ID prefix such as `--id anvil-` narrows the result to a single repository's worktree. The front-match is case-sensitive and does not guarantee uniqueness (`--id anvil-develop` may also match `anvil-develop-2`). To pin down exactly one worktree, pipe `--quiet` output through `grep -x` or pass a prefix that is already unique.

### Output Example

```
ID                     NAME                  STATUS   REASON                          DEFAULT  AUTO_YES
---------------------  --------------------  -------  ------------------------------  -------  ---------------
localllm-test          main                  ready    input_prompt                    claude   42:10
commandmate            develop               running  thinking_indicator              claude   1:05:33
commandmate-issue-518  feature/518-worktree  running  no_recent_output (no evidence)  claude   off
commandmate-issue-600  feature/600-sessions  waiting  prompt_detected                 claude   off
commandmate-issue-644  feature/644-repos     waiting  -                               claude   03:12 (codex-2)
commandmate-main       main                  idle     -                               claude   off
```

> IDs derive from the **worktree directory name** (Issues #1621 / #1645). The directory names
> `/worktree-setup` creates already contain the Issue number, so an ID is shorter and easier to read
> than the old form (`<repo>-<branch>`). The NAME column is the branch, refreshed on every checkout.

### STATUS Column

| Status | Meaning |
|--------|---------|
| `idle` | Session not started |
| `ready` | Session running, waiting for input (task completed) |
| `running` | Agent executing a task |
| `waiting` | Confirmation prompt active (Yes/No, etc.) |

### REASON Column (Issue #1926)

The **evidence** behind the STATUS beside it. The same `ready` can mean "the agent came back to its
composer" (`input_prompt`) or "the frame could not be read and the output stopped" (`no_recent_output`,
which is shown with `running`) — two different things the table could not tell apart before.

| Value | Meaning |
|---|---|
| `input_prompt` | A composer (input prompt) was detected |
| `thinking_indicator` | A thinking indicator was detected |
| `prompt_detected` | A confirmation prompt was parsed |
| `<reason> (no evidence)` | **No positive evidence** (`statusEvidence: 'none'`). The STATUS beside it is a fallback rather than a reading. This covers a frame the detection layer could not classify (`running` with reason `no_recent_output` / `unknown_frame` / `default`) and also a classified frame with no positive proof (for example an idle composer no tool-specific rule vouches for, `input_prompt`) |
| `-` | The server gives no reason: it predates #1926, the session is not running, or the tool has two or more instances and the aggregate dropped the reason |

> A `(no evidence)` row does not mean "finished". Check the raw pane with
> `commandmate capture <id> --pane`. When the same state holds for 60 seconds,
> `commandmate wait` returns exit 10 (`type: 'unclassified'`).

`--json` passes **the server's row through verbatim**: the reason and the evidence live under
`sessionStatusByCli.<tool>` and are not lifted to the top level, so the payload matches
`GET /api/worktrees`.

```bash
commandmate ls --json \
  | jq -r '.[] | "\(.id)\t\(.sessionStatusByCli.claude.sessionStatusReason // "-")\t\(.sessionStatusByCli.claude.statusEvidence // "-")"'
```

| Field | Meaning |
|---|---|
| `sessionStatusByCli.<tool>.statusEvidence` | `'positive'` (something confirmed it) / `'none'` (no positive proof, including a frame that could not be read) |
| `sessionStatusByCli.<tool>.sessionStatusReason` | The scraper's reason code. Whether the pane is working (`isProcessing`) also folds in the agent's own hooks (`Stop` and the rest) by the rules `capture --json` applies, so right after a `Stop` it can read `isProcessing: false` while the working row is still on screen and this reason still says `thinking_indicator` (Issue #3377) |
| `sessionStatusByCli.<tool>.lastKnownStatus` / `lastKnownStatusAt` | The last **positively confirmed** status and when. Held in server memory (TTL 30 minutes, cleared on restart, dropped when the session stops) |

### AUTO_YES Column (Issue #2575)

How much Auto-Yes is left on the instance that will lose it **first**, among the instances that
explain this row's STATUS. A `waiting` row reading `off` is **a confirmation prompt nobody is going
to answer** — it waits for a human. Reading that off this one column, with no push notification
configured and no subscription, is what the column exists for.

| Value | Meaning |
|---|---|
| `42:10` | Time left (`MM:SS` under an hour) |
| `1:05:33` | Time left (`H:MM:SS` from an hour up) |
| `off` | At least one of those instances is **not armed**, so a prompt on this row waits for a human |
| `off(restart)` | An `off` instance whose grant **a server restart released** (Issue #3730). A restart never turns a grant back on. It reads this way until the original grant's deadline, or until `--enable` / `--disable`. The reason is `autoYesStopReasonByInstance.<instanceId>: "server-restart"` in `--json` (a field of its own, beside the armed-only `autoYesByInstance`) |
| `blocked` | Armed, but the contract running on that instance sets `autoYes.mode: off`, so it **answers nothing** (Issue #3723). Like `off`, a prompt waits for a human. The reason is `autoYesByInstance.<instanceId>.blockedByContract: true` in `--json` |
| `on` | Armed with no expiry the server named (`expiresAt: null`; the current server does not produce this shape) |
| `-` | **Not known**: the server predates #2512 (no `autoYesByInstance`), or this row is not `idle` and no instance explains its STATUS |
| `03:12 (codex-2)` | The cell is about an instance other than the default agent's primary. The id in parentheses is an `--instance` value verbatim |

Which instances count is decided per STATUS: `waiting` takes the ones waiting, `running` the ones
processing, `ready` the ones running, and `idle` the ones that exited. Only a bare `idle` row that
nothing explains falls back to every armed instance.

> **Time left is not a promise that the prompt gets answered.** A contract (`--contract`) autoYes
> policy can withhold the answer, and a free-text prompt has no answer to give in the first place.
> What was withheld and why it stopped are in
> `commandmate capture <id> --json --instance <instanceId>` as `autoYes.lastSuppression` and
> `autoYes.stopReason`. `commandmate wait <id>` returns exit 10 for a prompt no agent will clear.

> **`off` wins because the cell is a minimum.** On a row where `claude` is unarmed and `codex` has
> ten minutes left, the cell reads `off`, not `10:00` — a countdown must not bury a prompt nobody
> will answer. The per-instance breakdown is still in `--json` under `autoYesByInstance`.

> **REASON and AUTO_YES can be about different sessions.** REASON is chosen per tool (preferring the
> worktree default), AUTO_YES per instance, so the two cells on one row need not agree. The instance
> id in parentheses is sometimes the only thing on the line that identifies the waiting session.

`--json` does **not** derive this column. It carries `sessionStatusByInstance` and
`autoYesByInstance` as the server sent them, which is where the per-instance breakdown is.

```bash
# Only the rows that are waiting with nobody to answer (columns are split on 2+ spaces)
commandmate ls | awk -F'  +' '$3 == "waiting" && $6 ~ /^off/'
```

> `$6`, not `$NF`: the parenthesis in `off (codex-2)` is joined by **a single space**, so `$NF`
> would pick up `(codex-2)` and silently skip exactly the multi-agent rows.

---

## commandmate sync

Make the server rescan its repositories and sync worktrees into the database (Issue #1680).
It calls the same endpoint as the worktree sync button in the GUI (`POST /api/repositories/sync`),
so a worktree created with `git worktree add` can be surfaced in `commandmate ls` from the CLI alone.

### Usage

```bash
commandmate sync                        # Rescan (prints the server's message)
commandmate sync --json                 # Print the sync result as JSON (the API response)
```

### Output Example

```
$ commandmate sync
Successfully synced 12 worktree(s) from 3 repository/repositories
```

`--json` prints the API response verbatim, including `worktreeCount` / `repositoryCount` /
`repositories` / `deletedCount` / `cleanupWarnings`.

### Errors

| Condition | Behavior |
|-----------|----------|
| Server not running | `Server is not running. Start it with: commandmate start` (exit 1) |
| No repositories configured | The server's 400 message (which points at `WORKTREE_REPOS` / `CM_ROOT_DIR`) is printed verbatim (exit 2) |

### Typical Flow

```bash
git worktree add ../myrepo-issue-123 -b feature/123-fix origin/develop
commandmate sync                        # Let the server discover the new worktree
commandmate ls --id myrepo-issue-123    # Visible immediately after the sync
commandmate send myrepo-issue-123 "Start working on this"
```

---

## commandmate send

Send a message to a worktree's agent (async). Starts the session automatically if not running.

```bash
commandmate send <worktree-id> "<message>"
commandmate send <worktree-id> "<message>" --instance codex
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
commandmate send <worktree-id> "<message>" --auto-yes --auto-yes-answer-mode careful  # questions are yours
```

`--auto-yes-answer-mode <m>` picks the answer mode `--auto-yes` arms with (`recommended` / `careful`;
see [Answer Modes](#answer-modes-recommended-and-careful-issue-3863)). Without `--auto-yes` it is
an error (exit 2). Omitted, a new grant is `recommended` and a grant that is on keeps its mode (Issue #3863).

### Naming the target: use `--instance` (Issue #1638)

`--instance` is the only target flag every command accepts. `--agent` is accepted
by `send` / `respond` / `capture` / `auto-yes` but **not by `wait`**, which fails
with `unknown option` (exit 1). That asymmetry is what bites: name the agent on
`send` and nothing on `wait`, and `wait` watches the worktree's **default** agent
— on a worktree cut for Codex it silently waits for Claude Code to finish.

```bash
commandmate send "$WT" "Implement this" --instance codex   # codex primary instance
commandmate wait "$WT" --instance codex                    # same flag, same target
```

An instance id is `<agent>` (the agent's primary instance, e.g. `codex`) or
`<agent>-<n>` (an additional session, e.g. `codex-2`). A registered instance
already carries its CLI tool, and an id that is itself a tool id resolves to
that tool's primary instance even when it is not registered — so `--instance`
alone is enough in both cases.

**`--agent` is not deprecated syntax; it is the supplement for instances the
roster does not know.** It cannot be dropped: `--register` has no other way to
say which CLI tool an unregistered id like `codex-3` should start. Passing an
`--agent` that contradicts a registered instance is an error (exit 2), not an
override.

```bash
# --agent is required here: codex-3 is not in the roster yet
commandmate send "$WT" "Quick check" --agent codex --instance codex-3 --register
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--instance <id>` | **Recommended way to name the target.** Instance id: `<agent>` or `<agent>-<n>` (e.g. `codex`, `claude-2`). Starts the session if it is not running | The agent's primary instance |
| `--agent <id>` | Ad-hoc CLI tool for an instance the roster does not know (claude, codex, gemini, vibe-local, opencode, copilot, antigravity, command-code, opencode-v2) | The roster value / worktree default |
| `--register` | Register the `--instance` session into the roster | - |
| `--model <model>` | Model to use (copilot / antigravity / claude only). **copilot** switches inside the session. **antigravity and claude take it as a launch flag**: it applies only when this send starts the session, and a running session answers 400 (stop the session and resend to switch). For claude the value is an alias (`sonnet` / `opus` / `opus[1m]`) or a full id (`claude-sonnet-5`). The target must be named (`--instance` or `--agent`) | The tool's default |
| `--auto-yes` | Enable auto-yes before sending | - |
| `--duration <d>` | Auto-yes duration (`1h`-`24h`, whole hours; e.g. `1h` / `3h` / `8h`). Out of range exits 2 with or without `--auto-yes` | 1h |
| `--stop-pattern <p>` | Auto-yes stop condition (regex) | - |

### Input that overlaps a send (input lock (#3952))

A message send (`send` / `ask`, chat, timers, relay) types into the composer only while it holds the instance's input lock (Issue #3945), so nothing else is typed in the middle of it (paste → check → Enter, the watch for a late paste, the withdrawal). The other input paths:

| Path | Lock | When it overlaps a send |
|------|------|-------------------------|
| `respond` / the answer panel (answers that send Enter), strict `respond`, Auto-Yes answers, Command Code plan review, codex's automatic answers at launch and before a send (hooks / update / trust / notices), copilot's and Antigravity's automatic folder-trust answers | Takes part (answers do not wait for each other) | Waits for the send to finish, then **reads the screen again and types only if the same confirmation is still up**. When it is gone, changed, unreadable, or the wait passes 60 s, nothing is typed: `respond` reports `answer_not_delivered` (`/respond` answers 409, strict mode exits 40 `session_conflict`), and Auto-Yes decides again on its next tick. A send that starts during an answer waits for the answer's Enter |
| `answer_only` digit answers (no Enter) | Does not take part | One key and no Enter, typed without waiting |
| Claude's trust dialog and Gemini's launch dialog, answered automatically | Does not take part (not covered) | Not ordered against a send. When another send overlaps the launch, that answer's keys can be mixed into its body |
| Typing in the terminal (WebSocket), `direct-input`, special keys (including the unsent bar's **Run**) | Does not take part (neither refused nor held) | **Keys typed during a send can be mixed into its body, or removed by its clean-up (the composer clear, the withdrawal).** Wait until the send is over (the reply has started) before typing |
| `interrupt` (Escape) | Does not take part (does not wait, does not invalidate the send) | So a stop is never queued behind a send. An Escape that arrives while a body is being typed can stop that send part-way (check `lastSend` for the outcome) |

- copilot's `--model` reads the screen once more right before typing `/model`: a dialog is `not-sent` (`prompt-waiting`), an unreadable pane `not-sent` (`recheck-failed`), and nothing is typed.
- The lock is per server process. Two servers sharing one tmux are not ordered by it.

### Finding Worktree IDs

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
# Or disambiguate the same branch across repositories by worktree id prefix:
WT=$(commandmate ls --id anvil- --quiet)
commandmate send "$WT" "Implement this"
```

---

## commandmate wait

Block until the agent in the given worktree completes.

> **Completion means `sessionStatus === 'ready'` on a frame that was classified, or the session
> disappearing** (`src/cli/commands/wait.ts:356`). **It does not check that the turn actually
> landed.** Use `--verify` / `--require-work` (below) to judge whether the work is really there.

### Usage

```bash
commandmate wait <worktree-id> --timeout 300
commandmate wait <id1> <id2> --timeout 600          # Multiple worktrees at once
commandmate wait <worktree-id> --on-prompt agent     # Return on prompt detection (default)
commandmate wait <worktree-id> --on-prompt human     # A human answers the prompt in the UI
commandmate wait <worktree-id> --stall-timeout 120   # Detect "no output change"
commandmate wait <worktree-id> --instance codex      # Wait on the codex session
commandmate wait <worktree-id> --verify              # Run every gate after completion is detected
commandmate wait <worktree-id> --require-work        # Run only work-evidence after completion
```

> **`wait` has no `--agent`** (Issue #1638). Name the target with `--instance`
> (`--instance codex` is that tool's primary instance). Without it, `wait`
> watches the worktree's **default** agent and can report "completed" while the
> codex session you actually sent to is still running.
>
> A single `wait` takes **one** `--instance`, applied to every worktree id in the
> call. Worktrees on different instances need one `wait` each.

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--timeout <sec>` | Maximum time to wait (seconds) | unlimited |
| `--on-prompt <mode>` | What to do when a prompt is detected (agent / human) | agent |
| `--stall-timeout <sec>` | Timeout on "no output change" (seconds) | - |
| `--instance <id>` | Target instance ID (`<agent>` or `<agent>-<n>`). **This is the only way to name the target** (there is no `--agent`) | the agent's primary instance |
| `--verify` | After completion is detected, run every verification gate and let the verdict decide the exit code | off |
| `--require-work` | After completion is detected, run only the work-evidence gate | off |
| `--fail-on-upstream-fault` | Exit **11** instead of 0 when an upstream fault signature is on the screen as the agent returns to its composer (Issue #1839). When the completion's basis is `hook_stop`, the verdict waits for the pane to settle: it is re-read every 500ms until two reads in a row show the same frame (the re-reads use `current-output?fresh=1`, past the server's capture cache; a server older than `fresh` answers from the cache and may read the pane as settled early), for at most 5 s, and a pane still drawing then is judged on the last frame read (a `still drawing` Note on stderr). The agent's `Stop` can land before its reply is drawn (~3 s measured on codex). The settled frame is judged as the next poll, through every check: a prompt drawn meanwhile exits 10, and a turn the agent has started meanwhile is waited on. A fault on the frame of the `Stop` poll is judged on the settled frame too (a fault with no `Stop`, #1839, still exits 11 at once). The settle never passes `--timeout` / `--stall-timeout`: an interval the next re-read could not finish within is not slept (a `would pass --timeout/--stall-timeout` Note), and each re-read is aborted at the earliest of 500ms, what is left of the 5 s bound and those deadlines (a `did not answer a re-read` Note), judging the last frame read: the verdict comes at most 5 s after the `Stop`. The ledger read that checks a fault frame for a `Stop` is bounded by the 5 s bound and `--timeout` as well, and shares that bound with the re-reads: both are counted from the `Stop` poll, so time the ledger takes is taken off the settle (unanswered: no `Stop`, exit 11 at once), and is not made when no `Stop` is on record. The fault diagnosis on stderr is printed only for the frame the verdict is on. A completion that is not `hook_stop`, and `wait` without the flag, do not wait (Issue #3956). `ask` (flag always on) goes through the same wait | off |

### Exit Codes

| Code | Meaning | Next Action |
|:----:|---------|-------------|
| 0 | Completed (and, with `--verify`, verification passed too) | `capture` to get results |
| 10 | Prompt detected (`--on-prompt agent`) | `respond`, then `wait` again |
| 11 | Upstream fault (`--fail-on-upstream-fault`; `ask` always, Issue #1839 / #3011). `id=context-limit` is the context limit: `instances <wt> kill <instance>` for a fresh session, then send again. `id=model-capacity` will not be answered by the same model: send to another instance or model (#3936) | **Do not run `verify`**; wait a while and `send` the same request again |
| 20 | A verification gate failed (`--verify`) | `verify --json` to see the failing gate, then fix it |
| 21 | No work evidence (neither a commit nor an uncommitted change) | The agent never started. `send` again |
| 124 | Timeout | `capture` to check status, then `wait` again or give up |

### --verify / --require-work (Issue #1544)

These raise the success condition of `wait` from "the agent stopped" to "**verification passed**".

- `--verify`: run every gate (work-evidence plus the gates declared in `.commandmate/verify.yaml`)
- `--require-work`: run only the work-evidence gate — a cheap pre-check before spending a full gate run
- Passing both is not an error. work-evidence is always part of the full set, so `--verify` subsumes it
- Verification runs **only when completion was detected**. A prompt (10) or a timeout (124) is returned as-is, unverified
- With multiple worktrees, completion detection is concurrent but verification is **serialized**, because the server caps concurrent runs
- Across multiple worktrees the exit codes are aggregated by the priority **10 > 20 > 21 > 124**

```bash
commandmate wait "$WT" --timeout 1800 --verify
case $? in
  0)  echo "verification passed" ;;
  10) commandmate respond "$WT" "yes" ;;
  20) commandmate verify "$WT" --json ;;   # details of the failing gates
  21) echo "the agent produced nothing" ;;
esac
```

### --on-prompt Modes

| Mode | Behavior |
|------|----------|
| `agent` (default) | Returns immediately with exit 10 on prompt detection, printing the prompt as JSON on stdout |
| `human` | Keeps blocking on prompt detection. Waits until a human answers in the browser UI, then returns 0 / 124 |

### Prompt JSON on exit 10

```json
{
  "worktreeId": "localllm-test-main",
  "cliToolId": "claude",
  "type": "yes_no",
  "question": "Do you want to proceed? [Y/n]",
  "options": ["yes", "no"],
  "status": "pending"
}
```

Since Issue #3755 the exit-10 JSON also carries `observation` (on the exit 10 of all three detection paths — prompt, selection list and unclassified screen, which are the only ones `wait` exits 10 from): the same payload as [`commandmate prompt --json`](#commandmate-prompt), read off the capture the exit was decided on. Exit codes, holds and grace are unchanged. `autoYesSuppression` keeps its meaning (since Issue #3798, when both the record and the server's payload name the waiting episode, the ids decide whatever the record's age; only when either id is missing is a record under a minute old taken; either way a record written before Auto-Yes answered that wait is not its reason and the hold goes on, as the push gate reads it), but do not read the record's time alone as "why nobody answered" — read `pollerRecord` and `contractEvaluation` under `observation.autoYes`. An older server sends no `observation`.

### The `type` field of exit 10

`wait` has three distinct reasons to decide "a human is needed", and **all three return exit 10**.
No new exit code was minted, so callers that already branch on exit 10 (a dispatch runner's
`--auto-yes`, for instance) keep working. Tell them apart with `type`.

| `type` | Meaning | How to answer |
|--------|---------|---------------|
| `yes_no` / `multiple_choice` | The prompt was detected and parsed | `commandmate respond <id> <answer>` |
| `selection_list` | An arrow-key selection UI (Codex's pager and `/model`, antigravity's permission menu, **opencode's permission dialog** (`Allow once / Allow always / Reject`, Issue #1893), Issue #1628). It cannot be parsed into options | Not `commandmate respond` — send the special keys that stand in for arrow keys |
| `unclassified` | **An interactive frame the detection layer could not classify** (Issue #1708). Returned only when `isUnclassifiedActive` has been set for **60 consecutive seconds** | Look at the raw pane: `commandmate capture <id> --pane` |

> **Never answer a `selection_list` with `commandmate respond <id> <number>` (Issue #1893).**
> opencode's permission dialog is an unnumbered button strip, and number keys do nothing on it
> (measured on 1.18.21). A numeric answer is sent as literal text followed by Enter, so what gets
> confirmed is **whichever button is highlighted** (`Allow once` by default) — `respond <id> 3`,
> meant as Reject, approves instead. Use the arrow-key special keys (←/→ then Enter) or the
> NavigationButtons in the web UI.

`unclassified` is the safety net that turns a detection miss into a stop reason of its own. A frame
that slips past the detection layer fires neither auto-yes, nor the contract's `autoYes` policy, nor
exit 10 — so before this existed, nobody noticed until `--timeout` ran out. **It never stops on an
instantaneous value** (a capture taken mid-redraw can raise the flag once); the dwell counter resets
as soon as the frame becomes classifiable.

Under `--on-prompt human` it behaves like the other two types: the reason is printed to stderr and
the wait continues.

A `--timeout` / `--stall-timeout` below 60 seconds always fires first (this dwell check exists to get
ahead of long waits, not to stretch short ones).

#### `ready` does not necessarily mean "complete"

`isUnclassifiedActive` is raised when `sessionStatus=running` and the reason is one of
`no_recent_output`, `unknown_frame` or `default` (no detection rule could read the frame; Issue #2011):

```
sessionStatus=running && reason ∈ {no_recent_output, unknown_frame, default}
```

`no_recent_output` is the reason for a frame whose output has stopped for roughly 5 seconds
(`STALE_OUTPUT_THRESHOLD_MS`), and it is published with `running` (it used to flip to `ready`; that
was abolished so a stalled worker is not called finished). Only a server that predates that change
returns `ready`/`no_recent_output`.

That is why **`wait` makes no completion decision while `isUnclassifiedActive` is set**. Genuine
completion is `ready`/`input_prompt` (the agent is back at the composer), which never raises the
flag and therefore still exits 0 on the first poll. A session that disappeared entirely still exits 0
as before.

#### A turn that stops with background work left is held (Issues #2614 / #3430 / #3451)

An agent can close its turn while background work is still running (a `schedule` timer, a command
sent to the background, a `Monitor`) and report that it will resume by itself once that work finishes
(a `stop` whose `structuredEvents.lastEventDetail` is `self_resume_pending`). Even if the worker looks
finished, `wait` does not report completion then: it **holds that `stop` for up to 30 minutes
(`SELF_RESUME_HOLD_MS`)**.

- While held, stderr shows `ended its turn with background work still running` and the wait continues
  (the final output carries `heldForSelfResume=<seconds>`)
- The hold ends when the agent resumes, opens a new turn and the next `stop` arrives; that `stop` completes the wait
- The 30 minutes are counted from the `stop` (or from this `wait`'s first sight of it, whichever is later).
  If the agent has not resumed by then, `wait` prints `Note: ... completing on that stop` and completes on that `stop`
- Applies to **Antigravity** (Issue #2614) and **Claude** (Issue #3430: an unfinished `run_in_background`
  `Bash`, `Monitor` or background subagent, read from the transcript; when it cannot be determined the `stop`
  counts as complete, as before). The `stop` of any other tool is not held
- `--timeout` / `--stall-timeout` win when shorter than 30 minutes (exit 124 can fire during a hold)

#### Wait with `wait`, not `sessionStatus`, before sending the next request (Issue #3337)

Do not poll `capture --json` and send as soon as `sessionStatus` reads `ready`. `sessionStatus`
includes a reading of a single frame, and it has read `ready` in the middle of a turn (a long codex
0.160.0 turn whose working indicator the detector could not read). Sending then interrupts the
running turn. `commandmate wait <id> --instance <name>` does not complete until the agent itself
reports the end of the turn (`Stop`), so wait with it and then send.

On the server, when codex's hooks speak for the pane (`structuredEvents.source.kind` is `hooks`),
its turn is no longer closed by the screen alone. The screen closes it (`closedBy:
'scraper_evidence'`) only when the `Stop` is known not to come — nothing heard for 30 minutes
(`closedBy: 'stale'`), or a frame that shows the turn was interrupted (`■ Conversation
interrupted`; an interrupt was measured to send no `Stop`). A relay reply waits by the same rule.
Claude and the other tools, and any source without hooks, are still closed by the screen, as
before (a Claude interrupt either prints an `Interrupted` row or just puts the prompt back in the
composer, and neither sends a `Stop`).

#### Do not stack `ask`s on one instance (Issue #3955)

Send the next `ask` (or `send`) to an instance only after the previous `ask` has returned. An agent
can fold a request that arrives while a turn is running into that turn and answer both with one
reply (measured on codex 0.164.0, which shows "Messages to be submitted after next tool call").
The two `ask`s then read the same reply, so **the one sent first can print the answer to the later
request** (or the other way round). Both exit 0, and both requests did arrive intact (this is not
a composer problem).

When `ask` sees such an overlap it keeps the reply and the exit code as they are, prints one
`overlapped: …` line on stderr, and adds `"overlapped": true` to `--json` (the key is absent when
nothing overlapped). A reply marked this way is not necessarily the answer to your request; send
the requests again one at a time if it matters. Two things are detected:

- the instance was already in another turn when the message was sent (the later sender; only for
  tools whose hooks report turn starts, and a turn that ended before the send does not count; it is
  caught even when that turn ended before `ask`'s first poll. The send API's response also says
  whether a turn was open when the message was accepted (`turnOpenAtSend: true`; the key is absent
  when not, or not known), so it is caught even when the server's turn record is replaced by this
  request's own new turn before that first poll (#3957))
- another request reached the instance between the send and the end of the turn (the earlier
  sender; read from the `user` rows of the chat history. The end is the close time the server
  recorded, so the next request sent after the `Stop` does not count, and no `user` row since the
  send is missed even when more than the newest 30 rows came after it)

An `ask` without `--instance` / `--agent` finds the instance its request landed on from the
history and looks only at that instance's rows. Only rows between the send and the end of the turn
are used for that (the same text sent to another instance later does not count). When that cannot
be told (the same text reaching more than one instance in that window, for example), the second
check is skipped.

Relay delivery (`ask --async` / `send --reply-to`) does not detect overlaps; do not stack messages on one instance.

### Progress Output

Progress is written to stderr. Only the final result (JSON) goes to stdout.

```
# stderr:
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Completed: localllm-test-main
```

---

## commandmate prompt

Observe, once and in a machine-readable form, the screen an agent is stopped on (Issue #3755). Use it instead of guessing from `capture --pane`.

### Usage

```bash
commandmate prompt <worktree-id> --instance antigravity          # human-readable
commandmate prompt <worktree-id> --instance antigravity --json   # schemaVersion-tagged JSON
```

Without `--instance` the worktree's default (primary) instance is read. There is no `--agent`.
The payload is `promptObservation` of `GET /api/worktrees/<id>/current-output?observe=1` (present only with `observe=1`).

### Screen kinds (`screen.kind`)

| kind | Screen |
|------|--------|
| `antigravity-trust` | agy's launch-time folder trust screen (`Do you trust the contents of this project?` / `> Yes, I trust this folder` / `No, exit`). `approvalTarget` is the folder |
| `antigravity-model-picker` | agy's `/model` picker (`Switch Model`) |
| `antigravity-permission` | agy's numbered permission dialog (running a command, creating a file). `approvalTarget` is the command block |
| `antigravity-slash-menu` | agy's slash-command popup |
| `composer` | No confirmation (at the input box) |
| `none` | No confirmation (working, not at the input box either) |
| `unknown` | Something waits on a human and no measured reading names it. Check it with `capture --pane` |

The kinds are a vocabulary of their own, separate from `promptData.type` and `sessionStatusReason` (`antigravity_selection_list`, …). Do not make those values a send condition.

To answer a screen only while it is still the one observed, pass its kind and token to [the strict `respond`](#strict-mode-answer-only-the-screen-you-observed---expect-screen-issue-3756).

### Main fields

| Field | Meaning |
|-------|---------|
| `schemaVersion` / `observedAt` | Payload version / when the observation was made (epoch ms) |
| `target` | What the server resolved (`worktreeId` / `cliToolId` / `instanceId` / `sessionName` = the pane / `resolvedBy`) |
| `session.generation` | The agent process generation this server launched (epoch ms); null for one running since before a server restart |
| `status` | `observed` (the screen was read, including when nothing asks) / `unavailable` (no running session) |
| `screen.token` | The observation token. Short-lived (120 s), single use, and bound to the instance, session generation, pane, appearance of the screen, kind, question, options, approval target and highlighted option. Null for `composer` / `none`, for `unknown`, and when the session generation is not known (an agent running since before a server restart). A screen that goes away and comes back with the same words between two observations counts as the same appearance |
| `screen.tokenWithheld` | Why `token` is null: `no-decision` (nothing asks) / `unknown-screen` / `no-session-generation`. Null when a token was issued |
| `screen.appearedAt` | When this appearance of the screen was first observed (epoch ms; bound by the token). Null with no token |
| `screen.question` / `options` / `selectedPosition` / `approvalTarget` | Question, options (1-based), current selection, approval target |
| `screen.answerVia` | How it is answered: `screen` (keys via `respond`) / `api` (a decision) / `strict` (agy's folder-trust screen: answered by `respond --expect-screen`) / `terminal` (`respond` cannot answer it today) / `none` |
| `autoYes.enabled` / `pollerActive` | Whether Auto-Yes is on / whether the server's poller runs |
| `autoYes.pollerRecord` | What the poller (or the permission hook) last recorded as withheld. `screenCorrelation` relates it to this screen; the record names no screen, so it is `unknown` / `type-mismatch` / `no-prompt-on-screen` |
| `autoYes.contractEvaluation` | The contract's policy applied to this screen **now** (`policy-withholds` + reason / `base-withholds` + reason / `policy-permits` / `no-base-answer` / `not-evaluated`). `base-withholds` (Issue #3822) means the base rules withheld the answer before the contract was read, with or without a contract (today only `allow-once-unidentified`; changing the contract does not bring the answer back). Reasons use the `AutoYesSuppressionReason` words ([reason table](#autoyeslastsuppression-observing-a-policy-suppression-issue-1684)) |
| `lastSend` | How the last send to this instance ended (Issue #3759): `{ at, state, reason }`. `state` is `not-sent` (it failed before any key of the body was typed, e.g. `prompt-not-ready`) / `sent` (the submit was confirmed) / `indeterminate` (it failed after part of it may have been typed, or the outcome could not be read back; `reason: composer-residue` when the body is still in the composer). Null when this server has no record since it started; absent from an older server . The `not-sent` reasons include, besides `prompt-not-ready`, those from the input lock (Issue #3945): `input-lock-timeout` (the wait limit passed) / `session-replaced` (the session was recreated while waiting) / `input-lock-lost` (the lock's ownership was lost mid-input), and `recheck-failed` (the re-read just before typing failed); none of them typed any key of the body. The unsent bar's Clear (`POST /api/worktrees/:id/clear-composer`) returns 409 `INSTANCE_INPUT_BUSY` when it cannot get the same input lock or the session was recreated (wait a moment and retry), and returns HTTP 200 with `cleared: false` when the text could not be cleared |

**Whatever `lastSend` says, CommandMate never resends.** The sender — you or the supervising agent — does. Resend a `not-sent` message yourself once the input prompt is back. **Do not resend an `indeterminate` one** before checking the pane with `commandmate capture <worktree-id> --pane` (is the body still in the composer, or was it already submitted?); resending blind can deliver it twice. A `send` that fails with `prompt not ready` and the like carries the same state in its error (`[send state: not-sent (prompt-not-ready): …]`).

**A missing record (`pollerRecord: null`) does not mean Auto-Yes can answer.** A poller that never reached the screen records nothing either (Issue #3746).
`policy-permits` says only that the contract would not stop it; the poller's other gates (the tool-specific dialog reader, …) are not part of it.

### Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | The screen was read (including no confirmation and `unknown`) |
| 21 | No running session (nothing to read) |
| 1 / 2 / 99 | Connection / argument / unexpected errors (99 also for a server too old to send `promptObservation`) |

---

## commandmate respond

Respond to an agent's prompt.

```bash
commandmate respond <worktree-id> "yes"          # Yes/No
commandmate respond <worktree-id> "2"            # Multiple choice (number)
commandmate respond <worktree-id> "text"         # Free text
commandmate respond <worktree-id> "yes" --instance codex     # Specific instance
```

### Strict Mode: Answer Only the Screen You Observed (`--expect-screen`, Issue #3756)

With `--expect-screen <kind> --observation <token>`, the server answers only when a capture it takes **just before
sending** still shows `<kind>` and the observation token printed by [`commandmate prompt`](#commandmate-prompt) still
verifies. Otherwise it sends **nothing** and exits 40.

```bash
commandmate prompt <worktree-id> --instance antigravity --json        # read kind, options, token, approvalTarget
commandmate respond <worktree-id> "Yes" --instance antigravity \
  --expect-screen antigravity-trust --observation <token> \
  --expect-target "<the folder approvalTarget showed>" --json
```

- It goes to its own endpoint, `POST /api/worktrees/<id>/prompt-response/strict`. An older server without it is a
  **stop** (exit 40, `strict_endpoint_missing`); it never falls back to the unchecked `/prompt-response`
- The kinds it answers are `antigravity-trust` (the folder trust screen) and `antigravity-permission` (the numbered
  permission dialog). `antigravity-model-picker` (its effort row is not read), `antigravity-slash-menu` and `unknown`
  are refused before any key
- **While the instance's Auto-Yes is on, `antigravity-permission` cannot be answered strictly** (exit 40,
  `auto_yes_active`): the poller answers the same dialog itself, and an Enter could land on the screen that follows.
  Turn it off first with `commandmate auto-yes <worktree-id> --disable`. `antigravity-trust`, which Auto-Yes never
  answers, can be answered with Auto-Yes on
- A trust screen also requires its **folder (`approvalTarget`) to equal `--expect-target`**. Without
  `--expect-target` nothing is sent and the folder on screen comes back as `observedTarget`. A trust screen whose
  folder could not be read is refused
- `--observation` is the observation token, not the auth `--token`. It is used up before the first key (a send that
  then fails cannot reuse it). After a refusal, observe again with `commandmate prompt`
- Before any key, the fresh capture is checked for: the kind, the token (pane, session generation, appearance of the
  screen, options, highlighted option), the folder, the option the answer names, **the screen being open at the
  bottom of the pane** (no input box under it, `↑/↓ Navigate` at the end — a trust screen quoted in a reply still
  being generated is not answered), and the launch not handling the trust screen itself. The launch's owed Enter
  (#3757) is dropped once the strict respond answers the trust screen, so the two never both answer it
- **This is not a way to get auto mode's permission.** It guarantees only that an answer cannot land on a screen it
  was not meant for; whether the approval may be given is for the user's permission rules. Do not retry an action
  auto mode refused through this flag

#### Answering an Unnumbered Screen

The trust screen numbers no option. Answer with the **option's label**; it is sent only when it matches exactly one
option visible on screen (case and spacing aside; with no exact match, a leading match up to a word boundary —
`Yes` → `Yes, I trust this folder`). What is sent is **Up/Down and Enter**, not text: the screen is read again after
every arrow, and the next key goes only while it is the same screen with the highlight where the keys put it.

- An option number and `--default` are refused (exit 2)
- A label matching two or more options, a screen with repeated labels, and an option outside the visible rows are refused
- On the numbered `antigravity-permission`, an option number works too

#### Outcome and Operation IDs

After the Enter the screen is read for a few seconds and `outcome` says what it did: `advanced` (nothing asks any
more: the input box, or working) / `next-prompt` (another confirmation) / `session-ended` (the session is gone — agy
exits when the trust screen is answered `No, exit`) / `unchanged` (the same screen) / `indeterminate` (unreadable, or
`unknown`). `advanced`, `next-prompt` and `session-ended` are success (exit 0); a screen that stayed is never answered
again automatically.

After an answer that itself exits agy (`No, exit`, the second of the trust screen's two options; a screen in another
order, with another number of options or other wording has none), the tmux session stays up with the shell in it and
the screen reads as `unknown`. When the pane's foreground command is a shell again (`zsh`, `bash`, ...), that is
`session-ended` even though the screen reads as `unknown`. After any other answer (`Yes`, or an answer to a permission
dialog) a shell in front is agy falling over, not the answer, and stays `indeterminate` (exit 41). A read after the
Enter that failed is never overridden: `indeterminate`. A foreground command
that cannot be read, or is still agy, is `indeterminate` too.

Without `--operation-id <id>` a new id is used each time. Ids are kept per worktree and instance (session), together
with what the request asked (kind, answer, token, `--expect-target`). Sending an operation that sent keys (exit 0 / 41)
again with the same id and the same arguments returns the stored result (`replayed: true`) and **sends nothing twice**
(for 10 minutes; a server restart forgets it). The same id with different arguments sends nothing and exits 41
(`operation_id_conflict`). An exit-40 result (nothing sent) is not kept, so the answer can be corrected and sent again
with the same id. When the answer was lost (exit 41, `response_unknown`), re-run with the same `--operation-id` and
arguments to read that operation's result. A server that could not be connected to at all (connection refused, …) never
got the request: exit 40 (`server_unreachable`).

`--json` prints exactly one result object on stdout (`code` / `delivery` (`not-sent` / `partial` / `sent` /
`indeterminate`) / `reason` / `expectedKind` / `observedKind` / `observedTarget` / `operationId` / `answer` /
`keysSent` / `outcome` / `highlightLeftAt`). Explanations go to stderr.

`highlightLeftAt` (`{ position, label }` or `null`) says, for an exit 41 that stopped before its Enter (`delivery:
partial`), where the arrow keys left the highlight, as the last read of the same screen showed it; the `message` ends
with it too. On agy's permission dialog it can be a `(Persist to settings.json)` option, which an Enter at the pane
would then choose. The keys are not walked back. It is `null` when the Enter was sent, when nothing was sent (exit 40),
and when the position is not known (the screen changed, or a key was sent and not read back). A result the CLI makes
itself (`response_unknown`, `server_unreachable`, …) and a result from an older server without the field leave it out.

Who answered (the agent the CLI runs in, `agent:<worktree>/<instance>`, or `cli`), which screen and which option are
recorded in server.log (`strict-prompt-answered` / `strict-prompt-response-refused`) and, once any key was sent, in
the task's history (`prompt_answered_human`, with the reason code when it stopped short). Who answered (`answeredBy`)
is **self-reported** by the CLI from its environment; the server does not verify it.

#### Residual Race

Checking and sending are not atomic. Strict answers to one instance are serialised on the server and the screen is
read again between keys, but a key typed at the pane, or a change on the tmux side, between the last check and the
next key is not seen. A screen that goes away and comes back with the same words between two observations counts as
the same appearance (`screen.token` of [`commandmate prompt`](#commandmate-prompt)).

### Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | Response sent successfully |
| 2 | Argument errors; in strict mode also `--default`, a number on an unnumbered screen, or only one of `--expect-screen` / `--observation` |
| 40 | Strict mode: the screen did not match or could not be checked. **Nothing was sent** (kind, token, folder or label mismatch, capture failure, an older server, …). Observe again with `commandmate prompt` |
| 41 | Strict mode: keys were sent (or may have been) and the result is not confirmed. **Do not send again**; look at the pane. Even at 41, when `reason` is `operation_in_progress` / `operation_id_conflict` nothing was sent (`keysSent` is 0; `delivery` reads `indeterminate` but nothing was sent); fetch the result again under a different ID |
| 99 | Prompt already dismissed (`prompt_no_longer_active`) |

---

## commandmate verify

Run the verification gates declared in `.commandmate/verify.yaml` in the worktree's working
directory, and return the verdict as an exit code.

The server answers a verification request with 202 and a runId only (gates are test suites and
builds, so they take minutes), so the CLI polls every 5 seconds until the run reaches a terminal
status.

### Usage

```bash
commandmate verify <worktree-id>                       # Run every gate
commandmate verify <worktree-id> --gates lint,unit     # Run a subset
commandmate verify <worktree-id> --json                # Print run + gate results as JSON
commandmate verify <worktree-id> --timeout 1800        # exit 124 when exceeded

commandmate verify history                             # List past runs (read-only)
commandmate verify show <run-id>                       # Show one run (read-only)
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--gates <id1,id2>` | Gate IDs to run (comma separated) | work-evidence + every declared gate |
| `--instance <id>` | Agent instance ID to attach the run to | none (a worktree-level run) |
| `--timeout <sec>` | Seconds before polling is abandoned | unlimited |
| `--json` | Print the run and gate results to stdout as JSON | off |

### Exit Codes

| Code | Meaning | Next Action |
|:----:|---------|-------------|
| 0 | Every gate passed | - |
| 20 | A gate failed (failed / timeout / error) | Read the failing gate's logTail and fix it |
| 21 | work-evidence failed (neither a commit nor an uncommitted change) | The agent never started |
| 99 | No verdict possible (invalid verify.yaml, every gate skipped, cancelled) | Check verify.yaml and the working directory |
| 124 | `--timeout` exceeded (the run continues on the server) | Check again later |

`error` / `cancelled` map to 99 rather than 20 so that "could not judge" is never read as
"judged, and it failed".

### Output

Progress (the `GATE` lines) goes to stderr; the verdict (the `RESULT` line) goes to stdout. A
failing gate's logTail follows on stderr. Display is capped at the **last 40 lines** (the excess
collapses into a single `... (+N more lines; run \`commandmate verify show <run-id>\` for the full log)`,
Issue #1683).

The logTail of a failing scope gate contains **the list of violating paths** (up to 100, the excess
as `... and N more`) plus fixed guidance: if the diff was intended, add the paths to the contract's
`scope.allow` (that is, the files the Issue covers) and **re-send** with `send --contract` — scope is
judged against a snapshot taken at send time, so editing the contract YAML alone changes no verdict.

```
# stderr:
Verifying: commandmate-issue-101 (run 42)
GATE work-evidence PASS (commits=3, uncommitted=2)
GATE lint PASS (exit=0, 12.3s)
GATE unit FAIL (exit=1, 45.0s)

# stdout:
RESULT failed
```

### Concurrent Run Conflict (409)

Only one run may be in flight per worktree. If one already is, the command exits with a message
naming the running runId.

```
Error: A verification run is already in progress for 'commandmate-issue-101' (run 41). Wait for it to finish, then retry.
```

### It Does Not Run in the Serving Checkout

`options.skipInPrimaryCheckout: true` in `verify.yaml` marks command gates as `skipped` for the
worktree that matches the server process's own working directory. This prevents `npm run build` from
replacing the build output that is currently being served and breaking the screen.

A run containing a skipped gate ends as `error` (exit 99), not `passed` — so that "did not verify" is
never read as "verified and fine".

### Contract Files Do Not Count as Work Evidence

Everything under `.commandmate/tasks/` is excluded both from work-evidence (commits / uncommitted)
and from the scope gate's change set (Issue #1580). That means a contract may be left in the worktree
**uncommitted and sent straight away** — it never has to be merged into the base branch first. A
worktree holding nothing but a contract stays at `commits=0 uncommitted=0` and exits 21 (no work
evidence).

`.commandmate/verify.yaml` is **not** excluded. The contract itself is snapshotted at send time, so
editing it later cannot change a verdict; but verify.yaml's gate definitions are re-read on every
run, so it stays visible to the scope gate's `deny` if an agent weakens its own gates.

### Reading Verification History (Issue #1593)

List past runs with `verify history` and inspect one with `verify show <run-id>`. Both are
**read-only** and never start a new verification.

```bash
commandmate verify history                             # The last 50 runs across all worktrees
commandmate verify history --worktree <worktree-id>    # Narrow to one worktree
commandmate verify history --days 14 --limit 100       # Narrow by window and count
commandmate verify history --json                      # Print a JSON array
commandmate verify show 42                             # Run 42 in detail (with logTail)
commandmate verify show 42 --json                      # As JSON
```

#### verify history Options

| Option | Description | Default |
|--------|-------------|---------|
| `--worktree <id>` | Narrow to a single worktree | every worktree |
| `--days <n>` | How many days back to look (1..90) | unbounded (only `--limit` applies) |
| `--limit <n>` | Maximum number of runs to fetch (1..500) | 50 |
| `--json` | Print the run array to stdout as JSON | off |

The human-readable output is one run per line. The leading `#<run-id>` is the ID to pass to
`verify show`.

```
#42  2026-07-31T04:12:00.000Z  myrepo-feature-101  manual  failed  failed: unit,build
#41  2026-07-31T03:58:00.000Z  myrepo-feature-101  wait    passed
```

The listing **does not include gate log bodies (logTail)**: returning the log tail of 500 runs every
time would make a listing megabytes long. Use `verify show` when you need logs. There is no
`logTail` field in the `--json` listing at all (it is absent, not `null`).

`verify show` lays out status / exit code / duration per gate and expands the logTail with a `| `
prefix.

```
run #42  failed  worktree=myrepo-feature-101  trigger=manual
started=2026-07-31T04:12:00.000Z  finished=2026-07-31T04:15:20.000Z
baseRef=origin/develop  instance=-  task=-
  work-evidence  passed  exit=0  0.2s
  unit  failed  exit=1  45.0s
    | 2 tests failed
    | expected 1 to be 2
```

#### Exit Codes

`history` / `show` **never return 20 or 21**. Those two mean "the tree in front of you failed
verification", and a query about a past run is not a verdict on the current tree.

| Code | Meaning |
|:----:|---------|
| 0 | Fetched successfully (including zero matches — stderr says `No verification runs found.`, `--json` prints `[]`) |
| 2 | Bad arguments (`--days` / `--limit` out of range, malformed worktree ID, run ID that is not a positive integer). Rejected before any HTTP call |
| 99 | The requested run does not exist (404), or any other unexpected error |

---

## commandmate task

Send an **execution contract** declared in `.commandmate/tasks/<name>.yaml`, and inspect the tasks
that were recorded.

A contract **declares, before the message is sent**, the goal, the paths that may change, the pass
condition, and the Auto-Yes policy. It is embedded verbatim in the message that reaches the agent,
and it becomes the default gate set for `verify`.
The canonical specification is [docs/design/task-contract.md](../../design/task-contract.md).

> The contract of this phase (#1545) is a **declaration**, not an **enforcement**.
> Gating on scope is #1546; enforcing `autoYes` is #1547.

### Sending with a Contract (`send --contract`)

```bash
# Send a contract. There is no message argument (the contract's goal becomes the body)
commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml

# The task id goes to stdout, so it can be captured in a variable
TASK=$(commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml)

# It composes with the existing options
commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml \
  --instance codex-2 --auto-yes --duration 3h
```

The agent receives the contract preamble followed by the goal. The "completion condition" line of
the preamble is written with the **actual commands** resolved from `gates[].command` in
`verify.yaml`.

The preamble is emitted in Japanese, verbatim, by `composeContractMessage()`
(`src/lib/tasks/contract-message.ts`); the sample below is the real output, so it is reproduced
unchanged. The two headings mean "Execution contract" and "Task", and the bullets read: only these
paths may change / commit when the work is done (uncommitted work counts as unfinished) / the
completion condition is that all of these verification commands succeed.

```
## 実行契約
- 変更してよいのは次のパスのみ: src/lib/tasks/**, tests/unit/tasks/**
- 作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）
- 完了条件: 次の検証コマンドがすべて成功すること: npm run lint / npx tsc --noEmit

## タスク
（契約の goal）
```

An invalid contract exits **2** and prints **every** violation (no task is created). A
`verify.gates` entry naming a gate that exists in neither `verify.yaml` nor the contract's own
`verify.gateDefinitions` is rejected here too.

```
Error: invalid task contract:
  - version: must be 1 (got 3)
  - scope.allow: at least one pattern is required while success.requireScopeClean is true
```

### `verify.gateDefinitions`: Gates the Contract Carries Itself (Issue #1791)

`gates` **selects**; `gateDefinitions` **defines**. They play different roles, and the meaning of
`gates` did not change.

```yaml
verify:
  gates: [lint, issue-1234-repro]   # Omit for "every gate"
  gateDefinitions:                  # Optional. Gates valid only for this contract
    - id: issue-1234-repro
      command: "node scripts/repro-1234.mjs"
      timeoutSec: 300               # Defaults to DEFAULT_TIMEOUT_SEC=600
```

**Why the contract carries them.** The only route for an Issue-specific throwaway gate used to be
"the orchestrator rewrites `.commandmate/verify.yaml`". But `verify.yaml` deliberately **stays** in
the work-evidence change set (only `.commandmate/tasks/` is excluded), so a worktree holding nothing
but that edit looks "worked on" and **exit 21 loses its meaning**. Widening the exclusion instead
would hide an agent weakening the gates that judge it. The contract is already snapshotted into
`tasks.contract_json` and already excluded from the change set, so putting the definitions there
**creates no new tampering surface**.

- Shape and validation go through the **same function** as `verify.yaml`'s `gates[]`
  (`validateGateEntries`): the id pattern `^[a-z0-9][a-z0-9-]{0,31}$`, the ban on reserved ids,
  the ban on duplicates within the list, and `timeoutSec` as an integer in 1..7200
- With `gates` omitted, the set is "every gate in verify.yaml **plus** every `gateDefinitions` entry
  of this contract"
- An empty `gateDefinitions: []` means the same as omitting the key (unlike `gates: []`, its reading
  is unambiguous, so it is not an error — an orchestrator generating YAML needs no empty-case branch)
- **Writing `gates` without selecting a gate you defined is a contract error.** The contract is the
  only place that gate is declared, so an unselected definition would **never run** — a check you
  meant to add but did not
- Execution order is **verify.yaml's declaration order, then the contract's**. Issue-specific gates
  run after the repository-wide ones
- Whether the built-in `work-evidence` / `scope` gates run is decided by
  `success.requireWorkEvidence` / `success.requireScopeClean`, **not** by this list
- Maximum 32 entries. `.commandmate/verify.yaml` is **read and never written** — that is the premise
  of the feature

### Use an allow-listed Auto-Yes Policy for Unattended Runs (Issue #1684)

A contract's `autoYes.mode: safe` **only answers `yes_no` prompts automatically**.
On a tool whose dialog gate is `enforce` (claude, codex, copilot, opencode, opencode-v2) it also
**does not answer a `yes_no` the tool's own dialog detector does not vouch for** (Issue #3822: a `(y/n)` quoted in a reply,
or a generic `(y/n)` already open when Auto-Yes was turned on; recorded as `unclassified-frame`).
A tool whose dialog gate is `legacy` (gemini, vibe-local and command-code by default, or a tool an operator set with
`CM_AUTOYES_DIALOG_GATE=<tool>=legacy`) answers a generic `(y/n)` as before; antigravity answers a dialog its hook asked about.
**Claude's edit confirmation (`Do you want to make this edit …?`) is a `multiple_choice` prompt**
(effectively Yes/No plus allow-all, three options), so under `safe` the worker stops on every edit.
Widen an unattended contract to `allow-listed` and escalate dangerous operations with `denyPatterns`.

```yaml
autoYes:
  mode: allow-listed
  allowPromptTypes: [yes_no, multiple_choice]
  denyPatterns: ['rm -rf', 'git push.*--force', 'sudo ']
```

The fact that the policy suppressed an automatic answer shows up in
`autoYes.lastSuppression` of `commandmate capture --json`
(see [JSON Output Fields](#json-output-fields)).

### Recommended Contract Template for Unattended Runs (Issue #1686)

Start unattended worker contracts from this template. It carries the full set — goal, permitted
change scope, pass condition, Auto-Yes policy — and drops straight into the
`send --contract` → `wait --verify` → `capture --json` / `capture --prompts` pipeline for judging
and observing the run.

```yaml
# .commandmate/tasks/issue-123.yaml — recommended contract template for unattended runs
version: 1
title: "Issue #123: <one-line summary>"
goal: |
  Implement https://github.com/<org>/<repo>/issues/123.
  Acceptance: satisfy every item on the Issue's acceptance checklist.
  Commit when the work is done.
scope:
  allow:                              # List the files the Issue covers (an omission fails the scope gate)
    - "src/**"
    - "tests/**"
    - "docs/**"
    - "CHANGELOG.md"
  deny: []
verify:
  gates: [lint, typecheck, unit]      # Gate ids from verify.yaml. Omitted: every gate
autoYes:
  mode: allow-listed                  # safe covers yes_no only; unattended runs want allow-listed (above)
  allowPromptTypes: [yes_no, multiple_choice]
  denyPatterns: ['rm -rf', 'git push.*--force', 'sudo ']
success:
  requireWorkEvidence: true
  requireScopeClean: true
```

```bash
commandmate send <worktree-id> --contract .commandmate/tasks/issue-123.yaml
commandmate wait <worktree-id> --verify          # pass 0 / fail 20 / no work evidence 21
commandmate capture <worktree-id> --json         # watch autoYes.lastSuppression for suppressions
commandmate capture <worktree-id> --prompts      # the audit trail of prompts auto-yes resolved
```

The canonical field specification is [docs/design/task-contract.md](../../design/task-contract.md),
and the design principle behind making verdicts observable is
[docs/design/discoverability-principle.md](../../design/discoverability-principle.md).

### Listing and Inspecting

```bash
commandmate task list <worktree-id>              # Newest first (TSV: id / status / agent / gates / title)
commandmate task list <worktree-id> --limit 5
commandmate task list <worktree-id> --json
commandmate task show <task-id>                  # The contract plus a summary of the last judging run
commandmate task show <task-id> --json
```

### What `status` Means

| status | Meaning |
|--------|---------|
| `pending` | The task row exists but has not been sent |
| `running` | Sent. The agent is working |
| `waiting_input` | Waiting on a prompt (used from Phase 3-1) |
| `verifying` | A verification run is in flight |
| `succeeded` | A verification run came back `passed` |
| `failed` | A verification run came back `failed`, or sending / verifying never completed |
| `not_started` | The verification run came back `not_started` (no work evidence) |
| `cancelled` | Explicitly aborted |

`succeeded` is a verdict only a verification run can hand out. Neither the CLI nor any other client
can report `succeeded` (the API rejects it with 400).

### Interaction with `wait --verify`

`wait --verify` needs nothing extra on the CLI side. **At the moment it starts waiting** it reads the
worktree's active task (the newest of `running` / `waiting_input` / `verifying`) and passes that id
to the verification run that follows. The contract's `verify.gates` becomes the default gate set, and
the result transitions the task.

The id is read **when the wait begins** because an agent that runs the gates itself before reporting
completion (as the contract asks it to) moves the task to `succeeded` with that run. Starting a
verification later from the worktree id alone could not resolve the contract, and **returned `passed`
with an unjudged scope still in it** (Issue #1620). Holding the id from the start means the
contract's scope is judged properly even if the task closes while you are waiting.

Consequently, running `commandmate verify <id>` on its own after the task has reached a terminal
state surfaces the unjudgeable scope in the exit code (the run is `error` = exit 99). The
`GATE scope SKIP` line in the log names **which task could not be judged**, with its id and status. A
bare `commandmate verify` in a worktree that holds no contract at all still passes, as before.

```bash
commandmate send <id> --contract .commandmate/tasks/loader.yaml
commandmate wait <id> --on-prompt human --verify   # pass 0 / fail 20 / no work evidence 21
commandmate task show "$TASK"                      # succeeded / failed / not_started
```

An explicit `verify --gates` wins over the contract.

Contract files are excluded from a verification gate's change set, so they can be sent while sitting
in the worktree, even uncommitted. See
[Contract Files Do Not Count as Work Evidence](#contract-files-do-not-count-as-work-evidence).

---

## commandmate capture

Get the current terminal output from a worktree.

```bash
commandmate capture <worktree-id>                    # Plain text
commandmate capture <worktree-id> --json             # JSON with status info
commandmate capture <worktree-id> --instance codex   # Specific instance
```

### JSON Output Fields

Everything the server sends except `fullOutput` is printed verbatim.

```json
{
  "isRunning": true,
  "isPromptWaiting": false,
  "content": "",
  "realtimeSnippet": "(last 100 rows)",
  "lineCount": 42,
  "lastCapturedLine": 42,
  "promptData": null,
  "promptView": null,
  "autoYes": {
    "enabled": false,
    "expiresAt": null,
    "lastSuppression": null,
    "lastEnterFallback": null
  },
  "thinking": true,
  "cliToolId": "claude",
  "isSelectionListActive": false,
  "isPagerActive": false,
  "isDismissablePanelActive": false,
  "isUnclassifiedActive": false,
  "startingSince": null,
  "statusEvidence": "positive",
  "lastKnownStatus": "running",
  "lastKnownStatusAt": 1754296400123,
  "lastServerResponseTimestamp": null,
  "serverPollerActive": true,
  "sessionStatus": "running",
  "sessionStatusReason": "hook_prompt_submit",
  "lastStopEventAt": null,
  "structuredEvents": {
    "lastEventType": "user_prompt_submit",
    "lastEventAt": 1754296400000,
    "lastEventDetail": null,
    "promptWaitingSince": null,
    "promptWaitingSource": null,
    "source": {
      "cliToolId": "claude",
      "kind": "hooks",
      "capabilities": {
        "supportedEvents": ["stop", "notification", "session_start", "user_prompt_submit", "session_end", "pre_tool_use", "post_tool_use"],
        "configScope": "per-instance",
        "decisionTimeoutSeconds": 5,
        "permissionHookPredictsDialog": true,
        "sessionStartMayArriveLate": false,
        "permissionReplyReleasesPrompt": false,
        "permissionAllowSuppressesDialog": true,
        "eventIdentity": null,
        "resync": "none",
        "transcriptHistory": "pull",
        "stopReportsSelfResume": true
      },
      "probedActivity": null
    }
  },
  "model": "claude-opus-5[1m]",
  "reasoningEffort": null,
  "promptDedup": {
    "skippedCount": 0,
    "lastSkippedAt": null
  },
  "composerText": null,
  "composerState": "empty",
  "agentMode": "accept-edits"
}
```

What each field actually means. The line numbers were measured on 2026-08-20; following the
function names (`buildCurrentOutput` / `isClaudeRunning`) is the safer way to find them (no line numbers are given below; they go stale).

| Field | Meaning |
|---|---|
| `content` | Whatever the poller has not saved yet (`buildCurrentOutput`). **It is a delta only for tools whose line count is a usable cursor** — the scrollback tools (codex / gemini / vibe-local / antigravity) while the 10000-line capture window is unsaturated; there it is empty even on a healthy session once the poller has saved it. For the **alternate-screen tools (claude / opencode / copilot), and for any saturated window, it is the WHOLE capture** (the line count is pinned at the pane height / window size and no longer denotes a read position — Issues #1910 / #1670 / #1268) |
| `realtimeSnippet` | The last 100 rows of the pane — the screen itself. When those 100 rows are all blank (a top-anchored pane such as codex, Command Code), the 100 rows ending at the last row with content instead (#2768). `selectRealtimeSnippetRows` in `src/lib/realtime-snippet.ts` |
| `lineCount` | The row count of the whole capture, blank rows included. A TUI is drawn on a 1000-row pane, so even a blank pane can report 1001 |
| `isRunning` | The tmux session exists and is healthy (`isClaudeRunning` / `isSessionHealthy` in `src/lib/session/claude-session.ts`). **It does not mean a turn is in progress** |
| `sessionStatus` / `sessionStatusReason` | The state and what it rests on: a `hook_*` reason came from hooks, anything else from the scraper (`HOOK_STATUS_REASON` in `src/lib/session/status-mapping.ts`) |
| `promptData` / `promptView` / `promptAnswerable` | The confirmation prompt parsed off the screen, and how it is shown and answered. `promptView` is a reading of `promptData` (Issue #3184): `null` with no prompt, absent from an older server. `promptAnswerable` says whether `/prompt-response` would answer it right now (Issue #2870) and is present **only for a prompt parsed off the screen** — with no prompt, or for the structured (hook / degraded) forms, the key is absent |
| `isSelectionListActive` / `isPagerActive` / `isDismissablePanelActive` / `isUnclassifiedActive` | Flags for the shape of the screen. `isDismissablePanelActive` is a dismiss-only overlay whose footer offers `Esc to close` and nothing else (Issue #2369; disjoint from `isSelectionListActive`). Absent from an older server |
| `startingSince` | Epoch ms at which the agent's launch began, while it is still starting; `null` otherwise (Issue #3179). While it is a number the session is `running` / `starting` and every dialog flag is `false` |
| `promptDedup` | How many times the prompt de-duplication dropped a prompt, `{ skippedCount, lastSkippedAt }` (Issue #1695). `skippedCount` is cumulative for the life of the server process, not per turn. Absent from an older server |
| `statusEvidence` / `lastKnownStatus` / `lastKnownStatusAt` | Whether the verdict rests on positive evidence (`'positive'` / `'none'`), and the last status that was positively confirmed with its time (Issue #1926). `lastKnownStatus` is held in server memory (TTL 30 minutes, cleared on restart, dropped when the session stops) |
| `structuredEvents.*` / `lastStopEventAt` | The last hook event and the last `stop` timestamp. `null` when no hooks have arrived |
| `structuredEvents.turnId` / `openedAt` / `closedAt` / `closedBy` | A provisional turn boundary (Issue #1926). **Not yet a stable turn identity** |
| `structuredEvents.source` | The identifier and **declared** values of the tool's structured-event source (Issue #1924). It describes the source, not the session, so it is present even with no hooks and with the session stopped. `kind` / `liveness` / `degradedReason` / `probedActivity` say whether the source is alive right now (Issue #2054) |
| `structuredEvents.sessionContext` / `sessionDiff` / `session` | Context-window usage (Issue #2042), the files this turn touched with their revert state (Issue #2043), and the conversation the agent says it is in (Issue #2040). `null` for tools that do not publish them |
| `structuredEvents.pendingDecisions[]` | The dialogs the instance is holding (Issue #1930; `kind` / `questionOptions` from Issue #2040) |
| `upstreamFault` | `{id, matchedText, at}` when the screen carries an upstream-fault signature, else `null` (Issue #1839). `id` is `overloaded` / `retrying` / `context-limit` (#3011) / `model-capacity` (codex's `■ Selected model is at capacity` row, #3936) / `limit-reached` / `api-error` (only at a line start: claude's `⏺ API Error: …` or column 0, so a reply that quotes it mid-line or on an indented row does not match, #3946). Judged on the `realtimeSnippet` rows; on codex's split screen (transcript at the top, composer at the bottom) the transcript's last row above them is read too, for `model-capacity` only — `matchedText` then shows a row that is not in `realtimeSnippet` (#3946). **`null` means "no known signature", not "healthy"** |
| `resolvedBy` / `conflict` | Which stage of the server's precedence chain chose `cliToolId`, and a contradiction between the roster and an explicit `--instance` / `cliTool` (Issue #1884) |
| `composerText` | Text sitting **unsent** in the agent's input box, or `null` (Issue #1879). Only text a human typed is returned; a dim suggestion or placeholder never is. `composerState` says why a `null` is `null`. claude / codex only |
| `composerState` | Why `composerText` is what it is (Issue #1879): `content` (real text is there) / `ghost` (only a suggestion or placeholder) / `empty` (the input box is empty) / `unsupported_tool` (this tool's input box has not been measured) / `no_composer` (no input box on the screen — also the answer for a session that is not running) |
| `agentMode` | The agent's permission mode (Issue #2592), read off the screen: `default` / `manual` / `accept-edits` / `plan` / `auto` / `autopilot` / `bypass` / `dont-ask` / `build`, or `unknown` when it could not be read. **`unknown` does not mean "the default mode"; it means "not determined"** — the tool has no mode cycle, the screen shows no mode indicator, or the session is not running. Most tools draw nothing in their default mode, so the absence of an indicator cannot be read as `default` |

To tell whether the screen is empty, **look at `isRunning` first**.

- `isRunning: false` — the session is not running. There is no screen at all, and `realtimeSnippet`
  is an absent key (`lineCount` is `0`). That is a different state from "the screen is empty"
- `isRunning: true` and `(realtimeSnippet ?? '').trim() === ''` — the session is running and its
  screen is empty. Read it together with `lineCount` (a blank pane can still report 1001)

Calling `.trim()` on `realtimeSnippet` directly throws for a session that is not running, because
the key is not there. `content` is a delta, so it never answers that on its own.

**Removed in v0.45.0 (#3395)**: `isComplete` / `isGenerating` / `thinkingMessage` (deprecated in #3394) are no longer returned. Replacements: `isComplete` → `isPromptWaiting` (same value; it actually means "waiting for approval", so the name does not match), `isGenerating` → `thinking`, `thinkingMessage` → `thinking` and `cliToolId`.

**When the session is not running (`isRunning: false`), the fields read off the screen are
absent keys** — not `false`, not `null` (Issue #3300). That covers `autoYes` / `isPromptWaiting` /
`promptData` / `thinking` / `realtimeSnippet` /
`lastCapturedLine` / `isSelectionListActive` / `lastServerResponseTimestamp` /
`serverPollerActive`. With `jq`, state what absence means (`.isPromptWaiting // false`). Auto-Yes
can be enabled for an instance that is not running, so read whether it is on from the `AUTO_YES`
column of `commandmate instances <id>` (or `autoYesByInstance` in `commandmate ls --json`).

#### `model` / `reasoningEffort` (Issue #1785)

The model and reasoning effort the session is running. `null` when nothing knows,
but **the keys are always present**, so `capture <id> --json | jq '.model'` answers
`null` rather than nothing at all.

```bash
commandmate capture <worktree-id> --json | jq -r '.model // "unknown"'
```

- Reported verbatim — the CLI never reformats a model name, so the value can be
  compared directly against what the agent says about itself
- `null` for a session that is not running: the retention layer deliberately never
  expires (an eight-hour turn is on the same model at the end as at the start), so
  the server drops it rather than report a dead process's model
- `reasoningEffort` is `null` for every session until Issue #1784 (effort extraction
  from the terminal frame) lands — no agent puts effort in its hook payload
- **No existing field changed.** `content` / `realtimeSnippet` / `sessionStatus` /
  `sessionStatusReason` are exactly as before

`commandmate instances <worktree-id>` shows the same two values as `MODEL` / `EFFORT`
columns (and as `model` / `reasoningEffort` with `--json`):

```
INSTANCE_ID  ALIAS   CLI_TOOL  RUNNING  AUTO_YES  MODEL              EFFORT  TMUX_SESSION
-----------  ------  --------  -------  --------  -----------------  ------  ---------------------
claude       Claude  claude    yes      no        claude-opus-5[1m]          mcbd-claude-myrepo-x
codex-2      Review  codex     yes      yes       gpt-5.6-sol                mcbd-codex-myrepo-x-2
gemini       Gemini  gemini    no       no                                   mcbd-gemini-myrepo-x
```

> `TMUX_SESSION` (Issue #2317) is the tmux session that instance runs in — the one
> `commandmate attach <id> --instance <instance-id>` opens, and usable directly as
> `tmux attach -t '=<name>:'`. It is **derived** from the roster row (no extra request), by the same
> function `BaseCLITool.getSessionName()` delegates to, so a name printed here is never a name the
> server would not open. The rule is `mcbd-<ns>-<tool>-<worktree>[-<suffix>]` (legacy: `mcbd-<tool>-<worktree>[-<suffix>]`, see "Finding the session name"): a primary instance has no
> suffix, an additional one carries its instance ID with the tool prefix removed (`codex-2` → `-2`).
> The column is appended, so anything reading this table by column position keeps working.

---


#### `autoYes.stopReason`: Why Auto-Yes Stopped

On an instance whose Auto-Yes is off, the reason it stopped, when there is one (otherwise the key is
absent): `expired`, `stop_pattern_matched`, `consecutive_errors`, and **`server-restart`**
(Issue #3730) — the grant was live when the server stopped gracefully (SIGINT / SIGTERM, including
`/rebuild` and `commandmate stop`).

- A restart **never turns the grant back on** (`enabled: false`). The reason stays until the original
  grant's deadline, including across another restart inside it, and goes on `--enable` or `--disable`
- A SIGKILL or a crash records nothing; those grants come back as a plain off
- The same reason reads `off(restart)` in `commandmate ls`, `no(restart)` in `commandmate instances`,
  and "Released by restart" in the UI. On exit 10, `commandmate wait` adds one stderr line naming the
  re-enable command with the waited-on `--instance`

#### `autoYes.lastSuppression`: Observing a Policy Suppression (Issue #1684)

The last time a contract's `autoYes` policy **suppressed** an automatic answer (`null` if it never
did). Suppressions used to appear only in the server log (`poller:auto-yes-suppressed-by-policy`),
which left the CLI unable to explain why a worker was stalled while Auto-Yes was on.

```json
"autoYes": {
  "enabled": true,
  "expiresAt": 1754300000000,
  "lastSuppression": {
    "reason": "type-not-allowed",
    "mode": "safe",
    "promptType": "multiple_choice",
    "at": 1754296400000
  }
}
```

| Field | Meaning |
|-------|---------|
| `reason` | `type-not-allowed` (the mode disallows that prompt type) / `deny-pattern` (a denyPattern matched) / `deny-pattern-unusable` (fail-closed when the patterns could not be evaluated: a pattern that could not be evaluated, or no pattern matched but what was matched is not the whole request — an approval target that begins at the top of a capture that may have been cut, an upward scan that stopped at its 12-row cap or at a `>` row (a here-document's continuation cannot be told from the previous turn's echo), another yes/no prompt inside a yes/no prompt's own block, or a text cut at the 20,000-character limit per field; no `pattern` then. Issue #3881) / `mode-off` / `policy-lookup-failed` (the contract lookup failed; see the table below) |
| `mode` | The policy mode at suppression time (`off` / `safe` / `allow-listed`, or `null` if the contract states no mode) |
| `promptType` | The type of the suppressed prompt (Claude's edit confirmation, for instance, is `multiple_choice`) |
| `pattern` | For the `deny-pattern` reasons, the denyPattern that matched |
| `at` | When it was suppressed (epoch ms). Refreshed on every poll while the suppressed prompt is still on screen |

Reasons other than the policy land in the same field. `partial-answer` (Issue #3706 / #3713 / #3880) means an
earlier answer left input behind, or the outcome of its send could not be confirmed, so Auto-Yes does not type
at the same prompt again and leaves it to a human (`mode` is `null`). The first is an answer stopped after some
of its keys (a `y` before its Enter, for instance) had reached the pane; the second is a send to tmux that ended
without an exit status (a timeout, for instance), where possibly no key arrived at all. A person's answer
(`commandmate respond`, or one given on screen) whose send fails the same way leads to it too (or keeps it).
When a worktree ID move carries the session to a new ID, this carries on under the new ID. `commandmate wait`
prints it as "because an earlier answer left partial input; Auto-Yes is waiting for a human (or that answer's
send could not be confirmed, so the input may hold it: check the pane, then answer; an answer that goes through
releases the hold)" (exit 10 and the JSON `reason` are handled as for any other reason). Check the input before
answering. A person's answer that goes through (or is refused with nothing sent) releases it, and so does the
screen moving to another prompt, the prompt leaving the screen, or the session being relaunched.

The remaining words of the type `AutoYesSuppressionReason` are not policy verdicts either, so `mode` can be `null`. The wording `commandmate wait` prints is quoted alongside.

| `reason` | Meaning | `commandmate wait` prints |
|----------|---------|---------------------------|
| `policy-lookup-failed` (Issue #3822) | Reading the contract (the database lookup) failed, so what the contract states is not known. It is not treated as "no contract" and nothing is answered (the poller sends no keys, and the `PermissionRequest` hook does not return `allow`, leaving it to the ordinary approval dialog). `mode` is `null`. The failure is not cached, so once the lookup works again the next poll follows the contract again (and answers if there is none). The server log line `policy-lookup-failed` carries the failure | "because the server could not read the execution contract (the database lookup failed), so Auto-Yes does not answer until it can; check the server log for policy-lookup-failed" |
| `agent-launch-dialog` (Issue #1829) | The confirmation on screen is a dialog of the CLI's launch sequence (a trust confirmation, for instance); its answer belongs to the tool's own launch sequence, so Auto-Yes does not answer it. If it stays after the launch with the cursor off the safe row (copilot's on `2.` or `3.`, gemini's on anything but `1. Trust folder`; Issue #3790), nobody answers it, so answer it at the pane | "while the agent's launch dialog was on screen; if it stays after the launch (copilot's cursor on 2. or 3., gemini's not on 1. Trust folder), answer it at the pane" |
| `unclassified-frame` (Issue #1924) | The generic estimator read a numbered list, but the tool's own dialog detector did not accept it as a confirmation, so nothing is sent. This is the position that stops answering `1` to a numbered list inside a reply (#1896) | "because no tool-specific dialog detector recognised the frame" |
| `startup-trust-unhandled` (Issue #3757) | agy's startup folder-trust confirmation (`Do you trust the contents of this project?`) is on screen. It belongs to the launch sequence and is unnumbered, so the poller cannot read it as a prompt. If it was drawn after the launch window ended, the next send's readiness wait answers it | "because agy's startup folder-trust confirmation is the launch's to answer, not Auto-Yes's; the next send confirms it once, or answer it at the pane" |
| `question-confirm-page` (Issue #3748) | The `AskUserQuestion` confirm page (`Submit` / `Cancel`) of Command Code and Claude. `Submit` picks nothing; it commits the answers as they stand, so Auto-Yes does not answer and leaves it to a human | "because the question's Submit/Cancel confirmation commits the answers as they stand, so Auto-Yes leaves it to a human" |
| `question-left-to-human` (Issue #3822 / #3863) | A question the tool asks the operator is on the pane and the answer mode is `careful`, so nothing is sent (claude's `AskUserQuestion` picker and command-code's question). OpenCode V2's question form is withheld under this reason in either mode. Not a contract verdict, so naming `multiple_choice` in `allowPromptTypes` does not make it answered. Neither `CM_AUTOYES_DIALOG_GATE=<tool>=legacy` (the kill switch) nor a tool whose dialog gate is `legacy` by default (command-code and others) changes it: under `careful` the question is withheld (Issue #3863 took the question reading off the dialog gate). Copilot's question (`ask_user`) and codex's (`request_user_input`) carry no question marker on screen, so under `careful` a copilot / codex numbered list whose rows do not read as permission wording (the measured `Yes` / `Allow` and so on) is withheld under this reason as possibly a question (answered as before under `recommended`; Issue #3881). The `Submit` / `Cancel` confirm page after a question stays `question-confirm-page`. Under `recommended` a question is answered with its recommended option ([Answer Modes](#answer-modes-recommended-and-careful-issue-3863)) | "because the agent is asking a question, and Auto-Yes answers permissions only (the careful answer mode, or a question form no mode answers); answer it at the pane (prompt --json, respond), or turn Auto-Yes on with --answer-mode recommended to have it pick the recommended option" |
| `allow-once-unidentified` (Issue #3822) | A permission dialog is on screen, but no single option reads as "allow this call only" (there is none, or there are two or more), so nothing is sent. Auto-Yes picks only the allow-once option, and sends its number wherever the cursor or the default is. It never picks a persistent allow (`don't ask again`, `always allow`, `Persist to settings.json`, …), a mode change (`allow all edits`, `Full Access`, …) or a denial. The options are read from the wording of live captures of claude, codex, agy (antigravity), command-code and copilot; a numbered list none of whose rows is recognised is answered as before (the default option, or 1). Not a contract verdict, so `mode` is recorded as the contract states it, and `autoYes.contractEvaluation` in `commandmate prompt --json` is `base-withholds`, not `policy-withholds` | "because no single option of the permission dialog allows this call only (the others save a rule, change the permission mode, or deny); Auto-Yes does not pick those, so answer it at the pane (prompt --json, respond)" |
| `recommended-option-unidentified` (Issue #3863) | The answer mode is `recommended` and a question is on the pane, but which option to answer with cannot be told, so nothing is sent: two or more options are recommended (a title ending in `(Recommended)` / `（推奨）` / `(推奨)`), an option's title cannot be told from its description, the option to pick takes typed text, or the question is multi-select. Not a contract verdict (a withholding of the base rules). `autoYes.contractEvaluation` in `commandmate prompt --json` reads the same screen under the same mode and reports `base-withholds` with this `reason` too (and `base-withholds` with `question-left-to-human` for a question under `careful`). Judged again on every poll | "because the question's recommended option could not be told (two or more marked recommended, a title it could not tell from its description, a typed-text or multi-select answer); answer it at the pane (prompt --json, respond)" |
| `no-hook-receipt` (Issue #3767) | agy's approval dialog is on screen but there is no matching hook question (`PreToolUse`) on record: (1) none was ever received, (2) the dialog appeared after the window (8 s) from the last one, (3) the dialog was already up before the question arrived (a quotation in a reply, for instance), (4) the questions stopped arriving, (5) the question was already spent on an earlier dialog, or (6) a dialog is still up 18 s (window + observation slack + post-answer cooldown) after Auto-Yes sent keys to the one its question was for — the keys did not clear it, or a dialog with no question of its own replaced it (Issue #3789). Even if sending is cut short part-way, the grace (18 s) is counted from that point, and if the confirmation remains after it has passed, it is recorded as no-hook-receipt. Part of the keys may remain in the input. However, if a more specific suppression reason (partial-answer) was recorded after the interruption, that reason is kept and it is not recorded as no-hook-receipt. The `hint` of the server log line `antigravity-autoyes-withheld-no-hook-receipt` tells them apart. **When it stalls**: `commandmate auto-yes <worktree-id> --disable`, then `commandmate prompt <worktree-id> --json`, then `commandmate respond <worktree-id> --expect-screen …` (or answer in the UI). If no question was ever received or they stopped, check where `~/.gemini/config/hooks.json` points | "because there is no unused agy hook permission question for this dialog (none arrived in time, or the last one was spent on keys that did not clear it); answer it yourself (auto-yes --disable, prompt --json, respond --expect-screen) or check hooks.json" |

In [`commandmate prompt --json`](#commandmate-prompt), `autoYes.pollerRecord` (the poller's record) and `autoYes.contractEvaluation` (the contract re-evaluated now) are separate fields, but both use the same words as this table and the `reason` row above.

If `isPromptWaiting: true` and `lastSuppression.at` is recent, that session is **stalled on a policy
suppression right now**. Either answer it as a human with `commandmate respond`, or revisit the
contract's `autoYes` (when `mode: safe` is suppressing `multiple_choice`, switching to
[allow-listed](#use-an-allow-listed-auto-yes-policy-for-unattended-runs-issue-1684) is recommended).

#### `autoYesDecision`: What Auto-Yes Is Doing About the Confirmation (Issue #3821)

The `current-output` response (`capture --json`) carries Auto-Yes's decision about the `promptData` of the same response.

```json
"autoYesDecision": {
  "state": "withheld",
  "reason": "server-poller-inactive",
  "observedAt": 1754296400000,
  "confirmation": "3f1c…"
}
```

| `state` | Meaning |
|---------|---------|
| `answering` | The server's poller is answering this confirmation (sending, or sent and the screen not redrawn yet) |
| `withheld` | Auto-Yes left this confirmation to a human; `reason` says why (the words of the table above, plus `server-poller-inactive` = Auto-Yes is on but no poller runs for this instance (the concurrent limit, for one), `no-auto-answer` = the base rules have no answer (typed text, a checkbox list), `answered-by-human` = for about 10 seconds after a person began answering from the panel, `foreign-session` / `moved-send-in-flight`) |
| `none` | No confirmation, Auto-Yes off, or not judged yet. Never read as `answering` |

The decision is what the poller actually judged, and it carries over none of: enabling Auto-Yes again (OFF→ON with the same screen up, or an expiry), a session relaunch, another confirmation, a person's answer (it reads `none` until the next judgement). Whether it is another confirmation is judged on the question and the options, plus what is being approved (`approvalTarget`, compared as read except for where the cursor sits on the option rows: the body's indentation, `>` and blank rows count, so two commands that differ only by indentation are two confirmations) and, for agy, the hook call. A reading whose approval target cannot be compared to its end (cut from the top, fewer rows) is not taken for the same confirmation, even under the same agy hook call, and reads `none` (the rows left may not tell it from another confirmation that differs only in its file name; this only shows the answer panel and does not change what is sent automatically). When the match cannot be confirmed otherwise it reads `none` too. `confirmation` names the confirmation the decision is about (an opaque key: readings the server judges to be the same confirmation carry the same value, and different values are different confirmations; the same screen read with a different number of rows gives a different value; `null` with no prompt). The PC screen keeps the later of two decisions only when they carry the same `confirmation`, and carries no decision over to another confirmation. While the duplicate guard waits after a send, `answering` stands only for the confirmation that was sent to. Two confirmations with the same text in a row, with no screen without a confirmation between them, cannot be told apart from the screen alone. The field is absent when the session is not running.

With Auto-Yes on, the PC and phone answer panels are shown whenever `state` is not `answering` (and for a response from an older server without the field). A question OpenCode / V2 asks over its API always shows its panel under Auto-Yes. Answering by hand leaves Auto-Yes on.

`commandmate wait` reports a `withheld` prompt at once instead of holding it for the Auto-Yes grace (`--auto-yes-grace`), with `auto-yes is not answering this prompt (reason=…)` on stderr. The prompt Push notification still arrives after its grace, as before.

#### `autoYes.lastEnterFallback`: An Enter on an Unreadable Choice Screen (Issue #3397, retired in Issue #3821)

The single Enter Auto-Yes sent to a choice screen CommandMate cannot read is **retired** (Issue #3821): a bare Enter confirms whatever happens to be selected, and on a screen nothing can read, nobody can check what that is. Setting `CM_AUTOYES_ENTER_FALLBACK` does not bring it back. Such a screen is answered by a person under Auto-Yes too (`lastSuppression.reason` is `unclassified-frame`, `autoYesDecision` is `withheld`).

The `autoYes.lastEnterFallback` field stays for compatibility and is always `null`. Past `[Enter]` answers in the audit log and the History, and the `enter-fallback` basis in the Auto-Yes measurement log, still read as they were.

### `--pane`: Reading the Transcript (Issue #1623)

Without `--pane`, `capture` returns "what the agent has accumulated in its current answer", so it is
**an empty string while the session is idle**. Use `--pane` when a human wants to read what is on the
screen.

```bash
commandmate capture <worktree-id> --pane              # Transcript with blank lines collapsed (paged on a TTY)
commandmate capture <worktree-id> --pane --tail 40    # Only the last 40 lines
commandmate capture <worktree-id> --pane --raw        # The raw pane, uncompressed
commandmate capture <worktree-id> --pane --json       # JSON with line counts before and after compression
commandmate capture <worktree-id> --pane --instance codex-2
commandmate capture <worktree-id> --pane --follow     # Follow along (Ctrl-C to stop, Issue #2317)
```

- **`--tail N` counts the last N lines *after* compression.** A TUI session is drawn on a 200x1000
  canvas and the blank space collects **between** the transcript and the composer, so the tail of a
  raw frame is mostly empty lines (measured: 4 readable lines in the raw last 20, 13 in the
  compressed last 20)
- When stdout is a terminal, output is paged through `CM_PAGER` → `PAGER` → `less -R`. Pipes and
  redirects get the plain text, so `| grep` and `> file` keep working
- The number of lines fetched is always 1000 (there is no `--lines`). It stays identical to what the
  detection layer asks for, so the server does not behave differently just because a human is reading
- **Neither an attach nor tmux 3.2+ is required**, which makes this the fallback where `prefix + g`
  (below) is unavailable

### `--pane --follow`: Following a Reply as It Is Generated (Issue #2317)

`--pane` is a snapshot. Add `--follow` to **watch** a reply being generated: the screen is cleared and
redrawn on an interval, and `Ctrl-C` ends it.

```bash
commandmate capture <worktree-id> --pane --follow                  # 2000ms interval by default
commandmate capture <worktree-id> --pane --follow --interval 1000  # 250-60000ms
commandmate capture <worktree-id> --pane --follow --tail 40        # Follow only the compressed last 40 lines
```

- **No tmux client and no key binding are needed.** That is what makes this the answer under
  `tmux attach -r` (read-only), where `prefix + g` does **not** work: tmux delivers no keys but the
  detach one to a read-only client, so the popup cannot open (measured)
- Anywhere that is not a terminal (a pipe, a redirect) it errors out. Loop over `--pane --tail N`
  there instead
- It cannot be combined with `--json` or `--raw` — both mean "give me the bytes", which has no meaning
  for a screen overwritten every two seconds
- **The session's geometry never changes.** Nothing about reading touches the window

### `--prompts`: The Audit Trail of Resolved Prompts (Issue #1685)

When auto-yes answers a prompt within `wait`'s polling interval, `wait` never exits 10 and
`promptData` in `capture --json` is already `null`. `--prompts` reads the prompt messages out of the
chat history, so **what was asked and what was answered can be recovered after the fact**.

```bash
commandmate capture <worktree-id> --prompts                    # The last 20, as text
commandmate capture <worktree-id> --prompts --limit 5          # The last 5
commandmate capture <worktree-id> --prompts --json             # As JSON
commandmate capture <worktree-id> --prompts --instance codex-2 # Narrowed to one instance
```

JSON output (`prompts` is oldest first):

```json
{
  "worktreeId": "myrepo-feature-x",
  "count": 1,
  "prompts": [
    {
      "id": "…",
      "timestamp": "2026-08-04T10:00:00.000Z",
      "cliToolId": "claude",
      "instanceId": "claude",
      "type": "yes_no",
      "question": "Allow tool use?",
      "options": ["yes", "no"],
      "status": "answered",
      "answer": "yes",
      "answeredAt": "2026-08-04T10:00:02.000Z",
      "answeredBy": "auto"
    }
  ]
}
```

- **`answeredBy` names who answered**: `auto` (the server-side auto-yes), `human` (an explicit answer
  through the respond API or the chat UI — before Issue #3821 the browser-side auto-yes fallback counted as `human` too),
  or `terminal` (a sweep record inferring that somebody answered directly in the terminal). Rows
  resolved before this feature landed are `null`
- It cannot be combined with `--pane` (`--prompts` reads history, `--pane` reads the current screen)
- `--limit` is capped by the server's history limit (1000)

#### Frames That Could Not Be Classified Are Recorded Too (Issue #1708)

**The failure to detect is itself a fact worth recording.** Both write paths used to be gated on
`isPrompt === true`, so a dialog that slipped past the detection layer was stored nowhere and "why
did it stop" could only be answered by looking at the raw pane — and only until the screen scrolled.

When `isUnclassifiedActive` stays set for 60 consecutive seconds, exactly one row is recorded (the
row does not multiply per poll while the frame persists). **It is rendered differently so it never
blends in with detected prompts**:

```
2026-08-06T12:00:00.000Z  claude/claude  [unclassified:detection-failed]
  Q: Unclassified interactive frame (running/default) held for 60s. …
```

- In `--json` it is identified by `"type": "unclassified"` / `"status": "unclassified"`
- Because `status` is not `pending`, the `markPendingPromptsAsAnswered()` sweep never marks it
  answered (a frame nobody could read never gets an `answered` stamp)
- It cannot be answered. Look at the raw pane with `capture <id> --pane`
- **Recording only happens while somebody is observing.** The write goes through the payload assembly
  of `current-output`, so it needs `wait` to be polling, a terminal open in the browser, or a
  `capture --json` call. **The server-side Auto-Yes poller alone does not record it.** That a stall
  nobody waited on leaves no trace is deliberate: the stall this feature exists to explain — one where
  something was waiting — is always under observation

---

## commandmate reply

Prints the **latest reply** an instance wrote, read from the chat ledger rows the transcript readers write (Issue #3039).
Use it to read the answer to a turn you did not send with `ask` (for example a supervisor's "stop and report" nudge)
without knowing where the tool keeps its transcript file.

### Usage

```bash
commandmate reply <worktree-id> --instance cc-1                                  # Reply body
commandmate reply <worktree-id> --instance cc-1 --since 2026-09-30T12:00:00Z     # Only a reply at or after this time
commandmate reply <worktree-id> --instance cc-1 --json
```

### Rules

- Only rows a transcript reader wrote (`<tool>-turn:<id>`) count as a reply. `ask` reads through the same shared function,
  so both mean the same thing by "reply". Furniture rows (`relay-sys:` / `model-changed:`) are skipped; ANSI and control
  characters are stripped
- Tools with a transcript reader: claude / codex / antigravity / command-code / opencode. Any other tool always reports
  "no reply"
- **The pane is never read**: a screen line cannot be attributed to a turn (the nudge's own echo is on it)
- `--since` takes ISO 8601 and returns only a reply written **at or after** that time. `--instance` / `--agent` resolve as in `ask`

### Output and exit codes

| State | stdout | stderr | exit |
|-------|--------|--------|------|
| A reply exists | Body | Nothing | 0 |
| No reply (no transcript row yet, or none after `--since`) | Empty | One line | 0 |
| Server unreachable, etc. | Empty | Error | Same as the other CLI commands |

`--json` prints `{ worktreeId, instanceId, cliToolId, reply, requestId, at }`; with no reply, `reply` / `requestId` / `at` are `null`.

---

## commandmate attach

Attach **this terminal** to the tmux session a worktree's agent is running in (Issue #2317).

### Usage

```bash
commandmate attach <worktree-id>                      # the worktree's default agent
commandmate attach <worktree-id> --instance codex-2   # a specific instance's session
commandmate attach <worktree-id> --read-only          # look without sending any input
commandmate attach <worktree-id> --live               # re-lay out to this terminal (claude only)
```

### Why this and not a bare `tmux attach`

Three separate things go wrong when you attach by hand, and this command absorbs each of them.

| Attaching by hand | This command |
|---|---|
| The session name `mcbd-<ns>-<tool>-<worktree>[-<suffix>]` (a legacy session keeps `mcbd-<tool>-<worktree>[-<suffix>]`) has to be assembled yourself, and `<ns>` lives in the server's DB, so it cannot be computed locally | Uses the name the server **actually uses** (`agentInstances[].sessionName` on `GET /api/worktrees/<id>`, adopted legacy sessions included). Against an older server that sends no `sessionName`, the legacy name is assembled |
| `tmux attach -t =mcbd-…:` is **eaten by zsh's equals expansion and fails with `not found`** (measured). The `'=mcbd-…:'` quoting is mandatory | The target is passed as argv with no shell in the path, so the quoting problem cannot arise |
| For an alternate-screen agent (claude / opencode / copilot) you see **nothing but blank space and the input box**. It looks broken; it is the 1000-row canvas | A hint on stderr before attaching says why, and names three ways to read anyway |

When the session does not exist it exits non-zero and points at `commandmate ls` /
`commandmate instances <id>`.

When `$TMUX` is set (you called it from inside tmux) it uses `switch-client` instead. If the current
client is on a **different tmux server** and cannot switch, it prints the quoted
`tmux attach -t '=mcbd-…:'` and exits non-zero.

When the session under that name belongs to **another CommandMate server** (the server answers 409
`session_owned_by_other_server`), it changes course so that no key reaches it (Issue #3334):

- A plain attach is **made read-only (`-r`)**, and says so on stderr. You can look; nothing you type
  arrives
- `--live` would change the other session's geometry, so it **does not attach** and exits non-zero
- From inside tmux, `switch-client` has no read-only form, so it **does not switch**; it prints
  `tmux attach -r -t '=mcbd-…:'` to run outside tmux and exits non-zero

The server's answer only counts when it is about **the very name being attached**. When the roster
cannot be read and the name falls back to the legacy form (`mcbd-<tool>-…`), the server checks the
namespaced name, so its answer is about a different session (both names can exist at once). That is
treated as **ownership not confirmed**: the attach is made read-only as above, and `--live` and the
switch from inside tmux are refused. No ownership answer at all — any non-2xx such as a 404, a
stopped server, or an older server with no ownership check — is treated the same way. Only a session
the server **confirms as its own** gets an attach that can send keys.

When `send` / `capture` / `respond` and the other commands get the same 409, they exit with a message
saying the session is another CommandMate server's and nothing was sent to it, read from it or stopped
(the exit code is the one a 409 always had, 99).

### Finding the session name

```bash
commandmate ls --json | jq -r '.[] | "\(.id)\t\(.tmuxSession)"'   # the worktree's default agent
commandmate instances <worktree-id>                                # every instance (TMUX_SESSION column)
```

A session name comes in two forms (Issue #2866 / #2867):

- **Namespaced** `mcbd-<ns>-<tool>-<worktree>[-<suffix>]` — `<ns>` is a per-server namespace (8 hex
  digits), so two CommandMate servers with the same worktree ID never share a session name
- **Legacy** `mcbd-<tool>-<worktree>[-<suffix>]` — a session that predates the namespace and was
  adopted by the server

`tmuxSession` in `ls --json` is built from the `tmuxSessionNamespace` that `GET /api/worktrees`
returns, as a **list-wide approximation**: a legacy session the server adopted is still printed under
its namespaced name (`ls` makes no per-worktree request). `commandmate attach` asks the server for
the name it actually uses, so it opens the right session in either form. Keep the CLI and the server
on the same version — an older CLI cannot build the namespaced name.

### `--live`: borrow this terminal's size while attached (claude only)

With `--live` the window **follows this terminal's size** for as long as you are attached
(`window-size latest`). The TUI re-lays out, so **a plain attach shows the transcript**. On detach it
goes back to 200x1000 and `manual`.

```bash
commandmate attach <worktree-id> --live
# From another terminal:
tmux display-message -p -t '=mcbd-claude-<worktree-id>:' '#{window_width}x#{window_height}'
tmux show-window-options -t '=mcbd-claude-<worktree-id>:' -v window-size
```

- **claude only.** Any other agent is refused. Two reasons — where the reply text comes from, and
  the width the detection rules were measured at: claude writes History from its transcript JSONL, so
  a smaller frame during delegation loses no reply text. copilot / gemini / vibe-local have no source
  for a reply except the pane; codex / antigravity / command-code have detection rules measured only
  at 200x1000; and opencode paints a sidebar into the transcript rows at 121 columns and wider (#2047)
- While delegated the session carries `@cm_delegated=1`, and the server **does not save a reply
  scraped off the pane** for the duration (History is written from the transcript instead).
  `send` / `wait` / Auto-Yes keep working as usual
- There are three ways back: the CLI, when it returns from the attach; the server's status poll, when
  it finds a session delegated with zero human clients; and by hand
  (`sh ~/.commandmate/bin/cm-live-restore.sh <session>`). **A control-mode client — CommandMate's own
  connection — does not count as a human**, so your detach restores the canvas even while one is
  still attached
- While delegated, the browser's terminal view shows the smaller frame too

> **No `client-detached` hook is used.** Measured on tmux 3.5a: a session-scoped `client-detached`
> hook **never fires** (a global one does, but `#{session_name}` then names a different session and
> `#{client_control_mode}` is empty). The restore runs from the server's poll instead, which also
> covers the CLI being killed, the terminal window being closed, and a detach from another client.

### Delegating on a hand-rolled attach (opt-in)

Start the server with `CM_LIVE_ATTACH_HOOK=on` and a session-scoped `client-attached` hook is
installed on claude sessions, so **a plain `tmux attach` delegates too**. Off by default: a bare
`tmux attach` silently changing a session's geometry is the behaviour #2317 決定事項 1 forbids.

### Reading the State From tmux (Issue #2317 Phase B)

The server writes a session's state onto that session whenever it **changes**, so running / waiting /
ready / idle can be read from `tmux ls` without attaching at all.

```bash
# Every CommandMate session and its state
tmux ls -F '#{session_name} #{@cm_status} #{@cm_tool}/#{@cm_instance} #{@cm_worktree}'

# Just one session
tmux show-options -v -t '=mcbd-claude-<worktree-id>:' @cm_status
```

| User option | Meaning |
|---|---|
| `@cm_status` | `idle` / `ready` / `running` / `waiting`. **The same vocabulary as `commandmate ls`'s STATUS column** (it comes from the same function) |
| `@cm_worktree` | Worktree ID |
| `@cm_tool` | Agent (`claude`, …) |
| `@cm_instance` | Instance ID |
| `@cm_updated` | When it was last written (ISO 8601) |
| `@cm_delegated` | `1` only while `--live` has delegated the geometry |

While attached it also shows on the right of the status line:
`[CommandMate claude/claude waiting] 200x1000`.

- **Written on a transition only.** No `set-option` is issued per poll
- **Everything is session-scoped** (`set-option -t`). The global `status-right` / `status-left` / key
  table do not change. #1623's `bind-key` remains the one and only global intervention
- **A `status-right` you set on that session yourself is never overwritten** (if a session-scoped
  value comes back, nothing is written)
- `@cm_status` never says `exited`. In `ls` too, `exited` is a REASON and not a STATUS — the STATUS
  beside it is `idle` (#2070). Matching `ls`'s vocabulary is the requirement that wins here

To turn it off, set `CM_TMUX_STATUS=off` and restart. **The next poll then REMOVES the `@cm_*`
options and CommandMate's `status-right` from each session** — it uninstalls rather than merely
stopping.

---

## Read Mode: Reading the Transcript While Attached (Issue #1623)

A CommandMate session is pinned to a canvas of 200 columns x **1000 rows** (#1163). tmux keeps the
cursor in view, and the cursor sits around row 997, so `tmux attach` shows **nothing but blank space
and the input box — not one line of the transcript you wanted to read**. Typing still works today;
the broken half is reading.

### `prefix + g` (read inside tmux)

While attached to a CommandMate session, pressing `prefix + g` (by default `Ctrl-b` followed by `g`)
opens the transcript, with blank lines collapsed, in a popup. `less` search and scrolling work as
usual, and `q` closes it and returns you straight to typing. No window is resized.

```bash
# Quote the session name with a leading `=` (to defeat zsh's equals expansion)
tmux attach -t '=mcbd-claude-<worktree-id>:'
```

- **The popup content is a snapshot.** It does not follow along as output is generated.
  Press **`prefix + g` again** to refresh it
- It can also be run by hand:
  `sh ~/.commandmate/bin/cm-read-pane.sh mcbd-claude-<worktree-id>`

### Installation, Configuration, Disabling

The key binding is installed automatically when the server starts. Because a tmux **key table is
shared across the whole tmux server**, **no binding is installed at all** in any of the following
cases (your tmux is left untouched).

| Condition | Behavior |
|-----------|----------|
| tmux has no `display-popup` (older than 3.2) | Not installed. Use `capture --pane` |
| The key is already bound to something else | Not installed (nothing is overwritten). Choose another key with `CM_READ_MODE_KEY` |
| Pressed in a session that is not CommandMate's | Nothing happens (guarded on the `mcbd-*` session name) |

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `CM_READ_MODE` | (enabled) | `off` / `0` / `false` disables it. **On the next server start, the previously installed binding is removed** |
| `CM_READ_MODE_KEY` | `g` | The key that follows the prefix. One alphanumeric character or `F1`–`F12`, optionally with a `C-` / `M-` / `S-` modifier |
| `CM_READ_MODE_FOLLOW` | (off) | `on` makes `prefix + <key>` open the **following** popup (Issue #2317, below) |
| `CM_READ_MODE_AUTO_POPUP` | (off) | `on` opens the following popup **automatically when a human attaches** (Issue #2317, below) |
| `CM_READ_LINES` | `1000` | How many lines the popup looks back (script side) |
| `CM_READ_FOLLOW_INTERVAL` | `2` | Redraw interval of the following popup, in seconds (script side) |
| `CM_READ_PAGER` | `less -R +G` | The pager used inside the popup (script side, snapshot mode only) |

### The Following Popup (Issue #2317 Phase C)

Start the server with `CM_READ_MODE_FOLLOW=on` and `prefix + g` opens a **following** popup: a redraw
loop instead of `less`, closed with `q`. The composer is typeable the instant it closes.

- **No second key was added.** Issue #2317 allows either a separate key (default `G`) or a switch;
  `bind-key` writes the tmux server's **global** key table, so a second binding would double the one
  global intervention 決定事項 2 exists to minimise. An environment variable costs no key table at all
- **The window is not resized.** A popup is per-client and leaves nothing behind when it closes
- It can be run by hand too:
  `sh ~/.commandmate/bin/cm-read-pane.sh --follow mcbd-claude-<worktree-id>`

### Opening It Automatically on Attach (opt-in, Issue #2317 Phase C)

Start the server with `CM_READ_MODE_AUTO_POPUP=on` and a session-scoped `client-attached` hook is
installed on CommandMate sessions, **opening the following popup when a human client attaches**.

- **Off by default.** The popup owns the keyboard until `q` is pressed, so opening it unasked turns
  "I attached" into "I cannot type"
- **It never opens for a control-mode client** (CommandMate's own connection). Measured: a
  session-scoped `client-attached` hook does not fire for a control-mode client at all, and the script
  checks `#{client_control_mode}` on top of that

> **Stopping the server does not remove the binding.** `commandmate start --issue N` lets several
> servers share one tmux server, so removing on one server's shutdown would steal the other's key.
> To remove it, set `CM_READ_MODE=off` and restart.

---

## commandmate auto-yes

Control auto-yes (automatic prompt response) individually.

```bash
commandmate auto-yes <worktree-id> --enable --duration 3h
commandmate auto-yes <worktree-id> --enable --stop-pattern "error"
commandmate auto-yes <worktree-id> --disable
commandmate auto-yes <worktree-id> --enable --instance codex-2  # Scoped to one instance
commandmate auto-yes <worktree-id> --enable --answer-mode careful  # Questions are yours (careful)
```

### Options

| Option | Description |
|--------|-------------|
| `--enable` | Turn Auto-Yes on |
| `--disable` | Turn Auto-Yes off |
| `--duration <d>` | How long it stays on (`1h`-`24h`, whole hours; e.g. `1h` / `3h` / `8h`; default `1h`). Lower-case `h` only; `01h`, `1.5h`, `90m` and the like exit 2 |
| `--stop-pattern <p>` | Stop automatically when the pattern appears in terminal output |
| `--answer-mode <m>` | The answer mode (`recommended` / `careful`; see [Answer Modes](#answer-modes-recommended-and-careful-issue-3863) below). With `--enable` only. Omitted: `recommended` for a new grant, the current mode for a grant that is on (Issue #3863) |
| `--instance <id>` | **The recommended way to name the target.** The instance ID; Auto-Yes is controlled independently of the other instances |
| `--agent <id>` | A helper for instances that are not in the roster (unnecessary when `--instance` alone is enough) |

Enabled for an instance whose session is not running, Auto-Yes stays on until it expires (`--duration`) and answers once the session starts (Issue #3329); while it waits it checks once a minute. It stops with `consecutive_errors` only when failures keep coming in a row: the session exists but its screen cannot be read or the answer cannot be sent, or tmux itself cannot be asked.

### Answer Modes: Recommended and Careful (Issue #3863)

When you turn Auto-Yes on you choose how it treats a **question** the agent asks.

| Mode | A question (claude's `AskUserQuestion`, command-code's question) | A permission |
|------|------------------------------------------------------------------|--------------|
| `recommended` (the default) | Answered with its recommended option (rules below) | Only the "allow this call once" option is picked (Issue #3822) |
| `careful` | Not answered; a person answers it (`question-left-to-human`) | The same |

The option `recommended` picks:

- exactly one option whose **title** (told apart from its description line; a wrapped title is read joined) ends in a standalone `(Recommended)`, `（推奨）` or `(推奨)`: that option, wherever it is in the list and wherever the cursor is;
- no recommended option: the default (the cursor's option, else option 1);
- nothing — the question is left to a person (`recommended-option-unidentified`) — when two or more are recommended, an option's title cannot be told from its description, the option to pick takes typed text (`Type something` and the like), or the question is multi-select. The same words at the end of a description do not count.

Under either mode these are never answered automatically: the `Submit` / `Cancel` confirm page after a question (`question-confirm-page`), OpenCode / V2's questions (the question form and the API question), and anything the contract withholds. Copilot's question (`ask_user`) and codex's (`request_user_input`) cannot be told from their other pickers on screen. So under `careful`, a copilot / codex numbered list whose rows do not read as permission wording (the measured `Yes` / `Allow` / `Always allow` and so on) is not answered and is left to a person as something that cannot be decided to be a question or not (`question-left-to-human`; Issue #3881). A permission dialog whose wording reads is still answered with its "allow this call once" row. Under `recommended`, such a list is answered as before. `CM_AUTOYES_DIALOG_GATE=<tool>=legacy` (the kill switch) does not change how a question is treated (`careful` still leaves it to a person).

- **The mode is set each time Auto-Yes is turned on** (worktree × instance). From off (an expiry included) it starts afresh, `recommended` when omitted; turning it on again while it is on keeps the current mode when omitted. After a mode change no decision made under the old mode carries over, even with the same screen up
- **The contract**: the contract's `autoYes` is the ceiling and the answer mode sits below it ([task-contract.md](../../design/task-contract.md) §2.4)
- **Where it shows**: `auto-yes --enable` and `send --auto-yes` print one `Answer mode: …` line when a mode was given or it is not the default (`recommended`). It is also `autoYesAnswerMode` in `capture --json` (while on), `autoYesAnswerMode` on an `instances --json` row (while on), and `answerMode=…` on `wait`'s withholding line and `autoYesSuppression.answerMode` in the exit-10 JSON
- **API**: `answerMode` in the body of `POST /api/worktrees/<id>/auto-yes` (`recommended` / `careful`; anything else is 400). The responses (the POST, `GET …/auto-yes?cliToolId=` and the top level of `GET …/auto-yes`) carry `answerMode` while on. `GET …/auto-yes` gives each instance's mode in `answerModeByInstance` (the `agents` / `instances` entries keep their shape)
- **Records**: the Auto-Yes measurement records (decision lines, send attempts, withheld intervals, checkpoints) carry the `answerMode` of the moment. Older records have none, and the daily count reads them as "unknown"

```console
$ commandmate auto-yes proj-cc --enable --answer-mode careful
Auto-yes enabled for proj-cc (claude).
Answer mode: careful (questions are left to you; permissions are still answered).
```

### The Target Agent Is the Worktree's Default (Issue #1909)

`auto-yes <id> --enable` with neither `--instance` nor `--agent` targets the **worktree's default
agent** — the same target `send` / `wait` / `capture` address. Before Issue #1909 it was hard-coded
to claude, so on a worktree whose default is copilot or opencode a claude poller started, logged
`Claude Code session ... does not exist` every 2 seconds, and left the real dialogs unanswered.

The command now names the agent it armed:

```console
$ commandmate auto-yes proj-cp --enable
Auto-yes enabled for proj-cp (copilot).
```

A non-primary `--instance` reads as `(opencode, instance oc-2)`. If no agent is named at all
(`Auto-yes enabled for proj-cp.`), the **running server is older than the CLI** and is still
hard-coding claude; restart it with `commandmate stop && commandmate start`.

### A Contract With `autoYes.mode: off` Is Warned About When Arming (Issue #3723)

On an instance whose running contract sets `autoYes.mode: off`, Auto-Yes **never answers**, however
it is enabled. `auto-yes --enable` and `send --auto-yes` then print a warning on stderr (the exit
code stays 0: the arming itself succeeded).

```console
$ commandmate auto-yes proj-cc --enable --instance claude-2
Auto-yes enabled for proj-cc (claude, instance claude-2).
Warning: the contract of task 7f3c… sets autoYes.mode: off, so Auto-Yes is armed but will answer no prompt. Prompts on this instance wait for a human (commandmate respond).
```

- `safe` / `allow-listed` are not blocked; one `Note:` line names what gets answered
  (e.g. `Note: … sets autoYes.mode: safe; Auto-Yes answers yes_no prompts only (on claude, codex, copilot, opencode and opencode-v2, only those the tool itself shows as a confirmation, not a generic (y/n)).`)
- With no contract, or a contract that states no `mode`, the output is what it was
- The verdict goes through the poller's own policy read (`getSessionAutoYesPolicy`). On the API it
  is `contractPolicy` (`{ taskId, mode, allowPromptTypes, denyPatternCount }` or `null`) on the
  responses of `POST /api/worktrees/<id>/auto-yes` (enabling) and `GET …/auto-yes?cliToolId=`
- The verdict is about the contract **running at that moment**. With `send --contract … --auto-yes`,
  though, the task is still `pending` when Auto-Yes is armed (the server does not count it as
  running), so when the server's `contractPolicy` is `null` the `autoYes` of **the contract being
  sent** is judged instead. The same `Warning:` / `Note:` is printed once, including when `--model`
  moves the arming after the send (a value from the server takes precedence)
- Once armed, the `AUTO_YES` column of `commandmate ls` / `commandmate instances` reads `blocked`,
  and the Auto Yes toggle on the worktree detail screen shows "Blocked by contract (mode: off)"

Arming a session that is already stuck on a dialog adds a second line reporting what it re-judged
for **that resolved agent** (Issue #1898-2 — only sources with a `resync` capability, which today
means opencode; the five hook tools print nothing).

```console
$ commandmate auto-yes proj-oc --enable
Auto-yes enabled for proj-oc (opencode).
Re-judged 2 pending approval(s): 2 answered.
```

### `--stop-pattern` Matches Terminal Output (It Cannot Suppress a Command)

`--stop-pattern` **does not watch the commands the agent runs**. It is a regular expression matched
against newly appended terminal output (the delta). It cannot stop a command from executing, and
conversely it fires when the pattern merely **appears** in output such as a build log (specify
`rm -rf` and an npm script that logs `rm -rf dist` during cleanup will stop Auto-Yes).

To suppress automatic answers for dangerous commands, use the execution contract's
`autoYes.denyPatterns` ([docs/design/task-contract.md](../../design/task-contract.md)) instead. That
one matches against the **question text and options** of the confirmation prompt, and on a match it
declines to answer and escalates to a human.

### Two Approval Routes, and command-code Only Has the Screen One

"Answering automatically" is not one mechanism. **Which route is used is a property of the agent**,
not of how you spell `--enable`.

| Route | What happens | Agents |
|-------|--------------|--------|
| **Hook approval** | The agent asks CommandMate **before** it runs the tool, and CommandMate adjudicates. When the answer is "allow", the dialog is **never drawn** | claude / codex / copilot / antigravity (opencode does the same thing over SSE rather than hooks) |
| **Screen-based (TUI numbered response)** | The dialog **is actually drawn**, then CommandMate reads the terminal and sends back the option's number key | **command-code** / gemini / vibe-local |

**command-code cannot use hook approval, structurally.** Its `PreToolUse` hook fires **after** the
permission dialog has been answered, so no hook reply can dismiss one (measured on Command Code
v1.49.0: dialog detected `23:02:19.398Z` → number sent `23:02:19.919Z` → `PreToolUse` delivered
`23:02:20.120Z`). That is why command-code's `PreToolUse` is registered against
`/api/hooks/agent-event` as an **ordinary observation** and is never consulted for an approval.
See [Agent event hooks](./agent-event-hooks.md) for the per-tool details.

Three consequences are visible from the CLI:

- **The dialog is drawn on the terminal, once.** Measured, it stands for 3–4 seconds before it is
  answered and disappears (0.1–0.6 s of that is detection → keystroke). On the four hook-approval
  tools no dialog appears at all as long as the request is allowed
- **Nothing is answered when the terminal cannot be read.** A pane capture is the only input this
  route has, so a frame that cannot be captured — or that slips past detection — is left standing
  (the same gap `wait` reports as `unclassified`)
- **`auto-yes --enable` never prints its second line here.** Re-judging pending approvals needs the
  `resync` capability, which today only opencode has — neither the three screen-based tools nor the
  four hook-approval ones print it

Either way, **`capture --prompts` is where you find out who answered** (`answeredBy` is `auto` for
the server-side Auto-Yes, `human` for `respond` or the chat UI).

```console
$ commandmate capture <worktree-id> --instance command-code --prompts --json
{
  "prompts": [
    {
      "question": "… Execute Shell Command Command Code needs to execute rm -f probe.txt. …",
      "options": [{ "number": 1, "label": "Yes", "isDefault": true }, …],
      "status": "answered", "answer": "1", "answeredBy": "auto"
    }
  ]
}
```

> **This does not mean Auto-Yes is weaker on command-code.** In an isolated live check both a
> `Create File` and an `Execute Shell Command` dialog were answered with `answeredBy: auto` while
> Auto-Yes was on, and with it off the same dialog was still standing 45 seconds later (the control).
> What differs is the **route**, and the three consequences above that follow from the dialog being
> drawn at all.

---

## commandmate instances

List, add, remove, and rename the worktree's "agent instances" (the roster, Issue #1000).
The roster is the source-of-truth data managed by the Agent pane of the browser UI
(`AgentInstancesPane`); it is tracked separately from the ad-hoc sessions that `send --instance`
starts.

### Usage

```bash
commandmate instances <worktree-id>                                    # List (the default action)
commandmate instances <worktree-id> --json                             # JSON output

commandmate instances <worktree-id> add --agent codex                  # Add (the ID is assigned, e.g. codex-2)
commandmate instances <worktree-id> add --agent codex --alias "For review"
commandmate instances <worktree-id> add --agent codex --id codex-3     # Explicit ID

commandmate instances <worktree-id> remove <instance-id>               # Remove from the roster
commandmate instances <worktree-id> remove <instance-id> --kill        # Remove and stop the session

commandmate instances <worktree-id> alias <instance-id> "New name"     # Rename

commandmate instances <worktree-id> kill <instance-id>                 # Stop just that instance's session
```

`kill` also disables Auto-Yes for the instances it stops (Auto-Yes of instances it did not stop is kept).

### Output Example (list)

`commandmate instances <worktree-id>`:

```
INSTANCE_ID  ALIAS   CLI_TOOL  RUNNING  AUTO_YES  MODEL              EFFORT
-----------  ------  --------  -------  --------  -----------------  ------
claude       Claude  claude    yes      no        claude-opus-5[1m]        
codex-2      Review  codex     yes      yes       gpt-5.6-sol              
gemini       Gemini  gemini    no       no                                 
```

`commandmate instances <worktree-id> --json`:

```json
[
  {
    "instanceId": "claude",
    "alias": "Claude",
    "cliTool": "claude",
    "running": true,
    "autoYes": false,
    "model": "claude-opus-5[1m]",
    "reasoningEffort": null
  },
  {
    "instanceId": "codex-2",
    "alias": "Review",
    "cliTool": "codex",
    "running": true,
    "autoYes": true,
    "model": "gpt-5.6-sol",
    "reasoningEffort": null
  },
  {
    "instanceId": "gemini",
    "alias": "Gemini",
    "cliTool": "gemini",
    "running": false,
    "autoYes": false,
    "model": null,
    "reasoningEffort": null
  }
]
```

#### The `AUTO_YES` Column (Issue #3300)

Whether Auto-Yes is on for that instance. Auto-Yes is kept per worktree × instance and can be
enabled with no session running (`commandmate auto-yes <id> --enable --instance <instance-id>`), so
a `RUNNING no` row can read `yes`.

- It is read from the server's Auto-Yes state (`instances` in `GET /api/worktrees/<id>/auto-yes`) —
  the same source as `autoYesByInstance` in `commandmate ls --json`. A listing makes one more
  request for it, whatever the number of instances
- Against an older server that does not answer that request, it is read from each session's
  `current-output` `autoYes` as before; there, an instance that is not running reads `no` even when
  Auto-Yes is on
- `autoYes` in `--json` is the same value
- An armed instance whose running contract sets `autoYes.mode: off` reads `blocked` (Issue #3723).
  In `--json`, `autoYes` stays `true` and `autoYesBlockedByContract: true` is added (absent on every other row)
- An instance whose grant a server restart released reads `no(restart)` (Issue #3730). In `--json`,
  `autoYes: false` gains `autoYesStopReason: "server-restart"` (absent on every other row). It reads
  so until the original grant's deadline, or until `--enable` / `--disable`

#### The `MODEL` / `EFFORT` Columns (Issue #1785)

These show **which model a running instance is on right now**. `CLI_TOOL` only answers "which
agent"; "which model inside it" is known to the session alone. The columns exist so that, running
parallel workers, "four are running" can be told apart from "four are running and one of them
dropped to a cheap model".

| State | Displayed as |
|-------|--------------|
| The agent reports a model | The reported value verbatim (`claude-opus-5[1m]`, `gpt-5.6-sol`, …) |
| The session is not running (`RUNNING no`) | Empty (`null` with `--json`) |
| A tool that does not report a model (gemini / copilot) | Empty (`null` with `--json`) |
| claude has not emitted `SessionStart` yet after a server restart | Empty (it comes back on the next session start) |

- The value is **the agent's own claim, verbatim**. The CLI neither reformats nor normalizes it, so
  it lines up directly with what `/status` or `agy models` displays
- `EFFORT` is always empty / `null` until Issue #1784 (extracting effort from a capture) lands: no
  agent puts effort in its hooks payload, and the TUI display is the only source
- The columns were **appended at the end**. Scripts reading `INSTANCE_ID` through `AUTO_YES` by
  column position keep working

### Options

| Option | Description | Applies to |
|--------|-------------|------------|
| `--json` | JSON output | list, add |
| `--agent <tool>` | The CLI tool the new instance runs | add (required) |
| `--alias <name>` | Display name (generated from the tool name if omitted) | add |
| `--id <instance-id>` | An explicit instance ID (assigned automatically if omitted) | add |
| `--kill` | Stop the session as well as removing it from the roster | remove |

### Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | Success |
| 2 | Validation error (bad `--agent`/`--id`, over the limit, removing the last remaining instance, …) |
| 99 | The named instance is not in the roster |

---

## Multi-Session (Several Sessions of One Agent)

One worktree can run several sessions of the same CLI tool at once (Issue #868).

### Instance ID Convention

| Form | Meaning |
|------|---------|
| `<agent>` | The primary instance (e.g. `claude`, `codex`) |
| `<agent>-<n>` (n >= 2) | An additional instance (e.g. `claude-2`, `codex-3`) |

`--instance` is accepted by `send` / `wait` / `respond` / `capture` / `auto-yes` alike.

> **Name the target with the bare `--instance` form (Issue #1638).** `--agent` is accepted only by
> `send` / `respond` / `capture` / `auto-yes`; `wait` does not take it (`wait --agent` is an
> `unknown option` and exits 1). That asymmetry does real damage in exactly one case —
> **writing the agent on `send` but not on `wait`** — because `wait` then watches the worktree's
> **default** agent and silently waits for Claude Code to finish in a worktree set up for Codex.
> All five commands accept `--instance`, so one flag covers the whole workflow.
>
> **`--agent` is not deprecated (the decision recorded in Issue #1638)**: breaking shipped CLIs,
> existing scripts, and embedded documentation is not worth it, and **`--register` has no other way
> to name the CLI tool for an ID that is not in the roster** (`codex-3` alone does not imply one).
> So `--agent` stays, positioned as **the helper for ad-hoc starts of instances outside the roster**.
> Parsing and precedence (see the table below) did not change at all.
>
> Adding `wait --agent` was considered and rejected in Issue #1629 (a bare `--agent codex` with no
> instance cannot decide *which* codex session to wait for).

### Relationship with the Roster

- The **roster** is the formal instance list managed in the browser UI's Agent pane (with ordering
  and aliases). `commandmate instances` lists, adds, removes, and renames its entries.
- `send --instance <id>` starts a session **even for an ID that is not registered** (an ad-hoc run).
  Instances outside the roster do not appear in the UI sidebar or tabs, though.
- Adding `--register` to `send ... --instance <id>` registers that instance in the roster after
  sending. Use it when you want the UI and the actual state to agree.
- To find valid `--instance` values, check the roster and the running sessions with
  `commandmate instances <worktree-id>`.

### Precedence Between `--agent` and `--instance` (Issue #1629)

`--instance` is an instance ID, not a CLI tool name, so which CLI tool starts has to be decided
separately. The CLI tool ID is part of the tmux session name
(`mcbd-[<ns>-]<agent>-<worktree>[-<suffix>]`), so getting it wrong leaves you with "claude running in a
session named codex". The resolution order below is shared by `send` / `respond` / `capture` /
`auto-yes`.

| Case | CLI tool used |
|------|---------------|
| `--instance` **is** in the roster / `--agent` omitted | The roster's `CLI_TOOL` |
| `--instance` **is** in the roster / `--agent` **matches** the roster | That value |
| `--instance` **is** in the roster / `--agent` **conflicts** with the roster | **Error (exit 2)**. The roster is the source of truth, so it is never silently overridden |
| `--instance` is **not** in the roster / `--agent` given | The `--agent` value (an ad-hoc start) |
| `--instance` is **not** in the roster / `--agent` omitted, ID is a CLI tool name (e.g. `codex`) | That CLI tool (its primary instance) |
| `--instance` is **not** in the roster / `--agent` omitted, ID is a custom name (e.g. `codex-9`) | The worktree's default agent |

To clear a conflict error, drop `--agent`, set it to the roster's value, or re-register the roster
entry with `commandmate instances <worktree-id> remove/add`.

> When the roster cannot be read (an old daemon, for instance), a warning is printed and `--agent`
> is used as given.

### Per-Instance Auto-Yes

Running `--auto-yes` / `auto-yes --enable` together with `--instance` enables and stops Auto-Yes for
that instance independently of the others.

### Examples

```bash
WT=$(commandmate ls --branch feature/101 --quiet)

# Check the roster (to find valid --instance values)
commandmate instances "$WT"

# Register the extra instance before using it
# Once it is in the roster, --agent can be omitted (the roster's CLI_TOOL is used)
commandmate instances "$WT" add --agent codex --alias "For review"
commandmate send "$WT" "Review the diff" --instance codex-2 --auto-yes
commandmate wait "$WT" --instance codex-2 --timeout 600
commandmate capture "$WT" --instance codex-2 --json

# Start ad-hoc and register on the spot
# --agent is required here: codex-3 is not in the roster yet, and the ID alone cannot decide the tool
commandmate send "$WT" "Give this a quick check" --agent codex --instance codex-3 --register

# Remove it when it is no longer needed (stopping the session too)
commandmate instances "$WT" remove codex-2 --kill
```

---

## commandmate report

Generate, show, and list daily reports (a summary of the day's agent activity, Issue #636).
While the server is running, the selected AI tool generates the report from registered session history.

```bash
commandmate report generate                       # Generate today's report (claude)
commandmate report generate --date 2026-06-21      # Specific date
commandmate report generate --tool codex           # Choose AI tool
commandmate report generate --template <id>        # Use a template as the instruction
commandmate report generate --instruction "Summarize"  # Custom instruction

commandmate report show                            # Show today's report
commandmate report show --date 2026-06-21 --json   # Specific date + JSON

commandmate report list                            # List the last 7 days
commandmate report list --days 30                  # List the last 30 days
commandmate report list --json                     # JSON output

commandmate report metrics                         # Eval metrics for the last 7 days
commandmate report metrics --days 30               # Choose the window (1-90 days)
commandmate report metrics --json                  # JSON output
```

### Subcommands

| Subcommand | Purpose |
|------------|---------|
| `generate` | Generate the report for a date and print its content to stdout |
| `show` | Show an existing report (`No report found` if not generated) |
| `list` | List report presence, message count, and tool for the last N days |
| `metrics` | Aggregate task success rate, verification pass rate, and human interventions (Issue #1551) |

### generate Options

| Option | Description | Default |
|--------|-------------|---------|
| `--date <date>` | Target date (`YYYY-MM-DD`) | today |
| `--tool <tool>` | AI tool to use (claude, codex, copilot, antigravity) | claude |
| `--model <model>` | Model name (for copilot) | - |
| `--template <id>` | Template ID used as the instruction | - |
| `--instruction <text>` | Custom instruction text (alternative to `--template`) | - |
| `--token <token>` | Auth token (prefer the `CM_AUTH_TOKEN` env var) | - |

### show / list Options

| Option | Description | Default |
|--------|-------------|---------|
| `--date <date>` (show) | Target date (`YYYY-MM-DD`) | today |
| `--days <days>` (list) | Number of days to list | 7 |
| `--json` | JSON output | - |
| `--token <token>` | Auth token (prefer the `CM_AUTH_TOKEN` env var) | - |

> **Note**: `--date` accepts only `YYYY-MM-DD`. An invalid format exits with code 2 (CONFIG_ERROR).
> `--tool` must be one of claude / codex / copilot / antigravity, and `--days` must be at least 1.

### list Output Example

```
2026-06-21  [report] tool=claude  messages=12
2026-06-20  [no report]  messages=3
2026-06-19  [report] tool=codex  messages=8
```

### metrics (Eval Metrics, Issue #1551)

Aggregates "how far the harness gets an agent through a run unattended" from the actual records in
`tasks` / `verification_runs` / `task_events`. It is **read-only**, and adds no table of its own.

| Option | Description | Default |
|--------|-------------|---------|
| `--days <days>` | Aggregation window (1..90). Out of range or non-integer exits 2 | 7 |
| `--json` | JSON output | - |
| `--token <token>` | Auth token (prefer the `CM_AUTH_TOKEN` env var) | - |

```
$ commandmate report metrics
Vibe Metrics (last 7 days)
Tasks:        12 total / 9 succeeded / 2 failed / 1 not-started  (success 75.0%)
Verification: 31 runs, pass 80.6%  (top fails: unit x4, lint x2)
Intervention: 5 human responds / 23 auto answered
Retry loops:  avg 1.3 per failed task
```

How to read it:

- **Tasks** — `tasks` rows created inside the window. `total` includes the unfinished ones
  (pending / running). `success` is `succeeded / total`
- **Verification** — verification runs started inside the window. `top fails` is the ten most common
  gates that ended `failed` / `timeout` (`skipped` and `error` are "not judged", so they are not
  counted)
- **Intervention** — the counts of `prompt_answered_human` (a human answered) and
  `prompt_answered_auto` (Auto-Yes answered). The count suppressed by policy (`suppressedByPolicy`)
  is not in the database yet, so it is always `null` in v1
- **Retry loops** — the average number of re-instructions per failed task (`message_sent` after
  `failed` / `not_started`)

> **A zero denominator prints `n/a`**, never `0.0%`, so that "0 of 12 succeeded" and "there were none
> to begin with" are not reported with the same string.

> **It works on older databases too.** On a database where migrations v49–v51 have not been applied,
> the relevant sections simply read 0 and `n/a` instead of erroring.

The daily report prompt (`report generate`) is handed the same aggregation for that day as a
`<verification_metrics>` section. On a day with no activity the section is omitted entirely.

---

## commandmate skill

Manage official Agent Skills from the CLI. This is a thin client over **the same API and domain
service** the browser UI uses; the CLI itself never downloads, extracts, writes, or deletes anything.

Filesystem paths, artifact URLs, file lists, and checksums are explicitly rejected by the API, so the
CLI never reconstructs them. The plan token the server issued during planning is passed straight
through to install / uninstall.

### Usage

```bash
# Browse the catalog
commandmate skill list                                    # List (table)
commandmate skill list --json                             # JSON (the API response verbatim)
commandmate skill list --prerelease                       # Include prereleases
commandmate skill info <skill-id>                         # Capabilities, provenance, version, compatibility
commandmate skill info <skill-id> --version 1.2.0

# Install plan (no writes)
commandmate skill plan <skill-id> --worktree <worktree-id>
commandmate skill plan <skill-id> --worktree <worktree-id> --version 1.2.0 --json

# Update plan (no writes)
commandmate skill update-plan <skill-id> --worktree <worktree-id>            # Plan against the recommended candidate
commandmate skill update-plan <skill-id> --worktree <worktree-id> --version 1.3.0
commandmate skill update-plan <skill-id> --worktree <worktree-id> --range "^1.0.0" --json

# update (plan, confirm, apply)
commandmate skill update <skill-id> --worktree <worktree-id>                 # Update to the recommended candidate
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 --dry-run
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 --yes
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 \
  --yes --ack-risk <skill-id>@1.3.0 --ack-risk-increase   # high-risk, and the risk goes up

# install (plan, confirm, apply)
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 --dry-run
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 --yes
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 \
  --yes --ack-risk <skill-id>@1.2.0                       # A high-risk Skill

# uninstall / status
commandmate skill uninstall <skill-id> --worktree <worktree-id> --dry-run
commandmate skill uninstall <skill-id> --worktree <worktree-id> --yes
commandmate skill status <skill-id> --worktree <worktree-id> --json
```

### The Confirmation Contract (install / update / uninstall)

| Condition | Behavior |
|-----------|----------|
| Always | A plan is built and displayed first |
| `--dry-run` | Stops after the plan; nothing is written or deleted |
| A TTY, no `--yes` | Prints the plan summary, then a confirmation prompt (on stderr) |
| **No TTY, no `--yes`** | **Writes nothing and exits 12.** It never acts implicitly where it cannot prompt |
| **A high-risk Skill** | Requires an **exact** `--ack-risk <skill-id>@<version>` in addition to `--yes`. `--yes` alone does not pass (nor does agreeing at a TTY) |
| **An update whose effective risk goes up** | Requires `--ack-risk-increase` **separately from** `--ack-risk`. Accepting high risk and accepting a risk increase are independent confirmations; neither substitutes for the other |
| **An update with local changes** | The plan already reports updatable=false. Applying anyway rewrites **neither the old nor the new version** and exits 11 |

### Options

| Option | Subcommands | Description |
|--------|-------------|-------------|
| `--worktree <id>` | plan / update-plan / install / update / uninstall / status | Target worktree ID (find it with `commandmate ls`) |
| `--version <version>` | info / plan / update-plan / install / update | **Required** for install (an exact version). For update-plan / update, omitting it resolves to the recommended candidate |
| `--range <range>` | update-plan / update | Restrict candidates to this version range (e.g. `"^1.0.0"`) |
| `--dry-run` | install / update / uninstall | Stop after the plan |
| `-y, --yes` | install / update / uninstall | Skip the confirmation prompt (required without a TTY) |
| `--ack-risk <id>@<version>` | install / update | Explicit approval for a high-risk Skill |
| `--ack-risk-increase` | update | Explicit approval for an update whose effective risk goes up (separate from `--ack-risk`) |
| `--prerelease` | list / info / plan / update-plan / install / update | Include prerelease versions |
| `--json` | every subcommand | JSON output (the API response verbatim) |
| `--token <token>` | every subcommand | Auth token (prefer the `CM_AUTH_TOKEN` env var) |

### Exit Codes

| Code | Meaning | What to do |
|:----:|---------|------------|
| 0 | Success | - |
| 1 | The server or the Catalog is unreachable | Retryable |
| 2 | Bad arguments, or the Skill / version does not exist | Fix the argv |
| 11 | The worktree side refused (local changes, conflict, lock, plan drift) | Resolve the path in question and re-plan |
| 12 | The write was never confirmed (no `--yes`, declined, `--ack-risk` mismatch) | Approve explicitly and re-run |
| 13 | Files were changed but reconciliation is needed | Check the state (it converges on its own) |

> **stdout / stderr separation**: on success with `--json`, stdout holds parseable JSON and nothing
> else. Plan summaries, confirmation prompts, warnings, and errors (including the typed code and the
> blocker path) all go to stderr, so a failed `--json` run leaves stdout empty.

> **About `skill status`**: it reports the install state of one Skill in one worktree, read from the
> install receipt (the artifact on disk). There is no API yet that lists the installed Skills of a
> worktree, so `<skill-id>` is required.

> **The safety of `skill update`**: an update re-proves, immediately before applying, that the old
> version is unmodified according to CommandMate's own record. One edited, added, or missing file is
> enough to stop it at exit 11 **without writing anything**. The switch has a single commit point —
> one rename — so a failure part-way converges on either the complete old version or the complete new
> one, never a mixture. The old version is saved, verified, to
> `~/.commandmate/skills/backups/` before the switch (a restore command is planned in #1245).

---

## commandmate update

Update CommandMate itself to the latest version (Issue #1194).
In a global install it runs stop, `npm install -g commandmate@latest`, restart, and a readiness check in one command.
Unlike the other commands here, it acts on the **npm registry and the local daemon** rather than on a worktree (there is no `--token` flag; the readiness check resolves its URL from `.env` / `CM_PORT` and sends `CM_AUTH_TOKEN` as a bearer token when it is set).

```bash
commandmate update            # Update with a confirmation prompt
commandmate update --check    # Only report versions (changes nothing)
commandmate update --yes      # Skip the confirmation prompt (required without a TTY)
```

### Options

| Option | Description |
|--------|-------------|
| `--check` | Print versions only. No install, stop or restart (exits 5 only if the registry query fails) |
| `-y, --yes` | Skip the confirmation prompt. Required without a TTY (otherwise exits 2) |

### --check Output

```
Current: v0.9.0
Latest: v0.10.0
Update available: yes
```

### When the Update Is Skipped

Each of these prints a message and exits 0 without changing anything.

| Condition | Behavior |
|-----------|----------|
| Already up to date | Prints `Already up to date` |
| Local version is newer | Skips (never downgrades) |
| Local or latest is a prerelease | Skips (versions are not comparable) |
| Not installed globally (git clone) | Prints the manual steps (`git pull`, `npm install`, `npm run build:all`, restart) |

### Exit Codes

| Code | Name | Meaning |
|:----:|------|---------|
| 0 | SUCCESS | Updated, skipped, cancelled, or `--check` (including a degraded readiness check) |
| 2 | CONFIG_ERROR | No TTY and `--yes` was not passed |
| 3 | START_FAILED | Update succeeded but the restarted server could not be verified (no rollback needed) |
| 4 | STOP_FAILED | The server could not be stopped; aborted **without changing anything** |
| 5 | UPDATE_FAILED | Registry query, `npm install -g`, or version verification failed |
| 99 | UNEXPECTED_ERROR | Unexpected error |

### Caveats

- **Startup options are not restored**: after the restart the server uses only the settings in `.env`. If you used `--auth`, `--auth-expire`, `--cert`, `--key`, `--allow-http`, `--allowed-ips`, `--trust-proxy`, `--port` or `--dev`, start it again manually (`--auth` generates a new token on every start).
- **Worktree servers (`--issue`) are out of scope**: they are neither stopped nor restarted. `npm install -g` replaces the package directory (`dist/`, `.next/`), so a running worktree server may crash. Run `commandmate stop --issue <number>` **before** updating and `commandmate start --issue <number>` afterwards. The command warns when it detects running worktree servers.
- **If the main server was not running**: it is updated but not started.
- **With auth, IP restrictions, or a self-signed certificate**: the readiness check degrades to "the server responds" and exits 0 with a warning. Set `CM_AUTH_TOKEN` for the strict check.
- **EACCES**: do not re-run with `sudo`. Fix the npm global directory permissions as described in the [CLI setup guide](./cli-setup-guide.md#permission-error-eacces).
- **Rollback**: on failure the command prints `npm install -g commandmate@<previous-version>`.

---

### commandmate remote

Make this server reachable from outside and pair a phone with it over a QR code. Unlike the other commands here, **what it acts on is not a worktree — it is this machine's server and a provider (tunnel)**.

> **All `remote` adds is an outward door.** It never writes `CM_BIND`, so the default `127.0.0.1` bind does not change (it **reads** it only under `--auth remote-only`, to decide whether that mode is allowed at all). There is no flag to enable Auto-Yes either, so on a server started by `remote` Auto-Yes stays off for every worktree.

#### Usage

```bash
commandmate remote          # up (default): start the server, publish it, print the QR code
commandmate remote status   # provider, URL, expiry, pairing state
commandmate remote stop     # close the provider session (the server keeps running)

commandmate remote --provider cloudflare        # force a provider
commandmate remote --expires 24h                # remote session TTL
commandmate remote --pairing-expires 3m         # pairing code TTL
commandmate remote --yes                        # approve a public tunnel (required when non-interactive)
commandmate remote --auth remote-only           # authenticate the provider route only; local stays open
commandmate remote status --json                # machine-readable output
```

#### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--provider <name>` | Force a provider (`tailscale` / `cloudflare`). If the named provider is unusable this exits 1; it never falls back to another one | Auto-selects the first ready provider in preference order |
| `--expires <duration>` | Remote session TTL (`1h`-`30d`) | `8h` |
| `--pairing-expires <duration>` | Pairing code TTL (`1m`-`24h`) | `10m` |
| `-p, --port <number>` | Port of the server to expose | Same resolution order as `commandmate start` |
| `--yes` | Approve creating a public tunnel. Required without a TTY | Off (asks interactively) |
| `--auth <scope>` | How far authentication reaches (`all` / `remote-only`). See [Authentication scope](#authentication-scope---auth) | `all` |
| `--json` | JSON output | Off |

> **There is no `--token` flag and no `--auto-yes` flag in any form.** `remote` is the side that mints the token, so one supplied from outside would have no matching hash on the server. For Auto-Yes, see the note above.

#### Exit Codes

| Code | Name | Meaning |
|:----:|------|---------|
| 0 | SUCCESS | Published, reported, or stopped successfully (including a `stop` that found nothing recorded to clean up) |
| 1 | DEPENDENCY_ERROR | No provider is usable / the provider named by `--provider` is unusable on this machine |
| 2 | CONFIG_ERROR | No TTY and no `--yes` for a public tunnel / an invalid `--expires`, `--pairing-expires`, `--provider` or `--auth` value / `--auth remote-only` with a non-loopback `CM_BIND` / a server with authentication is already running / restarting the running server was not approved |
| 3 | START_FAILED | The server or the provider failed to start (anything already opened is rolled back) |
| 4 | STOP_FAILED | The provider session could not be closed (the state file is kept, so you can retry) |
| 99 | UNEXPECTED_ERROR | Unexpected error |

`remote` adds no new exit codes. The values mean the same as in [Exit Codes](#exit-codes).

#### Provider status

| Provider ID | `--provider` value | State |
|-------------|--------------------|-------|
| `tailscale-serve` | `tailscale` | **Implemented** (Issue #1937 R3). Ready when `tailscale` is installed, the node is logged in, and Serve/HTTPS is available. Publishes to your tailnet only, so it needs no public-tunnel approval |
| `cloudflare-quick` | `cloudflare` | **Implemented.** Ready whenever `cloudflared` is installed (measured: `available: true` / `version: 2025.4.0` / `ready: true`). Publishes to the public internet. **See the known issue below** |

Auto-selection walks the preference order (tailscale, then cloudflare) and takes the first provider that reports ready. If no provider is ready it stops with `DEPENDENCY_ERROR` (exit 1).

> **Known issue (measured 2026-08-29): the Cloudflare Quick Tunnel does not outlive the command.** `cloudflared` exits at the moment `commandmate remote` returns, and the URL it just printed starts answering HTTP 530 within seconds — before there is time to scan the QR code. The cause is the provider's spawn shape (the child's stderr stays attached to a pipe that the exiting parent closes), so it is a defect rather than something to configure around. Until it is fixed, prefer `--provider tailscale`, whose provider holds configuration rather than a process and is unaffected. The measured record is in [`docs/qa/1937-remote-uat-record.md`](../../qa/1937-remote-uat-record.md) (defect D-1).

#### A public tunnel needs explicit approval

A Cloudflare Quick Tunnel creates `https://<random>.trycloudflare.com` — an address **on the public internet**. So approval is taken before it is created.

- **Interactive**: a warning describing what is about to be published, then a yes/no question (the default is **no**)
- **Non-interactive (no TTY)**: **refused** unless `--yes` was passed, exiting 2. This is what stops "it got published because nobody was watching"
- **Tailscale being unavailable is not a reason to switch to a public tunnel.** Choosing a provider and approving publication are separate decisions, and nothing is published without the approval

Only the CommandMate server running on 127.0.0.1 is published; nothing else on this machine is. CommandMate answers with token authentication enabled, so a visitor without the pairing code is refused — but **the listener itself is public**. See the [Security Guide](../security-guide.md) as well.

#### Authentication scope (`--auth`)

`remote` starts the server with token authentication enabled. `--auth` chooses **which routes** that authentication applies to.

| Value | Through the provider (your phone) | Local on this PC (`http://localhost:<port>`) |
|-------|----------------------------------|----------------------------------------------|
| `all` (default) | Authenticated | Authenticated |
| `remote-only` | Authenticated | **Not authenticated** |

Under the default `all`, a remote session also asks the browser on this machine to log in — and the plaintext token is deleted the instant pairing succeeds, so **there is no way to log in from the PC**. The CLI on this machine (`commandmate ls` / `send` / `wait` / `capture`) stops for the same reason. Use `--auth remote-only` when you want the phone and the PC at the same time (Issue #2489).

```bash
commandmate remote --auth remote-only
```

**The decision is made from which listener a request arrived on, never from its source address.** Tailscale Serve and the Cloudflare Quick Tunnel both connect to `http://127.0.0.1:<port>` as their upstream, so a tunnelled request reaches the server from `127.0.0.1` exactly like a local one; exempting loopback would publish an unauthenticated CommandMate to whoever has the URL. `Host` and `X-Forwarded-*` are not used either — the caller sets them, and a provider was measured rewriting `Host` to the upstream's own.

Under `remote-only` the server opens **a second listener on a separate `127.0.0.1` port** alongside the existing one, and the provider is pointed at that one alone. Authentication is decided per listener, and an internal header a request brings with it is always overwritten by the server.

- The provider's listener **always authenticates**. Before pairing: 307 for screens, 401 for the API, 401 for WebSocket
- Only the local listener is exempt. **IP restriction (`CM_ALLOWED_IPS`) is not exempt**
- `--auth remote-only` exits 2 when `CM_BIND` is not loopback (`127.0.0.1` / `localhost` / `::1`). An unauthenticated listener open to the LAN would extend "local means trusted" to every host that can reach this machine
- If the second listener cannot be opened, the server falls back to authenticating everything (fail-closed) and `remote` rolls the whole session back. **Publication never proceeds on its own**

> **The trade-off.** Under `remote-only`, any process on this PC — including the agents CommandMate itself runs in tmux — can reach the API without a token. That is the same exposure as a CommandMate used locally without `remote` at all, and weaker than `all`, which is why `all` remains the default.

> **`remote stop` does not close the second listener.** It closes the provider, as before. The listener is loopback-only and authenticates every request, so closing the provider is what removes the route from outside; the socket itself lives until the server is stopped (the same reason `--expires` does not stop the server — that would take your local session down with it).

#### Pairing code

- **Single-use**, and expires after 10 minutes by default (`--pairing-expires`)
- 26 Crockford Base32 characters (128 bits). **The plaintext is never stored anywhere**
- The QR code is shown **once**, during `up`. Only when the terminal is too narrow to draw a scannable QR code is the URL printed as text instead (that URL contains the code, so it stays in your scrollback)
- The handoff file `~/.commandmate/remote-pairing.json` is mode 0600. **"Already used" is the file's absence**, not a flag inside it — it is deleted the instant pairing succeeds

#### remote status output

```
Provider:        cloudflare-quick
URL:             https://<random>.trycloudflare.com
Auth scope:      all (every request needs the paired token)
Remote expires:  2026-08-29T21:00:00.000Z (in 6h 12m)
Pairing:         unused
Server:          running (pid 12345, http://localhost:3000, auth: on)
```

Started with `--auth remote-only`, the `Auth scope:` line names both the port that is exempt and the port that is not:

```
Auth scope:      remote-only (provider port 51234 needs the paired token; http://127.0.0.1:3000 on this machine does not)
```

`--json` carries the same information in `.remote.authScope` (`all` / `remote-only`) and `.remote.server.remoteIngressPort`. A session recorded before #2489 has no `authScope` field and reads as `all`.

`Pairing:` is one of `unused` / `consumed` / `expired`. With no remote session recorded it looks like this:

```
Provider:        (none - no remote session recorded)
Server:          stopped
```

**Neither the pairing code nor the session token ever appears in this output.** The URL does, because it is not a secret.

> `status` reports what was recorded, not what is still alive: it does not probe the provider. If the URL stops answering while `status` still shows the session as valid, see the known issue above.

#### Expiry closes the outward door only

Running `commandmate remote status` after `--expires` (`8h` by default) has elapsed closes the provider session there and then. **The CommandMate server is not stopped** — stopping it would take your local use of the machine down with it. `up` starts the server as a daemon and returns, so no long-running process is left behind and the expiry is evaluated when `status` runs.

#### remote stop does not guess

- If the state file (`~/.commandmate/remote.json`, mode 0600) cannot be read, `remote stop` **does not guess which provider to tear down**. It says it does not know what to clean up and exits 0. Some providers — Tailscale Serve above all — hold configuration of yours that cannot be restored once deleted
- CommandMate reverts **only what it created**. Anything the provider reports as having existed before this session is listed under `Left alone (existed before this session):` and is **reported, not removed**
- If it cannot finish closing, it exits 4 (STOP_FAILED) and keeps the state file, so `commandmate remote stop` can be retried
- On success the **CommandMate server is still running**

> **With Tailscale, tear down through `commandmate remote stop`.** After a successful `tailscale serve`, Tailscale itself suggests disabling the proxy by re-running `serve` with only the port and the word "off" and no path. That untargeted form removes **every** handler on that port — including your own — with exit status 0 and no warning. `remote stop` always passes the specific path it created.

#### When the server is already running

- **Running without authentication**: it has to be restarted with authentication enabled, so you are asked to confirm a stop and restart. Without a TTY this is refused with exit 2 unless `--yes` was passed
- **Running with authentication**: that server's token hash was fixed at start and the plaintext is not retained, so **this session cannot pair with it**. It stops with exit 2 — run `commandmate stop` first, then `commandmate remote`

#### The environment variables remote passes to the server

`CM_AUTH_TOKEN_HASH`, `CM_AUTH_EXPIRE`, `CM_REMOTE_PAIRING_FILE` and `CM_AUTH_SCOPE` — five with `CM_REMOTE_INGRESS_PORT`, which is added only under `--auth remote-only`. `CM_REMOTE_PAIRING_FILE` is a **path, not a secret**, and neither `CM_AUTH_SCOPE` nor `CM_REMOTE_INGRESS_PORT` is a secret either. No plaintext long-lived token goes into the environment, because a tmux pane inherits the server's environment wholesale — anything left there would be readable by the very agents CommandMate is driving. `CM_BIND` is never written, so your existing bind setting is untouched.

#### Reading `--json`

`status` and `stop` print JSON only, so they pipe directly. `up` mixes server start-up progress lines into stdout, so **the JSON is the last line of stdout**.

```bash
commandmate remote status --json | jq -r '.remote.url'
```

> **`up --json` puts the pairing code in `pairingUrl`.** Do not leave it in a log or a file. `status` does not emit that field — only `up` ever shows the code.

#### No `Secure` attribute on the cookie over a tunnel

The `Secure` attribute of the authentication cookie is decided by whether `CM_HTTPS_CERT` is set. A tunnel setup is **HTTPS on the outside and plain HTTP at the origin**, so `Secure` is not set. **This is correct behaviour**: setting it would make the browser refuse the cookie over HTTP to `127.0.0.1`, breaking local use. The outside of the tunnel is HTTPS, so the on-the-wire eavesdropping risk is already addressed.

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
commandmate send "$WT2" "Implement #102" --auto-yes --instance codex

# One `wait` takes a single --instance and applies it to every worktree id, so
# worktrees on different instances need one wait each. Both agents keep running
# while the first wait blocks, so this costs no wall clock over a combined wait.
# A bare `wait "$WT2"` would watch WT2's DEFAULT agent, not the codex session.
commandmate wait "$WT1" --timeout 1800
commandmate wait "$WT2" --instance codex --timeout 1800

commandmate capture "$WT1" --json
commandmate capture "$WT2" --instance codex --json
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
Error: Invalid duration. Must be 1h-24h, whole hours (e.g. 5h).
Error: Invalid agent. Must be one of: claude, codex, gemini, vibe-local, opencode, copilot, antigravity, command-code, opencode-v2
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
| 1 | DEPENDENCY_ERROR | Server not running / no usable remote provider (`remote`) |
| 2 | CONFIG_ERROR | Validation error (invalid agent, duration, etc.) |
| 3 | START_FAILED | Failed to start or verify the server (`start` / `update` / `remote`) |
| 4 | STOP_FAILED | Failed to stop the server (`stop` / `update`) / the provider session could not be closed (`remote stop`) |
| 5 | UPDATE_FAILED | Update failed (`update`: registry query / `npm install -g` / version verification) |
| 10 | PROMPT_DETECTED | Prompt detected during wait |
| 11 | UPSTREAM_FAULT | An upstream API fault was on the screen when the turn ended (`wait --fail-on-upstream-fault`; `ask` always). stderr / `--json` carry `id=...`; `id=context-limit` means the conversation is over the model's context limit — kill the instance (`commandmate instances <wt> kill <instance>`) and send again in a fresh session; `id=model-capacity` means the selected model is at capacity and will not answer — send to another instance or model (#3936) |
| 99 | UNEXPECTED_ERROR | Unexpected error / resource not found |
| 124 | TIMEOUT | Wait timeout exceeded |

---

## Related Documentation

- [Quick Start Guide](./quick-start.md) - The basics of using CommandMate
- [Commands Guide](./commands-guide.md) - Slash commands in detail
- [Workflow Examples](./workflow-examples.md) - Practical usage examples
- [Agent Skills Distribution](./skills.md) - What `commandmate skill` installs, and its constraints
- [Agent Event Hooks](./agent-event-hooks.md) - The structured events behind `autoVerifyOnStop` and Auto-Yes v2
- [Task Contract](../../design/task-contract.md) - The canonical specification of `.commandmate/tasks/*.yaml`
- [Verification Config](../../design/verification-config.md) - The canonical specification of `.commandmate/verify.yaml`
