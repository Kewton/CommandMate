# Architecture Review: Issue #202 影響範囲分析 (Stage 3)

## Executive Summary

Issue #202 (サーバー再起動時の削除済みリポジトリ復活防止) の変更による影響範囲を分析した。本修正は `server.ts` の `initializeWorktrees()` に既存関数 (`ensureEnvRepositoriesRegistered()` + `filterExcludedPaths()`) を追加する最小限の変更であり、影響範囲は限定的である。直接変更ファイルは4ファイル（うち2ファイルはコメント/JSDoc追加のみ）、間接依存は5ファイル（いずれも変更不要）。テスト・ビルドへの悪影響は想定されない。

**Status**: conditionally_approved (条件付き承認)
**Score**: 4/5

---

## 1. 直接変更ファイル

| カテゴリ | ファイル | 変更内容 | リスク |
|---------|---------|---------|-------|
| 直接変更 | `server.ts` | import文追加 + `initializeWorktrees()` に除外フィルタリングロジック追加 | Low |
| 直接変更 | `tsconfig.server.json` | include配列に `db-repository.ts` と `system-directories.ts` を追加 | Low |
| コメント追加 | `src/lib/db-repository.ts` | `filterExcludedPaths()` に `@requires` JSDoc追記 (SF-CS-001) | Low |
| コメント追加 | `src/app/api/repositories/sync/route.ts` | 呼び出し順序制約のインラインコメント追加 (SF-CS-002) | Low |

### 1-1. server.ts の変更詳細

`initializeWorktrees()` 関数 (L69-100) に以下の変更を追加する。

**変更点**:
1. import文に `ensureEnvRepositoriesRegistered` と `filterExcludedPaths` を追加 (L42の後)
2. `getRepositoryPaths()` の後に `ensureEnvRepositoriesRegistered(db, repositoryPaths)` を呼び出し
3. `filterExcludedPaths(db, repositoryPaths)` で除外フィルタリング
4. 除外数のログ出力（条件付き）
5. `scanMultipleRepositories()` の引数を `repositoryPaths` から `filteredPaths` に変更

**影響範囲**: `initializeWorktrees()` はサーバー起動時に1回のみ呼び出される。`app.prepare().then()` コールバック内のクロージャであり、外部からの呼び出しは不可能。変更は関数内部に閉じている。

### 1-2. tsconfig.server.json の変更詳細

include配列に2ファイルを追加する。

```
+ "src/lib/db-repository.ts",
+ "src/config/system-directories.ts",
```

**影響範囲**: `npm run build:server` (tsc + tsc-alias) のコンパイル対象が増加する。`db-repository.ts` 内部の `@/types/clone` と `@/config/system-directories` の `@/` パスエイリアスは tsc-alias によって相対パスに変換される必要がある。`types/**/*.ts` は既に include に含まれているため `@/types/clone` は問題ない。`src/config/system-directories.ts` を明示的に追加することで tsc-alias の確実な動作を保証する。

---

## 2. 間接依存ファイル（変更不要）

| ファイル | 依存関係 | 変更要否 | 備考 |
|---------|----------|---------|------|
| `src/lib/db-repository.ts` | server.ts から直接 import | 不要 | 既存関数のシグネチャ・動作に変更なし |
| `src/config/system-directories.ts` | db-repository.ts 経由の間接依存 | 不要 | isSystemDirectory() は内部使用のみ |
| `src/types/clone.ts` | db-repository.ts の型参照 | 不要 | tsconfig.server.json の types/**/*.ts で既にカバー |
| `src/lib/worktrees.ts` | server.ts から既存 import | 不要 | scanMultipleRepositories(filteredPaths) の引数は string[] 型で互換 |
| `src/lib/db-instance.ts` | server.ts から既存 import | 不要 | getDbInstance() の返却型 Database.Database は新規関数の第1引数と互換 |

### 依存グラフ（修正後）

```
server.ts
  |-- [既存] src/lib/worktrees.ts (getRepositoryPaths, scanMultipleRepositories, syncWorktreesToDB)
  |-- [既存] src/lib/db-instance.ts (getDbInstance)
  |-- [既存] src/lib/db-migrations.ts (runMigrations)
  |-- [既存] src/lib/ws-server.ts (setupWebSocket, closeWebSocket)
  |-- [既存] src/lib/response-poller.ts (stopAllPolling)
  |-- [既存] src/lib/auto-yes-manager.ts (stopAllAutoYesPolling)
  |-- [既存] src/lib/env.ts (getEnvByKey)
  |-- [新規] src/lib/db-repository.ts (ensureEnvRepositoriesRegistered, filterExcludedPaths)
                |-- src/config/system-directories.ts (isSystemDirectory)
                |-- src/types/clone.ts (CloneJobStatus)
```

---

## 3. 影響を受けない関連ファイル

以下のファイルは `db-repository.ts` や除外フィルタリングに関連するが、本修正の影響を受けない。

| ファイル | 理由 |
|---------|------|
| `src/app/api/repositories/route.ts` (DELETE) | disableRepository() を使用して除外する**側**。本修正は除外された後の読み込み時フィルタリング |
| `src/app/api/repositories/excluded/route.ts` (GET) | getExcludedRepositories() で除外リストを返す読み取り専用API |
| `src/app/api/repositories/restore/route.ts` (PUT) | restoreRepository() で enabled=1 に復元。復元後は filterExcludedPaths() で除外されないため正常動作 |
| `src/app/api/repositories/clone/route.ts` (POST) | クローン操作は db-repository.ts の別関数を使用。除外フィルタリングとは無関係 |
| `src/lib/clone-manager.ts` | db-repository.ts の別関数群（createRepository, getRepositoryByNormalizedUrl 等）を使用。変更対象外 |
| `src/cli/commands/start.ts` | npm run start を spawn するだけ。initializeWorktrees() は server.ts 側で実行 |

---

## 4. テスト影響分析

### 4-1. 既存テストへの影響

| テストファイル | テスト数 | 影響 | アクション |
|-------------|---------|------|-----------|
| `tests/unit/lib/db-repository-exclusion.test.ts` | 38 | なし | 全パス確認 |
| `tests/integration/repository-exclusion.test.ts` | 9 | なし | 全パス確認 |
| `tests/unit/db-repository-clone.test.ts` | - | なし | 全パス確認 |
| `tests/unit/db-repository-delete.test.ts` | - | なし | 全パス確認 |
| `tests/integration/api-repository-delete.test.ts` | - | なし | 全パス確認 |

既存のユニットテストは `ensureEnvRepositoriesRegistered()` と `filterExcludedPaths()` の動作を網羅的にカバーしている（冪等性、パス正規化、除外フィルタリング、disabled上限チェック等）。server.ts 側の変更はこれらの既存関数を呼び出すだけであるため、既存テストへの影響はない。

### 4-2. テストギャップ

server.ts の `initializeWorktrees()` は `app.prepare().then()` コールバック内のクロージャであり、外部からのアクセスが不可能なためユニットテストが困難。この問題は Stage 1 レビューの SF-002 で指摘済みであり、設計方針書 Section 10 で手動テストシナリオとフォローアップ Issue（関数抽出によるテスト可能性改善）が定義されている。

---

## 5. ビルド影響分析

| ビルドコマンド | 影響 | リスク | 検証方法 |
|-------------|------|-------|---------|
| `npm run build:server` | tsconfig.server.json の変更により db-repository.ts と system-directories.ts がコンパイル対象に追加。tsc-alias が @/ パスエイリアスを解決 | Low | コマンド実行で成功を確認 |
| `npm run build` | sync/route.ts のコメント追加のみ。ランタイム動作に影響なし | Low | コマンド実行で成功を確認 |
| `npm run build:cli` | 影響なし | None | 検証不要 |

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | tsconfig.server.json の tsc-alias パス変換が正しく動作しない可能性 | Low | Low | P3 |
| 技術的リスク | server.ts と sync/route.ts の除外フィルタリングフローの乖離（DRY違反） | Med | Low | P2 (フォローアップ) |
| 波及リスク | scan/route.ts が除外チェックなしで個別リポジトリをスキャンする経路 | Med | Low | P2 (フォローアップ) |
| 運用リスク | worktree別サーバー間で除外状態が同期されない | Low | Low | P3 |

---

## 7. 指摘事項

### Should Fix

#### SF-IA-001: scan/route.ts のフィルタリング未適用経路

- **カテゴリ**: 影響範囲
- **重要度**: medium
- **内容**: `POST /api/repositories/scan` (`src/app/api/repositories/scan/route.ts`) は個別のリポジトリパスを受け取り、`filterExcludedPaths()` を経由せずに `scanWorktrees()` -> `syncWorktreesToDB()` を直接呼び出している。ユーザーが削除済みリポジトリのパスを手動で指定した場合、除外状態を無視してワークツリーがDBに再登録される可能性がある。
- **リスク評価**: この経路はUI上の明示的な操作（手動パス入力）が必要であり、自動的な復活ではないためリスクは限定的。
- **推奨対応**: 本 Issue のスコープ外だが、以下のいずれかをフォローアップ Issue で検討すること。
  - (A) scan/route.ts に除外チェック（`getRepositoryByPath()` で `enabled=0` かを確認）を追加
  - (B) scan は意図的な操作であるため除外を無視する仕様として明文化

#### SF-IA-002: tsconfig.server.json の tsc-alias パス変換依存

- **カテゴリ**: 影響範囲
- **重要度**: low
- **内容**: `db-repository.ts` は `@/types/clone` と `@/config/system-directories` を `@/` パスエイリアスで import している。`npm run build:server` は tsc + tsc-alias を使用しており、明示的な include 追加がパス変換の確実な動作保証に必要。
- **推奨対応**: 設計書通りに明示的に include へ追加する方針を維持し、ビルド成功を `npm run build:server` で必ず検証すること。

### Consider

#### C-IA-001: worktree別サーバーでの影響

CLI の `commandmate start --issue` オプションにより worktree 別サーバーが起動可能。各インスタンスは独自の DB を持つため、メインサーバーでの削除操作が worktree 別サーバーには反映されない。本 Issue のスコープ外であり、必要に応じてフォローアップで検討する。

#### C-IA-002: restore/route.ts との整合性

`PUT /api/repositories/restore` は `restoreRepository()` で `enabled=1` に復元した後、`scanWorktrees()` -> `syncWorktreesToDB()` を直接呼び出す。復元は意図的な操作であるため `filterExcludedPaths()` を通さないのは正しい設計。server.ts 修正後も正しく動作する。

#### C-IA-003: clone-manager.ts の依存

`src/lib/clone-manager.ts` は `db-repository.ts` から複数の関数を import しているが、本修正で変更される関数とは異なるため影響なし。

---

## 8. 承認判定

| 基準 | 評価 |
|------|------|
| 影響範囲が正確に特定されているか | PASS: 直接変更4ファイル、間接依存5ファイル、非影響6ファイルを特定 |
| 既存テストへの破壊的影響がないか | PASS: 既存テストへの影響なし |
| ビルドへの破壊的影響がないか | PASS: 設計方針通りの tsconfig.server.json 修正で対応 |
| 波及効果が管理可能か | PASS: 影響範囲は限定的 |
| 未対応の影響経路があるか | CONDITIONAL: scan/route.ts のフィルタリング未適用経路あり（フォローアップ推奨） |

**結論**: 条件付き承認 (conditionally_approved)。scan/route.ts のフィルタリング未適用経路については、フォローアップ Issue での対応を推奨する。本 Issue のスコープ内での変更は影響範囲が限定的かつ低リスクであり、実装に進めて問題ない。

---

*Generated by architecture-review-agent for Issue #202 Stage 3*
*Date: 2026-02-09*
*Focus: 影響範囲 (Impact Scope)*
