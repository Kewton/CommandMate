# live-2997 — Claude / Codex replies that quote a numbered list, captured live

Input for `tests/unit/detection/tools/live-reply-numbered-list-2997.test.ts`
(Issue #2997).

The frames one directory up are **synthetic** (see `../README.md`). #2991 found
that two of them — `reply-numbered-list-repaint.txt` and
`reply-numbered-list-generating-repaint.txt` — read as `waiting` for claude, and
asked whether that happens on a live pane before opting claude / codex into
`ToolDetectorSpec.requireVouchedPrompt`. These frames are that check.

## Provenance

| | |
|---|---|
| Captured | 2026-09-29 |
| Tools | claude-cli 2.1.284, codex-cli 0.157.1 |
| Isolation | a private tmux server (`tmux -L cm2997probe`), one throwaway `git init` directory per tool under a scratch path, torn down with `kill-server` |
| Pane geometry | 200 x 60 (also re-captured right after resizing to 200 x 1000 and to 120 x 40, to look for a frame taken before the footer was redrawn: none was found) |
| Command | `tmux -L cm2997probe capture-pane -t '=<tool>:' -p -e -S -1000` |
| Post-processing | CSI and OSC 8 (hyperlink) escapes removed, trailing spaces and trailing blank rows trimmed; the user name and the scratch session id replaced length for length |

## Frames

| File | What is on the pane | Verdict |
|---|---|---|
| `claude-trust-dialog-21284.txt` | the workspace trust dialog at launch | `waiting` / `claude_selection_list` |
| `claude-reply-numbered-list-21284.txt` | two finished turns whose replies are `Do you want to proceed?` / `❯ 1. Yes` / `2. No` | `ready` |
| `claude-reply-numbered-list-generating-21284.txt` | the second turn mid-stream, the list already drawn and an essay being written below it | `running` |
| `codex-update-dialog-01571.txt` | the update dialog at launch (`› 1. Update now … / 2. Skip / 3. Skip until next version`) | `waiting` / `prompt_detected`, send refused |
| `codex-trust-dialog-01571.txt` | the folder-access trust dialog | `waiting` / `prompt_detected`, send refused |
| `codex-reply-numbered-list-01571.txt` | a finished reply `Do you want to proceed?` / `❯ 1. Yes` / `2. No` | `ready` |
| `codex-reply-dialog-glyph-01571.txt` | a finished reply in codex's own dialog spelling (`› 1. Yes, continue` / `2. No, quit` / `Press enter to continue`) | `ready` |

Every reply frame keeps the tool's composer below the list, and the composer
is the user-input barrier the generic parser stops at, so no candidate prompt
is found at all. Of 180 claude captures (three turns) and 220 codex captures
(two turns), taken every 0.1–0.5 s including right after a resize, every frame
read `running` or `ready`.
