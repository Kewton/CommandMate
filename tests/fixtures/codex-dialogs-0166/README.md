# codex-cli 0.166.0 の起動時の画面（Issue #4134）

新しい `CODEX_HOME`、確定モデル（課金なしのモック）、隔離の HOME、`tmux -L`、200x50、`capture-pane -e -p`。本番の高さは 1000 だが、判定は下端の行だけを読む。

| ファイル | 画面 | フッター |
|---|---|---|
| `hooks-review.txt` | 確認の 1 枚目（カーソルは 1） | `enter confirm · esc skip` |
| `hooks-review-cursor-2.txt` | `2` を押した後 | 同じ |
| `hooks-list.txt` | hook の一覧（未確認あり） | `t trust all · enter review · esc close` |
| `hooks-detail.txt` | hook の詳細（未確認） | `t trust · esc back` |
| `hooks-detail-trusted.txt` | `t` の後の詳細 | `space/enter toggle · esc back` |
| `hooks-list-trusted.txt` | `t` の後の一覧 | `enter details · esc close` |
| `trust.txt` | フォルダの信頼 | `enter continue · esc back` |
| `update.txt` | 更新の案内（`version.json` を置いて出した） | `enter continue · esc skip` |
| `ready.txt` | 確認を済ませた入力欄 | — |

測ったキーの動き:

- 確認の 1 枚目とフォルダの信頼は、数字でカーソルが動くだけで確定しない。Enter で確定する。`2` の後の Enter で `trusted_hash` が 5 件書かれた
- 更新の案内は 0.166.0 でも数字だけで確定する（`3` で `dismissed_version` が書かれる）。フッターが同じ形でも、画面ごとに違う
- 一覧と詳細は `t` の後も閉じない。`esc` で閉じる
