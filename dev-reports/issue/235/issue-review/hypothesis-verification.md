# Issue #235 仮説検証レポート

## 検証日時
- 2026-02-11

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `cleanContent` 生成ロジックが質問テキストのみを抽出している | Confirmed | `prompt-detector.ts:508` で `cleanContent: question.trim()` が確認された |
| 2 | `extractQuestionText()` が5行制限している | Confirmed | `prompt-detector.ts:476` で `Math.max(0, questionEndIndex - 5)` が確認された |
| 3 | `response-poller.ts:618` でcleanContentのみDB保存している | Confirmed | `response-poller.ts:618` で `content: promptDetection.cleanContent` が確認された |
| 4 | `PromptMessage.tsx` で `message.content` が未使用 | Confirmed | `PromptMessage.tsx:52` で `prompt.question` のみ表示、`message.content` は未使用 |
| 5 | Yes/Noパターンも同様に質問テキストのみ返却 | Confirmed | `prompt-detector.ts:129` で `cleanContent: question` が確認された |

## 詳細検証

### 仮説 1: `cleanContent` 生成ロジックが質問テキストのみを抽出している

**Issue内の記述**:
> `src/lib/prompt-detector.ts` の `cleanContent` 生成ロジックが質問テキストのみ（最大5行）を抽出し、Claudeの指示メッセージを切り捨てている。

**検証手順**:
1. `src/lib/prompt-detector.ts:488-509` を確認
2. `detectMultipleChoicePrompt()` の返り値を確認

**判定**: **Confirmed**

**根拠**:
- `prompt-detector.ts:508` で `cleanContent: question.trim()` として質問テキストのみ返却
- `question` は `prompt-detector.ts:476` で `Math.max(0, questionEndIndex - 5)` から抽出された最大5行のテキスト

**Issueへの影響**: Issue記載の原因分析は正確。修正方針の前提として問題なし。

---

### 仮説 2: `extractQuestionText()` が5行制限している

**Issue内の記述**:
> **`src/lib/prompt-detector.ts`（471-486行目）**: `extractQuestionText()` が `questionEndIndex - 5` で5行制限

**検証手順**:
1. `src/lib/prompt-detector.ts:471-486` を確認
2. ループの範囲を確認

**判定**: **Confirmed**

**根拠**:
- `prompt-detector.ts:476` で `for (let i = Math.max(0, questionEndIndex - 5); i <= questionEndIndex; i++)` を確認
- 質問テキストは質問行から最大5行前までしか取得されない

**Issueへの影響**: Issue記載の問題箇所は正確。

---

### 仮説 3: `response-poller.ts:618` でcleanContentのみDB保存している

**Issue内の記述**:
> **`src/lib/response-poller.ts`（618行目）**: `content: promptDetection.cleanContent` で切り捨てられた内容のみDB保存

**検証手順**:
1. `src/lib/response-poller.ts:615-623` を確認
2. `createMessage` の引数を確認

**判定**: **Confirmed**

**根拠**:
- `response-poller.ts:618` で `content: promptDetection.cleanContent` を確認
- 完全なClaude応答（指示テキスト含む）は `result.content` に存在するが、DB保存時には使用されていない

**Issueへの影響**: Issue記載のデータフローは正確。

---

### 仮説 4: `PromptMessage.tsx` で `message.content` が未使用

**Issue内の記述**:
> **`src/components/worktree/PromptMessage.tsx`**: `message.content` が未使用で表示されない

**検証手順**:
1. `src/components/worktree/PromptMessage.tsx` 全体を確認
2. `message.content` の使用箇所を検索

**判定**: **Confirmed**

**根拠**:
- `PromptMessage.tsx:52` で `{prompt.question}` のみ表示
- `message.content` は props として受け取っているが、コンポーネント内で使用されていない

**Issueへの影響**: Issue記載の問題箇所は正確。

---

### 仮説 5: Yes/Noパターンも同様に質問テキストのみ返却

**Issue内の記述**:
> **`src/lib/prompt-detector.ts`（116-132行目）**: Yes/Noパターンも同様に質問キャプチャのみ

**検証手順**:
1. `src/lib/prompt-detector.ts:116-132` を確認
2. Yes/Noパターンの `cleanContent` 設定を確認

**判定**: **Confirmed**

**根拠**:
- `prompt-detector.ts:129` で `cleanContent: question` として正規表現キャプチャグループ（質問部分のみ）を返却
- 完全な出力テキスト（`lastLines`）は使用されていない

**Issueへの影響**: Yes/Noパターンにも同じ問題が存在することを確認。修正時には両方のパターンに対応が必要。

---

## Stage 1レビューへの申し送り事項

### ✅ 全仮説が Confirmed

- すべての仮説がコードベースで確認されました
- Issue記載の原因分析・問題箇所・データフローはすべて正確です
- 修正方針（方針B: rawContentフィールド導入）の前提条件は満たされています

### 追加確認ポイント

1. **`PromptDetectionResult` 型定義の確認**
   - `prompt-detector.ts:40-47` で型定義を確認
   - 現在は `cleanContent: string` のみ
   - `rawContent?: string` の追加が可能

2. **データフローの完全性**
   - `response-poller.ts` で `result.content` に完全なClaude応答が存在することを確認
   - `rawContent` を導入すれば、この完全な応答をDB保存できる

3. **修正の影響範囲**
   - Issue記載の通り、`auto-yes-manager.ts` / `auto-yes-resolver.ts` / `status-detector.ts` は影響を受けない
   - 後方互換性は保たれる（`rawContent` はオプショナル）

---

## 結論

**すべての仮説が正確に検証されました。** Issue #235 の原因分析は正しく、修正方針Bの実装が適切です。

