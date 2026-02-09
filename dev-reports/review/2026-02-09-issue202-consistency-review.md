# Architecture Review Report: Issue #202 - Stage 2 整合性レビュー

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #202 サーバー再起動時の削除済みリポジトリ復活防止 |
| **Focus** | 整合性 (Consistency) - 設計方針書 vs 実装 |
| **Stage** | Stage 2 - 整合性レビュー |
| **Status** | Conditionally Approved |
| **Score** | 4 / 5 |
| **Date** | 2026-02-09 |

設計方針書と既存コードベースの整合性を精査した結果、設計方針書の記述は現行の実装状態と正確に一致しており、根本原因の分析、修正後コード、依存関係の特定、テスト方針のいずれも信頼性が高い。Must Fix 項目はなし。推奨改善として2件（JSDoc追記、sync/route.tsコメント追加）を報告する。

---

## Detailed Findings

### 整合性マトリクス

設計方針書の各設計項目と現行実装を逐一比較した結果を以下に示す。

#### 1. 根本原因の分析

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| server.ts の initializeWorktrees() にフィルタリングが欠如 | Section 1: `initializeWorktrees()` が Issue #190 の除外フィルタリングを持たない | `server.ts` L90-94: `scanMultipleRepositories(repositoryPaths)` を直接呼び出し。`ensureEnvRepositoriesRegistered` や `filterExcludedPaths` の呼び出しなし | **一致**: 設計書の根本原因分析は正確 |
| sync/route.ts には対策済み | Section 1: Issue #190 で `sync/route.ts` に適用済み | `src/app/api/repositories/sync/route.ts` L26-30: `ensureEnvRepositoriesRegistered` と `filterExcludedPaths` が実装済み | **一致**: 設計書の参照実装の記述は正確 |

#### 2. 修正対象ファイルと変更内容

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| server.ts への import 文追加 | Section 7-1: `import { ensureEnvRepositoriesRegistered, filterExcludedPaths } from './src/lib/db-repository';` | `server.ts` L32-42: 既存 import は全て `'./src/lib/...'` 形式の相対パス。`db-repository` の import なし | **整合**: 設計書の import パス形式は既存パターンと一致。実装は未着手 |
| initializeWorktrees() にフィルタリング追加 | Section 7-1: `ensureEnvRepositoriesRegistered` -> `filterExcludedPaths` -> `scanMultipleRepositories(filteredPaths)` -> `syncWorktreesToDB` | `server.ts` L90-94: `scanMultipleRepositories(repositoryPaths)` -> `syncWorktreesToDB` | **整合**: 設計書の修正後コードは sync/route.ts L26-36 のパターンと一致 |
| tsconfig.server.json への追加 | Section 7-2: `src/lib/db-repository.ts`, `src/config/system-directories.ts` を include に追加 | `tsconfig.server.json` L8-24: 両ファイルとも未追加 | **整合**: 設計書の追加対象は正確。依存チェーン (db-repository -> system-directories, db-repository -> types/clone) の分析も正確。`src/types/**/*.ts` で clone.ts はカバー済みの記述も正しい |

#### 3. 既存関数の仕様整合

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| `ensureEnvRepositoriesRegistered()` のシグネチャ | Section 4: `ensureEnvRepositoriesRegistered(db, repositoryPaths)` | `db-repository.ts` L369-386: `(db: Database.Database, repositoryPaths: string[]): void` | **一致** |
| `ensureEnvRepositoriesRegistered()` の冪等性 | Section 4, 5: 既登録リポジトリはスキップ | `db-repository.ts` L375-376: `getRepositoryByPath` で既存チェック、存在すれば何もしない | **一致** |
| `ensureEnvRepositoriesRegistered()` が disabled リポを再有効化しない | Section 5: 冪等。enabled 状態を変更しない | `db-repository.ts` L375-376: `existing` が true の場合は early return（enabled を更新しない） | **一致**: テスト `db-repository-exclusion.test.ts` L145-158 でも検証済み |
| `filterExcludedPaths()` のシグネチャ | Section 4: `filterExcludedPaths(db, repositoryPaths)` | `db-repository.ts` L400-408: `(db: Database.Database, repositoryPaths: string[]): string[]` | **一致** |
| `filterExcludedPaths()` のフィルタリングロジック | Section 5: `enabled=0` のパスを除外 | `db-repository.ts` L404-407: `getExcludedRepositoryPaths` で `enabled = 0` のパスを取得し、`Array.includes` で除外 | **一致** |
| 呼び出し順序制約 | Section 4: `ensureEnvRepositoriesRegistered` を `filterExcludedPaths` の前に呼ぶ必要がある | `sync/route.ts` L26-30: この順序で呼び出し。`db-repository.ts` の実装上、未登録パスは `getExcludedRepositoryPaths` に含まれないため除外されない | **一致**: 設計書の順序制約の理由は技術的に正確 |

#### 4. データモデル

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| repositories テーブル構造 | Section 5: id, name, path, enabled, clone_url, ... | `db-repository.ts` L52-63: `RepositoryRow` interface に同一カラム定義 | **一致** |
| enabled カラムの用途 | Section 5: `0=除外, 1=有効` | `db-repository.ts` L93: `enabled: row.enabled === 1` で boolean 変換 | **一致** |

#### 5. セキュリティ設計

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| 新たなセキュリティリスクなし | Section 8: 既存対策を呼び出すのみ | `db-repository.ts` に `isSystemDirectory`, `resolveRepositoryPath`, null byte チェック, `MAX_DISABLED_REPOSITORIES` 実装済み | **一致**: server.ts の修正は関数呼び出しのみで新規入力経路なし |

#### 6. テスト方針

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| 既存ユニットテストで十分 | Section 10: `db-repository-exclusion.test.ts` でカバー済み | `tests/unit/lib/db-repository-exclusion.test.ts`: `ensureEnvRepositoriesRegistered` (7テスト), `filterExcludedPaths` (5テスト), その他26テスト | **一致** |
| 結合テストが既にカバー | Section 10: `repository-exclusion.test.ts` | `tests/integration/repository-exclusion.test.ts`: Exclusion -> Sync フロー、API テスト等9テスト | **一致** |
| 新規テスト不要 | Section 10: server.ts の initializeWorktrees() はテスト困難、既存テストで十分 | `server.ts` L69-100: `app.prepare().then()` コールバック内のクロージャ。外部からのアクセス不可 | **一致**: テスト困難性の評価は正確 |

#### 7. 推奨項目（SF-001 対応）の整合

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| filterExcludedPaths() JSDoc に @requires 追記 | Section 7-3: `@requires ensureEnvRepositoriesRegistered()` を追記 | `db-repository.ts` L392-398: 既存 JSDoc に @requires なし | **差異あり (SF-CS-001)**: 設計書の推奨項目として記載済みだが未実装 |
| sync/route.ts の順序制約コメント | Section 7-4: 順序制約コメントの確認・追加 | `sync/route.ts` L26-30: `Issue #190` コメントのみ、順序制約の明示なし | **差異あり (SF-CS-002)**: 設計書の推奨項目として記載済みだが未実装 |

---

## SF-CS-001: filterExcludedPaths() の JSDoc に @requires 前提条件が未実装

**カテゴリ**: 整合性 (Should Fix)
**重要度**: Medium

設計方針書 Section 7-3 では、`filterExcludedPaths()` の JSDoc に以下の前提条件を追記する方針が明記されている:

```typescript
/**
 * Filter out excluded repository paths (enabled=0).
 *
 * @requires ensureEnvRepositoriesRegistered() must be called before this function
 *           to ensure all paths exist in the repositories table.
 *           Without prior registration, unregistered paths will not be filtered correctly.
 * @param db - Database instance
 * @param repositoryPaths - Array of repository paths to filter
 * @returns Filtered array excluding disabled repositories
 */
```

現在の `db-repository.ts` L392-408 にはこの `@requires` が存在しない:

```typescript
// 現在の JSDoc (db-repository.ts L392-398)
/**
 * Filter out excluded repository paths.
 * Exclusion logic is encapsulated here, so changes to exclusion criteria
 * (e.g., pattern-based exclusion, temporary exclusion) only affect this function.
 *
 * NOTE (SEC-SF-002): Array.includes() performs case-sensitive string comparison.
 * ...
 * SF-003: OCP - exclusion logic encapsulated
 */
```

この JSDoc 追記は設計書の実装チェックリスト（Section 15 推奨項目）に含まれている。Issue #202 の実装時に対応すべきである。

---

## SF-CS-002: sync/route.ts に順序制約コメントが不足

**カテゴリ**: 整合性 (Should Fix)
**重要度**: Low

設計方針書 Section 7-4 では、sync/route.ts の呼び出し箇所にも順序制約コメントを追加する方針が明記されている:

```typescript
// NOTE: Must be called BEFORE filterExcludedPaths() - order dependency
ensureEnvRepositoriesRegistered(db, repositoryPaths);

// NOTE: Requires ensureEnvRepositoriesRegistered() to have been called first
const filteredPaths = filterExcludedPaths(db, repositoryPaths);
```

現在の `sync/route.ts` L26-30:

```typescript
// Issue #190: Register environment variable repositories to repositories table (idempotent)
ensureEnvRepositoriesRegistered(db, repositoryPaths);

// Issue #190: Filter out excluded (enabled=0) repositories
const filteredPaths = filterExcludedPaths(db, repositoryPaths);
```

Issue番号付きコメントはあるが、呼び出し順序が **必須** である旨の明示がない。設計書の推奨項目（Section 15）に含まれている。

---

## C-CS-001: tsconfig.server.json の include と tsc-alias の動作保証

**カテゴリ**: 整合性 (Consider)

`tsconfig.server.json` の `include` 配列は TypeScript コンパイラのルートファイルを定義する。TypeScript 自体はインポートグラフを辿って依存ファイルを自動的に解決するが、`tsc-alias` によるパスエイリアス (`@/`) の変換が `include` に依存する可能性がある。

現在の `tsconfig.server.json` でも `auto-yes-manager.ts` が `include` に含まれていないにも関わらず `server.ts` から import されてビルドが成功している。これは TypeScript の依存解決が `include` の範囲外も処理するためだが、`tsc-alias` の変換対象がどう決まるかは実装依存である。

設計方針書では `db-repository.ts` と `system-directories.ts` を明示的に `include` に追加する方針としており、これは `tsc-alias` の確実な動作保証の観点から安全側の判断であり、適切である。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 設計方針書と実装の不整合による実装ミス | Low | Low | P3 |
| セキュリティ | 新規リスクなし（設計書の評価は正確） | Low | Low | - |
| 運用リスク | JSDoc 不備による将来の保守時の順序違反 | Low | Low | P3 |

### リスク詳細

**技術的リスク**: 設計方針書の修正対象コード（Section 7-1, 7-2）は、現行の `server.ts` と `tsconfig.server.json` の状態を正確に反映している。修正前コードのスニペットと実際のコードが一致しており、行番号の参照も概ね正確（設計書 L77-94、実際は L76-94 の範囲）である。このため、設計書に従った実装で整合性問題が発生するリスクは低い。

**セキュリティ**: 設計書 Section 8 の「新たなセキュリティリスクなし」という評価は正確である。`ensureEnvRepositoriesRegistered()` と `filterExcludedPaths()` は既にセキュリティ対策（`isSystemDirectory`, `resolveRepositoryPath`, `MAX_DISABLED_REPOSITORIES`）が組み込まれた関数であり、`server.ts` はこれらを呼び出すのみである。

**運用リスク**: `filterExcludedPaths()` の JSDoc に `@requires` が追記されていない点は、将来の保守者が呼び出し順序制約を見落とすリスクを若干増大させる。ただし、Stage 1 レビューの SF-001 で既に指摘・反映済みであり、設計書の実装チェックリストにも含まれているため、実装時に対応されれば問題ない。

---

## 整合性総合評価

### 高い整合性が確認された項目

1. **根本原因の分析**: 設計書の記述と `server.ts` の現行コードが完全に一致
2. **参照実装 (sync/route.ts)**: 設計書が参照する `sync/route.ts` の処理フローが正確に反映
3. **既存関数のシグネチャと挙動**: `ensureEnvRepositoriesRegistered()`, `filterExcludedPaths()` の記述が実装と一致
4. **依存関係の分析**: `db-repository.ts` -> `system-directories.ts`, `db-repository.ts` -> `types/clone.ts` の依存チェーンが正確
5. **import パス形式**: `'./src/lib/...'` 相対パスの選定が `server.ts` の既存パターンと整合
6. **テストカバレッジの評価**: 既存テストの網羅範囲の記述が正確
7. **セキュリティ評価**: 既存対策の再利用という評価が正確
8. **パフォーマンス評価**: 起動時1回の軽量クエリという評価が正確

### 差異が確認された項目

1. **SF-CS-001**: `filterExcludedPaths()` JSDoc の `@requires` 追記が未実装（推奨項目）
2. **SF-CS-002**: `sync/route.ts` の順序制約コメントが未追加（推奨項目）

いずれも設計書の「推奨項目（本 Issue スコープ内）」として実装チェックリストに含まれており、Issue #202 の実装時に対応すべき項目である。

---

## Improvement Recommendations

### 推奨改善項目 (Should Fix)

#### SF-CS-001: filterExcludedPaths() JSDoc への @requires 追記

実装時に `db-repository.ts` の `filterExcludedPaths()` JSDoc に、設計書 Section 7-3 に記載された `@requires` 前提条件を追記すること。これにより、呼び出し順序制約がコード上で明示される。

#### SF-CS-002: sync/route.ts への順序制約コメント追加

実装時に `sync/route.ts` L26-30 の既存コメントに、設計書 Section 7-4 に記載された順序制約コメント（`NOTE: Must be called BEFORE filterExcludedPaths()`）を追加すること。

### 検討事項 (Consider)

#### C-CS-001: tsconfig.server.json の include 方針の一貫性

今後 `server.ts` に新しい依存ファイルを追加する際は、`tsconfig.server.json` の `include` にも明示的に追加する方針を維持すること。

---

## Approval Status

**Status: Conditionally Approved**

設計方針書と既存コードベースの整合性は高く、設計書に従った実装を行うことでバグ修正が正しく行われることが確認できた。以下の条件を満たすことで承認:

1. 実装時に SF-CS-001 (`filterExcludedPaths()` JSDoc の `@requires` 追記) を対応すること
2. 実装時に SF-CS-002 (`sync/route.ts` の順序制約コメント追加) を対応すること

上記はいずれも設計書の実装チェックリスト（Section 15 推奨項目）に既に含まれているため、チェックリストに従って実装すれば自動的に対応される。

---

*Generated by architecture-review-agent*
*Date: 2026-02-09*
*Stage: 2 - 整合性レビュー*
