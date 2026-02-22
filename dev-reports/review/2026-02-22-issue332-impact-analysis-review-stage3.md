# Issue #332 影響範囲レビュー (Stage 3)

## Executive Summary

Issue #332（アクセス元IP制限オプション）の設計方針書について、影響範囲（変更の波及効果）の観点からレビューを実施した。

**評価結果**: conditionally_approved (スコア: 4/5)

設計方針書の影響範囲分析は概ね適切で、CM_ALLOWED_IPS未設定時の後方互換性が確保されている。Must Fixが2件、Should Fixが4件、Nice to Haveが3件検出された。主要な懸念はビルド設定の変更漏れとテスト設計の精緻化である。

---

## 1. 既存テストへの影響分析

### 1.1 auth-middleware.test.ts への影響

**ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-332/tests/integration/auth-middleware.test.ts`

現在のテスト構造:
- `vi.resetModules()` を各テストケース（L55, L103, L117, L129, L143, L155, L169, L183, L195, L209）で使用
- `process.env = { ...originalEnv }` による環境変数の隔離（L56）
- `delete process.env.CM_AUTH_TOKEN_HASH` / `delete process.env.CM_AUTH_EXPIRE` をbeforeEachで実行（L57-58）

**影響分析**:

| テストケース | 影響有無 | 理由 |
|-------------|---------|------|
| CM_AUTH_TOKEN_HASH未設定時のpass through (L91) | 影響なし | CM_ALLOWED_IPS未設定のためisIpRestrictionEnabled()=false |
| 未認証リクエストのリダイレクト (L99) | 影響なし | IP制限チェック後の認証処理であり、IP制限が無効なら既存動作維持 |
| 認証済みリクエストのpass through (L112) | 影響なし | 同上 |
| 除外パスのpass through (L126-163) | 要注意 | IP制限は除外パスの前に適用されるため、CM_ALLOWED_IPS設定時はIPチェックが先行 |
| WebSocket upgradeの認証 (L191-224) | 影響なし | middleware.tsではWebSocket upgradeのearly returnの前にIP制限が入るが、CM_ALLOWED_IPS未設定なら通過 |

**重要な干渉パターン**: ip-restriction.tsのモジュールスコープ初期化がfail-fast（throw）設計であるため、`vi.resetModules()`後のdynamic importで、不正なCM_ALLOWED_IPSがprocess.envに残存しているとモジュール初期化時にエラーがスローされる。

### 1.2 単体テストへの影響

| テストファイル | 影響有無 | 詳細 |
|---------------|---------|------|
| `tests/unit/auth.test.ts` | 影響なし | auth.tsモジュールのテスト。ip-restriction.tsに依存しない |
| `tests/unit/cli-auth-options.test.ts` | 影響なし | StartOptions型のテスト。型にallowedIps/trustProxyが追加されるが既存フィールドに影響なし |
| `tests/unit/cli/utils/daemon.test.ts` | 軽微な影響 | authEnvKeysへの追加により、process.envにCM_ALLOWED_IPSが存在する場合にspawn envに含まれる。テスト失敗はしないが留意が必要 |
| `tests/unit/cli/commands/start.test.ts` | 影響なし | startCommandのテスト。新オプション未使用のテストは既存動作維持 |
| `tests/unit/env.test.ts` | 影響なし | ENV_MAPPINGのキー数テスト（L215: 7個）はENV_MAPPINGに変更がないため通過 |

### 1.3 vi.resetModules()とip-restriction.tsの干渉パターン (S3-001)

```
テスト実行フロー:
1. process.env.CM_ALLOWED_IPS = '不正値' を設定
2. vi.resetModules() を呼び出し
3. await import('@/middleware') を実行
4. middleware.tsがip-restriction.tsをimport
5. ip-restriction.tsのモジュールスコープ初期化で parseAllowedIps() 呼び出し
6. parseAllowedIps() が不正値に対してErrorをthrow
7. テストランナーがクラッシュ
```

**推奨テストパターン**:
```typescript
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  delete process.env.CM_AUTH_TOKEN_HASH;
  delete process.env.CM_AUTH_EXPIRE;
  delete process.env.CM_ALLOWED_IPS;    // 追加必須
  delete process.env.CM_TRUST_PROXY;     // 追加必須
});
```

---

## 2. 既存機能へのリグレッションリスク分析

### 2.1 middleware.ts の変更影響

**変更内容**: IP制限チェックを既存処理の最前段に挿入

```
現行フロー:                          変更後フロー:
WebSocket upgrade check              [NEW] IP restriction check
  |                                    |
Auth disabled check                  WebSocket upgrade check
  |                                    |
Excluded paths check                 Auth disabled check
  |                                    |
Cookie auth check                    Excluded paths check
  |                                    |
Redirect to /login                   Cookie auth check
                                       |
                                     Redirect to /login
```

**リグレッションリスク評価**:

| 条件 | リスク | 根拠 |
|------|--------|------|
| CM_ALLOWED_IPS未設定 | 極低 | `isIpRestrictionEnabled()` が false を返し、IP制限ブロック全体がスキップされる |
| CM_ALLOWED_IPS設定 + 許可IP | 低 | 許可IPからのリクエストは通過し、後続の認証処理は変更なし |
| CM_ALLOWED_IPS設定 + 拒否IP | N/A | 新機能の期待動作。403を返す |
| CM_AUTH_TOKEN_HASH未設定 + CM_ALLOWED_IPS未設定 | 極低 | 両方のガード条件がスキップされ、既存動作と完全に同一 |

### 2.2 server.tsのX-Real-IP注入の干渉分析

**挿入位置**: L119（setHeaderガードのreturn後）とL120（upgradeスキップのif文の前）の間

```typescript
// L116-118: setHeaderガード（既存）
if (typeof (res as unknown as { setHeader?: unknown })?.setHeader !== 'function') {
  return;
}

// --- X-Real-IP注入コード（新規挿入） ---
const clientIp = req.socket.remoteAddress || '';
if (process.env.CM_TRUST_PROXY !== 'true') {
  req.headers['x-real-ip'] = clientIp;
}

// L120-123: upgradeスキップ（既存）
if (req.headers['upgrade']) {
  return;
}
```

**既存処理への干渉**:
- `req.headers` への書き込みはNode.js IncomingMessage APIで許可されている
- `x-real-ip` ヘッダーは既存コードでは使用されていない（middleware.tsは新規コードでgetClientIp()経由で参照）
- WebSocket upgradeリクエストにもX-Real-IPが注入されるが、upgradeハンドラーではrequest.socket.remoteAddressを直接使用するため無害

### 2.3 ws-server.tsの変更影響

**挿入位置**: upgradeハンドラー内、isAuthEnabled()チェック（L80）の前

```typescript
// 新規挿入: IP制限チェック
if (isIpRestrictionEnabled()) {
  const clientIp = normalizeIp(request.socket.remoteAddress || '');
  if (!isIpAllowed(clientIp, getAllowedRanges())) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
}

// L80-90: 既存の認証チェック（変更なし）
if (isAuthEnabled()) { ... }
```

**干渉リスク**: なし。IP制限チェックは認証チェックの前に挿入され、拒否時は早期returnする。許可時は後続の認証処理が変更なく実行される。

---

## 3. Section 11 影響範囲サマリーの検証

### 3.1 設計方針書の記載 vs 実際の変更対象

| 区分 | 設計方針書の数 | 検証結果 | 差異 |
|------|---------------|---------|------|
| 新規作成 | 2 | 2 | 一致 |
| 既存変更 | 13 | 14 | +1 (tsconfig.server.json) |
| ドキュメント | 3 | 3 | 一致 |
| 合計 | 18 | 19 | +1 |

### 3.2 検出された変更対象ファイル一覧

#### 新規作成 (2ファイル)
| # | ファイル | 内容 |
|---|---------|------|
| 1 | `src/lib/ip-restriction.ts` | CIDRマッチング、キャッシュ管理、IP取得 |
| 2 | `tests/unit/ip-restriction.test.ts` | 単体テスト |

#### 既存変更 (14ファイル) -- 設計方針書は13ファイルと記載
| # | ファイル | 変更内容 | 設計方針書に記載 |
|---|---------|---------|----------------|
| 3 | `server.ts` | X-Real-IP注入 | あり (Section 4.1) |
| 4 | `src/middleware.ts` | IP制限チェック挿入 | あり (Section 4.2) |
| 5 | `src/lib/ws-server.ts` | WebSocket IP制限 | あり (Section 4.3) |
| 6 | `src/lib/env.ts` | Envインターフェース拡張 | あり (Section 4.4) |
| 7 | `src/cli/utils/daemon.ts` | authEnvKeys拡張 | あり (Section 4.5) |
| 8 | `src/cli/commands/start.ts` | --allowed-ips/--trust-proxy処理 | あり (Section 4.6) |
| 9 | `src/cli/commands/init.ts` | 未明確 (Section 4.6で言及) | 不明確 |
| 10 | `src/cli/commands/status.ts` | 未明確 (Section 4.6で言及) | 不明確 |
| 11 | `src/cli/index.ts` | commander定義追加 | あり (Section 4.6) |
| 12 | `src/cli/types/index.ts` | StartOptions拡張 | あり (Section 4.6) |
| 13 | `src/cli/config/security-messages.ts` | 警告メッセージ更新 | あり (Section 4.7) |
| 14 | `tests/integration/auth-middleware.test.ts` | IP制限テスト追加 | あり (Section 7.2) |
| 15 | **`tsconfig.server.json`** | **includeリスト追加** | **なし (S3-002)** |

#### ドキュメント (3ファイル)
| # | ファイル | 内容 |
|---|---------|------|
| 16 | CLAUDE.md | モジュール説明追加 |
| 17 | README.md | 環境変数ドキュメント |
| 18-19 | その他ドキュメント | 実装履歴等 |

### 3.3 見落とされた影響ファイル

**tsconfig.server.json** (S3-002): ws-server.tsがip-restriction.tsをimportするため、`npm run build:server`で使用されるtsconfig.server.jsonのincludeリストに`src/lib/ip-restriction.ts`の追加が必要。これがないとビルドエラーが発生する。

### 3.4 login/route.tsのスコープ外判定の妥当性

`/Users/maenokota/share/work/github_kewton/commandmate-issue-332/src/app/api/auth/login/route.ts` のL22-35コメントにCM_TRUST_PROXYへの将来的な言及がある:

> A future CM_TRUST_PROXY option could enable per-IP limiting behind a proxy

Issue #332でCM_TRUST_PROXYが実装されるが、login/route.tsのレート制限ロジックの変更はスコープ外とする判断は**妥当**である。per-IP rate limitingの実装は独立した機能変更であり、別Issueとして追跡すべきである。ただし、実装者が誤ってlogin/route.tsのRATE_LIMIT_KEYを変更しないよう注意喚起が必要。

---

## 4. ビルドと型チェックへの影響

### 4.1 npm run build:cli への影響

**tsconfig.cli.json** の include は `src/cli/**/*` のみ:
```json
{
  "include": ["src/cli/**/*"]
}
```

ip-restriction.tsは`src/lib/`に配置されるため、CLIビルドには含まれない。CLIモジュール（start.ts/daemon.ts）からip-restriction.tsを直接importしない設計は、auth.tsのC001制約（Next.js固有モジュール依存禁止）と同様のパターンであり、適切。

**結論**: CLIビルドへの影響なし。

### 4.2 npm run build:server への影響 (S3-002)

**tsconfig.server.json** の include:
```json
{
  "include": [
    "server.ts",
    "src/lib/env.ts",
    "src/lib/auth.ts",
    "src/lib/ws-server.ts",
    ...
  ]
}
```

ws-server.tsが`import { ... } from './ip-restriction'`を行う際、ip-restriction.tsがincludeリストにないとTypeScriptコンパイラが型情報を解決できない。

**必要な変更**:
```json
"include": [
  ...,
  "src/lib/ip-restriction.ts"  // 追加必須
]
```

### 4.3 npx tsc --noEmit への影響

tsconfig.json（メインの型チェック用）は`"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`でglobパターンを使用しているため、新規ファイルは自動的に含まれる。ip-restriction.tsがEdge Runtime互換であり、Node.js固有のモジュールをimportしない限り、型チェックは通過する。

**結論**: 型チェックへの影響なし（ip-restriction.tsがEdge Runtime制約を遵守する限り）。

---

## 5. 環境変数設定の影響

### 5.1 env-setup.ts への影響

`/Users/maenokota/share/work/github_kewton/commandmate-issue-332/src/cli/utils/env-setup.ts` のEnvSetup.createEnvFile()はEnvConfig型に基づいて.envファイルを生成する。EnvConfig型（cli/types/index.ts L142-149）にはCM_ALLOWED_IPS/CM_TRUST_PROXYは含まれていない。

**init.tsの影響**: createDefaultConfig()とpromptForConfig()はEnvConfigの範囲内で動作するため、.envファイルにCM_ALLOWED_IPS/CM_TRUST_PROXYは自動追加されない。ユーザーが手動で.envに追加するか、CLIの`--allowed-ips`/`--trust-proxy`オプションで指定する設計は適切。

### 5.2 ENV_MAPPINGへの追加不要性

ENV_MAPPING（env.ts L24-33）はレガシー名（MCBD_*）からの移行支援用。CM_ALLOWED_IPS/CM_TRUST_PROXYは新規環境変数であり旧名が存在しないため、ENV_MAPPINGへの追加は不要。env.test.tsのENV_MAPPINGテスト（L215: 7個のキー）にも影響しない。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| ビルドエラー | tsconfig.server.jsonにip-restriction.ts未追加でbuild:serverが失敗 | High | High | P1 |
| テスト不安定 | vi.resetModules()とfail-fastの干渉でテストクラッシュ | Medium | Medium | P1 |
| テスト漏れ | daemon.test.tsでCM_ALLOWED_IPS/CM_TRUST_PROXYの転送テスト不足 | Low | Medium | P2 |
| 影響見積もり誤差 | init.ts/status.tsの変更要否が不明確 | Low | Low | P3 |
| リグレッション | CM_ALLOWED_IPS未設定時の既存動作への影響 | High | Low | P3 |

---

## 改善勧告

### Must Fix (2件)

**S3-001**: ip-restriction.tsのfail-fast設計とvi.resetModules()パターンの干渉に関するテスト設計ガイドラインをSection 7.2に追加する。

**S3-002**: tsconfig.server.jsonのincludeリストにsrc/lib/ip-restriction.tsを追加し、Section 11の影響範囲サマリーを19ファイルに更新する。

### Should Fix (4件)

**S3-003**: daemon.test.tsへのCM_ALLOWED_IPS/CM_TRUST_PROXY環境変数クリーンアップと転送テストの追加を推奨。

**S3-004**: Section 11にファイル一覧テーブルを追加し、init.ts/status.tsの変更要否を明確化する。

**S3-005**: server.tsのX-Real-IP注入とWebSocket upgradeのタイミング関係にコメントを追加する。

**S3-006**: CLIビルド互換性に関する注記（ip-restriction.tsをsrc/cli/から直接importしない制約）を追加する。

### Nice to Have (3件)

**S3-007**: createMockRequestヘルパーのIPヘッダーサポート確認（既に対応済みのため変更不要）。

**S3-008**: ENV_MAPPINGへのCM_ALLOWED_IPS/CM_TRUST_PROXY非追加の根拠を明記する。

**S3-009**: login/route.tsのper-IP rate limitingを別Issueとして追跡する旨を明記する。

---

## 承認ステータス

**conditionally_approved** -- Must Fix 2件の対応を条件に承認。設計方針書の影響範囲分析は大筋で正確であり、後方互換性の確保とリグレッションリスクの低減が適切に設計されている。ビルド設定の補完とテスト設計の精緻化により、安全な実装が可能。

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-02-22*
*Stage: 3 (Impact Analysis)*
*Issue: #332*
