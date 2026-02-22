# Issue #331 トークン認証・HTTPS対応 設計方針書

## 1. 概要

サーバー起動時にオプションでトークン認証を有効化し、全APIルート・WebSocket接続にアクセス制御を追加する。CLIでトークンを有効期限付きで発行し、フロントエンドにシンプルなトークン入力画面を提供する。デフォルトは認証なし（後方互換性維持）。HTTPS直接配信モードも追加する。

### 設計原則
- **後方互換性最優先**: `--auth`なし起動は従来と完全に同じ動作
- **KISS**: 最小限のトークン認証（JWT等の複雑な認証は不採用）
- **YAGNI**: セッション管理・ユーザー管理等は実装しない
- **DRY**: 認証ロジックの一元化（auth.ts）

---

## 2. アーキテクチャ設計

### 2.1 システム構成図

```mermaid
graph TD
    subgraph CLI["CLI (start.ts)"]
        TG[トークン生成<br/>crypto.randomBytes]
        TH[SHA-256ハッシュ化]
        ENV[環境変数設定<br/>CM_AUTH_TOKEN_HASH]
    end

    subgraph Server["Server Process"]
        ST[server.ts<br/>HTTP/HTTPS条件分岐]
        AUTH[auth.ts<br/>トークン検証・期限管理]
        MW[middleware.ts<br/>HTTP認証]
        WS[ws-server.ts<br/>WebSocket認証]
        API[Next.js API Routes]
        PAGE[Next.js Pages]
        LOGIN[/login ページ]
    end

    subgraph Client["Browser"]
        COOKIE[HttpOnly Cookie<br/>トークン格納]
        WSC[useWebSocket.ts<br/>wss://自動検出]
    end

    TG --> TH --> ENV
    ENV -->|spawn env| ST
    ST -->|process.env| AUTH
    MW -->|検証依頼| AUTH
    WS -->|検証依頼| AUTH
    Client -->|HTTPS| MW
    Client -->|wss://| WS
    MW --> API
    MW --> PAGE
    MW -->|未認証| LOGIN
    LOGIN -->|POST /api/auth/login| AUTH
    AUTH -->|Set-Cookie| COOKIE
    WSC -->|Cookie自動送信| WS
```

### 2.2 認証の責務境界

| レイヤー | 担当モジュール | 責務 | 認証方法 |
|---------|--------------|------|---------|
| HTTPリクエスト | `src/middleware.ts` | API・ページのアクセス制御 | Cookie → SHA-256 → CM_AUTH_TOKEN_HASH比較 |
| WebSocket接続 | `src/lib/ws-server.ts` | upgrade時の認証 | `headers.cookie` → 手動パース → 同上 |
| トークン管理 | `src/lib/auth.ts` | 生成・検証・期限管理 | SHA-256ハッシュ比較 |

**重要**: Next.js middlewareはWebSocket upgradeリクエストを処理しない。WebSocket認証はws-server.tsのupgradeハンドラーで独立して実装する。

### 2.3 レイヤー構成

```
src/lib/auth.ts              <- 認証基盤（Node.js標準モジュールのみ依存）
├── AUTH_COOKIE_NAME         <- Cookie名定数 'cm_auth_token'（R006: DRY一元化）
├── AUTH_EXCLUDED_PATHS      <- 認証除外パス配列（R006: DRY一元化）
├── isAuthEnabled()          <- 認証有効/無効判定（R012: CM_AUTH_TOKEN_HASH有無で判定）
├── generateToken()          <- トークン生成（CLI用）
├── hashToken()              <- SHA-256ハッシュ計算
├── verifyToken()            <- トークン検証（Cookie値 → ハッシュ比較、S001: crypto.timingSafeEqual()使用必須）
├── authenticateRequest()    <- 統合認証関数（R007: Cookie取得→パース→検証→期限チェック一元化）
├── isTokenExpired()         <- 有効期限チェック
├── parseDuration()          <- ホワイトリスト方式の期間変換（R005: ALLOWED_DURATIONS参照）
├── parseCookieToken()       <- Cookie文字列からトークン抽出
├── createRateLimiter()      <- IPベースレート制限（※R001: 将来的にauth-rate-limiter.tsへの分離を検討）
└── destroyRateLimiter()     <- レート制限タイマー解放（C010: server.tsのgracefulShutdownから呼び出し）

src/cli/utils/auth-helper.ts  <- CLI用トークン生成ヘルパー（C001: tsconfig.cli.json制約対応、新規）
├── generateToken()           <- crypto.randomBytes(32) トークン生成
└── hashToken()               <- SHA-256ハッシュ計算

src/middleware.ts             <- HTTPリクエスト認証（Next.js middleware）
src/lib/ws-server.ts          <- WebSocket認証（upgradeハンドラー内）
src/app/api/auth/login/       <- ログインAPI
src/app/api/auth/logout/      <- ログアウトAPI
src/app/api/auth/status/      <- 認証状態API
src/app/login/page.tsx        <- ログイン画面
```

#### 定数定義（auth.ts）

```typescript
// src/lib/auth.ts に一元定義する定数群（R006: DRY原則）
export const AUTH_COOKIE_NAME = 'cm_auth_token' as const;

export const AUTH_EXCLUDED_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
] as const;
```

#### 認証有効/無効判定（auth.ts）

```typescript
// R012: 認証有効/無効判定の一元化
// middleware.ts, ws-server.ts, auth/status API の全箇所からこの関数を使用する
export function isAuthEnabled(): boolean {
  return !!process.env.CM_AUTH_TOKEN_HASH;
}
```

#### verifyToken()のタイミング攻撃対策（S001）

**設計方針**: `verifyToken()` のハッシュ比較では `===` 演算子による文字列比較を **禁止** し、`crypto.timingSafeEqual()` を使用した定数時間比較を **必須** とする。

**根拠**: JavaScript/TypeScript の `===` 演算子は文字列を先頭から1バイトずつ比較し、不一致時点で早期リターンする。この挙動により、攻撃者がレスポンス時間の差異からハッシュ値を1バイトずつ推測できるタイミング攻撃が成立する。SHA-256ハッシュは64文字のhex文字列であるため、理論上64回の試行でハッシュ値全体を特定される可能性がある。

```typescript
// S001: verifyToken()の実装方針
export function verifyToken(inputToken: string): boolean {
  const computedHash = hashToken(inputToken);
  const storedHash = process.env.CM_AUTH_TOKEN_HASH ?? '';

  if (computedHash.length !== storedHash.length) {
    return false;
  }

  // S001: crypto.timingSafeEqual() による定数時間比較（必須）
  // === 演算子による比較は禁止（タイミング攻撃に脆弱）
  return crypto.timingSafeEqual(
    Buffer.from(computedHash, 'hex'),
    Buffer.from(storedHash, 'hex')
  );
}
```

**実装制約**:
- `Buffer.from(hash, 'hex')` でバイナリ変換してから比較すること（文字列のままでは `timingSafeEqual` の効果が限定的）
- 両バッファの長さが異なる場合は比較前に `false` を返すこと（`timingSafeEqual` は同一長さを要求）

#### 統合認証関数（auth.ts）

```typescript
// R007: Cookie→パース→検証→期限チェックの一連のフローを一元化
// middleware.tsとws-server.tsの呼び出しパターン重複を防止
export function authenticateRequest(cookieHeader: string | undefined): AuthResult {
  // 1. parseCookieToken(cookieHeader) でトークン抽出
  // 2. hashToken(token) でハッシュ計算
  // 3. verifyToken(hash) でCM_AUTH_TOKEN_HASHと比較（S001: crypto.timingSafeEqual()使用）
  // 4. isTokenExpired() で期限チェック
  // 5. AuthResult { authenticated: boolean, reason?: string } を返却
}
```

#### parseDuration()のサポート範囲（R005: YAGNI対応）

```typescript
// R005: ホワイトリスト方式で対応フォーマットを限定
// auto-yes-config.ts の ALLOWED_DURATIONS パターンに準拠（ホワイトリスト方式のアプローチを採用）
// C007: 値の形式は用途に応じて異なる:
//   - auth: 文字列ベース（'1h', '7d'等）- CLIで人間が入力する形式として自然
//   - auto-yes: ミリ秒数値ベース（3600000等）- API内部値として自然
// 「パターンに準拠」とは、ホワイトリスト配列によるバリデーション方式の採用を意味し、
// 値のデータ型（文字列 vs 数値）は各モジュールの用途に応じて適切な形式を選択する
const ALLOWED_AUTH_DURATIONS = ['1h', '6h', '12h', '24h', '48h', '72h', '7d'] as const;
```

---

## 3. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| トークン生成 | `crypto.randomBytes(32)` | Node.js標準、外部依存不要 |
| ハッシュ | `crypto.createHash('sha256')` | Node.js標準、十分なセキュリティ |
| 期間パース | 自前実装（ホワイトリスト方式） | `ms`ライブラリは過剰。ALLOWED_AUTH_DURATIONS: '1h','6h','12h','24h','48h','72h','7d' に限定（R005） |
| Cookieパース | 自前実装（`split(';')`、S006: 堅牢化） | WSサーバーでのCookieパースに外部依存不要 |
| レート制限 | `Map<string, RateLimitEntry>` | メモリベース、外部依存不要 |
| HTTPS | `https.createServer()` | Node.js標準 |

### 不採用技術

| 技術 | 不採用理由 |
|------|----------|
| JWT | 過剰な複雑性。単一トークンで十分 |
| express-rate-limit | 外部依存追加不要。Mapベースで十分 |
| cookie-parser | ws-serverで使えない。自前パースで十分 |
| Passport.js | 認証フレームワーク不要。単一トークン認証のみ |
| セッションDB | YAGNI。メモリベースで十分 |

---

## 4. データモデル設計

### 4.1 メモリ上の状態管理（auth.ts）

```typescript
// サーバーメモリ上に保持（DB不要）
interface AuthState {
  /** SHA-256 hash of the token (from CM_AUTH_TOKEN_HASH) */
  tokenHash: string;
  /** Token expiration timestamp (Date.now() + duration) */
  expireAt: number;
  /** Whether auth is enabled */
  enabled: boolean;
}

// レート制限状態
interface RateLimitEntry {
  /** Number of failed attempts */
  count: number;
  /** First failure timestamp */
  firstAttempt: number;
  /** Lockout expiration (set after exceeding max attempts) */
  lockedUntil?: number;
}

// Map<ipAddress, RateLimitEntry>
```

#### AuthState初期化フロー（C004）

AuthStateの初期化はauth.tsモジュールのロード時に以下の手順で行う:

1. **サーバー起動時**: `process.env.CM_AUTH_TOKEN_HASH` からtokenHashを読み込み
2. **enabled判定**: `!!process.env.CM_AUTH_TOKEN_HASH` で設定（`isAuthEnabled()` と同一ロジック）
3. **expireAt計算**: `process.env.CM_AUTH_TOKEN_EXPIRE_AT` から読み込み（CLI側で計算してサーバーに伝達）
   - CLI側（start.ts / auth-helper.ts）で `Date.now() + parseDuration(CM_AUTH_EXPIRE)` を計算
   - 計算結果を `CM_AUTH_TOKEN_EXPIRE_AT` 環境変数としてspawn時に伝達
   - これにより、expireAtはサーバー起動時刻ではなく **CLIでの認証有効化時刻** からの相対時間となる（C012対応）

```typescript
// auth.ts モジュールスコープでの初期化
const authState: AuthState = {
  tokenHash: process.env.CM_AUTH_TOKEN_HASH ?? '',
  expireAt: Number(process.env.CM_AUTH_TOKEN_EXPIRE_AT) || 0,
  enabled: !!process.env.CM_AUTH_TOKEN_HASH,
};
```

**注意**: `authenticateRequest()` はAuthStateモジュールスコープ変数を参照するステートフル関数である。モジュールスコープにより、サーバープロセスの生存期間中は状態が保持される。

### 4.2 Cookie仕様

| 属性 | 値 | 条件 |
|------|------|------|
| Name | `cm_auth_token` | - |
| Value | トークン平文 | - |
| HttpOnly | `true` | 常時 |
| SameSite | `Strict` | 常時 |
| Secure | `true` | HTTPS時のみ |
| Max-Age | `Math.floor((expireAt - Date.now()) / 1000)` | 動的計算（ログインAPI応答時に計算） |
| Path | `/` | 常時 |

**C012: Max-Age計算タイミングの明確化**: Cookie Max-Ageは `/api/auth/login` のレスポンス（Set-Cookie）生成時に動的計算する。expireAtは `CM_AUTH_TOKEN_EXPIRE_AT` 環境変数で伝達されるため、サーバー起動時点ではなくCLI実行時点を基準とした有効期限となる。

---

## 5. API設計

### 5.1 認証API

```
POST   /api/auth/login     - トークン検証・Cookie設定
POST   /api/auth/logout     - Cookie削除
GET    /api/auth/status      - 認証状態確認
```

### 5.2 リクエスト/レスポンス形式

#### POST /api/auth/login
```typescript
// Request
{ "token": string }

// Response (200)
{ "success": true }

// Response (401)
{ "success": false, "error": "Invalid token" }

// Response (429)
{ "success": false, "error": "Too many attempts", "retryAfter": number }
// Header: Retry-After: <seconds>
```

#### POST /api/auth/logout
```typescript
// Response (200)
{ "success": true }
// Set-Cookie: cm_auth_token=; Max-Age=0; Path=/
```

#### GET /api/auth/status
```typescript
// Response (200)
{ "authEnabled": boolean }
```

### 5.3 middleware.ts認証除外パス

```typescript
import { NextRequest, NextResponse } from 'next/server';  // C011: import元を明示
import { AUTH_EXCLUDED_PATHS, isAuthEnabled, authenticateRequest } from '@/lib/auth';

// config.matcher で静的アセットを除外
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

// R006: 認証除外パスはauth.tsのAUTH_EXCLUDED_PATHS定数を参照
// middleware.ts内でのハードコード禁止
// AUTH_EXCLUDED_PATHS は auth.ts に一元定義（Section 2.3参照）
// S002: マッチングは完全一致（===）を使用。startsWith()は禁止
```

#### middleware.ts完全スケルトン（C011）

```typescript
// src/middleware.ts（新規ファイル）
// Next.js App Routerのmiddlewareとしてsrc/直下に配置
import { NextRequest, NextResponse } from 'next/server';
import { isAuthEnabled, authenticateRequest, AUTH_EXCLUDED_PATHS } from '@/lib/auth';

export function middleware(request: NextRequest) {
  // R012: isAuthEnabled()で認証有効/無効を一元判定
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  // R006: AUTH_EXCLUDED_PATHSによるパスチェック
  // S002: 完全一致（===）でマッチング。startsWith()は使用禁止（パストラバーサル的バイパスリスク）
  // 例外: /_next/ のようなプレフィックスパスはconfig.matcherで除外済み
  const pathname = request.nextUrl.pathname;
  if (AUTH_EXCLUDED_PATHS.some((path) => pathname === path)) {
    return NextResponse.next();
  }

  // R007: authenticateRequest()による統合認証
  const cookieHeader = request.headers.get('cookie') ?? undefined;
  const result = authenticateRequest(cookieHeader);

  if (!result.authenticated) {
    // R014: 未認証時は/loginへリダイレクト
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

// matcher設定: 静的アセットを除外
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
```

#### S002: AUTH_EXCLUDED_PATHSマッチングルール

**設計方針**: AUTH_EXCLUDED_PATHSのマッチングは **完全一致（`===`）** を使用する。`pathname.startsWith(path)` は禁止。

**根拠**: `startsWith()` マッチングでは `/login` で始まる任意のパス（例: `/loginCallback`, `/login/../admin`）が認証をバイパスする。現在の除外パスリストでは `/login` や `/api/auth/login` のプレフィックスマッチにより、将来的なルート追加時（例: `/loginAdmin`, `/api/auth/loginExternal`）にリスクが顕在化する。

**例外ケース**: `/_next/` のようなプレフィックス一致が必要なパスは、`config.matcher` の正規表現による除外で対応済みであり、AUTH_EXCLUDED_PATHSには含めない。将来的にプレフィックス一致が必要な除外パスが生じた場合は、専用のプレフィックス除外配列（`AUTH_EXCLUDED_PATH_PREFIXES`）を分離して定義すること。

### 5.4 認証無効時の動作保証

```typescript
import { NextRequest, NextResponse } from 'next/server';  // C011: import元を明示
import { isAuthEnabled, authenticateRequest, AUTH_EXCLUDED_PATHS } from '@/lib/auth';

// middleware.ts の冒頭ガード
export function middleware(request: NextRequest) {
  // R012: isAuthEnabled()で認証有効/無効を一元判定
  // process.env.CM_AUTH_TOKEN_HASHの直接参照は禁止（auth.tsに委譲）
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }
  // R006: AUTH_EXCLUDED_PATHSによるパスチェック（S002: 完全一致マッチング）
  // R007: authenticateRequest()による統合認証（S001: crypto.timingSafeEqual()使用）
  // ... 認証ロジック
}
```

**注意**: `isAuthEnabled()` は以下の全箇所で使用すること（R012）:
- `src/middleware.ts` - HTTPリクエスト認証の冒頭ガード
- `src/lib/ws-server.ts` - WebSocket upgrade認証の冒頭ガード
- `src/app/api/auth/status/route.ts` - `{ authEnabled: isAuthEnabled() }` レスポンス

---

## 6. セキュリティ設計

### 6.1 CSRF対策

**方針**: `SameSite=Strict` Cookieのみ。追加CSRFトークン不要。

**根拠**:
- `SameSite=Strict`は最も厳格なポリシー。クロスオリジンリクエストにCookieが付与されない
- ログインAPIはJSONボディでトークンを送信。フォームベースCSRFは不成立

### 6.2 ブルートフォース対策

| 項目 | 値 |
|------|------|
| 最大試行回数 | 5回/IP |
| ロックアウト時間 | 15分 |
| レスポンス | 429 Too Many Requests + Retry-After |
| 認証成功時 | カウントリセット |
| クリーンアップ | setInterval(1時間)で期限切れエントリ削除 |
| gracefulShutdown | clearIntervalで停止 |

```typescript
const RATE_LIMIT_CONFIG = {
  maxAttempts: 5,
  lockoutDuration: 15 * 60 * 1000, // 15 minutes
  cleanupInterval: 60 * 60 * 1000, // 1 hour
} as const;
```

#### S004: 認証イベントのセキュリティログ記録方針

以下のセキュリティイベントをログに記録する。既存の `src/cli/utils/security-logger.ts` のパターンを参考にするが、サーバー側認証ログはauth.ts内で `console.warn` / `console.info` を使用する（security-logger.tsはCLI側モジュールのためtsconfig.server.json制約上importできない）。

| イベント | ログレベル | 記録内容 | 注意事項 |
|---------|----------|---------|---------|
| 認証失敗 | `warn` | IPアドレス、タイムスタンプ、現在の試行回数 | トークン値はログに含めない（情報漏洩防止） |
| ロックアウト発生 | `warn` | IPアドレス、ロックアウト期間（分） | - |
| 認証成功 | `info` | IPアドレス、タイムスタンプ | 高頻度ログ防止のため初回認証成功時のみ |
| トークン期限切れ | `warn` | タイムスタンプ | IPアドレスは含めない（正規ユーザーの可能性が高い） |

```typescript
// auth.ts 内のログ記録例
// S004: 認証失敗ログ（トークン値は含めない）
console.warn(`[auth] Authentication failed: ip=${ip}, attempts=${entry.count}`);

// S004: ロックアウトログ
console.warn(`[auth] IP locked out: ip=${ip}, duration=${RATE_LIMIT_CONFIG.lockoutDuration / 60000}min`);

// S004: 認証成功ログ
console.info(`[auth] Authentication successful: ip=${ip}`);
```

#### S005: IPアドレス取得方法

レート制限で使用するIPアドレスの取得方法を以下の優先順位で統一する。

| コンテキスト | 取得方法 | 理由 |
|------------|---------|------|
| middleware.ts（Next.js middleware） | `request.ip` | Next.jsが信頼されたプロキシヘッダーを処理 |
| login API（route.ts） | `request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() \|\| 'unknown'` | Next.js API RouteではRemoteAddressに直接アクセスできないため |
| ws-server.ts（WebSocket） | `req.socket.remoteAddress` | HTTPアップグレードリクエストのソケットから直接取得 |

**設計方針**: `X-Forwarded-For` ヘッダーを直接参照せず、Next.jsのtrustedプロキシ設定に委ねる。プロキシ環境でのIP詐称リスクは Section 13 のトレードオフに記載済み。

#### レート制限のリソース管理（R010, C010）

`createRateLimiter()` は `destroy()` メソッドを持つオブジェクトを返す設計とし、server.ts の `gracefulShutdown()` で `destroyRateLimiter()` を呼び出してタイマーを解放する。既存の `stopAllPolling()` / `stopAllAutoYesPolling()` パターンに準拠。

**C010: ライフサイクル管理方針**: auth.tsのモジュールスコープでrateLimiterインスタンスを作成し、`destroyRateLimiter()` 関数をexportする。server.tsはrateLimiterインスタンスに直接アクセスせず、`destroyRateLimiter()` 関数経由でクリーンアップする。

```typescript
// auth.ts内のライフサイクル管理
// I004: 認証無効時に不要なsetInterval（クリーンアップタイマー）を防止するため、
// isAuthEnabled()を条件として遅延初期化する。
// server.tsからauth.tsをimportしても、認証無効時はタイマーが起動しない。
const rateLimiter = isAuthEnabled() ? createRateLimiter() : null;

// server.tsから呼び出すためのexport関数
export function destroyRateLimiter(): void {
  rateLimiter?.destroy();
}

// createRateLimiter() の戻り値インターフェース
interface RateLimiter {
  checkLimit(ip: string): { allowed: boolean; retryAfter?: number };
  recordAttempt(ip: string, success: boolean): void;
  destroy(): void;  // clearInterval でクリーンアップタイマーを解放
}

// server.ts の gracefulShutdown() 内
import { destroyRateLimiter } from './lib/auth';
destroyRateLimiter();  // 既存の stopAllPolling() の後に追加
```

### 6.3 トークン管理

- トークンはCLIプロセスでのみ平文保持（ターミナル表示用）
- サーバーにはSHA-256ハッシュのみ伝達（`CM_AUTH_TOKEN_HASH`）
- Cookieにはトークン平文を格納（HttpOnly+Secure+SameSite=Strictで保護）
- 毎リクエストでCookie値のSHA-256ハッシュを計算し、`CM_AUTH_TOKEN_HASH`と比較
- **S001: ハッシュ比較には `crypto.timingSafeEqual()` を必須使用**。`===` 演算子による比較は禁止（タイミング攻撃対策）。詳細は Section 2.3「verifyToken()のタイミング攻撃対策」を参照
- **トレードオフ**: ステートフルセッション不要でシンプル。Cookieが漏洩した場合はトークン自体の露出となるが、HttpOnly+Secure+SameSiteで保護されている
- **S010: 環境変数の露出リスク**: `CM_AUTH_TOKEN_HASH` はspawn時のenv経由で伝達される。Linux環境では `/proc/<pid>/environ`、macOS環境では `ps e` コマンドでプロセスの環境変数を読み取り可能である。ただし、256ビットランダムトークンのSHA-256ハッシュであるため、ハッシュ値の露出によるトークン復元は計算的に不可能であり、実質的リスクは無視可能

### 6.4 Issue #179との関係

- Issue #179で削除された`CM_AUTH_TOKEN`はクライアント側環境変数（`NEXT_PUBLIC_`）に公開されていた
- 新しい`CM_AUTH_TOKEN_HASH`はサーバーサイド専用環境変数
- 旧`CM_AUTH_TOKEN`設定時は `start.ts` で非推奨警告を出力

---

## 7. CLIオプションと環境変数マッピング

| CLIオプション | 環境変数 | デフォルト | 説明 |
|-------------|---------|----------|------|
| `--auth` | `CM_AUTH_ENABLED=1` | 未設定 | 認証有効化 |
| `--auth-expire <dur>` | `CM_AUTH_EXPIRE` | `24h` | トークン有効期限 |
| `--cert <path>` | `CM_HTTPS_CERT` | 未設定 | 証明書ファイルパス |
| `--key <path>` | `CM_HTTPS_KEY` | 未設定 | 秘密鍵ファイルパス |
| `--https` | `CM_HTTPS_ENABLED=1` | 未設定 | 認証なしHTTPS |
| `--allow-http` | `CM_AUTH_ALLOW_HTTP=1` | 未設定 | HTTP警告抑制 |
| *(自動生成)* | `CM_AUTH_TOKEN_HASH` | - | サーバーに伝達するトークンハッシュ |
| *(自動計算)* | `CM_AUTH_TOKEN_EXPIRE_AT` | - | トークン有効期限タイムスタンプ（C004/C012） |

### ENV_MAPPING統合方針（C003）

既存の `src/lib/env.ts` の `ENV_MAPPING` は、旧名称 `MCBD_*` から新名称 `CM_*` へのフォールバックを提供する。しかし、本Issue で新規追加する認証・HTTPS環境変数には過去の `MCBD_*` 名称が存在しないため、**ENV_MAPPINGには追加しない**。

| 環境変数 | ENV_MAPPING追加 | 参照方法 | 理由 |
|---------|----------------|---------|------|
| `CM_AUTH_TOKEN_HASH` | 不要 | `process.env.CM_AUTH_TOKEN_HASH` | 新規変数、レガシーフォールバック不要 |
| `CM_AUTH_ENABLED` | 不要 | `process.env.CM_AUTH_ENABLED` | 新規変数（CLI内部フラグ用途のみ、C009参照） |
| `CM_AUTH_EXPIRE` | 不要 | `process.env.CM_AUTH_EXPIRE` | 新規変数 |
| `CM_AUTH_TOKEN_EXPIRE_AT` | 不要 | `process.env.CM_AUTH_TOKEN_EXPIRE_AT` | 新規変数（C004/C012対応） |
| `CM_HTTPS_CERT` | 不要 | `process.env.CM_HTTPS_CERT` | 新規変数 |
| `CM_HTTPS_KEY` | 不要 | `process.env.CM_HTTPS_KEY` | 新規変数 |
| `CM_HTTPS_ENABLED` | 不要 | `process.env.CM_HTTPS_ENABLED` | 新規変数 |
| `CM_AUTH_ALLOW_HTTP` | 不要 | `process.env.CM_AUTH_ALLOW_HTTP` | 新規変数 |

**注意**: `src/lib/env.ts` の `Env` interface も拡張しない。認証状態は `auth.ts` のモジュールスコープ（AuthState）で管理し、`getEnv()` / `getEnvByKey()` パターンとは独立した参照方法を使用する。これは認証環境変数が `getEnvByKey()` のフォールバック機能を必要としないためであり、既存パターンとの不整合ではなく意図的な設計判断である。

### CM_AUTH_ENABLEDの用途明確化（C009）

`CM_AUTH_ENABLED` と `isAuthEnabled()` の判定基準は以下の通り:

| 項目 | 判定基準 | 用途 |
|------|---------|------|
| `CM_AUTH_ENABLED` | CLI側フラグ（`'1'`で有効） | CLI内部の `--auth` 指定済み記録。daemon.tsの環境変数伝達で使用 |
| `isAuthEnabled()` | `!!process.env.CM_AUTH_TOKEN_HASH` | **サーバー側の認証判定**（唯一の判定基準） |

**設計判断**: サーバー側の認証有効/無効判定は `CM_AUTH_TOKEN_HASH` の有無のみで行う。`CM_AUTH_ENABLED` はCLI側の内部状態管理のみに使用し、サーバー側では参照しない。理由:
- `CM_AUTH_TOKEN_HASH` が設定されていれば認証は必ず有効であるべき（安全側に倒す）
- `CM_AUTH_ENABLED=1` だが `CM_AUTH_TOKEN_HASH` 未設定という矛盾状態を防止
- **結論**: `CM_AUTH_ENABLED` のサーバーへの伝達は必須ではないが、daemon.tsの環境変数としては他のフラグと共に伝達する（将来的なデバッグ用途）

### CLIオプション組み合わせルール

| 起動方法 | プロトコル | 認証 | 動作 |
|----------|-----------|------|------|
| `commandmate start` | HTTP | なし | 従来通り |
| `commandmate start --auth` | HTTP（警告） | あり | 警告表示+HTTP起動 |
| `commandmate start --auth --allow-http` | HTTP | あり | 警告抑制 |
| `commandmate start --auth --cert X --key Y` | **HTTPS** | あり | 推奨構成 |
| `commandmate start --https --cert X --key Y` | HTTPS | なし | 特殊用途 |

- `--auth --cert --key` 指定時: `--https`は冗長（暗黙的にHTTPS有効化）
- `--auth --https` 同時指定: `--https`は冗長として無視
- `--cert`/`--key`は必ずペアで指定（片方のみはエラー）

#### S007: --allow-httpオプション使用時のリスク警告強化

`--allow-http` オプション使用時に、HTTP上でのトークン送信リスクをユーザーに明確に伝える。以下のいずれかの方式で対応する:

| 方式 | 採用 | 理由 |
|------|------|------|
| CLI対話型確認プロンプト | 検討 | 誤使用防止に最も効果的だが、`--daemon` モードで非対話となるため注意が必要 |
| **AUTH_HTTP_WARNINGの文言強化** | **優先** | KISS原則に基づくシンプルな対応。非対話モードでも機能 |

**AUTH_HTTP_WARNING強化案**:
```typescript
export const AUTH_HTTP_WARNING =
  'WARNING: Authentication over HTTP exposes tokens to network interception (MITM attack). ' +
  'Anyone on the same network can capture your authentication token. ' +
  'Use --cert/--key for HTTPS, or --allow-http to suppress this warning.';
```

**--daemon モード対応**: 対話型確認を採用する場合、`--daemon` オプションとの併用時は確認をスキップし、ログファイルに警告を記録する方式とする。

### boolean型環境変数の解釈ルール（R008）

`CM_AUTH_ENABLED`、`CM_HTTPS_ENABLED`、`CM_AUTH_ALLOW_HTTP` はboolean的な環境変数として以下のルールに従う:

| 状態 | 値 | 判定結果 |
|------|------|---------|
| 有効 | `'1'` | `true` |
| 無効 | 未設定 | `false` |
| 無効 | `''`（空文字） | `false` |
| 無効 | `'0'`, `'false'`, その他の値 | `false` |

**注意**: 値が `'1'` の場合のみ有効として扱う。`'true'` や `'yes'` は有効として扱わない。これは既存の `env.ts` のバリデーションパターンとの一貫性を保つための設計判断である。

---

## 8. パフォーマンス設計

### 8.1 認証オーバーヘッド

- SHA-256ハッシュ計算: ~1us/request（無視可能）
- Cookieパース: 文字列split（~0.01ms）
- レート制限チェック: Map.get()（O(1)）

### 8.2 middleware.tsのリクエストパイプライン影響（I003）

`src/middleware.ts` はNext.jsの全HTTPリクエストパイプラインに挿入される。現在プロジェクトには middleware.ts が存在しないため、全APIルートはmiddlewareなしで処理されている。middleware追加後の影響は以下の通り:

| 条件 | オーバーヘッド | 詳細 |
|------|-------------|------|
| 認証無効時（`isAuthEnabled() === false`） | 無視可能 | `isAuthEnabled()` は `process.env` の参照のみ（O(1)）。`NextResponse.next()` を即座に返却するため、関数呼び出しオーバーヘッドのみ（~0.001ms） |
| 認証有効時 | 軽微 | SHA-256ハッシュ計算（~1us） + Cookieパース（~0.01ms）のみ |

**ポーリングエンドポイントへの影響**: 高頻度ポーリングを行うAPIルート（`/api/worktrees/[id]/auto-yes-poll`、`/api/worktrees/[id]/check-response` 等）もmatcherに含まれるが、認証無効時は `process.env` 参照のみ、認証有効時もSHA-256計算（~1us）で処理が完結するため、ポーリング頻度（通常1-5秒間隔）に対してオーバーヘッドは無視可能である。

### 8.3 メモリ管理

- トークンハッシュ: 64バイト（固定）
- レート制限: ~200バイト/IPエントリ x 最大エントリ数
- 1時間ごとのクリーンアップで期限切れエントリを削除

#### S009: レート制限Mapのメモリ枯渇攻撃対策（nice_to_have）

大量の異なるIPからのDDoS攻撃により `Map<string, RateLimitEntry>` のサイズが無制限に増大するリスクがある。単一プロセスのローカル開発ツールとしてのリスクレベルは低いため、現時点では将来対応とする。

**将来対応案**: `MAX_RATE_LIMIT_ENTRIES = 10000` の上限を設定し、上限超過時は最も古いエントリ（`firstAttempt` が最小のもの）を削除するLRU方式を検討。

---

## 9. HTTPS対応設計

### 9.1 server.ts の条件分岐

> **R002 設計判断**: OCP観点では `createAppServer()` ファクトリ関数を `src/lib/server-factory.ts` に抽出すべきだが、server.ts は単一ファイルで複雑性増加を避けるためインライン条件分岐を採用する。
> **理由**: KISS優先。将来的な複数プロトコル対応（mTLS、HTTP/2等）が不要のため、現時点ではファクトリ抽出のコストに見合わない。将来プロトコル対応が増える場合はファクトリパターンへの移行を検討する。

```typescript
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';

// HTTPS判定
const certPath = process.env.CM_HTTPS_CERT;
const keyPath = process.env.CM_HTTPS_KEY;
const isHttps = certPath && keyPath;

let server;
if (isHttps) {
  // R009: 証明書読み込みエラーのハンドリング
  // ファイル破損・権限不足・シンボリックリンク切れ等に対応
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = readFileSync(certPath);
    key = readFileSync(keyPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read certificate files: ${message}`);
    console.error(`  cert: ${certPath}`);
    console.error(`  key: ${keyPath}`);
    // C002: ExitCode enumはsrc/cli/types/index.tsに定義されており、
    // tsconfig.server.jsonのinclude対象外のため使用不可。
    // server.tsではExitCode enumを使用せず、直接exit codeの数値を使用する。
    process.exit(2);
  }
  // S008: cert/keyペア整合性検証（ユーザーフレンドリーなエラーメッセージ）
  // https.createServer()のエラーをキャッチし、分かりやすいメッセージに変換
  // KISS原則に基づき、crypto.createPublicKey/createPrivateKeyによる事前検証ではなく、
  // https.createServer()のエラーハンドリングで対応する
  try {
    server = createHttpsServer({ cert, key }, requestHandler);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to create HTTPS server. Certificate and key may not match.');
    console.error(`  Detail: ${message}`);
    console.error('  Verify that the certificate and private key are a matching pair.');
    process.exit(2);
  }
} else {
  server = createHttpServer(requestHandler);
}

// I006: ログメッセージのプロトコル動的切替
// 現在の server.ts (L130) は 'http://' をハードコードしている。
// HTTPS起動時に不正確な表示となるため、プロトコルを動的に切り替える。
// C013（status.tsのHTTPS URL表示）と同様のパターンを適用する。
const protocol = isHttps ? 'https' : 'http';
server.listen(port, hostname, () => {
  console.log(`> Ready on ${protocol}://${hostname}:${port}`);
});
```

### 9.2 ws-server.ts の型拡張

```typescript
import { Server as HTTPServer } from 'http';
import { Server as HTTPSServer } from 'https';

export function setupWebSocket(server: HTTPServer | HTTPSServer): void {
  // 既存実装は変更不要（wsのnoServerモードは両方に対応）
  // C006: Node.jsのhttps.createServer()のupgradeイベントもhttp.IncomingMessageを使用する。
  // そのため、server.on('upgrade', (req, socket, head) => { ... }) のcallback型は
  // HTTPServer/HTTPSServerどちらでも同一（http.IncomingMessage）であり、型安全性が保証される。
}
```

### 9.3 証明書バリデーション（start.ts）

#### S003: 証明書ファイルパスの具体的バリデーション手順

証明書ファイルパス（`--cert`, `--key`）のバリデーションは以下の5段階で実施する。既存の `src/cli/utils/env-setup.ts` のパストラバーサル防止パターンとの一貫性を確保する。

```typescript
import path from 'path';
import fs from 'fs';

// S003: 証明書ファイルパスバリデーション関数
function validateCertificatePath(filePath: string, label: string): string {
  // Step 1: path.resolve() で絶対パスに正規化
  // 相対パス・../・シンボリックリンクを含むパスを正規化
  const resolvedPath = path.resolve(filePath);

  // Step 2: fs.lstatSync() でシンボリックリンクを検出
  // シンボリックリンク経由のパストラバーサルを防止
  const stat = fs.lstatSync(resolvedPath);
  if (stat.isSymbolicLink()) {
    // シンボリックリンクの場合は fs.realpathSync() で実体パスを解決し、
    // 解決後のパスでバリデーションを継続
    const realPath = fs.realpathSync(resolvedPath);
    // realPath に対して Step 3-5 を適用
    return validateCertificatePathInternal(realPath, label, stat);
  }

  return validateCertificatePathInternal(resolvedPath, label, stat);
}

function validateCertificatePathInternal(
  resolvedPath: string,
  label: string,
  stat: fs.Stats
): string {
  // Step 3: 拡張子ホワイトリスト確認
  const ALLOWED_CERT_EXTENSIONS = ['.pem', '.crt', '.key', '.cert'] as const;
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!ALLOWED_CERT_EXTENSIONS.includes(ext as typeof ALLOWED_CERT_EXTENSIONS[number])) {
    throw new Error(
      `Invalid ${label} file extension: ${ext}. ` +
      `Allowed: ${ALLOWED_CERT_EXTENSIONS.join(', ')}`
    );
  }

  // Step 4: ファイルサイズ上限確認（1MB以下）
  const MAX_CERT_FILE_SIZE = 1 * 1024 * 1024; // 1MB
  if (stat.size > MAX_CERT_FILE_SIZE) {
    throw new Error(
      `${label} file too large: ${stat.size} bytes. Maximum: ${MAX_CERT_FILE_SIZE} bytes`
    );
  }

  // Step 5: ファイルパーミッション確認（警告のみ）
  // 秘密鍵ファイルのパーミッションが過度に緩い場合は警告
  // 600 (owner read/write) または 400 (owner read-only) を推奨
  const mode = stat.mode & 0o777;
  if (label === 'key' && mode > 0o604) {
    console.warn(
      `Warning: ${label} file has permissive permissions (${mode.toString(8)}). ` +
      `Recommended: 600 or 400`
    );
  }

  return resolvedPath;
}
```

**バリデーション定数**:

| 定数名 | 値 | 説明 |
|--------|------|------|
| `ALLOWED_CERT_EXTENSIONS` | `['.pem', '.crt', '.key', '.cert']` | 許可される証明書ファイル拡張子 |
| `MAX_CERT_FILE_SIZE` | `1048576` (1MB) | 証明書ファイルの最大サイズ |

**env-setup.tsとの一貫性**: 既存の `env-setup.ts` ではパストラバーサル防止に `path.resolve()` を使用している。証明書バリデーションでも同一パターンを採用し、追加でシンボリックリンク解決と拡張子ホワイトリストを実施する。

---

## 10. i18n対応

### 10.1 新規namespace: auth

**ファイル**: `locales/en/auth.json`, `locales/ja/auth.json`

```json
// locales/en/auth.json
{
  "login": {
    "title": "Authentication Required",
    "tokenLabel": "Enter your access token",
    "tokenPlaceholder": "Paste your token here",
    "submit": "Login",
    "error": "Invalid token",
    "rateLimited": "Too many attempts. Please try again in {minutes} minutes.",
    "expired": "Token has expired"
  },
  "logout": {
    "button": "Logout"
  }
}
```

### 10.2 src/i18n.ts 変更

```typescript
const [common, worktree, autoYes, error, prompt, auth] = await Promise.all([
  import(`../locales/${locale}/common.json`),
  import(`../locales/${locale}/worktree.json`),
  import(`../locales/${locale}/autoYes.json`),
  import(`../locales/${locale}/error.json`),
  import(`../locales/${locale}/prompt.json`),
  import(`../locales/${locale}/auth.json`),  // 追加
]);

// C005: 既存のi18n.tsはnamespace付きキー形式でマージしている。
// スプレッド演算子でフラットにマージするのではなく、namespace付きオブジェクトとして追加する。
return {
  messages: {
    common: common.default,
    worktree: worktree.default,
    autoYes: autoYes.default,
    error: error.default,
    prompt: prompt.default,
    auth: auth.default,  // 追加: namespace付きキー形式（既存パターン準拠）
  }
};
```

---

## 11. ビルド設定

### 11.1 tsconfig.server.json

```json
{
  "include": [
    // ... 既存エントリ
    "src/lib/auth.ts"  // 追加
  ]
}
```

**C002: server.tsのExitCode制約**: `server.ts` は `tsconfig.server.json` でビルドされるが、`ExitCode` enumは `src/cli/types/index.ts` に定義されており `tsconfig.server.json` のinclude対象外である。そのため、**server.tsではExitCode enumを使用せず、直接exit codeの数値を使用する**（例: `process.exit(2)`）。

**I008: auth.tsの依存関係制約**: `auth.ts` は `tsconfig.server.json` の include に追加されるため、**外部依存（`@/` パスエイリアス経由の import）を持たないこと**を実装制約とする。Node.js標準モジュール（`crypto` 等）のみに依存し、`@/config/auto-yes-config.ts` 等へのimportは行わない。`auto-yes-config.ts` の `ALLOWED_DURATIONS` パターンは設計パターンの参考にとどめる。誤って `@/` パスエイリアスを使用した場合、`tsconfig.server.json` の `paths` 解決により意図しないファイルがビルド依存関係に含まれるリスクがある。

**I004: rateLimiterの遅延初期化方針**: auth.tsのモジュールスコープで `rateLimiter` インスタンスを作成する設計（Section 6.2参照）において、`createRateLimiter()` 内の `setInterval`（クリーンアップタイマー）は `isAuthEnabled()` が `true` の場合のみ開始する。認証無効時（`CM_AUTH_TOKEN_HASH` 未設定）にserver.tsからauth.tsをimportしても不要なタイマーが起動しないよう、以下のガード付き初期化を採用する:

```typescript
// auth.ts モジュールスコープ
// I004: 認証無効時に不要なsetIntervalを防止
const rateLimiter = isAuthEnabled() ? createRateLimiter() : null;

export function destroyRateLimiter(): void {
  rateLimiter?.destroy();
}
```

### 11.2 auth.ts のCLIビルド互換性制約（C001）

**問題**: `tsconfig.cli.json` は `src/cli/**/*` のみをincludeしているため、CLIの `start.ts` から `src/lib/auth.ts` を直接importするとTypeScriptコンパイルエラーが発生する。

**解決策**: CLIビルドとサーバービルドの分離を維持するため、`auth.ts` を `tsconfig.cli.json` のincludeには追加しない。代わりに、CLI側で必要なトークン生成関数を `src/cli/utils/auth-helper.ts` として別途作成する。

| 方式 | 採用 | 理由 |
|------|------|------|
| `tsconfig.cli.json` に `src/lib/auth.ts` を追加 | 不採用 | CLIビルドとサーバービルドの分離が崩れる。パスエイリアス（`@/*`）が `tsconfig.cli.json` では `paths:{}` で無効化されているため相対パスimportが必要になり、保守性が低下する |
| `start.ts` にインライン実装 | 不採用 | DRY違反。auth.tsとの重複コード |
| **`src/cli/utils/auth-helper.ts` を新規作成** | **採用** | CLIビルド分離を維持。必要最小限の関数（`generateToken()`, `hashToken()`）のみを含む。Node.js標準 `crypto` モジュールのみ依存 |

```typescript
// src/cli/utils/auth-helper.ts（新規ファイル）
import { randomBytes, createHash } from 'crypto';

// S012: IMPORTANT: This algorithm MUST match src/lib/auth.ts
// アルゴリズム変更時は両ファイルの同期更新が必須

/** CLI用トークン生成（32バイトランダム、hex文字列） */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256ハッシュ計算 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

**注意**: `auth-helper.ts` と `auth.ts` でトークン生成・ハッシュ計算のロジックが重複するが、これはビルド分離を維持するための意図的なトレードオフである。両ファイルの実装は同一のアルゴリズム（`crypto.randomBytes(32)`, `crypto.createHash('sha256')`）を使用し、互換性を担保する。テストでは両方の出力が相互互換であることを検証する。

### 11.3 テスト設定

- `middleware.ts` テストでは `NextRequest`/`NextResponse` のモックが必要
- `vitest.setup.ts` でモック定義、または `vi.mock('next/server')` をテスト内で使用

**I011: モックスコープの明確化**: `vi.mock('next/server')` は **テストファイルレベル**（ファイル先頭の `vi.mock()` 呼び出し）で使用し、グローバルな `vitest.setup.ts` には追加しない。`vitest.config.ts` の `environment` は `'node'` であり、`NextRequest`/`NextResponse` はEdge Runtime向けAPIであるため、他のテストファイル（APIルートテスト等）が `next/server` の実体を使用している場合にモック汚染が発生するリスクがある。テストファイル内で `afterEach(() => { vi.restoreAllMocks(); })` を呼び出し、モックの影響を局所化すること。

### 11.4 ビルド全体への影響（I013）

`npm run build:all`（Next.js + CLI + server 全ビルド一括実行）への影響:

| ビルドターゲット | 影響 | 詳細 |
|---------------|------|------|
| `npm run build`（Next.js） | `src/middleware.ts` が自動的に含まれる | Next.js App Routerのファイル規約により、`src/middleware.ts` はビルド時に自動検出される。`auth.ts` からの import は `@/lib/auth` パスで解決される |
| `npm run build:server` | `auth.ts` が tsconfig.server.json の include で明示的に含まれる | Section 11.1参照 |
| `npm run build:cli` | `auth-helper.ts` が `src/cli/**/*` パターンで含まれる | `src/lib/auth.ts` はinclude対象外（Section 11.2参照） |

---

## 12. 実装順序ガイダンス

```
Phase 1: 基盤
  1. src/lib/auth.ts（トークン生成・検証・レート制限・destroyRateLimiter()）
  2. src/cli/utils/auth-helper.ts（C001: CLI用トークン生成ヘルパー、新規）
  3. locales/*/auth.json（i18n翻訳）
  4. src/i18n.ts（auth namespace追加）

Phase 2: サーバー・認証
  5. server.ts（HTTP/HTTPS条件分岐、C002: process.exit(2)使用）
  6. src/lib/ws-server.ts（型拡張 + upgrade認証）
  7. src/middleware.ts（HTTPリクエスト認証、C011: 完全スケルトン参照）

Phase 3: API・UI
  8. src/app/api/auth/login/route.ts
  9. src/app/api/auth/logout/route.ts
  10. src/app/api/auth/status/route.ts
  11. src/app/login/page.tsx

Phase 4: CLI
  12. src/cli/types/index.ts（StartOptions拡張、I007: 全フィールドoptional）
  13. src/cli/commands/start.ts（--auth等オプション、auth-helper.ts使用、I005: foregroundモード認証環境変数設定）
  14. src/cli/index.ts（commander定義追加）
  15. src/cli/utils/daemon.ts（環境変数伝達、C008参照）

Phase 5: 周辺
  16. src/cli/config/security-messages.ts（メッセージ更新、C015参照）
  17. src/cli/commands/status.ts（HTTPS URL表示、C013参照）
  18. tsconfig.server.json（auth.ts追加）
  19. docs/security-guide.md
  20. CLAUDE.md更新
```

### Phase 4: daemon.ts環境変数伝達の具体的方針（C008）

`DaemonManager.start()` の `env` 構築部分に認証・HTTPS関連の環境変数を追加する。現在の `daemon.ts` は `options.port` と `options.dbPath` のみを `env` にオーバーライドしているが、以下の変数を追加伝達する:

```typescript
// daemon.ts の DaemonManager.start() 内 env構築
const env: Record<string, string> = {
  ...process.env,
  PORT: String(options.port),
  CM_DB_PATH: options.dbPath,
  // C008: 認証・HTTPS環境変数の伝達
  // CM_AUTH_TOKEN_HASHはセキュリティ上重要。
  // spawn時のenv経由でのみ伝達し、コマンドライン引数やファイルには書き出さない。
  ...(process.env.CM_AUTH_TOKEN_HASH && {
    CM_AUTH_TOKEN_HASH: process.env.CM_AUTH_TOKEN_HASH,
  }),
  ...(process.env.CM_AUTH_TOKEN_EXPIRE_AT && {
    CM_AUTH_TOKEN_EXPIRE_AT: process.env.CM_AUTH_TOKEN_EXPIRE_AT,
  }),
  ...(process.env.CM_AUTH_ENABLED && {
    CM_AUTH_ENABLED: process.env.CM_AUTH_ENABLED,
  }),
  ...(process.env.CM_HTTPS_CERT && {
    CM_HTTPS_CERT: process.env.CM_HTTPS_CERT,
  }),
  ...(process.env.CM_HTTPS_KEY && {
    CM_HTTPS_KEY: process.env.CM_HTTPS_KEY,
  }),
  ...(process.env.CM_HTTPS_ENABLED && {
    CM_HTTPS_ENABLED: process.env.CM_HTTPS_ENABLED,
  }),
  ...(process.env.CM_AUTH_ALLOW_HTTP && {
    CM_AUTH_ALLOW_HTTP: process.env.CM_AUTH_ALLOW_HTTP,
  }),
};
```

**注意**: `CM_AUTH_TOKEN_HASH` はハッシュ値のみを伝達するため、spawn時のenv経由での伝達はセキュリティ上問題ない（トークン平文はCLIプロセスで表示後に破棄される）。

### Phase 4: start.ts foregroundモードの認証環境変数設定（I005）

`start.ts` の foreground モード（L130-179付近）は `env` オブジェクトを構築して `spawn` に渡す設計である。`--auth` オプション処理時には、daemon.ts（C008）と同様のパターンで認証・HTTPS環境変数を `env` に追加する必要がある。

```typescript
// start.ts foreground モードの env 構築部分（L148-163付近）
const env: Record<string, string> = {
  ...process.env,
  PORT: String(port),
  CM_DB_PATH: dbPath,
  // I005: foregroundモードでも認証環境変数を伝達
  // daemon.ts（C008）と同一パターン
  ...(process.env.CM_AUTH_TOKEN_HASH && {
    CM_AUTH_TOKEN_HASH: process.env.CM_AUTH_TOKEN_HASH,
  }),
  ...(process.env.CM_AUTH_TOKEN_EXPIRE_AT && {
    CM_AUTH_TOKEN_EXPIRE_AT: process.env.CM_AUTH_TOKEN_EXPIRE_AT,
  }),
  ...(process.env.CM_HTTPS_CERT && {
    CM_HTTPS_CERT: process.env.CM_HTTPS_CERT,
  }),
  ...(process.env.CM_HTTPS_KEY && {
    CM_HTTPS_KEY: process.env.CM_HTTPS_KEY,
  }),
  // CM_AUTH_ALLOW_HTTP, CM_HTTPS_ENABLED も同様に伝達
};
```

**注意**: foreground モードと daemon モードで認証環境変数の伝達方式が一致していることを保証すること。両者のenv構築ロジックの重複はDRY違反だが、start.tsとdaemon.tsでのenv構築コンテキストが異なるため、現時点では許容する。

### Phase 5: status.tsのHTTPS URL表示方針（C013）

`status.ts` のHTTPS対応は以下の方針で実装する:

```typescript
// DaemonManager.getStatus() 内のURL生成
// 現在: url: `http://localhost:${port}` がハードコード
// 変更: CM_HTTPS_CERTとCM_HTTPS_KEYの有無でプロトコルを切り替え
const protocol = (process.env.CM_HTTPS_CERT && process.env.CM_HTTPS_KEY) ? 'https' : 'http';
const url = `${protocol}://localhost:${port}`;
```

### Phase 5: security-messages.tsの変更方針（C015）

`security-messages.ts` の変更方針:

| 状態 | 表示メッセージ | 定数名 |
|------|-------------|--------|
| `--auth` なし | 既存 `REVERSE_PROXY_WARNING` | 変更なし |
| `--auth` + HTTPS | 認証有効メッセージ | `AUTH_ENABLED_MESSAGE` |
| `--auth` + HTTP（`--allow-http`なし） | HTTP警告 | `AUTH_HTTP_WARNING` |
| `--auth` + HTTP（`--allow-http`あり） | 警告抑制 | - |

#### REVERSE_PROXY_WARNINGとの共存ルール（I010）

現在の `start.ts`（L166-169）は `bindAddress === '0.0.0.0'` の場合に `REVERSE_PROXY_WARNING` を表示する。`--auth` オプション追加後の警告メッセージ表示優先順位は以下の通り:

| 条件 | 表示メッセージ | 理由 |
|------|-------------|------|
| `--auth` なし + `0.0.0.0` バインド | `REVERSE_PROXY_WARNING` のみ | 従来通り |
| `--auth` あり + HTTPS | `AUTH_ENABLED_MESSAGE` のみ | 認証+HTTPS有効時はリバースプロキシ警告は不要（直接HTTPS配信のため） |
| `--auth` あり + HTTP + `0.0.0.0` バインド | `AUTH_HTTP_WARNING` のみ | `AUTH_HTTP_WARNING` が `REVERSE_PROXY_WARNING` を包含（HTTP上でのトークン送信リスクの方が重大） |
| `--auth` あり + HTTP + `--allow-http` | 警告なし（`AUTH_ENABLED_MESSAGE` のみ） | ユーザーが明示的にHTTP使用を承認 |

**方針**: `--auth` 有効時は `REVERSE_PROXY_WARNING` を抑制し、認証固有の警告メッセージ（`AUTH_HTTP_WARNING` または `AUTH_ENABLED_MESSAGE`）のみを表示する。これは、認証が有効な場合はリバースプロキシの推奨よりもHTTPS使用の推奨の方が適切であるためである。

```typescript
// 新規追加定数
export const AUTH_HTTP_WARNING =
  'Warning: --auth without HTTPS. Tokens will be transmitted in plaintext. ' +
  'Use --cert/--key for HTTPS, or --allow-http to suppress this warning.';

export const AUTH_ENABLED_MESSAGE =
  'Token authentication enabled. Token expires in {duration}.';
```

---

## 13. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| メモリベーストークン管理 | サーバー再起動で自動失効、DB不要 | クラスタリング非対応（不要） |
| Cookie平文トークン格納 | ステートフルセッション不要、実装シンプル | Cookie漏洩=トークン漏洩（HttpOnly+Secure+SameSiteで保護） |
| SHA-256ハッシュ比較 | bcrypt不要（トークンは十分にランダム）、高速 | - |
| 自前Cookieパース | ws-serverで外部依存不要 | パースエッジケースのリスク（シンプルな形式のみ対応） |
| 自前期間パース | ホワイトリスト方式（R005）、msライブラリ不要 | ALLOWED_AUTH_DURATIONSに限定（YAGNI） |
| env変数経由のトークン伝達 | spawn環境変数は安全 | S010: `/proc/<pid>/environ`（Linux）や `ps e`（macOS）で環境変数読取可能だが、256ビットランダムトークンのSHA-256ハッシュのため復元は計算的に不可能。実質的リスクは無視可能 |
| レート制限Mapベース | 外部依存不要、シンプル | プロキシ背後で同一IP問題（X-Forwarded-Forは信頼性に課題） |
| HTTPS条件分岐をserver.tsにインライン（R002） | KISS優先。単一ファイルでの複雑性増加を避ける | OCP違反だが、複数プロトコル対応が不要のため許容。将来mTLS/HTTP2対応時はファクトリ抽出を検討 |
| auth.tsにレート制限を同居（R001） | KISS優先。現時点でファイル分割はオーバーエンジニアリング | SRP違反の可能性。セクションコメントで区切り、将来的にauth-rate-limiter.tsへの分離を検討 |
| 具象関数への直接依存（R003） | YAGNI原則。認証戦略は現時点でトークン認証のみ | 将来OAuth等追加時はverifyRequest()統合関数の導入を検討 |
| CLI用auth-helper.tsの重複コード（C001） | CLIビルドとサーバービルドの分離維持 | DRY違反だがビルド境界を維持。テストで互換性を検証。S012: 両ファイルに「IMPORTANT: This algorithm MUST match auth.ts/auth-helper.ts」コメントを追加 |
| server.tsでのExitCode非使用（C002） | tsconfig.server.jsonのinclude制約 | 可読性低下（数値リテラル使用）だがビルド分離を維持 |
| 認証環境変数のENV_MAPPING非統合（C003） | レガシーフォールバック不要 | getEnvByKey()パターンとの不統一だが意図的な設計判断 |

### 代替案との比較

| 代替案 | 不採用理由 |
|-------|----------|
| JWT認証 | 単一トークンに過剰。有効期限管理・リフレッシュトークン等の複雑性 |
| セッションDB（SQLite） | YAGNI。サーバー再起動でのセッション永続化は不要 |
| bcryptハッシュ | 遅い（意図的）。高エントロピートークンにはSHA-256で十分 |
| Redis レート制限 | 外部依存増加。単一プロセス構成ではMap十分 |

---

## 14. 変更対象ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `src/lib/auth.ts` | 新規 | トークン生成・検証・レート制限・destroyRateLimiter() |
| `src/cli/utils/auth-helper.ts` | 新規 | CLI用トークン生成ヘルパー（C001対応） |
| `src/middleware.ts` | 新規 | HTTP認証ミドルウェア（Section 5.3完全スケルトン参照、C011） |
| `src/app/api/auth/login/route.ts` | 新規 | ログインAPI |
| `src/app/api/auth/logout/route.ts` | 新規 | ログアウトAPI |
| `src/app/api/auth/status/route.ts` | 新規 | 認証状態API |
| `src/app/login/page.tsx` | 新規 | ログイン画面 |
| `locales/en/auth.json` | 新規 | 英語翻訳 |
| `locales/ja/auth.json` | 新規 | 日本語翻訳 |
| `server.ts` | 変更 | HTTP/HTTPS条件分岐（C002: process.exit(2)使用）、destroyRateLimiter()呼び出し |
| `src/lib/ws-server.ts` | 変更 | 型拡張（C006: IncomingMessage型安全性確認済み）、upgrade認証 |
| `src/cli/types/index.ts` | 変更 | StartOptions拡張 |
| `src/cli/commands/start.ts` | 変更 | auth/HTTPS オプション処理（auth-helper.ts使用） |
| `src/cli/index.ts` | 変更 | commander定義追加 |
| `src/cli/utils/daemon.ts` | 変更 | 環境変数伝達（C008: 具体的コード例はSection 12参照） |
| `src/cli/commands/status.ts` | 変更 | HTTPS URL表示（C013: プロトコル動的切替） |
| `src/cli/config/security-messages.ts` | 変更 | --auth時メッセージ分岐（C015: AUTH_HTTP_WARNING/AUTH_ENABLED_MESSAGE追加） |
| `src/i18n.ts` | 変更 | auth namespace追加（C005: namespace付きキー形式） |
| `tsconfig.server.json` | 変更 | auth.ts include追加 |
| `.env.example` | 変更 | HTTPS関連コメント追加 |
| `docs/security-guide.md` | 変更 | 認証+HTTPS使用ガイド |
| `tests/integration/i18n-namespace-loading.test.ts` | 変更 | I001: `EXPECTED_NAMESPACES` 配列に `'auth'` を追加し、ファイル数検証を6に更新 |

**I007: StartOptions型拡張の後方互換性保証**: `src/cli/types/index.ts` の `StartOptions` に追加するフィールド（`auth`, `authExpire`, `cert`, `key`, `https`, `allowHttp` 等）は全て **optional（`?` 付き）** として定義する。これにより、既存のCLIテスト（`tests/unit/cli/` 配下）は StartOptions の追加フィールドなしで従来通り動作する。

**I009: init コマンドの .env テンプレート更新方針**: `commandmate init` コマンドが生成する `.env` ファイルテンプレートには、認証・HTTPS関連の環境変数を **コメント付き** で含める。ユーザーが必要に応じてコメントを解除して使用できる形式とする。対象ファイル:
- `src/cli/utils/env-setup.ts` - .env テンプレート生成ロジックに認証・HTTPS環境変数のコメント追記
- `src/cli/commands/init.ts` - 変更不要（env-setup.ts経由で反映）

**I014: server.ts gracefulShutdown のコンフリクト解決ガイド**: `server.ts` の `gracefulShutdown()` は全Issueで共有されるファイルであり、将来的にコンフリクトの可能性がある。`destroyRateLimiter()` 呼び出しは、既存の `stopAllPolling()` / `stopAllAutoYesPolling()` の **後に** 追加する方針とする。コンフリクト解決時はこの順序を維持すること。

### 変更不要（既に対応済み）

| ファイル | 理由 |
|---------|------|
| `src/hooks/useWebSocket.ts` | wss://自動検出済み。I016: ブラウザ WebSocket API はハンドシェイク時に Cookie ヘッダーを自動送信するため、WebSocket 認証用の HttpOnly Cookie は明示的な追加実装なしに ws-server.ts 側で `req.headers.cookie` から取得可能 |
| `next.config.js` | CSPで ws:/wss: 両方許可済み |
| `tsconfig.cli.json` | C001: includeにauth.tsを追加しない（ビルド分離維持） |
| `src/lib/env.ts` | C003: Env interface/ENV_MAPPING拡張しない |

---

## 15. クライアント側トークン期限切れハンドリング（R014）

トークン期限切れ時のクライアント側UXフロー:

### 15.1 HTTPリクエスト（middleware.ts経由）

- middleware.tsが401レスポンスを返す際に `/login` へリダイレクト
- Next.js middleware の `NextResponse.redirect()` を使用

### 15.2 APIリクエスト（フロントエンド）

- APIルートの401レスポンス時にフロントエンドで `window.location.href = '/login'` にリダイレクト
- 既存のfetch呼び出しのレスポンスハンドリングに401チェックを追加

### 15.3 WebSocket接続

- WebSocket切断時は再接続ループ内で `/api/auth/status` を確認
- `authEnabled: true` かつ401の場合はログイン画面へ遷移

**I012: useWebSocket.ts の変更方針明確化**: 認証チェックは `useWebSocket.ts` の再接続ロジック内に直接統合するのではなく、**別フック（`useAuthCheck.ts` 等）で認証状態を監視し、認証失敗時にログイン画面へリダイレクトする方式**を採用する。これにより `useWebSocket.ts` 自体は変更不要（Section 14「変更不要」リストと整合）。WebSocket切断時の認証チェックは、再接続前に `/api/auth/status` を呼び出すラッパーロジックで対応し、`useWebSocket.ts` の既存の `setTimeout` ベース再接続ロジック（L137-141）には手を加えない。

**注意**: この方針により、Section 14 の「変更不要」リストに記載の `useWebSocket.ts` の位置付けが維持される。将来的に再接続ロジック内への統合が必要になった場合は、`useWebSocket.ts` を変更対象に移動すること。

---

## 16. テスト方針（C014）

### 16.1 auth.ts ユニットテスト

| テスト対象関数 | テスト内容 |
|--------------|----------|
| `generateToken()` | 64文字hex文字列の生成、呼び出し毎に異なる値 |
| `hashToken()` | 既知入力に対するSHA-256ハッシュの一致、auth-helper.tsとの互換性検証 |
| `verifyToken()` | 正しいトークンでtrue、不正トークンでfalse、空文字列でfalse、S001: crypto.timingSafeEqual()が使用されていることの検証（spy確認） |
| `authenticateRequest()` | 有効Cookie/無効Cookie/期限切れ/Cookie無し/認証無効時のAuthResult検証 |
| `isTokenExpired()` | 未来のexpireAtでfalse、過去のexpireAtでtrue、0でfalse（無期限） |
| `parseDuration()` | ALLOWED_AUTH_DURATIONS内の各値で正しいミリ秒変換、範囲外でエラー |
| `parseCookieToken()` | 単一Cookie/複数Cookie/Cookie無し/不正形式のパース検証、S006: エッジケース検証（下記参照） |
| `createRateLimiter()` | maxAttempts超過でlocked、成功でリセット、destroy()でタイマー解放 |
| `isAuthEnabled()` | CM_AUTH_TOKEN_HASH設定時true、未設定時false |

#### S006: parseCookieToken()のセキュリティエッジケーステスト

以下のエッジケースを `parseCookieToken()` のテストに含めること:

| テストケース | 入力例 | 期待結果 |
|------------|-------|---------|
| Cookie値の最大長超過 | 4096バイト超のCookieヘッダー | `undefined`（パース拒否） |
| トークンフォーマット不正 | `cm_auth_token=not-hex-string` | `undefined`（`/^[a-f0-9]{64}$/` 検証失敗） |
| 同名Cookie複数存在 | `cm_auth_token=aaa; cm_auth_token=bbb` | 最初のマッチを使用 |
| Cookie値に`;`を含む | `cm_auth_token=ab;cd` | `undefined`（フォーマット検証失敗） |
| 不正なUTF-8シーケンス | バイナリ含むCookieヘッダー | `undefined` またはエラーなし |

**parseCookieToken()の実装制約（S006）**:
- Cookie ヘッダー全体の最大長チェック: 4096バイト超は即座に `undefined` を返す
- 抽出したトークン値のフォーマット検証: `/^[a-f0-9]{64}$/` にマッチしない場合は `undefined` を返す
- 同名Cookie複数存在時: `split(';')` の最初のマッチを使用（RFC 6265準拠）

### 16.2 auth-helper.ts ユニットテスト

| テスト対象関数 | テスト内容 |
|--------------|----------|
| `generateToken()` | auth.tsのgenerateToken()と同一形式の出力 |
| `hashToken()` | auth.tsのhashToken()と同一のハッシュ値を返すこと（互換性検証） |

### 16.3 middleware.ts テスト

- **モック戦略**: `vi.mock('next/server')` で `NextRequest`/`NextResponse` をモック（I011: テストファイルレベルでの局所モック、Section 11.3参照）
- **モックスコープ注意事項（I011）**: `vi.mock('next/server')` はテストファイル先頭で呼び出し、`afterEach(() => { vi.restoreAllMocks(); })` でモックをリセットすること。グローバルな `vitest.setup.ts` にはモック定義を追加しない。
- **テストケース**:
  - 認証無効時: 全リクエストが `NextResponse.next()` で通過
  - 認証有効時 + 除外パス: `/login`, `/api/auth/*` が通過
  - 認証有効時 + 有効Cookie: `NextResponse.next()` で通過
  - 認証有効時 + 無効/期限切れCookie: `/login` へリダイレクト
  - 認証有効時 + Cookie無し: `/login` へリダイレクト

### 16.4 WebSocket認証 結合テスト

- ws-server.tsのupgradeハンドラーに対して:
  - 認証無効時: Cookie無しで接続成功
  - 認証有効時 + 有効Cookie: 接続成功
  - 認証有効時 + 無効Cookie: 接続拒否（401）
  - 認証有効時 + Cookie無し: 接続拒否（401）

**I002: 既存WebSocketテストへの影響保証**: `tests/integration/websocket.test.ts` の既存6テストケースは `CM_AUTH_TOKEN_HASH` 未設定状態で実行されるため、`isAuthEnabled()` のガードにより認証ロジックがスキップされ影響なし。ただし、ws-server.ts の upgrade ハンドラーに認証ロジックを追加した後は、テストの `beforeEach` で `delete process.env.CM_AUTH_TOKEN_HASH` を明示的に実行し、認証無効状態であることを保証する防御的ガードを追加することを推奨する。

### 16.5 ログインフロー E2Eテスト方針

- `/api/auth/login` に正しいトークンをPOST → 200 + Set-Cookie
- `/api/auth/login` に不正トークンをPOST → 401
- レート制限: 5回失敗後 → 429 + Retry-After
- ログアウト: `/api/auth/logout` POST → Cookie削除確認

**I015: 既存E2Eテスト（Playwright）の実行方針**: 既存のE2Eテストは認証なしモード（`--auth` なし）で起動したサーバーに対して実行する。HTTPS/認証対応のE2Eテストは新規テストファイルとして追加し、既存テストとは分離する。既存E2Eテスト環境にHTTPS設定（自己署名証明書の無視、baseURL変更等）の変更は不要。

### 16.6 i18n namespaceテスト更新（I001）

`tests/integration/i18n-namespace-loading.test.ts` のハードコードされた `EXPECTED_NAMESPACES` 配列と namespace ファイル数検証を更新する:

- `EXPECTED_NAMESPACES` に `'auth'` を追加: `['common', 'worktree', 'autoYes', 'error', 'prompt', 'auth']`
- ファイル数検証のアサーション値を `5` から `6` に更新
- テスト名（`'should have exactly 5 namespace files per locale matching src/i18n.ts'`）を `6` に更新

---

## 17. レビュー履歴

| 日付 | ステージ | レビュー種別 | レビュー結果 |
|------|---------|------------|------------|
| 2026-02-21 | Stage 1 | 通常レビュー（設計原則） | Conditional Approved（must_fix: 3, should_fix: 6, nice_to_have: 6） |
| 2026-02-21 | Stage 2 | 整合性レビュー | Conditional Approved（must_fix: 3, should_fix: 8, nice_to_have: 5） |
| 2026-02-21 | Stage 3 | 影響分析レビュー | Conditionally Approved（must_fix: 3, should_fix: 8, nice_to_have: 5） |
| 2026-02-21 | Stage 4 | セキュリティレビュー | Conditionally Approved（must_fix: 3, should_fix: 5, nice_to_have: 4） |

---

## 18. レビュー指摘事項サマリー（Stage 1: 設計原則）

### 18.1 Must Fix（必須対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| R002 | OCP | server.tsへのHTTPS条件分岐追加がOCPに抵触する可能性 | KISS優先でインライン条件分岐を採用。トレードオフとして明記 | Section 9.1, Section 13 |
| R006 | DRY | Cookie名定数の重複リスク | AUTH_COOKIE_NAME, AUTH_EXCLUDED_PATHS をauth.tsに一元定義 | Section 2.3, Section 5.3 |
| R012 | DRY | 認証有効/無効判定ロジックの一元化が不十分 | isAuthEnabled()をauth.tsに定義、全箇所から参照 | Section 2.3, Section 5.4 |

### 18.2 Should Fix（推奨対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| R001 | SRP | auth.tsに4責務が集中 | 将来的なauth-rate-limiter.ts分離を設計メモとして記録 | Section 2.3, Section 13 |
| R005 | YAGNI | parseDuration()の汎用性がYAGNIに抵触 | ALLOWED_AUTH_DURATIONSホワイトリスト方式を明記 | Section 2.3, Section 13 |
| R007 | DRY | Cookieパースロジックの重複リスク | authenticateRequest()統合認証関数をauth.tsに追加 | Section 2.3 |
| R009 | エラーハンドリング | 証明書ファイル読み込みエラーのハンドリングが不十分 | server.tsにtry-catch追加、エラーメッセージにパスと原因を含める | Section 9.1 |
| R010 | エラーハンドリング | レート制限のgraceful shutdown時のcleanupタイマー解放が不明確 | createRateLimiter()がdestroy()メソッドを持つ設計を明記 | Section 6.2 |
| R014 | エラーハンドリング | トークン期限切れ時のクライアント側UX設計が不足 | クライアント側期限切れハンドリングセクション追加 | Section 15 |

### 18.3 Nice to Have（検討事項）

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| R003 | DIP | middleware.tsとws-server.tsがauth.tsの具象関数に直接依存 | YAGNI原則に基づき現時点は許容。将来の認証戦略インターフェース導入メモをSection 13に記録済み |
| R004 | KISS | CLIオプション組み合わせルールの複雑性 | 現在の5パターンは実用上問題なし。暗黙的挙動の明示ログ出力は実装時に検討 |
| R008 | 命名 | boolean型環境変数の値解釈が不統一 | Section 7にboolean型環境変数の解釈ルールを追記済み |
| R011 | OCP | i18n namespace追加パターンの拡張性 | 既存パターンに従う。namespace数が10を超える場合に動的importを検討 |
| R013 | 命名 | ファイル命名パターンの一貫性（auth.ts） | YAGNI原則に基づきauth.tsで問題なし。将来必要時にリネーム |
| R015 | その他 | tsconfig.server.jsonへのauth.ts追加はtsconfig.cli.jsonとの二重include | tsconfig.cli.jsonのincludeパターン確認が必要。Section 11.2の制約に準拠 |

---

## 19. レビュー指摘事項サマリー（Stage 2: 整合性レビュー）

### 19.1 Must Fix（必須対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| C001 | 設計書-コード整合性 | tsconfig.cli.jsonがsrc/cli/**/*のみincludeのため、start.tsからsrc/lib/auth.tsをimportできない | src/cli/utils/auth-helper.tsを新規作成し、CLI用トークン生成関数を配置。tsconfig.cli.jsonのincludeは変更しない（ビルド分離維持） | Section 2.3, Section 11.2, Section 12, Section 14 |
| C002 | 設計書-コード整合性 | server.tsの設計コード例でExitCodeを参照しているがserver.tsには現在importされていない | server.tsのprocess.exit(ExitCode.CONFIG_ERROR)をprocess.exit(2)に変更。server.tsはExitCode enumを使用しない方針を明記 | Section 9.1, Section 11.1 |
| C003 | 設計書-コード整合性 | 新環境変数がENV_MAPPINGおよびEnv interfaceに追加される設計が記載されていない | 認証環境変数はENV_MAPPINGに追加せず、process.env直接参照。Env interface拡張なし。理由と方針を明記 | Section 7 |

### 19.2 Should Fix（推奨対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| C004 | 設計書内整合性 | AuthState初期化フローが不明確 | AuthStateの初期化手順（tokenHash/expireAt/enabled）とCM_AUTH_TOKEN_EXPIRE_AT環境変数による伝達フローを追記 | Section 4.1 |
| C005 | 設計書-コード整合性 | i18n.tsのコード例と既存実装のメッセージマージ方法が不一致 | スプレッド演算子によるフラットマージをnamespace付きキー形式に修正（auth: auth.default） | Section 10.2 |
| C006 | 設計書-コード整合性 | ws-server.tsの型拡張でHTTPSServer互換性確認が不足 | Node.js https upgradeイベントもhttp.IncomingMessageを使用する点を明記し、型安全性を保証 | Section 9.2 |
| C007 | 既存パターン整合性 | ALLOWED_AUTH_DURATIONSの値形式がauto-yes-config.tsのALLOWED_DURATIONSと根本的に異なる | 「パターンに準拠」はホワイトリスト方式のアプローチ採用を意味し、値の形式は用途別に異なることを明記 | Section 2.3 |
| C008 | 設計書-コード整合性 | DaemonManager.start()への環境変数追加が設計書に具体的に記載されていない | daemon.tsの環境変数伝達コード例を追加。CM_AUTH_TOKEN_HASHのspawn env経由伝達方式を明示 | Section 12 |
| C009 | 設計書内整合性 | CM_AUTH_ENABLEDとisAuthEnabled()の判定基準が矛盾する可能性 | CM_AUTH_ENABLEDはCLI内部フラグ、サーバー側はCM_AUTH_TOKEN_HASH有無のみで判定する方針を明記 | Section 7 |
| C010 | 設計書-コード整合性 | rateLimiter.destroy()のgracefulShutdown統合箇所が不明確 | auth.tsでモジュールスコープrateLimiterを保持し、destroyRateLimiter()関数をexportする方式を明記 | Section 2.3, Section 6.2 |
| C011 | 設計書-コード整合性 | middleware.tsの配置パスとexport形式が未記載 | middleware.tsの完全スケルトン（import文、export middleware関数、export config）を追記 | Section 5.3 |

### 19.3 Nice to Have（検討事項）

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| C012 | 設計書内整合性 | Cookie Max-Ageの動的計算とCookie設定タイミングの整合性 | expireAtはCLI側で計算しCM_AUTH_TOKEN_EXPIRE_ATとして伝達する方式をSection 4.1/4.2に追記 |
| C013 | 設計書内整合性 | status.tsのHTTPS URL表示の設計詳細が不足 | Section 12にstatus.tsのプロトコル動的切替方針を追記 |
| C014 | テスト整合性 | 設計方針書にテスト計画の記載がない | Section 16としてテスト方針セクションを新設。auth.ts/middleware.ts/WebSocket/E2Eテスト計画を記載 |
| C015 | 既存パターン整合性 | security-messages.tsの既存パターンとの連携方針が不足 | Section 12にsecurity-messages.tsの変更方針（AUTH_HTTP_WARNING/AUTH_ENABLED_MESSAGE）を追記 |
| C016 | 設計書-コード整合性 | Section 6.3のタイポ「トークンP平文」 | 「トークン平文」に修正済み |

---

## 20. レビュー指摘事項サマリー（Stage 3: 影響分析レビュー）

### 20.1 Must Fix（必須対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| I001 | テスト影響 | i18n-namespace-loading.test.tsがauth namespace追加で失敗する | EXPECTED_NAMESPACESに'auth'追加、ファイル数検証を6に更新。変更対象ファイル一覧に追加 | Section 14, Section 16.6 |
| I002 | 既存機能影響 | ws-server.tsの認証追加が既存WebSocketテストに影響する | 既存6テストケースはCM_AUTH_TOKEN_HASH未設定で影響なし。beforeEachにdelete guardを推奨 | Section 16.4 |
| I003 | 既存機能影響 | middleware.tsのmatcherが全HTTPリクエストのパフォーマンスに影響する可能性 | 認証無効時のオーバーヘッドは無視可能（process.env参照のみ）。ポーリングエンドポイントへの影響が軽微であることを明記 | Section 8.2 |

### 20.2 Should Fix（推奨対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| I004 | 既存機能影響 | rateLimiterのsetIntervalが認証無効時でも起動する | isAuthEnabled()を条件としたrateLimiter遅延初期化を採用。認証無効時はnullとする | Section 6.2, Section 11.1 |
| I005 | CLI影響 | start.ts foregroundモードでの認証環境変数設定漏れ | foregroundモードのenv構築にdaemon.ts（C008）と同一パターンの認証環境変数設定を追加 | Section 12 |
| I006 | 既存機能影響 | server.tsのログメッセージがHTTPS時に不正確になる | ログメッセージのプロトコル動的切替（isHttps ? 'https' : 'http'）を追加。C013と同様パターン | Section 9.1 |
| I007 | テスト影響 | StartOptions型変更が既存CLIテストに影響する可能性 | 追加フィールドは全てoptional（?付き）で後方互換性を保証 | Section 14 |
| I008 | ビルド影響 | auth.tsが@/パスエイリアス経由importを使用するリスク | auth.tsはNode.js標準モジュールのみ依存の制約を実装制約として明記 | Section 11.1 |
| I009 | CLI影響 | commandmate initの.envテンプレート更新が未記載 | env-setup.tsに認証・HTTPS環境変数のコメント付きテンプレートを追加する方針を記載 | Section 14 |
| I010 | 既存機能影響 | REVERSE_PROXY_WARNINGとAUTH警告メッセージの共存ルール | --auth有効時はREVERSE_PROXY_WARNINGを抑制し認証固有メッセージのみ表示。優先順位テーブルを追加 | Section 12 (C015) |
| I011 | テスト影響 | middleware.tsテストのモックスコープが他テストに影響する可能性 | テストファイルレベルでの局所モック、afterEachでvi.restoreAllMocks()を推奨。vitest.setup.tsには追加しない | Section 11.3, Section 16.3 |

### 20.3 Nice to Have（検討事項）

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| I012 | 既存機能影響 | useWebSocket.tsの再接続ロジックへの認証チェック統合が具体化不足 | 別フックで認証チェックを行い、useWebSocket.tsは変更しない方針を明確化。Section 14の「変更不要」と整合 |
| I013 | ビルド影響 | npm run build:allへの影響が暗黙的 | Section 11.4にビルド全体への影響分析を追記。middleware.tsのNext.js自動検出を確認 |
| I014 | 競合 | 並行開発中Issueとの変更対象ファイル重複リスク | server.ts gracefulShutdownへの追加順序ガイドをSection 14に追記。既存stopAllPolling()の後に配置 |
| I015 | テスト影響 | E2Eテスト（Playwright）のHTTPS/認証対応計画が不足 | 既存E2Eテストは認証なしモードで実行。HTTPS/認証E2Eテストは新規ファイルで追加 |
| I016 | 既存機能影響 | WebSocket認証Cookie送信の確認不足 | ブラウザWebSocket APIはハンドシェイク時にCookieを自動送信する旨をSection 14変更不要リストに追記 |

---

## 21. レビュー指摘事項サマリー（Stage 4: セキュリティレビュー）

### 21.1 OWASP Top 10 チェックリスト

| ID | タイトル | ステータス | 備考 |
|----|---------|----------|------|
| A01 | Broken Access Control | warn | AUTH_EXCLUDED_PATHSのstartsWith()マッチング修正（S002） |
| A02 | Cryptographic Failures | fail -> fixed | verifyToken()にcrypto.timingSafeEqual()使用を必須化（S001） |
| A03 | Injection | warn | 証明書ファイルパスバリデーション具体化（S003）、Cookieパーサー堅牢化（S006） |
| A04 | Insecure Design | pass | crypto.randomBytes(32)は256ビットエントロピーで十分 |
| A05 | Security Misconfiguration | warn | --allow-httpのリスク警告強化（S007） |
| A06 | Vulnerable Components | pass | 外部依存なし、Node.js標準cryptoモジュールのみ |
| A07 | Identification and Authentication Failures | warn | IPアドレス取得方法明確化（S005）、期限切れトークンのレート制限考慮（S011） |
| A08 | Software and Data Integrity Failures | warn | cert/keyペア整合性検証追加（S008） |
| A09 | Security Logging and Monitoring Failures | warn | 認証イベントログ記録方針追加（S004） |
| A10 | Server-Side Request Forgery (SSRF) | warn | 証明書パスバリデーション具体化で対応（S003） |

### 21.2 Must Fix（必須対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| S001 | 暗号化（A02） | タイミング攻撃対策: verifyToken()でcrypto.timingSafeEqual()未使用 | verifyToken()のハッシュ比較にcrypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'))を使用する設計を追記。===演算子による比較を禁止と明記 | Section 2.3, Section 6.3 |
| S002 | OWASP（A01） | AUTH_EXCLUDED_PATHSのプレフィックスマッチによるバイパスリスク | pathname.startsWith(path)をpathname === pathに変更。プレフィックス一致が必要なパスはconfig.matcherで対応。マッチングルールを明記 | Section 5.3 |
| S003 | 入力検証（A03） | 証明書ファイルパスのパストラバーサル防止設計が不十分 | 5段階バリデーション手順を追記: (1)path.resolve()正規化、(2)fs.lstatSync()シンボリックリンク検出、(3)拡張子ホワイトリスト(.pem,.crt,.key,.cert)、(4)ファイルサイズ上限(1MB)、(5)パーミッション警告 | Section 9.3 |

### 21.3 Should Fix（推奨対応）

| ID | カテゴリ | タイトル | 対応内容 | 反映箇所 |
|----|---------|---------|---------|---------|
| S004 | ログ（A09） | 認証イベントのセキュリティログ記録方針が未設計 | 認証失敗/ロックアウト/認証成功/期限切れの4イベントのログ記録方針を追記。ログレベル・記録内容・注意事項を明記 | Section 6.2 |
| S005 | 認証（A07） | レート制限のIPアドレス取得方法が未設計 | middleware.ts/login API/ws-server.tsの各コンテキストでのIP取得方法を明記。X-Forwarded-For直接参照禁止 | Section 6.2 |
| S006 | 入力検証（A03） | 自前Cookieパーサーのセキュリティ検証が不十分 | parseCookieToken()にCookie最大長チェック(4096B)、トークンフォーマット検証(/^[a-f0-9]{64}$/)、同名Cookie時の最初マッチ使用を追記。テストケースも追加 | Section 3, Section 16.1 |
| S007 | セッション管理（A05） | --allow-httpオプション使用時のセキュリティリスク警告が不十分 | AUTH_HTTP_WARNINGの文言にMITM攻撃リスクの具体的説明を追加。対話型確認は将来検討 | Section 7 |
| S008 | 暗号化（A08） | 証明書・秘密鍵ペアの整合性検証が未設計 | https.createServer()のエラーをキャッチし、cert/keyペア不一致時のユーザーフレンドリーなエラーメッセージを表示する設計を追加 | Section 9.1 |

### 21.4 Nice to Have（検討事項）

| ID | カテゴリ | タイトル | 対応方針 |
|----|---------|---------|---------|
| S009 | 認証（A07） | レート制限Mapベース実装のメモリ枯渇攻撃リスク | MAX_RATE_LIMIT_ENTRIES=10000の上限設定とLRU方式を将来検討。現時点ではローカル開発ツールとしてリスク低 |
| S010 | その他（A05） | 環境変数CM_AUTH_TOKEN_HASHのプロセス一覧表示リスク | リスク記述を具体化: 「256ビットランダムトークンのSHA-256ハッシュのため復元は計算的に不可能」をSection 6.3/13に反映済み |
| S011 | 認証（A07） | トークン有効期限切れ後の再認証フローにおけるレート制限の考慮 | 期限切れトークンによる認証試行はレート制限カウントに加算しない設計を将来検討。verifyToken()の結果を「無効」と「期限切れ」に分類する方式 |
| S012 | その他（A02） | auth-helper.tsとauth.tsの暗号アルゴリズム重複実装による不整合リスク | 両ファイルに「IMPORTANT: This algorithm MUST match auth.ts/auth-helper.ts」コメントを追加。テストでの互換性検証は設計済み |

---

## 22. 実装チェックリスト

### Stage 1 Must Fix 対応

- [ ] **R002**: Section 9.1のserver.ts HTTPS条件分岐にOCPトレードオフコメントを実装コード内にも記載
- [ ] **R006**: `src/lib/auth.ts` に `AUTH_COOKIE_NAME` 定数を定義し、middleware.ts / ws-server.ts / login API / logout API の全箇所から参照
- [ ] **R006**: `src/lib/auth.ts` に `AUTH_EXCLUDED_PATHS` 配列を定義し、middleware.tsから参照（ハードコード禁止）
- [ ] **R012**: `src/lib/auth.ts` に `isAuthEnabled(): boolean` を定義
- [ ] **R012**: middleware.ts の冒頭ガードで `isAuthEnabled()` を使用（`process.env.CM_AUTH_TOKEN_HASH` 直接参照禁止）
- [ ] **R012**: ws-server.ts の upgrade認証で `isAuthEnabled()` を使用
- [ ] **R012**: `/api/auth/status` の `authEnabled` レスポンスで `isAuthEnabled()` を使用

### Stage 1 Should Fix 対応

- [ ] **R001**: `createRateLimiter()` 周辺にセクションコメントを追加し、責務の境界を明示
- [ ] **R005**: `ALLOWED_AUTH_DURATIONS` 配列を定義し、`parseDuration()` でホワイトリスト検証を実装
- [ ] **R007**: `authenticateRequest(cookieHeader: string | undefined): AuthResult` 統合認証関数を実装
- [ ] **R007**: middleware.ts と ws-server.ts の認証フローを `authenticateRequest()` に置き換え
- [ ] **R009**: server.ts の証明書読み込みに try-catch を追加し、失敗時に `process.exit(2)` で終了（C002対応）
- [ ] **R010**: `createRateLimiter()` が `destroy()` メソッドを持つオブジェクトを返す実装
- [ ] **R010**: server.ts の `gracefulShutdown()` に `destroyRateLimiter()` 呼び出しを追加（C010対応）
- [ ] **R014**: middleware.ts の401レスポンスで `/login` へリダイレクト
- [ ] **R014**: フロントエンドの401レスポンスハンドリングを追加
- [ ] **R014**: WebSocket再接続時の認証チェックを `useWebSocket.ts` に統合

### Stage 2 Must Fix 対応

- [ ] **C001**: `src/cli/utils/auth-helper.ts` を新規作成（`generateToken()`, `hashToken()`）
- [ ] **C001**: `start.ts` から `auth-helper.ts` をimport（`src/lib/auth.ts` ではなく）
- [ ] **C001**: auth-helper.ts と auth.ts のハッシュ互換性テストを作成
- [ ] **C002**: server.ts の `process.exit(ExitCode.CONFIG_ERROR)` を `process.exit(2)` に変更
- [ ] **C002**: server.ts でExitCode enumをimportしない
- [ ] **C003**: 認証環境変数を `process.env` で直接参照（`getEnvByKey()` / `ENV_MAPPING` は使用しない）
- [ ] **C003**: `src/lib/env.ts` の `Env` interface を変更しない

### Stage 2 Should Fix 対応

- [ ] **C004**: AuthStateをauth.tsモジュールスコープで初期化（`CM_AUTH_TOKEN_HASH`, `CM_AUTH_TOKEN_EXPIRE_AT` から）
- [ ] **C004**: start.tsでexpireAtを計算し `CM_AUTH_TOKEN_EXPIRE_AT` としてspawn envに含める
- [ ] **C005**: `src/i18n.ts` のauth namespace追加時、namespace付きキー形式（`auth: auth.default`）を使用
- [ ] **C006**: ws-server.ts型拡張時、HTTPSServerのupgradeイベントがhttp.IncomingMessageであることをコメントに記載
- [ ] **C007**: parseDuration()のJSDocに「ホワイトリスト方式のアプローチ準拠」である旨を記載
- [ ] **C008**: daemon.ts の DaemonManager.start() env構築にCM_AUTH_TOKEN_HASH等の認証環境変数を追加
- [ ] **C009**: サーバー側でCM_AUTH_ENABLEDを参照しない（isAuthEnabled()のみ使用）
- [ ] **C010**: auth.tsに `destroyRateLimiter()` 関数をexport
- [ ] **C010**: server.tsのgracefulShutdownから `destroyRateLimiter()` を呼び出し
- [ ] **C011**: `src/middleware.ts` を Section 5.3 の完全スケルトンに従って作成（import元: `next/server`）

### Stage 2 Nice to Have 対応

- [ ] **C012**: CLI側でexpireAtを計算し `CM_AUTH_TOKEN_EXPIRE_AT` 環境変数で伝達
- [ ] **C013**: status.ts の URL生成でCM_HTTPS_CERT/CM_HTTPS_KEY有無によるプロトコル動的切替
- [ ] **C014**: Section 16のテスト方針に従ったテスト実装
- [ ] **C015**: security-messages.tsにAUTH_HTTP_WARNING/AUTH_ENABLED_MESSAGE定数を追加
- [ ] **C016**: (対応済み) Section 6.3のタイポ修正

### Stage 3 Must Fix 対応

- [ ] **I001**: `tests/integration/i18n-namespace-loading.test.ts` の `EXPECTED_NAMESPACES` 配列に `'auth'` を追加
- [ ] **I001**: namespace ファイル数検証のアサーション値を `5` から `6` に更新
- [ ] **I001**: テスト名の数値（`'should have exactly 5 namespace files...'`）を `6` に更新
- [ ] **I002**: `tests/integration/websocket.test.ts` の `beforeEach` で `delete process.env.CM_AUTH_TOKEN_HASH` を実行し、認証無効状態を保証
- [ ] **I003**: middleware.ts の認証無効時パスが `process.env` 参照のみ（O(1)）であることをコード内コメントに記載

### Stage 3 Should Fix 対応

- [ ] **I004**: auth.ts の `rateLimiter` を `isAuthEnabled() ? createRateLimiter() : null` で条件付き初期化
- [ ] **I004**: `destroyRateLimiter()` で `rateLimiter?.destroy()` のnull安全呼び出しを使用
- [ ] **I005**: `start.ts` foreground モードの env 構築に `CM_AUTH_TOKEN_HASH`, `CM_AUTH_TOKEN_EXPIRE_AT`, `CM_HTTPS_CERT`, `CM_HTTPS_KEY` 等を追加
- [ ] **I006**: server.ts の `server.listen()` コールバック内ログメッセージで `const protocol = isHttps ? 'https' : 'http'` を使用
- [ ] **I007**: `src/cli/types/index.ts` の `StartOptions` 追加フィールドが全て `?`（optional）であることを確認
- [ ] **I008**: `src/lib/auth.ts` 内で `@/` パスエイリアスの import を使用しないことを確認
- [ ] **I009**: `src/cli/utils/env-setup.ts` の .env テンプレートに認証・HTTPS環境変数のコメント付き記載を追加
- [ ] **I010**: `start.ts` で `--auth` 有効時に `REVERSE_PROXY_WARNING` を抑制し、`AUTH_ENABLED_MESSAGE` または `AUTH_HTTP_WARNING` のみ表示
- [ ] **I011**: middleware.ts テストファイルで `afterEach(() => { vi.restoreAllMocks(); })` を呼び出し

### Stage 4 Must Fix 対応

- [ ] **S001**: `verifyToken()` のハッシュ比較に `crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(storedHash, 'hex'))` を使用
- [ ] **S001**: `verifyToken()` で `===` 演算子による文字列比較を使用しないこと
- [ ] **S001**: 両バッファの長さが異なる場合は比較前に `false` を返すガードを実装
- [ ] **S002**: middleware.ts の AUTH_EXCLUDED_PATHS チェックを `pathname.startsWith(path)` から `pathname === path` に変更
- [ ] **S002**: プレフィックス一致が必要なパス（`/_next/`等）は `config.matcher` の正規表現で除外されていることを確認
- [ ] **S003**: `start.ts` の証明書バリデーションに `path.resolve()` による絶対パス正規化を実装
- [ ] **S003**: `fs.lstatSync()` によるシンボリックリンク検出を実装
- [ ] **S003**: 拡張子ホワイトリスト確認（`.pem`, `.crt`, `.key`, `.cert` のみ許可）を実装
- [ ] **S003**: ファイルサイズ上限確認（1MB以下）を実装
- [ ] **S003**: 秘密鍵ファイルのパーミッション確認（604未満を推奨、警告のみ）を実装

### Stage 4 Should Fix 対応

- [ ] **S004**: auth.ts に認証失敗時のログ記録を追加（`console.warn`、IPアドレス・試行回数を含む、トークン値は除外）
- [ ] **S004**: ロックアウト発生時のログ記録を追加（`console.warn`、IPアドレス・ロックアウト期間を含む）
- [ ] **S004**: 認証成功時のログ記録を追加（`console.info`、IPアドレスを含む）
- [ ] **S005**: middleware.ts での IP取得に `request.ip` を使用
- [ ] **S005**: login API での IP取得方法を実装
- [ ] **S005**: ws-server.ts での IP取得に `req.socket.remoteAddress` を使用
- [ ] **S006**: `parseCookieToken()` に Cookie ヘッダー最大長チェック（4096バイト）を追加
- [ ] **S006**: `parseCookieToken()` にトークンフォーマット検証（`/^[a-f0-9]{64}$/`）を追加
- [ ] **S006**: `parseCookieToken()` の同名Cookie複数存在時の動作を最初のマッチに統一
- [ ] **S006**: parseCookieToken() のエッジケーステストを Section 16.1 のテスト表に従って作成
- [ ] **S007**: `AUTH_HTTP_WARNING` の文言にMITM攻撃リスクの具体的説明を追加
- [ ] **S008**: server.ts の `createHttpsServer()` にtry-catchを追加し、cert/keyペア不一致時のユーザーフレンドリーなエラーメッセージを表示

### Nice to Have 対応（将来検討）

- [ ] **R003**: 認証戦略インターフェース導入（OAuth等追加時）
- [ ] **R004**: `--https` 冗長指定時の明示的ログ出力
- [ ] **R008**: boolean型環境変数のバリデーションヘルパー関数（必要に応じて）
- [ ] **R011**: i18n namespace動的import方式への移行（namespace数10超過時）
- [ ] **I012**: useWebSocket.ts 再接続時の認証チェック別フック化の詳細設計（必要時）
- [ ] **I013**: npm run build:all 実行時の auth.ts / middleware.ts ビルド通過確認
- [ ] **I015**: HTTPS/認証対応E2Eテストファイルの新規作成
- [ ] **S009**: レート制限Mapのエントリ上限数（MAX_RATE_LIMIT_ENTRIES = 10000）とLRU方式の導入
- [ ] **S010**: 環境変数露出リスクの追加ドキュメント化（現時点でSection 6.3/13に反映済み）
- [ ] **S011**: 期限切れトークンによる認証試行をレート制限カウントから除外する設計
- [ ] **S012**: auth-helper.ts と auth.ts の両方に「IMPORTANT: This algorithm MUST match auth.ts/auth-helper.ts」コメントを追加

---

*Generated by design-policy command for Issue #331*
*Date: 2026-02-21*
*Stage 1 Review Applied: 2026-02-21*
*Stage 2 Review Applied: 2026-02-21*
*Stage 3 Review Applied: 2026-02-21*
*Stage 4 Review Applied: 2026-02-21*
