# Issue #191 仮説検証レポート

## 検証日時
- 2026-02-08

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `detectThinking()`が`detectPrompt()`より先に実行され、thinking検出時にプロンプト検出を完全スキップ | Confirmed | `auto-yes-manager.ts` L281-287 |
| 2 | `detectThinking()`がバッファ全体（5000行）を検索対象とする | Confirmed | `auto-yes-manager.ts` L276, `captureSessionOutput(worktreeId, cliToolId, 5000)` |
| 3 | `detectPrompt()`は末尾10〜50行のみを検索 | Confirmed | `prompt-detector.ts` L48（末尾10行）、L268（末尾50行） |
| 4 | `CLAUDE_THINKING_PATTERN`が`· Simmering…`や`⏺ Bash(...…)`にマッチ | Confirmed | `cli-patterns.ts` L26-29: `[スピナー文字]\s+.+…` パターン |
| 5 | 影響ファイルが`auto-yes-manager.ts` L281-287と`cli-patterns.ts` L73-95 | Confirmed | 両ファイルの該当行を確認 |

## 詳細検証

### 仮説 1: detectThinking()がdetectPrompt()より先に実行される

**Issue内の記述**: `detectThinking()`が`detectPrompt()`より先に実行され（行281-287）、thinking検出時にプロンプト検出を完全スキップする

**検証手順**:
1. `src/lib/auto-yes-manager.ts` の `pollAutoYes()` 関数を確認
2. L281-287のコードを確認

**判定**: Confirmed

**根拠**: `auto-yes-manager.ts` L281-287:
```typescript
// 2.5. Skip prompt detection during thinking state (Issue #161, Layer 1)
if (detectThinking(cliToolId, cleanOutput)) {
  scheduleNextPoll(worktreeId, cliToolId);
  return;  // ← ここでreturnし、L290のdetectPrompt()に到達しない
}
```

**Issueへの影響**: 記述は正確

---

### 仮説 2: detectThinking()がバッファ全体（5000行）を検索

**Issue内の記述**: `captureSessionOutput()`で取得した5000行のバッファ全体に対してパターンマッチを行う

**検証手順**:
1. `auto-yes-manager.ts` L276を確認
2. `captureSessionOutput()` の実装を確認

**判定**: Confirmed

**根拠**:
- `auto-yes-manager.ts` L276: `const output = await captureSessionOutput(worktreeId, cliToolId, 5000);`
- L278: `const cleanOutput = stripAnsi(output);`
- L284: `if (detectThinking(cliToolId, cleanOutput))` — cleanOutput（5000行分）がそのまま渡される

---

### 仮説 3: detectPrompt()は末尾10〜50行のみを検索

**Issue内の記述**: `detectPrompt()`は末尾10〜50行のみを検索

**検証手順**:
1. `src/lib/prompt-detector.ts` の `detectPrompt()` を確認
2. `src/lib/status-detector.ts` のウィンドウイングを確認

**判定**: Confirmed

**根拠**:
- `prompt-detector.ts` L48: `const lastLines = lines.slice(-10).join('\n');` （yes/noプロンプト検出は末尾10行）
- `prompt-detector.ts` L268: `const scanStart = Math.max(0, lines.length - 50);` （multiple choice検出は末尾50行）
- `status-detector.ts` L83: 末尾15行（`STATUS_CHECK_LINE_COUNT = 15`）

---

### 仮説 4: CLAUDE_THINKING_PATTERNが完了サマリー行にマッチ

**Issue内の記述**: `· Simmering… (4m 16s · ↓ 8.0k tokens · thought for 53s)`や`⏺ Bash(...…)`がマッチする

**検証手順**:
1. `src/lib/cli-patterns.ts` のCLAUDE_THINKING_PATTERNを確認
2. スピナー文字定義を確認

**判定**: Confirmed

**根拠**:
- `cli-patterns.ts` L26-29: `new RegExp([スピナー文字]\s+.+…|to interrupt), 'm')`
- L15-19: スピナー文字に`·`（middot）と`⏺`が含まれる
- `· Simmering…` → `·`(スピナー) + `\s+` + `Simmering` + `…` → マッチ
- `⏺ Bash(...…)` → `⏺`(スピナー) + `\s+` + テキスト + `…` → マッチ

---

### 仮説 5: 影響ファイルの特定

**Issue内の記述**: `src/lib/auto-yes-manager.ts` L281-287と`src/lib/cli-patterns.ts` L73-95

**検証手順**: 両ファイルの該当行を確認

**判定**: Confirmed

**根拠**:
- `auto-yes-manager.ts` L281-287: `detectThinking()` の呼び出しとearly return
- `cli-patterns.ts` L73-95: `detectThinking()` 関数定義（全文検索をそのまま実行）

---

### 棄却済み仮説の検証

#### 棄却仮説A: `>` vs `❯` 問題
**Issue記載**: 棄却済み。Claude CLIは`❯`（U+276F）を使用。

**検証結果**: Confirmed（棄却が妥当）
- `cli-patterns.ts` L10: `export const CLAUDE_PROMPT_CHAR = '❯';` （U+276F）
- `prompt-detector.ts`で`❯`をベースに検出

#### 棄却仮説B: `· · · Thinking`のthinkingマッチ
**Issue記載**: `· · · Thinking`は末尾に`…`がないためマッチしない。

**検証結果**: Confirmed（棄却が妥当）
- パターン: `[スピナー]\s+.+…` — 末尾に`…`が必要
- `· · · Thinking`は末尾が`g`であり`…`がないためマッチしない

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedであり、Issueの原因分析は正確
- 修正方針の3案（検索範囲限定、優先順位変更、パターン除外）の妥当性をレビューで検討すべき
- 案1（検索範囲限定）がIssue推奨だが、末尾N行の適切な値（20行提案）の妥当性を確認すべき
