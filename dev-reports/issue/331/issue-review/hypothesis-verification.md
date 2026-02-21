# Issue #331 仮説検証レポート

## 検証日時
- 2026-02-21

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `useWebSocket.ts`はwss://自動検出対応済み | Confirmed | line 107: `window.location.protocol === 'https:' ? 'wss:' : 'ws:'` |
| 2 | `next.config.js`のCSPでws:/wss:両方許可済み | Confirmed | line 65: `"connect-src 'self' ws: wss:"` |
| 3 | `server.ts`はHTTPのみ（HTTPS条件分岐が未実装） | Confirmed | `createServer from 'http'`のみ使用、HTTPS分岐なし |
| 4 | `ws-server.ts`のupgradeハンドラーに認証チェックがない | Confirmed | upgradeイベントハンドラー(lines 42-53)に認証ロジックなし |
| 5 | `StartOptions`にHTTPS/auth関連オプションが未実装 | Confirmed | `src/cli/types/index.ts`にauth/cert/key/https等のフィールドなし |
| 6 | `src/middleware.ts`が未存在（新規作成が必要） | Confirmed | Globで`src/middleware.ts`が見つからない |
| 7 | `src/lib/env.ts`にHTTPS関連環境変数が未実装 | Confirmed | ENV_MAPPINGにCM_HTTPS_CERT/CM_HTTPS_KEYなし |
| 8 | `src/cli/utils/env-setup.ts`にHTTPS関連環境変数が未実装 | Confirmed | HTTPS/AUTH/CERT/KEYを含む行なし |

## 詳細検証

### 仮説 1: useWebSocket.tsはwss://自動検出対応済み

**Issue内の記述**: 「クライアント側WebSocket（useWebSocket.ts）は既にwss://自動検出対応済み」

**検証手順**:
1. `src/hooks/useWebSocket.ts` を確認
2. `connect()` 関数内のプロトコル設定を確認

**判定**: Confirmed

**根拠**: `src/hooks/useWebSocket.ts:107`
```ts
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);
```
HTTPSページアクセス時に自動的にwss://を使用する実装が済んでいる。

**Issueへの影響**: なし（記述は正確）

---

### 仮説 2: next.config.jsのCSPでws:/wss:両方許可済み

**Issue内の記述**: 「CSP（next.config.js）は既にws:/wss:両方許可済み」

**検証手順**:
1. `next.config.js` のheaders設定を確認
2. Content-Security-Policyのconnect-src値を確認

**判定**: Confirmed

**根拠**: `next.config.js:65`
```js
"connect-src 'self' ws: wss:", // Allow WebSocket connections
```
ws:とwss:の両方が既に許可されている。

**Issueへの影響**: なし（記述は正確）

---

### 仮説 3: server.tsは現在HTTPのみ

**Issue内の記述**: 「server.tsで`https.createServer()`を条件分岐で使用」（変更対象として記述）

**検証手順**:
1. `server.ts` のimportを確認
2. サーバー作成部分のコードを確認

**判定**: Confirmed（変更が必要）

**根拠**: `server.ts:29`
```ts
import { createServer } from 'http';
```
HTTPSのimportや条件分岐は一切ない。`createServer`呼び出しもHTTPのみ。

**Issueへの影響**: なし（変更対象として正確に認識されている）

---

### 仮説 4: ws-server.tsに認証チェックがない

**Issue内の記述**: 「WebSocket認証チェック追加（`src/lib/ws-server.ts`）- connection時にCookieからトークン検証」

**検証手順**:
1. `src/lib/ws-server.ts` のupgradeイベントハンドラーを確認

**判定**: Confirmed（追加が必要）

**根拠**: `src/lib/ws-server.ts:42-53`
```ts
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url || '/';
  if (pathname.startsWith('/_next/')) {
    return;
  }
  wss!.handleUpgrade(request, socket, head, (ws) => {
    wss!.emit('connection', ws, request);
  });
});
```
認証チェックなしで全接続を受け入れる実装。

**Issueへの影響**: なし（変更対象として正確に認識されている）

---

### 仮説 5: StartOptionsにHTTPS/auth関連オプションが未実装

**Issue内の記述**: 「CLIオプション追加 - `--auth`, `--auth-expire`, `--https`, `--cert`, `--key`, `--allow-http` オプション追加」

**検証手順**:
1. `src/cli/types/index.ts` のStartOptionsインターフェースを確認

**判定**: Confirmed（追加が必要）

**根拠**: `src/cli/types/index.ts:33-46`
```ts
export interface StartOptions {
  dev?: boolean;
  daemon?: boolean;
  port?: number;
  issue?: number;
  autoPort?: boolean;
  dbPath?: string;
}
```
auth/cert/key/https/allowHttp/authExpireフィールドは存在しない。

**Issueへの影響**: なし（変更対象として正確に認識されている）

---

### 仮説 6: src/middleware.tsが未存在

**Issue内の記述**: 「Next.js認証ミドルウェアの実装（`src/middleware.ts`新規作成）」

**検証手順**:
1. `src/middleware.ts` をGlobで検索

**判定**: Confirmed（新規作成が必要）

**根拠**: Globコマンドで `src/middleware.ts` が存在しないことを確認。

**Issueへの影響**: なし（新規作成対象として正確に認識されている）

---

## Stage 1レビューへの申し送り事項

全仮説がConfirmedのため特記事項はない。ただし以下の点をレビューで確認すること：

- `server.ts`のHTTPS対応において、Next.jsアプリの`hostname`/`port`設定との連携が正しく設計されているか
- WebSocket認証で`IncomingMessage`のCookieパース方法（`ws`パッケージはCookieを自動パースしないため、手動パースが必要）
- メモリ上のトークン管理がサーバー再起動で確実にリセットされる設計になっているか
- `src/cli/utils/env-setup.ts`の.envファイル生成テンプレートへのHTTPS関連変数追加も必要か確認
