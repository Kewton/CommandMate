# 作業計画書

## Issue: perf: DBインデックス追加とスケジュールマネージャのクエリ効率化
**Issue番号**: #409
**サイズ**: M
**優先度**: Medium
**依存Issue**: #407（stopAllSchedules()のグローバル操作修正）、#406（cmate-parser.ts非同期化）

---

## 詳細タスク分解

### Phase 1: DB/マイグレーション層の変更

- [ ] **Task 1.1**: `db-migrations.ts` にマイグレーション version 21 追加
  - 成果物: `src/lib/db-migrations.ts`
  - 変更内容:
    - `CURRENT_SCHEMA_VERSION` を `20` → `21` に更新
    - version 21 migration オブジェクト追加:
      ```typescript
      {
        version: 21,
        name: 'add-scheduled-executions-worktree-enabled-index',
        up: (db) => {
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_scheduled_executions_worktree_enabled
              ON scheduled_executions(worktree_id, enabled);
          `);
        },
        down: (db) => {
          db.exec('DROP INDEX IF EXISTS idx_scheduled_executions_worktree_enabled');
        }
      }
      ```
  - 依存: なし
  - 注意: 実装着手前に他ブランチのversion 21使用を確認すること

### Phase 2: schedule-manager.ts の変更

- [ ] **Task 2.1**: `ManagerState` インターフェース拡張
  - 成果物: `src/lib/schedule-manager.ts`
  - 変更内容:
    - `cmateFileCache: Map<string, number>` フィールド追加（mtimeMs保持）
    - JSDocコメントでサイズ上限の根拠を明記（SEC4-001）
    - `getManagerState()` の初期化ブロックに `cmateFileCache: new Map()` 追加
  - 依存: なし

- [ ] **Task 2.2**: `getCmateMtime()` ヘルパー関数実装
  - 成果物: `src/lib/schedule-manager.ts`
  - 変更内容:
    - 新規関数 `getCmateMtime(worktreePath: string): number | null` 追加
    - `CMATE_FILENAME` は `@/config/cmate-constants` から直接importすること（CR2-001: 循環依存防止）
    - `fs.statSync()` の ENOENT エラーを try-catch で処理（null返却）
    - その他エラーは `console.warn` ログ出力 + null返却
    - worktreePath はDB由来で登録時に `validateWorktreePath()` 検証済み。関数内再検証不要（SEC4-003: トラスト境界コメントを追加）
    ```typescript
    // import を追加: import { CMATE_FILENAME } from '@/config/cmate-constants'
    // import を追加: import { statSync } from 'fs'

    function getCmateMtime(worktreePath: string): number | null {
      // worktreePath はDB由来で、worktree登録時に validateWorktreePath() で検証済み。
      // ここでの再検証は不要（SEC4-003 トラスト境界）
      const filePath = path.join(worktreePath, CMATE_FILENAME);  // DRY: cmate-constants から import (CR2-001)
      try {
        return statSync(filePath).mtimeMs;
      } catch (error) {
        if (error instanceof Error && 'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null;  // ファイルなし
        }
        console.warn(`[schedule-manager] Failed to stat ${filePath}:`, error);
        return null;
      }
    }
    ```
  - 依存: Task 2.1

- [ ] **Task 2.3**: `batchUpsertSchedules()` 関数実装
  - 成果物: `src/lib/schedule-manager.ts`
  - 変更内容:
    - 新規関数 `batchUpsertSchedules(worktreeId: string, entries: ScheduleEntry[]): string[]` 追加
    - `upsertSchedule()` を削除（DR1-002: batchUpsertSchedules() に完全置換）
    - entries が空の場合は空配列を返すアーリーリターン
    - `getLazyDbInstance()` でDB取得
    - `SELECT id, name FROM scheduled_executions WHERE worktree_id = ?` で既存スケジュールをバルク取得して `Map<name, id>` 構築
    - `db.transaction()` 内でentriesをループし、UPDATE/INSERT を実行
    - `next_execute_at` カラムは既存の `upsertSchedule()` と同様に設定しない（CR2-002: 設計上意図的）
    - `randomUUID()` は `crypto.randomUUID()` を使用（CSPRNG、暗号学的に安全）
    - `db.prepare()` は better-sqlite3 ではDBインスタンスレベルでキャッシュされる（DR1-007コメント追記）
    - disableStaleSchedules() の動的IN句はプレースホルダーのみ生成（値の文字列結合なし）でSQLインジェクション安全（SEC4-002）
    ```typescript
    function batchUpsertSchedules(worktreeId: string, entries: ScheduleEntry[]): string[] {
      if (entries.length === 0) return [];
      const db = getLazyDbInstance();
      const now = Date.now();
      // better-sqlite3のprepare()はDBインスタンスレベルでキャッシュ (DR1-007)
      const existingRows = db.prepare(
        'SELECT id, name FROM scheduled_executions WHERE worktree_id = ?'
      ).all(worktreeId) as Array<{ id: string; name: string }>;
      const existingMap = new Map(existingRows.map(r => [r.name, r.id]));

      const scheduleIds: string[] = [];
      const updateStmt = db.prepare(`
        UPDATE scheduled_executions
        SET cron_expression = ?, message = ?, cli_tool_id = ?, enabled = 1, updated_at = ?
        WHERE id = ?
      `);
      const insertStmt = db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, cron_expression, message, cli_tool_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);

      db.transaction(() => {
        for (const entry of entries) {
          const existingId = existingMap.get(entry.name);
          if (existingId) {
            updateStmt.run(entry.cronExpression, entry.message, entry.cliToolId ?? null, now, existingId);
            scheduleIds.push(existingId);
          } else {
            const newId = randomUUID();
            insertStmt.run(newId, worktreeId, entry.name, entry.cronExpression, entry.message, entry.cliToolId ?? null, now, now);
            scheduleIds.push(newId);
          }
        }
      })();

      return scheduleIds;
    }
    ```
  - 依存: Task 2.1

- [ ] **Task 2.4**: `syncSchedules()` にmtimeキャッシュと差分検出ロジック追加
  - 成果物: `src/lib/schedule-manager.ts`
  - 変更内容:
    - `syncSchedules()` 内の処理フロー変更:
      1. `getAllWorktrees()` で全worktree取得
      2. 各worktreeについて:
         - a. `getCmateMtime(worktree.path)` でmtime取得
         - b-1. mtime が null かつキャッシュにエントリがある → CMATE.md削除と判断 → `manager.cmateFileCache.delete(worktree.path)` → continue（activeScheduleIdsに追加しない）
         - b-2. mtime が null かつキャッシュにエントリがない → スキップ（CMATE.md が最初から存在しない）
         - c. mtime が変更なし → `manager.cmateFileCache.get()` を取得して既存scheduleIdをactiveScheduleIdsに追加 → continue
         - d. mtime が変更あり（または初回） → `readCmateFile()` + `parseSchedulesSection()` で解析 → `batchUpsertSchedules()` でDBへ反映 → `manager.cmateFileCache.set(worktree.path, mtime)` → scheduleIdをactiveScheduleIdsに追加
      3. `disableStaleSchedules(activeScheduleIds)`
      4. Clean Up: stale cron jobs
    - **CMATE.md削除時の重要な動作（DR1-009）**: activeScheduleIdsにそのworktreeのscheduleIdを追加しないことで、Step 4のClean Upフェーズで当該worktreeのcronJobが停止・削除される
    - `upsertSchedule()` ループを `batchUpsertSchedules()` 1回の呼び出しに置換
  - 依存: Task 2.1, Task 2.2, Task 2.3

- [ ] **Task 2.5**: `stopAllSchedules()` に `cmateFileCache.clear()` 追加
  - 成果物: `src/lib/schedule-manager.ts`
  - 変更内容:
    - `stopAllSchedules()` 内で `manager.schedules.clear()` の後に `manager.cmateFileCache.clear()` を追加（DR1-008: ライフサイクル管理）
  - 依存: Task 2.1

### Phase 3: テストの変更・追加

- [ ] **Task 3.1**: `db-migrations.test.ts` の更新
  - 成果物: `tests/unit/lib/db-migrations.test.ts`
  - 変更内容:
    - `CURRENT_SCHEMA_VERSION` のアサーション値を `20` → `21` に更新（CR2-005, IR3-001）
    - 対象箇所: L37, L430, L443 の3箇所を確認・更新（漏れなし）
  - 依存: Task 1.1

- [ ] **Task 3.2**: `schedule-manager.test.ts` にmtimeキャッシュテスト追加
  - 成果物: `tests/unit/lib/schedule-manager.test.ts`
  - 追加テストケース:
    1. **キャッシュヒット時のスキップ確認**: mtime未変更のworktreeに対して `batchUpsertSchedules()` が呼ばれないこと（`getLazyDbInstance()` への呼び出し数で検証）
    2. **キャッシュミス時の正常動作確認**: 初回またはmtime変更時にCMATE.md解析+DB upsertが実行されること
    3. **CMATE.md削除時のキャッシュエントリ除去確認**: キャッシュにエントリがある状態でmtimeがnullになった場合に、キャッシュが削除されactiveScheduleIdsに追加されないこと
    4. **stopAllSchedules()のcmateFileCache.clear()確認**: stopAllSchedules()後にcmateFileCacheが空になること
    5. **batchUpsertSchedules()の既存scheduleId更新確認**: 既存scheduleが存在する場合にUPDATEが実行されIDが再利用されること
    6. **batchUpsertSchedules()の新規scheduleInsert確認**: 新規scheduleが存在しない場合にINSERTが実行されること
  - 注意: テスト内のモックDBスキーマへのインデックス追加は不要（機能テストレベルではインデックスの有無は影響しない、IR3-004）
  - 依存: Task 2.1〜2.5

---

## タスク依存関係

```mermaid
graph TD
    T11[Task 1.1<br/>db-migrations.ts<br/>version 21追加] --> T31[Task 3.1<br/>db-migrations.test.ts<br/>アサーション更新]
    T21[Task 2.1<br/>ManagerState拡張] --> T22[Task 2.2<br/>getCmateMtime()実装]
    T21 --> T23[Task 2.3<br/>batchUpsertSchedules()実装]
    T21 --> T25[Task 2.5<br/>stopAllSchedules()更新]
    T22 --> T24[Task 2.4<br/>syncSchedules()差分化]
    T23 --> T24
    T24 --> T32[Task 3.2<br/>schedule-manager.test.ts<br/>テスト追加]
    T25 --> T32
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |

---

## 成果物チェックリスト

### コード
- [ ] `src/lib/db-migrations.ts` - version 21追加、CURRENT_SCHEMA_VERSION=21
- [ ] `src/lib/schedule-manager.ts` - ManagerState拡張、getCmateMtime()、batchUpsertSchedules()、syncSchedules()差分化、stopAllSchedules()更新

### テスト
- [ ] `tests/unit/lib/schedule-manager.test.ts` - mtimeキャッシュ関連6テスト追加
- [ ] `tests/unit/lib/db-migrations.test.ts` - L37/L430/L443 toBe(21)更新

---

## Definition of Done

- [ ] すべてのタスクが完了
- [ ] `npm run lint` エラー0件
- [ ] `npx tsc --noEmit` 型エラー0件
- [ ] `npm run test:unit` 全テストパス
- [ ] CMATE.md未変更時に `batchUpsertSchedules()` が呼ばれないことをテストで確認
- [ ] `scheduled_executions(worktree_id, enabled)` インデックスが正しく作成されること

---

## 実装順序の推奨

1. Task 1.1 → Task 3.1（マイグレーション追加＋テスト更新）
2. Task 2.1 → Task 2.2 → Task 2.3 → Task 2.5（schedule-manager.tsの基盤部分）
3. Task 2.4（syncSchedules()統合）
4. Task 3.2（テスト追加）

---

## 次のアクション

作業計画承認後：
1. ブランチ: `feature/409-worktree`（現在のブランチ）
2. TDD実装: `/pm-auto-dev 409`
3. PR作成: `/create-pr`
