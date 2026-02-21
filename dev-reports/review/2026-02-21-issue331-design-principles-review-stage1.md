# Issue #331 Stage 1: 設計原則レビュー（SOLID/KISS/YAGNI/DRY）

**Date**: 2026-02-21
**Issue**: #331 トークン認証・HTTPS対応
**Stage**: 1 - 通常レビュー（設計原則）
**Reviewer**: Architecture Review Agent
**Status**: Conditionally Approved

---

## Executive Summary

Issue #331の設計方針書は、トークン認証とHTTPS対応をCommandMateに追加するための設計を定義している。KISS/YAGNI原則を強く意識した技術選定（JWT不採用、セッションDB不使用、外部依存最小化）は評価できる。後方互換性最優先の方針（`--auth`なし起動時は従来と完全同一動作）も明確に設計されている。

主要な指摘事項は以下の通り。

- **Must Fix (3件)**: 認証有効/無効判定ロジックの一元化不足、Cookie名定数の散在リスク、server.tsへのHTTPS条件分岐のOCP懸念
- **Should Fix (6件)**: auth.tsの責務集中、parseDuration()の範囲定義、認証フロー重複、証明書エラーハンドリング、レート制限クリーンアップ伝達、トークン期限切れUX
- **Nice to Have (6件)**: DIP関連の将来検討、CLIオプション複雑性、i18n拡張性、命名パターン等

---

## 設計原則チェックリスト

### SRP (Single Responsibility Principle)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R001] | auth.ts - 4責務集中（トークン生成/検証/レート制限/Cookieパース） | Should Fix |

**詳細**: `src/lib/auth.ts`には7つの関数が配置される設計だが、トークン管理とレート制限は異なる変更理由を持つ独立した関心事である。レート制限はIPベースのMap管理・setIntervalクリーンアップ・ロックアウト判定という独自のライフサイクルを持ち、トークンの生成/検証とは変更タイミングが異なる。

**設計書該当箇所**: Section 2.3 レイヤー構成

```
src/lib/auth.ts
├── generateToken()          <- トークン生成（CLI用）
├── hashToken()              <- SHA-256ハッシュ計算
├── verifyToken()            <- トークン検証
├── isTokenExpired()         <- 有効期限チェック
├── parseDuration()          <- "24h", "48h" → ms変換
├── parseCookieToken()       <- Cookie文字列からトークン抽出
└── createRateLimiter()      <- IPベースレート制限  <-- 別責務
```

**推奨対応**: `createRateLimiter()`およびレート制限関連型定義を`src/lib/auth-rate-limiter.ts`に分離するか、auth.ts内でセクションコメントにより明確に区切る。既存コードベースでは`auto-yes-config.ts`がconfigの分離パターンを示しており、このパターンに準拠可能。

---

### OCP (Open/Closed Principle)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R002] | server.ts - HTTP/HTTPS条件分岐の直接埋め込み | Must Fix (設計書修正) |
| [R011] | i18n.ts - namespace追加パターン | Nice to Have |

**R002 詳細**: 現在の`server.ts`（175行）はHTTPサーバー生成に集中しており、変更が最小限に保たれている。設計方針書Section 9.1ではserver.ts内にif/elseでHTTP/HTTPSを条件分岐する設計となっている。

現在のserver.ts:
```typescript
// server.ts L29, L56
import { createServer } from 'http';
const server = createServer(async (req, res) => { ... });
```

設計方針書の変更後:
```typescript
// Section 9.1 の設計
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';

let server;
if (isHttps) {
  server = createHttpsServer(options, requestHandler);
} else {
  server = createHttpServer(requestHandler);
}
```

**推奨対応**: サーバーファクトリ関数の抽出が理想的だが、KISS原則との兼ね合いで現時点のスコープではserver.ts内の条件分岐でも許容可能。その場合、設計書にトレードオフとして明記すべき。

---

### DIP (Dependency Inversion Principle)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R003] | middleware.ts/ws-server.ts -> auth.ts具象関数依存 | Nice to Have |

**詳細**: middleware.tsとws-server.tsがauth.tsの具象関数（`verifyToken()`, `parseCookieToken()`）に直接依存する設計。現時点ではトークン認証のみなのでYAGNI原則に基づき許容される。将来の拡張（APIキー認証等）時に認証戦略インターフェースを導入する際の設計メモを残すことを推奨。

---

### KISS (Keep It Simple, Stupid)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R004] | CLIオプション5つの組み合わせルール | Nice to Have |

**詳細**: `--auth`, `--https`, `--cert`, `--key`, `--allow-http`の5オプション、5パターンの組み合わせ表が定義されている。暗黙的な挙動（`--auth --cert --key`で`--https`が暗黙有効化、`--auth --https`同時指定で`--https`が冗長無視）はユーザーの認知負荷を増やす。

**設計書該当箇所**: Section 7 CLIオプション組み合わせルール

| 起動方法 | プロトコル | 認証 |
|----------|-----------|------|
| `commandmate start` | HTTP | なし |
| `commandmate start --auth` | HTTP（警告） | あり |
| `commandmate start --auth --allow-http` | HTTP | あり |
| `commandmate start --auth --cert X --key Y` | **HTTPS** | あり |
| `commandmate start --https --cert X --key Y` | HTTPS | なし |

**正の評価**: JWT不採用、セッションDB不使用、bcrypt不使用（SHA-256で十分）、外部ライブラリ最小化など、全体のアーキテクチャはKISS原則に良く準拠している。

---

### YAGNI (You Aren't Gonna Need It)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R005] | parseDuration()の範囲定義が曖昧 | Should Fix |

**詳細**: Section 3では「'24h'/'48h'の限定的パースのみ」と説明しているが、`--auth-expire <dur>`オプションはユーザーが任意の値を入力できるため、実装時に対応範囲が曖昧になる。

**推奨対応**: `auto-yes-config.ts`の`ALLOWED_DURATIONS`パターンに倣い、サポートする期間値をホワイトリスト定数として定義する。

```typescript
// auto-yes-config.ts の既存パターン
export const ALLOWED_DURATIONS = [5, 10, 15, 20, 25, 30, 60] as const;

// 同様のアプローチ
export const ALLOWED_AUTH_DURATIONS = ['1h', '6h', '12h', '24h', '48h', '72h', '7d'] as const;
```

**正の評価**: JWT不採用、セッションDB不使用、Passport.js不採用、Redis不採用など、不採用技術の選定理由が明確に文書化されている点は優れている。

---

### DRY (Don't Repeat Yourself)

| 評価 | 対象 | 判定 |
|------|------|------|
| [R006] | Cookie名定数の重複リスク | Must Fix |
| [R007] | 認証フロー（Cookie取得→パース→検証→期限チェック）の重複 | Should Fix |
| [R012] | 認証有効/無効判定ロジックの散在 | Must Fix |

**R006 詳細**: Cookie名`'cm_auth_token'`が設計書内だけでも4箇所に出現し、実装時にハードコードされた文字列が散在するリスクが高い。

**推奨対応**:
```typescript
// src/lib/auth.ts (または src/config/auth-config.ts)
export const AUTH_COOKIE_NAME = 'cm_auth_token' as const;
export const AUTH_EXCLUDED_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
] as const;
```

**R007 詳細**: middleware.tsとws-server.tsで認証フロー（Cookie取得→パース→ハッシュ比較→期限チェック→結果判定）が重複する。

**推奨対応**: auth.tsに統合認証関数を追加。
```typescript
// auth.ts
interface AuthResult {
  authenticated: boolean;
  error?: 'no_token' | 'invalid_token' | 'expired_token';
}

export function authenticateRequest(cookieHeader: string | undefined): AuthResult {
  // Cookie取得→パース→検証→期限チェックの一連のフローを一元化
}
```

**R012 詳細**: `CM_AUTH_TOKEN_HASH`の有無による認証有効/無効判定が3箇所（middleware.ts、ws-server.ts、auth/status API）に分散する。

**推奨対応**: `auth.ts`に`isAuthEnabled(): boolean`を定義し、全箇所からこの関数を呼び出す。

---

### 命名規則

| 評価 | 対象 | 判定 |
|------|------|------|
| [R008] | boolean型環境変数の値解釈ルール未定義 | Nice to Have |
| [R013] | auth.tsのファイル名が短い | Nice to Have |

**R008 詳細**: `CM_AUTH_ENABLED=1`, `CM_HTTPS_ENABLED=1`, `CM_AUTH_ALLOW_HTTP=1`のboolean型環境変数は既存コードベースに前例がない。値の解釈方法（`'1'`のみtrue? `'true'`もtrue?）を設計書で明記すべき。

---

### エラーハンドリング

| 評価 | 対象 | 判定 |
|------|------|------|
| [R009] | 証明書ファイル読み込みエラーのハンドリング不足 | Should Fix |
| [R010] | レート制限クリーンアップタイマーのgraceful shutdown統合 | Should Fix |
| [R014] | トークン期限切れ時のクライアント側UXフロー未定義 | Should Fix |

**R009 詳細**: Section 9.1の`readFileSync(certPath)`にtry-catchがなく、ファイル破損・権限不足時にuncaught exceptionでクラッシュする。Section 9.3のstart.tsでのexistsSync()チェックはファイル存在のみで、内容の妥当性は検証していない。

**R010 詳細**: `createRateLimiter()`が返すクリーンアップハンドル（intervalId）をserver.tsの`gracefulShutdown()`に伝達する方法が不明確。既存パターン:
```typescript
// server.ts L150-155 既存パターン
stopAllPolling();
stopAllAutoYesPolling();
closeWebSocket();
// ここにレート制限のクリーンアップも必要
```

**R014 詳細**: クライアント側でトークン期限切れ時の挙動が未定義。APIリクエスト401時のリダイレクト、WebSocket切断時の再認証フローを設計書に追記すべき。

---

### その他

| 評価 | 対象 | 判定 |
|------|------|------|
| [R015] | tsconfig.cli.jsonへのauth.ts追加の必要性 | Nice to Have |

**R015 詳細**: Section 11.2で「CLIのstart.tsからauth.tsのトークン生成関数を呼ぶ」と記載されているが、現在の`tsconfig.cli.json`のincludeパターンが`src/cli/**/*`のみの場合、`src/lib/auth.ts`はCLIビルドで解決できない可能性がある。Section 14の変更対象ファイル一覧にtsconfig.cli.jsonが含まれていない。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | DRY違反による認証ロジック散在→バグの温床 | High | High | P1 |
| 技術的リスク | server.tsのHTTPS分岐がOCPに抵触→将来の変更困難 | Medium | Medium | P2 |
| 運用リスク | トークン期限切れ時のクライアントUX未定義→ユーザー混乱 | Medium | High | P2 |
| 技術的リスク | 証明書読み込みエラー→サーバークラッシュ | High | Low | P2 |
| 技術的リスク | レート制限タイマーのリーク→メモリリーク | Low | Medium | P3 |

---

## 正の評価ポイント

1. **YAGNI原則の徹底**: JWT、セッションDB、bcrypt、Redis、Passport.js等の不採用理由が明確に文書化されている
2. **後方互換性設計**: `--auth`なし起動時の動作保証がmiddleware.tsの冒頭ガードで明確に設計されている
3. **技術選定の妥当性**: Node.js標準モジュール（crypto）のみでトークン生成・ハッシュ計算を実装し、外部依存を最小化
4. **実装順序ガイダンス**: Phase 1-5の段階的実装計画が明確で、依存関係を考慮した順序になっている
5. **トレードオフの文書化**: Section 13で設計判断とそのトレードオフが網羅的に記載されている
6. **WebSocket認証の独立設計**: Next.js middlewareがWebSocket upgradeを処理しない制約を正しく認識し、ws-server.tsでの独立認証を設計している
7. **既存パターンの踏襲**: i18n namespace追加、CLI型定義拡張、セキュリティメッセージ等が既存のコーディングパターンに準拠している

---

## 改善推奨事項

### 必須改善項目 (Must Fix)

1. **[R006] Cookie名・認証除外パス等の定数をauth.ts（またはsrc/config/auth-config.ts）に一元定義する設計を追記**
2. **[R012] auth.tsにisAuthEnabled(): boolean関数を定義し、認証有効/無効判定を一元化する設計を追記**
3. **[R002] server.tsへのHTTPS条件分岐について、OCPとのトレードオフを設計書Section 13に明記**

### 推奨改善項目 (Should Fix)

4. **[R001] auth.ts内のレート制限責務について、セクション分割またはファイル分離の方針を明記**
5. **[R005] parseDuration()のサポート範囲をホワイトリスト定数で定義**
6. **[R007] auth.tsに統合認証関数authenticateRequest()を追加し、認証フローのDRY化を図る**
7. **[R009] server.tsの証明書読み込みにtry-catchを追加する設計を明記**
8. **[R010] レート制限クリーンアップタイマーのgraceful shutdown統合方法を明記**
9. **[R014] トークン期限切れ時のクライアント側UXフロー（401→リダイレクト、WS切断→再認証）を追記**

### 検討事項 (Nice to Have)

10. **[R003]** 将来の認証戦略拡張に備えた設計メモの追加
11. **[R004]** CLIオプション冗長指定時のログメッセージ追加
12. **[R008]** boolean型環境変数の解釈ルール明記
13. **[R011]** i18n namespace管理の将来的な動的化検討
14. **[R013]** auth.tsの命名の将来拡張性
15. **[R015]** tsconfig.cli.jsonの変更要否の確認と設計書への反映

---

## 承認ステータス

**Conditionally Approved** -- Must Fix 3件を設計書に反映した後、Stage 2（整合性レビュー）に進むことを推奨する。

---

*Generated by Architecture Review Agent*
*Review target: dev-reports/design/issue-331-token-auth-design-policy.md*
