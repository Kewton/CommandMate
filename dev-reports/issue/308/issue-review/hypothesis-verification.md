# Issue #308 仮説検証レポート

## 検証日時
- 2026-02-19

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `clone-manager.ts` L193 で `basePath` デフォルト値が `/tmp/repos` にハードコードされている | Confirmed | L193: `config.basePath \|\| process.env.WORKTREE_BASE_PATH \|\| '/tmp/repos'` を確認 |
| 2 | `clone/route.ts` L71 で `new CloneManager(db)` として初期化し `basePath` を渡していない | Confirmed | L71: `const cloneManager = new CloneManager(db);` を確認 |
| 3 | `CloneManager` が `CM_ROOT_DIR` ではなく `WORKTREE_BASE_PATH` を参照し命名体系と不整合 | Confirmed | `ENV_MAPPING` に `WORKTREE_BASE_PATH` は含まれず、他APIは `getEnv().CM_ROOT_DIR` を使用 |
| 4 | `[jobId]/route.ts` でも `new CloneManager(db)` として初期化している | Partially Confirmed | L61 で確認済。ただし status 取得のみで `basePath` は実際には使用されない |

## 詳細検証

### 仮説 1: `basePath` デフォルト値のハードコード

**Issue内の記述**: `CloneManager`のコンストラクタ（`src/lib/clone-manager.ts` L193）で`basePath`のデフォルト値が`'/tmp/repos'`にハードコードされている。

**検証手順**:
1. `src/lib/clone-manager.ts` L189-196 を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/clone-manager.ts L192-195
this.config = {
  basePath: config.basePath || process.env.WORKTREE_BASE_PATH || '/tmp/repos',
  timeout: config.timeout || 10 * 60 * 1000,
};
```

macOS では `/tmp` → `/private/tmp` のシンボリックリンクのため、実際には `/private/tmp/repos` に作成される。

---

### 仮説 2: clone APIルートが `basePath` なしで初期化

**Issue内の記述**: clone APIルート（`src/app/api/repositories/clone/route.ts` L71）では`CloneManager`を`new CloneManager(db)`として初期化しており、`basePath`を渡していない。

**検証手順**:
1. `src/app/api/repositories/clone/route.ts` L70-75 を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/app/api/repositories/clone/route.ts L70-71
const db = getDbInstance();
const cloneManager = new CloneManager(db);
```
`config` 引数が渡されていないため、`CloneManager` コンストラクタのデフォルト値（`WORKTREE_BASE_PATH || '/tmp/repos'`）が使用される。

---

### 仮説 3: `CM_ROOT_DIR` vs `WORKTREE_BASE_PATH` の不整合

**Issue内の記述**: `WORKTREE_BASE_PATH`という別の環境変数を直接参照しており、環境変数の命名体系と不整合が生じている。

**検証手順**:
1. `src/lib/env.ts` の `ENV_MAPPING` を確認
2. 他の API ルートが `CM_ROOT_DIR` を使用しているか確認

**判定**: Confirmed

**根拠**:
- `env.ts` の `ENV_MAPPING` には `WORKTREE_BASE_PATH` が含まれていない（CM_ROOT_DIR, CM_PORT, CM_BIND, CM_LOG_LEVEL, CM_LOG_FORMAT, CM_LOG_DIR, CM_DB_PATH のみ）
- `src/app/api/repositories/scan/route.ts` は `getEnv().CM_ROOT_DIR` を使用している
- `dev-reports/design/issue-76-env-fallback-design-policy.md` でも `WORKTREE_BASE_PATH` は「フォールバック対象外」と記録されている
- `dev-reports/review/2026-01-29-issue76-architecture-review.md` でも同様の記録あり

---

### 仮説 4: `[jobId]/route.ts` でも同様の問題

**Issue内の記述**: `src/app/api/repositories/clone/[jobId]/route.ts`: 同上（CloneManager初期化時にbasePath指定追加）

**検証手順**:
1. `src/app/api/repositories/clone/[jobId]/route.ts` を確認

**判定**: Partially Confirmed

**根拠**:
```typescript
// src/app/api/repositories/clone/[jobId]/route.ts L61
const cloneManager = new CloneManager(db);
```
- `new CloneManager(db)` で初期化されていることは確認。
- ただし、このルートは `getCloneJobStatus()` のみを呼び出しており、`basePath` はステータス取得では使用されない。
- 実際のバグへの影響はないが、一貫性のため修正は推奨される。

---

## Stage 1レビューへの申し送り事項

- 全仮説が **Confirmed（または Partially Confirmed）** であり、Issue の根本原因分析は正確
- `[jobId]/route.ts` への修正は技術的に必須ではないが、コードの一貫性維持のため含めることが適切
- 受入条件の「`CM_ROOT_DIR`未設定時は`process.cwd()`をフォールバック値として使用」が、`env.ts` の `getEnv()` 実装（`getEnvByKey('CM_ROOT_DIR') || process.cwd()`）と整合していることを確認
- `WORKTREE_BASE_PATH` の非推奨化時の後方互換性テストについて、具体的なテストケースが Issue に明記されているか確認を推奨
