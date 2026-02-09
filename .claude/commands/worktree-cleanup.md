# Worktree Cleanup スキル

## 概要

指定したIssue番号に対応するGit Worktree環境をクリーンアップするスキルです。

## 使用方法

```bash
/worktree-cleanup [Issue番号...]
```

**例**:
```bash
/worktree-cleanup 135
/worktree-cleanup 187 188 191 193
```

## 実行内容

あなたはWorktree環境クリーンアップの専門家です。以下の手順でWorktree環境を安全にクリーンアップしてください。
複数のIssue番号が指定された場合は、各Issueに対してPhase 1〜5を順番に繰り返し実行します。

### パラメータ

- **issue_numbers**: 対象Issue番号（必須、1つ以上、スペース区切り、各番号は正の整数）

---

## 実行フェーズ

**複数Issue指定時**: 以下のPhase 1〜5を各Issueに対して順番に実行します。
Phase 6（Worktree同期）は全Issue完了後にまとめて1回実行します。

### Phase 1: 入力検証

1. Issue番号が正の整数であることを確認
2. Issue番号が1〜2147483647の範囲内であることを確認

```bash
# 共通バリデーション関数を読み込み
# Synced with: src/cli/utils/input-validators.ts MAX_ISSUE_NO
source "$(dirname "$0")/../lib/validators.sh"

# Issue番号の検証
if ! validate_issue_no "$ISSUE_NO"; then
  echo "Error: Invalid issue number"
  exit 1
fi
```

### Phase 2: サーバー停止

1. Issue専用サーバーが起動中か確認（PIDファイルベース）
2. ポートベースでサーバーを検出（フォールバック）
3. 起動中の場合は停止

```bash
# プロセス管理ユーティリティを読み込み
source "$(dirname "$0")/../lib/process-utils.sh"

# Worktreeの絶対パスを取得
WORKTREE_DIR="../commandmate-issue-${ISSUE_NO}"
WORKTREE_ABS=$(cd "$WORKTREE_DIR" 2>/dev/null && pwd)

# Step 1: PIDファイルベースの検出（既存ロジック）
PID_FILE=~/.commandmate/pids/${ISSUE_NO}.pid

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping server for Issue #${ISSUE_NO} (PID: $PID)..."
    kill "$PID"
    sleep 3
    # 強制終了（必要な場合）
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
  fi
  rm -f "$PID_FILE"
fi

# Step 2: ポートベースの検出（フォールバック）
# npm run devで直接起動したサーバーはPIDファイルがないため、ポートで検出
if check_lsof_available && [ -n "$WORKTREE_ABS" ]; then
  # 検出対象ポートの配列を構築
  PORTS_TO_CHECK=(3000)  # デフォルトポート

  # Issue専用ポート（4桁以下のIssue番号のみ）
  # ポート番号上限65535のため、3{issueNo}形式は1-9999まで
  if [ "$ISSUE_NO" -le 9999 ]; then
    PORTS_TO_CHECK+=("3${ISSUE_NO}")
  fi

  # 各ポートをチェック
  for PORT in "${PORTS_TO_CHECK[@]}"; do
    stop_server_by_port "$PORT" "$WORKTREE_ABS" "$ISSUE_NO"
  done
fi
```

### Phase 3: Worktree削除

1. Worktreeの存在確認
2. git worktree removeコマンドを実行

```bash
WORKTREE_DIR="../commandmate-issue-${ISSUE_NO}"

# Worktree存在チェック
if git worktree list | grep -q "commandmate-issue-${ISSUE_NO}"; then
  echo "Removing worktree: $WORKTREE_DIR"
  git worktree remove "$WORKTREE_DIR" --force
else
  echo "Worktree not found: $WORKTREE_DIR"
fi
```

### Phase 4: ブランチ削除（オプション）

1. featureブランチがマージ済みか確認
2. マージ済みの場合は削除（未マージの場合は警告のみ）

```bash
BRANCH_NAME="feature/${ISSUE_NO}-worktree"

# ブランチ存在チェック
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  # マージ済みかチェック
  if git branch --merged main | grep -q "$BRANCH_NAME"; then
    echo "Deleting merged branch: $BRANCH_NAME"
    git branch -d "$BRANCH_NAME"
  else
    echo "WARNING: Branch not merged: $BRANCH_NAME"
    echo "   Run 'git branch -D $BRANCH_NAME' to force delete"
  fi
fi
```

### Phase 5: リソースクリーンアップ

1. Issue専用DBファイルの削除（オプション）
2. Issue専用ログファイルの削除（オプション）

```bash
# DB削除の確認
DB_FILE=~/.commandmate/data/cm-${ISSUE_NO}.db
if [ -f "$DB_FILE" ]; then
  echo "DB file found: $DB_FILE"
  read -p "Delete DB file? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$DB_FILE"
    echo "DB file deleted"
  fi
fi

# ログ削除
LOG_FILE=~/.commandmate/logs/commandmate-${ISSUE_NO}.log
if [ -f "$LOG_FILE" ]; then
  rm -f "$LOG_FILE"
  echo "Log file deleted: $LOG_FILE"
fi
```

### Phase 6: Worktree同期

削除したWorktreeをCommandMateから除外するため、同期APIを呼び出します。

```bash
# CommandMateサーバーが起動している場合
curl -s -X POST http://localhost:${CM_PORT:-3000}/api/repositories/sync

# または、メインリポジトリに戻ってサーバーを再起動
# cd /path/to/main/repo && npm run dev
```

**重要**: この同期処理により、削除したWorktreeがCommandMateのトップ画面から除外されます。

---

## 出力例

### 単一Issue

```
✅ Worktree Cleanup Complete!

📋 Cleanup Summary:
  Issue:     #135
  Server:    Stopped (PID: 12345)
  Worktree:  Removed (../commandmate-issue-135)
  Branch:    Deleted (feature/135-worktree)
  DB:        Preserved (~/.commandmate/data/cm-135.db)

⚠️  Note: DB file preserved. Delete manually if needed:
    rm ~/.commandmate/data/cm-135.db
```

### 複数Issue

```
✅ Worktree Cleanup Complete! (4 issues)

📋 Cleanup Summary:

  Issue #187:
    Server:    Not running
    Worktree:  Removed (../commandmate-issue-187)
    Branch:    Deleted (feature/187-worktree) [merged]

  Issue #188:
    Server:    Not running
    Worktree:  Removed (../commandmate-issue-188)
    Branch:    Deleted (feature/188-worktree) [merged]

  Issue #191:
    Server:    Not running
    Worktree:  Removed (../commandmate-issue-191)
    Branch:    Deleted (feature/191-worktree) [merged]

  Issue #193:
    Server:    Stopped (PID: 54321)
    Worktree:  Removed (../commandmate-issue-193)
    Branch:    ⚠️ Not merged (feature/193-worktree)

🔄 Worktree sync completed.
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| Invalid issue number | 正の整数（1-2147483647）を指定してください |
| Worktree not found | 既に削除済みか、存在しません |
| Branch not merged | PRをマージするか、`git branch -D`で強制削除 |
| Server stop failed | `kill -9`で強制終了、またはPIDファイルを手動削除 |

---

## セキュリティ考慮

- Issue番号は整数検証を実施（コマンドインジェクション防止）
- ファイル削除前にパス検証（~/.commandmate/内のみ許可）
- DBファイル削除は明示的な確認を要求

---

## 関連コマンド

- `/worktree-setup`: Worktree環境のセットアップ
- `commandmate stop --issue {issueNo}`: Issue専用サーバー停止
- `commandmate status --issue {issueNo}`: Issue専用サーバー状態確認
