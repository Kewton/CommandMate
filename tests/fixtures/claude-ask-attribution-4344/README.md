# Claude Code transcript — 実行中のターンに吸収された入力（Issue #4344）

ask の帰属（`docs/design/ask-attribution-4344.md` §3.2 M1・§7 (a)）の試験に使う 2 本。

**形は実記録から取った**: `queue-operation`（`enqueue` → `remove`、`reason: "absorbed_mid_turn"`）と
`queued_command` の attachment は `tests/fixtures/claude-self-resume-3430/transcript.jsonl`
（Claude Code 2.1.293 の実 transcript、30・33・34 行目）と同じフィールド・同じ並び。
複数行の送信を `<pasted_content id="…">` で包む形は Issue #3102 の実測（`claudePastedContentPrompt`）。
本文・uuid・時刻・askId は試験のために書いた値（実機の採取ではない）。

| ファイル | 中身 | 期待 |
|---|---|---|
| `absorbed-ask.jsonl` | ask A（封筒つき・paste）のターン中に ask B（封筒つき）が吸収された | A は `ambiguous/shared_turn`、B は `unmatched/absorbed_mid_turn` |
| `absorbed-notice.jsonl` | ask A のターン中にバックグラウンドの `<task-notification>` だけが吸収された | A は `matched`、`notified: true`（§7 (a) の決定 ②） |

- session id は `00000000-0000-4000-8000-000000004344`、`cwd` は `<CWD>`（試験が一時ディレクトリに置き換える）
