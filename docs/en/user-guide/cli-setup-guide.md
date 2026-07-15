[日本語版](../../user-guide/cli-setup-guide.md)

# CommandMate CLI Setup Guide

This guide explains how to install and get started with CommandMate via npm.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Initial Setup](#initial-setup)
4. [Starting and Stopping the Server](#starting-and-stopping-the-server)
5. [CLI Command Reference](#cli-command-reference)
6. [Troubleshooting](#troubleshooting)
7. [Upgrading](#upgrading)
8. [Uninstalling](#uninstalling)

---

## Prerequisites

The following tools are required to use CommandMate.

| Tool | Version | Required | Check Command |
|------|---------|----------|---------------|
| Node.js | v20+ | Yes | `node -v` |
| npm | - | Yes | `npm -v` |
| Git | - | Yes | `git --version` |
| tmux | - | Yes | `tmux -V` |
| openssl | - | Yes | `openssl version` |
| Claude CLI | - | Optional | `claude --version` |
| gh CLI | - | Optional | `gh --version` |

### Checking Prerequisites

```bash
# Check all dependencies
node -v && npm -v && git --version && tmux -V && openssl version
```

### Installing Each Tool

#### macOS

```bash
# Using Homebrew
brew install node git tmux openssl
```

#### Ubuntu/Debian

```bash
sudo apt update
sudo apt install nodejs npm git tmux openssl
```

> **Note**: Windows is not currently supported (due to tmux dependency). WSL2 has not been tested.

---

## Installation

Install globally using npm.

```bash
npm install -g commandmate
```

Verify the installation:

```bash
commandmate --version
```

---

## Initial Setup

### Interactive Mode (recommended)

```bash
commandmate init
```

The interactive setup configures:
- Worktree root directory
- Server port (default: 3000)
- External access permission (for mobile access)
- Authentication token (auto-generated when external access is enabled)

### Non-interactive Mode

To set up with default values:

```bash
commandmate init --defaults
```

### Overwriting Existing Configuration

To overwrite existing settings:

```bash
commandmate init --force
```

---

## Starting and Stopping the Server

### Starting the Server

#### Background Start (recommended)

```bash
commandmate start --daemon
```

#### Foreground Start

```bash
commandmate start
```

#### Development Mode

```bash
commandmate start --dev
```

#### Start on a Specific Port

```bash
commandmate start --port 3001
```

### Checking Server Status

```bash
commandmate status              # Main server status
commandmate status --all        # All servers (main + worktrees)
commandmate status --issue 135  # Worktree server for Issue #135
```

### Stopping the Server

```bash
commandmate stop                # Stop the main server
commandmate stop --issue 135    # Stop the worktree server for Issue #135
```

#### Force Stop

```bash
commandmate stop --force
```

### Accessing via Browser

After starting the server, open your browser at:

```
http://localhost:3000
```

> **Port change**: Use the port specified with the `--port` option.

---

## CLI Command Reference

### commandmate --version

Display the version.

```bash
commandmate --version
```

### commandmate init

Perform initial setup.

```bash
commandmate init [options]
```

| Option | Description |
|--------|-------------|
| `--defaults` | Set up non-interactively with default values |
| `--force` | Overwrite existing settings |

### commandmate start

Start the server.

```bash
commandmate start [options]
```

| Option | Description |
|--------|-------------|
| `--daemon` | Start in background |
| `--dev` | Start in development mode |
| `-p, --port <number>` | Specify port (default: 3000) |
| `-i, --issue <number>` | Start a server for a specific issue worktree (Issue #136) |
| `--auto-port` | Automatically allocate a port for the worktree server (Issue #136) |
| `--auth` | Enable token authentication (Issue #331) |
| `--auth-expire <duration>` | Token expiration (e.g., `24h`, `7d`, `90m`) |
| `--https` | Enable HTTPS |
| `--cert <path>` | Path to TLS certificate file |
| `--key <path>` | Path to TLS private key file |
| `--allow-http` | Suppress the HTTPS warning when using `--auth` without certificates |
| `--allowed-ips <cidrs>` | Allowed IP addresses/CIDR ranges (comma-separated, Issue #331) |
| `--trust-proxy` | Trust the `X-Forwarded-For` header from a reverse proxy |

#### Parallel Worktree Development (Issue #136)

Run an independent server per worktree.

```bash
commandmate start --issue 135 --auto-port  # Start a server for Issue #135 (auto port)
commandmate start --issue 135 --port 3135  # Start on a specific port
```

#### Authentication / External Access (Issue #331)

```bash
commandmate start --auth --auth-expire 24h          # Token auth (24h expiry)
commandmate start --auth --allowed-ips 192.168.1.0/24  # With IP restriction
commandmate start --https --cert ./cert.pem --key ./key.pem  # HTTPS
```

### commandmate stop

Stop the server.

```bash
commandmate stop [options]
```

| Option | Description |
|--------|-------------|
| `-f, --force` | Force stop (SIGKILL) |
| `-i, --issue <number>` | Stop the server for a specific issue worktree (Issue #136) |

### commandmate status

Display server status.

```bash
commandmate status [options]
```

| Option | Description |
|--------|-------------|
| `-i, --issue <number>` | Show status for a specific issue worktree (Issue #136) |
| `-a, --all` | Show status for all servers (main + worktrees) |

### commandmate update

Update CommandMate to the latest version (stop -> `npm install -g commandmate@latest` -> restart).

```bash
commandmate update [options]
```

| Option | Description |
|--------|-------------|
| `--check` | Only check for updates (no install, stop or restart) |
| `-y, --yes` | Skip the confirmation prompt (required for non-interactive use) |

See [Upgrading](#upgrading) for details and caveats.

### commandmate issue

GitHub Issue management command (requires gh CLI).

```bash
commandmate issue create [options]
commandmate issue search <query>
commandmate issue list
```

| Subcommand | Description |
|------------|-------------|
| `create` | Create a new Issue |
| `search <query>` | Search Issues |
| `list` | List Issues |

#### create options

| Option | Description |
|--------|-------------|
| `--title <title>` | Issue title |
| `--body <body>` | Issue body |
| `--bug` | Use Bug Report template |
| `--feature` | Use Feature Request template |
| `--question` | Use Question template |
| `--labels <labels>` | Labels (comma-separated) |

### commandmate docs

Display CommandMate documentation.

```bash
commandmate docs [options]
```

| Option | Description |
|--------|-------------|
| `--section <name>` | Display specified section content |
| `--search <query>` | Search within documentation |
| `--all` | List all available sections |

---

## Troubleshooting

### command not found Error

If you see `commandmate: command not found`:

```bash
# Check npm global bin path
npm config get prefix

# Add to PATH (bash/zsh)
export PATH="$(npm config get prefix)/bin:$PATH"

# Persist (~/.bashrc or ~/.zshrc)
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Permission Error (EACCES)

If you get a permission error with `npm install -g`:

#### Method 1: Change npm prefix (recommended)

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# Persist
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc

# Reinstall
npm install -g commandmate
```

#### Method 2: Use sudo (not recommended)

```bash
sudo npm install -g commandmate
```

### Port Conflict

If you see `Error: Port 3000 is already in use`:

```bash
# Start on a different port
commandmate start --port 3001

# Or check and stop the process using the port
lsof -ti:3000 | xargs kill -9
```

### Server Won't Start

```bash
# Check status
commandmate status

# Force stop and restart
commandmate stop --force
commandmate start --daemon

# Check logs (in config directory)
tail -f ~/.commandmate/logs/server.log
```

### Dependency Errors

```bash
# tmux not found
brew install tmux  # macOS
sudo apt install tmux  # Ubuntu/Debian

# Node.js version too old
node -v  # v20+ required
```

### Database Errors

```bash
# Reset database (data will be deleted)
rm -rf ~/.commandmate/data
commandmate init --force
```

---

## Upgrading

If CommandMate is installed globally (`npm install -g commandmate`), a single `commandmate update` upgrades it.

```bash
commandmate update
```

In a global install, it runs the following steps:

1. Query the npm registry for the latest version and compare it with the current one
2. Only when an update exists, print the caveats and ask for confirmation (defaults to no)
3. Stop the server if it is running
4. Run `npm install -g commandmate@latest`
5. Verify that the installed version matches the latest version
6. Restart the server it stopped and wait for it to respond (up to 30 seconds)

If the server was not running beforehand, it is not started for you.
If you are already up to date, if your local version is newer, or if either version is a prerelease, the update is skipped.

### Checking for Updates Only

`--check` prints the versions and changes nothing.

```bash
commandmate update --check
```

```
Current: v0.9.0
Latest: v0.10.0
Update available: yes
```

### Non-interactive Use

Use `--yes` to skip the confirmation prompt.

```bash
commandmate update --yes
```

Without `--yes` in an environment that has no TTY (CI, scripts), nothing is updated and the command exits with code `2`.

### Caveats

- **Startup options are not restored**: after the restart the server only uses the settings in `.env`. If you started it with `--auth`, `--auth-expire`, `--cert`, `--key`, `--allow-http`, `--allowed-ips`, `--trust-proxy`, `--port` or `--dev`, start it again manually after the update (`--auth` generates a new token on every start, so existing tokens are invalidated).
- **Worktree servers (`--issue`) are not stopped or restarted for you**: `npm install -g` replaces the package directory (`dist/`, `.next/`), so a running worktree server may crash. Stop them **before** updating with `commandmate stop --issue <number>` and restart them afterwards with `commandmate start --issue <number>`. The command warns you when it detects running worktree servers.
- **Permission errors (EACCES)**: do not re-run with `sudo`. Fix the npm global directory permissions as described in [Permission Error (EACCES)](#permission-error-eacces), then run `commandmate update` again.
- **When authentication is enabled**: the post-restart check degrades to "the server responds" and finishes with a warning instead of a strict readiness check. Set `CM_AUTH_TOKEN` for the strict check (IP restrictions and self-signed certificates degrade it the same way).
- **If the update fails**: the command prints a rollback command for the version you had before (`npm install -g commandmate@<previous-version>`). If the server cannot be stopped, the update aborts without changing anything.

### Upgrading Manually (fallback)

If you cannot use `commandmate update`, upgrade manually as before.

```bash
commandmate stop
npm install -g commandmate@latest
commandmate start --daemon
```

In a git clone (development) environment, `commandmate update` does not update anything; it prints these steps and exits.

```bash
git pull
npm install
npm run build:all
commandmate stop && commandmate start --daemon   # or: npm start
```

> Run `npm run build:all`, not `npm run build`. The latter only builds Next.js and leaves the server (`dist/server`) and the CLI (`dist/cli`) stale.

After upgrading, verify the version:

```bash
commandmate --version
```

---

## Uninstalling

### 1. Stop the Server

```bash
commandmate stop
```

### 2. Uninstall the Package

```bash
npm uninstall -g commandmate
```

### 3. Remove Configuration Files (optional)

```bash
# Completely remove configuration and data
rm -rf ~/.commandmate
```

---

## Next Steps

- [Web App Guide](./webapp-guide.md) - Basic browser operations
- [Quick Start Guide](./quick-start.md) - Using Claude Code commands
- [Deployment Guide](../../DEPLOYMENT.md) - Production environment deployment

---

## Related Documentation

- [README](../../../README.md) - Project overview
- [Architecture](../../architecture.md) - System design
- [Trust & Safety](../../TRUST_AND_SAFETY.md) - Security and permissions
