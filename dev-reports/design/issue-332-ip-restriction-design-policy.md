# Issue #332 アクセス元IP制限オプション 設計方針書

## 1. 概要

CommandMateサーバーへのアクセスを特定のIPアドレスまたはCIDRレンジに限定するオプション機能を追加する。既存のトークン認証（Issue #331）と独立して並列に動作し、多層防御（defense-in-depth）を実現する。

### 設計原則
- **KISS**: Edge Runtime互換のシンプルなCIDRマッチングを自前実装
- **SRP**: IP制限ロジックを独立モジュール（`ip-restriction.ts`）に分離
- **DRY**: HTTP/WebSocketの両レイヤーで共通のIP制限ロジックを使用
- **YAGNI**: IPv4 CIDRを初期実装、IPv6は段階的に追加

## 2. アーキテクチャ設計

### セキュリティレイヤー構成

```
クライアント
  │
  ▼
┌─────────────────────────────────────┐
│ Network層: CM_BIND (127.0.0.1/0.0.0.0) │
└──────────────┬──────────────────────┘
               │
  ┌────────────┴────────────┐
  │                         │
  ▼                         ▼
HTTP Request          WebSocket Upgrade
  │                         │
  ▼                         │
┌───────────────┐           │
│ server.ts     │           │
│ X-Real-IP注入 │           │
└──────┬────────┘           │
       │                    │
       ▼                    ▼
┌───────────────┐   ┌──────────────────┐
│ middleware.ts │   │ ws-server.ts     │
│ ★IP制限       │   │ ★IP制限          │
│ ★認証チェック │   │ ★認証チェック    │
└──────┬────────┘   └──────────────────┘
       │
       ▼
┌───────────────┐
│ API Routes    │
│ Rate Limiter  │
└───────────────┘
```

### モジュール依存関係

```
ip-restriction.ts (新規・Edge Runtime互換)
  ├── parseAllowedIps()       [内部使用]
  ├── getAllowedRanges()       [S1-001: キャッシュ一元管理]
  ├── isIpAllowed()
  ├── normalizeIp()
  ├── isIpRestrictionEnabled()
  └── getClientIp()           [S1-004: リクエスト解析責務]
        │
  ┌─────┴──────┐
  │            │
  ▼            ▼
middleware.ts  ws-server.ts
(Edge Runtime) (Node.js Runtime)
  │            │
  └──── 両方とも getAllowedRanges() を使用 ────┘
```

## 3. 新規モジュール設計

### 3.1 `src/lib/ip-restriction.ts`（Edge Runtime互換）

```typescript
// CONSTRAINT: This module must be Edge Runtime compatible.
// Do NOT import Node.js-specific modules (net, dns, os, fs, etc.).
//
// [S3-006] CLIビルド互換性制約:
// ip-restriction.tsはsrc/cli/からは直接importしない。
// CLIはCM_ALLOWED_IPSをprocess.envに設定するのみであり、
// IP制限ロジックの実行はサーバーサイド（middleware.ts/ws-server.ts）で行う。

// --- 内部定数（未export） [S1-002] ---
// ip-restriction-config.tsを廃止し、以下の定数をモジュール内部に統合。
// これらの定数はip-restriction.ts内でのみ使用され、外部参照の必要がないため。
//
// const IPV4_MAPPED_IPV6_PREFIX = '::ffff:';
// const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// const IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
// const MAX_IPV4_PREFIX_LENGTH = 32;
// const MAX_ALLOWED_IP_ENTRIES = 256;  // [S4-002] DoS防止: CIDRエントリ数上限
// const MAX_CIDR_ENTRY_LENGTH = 18;   // [S4-005] 入力バリデーション: 各エントリの最大文字数（例: '255.255.255.255/32' = 18文字）

// --- モジュールスコープ初期化 [S1-003] ---
// auth.tsのstoredTokenHashパターンに倣い、環境変数をモジュール初期化時に
// 一度だけ読み取る。これによりテスタビリティ向上と、isIpRestrictionEnabled()と
// getAllowedRanges()のキャッシュ整合性を保証する。
//
// [S2-004] auth.tsとの差異:
// auth.tsのstoredTokenHashはバリデーション失敗時にundefinedとなり機能無効化する
// のに対し、ip-restriction.tsはセキュリティ機能としてfail-fast（throw）を採用する。
// IP制限は設定値の不正を黙殺するとセキュリティホールとなるため、起動時に即座に
// エラーとして検出する設計とする。
const allowedIpsEnv = process.env.CM_ALLOWED_IPS?.trim() || '';

// --- [S4-006] CM_TRUST_PROXY値検証 ---
// 'true'以外の非空値が設定された場合、設定ミスを早期発見するために警告を出力する。
// 安全側にフォールバック（プロキシを信頼しない）するが、運用者の意図との乖離を通知する。
const trustProxyEnv = process.env.CM_TRUST_PROXY?.trim() || '';
if (trustProxyEnv !== '' && trustProxyEnv !== 'true' && trustProxyEnv !== 'false') {
  console.warn(
    `[IP-RESTRICTION] CM_TRUST_PROXY has unexpected value: "${trustProxyEnv}". ` +
    'Only "true" (lowercase) enables proxy trust.'
  );
}

// --- パース結果のモジュールレベルキャッシュ [S1-001] ---
// middleware.tsのexpireAtキャッシュパターンと同様に、パース結果を
// モジュールスコープでキャッシュし、HTTP/WebSocket両レイヤーで共有する。
const cachedRanges: CidrRange[] = allowedIpsEnv.length > 0
  ? parseAllowedIps(allowedIpsEnv)
  : [];

/** CIDR範囲を表す内部型 */
export interface CidrRange {
  /** ネットワークアドレス（32bit unsigned integer） */
  network: number;
  /** サブネットマスク（32bit unsigned integer） */
  mask: number;
}

/**
 * CM_ALLOWED_IPS環境変数の文字列をパースしてCidrRange配列に変換する。
 * 不正なCIDR形式が含まれる場合はErrorをスローする（fail-fast）。
 *
 * [S4-002] DoS防止のため、エントリ数が`MAX_ALLOWED_IP_ENTRIES`（256）を超える場合は
 * Errorをスローする（fail-fast）。大量のCIDRエントリはパース処理の遅延と
 * リクエスト毎のOR判定ループによるパフォーマンス劣化を引き起こすため。
 *
 * [S4-005] 各エントリが`MAX_CIDR_ENTRY_LENGTH`（18文字）を超える場合は
 * Errorをスローする（fail-fast）。IPv4 CIDRの最大長は'255.255.255.255/32'の18文字であり、
 * これを超える入力は不正な値として正規表現マッチングの前に弾く。
 *
 * @throws {Error} 不正なIPアドレスまたはCIDR形式
 * @throws {Error} エントリ数がMAX_ALLOWED_IP_ENTRIES（256）を超過
 * @throws {Error} 個別エントリがMAX_CIDR_ENTRY_LENGTH（18文字）を超過
 */
export function parseAllowedIps(envValue: string): CidrRange[];

/**
 * キャッシュ済みの許可CIDR範囲配列を返す。
 * モジュール初期化時にCM_ALLOWED_IPSをパースした結果をキャッシュしており、
 * middleware.ts/ws-server.tsの両方がこの関数を使用する。
 *
 * [S1-001] parseAllowedIps()を毎回呼び出す代わりにこの関数を使用することで、
 * HTTP/WebSocket間のキャッシュ戦略を統一し、DRY原則とパフォーマンスを担保する。
 */
export function getAllowedRanges(): CidrRange[] {
  return cachedRanges;
}

/**
 * 指定されたIPアドレスが許可リストに含まれるか判定する。
 * 複数のCIDR範囲のいずれかにマッチすればtrue（OR判定）。
 */
export function isIpAllowed(ip: string, ranges: CidrRange[]): boolean;

/**
 * IPv4-mapped IPv6アドレス（::ffff:x.x.x.x）をIPv4に正規化する。
 * IPv4アドレスはそのまま返す。純粋なIPv6はそのまま返す。
 */
export function normalizeIp(ip: string): string;

/**
 * IP制限が有効かどうかを判定する。
 * モジュール初期化時にキャプチャしたCM_ALLOWED_IPSの値に基づいて判定する。
 *
 * [S1-003] auth.tsのstoredTokenHash/isAuthEnabled()パターンに倣い、
 * process.envを毎回参照するのではなく、モジュールスコープでキャプチャした
 * allowedIpsEnvを使用する。これによりテスタビリティが向上し、
 * getAllowedRanges()のキャッシュとの整合性が保証される。
 */
export function isIpRestrictionEnabled(): boolean {
  return allowedIpsEnv.length > 0;
}

/**
 * リクエストからクライアントIPを取得する。
 * CM_TRUST_PROXY=trueの場合はX-Forwarded-Forの先頭IPを使用。
 * それ以外の場合はX-Real-IPヘッダーを使用。
 *
 * [S1-004] Request parsing helper - リクエスト解析の責務を担う。
 * CIDRマッチング（IP制限判定）とは異なる責務であることに注意。
 * 将来的にプロキシ関連の設定（trusted proxies list等）が増えた場合は、
 * 別モジュール（例: request-ip.ts）への分離を検討する。
 *
 * [S4-001] WARNING: CM_TRUST_PROXY=true時はleftmost IP（X-Forwarded-Forの先頭IP）
 * を使用するが、これは攻撃者がX-Forwarded-Forヘッダーの先頭に任意のIPを挿入できる
 * リスクがある。リバースプロキシが必ずX-Forwarded-Forヘッダーを上書き（trusted proxy
 * 自身が受け取ったクライアントIPを先頭に設定）する構成にすること。
 * リバースプロキシがX-Forwarded-Forを正しく設定しない場合、IP制限バイパスが可能となる。
 * 将来的にtrusted proxy IPリスト（CM_TRUSTED_PROXIES）を導入し、
 * rightmost非信頼IP方式への拡張を検討する。
 */
export function getClientIp(headers: {
  get(name: string): string | null;
}): string | null;
```

#### 設計判断

| 決定事項 | 選択 | 理由 | トレードオフ |
|---------|------|------|-------------|
| CIDRマッチング | 自前実装 | Edge Runtime互換が確実、外部依存なし | IPv6対応時に実装量が増加 |
| IPv6対応範囲 | Phase 1: IPv4 + IPv4-mapped IPv6のみ | 実用的なユースケースをカバー | 純粋IPv6 CIDRは未対応 |
| モジュール配置 | `src/lib/` | middleware.ts/ws-server.ts両方から参照 | `src/config/`に置く選択肢もあった |
| 関数設計 | Pure function + モジュールキャッシュ | テスタビリティ、DRYキャッシュ統一 | - |
| 不正CIDR | fail-fast（起動エラー） | セキュリティ機能での静かな失敗は危険 | 部分的な設定も拒否される |
| 定数配置 [S1-002] | ip-restriction.ts内の未export内部定数 | 外部参照不要、YAGNI準拠 | auth-config.tsとの非対称性 |
| キャッシュ戦略 [S1-001] | getAllowedRanges()による一元管理 | DRY、パフォーマンス | モジュールリロード時にキャッシュ更新 |
| 環境変数読取 [S1-003] | モジュール初期化時キャプチャ | auth.tsパターン準拠、テスタビリティ | 動的変更不可（再起動必要） |

## 4. 既存モジュール変更設計

### 4.1 `server.ts` - X-Real-IPヘッダー注入

```typescript
// requestHandler内、nextHandler呼び出しの前に追加
// WebSocket upgradeのearly return（L120-123）の前に配置

const clientIp = req.socket.remoteAddress || '';
if (process.env.CM_TRUST_PROXY !== 'true') {
  // CM_TRUST_PROXY=falseの場合、偽のX-Real-IPヘッダーを常に上書き
  // login/route.ts L22-33の設計判断と整合
  req.headers['x-real-ip'] = clientIp;
} else {
  // CM_TRUST_PROXY=trueの場合、X-Forwarded-Forがなければソケットのアドレスを使用
  if (!req.headers['x-forwarded-for']) {
    req.headers['x-real-ip'] = clientIp;
  }
}
```

**挿入位置**: requestHandler関数内、L119後（setHeaderガードのreturn後）とL120（upgradeスキップのif文の前）の間

> **[S3-005] 注記**: server.tsのrequestHandlerはWebSocket upgradeリクエストをL120でスキップする（early return）ため、上記のX-Real-IPヘッダー注入はHTTPリクエストにのみ適用される。WebSocketでのクライアントIP取得はws-server.tsで`request.socket.remoteAddress`を直接使用する（Section 4.3参照）。

### 4.2 `src/middleware.ts` - IP制限チェック挿入

> **[S2-005] Defense-in-depth**: WebSocket upgradeリクエストはmiddleware.tsとws-server.tsの両方でIP制限チェックされる。middleware.tsでは全HTTPリクエスト（WebSocket upgradeリクエストを含む）に対してIP制限を適用し、ws-server.tsではupgradeハンドラー内で独立したIP制限チェックを行う。これにより、いずれかのレイヤーが回避された場合でも保護が維持される多層防御を実現する。

> **[S4-003] 注記**: IP制限はAUTH_EXCLUDED_PATHSの評価よりも前に実行される（Step 1）。つまり、除外パス（/login、/api/auth/login等）へのアクセスもIP制限の対象となる。IP制限のみ使用（CM_AUTH_TOKEN_HASH未設定+CM_ALLOWED_IPS設定）の場合でも、AUTH_EXCLUDED_PATHSの到達にはIP制限を通過する必要がある。これにより、認証が不要なパスであってもネットワークレベルでのアクセス制御が維持される。

```typescript
import { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, getClientIp, normalizeIp } from '../lib/ip-restriction';

// [S1-001] getAllowedRanges()を使用し、ip-restriction.ts内のモジュールレベル
// キャッシュを参照する。middleware.ts側でのparseAllowedIps()呼び出しは不要。

export async function middleware(request: NextRequest) {
  // Step 1: IP restriction check（全リクエスト）
  // [S4-003] AUTH_EXCLUDED_PATHSの評価前に実行。除外パスもIP制限対象。
  if (isIpRestrictionEnabled()) {
    const clientIp = getClientIp(request.headers);
    if (!clientIp || !isIpAllowed(clientIp, getAllowedRanges())) {
      // [S4-004] ログインジェクション防止: normalizeIp()適用済みIPを最大45文字に切り詰めて出力
      const safeIp = clientIp ? normalizeIp(clientIp).substring(0, 45) : 'unknown';
      console.warn(`[IP-RESTRICTION] Denied: ${safeIp}`);
      return new NextResponse(null, { status: 403 });
    }
  }

  // Step 2-6: 既存処理（WebSocket upgrade, Auth check等）
  // ...（変更なし）
}
```

### 4.3 `src/lib/ws-server.ts` - WebSocket IP制限

```typescript
import { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, normalizeIp } from './ip-restriction';

// [S1-001] upgradeハンドラー内、認証チェックの前に挿入。
// getAllowedRanges()を使用し、毎回parseAllowedIps()を呼び出す設計を廃止。
// middleware.tsと同一のキャッシュ戦略に統一。
//
// [S2-008] WebSocket upgradeではrequest.socket.remoteAddressを直接使用するため
// getClientIp()は不要。getClientIp()はHTTPヘッダー（X-Real-IP/X-Forwarded-For）
// からのIP取得用であり、WebSocketではソケット接続から直接IPを取得する。
if (isIpRestrictionEnabled()) {
  const clientIp = normalizeIp(request.socket.remoteAddress || '');
  if (!isIpAllowed(clientIp, getAllowedRanges())) {
    // security-logger.ts使用（Node.js Runtime）
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
}
```

### 4.4 `src/lib/env.ts` - Envインターフェース拡張

> **[S2-002] 注記**: CM_ALLOWED_IPSとCM_TRUST_PROXYをEnvインターフェースに追加するが、getEnv()の戻り値には含めない（既存のCM_AUTH_TOKEN_HASH等と同パターン）。これらの環境変数はip-restriction.tsのモジュールスコープ初期化時にprocess.envから直接読み取るため、getEnv()経由での取得は不要。

```typescript
interface Env {
  // ...既存フィールド
  CM_ALLOWED_IPS?: string;   // 許可IPリスト（カンマ区切り）
  CM_TRUST_PROXY?: string;   // リバースプロキシ信頼設定（'true'/'false'）
}
```

### 4.5 `src/cli/utils/daemon.ts` - 環境変数転送リスト拡張

> **[S2-003] 設計判断**: authEnvKeysの名前は変更せず維持する。IP制限もセキュリティ機能の一部であり、認証（authentication）と認可（authorization/access control）を包括するセキュリティ関連環境変数のグループとして`authEnvKeys`は適切な命名である。名前変更による既存コードへの影響を避けつつ、意味的にも問題がないため現状を維持する。

```typescript
const authEnvKeys = [
  'CM_AUTH_TOKEN_HASH',
  'CM_AUTH_EXPIRE',
  'CM_HTTPS_CERT',
  'CM_HTTPS_KEY',
  'CM_ALLOW_HTTP',
  'CM_ALLOWED_IPS',    // 追加
  'CM_TRUST_PROXY',    // 追加
] as const;
```

### 4.6 CLI変更（start.ts / init.ts / status.ts / index.ts / types）

Issue #331の`--auth`オプション追加パターンに準拠：

```typescript
// src/cli/types/index.ts - StartOptions
interface StartOptions {
  // ...既存
  allowedIps?: string;    // --allowed-ips
  trustProxy?: boolean;   // --trust-proxy
}

// src/cli/index.ts - commander定義
.option('--allowed-ips <cidrs>', 'Allowed IP addresses/CIDR ranges (comma-separated)')
.option('--trust-proxy', 'Trust X-Forwarded-For header from reverse proxy')

// src/cli/commands/start.ts - 環境変数設定（daemonモード: L286付近）
if (options.allowedIps) {
  process.env.CM_ALLOWED_IPS = options.allowedIps;
}
if (options.trustProxy) {
  process.env.CM_TRUST_PROXY = 'true';
}

// [S2-007] start.ts L286-300のforegroundモード環境変数設定ブロックにも
// CM_ALLOWED_IPSとCM_TRUST_PROXYの設定を追加する。
// daemonモードと同様に、foregroundモードでもCLIオプションから
// 環境変数への転送が必要。
```

### 4.7 `src/cli/config/security-messages.ts` - 警告メッセージ更新

REVERSE_PROXY_WARNINGに`--allowed-ips`オプションの案内を追加。
daemon.ts/start.tsの警告表示条件に`CM_ALLOWED_IPS`チェックを追加（設定済みなら警告を抑制）。

## 5. セキュリティ設計

### 5.1 IPスプーフィング防止

| 設定 | IP取得方法 | 防御策 |
|------|-----------|--------|
| `CM_TRUST_PROXY=false`（デフォルト） | server.ts: `req.socket.remoteAddress` → `X-Real-IP` | 偽ヘッダーを常に上書き |
| `CM_TRUST_PROXY=true` | `X-Forwarded-For` 先頭IP | リバースプロキシの設定責任 |
| WebSocket | `request.socket.remoteAddress` 直接使用 | ヘッダーに依存しない |

### 5.2 拒否時レスポンス

- HTTPリクエスト: `403 Forbidden`（レスポンスボディなし）
- WebSocket: `HTTP/1.1 403 Forbidden` → socket.destroy()
- 情報漏洩防止: IPが拒否された理由やCIDR設定値は返さない

### 5.3 セキュリティログ

- middleware.ts（Edge Runtime）: `console.warn('[IP-RESTRICTION] Denied: <ip>')`
- ws-server.ts（Node.js）: `security-logger.ts` を使用
- クライアントIPのみログ出力（CIDR設定値は出力しない）
- **[S4-004] ログインジェクション防止**: IPアドレスをログに出力する前に`normalizeIp()`を適用し、最大45文字に切り詰める（`ip.substring(0, 45)`）。これにより、悪意あるヘッダー偽装による過大な文字列のログ出力やログインジェクション攻撃を防止する

### 5.4 入力バリデーション

- CIDRパース時の不正入力: fail-fast（サーバー起動を中断）
- オクテット範囲チェック（0-255）
- プレフィックス長範囲チェック（0-32）
- 空文字・空白のみの入力に対するガード
- **[S4-002]** CIDRエントリ数上限チェック: `MAX_ALLOWED_IP_ENTRIES`（256）を超える場合はfail-fast
- **[S4-005]** 個別エントリ長上限チェック: `MAX_CIDR_ENTRY_LENGTH`（18文字）を超える場合はfail-fast

### 5.5 IP制限と認証の相互作用

> **[S4-003]** IP制限は認証チェック（AUTH_EXCLUDED_PATHSの評価を含む）よりも前に実行される。つまり、除外パス（/login、/api/auth/login等）へのアクセスもIP制限の対象となる。IP制限のみ使用（CM_AUTH_TOKEN_HASH未設定+CM_ALLOWED_IPS設定）の場合でも、AUTH_EXCLUDED_PATHSの到達にはIP制限を通過する必要がある。

## 6. データフロー設計

### HTTPリクエストのIP制限フロー

```
Client → server.ts(requestHandler)
  │
  ├─ req.socket.remoteAddress取得
  ├─ CM_TRUST_PROXY=false → X-Real-IPヘッダー上書き
  ├─ CM_TRUST_PROXY=true → X-Forwarded-For保持
  │
  ▼
middleware.ts
  │
  ├─ isIpRestrictionEnabled()チェック
  ├─ getClientIp(headers)でIP取得
  ├─ isIpAllowed(ip, getAllowedRanges())で判定  [S1-001]
  │   ├─ normalizeIp()でIPv4-mapped IPv6正規化
  │   └─ CidrRange配列とのOR判定
  ├─ 拒否 → 403 Forbidden (console.warn)
  └─ 許可 → 既存の認証処理へ
```

### WebSocket upgradeのIP制限フロー

```
Client → server.ts(upgradeイベント)
  │
  ├─ requestHandlerをスキップ
  │  （X-Real-IP注入なし）
  │
  ▼
ws-server.ts(upgradeハンドラー)
  │
  ├─ request.socket.remoteAddress直接取得
  ├─ normalizeIp()でIPv4-mapped IPv6正規化
  ├─ isIpAllowed(ip, getAllowedRanges())で判定  [S1-001]
  ├─ 拒否 → HTTP/1.1 403 + socket.destroy()
  └─ 許可 → 既存の認証処理へ
```

## 7. テスト設計

### 7.1 単体テスト（`tests/unit/ip-restriction.test.ts`）

| テストケース | 入力 | 期待結果 |
|-------------|------|---------|
| IPv4単一IPマッチ | ip=`192.168.1.1`, range=`192.168.1.1/32` | true |
| IPv4 CIDRマッチ | ip=`192.168.1.100`, range=`192.168.1.0/24` | true |
| IPv4 CIDR不一致 | ip=`192.168.2.1`, range=`192.168.1.0/24` | false |
| 複数CIDR（OR判定） | ip=`10.0.0.1`, ranges=`192.168.1.0/24,10.0.0.0/8` | true |
| IPv4-mapped IPv6正規化 | ip=`::ffff:192.168.1.1`, range=`192.168.1.0/24` | true |
| /0（全許可） | ip=`any`, range=`0.0.0.0/0` | true |
| /32（単一IP） | ip=`192.168.1.1`, range=`192.168.1.2/32` | false |
| 不正CIDR形式 | `999.999.999.999/24` | Error throw |
| 不正プレフィックス長 | `192.168.1.0/33` | Error throw |
| 空文字列 | `""` | 空配列 |
| normalizeIp: IPv4 | `192.168.1.1` | `192.168.1.1` |
| normalizeIp: mapped | `::ffff:192.168.1.1` | `192.168.1.1` |
| getClientIp: x-real-ip | headers=`{x-real-ip: '1.2.3.4'}` | `1.2.3.4` |
| getClientIp: x-forwarded-for (trust) | headers=`{x-forwarded-for: '1.2.3.4, 5.6.7.8'}` | `1.2.3.4` |
| getAllowedRanges: キャッシュ返却 | CM_ALLOWED_IPS設定済み | CidrRange[] |
| isIpRestrictionEnabled: モジュールスコープ | allowedIpsEnv非空 | true |

### 7.2 結合テスト

- `tests/integration/auth-middleware.test.ts` にIP制限テストケースを追加
  - 許可IPからのリクエスト通過確認
  - 拒否IPからの403レスポンス確認
  - CM_ALLOWED_IPS未設定時のスキップ確認
  - トークン認証との併用（AND条件）確認
  - vi.resetModules()によるモジュールレベルキャッシュ対応

#### [S3-001] テストのsetup/teardownパターン

ip-restriction.tsはモジュールスコープで`allowedIpsEnv`と`cachedRanges`を初期化するため、テスト間の環境変数残存がテスト結果に影響する。以下のパターンを適用する。

```typescript
// beforeEachでの環境変数クリーンアップ
beforeEach(() => {
  delete process.env.CM_ALLOWED_IPS;
  delete process.env.CM_TRUST_PROXY;
  vi.resetModules(); // モジュールキャッシュを再初期化
});
```

- **`delete process.env.CM_ALLOWED_IPS`/`delete process.env.CM_TRUST_PROXY`**: 前のテストで設定された環境変数の残存を防ぐ
- **`vi.resetModules()`**: ip-restriction.tsのモジュールキャッシュ（`allowedIpsEnv`、`cachedRanges`）を再初期化する。これにより各テストケースが独立した環境変数状態でモジュールを再ロードできる
- **不正値テストのエラーハンドリング**: fail-fast設計のため、不正なCIDR値でのモジュールロード自体がエラーをスローする。動的importを使用してテストする

```typescript
// 不正値テストパターン
it('should throw on invalid CIDR', async () => {
  process.env.CM_ALLOWED_IPS = '999.999.999.999/24';
  await expect(() => import('../../../src/lib/ip-restriction')).rejects.toThrow();
});
```

#### [S3-003] daemon.tsの環境変数転送テスト

- `tests/unit/cli/utils/daemon.test.ts`のauthEnvKeys転送テストに、`CM_ALLOWED_IPS`および`CM_TRUST_PROXY`のテストケースを追加する
  - daemon起動時にこれらの環境変数がchildプロセスに正しく転送されることを検証

## 8. 環境変数設計

### CM_ALLOWED_IPS

| 項目 | 値 |
|------|-----|
| 名前 | `CM_ALLOWED_IPS` |
| 型 | `string` (カンマ区切り) |
| デフォルト | 未設定（IP制限なし） |
| 例 | `192.168.1.0/24,10.0.0.0/8,172.16.0.1` |
| バリデーション | 各エントリがIPv4またはIPv4 CIDRであること |

### CM_TRUST_PROXY

| 項目 | 値 |
|------|-----|
| 名前 | `CM_TRUST_PROXY` |
| 型 | `string` ('true'/'false') |
| デフォルト | 未設定（`false`扱い） |
| 効果 | `true`時にX-Forwarded-Forヘッダーを信頼 |
| 有効値 | 厳密に文字列`'true'`のみ（大文字小文字区別あり） |

> **[S4-001] 注意**: リバースプロキシがX-Forwarded-Forを正しく設定しない場合、IP制限バイパスが可能となる。CM_TRUST_PROXY=true時は、リバースプロキシが必ずX-Forwarded-Forヘッダーを上書き（trusted proxy自身が受け取ったクライアントIPを先頭に設定）する構成にすること。

> **[S4-006] 値の検証**: CM_TRUST_PROXYに`'true'`以外の非空値（`'TRUE'`、`'True'`、`'1'`、`'yes'`等）が設定された場合、起動時に`console.warn`で警告を出力する。有効値は厳密に小文字の`'true'`のみであり、それ以外の値ではプロキシを信頼しない（安全側にフォールバック）。これにより、設定ミスの早期発見を支援する。
>
> ```typescript
> // ip-restriction.ts モジュールスコープ初期化時
> const trustProxyEnv = process.env.CM_TRUST_PROXY?.trim() || '';
> if (trustProxyEnv !== '' && trustProxyEnv !== 'true' && trustProxyEnv !== 'false') {
>   console.warn(
>     `[IP-RESTRICTION] CM_TRUST_PROXY has unexpected value: "${trustProxyEnv}". ` +
>     'Only "true" (lowercase) enables proxy trust.'
>   );
> }
> ```

## 9. 設計上の決定事項とトレードオフ

### 採用した設計

| 決定事項 | 選択 | 理由 | トレードオフ |
|---------|------|------|-------------|
| IP取得方式 | server.tsでX-Real-IP注入 | Edge RuntimeのmiddlewareでソケットIP取得不可 | server.tsの変更が必要 |
| WebSocket IP取得 | request.socket.remoteAddress直接使用 | server.tsのrequestHandlerをスキップするため | HTTPとは異なる取得経路 |
| CIDRマッチング | 自前実装（IPv4のみ） | Edge Runtime互換確実、外部依存なし | IPv6は別Phase |
| 不正CIDR処理 | fail-fast | セキュリティ機能の暗黙的失敗は危険 | 起動がブロックされる |
| 認証との関係 | AND条件（独立並列） | 多層防御の原則に合致 | 設定の複雑さ増加 |
| middleware挿入位置 | 全処理の最前段 | IP制限のみ使用するケースをサポート | 全リクエストにオーバーヘッド追加 |
| モジュール配置 | `src/lib/ip-restriction.ts` | middleware/ws-server両方から参照 | auth-config.tsに含める選択肢もあった |
| ログ出力先 | ランタイム別（console.warn/security-logger） | Edge Runtimeの制約 | ログ出力先が分散 |
| キャッシュ一元管理 [S1-001] | getAllowedRanges()でip-restriction.ts内キャッシュ | DRY、パフォーマンス統一 | 呼び出し側での直接パース不可 |
| 定数統合 [S1-002] | ip-restriction.ts内の未export定数 | YAGNI、単一利用元 | config分離の非対称性 |
| 環境変数キャプチャ [S1-003] | モジュール初期化時に一度だけ読取 | auth.tsパターン準拠 | 動的変更には再起動が必要 |

### 代替案との比較

| 代替案 | メリット | デメリット | 不採用理由 |
|--------|---------|-----------|-----------|
| 外部CIDRライブラリ | 実装量削減、IPv6対応 | Edge Runtime互換不確実、依存追加 | 互換性リスク |
| middleware以外で実装 | Node.js API利用可能 | 全ルートへの適用が困難 | カバレッジ不足 |
| blocklist方式 | 特定IPのみブロック | 設定ミスのリスク大 | allowlistの方が安全 |
| API Route個別実装 | 柔軟な適用 | DRY違反、漏れのリスク | 一元管理が望ましい |
| ip-restriction-config.ts分離 [S1-002] | auth-config.tsとの対称性 | 4定数のみで過度な分離、YAGNI違反 | 単一利用元のため統合 |
| parseAllowedIps()毎回呼び出し [S1-001] | 動的設定変更対応 | DRY違反、パフォーマンス非効率 | キャッシュ一元化を採用 |

## 10. 後方互換性

- `CM_ALLOWED_IPS` 未設定時は従来通りの動作（IP制限なし）
- `CM_AUTH_TOKEN_HASH` 未設定 + `CM_ALLOWED_IPS` 未設定 = 既存動作と同一
- 既存APIのレスポンス形式・ステータスコードに変更なし
- `.env` ファイルに新環境変数がなくても起動可能

## 11. 影響範囲サマリー

| 区分 | ファイル数 |
|------|----------|
| 新規作成 | 2ファイル（ip-restriction.ts, テスト）[S1-002: ip-restriction-config.ts廃止] |
| 既存変更 | 13ファイル |
| ビルド設定 | 1ファイル [S3-002] |
| ドキュメント | 3ファイル |
| **合計** | **19ファイル** |

> **[S3-002] 注記**: `tsconfig.server.json`について、ws-server.tsがip-restriction.tsをimportするため、includeリストに自動で含まれる可能性があるが、明示的な追加が必要か実装時に確認すること。併せて、プロジェクトルートの`tsconfig.json`の設定（paths、include）にも影響がないことを確認する。

### [S3-004] ファイル別変更内容詳細

| ファイル | 区分 | 変更内容 |
|---------|------|---------|
| `src/lib/ip-restriction.ts` | 新規 | IP制限コアモジュール（CIDRパース、マッチング、キャッシュ、getClientIp） |
| `tests/unit/ip-restriction.test.ts` | 新規 | ip-restriction.tsの単体テスト |
| `server.ts` | 変更 | requestHandler内にX-Real-IPヘッダー注入ロジック追加 |
| `src/middleware.ts` | 変更 | IP制限チェック挿入（isIpRestrictionEnabled/getClientIp/isIpAllowed） |
| `src/lib/ws-server.ts` | 変更 | WebSocket upgradeハンドラーにIP制限チェック追加 |
| `src/lib/env.ts` | 変更 | EnvインターフェースにCM_ALLOWED_IPS/CM_TRUST_PROXY追加 |
| `src/cli/utils/daemon.ts` | 変更 | authEnvKeysにCM_ALLOWED_IPS/CM_TRUST_PROXY追加 |
| `src/cli/types/index.ts` | 変更 | StartOptionsにallowedIps/trustProxyプロパティ追加 |
| `src/cli/index.ts` | 変更 | --allowed-ips/--trust-proxyオプション定義追加 |
| `src/cli/commands/start.ts` | 変更 | foreground/daemonモードでCM_ALLOWED_IPS/CM_TRUST_PROXY環境変数設定 |
| `src/cli/commands/init.ts` | 変更 | IP制限設定の案内追加 |
| `src/cli/commands/status.ts` | 変更 | IP制限状態の表示追加 |
| `src/cli/config/security-messages.ts` | 変更 | REVERSE_PROXY_WARNINGに--allowed-ips案内追加 |
| `tests/integration/auth-middleware.test.ts` | 変更 | IP制限テストケース追加（setup/teardownパターン含む） |
| `tests/unit/cli/utils/daemon.test.ts` | 変更 | authEnvKeys転送テストにCM_ALLOWED_IPS/CM_TRUST_PROXYケース追加 [S3-003] |
| `tsconfig.server.json` | 確認/変更 | ws-server.tsのip-restriction.tsインポートに伴うinclude確認 [S3-002] |
| `.env.example` | ドキュメント | CM_ALLOWED_IPS/CM_TRUST_PROXYの設定例追加 |
| `README.md` | ドキュメント | IP制限機能の説明追加 |
| `docs/architecture.md` | ドキュメント | セキュリティレイヤー構成図更新 |

## 12. レビュー履歴

| 日付 | ステージ | レビュー内容 | 結果 |
|------|---------|-------------|------|
| 2026-02-22 | Stage 1（設計原則） | SOLID/KISS/YAGNI/DRYの各原則への準拠度評価 | conditionally_approved |
| 2026-02-22 | Stage 2（整合性レビュー） | 既存コードベースとの整合性、行番号・importパス・インターフェースパターンの検証 | conditionally_approved |
| 2026-02-22 | Stage 3（影響分析レビュー） | テストsetup/teardownパターン、tsconfig影響、daemon転送テスト、影響ファイル詳細化、WebSocket注意事項、CLIビルド互換性制約 | conditionally_approved |
| 2026-02-22 | Stage 4（セキュリティレビュー） | X-Forwarded-For先頭IP信頼チェーン、CIDRエントリ数/長さ上限、AUTH_EXCLUDED_PATHSとIP制限順序、ログインジェクション防止、CM_TRUST_PROXY値検証 | conditionally_approved |

## 13. レビュー指摘事項サマリー

### Stage 1: 設計原則レビュー

| ID | 重要度 | 原則 | タイトル | 対応状況 |
|----|--------|------|---------|---------|
| S1-001 | Must Fix | DRY | ws-server.tsでのparseAllowedIps()毎回呼び出しによるキャッシュ戦略の不整合 | 反映済み |
| S1-002 | Should Fix | YAGNI | ip-restriction-config.tsの過度なモジュール分離 | 反映済み |
| S1-003 | Should Fix | SOLID | isIpRestrictionEnabled()の環境変数直接参照によるDIP違反とテスタビリティ低下 | 反映済み |
| S1-004 | Should Fix | SOLID | ip-restriction.tsのSRP観点での責務境界の明確化（getClientIp JSDoc） | 反映済み |
| S1-005 | Nice to Have | SOLID | OCP観点: IPv6対応時の拡張性設計の不足 | 将来検討（YAGNI優先） |
| S1-006 | Nice to Have | DRY | server.tsとws-server.tsでのIP取得ロジック分散 | 将来検討 |
| S1-007 | Nice to Have | KISS | middleware.tsのIP制限挿入位置と既存認証フローの複雑性 | 将来検討 |
| S1-008 | Nice to Have | DRY | daemon.tsのauthEnvKeys配列にIP制限用変数を追加する際のハードコード重複 | 将来検討 |

### Stage 2: 整合性レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S2-001 | Must Fix | 行番号 | server.tsのWebSocket upgradeスキップ行番号修正（L121-123 -> L120-123）、挿入位置の正確な記述 | 反映済み |
| S2-002 | Must Fix | インターフェース | Envインターフェース追加時のgetEnv()戻り値非包含の明確化（既存CM_AUTH_TOKEN_HASHパターン準拠） | 反映済み |
| S2-003 | Must Fix | 命名 | daemon.tsのauthEnvKeys名の維持方針明記（IP制限もセキュリティ機能の一部） | 反映済み |
| S2-004 | Should Fix | パターン差異 | auth.tsのundefined無効化 vs ip-restriction.tsのfail-fast(throw)の設計差異を明記 | 反映済み |
| S2-005 | Should Fix | 多層防御 | WebSocket upgradeリクエストに対するmiddleware.ts/ws-server.ts二重チェックの意図（defense-in-depth）を明記 | 反映済み |
| S2-006 | Should Fix | importパス | middleware.ts/ws-server.tsのimportパスを相対パスに修正（@/lib/ -> ../lib/ / ./） | 反映済み |
| S2-007 | Should Fix | CLI | start.tsのforegroundモード環境変数設定ブロックへのCM_ALLOWED_IPS/CM_TRUST_PROXY追加を明記 | 反映済み |
| S2-008 | Should Fix | API設計 | ws-server.tsでgetClientIp()を使用しない理由の明記（socket.remoteAddress直接使用） | 反映済み |

### Stage 3: 影響分析レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|---------|---------|---------|
| S3-001 | Must Fix | テスト | テストのsetup/teardownパターン明記（beforeEach env削除、vi.resetModules()、不正値テストパターン） | 反映済み |
| S3-002 | Must Fix | ビルド設定 | tsconfig.server.jsonの影響ファイル追加、ファイル数18->19更新 | 反映済み |
| S3-003 | Should Fix | テスト | daemon.test.tsのauthEnvKeys転送テストにCM_ALLOWED_IPS/CM_TRUST_PROXYケース追加 | 反映済み |
| S3-004 | Should Fix | ドキュメント | 影響ファイル一覧のファイル別変更内容詳細テーブル追加 | 反映済み |
| S3-005 | Should Fix | アーキテクチャ | server.tsのWebSocket upgradeスキップによるX-Real-IP注入のHTTPリクエスト限定の注記 | 反映済み |
| S3-006 | Should Fix | 制約 | CLIビルド互換性制約の明記（ip-restriction.tsはsrc/cli/から直接importしない） | 反映済み |

### Stage 4: セキュリティレビュー

| ID | 重要度 | OWASPカテゴリ | タイトル | 対応状況 |
|----|--------|--------------|---------|---------|
| S4-001 | Must Fix | A01:Broken Access Control | X-Forwarded-Forヘッダーの先頭IP抽出に対する信頼チェーン不備の文書化 | 反映済み |
| S4-002 | Must Fix | A05:Security Misconfiguration | CM_ALLOWED_IPSのCIDRエントリ数上限（MAX_ALLOWED_IP_ENTRIES=256）の定義 | 反映済み |
| S4-003 | Should Fix | A01:Broken Access Control | AUTH_EXCLUDED_PATHSとIP制限の実行順序の明記 | 反映済み |
| S4-004 | Should Fix | A09:Security Logging Failures | IP制限拒否ログのnormalizeIp()適用と最大45文字切り詰めによるログインジェクション防止 | 反映済み |
| S4-005 | Should Fix | A03:Injection | CIDRエントリ長上限（MAX_CIDR_ENTRY_LENGTH=18）の定義 | 反映済み |
| S4-006 | Should Fix | A07:Auth Failures | CM_TRUST_PROXY環境変数の値検証とfail-fast警告 | 反映済み |
| S4-007 | Should Fix | A01:Broken Access Control | WebSocket upgradeのdefense-in-depth二重チェックにおけるIP不整合の注記 | 将来検討 |
| S4-008 | Nice to Have | A03:Injection | CLI --allowed-ipsオプションのシェルインジェクション耐性確認 | 将来検討 |
| S4-009 | Nice to Have | A05:Security Misconfiguration | Edge Runtimeモジュールスコープ変数の単一テナント前提の明確化 | 将来検討 |
| S4-010 | Nice to Have | A09:Security Logging Failures | 403レスポンスHTTPボディの一貫性確認 | 将来検討（現行設計維持） |
| S4-011 | Nice to Have | A01:Broken Access Control | 0.0.0.0/0 CIDR設定時の警告メッセージ | 将来検討 |

## 14. 実装チェックリスト

### Must Fix

- [ ] **[S1-001]** `ip-restriction.ts`に`getAllowedRanges()`関数を追加し、モジュールレベルの`cachedRanges`を返す
- [ ] **[S1-001]** `middleware.ts`のimportから`parseAllowedIps`を削除し、`getAllowedRanges`を使用
- [ ] **[S1-001]** `middleware.ts`のモジュールレベル`allowedRanges`定数を削除し、`getAllowedRanges()`呼び出しに置換
- [ ] **[S1-001]** `ws-server.ts`のimportから`parseAllowedIps`を削除し、`getAllowedRanges`を使用
- [ ] **[S1-001]** `ws-server.ts`のupgradeハンドラー内の`parseAllowedIps()`呼び出しを`getAllowedRanges()`に置換

### Should Fix

- [ ] **[S1-002]** `ip-restriction-config.ts`を作成しない（旧設計から廃止）
- [ ] **[S1-002]** `IPV4_MAPPED_IPV6_PREFIX`, `IPV4_PATTERN`, `IPV4_CIDR_PATTERN`, `MAX_IPV4_PREFIX_LENGTH`を`ip-restriction.ts`内の未export定数として定義
- [ ] **[S1-003]** `ip-restriction.ts`のモジュールスコープに`const allowedIpsEnv = process.env.CM_ALLOWED_IPS?.trim() || ''`を定義
- [ ] **[S1-003]** `isIpRestrictionEnabled()`が`allowedIpsEnv.length > 0`を返す実装に変更
- [ ] **[S1-003]** `cachedRanges`の初期化に`allowedIpsEnv`を使用（`process.env`の二重参照を排除）
- [ ] **[S1-004]** `getClientIp()`にJSDocコメントを追加（リクエスト解析責務の明記、将来の分離ポイントの注記）

### Stage 2 Must Fix

- [ ] **[S2-001]** `server.ts`のX-Real-IPヘッダー注入コードをL119後（setHeaderガードのreturn後）とL120（upgradeスキップのif文の前）の間に挿入
- [ ] **[S2-002]** `env.ts`のEnvインターフェースにCM_ALLOWED_IPS/CM_TRUST_PROXYを追加（getEnv()の戻り値には含めない）
- [ ] **[S2-003]** `daemon.ts`のauthEnvKeys配列にCM_ALLOWED_IPS/CM_TRUST_PROXYを追加（配列名は変更しない）

### Stage 2 Should Fix

- [ ] **[S2-004]** `ip-restriction.ts`のモジュールスコープ初期化コメントにauth.tsとのfail-fast差異を記載
- [ ] **[S2-005]** `middleware.ts`のIP制限チェックにdefense-in-depthコメントを記載
- [ ] **[S2-006]** `middleware.ts`のimportパスを`'../lib/ip-restriction'`に設定
- [ ] **[S2-006]** `ws-server.ts`のimportパスを`'./ip-restriction'`に設定
- [ ] **[S2-007]** `start.ts`のforegroundモード環境変数設定ブロックにCM_ALLOWED_IPS/CM_TRUST_PROXYの設定を追加
- [ ] **[S2-008]** `ws-server.ts`のupgradeハンドラーにgetClientIp()不使用の理由コメントを記載

### Stage 3 Must Fix

- [ ] **[S3-001]** `tests/unit/ip-restriction.test.ts`と`tests/integration/auth-middleware.test.ts`のbeforeEachに`delete process.env.CM_ALLOWED_IPS`と`delete process.env.CM_TRUST_PROXY`を追加
- [ ] **[S3-001]** 結合テストで`vi.resetModules()`パターンを使用してip-restriction.tsのモジュールキャッシュ（`allowedIpsEnv`、`cachedRanges`）を再初期化
- [ ] **[S3-001]** 不正値テストで`expect(() => dynamicImport()).rejects.toThrow()`パターンを使用
- [ ] **[S3-002]** `tsconfig.server.json`のincludeリストにip-restriction.tsの明示的追加が必要か確認し、必要に応じて追加
- [ ] **[S3-002]** プロジェクトルートの`tsconfig.json`の設定（paths、include）に影響がないことを確認

### Stage 3 Should Fix

- [ ] **[S3-003]** `tests/unit/cli/utils/daemon.test.ts`のauthEnvKeys転送テストにCM_ALLOWED_IPS/CM_TRUST_PROXYのテストケースを追加
- [ ] **[S3-004]** 実装時にSection 11のファイル別変更内容詳細テーブルを最新の実装状況で更新
- [ ] **[S3-005]** `server.ts`のX-Real-IPヘッダー注入コードの付近にWebSocket upgradeスキップに関するコメントを追加
- [ ] **[S3-006]** `ip-restriction.ts`の冒頭コメントにCLIビルド互換性制約を記載（src/cli/からの直接import禁止）

### Stage 4 Must Fix

- [ ] **[S4-001]** `getClientIp()`のJSDocに「CM_TRUST_PROXY=true時はleftmost IP（先頭IP）を使用するが、攻撃者が先頭に任意のIPを挿入できるリスクがある。リバースプロキシが必ずX-Forwarded-Forヘッダーを上書きする構成にすること」という警告を記載
- [ ] **[S4-001]** Section 8のCM_TRUST_PROXY説明に「リバースプロキシがX-Forwarded-Forを正しく設定しない場合、IP制限バイパスが可能」という警告を記載
- [ ] **[S4-002]** `ip-restriction.ts`の内部定数に`MAX_ALLOWED_IP_ENTRIES = 256`を追加
- [ ] **[S4-002]** `parseAllowedIps()`内でエントリ数が256を超える場合にErrorをスロー（fail-fast）

### Stage 4 Should Fix

- [ ] **[S4-003]** `middleware.ts`のIP制限チェックコメントに「AUTH_EXCLUDED_PATHSの評価前に実行。除外パスもIP制限対象」の注記を追加
- [ ] **[S4-003]** Section 5に「IP制限と認証の相互作用」セクションとして明文化
- [ ] **[S4-004]** `middleware.ts`のIP制限拒否ログで`normalizeIp()`を適用し、`substring(0, 45)`で切り詰めてログインジェクションを防止
- [ ] **[S4-004]** `ws-server.ts`のIP制限拒否ログでも同様にnormalizeIp()と長さ制限を適用
- [ ] **[S4-004]** Section 5.3のセキュリティログ説明にログインジェクション防止策を記載
- [ ] **[S4-005]** `ip-restriction.ts`の内部定数に`MAX_CIDR_ENTRY_LENGTH = 18`を追加
- [ ] **[S4-005]** `parseAllowedIps()`内で各エントリが18文字を超える場合にErrorをスロー（正規表現マッチングの前に実行）
- [ ] **[S4-006]** `ip-restriction.ts`のモジュールスコープ初期化時にCM_TRUST_PROXYの値を検証し、`'true'`以外の非空値に対してconsole.warnで警告を出力

---

*Generated by design-policy command for Issue #332*
*Updated: 2026-02-22 - Stage 4 security review findings applied (S4-001 through S4-006)*
