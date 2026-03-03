# Issue #395 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目
**Issue タイトル**: security: same-origin trust break and credential leakage through /proxy/* external app proxy

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 4 |

Issue #395 の根本原因分析、影響評価、攻撃シナリオはコードベースの事実と正確に一致しており、仮説検証でも全6項目が Confirmed となっている。技術的な記載は高品質である。

主な指摘は以下の通り:
- 既存のセキュリティ対策（CSPヘッダ、認証ミドルウェア）への言及が欠如しており、攻撃の前提条件が不完全
- `next.config.js` のセキュリティヘッダがプロキシレスポンスに実際に適用されるかの検証が不可欠（must_fix）
- Validation Notes の検証項目が不十分
- 追加のリスク（X-Forwarded-* ヘッダ転送、WebSocket directUrl 漏洩）への言及なし

---

## Must Fix（必須対応）

### S1-009: next.config.js セキュリティヘッダのプロキシレスポンスへの適用確認

**カテゴリ**: 不足情報
**場所**: ## Root Cause / ## Preconditions

**問題**:
`next.config.js` の `headers()` で設定されたセキュリティヘッダ（CSP, X-Frame-Options 等）は `/:path*` パターンで全ルートに適用されている。しかし、`proxyHttp()` は独自の `new Response()` オブジェクトを構築して返すため、Next.js の `headers()` 設定がこのレスポンスに適用されるかどうかは Next.js の内部実装に依存する。

Route Handler が `new Response()` を直接返す場合、`next.config.js` の `headers()` は適用されない可能性がある。もし適用されない場合:
- プロキシレスポンスには CSP も X-Frame-Options も付与されない
- 外部スクリプト読み込みも含め、あらゆるJavaScript実行が制限なく可能になる
- 攻撃の実現可能性が大幅に高まる

**証拠**:
- `next.config.js` L23-81: `/:path*` パターンで CSP 等を設定
- `src/lib/proxy/handler.ts` L96-100: `new Response(response.body, { ... })` で独自レスポンスを構築

```typescript
// handler.ts L96-100
return new Response(response.body, {
  status: response.status,
  statusText: response.statusText,
  headers: responseHeaders,
});
```

**推奨対応**:
Validation Notes に「next.config.js の security headers がプロキシルートの Response に適用されるかの実機検証」を追加する。適用されない場合は `proxyHttp()` 内で明示的にセキュリティヘッダを付与する必要がある。

---

## Should Fix（推奨対応）

### S1-001: 既存CSP設定への言及が欠如

**カテゴリ**: 不足情報
**場所**: ## Impact / ## Example Attack Scenario

**問題**:
`next.config.js` には以下の CSP が設定されている:

```javascript
// next.config.js L58-67
"default-src 'self'",
"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
"connect-src 'self' ws: wss:",
```

Issue 本文では CSP の存在に全く触れておらず、攻撃シナリオの前提条件が不完全である。CSP の影響:
- `script-src 'unsafe-inline' 'unsafe-eval'` によりインラインスクリプトは実行可能
- `connect-src 'self' ws: wss:` により外部ドメインへの直接的なデータ送出は制限される
- ただし proxy 経由でアップストリームアプリのバックエンドに送り返すことは `self` 扱いで可能

**推奨対応**:
CSP の存在と制限範囲を Preconditions セクションに記載する。攻撃シナリオのデータ窃取経路として「proxy 経由でのアップストリームバックエンドへの送信」が `self` 扱いで許可される点を明示する。

---

### S1-002: 認証ミドルウェアによるプロキシアクセス保護の未記載

**カテゴリ**: 不足情報
**場所**: ## Preconditions

**問題**:
`middleware.ts` は `AUTH_EXCLUDED_PATHS` に `/proxy` パスを含まないため、`CM_AUTH_TOKEN_HASH` が設定されている環境では未認証ユーザーは `/proxy/*` にアクセスできない。

**証拠**:
- `src/config/auth-config.ts` L31-36: `AUTH_EXCLUDED_PATHS` は `/login`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/status` のみ
- `src/middleware.ts` L106: 完全一致マッチング

**推奨対応**:
Preconditions に「When CM_AUTH_TOKEN_HASH is configured, the user must be authenticated to access /proxy/* paths」を追加する。脆弱性の深刻度を下げるものではないが、正確な前提条件の記述として必要。

---

### S1-003: X-Forwarded-* ヘッダ転送リスクの未記載

**カテゴリ**: 不足情報
**場所**: ## Root Cause / ## Impact

**問題**:
`proxyHttp()` は `HOP_BY_HOP_REQUEST_HEADERS` に含まれないヘッダを全て転送する。これには以下が含まれる:
- `X-Forwarded-For`
- `X-Forwarded-Host`
- `X-Forwarded-Proto`
- `X-Real-IP`

アップストリームアプリがこれらを信頼した場合、ホストヘッダインジェクションやIPスプーフィング攻撃が可能になる。

**証拠**:
- `src/lib/proxy/config.ts` L23-31: 除外リストに上記ヘッダは含まれない

**推奨対応**:
Root Cause セクションの sensitive headers リストに追加し、Recommended Direction にもこれらのストリッピングまたは明示的な制御を含める。

---

### S1-004: Validation Notes の検証項目が不十分

**カテゴリ**: 不足情報
**場所**: ## Validation Notes

**問題**:
現在の Validation Notes は3項目のみ:
1. Cookie forwarding
2. Set-Cookie acceptance
3. API endpoint access from proxied JS

以下の重要な検証項目が欠如している。

**推奨対応**:
以下を追加:
4. `Set-Cookie: cm_auth_token=xxx; Path=/; HttpOnly` で既存認証 cookie の上書き可否
5. CSP (`script-src 'unsafe-inline'`) 下でのインラインJS実行可否
6. `next.config.js` のセキュリティヘッダがプロキシ Route Handler のレスポンスに付与されるか
7. `proxyWebSocket()` の `directUrl` レスポンスによる内部ネットワーク情報漏洩
8. `X-Forwarded-For` 等がアップストリームに転送されるか

---

## Nice to Have（あれば良い）

### S1-005: Authorization ヘッダの実用的リスク説明の補足

**カテゴリ**: 正確性
**場所**: ## Impact > ### 2. Credential disclosure to upstream apps

**問題**:
Issue では `Cookie` と `Authorization` を同列に挙げているが、CommandMate の認証は cookie ベース（`cm_auth_token`）であり、`Authorization` ヘッダ（Bearer トークン等）は使用していない。「bearer tokens if present」は現在のコードベースでは該当しない。

**推奨対応**:
現在の認証方式との関係を補足する。将来的な拡張やブラウザ拡張機能による Authorization ヘッダ付与のリスクは残る旨を明記する。

---

### S1-006: WebSocket upgrade 拒否レスポンスでの内部情報漏洩

**カテゴリ**: 不足情報
**場所**: ## Affected Code

**問題**:
`proxyWebSocket()` 関数（`handler.ts` L143-166）は 426 レスポンスで `directUrl` として `ws://{targetHost}:{targetPort}{path}` を返す。内部ネットワーク構成（ポート番号等）の漏洩リスクがある。

**証拠**:
```typescript
// handler.ts L150
const directWsUrl = `ws://${app.targetHost}:${app.targetPort}${path}`;
```

**推奨対応**:
内部情報漏洩のリスクとして追記するか、Recommended Direction に directUrl の除去を含める。

---

### S1-007: Recommended Direction に iframe sandboxing 戦略の追加

**カテゴリ**: 推奨事項
**場所**: ## Recommended Direction

**問題**:
完全なオリジン分離が困難な場合の中間的対策として、iframe sandbox + CSP `frame-src` によるプロキシコンテンツの隔離が言及されていない。

**推奨対応**:
以下の選択肢を追加:
- プロキシコンテンツを `sandbox` 属性付き iframe 内で表示
- iframe からの `/api/*` 呼び出しを CSP `frame-src` で制限
- ヘッダストリッピングとの併用が前提

---

### S1-008: コード参照の行番号の微修正

**カテゴリ**: 整合性
**場所**: ## Affected Code > Key references

**問題**:
`handler.ts:61` は実際には L62（`request.headers.forEach` の開始行）。

**推奨対応**:
`handler.ts:61` を `handler.ts:62` に修正。微修正であり優先度は低い。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/proxy/handler.ts` | プロキシHTTP/WebSocketハンドラ（脆弱性の主要箇所） |
| `src/lib/proxy/config.ts` | ホップバイホップヘッダ除外リスト定義 |
| `src/app/proxy/[...path]/route.ts` | プロキシルートハンドラ |
| `src/lib/external-apps/validation.ts` | 外部アプリバリデーション（targetHost制限） |
| `src/app/api/external-apps/route.ts` | 外部アプリ登録API |
| `src/middleware.ts` | 認証ミドルウェア（/proxy/* は認証対象） |
| `src/config/auth-config.ts` | 認証設定（AUTH_EXCLUDED_PATHS） |
| `next.config.js` | CSP/セキュリティヘッダ設定 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `dev-reports/issue/395/issue-review/hypothesis-verification.md` | 仮説検証レポート（全6項目Confirmed） |
| `CLAUDE.md` | プロジェクト構成・モジュール一覧 |
