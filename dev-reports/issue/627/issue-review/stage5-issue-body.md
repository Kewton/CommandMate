> **Note**: このIssueは 2026-04-05 にStage 5通常レビュー結果を反映して更新されました。
> Stage 1レビュー反映: S1-001〜S1-010
> Stage 3レビュー反映: S3-001〜S3-008
> Stage 5レビュー反映: S5-001〜S5-003
> 詳細: dev-reports/issue/627/issue-review/

## 概要

レポート生成時に、CommandMateが管理する全リポジトリから当日の全コミットメッセージを取得し、プロンプトの追加セクションとしてAIに渡す。これによりAIがIssue消化数・作業内容・コミット数を正確に把握しやすくする。

## 背景・課題

現在のレポート生成は `chat_messages` テーブルのメッセージ内容のみをデータソースとしており、Issue消化数やコミット数のような構造化情報を含まない。そのためAIがメッセージ内容から推測するしかなく、日次レポートの精度に限界がある。

## 提案する解決策

### データ取得

プロンプト構築時に、DBに登録された全リポジトリに対して `git log` を実行し、当日のコミットメッセージを取得する。

```bash
git log --all --since="2026-04-04T00:00:00+09:00" --until="2026-04-05T00:00:00+09:00" --format="%h %s (%an)" --
```

- `--all`: 全ブランチのコミットを対象（git logはデフォルトで同一コミットの重複を排除する）
- `--since` / `--until`: 当日の日付範囲をISO 8601形式で渡す
- 各リポジトリの実行対象は `worktree-db.ts` の `getRepositories(db)` を使用して取得する
- `db-repository.ts` の `getAllRepositories()` は本機能では使用しない

#### タイムゾーン処理方針（S1-001, S5-001）

本Issueでは、日次集計の基準タイムゾーンは**既存の daily summary と同じく CommandMate 実行環境のローカルTZ**とする。`ReportDatePicker` が送る `YYYY-MM-DD` も同じ前提で扱う。`toISOString()` は `git log` に渡すためのシリアライズ手段であり、タイムゾーン基準そのものを変更するものではない。

したがって、`dayStart` / `dayEnd` は実行環境ローカルTZの一日境界として生成し、その後 ISO 8601 文字列へ変換して `--since` / `--until` に渡す。

```typescript
const dayStart = new Date(date + 'T00:00:00');
const dayEnd = new Date(date + 'T23:59:59.999');

const since = dayStart.toISOString();
const until = dayEnd.toISOString();
const commits = await getCommitsByDateRange(repoPath, since, until);
```

この前提に合わせ、受入条件ではフロントエンドの `YYYY-MM-DD` とAPI側の日付解釈が同じタイムゾーン前提で動作することを確認対象に含める。

#### リポジトリパスの存在確認とエラーハンドリング（S1-006, S3-004）

`getRepositories()` が返す `repository_path` は、アーカイブ済み/削除済みworktree由来で存在しない場合がある。`getCommitsByDateRange()` 内でパス存在確認を行い、存在しない場合はスキップする。git log 実行時のエラーも空配列扱いで継続する。

#### git log タイムアウト設定（S1-004, S3-003）

- 個別リポジトリの git log 実行には `GIT_COMMIT_LOG_TIMEOUT_MS = 5000` を使う
- 全リポジトリの取得は `Promise.allSettled()` で並列実行する
- 並列取得全体にも `GIT_LOG_TOTAL_TIMEOUT_MS = 15000` の上限を設け、取得済み分のみで続行できるようにする

### getCommitsByDateRange の戻り値型（S1-007, S5-003）

プロンプト埋め込み用には既存の `CommitInfo` ではなく簡略型を用いる。

```typescript
interface CommitLogEntry {
  shortHash: string;
  message: string;
  author: string;
}
```

ただし、`summary-prompt-builder.ts` 側で `## Repository: {name}` の見出しを生成するため、`buildSummaryPrompt` に渡す第4引数は**表示名を含む構造**にする。

```typescript
type RepositoryCommitLogs = Map<string, {
  name: string;
  commits: CommitLogEntry[];
}>;
```

### プロンプトへの埋め込み

取得したコミットログを `<commit_log>` セクションとしてプロンプトに追加する。コミットがないリポジトリは含めない。

```text
<commit_log>
## Repository: MyCodeBranchDesk (3 commits)
- abc1234 feat(618): add report template system with CRUD API (author)
- def5678 fix(619): detect Codex /model selection list (author)

## Repository: Anvil (2 commits)
- jkl3456 fix(259): file edit disk sync issue (author)
</commit_log>
```

### buildSummaryPrompt の引数拡張方針（S3-001, S5-003）

コミットログは `buildSummaryPrompt` の第4引数としてオプショナル追加する。既存呼び出しとの後方互換を維持する。

```typescript
function buildSummaryPrompt(
  messages: ChatMessage[],
  worktrees: Map<string, string>,
  userInstruction?: string,
  commitLogs?: RepositoryCommitLogs
): string
```

### コミットログのサニタイズ（S1-003, S3-005）

- `sanitizeMessage()` を拡張し、既存の `<user_data>` に加えて `<commit_log>` タグもエスケープ対象に含める
- コミットメッセージ内の制御文字を除去する
- テストにも `<commit_log>` タグエスケープのケースを追加する

### プロンプト長制限の調整方針（S1-002, S5-002）

`MAX_COMMIT_LOG_LENGTH = 3000` は**コミットログ単体の上限**として導入するが、最終的なプロンプト全体は `executeClaudeCommand` の `MAX_MESSAGE_LENGTH = 10000` を超えてはならない。したがって、メッセージとコミットログを完全に独立した固定枠として扱うのではなく、**総プロンプト上限の中で優先度付きに配分する**。

方針:

1. system prompt、`<user_instruction>`、ラッパータグ等の固定オーバーヘッドを先に見積もる
2. 残り予算の中でメッセージセクションを優先し、コミットログはその次に割り当てる
3. コミットログ自体は `MAX_COMMIT_LOG_LENGTH` を超えない
4. `executeClaudeCommand` 側の暗黙の末尾切り詰めに依存しない

### 主要な変更点

- `git-utils.ts` に `getCommitsByDateRange()` を追加
- `summary-prompt-builder.ts` に `<commit_log>` セクション構築とサニタイズ拡張を追加
- `buildSummaryPrompt` に第4引数 `commitLogs?` をオプショナル追加
- `commitLogs` は `Map<repositoryPath, { name, commits }>` として保持する
- `daily-summary-generator.ts` で `getRepositories(db)` を使ってコミットログを収集する
- プロンプト長は `MAX_MESSAGE_LENGTH` を総上限として管理し、その内側でコミットログ上限を適用する

## 実装タスク

- [ ] `src/lib/git/git-utils.ts` に `getCommitsByDateRange(repoPath, since, until): Promise<CommitLogEntry[]>` を追加
  - ISO 8601形式の日時文字列を `--since` / `--until` に渡す
  - タイムアウトは `GIT_COMMIT_LOG_TIMEOUT_MS = 5000`
  - リポジトリパスの存在確認を行い、存在しない場合は空配列を返す
  - git log 実行エラーはログ出力の上で空配列を返す
- [ ] `src/lib/summary-prompt-builder.ts` にコミットログセクション構築を追加
  - 第4引数 `commitLogs?: Map<string, { name: string; commits: CommitLogEntry[] }>` をオプショナル追加
  - `<commit_log>` タグのエスケープを `sanitizeMessage()` に追加
  - 制御文字除去を適用する
  - `MAX_COMMIT_LOG_LENGTH` を守りつつ、最終プロンプト全体が `MAX_MESSAGE_LENGTH` を超えないよう総量制御を実装する
- [ ] `src/lib/daily-summary-generator.ts` で全リポジトリのコミットログを収集
  - `getRepositories(db)` を使用し、リポジトリ名とパスの両方を保持する
  - `dayStart` / `dayEnd` は既存 daily summary と同じ実行環境ローカルTZ前提で生成し、`toISOString()` して渡す
  - `Promise.allSettled()` による並列実行と `GIT_LOG_TOTAL_TIMEOUT_MS = 15000` を適用する
- [ ] `src/config/review-config.ts` に `MAX_COMMIT_LOG_LENGTH = 3000`、`GIT_LOG_TOTAL_TIMEOUT_MS = 15000` を追加
- [ ] ユニットテスト追加
  - `tests/unit/lib/summary-prompt-builder.test.ts`
  - `tests/unit/lib/git/git-utils.test.ts`
  - `tests/unit/lib/daily-summary-generator.test.ts`
  - 既存 `daily-summary-generator` テストのモックに `getRepositories` / `getCommitsByDateRange` を追加する

## 受入条件

- [ ] 全リポジトリ（DB登録済みかつパス存在）の当日コミットが取得できる
- [ ] 全ブランチのコミットが対象になる（`--all`）
- [ ] コミットがないリポジトリはスキップされる
- [ ] パスが存在しないリポジトリはエラーにならずスキップされる
- [ ] git log の個別タイムアウトが `GIT_COMMIT_LOG_TIMEOUT_MS` で制御される
- [ ] git log 並列実行の全体タイムアウトが `GIT_LOG_TOTAL_TIMEOUT_MS` で制御される
- [ ] フロントエンドが送る `YYYY-MM-DD` とAPI側の日付解釈が同じタイムゾーン前提で動作する
- [ ] プロンプトに `<commit_log>` セクションが含まれる
- [ ] リポジトリごとのセクションヘッダーに表示名とコミット数が含まれる
- [ ] コミットログ内の `<commit_log>` / `<user_data>` タグがエスケープされる
- [ ] コミットログが `MAX_COMMIT_LOG_LENGTH` を超える場合にトランケーションされる
- [ ] 最終プロンプト全体が `MAX_MESSAGE_LENGTH` 以内であり、`executeClaudeCommand` の暗黙トランケーションに依存しない
- [ ] 既存のレポート生成機能に回帰がない
- [ ] `buildSummaryPrompt` の既存呼び出しが修正なしで動作する
- [ ] 既存テストが新モック追加後もパスする

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/git/git-utils.ts` | `getCommitsByDateRange()` と `CommitLogEntry` 追加 |
| `src/lib/summary-prompt-builder.ts` | `buildSummaryPrompt` 第4引数追加、`<commit_log>` セクション追加、サニタイズ拡張 |
| `src/lib/daily-summary-generator.ts` | リポジトリ一覧取得、コミットログ収集、総量制御付きプロンプト構築 |
| `src/lib/db/worktree-db.ts` | 既存 `getRepositories(db)` を利用 |
| `src/config/review-config.ts` | `MAX_COMMIT_LOG_LENGTH`、`GIT_LOG_TOTAL_TIMEOUT_MS` 追加 |
| `tests/unit/lib/summary-prompt-builder.test.ts` | コミットログ構築・トランケーション・サニタイズのテスト追加 |
| `tests/unit/lib/git/git-utils.test.ts` | `getCommitsByDateRange` テスト追加 |
| `tests/unit/lib/daily-summary-generator.test.ts` | コミットログ収集のテストと既存モック更新 |

### 変更不要だが影響を受けるファイル

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/daily-summary/route.ts` | `generateDailySummary()` 内でgit log収集が追加されるためレスポンス時間は増加しうるが、関数シグネチャ変更は不要 |

### 関連コンポーネント

- `src/components/review/ReportDatePicker.tsx`
- `src/app/api/daily-summary/route.ts`
- `src/config/review-config.ts`
- `src/lib/db/worktree-db.ts`
