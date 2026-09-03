[日本語版](../../user-guide/agent-event-hooks.md)

# Agent Event Hooks Guide

By default, CommandMate infers that an agent has finished by **parsing the text on the tmux screen**.
Installing hooks adds the **structured events** the agent CLI emits itself as a first-class source of
information (Issue #1549).

**CommandMate injects these hooks automatically** (Issue #1722, Epic #1720 Phase 4), for
**seven tools: claude / copilot / gemini / antigravity / codex / opencode / command-code**.
Manual configuration is no longer needed (§0). An existing manual configuration keeps working — see §0.4.

> **Text parsing is not going away.** Hooks are a *second opinion*, and as of today they have not
> replaced the completion verdict used by `wait` or by the poller (§5).

---

## 0. Automatic Injection (Issue #1722 / Epic #1720 Phase 4)

When CommandMate **creates a new** agent session, it prepares that tool's hook configuration and puts
it on the launch command. The authority on which tools are covered is the list of
`registerAgentEventSource(...)` calls at the bottom of `src/lib/hooks/sources/registry.ts`; today it
is **seven tools: claude / copilot / gemini / antigravity / codex / opencode / command-code**
(`vibe-local` is the one that is not registered). A tool with no source falls back to the `legacy-relay` compatibility source,
which behaves exactly as the hand-configured hooks of #1549 did.

### 0.0 Per-tool summary

**Reading this as "presumably the same as Claude" will be wrong every time.** The delivery mechanism,
the configuration file, the way correlation keys travel and the decision budget all differ per tool,
and every one of those differences **fails silently**.

| Tool | What CommandMate writes | Scope | How correlation travels | Delivery | Adjudicating event | Decision budget |
|---|---|---|---|---|---|---|
| **claude** | generates `~/.commandmate/hooks/claude-<worktreeId>-<instanceId>-<hash>.json` and passes it with `--settings <file>` | per-instance | **baked into the URL query** | `http` (`SessionStart` alone is `command`; §0.2) | `PermissionRequest` | 5 s |
| **copilot** | **merges into `~/.copilot/settings.json`, the user's machine-wide settings** | global-singleton | **environment variables** `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` / `CM_HOOK_PORT` | `command` (not one request arrives from `http`) | `PreToolUse` | **10 s** |
| **codex** | `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`, machine-wide) | global-singleton | environment variables `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` plus `CM_HOOK_URL` | `command` (a single `http` handler **destroys the whole file**) | `PermissionRequest` | 5 s (codex clamps `SessionEnd` to 3 s) |
| **gemini** | merges into `<worktree>/.gemini/settings.json` | per-worktree | `CM_HOOK_URL` (the instance rides in the URL) | `command` | **none** (no event whose reply is a verdict is registered) | — |
| **antigravity** | `~/.gemini/config/hooks.json` (machine-wide; shares gemini's tree) | global-singleton | environment variables `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` | `command` | `PreToolUse` | 5 s |
| **opencode** | **nothing at all** | none | the `--port <N>` assigned at launch | **not a push** — CommandMate is the one **subscribing** over SSE | `POST /permission/:id/reply` | **none (waits forever)** |
| **command-code** | merges into `<worktree>/.commandcode/settings.local.json` | per-worktree | `CM_HOOK_URL` (the instance rides in the URL) | `command` (`matcher` **must be the empty string**; §0.8) | **none** (`PreToolUse` fires after approval, so no reply can be a verdict) | — |

How to read it:

- The **decision budget** is the deadline for "what happens if CommandMate's verdict is late", not the
  time the tool allows hooks in general. Each source publishes it as
  `capabilities.decisionTimeoutSeconds`, so callers read that instead of re-deriving a constant.
- **`type: "http"` works for claude only.** Not a single request arrived from a copilot `http`
  handler (and nothing was printed), and codex discards the whole of `hooks.json` if one `http`
  handler is present. For the other five tools `scripts/hooks/cmate-agent-event.sh` (§2) is the only
  delivery path.
- **gemini's `timeout` is in milliseconds.** Writing `5` — the seconds figure every other tool takes —
  kills the hook after 5 ms, producing a state where the hook is registered, disclosed in the banner,
  runs, and **loses every event while looking correctly configured**.
- **Abstaining (no-decision) is unsafe on opencode only.** On the other six it costs an approval
  dialog; on opencode it **costs the session** (measured: still pending after 10 minutes 19 seconds).
  See §0.8.

Properties shared by every tool:

| Item | Detail |
|---|---|
| opt-out | **`CM_AGENT_HOOKS_INJECT=0`** skips injection for all seven and restores the bare pre-#1722 launch command (§0.3) |
| Where the generated file goes | claude's generated file lives under `~/.commandmate/hooks` (`CM_AGENT_HOOKS_DIR` overrides it). **The tools whose own settings files are rewritten are copilot / codex / gemini / antigravity / command-code, and all five are merges** — only CommandMate's own marked entries are replaced; every other key and handler is copied through. A file that cannot be parsed is **left alone** and the session starts without hooks |
| fail-open | neither a timeout, a connection failure nor a failed settings write stops the agent. **It falls back to a launch with no hooks** |
| Existing sessions | a healthy existing session is **reused without injection** (§0.5); the next newly created one picks it up |
| Startup signal | **a hook arriving is not "startup finished"** (§0.5) |

**§0.1 through §0.7 below are claude's details.** What is specific to the other six tools is
collected in §0.8.

### claude's injected file

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
- **Screen-based Auto-Yes still exists.** It works as before wherever hooks cannot be injected
  (`CM_AGENT_HOOKS_INJECT=0`, a failed settings write, codex hooks the user has not trusted yet) and
  for `vibe-local`. On the five tools that do have an adjudicating hook (claude / codex / copilot /
  antigravity / opencode), the hook decides first. **`command-code` also stays on the screen path** —
  its `PreToolUse` fires *after* the approval dialog, so no adjudicating hook can be built (§0.8).

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

### 0.8 The other six tools

What each row of the §0.0 table means in the implementation. **All of it is measured** (the sources
are `docs/design/agent-hooks-phase4-live-verification.md` and each source's module comment).

#### copilot — it rewrites the machine-wide `~/.copilot/settings.json`

**This is the one tool where CommandMate rewrites a settings file the user has exactly one of, for the
whole machine.** copilot has no equivalent of `--settings`, so there is no per-launch file to write.

- **It merges; it does not overwrite.** Only entries carrying CommandMate's own marker
  (`cmate-copilot-agent-hooks`, spelled as an argument to the shell's no-op `:`) are replaced; every
  other key and handler is copied through untouched. **An existing file it cannot parse is left alone
  entirely and the session starts without hooks** — losing events is recoverable, overwriting a
  user's settings is not.
- **The write is an atomic replace under a lock** (Issue #1904): it takes a `.cmate.lock` in the same
  directory, writes a temp file and `rename`s it. `commandmate start --issue N --auto-port` makes
  several servers writing this one file a supported workflow, and `writeFileSync` truncates before it
  writes. **A lock this process cannot take means starting without hooks.**
- **If `config.json` carries a `hooks` key, settings.json is not written** (Issue #1904).
  `copilot help config` documents `hooks` as a `config.json` key, but copilot 1.0.80 migrates that key
  **over** `settings.json` at startup — so an operator following the published documentation silently
  erases what CommandMate wrote. CommandMate inspects `config.json` first and, finding the key,
  **goes ahead without hooks rather than writing a file that is about to be erased.**
- **The hook is inert without `CM_AGENT_WORKTREE_ID`.** Because the file is machine-wide, the same
  hooks fire for a copilot the operator ran in their own terminal. Every handler opens with a
  `[ -z "$CM_AGENT_WORKTREE_ID" ]` guard and exits quietly when it is unset. Without it, an unrelated
  copilot that happened to sit in a registered worktree would have its `Stop` resolved by `cwd` and
  **release a `commandmate wait` that nobody's agent had finished**. A `CM_HOOK_PORT` that is not a
  number makes it inert the same way.
- **Correlation travels in the environment** (`CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID`). A URL
  fixed at write time could only ever name one instance, so the second copilot session in a worktree
  would post under the first one's identity. **The port (`CM_HOOK_PORT`) is an environment variable
  for the same reason** — measured: a development server on 3011 rewrote the file and every copilot
  session on the machine, including the one on 3000, started posting to 3011.
- **The decision budget is ≈10 s** (copilot's own hook cut-off, a different thing from the 5 s
  `timeout` written into claude's `PermissionRequest`). The generated `curl` bounds itself at 4 s. A
  late verdict is discarded and the tool runs (fail-open).

#### codex — `$CODEX_HOME/hooks.json`, but nothing runs until a human trusts it

- There is exactly one file, `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`).
  `<worktree>/.codex/hooks.json` fires too, but it grows an untracked `.codex/` in every worktree and
  trust is keyed by absolute path, so a per-worktree file means answering the review dialog once per
  worktree, forever.
- **An untrusted hook is skipped in complete silence.** Trust is recorded in the user's own
  `~/.codex/config.toml`, and CommandMate does not write that file.
- Correlation travels in the environment, as with copilot. **Unlike copilot, codex sessions
  CommandMate did not start post too** — without the environment variables the relay omits the
  correlation keys, and the receiver resolves the worktree from `cwd` and applies it to the primary
  instance, which is exactly the hand-configured behaviour of #1549.

#### gemini — `.gemini/settings.json` inside the worktree, and a `timeout` in milliseconds

- gemini and command-code are the two tools whose hook configuration is naturally worktree-scoped;
  the user's `~/.gemini/settings.json` is never opened. Because **it writes a file inside the user's
  repository**, both properties matter: it merges, and the command string it writes does not vary per
  launch (gemini records the exact command strings it has been trusted with and re-shows the
  disclosure banner when they change).
- **`timeout` is in milliseconds.** `5` kills the hook after 5 ms.
- `BeforeTool` / `AfterTool` are **deliberately not registered**: gemini runs hooks synchronously, so
  they would add two blocking round trips per tool call and report `running`, which `BeforeAgent` has
  already established.

#### antigravity — `~/.gemini/config/hooks.json`, sharing gemini's tree

- agy reads exactly one file, `~/.gemini/config/hooks.json`. The documented
  `<workspace>/.agents/hooks.json` is never read. `~/.gemini/` also holds gemini's OAuth credentials
  and agy's own state, so writing there is restricted to merging.
- **The file carries no correlation at all.** The worktree and the instance travel in each launched
  session's environment (`CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL`).
- **`PreToolUse` alone does not go through the relay script.** agy's `PreToolUse` reply has a
  *required* `decision` field, and a hook that answers `{}` has **every tool call denied**. The relay
  script writes nothing to stdout, so this one is built as an inline `curl` whose stdout is the
  verdict.

#### opencode — writes nothing; CommandMate subscribes

- **Not one byte of configuration is written** (`configScope: 'none'`). The whole integration is a
  `--port <N>` argument on the launch command and a subscription to that port. Where the other six
  push (agent → CommandMate), this one runs the other way round.
- **CommandMate assigns the port explicitly** (range 4200-4299). `--port 0` does not mean "ask the OS
  for a free port": the first server takes 4096 and only the second falls through to an ephemeral
  one, and the only ways to read the real port back are one stdout line or `lsof`. The assignment is
  persisted to `~/.commandmate/opencode-ports.json`, so a CommandMate restart recovers by reading the
  record plus a health check rather than by guessing.
- **Withholding a verdict does not cost a dialog — it stops the session.** An approval left
  unanswered for 10 minutes 19 seconds was still pending, with no timeout and no fall-through. The
  TUI dialog and the REST request are not two stages but the same pending object seen twice, which is
  why "when in doubt, abstain" is the one rule that does not hold here.
- Every degraded path is fail-open (an exhausted port range, an unreachable server, a dropped SSE
  stream all fall back to the scraper). `CM_AGENT_HOOKS_INJECT=0` restores the bare `opencode`
  launch.

#### command-code — `.commandcode/settings.local.json` in the worktree, and an EMPTY `matcher`

- **CommandMate writes `settings.local.json` (the machine-local layer), not `settings.json` (the
  shared one).** Command Code reads three layers — `<cwd>/.commandcode/settings.local.json`, then
  `<cwd>/.commandcode/settings.json`, then `~/.commandcode/settings.json` — and **unions every
  handler from all three** rather than letting one override another (the only deduplication is an
  exact `event:matcher:command` match). Measured: two layers registering different commands both ran,
  and the pane printed `◼ Ran 2 session start hooks`. Because they are unioned, occupying the local
  layer cannot cost the operator a single hook in the shared one — and the shared file is the one a
  team commits, so CommandMate keeps its machine-local absolute paths out of it.
- **The `matcher` must be the empty string. `"*"` silently removes `SessionStart` and `Stop`.**
  Handler selection reads `if (handler.matcher) { if (!toolName) continue; … }`, and those two events
  are invoked with `toolName: ""`. `"*"` *loads* fine — it is special-cased to a match-everything
  regex, so no warning is printed — and then never fires. Measured: `""` gives
  `Ran 2 session start hooks`, `"*"` gives `Ran 1 session start hook`.
- **Four events exist, and that is all of them** (`SessionStart` / `PreToolUse` / `PostToolUse` /
  `Stop`). `UserPromptSubmit` / `Notification` / `SessionEnd` are not merely unobserved — they are
  **rejected at load** (`unknown hook event "…" — skipped`).
- **`PreToolUse` fires *after* the approval dialog** (measured: drawn 00:11:37, answered 00:11:46,
  hook 00:11:46). No adjudicating hook can be built from it, so CommandMate points the event at the
  ordinary event receiver and records it as an observation. Auto-Yes stays on the TUI's numbered
  responder.
- `timeout` is in **seconds**, and anything outside `(0, 600]` is dropped with a warning (default 30).
- **Replying `{}` continues on all four events** (measured). The only things that block are
  `decision: "block"`, `block: true`, `hookSpecificOutput.permissionDecision: "deny"`, and
  **exit code 2 on `PreToolUse` / `Stop`**. The relay script prints nothing to stdout and exits 0 even
  when the POST fails, so a server that is down cannot stop a turn.
- **`.commandcode/` is not git-ignored** (`git status` reports `?? .commandcode/`). This is not
  something CommandMate introduces: Command Code writes `.commandcode/taste/taste.md` itself on the
  first launch. Add `.commandcode/` to `.gitignore` if it is in the way — the same treatment
  gemini's `.gemini/` gets.

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
  `codex`'s task. In an automatically injected session this is filled in for you (claude carries it in the URL, the
  other five in the environment).
- **Automatic injection covers seven tools**: claude / copilot / gemini / antigravity / codex /
  opencode / command-code (`src/lib/hooks/sources/registry.ts` is the authority). **Only `vibe-local` is not
  covered** and is still judged by text parsing alone. The endpoint takes any existing CLI tool id in
  `tool`, so events can still be sent for an uncovered tool by changing `--tool`.
- **The premises differ per tool**: where the configuration file lives, how correlation keys travel,
  the decision budget and what happens when a verdict is withheld are all tool-dependent (§0.0 and
  §0.8). In particular, **opencode is the one source where abstaining stops the session**, and
  **codex hooks are skipped in complete silence until a human trusts them**.
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
