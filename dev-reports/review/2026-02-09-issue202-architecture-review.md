# Architecture Review Report: Issue #202

## Executive Summary

| 項目 | 内容 |
|------|------|
| **Issue** | #202 サーバー再起動時の削除済みリポジトリ復活防止 |
| **Focus** | 設計原則 (Design Principles) |
| **Stage** | Stage 1 - 通常レビュー |
| **Status** | Conditionally Approved |
| **Score** | 4 / 5 |
| **Date** | 2026-02-09 |

Issue #202の設計方針書は、SOLID/KISS/YAGNI原則に概ね準拠しており、技術的リスクが低い修正方針を提示している。DRY原則に関してのみ条件付きの承認とし、フォローアップIssueの確実な作成を推奨する。

---

## Detailed Findings

### SOLID原則の評価

#### S - Single Responsibility Principle (単一責任原則): PASS

`initializeWorktrees()` はサーバー起動時のワークツリー初期化という単一責務を担う関数である。除外フィルタリングの追加は、この初期化処理の欠落ステップを補完するものであり、新たな責務の追加ではなく既存責務の正当な完成である。

除外ロジック自体は `db-repository.ts` の以下の独立関数に分離されている:

- `ensureEnvRepositoriesRegistered()` -- 登録責務 (MF-001)
- `filterExcludedPaths()` -- フィルタリング責務 (SF-003)
- `disableRepository()` -- 無効化責務 (SF-002)

各関数は明確な単一責任を持ち、設計書のSF-001/SF-002/SF-003タグで追跡されている。

#### O - Open/Closed Principle (開放閉鎖原則): PASS

`filterExcludedPaths()` は除外ロジックをカプセル化しており (SF-003)、呼び出し元の `server.ts` は除外の具体的判定ロジックを知らない。除外基準が将来変更された場合（例: パターンベース除外、一時的除外）、`filterExcludedPaths()` の内部のみを変更すれば良い。

`server.ts` の修正コード:
```typescript
// server.ts は除外の「方法」を知らない -- filterExcludedPaths() に委譲
const filteredPaths = filterExcludedPaths(db, repositoryPaths);
```

#### L - Liskov Substitution Principle: NOT APPLICABLE

本修正にはクラス継承やポリモーフィズムの使用がないため評価対象外。

#### I - Interface Segregation Principle (インターフェース分離原則): PASS

`db-repository.ts` は28個の関数をエクスポートしているが、`server.ts` が必要とするのは `ensureEnvRepositoriesRegistered` と `filterExcludedPaths` の2関数のみである。設計書のimport文も正確にこの2関数のみを指定している:

```typescript
import { ensureEnvRepositoriesRegistered, filterExcludedPaths } from './src/lib/db-repository';
```

#### D - Dependency Inversion Principle (依存性逆転原則): PASS

`server.ts` は `db-repository.ts` の具象関数に依存するが、`Database` 型は `better-sqlite3` のインスタンスとして注入されている。テストコードでは `:memory:` DBに差し替え可能であり、テスタビリティは確保されている:

```typescript
// テストコード (db-repository-exclusion.test.ts L29-31)
beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
});
```

---

### KISS原則の評価: PASS

設計方針の最大の強みは簡潔さにある。

1. **既存パターンの転写**: `sync/route.ts` (Issue #190) で実装済みの処理フローを `server.ts` に転写する方式を採用。新しい概念、パターン、抽象化の導入がない。

2. **最小変更量**: 修正は以下の3要素に限定される:
   - import文1行の追加
   - ビジネスロジック4行の追加 (register, filter, log, variable rename)
   - `tsconfig.server.json` への2ファイル追加

3. **代替案の適切な却下**: 設計書 Section 3 で3つの方式を比較し、方式A（既存関数の再利用）を選定した理由が明確。方式C（syncWorktreesToDB内部に除外ロジック追加）の却下理由として「単一責任原則違反」を正しく挙げている。

---

### YAGNI原則の評価: PASS

以下の判断がYAGNI原則に合致している:

1. **共通関数への抽出を見送り**: 2箇所の重複で直ちにリファクタリングするのではなく、バグ修正のスコープに留めている。

2. **ログレベル制御の見送り**: 除外がない場合はログを出力しない条件分岐のみとし、LOG_LEVELやDEBUGフラグの導入を行わない。

3. **拡張パターンの見送り**: 除外ロジックのStrategy パターン化など、現時点で不要な抽象化を行わない。

設計書 Section 3 の代替案比較テーブルでは、方式B（共通関数への抽出）を「スコープ拡大、リファクタリングリスク」として見送り、フォローアップIssue候補として明記している。この判断は妥当である。

---

### DRY原則の評価: CONDITIONAL PASS

**重複箇所の特定**:

`sync/route.ts` (L26-33):
```typescript
ensureEnvRepositoriesRegistered(db, repositoryPaths);
const filteredPaths = filterExcludedPaths(db, repositoryPaths);
const allWorktrees = await scanMultipleRepositories(filteredPaths);
syncWorktreesToDB(db, allWorktrees);
```

`server.ts` 設計書の修正後コード (Section 7-1):
```typescript
ensureEnvRepositoriesRegistered(db, repositoryPaths);
const filteredPaths = filterExcludedPaths(db, repositoryPaths);
const worktrees = await scanMultipleRepositories(filteredPaths);
syncWorktreesToDB(db, worktrees);
```

4ステップの呼び出しシーケンスが完全に重複する。特に注意すべきは、設計書 Section 4 で明記された **呼び出し順序制約** である:

> `ensureEnvRepositoriesRegistered()` を `filterExcludedPaths()` の **前** に呼び出す必要がある

この制約は暗黙的であり、コード上の強制力がない。将来いずれかの箇所を修正する際に、もう一方の箇所を更新し忘れるリスクがある。

**判断の妥当性**: 設計書はこの重複を認識し、Section 3 で明示的にトレードオフとして記載している。バグ修正のスコープでリファクタリングを行うことのリスク（既存テスト大幅修正、テスト不能なserver.tsのネスト構造）を正しく評価している。

**条件**: フォローアップIssueを確実に作成し、共通関数への抽出を後続タスクとして追跡すること。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 呼び出し順序制約の暗黙性による将来の保守ミス | Low | Low | P3 |
| セキュリティ | 新たなセキュリティリスクなし（既存対策を再利用） | Low | Low | - |
| 運用リスク | server.ts の initializeWorktrees() テスト困難性 | Low | Low | P3 |

### リスク詳細

**技術的リスク**: `ensureEnvRepositoriesRegistered()` -> `filterExcludedPaths()` の呼び出し順序が暗黙的である点。ただし、(1) 同一パターンが `sync/route.ts` にも存在しており参照実装がある、(2) 設計書 Section 4 で制約が文書化されている、(3) `filterExcludedPaths()` 自体が DB の `enabled` カラムを参照するため、未登録リポジトリは除外対象にならず「フィルタ漏れ」（= リポジトリが表示される）という可視的な不具合として顕在化する。従って影響度はLow。

**セキュリティ**: 既存のセキュリティ対策（`isSystemDirectory`、`resolveRepositoryPath`、null byte チェック、`MAX_DISABLED_REPOSITORIES` 制限）は `db-repository.ts` 内に実装済みであり、`server.ts` はこれらを呼び出すのみ。新たな入力経路の追加がないため、追加のセキュリティリスクは発生しない。

**運用リスク**: `initializeWorktrees()` が `app.prepare()` コールバック内にネストされているため、自動テストが困難。ただし、(1) ビジネスロジック部分（`ensureEnvRepositoriesRegistered`, `filterExcludedPaths`）は独立したユニットテストでカバー済み（`tests/unit/lib/db-repository-exclusion.test.ts` に38テストケース）、(2) 結合テスト（`tests/integration/repository-exclusion.test.ts`）で Exclusion -> Sync フローが検証済み。

---

## Improvement Recommendations

### 推奨改善項目 (Should Fix)

#### SF-001: DRY違反のフォローアップIssue作成

**原則**: DRY
**重要度**: Medium

server.ts と sync/route.ts のワークツリー初期化フロー（register -> filter -> scan -> sync）が重複している。設計書で認識済みだが、フォローアップIssueの作成を確実に行い、以下の共通関数の抽出を検討すべきである:

```typescript
// 提案: src/lib/worktree-initializer.ts
export async function initializeFilteredWorktrees(
  db: Database.Database,
  repositoryPaths: string[]
): Promise<{ worktrees: Worktree[]; excludedCount: number }> {
  ensureEnvRepositoriesRegistered(db, repositoryPaths);
  const filteredPaths = filterExcludedPaths(db, repositoryPaths);
  const excludedCount = repositoryPaths.length - filteredPaths.length;
  const worktrees = await scanMultipleRepositories(filteredPaths);
  syncWorktreesToDB(db, worktrees);
  return { worktrees, excludedCount };
}
```

#### SF-002: initializeWorktrees() のテスタビリティ向上

**原則**: テスト方針
**重要度**: Low

`initializeWorktrees()` 内のビジネスロジック部分を独立関数として抽出することで、テスト可能にすることを検討する。ただし、既存のユニットテスト・結合テストが個々の関数をカバーしているため、緊急性は低い。

### 検討事項 (Consider)

#### C-001: 除外フィルタリングの拡張性

将来的にパターンベース除外や一時的除外などの要件が追加された場合に備え、`filterExcludedPaths()` の拡張方針を検討する。現時点ではYAGNI原則に基づき対応不要。

#### C-002: ログ出力の条件分岐

除外数が0の場合にログを出力しない設計は適切だが、トラブルシューティング時に情報不足となる可能性がある。デバッグログレベルの導入はYAGNIに反するため現行維持を推奨。

---

## Design Principles Checklist Summary

| 原則 | 評価 | 備考 |
|------|------|------|
| Single Responsibility | PASS | initializeWorktrees()の責務は適切。除外関数は独立分離済み |
| Open/Closed | PASS | filterExcludedPaths()に除外ロジックがカプセル化 |
| Liskov Substitution | N/A | クラス継承なし |
| Interface Segregation | PASS | 必要な2関数のみimport |
| Dependency Inversion | PASS | Database型がテスト時に差し替え可能 |
| KISS | PASS | 既存パターンの転写、新概念の導入なし |
| YAGNI | PASS | 過度な抽象化を回避、最小限の修正 |
| DRY | CONDITIONAL PASS | 重複認識済み、フォローアップIssue要作成 |

---

## Approval Status

**Status: Conditionally Approved**

以下の条件を満たすことで承認:

1. DRY違反を解消するためのフォローアップIssueを作成すること（設計書 Section 3 で「フォローアップ Issue 候補」と記載済み）
2. 呼び出し順序制約（`ensureEnvRepositoriesRegistered` -> `filterExcludedPaths`）をインラインコメントで `server.ts` に残すこと（設計書の修正後コードにはIssue番号付きコメントが含まれており、概ね対応済み）

上記2点が対応されれば、設計書の方針に従って実装を進めて問題ない。

---

*Generated by architecture-review-agent*
*Date: 2026-02-09*
