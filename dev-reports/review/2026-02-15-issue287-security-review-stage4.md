# Security Architecture Review - Issue #287

**Issue**: #287 - 選択肢プロンプト送信のフォールバック不備修正
**Focus**: セキュリティ (Security)
**Stage**: 4 - セキュリティレビュー
**Date**: 2026-02-15
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #287 の設計方針書は、`promptCheck` が `null` になった際のフォールバック機構として、UIから `promptType` / `defaultOptionNumber` をリクエストボディに追加して送信する設計を提案している。セキュリティ観点から、この変更は全体として低リスクである。

主な理由:
- 新規フィールドはフォールバック用途のみで、`promptCheck` が正常に機能する通常パスでは使用されない
- 既存のコマンドインジェクション防止機構（`validateSessionName`, `ALLOWED_SPECIAL_KEYS`, `sendKeys` のクオートエスケープ）が適切に機能している
- 本アプリケーションはローカル実行を前提としており、外部からの攻撃面が限定的

ただし、新規フィールドのランタイムバリデーション追加が必要である（SEC-S4-001: Must Fix 1件）。

---

## OWASP Top 10 Compliance Checklist

### A01:2021 - Broken Access Control

**Status**: PASS

本アプリケーションはローカル実行を前提としており、認証・認可の仕組みは設けていない。`prompt-response` API は worktree ID による存在チェック（`getWorktreeById`）で対象リソースの存在を確認しているが、これは認可ではなくデータ整合性チェックである。本変更はこのアーキテクチャ前提に影響しない。

### A02:2021 - Cryptographic Failures

**Status**: NOT APPLICABLE

本変更では暗号化処理は含まれない。新規フィールド（`promptType`, `defaultOptionNumber`）は機密情報ではなく、暗号化の必要はない。

### A03:2021 - Injection

**Status**: CONDITIONAL PASS (SEC-S4-001 対応必要)

#### 既存の防御機構（良好）

1. **tmux コマンドインジェクション防止**:
   - `validateSessionName()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/cli-tools/validation.ts`) が `SESSION_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/` でセッション名を検証
   - `sendSpecialKeys()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/tmux.ts` L231-235) が `ALLOWED_SPECIAL_KEYS` ホワイトリストでキー名を制限
   - `sendKeys()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/tmux.ts` L207-225) がシングルクオートをエスケープ

2. **SQL インジェクション防止**:
   - `getWorktreeById()` は prepared statement を使用（`/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/db.ts` L288-300）
   - `params.id` が SQL に直接埋め込まれることはない

3. **Auto-Yes Manager のバリデーション**:
   - `isValidWorktreeId()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/lib/auto-yes-manager.ts` L79-80, L122-125) が worktree ID 形式を検証

#### 新規フィールドに関する懸念（SEC-S4-001）

設計方針書 Section 9 では以下のバリデーション方針を記載している:

```
| フィールド | バリデーション | 理由 |
|-----------|-------------|------|
| promptType | 'yes_no' | 'multiple_choice' | undefined のみ許可 | 型安全性 |
| defaultOptionNumber | number | undefined | 数値型の保証 |
```

しかし、TypeScript の型注釈はランタイムでは消失するため、`req.json()` で受け取った `body.promptType` が実際に `'yes_no'` または `'multiple_choice'` であることは保証されない。任意の文字列が送信される可能性がある。

現状の設計では `effectivePromptType` が未知の値の場合、`isClaudeMultiChoice` が `false` に評価されてテキスト送信方式にフォールバックする（安全側動作）。この設計は Section 4 の C-S2-001 で明記されており、安全側に倒す方針は適切である。

ただし、以下の防御的バリデーションを明示的に追加すべきである:

```typescript
// route.ts 内
const validPromptTypes = ['yes_no', 'multiple_choice'] as const;
const promptType = validPromptTypes.includes(body.promptType as typeof validPromptTypes[number])
  ? body.promptType as typeof validPromptTypes[number]
  : undefined;

const defaultOptionNumber = (
  typeof body.defaultOptionNumber === 'number'
  && Number.isInteger(body.defaultOptionNumber)
  && body.defaultOptionNumber > 0
) ? body.defaultOptionNumber : undefined;
```

### A04:2021 - Insecure Design

**Status**: PASS

フォールバック設計は安全側に倒す原則を遵守している:

1. **`promptCheck` 優先**: リアルタイムの画面出力解析結果を優先し、UIから送信された情報はフォールバックのみ
2. **multi-select フォールバック非対応**: `promptCheck === null` 時は single-select として処理（安全側制限、設計方針書 D-6）
3. **`defaultOptionNumber ?? 1`**: 値が未指定時はデフォルト1番を選択（設計方針書 D-5）

### A05:2021 - Security Misconfiguration

**Status**: PASS

新規設定項目なし。既存のセキュリティ設定に影響なし。

### A06:2021 - Vulnerable and Outdated Components

**Status**: PASS

新規依存ライブラリの追加なし。`cursor-key-sender.ts` と `prompt-response-utils.ts` は純粋な TypeScript モジュールで外部依存なし。

### A07:2021 - Identification and Authentication Failures

**Status**: NOT APPLICABLE

ローカル実行アプリケーションのため、認証機能は対象外。

### A08:2021 - Software and Data Integrity Failures

**Status**: PASS

- リクエストボディの JSON パースは Next.js の `req.json()` 経由で安全に処理
- デシリアライゼーション脆弱性のリスクなし
- `buildPromptResponseBody()` はクライアントサイドでリクエストボディを構築するが、セキュリティバリデーションはサーバーサイドの責務

### A09:2021 - Security Logging and Monitoring Failures

**Status**: CONDITIONAL PASS (SEC-S4-003)

- `console.warn('[prompt-response] Failed to verify prompt state, proceeding with send')` のように固定メッセージのログ出力パターンが使用されており良好
- ただし、L44 の `Worktree '${params.id}' not found` でユーザー入力がエラーメッセージに含まれる既存パターンがある
- 新規コードの `sendPromptAnswer()` エラーハンドリングでは固定メッセージパターンを採用すべき

### A10:2021 - Server-Side Request Forgery (SSRF)

**Status**: NOT APPLICABLE

本変更ではサーバーサイドの HTTP リクエスト発行なし。

---

## Detailed Security Analysis

### 1. 入力バリデーションと サニタイゼーション

#### 新規フィールドの攻撃面分析

| フィールド | 型 | 攻撃シナリオ | 影響 | 既存の防御 | 追加防御（SEC-S4-001） |
|-----------|------|-------------|------|-----------|---------------------|
| `promptType` | `string` | 不正な型文字列の注入 | 低: `isClaudeMultiChoice` が false になりテキスト送信にフォールバック | TypeScript の型注釈（ランタイムでは無効） | ホワイトリストバリデーション追加 |
| `defaultOptionNumber` | `number` | 負数/float/NaN の注入 | 低: offset 計算が不正になるが、キー送信数が異常になる可能性 | TypeScript の型注釈（ランタイムでは無効） | Number.isInteger() + 正数チェック追加 |
| `answer` | `string` | 既存フィールド、長大文字列 | 低: tmux sendKeys で処理される | シングルクオートエスケープ | 将来的に長さ制限を検討 |
| `cliTool` | `string` | 既存フィールド | 低: CLIToolManager.getTool() でバリデーション済み | CLI_TOOL_IDS のホワイトリスト | 追加不要 |

#### tmux コマンドインジェクション防止チェーン

```
params.id → getSessionName() → validateSessionName() → SESSION_NAME_PATTERN
                                                         ^
                                                 /^[a-zA-Z0-9_-]+$/

answer → sendKeys() → escapedKeys = keys.replace(/'/g, "'\\''")
                       → tmux send-keys -t "{sessionName}" '{escapedKeys}'

keys[] → sendSpecialKeys() → ALLOWED_SPECIAL_KEYS.has(key)
                              → tmux send-keys -t "{sessionName}" {key}
```

この防御チェーンは Issue #287 の変更で破壊されない。`buildCursorKeys()` は `keys` 配列（`'Up'`, `'Down'`, `'Enter'`, `'Space'` のみ）を構築し、`sendSpecialKeys()` の `ALLOWED_SPECIAL_KEYS` ホワイトリスト検証を通過する。

### 2. 認証と認可

本アプリケーションはローカル実行を前提としており、認証・認可機能はアーキテクチャスコープ外である。Issue #287 の変更はこの前提に影響しない。

### 3. データ露出リスク

#### レスポンスの情報漏洩

```typescript
// 成功時レスポンス
{ "success": true, "answer": "1" }

// 失敗時レスポンス
{ "success": false, "reason": "prompt_no_longer_active", "answer": "1" }
```

`answer` フィールドがレスポンスに含まれるが、これはユーザー自身が送信した値のエコーバックであり、情報漏洩リスクは低い。新規フィールド（`promptType`, `defaultOptionNumber`）はレスポンスに含まれないため、追加の情報漏洩リスクはない。

#### ログ出力の情報漏洩

- `auto-yes-manager.ts` L408: `console.info('[Auto-Yes Poller] Sent response for worktree: ${worktreeId}')` -- 応答内容は含まない（良好）
- `route.ts` L88: `console.warn('[prompt-response] Failed to verify prompt state, proceeding with send')` -- 固定メッセージ（良好）

### 4. 偽装攻撃の分析

設計方針書 Section 9 のリスク分析を検証する:

| リスク | 設計方針書の評価 | レビュー評価 | 補足 |
|-------|-----------------|------------|------|
| `promptType` 偽装 | 低 | 低（妥当） | `promptCheck` 優先により、正常パスでは無視。フォールバック時も安全側に倒す設計。 |
| `defaultOptionNumber` 偽装 | 低 | 低（妥当） | `promptCheck` 優先。フォールバック時も `?? 1` で安全なデフォルト。ただしバウンドチェック追加が望ましい（SEC-S4-C03） |

### 5. セキュリティテスト要件

設計方針書 Section 11 のテスト設計を評価する。

#### 現状のテストカバレッジ（良好）

- テストケース 3 (`promptType` なし + `answer="1"` -> テキスト方式): 後方互換性の安全動作を検証
- テストケース 7 (`promptCheck.promptData.type` と `body.promptType` が異なる場合): `promptCheck` 優先の動作を検証

#### 追加すべきセキュリティテスト

| # | テストケース | 目的 |
|---|------------|------|
| S1 | `promptType` に不正な文字列（例: `"__proto__"`, `"constructor"`)を送信 | プロトタイプ汚染の防止確認 |
| S2 | `defaultOptionNumber` に負数（`-1`）、浮動小数（`1.5`）、NaN を送信 | 数値バリデーションの確認 |
| S3 | `defaultOptionNumber` に極端に大きな値（`999999`）を送信 | offset バウンドの確認 |
| S4 | `promptType` に空文字列 `""` を送信 | 空文字列のハンドリング確認 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| インジェクション | 新規フィールドのランタイムバリデーション不足 | Low | Low | P2 (SEC-S4-001) |
| インジェクション | params.id のエントリーポイントバリデーション | Low | Low | P3 (SEC-S4-002) |
| ログ情報漏洩 | エラーメッセージにユーザー入力を含む | Low | Low | P3 (SEC-S4-003) |
| リソース消費 | answer の長さ制限なし | Low | Very Low | P4 (SEC-S4-C01) |
| リソース消費 | offset のバウンドチェックなし | Low | Very Low | P4 (SEC-S4-C03) |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

#### SEC-S4-001: promptType / defaultOptionNumber のランタイムバリデーション

**対象ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/app/api/worktrees/[id]/prompt-response/route.ts`

設計方針書 Section 9 に記載されたバリデーション方針を、route.ts の POST 関数内でランタイムバリデーションとして実装する必要がある。TypeScript の型注釈はコンパイル時のみ有効であり、ランタイムでは JSON パース結果が任意の値を持ちうる。

実装例:

```typescript
// effectivePromptType 導出前にバリデーション
const validPromptTypes = ['yes_no', 'multiple_choice'] as const;
const bodyPromptType = validPromptTypes.includes(body.promptType as typeof validPromptTypes[number])
  ? (body.promptType as 'yes_no' | 'multiple_choice')
  : undefined;

const bodyDefaultOptionNumber = (
  typeof body.defaultOptionNumber === 'number'
  && Number.isInteger(body.defaultOptionNumber)
  && body.defaultOptionNumber > 0
) ? body.defaultOptionNumber : undefined;

// SF-002: effectivePromptType / effectiveDefaultNum 導出で使用
const effectivePromptType = promptCheck?.promptData?.type ?? bodyPromptType;
const effectiveDefaultNum = promptCheck
  ? (promptCheck.promptData?.options?.find(o => o.isDefault)?.number ?? 1)
  : (bodyDefaultOptionNumber ?? 1);
```

### 推奨改善項目 (Should Fix)

#### SEC-S4-002: route.ts の params.id バリデーション追加

**対象ファイル**: `/Users/maenokota/share/work/github_kewton/commandmate-issue-287/src/app/api/worktrees/[id]/prompt-response/route.ts`

`auto-yes-manager.ts` の `isValidWorktreeId()` と同等のバリデーションを route.ts のエントリーポイントに追加する。これは防御の深化（defense in depth）として望ましい。

#### SEC-S4-003: エラーメッセージからのユーザー入力除去

新規に追加される `sendPromptAnswer()` 関数のエラーハンドリングでは、ユーザー入力を含まない固定メッセージパターンを採用する。

### 検討事項 (Consider)

#### SEC-S4-C01: answer フィールドの長さ制限

将来的に `answer` フィールドに合理的な最大長（例: 1000文字）を設定する。

#### SEC-S4-C02: サーバーサイドバリデーション優先の設計方針確認

`buildPromptResponseBody()` はクライアントサイドに配置されるが、セキュリティバリデーションはサーバーサイドで実行する方針を維持する。

#### SEC-S4-C03: offset のバウンドチェック

`buildCursorKeys()` で生成される keys 配列の最大長を制限する（例: 100要素）。

---

## Security Architecture Assessment

### 既存のセキュリティアーキテクチャとの整合性

Issue #287 の変更は既存のセキュリティアーキテクチャに適合している:

1. **tmux インジェクション防止**: `validateSessionName()`, `ALLOWED_SPECIAL_KEYS`, `sendKeys` のエスケープ処理が適切に機能しており、`buildCursorKeys()` への委譲でこの防御チェーンが維持される
2. **SQL インジェクション防止**: prepared statement のパターンが維持される
3. **安全側フォールバック**: `promptCheck` 優先、未知の `promptType` 時のテキスト送信フォールバック、`defaultOptionNumber ?? 1` のデフォルト値

### セキュリティテスト戦略

設計方針書 Section 11 のテスト設計にセキュリティテストケース（上記 S1-S4）を追加することを推奨する。特に `cursor-key-sender.test.ts` に不正入力のバリデーションテストを含めるべきである。

---

## Approval Status

**Conditionally Approved** -- SEC-S4-001（新規フィールドのランタイムバリデーション追加）を実装時に対応することを条件に承認する。この対応は実装フェーズで容易に組み込める内容であり、設計変更は不要である。

---

*Generated by architecture-review-agent for Issue #287 Stage 4 Security Review*
