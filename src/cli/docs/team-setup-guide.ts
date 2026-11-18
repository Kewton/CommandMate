/**
 * Team setup guide for agents (Issue #4464)
 *
 * The page the README's one-block prompt points an agent at:
 * https://kewton.github.io/CommandMate/team-setup.md. `website/` is not in the
 * npm package, so the same text is carried here as a string constant and served
 * by `commandmate docs --section team-setup`.
 *
 * Do not edit this constant by hand: edit `website/team-setup.md` and copy it
 * here. `tests/unit/cli/commands/docs-team-setup-4464.test.ts` fails when the
 * two differ by a single byte.
 */

export const TEAM_SETUP_GUIDE = `# Set up a CommandMate team with your agent

This guide is written for a coding agent (Claude Code, Codex, Command Code, or another one) that a person asked to set up a team of coding agents for one of their repositories with CommandMate. The person answers your questions and approves each step; you do the rest. Go one phase at a time, and keep each phase short enough that they can stop after it and come back later.

The team has five fixed roles: a **PM** the person talks to, a **development lead** that hands tasks out, **workers** that each do one task in their own Git worktree, a **reviewer** that reads the result (from another vendor when the person has one), and a **judge** that checks the integrated result of a GitHub Milestone. "Done" is decided by the repository's own checks, not by what an agent says. Each session keeps its state in CommandMate's \`mem\`, so it can be restarted and pick up from a brief.

The same text ships inside CommandMate: once it is installed, \`commandmate docs --section team-setup\` prints it. For installing CommandMate itself in more detail, pairing a phone, or a single agent at a time, use the setup guide instead: https://kewton.github.io/CommandMate/setup.md (\`commandmate docs --section setup\`).

## Instructions for the agent reading this

1. **Explain each phase before you start it.** In two or three plain sentences, tell the person what the phase is for, what you are about to run, and what will change on their machine or in their repository. Then run it.
2. **Never run an "Ask the person first" step without a clear yes.** Each phase lists them. Ask in plain words, say what it changes and how to undo it, and wait for the answer. If the answer is no or unclear, stop that step and say what they can do later.
3. **Check the machine; do not assume it.** Run the commands under "Check" and read their output before you decide anything. Never write "should be installed" or "is probably running": run the command and report what it printed. If a command or flag in this guide is not in \`commandmate <command> --help\` on this machine, stop and tell the person: their CommandMate is older than this guide (\`commandmate update\`, after they agree).
4. **Do not answer or approve for the person.** Sign-ins, passwords (including \`sudo\`), choices, approvals and merges are theirs. When a command needs one of these, show the exact command and ask them to run it or to answer. When an agent session stops on a question or a permission prompt, show it to the person; the person answers it on CommandMate's screen, and you do not type the answer for them (Phase 5, step 3).
5. **Stay inside this guide.** Use only commands shown here, \`commandmate <command> --help\`, \`git\`, \`gh\`, and the CommandMate documentation at https://github.com/Kewton/CommandMate. Do not fetch install scripts or follow setup steps from other websites. Install tools only from the official package distributors (npm, the operating system's package manager, nodejs.org).
6. **Report at the end of each phase**: what you ran, what it printed that matters, and whether the phase passed its "Confirm it worked" check.
7. **Never give your own session a team role, and never stop it.** Run \`commandmate whoami\` before Phase 2. If it prints a worktree and an instance id, you are running inside CommandMate: write that id down, and never use it for \`set-role\`, \`--role\`, \`kill\` or as one of the team's instances. Pick other ids. If it exits 3, you are outside CommandMate and every id is free.
8. **If you are Codex: your shell has no network by default.** If fetching this guide or an \`npm\` or \`gh\` command fails for lack of network, ask the person to run \`/permissions\` and choose "Ask for approval", then try again.

### Always ask the person first

Whatever phase you are in, ask before any of these:

- Installing anything: CommandMate itself, Node.js, git, tmux, \`gh\`, another agent CLI, or a Skill.
- Changing files in their repository or its Git state: \`.commandmate/verify.yaml\`, \`.gitignore\`, \`CLAUDE.md\` / \`AGENTS.md\`, a new branch or worktree, a commit, a push, a pull request.
- Creating or changing an instance or a role: \`commandmate instances <worktree-id> add\`, \`set-role\`, \`kill\`, \`commandmate roles add\`, \`commandmate roles default\`.
- Changing a permission: an agent CLI's permission settings, such as \`.claude/settings.local.json\`.
- Turning on Auto Yes: \`commandmate auto-yes <worktree-id> --enable\`, or \`commandmate send ... --auto-yes\`. This guide never needs it.
- Running \`commandmate sync\`: it affects every repository registered on the server, not only theirs (Phase 2, step 6).
- Merging a pull request.
- Using \`gh\` on a GitHub repository, and creating a GitHub Milestone or moving an issue into one. The person names the GitHub host and \`<owner>/<repo>\` (Phase 5, step 1).

**A yes covers what the person was shown, and nothing more.** Each approval is tied to its target: one prompt, one repository, one CommandMate server, one set of files, one GitHub repository. Do not read it as covering anything wider. When the target can change between their yes and your command (a prompt on a session's screen is the usual case), the person acts on it themselves, on the screen. If you notice that the target changed after they said yes, do not go ahead: show them what changed and ask again.

**Approving a mem decision is never yours.** A decision recorded in \`mem\` is written to its Issue, pull request or document only when a person approves it on CommandMate's screen. The CLI has no way to approve it, and you never look for one. The same goes for the \`mem\` mode: only the person changes it, on the screen.

### Antigravity (agy)

Section 6 of the Google Antigravity Additional Terms of Service (https://antigravity.google/terms) and the official FAQ (https://antigravity.google/docs/faq) restrict using Antigravity through third-party software or coding agents on consumer plans. A breach can lead to account suspension. So in this team:

- No AI agent sends, asks, responds or relays to agy (\`commandmate send\`, \`ask\`, \`respond\`, \`--reply-to\`). That includes you.
- Never turn on Auto Yes for agy.
- Antigravity is never given a role that an AI agent drives: not PM, development lead, worker, reviewer or judge. It does not appear in the team table below.
- Do not run \`agy\` yourself, not even \`agy --version\`. Ask the person whether they have it instead.

If the person uses Antigravity, they type into it themselves. CommandMate refuses a send to agy from an agent with exit 33 unless the server declares an API-key or enterprise use; do not try to get around that refusal. This is not legal advice.

## Phase 1: Environment, your agent CLIs and a team that fits them

Goal: CommandMate is installed and running, the person's repository is registered, and the person has agreed to a team table built from the agent CLIs they already have.

### Check

\`\`\`bash
uname -s                       # Darwin = macOS, Linux = Linux or WSL2
node -v                        # needs v22 or newer
git --version
tmux -V
gh --version                   # GitHub CLI, for issues and milestones
gh auth status                 # is gh signed in?
command -v commandmate && commandmate --version
claude --version               # Claude Code
codex --version                # Codex
commandcode --version          # Command Code
\`\`\`

If \`commandmate\` is installed, also run:

\`\`\`bash
commandmate status             # is the server running, and at which URL?
commandmate ls                 # the worktrees CommandMate knows about
commandmate whoami             # exit 3: you are outside CommandMate; otherwise, your own instance
\`\`\`

### Run

1. **Install and start CommandMate** if the check found it missing, after the person agrees. Node.js, git and tmux come first; if one is missing or too old, follow Stage 1 of https://kewton.github.io/CommandMate/setup.md for it. Then:

\`\`\`bash
npm install -g commandmate
commandmate init --defaults
commandmate start --daemon
commandmate status
\`\`\`

If \`~/.commandmate/.env\` already exists, \`commandmate init --defaults\` stops with ".env file already exists": CommandMate is already configured, so skip \`init\`. Do not add \`--force\`.

2. **Register the repository.** Ask the person which repository the team works on and where it is. Run \`commandmate ls\`. If it is not listed, the person registers it: the CLI cannot. Ask them to open CommandMate's screen, go to **Repositories → Add Repository**, and add it. The screen accepts repositories under the directory \`init\` set (\`CM_ROOT_DIR\`, by default \`~/repos\`); if theirs is elsewhere, tell them so, and let them choose whether to move or clone it under that directory. Adding it on the screen lists its worktrees; run \`commandmate ls\` again. Write down the worktree id of the repository's main checkout; this guide calls it \`<base-worktree-id>\`, its path \`<repository-path>\`, and its branch \`<base-branch>\`.

3. **Propose a team.** Build the table from the CLIs the check found, and show it to the person. Every row uses the same five roles and the same checks; only who plays each role changes.

| The person has | PM | Development lead | Worker | Reviewer | Judge |
|---|---|---|---|---|---|
| Claude Code, Codex and Command Code | Claude Code | Claude Code | Command Code | Codex | Claude Code |
| Claude Code and Codex | Claude Code | Claude Code | Codex | Claude Code (a session that did not do the work) | Claude Code |
| Claude Code and Command Code | Claude Code | Claude Code | Command Code | Claude Code (a session that did not do the work) | Claude Code |
| Command Code and Codex | Command Code | Command Code | Command Code | Codex | Command Code |
| Claude Code only | Claude Code | Claude Code | Claude Code | Claude Code (a session that did not do the work) | Claude Code |
| Command Code only | Command Code | Command Code | Command Code | Command Code (a session that did not do the work) | Command Code |

- The reviewer is never the session that did the work. When the person has a second vendor, the reviewer comes from the other vendor than the worker; with one vendor, say plainly that the review is by the same vendor in a fresh session, which is weaker. The checks in Phase 3 are the same in every row.
- The PM and development lead have been tried in recorded runs on Claude Code and on Command Code. A team led from Codex alone has not been: if Codex is all the person has, tell them so and ask whether to go on with Codex as PM and development lead.
- Antigravity is not in this table (see "Antigravity (agy)" above).
- The PM, the development lead, the reviewer and the judge are instances in \`<base-worktree-id>\`, never your own instance (instruction 7). Each worker runs in its own worktree, one per issue (Phase 2 and Phase 5).

### Ask the person first

- Installing CommandMate and anything it needs, each with its exact command.
- Which repository, and adding it on the screen (Repositories → Add Repository) if \`commandmate ls\` does not list it.
- Which row of the table to use, or a change to it.
- If \`gh\` is missing or not signed in: installing it, and signing in, which is theirs (\`gh auth login\` in their own terminal). They may also skip it: then, in Phase 5, ask them for the milestone's issue numbers, titles and acceptance criteria, and the team works from their answer.

### Confirm it worked

- \`commandmate status\` reports the server as running.
- \`commandmate ls\` lists the repository, and you have written down \`<base-worktree-id>\`.
- The person agreed to one team table, and you have written down which CLI plays each role.

### If it fails

- \`commandmate: command not found\` after \`npm install -g\`: npm's global bin directory is not on \`PATH\`. Run \`npm prefix -g\` and show the person; the fix is in https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/cli-setup-guide.md#command-not-found-error.
- \`EACCES\` during \`npm install -g\`: do not retry with \`sudo\`. Show the person the "Permission Error (EACCES)" section of the same setup guide.
- The port is already in use: \`commandmate start --daemon --port 3001\`, then \`commandmate status\`.
- \`commandmate ls\` does not list the repository: it has not been added on the screen yet. Ask the person to add it under **Repositories → Add Repository**, then run \`commandmate ls\` again.
- The screen refuses the path: it is outside \`CM_ROOT_DIR\`. Tell the person; moving or cloning the repository under that directory is their choice.
- "Worktree ID not found": run \`commandmate ls\` and copy the ID exactly. If the worktree is really missing from the list, see "Before every \`commandmate sync\`" in Phase 2, step 6.

## Phase 2: Five fixed roles and isolated worktrees

Goal: each of the five roles is a CommandMate role, each team session is an instance that holds its role from the moment it starts, and the person knows how a worker gets its own worktree.

A role is text CommandMate gives the session when it starts. It is an instruction to the model, not a permission: it limits nothing. What a session may run is set by its CLI's permission settings and by the person's approvals. The task contract's scope (Phase 3) does not limit it either: the scope is checked after the work, against what changed.

### Check

\`\`\`bash
commandmate whoami             # your own instance, if you run inside CommandMate (instruction 7)
commandmate roles list
commandmate roles defaults --repo <repository-path>
commandmate instances <base-worktree-id>
\`\`\`

### Run

1. **Define the five roles**, after showing the person the text. Change the wording with them if they want; keep each one short:

\`\`\`bash
commandmate roles add pm --stdin <<'EOF'
You are the PM. You talk to the person and to the development lead only. You do not write code or edit the repository. Turn the person's request into a brief for the development lead, follow progress, and report to the person. Approvals, merges and mem decisions are the person's.
EOF
commandmate roles add dev-lead --stdin <<'EOF'
You are the development lead. You take briefs from the PM and never ask the person directly. Hand each task to one worker under a task contract, wait for the checks, ask the reviewer to read the result, and report to the PM. Never weaken a check to make it pass.
EOF
commandmate roles add worker --stdin <<'EOF'
You are a worker. Do the one task in your contract. Change only the files the contract says the person approved, and commit only if it says the person approved that; the scope is checked after your work, so keeping inside it is on you. If the task needs a file outside the scope, or the contract does not say you may commit, do not do it: say so and stop.
EOF
commandmate roles add reviewer --stdin <<'EOF'
You are the reviewer. You read; you do not change files. Review the diff you are given against the issue and answer APPROVE or REJECT, with the reasons and the lines they are about.
EOF
commandmate roles add judge --stdin <<'EOF'
You are the judge. When the PM asks, check the integrated result of a milestone against each issue's acceptance criteria on the base branch, and report GO or NO-GO per issue with what you ran. You do not change files.
EOF
\`\`\`

2. **Give each team session its role.** First read \`commandmate instances <base-worktree-id>\`: the worktree lists the agent CLIs chosen for it (by default \`claude\`, \`codex\` and \`antigravity\`). A CLI id such as \`command-code\` can be used even when it is not listed. An id it lists gets its role with \`set-role\`; a new one is created with \`add --id\`, so you know its id. Never use your own instance (instruction 7). For the first row of the table:

\`\`\`bash
commandmate instances <base-worktree-id>
commandmate instances <base-worktree-id> add --agent claude --id claude-2 --role pm
commandmate instances <base-worktree-id> add --agent claude --id claude-3 --role dev-lead
commandmate instances <base-worktree-id> add --agent claude --id claude-4 --role judge
commandmate instances <base-worktree-id> set-role codex --role reviewer
commandmate instances <base-worktree-id>
\`\`\`

With Claude Code only, the reviewer is one more Claude Code instance: \`commandmate instances <base-worktree-id> add --agent claude --id claude-5 --role reviewer\`. For Command Code, use \`--agent command-code --id command-code-2\` and so on (\`instances --help\` does not list \`command-code\` among the \`--agent\` values, but \`add\` accepts it, as \`send --help\` lists). If an id is taken, pick the next number. Write the ids into the team table: this guide calls them \`<pm-instance>\`, \`<lead-instance>\`, \`<reviewer-instance>\` and \`<judge-instance>\`.

3. **Make every new worker start as a worker.** Workers run in worktrees made later, so set the role as the repository's default for the worker's CLI:

\`\`\`bash
commandmate roles default command-code --repo <repository-path> --role worker
\`\`\`

Use the worker's tool from the table (\`claude\`, \`codex\` or \`command-code\`). An instance that was given a role in step 2 keeps it; the default only applies to instances that have none.

4. **Send to a role, not just to an instance.** From now on, a send to a team session names the role it must hold: \`commandmate send <base-worktree-id> "<message>" --instance <pm-instance> --role pm\`. If the session is running under another role, or CommandMate has no record of how it started, the send exits **32** and types nothing. A role is fixed when the process starts: stop it (\`commandmate instances <base-worktree-id> kill <instance-id>\`, after the person agrees) and send again.

5. **Permissions for the team sessions.** The PM and the development lead run \`commandmate\` commands. For Claude Code, all instances in \`<base-worktree-id>\` share that worktree's \`.claude/settings.local.json\`; show the person these rules and add them only after they agree:

\`\`\`text
Bash(commandmate send:*)
Bash(commandmate ask:*)
Bash(commandmate wait:*)
Bash(commandmate reply:*)
Bash(commandmate capture:*)
Bash(commandmate verify:*)
Bash(commandmate mem:*)
Bash(commandmate brief:*)
\`\`\`

For Codex and Command Code, show the person that CLI's own permission screen and let them choose. Do not widen a permission to get past a prompt.

Each worker worktree is a separate directory with its own permission settings (for Claude Code, its own \`.claude/settings.local.json\`). So a worker, and the development lead when it works there, will stop on permission prompts the first time it edits files or runs a check. Those prompts go to the person (Phase 5, step 3); adding rules to a worker worktree is again their choice.

6. **One worktree per issue.** A worker never shares a working copy with another session. When Phase 5 starts an issue, its worktree is made next to the repository, after the person agrees:

\`\`\`bash
git -C <repository-path> worktree add ../<repository>-issue-<n> -b feature/<n>-<short-name> <base-branch>
\`\`\`

CommandMate lists the new worktree after a sync. **Before every \`commandmate sync\`**, this one and any retry, tell the person what it does and wait for a yes: it re-reads every repository registered on the CommandMate server that \`commandmate status\` shows, not only theirs; it deletes that server's records of worktrees that no longer exist in Git, in any of those repositories, and stops the sessions running in them; and it stops the global assistant session if one is running. The person may prefer to press the sync button on the screen themselves; it does the same. After the sync:

\`\`\`bash
commandmate sync
commandmate ls
\`\`\`

The new worktree shows up in \`commandmate ls\` with its own worktree id: this guide calls it \`<worker-worktree-id>\`.

### Ask the person first

- The text of each role, and creating the five roles.
- Creating each instance, giving it a role, and the repository default for workers.
- Stopping a session with \`kill\` so it starts again with its role.
- Each permission rule, and which file it goes into.
- Each new worktree and branch.
- Each \`commandmate sync\`, after saying what it does on the whole server (step 6).

### Confirm it worked

- \`commandmate roles list\` lists \`pm\`, \`dev-lead\`, \`worker\`, \`reviewer\` and \`judge\`.
- \`commandmate instances <base-worktree-id>\` lists the PM, the development lead, the reviewer and the judge as separate instances, each with its role.
- \`commandmate roles defaults --repo <repository-path>\` shows \`worker\` for the worker's tool.
- \`commandmate send <base-worktree-id> "Run commandmate whoami and tell me your role in one line." --instance <pm-instance> --role pm\` exits 0, and \`commandmate reply <base-worktree-id> --instance <pm-instance>\` says it is the PM.
- None of the team's instance ids is your own (instruction 7).

### If it fails

- Exit 2 from \`roles\` or \`instances\`: an unknown or ambiguous role, an instance not on the roster, or a tool roles do not apply to. Read the message; \`commandmate roles list\` and \`commandmate instances <base-worktree-id>\` show what exists.
- Exit 31: the instance already exists, or the roster changed while you wrote. Read \`commandmate instances <base-worktree-id>\` again, then use \`set-role\` for an existing instance, unless it is your own (instruction 7): then pick another id.
- Exit 32 from \`send --role\`: the running session holds another role or its start is not known. Ask the person, \`kill\` it, and send again.
- Exit 33: the target is Antigravity. Stop; it has no place in this team.
- The new worktree is not in \`commandmate ls\` after \`commandmate sync\`: show the person \`git -C <repository-path> worktree list\` and the output of \`sync\`; do not make it again under another name, and do not sync again without a new yes (step 6).
- You notice that an instance you were about to use is your own: stop, pick another id, and tell the person.

## Phase 3: Done means the checks passed

Goal: the repository declares its checks in \`.commandmate/verify.yaml\`, a task is handed over under a contract, and \`wait --verify\` reports pass or fail from those checks.

### Check

\`\`\`bash
ls <repository-path>/.commandmate/verify.yaml
git -C <repository-path> config user.name
git -C <repository-path> config user.email
git -C <repository-path> check-ignore -v .commandcode/ .claude/skills/cmate-x/ .agents/skills/cmate-x/
\`\`\`

### Run

1. **Draft the gates from the repository's own scripts and CI**, show them to the person, and write them only after they agree:

\`\`\`bash
commandmate verify init --cwd <repository-path> --dry-run   # print the draft, write nothing
commandmate verify init --cwd <repository-path>             # write it (never overwrites)
\`\`\`

Show the person each gate (lint, type check, tests and so on) and change them only with their agreement.

2. **Set what the checks compare against.** The checks judge a worker's work as the difference between its worktree and a base ref. Without one, they use the remote's default branch (\`origin/HEAD\`), which does not have this setup's commits (they are not pushed), may not be \`<base-branch>\`, and may not exist at all. So, with the person's agreement, set it to the local base branch in \`.commandmate/verify.yaml\`. The draft's \`options:\` block has a commented-out \`# baseRef:\` line; replace that one line with this one, indented the same, and leave the rest of the block as it is:

\`\`\`yaml
  baseRef: <base-branch>
\`\`\`

A local branch works from every worktree of the repository, because worktrees share their branches.

3. **Keep generated files out of the checks.** Without these lines, the contract's scope check fails every task because files the tools write appear as changes. Add them to the repository's \`.gitignore\` after the person agrees, only the ones for the CLIs they use:

\`\`\`text
/.commandmate/*
!/.commandmate/verify.yaml
/.commandcode/
/.claude/settings.local.json
/.claude/skills/cmate-*/
/.agents/skills/cmate-*/
\`\`\`

4. **Run the checks once, before committing:**

\`\`\`bash
commandmate verify <base-worktree-id>
\`\`\`

At this point the new \`verify.yaml\` and \`.gitignore\` are uncommitted changes, so they count as work and every gate runs: expect exit 0, or a failure the person recognizes as real. (After the commit in the next step, the same command exits 21: nothing differs from \`<base-branch>\` any more. That is expected.)

5. **Commit only \`.commandmate/verify.yaml\` and \`.gitignore\` to \`<base-branch>\`**, after the person agrees, so every worktree made from it has the same checks. Pushing is not needed. If \`git config user.name\` or \`user.email\` is empty, ask the person for their name and email and set them only with their answer; do not invent a bot name.

6. **A task contract.** The development lead writes one per task in the worker's worktree, as \`.commandmate/tasks/issue-<n>.yaml\`. It states the goal, the files the worker may change, whether it may commit, and the checks that decide when it is done. The files and the commit come from the person: the PM asks them before the issue starts (Phase 5, step 1) and passes their answer down in the brief. If the brief does not say, the development lead stops and asks up through the PM instead of writing the contract.

The scope is a check made after the work, against what changed in Git. It does not stop a session from editing a file outside it: by the time the check fails, the edit has been made. So a worker keeps inside it from its instructions, and its CLI's permission prompts stay on.

In the example below, the lines in angle brackets come from the brief: copy what the person approved, not the example. The \`scope\` lines are an example for a person who approved \`src/\` and \`tests/\`. \`autoYes: mode: off\` makes sure Auto Yes never answers this task's prompts, even if someone turns it on for the worker's session; leaving it out keeps whatever is set on that session, which in this team is off.

\`\`\`yaml
version: 1
title: "Issue #<n>: <one-line summary>"
goal: |
  Implement issue #<n>. Change only the files the scope allows.
  <Commits, from the brief: "Commit when the work is done." only if the person approved commits; otherwise "Do not commit; report when the work is done.">
scope:
  allow:                     # the files the person approved, from the brief
    - "src/**"
    - "tests/**"
verify:
  gates: [lint, unit]        # gate ids from .commandmate/verify.yaml
autoYes:
  mode: off
success:
  requireWorkEvidence: true
  requireScopeClean: true
\`\`\`

The development lead hands it over and waits for the checks. \`<worker-instance>\` is the worker's CLI id from the team table (\`command-code\`, \`claude\` or \`codex\`; it works in the new worktree whether or not that worktree lists it):

\`\`\`bash
commandmate send <worker-worktree-id> --contract .commandmate/tasks/issue-<n>.yaml --instance <worker-instance>
commandmate wait <worker-worktree-id> --instance <worker-instance> --verify
\`\`\`

\`wait --verify\` exits **0** when every gate passed, **20** when a gate failed, and **21** when there is no work to judge (no commits and no changes).

### Ask the person first

- Writing \`.commandmate/verify.yaml\`, which gates it declares, its \`baseRef\`, and any later change to them.
- Editing \`.gitignore\`.
- Setting \`git config user.name\` / \`user.email\`, and the commit to \`<base-branch>\`.

### Confirm it worked

- Before the commit, \`commandmate verify <base-worktree-id>\` ended with exit 0, or with a gate failure the person recognizes as real.
- \`git -C <repository-path> log -1 --stat\` shows the commit with only \`.commandmate/verify.yaml\` and \`.gitignore\`.
- \`git -C <repository-path> check-ignore -v .claude/settings.local.json .claude/skills/cmate-x/\` prints a rule for each.
- \`commandmate verify history\` lists the run.

### If it fails

- Exit 20: a gate failed. \`commandmate verify show <run-id>\` shows which one and the end of its log. Report it; do not weaken the gate to make it pass.
- Exit 20 with "work-evidence: no base ref" or "base ref is unreachable": \`options.baseRef\` is missing or names a branch that does not exist. Check the \`options:\` block of \`verify.yaml\` and \`git -C <repository-path> rev-parse --verify <base-branch>\`, and fix \`baseRef\` with the person's agreement.
- Exit 20 from the scope check on files nobody meant to change (for example \`.claude/settings.local.json\`): the \`.gitignore\` lines from step 3 are missing or not committed to \`<base-branch>\`.
- Exit 21 right after the commit: expected (step 4).
- The contract is rejected (exit 2): it prints every problem, for example a gate id that is not in \`verify.yaml\`. Fix the contract, not the gates.
- \`verify init\` finds nothing to draft from: ask the person which commands they run to check their work, and write those as gates with their agreement.

## Phase 4: mem, the restart brief, screen-only approval, and the instructions file

Goal: each session writes what it cannot leave anywhere else into \`mem\`, a restarted session picks up from a brief, decisions wait for the person on the screen, and the repository's instructions file tells every session these rules.

### Check

\`\`\`bash
commandmate mem mode --worktree <base-worktree-id>
commandmate skill list
\`\`\`

### Run

1. **Turn \`mem\` on — the person does it, on the screen.** The mode can only be changed on CommandMate's screen: **Repositories → the repository's "mem"**, as rules for branch names. Ask the person to set it to \`on\` for \`<base-branch>\` and for the workers' branches (for example \`feature/**\`), and to turn on "Insert at start" so a restarted session gets its brief with the first message. Then confirm it:

\`\`\`bash
commandmate mem mode --worktree <base-worktree-id>   # should say on
\`\`\`

2. **Skills from the official Catalog**, if they help this team. Run \`commandmate skill list\`. For each Skill the person wants (for example \`cmate-delegate\`, for one session to ask another, or \`cmate-verify\`, for the checks), pick the version from \`commandmate skill info <skill-id>\`, show the plan, and install after they agree:

\`\`\`bash
commandmate skill install <skill-id> --worktree <base-worktree-id> --version <version> --dry-run
commandmate skill install <skill-id> --worktree <base-worktree-id> --version <version> --yes
\`\`\`

A Skill marked high-risk also needs \`--ack-risk <skill-id>@<version>\`: explain what it acknowledges and ask first. Skills are read when a session starts, so the sessions need a restart afterwards. Nothing in this guide depends on a Skill: the template below is enough on its own.

3. **Write the team rules into the instructions file** the sessions read (\`CLAUDE.md\` for Claude Code, \`AGENTS.md\` for Codex and Command Code; both if the team uses both), after the person agrees. Fill in the instance ids from the table:

\`\`\`markdown
## Team

| Role | Instance | Talks to |
|---|---|---|
| PM | \`<pm-instance>\` | the person, the development lead |
| Development lead | \`<lead-instance>\` | the PM, workers, the reviewer |
| Worker | one per issue worktree | the development lead |
| Reviewer | \`<reviewer-instance>\` | the development lead |
| Judge | \`<judge-instance>\` | the PM |

- At the start, run \`commandmate whoami\`, find your instance id in the table, and say your role in one line. If you are not in the table, say so and stop.
- The person talks to the PM only. The PM never sends to a worker; the development lead never asks the person. Questions and approvals go up through the PM.
- A brief from the PM has five parts: the issue; what the person approved for it (the files that may change, and whether the worker may commit); how far merging is allowed (default: none; stop and report "mergeable"); when to stop; and the last line of the report (\`DONE: <summary>\` or \`STOP: <reason>\`).
- The development lead writes the person's approval into the contract and hands nothing more down. If a brief does not say what the person approved, or the work needs more than that, stop there and report up through the PM; do not start or widen it.
- A contract's scope is checked after the work; it does not stop an edit. Keep inside it yourself. Every contract says \`autoYes: mode: off\`.
- Making a worktree and \`commandmate sync\` are the development lead's, and each needs the person's yes first, through the PM. Before asking, say what \`sync\` does: it re-reads every repository registered on the CommandMate server, not only this one, deletes its records of worktrees that no longer exist in Git and stops their sessions, and stops the global assistant session. The person may press sync on the screen instead.
- Done means \`commandmate wait <worktree-id> --instance <worker> --verify\` exited 0. Report 20 or 21 as they are; never weaken a check.
- The PM's report starts with one line that says whether the person has to do anything ("Nothing needs your attention now." or "2 decisions are waiting for you."), then each decision with its options, the recommended one first.
- When a session you asked stops on a question or a permission prompt (\`wait\` or \`ask\` exits 10), do not answer it for that session: report it up. The person answers it on CommandMate's screen.
- Merging is the person's.

## mem and restarts

- Keep in mem only what CommandMate cannot know itself: what you intend (\`commandmate mem now "<text>"\`), what you wait for, the next step, and decisions. Use \`commandmate mem add --kind <kind> --text "<text>"\`, with \`--close-when\` for waiting, next and external items.
- A decision goes in as \`commandmate mem add --kind decision --text "<decision>" --promote-to issue:#<n>\`. Only the person approves it, on CommandMate's screen. You never approve a decision and never write it into the Issue yourself.
- When your context is getting long, or after the agent CLI was updated, write your state into mem and tell the PM; the person restarts the session. After a restart, read your brief first (\`commandmate brief\`) if it was not given with the first message.

## Antigravity

- No agent sends, asks, responds or relays to Antigravity (agy), and Auto Yes is never turned on for it (Google Antigravity Additional Terms of Service, Section 6: https://antigravity.google/terms).
\`\`\`

Commit the instructions file to \`<base-branch>\` after the person agrees, so new worktrees have it.

4. **Restart the team sessions once**, after the person agrees, so they read the instructions and the Skills: \`commandmate instances <base-worktree-id> kill <instance-id>\` for each team instance (never your own, instruction 7), and the next \`send --role\` starts it again with its role.

### Ask the person first

- Turning \`mem\` on, which they do themselves on the screen, and for which branches.
- Each Skill, after showing the \`--dry-run\` plan; \`--ack-risk\` for a high-risk one.
- Writing and committing the instructions file.
- Restarting the sessions.

### Confirm it worked

- \`commandmate mem mode --worktree <base-worktree-id>\` says \`on\`.
- \`commandmate brief --worktree <base-worktree-id> --instance <pm-instance>\` prints a brief (exit 0).
- Each team session, asked to run \`commandmate whoami\`, states the role the table gives it.

### If it fails

- \`mem\` commands exit 50: the mode is not \`on\` for that branch. Ask the person to check the rule on the screen; you cannot change it.
- \`brief\` exits 50: the same; exit 52: the worktree or instance id is wrong (\`commandmate instances <base-worktree-id>\`).
- \`skill install\` exits 12: it was not confirmed (no \`--yes\`, or a high-risk Skill without \`--ack-risk\`). Ask again rather than adding flags on your own. Exit 11: the worktree has local changes in the way; show the person \`git status\`.
- A session does not follow the instructions file: it started before the file was written. Restart it, after the person agrees.

## Phase 5: The first GitHub Milestone

Goal: the PM takes one issue from a GitHub Milestone through the development lead and a worker, and the issue's work passes the checks.

### Check

Ask the person first which GitHub repository the team's issues are in (step 1), then:

\`\`\`bash
gh issue list --repo <owner>/<repo> --milestone "<milestone>" --state open
commandmate instances <base-worktree-id>
commandmate mem mode --worktree <base-worktree-id>
\`\`\`

### Run

1. **Agree on the run.** Ask the person:
   - Which GitHub repository: its host (for example \`github.com\`) and \`<owner>/<repo>\`, in their words. Do not work it out from the Git remotes yourself: a checkout can have more than one (a fork and its upstream), and a remote URL can hold a credential. Show them the host and \`<owner>/<repo>\` you will use and let them confirm it. Use that same one for every \`gh\` command, reading and changing alike: \`--repo <owner>/<repo>\` on \`github.com\`, \`--repo <host>/<owner>/<repo>\` on another host, and \`gh api --hostname <host>\` there.
   - Which GitHub Milestone. Without \`gh\` (Phase 1), ask for its issue numbers, titles and acceptance criteria instead, and put them in the brief. If there is no milestone yet, suggest a small trial milestone with one or two small issues; create it and move the issues only after they agree (\`gh api repos/<owner>/<repo>/milestones -f title="<milestone>"\`, then \`gh issue edit <n> --repo <owner>/<repo> --milestone "<milestone>"\`).
   - Which issue goes first.
   - What the worker may do for it: which files may change (for example \`src/\` and \`tests/\`) and whether it may commit in its own worktree. The PM passes this down in the brief; the development lead writes it into the contract. Without an answer, the team stops before the work starts.
   - The deadline, with its time zone, and when to stop (for example: a check fails twice, a change outside the contract's scope is needed, or an approval is needed).
   - How far merging is allowed. The default is none: the PM reports "mergeable" and the person merges.

2. **Brief the PM.** Send the person's answers as one brief:

\`\`\`bash
commandmate send <base-worktree-id> "Milestone <milestone>, issue #<n> first. Ask the development lead to take it through one worker in its own worktree, under a contract with our checks, then have the reviewer read it. I approved: changes under <files> only, and commits in the worker's worktree <yes or no>; nothing else. Merging: none, report mergeable. Stop if a check fails twice, a change outside the scope is needed, or an approval is needed. Deadline <time and time zone>. Report to me with line 1 saying whether I have to do anything; end with DONE: or STOP:." --instance <pm-instance> --role pm
\`\`\`

3. **Follow it and bring every question to the person.** The PM asks the development lead (\`commandmate ask\`). The development lead makes the issue's worktree (Phase 2, step 6), writes the contract (Phase 3), hands it to a worker with \`send --contract\`, waits with \`wait --verify\`, and asks the reviewer to read the diff. Every approval they need comes back through the PM. Watch the PM:

\`\`\`bash
commandmate wait <base-worktree-id> --instance <pm-instance> --timeout 1800
commandmate reply <base-worktree-id> --instance <pm-instance>
\`\`\`

**How an answer reaches a stopped session.** Any session in the chain can stop on a question or a permission prompt: the PM, the development lead, the reviewer, and above all a worker in its new worktree (Phase 2, step 5). \`wait\` on the PM exits 10 when the PM is waiting; \`commandmate ls\` shows which worktree is waiting on someone. For each one:

\`\`\`bash
commandmate ls
commandmate prompt <worktree-id> --instance <instance-id>   # the question, its options, read only
\`\`\`

1. Show the person the question and its options as \`prompt\` printed them, and say which session asks and why.
2. The person answers it themselves on CommandMate's screen: open that worktree, choose that instance, and answer there (the same screen the phone shows). What they answer is then the prompt they are looking at.
3. Do not type the answer for them, even when they tell you what it is. A plain \`commandmate respond\` answers whatever the screen shows when it arrives, and by then the prompt they approved may have been replaced by another one with the same options. The checked form, which sends nothing when the screen changed (\`respond --expect-screen <kind> --observation <token>\`), covers only Antigravity's screens, and no agent answers Antigravity in this team. So every prompt this team meets is answered by the person on the screen.

Never choose an option yourself, and never let a team session answer another session's prompt.

4. **After the first issue.** The rest of the milestone goes the same way. When all its issues are merged, the PM asks the judge to check the integrated \`<base-branch>\` against each issue's acceptance criteria and reports GO or NO-GO per issue. If the person wants the PM to keep going while they are away, agree on the deadline with its time zone and on what the PM may do, and put both in the brief. Do not turn on Auto Yes for it in this team, even though the "time-boxed run" in Stage 6 of https://kewton.github.io/CommandMate/setup.md does: Auto Yes approves prompts the person never saw. When any session reaches a point that needs an approval, it stops there and waits for the person.

### Ask the person first

- The GitHub host and \`<owner>/<repo>\`, before the first \`gh\` command.
- The milestone, the first issue, the files the worker may change and whether it may commit, the deadline and the stop conditions.
- Creating a milestone or moving issues into one.
- Each worktree and branch the development lead asks for, and each \`commandmate sync\` (Phase 2, step 6).
- Every approval and every question the PM brings back, and every prompt a session stops on: the person answers it on the screen.
- Every merge. You never approve or merge on the person's behalf.

### Confirm it worked

- The worker's \`commandmate wait <worker-worktree-id> --instance <worker-instance> --verify\` exited 0.
- The reviewer answered APPROVE, or the REJECT was fixed and the checks passed again.
- The PM's report starts with the line that says whether the person has to do anything, and ends with \`DONE:\`.

### If it fails

- Exit 20 or 21 from \`wait --verify\`: see Phase 3. Report it to the person through the PM; do not weaken a check.
- Exit 10 from \`wait\`: a session is waiting on a question. Use step 3 ("How an answer reaches a stopped session"); do not choose an answer yourself.
- Nothing moves and no \`wait\` returns: run \`commandmate ls\`; a worker or the development lead may be waiting on a permission prompt in its own worktree. Use step 3 for it.
- Exit 124: the wait timed out. Look with \`commandmate capture\` before waiting again.
- Exit 32 from \`send --role\`: see Phase 2, step 4.
- \`ask\` or \`send\` exits 99: read what it printed on stderr before anything else; it says whether the message was sent. Send again only when it says nothing was sent. If you cannot tell, do not send again; tell the person.

## Where to read more

- The setup guide (install, phone, a single agent): https://kewton.github.io/CommandMate/setup.md
- Roles for a PM, a development lead and a worker: https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/team-roles.md
- CLI operations guide, every flag and exit code: https://github.com/Kewton/CommandMate/blob/main/docs/en/user-guide/cli-operations-guide.md
- A worked example of a team: https://github.com/Kewton/commandmate-team-demo
- CommandMate on GitHub: https://github.com/Kewton/CommandMate
`;
