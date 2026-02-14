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
commandmate status
```

### Stopping the Server

```bash
commandmate stop
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
| `--port <port>` | Specify port (default: 3000) |

### commandmate stop

Stop the server.

```bash
commandmate stop [options]
```

| Option | Description |
|--------|-------------|
| `--force` | Force stop |

### commandmate status

Display server status.

```bash
commandmate status
```

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

To upgrade to the latest version:

```bash
npm install -g commandmate@latest
```

After upgrading, verify the version:

```bash
commandmate --version
```

Restart the server:

```bash
commandmate stop
commandmate start --daemon
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
