# Issue #193 仮説検証レポート

## 検証日時
- 2026-02-08

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `detectMultipleChoicePrompt()`の2パス❯検出方式が特定のClaude Code形式をカバーできていない | Confirmed | Pass 1で❯未検出時に即`isPrompt: false`を返却。❯なし形式は一切検出不可 |
| 2 | `CLAUDE_CHOICE_INDICATOR_PATTERN`がスクリーンショットの形式と一致していない | Partially Confirmed | cli-patterns.tsに`CLAUDE_CHOICE_INDICATOR_PATTERN`自体が存在しない。検出ロジックはprompt-detector.ts内にハードコード |
| 3 | `prompt-response/route.ts`の`detectPrompt()`が選択肢プロンプトを認識できず送信を拒否 | Confirmed | L75-82で`promptCheck.isPrompt`がfalseなら`prompt_no_longer_active`エラーを返却 |
| 4 | `detectPrompt()`の呼び出し箇所が計9箇所 | Confirmed | 全9箇所の行番号を確認済み |
| 5 | `STATUS_CHECK_LINE_COUNT=15`行制限により検出ウィンドウから外れる可能性 | Confirmed | status-detector.ts L50で15行に制限。detectMultipleChoicePrompt()は50行を想定するが、入力が15行に切り詰められる |

## 詳細検証

### 仮説 1: 2パス❯検出方式のカバレッジ

**Issue内の記述**: `prompt-detector.ts`の`detectMultipleChoicePrompt()`内の2パス❯検出方式（Issue #161）が、スクリーンショットに示されるClaude Codeの選択肢形式をカバーできていない

**検証手順**:
1. `src/lib/prompt-detector.ts` L264-391 の`detectMultipleChoicePrompt()`を確認
2. Pass 1 (L270-288): 50行ウィンドウ内で`DEFAULT_OPTION_PATTERN` (`/^\s*\u276F\s*(\d+)\.\s*(.+)$/`) を検索
3. Pass 1で❯未検出 → L283-287で即座に`isPrompt: false`を返却

**判定**: Confirmed

**根拠**:
- `DEFAULT_OPTION_PATTERN` (L182): `/^\s*\u276F\s*(\d+)\.\s*(.+)$/` — ❯ (U+276F) のみ対応
- Pass 1で❯が見つからない場合、Pass 2に進まず即座にfalseを返す
- ❯マーカーなしの選択肢形式（番号のみのリスト）は一切検出されない

**Issueへの影響**: Issue記載のケースB（❯マーカーなしの選択肢形式）に該当する可能性が高い

---

### 仮説 2: CLI パターンの不一致

**Issue内の記述**: `cli-patterns.ts`のClaude Code選択肢パターン（`CLAUDE_CHOICE_INDICATOR_PATTERN`等）がスクリーンショットの形式と一致していない可能性

**検証手順**:
1. `src/lib/cli-patterns.ts` を全文確認
2. `CLAUDE_CHOICE_INDICATOR_PATTERN` という名前のパターンを検索

**判定**: Partially Confirmed

**根拠**:
- `cli-patterns.ts`に`CLAUDE_CHOICE_INDICATOR_PATTERN`は**存在しない**
- 選択肢検出パターンは`prompt-detector.ts`内にハードコードされている（L182, L189）
- Issue記載のパターン名は実際のコードと異なるが、「パターンが一致しない」という本質的主張は正しい

**Issueへの影響**: パターン名の修正が必要。変更対象ファイルは`cli-patterns.ts`ではなく`prompt-detector.ts`

---

### 仮説 3: prompt-response/route.ts のブロッキング

**Issue内の記述**: `detectPrompt()`が選択肢プロンプトを認識できず、送信を拒否

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts` L65-83を確認

**判定**: Confirmed

**根拠**:
```typescript
// L75: プロンプト検出
const promptCheck = detectPrompt(cleanOutput);

// L77-82: 検出失敗時はエラーレスポンス
if (!promptCheck.isPrompt) {
  return NextResponse.json({
    success: false,
    reason: 'prompt_no_longer_active',
    answer,
  });
}
```
- `detectPrompt()`がfalseを返すと、ユーザーの回答は送信されない
- UIには「プロンプトがアクティブでない」エラーが表示される

---

### 仮説 4: detectPrompt()の呼び出し箇所（9箇所）

**Issue内の記述**: `detectPrompt()`の呼び出し箇所が計9箇所

**検証手順**: 全ファイルで`detectPrompt(`を検索

**判定**: Confirmed

**根拠**: 全9箇所確認済み:

| # | ファイル | 行番号 | コンテキスト |
|---|---------|--------|------------|
| 1 | `auto-yes-manager.ts` | L290 | Auto-yesポーリング |
| 2 | `status-detector.ts` | L87 | セッションステータス検出 |
| 3 | `prompt-response/route.ts` | L75 | ユーザー応答検証 |
| 4 | `current-output/route.ts` | L88 | 現在出力API |
| 5 | `response-poller.ts` | L248 | パーミッションプロンプト早期チェック（Claude専用ガード内） |
| 6 | `response-poller.ts` | L442 | インタラクティブプロンプト検出 |
| 7 | `response-poller.ts` | L556 | レスポンス完了チェック |
| 8 | `claude-poller.ts` | L164 | Claude専用ポーラー |
| 9 | `claude-poller.ts` | L232 | Claude専用ポーラー |

---

### 仮説 5: STATUS_CHECK_LINE_COUNT=15 の制約

**Issue内の記述**: `status-detector.ts`のSTATUS_CHECK_LINE_COUNT=15行制限により、選択肢が多い場合やヘッダーテキストが長い場合に検出ウィンドウから外れていないか

**検証手順**:
1. `src/lib/status-detector.ts` L50, L83, L87を確認
2. `detectPrompt()`内部のウィンドウサイズと比較

**判定**: Confirmed

**根拠**:
- `status-detector.ts` L50: `const STATUS_CHECK_LINE_COUNT: number = 15;`
- L83: `const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');` — 15行に切り詰め
- L87: `const promptDetection = detectPrompt(lastLines);` — 切り詰めた15行を渡す
- `detectMultipleChoicePrompt()`は50行のスキャンウィンドウを想定するが、入力自体が15行に制限されている
- ウィンドウサイズの不整合: 呼び出し元によって渡される行数が異なる（15行 vs 全文）

---

## 追加発見事項

### detectPrompt()のシグネチャ

```typescript
export function detectPrompt(output: string): PromptDetectionResult
```

- パラメータは`output: string`の1つのみ
- optionsパラメータなし（CLIツール別のパターンカスタマイズ不可）
- cliToolIdパラメータなし

### ウィンドウサイズの不整合

| 呼び出し元 | 渡される行数 |
|-----------|------------|
| status-detector.ts | 最後15行 |
| auto-yes-manager.ts | 全文 |
| prompt-response/route.ts | 全文 |
| response-poller.ts L442, L556 | 全文（ANSI未ストリップ） |

---

## Stage 1レビューへの申し送り事項

- **Issue記載の`CLAUDE_CHOICE_INDICATOR_PATTERN`は実在しない**: 変更対象ファイル欄の修正が必要
- **ケースB（❯なし形式）が最も可能性が高い**: Pass 1で❯が見つからない場合の即座のfalse返却が根本原因
- **ウィンドウサイズの不整合**: status-detector.ts経由の呼び出しでは15行制限により検出範囲が狭まる
- **response-poller.ts L442, L556**: ANSI未ストリップの生出力を`detectPrompt()`に渡している問題も確認
