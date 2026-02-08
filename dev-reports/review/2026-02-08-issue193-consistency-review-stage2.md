# Issue #193 整合性レビュー (Stage 2)

## レビュー概要

| 項目 | 値 |
|------|------|
| Issue | #193 - Codex CLI複数選択肢検出・応答対応 |
| レビュー種別 | 整合性 (Consistency) |
| ステージ | Stage 2 |
| 日付 | 2026-02-08 |
| 設計書 | `dev-reports/design/issue-193-codex-multiple-choice-detection-design-policy.md` |
| 結果 | must_fix: 6, should_fix: 8, nice_to_have: 4 |
| 総合判定 | must_fix (修正必須事項あり) |

---

## 検証対象ファイル

以下のソースファイルを全行読み込み、設計書の記載内容と照合した。

| ファイル | 行数 | 検証内容 |
|---------|------|---------|
| `src/lib/prompt-detector.ts` | 432行 | 関数シグネチャ、パターン定数、Layer 3/4ロジック |
| `src/lib/cli-patterns.ts` | 172行 | 既存パターン定義、CLIToolType import |
| `src/lib/auto-yes-manager.ts` | 427行 | detectPrompt呼び出し行、cliToolIdアクセス方法 |
| `src/lib/status-detector.ts` | 143行 | STATUS_CHECK_LINE_COUNT、detectPrompt呼び出し行 |
| `src/lib/response-poller.ts` | 737行 | detectPrompt呼び出し箇所、モジュール構造 |
| `src/lib/claude-poller.ts` | 397行 | detectPrompt呼び出し行、Claude専用判断 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 120行 | detectPrompt呼び出し行、cliToolId取得 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 136行 | detectPrompt呼び出し行、thinking条件分岐 |
| `src/lib/auto-yes-resolver.ts` | 40行 | isDefault処理、フォールバックロジック |
| `src/types/models.ts` | 356行 | PromptData型、MultipleChoiceOption |
| `src/lib/cli-tools/codex.ts` | L85-103 | TUI操作パターン参照 |
| テストファイル3件 | - | モック定義箇所、行番号 |

---

## 重大な不整合 (must_fix)

### DR2-001: response-poller.ts -- クラスメンバ参照は誤り

**問題**: 設計書 Section 5.3/5.4 では `this.cliToolId` を参照しているが、`response-poller.ts` はクラスではなくモジュールレベル関数で構成されている。

**設計書の記載**:
```typescript
// Section 5.4
const promptDetection = detectPromptForCli(stripAnsi(lastOutput), this.cliToolId);
```

**実コード** (`src/lib/response-poller.ts`):
```typescript
// L190-193: スタンドアロン関数、クラスメンバなし
function extractResponse(
  output: string,
  lastCapturedLine: number,
  cliToolId: CLIToolType  // パラメータとして受け取る
): { ... } | null {
```

**修正方針**: `this.cliToolId` を `cliToolId`（関数パラメータ）に変更。

---

### DR2-003: response-poller.ts -- 変数名 lastOutput は実コードに存在しない

**問題**: 設計書では `lastOutput` という変数名を使用しているが、実際のコードでは:
- L441-442: `const fullOutput = lines.join('\n');` / `detectPrompt(fullOutput)`
- L556: `detectPrompt(result.response)`

**修正方針**: 設計書の変数名を `fullOutput` / `result.response` に修正。

---

### DR2-008: claude-poller.ts 行番号検証

**結果**: L164 (`detectPrompt(fullOutput)`) と L232 (`detectPrompt(result.response)`) は実コードと一致。設計書の「変更不要」判断も Claude 専用モジュールであることから妥当。

---

### DR2-012: テストファイルのモック行番号

**問題**: `auto-yes-manager.test.ts` のモック箇所を L431 としているが、L431 はテスト関数内の dynamic import 行であり、vi.mock 宣言箇所ではない。

---

### DR2-016: Section 16 チェックリストの変数名・参照不一致

**問題**: 実装チェックリスト（Phase 3）で `this.cliToolId` と `lastOutput` を使用しているが、実コードの変数名と不一致。チェックリストは実装者が直接参照するため、正確性が特に重要。

---

### DR2-020: Layer 4 の条件化で options.length < 2 との分離が必要

**問題**: 設計書の条件化コード例:
```typescript
if (requireDefault && !hasDefaultIndicator) {
  return { isPrompt: false, ... };
}
```

実コード:
```typescript
// L344-350
const hasDefaultIndicator = options.some(opt => opt.isDefault);
if (options.length < 2 || !hasDefaultIndicator) {
  return { isPrompt: false, ... };
}
```

`options.length < 2` チェックは `requireDefaultIndicator` に関わらず維持すべき独立した検証だが、設計書のコード例ではこの分離が不明確。

**修正方針**:
```typescript
// options.length < 2 は独立検証（全CLIツール共通）
if (options.length < 2) {
  return { isPrompt: false, cleanContent: output.trim() };
}
// Layer 4: hasDefaultIndicator検証（条件付き）
const requireDefault = options?.requireDefaultIndicator ?? true;
if (requireDefault && !hasDefaultIndicator) {
  return { isPrompt: false, cleanContent: output.trim() };
}
```

---

## 重要な不整合 (should_fix)

### DR2-007: current-output/route.ts の thinking 条件分岐

**問題**: L88 の `detectPrompt` 呼び出しは thinking 状態で条件分岐されている:
```typescript
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPrompt(cleanOutput);
```

設計書はこの条件分岐の存在を認識しつつも、`detectPromptForCli()` への変更時の統合方法を明記していない。

**修正方針**: 設計書に以下のコード例を追記:
```typescript
const promptDetection = thinking
  ? { isPrompt: false, cleanContent: cleanOutput }
  : detectPromptForCli(cleanOutput, cliToolId);
```

---

### DR2-009: detectMultipleChoicePrompt は module-private

**問題**: 設計書のシグネチャ表記が export 関数のように見えるが、実際は module-private 関数。

---

### DR2-011: MultipleChoiceOption.isDefault -- undefined vs false

**問題**: Codex 選択肢では `isDefault: false` を明示的に設定すべきだが、型定義上は `isDefault?: boolean` (optional) であるため、`undefined` と `false` の違いに注意が必要。

---

### DR2-013: detectPrompt 内部の yes/no パターンと status-detector の関係

**問題**: 設計書の DR1-003 修正（status-detector から full cleanOutput を渡す）の根拠として、`detectPrompt` 内部の `lastLines = lines.slice(-10)` が yes/no パターンに使われ、`detectMultipleChoicePrompt` は全出力を使用する、という二層構造の説明が不足。

---

## 行番号検証サマリー

| ファイル | 設計書参照 | 実コード | 一致 |
|---------|----------|---------|------|
| `auto-yes-manager.ts` L290 detectPrompt | L290 | L290 | 一致 |
| `auto-yes-manager.ts` L262 cliToolId | L262 | L262 | 一致 |
| `status-detector.ts` L87 detectPrompt | L87 | L87 | 一致 |
| `status-detector.ts` L77 cliToolId | L77 | L77 | 一致 |
| `status-detector.ts` STATUS_CHECK_LINE_COUNT=15 | L50 | L50 | 一致 |
| `prompt-response/route.ts` L75 detectPrompt | L75 | L75 | 一致 |
| `prompt-response/route.ts` L50 cliToolId | L50 | L50 | 一致 |
| `current-output/route.ts` L88 detectPrompt | L88 | L88 | 一致 |
| `current-output/route.ts` L40 cliToolId | L40 | L39-40 | 概ね一致 |
| `response-poller.ts` L248 Claude guard | L248 | L248 | 一致 |
| `response-poller.ts` L442 detectPrompt | L442 | L442 | 一致 |
| `response-poller.ts` L556 detectPrompt | L556 | L556 | 一致 |
| `response-poller.ts` this.cliToolId | - | 存在しない | 不一致 |
| `claude-poller.ts` L164 detectPrompt | L164 | L164 | 一致 |
| `claude-poller.ts` L232 detectPrompt | L232 | L232 | 一致 |
| `codex.ts` L91-96 TUI pattern | L91-96 | L91-96 | 一致 |
| `prompt-detector.ts` DEFAULT_OPTION_PATTERN | L182 | L182 | 一致 |
| `prompt-detector.ts` NORMAL_OPTION_PATTERN | L189 | L189 | 一致 |

---

## パターン定義の検証

| パターン | 設計書 | 実コード | 一致 |
|---------|--------|---------|------|
| DEFAULT_OPTION_PATTERN | `/^\s*\u276F\s*(\d+)\.\s*(.+)$/` | `/^\s*\u276F\s*(\d+)\.\s*(.+)$/` | 一致 |
| NORMAL_OPTION_PATTERN | `/^\s*(\d+)\.\s*(.+)$/` | `/^\s*(\d+)\.\s*(.+)$/` | 一致 |
| CLIToolType import元 | `./cli-tools/types` | `./cli-tools/types` | 一致 |

---

## 型定義の検証

| 型 | 設計書 | 実コード | 一致 |
|-----|--------|---------|------|
| PromptDetectionResult | Section 3.3で参照 | L14: export interface | 一致 |
| PromptData | Section 9.1 | L176: union type | 一致 |
| MultipleChoiceOption | Section 9.1 | L153-162 | 一致 |
| CLIToolType | Section 3.2で使用 | cli-tools/types.tsで定義 | 一致 |

---

## リスク評価

### 高リスク
- **response-poller.ts の構造誤認**: 実装フェーズで `this.cliToolId` を使用しようとしてコンパイルエラーが発生する。設計書の修正コード例と Section 16 チェックリストの両方を更新する必要がある。

### 中リスク
- **current-output/route.ts の thinking 条件分岐**: 修正方法が明記されていないため、実装者が条件分岐を誤って削除するか、統合方法に迷う可能性。
- **Layer 4 の条件分離**: `options.length < 2` チェックが `requireDefaultIndicator` の影響を受ける形で誤って条件化される可能性。

### 低リスク
- テストファイルの行番号ずれは、関数名やモック名で特定できるため実装への影響は限定的。

---

## 推奨アクション

1. **[必須]** response-poller.ts 関連の `this.cliToolId` 参照を全て `cliToolId`（関数パラメータ）に修正（Section 5.3, 5.4, 16）
2. **[必須]** response-poller.ts の変数名 `lastOutput` を実コードの `fullOutput` / `result.response` に修正
3. **[必須]** Layer 4 条件化コード例で `options.length < 2` を独立した検証として分離
4. **[推奨]** current-output/route.ts の thinking 条件分岐を含む修正後コード例を追記
5. **[推奨]** Section 16 チェックリストの response-poller.ts 項目を実コードの変数名に合わせて更新
6. **[推奨]** テストファイルのモック行番号を更新するか、行番号ではなく関数名での参照に変更

---

*Generated by architecture-review-agent*
*Date: 2026-02-08*
*Stage: 2 (整合性レビュー)*
