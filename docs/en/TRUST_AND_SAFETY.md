[日本語版](../TRUST_AND_SAFETY.md)

# Trust & Safety

This document explains CommandMate's security model and safe usage practices.

## Security Model

### Local Execution by Design

CommandMate runs on your local machine.

- The application, SQLite database, and tmux sessions all operate entirely locally
- External communication is limited to API calls made by the CLI tools themselves (Claude Code / Codex CLI)
  (for the exception when you publish the server with `commandmate remote`, see
  "External Access Dependencies (Optional)" below)
- No user data is sent to external servers

### Dependency on CLI Tools

This tool is a **UI for operating CLI tools** such as Claude Code and Codex CLI.

- The permission settings of each CLI tool apply as-is
- This tool does not extend or modify CLI tool permissions
- The scope of operations each CLI tool can perform follows that tool's own settings

### External Access Dependencies (Optional)

If you want to access CommandMate from outside your home, you can use Cloudflare Tunnel.

- Cloudflare Tunnel is **optional** and not needed for local-only use
- For LAN access, `CM_BIND=0.0.0.0` configuration is required. Reverse proxy authentication is recommended

#### Provider dependencies of `commandmate remote`

`commandmate remote` depends on an external tool — **`cloudflared`** (the Cloudflare Tunnel
client) or **`tailscale`** — depending on which provider it selects.

- Both are **optional dependencies**. If neither is installed, `remote` stops with
  `DEPENDENCY_ERROR` and nothing about ordinary local use of CommandMate changes
- CommandMate never installs either of them for you
- `remote` runs `cloudflared` as a child process. Tunnel traffic passes through Cloudflare,
  so use it **only if you are willing to trust Cloudflare as a transit path**
- The `tailscale-serve` provider does not spawn a long-lived process. It writes a Serve
  handler into configuration owned by `tailscaled` — configuration you may already be using
  for your own services, and which has no undo. Everything under "Cleanup removes only what
  CommandMate created" below exists because of that

#### What is exposed

- What goes outside is **the CommandMate server itself**. The server listening on
  127.0.0.1 becomes reachable through a provider URL — a random public address
  (`https://<random>.trycloudflare.com`) with Cloudflare, or a tailnet-only address with
  Tailscale Serve
- **The bind address does not change.** `remote` neither reads nor writes `CM_BIND`; it
  stays at the default `127.0.0.1`. No new port opens on your LAN
- Only this one CommandMate server is published. Nothing else on the machine is
- Because anyone who learns the URL can reach it, **CommandMate's own token authentication
  is mandatory**. `remote` always starts the server with authentication enabled, and only a
  device that redeems the pairing code (single-use, 10 minutes by default) can sign in
- **Creating a public tunnel always requires your explicit approval.** Interactively you
  are shown a warning and asked; non-interactively the run stops with `CONFIG_ERROR` unless
  you passed `--yes`. Nothing is ever published silently
- A Quick Tunnel URL changes on every start and carries no access policy and no audit log
  you control. **Do not use a Quick Tunnel for long-lived or production access**
  (details: `docs/security-guide.md`)

#### Cleanup removes only what CommandMate created

- `commandmate remote stop` reverts **only what CommandMate recorded creating**
- When the state file cannot be read, it **does not guess which provider to tear down.** It
  reports that it does not know what to clean up and exits successfully. Guessing could
  destroy provider configuration you set up yourself — a Tailscale Serve mapping you added
  by hand, say — which CommandMate has no way to restore
- For the same reason, do not follow the teardown hint Tailscale prints after a successful
  `serve`: re-running `serve` with only the port and "off", with no path, removes **every**
  handler on that port, yours included. `commandmate remote stop` always names the specific
  path it created
- When `--expires` (8 hours by default) elapses, **only the outward door closes — the
  server is not stopped**, because stopping it would take your local session on the machine
  down with it

## Least Privilege Guide

### Recommended Settings

- Set `CM_ROOT_DIR` to only **specific, git-managed directories**
- Use Claude Code's permission settings to limit operations to the target repository
- When exposing externally, set up reverse proxy authentication (details: `docs/security-guide.md`)
- For temporary access while you are away from your machine, use `commandmate remote`:
  publish for as long as you actually need and close it with `commandmate remote stop`
  (set `--expires` to the shortest value that does the job)

### Not Recommended

- Setting `CM_ROOT_DIR` to your entire home directory (`~`)
- Exposing the server with `CM_BIND=0.0.0.0` without reverse proxy authentication
- Enabling Auto Yes mode while Claude Code has broad file operation permissions
- Keeping a Cloudflare Quick Tunnel (`commandmate remote`) up as a permanent public
  entrance, for long-lived or production use
- Forwarding, screenshotting into a chat, or reusing the pairing QR code / URL — it is a
  single-use credential

## Preventing Dangerous Operations

### Confirmation Dialogs

- A confirmation dialog is displayed when enabling **Auto Yes mode**
- Auto Yes mode automatically approves CLI tool confirmation prompts, which carries a risk of unintended operations
- Duration options: **1 hour** (default) / **3 hours** / **8 hours**
  - 1 hour: 3,600,000 milliseconds
  - 3 hours: 10,800,000 milliseconds
  - 8 hours: 28,800,000 milliseconds
- Automatically turns OFF after the selected duration expires
- **Security implementation**:
  - worktreeId format validation (path traversal prevention)
  - JSON parse error handling
  - duration type validation (confirms number type)
  - Whitelist validation (only 3 allowed values accepted)
  - Default value fallback (1 hour when unspecified)
  - Invalid values rejected with 400 error

### Auto Yes Duration Risks and Recommendations

**Risk Scenarios**:
- **Broad file operations while away**: If the user is away during long Auto-Yes activation, the CLI tool may continue auto-approving confirmation prompts, potentially auto-approving broad file deletions or refactoring
- **Unexpected operations outside worktree**: If `CM_ROOT_DIR` is broadly configured, operations on unintended directories may be auto-approved
- **Accumulation of auto-responses over time**: Over long periods, many auto-responses may accumulate, making review difficult

**Best Practices**:
- **Minimum time selection**: Choose the minimum duration needed for your work. When in doubt, the default 1 hour is recommended
- **Limit CM_ROOT_DIR**: When using Auto-Yes for long periods, limit `CM_ROOT_DIR` to the target worktree directory to restrict the impact scope
- **Turn OFF when away**: When stepping away for extended periods, manually turn off Auto-Yes regardless of remaining time
- **8-hour use case**: Intended for long-running batch-like development tasks (large-scale refactoring, comprehensive test execution, etc.) where the user can periodically check progress

**Technical Safety**:
- TypeScript type safety: `AutoYesDuration` literal type eliminates invalid values at compile time
- Type guard function: `isAllowedDuration()` performs runtime type validation
- Shared config file: `src/config/auto-yes-config.ts` provides centralized management to prevent server-client inconsistencies
- 5-layer defense: format → JSON parse → type → whitelist → default multi-layer validation

### Operation Logs

- All chat messages are recorded in the SQLite database
- Claude Code's detailed output is saved in Markdown format under `.claude_logs/`
- Operation history can be reviewed at any time

## Notes

- This tool performs file operations through Claude Code, so **important files may be deleted or modified**
- When using with important repositories, taking backups beforehand is recommended
- For git-managed directories, recovery is possible via `git stash` or `git checkout`
- Use Auto Yes mode only after understanding its implications
