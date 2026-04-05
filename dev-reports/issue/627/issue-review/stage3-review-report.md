# Issue #627 Stage 3: 影響範囲レビュー報告書

## レビュー概要

| 項目 | 値 |
|------|-----|
| Issue | #627 feat: レポート生成時に全リポジトリの当日コミットログをプロンプトに含める |
| Stage | 3 (影響範囲レビュー 1回目) |
| Reviewer | opus |
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

## 検出事項一覧

### Must Fix (2件)

#### S3-001: buildSummaryPrompt の引数変更が既存テスト20件以上に影響する

**深刻度**: Must Fix

`buildSummaryPrompt` の現在のシグネチャは `(messages, worktrees, userInstruction?)` であり、コミットログ引数の追加方法（第4引数 or オブジェクト引数化）によって既存コードへの影響範囲が大きく変わる。

- **呼び出し箇所**: `daily-summary-generator.ts` (1箇所)
- **テスト呼び出し**: `summary-prompt-builder.test.ts` (15箇所)
- **テストモック**: `daily-summary-generator.test.ts` (1箇所)

第4引数としてオプショナルに追加すれば後方互換だが、オブジェクト引数に変更する場合は全箇所の修正が必要。この設計判断がIssueに記載されていない。

**推奨**: 第4引数 `commitLogs?: Map<string, CommitLogEntry[]>` としてオプショナル追加する方針を明記する。

#### S3-002: daily-summary-generator.ts の既存テスト11件にモック追加が必要

**深刻度**: Must Fix

`daily-summary-generator.test.ts` の既存モック構造:
- `worktree-db` -> `getWorktrees` のみモック
- `git-utils` -> モックなし

Issue実装後に追加が必要なモック:
- `worktree-db` -> `getRepositories` のモック追加
- `git/git-utils` -> `getCommitsByDateRange` のモック追加

既存テスト11件は新モックがデフォルトで空配列を返せば修正不要だが、その方針がIssueに未記載。

---

### Should Fix (4件)

#### S3-003: SUMMARY_GENERATION_TIMEOUT_MS (60秒) への git log 実行時間の影響

git log 並列実行は `executeClaudeCommand` の外側で行われるため、SUMMARY_GENERATION_TIMEOUT_MS (60秒) のタイムアウトには含まれない。しかし `isGenerating()` のフェイルセーフ（60秒+10秒マージン）の時間を圧迫する。全リポジトリの git log 取得に対する全体タイムアウト上限の設定が必要。

#### S3-004: getRepositories() がアーカイブ済みworktreeのリポジトリパスも返す

`getRepositories()` の SQL は `WHERE repository_path IS NOT NULL` のみでフィルタしており、archived worktreeを除外しない。アーカイブ済みworktreeのリポジトリが削除済みの場合、無駄な git log 実行が発生する（S1-006のパス存在確認でスキップはされる）。

#### S3-005: sanitizeMessage 既存テストに commit_log タグのテスト追加が必要

S1-003 の実装に伴い、既存の sanitizeMessage テスト（8件）に `<commit_log>` タグのエスケープテストを追加する必要がある。実装タスクに明記されていない。

#### S3-006: APIルート daily-summary/route.ts への間接的影響が未記載

`daily-summary/route.ts` の POST ハンドラは `generateDailySummary()` を呼び出す。関数シグネチャは変わらないため修正不要だが、以下の影響がある:
- レスポンス時間増加（git log 取得分）
- 新エラー型の伝播がないことの確認（generateDailySummary 内で握りつぶすため不要）

影響範囲テーブルに「変更不要だが影響を受けるファイル」として追記すべき。

---

### Nice to Have (2件)

#### S3-007: tests/unit/lib/git/ ディレクトリの新規作成が必要

現在 `tests/unit/lib/git/` ディレクトリは存在しない。`getCommitsByDateRange` のテストファイル作成時にディレクトリも新規作成する必要がある。

#### S3-008: summary-prompt-builder.ts -> review-config.ts の新規依存関係

`MAX_COMMIT_LOG_LENGTH` のインポートにより新しい依存関係が発生する。循環依存のリスクはない（review-config.ts は他モジュールをインポートしていない）。

---

## 影響範囲マップ

### 変更が必要なファイル（Issue記載済み）

| ファイル | 変更内容 | 既存テストへの影響 |
|---------|---------|-----------------|
| `src/lib/git/git-utils.ts` | `getCommitsByDateRange` 追加 | なし（新規関数） |
| `src/lib/summary-prompt-builder.ts` | 引数追加 + commit_log セクション | テスト15箇所に間接影響（後方互換なら修正不要） |
| `src/lib/daily-summary-generator.ts` | リポジトリ取得 + git log 収集 | テスト11件にモック追加必要 |
| `src/config/review-config.ts` | `MAX_COMMIT_LOG_LENGTH` 追加 | なし（純粋追加） |

### 変更不要だが影響を受けるファイル（Issue未記載）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/daily-summary/route.ts` | レスポンス時間増加 |
| `tests/unit/lib/summary-prompt-builder.test.ts` | sanitizeMessage の commit_log テスト追加 |
| `tests/unit/lib/daily-summary-generator.test.ts` | 既存モック構造の拡張 |

### 影響なしのファイル（確認済み）

| ファイル | 確認結果 |
|---------|---------|
| `src/lib/db/worktree-db.ts` | 既存 `getRepositories()` をそのまま利用、変更不要 |
| `src/lib/db/db-repository.ts` | 使用しない（Issue記載通り） |
| `src/lib/session/claude-executor.ts` | `MAX_MESSAGE_LENGTH` の値変更なし |
| `src/app/api/worktrees/*/git/*` | git-utils の新関数はAPI層から呼ばれない |

## サマリー

Issue #627 の影響範囲は概ねIssue記載の通りだが、以下の点が不足している:

1. **buildSummaryPrompt の引数拡張方針**（後方互換のオプショナル引数 vs 破壊的変更のオブジェクト引数）が未定義で、テスト修正範囲が大きく異なる
2. **既存テストへのモック追加**が必要であることが実装タスクに明記されていない
3. **APIルートへの間接的影響**（レスポンス時間増加）が影響範囲テーブルに含まれていない
4. **git log 全体タイムアウト**の設計がフェイルセーフタイマーとの関係で未整理
