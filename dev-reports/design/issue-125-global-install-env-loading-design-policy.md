# Issue #125: グローバルインストール時の.env読み込み設計方針書

## 概要

CommandMateをグローバルインストール（`npm install -g commandmate`）した場合、`init`コマンドは`.env`を`~/.commandmate/.env`に保存するが、`start`/`stop`/`status`コマンドは`process.cwd()`から設定ファイルを探す不整合を修正する。

## 背景

### 現状の問題

1. **initコマンド**: `getEnvPath()`を使用し、グローバルインストール時は`~/.commandmate/.env`に保存
2. **start/stop/statusコマンド**: `process.cwd()`を使用し、カレントディレクトリから読み込み
3. **結果**: 任意のディレクトリからサーバーを起動すると設定を読み込めない

### 影響

- リポジトリ登録時に「Invalid or unsafe repository path」エラーが発生
- ユーザーは手動で`.env`をコピーするか、ホームディレクトリから実行する必要がある

## 設計方針

### 原則

1. **一貫性**: 全CLIコマンドで同じ設定ファイル解決ロジックを使用
2. **後方互換性**: ローカルインストール時の動作は維持
3. **単一責任**: 設定ファイルパス解決は`env-setup.ts`に集約
4. **DRY**: パス解決ロジックの重複を排除

### 変更概要

| ファイル | 変更内容 |
|---------|---------|
| `package.json` | **【Stage 3レビュー対応: MF-1】** dotenvパッケージをdependenciesに追加 |
| `src/cli/utils/env-setup.ts` | `getPidFilePath()`関数を追加（Stage 1レビュー対応: MF-1）、**【Stage 4レビュー対応: MF-1】** パストラバーサル対策を追加 |
| `src/cli/commands/start.ts` | `getEnvPath()`, `getPidFilePath()`使用に変更、環境変数読み込みロジック削除（Stage 1レビュー対応: MF-2）、**【Stage 4レビュー対応: MF-2】** 外部公開時のセキュリティ警告追加 |
| `src/cli/commands/stop.ts` | `getPidFilePath()`使用に変更 |
| `src/cli/commands/status.ts` | `getPidFilePath()`使用に変更、**【Stage 3レビュー対応: MF-2】** .env読み込みによる正しい設定値表示 |
| `src/cli/utils/daemon.ts` | dotenvで.envを読み込み、環境変数読み込み責務を一元化（Stage 1レビュー対応: MF-2）、**【Stage 4レビュー対応: MF-2】** 外部公開+認証未設定時の警告 |

### 依存関係の追加（Stage 3レビュー対応: MF-1）

**追加するパッケージ**:
```json
{
  "dependencies": {
    "dotenv": "^16.0.0"
  }
}
```

**理由**:
- daemon.tsで.envファイルを読み込むために必要
- 広く使用されている安定したパッケージであり、追加によるリスクは低い
- Node.js 20.6以降で利用可能な`--env-file`フラグは互換性の観点から非推奨

**代替案**（不採用）:
- `fs.readFileSync` + 手動パース: 実装コストが高く、エッジケース対応が困難
- Node.js `--env-file`フラグ: Node.js 20.6未満との互換性なし

### 影響なしのファイル（Stage 2レビュー対応: SF-4）

| ファイル | 理由 |
|---------|------|
| `src/cli/commands/init.ts` | 既に`getEnvPath()`を使用しており、今回の修正で影響を受けない |

## 詳細設計

### 1. env-setup.ts への getPidFilePath() 集約（Stage 1レビュー対応: MF-1）

#### 設計意図

DRY原則に従い、`getPidFilePath()`を`env-setup.ts`に集約する。これにより、start.ts/stop.ts/status.tsでの関数重複を排除する。

#### 追加する関数

```typescript
// src/cli/utils/env-setup.ts

/**
 * PIDファイルのパスを取得する
 * グローバルインストール時: ~/.commandmate/.commandmate.pid
 * ローカルインストール時: <cwd>/.commandmate.pid
 *
 * @returns PIDファイルのパス（グローバルインストール時は絶対パス、ローカル時はカレントディレクトリ相対）
 *
 * 【Stage 2レビュー対応: MF-1】
 * 戻り値の説明を実態に合わせて修正。ローカルインストール時はprocess.cwd()を使用するため、
 * シンボリックリンクなどの環境では相対パス的な挙動になる可能性がある。
 */
export function getPidFilePath(): string {
  return join(getConfigDir(), '.commandmate.pid');
}
```

### 2. パストラバーサル対策（Stage 4レビュー対応: MF-1）

#### 設計意図

`getEnvPath()`および`getConfigDir()`でシンボリックリンクを経由した場合のパストラバーサル攻撃を防止する。攻撃者がシンボリックリンクを作成し、意図しないディレクトリの`.env`ファイルを読み込ませる可能性を排除する。

#### OWASP参照

**A01:2021 - Broken Access Control**

#### 追加する関数

```typescript
// src/cli/utils/env-setup.ts

import { realpathSync } from 'fs';
import { homedir } from 'os';

/**
 * シンボリックリンクを解決し、安全なパスであることを検証する
 *
 * 【Stage 4レビュー対応: MF-1】
 * パストラバーサル攻撃対策として、realpathSync()でシンボリックリンクを解決し、
 * 許可されたディレクトリ内にあることを検証する。
 *
 * @param targetPath 検証対象のパス
 * @param allowedBaseDir 許可されたベースディレクトリ
 * @returns 正規化された絶対パス
 * @throws Error パスが許可されたディレクトリ外の場合
 */
export function resolveSecurePath(targetPath: string, allowedBaseDir: string): string {
  const realPath = realpathSync(targetPath);
  const realBaseDir = realpathSync(allowedBaseDir);

  if (!realPath.startsWith(realBaseDir)) {
    throw new Error(`Path traversal detected: ${targetPath} resolves outside of ${allowedBaseDir}`);
  }

  return realPath;
}
```

#### getConfigDir()の修正

```typescript
// src/cli/utils/env-setup.ts

/**
 * 設定ディレクトリのパスを取得する
 * グローバルインストール時: ~/.commandmate/
 * ローカルインストール時: process.cwd()
 *
 * 【Stage 4レビュー対応: MF-1】
 * fs.realpathSync()を使用してシンボリックリンクを解決し、
 * 許可されたディレクトリ内にあることを検証する。
 *
 * @returns 設定ディレクトリの絶対パス
 */
export function getConfigDir(): string {
  if (isGlobalInstall()) {
    const configDir = join(homedir(), '.commandmate');
    // グローバルインストール時は~/.commandmate/のみ許可
    // ディレクトリが存在しない場合はrealpathSyncがエラーになるため、
    // 存在確認後に検証を行う
    if (existsSync(configDir)) {
      const realPath = realpathSync(configDir);
      const realHome = realpathSync(homedir());
      if (!realPath.startsWith(realHome)) {
        throw new Error(`Security error: Config directory ${configDir} is outside home directory`);
      }
    }
    return configDir;
  }

  // ローカルインストール時はcwdを使用
  const cwd = process.cwd();
  const realCwd = realpathSync(cwd);
  // cwdのシンボリックリンクを解決して返す
  return realCwd;
}
```

### 3. start.ts の修正（Stage 1レビュー対応: MF-1, MF-2、Stage 4レビュー対応: MF-2）

#### 現状
```typescript
const PID_FILE = join(process.cwd(), '.commandmate.pid');
const envPath = join(process.cwd(), '.env');
```

#### 修正後
```typescript
import { getEnvPath, getPidFilePath } from '../utils/env-setup';

export async function startCommand(options: StartOptions): Promise<void> {
  const envPath = getEnvPath();
  const pidFilePath = getPidFilePath();  // camelCase使用（Stage 2レビュー対応: SF-1）

  // 注: 環境変数の読み込みはdaemon.tsに一元化（MF-2対応）
  // start.tsはenvPathの存在確認のみを行う
  if (!existsSync(envPath)) {
    logger.error(`.env file not found at ${envPath}`);
    logger.info('Run "commandmate init" to create a configuration file');
    return;
  }

  // DaemonManagerに処理を委譲
  const manager = new DaemonManager(pidFilePath);
  // ...
}
```

#### 命名規則（Stage 2レビュー対応: SF-1）

既存コードでは`PID_FILE`（UPPER_SNAKE_CASE）を使用しているが、修正後は`pidFilePath`（camelCase）を使用する。これは`getPidFilePath()`関数からの戻り値であり、定数ではなく変数であるため、camelCaseが適切である。

### 4. stop.ts の修正（Stage 1レビュー対応: MF-1）

#### 現状
```typescript
const PID_FILE = join(process.cwd(), '.commandmate.pid');
```

#### 修正後
```typescript
import { getPidFilePath } from '../utils/env-setup';

export async function stopCommand(): Promise<void> {
  const pidFilePath = getPidFilePath();  // camelCase使用（Stage 2レビュー対応: SF-1）
  const manager = new DaemonManager(pidFilePath);
  // ...
}
```

### 5. status.ts の修正（Stage 1レビュー対応: MF-1、Stage 3レビュー対応: MF-2）

#### 現状
```typescript
const PID_FILE = join(process.cwd(), '.commandmate.pid');
```

#### 修正後
```typescript
import { config as dotenvConfig } from 'dotenv';
import { getEnvPath, getPidFilePath } from '../utils/env-setup';

export async function statusCommand(): Promise<void> {
  const pidFilePath = getPidFilePath();  // camelCase使用（Stage 2レビュー対応: SF-1）

  // 【Stage 3レビュー対応: MF-2】
  // statusコマンドでも正しい設定値を表示するため、.envを読み込む
  const envPath = getEnvPath();
  dotenvConfig({ path: envPath });

  const manager = new DaemonManager(pidFilePath);
  // ...
}
```

#### 設計意図（Stage 3レビュー対応: MF-2）

**問題**: daemon.tsの`getStatus()`メソッドは`process.env`から`CM_PORT`、`CM_BIND`を読み取るが、設計変更後は`.env`ファイルがdaemon.ts内で読み込まれるのは`start()`メソッド内のみ。`status`コマンド実行時は`.env`を読み込まないため、正しい設定値を取得できない可能性がある。

**対応方針**: `status.ts`内で`dotenvConfig()`を呼び出し、`getStatus()`が参照する`process.env`に設定値を反映させる。

**代替案**（不採用）:
1. PIDファイルにポート情報も記録する
   - 理由: PIDファイルの責務が増加し、PidManagerの変更が必要
2. ドキュメントに「statusコマンドは実行時の環境変数を使用する」と明記
   - 理由: ユーザー体験の観点から、initで設定した値がstatusで表示されることが期待される

### 6. daemon.ts の修正（Stage 1レビュー対応: MF-2、Stage 2レビュー対応: MF-2, MF-3、Stage 4レビュー対応: MF-2）

#### 設計意図

環境変数読み込み責務を`daemon.ts`に一元化する。`start.ts`は`.env`ファイルの存在確認のみを行い、実際の読み込みと子プロセスへの伝播は`daemon.ts`が担当する。

#### DaemonManagerのシグネチャ設計（Stage 2レビュー対応: MF-3）

**設計方針**: DaemonManagerのコンストラクタシグネチャは`constructor(pidFilePath: string)`のまま維持する。`getEnvPath()`は`start()`メソッド内で呼び出す設計とする。

**理由**:
- コンストラクタの変更は既存のstop/statusコマンドにも影響を与える
- `getEnvPath()`はstart時にのみ必要であり、stop/statusでは不要
- シグネチャ変更なしで実装可能であり、変更の最小化につながる

**代替案**（将来検討）:
- `DaemonManagerOptions`として`{ pidFilePath: string, envPath?: string }`を渡す設計
- テスト容易性の向上を目的とする場合に検討

#### 外部公開設定時のセキュリティ警告（Stage 4レビュー対応: MF-2）

**OWASP参照**: A05:2021 - Security Misconfiguration

**対応方針**:
1. `.env`読み込み後の正確なポート/バインド値を使用してログ出力
2. `CM_BIND=0.0.0.0`の場合はセキュリティ警告を表示
3. 認証トークン未設定時に警告を表示

#### 修正後

```typescript
import { config as dotenvConfig } from 'dotenv';
import { getEnvPath } from './env-setup';

async start(options: StartOptions): Promise<number> {
  // 環境変数読み込み責務をdaemon.tsに一元化（MF-2対応）
  const envPath = getEnvPath();
  const envResult = dotenvConfig({ path: envPath });

  // 【Stage 2レビュー対応: MF-2】.envファイル読み込みエラーのハンドリング
  // start.tsで存在確認済みのため通常は発生しないが、レースコンディション対策として防御コードを追加
  if (envResult.error) {
    logger.warn(`Failed to load .env file at ${envPath}: ${envResult.error.message}`);
    logger.info('Continuing with existing environment variables');
    // フォールバック: process.envのみを使用して続行
  }

  // 環境変数をマージ
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(envResult.parsed || {}),  // エラー時はparsedがundefinedの可能性があるため空オブジェクトにフォールバック
  };

  // コマンドラインオプションによるオーバーライド
  if (options.port) {
    env.CM_PORT = String(options.port);
  }

  // 【Stage 4レビュー対応: MF-2】外部公開設定時のセキュリティ警告
  const bindAddress = env.CM_BIND || '127.0.0.1';
  const authToken = env.CM_AUTH_TOKEN;

  if (bindAddress === '0.0.0.0') {
    logger.warn('WARNING: Server is accessible from external networks (CM_BIND=0.0.0.0)');

    if (!authToken) {
      logger.warn('SECURITY WARNING: No authentication token configured. External access is not recommended without CM_AUTH_TOKEN.');
      logger.info('Run "commandmate init" to configure a secure authentication token.');
    }
  }

  // 起動成功時のログメッセージで正確な値を使用
  const port = env.CM_PORT || '3000';
  logger.info(`Starting server at http://${bindAddress}:${port}`);

  // 子プロセスに伝播
  const child = spawn('npm', ['run', npmScript], {
    cwd: packageRoot,
    env,
    detached: true,
    stdio: 'ignore',
  });
  // ...
}
```

### 7. エラーメッセージの改善

設定ファイルが見つからない場合、期待されるパスを表示する。

```typescript
if (!existsSync(envPath)) {
  logger.error(`.env file not found at ${envPath}`);
  logger.info('Run "commandmate init" to create a configuration file');
  // ...
}
```

## セキュリティ設計（Stage 4レビュー対応）

### パストラバーサル対策（MF-1）

#### 脅威

シンボリックリンクを経由して意図しないディレクトリの`.env`ファイルを読み込ませるパストラバーサル攻撃。

#### OWASP参照

**A01:2021 - Broken Access Control**

#### 対策

1. **fs.realpathSync()によるシンボリックリンク解決**
   - `getConfigDir()`でシンボリックリンクを解決し、正規化されたパスを使用
   - `getEnvPath()`、`getPidFilePath()`も間接的に保護される

2. **許可ディレクトリ内チェック**
   - グローバルインストール時: `~/.commandmate/`がホームディレクトリ内にあることを検証
   - ローカルインストール時: `process.cwd()`をrealpathで解決して返却

3. **エラーハンドリング**
   - パスが許可されたディレクトリ外の場合は明確なエラーメッセージで例外をスロー

#### 実装チェックリスト

- [ ] `getConfigDir()`でfs.realpathSync()を使用してシンボリックリンクを解決
- [ ] グローバルインストール時に`~/.commandmate/`がホームディレクトリ内にあることを検証
- [ ] ローカルインストール時にprocess.cwd()をrealpathで解決
- [ ] パストラバーサル検出時のエラーメッセージとログ出力

### 機密情報の取り扱い（MF-2）

#### 脅威

1. `.env`読み込み前のprocess.envを参照することで不正確な設定値を表示
2. 0.0.0.0バインド時に外部からのアクセスが可能になるセキュリティリスク

#### OWASP参照

**A05:2021 - Security Misconfiguration**

#### 対策

1. **正確な設定値の取得**
   - daemon.tsで`.env`読み込み後の`env`オブジェクトから設定値を取得
   - process.envを直接参照せず、マージ後の値を使用

2. **外部公開設定時のセキュリティ警告**
   - `CM_BIND=0.0.0.0`の場合に「Server is accessible from external networks」警告を表示
   - 認証トークン未設定時に追加の警告を表示

3. **ログメッセージの改善**
   - 起動成功時のログに正確なポート/バインド値を出力

#### 実装チェックリスト

- [ ] daemon.tsのstart()で.env読み込み後のenv変数から設定値を取得
- [ ] CM_BIND=0.0.0.0の場合にセキュリティ警告を表示
- [ ] CM_AUTH_TOKEN未設定かつ外部公開時に追加警告を表示
- [ ] 起動成功ログに正確なポート/バインド値を出力

### 既存のセキュリティ実装（Good Practices）

Stage 4レビューで確認された良好なセキュリティ実装:

| カテゴリ | 実装箇所 | 説明 |
|---------|---------|------|
| 機密情報の保護 | env-setup.ts createEnvFile() | .envファイル作成時にmode: 0o600設定、chmodSync()で明示的にパーミッション再設定 |
| TOCTOU対策 | pid-manager.ts writePid() | O_EXCLフラグを使用したアトミックなファイル作成 |
| 機密データのマスキング | security-logger.ts maskSensitiveData() | CM_AUTH_TOKENおよびtoken様の文字列をログ出力前にマスキング |
| コマンドインジェクション防止 | daemon.ts spawn() | 引数配列形式でshell: true未使用 |
| 安全な乱数生成 | env-setup.ts generateAuthToken() | crypto.randomBytes(32)による256ビットエントロピー |
| 入力サニタイズ | env-setup.ts sanitizeInput(), escapeEnvValue() | 制御文字の除去、特殊文字エスケープ |
| セキュリティログ出力 | start.ts, stop.ts | logSecurityEvent()による監査ログ |

## PIDファイルの配置

### グローバルインストール時
- **PIDファイル**: `~/.commandmate/.commandmate.pid`
- **.envファイル**: `~/.commandmate/.env`

### ローカルインストール時
- **PIDファイル**: `<cwd>/.commandmate.pid`
- **.envファイル**: `<cwd>/.env`

## 後方互換性

### ローカルインストール環境

`isGlobalInstall()`が`false`を返す場合、現行動作を維持：
- `.env`は`process.cwd()`から読み込み
- PIDファイルは`process.cwd()`に配置

### 既存PIDファイルの移行

カレントディレクトリに既存の`.commandmate.pid`がある場合の警告表示を検討：
```typescript
const legacyPidFile = join(process.cwd(), '.commandmate.pid');
if (existsSync(legacyPidFile)) {
  logger.warn(`Legacy PID file found at ${legacyPidFile}`);
  logger.info('Consider removing it if the server is not running');
}
```

## テスト計画

### 単体テスト

1. **env-setup.ts**（Stage 1レビュー対応: MF-1、Stage 4レビュー対応: MF-1）
   - `getPidFilePath()`がグローバルインストール時に正しいパスを返すこと
   - `getPidFilePath()`がローカルインストール時に正しいパスを返すこと
   - **【Stage 4追加】** `getConfigDir()`がシンボリックリンクを正しく解決すること
   - **【Stage 4追加】** パストラバーサル攻撃を検出してエラーをスローすること

2. **start.ts**
   - グローバルインストール時に`~/.commandmate/.env`を読み込むこと
   - ローカルインストール時に`process.cwd()/.env`を読み込むこと
   - `.env`が見つからない場合に適切なエラーメッセージを表示すること

3. **stop.ts**
   - グローバルインストール時に`~/.commandmate/.commandmate.pid`を参照すること
   - ローカルインストール時に`process.cwd()/.commandmate.pid`を参照すること

4. **status.ts**
   - グローバルインストール時に正しいPIDファイルを参照すること
   - ローカルインストール時に正しいPIDファイルを参照すること
   - **【Stage 3追加】** .envの設定値が正しく読み込まれ、status出力に反映されること

5. **daemon.ts**（Stage 1レビュー対応: MF-2、Stage 2レビュー対応: MF-2、Stage 4レビュー対応: MF-2）
   - `.env`の環境変数が子プロセスに渡ること
   - コマンドラインオプションが`.env`の値をオーバーライドすること
   - 環境変数読み込み責務がdaemon.tsに集約されていること
   - **【Stage 2追加】** `.env`ファイル読み込みエラー時にフォールバック動作すること（envResult.errorのハンドリング）
   - **【Stage 4追加】** CM_BIND=0.0.0.0の場合にセキュリティ警告がログ出力されること
   - **【Stage 4追加】** CM_AUTH_TOKEN未設定かつ外部公開時に追加警告がログ出力されること
   - **【Stage 4追加】** 起動成功ログに正確なポート/バインド値が出力されること

### テスト検証方法（Stage 2レビュー対応: SF-2）

**spawn呼び出しの検証方法**:
- `spawn`関数をモック化し、第3引数の`env`オブジェクトに`.env`の値とオーバーライド値が含まれていることを検証
- テストフレームワーク（Vitest）のspy機能を使用して呼び出し引数をキャプチャ

```typescript
// テスト例
import { vi } from 'vitest';
import { spawn } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() }))
}));

// テスト内でspawnの呼び出し引数を検証
expect(spawn).toHaveBeenCalledWith(
  'npm',
  ['run', expect.any(String)],
  expect.objectContaining({
    env: expect.objectContaining({
      CM_PORT: '3000',
      CM_ROOT_DIR: '/path/to/repos'
    })
  })
);
```

### 統合テスト

1. グローバルインストール環境での一連の操作
   - `commandmate init` → `commandmate start --daemon` → `commandmate status` → `commandmate stop`

2. 任意のディレクトリからの実行
   - `/tmp`などのディレクトリから`commandmate start`が成功すること

## 受け入れ条件

- [ ] グローバルインストール時に任意のディレクトリから`commandmate start`できること
- [ ] `~/.commandmate/.env`の設定が正しく読み込まれること
- [ ] PIDファイルが`~/.commandmate/.commandmate.pid`に作成されること
- [ ] `stop`/`status`コマンドが正しいPIDファイルを参照すること
- [ ] エラー発生時に期待される設定ファイルパスが表示されること
- [ ] ローカルインストール時の動作が維持されること（後方互換性）
- [ ] 単体テスト追加
- [ ] **【Stage 2追加】** daemon.tsで.env読み込みエラー時にフォールバック動作すること
- [ ] **【Stage 3追加】** dotenvパッケージがdependenciesに追加されていること
- [ ] **【Stage 3追加】** statusコマンドで正しい設定値が表示されること
- [ ] **【Stage 4追加】** getConfigDir()でシンボリックリンク解決とパストラバーサル検証が実装されていること
- [ ] **【Stage 4追加】** CM_BIND=0.0.0.0の場合にセキュリティ警告が表示されること
- [ ] **【Stage 4追加】** 外部公開+認証未設定時に追加警告が表示されること
- [ ] **【Stage 4追加】** 起動成功ログに正確な設定値が表示されること

## 今後の検討事項

### Stage 1レビュー対応

#### SF-1: startCommand()の責務分割（SRP）

**指摘**: `startCommand()`がフォアグラウンド起動とデーモン起動の両方のロジックを含み、複数の責務を持っている。

**推奨**: `startForeground()`と`startDaemon()`の2つのプライベート関数に分割し、`startCommand()`はオプションに応じてどちらかを呼び出すディスパッチャとして機能させる。

**優先度**: 中

#### SF-2: isGlobalInstall()のパターン外部化（OCP）

**指摘**: `isGlobalInstall()`がハードコードされた文字列パターンで判定を行っている。新しいパッケージマネージャやインストール方式が追加された場合、この関数を直接修正する必要がある。

**推奨**: パターンを設定ファイルまたは定数配列として外部化し、新規パターン追加時に関数本体を修正せずに済むようにする。

**優先度**: 低（YAGNI観点から現時点では緊急性なし）

#### SF-3: DaemonManagerへの依存性注入（DIP）

**指摘**: 各コマンドがDaemonManagerを直接インスタンス化しており、テストでのモック差し替えが困難。高レベルのコマンドモジュールが低レベルのDaemonManager具象クラスに直接依存している。

**推奨**: DaemonManagerのインターフェースを定義し、ファクトリ関数またはコンストラクタ注入で依存性を渡す設計を検討。ただし、CLIという単純なユースケースでは過度な抽象化となる可能性もあるため、テスト容易性とのバランスを考慮する。

**優先度**: 中

#### SF-4: EnvSetupクラスの責務分離（KISS）

**指摘**: EnvSetupクラスにはcreateEnvFile, backupExisting, generateAuthToken, validateConfigという異なる粒度の責務が混在している。クラスとして抽象化する必然性が低い。

**推奨**: 現状の設計でも動作するが、将来的にはEnvFileWriter, EnvValidator, TokenGeneratorなどに分離することで、各モジュールのテスト容易性が向上する。

**優先度**: 低

### Stage 2レビュー対応

#### SF-1: 命名規則の一貫性

**指摘**: 設計書では`pidFilePath`という変数名を使用しているが、既存のstop.ts/status.tsでは`PID_FILE`という定数名（UPPER_SNAKE_CASE）を使用している。

**対応**: 本設計書では`pidFilePath`（camelCase）に統一する。関数からの戻り値は定数ではなく変数であるため、camelCaseが適切。

**ステータス**: 設計書に反映済み

#### SF-2: テスト検証方法の具体化

**指摘**: テスト計画にはdaemon.tsの「.envの環境変数が子プロセスに渡ること」が記載されているが、具体的な検証方法が不明確。

**対応**: テスト計画セクションにspawnモック化による検証方法を追記。

**ステータス**: 設計書に反映済み

#### SF-3: エラーメッセージパターンの統一

**指摘**: 設計書のエラーメッセージ改善では`.env file not found at ${envPath}`とパスを表示する設計だが、PIDファイルが見つからない場合のエラーメッセージにもパス情報を含めるべきか統一されていない。

**推奨**: 全コマンドで一貫したエラーメッセージ形式を定義する。例：「{ファイル種別} not found at {パス}」の形式を標準化し、エラーメッセージテンプレートをcli/utils/messages.tsなどに集約することを検討。

**優先度**: 低（本Issueのスコープ外、将来の改善として検討）

#### SF-4: 影響なしファイルの明記

**指摘**: 変更概要テーブルにはinit.tsが含まれていないが、「影響を受けないファイル」として明示されていない。

**対応**: 変更概要セクションに「影響なしのファイル」テーブルを追加。

**ステータス**: 設計書に反映済み

### Stage 3レビュー対応

#### SF-1: env-setup.tsの責務増加

**指摘**: `getPidFilePath()`をenv-setup.tsに追加することで、env-setup.tsの責務が増加する。現在env-setup.tsは「環境設定ファイルの管理」を担当しているが、PIDファイルパス管理という別の責務が混在することになる。

**推奨**: 短期的にはenv-setup.tsへの追加で問題ないが、将来的にはpaths.tsまたはconfig-paths.tsとして設定パス全般を管理するモジュールに分離することを検討。

**優先度**: 低（機能的には問題なく動作、保守性の観点での指摘）

#### SF-2: マイグレーションパスの定義

**指摘**: 設計書では「レガシーPIDファイルの警告表示」を検討事項としているが、具体的な移行パスが定義されていない。既存ユーザーがグローバルインストールにアップグレードした場合、カレントディレクトリの.commandmate.pidが残存し、混乱を招く可能性がある。

**推奨**: バージョンアップノートまたはCHANGELOG.mdに移行手順を明記:
1. 旧バージョンで`stop`コマンドを実行
2. 残存する`.commandmate.pid`を手動削除
3. `commandmate init`を再実行
4. start/stopコマンドに移行ガイダンスメッセージの追加も検討

**優先度**: 中（ドキュメント追加で対応可能）

#### SF-3: ファイルI/Oの増加

**指摘**: daemon.tsのstart()メソッドでdotenv.config()を呼び出すことで、ファイルI/Oが1回増加する。start.tsで既に存在確認を行っているため、同じファイルに2回アクセスすることになる。

**評価**: 起動時のオーバーヘッドは無視できるレベル（数ms程度）であり、責務分離の観点からは許容範囲。OSキャッシュにより2回目のアクセスは高速。

**対応**: 不要（パフォーマンス影響は無視可能レベル）

#### SF-4: デバッグ容易性の向上

**指摘**: 設定ファイルパスがグローバル/ローカルで異なる場合、デバッグ時にどちらの設定が使用されているか判断しにくい。特にログメッセージに設定ファイルパスが含まれていない場合、問題の切り分けが困難になる。

**推奨**:
- CLIの起動時ログに使用している設定ファイルパスを出力する
  - 例: `logger.debug(\`Using config: ${getEnvPath()}\`);`
- statusコマンドの出力に`Config file`パスを追加することを検討

**優先度**: 中（ログ出力の改善で対応可能）

### Stage 4レビュー対応（セキュリティ）

#### SF-1: コマンドインジェクション対策 - ポートバリデーション強化

**指摘**: spawn()は引数配列を使用しており基本的なコマンドインジェクションは防止されているが、環境変数envオブジェクトにユーザー入力（options.port）が含まれる。parseInt()で数値変換しているものの、String()変換前のバリデーションが不十分。

**OWASP参照**: A03:2021 - Injection

**推奨**: env-setup.tsのvalidatePort()関数を使用して、options.portを環境変数に設定する前に明示的にバリデーションする。また、ポート番号の範囲チェック（1024-65535の非特権ポート範囲推奨）を追加。

**現状の緩和策**: spawn()の引数配列使用でシェルインジェクションは防止済み

**優先度**: 中

#### SF-2: ファイルパーミッション - 既存ディレクトリの検証

**指摘**: `~/.commandmate/`ディレクトリ作成時にmode: 0o700を設定しているが、既存ディレクトリのパーミッションが緩い場合の検証・修正が行われていない。また、umaskによってパーミッションが意図せず変更される可能性がある。

**OWASP参照**: A05:2021 - Security Misconfiguration

**推奨**:
1. mkdirSync後にchmodSyncで明示的にパーミッションを再設定
2. 既存ディレクトリがある場合はパーミッションを検証し、0o700より緩い場合は警告を表示
3. statSync().modeでパーミッションを確認するヘルパー関数を追加

**優先度**: 中

#### SF-3: セキュリティログ・監視の強化

**指摘**: セキュリティイベントログは実装されているが、以下の重要イベントがログ対象になっていない:
1. .env読み込み失敗
2. PIDファイル競合（EEXIST）
3. 設定ファイルパーミッションの異常検出
また、ログローテーションが実装されていない。

**OWASP参照**: A09:2021 - Security Logging and Monitoring Failures

**推奨**:
1. daemon.tsでenvResult.error発生時にlogSecurityEvent()を呼び出す
2. pid-manager.tsでEEXIST発生時にlogSecurityEvent()を呼び出す
3. 設定ファイル読み込み時にパーミッションチェックを追加しログ出力
4. 将来的にログローテーション機能を検討

**優先度**: 中

#### SF-4: 認証・認可 - start時の再検証

**指摘**: CM_BIND=0.0.0.0の場合にCM_AUTH_TOKENが必須とするバリデーションは実装されているが、initコマンドでのみ検証される。start時に.envを読み込む際の再検証が行われておらず、ユーザーが手動で.envを編集してトークンを削除した場合、外部公開状態で認証なし起動が可能。

**OWASP参照**: A07:2021 - Identification and Authentication Failures

**推奨**: daemon.tsのstart()メソッドで.env読み込み後、CM_BIND=0.0.0.0かつCM_AUTH_TOKEN未設定の場合にエラーまたは強制的なwarningを出力する検証ロジックを追加。

**優先度**: 中

**注記**: MF-2で警告表示は追加されるが、起動をブロックするかどうかは運用要件に応じて検討が必要。

#### SF-5: 入力バリデーション - sanitizePath()の強化

**指摘**: sanitizePath()はpath.normalize()を使用しているが、これだけでは../(親ディレクトリ参照)を含むパスを防げない。悪意のあるパスが設定ファイルに書き込まれる可能性がある。

**OWASP参照**: A03:2021 - Injection (Path Traversal)

**推奨**:
1. normalize後のパスが..を含まないことを検証
2. 絶対パスの場合は許可されたベースディレクトリ内であることを検証
3. isPathSafe()のような専用関数の実装を検討

**優先度**: 中

## 関連Issue

- Issue #119: commandmate init 対話形式モード
- Issue #96: npm install CLI サポート

## レビュー指摘事項サマリー

### Stage 2（整合性レビュー）

| ID | カテゴリ | 重要度 | 内容 | ステータス |
|----|---------|--------|------|-----------|
| MF-1 | 設計書と既存コードの整合性 | 高 | JSDocコメントの精度不足 - getPidFilePath()の戻り値説明を実態に合わせて修正 | 反映済み |
| MF-2 | 設計書内セクション間の整合性 | 高 | daemon.tsでenvResult.errorのエラーハンドリングが設計されていない | 反映済み |
| MF-3 | APIシグネチャの整合性 | 高 | DaemonManagerのシグネチャ検討が不足 - コンストラクタ維持の設計意図を明記 | 反映済み |
| SF-1 | 命名規則の一貫性 | 中 | PID_FILE（定数）からpidFilePath（変数）への移行をcamelCaseに統一 | 反映済み |
| SF-2 | テスト計画と実装の整合性 | 中 | テスト検証方法の具体化（spawnモック化） | 反映済み |
| SF-3 | エラーハンドリングの整合性 | 中 | エラーメッセージパターンの統一 | 今後の検討事項 |
| SF-4 | 設計書内の整合性 | 中 | 影響なしファイル（init.ts）の明記 | 反映済み |

### Stage 3（影響分析レビュー）

| ID | カテゴリ | 重要度 | 内容 | ステータス |
|----|---------|--------|------|-----------|
| MF-1 | 依存関係の変化 | 高 | dotenvパッケージの依存追加が設計書に明記されていない | 反映済み |
| MF-2 | 既存機能への影響 | 高 | getStatus()での設定値取得問題 - status.tsでdotenvConfig()呼び出しを追加 | 反映済み |
| SF-1 | 波及効果 | 中 | env-setup.tsの責務増加 - 将来的なpaths.ts分離を検討 | 今後の検討事項 |
| SF-2 | 後方互換性 | 中 | マイグレーションパスの定義 - CHANGELOG.md移行手順追記を検討 | 今後の検討事項 |
| SF-3 | パフォーマンスへの影響 | 低 | ファイルI/Oの増加 - オーバーヘッドは無視可能レベル | 対応不要 |
| SF-4 | 運用・保守への影響 | 中 | デバッグ容易性 - 起動時ログに設定ファイルパス出力を検討 | 今後の検討事項 |

### Stage 4（セキュリティレビュー）

| ID | カテゴリ | OWASP参照 | 重要度 | 内容 | ステータス |
|----|---------|-----------|--------|------|-----------|
| MF-1 | パストラバーサル対策 | A01:2021 - Broken Access Control | 高 | getEnvPath()/getConfigDir()でシンボリックリンク解決が行われていない | 反映済み |
| MF-2 | 機密情報の取り扱い | A05:2021 - Security Misconfiguration | 高 | 起動成功時のログで不正確な情報表示、0.0.0.0バインド時のセキュリティ警告欠如 | 反映済み |
| SF-1 | コマンドインジェクション対策 | A03:2021 - Injection | 中 | options.portのバリデーション強化 - validatePort()使用を推奨 | 今後の検討事項 |
| SF-2 | ファイルパーミッション | A05:2021 - Security Misconfiguration | 中 | 既存ディレクトリのパーミッション検証追加 | 今後の検討事項 |
| SF-3 | セキュリティログ・監視 | A09:2021 - Security Logging and Monitoring Failures | 中 | .env読み込み失敗、PID競合時のlogSecurityEvent()呼び出し追加 | 今後の検討事項 |
| SF-4 | 認証・認可 | A07:2021 - Identification and Authentication Failures | 中 | start時の0.0.0.0 + トークン未設定の再検証 | 今後の検討事項 |
| SF-5 | 入力バリデーション | A03:2021 - Injection (Path Traversal) | 中 | sanitizePath()に..チェック追加 | 今後の検討事項 |

## レビュー履歴

| 日付 | ステージ | 対応内容 |
|------|---------|---------|
| 2026-02-02 | Stage 1（設計原則レビュー） | MF-1: getPidFilePath()をenv-setup.tsに集約、MF-2: 環境変数読み込み責務をdaemon.tsに一元化 |
| 2026-02-02 | Stage 2（整合性レビュー） | MF-1: JSDocコメント修正、MF-2: daemon.tsにenvResult.errorエラーハンドリング追加、MF-3: DaemonManagerシグネチャ設計意図明記、SF-1〜SF-4: 設計書に反映または今後の検討事項に追記 |
| 2026-02-02 | Stage 3（影響分析レビュー） | MF-1: dotenvパッケージ依存追加を変更概要・詳細設計・受け入れ条件に明記、MF-2: status.tsでdotenvConfig()呼び出しを追加する設計を明記、SF-1〜SF-4: 今後の検討事項に追記 |
| 2026-02-02 | Stage 4（セキュリティレビュー） | MF-1: getConfigDir()にfs.realpathSync()によるシンボリックリンク解決とパストラバーサル検証を追加、MF-2: daemon.tsに外部公開時のセキュリティ警告と正確な設定値取得を追加、SF-1〜SF-5: 今後の検討事項に追記、セキュリティ設計セクションを新設 |
