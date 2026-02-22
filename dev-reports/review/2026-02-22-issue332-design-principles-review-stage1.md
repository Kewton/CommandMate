# Issue #332 設計原則レビュー (Stage 1)

**Issue**: #332 アクセス元IP制限オプション
**Focus**: 設計原則 (SOLID / KISS / YAGNI / DRY)
**Date**: 2026-02-22
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

Issue #332の設計方針書は、既存のトークン認証機能（Issue #331）のアーキテクチャパターンに忠実に設計されており、設計原則への準拠度は全体的に高い。KISS原則に基づくEdge Runtime互換の自前CIDRマッチング、YAGNI原則に基づくIPv4限定の初期スコープ、SRP原則に基づく`ip-restriction.ts`の独立モジュール化はいずれも妥当な判断である。

主な改善点は以下の3点。

1. **[must_fix]** `ws-server.ts`で`parseAllowedIps()`を毎回呼び出す設計がDRY原則に反し、`middleware.ts`のモジュールレベルキャッシュ戦略と不整合
2. **[should_fix]** `ip-restriction-config.ts`の分離がYAGNI原則の観点で過剰
3. **[should_fix]** `isIpRestrictionEnabled()`の環境変数直接参照がDIP原則に反し、テスタビリティを低下させる

---

## SOLID原則評価

### SRP (Single Responsibility Principle) -- 良好

`ip-restriction.ts`をCIDRマッチング専用モジュールとして分離する設計は、SRPに準拠している。`middleware.ts`と`ws-server.ts`の両方から参照される位置（`src/lib/`）も適切。

ただし、`getClientIp()`関数はHTTPヘッダー解析の責務であり、CIDRマッチングの責務とは質的に異なる。現時点のモジュール規模では問題にならないが、将来のプロキシ設定拡張を見据えてJSDocで分離ポイントを記録しておくことを推奨する。

**参照箇所**: 設計方針書 Section 3.1

```typescript
// ip-restriction.ts (設計方針書より)
export function parseAllowedIps(envValue: string): CidrRange[];
export function isIpAllowed(ip: string, ranges: CidrRange[]): boolean;
export function normalizeIp(ip: string): string;
export function isIpRestrictionEnabled(): boolean;
export function getClientIp(headers: { get(name: string): string | null; }): string | null;
```

**既存パターンとの比較**: `src/lib/auth.ts`は認証のコアロジック（トークン生成・検証・Cookie解析・Rate Limiter）を一つのモジュールに集約しており、同様のパターンとして整合的。

### OCP (Open/Closed Principle) -- 注意事項あり

IPv6対応を「別Phase」として明示的に除外している点はYAGNI準拠で正しい。しかし、`CidrRange`インターフェースのフィールド（`network: number`, `mask: number`）が32bit整数に固定されているため、IPv6対応時にはインターフェース自体の変更が必要になる。

```typescript
// 現設計: IPv4固定
export interface CidrRange {
  network: number;  // 32bit unsigned integer
  mask: number;     // 32bit unsigned integer
}
```

IPv6追加時の拡張パスとして、`CidrRangeV4 | CidrRangeV6`のunion型による拡張が考えられるが、現時点での構造変更はYAGNI違反となるためJSDocでの設計意図記録に留める。

### LSP (Liskov Substitution Principle) -- 該当なし

本設計にはクラス継承やインターフェース実装の階層が存在しないため、LSPの評価対象外。

### ISP (Interface Segregation Principle) -- 良好

`getClientIp()`の引数型が`{ get(name: string): string | null; }`という最小インターフェースで定義されている点は、ISPに優れて準拠している。`NextRequest`や`IncomingMessage`の全体型に依存せず、Edge Runtime/Node.js両方で使用可能な設計。

```typescript
// ISP準拠: 必要最小限のインターフェース
export function getClientIp(headers: {
  get(name: string): string | null;
}): string | null;
```

### DIP (Dependency Inversion Principle) -- 改善推奨

`isIpRestrictionEnabled()`が`process.env.CM_ALLOWED_IPS`を直接参照する設計は、DIPの観点で改善の余地がある。

**既存パターン比較**: `src/lib/auth.ts` (L36-46)

```typescript
// auth.ts: モジュール初期化時にキャプチャ (DIP準拠)
const storedTokenHash: string | undefined = (() => {
  const hash = process.env.CM_AUTH_TOKEN_HASH || undefined;
  // ...validation...
  return hash;
})();

export function isAuthEnabled(): boolean {
  return !!storedTokenHash;
}
```

**設計方針書の現設計**:

```typescript
// ip-restriction.ts: 毎回process.envを参照 (DIP非準拠)
export function isIpRestrictionEnabled(): boolean {
  // CM_ALLOWED_IPSが設定されており、空でない場合にtrue
  // -> process.env直接参照
}
```

`auth.ts`のパターンに統一することで、テスタビリティと既存パターンとの整合性が向上する。

---

## KISS原則評価 -- 良好

### 適切な判断

1. **自前CIDRマッチング**: 外部ライブラリ依存なし、Edge Runtime互換が確実。IPv4のCIDRマッチングは32bitビット演算で実装可能であり、複雑さは限定的。
2. **fail-fast方式**: 不正CIDRで起動エラーとする設計は、セキュリティ機能としてシンプルかつ安全。
3. **allowlist方式**: blocklist方式より設定ミスのリスクが低く、シンプルなセキュリティモデル。

### 注意点

`middleware.ts`のフロー段階数は現在5段階であり、IP制限追加で6段階になる。一つの関数内のフロー段階としては許容範囲だが、各ステップのコメント付番を維持することで認知的複雑度を管理する必要がある。

---

## YAGNI原則評価 -- 概ね良好（1件改善推奨）

### 適切な判断

- IPv4 + IPv4-mapped IPv6のみの初期実装スコープ
- IPv6 CIDRサポートの明示的除外
- 純粋関数ベースの設計（Strategyパターン等の過度な抽象化を回避）

### 改善推奨: ip-restriction-config.tsの過度な分離

`ip-restriction-config.ts`は4つの定数のみを格納するモジュールとして設計されている。

```typescript
// ip-restriction-config.ts (設計方針書 Section 3.2)
export const IPV4_MAPPED_IPV6_PREFIX = '::ffff:';
export const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
export const MAX_IPV4_PREFIX_LENGTH = 32;
```

**`auth-config.ts`との比較**: `auth-config.ts`は`AUTH_COOKIE_NAME`, `AUTH_EXCLUDED_PATHS`, `isValidTokenHash()`, `parseDuration()`, `computeExpireAt()`など、複数の関数と定数を含み、`middleware.ts`と`auth.ts`の両方から参照される。分離の理由（Edge Runtime互換性の境界制御）が明確。

一方、`ip-restriction-config.ts`の定数は`ip-restriction.ts`のみから参照される内部定数であり、外部モジュールからの直接参照は不要。現時点での分離はYAGNI原則に反する。

---

## DRY原則評価 -- 改善必要

### [must_fix] S1-001: parseAllowedIps()のキャッシュ戦略不整合

設計方針書の最も重大なDRY違反は、`middleware.ts`と`ws-server.ts`で異なるキャッシュ戦略が使用されている点にある。

**middleware.ts (Section 4.2)** -- モジュールレベルキャッシュ:

```typescript
// モジュールレベルキャッシュ（expireAtと同パターン）
const allowedRanges = isIpRestrictionEnabled()
  ? parseAllowedIps(process.env.CM_ALLOWED_IPS || '')
  : [];
```

**ws-server.ts (Section 4.3)** -- 毎回パース:

```typescript
if (isIpRestrictionEnabled()) {
  const clientIp = normalizeIp(request.socket.remoteAddress || '');
  const ranges = parseAllowedIps(process.env.CM_ALLOWED_IPS || '');  // 毎回パース
  if (!isIpAllowed(clientIp, ranges)) { ... }
}
```

この不整合は以下の問題を引き起こす。

- **パフォーマンス**: WebSocket接続ごとにCIDR文字列パースが発生
- **保守性**: キャッシュ方針の変更時に両方のモジュールを修正する必要
- **一貫性**: 同一設定値に対して異なる取得パターン

**推奨改善案**: `ip-restriction.ts`内に`getAllowedRanges()`関数を追加し、モジュールレベルでパース結果をキャッシュする。

```typescript
// ip-restriction.ts に追加
const cachedRanges: CidrRange[] = isIpRestrictionEnabled()
  ? parseAllowedIps(process.env.CM_ALLOWED_IPS || '')
  : [];

export function getAllowedRanges(): CidrRange[] {
  return cachedRanges;
}
```

### [nice_to_have] S1-006: IP取得ロジックの分散

HTTPリクエストでは`getClientIp(headers)`、WebSocketでは`normalizeIp(request.socket.remoteAddress || '')`と、IP取得の「意図」は同一だが実装経路が分散している。技術的制約（Edge Runtime vs Node.js）から経路分離は必然だが、`ws-server.ts`側で`normalizeIp()`の呼び忘れリスクがある。

**推奨**: `getClientIpFromSocket()`ヘルパーの追加。

```typescript
export function getClientIpFromSocket(
  socket: { remoteAddress?: string }
): string | null {
  const raw = socket.remoteAddress;
  if (!raw) return null;
  return normalizeIp(raw);
}
```

---

## モジュール命名規則の整合性

| 既存モジュール | 新規モジュール | パターン整合性 |
|--------------|--------------|-------------|
| `src/config/auth-config.ts` | `src/config/ip-restriction-config.ts` | 命名は整合的 |
| `src/lib/auth.ts` | `src/lib/ip-restriction.ts` | 命名は整合的 |
| `src/middleware.ts` | (既存変更) | - |

命名規則は既存パターンに準拠しており問題なし。

---

## エラー設計の評価

### fail-fast方式 -- 適切

不正なCIDR形式でサーバー起動を中断する設計は、セキュリティ機能として正しい。静かに失敗して「IPフィルタが効いていると思ったが実は効いていない」状態が最も危険であり、fail-fastはこれを確実に防止する。

既存パターンとの比較:
- `auth-config.ts`の`isValidTokenHash()`: 不正ハッシュ時にconsole.errorを出力し認証を無効化（やや寛容）
- `env.ts`の`getEnv()`: 不正値でthrow Error（fail-fast）
- `server.ts`の`validateCertPath()`: 不正時に`process.exit(2)`（fail-fast）

IP制限のfail-fast方式は`validateCertPath()`のパターンと整合的。

---

## テスト設計の評価

### 網羅性 -- 良好

Section 7.1の単体テストケースは主要なケースを網羅している。

| カテゴリ | テストケース数 | 評価 |
|---------|-------------|------|
| 正常系（マッチ） | 4 | 十分 |
| 正常系（不一致） | 2 | 十分 |
| 境界値（/0, /32） | 2 | 良好 |
| エラー系 | 2 | 十分 |
| normalizeIp | 2 | 最低限 |
| getClientIp | 2 | 最低限 |

### 追加推奨テストケース

1. `normalizeIp`の純粋IPv6アドレス入力（そのまま返す確認）
2. `parseAllowedIps`の空白を含む入力（`" 192.168.1.0/24 , 10.0.0.0/8 "`）
3. `getClientIp`で`CM_TRUST_PROXY=true`かつ`X-Forwarded-For`に複数IPが含まれる場合の先頭IP抽出
4. `isIpAllowed`に空のranges配列を渡した場合（false期待）

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | ws-server.tsでの毎回パースによるパフォーマンス低下 | Medium | High | P1 |
| 技術的リスク | ip-restriction-config.ts分離による不要なモジュール増加 | Low | High | P2 |
| 保守性リスク | キャッシュ戦略の不整合による将来のバグ混入 | Medium | Medium | P1 |
| テストリスク | isIpRestrictionEnabled()のprocess.env直接参照によるテスト困難 | Medium | Medium | P2 |

---

## 改善推奨事項

### 必須改善項目 (Must Fix)

| ID | 指摘 | 原則 |
|----|------|------|
| S1-001 | ws-server.tsでのparseAllowedIps()毎回呼び出しをキャッシュ方式に統一 | DRY |

### 推奨改善項目 (Should Fix)

| ID | 指摘 | 原則 |
|----|------|------|
| S1-002 | ip-restriction-config.tsの定数をip-restriction.ts内に統合 | YAGNI |
| S1-003 | isIpRestrictionEnabled()をauth.tsパターンに揃えてモジュール初期化時キャプチャに変更 | SOLID (DIP) |
| S1-004 | getClientIp()のJSDocに責務境界と将来の分離ポイントを記録 | SOLID (SRP) |

### 検討事項 (Nice to Have)

| ID | 指摘 | 原則 |
|----|------|------|
| S1-005 | CidrRange interfaceのJSDocにIPv6対応時の拡張計画を記録 | SOLID (OCP) |
| S1-006 | getClientIpFromSocket()ヘルパーの追加でnormalizeIp()呼び忘れ防止 | DRY |
| S1-007 | middleware.ts内フローステップのコメント付番維持 | KISS |
| S1-008 | daemon.tsのauthEnvKeys将来的な外部化検討 | DRY |

---

## Approval Status

**conditionally_approved** -- S1-001（must_fix）を修正し、S1-002/S1-003の対応方針を決定した上で実装に進むことを承認する。

---

*Generated by architecture-review-agent for Issue #332 Stage 1*
