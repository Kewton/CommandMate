# UAT and daily-check isolation (`CM_UAT_ISOLATION=1`)

When a UAT or the daily real-environment check runs a CommandMate server and CLI, `scripts/uat/run-server.sh` (called by `env.up` / `env.down` of `.commandmate/uat.yaml`, Issue #3359) already separates the port, the DB, tmux and the state directories from production. Three paths are left that those cannot separate, because each lives where the user's login lives (Issue #3360).

1. **codex's shared files** — `$CODEX_HOME/hooks.json`, the relay (`$CODEX_HOME/commandmate/cmate-agent-event.sh`) and the hook trust in `config.toml`. Moving `CODEX_HOME` logs codex out.
2. **claude's user-level hooks** — `--settings` is added to `~/.claude/settings.json`, not substituted for it. Moving `CLAUDE_CONFIG_DIR` logs claude out.
3. **the CLI's settings** — the global CLI reads `~/.commandmate/.env` whatever the cwd, and with nothing set it sends to the default port 3000 (production).

A server and CLI started with `CM_UAT_ISOLATION=1` behave as follows. Without it nothing changes (any value other than `1` or `own-home` counts as unset; `own-home` is described at the end).

| Target | With `CM_UAT_ISOLATION=1` |
|--------|---------------------------|
| codex `hooks.json` and relay | Not written. When the file production wrote is byte-identical to what this build writes into an empty file (CommandMate's hooks only), it is used as it is (the launch environment's `CM_HOOK_URL` makes the UAT server the receiver). Otherwise the **launch is refused** (the session start fails with `CM_UAT_ISOLATION=1: refusing to start codex …`): a bare codex still reads the shared `hooks.json`, so "start without hooks" would run production's trusted hooks. A file that also holds hooks the user added is refused too (one may post straight to production; the refusal says so). `CM_AGENT_HOOKS_INJECT=0` is refused for the same reason |
| codex hook trust | Never granted (granting is codex writing `config.toml`). The review screen, if shown, is answered "continue without trusting", and that session has no hooks |
| antigravity `~/.gemini/config/hooks.json` | Not written. Used when it already holds the same content and only CommandMate's hook; missing, different or mixed with the user's own hooks, the **launch is refused** (agy always reads the shared file, the same reason as codex) |
| copilot `~/.copilot/settings.json` | Not written (no `.cmate-backup`, no lock file either). When it is byte-identical to what this build writes into an empty file (CommandMate's hooks only), it is used as it is (the correlation keys and the port travel in the launch environment, so the UAT server is the receiver). Missing, different, mixed with the user's own hooks (or other keys), or with a `hooks` key in copilot's `config.json` (copilot migrates it over `settings.json` at startup) or an unreadable one, the **launch is refused** (a bare copilot always reads the shared file, the same reason as codex). The refusal is decided before the tmux session is created. `CM_AGENT_HOOKS_INJECT=0` is refused too (Issue #3391) |
| claude | Launched with `--setting-sources project,local`. The user's `settings.json` (hooks and plugins included) is not loaded; CommandMate's `--settings` and the repository's `.claude/settings*.json` are. The `claude -p` of Schedules and the daily summary gets the same restriction |
| `codex exec` / `agy -p` of Schedules and the daily summary | **Refused** (the run fails with `CM_UAT_ISOLATION=1: refusing to start a headless codex run …`). Both always read the shared `hooks.json`, and a headless run carries no receiver URL (`CM_HOOK_URL`) and no correlation keys, so the hooks post to the relay's default (`CM_PORT`, else 3000 = production). There is no per-run way to turn them off or redirect them |
| CLI (commands built on `ApiClient`) | Reads no `.env` at all. Without `CM_PORT` it exits 2 instead of sending to 3000 |

## Procedure

`scripts/uat/run-server.sh up` starts the server (`env -i … CM_UAT_ISOLATION=1 …`); `env.up` of `.commandmate/uat.yaml` and the daily real-environment check (#3312) both call it. `isolation.checks` in `.commandmate/uat.yaml` confirms `CM_UAT_ISOLATION=1` in the running server's environment. Before the start, `up` records the sha256 of codex's `hooks.json` and relay of antigravity's `~/.gemini/config/hooks.json` and of copilot's `~/.copilot/settings.json` (a missing file is recorded as `absent`) in `{run_dir}/codex-shared.sha256`; `run-server.sh down` compares them and fails when one changed (it never writes them back).

Call the CLI of the same build by absolute path, with its own client HOME and the target pinned by `CM_PORT`:

```bash
mkdir -p "$RUN_DIR/client-home"
env -i HOME="$RUN_DIR/client-home" PATH="$PATH" CM_UAT_ISOLATION=1 \
  CM_PORT="$UAT_PORT" CM_BIND=127.0.0.1 \
  node "$WORKTREE/bin/commandmate.js" ls --json
```

- Do not use the global `commandmate` (another build, and it reads `~/.commandmate/.env`).
- HOME is separated because the CLI may write `$HOME/.commandmate-security.log`, and the global CLI creates `$HOME/.commandmate/`.
- There is no `--base-url` CLI option. The existing knobs for the target are `CM_PORT` and `CM_BIND` (an exported value outranks `.env`).

## Measurements (2026-10-05, claude 2.1.289 / codex-cli 0.160.0)

Taken on a private tmux (`tmux -L`) and in throwaway directories (`/tmp`). Nothing that could rewrite the user's `~/.claude*`, `~/.codex` or `~/.commandmate` was run; such cases are marked "not measurable".

| Tool | Place | What was measured | Result | Isolatable |
|------|-------|-------------------|--------|------------|
| claude | user `settings.json` hooks | Marker hooks in user / project / `--settings` under a temporary `CLAUDE_CONFIG_DIR`, `claude -p` with different `--setting-sources` | `user,project,local`: all three fired / `project,local`: project and `--settings` only / `local`: `--settings` only. `SessionStart` and `UserPromptSubmit` hooks fire even when logged out | Yes (`--setting-sources project,local`) |
| claude | auth (moving `CLAUDE_CONFIG_DIR`) | Interactive launch on a private tmux | Theme picker, then "Select login method". `-p` says "Not logged in" | No (the config location cannot move) |
| claude | auth (`--setting-sources project,local`, config location unchanged) | — | Not measurable (a real logged-in launch writes `~/.claude.json` and `~/.claude/projects/`). Auth is decided by the config location (Keychain), not by a setting source, so it is expected to hold; the three `-p` runs above all gave the same auth error, so the source selection does not change auth | Yes (inferred) |
| claude | the rest of the user `settings.json` | Read only | `model`, `enabledPlugins` and the like are dropped too. The model is the default (or `--model`) | Side effect |
| codex | `$CODEX_HOME/hooks.json` | Read and compared with what this build generates | Identical (production already wrote this content) | Yes (used without writing) |
| codex | relay | `cmp` | Identical to the shipped relay | Yes (used without writing) |
| codex | hook trust in `config.toml` | Read only | `trusted_hash` exists for the five events of `hooks.json`. Whether the hashes match the current content cannot be read off | Yes (never granted; no hooks when they do not match) |
| codex | do hooks reach the UAT server | — | Not measurable (a real codex writes history and sessions to `~/.codex`; moving `CODEX_HOME` logs out and credentials are not copied). `hooks.json` holds no target, the relay reads `CM_HOOK_URL` first (`scripts/hooks/cmate-agent-event.sh`), and the launch plan sets `CM_HOOK_URL` to the UAT port (unit-tested) | Yes (by design) |
| codex | folder trust in `config.toml`, `version.json` | Code read | codex itself writes them when `1` (trust this directory) or `3` (update notice) is pressed | No |
| antigravity | `~/.gemini/config/hooks.json` | Code read | It names the relay by checkout path, so a worktree build's content differs from production's | Yes (not written; for a worktree build the launch is in practice refused) |
| copilot | `~/.copilot/settings.json` | Code read | It names the relay by checkout path, so a worktree build's content differs from production's | Yes (not written; for a worktree build the launch is in practice refused) |
| CLI | `~/.commandmate/.env` | Worktree-build CLI with a `.env` holding `CM_PORT=3996` under a temporary HOME | Not read (a worktree build reads the cwd `.env`). With neither `CM_PORT` nor `.env` it sent to 3000 | Yes (separate HOME and `CM_UAT_ISOLATION=1`) |
| CLI | target | `CM_PORT` exported | The exported value outranks `.env` | Yes |

During the measurement, an `ls --json` with neither `CM_PORT` nor `.env` sent one GET to production (3000). Read-only, nothing written. That is why `CM_UAT_ISOLATION=1` no longer falls back to 3000.

## Skip conditions (for the #3312 design)

| Scenario | Skip when |
|----------|-----------------------------------|
| every codex scenario (launch refused) | The codex session start failed with `CM_UAT_ISOLATION=1: refusing to start codex` (the server log also has one of `codex-hooks-shared-absent-readonly`, `codex-hooks-shared-differs-readonly`, `codex-hooks-shared-foreign-readonly`, `codex-hooks-shared-relay-differs-readonly`). The shared `hooks.json` or relay is missing, differs from this build, or also holds the user's own hooks, so no codex scenario can run until the UAT uses the same build as production |
| scenarios that observe codex hooks | The hook review screen appeared (trust does not match). It is answered without trust, so that session's hooks do not run; only screen-based judgements apply |
| every codex scenario | Skip in a check that allows no change at all under `~/.codex`. codex itself writes folder trust (paths under `{run_dir}`) to `config.toml` and the update-notice answer to `version.json`; that cannot be prevented. Changes to `hooks.json` and the relay are detected by `run-server.sh down` (`env.down`) |
| every antigravity scenario (launch refused) | The antigravity session start failed with `CM_UAT_ISOLATION=1: refusing to start antigravity` (the server log may also have `antigravity-hooks-config-differs-readonly`). The shared file names the relay by checkout path, so this is almost always the case for a worktree build |
| every copilot scenario (launch refused) | The copilot session start failed with `CM_UAT_ISOLATION=1: refusing to start copilot` (the server log also has one of `copilot-hook-settings-absent-readonly`, `copilot-hook-settings-differs-readonly`, `copilot-hook-settings-foreign-readonly`, `copilot-hook-config-json-readonly`). The shared file names the relay by checkout path, so this is almost always the case for a worktree build. Changes to `~/.copilot/settings.json` are detected by `run-server.sh down` (`env.down`) |
| Schedule / daily-summary scenarios with copilot | Skip when the shared `~/.copilot/settings.json` holds hooks the user added. A headless `copilot -p` is not refused and reads the shared file; CommandMate's hooks do nothing without the correlation key (`CM_AGENT_WORKTREE_ID`), but the user's own hooks run |
| claude scenarios | Skip a scenario that relies on the user's `settings.json` (model, plugins, permissions). The target repository's `.claude/settings*.json` hooks do run (none are placed in the UAT's `{run_dir}/root` repositories) |
| Schedule / daily-summary scenarios with codex or antigravity | Always skip (the run is refused under isolation). A claude Schedule runs, with `--setting-sources project,local` |
| CLI scenarios | None, as long as the CLI is called as above. Do not build a scenario around the global `commandmate` |

## Running as a dedicated user (`CM_UAT_ISOLATION=own-home`, #3312)

The value for running the daily product-path check (stage 2 of #3312) as a dedicated macOS user (for example `cmcheck`). The behaviour of `1` is unchanged.

Start:

```bash
# As the dedicated user. Sockets and the lock go under that HOME
CM_UAT_SOCK_BASE="$HOME/run" CM_RUN_LOCK_DIR="$HOME/run/run.lock" \
  bash scripts/uat/run-server.sh up --own-home --port <port> --run-dir <dir>
```

`up --own-home` passes `CM_UAT_ISOLATION=own-home` and `CM_UAT_DEDICATED_USER=$(id -un)` to the server. Its set of checks is `.commandmate/uat-own-home.yaml` (a separate file in the same shape as `uat.yaml`: value, user, socket location; kept apart because cmate-uat asks about any unknown key in `uat.yaml` on every run).

**Allowed:** this build writes the shared hook files inside that HOME: codex's `$CODEX_HOME/hooks.json`, relay and hook trust (`config.toml`), antigravity's `~/.gemini/config/hooks.json`, copilot's `~/.copilot/settings.json`, and claude's `--settings` file (`CM_AGENT_HOOKS_DIR`). They are written instead of the "read only, refuse when different" of `1`.

**Checked before every agent launch:** otherwise that launch is refused (`CM_UAT_ISOLATION=own-home: refusing to start <tool>: <reason>`).

- The user running the process (`os.userInfo().username`) is `CM_UAT_DEDICATED_USER`
- `HOME` resolves to the same place as that user's home directory (from the account database, not `$HOME`) and is owned by that user
- Every write target (`CODEX_HOME`, `hooks.json`, the relay and its `.tmp`, `config.toml`, `~/.gemini/config/hooks.json`, `~/.copilot/` and `settings.json` with its backup, temp file and lock, `CM_AGENT_HOOKS_DIR` and claude's settings file itself) resolves, symlinks followed, to a path inside HOME owned by that user (a file not created yet is judged by its nearest existing ancestor). A dangling symlink is refused

**Kept (same as `1`):**

- A failed hook setup refuses the launch (never a bare start). So does a `hooks` key in copilot's `config.json`. So do a codex relay that could not be updated or still differs from the shipped one, and a claude settings file that could not be written (`CM_AGENT_HOOKS_INJECT=0` included). With the other values: codex, unset, logs a failed relay update and goes on with the older relay; with `1` it writes no relay and refuses the launch when the installed relay differs from the shipped one. claude, unset or `1`, starts bare (no hooks) when its settings file cannot be written (with `1`, carrying `--setting-sources project,local`)
- Temp files (the relay's `.tmp`, copilot's temp file) are removed and then created exclusively, so a planted symlink is never written through (whatever the value)
- claude's launch plan is built before its tmux session, so a refusal leaves no empty pane
- The receiver is pinned (`CM_HOOK_URL` and the others point at the run's server)
- Headless `codex exec` / `agy -p` (Schedules, daily summary) are refused; claude gets `--setting-sources project,local`
- The CLI reads no `.env` and never falls back to 3000 without `CM_PORT`

Under `own-home`, `run-server.sh down` records whether the shared files changed (the messages, and `shared_changed=yes|no` in the state file) but does not fail on it. Without `--own-home` (the user's UAT) it still fails.

The production receiver's `agent-event-unresolved-target` log carries `worktreeId` (when the hook named one) and `cwdHash` (the first 16 hex characters of the SHA-256 of `cwd`; `cwd` itself is never logged), so hooks from a dedicated-user run that reached production can be counted against the hash of the run's cwd.
