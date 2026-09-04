[English](../en/user-guide/cli-operations-guide.md)

# CLI操作コマンドガイド

CommandMateのCLIから、起動中のエージェントセッションを操作するコマンドのガイドです。
これらのコマンドを使用することで、コーディングエージェント（Claude Code, Codex等）が他のエージェントを並列操作できるようになります。

---

## 前提条件

- CommandMateサーバーが起動中であること（`commandmate start --daemon`）
- 操作対象のworktreeがサーバーに登録済みであること（ブラウザUIのサイドバーに表示されていること）

### サーバーポートの指定

接続先は次の優先順位で解決されます（Issue #1743）。

1. シェルで明示的に指定した `CM_PORT`（例: `CM_PORT=3011 commandmate ls`）
2. `~/.commandmate/.env` の `CM_PORT`
3. デフォルト（`3000`）

```bash
# 1. その場限りで接続先を指定（.env より優先される）
CM_PORT=3011 commandmate ls

# 2. シェルで CM_PORT を指定しない場合は .env の値が使われる
#    （commandmate status が表示する Port と一致する）
commandmate ls
```

ホストとプロトコルも同じ設定から解決されます。`CM_BIND` が `0.0.0.0` の場合は `127.0.0.1` に接続し、`CM_HTTPS_CERT` と `CM_HTTPS_KEY` の**両方**が設定されている場合のみ HTTPS で接続します。

> **補足**: `commandmate status` は「サーバーが実際にどこで動いているか」を報告するため、`.env` がシェルの環境変数より優先されます（サーバープロセス自身がその順序で起動されるため）。一方 CLI の接続先解決は「今回の呼び出しをどこへ繋ぐか」なので、上記のとおりシェルの指定が優先されます。

### 認証付きサーバーへの接続

サーバーが `--auth` 付きで起動されている場合、`CM_AUTH_TOKEN` 環境変数でトークンを指定します。

```bash
# 推奨: 環境変数（プロセスリストに表示されない）
CM_AUTH_TOKEN=your-token commandmate ls

# 代替: --token フラグ（プロセスリストに表示されるため注意）
commandmate ls --token your-token
```

### 開発環境での実行

グローバルインストールなしでも、開発環境から直接実行できます。

```bash
# ビルド（初回のみ）
npm run build:cli

# 実行
node bin/commandmate.js ls
CM_PORT=3000 node bin/commandmate.js send abc123 "msg"
```

---

## コマンド一覧

| コマンド | 用途 |
|---------|------|
| [`commandmate ls`](#commandmate-ls) | worktree一覧の表示 |
| [`commandmate sync`](#commandmate-sync) | サーバーのworktree再スキャン（GUI同期ボタン相当） |
| [`commandmate send`](#commandmate-send) | エージェントへのメッセージ送信 |
| [`commandmate wait`](#commandmate-wait) | エージェント完了の待機 |
| [`commandmate respond`](#commandmate-respond) | プロンプトへの応答 |
| [`commandmate interrupt`](#commandmate-interrupt) | 生成中のターンの中断（GUI の中断ボタン相当） |
| [`commandmate verify`](#commandmate-verify) | 検証ゲート（.commandmate/verify.yaml）の実行と検証履歴の参照 |
| [`commandmate task`](#commandmate-task) | 実行契約（.commandmate/tasks/*.yaml）の一覧・詳細 |
| [`commandmate capture`](#commandmate-capture) | ターミナル出力の取得 |
| [`commandmate auto-yes`](#commandmate-auto-yes) | Auto-Yesの制御 |
| [`commandmate instances`](#commandmate-instances) | エージェントインスタンス（roster）の一覧・追加・削除・alias変更 |
| [`commandmate agents`](#commandmate-agents) | エージェント CLI の版表示と更新（pane の外で `codex update` を実行） |
| [`commandmate report`](#commandmate-report) | 日次レポートの生成・表示・一覧、Eval メトリクス集計 |
| [`commandmate skill`](#commandmate-skill) | 公式Skillのカタログ参照・Install/Update Plan・install・update・uninstall・status |
| [`commandmate update`](#commandmate-update) | CommandMate本体の更新（停止 → 更新 → 再起動） |
| [`commandmate remote`](#commandmate-remote) | スマホからの利用（Providerトンネルでの公開とQRペアリング） |

---

## commandmate ls

worktree一覧をステータス付きで表示します。

### 使用方法

```bash
commandmate ls                          # テーブル形式
commandmate ls --json                   # JSON形式（エージェント向け）
commandmate ls --quiet                  # IDのみ（1行1ID、パイプ用）
commandmate ls --branch feature/        # ブランチ名プレフィックスでフィルタ
commandmate ls --id anvil-              # worktree IDプレフィックスでフィルタ
```

> **`--id` について**: worktree ID は **worktree ディレクトリ名**由来のスラッグ（例 `commandmate-issue-1644`）です（Issue #1621。同名ディレクトリが複数リポジトリにある場合のみ `-<パスのハッシュ8桁>` が付きます）。`--id` はこの ID の前方一致でフィルタします。`--branch` と `--id` は独立して適用され、同時指定すると両方が適用されます（AND）。同一ブランチ名（例 `develop`）が複数リポジトリに存在する場合、`--id anvil-` のように ID プレフィックスで特定リポジトリの worktree に絞り込めます。前方一致は case-sensitive で、一意性は保証しません（`--id anvil-develop` は `anvil-develop-2` にもマッチし得ます）。厳密に1件へ絞るには `--quiet` の出力を `grep -x` する等してください。

### 出力例

```
ID                                               NAME                  STATUS   REASON                          DEFAULT
-----------------------------------------------  --------------------  -------  ------------------------------  ------
localllm-test                                    main                  ready    input_prompt                    claude
commandmate                                      develop               running  thinking_indicator              claude
commandmate-issue-518                            feature/518-worktree  ready    no_recent_output (no evidence)  claude
commandmate-main                                 main                  idle     -                               claude
```

> ID は **worktree ディレクトリ名**由来です（Issue #1621/#1645）。`/worktree-setup` が作る
> ディレクトリ名は既に Issue 番号を含むため、ID は旧形式（`<リポジトリ名>-<ブランチ名>`）より
> 短く読みやすくなります。NAME 列はブランチ名で、checkout のたびに更新されます。

### STATUS列の意味

| ステータス | 意味 |
|-----------|------|
| `idle` | セッション未起動 |
| `ready` | セッション起動中・入力待ち（タスク完了後の状態） |
| `running` | エージェントがタスク実行中 |
| `waiting` | 確認プロンプト待ち（Yes/No等） |

### REASON列の意味（Issue #1926）

STATUS の**根拠**です。同じ `ready` でも「エージェントが composer に戻った」（`input_prompt`）と
「画面が読めないまま出力も止まったのでフォールバックで ready と呼んでいる」（`no_recent_output`）は
別物で、これまで表からは区別できませんでした。

| 表示 | 意味 |
|---|---|
| `input_prompt` | composer（入力プロンプト）を検出した |
| `thinking_indicator` | 思考インジケータを検出した |
| `prompt_detected` | 確認プロンプトを解析できた |
| `<reason> (no evidence)` | **肯定的証拠なし**（`statusEvidence: 'none'`）。検出層が画面を分類できず、STATUS はフォールバック値です。現状は `default` と `no_recent_output` の 2 経路 |
| `-` | サーバーが理由を返さない。#1926 以前のサーバー／セッション未起動／そのツールに 2 つ以上のインスタンスがある（集約に単一の理由は無い）のいずれか |

> `(no evidence)` の行は「完了した」ではありません。`commandmate capture <id> --pane` で
> 生ペインを確認してください。同じ状態が 60 秒続くと `commandmate wait` は exit 10
> （`type: 'unclassified'`）を返します。

`--json` の値は**サーバーの行そのまま**で、理由と証拠は `sessionStatusByCli.<tool>` の下に入ります
（トップレベルには足していません。`GET /api/worktrees` と一致させるためです）。

```bash
commandmate ls --json \
  | jq -r '.[] | "\(.id)\t\(.sessionStatusByCli.claude.sessionStatusReason // "-")\t\(.sessionStatusByCli.claude.statusEvidence // "-")"'
```

| フィールド | 意味 |
|---|---|
| `sessionStatusByCli.<tool>.statusEvidence` | `'positive'`（何かが肯定的に確認した）／`'none'`（読めなかった） |
| `sessionStatusByCli.<tool>.sessionStatusReason` | スクレイパーの理由コード |
| `sessionStatusByCli.<tool>.lastKnownStatus` / `lastKnownStatusAt` | 最後に**肯定的に確認できた**状態とその時刻。サーバーのメモリ上に保持（TTL 30 分、再起動でクリア、セッション停止で破棄） |

---

## commandmate sync

サーバーにリポジトリの再スキャンを実行させ、worktree を DB に同期します（Issue #1680）。
GUI の worktree 同期ボタンと同じエンドポイント（`POST /api/repositories/sync`）を呼ぶため、
`git worktree add` で作成した worktree を CLI だけで `commandmate ls` に反映できます。

### 使用方法

```bash
commandmate sync                        # 再スキャン実行（サーバーのmessageを表示）
commandmate sync --json                 # 同期結果をJSON（APIレスポンス相当）で出力
```

### 出力例

```
$ commandmate sync
Successfully synced 12 worktree(s) from 3 repository/repositories
```

`--json` では `worktreeCount` / `repositoryCount` / `repositories` / `deletedCount` /
`cleanupWarnings` を含む API レスポンスをそのまま出力します。

### エラー

| 状況 | 動作 |
|------|------|
| サーバー未起動 | `Server is not running. Start it with: commandmate start`（exit 1） |
| リポジトリ未設定 | サーバーの 400 メッセージ（`WORKTREE_REPOS` / `CM_ROOT_DIR` の設定を案内）をそのまま表示（exit 2） |

### 典型的なフロー

```bash
git worktree add ../myrepo-issue-123 -b feature/123-fix origin/develop
commandmate sync                        # サーバーに新worktreeを認識させる
commandmate ls --id myrepo-issue-123    # 同期直後から見える
commandmate send myrepo-issue-123 "作業を開始してください"
```

---

## commandmate send

指定worktreeのエージェントにメッセージを送信します（非同期）。セッションが未起動の場合は自動的に起動します。

### 使用方法

```bash
commandmate send <worktree-id> "<message>"
commandmate send <worktree-id> "<message>" --instance codex    # codex のプライマリインスタンス宛て
commandmate send <worktree-id> "<message>" --instance codex-2  # 追加インスタンス宛て（roster登録済み）
commandmate send <worktree-id> "<message>" --agent codex --instance codex-3 --register  # 未登録IDをrosterへ登録
commandmate send <worktree-id> "<message>" --auto-yes          # Auto-Yes有効化
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
commandmate send <worktree-id> "<message>" --auto-yes --stop-pattern "FAILED"
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--instance <id>` | **送り先の推奨指定方法**。インスタンスID（`<agent>` または `<agent>-<n>`、例: `codex` / `claude-2`）。未起動なら自動起動 | エージェントのプライマリインスタンス |
| `--agent <id>` | roster に無いインスタンスをアドホック起動するときの補助（claude, codex, gemini, vibe-local, opencode, copilot, antigravity, command-code） | roster の値・worktree既定 |
| `--register` | `--instance` で指定したセッションをroster（エージェントインスタンス一覧）に登録 | - |
| `--auto-yes` | 送信前にAuto-Yesを有効化 | - |
| `--duration <d>` | Auto-Yesの有効期間（1h, 3h, 8h） | 1h |
| `--stop-pattern <p>` | Auto-Yes停止条件（正規表現、ターミナル出力への照合。[auto-yes の注意](#--stop-pattern-はターミナル出力への照合コマンドの抑止には使えない)参照） | - |

> `--instance` の詳細（ID規約・rosterとの関係）は [マルチセッション（1エージェント複数セッション）](#マルチセッション1エージェント複数セッション) を参照してください。

> **送り先は `--instance` で指定してください（Issue #1638）**。`--agent` を受け付けないコマンドが
> 1つだけあります（`wait`）。`send --agent codex` と書いて `wait` に何も付けないと、
> **待つ相手は worktree の既定エージェント**になり、Codex 用に切った worktree で黙って
> Claude Code の完了を待つことになります。`--instance` は 5 コマンド全てが受け付けるため、
> ワークフロー全体を同じフラグで書けます。

### プロンプト待ちのセッションへは送信できません（Issue #1708）

プロンプトダイアログが開いている間、キー入力は**エージェントに届きません**。ダイアログ自身の
入力欄に溜まるだけです。そのまま `respond` を送ると、その残留テキストごと送信され、
**「回答」ではなく「メッセージ」として届く**恐れがあります。停滞している worker に nudge を
送って状態を悪化させたのが Issue #1708 の実例です。

そのため、サーバがプロンプト待ちを報告している間の `send` は拒否されます。

```
$ commandmate send myrepo-issue-29 "まだ動いてる？"
Error: myrepo-issue-29 is waiting on a prompt. … Answer the prompt first: `commandmate respond myrepo-issue-29 <answer>`.
$ echo $?
2
```

- **`respond` / 特殊キー送信 / prompt-response は拒否されません。** これらはプロンプトを
  解消するための経路なので、塞ぐと回答手段が無くなります
- **タイマー送信も同じく拒否されます。** ガードは送信サービス層（`sendUserMessage`）に置いて
  あり、Web/CLI の送信とタイマー送信の両方がここを通ります。拒否されたタイマーは
  `[prompt_waiting] …` を失敗理由として記録するので、詳細モーダルで理由が読めます
- **拒否は検出できているときだけ効きます。** 検出をすり抜けたフレームはこのガードの対象外で、
  そちらは `wait` の `unclassified`（上記）が受け持ちます
- ペインをキャプチャできない場合は**拒否しません**（fail-open）。誤検知でセッションが
  書き込み不能になる方が被害が大きいためです。**つまりこれは「取りこぼしを減らすガード」で
  あって、「ダイアログに文字が絶対に入らない保証」ではありません**

#### 画面に見えないダイアログでも拒否されます（Issue #1737）

エージェントの hooks が報告したダイアログ（`Notification(permission_prompt)` など）は、
ターミナル側の解析が読めなくても拒否の根拠になります。#1708 の実害はまさに
「**画面からは読めないダイアログ**に nudge を打ち込んだ」ことなので、そこを塞ぐのが目的です。

構造化イベントだけが根拠のときは、拒否メッセージに**脱出手段**が併記されます。

```
$ commandmate send myrepo-issue-29 "まだ動いてる？"
Error: myrepo-issue-29 is waiting on a prompt. … This dialog was reported by the agent's own
hooks and is not visible to the terminal scraper, … it stops blocking sends 5 minutes after it
was reported, or immediately with `commandmate send myrepo-issue-29 <message>
--ignore-structured-prompt` (server-wide: CM_STRUCTURED_SEND_GUARD=off).
```

**セッションが書き込み不能にならないための 3 つの安全弁**があります。hooks は全経路
fail-open で、「人間が答えた」を示すイベントが届かない事故は起こりうるためです。

| 手段 | 使いどころ |
|------|-----------|
| **5 分の上限** | 何もしなくても、報告から 5 分経った構造化 waiting は `send` を止めません（画面に見えているプロンプトには上限はありません） |
| `send --ignore-structured-prompt` | ペインは平常なのに拒否され続けるとき。その 1 回だけ構造化側の拒否を無効化します |
| `CM_STRUCTURED_SEND_GUARD=off` | サーバ全体で構造化側の拒否を切る（サーバ再起動が必要） |

- どの手段も**画面に見えているプロンプトは拒否したままです**。そちらは `respond` で答えられる
  本物のダイアログで、打ち込むこと自体が #1708 の実害だからです
- 5 分の上限が効くのは **`send` の拒否だけ**です。`/current-output` の `isPromptWaiting` や
  `wait` の exit 10 は従来どおり報告され続けます（誤って「完了」と読ませないため）

### worktree ID の調べ方

```bash
# 全ID一覧
commandmate ls --quiet

# ブランチ名でフィルタしてID取得
commandmate ls --branch feature/101 --quiet
# → commandmate-issue-101

# worktree IDプレフィックスでフィルタ（同一プレフィックスのworktree絞り込み）
commandmate ls --id commandmate-issue- --quiet
# → commandmate-issue-101

# 変数に格納
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "実装してください"
```

> **ID はブランチを切り替えても変わりません**（Issue #1621）。以前の ID は
> `<リポジトリ名>-<ブランチ名>`（例 `mycodebranchdesk-feature-101`）で、同じディレクトリで
> `git checkout` するたびに別物になっていました。現在の ID は **worktree ディレクトリに
> 一度だけ**採番され、以後は checkout でも detached HEAD のコミットでも変わりません。
> ブランチ名は `commandmate ls` の NAME 列（`--json` の `branch`）に出ます。
>
> **以前の ID もそのまま使えます。** ID が変わった worktree については旧 ID が記録され、
> `send` / `wait` / `capture` / `respond` / `auto-yes` / `instances` / `verify` の
> `<worktree-id>` 引数と、ブラウザの `/worktrees/<旧ID>` が引き続き解決されます。
> `ls --id` の**前方一致だけは現在の ID に対して**行われます（旧 ID は完全一致でのみ解決）。
>
> ブラウザ URL は **HTTP 308 で現在の URL へ転送**されます（Issue #1645、実サーバで実測）。
> `/terminal` や `/files/...` などのサブパスとクエリも保持されるので、ターミナル画面の
> ブックマークはターミナル画面に着地します。
>
> **既存 worktree の ID はサーバ再起動時の migration で一度だけ振り直されます。** 稼働中の
> tmux セッションは起動時に新しい名前へ追従しますが、**並列ワーカーを動かしていない
> タイミングで当てる**こと — 監視スクリプトが旧 ID を握ったままだと、セッションは生きて
> いるのに `send` / `capture` が届かないという切り分けの難しい状態になります。

---

## commandmate wait

指定worktreeのエージェントが完了するまでブロッキング待機します。

> **完了判定は `sessionStatus === 'ready'`（かつ未分類フレームでない）またはセッション消滅。**
> エージェントが要求した作業を実際にやり遂げたかどうかは `--verify` / `--require-work`（下記）で
> 確かめてください。
>
> Issue #1839 で**ターン成立の判定が 1 つだけ入りました**。hooks が有効なインスタンス
> （`sessionStatusReason` が `hook_*`）で、この `wait` が開始した後にエージェント自身が
> ターン開始を報告している場合、**そのターンの `Stop` が届くまで完了とみなしません**
> （[ターン成立の判定](#ターン成立の判定issue-1839)）。hooks が来ていないセッションの挙動は
> 一切変わりません。

### 使用方法

```bash
commandmate wait <worktree-id> --timeout 300
commandmate wait <id1> <id2> --timeout 600          # 複数同時待機
commandmate wait <worktree-id> --on-prompt agent     # プロンプト検出で返却（デフォルト）
commandmate wait <worktree-id> --on-prompt human     # プロンプトは人間がUIで応答
commandmate wait <worktree-id> --stall-timeout 120   # 出力変化なしの検出
commandmate wait <worktree-id> --instance codex      # codex のセッションを待つ
commandmate wait <worktree-id> --verify               # 完了検知後に全ゲートを実行
commandmate wait <worktree-id> --require-work         # 完了検知後に work-evidence のみ実行
commandmate wait <worktree-id> --fail-on-upstream-fault  # 上流障害で composer に戻ったら exit 11
```

> **`wait` に `--agent` はありません（Issue #1638）**。送り先エージェントの指定は
> `--instance` で行ってください（`--instance codex` はそのCLIツールのプライマリインスタンスを指します）。
> `send --agent codex` と書いて `wait` に何も付けないと、`wait` は
> **worktree の既定エージェント**を見るため、まだ動いている codex を横目に「完了」を返しえます。
> 1回の `wait` に指定できる `--instance` は**1つ**で、引数の全 worktree に適用されます。
> インスタンスが異なる worktree は `wait` を分けてください。

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--timeout <sec>` | 最大待機時間（秒） | 無制限 |
| `--on-prompt <mode>` | プロンプト検出時の動作（agent / human） | agent |
| `--stall-timeout <sec>` | 出力変化なしのタイムアウト（秒） | - |
| `--instance <id>` | 対象インスタンスID（`<agent>` または `<agent>-<n>`）。**送り先指定はこのフラグのみ**（`--agent` は無い） | エージェントのプライマリインスタンス |
| `--verify` | 完了検知後に検証ゲートを全件実行し、その判定で終了コードを決める | 無効 |
| `--require-work` | 完了検知後に work-evidence ゲートのみ実行する | 無効 |
| `--fail-on-upstream-fault` | composer に戻った時点で上流障害の署名が画面にあれば exit 0 ではなく **11** を返す（Issue #1839） | 無効 |

### 終了コード

| コード | 意味 | 次のアクション |
|:------:|------|---------------|
| 0 | 正常完了（`--verify` 指定時は検証にも合格） | `capture` で結果取得 |
| 10 | プロンプト検出（`--on-prompt agent` 時） | `respond` で応答し、再度 `wait` |
| 11 | 上流障害（`--fail-on-upstream-fault` 指定時のみ、Issue #1839） | **`verify` を回さず**時間をおいて同じ内容を再 `send` |
| 20 | 検証ゲート不合格（`--verify`） | `verify --json` で失敗ゲートを確認し修正 |
| 21 | 作業証跡ゼロ（コミットも未コミット変更も無い）／セッションが一度も稼働していない | エージェントが着手していない。再度 `send` |
| 124 | タイムアウト | `capture` で状況確認、再度 `wait` or 中断 |

> **exit 21 が出たときは、まず送り先の解決を疑ってください（Issue #1884）**。
> `Not started: <id> has no running <agent> session for instance <x> (resolvedBy=...)` の
> 末尾が**解決の根拠**です。`resolvedBy=worktree-default` なのに `--instance` を渡している場合、
> その instance は roster にも無くツール名でもないため **worktree の既定エージェント**を
> 見に行っています（`commandmate instances <id>` で roster を確認してください）。
> `resolvedBy=fallback` は worktree 自身に CLI ツールが記録されていないという別の異常です。
> #1884 以前のサーバーはこの末尾を返さないので、**末尾が無いこと自体**が
> 「サーバーが `--instance` のツールを解決しない版である」ことを意味します。

### --verify / --require-work（Issue #1544）

`wait` の成功条件を「エージェントが止まった」から「**検証に合格した**」へ引き上げます。

- `--verify`: 全ゲート（work-evidence + `.commandmate/verify.yaml` の宣言ゲート）を実行
- `--require-work`: work-evidence ゲートのみ実行。全ゲートを回す前の安価な事前確認に使う
- 両方を同時指定してもエラーにはならない。work-evidence は常に全ゲートに含まれるため `--verify` が包含する
- **opencode を名指しした run だけ、work-evidence に第 2 の証跡が加わる（Issue #2043）**。
  git が「コミットも未コミット変更も無い」と判定した**その分岐でのみ**、opencode 自身の diff 台帳を参照し、
  ファイルが挙がっていれば合格にする（log_tail に `opencode session diff: N file(s) changed` が出る）。
  **`--instance` で opencode を名指ししたときだけ**参照する ―― work-evidence の git カウントは
  worktree 単位なので、名指しの無い `wait --verify` が同じ worktree の opencode ペインの diff を
  他ツールの判定に流用しないための制限。`requireCommit` は緩めない。
  これが要るのは、worktree 詳細に付いた **「このターンを取り消す（revert）」が、
  作業ツリーを git から見て「何もしていない」状態にしうる**ため。
  なお opencode の台帳は git snapshot なので、`.gitignore` された作業は opencode 側も見えない（実測）。
- 検証は**完了検知できたときだけ**走る。プロンプト検出（10）やタイムアウト（124）はそのまま返し、検証しない
- 複数 worktree を指定した場合、完了検知は並行・検証は**直列**。サーバ側が同時実行数を制限しているため
- 複数 worktree の終了コードは優先順位 **10 > 11 > 20 > 21 > 124** で集約される（Issue #1839 で 11 を追加）
- exit 11 は検証を**回しません**。走らなかったターンにゲートの判定を出すこと自体が、
  この Issue が終わらせにきた誤帰属です

```bash
commandmate wait "$WT" --timeout 1800 --verify
case $? in
  0)  echo "検証合格" ;;
  10) commandmate respond "$WT" "yes" ;;
  20) commandmate verify "$WT" --json ;;   # 失敗ゲートの詳細
  21) echo "エージェントが何も作っていない" ;;
esac
```

### --on-prompt の動作

| モード | 動作 |
|--------|------|
| `agent`（デフォルト） | プロンプト検出で即座に exit 10 で返却。stdoutにプロンプト情報をJSON出力 |
| `human` | プロンプト検出してもブロック継続。人間がブラウザUIで応答するまで待機し、最終的に exit 0/124 で返却 |

### プロンプト検出時のJSON出力（exit 10）

```json
{
  "worktreeId": "localllm-test-main",
  "cliToolId": "claude",
  "type": "yes_no",
  "question": "Do you want to proceed? [Y/n]",
  "options": ["yes", "no"],
  "status": "pending"
}
```

### exit 10 の `type`（種別）

`wait` が「人間待ち」と判断する事由は 3 種類あり、**すべて exit 10** で返ります。
新しい exit code を作らないのは、既に exit 10 で分岐している呼び出し側
（dispatch runner の `--auto-yes` 等）を壊さないためです。種別は `type` で判別します。

| `type` | 意味 | 応答方法 |
|--------|------|----------|
| `yes_no` / `multiple_choice` | プロンプトを検出・解析できた | `commandmate respond <id> <答え>` |
| `selection_list` | 矢印キー選択 UI（Codex の pager / `/model`、antigravity の権限メニュー、**opencode の permission ダイアログ**（`Allow once / Allow always / Reject`、Issue #1893）、**opencode のダイアログ全般**（セッション一覧 `ctrl+x l` / エージェント一覧 `ctrl+x a` / タイムライン `ctrl+x g` / コマンドパレット `ctrl+p` / ピッカー。`sessionStatusReason` は `opencode_modal_overlay`、閉じるのは `Escape`、Issue #2112）等、Issue #1628）。選択肢としては解析できない | `commandmate respond` ではなく矢印キー相当の特殊キー送信 |
| `unclassified` | **対話中の画面なのに検出層が分類できなかった**（Issue #1708）。`isUnclassifiedActive` が **60 秒連続**で立った場合のみ返る | 生ペインを見る: `commandmate capture <id> --pane` |

> **`selection_list` に `commandmate respond <id> <番号>` を送らないこと（Issue #1893）。**
> opencode の permission ダイアログは番号を持たないボタン列で、実測（1.18.21）では数字キーは無反応です。
> 数値回答はテキストとして送られたあと Enter が続くため、**ハイライトされているボタン（既定は `Allow once`）が
> 確定します** —— `respond <id> 3`（Reject のつもり）が承認に化けます。矢印キー相当の特殊キー（←/→ ＋ Enter）
> か、Web UI の NavigationButtons を使ってください。

`unclassified` は「検出漏れそのものを停止事由にする」ための安全網です。検出層をすり抜けると
auto-yes も契約の `autoYes` ポリシーも exit 10 も一切発火しないため、以前は `--timeout` を
使い切るまで誰も気づけませんでした。**瞬間値では止めません**（再描画中のキャプチャで 1 回だけ
立つことがあるため）。途中で分類できた時点で滞留カウンタはリセットされます。

`--on-prompt human` では、他の 2 種別と同様に stderr に理由を出して待機を継続します。

`--timeout` / `--stall-timeout` を 60 秒未満に設定した場合は常にそちらが先に効きます（この滞留判定は
長い待ちを先回りするためのもので、短い待ちを延ばすものではありません）。

> **この段落の要点は `commandmate wait --help` にも出ます（Issue #1926）。** 滞留判定は専用フラグを
> 持たない停止事由なので、オプション一覧を読んだだけでは存在に気づけません。60 秒・exit 10・
> `--stall-timeout` / `--timeout` との優先関係・`capture --pane` への導線を `--help` の
> `Unclassified frames` 節に置いています。

#### opencode で `unclassified` になったら、まずサイドバーを疑う（Issue #2095）

opencode のサイドバー（`ctrl+x b`、または `ctrl+p` パレットの `Show sidebar`）は、
**キャプチャの行を transcript と共有します**。ON の間はターンの終了マーカーが隠れるため、
**終わったターンが `running` / `unknown_frame` のまま**になり、60 秒後に `unclassified` で
exit 10 します。既定の 80 桁でも起こります（Issue #2046 の実測）。

`wait` はこのとき stderr に原因を出します。

```
Unclassified interactive frame on wt-1 for 60s (status=running/unknown_frame). …
 Cause: paneObstruction=opencode_sidebar — a second column is sharing rows with the
 transcript (it reads "/private/tmp/…"), which covers the marker that ends a turn.
 Press `ctrl+x b` in the pane to close opencode's sidebar.
```

`commandmate capture <id> --json` の `paneObstruction` にも同じ判定が出ます。

```bash
commandmate capture wt-1 --json | jq '.paneObstruction'
# { "id": "opencode_sidebar", "matchedText": "…", "at": 1756…  }
```

**復帰手段は opencode のペインで `ctrl+x b` をもう一度押すことだけです。Escape では戻りません**（実測）。
CommandMate のクイックキー列からは送れません —— このキーは #2046 の実測を受けて意図的に外してあり、
special-keys API も 400 を返します。Web UI の端末画面（PC / モバイル）には、
この状態のあいだ `ctrl+x b` を案内する警告バーが出ます。

`paneObstruction` が `null` なのは「サイドバーが無い」ではなく「レイアウトを読めなかった」です
（permission ダイアログが出ていると入力ボックスの下辺ごと隠れます）。all-clear として扱わないでください。
opencode 以外のツールでは常に `null` です（そもそも判定しません）。

#### `ready` は必ずしも「完了」ではありません

`isUnclassifiedActive` は次の 2 状態で立ちます。

```
(sessionStatus=running && reason=default) || (sessionStatus=ready && reason=no_recent_output)
```

後者は**読めないオーバーレイが劣化した姿**です。出力が止まったフレームは、サーバの Auto-Yes ポーラが
`lastServerResponseTimestamp` を打った時点から約 5 秒（`STALE_OUTPUT_THRESHOLD_MS`）で
`running`/`default` → `ready`/`no_recent_output` に反転します。つまり `ready` でも
「完了した」とは限らず、「まだ読めないうえに出力も止まった」という意味になり得ます。

そのため **`isUnclassifiedActive` が立っている間は `wait` は完了判定を行いません**。
本物の完了は `ready`/`input_prompt`（エージェントが composer に戻った状態）で、こちらはフラグを
立てないため従来どおり最初のポーリングで exit 0 になります。セッション自体が消えた場合も従来どおり
exit 0 です。

### ターン成立の判定（Issue #1839）

`wait` はこれまで「エージェントが composer に戻ったか」しか見ておらず、**そのターンが
成立したかどうか**を見ていませんでした。上流 API 障害でエージェントが何も実行せず即座に
composer へ戻ると、`wait` は exit 0 を返し、続く `--verify` は work-evidence ゼロ（exit 21）を
返します。呼び出し側はこれを「ターンは成立したが成果物が無い」と読み、同じ送信を無駄に
繰り返すことになります（実測 #1834: 上流 529 × 13 に対して exit 21 を 12 回）。

#### 実測（2026-08-20 / claude 2.1.236 / 隔離環境・実 API 不使用）

ローカル stub を `ANTHROPIC_BASE_URL` に据えて 529 を返させ、CommandMate が実際に注入する
hooks 設定を使って観測した結果です（詳細は
[docs/design/upstream-fault-turn-boundary-1839.md](../design/upstream-fault-turn-boundary-1839.md)）。

| 送信からの経過 | 観測 |
|---|---|
| +0.6 s | `UserPromptSubmit` hook が届く／上流へ 4 回 POST、すべて 529 |
| +3 s | スクレイパーが `ready` / `input_prompt`。pane に `API Error: Repeated 529 Overloaded errors …` |
| 最後まで | **`Stop` hook は 1 度も届かない** |
| +62 s | `Notification(idle_prompt)`（「Claude is waiting for your input」） |

#### 判定ルール

- hooks が来ていないインスタンスでは `turnStartedAt` が立たないため、**挙動は従来どおり**です
- この `wait` の開始（-5 秒の猶予）以降に `user_prompt_submit` / `pre_tool_use` / `post_tool_use`
  を観測すると、それを「このターン」として採用します。開始より古いイベントは採用しません
  （サーバー側の構造化イベントは世代で仕切られていないため、前プロセスの残骸で待ちが固まらないように）
- 採用したターンについて、**`lastStopEventAt` がその時刻以降になるまで完了とみなしません**
- **`idle_prompt` はターン終端として扱いません**。Issue #1839 の当初案は `stop` または
  `idle_prompt` でしたが、上の実測どおり `idle_prompt` は「何も実行しなかったターン」でも
  60 秒後に届くため、採用すると同じ誤判定が 1 分遅れで再現します
- 完了しない間は stderr に理由（`turnStartedAt` と `lastStopEventAt`）を出し続けます。
  最終的には `--timeout` で exit 124 になります — 「ゴミを 0 で通す」より「止める」ほうが安全です

#### `--fail-on-upstream-fault`

上のルールだけだと結果は exit 124 で、**原因が分かりません**。このフラグを付けると、
composer に戻った時点で `upstreamFault`（→ [capture の該当節](#upstreamfault上流障害の観測issue-1839)）が
非 null なら exit **11** を返し、何が一致したかを stderr に出します。

```bash
commandmate wait "$WT" --timeout 1800 --verify --fail-on-upstream-fault
case $? in
  0)  echo "検証合格" ;;
  10) commandmate respond "$WT" "yes" ;;
  11) sleep 600; commandmate send "$WT" "$SAME_MESSAGE" ;;   # ターンは走っていない。再送する
  20) commandmate verify "$WT" --json ;;
  21) echo "エージェントが何も作っていない" ;;
esac
```

- **既定では有効になりません**。`wait` の終了コードは skills 側 dispatch が分岐に使う公開契約で、
  途中で 529 を踏んで自力復帰したセッションは従来どおり exit 0 である必要があります
- 判定は**署名一致のみ**です。`upstreamFault` が null であることは「上流が健全」を意味しません

### 進捗表示

進捗メッセージはstderrに出力されます。stdoutは最終結果（JSON）のみです。
完了行には**何を根拠に完了と判定したか**が付きます（Issue #1839）。

```
# stderr:
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Completed: localllm-test-main (basis=hook_stop)
```

| `basis` | 意味 |
|---|---|
| `hook_stop` | エージェント自身が、この `wait` が採用したターンの終了を報告した |
| `session_gone` | 一度動いていた tmux セッションが消えた |
| `scraper_ready` | 画面が composer に戻っただけ。**誰も裏付けていない**（hooks が無いインスタンスの通常経路） |

---

## commandmate respond

エージェントのプロンプト（確認ダイアログ等）に応答を送信します。

### 使用方法

```bash
commandmate respond <worktree-id> "yes"          # Yes/No（複数選択では肯定選択肢へ意味解決）
commandmate respond <worktree-id> "2"            # 複数選択（番号）
commandmate respond <worktree-id> "text"         # テキスト入力
commandmate respond <worktree-id> --default      # default 選択肢を明示的に選ぶ
commandmate respond <worktree-id> "yes" --instance codex          # プライマリインスタンス指定
commandmate respond <worktree-id> "yes" --instance codex-2        # 追加インスタンス宛て
```

### yes / no の意味解決（Issue #1681）

複数選択（multiple_choice）プロンプトへの `yes` / `no`（`y` / `n`）は、選択肢ラベルを正規化して
肯定（`Yes...`）/ 否定（`No...`・`Deny`）の**選択肢番号に解決してから**送信します。カーソルナビ型
メニュー（claude / antigravity）ではテキスト入力が無視され Enter が default 選択肢の選択に
化けるため（`respond no` が承認になる事故）、テキスト+Enter では送りません。

- 肯定候補が複数ある場合（例: `1. Yes` / `2. Yes, allow all edits...`）は**最も番号の小さい選択肢**
  （= 最小権限）を選びます
- 解決できない場合（yes/no 系ラベルが無い・チェックボックス型・選択肢を読めない）は**何も送信せず**
  exit 99（`unresolvable_answer`）で失敗します。番号で応答してください
- 解決結果は監査のため stdout に出力されます: `Resolved "no" to option 3: No, and tell Claude ...`
- `--default` は default 選択肢（❯ ハイライト位置）を明示的に選びます（`<answer>` と排他）

### 構造化 decision への番号写像（Issue #2040）

**エージェントが decision ごとの ID を publish する場合**（`capture --json` の
`structuredEvents.source.capabilities.eventIdentity` が `null` 以外。実装上は現在 opencode のみ）、
`respond <worktree-id> <n>` は **pane にキーを送らず**、そのインスタンスが保持している
decision へエージェント自身の API で回答します。

- **承認（permission）** → `POST /permission/:id/reply`。番号は 3 つの verdict です:
  `1` = Allow once / `2` = Allow always / `3` = Reject（`once` / `always` / `reject` / `yes` / `no` も同義語として解決）
- **質問（question）** → `POST /question/:id/reply`。番号は**その質問が publish した選択肢の並び順**です。
  ラベル（`Blue`）・自由入力（`neither, use green`）でも回答できます

**回答されるのは「保持している decision がちょうど 1 件」のときだけです。**

| 保持数 | 結果 | pane |
|:------:|------|------|
| 0 件 | exit 99（`decision_not_found`）| **何も送らない** |
| 1 件 | 回答して exit 0 | **何も送らない** |
| 2 件以上 | exit 99（`multiple_pending_decisions`）。開いている decision の ID / kind を stderr に列挙 | **何も送らない** |

番号は「どれかの一覧の中の位置」であって、どの一覧かは呼び出し側が言っていません。2 件以上あるときに
最も古いものへ当てにいくと、利用者が見てもいない承認に答えてしまうため、拒否します。個別に答えるには
列挙された ID を使って `POST /api/worktrees/<id>/respond` に `{"decisionId": "...", "answer": "3"}` を
送るか、ターミナルで直接答えてください。

`eventIdentity: null` のエージェント（claude / codex / gemini / copilot / antigravity）は**従来どおり**
`/prompt-response` 経由のキー送出です。`--default` も従来どおりで、これは意図的です:
TUI にはハイライトされた選択肢がありますが、それがどれかは wire 上のどこにも書かれていないため、
構造化経路は `--default` を拒否します（一方でキー送出経路の Enter は実際に答えになります）。

判定に使うのはツール名ではなく**サーバが申告した capability** です。そのため `respond` は送信前に
`GET /api/worktrees/<id>/current-output` を 1 回だけ読みます。この読み取りが失敗した場合
（古い daemon・サーバ停止など）は**従来経路にフォールバック**します。

### 終了コード

| コード | 意味 |
|:------:|------|
| 0 | 応答成功 |
| 2 | 引数エラー（`<answer>` と `--default` の同時指定・両方欠落 等）/ 選択肢に無い番号（`answer_out_of_range`）|
| 99 | プロンプトが既に消えている（`prompt_no_longer_active`）/ yes・no を選択肢に解決できない（`unresolvable_answer`）/ 保持している decision が 0 件（`decision_not_found`）・2 件以上（`multiple_pending_decisions`、Issue #2040）|

---

### commandmate interrupt

生成中のターンを中断します。GUI の中断ボタンと**同じ** `POST /api/worktrees/:id/interrupt` を呼びます。

> **`stop` ではありません。** `commandmate stop` は CommandMate **サーバ**を止めるコマンドです。
> エージェントの生成を止めるのはこの `interrupt` です。

### 使用方法

```bash
commandmate interrupt <worktree-id>                     # 稼働中の全セッションを中断
commandmate interrupt <worktree-id> --instance codex-2  # インスタンスを指定して中断
commandmate interrupt <worktree-id> --json              # interrupted[] を JSON で取得
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--instance <id>` | 中断するインスタンス（`<agent>` または `<agent>-<n>`） |
| `--json` | API レスポンスをそのまま JSON 出力（`success` / `message` / `interrupted[]`） |
| `--token <token>` | 認証トークン（`CM_AUTH_TOKEN` 推奨） |

`--instance` を**省略した場合は「既定エージェント」ではなく、その worktree で稼働中の全セッション**が
対象になります（ルート側の仕様）。`send` / `respond` / `capture` の `--instance` 省略時とは既定が
異なる点に注意してください。

`--agent` はありません（`wait` と同じ理由 — Issue #1629。ツール名だけでは「どのセッションか」が
決まらないため）。roster 登録済みインスタンスは `--instance` だけで CLI ツールまで解決されます。

### JSON 出力

```bash
$ commandmate interrupt anvil-develop --json
{
  "success": true,
  "message": "Interrupt sent to 1 session(s)",
  "interrupted": [
    {
      "cliToolId": "opencode",
      "instanceId": "opencode",
      "sessionName": "mcbd-opencode-anvil-develop"
    }
  ]
}
```

対象セッションが無い場合も `--json` は同じフィールド名で返します（`interrupted` は**空配列**であって
欠落ではありません。呼び出し側が `.interrupted.length` を読めるようにするためです）。

```bash
$ commandmate interrupt anvil-develop --json ; echo "exit=$?"
{
  "success": false,
  "message": "No active sessions found",
  "interrupted": []
}
exit=30
```

### 終了コード

| コード | 定数名 | 意味 |
|:------:|--------|------|
| 0 | SUCCESS | 1 つ以上のセッションを中断した |
| 2 | CONFIG_ERROR | worktree ID / `--instance` の形式不正、インスタンスの CLI ツールを解決できない（400 passthrough）|
| 30 | NO_ACTIVE_SESSIONS | worktree は存在するが稼働中セッションが無く、**何も中断していない** |
| 99 | UNEXPECTED_ERROR | worktree が見つからない、その他の失敗 |

30 は「既に止まっている（=目的の状態に到達済み）」、99 は「ID が違う」で、必要な復旧が逆になります。
サーバはどちらも 404 で返すため（機械可読な `code` は付きません）、CLI 側でメッセージ
`No active sessions found` を見て振り分けています。

stderr は次の形です（`--instance` を指定したときはインスタンス名も入ります）:

```
Error: No active sessions found for worktree 'anvil-develop'. Nothing was interrupted.
```

### opencode での中断経路（Issue #2034 / #2101）

opencode では、まず **opencode 自身のサーバへ `POST /session/:id/abort`** を投げます（一次経路）。
これが適用できた場合はログに `opencode-interrupt-aborted-via-api` が出ます。適用できなかった場合のみ
Esc ×2（`opencode-interrupt-sent`）にフォールバックします。Esc 1 回では opencode のターンは
止まりません（実測。`src/lib/cli-tools/opencode.ts` の docblock 参照）。

中断されたターンは `· interrupted` で終わり、`· 11.3s` のような duration 付き完了マーカーを残しません。
そのため `sessionStatus` は「肯定的な完了検知」ではなく staleness フォールバック経由で `ready` に
戻ります（Issue #1893 と同じ扱い）。

---

## commandmate verify

`.commandmate/verify.yaml` に宣言された検証ゲートを worktree の作業ディレクトリで実行し、終了コードで合否を返します。

サーバは検証要求に対して 202 と runId のみを返す（ゲートはテストスイートやビルドで数分かかる）ため、CLI は run が終端ステータスに達するまで 5 秒間隔でポーリングします。

### 使用方法

```bash
commandmate verify <worktree-id>                       # 全ゲート実行
commandmate verify <worktree-id> --gates lint,unit     # ゲートを絞る
commandmate verify <worktree-id> --json                # run + gate results を JSON 出力
commandmate verify <worktree-id> --timeout 1800        # 超過で exit 124

commandmate verify history                             # 過去の run 一覧（読み取り専用）
commandmate verify show <run-id>                       # run の詳細（読み取り専用）

commandmate verify init                                # CI 定義から verify.yaml を起案（Issue #2061）
commandmate verify init --dry-run                      # 草案を表示するだけ（書き込まない）
commandmate verify init --cwd <path> --json            # 対象リポジトリ指定 / 機械可読出力
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--gates <id1,id2>` | 実行するゲートID（カンマ区切り） | work-evidence + 宣言された全ゲート |
| `--instance <id>` | run を紐づけるエージェントインスタンスID | なし（worktree 単位の run） |
| `--timeout <sec>` | ポーリングを打ち切るまでの秒数 | 無制限 |
| `--json` | run と gate results を stdout に JSON 出力 | 無効 |

### 終了コード

| コード | 意味 | 次のアクション |
|:------:|------|---------------|
| 0 | 全ゲート合格 | - |
| 20 | ゲート不合格（failed / timeout / error） | 失敗ゲートの logTail を見て修正 |
| 21 | work-evidence 不合格（コミットも未コミット変更も無い） | エージェントが着手していない |
| 99 | 判定不能（verify.yaml 不正、全ゲート skipped、cancelled） | verify.yaml と実行ディレクトリを確認 |
| 124 | `--timeout` 超過（サーバ側の run は継続中） | 時間をおいて再確認 |

`error` / `cancelled` を 20 ではなく 99 に割り当てているのは、「判定できなかった」が「判定した結果ダメだった」として読まれないようにするためです。

### 出力

進捗（GATE 行）は stderr、判定（RESULT 行）は stdout に出力されます。不合格ゲートは logTail も stderr に続けて出力します。表示は**末尾 40 行**まで（超過分は `... (+N more lines; run \`commandmate verify show <run-id>\` for the full log)` の 1 行に畳まれます。Issue #1683）。

scope ゲート不合格の logTail には**違反 path 一覧**（最大 100 件、超過は `... and N more`）と、意図した差分なら契約の `scope.allow`（＝Issue の対象ファイル）へ path を追加して `send --contract` で**送り直す**定型ガイダンスが含まれます（scope は送信時スナップショットで裁定されるため、契約 YAML の編集だけでは判定は変わりません）。合格・不合格を問わず、許可された変更とそれを許可したパターンは `admitted:` 節に残ります（下記）。

```
# stderr:
Verifying: commandmate-issue-101 (run 42)
GATE work-evidence PASS (commits=3, uncommitted=2)
GATE lint PASS (exit=0, 12.3s)
GATE unit FAIL (exit=1, 45.0s)

# stdout:
RESULT failed
```

### commandmate verify init — CI 定義から起案する（Issue #2061）

`.commandmate/verify.yaml` が無いリポジトリで、**そのリポジトリ自身の CI 定義**から草案を
生成します。`.github/workflows/*.yml` の各 `run:` ステップと `package.json` の `scripts` を
読み、ゲートにできるものだけを宣言します。

```bash
$ commandmate verify init --dry-run     # まず中身を見る
$ commandmate verify init               # 納得したら書き出す
Wrote .commandmate/verify.yaml with 11 gate(s).
Scanned: .github/workflows/ci-pr.yml, package.json
  token-discipline  node scripts/check-token-discipline.mjs  <- .github/workflows/ci-pr.yml (job: token-discipline, step: ...)
  lint              npm run lint                             <- .github/workflows/ci-pr.yml (job: lint, step: Run ESLint)
  ...
```

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--cwd <path>` | 起案対象のリポジトリ | カレントディレクトリ |
| `--dry-run` | 草案を stdout に出すだけで書き込まない | 無効 |
| `--json` | 草案（ゲート・拒否理由・走査したファイル）を JSON 出力 | 無効 |

**この 1 本だけはサーバを必要としません。** verify.yaml がまだ無い段階で走らせるコマンドなので、
`commandmate start` を前提にすると起動の前提がその起動自身になります。

**既存ファイルは決して上書きしません**（`--force` は用意していません）。既存の verify.yaml は
そのリポジトリ自身の判断であり、多くは各ゲートの根拠がコメントで併記されています。
既にある場合は exit 2 で、そのパスを名指しして終了します。捨てるつもりならファイルを削除してください。

ゲートにしなかったコマンドは**理由つきで stderr に出ます**（`setup` / `network` / `release` /
`container` / `mutating` / `long-running` / `multi-line` / `multi-command` / `runner-specific` /
`not-a-check` / `interactive` / `redundant` / `unquotable` / `reserved-id`）。
`npm ci` や `npm publish`、`npm audit`、`test:e2e` はゲートになりません
（ゲートは**何度でも安全に再実行できるコマンド**に限るため）。
判定基準の一覧は [`docs/design/verification-config.md` §11](../design/verification-config.md) を参照。

**草案は草案です。** CI が既に走らせているものを写しただけで、そのリポジトリが十分と
考える集合ではありません。書き出したら中身を読み、1 回実行して `RESULT passed` を確認してください。

Web UI では Verification ペインの「CI から起案する」ボタンが**同じ実装**を呼びます
（`POST /api/worktrees/:id/verify/config`）。起案ロジックの実体は
`src/lib/verification/verify-draft.ts` の 1 本だけです。

### CI と同じ検査を宣言する（Issue #1882）

`wait --verify` の exit code は `/orchestrate` がワーカーの完了を裁定する根拠なので、**宣言ゲートが
見ていない CI ジョブは、裁定が緑でも赤になりうる**。PR #1881 では全ゲート exit 0 の commit が
CI の `Token discipline` で FAILURE になった（宣言ゲートが lint / typecheck / unit の 3 本だけだった）。

このとき **verify.yaml へ検査本体（`git grep` や閾値）をコピーしてはいけない**。同じ検査の実装が
2 箇所に増え、片方だけ更新されて静かに乖離する。乖離は「verify は緑・CI は赤」の向きに倒れるので、
塞ごうとした事故そのものが再発する。正しい形は**両方が同じスクリプトを呼ぶ**こと。

```yaml
# .commandmate/verify.yaml
gates:
  - id: token-discipline
    command: "node scripts/check-token-discipline.mjs"   # ← CI の run: と同一
    timeoutSec: 120
```

```yaml
# .github/workflows/ci-pr.yml — ジョブ側は呼ぶだけ
      - name: Guard against raw gray/slate + chromatic colors in migrated directories
        run: node scripts/check-token-discipline.mjs
```

**何を宣言し、何を宣言しないか**は所要時間で決まる。宣言ゲートは既定で毎ラン走るため
（「宣言はするが既定では走らない」フラグはスキーマに無い）、1 本の追加はワーカー 1 体あたりの
裁定時間にそのまま乗る。CommandMate 本体では静的ガード 3 本（各 0.1 分）を足し、
Integration（2.1 分）/ Legacy tmux（Docker 必須）/ Security Audit（ネットワーク依存）/
Build（稼働サーバの成果物を差し替える）/ E2E（5 分超）は**足していない**。

### 並列 worktree と共有資源（Issue #1771）

固定ポート・ローカル DB・エミュレータを掴むゲートは、並列 worktree で重なると後発が
資源衝突で落ちます。記録は `GATE e2e FAIL exit=1` だけなので、**変更の欠陥なのか環境の
衝突なのかが読めません**。対処は 2 つあり、**先に試すべきは 1 つ目**です。

**1. worktree ごとに資源を分ける（並列度が保てるのはこちらだけ）**

コマンド系ゲートには常に次の 2 変数が渡ります。

| 変数 | 値 | 用途 |
|---|---|---|
| `CM_WORKTREE_ID` | worktree ID | コンテナ名・DB 名・ログディレクトリ |
| `CM_WORKTREE_INDEX` | `0..1023` の整数。worktree ごとに一意で、同じ worktree なら毎回同じ | ポート等の数値資源 |

```yaml
gates:
  - id: e2e
    command: "sh -c 'E2E_PORT=$((60400+CM_WORKTREE_INDEX)) npm run test:e2e'"
    timeoutSec: 1800
```

**2. `mutex` で直列化する（資源を分けられない場合）**

```yaml
gates:
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
    mutex: e2e-port      # 同名 mutex のゲートはマシン全体で同時に 1 つだけ
```

ロックは `~/.commandmate/locks/<name>.lock`（`mkdir` 方式）で、CommandMate の runner と
`cmate-verify` の standalone runner が**同じパス規約**に従います。待ち時間は
`duration` に混ぜず `waited=` として別に出ます。

```
GATE e2e PASS (exit=0, 190.0s, waited=42.3s)
```

ロックが `timeoutSec` の間ずっと空かなければ、ゲートは **TIMEOUT ではなく SKIP** になります。

```
GATE e2e SKIP (reason=mutex-wait waited=600.0s)
```

コマンドは 1 度も起動していないので「失敗」とは記録しません。run は `error` ＝ **exit 99
（判定不能）** であって 20（不合格）ではありません。時間をおいて再実行してください。

> **注意**: `mutex` を受理するのは現時点で CommandMate の runner だけです。`cmate-verify`
> skill の standalone runner は v1 を閉じたキー集合として扱うため、`mutex:` を書いた
> verify.yaml は**設定エラー（exit 2）で一切走りません**。両方で回すリポジトリでは、
> skill 側へ移植されるまで `mutex:` を書かないでください。

### 環境・乱数由来の赤を FLAKY として名指す（Issue #1772）

「この 1 件だけ赤ならまず再実行してみる」は長く**人間の部族知識**でした。並列委任の下では、
ワーカーもオペレータも赤の原因を自分の変更に求めて時間を焼きます
（実測: 禁止語検査の `not.toContain("fac-")` が乱数 UUID の `9fac-` に一致して fail し、
同一 tree で再実行したら pass）。

ゲート単位の opt-in で、**fail したら同一 tree でもう 1 回だけ**再実行できます。

```yaml
gates:
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
    retryOnFail: 1        # 0 か 1 のみ。省略時 0（＝再実行しない）
    flakyIsPass: false    # 省略時 false。FLAKY を pass 扱いにするか
```

1 回目 fail → 2 回目 pass のとき、GATE 行は `FLAKY` になり **両ランの exit と duration**
が出ます。2 回とも fail なら `FLAKY` にはならず `FAIL` のままです。

```
GATE unit FLAKY (exit=1,0, 45.0s,44.0s)
GATE e2e FAIL (exit=1,1, 45.0s,44.0s)
```

| | 既定（`flakyIsPass` 未宣言） | `flakyIsPass: true` |
|---|---|---|
| ゲートの裁定 | **fail** | pass |
| RESULT / exit code | `failed` / **20** | `passed` / **0** |
| GATE 行 | `FLAKY` | `FLAKY`（綴りは変わりません） |

**既定は「FLAKY は fail 扱い」です。** `retryOnFail: 1` を書いてもゲートは 1 bit も
弱くなりません — 買えるのは「何が起きたか」に名前が付くことだけで、pass ではありません。
`flakyIsPass` は**ゲート単位**の宣言で、`retryOnFail: 1` を伴わない `flakyIsPass: true` は
設定エラーです（再実行が無ければ FLAKY は発生せず、その宣言は何も変えないため）。

再実行するのは**非ゼロ終了（FAIL）だけ**です。TIMEOUT は再実行しません（そのゲートは
既に予算を使い切っており、2 回目は実時間をそのまま倍にします）。mutex 待ちの SKIP や
起動失敗も、コマンドが 1 度も走っていないため対象外です。

両ランの記録は `verify show <run-id>` で読めます（`--json` では `gates[].flaky` として
構造化されます）。`verify history` の**一覧行には出ません** — 一覧はログ本体を返さない
設計のためで、run を絞ってから `show` を見てください。

```
$ commandmate verify show 42
  unit  failed  exit=1  89.0s  src=verify.yaml  FLAKY
    | [flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=fail
    | --- [flaky] run 1/2: failed exit=1 duration=45.0s ---
```

> **注意**: `retryOnFail` / `flakyIsPass` を受理するのは現時点で CommandMate の runner
> だけです。`cmate-verify` skill の standalone runner は v1 を閉じたキー集合として扱うため、
> これらを書いた verify.yaml は**設定エラー（exit 2）で一切走りません**。両方で回す
> リポジトリでは、skill 側へ移植されるまで書かないでください。

### scope ゲートの証跡 — 何がどのパターンで許可されたか（Issue #1841）

`scope.allow` に完全一致 path しか書かない運用なら「パターン＝ファイル」なので追加情報はありませんが、
`src/**` のような glob（Issue #1546）では **その run で実際に何が許可されたか**が契約からは読めません。
そこで scope ゲートの logTail に `admitted:` 節を出し、変更ファイルごとに**それを許可した allow パターン**を残します。

```
scope: baseRef=origin/develop changed=3 violations=1
allow: src/**, docs/*.md
deny: src/secret/**
admitted:
  + docs/x.md  ← docs/*.md
  + src/a/b.ts  ← src/**
out of scope:
  - src/secret/key.ts  ← src/secret/**
To allow this diff, add the paths above to the contract's scope.allow ...
```

- 記録するのは**宣言順で最初に一致したパターン**です（`allow: ["src/**", "src/lib/**"]` なら
  `src/lib/a.ts` は `src/**`）。後ろの方を名指しすると「消しても判定が変わらないルール」を
  読者に提示することになるためです
- `allow` のどれにも書かれていないのに許可された path は `(exempt: .commandmate/)` /
  `(exempt: contract path)` と名乗ります。括弧付きなのは、契約を grep しても見つからないことが
  事実だからです（そこには何も書かれていない）
- `deny` で落ちた path は `admitted:` に入らず、`out of scope:` 側に**拒否した deny パターン**が付きます。
  `deny:` 見出しは「宣言されたもの」の一覧で、こちらは「この path が踏んだもの」です
  （＝「revert する」か「allow を広げる」かの違い）
- `admitted:` / `out of scope:` はそれぞれ**最大 100 件**で、超過時は `  ... (+N more)` /
  `  ... and N more` と明示します。**切り詰めは表示上の規則で、判定は全ファイルに対して行われます**
- `admitted:` は `out of scope:` より**前**に出ます。不合格ゲートの stderr 表示は末尾 40 行までなので、
  長い `admitted:` を後ろに置くと違反一覧とガイダンスが画面外へ流れるためです

`--json` では、`scope` ゲートの結果に機械可読の `scope` フィールドが付きます
（`verify --json` と `verify show --json` の両方。**既存フィールドは一切変わりません**）。

```jsonc
{
  "gates": [
    {
      "gateId": "scope",
      "status": "failed",
      "exitCode": 1,
      "logTail": "scope: baseRef=... (上の全文がそのまま残る)",
      "scope": {
        // 許可された変更と、それを許可したパターン（最大 100 件）
        "admitted": [
          { "path": "docs/x.md",  "pattern": "docs/*.md" },
          { "path": "src/a/b.ts", "pattern": "src/**" }
        ],
        // scope 外の path（最大 100 件）
        "violations": ["src/secret/key.ts"],
        // ゲートが全ファイルに対して数えた実数。上の 2 配列は 100 件で切れるので、
        // 「scope 外が在るか」は必ず totals.violations で判定すること
        "totals": { "changed": 3, "admitted": 2, "violations": 1 }
      }
    }
  ]
}
```

`scope` フィールドは **scope ゲートが実際に判定したときだけ**付きます。`skipped`（契約なし /
`requireScopeClean: false` / 契約に結び付かなかった）や `error`（baseRef 未解決）の logTail は
レポートではなく 1 文のメッセージなので、フィールドごと不在です — 空の `admitted` を出すと
「判定した結果 1 件も許可されなかった」と読まれてしまうためです。

### 実行中コンフリクト（409）

1つの worktree に対して同時に走らせられる run は1つだけです。既に走っている場合は実行中の runId を含むメッセージで終了します。

```
Error: A verification run is already in progress for 'commandmate-issue-101' (run 41). Wait for it to finish, then retry.
```

### 稼働サーバの作業ディレクトリでは走らない

`verify.yaml` の `options.skipInPrimaryCheckout: true` は、サーバプロセス自身の作業ディレクトリと一致する worktree でコマンドゲートを `skipped` にします。配信中のビルド成果物を `npm run build` が差し替えて画面を壊す事故を防ぐためです。

skipped を含む run は `passed` ではなく `error`（exit 99）になります。「検証しなかった」が「検証して問題なかった」として読まれないようにするためです。

### 契約ファイルは作業証跡に数えない

`.commandmate/tasks/` 配下は work-evidence（commits / uncommitted）からも scope の変更集合からも除外されます（Issue #1580）。そのため契約を worktree に**未コミットのまま置いてすぐ `send` してよく**、事前に base ブランチへマージする必要はありません。契約だけが置かれた worktree は `commits=0 uncommitted=0` のまま exit 21（作業証跡ゼロ）になります。

`.commandmate/verify.yaml` は**除外されません**。契約本体は送信時にスナップショットされるので後編集が判定に影響しない一方、verify.yaml のゲート定義は毎ラン読み直されるため、エージェントが自分のゲートを弱めた場合に scope の `deny` で検出できる状態を残しています。

### 検証履歴を読む（Issue #1593）

過去の run は `verify history` で一覧し、`verify show <run-id>` で中身を見ます。どちらも**読み取り専用**で、検証を新たに走らせることはありません。

```bash
commandmate verify history                             # 全 worktree の直近50 run
commandmate verify history --worktree <worktree-id>    # worktree で絞る
commandmate verify history --days 14 --limit 100       # 期間と件数で絞る
commandmate verify history --json                      # JSON 配列で出力
commandmate verify show 42                             # run 42 の詳細（logTail 込み）
commandmate verify show 42 --json                      # JSON で出力
```

#### verify history のオプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--worktree <id>` | 対象 worktree を1つに絞る | 全 worktree |
| `--days <n>` | 何日前まで遡るか（1..90） | 制限なし（`--limit` のみが効く） |
| `--limit <n>` | 取得する run の最大数（1..500） | 50 |
| `--json` | run の配列を stdout に JSON 出力 | 無効 |

人間可読出力は 1 run 1 行です。先頭の `#<run-id>` が `verify show` に渡す ID です。

```
#42  2026-07-31T04:12:00.000Z  myrepo-feature-101  manual  failed  failed: unit,build
#41  2026-07-31T03:58:00.000Z  myrepo-feature-101  wait    passed
```

一覧には**ゲートのログ本文（logTail）は含まれません**。500 run 分のログ末尾を毎回返すと一覧が MB 級になるためで、ログが必要なときは `verify show` を使います。`--json` の一覧に `logTail` フィールドは存在しません（`null` ではなく不在です）。

`verify show` はゲートごとに status / exit code / 所要時間を並べ、logTail を `| ` プレフィックス付きで展開します。

```
run #42  failed  worktree=myrepo-feature-101  trigger=manual
started=2026-07-31T04:12:00.000Z  finished=2026-07-31T04:15:20.000Z
baseRef=origin/develop  instance=-  task=-
  work-evidence  passed  exit=0  0.2s
  unit  failed  exit=1  45.0s
    | 2 tests failed
    | expected 1 to be 2
```

#### 終了コード

`history` / `show` は **20 / 21 を返しません**。この2つは「今のツリーが検証に落ちた」という意味であり、過去の run への問い合わせは現在のツリーへの判定ではないからです。

| コード | 意味 |
|:------:|------|
| 0 | 取得成功（該当0件でも 0。人間向けには stderr に `No verification runs found.`、`--json` では `[]`） |
| 2 | 引数不正（`--days` / `--limit` が範囲外、worktree ID 形式不正、run ID が正の整数でない）。HTTP 前に弾く |
| 99 | 指定した run が存在しない（404）ほか予期しないエラー |

---

## commandmate task

`.commandmate/tasks/<name>.yaml` に宣言した**実行契約**を送信し、記録された task を参照します。

契約は「目的・変更許可スコープ・合格条件・Auto-Yes ポリシー」を**送信前に宣言**するもので、
送信メッセージにそのまま埋め込まれ、`verify` の既定ゲートにもなります。
正準仕様は [docs/design/task-contract.md](../design/task-contract.md)。

> 本フェーズ（#1545）の契約は**宣言**であって**強制**ではありません。
> scope のゲート化は #1546、autoYes の enforcement は #1547 です。

### 契約付き送信（`send --contract`）

```bash
# 契約を送る。message 引数は取らない（契約の goal が本文になる）
commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml

# task id は stdout に出るので変数に取れる
TASK=$(commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml)

# 既存オプションと併用できる
commandmate send myrepo-feature-101 --contract .commandmate/tasks/loader.yaml \
  --instance codex-2 --auto-yes --duration 3h
```

エージェントには契約前文＋goal が送られます。前文の「完了条件」行は
`verify.yaml` の `gates[].command` を解決した**実コマンド**で書かれます。

```
## 実行契約
- 変更してよいのは次のパスのみ: src/lib/tasks/**, tests/unit/tasks/**
- 作業完了後は必ず commit すること（未 commit の作業は未完了とみなされる）
- 完了条件: 次の検証コマンドがすべて成功すること: npm run lint / npx tsc --noEmit

## タスク
（契約の goal）
```

契約が不正な場合は **exit 2** で、違反が**全件**表示されます（task は作られません）。
`verify.gates` が `verify.yaml` に無いゲート id を指している場合もここで弾かれます。

```
Error: invalid task contract:
  - version: must be 1 (got 3)
  - scope.allow: at least one pattern is required while success.requireScopeClean is true
```

### 無人実行の Auto-Yes ポリシーは allow-listed を使う（Issue #1684）

契約の `autoYes.mode: safe` は **`yes_no` 型のプロンプトしか自動応答しません**。
**Claude の編集確認（`Do you want to make this edit …?`）は `multiple_choice` 型**
（実質 Yes/No＋allow-all の 3 択）なので、safe のままだと編集のたびにワーカーが停止します。
無人で走らせる契約は `allow-listed` に広げ、危険操作は `denyPatterns` でエスカレートさせてください。

```yaml
autoYes:
  mode: allow-listed
  allowPromptTypes: [yes_no, multiple_choice]
  denyPatterns: ['rm -rf', 'git push.*--force', 'sudo ']
```

ポリシーが自動応答を抑止した事実は `commandmate capture --json` の
`autoYes.lastSuppression` に出ます（[capture の JSON フィールド](#json出力の主要フィールド)参照）。

### 無人実行の推奨契約テンプレート（Issue #1686）

無人でワーカーを走らせる契約はこのテンプレートから始めてください。
「目的・変更許可スコープ・合格条件・Auto-Yes ポリシー」が一式そろっており、
`send --contract` → `wait --verify` → `capture --json` / `capture --prompts` の
パイプラインでそのまま裁定・観測できます。

```yaml
# .commandmate/tasks/issue-123.yaml — 無人実行の推奨契約テンプレート
version: 1
title: "Issue #123: <一行サマリ>"
goal: |
  https://github.com/<org>/<repo>/issues/123 を実装する。
  受入条件: Issue の受入条件チェックリストをすべて満たすこと。
  作業完了後は commit すること。
scope:
  allow:                              # Issue の対象ファイルを列挙（列挙漏れは scope ゲートで不合格になる）
    - "src/**"
    - "tests/**"
    - "docs/**"
    - "CHANGELOG.md"
  deny: []
verify:
  gates: [lint, typecheck, unit]      # verify.yaml のゲート id。省略時: 全ゲート
autoYes:
  mode: allow-listed                  # safe は yes_no 型のみ。無人実行は allow-listed（上記参照）
  allowPromptTypes: [yes_no, multiple_choice]
  denyPatterns: ['rm -rf', 'git push.*--force', 'sudo ']
success:
  requireWorkEvidence: true
  requireScopeClean: true
```

```bash
commandmate send <worktree-id> --contract .commandmate/tasks/issue-123.yaml
commandmate wait <worktree-id> --verify          # 合格 0 / 不合格 20 / 作業証跡ゼロ 21
commandmate capture <worktree-id> --json         # autoYes.lastSuppression で抑止を観測
commandmate capture <worktree-id> --prompts      # auto-yes が解決したプロンプトの監査証跡
```

フィールドの正準仕様は [docs/design/task-contract.md](../design/task-contract.md)、
判定の可観測性の設計原則は
[docs/design/discoverability-principle.md](../design/discoverability-principle.md) を参照してください。

### 一覧・詳細

```bash
commandmate task list <worktree-id>              # 新しい順（TSV: id / status / agent / gates / title）
commandmate task list <worktree-id> --limit 5
commandmate task list <worktree-id> --json
commandmate task show <task-id>                 # 契約＋最後に判定した検証ランの要約
commandmate task show <task-id> --json
```

### status の意味

| status | 意味 |
|--------|------|
| `pending` | task 行はあるが未送信 |
| `running` | 送信済み。エージェントが作業中 |
| `waiting_input` | プロンプト待ち（Phase 3-1 で使用） |
| `verifying` | 検証ラン実行中 |
| `succeeded` | 検証ランが `passed` |
| `failed` | 検証ランが `failed`、または送信・検証が成立しなかった |
| `not_started` | 検証ランが `not_started`（作業証跡ゼロ） |
| `cancelled` | 明示的に中止 |

`succeeded` は検証ランだけが与えられる判定です。CLI やクライアントから
`succeeded` を報告することはできません（API が 400 で拒否します）。

### wait --verify との連携

`wait --verify` は CLI 側に追加指定は要りません。**待ち始める時点**で worktree の
active task（`running` / `waiting_input` / `verifying` の最新1件）を読み、その id を
後続の検証 run に渡します。契約の `verify.gates` が既定のゲート集合になり、結果で task が
遷移します。

id を**待機開始時に**読むのは、エージェントが完了報告の前に自分でゲートを回す（契約がそう
求めている）と、その run が task を `succeeded` へ移してしまうためです。後から worktree id
だけで検証を始めると契約を解決できず、**判定していない scope を含んだまま `passed` を返して
いました**（Issue #1620）。待機開始時に id を控えておけば、待っている間に task が閉じても
契約の scope はきちんと裁定されます。

そのため、task が既に終端になった後で `commandmate verify <id>` を単独で回すと、scope を
判定できないことが exit code に出ます（run は `error` = exit 99）。ログの `GATE scope SKIP`
行が **どの task を判定できなかったのか**を id と status つきで示します。契約を 1 件も
持たない worktree の素の `commandmate verify` は従来どおり `passed` です。

```bash
commandmate send <id> --contract .commandmate/tasks/loader.yaml
commandmate wait <id> --on-prompt human --verify   # 合格 0 / 不合格 20 / 作業証跡ゼロ 21
commandmate task show "$TASK"                      # succeeded / failed / not_started
```

`verify --gates` を明示した場合は契約より明示指定が優先されます。

契約ファイルは検証ゲートの変更集合から除外されるため、worktree に置いたまま（未コミットでも）`send` できます。詳細は [契約ファイルは作業証跡に数えない](#契約ファイルは作業証跡に数えない)。

---

## commandmate capture

指定worktreeのターミナル出力を取得します。

### 使用方法

```bash
commandmate capture <worktree-id>                    # テキスト出力
commandmate capture <worktree-id> --json             # JSON出力（ステータス情報付き）
commandmate capture <worktree-id> --instance codex   # プライマリインスタンス指定
commandmate capture <worktree-id> --instance codex-2 # 追加インスタンス指定
```

### JSON出力の主要フィールド

`fullOutput` 以外はサーバーの返す payload をそのまま出力します。

```json
{
  "isRunning": true,
  "isComplete": false,
  "isPromptWaiting": false,
  "isGenerating": true,
  "content": "",
  "realtimeSnippet": "(last 100 rows)",
  "lineCount": 42,
  "lastCapturedLine": 42,
  "promptData": null,
  "autoYes": {
    "enabled": false,
    "expiresAt": null,
    "lastSuppression": null
  },
  "thinking": true,
  "thinkingMessage": "Claude is thinking...",
  "cliToolId": "claude",
  "isSelectionListActive": false,
  "isPagerActive": false,
  "isUnclassifiedActive": false,
  "statusEvidence": "positive",
  "lastKnownStatus": "running",
  "lastKnownStatusAt": 1754296400123,
  "lastServerResponseTimestamp": null,
  "serverPollerActive": true,
  "sessionStatus": "running",
  "sessionStatusReason": "hook_prompt_submit",
  "lastStopEventAt": null,
  "structuredEvents": {
    "lastEventType": "user_prompt_submit",
    "lastEventAt": 1754296400000,
    "lastEventDetail": null,
    "turnId": "turn-1754296400000",
    "openedAt": 1754296400000,
    "closedAt": null,
    "closedBy": null,
    "promptWaitingSince": null,
    "promptWaitingSource": null,
    "pendingDecisions": [],
    "session": null,
    "sessionContext": null,
    "sessionDiff": null,
    "source": {
      "cliToolId": "claude",
      "kind": "hooks",
      "capabilities": {
        "supportedEvents": ["stop", "notification", "session_start", "user_prompt_submit", "session_end", "pre_tool_use", "post_tool_use"],
        "configScope": "per-instance",
        "decisionTimeoutSeconds": 5,
        "permissionHookPredictsDialog": true,
        "sessionStartMayArriveLate": false,
        "permissionReplyReleasesPrompt": false,
        "eventIdentity": null,
        "resync": "none"
      },
      "probedActivity": null
    }
  },
  "model": "claude-opus-5[1m]",
  "reasoningEffort": null,
  "upstreamFault": null,
  "resolvedBy": "roster",
  "conflict": null
}
```

各フィールドの意味論は次のとおりです。行番号は 2026-08-20 時点の実測で、
関数名（`buildCurrentOutput` / `isClaudeRunning`）で追うほうが安全です。

| フィールド | 意味 |
|---|---|
| `content` | ポーラーがまだ保存していない分（`buildCurrentOutput`）。**行数がカーソルとして使えるツールでのみ差分**＝ scrollback を持つ codex / gemini / vibe-local / antigravity で、かつ capture window（10000 行）が未飽和のとき。この場合ポーラーが保存済みなら正常時でも空になる。**alternate screen のツール（claude / opencode / copilot）と、window 飽和時は capture 全体**（行数が pane 高さ・window 幅で pin され「読んだ位置」にならないため。Issue #1910 / #1670 / #1268） |
| `realtimeSnippet` | pane 末尾 100 行（画面そのもの。`src/lib/session/current-output-builder.ts:712`） |
| `lineCount` | capture 全体の行数（空白行を含む。TUI は 1000 行のペインに描かれるため、空白 pane でも 1001 になりうる） |
| `isRunning` | tmux セッションが存在して healthy（`src/lib/session/claude-session.ts:543-556`）。**ターン進行中の意味ではない** |
| `sessionStatus` / `sessionStatusReason` | 状態と、その根拠（`hook_*` なら hooks 由来、それ以外はスクレイパー由来。`HOOK_STATUS_REASON` は `src/lib/session/status-mapping.ts`） |
| `structuredEvents.*` / `lastStopEventAt` | hooks の最終イベントと最終 `stop` 時刻。hooks が来ていなければ `null` |
| `statusEvidence` / `lastKnownStatus` / `lastKnownStatusAt` | 判定が肯定的証拠に基づくか、と直前の確定状態（Issue #1926）。下記参照 |
| `structuredEvents.turnId` / `openedAt` / `closedAt` / `closedBy` | ターンの暫定境界（Issue #1926）。**まだ安定した turn 同一性ではありません**。下記参照 |
| `structuredEvents.source` | そのツールの構造化イベントソースの識別子と**宣言値**（Issue #1924）。セッションの状態ではなく**ソースの性質**なので、hooks が 1 件も来ていなくても・セッションが止まっていても必ず入る。ソース実装が無いツール（`vibe-local`）は互換ソースの「未計測」値（`supportedEvents: []`）を返す |
| `structuredEvents.source.kind` / `liveness` / `degradedReason` / `probedActivity` | そのソースが**いま生きているか**（Issue #2054）。宣言値と違い**セッションの状態**。下記参照 |
| `structuredEvents.sessionContext` | コンテキスト窓の使用率（Issue #2042）。publish しないツールでは常に `null`。下記参照 |
| `structuredEvents.sessionDiff` | **このターンが触ったファイル**とその revert 状態（Issue #2043）。publish しないツールでは常に `null`。下記参照 |
| `structuredEvents.pendingDecisions[]` | そのインスタンスが保持している dialog（Issue #1930、`kind` / `questionOptions` は Issue #2040）。下記参照 |
| `structuredEvents.session` | エージェント自身が申告した「いま入っている会話」（Issue #2040）。publish しないツールでは常に `null`。下記参照 |
| `upstreamFault` | 画面に上流障害の署名があれば `{id, matchedText, at}`、無ければ `null`（Issue #1839）。**`null` は「健全」ではなく「既知の署名が無かった」** |
| `resolvedBy` / `conflict` | `cliToolId` を選んだ**解決段**と、roster と明示指定の矛盾（Issue #1884）。下記参照 |

画面が空かどうかは `realtimeSnippet.trim() === ''` と `lineCount` で見る。
`content` は差分なので単独では判断しない。

#### `structuredEvents.pendingDecisions[]` の `kind` / `questionOptions`（Issue #2040）

保持中の dialog が**承認待ちなのか質問待ちなのか**を分けて出します。両者はワーカーを同じように
塞ぎますが、答え方がまったく違う（承認は 3 つの verdict、質問はエージェントが publish した選択肢）ため、
`capture --json` を読むオーケストレーターは先にこれを見分けられる必要があります。

```json
"pendingDecisions": [
  {
    "id": "que_0000000000000000000000000",
    "at": 1754296400000,
    "source": "permission-request",
    "toolName": "question",
    "confirmedAt": null,
    "scraperCorroborated": false,
    "deliveryExpired": false,
    "kind": "question",
    "questionOptions": [
      { "number": 1, "label": "Red" },
      { "number": 2, "label": "Blue" }
    ]
  }
]
```

- `kind`: `permission` / `question`。**必ず入ります**
- `questionOptions`: `kind === "question"` かつエージェントの payload をまだ保持しているときだけ非 `null`。
  番号は**その payload の並び順**で、`commandmate respond <id> <n>` が解決に使う番号と同一です
- 承認の 3 verdict はここではなく `promptData.decisionOptions` に出ます（そのソースの性質であって、
  この dialog の性質ではないため）
- **追加は additive です。** `id` / `at` / `source` / `toolName` / `confirmedAt` /
  `scraperCorroborated` / `deliveryExpired` の型・意味・有無は変わりません

#### `structuredEvents.session`（Issue #2040）

エージェント自身が申告した「いま入っている会話」です。ターミナルの画面からは読めない半分
（どのセッション・どの persona・どのモデル・いくら使ったか）で、opencode の `session.updated`
フレーム（既に購読済みのストリーム）から読むため**追加のリクエストもポーリングも発生しません**。

```json
"session": {
  "id": "ses_0000000000000000000000000",
  "title": "Fix the flaky test",
  "agent": "build",
  "model": "claude-sonnet-4.6",
  "provider": "github-copilot",
  "cost": 0.4213,
  "tokens": {
    "input": 120,
    "output": 30,
    "reasoning": 0,
    "cacheRead": 4096,
    "cacheWrite": 512,
    "total": null
  },
  "at": 1754296400000
}
```

- **必ずキーは存在し、判らないときは `null`** です。`null` になるのは opencode 以外の全ツール、
  まだ `session.updated` が届いていない opencode ペイン、および kill 済みのペイン
- 値は**そのまま**です。コストは丸めず、モデル名も整形しません（エージェント自身の申告と
  突き合わせられることが目的なので、出口で整えると必要なときに比較できなくなります）
- `tokens.cacheRead` / `cacheWrite` は opencode の `tokens.cache.read` / `.write` を平坦化したものです。
  `total` はセッションではなく assistant message 側の宣言なので、現状は常に `null`（自前で合計しません）
- サブエージェント（`parentID` を持つセッション）の `session.updated` は**無視します**。
  そのコストはペインのものではなく、採ると会話とバックグラウンドジョブの間で値が往復するためです
- `at` はこのレコードを書いた時刻です。古さの判断に使ってください

#### `structuredEvents.sessionContext`（Issue #2042）

コンテキスト窓をどれだけ使ったかです。`session` と同じく opencode の `session.updated` から読むので
**追加のリクエストは発生しません**。

```json
"sessionContext": {
  "tokens": 8510,
  "limit": 1000000,
  "percent": 1,
  "sessionAt": 1787738184568,
  "at": 1787738205025
}
```

- **publish しないツールでは常に `null`** です（現状 opencode 以外の全ツール）
- `percent` は `tokens / limit` をサーバが計算した整数です。`limit` が判らないときは `null`
- `sessionAt` は**エージェントがその数字を申告した時刻**、`at` はこのレコードを書いた時刻です。
  2 つが離れていれば「表示している使用率が古い」と判断できます

```bash
# コンテキストを 80% 以上使ったペインを拾う
commandmate capture "$WT" --json | jq -r 'select(.structuredEvents.sessionContext.percent >= 80) | .structuredEvents.session.id'
```

#### `structuredEvents.sessionDiff`（Issue #2043）

**このターンが触ったファイル**と、その revert 状態です。

```json
"sessionDiff": {
  "sessionId": "ses_0000000000000000000000000",
  "turnMessageId": "msg_0000000000000000000000000",
  "files": [],
  "filesAt": 1787738205026,
  "revertedFiles": [],
  "revertedMessageId": null,
  "at": 1787738205026
}
```

- **publish しないツールでは常に `null`** です（現状 opencode 以外の全ツール）
- `files` は**そのターンの**変更で、worktree 全体の `git status` ではありません
- `revertedMessageId` が非 `null` なら、そのターンは取り消されています。
  このとき作業ツリーは git から見て「何もしていない」状態になりうるので、
  `wait --verify` の work-evidence は opencode を名指しした run に限りこの台帳を参照します
  （[--verify の節](#--verify----require-workissue-1544)）
- opencode の台帳は git snapshot なので、`.gitignore` された作業は**ここにも出ません**（実測）

#### `structuredEvents.source` の健全性フィールド（Issue #2054）

`source.capabilities` が**ソースの性質**（宣言値）なのに対し、こちらは**いまそのソースが生きているか**です。

| フィールド | 意味 |
|---|---|
| `kind` | `sse`（pull 型＝ opencode）/ `hooks`（push 型＝ claude / codex / copilot / gemini / antigravity）/ `scraper`（構造化ソースが無い＝ `vibe-local`）。**全ツールで必ず入ります** |
| `liveness` | `live` / `stale`。**降格しうるソースでしか入りません**（現状 opencode のみ）。ハートビート断 30 秒で `stale` |
| `degradedReason` | scraper へ降格した理由（`port_identity_changed` など）。降格していなければキーごと出ません |
| `probedActivity` | 再接続直後に 1 回だけ問い合わせた活動状態 `{activity, at}`、または `null` |

```json
"source": {
  "cliToolId": "opencode",
  "kind": "sse",
  "liveness": "live",
  "probedActivity": { "activity": "idle", "at": 1787738180830 },
  "capabilities": { "...": "..." }
}
```

- **push 型のツールでは `kind` 以外は publish されません。**claude / codex の payload は
  `kind` と `probedActivity: null` が増えるだけで、他は #2054 以前と同一です
- `liveness` が `stale` / `degradedReason` が非 `null` のときは、**その worktree の状態は
  構造化イベントではなく画面スクレイプ由来**になっています。`sessionStatusReason` が
  `hook_*` から離れるのと同じ意味です

```bash
# 降格したペインだけ拾う
commandmate capture "$WT" --json | jq -r 'select(.structuredEvents.source.degradedReason != null) | .structuredEvents.source.degradedReason'
```

#### `statusEvidence` / `lastKnownStatus`（Issue #1926）

`sessionStatus` が**肯定的証拠に基づく**のか、単に否定パターンに一致しなかっただけなのかを
分けて出します。設計方針書 §4 D1 の「完了は肯定的証拠でのみ宣言する」に対応する追加フィールドで、
**`sessionStatus` の値域（`idle` / `ready` / `running` / `waiting`）は変わりません**。

| 値 | 意味 |
|---|---|
| `statusEvidence: "positive"` | 完了マーカー・思考インジケータ・解析できたプロンプト・composer、あるいはエージェント自身の `Stop` が判定の根拠 |
| `statusEvidence: "none"` | 対話中の画面なのに検出層が読めなかった。`sessionStatus` はフォールバック値。現状は `running`/`default` と `ready`/`no_recent_output` の 2 経路で、既存の `isUnclassifiedActive` と**同じ事実**（`statusEvidence === 'none'` ⇔ `isUnclassifiedActive === true`） |

`lastKnownStatus` / `lastKnownStatusAt` は**最後に肯定的に確認できた状態**とその時刻です。
`statusEvidence` が `"positive"` の間は `sessionStatus` と同じ値で、`"none"` になった瞬間から
「フォールバックが何と呼んでいるか」ではなく「直前まで実際に何だったか」を答えます。

```bash
# フォールバックで ready に見えているだけの worktree を弾く
commandmate capture "$WT" --json | jq -r 'select(.statusEvidence == "none") | .lastKnownStatus'
```

- サーバーのメモリ上に保持します。**TTL 30 分**（構造化状態の staleness bound と同値）、
  **サーバー再起動でクリア**、**セッション停止で破棄**します。`null` はこの 4 つを区別しません
- `isRunning: false` のセッションは `lastKnownStatus: null` です（`model` と同じ理由）。
  `statusEvidence` は `"positive"` — tmux に問い合わせて「セッションが無い」と確認した結果だからです
- **キーが無い**のは #1926 以前のサーバーで、`"positive"` とは意味が違います
- 既存フィールドは一切変わっていません。`isUnclassifiedActive` もそのまま出ます

#### `structuredEvents` のターンフィールド（Issue #1926）

| フィールド | 意味 |
|---|---|
| `turnId` | ターンの識別子（`turn-<openedAt>`）、無ければ `null` |
| `openedAt` | 直近の `user_prompt_submit` / `pre_tool_use` / `post_tool_use` の時刻 |
| `closedAt` | エージェントがターン終了（`Stop`）を報告した時刻 |
| `closedBy` | 終了理由。現状は `'stop'` のみ |

> **`turnId` はまだ安定したターン同一性ではありません。** 現状サーバーが保持しているのは
> **最新イベント 1 件だけ**なので、ターン途中の `pre_tool_use` で `openedAt` と `turnId` が
> 打ち直されます。`turnId` の変化を「新しいターンが始まった」と読むと 1 ターンの中で何度も
> 誤検知します。本実装（generation フェンス配下の turn レコード）は Phase 4 です。
>
> `commandmate wait` はこれらをまだ読みません。ターン成立の判定（Issue #1839）は
> `lastEventType` / `lastEventAt` のままで、`lastEventType` / `lastEventAt` も残っています。
> `closedAt` が `null` でも「ターンが続いている」とは限りません（`notification` が最後なら
> 4 つとも `null` になります）。

#### `model` / `reasoningEffort`（Issue #1785）

そのセッションが動いているモデルと reasoning effort です。取得できなければ `null` で、
**キー自体は常に存在します**（`capture <id> --json | jq '.model'` が `null` を返す）。

```bash
commandmate capture <worktree-id> --json | jq -r '.model // "unknown"'
```

- 値はエージェントの申告そのままで、CLI 側の整形はありません
- `isRunning: false` のセッションは `null` です。モデルの保持は意図的に期限切れしない
  （8時間走るターンは最後まで同じモデル）ため、停止済みセッションで前プロセスのモデルを
  返さないようサーバー側で落としています
- `reasoningEffort` は Issue #1784 着地までは常に `null` です
- **既存フィールドは一切変わっていません**。`content` / `realtimeSnippet` /
  `sessionStatus` / `sessionStatusReason` を読んでいる監視スクリプトはそのままです

#### `resolvedBy` / `conflict`: 送り先の解決（Issue #1884）

`cliToolId` が**どの段で決まったか**と、roster と明示指定（`--agent` / `?cliTool`）が
食い違っていたかを載せます。どちらも**追加フィールド**で、既存フィールドは変わりません。
#1884 以前のサーバーは両方とも返しません（キー自体が無い）。

| `resolvedBy` | 意味 |
|---|---|
| `roster` | `--instance` が roster に登録されており、その `cliTool` を採用した（最優先） |
| `explicit` | roster が知らない instance に対して明示指定を採用した／instance 未指定で明示指定があった |
| `primary` | instance ID がツール名そのもの（`--instance opencode` 等）なので、そのツールのプライマリインスタンスと解釈した（Issue #868） |
| `worktree-default` | 上記のいずれにも当たらず、worktree の既定エージェントを採用した |
| `fallback` | worktree に CLI ツールが記録されていなかった。**正常な結果ではありません**（設計 §4 D5 決定 5） |

```bash
# --instance を渡したのに worktree 既定が返ってきていないか
commandmate capture <worktree-id> --instance worker-7 --json | jq -r '.resolvedBy'
```

`conflict` は roster と明示指定が食い違ったときだけ非 `null` になります。
**読み取り経路なので 400 にはせず 200 を返し、roster を優先して解決した事実を載せます**
（副作用のある `send` / `respond` / `kill-session` などは同じ矛盾を 400 `instance_tool_conflict`
で拒否します）。

```json
"conflict": { "instanceId": "oc-2", "rosterCliTool": "opencode", "requestedCliTool": "claude" }
```

#### `upstreamFault`: 上流障害の観測（Issue #1839）

`realtimeSnippet`（pane 末尾 100 行）を ANSI 除去したうえで、上流（モデル API）障害の署名に
一致したものを載せます。一致が無ければ `null` で、**キー自体は常に存在します**。

```json
"upstreamFault": {
  "id": "overloaded",
  "matchedText": "⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.",
  "at": 1755640000000
}
```

| フィールド | 意味 |
|-----------|------|
| `id` | `overloaded`（`5xx Overloaded`）/ `retrying`（`Retrying in Ns · attempt N/M`）/ `limit-reached` / `api-error` |
| `matchedText` | 一致した**行そのもの**（前後の行は含まない）。200 UTF-8 バイトで切り詰め、切ったときだけ `…[truncated]` が付く |
| `at` | 判定に使ったフレームの取得時刻（epoch ms） |

- 署名は「エラーの文言」に固定しています。Claude が健全なフレームに出す
  `up to 50% of your weekly usage limit on Fable 5` のような**宣伝バナーには一致しません**
  （緩いパターンで実行全件を `blocked` と誤判定した実測が 2026-08-06 にあります）
- 定義は `src/lib/detection/upstream-faults.ts` の 1 箇所だけです。検出カナリア
  （`scripts/canary`）も `capture` も `wait` も同じ表を読みます
- **`null` を「上流は健全」と読まないでください。** 署名一致だけが根拠であり、pane が
  スクロールした場合も、障害が pane を空白のまま残した場合（#1834 の実測例）も `null` になります
- `wait --fail-on-upstream-fault` はこのフィールドだけを見て exit 11 を返します

#### `autoYes.lastSuppression`: ポリシー抑止の観測（Issue #1684）

実行契約の `autoYes` ポリシーが自動応答を**抑止**した最後の記録です（抑止が無ければ `null`）。
抑止はこれまでサーバーログ（`poller:auto-yes-suppressed-by-policy`）にしか出ず、
「Auto-Yes が効いているのにワーカーが止まっている」理由を CLI から判別できませんでした。

```json
"autoYes": {
  "enabled": true,
  "expiresAt": 1754300000000,
  "lastSuppression": {
    "reason": "type-not-allowed",
    "mode": "safe",
    "promptType": "multiple_choice",
    "at": 1754296400000
  }
}
```

| フィールド | 意味 |
|-----------|------|
| `reason` | `type-not-allowed`（mode が許さない型）/ `deny-pattern`（denyPatterns がマッチ）/ `deny-pattern-unusable`（評価不能パターンの fail-closed）/ `mode-off` |
| `mode` | 抑止時点のポリシー mode（`off` / `safe` / `allow-listed`、契約が mode を述べていなければ `null`） |
| `promptType` | 抑止されたプロンプトの型（例: Claude の編集確認は `multiple_choice`） |
| `pattern` | `deny-pattern` 系のとき、マッチした denyPattern |
| `at` | 抑止時刻（epoch ms）。抑止されたプロンプトが画面に残っている間は毎ポーリング更新される |

`isPromptWaiting: true` かつ `lastSuppression.at` が新しい場合、そのセッションは
**いまポリシー抑止で停止**しています。`commandmate respond` で人間が応答するか、
契約の `autoYes` を見直してください（`mode: safe` で `multiple_choice` が抑止される場合は
[allow-listed への切り替え](#無人実行の-auto-yes-ポリシーは-allow-listed-を使うissue-1684)を推奨）。

### `--pane`: transcript を読む（Issue #1623）

`--pane` を付けない `capture` は「エージェントがいま返している応答の蓄積」を返すため、
**アイドル時は空文字**になります。「画面に何が出ているか」を人間が読みたいときは `--pane` を使います。

```bash
commandmate capture <worktree-id> --pane              # 空行を畳んだ transcript（TTY ならページャ）
commandmate capture <worktree-id> --pane --tail 40    # 末尾 40 行だけ
commandmate capture <worktree-id> --pane --raw        # 圧縮せず生のペインを出す
commandmate capture <worktree-id> --pane --json       # 圧縮前後の行数つき JSON
commandmate capture <worktree-id> --pane --instance codex-2
```

- **`--tail N` は「圧縮後」の末尾 N 行**です。TUI セッションは 200×1000 のキャンバスに描かれ、
  空白は transcript と入力欄の**間**に溜まるため、生フレームの末尾を取ると空行ばかりになります
  （実測: 生の末尾 20 行に読める行は 4 行、圧縮後の末尾 20 行なら 13 行）
- 出力先が端末なら `CM_PAGER` → `PAGER` → `less -R` の順でページャに通します。
  パイプ・リダイレクト時はそのまま出るので `| grep` や `> file` が壊れません
- 取得する行数は常に 1000 行固定（`--lines` はありません）。検知系と同じ要求のままにして、
  人が読んでいるという理由でサーバの挙動が変わらないようにしています
- **attach も tmux 3.2+ も不要**です。`prefix+g`（下記）が使えない環境の代替になります

### `--prompts`: 解決済みプロンプトの監査証跡（Issue #1685）

auto-yes が `wait` のポーリング間隔内にプロンプトへ自動応答すると、`wait` は exit 10 せず、
`capture --json` の `promptData` も既に `null` になっています。`--prompts` はチャット履歴から
プロンプトメッセージを読むため、**何を聞かれ、何と答えたかを事後に取得できます**。

```bash
commandmate capture <worktree-id> --prompts                    # 直近 20 件をテキストで一覧
commandmate capture <worktree-id> --prompts --limit 5          # 直近 5 件
commandmate capture <worktree-id> --prompts --json             # JSON で取得
commandmate capture <worktree-id> --prompts --instance codex-2 # インスタンスで絞り込み
```

JSON 出力（`prompts` は古い順）:

```json
{
  "worktreeId": "myrepo-feature-x",
  "count": 1,
  "prompts": [
    {
      "id": "…",
      "timestamp": "2026-08-04T10:00:00.000Z",
      "cliToolId": "claude",
      "instanceId": "claude",
      "type": "yes_no",
      "question": "Allow tool use?",
      "options": ["yes", "no"],
      "status": "answered",
      "answer": "yes",
      "answeredAt": "2026-08-04T10:00:02.000Z",
      "answeredBy": "auto"
    }
  ]
}
```

- **`answeredBy` が応答種別**です: `auto`（サーバ側 auto-yes が自動応答）/ `human`（respond API・
  チャット UI からの明示応答。ブラウザ側 auto-yes フォールバック経由も `human` になります）/
  `terminal`（誰かがターミナルで直接応答したと推定される掃引記録）。本機能導入前に解決した行は `null`
- `--pane` とは併用できません（`--prompts` は履歴、`--pane` は現在の画面を読むため）
- `--limit` の上限はサーバの履歴取得上限（1000）と同じです

#### 検出できなかったフレームも残ります（Issue #1708）

**検出できなかったこと自体が記録すべき事実**です。以前は書き込み口が 2 つとも
`isPrompt === true` でゲートされていたため、検出層をすり抜けたダイアログはどこにも残らず、
「なぜ止まったか」は生ペインを見るしかありませんでした（しかも画面が流れるまでの間だけ）。

`isUnclassifiedActive` が 60 秒連続で立つと、1 件だけ記録されます（滞留中にポーリングの度に
行は増えません）。**検出できたプロンプトと混ざらないよう別表記になります**:

```
2026-08-06T12:00:00.000Z  claude/claude  [unclassified:detection-failed]
  Q: Unclassified interactive frame (running/default) held for 60s. …
```

- `--json` では `"type": "unclassified"` / `"status": "unclassified"` で判別します
- `status` が `pending` ではないため、`markPendingPromptsAsAnswered()` の掃引で
  「回答済み」にされることはありません（誰も読めなかったフレームに `answered` は付きません）
- この行に応答することはできません。生ペインを `capture <id> --pane` で確認してください
- **記録は「誰かが観測しているとき」に限られます。** 書き込みは `current-output` の
  ペイロード組立を経由するので、`wait` がポーリング中／ブラウザでターミナルを開いている／
  `capture --json` を打った、のいずれかが必要です。**サーバ側の Auto-Yes ポーラ単独では
  記録されません**。誰も待っていない停滞は残らない、という制約は意図的なもので、
  この機能が説明したい停滞（＝何かが待っていた停滞）は必ず観測下にあるためです

---

## 読むモード: attach したまま transcript を読む（Issue #1623）

CommandMate のセッションは 200 桁 × **1000 行**のキャンバスに固定されています（#1163）。
tmux はカーソルを追従表示しますが、カーソルは 997 行目付近にあるため、
`tmux attach` しても**見えるのは空白と入力欄だけで、読みたい transcript は一行も見えません**。
打つことは今でもできているので、壊れているのは「読む」だけです。

### `prefix + g`（tmux 内で読む）

CommandMate セッションに attach 中に `prefix + g`（既定では `Ctrl-b` に続けて `g`）を押すと、
空行を畳んだ transcript が popup に開きます。`less` の検索・スクロールがそのまま使え、
`q` で閉じて即入力に戻れます。ウィンドウのサイズは一切変わりません。

```bash
# セッション名は `=` を付けてクォートすること（zsh の equals expansion 対策）
tmux attach -t '=mcbd-claude-<worktree-id>:'
```

- **popup の内容はスナップショットです。** 生成中の追従はしません。
  更新したいときは **もう一度 `prefix + g`** を押してください
- 手で実行することもできます:
  `sh ~/.commandmate/bin/cm-read-pane.sh mcbd-claude-<worktree-id>`

### 導入・設定・無効化

キーバインドはサーバ起動時に自動で導入されます。tmux の **key table はサーバ全体で共有される**ため、
次のいずれかに当てはまる場合は **バインドを一切導入しません**（あなたの tmux は無変更のままです）。

| 状況 | 挙動 |
|---|---|
| tmux が `display-popup` 非対応（3.2 未満） | 導入しない。`capture --pane` を使ってください |
| そのキーが既に別の用途にバインド済み | 導入しない（上書きしません）。`CM_READ_MODE_KEY` で別のキーを指定してください |
| CommandMate 以外のセッションで押した | 何も起きません（セッション名 `mcbd-*` でガードしています） |

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `CM_READ_MODE` | （有効） | `off` / `0` / `false` で無効化。**次回のサーバ起動時に、前回導入したバインドを削除します** |
| `CM_READ_MODE_KEY` | `g` | prefix に続けるキー。英数字 1 文字か `F1`–`F12`、`C-` / `M-` / `S-` 修飾可 |
| `CM_READ_LINES` | `1000` | popup が遡る行数（スクリプト側） |
| `CM_READ_PAGER` | `less -R +G` | popup 内で使うページャ（スクリプト側） |

> **サーバ停止時にバインドは削除されません。** `commandmate start --issue N` で複数サーバが
> 1 つの tmux サーバを共有するため、片方の停止で削除すると他方のキーを奪ってしまうからです。
> 削除したいときは `CM_READ_MODE=off` を設定して再起動してください。

---

## commandmate auto-yes

Auto-Yes（確認プロンプト自動応答）を個別に制御します。

### 使用方法

```bash
commandmate auto-yes <worktree-id> --enable                    # 有効化（デフォルト1h）
commandmate auto-yes <worktree-id> --enable --duration 3h       # 期間指定
commandmate auto-yes <worktree-id> --enable --stop-pattern "error"  # 停止条件
commandmate auto-yes <worktree-id> --disable                    # 無効化
commandmate auto-yes <worktree-id> --enable --instance codex    # プライマリインスタンス指定
commandmate auto-yes <worktree-id> --enable --instance codex-2  # 追加インスタンス個別制御
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--enable` | Auto-Yesを有効化 |
| `--disable` | Auto-Yesを無効化 |
| `--duration <d>` | 有効期間（1h, 3h, 8h） |
| `--stop-pattern <p>` | 指定パターンがターミナル出力に出現したら自動停止 |
| `--instance <id>` | **対象の推奨指定方法**。対象インスタンスID。他インスタンスと独立してAuto-Yesを制御 |
| `--agent <id>` | roster に無いインスタンス向けの補助（`--instance` 単独で足りる場合は不要） |

### 対象エージェントは worktree の既定（Issue #1909）

`--instance` も `--agent` も付けない `auto-yes <id> --enable` は、
[`--agent` と `--instance` の優先順位](#--agent-と---instance-の優先順位issue-1629--1925)の表を
そのまま適用します。つまり **worktree の既定エージェント**が対象で、`send` / `wait` / `capture`
と同じ送り先です。**Issue #1909 以前は claude 固定**で、既定が copilot / opencode の worktree では
claude の poller が起動して 2 秒ごとに `Claude Code session ... does not exist` を出しつつ、
実際のダイアログは無応答のまま残っていました。どのエージェントを武装したかは実行時に表示されます。

```console
$ commandmate auto-yes proj-cp --enable
Auto-yes enabled for proj-cp (copilot).
```

`--instance` でプライマリ以外を指定した場合は `(opencode, instance oc-2)` の形になります。
エージェント名が出ない（`Auto-yes enabled for proj-cp.`）ときは、**稼働中のサーバが CLI より古く**
まだ claude 固定で動いています。`commandmate stop && commandmate start` で再起動してください。

ダイアログが出たまま停まっているセッションに対して有効化した場合は、**その解決済みエージェントの**
保留承認を再裁定した結果が 2 行目に出ます（Issue #1898-2。`resync` capability を持つソース＝
現状 opencode のみが対象で、hook 系 5 ツールでは何も出ません）。

```console
$ commandmate auto-yes proj-oc --enable
Auto-yes enabled for proj-oc (opencode).
Re-judged 2 pending approval(s): 2 answered.
```

### `--stop-pattern` はターミナル出力への照合（コマンドの抑止には使えない）

`--stop-pattern` はエージェントが実行する**コマンドを監視するものではなく**、ターミナル出力の
新規部分（デルタ）への正規表現照合です。コマンドの実行そのものを止めることはできず、逆に
ビルドログ等の出力にパターン文字列が**表示されただけ**でも発火します（例: `rm -rf` を指定すると、
npm スクリプトがクリーンアップで `rm -rf dist` をログに出しただけで Auto-Yes が停止します）。

「危険なコマンドに対する自動応答を抑止したい」場合は、実行契約の `autoYes.denyPatterns`
（[docs/design/task-contract.md](../design/task-contract.md)）を使ってください。こちらは
確認プロンプトの**質問文・選択肢**に照合し、マッチしたら自動応答せず人間へエスカレートします。

### 承認の経路はエージェントで 2 つに分かれる（command-code は画面ベースのみ）

Auto-Yes が「自動で答える」やり方は 1 つではありません。**どちらの経路になるかはエージェントで
決まり**、`--enable` の書き方では変わりません。

| 経路 | 何が起きるか | エージェント |
|------|-------------|-------------|
| **hooks 承認** | エージェントがツールを実行する**前**に CommandMate へ問い合わせ、CommandMate が裁定する。承認された場合ダイアログは**描かれないまま**先へ進む | claude / codex / copilot / antigravity（opencode は hooks ではなく SSE で同じことをする） |
| **画面ベース（TUI 番号応答）** | ダイアログが**実際に描かれてから**、CommandMate がターミナルを読み取り、選択肢の番号キーを送り返す | **command-code** / gemini / vibe-local |

**command-code は構造上 hooks 承認を選べません。** このツールの `PreToolUse` hook は権限ダイアログが
**承認された後**に発火するため、hook の応答ではダイアログを消せないからです（Command Code v1.49.0
実測: ダイアログ検出 `23:02:19.398Z` → 番号送信 `23:02:19.919Z` → `PreToolUse` 到達
`23:02:20.120Z`）。そのため command-code の `PreToolUse` は `/api/hooks/agent-event` に
**観測用のイベント**として登録されており、承認の裁定には使われません。経路ごとの詳細は
[エージェントイベント hooks](./agent-event-hooks.md) を参照してください。

CLI から見える違いは次の 3 点です。

- **ダイアログは一度ターミナルに描かれます。** 描かれてから消えるまで実測 3〜4 秒（うち検出から
  番号送信までが 0.1〜0.6 秒）かかります。hooks 承認の 4 ツールでは、承認される限りダイアログ
  そのものが出ません
- **ターミナルを読めない状況では答えられません。** 画面ベースの経路はペインのキャプチャが唯一の
  入力なので、キャプチャできないフレームや検出をすり抜けたフレームは無応答のまま残ります
  （`wait` の `unclassified` と同じ穴です）
- **`auto-yes --enable` の 2 行目（保留承認の再裁定）は出ません。** あれは `resync` capability を
  持つ opencode だけの機能で、画面ベースの 3 ツールにも hooks 承認の 4 ツールにもありません

どちらの経路であっても、**答えたのが誰かは `capture --prompts` で確認できます**
（`answeredBy` が `auto` ならサーバの Auto-Yes、`human` なら `respond` / チャット UI からの応答）。

```console
$ commandmate capture <worktree-id> --instance command-code --prompts --json
{
  "prompts": [
    {
      "question": "… Execute Shell Command Command Code needs to execute rm -f probe.txt. …",
      "options": [{ "number": 1, "label": "Yes", "isDefault": true }, …],
      "status": "answered", "answer": "1", "answeredBy": "auto"
    }
  ]
}
```

> **これは「command-code では Auto-Yes が弱い」という意味ではありません。** 隔離環境の実機確認では、
> `Create File` と `Execute Shell Command` のどちらのダイアログも Auto-Yes 有効時は `answeredBy: auto`
> で自動応答され、無効時は 45 秒放置してもダイアログが残りました（対照実験）。違うのは**経路**と、
> 「ダイアログが一度描かれる」ことに由来する上記 3 点だけです。

---

## commandmate instances

worktreeの「エージェントインスタンス」（roster）を一覧・追加・削除・alias変更します（Issue #1000）。
rosterはブラウザUIのAgentパネル（`AgentInstancesPane`）が管理する正本データで、`send --instance` が起動するアドホックなセッションとは別管理です。

### 使用方法

```bash
commandmate instances <worktree-id>                                    # 一覧（デフォルト動作）
commandmate instances <worktree-id> --json                             # JSON出力

commandmate instances <worktree-id> add --agent codex                  # 追加（IDは自動採番、例: codex-2）
commandmate instances <worktree-id> add --agent codex --alias "レビュー用"
commandmate instances <worktree-id> add --agent codex --id codex-3     # ID明示指定

commandmate instances <worktree-id> remove <instance-id>               # rosterから削除
commandmate instances <worktree-id> remove <instance-id> --kill        # 削除＋セッション停止

commandmate instances <worktree-id> alias <instance-id> "新しい名前"    # alias変更

commandmate instances <worktree-id> kill <instance-id>                 # 該当インスタンスのセッションのみ停止
```

### 出力例（一覧）

`commandmate instances <worktree-id>`:

```
INSTANCE_ID  ALIAS   CLI_TOOL  RUNNING  AUTO_YES  MODEL              EFFORT  SESSION_ID  SESSION_TITLE
-----------  ------  --------  -------  --------  -----------------  ------  ----------  -------------
claude       Claude  claude    yes      no        claude-opus-5[1m]                                   
codex-2      レビュー用   codex     yes      yes       gpt-5.6-sol                                        
opencode     opencode opencode yes      no        claude-sonnet-4.6          ses_01H…    Fix the flaky test
```

`commandmate instances <worktree-id> --json`:

```json
[
  {
    "instanceId": "claude",
    "alias": "Claude",
    "cliTool": "claude",
    "running": true,
    "autoYes": false,
    "model": "claude-opus-5[1m]",
    "reasoningEffort": null
  },
  {
    "instanceId": "codex-2",
    "alias": "レビュー用",
    "cliTool": "codex",
    "running": true,
    "autoYes": true,
    "model": "gpt-5.6-sol",
    "reasoningEffort": null
  },
  {
    "instanceId": "opencode",
    "alias": "opencode",
    "cliTool": "opencode",
    "running": true,
    "autoYes": false,
    "model": "claude-sonnet-4.6",
    "reasoningEffort": null,
    "sessionId": "ses_01H0000000000000000000000",
    "sessionTitle": "Fix the flaky test"
  }
]
```

#### `SESSION_ID` / `SESSION_TITLE` 列（Issue #2038）

opencode は、サポート対象エージェントの中で唯一**会話をコマンドラインから指定できる**ため
（`opencode -s <id>`）、次に起動したときに再開されるセッションを列に出しています。

| 状態 | 表示 |
|------|------|
| opencode で、CommandMate がセッションを記憶している | `ses…` とそのタイトル |
| opencode 以外のエージェント | 空欄（`--json` では `null`）。他のどのエージェントの起動コマンドも会話を名指さないため、これは欠落ではなく正しい答えです |
| CommandMate が一度もターン終了を見ていない opencode インスタンス | 空欄（`--json` では `null`） |

- **`--json` のキー名は `sessionId` / `sessionTitle` です。** 表の列名（`SESSION_TITLE`）とは一致しますが、
  `GET /api/worktrees/<id>/opencode/session` が返す同じ値のキーは `title` です。両者を取り違えないでください
- 列は**末尾に追加**しています。`INSTANCE_ID` 〜 `EFFORT` を列位置で読んでいるスクリプトはそのまま動きます
- 表のタイトルは 40 文字で切りますが、`--json` は全文を返します

#### `MODEL` / `EFFORT` 列（Issue #1785）

稼働中インスタンスが**いまどのモデルで動いているか**を表示します。`CLI_TOOL` が答えるのは
「どのエージェントか」までで、「その中のどのモデルか」はセッションだけが知っています。
並列ワーカー運用で「4本動いている」と「4本動いていて1本だけ安いモデルに落ちている」を
区別するための列です。

| 状態 | 表示 |
|------|------|
| エージェントがモデルを報告している | 報告値をそのまま（`claude-opus-5[1m]` / `gpt-5.6-sol` 等） |
| セッション未稼働（`RUNNING no`） | 空欄（`--json` では `null`） |
| モデルを報告しないツール（gemini / copilot） | 空欄（`--json` では `null`） |
| サーバー再起動後で claude がまだ `SessionStart` を出していない | 空欄（次のセッション開始で復帰） |

- 値は**エージェントの申告そのまま**です。CLI 側で整形・正規化しません。`/status` や
  `agy models` の表示とそのまま突き合わせられるようにするためです
- `EFFORT` は Issue #1784（capture からの effort 抽出）着地までは常に空欄 / `null` です。
  どのエージェントの hooks payload にも effort が無く、TUI 表示が唯一の情報源であるためです
- 列は**末尾に追加**しています。`INSTANCE_ID` 〜 `AUTO_YES` を列位置で読んでいる
  スクリプトはそのまま動きます

### オプション

| オプション | 説明 | 対象アクション |
|-----------|------|---------------|
| `--json` | JSON形式で出力 | list, add |
| `--agent <tool>` | 新規インスタンスの実行元CLIツール | add（必須） |
| `--alias <name>` | 表示名（省略時はツール名から自動生成） | add |
| `--id <instance-id>` | 明示的なインスタンスID（省略時は自動採番） | add |
| `--kill` | roster削除と同時にセッションも停止 | remove |

### 終了コード

| コード | 意味 |
|:------:|------|
| 0 | 成功 |
| 2 | バリデーションエラー（不正な `--agent`/`--id`、上限超過、最後の1件を削除しようとした等） |
| 99 | 指定インスタンスがrosterに存在しない |

---

## マルチセッション（1エージェント複数セッション）

1つのworktreeで、同じCLIツールのセッションを複数同時に起動できます（Issue #868）。

### インスタンスIDの規約

| 形式 | 意味 |
|------|------|
| `<agent>` | プライマリインスタンス（例: `claude`, `codex`） |
| `<agent>-<n>`（n ≥ 2） | 追加インスタンス（例: `claude-2`, `codex-3`） |

`--instance` は `send` / `wait` / `respond` / `capture` / `auto-yes` すべてで受け付けます。

> **送り先は `--instance` 単独形で書いてください（Issue #1638）**。`--agent` を受け付けるのは
> `send` / `respond` / `capture` / `auto-yes` のみで、`wait` は受け付けません（`wait --agent` は
> `unknown option` で exit 1）。この非対称が実害になるのは
> **「`send` にだけエージェントを書いて `wait` には書かない」**ときで、`wait` は worktree の
> **既定エージェント**を見るため、Codex 用に切った worktree で黙って Claude Code の完了を待ちます。
> `--instance` は 5 コマンド全てが受け付けるので、ワークフロー全体を 1 つのフラグで書けます。
>
> **`--agent` は廃止していません（Issue #1638 の決定）**。出荷済みの CLI・既存スクリプト・
> 埋め込みドキュメントを壊す代償に見合わないこと、および
> **`--register` は roster に無いIDに対して `--agent` でしかCLIツールを指定できない**（`codex-3` という
> IDだけからは推論できない）ためです。したがって `--agent` は
> **「roster に無いインスタンスをアドホック起動するときの補助」**という位置づけで残ります。
> パース・優先順位（下表）は一切変わっていません。
>
> `wait --agent` の新設は Issue #1629 で不採用と結論済みです（インスタンスを伴わない
> `--agent codex` は「どの codex セッションを待つのか」を決められないため）。

### rosterとの関係

- **roster** = ブラウザUIのAgentパネルで管理される、正式なインスタンス一覧（表示順・alias付き）。`commandmate instances` で一覧・追加・削除・alias変更ができます。
- `send --instance <id>` は roster に**登録されていなくても**セッションを自動起動します（アドホック実行）。ただし roster に無いインスタンスはUIのサイドバー/タブには表示されません。
- `send ... --instance <id> --register` を付けると、送信後にそのインスタンスを roster へ自動登録します。UIと状態を一致させたい場合はこちらを使ってください。
- 有効な `--instance` の値を調べるには `commandmate instances <worktree-id>` で roster と稼働中セッションを確認します。

### `--agent` と `--instance` の優先順位（Issue #1629 / #1925）

`--instance` はインスタンスIDであってCLIツール名ではないため、どのCLIツールで起動するかは
別に決める必要があります。CLIツールIDは tmux セッション名の一部（`mcbd-<agent>-<worktree>[-<suffix>]`）
なので、取り違えると「codex という名前のセッションで claude が動く」状態になります。
決定順は次のとおりで、`send` / `respond` / `capture` / `auto-yes` で共通です。

| ケース | 採用されるCLIツール | `resolvedBy` |
|--------|--------------------|--------------|
| `--instance` が roster に**ある** / `--agent` 省略 | roster の `CLI_TOOL` | `roster` |
| `--instance` が roster に**ある** / `--agent` が roster と**一致** | その値 | `roster` |
| `--instance` が roster に**ある** / `--agent` が roster と**不一致** | **変更系はエラー（exit 2）**。roster が正本なので黙って上書きしない | `roster` ＋ `conflict` |
| `--instance` が roster に**ない** / `--agent` 指定あり | `--agent` の値（アドホック起動） | `explicit` |
| `--instance` が roster に**ない** / `--agent` 省略・IDがCLIツール名（例 `codex`） | そのCLIツール（プライマリインスタンス） | `primary` |
| `--instance` が roster に**ない** / `--agent` 省略・IDが独自名（例 `codex-9`） | worktree の既定エージェント | `worktree-default` |
| `--instance` 省略 | `--agent` の値、無ければ worktree の既定エージェント（roster は参照しない） | `explicit` / `worktree-default` |

不一致でエラーになった場合は、`--agent` を外す・roster と同じ値にする・
`commandmate instances <worktree-id> remove/add` で roster を登録し直す、のいずれかで解消します。

#### 決定するのはサーバ（Issue #1925）

上の表を適用するのは**サーバ**です。CLI は `GET /api/worktrees/<id>/resolve-target` に問い合わせ、
返ってきた `cliToolId` / `instanceId` / `resolvedBy` をそのまま使います。以前は CLI 側にも
同じ規則の写しがあり、しかも**プライマリインスタンスの段（上表 5 行目）が欠けていた**ため、
roster 未登録の `--instance codex` に対して CLI とサーバが違う答えを返していました。

不一致（`conflict`）の扱いは**副作用の有無で分かれます**。

| 区分 | コマンド | 不一致のとき |
|------|----------|--------------|
| 変更 | `send` / `respond` / `auto-yes --enable` | **exit 2**。送り先を推測して副作用を起こさない |
| 読み取り | `capture` | **警告を stderr に 1 行出して roster 側で読む**（exit 0） |

`capture` を例外にしているのは、監視スクリプトが `capture` の非 0 終了を「今回のポーリングを飛ばす」
と解釈して無限に回り続けるためです（`--agent` を取り違えたワーカー 1 本で、監視が無音のまま止まらなくなる）。

#### CLI が稼働サーバより新しいとき

`npm i -g commandmate` は**稼働中のデーモンを再起動しません**。そこで CLI は
`GET /api/capabilities`（`{ serverVersion, capabilities }`）をプロセス内 1 回だけ問い合わせ、
サーバが解決に対応しているかを確かめてから委譲します。判定は次の 4 通りだけです。

| 応答 | 動作 |
|------|------|
| 200 ＋ JSON ＋ `capabilities` に `resolve-session-target` | サーバへ委譲する |
| **本物の 404**（本文が空 or JSON） | 旧サーバとみなし CLI 側で解決（`resolvedBy: client-fallback`）。**stderr に警告 1 行** |
| 401 / 403 | 認証エラーとして終了。**フォールバックしない** |
| 3xx / HTML / JSON でない本文 / 500 / 通信エラー | 「サーバの能力を判定できない」として終了。**フォールバックしない** |

`client-fallback` は**プライマリインスタンスの段を持たない劣化解決**です。認証が通っていないだけの
応答や中間装置（リバースプロキシ・ngrok 等）の応答をここに落とすと `send` / `respond` の着弾先が
変わりうるため、**旧サーバだと確認できた場合以外はフォールバックしません**。警告が出たら
`commandmate stop && commandmate start` でサーバを入れ替えてください。

> roster を読めない場合（`client-fallback` 経路のみ）は警告を出して `--agent` をそのまま使います。

#### ツール依存オプションは解決の**後**に検証されます

`send --model` は解決後の CLI ツールに対して検証されます。したがって
`send <id> "..." --instance copilot-2 --model gpt-5-mini` は `--agent copilot` を重ねなくても通ります
（roster が `copilot-2` を copilot だと宣言しているため）。

### per-instance Auto-Yes

`--instance` 付きで `--auto-yes` / `auto-yes --enable` を実行すると、そのインスタンスのAuto-Yesは他インスタンスと独立して有効化・停止されます。

### 使用例

```bash
WT=$(commandmate ls --branch feature/101 --quiet)

# roster確認（有効な --instance 値を調べる）
commandmate instances "$WT"

# 追加インスタンスをrosterに登録してから使う
# roster登録済みなら --agent は省略できる（roster の CLI_TOOL が使われる）
commandmate instances "$WT" add --agent codex --alias "レビュー用"
commandmate send "$WT" "差分をレビューして" --instance codex-2 --auto-yes
commandmate wait "$WT" --instance codex-2 --timeout 600
commandmate capture "$WT" --instance codex-2 --json

# アドホックに起動しつつ、その場でrosterに登録
# ここは --agent が必要: codex-3 はまだrosterに無く、IDだけではCLIツールを決められない
commandmate send "$WT" "軽くチェックして" --agent codex --instance codex-3 --register

# 不要になったら削除（セッションも停止）
commandmate instances "$WT" remove codex-2 --kill
```

---

## commandmate report

日次レポート（その日のエージェント活動サマリー）を生成・表示・一覧します（Issue #636）。
サーバー稼働中に、登録済みのセッション履歴をもとにAIツールがレポートを生成します。

### 使用方法

```bash
commandmate report generate                       # 本日分を生成（claude）
commandmate report generate --date 2026-06-21      # 日付指定
commandmate report generate --tool codex           # AIツール指定
commandmate report generate --template <id>        # テンプレートを指示文として使用
commandmate report generate --instruction "要約して"  # カスタム指示文

commandmate report show                            # 本日分を表示
commandmate report show --date 2026-06-21 --json   # 日付指定＋JSON出力

commandmate report list                            # 直近7日を一覧
commandmate report list --days 30                  # 直近30日を一覧
commandmate report list --json                     # JSON出力

commandmate report metrics                         # 直近7日の Eval メトリクス
commandmate report metrics --days 30               # 期間指定（1〜90日）
commandmate report metrics --json                  # JSON出力
```

### サブコマンド

| サブコマンド | 用途 |
|-------------|------|
| `generate` | 指定日のレポートを生成し、内容を標準出力に表示 |
| `show` | 既存レポートを表示（未生成なら `No report found` を表示） |
| `list` | 直近 N 日分のレポート有無・メッセージ件数・生成ツールを一覧 |
| `metrics` | タスク成功率・検証合格率・人間介入回数を集計（Issue #1551） |

### generate オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--date <date>` | 対象日（`YYYY-MM-DD`） | 当日 |
| `--tool <tool>` | 使用するAIツール（claude, codex, copilot, antigravity, opencode） | claude |
| `--model <model>` | モデル名（copilot は `--model` の値、opencode は `provider/model`） | - |
| `--template <id>` | テンプレートIDを指示文として使用 | - |
| `--instruction <text>` | カスタム指示文（`--template` の代替） | - |
| `--token <token>` | 認証トークン（`CM_AUTH_TOKEN` 環境変数を推奨） | - |

### show / list オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--date <date>`（show） | 対象日（`YYYY-MM-DD`） | 当日 |
| `--days <days>`（list） | 一覧する日数 | 7 |
| `--json` | JSON形式で出力 | - |
| `--token <token>` | 認証トークン（`CM_AUTH_TOKEN` 環境変数を推奨） | - |

> **注意**: `--date` は `YYYY-MM-DD` 形式のみ受け付けます。不正な形式は `exit 2`（CONFIG_ERROR）になります。
> `--tool` は claude / codex / copilot / antigravity / opencode のいずれか、`--days` は 1 以上を指定してください。

> **opencode（Issue #2044）**: `--tool opencode` は `opencode run --format json` で実行され、
> JSON イベント列の**最後のアシスタントメッセージの text** が本文になります。
> `--format default` の装飾を剥がしているわけではないので、ツール呼び出しを挟んだ実行でも
> 「ツールを呼ぶと決めたメッセージ」ではなく答えの側が採用されます。
> `--model` を渡すときは `provider/model`（例: `github-copilot/claude-sonnet-4.6`）で書いてください。

### レポート末尾の「Agent session cost」節（Issue #2044）

その日にエージェントが報告したコスト／トークンが台帳（`agent_session_costs`）にあると、
生成された本文の**末尾に** worktree 別の表が追記されます。**AI には渡していません**
（数字を要約させると `opencode stats` と突き合わせられなくなるため、生成後に決定的に付けています）。
台帳が空の日は節ごと出ません＝ claude / codex の生成結果は従来どおりです。

見出しは `## Agent session cost (YYYY-MM-DD)` で、その下に次の表が付きます。

```markdown
| Worktree | Sessions | Cost (USD) | Input | Output | Reasoning | Cache read | Cache write |
|---|---:|---:|---:|---:|---:|---:|---:|
| feature/2044-opencode | 2 | 0.067939 | 6 | 181 | 0 | 8367 | 16719 |
| **Total** | 2 | 0.067939 | 6 | 181 | 0 | 8367 | 16719 |
```

- 数字は**エージェント自身のセッション累計**をそのまま足したものです。opencode 1.18.22 で
  `opencode stats --project "" ` の Total Cost / Input / Output / Cache Read / Cache Write と
  一致することを実測しています（`docs/design/opencode-server-live-verification.md` §15.3）。
- `-` は 0 ではなく「エージェントが値を報告しなかった」という意味です。
- 突き合わせは `opencode stats --project <worktree のパス> --days 1` で行えます。

### list 出力例

```
2026-06-21  [report] tool=claude  messages=12
2026-06-20  [no report]  messages=3
2026-06-19  [report] tool=codex  messages=8
```

### metrics（Eval メトリクス、Issue #1551）

「ハーネスがどれだけエージェントを放置したまま完走させられているか」を、`tasks` / `verification_runs` /
`task_events` の実記録から集計します。**読み取り専用**で、集計のためのテーブル追加はありません。

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--days <days>` | 集計期間（1〜90）。範囲外・非整数は `exit 2` | 7 |
| `--json` | JSON形式で出力 | - |
| `--token <token>` | 認証トークン（`CM_AUTH_TOKEN` 環境変数を推奨） | - |

```
$ commandmate report metrics
Vibe Metrics (last 7 days)
Tasks:        12 total / 9 succeeded / 2 failed / 1 not-started  (success 75.0%)
Verification: 31 runs, pass 80.6%  (top fails: unit x4, lint x2)
Intervention: 5 human responds / 23 auto answered
Retry loops:  avg 1.3 per failed task
```

読み方:

- **Tasks** — 期間内に作成された `tasks` 行。`total` には未完了（pending / running）も含まれる。
  `success` は `succeeded / total`
- **Verification** — 期間内に開始された検証 run。`top fails` は `failed` / `timeout` に終わったゲートの上位10件
  （`skipped` と `error` は「判定していない」ので数えない）
- **Intervention** — `prompt_answered_human`（人間が答えた）と `prompt_answered_auto`（Auto-Yes が答えた）の件数。
  ポリシーで抑止された件数（`suppressedByPolicy`）は DB 化されていないため v1 では常に `null`
- **Retry loops** — 不合格になったタスク 1 件あたりの平均再指示回数（`failed` / `not_started` からの `message_sent`）

> **分母ゼロは `n/a`** — `0.0%` とは表示しません。「12件中0件成功」と「そもそも0件」を同じ文字列で報告しないためです。

> **旧 DB でも動きます** — migration v49〜v51 が未適用のデータベースでは、該当セクションが 0 と `n/a` になるだけで
> エラーにはなりません。

日次レポート（`report generate`）のプロンプトにも、当日分の同じ集計が `<verification_metrics>` セクションとして
渡されます。活動がゼロの日はセクション自体が省略されます。

---

## commandmate skill

公式 Agent Skill を CLI から管理します。ブラウザ UI と**同一の API / domain service** を利用する thin client であり、
CLI 側で download / extract / write / delete は一切行いません。

filesystem path・artifact URL・file list・checksum は API 側で明示的に拒否されるため、CLI はそれらを再構成しません。
plan で server が発行した plan token を、そのまま install / uninstall へ渡します。

### 使用方法

```bash
# カタログ参照
commandmate skill list                                    # 一覧（表形式）
commandmate skill list --json                             # JSON（API レスポンスそのまま）
commandmate skill list --prerelease                       # prerelease を含める
commandmate skill info <skill-id>                         # 能力・提供元・version・互換性
commandmate skill info <skill-id> --version 1.2.0

# Install Plan（書き込みなし）
commandmate skill plan <skill-id> --worktree <worktree-id>
commandmate skill plan <skill-id> --worktree <worktree-id> --version 1.2.0 --json

# Update Plan（書き込みなし）
commandmate skill update-plan <skill-id> --worktree <worktree-id>            # 推奨候補で計画
commandmate skill update-plan <skill-id> --worktree <worktree-id> --version 1.3.0
commandmate skill update-plan <skill-id> --worktree <worktree-id> --range "^1.0.0" --json

# update（plan → 確認 → apply）
commandmate skill update <skill-id> --worktree <worktree-id>                 # 推奨候補へ更新
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 --dry-run
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 --yes
commandmate skill update <skill-id> --worktree <worktree-id> --version 1.3.0 \
  --yes --ack-risk <skill-id>@1.3.0 --ack-risk-increase   # high-risk かつ risk 上昇時

# install（plan → 確認 → apply）
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 --dry-run
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 --yes
commandmate skill install <skill-id> --worktree <worktree-id> --version 1.2.0 \
  --yes --ack-risk <skill-id>@1.2.0                       # high-risk Skill

# uninstall / status
commandmate skill uninstall <skill-id> --worktree <worktree-id> --dry-run
commandmate skill uninstall <skill-id> --worktree <worktree-id> --yes
commandmate skill status <skill-id> --worktree <worktree-id> --json
```

### 確認規約（install / update / uninstall）

| 状況 | 挙動 |
|------|------|
| 常に | 先に plan を構築して内容を表示する |
| `--dry-run` | plan までで停止し、書き込み・削除を行わない |
| TTY かつ `--yes` なし | plan summary を表示してから確認プロンプト（stderr）を出す |
| **非TTY かつ `--yes` なし** | **書き込まず exit 12**。プロンプトを出せない環境で暗黙実行しない |
| **high-risk Skill** | `--yes` に加えて `--ack-risk <skill-id>@<version>` の**完全一致**が必要。`--yes` だけでは通らない（TTY で承諾しても同じ） |
| **update で effective risk が上がる** | `--ack-risk` とは**別に** `--ack-risk-increase` が必要。high-risk 承認とリスク上昇承認は独立した確認で、片方が他方を代替しない |
| **update に local 変更がある** | plan の時点で updatable=false。適用しても**旧版・新版のどちらも書き換えず** exit 11 |

### オプション

| オプション | 対象サブコマンド | 説明 |
|-----------|-----------------|------|
| `--worktree <id>` | plan / update-plan / install / update / uninstall / status | 対象worktree ID（`commandmate ls` で確認） |
| `--version <version>` | info / plan / update-plan / install / update | install では**必須**（exact version）。update-plan / update では省略時に推奨候補へ解決 |
| `--range <range>` | update-plan / update | 候補をこの version range 内に限定（例 `"^1.0.0"`） |
| `--dry-run` | install / update / uninstall | plan までで停止 |
| `-y, --yes` | install / update / uninstall | 確認プロンプトをスキップ（非対話環境では必須） |
| `--ack-risk <id>@<version>` | install / update | high-risk Skill の明示的な承認 |
| `--ack-risk-increase` | update | effective risk が上がる更新の明示的な承認（`--ack-risk` とは別枠） |
| `--prerelease` | list / info / plan / update-plan / install / update | prerelease version を対象に含める |
| `--json` | 全サブコマンド | JSON出力（API レスポンスをそのまま出力） |
| `--token <token>` | 全サブコマンド | 認証トークン（`CM_AUTH_TOKEN` 環境変数を推奨） |

### 終了コード

| コード | 意味 | 対処 |
|-------|------|------|
| 0 | 成功 | - |
| 1 | サーバー／Catalog へ到達できない | リトライ可 |
| 2 | 引数不正・Skill / version が存在しない | argv を修正 |
| 11 | worktree 側が拒否（local変更・衝突・lock・plan drift） | 該当pathを解消して再 plan |
| 12 | 書き込みが確認されなかった（`--yes` なし・拒否・`--ack-risk` 不一致） | 明示的に承認して再実行 |
| 13 | ファイルは変更されたが reconciliation が必要 | 状態を確認（自動収束する） |

> **stdout / stderr の分離**: `--json` 成功時の stdout は parse 可能な JSON のみになります。
> plan summary・確認プロンプト・警告・エラー（typed code と blocker path を含む）はすべて stderr に出るため、
> `--json` 実行が失敗した場合の stdout は空です。

> **`skill status` について**: 1 worktree × 1 Skill の導入状態を、install receipt（ディスク上の実体）から報告します。
> worktree 単位で導入済み Skill を一覧する API は未提供のため、`<skill-id>` は必須です。

> **`skill update` の安全性**: 更新は「旧版が CommandMate の記録どおり無変更である」ことを適用直前に
> 再証明してから行います。1 file でも編集・追加・欠落があれば**何も書かずに** exit 11 で止まります。
> 切替は rename 1 点を commit point とするため、途中で失敗しても旧版完全体か新版完全体のどちらかに
> 収束し、混在しません。旧版は切替前に `~/.commandmate/skills/backups/` へ検証済みで保存されます
> （復元コマンドは #1245 で提供予定）。

---

## commandmate update

CommandMate本体を最新バージョンに更新します（Issue #1194）。
グローバルインストール環境では、停止 → `npm install -g commandmate@latest` → 再起動 → 応答確認を1コマンドで実行します。
他のコマンドと異なり、操作対象は worktree ではなく**npm registry とローカルのデーモン**です（`--token` フラグはありません。再起動後の応答確認先 URL は `.env` / `CM_PORT` から解決され、`CM_AUTH_TOKEN` があれば Bearer トークンとして使用されます）。

### 使用方法

```bash
commandmate update            # 確認プロンプトつきで更新
commandmate update --check    # 更新の有無を確認するだけ（何も変更しない）
commandmate update --yes      # 確認プロンプトをスキップ（非対話環境では必須）
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--check` | バージョンを表示するだけ。インストール・停止・再起動を行わない（registry照会に失敗した場合のみ exit 5） |
| `-y, --yes` | 確認プロンプトをスキップ。TTYのない環境では必須（無い場合は exit 2） |

### --check の出力

```
Current: v0.9.0
Latest: v0.10.0
Update available: yes
```

### 更新がスキップされる条件

いずれも更新を実行せず exit 0 で終了します。

| 条件 | 動作 |
|------|------|
| すでに最新 | `Already up to date` を表示 |
| ローカルの方が新しい | ダウングレードせずスキップ |
| ローカルまたはlatestがプレリリース | 比較不能としてスキップ |
| 非グローバルインストール（git clone環境） | 手動更新手順（`git pull` → `npm install` → `npm run build:all` → 再起動）を案内 |

### 終了コード

| コード | 定数名 | 意味 |
|:------:|--------|------|
| 0 | SUCCESS | 更新完了・スキップ・キャンセル・`--check`（応答確認が緩和された場合も含む） |
| 2 | CONFIG_ERROR | 非対話環境で `--yes` が指定されていない |
| 3 | START_FAILED | 更新は成功したが、再起動後のサーバーを確認できない（ロールバック不要） |
| 4 | STOP_FAILED | サーバーを停止できず中止（**何も変更していない**） |
| 5 | UPDATE_FAILED | npm registry照会・`npm install -g`・バージョン検証のいずれかに失敗 |
| 99 | UNEXPECTED_ERROR | 予期しないエラー |

### 注意事項

- **起動オプションは復元されません**: 再起動後は `.env` の設定のみで起動します。`--auth` / `--auth-expire` / `--cert` / `--key` / `--allow-http` / `--allowed-ips` / `--trust-proxy` / `--port` / `--dev` を使っていた場合は、update 後に手動で起動し直してください（`--auth` は起動のたびに新しいトークンが生成されます）。
- **worktree用サーバー（`--issue`）は対象外**: 停止も再起動もされません。`npm install -g` がパッケージディレクトリ（`dist/` / `.next/`）を置換するため、稼働中のworktreeサーバーは異常終了する可能性があります。update **前**に `commandmate stop --issue <number>`、update 後に `commandmate start --issue <number>` を実行してください（稼働中の場合は警告が表示されます）。
- **メインサーバーが停止中の場合**: 更新のみを行い、サーバーは起動しません。
- **認証・IP制限・自己署名証明書の環境**: 再起動後の応答確認が「サーバー応答の確認のみ」に緩和され、警告付きで成功（exit 0）します。厳密に確認するには `CM_AUTH_TOKEN` を設定して実行してください。
- **EACCES（権限エラー）**: `sudo` で再実行しないでください。[CLIセットアップガイドの権限エラー（EACCES）](./cli-setup-guide.md#権限エラーeacces) の手順で npm のグローバルディレクトリ権限を修正します。
- **失敗時のロールバック**: 更新前のバージョンに戻すコマンドが表示されます（`npm install -g commandmate@<更新前のバージョン>`）。

---

### commandmate remote

このサーバを外から到達できるようにし、スマホと QR コードでペアリングします。他のコマンドと異なり、**操作対象は worktree ではなく、この PC のサーバと Provider（トンネル）**です。

> **`remote` が増やすのは「外への口」だけです。** `CM_BIND` は読みも書きもしないため、既定の `127.0.0.1` バインドは変わりません。Auto-Yes を有効化するフラグもなく、`remote` が起動したサーバでは Auto-Yes はどの worktree でも無効のままです。

#### 使用方法

```bash
commandmate remote          # 既定 = up。サーバを起動し、公開し、QR を表示する
commandmate remote status   # Provider / URL / 期限 / ペアリング状態
commandmate remote stop     # Provider を閉じる（サーバは止めない）

commandmate remote --provider tailscale         # Provider を明示指定（tailnet 内に閉じる）
commandmate remote --provider cloudflare        # Provider を明示指定（公開 Tunnel）
commandmate remote --expires 24h                # remote セッションのTTL
commandmate remote --pairing-expires 3m         # ペアリングコードのTTL
commandmate remote --yes                        # 公開Tunnelを明示承認（非対話環境では必須）
commandmate remote status --json                # 機械可読出力
```

#### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--provider <name>` | Provider を指定（`tailscale` / `cloudflare`）。指定した Provider が使えない場合、他へフォールバックせず exit 1 | 使える Provider を優先順で自動選択 |
| `--expires <duration>` | remote セッションのTTL（`1h`〜`30d`） | `8h` |
| `--pairing-expires <duration>` | ペアリングコードのTTL（`1m`〜`24h`） | `10m` |
| `-p, --port <number>` | 公開するサーバのポート | 未指定なら `commandmate start` と同じ解決順 |
| `--yes` | 公開Tunnel（`cloudflare`）の作成を明示承認する。非対話環境（TTYなし）では必須。`tailscale` は tailnet 内に閉じるため不要 | 無効（対話で確認する） |
| `--json` | JSON出力 | 無効 |

> **`--token` と `--auto-yes` 系のフラグはありません。** トークンを鋳造するのは `remote` 自身の側なので、外から渡されたトークンには照合するハッシュがサーバに存在しません。Auto-Yes については上の注記のとおりです。

#### 終了コード

| コード | 定数名 | 意味 |
|:------:|--------|------|
| 0 | SUCCESS | 公開・状態表示・停止に成功（`stop` で片付ける記録が無かった場合も含む） |
| 1 | DEPENDENCY_ERROR | 使える Provider が1つも無い／`--provider` で指定した Provider がこのマシンで使えない |
| 2 | CONFIG_ERROR | 非対話環境で公開Tunnelの承認（`--yes`）が無い／`--expires`・`--pairing-expires`・`--provider` の値が不正／認証付きのサーバが既に稼働中／稼働中サーバの再起動が承認されなかった |
| 3 | START_FAILED | サーバまたは Provider の起動に失敗（開きかけたものはロールバックされる） |
| 4 | STOP_FAILED | Provider を閉じきれなかった（状態ファイルは残るので再実行できる） |
| 99 | UNEXPECTED_ERROR | 予期しないエラー |

`remote` は新しい終了コードを追加していません。値の意味は[全終了コード一覧](#全終了コード一覧)と同じです。

#### Provider の現状

| Provider ID | `--provider` の値 | 状態 |
|-------------|------------------|------|
| `tailscale-serve` | `tailscale` | **実装済み**（Issue #1937 R3）。`tailscale` がインストールされ、ノードがログイン済みで、Serve/HTTPS が使える状態なら `ready` になります。公開先は**自分の tailnet の中だけ**でインターネットには出ないため、公開Tunnel の承認（`--yes`）は要りません |
| `cloudflare-quick` | `cloudflare` | **実装済み**。`cloudflared` がインストールされていれば使えます（実測: `available: true` / `version: 2025.4.0` / `ready: true`）。公開先は**インターネット**なので、承認が要ります |

自動選択は優先順（tailscale → cloudflare）で最初に ready な Provider を選びます。tailnet の中に閉じる `tailscale-serve` が先に試されるのはこのためです。ready な Provider が1つも無ければ `DEPENDENCY_ERROR`（exit 1）で停止します。

#### 公開Tunnel には明示承認が必要

Cloudflare Quick Tunnel は `https://<ランダム>.trycloudflare.com` という**公開インターネット上の**アドレスを作ります。そのため作成前に承認を求めます。

- **対話環境**: 何が公開されるかを示す警告を表示し、yes/no を尋ねます（既定は **no**）
- **非対話環境（TTYなし）**: `--yes` が無い限り**拒否**し、exit 2 で終了します。「誰も見ていなかったので公開された」が起きないようにするためです
- **Tailscale が使えないことは、公開Tunnel へ切り替える理由になりません。** Provider の選択と公開の承認は別々の判断で、承認が無ければ公開されません
- **この確認を求めるのは公開Tunnel の Provider だけです。** `tailscale-serve` の公開先は自分の tailnet の中に閉じていてインターネットには出ないため、`--yes` は要りません

公開されるのは 127.0.0.1 で動く CommandMate サーバだけで、この PC の他のものは公開されません。CommandMate はトークン認証を有効にした状態で応答するため、ペアリングコードを持たない訪問者は拒否されますが、**リスナー自体は公開**です。あわせて[セキュリティガイド](../security-guide.md)も参照してください。

#### ペアリングコード

- **一度限り**で、既定 10 分（`--pairing-expires`）で失効します
- Crockford Base32 26 文字（128 bit）。**平文はどこにも保存されません**
- QR は `up` のときに**一度だけ**表示されます。端末幅が足りず走査可能な QR を描けない場合に限り、URL がテキストで出力されます（この URL はコードを含むため、スクロールバックに残ります）
- 受け渡しファイル `~/.commandmate/remote-pairing.json` は mode 0600 です。**消費済みフラグはファイルの不在そのもの**で、ペアリング成功と同時に削除されます

#### remote status の出力

```
Provider:        cloudflare-quick
URL:             https://<ランダム>.trycloudflare.com
Remote expires:  2026-08-29T21:00:00.000Z (in 6h 12m)
Pairing:         unused
Server:          running (pid 12345, http://localhost:3000, auth: on)
```

`Pairing:` は `unused` / `consumed` / `expired` のいずれかです。記録された remote セッションが無い場合は次のようになります。

```
Provider:        (none - no remote session recorded)
Server:          stopped
```

**ペアリングコードもセッショントークンも、この出力には現れません。** URL は公開情報なので表示されます。

#### 期限切れで閉じるのは「外への口」だけ

`--expires`（既定 8h）を過ぎたあとに `commandmate remote status` を実行すると、その場で Provider が閉じられます。**CommandMate サーバは止まりません** — 止めると PC でのローカル利用まで巻き添えになるためです。`up` はサーバをデーモンとして起動して戻るため常駐プロセスが残らず、期限の判定は `status` の実行時に行われます。

#### remote stop は推測で片付けない

- 状態ファイル（`~/.commandmate/remote.json`、mode 0600）が読めない場合、`remote stop` は **Provider を推測して片付けにいきません**。「片付けるものが分からない」と表示して exit 0 で終了します。Tailscale Serve のように、利用者自身の設定を消すと復元手段が無い Provider があるためです
- CommandMate は**自分が作ったものだけ**を取り消します。Provider が「このセッションより前から存在していた」と報告した設定は `Left alone (existed before this session):` として**報告されるだけで、削除されません**
- 閉じきれなかった場合は exit 4（STOP_FAILED）で終了し、状態ファイルは残るので `commandmate remote stop` を再実行できます
- 成功した場合も **CommandMate サーバは動いたまま**です

> **Tailscale の撤収は `commandmate remote stop` で行ってください。** `tailscale serve` に成功すると、Tailscale 自身が「パスを付けずにポートと `off` だけを指定して `serve` を再実行する」撤収方法を案内します。このパス無しの形は、そのポートの**すべて**のハンドラ（あなた自身が設定したものを含む）を、警告も無く exit 0 で消します。`remote stop` は必ず自分が作ったパスを指定して撃ちます。

#### サーバがすでに起動している場合

- **認証なしで起動中**: 認証を有効にして起動し直す必要があるため、確認のうえ停止・再起動します。非対話環境では `--yes` が無いと exit 2 で拒否されます
- **認証ありで起動中**: そのサーバのトークンハッシュは起動時に確定していて平文は保持していないため、**このセッションからはペアリングできません**。exit 2 で停止するので、`commandmate stop` してから `commandmate remote` を実行してください

#### remote がサーバへ渡す環境変数は3つだけ

`CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` / `CM_REMOTE_PAIRING_FILE` の3つで、3つ目は**秘匿値ではなくパス**です。平文の長期トークンを環境変数に置かないのは、tmux のペインがサーバの環境変数をそのまま継承するため — 置けば CommandMate が動かしているエージェント自身が読めてしまいます。`CM_BIND` は読みも書きもしないため、既存のバインド設定は変わりません。

#### `--json` の読み方

`status` と `stop` は JSON だけを出力するのでそのままパイプできます。`up` はサーバ起動の進捗行が stdout に混ざるため、**JSON は stdout の最終行**です。

```bash
commandmate remote status --json | jq -r '.remote.url'
```

> **`up --json` の `pairingUrl` にはペアリングコードが含まれます。** ログやファイルに残さないでください。`status` はこのフィールドを出力しません（コードを示すのは `up` だけです）。

#### Tunnel 越しの Cookie に `Secure` は付きません

認証 Cookie の `Secure` 属性は `CM_HTTPS_CERT` の有無で決まります。Tunnel 構成は**外側が HTTPS でオリジンは平文 HTTP** なので `Secure` は付きません。**これは正しい挙動です**: `Secure` を立てると `127.0.0.1` への HTTP アクセスで Cookie が拒まれ、ローカル利用が壊れます。Tunnel の外側は HTTPS なので、網線上の盗聴リスクは既に下がっています。

---

### commandmate agents

> **英語版について**: この節は `docs/en/user-guide/cli-operations-guide.md` へまだ反映されていません。
> 見出しレベルが `###` なのはそのためです（en/ja の `##` 見出し数を突き合わせる
> `tests/unit/docs/ja-en-heading-parity.test.ts` があり、片側だけに `##` を足せません）。

CommandMate が動かす**エージェント CLI 側**のバージョンを表示し、更新します（Issue #2069）。

> **`commandmate update` との違い**: `update` が更新するのは **CommandMate 本体**です。
> `agents update` が更新するのは **codex などのエージェント CLI** で、npm registry 上の
> パッケージも、再起動されるプロセスも別物です。

#### 使用方法

```bash
commandmate agents                       # = agents versions
commandmate agents versions              # インストール済みの版を一覧
commandmate agents versions --json       # JSON 出力
commandmate agents update codex          # 確認プロンプトつきで更新
commandmate agents update codex --yes    # 確認スキップ（非対話環境では必須。無い場合 exit 2）
commandmate agents update codex --check  # 実行するコマンドを表示するだけ（何も変更しない）
```

#### 出力例

```
TOOL         INSTALLED  LATEST   UPDATE
-----------  ---------  -------  ---------
antigravity  1.1.18
claude       2.1.251
codex        0.149.1    0.151.0  available
copilot      1.0.82
gemini       0.57.0
opencode     1.18.25

Update available for codex: 0.149.1 -> 0.151.0
Run "commandmate agents update codex" to install it.
```

#### LATEST 列が codex にしか出ない理由

**ネットワークを一切使わないため**です。INSTALLED はどのツールも `<cli> --version` の実測ですが、
「もっと新しい版があるか」は codex だけが自分で調べて `~/.codex/version.json`
（`latest_version` / `dismissed_version`）に書き出しており、CommandMate はそれを読んでいます。
他のツールにはその置き場所が無いので、**インストール済みの版だけ**を表示します。

- `$CODEX_HOME` が設定されていればそちらを見ます（絶対パスのときのみ）。
- ファイルが無い・壊れている・codex が一度も起動していない場合は「更新情報なし」として扱い、
  エラーにはなりません。
- codex 側でバナーを非表示にした版（`dismissed_version`）は注記されるだけで、
  更新ボタン／コマンドは塞ぎません。

#### 更新は pane の外で実行されます

codex の「Update now」は **codex プロセスを終了してから**インストーラを動かし、
`Update ran successfully! Please restart Codex.` を出して終わります（自動再起動はしません）。
これをエージェントの tmux pane の中で走らせると pane が素のシェルに落ちるため、
`agents update` は **CommandMate / CLI 自身の子プロセス**として実行します。

その結果として:

- **稼働中のセッションは中断されません。** ただし**起動済みのプロセスは古いバイナリのまま**です。
  新しい版で動かすには、そのセッションを一度終了してください（GUI の「再起動」ボタン、
  あるいは `commandmate instances <worktree-id> kill <instance-id>`）。次の送信で新しい版が起動します。
- 実行されるコマンドは codex 0.149.0 以降なら `codex update`（インストール方法を自動判別）、
  それ未満または codex が PATH に無い場合は `npm install -g @openai/codex@latest` です。
  `--check` でどちらになるかを事前に確認できます。

#### pane の中の update ダイアログとの関係

pane の中で codex が update ダイアログを出すことは**今でもあります**（利用者が自分で
`Update now` を押した場合など）。**その経路は塞がれておらず**、CommandMate が何と答えるかと
落ちた pane をどう復旧するかは `CM_CODEX_UPDATE_DIALOG`（[CLI セットアップガイド](./cli-setup-guide.md)）が
受け持ちます。インストール完了後に同じ pane へ起動コマンドを送り直すので、pane がシェルに
落ちたままにはなりません。

2 つの経路の違いはこうです:

| | pane の中の更新 | `agents update`（この節） |
|---|---|---|
| きっかけ | codex が聞いてきたとき（受動的） | 利用者が CommandMate から実行（能動的） |
| セッション | **一度落ちて再起動される** | **無傷のまま**（古いバイナリで動き続ける） |
| 実行コマンド | codex 自身の `npm install -g @openai/codex` | `codex update` または `npm install -g @openai/codex@latest` |

**同じグローバル install を撃つ経路が複数あるため**、CommandMate はツール単位の in-flight
ロックを持ち、API・CLI・pane 内更新のいずれもそれを取ります（同時実行は 409 / エラーで拒否）。

> **`@latest` の有無について**: codex 自身は `npm install -g @openai/codex` と書きます。
> これは npm の既定 dist-tag（通常 `latest`）を使う形で、`npm config set tag` を設定して
> いない環境では `@latest` 付きと同じ版になります。`agents update` のフォールバックが
> `@latest` を明示するのは、実行する argv が「押した時点では誰も見ていない npm の設定」に
> 依存しないようにするためです。

#### 終了コード

| コード | 意味 |
|:------:|------|
| 0 | 更新に成功、または `versions` / `--check` が正常終了 |
| 2 | 更新フローの無いツール名／codex も npm も PATH に無い／非対話環境で `--yes` が無い |
| 5 | 更新コマンド自体が失敗（`npm install -g` の権限エラーなど） |

#### GUI からの導線

同じ内容が **More 画面の「設定」**と、**worktree 詳細のエージェント一覧ペイン**（「エージェント CLI
のバージョン」を開く）にあります。更新中は出力がそのまま流れ、対象ツールのセッションが稼働中なら
「再起動が必要」の警告とインスタンス単位の再起動ボタンが出ます。

---

## 典型的なワークフロー

### 基本: send → wait → capture

```bash
# 1. worktree IDを取得
WT=$(commandmate ls --branch feature/101 --quiet)

# 2. メッセージ送信
commandmate send "$WT" "Issue #101 をTDDで実装してください"

# 3. 完了まで待機
commandmate wait "$WT" --timeout 600

# 4. 結果を確認
commandmate capture "$WT"
```

### Auto-Yes付き（確認プロンプトで止まらない）

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "Issue #101 を実装して" --auto-yes --duration 3h
commandmate wait "$WT" --timeout 1800
commandmate auto-yes "$WT" --disable    # 安全のため無効化
commandmate capture "$WT" --json
```

### プロンプト応答ループ

```bash
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "リファクタリングして"

while true; do
  commandmate wait "$WT" --timeout 600 --on-prompt agent
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "完了"
    break
  elif [ $EXIT_CODE -eq 10 ]; then
    # プロンプト検出 → 自動応答
    commandmate respond "$WT" "yes"
  elif [ $EXIT_CODE -eq 124 ]; then
    echo "タイムアウト"
    break
  fi
done

commandmate capture "$WT"
```

### 複数worktreeの並列操作

```bash
# 2つのworktreeに同時に指示
WT1=$(commandmate ls --branch feature/101 --quiet)
WT2=$(commandmate ls --branch feature/102 --quiet)

commandmate send "$WT1" "Issue #101 を実装して" --auto-yes
commandmate send "$WT2" "Issue #102 を実装して" --auto-yes --instance codex

# 完了を待つ。1回の wait に指定できる --instance は1つで全worktreeに適用されるため、
# インスタンスが異なる worktree は wait を分ける。
# ここで `wait "$WT2"` と書くと WT2 の「既定エージェント」を待ってしまう（wait に --agent は無い）
commandmate wait "$WT1" --timeout 1800
commandmate wait "$WT2" --instance codex --timeout 1800

# 結果をそれぞれ確認
commandmate capture "$WT1" --json
commandmate capture "$WT2" --instance codex --json
```

### エージェント稼働中の worktree でビルドしない（生成物ディレクトリの共有破損）

エージェント（worker）が作業中の worktree で、監督側が検証やビルド
（`npm run build` / `npm run preview` 等）を実行しないでください。双方が同じ生成物
ディレクトリ（`.next` / `dist` 等）に書き込むため、**両方のビルドが破損**します。

- 検証・ビルドは `commandmate wait` で worker の完了を確認してから実行する
- 稼働中にどうしても必要な場合は、別の worktree / 別ディレクトリに checkout して行う
- `commandmate verify` のゲートは worktree の作業ディレクトリで走るため、worker 稼働中の
  実行も同じ競合を起こします。完了後（`wait --verify` の裁定後）に実行してください

---

## トラブルシューティング

### サーバーに接続できない

```
Error: Server is not running. Start it with: commandmate start
```

**原因**: CommandMateサーバーが起動していない、またはポートが異なる。

**対処**:
```bash
# サーバー起動
commandmate start --daemon

# 別ポートの場合
CM_PORT=3011 commandmate ls
```

### worktree IDが見つからない

```
Error: Resource not found. Check the worktree ID.
```

**原因**: 指定したIDがサーバーに登録されていない。

**対処**:
```bash
# 登録済みIDを確認
commandmate ls --quiet

# worktreeを同期（新しく作成した場合）
curl -s -X POST http://localhost:3000/api/repositories/sync
```

### waitがタイムアウトする

**原因**: エージェントの処理に時間がかかっている、またはエラーで停止している。

**対処**:
```bash
# 現在の状態を確認
commandmate capture <id> --json

# タイムアウトを延長
commandmate wait <id> --timeout 3600

# ブラウザUIで直接確認
# http://localhost:3000 にアクセスし、該当worktreeのターミナルを確認
```

### respondが「prompt_no_longer_active」を返す

```
Warning: Response may not have been applied. Reason: prompt_no_longer_active
```

**原因**: プロンプトが既に消えている（Auto-Yesが自動応答した、またはタイミングのずれ）。

**対処**: エージェントの動作に影響はないため、そのまま `wait` で続行できます。

### 不正なdurationエラー

```
Error: Invalid duration. Must be one of: 1h, 3h, 8h
```

**対処**: `--duration` には `1h`, `3h`, `8h` のいずれかを指定してください。

### 不正なagentエラー

```
Error: Invalid agent. Must be one of: claude, codex, gemini, vibe-local, opencode, copilot, antigravity, command-code
```

**対処**: `--agent` には上記のいずれかを指定してください。

### 認証エラー

サーバーが `--auth` 付きで起動されている場合、トークンなしで接続するとエラーになります。

**対処**:
```bash
# 環境変数で指定（推奨）
CM_AUTH_TOKEN=your-token commandmate ls

# --token フラグで指定（プロセスリストに表示されるため注意）
commandmate ls --token your-token
```

---

## 全終了コード一覧

| コード | 定数名 | 意味 |
|:------:|--------|------|
| 0 | SUCCESS | 正常完了 |
| 1 | DEPENDENCY_ERROR | サーバー未起動等のインフラエラー／使える remote Provider が無い（`remote`） |
| 2 | CONFIG_ERROR | バリデーションエラー（不正なagent, duration等）／更新フローの無いツール（`agents update`） |
| 3 | START_FAILED | サーバーの起動・起動後の確認に失敗（`start` / `update` / `remote`） |
| 4 | STOP_FAILED | サーバーの停止に失敗（`stop` / `update`）／ Provider を閉じきれない（`remote stop`） |
| 5 | UPDATE_FAILED | 更新に失敗（`update`: registry照会 / `npm install -g` / バージョン検証、`agents update`: エージェント CLI の更新コマンド） |
| 10 | PROMPT_DETECTED | wait中にプロンプトを検出 |
| 30 | NO_ACTIVE_SESSIONS | interruptの対象となる稼働中セッションが無い |
| 99 | UNEXPECTED_ERROR | 予期しないエラー / リソース未検出 |
| 124 | TIMEOUT | waitのタイムアウト |

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - CommandMateの基本的な使い方
- [コマンド利用ガイド](./commands-guide.md) - スラッシュコマンドの詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
