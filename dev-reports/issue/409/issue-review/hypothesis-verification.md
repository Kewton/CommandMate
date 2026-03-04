# Issue #409 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `scheduled_executions(worktree_id, name)` にインデックスがなく、スケジュール同期時にフルスキャンが発生 | Partially Confirmed | UNIQUE制約から暗黙的インデックスは存在するが、`disableStaleSchedules()`クエリは最適化されていない |
| 2 | `chat_messages(cli_tool_id)` の複合インデックスが不足（cli_tool_id単独フィルタリング） | Rejected | 実際にはcli_tool_id単独クエリは存在せず、`idx_messages_cli_tool(worktree_id, cli_tool_id, timestamp DESC)`が既存 |
| 3 | `syncSchedules()` で60秒ごとにLIMIT/フィルタなしの全件SELECT実行 | Confirmed | `SELECT id, path FROM worktrees`を全件取得（LIMIT・フィルタなし） |
| 4 | 各worktreeのCMATE.mdを毎回再パース | Confirmed | `readCmateFile(worktree.path)`と`parseSchedulesSection()`を毎回実行、キャッシュなし |
| 5 | 100 worktree × 5 schedule = 500クエリ/60秒 | Partially Confirmed | `upsertSchedule()`はSELECT+UPDATE/INSERTで2クエリ/エントリのため実際は1000クエリ/60秒（過小見積もり） |

## 詳細検証

### 仮説 1: `scheduled_executions(worktree_id, name)` にインデックスがなく、フルスキャンが発生

**Issue内の記述**: 「`scheduled_executions(worktree_id, name)` にインデックスがなく、スケジュール同期時にフルスキャンが発生」

**検証手順**:
1. `src/lib/db-migrations.ts` migration version 17 (`add-scheduled-executions-and-execution-logs`) を確認
2. テーブル定義とインデックス定義を照合

**判定**: Partially Confirmed

**根拠**:
- `UNIQUE(worktree_id, name)` 制約（db-migrations.ts:829）により SQLite が暗黙的な複合インデックスを自動生成する
  → `upsertSchedule()` の `WHERE worktree_id = ? AND name = ?` クエリ（schedule-manager.ts:151-153）はこの暗黙インデックスで効率的にルックアップ可能
- ただし `idx_scheduled_executions_worktree ON scheduled_executions(worktree_id)` のみが明示的に定義（db-migrations.ts:835-837）
- `disableStaleSchedules()` の `SELECT id FROM scheduled_executions WHERE worktree_id IN (...) AND enabled = 1` クエリ（schedule-manager.ts:275-277）では `enabled` 列との複合フィルタリングに既存インデックスが最適ではない可能性がある

**Issueへの影響**:
- UNIQUE制約インデックスの存在を明記すべき。`(worktree_id, name)` への明示インデックス追加提案は不要（暗黙的に存在）。ただし `(worktree_id, enabled)` の複合インデックスは有効性がある。

---

### 仮説 2: `chat_messages(cli_tool_id)` の複合インデックスが不足

**Issue内の記述**: 「`chat_messages(cli_tool_id)` の複合インデックスが不足（cli_tool_id単独でのフィルタリング時）」

**検証手順**:
1. `src/lib/db.ts` の全`chat_messages`クエリを確認
2. `cli_tool_id`を使用するクエリのWHERE句を照合

**判定**: Rejected

**根拠**:
- 既存インデックス `idx_messages_cli_tool ON chat_messages(worktree_id, cli_tool_id, timestamp DESC)` が db.ts:99-101 に存在
- `cli_tool_id` を使う全クエリは `worktree_id` も条件に含む:
  - `WHERE worktree_id = ? AND cli_tool_id = ?`（db.ts:706）
  - `WHERE worktree_id = ? ... AND cli_tool_id = ?`（db.ts:592）
  - `WHERE worktree_id = ? AND cli_tool_id = ? AND message_type = 'prompt'`（db.ts:913）
- `cli_tool_id` 単独フィルタリングのクエリは存在しない

**Issueへの影響**: `chat_messages(cli_tool_id)` のインデックス不足という記述は不正確。この箇所の修正が必要。

---

### 仮説 3: `syncSchedules()` で60秒ごとに LIMIT/フィルタなし全件SELECT実行

**Issue内の記述**: 「`schedule-manager.ts` (L363-442) で60秒ごとに`SELECT * FROM worktrees`を実行（LIMIT/フィルタなし）」

**検証手順**:
1. `src/lib/schedule-manager.ts` の `getAllWorktrees()` と `syncSchedules()` を確認

**判定**: Confirmed

**根拠**:
- `getAllWorktrees()`（schedule-manager.ts:124-132）:
  ```typescript
  return db.prepare('SELECT id, path FROM worktrees').all() as WorktreeRow[];
  ```
  - 全worktreeをLIMIT/フィルタなしで取得（`SELECT *`ではなく`SELECT id, path`だが全件取得は正確）
- `syncSchedules()`（schedule-manager.ts:363-442）はsetIntervalで60秒ごとに呼び出される（initScheduleManager L471）
- 行番号はほぼ正確（実際はL363-442）

---

### 仮説 4: 各worktreeのCMATE.mdを毎回再パース

**Issue内の記述**: 「各worktreeのCMATE.mdを毎回再パースし、各scheduleエントリに対して個別にDBクエリ」

**検証手順**:
1. `syncSchedules()`（schedule-manager.ts:363-442）のループ処理を確認

**判定**: Confirmed

**根拠**:
- `syncSchedules()` ループ内（schedule-manager.ts:370-427）:
  ```typescript
  const config = readCmateFile(worktree.path);  // 毎回ファイル読み取り
  const scheduleRows = config.get('Schedules');
  const entries = parseSchedulesSection(scheduleRows);  // 毎回パース
  ```
- mtimeキャッシュや変更検出のメカニズムは一切存在しない
- CMATE.mdの変更有無にかかわらず全worktreeを処理

---

### 仮説 5: 100 worktree × 5 schedule = 500クエリ/60秒

**Issue内の記述**: 「100 worktree × 5 schedule = 500クエリ/60秒」

**検証手順**:
1. `upsertSchedule()`（schedule-manager.ts:143-170）のDB操作を確認

**判定**: Partially Confirmed

**根拠**:
- `upsertSchedule()`は1エントリあたり最低2クエリ（SELECT + UPDATE/INSERT）
  - 既存の場合: `SELECT id` + `UPDATE`
  - 新規の場合: `SELECT id` + `INSERT`
- 実際: 100 worktree × 5 schedules × 2 queries = **1000クエリ/60秒**（Issue記載の500は過小見積もり）
- さらに `disableStaleSchedules()` の SELECT + 個別 UPDATE クエリも加算される

---

## Stage 1レビューへの申し送り事項

1. **Rejected（仮説2）**: `chat_messages(cli_tool_id)` のインデックス不足という記述は誤り。既に適切な複合インデックスが存在する。Issue記述の修正が必要。
2. **Partially Confirmed（仮説1）**: `scheduled_executions(worktree_id, name)` はUNIQUE制約による暗黙インデックスが存在するため「インデックスがない」という表現は不正確。ただし `(worktree_id, enabled)` の複合インデックスは有効かもしれない。
3. **Partially Confirmed（仮説5）**: クエリ数の見積もりが過小。実際は1エントリあたり2クエリ（SELECT+UPDATE/INSERT）のため500ではなく1000+クエリとなる。
4. **Confirmed（仮説3, 4）**: スケジュールマネージャの非効率ポーリングは正確に確認された。これが本Issueの主要な問題。
