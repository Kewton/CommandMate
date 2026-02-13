# Architecture Review: Issue #257 - Stage 2 整合性レビュー

## Executive Summary

Issue #257 (バージョンアップ通知機能) の設計方針書について、既存コードベースとの整合性 (Consistency) レビューを実施した。

**結果: 条件付き承認 (Conditionally Approved) - Score: 4/5**

設計書は既存のアーキテクチャパターン（globalThisキャッシュ、API Routeハンドラ構造、api-client.tsのAPIクライアントオブジェクト、カスタムフック、i18n名前空間、コンポーネント配置）と高い整合性を持つ。9つの設計項目のうち7つが既存実装と完全に一致し、2つが部分的に一致した。Must Fixは1件（モジュール境界の文書化）で、実装ブロッカーではなく文書の明確化が主な要件である。

---

## 整合性マトリクス

| 設計項目 | 設計書の記載 | 実装状況/参照 | 整合性 | 備考 |
|---------|------------|-------------|--------|------|
| globalThis キャッシュ (Section 3-1) | `declare global` + `eslint-disable` + `globalThis.__versionCheckCache` | `auto-yes-manager.ts:99-112` | 一致 | コード形式が完全に同一 |
| API Route 構造 (Section 3-3) | NextResponse.json()、try-catch | `slash-commands/route.ts`、`auto-yes/route.ts` | 一致 | 既存パターンに準拠 |
| api-client.ts 拡張 (Section 10) | appApi オブジェクト新規追加 | `worktreeApi`, `repositoryApi` 等4つの既存客体 | 一致 | 命名規則・構造が同一 |
| カスタムフック (Section 1) | useUpdateCheck | `useFileSearch.ts`, `useAutoYes.ts` | 一致 | `'use client'`、型定義、JSDocパターン |
| i18n キー追加 (Section 10) | `worktree.update.*` | `src/i18n.ts` (worktree名前空間の動的import) | 一致 | i18n.ts変更不要 |
| コンポーネント配置 (Section 10) | `src/components/worktree/` | 既存30+コンポーネント | 一致 | 既存ディレクトリ |
| バージョン表示 (Section 9) | VersionSection + APP_VERSION_DISPLAY | `WorktreeDetailRefactored.tsx:108` | 部分一致 | サーバー側のバージョン取得方式未定義 |
| CSP設定 (Section 6-1) | connect-src 変更不要 | `next.config.js:64` | 一致 | サーバーサイドfetchはCSP対象外 |
| isGlobalInstall() (Section 5) | API Routeから呼出し | `src/cli/utils/install-context.ts` | 部分一致 | レイヤー図と実ファイル配置に不一致 |

---

## 詳細所見

### Must Fix (1件)

#### CONS-001: install-context.ts のモジュール境界に関する文書不一致

**影響箇所**: Section 1 (システム構成図), Section 3-3, Section 5

設計書のシステム構成図（Section 1）では `InstallCtx` を Server 層のコンポーネントとして記載しているが、実際のファイル配置は `src/cli/utils/install-context.ts` であり、CLI層に属する。API Route (`src/app/api/app/update-check/route.ts`) からCLI層のモジュールを直接importすることは、レイヤー構成の設計意図と矛盾する。

**既存の前例**: `src/lib/db-path-resolver.ts:14` が `from '../cli/utils/install-context'` で同様のimportを行っており、技術的には問題ない。

**推奨対応**:
- 設計書Section 1の構成図に `install-context.ts` の実際のパス（`src/cli/utils/`）を明記する
- `isGlobalInstall()` がCLI層に配置されている理由と、Server層からのimportが許容される根拠を記載する
- 将来的に `src/lib/install-context.ts` への移設を検討する旨を `Consider` として追記する

---

### Should Fix (4件)

#### CONS-002: getCurrentVersion() のバージョン取得方式の未定義

**影響箇所**: Section 2, Section 4

設計書は `version-checker.ts` 内の `getCurrentVersion()` 関数でバージョンを取得する前提だが、取得方式が明記されていない。

- **クライアント側**: `process.env.NEXT_PUBLIC_APP_VERSION` (ビルド時にnext.config.jsがpackage.jsonから埋め込み)
- **サーバー側の選択肢**:
  - (a) `process.env.NEXT_PUBLIC_APP_VERSION` -- Next.jsサーバー環境でも利用可能
  - (b) `require('../../package.json').version` -- 直接読み取り

方式によって、CLIからの直接実行時やNext.jsビルドなしの環境でバージョン不一致が発生する可能性がある。

**推奨対応**: `version-checker.ts` が `process.env.NEXT_PUBLIC_APP_VERSION` を使用する方針を明記する。これはnext.config.jsで設定済みの値を再利用するため、クライアントとサーバーで一貫したバージョンが保証される。フォールバックとして `require` を使う場合はその旨も明記する。

#### CONS-003: テストディレクトリ構造の既存パターンとの不一致

**影響箇所**: Section 10

設計書提案のテスト配置:
```
tests/unit/api/app/update-check.test.ts
tests/unit/components/worktree/update-notification-banner.test.tsx
tests/unit/components/worktree/version-section.test.tsx
```

既存のテスト配置パターン:
- APIテスト: `tests/unit/api/` 直下にフラット配置（`prompt-response-verification.test.ts`のみ存在、`api/app/`サブディレクトリの前例なし）
- コンポーネントテスト: `tests/unit/components/worktree/` に配置（`AutoYesToggle.test.tsx`等 -- この点は一致）

**推奨対応**: APIテストは `tests/unit/api/update-check.test.ts`（`app/` サブディレクトリなし）に配置するか、ロジックテストを `tests/unit/lib/version-checker.test.ts` に集約し、route.tsの統合テストは最小限にする。

#### CONS-004: appApi クライアントの追加に関する補足

**影響箇所**: Section 1, Section 10

`appApi` の追加は既存の `worktreeApi`、`repositoryApi` 等のパターンに完全準拠しており、構造・命名共に整合性がある。唯一の注意点は、既存の `fetchApi()` がGETリクエストでも `Content-Type: application/json` ヘッダーを自動付与する点だが、これは技術的な問題を生じない。

**推奨対応**: 実装時の留意事項として記録する程度で十分。

#### CONS-005: VersionSection のスタイル差異の吸収方法が未定義

**影響箇所**: Section 9, Section 3-4

InfoModalとMobileInfoContentのVersionセクションには以下のスタイル差異がある:

| 配置先 | スタイル |
|-------|---------|
| InfoModal (line 508) | `bg-gray-50 rounded-lg p-4` |
| MobileInfoContent (line 776) | `bg-white rounded-lg border border-gray-200 p-4` |

`VersionSection` (SF-001) で両方を置換する場合、このスタイル差異をどう扱うかが設計書に記載されていない。

**推奨対応**: VersionSection コンポーネントが `className` prop を受け取り、外側のコンテナスタイルを呼び出し側が指定するパターンを採用する。これは既存コンポーネント（例: `PromptPanel` 等）で一般的なパターンである。

---

### Consider (3件)

#### CONS-C01: /api/app/ パスの新規ドメイン

`/api/app/` は既存のAPIドメイン（worktrees, repositories, slash-commands, hooks, external-apps）に加わる新規ドメインとなる。アプリケーション全体に関わる機能の配置先として妥当だが、今後の拡張（ヘルスチェック、設定取得等）も見据えたガイドラインを検討するとよい。

#### CONS-C02: withLogging() ラッパーの適用

`src/lib/api-logger.ts` の `withLogging()` がAPI Routeの開発時デバッグに利用可能だが、設計書のroute.tsコード例では使用されていない。外部API呼び出しを含むためデバッグ時に有用な可能性がある。実装時に適用するかどうかを判断する。

#### CONS-C03: i18n worktree 名前空間の概念的不一致

`update.*` キーはアプリケーションレベルの概念であり、worktreeドメインとは直接関連しない。C-002（設計書内）で将来の名前空間分離を検討済みだが、整合性の観点から既存の `session.*`、`status.*` 等のworktree固有キーとの概念的差異を認識しておく。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | モジュール境界（CLI層からAPI層へのimport）の明確化不足 | Low | Low | P3 |
| 技術的リスク | サーバー側バージョン取得方式の未定義 | Medium | Medium | P2 |
| 運用リスク | テストディレクトリの非統一 | Low | Low | P3 |
| 技術的リスク | コンポーネントスタイル差異の未吸収 | Low | Medium | P2 |
| セキュリティリスク | なし | - | - | - |

---

## 高い整合性が認められた項目

以下の設計項目は、既存コードベースのパターンと高い整合性が確認された。

1. **globalThis キャッシュパターン**: `auto-yes-manager.ts:99-112` のコードパターン（`declare global`、`eslint-disable-next-line no-var`、`globalThis.__xxx ??= { ... }`）と完全一致
2. **API Route ハンドラ構造**: NextRequest/NextResponse import、export async function GET()、try-catch、NextResponse.json() の標準パターンに準拠
3. **api-client.ts の拡張パターン**: 既存4つのAPIクライアントオブジェクト（worktreeApi等）と同一の構造（オブジェクトリテラル + async メソッド + fetchApi<T>()）
4. **カスタムフック設計**: `'use client'` ディレクティブ、export interface、定数定義、JSDocの既存パターンに合致
5. **i18n 名前空間の変更なし**: `src/i18n.ts` の動的import構造の変更が不要で、locales JSONファイルへのキー追加のみで完結
6. **CSP設定への影響なし**: サーバーサイドfetchがCSP connect-srcの対象外であることの判断は正確
7. **Silent Failure パターン**: `AbortSignal.timeout(5000)` によるタイムアウト制御は、既存の `git-utils.ts` の1秒タイムアウトパターンと類似

---

## 結論

設計書は既存のCommandMateアーキテクチャパターンとの整合性が全体的に高い。Must Fix 1件は主に文書の明確化であり、アーキテクチャ上の根本的な問題ではない。Should Fix 4件のうち最も重要なのは CONS-002（サーバー側バージョン取得方式の明記）と CONS-005（VersionSection のスタイル差異吸収方法の定義）であり、いずれも設計書への追記で対応可能である。

**承認条件**:
1. CONS-001 の対応: install-context.ts のモジュール配置をシステム構成図に正確に反映する
2. CONS-002 の対応: getCurrentVersion() のバージョン取得方式を明記する

---

*Review conducted: 2026-02-13*
*Focus: 整合性 (Consistency)*
*Stage: 2 of 4*
*Reviewer: Architecture Review Agent*
