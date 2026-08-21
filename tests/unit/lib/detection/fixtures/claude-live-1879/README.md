# claude-live-1879 — raw composer frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/detection/composer-text.test.ts` (Issue #1879).

**These files are raw on purpose. Do not strip ANSI from them.** After
`stripAnsi`, Claude Code's dim suggestion text is byte-identical to text a human
typed — that is the whole defect the extraction exists to prevent, so a stripped
fixture would let a broken extractor pass every ghost assertion in the suite.
`composer-text.test.ts` asserts the `ESC[2m` sequences are still present, and
fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-21 |
| Agent | Claude Code v2.1.238 |
| Pane geometry | 200x1000 (production layout; the default size does not reproduce the footer structure) |
| Session | `cm1879-probe`, a disposable detached session over a scratch directory, killed afterwards |
| Command | `tmux capture-pane -p -e -t '=cm1879-probe:'` |

## The frames

| File | Composer row (`cat -v`) | `cursor_x` | Expected |
|---|---|---|---|
| `composer-empty.txt` | `^[[39m❯<NBSP>` | 2 | `empty` |
| `composer-ghost-suggestion.txt` | `^[[39m❯<NBSP>^[[2mTry "how do I log an error?"^[[0m` | 2 | `ghost` |
| `composer-residual-plain.txt` | `^[[39m❯<NBSP>echo PREFILLED` | 16 | `content` — `echo PREFILLED` |
| `composer-residual-slash.txt` | `^[[39m❯<NBSP>^[[38;5;153m/cost^[[39m` | 7 | `content` — `/cost` |
| `composer-residual-multiline.txt` | `^[[39m❯<NBSP>RESIDLINE1` + `  RESIDLINE2` | 12 | `content` — two rows |

`cursor_x` was read with `tmux display-message -p '#{cursor_x}'` at capture time
and is recorded because #1878 identified it as the *other* viable discriminator
(2 means the buffer is empty). It is not used by the implementation — the SGR
attribute is, because it costs no extra tmux round-trip and can be applied to a
frame after the fact — but it independently corroborates every row above.

Two measured details that a hand-written fixture would get wrong:

- the character between `❯` and the text is **U+00A0 NO-BREAK SPACE**, not an
  ASCII space;
- the residual `/cost` row is coloured with `ESC[38;5;153m`, whose *argument*
  contains no dim code but whose introducer (`38;5;…`) must be consumed as an
  extended-colour form — a naive SGR scan reads a stray `2` in `38;2;…` and calls
  real input a ghost.

## `composer-ghost-history-1878.txt`

The one file here that is **not** a verbatim capture. It is
`composer-empty.txt` with the composer row replaced by the exact bytes
transcribed in the #1878 measurement report
(<https://github.com/Kewton/CommandMate/issues/1878#issuecomment-5367721372> §4):

```
^[[39m❯ ^[[2mecho PREFILLED/clear^[[0m      (cursor_x = 2)
```

That report observed Claude's *history-derived* suggestion; the live probe for
this Issue only ever produced the rotating hint form
(`composer-ghost-suggestion.txt`). Both are dim, both sit in an empty buffer, and
both must be excluded, so this frame is kept to cover the longer form and the
ASCII-space gutter that report's transcription carries.
