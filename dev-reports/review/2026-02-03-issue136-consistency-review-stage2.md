# Architecture Review Report: Issue #136 - Stage 2 (Consistency Review)

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #136 - Git Worktree 並列開発環境の整備 |
| Focus Area | 整合性 (Consistency) |
| Stage | 2 of 4 (Multi-stage Design Review) |
| Status | **Conditionally Approved** |
| Score | 3/5 |
| Date | 2026-02-03 |

本レビューでは、設計書と既存コードの整合性、設計書内部の整合性、CLAUDE.md との整合性を検証した。主要な型定義（ExternalApp、DaemonManager）において既存実装との不一致が発見された。実装開始前にこれらの不整合を解消する必要がある。

---

## Detailed Findings

### Must Fix (3 items)

#### MF-CONS-001: ExternalApp 型定義の不一致

**カテゴリ**: 設計書と既存コードの整合性
**影響度**: High

**問題点**:
設計書の ExternalApp 型定義と既存実装が大きく異なる。

| 項目 | 設計書 (Section 5.2) | 既存実装 (src/types/external-apps.ts) |
|------|---------------------|--------------------------------------|
| id | `number` | `string` (UUID) |
| port | `port: number` | `targetPort: number` |
| appType | `'local' \| 'docker'` | `'sveltekit' \| 'streamlit' \| 'nextjs' \| 'other'` |
| targetHost | なし | `targetHost: string` |
| websocket関連 | なし | `websocketEnabled`, `websocketPathPattern` |

**既存実装コード** (`src/types/external-apps.ts:16-55`):
```typescript
export interface ExternalApp {
  /** Unique identifier (UUID) */
  id: string;
  name: string;
  displayName: string;
  description?: string;
  pathPrefix: string;
  targetPort: number;
  targetHost: string;
  appType: ExternalAppType;  // 'sveltekit' | 'streamlit' | 'nextjs' | 'other'
  websocketEnabled: boolean;
  websocketPathPattern?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

**推奨対応**:
設計書の ExternalApp 型定義を既存実装に合わせて修正すること。WorktreeExternalApp は既存の ExternalApp を正しく extends する形に修正が必要。

---

#### MF-CONS-002: DaemonManager コンストラクタシグネチャの不整合

**カテゴリ**: 設計書と既存コードの整合性
**影響度**: High

**設計書 (Section 4.4)**:
```typescript
class DaemonManagerFactory {
  create(issueNo?: number): IDaemonManager {
    return new DaemonManager({
      pidPath,
      envPath,
      dbPath,
      issueNo,
    });
  }
}
```

**既存実装** (`src/cli/utils/daemon.ts:19-26`):
```typescript
export class DaemonManager {
  private pidManager: PidManager;
  private logger: CLILogger;

  constructor(pidFilePath: string) {
    this.pidManager = new PidManager(pidFilePath);
    this.logger = new CLILogger();
  }
```

**既存利用箇所** (`src/cli/commands/start.ts:37`):
```typescript
const daemonManager = new DaemonManager(pidFilePath);
```

**推奨対応**:
1. 既存の `DaemonManager(pidFilePath: string)` シグネチャを維持
2. Factory パターンで新しいオプションベースの生成メソッドを提供
3. 内部で pidPath 以外の設定は別途注入する設計を検討
4. 後方互換性維持の方針を設計書に明記

---

#### MF-CONS-003: getDefaultDbPath() 重複実装が既に存在

**カテゴリ**: 依存関係の整合性
**影響度**: High

**設計書の記載 (Section 4.1)**:
> **前提条件（MF-001対応）**: 実装前に `getDefaultDbPath()` を `db-path-resolver.ts` に一元化する。`env-setup.ts` からは `db-path-resolver.ts` をimportして使用する形にリファクタリングを先行実施すること。

**現状の実装**:

`src/cli/utils/env-setup.ts:45-68`:
```typescript
/**
 * Get the default database path based on install type
 * Issue #135: Dynamic DB path resolution
 *
 * Note: This is a local implementation to avoid circular imports.
 * The canonical implementation is in src/lib/db-path-resolver.ts.
 * Both implementations must remain in sync.
 */
export function getDefaultDbPath(): string {
  if (isGlobalInstall()) {
    return join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  return join(cwd, 'data', 'cm.db');
}
```

`src/lib/db-path-resolver.ts:12-13`:
```typescript
import { isGlobalInstall } from '../cli/utils/env-setup';
```

**問題の本質**:
- `db-path-resolver.ts` は `env-setup.ts` から `isGlobalInstall()` をインポート
- `env-setup.ts` が `db-path-resolver.ts` をインポートすると循環参照が発生
- 現状は意図的に重複実装で回避している

**推奨対応**:
1. `isGlobalInstall()` を共通モジュール（例: `src/cli/utils/install-detector.ts`）に抽出
2. 両ファイルが共通モジュールをインポートする形に変更
3. `getDefaultDbPath()` を `db-path-resolver.ts` に一元化
4. この循環参照解消方針を設計書に明記

---

### Should Fix (5 items)

#### SF-CONS-001: StopOptions, StatusOptions の既存型定義との差異

**カテゴリ**: インターフェース整合性
**影響度**: Medium

**設計書 (Section 5.2)**:
```typescript
export interface StopOptions {
  force?: boolean;
  issue?: number;  // 追加
}

export interface StatusOptions {
  issue?: number;  // 追加
}
```

**既存実装** (`src/cli/types/index.ts:44-47`):
```typescript
export interface StopOptions {
  /** Force stop (SIGKILL) */
  force?: boolean;
}
```

**推奨対応**:
- `issue` オプション追加に伴う `stop.ts`, `status.ts` への変更箇所を影響範囲 (Section 11.1) に追記
- commander の option 定義変更も必要であることを明記

---

#### SF-CONS-002: Migration #16 の定義不足

**カテゴリ**: 設計書内の整合性
**影響度**: Medium

**設計書 (Section 5.1)**:
```sql
-- Migration #16
ALTER TABLE external_apps ADD COLUMN issue_no INTEGER;
CREATE INDEX IF NOT EXISTS idx_external_apps_issue_no ON external_apps(issue_no);
```

**既存スキーマ** (`src/lib/db-migrations.ts:492-524`):
- Migration #12 で `external_apps` テーブル作成済み
- カラム: `target_port`, `target_host`, `app_type` (CHECK制約あり)

**問題点**:
- 設計書の型定義 (`port`) と既存DB (`target_port`) が不一致
- `app_type` のCHECK制約が `'sveltekit' | 'streamlit' | 'nextjs' | 'other'` であり、設計書の `'local' | 'docker'` と異なる

**推奨対応**:
- Migration #16 は `issue_no INTEGER` カラム追加のみとして明確化
- 既存スキーマとの整合性を設計書に明記
- 型定義を既存DBスキーマに合わせて修正

---

#### SF-CONS-003: CreateExternalAppInput の既存定義との差異

**カテゴリ**: インターフェース整合性
**影響度**: Medium

**既存定義** (`src/types/external-apps.ts:60-87`):
```typescript
export interface CreateExternalAppInput {
  name: string;
  displayName: string;
  description?: string;
  pathPrefix: string;
  targetPort: number;
  targetHost?: string;
  appType: ExternalAppType;
  websocketEnabled?: boolean;
  websocketPathPattern?: string;
}
```

**設計書の定義** (簡略化されている):
```typescript
export interface CreateExternalAppInput {
  name: string;
  displayName: string;
  description?: string;
  appType: 'local' | 'docker';
  port: number;
  pathPrefix: string;
  enabled?: boolean;
}
```

**推奨対応**:
`CreateWorktreeExternalAppInput` は既存の `CreateExternalAppInput` を正しく extends し、`issueNo` のみを追加する形に設計書を修正。

---

#### SF-CONS-004: ブランチ戦略変更の詳細不足

**カテゴリ**: CLAUDE.md との整合性
**影響度**: Medium

**設計書 (Section 1.2)**:
> ブランチ戦略の変更（main <- develop <- feature/*）

**CLAUDE.md の現状**:
```
main (本番) <- PRマージのみ
  |
feature/*, fix/*, hotfix/* (作業ブランチ)
```

**推奨対応**:
- NTH-002 で段階的導入を検討としているが、Phase 1 で実施するかどうかを明確化
- 実施する場合、CLAUDE.md の更新内容（ブランチ構成、標準マージフロー、コミットメッセージ規約への影響）を具体的に記載
- CI/CD (`ci-pr.yml`) の変更内容を詳細化

---

#### SF-CONS-005: ResourcePathResolver の validate メソッドの例外処理

**カテゴリ**: 設計書内の整合性
**影響度**: Medium

**設計書 (Section 4.1)**:
```typescript
validate(path: string): boolean {
  const configDir = getConfigDir();
  const resolved = fs.realpathSync(path);  // ファイルが存在しない場合 ENOENT
  return resolved.startsWith(configDir);
}
```

**推奨対応**:
新規ファイル作成時（DBファイル初期化など）のバリデーションロジックを考慮し、以下のいずれかを採用:
1. `existsSync` チェック後に `realpathSync` を呼び出す
2. 親ディレクトリの存在確認でパストラバーサルを検証
3. try-catch で ENOENT を適切に処理

---

### Consider (3 items)

| ID | 内容 | 推奨 |
|----|------|------|
| NTH-CONS-001 | ポート範囲 3001-3100 の根拠が未記載 | 範囲選定理由を追記 |
| NTH-CONS-002 | Issue #135 の完了状態が不明確 | 依存関係の現状を確認・更新 |
| NTH-CONS-003 | Facade/Command でのログ出力方針が未記載 | CLILogger 注入方針を追記 |

---

## Consistency Matrix

### 設計書 vs 既存実装

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| ExternalApp型 | id: number, port: number | id: string, targetPort: number | **不一致** |
| DaemonManager | オプションオブジェクト | 文字列引数 | **不一致** |
| getDefaultDbPath | 一元化予定 | 重複実装（循環参照回避） | **部分的不一致** |
| PidManager | O_EXCL使用 | O_EXCL使用 | 整合 |
| CLI Types | issue オプション追加 | issue オプションなし | **部分的不一致** |

### 設計書内部

| 設計項目 | セクション | 整合性 |
|---------|-----------|--------|
| 型定義とDBスキーマ | 5.1 vs 5.2 | **不一致** (port vs targetPort) |
| 入力型と基本型 | 5.2 | **部分的不一致** |
| フェーズ間の依存 | 13 | 整合 |
| セキュリティ設計 | 7 | 整合 |

### 設計書 vs CLAUDE.md

| 設計項目 | 整合性 | 備考 |
|---------|--------|------|
| ブランチ戦略 | **部分的不一致** | develop導入未反映 |
| コーディング規約 | 整合 | TypeScript, Strategy等 |
| モジュール構成 | 整合 | 新規ファイルパス適切 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 型定義不整合による実装時の混乱 | Medium | High | P1 |
| 技術的リスク | 循環参照問題の未解決 | Medium | Medium | P1 |
| 運用リスク | 既存コマンドとの後方互換性 | Medium | Low | P2 |
| セキュリティリスク | パス検証ロジックの不完全性 | Low | Low | P3 |

---

## Recommendations Summary

### 実装開始前に必須 (Must Fix)

1. **ExternalApp型定義の修正** (MF-CONS-001)
   - 既存実装の型定義に合わせて設計書を更新
   - `WorktreeExternalApp extends ExternalApp` の形式を維持

2. **DaemonManager設計の再検討** (MF-CONS-002)
   - 既存シグネチャとの後方互換性を維持する方針を明記
   - Factory パターンでの新機能追加方法を詳細化

3. **循環参照解消方針の明記** (MF-CONS-003)
   - `isGlobalInstall()` の共通モジュール化を Phase 0 に追加
   - 具体的なリファクタリング手順を設計書に追記

### 実装中に対応 (Should Fix)

- CLI型定義の影響範囲を Section 11.1 に追記
- Migration #16 の詳細を明確化
- ブランチ戦略変更の具体的な実施判断

---

## Approval Status

**Status**: Conditionally Approved

**条件**:
1. MF-CONS-001, MF-CONS-002, MF-CONS-003 の3項目を設計書に反映すること
2. 反映後、Stage 3（影響範囲分析）に進むことを推奨

---

*Generated by Architecture Review Agent*
*Review Date: 2026-02-03*
*Reviewer Focus: Consistency (整合性)*
