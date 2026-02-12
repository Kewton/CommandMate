[日本語版](../TRUST_AND_SAFETY.md)

# Trust & Safety

This document explains CommandMate's security model and safe usage practices.

## Security Model

### Local Execution by Design

CommandMate runs on your local machine.

- The application, SQLite database, and tmux sessions all operate entirely locally
- External communication is limited to API calls made by the CLI tools themselves (Claude Code / Codex CLI)
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

## Least Privilege Guide

### Recommended Settings

- Set `CM_ROOT_DIR` to only **specific, git-managed directories**
- Use Claude Code's permission settings to limit operations to the target repository
- When exposing externally, set up reverse proxy authentication (details: `docs/security-guide.md`)

### Not Recommended

- Setting `CM_ROOT_DIR` to your entire home directory (`~`)
- Exposing the server with `CM_BIND=0.0.0.0` without reverse proxy authentication
- Enabling Auto Yes mode while Claude Code has broad file operation permissions

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
