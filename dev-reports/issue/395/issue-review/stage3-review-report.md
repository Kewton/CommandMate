# Issue #395 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3/4

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 7 |
| Nice to Have | 3 |

Issue #395の修正による影響範囲は比較的限定的で、主にプロキシモジュール（`handler.ts`, `config.ts`）とそのテストに集中する。`middleware.ts`, `validation.ts`, `external-apps API`への変更は不要。ただし、テストコードへの影響が大きく、CSPヘッダのProxy適用状況によっては追加修正が必要になる。

---

## Must Fix（必須対応）

### S3-001: proxyHttp()のヘッダストリッピング変更がテストコードと乖離する

**カテゴリ**: 影響範囲
**場所**: `tests/unit/proxy/handler.test.ts` L83-105, `src/lib/proxy/handler.ts` L60-68

**問題**:
Issue #395の修正で`proxyHttp()`にCookie/Authorization/X-Forwarded-*等のリクエストヘッダストリッピングを追加する場合、既存テスト「should forward request headers」がAuthorizationヘッダの転送を暗黙的に期待しているため、テストが失敗するか意図と矛盾する。

**証拠**:
```typescript
// tests/unit/proxy/handler.test.ts L88-91
const request = new Request('http://localhost:3000/proxy/test/api', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer token123',  // <-- ストリッピング対象
    'X-Custom-Header': 'custom-value',
  },
});
```

**推奨対応**:
Issue本文の「Affected Code」にテスト修正の必要性を明記する。具体的には:
1. Cookie, Authorization, X-Forwarded-*, X-Real-IPがストリッピングされることの検証テスト追加
2. Content-Type, Accept等の安全なヘッダが引き続き転送されることの回帰テスト追加
3. Set-Cookieレスポンスヘッダのストリッピングテスト追加

---

### S3-002: config.tsの定数変更の設計方針が未明記

**カテゴリ**: 影響範囲
**場所**: `src/lib/proxy/config.ts`, Issue本文 ## Recommended Direction

**問題**:
`config.ts`は現在`handler.ts`からのみインポートされており（Grep確認済み）、他モジュールへの波及はない。しかし、ストリッピングリストを`config.ts`に集約するか`handler.ts`にハードコードするかの設計方針がIssueに記載されていない。

**証拠**:
```typescript
// 現在のconfig.ts - HOP_BY_HOP パターンが確立されている
export const HOP_BY_HOP_REQUEST_HEADERS = [
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
] as const;
```

**推奨対応**:
Recommended Directionに「`config.ts`に`SENSITIVE_REQUEST_HEADERS`（Cookie, Authorization, X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto, X-Real-IP）および`SENSITIVE_RESPONSE_HEADERS`（Set-Cookie）定数を追加し、`handler.ts`のヘッダ転送ループで参照する」という方針を記載する。既存の`HOP_BY_HOP_*`定数パターンとの一貫性が保たれる。

---

## Should Fix（推奨対応）

### S3-003: proxyWebSocket()のdirectUrl情報漏洩のスコープ明確化

**カテゴリ**: 影響範囲
**場所**: `src/lib/proxy/handler.ts` L143-166

**問題**:
`proxyWebSocket()`の426レスポンスに含まれる`directUrl`（`ws://{targetHost}:{targetPort}{path}`）による内部情報漏洩が、本Issueのスコープ内かどうかが不明。修正する場合は`tests/unit/proxy/handler.test.ts` L178-211のテストにも影響する。

**推奨対応**:
Affected Codeセクションに`proxyWebSocket()`の`directUrl`問題のスコープ可否を明示する。

---

### S3-004: ExternalAppForm.tsxへのセキュリティ警告UIの追加

**カテゴリ**: 影響範囲
**場所**: `src/app/api/external-apps/route.ts:48`, `src/components/external-apps/ExternalAppForm.tsx`

**問題**:
Issueの「Affected Code」に`route.ts:48`が含まれているが、POSTエンドポイント自体にコード変更は不要。代わりに、UIレベル（`ExternalAppForm.tsx`）でセキュリティ警告を表示すべき。現在の登録フォームにはプロキシのセキュリティリスクに関する説明が一切ない。

**推奨対応**:
Recommended Directionを具体化し、「`ExternalAppForm.tsx`の登録フォームにセキュリティ警告バナーを追加する（例: 'Proxied apps run under the CommandMate origin and can access CommandMate APIs. Only register trusted applications.'）」と記載する。

---

### S3-005: middleware.tsへの変更不要の明示

**カテゴリ**: 影響範囲
**場所**: `src/middleware.ts`

**問題**:
`middleware.ts`は変更不要だが、Issueにその旨が明示されていない。実装者がmiddleware.tsも修正対象と誤解する可能性がある。

**推奨対応**:
Affected Codeセクションに「`middleware.ts`: 変更不要。`/proxy/*`パスは`AUTH_EXCLUDED_PATHS`に含まれず、認証が有効な場合は認証必須」と補足する。

---

### S3-006: validation.tsへの変更不要の明示

**カテゴリ**: 影響範囲
**場所**: `src/lib/external-apps/validation.ts`

**問題**:
`validation.ts`はアプリ登録のバリデーション処理であり、Issue #395の脆弱性の原因ではない。コード変更は不要だが、Issueに明示されていない。

**推奨対応**:
Issue本文に「`validation.ts`への変更は本Issueのスコープ外」と記載する。

---

### S3-007: CSPヘッダのProxy適用問題による影響範囲変動

**カテゴリ**: 影響範囲
**場所**: `src/lib/proxy/handler.ts` L96-100, `next.config.js` L23-82

**問題**:
`next.config.js`のCSPヘッダがProxy Route Handlerのレスポンスに適用されるかの検証結果（Validation Notes item 6）によって修正範囲が変わる。upstreamのContent-Security-Policyヘッダが含まれていれば、`next.config.js`の設定を上書きしてしまう可能性もある。

**推奨対応**:
Recommended Directionに「`proxyHttp()`のレスポンスヘッダ構築時に`Content-Security-Policy`と`X-Frame-Options`をupstreamから継承しないよう明示的にストリッピングし、`next.config.js`の設定が確実に適用されるようにする」という方針を追加する。

---

### S3-008: CLAUDE.mdのモジュール説明更新

**カテゴリ**: 影響範囲
**場所**: `CLAUDE.md` 主要機能モジュールテーブル

**問題**:
修正後、`handler.ts`の説明にセキュリティ関連の情報を更新する必要がある。現在は「Issue #376: buildUpstreamUrl()がpathPrefix含むフルパスを転送するよう修正」のみ。

**推奨対応**:
修正完了後に`handler.ts`の説明に「Issue #395: SENSITIVE_REQUEST_HEADERS/SENSITIVE_RESPONSE_HEADERSストリッピング追加」を追記する。

---

### S3-010: レスポンスヘッダストリッピング時のCSP強制付与検討

**カテゴリ**: 影響範囲
**場所**: `src/lib/proxy/handler.ts` L86-100

**問題**:
ヘッダストリッピングだけでは同一オリジンのスクリプト実行を防げない。`proxyHttp()`でrestrictiveなCSPレスポンスヘッダを強制付与するオプションも検討すべき。

**推奨対応**:
Recommended Directionに「`proxyHttp()`のレスポンスにrestrictiveなCSPヘッダ（例: `Content-Security-Policy: default-src 'self'; script-src 'none'`）を強制付与するオプション」をiframe sandboxingと並ぶ防御層として追加する。

---

## Nice to Have（あれば良い）

### S3-009: security-guide.mdへのProxy注意事項追加

**場所**: `docs/security-guide.md` ## Threat Model

`docs/security-guide.md`にProxy機能のセキュリティリスクに関する記載がない。修正後も同一オリジン実行の本質的リスクは残るため、ユーザー向けドキュメントに注意事項を追加すべき。

---

### S3-011: Worktreeプロキシへの波及確認記載

**場所**: `src/lib/external-apps/db.ts`, `src/app/proxy/[...path]/route.ts`

Issue #136のWorktreeプロキシも同じ`proxyHttp()`を経由するため修正は自動適用されるが、Issueに明記されていない。

---

### S3-012: セキュリティテストの拡充計画

**場所**: `tests/unit/proxy/`

セキュリティ専用テストファイル（`tests/unit/proxy/security.test.ts`）の新規作成を推奨。ヘッダストリッピング、Set-Cookie除去、CSP付与の検証を含む。

---

## 影響範囲マトリクス

### 直接変更が必要なファイル

| ファイル | 変更種別 | 説明 |
|---------|---------|------|
| `src/lib/proxy/handler.ts` | 修正 | ヘッダストリッピングロジック追加 |
| `src/lib/proxy/config.ts` | 修正 | SENSITIVE_*_HEADERS定数追加 |
| `tests/unit/proxy/handler.test.ts` | 修正 | 既存テスト修正+セキュリティテスト追加 |

### 変更不要なファイル（確認済み）

| ファイル | 理由 |
|---------|------|
| `src/middleware.ts` | /proxy/*は既に認証対象 |
| `src/lib/external-apps/validation.ts` | バリデーションは脆弱性の原因ではない |
| `src/app/api/external-apps/route.ts` | 登録APIは脆弱性の原因ではない |
| `src/app/proxy/[...path]/route.ts` | handler.tsに委譲。直接変更不要 |
| `src/lib/external-apps/db.ts` | DB層は変更不要 |
| `src/lib/external-apps/cache.ts` | キャッシュ層は変更不要 |

### 推奨される追加対応

| ファイル | 種別 | 説明 |
|---------|------|------|
| `tests/unit/proxy/security.test.ts` | 新規作成 | セキュリティテスト |
| `src/components/external-apps/ExternalAppForm.tsx` | 修正 | セキュリティ警告バナー追加 |
| `CLAUDE.md` | 更新 | モジュール説明にセキュリティ情報追記 |
| `docs/security-guide.md` | 更新 | Proxy注意事項セクション追加 |

### 破壊的変更

なし。ヘッダストリッピングはプロキシの内部動作の変更であり、外部APIインターフェースに変更はない。upstreamアプリがCommandMateのCookie/Authorizationヘッダに依存している場合（設計上は想定外）のみ動作が変わる。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/proxy/handler.ts`: 主要変更対象（ヘッダストリッピング追加）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/proxy/config.ts`: 定数追加対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/proxy/logger.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/app/proxy/[...path]/route.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/middleware.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/lib/external-apps/validation.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/app/api/external-apps/route.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/src/components/external-apps/ExternalAppForm.tsx`: UI警告追加（推奨）

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/tests/unit/proxy/handler.test.ts`: 既存テスト修正必要
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/tests/unit/proxy/route.test.ts`: 変更不要（確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/tests/integration/external-apps-api.test.ts`: 変更不要（確認済み）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/CLAUDE.md`: モジュール説明更新必要
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/docs/security-guide.md`: Proxy注意事項追加（推奨）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-395/next.config.js`: CSPヘッダ定義の参照先（変更不要）
