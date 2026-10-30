# Command Code の上寄せ Plan review（200x1000）— Issue #4000

ターミナル面が真っ黒に見えた件（#4000）のテスト用 fixture。

## Provenance — live capture ではない

| | |
|---|---|
| 観測 | 2026-10-30、計画レビュー中の稼働セッション（CommandMate 0.49.0）。tmux の画面は 200x1000、`history_size=0`・`cursor_y=175`。内容は上から 175 行、その下は空 |
| 本文 | 観測した計画の本文・プロジェクト名は使っていない。中立の文面（`sample.js` に `clamp` を足す計画）を node で生成した |
| 構造 | [`../command-code-plan-review-2763/plan-review-short.txt`](../command-code-plan-review-2763/plan-review-short.txt)（1.58.0 の live capture）と同じ並び: 200 桁の罫線 / 空行 / `Plan review: …` / `Review the plan like a PR …` / 空行 / 番号つきの本文 / 空行 / 罫線 / 空行 / ` REVIEW` / `Approve ctrl+a   executes the plan` / `Cancel esc` / 空行 / `type + enter to comment · …` |
| 高さ | 内容 175 行 + 空行 825 行 = 1000 行（末尾に改行 1 つ。2763 の fixture と同じ）。本文に 3 行以上続く空行は無いので、空行を詰めると 175 行ちょうどになる |
| ANSI | 無し（2763 と同じく plain）。背景で塗った行の対照は `../command-code-live-2250/` などの raw の fixture で行う |

| file | 内容 |
|---|---|
| `plan-review-top-anchored-200x1000.txt` | 上寄せの REVIEW 画面。最後の内容行は `type + enter to comment · …` |
