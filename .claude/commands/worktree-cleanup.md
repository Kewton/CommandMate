# Worktree Cleanup スキル

## 概要

指定したIssue番号に対応するGit Worktree環境をクリーンアップするスキルです。

## 使用方法

```bash
/worktree-cleanup [Issue番号]
```

**例**:
```bash
/worktree-cleanup 135
/worktree-cleanup 200
```

## 実行内容

あなたはWorktree環境クリーンアップの専門家です。以下の手順でWorktree環境を安全にクリーンアップしてください。

### パラメータ

- **issue_number**: 対象Issue番号（必須、正の整数）

---

## 実行フェーズ

### Phase 1: 入力検証

1. Issue番号が正の整数であることを確認
2. Issue番号が1〜999999の範囲内であることを確認

```bash
# Issue番号の検証
if ! [[ "$ISSUE_NO" =~ ^[0-9]+$ ]] || [ "$ISSUE_NO" -lt 1 ] || [ "$ISSUE_NO" -gt 999999 ]; then
  echo "Error: Invalid issue number"
  exit 1
fi
```

### Phase 2: サーバー停止

1. Issue専用サーバーが起動中か確認
2. 起動中の場合は停止

```bash
PID_FILE=~/.commandmate/pids/${ISSUE_NO}.pid

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping server for Issue #${ISSUE_NO} (PID: $PID)..."
    kill "$PID"
    sleep 2
    # 強制終了（必要な場合）
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
  fi
  rm -f "$PID_FILE"
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
    echo "⚠️  Branch not merged: $BRANCH_NAME"
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

---

## 出力例

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

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| Invalid issue number | 正の整数（1-999999）を指定してください |
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
