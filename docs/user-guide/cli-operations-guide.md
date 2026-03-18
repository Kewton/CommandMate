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

---

## commandmate ls

worktree一覧をステータス付きで表示します。

### 使用方法

```bash
commandmate ls                          # テーブル形式
commandmate ls --json                   # JSON形式（エージェント向け）
commandmate ls --quiet                  # IDのみ（1行1ID、パイプ用）
commandmate ls --branch feature/        # ブランチ名プレフィックスでフィルタ
```

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
commandmate send <worktree-id> "<message>" --auto-yes          # Auto-Yes有効化
commandmate send <worktree-id> "<message>" --auto-yes --duration 3h
commandmate send <worktree-id> "<message>" --auto-yes --stop-pattern "FAILED"
```

### オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--agent <id>` | エージェント種別（claude, codex, gemini, vibe-local, opencode） | claude |
| `--auto-yes` | 送信前にAuto-Yesを有効化 | - |
| `--duration <d>` | Auto-Yesの有効期間（1h, 3h, 8h） | 1h |
| `--stop-pattern <p>` | Auto-Yes停止条件（正規表現） | - |

### worktree ID の調べ方

```bash
# 全ID一覧
commandmate ls --quiet

# ブランチ名でフィルタしてID取得
commandmate ls --branch feature/101 --quiet
# → mycodebranchdesk-feature-101

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
```

### オプション

| オプション | 説明 |
|-----------|------|
| `--enable` | Auto-Yesを有効化 |
| `--disable` | Auto-Yesを無効化 |
| `--duration <d>` | 有効期間（1h, 3h, 8h） |
| `--stop-pattern <p>` | 指定パターンがターミナル出力に出現したら自動停止 |
| `--agent <id>` | 対象エージェント |

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
| 10 | PROMPT_DETECTED | wait中にプロンプトを検出 |
| 99 | UNEXPECTED_ERROR | 予期しないエラー / リソース未検出 |
| 124 | TIMEOUT | waitのタイムアウト |

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - CommandMateの基本的な使い方
- [コマンド利用ガイド](./commands-guide.md) - スラッシュコマンドの詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
