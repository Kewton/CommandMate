# Issue #480 Stage 4: セキュリティレビュー

## 概要

| 項目 | 内容 |
|------|------|
| Issue | #480 console.log整理・logger統一 |
| レビューステージ | Stage 4: セキュリティレビュー |
| レビュー日 | 2026-03-13 |
| 対象文書 | `dev-reports/design/issue-480-console-log-logger-unification-design-policy.md` |
| 総合評価 | **Good** (セキュリティリスクは限定的、改善推奨事項あり) |

## レビュー結果サマリ

| 種別 | 件数 |
|------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |

---

## セキュリティチェックリスト

### 1. センシティブデータの露出リスク

**判定: PASS (注意事項あり)**

`logger.ts` の `sanitize()` 関数は以下のパターンを自動マスクする:

- Bearer token
- password/passwd/pwd
- token/secret/api_key/apikey/auth
- Authorization header
- SSH private key

また、`SENSITIVE_KEY_PATTERN` によりオブジェクトのキー名が `password|secret|token|key|auth` にマッチする場合も `[REDACTED]` に置換される。

**注意事項**: SQLiteのエラーメッセージ（テーブル構造・カラム名を含む可能性）やworktreeId等の内部識別子はサニタイズ対象外。ローカル開発ツールのため実害は限定的だが、data引数に含めてよい情報の基準が設計方針書に未記載（SEC4-006）。

### 2. ログインジェクション

**判定: 要改善**

`logger.ts` の `formatLogEntry()` はaction引数をそのまま文字列結合してログ出力する。設計方針書のaction名命名規則では `'verb:target'` 形式の静的文字列を推奨しているが、実装者がユーザー由来の値をaction引数に渡してしまう場合のガードがない（SEC4-001）。

### 3. 情報漏洩（debugログの本番出力）

**判定: PASS**

- サーバーサイド: `getLogConfig()` が本番環境でデフォルト `'info'` レベルを返すため、`logger.debug()` は出力されない
- クライアントサイド: `shouldLogOnClient()` が `NODE_ENV === 'development'` をチェックし、本番では全ログレベルが抑制される
- `CM_LOG_LEVEL=debug` を明示設定した場合のみdebugログが本番出力されるが、sanitize()によるフィルタリングは有効

### 4. アクセスログ完全性

**判定: PASS**

`src/lib/api-logger.ts` の `withLogging()` は既に `createLogger('api')` を使用しており、本Issue #480の移行によるAPIアクセスログの欠落リスクはない。

### 5. console.errorの残置

**判定: PASS (注意事項あり)**

クライアントサイドの `console.error` 残置方針（29件）は妥当。ブラウザのエラーハンドリングに必要な正当な用途である。ただし、一部でサーバーエラーレスポンスのボディをそのまま出力している箇所があり（例: `InterruptButton.tsx:71`）、サーバー側のエラーメッセージに内部情報が含まれた場合の露出リスクがある（SEC4-005）。

### 6. db-migrations.tsのエラーログ

**判定: PASS (注意事項あり)**

マイグレーション失敗時の `console.error` は `logger.error()` に移行されるが、`String(error)` でスタックトレースが含まれる点と、トランザクションロールバック状態がログに記録されない点が改善余地（SEC4-002, SEC4-007）。

---

## 指摘事項詳細

### Must Fix

#### SEC4-006: APIルートのdata引数に含める情報の基準が未定義

設計方針書のログレベル割り当て方針（セクション1）には、console.logからlogger呼び出しへの変換パターンが記載されているが、data引数に含めてよい情報の基準が明記されていない。

`src/app/api/` 配下の約80件のconsole出力にはworktreeId、sessionName、gitブランチ名、ファイルパス等の内部情報が含まれており、これらがそのままlogger.info()のdata引数に渡される。logger.tsのsanitize()はパスワードやトークンをマスクするが、内部識別子や構造情報はフィルタリング対象外である。

**推奨対応**:

設計方針書のセクション1に以下の基準を追記する:

| data引数に含める情報 | 許容レベル | 備考 |
|---------------------|-----------|------|
| 認証トークン・パスワード | 禁止 | sanitize()で自動マスクされるが、意図的に渡さない |
| ファイルパス・worktreeId | info以上で許容 | 運用ログとして必要 |
| ユーザー入力テキスト（メッセージ内容等） | debugのみ許容 | 本番ではdebugレベル非出力 |
| エラーオブジェクト | error.messageのみ推奨 | スタックトレースはdebugレベル |

### Should Fix

#### SEC4-001: action引数のログインジェクション防御方針を追記

設計方針書のaction名命名規則に「action名は静的文字列のみ使用し、動的な値はdata引数に渡す」という制約を明記する。

#### SEC4-002: マイグレーションエラーログのスタックトレース分離

`logger.error('migration:failed', { error: error.message })` と `logger.debug('migration:failed:stack', { stack: error.stack })` のようにレベルを分離する方針を設計書に追記する。

#### SEC4-005: クライアントconsole.error残置の詳細基準

サーバーエラーレスポンスのボディをそのまま出力するconsole.errorについて、表示フィールドの限定またはNODE_ENV条件分岐を推奨する基準を追記する。

### Nice to Have

#### SEC4-003: 本番CM_LOG_LEVEL=debug時の運用注意事項を追記

#### SEC4-004: withLogging()ラッパーの全APIルート適用は将来課題として記録

#### SEC4-007: マイグレーション失敗時のロールバック状態ログ追加

---

## リスク評価

| リスク種別 | 評価 | 根拠 |
|-----------|------|------|
| 技術的リスク | Low | logger.tsの既存実装が堅牢。sanitize()・ログレベル制御・サーバー/クライアント分離が実装済み |
| セキュリティリスク | Low | ローカル開発ツールのため外部攻撃面は限定的。センシティブデータフィルタリングは機能している |
| 運用リスク | Low | 段階的移行フェーズにより大規模障害のリスクは低い |

---

## 総合所見

設計方針書はセキュリティ面で概ね適切な設計となっている。特に以下の点が高く評価できる:

1. **既存logger.tsの活用**: sanitize()による自動サニタイズ、ログレベル制御、サーバー/クライアント分離が既に実装済み
2. **クライアントサイドの3段階方針**: console.errorの正当な残置とconsole.log/warnの削除は合理的
3. **env.tsの除外**: 循環依存回避のための除外は適切

主な改善推奨事項は、移行実装時のガイドライン強化（data引数の情報基準、action引数の静的文字列制約）であり、設計の根幹に影響する変更は不要である。
