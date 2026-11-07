# Claude Code 2.1.318 の「Make auto mode your default permission mode?」（Issue #4134）

API キー経路と確定モデル（課金なしのモック）、隔離の HOME、`tmux -L`、200x50、`capture-pane -e -p`。`~/.claude/settings.json` に `{"permissions":{"defaultMode":"default"}}` がある HOME で出た。無い HOME では出ない（説明の帯だけ）。

- `cursor-yes.txt`: 出た直後。カーソルは `Yes`
- `cursor-no.txt`: `Down` の後

測ったキーの動き: 数字は効かない。`Down` → `Enter` で閉じ、入力欄が出る。`settings.json` は変わらず、`~/.claude.json` に `hasSeenAutoDefaultNudge: true` が書かれる。

`defaultMode` が `acceptEdits` のときは選択肢が `No, keep accept edits` になる（`mode` が付かない）。

出る条件（2.1.318 の実行ファイルの `CPo`）: オンボーディング済み、`hasSeenAutoDefaultNudge` なし、利用者の設定の `permissions.defaultMode` が `auto` 以外で在り、プロジェクト・ローカル・フラグ・ポリシーの設定に `defaultMode` が無く、自動モードが使える。認証の経路は条件に無い。OAuth の経路では実機で確かめていない。
