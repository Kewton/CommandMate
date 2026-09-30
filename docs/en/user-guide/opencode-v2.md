[日本語版](../../user-guide/opencode-v2.md)

# OpenCode V2 (opencode-v2)

OpenCode V2 is OpenCode 2.0 (executable `opencode2`, npm package `@opencode/cli`). In CommandMate it is a separate
agent from OpenCode 1.x (`opencode`): **OpenCode V2** (tool id `opencode-v2`), chosen per worktree like the others.
The public pages (README, landing page) count 1.x and V2 together as one agent, "OpenCode (1.x and V2)".

What this page says is what was checked against `opencode2` **2.0.18** in the user acceptance tests (UAT) of
2026-09-28 to 09-29 and in each Issue's run on a real CLI (Epic #2370).

---

## 1. Installing it next to OpenCode 1.x

```bash
npm install -g @opencode/cli               # OpenCode V2 (opencode2)
```

- The package registers two executables, `opencode2` **and `opencode`**. The second name collides with 1.x's
  `opencode`, so CommandMate tells 1.x and V2 apart by what `--version` prints, not by the name (Issue #2939).
- 1.x and V2 share `~/.local/share/opencode/opencode.db`. After V2 has run, 1.x can fail to start with
  `no such column: …`; CommandMate then shows that cause as the start error.
- In the V2 sessions CommandMate starts, V2's own update check is turned off, so starting V2 no longer writes a
  `"packageManager"` field into the project's `package.json` (Issue #2957; in the UAT `package.json` stayed
  unchanged in all five worktrees). Update V2 with `npm install -g @opencode/cli`.

For the details see [OpenCode (1.x) and OpenCode V2 side by side](./cli-setup-guide.md#opencode-1x-and-opencode-v2-side-by-side)
in the CLI setup guide.

---

## 2. How it is started

- For each instance CommandMate starts a private `opencode2 serve` (port 4300–4399, password stored as a 0600
  file under `~/.commandmate/opencode-v2/`) and attaches the TUI to it. Unlike the other tools no hook
  configuration is written: CommandMate subscribes to that server's SSE (`GET /api/event`) for the state
  (Issue #2934).
- The executable is passed as its resolved absolute path. A V2 installed only under the `opencode` name starts the
  same way, private server plus TUI (Issue #2952).
- Only when the port, the password file or the launch script cannot be prepared does it start as
  `opencode2 --standalone`. Started that way no structured events reach CommandMate, so the state display and
  answering approvals do not work.
- Stopping the session stops both the TUI and the private server, and the port closes.

---

## 3. What works

| Feature | What it does | Issue |
|---|---|---|
| Sending | Send from the screen and with `commandmate send`. A bare `/<name>` (a project command or a Skill) runs in V2 as is | #2934 #2950 |
| State | Running, done and waiting are shown from the SSE (e.g. `OpenCode V2: waiting` in the sidebar) | #2934 |
| Transcript (History) | When a turn ends the reply is read from V2's server and recorded in chat, one row per turn | #2940 |
| Approvals and questions | Approvals (with the diff) and questions can be answered from the PC panel, the phone, `commandmate respond` and Auto-Yes (below) | #2945 #2951 |
| Refusing to send into a dialog | While a dialog such as model selection or the Commands palette is open, sending fails instead of typing the text into the dialog (below) | #2971 |
| Model | The model that actually answered is shown in `capture --json` (`.model`) and in the pane header. After a model change in the TUI it switches with the next reply, and a change notification is raised | #2964 |
| Usage | Tokens (input, output), cost and context usage are shown on screen and in the API, matching V2's own footer. They switch with a new session and are cleared when the instance stops | #2981 |
| Switching agents | The mode button beside the composer switches Build ⇄ Plan (it sends `shift+tab`) and shows the current agent. It works on the chat screen, the terminal screen and the phone | #3038 |
| Quick keys | Ten keys from V2's measured key table (Commands / Variant / Agents / Sessions / New session / Models / Page up / Page down / First / Latest). `shift+tab` moved to the mode button above | #2966 #3038 |
| Keys on the dialog card | While model selection is open, the chat card shows Variant `ctrl+t` / Models `ctrl+x m` / Commands `ctrl+p`, and pressing one switches to it | #2983 |
| Slash-command candidates | Built-in commands, Skills and the running server's project commands are offered. V2 is also covered by the freshness check of the built-in list (`catalogStaleness`) | #2944 #2950 |
| Skills | Reads `.agents/skills` and `.claude/skills`. A Skill added while it runs needs **no new session**: it is found from the next send | #2975 #2985 |
| Schedules | Writing `opencode-v2` in the CLI Tool column of CMATE.md runs `opencode2 run` in the schedule's worktree | #2974 #2979 #2982 |
| Daily check | The agent-health daily check includes V2's launch and SSE ([agent-health](../../user-guide/agent-health.md), Japanese) | #2937 |

### Answering approvals and questions

- The approval choices are the ones V2's screen draws: **Allow once / Always allow / Reject**. `commandmate respond`
  takes the number (`1` to `3`) or the text (`"Always allow"`), and also accepts 1.x's `Allow always`. The approval
  card shows the target and the diff.
- Questions are answered with the number of a choice. A question that accepts free text can be answered with text
  (e.g. `respond "Purple"`).
- Auto-Yes answers V2's approvals. Turning Auto-Yes on while an approval is pending answers that pending approval
  too (the output reads `Re-judged 1 pending approval(s): 1 answered.`).
- Auto-Yes does not answer numbered choices (such as `❯ 1. Yes`) in the **body** of a reply (Issue #2984).

### While a dialog is open

- While a dialog other than an approval or a question is open (Select model / Select variant / Commands, …),
  `commandmate send` types nothing and exits 99 with a message such as
  `the "Select variant" dialog is open. Close it (esc) or finish the choice, then send again`.
- Meanwhile the state stays waiting and `commandmate wait` does not report completion (exit 10 by default). Close
  the dialog with `esc` and send again.

### Notes on schedules

For the settings and the measurements see [the opencode-v2 section of the schedules guide](./cmate-schedules-guide.md#opencode-v2---auto).
An operation answered with "Always allow" on screen is also allowed in the schedules of every worktree of the same
repository (same section).

---

## 4. How it differs from OpenCode 1.x

| Aspect | OpenCode 1.x (`opencode`) | OpenCode V2 (`opencode-v2`) |
|---|---|---|
| Executable | an `opencode` whose `--version` prints `1.x` | `opencode2`; failing that, an `opencode` whose `--version` prints `opencode v2.x` |
| Switching agents | `tab` / `shift+tab` | **`shift+tab` only** (Build ⇄ Plan). `tab` does not switch |
| Approval wording | Allow once / Allow always / Reject | Allow once / **Always allow** / Reject |
| Picking up a Skill | a new session is required | no new session (found from the next send) |
| Invoking a Skill | the server expands the Skill as a command | the model calls the `skill` tool. Skills are not in V2's own `/` completion, so use `@` completion or send `/<name>` from CommandMate's slash-command candidates |
| Scheduled runs | `opencode run` | `opencode2 run --standalone --format json`; `--variant` only together with `--model` |

Both can be installed and used side by side. The installation details are in the
[CLI setup guide](./cli-setup-guide.md#opencode-1x-and-opencode-v2-side-by-side).

---

## 5. Not yet, and known bugs

- **The first send after a start**: the first `commandmate send` to a newly started instance can fail with
  `OpenCode V2 composer not ready` (exit 99, nothing sent). Sending again goes through (observed in the UAT of
  2026-09-29).
- **Questions that cannot be answered**: a question with a numeric, free-text-only or external field, or with more
  than one field, cannot be answered from CommandMate. Answer it in V2's TUI.
- **The reach of "Always allow"**: OpenCode treats the worktrees of one repository as one project and saves
  "Always allow" there. An operation always-allowed in one worktree goes through without a prompt in the other
  worktrees of the same repository.
- **The Skill detail screen**: the V2 row appears in the Skill detail's compatibility table only once the Catalog's
  manifest declares V2 (commandmate-skills#275).
- **Starting with `--standalone`**: as in §2, the state display and answering approvals do not work.

---

## 6. Related

- [CLI setup guide](./cli-setup-guide.md) — installing, and living next to 1.x
- [CMATE.md schedules](./cmate-schedules-guide.md) — `opencode-v2` run options and Permission
- [Agent Skills](./skills.md) — installing Skills and per-agent support
- [Skill and agent compatibility](../../reference/skill-agent-compatibility.md) — V2's Skill measurements (§10, Japanese)
- [Agent event hooks](./agent-event-hooks.md) — V2 writes no hooks and is subscribed over SSE
