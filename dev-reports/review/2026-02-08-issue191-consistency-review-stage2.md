# Architecture Review: Issue #191 - Stage 2 整合性レビュー

## Executive Summary

Issue #191 の設計書「Auto-Yes detectThinking() ウィンドウイング 設計方針書」と実際のコードベースとの整合性レビューを実施した。設計書の品質は全体的に高く、行番号参照、関数シグネチャ、定数名、影響範囲分析のいずれも概ね正確であった。Must Fix 該当の指摘はなく、2件の Should Fix と 3件の Consider を検出した。

**ステータス**: conditionally_approved (4/5)

---

## レビュー対象

| 対象 | パス |
|------|------|
| 設計書 | `dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md` |
| 修正対象 | `src/lib/auto-yes-manager.ts` |
| 参照ファイル | `src/lib/cli-patterns.ts` |
| 参照ファイル | `src/lib/status-detector.ts` |
| 参照ファイル | `src/lib/prompt-detector.ts` |
| 参照ファイル | `src/app/api/worktrees/[id]/current-output/route.ts` |
| 既存テスト | `tests/unit/lib/auto-yes-manager.test.ts` |

---

## 1. 行番号参照の検証

| 設計書の参照 | 実際の行番号 | 結果 |
|-------------|------------|------|
| `auto-yes-manager.ts` L284 (`detectThinking`) | L284 | MATCH |
| `auto-yes-manager.ts` L276-287 (変更範囲) | L276: captureSessionOutput, L279: stripAnsi, L284: detectThinking, L287: return | MATCH |
| `auto-yes-manager.ts` L290 (`detectPrompt`) | L290 | MATCH |
| `status-detector.ts` L99 (`detectThinking`) | L99 | MATCH |
| `status-detector.ts` L83 (split-slice-join) | L83 | MATCH |
| `prompt-detector.ts` L268 (50行ウィンドウ) | L268: `Math.max(0, lines.length - 50)` | PARTIAL MATCH (*1) |
| `current-output/route.ts` L83 (`detectThinking`) | L83 | MATCH |
| `current-output/route.ts` L73-74 (非空行15行) | L73-74 | MATCH |

(*1) SF-C01 参照 -- 設計書は `slice(-50)` と記載しているが実際は `Math.max(0, lines.length - 50)` を使用。

---

## 2. "Before" コードの検証

### auto-yes-manager.ts pollAutoYes() の現状コード

設計書 Section 3-1 の "Before" ブロック:

```typescript
const output = await captureSessionOutput(worktreeId, cliToolId, 5000);
const cleanOutput = stripAnsi(output);

if (detectThinking(cliToolId, cleanOutput)) {
  scheduleNextPoll(worktreeId, cliToolId);
  return;
}
```

実際のコード (L276-287):

```typescript
// 1. Capture tmux output
const output = await captureSessionOutput(worktreeId, cliToolId, 5000);

// 2. Strip ANSI codes
const cleanOutput = stripAnsi(output);

// 2.5. Skip prompt detection during thinking state (Issue #161, Layer 1)
// This prevents false positive detection of numbered lists in CLI output
// while Claude is actively processing (thinking/planning).
if (detectThinking(cliToolId, cleanOutput)) {
  scheduleNextPoll(worktreeId, cliToolId);
  return;
}
```

**結果**: MATCH -- コメント行が省略されているが、ロジックは完全に一致。`detectThinking()` が `cleanOutput`（5000行全体）を受け取っている点も正確。

---

## 3. 関数シグネチャ・定数名の検証

| 設計書の記載 | 実際のコード | ファイル:行 | 結果 |
|-------------|------------|------------|------|
| `detectThinking(cliToolId, content): boolean` | `detectThinking(cliToolId: CLIToolType, content: string): boolean` | `cli-patterns.ts:73` | MATCH |
| `stripAnsi(str): string` | `stripAnsi(str: string): string` | `cli-patterns.ts:169` | MATCH |
| `detectPrompt(output): PromptDetectionResult` | `detectPrompt(output: string): PromptDetectionResult` | `prompt-detector.ts:44` | MATCH |
| `STATUS_CHECK_LINE_COUNT = 15` | `const STATUS_CHECK_LINE_COUNT: number = 15` | `status-detector.ts:50` | MATCH |
| `CLAUDE_THINKING_PATTERN` | 定義あり | `cli-patterns.ts:26-29` | MATCH |
| `captureSessionOutput` | `import { captureSessionOutput } from './cli-session'` | `auto-yes-manager.ts:12` | MATCH |
| `sendKeys` | `import { sendKeys } from './tmux'` | `auto-yes-manager.ts:15` | MATCH |
| `resolveAutoAnswer` | `import { resolveAutoAnswer } from './auto-yes-resolver'` | `auto-yes-manager.ts:14` | MATCH |

---

## 4. 影響範囲分析の検証

### 修正対象ファイル

設計書は `auto-yes-manager.ts` のみを修正対象としている。

**検証結果**: 適切。修正は `pollAutoYes()` 関数内の `detectThinking()` 呼び出し前にウィンドウイングを追加するのみであり、他ファイルへの変更は不要。

### 影響なしとされるファイル

| ファイル | 設計書の記載 | 検証結果 |
|---------|------------|---------|
| `detectThinking()` 関数自体 | 変更なし | CONFIRMED -- 関数自体は修正不要、呼び出し元で前処理 |
| `detectPrompt()` 関数 | 変更なし、内部ウィンドウイング済み | CONFIRMED -- L48: `slice(-10)`, L268: `Math.max(0, lines.length - 50)` |
| `status-detector.ts` | 変更なし、既にウィンドウイング済み | CONFIRMED -- L83: `slice(-STATUS_CHECK_LINE_COUNT)` |
| `current-output/route.ts` | 変更なし、既にウィンドウイング済み | CONFIRMED -- L73-74: 非空行フィルタ + `slice(-15)` |
| `auto-yes-resolver.ts` | 変更なし | CONFIRMED -- `pollAutoYes()` 内の呼び出し順序に変更なし |

### 回帰リスク

設計書の「低リスク」評価は適切。理由:
- 検索範囲を縮小する方向の変更（5000行 -> 50行）
- 既存テスト（Issue #161、3行入力）は50行ウィンドウ内に収まる
- `detectPrompt()` は独自ウィンドウイングを持つため影響なし

---

## 5. テスト設計の検証

### 既存テスト構造 (tests/unit/lib/auto-yes-manager.test.ts)

- 全500行、11個の describe ブロック
- Issue #161 テスト: L427-499 に2テスト（thinking state skip / normal prompt detection）
- モックパターン: `await import()` による動的インポート + `vi.mocked()` を使用
- セットアップ: `beforeEach` で `clearAllAutoYesStates()` + `clearAllPollerStates()`

### 設計書テスト3 (SF-001) の実現可能性

テスト3 は `THINKING_CHECK_LINE_COUNT` をエクスポートして値を検証する設計。現在のコードでは `STATUS_CHECK_LINE_COUNT` はモジュールプライベート（非エクスポート）であるが、新規定数 `THINKING_CHECK_LINE_COUNT` はテストから参照する必要があるためエクスポートが必須。チェックリストにエクスポートの指定がない点を SF-C02 として指摘。

---

## 6. アーキテクチャ図の検証

設計書 Section 2 の Mermaid 図は修正後（After）の呼び出しフローを示している:

```
pollAutoYes -> captureSessionOutput -> stripAnsi -> detectThinking(末尾50行) -> detectPrompt
```

現状のコードでは `detectThinking` は `cleanOutput` 全体（5000行）を受け取るため、図は提案後の状態を描画している。フローの構造自体（captureSessionOutput -> stripAnsi -> detectThinking -> detectPrompt -> resolveAutoAnswer -> sendKeys）は現状コードと一致しており、変更点（ウィンドウイング追加）のみが異なる。

**結果**: 構造は正確。提案後のフローである旨が明示されるとなお良い（C-C03）。

---

## 7. 指摘事項

### Must Fix

なし

### Should Fix

#### SF-C01: prompt-detector.ts L268 のコード形式の記述が不正確

| 項目 | 内容 |
|------|------|
| **場所** | 設計書 Section 3-1 (定数コメント), Section 3-2 項目1 |
| **問題** | `prompt-detector.ts L268で slice(-50) を使用` と記載されているが、実際のコードは `Math.max(0, lines.length - 50)` を使用 |
| **文書内矛盾** | 同設計書の Section 3-3 では `Math.max(0, length-50)` と正しく記載されており、文書内で矛盾が発生 |
| **重要度** | medium |
| **工数** | low |
| **推奨対応** | Section 3-1 定数コメント内の `slice(-50)` を `Math.max(0, lines.length - 50)` に修正。Section 3-2 項目1 も同様に修正 |

実際のコード (`src/lib/prompt-detector.ts` L264-268):
```typescript
function detectMultipleChoicePrompt(output: string): PromptDetectionResult {
  const lines = output.split('\n');

  // Calculate scan window: last 50 lines
  const scanStart = Math.max(0, lines.length - 50);
```

設計書 Section 3-1 の定数コメント案:
```typescript
// 現在の記載:
// IMPORTANT: This value is semantically coupled to the hardcoded 50 in
// prompt-detector.ts detectMultipleChoicePrompt() (L268: slice(-50)).

// 修正後:
// IMPORTANT: This value is semantically coupled to the hardcoded 50 in
// prompt-detector.ts detectMultipleChoicePrompt() (L268: Math.max(0, lines.length - 50)).
```

#### SF-C02: THINKING_CHECK_LINE_COUNT のエクスポート指定がチェックリストに未記載

| 項目 | 内容 |
|------|------|
| **場所** | 設計書 Section 8 (実装チェックリスト) |
| **問題** | Section 4-1 テスト3 で `THINKING_CHECK_LINE_COUNT をエクスポートして直接値を検証` と明記しているが、チェックリストでは `定数追加` としか記載されていない |
| **影響** | 実装者がエクスポートを忘れるとテスト3 がコンパイルエラーになる |
| **重要度** | medium |
| **工数** | low |
| **推奨対応** | チェックリスト項目を `THINKING_CHECK_LINE_COUNT 定数追加（export）` に修正 |

### Consider

#### C-C01: current-output/route.ts の非空行フィルタリングの差異

`current-output/route.ts` (L73-74) は空行を除外してから末尾15行を取得するが、`status-detector.ts` (L82-83) は空行を含む全行から末尾15行を取得する。設計書はこの差異を暗黙的に扱っているが、コードコメントや設計書本文での明確な説明があると保守性が向上する。

#### C-C02: テスト設計例のモックパターンが既存テストと異なる

設計書 Section 4-1 のテスト1-2 はトップレベルの `vi.mocked()` パターンで記載されているが、既存の Issue #161 テスト（L429-498）は `await import()` による動的インポートパターンを使用している。実装時には既存パターンに合わせることが望ましい。

#### C-C03: Mermaid図の時制の明示

設計書 Section 2 の Mermaid 図は修正後のフローを描画しているが、その旨がキャプションや注記で明示されていない。現状フローとの差異を注記すると読者の理解が深まる。

---

## 8. リスク評価

| カテゴリ | リスクレベル | 根拠 |
|---------|------------|------|
| 技術リスク | low | 検索範囲縮小のみの変更。既存テストは影響範囲内 |
| セキュリティリスク | low | 入力バリデーション変更なし。外部入力処理変更なし |
| 運用リスク | low | ポーリング間隔・バックオフロジックに変更なし |

---

## 9. 総合評価

設計書と実際のコードベースの整合性は非常に高い。8箇所の行番号参照のうち7箇所が完全一致、1箇所が部分一致（コード形式の記述差異のみ、意味的には一致）であった。関数シグネチャ、定数名、影響範囲分析はすべて正確であり、設計書の品質が高いことを確認した。

2件の Should Fix は設計書の記述精度に関する軽微な修正であり、実装の方向性や技術的妥当性には影響しない。

**承認ステータス**: conditionally_approved -- SF-C01, SF-C02 の修正を条件とする

---

*Generated by architecture-review-agent (Stage 2: 整合性レビュー)*
*Reviewed: 2026-02-08*
