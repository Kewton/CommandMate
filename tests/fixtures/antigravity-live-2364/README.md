# antigravity-live-2364 — raw Antigravity (agy) frames

Live `tmux capture-pane -p -e` captures of agy 1.1.27, taken for Issue #2364.
Every frame is **200 columns by 1000 rows**, asserted by
`tests/unit/lib/detection/antigravity-numbered-dialog-2364.test.ts`; agy is
top-anchored, so the content sits in the first ~30 rows and the rest is the
blank padding the server's `lastLines` slicing walks off. A fixture without
that padding exercises a different window than production does
(`reference_tui_pane_anchoring_top_vs_bottom`).

**These files are raw on purpose. Do not strip ANSI from them.** The `>`
gutter on the highlighted option is drawn in `\x1b[94m`, and the rules that
read it must survive both the raw spelling and the `stripBoxDrawing(stripAnsi())`
spelling the response poller hands them.

## Provenance

| | |
|---|---|
| Captured | 2026-09-06 |
| Agent | Antigravity CLI 1.1.27 (`agy`, `~/.local/bin/agy`), Gemini 3.8 Flash (High) |
| Pane geometry | 200x1000 (`new-session -x 200 -y 1000`, `window-size manual`, `resize-window -x 200 -y 1000`) |
| Session | `probe` on a private tmux server (`tmux -L cm2364`) over a scratch git directory, killed afterwards |
| Hooks | `~/.gemini/config/hooks.json` as installed by CommandMate; launched WITHOUT `CM_PERMISSION_HOOK_URL`, so the `PreToolUse` relay answered `{"decision":"ask"}` and agy drew its own dialogs (the Auto-Yes-off situation the Issue is about) |

Redacted, and nothing in the suites reads any of it: the scratch cwd was
replaced with `~/agy2364-probe`, the shell prompt's `user@host` and the
account e-mail with placeholders. Every other byte is verbatim.

## The frames

| file | screen | expected reading |
|---|---|---|
| `boot-idle.txt` | after the trust screen: bare `>` between two rules, `? for shortcuts` status row | `ready` / `input_prompt` — the first live IDLE agy frame in the repository |
| `trust-dialog.txt` | `Do you trust the contents of this project?` — `> Yes, I trust this folder` / `No, exit`, `↑/↓ Navigate · enter Confirm` | `waiting` / `antigravity_selection_list` (unnumbered rows) |
| `dialog-create-file.txt` | **Issue path 1.** `Create file` panel with a one-line diff preview, `Allow creation of this file?`, `> 1. Yes, allow creation` / `2. No, deny creation`, `↑/↓ Navigate · tab Amend · f full diff` | `waiting` / `prompt_detected`, 2 options, question exactly `Allow creation of this file?` |
| `dialog-create-file-highlight-2.txt` | the same after one `Down`: `2. No, deny creation` wears the `>` | option 2 `isDefault` |
| `dialog-bash-oneline.txt` | `Command` panel, `Requesting permission for:` a one-line `python3 -c`, `Do you want to proceed?`, four options on one row each | the #2270 shape on 1.1.27: 4 options |
| `dialog-bash-wrapped.txt` | **Issue path 2.** the same panel for a `python3 -c` whose script spans lines: options 2 and 3 each wrap onto three rows | `waiting` / `prompt_detected`, 4 options, the wrapped rows folded into labels 2 and 3 — and **never** `running` / `thinking_indicator` |
| `dialog-bash-wrapped-highlight-4.txt` | the same after three `Down`s: `4. No` wears the `>` | option 4 `isDefault` |
| `dialog-bash-wrapped-six.txt` | the same command asked again after a denial: agy adds `5. No, and always deny … in this conversation` and `6. No, and always deny … (Persist to settings.json)`, both wrapping onto three rows — so the LAST option wraps | 6 options, option 6's wrapped rows folded into its label (captured through the isolated CommandMate server, hence the `CM_HOOK_URL=…` launch rows at the top) |
| `dialog-feedback-category.txt` | `/feedback`'s category menu: six numbered rows under `esc Cancel · 1-6 Select & Continue · enter Continue` — no `↑/↓ Navigate` | not an agy numbered dialog (no footer); still read by the generic parser as before |
| `picker-switch-model.txt` | `/model`: `Switch Model` header, unnumbered model rows, effort slider, `Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back` | `waiting` / `antigravity_selection_list` — the #995 regression frame |
| `popup-slash-commands.txt` | the slash-command popup: `> /add-dir  Add a directory …` rows, `↓ 41 more`, `↑/↓ Navigate · enter Select · tab Complete` | `waiting` / `antigravity_selection_list` |
| `idle-after-deny.txt` | the pane after `4. No` on the wrapped dialog: `⎿  User declined the tool call`, composer back | `ready` / `input_prompt` |
| `survey-after-deny.reconstructed.txt` | **not a capture — see below** | `waiting` / `antigravity_selection_list`, never `running` |

## `survey-after-deny.reconstructed.txt`

agy sometimes replaces its composer with a survey after a tool decision:

```
 How's the CLI experience so far? Help us improve:
 [1] Good  [2] Fine  [3] Bad  [0] Skip

? for shortcuts …
```

It was seen once, on the production server on 2026-09-06 (agy 1.1.27, 200x1000,
right after `2. No, deny creation`), and only its ANSI-stripped rows were
recorded; it did not reappear during the capture session above, and what
triggers it is not known. This file is `dialog-create-file.txt`'s pane after
the denial (a real capture, `idle-after-deny`-shaped) with the composer block
— rule, `>`, rule — replaced by the three recorded survey rows, plain text, in
the recorded positions. Everything above and below them is verbatim.

Replace it with a raw capture the next time the survey is seen. The reading
it pins (a selection list, not a `multiple_choice` prompt) is deliberate: the
screen takes a typed digit, while `sendPromptAnswer` drives agy's numeric
answers with arrow keys, so a `0. Skip` button would send the wrong keys.

## Why these live under `tests/fixtures/` and not `tests/unit/lib/detection/fixtures/`

Four suites walk `tests/unit/lib/detection/fixtures/` as a corpus and pin what
they find there by name or by property (`auto-yes-dialog-gate.test.ts`,
`detection/tools/unclassified-frames.test.ts`,
`opencode-terminal-compaction-2049.test.ts`,
`terminal-display-normalize-2049.test.ts`). Adding a directory there is a
change to those suites' inputs, and Issue #2364's scope does not include them.
Under `tests/fixtures/` the only sweep is `dialog-frame-2326.test.ts`, which
asserts that the Command Code picker reader stays null on every non-Command-Code
frame — which these are.
