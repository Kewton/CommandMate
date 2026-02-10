# Issue #11 レビューレポート（Stage 7）

**レビュー日**: 2026-02-10
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目

## 前回指摘（Stage 3）の検証結果

Stage 3で挙げた全8件の指摘事項について、Stage 4・Stage 6の反映状況を検証した。

| ID | カテゴリ | ステータス | 備考 |
|----|---------|-----------|------|
| MF-1 | 影響ファイル | **解決済み** | 段階的適用計画（Phase 1/2）、高頻度APIへの対策、型設計の考慮事項が詳細に記載 |
| MF-2 | 依存関係 | **解決済み** | サーバーサイド実行を明記、実装方式(A)を推奨として記載 |
| SF-1 | テスト範囲 | **解決済み** | テスト計画を4つのサブタスクに詳細化 |
| SF-2 | 破壊的変更 | **解決済み** | logger.tsへの変更不要を明記、7モジュール名を列挙 |
| SF-3 | 影響ファイル | **解決済み** | 既存ログ取得API・api-client.tsを影響範囲テーブルに追加 |
| SF-4 | 移行考慮 | **解決済み** | debugレベル設定、truncation、console出力のみを明記 |
| NTH-1 | ドキュメント | **解決済み** | CLAUDE.md更新タスクを追加 |
| NTH-2 | テスト範囲 | **スキップ承認** | スコープ上の判断として妥当 |

**結論**: Stage 3の指摘事項は全て適切に反映されている。

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: 既存結合テスト（api-logs.test.ts）が現在のroute.ts実装と乖離

**カテゴリ**: テスト範囲
**場所**: `tests/integration/api-logs.test.ts` 全体

**問題**:
既存の結合テストファイル `tests/integration/api-logs.test.ts` が、現在のログファイルAPI実装（`src/app/api/worktrees/[id]/logs/[filename]/route.ts`）と複数の点で乖離している。サニタイズオプション（`?sanitize=true`）を追加する際に、このテストの修正が前提条件となる。

**具体的な乖離箇所**:

| 項目 | テスト（api-logs.test.ts） | 実装（route.ts） |
|------|--------------------------|-----------------|
| ファイルシステムAPI | `fs`（同期: existsSync, readdirSync, readFileSync, statSync）をモック | `fs/promises`（非同期: fs.stat, fs.readFile）を使用 |
| 許可ファイル形式 | `.jsonl` を期待 | `.md` のみ許可 |
| バリデーションエラー | `'must be a .jsonl file'` を検証 | `'Invalid filename'` を返す |
| ファイル名検証 | worktree IDプレフィックスの検証なし | `filename.startsWith(params.id + '-')` を要求 |

**証拠**:
- `tests/integration/api-logs.test.ts` Line 46-52: `vi.mock('fs', ...)` で同期APIをモック
- `tests/integration/api-logs.test.ts` Line 268-285: `.jsonl` バリデーションを検証
- `src/app/api/worktrees/[id]/logs/[filename]/route.ts` Line 10: `import fs from 'fs/promises'`
- `src/app/api/worktrees/[id]/logs/[filename]/route.ts` Line 36: `.md` バリデーション

**推奨対応**:
Issueの実装タスクに「既存結合テスト（api-logs.test.ts）の修正 -- 現在のroute.ts実装との整合性回復」を追加すべき。サニタイズオプション追加のテストは、この修正を前提として構築する必要がある。

---

## Should Fix（推奨対応）

### SF-1: ハンドラー関数の総数が不正確（46 -> 48）

**カテゴリ**: 影響ファイル
**場所**: 提案する解決策 - 3. APIリクエスト/レスポンスログ

**問題**:
Issue内の複数箇所で「計46ハンドラー」と記載されているが、実測では48のハンドラー関数が存在する。

**証拠**:
`src/app/api/` 配下の全route.tsファイルから `export async function (GET|POST|PATCH|PUT|DELETE)` パターンで検索した結果、48件がヒット。分布は GET: 19、POST: 16、PATCH: 6、PUT: 3、DELETE: 4。

**推奨対応**:
「計46ハンドラー」を「計48ハンドラー」に修正。Phase 2の作業量見積もりに影響するため正確な数値が必要。

---

### SF-2: api-client.tsのgetLogFile()メソッドの型乖離とサニタイズオプション追加設計の具体化

**カテゴリ**: 影響ファイル
**場所**: 影響範囲 - 変更対象ファイル: `src/lib/api-client.ts`

**問題**:
現在の `api-client.ts` の `getLogFile()` メソッドの戻り値型は `{ filename, content, size, modifiedAt }` だが、実際のAPIレスポンスは `cliToolId` も含んでいる（型の乖離）。サニタイズオプション追加時のメソッドシグネチャ変更設計が具体化されていない。

**証拠**:
- `src/lib/api-client.ts` Line 194-201: 戻り値型に `cliToolId` が欠落
- `src/app/api/worktrees/[id]/logs/[filename]/route.ts` Line 88-96: レスポンスに `cliToolId` を含む

**推奨対応**:
実装タスクの「api-client.tsにサニタイズ済みログ取得メソッド追加」に以下の具体的な変更内容を補記:
1. `getLogFile()` メソッドの戻り値型に `cliToolId` を追加（既存の型乖離の修正）
2. オプショナルな `options` パラメータの追加（例: `{ sanitize?: boolean }`）
3. URLにクエリパラメータを付加するロジックの追加

---

### SF-3: dynamic = 'force-dynamic' を持つroute.tsの具体的なリスト記載

**カテゴリ**: 破壊的変更
**場所**: 提案する解決策 - 3. APIリクエスト/レスポンスログ - withLogging()ヘルパーの設計考慮事項

**問題**:
Issueでは「export const dynamic = 'force-dynamic'等の設定エクスポートには影響しない設計とする」と記載されているが、該当ファイルのリストが示されていない。

**証拠**:
以下の4つのroute.tsが `export const dynamic = 'force-dynamic'` を持つ:
1. `src/app/api/external-apps/[id]/route.ts`
2. `src/app/api/external-apps/route.ts`
3. `src/app/api/external-apps/[id]/health/route.ts`
4. `src/app/api/worktrees/route.ts`

特に (4) の `worktrees/route.ts` はPhase 1の適用対象候補でありポーリング対象でもある。

**推奨対応**:
設計考慮事項に該当する4ファイルのリストを追加。withLogging()のハンドラーラップ方式がモジュールレベルのconst exportに影響しないことを確認するヒントとして記載すると実装時の参照になる。

---

## Nice to Have（あれば良い）

### NTH-1: HOMEの取得方法がgetEnv()のスコープ外

**カテゴリ**: 依存関係
**場所**: 提案する解決策 - 2. エクスポート時の機密情報サニタイズ

**問題**:
サニタイズ対象にHOMEディレクトリが含まれているが、`getEnv()` の `Env` interfaceには `HOME` が含まれていない（`CM_ROOT_DIR`, `CM_PORT`, `CM_BIND`, `CM_DB_PATH` のみ）。HOMEの取得は `process.env.HOME` の直接参照が必要。

**証拠**:
- `src/lib/env.ts` Line 172-184: `Env` interfaceの定義

**推奨対応**:
`log-export-sanitizer.ts` の実装時にHOMEの取得方法（`process.env.HOME` の直接参照）を考慮する旨を、サニタイズ対象の説明に注記として追加すると実装がスムーズになる。また、`CM_ROOT_DIR` 未設定時のフォールバック値（`process.cwd()`）によるサニタイズも考慮すべきエッジケースとなる。

---

### NTH-2: withLogging()のNODE_ENV=production非出力テストの環境考慮

**カテゴリ**: テスト範囲
**場所**: 受入条件 - 開発環境APIログ

**問題**:
受入条件に「本番環境ではAPIリクエスト/レスポンスの詳細ログが出力されないこと」が含まれているが、VitestのテストではNODE_ENVがデフォルトで `'test'` であるため、NODE_ENV='production' のテストには工夫が必要。

**推奨対応**:
テスト実装時のヒントとして、withLogging()が環境変数を参照する部分をモック可能な設計にする旨を記載しておくと、テスト実装がスムーズになる。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/app/api/worktrees/[id]/logs/[filename]/route.ts` | サニタイズオプション追加の直接変更対象。fs/promises使用。requestパラメータ未使用（searchParams参照の追加が必要） |
| `tests/integration/api-logs.test.ts` | 既存結合テスト。route.ts実装との乖離あり。修正が前提条件 |
| `src/lib/api-client.ts` | getLogFile()の型乖離。サニタイズオプション追加でメソッドシグネチャ変更が必要 |
| `src/lib/env.ts` | サニタイズ対象値の取得元。HOMEはスコープ外 |
| `src/lib/logger.ts` | withLogging()が利用するcreateLogger()の定義元。変更不要を確認済み |
| `src/app/api/worktrees/route.ts` | dynamic = 'force-dynamic' + ポーリング対象 + Phase 1適用候補 |
| `src/components/worktree/LogViewer.tsx` | エクスポートボタン追加先。既存のloadLogFile()を拡張してサニタイズ版取得に対応 |
| `src/lib/log-manager.ts` | 変更不要を確認済み。logs/route.tsはlistLogs()を使用 |
| `src/lib/clipboard-utils.ts` | copyToClipboard()をそのまま利用。変更不要を確認済み |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | 主要機能モジュールテーブルの更新（log-export-sanitizer.ts, api-logger.ts追加）が実装タスクに記載済み |
