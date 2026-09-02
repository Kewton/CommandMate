# claude-live-2247 — raw Claude Code frames around the startup-banner guard

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/polling/response-checker-claude-banner-2247.test.ts` (Issue #2247).

**These files are raw on purpose. Do not strip ANSI from them.** `boot-banner.txt`
is only a fair negative case while its composer row keeps its `ESC[2m` ghost
suggestion: after `stripAnsi` that row is byte-identical to a transcript echo
(#1879), which is precisely the trap the guard has to survive. A stripped fixture
would let a pane-wide echo scan pass this suite while putting the banner back
into History.

## Provenance

| | |
|---|---|
| Captured | 2026-09-03 |
| Agent | Claude Code v2.1.258 |
| Pane geometry | 200x1000 (production layout; the default size does not reproduce the footer structure) |
| Session | `probe` on a private tmux server (`tmux -L cm2247`) over a scratch directory, killed afterwards |
| Command | `tmux capture-pane -p -e -t probe` |

Redacted, and nothing in the suite reads either: the scratch cwd was replaced
with `~/cm2247-probe`, and the session id in the status row's OSC 8 hyperlink
with `session_REDACTED`. Every other byte is verbatim.

## The frames

| File | Turn | What `extractResponse(raw, 0, 'claude', 1000)` must say |
|---|---|---|
| `boot-banner.txt` | none — the session has just been trusted | `isComplete: false`. The transcript is the banner (`Claude Code v2.1.258`) and the only `❯ …` row on the pane is the footer's dim ghost |
| `turn-github-release.txt` | 1 | `isComplete: true`, body opens `GitHub Release v0.30.0 …` — **the frame from the incident**, 148 chars, caught by the old bare `v\d+\.\d+` |
| `turn-version-v12.txt` | 2 | `isComplete: true` — `リリース v1.2 のタグを打ちました`, same anchor, shortest form |
| `turn-table.txt` | 3 | `isComplete: true` — a two-row markdown table, which Claude Code draws with `│`, the glyph the old `hasBannerArt` shared with the banner |
| `turn-tip.txt` | 4 | `isComplete: true` — a reply quoting `Tip: Use /help for shortcuts`, i.e. `hasStartupTips` |

The three turn frames are cumulative: each one is the same pane after one more
exchange, so `turn-tip.txt` still carries all four echoes and all four replies.
That is why every assertion runs `extractResponse` with `lastCapturedLine = 0`,
which anchors on the NEWEST echo and reads only the last turn.

Measured on these frames, before the fix (all five returned `isComplete: false`):

| Frame | echo index | `hasBannerArt` | `hasVersionInfo` | `hasStartupTips` | response length |
|---|---|---|---|---|---|
| `boot-banner` | -1 | false | true | false | 253 |
| `turn-github-release` | 6 | false | true | false | 148 |
| `turn-version-v12` | 12 | false | true | false | 106 |
| `turn-table` | 18 | true | false | false | 195 |
| `turn-tip` | 30 | false | false | true | 135 |
