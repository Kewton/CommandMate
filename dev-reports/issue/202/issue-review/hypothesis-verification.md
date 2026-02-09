# Issue #202 仮説検証レポート

## 検証日時
- 2026-02-09

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `server.ts` の `initializeWorktrees()` が `filterExcludedPaths()` でフィルタリングせずに `scanMultipleRepositories()` に渡している | **Confirmed** | server.ts:77-91 でフィルタリングなし |
| 2 | API Sync All (`sync/route.ts`) は `filterExcludedPaths()` を使用している | **Confirmed** | sync/route.ts:26-33 で使用 |
| 3 | API Sync All では復活しないが、サーバー起動時では復活する | **Confirmed** | フィルタリングの有無が原因 |

## 詳細検証

### 仮説 1: `server.ts` の `initializeWorktrees()` が `filterExcludedPaths()` でフィルタリングしていない

**Issue内の記述**:
> `server.ts` の `initializeWorktrees()` で、環境変数 `CM_ROOT_DIR` から取得したリポジトリパスを `filterExcludedPaths()` でフィルタリングせずに `scanMultipleRepositories()` → `syncWorktreesToDB()` に渡している。

**検証手順**:
1. `server.ts` の `initializeWorktrees()` 関数を確認
2. `getRepositoryPaths()` から `scanMultipleRepositories()` までの処理フローを追跡

**判定**: **Confirmed**

**根拠**:
```typescript
// server.ts:69-100
async function initializeWorktrees() {
  try {
    // Run database migrations first
    console.log('Running database migrations...');
    const db = getDbInstance();
    runMigrations(db);

    // Get repository paths from environment variables
    const repositoryPaths = getRepositoryPaths();  // L77

    if (repositoryPaths.length === 0) {
      console.warn('Warning: No repository paths configured');
      console.warn('Set WORKTREE_REPOS (comma-separated) or MCBD_ROOT_DIR');
      return;
    }

    console.log(`Configured repositories: ${repositoryPaths.length}`);
    repositoryPaths.forEach((path, i) => {
      console.log(`  ${i + 1}. ${path}`);
    });

    // Scan all repositories
    const worktrees = await scanMultipleRepositories(repositoryPaths);  // L91

    // Sync to database
    syncWorktreesToDB(db, worktrees);  // L94

    console.log(`✓ Total: ${worktrees.length} worktree(s) synced to database`);
  } catch (error) {
    console.error('Error initializing worktrees:', error);
  }
}
```

**確認事項**:
- ✅ `getRepositoryPaths()` で環境変数からパスを取得（L77）
- ❌ **`ensureEnvRepositoriesRegistered()` の呼び出しなし**
- ❌ **`filterExcludedPaths()` の呼び出しなし**
- ✅ フィルタリングなしで `scanMultipleRepositories(repositoryPaths)` に渡している（L91）

**Issueへの影響**: Issue記載通り、server.ts では除外フィルタリングが未実装。

---

### 仮説 2: API Sync All (`sync/route.ts`) は `filterExcludedPaths()` を使用している

**Issue内の記述**:
> | 処理 | `filterExcludedPaths()` | 結果 |
> |------|------------------------|------|
> | API Sync All (`sync/route.ts`) | ✅ あり | 復活しない |

**検証手順**:
1. `src/app/api/repositories/sync/route.ts` を確認
2. `filterExcludedPaths()` の使用箇所を特定

**判定**: **Confirmed**

**根拠**:
```typescript
// sync/route.ts:12-36
export async function POST() {
  try {
    // Get configured repository paths from environment
    const repositoryPaths = getRepositoryPaths();  // L15

    if (repositoryPaths.length === 0) {
      return NextResponse.json(
        { error: 'No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR environment variable.' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Issue #190: Register environment variable repositories to repositories table (idempotent)
    ensureEnvRepositoriesRegistered(db, repositoryPaths);  // L27

    // Issue #190: Filter out excluded (enabled=0) repositories
    const filteredPaths = filterExcludedPaths(db, repositoryPaths);  // L30

    // Scan filtered repositories (excluded repos are skipped)
    const allWorktrees = await scanMultipleRepositories(filteredPaths);  // L33

    // Sync to database
    syncWorktreesToDB(db, allWorktrees);  // L36

    // ...
  }
}
```

**確認事項**:
- ✅ `ensureEnvRepositoriesRegistered()` でリポジトリをDB登録（L27）
- ✅ `filterExcludedPaths()` で除外リポジトリをフィルタリング（L30）
- ✅ フィルタ済みパス（`filteredPaths`）を `scanMultipleRepositories()` に渡している（L33）

**Issueへの影響**: Issue記載通り、sync/route.ts では除外フィルタリングが正しく実装されている。

---

### 仮説 3: API Sync All では復活しないが、サーバー起動時では復活する

**Issue内の記述**:
> 関連: #190（Sync All復活防止は対策済みだが、サーバー起動時の初期化処理が未対策）

**検証手順**:
1. 仮説1と仮説2の検証結果を比較
2. フィルタリングの有無が原因であることを確認

**判定**: **Confirmed**

**根拠**:

| 処理 | `ensureEnvRepositoriesRegistered()` | `filterExcludedPaths()` | 結果 |
|------|-----------------------------------|------------------------|------|
| API Sync All (`sync/route.ts`) | ✅ あり（L27） | ✅ あり（L30） | 復活しない |
| サーバー起動時 (`server.ts`) | ❌ **なし** | ❌ **なし** | **復活する** |

**因果関係**:
1. UIでリポジトリを削除すると、DB の `repositories` テーブルで `enabled=0` に設定される
2. API Sync All では `filterExcludedPaths()` が `enabled=0` のリポジトリをフィルタリングするため、スキャン対象外となる
3. サーバー起動時（`initializeWorktrees()`）では `filterExcludedPaths()` を呼び出していないため、環境変数のすべてのパスがスキャン対象となる
4. 結果、削除済み（`enabled=0`）のリポジトリが `syncWorktreesToDB()` で再び DB に登録される

**Issueへの影響**: 根本原因が正確に特定されている。Issue記載の修正方針（server.ts に除外フィルタリング追加）は妥当。

---

## Stage 1レビューへの申し送り事項

- ✅ すべての仮説が **Confirmed** であり、Issue記載内容は正確
- ✅ 修正方針（`ensureEnvRepositoriesRegistered()` と `filterExcludedPaths()` の追加）は妥当
- ✅ 影響範囲（server.ts のみ）も正確
- 🔍 Stage 1レビューでは以下を重点確認:
  - import文に `ensureEnvRepositoriesRegistered, filterExcludedPaths` の追加が記載されているか
  - `filterExcludedPaths()` の呼び出し順序（`ensureEnvRepositoriesRegistered()` の後）が正しいか
  - 既存のテストへの影響範囲が明記されているか

---

## 結論

Issue #202 の記載内容はすべて **事実に基づいており、検証済み** です。
仮説ではなく、コードベースから確認できる客観的な事実として正確です。

次の Stage 1（通常レビュー）では、修正方針の妥当性と影響範囲の網羅性を中心にレビューを実施してください。
