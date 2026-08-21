# エージェントイベント Hook 設定ガイド

CommandMate はエージェントの完了を、既定では **tmux 画面の文字列解析**で推測している。
hook を入れると、エージェント CLI 自身が発する**構造化イベント**が第一級の情報源として
加わる（Issue #1549）。

**この hook は CommandMate が自動注入する**（Issue #1722、Epic #1720 Phase 4）。
対応は **claude / copilot / gemini / antigravity / codex / opencode の 6 ツール**で、
手動設定は不要になった（§0）。手動設定を残していても壊れない — §0.4 を参照。

> **文字列解析は廃止しない**。hook は「二つ目の意見」であり、
> 現時点で `wait` やポーラーの完了判定を置き換えてはいない（§5）。

---

## 0. 自動注入（Issue #1722 / Epic #1720 Phase 4）

CommandMate がエージェントセッションを**新規作成**するとき、そのツール用の hook 設定を
自動で用意し、起動コマンドに載せる。対応ツールの正本は
`src/lib/hooks/sources/registry.ts` 末尾の `registerAgentEventSource(...)` 呼び出しで、
現在は **claude / copilot / gemini / antigravity / codex / opencode の 6 ツール**である
（`vibe-local` だけが未登録。登録の無いツールは `legacy-relay` の互換ソースに落ち、
#1549 時点の手動設定と同じ挙動になる）。

### 0.0 ツール別の一覧

**「Claude と同じはず」で読むと必ず外れる。** 配送方式・設定ファイル・相関キーの運び方・
裁定の予算がツールごとに違い、どれも**無言で壊れる**種類の違いである。

| ツール | CommandMate が書く設定 | スコープ | 相関キーの運び方 | 配送 | 裁定イベント | 決定予算 |
|---|---|---|---|---|---|---|
| **claude** | `~/.commandmate/hooks/claude-<worktreeId>-<instanceId>-<hash>.json` を生成し `--settings <file>` で渡す | per-instance | **URL のクエリに焼き込み** | `http`（`SessionStart` だけ `command`。§0.2） | `PermissionRequest` | 5 秒 |
| **copilot** | **`~/.copilot/settings.json`（マシン共通のユーザー設定）へ merge** | global-singleton | **環境変数** `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` / `CM_HOOK_PORT` | `command`（`http` は 1 件も届かない） | `PreToolUse` | **10 秒** |
| **codex** | `$CODEX_HOME/hooks.json`（既定 `~/.codex/hooks.json`、マシン共通） | global-singleton | 環境変数 `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` ＋ `CM_HOOK_URL` | `command`（`http` handler が 1 つあると**ファイルごと破棄される**） | `PermissionRequest` | 5 秒（`SessionEnd` だけ codex 側が 3 秒に clamp） |
| **gemini** | `<worktree>/.gemini/settings.json` へ merge | per-worktree | `CM_HOOK_URL`（instance は URL 側） | `command` | **なし**（応答が裁定になるイベントを登録しない） | — |
| **antigravity** | `~/.gemini/config/hooks.json`（マシン共通。gemini と同じツリーに同居） | global-singleton | 環境変数 `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` | `command` | `PreToolUse` | 5 秒 |
| **opencode** | **何も書かない** | none | 起動時に割り当てた `--port <N>` | **push ではない** — CommandMate が SSE を**購読する側** | `POST /permission/:id/reply` | **なし（無期限に待つ）** |

読み方の注意:

- **決定予算**は「CommandMate の裁定が間に合わないと何が起きるか」の締切であって、
  そのツールが hook 全般に与える時間ではない。各ソースが
  `capabilities.decisionTimeoutSeconds` として公開しており、呼び出し側は定数を
  読み直さずここを見る。
- **`type:"http"` が使えるのは claude だけ。** copilot は `http` handler から 1 件も
  リクエストが届かず（エラーも出ない）、codex は `http` handler が 1 つあるだけで
  `hooks.json` 全体を破棄する。他 4 ツールでは
  `scripts/hooks/cmate-agent-event.sh`（§2）が唯一の配送路である。
- **`gemini` の `timeout` はミリ秒**。他ツールのつもりで `5` と書くと 5ms で殺され、
  「登録もされ、開示バナーにも出て、実行もされたのに全イベントが失われる」状態になる。
- **裁定の見送り（no-decision）が安全でないのは opencode だけ。** 他 5 ツールは
  見送っても承認ダイアログが出るだけだが、opencode は**セッションが止まる**
  （実測 10 分 19 秒無応答で pending のまま）。§0.8 を参照。

全ツール共通の性質:

| 事項 | 内容 |
|---|---|
| opt-out | **`CM_AGENT_HOOKS_INJECT=0`** で 6 ツールとも注入をスキップし、Issue #1722 以前と同じ素の起動コマンドに戻る（§0.3） |
| 生成物の置き場所 | claude の生成ファイルは `~/.commandmate/hooks`（`CM_AGENT_HOOKS_DIR` で差替可）。**ユーザー自身の設定ファイルを書き換えるのは copilot / codex / gemini / antigravity で、いずれも merge** — 自分の marker つきエントリだけを差し替え、他のキーとハンドラは素通しする。解釈できないファイルは**触らず**、hook 無しで起動する |
| fail-open | timeout も接続失敗も設定書き込み失敗もエージェントを止めない。**hook の無い素の起動に落ちるだけ**である |
| 既存セッション | healthy な既存セッションの**再利用時は注入しない**（§0.5）。次の新規作成から効く |
| 起動完了の signal | **hook の到着を起動完了の判定に使わない**（§0.5） |

**以下 §0.1〜§0.7 は claude の詳細**である。claude 以外の 5 ツール固有の注意は §0.8 にまとめた。

### claude の注入ファイル

```
~/.commandmate/hooks/claude-<worktreeId>-<instanceId>-<hash>.json
```

| 注入されるイベント | handler | 備考 |
|---|---|---|
| `SessionStart` | `command`（`cmate-agent-event.sh` 中継） | **http は使えない**。§0.2 |
| `UserPromptSubmit` | `http` | |
| `Stop` | `http` | |
| `Notification` | `http`（matcher: `permission_prompt\|idle_prompt`） | matcher は `notification_type` に照合される |
| `SessionEnd` | `http` | |
| `PermissionRequest` | `http`（別受け口 `/api/hooks/permission-request`、timeout 5 秒） | **Auto-Yes v2**（#1724）。§0.6 |
| `PreToolUse` / `PostToolUse` | `http`（matcher: `AskUserQuestion`） | #1726。宛先は event 受け口（裁定ではなく観測） |

同じファイルに hooks 以外に **`permissions.deny`** も入る（#1739）。hook ではなく
Claude 自身が enforce するもので、`PermissionRequest` が発火する前に効く。§0.7

### 0.1 `~/.claude/settings.json` は書き換えられない

`--settings` の hooks はユーザー設定と**同一イベントでも配列連結され、両方が実行される**
（置換ではない）。ユーザーの `~/.claude/settings.json` は sha256 が変わらない（実測）。

### 0.2 `SessionStart` だけ `type:"http"` が使えない

Claude Code は `SessionStart` の http hook を**黙って skip する**（公式ドキュメント未記載）。
debug ログに `HTTP hooks are not supported for SessionStart` が出るだけで、
stdout にも TUI にも何も出ない。そのため `SessionStart` のみ `type:"command"` で
`scripts/hooks/cmate-agent-event.sh` を中継に使う。

### 0.3 無効化（ロールバック）

```bash
CM_AGENT_HOOKS_INJECT=0 commandmate start
```

注入をスキップし、Issue #1722 以前とまったく同じ起動コマンドになる。
生成ファイルの置き場所は `CM_AGENT_HOOKS_DIR` で変更できる。

### 0.4 手動設定との共存（二重配送）

§3 の手動 Stop hook を残したまま自動注入が有効になると、**同じターンの `stop` が 2 回届く**。
`applyAgentStopEvent` の `lastStopEventAt` は上書きなので冪等だが、
`task_events` の `agent_idle` は**配送ごとに 1 行増える**（実測・確認済み）。

そのため受け口は `(worktreeId, cliTool, instance, event, sessionId)` が一致する
イベントを **3 秒以内は 1 回として扱う**。両方の配送は同じ `session_id` を運ぶので
二重配送は畳まれ、別ターン（別 `session_id`）は畳まれない。
`sessionId` を送らない呼び出しは**畳まない**（区別材料が無いため、
実イベントを取りこぼすより重複を許す）。

**手動設定は削除して構わない**（自動注入が同じイベントを送る）。
残す場合も上記 dedup で二重記録は起きない。

### 0.5 注入されないケース

- **既存セッションの再利用時**（healthy なセッションがある場合）は注入しない。
  次回の新規作成から適用される。実行中セッションへの settings 追記は Claude が
  無警告でホットリロードするため技術的には可能だが、
  「この pane はどの設定で動いているか」が時間で変わる状態を避けるために採らない。
- **hook の到着を「起動完了」の signal にしてはいけない**。未 trust ディレクトリでは
  folder trust ダイアログが先に出て、応答するまで `SessionStart` すら発火しない
  （実測 25.3 秒の完全無音）。起動検出は従来どおり `CLAUDE_PROMPT_PATTERN` と
  trust ダイアログ自動応答で行う。
### 0.6 `PermissionRequest`（Auto-Yes v2 / Issue #1724）

他のイベントと違い、これは**同期**で、**応答本文がエージェントに従われる**。
Claude は承認ダイアログを**描く前に**この hook を叩き、CommandMate は 3 通りのうち 1 つを返す。

| 応答 | Claude の挙動 |
|---|---|
| `{}`（no-decision） | 従来どおり TUI 承認ダイアログが出る（＝この機能が無い機械と同じ） |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | ダイアログを出さず即実行 |
| `deny` | **CommandMate は返さない**（下記） |

裁定表:

| 条件 | 裁定 |
|---|---|
| payload を読めない | no-decision |
| `tool_name` が `AskUserQuestion` | no-decision（常に） |
| Auto-Yes が無効／期限切れ | no-decision |
| 契約 `autoYes` が抑止（`mode: off` / `denyPatterns` 一致 / 型不許可） | no-decision ＋ `lastSuppression` 記録 |
| 上記以外 | `allow` |

- **判定不能は必ず no-decision。** 誤 `allow` はコマンド実行を意味し、no-decision はダイアログが出るだけ。
  この非対称性が全分岐の設計原則になっている。
- **`deny` は返さない。** Auto-Yes の抑止はもともと「自動応答しない」であって「拒否する」ではない。
  `denyPatterns` 該当時も**ダイアログが出て手動で応答できる**（挙動は従来と同じ）。
- **`denyPatterns` の照合対象はそのリクエストの `tool_input` だけ**（Bash なら command、他ツールは主要引数）。
  画面もスクロールバックも入力に無いため、#1699（承認済みの `rm -rf` が以後の無関係な承認まで抑止した不具合）は
  構造的に起こらない。
- **`AskUserQuestion` は突破できない。** `allow` を返しても選択画面はそのまま出る（実測）。
  裏返せば「`respond yes` が承認に化ける」型の事故も起きない。質問への回答は別機構（#1726）の担当。
- **サーバが落ちていてもエージェントは止まらない。** hook の timeout / 接続失敗はすべて fail-open で、
  ダイアログが出るだけになる。
- Auto-Yes のトグルとは**独立に常時注入**される。注入はセッション起動時 1 回きりで、
  Auto-Yes は後から有効化されるため、トグル連動にすると「有効にしたのに hook が無い」状態が生まれる。
- **画面ベースの Auto-Yes は残っている。** hooks を注入できない環境（`CM_AGENT_HOOKS_INJECT=0`、
  設定ファイルの書き込みに失敗した場合、codex の hook trust 未承認など）と `vibe-local` では
  従来どおり画面解析で動く。裁定 hook を持つ 5 ツール（claude / codex / copilot / antigravity /
  opencode）では、hook 側が先に裁定する。

> **この 2 つの挙動は実 TUI で継続的に確認されている**（Issue #1847）。
> `npm run canary` の `permission-hook-allow`（allow → ダイアログが出ずにツールが走る）と
> `permission-hook-no-decision`（`denyPatterns` 一致 → ダイアログが出て `autoYes.lastSuppression` に理由が載る）が、
> 実際の Claude セッションに対して毎回測り直す。3 項目の記録先の一覧は
> [`docs/design/agent-hooks-live-verification.md`](../design/agent-hooks-live-verification.md) の §8。

### 0.7 `permissions.deny` — パターン一括 kill の禁止（Issue #1739）

注入ファイルには hooks に加えて `permissions.deny` が入る。

```jsonc
"permissions": {
  "deny": ["Bash(pkill:*)", "Bash(killall:*)", "Bash(kill -9:*)"]
}
```

2026-08-06、委任ワーカーが自分の隔離サーバ 1 本を再起動するつもりで
`pkill -f "node dist/server/server.js"` を実行した。`-f` はコマンドライン全体への部分一致なので、
同じ実行ファイルで動いていた**ユーザーの本番サーバ（port 3000）と global インスタンス（port 60301）**にも
命中し、手で再ビルド・再起動するまで復旧しなかった。

**なぜ hooks の隣に置くのか。** `permissions.deny` は**ダイアログが存在する前に**拒否する。
つまり `PermissionRequest` が発火せず、**Auto-Yes には裁定する機会が来ない**。
実際の事故ではダイアログが出て Auto-Yes がそれを承認していた。上位 2 層では止まらない:

| 層 | 何をするか | この事故で止まったか |
|---|---|---|
| 委任契約の文面（「port 3000 に触れない」） | 助言。**対象**を禁じる | ✗ ワーカーの主観では自分のサーバだけを止めていた |
| 契約 `autoYes.denyPatterns`（#1724） | 自動応答を抑止し**人間へエスカレート**する | ✗ 誰かが書き忘れたパターンは効かない |
| `permissions.deny`（本節） | **手段**を禁じる。ダイアログ以前に拒否 | ✓ Auto-Yes の有無に関係なく拒否される |

**禁じているのは「手段」であって「対象」ではない。** 3 つのルールはいずれも
*プロセスをパターンで選ぶ*書き方を指している。

#### 自分が起動したプロセスの止め方（この作法を使うこと）

**PID を指定すれば従来どおり止められる。** 起動時に PID を記録し、それだけを止める:

```bash
U="$SB/uat"; mkdir -p "$U"
CM_PORT=3779 CM_DB_PATH="$U/cm.db" NODE_ENV=production \
  nohup node dist/server/server.js > "$U/server.log" 2>&1 &
echo $! > "$U/uat.pid"          # ← 自分の PID だけ記録する
# ...
kill "$(cat "$U/uat.pid")"      # ← deny 対象外。そのまま実行できる
```

| 書き方 | 可否 |
|---|---|
| `kill "$(cat uat.pid)"` / `kill 4242` / `kill -TERM 4242` | ✅ 通る |
| `pkill …` / `killall …` | ❌ 拒否 |
| `kill -9 …` | ❌ 拒否（`kill -9 -1` は自分の全プロセス、`kill -9 -<pgid>` はプロセスグループを撃つ）。SIGTERM を使うこと |

拒否は**コマンドを合成しても回避できない**。`cd /tmp && pkill …`・`pkill … \| cat`・
`echo x; pkill …` はいずれも拒否される（コマンド行が分解され、区間ごとに照合されるため。§0.7 の実測）。

#### ユーザー設定との関係

- `--settings` の deny ルールは Claude 内部で **`flagSettings` という独立の宛先**に入り、
  ユーザー設定・プロジェクト設定の権限ルールと**併存**する（hooks と同じく置換ではない）。
- **`deny` は `allow` に勝つ。** より優先度の高い `.claude/settings.local.json` に
  `"allow": ["Bash(pkill:*)"]` を書いても拒否されることを実測済み。
  つまりユーザー設定の `permissions.allow` でこの禁止を開け直すことはできない。
- 前方一致は**フラグまで含めて**照合される。`Bash(kill -9:*)` は `kill -9 …` だけを拒否し、
  `kill <pid>` には当たらない（`Bash(uname -a:*)` が `uname -a` を拒否し `uname -s` を通した実測による）。

実測の詳細は [agent-hooks-permission-deny-verification.md](../design/agent-hooks-permission-deny-verification.md)。

#### 逃げ道

正当な用途がどうしても塞がれる場合は、注入全体を切る（§0.3）:

```bash
CM_AGENT_HOOKS_INJECT=0 commandmate start
```

deny ルールだけを外すスイッチは**用意していない**。構造化イベントごと失う方が、
「機構は入っているが誰かが黙って外している」状態より事故を見つけやすい。

### 0.8 claude 以外の 5 ツール

§0.0 の表の各行が、実装のどこで何を意味しているか。**どれも実測に基づく**（出典は
`docs/design/agent-hooks-phase4-live-verification.md` と各ソースのモジュールコメント）。

#### copilot — マシン共通の `~/.copilot/settings.json` を書き換える

**このツールだけは、ユーザーの機械全体で 1 つしかない設定ファイルを CommandMate が書き換える。**
`copilot` に `--settings` 相当のオプションが無く、per-launch のファイルを作れないためである。

- **merge であって上書きではない。** CommandMate 自身の marker
  （`cmate-copilot-agent-hooks`。シェルの no-op `:` の引数として書かれる）を持つエントリだけを
  差し替え、他のキーとハンドラは 1 バイトも触らない。**解釈できないファイルは触らず、
  hook 無しでセッションを起動する** — イベントを失うのは回復できるが、
  ユーザーの設定を壊すのは回復できない。
- **書き込みは原子的置換＋ロック**（Issue #1904）。同じディレクトリの `.cmate.lock` を取り、
  一時ファイルへ書いて `rename` する。`commandmate start --issue N --auto-port` で
  複数サーバが同時に動く運用が正式にサポートされている以上、`writeFileSync` の
  「truncate してから書く」窓は実在するリスクである。**ロックを取れなければ hook 無しで起動する。**
- **`config.json` に `hooks` があるときは settings.json を書かない**（Issue #1904）。
  `copilot help config` は `hooks` を `config.json` のキーとして案内しているが、
  copilot 1.0.80 は起動時にそのキーを `settings.json` **の上へ**移送する。つまり
  公式ドキュメントに従った利用者の設定が、CommandMate の書いた内容を無言で消す。
  CommandMate は先に `config.json` を検査し、`hooks` があれば**書かずに素の起動へ落ちる**。
- **hook は `CM_AGENT_WORKTREE_ID` が無ければ不活性。** マシン共通のファイルなので、
  利用者が自分の端末で起動した copilot にも同じ hook が仕掛かる。全ハンドラの先頭に
  `[ -z "$CM_AGENT_WORKTREE_ID" ]` のガードがあり、未設定なら stdin を捨てて `exit 0` する。
  これが無いと、たまたま登録済み worktree の中で起動した無関係な copilot の `Stop` が
  `cwd` で解決され、**誰のエージェントも終わっていないのに `commandmate wait` が返る**。
  `CM_HOOK_PORT` が数字でない場合も同じく不活性になる。
- **相関キーは環境変数で運ぶ**（`CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID`）。
  書き込み時に URL へ焼き込むと、1 worktree の `copilot` と `copilot-2` のうち
  後から起動したほうが先のインスタンスの名前で post することになる。
  **ポート（`CM_HOOK_PORT`）も同じ理由で環境変数**である — 実際に、開発サーバ（3011）が
  ファイルを書き換えた結果、本番 3000 のセッションまで 3011 へ post していた。
- **決定予算は約 10 秒**（claude の `PermissionRequest` 用 5 秒設定とは別物で、
  copilot 側の hook 打ち切り時間）。生成コマンド内の `curl` は 4 秒で自分を打ち切る。
  遅れた裁定は破棄され、ツールはそのまま実行される（fail-open）。

#### codex — `$CODEX_HOME/hooks.json`、ただし人が trust するまで動かない

- ファイルは `$CODEX_HOME/hooks.json`（既定 `~/.codex/hooks.json`）**1 本のみ**。
  `<worktree>/.codex/hooks.json` も発火するが、worktree ごとに untracked な `.codex/` が増え、
  trust が絶対パス単位なので worktree の数だけ人が承認し直すことになるため採らない。
- **hook は人が trust するまで完全な沈黙のうちに skip される。** trust は利用者自身の
  `~/.codex/config.toml` に記録され、CommandMate はこのファイルを書かない。
- 相関キーは copilot と同じく環境変数で運ぶ。**copilot と違い、CommandMate が起動していない
  codex セッションも post する** — 環境変数が無いぶん相関キーが載らず、受け口は `cwd` から
  worktree を解決してプライマリインスタンス扱いにする（＝#1549 の手動設定と同じ挙動）。

#### gemini — worktree 内の `.gemini/settings.json`、`timeout` はミリ秒

- 5 ツール中このツールだけ hook 設定が worktree スコープで、`~/.gemini/settings.json` は
  一切開かない。**利用者のリポジトリ内のファイルを書き換える**ので、merge であることと、
  書き込む command 文字列が起動ごとに変わらないことの両方が要件になる
  （gemini は trust した command 文字列を記録しており、変わると開示バナーを出し直す）。
- **`timeout` の単位はミリ秒**。`5` と書くと 5ms で殺される。
- `BeforeTool` / `AfterTool` は**意図的に登録しない**（同期実行なのでツール呼び出しごとに
  往復 2 回を足すだけで、得られる情報は `BeforeAgent` が既に立てている `running` と同じ）。

#### antigravity — `~/.gemini/config/hooks.json`（gemini と同居）

- agy が読むのは `~/.gemini/config/hooks.json` **1 本だけ**。文書化されている
  `<workspace>/.agents/hooks.json` は読まれない。`~/.gemini/` は gemini の
  OAuth 資格情報や agy 自身の状態と同居しているので、書き込みは merge に限られる。
- ファイルは**相関キーを一切持たない**。worktree と instance は起動セッションの
  環境変数（`CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL`）で運ぶ。
- **`PreToolUse` だけは中継スクリプトを通さない。** agy の `PreToolUse` は応答の
  `decision` が必須で、`{}` を返すと**全ツール呼び出しが拒否される**。中継スクリプトは
  stdout に何も書かないため、こちらは stdout が裁定になるインライン `curl` で構成する。

#### opencode — 何も書かない。CommandMate が購読する側

- **設定ファイルを 1 バイトも書かない**（`configScope: 'none'`）。統合の実体は
  起動コマンドに付ける `--port <N>` と、そのポートへの SSE 購読だけである。
  他 5 ツールが「エージェント → CommandMate へ POST」なのに対し、これだけが逆向きになる。
- **ポートは CommandMate が明示的に割り当てる**（範囲 4200-4299）。`--port 0` は
  「OS に空きを訊く」ではなく「まず 4096、埋まっていれば ephemeral」で、実ポートを
  読み戻す手段が stdout か `lsof` しか無い。割当は `~/.commandmate/opencode-ports.json`
  に永続化し、CommandMate 再起動後は推測ではなく記録＋health check で復帰する。
- **裁定を見送ると、ダイアログが出るのではなくセッションが止まる。** 承認要求を
  10 分 19 秒放置しても timeout もフォールスルーも起きなかった（実測）。TUI のダイアログと
  REST の pending は 2 段階ではなく同じオブジェクトの 2 つの見え方なので、
  「判断できないときは黙る」が唯一成立しないソースである。
- 縮退は全経路 fail-open（ポート枯渇・サーバ不達・SSE 断のいずれも画面解析に落ちる）。
  `CM_AGENT_HOOKS_INJECT=0` は起動を素の `opencode` に戻す。

---

## 1. 受け口: `POST /api/hooks/agent-event`

受け口は**2 つのリクエスト形式**を受ける。

**(a) CommandMate 形式**（`cmate-agent-event.sh` と手動設定）:

```jsonc
{
  "tool": "claude",           // 既存 CLI ツール id（claude / codex / ...）
  "event": "stop",            // stop | notification | session_start |
                              // user_prompt_submit | session_end
  "cwd": "/path/to/worktree", // 絶対パス。worktree の解決キー
  "sessionId": "abc123",      // 任意
  "worktreeId": "wt-a",       // 任意。あれば cwd 解決より優先
  "instanceId": "claude-2",   // 任意。無ければプライマリ扱い
  "detail": "idle_prompt"     // 任意。イベント種別のサブタイプ
}
```

**(b) Claude Code のネイティブ payload**（注入した `type:"http"` hook）:

```jsonc
{ "hook_event_name": "Stop", "session_id": "...", "cwd": "...", ... }
```

`type:"http"` はボディを加工できないため、Claude の payload がそのまま届く。
`tool` / `worktreeId` / `instanceId` は**クエリパラメータ**で渡す:

```
POST /api/hooks/agent-event?tool=claude&worktreeId=wt-a&instanceId=claude-2
```

| 応答 | 意味 |
|---|---|
| `202 {"accepted":true}` | 受理。**worktree が解決できた場合も、できなかった場合も同じ応答**（登録済みディレクトリの探索に使われないため） |
| `400` | `tool` / `event`（または `hook_event_name`）/ `cwd` / `instanceId` が不正 |

認証が有効（`CM_AUTH_TOKEN_HASH` 設定済み）なら、この経路も**認証必須**である。
`Authorization: Bearer <token>` を付けること（後述の `CM_AUTH_TOKEN`）。

> **注入した http hook の `headers` で `$CM_AUTH_TOKEN` を使う場合、
> 同じ hook に `allowedEnvVars: ["CM_AUTH_TOKEN"]` を併記しないと展開されない。**
> 併記を忘れるとリテラル文字列 `$CM_AUTH_TOKEN` で認証しにいき、無言で 401 になる。
> 生成器はこれを常に対で出力する。

`event: "stop"` を受け取ると、対象 worktree / instance について次を行う:

1. 実行契約つきの active task があれば `agent_idle` イベントを `task_events` に
   `source=hook` で記録する
2. その契約に `success.autoVerifyOnStop: true` があれば検証ランを自動起動する
   （[task-contract.md](../design/task-contract.md) §2.5。**省略時は false**）
3. セッション状態のヒントとして `lastStopEventAt` を記録する（§5）

契約が無いセッション（大多数）では 1〜2 は何も起こらず、3 だけが記録される。

`stop` 以外のイベントは受理・記録されるが、現時点で状態は変えない。

### 1.1 インスタンスの特定

`cwd` は worktree は特定できるが**インスタンスは特定できない** —
同一 worktree の `claude` と `claude-2` は cwd が同じである。
そのため注入 URL に `worktreeId` / `instanceId` を焼き込み、これを相関キーにする。

**`session_id` は相関キーにしない。** `/clear` は `SessionEnd(reason=clear)` →
`SessionStart(source=clear)` を発火し、そのとき `session_id` が変わる。
インスタンス・worktree・tmux pane はどれも変わっていない。

`worktreeId` / `instanceId` が無いリクエスト（手動設定）は従来どおり
`cwd` から worktree を解決し、**プライマリインスタンス**に適用される。

---

## 2. 同梱スクリプト `cmate-agent-event.sh`

`scripts/hooks/cmate-agent-event.sh` は上記を POST するだけの薄いラッパである
（bash 3.2 互換）。

```
cmate-agent-event.sh [--tool ID] [--event EVENT] [--cwd PATH] [--session-id ID]
                     [--worktree-id ID] [--instance-id ID]
                     [--json JSON | --stdin-json] [--url URL] [--strict] [JSON]
```

| 環境変数 | 既定 | 用途 |
|---|---|---|
| `CM_HOST` | `127.0.0.1` | サーバホスト |
| `CM_PORT` | `3000` | サーバポート（worktree 並列運用時は該当ポート） |
| `CM_HOOK_URL` | — | 完全な URL。`CM_HOST`/`CM_PORT` より優先 |
| `CM_AUTH_TOKEN` | — | 設定時 `Authorization: Bearer` を付与 |
| `CM_AGENT_TOOL` | `claude` | `--tool` の既定 |
| `CM_HOOK_TIMEOUT` | `5` | curl の `--max-time`（秒） |

`cwd` の決定順は `--cwd` → `CM_AGENT_CWD` → `CLAUDE_PROJECT_DIR` → JSON の `cwd` → `$PWD`。

`--worktree-id` / `--instance-id` は**指定したときだけ**ボディに載る。
未指定なら受け口は cwd 解決＋プライマリ扱いになるので、Issue #1549 時点の手動設定と
挙動が変わらない。

`hook_event_name` は `Stop` / `SubagentStop` → `stop`、`Notification` → `notification`、
`SessionStart` → `session_start`、`SessionEnd` → `session_end`、
`UserPromptSubmit` → `user_prompt_submit` に対応づけられる。
`PreToolUse` / `PermissionRequest` は**対応づけず exit 2 で拒否する**（本 Issue のスコープ外）。

**POST に失敗しても exit 0 で終わる**。サーバが落ちているという理由でエージェントの
セッションが壊れるほうが害が大きいからである。CI 等で失敗を検出したい場合は `--strict`。

---

## 3. Claude Code の手動設定（Stop hook）

> **Claude では通常この設定は不要**（§0 の自動注入が同じイベントを送る）。
> 以下は CommandMate 以外から起動した Claude セッションや、
> `CM_AGENT_HOOKS_INJECT=0` で運用する場合の手順である。

`~/.claude/settings.json`（プロジェクト限定なら `.claude/settings.json`）:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/scripts/hooks/cmate-agent-event.sh --tool claude --stdin-json"
          }
        ]
      }
    ]
  }
}
```

Claude Code は hook に `{"session_id":"...","hook_event_name":"Stop","cwd":"..."}` を
**stdin の JSON** で渡すので `--stdin-json` を付ける。対応づけは §2 のとおり。

ポートを変えている worktree では `command` の前に `CM_PORT=3135 ` を付ける。

> `--stdin-json` を付けないと stdin を読まないので、hook が stdin を渡さない構成でも
> ブロックしない。その場合 `cwd` は `CLAUDE_PROJECT_DIR` か `$PWD` から決まる。

---

## 4. Codex の設定（notify）

`~/.codex/config.toml`:

```toml
notify = ["/absolute/path/to/scripts/hooks/cmate-agent-event.sh", "--tool", "codex"]
```

Codex は notify コマンドの**末尾に JSON 文字列を 1 引数として追加**して起動する。
スクリプトはオプション以外の位置引数を JSON として読み、`type` を event に、
`turn-id` を `sessionId` に対応づける（`agent-turn-complete` → `stop`）。

notify は Codex の作業ディレクトリで起動されるため `cwd` は `$PWD` から決まる。
確実にしたい場合は `"--cwd", "/path/to/worktree"` を足す。

---

## 5. いま hook が「変えないこと」

> **例外は `PermissionRequest` だけ**（§0.6 / Issue #1724）。これは応答がエージェントに
> 従われる唯一のイベントで、Auto-Yes が有効なら承認ダイアログを出さずに実行させる。
> それ以外の判定（`wait` / ポーラー / 完了検知）は以下のとおり従来のまま。

`lastStopEventAt` と `structuredEvents` は
`GET /api/worktrees/:id/current-output` と WebSocket のターミナルスナップショットに
**露出するだけ**で、`wait` / ポーラー / **画面ベース** Auto-Yes の完了判定はいずれも
従来どおり文字列解析の結果で動く。

```jsonc
"lastStopEventAt": 1754470000000,
"structuredEvents": {
  "lastEventType": "notification",   // 直近イベント種別
  "lastEventAt": 1754470000000,
  "lastEventDetail": "idle_prompt"   // notification_type / reason / source
}
```

hook が届いているかを確認したいときはこれを見る。
`lastEventType` が永久に `null` なら注入されていないか、届いていない。

文字列解析と hook という二重ソースを、実測データを見る前に切り替えるのは
「既知の不正確さ」を「未知の失敗モード」と交換することになる。
判定への組み込みは後続 Issue（#1723）で、両者の一致率を見てから行う。

---

## 6. 制限事項

- **手動設定でのインスタンス指定**: `--worktree-id` / `--instance-id` を渡さない
  リクエストは従来どおり**プライマリインスタンス**の task に適用される。
  1 worktree で `codex` と `codex-2` を併走させている場合、`codex-2` の hook に
  `--instance-id codex-2` を足さないと `codex` の task を動かす。
  自動注入したセッションではこれは自動で入る（claude は URL、他 4 ツールは環境変数）。
- **自動注入の対象は 6 ツール**: claude / copilot / gemini / antigravity / codex / opencode
  （`src/lib/hooks/sources/registry.ts` が正本）。**`vibe-local` だけが未対応**で、
  従来どおり画面解析のみで判定する。受け口は `tool` に既存 CLI ツール id を取れるので、
  未対応ツールでも同じスクリプトで `--tool` を変えれば手動で送信できる。
- **ツールごとに前提が違う**: 設定ファイルの置き場所・相関キーの運び方・決定予算・
  「裁定を見送ったときに何が起きるか」はいずれもツール依存である（§0.0 の表と §0.8）。
  とくに **opencode は裁定を見送るとセッションが止まる**唯一のソースで、
  **codex は人が hook を trust するまで沈黙のうちに skip される**。
- **hook 到着 ≠ 起動完了**: §0.5 のとおり、未 trust ディレクトリでは
  trust ダイアログに答えるまで `SessionStart` すら来ない。
- **hook はすべて fail-open**: timeout も接続失敗もエージェントを止めない。
  CommandMate サーバが落ちていてもセッションは壊れず、イベントだけが失われる
  （`PermissionRequest` なら承認ダイアログが出るだけになる）。
- **`PermissionRequest` は headless `-p` では発火しない**: sandbox guard が先に弾くため、
  非対話実行は Auto-Yes v2 の裁定対象にならない（実測）。
- **ユーザーが「No」を選んだことは hook から分からない**: `PermissionDenied` は TUI で
  拒否しても発火しなかった（実測・登録済み 0 回）。拒否を検知する仕組みには使えない。

---

## 関連ドキュメント

- [実行契約（Task Contract）](../design/task-contract.md) — `success.autoVerifyOnStop`
- [検証設定](../design/verification-config.md) — 自動起動される検証ゲート
- [CLI 運用ガイド](./cli-operations-guide.md)
- [実機検証: Claude Code hooks](../design/agent-hooks-live-verification.md) —
  本ガイドの「実測」の出典（Issue #1721）。公式ドキュメントとの食い違いは §2 にある
- [実 payload fixture](../../tests/fixtures/hooks/claude/) — 実機で採取した 12 件
