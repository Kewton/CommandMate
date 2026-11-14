# UAT・日次確認の隔離（`CM_UAT_ISOLATION=1`）

UAT や日次の実機確認で CommandMate のサーバーと CLI を動かすとき、ポート・DB・tmux・状態ディレクトリは `scripts/uat/run-server.sh`（`.commandmate/uat.yaml` の `env.up` / `env.down` が呼ぶ。Issue #3359）で本番から分けている。それだけでは分けられない経路が 3 つあり、どれも利用者のログインに結び付いた場所にある（Issue #3360）。

1. **codex の共有ファイル** — `$CODEX_HOME/hooks.json`、relay（`$CODEX_HOME/commandmate/cmate-agent-event.sh`）、`config.toml` の hook の信頼。`CODEX_HOME` を移すと codex がログアウトする。
2. **claude の利用者の hook** — `--settings` は `~/.claude/settings.json` に足されるだけで、置き換わらない。`CLAUDE_CONFIG_DIR` を移すと claude がログアウトする。
3. **CLI の設定** — グローバルの CLI は cwd に関係なく `~/.commandmate/.env` を読む。何も指定しないと既定のポート 3000（本番）に送る。

`scripts/uat/run-server.sh up` は、サーバーのデータベースのほか `CM_OPENCODE_V2_DIR`・`CM_AGENT_HOOKS_DIR`・`CM_AGENT_ROLE_ARTIFACTS_DIR`・`CM_OPENCODE_SESSION_FILE`・`CM_OPENCODE_PORT_FILE` を run の下へ向ける。`.commandmate/uat.yaml` と `.commandmate/uat-own-home.yaml` の検査はこれを動いているプロセスの環境（`ps eww`）で確かめる。ロールの生成物は `~/.commandmate/agent-roles` に増えない。opencode（V1）の記録は `~/.commandmate/opencode-sessions.json`・`opencode-ports.json` に書かない。本物のこの 2 つのハッシュも `up` が記録し、`run-server.sh down` が比べて `uat-run.state` の `opencode_v1_real_changed=yes|no` に残すが、不合格にはしない（同じマシンの本番のサーバーも書くので、変わっても誰が書いたかは言えない）。日次の確認（`scripts/agent-health`）の V1 は起動の行を組むだけで、この 2 つに書く処理を通らないので、移していない。

`CM_UAT_ISOLATION=1` を付けて起動したサーバーと CLI は、次のように動く。付けないときの動きは変わらない（`1` と `own-home` 以外の値は付けないのと同じ。`own-home` は末尾の節）。

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

### run-server.sh を通さずに手で立てるとき

`scripts/uat/run-server.sh up` は以下の隔離をすべて済ませている。probe などで、サーバー・tmux・CLI を手で立てるときだけ読む。

#### 環境は `env -i` で全部渡し、動いているプロセスで確かめる

- 作業のシェルには本番の `CM_PORT`・`CM_DB_PATH`・`CM_ROOT_DIR`・`NODE_ENV` などが export されていることがある。最初に `env | grep '^CM_'` を見る。`scripts/load-env.sh` も dotenv も既にある変数を上書きしないので、worktree に `.env` を書いても本番の値が勝つ。「別のポートで動いた」は別の DB の証拠にならない。
- 起動は要る変数を全部書く（`env -i HOME="$HOME" PATH="$PATH" … CM_PORT=<port> CM_BIND=127.0.0.1 CM_DB_PATH=<run>/uat.db CM_ROOT_DIR=<run>/root node dist/server/server.js`）。`dist/server/server.js` は `npm run build:all` で作られる（`npm run build` だけでは無く、起動してすぐ落ちる）。dev モード（`tsx server.ts`）は `NODE_ENV=development` を明示する（シェルの `NODE_ENV=production` を拾うと production の build を探して落ちる）。隔離の worktree の `npm install` には `--include=dev` を付ける。
- `CM_DB_PATH` は、worktree のビルドでは `/tmp` などのシステムディレクトリだと起動が失敗する（グローバルの CLI では HOME の下でないと失敗する）。run の下（worktree の中）に置く。
- 確かめるのは設定ではなくプロセス。`ps eww -p <pid> | tr ' ' '\n' | grep -E '^(CM_|TMUX|HOME|NODE_ENV)'` で渡った値を、`lsof -p <pid> | grep -E '\.(db|sqlite)'` で開いている DB を見る。`GET /api/repositories` が使い捨てのリポジトリだけを返すことも確かめる。起動ログの `scheduleCount: 0` は DB が開けずに落ちたときにも出るので証拠にしない。本番の DB の mtime は WAL のため書き込みがあっても動かないことがあり、弱い証拠にとどまる。
- YAML に複数行の shell を書くとき、`>-`（折り畳み）で継続の行を深く字下げすると改行が残る。`env -i …` が単独の行になり、以降が呼び出し側の環境で動く（元から export 済みの `CM_*` で DB は隔離されて見え、`TMUX` などだけが本番に漏れる）。`|` と明示の `\` 継続で書き、先頭に `set -e` を置く。

#### 本番の DB を UAT のサーバーに読ませない

- 本番の DB を丸ごとコピーして読ませない。起動時の同期がコピーの中のリポジトリを走査して本番の worktree を復活させ、保存されたタイマーのメッセージが同じ名前の tmux セッションへ送られうる。
- 実データで画面を確かめたいときは、空の DB で起動し、使い捨てのリポジトリ（`<run>/root` の下に `git init`。稼働中の tmux セッションと名前が衝突しないもの）を scan する。止めてから本番の DB を `mode=ro` で開き、対象の行だけを worktree id を付け替えてコピーし、起動し直す。元の worktree id を名乗らせない（tmux のセッション名が稼働中のものと一致する）。
- `CM_ROOT_DIR` の外のリポジトリは scan が拒否する（`outside-roots`）。本番のリポジトリに `git worktree add` して使わない（本番の同期に拾われ、同じ worktree id・同じ tmux セッション名になる）。

#### tmux は私設のサーバーを通常の環境で起こす

- 私設の tmux サーバー（`tmux -S <sock>`）を呼び出し側の通常の環境で起こし、CommandMate のサーバーには `TMUX=<sock>,<tmux の pid>,0` を渡す。ペインは tmux サーバーの環境を継ぐ（[opencode-server-live-verification.md](../design/opencode-server-live-verification.md) §4.6）ので、`env -i` で起こした tmux サーバーのペインでは claude が Keychain の資格情報に届かず、ログアウトした状態で上がる。
- `tmux kill-session -t ""` は直近のセッションを消す。keepalive のセッションが消えると私設のサーバーごと落ち、CommandMate のサーバーが作り直した tmux は `env -i` の環境になる。`run-server.sh down` → `up` でやり直す。
- `kill-server` の後もソケットのファイルは残る。`tmux -S <sock> ls` が失敗するのを確かめてから、自分のものだけ消す。
- 新しく `git init` したディレクトリでは claude のフォルダの信頼の画面が出て、既定のカーソルが `❯ No, exit` にある。そのまま `send` すると本文の Enter で claude が終わる。先に私設の tmux で claude を 1 回起動し、カーソルの位置を確かめてから Down → Enter で信頼させる。信頼はパスごと（clone を移したらやり直す）。`~/.claude.json` は手で編集しない（稼働中の claude が同時に書く）。

#### codex をサーバーを通さずに測る

`CM_UAT_ISOLATION=1` のサーバーは、本番が書いた codex の relay がそのビルドと違うと起動を拒否する（上の skip の表）。本番を同じビルドにできないときは、私設の tmux で codex を直接起動する。

- 資格情報（`auth.json` など）を使い捨ての `CODEX_HOME` へ複製しない。利用者の `CODEX_HOME` のまま、hook と記録を止め、送り先を閉じたポートへ向けて起動する。フォルダの信頼は `-c projects.<実パス>.trust_level=trusted`（メモリの上だけで `config.toml` に書かない。パスにドットが無いこと）で越える。

  ```bash
  tmux -L <label> -f /dev/null new-session -d -x 200 -y 1000 -c <repo> \
    'CM_PORT=9 CM_HOOK_URL=http://127.0.0.1:9/none CM_PERMISSION_HOOK_URL=http://127.0.0.1:9/none codex --disable hooks -c "notify=[]" -c history.persistence=none'
  ```

  起動の行を直接渡すとシェルを挟まない（シェルの履歴にも残らない）。
- アイドルのときの C-c で codex が終わり、私設の tmux サーバーごと消える。入力欄を消すのは C-u。
- 残るもの: フォルダの信頼（`-c` で越えなかったとき）、`/model` で選んだモデルと effort（その場で `config.toml` に保存され、後から起動する本番の codex が拾う）、ターンを送ったときの `sessions/` の rollout。利用者全体のファイル（`config.toml`、copilot の `config.json` など）は始める前に控え、終わった後の差分が UAT 由来だけのときに限って戻す（途中で本番が書いた変更を消さない）。

### UAT の組み方

#### CLI の対話を実機で測る

- 対話（`init` など）は stdin が TTY のときだけ動く。パイプで流すと readline が EOF で先に閉じ、対話が途中で黙って終わる（`.env` が作られない）。本物の PTY が要るときは `expect` を使う。
- `start` は、設定の `.env` の値をシェルの export に重ねて子のサーバーに渡す（dotenv はシェルの値を上書きしないが、子には `.env` が勝つ）。表示の URL と実際に待ち受けるポートが食い違いうるので、ポート・URL を触ったら `.env` とシェルの値をわざと食い違わせて実行し、`lsof -nP -iTCP:<port> -sTCP:LISTEN` で待ち受けを確かめる。
- CLI を書き換えたら `npm run build:cli` する（`bin/commandmate.js` は `dist/` を読む）。

#### 公開版（npm）の CLI を測る

- グローバルを上書きしないよう `npm install commandmate@<版> --prefix <dir>` で入れ、`<dir>/node_modules/.bin/commandmate` を呼ぶ（`npm i -g` は稼働中のサーバーの足元を差し替える）。
- 公開版は `$HOME/.commandmate/.env` を読み、`start` ではその値が export した値に勝つ。`HOME=<dir>/home` にして、その下に `.env` を自分で書く。`CM_DB_PATH` は HOME の下でないと失敗するので、HOME を分けたら指定しない（既定がその HOME の下になる）。本番を指して export されていることの多い `CM_ROOT_DIR` は `env -u` で落とす。
- 止めるときは待ち受けの pid を拾い、`lsof -a -p <pid> -d cwd` で cwd を確かめてから止める。`pkill -f commandmate` は使わない（サーバーの cmdline は `node dist/server/server.js` で当たらず、ほかの worktree のサーバーを巻き込みうる）。

#### 振る舞いを変えない変更は変更前のビルドと比べる

整理（refactor）の UAT は「動いた」だけでは弱い。変更前のコミットを別の作業場所でビルドし、2 台目の隔離サーバー（別のポート・別の run）にして同じ操作を流し、出力を文字列で比べる。

- 比べられるもの: `wait` の標準出力の JSON、`send` / `respond` / `wait` の終了コードと文言、`capture --json` のキーと型、画面から送る要求の本文（Playwright の `page.on('request')`）、`/messages` の行（時刻・パス・ANSI をそろえる）。
- 画面の判定は、`tmux capture-pane -e -p` で保存した画面を両方のビルドに通す（各作業場所で `npx tsx <script>.ts` から `detectSessionStatus` を呼ぶ）。タイミングの差が消える。
- 比べられないもの: モデルの文面、共有の資源を取り合うもの（同じローカルモデルなど）。こういうケースは 1 台ずつ順に流す。

#### Skill を開発版の CLI で確かめる

- 親のエージェントが呼ぶ `commandmate` を開発版にするには、`exec node <worktree>/bin/commandmate.js "$@"` の shim を置き、対象リポジトリの `.claude/settings.local.json` の `env.PATH` に、shim の場所を先頭にした PATH を全文で書く（値は展開されない）。親の Bash で `command -v commandmate` が shim を指すことを確かめる。
- 対象のリポジトリは本番の `CM_ROOT_DIR` の外に独立の clone で置き、隔離サーバーの `CM_ROOT_DIR` の下で scan させる。

#### 本物に頼らず状態を作る

- proxy: CLI の `CM_PORT` を小さな HTTP proxy に向け、特定の要求にだけ決まった応答（例: 409）を返すと、並列でしか起きにくい失敗の経路を確実に作れる。
- 偽の TUI: run の `PATH` の先頭にエージェントの CLI と同じ名前の shim を置き、決めたフォルダでだけ偽の画面を出して受けたキーを記録する。「Enter を押さない」ことを実測で示せる。`--version` だけ答えて本物を起動しない shim は、セッションが消えたときに送信が本物の CLI を起動する事故も防ぐ。shim が当たらない CLI もあるので、起動したプロセスを確かめる。

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

## 専用ユーザーで動かす（`CM_UAT_ISOLATION=own-home`、#3312）

毎朝の製品の経路の確認（#3312 の第 2 段）を、専用の macOS ユーザー（例: `cmcheck`）で動かすための値。`1` の動きは変わらない。

起動:

```bash
# 専用ユーザーとして。ソケットとロックはその HOME の下に置く
CM_UAT_SOCK_BASE="$HOME/run" CM_RUN_LOCK_DIR="$HOME/run/run.lock" \
  bash scripts/uat/run-server.sh up --own-home --port <port> --run-dir <dir>
```

`up --own-home` は、サーバーに `CM_UAT_ISOLATION=own-home` と `CM_UAT_DEDICATED_USER=$(id -un)` を渡す。検査の組は `.commandmate/uat-own-home.yaml`（`uat.yaml` と同じ形の別ファイル。値・ユーザー・ソケットの場所。`uat.yaml` に足すと cmate-uat が未知のキーとして毎回確認を求めるので分けた）。

**許すもの:** その HOME の中の共有の hook のファイルを、このビルドが書くこと。codex の `$CODEX_HOME/hooks.json`・relay・hook の信頼（`config.toml`）、antigravity の `~/.gemini/config/hooks.json`、copilot の `~/.copilot/settings.json`、claude の `--settings` のファイル（`CM_AGENT_HOOKS_DIR`）。`1` のときの「読むだけ・違えば拒否」の代わりに書く。

**起動の前の確認（エージェントを起動するたび）:** 満たさなければ、そのエージェントの起動を拒否する（`CM_UAT_ISOLATION=own-home: refusing to start <tool>: <理由>`）。

- 実行しているユーザー（`os.userInfo().username`）が `CM_UAT_DEDICATED_USER` と一致する
- `HOME` の実体が、そのユーザーのホームディレクトリ（アカウントの情報。`$HOME` ではない）の実体と同じで、持ち主がそのユーザー
- 書き込み先（`CODEX_HOME`・`hooks.json`・relay とその一時ファイル `.tmp`・`config.toml`・`~/.gemini/config/hooks.json`・`~/.copilot/` と `settings.json`・そのバックアップ・一時ファイル・ロック・`CM_AGENT_HOOKS_DIR` と claude の設定ファイルそのもの）のそれぞれの実体のパス（symlink をたどる。まだ無いファイルは、在る祖先の実体で判定）が HOME の中で、持ち主がそのユーザー。行き先の無い symlink は拒否

**残すもの（`1` と同じ）:**

- hook の準備に失敗したときは起動を拒否する（素の起動に戻さない）。copilot の `config.json` に `hooks` があるときも拒否。codex の relay を更新できない・同梱版と違う、claude の設定ファイルを書けない（`CM_AGENT_HOOKS_INJECT=0` を含む）ときも拒否する。ほかの値では: codex は、未設定なら relay の更新の失敗を記録して古い relay のまま続け、`1` なら relay を書かず、同梱版と違う relay を見つけると起動を拒否する。claude は、未設定でも `1` でも設定ファイルを書けなければ hook なしの素の claude で起動する（`1` は `--setting-sources project,local` つき）
- 一時ファイル（relay の `.tmp`、copilot の一時ファイル）は、先に消してから排他的に作る（置かれた symlink をたどって書かない。これはどの値でも同じ）
- claude の起動の計画は tmux のセッションを作る前に組む（拒否したときに空のペインを残さない）
- 送り先の固定（`CM_HOOK_URL` などを、その run のサーバーへ）
- Schedule・日次まとめの `codex exec`・`agy -p` の拒否。claude は `--setting-sources project,local`
- CLI は `.env` を読まず、`CM_PORT` が無ければ 3000 に落ちない

`run-server.sh down` は、`own-home` のときは共有のファイルの前後の変化を記録する（メッセージと、状態のファイルの `shared_changed=yes|no`）が、不合格にしない。`--own-home` を付けないとき（利用者の UAT）は今までどおり不合格にする。

本番の受け口の `agent-event-unresolved-target` のログには、`worktreeId`（hook が名乗ったとき）と `cwdHash`（`cwd` の SHA-256 の先頭 16 文字。`cwd` そのものは出さない）が載る。run の cwd のハッシュと突き合わせて、専用ユーザーの run から本番に届いた hook を数えるのに使う。

## 素の CLI を実機で測るとき（gemini の自動更新、#3790）

私設の tmux（`tmux -L`）・一時 HOME・空のディレクトリで gemini を起動して測るときの追加の手順。HOME を一時にしても、gemini は起動のたびに新しい版を確かめ、npm でグローバルに入れた gemini なら `npm install -g @google/gemini-cli@<版>` を自分で走らせる。書き換わるのは一時 HOME ではなく、利用者のグローバルのインストール（#3776 の測定で v0.62.0 → v0.64.0 になった）。

- 一時 HOME の `~/.gemini/settings.json` に、起動の前に次を書く。古い名前の `disableAutoUpdate` / `disableUpdateNag` は gemini が読み替える。

  ```json
  {"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false}}
  ```

- 設定が効かなかったときの逃げ道として、起動の環境に `npm_config_prefix=<一時のディレクトリ>` と `npm_config_cache=<一時のディレクトリ>` も渡す。更新が走っても、書き込み先は一時の場所になる。`ps eww <pid>` で環境に入っていることを確かめる。
- 未サインインの HOME では、信頼の確認の後に認証方式の選択（`● 1. Sign in with Google`）が出る。Auto-Yes はこれを既定で答える（従来どおり）。答えると一時 HOME の `settings.json` に `security.auth.selectedType: "oauth-personal"` が書かれ、Google のサインインが始まる。`NO_BROWSER=true` を渡すと、ブラウザを開かずに URL と `Enter the authorization code:` を出して止まる。

実測（2026-10-18、上の隔離の中）: 一時の prefix に gemini 0.62.0 を入れ（最新は 0.64.0）、`npm_config_prefix` をその prefix に向けて起動した。

| 一時 HOME の設定 | 画面 | 一時の prefix の版 |
|------------------|------|--------------------|
| なし | `Update successful! The new version will be used on your next run.` | 0.64.0（更新された） |
| `enableAutoUpdate: false` だけ | `Gemini CLI update available! 0.62.0 → 0.64.0` の通知だけ | 0.62.0 |
| 上の 2 つとも `false` | 通知も出ない | 0.62.0 |

どの場合も、利用者のグローバルの gemini（`/opt/homebrew`）は 0.64.0 のままだった。Homebrew の formula・npx・単体のバイナリで入れた gemini は、gemini のコード上もともと自分では更新しない。
