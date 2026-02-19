# Issue #304 影響範囲レビューレポート

**レビュー日**: 2026-02-20
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 3 |
| **合計** | **8** |

---

## Must Fix（必須対応）

### R3-006: Viteの.env自動読み込みの影響範囲がenv.test.tsに限定されすぎている

**カテゴリ**: 影響範囲
**場所**: 対策案セクション

**問題**:
`vitest.config.ts` には `envPrefix` や `envFile: false` の設定がなく、Viteのデフォルト動作によりプロジェクトルートの `.env` ファイルが全テストの `process.env` に自動注入される。Issueの変更対象ファイルは `env.test.ts` のみだが、`process.env` を操作する全16テストファイルが潜在的に `.env` 値の汚染を受けている。

**証拠**:
- `vitest.config.ts` にenvPrefix/envFile設定なし
- `.env` には `CM_ROOT_DIR=/Users/maenokota/share/work/github_kewton`、`CM_DB_PATH=/Users/maenokota/.commandmate/data/cm.db` 等が設定されており、テスト実行時に `process.env` に注入される
- `process.env` を操作するテストファイルは全16ファイル存在

**推奨対応**:
対策案に以下の選択肢を追加検討する：
- (A) `vitest.config.ts` に `envPrefix: ['VITE_']` を設定して `.env` からの自動注入を `VITE_` プレフィックスのみに制限する
- (B) テスト用の `.env.test` ファイルを作成し、テスト環境で必要な最小限の環境変数のみを定義する
- (C) 現行の `.env` ファイルがテストに注入される前提で、各テストファイルの環境変数セットアップパターンを標準化する

---

## Should Fix（推奨対応）

### R3-001: env.test.ts以外にも同一の脆弱なprocess.envパターンが存在する

**カテゴリ**: 影響範囲
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
`env.test.ts` と同一のパターン（モジュールスコープで `const originalEnv = process.env` を参照代入）を使用しているテストファイルが他にも存在する。

**証拠**:
- `tests/unit/lib/worktree-path-validator.test.ts` L11: `const originalEnv = process.env;`
- `tests/unit/db-migration-path.test.ts` L42: `const originalEnv = process.env;`

**推奨対応**:
変更対象ファイルに上記2ファイルを追加するか、現時点でテスト失敗が発生していないことを確認して「影響なし」と明記する。

---

### R3-002: process.envの保存・復元パターンが3種類混在しており影響度の整理が必要

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
テストファイル間で `process.env` の保存・復元パターンが統一されておらず、各パターンの `.env` 汚染に対する脆弱性が異なる。

**パターン分類**:

| パターン | 方法 | 使用ファイル | .env汚染リスク |
|---------|------|-------------|--------------|
| A: 参照代入 | `const originalEnv = process.env` | env.test.ts, worktree-path-validator.test.ts, db-migration-path.test.ts | 高（復元時に.env値が残留） |
| B: スプレッドコピー | `const originalEnv = { ...process.env }` | logger.test.ts, log-config.test.ts, app-version-display.test.tsx | 中（コピー時に.env値を含む） |
| C: 単一変数 | `const originalEnv = process.env.SPECIFIC_KEY` | api-logger.test.ts, version-checker.test.ts | 低（特定変数のみ操作） |

**推奨対応**:
Issueの影響範囲セクションにパターン分類と各ファイルの影響度を記載する。

---

### R3-003: app-version-display.test.tsxの影響認識

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
`app-version-display.test.tsx` はモジュールスコープで `const originalEnv = { ...process.env }` を使用し、jsdom環境で `@testing-library/react` テストを実行している。NODE_ENV=production時のact()エラーの直接的な影響を受けるカテゴリだが、このファイル自体が操作するのは `NEXT_PUBLIC_APP_VERSION` のみであり、NODE_ENVに関する操作は行っていない。

**推奨対応**:
process.envをモジュールスコープで保存するテストファイル一覧（全16ファイル）を、対策1で自動カバーされるものと対策2の個別対応が必要なものに区分して記載する。

---

### R3-007: 統合テストへの影響が影響範囲に未記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
Issue本文では「62ファイル/1112テスト」としてunit testの失敗数のみ記載されているが、`tests/integration/` 以下にも3件のjsdom環境テスト（`@testing-library/react` 使用）が存在し、同様にNODE_ENV=productionでact()エラーが発生する。

**証拠**:
- `tests/integration/worktree-detail-integration.test.tsx`
- `tests/integration/issue-266-acceptance.test.tsx`
- `tests/integration/issue-288-acceptance.test.tsx`

**推奨対応**:
影響範囲の記述を「unit: 62ファイル/1112テスト + integration: 3ファイル」のように統合テストへの影響も含めた記述に更新する。

---

## Nice to Have（あれば良い）

### R3-004: NODE_ENVに依存するソースコード分岐への影響確認結果の記載

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
対策1で `NODE_ENV=test` を明示設定した場合のランタイム分岐への影響が分析されていない。

**確認結果（影響なし）**:

| ファイル | 分岐条件 | NODE_ENV=test時の動作 | NODE_ENV未設定時との差異 |
|---------|---------|---------------------|---------------------|
| `src/lib/env.ts` L160 | `=== 'production' ? 'info' : 'debug'` | 'debug' | なし |
| `src/lib/api-logger.ts` L86 | `!== 'development'` | ログ出力しない | なし |
| `src/lib/logger.ts` L141 | `=== 'development'` | false | なし |
| `src/components/worktree/PromptPanel.tsx` L98 | `!== 'production'` | console.error出力 | なし |

**推奨対応**:
影響範囲セクションに「NODE_ENVに依存するソースコード分岐への影響なし」の確認結果を簡潔に記載する。

---

### R3-005: CI/CDパイプラインへの影響の明記

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
CIワークフロー（`.github/workflows/ci-pr.yml`）への影響が明確に記載されていない。

**推奨対応**:
「CIワークフローは `npm run test:unit` 経由でテストを実行するため、package.jsonの `NODE_ENV=test` 追加で同時にカバーされる。`ci-pr.yml` 側の変更は不要」と明記する。

---

### R3-008: CLAUDE.mdへの注意事項追記

**カテゴリ**: 影響範囲
**場所**: 影響範囲

**問題**:
CLAUDE.mdの開発コマンドセクションには、テストを直接 `vitest run tests/unit` で実行した場合に `NODE_ENV=test` が適用されない点についての注意事項がない。

**推奨対応**:
以下のいずれかを実施する：
- CLAUDE.mdに「テストは必ず `npm run test:unit` 等のnpmスクリプト経由で実行すること」の注記を追加
- vitest.config.tsの `test.env` オプションで `NODE_ENV: 'test'` を設定して直接実行でも安全にする

---

## 破壊的変更の有無

**破壊的変更: なし**

対策1（package.jsonのテストスクリプトに `NODE_ENV=test` を追加）は、テスト実行時の環境変数を明示的に設定するだけであり、以下の理由から下位互換性に影響しない：

1. 既存のソースコードのNODE_ENV分岐は `NODE_ENV=test` で従来と同等の動作をする
2. CI/CDパイプラインは `npm run` 経由で実行されるため自動的にカバーされる
3. ビルドやデプロイのスクリプトには影響しない（変更対象はテストスクリプトのみ）

---

## 影響ファイル一覧

### 直接の変更対象（Issue記載）

| ファイル | 変更内容 |
|---------|---------|
| `package.json` | 全テストスクリプトに `NODE_ENV=test` を追加 |
| `tests/unit/env.test.ts` | 環境変数の分離処理を追加 |

### 追加検討が必要なファイル

| ファイル | 理由 |
|---------|------|
| `vitest.config.ts` | `envPrefix` や `test.env` の設定追加を検討 |
| `tests/unit/lib/worktree-path-validator.test.ts` | env.test.tsと同一のprocess.env参照代入パターン |
| `tests/unit/db-migration-path.test.ts` | env.test.tsと同一のprocess.env参照代入パターン |

### 影響を受けるが変更不要なファイル

| ファイル | 理由 |
|---------|------|
| `.github/workflows/ci-pr.yml` | npm script経由で自動カバー |
| `CLAUDE.md` | 注意事項追記を推奨（nice_to_have） |
| 67件のjsdom環境テストファイル | 対策1で自動的にNODE_ENV=test適用 |
| 3件のjsdom統合テストファイル | 対策1で自動的にNODE_ENV=test適用 |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/package.json`: テストスクリプト定義（L39-46）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/vitest.config.ts`: vitest設定（envPrefix/envFile未設定）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.env`: テストに注入される環境変数
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/env.test.ts`: 主要対策対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/lib/worktree-path-validator.test.ts`: 同一パターン使用
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/db-migration-path.test.ts`: 同一パターン使用
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/logger.test.ts`: スプレッドコピーパターン
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/config/log-config.test.ts`: スプレッドコピーパターン
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/api-logger.test.ts`: NODE_ENV単一変数パターン
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/src/lib/env.ts`: NODE_ENV分岐（L160）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/src/lib/api-logger.ts`: NODE_ENV分岐（L86）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/.github/workflows/ci-pr.yml`: CI設定

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/CLAUDE.md`: 開発コマンド記載
