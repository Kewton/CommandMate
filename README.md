# CommandMate

![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](./README.md) | [日本語](./docs/ja/README.md)

<p align="center">
  <img src="./docs/images/demo-mobile.gif" alt="CommandMate mobile demo" width="300">
</p>

> **Claude Code keeps coding while you're away. Check in from your phone.**

Not a "remote control" — a **mobile dev cockpit**.

You kick off a task, close your laptop, and head out.
On the train, you pull out your phone — the agent is still running.
You review the diff, tweak the instructions, and snap a screenshot of a UI bug.
Claude sees it and starts fixing. All from your pocket.

Of course, it works great on desktop too — the two-column layout gives you a full overview of all sessions and worktrees at a glance.

<p align="center">
  <img src="./docs/images/demo-desktop.gif" alt="CommandMate desktop demo" width="600">
</p>

```bash
npx commandmate
```

---

## The 6 Pillars

| Pillar | What it does | Why it matters |
|--------|-------------|----------------|
| **Auto Yes Mode** | Agent runs without stopping for confirmations | No babysitting — Claude Code keeps working while you're away |
| **Git Worktree Sessions** | One session per worktree, parallel execution | Multiple tasks progress simultaneously |
| **Mobile Web UI** | Full session control from any browser | Monitor and steer from your phone |
| **File Viewer** | Browse worktree files from the browser | Review code changes without touching your PC |
| **Markdown Editor** | Edit Markdown files in the browser | Update AI instructions on the go |
| **Screenshot Instructions** | Attach images to your prompts | Snap a bug → "Fix this" — the agent sees the screenshot |

---

## Quick Start

**Prerequisites:** macOS / Linux, Node.js v20+, npm, git, tmux, openssl

```bash
# Install & start in one command
npx commandmate

# Or install globally
npm install -g commandmate
commandmate init
commandmate start --daemon
```

Open http://localhost:3000 in your browser.

See the [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) for details.

---

## Comparison

| Feature | CommandMate | Happy Coder | claude-squad | Omnara |
|---------|:-----------:|:-----------:|:------------:|:------:|
| Auto Yes Mode | Yes | No | Yes (TUI only) | No |
| Git Worktree Management | Yes | No | Yes (TUI only) | No |
| Mobile Web UI | Yes | Yes | **No** | Yes |
| File Viewer | Yes | No | No | No |
| Markdown Editor | Yes | No | No | No |
| Screenshot Instructions | Yes | No | Not possible | No |
| Free / OSS | Yes | Free + Paid | Yes | $20/mo |
| Runs 100% Locally | Yes | Server-routed | Yes | Cloud fallback |

---

## Workflow

```
1. Start tasks on your PC
   $ commandmate start --daemon
   → Claude Code begins working with Auto Yes

2. Close your laptop and go

3. Check in from your phone
   → Web UI shows all sessions at a glance

4. Review code changes
   → File Viewer lets you read diffs on mobile

5. Adjust direction
   → Edit a Markdown instruction file, or type a new prompt

6. Snap a bug
   → Screenshot Instructions: attach a photo and say "Fix this"

7. Claude Code sees the image and starts fixing
```

---

## Security

Runs **100% locally**. No external server, no cloud relay, no account required. The only network traffic is Claude CLI's own API calls.

- Fully open-source ([MIT License](./LICENSE))
- Local database, local sessions
- For remote access, use a VPN or authenticated reverse proxy

See the [Security Guide](./docs/security-guide.md) and [Trust & Safety](./docs/en/TRUST_AND_SAFETY.md) for details.

---

## How it works

```mermaid
flowchart LR
    A["Browser / Phone"] -->|HTTP| B["CommandMate Server"]
    B --> C["Session Manager"]
    C -->|"spawn / attach"| D["tmux sessions\n(per worktree)"]
    D --> E["Claude Code CLI"]
    C <-->|"read / write"| F[("Local DB\n& State")]
```

Each Git worktree gets its own tmux session, so multiple tasks run in parallel without interference.

---

<details>
<summary><strong>CLI Commands</strong></summary>

### Basic

| Command | Description |
|---------|-------------|
| `commandmate init` | Initial setup (interactive) |
| `commandmate init --defaults` | Initial setup (default values) |
| `commandmate init --force` | Overwrite existing configuration |
| `commandmate start` | Start the server (foreground) |
| `commandmate start --daemon` | Start in background |
| `commandmate start --dev` | Start in development mode |
| `commandmate start -p 3001` | Start on a specific port |
| `commandmate stop` | Stop the server |
| `commandmate stop --force` | Force stop (SIGKILL) |
| `commandmate status` | Check status |

### Worktree Parallel Development

Run separate servers per Issue/worktree with automatic port allocation.

| Command | Description |
|---------|-------------|
| `commandmate start --issue 123` | Start server for Issue #123 worktree |
| `commandmate start --issue 123 --auto-port` | Start with automatic port allocation |
| `commandmate start --issue 123 -p 3123` | Start on a specific port |
| `commandmate stop --issue 123` | Stop server for Issue #123 |
| `commandmate status --issue 123` | Check status for Issue #123 |
| `commandmate status --all` | Check status for all servers |

### GitHub Issue Management

Requires [gh CLI](https://cli.github.com/) to be installed.

| Command | Description |
|---------|-------------|
| `commandmate issue create` | Create a new issue |
| `commandmate issue create --bug` | Create with bug report template |
| `commandmate issue create --feature` | Create with feature request template |
| `commandmate issue create --question` | Create with question template |
| `commandmate issue create --title <title>` | Specify issue title |
| `commandmate issue create --body <body>` | Specify issue body |
| `commandmate issue create --labels <labels>` | Add labels (comma-separated) |
| `commandmate issue search <query>` | Search issues |
| `commandmate issue list` | List issues |

### Documentation

| Command | Description |
|---------|-------------|
| `commandmate docs` | Show documentation |
| `commandmate docs -s <section>` | Show a specific section |
| `commandmate docs -q <query>` | Search documentation |
| `commandmate docs --all` | List all available sections |

See `commandmate --help` for all options.

</details>

<details>
<summary><strong>Screenshots</strong></summary>

### Desktop

![Desktop view](./docs/images/screenshot-desktop.png)

### Worktree Detail View (Message / Console / History)

| Desktop | Mobile (History) | Mobile (Terminal) |
|---------|-----------------|-------------------|
| ![Desktop - Worktree detail](./docs/images/screenshot-worktree-desktop.png) | ![Mobile - History](./docs/images/screenshot-worktree-mobile.png) | ![Mobile - Terminal](./docs/images/screenshot-worktree-mobile-terminal.png) |

### Top Page (Mobile)

![Mobile view](./docs/images/screenshot-mobile.png)

</details>

<details>
<summary><strong>Troubleshooting & FAQ</strong></summary>

### Claude CLI not found / path changed?

If you switch between npm and standalone versions of Claude CLI, the path may change. CommandMate auto-detects the new path on the next session start. To set a custom path, add `CLAUDE_PATH=/path/to/claude` to `.env`.

### Port conflict?

```bash
commandmate start -p 3001
```

### Session stuck or not responding?

Check tmux sessions directly. CommandMate manages sessions with the naming format `mcbd-{tool}-{worktree}`:

```bash
# List all CommandMate sessions
tmux list-sessions | grep mcbd

# View session output (without attaching)
tmux capture-pane -t "mcbd-claude-feature-123" -p

# Attach to inspect (detach with Ctrl+b then d)
tmux attach -t "mcbd-claude-feature-123"

# Kill a broken session
tmux kill-session -t "mcbd-claude-feature-123"
```

> **Note:** When attached, avoid typing directly into the session — this can interfere with CommandMate's session management. Use `Ctrl+b` then `d` to detach and operate through the CommandMate UI instead.

### Sessions fail when launching from within Claude Code?

Claude Code sets `CLAUDECODE=1` to prevent nesting. CommandMate removes this automatically, but if it persists, run: `tmux set-environment -g -u CLAUDECODE`

### FAQ

**Q: How do I use CommandMate from my phone?**
A: CommandMate runs a web server on your PC. To access it from your phone, your phone and PC must be on the same network (Wi-Fi). Run `commandmate init` and enable external access — this sets `CM_BIND=0.0.0.0`. Then open `http://<your-PC-IP>:3000` in your phone's browser.

**Q: Can I access it from outside my home network?**
A: Yes. Use a tunneling service like [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to securely expose your local server without opening router ports. Alternatively, a VPN or an authenticated reverse proxy (Basic Auth, OIDC, etc.) also works. **Do not** expose the server directly to the internet without authentication.

**Q: Does it work on iPhone / Android?**
A: Yes. CommandMate's Web UI is responsive and works on any modern mobile browser (Safari, Chrome, etc.). No app install required.

**Q: Is tmux required?**
A: CommandMate uses tmux internally to manage CLI sessions. You don't need to operate tmux directly — CommandMate handles it for you.

**Q: What about Claude Code's permissions?**
A: Claude Code's own permission settings apply as-is. CommandMate does not expand permissions. See [Trust & Safety](./docs/en/TRUST_AND_SAFETY.md) for details.

**Q: Can multiple people use it?**
A: Currently designed for individual use. Simultaneous multi-user access is not supported.

</details>

<details>
<summary><strong>Developer Setup</strong></summary>

For contributors or those building a development environment:

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

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) | Installation and initial setup |
| [Web App Guide](./docs/en/user-guide/webapp-guide.md) | Basic web app operations |
| [Quick Start](./docs/en/user-guide/quick-start.md) | Using Claude Code commands |
| [Concept](./docs/en/concept.md) | Vision and problems solved |
| [Architecture](./docs/en/architecture.md) | System design |
| [Deployment Guide](./docs/en/DEPLOYMENT.md) | Production environment setup |
| [UI/UX Guide](./docs/en/UI_UX_GUIDE.md) | UI implementation details |
| [Trust & Safety](./docs/en/TRUST_AND_SAFETY.md) | Security and permissions |

## Contributing

Bug reports, feature suggestions, and documentation improvements are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[MIT License](./LICENSE) - Copyright (c) 2026 Kewton
