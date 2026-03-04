# Architecture Review: Issue #409 - Stage 3 影響分析レビュー

## Executive Summary

Issue #409 (DB index addition and schedule manager query optimization) の設計方針書に対する影響範囲分析を実施した。変更は `schedule-manager.ts` と `db-migrations.ts` の2ファイルに集中しており、export されるパブリック API のシグネチャ変更はない。テストファイル2件のアサーション値更新が必要。間接的な影響は `session-cleanup.ts` の既知の設計問題（Issue #407 で対応予定）のみであり、新規の影響範囲は発見されなかった。

- **Status**: Conditionally Approved
- **Score**: 4/5
- **Must Fix**: 1件 (テストのハードコード値更新漏れ)
- **Should Fix**: 3件
- **Consider**: 2件

---

## 1. 影響範囲の全体マップ

### 1.1 変更の波及構造

```
src/lib/db-migrations.ts (CURRENT_SCHEMA_VERSION 20->21, migration v21 追加)
  |
  +-- tests/unit/lib/db-migrations.test.ts (アサーション値更新: L37, L430, L443)
  |
src/lib/schedule-manager.ts (ManagerState拡張, syncSchedules改修, upsert関数入替)
  |
  +-- tests/unit/lib/schedule-manager.test.ts (新規テスト追加)
  |
  +-- server.ts (L259 initScheduleManager, L281 stopAllSchedules) [変更不要]
  |
  +-- src/lib/session-cleanup.ts (L111 stopAllSchedules) [変更不要, Issue #407依存]
  |     +-- src/app/api/repositories/route.ts (L92 cleanupMultipleWorktrees) [変更不要]
  |
  +-- src/app/api/worktrees/[id]/schedules/route.ts [変更不要, インデックス恩恵あり]
```

### 1.2 変更カテゴリ別ファイル一覧

| カテゴリ | ファイル | 変更内容 | リスク |
|---------|---------|---------|-------|
| 直接変更 | `src/lib/schedule-manager.ts` | ManagerState拡張、upsertSchedule()削除、batchUpsertSchedules()追加、getCmateMtime()追加、syncSchedules()改修、stopAllSchedules()にcmateFileCache.clear()追加 | Low |
| 直接変更 | `src/lib/db-migrations.ts` | CURRENT_SCHEMA_VERSION 20->21、migration v21追加 | Low |
| 直接変更 | `tests/unit/lib/schedule-manager.test.ts` | mtimeキャッシュ/バッチupsertテスト追加 | Low |
| 直接変更 | `tests/unit/lib/db-migrations.test.ts` | アサーション値 toBe(20) -> toBe(21) 更新 (3箇所) | Low |
| 間接影響 | `server.ts` | インターフェース変更なし | None |
| 間接影響 | `src/lib/session-cleanup.ts` | stopAllSchedules()でcmateFileCacheも消去 (Issue #407) | Low |
| 間接影響 | `src/app/api/repositories/route.ts` | cleanupMultipleWorktrees()経由の副作用 | Low |
| 間接影響 | `src/app/api/worktrees/[id]/schedules/route.ts` | 新規インデックスのパフォーマンス恩恵 | None |
| 間接影響 | `src/config/cmate-constants.ts` | CMATE_FILENAME の新規import元（変更なし） | None |
| 間接影響 | `src/lib/cmate-parser.ts` | readCmateFile()呼び出しパターン変更（関数自体は変更なし） | None |

---

## 2. 詳細影響分析

### 2.1 schedule-manager.ts の変更が他モジュールに与える影響

#### Export されるパブリック API

| 関数 | 変更 | 呼び出し元 | 影響 |
|------|------|-----------|------|
| `initScheduleManager()` | シグネチャ変更なし | `server.ts:259` | なし |
| `stopAllSchedules()` | シグネチャ変更なし。内部でcmateFileCache.clear()追加 | `server.ts:281`, `session-cleanup.ts:111` | 動作変更あり（キャッシュクリア追加）だが外部契約は変わらない |
| `getActiveScheduleCount()` | 変更なし | `schedule-manager.test.ts` | なし |
| `isScheduleManagerInitialized()` | 変更なし | `schedule-manager.test.ts` | なし |
| `POLL_INTERVAL_MS` | 変更なし | `schedule-manager.test.ts` | なし |
| `MAX_CONCURRENT_SCHEDULES` | 変更なし | `schedule-manager.test.ts` | なし |

**結論**: export されるパブリック API のシグネチャに変更はない。`server.ts` と `session-cleanup.ts` のコード変更は不要。

#### Import 関係の変更

```typescript
// 新規追加: schedule-manager.ts に以下の import が追加される
import { statSync } from 'fs';                        // getCmateMtime() 用
import { CMATE_FILENAME } from '@/config/cmate-constants';  // CR2-001: 直接import
```

`cmate-constants.ts` からの import は、`cmate-parser.ts` 経由の re-export を使用しない（循環依存防止: CR2-001）。`cmate-constants.ts` 自体はコード変更不要。

### 2.2 upsertSchedule() 削除のコードベース全体への影響

`upsertSchedule()` の使用箇所を網羅的に調査した結果:

| 種類 | ファイル | 行 | 詳細 |
|------|---------|-----|------|
| 定義 | `src/lib/schedule-manager.ts` | L143-170 | 関数定義（非export） |
| 呼び出し | `src/lib/schedule-manager.ts` | L386 | syncSchedules() 内の唯一の呼び出し |

- `upsertSchedule()` は **非 export の内部関数**である
- 呼び出し元は `syncSchedules()` L386 の **1箇所のみ**
- 外部モジュール（API routes, session-cleanup.ts 等）からの参照は **ゼロ**
- API routes (`src/app/api/worktrees/[id]/schedules/route.ts` POST) は独自の INSERT 文を使用しており、`upsertSchedule()` に依存していない

**結論**: `upsertSchedule()` の削除は `schedule-manager.ts` 内で完結し、外部への影響はない。

### 2.3 db-migrations.ts の version 21 追加が既存テストに与える影響

`db-migrations.test.ts` 内で `CURRENT_SCHEMA_VERSION` またはバージョン番号をハードコードしている箇所:

| 行 | 現在のコード | 必要な変更 | 設計書記載 |
|----|------------|-----------|-----------|
| L37 | `expect(CURRENT_SCHEMA_VERSION).toBe(20)` | `toBe(21)` | Section 9: 記載あり |
| L430 | `expect(getCurrentVersion(db)).toBe(20)` | `toBe(21)` | Section 9 CR2-005: 記載あり |
| L443 | `expect(getCurrentVersion(db)).toBe(20)` | `toBe(21)` | **記載なし** (IR3-001) |

**IR3-001の詳細**: L443 は rollbackMigrations テストの2つ目のテストケース内にあり、`runMigrations(db)` 実行後に `getCurrentVersion(db)` が 20 であることを検証している。version 21 追加に伴い 21 に更新が必要だが、設計方針書 Section 9 および CR2-005 チェックリストではこの箇所が漏れている。

```typescript
// db-migrations.test.ts L441-443
it('should rollback Migration #16 and remove issue_no column', () => {
  runMigrations(db);
  expect(getCurrentVersion(db)).toBe(20);  // <-- L443: 更新必要
```

### 2.4 ManagerState interface 変更の既存関数への影響

`ManagerState` interface に `cmateFileCache: Map<string, number>` フィールドが追加される。

| 関数 | ManagerState 参照箇所 | 影響 |
|------|---------------------|------|
| `getManagerState()` | L87-96: 初期化時に cmateFileCache: new Map() を追加 | 変更必要 |
| `syncSchedules()` | L364: manager.schedules のみ参照 | cmateFileCache の読み書きロジック追加が必要 |
| `stopAllSchedules()` | L486-517: manager.schedules.clear(), initialized=false | cmateFileCache.clear() 追加が必要 (DR1-008) |
| `initScheduleManager()` | L455-477: manager.initialized チェック | 変更不要（initialized=false 時に syncSchedules() が全 worktree を再処理） |
| `getActiveScheduleCount()` | L524: manager.schedules.size のみ | 変更不要 |
| `isScheduleManagerInitialized()` | L531: manager.initialized のみ | 変更不要 |
| `executeSchedule()` | L309-352: state パラメータのみ使用 | 変更不要 |
| `disableStaleSchedules()` | L263-297: DB 直接操作のみ | 変更不要 |

**globalThis 型宣言**: `declare global` 内の `var __scheduleManagerStates: ManagerState | undefined` は、`ManagerState` 型の変更に自動追従するため、明示的な変更は不要。

**テストへの影響**: `schedule-manager.test.ts` L77, L88 の `globalThis.__scheduleManagerStates = undefined` で cmateFileCache を含む全フィールドがリセットされるため、テスト分離は自動的に維持される。

### 2.5 新規 DB インデックスの INSERT/UPDATE 速度への影響

現在の `scheduled_executions` テーブルのインデックス構成:

| インデックス | カラム | 種類 |
|-------------|--------|------|
| UNIQUE制約 (暗黙) | `(worktree_id, name)` | 暗黙インデックス |
| `idx_scheduled_executions_worktree` | `(worktree_id)` | 明示インデックス |
| `idx_scheduled_executions_enabled` | `(enabled)` | 明示インデックス |
| **新規** `idx_scheduled_executions_worktree_enabled` | `(worktree_id, enabled)` | 明示インデックス |

**INSERT/UPDATE への影響**:
- SQLite のインデックス更新は B-tree 挿入操作であり、1インデックスあたり O(log N) のコスト
- N = 500 行 (100 worktree x 5 schedule) の場合、log2(500) = 約9回の比較
- 4つのインデックスで 4 x O(log 500) = 微小な追加コスト (microsecond 単位)
- better-sqlite3 の同期操作において、このオーバーヘッドは計測不能なレベル

**SELECT への恩恵**:
- `disableStaleSchedules()`: `WHERE worktree_id IN (...) AND enabled = 1` -- 複合インデックスでカバリングクエリが可能
- API GET `/schedules`: `WHERE worktree_id = ? AND enabled = 1` -- 同様にカバリングクエリが可能

**冗長性の考慮**:
- `idx_scheduled_executions_worktree` は新規複合インデックスのプレフィクスでカバーされる（冗長）
- `idx_scheduled_executions_enabled` は enabled の選択性が低い（大半が enabled=1）ため単独の効果は薄い（冗長の可能性）
- 設計方針書では「実装時判断」としている (CR2-007)

### 2.6 変更が必要なテストファイルの特定

| テストファイル | 変更種別 | 変更内容 |
|--------------|---------|---------|
| `tests/unit/lib/db-migrations.test.ts` | 値更新 | L37: toBe(20)->toBe(21), L430: toBe(20)->toBe(21), L443: toBe(20)->toBe(21) |
| `tests/unit/lib/schedule-manager.test.ts` | テスト追加 | mtime キャッシュヒット/ミス、CMATE.md 削除時、batchUpsert、初回実行テスト |

その他のテストファイルへの影響は確認されなかった:
- API route テスト（存在する場合）: DB 操作は直接 SQL であり、schedule-manager.ts の内部関数に依存しない
- session-cleanup.ts のテスト（存在する場合）: stopAllSchedules() のモックまたは import に影響なし

---

## 3. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | db-migrations.test.ts のハードコード値更新漏れ (L443) | Low | High | P1 |
| 技術的リスク | 新規インデックスによる INSERT/UPDATE オーバーヘッド | Low | Low | P3 |
| 運用リスク | session-cleanup.ts の stopAllSchedules() で cmateFileCache 全消去 | Medium | Medium | P3 (Issue #407 で解消) |
| セキュリティリスク | getCmateMtime() のパス構築はDB由来のworktreePathを使用 | Low | Low | P3 |

---

## 4. 改善勧告

### 4.1 必須改善項目 (Must Fix)

#### IR3-001: db-migrations.test.ts の toBe(20) 更新箇所の漏れ

設計方針書 Section 9 および CR2-005 チェックリストでは、`db-migrations.test.ts` 内のハードコード値更新として L37 と L430 の2箇所のみ記載されている。しかし L443 にも同様の `expect(getCurrentVersion(db)).toBe(20)` が存在し、version 21 追加に伴い更新が必要。

**影響**: テスト失敗（CI ブロック）

**対応**: 設計方針書 Section 9 の既存テスト影響に L443 を追記し、CR2-005 チェックリストにも反映する。実装時は `toBe(20)` を db-migrations.test.ts 内で全文検索して漏れなく更新すること。

### 4.2 推奨改善項目 (Should Fix)

#### IR3-002: API routes のインデックス恩恵を Section 14 に記載

Section 14 のファイル変更一覧に、コード変更不要だがインデックス追加によるパフォーマンス恩恵を受ける間接影響ファイルを注記する。

#### IR3-003: INSERT/UPDATE オーバーヘッドの判断根拠を Section 11 に明記

Section 11 のパフォーマンス設計に、インデックス追加による INSERT/UPDATE 側のオーバーヘッドが微小である根拠を記載する。

#### IR3-004: schedule-manager.test.ts のモック DB スキーマの認識

現時点では変更不要だが、パフォーマンステスト追加時にはモック DB にインデックス定義が存在しない点に注意が必要。

### 4.3 検討事項 (Consider)

#### IR3-005: session-cleanup.ts の cmateFileCache 全消去の副作用

Issue #407 の依存関係として既に設計書に文書化済み。追加の対応は不要。

#### IR3-006: CLAUDE.md の更新

実装完了後に schedule-manager.ts のモジュール説明を更新する。

---

## 5. 承認ステータス

| 項目 | 結果 |
|------|------|
| **ステータス** | Conditionally Approved |
| **スコア** | 4/5 |
| **条件** | IR3-001 (db-migrations.test.ts L443 の更新漏れ) を設計方針書に反映すること |
| **ブロッカー** | なし |

影響範囲は適切に限定されており、export API の変更がないため外部モジュールへの波及リスクは極めて低い。`upsertSchedule()` の削除も内部関数であり外部影響ゼロ。唯一の改善点は db-migrations.test.ts のハードコード値更新箇所の網羅性確保である。
