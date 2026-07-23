[日本語版](../../user-guide/tutorial.md)

# Tutorial

Use a sample repository with two bugs left in on purpose to work through the core of CommandMate in about fifteen minutes. You **fork the sample repository before you start**, so nothing you do can touch the original repository (upstream).

- Sample repository: [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)
- It has zero dependencies. There is no `npm install` step — `npm test` and `npm start` work on their own

This document follows the flow in the sample repository's README, and adds the **CommandMate screen operations** around it (registering your forked repository, installing a Skill, External Apps, and parallel worktrees).

---

## Prerequisites

- CommandMate is running (if not: `npx commandmate@latest`)
- Node.js 22 or later
- One agent CLI: Claude Code, Codex, or Antigravity
- A GitHub account (you use it to fork the sample repository)

---

## What you will use

| Step | CommandMate feature |
|------|---------------------|
| 1 | Fork and clone the sample repository into the managed root |
| 1.5 | Install a Skill from the Catalog in the UI → restart the session → use it |
| 2 | External Apps — proxy your dev server through CommandMate |
| 3 | Run an agent CLI in a session, from any browser |
| 4 | One session per worktree, running in parallel |

---

## Step 1: Fork and clone the sample repository

First **fork** the repository on GitHub, then clone your fork into CommandMate. You go through a fork so that the clone's origin points at **your own fork**. That way, even if you push by accident later, the change only lands in your fork and never touches the original sample repository (upstream).

### 1-1. Fork it on GitHub

1. Open [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)
2. Click **Fork** at the top right to create a fork under your account

Your fork's URL is `https://github.com/<you>/commandmate-tutorial.git`.

### 1-2. Clone your fork from the CommandMate UI

You can clone straight from the CommandMate UI.

1. Open the **Repositories** screen
2. Click **Add Repository**
3. Choose the **Clone URL** tab
4. Paste **your fork's URL** and click **Clone**

```
https://github.com/<you>/commandmate-tutorial.git
```

It lands inside CommandMate's managed root (`CM_ROOT_DIR`) and shows up in the list as a session. Origin is the fork URL you pasted, so everything from here on acts against your own fork.

> **Note**: CommandMate refuses to register paths outside the managed root. The worktree you create in Step 4 has to live under that root too.

> **Advanced (optional)**: This tutorial never pushes or opens a PR — it stays entirely local — so you do not need to track upstream. If you later want to pull updates from the original repository, add it in a terminal with `git remote add upstream https://github.com/Kewton/commandmate-tutorial.git`.

---

## Step 1.5: Install a Skill and use it

CommandMate can install **Agent Skills** from the official Catalog, one worktree at a time. Here you install a **read-only Skill that does not modify the repository**, walking the whole loop — **browse the Catalog → install it in the UI → restart the session → use it** — with a safe subject.

### 1.5-1. Open the Skills pane

Open the session (the worktree detail screen) for the repository you cloned.

- **Desktop**: open **Skills** (the ✨ icon) in the Activity Bar
- **Mobile**: open the **Tools** tab → **Skills**

The same Skills pane appears, with "Installed in this worktree" on top and "Install from the Catalog" below.

### 1.5-2. Install the read-only Skill

1. From "Install from the Catalog", pick **`cmate-repository-analysis`** (a read-only Skill that only analyzes the repository; its risk badge reads **low**)
2. On the detail screen, click **Build install plan**. Nothing is written yet — it just previews what installing would write (under `.agents/skills/cmate-repository-analysis/`)
3. Review it and click **Install into this worktree**

Once it finishes, the pane says "Restart the agent sessions listed below to start using it."

### 1.5-3. Restart the session and use it

Agents read a worktree's Skills **at startup**. Installing alone is not enough, so **restart this repository's session**. After the restart, ask the session the following and it will use the Skill you installed:

> Analyze this repository.

> **Important notes**
> - **A session restart is required after installing** (agents only read Skills at startup).
> - **You cannot reinstall or update into the same destination** (it is one-shot). To change versions, uninstall first and then install again.
> - Do **not** use **high-risk Skills** such as `cmate-worktree-cleanup` or `cmate-orchestrate` in your first tutorial.
> - For the details and constraints of the Skills feature, see [Agent Skills Distribution](../../user-guide/skills.md).

---

## Step 2: Run it and watch it in the browser

Start the app:

```bash
npm start
```

It listens on **port 4173**. Register it so CommandMate can serve it for you.

1. Open External Apps on the **More** screen
2. Add an app with these values:

| Field | Value |
|-------|-------|
| Display Name | `Tutorial` |
| Identifier Name | `tutorial` |
| Path Prefix | `tutorial` |
| Port Number | `4173` |
| App Type | `Other` |

3. Turn **Enable app** on and save

It becomes available at `/proxy/tutorial/`. No separate tab on a raw port, and the same URL works from your phone.

The heading is missing its exclamation mark:

> # Hello, CommandMate

That is bug number one, and **you can see it**. Leave the page open.

> **Security**: A proxied app runs on the same origin as CommandMate and can reach CommandMate's API. Only register apps you trust.

---

## Step 3: Let an agent fix it, then restart

Two tests in this repository **fail on purpose**.

```bash
npm test
```

```
✖ greet ends with an exclamation mark
    actual:   'Hello, World'
    expected: 'Hello, World!'
✖ shout uppercases the greeting
    Error: shout() is not implemented yet
```

Open the session and ask your agent:

> `npm test` fails. Fix the first failure only, then run the tests again.

The fix is one character in `src/greet.js`. The point is not the difficulty — it is **watching the agent run the tests, change the code, and re-run them from your browser (or your phone)**.

Leave the second failure (`shout()` is not implemented) alone for now: Step 4 uses it.

### The page only changes after a restart

Fixing the code is not enough: reloading the page you opened in Step 2 still shows **the same heading**. Restart the app (`Ctrl+C`, then `npm start` again).

Restart, reload, and the heading changes:

> # Hello, CommandMate!

That is the loop: **an agent changes code → you restart → you see the result.**

> **Why the restart?** `src/server.js` imports `greet` once, when the process starts, so a running server keeps serving the code it booted with no matter what is on disk. This is not a quirk of the tutorial — it is the same reason a real dev server needs restarting when you change code it loaded at boot.

---

## Step 4: Go parallel with a worktree

CommandMate runs **one session per git worktree**, side by side. It does not *create* worktrees, though — it *discovers* existing ones and registers them. So have your agent create it.

### Claude Code / Codex

A `worktree-new` skill ships with the sample repository:

```
/worktree-new fix/shout
```

> **Advanced (optional)**: Instead of the bundled `worktree-new`, you can install the official **`cmate-worktree-setup`** from the Catalog (its risk badge reads **moderate**) the same way as in Step 1.5 and use it to create the worktree. Note that it needs a session restart after installing, and its behavior differs slightly from the bundled skill.

### Antigravity

The `worktree-new` skill is verified on Claude Code (`.claude/skills/`) and Codex (`.agents/skills/`), but is **unverified on Antigravity**. Paste this instead:

> Create a git worktree for a new branch `fix/shout`.
> Put it next to this repository, as a sibling directory named
> `commandmate-tutorial-fix-shout`, using
> `git worktree add -b fix/shout ../commandmate-tutorial-fix-shout`.
> Stop if that directory already exists. Print the path you created.
> Do not use `--force`.

### Let CommandMate pick it up

1. Open the **Repositories** screen
2. Click **Sync All**

The new worktree appears as a second session. Ask *that* session to implement `shout()` — the second failing test you left alone — while the first session stays where it is.

**Two branches, two agents, one browser.**

---

## Notes

- The worktree must live **inside CommandMate's managed root**. A sibling of this repository is inside it
- Antigravity's non-interactive mode (`agy --print`) **times out silently** on a trust dialog the first time it runs in a new project. Answer it once in interactive mode, or pass `--dangerously-skip-permissions` if you understand what it skips

---

## Cleaning up

```bash
git worktree remove ../commandmate-tutorial-fix-shout
```

Then remove the repository from the **Repositories** screen, and remove `tutorial` from External Apps on the **More** screen.

---

## Next steps

- [Quick Start Guide](./quick-start.md) - A development flow using slash commands and agents
- [CLI Setup Guide](./cli-setup-guide.md) - Installation and configuration details
- [Workflow Examples](./workflow-examples.md) - Practical usage examples
