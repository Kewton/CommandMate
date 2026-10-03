# Command Code 1.74.0 の Plan review（REVIEW 画面）— Issue #3125

`commandmate respond` / `send` がこの画面にコメントを届けられなかった件（#3125）のテスト用 fixture。

## Provenance — live capture ではない

| | |
|---|---|
| 観測 | #3059 の実機確認（Ubuntu 24.04 コンテナ、CommandMate develop `4df4e921`、Command Code **1.74.0**）で、REVIEW 画面の下部を目視で書き写した文言 |
| 本文 | plan 本文・ヘッダ・罫線・ペインの高さ（200x1000、上端寄せ、末尾は空行）は [`../command-code-plan-review-2763/plan-review-short.txt`](../command-code-plan-review-2763/plan-review-short.txt)（1.58.0 の live capture）をそのまま借りた |
| 下部 | `REVIEW` バッジ・アクション行・ヒント行だけを 1.74.0 の観測文言に合わせた（下の表）。1.58.0 と 1 バイトも違わなかったので、`initial` の下部は 1.58.0 と同じバイト列である |
| 作り方 | `plan-review-short.txt` を node で 1 行ずつ書き換えた（コメントの `●` / `↳` 行の位置と書式は 2763 の `plan-review-comment-pinned.txt` に従う）。サーバ・tmux・Command Code は動かしていない |

| file | 観測した 1.74.0 の下部 |
|---|---|
| `plan-review-1-74-0-initial.txt` | ` REVIEW` / `Approve ctrl+a   executes the plan` / `Cancel esc` / `type + enter to comment · quick: ? why  x cut  ! risky · ctrl+g $EDITOR` |
| `plan-review-1-74-0-one-comment.txt` | ` REVIEW   1 pending comment` / `Submit review (1) ctrl+r   agent revises the plan, returns it for review` / `Approve ctrl+a   executes the plan · comments go along as notes` / `Cancel esc`。ヒント行は観測に無いので 1.58.0 の `type + enter to comment · ctrl+n/p jump comments · …` を置いた |

## 1.74.0 で観測された振る舞い（修正前）

- `wait` は `{"type":"selection_list","question":"command_code_plan_review","options":[]}` で exit 10
- `respond <id> "<text>" --instance command-code` は `prompt_no_longer_active`（キーは何も送られない）
- `send <id> "<text>" --instance command-code` は composer を待って `Command Code prompt not ready: timed out waiting for the composer before sending`
- 回避は tmux ペインに直接コメントを打って `ctrl+r`（Submit review）、2 回目の REVIEW は `Esc`

実機の確認（キーが本当に効くか）はオーケストレーターが行う。ここに live capture を足すときは、
2763 の README の Provenance 表の形式で採取条件を書くこと。
