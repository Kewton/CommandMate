# codex paste-placeholder composer frames (Issue #3937)

**合成（synthetic）。** None of these frames was captured from a live codex.
`variants.json` holds one replacement composer row per frame; a frame is
`tests/fixtures/long-body-2464/codex-pasted-content.capture` (codex-cli 0.154.0,
200x1000, `capture-pane -p -e`, taken 2026-09-11 — see that directory's README)
with its composer row `› [Pasted Content 12288 chars]` (the row containing
`replaces`) swapped for that row. Every other row, ANSI attributes included, is
the live capture unchanged. The test
(`tests/unit/lib/session/composer-clear-codex-paste-token-3937.test.ts`) builds
the frames in memory.

They are kept as rows rather than `*.capture` files on purpose: every `*.txt` /
`*.capture` under a `codex` path is a capture that
`tests/unit/lib/detection/codex-verdict-corpus.test.ts` pins a live verdict for,
and these are not captures.

The replacement row keeps the live row's glyph (`ESC[1m›ESC[0m `) and, where it
draws a real placeholder, the live placeholder's colour (`ESC[38;5;6m … ESC[39m`).
Text standing for something the user typed is drawn without attributes.

| Key | Composer row (after the glyph) | Stands for |
|------|--------------------------------|------------|
| `token-only` | cyan `[Pasted Content 3575 chars]` | The frame left behind on 2026-10-25 (codex 0.164.0, `composer-clear:not-cleared {"passes":12,"state":"content"}`), with that run's count. |
| `token-then-typed` | cyan placeholder + ` and one more line` | A placeholder with typed text after it. |
| `two-tokens` | cyan `[Pasted Content 3575 chars]` + cyan `[Pasted Content 120 chars]` | Two pastes. |
| `quoted-among-text` | plain `see [Pasted Content 600 chars] above` | A body quoting the placeholder's wording among other text. |
| `quoted-exact` | plain `[Pasted Content 600 chars]` | A body that is nothing but that wording, typed out. |
| `quoted-exact-bspaced` | plain `[Pasted Content 600 chars` | `quoted-exact` after one `BSpace`. |

What a live codex 0.164.0 draws for these cases — and whether `C-e`+`BSpace`
removes a placeholder whole there — has not been captured (no live codex could
be run for #3937). Replace these with live captures, taken the same way as
`long-body-2464/` (private `tmux -L` server, 200x1000, `capture-pane -p -e`),
when that is measured.
