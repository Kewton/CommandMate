# Issue #125 影響分析レビュー（Stage 3）

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue番号 | #125 |
| レビューステージ | Stage 3: 影響分析レビュー |
| フォーカス | 影響範囲 |
| レビュー日 | 2026-02-02 |
| 対象設計書 | dev-reports/design/issue-125-global-install-env-loading-design-policy.md |
| ステータス | 条件付き承認 |

## エグゼクティブサマリー

Issue #125の設計変更による影響範囲を分析した結果、変更対象はCLIモジュール（`src/cli/`）に適切に限定されており、Web UIやAPIへの波及効果はないことを確認した。

主な懸念点は以下の2点である:

1. **dotenv依存の追加漏れ**: 設計書ではdaemon.tsでdotenvを使用する計画だが、package.jsonへの追加が明記されていない
2. **getStatus()の設定値取得**: daemon.tsのgetStatus()メソッドが変更後も正しい設定値を取得できるか未検証

後方互換性は概ね維持されるが、グローバルインストールへの移行時のドキュメント整備が必要。パフォーマンス影響は無視できるレベルである。

## 影響を受けるモジュール一覧

| モジュール | 変更種別 | 影響内容 | リスク |
|-----------|---------|---------|--------|
| `src/cli/commands/start.ts` | 直接変更 | getEnvPath(), getPidFilePath()のimport追加、PID_FILE定数削除 | Low |
| `src/cli/commands/stop.ts` | 直接変更 | getPidFilePath()のimport追加、PID_FILE定数削除 | Low |
| `src/cli/commands/status.ts` | 直接変更 | getPidFilePath()のimport追加、PID_FILE定数削除 | Low |
| `src/cli/utils/daemon.ts` | 直接変更 | dotenv import追加、start()での.env読み込みロジック追加 | Medium |
| `src/cli/utils/env-setup.ts` | 直接変更 | getPidFilePath()関数追加 | Low |
| `src/cli/commands/init.ts` | 影響なし | 既にgetEnvPath()使用、変更不要 | None |
| `src/cli/utils/pid-manager.ts` | 間接影響 | インターフェース不変、呼び出し元経由で影響可能性 | None |
| `package.json` | 直接変更 | dotenv依存追加が必要 | Low |

## 依存関係の変化

### 新規依存

```
package.json
  +-- dotenv (新規追加必要)
```

**推奨バージョン**: `^16.0.0`

**代替手段**:
- Node.js 20.6+ の `--env-file` フラグ
- `fs.readFileSync` + 手動パース

**推奨**: dotenvパッケージの使用（広く使用されている安定したライブラリ）

### モジュール間依存の変化

```
変更前:
  start.ts ----> daemon.ts ----> pid-manager.ts
  stop.ts  ----> daemon.ts ----> pid-manager.ts
  status.ts ---> daemon.ts ----> pid-manager.ts
  init.ts -----> env-setup.ts

変更後:
  start.ts ----> daemon.ts ----> pid-manager.ts
      |              |
      +-----> env-setup.ts <----+
                   ^
  stop.ts  --------+
  status.ts -------+
  init.ts ---------+
```

依存方向は `commands -> utils` の一方向を維持しており、適切な設計となっている。

## 必須改善項目（Must Fix）

### MF-1: dotenv依存の追加

**重要度**: High

**場所**: package.json / src/cli/utils/daemon.ts

**問題点**: 設計書ではdaemon.tsでdotenvパッケージを使用して.envファイルを読み込む予定だが、現在のpackage.jsonにdotenvが依存関係として含まれていない。この依存関係の追加が明示的に計画されていない。

**推奨対応**:
1. 設計書に「dotenvパッケージをdependenciesに追加する」旨を明記
2. 実装時に `npm install dotenv` を実行
3. package.jsonのdependenciesに追加

```bash
npm install dotenv
```

### MF-2: getStatus()の設定値取得問題

**重要度**: High

**場所**: src/cli/utils/daemon.ts getStatus()

**問題点**: daemon.tsのgetStatus()メソッドは現在process.envから直接CM_PORT、CM_BINDを読み取っている。設計変更後、.envファイルはstart()メソッド内でのみ読み込まれるため、stop/statusコマンド実行時は.envを読み込まない。そのため、getStatus()が正しいポート/URL情報を取得できない可能性がある。

**現在の実装（daemon.ts:125-128）**:
```typescript
// Get port from environment or default
const port = parseInt(process.env.CM_PORT || '3000', 10);
const bind = process.env.CM_BIND || '127.0.0.1';
const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}`;
```

**推奨対応**（いずれかを選択）:

1. **getStatus()内でもdotenv.config()を呼び出す**
   ```typescript
   async getStatus(): Promise<DaemonStatus | null> {
     // .envを読み込んで設定値を取得
     const envPath = getEnvPath();
     dotenvConfig({ path: envPath });
     // ...
   }
   ```

2. **PIDファイルにポート情報も記録する**（実装変更が大きい）

3. **ドキュメントに動作を明記**
   - 「statusコマンドは実行時の環境変数またはデフォルト値を使用する」と明記

## 推奨改善項目（Should Fix）

### SF-1: env-setup.tsの責務増加

**重要度**: Medium

**問題点**: getPidFilePath()をenv-setup.tsに追加することで、「環境設定ファイルの管理」に加えて「PIDファイルパス管理」という責務が混在する。

**推奨対応**: 短期的にはenv-setup.tsへの追加で問題ないが、以下のコメントを追加:

```typescript
/**
 * PIDファイルのパスを取得する
 *
 * NOTE: 将来的にはpaths.tsへの分離を検討
 * @see Issue #125 Stage 3 Review SF-1
 */
export function getPidFilePath(): string {
  return join(getConfigDir(), '.commandmate.pid');
}
```

### SF-2: 後方互換性のマイグレーションパス

**重要度**: Medium

**問題点**: 既存ユーザーがグローバルインストールにアップグレードした場合、カレントディレクトリの.commandmate.pidが残存し、混乱を招く可能性がある。

**推奨対応**: CHANGELOG.mdに以下の移行手順を追記:

```markdown
### Migration from Local to Global Install

1. Stop the server with the old version: `commandmate stop`
2. Remove legacy PID file: `rm .commandmate.pid`
3. Install globally: `npm install -g commandmate`
4. Re-initialize: `commandmate init`
5. Start the server: `commandmate start`
```

### SF-3: パフォーマンス影響（対応不要）

**重要度**: Low

**問題点**: .envファイルへの2回アクセス（存在確認 + 読み込み）

**評価**: 起動時のオーバーヘッドは1-5ms程度であり、無視できるレベル。OSキャッシュにより2回目のアクセスは高速。

**推奨対応**: 現時点での対応は不要。

### SF-4: デバッグ容易性の向上

**重要度**: Medium

**問題点**: 設定ファイルパスがグローバル/ローカルで異なる場合、どちらの設定が使用されているか判断しにくい。

**推奨対応**: 以下のログ出力を追加:

```typescript
// start.ts
const envPath = getEnvPath();
logger.debug(`Using config: ${envPath}`);
```

statusコマンドの出力にも追加:

```typescript
// status.ts
console.log(`Config:  ${getEnvPath()}`);
console.log(`PID:     ${getPidFilePath()}`);
```

## 後方互換性評価

| 項目 | 状態 | リスク | 備考 |
|------|------|--------|------|
| ローカルインストール | 維持 | Low | isGlobalInstall()=falseでprocess.cwd()ベース動作維持 |
| グローバルインストール（既存ユーザー） | 移行必要 | Medium | レガシーPIDファイル残存リスク |
| .envファイル形式 | 維持 | None | フォーマット変更なし |
| CLIコマンドインターフェース | 維持 | None | 引数・オプション変更なし |

## パフォーマンス影響評価

| 項目 | オーバーヘッド | 評価 | 対応 |
|------|---------------|------|------|
| 起動時間 | 1-5ms | 無視可能 | 不要 |
| ファイルI/O | 1-2ms | 無視可能 | 不要 |
| メモリ使用量 | ~100KB | 無視可能 | 不要 |

## 運用・保守への影響

### デバッグ

**現状**: 設定ファイルパスがログに出力されない

**推奨改善**: 起動時ログとstatusコマンド出力に設定ファイルパスを追加

### ログ出力

**現状**: CLIログは標準出力に出力

**影響**: daemon.tsでenvResult.errorの警告ログが追加（設計書反映済み）

**評価**: ポジティブな変更

### 監視

**現状**: PIDファイルによるプロセス監視

**影響**: PIDファイル配置場所変更により、既存監視スクリプトの更新が必要な場合あり

**推奨**: ドキュメントに新しいPIDファイルパスを明記

## 良い設計パターン

1. **影響範囲の限定**: 変更対象をCLIモジュールに限定、Web UI/APIへの影響なし
2. **依存方向の維持**: commands -> utils の一方向依存を維持
3. **init.tsの影響回避**: 既にgetEnvPath()を使用しているため変更不要
4. **テスト計画の具体性**: グローバル/ローカル両シナリオのテストケース定義

## リスク評価サマリー

| リスク種別 | 影響度 | 発生確率 | 対策優先度 |
|-----------|--------|---------|-----------|
| dotenv依存漏れ | Medium | High | P1 |
| getStatus()設定値 | Medium | Medium | P1 |
| レガシーPID残存 | Low | Medium | P2 |
| パフォーマンス劣化 | Negligible | Low | P3 |

## 結論

設計変更の影響範囲は適切にスコープ管理されている。MF-1（dotenv依存追加）とMF-2（getStatus()の設定値取得）の2点を修正すれば、実装に進んで問題ない。

---

## レビュー履歴

| ステージ | 日付 | フォーカス | Must Fix | Should Fix |
|---------|------|-----------|----------|------------|
| Stage 1 | 2026-02-02 | 設計原則 | 2 | 4 |
| Stage 2 | 2026-02-02 | 整合性 | 3 | 4 |
| Stage 3 | 2026-02-02 | 影響範囲 | 2 | 4 |

---

**レビュアー**: Architecture Review Agent
**レビュー完了日**: 2026-02-02
