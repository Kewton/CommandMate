[English](../en/user-guide/cli-operations-guide.md)

# CLI操作コマンドガイド

CommandMateのCLIから、起動中のエージェントセッションを操作するコマンドのガイドです。
これらのコマンドを使用することで、コーディングエージェント（Claude Code, Codex等）が他のエージェントを並列操作できるようになります。

---

## 前提条件

- CommandMateサーバーが起動中であること（`commandmate start --daemon`）
- 操作対象のworktreeがサーバーに登録済みであること（ブラウザUIのサイドバーに表示されていること）

### サーバーポートの指定

CLIはデフォルトで `localhost:3000` に接続します。別のポートで起動している場合は `CM_PORT` 環境変数で指定します。

```bash
# デフォルト（ポート3000）
commandmate ls

# 別ポートのサーバーに接続
CM_PORT=3011 commandmate ls
```

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
| [`commandmate send`](#commandmate-send) | エージェントへのメッセージ送信 |
| [`commandmate wait`](#commandmate-wait) | エージェント完了の待機 |
| [`commandmate respond`](#commandmate-respond) | プロンプトへの応答 |
| [`commandmate capture`](#commandmate-capture) | ターミナル出力の取得 |
| [`commandmate auto-yes`](#commandmate-auto-yes) | Auto-Yesの制御 |
| [`commandmate instances`](#commandmate-instances) | エージェントインスタンス（roster）の一覧・追加・削除・alias変更 |
| [`commandmate report`](#commandmate-report) | 日次レポートの生成・表示・一覧 |
| [`commandmate skill`](#commandmate-skill) | 公式Skillのカタログ参照・Install Plan・install・uninstall・status |
| [`commandmate update`](#commandmate-update) | CommandMate本体の更新（停止 → 更新 → 再起動） |

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

> **`--id` について**: worktree ID は `<リポジトリ名>-<ブランチ名>` 形式のスラッグ（例 `anvil-develop`）です。`--id` はこの ID の前方一致でフィルタします。`--branch` と `--id` は独立して適用され、同時指定すると両方が適用されます（AND）。同一ブランチ名（例 `develop`）が複数リポジトリに存在する場合、`--id anvil-` のように ID プレフィックスで特定リポジトリの worktree に絞り込めます。前方一致は case-sensitive で、一意性は保証しません（`--id anvil-develop` は `anvil-develop-2` にもマッチし得ます）。厳密に1件へ絞るには `--quiet` の出力を `grep -x` する等してください。

### 出力例

```
ID                                               NAME                  STATUS   DEFAULT
-----------------------------------------------  --------------------  -------  ------
localllm-test-main                               main                  ready    claude
mycodebranchdesk-develop                         develop               running  claude
mycodebranchdesk-feature-518-worktree            feature/518-worktree  ready    claude
mycodebranchdesk-main                            main                  idle     claude
```

### STATUS列の意味

| ステータス | 意味 |
|-----------|------|
| `idle` | セッション未起動 |
| `ready` | セッション起動中・入力待ち（タスク完了後の状態） |
| `running` | エージェントがタスク実行中 |
| `waiting` | 確認プロンプト待ち（Yes/No等） |

---

## commandmate send

指定worktreeのエージェントにメッセージを送信します（非同期）。セッションが未起動の場合は自動的に起動します。

### 使用方法

```bash
commandmate send <worktree-id> "<message>"
commandmate send <worktree-id> "<message>" --agent codex      # エージェント指定
commandmate send <worktree-id> "<message>" --agent codex --instance codex-2  # 追加インスタンス宛て
commandmate send <worktree-id> "<message>" --agent codex --instance codex-2 --register  # rosterへ登録
commandmate send <worktree-id> "<message>" --auto-yes          # Auto-Yes有効化
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
commandmate send <worktree-id> "<message>" --auto-yes --stop-pattern "FAILED"
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--agent <id>` | エージェント種別（claude, codex, gemini, vibe-local, opencode, copilot, antigravity） | claude |
| `--instance <id>` | インスタンスID。`<agent>` または `<agent>-<n>`（例: `claude-2`）。未起動なら自動起動 | エージェントのプライマリインスタンス |
| `--register` | `--instance` で指定したセッションをroster（エージェントインスタンス一覧）に登録 | - |
| `--auto-yes` | 送信前にAuto-Yesを有効化 | - |
| `--duration <d>` | Auto-Yesの有効期間（1h, 3h, 8h） | 1h |
| `--stop-pattern <p>` | Auto-Yes停止条件（正規表現） | - |

> `--instance` の詳細（ID規約・rosterとの関係）は [マルチセッション（1エージェント複数セッション）](#マルチセッション1エージェント複数セッション) を参照してください。

### worktree ID の調べ方

```bash
# 全ID一覧
commandmate ls --quiet

# ブランチ名でフィルタしてID取得
commandmate ls --branch feature/101 --quiet
# → mycodebranchdesk-feature-101

# worktree IDプレフィックスでフィルタ（同一ブランチ×複数リポジトリの絞り込み）
commandmate ls --id anvil- --quiet
# → anvil-develop

# 変数に格納
WT=$(commandmate ls --branch feature/101 --quiet)
commandmate send "$WT" "実装してください"
```

---

## commandmate wait

指定worktreeのエージェントが完了するまでブロッキング待機します。

### 使用方法

```bash
commandmate wait <worktree-id> --timeout 300
commandmate wait <id1> <id2> --timeout 600          # 複数同時待機
commandmate wait <worktree-id> --on-prompt agent     # プロンプト検出で返却（デフォルト）
commandmate wait <worktree-id> --on-prompt human     # プロンプトは人間がUIで応答
commandmate wait <worktree-id> --stall-timeout 120   # 出力変化なしの検出
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--timeout <sec>` | 最大待機時間（秒） | 無制限 |
| `--on-prompt <mode>` | プロンプト検出時の動作（agent / human） | agent |
| `--stall-timeout <sec>` | 出力変化なしのタイムアウト（秒） | - |
| `--instance <id>` | 対象インスタンスID（`<agent>` または `<agent>-<n>`） | エージェントのプライマリインスタンス |

### 終了コード

| コード | 意味 | 次のアクション |
|:------:|------|---------------|
| 0 | 正常完了（エージェントが入力待ちに戻った） | `capture` で結果取得 |
| 10 | プロンプト検出（`--on-prompt agent` 時） | `respond` で応答し、再度 `wait` |
| 124 | タイムアウト | `capture` で状況確認、再度 `wait` or 中断 |

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

### 進捗表示

進捗メッセージはstderrに出力されます。stdoutは最終結果（JSON）のみです。

```
# stderr:
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Waiting: localllm-test-main (status=running, running=true, prompt=false)
Completed: localllm-test-main
```

---

## commandmate respond

エージェントのプロンプト（確認ダイアログ等）に応答を送信します。

### 使用方法

```bash
commandmate respond <worktree-id> "yes"          # Yes/No
commandmate respond <worktree-id> "2"            # 複数選択（番号）
commandmate respond <worktree-id> "text"         # テキスト入力
commandmate respond <worktree-id> "yes" --agent claude
commandmate respond <worktree-id> "yes" --agent codex --instance codex-2  # 追加インスタンス宛て
```

### 終了コード

| コード | 意味 |
|:------:|------|
| 0 | 応答成功 |
| 99 | プロンプトが既に消えている（`prompt_no_longer_active`）|

---

## commandmate capture

指定worktreeのターミナル出力を取得します。

### 使用方法

```bash
commandmate capture <worktree-id>                # テキスト出力
commandmate capture <worktree-id> --json          # JSON出力（ステータス情報付き）
commandmate capture <worktree-id> --agent codex   # エージェント指定
commandmate capture <worktree-id> --agent codex --instance codex-2  # 追加インスタンス指定
```

### JSON出力の主要フィールド

```json
{
  "isRunning": true,
  "sessionStatus": "ready",
  "cliToolId": "claude",
  "lineCount": 42,
  "isPromptWaiting": false,
  "autoYes": { "enabled": false, "expiresAt": null }
}
```

---

## commandmate auto-yes

Auto-Yes（確認プロンプト自動応答）を個別に制御します。

### 使用方法

```bash
commandmate auto-yes <worktree-id> --enable                    # 有効化（デフォルト1h）
commandmate auto-yes <worktree-id> --enable --duration 3h       # 期間指定
commandmate auto-yes <worktree-id> --enable --stop-pattern "error"  # 停止条件
commandmate auto-yes <worktree-id> --disable                    # 無効化
commandmate auto-yes <worktree-id> --enable --agent codex       # エージェント指定
commandmate auto-yes <worktree-id> --enable --agent codex --instance codex-2  # 追加インスタンス個別制御
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--enable` | Auto-Yesを有効化 |
| `--disable` | Auto-Yesを無効化 |
| `--duration <d>` | 有効期間（1h, 3h, 8h） |
| `--stop-pattern <p>` | 指定パターンがターミナル出力に出現したら自動停止 |
| `--agent <id>` | 対象エージェント |
| `--instance <id>` | 対象インスタンスID。他インスタンスと独立してAuto-Yesを制御 |

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

```
INSTANCE_ID  ALIAS   CLI_TOOL  RUNNING  AUTO_YES
-----------  ------  --------  -------  --------
claude       Claude  claude    yes      no
codex-2      レビュー用 codex     no       no
```

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

### rosterとの関係

- **roster** = ブラウザUIのAgentパネルで管理される、正式なインスタンス一覧（表示順・alias付き）。`commandmate instances` で一覧・追加・削除・alias変更ができます。
- `send --instance <id>` は roster に**登録されていなくても**セッションを自動起動します（アドホック実行）。ただし roster に無いインスタンスはUIのサイドバー/タブには表示されません。
- `send ... --instance <id> --register` を付けると、送信後にそのインスタンスを roster へ自動登録します。UIと状態を一致させたい場合はこちらを使ってください。
- 有効な `--instance` の値を調べるには `commandmate instances <worktree-id>` で roster と稼働中セッションを確認します。

### per-instance Auto-Yes

`--instance` 付きで `--auto-yes` / `auto-yes --enable` を実行すると、そのインスタンスのAuto-Yesは他インスタンスと独立して有効化・停止されます。

### 使用例

```bash
WT=$(commandmate ls --branch feature/101 --quiet)

# roster確認（有効な --instance 値を調べる）
commandmate instances "$WT"

# 追加インスタンスをrosterに登録してから使う
commandmate instances "$WT" add --agent codex --alias "レビュー用"
commandmate send "$WT" "差分をレビューして" --agent codex --instance codex-2 --auto-yes
commandmate wait "$WT" --instance codex-2 --timeout 600
commandmate capture "$WT" --agent codex --instance codex-2 --json

# アドホックに起動しつつ、その場でrosterに登録
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
```

### サブコマンド

| サブコマンド | 用途 |
|-------------|------|
| `generate` | 指定日のレポートを生成し、内容を標準出力に表示 |
| `show` | 既存レポートを表示（未生成なら `No report found` を表示） |
| `list` | 直近 N 日分のレポート有無・メッセージ件数・生成ツールを一覧 |

### generate オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--date <date>` | 対象日（`YYYY-MM-DD`） | 当日 |
| `--tool <tool>` | 使用するAIツール（claude, codex, copilot） | claude |
| `--model <model>` | モデル名（copilot 向け） | - |
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
> `--tool` は claude / codex / copilot のいずれか、`--days` は 1 以上を指定してください。

### list 出力例

```
2026-06-21  [report] tool=claude  messages=12
2026-06-20  [no report]  messages=3
2026-06-19  [report] tool=codex  messages=8
```

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

### 確認規約（install / uninstall）

| 状況 | 挙動 |
|------|------|
| 常に | 先に plan を構築して内容を表示する |
| `--dry-run` | plan までで停止し、書き込み・削除を行わない |
| TTY かつ `--yes` なし | plan summary を表示してから確認プロンプト（stderr）を出す |
| **非TTY かつ `--yes` なし** | **書き込まず exit 12**。プロンプトを出せない環境で暗黙実行しない |
| **high-risk Skill** | `--yes` に加えて `--ack-risk <skill-id>@<version>` の**完全一致**が必要。`--yes` だけでは通らない（TTY で承諾しても同じ） |

### オプション

| オプション | 対象サブコマンド | 説明 |
|-----------|-----------------|------|
| `--worktree <id>` | plan / install / uninstall / status | 対象worktree ID（`commandmate ls` で確認） |
| `--version <version>` | info / plan / install | install では**必須**（exact version） |
| `--dry-run` | install / uninstall | plan までで停止 |
| `-y, --yes` | install / uninstall | 確認プロンプトをスキップ（非対話環境では必須） |
| `--ack-risk <id>@<version>` | install | high-risk Skill の明示的な承認 |
| `--prerelease` | list / info / plan / install | prerelease version を対象に含める |
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
commandmate send "$WT2" "Issue #102 を実装して" --auto-yes --agent codex

# 両方の完了を待つ
commandmate wait "$WT1" "$WT2" --timeout 1800

# 結果をそれぞれ確認
commandmate capture "$WT1" --json
commandmate capture "$WT2" --json
```

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
Error: Invalid agent. Must be one of: claude, codex, gemini, vibe-local, opencode
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
| 1 | DEPENDENCY_ERROR | サーバー未起動等のインフラエラー |
| 2 | CONFIG_ERROR | バリデーションエラー（不正なagent, duration等） |
| 3 | START_FAILED | サーバーの起動・起動後の確認に失敗（`start` / `update`） |
| 4 | STOP_FAILED | サーバーの停止に失敗（`stop` / `update`） |
| 5 | UPDATE_FAILED | 更新に失敗（`update`: registry照会 / `npm install -g` / バージョン検証） |
| 10 | PROMPT_DETECTED | wait中にプロンプトを検出 |
| 99 | UNEXPECTED_ERROR | 予期しないエラー / リソース未検出 |
| 124 | TIMEOUT | waitのタイムアウト |

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - CommandMateの基本的な使い方
- [コマンド利用ガイド](./commands-guide.md) - スラッシュコマンドの詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
