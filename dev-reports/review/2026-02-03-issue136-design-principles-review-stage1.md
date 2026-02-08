# Architecture Review Report: Issue #136 - Stage 1

## Executive Summary

| Item | Value |
|------|-------|
| Issue | #136 - Git Worktree 並列開発環境の整備 |
| Review Stage | Stage 1: 通常レビュー |
| Focus Area | 設計原則 (SOLID/KISS/YAGNI/DRY) |
| Status | **Conditionally Approved** |
| Score | 4/5 |
| Reviewer | Architecture Review Agent |
| Date | 2026-02-03 |

**Summary**: 設計方針書は全体的に良く構成されており、Strategy/Factory/Facade パターンの適用は適切です。ただし、DRY 原則に関する既存の問題（getDefaultDbPath() の重複実装）の解決が不十分であり、新機能追加時にこの問題が拡大する懸念があります。また、WorktreeSetupFacade の責務範囲が広すぎる点と、ExternalApp インターフェースへの issueNo フィールド追加による ISP 違反の懸念について対応が必要です。

---

## Detailed Findings

### Must Fix (2 items)

#### MF-001: getDefaultDbPath() 重複実装の拡大リスク (DRY)

**Severity**: High

**Location**: 設計書 4.1 Strategy パターン / 11.1 変更対象ファイル

**Description**:
現在 `env-setup.ts` と `db-path-resolver.ts` に同一ロジックの `getDefaultDbPath()` が存在する問題が継続しています。設計書では Issue #136 で `getIssueDbPath()` を追加する計画ですが、この設計のままでは両ファイルに同様の拡張が必要となり、重複がさらに拡大します。

**Current State**:
```typescript
// src/cli/utils/env-setup.ts (lines 57-68)
export function getDefaultDbPath(): string {
  if (isGlobalInstall()) {
    return join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  const cwd = process.cwd();
  return join(cwd, 'data', 'cm.db');
}

// src/lib/db-path-resolver.ts (lines 31-36)
export function getDefaultDbPath(): string {
  if (isGlobalInstall()) {
    return path.join(homedir(), '.commandmate', 'data', 'cm.db');
  }
  return path.resolve(process.cwd(), 'data', 'cm.db');
}
```

**Recommendation**:
Issue #136 の実装前に、以下のリファクタリングを実施すべきです:

1. `db-path-resolver.ts` を唯一の DB パス解決モジュールとして確立
2. `env-setup.ts` からは `db-path-resolver.ts` を import して使用
3. 循環参照を避けるため、`isGlobalInstall()` を共通モジュールに抽出

```typescript
// Proposed: src/lib/db-path-resolver.ts
import { isGlobalInstall } from '@/lib/install-detector';

export function getDefaultDbPath(): string { /* ... */ }
export function getIssueDbPath(issueNo: number): string { /* ... */ }

// src/cli/utils/env-setup.ts
import { getDefaultDbPath } from '@/lib/db-path-resolver';
// Remove duplicate implementation
```

---

#### MF-002: WorktreeSetupFacade の責務過多 (SRP)

**Severity**: High

**Location**: 設計書 4.3 Facade パターン

**Description**:
設計書の `WorktreeSetupFacade` は以下の5つの異なるサブシステムを統合しています:

1. `portAllocator.allocate()` - ポート割り当て
2. `worktreeCreator.create()` - Worktree 作成
3. `envGenerator.generate()` - 環境設定ファイル生成
4. `externalAppRegistrar.register()` - External App 登録
5. `serverStarter.start()` - サーバー起動

これらは異なるライフサイクル（ポート割り当ては永続、サーバー起動は一時的）を持つため、単一クラスでの管理は SRP 違反となり、テスト困難性やエラーハンドリングの複雑化を招きます。

**Recommendation**:
Facade 内部の各ステップを独立した Command パターンで実装し、Facade はオーケストレーションのみを担当するよう分離を検討してください:

```typescript
// Proposed structure
interface SetupStep {
  execute(context: SetupContext): Promise<SetupContext>;
  rollback(context: SetupContext): Promise<void>;
}

class WorktreeSetupOrchestrator {
  private steps: SetupStep[] = [
    new AllocatePortStep(),
    new CreateWorktreeStep(),
    new GenerateEnvStep(),
    new RegisterExternalAppStep(),
    new StartServerStep(),
  ];

  async setup(issueNo: number): Promise<WorktreeSetupResult> {
    // Execute steps with rollback on failure
  }
}
```

---

### Should Fix (4 items)

#### SF-001: ResourcePathResolver インターフェースの実装不足 (OCP)

**Severity**: Medium

**Location**: 設計書 4.1 Strategy パターン

**Description**:
設計書で `ResourcePathResolver` インターフェースを定義していますが、`DbPathResolver` のみが例示されています。PID パス、ログパスの Resolver 実装が明示されておらず、OCP に従った拡張性の確保が不十分です。

**Recommendation**:
以下の Resolver 実装を設計に追加してください:

```typescript
class PidPathResolver implements ResourcePathResolver {
  resolve(issueNo?: number): string {
    if (issueNo) {
      return path.join(getConfigDir(), 'pids', `${issueNo}.pid`);
    }
    return path.join(getConfigDir(), '.commandmate.pid');
  }
}

class LogPathResolver implements ResourcePathResolver {
  resolve(issueNo?: number): string {
    if (issueNo) {
      return path.join(getConfigDir(), 'logs', String(issueNo));
    }
    return path.join(getConfigDir(), 'logs', 'default');
  }
}
```

---

#### SF-002: CLI コマンドと DaemonManager の直接依存 (DIP)

**Severity**: Medium

**Location**: 設計書 6.1 CLI コマンド / `src/cli/commands/start.ts`

**Description**:
現在の `start.ts` は `DaemonManager` を直接インスタンス化しています:

```typescript
// src/cli/commands/start.ts (line 37)
const daemonManager = new DaemonManager(pidFilePath);
```

Issue #136 で `--issue` フラグを追加する際、Issue 番号に応じた PID ファイルパスの解決ロジックが `DaemonManager` コンストラクタ呼び出し前に必要となり、依存関係が複雑化します。

**Recommendation**:
Factory パターンを導入して、Issue 番号に基づく動的なパス解決を容易にしてください:

```typescript
// Proposed
class DaemonManagerFactory {
  static create(options?: { issue?: number }): DaemonManager {
    const pidPath = options?.issue
      ? getPidFilePath(options.issue)
      : getPidFilePath();
    return new DaemonManager(pidPath);
  }
}
```

---

#### SF-003: ポート管理の二重システム可能性 (KISS)

**Severity**: Medium

**Location**: 設計書 8.2 キャッシュ戦略 / 9.1 採用した設計

**Description**:
設計書 9.1 で DB ベースポート管理を採用しつつ、8.2 で `worktree-ports.json` をキャッシュ用途として言及しています:

> ポートマッピング: worktree-ports.json（オプション、キャッシュ用途のみ）

External Apps テーブルとキャッシュファイルの両方でポート情報を管理すると、同期問題が発生しやすくなります。

**Recommendation**:
- キャッシュファイルの必要性を再検討
- DB を Single Source of Truth として一本化
- キャッシュが必要な場合は、更新タイミング・無効化ルールを明確に定義

---

#### SF-004: ExternalApp インターフェースへの issueNo フィールド追加 (ISP)

**Severity**: Medium

**Location**: 設計書 5.2 型定義拡張

**Description**:
設計書で `ExternalApp` に `issueNo?: number` を追加する設計ですが、Issue と関連しない通常の External App にとっては不要なフィールドとなり、ISP (Interface Segregation Principle) 違反の懸念があります。

```typescript
// 設計書の提案
export interface ExternalApp {
  // ... 既存フィールド
  issueNo?: number; // <- Issue と関連しない External App には不要
}
```

**Recommendation**:
以下のいずれかの方法で対応を検討してください:

1. **派生型を定義**: `WorktreeExternalApp extends ExternalApp`
2. **別テーブルで管理**: `worktree_external_apps` マッピングテーブルを作成
3. **Discriminated Union**: `type ExternalApp = StandardExternalApp | WorktreeExternalApp`

---

### Nice to Have (3 items)

#### NTH-001: ログディレクトリの Issue 別分離 (YAGNI)

**Location**: 設計書 2.2 ディレクトリ構成

設計書でログを Issue 別ディレクトリに分離する設計ですが、現時点でログの Issue 別管理が必要かどうかは不明確です。ログファイル名に Issue 番号を含めるだけで十分な可能性があります。

**Recommendation**: Phase 2 実装前にログの分離粒度を再検討。ディレクトリ分離は運用要件が明確になってから追加しても遅くありません。

---

#### NTH-002: develop ブランチ導入の複雑性 (KISS)

**Location**: 設計書 9.1 / 9.2 ブランチ戦略

設計書で develop ブランチ導入を決定していますが、現在のトランクベース開発からの移行は CI/CD の変更、マージ戦略の変更など影響が大きいです。並列開発の実現には必須ではない可能性があります。

**Recommendation**: develop ブランチなしで feature/* から main への直接 PR でも並列 worktree 開発は可能です。ブランチ戦略変更は別 Issue で段階的に導入することを検討してください。

---

#### NTH-003: Claude Code スキルの重複処理 (DRY)

**Location**: 設計書 11.2 新規作成ファイル

`/worktree-setup` と `/worktree-cleanup` スキルを新規作成しますが、これらのスキル内で実行される処理が CLI コマンドと重複する可能性があります。

**Recommendation**: スキルは CLI コマンドを呼び出すラッパーとして実装し、ビジネスロジックの重複を避けてください。

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Medium | DRY 違反の継続により、保守性が低下する可能性 |
| Security | Low | セキュリティ設計（パストラバーサル対策、ポート範囲制限）は適切 |
| Operational | Medium | develop ブランチ導入による CI/CD 変更の影響 |

---

## Design Principles Checklist

| Principle | Status | Notes |
|-----------|--------|-------|
| Single Responsibility | Partial | WorktreeSetupFacade の責務が広すぎる。db-path-resolver.ts は適切に分離されている |
| Open/Closed | Partial | Strategy パターンの採用は良いが、具体的な Resolver 実装が不足 |
| Liskov Substitution | OK | ResourcePathResolver インターフェースは LSP に適合した設計 |
| Interface Segregation | Concern | ExternalApp への issueNo 追加は既存利用者に不要なフィールドを強制 |
| Dependency Inversion | Partial | CLI コマンドが具象クラスに直接依存。抽象化の余地あり |
| KISS | Partial | DB とキャッシュファイルの二重管理、develop ブランチ導入など複雑性あり |
| YAGNI | OK | パフォーマンス設計は現実的な範囲内 |
| DRY | Concern | getDefaultDbPath() の重複が継続し、拡張時にさらに悪化する懸念 |

---

## Recommendations Summary

### Before Implementation

1. **MF-001**: `getDefaultDbPath()` の重複実装を解消するリファクタリングを先行実施
2. **SF-003**: `worktree-ports.json` キャッシュの必要性を再検討

### During Implementation

1. **MF-002**: WorktreeSetupFacade を Command パターンで分解
2. **SF-001**: PidPathResolver, LogPathResolver の具体的なクラス設計を追加
3. **SF-002**: DaemonManagerFactory の導入
4. **SF-004**: ExternalApp の型設計を再検討

### Future Consideration

1. **NTH-002**: develop ブランチ導入は別 Issue で段階的に
2. **NTH-003**: スキルは CLI コマンドのラッパーとして実装

---

## Approval Status

**Status**: Conditionally Approved

**Conditions**:
1. MF-001 (DRY 違反) の解決方針を設計書に追記すること
2. MF-002 (WorktreeSetupFacade の責務分離) について、具体的な分離方針を決定すること

上記条件が満たされれば、実装を開始して問題ありません。

---

## Reviewed Files

- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/design/issue-136-worktree-parallel-dev-design-policy.md`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/cli/utils/env-setup.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/cli/utils/pid-manager.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/db.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/cli/types/index.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/cli/commands/start.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/types/external-apps.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/db-path-resolver.ts`

---

*Generated by Architecture Review Agent - Stage 1: Design Principles Review*
