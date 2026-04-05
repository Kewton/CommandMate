# Issue #627 仮説検証レポート

## 対象Issue
feat: レポート生成時に全リポジトリの当日コミットログをプロンプトに含める

## 検証結果サマリー

| # | 仮説/前提条件 | 判定 | 備考 |
|---|--------------|------|------|
| 1 | 現在のレポート生成は `chat_messages` テーブルのみをデータソースとしている | Confirmed | `daily-summary-generator.ts` の `getMessagesByDateRange` 参照 |
| 2 | `git-utils.ts` に `getCommitsByDateRange` 関数が未実装 | Confirmed | 現在は `getGitLog`, `getGitShow`, `getGitDiff` 等のみ存在 |
| 3 | `summary-prompt-builder.ts` が存在し、コミットログセクション追加対象 | Confirmed | `buildSummaryPrompt` 関数が存在、引数拡張が必要 |
| 4 | `daily-summary-generator.ts` にリポジトリ一覧取得を追加する必要がある | Confirmed | 現在は `getWorktrees` でworktree一覧のみ取得 |
| 5 | プロンプト長制限が `10000` 文字 | Confirmed | `claude-executor.ts` の `MAX_MESSAGE_LENGTH = 10000` |
| 6 | `worktree-db.ts` からリポジトリパスが取得可能 | Confirmed | `getRepositories(db)` 関数が存在しリポジトリパス・名前を返す |
| 7 | `db-repository.ts` からリポジトリ情報が取得可能 | Confirmed | `getAllRepositories(db)` 関数が存在 |

## 詳細検証

### 仮説1: chat_messagesテーブルのみをデータソースとしている

**コード証拠** (`src/lib/daily-summary-generator.ts:144`):
```typescript
const messages = getMessagesByDateRange(db, { after: dayStart, before: dayEnd });
```
コミットログの取得は一切行われていない。→ **Confirmed**

### 仮説2: git-utils.ts に日付範囲コミット取得関数が未実装

**確認結果**: `src/lib/git/git-utils.ts` には以下の関数が存在するが、日付範囲指定の全ブランチコミット取得は未実装:
- `getGitStatus`
- `getGitLog` (特定commitのログ取得)
- `getGitShow`
- `getGitDiff`

→ **Confirmed** (新規追加が必要)

### 仮説3: summary-prompt-builder.ts がコミットログセクション追加対象

**確認結果**: `buildSummaryPrompt(messages, worktrees, userInstruction?)` 関数が存在し、現在は `chat_messages` のみをプロンプトに含める。コミットログ用の引数・セクション構築が未実装。→ **Confirmed**

### 仮説4: daily-summary-generator.ts にリポジトリ一覧取得を追加

**確認結果**: 現在の実装（line 151）では `getWorktrees(db)` でworktreeマップのみ構築しているが、コミットログ収集のためのリポジトリパス取得は未実装。

なお、`worktree-db.ts` の `getRepositories(db)` 関数（line 167）はリポジトリパスを一意に返す関数として既存。これを活用可能。→ **Confirmed**

### 仮説5: 10000文字制限

**コード証拠** (`src/lib/session/claude-executor.ts:36`):
```typescript
export const MAX_MESSAGE_LENGTH = 10000;
```
`summary-prompt-builder.ts` では `MAX_TOTAL_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH` として使用。コミットログ追加でこの制限に到達しやすくなる可能性がある。→ **Confirmed**

### 仮説6: worktree-db.ts にリポジトリパス取得関数が存在

**コード証拠** (`src/lib/db/worktree-db.ts:167`):
```typescript
export function getRepositories(db: Database.Database): Array<{
  path: string;
  name: string;
  worktreeCount: number;
}>
```
SQLでは `GROUP BY repository_path, repository_name` を使って重複を排除。→ **Confirmed**

### 仮説7: db-repository.ts にリポジトリ情報取得関数が存在

**コード証拠** (`src/lib/db/db-repository.ts:281`):
```typescript
export function getAllRepositories(db: Database.Database): Repository[]
```
→ **Confirmed**

## 注意事項（Stage 1への申し送り）

1. **リポジトリパス取得の選択**: Issue では「worktreeテーブルから取得」と記載されているが、`worktree-db.ts` の `getRepositories()` 関数が既存で最適。`db-repository.ts` の `getAllRepositories()` も利用可能だが、worktreeテーブルの方がCommandMateが管理するリポジトリに限定できる。

2. **プロンプト長制限の実際**: 現在 `MAX_TOTAL_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH = 10000` 文字。コミットログが追加されると合計文字数が増えるため、コミットログ専用の文字数上限を設けるか、既存制限との調整が必要。

3. **`getRepositories` vs `getAllRepositories`**: Issue に記載の `db-repository.ts` の利用について検討が必要。worktreeテーブルからのリポジトリパス取得の方が既存コードで直接利用可能。
