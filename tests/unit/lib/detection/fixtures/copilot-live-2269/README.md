# copilot-live-2269 — raw copilot 1.0.82 TUI frames

Live `tmux capture-pane -p -e` captures used by Issue #2269.

**These files are raw on purpose. Do not strip ANSI and do not re-capture them
at a smaller pane height.** Every verdict under test is positional — copilot
pins its chrome to the bottom of the pane and nothing else tells the chrome from
transcript that quotes it — and a frame trimmed to a default pane height puts
the transcript and the chrome inside the same window, which is exactly the
confusion these fixtures exist to rule out.

## Provenance

| | |
|---|---|
| Captured | 2026-09-04 |
| Agent | GitHub Copilot CLI 1.0.82 (model `GPT-5.6 Terra`) |
| Pane geometry | 200x1000 — the production layout for copilot (design policy §4 D2) |
| Session | `p` on a private tmux socket (`tmux -L cm2269`), over a scratch directory outside the repository, killed afterwards |
| Command | `tmux -L cm2269 capture-pane -t p -e -p` |

## What changed between 1.0.80 and 1.0.82

`copilot-live-1885/` (1.0.80) fences the composer with two full-width `─` rules:

```
 <cwd> [⎇ <branch>]                                   Session: N AIC used
────────────────────────────────────────────────────  ← full-width rule
❯                                                     ← composer
────────────────────────────────────────────────────  ← full-width rule
 ◉ Working · 1.5 KiB esc interrupt      GPT-5.6 Terra  ← STATUS BAR
```

1.0.82 draws the same five rows with a *half-block* frame and no `❯` in the
composer at all:

```
 <cwd>                                                Session: N AIC used
╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ← opening frame (U+257B + U+2584 ×)
┃                                                     ← composer (U+2503, text follows)
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ← closing frame (U+2579 + U+2580 ×)
 ← open sidebar · / commands · ? help · tab next tab   GPT-5.6 Terra  ← STATUS BAR
```

`COPILOT_RULE_ROW` was `/^─{10,}$/`, so `findCopilotChromeStart` returned -1 on
every frame here and the whole pane — frame rows, composer and the
`← open sidebar …` footer included — was saved as the agent's reply. That is
#2269's headline symptom.

The **transcript** changed with it. 1.0.80 drew the echoed prompt as one bare
` ❯ <text>` row; 1.0.82 boxes it between two half-block dividers that carry no
corner glyph:

```
 ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
  ❯ Reply with exactly the word: uat-run1       00:27
 ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
 ● uat-run1
```

`COPILOT_SKIP_PATTERNS` already carried `/[█▘▝▖▗▔▄▌▐]/`, which drops the `▄`
row above the echo. `▀` (U+2580) was **not** in it, so the row *below* the echo
survived — and since extraction starts one row past the echo, the wall of `▀`
was the first line of every saved reply.

Tool rows changed shape too. 1.0.80 drew them all as `● <Verb> …`; 1.0.82 puts
a short file-type badge in front of the verb and only falls back to `●` for a
type it has no badge for:

| Row (measured, ANSI stripped) | Badge |
|---|---|
| `/ Search "a.ts" 1 file found` | `/` |
| `MD Read note.md L1:1 (1 line read)` | `MD` |
| `TS Read a.ts 1 line read` | `TS` |
| `PY Read c.py 1 line read` | `PY` |
| `{} Read b.json 1 line read` | `{}` |
| `● Read d.txt 1 line read` | `●` (plain text has no badge) |
| `$ Shell Print requested text 2 lines…` | `$` (unchanged; a block header) |
| `● Asked user What would you like me to help with?` | `●` |

The reply itself is still `● <text>` (` ● uat-run1`, ` ● done`), and the
collapsed reasoning block is still `⌄ Thought for 22s` followed by `│ …` rows,
both unchanged from 1.0.80.

## The frames

| File | State | What it pins |
|---|---|---|
| `boot-idle.txt` | launch screen, idle | The 1.0.82 chrome with an **empty** composer (`┃` and nothing else) and no echo anywhere. `findCopilotChromeStart` must return the cwd row, and the launch banner must not be saved as a reply. |
| `turn-complete.txt` | finished turn | `● uat-run1` — a one-word reply, the acceptance case. The `▀` wall sits directly above it. |
| `turn-complete-oneword.txt` | finished turn | `● 13` — the second acceptance case, two turns deep, so the previous turn's echo and reply are also on screen. |
| `turn-running.txt` | generating | Status bar reads `◉ Working esc interrupt`; the composer frame is drawn throughout, which is why it cannot be the completion signal. |
| `turn-tool-rows.txt` | finished turn | `/ Search …` + `MD Read …` + `● hello-2269`. The badge rows must not reach the reply. |
| `turn-tool-badges.txt` | finished turn | `TS` / `{}` / `PY` / `●` Read badges and four `/ Search` rows around a `● …` prose row and a final `● done`. The measurement behind the badge alternation. |
| `turn-shell-block.txt` | finished turn | `$ Shell Print requested text 2 lines…` with its indented `echo 2269-ok` row, then `● 2269-ok`. The 1.0.80 block rule still holds. |
| `turn-oneword-echo-askuser.txt` | finished turn | The whole turn produced by a bare ` ❯ a` nudge: a `⌄ Thought for 57s` reasoning block and `● Asked user What would you like me to help with?`. The frame behind #2269's "launch screen saved as the reply" report — a one-character echo is a turn boundary the guard used to trust. |

## One frame that was measured and is deliberately not here

1.0.82's folder-trust dialog was captured in the same session. It draws its box
over the bottom of the pane, so there is no composer and no status bar, and
`findCopilotChromeStart` returns -1 on it — the frame belongs to `detectPrompt`,
exactly as 1.0.80's permission dialog does.

It is not shipped because `tests/unit/polling/auto-yes-dialog-gate.test.ts`
enumerates every `.txt` under `fixtures/`, classifies each one, and pins the
answerable dialogs by list equality. Adding a dialog capture here is therefore a
change to that file, and the verdict it would add is one the 1.0.80 permission
dialog already carries — so the -1 assertions in
`tests/unit/detection/tools/copilot/chrome-1082-2269.test.ts` and
`tests/unit/lib/polling/response-checker-copilot-1082-2269.test.ts` read off
`copilot-live-1885/permission-dialog.txt` instead.
