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

更新の案内の後の Enter（Issue #4161。別の日に同じ隔離で測った。`check_for_update_on_startup = true`、`version.json` に新しい版。数字の 0.1 秒後に Enter を tmux で送った。送信の間隔は `sendPromptAnswer` と同じ）:

| 数字 | 次の画面 | Enter の結果 |
|---|---|---|
| `2`・`3` | フォルダの信頼（未信頼のフォルダ） | カーソルが `1. Trust and continue` にあるので確定する。`config.toml` に `trust_level = "trusted"` が書かれ、入力欄まで進む |
| `2`・`3` | hook の確認（信頼済みのフォルダ、`hooks.json` に未確認の hook） | カーソルが `1. Review hooks` にあるので一覧が開く |
| `3` | 空の入力欄（信頼済みのフォルダ、hook なし。この行だけ数字の 0.5 秒後） | 何も起きない |
| `1`（`npm` は `PATH` の偽物） | codex が終了する | 画面は変わらない。Enter はその後ろのプロセス（測定では `sleep`）へ渡る |

`3` は `dismissed_version` を書き、`2` は書かない。この結果から、更新の案内は `answer_only` を宣言して Enter を送らない。信頼と hook の確認は Enter で確定するので保つ。

未確認: サーバー越しの `respond` を実機の画面に打つこと、本物の `npm install` の最中の Enter、`2` の後の空の入力欄、下書きのある入力欄（起動の直後には測っていない）、一覧と詳細での数字。画面は保存していない。
