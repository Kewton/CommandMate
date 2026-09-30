# codex 0.157.1 の起動直後の更新ダイアログ、実測（Issue #3020）

日次確認（agent-health）の `screen-idle` が 2026-09-30 に codex で fail した画面そのもの。
codex は `$CODEX_HOME/version.json` に自分より新しい `latest_version` が載っていて、それを
`dismissed_version` で見送っていないと、composer の代わりにこの更新ダイアログで起動する。
0.157.1 で新しく出るようになったのではない（0.149.1 の `tests/fixtures/codex-update-dialog-2068/` と同じ仕組みで、
0.157.1 では文言が `Update available · a → b`・フッタ `enter continue · esc skip` に変わった）。
新しい版（0.159.1）が出た日から、確認が起動画面としてこのダイアログを撮るようになった。

**raw のまま置いている。ANSI を剥がさないこと**（agent-health は `capture-pane -p -e` で撮る）。
読むテストは `tests/unit/scripts/agent-health/codex-update-dialog-3020.test.ts`。

## Provenance

| | |
|---|---|
| build | codex-cli **0.157.1**（`npm install --prefix <scratchpad>/npm @openai/codex@0.157.1`。グローバルの codex には触れていない） |
| 採取日時 | 2026-09-30 09:54 JST |
| tmux | 私設ソケット `tmux -L cm3020 -f /dev/null`、`new-session -d -s probe -x 200 -y 1000`。`display-message '#{pane_width}x#{pane_height}'` で **200x1000** を実測。終わったら `-L cm3020 kill-server` |
| 環境 | `env -i HOME=<scratchpad>/home CODEX_HOME=<scratchpad>/home/.codex NPM_CONFIG_PREFIX=<scratchpad>/npm-global`。利用者の `~/.codex` は使っていない |
| version.json | `{"latest_version":"0.159.1","last_checked_at":<採取時刻>,"dismissed_version":null}` を手で置いた（報告された画面 `0.157.1 → 0.159.1` と同じ状態） |
| 起動 | `codex -c projects.<wt>.trust_level=trusted -c history.persistence=none` |
| 採取コマンド | `capture-pane -p -e -S -1000 -t '=probe:'` |

## 実機で確かめたこと

| 操作 | 結果 |
|---|---|
| そのまま起動 | このダイアログ（`detectSessionStatus` → `waiting` / `prompt_detected`。検出は正しい） |
| `-c check_for_update_on_startup=false` を足して起動 | ダイアログが出ない。`last_checked_at` が古い `version.json` でも書き換えない |
| 上の flag 無しで `last_checked_at` が古いとき | codex が `version.json` を取り直して書き換える（agent-health が利用者の `~/.codex/version.json` を書いていた） |
| ダイアログで `2. Skip`（Down → Enter） | 閉じる。`version.json` は変わらない（`3. Skip until next version` は `dismissed_version` を書く） |
