# Issue #332 セキュリティレビュー (Stage 4)

**対象**: アクセス元IP制限オプション 設計方針書
**レビュー日**: 2026-02-22
**ステージ**: Stage 4 - セキュリティレビュー（OWASP Top 10準拠・攻撃ベクター分析）
**ステータス**: conditionally_approved
**スコア**: 4/5

---

## Executive Summary

Issue #332の設計方針書について、OWASP Top 10カテゴリに基づくセキュリティレビューを実施した。設計は多層防御（defense-in-depth）の原則に忠実であり、以下の点で堅実なセキュリティ設計が確認された。

**評価できる点**:
- CM_TRUST_PROXY=false時のX-Real-IPヘッダー強制上書きによるIPスプーフィング防止
- CIDRパース不正時のfail-fast（起動中断）設計
- 403レスポンスボディなしによる情報漏洩防止
- WebSocketとHTTPの両レイヤーでの独立したIP制限チェック（defense-in-depth）
- IP制限を認証チェックより先に配置する設計（最前段での遮断）

**改善が必要な点**:
- X-Forwarded-Forの先頭IP抽出ロジックの仕様不明確さ
- CIDRエントリ数の上限未定義によるDoSリスク
- CM_TRUST_PROXY=true環境でのWebSocket二重チェック時のIP不整合可能性

---

## OWASP Top 10 チェックリスト

| OWASP カテゴリ | 評価 | 備考 |
|---------------|------|------|
| A01: Broken Access Control | 要改善 | X-Forwarded-For解析、WebSocket二重チェック不整合 |
| A02: Cryptographic Failures | 該当なし | IP制限機能は暗号処理を含まない |
| A03: Injection | 良好 | 正規表現ReDoSリスク低、シェルインジェクション対策確認 |
| A04: Insecure Design | 良好 | defense-in-depth、fail-fast設計 |
| A05: Security Misconfiguration | 要改善 | CIDRエントリ上限未定義、CM_TRUST_PROXYの厳密性 |
| A06: Vulnerable Components | 良好 | 外部ライブラリ依存なし（自前CIDR実装） |
| A07: Identification and Authentication Failures | 良好 | IP制限と認証のAND条件は適切 |
| A08: Software and Data Integrity Failures | 良好 | モジュールスコープキャッシュは起動時のみ |
| A09: Security Logging and Monitoring | 要改善 | ログ出力IPの正規化・長さ検証 |
| A10: Server-Side Request Forgery | 該当なし | IP制限機能はSSRFに関連しない |

---

## 詳細レビュー結果

### 1. IPスプーフィング攻撃

#### 1.1 X-Real-IPヘッダーの偽造攻撃への耐性

**評価**: 良好

設計書のserver.ts X-Real-IPヘッダー注入ロジックは堅実である。

```typescript
// CM_TRUST_PROXY=falseの場合、偽のX-Real-IPヘッダーを常に上書き
if (process.env.CM_TRUST_PROXY !== 'true') {
  req.headers['x-real-ip'] = clientIp;  // socket.remoteAddressで強制上書き
}
```

CM_TRUST_PROXY=false（デフォルト）時は、攻撃者がX-Real-IPヘッダーを偽装しても`req.socket.remoteAddress`で上書きされるため、スプーフィング攻撃は成立しない。既存のlogin/route.ts L22-33の設計判断（H2 fix）との整合性も確認済み。

#### 1.2 X-Forwarded-Forヘッダーのスプーフィング [S4-001 Must Fix]

**評価**: 要改善

CM_TRUST_PROXY=true時に「X-Forwarded-Forの先頭IPを使用」する設計だが、先頭IP（leftmost）の選択には前提条件がある。

**攻撃シナリオ**:
```
攻撃者 → プロキシ
X-Forwarded-For: 192.168.1.1  (攻撃者が偽装)

プロキシ → サーバー
X-Forwarded-For: 192.168.1.1, 10.0.0.50  (プロキシが実IPを追記)
```

この場合、先頭IP `192.168.1.1` は攻撃者の偽装値であり、実際のクライアントIPは `10.0.0.50` である。先頭IPの使用が安全なのは、リバースプロキシがX-Forwarded-Forヘッダーを上書き（クライアントの値を破棄）する場合のみ。

#### 1.3 WebSocket upgradeリクエストでのIP偽造可能性

**評価**: 良好

ws-server.tsでは`request.socket.remoteAddress`を直接使用しており、HTTPヘッダーに依存しない。これはWebSocketにおけるIPスプーフィング耐性として適切。

### 2. CIDR解析の安全性

#### 2.1 悪意のある入力（CM_ALLOWED_IPS）でのインジェクション攻撃

**評価**: 良好

parseAllowedIps()はfail-fast設計であり、不正なCIDR形式が含まれる場合はErrorをスローしてサーバー起動を中断する。カンマ区切りでの分割後、各エントリに対して正規表現マッチングを行う設計は、インジェクション攻撃に対して安全。

#### 2.2 非常に大きなCIDRリスト（DoS攻撃）への対策 [S4-002 Must Fix]

**評価**: 要改善

CIDRエントリの最大数が未定義。数千件のエントリは以下の影響をもたらす:
- **起動時**: parseAllowedIps()のパース処理時間増加
- **リクエスト毎**: isIpAllowed()のOR判定ループ（O(n)）によるレスポンスタイム悪化

#### 2.3 正規表現のReDoS（Catastrophic Backtracking）リスク [S4-005 Should Fix]

**評価**: 良好（軽微な改善推奨）

定義されている正規表現パターン:
```
IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
IPV4_CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/
```

両パターンはアンカー（`^...$`）と固定長量指定子（`{1,3}`、`{1,2}`）を使用しており、ReDoSリスクは極めて低い。ただし、正規表現適用前の入力長チェックが未設計。

### 3. 認証バイパス

#### 3.1 IP制限とトークン認証の組み合わせによる認証バイパスの可能性

**評価**: 良好

設計書では「IP制限と認証は独立して並列に動作（AND条件）」と明記されており、middleware.tsでは:
1. Step 1: IP制限チェック（全リクエスト）
2. Step 2-6: 既存認証処理

この順序により、IP制限を通過した後にさらに認証チェックが行われる。IP制限の通過のみでは認証をバイパスできない。

#### 3.2 AUTH_EXCLUDED_PATHSとIP制限の相互作用 [S4-003 Should Fix]

**評価**: 良好（文書化推奨）

IP制限がmiddleware.tsの最前段（Step 1）に配置されるため、AUTH_EXCLUDED_PATHS（/login等）への到達にもIP制限の通過が必要。これは正しい設計だが、この相互作用の明文化が不足。

### 4. 情報漏洩

#### 4.1 403レスポンスからの情報漏洩

**評価**: 良好

- HTTP: `new NextResponse(null, { status: 403 })` -- ボディなし
- WebSocket: `socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')` -- ボディなし
- CIDR設定値はレスポンスに含まれない

攻撃者はステータスコード（403 vs 401）からIP制限の存在を推測可能だが、設定の詳細は漏洩しない。

#### 4.2 セキュリティログへの機密情報記録 [S4-004 Should Fix]

**評価**: 要改善

ログ出力 `console.warn('[IP-RESTRICTION] Denied: ${clientIp || \"unknown\"}')` について:
- クライアントIPのみ出力（CIDR設定値は非出力）は適切
- ただし、clientIpの正規化（IPv4-mapped IPv6対応）とログインジェクション対策（IP長さ検証）が未設計

### 5. Edge Runtime固有のセキュリティリスク

#### 5.1 モジュールスコープ変数のテナント間共有 [S4-009 Nice to Have]

**評価**: 現状問題なし

CommandMateは自前サーバー（server.ts）で単一テナント運用するため、モジュールスコープ変数（allowedIpsEnv、cachedRanges）のテナント間共有リスクは実質的に存在しない。サーバーレスプラットフォームへのデプロイは想定外。

### 6. CLI側のセキュリティ

#### 6.1 --allowed-ipsオプションへのシェルインジェクション [S4-008 Nice to Have]

**評価**: 良好（将来リスク注記）

commanderライブラリ経由の引数受け取り → process.env代入は安全。ただし、将来.envファイルへの書き込み機能追加時にはファイルインジェクションリスクに注意。

#### 6.2 CM_TRUST_PROXY環境変数の取り扱い [S4-006 Should Fix]

**評価**: 要改善

`'true'` のみを有効値とする厳密な比較は安全側に倒れるが、`'TRUE'`や`'1'`を設定した運用者が意図しない動作（プロキシ非信頼）に気づかないリスクがある。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| アクセス制御 | X-Forwarded-For先頭IP偽装によるIP制限バイパス | High | Medium（CM_TRUST_PROXY=true時のみ） | P1 |
| DoS | CIDRエントリ数過大によるパフォーマンス劣化 | Medium | Low（管理者のみ設定可能） | P1 |
| 設定ミス | CM_TRUST_PROXYの大文字小文字誤りによる意図しない動作 | Medium | Medium | P2 |
| ログインジェクション | 偽装IPによるログ汚染 | Low | Low | P2 |
| WebSocket不整合 | defense-in-depth二重チェックでの異なるIP判定 | Medium | Low（プロキシ環境のみ） | P2 |

---

## 改善勧告

### 必須改善項目 (Must Fix) - 2件

#### S4-001: X-Forwarded-Forヘッダーの先頭IP抽出に対する信頼チェーン不備

- **OWASP**: A01:2021-Broken Access Control
- **対象**: `src/lib/ip-restriction.ts` getClientIp()、ドキュメント
- **対応**: getClientIp()のJSDocにleftmost IP使用の前提条件を明記。CM_TRUST_PROXYのドキュメントにリバースプロキシの構成要件を記載。

#### S4-002: CM_ALLOWED_IPSのCIDRエントリ数上限が未定義

- **OWASP**: A05:2021-Security Misconfiguration
- **対象**: `src/lib/ip-restriction.ts` parseAllowedIps()
- **対応**: MAX_ALLOWED_IP_ENTRIES定数（100または256）を追加し、超過時はfail-fast。

### 推奨改善項目 (Should Fix) - 5件

#### S4-003: AUTH_EXCLUDED_PATHSへのIP制限適用順序の明確化

- **OWASP**: A01:2021-Broken Access Control
- **対応**: 設計書Section 5にIP制限と認証の評価順序と相互作用を明記。

#### S4-004: IP制限拒否ログのクライアントIP出力における正規化の欠如

- **OWASP**: A09:2021-Security Logging and Monitoring Failures
- **対応**: ログ出力前にnormalizeIp()適用と長さ検証（45文字上限）を追加。

#### S4-005: IPV4_PATTERN/IPV4_CIDR_PATTERNのReDoSリスク評価

- **OWASP**: A03:2021-Injection
- **対応**: 正規表現適用前にエントリ長上限チェック（MAX_CIDR_ENTRY_LENGTH = 18）を追加。

#### S4-006: CM_TRUST_PROXY環境変数のブール値パースの厳密性不足

- **OWASP**: A07:2021-Identification and Authentication Failures
- **対応**: 'true'以外の非空値が設定された場合にconsole.warnで警告を出力。

#### S4-007: WebSocket upgradeリクエストにおけるdefense-in-depth二重チェックの潜在的不整合

- **OWASP**: A01:2021-Broken Access Control
- **対応**: CM_TRUST_PROXY=true環境でのWebSocket IP判定の不整合をドキュメントに明記。

### 検討事項 (Nice to Have) - 4件

#### S4-008: CLIの--allowed-ipsオプションに対するシェルインジェクション耐性

- 現時点で問題なし。将来.envファイル書き込み機能追加時に注意。

#### S4-009: Edge Runtimeにおけるモジュールスコープ変数の共有リスクの明確化

- 自前サーバー運用前提のため現在リスクなし。サーバーレスデプロイは想定外の旨を注記。

#### S4-010: 403レスポンスのHTTPレスポンスボディ一貫性

- 現行設計（IP制限=403、認証失敗=401、ボディなし）は適切。変更不要。

#### S4-011: 0.0.0.0/0 CIDRの設定に対する警告メッセージ

- /0プレフィックスのCIDR検出時に警告出力を推奨。

---

## 実装チェックリスト（Stage 4追加分）

### Must Fix

- [ ] **[S4-001]** getClientIp()のJSDocにX-Forwarded-For leftmost IP使用の前提条件を明記
- [ ] **[S4-001]** CM_TRUST_PROXYのドキュメント（.env.example、README.md）にリバースプロキシの構成要件を記載
- [ ] **[S4-002]** parseAllowedIps()にMAX_ALLOWED_IP_ENTRIES定数（例: 256）を追加し、超過時にErrorをスロー

### Should Fix

- [ ] **[S4-003]** 設計書Section 5にIP制限とAUTH_EXCLUDED_PATHSの相互作用を明記
- [ ] **[S4-004]** middleware.tsのIP制限拒否ログでnormalizeIp()を適用し、IP長さを45文字に制限
- [ ] **[S4-005]** parseAllowedIps()内で各エントリの長さを18文字以内に制限（IPv4 CIDRの最大長）
- [ ] **[S4-006]** server.tsまたはip-restriction.tsでCM_TRUST_PROXYの非空・非'true'・非'false'値に対するconsole.warn出力
- [ ] **[S4-007]** 設計書Section 5.1にCM_TRUST_PROXY=true環境でのWebSocket IP判定の注意事項を追記

### Nice to Have

- [ ] **[S4-008]** 将来.envファイル書き込み時の入力値サニタイズ（改行・クォート・コメント文字の排除）
- [ ] **[S4-009]** モジュールスコープキャッシュの単一テナント運用前提の注記
- [ ] **[S4-010]** （変更不要 - 現行設計維持を推奨）
- [ ] **[S4-011]** 0.0.0.0/0 CIDR検出時の警告メッセージ出力

---

*Generated by architecture-review-agent for Issue #332 Stage 4*
*Date: 2026-02-22*
