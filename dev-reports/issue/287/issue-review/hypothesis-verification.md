# Issue #287 仮説検証レポート

## 検証日時
- 2026-02-15

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | プロンプト再検証処理がサイレント失敗し、`promptCheck` が `null` になる | **Confirmed** | route.ts:72-89 |
| 2 | `isClaudeMultiChoice` 判定が常に `false` になる | **Confirmed** | route.ts:96-98 |
| 3 | テキスト入力フォールバック（`sendKeys("1")` + Enter）が実行される | **Confirmed** | route.ts:149-157 |
| 4 | Claude Codeの選択肢プロンプトはカーソルキーベース（Arrow/Enter）を要求 | **Confirmed** | route.ts:93-148, tmux.ts:252-274 |

## 詳細検証

### 仮説 1: プロンプト再検証処理がサイレント失敗し、`promptCheck` が `null` になる

**Issue内の記述**:
> `src/app/api/worktrees/[id]/prompt-response/route.ts` の72〜89行目にあるプロンプト再検証処理がサイレント失敗した場合、`promptCheck` が `null` のままとなる

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`:72-89 を確認
2. `promptCheck` の初期化と例外処理の動作を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:72-89
let promptCheck: PromptDetectionResult | null = null;  // L72: null で初期化
try {
  const currentOutput = await captureSessionOutput(params.id, cliToolId, 5000);
  const cleanOutput = stripAnsi(currentOutput);
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptCheck = detectPrompt(cleanOutput, promptOptions);

  if (!promptCheck.isPrompt) {
    return NextResponse.json({
      success: false,
      reason: 'prompt_no_longer_active',
      answer,
    });
  }
} catch {
  // L86-89: 例外が発生した場合、promptCheck は null のまま処理が続行される
  console.warn('[prompt-response] Failed to verify prompt state, proceeding with send');
}
```

**Issueへの影響**: この仮説は正確であり、修正すべき問題の根本原因として正しい。

---

### 仮説 2: `isClaudeMultiChoice` 判定が常に `false` になる

**Issue内の記述**:
> 96〜98行目の `isClaudeMultiChoice` 判定が常に `false` になる

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`:96-98 を確認
2. `promptCheck?.promptData?.type` の評価動作を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:96-98
const isClaudeMultiChoice = cliToolId === 'claude'
  && promptCheck?.promptData?.type === 'multiple_choice'  // promptCheck が null の場合、undefined となる
  && /^\d+$/.test(answer);
```

`promptCheck` が `null` の場合:
- `promptCheck?.promptData?.type` は `undefined`
- `undefined === 'multiple_choice'` は `false`
- 結果: `isClaudeMultiChoice` は `false`

**Issueへの影響**: この仮説は正確であり、問題の連鎖の第2段階として正しい。

---

### 仮説 3: テキスト入力フォールバック（`sendKeys("1")` + Enter）が実行される

**Issue内の記述**:
> 149〜157行目のテキスト入力フォールバック（`sendKeys("1")` + Enter）が実行される

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`:149-157 を確認
2. `isClaudeMultiChoice` が `false` の場合の処理フローを確認

**判定**: **Confirmed**

**根拠**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:149-157
} else {
  // Standard CLI prompt: send text + Enter (y/n, Approve?, etc.)
  await sendKeys(sessionName, answer, false);  // L151: "1" を送信（Enterなし）

  // Wait a moment for the input to be processed
  await new Promise(resolve => setTimeout(resolve, 100));

  // Send Enter
  await sendKeys(sessionName, '', true);  // L157: Enter を送信
}
```

`isClaudeMultiChoice` が `false` の場合、elseブロックが実行され:
1. L151: `sendKeys(sessionName, "1", false)` - 文字列 "1" を送信
2. L157: `sendKeys(sessionName, "", true)` - Enter を送信

**Issueへの影響**: この仮説は正確であり、問題の症状として正しい。

---

### 仮説 4: Claude Codeの選択肢プロンプトはカーソルキーベース（Arrow/Enter）を要求

**Issue内の記述**:
> Claude Codeの選択肢プロンプトはカーソルキーベースのナビゲーション（Arrow Up/Down + Enter）を要求するため、文字列入力は無視される

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts`:93-148 を確認（コメントと実装）
2. `src/lib/tmux.ts`:252-274 を確認（`sendSpecialKeys` の実装）

**判定**: **Confirmed**

**根拠**:

**コメントでの明記**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:93-95
// Issue #193: Claude Code AskUserQuestion uses cursor-based navigation
// (Arrow/Space/Enter), not number input. Detect this format and send
// the appropriate key sequence instead of typing the number.
```

**実装での確認**:
```typescript
// src/app/api/worktrees/[id]/prompt-response/route.ts:100-148
if (isClaudeMultiChoice && promptCheck?.promptData?.type === 'multiple_choice') {
  // ... カーソルキー（Up/Down/Space/Enter）を送信する処理 ...

  // Single-select: navigate and Enter to select (L137-147)
  const keys: string[] = [];
  if (offset > 0) {
    for (let i = 0; i < offset; i++) keys.push('Down');
  } else if (offset < 0) {
    for (let i = 0; i < Math.abs(offset); i++) keys.push('Up');
  }
  keys.push('Enter');
  await sendSpecialKeys(sessionName, keys);
}
```

**`sendSpecialKeys` の実装**:
```typescript
// src/lib/tmux.ts:252-274
export async function sendSpecialKeys(
  sessionName: string,
  keys: string[]  // ['Down', 'Down', 'Space', 'Enter'] など
): Promise<void> {
  // ... tmux send-keys -t "${sessionName}" Down のように送信 ...
}
```

**Issueへの影響**: この仮説は正確であり、Claude Codeの動作仕様として正しい。

---

## Stage 1レビューへの申し送り事項

**すべての仮説が Confirmed のため、Issue記載内容は正確**:
- 原因分析は正しく、修正が必要な問題として妥当
- 処理フロー図も正確
- 期待される動作 vs 実際の動作の対比も正確

**Stage 1レビューでの確認推奨事項**:
1. ✅ 原因分析は正確であることを確認済み → 追加の技術的検証は不要
2. Issue内の「修正方針案」セクションの妥当性を検討
3. 関連ファイルリストの網羅性を確認
4. テストファイル（`tests/unit/api/prompt-response-verification.test.ts`）の記載が正確か確認

---

*Generated by multi-stage-issue-review command (Phase 0.5)*
