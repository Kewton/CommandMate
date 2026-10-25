# claude-confirm-live-3791 — the AskUserQuestion confirm page, captured live

Input for Issue #3791 item 2
(`tests/unit/lib/polling/claude-confirm-page-live-shapes-3791.test.ts`).

## Provenance

Every `.txt` is a verbatim `tmux capture-pane -p -e -S -1000` of a live
**claude-cli 2.1.310** session (`--model haiku`), captured 2026-10-24. The
sessions ran on a private tmux socket (`-L cmate-canary-x3791`, `-f /dev/null`)
with a throwaway HOME made by the canary's `scripts/canary/isolated-home.ts`
(removed afterwards, socket file included). Each pane was created at the size in
its file name (`<cols>x<rows>`) with `window-size manual`; nothing was resized
after the session started.

Each session was asked: *"Read the file ask.json in the current directory. Then
call the AskUserQuestion tool exactly once, passing the JSON object in that file
verbatim as the tool input. Do nothing else."*, every question was answered with
`Enter` (option 1), and the frame was captured on the confirm page.

| input | questions |
|---|---|
| `ask.json` | 2 short questions, headers `Goal` / `Scope` |
| `ask-long.json` | 4 questions of about 2,000 characters each, 11–12 character headers |
| `ask-lookalike.json` | 1 question that IS `Ready to submit your answers?`, options `Submit answers` / `Cancel` |

Nothing was rewritten. No row carries an email address or a home path (the
banner shows `~/work/x3791`, inside the throwaway HOME; the Bash approval names
the throwaway HOME's temporary path).

## Files

| file | input | screen | before #3791 |
|---|---|---|---|
| `confirm-200x60.txt` | `ask.json` | the page as #3748 reads it: one-row tab bar, `Review your answers`, one-row question, no footer | page |
| `question-wrapped-24x1000.txt` | `ask.json` | the question wraps: `Ready to submit your ` / `answers?`; headers truncated (`G…`), the tab bar on one row | **not read** |
| `tab-row-wrapped-16x1000.txt` | `ask.json` | the tab bar wraps (`← ☒   ☒   ✔` / ` G…  S…  Submit→`), and so do the heading, the question and option 1 (`❯ 1. Submit` / `     answers`) | **not read** |
| `tab-row-far-above-40x1000.txt` | `ask-long.json` | the tab bar 274 rows above the question; long questions drawn in a ` │ ` gutter and cut with `…` | **not read** |
| `head-cut-40x30.txt` | `ask-long.json` | a pane shorter than the page shows its bottom only: no tab bar, no heading | **not read** |
| `head-cut-200x12.txt` | `ask.json` | as above with `Review your answers` the top row | **not read** |
| `lookalike-askuserquestion-200x60.txt` | `ask-lookalike.json` | an ordinary question asking the sentence (`☐ Confirm`, options 1–4, footer) | not the page |
| `lookalike-bash-approval-200x60.txt` | — | `--permission-mode default`, a Bash approval whose command prints the page's rows | not the page |
| `lookalike-bash-output-quoted-200x60.txt` | — | the same printf's output in the transcript above the idle input box | not the page |

## Not captured

An unknown footer under `2. Cancel`: no session drew one (16 to 200 columns,
12 to 1,000 rows, short and long questions). Claude truncates long headers
(`G…`, `Ar…`) instead of wrapping the tab bar at 24 and 40 columns, so the
synthetic wrapped bar of `../claude-confirm-missed-3770/` is not a shape Claude
draws either.
