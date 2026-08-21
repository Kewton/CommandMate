# codex-live-1890 — raw composer frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/detection/composer-text.test.ts` (Issue #1890).

**These files are raw on purpose. Do not strip ANSI from them.** codex draws its
idle placeholder into an *empty* composer with the same dim attribute Claude Code
uses, and it puts its prompt glyph `›` (U+203A) at column 0 in two other places
that are not the composer at all. After `stripAnsi` all four rows look alike, so
a stripped fixture would let a broken extractor pass every assertion in the
suite. The test file asserts the `ESC[2m` sequences are still present and fails
loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-21 |
| Agent | codex-cli 0.148.0 (model `gpt-5.6-sol xhigh`) |
| Pane geometry | 200x1000 (production layout) |
| Session | `cm1890-probe`, a disposable detached session over a scratch git repo, killed afterwards |
| Command | `tmux capture-pane -p -e -t '=cm1890-probe:'` |

## The frames

| File | Composer row (`cat -v`) | `cursor_x` | Expected |
|---|---|---|---|
| `composer-placeholder-ask.txt` | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | 2 | `ghost` |
| `composer-residual-plain.txt` | `^[[1m›^[[0m echo PREFILLED` | 16 | `content` — `echo PREFILLED` |
| `composer-residual-slash.txt` | `^[[1m›^[[0m /status` | 9 | `content` — `/status` (a completion popup has replaced the footer below it) |
| `composer-residual-multiline.txt` | `^[[1m›^[[0m RESIDLINE1` + `  RESIDLINE2` | 12 | `content` — two rows |
| `composer-residual-leading-number.txt` | `^[[1m›^[[0m 1. buy milk` | 13 | `content` — `1. buy milk` |
| `dialog-model-picker.txt` | *(no composer; `^[[1m^[[38;5;6m› 1. gpt-5.6-sol (current)…^[[0m`)* | 200 | `no_composer` |

`cursor_x` was read with `tmux display-message -p '#{cursor_x}'` at capture time
and is recorded because #1878 identified it as the *other* viable discriminator
(2 means the buffer is empty). It is not used by the implementation — the SGR
attributes are, because they cost no extra tmux round-trip and can be applied to
a frame after the fact — but it independently corroborates every row above:
`composer-placeholder-ask.txt` reads 2 with `Ask Codex to do anything` on screen,
which is the direct measurement that the placeholder is not in the buffer.

## Why `composer-residual-leading-number.txt` exists

The dialog rows this reader must reject (`› 1. Yes, proceed (y)`, `› 1. gpt-5.6-sol
(current)`) are numbered options, so "reject `› <digit>. `" looks like a cheap
second guard. It is a wrong one: this frame is a composer holding exactly that
shape, typed by hand, and it must still be `content`. The attribute rule
separates them where the text cannot — the dialog's selected option is **bold**
(`ESC[1mESC[38;5;6m` covering the whole row), a typed `1. buy milk` is not.

## Frames borrowed from earlier Issues

The negative cases that need a full-screen dialog or a scrolled transcript are
already on disk as live captures of the same codex version, and are asserted
from this suite rather than re-captured:

- `../codex-live-1628/approval-run-command.txt`, `approval-apply-patch.txt`,
  `model-picker-step1.txt`, `model-picker-step2.txt` — the composer is off
  screen and a bold `›` option row is the last one in the frame → `no_composer`.
- `../codex-live-1628/idle-ready.txt`, `working.txt` and
  `../codex-live-1671/reported-session-tail.txt` — the other two placeholder
  rotations (`Use /skills to list available skills`,
  `Find and fix a bug in @filename`) → `ghost`.
- `../codex-live-1671/turn-running-command.txt` — a scrolled pane carrying an
  OLD composer row 28 rows above the live one, plus the dim-glyph transcript
  echo of a sent message (`ESC[1;2m› ESC[0mRun the shell command: …`) between
  them. Both must lose to the live composer at the bottom.
