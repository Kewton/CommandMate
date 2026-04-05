# Issue #627 設計方針書: レポート生成時に全リポジトリの当日コミットログをプロンプトに含める

## 1. アーキテクチャ設計

### システム構成図

```mermaid
graph TD
    UI[ReportTab.tsx] --> API[/api/daily-summary/route.ts]
    API --> GEN[daily-summary-generator.ts]
    GEN --> DB[(worktree-db.ts: getRepositories)]
    GEN --> GIT[git-utils.ts: getCommitsByDateRange]
    GIT --> FS[ファイルシステム: git log]
    GEN --> BUILDER[summary-prompt-builder.ts: buildSummaryPrompt]
    BUILDER --> CLAUDE[claude-executor.ts: executeClaudeCommand]
    CLAUDE --> AI[AI モデル]
```

### レイヤー構成

| レイヤー | ファイル | 役割 |
|---------|---------|------|
| プレゼンテーション | `src/components/review/ReportTab.tsx` | レポート生成UI（変更不要） |
| API | `src/app/api/daily-summary/route.ts` | リクエスト受付（変更不要） |
| ビジネスロジック | `src/lib/daily-summary-generator.ts` | コミットログ収集 + プロンプト構築 |
| プロンプト構築 | `src/lib/summary-prompt-builder.ts` | commit_logセクション追加 |
| インフラ | `src/lib/git/git-utils.ts` | git log実行 |
| データアクセス | `src/lib/db/worktree-db.ts` | リポジトリ一覧取得（既存関数活用） |
| 設定 | `src/config/review-config.ts` | 定数追加 |

---

## 2. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| git実行 | `execFile` (既存パターン) | コマンドインジェクション防止 |
| 並列実行 | `Promise.allSettled()` | 一部失敗しても継続可能 |
| 型定義 | `CommitLogEntry` = `Pick<CommitInfo, ...>` 型エイリアス | DRY原則準拠、既存 `CommitInfo` との整合性維持 (DR1-003) |
| リポジトリ取得 | `getRepositories(db)` (worktree-db.ts) | CommandMate管理のリポジトリに限定 |
| サニタイズ | 既存 `sanitizeMessage()` を拡張 | 一貫したセキュリティ処理 |

---

## 3. 型定義設計

```typescript
/** コミットログエントリ（プロンプト埋め込み用簡略型）(DR1-003) */
// CommitInfo からの Pick 型エイリアスとして定義し、DRY原則を維持する
// CommitInfo のフィールド名変更時に自動追従される
type CommitLogEntry = Pick<CommitInfo, 'shortHash' | 'message' | 'author'>;

/** リポジトリ別コミットログ（buildSummaryPromptに渡す） */
type RepositoryCommitLogs = Map<string, {
  name:    string;
  commits: CommitLogEntry[];
}>;
```

**設計判断 (DR1-003)**: `CommitLogEntry` は独立型ではなく `Pick<CommitInfo, 'shortHash' | 'message' | 'author'>` の型エイリアスとして定義する。これにより DRY 原則を維持し、`CommitInfo` のフィールド名変更時にコンパイルエラーで追従漏れを検知できる。git log の format が `CommitInfo` のパースロジックと異なるため、実行時の変換は別途必要。

---

## 4. API設計

### withTimeout ユーティリティ (DR1-002: Must Fix)

```typescript
/**
 * Promise にタイムアウトを設定するユーティリティ
 * 配置場所: src/lib/utils.ts
 *
 * @param promise - ラップ対象の Promise
 * @param timeoutMs - タイムアウト時間（ミリ秒）
 * @param fallback - タイムアウト時に返すフォールバック値（省略時は reject）
 * @returns Promise の結果、またはタイムアウト時にフォールバック値 / reject
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback?: T
): Promise<T>
```

**タイムアウト時の挙動**:
- `fallback` 引数が指定されている場合: タイムアウト時にフォールバック値を resolve する
- `fallback` 引数が省略された場合: `TimeoutError` で reject する
- **コミットログ収集での使用時**: `fallback` として空配列 `[]` を渡し、タイムアウト時は取得済み結果なしとして安全に続行する

**設計判断**: `Promise.allSettled` をラップする場合、タイムアウト発生時は全体を reject するのではなく、フォールバック値（空の PromiseSettledResult 配列）を返す。これにより、部分的にでも取得済みの結果を利用できないトレードオフはあるが、実装の簡潔さを優先する。将来的に「取得済み分のみ返す」パターンが必要になった場合は別途拡張する。

### git-utils.ts: getCommitsByDateRange

```typescript
/**
 * 指定リポジトリ・日付範囲のコミットログを取得
 * エラーハンドリング: 既存 execGitCommand パターン（null返却）を内部利用し、
 * null の場合に空配列を返す (DR1-006)
 *
 * @param repoPath - リポジトリパス（DBからの信頼済みパス）
 * @param since - ISO 8601形式の開始日時
 * @param until - ISO 8601形式の終了日時
 * @returns コミットエントリ配列（エラー・パス不存在時は空配列）
 */
export async function getCommitsByDateRange(
  repoPath: string,
  since: string,
  until: string
): Promise<CommitLogEntry[]>
```

**エラーハンドリング方針 (DR1-006, DR2-001)**: `getCommitsByDateRange` 内では `execGitCommand` を使用しない。`execGitCommand` はタイムアウト値をパラメータとして受け取らず、ハードコードされた `GIT_COMMAND_TIMEOUT_MS = 1000ms` を使用するため、`GIT_COMMIT_LOG_TIMEOUT_MS = 5000ms` を指定できない。代わりに `execFileAsync` を直接呼び出し、`timeout` オプションに `GIT_COMMIT_LOG_TIMEOUT_MS` を渡す。エラー発生時（タイムアウト含む）は try-catch で捕捉し、空配列 `[]` を返す。これにより null 返却パターンとの一貫性は失われるが、カスタムタイムアウトの実現を優先する。既存の `execGitCommand` / `execGitCommandTyped` は変更しない。

**git コマンド設計**:
```bash
git log --all --since="{since}" --until="{until}" --format="%h\x1f%s\x1f%an" --
```
- `\x1f` (Unit Separator) をフィールド区切りに使用（メッセージ内の空白を安全に扱う）
- `--all`: 全ブランチ対象（git log がデフォルトで重複排除）
- タイムアウト: `GIT_COMMIT_LOG_TIMEOUT_MS = 5000`（`git-utils.ts` のファイルスコープ定数、詳細はセクション6参照）

**パースロジック設計 (DR2-005)**: 既存の `parseGitLogOutput` は `%H%n%h%n%s%n%an%n%aI`（5フィールド、改行区切り）をパースする関数であり、本設計の3フィールド/Unit Separator 区切りフォーマットには再利用できない。`getCommitsByDateRange` 内にインラインのパースロジックを実装する（規模が小さいため独立関数化は不要）。

```typescript
// getCommitsByDateRange 内のパースロジック概要
function parseCommitLogLines(stdout: string): CommitLogEntry[] {
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')   // 空行スキップ
    .map(line => {
      const parts = line.split('\x1f');   // Unit Separator で分割
      if (parts.length !== 3) return null; // フィールド数不正はスキップ
      return {
        shortHash: parts[0],
        message: parts[1],
        author: parts[2],
      };
    })
    .filter((entry): entry is CommitLogEntry => entry !== null);
}
```

### git-utils.ts: collectRepositoryCommitLogs (DR1-008)

コミットログ収集ロジックを `daily-summary-generator.ts` から `git-utils.ts` の専用関数に切り出す。これにより SRP（単一責任原則）を遵守し、git 操作の責務を `git-utils.ts` に一元管理する。

```typescript
/**
 * 全リポジトリのコミットログを並列収集する
 * 配置場所: src/lib/git/git-utils.ts
 *
 * DB依存を避けるため、リポジトリ一覧は呼び出し元から渡す（依存逆転原則）
 *
 * @param repositories - リポジトリ情報配列（呼び出し元が getRepositories(db) で取得）
 * @param since - ISO 8601形式の開始日時
 * @param until - ISO 8601形式の終了日時
 * @returns RepositoryCommitLogs（空コミットのリポジトリはスキップ済み）
 */
export async function collectRepositoryCommitLogs(
  repositories: Array<{ path: string; name: string }>,  // (DR2-003) getRepositories() の返却値をそのまま渡せる（余剰プロパティ worktreeCount 等は無視される）
  since: string,
  until: string
): Promise<RepositoryCommitLogs>
```

**設計判断 (DR1-008)**: `git-utils.ts` が `db` モジュールに依存しないよう、リポジトリ一覧は引数として呼び出し元から渡す。`daily-summary-generator.ts` は `getRepositories(db)` で取得したリストを本関数に渡すだけとなり、オーケストレーションの責務に専念できる。

**引数型の注記 (DR2-003)**: `repositories` の型は `Array<{ path: string; name: string }>` だが、TypeScript の構造的部分型により `getRepositories(db)` の返却値（`worktreeCount` プロパティを含む）をそのまま渡すことができる。呼び出し元で `map` による絞り込みは不要。

### summary-prompt-builder.ts: buildSummaryPrompt 拡張

```typescript
// (DR1-001) 本 Issue では位置引数（第4引数追加）で実装する。
// KISS原則に基づき、本Issueのスコープを最小に保つ。
// オブジェクト引数パターンへのリファクタリングは別Issueで計画する。
export function buildSummaryPrompt(
  messages:       ChatMessage[],
  worktrees:      Map<string, string>,
  userInstruction?: string,
  commitLogs?:    RepositoryCommitLogs  // 第4引数：オプショナル追加
): string
```

**後方互換性**: 既存呼び出しは変更不要（省略時は現在と同じ動作）。

**引数設計方針 (DR1-001)**: 現在の `buildSummaryPrompt` は3引数であり、第4引数追加で4引数となる。`daily-summary-generator.ts` の `GenerateDailySummaryParams` のようなオブジェクト引数パターンが既にプロジェクトに存在するが、本 Issue では KISS 原則を優先し位置引数のまま進める。ただし、今後さらに引数が増える場合はオブジェクト引数パターンへのリファクタリングを別 Issue として計画すること。

**トランケーション責務 (DR1-009)**: `MAX_COMMIT_LOG_LENGTH` によるトランケーションは `buildSummaryPrompt` 内で実施する。`daily-summary-generator.ts` は生データを渡し、`buildSummaryPrompt` がプロンプト最適化（commit_log セクション構築 + トランケーション）の責務を持つ。

### daily-summary-generator.ts: コミットログ収集フロー

```typescript
// 1. リポジトリ一覧取得（getRepositories が getWorktrees より適切）
const repositories = getRepositories(db); // { path, name }[]

// 2. ISO 8601形式に変換（既存TZ前提を維持）
const since = dayStart.toISOString();
const until = dayEnd.toISOString();

// 3. コミットログ収集（git-utils.ts の専用関数に委譲）(DR1-008)
const commitLogs = await withTimeout(
  collectRepositoryCommitLogs(repositories, since, until),
  GIT_LOG_TOTAL_TIMEOUT_MS,
  new Map() as RepositoryCommitLogs  // タイムアウト時は空Map (DR1-002)
);
```

**設計判断 (DR1-008)**: `daily-summary-generator.ts` は並列収集ロジックを直接持たず、`collectRepositoryCommitLogs()` に委譲する。これにより `daily-summary-generator.ts` はオーケストレーション（リポジトリ取得 -> ログ収集 -> プロンプト構築 -> AI実行）に専念する。

---

## 5. セキュリティ設計

### 入力サニタイズ（コミットログ）(DR1-005)

**タグエスケープの拡張性設計 (DR1-005)**: エスケープ対象タグをハードコードせず、定数配列として管理する。新タグ追加時は配列への追加のみで済み、OCP (Open/Closed Principle) に準拠する。

```typescript
// summary-prompt-builder.ts に定数配列を定義（非 export のファイルスコープ定数）(DR2-006)
// 配置理由 (DR2-007): sanitizeMessage の内部実装に密結合のため summary-prompt-builder.ts に配置。
// MAX_COMMIT_LOG_LENGTH は複数モジュールから参照される可能性があるため review-config.ts に配置。
/** エスケープ対象XMLタグ一覧（新タグ追加時はここに追加するだけ） */
const ESCAPED_TAGS = ['user_data', 'commit_log'] as const;

// sanitizeMessage() をタグ配列ベースに変更
function sanitizeMessage(msg: string): string {
  let sanitized = msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // タグ配列をループ処理（OCP準拠: 新タグは ESCAPED_TAGS に追加するだけ）
  for (const tag of ESCAPED_TAGS) {
    sanitized = sanitized.replace(
      new RegExp(`<\\/?${tag}>`, 'gi'),
      (m) => m.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    );
  }
  return sanitized.slice(0, MAX_MESSAGE_LENGTH);
}
```

### パスインジェクション防止

- `getRepositories(db)` が返す `path` は `worktrees` テーブルの `repository_path` カラム（リポジトリのルートディレクトリパス）であり、個別の worktree パスではない (DR2-004)。リポジトリルートで `git log --all` を実行することで、全ブランチのコミットを正しく取得できる
- DB内の信頼済みパスであるため、ユーザー入力由来のパスインジェクションリスクはない
- `fs.existsSync()` で存在確認後に git 実行
- `execFile` (シェル非経由) を使用

### git log 引数インジェクション防止

- `since` / `until` は `Date.toISOString()` の出力のみ（英数字・記号のみ、制御文字なし）
- `execFile` の args 配列に個別要素として渡す

---

## 6. パフォーマンス設計

### プロンプト長制限

```
総上限: MAX_MESSAGE_LENGTH = 10000文字（executeClaudeCommand の末尾切り詰め前）

配分戦略:
1. system prompt + タグオーバーヘッド: 約800文字（固定）
2. コミットログ: MAX_COMMIT_LOG_LENGTH = 3000文字（独立トランケーション）
3. メッセージセクション: 残り約6200文字（既存ロジックで制御）
4. 最終プロンプト全体を MAX_MESSAGE_LENGTH 以内に収める
   → executeClaudeCommand の暗黙切り詰めに依存しない

※ コミットログ上限が先にトランケーションされ、
   メッセージセクションへの影響を最小化する
```

**トランケーション実装箇所 (DR1-009)**: `MAX_COMMIT_LOG_LENGTH` によるトランケーションは `buildSummaryPrompt` 内で実施する。`daily-summary-generator.ts` は生データ（`RepositoryCommitLogs`）をそのまま渡し、`buildSummaryPrompt` が commit_log セクション構築時にトランケーション処理を行う。これはプロンプト最適化がプロンプト構築関数の責務であるという設計判断に基づく。

### タイムアウト管理

| 定数 | 値 | 配置場所 | 用途 |
|------|-----|---------|------|
| `GIT_COMMIT_LOG_TIMEOUT_MS` | 5000ms | `src/lib/git/git-utils.ts` (ファイルスコープ定数) (DR1-007) | 個別リポジトリの git log タイムアウト |
| `GIT_LOG_TOTAL_TIMEOUT_MS` | 15000ms | `src/config/review-config.ts` | 全リポジトリ並列取得の総タイムアウト |
| `SUMMARY_GENERATION_TIMEOUT_MS` | 60000ms (既存) | `src/config/review-config.ts` | AI実行タイムアウト |

**GIT_COMMIT_LOG_TIMEOUT_MS の配置方針 (DR1-007: Must Fix)**:
- `git-utils.ts` のファイルスコープ定数として定義する（export しない）
- 既存の `GIT_COMMAND_TIMEOUT_MS = 1000` (基本gitコマンド用), `GIT_LOG_TIMEOUT_MS = 3000` (単一ブランチlog用) との関係を明確にするため、JSDoc コメントに以下を記載する:
  ```typescript
  /**
   * コミットログ取得用タイムアウト（--all オプション付きのため GIT_LOG_TIMEOUT_MS より大きい）
   * - GIT_COMMAND_TIMEOUT_MS (1000ms): 基本的なgitコマンド（status等）
   * - GIT_LOG_TIMEOUT_MS (3000ms): 単一ブランチのgit log
   * - GIT_COMMIT_LOG_TIMEOUT_MS (5000ms): 全ブランチ対象のgit log --all
   */
  const GIT_COMMIT_LOG_TIMEOUT_MS = 5000;
  ```

**設計判断**: `GIT_LOG_TOTAL_TIMEOUT_MS` は `SUMMARY_GENERATION_TIMEOUT_MS` の外側で実行されるが、Failsafe タイマー（70秒）との合計を考慮して 15秒以内に設定。

### 並列実行

- `Promise.allSettled()` で全リポジトリを並列実行
- 失敗したリポジトリはスキップ（非破壊）
- タイムアウト時は空Mapをフォールバックとして使用し、コミットログなしで続行 (DR2-002)

---

## 7. データモデル設計

既存テーブルの変更は不要。

### 利用するDB関数

```typescript
// worktree-db.ts（既存）
getRepositories(db: Database.Database): Array<{ path: string; name: string; worktreeCount: number }>
// → SQL: SELECT repository_path, repository_name, COUNT(*) FROM worktrees GROUP BY repository_path, repository_name
// (DR2-004) path は worktrees.repository_path カラムの値であり、リポジトリのルートディレクトリパス。
// 個別の worktree パス（worktrees.path カラム）とは異なる。
// git log --all はリポジトリルートで実行する必要がある（worktree パスでは .git がない可能性がある）。
```

### タイムゾーン処理

```
フロントエンド → YYYY-MM-DD 文字列 → API
API → new Date(date + 'T00:00:00') → ローカルTZ前提の Date
Date → .toISOString() → ISO 8601文字列
ISO 8601文字列 → git log --since/--until → コミット取得
```

**基準**: CommandMate 実行環境のローカルTZ（既存 daily summary と統一）

---

## 8. テスト設計

### テストファイル (DR1-010)

| ファイル | 変更種別 | 対象 | 主要テストケース |
|---------|---------|------|----------------|
| `tests/unit/git-utils.test.ts` | **追加** (既存ファイル) | `getCommitsByDateRange`, `collectRepositoryCommitLogs` | 通常取得・パス不存在スキップ・タイムアウト・空コミット・並列収集 |
| `tests/unit/lib/summary-prompt-builder.test.ts` | 追加 | `buildSummaryPrompt` 拡張 | commitLogs追加・トランケーション・タグエスケープ・後方互換 |
| `tests/unit/lib/utils.test.ts` | 追加 | `withTimeout` | 正常完了・fallback resolve・fallbackなし reject・既存 utility export 回帰なし確認 |

**注記 (DR1-010)**: `git-utils.test.ts` は `tests/unit/git-utils.test.ts` に既存のテストファイルがあるため、新規ファイル作成ではなくテストケースの追加として対応する。

### 既存テストの更新

| ファイル | 更新内容 |
|---------|---------|
| `tests/unit/lib/daily-summary-generator.test.ts` | `getRepositories` モック追加、`collectRepositoryCommitLogs` モック追加、`@/config/review-config` モックに `GIT_LOG_TOTAL_TIMEOUT_MS` 追加 |

### 互換性確認テスト

| ファイル | 確認内容 |
|---------|---------|
| `tests/integration/api-worktrees.test.ts` | `getRepositories()` の `/api/worktrees` への影響なし確認 |
| `tests/unit/components/review/ReportTab.test.tsx` | `/api/daily-summary` generate フロー互換性 |

**影響範囲の補足 (DR3-003)**: `collectRepositoryCommitLogs()` は `getRepositories()` の返却値を読み取るだけで、`worktree-db.ts` や `getRepositories()` の返却契約自体は変更しない。したがって `/api/worktrees` の実装変更は不要だが、`src/app/api/worktrees/route.ts` は `repositories` レスポンスの既存契約を利用しているため、互換性確認対象として扱う。

---

## 9. 設計上の決定事項とトレードオフ

| 決定事項 | 採用案 | 理由 | トレードオフ | レビュー対応 |
|---------|-------|------|------------|------------|
| リポジトリ取得方法 | `getRepositories(db)` (worktree-db) | CommandMate管理リポジトリに限定、pathが直接利用可能 | repositories テーブルと差異が生じる場合がある | - |
| buildSummaryPrompt 拡張方法 | 第4引数オプショナル追加（位置引数継続） | KISS原則優先、後方互換性維持 | 引数が増えて可読性が若干低下。将来的にはオブジェクト引数へ移行を別Issueで計画 | DR1-001 |
| withTimeout ユーティリティ | `src/lib/utils.ts` に新規定義、fallback引数付き | プロジェクト共通で再利用可能 | タイムアウト時に取得済み部分結果を返せない（全体フォールバック） | DR1-002 |
| CommitLogEntry 型 | `Pick<CommitInfo, ...>` 型エイリアス | DRY原則準拠、型安全 | CommitInfo への依存が発生 | DR1-003 |
| sanitizeMessage タグエスケープ | 定数配列 `ESCAPED_TAGS` ベースのループ処理 | OCP準拠、新タグ追加が容易 | 正規表現の動的生成コスト（微小） | DR1-005 |
| エラーハンドリング | `execFileAsync` 直接呼び出し + try-catch で空配列返却 | `execGitCommand` がカスタムタイムアウトを受け付けないため (DR2-001) | null返却パターンとの一貫性は失われるが、カスタムタイムアウト実現を優先 | DR1-006, DR2-001 |
| GIT_COMMIT_LOG_TIMEOUT_MS 配置 | `git-utils.ts` ファイルスコープ定数 | 既存タイムアウト定数と同一ファイルで管理 | 類似名の定数が3つ存在（JSDocで関係を明記） | DR1-007 |
| コミットログ収集責務 | `git-utils.ts` の `collectRepositoryCommitLogs` に切り出し | SRP準拠、テスト容易性向上 | リポジトリ一覧を引数で渡す必要あり（依存逆転） | DR1-008 |
| プロンプト長管理 | 総上限内での優先配分 | executeClaudeCommand の暗黙切り詰めに依存しない | 実装がやや複雑 | - |
| タイムゾーン基準 | 実行環境ローカルTZ（既存統一） | 既存 daily summary との一貫性 | Docker/クラウド環境でのズレリスク | - |
| git log 形式 | `%h\x1f%s\x1f%an` | フィールド安全分割 | 解析ロジックが必要 | - |
| 並列実行方式 | `Promise.allSettled()` | 部分失敗を許容 | エラーが無視されやすい（ログ必須）| - |
| タイムアウト時フォールバック | 空Mapで続行（部分結果なし） | withTimeout 設計のシンプルさ優先 (DR2-002) | タイムアウト時に取得済みリポジトリの結果を活用できない | DR2-002 |
| repository_path の意味 | リポジトリルートディレクトリパス | git log --all の正常動作に必要 | worktree パスとの混同リスク（設計書で明記して対策） | DR2-004 |
| git log パースロジック | getCommitsByDateRange 内のインライン実装 | 既存 parseGitLogOutput とはフォーマットが異なるため再利用不可 (DR2-005) | パースロジックの共有不可 | DR2-005 |

---

## 10. 変更ファイルサマリー

| ファイル | 変更種別 | 変更内容 | レビュー対応 |
|---------|---------|---------|------------|
| `src/lib/utils.ts` | 拡張 | 既存 utility モジュールに `withTimeout()` を追加（既存 export への破壊的変更なし） | DR1-002, DR3-002 |
| `src/lib/git/git-utils.ts` | 追加 | `CommitLogEntry` 型エイリアス (`Pick<CommitInfo, ...>`)、`getCommitsByDateRange()`（`execFileAsync` 直接呼び出し + インラインパースロジック）、`collectRepositoryCommitLogs()`、`GIT_COMMIT_LOG_TIMEOUT_MS` ファイルスコープ定数 | DR1-003, DR1-006, DR1-007, DR1-008, DR2-001, DR2-005 |
| `src/lib/summary-prompt-builder.ts` | 拡張 | `buildSummaryPrompt` 第4引数、`<commit_log>` セクション、`ESCAPED_TAGS` 定数配列、サニタイズ拡張（ループ処理化）、トランケーション処理 | DR1-001, DR1-005, DR1-009 |
| `src/lib/daily-summary-generator.ts` | 拡張 | `getRepositories` の import 追加 (DR2-008)、`getRepositories()` 呼び出し、`collectRepositoryCommitLogs()` 委譲、`withTimeout` 利用 | DR1-002, DR1-008, DR2-008 |
| `src/config/review-config.ts` | 追加 | `MAX_COMMIT_LOG_LENGTH`, `GIT_LOG_TOTAL_TIMEOUT_MS` | - |
| `tests/unit/git-utils.test.ts` | 追加 (既存ファイル) | `getCommitsByDateRange`, `collectRepositoryCommitLogs` テスト | DR1-010 |
| `tests/unit/lib/summary-prompt-builder.test.ts` | 追加 | コミットログ関連テスト | - |
| `tests/unit/lib/daily-summary-generator.test.ts` | 更新 | `getRepositories`, `collectRepositoryCommitLogs`, `GIT_LOG_TOTAL_TIMEOUT_MS` モック追加 | DR3-001 |
| `tests/unit/lib/utils.test.ts` | 更新 | `withTimeout` の挙動追加検証、既存 utility export の回帰確認 | DR3-002 |
| `src/app/api/worktrees/route.ts` | 影響確認 | `getRepositories()` の既存返却契約に依存するため、コード変更不要だが互換性確認対象 | DR3-003 |
| `tests/integration/api-worktrees.test.ts` | 確認 | `/api/worktrees` の `repositories` 契約に影響がないことを確認 | DR3-003 |
| `tests/unit/components/review/ReportTab.test.tsx` | 確認 | UI互換性確認 | - |

---

## 11. Stage 1 設計原則レビュー指摘事項サマリー

### 反映済み指摘一覧

| ID | 重要度 | タイトル | 対応方針 | 反映箇所 |
|----|--------|---------|---------|---------|
| DR1-001 | Should Fix | `buildSummaryPrompt` 引数増加による可読性低下 | 本Issueでは位置引数（第4引数）のまま進め、オブジェクト引数へのリファクタリングは別Issueで計画 | セクション4 API設計 |
| DR1-002 | **Must Fix** | `withTimeout` ユーティリティが未定義 | `src/lib/utils.ts` に新規定義。fallback引数付きでタイムアウト時の挙動を制御可能に | セクション4 API設計 |
| DR1-003 | Should Fix | `CommitLogEntry` と `CommitInfo` の型重複 | `Pick<CommitInfo, 'shortHash' \| 'message' \| 'author'>` 型エイリアスに変更 | セクション3 型定義設計 |
| DR1-005 | Should Fix | `sanitizeMessage` のタグエスケープがOCP違反 | `ESCAPED_TAGS` 定数配列によるループ処理に変更 | セクション5 セキュリティ設計 |
| DR1-006 | Nice to Have | エラーハンドリングパターン不一致 | `execFileAsync` 直接呼び出し + try-catch で空配列返却に変更（DR2-001 により `execGitCommand` パターンからの方針転換） | セクション4 API設計 |
| DR1-007 | **Must Fix** | `GIT_COMMIT_LOG_TIMEOUT_MS` の配置場所が不明確 | `git-utils.ts` のファイルスコープ定数として定義。JSDocで既存定数との関係を明記 | セクション6 パフォーマンス設計 |
| DR1-008 | Should Fix | コミットログ収集ロジックの責務集中 | `collectRepositoryCommitLogs()` として `git-utils.ts` に切り出し | セクション4 API設計 |
| DR1-009 | Should Fix | `MAX_COMMIT_LOG_LENGTH` のトランケーション実装箇所が未指定 | `buildSummaryPrompt` 内で実施する方針を明記 | セクション4, セクション6 |
| DR1-010 | Nice to Have | テストファイルの新規/既存の確認 | 既存 `tests/unit/git-utils.test.ts` へのテストケース追加に修正 | セクション8 テスト設計 |

### スキップした指摘

| ID | 重要度 | タイトル | スキップ理由 |
|----|--------|---------|------------|
| DR1-004 | Nice to Have | `RepositoryCommitLogs` の Map vs 配列 | 現設計の Map 構造で機能要件を満たしており、KISS 観点でも変更の必要性が低い。将来的な拡張時に再検討 |

---

## 12. Stage 2 整合性レビュー指摘事項サマリー

### 反映済み指摘一覧

| ID | 重要度 | タイトル | 対応方針 | 反映箇所 |
|----|--------|---------|---------|---------|
| DR2-001 | **Must Fix** | `execGitCommand` はカスタムタイムアウトを受け付けない | `execFileAsync` を直接呼び出し、`timeout` オプションに `GIT_COMMIT_LOG_TIMEOUT_MS` を渡す。try-catch で空配列返却。既存 `execGitCommand` / `execGitCommandTyped` は変更しない | セクション4 API設計、セクション9 決定事項 |
| DR2-002 | Should Fix | セクション6「取得済み分のみで続行」と withTimeout 設計の矛盾 | セクション6の記述を「空Mapをフォールバックとして使用し、コミットログなしで続行」に修正 | セクション6 パフォーマンス設計、セクション9 決定事項 |
| DR2-003 | Should Fix | `collectRepositoryCommitLogs` 引数型と `getRepositories` 返却型の不一致 | 設計方針書に「TypeScript の構造的部分型により `getRepositories()` の返却値をそのまま渡せる（余剰プロパティは無視される）」と注記 | セクション4 API設計 |
| DR2-004 | Should Fix | `repository_path` がリポジトリルートパスであることの明確化不足 | セクション5とセクション7で `repository_path` がリポジトリルートディレクトリパスであることを明記。worktree パスとの違いを説明 | セクション5 セキュリティ設計、セクション7 データモデル設計 |
| DR2-005 | Should Fix | 新 git log フォーマット用パースロジックの設計欠如 | `getCommitsByDateRange` 内のインラインパースロジック（Unit Separator 分割、空行スキップ、フィールド数検証）を設計方針書に追記 | セクション4 API設計 |
| DR2-006 | Nice to Have | `ESCAPED_TAGS` の export 方針未記載 | 非 export（ファイルスコープ定数）とし、`sanitizeMessage` のテストで間接的に検証する方針 | セクション5 セキュリティ設計（暗黙） |
| DR2-007 | Nice to Have | `MAX_COMMIT_LOG_LENGTH` と `ESCAPED_TAGS` の配置場所の一貫性 | `MAX_COMMIT_LOG_LENGTH` は複数モジュールから参照される可能性があるため `review-config.ts`、`ESCAPED_TAGS` は `sanitizeMessage` の内部実装に密結合のため `summary-prompt-builder.ts` に配置（配置判断理由を明記） | セクション5, セクション6 |
| DR2-008 | Nice to Have | `daily-summary-generator.ts` への `getRepositories` import 追加の明記 | セクション10の変更ファイルサマリーに `getRepositories の import 追加` を明記 | セクション10 変更ファイルサマリー |

### スキップした指摘

なし（全件反映済み）

---

## 13. 実装チェックリスト

Stage 1 および Stage 2 レビュー指摘事項を含む実装チェックリスト。

### Must Fix (実装必須)

- [ ] **DR1-002**: `src/lib/utils.ts` に `withTimeout<T>(promise, timeoutMs, fallback?)` を実装
- [ ] **DR1-002**: `daily-summary-generator.ts` で `withTimeout` を使用し、フォールバック値（空Map）を指定
- [ ] **DR1-007**: `git-utils.ts` に `GIT_COMMIT_LOG_TIMEOUT_MS = 5000` をファイルスコープ定数として定義
- [ ] **DR1-007**: JSDoc コメントで `GIT_COMMAND_TIMEOUT_MS`, `GIT_LOG_TIMEOUT_MS` との関係を記載
- [ ] **DR2-001**: `getCommitsByDateRange` 内で `execFileAsync` を直接呼び出し、`timeout` オプションに `GIT_COMMIT_LOG_TIMEOUT_MS` を渡す（`execGitCommand` は使用しない）
- [ ] **DR2-001**: エラー時（タイムアウト含む）は try-catch で捕捉し空配列 `[]` を返す

### Should Fix (実装推奨)

- [ ] **DR1-001**: `buildSummaryPrompt` は第4引数追加で実装（オブジェクト引数リファクタリングは別Issue化）
- [ ] **DR1-003**: `CommitLogEntry` を `Pick<CommitInfo, 'shortHash' | 'message' | 'author'>` 型エイリアスとして定義
- [ ] **DR1-005**: `ESCAPED_TAGS` 定数配列を定義し、`sanitizeMessage` をループ処理に変更
- [ ] **DR1-008**: `collectRepositoryCommitLogs()` を `git-utils.ts` に切り出し、リポジトリ一覧は引数で受け取る
- [ ] **DR1-009**: `MAX_COMMIT_LOG_LENGTH` トランケーションを `buildSummaryPrompt` 内に実装
- [ ] **DR2-005**: `getCommitsByDateRange` 内に Unit Separator (`\x1f`) 分割のパースロジックを実装（空行スキップ、フィールド数3の検証含む）
- [ ] **DR2-008**: `daily-summary-generator.ts` に `getRepositories` の import を追加

### Nice to Have

- [ ] **DR1-010**: テストは `tests/unit/git-utils.test.ts` (既存ファイル) にテストケースを追加
- [ ] **DR2-005**: パースロジックのテスト（不正フォーマット行のスキップ、空出力時の空配列返却）
- [ ] **DR2-006**: `ESCAPED_TAGS` は非 export（ファイルスコープ定数）、`sanitizeMessage` テストで間接検証

### 影響範囲レビュー追加項目 (Stage 3)

- [ ] **DR3-001**: `tests/unit/lib/daily-summary-generator.test.ts` は `getCommitsByDateRange` ではなく `collectRepositoryCommitLogs` をモックする
- [ ] **DR3-001**: `tests/unit/lib/daily-summary-generator.test.ts` の `@/config/review-config` モックに `GIT_LOG_TOTAL_TIMEOUT_MS` を追加する
- [ ] **DR3-002**: `tests/unit/lib/utils.test.ts` に `withTimeout` テストを追加し、既存 utility export の回帰がないことを確認する
- [ ] **DR3-003**: `src/app/api/worktrees/route.ts` はコード変更不要だが、`getRepositories()` 契約の互換性確認対象として扱う
- [ ] **DR3-003**: `tests/integration/api-worktrees.test.ts` で `repositories` フィールドの既存契約維持を確認する

---

## 14. Stage 3 影響範囲レビュー指摘事項サマリー

### 反映済み指摘一覧

| ID | 重要度 | タイトル | 対応方針 | 反映箇所 |
|----|--------|---------|---------|---------|
| DR3-001 | **Must Fix** | `daily-summary-generator.test.ts` のモック対象が設計と不整合 | `getCommitsByDateRange` モック追加という記述を `collectRepositoryCommitLogs` モック追加へ修正し、`GIT_LOG_TOTAL_TIMEOUT_MS` モック追加も明記 | セクション8 テスト設計、セクション10 変更ファイルサマリー、セクション13 実装チェックリスト |
| DR3-002 | Should Fix | `withTimeout` を既存 `utils.ts` に追加する影響範囲が過小評価されている | `src/lib/utils.ts` を「追加」ではなく「拡張」と明記し、`tests/unit/lib/utils.test.ts` を影響テストへ追加 | セクション8 テスト設計、セクション10 変更ファイルサマリー、セクション13 実装チェックリスト |
| DR3-003 | Should Fix | `collectRepositoryCommitLogs` と共有 `getRepositories()` の関係による `/api/worktrees` への影響確認が弱い | `/api/worktrees` はコード変更不要だが互換性確認対象であることを明記し、`tests/integration/api-worktrees.test.ts` で契約維持を確認する方針を追加 | セクション8 テスト設計、セクション10 変更ファイルサマリー、セクション13 実装チェックリスト |

### スキップした指摘

なし（全件反映済み）
