# copilot-live-1885 — raw copilot TUI frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-copilot-generating-1885.test.ts` (Issue #1885).

**These files are raw on purpose. Do not strip ANSI and do not re-capture them
at a smaller pane height.** The verdict under test is anchored on the *bottom
row of the pane* — copilot draws its turn state there and nowhere else — and a
frame trimmed to a default pane height would put the transcript and the status
bar inside the same tail window, which is precisely the confusion these fixtures
exist to rule out. The first test in the suite asserts both properties and fails
loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | GitHub Copilot CLI 1.0.80 (model `GPT-5.6 Terra`), launched as `gh copilot` — the production `COPILOT_LAUNCH_COMMAND` |
| Pane geometry | 200x1000 — the production layout for copilot (design policy §4 D2) |
| Session | `cpprobe` on a private tmux socket (`tmux -L cm1885probe`), over a scratch git repository, killed afterwards |
| Command | `tmux -L cm1885probe capture-pane -t '=cpprobe:' -p -e -S -1000 -E -` |

## The layout these frames capture

copilot runs on the alternate screen and pins its chrome to the bottom of the
pane. Every frame here has the same five rows at the bottom, with the transcript
~970 rows above them and nothing but padding in between:

```
 <cwd> [⎇ <branch>]                                   Session: N AIC used
────────────────────────────────────────────────────────────────────────  ← full-width rule
❯                                                                          ← composer
────────────────────────────────────────────────────────────────────────  ← full-width rule
 ◉ Working · 1.5 KiB esc interrupt                            GPT-5.6 Terra ← STATUS BAR
```

The last row is the only one that changes when a turn starts or ends. The
composer above it is drawn *throughout* a turn — that is the measurement behind
the bug: `COPILOT_PROMPT_PATTERN` matches every frame of a generating session, so
the always-visible `❯` used to win at step 3 of `detectSessionStatus` and publish
`ready`/`input_prompt` while copilot was working.

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `boot-idle.txt` | A session that has just started. Status bar: `← open sidebar · / commands · ? help · tab next tab` | `ready` / `input_prompt` / `hasActivePrompt: false` |
| `turn-running-early.txt` | The first seconds of a turn, before any output. Status bar: `● Working esc interrupt` — no byte counter yet | `running` / `thinking_indicator` — the #1885 regression |
| `turn-running-thinking.txt` | Mid-turn. Status bar: `◉ Working · 1.5 KiB esc interrupt`; `⌄ Thinking…` visible in the transcript | `running` / `thinking_indicator` |
| `turn-complete.txt` | The same turn finished. `⌄ Thinking…` has become `⌄ Thought for 41s`, the status bar is back to key hints | `ready` / `input_prompt` |
| `status-vocabulary-in-response.txt` | copilot was asked to print the status-bar vocabulary and answered ` ● Working esc interrupt` / `Thinking…` as body text, while the status bar shows key hints | `ready` / `input_prompt`; the running check must **not** match |
| `permission-dialog.txt` | `Do you want to run this command?` — copilot draws the dialog as a box over the bottom of the pane, so there is **no status bar and no composer** | `waiting` / `prompt_detected` / `hasActivePrompt: true`, unchanged by #1885 |
| `model-picker.txt` | `/model`. Ends in its own footer (`↑/↓ to navigate · … · enter to select · esc to cancel`), not the status bar | no positive evidence: not `input_prompt`, `isUnclassifiedActive: true` (Issue #1895's subject) |

## What was measured, and what it rules out

**The 1.0.79 rewording.** `COPILOT_THINKING_PATTERN` (Issue #547) looks for
braille spinners, `(Esc to cancel`, `Reasoning ■■■`, `... Thinking`, `Generating`
and `Processing`. Across 44 live generating frames captured for this fixture set,
1.0.80 drew **none** of them — 0/44 detected. What it draws is `Working` and
`esc interrupt`, and the spinner glyph cycles `● ◉ ◎ ○` while the byte counter
(`· 37 B`, `· 1.5 KiB`, `· 2.6 KiB`) appears only once the turn has produced
output. Neither the glyph nor the counter is anchored on.

**Why the row and not a window.** `status-vocabulary-in-response.txt` is the
answer. copilot printed ` ● Working esc interrupt` into its own transcript, which
is character-for-character its status bar, and the transcript never scrolls away.
A detector matching that vocabulary anywhere in the last 15 rows would pin the
finished session to `running` for the rest of its life — the #1900 shape, where
`wait` polls to `--timeout` against an idle agent. Reading only the bottom row
costs nothing and rules the whole class out.

**Why a dialog cannot be misread as busy.** `permission-dialog.txt` shows what
copilot does when it needs an answer: the box replaces the bottom of the pane, so
the status bar is gone and the frame carries no evidence either way. The running
check declines it and `detectPrompt` reports `waiting` exactly as before — which
is what makes it safe to keep the running check *ahead* of prompt detection,
where Issue #547 originally put it.

**Why the composer is not the completion evidence.** The design policy's D1
example for copilot ("an empty composer straight after the `●` response row")
does not describe 1.0.80: the composer is ~950 rows below the response, and it is
drawn identically while the agent works. Both running fixtures assert
`COPILOT_PROMPT_PATTERN` still matches, so this stays measured rather than
remembered.
