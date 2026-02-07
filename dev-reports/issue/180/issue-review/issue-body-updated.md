## 問題概要

CLIが実際にはidle状態（`❯`プロンプト表示）であるにも関わらず、UIが「running」（スピナー）や「waiting」（黄色）ステータスを表示する問題。この問題はモバイル・デスクトップを問わず全プラットフォームで発生する（APIレスポンスの段階でステータスが誤っているため、表示側の問題ではない）。

## 再現手順

1. CommandMateにアクセス（モバイル・デスクトップ共通）
2. Claude CLIセッションを開始し、何らかの操作を行う
3. CLIが`❯`プロンプトを表示している（idle/ready状態）にも関わらず、ヘッダーのステータスインジケーターがスピナーや黄色ドットを表示

## 期待される動作

- `❯`プロンプトが表示されている場合 → 緑ドット（ready）または灰色ドット（idle）
- thinking中（`✻ Processing...`等）の場合 → 青スピナー（running）
- yes/noプロンプト表示中の場合 → 黄色ドット（waiting）

## 実際の動作

- `❯`プロンプトが表示されていても、スピナー（running）や黄色（waiting）が表示される

## 根本原因

`/api/worktrees/route.ts` および `/api/worktrees/[id]/route.ts` のステータス検出ロジックに欠陥がある（両ファイルの該当コードは完全に同一のロジック重複）。

### 問題1: 過去のプロンプト誤検出

ステータス検出には2段階の行数制限が存在する:
1. `captureSessionOutput()` がtmuxバッファの最後100行を取得
2. `detectPrompt()` がその中の最後10行（yes/noパターン）/ 最後50行（multiple_choiceパターン）を検索

このため、過去の`(y/n)`や選択肢プロンプトがスクロールバックに残っていると、検出範囲内に含まれ、現在アクティブなプロンプトとして誤検出される。
結果: `isWaitingForResponse = true`（誤り）

### 問題2: 末尾検証の欠如

検出されたパターンが出力の「末尾」（現在のカーソル位置付近）にあるかを確認していない。
`❯`入力プロンプトが出力の最後にあれば「ready」のはずだが、その確認が行われていない。

### 問題3: thinking検出の範囲が広すぎる

`detectThinking()`が最後15行を検索するため、過去の出力にスピナー文字（`✻`等）があると誤検出の可能性がある。

## 修正案

### 現在のロジック（問題あり）

```typescript
// route.ts (行47-111) - route.ts と [id]/route.ts の両方に同一コードが存在
const promptDetection = detectPrompt(cleanOutput);
if (promptDetection.isPrompt) {
  isWaitingForResponse = true;
} else {
  const nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '');
  const lastLines = nonEmptyLines.slice(-15).join('\n');
  if (detectThinking(cliToolId, lastLines)) {
    isProcessing = true;
  } else {
    const hasInputPrompt = promptPattern.test(lastLines);
    if (!hasInputPrompt) {
      isProcessing = true;
    }
  }
}
```

### 改善方針

修正には以下の2つの軸がある:

#### 軸1: 検出優先順位の変更

現在の優先順位: detectPrompt → detectThinking → promptPattern
改善後の優先順位:
1. まず最後2-3行で入力プロンプト(❯)をチェック → ready
2. 次に最後2-3行でインタラクティブプロンプトをチェック → waiting
3. 最後に最後2-3行でthinkingをチェック → running
4. いずれにも該当しない場合のみ → processing

#### 軸2: detectPrompt() の検索範囲制限

`detectPrompt()` 内部の検索範囲が広すぎる問題への対処方式として、以下の3つの選択肢がある:

- **(A) route.ts側で末尾N行に切り出してからdetectPrompt()に渡す方式**: route.tsの呼び出し側で `cleanOutput` の末尾2-3行を切り出し、`detectPrompt()` に渡す。`detectPrompt()` 自体の変更不要
- **(B) detectPrompt()内部の検索範囲を制限する方式**: `detectPrompt()` の `slice(-10)` を `slice(-3)` 等に変更する。呼び出し側の変更不要
- **(C) detectPrompt()に末尾位置検証を追加する方式**: 検出されたパターンが出力の末尾N行以内にあるかを検証するロジックを追加。検索範囲は広いまま維持し、結果のフィルタリングで対処

設計時に各方式のトレードオフを分析し、根拠とともに選択すること。

#### 優先順位変更のトレードオフ

入力プロンプト(❯)検出を最優先にする場合、以下のエッジケースに注意が必要:
- **❯プロンプト表示行の直前にyes/noプロンプトがある場合**: Claude CLIが質問直後に新しいプロンプトを出す場合、本来waitingであるべき状態がreadyと誤判定される可能性がある
- 設計時にこのケースの挙動を明確に定義し、テストケースとして含めること

### ロジック重複の解消

`route.ts` と `[id]/route.ts` のステータス検出ロジック（行47-111）が完全に同一であるため、共通関数への抽出を検討する。

## 受け入れ条件

- [ ] 1. `❯`プロンプトが出力末尾にある場合、ステータスは `ready` と表示されること
- [ ] 2. 過去の `(y/n)` プロンプトがスクロールバックに残っていても、末尾が`❯`の場合、ステータスは `ready` と表示されること
- [ ] 3. thinkingインジケーター（`✻`等）が末尾にある場合、ステータスは `running` と表示されること
- [ ] 4. `(y/n)` プロンプトが末尾にある場合、ステータスは `waiting` と表示されること
- [ ] 5. 既存の正常なステータス表示が壊れないこと（回帰テスト）
- [ ] 6. `route.ts` と `[id]/route.ts` の両方に修正が適用されていること

## 影響範囲

- `src/app/api/worktrees/route.ts` - ステータス検出ロジック
- `src/app/api/worktrees/[id]/route.ts` - 同一のステータス検出ロジック（重複コード）
- `src/lib/prompt-detector.ts` - プロンプト検出関数（検索範囲の制限）
- `src/lib/auto-yes-manager.ts` - `pollAutoYes()` 関数内でも `detectPrompt()` を使用（行290付近）。今回の `detectPrompt()` の検索範囲変更は auto-yes ポーリングにも波及する。ただし auto-yes には Layer 1（thinking状態スキップ）による防御が別途あるため、影響度は限定的

## スクリーンショット

調査時に確認した問題（スクリーンショットなし、テキスト記録のみ）：
- feature/161-worktree: `❯`プロンプト表示なのに青スピナー（running）
- develop: `❯ Issue #177 を対応して`表示なのに黄色（waiting）

## 関連

- Issue #4 (CLIツールサポート)
- Issue #31 (サイドバーUX改善)
- Issue #161 (Auto-Yes誤検出修正 - prompt-detector.ts の2パス検出方式。同じファイルへの変更であり密接に関連)
- Issue #152 (セッション初回メッセージ送信の信頼性向上 - プロンプト検出強化)
