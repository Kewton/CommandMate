# Issue #395 Stage 1: 通常レビュー（設計原則）

| 項目 | 値 |
|------|-----|
| Issue | #395 Proxy Security Hardening |
| Stage | 1 - 通常レビュー（設計原則） |
| 対象 | dev-reports/design/issue-395-proxy-security-hardening-design-policy.md |
| 日付 | 2026-03-03 |
| ステータス | Conditionally Approved |

---

## Executive Summary

Issue #395 の設計方針書は、プロキシ機能における機密ヘッダ漏洩とWebSocket情報漏洩の脆弱性修正を対象としている。設計原則（SOLID/KISS/YAGNI/DRY）の観点からレビューした結果、全体として高品質な設計であると評価する。変更スコープは最小限に抑えられ、既存パターンとの一貫性が保たれている。must_fixは1件（コード内コメントの更新方針未記載）のみで、対応後に実装着手可能である。

---

## 設計原則チェックリスト

### SOLID原則

| 原則 | 評価 | 詳細 |
|------|------|------|
| Single Responsibility (SRP) | OK（条件付き） | handler.tsのproxyHttp()がヘッダフィルタリングをインラインで実装しているが、既存パターンの踏襲であり許容範囲。DR1-001参照 |
| Open/Closed (OCP) | OK | `as const`配列方式により、新規ヘッダ追加時にconfig.tsのみ変更すればよい。handler.tsの修正不要 |
| Liskov Substitution (LSP) | N/A | 継承・多態性を使用していない設計のため該当なし |
| Interface Segregation (ISP) | OK | 各モジュール（config.ts/handler.ts/logger.ts）のエクスポートは必要最小限 |
| Dependency Inversion (DIP) | OK | handler.tsはconfig.tsの定数に依存しており、適切な依存方向 |

### KISS原則

| チェック項目 | 評価 | 詳細 |
|-------------|------|------|
| 設計の複雑さは適切か | OK | 定数配列 + `.includes()` は最もシンプルなアプローチ。Set/Map等の過剰な抽象化を避けている |
| 変更箇所は最小限か | OK | 3ファイルのみの修正（config.ts/handler.ts/ExternalAppForm.tsx） |
| 代替案の検討は妥当か | OK | Section 3の代替案比較表で4方式を比較し、適切に選定している |

### YAGNI原則

| チェック項目 | 評価 | 詳細 |
|-------------|------|------|
| 不要な機能が含まれていないか | OK（条件付き） | `authorization`ヘッダのストリッピングは現在Bearer Token未使用だが、セキュリティの防御的設計として妥当 |
| スコープ外が明確か | OK | iframe sandboxing/restrictive CSP注入/オリジン分離がスコープ外として明示されている |
| proxyWebSocketのパラメータ | 要改善 | 未使用パラメータ3つの維持は「互換性」理由だが、YAGNI観点では削除またはアンダースコア化すべき（DR1-002） |

### DRY原則

| チェック項目 | 評価 | 詳細 |
|-------------|------|------|
| 定数の一元管理 | OK | SENSITIVE_*ヘッダリストをconfig.tsに集約。handler.ts内ハードコードを避けている |
| フィルタリングロジックの重複 | 要改善 | リクエスト/レスポンスで同一パターンのforEachループが2箇所（DR1-001） |
| エラーレスポンスのerrorフィールド | 許容 | ハードコードだが既存パターン踏襲（DR1-007） |

---

## 詳細指摘事項

### DR1-001 [should_fix] ヘッダフィルタリングロジックの重複

**カテゴリ**: DRY原則

**箇所**: 設計方針書 Section 4-2 - リクエスト/レスポンスヘッダフィルタリング

**説明**: リクエストヘッダフィルタリングとレスポンスヘッダフィルタリングは構造的に同一パターンである。

```typescript
// パターン1: リクエスト（Section 4-2 L62-68相当）
request.headers.forEach((value, key) => {
  const lowerKey = key.toLowerCase();
  if (
    !HOP_BY_HOP_REQUEST_HEADERS.includes(...) &&
    !SENSITIVE_REQUEST_HEADERS.includes(...)
  ) {
    headers.set(key, value);
  }
});

// パターン2: レスポンス（Section 4-2 L87-94相当）- 同一構造
response.headers.forEach((value, key) => {
  const lowerKey = key.toLowerCase();
  if (
    !HOP_BY_HOP_RESPONSE_HEADERS.includes(...) &&
    !SENSITIVE_RESPONSE_HEADERS.includes(...)
  ) {
    responseHeaders.set(key, value);
  }
});
```

**提案**: ヘルパー関数の抽出を検討する。例:

```typescript
function filterHeaders(
  source: Headers,
  ...excludeLists: ReadonlyArray<readonly string[]>
): Headers {
  const filtered = new Headers();
  source.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    const excluded = excludeLists.some(list =>
      (list as readonly string[]).includes(lowerKey)
    );
    if (!excluded) {
      filtered.set(key, value);
    }
  });
  return filtered;
}
```

ただし、既存パターンとの一貫性を重視してインライン維持とする判断も妥当。その場合は両箇所の同期修正が必要であることをコメントで明記する。

---

### DR1-002 [should_fix] proxyWebSocket()の未使用パラメータ

**カテゴリ**: YAGNI / SRP

**箇所**: 設計方針書 Section 4-3 - proxyWebSocket() シグネチャ

**説明**: 修正後の `proxyWebSocket(request, app, path)` では全パラメータが未使用となる。「シグネチャ互換性」の理由が示されているが、呼び出し元は `src/lib/proxy/handler.ts` 内部（index.tsで再エクスポート）であり、外部API互換性の要件は低い。

**提案**: アンダースコアプレフィックスを使用して未使用を明示する。

```typescript
export async function proxyWebSocket(
  _request: Request,
  _app: ExternalApp,
  _path: string
): Promise<Response> {
```

これにより、ESLint `@typescript-eslint/no-unused-vars` の警告を回避しつつ、シグネチャ互換性も維持できる。

---

### DR1-003 [nice_to_have] 型アサーションの改善余地

**カテゴリ**: OCP

**箇所**: 設計方針書 Section 4-2 - `.includes()` 型アサーション

**説明**: `lowerKey as typeof SENSITIVE_REQUEST_HEADERS[number]` の型アサーションは、`string` を `as const` リテラル型にキャストしているため、TypeScriptの型安全性が形骸化している。既存パターンの踏襲であるため本Issueでの修正は不要。

---

### DR1-004 [nice_to_have] 警告バナーのi18n非対応

**カテゴリ**: KISS

**箇所**: 設計方針書 Section 4-4 - ExternalAppForm.tsx

**説明**: プロジェクトはnext-intlによるi18n対応済みだが、新規UI文字列を英語ハードコードで追加している。設計方針書でスコープ外と明記されているため許容するが、TODOコメントまたは後続Issue作成を推奨する。

---

### DR1-005 [nice_to_have] テスト修正方針の不明確さ

**カテゴリ**: テスト設計

**箇所**: 設計方針書 Section 6 - 既存テスト修正

**説明**: 「should forward request headers」テストの修正後のアサーション内容が不明確。現在のテスト（`tests/unit/proxy/handler.test.ts` L83-105）では `Authorization: 'Bearer token123'` がリクエストに含まれている。

**提案**: 推奨アプローチは、既存テストからAuthorizationヘッダの設定を除去してX-Custom-Headerのみの転送を検証し、別途新規テストケースで「Authorizationがストリップされること」を明示的に検証する。

---

### DR1-006 [must_fix] コード内コメント更新方針の欠如

**カテゴリ**: DRY / 正確性

**箇所**: 設計方針書 Section 4-2 - handler.ts proxyHttp()

**説明**: 既存コードの `handler.ts` L60 には `// Clone headers, removing hop-by-hop headers` というコメントがある。修正後はセキュリティ関連ヘッダもストリップするため、コメントが実装と乖離する。設計方針書にコメント更新方針の記載がない。

**提案**: 設計方針書に以下のコメント更新を追記する:

```typescript
// L60: Clone headers, removing hop-by-hop and sensitive headers (Issue #395)
// L86: Clone response headers, removing hop-by-hop and sensitive headers (Issue #395)
```

実装時の見落とし防止とコードの自己文書化の観点で重要。

---

### DR1-007 [should_fix] エラーレスポンスのerrorフィールドハードコード

**カテゴリ**: 防御的設計

**箇所**: 設計方針書 Section 4-3 - proxyWebSocket() エラーレスポンス

**説明**: `error: 'Upgrade Required'` がハードコードされているが、`PROXY_ERROR_MESSAGES` 定数からの取得が望ましい（DRY原則）。既存のproxyHttp()エラーレスポンスも同様のパターンであるため、既存パターン踏襲として許容する。

**提案**: 設計方針書に「既存パターン踏襲」であることを明記する。将来的には `PROXY_ERROR_NAMES` 定数を追加してerrorフィールドも一元管理する。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | ヘッダフィルタリングの同期修正漏れ | Low | Low | P3 |
| 技術的リスク | proxyWebSocket未使用パラメータによるESLint警告 | Low | Medium | P2 |
| 運用リスク | コメント未更新による保守性低下 | Low | Medium | P2 |
| 技術的リスク | i18n非対応の技術的負債蓄積 | Low | Low | P3 |

---

## 判定結果

**ステータス: Conditionally Approved**

must_fix（DR1-006: コメント更新方針の明記）を設計方針書に追記した上で、実装着手を推奨する。設計の根幹は適切であり、KISS/YAGNI原則に沿った最小限の変更スコープが確保されている。

### 対応優先度

| 優先度 | ID | 内容 |
|--------|-----|------|
| 実装前対応必須 | DR1-006 | コメント更新方針を設計方針書に追記 |
| 実装時対応推奨 | DR1-001 | フィルタリング重複の認識（ヘルパー抽出またはコメント明記） |
| 実装時対応推奨 | DR1-002 | proxyWebSocketパラメータのアンダースコア化 |
| 実装時対応推奨 | DR1-007 | 設計方針書に「既存パターン踏襲」の注記追記 |
| 後続対応 | DR1-004 | i18n対応のTODOコメント追加 |
| 後続対応 | DR1-005 | テスト修正の具体的方針記載 |
| 将来検討 | DR1-003 | 型アサーションのリファクタリング |

---

## レビュー対象ファイル

| ファイル | 確認内容 |
|---------|---------|
| `dev-reports/design/issue-395-proxy-security-hardening-design-policy.md` | 設計方針書全体 |
| `src/lib/proxy/handler.ts` | 既存のproxyHttp/proxyWebSocket実装 |
| `src/lib/proxy/config.ts` | 既存の定数定義 |
| `src/lib/proxy/logger.ts` | ロガーモジュール（変更不要確認） |
| `src/lib/proxy/index.ts` | エクスポート定義（変更不要確認） |
| `src/components/external-apps/ExternalAppForm.tsx` | 既存フォーム実装 |
| `tests/unit/proxy/handler.test.ts` | 既存テスト内容 |

---

*Generated by architecture-review-agent for Issue #395 Stage 1*
