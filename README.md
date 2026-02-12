# CommandMate

[English](./README.md) | [日本語](./docs/ja/README.md)

> "Never miss a prompt — your development companion."
> "Lightweight. Self-contained. Run Claude Code from anywhere."

![Desktop view](./docs/images/screenshot-desktop.png)

## What is this?

A development companion tool that manages Claude Code sessions per Git worktree and lets you send instructions from your browser.

During your commute, childcare breaks, or lunch — send the next instruction as easily as replying to an email, and keep your side projects moving forward.

## What it is NOT

- It is not a terminal replacement. It **complements** Claude Code
- It does not replicate all CLI features — it specializes in "never missing a prompt/confirmation and responding immediately"

## Target Users

Developers with Claude Code experience who want to continue personal projects alongside their day job.

## Key Features

- **Prompt/confirmation detection** — Real-time status display in the sidebar (idle/ready/running/waiting)
- **Send instructions from browser** — Operate via message UI from both mobile and desktop
- **Execution history & notes** — Retains conversation history per branch with note-taking support
- **Markdown log viewer** — View Claude's detailed output in Markdown format
- **File viewer** — Browse worktree files from the browser
- **Auto Yes mode** — Control automatic approval with a confirmation dialog
- **Repository removal** — Remove repositories from app management (actual files are not deleted)
- **Clone URL registration** — Clone and register repositories by specifying HTTPS/SSH URLs
- **Claude Code optimized** — Optimized for Claude Code session management
- **Responsive UI** — Two-column layout on desktop, tab-based layout on mobile

### Worktree Detail View (Message / Console / History)

| Desktop | Mobile (History) | Mobile (Terminal) |
|---------|-----------------|-------------------|
| ![Desktop - Worktree detail](./docs/images/screenshot-worktree-desktop.png) | ![Mobile - History](./docs/images/screenshot-worktree-mobile.png) | ![Mobile - Terminal](./docs/images/screenshot-worktree-mobile-terminal.png) |

### Top Page (Mobile)

![Mobile view](./docs/images/screenshot-mobile.png)

## Quick Start

### Prerequisites

- macOS / Linux (Windows not supported due to tmux dependency)
- Node.js v20+, npm, git, tmux, openssl
- Claude CLI (optional)

### Installation

```bash
npm install -g commandmate
```

### Setup and Launch

```bash
commandmate init              # Dependency check, environment setup, DB initialization
commandmate start --daemon    # Start in background
```

Open http://localhost:3000 in your browser.

### CLI Commands

| Command | Description |
|---------|-------------|
| `commandmate init` | Initial setup (interactive) |
| `commandmate init --defaults` | Initial setup (default values) |
| `commandmate start --daemon` | Start in background |
| `commandmate start -p 3001` | Start on a specific port |
| `commandmate stop` | Stop the server |
| `commandmate status` | Check status |

See the [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) for details.

### Mobile Access

Enabling external access via `commandmate init` sets `CM_BIND=0.0.0.0`. Access from the same LAN at `http://<your PC's IP>:3000`. For external access, we recommend authentication via a reverse proxy. See the [Security Guide](./docs/security-guide.md) for details.

## Developer Setup

For contributors or those building a development environment, use git clone.

```bash
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
./scripts/setup.sh  # Auto-runs dependency check, env setup, build, and launch
```

### Manual Setup (for customization)

```bash
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
./scripts/preflight-check.sh          # Dependency check
npm install
./scripts/setup-env.sh                # Interactive .env generation
npm run db:init
npm run build
npm start
```

> **Note**: `./scripts/*` scripts are only available in the development environment. For global installs (`npm install -g`), use the `commandmate` CLI.

> **Note**: Legacy environment variable names (`MCBD_*`) are still supported for backward compatibility, but using the new names (`CM_*`) is recommended.

## FAQ

**Q: Does everything run locally?**
A: The app, database, and sessions all run entirely locally. The only external communication is the Claude CLI's own API calls.

**Q: How do I access it from my phone outside the house?**
A: You can use tunneling services like Cloudflare Tunnel. Within your home, simply connect your phone to the same Wi-Fi as your PC.

**Q: What about Claude Code's permissions?**
A: Claude Code's own permission settings apply as-is. This tool does not expand permissions. See [Trust & Safety](./docs/TRUST_AND_SAFETY.md) for details.

**Q: Does it work on Windows?**
A: Not currently supported. macOS / Linux is required due to the tmux dependency. WSL2 has not been tested.

**Q: Does it support CLI tools other than Claude Code?**
A: It supports Claude Code and Codex CLI. Thanks to the extensible Strategy pattern design, additional tools can be added in the future.

**Q: Can multiple people use it?**
A: Currently designed for individual use. Simultaneous multi-user access is not supported.

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) | Installation and initial setup |
| [Web App Guide](./docs/en/user-guide/webapp-guide.md) | Basic web app operations |
| [Quick Start](./docs/en/user-guide/quick-start.md) | Using Claude Code commands |
| [Concept](./docs/concept.md) | Vision and problems solved |
| [Architecture](./docs/architecture.md) | System design |
| [Deployment Guide](./docs/DEPLOYMENT.md) | Production environment setup |
| [Migration Guide](./docs/migration-to-commandmate.md) | Migrating from MyCodeBranchDesk |
| [UI/UX Guide](./docs/UI_UX_GUIDE.md) | UI implementation details |
| [Trust & Safety](./docs/TRUST_AND_SAFETY.md) | Security and permissions |

## Contributing

Bug reports, feature suggestions, and documentation improvements are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[MIT License](./LICENSE) - Copyright (c) 2026 Kewton
