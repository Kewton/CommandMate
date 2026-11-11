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
| [`commandmate roles`](#commandmate-roles) | Define roles and set the defaults per tool and repository |
| [`commandmate mem`](#commandmate-mem) | Read and write the items that carry work across sessions (now, waiting, decisions, …); the mode is read-only |
| [`commandmate handoff`](#commandmate-handoff) | The hand-off before a session ends: the agent proposes its mem updates (a person confirms on the screen) |
| [`commandmate brief`](#commandmate-brief) | The summary a restart reads (derived state and mem items) within a UTF-8 byte budget |
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
commandmate send <worktree-id> "<message>" --instance codex --role reviewer  # Save the role, and send only to a process running it (see commandmate roles)
commandmate send <worktree-id> "<message>" --agent codex --instance codex-3 --register --role reviewer  # Create the instance and its role first, then send
commandmate send <worktree-id> "<message>" --instance opencode --new-conversation  # OpenCode V1: start a stopped session on a new conversation, not the remembered one
commandmate send <worktree-id> "<message>" --no-brief    # no session brief on this send only (the boundary keeps it for the next)
commandmate send <worktree-id> "<message>" --with-brief  # attach the session brief to this send even with no boundary detected
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
commandmate send <worktree-id> "<message>" --auto-yes --auto-yes-answer-mode careful  # questions are yours
```

**Session brief (Issue #4274)**: on claude, codex and command-code, the first send after a conversation boundary (a new launch, a reset such as `/clear` or codex's `/new`, a resume to another conversation, a restart) carries the mem brief once, in front of the message — only when mem is `on` / `derived` for the branch and `injectOnStart` is enabled. Reconnecting to a running process is not a boundary. `--no-brief` skips it for that one send without changing any setting; `--with-brief` attaches it with no boundary. Giving both is exit 2 with nothing sent. When the brief and the message together would pass the length #2464 verified (48 KiB, 240 lines), the brief is left off and the message is never cut. The response's `brief` says what happened when one was attached or a flag was given. Other tools, relay delivery, Schedule, terminal commands and answers never carry it.

**What the brief holds, and when it is left off (Issue #4224)**: the brief is built as [`commandmate brief`](#commandmate-brief) builds it (C, #4223), and only the "it ended" notices that are in the text typed are acknowledged, when the delivery is `sent` (an `unknown` delivery is not an acknowledgement). When the worktree is deleted, made again or renamed after the send was accepted and before it is typed, the old request's brief is not put into the new worktree (`brief.reason` is `worktree_changed`; a send whose lifetimes could not be fixed at its entrance says `lifetime_unpinned`). After a process ended in a way nobody planned, the brief's data starts with the line 「終わる前の更新を確認できない（この instance の最終更新は N 時間前）」 ("the update before the end cannot be confirmed; this instance's last update was N hours ago") — on an `on` branch, only when an earlier conversation is on record, and never as a verdict. When that line does not fit the budget the brief is left off (`over_limit`) and the message is never cut. When a briefed send is read back from the transcript into the history, its row keeps the message alone and no row is added. A message whose first word starts with `/` (`/model`, `/plugin:cmd`, `/mcp__srv__prompt`, `/prompts:name`, …) or that starts with `!` is a command to the tool: it is never briefed and the boundary is kept for the next send. When the instance is deleted and made again after the send was accepted, the old request does not use the new instance's launch boundary (the next request does). Nor does it settle a boundary a gone process left mid-send. A send accepted after the instance was made again, while the new launch boundary is not open yet and the earlier instance's launch boundary is still the current one, clears that boundary without a brief (`incarnation_changed`). A send whose worktree lifetime could not be confirmed when it was accepted (`lifetime_unpinned`), or whose worktree was made again (`worktree_changed`), writes nothing on the ledger — clearing a boundary included.

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
| `--auto-yes` | Enable auto-yes before sending. Applied after the message (a tool `--model` defers it for, or a grant already on with a role or pin), a failure is a warning and exit 0, because the message has gone out. Do not send it again: the warning's command enables it. A failure before the message is an error with nothing sent (Issue #4159) | - |
| `--duration <d>` | Auto-yes duration (`1h`-`24h`, whole hours; e.g. `1h` / `3h` / `8h`). Out of range exits 2 with or without `--auto-yes` | 1h |
| `--note "<text>"` | With `--reply-to`: what you wait for, kept in the sender's mem (your own session, `whoami`) as a `waiting` item (`close_when=relay:<id>`, `evidence=[relay:<id>]`; it closes when the relay ends). Only the note and the relay id are stored — not the other session, the time or the message. **The message is not changed.** Without `--reply-to` or a session identity: exit 2. When mem refuses it (mode not `on` 50, a check 2, the open limit 56, ...) **nothing is sent**: the contract's task is failed, the Auto-Yes grant this send armed and the relay are withdrawn, and send exits with mem's code. With `--auto-yes`, an Auto-Yes state that cannot be read first stops the send before arming (exit 99), and `--instance` is required (with `--agent` alone there is no instance to read the state for: exit 2, nothing done). A send known not to have gone in closes the item (Issue #4226) | - |
| `--stop-pattern <p>` | Auto-yes stop condition (regex) | - |

### Input that overlaps a send (input lock (#3952))

A message send (`send` / `ask`, chat, timers, relay) types into the composer only while it holds the instance's input lock (Issue #3945), so nothing else is typed in the middle of it (paste → check → Enter, the watch for a late paste, the withdrawal). The other input paths:

| Path | Lock | When it overlaps a send |
|------|------|-------------------------|
| `respond` / the answer panel (answers that send Enter), strict `respond`, Auto-Yes answers, Command Code plan review, codex's automatic answers at launch and before a send (hooks / update / trust / notices), copilot's and Antigravity's automatic folder-trust answers | Takes part (answers do not wait for each other) | Waits for the send to finish, then **reads the screen again and types only if the same confirmation is still up**. When it is gone, changed, unreadable, or the wait passes 60 s, nothing is typed: `respond` reports `answer_not_delivered` (`/respond` answers 409, strict mode exits 40 `session_conflict`), and Auto-Yes decides again on its next tick. A send that starts during an answer waits for the answer's Enter |
| `answer_only` digit answers (no Enter) | Does not take part | One key and no Enter, typed without waiting |
| The keys Claude's and Gemini's launch types itself (the launch line, the automatic folder-trust answer) (#3975) | Takes part (as a sole writer; also waits for answers) | Holds the lock only while typing (the launch's waits are outside it). Waits for a send or an answer to finish; the trust answer, when a send came in meanwhile, reads the screen again and types only if the same dialog is still up. A `respond` that read the screen before the launch's Enter reads it again after it |
| Every tool's launch line (codex, copilot, Antigravity, OpenCode, OpenCode V2, Command Code, Vibe Local, Gemini and Claude; for Claude also the `unset CLAUDECODE` before it) (#3981) | Takes part (as a sole writer; one launch's lines in one hold) | Waits for a send or an answer to finish before typing (the launch's waits are outside the lock). A relaunch from inside a send (codex after its update, for example) types under that send's lock |
| Every tool's exit keys on stop (`kill-session`, worktree deletion, Stop): Ctrl-C, Ctrl-D, `/quit`, `/exit` and the like (#3981) | Does not take part (by decision) | So a stop is never queued behind a send. Stopping during a send makes that send fail part-way (check `lastSend` for the outcome) |
| Typing in the terminal (WebSocket), `direct-input`, special keys (including the unsent bar's **Run**) | Does not take part (neither refused nor held) | **Keys typed during a send can be mixed into its body, or removed by its clean-up (the composer clear, the withdrawal).** Wait until the send is over (the reply has started) before typing |
| `interrupt` (Escape) | Does not take part (does not wait, does not invalidate the send) | So a stop is never queued behind a send. An Escape that arrives while a body is being typed can stop that send part-way (check `lastSend` for the outcome) |

- copilot's `--model` reads the screen once more right before typing `/model`: a dialog is `not-sent` (`prompt-waiting`), an unreadable pane `not-sent` (`recheck-failed`), and nothing is typed.
- A session is started by one launch at a time (Issue #3981). A send or a start request that arrives during a launch waits for that launch to finish and then goes on (no second launch). A send that holds the input lock when it meets another request's launch (Claude's and codex's sends) does not wait: it returns `not-sent` (`session-starting`, HTTP 503 `SESSION_STARTING`) with nothing typed — retry it in a few seconds. The order is fixed as "the one-launch rule outside, the input lock inside": a lock holder waiting for a launch whose keys wait for the lock would stall both.
  - The wait lasts until the launching tool's start deadline (counted from when the launch began: 65 s for Claude, 35 s for the others). A launch still not finished by then gets the send back as `not-sent` (`session-starting`, HTTP 503 `SESSION_STARTING`) with nothing typed.
  - A send with `--model` that meets a launch starting another model (or no model) does not join it: it returns HTTP 400 with nothing typed, as `--model` to a running session does.
  - A launch stopped with `kill-session` is no longer waited for (the next start is a launch of its own). A session stopped by the server's clean-up (a repository deletion; the sessions of worktrees that `commandmate sync`, a repository scan or restore, or the end of a clone removes; and the `__global__` sessions on the same occasions) is not treated so: a send or a start request that arrives before the stopped launch returns (usually by failing) waits for that launch and gets its outcome. The wait lasts at most the deadline above (65 s / 35 s); if the stopped launch fails early, the next start is a new launch from then on (recorded by Issue #4032).
- Gemini returns `not-sent` (`prompt-not-ready`) with nothing typed when its prompt does not appear within 15 s before a send (Issue #3981; it used to give up waiting and type anyway).
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
| `--timeout <sec>` | Maximum time to wait (seconds). One deadline counted from the command's start: it cuts the reads before the poll (`--instance` resolution and the capabilities probe, the task list of `--verify` / `--require-work`) and each poll's reads (`current-output` and the messages ledger), up to the end of the body. A server that does not answer still ends in exit 124 at the deadline, with no poll or verification after it (Issue #3974 / #3983). Verification after a detected completion (`--verify` / `--require-work`) is not part of it and is not cut. `ask --timeout` is the same deadline, except that the send POST (and, with `--async`, the relay POST) is not cut: if it returns past the deadline, ask exits 124 saying the message was sent (`--async` exits 0 once the relay exists). Resolving the two ends of an `--async` relay is inside the deadline. Reading the reply after completion (ledger, pane) is not part of it either: each read is cut at the reply grace (15 s) and falls back to the pane | unlimited |
| `--on-prompt <mode>` | What to do when a prompt is detected (agent / human) | agent |
| `--stall-timeout <sec>` | Timeout on "no output change" (seconds). Like `--timeout`, it also cuts a read that does not answer (exit 124) | - |
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
  caught even when that turn ended before `ask`'s first poll. The server reads whether a turn was
  open at the moment the body started going in and returns it in the send API's response as
  `turnOpenAtSend: true` / `false` (the key is absent when that is not known: a tool whose hooks do
  not report both a turn's start and its end, a send path that reports no input start, a relaunch
  inside the send). When the key is there, `ask` decides this side from its value alone, so it is
  caught even when the server's turn record is replaced by this request's own new turn before that
  first poll, and a turn that ended between the send and the input does not count. Without the key
  the earlier check applies (#3957))
- another request reached the instance between the send and the end of the turn (the earlier
  sender; read from the `user` rows of the chat history. The end is the close time the server
  recorded, so the next request sent after the `Stop` does not count, and no `user` row since the
  send is missed even when more than the newest 30 rows came after it)

An `ask` without `--instance` / `--agent` finds the instance its request landed on from the
history and looks only at that instance's rows. Only rows between the send and the end of the turn
are used for that (the same text sent to another instance later does not count). When that cannot
be told (the same text reaching more than one instance in that window, for example), the second
check is skipped.

#### Relay delivery bound to its send (Issue #3957)

Relay delivery (`ask --async` / `send --reply-to`) now picks the reply by **tying the relay to the send of
its request** (a new CLI with a new server).

- The CLI opens the relay with `bind: true` on `POST /api/relays`, checks `bindMode: "bound"` in the
  answer, and puts `relayId` on the send (`POST /api/worktrees/:id/send`). The send API reserves the
  relay before any side effect such as starting the session (a wrong destination or id is 400; a closed,
  expired or already reserved relay is 409; neither types anything) and records the "input boundary" —
  the time, and whether a turn was open then — right before the first key of the body. When it cannot
  record it, the input does not start
- Only a turn that ended after the boundary counts. Turns that end before the send is confirmed are held
  as candidates, and once it is confirmed **the earliest candidate after the boundary** is taken. A reply
  to another request that ended while the send waited for the input lock, or a reply to a request whose
  send failed, is never delivered. Confirmation (prompt) notices follow the same rule: only a dialog still
  open when the send is confirmed is reported. A reply that is ready while a prompt notice is being
  delivered goes out after the notice
- The send API answers `sendOutcome` (`sent` / `not_sent` / `unknown`). The CLI withdraws the relay only
  on `not_sent` (nothing reached the session). A 409 reservation conflict does not withdraw it. When the
  answer is lost, the CLI asks `GET /api/relays/:id` and **does not resend** the message; when that does
  not tell either, the relay is left open and stderr names the relay id and
  `commandmate relays --id <relay-id>`
- An overlap is noted only when it is proven. The delivered body is the `[from <alias> / <worktree>]`
  line, one note line
  (`[CommandMate relay] Note: this reply may have been processed in the same turn as another request (overlap=later).`),
  then the reply verbatim. `overlap` is `later` (another turn was open at the input), `earlier` (another
  input arrived between the input and the reply), `both`, `unknown` (could not be told; never shown as
  "no overlap") or `none` (no note)
- A held relay publishes its `hold` reason: `send_unknown` (whether it was sent is not known),
  `dispatch_unknown` (opencode's HTTP send could not be confirmed), `generation_changed` (the session was
  relaunched during the send or before the reply), `server_restarted` (the server restarted during the
  send), and so on. A held relay delivers no reply and is replaced by the expiry notice at its deadline
  (24 hours by default). `commandmate relays --id <relay-id> [--json]` shows `send=` / `overlap=` /
  `hold=`, closed relays included, and the requester's "reply" history line carries `overlap=`
- opencode's HTTP send reports no input start, so the moment right before the dispatch is the boundary.
  When the HTTP send is confirmed not to have arrived and the terminal fallback types the body, the
  terminal input start replaces the boundary
- Relays opened by an older CLI, and older servers, behave as before (a new CLI prints one "legacy
  handling" line on stderr against an older server and does not send `relayId`)

**Limits until PR 3** (matching turns to replies comes in the next change):

- On claude and others, a request sent into a running turn may be carried to the next turn; the reply
  of the turn that ended first is then delivered with an `overlap=later` note, and the reply to the
  request's own turn is not delivered
- Two relays to one instance from different requesters can both receive one reply
- `earlier` is judged only when proven and can be missed (`unknown` then)

Not overlapping is still the safest: do not stack messages on one instance.

#### An uncertain delivery is never resent automatically (Issue #4064)

When delivering a relay reply, a confirmation (prompt) notice or an expiry notice to the requester's
composer ends with an **uncertain** outcome, CommandMate does **not resend that payload automatically**, so
that it cannot arrive twice.

- A delivery first records "attempting" in the ledger, before its first key, and only the delivery whose
  write succeeded sends (when the write fails, nothing is sent)
- Only a `not-sent` outcome (no key of the body was typed: `prompt-not-ready`, `session-starting`, ...) is
  retried automatically. A requester waiting on a dialog (`prompt_waiting`) is waited for and retried as before
- Everything else — `indeterminate` (`prompt-unreported`, `submit-unconfirmed`, `send-error`,
  `composer-residue`, ...), a failure after the send was confirmed (`threw-after-sent`), a failure before any
  outcome was known (`send-threw`), a server restart during the send (`server-restarted`) — is **held**
  (`uncertain`). A server that stopped right before the send, having typed nothing, also leaves the attempt
  behind and it is held after the restart (it cannot be told apart, so the safe side is taken)
- While a payload is held, the relay's later deliveries (a reply that finished after a prompt notice
  included) wait behind it. Other relays go on
- A hold is read with `commandmate relays` (`# delivery not confirmed, not resent`), `commandmate relays
  --id <relay-id>`, `GET /api/relays` (`held`) and `GET /api/relays/:id` (`deliveryHold`). The line carries
  `delivery=uncertain`, `payload=<kind>:<payloadId>`, `attempt=<attemptId>`, `reason=<reason>` and
  `check=<where to look>`, which is the requester's exact instance:
  `commandmate capture <worktree-id> --instance <instance> --pane`. Once you have looked, settle it with
  `commandmate relays resolve` below rather than resending it yourself (a resend of your own followed by a
  later `--retry` arrives twice)
- An expiry or a cancel (`commandmate relays cancel`) only stops later deliveries. The held payload's body,
  payloadId and reason stay readable (what already reached the composer cannot be taken back). A relay that
  expires while a payload is held gets no expiry notice delivered

#### Resolving a hold (Issue #4082)

An `uncertain` hold is settled, after looking at the requester's pane, with exactly one of the following.
`--payload` and `--attempt` are `payload=<kind>:<payloadId>` and `attempt=<attemptId>` from
`commandmate relays --id <relay-id>` (`deliveryHold.payloadId` and `deliveryHold.attemptId` in JSON and the API).

```bash
commandmate relays resolve <relay-id> --payload <payloadId> --attempt <attemptId> --confirm   # it arrived
commandmate relays resolve <relay-id> --payload <payloadId> --attempt <attemptId> --retry     # it did not: send it again
commandmate relays resolve <relay-id> --payload <payloadId> --attempt <attemptId> --discard   # drop it, send nothing
```

The API is `POST /api/relays/:id/resolve` (body `{ "payloadId", "attemptId", "action": "confirm" | "retry" | "discard" }`).

| Held payload | Relay | `--confirm` | `--retry` | `--discard` |
|---|---|---|---|---|
| reply | open | closed as `delivered` | the same body queued again | closed as `cancelled` (later payload dropped too) |
| prompt notice | open | hold dropped; the reply waiting behind it is queued in its place (relay stays open) | queued again | same as `--confirm` |
| expiry notice | closed | hold dropped | queued again, relay stays closed | hold dropped |
| reply / prompt notice | closed by a cancel or an expiry | hold dropped (closing reason kept) | refused (409) | hold dropped (closing reason kept) |

- `--confirm` and `--discard` type nothing. The reply queued after a prompt notice is settled is another
  payload and arrives by the ordinary delivery. The same dialog is not told again; a new dialog and the final
  reply arrive as before
- A successful `--retry` means "queued for delivery again", not "delivered". The next delivery sends it once,
  when the requester can take it (composer readiness and the input lock as for any delivery). If that send is
  `not-sent` it is retried automatically as before; if it is uncertain again it is held under a new `attempt`.
  A prompt notice queued again is still replaced by the relay's reply if one is decided before it is sent, as
  before. A reply or prompt notice of a relay past its deadline (even one still open) cannot be retried
- These are refused with 409 and change nothing: an old `attempt` (a retry made a new attempt since), a second
  operation on the same hold, a delivery in progress (`delivery=attempting`), no hold, a hold without an
  `attempt` (written by an older server), and the refusals in the table. A relay that does not exist is 404, a
  malformed id or body is 400, a database failure is 500 (nothing is committed). After a refusal, read it again
  with `commandmate relays --id <relay-id>`
- Resolving does not change the send binding (`send=`, `hold=`). Restarts behave as before: a payload retried
  but not yet taken stays queued, one whose send had started is held under its new `attempt`. A settled hold
  does not come back

#### Telling, showing and counting holds (Issue #4082)

- **The requester's history**: when a delivery is held (`uncertain`), one system line is left in the history
  of the requester A (with `relay=<relay-id>`, `payload=<kind>:<payloadId>`, `attempt=<attemptId>` and
  `reason=<reason>`). One line per attempt: another payload, or a new `attempt` after `--retry`, that is held
  again gets its own line. The line is best-effort (when it cannot be written, or the server stops before it
  is, there is none and it is not written later). The hold itself does not depend on it. The line is never
  read as a reply (`relays`, `wait`, the relay delivery)
- **The screens**: the PC and phone rosters and the chat surface show a hold on the requester A's row as
  "delivery unconfirmed" (warning colour), ahead of waiting and prompt. A held relay is not also counted as
  waiting or owed (a delivery in progress, `attempting`, stays waiting as before). Holds of closed relays are
  shown too. A hold whose requester instance is no longer in the roster is listed under the roster as
  "Unconfirmed deliveries to sessions not in the roster". The screens follow the 20-second re-read and the
  re-read after an action
- **The count**: `heldCount` in `GET /api/relays` is the number of holds now (`uncertain` only, closed relays
  included, once per payload). It is an axis of its own, apart from the per-state `counts`, never added to
  them, and not narrowed by `days`. `commandmate relays` prints `held=<n>`, `commandmate task show` adds
  `, <n> held` to its `RELAYS:` line and `commandmate report metrics` adds `, <n> held now` to its `Relays:`
  line. The `commandmate relays` listing shows the holds to settle (`uncertain`; the N of
  `# delivery not confirmed, not resent (N)` is the same as `held=`) apart from deliveries being typed right now
  (`attempting`; `# delivery in progress (N)`). In JSON, `task show --json` carries `relays` (per state) and `relaysHeld`, and `report metrics --json`
  carries `relays` and `relaysHeld`. An older server that does not answer `heldCount` gets no count printed
  (never 0), and `null` in JSON
- **Expiry while held**: the expiry sweep keeps the reply waiting behind a held prompt notice. When that closed
  relay's prompt notice (or that of a relay still open past its deadline and not yet swept: the settle itself then
  closes it as `expired`, with the usual "expired" system line) is then settled with `--confirm` or `--discard`, the waiting reply is discarded too
  (a closed relay delivers nothing more) and a system line in the requester's history says so (the API answers
  `replyDiscarded: true`). The expiry itself is told by the existing "expired" system line and the hold on the
  screens; no expiry notice is sent to the composer after the hold is settled

#### A delivery stopped by the requester's confirmation dialog (Issue #4105)

While the requester A shows a confirmation dialog, a relay delivery types nothing into A's composer (as
before). Why it is stopped is now readable, as what the **last delivery attempt** observed.

- **The field**: every relay in `GET /api/relays` (`owed`, `awaiting`, `open`, `held`) and `GET /api/relays/:id`
  carries `lastDeliveryBlock` (`{ reason, kind, payloadId, observedAt }`). `reason` is `prompt_waiting` (A's
  confirmation dialog), `generating` (A is mid-turn), `session_stopped` (A's session is not running) or
  `foreign_session` (a session of that name belongs to another server). It is not a current state but what the
  attempt at `observedAt` saw. Once the dialog is closed, the next delivery pass (about every 15 s) delivers
  and it goes away; the screens follow with their 20-second re-read
- **The payload it is for**: only an observation of the current payload (`kind`, `payloadId`) is shown. It is
  `null` once the payload was replaced, delivered, cancelled, expired or held (`deliveryHold`)
- **`null` does not mean "deliverable"**: it is kept in the server process only, never in the database. After a
  restart, before the first attempt, or when the attempt stopped for another reason it is `null`. An older
  server sends no such field
- **CLI**: the lines of `commandmate relays` and `commandmate relays --id <relay-id>` carry `pending=<kind>`
  (the payload waiting for the composer) and `blocked=<reason>@<observed time>`. `--json` is the API's answer
- **The screens**: the PC and phone rosters and the chat surface show "stopped by this pane's dialog" (warning
  colour) on the requester A's row, for `prompt_waiting` only. It comes after "delivery unconfirmed" and before
  the worker's confirmation. The waiting and prompt counts are unchanged
- **A notice still stopped after the expiry (Issue #4193)**: a relay closed by its deadline keeps the expiry
  notice until it reaches A's composer. While that delivery is stopped (`lastDeliveryBlock` set) the relay is in
  `closedBlocked` of `GET /api/relays` (scoped by the requester A), and `commandmate relays` prints it under
  `# closed, notice not delivered yet` as `expired`, `pending=expired`, `blocked=<reason>@<observed time>`
  (`closedBlocked` in `--json`). The PC and phone rosters and the chat surface show the same "stopped by this
  pane's dialog" for `prompt_waiting` (its tooltip says the notice stays until delivered, not that it is replaced at
  the deadline). A requester not in the roster (`instances remove` without `--kill` leaves its session running)
  gets it below the roster, under its own heading apart from the unconfirmed deliveries, with the reason. It goes
  away once the notice is delivered. It is never in `open` /
  `awaiting`, and `counts` / `heldCount` do not change. A closed relay with no stopped attempt is not listed
- **Not the `prompt` state**: `prompt` records that the worker B stopped on a confirmation and a notice to A was
  **queued** (not that it arrived). **It does not mean B is still waiting**: once B answers and the reply replaces
  the notice (`pending=reply`), `state` stays `prompt` until the relay closes. The roster says "Worker confirmation
  recorded"
- **No count changes**: the reason is never in `held`, `heldCount`, `holdReason`, `deliveryHold` or the
  per-state `counts`
- **Left alone**: at the deadline (24 hours by default) the waiting reply is replaced by the expiry notice (as
  before). The dialog is never closed automatically (Auto-Yes is unchanged)

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
| `lastSend` | How the last send to this instance ended (Issue #3759): `{ at, state, reason }`. `state` is `not-sent` (it failed before any key of the body was typed, e.g. `prompt-not-ready`) / `sent` (the submit was confirmed) / `indeterminate` (it failed after part of it may have been typed, or the outcome could not be read back; `reason: composer-residue` when the body is still in the composer; `prompt-unreported` when, on a new claude session's first send, the composer no longer showed the body after Enter but claude never reported the prompt with `UserPromptSubmit` (Issue #4035) — the body may still have been submitted (for example where only `SessionStart` arrives and the http `UserPromptSubmit` hook does not), so check with `commandmate capture <worktree-id> --pane` before resending; the screen is read once more right before failing and a generating screen makes it `sent` (Issue #4048); a session recreated while the send waits after its Enter is `indeterminate`, not `not-sent` (`session-replaced`), since the old process may have taken it (Issue #4048); a `sent` record turns `found-in-composer` when the next send finds that body still in the composer (claude only, and only the record of the send whose body it is; other tools only log the warning and keep `lastSend`, Issue #4048) — only while that send runs; the lasting record is the warn log `pre-send-found-submitted-body`). Null when this server has no record since it started; absent from an older server . The `not-sent` reasons include, besides `prompt-not-ready`, those from the input lock (Issue #3945): `input-lock-timeout` (the wait limit passed) / `session-replaced` (the session was recreated while waiting) / `input-lock-lost` (the lock's ownership was lost mid-input), `recheck-failed` (the re-read just before typing failed), `agent-not-in-foreground` (Issue #4300: the agent has exited and the pane is back at its shell, so nothing was typed; stop the instance's session with `commandmate instances <worktree-id> kill <instance-id>` and send again), `relay-reservation-lost` (Issue #3992: the reservation of the bound relay a `--reply-to` / `ask --async` send went in under was lost — cancelled, expired or taken by another send — right before the body), and `paste-not-started` (Issue #4031: a long body sent as one paste could not be loaded into the tmux buffer — `load-buffer` failed, so `paste-buffer` never ran; `not-sent` with or without a relay, and the send API's `sendOutcome` is `not_sent`; a failed `paste-buffer` stays `indeterminate` (`send-error`) / `unknown`); none of them typed any key of the body. The unsent bar's Clear (`POST /api/worktrees/:id/clear-composer`) returns 409 `INSTANCE_INPUT_BUSY` when it cannot get the same input lock or the session was recreated (wait a moment and retry), and returns HTTP 200 with `cleared: false` when the text could not be cleared |

**`lastSend` is not "the send that finished last" (Issue #4065).** When sends overlap, it follows the order in which the input lock was granted (its generation). It is not necessarily the reading request's own outcome (a request's own outcome is in the `send` error and the send API's `sendOutcome`).
- The record of a send that was granted the lock (including a `not-sent` refused after the grant, before the body) is not kept when a send granted the lock later already has a record for the same instance.
- A `not-sent` refused before any lock was granted to it (another server's session, a session still starting, a failed start, the prompt guard, a failed copilot `/model`, a lock wait that ran out, and the like) is not kept when a send granted the lock after that request began already has a record. A refusal on its own is recorded as before.
- When an old send fails late, after its Enter, its outcome is kept unless a send granted the lock after it already has a record (also after the session was recreated).
- **Paths kept in the order they finish**: copilot's selection-list commands and `/model`, and opencode's HTTP delivery (including its switch to keyboard input after an `unknown` dispatch) have no lock order, so they are recorded in the order they finish (and do not move the lock order either).
- The order lives only in the server process and is forgotten with the records on a restart. A worktree ID migration drops them rather than moving them. At most 1024 instances are tracked; an instance pushed out loses its record and its order together. The published fields stay `{ at, state, reason }`, and `at` is not an order.

**Whatever `lastSend` says, CommandMate never resends.** The sender — you or the supervising agent — does. Resend a `not-sent` message yourself once the input prompt is back. **Do not resend an `indeterminate` one** before checking the pane with `commandmate capture <worktree-id> --pane` (is the body still in the composer, or was it already submitted?); resending blind can deliver it twice. A `send` that fails with `prompt not ready` and the like carries the same state in its error (`[send state: not-sent (prompt-not-ready): …]`). The send API's failure answer carries `sendOutcome` even when the send is not tied to a relay, whenever the failure was recorded as its `lastSend` (`not_sent` for `not-sent`, `unknown` otherwise; another server's session (409), a session still starting (503 `SESSION_STARTING`) and a failed start are `not_sent`; a 400 refusal, which records nothing, carries none), and the CLI prints one stderr line saying either that it is safe to send again or to check with `commandmate capture <worktree-id> --pane` first (Issue #4011).

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
| 99 | Prompt already dismissed (`prompt_no_longer_active`) / the answer was not sent (`answer_not_delivered`) or stopped part-way (`answer_input_lost`, see below) |

#### An answer not delivered, and one stopped part-way (Issue #3975)

An answer that waited while a send or another answer held the input lock ([input lock (#3952)](#input-that-overlaps-a-send-input-lock-3952)) can end in one of two ways. Both exit 99, but the next step is the opposite:

| Reason | Printed | Meaning and next step |
|--------|---------|-----------------------|
| `answer_not_delivered` | `Error: Answer was not sent. Reason: answer_not_delivered (…). Nothing was typed, so it is safe to run respond again.` | Stopped before the first key. **Not one key reached the pane**; running the same `respond` again is safe |
| `answer_input_lost` | ``Warning: The answer may have been only partly typed (reason: answer_input_lost): … Check the screen with `commandmate capture <id> --instance <instance> --pane --tail 40` before answering again.`` | The session was replaced part-way through the keys and the rest were not sent. **Some of it may have reached the agent**; look at the pane first, then decide whether to answer again. The suggested command reads the pane the answer went to (the `--instance` or `--agent` the answer resolved to; neither when you named neither) |

`answer_input_lost` comes back from both `/prompt-response` and `/respond` as a 500 with `reason: "answer_input_lost"` and `keysSent: true` (Issue #3982; the other answer errors carry `reason` and `keysSent` on both routes too). On a server whose `GET /api/capabilities` lists `prompt-answer-reason`, the CLI decides by `reason` alone and never searches the 500's `error` text, which can quote the answer. On an older server without that token it reads the `error` text as before. `respond --plan-review` answers the same way (Issue #4031): when the session is replaced part-way through the plan review's keys (after at least one step was sent) it is `answer_input_lost` (500, `keysSent: true`); before the first step it is `answer_not_delivered` (`keysSent: false`, nothing was typed). The Web UI's answer panel also tells `answer_input_lost` from other failures and says that some keys may have reached the agent and to check the screen before answering again.

The other hints `respond` prints (`send` after `prompt_no_longer_active`, the plan review Next / Note, `send` when the chosen row asks for text, and the option-number hint after `unresolvable_answer`), `send`'s `PROMPT_WAITING` fallback (when the server sent no sentence) and its "check the pane before resending" `capture`, and the `capture` hints of `wait` and `attach` all name the same resolved target: an `--instance` alias as the id it resolved to, `--agent` alone as given, nothing when neither was named. A `capture` that is there to read a dialog is `--pane --tail 40`.

The server's own `PROMPT_WAITING` sentence returned when a send is refused (`send` and the terminal send, e.g. their 409) names the target when the request named an `--instance` (Issue #4031, e.g. `` `commandmate respond <id> <answer> --instance codex-2` ``); a request that named only a tool other than the worktree default with `--agent` gets ` --agent <tool>` (Issue #4049, e.g. `` `commandmate respond <id> <answer> --agent codex` ``, since a `respond` with no target goes to the default tool). A request that named none, or named the default tool, gets the sentence as before. The structured prompt's guidance (the `respond <number>` for a dialog only the hooks saw, e.g. the structured prompt of `/current-output`) is outside this `--agent` rule: `/current-output` passes the instance the server resolved, so whether it is read with `--agent` or for the primary, the guidance carries that resolved instance as `--instance <id>` (e.g. `` `commandmate respond <id> <number> --instance codex` ``), as it has since Issue #4031. The WebSocket push, the push after an Auto-Yes answer and the prompt history row carry the same sentence (Issue #4063; the primary's id is the tool name). The strict respond's (`--expect-screen`) failure hints name the resolved target too (exit 40: `` `commandmate prompt <id> --instance <instance>` ``; exit 41: that plus `` `commandmate capture <id> --instance <instance> --pane` ``). `prompt` takes no `--agent`, so after an `--agent`-only request they name that tool's primary instance, whose id is the tool name (Issue #4049, e.g. `` `commandmate prompt <id> --instance codex` `` / `` `commandmate capture <id> --agent codex --pane` ``); with no target named they stay `` `commandmate prompt` `` / `` `capture --pane` ``. The sentence with which `send` is refused while Command Code shows a plan review (REVIEW) names the real worktree id and, for an instance other than the primary, ` --instance <id>` (Issue #4049, e.g. `` `commandmate respond <id> "<text>" --instance command-code-2` ``). For the primary on a worktree whose default is not Command Code it names ` --agent command-code` (Issue #4063; on a Command Code worktree it names no target, as before). The terminal send (`POST /api/worktrees/:id/terminal`) answers this refusal with the same sentence as a 409 with `code: "PLAN_REVIEW_SEND_REFUSED"`, not the fixed 500.

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
| `--timeout <sec>` | Seconds before polling is abandoned, counted from before the start POST. The start POST and the run reads are included: one that does not answer is cut at the deadline, exit 124 (Issue #3983). So that a run finishing just before the deadline still reports its verdict, the last read is taken at the deadline itself (a read that starts within 2 s of the deadline may run until 2 s past it) | unlimited |
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

commandmate instances <worktree-id> add --agent codex --role reviewer  # Add an instance and set its role together (--no-role for no role)
commandmate instances <worktree-id> set-role <instance-id> --role reviewer  # Save the role for its next start (also --none / --inherit)
```

`add`, `remove`, `alias` and `send --register` save with the revision of the roster they read (Issue #4132). If the roster changed after the read, the change is rebuilt on the current roster, up to 2 more times, so another add or change is not erased. The id is one that is free in the current roster. If the roster keeps changing, `add`, `remove` and `alias` end in exit 31 (`roster_changed`) and other changes stay (`remove --kill` stops the session and then saves, so the session may have been stopped). `send --register` has sent its message by then, so this and any other failure to register (Issue #4159) warn, exit 0 and name the command that registers it.

`kill` also disables Auto-Yes for the instances it stops (Auto-Yes of instances it did not stop is kept).
A successful `kill` (and `remove --kill`) appends one line to `~/.commandmate/session-kills/<UTC date>.jsonl`
(kept 30 days): the worktree and instance, the tmux sessions the server says it stopped (`killedSessions`),
and where it was asked from (cwd and tmux session). The server records its own kills there too — the
kill-session API (the UI's stop button) and the cleanup of worktrees that sync or a repository removal dropped.

The env-clean verification gate sets a vanished sibling session apart as `external` instead of failing on it
only when a CLI line names exactly that session and its caller is known not to be the worker: its cwd is a
sibling directory of the task's worktree (the primary checkout, another worktree or any other directory next to it; it need not be a worktree), or it ran inside another
worktree's tmux session, and neither is the task's. Still a failure (Issue #3993, #1624): a worker stopping its
neighbour itself; a caller outside tmux in a directory that is not next to the worktree (`/tmp`, `$HOME`); the UI's stop
button, the server's cleanup (`commandmate sync`, repository removal) and bare API calls such as curl — a
worker can cause each of these, so the report only notes `· mcbd-…: kill recorded but counted (…)`; another
instance of the same worktree the line does not name; and any kill that bypassed CommandMate
(`tmux kill-session`). A worker that `cd`s into the neighbour and stops it from outside tmux cannot be told
apart by the record and is excused. A CLI kill is written twice (the CLI's line and the server's), and only the
CLI's line can excuse.

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

## commandmate roles

Manage role definitions and defaults without the screen (Issue #4116). The body comes from `--file` or stdin, and nothing is interactive.

### The three operations

| Operation | What changes | Running sessions |
|-----------|--------------|------------------|
| `roles edit` | The role's text. Every setting pointing at it follows, from its next start | Unchanged |
| `roles default` | The default per tool (`--repo` for that repository, otherwise the system level). Schedules follow too | Unchanged |
| `instances <wt> set-role` / `send --role` | That instance's setting | Unchanged. A role is fixed when the process starts: stop it (`instances <wt> kill <id>`) and send again to apply |

### A role is not a permission

A role is an instruction to the model. It limits nothing. The text sent with it at the start says that the request, an execution contract and the project instructions (`AGENTS.md` and the like) come first.

For example, send an implementation contract under a "do not edit" role and the agent edits and commits, and `wait --verify` sees the real work and returns exit 0 (checked with Claude on 2026-11-04). To be sure nothing is edited, do not rely on a role: use the CLI's own permission settings, and do not send an implementation contract.

### Usage

```bash
commandmate roles list [--json]
commandmate roles show <role> [--json]
commandmate roles add <name> (--file <path> | --stdin) [--json]
commandmate roles edit <role> [--name <name>] [--file <path> | --stdin] [--if-version <n>] [--json]
commandmate roles rm <role> [--force] [--json]
commandmate roles default <tool> (--role <role> | --none) [--json]
commandmate roles default <tool> --repo <repository> (--role <role> | --none | --inherit) [--json]
commandmate roles defaults [--repo <repository>] [--tool <tool>] [--json]
commandmate instances <worktree-id> set-role <instance-id> (--role <role> | --none | --inherit) [--json]
commandmate instances <worktree-id> add --agent <tool> [--role <role> | --no-role]
commandmate send <worktree-id> "..." --instance <id> [--role <role> | --no-role]
```

Example: define a reviewer and make it this repository's Codex default.

```bash
commandmate roles add reviewer --file ./reviewer.md
commandmate roles default codex --repo . --role reviewer
```

### Naming

- `<role>` is an ID or a name. An exact match wins; failing that, one ignoring case and Unicode form. Two candidates is exit 2 with both listed, never a pick
- Nothing is reserved. "No role" and "follow the defaults" are the flags `--none` / `--no-role` / `--inherit`, so a role can be called `none`
- Tools are claude, codex, command-code, opencode, opencode-v2, copilot and antigravity. Any other is exit 2 (`tool_not_supported`). Antigravity can hold settings, but a start with a role is refused until it is enabled, and the command warns

### `--repo` forms and precedence

1. A repository ID
2. A path (a value containing `/` or starting with `.`). A registered repository, or a registered worktree's path, which means its repository (so `--repo .` works inside a worktree)
3. A name (a value with no `/` is never read as a path)

See what is registered with `commandmate roles defaults`. Errors say which: `unknown_repository` (no match), `repository_not_registered` (a directory with no row), `ambiguous_repository` (several, listed). A repository with no setting for a tool is not an error: it reads `stored: { state: "inherit" }`, and `effective` says what it gets instead.

### `send --role` and `--register`

`send --role` is a condition, not a switch.

- The setting is saved first. A session that is not running starts with it
- A running one gets the message only if its startup fingerprint matches. Another role, or no record of its start (after a server restart, say), is exit 32 with nothing typed. The setting stays saved, so stop the session and send again without `--role`
- Only an instance on the roster can hold a role. An ad-hoc id needs `--register` as well
- `--register --role` creates the instance and its role **before** sending, so the first start has it. Repeating it creates nothing: `--role` replaces what the instance holds and is a condition as above. A roster changed after it was read is exit 31, nothing sent
- `--register` without `--role` keeps its old order (sent, then registered) and leaves any role alone. The message has gone out by then, so a roster that keeps changing is a warning and exit 0, not exit 31. So is any other failure to register: a failed roster read, a 5xx, another 409 (Issue #4159; a 5xx or no answer may have saved it, so check with `commandmate instances <worktree-id>`, as the warning says). Do not send the message again: the warning's command (`commandmate instances <worktree-id> add --agent <tool> --id <instance-id>`) registers it
- `--contract --role` ends the same way. If the contract's own check would refuse for the old setting, the role is saved and the check runs again. A broken contract saves nothing. The save is conditional on the revision of the roster just read (Issue #4132): if the roster changed after that, nothing is saved and it exits 31 (`roster_changed`)
- When a send with a role or a pin types nothing, the `--auto-yes` it armed is withdrawn, naming the tool and instance, and only if it reads back as that grant. A grant already on stays as it was until the message is in. A grant updated since, or a send that cannot be said to have typed nothing, leaves it on, and the command to stop it is printed. With no target named, the default it read is named in every later request, so a default changed meanwhile neither overwrites nor withdraws another target's Auto-Yes (a server answering for another target than the one read gets no withdrawal, only the command to stop it)
- Withdrawing and arming are conditional requests that go by the grant's id (Issue #4132). A grant another operation armed after the read-back is not turned off, even with the same expiry and answer mode. If another operation armed one first, its terms are not overwritten: this send's terms apply once the message is in. A server too old to return a grant's id is sent no unconditional withdrawal: the grant stays on, and the command to stop it is printed (Issue #4159)
- `--auto-yes` with no role, pin or `--reply-to` reads nothing first (decided in Issue #4159). It cannot tell a grant it armed from one already on, so a send that types nothing leaves it on, and the command to stop it is printed. Reading first would add a request to every such send, and would move the new terms of a grant already on to after the message
- A refusal that can be checked before the save (`--model` on a running session, a bad image path) leaves no setting. A refusal after the save says the setting stayed saved, whatever refused it
- OpenCode V1 goes on with the conversation it remembers, even under another role, and what the earlier role said stays in its history. Stopping the session does not forget it. To start a new one, stop the session and send with `--new-conversation`. Another tool, or a session running or starting when this checks, is exit 2 with nothing sent (a start between that check and the send is not detected)
- `--expect-role-generation <g>` with `--expect-role-fingerprint <f>` / `--expect-no-role` pin the send to what the caller read (`capture --json`'s `roleLaunch`), saving nothing. The server reads them again right before the first key, so a process replaced in between, even with the same role, gets nothing: exit 32. They combine with `--contract` and `--role`
- `send --contract` to a running session with no evidence of its start (this server did not start it, or started it before restarting) is not refused. Only when the settings give that session a role, one `Warning:` line goes to stderr and `POST tasks` answers with `roleWarning` (Issue #4132). The task id on stdout and the exit code do not change. To apply the role, stop the session and send again. To refuse such a session, pass `--role` or `--expect-*` (not sent, exit 32)

### `set-role` and `instances --json`

`set-role` saves for the next start, running or not, and leaves a running process alone. It compares the two, and only a difference gives `applyPending: true` (`Pending:` in text). `restartPending` is `yes`, `no` or `unknown` (nothing known about the process).

Each `instances --json` row has `role` when the server has roles:

```json
{
  "role": {
    "stored": { "state": "role", "roleId": "...", "roleName": "reviewer" },
    "effectiveNext": { "kind": "role", "source": "instance", "role": { "id": "...", "name": "reviewer" }, "injectionFingerprint": "..." },
    "launched": { "roleName": "writer", "source": "system", "sessionGeneration": "...", "injectionFingerprint": "..." },
    "requested": { "roleName": "writer", "source": "system" },
    "restartPending": "yes"
  }
}
```

With `--require-roles` a role that cannot be read fails the command instead of being left out (a server older than roles says `role_api_unavailable`). A null `launched` means not known, which is not "no role". The table appends `ROLE_AT_START`, `ROLE_NEXT` and `RESTART_PENDING`.

### `--json` shapes

Failures included, on stdout (the same sentence goes to stderr). A failure with no role code of its own says `internal_error`, `request_failed`, `no_response` (no server), `role_api_unavailable` (a server older than roles) or `unexpected_error`, with the exit codes below. A missing argument or unknown option is commander's: stderr only, exit 1. A request changing a role setting (`roles add` / `edit` / `rm` / `default`, `set-role`, `add --role`) that ends in a 5xx or no answer may have saved, so it says that is not known and how to check (`--json`: `saved: "unknown"` and `check`). A 4xx saved nothing. `send` has no `--json`; `send --register --role` and `--contract --role` print the same sentence on stderr.

| Command | Shape |
|---------|-------|
| `list` | `{ success, roles: [{ id, name, bodyVersion, bodyFingerprint, bodyBytes, createdAt, updatedAt }] }` |
| `show` | `{ success, role: { ..., body }, references: { instances, repositories, system } }` |
| `add` | `{ success, role }` |
| `edit` | `{ success, before, after, bodyVersion, affected, impact: { schedules, runningSessions, message } }` |
| `rm` | `{ success, deleted: { id, name }, affected }` |
| `default` | `{ success, level: "system" \| "repository", cliToolId, repository?, before, after, impact: { repositories, schedules, runningSessions, message } }`; `before` / `after` are `{ stored, effective }` |
| `defaults` | `{ success, system: [{ cliToolId, adapterEnabled, stored, effective }], repositories }`; with `--repo`, `{ success, repository, defaults: [{ cliToolId, adapterEnabled, stored, effective }] }` |
| `set-role`, `add --role` | `{ success, instanceId, cliToolId, adapterEnabled, stored, effectiveNext, launched, requested, restartPending, applyPending, rosterRevision }` |
| Failure | `{ success: false, error: <code>, message, candidates? \| references? \| currentBodyVersion? \| saved?: "unknown", check? }` |

`stored.state` is `role`, `none`, `inherit` (no row) or `unset` (system, no row). `effective.kind` is `role`, `none` or `ambiguous`. `effective.source` is `repository`, `system` or `fallback`.

### Exit Codes

| Code | Meaning |
|:----:|---------|
| 0 | Done |
| 1 | The server is not running |
| 2 | Bad arguments, a body that cannot be stored, an unknown or ambiguous role or repository, an instance not on the roster, a tool outside the feature |
| 31 | A conflict; nothing changed or sent: `name_conflict`, `name_changed` (another rename landed during `edit --name`), `version_conflict` (`--if-version`), `role_in_use` (`rm` without `--force`), `instance_exists`, `roster_changed` (also from `instances add` / `remove` / `alias` without a role, when the roster keeps changing and cannot be saved). The exception: `remove --kill` stops the session and then saves, so the session may have been stopped even though the roster did not change |
| 32 | The body was not typed: the role condition does not hold (`ROLE_CONDITION_UNMET`), or the start was refused because of its role (`ROLE_LAUNCH_REFUSED`, `SESSION_LAUNCH_ROLE_MISMATCH`). `send` / `ask` |
| 99 | Anything else |

---

## commandmate mem

Typed items that carry the state of a piece of work across sessions (Issue #4221, Epic #4220). Only what CommandMate cannot know itself (intent, the next step, who you are waiting for, decisions, outside state) is kept, each with a condition that closes it. Items belong to a registered repository and a branch, so they survive a worktree made again for the same branch.

### Turning it on (the screen only)

Off by default. The mode (`off` / `derived` / `on`) is set on **the "mem" of each row of the Repositories screen**, as branch-name rules (the first that matches from the top; `*` stays within `/`, `**` crosses it; a `detached HEAD` row) and per-branch overrides. Precedence: the branch override → the rules → `off`. **The CLI has no way to change the mode** (`mem mode` only reads it). Writes (`now` / `add` / `update` / `close`) go through only on a branch whose mode is `on`; `off` and `derived` answer exit 50 and store nothing.

### Usage

```bash
commandmate mem now "<text>" [--close-when <cond>] [--evidence <ref>]
commandmate mem add --kind <kind> (--text "<text>" | --stdin) [--close-when <cond>] [--promote-to <dest>] [--quote "<words>" --quote-at <ts>] [--evidence <ref>] [--key <key>]
commandmate mem update <id> --if-version <n> [--text … | --stdin] [--close-when …] [--evidence …]
commandmate mem close <id> [--reason "<text>"]
commandmate mem list [--all] [--branch <name>] [--json]
commandmate mem check [--branch <name>] [--json]
commandmate mem check --suggest [--instance <id>] [--json]
commandmate mem check --suggest --quiet [--hook <event>]
commandmate mem mode [--json]
commandmate mem purge --branch <name> [--closed-only] [--kind <kind>] [--before <ts>] [--include-decisions] --confirm
```

- Inside a session the target is your own instance (`whoami`). In an ordinary shell, writes need `--worktree <id> --instance <id>`, and `list` / `mode` / `purge` need `--worktree <id>` or `--repository <id> --branch <name>` (otherwise exit 2 `target_required`)
- `now` is the session's note (#2427). Up to 100 characters. The next `now` replaces it; the previous content is kept as `superseded` (the newest 20 per slot)
- Kinds: `now` / `waiting` / `decision` / `next` / `external` / `note`. `--close-when` is required for `waiting` / `next` / `external`; omitted, `now` → `replaced`, `note` → `manual`, `decision` → open until promoted
- `--close-when`: `manual` · `replaced` (now only) · `issue:[host/owner/repo]#N` · `pr:[host/owner/repo]#N[?state=merged|closed]` · `branch:<name>?merged=<ref>[&scope=local|remote]` · `branch:<name>?deleted` · `relay:<id>` · `worktree:<id>` · `session:task:<id>` · `session:verify:<run id>` · `session:schedule:<execution log id>` · `at:<ISO 8601 with an offset>`. `session:` takes only the three runs CommandMate records the end of (no tmux session name, no PID). `branch:…?deleted` also stores the tip at the time of writing (empty when the ref does not exist)
- Only the instance that wrote an item (its same incarnation) and a person (on the screen) may `update` / `close` it. An instance removed and made again under the same id is another incarnation and cannot change the earlier items (exit 55)
- `add` with `--key` answers the first item to a retry with the same key and content (`replayed: true`); different content is exit 54
- `purge` deletes nothing without `--confirm` and shows the counts. Recorded / promoted decisions are left out unless `--include-decisions`. Refused from inside an agent session (exit 55)

### Evaluating the close conditions (Issue #4222)

Conditions are **evaluated when read** (`mem list`, `mem check`, the brief); nothing watches in the background and nothing polls. Only a branch in mode `on` is evaluated; `off` / `derived` ask nothing and close nothing (`mem check` exits 50). Each result is one of three, with a fixed reason word (`reason`): `list --json` carries `conditions` (by item ID), `check --json` carries `results`.

| Result | Closes? | Examples |
|---|---|---|
| `met` | Yes (`close_reason=condition`, `updated_by=server`), with one end record (condition, what was observed, end reason, outcome) and one "it ended" notice | `issue-closed`, `pr-merged`, `branch-deleted`, `relay-delivered`, `task-succeeded`, `worktree-deleted`, `time-passed` |
| `not-met` | No | `issue-open`, `not-merged`, `no-new-commits`, `relay-delivery-attempting`, `task-running` |
| `unknown` | **No** | `not_found` (404), `unauthenticated`, `forbidden`, `rate_limited`, `offline`, `query_timeout`, `gh_unavailable`, `host_not_allowed`, `branch-diverged`, `branch-order-uncertain`, `relay-delivery-uncertain`, `session_kind_unknown`, `query_budget_exhausted`, `deadline_exceeded`, … |

- **Met, per type**: `issue` closed (the outcome from `state_reason`); `pr` merged (closed with `?state=closed`); `branch … merged` means it reached `into` with commits after the tip it had when written (merged into another ref, or a new branch with no change yet, is not met; `scope=remote` sees a squash merge through the GitHub PR); `deleted` means the ref is gone (not "could not be read"); `relay` delivered (`expired` / `cancelled` are met with outcome `failure`; never closed while a delivery hold or an undelivered payload remains); `worktree` deleted (a rename is not met); `session` a terminal task / verify / schedule state (`running`, `waiting_input` are not met); `at` the time has passed
- **Query limits**: per evaluation, 8 GitHub / `git ls-remote` queries (5 s each), 24 local git queries (3 s each), 10 s in all. The same target is asked once. Items past a limit are unknown
- **GitHub hosts**: only `github.com` and the host of the item's repository's `origin` are asked (others: `host_not_allowed`). No `git fetch`
- **Re-created branches**: a branch deleted and made again under the same name is another branch (locally told apart by its reflog's creation time; one made in the same second as the item cannot be ordered and stays unknown). Use `pr:` to follow a remote one exactly
- **Decisions**: a decision met before it is promoted stays open, marked `unreflected`
- **The "it ended" notice**: the author's session (the same instance incarnation) gets it once, in its next brief. A `check`, another instance's brief or the screen's preview evaluating first does not use it up. If the author's incarnation has ended, the next session of the same branch gets it; if none, it stays in the screen's undelivered list (`GET /api/repositories/:id/mem/notices?branch=`) for a person to take

### Prompts to update (`check --suggest`, Issue #4226)

`mem check --suggest` applies the prompt rules to your own items and your own `now`. It runs no model, adds no watcher and changes no hook settings (no hook hands a line back to the agent's context; at a conversation boundary the brief does, and before a summary or at the end of a turn a skill's steps call this command).

| code | When |
|---|---|
| `now_missing` | Your instance has no `now` (instances on the roster only) |
| `now_stale` | Your `now` has not been updated for a day |
| `now_condition_met` | Your `now` closed because its condition was met (not with `--quiet`) |
| `decision_unreflected` | An `open` / `recorded` decision is stale (14 days), or met but not reflected |
| `manual_stale` | A `next` / `external` / `note` closed by `manual` is stale |
| `open_count` | The open items of the branch reached the warning count (the same formula as `mem list`'s warning) |
| `ref_unknown` | A condition's reference is not found (`not_found` / `relay_not_found`; not with `--quiet`) |
| `evidence_missing` | A `path:` of `evidence` is gone (a symbolic link counts as gone) |
| `decision_no_destination` | An `open` decision has no destination (`promote_to`) |

- It looks at items you wrote (the same incarnation of the instance; a rename of the worktree id keeps them) and items a person wrote on the screen. **It does not find an intention that should have been written and was not** (it sees the state of what is written, and an empty `now`)
- What it prints is a fixed sentence per code with ids and versions; never an item's text or a branch name. `branch` in `--json` is replaced as the brief does (`null` for a branch with a secret-like value or invisible characters)
- **Exit codes**: **57** when there is at least one prompt, 0 otherwise. Mode `off` / `derived`: nothing on stdout, exit 50. With `promptOnEvents` (the screen's mem settings) off, no prompt and exit 0 (`disabledBy: "promptOnEvents"` in `--json`). When the mode, the settings, the branch, the registration or the lifetime of the instance or worktree changed during the evaluation: nothing, exit 0 (`discarded` in `--json`, one line on stderr saying to run it again)
- `--suggest` evaluates the conditions (like `mem list`, it may close what is met). It says whether a prompt was shown (`shown`) and prints everything every time
- `--quiet` is what a skill's steps call. It **always exits 0**, prints only the prompts this instance has not been shown, in one line (280 bytes at most), and records them. It asks no condition. The record is in the database: **the same state is not prompted again, a server restart included** (going back to a branch, or to another registered root of the same Git, prompts nothing while their state is unchanged). A new conversation boundary, a new incarnation of the instance or a new state (an item's version, ...) prompts once. No identity, or an `--instance` that is not yours: nothing. `--json` loses to quiet. A flag error commander refuses (an unknown flag) is exit 1 as ever
- Known limits: a prompt recorded by the server whose answer did not reach the CLI within its deadline (4 seconds) is recorded and never shown (the server's 3-second deadline counts from when it takes the request, not the time the CLI spent before that, such as resolving the session identity, so it does not close this gap). The records of an instance off the roster, a branch git no longer has, or a root whose registration was removed stay until the next `--quiet` in that worktree or until the worktree is deleted
- `--hook <event>` (`session_start` / `pre_compact` / `turn_end` / `manual`) marks where it was called; it is logged and echoed in `--json` only
- A process with the same OS rights can call the API (`POST /api/worktrees/<id>/mem/suggest`) directly and use up another instance's record. Like the author check, this stops mistakes, not intent

### Checks on the free fields

Every free field (`text`, `quote`, `evidence`, `promote_to`, `reason`) is checked on the server for its length limit, secret-like strings (tokens, keys, `password=`, …) and control characters. `path:` in `evidence` and `promote_to` takes repository-relative paths only, and refuses absolute paths, `..` leaving the repository, a symlink on the way and files like `.env`. A refusal shows only `code`, `field` and `rule` in the error, `--json` and the log — **never the refused text itself**.

### Exit codes

| Code | Meaning |
|:----:|---------|
| 0 | Done (also a `--key` retry answering the existing item) |
| 1 | The server cannot be reached |
| 2 | Invalid input (`invalid_close_when` / `control_char` / `secret_like` / `too_long` / `absolute_path` / `outside_repository` / `symlink` / `sensitive_path` / `invalid_evidence` / `invalid_key` / `target_required`, …); nothing stored |
| 50 | `disabled`: the branch's mode is `off` or `derived`; nothing stored (`check` asks nothing either) |
| 51 | `version_conflict`: `--if-version` is not the current version; the stored item is returned |
| 52 | `not_registered` / `item_not_found` / `instance_not_found` / `branch_unresolved` |
| 53 | `ambiguous`: registered roots of one git whose settings differ, a root git cannot identify, or a registration that kept changing |
| 54 | `duplicate_key`: the same `--key` with different content |
| 55 | `not_owner` / `state_forbids`: not the author (another incarnation included), a state that does not allow it, or `purge` inside a session |
| 56 | `limit_exceeded`: too many open items on the branch (30 for `waiting` / `next` / `external`, 50 for `note`; `decision` only warns) |
| 57 | `check --suggest`: there is at least one prompt (Issue #4226; `--quiet` always exits 0) |

### Recording a decision in its canonical place (screen only, Issue #4225)

A `decision` is written to an Issue / PR comment or a worktree document (`promote_to`) **only when a person approves the diff on the screen** (the "mem" of each row of the Repositories screen → "Record decisions in their canonical place", `/repositories/<id>/mem/decisions?branch=<name>`). **The CLI has no way to do it** (`commandmate mem` has no promote / approve sub-command). No other path — the brief, `check`, prompts, Schedules — writes.

1. Choose the item and a worktree and press "Make the diff". The whole body, the destination as resolved (`Issue <host>/<owner>/<repo>#N`, or `<worktree> (<branch>): <path>`), the account that posts, the effect ("changes the specification" by default / "record only") and the expiry (30 minutes) are shown. Changing the worktree, the effect or the quote's check drops the diff shown (make it again before approving). A quote an agent wrote is shown beside its check and written as "recorded by the agent (unchecked)"; it becomes "checked by a person on the screen" only when you tick the check after comparing it with the original (the check is cleared when you choose another item). Free text (the decision, the quote) goes inside code blocks, and invisible characters are shown as `[U+XXXX]`
2. Press "Approve and write". Right before writing, the item's version, the destination (host, repository and number, or worktree, branch and path), the fingerprint of the content the diff was made from, the worktree's lifetime, the mode and the poster are checked again; if any changed, **nothing is written** and a new diff is asked for (another session changed the document after the approval, the worktree was deleted or switched to another branch, the same item was approved in parallel, …)
3. Once written, "changes the specification" leaves the item `recorded` (**not reflected**: only recorded as a comment or in a document, not yet reflected in the canonical place such as the Issue body), and "record only" makes it `promoted`. A `recorded` item becomes `promoted` when a person reflects it and presses "I checked it is reflected in the canonical place"

- **Documents**: a marked block is appended at the end of an existing document (never rewritten or replaced). `.md` only, up to 1 MiB. A path outside the repository, an absolute path, a symlink, `.git`, `.env` and the like are refused. **Agents' instruction files are refused too** (a record an agent wrote is never read as an instruction by the agents after it): anything under `.claude/`, `.agents/`, `.codex/`, `.gemini/`, `.agent/`, `.cursor/`, `.windsurf/`, `.clinerules/`, `.commandcode/` or `.opencode/` at any depth, files named `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md` or `CMATE.md`, and `.github/copilot-instructions.md` and anything under `.github/instructions/`, `.github/prompts/`, `.github/chatmodes/`, `.github/skills/` or `.config/opencode/` (case-insensitive; every root an agent was measured to discover Skills from is always among them). A new document appears whole through `link` from a temporary file (a `.commandmate-promote-<id>.tmp` left behind is taken back by the reconcile). **Nothing is committed or pushed** (the change stays in the worktree)
- **Comments**: the body starts with a mark naming the operation (`<!-- commandmate-promote:op=…; item=… -->`). The poster is fixed by the token read once with `gh auth token --hostname <host>`, given to both the check and the post (the token is never stored or shown)
- **Unknown outcomes**: a lost answer, a timeout, a database update that failed after the write, a restart and the like are kept as "outcome unknown" and **never sent again by themselves**. "Reconcile" on the screen looks for the mark (for a comment: the poster and the body's fingerprint; for a document: the block). If it is not found, the outcome stays unknown until a person presses "I checked it is not there" (on GitHub or in the worktree)
- **The mark is found but not what was written** (the comment was edited, the document's block was changed by hand): the outcome stays unknown, and the reconcile shows "What was found (as it is now)" beside "What was meant to be written (the approved body)". If you judge from both that it was written, press "Treat as written" (recorded as succeeded and the item moves; nothing is written outside). Pressing "I checked it is not there" here lets the next approval write the same decision again
- When the write succeeded but the item did not move (the worktree was re-created, the version changed, the mode is not `on`), the screen says so, and "Treat as recorded" makes the transition only (nothing is written outside)
- The mode is that of **the item's branch** (not the chosen worktree's current branch). With several roots of the same Git, it is written only when every root agrees the item's branch is `on` (roots whose settings differ write nothing)
- An operation whose outcome is not settled stays on the screen under "Operations still unsettled after their item was closed or deleted" after the item was closed with `mem close` or deleted with `mem purge`, and can still be reconciled. A worktree whose id changed by a rename is reconciled as the same worktree (one deleted and made again is another)
- A write that succeeded after its item was closed or deleted cannot move the item (a closed item never moves). The screen offers only "Treat as recorded (the outcome only; the closed item does not move)", which records that a person checked the outcome (the item stays closed)
- When the roots of the same Git disagree on the setting of the item's branch, the screen warns and stops listing and approving decisions, but keeps showing the operations whose outcome is not settled; they can still be reconciled or checked as not there (the item does not move until the roots agree)
- The screen of any root of the same Git reconciles and settles the operations of that Git's roots (a root of another Git does not reach them)
- Invisible characters in the branch or the author are warned about too. A branch is written in its omitted form (`(省略 N bytes・reason)`)

### Viewing and writing items on the screen (screen only, Issue #4227)

A branch's items are shown under **the "mem" of each row of the Repositories screen → "View items"** (`/repositories/<id>/mem?branch=<name>[&worktree=<id>]`), where a person adds, edits and closes them. The PC and the phone share the screen (at a phone's width the rows only wrap). **The CLI has no way to do it** (the screen's writes accept requests with the mark only).

- The top shows the branch's mode and what decided it (an override, a rule, the default). `derived` is "frozen", and this screen cannot write either. `off` lists nothing (the items are kept). "Change the mode and features" opens the mem settings in place, where an override for this branch can be added
- The list has a section per kind; each row shows the author, the owning instance, who updated it, the version, the close condition and its answer (`{result:reason}`) and staleness. A recorded decision shows "Not reflected: recorded only, not yet reflected in the canonical place". Recording and reflecting a decision is done on the decisions screen above, through "Record and reflect" (this screen does not write it)
- To write, choose a worktree of this branch and an instance of its roster (an item is owned by an instance). The author and updater are `human`. When the worktree's current branch is not the screen's branch, it is read only. An add makes one key per request. When the result is unknown (a timeout, a lost connection), the input is held and "Send the same again" sends the same content with the same key, so even if the first request was written there is still one item (the same item comes back). The request sent again does not change: it keeps the worktree, instance, content and key it was sent with (one per operation — the add, and each item's edit and close — and another operation finishing does not drop it; while it remains, other writes wait — see "Concurrent edits" below). When the worktree or instance selection is changed, the screen says it cannot be sent with that selection, and you choose "Go back to that destination" or not to send it again. An edit or close sent again has no key, so a 409 to it (whether the first request was written or someone else changed the item) is never shown as saved: it goes back to the concurrent-edit comparison. If the worktree's HEAD moved to another branch, nothing is written and the add is refused. For the kinds that need a close condition (waiting, next, external) the field says "required"
- **Items a person wrote**: an item a person added on this screen (author `human`) cannot be changed or closed through `commandmate mem update` / `mem close`, even by the agent of the instance chosen as its owner (exit 55, `not_owner`). Only a person (this screen) changes or closes it. A close by its condition (the server's evaluation) still applies to any item
- **Buttons**: only what the current state allows is offered (a recorded decision has no "Edit"; a reflected decision closes with "Close", an open one with "Withdraw")
- `now` (each session's current state) is not added or edited here; write it from the session note on the worktree screen as before
- **Concurrent edits**: an edit and a close send the version read when they were opened (a read of the list meanwhile does not replace it). An edit sends only the fields you changed (emptying the evidence sends "no evidence"; a field you did not change is not sent, so what someone else wrote meanwhile stays). If it changed elsewhere (another page, an agent's `mem update`, a close by condition), nothing is written; for an edit, **your draft, the value you read and the current value** are shown side by side with the text and the evidence, along with the fields saving on top would send. Only pressing "Save my draft on top of the current value" sends it again with the new version (it is never laid on top by itself). For a close, what you read and the current value are shown, and "Close it again, having seen the current value" starts the confirmation again. The comparison is shown above the list, not inside the item's row. The resend of an edit or a close whose result is still unknown is in the item's row while the item is listed, and above the list once it is not (for example, it was closed and left the default list). Either way, when the item was closed and left the default list (closed items hidden), you can still check them without choosing "Show closed items" (for example, a close whose answer was lost and whose resend finds it already closed: the current value says closed, and no "close again" is offered). Opening or saving another item's edit or close does not remove a comparison. **While a request is being sent, or a request whose result is unknown remains, no other write (add, edit, close, save on top, close again) can be made: it waits** (the screen says why; this keeps anything from being written twice or mixed up). Send that request again or press "Do not send again", and writing is possible again. Reading again and changing the worktree or instance still work. A resend (and a request being sent) keeps the content it sent and cannot be changed; to give it up, press "Do not send again" (the list is read again, so you can check whether it was written)
- **Stale pages**: the screen reads the list again when it gets the focus back and every 30 seconds, and marks a row whose version moved as "Updated"
- **Closing a recorded decision**: a `recorded` decision you decide not to reflect closes only after a two-step confirmation ("This decision is recorded; it will be closed without being reflected in the canonical place. Comments and other records stay"), with the reason `withdrawn`. `commandmate mem close` still refuses `recorded` (exit 55). Closing an open decision is a withdrawal (`withdrawn`)
- **Undelivered notices**: the "it ended" notices no session took are listed, each with "Take it"
- Of the mem settings' features, "Pop-ups" is the attended or unattended (the default) setting. On a branch with it on and mode `on`, "end" shows the hand-off screen ("commandmate handoff" below). It is separate from auto-yes; neither changes the other
- **Asked when a session opens** (Issue #4227): on a branch with Pop-ups on, mode `on` or `derived` and "inject on start" on, the first send after a conversation boundary (a launch, a restart, a reset…) first shows three lines (open items and how many decisions are not reflected, questions waiting for a person, the last update) and three choices: **read the short brief** (the default, as before), **read it all** (entries that fit the budget are not cut at 512 bytes; the whole budget and the line limit still hold), **don't read this time** (this boundary's brief is not attached, nor on the next send; the note about how the last session ended is not delivered either). Closing sends nothing and leaves the text and the image in the composer; they are cleared only once sent. When the boundary changed after it was shown (another launch or reset, another send is delivering the brief, or the mode, inject on start or the branch changed while the send waited) nothing is typed (409 `boundary_changed`) and you are asked again with fresh lines. Questions that could not be read are shown as unknown, never as none. A command (a send starting with `/` or `!`) is not asked about (calling the API directly with "read it all" or "don't read" for a command, or for a tool without conversation boundaries, is a 400). When "read it all" or "don't read" did not get the text typed, the boundary is not used up (if putting it back fails too, this server's next choice is 409 `claimed`, and after a restart the boundary counts as used and you are asked again). The preview is read in the background when the composer is focused and a send never waits for it (not read, or not in time: sent with the short brief as before)

### What is not prevented

- Only the screen path changes the mode (the server checks a mark only the screen sends and a matching `Origin`). A process with the same OS rights (agents included) can still forge the mark with `curl`, or write the database file directly. CommandMate does not prevent or detect that
- What is prevented: the mode changing through the CLI's regular commands, a CLI user changing it without knowing, and a page of another origin changing it through the user's browser
- `--instance` can be claimed falsely too. The author check keeps a session from changing another's items by mistake; it does not stop a deliberate rewrite
- Approving a decision's record (promote) is limited to the screen path by the same mark. A process with the same OS rights can forge it, and can rewrite the operation records in the database to read "succeeded". That agents do not approve rests on the CLI having no way to and on the skills' instructions, not on a guarantee
- A person's item writes on the screen (Issue #4227) are limited to the screen path by the same mark. A person passes the author check (a person may change any item; conversely, an item a person wrote is not changed through an agent's entrance), so the worktree's and the instance's lifetimes, the branch, the mode and the version are checked right before the write. A process with the same OS rights that forges the mark writes as a person

---

## commandmate handoff

The **agent's side** of the hand-off before a session ends (Issue #4227). When a person starts the hand-off from the screen's "end" (only on a branch set to be attended, `popup` on, with mode `on`), the screen sends the agent a request, and the agent puts its mem updates up as **proposals** with this command. A proposal is not an update: only what a person approves on the screen, after seeing the difference, is confirmed against the item's version.

```bash
commandmate handoff propose --request <id> add --kind <kind> --text "…" [--close-when …] [--evidence …]
commandmate handoff propose --request <id> update <itemId> --base-version <v> --text "…"
commandmate handoff propose --request <id> close <itemId> --base-version <v> [--reason "…"]
commandmate handoff done --request <id>
```

- `--request` is the id in the request text. For `propose` it may stand before the operation (`add`, `update`, `close`) or after it; with neither it is 2 and nothing is sent. Inside a session the target is yourself (whoami); in an ordinary shell add `--worktree <id> --instance <id>`
- If a `propose` fails (an exit code other than 0), fix it and propose again before `done`: nothing is taken after `done`. When `done` arrives with no proposal, the screen says that a failed proposal did not arrive, and a person can ask again with "Don't end" and then "End"
- **There is no way here to approve, cancel or end** (the screen's only, with its mark)
- Only the instance asked can propose (another gets `not_requested`). Past the agent's time (5 minutes; the screen can add 5 minutes twice), after `done`, after a forced stop or a cancel, nothing is taken (`request_closed`)
- A proposal never touches `now`. A decision is proposed as an add (open) or the withdrawal of an open one (close); closing a recorded decision is a person's, on the screen (`state_forbids`)
- If the session is started again after the request (a restart, reset or resume: a new D1 boundary), proposals to the old request are refused with `session_changed` and the request expires

### How a hand-off ends and what is recorded (a person stops it)

- The hand-off **never stops a session**. Only the existing stop a person presses does. The screen's "Stop" declares the stop, runs the existing stop, then asks the server to observe it; the server checks with `isRunning` and records it. Nothing stops anything from a deadline, a cancel, a confirmation or a read
- The record is `confirmed` (the agent's `done`, every proposal decided, every confirmation in, and the stop observed after the person's press — all of them) or `unconfirmed` with a reason: `forced`, `agent_timeout`, `request_failed`, `undecided_left`, `conflict_left`, `apply_failed`, `session_changed`. "Stop now" before confirming is always `unconfirmed(forced)`. When the stop cannot be confirmed nothing is recorded and the screen asks to press Stop again
- The screen's "end" (the PC header's and each split's, the phone's "…" → End) reads the mode when pressed: with attended on and mode `on` it opens this hand-off; otherwise (unattended, mode not `on`, the mode not readable or not answered in 5 seconds) the usual confirmation as before. Opening either stops nothing. "Don't end" keeps the session
- The hand-off screen **does not close while a confirmation is being sent, a confirmation's result is unknown, a cancel waits for its answer, or the stop is in progress** — by Esc, ×, the backdrop, a button, another "end" or a switch of worktree (it says why). A confirmation whose result is unknown stays until you send it again or drop it; the stop can still be pressed meanwhile. Switching worktree keeps the screen: on the other worktree nothing can be stopped or confirmed and the confirmation can only be dropped; back on its own worktree it can be sent again. These stay, and no request is made again, when the screen switches between PC and phone (a turn of the device, a change of width) or disappears for a moment while a switch of worktree loads. A hand-off screen not closed is shown open again when you come back to its worktree from another page (also while the agent's proposals are awaited). After cancelling, neither a confirmation nor the request's text is sent. An earlier confirmation, cancel, stop or request whose answer comes back late does nothing to a confirmation sent since, nor to a hand-off screen opened again (or opened on another page): it does not close it, mark it unknown or rewrite what it shows. Where no request could be made and only the existing stop is offered, it says "stopped" only when the session stopped; when it could not be stopped, or it is not known, it says why and the stop button stays (press it again)
- The exit codes are mem's: 0 done, 2 invalid input, 50 mode not on, 51 version conflict, 52 not found, 55 `not_requested` / `request_closed` / `session_changed` / `state_forbids`

---

## commandmate brief

The summary a restart reads (Issue #4223, Epic #4220). The state CommandMate holds (the instances' state, auto-yes, relays, execution contracts, verification, the orchestrate run, a reference to the conversation) is read from its source every time, set next to the branch's mem items, and kept **within a budget of UTF-8 bytes**. No model and no external generator is called. Nothing is copied (the brief is never stored). This command only reads: it acknowledges no "it ended" notice (putting the brief into a session is #4224).

### Usage

```bash
commandmate brief [--budget <bytes>] [--json] [--all] [--worktree <id> --instance <id>]
commandmate brief --session-start     # from a SessionStart hook (Issue #4224)
```

- The target is your own instance inside a CommandMate session (resolved like `whoami`). In an ordinary shell, give **both** `--worktree` and `--instance` (only one is exit 2)
- `--budget` is the UTF-8 byte count of the whole output, the final newline included. Text: 1,024–49,152 (default 4,096); `--json`: 4,096–49,152 (default 16,384). Anything else, or a value that is not a whole number (`0`, negative, decimal, `1e3`, empty), is exit 2 and prints nothing
- `--all` drops the budget and prints every entry (not with `--budget`)
- `--json` is one line of JSON (`schema: "cmate-brief/v1"`); whole elements of `entries` are dropped to fit

### What it shows

- A fixed top: the block's fences (`<<<cmate-brief:<tag>` … `cmate-brief:<tag>>>>`), a line saying that what follows is data, not instructions, the mode and the target, and **the number of entries left out with the command that reads them all** (`omitted=<n> all="commandmate brief … --all"`). The closing fence is never dropped
- One entry per line, each with its source (`src=`), author (`by=`) and time (`updated=`). Free text is a JSON string; for every source (task titles, branch names and run stages as well as mem items), a secret-like value, a control character or a bidirectional control is not shown and the line says `withheld=<code>`. Invisible characters (every Unicode Default_Ignorable_Code_Point, format character (Cf), line / paragraph separator, private-use code point and variation selector) are replaced by a visible `[U+XXXX]`. Only the ZWJ and VS15/VS16 inside an emoji sequence and the tags of an RGI subdivision flag are kept, so a Persian ZWNJ or an Indic ZWJ is replaced too. An entry over 512 bytes shows its body and references (`refs`) in the omitted form (`…(本文 <n> bytes を省略。読む: …)`)
- A fixed order: what waits for a person (an open wait, a relay in `prompt`) → your own `now` → relays with a delivery hold → unreflected decisions → next steps → your session's state (the instance, auto-yes, the contract, your verification, the run) → other sessions' `now` → waiting and external items → ended notices → the rest. The same state gives the same order, and the cut stops at the first entry that does not fit
- A source that cannot be read is one line saying `unavailable=<reason>` (`timeout`, `read_failed`, `no_transcript_reader`, `no_turn_yet`) or `unsupported=<reason>` (`format`, `too_large`), and the other lines are printed (exit 0)
- An instance's state is the value the ordinary monitoring last observed; the brief never captures the screen or detects a state for itself (`observed=none` when nothing was observed). Auto-yes is read per instance; a grant past its deadline reads `enabled=false stop=expired`, and the state is not rewritten
- The conversation is a reference only: the time of the last transcript turn and the command that reads it (`commandmate reply <worktree-id> --instance <id>`), never its body
- On a `derived` branch only the derived state is shown; hand-written items and notices are not read. On `on`, the close conditions are evaluated when read (as `mem list` does)

### From a SessionStart hook (`--session-start`, Issue #4224)

- On a branch with `injectOnStart` enabled, the send path (claude, codex, command-code) puts the brief in front of a conversation's first send, once. A `SessionStart` hook that prints the brief should **use `commandmate brief --session-start`, not the plain `commandmate brief`**
- `--session-start` prints nothing to stdout and exits 0 (one line on stderr) when the branch is `derived` / `on` with `injectOnStart` enabled and the instance's tool is one the send path briefs. Otherwise it prints what the plain command prints (a tool the send path does not brief gets it from the hook)
- It is decided from the membership, the mode, `injectOnStart` and the tool alone: the boundary ledger is neither read nor written, and nothing is reserved or acknowledged. Not with `--json` (exit 2)
- No double brief is guaranteed for the hooks CommandMate installs and hooks that use `--session-start`. A hook of your own that prints the plain `commandmate brief`, or a hand-written handoff, at `SessionStart` cannot be stopped
- It does not look at the hook's `source` (`startup`, `resume`, `clear`, `compact`, …) or at whether the conversation goes through CommandMate's send. When the conditions hold it prints nothing after a `compact` or in a conversation started outside CommandMate too, and such a conversation gets the brief from neither side (the send path briefs only what is sent with CommandMate's `send`)
- When the worktree or the instance is deleted and made again while it decides, it prints no brief for the new one and evaluates no close condition (exit 52, `reason` is `lifetime_changed`)

### Exit codes

| Code | Meaning |
|:----:|---------|
| 0 | Printed (also when a source could not be read) |
| 1 | The server is not reachable |
| 2 | Invalid input (the budget's range or form, `--all` with `--budget`, only one of `--worktree` / `--instance`, an id's shape). Nothing printed |
| 50 | The branch's mode is `off` (also when it turned `off` while the brief was built). Nothing on stdout, one line on stderr |
| 52 | Not registered, no such worktree / instance, the branch cannot be read, or the worktree / instance was deleted and made again while the brief was built (`reason: lifetime_changed`; it is not rebuilt for the new one) |
| 53 | `ambiguous`, or the membership kept changing while it was rebuilt |
| 99 | Anything else |

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
| 31 | ROLE CONFLICT | A role or roster conflict (`name_conflict` / `name_changed` / `version_conflict` / `role_in_use` / `instance_exists` / `roster_changed`); nothing changed or sent. Also from `instances add` / `remove` / `alias` without a role. The exception: `remove --kill` may have stopped the session |
| 32 | ROLE NOT_SENT | The role condition does not hold, or the start was refused because of its role; the body was not typed (`send` / `ask`) |
| 50–57 | MEM | Refusals of `mem` (50 disabled / 51 version_conflict / 52 target not found / 53 ambiguous / 54 duplicate_key / 55 not_owner, state_forbids / 56 limit_exceeded), and a prompt from `mem check --suggest` (57); see the exit codes of [commandmate mem](#commandmate-mem). `send --note` refused by mem ends in 50–56 too |
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
