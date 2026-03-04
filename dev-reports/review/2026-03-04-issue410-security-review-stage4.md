# Issue #410 Stage 4: セキュリティレビュー

## Executive Summary

Issue #410 の設計方針書「xterm.js・highlight.jsのdynamic import化」に対するセキュリティレビューを実施した。本変更は静的importを `next/dynamic` によるdynamic importに置き換えるもので、プレゼンテーション層のみの変更であり、認証・認可・データアクセスのフローに影響を与えない。

**レビュー結果: approved (スコア: 5/5)**

Must Fix: 0件、Should Fix: 0件、Nice to Have: 3件

セキュリティ上の問題は検出されなかった。

---

## 1. XSSリスク評価

### 1-1. rehype-sanitize の動的チャンクへの包含確認

`src/components/worktree/MarkdownEditor.tsx` の L33-34 で `rehype-sanitize` と `rehype-highlight` が静的importされている:

```typescript
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
```

L614-616 で ReactMarkdown の rehypePlugins として適用されている:

```typescript
rehypePlugins={[
  rehypeSanitize, // [SEC-MF-001] XSS protection
  rehypeHighlight,
]}
```

設計方針書の記載通り、MarkdownEditor コンポーネント全体を `next/dynamic` でチャンク分離する設計のため、`rehype-sanitize` はチャンク内に含まれる。dynamic import によりロードタイミングが遅延するだけで、sanitize 処理が省略されることはない。MarkdownEditor が表示される時点では必ず rehype-sanitize が適用される。

**評価: 問題なし**

### 1-2. ローディング中のUIにおけるXSSリスク

設計方針書 Section 4 D2 で定義されたローディングUI:

```typescript
loading: () => (
  <div className="flex items-center justify-center h-full bg-white">
    <div className="text-center">
      <Loader2 className="animate-spin h-8 w-8 text-blue-600 mx-auto" />
      <p className="mt-4 text-gray-600">Loading editor...</p>
    </div>
  </div>
)
```

ローディングUIは以下の特性を持つ:
- ハードコードされた静的JSXのみで構成
- ユーザー入力を表示する要素を一切含まない
- props としてユーザー制御可能な値を受け取らない
- React の JSX レンダリングにより HTML エスケープが自動適用

**評価: XSSリスクはゼロ**

---

## 2. コードインジェクション評価

### 2-1. dynamic import のモジュール解決

設計方針書で定義されたdynamic import:

```typescript
const MarkdownEditor = dynamic(
  () => import('@/components/worktree/MarkdownEditor').then(...)
);

const TerminalComponent = dynamic(
  () => import('@/components/Terminal').then(...)
);
```

**モジュールパスはリテラル文字列のみ**で構成されており、ユーザー入力がモジュール解決に介入する経路は存在しない。webpack はビルド時にこれらのパスを静的に解析してチャンクを生成する。ランタイムでのパス操作は技術的に不可能（変数ベースの dynamic import は webpack がサポートせず、ビルドエラーになる）。

既存の先例（MermaidCodeBlock.tsx, login/page.tsx）も同一パターンを使用しており、プロジェクト内で確立された安全なパターンである。

**評価: コードインジェクションの攻撃面は存在しない**

---

## 3. CSP（Content Security Policy）互換性

### 3-1. 現在のCSP設定

`next.config.js` で定義されたCSP:

```javascript
"script-src 'self' 'unsafe-inline' 'unsafe-eval'"
```

### 3-2. dynamic import との互換性

`next/dynamic` が生成するチャンクファイルは `_next/static/chunks/` 配下に配置され、同一オリジンから読み込まれる。CSP の `script-src 'self'` により許可される範囲内であり、追加のCSP設定変更は不要。

dynamic import は内部的に webpack の `__webpack_require__.e()` を使用してチャンクを読み込む。これは通常の `<script>` タグまたは JSONP パターンで行われ、`eval()` やインライン JavaScript は使用しない。

### 3-3. 注記（既存設定に関する所見）

CSP に `'unsafe-eval'` が含まれているが、これは Next.js の開発モードで必要な設定であり、Issue #410 の変更とは無関係。本番環境では nonce ベースや `strict-dynamic` への移行が望ましいが、それは別の改善課題として扱うべきである。

**評価: CSP互換性に問題なし**

---

## 4. 認証・認可の維持確認

### 4-1. middleware の認証カバレッジ

`src/middleware.ts` の matcher 設定:

```typescript
matcher: [
  '/((?!_next/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
]
```

- `/worktrees/[id]`ルート: matcher に合致し、認証チェック対象
- `/worktrees/[id]/terminal`ルート: matcher に合致し、認証チェック対象
- dynamic importのチャンク (`_next/static/chunks/*`): matcher の除外パターンに該当

### 4-2. チャンクファイルへの認証なしアクセス

`_next/static/chunks/` 配下のチャンクファイルは認証なしでアクセス可能であるが、これは Next.js の標準動作であり、以下の理由でセキュリティ上の問題はない:

1. チャンクには JavaScript コードのみが含まれ、機密データは含まれない
2. MarkdownEditor のファイルデータは `/api/worktrees/[id]/files/` API 経由で取得され、この API は middleware の認証対象範囲内
3. Terminal の WebSocket 接続も middleware で認証チェックされる（L84-96）
4. IP制限も middleware で全リクエストに対して適用される（L68-78）

### 4-3. 認証フローへの影響

dynamic import はクライアントサイドの JavaScript チャンク読み込みメカニズムであり、HTTP リクエストの認証フローに影響を与えない。ページ自体へのアクセスは従来通り middleware で認証され、認証済みのブラウザセッション内でチャンクが読み込まれる。

**評価: 認証・認可に影響なし**

---

## 5. OWASP Top 10 照合

| OWASP | 項目 | 評価 | 詳細 |
|-------|------|------|------|
| A01 | Broken Access Control | Pass | middleware の認証は全対象ルートに適用。チャンクファイルはコードのみで機密データなし |
| A03 | Injection | Pass | モジュールパスはハードコードリテラル。ユーザー入力によるパス操作は不可能 |
| A05 | Security Misconfiguration | Pass | CSP と dynamic import は互換。ssr:false は正しい設定 |
| A06 | Vulnerable and Outdated Components | Pass | 新規ライブラリ追加なし。Loader2(lucide-react)は既存依存 |

---

## 6. 指摘事項一覧

### Nice to Have (3件)

| ID | タイトル | 説明 |
|----|---------|------|
| S4-001 | CSP script-src に unsafe-eval が含まれている | 既存設定であり本Issue起因ではない。将来のCSP強化時の検討事項として記録 |
| S4-002 | dynamic import 失敗時のエラーバウンダリ未設計 | Stage 1 の S1-008 でスキップ済み。ErrorBoundary が既に WorktreeDetailRefactored を包んでおり情報漏洩は防止されている |
| S4-003 | 共通コンポーネント message props のサニタイズ | React JSX の自動エスケープにより問題なし。dangerouslySetInnerHTML を使用しないこと |

---

## 7. リスク評価

| リスク種別 | レベル | 根拠 |
|-----------|-------|------|
| 技術的リスク | Low | 既存パターン（MermaidCodeBlock, QrCodeGenerator）の踏襲。新規技術の導入なし |
| セキュリティリスク | Low | 攻撃面の変化なし。認証・XSS防止・CSPに影響なし |
| 運用リスク | Low | プレゼンテーション層のみの変更。データアクセス・認証フローに影響なし |

---

## 8. 承認状況

| 項目 | 結果 |
|------|------|
| ステータス | **approved** |
| スコア | **5/5** |
| Must Fix | 0件 |
| Should Fix | 0件 |
| Nice to Have | 3件 |

本変更はセキュリティ上の問題を生じず、既存のセキュリティメカニズム（middleware認証、rehype-sanitize XSS防止、CSP）を正しく維持している。実装を承認する。

---

## レビュー対象ファイル

- `dev-reports/design/issue-410-dynamic-import-design-policy.md`
- `src/components/worktree/MarkdownEditor.tsx`
- `src/components/worktree/WorktreeDetailRefactored.tsx`
- `src/app/worktrees/[id]/terminal/page.tsx`
- `src/components/Terminal.tsx`
- `src/middleware.ts`
- `src/config/auth-config.ts`
- `src/components/worktree/MermaidCodeBlock.tsx`
- `src/app/login/page.tsx`
- `next.config.js`

---

*Generated by architecture-review-agent for Issue #410 Stage 4 Security Review*
*Review date: 2026-03-04*
