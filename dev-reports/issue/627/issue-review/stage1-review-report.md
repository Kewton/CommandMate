# Issue #627 Stage 1 Review Report (通常レビュー)

**Reviewer**: opus
**Date**: 2026-04-05
**Issue**: feat: レポート生成時に全リポジトリの当日コミットログをプロンプトに含める

---

## Summary

Issue #627 は全体として妥当な設計方針を持つが、実装に入る前に解決すべき重要な課題が2点ある。第一に、git log の --since/--until のタイムゾーン処理が未定義であり、サーバー環境によってコミットの漏れ・重複が発生するリスクがある。第二に、プロンプト長制限（10000文字）の調整方針が具体的に示されておらず、コミットログ追加によるメッセージセクション切り捨てリスクへの対処が不明確。

| Severity | Count |
|----------|-------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 3 |

---

## Must Fix

### S1-001: git log --since/--until のタイムゾーン未指定によるコミット漏れ・重複リスク

Issueの git log コマンド例では `--since="2026-04-04" --until="2026-04-05"` と日付のみを指定しているが、gitはローカルタイムゾーンで解釈する。`daily-summary-generator.ts` の dayStart/dayEnd は `new Date(date + 'T00:00:00')` でローカルTZ依存だが、サーバーのTZとユーザーの期待するTZが異なる場合（Docker環境、クラウドデプロイ等）にコミットの漏れや重複が発生する。Issueにはタイムゾーンに関する記述が一切ない。

**Suggestion**: `getCommitsByDateRange` 関数の引数でISO 8601形式（タイムゾーン付き）の日時文字列を受け取るか、明示的に `--date=local` を指定する設計を記載すべき。少なくとも既存の dayStart/dayEnd (Date型) をそのまま ISO文字列に変換して --since/--until に渡す方針を明記する。

### S1-002: プロンプト長制限の調整方法が未定義

Issueの実装タスクに「プロンプト長制限の調整（コミットログ分の余裕確保）」と記載されているが、具体的な方針が一切示されていない。現在 `MAX_TOTAL_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH = 10000` 文字で、messages + commit_log の合計がこの上限に収まる必要がある。コミットログが大量の場合（例: 100コミット以上のモノレポ）、メッセージセクションが完全に切り捨てられる可能性がある。

**Suggestion**: 以下のいずれかの方針を明記すべき:
- (A) MAX_TOTAL_MESSAGE_LENGTH を増加させる（例: 15000文字）
- (B) コミットログ専用の上限を設ける（例: MAX_COMMIT_LOG_LENGTH = 3000文字）としてメッセージとコミットログで独立したトランケーション
- (C) 割合ベース（メッセージ70%/コミットログ30%）

受入条件の「適切にトランケーション」も具体的な基準（どちらが優先されるか）を定義すべき。

---

## Should Fix

### S1-003: コミットログのサニタイズ（インジェクション対策）が未記載

コミットメッセージは外部入力であり、`<user_data>` タグや `<commit_log>` タグを含む悪意あるコミットメッセージが存在し得る。既存の `sanitizeMessage()` は `<user_data>` タグのみをエスケープしているが、新規追加する `<commit_log>` タグもエスケープ対象に含める必要がある。

**Suggestion**: `sanitizeMessage()` を拡張して `<commit_log>` タグもエスケープするか、コミットログ専用のサニタイズ関数を設計する旨を実装タスクに追加すべき。

### S1-004: git log のタイムアウト値が不十分な可能性

既存の `GIT_LOG_TIMEOUT_MS = 3000ms` は単一worktreeでのログ取得用。本Issueでは全リポジトリに対して `--all` で全ブランチのコミットを取得するため、大規模リポジトリでは3秒では不足する可能性がある。複数リポジトリを逐次実行する場合、合計タイムアウトが `SUMMARY_GENERATION_TIMEOUT_MS` (60秒) に食い込むリスクもある。

**Suggestion**: コミットログ取得専用のタイムアウト定数を設けるか、全リポジトリの合計タイムアウト上限を設定する方針を記載すべき。並列実行（`Promise.allSettled`）の検討も推奨。

### S1-005: getRepositories() vs getAllRepositories() の選択が曖昧

Issue本文では「worktreeテーブルから取得」と記載しているが、影響範囲テーブルに `db-repository.ts` も「関連コンポーネント」として挙げている。`worktree-db.ts` の `getRepositories()` はworktreesテーブルからGROUP BYで取得するためCommandMateが管理するリポジトリに限定される。`db-repository.ts` の `getAllRepositories()` はrepositoriesテーブルから取得する。両者の差異と採用方針がIssue上で明確でない。

**Suggestion**: `getRepositories(db)` (worktree-db.ts) を使う方針を明示的に記載すべき。理由: worktreeテーブルにはrepository_pathが直接格納されており、git logの実行パスとして直接利用可能。

### S1-006: git log 実行対象パスの存在確認が未記載

`getRepositories()` が返す `repository_path` は、worktreeが削除済みでもDB上に残っている可能性がある。存在しないパスに対して git log を実行するとエラーになるが、このエラーハンドリング方針がIssueに記載されていない。

**Suggestion**: `getCommitsByDateRange()` 内でパスの存在確認を行うか、git log実行時のエラーを握りつぶして次のリポジトリに進む方針を記載すべき。

### S1-007: getCommitsByDateRange の戻り値型が未定義

実装タスクに `getCommitsByDateRange(repoPath, since, until)` の追加が記載されているが、戻り値の型定義が示されていない。既存の `CommitInfo` 型を再利用するのか、簡略化した型にするのか不明。git log の --format も既存の `getGitLog` とは異なるフォーマット（`%h %s (%an)`）を使用する設計になっている。

**Suggestion**: 既存の `CommitInfo` 型との関係を明確にすべき。プロンプト用途なので簡略型か、既存 `CommitInfo` の再利用かを記載する。

---

## Nice to Have

### S1-008: 重複コミットの除外が未考慮

`git log --all` は全ブランチを対象とするが、デフォルトで同一コミットの重複を排除する。Issueにこの点の言及がないため、実装者が混乱する可能性がある。設計意図として明記しておくことを推奨。

### S1-009: テスト対象の網羅性

実装タスクのテスト追加対象が `summary-prompt-builder.test.ts` のみ。git-utils.ts の `getCommitsByDateRange` と `daily-summary-generator.ts` のコミットログ収集ロジックのテストも必要。

### S1-010: 受入条件「Issue消化数・コミット数が正確に反映されること」の検証方法が不明

AIの出力内容は非決定的であり、プロンプトにコミットログを含めたからといってAIが必ず正確な数値を出力する保証はない。「プロンプトにコミットログセクションが含まれ、コミット数がセクションヘッダーに記載されていること」のように検証可能な条件に修正することを推奨。

---

## Reviewed Files

| File | Purpose |
|------|---------|
| `src/lib/git/git-utils.ts` | 既存git関数の確認、タイムアウト定数・execFileAsync パターンの確認 |
| `src/lib/summary-prompt-builder.ts` | buildSummaryPrompt のシグネチャ・sanitizeMessage の対象タグ確認 |
| `src/lib/daily-summary-generator.ts` | generateDailySummary のデータフロー・getWorktrees 使用箇所確認 |
| `src/lib/db/worktree-db.ts` | getRepositories() の SQL・戻り値型確認 |
| `src/lib/db/db-repository.ts` | getAllRepositories() との差異確認 |
| `src/lib/session/claude-executor.ts` | MAX_MESSAGE_LENGTH 定数確認 |
| `src/config/review-config.ts` | SUMMARY_GENERATION_TIMEOUT_MS 確認 |
| `src/types/git.ts` | CommitInfo 型定義確認 |
| `tests/unit/lib/summary-prompt-builder.test.ts` | 既存テストパターン確認 |
