# opencode-live-2046 — what pressing an opencode quick key does to a frame

Live `tmux capture-pane -p -e -S -200 -E -` captures used by
`tests/unit/detection-opencode-quick-key-frames-2046.test.ts` (Issue #2046).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** The verdicts under test are anchored on the input box's
gutter (`┃`, U+2503) and on the SGR-painted background that #2047 turned out to
be about; the first test in the suite asserts the raw bytes are still there.

## Why 80 columns only

Unlike `opencode-live-2047/`, which exists to answer "does the pane width change
anything", these frames exist to answer "does *this keystroke* change anything".
The answer is only interesting at the width production actually runs opencode
at, which `OPENCODE_PANE_WIDTH` pins at 80 — and one of the findings is that a
keystroke can put the pane into the 121+-column *state* while it is still 80
columns wide. Capturing that at 200 would have hidden it.

## Provenance

| | |
|---|---|
| Captured | 2026-08-26 |
| Agent | opencode 1.18.22 (model `Claude Sonnet 4.6`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_WIDTH` x `OPENCODE_PANE_HEIGHT`, i.e. production |
| Harness | `docs/design/opencode-server-live-verification.md` §4: isolated `HOME` under the scratchpad, `opencode serve` on 127.0.0.1:4790, `GET /path` confirmed all five resolved directories were inside it |
| Session | `ocw` on a private tmux socket (`tmux -L cmate-2046-oc`), `opencode attach`, torn down with `kill-session -t '=ocw:'` (never `kill-server`) |
| Command | `tmux -L cmate-2046-oc capture-pane -t '=ocw:0.0' -p -e -S -200 -E -` |
| Keys | sent with `tmux -L cmate-2046-oc send-keys`, leader chords as two sends 100–300 ms apart (production sends them 100 ms apart, confirmed 3/3) |
| Model picker | opened once, by accident, inside the isolated `HOME`; closed with Escape with nothing selected, and both the isolated config and the user's `~/.config/opencode/opencode.jsonc` / `~/.local/share/opencode/opencode.db` were verified unchanged afterwards. See §22.7. |

## The frames

| File | How it was produced | What it shows |
|---|---|---|
| `home-idle.txt` | fresh session (`ctrl+x n`), nothing typed | opencode's home screen: `Ask anything...` placeholder, `ready` / `input_prompt` |
| `home-leader-b-fallthrough.txt` | `ctrl+x` then `b` on that home screen | `sidebar_toggle` is session-scoped, so the leader does **not** consume the letter: a literal `b` is in the composer, and the verdict flips to `running` / `unknown_frame` |
| `sidebar-off.txt` | one completed turn (`OK2046`), sidebar off | the normal production frame: `ready` / `opencode_response_complete`, saved reply `OK2046` |
| `sidebar-on.txt` | the same session after `ctrl+x` `b` | the sidebar is on **at 80 columns**, the transcript is truncated to ~37, the verdict is `running` / `unknown_frame`, and the saved reply is the sidebar's own text |
| `agent-build.txt` | after two `Tab` presses | composer status line reads `Build · Claude Sonnet 4.6 GitHub Copilot`. Byte-identical to `sidebar-off.txt` — `Tab` twice is an involution on the whole frame, not just on the label |
| `agent-plan.txt` | after one `Tab` press | the same frame reading `Plan · …` |
| `dialog-agent-list.txt` | `ctrl+x` `a` | opencode's `Select agent` dialog, `● build native` / `plan native` |
| `dialog-session-list.txt` | `ctrl+x` `l` | the `Sessions` dialog |
| `dialog-timeline.txt` | `ctrl+x` `g` | the `Timeline` dialog |
| `dialog-command-palette.txt` | `ctrl+p` | the `Commands` palette, which is also where opencode prints its own keybind table |

Every one of these was produced by a **keystroke on a live TUI**, never by a
`POST /tui/open-*`. §11.3.3 of the design doc is why that distinction is
load-bearing: those routes answer `200 true` with no TUI attached at all, so an
HTTP success is not evidence a dialog exists.

## Not here

- **No fixture for `F2` (`model_cycle_recent`) or `ctrl+x m` (`model_list`)
  mid-selection.** Measuring either means putting a second model in opencode's
  recent list, which means selecting one in the picker — and the picker rewrites
  opencode's default model (§4). Neither key is published by this Issue.
- **No 120/200-column variants.** `opencode-live-2047/` already holds the same
  session at three widths; re-taking them here would be a second copy of #2047's
  answer, not a new measurement.
