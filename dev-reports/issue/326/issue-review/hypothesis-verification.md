# Issue #326 仮説検証レポート

## 検証日時
- 2026-02-20

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | 行326-341のClaude早期プロンプト検出でtmuxバッファ全体を返している | Confirmed | 実コードで `stripAnsi(fullOutput)` を返しており、lastCapturedLineを無視 |
| 2 | 行487-499のフォールバックプロンプト検出でtmuxバッファ全体を返している | Confirmed | 実コードで `fullOutput` をそのまま返しており、lastCapturedLineを無視 |
| 3 | 通常レスポンス抽出（行360-414）ではlastCapturedLineを起点にしている | Confirmed | `startIndex = Math.max(0, lastCapturedLine)` で起点を制御している |

## 詳細検証

### 仮説 1: 行326-341 Claude早期プロンプト検出

**Issue内の記述**:
```typescript
if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');  // ← tmuxバッファ全体
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
    if (promptDetection.isPrompt) {
      return {
        response: stripAnsi(fullOutput),  // ← バッファ全体を返している
        isComplete: true,
        lineCount: totalLines,
      };
    }
}
```

**検証手順**:
1. `src/lib/response-poller.ts` の行326-341を確認
2. `const fullOutput = lines.join('\n')` が `lastCapturedLine` を無視してバッファ全体を結合していることを確認
3. `response: stripAnsi(fullOutput)` でバッファ全体が返されていることを確認

**判定**: Confirmed

**根拠**: `src/lib/response-poller.ts` 行326-341
```typescript
if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');  // ← 全linesを結合（lastCapturedLine無視）
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

    if (promptDetection.isPrompt) {
      return {
        response: stripAnsi(fullOutput),  // ← バッファ全体をstripAnsiして返す
        isComplete: true,
        lineCount: totalLines,
      };
    }
  }
```
`lines` は `rawLines.slice(0, trimmedLength)` でtrimされたバッファ全体であり、`lastCapturedLine` で切り取っていない。

**Issueへの影響**: Issue記載の通り、プロンプト検出時に前の会話内容が混入する。

---

### 仮説 2: 行487-499 フォールバックプロンプト検出

**Issue内の記述**:
```typescript
const fullOutput = lines.join('\n');  // ← tmuxバッファ全体
const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
if (promptDetection.isPrompt) {
    return {
      response: fullOutput,  // ← バッファ全体を返している
      isComplete: true,
      lineCount: totalLines,
    };
}
```

**検証手順**:
1. `src/lib/response-poller.ts` の行487-499を確認
2. `response: fullOutput` でバッファ全体が返されていることを確認

**判定**: Confirmed

**根拠**: `src/lib/response-poller.ts` 行487-499
```typescript
const fullOutput = lines.join('\n');
const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);

if (promptDetection.isPrompt) {
    return {
      response: fullOutput,  // ← バッファ全体を返している（stripAnsiもしていない）
      isComplete: true,
      lineCount: totalLines,
    };
  }
```
こちらは早期プロンプト検出と同様にバッファ全体を返すが、さらに `stripAnsi` もしていない点が異なる。

**Issueへの影響**: Issue記載の通り、前の会話内容が混入する。

---

### 仮説 3: 通常レスポンス抽出（行360-414）でlastCapturedLineを使用

**Issue内の記述**: 通常のレスポンス抽出ではlastCapturedLineを起点として新しい行のみを抽出している

**検証手順**:
1. `src/lib/response-poller.ts` の行360-414を確認
2. `startIndex` の決定ロジックを確認

**判定**: Confirmed

**根拠**: `src/lib/response-poller.ts` 行363-386
```typescript
let startIndex: number;
const bufferWasReset = lastCapturedLine >= totalLines || bufferReset;

if (bufferWasReset) {
  const foundUserPrompt = findRecentUserPromptIndex(40);
  startIndex = foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0;
} else if (cliToolId === 'codex') {
  startIndex = Math.max(0, lastCapturedLine);
} else if (lastCapturedLine >= totalLines - 5) {
  const foundUserPrompt = findRecentUserPromptIndex(50);
  startIndex = foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40);
} else {
  startIndex = Math.max(0, lastCapturedLine);  // ← 通常ケースではlastCapturedLine使用
}
```
通常ケースでは `startIndex = Math.max(0, lastCapturedLine)` を使用して新しい行のみを抽出している。

---

## Stage 1レビューへの申し送り事項

- Issue記載の仮説はすべて**Confirmed**（コードと一致）
- 修正方針（「プロンプト検出はバッファ全体で行い、返却するcontent部分のみlastCapturedLine以降に限定する」）は技術的に妥当
- 追加確認点:
  - 箇所2（行487-499）は `stripAnsi` もしていないため、修正時に `stripAnsi` も適用すべきかどうかを検討すること
  - 修正後の影響として `checkForResponse()` 内の promptDetection でも正しくプロンプトが検出されるかを確認すること（行605）
  - `findRecentUserPromptIndex()` がプロンプト検出時にも有効に機能するかを確認すること
