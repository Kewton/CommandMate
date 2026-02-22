# Architecture Review Report: Issue #331 Stage 2 整合性レビュー

**Issue**: #331 トークン認証・HTTPS対応
**Stage**: 2 (整合性レビュー)
**Focus**: 整合性
**Date**: 2026-02-21
**Status**: Conditionally Approved
**Score**: 3/5

---

## Executive Summary

設計方針書はStage 1のレビュー指摘(must_fix: 3件, should_fix: 6件, nice_to_have: 6件)を反映し、認証アーキテクチャの全体像・トレードオフ・実装チェックリストが充実している。しかし、既存コードベースとの具体的な整合性確認において3件のmust_fix(実装ブロッカー)と8件のshould_fix(品質・保守性リスク)が検出された。

主要な問題は以下の3カテゴリに分類される:

1. **ビルド構成の不整合**: tsconfig.cli.jsonとtsconfig.server.jsonのinclude範囲の制約が、設計書のモジュール間依存と矛盾(C001, C002)
2. **既存パターンとの不整合**: ENV_MAPPING、i18n.tsのnamespaceマージ方式、ALLOWED_DURATIONSの値形式が既存コードと異なる(C003, C005, C007)
3. **設計書内セクション間の曖昧さ**: AuthState初期化フロー、CM_AUTH_ENABLEDの用途、rateLimiterライフサイクルの記述不足(C004, C009, C010)

---

## Detailed Findings

### Must Fix (3件) -- 実装前に必ず対応

#### C001: tsconfig.cli.jsonがsrc/cli/**/*のみincludeのため、start.tsからsrc/lib/auth.tsをimportできない

**Severity**: must_fix
**Category**: 設計書-コード整合性
**Location**: Section 11.2 auth.tsのCLIビルド互換性制約

**問題**:

設計方針書Section 11.2では「CLIの`start.ts`から`auth.ts`のトークン生成関数を呼ぶため、CLI側のimportパスが`src/lib/auth.ts`を参照可能であること」と記載している。しかし、実際の`tsconfig.cli.json`を確認すると:

```json
// /Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.cli.json
{
  "include": ["src/cli/**/*"],
  "compilerOptions": {
    "paths": {}  // パスエイリアスが無効化されている
  }
}
```

`src/lib/auth.ts`はinclude範囲外のためCLIビルドでTypeScriptコンパイルエラーになる。さらに`paths: {}`により`@/*`エイリアスが使えないため、相対パスimportが必要になる。

**提案**:
- `tsconfig.cli.json`のincludeに`"src/lib/auth.ts"`を追加する
- Section 11.2に「CLI側からのimportは`../../lib/auth`のような相対パスを使用すること」を明記する

---

#### C002: server.tsの設計コード例でExitCodeを参照しているがserver.tsには現在importされていない

**Severity**: must_fix
**Category**: 設計書-コード整合性
**Location**: Section 9.1 server.tsの条件分岐

**問題**:

設計方針書Section 9.1のHTTPS条件分岐コード例:

```typescript
process.exit(ExitCode.CONFIG_ERROR);
```

現在の`server.ts`(`/Users/maenokota/share/work/github_kewton/commandmate-issue-331/server.ts`)にはExitCode enumのimportがなく、`process.exit(1)`を直接使用している。`ExitCode`は`src/cli/types/index.ts`に定義されているが、`tsconfig.server.json`のincludeには`src/types/**/*.ts`は含まれているものの`src/cli/types/**`は含まれていない。

```json
// /Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.server.json
{
  "include": [
    "server.ts",
    "src/lib/env.ts",
    // ... src/cli/types/ は含まれていない
    "src/types/**/*.ts"
  ]
}
```

**提案**:
- 方法A: `ExitCode`を`src/types/exit-codes.ts`(共有型定義)に移動し、`src/cli/types/index.ts`からre-exportする
- 方法B: server.tsでは`process.exit(2)`のように数値リテラルを使用し、コメントで`ExitCode.CONFIG_ERROR`と注記する
- 方法C: `tsconfig.server.json`のincludeに`src/cli/types/index.ts`を追加する

---

#### C003: 新環境変数がENV_MAPPINGおよびEnv interfaceに追加される設計が記載されていない

**Severity**: must_fix
**Category**: 設計書-コード整合性
**Location**: Section 7 CLIオプションと環境変数マッピング

**問題**:

既存の`src/lib/env.ts`は全ての`CM_*`環境変数をENV_MAPPINGで管理し、`getEnvByKey()`でフォールバック付き取得を提供している:

```typescript
// /Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/env.ts
export const ENV_MAPPING = {
  CM_ROOT_DIR: 'MCBD_ROOT_DIR',
  CM_PORT: 'MCBD_PORT',
  CM_BIND: 'MCBD_BIND',
  CM_LOG_LEVEL: 'MCBD_LOG_LEVEL',
  CM_LOG_FORMAT: 'MCBD_LOG_FORMAT',
  CM_DB_PATH: 'MCBD_DB_PATH',
} as const;
```

設計方針書Section 7で定義されている7つの新環境変数(CM_AUTH_ENABLED, CM_AUTH_EXPIRE, CM_HTTPS_CERT, CM_HTTPS_KEY, CM_HTTPS_ENABLED, CM_AUTH_ALLOW_HTTP, CM_AUTH_TOKEN_HASH)について、ENV_MAPPINGへの追加方針が記載されていない。Section 2.3のisAuthEnabled()は`process.env.CM_AUTH_TOKEN_HASH`を直接参照する設計(R012)だが、これは既存パターンと異なる。

**提案**:

AUTH関連環境変数にはMCBD_*レガシーフォールバックが不要(Issue #179でCM_AUTH_TOKEN系は既に廃止済み)なため、`process.env`直接参照でよいという設計判断を明記する。これにより既存のENV_MAPPING/getEnvByKey()パターンからの逸脱が意図的であることが明確になる。

---

### Should Fix (8件) -- 品質・保守性向上のため推奨

#### C004: AuthState interfaceの初期化フローが不明確

**Severity**: should_fix
**Category**: 設計書内整合性
**Location**: Section 2.3, Section 4.1, Section 6.3

Section 4.1のAuthState interface(tokenHash, expireAt, enabled)がモジュールスコープに保持される場合、初期化タイミングが明確でない。サーバー起動時にCM_AUTH_TOKEN_HASHから読み込むのか、認証リクエスト時に遅延初期化するのか。expireAtの計算元(CM_AUTH_EXPIRE)がサーバー側でどう受け取られるかも不明。

**提案**: AuthStateの初期化フロー図またはシーケンスを追記する。

#### C005: i18n.tsのコード例が既存実装のマージ方式と不一致

**Severity**: should_fix
**Category**: 設計書内整合性
**Location**: Section 10.2

設計書はスプレッド演算子によるフラットマージ(`...auth.default`)を記載しているが、実際のi18n.tsはnamespace付きキーマージ(`auth: auth.default`)を使用している。

**実際のコード** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/i18n.ts`):
```typescript
return {
  locale,
  messages: {
    common: common.default,
    worktree: worktree.default,
    autoYes: autoYes.default,
    error: error.default,
    prompt: prompt.default,
  },
};
```

**提案**: Section 10.2のコード例を`auth: auth.default`形式に修正する。

#### C006: setupWebSocket()型拡張のHTTPSServer互換性根拠が不足

**Severity**: should_fix
**Category**: 設計書-コード整合性
**Location**: Section 9.2

ws-server.tsの`server.on('upgrade', ...)`がHTTPSServerでも同じIncomingMessageを受け取ることの明示的な根拠が設計書にない。

**提案**: Node.js APIの互換性保証を設計書に明記する。

#### C007: ALLOWED_AUTH_DURATIONSの値形式がALLOWED_DURATIONSと異なる

**Severity**: should_fix
**Category**: 既存パターン整合性
**Location**: Section 2.3

設計書はALLOWED_AUTH_DURATIONS = ['1h', '6h', ...]（文字列配列）、既存ALLOWED_DURATIONS = [3600000, 10800000, ...]（数値配列）。設計書はパターン準拠を謳っているが型が異なる。

**提案**: 「ホワイトリスト方式」というアプローチの準拠であり、値形式は用途に応じて異なることを明記する。

#### C008: DaemonManager.start()への環境変数追加の具体的設計が不足

**Severity**: should_fix
**Category**: 設計書-コード整合性
**Location**: Section 12 Phase 4, Section 14

daemon.tsのstart()メソッドでCM_AUTH_TOKEN_HASH等をspawnの環境変数に含める具体的なコード例がない。

**提案**: daemon.tsへの変更箇所の具体的なコード例を追記する。

#### C009: CM_AUTH_ENABLEDとisAuthEnabled()の判定基準が矛盾する可能性

**Severity**: should_fix
**Category**: 設計書内整合性
**Location**: Section 7, Section 2.3 R012

Section 7はCM_AUTH_ENABLED='1'で認証有効、Section 2.3のisAuthEnabled()はCM_AUTH_TOKEN_HASHの有無で判定。CM_AUTH_ENABLEDの正確な用途が不明確。

**提案**: CM_AUTH_ENABLEDの用途を明確化し、サーバー側はCM_AUTH_TOKEN_HASHのみで判定する方針を明記する。

#### C010: rateLimiterインスタンスのライフサイクル管理方針が不明確

**Severity**: should_fix
**Category**: 設計書-コード整合性
**Location**: Section 6.2 R010

server.tsのgracefulShutdownからrateLimiter.destroy()を呼ぶ設計だが、rateLimiterインスタンスへのアクセス方法(exportパターン)が不明確。

**提案**: auth.tsからdestroyRateLimiter()関数をexportし、server.tsから呼ぶパターンを推奨する。

#### C011: middleware.tsの完全なファイルスケルトンが不足

**Severity**: should_fix
**Category**: 設計書-コード整合性
**Location**: Section 5.3, 5.4, 14

Next.js middlewareの正確なexport形式(named export `middleware`, export `config`)の完全なスケルトンが設計書に記載されていない。

**提案**: import文、export middleware関数、export configを含む完全なファイルスケルトンを追記する。

---

### Nice to Have (5件) -- 将来検討

| ID | Category | Title |
|----|----------|-------|
| C012 | 設計書内整合性 | Cookie Max-Ageの動的計算タイミングとexpireAt設定タイミングの整合性 |
| C013 | 設計書内整合性 | status.tsのHTTPS URL表示の具体的な実装方針が不足 |
| C014 | テスト整合性 | 設計方針書にテスト計画セクションが存在しない |
| C015 | 既存パターン整合性 | security-messages.tsの--auth時メッセージ分岐の具体的設計が不足 |
| C016 | 設計書-コード整合性 | Section 6.3のタイポ: 「トークンP平文」 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | tsconfig.cli.json/server.jsonのinclude範囲不足によるビルドエラー | High | High | P1 |
| 技術的リスク | i18n.tsマージ方式の不一致による翻訳キー参照エラー | Med | High | P1 |
| 技術的リスク | AuthState初期化フローの曖昧さによる実装差異 | Med | Med | P2 |
| セキュリティ | CM_AUTH_ENABLEDとCM_AUTH_TOKEN_HASHの判定矛盾による認証バイパス | High | Low | P1 |
| 運用リスク | rateLimiterのdestroy()未呼出によるタイマーリーク(graceful shutdownの遅延) | Low | Med | P3 |

---

## Consistency Check Matrix

### 設計書 vs 既存コードの整合性

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| tsconfig.cli.json include | src/lib/auth.tsを参照可能と想定(Section 11.2) | `"include": ["src/cli/**/*"]`のみ | **不整合(C001)** |
| tsconfig.server.json include | ExitCode使用(Section 9.1) | src/cli/types/含まず | **不整合(C002)** |
| ENV_MAPPING統合 | process.env直接参照(Section 2.3) | 既存はgetEnvByKey()パターン | **方針未記載(C003)** |
| i18n.ts namespace追加 | スプレッドマージ(Section 10.2) | namespace付きキーマージ | **不整合(C005)** |
| setupWebSocket()型 | HTTPServer \| HTTPSServer(Section 9.2) | HTTPServerのみ | 設計通りの変更で問題なし |
| useWebSocket.ts | wss://自動検出済み(Section 14) | `window.location.protocol`で動的判定(line 107) | **整合** |
| next.config.js CSP | ws:/wss:両方許可済み(Section 14) | `"connect-src 'self' ws: wss:"`(line 65) | **整合** |
| ALLOWED_DURATIONS | パターン準拠(Section 2.3 R005) | 数値配列(ms) vs 文字列配列 | **形式差異(C007)** |
| gracefulShutdown | stopAllPolling()後にdestroy()追加(Section 6.2) | stopAllPolling() + stopAllAutoYesPolling()が既存 | 設計通りの追加で問題なし |

### 設計書内セクション間の整合性

| 照合対象 | 整合状況 |
|---------|---------|
| Section 2.3 関数一覧 vs Section 5.x コード例 | 整合(authenticateRequest, isAuthEnabled, parseCookieToken等が一致) |
| Section 7 CLI環境変数 vs Section 12 実装順序 | Phase 4でCLI実装、概ね整合。ただしCM_AUTH_ENABLEDの用途が曖昧(C009) |
| Section 9.1 server.ts vs Section 14 ファイル一覧 | 整合(server.tsは変更対象として記載) |
| Section 4.2 Cookie仕様 vs Section 6.3 トークン管理 | 概ね整合。Cookie Max-Age計算タイミングのみ曖昧(C012) |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. **C001**: `tsconfig.cli.json`のincludeに`"src/lib/auth.ts"`を追加する方針を設計書Section 11.2に明記する
2. **C002**: server.tsでのExitCode参照方法を決定し設計書に反映する(共有型への移動 or 数値リテラル使用)
3. **C003**: AUTH関連環境変数にはレガシーフォールバックが不要なためprocess.env直接参照とする設計判断をSection 7に明記する

### 推奨改善項目 (Should Fix)

4. **C004**: AuthState初期化フロー(サーバー起動時のCM_AUTH_TOKEN_HASH読み込み、expireAt計算タイミング)を新セクションに追記
5. **C005**: Section 10.2のi18n.tsコード例を`auth: auth.default`形式に修正
6. **C009**: CM_AUTH_ENABLEDの正確な用途(CLI内部フラグのみ)とサーバー側判定基準(CM_AUTH_TOKEN_HASHのみ)を明確化
7. **C010**: rateLimiterのexport/destroyパターンを具体化
8. **C011**: middleware.tsの完全なファイルスケルトンを追記

### 検討事項 (Consider)

9. **C014**: テスト方針セクションの追加
10. **C016**: タイポ修正

---

## Reviewed Files

| File | Purpose |
|------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/dev-reports/design/issue-331-token-auth-design-policy.md` | 設計方針書(レビュー対象) |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/env.ts` | 既存ENV_MAPPING, Env interface |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/config/auto-yes-config.ts` | 既存ALLOWED_DURATIONSパターン |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/utils/daemon.ts` | DaemonManager.start()実装 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/server.ts` | 既存gracefulShutdown実装 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/lib/ws-server.ts` | 既存setupWebSocket()実装 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/types/index.ts` | ExitCode, StartOptions定義 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/commands/start.ts` | startCommand実装 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/index.ts` | commander定義 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/i18n.ts` | i18n namespace設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.server.json` | サーバービルド設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.cli.json` | CLIビルド設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/tsconfig.base.json` | 基本TS設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/hooks/useWebSocket.ts` | WebSocketフック(wss://検出) |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/next.config.js` | CSP設定確認 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/config/security-messages.ts` | セキュリティメッセージ定数 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/src/cli/commands/status.ts` | statusコマンド実装 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-331/.env.example` | 環境変数テンプレート |

---

## Approval Status

**Conditionally Approved** -- must_fix 3件の解消後に実装フェーズ移行可能。特にtsconfig関連のビルド構成不整合(C001, C002)は実装開始直後にブロッカーとなるため、早期対応が必須。

---

*Generated by architecture-review-agent for Issue #331 Stage 2*
*Date: 2026-02-21*
