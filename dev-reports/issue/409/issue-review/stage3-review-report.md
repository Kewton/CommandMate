# Issue #409 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/4

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 6 |
| Nice to Have | 2 |
| **合計** | **10** |

---

## Must Fix（必須対応）

### R3-001: session-cleanup.ts の stopAllSchedules() が cmateFileCache を全消去する

**カテゴリ**: 影響範囲
**場所**: `src/lib/session-cleanup.ts` L109-117

**問題**:

`session-cleanup.ts` の `cleanupWorktreeSessions()` は **worktree 単位**のクリーンアップ関数だが、L111 で `stopAllSchedules()` を呼び出している。`stopAllSchedules()` は全 worktree の全スケジュールを停止するグローバル操作であり、以下の処理を実行する:

```typescript
// schedule-manager.ts L485-517
export function stopAllSchedules(): void {
  const manager = getManagerState();
  clearInterval(manager.timerId);    // ポーリングタイマー停止
  manager.timerId = null;
  manager.schedules.clear();          // 全スケジュール消去
  manager.initialized = false;        // 初期化フラグリセット
  // ...
}
```

Issue #409 で `ManagerState` に `cmateFileCache: Map<string, number>` を追加すると、`stopAllSchedules()` 実行時にこのキャッシュも消去される（`manager` オブジェクト自体は保持されるが、`initialized = false` になり次回 `initScheduleManager()` まで定期ポーリングが再開されない）。

つまり、1つの worktree を削除しただけで:
1. 他の全 worktree のスケジュールが停止
2. cmateFileCache が実質無効化
3. 定期ポーリング（setInterval）が停止

これは Issue #409 以前から存在するバグだが、mtime キャッシュ追加により影響が拡大する。

**証拠**:
- `session-cleanup.ts:111` - `stopAllSchedules()` はグローバル停止
- `schedule-manager.ts:485-517` - `stopAllSchedules()` は `timerId=null`, `schedules.clear()`, `initialized=false` を実行

**推奨対応**:

Issue #409 の scope 内で対処するか明示的に判断する:

1. **scope 外とする場合**: Issue #407（globalThis Map メモリリーク修正）で `session-cleanup.ts` の `stopAllSchedules()` 呼び出しを worktree 単位の停止関数に置換する予定であるため、Issue #409 では「Issue #407 の修正が前提」と依存関係を明記する。
2. **scope 内とする場合**: `stopScheduleForWorktree(worktreeId)` のような worktree 単位の停止関数を新設し、キャッシュのエントリ単位の除去を実装する。

---

### R3-002: マイグレーション version 21 の連番競合リスク

**カテゴリ**: 後方互換性
**場所**: `src/lib/db-migrations.ts` - version 21

**問題**:

現在 `CURRENT_SCHEMA_VERSION = 20`（`db-migrations.ts:14`）で、Issue #409 は version 21 を使用予定。open Issues を確認したところ、現時点で version 21 を使用する他の PR/Issue は確認されなかった。ただし Issue #407 も `schedule-manager.ts` に変更を加える予定であり、他の未確認 Issue が DB 変更を含む可能性は排除できない。

**推奨対応**:

- 実装着手前に他ブランチでマイグレーション version 21 が使用されていないことを再確認する
- `db-migrations.test.ts` L37 の `expect(CURRENT_SCHEMA_VERSION).toBe(20)` が CI でフェイルセーフとして機能する（競合時は即座に検出）
- 競合発生時はリベースでマイグレーション番号を繰り上げて対処可能

---

## Should Fix（推奨対応）

### R3-003: Issue #406 との syncSchedules() 変更競合

**カテゴリ**: 依存関係
**場所**: Issue #406（cmate-parser 非同期化）と Issue #409 の相互依存

**問題**:

Issue #406 は `cmate-parser.ts` の `realpathSync()` を非同期化し、`schedule-manager.ts` の `syncSchedules()` 内の `readCmateFile()` 呼び出しを `await` 対応に変更する提案。Issue #409 も `syncSchedules()` に mtime チェックを追加する。両方が同一関数を変更するため、マージ順序によってコンフリクトが発生する。

**推奨対応**:

推奨マージ順序: **Issue #409 を先行**。理由:
- mtime チェックは `fs.statSync()` で同期的に実行可能
- async 化は後から適用しやすい
- Issue #409 の実装タスクに Issue #406 との依存関係を明記

---

### R3-004: Issue #407 との ManagerState 変更競合

**カテゴリ**: 依存関係
**場所**: Issue #407（globalThis Map メモリリーク修正）と Issue #409

**問題**:

Issue #407 は `schedule-manager.ts` にエントリ削除用のエクスポート関数を追加する提案であり、`ManagerState` の構造変更を含む可能性がある。Issue #409 も `ManagerState` に `cmateFileCache` フィールドを追加する。

**推奨対応**:

Issue #409 は `cmateFileCache` 追加を自己完結的に実装し、Issue #407 が後からエントリ削除関数を追加する際にキャッシュの worktree 単位クリーンアップも含めるよう、Issue #407 側に注記を残す。

---

### R3-005: db-migrations.test.ts のアサーション値更新が影響範囲に未記載

**カテゴリ**: テスト影響
**場所**: `tests/unit/lib/db-migrations.test.ts` L36-37

**問題**:

`db-migrations.test.ts` で以下のアサーションが存在する:

```typescript
// L37
expect(CURRENT_SCHEMA_VERSION).toBe(20);
// L63
expect(history.length).toBe(CURRENT_SCHEMA_VERSION);
```

`CURRENT_SCHEMA_VERSION` を 21 に変更すると L37 がフェイルする。Issue の影響範囲テーブルには `tests/unit/lib/schedule-manager.test.ts` は記載されているが、`tests/unit/lib/db-migrations.test.ts` が記載されていない。

**推奨対応**:

影響範囲テーブルに追加:

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/lib/db-migrations.test.ts` | CURRENT_SCHEMA_VERSION のアサーション値を 20 -> 21 に更新、マイグレーション #21 のテスト追加 |

---

### R3-006: schedule-manager.test.ts のモックDBとテスト追加方針

**カテゴリ**: テスト影響
**場所**: `tests/unit/lib/schedule-manager.test.ts` L26-63

**問題**:

テストのモック DB スキーマには `scheduled_executions` テーブルが定義されているが、インデックスは定義されていない。Issue #409 のインデックス追加自体はテストの機能的動作に影響しないが、mtime キャッシュのテスト追加時に以下の確認が必要:

1. キャッシュヒット時の `upsertSchedule()` 呼び出しスキップ
2. キャッシュミス時の正常動作
3. CMATE.md 削除時のキャッシュエントリ除去

**推奨対応**:

ユニットテストレベルではインデックスの有無は機能に影響しないため、モック DB にインデックスを追加する必要はない。ただし、上記 3 つのテストケースは必須。`fs.statSync` のモック方法と、`readCmateFile` のモック方法を実装タスクに含めることを推奨。

---

### R3-007: fs.statSync() のパフォーマンス考慮事項の補足

**カテゴリ**: パフォーマンス影響
**場所**: `schedule-manager.ts` syncSchedules()

**問題**:

100 worktree で 60 秒ごとに 100 回の `fs.statSync()` が発生する。ローカルファイルシステムでは 0.01-0.1ms 程度で問題ないが、CMATE.md が存在しない場合の `ENOENT` エラー処理が必要。

**推奨対応**:

Issue の提案する解決策セクションに以下を補足:
- `fs.statSync()` で `ENOENT` が発生した場合: キャッシュにエントリがあれば「CMATE.md 削除」と判断してスケジュール無効化処理を実行。キャッシュにエントリがなければスキップ。
- `fs.statSync()` のコストは `readFileSync()` + パース + DB 操作と比較して軽微であり、全体的なパフォーマンス改善に寄与。

---

### R3-008: globalThis キャッシュと Hot Reload の挙動確認

**カテゴリ**: 影響範囲
**場所**: `schedule-manager.ts` globalThis.__scheduleManagerStates

**問題**:

`cmateFileCache` は `ManagerState` のフィールドとして `globalThis.__scheduleManagerStates` 内に保持される。Next.js 開発モードの HMR ではモジュールが再評価されても `globalThis` の値は保持される既存パターンに準拠しており、問題ない。

テスト時は `beforeEach` で `globalThis.__scheduleManagerStates = undefined` を設定するだけで `cmateFileCache` もリセットされる（`ManagerState` のプロパティであるため）。

**推奨対応**:

現在のテストコード（`schedule-manager.test.ts:77`）は既にこのリセットを行っているため、追加のリセット処理は不要であることを確認済み。実装時に特別な対応は不要。

---

## Nice to Have（あれば良い）

### R3-009: CLAUDE.md のモジュール説明更新

**カテゴリ**: ドキュメント更新

Issue 完了時に CLAUDE.md の `schedule-manager.ts` モジュール説明に「Issue #409: cmateFileCache(mtimeMs) による差分ベース同期、db.transaction() バッチ化」を追記する。

---

### R3-010: API エンドポイントへのインデックス効果の明示

**カテゴリ**: 影響範囲

`src/app/api/worktrees/[id]/schedules/route.ts` L42 の `WHERE worktree_id = ? AND enabled = 1` クエリは `(worktree_id, enabled)` 複合インデックスの恩恵を受ける。コード変更は不要だが、影響範囲テーブルに受益ファイルとして注記があると変更の効果が明確になる。

---

## 影響ファイル一覧

### 変更が必要なファイル

| ファイル | 変更内容 | Issue記載 |
|---------|---------|----------|
| `src/lib/schedule-manager.ts` | ManagerState に cmateFileCache 追加、syncSchedules() mtime チェック、db.transaction() | 記載あり |
| `src/lib/db-migrations.ts` | version 21 マイグレーション追加、CURRENT_SCHEMA_VERSION = 21 | 記載あり |
| `tests/unit/lib/schedule-manager.test.ts` | mtime キャッシュのテスト追加 | 記載あり |
| `tests/unit/lib/db-migrations.test.ts` | CURRENT_SCHEMA_VERSION アサーション更新、#21 テスト追加 | **未記載** |

### 変更不要だが影響を受けるファイル

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/session-cleanup.ts` | stopAllSchedules() 呼び出しにより cmateFileCache が全消去される副作用（R3-001） |
| `src/app/api/worktrees/[id]/schedules/route.ts` | (worktree_id, enabled) インデックスによりクエリ最適化 |
| `server.ts` | initScheduleManager() のインターフェースは変更なし |

### 変更なし・影響なし

| ファイル | 理由 |
|---------|------|
| `src/lib/claude-executor.ts` | globalThis.__scheduleActiveProcesses は別のグローバル変数 |
| `src/app/api/worktrees/[id]/schedules/[scheduleId]/route.ts` | 直接的なコード変更不要 |

---

## 依存関係マップ

```
Issue #406 (cmate-parser async化)
    |
    +-- syncSchedules() 内の readCmateFile() 呼び出し変更 (競合リスク)
    |
Issue #409 (本Issue)
    |
    +-- ManagerState に cmateFileCache 追加
    +-- syncSchedules() に mtime チェック追加
    +-- db.transaction() バッチ化
    +-- マイグレーション version 21
    |
Issue #407 (globalThis Map メモリリーク修正)
    |
    +-- ManagerState にエントリ削除関数追加 (競合リスク)
    +-- session-cleanup.ts の stopAllSchedules() 修正 (R3-001 解消)
```

**推奨マージ順序**: Issue #409 -> Issue #406 -> Issue #407

---

## 参照ファイル

### コード
- `src/lib/schedule-manager.ts`: 主要変更対象
- `src/lib/db-migrations.ts`: マイグレーション version 21 追加
- `src/lib/session-cleanup.ts`: stopAllSchedules() の副作用（R3-001）
- `src/lib/cmate-parser.ts`: readCmateFile() の mtime チェック対象
- `src/app/api/worktrees/[id]/schedules/route.ts`: インデックス受益クエリ
- `tests/unit/lib/db-migrations.test.ts`: CURRENT_SCHEMA_VERSION アサーション更新
- `tests/unit/lib/schedule-manager.test.ts`: mtime キャッシュテスト追加

### ドキュメント
- `CLAUDE.md`: schedule-manager.ts モジュール説明の更新
