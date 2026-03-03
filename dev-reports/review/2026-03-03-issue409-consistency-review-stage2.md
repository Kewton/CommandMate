# Architecture Review Report: Issue #409 - Stage 2 整合性レビュー

## Executive Summary

Issue #409（DBインデックス追加とスケジュールマネージャのクエリ効率化）の設計方針書と実際のコードベースの整合性を検証した。全体として設計方針書はコードベースの構造を正確に反映しており、提案される変更も既存パターンと整合している。1件のMust Fix（importパスの不明確さ）と4件のShould Fix（next_execute_atカラム未処理の注記不足等）が発見されたが、いずれも設計文書の補足レベルであり、実装そのものに根本的な問題はない。

**判定: Conditionally Approved（条件付き承認）**
**スコア: 4/5**

---

## 1. 整合性マトリクス

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| ManagerState拡張 | Section 5: cmateFileCache: Map<string, number>追加 | `schedule-manager.ts` L52-59: 3フィールドのみ | なし（これから実装） |
| マイグレーション version 21 | Section 3: 複合インデックス追加 | `db-migrations.ts` L14: CURRENT_SCHEMA_VERSION=20, 最終migration=version 20 | **なし（21は空き番号、競合なし）** |
| CMATE_FILENAME定数 | Section 6: cmate-constants.tsから使用 | `cmate-constants.ts` L14, `cmate-parser.ts` L26でre-export | **importパス不明確（CR2-001）** |
| batchUpsertSchedules() SQL | Section 7: 9カラムINSERT | `db-migrations.ts` L817-831: 11カラム（next_execute_at含む） | **next_execute_atカラム未処理（CR2-002）** |
| getCmateMtime()エラー処理 | Section 6,8: 全エラーでnull返却 | `cmate-parser.ts` L319-328: ENOENT以外はthrow | **意図的差異（CR2-004）** |
| disableStaleSchedules()クエリ | Section 4: WHERE worktree_id IN (...) AND enabled = 1 | `schedule-manager.ts` L276: 完全一致 | なし |
| upsertSchedule()廃止 | Section 7: batchUpsertSchedules()に置換 | `schedule-manager.ts` L143-170: 現在存在 | なし（廃止は今後） |
| stopAllSchedules()キャッシュクリア | Section 6: cmateFileCache.clear()追加 | `schedule-manager.ts` L485-517: 未実装 | なし（今後実装） |

---

## 2. 詳細分析

### 2.1 マイグレーションバージョン競合チェック

`/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/lib/db-migrations.ts` の確認結果:

- 現在の`CURRENT_SCHEMA_VERSION`: **20**（L14）
- 最終マイグレーション: **version 20** -- `add-vibe-local-context-window-column`（L949-965）
- マイグレーション配列は version 1 から 20 まで連番で定義されている

**結論**: version 21 は空き番号であり、競合は発生しない。設計方針書の提案どおり、version 21 として`idx_scheduled_executions_worktree_enabled`インデックスを追加するマイグレーションを安全に追加可能。

### 2.2 CMATE_FILENAME定数の定義場所とimportパス

CMATE_FILENAME定数は以下のパスに存在する:

1. **定義元**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/config/cmate-constants.ts` (L14)
   ```typescript
   export const CMATE_FILENAME = 'CMATE.md';
   ```

2. **re-export**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-409/src/lib/cmate-parser.ts` (L26, L35)
   ```typescript
   import { CMATE_FILENAME, ... } from '@/config/cmate-constants';
   export { CMATE_FILENAME, ... };
   ```

3. **現在のschedule-manager.tsのimport** (L19):
   ```typescript
   import { readCmateFile, parseSchedulesSection } from './cmate-parser';
   ```
   CMATE_FILENAMEは現在importされていない。

設計方針書では「cmate-constants.tsのCMATE_FILENAME定数を使用」と記載しているが、実装チェックリスト（DR1-001）では「`CMATE_FILENAME`定数を`cmate-constants.ts`からimportして使用」と指定している。getCmateMtime()の実装時には `import { CMATE_FILENAME } from '@/config/cmate-constants'` を追加することが推奨される。cmate-parser.ts経由でもimport可能だが、循環依存リスクを避けるため定義元からの直接importが安全。

### 2.3 batchUpsertSchedules()のSQL整合性

`scheduled_executions`テーブルの全カラム（`db-migrations.ts` L817-831）:

| カラム | 型 | 設計書INSERT | 設計書UPDATE | 既存upsertSchedule() |
|--------|-----|:---:|:---:|:---:|
| id | TEXT PK | o | - | o |
| worktree_id | TEXT NOT NULL | o | - | o |
| cli_tool_id | TEXT DEFAULT 'claude' | o | o | o |
| name | TEXT NOT NULL | o | - | o |
| message | TEXT NOT NULL | o | o | o |
| cron_expression | TEXT | o | o | o |
| enabled | INTEGER DEFAULT 1 | o | o | o |
| last_executed_at | INTEGER | - | - | - |
| next_execute_at | INTEGER | - | - | - |
| created_at | INTEGER NOT NULL | o | - | o |
| updated_at | INTEGER NOT NULL | o | o | o |

**結論**: 設計方針書のSQL文は既存upsertSchedule()と完全に同一のカラム操作を行う。`last_executed_at`と`next_execute_at`はどちらの関数でも未処理（`last_executed_at`は別関数`updateScheduleLastExecuted()`で更新される）。整合性は保たれている。

### 2.4 getCmateMtime()のエラーハンドリング整合性

設計方針書のgetCmateMtime()エラーハンドリング:
```typescript
try {
  return statSync(filePath).mtimeMs;
} catch (error) {
  if (error instanceof Error && 'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return null;
  }
  console.warn(`[schedule-manager] ...`, error);
  return null;
}
```

既存パターンとの比較:

| 関数 | ENOENT | 権限エラー等 | 使用箇所 |
|------|--------|-------------|---------|
| `getCmateMtime()`（設計） | null返却 | warn + null返却 | schedule-manager.ts |
| `readCmateFile()`（実装済） | null返却 | throw | cmate-parser.ts L319-328 |
| `parseSkillFile()`（実装済） | null返却（暗黙） | null返却 | slash-commands.ts L133-139 |

ENOENTの3段階チェックパターン（`instanceof Error`, `'code' in error`, cast）はreadCmateFile()と一致しており、コードベースのconventionに準拠している。権限エラー時のnull返却はreadCmateFile()とは異なるが、getCmateMtime()はstat操作のみで非致命的に扱う設計であり、意図的な差異である。

### 2.5 テストファイルの整合性

`/Users/maenokota/share/work/github_kewton/commandmate-issue-409/tests/unit/lib/db-migrations.test.ts` で更新が必要な箇所:

1. **L37**: `expect(CURRENT_SCHEMA_VERSION).toBe(20)` -- 設計書で言及済み（`toBe(21)`に更新）
2. **L430**: `expect(getCurrentVersion(db)).toBe(20)` -- 設計書で**未言及**。rollbackMigrations()テスト内でrunMigrations()後の期待値が20となっており、21に更新が必要。

`/Users/maenokota/share/work/github_kewton/commandmate-issue-409/tests/unit/lib/schedule-manager.test.ts` では、globalThis.__scheduleManagerStates = undefinedによるリセット（L77, L88）でcmateFileCacheも含めて自動リセットされるため、テストの分離は保たれる。

---

## 3. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | importパスの不明確さによる実装者の混乱 | Low | Medium | P2 |
| 技術的リスク | テストハードコード値の更新漏れ | Low | Medium | P2 |
| セキュリティ | なし（既存のセキュリティ機構に変更なし） | - | - | - |
| 運用リスク | マイグレーション version 21 競合（他ブランチとの同時開発） | Low | Low | P3 |

---

## 4. 改善提案

### 4.1 必須改善項目 (Must Fix)

**CR2-001: importパスの明確化**

設計方針書Section 6のgetCmateMtime()コード例およびSection 15の実装チェックリストDR1-001で、CMATE_FILENAMEのimportパスを明確に指定する必要がある。

現在の記載:
> getCmateMtime()でCMATE_FILENAME定数をcmate-constants.tsからimportして使用

推奨される修正:
```typescript
// schedule-manager.ts のimportセクションに追加
import { CMATE_FILENAME } from '@/config/cmate-constants';
```

理由: schedule-manager.tsはcmate-parser.tsから`readCmateFile`/`parseSchedulesSection`をimportしている。CMATE_FILENAMEもcmate-parser.ts経由で取得可能だが、定義元（`@/config/cmate-constants`）からの直接importが循環依存リスクを最小化し、依存関係を明確にする。

### 4.2 推奨改善項目 (Should Fix)

**CR2-002**: Section 7にnext_execute_atカラムが未使用である理由（updateScheduleLastExecuted()と同様に専用関数で更新される設計、または将来実装予定）を注記する。

**CR2-003**: 実装チェックリストに「ManagerState interfaceにcmateFileCache: Map<string, number>フィールドを追加する」を明示的に追加する。

**CR2-004**: Section 8のエラーハンドリング表に、getCmateMtime()がnull返却した場合はreadCmateFile()が呼ばれないため動作差異は実用上問題にならないことを注記する。

**CR2-005**: db-migrations.test.tsのrollbackMigrationsテスト内のハードコード値（L430: `expect(getCurrentVersion(db)).toBe(20)`）の更新も必要であることを設計方針書に追記する。

### 4.3 検討事項 (Consider)

**CR2-006**: session-cleanup.tsでの`stopAllSchedules()`呼び出しは個別worktreeクリーンアップ時に全スケジュールを停止する既知の設計問題。Issue #407で対応予定。

**CR2-007**: `idx_scheduled_executions_enabled`インデックスの冗長性判断を設計段階で確定させることで、実装時の判断負荷を軽減できる。

---

## 5. 承認状況

| 項目 | 状態 |
|------|------|
| 設計書 vs 実装の整合性 | CR2-001のimportパス明確化が必要 |
| マイグレーション競合 | 問題なし（version 21は空き番号） |
| SQLカラム整合性 | 整合性あり（既存パターンと一致） |
| エラーハンドリング整合性 | 意図的差異あり（設計書に注記推奨） |
| テスト影響範囲 | ハードコード値の更新箇所を設計書に追記推奨 |

**最終判定**: Conditionally Approved

CR2-001（importパス明確化）の対応後、実装を進めることが可能。Should Fix項目は実装と並行して設計書を更新することで対応可能。

---

## Review Metadata

- **Issue**: #409
- **Stage**: 2 (整合性レビュー)
- **Reviewer**: Architecture Review Agent
- **Date**: 2026-03-03
- **Reviewed Files**:
  - `dev-reports/design/issue-409-schedule-perf-design-policy.md`
  - `src/lib/schedule-manager.ts`
  - `src/lib/db-migrations.ts`
  - `src/lib/cmate-parser.ts`
  - `src/config/cmate-constants.ts`
  - `src/config/schedule-config.ts`
  - `src/types/cmate.ts`
  - `src/lib/session-cleanup.ts`
  - `tests/unit/lib/db-migrations.test.ts`
  - `tests/unit/lib/schedule-manager.test.ts`
