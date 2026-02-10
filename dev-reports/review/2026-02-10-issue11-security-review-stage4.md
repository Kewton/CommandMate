# Architecture Review Report: Issue #11 - Security Review (Stage 4)

**Issue**: #11 - バグ原因調査目的のデータ収集機能強化
**Focus Area**: セキュリティ (Security)
**Stage**: 4 (セキュリティレビュー)
**Date**: 2026-02-10
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

Issue #11 の設計方針書に対するセキュリティレビューを実施した。設計方針書はサーバーサイドサニタイズ、パストラバーサル防止、既存セキュリティ機構との共存について適切に考慮されている。しかし、OWASP Top 10 の観点から **2つの必須改善項目** を特定した。

1. **LogViewer.tsx の XSS リスク (S4-MF-001)**: `dangerouslySetInnerHTML` で挿入される検索ハイライト済みコンテンツが HTML エスケープされていない。Issue #11 のエクスポートボタン追加に際し、この既存脆弱性を認識し対処が必要。
2. **機密データパターンのサニタイズ不足 (S4-MF-002)**: エクスポート用サニタイズがパスとホスト名のみを対象としており、会話ログ内のトークン、パスワード、SSH鍵等の機密データパターンが未対応。

全体として、設計の方向性は堅実であり、上記2点を反映すれば承認可能な品質に達する。

---

## OWASP Top 10 Checklist

### A01:2021 - Broken Access Control

**評価: Acceptable**

| チェック項目 | 状態 | 備考 |
|-------------|------|------|
| パストラバーサル防止 | OK | route.ts で `..`, `/`, `\` を検証済み。`.md` 拡張子と worktreeId プレフィクス検証も実装済み |
| ディレクトリリスティング制限 | OK | listLogs() は worktreeId プレフィクスでフィルタリング |
| API アクセス制御 | N/A | ローカルツール（127.0.0.1 バインド）のため意図的にスコープ外 |
| sanitize パラメータのデフォルト挙動 | 要注記 | デフォルト非サニタイズは意図的だが設計方針書に明記が必要 (S4-SF-002) |

**既存実装の確認結果**:
```typescript
// src/app/api/worktrees/[id]/logs/[filename]/route.ts (lines 36-49)
// パストラバーサル検証が適切に実装されている
if (!filename.endsWith('.md') || !filename.startsWith(`${params.id}-`)) {
  return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
}
if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
  return NextResponse.json({ error: 'Invalid filename: path traversal not allowed' }, { status: 400 });
}
```

### A02:2021 - Cryptographic Failures / Sensitive Data Exposure

**評価: Needs Improvement**

| チェック項目 | 状態 | 備考 |
|-------------|------|------|
| パス情報のマスキング | OK | HOME, CM_ROOT_DIR, CM_DB_PATH をマスキング |
| ホスト名のマスキング | OK | os.hostname() で検出してマスキング |
| トークン/パスワードのマスキング | NG | 会話ログ内の機密データパターンが未対応 (S4-MF-002) |
| IP アドレスのマスキング | 未対応 | 初期スコープとしては許容するが注記が必要 (S4-SF-004) |
| サニタイズのサーバーサイド実行 | OK | getEnv() がサーバー専用のため適切な判断 |

**問題箇所**: 設計方針書 Section 3-2 の `buildSanitizeRules()` は4パターン（HOME, CM_ROOT_DIR, CM_DB_PATH, hostname）のみ。既存の `logger.ts` には以下の SENSITIVE_PATTERNS が存在するが、エクスポート用サニタイズには未反映:

```typescript
// src/lib/logger.ts (lines 75-87) - これらがエクスポートサニタイズに未適用
const SENSITIVE_PATTERNS = [
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /(password|passwd|pwd)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { pattern: /(token|secret|api_key|apikey|auth)[=:]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  { pattern: /Authorization:\s*\S+/gi, replacement: 'Authorization: [REDACTED]' },
  { pattern: /-----BEGIN\s+\w+\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+\w+\s+PRIVATE\s+KEY-----/g, replacement: '[SSH_KEY_REDACTED]' },
];
```

### A03:2021 - Injection (XSS)

**評価: Needs Improvement**

| チェック項目 | 状態 | 備考 |
|-------------|------|------|
| DOMPurify による XSS 防止 | OK | sanitize.ts で TerminalDisplay 等に適用済み |
| LogViewer highlight の HTML エスケープ | NG | dangerouslySetInnerHTML に未エスケープコンテンツが渡る (S4-MF-001) |
| CSP ヘッダー | 部分的 | 設定済みだが unsafe-inline/unsafe-eval が残存 |

**問題箇所**: `LogViewer.tsx` の line 143-151:

```typescript
// src/components/worktree/LogViewer.tsx (lines 143-151)
// matchText はファイルコンテンツ由来であり、HTMLエスケープされていない
matches.forEach((match, idx) => {
  result += fileContent.substring(lastIndex, match.index);  // 未エスケープ
  const matchText = fileContent.substring(match.index, match.index + match.length);  // 未エスケープ
  result += `<mark class="..." data-match-index="${idx}">${matchText}</mark>`;  // XSSリスク
  lastIndex = match.index + match.length;
});
result += fileContent.substring(lastIndex);  // 未エスケープ
```

このコンテンツが line 350 で `dangerouslySetInnerHTML={{ __html: highlightedContent || '' }}` として挿入される。

### A04:2021 - Insecure Design

**評価: Pass**

- サニタイズのサーバーサイド実行は適切
- ルールベースの拡張可能な設計で将来の対象追加に対応
- 既存セキュリティ機構（logger.ts SENSITIVE_PATTERNS、sanitize.ts DOMPurify）との役割分担が明確
- 最長一致優先のソートで二重置換を防止

### A05:2021 - Security Misconfiguration

**評価: Acceptable**

| チェック項目 | 状態 | 備考 |
|-------------|------|------|
| withLogging() の環境制御 | OK | NODE_ENV === 'development' でのみ有効 |
| レスポンスボディの制限 | OK | 1KB でトランケート |
| エラーメッセージの情報漏洩 | 軽微 | params.id がエラーメッセージに含まれる (S4-SF-003) |
| セキュリティヘッダー | OK | X-Frame-Options, CSP 等が設定済み |

### A06:2021 - Vulnerable and Outdated Components

**評価: Pass**

- Issue #11 で外部依存の追加なし
- 既存の DOMPurify、better-sqlite3 等には変更なし
- os モジュール（Node.js 標準）のみ新規使用

### A07:2021 - Identification and Authentication Failures

**評価: Not Applicable**

- ローカル開発ツールとして認証は意図的にスコープ外
- `CM_BIND` デフォルト `127.0.0.1` でリモートアクセスを制限
- 将来の共有利用時には認証導入が必要 (S4-C-001)

### A08:2021 - Software and Data Integrity Failures

**評価: Pass**

- サニタイズは読み取り専用操作（元のログファイルは変更されない）
- withLogging() もリードオンリー（response.clone() で非破壊的に読み取り）
- ログファイルの改竄検知は本ツールのスコープ外

### A09:2021 - Security Logging and Monitoring Failures

**評価: Acceptable**

- withLogging() の導入で API 監視が改善される
- createLogger() 経由で SENSITIVE_PATTERNS が自動適用
- レスポンスボディの機密データ完全マスキングは保証されない (S4-SF-001)
- セキュリティログ（security-logger.ts）は CLI 操作に限定

### A10:2021 - Server-Side Request Forgery (SSRF)

**評価: Not Applicable**

- Issue #11 の変更にサーバーサイドの HTTP リクエスト送信は含まれない

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| XSS | LogViewer.tsx の dangerouslySetInnerHTML に未エスケープコンテンツ | High | Medium | P1 |
| 機密データ漏洩 | エクスポート時にトークン/パスワード等が未マスキング | High | Medium | P1 |
| 情報漏洩 | withLogging() レスポンスボディ内の機密データ | Medium | Low | P2 |
| 情報漏洩 | IP アドレスがサニタイズ対象外 | Medium | Low | P2 |
| 情報漏洩 | sanitize パラメータなしで生データ取得可能 | Low | Low | P3 |
| 情報漏洩 | エラーメッセージに内部 ID 含む | Low | Low | P3 |

---

## Detailed Findings

### Must Fix (P1)

#### S4-MF-001: LogViewer.tsx の dangerouslySetInnerHTML による XSS リスク

**OWASP カテゴリ**: A03:2021 - Injection (XSS)
**影響度**: High
**対象ファイル**: `src/components/worktree/LogViewer.tsx` (lines 135-159, 348-351)

LogViewer.tsx の検索ハイライト機能は、ファイルコンテンツを正規表現で分割し `<mark>` タグでラップして `dangerouslySetInnerHTML` で DOM に挿入している。問題は、`matchText` および非マッチ部分の `fileContent.substring()` 結果に HTML エスケープが適用されていないことである。

会話ログファイルにはユーザー入力と AI の応答が含まれており、HTML タグやスクリプトタグが含まれる可能性がある（例：ユーザーが HTML コードについて質問した場合）。

**推奨対応**:
- highlightedContent 構築時に、`<mark>` タグの外側の全テキスト部分に HTML エスケープ（`<`, `>`, `&`, `"`, `'` の変換）を適用する
- 設計方針書の T5（LogViewer.tsx 修正）のチェックリストに「highlightedContent 構築時の HTML エスケープ適用」を追加する
- 既存の `sanitize.ts` の DOMPurify を使用するか、シンプルなエスケープユーティリティ関数を導入する

#### S4-MF-002: エクスポート用サニタイズにおける機密データパターンの不足

**OWASP カテゴリ**: A02:2021 - Cryptographic Failures / Sensitive Data Exposure
**影響度**: High
**対象ファイル**: 設計方針書 Section 3-2 (`log-export-sanitizer.ts` 設計)

現在のサニタイズルールは HOME、CM_ROOT_DIR、CM_DB_PATH、ホスト名の4パターンのみ。しかし、エクスポートの主目的が「バグ報告のための外部共有」であることを考えると、会話ログ内に含まれる可能性のある以下の機密データもマスキング対象とすべきである:

- Bearer トークン
- password/token/secret/api_key 等のキーバリューペア
- Authorization ヘッダー
- SSH 秘密鍵

これらのパターンは既に `logger.ts` の `SENSITIVE_PATTERNS` として定義されている。

**推奨対応**:
- `log-export-sanitizer.ts` の `buildSanitizeRules()` に `logger.ts` の SENSITIVE_PATTERNS と同等のルールを追加する
- 設計方針書 Section 3-2 と Section 6-1 にこれらのルール追加を明記する
- テストケース（Section 9）にトークン/パスワードのマスキングテストを追加する
- SENSITIVE_PATTERNS の共通化（共通モジュール抽出）は将来的な改善として検討する

---

### Should Fix (P2)

#### S4-SF-001: withLogging() のレスポンスボディログ出力における機密データ漏洩リスク

**OWASP カテゴリ**: A09:2021 - Security Logging and Monitoring Failures
**影響度**: Medium

withLogging() はレスポンスボディを最大 1KB までログに出力する。ログファイル取得 API（`logs/[filename]/route.ts`）のレスポンスにはファイルコンテンツ全体が含まれるため、1KB 分のログファイル内容（機密情報を含む可能性あり）がコンソールに出力される。

**推奨対応**:
- `WithLoggingOptions` に `skipResponseBody?: boolean` オプションを追加する
- ファイルコンテンツを返す API では `skipResponseBody: true` を指定する
- 設計方針書 Section 3-1 に該当オプションの記載を追加する

#### S4-SF-002: sanitize パラメータのデフォルト非サニタイズの明示化

**OWASP カテゴリ**: A01:2021 - Broken Access Control
**影響度**: Low

**推奨対応**:
- 設計方針書 Section 6-1 に「デフォルト（sanitize パラメータなし）では非サニタイズの生データを返す仕様は意図的であり、LogViewer.tsx の通常表示に生データが必要なため」と明記する

#### S4-SF-003: エラーレスポンスにおける内部情報漏洩

**OWASP カテゴリ**: A05:2021 - Security Misconfiguration
**影響度**: Low

**推奨対応**:
- 設計方針書 Section 5-1 に「エラーメッセージにおける内部情報の取り扱い方針」を注記として追加する

#### S4-SF-004: ホスト名マスキングの網羅性とIPアドレス対応

**OWASP カテゴリ**: A02:2021 - Cryptographic Failures / Sensitive Data Exposure
**影響度**: Medium

**推奨対応**:
- 設計方針書 Section 3-2 または Section 6-1 に、マスキング対象の制約（os.hostname() のみ、IP アドレスは初期スコープ外）を明記する

---

### Consider (P3)

#### S4-C-001: 認証/認可メカニズムの不在

ローカルツールとしてのスコープ前提を設計方針書に明記する。将来の共有利用時の認証導入を検討事項として記録する。

#### S4-C-002: response.clone() によるメモリ使用量の二重化

大きなレスポンスを返す API での withLogging() の影響。開発環境限定のため緊急性は低い。

#### S4-C-003: CSP ポリシーにおける unsafe-inline / unsafe-eval

本 Issue のスコープ外。将来的な nonce ベース CSP への移行を検討。

#### S4-C-004: サニタイズルールの正規表現 ReDoS リスク

現状の設計では環境変数値からの正規表現構築のため ReDoS リスクは低い。追加対策不要。

---

## Existing Security Mechanisms Verification

Issue #11 の変更が既存のセキュリティ機構に悪影響を与えないことを確認した。

| 既存機構 | ファイル | 影響 | 確認結果 |
|---------|---------|------|---------|
| SENSITIVE_PATTERNS | `src/lib/logger.ts` | 変更なし | withLogging() が createLogger() 経由で活用。問題なし |
| DOMPurify XSS 防止 | `src/lib/sanitize.ts` | 変更なし | TerminalDisplay 等での利用継続。LogViewer には未適用（S4-MF-001） |
| パストラバーサル検証 | `route.ts` (logs) | 変更なし | 既存の .md/worktreeId プレフィクス/.. 検証は維持 |
| DB パス検証 | `src/lib/db-path-resolver.ts` | 変更なし | SEC-001 のシステムディレクトリ保護は維持 |
| セキュリティヘッダー | `next.config.js` | 変更なし | CSP/X-Frame-Options 等は維持 |
| セキュリティログ | `src/cli/utils/security-logger.ts` | 変更なし | CLI 操作のセキュリティイベントログは維持 |

---

## Recommendations for Design Policy Updates

以下のセクションに追記が必要:

1. **Section 3-2** (サニタイズルール): SENSITIVE_PATTERNS 相当のトークン/パスワード/SSH鍵パターン追加
2. **Section 6-1** (情報漏洩防止テーブル): トークン/パスワード/SSH鍵の行追加、デフォルト非サニタイズの意図的仕様注記
3. **Section 3-1** (WithLoggingOptions): `skipResponseBody` オプションの追加
4. **Section 9** (テストケース): 機密データパターンのマスキングテスト追加
5. **Section 13** (チェックリスト T5): highlightedContent の HTML エスケープ追加

---

## Approval Status

**Status**: conditionally_approved
**Score**: 4/5

**承認条件**:
1. S4-MF-001 (XSS リスク対策) を設計方針書に反映すること
2. S4-MF-002 (機密データパターンのサニタイズ追加) を設計方針書に反映すること

上記2点の反映後、本設計はセキュリティの観点から承認可能である。

---

*Generated by architecture-review-agent (Stage 4: Security Review)*
*Date: 2026-02-10*
