# Issue #304 仮説検証レポート

## 検証日時
- 2026-02-20

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `package.json` の `test:unit` スクリプトに `NODE_ENV=test` が明示されていない | Confirmed | `"test:unit": "vitest run tests/unit"` — NODE_ENV未指定を確認 |
| 2 | `env.test.ts` で `.env` ファイルの環境変数がテスト内のモック値を上書きしている | Confirmed | `NODE_ENV=test` でも9テスト失敗を実行確認。`.env` の `CM_ROOT_DIR`/`CM_DB_PATH` 等がvitest起動時に `process.env` に注入される |

## 詳細検証

### 仮説 1: `test:unit` スクリプトに `NODE_ENV=test` が明示されていない

**Issue内の記述**:
> 1. **`package.json` の `test:unit` スクリプトに `NODE_ENV=test` が明示されていない**

**検証手順**:
1. `package.json` の `scripts` セクションを確認

**判定**: Confirmed

**根拠**:
```json
"test": "vitest",
"test:unit": "vitest run tests/unit",
```
`NODE_ENV=test` の明示なし。`test:integration`、`test:watch` も同様。

**Issueへの影響**: 仮説通り。シェルで `NODE_ENV=production` が残留していると62ファイル/1139テストが失敗することを `NODE_ENV=production npm run test:unit` で実際に確認した。

---

### 仮説 2: `env.test.ts` で `.env` ファイルの環境変数がモック値を上書きする

**Issue内の記述**:
> 2. **`env.test.ts` で `.env` ファイルの環境変数（`CM_ROOT_DIR` 等）がテスト内のモック値を上書きしている**（`NODE_ENV=test` でも9テスト失敗）

**検証手順**:
1. `.env` ファイルの内容確認 → `CM_ROOT_DIR=/Users/maenokota/share/work/github_kewton` 等が設定済み
2. `tests/unit/env.test.ts` の `beforeEach` パターン確認 → `process.env = { ...originalEnv }` で初期化
3. `NODE_ENV=test npm run test:unit` を実行

**判定**: Confirmed

**根拠**:
- `.env` に `CM_ROOT_DIR`、`CM_PORT`、`CM_BIND`、`CM_DB_PATH` 等が設定されている
- vitest v4 はVite経由でプロジェクトルートの `.env` ファイルを読み込み、`process.env` に注入する
- `env.test.ts` はモジュール初期化時に `const originalEnv = process.env` を保存するため、`.env` 値が `originalEnv` に含まれる
- `beforeEach` の `process.env = { ...originalEnv }` で復元しても `.env` 値は残る
- 結果：`CM_ROOT_DIR` が未設定であることを前提にするテストや `CM_DB_PATH` の値を制御するテストが失敗する

**失敗テスト一覧**（`NODE_ENV=test` 環境):
```
✗ getEnvWithFallback > should fallback to old key value and warn when only old key is set
✗ getEnvWithFallback > should return undefined when neither key is set
✗ getEnvWithFallback > should only warn once for same key across multiple calls
✗ getEnvWithFallback > should warn separately for different keys
✗ resetWarnedKeys > should allow warning again after reset
✗ getEnv with fallback > should work without warning when new names are used
✗ getEnv with fallback > should work with warning when old names are used
✗ getEnv with DB path resolution > should use CM_DB_PATH when set
✗ getEnv with DB path resolution > should use default path when no DB path env vars set
```

---

## Stage 1レビューへの申し送り事項

- 両仮説はコードベースと実行結果で確認済み。Issue記載の根本原因分析は正確。
- 対策案1（`NODE_ENV=test` 追加）と対策案2（`beforeEach` での env var 削除）は両方必要。
- `test:integration` や `test:watch` スクリプトも同様に `NODE_ENV` が未設定のため、受入条件に追加すべきか確認が必要。
- vitest v4 の `.env` 読み込み挙動については `vitest.config.ts` の `env` オプションや `envFile` オプションで制御可能かも検討価値あり（ただし Issue の対策案は直接的で適切）。
