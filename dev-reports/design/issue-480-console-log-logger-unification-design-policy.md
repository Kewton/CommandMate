# Issue #480 設計方針書: console.log 整理・logger統一（R-2）

## 概要

`src/` 配下（`src/cli/` 除く）の `console.log`・`console.error`・`console.warn` を `src/lib/logger.ts` の `createLogger()` 経由に統一するリファクタリング。

## 対象スコープ

| 対象 | 件数 | 備考 |
|------|------|------|
| `src/lib/` 配下 | 約220件 | メイン対象 |
| `src/app/api/` 配下 | 約80件 | APIルート |
| `src/components/` 配下 | 約35件（console.log/error/warn含む） | クライアントサイド（3段階対応、詳細は後述） |
| `src/hooks/` 配下 | 実行コード console.error 2件（残置対象）、JSDoc内5件（対象外） | console.error は残置方針のため実質移行不要 |
| **実移行対象合計** | **約340件** | JSDoc内・logger.ts内部・env.ts（3件）除く |

> **[DS1-001] 修正**: src/components/ の件数を約2件から約35件に更新。console.errorは原則残置のため、移行対象合計も見直し済み。
>
> **[DS2-001/DS2-002/DS2-003] 修正**: Stage 2整合性レビューにより実測値に更新。src/lib/ を約125件→約220件（db-migrations.tsは53→57件）、src/app/api/ を約15件→約80件、実移行対象合計を約170件→約340件に修正。src/hooks/ も実測値に更新（DS2-006）。

## 既存 logger モジュール仕様

```typescript
// src/lib/logger.ts
import { createLogger } from '@/lib/logger';

const logger = createLogger('module-name');  // モジュール名を渡す

logger.debug('action', { key: value });     // デバッグ用（LOG_LEVELで制御）
logger.info('action', { key: value });      // 通常情報
logger.warn('action', { key: value });      // 警告
logger.error('action', { key: value });     // エラー
```

- **センシティブデータフィルタリング**: 自動サニタイズあり
- **ログレベル制御**: `LOG_LEVEL` 環境変数で制御（debug < info < warn < error）
- **サーバー/クライアント分離**: `isServer()` チェックあり
- **依存チェーン**: `logger.ts` → `env.ts` → `db-path-resolver.ts` → Node.js専用モジュール
- **ログ出力形式**: `LOG_FORMAT` 環境変数で制御（`text`（デフォルト）/ `json`）

### 依存制約

> **[DS3-003] 追記**: logger.tsのランタイム制約を明記。

| 制約 | 理由 | 対象ファイル例 |
|------|------|---------------|
| **Edge Runtimeでのimport禁止** | logger.ts → env.ts → db-path-resolver.ts がNode.js専用APIに依存 | `src/middleware.ts` |
| **クライアントコンポーネントでのimport禁止** | 同上。`'use client'` ファイルでは `createLogger()` を使用不可 | `src/components/**/*.tsx` |
| **env.tsでの使用禁止** | 循環依存を避けるため | `src/lib/env.ts` |

`src/middleware.ts` は Edge Runtime で動作するため、`@/lib/logger` を絶対にimportしてはならない。middleware内のログ出力が必要な場合は `console.warn` / `console.error` を直接使用すること。

## 設計方針

### 1. ログレベル割り当て方針

| 元の console | 方針 | 対象例 |
|-------------|------|--------|
| `console.log`（マイグレーション進捗） | `logger.info()` | db-migrations.ts の進捗メッセージ |
| `console.log`（デバッグ情報） | `logger.debug()` | claude-session.ts, codex.ts 等 |
| `console.log`（運用ログ） | `logger.info()` | schedule-manager.ts, resource-cleanup.ts |
| `console.error` | `logger.error()` | DB エラー等 |
| `console.warn` | `logger.warn()` | 警告メッセージ |

### 2. 対象外の明示

以下は本Issueの移行対象**外**:

- `src/cli/` 配下: 正当なユーザー向けCLI出力
- `src/lib/logger.ts` 内部: loggerの実装本体
- `src/lib/env.ts` の `console.warn`（3件）: logger.tsがenv.tsに依存するため循環依存を避ける
- JSDocコメント（`@example` ブロック等）内の `console.log`

### 3. クライアントサイド対応（3段階方針）

`logger.ts` はNode.js専用モジュール依存があるため `'use client'` コンポーネントで使用不可。

> **[DS1-007] 修正**: クライアントサイドの console 出力を一律削除ではなく、以下の3段階で対応する。

#### 3段階対応方針

| レベル | 方針 | 理由 |
|--------|------|------|
| `console.log` | **削除** | デバッグ目的のログは本番環境に不要 |
| `console.warn` | **削除** | 警告ログも本番環境では不要。重要なものはエラーに昇格を検討 |
| `console.error` | **原則残置** | ブラウザのエラーハンドリング・デバッグに必要な正当なエラー報告。catch節でのエラー通知等は残す |

**影響対象（実行コードとしての console 出力を持つもの）**:

- `src/components/` 配下: 約35件
  - `console.log` → 削除
  - `console.warn` → 削除
  - `console.error` → 残置（正当なエラーハンドリング用途）

#### client-logger.ts 導入判断基準

> **[DS1-006]**: 将来的にクライアント側のロギング需要が増えた場合（console.log の削除対象が5件以上発生するような新規開発時）、`src/lib/client-logger.ts` を導入する。導入する場合はサーバー側 `logger.ts` と同じインターフェース（`debug`, `info`, `warn`, `error`, `withContext`）を持たせ、互換性を確保する。

### 4. db-migrations.ts の対応

`db-migrations.ts`（57件）はアプリ起動の最初期に実行されるが、`logger.ts` → `env.ts` → `db-path-resolver.ts` の依存チェーンに DB 操作は含まれず、`getLogConfig()` は環境変数読み取りのみのため**循環依存は発生しない**。通常どおり `createLogger('db-migrations')` で対応可能。

> **[DS1-002] 注意**: db-migrations.ts は57件と最多件数であり、一括移行はリスクが高い。可能であれば独立したPRとして分離し、レビュー負荷を軽減することを推奨する。マイグレーションの起動時実行という特性上、デグレが発生した場合の影響範囲が広いため、個別に動作確認を行うこと。

### 5. テスト修正方針

console.log を直接 spy しているテストを logger モック方式に切り替える。

**影響テスト**:
- `tests/integration/trust-dialog-auto-response.test.ts`（119行目）— console.log spy
- `tests/unit/lib/schedule-manager.test.ts`（130行目、367行目）— console.log spy, console.warn spy

> **[DS2-007/DS2-008] 修正**: Stage 2整合性レビューにより影響テスト一覧を拡充し、行番号を実測値に更新。console.warn spy を含むテストも対象に追記。
>
> **[DS3-001/DS3-002] 修正**: Stage 3影響分析により、存在しない6ファイルを削除し、漏れていた5ファイルを追加。実在するファイルのみの正確な一覧に修正。
>
> 以下は console.log/warn/error/debug を spy または直接使用しているテストファイルの完全一覧:
>
> | テストファイル | spy対象 | 備考 |
> |--------------|---------|------|
> | `tests/integration/trust-dialog-auto-response.test.ts` | console.log | 119行目 |
> | `tests/unit/lib/schedule-manager.test.ts` | console.log, console.warn | 130行目、367行目 |
> | `tests/unit/lib/db-migrations.test.ts` | console.log | マイグレーション出力検証 |
> | `tests/unit/lib/response-poller.test.ts` | console.log | ポーリングログ検証 |
> | `tests/unit/lib/claude-session.test.ts` | console.log | セッション管理ログ検証 |
> | `tests/unit/lib/clone-manager.test.ts` | console.log | クローン処理ログ検証 |
> | `tests/unit/lib/auto-yes-manager.test.ts` | console.log | Auto-Yesログ検証 |
> | `tests/unit/lib/tmux-capture-cache.test.ts` | console.debug | 233行目、logger.debugモックに置換対象 |
> | `tests/unit/lib/cmate-parser.test.ts` | console.warn | 171行目他（5箇所）、logger.warnモックに置換対象 |
> | `tests/integration/security.test.ts` | console.warn | 231行目 |
> | `tests/integration/auth-middleware.test.ts` | console.warn | 252行目、262行目、272行目 |
> | `tests/unit/prompt-detector-cache.test.ts` | console.log, console.warn, console.error | 25-28行目、logger内部出力の抑制用spy |

**推奨方式**:
```typescript
// NG: console.log spy（loggerの内部実装に脆弱）
const consoleSpy = vi.spyOn(console, 'log');

// OK: logger モジュールのモック化
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
}));
// または logger.info 等の呼び出し回数・引数を検証
```

> **[DS3-009] 追記**: `console.debug` spyを使用しているテスト（`tmux-capture-cache.test.ts` 233行目）は、logger移行後に `logger.debug` モックへの置換が必要。`console.debug` はlogger内部で使用されないため、spy対象を変更すること。

> **[DS1-005] 推奨**: 上記のloggerモックパターンは複数テストで繰り返し使用されるため、`tests/helpers/logger-mock.ts` として共通ヘルパーに切り出すことを推奨する。以下のようなファクトリ関数を提供する:
>
> ```typescript
> // tests/helpers/logger-mock.ts
> export function createMockLogger() {
>   return {
>     debug: vi.fn(),
>     info: vi.fn(),
>     warn: vi.fn(),
>     error: vi.fn(),
>     withContext: vi.fn(),
>   };
> }
>
> export function mockLoggerModule() {
>   vi.mock('@/lib/logger', () => ({
>     createLogger: vi.fn(() => createMockLogger()),
>   }));
> }
> ```

### 6. action名の命名規則

```
'<動詞>:<対象>'  例: 'session:start', 'migration:completed', 'cache:hit'
```

> **[SEC4-001] 追記**: action引数は必ず**静的文字列リテラル**のみを使用すること。動的な値（ユーザー入力、変数展開等）はaction引数に含めず、data引数に渡す。
>
> ```typescript
> // NG: action引数に動的値を含める
> logger.info(`migration:${migrationName}`, {});
>
> // OK: action引数は静的、動的値はdata引数に
> logger.info('migration:start', { name: migrationName });
> ```

> **[DS1-004] 追記**: 以下に推奨動詞リストと db-migrations.ts の代表的な変換例を示す。

#### 推奨動詞リスト

| 動詞 | 用途 | 例 |
|------|------|-----|
| `start` / `stop` | 処理の開始・終了 | `'session:start'`, `'poller:stop'` |
| `completed` / `failed` | 処理の成功・失敗 | `'migration:completed'`, `'query:failed'` |
| `create` / `delete` | リソースの生成・削除 | `'table:create'`, `'session:delete'` |
| `hit` / `miss` | キャッシュ等の該否 | `'cache:hit'`, `'cache:miss'` |
| `detect` | 状態検出 | `'status:detect'`, `'prompt:detect'` |
| `skip` | スキップ | `'migration:skip'`, `'check:skip'` |
| `retry` | リトライ | `'connection:retry'` |

#### db-migrations.ts 変換例

| 変更前（console.log） | 変更後（logger） |
|----------------------|-----------------|
| `console.log('Running migration:', name)` | `logger.info('migration:start', { name })` |
| `console.log('Migration completed:', name)` | `logger.info('migration:completed', { name })` |
| `console.log('Skipping migration:', name)` | `logger.debug('migration:skip', { name })` |
| `console.log('Creating table:', tableName)` | `logger.info('table:create', { tableName })` |
| `console.error('Migration failed:', error)` | `logger.error('migration:failed', { error: error.message })` + `logger.debug('migration:failed:detail', { stack: error.stack })` |

> **[SEC4-002] 追記**: `db-migrations.ts` 等のエラーログでは `error.message` のみを `logger.error()` で記録し、スタックトレースは `logger.debug()` レベルで分離する。これにより本番環境でスタックトレースが出力されることを防ぎ、情報漏洩リスクを低減する。
>
> ```typescript
> // 推奨パターン
> try {
>   // migration処理
> } catch (error) {
>   const err = error instanceof Error ? error : new Error(String(error));
>   logger.error('migration:failed', { error: err.message });
>   logger.debug('migration:failed:detail', { stack: err.stack });
> }
> ```

## 前提条件

> **[DS1-003] 変更**: 旧Phase 1（確認のみ）の内容を前提条件として切り出し。実作業フェーズを1-3に再番号付け。

既に `createLogger` 導入済みのファイル（8ファイル）に `console.log` 残存がないことを確認済み。現時点では全て0件で完全移行済み。

```
src/lib/cli-session.ts, src/lib/prompt-detector.ts, src/lib/cli-patterns.ts,
src/lib/pasted-text-helper.ts, src/lib/tmux-control-client.ts,
src/lib/tmux-control-registry.ts,
src/app/api/worktrees/[id]/interrupt/route.ts,
src/app/api/worktrees/[id]/search/route.ts
```

## 段階的移行フェーズ

### Phase 1: src/lib/ 配下のサーバーサイドモジュール

優先度高・最多件数のファイルから移行。

| ファイル | 件数 | モジュール名 |
|---------|------|------------|
| `src/lib/db-migrations.ts` | 57 | `'db-migrations'` |
| `src/lib/schedule-manager.ts` | 21 | `'schedule-manager'` |
| `src/lib/claude-session.ts` | 13 | `'claude-session'` |
| `src/lib/resource-cleanup.ts` | 11 | `'resource-cleanup'` |
| `src/lib/cli-tools/codex.ts` | 11 | `'cli-tools/codex'` |
| `src/lib/cli-tools/opencode-config.ts` | 11 | `'cli-tools/opencode-config'` |
| `src/lib/ws-server.ts` | 10 | `'ws-server'` |
| `src/lib/cli-tools/gemini.ts` | 9 | `'cli-tools/gemini'` |
| `src/lib/response-poller.ts` | 8 | `'response-poller'` |
| `src/lib/cmate-parser.ts` | 8 | `'cmate-parser'` |
| `src/lib/assistant-response-saver.ts` | 6 | `'assistant-response-saver'` |
| `src/app/api/worktrees/[...]/worktrees.ts` | 6 | `'api/worktrees'` |
| `src/lib/db-migration-path.ts` | 6 | `'db-migration-path'` |
| `src/lib/auto-yes-manager.ts` | 6 | `'auto-yes-manager'` |
| `src/lib/clone-manager.ts` | 5 | `'clone-manager'` |
| `src/lib/cli-tools/vibe-local.ts` | 5 | `'cli-tools/vibe-local'` |
| `src/lib/cli-tools/opencode.ts` | 5 | `'cli-tools/opencode'` |
| `src/lib/slash-commands.ts` | 5 | `'slash-commands'` |
| `src/lib/session-cleanup.ts` | 5 | `'session-cleanup'` |
| その他 src/lib/ 残ファイル | 約32 | 各ファイル名 |

> **[DS2-004/DS2-005] 修正**: Stage 2整合性レビューにより個別ファイル件数を実測値に更新し、主要未記載ファイルを追記。「その他」を約20件→約32件に更新（総数約220件との整合性を確保）。
>
> **[DS1-002]**: db-migrations.ts（57件）は可能であれば独立PRとして分離を推奨。

**完了時確認**: `npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:integration && npm run build`

> **[DS1-008] 追記**: test:integration を完了確認コマンドに追加。trust-dialog-auto-response.test.ts 等のlogger関連テストが結合テストに含まれるため。
>
> **[DS3-004] 追記**: Phase 1完了時に `npm run build` チェックを追加。logger.tsのimport追加によりバンドルサイズやTree Shakingへの影響がないことを確認するため。

### Phase 2: src/app/api/ 配下のAPIルート

APIルートハンドラの `console.log` を `logger` 経由に変更。

**完了時確認**: `npm run lint && npx tsc --noEmit && npm run test:unit && npm run test:integration`

### Phase 3: src/components/, src/hooks/ のクライアントサイド

3段階方針に従い対応:

- `console.log` → **削除**
- `console.warn` → **削除**
- `console.error` → **残置**（正当なエラーハンドリング用途）

> **[DS2-012] 追記**: クライアントサイドの console 出力件数内訳（実測値）:
>
> | 種別 | 件数 | 対応 |
> |------|------|------|
> | `console.log` | 5件 | 削除 |
> | `console.warn` | 1件 | 削除 |
> | `console.error` | 29件 | 残置（正当なエラーハンドリング用途） |
> | **合計** | **35件** | 実質移行（削除）対象は6件 |

**完了時確認**: `npm run lint && npx tsc --noEmit && npm run test:unit`

## 実装パターン

### 基本パターン（サーバーサイド）

```typescript
// 変更前
console.log('Migration completed:', migrationName);
console.error('Migration failed:', error);

// 変更後
import { createLogger } from '@/lib/logger';
const logger = createLogger('db-migrations');

logger.info('migration:completed', { migrationName });
logger.error('migration:failed', { error: String(error) });
```

## セキュリティガイドライン

> **[SEC4-006] 追記**: logger の data 引数に含めてよい情報の基準を定義する。

### data引数の情報基準

| 分類 | 許可/禁止 | 例 |
|------|----------|-----|
| **認証情報** | **禁止** | トークン、パスワード、APIキー、セッションID |
| **環境変数の値** | **禁止** | `process.env.*` の生値（キー名のみ許可） |
| **ファイルパス** | **許可** | worktreeパス、設定ファイルパス |
| **worktreeId** | **許可** | リソース識別子 |
| **マイグレーション名** | **許可** | テーブル名、カラム名 |
| **エラーメッセージ** | **許可**（errorレベルのみ） | `error.message`（スタックはdebugのみ） |
| **ユーザー入力** | **debugレベルのみ** | コマンド引数、検索クエリ等 |

> **注意**: logger.ts には自動サニタイズ機能があるが、入力段階で不要な情報を渡さないことが第一の防御線となる。

### クライアントサイド console.error 残置基準

> **[SEC4-005] 追記**: クライアントサイドで残置する `console.error` の出力基準を定義する。

- サーバーエラーレスポンスをログ出力する場合は、**`message` フィールドのみ**を出力する
- レスポンスボディ全体やヘッダー情報を `console.error` に渡さない
- スタックトレースやサーバー内部情報がクライアントに漏洩しないよう、APIレスポンス設計と合わせて確認する

```typescript
// NG: レスポンス全体をログ出力
console.error('API error:', response);

// OK: messageフィールドのみ
console.error('API error:', data.message);
```

### 本番環境の運用注意事項

> **[SEC4-003] 追記**: `CM_LOG_LEVEL=debug` 設定時の注意事項。

本番環境で `CM_LOG_LEVEL=debug` を設定した場合、ユーザー入力やスタックトレースなど詳細情報がログに出力される。本番でのdebugレベル有効化は一時的なトラブルシューティングに限定し、調査完了後は速やかに `info` 以上に戻すこと。長期間debugレベルで運用しないこと。

## ESLint no-console ルール段階的有効化

> **[DS3-005] 追記**: 移行済みスコープの退行防止のため、ESLint `no-console` ルールを段階的に有効化する。

### 有効化スケジュール

| タイミング | 対象スコープ | 設定方法 |
|-----------|-------------|---------|
| Phase 1 完了時 | `src/lib/**/*.ts` | overrides で warn レベルで有効化 |
| Phase 2 完了時 | `src/app/api/**/*.ts` | overrides に追加 |
| Phase 3 完了時 | `src/components/**/*.tsx`, `src/hooks/**/*.ts`（console.error は allowedMethods で除外） | overrides に追加 |
| 全Phase完了後 | `src/` 全体（`src/cli/`, `src/lib/logger.ts`, `src/lib/env.ts` は除外） | error レベルに昇格 |

### 設定例

```javascript
// .eslintrc.js (overrides 追加例)
{
  overrides: [
    {
      files: ['src/lib/**/*.ts'],
      excludedFiles: ['src/lib/logger.ts', 'src/lib/env.ts'],
      rules: {
        'no-console': 'warn'  // Phase 1完了後
      }
    }
  ]
}
```

## ログ出力形式の運用影響

> **[DS3-006] 追記**: console.log からloggerへの移行により、ログ出力形式が変更される。

### 形式比較

| 項目 | 変更前（console.log） | 変更後（logger / text形式） |
|------|---------------------|---------------------------|
| 出力例 | `Running migration: 001_init` | `[INFO] db-migrations migration:start {"name":"001_init"}` |
| タイムスタンプ | なし | なし（text形式） |
| ログレベル | なし | `[DEBUG]`, `[INFO]`, `[WARN]`, `[ERROR]` |
| モジュール名 | なし | あり |
| 構造化データ | なし | JSON形式のdata引数 |

### LOG_FORMAT 設定

| 値 | 出力形式 | 用途 |
|----|---------|------|
| `text`（デフォルト） | `[LEVEL] module action {data}` | 開発環境・目視確認 |
| `json` | `{"level":"info","module":"...","action":"...","data":{}}` | 本番環境・ログ集約 |

> **注意**: `LOG_FORMAT` のデフォルトは `text` であり、明示的に設定しない限り開発者の目視確認に適した形式で出力される。既存のログ監視スクリプトや grep ベースの運用がある場合は、移行前に出力形式の変更を周知すること。

## PR分割戦略

> **[DS3-007] 追記**: レビュー負荷低減とリスク分散のため、以下のPR分割で実装する。

| PR | 内容 | 理由 |
|----|------|------|
| **PR-A** | `tests/helpers/logger-mock.ts` の作成 | 全テスト修正の前提となる共通ヘルパー。単独で先行マージ可能 |
| **PR-B** | `src/lib/db-migrations.ts` の logger 移行 + 関連テスト修正 | 57件と最多。起動時実行のため独立して動作確認が必要 |
| **PR-C** | Phase 1 の残りファイル（`src/lib/` 配下） | PR-A, PR-B マージ後に実施 |
| **PR-D** | Phase 2（`src/app/api/` 配下） | Phase 1 完了後 |
| **PR-E** | Phase 3（`src/components/`, `src/hooks/`）+ ESLint no-console 有効化 | 最終PR |

### マージ順序

```
PR-A → PR-B → PR-C → PR-D → PR-E
```

> 各PRは前段のPRがマージされた後にベースブランチを更新してから作成すること。コンフリクトを最小化するため、並行作業は避ける。

## 品質保証

### 受け入れ基準の検証コマンド

```bash
# 実行コード内のconsole.log/warn残存確認（console.errorはクライアント側で残置許可）
# サーバーサイド（console.log/error/warn 全て移行対象）
grep -r "console\.\(log\|error\|warn\)" src/lib/ src/app/ \
  --include="*.ts" --include="*.tsx" \
  | grep -v "src/cli/" \
  | grep -v "src/lib/logger\.ts" \
  | grep -v "src/lib/env\.ts" \
  | grep -v "node_modules" \
  | grep -v "\.test\." \
  | grep -v "^\s*//"

# クライアントサイド（console.log/warn のみ確認。console.errorは残置許可）
grep -r "console\.\(log\|warn\)" src/components/ src/hooks/ \
  --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules" \
  | grep -v "\.test\." \
  | grep -v "^\s*//"
```

### 最終品質チェック

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run test:integration
npm run build
```

## レビュー指摘反映サマリ（Stage 1: 設計原則レビュー）

| ID | 種別 | 内容 | 対応 |
|----|------|------|------|
| DS1-001 | Must Fix | src/components/ の件数が過小評価（約2件→約35件） | 対象スコープ表を修正、合計も更新 |
| DS1-007 | Must Fix | console.errorの一律削除は不適切 | 3段階方針を策定（log→削除、warn→削除、error→残置） |
| DS1-002 | Should Fix | db-migrations.ts（53件）の一括移行リスク | 独立PR分離の推奨を追記 |
| DS1-003 | Should Fix | Phase 1（確認のみ）はフェーズとして不要 | 前提条件セクションに切り出し、フェーズを再番号付け |
| DS1-004 | Should Fix | action名の命名規則に具体例が不足 | 推奨動詞リスト・db-migrations.ts変換例を追加 |
| DS1-005 | Nice to Have | loggerモックパターンの共通ヘルパー化 | tests/helpers/logger-mock.ts の推奨を追記 |
| DS1-006 | Nice to Have | client-logger.ts導入判断基準 | 5件以上の基準・インターフェース互換性方針を明記 |
| DS1-008 | Nice to Have | Phase完了確認にtest:integrationを追加 | Phase 1, 2の確認コマンドに追加 |

## レビュー指摘反映サマリ（Stage 2: 整合性レビュー）

| ID | 種別 | 内容 | 対応 |
|----|------|------|------|
| DS2-001 | Must Fix | src/lib/ 件数が過小評価（約125件→約220件） | 対象スコープ表を実測値に修正 |
| DS2-002 | Must Fix | src/app/api/ 件数が過小評価（約15件→約80件） | 対象スコープ表を実測値に修正 |
| DS2-003 | Must Fix | 実移行対象合計が過小評価（約170件→約340件） | 対象スコープ表を実測値に修正 |
| DS2-004 | Should Fix | Phase 1テーブルの個別ファイル件数が不正確 | 各ファイルの件数を実測値に更新 |
| DS2-005 | Should Fix | Phase 1テーブルの「その他: 約20件」が過小 | 主要未記載ファイル11件を追記、「その他」を約32件に更新 |
| DS2-006 | Should Fix | src/hooks/ の記載が不正確 | 実行コード console.error 2件（残置対象）、JSDoc内5件（対象外）に更新 |
| DS2-007 | Should Fix | 影響テスト一覧が不足 | 13ファイルの完全一覧を追記（console.warn spy含む） |
| DS2-008 | Should Fix | テストファイルの行番号が不正確 | trust-dialog: 146→119, schedule-manager: 136→130, 372→367 に修正 |
| DS2-009 | 変更不要 | logger.ts API仕様の記載は正確 | 確認済み、変更不要 |
| DS2-010 | 変更不要 | env.tsのconsole.warn 3件の記載は正確 | 確認済み、変更不要 |
| DS2-011 | 変更不要 | 前提条件の既移行8ファイル確認は正確 | 確認済み、変更不要 |
| DS2-012 | Nice to Have | Phase 3に console 種別ごとの件数内訳がない | log:5件→削除、warn:1件→削除、error:29件→残置 を追記 |

## レビュー指摘反映サマリ（Stage 3: 影響分析レビュー）

| ID | 種別 | 内容 | 対応 |
|----|------|------|------|
| DS3-001 | Must Fix | 影響テスト一覧に存在しないファイルが6件含まれている | 実在しない6ファイルを削除（resource-cleanup, assistant-response-saver, session-cleanup, codex, gemini, ws-server） |
| DS3-002 | Must Fix | console spyを使用する5ファイルが一覧から漏れている | 5ファイルを追加（tmux-capture-cache, cmate-parser, security, auth-middleware, prompt-detector-cache） |
| DS3-003 | Should Fix | logger.tsのEdge Runtime非対応の記載不足 | 「依存制約」セクションを追加し、middleware.tsでのimport禁止を明記 |
| DS3-004 | Should Fix | Phase 1完了時にbuildチェックがない | Phase 1完了時確認コマンドに `npm run build` を追加 |
| DS3-005 | Should Fix | ESLint no-consoleルールの段階的有効化が未記載 | 「ESLint no-console ルール段階的有効化」セクションを追加 |
| DS3-006 | Should Fix | ログ出力形式変更の運用影響が未記載 | 「ログ出力形式の運用影響」セクションを追加（text形式フォーマット例、LOG_FORMATデフォルト） |
| DS3-007 | Should Fix | PR分割戦略が未記載 | 「PR分割戦略」セクションを追加（PR-A〜PR-E、マージ順序） |
| DS3-009 | Nice to Have | console.debug spyのテスト修正方針が未記載 | テスト修正方針セクションにlogger.debugモック置換の注記を追加 |

## レビュー指摘反映サマリ（Stage 4: セキュリティレビュー）

| ID | 種別 | 内容 | 対応 |
|----|------|------|------|
| SEC4-006 | Must Fix | data引数に含めてよい情報の基準が未定義 | 「セキュリティガイドライン」セクションにdata引数情報基準表を追加 |
| SEC4-001 | Should Fix | action引数に動的値を渡すリスクが未記載 | action名命名規則に静的文字列のみ使用ルールを追記 |
| SEC4-002 | Should Fix | エラーログにスタックトレースが混入するリスク | db-migrations.ts変換例にerror.messageとstack分離パターンを追記 |
| SEC4-005 | Should Fix | クライアントサイドconsole.error残置の基準が未定義 | 「クライアントサイド console.error 残置基準」セクションを追加 |
| SEC4-003 | Nice to Have | 本番でCM_LOG_LEVEL=debug時の運用注意が未記載 | 「本番環境の運用注意事項」セクションを追加 |

## 設計上のトレードオフ

| 決定事項 | 採用理由 | トレードオフ |
|---------|---------|------------|
| 既存 logger.ts を活用 | 実装済み・センシティブデータ対応済み | Node.js依存でクライアント不可 |
| クライアントは3段階対応 | console.errorは正当なエラー報告として必要 | console.errorの残置によりログ出力は完全統一されない |
| vi.mockでテスト修正 | 実装変更に強いテスト | テストの変更量増加 |
| 段階的フェーズ移行 | レビュー負荷低減・リスク分散 | 移行期間中の不統一 |
| db-migrations.ts 独立PR推奨 | 57件の一括移行リスク軽減 | PR数増加・マージ管理の複雑化 |
| error.message/stack分離 | 本番でのスタックトレース漏洩防止 | debugレベルでないとスタック確認不可 |
| ESLint no-console段階的有効化 | 移行済みスコープの退行防止 | 設定の段階的更新が必要 |
| PR 5分割戦略 | レビュー負荷低減・個別動作確認 | マージ管理の複雑化・完了まで時間増加 |

## 関連ファイル

- `src/lib/logger.ts`: 統一先 logger モジュール
- `src/lib/env.ts`: logger の依存元（移行対象外）
- `src/lib/db-migrations.ts`: 最多件数（57件）
- `tests/integration/trust-dialog-auto-response.test.ts`: 修正対象テスト
- `tests/unit/lib/schedule-manager.test.ts`: 修正対象テスト
