# Issue #304 セキュリティレビュー (Stage 4)

## 基本情報

| 項目 | 内容 |
|------|------|
| Issue | #304 |
| ステージ | Stage 4 - セキュリティレビュー |
| 設計方針書 | `dev-reports/design/issue-304-test-env-isolation-design-policy.md` |
| レビュー日 | 2026-02-20 |
| ステータス | **Approved** |
| スコア | 5/5 |

## エグゼクティブサマリー

Issue #304 の設計方針書に対するセキュリティレビューを実施した。本修正はテスト環境設定のみ（`package.json` のテストスクリプトへの `NODE_ENV=test` プレフィックス追加、テストファイル内の `beforeEach` での環境変数 delete 追加）を対象としており、`src/` 以下のソースコードの変更を伴わない。

セキュリティ上の問題は検出されなかった。全8項目の確認を行い、いずれも info（情報確認のみ・対応不要）と判定した。must_fix、should_fix、nice_to_have に該当する指摘事項はない。

---

## レビュー対象ファイル

| ファイル | 変更種別 | セキュリティ関連性 |
|---------|---------|------------------|
| `package.json` | 修正 | テストスクリプトへの `NODE_ENV=test` 追加。本番スクリプトへの影響なし |
| `tests/unit/env.test.ts` | 修正 | `beforeEach` での環境変数 delete 追加。テストコード内に閉じた変更 |
| `tests/unit/lib/worktree-path-validator.test.ts` | 修正 | `beforeEach` での `ALLOWED_WORKTREE_PATHS` delete 追加。テストコード内に閉じた変更 |
| `tests/unit/db-migration-path.test.ts` | 変更なし | 既存の `DATABASE_PATH` delete で十分 |

---

## セキュリティレビュー詳細

### 1. 環境変数の扱い

#### DR4-001: process.env操作時の情報漏洩リスク [info]

テストコードでの `process.env` 操作（スプレッドコピー、delete、afterEach での参照復元）は Vitest 実行プロセス内に閉じている。`process.env` の操作結果がログ、ファイル、ネットワーク等の外部チャネルに意図せず露出するパスは存在しない。

確認したコード箇所:
- `tests/unit/env.test.ts` L19-30: `const originalEnv = process.env` でモジュールスコープに保存 -> `beforeEach` でスプレッドコピー -> `afterEach` で参照復元
- 同パターンが7つの describe ブロックで使用されている

**判定**: 対応不要。

#### DR4-002: .envファイルの機密情報テスト出力露出リスク [info]

`.env` ファイルの内容を確認した:

```
CM_ROOT_DIR=/Users/maenokota/share/work/github_kewton
CM_PORT=3002
CM_BIND=127.0.0.1
CM_DB_PATH=/Users/maenokota/.commandmate/data/cm.db
CM_LOG_LEVEL=info
CM_LOG_FORMAT=text
```

これらはローカルパス・ポート番号・ログ設定であり、パスワード、トークン、APIキー等の高感度情報は含まれていない。さらに:

- `.env` は `.gitignore` に登録済み（L32: `.env`）であり、リポジトリにコミットされない
- CI 環境（GitHub Actions）では `npm ci` によるクリーンインストールが行われ、`.env` ファイルは存在しない
- `.env.example` と `.env.production.example` はコミットされるが、プレースホルダー値（`/path/to/your/worktrees` 等）のみを含む

**判定**: 対応不要。

#### DR4-008: ENV_VARS_TO_CLEANリストの網羅性 [info]

`ENV_VARS_TO_CLEAN` の15変数を確認した:

| 変数グループ | 変数数 | 内容 | 機密性 |
|-------------|--------|------|--------|
| CM_* | 7 | パス、ポート、ログ設定 | 低（インフラ設定値） |
| MCBD_* | 7 | レガシー変数（CM_*と同等） | 低（インフラ設定値） |
| DATABASE_PATH | 1 | DBファイルパス | 低（ファイルパスのみ） |

認証情報・暗号鍵・トークン等のセキュリティ機密情報は含まれていない。delete 操作自体がセキュリティリスクを生じさせることはなく、むしろ `.env` 由来の値によるテスト汚染を防止する正の効果がある。

**判定**: 対応不要。

### 2. テスト環境の分離

#### DR4-003: NODE_ENV=testによる本番データベース接続防止 [info]

本プロジェクトは SQLite（better-sqlite3）をローカルファイルDBとして使用しており、外部データベースサーバーへの接続は存在しない。DB接続先はファイルパス（`CM_DB_PATH` 環境変数）で制御され、テスト時は各テストの `process.env` モック操作により個別に制御される設計となっている。

`NODE_ENV=test` の主目的は React の `act()` 有効化（テスト用警告制御）であり、DB接続制御ではない。ただし、対策2（`beforeEach` での `CM_DB_PATH` delete）により、`.env` の実DBパスがテストに混入するリスクはさらに軽減される。

`src/lib/env.ts` L160 の `getLogConfig()` で `NODE_ENV` が参照されている:

```typescript
const defaultLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
```

`NODE_ENV=test` が設定されることで、テスト時のデフォルトログレベルは `'debug'` となる。これはテスト実行に影響しない（テストで `CM_LOG_LEVEL` を明示設定するケースではオーバーライドされる）。

**判定**: 対応不要。

#### DR4-004: テスト実行時の外部サービス接続リスク [info]

対象テストファイル3本の内容を確認した:

| テストファイル | HTTP通信 | WebSocket | 外部API | ファイルI/O |
|--------------|----------|-----------|---------|------------|
| `env.test.ts` | なし | なし | なし | なし（`process.env` 操作のみ） |
| `worktree-path-validator.test.ts` | なし | なし | なし | なし（パス文字列検証のみ） |
| `db-migration-path.test.ts` | なし | なし | なし | あり（`fs.existsSync` 等、ローカルのみ） |

`dotenv` のロードは CLI モジュール（`src/cli/commands/start.ts`、`src/cli/commands/status.ts`、`src/cli/utils/daemon.ts`）で明示的に呼び出される設計であり、テスト実行時に自動的にロードされることはない。Vitest も `vitest.config.ts` で `envFile` や `loadEnv` の設定を行っていないため、`.env` ファイルの自動ロードは Vite/Vitest のデフォルト動作（ルートディレクトリの `.env` を読み込む）に依存している。

**判定**: 対応不要。

### 3. CI/CDセキュリティ

#### DR4-005: package.jsonスクリプト変更によるCIシークレット漏洩リスク [info]

変更前後の比較:

```diff
- "test": "vitest",
+ "test": "NODE_ENV=test vitest",
```

この変更は以下の点でCIシークレットに影響しない:

1. **環境変数の上書き方式**: `NODE_ENV=test` はコマンドプレフィックス方式であり、子プロセスの `NODE_ENV` のみを設定する。他の環境変数（`GITHUB_TOKEN`、`NPM_TOKEN` 等のCIシークレット）には影響しない
2. **変更対象の限定**: test 系スクリプト6本のみ。`build`、`start`、`prepublishOnly` 等の本番・デプロイ系スクリプトは変更対象外
3. **CI ワークフロー**: `.github/workflows/ci-pr.yml` の `test-unit` ジョブは `npm run test:unit` を呼び出すのみ。`env:` セクションで `CI: 'true'` と `NODE_OPTIONS` のみ設定しており、シークレットの注入はない

**判定**: 対応不要。

### 4. OWASP A05:2021 セキュリティの設定ミス

#### DR4-006: テスト専用設定の本番混入リスク [info]

本修正の変更は以下の2種類に厳密に限定されている:

1. **`package.json`**: テスト系スクリプト（`test`, `test:ui`, `test:coverage`, `test:unit`, `test:integration`, `test:watch`）への `NODE_ENV=test` プレフィックス追加。本番系スクリプト（`start`: `NODE_ENV=production node dist/server/server.js`）は変更なし
2. **テストファイル**: `tests/` ディレクトリ内の `beforeEach` での `process.env` delete 追加

`src/` 以下のソースコードに一切の変更がないため、テスト専用の条件分岐・設定値・フラグがプロダクションコードに混入するリスクは構造的に排除されている。

**判定**: 対応不要。

#### DR4-007: NODE_ENV=testの本番環境への影響 [info]

`package.json` のスクリプト定義を確認した:

```json
{
  "start": "NODE_ENV=production node dist/server/server.js",  // 本番: production
  "test": "NODE_ENV=test vitest",                              // テスト: test (新規追加)
  "test:unit": "NODE_ENV=test vitest run tests/unit"           // テスト: test (新規追加)
}
```

テスト系と本番系のスクリプトは完全に独立しており、`NODE_ENV` の値が相互に干渉することはない。`npm start` 実行時に `NODE_ENV=test` が残留する経路は存在しない（各スクリプトのプレフィックスはコマンド実行時の子プロセスにのみ適用される）。

**判定**: 対応不要。

---

## リスク評価

| リスク種別 | 評価 | 根拠 |
|-----------|------|------|
| 技術的リスク | **Low** | テスト環境設定のみの変更。ソースコード変更なし |
| セキュリティリスク | **Low** | 機密情報の操作なし。テスト/本番の分離は構造的に保証 |
| 運用リスク | **Low** | CI/CDへの影響は `NODE_ENV=test` のプロセス内設定のみ |

---

## OWASP Top 10 チェックリスト

| OWASP カテゴリ | 該当性 | 判定 |
|---------------|--------|------|
| A01:2021 アクセス制御の不備 | 該当なし | テスト環境設定のみ |
| A02:2021 暗号化の失敗 | 該当なし | 暗号化処理の変更なし |
| A03:2021 インジェクション | 該当なし | 入力処理の変更なし |
| A04:2021 安全でない設計 | 該当なし | テスト設計パターンは適切 |
| **A05:2021 セキュリティの設定ミス** | **確認済み** | テスト設定の本番混入リスクは構造的に排除 |
| A06:2021 脆弱で古いコンポーネント | 該当なし | 依存パッケージの変更なし |
| A07:2021 識別と認証の失敗 | 該当なし | 認証処理の変更なし |
| A08:2021 ソフトウェアとデータの整合性の不具合 | 該当なし | ビルドパイプラインの変更なし |
| A09:2021 セキュリティログとモニタリングの不備 | 該当なし | ログ設定の変更なし |
| A10:2021 SSRF | 該当なし | ネットワーク通信の変更なし |

---

## 改善提案

### 必須改善項目 (Must Fix)

なし。

### 推奨改善項目 (Should Fix)

なし。

### 検討事項 (Nice to Have)

なし。

---

## 結論

Issue #304 の設計方針書はセキュリティ観点で問題がなく、承認を推奨する。

本修正の核心的なセキュリティ特性:

1. **ソースコード変更なし**: `src/` 以下の変更が一切ないため、プロダクションコードのセキュリティ特性に影響しない
2. **テスト/本番の構造的分離**: `package.json` のスクリプトレベルで `NODE_ENV` が分離されており、相互干渉の経路がない
3. **機密情報非対象**: 操作対象の環境変数（`CM_*`, `MCBD_*`, `DATABASE_PATH`）はすべてインフラ設定値であり、認証情報・トークン等の機密情報は含まれない
4. **CI環境の安全性**: `.env` は `.gitignore` に含まれ、CI環境には存在しない。CIシークレットへの影響パスもない

---

## レビューサマリー

| 区分 | 件数 |
|------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 0 |
| Info | 8 |
| **合計** | **8** |

---

*Generated by architecture-review-agent for Issue #304 Stage 4*
*Review date: 2026-02-20*
