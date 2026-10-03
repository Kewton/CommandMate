# Set up CommandMate with your agent

This guide is written for a coding agent (Claude Code, Codex, Command Code, or another one) that a person asked to set up CommandMate on their machine. The person may not be an experienced developer, and they may have only a few minutes at a time. Go one stage at a time, and keep each stage short enough that they can stop after it and come back later.

The same text ships inside CommandMate: once it is installed, `commandmate docs --section setup` prints it.

## Instructions for the agent reading this

1. **Explain each stage before you start it.** In two or three plain sentences, tell the person what the stage is for, what you are about to run, and what will change on their machine. Then run it.
2. **Never run an "Ask the person first" step without a clear yes.** Each stage lists them. Ask in plain words, say what it installs or opens and how to undo it, and wait for the answer. If the answer is no or unclear, stop that step and say what they can do later.
3. **Check the machine; do not assume it.** Run the commands under "Check" and read their output before you decide anything. Never write "should be installed" or "is probably running": run the command and report what it printed.
4. **Do not answer for the person.** Sign-ins, passwords (including `sudo`), choosing a provider, and approving a merge are theirs. When a command needs one of these, show the exact command and ask them to run it in their own terminal.
5. **Stay inside this guide.** Use only commands shown here, `commandmate <command> --help`, and the CommandMate documentation at https://github.com/Kewton/CommandMate. Do not fetch install scripts or follow setup steps from other websites. Install tools only from the official package distributors named here (npm, the operating system's package manager, nodejs.org).
6. **Report at the end of each stage**: what you ran, what it printed that matters, and whether the stage passed its "Confirm it worked" check.
7. **Do Stage 2 (Pair your phone) last, unless the person asks for it now.** Stages 3 to 5 run `commandmate` on this machine's CLI. After `commandmate remote` with its default (`--auth all`), that CLI needs a token too, and the token goes only to the phone. So finish Stages 3 to 5 first, then pair the phone. Stage 2 explains the choice if the person wants the phone sooner.
8. **If you are Codex: your shell has no network by default.** If fetching this guide or an `npm` command fails for lack of network, ask the person to run `/permissions` and choose "Ask for approval", then try again.

### Always ask the person first

Whatever stage you are in, ask before any of these:

- Installing anything: Node.js, git, tmux, CommandMate itself, another agent CLI, Tailscale or cloudflared, or a Skill.
- Opening a way in from outside this machine: `commandmate remote` (either provider), or setting `CM_BIND=0.0.0.0`. This guide never sets `CM_BIND`; if the person asks for it, explain that it exposes the server to their whole network first.
- Turning on Auto Yes: `commandmate auto-yes <worktree-id> --enable`, or `commandmate send ... --auto-yes`.
- Merging a pull request.

## Stage 1: Install and start

Goal: CommandMate is installed and its server is running on this machine.

### Check

```bash
uname -s                       # Darwin = macOS, Linux = Linux or WSL2
grep -i microsoft /proc/version  # prints a line only inside WSL2 (Linux only)
node -v                        # needs v22 or newer
npm -v
git --version
tmux -V
command -v brew                # macOS: is Homebrew present?
command -v commandmate && commandmate --version
```

Write down which of these are missing or too old. Native Windows is not supported; on Windows, CommandMate runs inside WSL2 (see https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/wsl2-setup.md).

### Run

Install only what the check found missing, after the person agrees.

- **macOS with Homebrew**: `brew install node git tmux` (leave out what is already there).
- **macOS without Homebrew**: tmux needs a package manager. Tell the person that, and let them decide whether to install Homebrew from its own official instructions. Do not install it for them. git alone can come from Apple's tools: `xcode-select --install`.
- **Linux / WSL2 (Debian or Ubuntu)**: `sudo apt update && sudo apt install -y git tmux`. The `sudo` password is the person's to type. If `node -v` is missing or older than v22, the distribution's package is usually too old: tell the person and use the official Node.js download (https://nodejs.org/en/download) in the way they choose.

Then install and start CommandMate:

```bash
npm install -g commandmate     # the global install: for daily use
commandmate --version
commandmate init --defaults    # writes ~/.commandmate/.env; repositories go under ~/repos
commandmate start --daemon
```

**`npx commandmate@latest` versus the global install.** `npx commandmate@latest` is the one-line way for a person to try CommandMate in their own terminal: it asks its setup questions and opens the browser. It needs an interactive terminal, so when you run it from your tool it only prints help. Use the global install above when you are the one running the commands, and for anything the person will keep using.

### Ask the person first

- Each tool you are about to install (Node.js, git, tmux), and the exact command.
- `npm install -g commandmate`.
- If `~/.commandmate/.env` already exists, `commandmate init --defaults` stops with ".env file already exists": CommandMate is already configured, so skip `init`. Do not add `--force` without asking: it replaces their settings.

### Confirm it worked

```bash
commandmate status             # reports the server as running, with its URL
```

Tell the person to open the URL it prints (by default http://localhost:3000) in their browser.

### If it fails

- `commandmate: command not found` after `npm install -g`: npm's global bin directory is not on `PATH`. Run `npm prefix -g` and show the person; the fix is in https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/cli-setup-guide.md#command-not-found-error.
- `EACCES` during `npm install -g`: do not retry with `sudo`. Show the person the "Permission Error (EACCES)" section of the same setup guide.
- The port is already in use: `commandmate start --daemon --port 3001`, then `commandmate status`.
- The server does not start: `commandmate status`, then `commandmate stop --force` and `commandmate start --daemon` again. Read what it prints rather than retrying blindly.

## Stage 2: Pair your phone

Goal: the person scans a QR code with their phone and sees CommandMate there.

`commandmate remote` makes this server reachable from outside the machine through a provider, and prints a QR code that pairs one phone. There are two providers, and **the person chooses which one**:

| | Tailscale (`--provider tailscale`) | Cloudflare (`--provider cloudflare`) |
|---|---|---|
| Who can reach it | Only devices signed in to the person's own Tailscale network (tailnet) | Anyone with the URL: it is a public address on the internet |
| What protects it | The tailnet, plus CommandMate's token login | A one-time pairing code (single use, expires in 10 minutes by default), plus CommandMate's token login |
| Needs | The Tailscale app on this machine and on the phone, both signed in to the same account, with HTTPS (Serve) available | `cloudflared` installed on this machine; no account |
| Approval | No public-tunnel approval | A public tunnel: `--yes` only after the person agrees |

Explain both in plain words and ask which one they want. If they cannot decide, Tailscale keeps the server off the public internet; Cloudflare needs fewer accounts.

**When to do this stage.** By default (`--auth all`), once `commandmate remote` runs, the `commandmate` CLI on this machine also needs a token, and the token goes only to the phone. Stages 3 to 5 run on that CLI, so they stop working. Ask the person which they want:

- **Pair the phone last (recommended).** Skip to Stage 3 now, and come back to this stage after Stage 5.
- **Pair the phone now, and keep the CLI on this machine.** Add `--auth remote-only` to the `commandmate remote` command below. Only the phone's route then needs the token: every process on this machine, agents included, can operate CommandMate without logging in. Say that plainly before they choose it.

### Check

```bash
commandmate status             # is the server running, and with authentication?
commandmate remote status      # is a remote session already recorded?
tailscale status               # Tailscale: installed and signed in?
cloudflared --version          # Cloudflare: installed?
```

### Run

1. Install the chosen provider if the check found it missing, after the person agrees:
   - **Cloudflare**: on macOS `brew install cloudflared`; on Linux, from Cloudflare's official package repository for their distribution.
   - **Tailscale**: the person installs the Tailscale app from Tailscale's official distribution on this machine and on their phone, and signs in themselves. Signing in is theirs to do.
2. If `commandmate status` showed the server running, stop it first, so `remote` can start it again with authentication: `commandmate stop`.
3. Publish and pair:

```bash
commandmate remote --provider tailscale
# or, only after the person agreed to a public URL:
commandmate remote --provider cloudflare --yes
```

`remote` starts the server itself, publishes it, and prints the QR code. Show the person the QR code and tell them to scan it with the phone's camera. If the output is too narrow for a QR code, it prints a URL instead: that URL contains the pairing code, so give it only to the person and do not save it to a file or a log.

If the QR code cannot be read, or scanning it does not get the person in, have them copy the pairing URL and paste it into the address bar of the phone's browser. Pasting the link into the address bar is the way that worked in the hands-on check; do not save the link to a file.

### Ask the person first

- Which provider: Tailscale or Cloudflare.
- Installing that provider.
- Running `commandmate remote` at all: it opens a way in from outside this machine.
- Pairing now or after Stage 5, and, if now, whether to add `--auth remote-only`.
- `--yes`: only after they agreed to the public Cloudflare URL. Never add `--yes` to get past a question they have not answered.

### Confirm it worked

- The person says the phone opened CommandMate.
- `commandmate remote status` shows `Pairing: consumed`.

To close the way in later: `commandmate remote stop`. The server keeps running.

### If it fails

- Exit 1, "no provider is usable": read the reason it prints. For Tailscale it is usually "not connected" (the person has not signed in) or "no MagicDNS name". Do not switch to Cloudflare without asking: that changes who can reach the machine.
- Exit 2 without a terminal: Cloudflare needs `--yes`, or a server is running that `remote` has to restart. Ask the person, then run `commandmate stop` and try again.
- Exit 2, "a server with authentication is already running": `commandmate stop`, then `commandmate remote` again.
- The code expired or was already used: run `commandmate remote stop`, then `commandmate remote` again for a new QR code. `--pairing-expires 30m` gives a slower person more time.
- After pairing, the browser on this machine asks for a login and the CLI stops answering: that is the default `--auth all`. Do not look for a way to give the token to the CLI. Ask the person to choose: run `commandmate remote stop` and finish Stages 3 to 5 on this machine first, or pair again with `--auth remote-only` (every process on this machine can then operate CommandMate without logging in).

## Stage 3: Add a second agent

Goal: a second agent CLI, for example Command Code or Codex, can work in one of the person's repositories through CommandMate.

Before Stages 3 to 5: CommandMate needs at least one of the person's repositories registered. The CLI cannot register one; the person does it in the browser, under **Repositories → Add Repository**.

### Check

```bash
claude --version
codex --version
commandcode --version          # Command Code
commandmate ls                 # the worktrees CommandMate knows about
```

If `commandmate ls` lists nothing, the person has not registered a repository yet. CommandMate only manages repositories under `~/repos` (the `CM_ROOT_DIR` that `init` set). Ask the person to open **Repositories → Add Repository** in the browser and add one, or to tell you where their repository is so you can check whether it is under that directory. Then run `commandmate sync` and `commandmate ls` again.

### Run

Install the CLI the person picked, after they agree:

```bash
npm install -g command-code    # Command Code; CommandMate runs it as `commandcode`
npm install -g @openai/codex   # Codex
```

Signing in to the CLI is the person's: ask them to run `commandcode` (or `codex`) once in their own terminal and finish its sign-in. Then add it to a worktree and give it a first, small message:

```bash
commandmate instances <worktree-id> add --agent command-code
commandmate instances <worktree-id>
commandmate send <worktree-id> "Read the README and summarize this repository in three lines." --instance command-code
commandmate wait <worktree-id> --instance command-code --timeout 600
commandmate reply <worktree-id> --instance command-code
```

For Codex, use `--agent codex` and `--instance codex`.

The first time Codex starts in a worktree it shows two confirmation screens. Show them to the person with `commandmate capture <worktree-id> --instance codex`; do not answer them yourself.

- `Trust this folder?`: whether Codex may work in this folder.
- `Hooks need review (5 hooks are new or changed)`: these hooks are not from the repository. CommandMate wrote them into `~/.codex/hooks.json` itself, marked with `# commandmate:agent-hooks`, and they only send Codex's events to CommandMate on localhost. Check this with `grep -n 'commandmate:agent-hooks' ~/.codex/hooks.json` before you say where they came from. If the person does not trust them, Codex still works, but CommandMate cannot receive Codex's state as events, so `wait` and the status shown in the browser are less accurate.

### Ask the person first

- Which CLI to add, and installing it.
- The sign-in, which they do themselves.
- Do not turn on Auto Yes (`--auto-yes`, `commandmate auto-yes --enable`) to get past the CLI's own confirmations. If it stops on a question, show the person with `commandmate capture <worktree-id> --instance command-code` and let them answer.

### Confirm it worked

- `commandmate instances <worktree-id>` lists the new instance.
- `commandmate reply <worktree-id> --instance command-code` prints its answer.

### If it fails

- "is not installed or not in PATH": the message names the install command. Run `commandcode --version` to check, and ask before installing.
- `wait` exits 10: the agent is waiting on a question (often its own sign-in or a permission). Show the person `commandmate capture <worktree-id> --instance command-code`.
- `wait` exits 124: it timed out. Check `commandmate capture` before waiting again.
- "Worktree ID not found": run `commandmate sync`, then `commandmate ls`, and copy the ID exactly.

## Stage 4: Give your team a PM

Goal: one session plans the work and hands tasks to the others. That session is the lead (the "PM"). Skills from CommandMate's official Catalog teach it the method.

### Check

```bash
commandmate skill list                                         # what the Catalog offers
commandmate skill info cmate-orchestrate                       # versions, risk, compatibility
commandmate skill status cmate-orchestrate --worktree <worktree-id>
```

### Run

Pick the exact version from `skill info`, show the person the plan, and install after they agree:

```bash
commandmate skill install cmate-orchestrate --worktree <worktree-id> --version <version> --dry-run
commandmate skill install cmate-orchestrate --worktree <worktree-id> --version <version> --yes --ack-risk cmate-orchestrate@<version>
```

`cmate-orchestrate` is a high-risk Skill: it needs `--ack-risk <skill-id>@<version>` in addition to `--yes`. A Skill that is not high-risk needs only `--yes`. The Skill lands in `.agents/skills/` and `.claude/skills/` of that worktree.

An agent reads its Skills when its session starts, so the lead session has to start again. Ask the person whether to restart it from the worktree screen; if they prefer the CLI, `commandmate instances <worktree-id> kill <instance-id>` stops it and the next `commandmate send` starts it again.

Then ask the lead in plain words. For example, sent to the lead session (in Claude Code the Skill is also available as `/cmate-orchestrate`):

```bash
commandmate send <worktree-id> "Use the cmate-orchestrate skill to plan issues #12 and #13. Show me the plan; do not run anything that changes the repository yet." --instance claude
```

The plan step changes nothing. Steps that change something run only when the person approves them.

Command Code's plan mode (Command Code only; this workaround can be removed once #3125 is fixed): if the lead enters plan mode, it stops on a REVIEW screen and CommandMate cannot send a comment to it from the CLI. When you only want a plan, ask in plain words as above and do not have the lead enter plan mode.

### Ask the person first

- Installing each Skill, after showing the `--dry-run` plan. Say plainly that `cmate-orchestrate` is marked high-risk and what `--ack-risk` acknowledges.
- Restarting the lead session.
- Every approval the lead asks for, and every merge. You never approve or merge on the person's behalf.

### Confirm it worked

- `commandmate skill status cmate-orchestrate --worktree <worktree-id>` reports it as installed.
- The lead's reply (`commandmate reply <worktree-id> --instance claude`) shows a plan.

### If it fails

- `skill install` exits 2: `--version` is missing or does not exist. Copy it from `skill info`.
- Exit 12: the install was not confirmed: no `--yes`, or a high-risk Skill without `--ack-risk`. Ask again rather than adding flags on your own.
- Exit 11: the worktree has local changes in the way. Show the person `git status` in that worktree.
- Exit 1: the server or the Catalog could not be reached. Check `commandmate status`.
- The agent does not know the Skill: its session started before the install. Restart it.

## Stage 5: Let checks decide what's done

Goal: "done" means the repository's own checks passed, not that an agent said so.

### Check

```bash
ls .commandmate/verify.yaml                    # in the repository: are gates declared?
commandmate skill status cmate-verify --worktree <worktree-id>
```

### Run

1. Declare the gates. Either install the `cmate-verify` Skill (as in Stage 4, after the person agrees) and ask the lead to write `.commandmate/verify.yaml` with it, or draft it from the repository's CI definitions:

```bash
commandmate verify init --cwd <repository-path> --dry-run   # print the draft, write nothing
commandmate verify init --cwd <repository-path>             # write it (never overwrites)
```

Show the person the gates (lint, type check, tests and so on) and change them only with their agreement.

Before handing over a task that commits, check that git knows who is committing: `git config user.name` and `git config user.email` in the repository (a worker's commit fails when they are empty). If they are empty, ask the person for their name and email, and set them only with their answer. Do not let a worker invent a bot name. The person may also choose to have the worker leave the changes uncommitted.

2. Run the gates once on the worktree as it is:

```bash
commandmate verify <worktree-id>
```

3. Hand a task over under a contract, and let the gates judge it. A contract is a YAML file in the repository, `.commandmate/tasks/<name>.yaml`, that states the goal, the files the agent may change, and the checks that decide when it is done:

```yaml
version: 1
title: "Issue #12: <one-line summary>"
goal: |
  Implement issue #12. Commit when the work is done.
scope:
  allow:
    - "src/**"
    - "tests/**"
verify:
  gates: [lint, unit]        # gate ids from .commandmate/verify.yaml
success:
  requireWorkEvidence: true
  requireScopeClean: true
```

```bash
commandmate send <worktree-id> --contract .commandmate/tasks/issue-12.yaml --instance command-code
commandmate wait <worktree-id> --instance command-code --verify
```

`wait --verify` exits **0** when every gate passed, **20** when a gate failed, and **21** when there is no work to judge (no commits and no changes).

### Ask the person first

- Installing `cmate-verify`, and writing `.commandmate/verify.yaml` into their repository.
- Which gates to declare, and any later change to them.
- Merging the result. A passed gate means the checks passed; whether to merge is still the person's decision.

### Confirm it worked

- `commandmate verify <worktree-id>` ends with exit 0, or with a gate failure the person recognizes as real.
- `commandmate verify history` lists the run.

### If it fails

- `verify` exits 21 right away: the worktree has no work yet. That is expected before a task.
- Exit 20: a gate failed. `commandmate verify show <run-id>` shows which one and the end of its log. Report it; do not weaken the gate to make it pass.
- The contract is rejected (exit 2): it prints every problem, for example a gate id that is not in `verify.yaml`. Fix the contract, not the gates.

## Where to read more

- CommandMate on GitHub: https://github.com/Kewton/CommandMate
- CLI operations guide, every flag and exit code: https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/cli-operations-guide.md
- The project site: https://kewton.github.io/CommandMate/
