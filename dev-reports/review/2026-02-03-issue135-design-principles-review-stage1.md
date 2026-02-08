# Issue #135 Design Principles Review (Stage 1)

**Review Date**: 2026-02-03
**Stage**: 1 - 通常レビュー（設計原則）
**Design Document**: `dev-reports/design/issue-135-db-path-resolution-design-policy.md`
**Recommendation**: PROCEED_WITH_MINOR_CHANGES

---

## Executive Summary

Issue #135 の設計書は、グローバルインストール時のDBパス解決問題を解決するための包括的な設計を提示している。DRY原則と既存コードの再利用を重視した堅実な設計であり、Singletonパターンの維持、Facadeパターンの活用、セキュリティ設計の充実など多くの点で優れている。

一方で、Strategyパターンの導入についてはKISS原則の観点から再検討の余地があり、env.tsの責務拡大傾向についてはSRPの観点から改善が推奨される。

---

## Review Findings

### Must Fix (1件)

#### SOLID-DIP-001: Dependency Inversion Principle違反の認識

**重要度**: Medium

**説明**:
現在の`db-instance.ts`は`process.env`と`path.join(process.cwd())`に直接依存している。設計書では`getEnv()`経由に修正する方針だが、依然として具象モジュール(`env.ts`)に依存する形となる。

**現在のコード** (`src/lib/db-instance.ts:25`):
```typescript
const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
```

**設計書の提案**:
```typescript
const env = getEnv();
const dbPath = env.CM_DB_PATH;
```

**推奨事項**:
本来はDbPathProvider interfaceを定義し、依存注入できるようにすることでテスタビリティを向上させることが理想的。ただし、現プロジェクトの規模感ではオーバーエンジニアリングの可能性もあり、現行案でも許容範囲内。設計書に「将来的なテスタビリティ改善の余地」として記載することを推奨。

---

### Should Fix (3件)

#### DRY-001: isGlobalInstall()の呼び出し経路の複雑化

**重要度**: Medium

**説明**:
設計書では`db-path-resolver.ts`に`getDbPathStrategy()`を追加し、その中で`isGlobalInstall()`を使用する。一方、`isGlobalInstall()`は`env-setup.ts`に既存。import経路が複雑化する可能性がある。

**推奨事項**:
`isGlobalInstall()`を一箇所（`env-setup.ts`）に集約し、`db-path-resolver.ts`からはimportして使用することを設計書に明記する。依存関係図の追加を推奨。

---

#### KISS-001: Strategyパターンの必要性再検討

**重要度**: Medium

**説明**:
設計書では`GlobalInstallStrategy`と`LocalInstallStrategy`の2つのStrategyクラスを導入している（設計書 Section 4.2）：

```typescript
export class GlobalInstallStrategy implements DbPathStrategy {
  getDefaultPath(): string {
    return path.join(homedir(), '.commandmate', 'data', 'cm.db');
  }
}

export class LocalInstallStrategy implements DbPathStrategy {
  getDefaultPath(): string {
    return path.join(process.cwd(), 'data', 'cm.db');
  }
}
```

現時点でこれら以外の戦略が追加される見込みは低く、単純なif-elseで済む処理をStrategyパターンで実装することは過剰設計の恐れがある。

**推奨事項**:
以下のいずれかを選択：
1. 将来の拡張性（Docker環境用Strategy、CI環境用Strategy等）を設計書に明記
2. シンプルに関数ベースの実装に変更

```typescript
// シンプルな関数ベース実装の例
export function getDefaultDbPath(): string {
  if (isGlobalInstall()) {
    return path.join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  return path.resolve(process.cwd(), 'data', 'cm.db');
}
```

---

#### SRP-001: env.tsの責務拡大

**重要度**: Low

**説明**:
`env.ts`は環境変数の取得・バリデーションを担当しているが、設計書では以下の関数も追加される予定：
- `getDatabasePathWithDeprecationWarning()`
- `validateDbPath()`

環境変数管理とDBパス解決という2つの責務を持つことになる。

**推奨事項**:
DBパス解決ロジックは`db-path-resolver.ts`に完全に分離し、`env.ts`は純粋に環境変数の取得・バリデーションに集中させる。`env.ts`の`getEnv()`は`db-path-resolver`の関数を呼び出す形にする。

---

### Nice to Have (3件)

#### OCP-001: マイグレーション検出パスのハードコード

設計書 Section 9.2 の`getLegacyDbPaths()`では旧DBパスをハードコードしている。将来新たな旧形式が発見された場合、コード修正が必要となる。ただし、マイグレーションは一時的な機能であり、過度な拡張性は不要な可能性もある。

#### YAGNI-001: DATABASE_PATHのフォールバック維持の必要性

`DATABASE_PATH`は Issue #77 以前の旧仕様であり、現在のユーザーベースで使用されている可能性は低い。`CM_DB_PATH`/`MCBD_DB_PATH`のフォールバック（Issue #76）で十分な可能性がある。後方互換性を重視する方針であれば現設計で問題なし。

#### DRY-002: path.resolve()の呼び出し重複

複数箇所で`path.resolve()`を呼び出して絶対パス化している。絶対パス変換の責務を一箇所に集約することを推奨。

---

## Positive Aspects

### POS-001: Singletonパターンの適切な維持

DBインスタンスのSingleton管理は維持される設計であり、リソース管理として適切。`getDbInstance()`のインターフェースを変更せずに内部実装のみを修正する方針は既存コードへの影響を最小化する。

### POS-002: 既存フォールバック機構の再利用

Issue #76 で実装された`getEnvWithFallback()`/`getEnvByKey()`を再利用する設計はDRY原則に則っており、コードの重複を避けている。

### POS-003: Facadeパターンの活用

`getEnv()`をFacadeとして使用し、パス解決の複雑さを隠蔽する設計は、呼び出し側のコードをシンプルに保つ。

### POS-004: マイグレーション設計の充実

旧DBからの自動マイグレーション設計（Section 9）は、ユーザー体験を損なわずにアップグレードを実現する配慮がある。バックアップ作成の設計も適切。

### POS-005: セキュリティ設計の整合性

既存の`resolveSecurePath()`を活用したパストラバーサル対策、OWASP Top 10への対応が設計書に明記されており、Issue #125との一貫性がある。

---

## Current Implementation Analysis

### db-instance.ts (現状)

```typescript
// src/lib/db-instance.ts:23-25
export function getDbInstance(): Database.Database {
  if (!dbInstance) {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
```

**問題点**:
1. `process.env.DATABASE_PATH`を直接参照（env.ts経由でない）
2. `process.cwd()`に依存（グローバルインストール時に予測不能）
3. `CM_DB_PATH`ではなく旧名称`DATABASE_PATH`を参照
4. ファイル名が`db.sqlite`（Issue #77以降は`cm.db`）

### env.ts (現状)

```typescript
// src/lib/env.ts:169-171
const databasePath = getEnvByKey('CM_DB_PATH')
  || process.env.DATABASE_PATH
  || path.join(process.cwd(), 'data', 'cm.db');
```

**良い点**:
- `getEnvByKey()`を使用（CM_*/MCBD_*フォールバック対応）
- `DATABASE_PATH`のレガシーサポートあり

**問題点**:
- `process.cwd()`に依存（グローバルインストール時に予測不能）
- `DATABASE_PATH`使用時の警告なし

### env-setup.ts (現状)

```typescript
// src/cli/utils/env-setup.ts:28-34
export const ENV_DEFAULTS = {
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  CM_DB_PATH: './data/cm.db',  // 相対パス
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
} as const;
```

**問題点**:
- `CM_DB_PATH`が相対パス（`.env`に書き込まれる値）
- グローバルインストール時も相対パスが使用される

---

## Next Actions

1. **Strategyパターンの必要性を再評価**: シンプルな関数ベース実装への変更を検討
2. **env.tsとdb-path-resolver.tsの責務分離を明確化**: 設計書の依存関係図を更新
3. **isGlobalInstall()のimport経路を設計書に明記**: モジュール間の依存関係を可視化

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `dev-reports/design/issue-135-db-path-resolution-design-policy.md` | 設計書 |
| `src/lib/db-instance.ts` | DBインスタンスSingleton |
| `src/lib/env.ts` | 環境変数管理 |
| `src/cli/utils/env-setup.ts` | CLI環境セットアップ |
| `src/cli/commands/init.ts` | initコマンド |

---

*Generated by architecture-review-agent (Stage 1: Design Principles Review)*
