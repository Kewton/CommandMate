# command-code-live-2250 — raw Command Code frames

Live `tmux capture-pane -p -e` captures of Command Code, used by the Issue #2250
suites (Epic #2249 Phase A).

**These files are raw on purpose. Do not strip ANSI from them.** `boot-idle.txt`
is only a fair negative case for the launch-screen guard while its composer row
keeps the dim placeholder Command Code paints into an empty input box: after
`stripAnsi` that row is byte-identical to a transcript echo (#1879), which is the
trap the guard has to survive.

## Provenance

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

## The frames

| File | State | What it pins |
|---|---|---|
| `boot-idle.txt` | launched, no turn yet | The launch screen. `extractResponse(raw, 0, 'command-code', 1000)` must answer `isComplete: false`: block-art logo, `# Command Code v1.40.1` / `# models: …` / `# <cwd>`, composer between two rules — a complete idle frame with no user echo anywhere |
| `turn-thinking.txt` | turn 1 in flight | ` ⌘ Planning…  esc to interrupt • 0s • ↓ 0` three rows above a composer that is still drawn. `running` |
| `turn-version.txt` | turn 1 done | `⠶ released v1.40.1` then ` ✻ Worked for 2s`. The #2247 regression case: a short reply carrying a version string must be saved, not swallowed |
| `dialog-create-file.txt` | turn 2, permission dialog | `Create File` / `Do you want to create probe.txt?` / `❯ 1. Yes` / `2. …` / `3. …`. Note that turn 1's ` ✻ Worked for 2s` row is GONE — it belongs to the live turn's UI, not to the transcript |
| `turn-tool-write.txt` | turn 2 done | The `WRITE` tool block (` │ ` file preview included) and `⠶ Done.` |
| `dialog-shell-command.txt` | second session, shell-permission dialog | The other dialog shape (`Execute Shell Command`, four footer hints) sitting under a **two-row** reply, which is what pins the 2-space continuation indent of a wrapped `⠶` message |

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
