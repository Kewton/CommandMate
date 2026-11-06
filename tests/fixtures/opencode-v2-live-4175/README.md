# OpenCode V2 live frames, 80 columns (Issue #4175)

Captured on 2026-11-06 from the real `opencode2` **2.0.18**, pane 80x200, in an
isolated HOME on a private tmux socket, during the UAT of #4159〜#4163 (a GitHub
Copilot model). Copied verbatim — ANSI included — from that run's evidence
(`v2f/`). Checked before copying: no user name and no home path (the footer's
working directory is already shortened by the TUI to `…/i…/4159-4163/uat/run/root/sample:main`).

| File | Source | What |
|---|---|---|
| `long-running.txt` | `long-5.txt` | a long reply being written: footer `⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt  17.9K (2%) · $0.01  ctrl+p commands`; the previous turn's numbers, its `REPOSTAMP` and completion row above the echo |
| `long-done.txt` | `long-40.txt` | the same reply finished, `Build · Claude Sonnet 5.5 · 28.9s · 117.1 tok/s`; the echo has scrolled off except its blank last gutter row |
| `idle-after-turn.txt` | `long-0.txt` | a finished turn whose echo has scrolled off entirely; the session's tab row is the first row |
| `esc-again-running.txt` | `int-1.txt` | after one Esc: footer `⬝⬝⬝⬝■■■■ esc again to interrupt  21.3K (2%) · $0.04  ctrl+p commands`, reply still growing |
| `interrupted.txt` | `int-4.txt` | after the second Esc: `Build · Claude Sonnet 5.5 · 8.5s · interrupted`, footer without the hint |
| `quote-footer-done.txt` | `quote-0.txt` | a finished reply quoting three rows at column 5: `⬝⬝⬝⬝■■■■ esc again to interrupt`, `esc interrupt`, `Ask anything... ctrl+p commands` |

What every frame shows (read by `tests/unit/detection/tools/opencode-v2/pattern-anchors-4175.test.ts`):
the footer is the row right under the composer's `╹▀▀▀` border; the running hint
is on that row and nowhere else; a reply's rows start at column 5.
