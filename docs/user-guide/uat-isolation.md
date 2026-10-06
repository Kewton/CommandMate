# UAT・日次確認の隔離（`CM_UAT_ISOLATION=1`）

UAT や日次の実機確認で CommandMate のサーバーと CLI を動かすとき、ポート・DB・tmux・状態ディレクトリは `scripts/uat/run-server.sh`（`.commandmate/uat.yaml` の `env.up` / `env.down` が呼ぶ。Issue #3359）で本番から分けている。それだけでは分けられない経路が 3 つあり、どれも利用者のログインに結び付いた場所にある（Issue #3360）。

1. **codex の共有ファイル** — `$CODEX_HOME/hooks.json`、relay（`$CODEX_HOME/commandmate/cmate-agent-event.sh`）、`config.toml` の hook の信頼。`CODEX_HOME` を移すと codex がログアウトする。
2. **claude の利用者の hook** — `--settings` は `~/.claude/settings.json` に足されるだけで、置き換わらない。`CLAUDE_CONFIG_DIR` を移すと claude がログアウトする。
3. **CLI の設定** — グローバルの CLI は cwd に関係なく `~/.commandmate/.env` を読む。何も指定しないと既定のポート 3000（本番）に送る。

`CM_UAT_ISOLATION=1` を付けて起動したサーバーと CLI は、次のように動く。付けないときの動きは変わらない（`1` 以外の値は付けないのと同じ）。

| 対象 | `CM_UAT_ISOLATION=1` のときの動き |
|------|----------------------------------|
| codex の `hooks.json` と relay | 書かない。本番が書いたものが、このビルドが空のファイルに書く内容とバイト単位で同じ（CommandMate の hook だけ）なら、そのまま使う（送り先は起動時の環境変数 `CM_HOOK_URL` で UAT のサーバーになる）。違えば**起動を拒否する**（セッションの開始が `CM_UAT_ISOLATION=1: refusing to start codex …` で失敗する）。利用者が独自に足した hook が混ざっている場合も拒否する（本番へ直接送る hook もありうるため。拒否の文がその理由を言う）。素の codex も共有の `hooks.json` を読むので、「hook なしで起動」すると本番の信頼済みの hook が動いてしまうため。`CM_AGENT_HOOKS_INJECT=0` との組み合わせも同じ理由で拒否する |
| codex の hook の信頼 | 信頼を与えない（与えると codex が `config.toml` に書く）。確認の画面が出たら「信頼せずに続ける」で答え、そのセッションは hook なしになる |
| antigravity の `~/.gemini/config/hooks.json` | 書かない。CommandMate の hook だけで同じ内容が既にあれば使い、無い・違う・独自の hook が混ざっていれば**起動を拒否する**（agy は共有のファイルを必ず読むため。codex と同じ理由） |
| copilot の `~/.copilot/settings.json` | 書かない（`.cmate-backup` もロックのファイルも作らない）。このビルドが空のファイルに書く内容とバイト単位で同じ（CommandMate の hook だけ）なら、そのまま使う（相関キーとポートは起動時の環境変数で渡るので、送り先は UAT のサーバーになる）。無い・違う・独自の hook（や他のキー）が混ざっている、または copilot の `config.json` に `hooks` がある（copilot が起動時に `settings.json` へ移して上書きする）・読めない場合は**起動を拒否する**（素の copilot も共有のファイルを必ず読むため。codex と同じ理由）。拒否は tmux のセッションを作る前に判定する。`CM_AGENT_HOOKS_INJECT=0` との組み合わせも拒否する（Issue #3391） |
| claude | `--setting-sources project,local` を付けて起動する。利用者の `settings.json`（hook とプラグインを含む）は読まれず、CommandMate の `--settings` とリポジトリの `.claude/settings*.json` は読まれる。Schedule と日次まとめの `claude -p` にも同じ制限を付ける |
| Schedule・日次まとめの `codex exec`・`agy -p` | **実行を拒否する**（実行結果は failed、エラーは `CM_UAT_ISOLATION=1: refusing to start a headless codex run …`）。どちらも共有の `hooks.json` を必ず読み、非対話の実行には送り先（`CM_HOOK_URL`）も相関キーも渡らないので、hook は relay の既定（`CM_PORT`、無ければ 3000 = 本番）へ送る。実行ごとに hook を止める口も送り先を変える口も無い |
| CLI（`ApiClient` を使うコマンド） | `.env` を一切読まない。`CM_PORT` が無ければ 3000 に送らず exit 2 で止まる |

## 手順

サーバーは `scripts/uat/run-server.sh up` が起動する（`env -i … CM_UAT_ISOLATION=1 …`）。`.commandmate/uat.yaml` の `env.up` も、日次の実機確認（#3312）もこれを呼ぶ。`.commandmate/uat.yaml` の `isolation.checks` が、動いているサーバーの環境に `CM_UAT_ISOLATION=1` があることを確かめる。`up` は起動の前に codex の `hooks.json`・relay と antigravity の `~/.gemini/config/hooks.json`、copilot の `~/.copilot/settings.json` のハッシュ（無いファイルは `absent`）を `{run_dir}/codex-shared.sha256` に記録し、`run-server.sh down` が比べて、変わっていれば失敗する（書き戻さない）。

CLI は、同じビルドの CLI を絶対パスで呼び、クライアント用の HOME を分け、送り先を `CM_PORT` で固定する。

```bash
mkdir -p "$RUN_DIR/client-home"
env -i HOME="$RUN_DIR/client-home" PATH="$PATH" CM_UAT_ISOLATION=1 \
  CM_PORT="$UAT_PORT" CM_BIND=127.0.0.1 \
  node "$WORKTREE/bin/commandmate.js" ls --json
```

- グローバルの `commandmate` は使わない（別のビルドで、`~/.commandmate/.env` を読む）。
- HOME を分けるのは、CLI が `$HOME/.commandmate-security.log` を書くことがあるのと、グローバルの CLI が `$HOME/.commandmate/` を作るため。
- `--base-url` という CLI のオプションは無い。送り先を決める既存の口は `CM_PORT` と `CM_BIND`（エクスポートした値が `.env` より優先）。

## 測定の結果（2026-10-05、claude 2.1.289 / codex-cli 0.160.0）

私設の tmux（`tmux -L`）と使い捨ての場所（`/tmp`）で測った。利用者の `~/.claude*`・`~/.codex`・`~/.commandmate` を書き換えるおそれのある測り方はしていない。その場合は「測れない」と書いた。

| ツール | 場所 | 測ったこと | 結果 | 隔離 |
|--------|------|------------|------|------|
| claude | 利用者の `settings.json` の hook | 一時の `CLAUDE_CONFIG_DIR` に user・project・`--settings` の 3 か所へ印を出す hook を置き、`claude -p` を `--setting-sources` を変えて実行 | `user,project,local`: 3 つとも動いた / `project,local`: project と `--settings` だけ / `local`: `--settings` だけ。ログインが無くても `SessionStart` と `UserPromptSubmit` の hook は動いた | できる（`--setting-sources project,local`） |
| claude | 認証（`CLAUDE_CONFIG_DIR` を移す） | 対話の起動を私設の tmux で | テーマ選択の後に「Select login method」。`-p` は「Not logged in」 | できない（設定の場所は移せない） |
| claude | 認証（`--setting-sources project,local`、設定の場所はそのまま） | — | 測れない（本物のログインで起動すると `~/.claude.json` と `~/.claude/projects/` に書く）。認証は設定の source ではなく設定の場所（キーチェーン）で決まるので、保たれると見ている。上の 3 回の `-p` はどれも同じ認証エラーで、source の選び方が認証を変えないことは確かめた | できる（推定） |
| claude | 利用者の `settings.json` の hook 以外 | 読んだだけ | 利用者の `settings.json` にある `model`・`enabledPlugins` なども読まれなくなる。モデルは既定のものになる（`--model` を付ければそれ） | 副作用あり |
| codex | `$CODEX_HOME/hooks.json` | このビルドが作る内容と、今のファイルを読んで比べた | 一致（本番がすでに同じ内容を書いている） | できる（書かずに使う） |
| codex | relay | `cmp` | 同梱の relay と一致 | できる（書かずに使う） |
| codex | `config.toml` の hook の信頼 | 読んだだけ | `hooks.json` の 5 つの event に `trusted_hash` がある。ハッシュが今の内容に合っているかは読むだけでは分からない | できる（信頼を与えない。合っていなければ hook なし） |
| codex | hook が UAT のサーバーに届くか | — | 測れない（本物の codex は `~/.codex` に履歴やセッションを書く。`CODEX_HOME` を移すとログアウトし、資格情報の複製はしない）。`hooks.json` に送り先は無く、relay は `CM_HOOK_URL` を先に見る（`scripts/hooks/cmate-agent-event.sh`）。起動計画は `CM_HOOK_URL` を UAT のポートにする（単体テストで確認） | できる（設計上） |
| codex | `config.toml` のフォルダの信頼、`version.json` | コードを読んだ | 「このディレクトリを信頼するか」に `1`、更新の知らせに `3` を押すと、codex 自身が書く | できない |
| antigravity | `~/.gemini/config/hooks.json` | コードを読んだ | relay を checkout のパスで書くので、worktree のビルドの内容は本番のものと違う | できる（書かない。worktree のビルドでは実際には起動を拒否する） |
| copilot | `~/.copilot/settings.json` | コードを読んだ | relay を checkout のパスで書くので、worktree のビルドの内容は本番のものと違う | できる（書かない。worktree のビルドでは実際には起動を拒否する） |
| CLI | `~/.commandmate/.env` | worktree のビルドの CLI を、一時の HOME に `CM_PORT=3996` の `.env` を置いて実行 | 読まなかった（worktree のビルドは cwd の `.env` を読む）。`CM_PORT` も `.env` も無いと 3000 に送った | できる（HOME を分け、`CM_UAT_ISOLATION=1`） |
| CLI | 送り先 | `CM_PORT` をエクスポートして実行 | エクスポートした値が `.env` より優先 | できる |

測定の途中で、`CM_PORT` も `.env` も無い状態の `ls --json` が本番（3000）に GET を 1 回送った。読み取りだけで、書き込みは無い。`CM_UAT_ISOLATION=1` のときに 3000 へ落ちないようにしたのは、これが理由である。

## skip にする条件（#3312 の設計が使う）

| 場面 | skip にする条件 |
|------|----------------------------------------|
| codex の場面すべて（起動の拒否） | codex のセッションの開始が `CM_UAT_ISOLATION=1: refusing to start codex` で失敗した（サーバーのログに `codex-hooks-shared-absent-readonly`・`codex-hooks-shared-differs-readonly`・`codex-hooks-shared-foreign-readonly`・`codex-hooks-shared-relay-differs-readonly` のどれかも出る）。共有の `hooks.json` か relay が無い・このビルドと違う・独自の hook が混ざっているので、本番と同じビルドで UAT するまで codex の場面は動かせない |
| codex の hook を見る場面 | hook の確認の画面が出た（信頼が合っていない）。信頼せずに続けるので、そのセッションの hook は動かない。画面の読み取りだけで判定できる場面に限る |
| codex の場面すべて | `~/.codex` の変化を一切許さない確認では skip。codex 自身が `config.toml` にフォルダの信頼（`{run_dir}` の下のパス）を、`version.json` に更新の知らせへの答えを書くのは防げない。`hooks.json` と relay の変化は `run-server.sh down`（`env.down`）が検出する |
| antigravity の場面すべて（起動の拒否） | antigravity のセッションの開始が `CM_UAT_ISOLATION=1: refusing to start antigravity` で失敗した（サーバーのログに `antigravity-hooks-config-differs-readonly` も出ることがある）。共有のファイルは relay を checkout のパスで書くので、worktree のビルドではほぼいつもこうなる |
| copilot の場面すべて（起動の拒否） | copilot のセッションの開始が `CM_UAT_ISOLATION=1: refusing to start copilot` で失敗した（サーバーのログに `copilot-hook-settings-absent-readonly`・`copilot-hook-settings-differs-readonly`・`copilot-hook-settings-foreign-readonly`・`copilot-hook-config-json-readonly` のどれかも出る）。共有のファイルは relay を checkout のパスで書くので、worktree のビルドではほぼいつもこうなる。`~/.copilot/settings.json` の変化は `run-server.sh down`（`env.down`）が検出する |
| Schedule・日次まとめで copilot を使う場面 | 共有の `~/.copilot/settings.json` に利用者が独自に足した hook があれば skip。非対話の `copilot -p` は拒否されず、共有のファイルを読む。CommandMate の hook は相関キー（`CM_AGENT_WORKTREE_ID`）が無いので何もしないが、独自の hook は動く |
| claude の場面 | 利用者の `settings.json` にある設定（モデル・プラグイン・権限）を前提にする場面は skip。対象のリポジトリの `.claude/settings*.json` の hook は動く（UAT の `{run_dir}/root` のリポジトリには置かない） |
| Schedule・日次まとめで codex・antigravity を使う場面 | いつも skip（隔離中は実行が拒否される）。claude の Schedule は `--setting-sources project,local` つきで動く |
| CLI の場面 | 上の手順で呼ぶ限り skip は無い。グローバルの `commandmate` を呼ぶ場面は作らない |
