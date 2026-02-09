# Issue #188 仮説検証レポート

## 検証日時
- 2026-02-09

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | thinking検出ウィンドウ（非空行15行）が広すぎ、完了済み応答のthinkingインジケータを含む | **Confirmed** | `worktrees/route.ts` L60, `current-output/route.ts` L72-74にて`detectSessionStatus()`および非空行15行ウィンドウを使用 |
| 2 | thinking検出がプロンプト検出を無条件で上書き | **Partially Confirmed** | `status-detector.ts`では優先順位あり（1.プロンプト→2.thinking→3.入力プロンプト）。`current-output/route.ts` L88でthinking優先ロジックあり |
| 3 | `current-output` でthinking=trueの場合プロンプト検出が完全スキップ | **Confirmed** | `current-output/route.ts` L88: `const promptDetection = thinking ? { isPrompt: false, ... } : detectPrompt(...)` |
| 4 | レスポンスポーラー（raw 20行）とステータス検出（非空行15行）のウィンドウ方式不整合 | **Confirmed** | `response-poller.ts` L235-236: raw 20行、`status-detector.ts` L83: 非空行15行 |
| 5 | `claude-poller.ts`のthinkingパターンがスピナー文字の存在のみでマッチ | **Rejected** | `claude-poller.ts`は存在せず。`cli-patterns.ts` L27-30の`CLAUDE_THINKING_PATTERN`は`…`を必須とする |

## 詳細検証

### 仮説 1: thinking検出ウィンドウ（非空行15行）が広すぎ、完了済み応答のthinkingインジケータを含む

**Issue内の記述**:
> 「最後15行（非空行）」のウィンドウには、**完了済みの応答処理で表示されたthinkingインジケータ**（`✻ Churned for 41s…` や `(esc to interrupt)` を含むステータスバー）が含まれてしまう。

**検証手順**:
1. `src/lib/status-detector.ts:75-83` を確認
2. `src/app/api/worktrees/[id]/current-output/route.ts:72-74` を確認

**判定**: **Confirmed**

**根拠**:

**status-detector.ts:83**
```typescript
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
// STATUS_CHECK_LINE_COUNT = 15
```

**current-output/route.ts:72-74**
```typescript
const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
const lastSection = nonEmptyLines.slice(-15).join('\n');
const thinking = detectThinkingState(cliToolId, lastSection);
```

どちらも非空行の最後15行をウィンドウとして使用しており、空行がスキップされる結果、より広い時間範囲（数十行前まで）の内容が検査対象に含まれる。

**Issueへの影響**: P0問題として正しく指摘されている。

---

### 仮説 2: thinking検出がプロンプト検出を無条件で上書き（プロンプトが見えていてもthinkingが優先）

**Issue内の記述**:
> `CLAUDE_THINKING_PATTERN` がこれにマッチし、プロンプト（`>`）が存在していてもthinking検出が無条件で優先されるため、`isProcessing = true`（スピナー表示）となる。

**検証手順**:
1. `src/lib/status-detector.ts:75-107` の検出優先順位を確認
2. `src/app/api/worktrees/[id]/current-output/route.ts:79-90` のロジックを確認

**判定**: **Partially Confirmed**

**根拠**:

**status-detector.ts では優先順位が正しく実装されている**:

```typescript
// 1. Interactive prompt detection (highest priority)
const promptDetection = detectPrompt(lastLines, promptOptions);
if (promptDetection.isPrompt) {
    return { status: 'waiting', ... };
}

// 2. Thinking indicator detection
if (detectThinking(cliToolId, lastLines)) {
    return { status: 'running', ... };
}

// 3. Input prompt detection
if (promptPattern.test(lastLines)) {
    return { status: 'ready', ... };
}
```

`status-detector.ts`は正しい優先順位（1.interactive prompt → 2.thinking → 3.input prompt）を実装している。

**しかし、current-output/route.ts では thinking が優先**:

```typescript
// L79-90
const thinking = detectThinkingState(cliToolId, lastSection);
const promptDetection = thinking
    ? { isPrompt: false, cleanContent: cleanOutput }
    : detectPrompt(cleanOutput, promptOptions);
```

`current-output/route.ts`では、thinking検出が先に実行され、thinking=trueの場合はプロンプト検出が完全にスキップされる。

**Issueへの影響**:
- `status-detector.ts`は正しく実装されているが、`current-output/route.ts`のthinking優先ロジックが問題の一因。
- Issueの指摘は`current-output/route.ts`に関しては正しいが、全体としては「部分的に確認」。

---

### 仮説 3: `current-output` でthinking=trueの場合プロンプト検出が完全スキップ（Issue #161対策の副作用）

**Issue内の記述**:
> thinking=trueの場合、プロンプト検出が完全にスキップされる（Issue #161対策の副作用）

**検証手順**:
1. `src/app/api/worktrees/[id]/current-output/route.ts:79-90` を確認
2. コメント内のIssue #161参照を確認

**判定**: **Confirmed**

**根拠**:

**current-output/route.ts:79-90**
```typescript
// Check for thinking indicator FIRST (takes priority over prompt detection)
// Issue #161: Skip prompt detection during thinking state to prevent
// false positive detection of numbered lists as multiple_choice prompts.
// This mirrors the same defense in auto-yes-manager.ts pollAutoYes().
const thinking = detectThinkingState(cliToolId, lastSection);

// Check if it's an interactive prompt (yes/no or multiple choice)
// Skip detection during thinking to avoid false positives propagating
// to useAutoYes.ts client-side auto-response.
const promptDetection = thinking
    ? { isPrompt: false, cleanContent: cleanOutput }
    : detectPrompt(cleanOutput, promptOptions);
```

コメントで明示的にIssue #161対策として、thinking中はプロンプト検出をスキップすることが記載されている。

**Issueへの影響**: P1問題として正しく指摘されている。Issue #161の対策が本Issueの問題の一因となっている。

---

### 仮説 4: レスポンスポーラー（raw 20行）とステータス検出（非空行15行）のウィンドウ方式不整合

**Issue内の記述**:
> レスポンスポーラーは「最後20 raw行」を検査するため、thinkingインジケータが20行以上前にあれば正しく完了検出する。一方、サイドバーとcurrent-outputは「最後15 非空行」のため、空行をスキップした結果より広い範囲を検査し、完了済みのthinkingインジケータが含まれてしまう。

**検証手順**:
1. `src/lib/response-poller.ts:235-239` の`extractResponse()`を確認
2. `src/lib/status-detector.ts:83` の検出ロジックを確認

**判定**: **Confirmed**

**根拠**:

**response-poller.ts:235-239 (extractResponse)**
```typescript
// Always check the last 20 lines for completion pattern (more robust than tracking line numbers)
const checkLineCount = 20;
const startLine = Math.max(0, totalLines - checkLineCount);
const linesToCheck = lines.slice(startLine);
const outputToCheck = linesToCheck.join('\n');
```

- **raw行で最後20行**を使用（空行含む）

**status-detector.ts:83**
```typescript
const cleanOutput = stripAnsi(output);
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
// STATUS_CHECK_LINE_COUNT = 15
```

- **非空行ではなく全行の最後15行**を使用

**補足検証**: `current-output/route.ts:72-74`
```typescript
const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
const lastSection = nonEmptyLines.slice(-15).join('\n');
```

- **非空行の最後15行**を使用

**結論**:
- `response-poller.ts`: raw行20行（空行含む）
- `status-detector.ts`: 全行15行（空行含む）
- `current-output/route.ts`: 非空行15行（空行除外）

3箇所でウィンドウ方式が異なり、特に`current-output/route.ts`の非空行フィルタリングが問題。

**Issueへの影響**: P1問題として正しく指摘されている。ウィンドウ方式の不整合が誤検出の一因。

---

### 仮説 5: `claude-poller.ts`（レガシー）のthinkingパターンがスピナー文字の存在のみでマッチし誤検出しやすい

**Issue内の記述**:
> `claude-poller.ts`（レガシー）のthinkingパターンがスピナー文字の存在のみでマッチし誤検出しやすい

**検証手順**:
1. `src/lib/claude-poller.ts` の存在確認
2. `src/lib/cli-patterns.ts` の`CLAUDE_THINKING_PATTERN`を確認

**判定**: **Rejected**

**根拠**:

`src/lib/claude-poller.ts`は存在しない（グローバル検索でヒットせず）。

代わりに`src/lib/cli-patterns.ts:27-30`に以下の定義がある:

```typescript
/**
 * Claude thinking pattern
 * Matches spinner character followed by activity text ending with …
 * The text can contain spaces (e.g., "Verifying implementation (dead code detection)…")
 */
export const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s+.+…|to interrupt\\)`,
  'm'
);
```

このパターンは`…`（U+2026, 水平楕円記号）または`to interrupt)`を**必須**とし、スピナー文字だけではマッチしない。

**正しい事実**:
- `claude-poller.ts`は存在しない（削除済みまたは統合済み）
- `CLAUDE_THINKING_PATTERN`はスピナー文字 + `.+…` を必須とし、十分に厳密

**Issueへの影響**: P2問題として挙げられているが、前提となるファイルが存在しない。この指摘は削除すべき。

---

## Stage 1レビューへの申し送り事項

### Rejected仮説に関する修正要請

- **仮説5（claude-poller.ts問題）**: `claude-poller.ts`は存在しないため、P2問題リストから削除する
- **改善案P2項目**: 同様に削除または「該当なし」に修正する

### Partially Confirmed仮説の補足

- **仮説2（thinking優先）**:
  - `status-detector.ts`では正しい優先順位が実装されている（プロンプト > thinking）
  - 問題は`current-output/route.ts`のthinking優先ロジックに限定される
  - Issueの問題点の表現を「`current-output/route.ts`のthinking優先ロジック」に限定すべき

### 検証で明らかになった追加の問題

1. **3つのウィンドウ方式の不整合**:
   - `response-poller.ts`: raw行20行
   - `status-detector.ts`: 全行15行
   - `current-output/route.ts`: 非空行15行

   この不整合がより根本的な問題である可能性がある。

2. **STATUS_CHECK_LINE_COUNT定数の意味的結合**:
   - `status-detector.ts` L50: `const STATUS_CHECK_LINE_COUNT: number = 15;`
   - この定数は「非空行15行」として使われることがあるため、定数名と実際の使用方法に齟齬がある。

---

## 次ステップ

Stage 1レビューでは、以下を重点的に確認すべき:

1. **仮説5（Rejected）の削除**: 問題点リスト・改善案から`claude-poller.ts`関連の記述を削除
2. **仮説2の表現修正**: 「thinking検出が無条件で優先」→「`current-output/route.ts`でthinking検出が優先」
3. **ウィンドウ方式不整合の強調**: 3箇所の不整合が根本原因である可能性を追記
4. **根本原因の再分析**: ウィンドウ方式の統一が最優先課題か検討
