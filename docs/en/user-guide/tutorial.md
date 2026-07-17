[日本語版](../../user-guide/tutorial.md)

# Tutorial

Use a sample repository with two bugs left in on purpose to work through the core of CommandMate in about ten minutes.

- Sample repository: [Kewton/commandmate-tutorial](https://github.com/Kewton/commandmate-tutorial)
- It has zero dependencies. There is no `npm install` step — `npm test` and `npm start` work on their own

This document follows the four steps in the sample repository's README, and adds the **CommandMate screen operations** around them.

---

## Prerequisites

- CommandMate is running (if not: `npx commandmate@latest`)
- Node.js 22 or later
- One agent CLI: Claude Code, Codex, or Antigravity

---

## What you will use

| Step | CommandMate feature |
|------|---------------------|
| 1 | Clone a repository into the managed root |
| 2 | Run an agent CLI in a session, from any browser |
| 3 | External Apps — proxy your dev server through CommandMate |
| 4 | One session per worktree, running in parallel |

---

## Step 1: Clone the repository

You can clone straight from the CommandMate UI.

1. Open the **Repositories** screen
2. Click **Add Repository**
3. Choose the **Clone URL** tab
4. Paste this URL and click **Clone**

```
https://github.com/Kewton/commandmate-tutorial.git
```

It lands inside CommandMate's managed root (`CM_ROOT_DIR`) and shows up in the list as a session.

> **Note**: CommandMate refuses to register paths outside the managed root. The worktree you create in Step 4 has to live under that root too.

---

## Step 2: Let an agent fix a failing test

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

---

## Step 3: See the change in the browser

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

3. Turn on **App is enabled** and save

It is now reachable at `/proxy/tutorial/`. No separate tab on a raw port, and the same URL works from your phone.

The heading on the page comes from the `greet()` you fixed in Step 2:

- Before: `Hello, CommandMate`
- After: `Hello, CommandMate!`

That is the loop: **an agent changes code → you see the result.**

> **Security**: proxied apps run under the CommandMate origin and can access CommandMate APIs. Only register applications you trust.

---

## Step 4: Go parallel with a worktree

CommandMate runs **one session per git worktree**, side by side. It does not *create* worktrees, though — it *discovers* existing ones and registers them. So have your agent create it.

### Claude Code / Codex

A `worktree-new` skill ships with the sample repository:

```
/worktree-new fix/shout
```

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
