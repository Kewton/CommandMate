# Issue #125 影響範囲レビューレポート

**レビュー日**: 2026-02-02
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 3 |
| Nice to Have | 2 |

**総合評価**: Issue #125は技術的に明確で、根本原因と修正案が適切に記載されています。主な問題は、`start.ts`/`stop.ts`/`status.ts`が`process.cwd()`を使用している一方、`init.ts`は正しく`getEnvPath()`を使用している不整合です。

---

## 影響分析

### 1. 変更対象ファイル

| ファイル | 変更種別 | 影響度 | 説明 |
|----------|----------|--------|------|
| `src/cli/commands/start.ts` | 修正 | 高 | getEnvPath()とgetConfigDir()を使用するよう変更 |
| `src/cli/commands/stop.ts` | 修正 | 高 | PID_FILEパスをgetConfigDir()から取得 |
| `src/cli/commands/status.ts` | 修正 | 高 | PID_FILEパスをgetConfigDir()から取得 |
| `src/cli/utils/daemon.ts` | 修正 | 高 | .envファイルを読み込み環境変数を子プロセスに伝播 |
| `src/cli/utils/env-setup.ts` | 変更なし | - | getEnvPath()とgetConfigDir()は既に実装済み |

### 2. 依存関係への影響

```
src/cli/utils/env-setup.ts
    |
    +-- getEnvPath() --> start.ts (新規参照)
    |
    +-- getConfigDir() --> start.ts, stop.ts, status.ts (新規参照)

src/cli/utils/daemon.ts
    |
    +-- DaemonManager --> start.ts, stop.ts
    |
    +-- dotenv (新規依存の可能性)
```

### 3. 後方互換性

**ステータス**: 破壊的変更の可能性あり

**考慮事項**:
- ローカルインストール環境（`process.cwd()`）での動作は維持される必要あり
- グローバルインストール時のPIDファイル位置変更により、既存の`.commandmate.pid`が孤立する可能性
- 既存のstart/stopワークフローを持つユーザーへの影響

**移行手順の提案**:
1. 既存のカレントディレクトリ内`.commandmate.pid`を`~/.commandmate/`に移動
2. 既存の`.env`ファイルがある場合は警告表示を検討

### 4. テストへの影響

**単体テスト（要修正）**:
- `tests/unit/cli/commands/start.test.ts`
- `tests/unit/cli/commands/stop.test.ts`
- `tests/unit/cli/commands/status.test.ts`
- `tests/unit/cli/utils/daemon.test.ts`

**追加が必要なテスト**:
- グローバルインストール時のパス解決テスト
- ローカルインストール時のパス解決テスト（後方互換性確認）
- `daemon.ts`での環境変数伝播テスト
- グローバルインストールでのE2Eフロー

### 5. ドキュメントへの影響

**更新が必要なドキュメント**:
- `CLAUDE.md` - CLIモジュール説明の更新
- `docs/migration-to-commandmate.md` - グローバルインストール時の設定ファイル配置場所説明追加
- `README.md` - 必要に応じて更新

---

## Must Fix（必須対応）

### MF-1: start.tsとinit.tsのパス解決ロジック不整合

**カテゴリ**: 整合性
**場所**: `src/cli/commands/start.ts` L17, L25

**問題**:
`start.ts`が`process.cwd()`を使用している一方、`init.ts`は`getEnvPath()`を使用しており不整合が発生しています。

**証拠**:
```typescript
// start.ts L17
const PID_FILE = join(process.cwd(), '.commandmate.pid');

// start.ts L25
const envPath = join(process.cwd(), '.env');

// init.ts L190（正しい実装）
const envPath = getEnvPath();
```

**推奨対応**:
`start.ts`で`getEnvPath()`と`getConfigDir()`を使用するよう修正してください。

---

### MF-2: stop.tsとstatus.tsのPIDファイルパス不整合

**カテゴリ**: 整合性
**場所**: `src/cli/commands/stop.ts` L14, `src/cli/commands/status.ts` L13

**問題**:
`stop.ts`と`status.ts`も同様に`process.cwd()`を使用しており、グローバルインストール時に正しいPIDファイルを参照できません。

**証拠**:
```typescript
// stop.ts L14
const PID_FILE = join(process.cwd(), '.commandmate.pid');

// status.ts L13
const PID_FILE = join(process.cwd(), '.commandmate.pid');
```

**推奨対応**:
`getConfigDir()`を使用してPID_FILEパスを構築してください。

```typescript
import { getConfigDir } from '../utils/env-setup';
const PID_FILE = join(getConfigDir(), '.commandmate.pid');
```

---

### MF-3: daemon.tsの環境変数伝播欠落

**カテゴリ**: 機能欠落
**場所**: `src/cli/utils/daemon.ts` L41-44

**問題**:
`daemon.ts`が`.env`ファイルの環境変数を子プロセスに伝播していません。これがIssueで報告されている「Invalid or unsafe repository path」エラーの直接的な原因です。

**証拠**:
```typescript
// daemon.ts L41-44
const env: NodeJS.ProcessEnv = { ...process.env };
// .envファイルの内容が子プロセスに渡らない
```

**推奨対応**:
`dotenv`を使用して`.env`ファイルを読み込み、`env`オブジェクトにマージしてください。

```typescript
import { config } from 'dotenv';
import { getEnvPath } from './env-setup';

// .envファイルを読み込み
const envPath = getEnvPath();
const parsed = config({ path: envPath }).parsed || {};

// 環境変数をマージ
const env: NodeJS.ProcessEnv = { ...process.env, ...parsed };
```

---

## Should Fix（推奨対応）

### SF-1: テストのグローバルインストール対応

**カテゴリ**: テスト
**場所**: `tests/unit/cli/commands/start.test.ts`

**問題**:
既存テストが`process.cwd()`ベースのパス解決を前提としており、グローバルインストール時のパス解決をテストしていません。

**推奨対応**:
`env-setup.ts`の`getEnvPath()`と`getConfigDir()`をモックし、両方のインストールタイプをテストしてください。

---

### SF-2: エラーメッセージ改善の受け入れ条件追加

**カテゴリ**: エラーメッセージ
**場所**: Issue body - 修正案セクション

**問題**:
Issueの修正案3に記載の「エラーメッセージ改善」が受け入れ条件に含まれていません。

**証拠**:
> 修正案3: エラーメッセージ改善 - 期待されるパスをエラーメッセージに含める

**推奨対応**:
受け入れ条件に「エラー発生時に期待される設定ファイルパスが表示されること」を追加してください。

```markdown
- [ ] .envファイルが見つからない場合、期待されるパスがエラーメッセージに含まれること
```

---

### SF-3: 移行パスの明示

**カテゴリ**: 後方互換性
**場所**: Issue body - 全体

**問題**:
既存環境からの移行パスが明示されていません。カレントディレクトリにある`.commandmate.pid`ファイルの扱いが不明です。

**推奨対応**:
以下のいずれかを受け入れ条件に追加してください：
1. 移行手順のドキュメント化
2. 既存PIDファイルの自動検出と警告表示
3. マイグレーションコマンドの追加（将来Issue）

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issueの双方向リンク

**カテゴリ**: ドキュメント
**場所**: Issue body - 関連Issueセクション

**推奨対応**:
Issue #119にも#125への参照を追加すると追跡が容易になります。

---

### NTH-2: dotenv依存の確認

**カテゴリ**: 実装詳細
**場所**: package.json

**推奨対応**:
`dotenv`が既に依存関係に含まれているか確認し、含まれていない場合は追加を検討してください。Next.jsは開発時に`.env`を自動読み込みしますが、本番ビルドでは明示的な読み込みが必要な場合があります。

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 |
|----------|--------|--------|
| `src/cli/commands/start.ts` | 17, 25 | PID_FILEとenvPathの定義箇所（修正対象） |
| `src/cli/commands/stop.ts` | 14 | PID_FILEの定義箇所（修正対象） |
| `src/cli/commands/status.ts` | 13 | PID_FILEの定義箇所（修正対象） |
| `src/cli/commands/init.ts` | 190 | getEnvPath()の正しい使用例（参照） |
| `src/cli/utils/env-setup.ts` | 46-93 | isGlobalInstall(), getEnvPath(), getConfigDir()の実装（参照） |
| `src/cli/utils/daemon.ts` | 41-52 | 環境変数構築部分（修正対象） |

### ドキュメント

| ファイル | 関連性 |
|----------|--------|
| `dev-reports/design/issue-96-npm-cli-design-policy.md` | CLIアーキテクチャの元設計書 |
| `docs/migration-to-commandmate.md` | 環境変数移行ガイド（更新が必要） |
| `CLAUDE.md` | CLIモジュール説明（更新が必要） |

---

*レビュー完了: 2026-02-02*
