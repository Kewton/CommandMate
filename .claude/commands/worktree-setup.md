# Worktree Setup スキル

## 概要

指定したIssue番号に対応するGit Worktree環境を自動構築するスキルです。

## 使用方法

```bash
/worktree-setup [Issue番号]
```

**例**:
```bash
/worktree-setup 135
/worktree-setup 200
```

## 実行内容

あなたはWorktree環境セットアップの専門家です。以下の手順でWorktree環境を構築してください。

### パラメータ

- **issue_number**: 対象Issue番号（必須、正の整数）

---

## 実行フェーズ

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

### Phase 2: 前提条件チェック

1. 現在のディレクトリがGitリポジトリであることを確認
2. developブランチが存在することを確認
3. git worktreeコマンドが利用可能であることを確認

```bash
# Gitリポジトリチェック
git rev-parse --git-dir > /dev/null 2>&1 || { echo "Error: Not a git repository"; exit 1; }

# developブランチ存在チェック
git show-ref --verify --quiet refs/heads/develop || { echo "Error: develop branch not found"; exit 1; }
```

### Phase 3: Worktree作成

1. featureブランチ名を決定: `feature/{issue_number}-worktree`
2. Worktreeディレクトリを決定: `../commandmate-issue-{issue_number}`
3. git worktree addコマンドを実行

```bash
BRANCH_NAME="feature/${ISSUE_NO}-worktree"
WORKTREE_DIR="../commandmate-issue-${ISSUE_NO}"

# 既存Worktreeチェック
if git worktree list | grep -q "$WORKTREE_DIR"; then
  echo "Worktree already exists: $WORKTREE_DIR"
else
  # Worktree作成（developブランチから派生）
  git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" develop
fi
```

### Phase 4: 環境設定

1. Worktreeディレクトリに移動
2. 依存関係インストール（必要な場合）
3. Issue専用DBパスを設定

```bash
cd "$WORKTREE_DIR"

# 依存関係インストール（node_modulesがない場合）
if [ ! -d "node_modules" ]; then
  npm install
fi

# .envファイルにIssue固有設定を追加（存在しない場合）
if [ ! -f ".env" ]; then
  cp ~/.commandmate/.env .env 2>/dev/null || touch .env
fi
```

### Phase 5: サーバー起動（オプション）

Issue専用ポートでサーバーを起動する場合：

```bash
# ポート範囲: 3001-3100（メインは3000）
PORT=$((3000 + ISSUE_NO % 100 + 1))

# サーバー起動
CM_PORT=$PORT CM_DB_PATH=~/.commandmate/data/cm-${ISSUE_NO}.db npm run dev
```

### Phase 6: Worktree同期

新しいWorktreeをCommandMateに認識させるため、同期APIを呼び出します。

```bash
# CommandMateサーバーが起動している場合
curl -s -X POST http://localhost:${CM_PORT:-3000}/api/repositories/sync

# または、メインリポジトリに戻ってサーバーを再起動
# cd /path/to/main/repo && npm run dev
```

**重要**: この同期処理により、新しいWorktreeがCommandMateのトップ画面に表示されるようになります。

---

## 出力例

```
✅ Worktree Setup Complete!

📋 Environment Information:
  Issue:     #135
  Branch:    feature/135-worktree
  Directory: ../commandmate-issue-135
  DB Path:   ~/.commandmate/data/cm-135.db

🔧 Next Steps:
  1. cd ../commandmate-issue-135
  2. npm run dev (or commandmate start --issue 135)

📌 Cleanup:
  /worktree-cleanup 135
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| Invalid issue number | 正の整数（1-2147483647）を指定してください |
| Not a git repository | Gitリポジトリ内で実行してください |
| develop branch not found | developブランチを作成してください |
| Worktree already exists | 既存のWorktreeを使用するか、cleanupしてください |

---

## セキュリティ考慮

- Issue番号は整数検証を実施（コマンドインジェクション防止）
- ブランチ名は英数字とハイフンのみ許可
- ディレクトリパスはホームディレクトリ外への展開を禁止

---

## 関連コマンド

- `/worktree-cleanup`: Worktree環境のクリーンアップ
- `commandmate start --issue {issueNo}`: Issue専用サーバー起動
- `commandmate stop --issue {issueNo}`: Issue専用サーバー停止
