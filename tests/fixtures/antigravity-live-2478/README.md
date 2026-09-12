# antigravity-live-2478 — agy 1.2.1 after a tool turn, and after a plain one

The two frames Issue #2478 is pinned on. agy 1.2.1 stops drawing
`? for shortcuts` on its status row after a turn that used a tool. The send
path's readiness check required that word, so every `send` / `ask` to the
session after the tool turn waited 15 s and failed (`Antigravity prompt not
ready`, CLI exit 99) — while the status detector, which never read the word,
kept calling the same pane `ready`.

Used by `tests/unit/cli-tools/antigravity.test.ts`.

## Provenance

| | |
|---|---|
| Captured | 2026-09-11, during the UAT of #2463 / #2464 / #2472 / #2473 (finding F1) |
| Agent | Antigravity CLI 1.2.1 (`agy`), Gemini 3.8 Flash (High) |
| Pane geometry | 200x1000, on a private tmux server (`tmux -L cmuat2463`) |
| Capture | `tmux capture-pane -p -S -50` — the window `waitForPrompt` reads, but **without `-e`**, so these files carry no ANSI. `isAntigravityReady` strips ANSI before it reads a frame, so the reading is the same; the raw spelling is covered by `../antigravity-live-2364/` |
| Session | launched by an isolated CommandMate server (:3010, develop `ae1b7c33`), hence the `CM_HOOK_URL=… 'agy'` launch rows at the top; Auto-Yes on |

Redacted, and nothing in the suite reads any of it: the shell prompt's
`user@host` (row 3) and the account e-mail in agy's header (row 7) are
placeholders. Every other byte is verbatim, including the blank padding down to
row 1000 — agy is top-anchored, and a frame without that padding exercises a
different window than production reads.

## The frames

| file | how it got there | bottom of the frame | expected reading |
|---|---|---|---|
| `after-tool-turn.txt` | worktree `uat-grace`: `Reply with exactly: OK warmup`, then a turn that ran `git log -1 --format=%s`, `git status --short` and `ls` as three Bash tool calls (Auto-Yes answered all three) | rule / `>` / blank / blank / rule / a status row holding only the right-aligned `Gemini 3.8 Flash · hig` | ready — the frame the pre-#2478 footer rule refused |
| `after-plain-turns.txt` | worktree `uat-body`: `Reply with exactly: OK short`, then a 12 KB / 60-line body with no tools | rule / `>` / rule / `? for shortcuts … Gemini 3.8 Flash · hig` | ready |

Two details the Issue's summary table flattened, read off `after-tool-turn.txt`
itself: the status row is not empty (the model label stays on its right), and
the input box is three rows tall (the `>` row and two blank rows between the
rules). Neither is what the old rule tripped on — only the missing
`? for shortcuts` is — but a rule that wanted the `>` directly on top of the
lower rule would refuse this frame too.

## What is not here

No agy 1.2.1 capture of the other screens the Issue's acceptance names exists in
the repository, and none was taken for it (the change was made under
delegation, without a live agy). The suite reads the real captures that do
exist:

| screen | frame | agy |
|---|---|---|
| generating (`esc to cancel`, spinner, `Generating...`) | `ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13` in `../model-info-captures.ts` | 1.1.13 |
| the folder-trust dialog | `../antigravity-live-2364/trust-dialog.txt` | 1.1.27 |
| selection lists | `../antigravity-live-2364/picker-switch-model.txt`, `popup-slash-commands.txt` | 1.1.27 |
| numbered permission dialogs, `/feedback`'s menu | `../antigravity-live-2364/dialog-*.txt` | 1.1.27 |

Replace them with 1.2.1 captures when those screens are next taken.
