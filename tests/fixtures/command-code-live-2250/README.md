# command-code-live-2250 — raw Command Code frames

Live `tmux capture-pane -p -e` captures of Command Code: the six frames the
Issue #2250 suites read (Epic #2249 Phase A), plus seven captured for Issue
#2304 on a build nine minor versions newer.

Every frame here is **200 columns by 1000 rows**, and both numbers are asserted
by `tests/unit/detection/tools/command-code/fixtures.test.ts` — see "Why the
geometry is asserted" below.

**These files are raw on purpose. Do not strip ANSI from them.** `boot-idle.txt`
is only a fair negative case for the launch-screen guard while its composer row
keeps the dim placeholder Command Code paints into an empty input box: after
`stripAnsi` that row is byte-identical to a transcript echo (#1879), which is the
trap the guard has to survive.

## Provenance

### The 1.40.1 frames (Issue #2250)

| | |
|---|---|
| Captured | 2026-09-03 |
| Agent | Command Code v1.40.1 (`/opt/homebrew/bin/commandcode`) |
| Pane geometry | 200x1000 (production layout — the default pane size reproduces neither the 200-column rules that fence the composer nor the status row's `esc to interrupt` tail, which the tool drops below 72 columns) |
| Session | `probe` / `probe2` on a private tmux server (`tmux -L cm2250`) over a scratch directory, killed afterwards |
| Command | `commandcode --no-session --skip-onboarding --no-auto-update --trust`, captured with `tmux capture-pane -p -e -t <session>` |

`--no-session` on purpose: the captures must not leave a resumable transcript in
`~/.commandcode/projects/`.

Redacted, and nothing in the suites reads either: the scratch cwd was replaced
with `~/cc2250-probe` and the shell prompt's `user@host` with a placeholder.
Every other byte is verbatim.

### The `-1490` frames (Issue #2304)

| | |
|---|---|
| Captured | 2026-09-04 |
| Agent | Command Code v1.49.0 (`/opt/homebrew/bin/commandcode`) |
| Pane geometry | 200x1000, same as above and for the same reasons |
| Session | `probe:cc` on a private tmux server (`tmux -L cm2304`) started with an **isolated `HOME`**, killed afterwards |
| Command | `commandcode --skip-onboarding --no-auto-update --trust`, captured with `tmux capture-pane -p -e -t '=probe:cc'` |

The isolated `HOME` is why `--no-session` is *not* passed this time: the same
run had to leave a transcript for `tests/fixtures/transcripts/command-code/` to
carry, and an isolated `HOME` keeps it out of the operator's own
`~/.commandcode/projects/`. Only `~/.commandcode/auth.json` and `config.json`
were copied in.

Redacted the same way and nowhere else: the probe cwd became
`/private/tmp/cc2304-probe/MyCodeBranchDesk/probe`, which is the one row of each
frame that carried it (the banner's `# <cwd>`). The `MyCodeBranchDesk/probe`
tail is kept deliberately — it is the part the transcript fixtures' slug story
rests on.

## Why the geometry is asserted

`fixture-sweep.ts` pins the row count for the tools that use it. The sweep for
this directory pins the **column** count as well, and that half was missing
everywhere before #2304:

- **1000 rows** keeps the transcript hundreds of rows above the chrome, so a
  rule that names a tail window is a statement about the rows it names.
- **200 columns** is what makes the frame carry the chrome at all. The `Status`
  component draws `esc to interrupt • <elapsed> • ↓ <tokens>` only in its
  `"all"` layout, i.e. at 72 columns or more, and the `─` rules that fence the
  composer are exactly as wide as the pane. A re-capture at a default width
  would drop the first and shorten the second — and every rule read off these
  frames would still pass, because the rules do not mention the width.

## The frames

| File | State | What it pins |
|---|---|---|
| `boot-idle.txt` | launched, no turn yet | The launch screen. `extractResponse(raw, 0, 'command-code', 1000)` must answer `isComplete: false`: block-art logo, `# Command Code v1.40.1` / `# models: …` / `# <cwd>`, composer between two rules — a complete idle frame with no user echo anywhere |
| `turn-thinking.txt` | turn 1 in flight | ` ⌘ Planning…  esc to interrupt • 0s • ↓ 0` three rows above a composer that is still drawn. `running` |
| `turn-version.txt` | turn 1 done | `⠶ released v1.40.1` then ` ✻ Worked for 2s`. The #2247 regression case: a short reply carrying a version string must be saved, not swallowed |
| `dialog-create-file.txt` | turn 2, permission dialog | `Create File` / `Do you want to create probe.txt?` / `❯ 1. Yes` / `2. …` / `3. …`. Note that turn 1's ` ✻ Worked for 2s` row is GONE — it belongs to the live turn's UI, not to the transcript |
| `turn-tool-write.txt` | turn 2 done | The `WRITE` tool block (` │ ` file preview included) and `⠶ Done.` |
| `dialog-shell-command.txt` | second session, shell-permission dialog | The other dialog shape (`Execute Shell Command`, four footer hints) sitting under a **two-row** reply, which is what pins the 2-space continuation indent of a wrapped `⠶` message |

### The 1.49.0 frames

| File | State | What it pins |
|---|---|---|
| `boot-idle-1490.txt` | launched, no turn yet | The launch screen at 1.49.0 — **and, byte-identically, the pane after `/clear`**. Measured: `/clear` repaints the launch screen, so one of the two "awkward idle states" #2250 said it had not captured needs no file of its own |
| `turn-thinking-1490.txt` | turn in flight | ` · Parsing…  esc to interrupt • 2s • ↓ 0`. The 1.40.1 shape with a different spinner glyph and a different verb, which is what the spinner class and the case-agnostic verb were left open for |
| `turn-shell-running-1490.txt` | tool running | Two things. ` ✧ Shell command allowed  esc to interrupt • 19s • ↓ 1.7k` is a status verb of **three words with no `…`**, which `COMMAND_CODE_THINKING_PATTERN`'s spinner branch does not read — only the `esc to interrupt` tail does. And ` ✻ Thinking… (72 lines) [ctrl+o to expand]` two rows above it is a *second, independent* marker, which is why this frame stays `running` when the status row is defused and the single-marker frames do not |
| `turn-done-1490.txt` | turn done | `⠶ PROBE-2304-OK` then `✻ Worked for 2s` |
| `dialog-shell-1490.txt` | shell-permission dialog | The 1.49.0 shell dialog. Byte-shape identical to 1.40.1's, including the four footer hints and the OSC-8 link in `(Docs ↗)` |
| `dialog-kill-task-1490.txt` | shell-permission dialog, other body | The other dialog body: a description row (`Stop tracked shell/monitor task s0a8jfqz`) where the shell dialog puts `Press [ctrl+e] to explain this command`, and one footer hint fewer |
| `idle-after-interrupt-1490.txt` | idle after an Esc interrupt | The second awkward idle state, and the one that *does* need a file. Esc landed before the agent had written anything, so the newest turn is a prompt echo followed straight by `✻ Worked for 4s` with **no `⠶` reply row at all** — a pane any "the tail carries a reply" completion rule would read as unfinished forever |

## Measured facts these frames carry

- **Inline rendering.** `#{alternate_on}` is 0 and the pane keeps its scrollback,
  so a captured line count is a real cursor (unlike claude v2 / opencode /
  copilot).
- **`⠶` is fixed, not a spinner frame.** The bundle declares it once as
  `Ct() ? "⠶" : "#"` — one constant with an ASCII fallback. That answers Epic
  #2249's 未確定事項 1.
- **`✻ Worked for Ns` is not a durable marker.** `WorkedDurationNote` renders
  nothing under 1000 ms, and the row is dropped when the next turn starts —
  compare `turn-version.txt` with `dialog-create-file.txt`, the same pane one
  prompt later. Nothing may require it to declare a turn finished.
- **The footer row is mode-dependent.** `? for shortcuts` is only the DEFAULT
  mode's spelling; `ModeIndicator` swaps it for `plan mode`, `» accept edits on`,
  `» permission bypass on` or `» don't-ask on`.
- **The footer also grows segments.** 1.49.0 with a background shell running
  spells it `? for shortcuts · taste on · 1 shell · ↓ to manage`
  (`turn-shell-running-1490.txt`). Nothing reads the footer's content, and this
  is the reason to keep it that way.

## Measured for Issue #2304

- **Nine minor versions changed no rule.** All six 1.40.1 rules answer
  identically on the 1.49.0 frames, state for state, which is why
  `verifiedAgainst` still records 1.40.1: that is the build the rules were read
  *off*, and the sweep is the receipt that they still hold.
- **`PreToolUse` still fires after the dialog is answered.** Re-measured with a
  hook that logged every payload: with the `Create File` dialog on screen the
  log held one line; answering `1` took it to four. Epic #2249 決定 3 stands.
- **The §4 D1 gap is real and is pinned.** Defuse the busy vocabulary on a
  running frame and Command Code publishes `ready` / `input_prompt` /
  `evidence: 'positive'`, because the composer row is drawn during a turn and
  after it. That is a completion declared on the *absence* of a busy marker,
  which is why `detection-evidence-config` ships `legacy` for this tool. The
  frames a rule would need — the idle states with no completion marker — are the
  two `-1490` idle rows above; building the rule is its own Issue.
- **`matcher` must be the empty string.** `"*"` loads without complaint and
  silently kills `SessionStart` and `Stop`; measured again on 1.49.0 while
  setting the probe's hooks up, and already written down in
  `hooks-config.ts` §2.
