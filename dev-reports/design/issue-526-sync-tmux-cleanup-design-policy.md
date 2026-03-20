# Issue #526 設計方針書: syncWorktreesToDB() tmuxセッションクリーンアップ

## 1. 概要

### 問題
`syncWorktreesToDB()`でworktreeがDBから削除される際、対応するtmuxセッションが削除されず孤立セッションが残り続ける。

### ゴール
worktreeのDB削除時に、対応するtmuxセッション・ポーラー・スケジュール等のリソースを確実にクリーンアップする。

---

## 2. アーキテクチャ設計

### 現状の問題構造

```
syncWorktreesToDB() [同期]
  └─ deleteWorktreesByIds() [DB削除のみ]
     ❌ tmuxセッション削除なし

cleanupMultipleWorktrees() [非同期・既存インフラ]
  └─ cleanupWorktreeSessions()
     ├─ killSession() [tmux]
     ├─ stopResponsePolling()
     ├─ stopAutoYesPolling()
     ├─ deleteAutoYesState()
     └─ stopScheduleForWorktree()
```

### 修正後の構造（方針B: 推奨）

```
syncWorktreesToDB() [同期 → 戻り値変更]
  ├─ deleteWorktreesByIds() [DB削除]
  └─ return { deletedIds } ← NEW

呼び出し元（各APIルート等）[非同期]
  ├─ syncWorktreesToDB() → deletedIds取得
  └─ cleanupMultipleWorktrees(deletedIds, killFn) ← NEW
```

### レイヤー構成

```
プレゼンテーション層（API Routes）
  ├─ sync/route.ts    ← クリーンアップ呼び出し追加
  ├─ scan/route.ts    ← クリーンアップ呼び出し追加
  └─ restore/route.ts ← クリーンアップ呼び出し追加

ビジネスロジック層
  ├─ worktrees.ts     ← 戻り値変更（deletedIds返却）
  ├─ session-cleanup.ts ← killWorktreeSession() / syncWorktreesAndCleanup() 追加エクスポート
  ├─ clone-manager.ts ← クリーンアップ呼び出し追加
  └─ tmux.ts          ← 既存（変更なし）

インフラ層
  ├─ server.ts        ← excludedPaths + sync両方でクリーンアップ追加
  │    └─ 新規依存: session-cleanup.ts（IA-MF-001）
  └─ db/              ← 変更なし
```

#### IA-MF-001: server.ts から session-cleanup.ts への新規依存

server.ts（インフラ層）がビジネスロジック層の session-cleanup.ts に依存する。この依存は以下の理由で妥当と判断する。

- server.ts は起動時の初期化処理（`initializeWorktrees()`）内で worktree の同期とクリーンアップを実行する責務を持つ
- 既存の server.ts は `stopAllPolling`, `stopAllAutoYesPolling`, `stopAllSchedules` 等、ビジネスロジック層のクリーンアップ関数を `gracefulShutdown()` で既に呼んでおり、session-cleanup.ts への依存追加は既存のパターンと一致する
- server.ts に追加が必要な具体的 import:
  - `killWorktreeSession` from `@/lib/session-cleanup`（excludedPaths 処理用）
  - `syncWorktreesAndCleanup` from `@/lib/session-cleanup`（sync 処理用）

---

## 3. 設計方針: 方針(B) 採用

### 方針決定の根拠

| 観点 | 方針(A) async化 | 方針(B) 戻り値返却（採用） |
|------|----------------|--------------------------|
| 責務分離 | ❌ worktrees.tsにsession依存追加 | ✅ worktrees.tsはGit+DB責務を維持 |
| 変更影響 | 5箇所のawait追加 | 5箇所の戻り値処理追加 |
| テスタビリティ | session-cleanupのモック必要 | 戻り値の検証のみ |
| 既存パターン | 新規パターン | repositories/route.tsの既存パターン踏襲 |

**worktrees.tsの現在のimport**: `child_process, util, path, @/types/models, better-sqlite3, @/lib/db, @/lib/env, @/lib/logger`
→ session-cleanup/tmux/cli-toolsへの依存追加は責務の越境となるため方針(B)を採用。

### syncWorktreesToDB() 戻り値変更

```typescript
// Before
function syncWorktreesToDB(db: Database.Database, worktrees: Worktree[]): void

// After
interface SyncResult {
  deletedIds: string[];
  upsertedCount: number;
}
function syncWorktreesToDB(db: Database.Database, worktrees: Worktree[]): SyncResult
```

### killWorktreeSession() 共通化

現在 `repositories/route.ts:30-44` にローカル定義されている `killWorktreeSession()` を共通化する。

```typescript
// src/lib/session-cleanup.ts に追加（既存ファイル）
// MF-C01: getTool() はツールが見つからない場合に Error を throw する（nullを返さない）
// 既存の repositories/route.ts の実装パターンに合わせ、try-catch でラップする
export async function killWorktreeSession(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<boolean> {
  try {
    const manager = CLIToolManager.getInstance();
    const tool = manager.getTool(cliToolId);  // throws Error if not found
    if (!await tool.isRunning(worktreeId)) return false;  // SF-004: await を明示
    const sessionName = tool.getSessionName(worktreeId);
    return killSession(sessionName);
  } catch {
    return false;
  }
}
```

> **注意（SF-002）**: sync処理では syncWorktreesToDB() 内部でDB削除が先に実行され、その後 cleanup が行われる（delete -> cleanup の順序）。一方、server.ts の excludedPaths 処理では cleanup -> delete の順序となる。sync処理側でDB削除後にcleanupが失敗しても、次回syncで再試行可能であるため、この順序の不一致は許容する。

---

## 4. 修正対象と具体的変更

### 4-1. `src/lib/git/worktrees.ts`

**変更内容**: `syncWorktreesToDB()` の戻り値を `SyncResult` に変更

```typescript
interface SyncResult {
  deletedIds: string[];
  upsertedCount: number;
}

export function syncWorktreesToDB(db: Database.Database, worktrees: Worktree[]): SyncResult {
  // SF-C01: 空配列時の早期リターンでもSyncResultを返す
  if (worktrees.length === 0) return { deletedIds: [], upsertedCount: 0 };

  const allDeletedIds: string[] = [];
  let upsertedCount = 0;
  // ... 既存ロジック ...
  // 削除時
  if (deletedIds.length > 0) {
    const result = deleteWorktreesByIds(db, deletedIds);
    allDeletedIds.push(...deletedIds);
    logger.info('worktree:cleanup', { deletedCount: result.deletedCount });
  }
  // upsert時
  // upsertedCount++
  return { deletedIds: allDeletedIds, upsertedCount };
}
```

### 4-2. `src/lib/session-cleanup.ts`

**変更内容**: `killWorktreeSession()` を共通関数として追加

- `CLIToolManager`, `killSession` のimport追加
- `killWorktreeSession()` 関数のエクスポート
- 既存の `cleanupWorktreeSessions()`, `cleanupMultipleWorktrees()` は変更なし

### 4-3. `src/app/api/repositories/sync/route.ts`

**変更内容**: sync後にクリーンアップ実行（MF-001対応: ヘルパー関数を使用）

```typescript
// Before
syncWorktreesToDB(db, allWorktrees);

// After（MF-001: syncWorktreesAndCleanup ヘルパー使用）
const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, allWorktrees);
```

### 4-4. `src/app/api/repositories/scan/route.ts`

**変更内容**: 4-3と同様のパターン（`syncWorktreesAndCleanup()` 使用）

### 4-5. `src/app/api/repositories/restore/route.ts`

**変更内容**: 4-3と同様のパターン（`syncWorktreesAndCleanup()` 使用）

### 4-6. `src/lib/git/clone-manager.ts`

**変更内容**: `onCloneSuccess()` 内でクリーンアップ実行（MF-001対応: ヘルパー関数を使用）

```typescript
// MF-001: syncWorktreesAndCleanup ヘルパー使用
const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, worktrees);
```

#### IA-MF-002: onCloneSuccess() でのエラーハンドリング方針

`onCloneSuccess()` は `executeClone()` 内の `gitProcess.on('close')` コールバック（Promise コンストラクタ内の async コールバック）から呼ばれる。`syncWorktreesAndCleanup()` の追加によりエラー発生確率が上がるため、以下のエラーハンドリング方針を適用する。

**方針**: `syncWorktreesAndCleanup()` 内の `cleanupMultipleWorktrees()` の失敗が `onCloneSuccess()` 全体を reject させないことを保証する。

- `syncWorktreesAndCleanup()` ヘルパー関数は内部で `cleanupMultipleWorktrees()` を try-catch でラップし、クリーンアップ失敗時も `syncResult` と共に `cleanupWarnings` を返す（reject しない）
- 万が一 `syncWorktreesAndCleanup()` 自体が throw した場合に備え、`onCloneSuccess()` 内での呼び出しも try-catch でラップする

```typescript
// onCloneSuccess() 内での呼び出しパターン
try {
  const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, worktrees);
  if (cleanupWarnings.length > 0) {
    logger.warn('clone:cleanup-warnings', { cleanupWarnings });
  }
} catch (error) {
  // syncWorktreesAndCleanup 自体の失敗はログのみ（clone成功は維持）
  logger.error('clone:sync-cleanup-failed', { error });
}
```

**根拠**: `onCloneSuccess()` の主目的はクローン成功後のDB同期であり、セッションクリーンアップの失敗でクローン全体を失敗させるべきではない。クリーンアップの再試行は次回 sync で自動的に行われる。

### 4-7. `server.ts`

**変更内容**: 2箇所の修正

1. **excludedPaths削除処理（`initializeWorktrees()` 内の excludedPaths ループ）**: cleanup -> delete の順序（SF-002: 順序の理由をコメントに明記）（SF-C03: 行番号ではなくコードコンテキストで位置を特定）
2. **initializeWorktrees内のsync**: ヘルパー関数を使用

```typescript
// excludedPaths削除処理
// SF-002: リポジトリ単位の一括削除のため、セッションを先に停止してからDB削除する
const worktreeIds = getWorktreeIdsByRepository(db, resolvedPath);
if (worktreeIds.length > 0) {
  await cleanupMultipleWorktrees(worktreeIds, killWorktreeSession);
  deleteWorktreesByIds(db, worktreeIds);
}

// sync処理（MF-001: syncWorktreesAndCleanup ヘルパー使用）
const { syncResult, cleanupWarnings } = await syncWorktreesAndCleanup(db, allWorktrees);
```

### 4-8. `src/app/api/repositories/route.ts`

**変更内容**: ローカルの `killWorktreeSession()` を削除し、共通化された関数をimport

```typescript
// Before
const killWorktreeSession = async (...) => { ... };

// After
import { killWorktreeSession } from '@/lib/session-cleanup';
```

---

## 5. エラーハンドリング設計

### 原則: 部分的成功を許容

```
sync処理全体
  ├─ DB同期（syncWorktreesToDB）→ 成功必須
  └─ セッションクリーンアップ → 失敗許容（ログのみ）
```

- `cleanupMultipleWorktrees()` は既にpartial successパターンを実装済み
- 個別セッションのkill失敗は `warnings` に収集される
- クリーンアップ全体が失敗しても、sync APIのレスポンスは200（warningsを含める）

### エラーレスポンスの拡張

#### IA-SF-004: 各APIルートのレスポンスフォーマット変更

3つのAPIルート（sync, scan, restore）それぞれのレスポンスフォーマット変更を以下に明記する。全て後方互換（既存フィールドに変更なし、新規フィールドの追加のみ）である。

**sync/route.ts** レスポンス:
```typescript
{
  success: true,
  message: string,
  worktreeCount: number,
  repositoryCount: number,
  repositories: string[],
  deletedCount: number,          // NEW: 削除されたworktree数
  cleanupWarnings: string[]      // NEW: クリーンアップ失敗の警告（SEC-MF-001: サニタイズ済み汎用メッセージのみ）
}
```

**scan/route.ts** レスポンス:
```typescript
{
  success: true,
  // ...既存フィールド維持
  deletedCount: number,          // NEW
  cleanupWarnings: string[]      // NEW
}
```

**restore/route.ts** レスポンス:
```typescript
{
  success: true,
  // ...既存フィールド維持
  deletedCount: number,          // NEW
  cleanupWarnings: string[]      // NEW
}
```

**フロントエンド・CLI への影響**: これらのレスポンスを消費するフロントエンドコンポーネントや CLI コマンドは、新規フィールドを無視しても問題なく動作する（追加フィールドのみのため TypeScript の型チェックでもエラーにならない）。ただし、フロントエンド側に明示的な型定義がある場合は、新規フィールドをオプショナルとして追加することを推奨する。

---

## 6. パフォーマンス設計

### 問題: 大量削除時の応答遅延

最悪ケース: 47 worktrees × 5 CLI tools × 5秒 = 約20分

### 対策

1. **hasSession先行確認**: 既存の `killWorktreeSession()` パターン（`isRunning()` チェック内蔵）を踏襲し、存在しないセッションのタイムアウト待ちを回避

2. **並列実行**: `cleanupMultipleWorktrees()` 内部のforループを `Promise.allSettled()` に変更

> **SF-003 影響範囲**: この変更は `cleanupMultipleWorktrees()` の全呼び出し元に影響する。
> - 既存: `src/app/api/repositories/route.ts` (DELETE handler)
> - 新規: sync/route.ts, scan/route.ts, restore/route.ts, clone-manager.ts, server.ts（`syncWorktreesAndCleanup()` 経由を含む）
>
> **並列実行の安全性根拠**: 各 worktree のセッション名は一意であり、異なる worktree のクリーンアップが互いに干渉しない。同一 worktree に対する複数回同時 cleanup は、worktreeIds 配列の設計上発生しない。

```typescript
// Before (逐次)
for (const id of worktreeIds) {
  const result = await cleanupWorktreeSessions(id, killSessionFn);
}

// After (並列)
const results = await Promise.allSettled(
  worktreeIds.map(id => cleanupWorktreeSessions(id, killSessionFn))
);
```

3. **全体タイムアウト**: sync処理のクリーンアップに上限を設定（例: 60秒）
   - **C-002**: 具体的な実装方針（Promise.race パターン等）は Step 7（パフォーマンス改善）で別途設計する

### パフォーマンス目標

- 通常ケース（1-5 worktree削除）: 追加遅延 < 5秒
- 大量ケース（10+ worktree削除）: 追加遅延 < 30秒

---

## 7. テスト設計

### テスト戦略

| テスト種別 | 対象 | 手法 |
|-----------|------|------|
| 単体テスト | syncWorktreesToDB() 戻り値 | 既存テスト拡張 |
| 単体テスト | killWorktreeSession() 共通化 | 新規テスト |
| 統合テスト | 各APIルートのクリーンアップ | モック注入 |
| 統合テスト | server.ts初期化処理 | 共通関数抽出 |
| エラーテスト | クリーンアップ失敗時の部分成功 | モックエラー |

### テストケース

1. **syncWorktreesToDB()**: 削除対象があるとき `deletedIds` が返ること
2. **syncWorktreesToDB()**: 削除対象がないとき空配列が返ること
3. **killWorktreeSession()**: 実行中セッションをkillできること
4. **killWorktreeSession()**: 非実行セッションでfalseを返すこと
5. **sync API**: 削除時にcleanupMultipleWorktrees()が呼ばれること
6. **sync API**: クリーンアップ失敗時もsync自体は成功すること
7. **server.ts excludedPaths**: 削除前にクリーンアップが呼ばれること

### IA-SF-001: 既存テストファイルごとの具体的変更内容

戻り値が `void` から `SyncResult` に変更されるため、以下の既存テストファイルに対して更新が必要である。

**`src/lib/__tests__/worktrees-sync.test.ts`（5テストケース）**:
- 既存テストは戻り値を検証していないため、テスト自体はそのまま通る（`void` -> `SyncResult` の変更は TypeScript で許容される）
- ただし、以下のテストケースに戻り値の検証を追加する:
  - 「should remove deleted worktrees from DB」: `deletedIds` に削除された worktree の ID が含まれることを検証
  - 「should upsert new worktrees」: `upsertedCount` が正しいことを検証
  - 「should handle empty worktrees array」: `{ deletedIds: [], upsertedCount: 0 }` が返ることを検証

**`tests/unit/worktrees.test.ts`（L262-269）**:
- `syncWorktreesToDB` のシグネチャ存在確認テストに、戻り値型 `SyncResult` の検証を追加

### IA-SF-002: cleanupMultipleWorktrees() 並列化に伴う既存テストの修正

**`tests/unit/session-cleanup.test.ts`（L120-152）**:
- 現在の逐次実行を前提とした `mockResolvedValueOnce` チェーン（L133-136）は、`Promise.allSettled` による並列実行では呼び出し順序が保証されない
- 特に「should aggregate all warnings」テスト（L132-141）では、最初の呼び出しが `true`、2番目が Error を throw する前提で書かれている
- **必要な修正**: `mockResolvedValueOnce` の代わりに、worktreeId に基づく条件分岐モックに書き換える

```typescript
// Before (逐次前提)
killSessionFn.mockResolvedValueOnce(true);
killSessionFn.mockRejectedValueOnce(new Error('fail'));

// After (並列対応: worktreeId に基づく条件分岐)
killSessionFn.mockImplementation(async (id: string, _tool: string) => {
  if (id === 'wt-1') return true;
  if (id === 'wt-2') throw new Error('fail');
  return false;
});
```

### IA-SF-003: integration テストのモック定義更新

`killWorktreeSession` が `session-cleanup.ts` から新たにエクスポートされるため、以下の integration テストのモック定義に追加が必要である。

**`tests/integration/api-repository-delete.test.ts`**:
```typescript
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ warnings: [] }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),  // NEW
}));
```

**`tests/integration/repository-exclusion.test.ts`**:
```typescript
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ warnings: [] }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),  // NEW
}));
```

モックに `killWorktreeSession` を追加しないと、`repositories/route.ts` の DELETE handler が共通化版 `killWorktreeSession` を import した際にテストが失敗する。

---

## 8. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| 方針(B)採用 | 責務分離維持 | 各呼び出し元での個別対応が必要（MF-001でヘルパー関数により軽減） |
| syncWorktreesAndCleanup()導入 | MF-001: 5箇所のDRY違反解消 | session-cleanup.tsがworktrees.tsに依存（syncWorktreesToDBのimport） |
| killWorktreeSession共通化 | 4箇所で同一パターン使用 | session-cleanup.tsの責務範囲が若干拡大 |
| 並列実行導入 | 大量削除時のパフォーマンス | 同時tmux操作による競合リスク（SF-003: 安全性根拠を明記済み） |
| 部分的成功許容 | sync処理の信頼性確保 | 孤立セッションが残る可能性（次回syncで再試行可能） |
| excludedPathsの処理順序維持 | SF-002: cleanup -> delete が安全 | sync処理側とは順序が異なる（設計書に理由を明記） |

### 代替案との比較

- **方針(A) async化**: 責務の越境が発生するため不採用
- **方針(C) killSession()のみ**: ポーラー/スケジュール等のクリーンアップが不完全になるため不採用
- **イベント駆動方式**: オーバーエンジニアリングのため不採用

---

## 9. セキュリティ考慮

- `killSession()` は `execFile` を使用（コマンドインジェクション耐性あり）
- セッション名は内部生成（外部入力を直接使用しない）
- 影響範囲は既存の `cleanupMultipleWorktrees()` と同一で、新たなセキュリティリスクなし
- SF-C04: `worktrees.ts` は `child_process` の `exec` を使用しているが、本 Issue #526 の変更範囲（`syncWorktreesToDB()` の戻り値変更）では `exec` 使用箇所を変更しないため、新たなセキュリティリスクは追加されない
  - SEC-SF-001: `worktrees.ts` の `exec` 使用は将来的に `execFile` への移行を推奨する（技術的負債として記録。本 Issue では対応不要）
- SEC-MF-001: **cleanupWarnings のAPIレスポンスサニタイズ（必須）** -- `syncWorktreesAndCleanup()` が返す `cleanupWarnings` には `getErrorMessage(error)` 由来のスタックトレース、ファイルパス、tmuxセッション名（worktreeIdとcliToolIdを含む）が含まれうる。これをそのままAPIレスポンスに含めると、サーバー内部構造の情報漏洩（OWASP A01/A04）となる。APIレスポンスに返す `cleanupWarnings` は汎用メッセージに変換し、詳細はサーバーログのみに記録すること（実装方針は下記参照）
- SEC-SF-002: 並列実行時のリソース枯渇対策 -- `cleanupMultipleWorktrees()` を `Promise.allSettled()` に変更する設計で、最悪ケース（47 worktrees x 5 CLI tools = 235同時プロセス）でのリソース枯渇リスクがある。現設計では worktree 単位の並列実行であり、各 worktree 内の5ツールは `cleanupWorktreeSessions()` 内で逐次処理されるため、最大同時実行数は `worktreeIds.length` に制限される。この制約を実装時に維持すること。大量 worktree（例: 50以上）の場合は `p-limit` 等による同時実行数制限（例: concurrency=10）の導入を検討する
- SEC-SF-003: sync APIの並列呼び出し時のTOCTOU問題 -- 複数の sync リクエストが同時に到達した場合、同じ worktree の削除を二重に検出し二重クリーンアップが発生しうる。ただし `killSession()` は冪等（存在しないセッションに対して false を返す）であるため実害は限定的。warnings の重複や不整合なログが発生しうるが、現時点では許容する。将来的にクリーンアップ処理が冪等でない操作を含む場合はミューテックス導入を検討する
- SEC-SF-004: ログ出力における worktreeId のサニタイズ -- session-cleanup.ts のログ出力に worktreeId が含まれる。worktreeId はGitコマンド出力由来のため外部ユーザーが直接制御する値ではないが、ブランチ名由来の worktreeId に改行文字や制御文字が含まれた場合のログインジェクションリスクがある。worktreeId の文字種制約（英数字、ハイフン、スラッシュ、アンダースコア、ドットのみ）を実装時に確認し、必要に応じてサニタイズを追加する

### SEC-MF-001: cleanupWarnings サニタイズ実装方針

`syncWorktreesAndCleanup()` ヘルパー関数内またはAPIルート側で、`cleanupWarnings` をサニタイズしてからレスポンスに含める。

```typescript
// syncWorktreesAndCleanup() 内のサニタイズ処理
// 詳細なエラー情報はサーバーログに記録し、クライアントには汎用メッセージのみ返す
if (cleanupWarnings.length > 0) {
  logger.warn('sync:cleanup-warnings', { warnings: cleanupWarnings });  // 詳細はログのみ
  cleanupWarnings = [`${cleanupWarnings.length}件のセッションクリーンアップで警告が発生しました`];  // 汎用メッセージに変換
}
```

**方針**: `syncWorktreesAndCleanup()` が返す `cleanupWarnings` を汎用メッセージに変換する処理を同関数内に組み込む。これにより全呼び出し元（sync, scan, restore, clone-manager, server.ts）で一貫したサニタイズが保証される。呼び出し元個別のサニタイズ漏れリスクを排除する。

---

## 10. 実装順序

1. `SyncResult` 型定義追加（worktrees.ts）（SF-001: 将来の types/ 移動について TODO コメント追加）
2. `syncWorktreesToDB()` 戻り値変更
3. 既存テスト更新（戻り値の型変更対応）
4. `killWorktreeSession()` 共通化（session-cleanup.ts）（SF-004: isRunning() の await を正しく使用）
5. `syncWorktreesAndCleanup()` ヘルパー関数追加（session-cleanup.ts）（MF-001: DRY違反解消）
6. 各呼び出し元を `syncWorktreesAndCleanup()` に置換（sync, scan, restore, clone-manager, server.ts sync処理）
7. server.ts excludedPaths処理: 個別に cleanup -> delete 順序を維持（SF-002: 順序の理由をコメントに明記）
8. `repositories/route.ts` のローカル関数を共通関数に置換
9. パフォーマンス改善（並列実行）（SF-003: 影響範囲を確認）
10. 統合テスト追加

---

---

## 11. Stage 1 レビュー指摘事項と対応方針

### レビュー概要

- **ステージ**: Stage 1（設計原則レビュー）
- **判定**: 条件付き承認（conditionally_approved）
- **スコア**: 4/5
- **レビュー日**: 2026-03-20

### Must Fix

#### MF-001: クリーンアップ呼び出しパターンの重複（DRY違反）

**指摘内容**: sync/route.ts, scan/route.ts, restore/route.ts, clone-manager.ts, server.ts の5箇所以上で同一の「syncResult取得 -> deletedIds判定 -> cleanupMultipleWorktrees呼び出し」パターンが繰り返される。方針(B)の本質的なトレードオフだが、共通ヘルパー関数の導入で軽減すべき。

**対応方針**: `session-cleanup.ts` に `syncWorktreesAndCleanup()` ヘルパー関数を導入する。worktrees.ts の責務を越えないよう、session-cleanup.ts 側に配置する。

```typescript
// src/lib/session-cleanup.ts に追加
export async function syncWorktreesAndCleanup(
  db: Database.Database,
  worktrees: Worktree[]
): Promise<{ syncResult: SyncResult; cleanupWarnings: string[] }> {
  const syncResult = syncWorktreesToDB(db, worktrees);
  let cleanupWarnings: string[] = [];
  if (syncResult.deletedIds.length > 0) {
    const cleanupResult = await cleanupMultipleWorktrees(
      syncResult.deletedIds,
      killWorktreeSession
    );
    // SEC-MF-001: 詳細な警告はサーバーログのみに記録し、クライアント向けには汎用メッセージに変換
    if (cleanupResult.warnings.length > 0) {
      logger.warn('sync:cleanup-warnings', { warnings: cleanupResult.warnings });
      cleanupWarnings = [`${cleanupResult.warnings.length}件のセッションクリーンアップで警告が発生しました`];
    }
  }
  return { syncResult, cleanupWarnings };
}
```

**影響**: Section 4-3, 4-4, 4-5, 4-6, 4-7（sync処理部分）の各呼び出し元は、個別に sync + cleanup を呼ぶ代わりに `syncWorktreesAndCleanup()` を呼ぶだけでよくなる。Section 4-7 の excludedPaths 処理は cleanup -> delete の独自順序のため、ヘルパー関数の対象外とする。

### Should Fix

#### SF-001: SyncResult型の配置場所の検討（SRP）

**指摘内容**: SyncResult インターフェースを worktrees.ts に定義する設計だが、クリーンアップ連携にも使われるため、間接的にクリーンアップ層への結合が生まれる。

**対応方針**: 現状の規模では worktrees.ts に配置して問題ない。ただし、将来 SyncResult を他モジュールから参照するケースが増えた場合は `src/types/` ディレクトリへの移動を検討する。この判断は実装時にコメントとして残す。

#### SF-002: excludedPaths処理とsync処理のクリーンアップ順序不一致（SRP）

**指摘内容**: Section 4-7 の excludedPaths 処理では cleanup -> delete の順序だが、sync処理側では delete（syncWorktreesToDB内部） -> cleanup の順序になり、処理順序が逆転している。

**対応方針**: この順序の不一致は意図的な設計判断である。以下の理由を設計書に明記する。

- **excludedPaths処理（cleanup -> delete）**: リポジトリ単位の一括削除であり、セッションを先に停止してからDB削除する方が安全。
- **sync処理（delete -> cleanup）**: `syncWorktreesToDB()` 内部でDB削除が行われるため、cleanup は後になる。DB削除後にcleanupが失敗しても、次回syncで再試行可能であるため許容する。
- **MF-001対応の `syncWorktreesAndCleanup()` 導入後も、この順序（delete -> cleanup）は維持される。** sync処理の戻り値として deletedIds を返す方針(B)の設計上、DB削除が先に実行される構造は変わらない。

#### SF-003: cleanupMultipleWorktrees の並列化変更の影響範囲（KISS）

**指摘内容**: Section 6 の Promise.allSettled への変更は、既存の `repositories/route.ts` (DELETE) でも使われている共通関数への変更であり、影響範囲が明示されていない。

**対応方針**: `cleanupMultipleWorktrees()` の全呼び出し元への影響を明記する。

- **既存呼び出し元**: `src/app/api/repositories/route.ts` (DELETE handler)
- **新規呼び出し元**: sync/route.ts, scan/route.ts, restore/route.ts, clone-manager.ts, server.ts（MF-001対応で `syncWorktreesAndCleanup()` 経由になる箇所を含む）
- **並列実行による tmux 操作の競合リスクについて**: 各 worktree のセッション名は一意であり、異なる worktree のクリーンアップが互いに干渉することはない。同一 worktree に対して複数回 cleanup が同時実行されるケースは、`cleanupMultipleWorktrees()` が worktreeIds の配列を受け取る設計上発生しない。したがって並列実行は安全である。

#### SF-004: killWorktreeSession の isRunning() 非同期性（OCP）

**指摘内容**: Section 3 のコード例で `tool.isRunning()` に await がないが、現在の repositories/route.ts の実装では await が使われている。isRunning() が非同期関数かどうかの確認が必要。

**対応方針**: Section 3 のコード例を修正し、`isRunning()` の戻り値型を明確にする。実装時に `CLITool` インターフェースの `isRunning()` シグネチャを確認し、async/await パターンを適切に維持する。修正後のコード例:

```typescript
// src/lib/session-cleanup.ts に追加（既存ファイル）
// MF-C01: getTool() は Error を throw するため、try-catch でラップする
export async function killWorktreeSession(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<boolean> {
  try {
    const manager = CLIToolManager.getInstance();
    const tool = manager.getTool(cliToolId);  // throws Error if not found
    if (!await tool.isRunning(worktreeId)) return false;  // await を明示
    const sessionName = tool.getSessionName(worktreeId);
    return killSession(sessionName);
  } catch {
    return false;
  }
}
```

### Consider（参考情報）

以下は必須対応ではないが、実装時に検討する事項として記録する。

| ID | 原則 | 内容 | 対応方針 |
|----|------|------|---------|
| C-001 | YAGNI | `upsertedCount` フィールドの必要性。現時点で使用する呼び出し元がない | ログやAPIレスポンスに含める可能性があるため許容するが、不要と判断した場合は `deletedIds` のみ返す簡潔な型にする |
| C-002 | KISS | 全体タイムアウト（60秒）の実装方針が未詳細 | Step 7（パフォーマンス改善）で Promise.race パターン等の具体的な実装方針を別途設計する |
| C-003 | DRY | cleanupWarnings フィールドの一貫性。scan/restore APIでも同様のフィールドが必要 | MF-001対応の `syncWorktreesAndCleanup()` が cleanupWarnings を返すため、自然に一貫性が確保される |

---

## 12. 実装チェックリスト（Stage 1 レビュー反映後）

### 前提作業
- [ ] `CLITool` インターフェースの `isRunning()` シグネチャ確認（同期/非同期）

### Step 1: 型定義
- [ ] `SyncResult` 型定義追加（worktrees.ts）
  - [ ] 将来の types/ 移動について TODO コメント追加（SF-001）
  - [ ] `upsertedCount` の要否を最終判断（C-001）

### Step 2: コア関数変更
- [ ] `syncWorktreesToDB()` 戻り値変更
  - [ ] 空配列時の早期リターンで `{ deletedIds: [], upsertedCount: 0 }` を返す（SF-C01）
- [ ] `killWorktreeSession()` 共通化（session-cleanup.ts）
  - [ ] `isRunning()` の await を正しく使用（SF-004）
  - [ ] `getTool()` が Error を throw する前提で try-catch を使用（MF-C01）

### Step 3: ヘルパー関数導入（MF-001対応、SEC-MF-001対応）
- [ ] `syncWorktreesAndCleanup()` を session-cleanup.ts に追加
  - [ ] `cleanupResult.warnings` に不要な `?? []` を使用しない（SF-C02）
  - [ ] **cleanupWarnings のサニタイズ処理を組み込む（SEC-MF-001）**: 詳細エラーはサーバーログに記録し、戻り値には汎用メッセージのみを含める
- [ ] sync + cleanup の一連パターンを1箇所に集約

### Step 4: 呼び出し元更新
- [ ] sync/route.ts: `syncWorktreesAndCleanup()` 使用
  - [ ] レスポンスに `deletedCount`, `cleanupWarnings` フィールドを追加（IA-SF-004）
- [ ] scan/route.ts: `syncWorktreesAndCleanup()` 使用
  - [ ] レスポンスに `deletedCount`, `cleanupWarnings` フィールドを追加（IA-SF-004）
- [ ] restore/route.ts: `syncWorktreesAndCleanup()` 使用
  - [ ] レスポンスに `deletedCount`, `cleanupWarnings` フィールドを追加（IA-SF-004）
- [ ] clone-manager.ts: `syncWorktreesAndCleanup()` 使用
  - [ ] `onCloneSuccess()` 内で await を忘れずに追加（C-C02）
  - [ ] `syncWorktreesAndCleanup()` 呼び出しを try-catch でラップし、失敗時もクローン成功を維持（IA-MF-002）
- [ ] server.ts sync処理: `syncWorktreesAndCleanup()` 使用
  - [ ] `session-cleanup.ts` からの import を追加（IA-MF-001: `killWorktreeSession`, `syncWorktreesAndCleanup`）
- [ ] server.ts excludedPaths処理: 個別に cleanup -> delete の順序を維持（SF-002）
  - [ ] 順序の理由をコードコメントに明記
  - [ ] 修正対象はコードコンテキスト（関数名・コメント）で特定する（SF-C03）

### Step 5: 既存コードの整理
- [ ] repositories/route.ts: ローカル `killWorktreeSession()` を削除し、共通関数をimport

### Step 6: テスト
- [ ] syncWorktreesToDB() 戻り値テスト
  - [ ] `src/lib/__tests__/worktrees-sync.test.ts`: 既存テストに `deletedIds`, `upsertedCount` の戻り値検証を追加（IA-SF-001）
  - [ ] `tests/unit/worktrees.test.ts`: シグネチャテストに `SyncResult` 戻り値型の検証を追加（IA-SF-001）
- [ ] killWorktreeSession() 共通化テスト
- [ ] syncWorktreesAndCleanup() ヘルパー関数テスト
- [ ] 各APIルートの統合テスト
  - [ ] `tests/integration/api-repository-delete.test.ts`: モックに `killWorktreeSession` を追加（IA-SF-003）
  - [ ] `tests/integration/repository-exclusion.test.ts`: モックに `killWorktreeSession` を追加（IA-SF-003）
- [ ] クリーンアップ失敗時の部分成功テスト

### Step 6.5: 既存テストの並列化対応（IA-SF-002）
- [ ] `tests/unit/session-cleanup.test.ts`: `mockResolvedValueOnce` チェーンを worktreeId ベースの条件分岐モックに書き換え
  - [ ] 「should aggregate all warnings」テストの呼び出し順序依存を解消

### Step 7: パフォーマンス改善
- [ ] cleanupMultipleWorktrees() 並列化（Promise.allSettled）
  - [ ] 既存 DELETE handler への影響確認（SF-003）
  - [ ] 最大同時実行数が `worktreeIds.length` に制限されることを確認（SEC-SF-002）
  - [ ] 大量 worktree（50以上）の場合の同時実行数制限（p-limit 等）の必要性を評価（SEC-SF-002）
- [ ] 全体タイムアウト実装方針の詳細設計（C-002）

### Step 8: セキュリティ確認（Stage 4 レビュー対応）
- [ ] cleanupWarnings サニタイズが全APIレスポンスパスで有効であることを確認（SEC-MF-001）
- [ ] worktreeId の文字種制約を確認し、改行・制御文字が含まれないことを保証（SEC-SF-004）
- [ ] sync API の並列呼び出し時に二重クリーンアップが発生しても安全であることを確認テスト（SEC-SF-003）

---

## 13. Stage 2 レビュー指摘事項と対応方針

### レビュー概要

- **ステージ**: Stage 2（整合性レビュー）
- **判定**: 条件付き承認（conditionally_approved）
- **スコア**: 4/5
- **レビュー日**: 2026-03-20

### Must Fix

#### MF-C01: killWorktreeSession() の getTool() 戻り値のnullチェックが実装と不整合

**指摘内容**: 設計方針書 Section 3 および Section 11（SF-004対応）のコード例では `const tool = manager.getTool(cliToolId); if (!tool) return false;` としてnullチェックを行っているが、`CLIToolManager.getTool()` の実装（`src/lib/cli-tools/manager.ts` L61-65）ではツールが見つからない場合にnullを返さず Error を throw する。既存の `repositories/route.ts` L30-44 では nullチェックなしで直接使用している。

**対応方針**: 設計書の `killWorktreeSession()` コード例を try-catch パターンに修正した。`getTool()` が Error を throw する前提とし、catch 時に `false` を返す。これにより実際の `CLIToolManager` の挙動と整合する。

**反映箇所**: Section 3、Section 11（SF-004）のコード例を修正済み。

### Should Fix

#### SF-C01: syncWorktreesToDB() の空配列時の早期リターンが SyncResult 未返却

**指摘内容**: 現在の `syncWorktreesToDB()` 実装（`src/lib/git/worktrees.ts` L269-272）では `worktrees.length === 0` の場合に `return;` で早期リターンしている。`SyncResult` 型に変更後、この早期リターンでも適切な値を返す必要がある。

**対応方針**: Section 4-1 のコード例に `if (worktrees.length === 0) return { deletedIds: [], upsertedCount: 0 };` を追加済み。実装チェックリスト Step 2 にも反映。

#### SF-C02: cleanupMultipleWorktrees() の warnings フィールドに対する不要な nullish coalescing

**指摘内容**: Section 11（MF-001対応）の `syncWorktreesAndCleanup()` コード例で `cleanupResult.warnings ?? []` としているが、`CleanupResult` 型（`src/lib/session-cleanup.ts` L40-45）の `warnings` は `string[]` 型であり undefined にならない。

**対応方針**: コード例を `cleanupWarnings = cleanupResult.warnings;` に修正済み。実装チェックリスト Step 3 にも反映。

#### SF-C03: server.ts excludedPaths 処理の行番号が不正確

**指摘内容**: 設計方針書 Section 4-7 では行番号「L225-232」で位置を特定しているが、コード変更により行番号がずれるリスクがある。

**対応方針**: Section 4-7 の記述を行番号ではなくコードコンテキスト（`initializeWorktrees()` 内の excludedPaths ループ）で位置を特定する形に修正済み。実装チェックリスト Step 4 にも反映。

#### SF-C04: worktrees.ts の import リストに exec の種類が未明記

**指摘内容**: worktrees.ts は `child_process` の `exec` を使用しているが、設計書に明記されていない。`tmux.ts` の `execFile` との対比で重要な情報である。

**対応方針**: Section 9（セキュリティ考慮）に「worktrees.ts の `exec` 使用箇所は本 Issue #526 の変更範囲外であり、新たなリスクは追加されない」旨を補足済み。

### Consider（参考情報）

以下は必須対応ではないが、実装時に検討する事項として記録する。

| ID | 内容 | 対応方針 |
|----|------|---------|
| C-C01 | `session-cleanup.ts` から `worktrees.ts` への新規依存（`syncWorktreesToDB` の import）が水平依存として問題ないか | 現状の規模では問題ない。将来 `worktrees.ts` が `session-cleanup.ts` に依存するケースが生まれた場合は循環依存となるため、その時点でヘルパー関数を別ファイルに分離する。**IA-SF-005 追記**: 循環依存の早期検出手段として、以下のいずれかの導入を検討する: (1) `eslint-plugin-import` の `no-cycle` ルール、(2) CI パイプラインでの `madge --circular` 実行。現時点では必須ではないが、session-cleanup.ts と worktrees.ts 間の依存方向が逆転するPRが出た時点で導入する |
| C-C02 | `clone-manager.ts` の `onCloneSuccess()` で `syncWorktreesAndCleanup()` を呼ぶ際に await が必要 | `onCloneSuccess()` は既に async メソッドなので await 追加に問題はない。実装チェックリスト Step 4 に明記済み |
| C-C03 | Section 8 の「4箇所で同一パターン使用」の内訳が不明確 | 現在1箇所（`repositories/route.ts`）+ 新規呼び出し元（`syncWorktreesAndCleanup()` 経由、`server.ts` excludedPaths 処理等）を合わせた数。今後の実装で正確な箇所数を確認する |

---

## 14. Stage 3 レビュー指摘事項と対応方針

### レビュー概要

- **ステージ**: Stage 3（影響分析レビュー）
- **判定**: 条件付き承認（conditionally_approved）
- **スコア**: 4/5
- **レビュー日**: 2026-03-20
- **リスク評価**: 技術: medium / セキュリティ: low / 運用: low

### Must Fix

#### IA-MF-001: server.ts から session-cleanup.ts への新規依存がレイヤー構成図に未反映

**指摘内容**: server.ts（インフラ層）が session-cleanup.ts（ビジネスロジック層）に新規依存するが、Section 2 のレイヤー構成図に明記されていない。server.ts の import セクションに追加が必要な具体的モジュール一覧も不足している。

**対応方針**: Section 2 のレイヤー構成図に server.ts から session-cleanup.ts への依存を追記し、必要な import 一覧（`killWorktreeSession`, `syncWorktreesAndCleanup`）を明記した。既存の `gracefulShutdown()` でのビジネスロジック層への依存パターンと一致するため、レイヤー構成上の妥当性も記載。

**反映箇所**: Section 2 レイヤー構成、Section 12 Step 4 チェックリスト

#### IA-MF-002: clone-manager.ts の onCloneSuccess() でのエラーハンドリング方針が未定義

**指摘内容**: `onCloneSuccess()` は Promise コンストラクタ内の async コールバックから呼ばれる。`syncWorktreesAndCleanup()` の追加によりエラー発生確率が上がるため、エラーハンドリングを明示的に設計すべき。

**対応方針**: Section 4-6 に `onCloneSuccess()` 内での try-catch パターンを追記した。`cleanupMultipleWorktrees()` の失敗が `onCloneSuccess()` 全体を reject させないことを保証する設計とし、具体的なコード例を記載。

**反映箇所**: Section 4-6、Section 12 Step 4 チェックリスト

### Should Fix

#### IA-SF-001: 既存テスト5件への影響が未詳細

**指摘内容**: `worktrees-sync.test.ts`（5テストケース）と `worktrees.test.ts` に対する具体的な変更内容が明確でない。

**対応方針**: Section 7 に既存テストファイルごとの具体的な変更内容を列挙した。テストケース名と追加すべき検証内容を明記。

**反映箇所**: Section 7（IA-SF-001 サブセクション）、Section 12 Step 6 チェックリスト

#### IA-SF-002: cleanupMultipleWorktrees() 並列化による既存テストの挙動変化

**指摘内容**: `tests/unit/session-cleanup.test.ts` の `mockResolvedValueOnce` チェーンが並列実行で呼び出し順序が保証されなくなる。

**対応方針**: Section 7 に並列化対応のモック書き換え方針を追記した。worktreeId ベースの条件分岐モックパターンとコード例を記載。

**反映箇所**: Section 7（IA-SF-002 サブセクション）、Section 12 Step 6.5 チェックリスト

#### IA-SF-003: integration テストのモックに killWorktreeSession の追加が必要

**指摘内容**: `api-repository-delete.test.ts` と `repository-exclusion.test.ts` の `vi.mock('@/lib/session-cleanup')` に `killWorktreeSession` の追加が必要。

**対応方針**: Section 7 に具体的なモック定義の更新内容を記載した。

**反映箇所**: Section 7（IA-SF-003 サブセクション）、Section 12 Step 6 チェックリスト

#### IA-SF-004: sync/scan/restore の各 API レスポンスフォーマット変更の後方互換性

**指摘内容**: 3つの API ルートそれぞれのレスポンスフォーマット変更が明確でない。フロントエンド・CLI への影響も未確認。

**対応方針**: Section 5 に各 API ルート（sync, scan, restore）のレスポンスフォーマット変更を明記した。後方互換性の確認結果とフロントエンド・CLI への影響についても記載。

**反映箇所**: Section 5、Section 12 Step 4 チェックリスト

#### IA-SF-005: session-cleanup.ts から worktrees.ts への新規水平依存の循環依存検出方法が未定義

**指摘内容**: C-C01 で「現状の規模では問題ない」と結論付けているが、循環依存の具体的な検出方法が未定義。

**対応方針**: C-C01 の対応方針に循環依存の早期検出手段（`eslint-plugin-import` の `no-cycle` ルール、または CI での `madge --circular` 実行）を追記した。

**反映箇所**: Section 13 C-C01

### Consider（参考情報）

以下は必須対応ではないが、実装時に検討する事項として記録する。

| ID | 内容 | 対応方針 |
|----|------|---------|
| IA-C-001 | gracefulShutdown 内でのクリーンアップとの競合可能性（SIGTERM 受信時に syncWorktreesAndCleanup() が実行中の場合） | エッジケースとして認識。initializeWorktrees の実行状態追跡は現時点では不要だが、タイムアウト関連の問題が報告された場合に検討する |
| IA-C-002 | CI/CD パイプラインへの影響は最小限。TypeScript の厳格モードで戻り値変更は後方互換 | 特別な対応不要 |
| IA-C-003 | repositories/route.ts DELETE handler での killWorktreeSession 置換時のエラーログ出力内容の変化 | 動作差異は軽微。共通化後のエラーログ出力内容が変わりうることを認識した上で実装する |

---

## 15. Stage 4 レビュー指摘事項と対応方針

### レビュー概要

- **ステージ**: Stage 4（セキュリティレビュー / OWASP Top 10 準拠確認）
- **判定**: 条件付き承認（conditionally_approved）
- **スコア**: 4/5
- **レビュー日**: 2026-03-20
- **リスク評価**: 技術: low / セキュリティ: low / 運用: low

### OWASP Top 10 チェック結果サマリ

| カテゴリ | 結果 | 備考 |
|---------|------|------|
| A01 Broken Access Control | pass | sync/scan/restore APIはmiddleware.tsで保護済み |
| A02 Cryptographic Failures | N/A | 暗号処理の変更なし |
| A03 Injection | conditional pass | killSession()はexecFileで安全。worktrees.tsのexecは変更範囲外 |
| A04 Insecure Design | conditional pass | cleanupWarningsの情報漏洩リスク（SEC-MF-001） |
| A05 Security Misconfiguration | pass | 設定変更なし |
| A06 Vulnerable Components | N/A | 新規依存なし |
| A07 Auth Failures | pass | 認証フロー変更なし |
| A08 Data Integrity | pass | 新たなリスクなし |
| A09 Logging Failures | conditional pass | worktreeIdのログインジェクションリスクは低い（SEC-SF-004） |
| A10 SSRF | N/A | 外部リクエスト発行なし |

### Must Fix

#### SEC-MF-001: cleanupWarnings のAPIレスポンスでのサニタイズ不足（情報漏洩）

**指摘内容**: `syncWorktreesAndCleanup()` が返す `cleanupWarnings` に `getErrorMessage(error)` 由来のスタックトレース、ファイルパス、tmuxセッション名（worktreeIdとcliToolIdを含む）が含まれうる。これがAPIレスポンスとしてクライアントに返却されると、サーバー内部構造の情報漏洩となる（OWASP A01/A04）。

**対応方針**: `syncWorktreesAndCleanup()` 関数内で cleanupWarnings をサニタイズする。詳細なエラー情報はサーバーログ（`logger.warn`）のみに記録し、クライアント向け戻り値は「N件のセッションクリーンアップで警告が発生しました」のような汎用メッセージに変換する。これにより全呼び出し元で一貫したサニタイズが保証される。

**反映箇所**: Section 9（セキュリティ考慮）、Section 11 MF-001 コード例、Section 5 レスポンスフォーマット注釈、Section 12 Step 3/Step 8 チェックリスト

### Should Fix

#### SEC-SF-001: worktrees.ts の exec 使用の技術的負債記録

**指摘内容**: `worktrees.ts` は `child_process` の `exec` を使用しており、シェル経由のコマンド実行であるため本質的にコマンドインジェクションリスクがある。本 Issue の変更範囲では新たなリスクは追加されないが、将来の変更リスクとして記録すべき。

**対応方針**: Section 9 に「worktrees.ts の exec 使用は将来的に execFile への移行を推奨する」旨を技術的負債として追記済み。本 Issue での対応は不要。

**反映箇所**: Section 9

#### SEC-SF-002: 並列実行時のリソース枯渇に対する同時実行数の明確化

**指摘内容**: `Promise.allSettled()` による無制限並列で、最悪ケース（47 worktrees x 5 CLI tools = 235同時プロセス）のリソース枯渇リスクがある。

**対応方針**: 現設計では worktree 単位の並列（各 worktree 内の5ツールは `cleanupWorktreeSessions()` 内で逐次処理）であり、最大同時実行数は `worktreeIds.length` に制限される。この制約を Section 9 に明記済み。大量 worktree の場合は `p-limit` 等の導入を検討する旨も記載。

**反映箇所**: Section 9、Section 12 Step 7 チェックリスト

#### SEC-SF-003: sync APIの並列呼び出し時のTOCTOU問題

**指摘内容**: 複数のsyncリクエストが同時に到達した場合、同じworktreeの削除を二重に検出し二重クリーンアップが実行される可能性がある。

**対応方針**: `killSession()` の冪等性により実害は限定的であるため、現時点ではこの挙動を許容する。Section 9 に「sync APIの並列呼び出し時は二重クリーンアップが発生しうるが、killSession() の冪等性により安全である」旨を追記済み。

**反映箇所**: Section 9、Section 12 Step 8 チェックリスト

#### SEC-SF-004: ログ出力における worktreeId のサニタイズ

**指摘内容**: session-cleanup.ts のログ出力に worktreeId が含まれるが、ブランチ名由来の worktreeId に改行文字や制御文字が含まれた場合のログインジェクションリスクがある。

**対応方針**: worktreeId の文字種制約を実装時に確認し、必要に応じてサニタイズを追加する旨を Section 9 に追記済み。

**反映箇所**: Section 9、Section 12 Step 8 チェックリスト

### Consider（参考情報）

以下は必須対応ではないが、認識事項として記録する。

| ID | 内容 | 対応方針 |
|----|------|---------|
| SEC-C-001 | sync/scan/restore APIの認証はmiddleware.tsで保護されており、本設計変更で認証/認可に関する新たなリスクは追加されない | 対応不要 |
| SEC-C-002 | sync/route.ts の500エラー時に error.message がそのままレスポンスに含まれている既存問題。本 Issue の変更範囲外だが、syncWorktreesAndCleanup() 導入でエラーパスが増える | 本 Issue の範囲外として認識。別途改善 Issue として起票を検討 |
| SEC-C-003 | killSession() の execFile 使用は安全。引数は配列で渡されシェルインジェクション不可。sessionName は内部生成 | 対応不要 |

---

*Generated by design-policy command for Issue #526*
*Date: 2026-03-20*
*Stage 1 review applied: 2026-03-20*
*Stage 2 review applied: 2026-03-20*
*Stage 3 review applied: 2026-03-20*
*Stage 4 review applied: 2026-03-20*
