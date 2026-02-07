# Architecture Review: Issue #180 - Stage 2 整合性レビュー

**Review Date**: 2026-02-07
**Issue**: #180 ステータス表示の不整合修正
**Focus Area**: 整合性 (設計書 vs 実コードの一致検証)
**Overall Assessment**: PASS_WITH_FINDINGS

---

## 1. レビュー概要

設計書 `dev-reports/design/issue-180-status-display-inconsistency-design-policy.md` と実際のソースコードを突き合わせ、以下の整合性を検証した。

- コードスニペットの正確性
- 行番号の正確性
- 関数シグネチャの正確性
- 提案されるAfterコードのコンパイル可能性
- importパスの正確性
- インターフェース変更の後方互換性
- 設計判断 (DR-001 -- DR-008) の技術的正確性

---

## 2. 検証対象ファイル

| ファイル | パス | 検証内容 |
|---------|------|---------|
| status-detector.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/status-detector.ts` | インターフェース、関数シグネチャ、内部ロジック |
| route.ts (list) | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/route.ts` | インラインロジックの現状、設計書のBeforeコードとの一致 |
| route.ts (detail) | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/app/api/worktrees/[id]/route.ts` | route.tsとの重複確認 |
| prompt-detector.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/prompt-detector.ts` | 内部ウィンドウイング (slice(-10), slice(-50)) の検証 |
| cli-patterns.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/cli-patterns.ts` | パターン定義の検証 |
| status-detector.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/__tests__/status-detector.test.ts` | 既存テスト構造と後方互換性 |
| claude-poller.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-180/src/lib/claude-poller.ts` | DR-008 到達不能コード主張の検証 |

---

## 3. 検証結果サマリー

### 整合性チェックリスト

| 項目 | 結果 | 詳細 |
|------|------|------|
| コードスニペットの一致 | PARTIAL | Beforeコードは概ね正確。Afterコードに未定義変数 `worktreeId` あり |
| 行番号の正確性 | PARTIAL | status-detector.ts行74-76は正確。route.tsの行56-84は概算 |
| 関数シグネチャの正確性 | FAIL | 型の不一致2件 (C-001, C-002) |
| Afterコードのコンパイル可能性 | PASS | 型修正後はコンパイル可能 |
| importパスの正確性 | PASS | @/lib/status-detector は正しい |
| インターフェース後方互換性 | PASS | フィールド追加のみ、既存テスト影響なし |
| DR-007 レイヤードウィンドウイング | PASS | prompt-detector.ts内部実装と一致 |
| DR-003 空行動作差異 | PASS | 正確に文書化されている |
| DR-008 到達不能コード | PASS | claude-poller.tsのstartPollingは外部未使用 |

---

## 4. 指摘事項

### 4-1. [C-001] must_fix: lastOutputTimestamp型の不一致

**設計書の記述** (Section 5-1, 行193):
```typescript
export function detectSessionStatus(
  output: string,
  cliToolId: string,
  lastOutputTimestamp?: number    // <-- 設計書
): StatusDetectionResult;
```

**実際のコード** (`src/lib/status-detector.ts` 行68-72):
```typescript
export function detectSessionStatus(
  output: string,
  cliToolId: CLIToolType,
  lastOutputTimestamp?: Date      // <-- 実コード
): StatusDetectionResult {
```

**影響**: 設計書のシグネチャを忠実に実装すると、status-detector.ts内部の `lastOutputTimestamp.getTime()` 呼び出し (行113) が `number` 型に対して不正となりコンパイルエラーが発生する。

**対応**: 設計書を `lastOutputTimestamp?: Date` に修正する。

---

### 4-2. [C-002] must_fix: cliToolId型の不一致

**設計書の記述** (Section 5-1, 行193):
```typescript
cliToolId: string,
```

**実際のコード** (`src/lib/status-detector.ts` 行70):
```typescript
cliToolId: CLIToolType,
```

**影響**: `CLIToolType` は `'claude' | 'codex' | 'gemini'` のユニオン型であり、`string` 型からの暗黙変換はTypeScriptでは許容されない。route.tsの呼び出し側で `cliToolId` は `CLIToolType` 型として宣言されているため実装上は問題ないが、設計書がシグネチャを `string` と記述していることは不正確。

**対応**: 設計書を `cliToolId: CLIToolType` に修正する。

---

### 4-3. [C-003] should_fix: 行番号参照の概算値

**設計書の記述** (Section 5-2, 行246):
> 行56-84のインラインステータス検出ロジック全体

**実際のコード**: route.tsのステータス検出+クリーンアップロジックは行56-99に及ぶ。行84はelseブロックの閉じ括弧であり、行86-95のstale prompt cleanupは論理的に同一ブロック内。

**対応**: 行番号を「行56-95」に修正するか、コードブロックの論理的境界で記述する。

---

### 4-4. [C-004] should_fix: Afterコードの条件等価性の未説明

**設計書のAfterコード** (Section 5-2, 行273):
```typescript
if (!statusResult.hasActivePrompt) {
```

**現行route.ts** (行87):
```typescript
if (!promptDetection.isPrompt) {
```

これらは論理的に等価であるが（`hasActivePrompt: true` は `detectPrompt().isPrompt === true` のときのみ設定されるため）、この等価性についての明示的な説明が設計書にない。将来 `detectSessionStatus()` が `hasActivePrompt` の設定条件を変更した場合に動作差異が生じるリスクがある。

**対応**: 等価性についてのコメントまたは注記を設計書に追加する。

---

### 4-5. [C-005] nice_to_have: Afterコードの変数名 worktreeId が未定義

**設計書のAfterコード** (Section 3, 行122 / Section 5-2, 行274):
```typescript
const messages = getMessages(db, worktreeId, undefined, 10, cliToolId);
// ...
markPendingPromptsAsAnswered(db, worktreeId, cliToolId);
```

**実際のroute.ts** (行88, 93):
```typescript
const messages = getMessages(db, worktree.id, undefined, 10, cliToolId);
// ...
markPendingPromptsAsAnswered(db, worktree.id, cliToolId);
```

**実際の[id]/route.ts** (行88, 93):
```typescript
const messages = getMessages(db, params.id, undefined, 10, cliToolId);
// ...
markPendingPromptsAsAnswered(db, params.id, cliToolId);
```

`worktreeId` はどちらのroute.tsにも変数として定義されていない。

**対応**: Afterコード例で適切な変数名に変更するか、疑似コードであることを明記する。

---

### 4-6. [C-006] nice_to_have: StatusDetectionResult後方互換性確認

`StatusDetectionResult` に `hasActivePrompt: boolean` を追加する変更は後方互換。既存テスト (`src/lib/__tests__/status-detector.test.ts`) では `result.status`, `result.confidence`, `result.reason` のみを検証しており、新フィールドの存在はテストを壊さない。設計書 Section 8-2 のテスト項目6で新フィールドの検証が計画されている。

**対応**: 確認事項のみ。追加テストで新フィールドの検証を確実にカバーすること。

---

## 5. 検証詳細

### 5-1. route.ts と [id]/route.ts のインラインロジック重複確認

両ファイルのステータス検出ロジック (行56-95) を比較した結果、以下の差異を除き完全に同一であることを確認した:

| 箇所 | route.ts | [id]/route.ts |
|------|----------|---------------|
| worktree ID参照 | `worktree.id` | `params.id` |
| セッション出力キャプチャ | `captureSessionOutput(worktree.id, ...)` | `captureSessionOutput(params.id, ...)` |

設計書の「route.ts x2で完全重複」という記述は正確である。

### 5-2. detectPrompt() 内部ウィンドウイング検証 (DR-007)

`src/lib/prompt-detector.ts` の実装を確認:

- **行48**: `const lastLines = lines.slice(-10).join('\n');` -- y/nパターン (Pattern 1-5) に適用
- **行56**: `detectMultipleChoicePrompt(output)` -- 元の `output` 引数をそのまま渡す
- **行268**: `const scanStart = Math.max(0, lines.length - 50);` -- multiple choiceの内部ウィンドウ

`detectSessionStatus()` が15行を `detectPrompt()` に渡した場合:
- y/n: min(10, 15) = 10行 -- DR-007と一致
- multiple choice: min(50, 15) = 15行 -- DR-007と一致

### 5-3. DR-008 到達不能コード検証

`claude-poller.ts` の `startPolling()` 関数 (行324) のエクスポートを確認。プロジェクト全体を検索した結果:

- `claude-poller.ts` の `startPolling` を import している箇所: **0件**
- `response-poller.ts` の `startPolling` を import している箇所: 3件 (`send/route.ts`, `respond/route.ts`, `start-polling/route.ts`)

`claude-poller.ts` 内の `detectPrompt()` 呼び出し (行164, 232) は `startPolling()` の実行パス上にあり、外部から呼び出されないため到達不能コードである。DR-008の主張は正確。

### 5-4. 設計書のBeforeコードと実コードの比較

設計書 Section 5-2 のBeforeコード:
```typescript
const promptDetection = detectPrompt(cleanOutput);  // <- 全文を渡す（問題）
```

実際のroute.ts 行62:
```typescript
const promptDetection = detectPrompt(cleanOutput);
```

**一致を確認**。`cleanOutput` は `stripAnsi(output)` の結果であり、行数制限なしの全文が渡されている。これが Issue #180 の根本原因として設計書に正しく記述されている。

---

## 6. リスク評価

| リスク | レベル | 詳細 |
|--------|--------|------|
| 型の不一致によるコンパイルエラー | LOW | 実装時に自然に気づく可能性が高いが、設計書を参照して実装する場合にコピペミスのリスクあり |
| 空行フィルタリング動作変更 | LOW | DR-003で文書化済み。正規表現は行内マッチングのため空行は影響しない |
| hasActivePrompt条件の将来的乖離 | LOW | 現時点では等価。detectSessionStatusの内部変更時に要注意 |
| 全体的なリスク | LOW | 提案される変更は技術的に健全で後方互換性あり |

---

## 7. 結論

設計書は全体として実コードの状態を正確に反映しており、提案される共通化アプローチは技術的に実現可能である。主要な指摘事項は関数シグネチャの型記述不正確 (C-001, C-002) であり、これらは設計書修正で対応可能。提案されるAfterコードは型修正後にコンパイル可能であり、既存テストとの後方互換性も確保されている。

### 対応推奨

| 優先度 | 対応数 | 内容 |
|--------|--------|------|
| must_fix | 2件 | 関数シグネチャの型修正 (Date, CLIToolType) |
| should_fix | 2件 | 行番号修正、条件等価性の明記 |
| nice_to_have | 2件 | 変数名修正、後方互換性確認 |

---

*Generated by architecture-review-agent (Stage 2: 整合性レビュー) on 2026-02-07*
