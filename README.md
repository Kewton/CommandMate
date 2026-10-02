# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](./README.md) | [日本語](./docs/ja/README.md)

**[commandmate website →](https://kewton.github.io/CommandMate/)**

> **No long blocks of time? Run an AI team from your phone.**

- 10+ PRs a day, solo
- $110–$210 a month: Claude Max + Command Code Goat
- ~80% of my instructions sent from a phone (my estimate)
- 689 PRs merged in September 2026, across my repositories

<p align="center">
  <img src="./docs/images/demo-hero.en.gif" width="560" alt="A list of four open issues, one message typed into the lead session, four worktree sessions in the sidebar, a worker writing a test file, and a final report with a phase-by-phase table" />
</p>

Open source (MIT) · runs on your machine · macOS / Linux / Windows (WSL2) · no app to install

---

## The problem

- The agents can work for hours. You can't sit at the desk for hours to answer them.
- From the outside, an idle agent and one waiting on you look the same.
- The agent's summary of what it did is not evidence of what it did.

---

## Three levels

### Level 1 — Many agents, one place, in your pocket

Every task gets its own Git worktree and session, on whichever agent fits: Claude Code, Codex, Gemini CLI, Copilot, OpenCode (1.x and V2), Antigravity, Command Code or local models. Waiting is read from the agents' own hooks, not guessed from the screen, and reaches your phone as a badge or a push notification. You answer from the browser.

### Level 2 — Work like a team, not a chat

A task goes out with a contract — the goal, the files it may change, the gates — and comes back with a verdict: the gates' exit code (`0` passed, `20` failed, `21` no evidence of work), not the agent's summary. A session can also hand its work to another agent for review.

### Level 3 — An AI team that builds and maintains

One message to a lead session: it plans several issues, hands each one to a worker under a contract, and only what passed the gates becomes a PR. Schedules keep work running while you are away. The author's daily auto-fix loop is the author's own operation built from these parts, not a switch in the product.

More on each level on the [website](https://kewton.github.io/CommandMate/), and the long form in [How CommandMate works](./docs/en/user-guide/how-it-works.md).

---

## Set up with your agent

Paste this into the agent CLI you already use (Claude Code, Codex, …):

```text
Read https://kewton.github.io/CommandMate/setup.md and help me set up CommandMate on this machine. Explain each step before you run it, and ask me before you install anything or open access from the internet.
```

### Or by hand

Requires macOS / Linux / Windows (WSL2), Node.js v22+, npm, git and tmux.

```bash
npm install -g commandmate
commandmate init
commandmate start --daemon
```

- Open http://127.0.0.1:3000. CommandMate binds `127.0.0.1` by default, and `localhost` can resolve to `::1` (IPv6) first — an address CommandMate does not listen on, and another process may.
- To try it without installing, run `npx commandmate@latest` (always with `@latest`). The [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) covers why, plus WSL2, updating and building from source.
- Phone notifications stay off until `commandmate init` has written `CM_VAPID_PUBLIC_KEY` / `CM_VAPID_PRIVATE_KEY` / `CM_VAPID_SUBJECT` into `.env`. See [Web App Guide → Phone Notifications](./docs/en/user-guide/webapp-guide.md#phone-notifications-web-push).
- To reach it from your phone, run `commandmate remote`: it publishes the server through Tailscale or Cloudflare (asking before anything goes on the public internet) and prints a QR code to pair with.

First commands, for you or for your agent:

| Command | What it does |
|---------|--------------|
| `commandmate status` | Is the server up, and is push configured |
| `commandmate remote` | Pair your phone with a QR code |
| `commandmate ls` | Every worktree and the state of its session |
| `commandmate send <id> "Implement Issue #101" --instance codex` | Send a message to one agent's session |
| `commandmate send <id> --contract .commandmate/tasks/issue-101.yaml --instance codex` | Hand over a task contract |
| `commandmate wait <id> --instance codex --verify` | Wait for the agent, then run the gates: exit `0` / `20` / `21` |
| `commandmate capture <id>` | Read the session's current output |
| `commandmate respond <id> "yes"` | Answer the prompt the agent is waiting on |
| `commandmate skill list` | The official Catalog Skills you can install per worktree |
| `commandmate update` | Update a global install and restart the server |
| `commandmate docs --section agent-operations` | The full command guide, for your agent to read |

Every command and flag is in the [CLI Operations Guide](./docs/en/user-guide/cli-operations-guide.md); `commandmate --help` lists the options.

---

## What it does not do

- It is a run, not a resident agent. Nothing loops forever, and nothing mutates without an explicit approve.
- It does not read the code for you. Gates catch what your tests and checks catch.
- Review by another agent is a step you add, not something the runner does for you.
- Approvals still come to a person. Auto Yes is opt-in, time-boxed, and stops on the patterns you set.
- It does not replace tmux, Git worktrees, your terminal, or your agent CLI. An OS reboot ends the processes; what survives is the record.

---

## Documentation

| Document | Description |
|----------|-------------|
| [How CommandMate works](./docs/en/user-guide/how-it-works.md) | The long form: measured runs, feature tables, use cases, supported agents, security, the Vibe Engineering workflow |
| [Tutorial](./docs/en/user-guide/tutorial.md) | Fork a sample repository and go from contract to verified result in about fifteen minutes |
| [Quick Start](./docs/en/user-guide/quick-start.md) | The minimum contract-and-verify loop on any agent, then a five-minute development flow |
| [CLI Setup Guide](./docs/en/user-guide/cli-setup-guide.md) | Installation, `npx`, initial setup, updating, building from source |
| [CLI Operations Guide](./docs/en/user-guide/cli-operations-guide.md) | Driving sessions from the CLI: execution contracts, verification gates, Skills, agent instances |
| [Web App Guide](./docs/en/user-guide/webapp-guide.md) | The web UI, phone access, app install (PWA), push notifications, supported browsers |
| [Troubleshooting & FAQ](./docs/en/user-guide/troubleshooting.md) | Stuck sessions, an empty-looking `tmux attach`, port conflicts, phone and remote access |
| [Skills Guide](./docs/en/user-guide/skills.md) | Installing official Catalog Skills into a worktree |
| [OpenCode V2 guide](./docs/en/user-guide/opencode-v2.md) | Running OpenCode V2 next to OpenCode 1.x |
| [Agent Event Hooks](./docs/en/user-guide/agent-event-hooks.md) | Structured agent events instead of terminal scraping |
| [Concept](./docs/en/concept.md) | The canonical Vision, Mission and core principle, and how each implementation item maps to a feature |
| [Product Highlights](./docs/en/features/product-highlights.md) | A feature-by-feature tour of the product |
| [Security Guide](./docs/en/security-guide.md) | No telemetry, no account; authentication and remote access |
| [Trust & Safety](./docs/en/TRUST_AND_SAFETY.md) | Security and permissions |
| [Architecture](./docs/en/architecture.md) | System design |
| [Deployment Guide](./docs/en/DEPLOYMENT.md) | Production environment setup |

## Contributing

Bug reports, feature suggestions, and documentation improvements are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[MIT License](./LICENSE) - Copyright (c) 2026 Kewton
