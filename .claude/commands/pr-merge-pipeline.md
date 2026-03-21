---
model: sonnet
description: "複数IssueのPR作成→CI通過→順次マージ→統合検証を自動化"
---

# PR Merge Pipeline

## 概要
複数ワーカー（featureブランチ worktree）のPR作成からdevelopへのマージ完了までを一貫して自動化するパイプラインです。commandmatedev CLIで各ワーカーを制御し、PR作成→CI通過待ち→順次マージ→統合ビルド検証を行います。

## 使用方法
- `/pr-merge-pipeline [Issue番号1] [Issue番号2] ...`
- `/pr-merge-pipeline [Issue番号1] [Issue番号2] --merge-order 24,25` （マージ順序を指定）
- `/pr-merge-pipeline [Issue番号1] [Issue番号2] --skip-pr` （PR作成済みの場合）

## 前提条件
- developブランチ上で実行すること
- 各Issueの開発がfeatureブランチで完了していること
- CommandMateサーバーが稼働していること
- 各Issueのworktreeが `commandmatedev ls` で表示されること

## 実行内容

あなたはリリースマネージャーとして、複数IssueのPR作成からマージまでを統括します。

### パラメータ
- **issue_numbers**: 対象のIssue番号（スペース区切り）
- **--merge-order**: マージ順序をカンマ区切りで指定（省略時は自動決定）
- **--skip-pr**: 既存PRがある場合、PR作成をスキップ

---

## Step 1: 事前チェック

### 1-1. ブランチ確認

```bash
current_branch=$(git branch --show-current)
if [ "$current_branch" != "develop" ]; then
  echo "ERROR: developブランチで実行してください（現在: $current_branch）"
  exit 1
fi
```

### 1-2. ワーカー存在確認

各Issueに対応するworktreeが存在し、利用可能か確認：

```bash
commandmatedev ls --json
```

各worktreeについて:
- **存在しない**: エラー報告して中断
- **running（処理中）**: `commandmatedev wait` で完了を待つ
- **ready / idle**: 続行可能

### 1-3. 既存PR確認

```bash
for issue_num in {issue_numbers}; do
  gh pr list --repo Kewton/MyCodeBranchDesk --head "feature/${issue_num}-worktree" --json number,title,state
done
```

- open なPRが既にある → PR作成をスキップ
- closed / なし → Step 2 でPR作成

---

## Step 2: PR作成（並列）

`--skip-pr` 指定時はこのステップをスキップ。

### 2-1. 各ワーカーにPR作成を送信

```bash
for each worktree:
  commandmatedev send <worktree-id> "/create-pr" --auto-yes --duration 1h
```

### 2-2. 完了待機

```bash
for each worktree:
  commandmatedev wait <worktree-id> --timeout 600
```

### 2-3. PR番号の取得・記録

```bash
for issue_num in {issue_numbers}; do
  PR_NUM=$(gh pr list --repo Kewton/MyCodeBranchDesk --head "feature/${issue_num}-worktree" --json number -q '.[0].number')
  echo "Issue #${issue_num} → PR #${PR_NUM}"
done
```

PR番号を記録し、以降のステップで使用する。

---

## Step 3: CI通過待ち（並列）

### 3-1. 各PRのCIステータスを確認

```bash
for each PR:
  gh pr checks <PR_NUM> --repo Kewton/MyCodeBranchDesk
```

### 3-2. CI完了待ち

CIが実行中の場合は完了を待つ。定期的にステータスを確認する：

```bash
for each PR:
  gh pr checks <PR_NUM> --repo Kewton/MyCodeBranchDesk --watch
```

### 3-3. CI失敗時のリカバリ

CI失敗を検出した場合:

1. 失敗内容を取得：
   ```bash
   gh pr checks <PR_NUM> --repo Kewton/MyCodeBranchDesk
   ```

2. ワーカーに修正を指示：
   ```bash
   commandmatedev send <worktree-id> \
     "CIが失敗しました。以下のエラーを修正してpushしてください:
     {CI失敗の詳細}" \
     --auto-yes --duration 1h
   ```

3. 修正後、再度CI待ち。**最大3回**まで自動リトライ。3回失敗でユーザーに報告して中断。

---

## Step 4: マージ順序の決定

### 4-1. --merge-order 指定あり

指定された順序をそのまま使用。

### 4-2. --merge-order 未指定（自動決定）

以下の基準で決定：

1. **各PRの変更規模を取得**:
   ```bash
   for each PR:
     gh pr diff <PR_NUM> --repo Kewton/MyCodeBranchDesk --stat
   ```

2. **共通変更ファイルの特定**:
   複数PRが同じファイルを変更している場合、コンフリクト候補として記録。

3. **スコアリング**:
   ```
   score(issue) = 変更ファイル数 × 2 + 共通ファイル変更行数
   ```
   スコアが高い（変更が大きい）Issueを先にマージ。
   → 後続Issueは少ない変更で rebase しやすくなる。

4. **依存関係による上書き**:
   Issue間に依存がある場合、依存元を先にマージ。

5. マージ順序をユーザーに報告し確認を取る：
   ```
   マージ順序: #24 → #25
   理由: #24 の変更規模が大きく、共通ファイルの変更が多いため先にマージ
   この順序で進めてよろしいですか？
   ```

---

## Step 5: 順次マージ（直列）

**重要**: 1つずつマージし、都度ビルド検証する。

### マージ対象ごとに以下を実行：

#### 5-1. マージ可能性の確認

```bash
gh pr view <PR_NUM> --repo Kewton/MyCodeBranchDesk --json mergeable,mergeStateStatus
```

- **mergeable**: マージ可能 → 5-3 へ
- **CONFLICTING**: コンフリクトあり → 5-2 へ
- **UNKNOWN**: 再取得（GitHub側の計算待ち）

#### 5-2. コンフリクト自動解消（必要時のみ）

```bash
commandmatedev send <worktree-id> \
  "developブランチの最新を取り込み、コンフリクトを解消してください:
  git fetch origin develop && git rebase origin/develop
  解消後:
  1. npm run lint && npx tsc --noEmit && npm run test:unit で確認
  2. git push --force-with-lease" \
  --auto-yes --duration 1h

commandmatedev wait <worktree-id> --timeout 3600
```

解消失敗（ワーカーがエラー報告）の場合、ユーザーに報告して中断。

#### 5-3. マージ実行

```bash
gh pr merge <PR_NUM> --merge --repo Kewton/MyCodeBranchDesk
```

#### 5-4. develop更新・ビルド検証

```bash
git pull origin develop
npm run lint && npx tsc --noEmit && npm run test:unit && npm run build
```

#### 5-5. ビルド検証失敗時のリカバリ

マージ後にビルド/テストが失敗した場合:

1. **直前のマージが単独で原因の場合**:
   - 該当ワーカーに修正を指示
   - 修正後に再push → 追加PRでマージ

2. **前のマージとの相互作用が原因の場合**:
   - 後のIssueのワーカーに修正指示
   - `"developの最新でビルドが失敗しています。以下のエラーを修正してください: {エラー内容}"`

3. **判断が難しい場合**:
   - ユーザーに状況を報告して判断を仰ぐ

---

## Step 6: 最終統合検証

全PRマージ完了後、最終確認：

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

全パスであることを確認。

---

## Step 7: 結果レポート

以下のサマリーをユーザーに報告：

```markdown
## PR Merge Pipeline 結果

### 実行サマリー

| # | Issue | PR | CI | マージ | ビルド検証 |
|---|-------|----|----|--------|----------|
| 1 | #{N} | #XX | Pass | 完了 | Pass |
| 2 | #{M} | #YY | Pass | 完了 | Pass |

### 統合検証

| チェック | 結果 |
|---------|------|
| npm run lint | Pass |
| npx tsc --noEmit | Pass |
| npm run test:unit | Pass |
| npm run build | Pass |

### develop ブランチ状態

- コミット: {hash}
- マージ済みPR: #XX, #YY
- 次のアクション: /uat {issue_numbers}（受入テスト）
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| worktreeが存在しない | エラー報告、`/worktree-setup` を案内 |
| CI 3回連続失敗 | ユーザーに報告して中断 |
| コンフリクト解消失敗 | ユーザーに報告して中断 |
| マージ後ビルド失敗 | リカバリ試行、失敗時はユーザーに報告 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |

---

## 完了条件

- [ ] 全IssueのPRが作成されている
- [ ] 全PRのCIが通過している
- [ ] 全PRがdevelopにマージ済み
- [ ] マージ後のビルド・テストが全パス
- [ ] 最終統合検証（lint, tsc, test, build）が全パス
- [ ] 結果レポートが出力されている

## 関連コマンド

- `/create-pr`: 単一ワーカーでのPR作成（このコマンドが内部で各ワーカーに送信）
- `/orchestrate`: 上位のオーケストレーションコマンド（開発〜UAT全体を統括）
- `/uat`: マージ完了後の受入テスト
- `/uat-fix-loop`: UAT不合格時の修正ループ
