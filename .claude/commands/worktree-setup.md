# Worktree Setup スキル

## 概要

指定したIssue番号に対応するGit Worktree環境を自動構築するスキルです。

## 使用方法

```bash
/worktree-setup [Issue番号...]
```

**例**:
```bash
/worktree-setup 135
/worktree-setup 187 188 191 193
```

## 実行内容

あなたはWorktree環境セットアップの専門家です。以下の手順でWorktree環境を構築してください。
複数のIssue番号が指定された場合は、各Issueに対してPhase 1〜7を順番に繰り返し実行します。

### パラメータ

- **issue_numbers**: 対象Issue番号（必須、1つ以上、スペース区切り、各番号は正の整数）

---

## 実行フェーズ

**複数Issue指定時**: 以下のPhase 1〜7を各Issueに対して順番に実行します。
ただし、Phase 2（前提条件チェック）は初回のみ実行し、Phase 6（Worktree同期）は全Issue完了後にまとめて1回実行します。

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
# --include=dev: シェルが NODE_ENV=production だと vitest / eslint などが入らない
if [ ! -d "node_modules" ]; then
  npm install --include=dev
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

### Phase 7: GitHub Project Status更新

IssueのGitHub ProjectステータスをIn Progressに変更します。

**前提条件**: `gh auth` に `read:project` と `project` スコープが必要です。
未設定の場合は以下を実行: `gh auth refresh -s read:project,project`

```bash
# リポジトリ情報取得
REPO_OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO_NAME=$(gh repo view --json name --jq '.name')

# プロジェクト番号取得（最初のプロジェクトを使用）
PROJECT_NUMBER=$(gh project list --owner "$REPO_OWNER" --format json --jq '.projects[0].number')

if [ -z "$PROJECT_NUMBER" ]; then
  echo "⚠️ GitHub Project status update skipped: no project found or missing scopes"
  echo "   To enable: gh auth refresh -s read:project,project"
else
  # IssueをProjectに追加（既に追加済みの場合はそのまま）
  ISSUE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/${ISSUE_NO}"
  ITEM_ID=$(gh project item-add "$PROJECT_NUMBER" --owner "$REPO_OWNER" --url "$ISSUE_URL" --format json --jq '.id')

  if [ -n "$ITEM_ID" ]; then
    # Project ID、Statusフィールド情報をGraphQLで取得
    PROJECT_INFO=$(gh api graphql -f query='
      query($owner: String!, $number: Int!) {
        user(login: $owner) {
          projectV2(number: $number) {
            id
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options { id name }
              }
            }
          }
        }
      }
    ' -f owner="$REPO_OWNER" -F number="$PROJECT_NUMBER")

    PROJECT_ID=$(echo "$PROJECT_INFO" | jq -r '.data.user.projectV2.id')
    STATUS_FIELD_ID=$(echo "$PROJECT_INFO" | jq -r '.data.user.projectV2.field.id')
    IN_PROGRESS_OPTION_ID=$(echo "$PROJECT_INFO" | jq -r '.data.user.projectV2.field.options[] | select(.name == "In progress") | .id')

    # ステータスを "In Progress" に変更
    if [ -n "$IN_PROGRESS_OPTION_ID" ]; then
      gh api graphql -f query='
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: { singleSelectOptionId: $optionId }
          }) {
            projectV2Item { id }
          }
        }
      ' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$STATUS_FIELD_ID" -f optionId="$IN_PROGRESS_OPTION_ID"

      echo "✅ GitHub Project status updated to 'In Progress'"
    else
      echo "⚠️ 'In Progress' status option not found in project"
    fi
  fi
fi
```

**注意**: この Phase はスコープ不足やProject未設定でもWorktreeセットアップ全体を失敗させません。警告を表示してスキップします。

---

## 出力例

### 単一Issue

```
✅ Worktree Setup Complete!

📋 Environment Information:
  Issue:     #135
  Branch:    feature/135-worktree
  Directory: ../commandmate-issue-135
  DB Path:   ~/.commandmate/data/cm-135.db
  Project:   ✅ Status → In Progress

🔧 Next Steps:
  1. cd ../commandmate-issue-135
  2. npm run dev (or commandmate start --issue 135)

📌 Cleanup:
  /worktree-cleanup 135
```

### 複数Issue

```
✅ Worktree Setup Complete! (4 issues)

📋 Environment Information:

  Issue #187:
    Branch:    feature/187-worktree
    Directory: ../commandmate-issue-187
    Project:   ✅ Status → In Progress

  Issue #188:
    Branch:    feature/188-worktree
    Directory: ../commandmate-issue-188
    Project:   ✅ Status → In Progress

  Issue #191:
    Branch:    feature/191-worktree
    Directory: ../commandmate-issue-191
    Project:   ✅ Status → In Progress

  Issue #193:
    Branch:    feature/193-worktree
    Directory: ../commandmate-issue-193
    Project:   ✅ Status → In Progress

📌 Cleanup:
  /worktree-cleanup 187 188 191 193
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| Invalid issue number | 正の整数（1-2147483647）を指定してください |
| Not a git repository | Gitリポジトリ内で実行してください |
| develop branch not found | developブランチを作成してください |
| Worktree already exists | 既存のWorktreeを使用するか、cleanupしてください |
| No project found / missing scopes | `gh auth refresh -s read:project,project` を実行してください |
| 'In Progress' option not found | GitHub ProjectのStatusフィールドに "In Progress" オプションを追加してください |

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
