# Issue #395 仮説検証レポート

## 検証日時
- 2026-03-03

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `handleProxy()` は `pathPrefix` で外部アプリを解決し転送する | Confirmed | `route.ts:30,47` |
| 2 | `proxyHttp()` はホップバイホップ許可リスト以外のほぼ全リクエストヘッダを転送する | Confirmed | `handler.ts:62-68`, `config.ts:23-31` |
| 3 | `Cookie`・`Authorization` がアップストリームに転送される | Confirmed | `config.ts:23-31`（両ヘッダとも除外リストに存在しない） |
| 4 | `proxyHttp()` はホップバイホップ拒否リスト以外のほぼ全レスポンスヘッダをブラウザへ返す | Confirmed | `handler.ts:87-94`, `config.ts:36-40` |
| 5 | `Set-Cookie` がブラウザへ転送される | Confirmed | `config.ts:36-40`（`set-cookie` は除外リストに存在しない） |
| 6 | `targetHost` は `localhost`/`127.0.0.1` に制限されているが、ブラウザ側のオリジン境界は保護しない | Confirmed | `validation.ts:25` |

## 詳細検証

### 仮説 1: `handleProxy()` はpathPrefixで外部アプリを解決する

**Issue内の記述**: 「`handleProxy()` resolves an external app by `pathPrefix` and forwards the request.」

**検証手順**:
1. `src/app/proxy/[...path]/route.ts` を確認
2. L30: `const [pathPrefix] = pathSegments;` でpathPrefixを抽出
3. L47: `const app = await cache.getByPathPrefix(pathPrefix);` でアプリ解決

**判定**: Confirmed

**根拠**: `route.ts:30,47` でpathPrefixによるアプリ解決が実装されている

---

### 仮説 2: ほぼ全リクエストヘッダが転送される

**Issue内の記述**: 「`proxyHttp()` forwards nearly all request headers except a small hop-by-hop allowlist.」

**検証手順**:
1. `src/lib/proxy/handler.ts` L62-68 を確認
2. `src/lib/proxy/config.ts` L23-31 の `HOP_BY_HOP_REQUEST_HEADERS` を確認

**判定**: Confirmed

**根拠**:
- `handler.ts:62-68`: 全リクエストヘッダをループし、`HOP_BY_HOP_REQUEST_HEADERS` に含まれないものだけを転送
- `config.ts:23-31`: 除外リストは `['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']` のみ

---

### 仮説 3: `Cookie`・`Authorization` が転送される

**Issue内の記述**: 「This includes sensitive headers such as: Cookie, Authorization」

**検証手順**:
1. `config.ts:23-31` の `HOP_BY_HOP_REQUEST_HEADERS` を確認
2. `cookie` と `authorization` の存在を確認

**判定**: Confirmed

**根拠**: `HOP_BY_HOP_REQUEST_HEADERS = ['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']` に `cookie` も `authorization` も含まれない。結果として両ヘッダはアップストリームアプリに転送される。

---

### 仮説 4: ほぼ全レスポンスヘッダがブラウザへ返される

**Issue内の記述**: 「`proxyHttp()` also returns nearly all upstream response headers to the browser except a small hop-by-hop denylist.」

**検証手順**:
1. `handler.ts:87-94` を確認
2. `config.ts:36-40` の `HOP_BY_HOP_RESPONSE_HEADERS` を確認

**判定**: Confirmed

**根拠**:
- `handler.ts:87-94`: 全レスポンスヘッダをループし、`HOP_BY_HOP_RESPONSE_HEADERS` に含まれないものだけを転送
- `config.ts:36-40`: 除外リストは `['transfer-encoding', 'connection', 'keep-alive']` のみ

---

### 仮説 5: `Set-Cookie` がブラウザへ転送される

**Issue内の記述**: 「This includes `Set-Cookie`.」

**検証手順**:
1. `config.ts:36-40` の `HOP_BY_HOP_RESPONSE_HEADERS` を確認
2. `set-cookie` の存在を確認

**判定**: Confirmed

**根拠**: `HOP_BY_HOP_RESPONSE_HEADERS = ['transfer-encoding', 'connection', 'keep-alive']` に `set-cookie` は含まれない。アップストリームアプリが `Set-Cookie` を返すと、ブラウザはCommandMateオリジンのCookieとして設定する。

---

### 仮説 6: `targetHost` はネットワーク宛先のみ制限する

**Issue内の記述**: 「`targetHost` is restricted to `localhost` / `127.0.0.1`, but that only limits network destination. It does not protect the browser-side origin boundary.」

**検証手順**:
1. `src/lib/external-apps/validation.ts:25` を確認

**判定**: Confirmed

**根拠**: `VALID_TARGET_HOSTS = ['localhost', '127.0.0.1']` により接続先はローカルホストに限定されるが、ブラウザから見ると `/proxy/...` はCommandMateと同一オリジンのため、same-origin制限は機能しない。

---

## Stage 1レビューへの申し送り事項

全仮説が Confirmed のため、Issueに記載された原因分析・影響・攻撃シナリオはすべてコードベースの事実と一致している。

レビュー時の重点確認ポイント:
- `HOP_BY_HOP_REQUEST_HEADERS` に追加すべきセキュリティ関連ヘッダ（`cookie`, `authorization`, `x-auth-token` 等）の網羅性
- `HOP_BY_HOP_RESPONSE_HEADERS` に追加すべきヘッダ（`set-cookie` 等）の網羅性
- 「Recommended Direction」の実現方針（ヘッダストリッピングのみ vs. 完全な分離）の妥当性と実装範囲
- `Content-Security-Policy` ヘッダによる同一オリジンスクリプト実行制限の可能性
