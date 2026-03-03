# Stage 3: 影響分析レビュー - Issue #395 Proxy Security Hardening

## Executive Summary

Issue #395 の設計方針書に対する影響範囲（Impact Scope）観点のレビューを実施した。設計方針書は変更対象を `handler.ts` / `config.ts` / `ExternalAppForm.tsx` の3ファイルに明確に限定しており、影響範囲の特定は概ね適切である。

しかし、以下の観点で影響分析の補強が必要である:
- 既存テストの修正方針が不十分で、回帰テストとしての信頼性に懸念がある
- `IProxyHandler` インターフェースの JSDoc が動作変更と不整合になる
- `next.config.js` の CSP ヘッダとの相互作用が未分析である

全体として、指摘事項を反映すれば実装に進めるレベルの設計品質である。

**Status**: conditionally_approved
**Score**: 4/5
**Must Fix**: 1 item / **Should Fix**: 4 items / **Nice to Have**: 3 items

---

## Review Scope

| 項目 | 内容 |
|------|------|
| Issue | #395 Proxy Security Hardening |
| Stage | 3 - 影響分析レビュー |
| Focus | 影響範囲 (Impact Scope) |
| Date | 2026-03-03 |
| Design Doc | `dev-reports/design/issue-395-proxy-security-hardening-design-policy.md` |

### Reviewed Files

| ファイル | 役割 |
|---------|------|
| `src/lib/proxy/handler.ts` | プロキシHTTP/WebSocketハンドラ（直接変更対象） |
| `src/lib/proxy/config.ts` | プロキシ設定定数（直接変更対象） |
| `src/lib/proxy/logger.ts` | プロキシログ（間接影響確認） |
| `src/lib/proxy/index.ts` | プロキシモジュールre-export（間接影響確認） |
| `src/app/proxy/[...path]/route.ts` | プロキシRoute Handler（間接影響確認） |
| `src/components/external-apps/ExternalAppForm.tsx` | 外部アプリ登録フォーム（直接変更対象） |
| `src/components/external-apps/ExternalAppsManager.tsx` | 外部アプリ管理コンテナ（間接影響確認） |
| `src/components/external-apps/ExternalAppCard.tsx` | 外部アプリカード（間接影響確認） |
| `src/components/external-apps/ExternalAppStatus.tsx` | 外部アプリステータス（間接影響確認） |
| `src/types/external-apps.ts` | 型定義（間接影響確認） |
| `src/lib/external-apps/interfaces.ts` | IProxyHandlerインターフェース（間接影響確認） |
| `src/middleware.ts` | 認証ミドルウェア（間接影響確認） |
| `next.config.js` | Next.js設定（セキュリティヘッダ、間接影響確認） |
| `tests/unit/proxy/handler.test.ts` | ハンドラテスト（直接変更対象） |
| `tests/unit/proxy/route.test.ts` | ルートテスト（間接影響確認） |
| `tests/unit/proxy/logger.test.ts` | ロガーテスト（間接影響確認） |

---

## Impact Analysis

### Direct Changes (直接変更)

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/lib/proxy/config.ts` | SENSITIVE_REQUEST_HEADERS, SENSITIVE_RESPONSE_HEADERS 定数追加 | 低: 新規定数追加のみ、既存コードへの影響なし |
| `src/lib/proxy/handler.ts` | proxyHttp() ヘッダフィルタリング追加、proxyWebSocket() 情報除去 | 中: レスポンス内容の変更は動作変更を伴う |
| `src/components/external-apps/ExternalAppForm.tsx` | セキュリティ警告バナー追加 | 低: UI追加のみ、既存機能への影響なし |
| `tests/unit/proxy/handler.test.ts` | 既存テスト修正 + 新規テスト追加 | 中: 既存テストの変更は回帰リスクを伴う |

### Indirect Impact (間接影響)

| ファイル | 影響内容 | リスク |
|---------|---------|-------|
| `src/app/proxy/[...path]/route.ts` | handler.ts の proxyWebSocket シグネチャ変更（パラメータ名のみ）。呼び出し側の変更は不要 | 低 |
| `src/lib/external-apps/interfaces.ts` | IProxyHandler.proxyWebSocket の JSDoc が動作変更と不整合になる | 中 |
| `src/lib/proxy/index.ts` | 新規 SENSITIVE_* 定数の re-export は不要（handler.ts 内部消費） | 低 |
| `src/middleware.ts` | middleware の Cookie 認証は handler.ts より前段で実行。handler.ts の Cookie ストリップとは独立 | 低 |
| `next.config.js` | CSP / X-Frame-Options がプロキシレスポンスにも適用されるかの確認が必要 | 中 |
| `tests/unit/proxy/route.test.ts` | handler.ts をモックしており、シグネチャ変更の影響なし | 低 |
| `tests/unit/proxy/logger.test.ts` | logger.ts 変更なし、影響なし | 無 |

### No Impact (影響なし)

| ファイル | 確認結果 |
|---------|---------|
| `src/types/external-apps.ts` | ExternalApp 型定義に変更なし |
| `src/components/external-apps/ExternalAppsManager.tsx` | ExternalAppForm の props 変更なし、影響なし |
| `src/components/external-apps/ExternalAppCard.tsx` | 変更なし |
| `src/components/external-apps/ExternalAppStatus.tsx` | 変更なし |
| `src/lib/external-apps/validation.ts` | 変更なし |
| `src/lib/external-apps/cache.ts` | 変更なし |
| `src/lib/external-apps/db.ts` | 変更なし |
| `tests/integration/external-apps-api.test.ts` | handler.ts を直接使用しない、影響なし |

---

## Detailed Findings

### DR3-001 [must_fix] 既存テスト回帰検出能力の不足

**場所**: 設計方針書 Section 6 テスト設計、`tests/unit/proxy/handler.test.ts` L83-105

既存テスト "should forward request headers" はリクエストに `Authorization: Bearer token123` と `X-Custom-Header: custom-value` を含めているが、アサーションは `expect.any(Headers)` のみであり、具体的なヘッダ値の検証を行っていない。

```typescript
// 現在のアサーション（handler.test.ts L99-104）
expect(global.fetch).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({
    headers: expect.any(Headers),
  })
);
```

Issue #395 実装後、Authorization はストリップされるが、このテストは引き続きパスしてしまう。設計方針書 Section 6 で既存テスト修正を記載しているが、以下の点が不十分:

1. テストに `Cookie` ヘッダが含まれていない（Cookie ストリッピングの回帰検証ができない）
2. `X-Forwarded-For` 等の X-Forwarded-* ヘッダも含まれていない
3. fetch に渡された Headers オブジェクトの具体的な検証方法が記載されていない

**推奨**: テスト修正方針を具体化し、全 SENSITIVE_REQUEST_HEADERS のストリップと安全なヘッダの転送を明示的にアサートするテストに変更する方針を記載する。

---

### DR3-002 [should_fix] route.test.ts への影響分析が未記載

**場所**: 設計方針書 Section 2、Section 6、Section 8

`tests/unit/proxy/route.test.ts` は handler.ts の関数をモックして Route Handler の統合動作を検証している。handler.ts の proxyWebSocket パラメータ名変更（`_request`, `_app`, `_path`）は呼び出し側に影響しないが、設計方針書でこのテストファイルへの影響が分析されていない。

Route Handler テストは handler.ts をモックしているため変更不要であることは技術的に自明だが、影響分析としてはこの確認を明示すべきである。

---

### DR3-003 [should_fix] IProxyHandler インターフェースの JSDoc 不整合

**場所**: `src/lib/external-apps/interfaces.ts` L95-106、`src/lib/proxy/handler.ts` L132-141

IProxyHandler インターフェースの proxyWebSocket メソッドの JSDoc:
```typescript
/**
 * Proxy a WebSocket connection to the upstream app
 * ...
 * @returns WebSocket upgrade response
 */
proxyWebSocket(request: Request, app: ExternalApp, path: string): Promise<Response>;
```

Issue #395 実装後、proxyWebSocket は WebSocket upgrade response ではなく 426 エラーレスポンス（内部 URL 情報なし）を返す。JSDoc の "@returns" が不正確になる。

同様に、handler.ts L136 の JSDoc:
```
* This returns a 426 Upgrade Required response with instructions.
```
の "with instructions" も不正確になる（directUrl/接続先情報が削除されるため）。

設計方針書の変更ファイル一覧に `interfaces.ts` が含まれておらず、JSDoc 更新が漏れる可能性がある。

---

### DR3-004 [should_fix] proxy/index.ts の re-export 方針が未記載

**場所**: `src/lib/proxy/index.ts`

`proxy/index.ts` は handler.ts と logger.ts の主要エクスポートを re-export しているが、config.ts の定数は re-export していない。SENSITIVE_REQUEST_HEADERS / SENSITIVE_RESPONSE_HEADERS は handler.ts 内部でのみ使用されるため index.ts 変更は不要だが、この判断が設計方針書に明示されていない。

テストから config.ts の定数を直接参照する必要がある場合（例: テスト内で定数を使用してストリップ対象ヘッダを動的に検証する場合）のインポートパスが明確でない。

---

### DR3-005 [should_fix] next.config.js CSP/X-Frame-Options との相互作用が未分析

**場所**: `next.config.js` L23-81、設計方針書 Section 4-1、Section 5

next.config.js は全ルートに対して以下のセキュリティヘッダを設定している:
- `Content-Security-Policy`
- `X-Frame-Options: DENY`

設計方針書では upstream からのこれらのヘッダをストリップする方針だが、Next.js Route Handler が返す Response に対して next.config.js の `headers()` 設定が自動的にマージされるかどうかの検証が記載されていない。

Next.js の挙動として:
- Route Handler から返された Response に対して、next.config.js の headers() はリクエストパスベースで適用される
- ただし、proxyHttp() が返す `new Response(response.body, ...)` がそのまま Route Handler の戻り値になるため、Next.js がヘッダを追加するかは確認が必要

ストリップ後に Next.js が再付与しない場合、`/proxy/*` ルートの CSP と X-Frame-Options が欠落し、セキュリティヘッダの空白が生じる。

---

### DR3-006 [nice_to_have] ExternalAppCard の Open ボタンと警告の関連性

**場所**: `src/components/external-apps/ExternalAppCard.tsx` L155

ExternalAppCard に "Open" ボタン (`window.open(proxyUrl, '_blank')`) があり、プロキシ経由でアプリを開く。設計方針書では ExternalAppForm にのみ警告バナーを追加するが、既に登録済みアプリを開く際のリスク認識は提供されない。本 Issue のスコープとしては適切な判断である。

---

### DR3-007 [nice_to_have] logger.test.ts への影響確認が未記載

**場所**: 設計方針書 Section 6

`tests/unit/proxy/logger.test.ts` は logger.ts のみを検証しており、handler.ts / config.ts の変更影響を受けない。設計方針書に明示されていないが、変更ファイル一覧に含まれていないことから自明である。

---

### DR3-008 [nice_to_have] middleware.ts と proxyWebSocket() の関係

**場所**: `src/middleware.ts` L84-96、設計方針書 Section 5

middleware.ts は WebSocket upgrade リクエストに対して認証チェックを行う。認証成功後、Route Handler に到達した WebSocket リクエストは proxyWebSocket() で 426 拒否される。Issue #395 の前後でこのフローは変わらないが、directUrl 削除により認証済みユーザーも直接接続先情報を取得できなくなる点は動作変更である。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | 既存テストの回帰検出能力不足（DR3-001） | Medium | High | P1 |
| 技術的リスク | next.config.js CSP ヘッダの再付与が不確実（DR3-005） | Medium | Medium | P2 |
| 技術的リスク | IProxyHandler JSDoc 不整合（DR3-003） | Low | High | P2 |
| 運用リスク | directUrl 削除による WebSocket 直接接続情報の喪失（DR3-008） | Low | Medium | P3 |

---

## Improvement Recommendations

### Must Fix (必須改善)

1. **DR3-001**: 既存テスト "should forward request headers" の修正方針を具体化する。全 SENSITIVE_REQUEST_HEADERS を含むリクエストを作成し、ストリップと安全ヘッダ転送の両方を明示的にアサートするテスト設計を記載する。

### Should Fix (推奨改善)

2. **DR3-002**: route.test.ts への影響が無いことを設計方針書に明記する。
3. **DR3-003**: interfaces.ts の IProxyHandler JSDoc と handler.ts の proxyWebSocket JSDoc を更新対象に含める。
4. **DR3-004**: proxy/index.ts の re-export 方針を明記する。
5. **DR3-005**: next.config.js の CSP ヘッダが proxyHttp() レスポンスに適用されるかの検証方針を追記する。

### Consider (検討事項)

6. **DR3-006**: ExternalAppCard の Open ボタン付近への警告インジケーターは将来 Issue で検討。
7. **DR3-007**: logger.test.ts が影響なしであることの明記は網羅性向上に有効。
8. **DR3-008**: directUrl 削除のトレードオフに認証済みユーザーへの影響を追記する。

---

## Approval Status

| 項目 | 判定 |
|------|------|
| Status | **conditionally_approved** |
| Score | 4/5 |
| Condition | DR3-001 (must_fix) を反映後、実装に進行可能 |

---

*Generated by architecture-review-agent for Issue #395 Stage 3*
*Review Date: 2026-03-03*
