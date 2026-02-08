# Issue #125 設計原則レビュー (Stage 1)

## 概要

| 項目 | 内容 |
|------|------|
| Issue | #125: グローバルインストール時の.env読み込み |
| レビューステージ | Stage 1: 通常レビュー |
| フォーカス | 設計原則 (SOLID, KISS, YAGNI, DRY) |
| 実施日 | 2026-02-02 |
| 総合評価 | 条件付き承認 |

---

## エグゼクティブサマリー

Issue #125の設計方針書をSOLID/KISS/YAGNI/DRY原則の観点からレビューした。設計方針は全体的に妥当であり、既存のコードベースにおける良い設計パターン（PidManagerの分離、ENV_DEFAULTSの集約など）を活かしている。

ただし、**DRY原則に関して2点の重要な改善が必要**である。

1. `getPidFilePath()`が3つのコマンドファイルで重複定義される設計
2. 環境変数読み込みの責務がstart.tsとdaemon.ts間で曖昧

これらを解消することで、より保守性の高い実装が可能となる。

---

## レビュー対象ファイル

| ファイル | 概要 |
|---------|------|
| `src/cli/commands/start.ts` | サーバー起動コマンド |
| `src/cli/commands/stop.ts` | サーバー停止コマンド |
| `src/cli/commands/status.ts` | サーバー状態確認コマンド |
| `src/cli/utils/daemon.ts` | デーモンプロセス管理 |
| `src/cli/utils/env-setup.ts` | 環境設定ユーティリティ |
| `src/cli/utils/pid-manager.ts` | PIDファイル管理（参照） |
| `src/cli/commands/init.ts` | 初期化コマンド（参照） |

---

## 必須改善項目 (Must Fix)

### MF-1: PID_FILE定数の重複 [DRY違反]

**重大度**: High

**場所**:
- `src/cli/commands/start.ts:17`
- `src/cli/commands/stop.ts:14`
- `src/cli/commands/status.ts:13`

**現状**:
```typescript
// start.ts, stop.ts, status.ts で同じコード
const PID_FILE = join(process.cwd(), '.commandmate.pid');
```

**設計書の方針**:
```typescript
// 各ファイルにgetPidFilePath()を追加
const getPidFilePath = (): string => join(getConfigDir(), '.commandmate.pid');
```

**問題点**:
設計書の方針では、`getPidFilePath()`を各ファイルに追加するとしているが、これも3箇所での重複定義となる。DRY原則に違反。

**推奨対応**:
```typescript
// src/cli/utils/env-setup.ts に追加
export function getPidFilePath(): string {
  return join(getConfigDir(), '.commandmate.pid');
}

// 各コマンドファイルでは import して使用
import { getPidFilePath } from '../utils/env-setup';
```

---

### MF-2: 環境変数読み込みの責務重複 [DRY違反]

**重大度**: High

**場所**:
- `src/cli/commands/start.ts:25-26`
- `src/cli/utils/daemon.ts:41-44`

**現状のstart.ts**:
```typescript
const envPath = join(process.cwd(), '.env');
if (!existsSync(envPath)) { ... }

// ...
const env: NodeJS.ProcessEnv = { ...process.env };
if (options.port) {
  env.CM_PORT = String(options.port);
}
```

**設計書のdaemon.ts修正方針**:
```typescript
// .envファイルを読み込み
const envPath = getEnvPath();
const envResult = dotenvConfig({ path: envPath });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...envResult.parsed,
};
```

**問題点**:
- start.tsとdaemon.tsの両方で.envパス取得と環境変数マージを行う設計
- 責務が曖昧で、どちらが.env読み込みの責任を持つか不明確

**推奨対応**:

**Option A: daemon.tsに責務を集約**
```typescript
// daemon.ts - 環境変数読み込みを担当
async start(options: StartOptions): Promise<number> {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) {
    throw new Error(`.env file not found at ${envPath}`);
  }
  const envResult = dotenvConfig({ path: envPath });
  // ...
}

// start.ts - 存在確認のみ（フォアグラウンド起動時）
const envPath = getEnvPath();
if (!existsSync(envPath)) {
  logger.error(`.env file not found at ${envPath}`);
  // ...
}
```

**Option B: 共通モジュール化**
```typescript
// src/cli/utils/env-loader.ts (新規)
export function loadEnvFile(): { env: NodeJS.ProcessEnv; path: string } {
  const envPath = getEnvPath();
  if (!existsSync(envPath)) {
    throw new EnvNotFoundError(envPath);
  }
  const result = dotenvConfig({ path: envPath });
  return {
    env: { ...process.env, ...result.parsed },
    path: envPath,
  };
}
```

---

## 推奨改善項目 (Should Fix)

### SF-1: startCommand()の責務過多 [SRP]

**重大度**: Medium

**場所**: `src/cli/commands/start.ts:22-141`

**問題点**:
- フォアグラウンド起動（84-126行）とデーモン起動（36-82行）の2つの異なるコードパスが混在
- 関数が120行を超えており、可読性が低下

**推奨対応**:
```typescript
async function startForeground(options: StartOptions): Promise<void> {
  // フォアグラウンド起動ロジック
}

async function startDaemon(options: StartOptions, daemonManager: DaemonManager): Promise<void> {
  // デーモン起動ロジック
}

export async function startCommand(options: StartOptions): Promise<void> {
  // 共通の前処理（.env確認など）
  if (options.daemon) {
    await startDaemon(options, daemonManager);
  } else {
    await startForeground(options);
  }
}
```

---

### SF-2: isGlobalInstall()のハードコードパターン [OCP]

**重大度**: Medium

**場所**: `src/cli/utils/env-setup.ts:46-58`

**現状**:
```typescript
export function isGlobalInstall(): boolean {
  const currentPath = dirname(__dirname);
  return (
    currentPath.includes('/lib/node_modules/') ||
    currentPath.includes('\\node_modules\\') ||
    currentPath.includes('/node_modules/commandmate')
  );
}
```

**問題点**:
新しいパッケージマネージャ（pnpm, yarn berry等）やインストール方式が追加された場合、関数本体を修正する必要がある。

**推奨対応**:
```typescript
const GLOBAL_INSTALL_PATTERNS = [
  '/lib/node_modules/',
  '\\node_modules\\',
  '/node_modules/commandmate',
] as const;

export function isGlobalInstall(): boolean {
  const currentPath = dirname(__dirname);
  return GLOBAL_INSTALL_PATTERNS.some(pattern => currentPath.includes(pattern));
}
```

**優先度**: 低（現時点のパターンは十分網羅的、YAGNI観点から緊急性なし）

---

### SF-3: DaemonManager直接依存 [DIP]

**重大度**: Medium

**場所**:
- `src/cli/commands/start.ts:33`
- `src/cli/commands/stop.ts:21`
- `src/cli/commands/status.ts:20`

**現状**:
```typescript
const daemonManager = new DaemonManager(PID_FILE);
```

**問題点**:
- 高レベルのコマンドモジュールが低レベルのDaemonManager具象クラスに直接依存
- テストでのモック差し替えが困難

**推奨対応**:
```typescript
// types/index.ts
export interface IDaemonManager {
  start(options: StartOptions): Promise<number>;
  stop(force?: boolean): Promise<boolean>;
  getStatus(): Promise<DaemonStatus | null>;
  isRunning(): Promise<boolean>;
}

// 依存性注入（テスト時に差し替え可能）
export async function startCommand(
  options: StartOptions,
  daemonManager?: IDaemonManager
): Promise<void> {
  const dm = daemonManager ?? new DaemonManager(getPidFilePath());
  // ...
}
```

**優先度**: 低〜中（CLIの単純なユースケースでは過度な抽象化となる可能性あり）

---

### SF-4: EnvSetupクラスの責務混在 [KISS]

**重大度**: Low

**場所**: `src/cli/utils/env-setup.ts:144-252`

**現状のEnvSetupクラス責務**:
1. .envファイル作成 (`createEnvFile`)
2. バックアップ作成 (`backupExisting`)
3. 認証トークン生成 (`generateAuthToken`)
4. 設定検証 (`validateConfig`)

**問題点**:
異なる粒度の責務が1つのクラスに混在している。

**推奨対応**:
現時点では動作に問題なし。将来的なリファクタリング候補として記録。

---

## 良い設計パターン

### GP-1: PidManagerの適切な分離 [SRP]

**場所**: `src/cli/utils/pid-manager.ts`

PidManagerクラスはPIDファイルの読み書きと削除という単一の責務のみを担当。DaemonManagerから適切に分離されており、コードコメント（SF-1）で設計意図も明記されている。

```typescript
/**
 * PID File Manager
 * Issue #96: npm install CLI support
 * SF-1: SRP - Separated from daemon.ts for single responsibility
 */
```

### GP-2: デフォルト値の集約 [DRY]

**場所**: `src/cli/utils/env-setup.ts:27-33`

```typescript
export const ENV_DEFAULTS = {
  CM_PORT: 3000,
  CM_BIND: '127.0.0.1',
  CM_DB_PATH: './data/cm.db',
  CM_LOG_LEVEL: 'info',
  CM_LOG_FORMAT: 'text',
} as const;
```

デフォルト値が一元管理されており、init.tsなど複数箇所から参照されている。

### GP-3: シンプルな条件分岐 [KISS]

**場所**: `src/cli/utils/env-setup.ts:66-93`

```typescript
export function getEnvPath(): string {
  if (isGlobalInstall()) {
    // ...
    return join(configDir, '.env');
  }
  return join(process.cwd(), '.env');
}
```

過度な抽象化を避け、シンプルな条件分岐で実装。

### GP-4: アトミックなPIDファイル書き込み [セキュリティ]

**場所**: `src/cli/utils/pid-manager.ts:61-83`

```typescript
// O_EXCL: Fail if file already exists (atomic check-and-create)
const fd = openSync(
  this.pidFilePath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
  0o600
);
```

TOCTOU競合状態を防止する適切な実装。

---

## 設計書との整合性

| 設計原則 | 状態 | 備考 |
|---------|------|------|
| 一貫性 | 適合 | 全CLIコマンドで同じ設定ファイル解決ロジックを使用 |
| 後方互換性 | 適合 | isGlobalInstall()によりローカルインストール時の動作維持 |
| 単一責任 | 部分的適合 | env-setup.tsへの集約は良いが、getPidFilePath()が分散 |
| DRY | 要改善 | getPidFilePath()の3箇所重複を解消すべき |

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | PID_FILE重複によるバグ発生（一部だけ修正漏れ） | Medium | Medium | P1 |
| 保守性リスク | 環境変数読み込み責務の曖昧さによる将来のバグ | Medium | Low | P2 |
| テスト容易性 | DaemonManager直接依存によるモック困難 | Low | Low | P3 |

---

## 改善推奨アクション

### 必須（実装前に対応）

1. **getPidFilePath()をenv-setup.tsに集約**
   - 各コマンドファイルでの重複定義を避ける
   - getConfigDir()と同じファイルに配置

2. **環境変数読み込み責務の明確化**
   - daemon.tsに.env読み込みを集約するか
   - 共通のenv-loader.tsモジュールを作成

### 推奨（実装後または次期改善で対応）

3. startCommand()のフォアグラウンド/デーモン分離
4. isGlobalInstall()パターンの外部化
5. DaemonManagerインターフェース化

---

## 結論

設計方針は全体的に妥当であり、Issue #125の目的である「全CLIコマンドで一貫した設定ファイル解決」は達成可能。

ただし、**DRY原則に関する2点の必須改善**を設計書に反映した上で実装を進めることを推奨する。

**ステータス**: 条件付き承認（MF-1, MF-2の対応を条件とする）

---

## 参照

- 設計書: `dev-reports/design/issue-125-global-install-env-loading-design-policy.md`
- レビュー結果JSON: `dev-reports/issue/125/multi-stage-design-review/stage1-review-result.json`
- 関連Issue: #96 (npm CLI support), #119 (interactive init)
