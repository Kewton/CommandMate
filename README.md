# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](./README.md) | [日本語](./docs/ja/README.md)

<!-- TODO: Upload docs/images/demo-desktop.mp4 via GitHub UI and replace this URL -->
<p align="center">
  <video src="./docs/images/demo-desktop.mp4" width="600" controls></video>
</p>

> **Move issues forward, not terminal tabs.**

CommandMate is an IDE for issue-driven AI development.

```bash
npx commandmate
```

**From install to your first session in 60 seconds.** macOS / Linux · Node.js v20+ · npm · git · tmux

---

Instead of jumping straight into implementation, you define an issue, refine it with AI, review the direction, generate a plan, and then let your coding agent execute. CommandMate helps you run multiple issues in parallel with Git worktrees, choose the right agent for each issue, and keep work moving even when you leave your desk.

If your workflow is shifting from "writing code yourself" to "defining issues, reviewing direction, and accepting outcomes," CommandMate can become the center of your development workflow.

<!-- TODO: Upload docs/images/demo-mobile.mp4 via GitHub UI and replace this URL -->
<p align="center">
  <video src="./docs/images/demo-mobile.mp4" width="300" controls></video>
</p>

Works on desktop and mobile — monitor and steer sessions from any browser, including your phone.

---

## Issue-Driven Development

CommandMate recommends the following development method. By adopting this process, humans can focus on defining issues and verifying final outputs.

```
Define Issue → Refine with AI → Review Direction → Generate Plan → Agent Executes
```

| Step | Command | What happens |
|------|---------|-------------|
| Refine the issue | `/issue-enhance` | AI asks clarifying questions and fills in missing details |
| Review the issue | `/multi-stage-issue-review` | Multi-stage review (consistency, impact scope) with automated fixes |
| Review the design | `/multi-stage-design-review` | 4-stage review (general → consistency → impact → security) |
| Plan the work | `/work-plan` | Generates a task breakdown with dependencies |
| Implement via TDD | `/tdd-impl` | Red-Green-Refactor cycle, automated |
| Verify acceptance | `/acceptance-test` | Validates all acceptance criteria from the issue |
| Create the PR | `/create-pr` | Auto-generates title, description, and labels |
| Dev (full) | `/pm-auto-dev` | TDD implementation → acceptance test → refactoring → progress report |
| Issue → Dev (full) | `/pm-auto-issue2dev` | Issue review → design review → work plan → TDD → acceptance test → refactoring → progress report |
| Design → Dev (full) | `/pm-auto-design2dev` | Design review → work plan → TDD → acceptance test → refactoring → progress report |

For details, see the [issues](https://github.com/Kewton/CommandMate/issues), [dev reports](./dev-reports/issue/), and [workflow examples](./docs/en/user-guide/workflow-examples.md) in the CommandMate repository.

---

## Key Features

| Feature | What it does | Why it matters |
|---------|-------------|----------------|
| **Issue-Driven Commands** | Slash commands that follow the define → plan → execute cycle | Development stays structured around issues, not ad-hoc prompts |
| **Git Worktree Sessions** | One session per worktree, parallel execution | Multiple issues progress simultaneously without interference |
| **Multi-Agent Support** | Choose Claude Code, Codex, Gemini, or local models per issue | Pick the right agent for each task |
| **Auto Yes Mode** | Agent runs without stopping for confirmations | No babysitting — the agent keeps working while you're away |
| **Web UI (Desktop & Mobile)** | Full session control from any browser | Monitor and steer from your desk or your phone |
| **File Viewer & Markdown Editor** | Browse and edit worktree files in the browser | Review changes and update AI instructions without opening an IDE |
| **Screenshot Instructions** | Attach images to your prompts | Snap a bug → "Fix this" — the agent sees the screenshot |
| **Scheduled Execution** | Cron-based auto-run via CMATE.md | Daily reviews, nightly tests — agents work on a schedule |
| **Token Authentication** | SHA-256 hashed token + HTTPS + rate limiting | Secure remote access — no credentials leaked, brute-force protected |

---

## Use Cases

| Scenario | How CommandMate helps |
|----------|----------------------|
| **Parallel issue development** | Run multiple issues in separate worktrees, each with its own agent session |
| **Issue refinement** | Define an issue, let AI fill gaps, review before any code is written |
| **Overnight execution** | Queue issues with scheduled execution — check progress in the morning |
| **Mobile review** | Review AI-generated changes and steer direction from your phone |
| **Visual bug fix** | Snap a UI bug on your phone, send it with "Fix this" |

---

## Screenshots

<!-- TODO: Upload docs/images/demo-desktop.mp4 via GitHub UI and replace this URL -->
<p align="center">
  <video src="./docs/images/demo-desktop.mp4" width="600" controls></video>
</p>

---

## Security

Runs **100% locally**. No external server, no cloud relay, no account required. The only network traffic is Claude CLI's own API calls.

- Fully open-source ([MIT License](./LICENSE))
- Local database, local sessions
- For remote access, use a tunneling service ([Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), [ngrok](https://ngrok.com/), [Pinggy](https://pinggy.io/)), a VPN, or an authenticated reverse proxy

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
<summary><strong>Quick Start (detailed)</strong></summary>

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

</details>

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
A: Yes. Use a tunneling service to securely expose your local server without opening router ports:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — free, requires Cloudflare account
- [ngrok](https://ngrok.com/) — free tier available, easy setup
- [Pinggy](https://pinggy.io/) — no sign-up required, simple SSH-based tunnel

Alternatively, a VPN or an authenticated reverse proxy (Basic Auth, OIDC, etc.) also works. **Do not** expose the server directly to the internet without authentication.

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

<details>
<summary><strong>Comparison</strong></summary>

| Feature | CommandMate | Remote Control (Official) | Happy Coder | claude-squad | Omnara |
|---------|:-----------:|:------------------------:|:-----------:|:------------:|:------:|
| Auto Yes Mode | Yes | No | No | Yes (TUI only) | No |
| Git Worktree Management | Yes | No | No | Yes (TUI only) | No |
| Parallel Sessions | Yes | **No (1 only)** | Yes | Yes | No |
| Mobile Web UI | Yes | Yes (claude.ai) | Yes | **No** | Yes |
| File Viewer | Yes | No | No | No | No |
| Markdown Editor | Yes | No | No | No | No |
| Screenshot Instructions | Yes | No | No | Not possible | No |
| Scheduled Execution | Yes | No | No | No | No |
| Survives Laptop Close | Yes (daemon) | **No (terminal must stay open)** | Yes | Yes | Yes |
| Token Authentication | Yes | N/A (Anthropic account) | N/A (app) | No | N/A (cloud) |
| Free / OSS | Yes | Requires Pro/Max | Free + Paid | Yes | $20/mo |
| Runs 100% Locally | Yes | Via Anthropic API | Server-routed | Yes | Cloud fallback |

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
