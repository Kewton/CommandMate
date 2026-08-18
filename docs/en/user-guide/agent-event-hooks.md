[日本語版](../../user-guide/agent-event-hooks.md)

# Agent Event Hooks Guide

By default, CommandMate infers that an agent has finished by **parsing the text on the tmux screen**.
Installing hooks adds the **structured events** the agent CLI emits itself as a first-class source of
information (Issue #1549).

**For Claude sessions, CommandMate injects these hooks automatically** (Issue #1722).
Manual configuration is no longer needed (§0). An existing manual configuration keeps working — see §0.4.

> **Text parsing is not going away.** Hooks are a *second opinion*, and as of today they have not
> replaced the completion verdict used by `wait` or by the poller (§5).

---

## 0. Automatic Injection (Claude / Issue #1722)

When CommandMate **creates a new** Claude session, it generates a hooks configuration file dedicated
to that session and passes it with `claude --settings <file>`.

```
~/.commandmate/hooks/claude-<worktreeId>-<instanceId>-<hash>.json
```

| Injected event | handler | Notes |
|----------------|---------|-------|
| `SessionStart` | `command` (relayed through `cmate-agent-event.sh`) | **http does not work here.** §0.2 |
| `UserPromptSubmit` | `http` | |
| `Stop` | `http` | |
| `Notification` | `http` (matcher: `permission_prompt\|idle_prompt`) | The matcher is applied to `notification_type` |
| `SessionEnd` | `http` | |
| `PermissionRequest` | `http` (a separate endpoint, `/api/hooks/permission-request`, 5-second timeout) | **Auto-Yes v2** (#1724). §0.6 |
| `PreToolUse` / `PostToolUse` | `http` (matcher: `AskUserQuestion`) | #1726. Sent to the event endpoint (observation, not adjudication) |

The same file also carries **`permissions.deny`** alongside the hooks (#1739). That is enforced by
Claude itself rather than by a hook, and it takes effect before `PermissionRequest` ever fires. §0.7

### 0.1 `~/.claude/settings.json` is never rewritten

Hooks passed through `--settings` are **concatenated with the user's settings — both run — even for
the same event** (they do not replace them). The user's `~/.claude/settings.json` keeps the same
sha256 (measured).

### 0.2 Only `SessionStart` cannot use `type:"http"`

Claude Code **silently skips** an http hook on `SessionStart` (this is not in the official
documentation). The only trace is `HTTP hooks are not supported for SessionStart` in the debug log —
nothing appears on stdout or in the TUI. So `SessionStart` alone uses `type:"command"` and relays
through `scripts/hooks/cmate-agent-event.sh`.

### 0.3 Disabling it (rollback)

```bash
CM_AGENT_HOOKS_INJECT=0 commandmate start
```

Injection is skipped and the launch command becomes exactly what it was before Issue #1722.
The location of the generated files can be changed with `CM_AGENT_HOOKS_DIR`.

### 0.4 Coexisting with a manual configuration (double delivery)

If automatic injection is enabled while the manual Stop hook from §3 is still in place, **the same
turn's `stop` arrives twice**. `lastStopEventAt` in `applyAgentStopEvent` is an overwrite and thus
idempotent, but `agent_idle` in `task_events` **gains one row per delivery** (measured and confirmed).

So the endpoint treats events matching on
`(worktreeId, cliTool, instance, event, sessionId)` **as one event within a 3-second window**. Both
deliveries carry the same `session_id`, so the double delivery collapses while a different turn
(a different `session_id`) does not. A call that sends no `sessionId` is **never collapsed** (there is
nothing to tell them apart with, and losing a real event is worse than allowing a duplicate).

**The manual configuration may simply be deleted** (automatic injection sends the same events).
Keeping it causes no double recording either, thanks to the dedup above.

### 0.5 Cases where nothing is injected

- **Reusing an existing session** (when a healthy one exists) injects nothing. It applies from the
  next newly created session. Appending settings to a running session is technically possible —
  Claude hot-reloads them without warning — but it is not done, to avoid a state where "which
  settings is this pane running under" changes over time.
- **The arrival of a hook must not be used as a "startup finished" signal.** In an untrusted
  directory the folder-trust dialog comes first, and not even `SessionStart` fires until it is
  answered (measured: 25.3 seconds of complete silence). Startup detection still relies on
  `CLAUDE_PROMPT_PATTERN` and on answering the trust dialog automatically.

### 0.6 `PermissionRequest` (Auto-Yes v2 / Issue #1724)

Unlike the other events this one is **synchronous**, and **the agent obeys the body of the response**.
Claude calls this hook **before drawing** the approval dialog, and CommandMate returns one of three
things.

| Response | What Claude does |
|----------|------------------|
| `{}` (no decision) | The TUI approval dialog appears as usual (identical to a machine without this feature) |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | Runs immediately, with no dialog |
| `deny` | **CommandMate never returns this** (see below) |

The decision table:

| Condition | Verdict |
|-----------|---------|
| The payload cannot be read | no decision |
| `tool_name` is `AskUserQuestion` | no decision (always) |
| Auto-Yes is off or expired | no decision |
| The contract's `autoYes` suppresses it (`mode: off` / a `denyPatterns` match / a disallowed type) | no decision, plus a `lastSuppression` record |
| Anything else | `allow` |

- **Undecidable always means no decision.** A wrong `allow` means a command runs; a no decision only
  means a dialog appears. That asymmetry is the design principle behind every branch.
- **`deny` is never returned.** Auto-Yes suppression has always meant "do not answer automatically",
  not "refuse". Even on a `denyPatterns` match, **the dialog appears and can be answered by hand**
  (the behavior is unchanged).
- **`denyPatterns` are matched against that request's `tool_input` only** (the command for Bash, the
  primary argument for other tools). Neither the screen nor the scrollback is an input, so #1699
  (an approved `rm -rf` suppressing every later, unrelated approval) is structurally impossible.
- **`AskUserQuestion` cannot be bypassed.** Returning `allow` still leaves the selection screen up
  (measured). Conversely, the class of accident where "`respond yes` turns into an approval" cannot
  happen either. Answering questions is the job of a separate mechanism (#1726).
- **The agent does not stall when the server is down.** Hook timeouts and connection failures are all
  fail-open; the only effect is that the dialog appears.
- It is **always injected, independently** of the Auto-Yes toggle. Injection happens once at session
  start while Auto-Yes is enabled later, so tying them together would create a state of "I enabled it
  but there is no hook".
- **Screen-based Auto-Yes still exists.** It works as before for environments without hooks support
  and for CLIs other than Claude.

### 0.7 `permissions.deny` — no pattern-based mass kill (Issue #1739)

The injected file carries `permissions.deny` in addition to the hooks.

```jsonc
"permissions": {
  "deny": ["Bash(pkill:*)", "Bash(killall:*)", "Bash(kill -9:*)"]
}
```

On 2026-08-06 a delegated worker ran `pkill -f "node dist/server/server.js"` intending to restart the
single isolated server it owned. `-f` matches a substring of the whole command line, so it also hit
**the user's production server (port 3000) and the global instance (port 60301)**, which were running
the same executable, and neither recovered until they were rebuilt and restarted by hand.

**Why it sits next to the hooks.** `permissions.deny` refuses **before a dialog exists**. That is,
`PermissionRequest` never fires and **Auto-Yes never gets a chance to adjudicate**. In the real
incident the dialog did appear and Auto-Yes approved it. The two layers above do not stop this:

| Layer | What it does | Did it stop this incident? |
|-------|--------------|----------------------------|
| The prose of the delegation contract ("do not touch port 3000") | Advice. Forbids a **target** | No — as far as the worker knew, it was stopping only its own server |
| The contract's `autoYes.denyPatterns` (#1724) | Suppresses the automatic answer and **escalates to a human** | No — a pattern nobody thought to write has no effect |
| `permissions.deny` (this section) | Forbids a **means**. Refuses before the dialog | Yes — refused regardless of Auto-Yes |

**What is forbidden is the means, not the target.** All three rules name a way of
*selecting processes by pattern*.

#### How to stop a process you started (use this idiom)

**Naming a PID still works as it always did.** Record the PID at startup and stop only that:

```bash
U="$SB/uat"; mkdir -p "$U"
CM_PORT=3779 CM_DB_PATH="$U/cm.db" NODE_ENV=production \
  nohup node dist/server/server.js > "$U/server.log" 2>&1 &
echo $! > "$U/uat.pid"          # <- record only your own PID
# ...
kill "$(cat "$U/uat.pid")"      # <- not covered by deny; runs as written
```

| Form | Allowed? |
|------|----------|
| `kill "$(cat uat.pid)"` / `kill 4242` / `kill -TERM 4242` | Yes |
| `pkill …` / `killall …` | No, refused |
| `kill -9 …` | No, refused (`kill -9 -1` hits all your processes, `kill -9 -<pgid>` a process group). Use SIGTERM |

The refusal **cannot be worked around by composing commands**. `cd /tmp && pkill …`,
`pkill … | cat`, and `echo x; pkill …` are all refused (the command line is decomposed and each
segment is matched — measured for §0.7).

#### Relationship with the user's settings

- deny rules from `--settings` land in a separate destination inside Claude called `flagSettings`,
  and they **coexist** with the permission rules of the user and project settings (concatenated, not
  replaced, just like the hooks).
- **`deny` beats `allow`.** Writing `"allow": ["Bash(pkill:*)"]` into the higher-priority
  `.claude/settings.local.json` was measured to still be refused. In other words, a user's
  `permissions.allow` cannot reopen this prohibition.
- The prefix match includes **the flags**. `Bash(kill -9:*)` refuses only `kill -9 …` and does not
  match `kill <pid>` (measured from `Bash(uname -a:*)` refusing `uname -a` while letting `uname -s`
  through).

For the measurement details see
[agent-hooks-permission-deny-verification.md](../../design/agent-hooks-permission-deny-verification.md).

#### The escape hatch

If a legitimate use is genuinely blocked, turn off the whole injection (§0.3):

```bash
CM_AGENT_HOOKS_INJECT=0 commandmate start
```

There is **no switch that removes only the deny rules**. Losing the structured events along with them
makes an accident easier to spot than a state where "the mechanism is installed, but somebody quietly
disabled part of it".

---

## 1. The Endpoint: `POST /api/hooks/agent-event`

The endpoint accepts **two request shapes**.

**(a) The CommandMate shape** (`cmate-agent-event.sh` and manual configuration):

```jsonc
{
  "tool": "claude",           // An existing CLI tool id (claude / codex / ...)
  "event": "stop",            // stop | notification | session_start |
                              // user_prompt_submit | session_end
  "cwd": "/path/to/worktree", // Absolute path. The key the worktree is resolved by
  "sessionId": "abc123",      // Optional
  "worktreeId": "wt-a",       // Optional. Wins over cwd resolution when present
  "instanceId": "claude-2",   // Optional. Treated as primary when absent
  "detail": "idle_prompt"     // Optional. A subtype of the event kind
}
```

**(b) Claude Code's native payload** (the injected `type:"http"` hooks):

```jsonc
{ "hook_event_name": "Stop", "session_id": "...", "cwd": "...", ... }
```

`type:"http"` cannot shape the body, so Claude's payload arrives as-is.
`tool` / `worktreeId` / `instanceId` are passed as **query parameters**:

```
POST /api/hooks/agent-event?tool=claude&worktreeId=wt-a&instanceId=claude-2
```

| Response | Meaning |
|----------|---------|
| `202 {"accepted":true}` | Accepted. **The same response whether or not the worktree resolved** (it is not used to probe which directories are registered) |
| `400` | `tool` / `event` (or `hook_event_name`) / `cwd` / `instanceId` is invalid |

If authentication is on (`CM_AUTH_TOKEN_HASH` is set), **this route requires it too**.
Send `Authorization: Bearer <token>` (see `CM_AUTH_TOKEN` below).

> **When an injected http hook uses `$CM_AUTH_TOKEN` in its `headers`, the same hook must also carry
> `allowedEnvVars: ["CM_AUTH_TOKEN"]` or the variable is not expanded.**
> Forget it and the hook authenticates with the literal string `$CM_AUTH_TOKEN` and gets a silent 401.
> The generator always emits the two together.

On `event: "stop"`, the following happens for the target worktree / instance:

1. If there is an active task with an execution contract, an `agent_idle` event is recorded in
   `task_events` with `source=hook`
2. If that contract has `success.autoVerifyOnStop: true`, a verification run is started automatically
   ([task-contract.md](../../design/task-contract.md) §2.5. **It defaults to false**)
3. `lastStopEventAt` is recorded as a hint about the session state (§5)

For a session with no contract (the vast majority) steps 1 and 2 do nothing, and only 3 is recorded.

Events other than `stop` are accepted and recorded, but change no state today.

### 1.1 Identifying the instance

`cwd` identifies the worktree but **not the instance** — `claude` and `claude-2` in the same worktree
share a cwd. So `worktreeId` / `instanceId` are baked into the injected URL and used as the
correlation key.

**`session_id` is not used as the correlation key.** `/clear` fires
`SessionEnd(reason=clear)` → `SessionStart(source=clear)`, and `session_id` changes at that point.
The instance, the worktree, and the tmux pane have all stayed the same.

A request without `worktreeId` / `instanceId` (a manual configuration) resolves the worktree from
`cwd` as before, and applies to the **primary instance**.

---

## 2. The Bundled Script `cmate-agent-event.sh`

`scripts/hooks/cmate-agent-event.sh` is a thin wrapper that does nothing but POST the above
(bash 3.2 compatible).

```
cmate-agent-event.sh [--tool ID] [--event EVENT] [--cwd PATH] [--session-id ID]
                     [--worktree-id ID] [--instance-id ID]
                     [--json JSON | --stdin-json] [--url URL] [--strict] [JSON]
```

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `CM_HOST` | `127.0.0.1` | Server host |
| `CM_PORT` | `3000` | Server port (the worktree's own port when running several) |
| `CM_HOOK_URL` | — | A full URL. Wins over `CM_HOST` / `CM_PORT` |
| `CM_AUTH_TOKEN` | — | When set, adds `Authorization: Bearer` |
| `CM_AGENT_TOOL` | `claude` | The default for `--tool` |
| `CM_HOOK_TIMEOUT` | `5` | curl's `--max-time` (seconds) |

`cwd` is resolved in the order `--cwd` → `CM_AGENT_CWD` → `CLAUDE_PROJECT_DIR` → the JSON's `cwd` → `$PWD`.

`--worktree-id` / `--instance-id` are put in the body **only when given**. Without them the endpoint
falls back to cwd resolution and the primary instance, so the behavior matches the manual
configuration as of Issue #1549.

`hook_event_name` maps as follows: `Stop` / `SubagentStop` → `stop`, `Notification` → `notification`,
`SessionStart` → `session_start`, `SessionEnd` → `session_end`,
`UserPromptSubmit` → `user_prompt_submit`.
`PreToolUse` and `PermissionRequest` are **not mapped and are refused with exit 2** (outside the scope
of that Issue).

**A failed POST still exits 0.** Breaking an agent's session because the server is down does more
harm than the lost event. Use `--strict` where a failure must be detected, such as in CI.

---

## 3. Manual Configuration for Claude Code (the Stop hook)

> **This is normally unnecessary for Claude** (the automatic injection in §0 sends the same events).
> What follows is for Claude sessions started outside CommandMate, or for running with
> `CM_AGENT_HOOKS_INJECT=0`.

`~/.claude/settings.json` (or `.claude/settings.json` to scope it to one project):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/scripts/hooks/cmate-agent-event.sh --tool claude --stdin-json"
          }
        ]
      }
    ]
  }
}
```

Claude Code hands the hook `{"session_id":"...","hook_event_name":"Stop","cwd":"..."}` as **JSON on
stdin**, so pass `--stdin-json`. The mapping is the one in §2.

On a worktree running a different port, prefix `command` with `CM_PORT=3135 `.

> Without `--stdin-json` the script does not read stdin, so it does not block on a setup that passes
> no stdin. In that case `cwd` comes from `CLAUDE_PROJECT_DIR` or `$PWD`.

---

## 4. Configuration for Codex (notify)

`~/.codex/config.toml`:

```toml
notify = ["/absolute/path/to/scripts/hooks/cmate-agent-event.sh", "--tool", "codex"]
```

Codex launches the notify command **with a JSON string appended as one final argument**. The script
reads a positional argument that is not an option as JSON, and maps `type` to the event and `turn-id`
to `sessionId` (`agent-turn-complete` → `stop`).

notify is launched in Codex's working directory, so `cwd` comes from `$PWD`. To be certain, add
`"--cwd", "/path/to/worktree"`.

---

## 5. What Hooks Do *Not* Change Today

> **The one exception is `PermissionRequest`** (§0.6 / Issue #1724). It is the only event whose
> response the agent obeys, and with Auto-Yes on it makes the command run without an approval dialog.
> Every other verdict (`wait` / the poller / completion detection) is unchanged, as below.

`lastStopEventAt` and `structuredEvents` are **only exposed** through
`GET /api/worktrees/:id/current-output` and the WebSocket terminal snapshot. The completion verdict of
`wait`, of the poller, and of **screen-based** Auto-Yes all still run on the result of text parsing.

```jsonc
"lastStopEventAt": 1754470000000,
"structuredEvents": {
  "lastEventType": "notification",   // The kind of the most recent event
  "lastEventAt": 1754470000000,
  "lastEventDetail": "idle_prompt"   // notification_type / reason / source
}
```

This is what to look at to confirm hooks are arriving.
A `lastEventType` that stays `null` forever means they are not injected, or not arriving.

Switching between the two sources — text parsing and hooks — before looking at measured data would
trade a *known* inaccuracy for an *unknown* failure mode. Folding them into the verdict is a follow-up
Issue (#1723), once the agreement rate between the two has been observed.

---

## 6. Limitations

- **Naming the instance in a manual configuration**: a request that passes no `--worktree-id` /
  `--instance-id` applies, as before, to the **primary instance**'s task. Running `codex` and
  `codex-2` side by side in one worktree, a `codex-2` hook without `--instance-id codex-2` will drive
  `codex`'s task. In an automatically injected Claude session this is filled in for you.
- **Automatic injection is Claude-only**: extending it to codex / gemini / copilot and others is
  future work. The endpoint itself takes any existing CLI tool id in `tool`, so the same script can
  send events for them by changing `--tool`.
- **A hook arriving is not "startup finished"**: as in §0.5, in an untrusted directory not even
  `SessionStart` arrives until the trust dialog is answered.
- **Every hook is fail-open**: neither a timeout nor a connection failure stops the agent. A session
  survives a downed CommandMate server; only the events are lost (for `PermissionRequest`, the
  approval dialog simply appears).
- **`PermissionRequest` does not fire under headless `-p`**: the sandbox guard rejects first, so a
  non-interactive run is never adjudicated by Auto-Yes v2 (measured).
- **A hook cannot tell you the user chose "No"**: `PermissionDenied` did not fire even when the TUI
  request was refused (measured; recorded 0 times). It cannot be used to detect a refusal.

---

## Related Documentation

- [Task Contract](../../design/task-contract.md) — `success.autoVerifyOnStop`
- [Verification Config](../../design/verification-config.md) — the verification gates that are started automatically
- [CLI Operations Guide](./cli-operations-guide.md)
- [Live verification: Claude Code hooks](../../design/agent-hooks-live-verification.md) —
  the source of the "measured" claims in this guide (Issue #1721). Where it disagrees with the
  official documentation is in its §2
- [Real payload fixtures](../../../tests/fixtures/hooks/claude/) — 12 captured on real machines
