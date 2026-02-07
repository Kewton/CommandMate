> **Note**: このIssueは 2026-02-07 に影響範囲レビュー2回目（Stage 7）の結果を反映して更新されました。
> 詳細: dev-reports/issue/180/issue-review/

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

**補足**: route.ts では cleanOutput（全文）を `detectPrompt()` に渡しているのに対し、`status-detector.ts` では lastLines（最後15行）を渡している。この前処理の不一致も問題の一因であり、共通関数化の際に統一が必要。status-detector.ts の方式（最後N行に切り出してから渡す）が本 Issue の修正方針と整合しているが、status-detector.ts では15行、本 Issue では2-3行を提案しており、この差異も設計時に検討すること。

### 問題2: 末尾検証の欠如

検出されたパターンが出力の「末尾」（現在のカーソル位置付近）にあるかを確認していない。
`❯`入力プロンプトが出力の最後にあれば「ready」のはずだが、その確認が行われていない。

### 問題3: thinking検出の範囲が広すぎる

`detectThinking()`が最後15行を検索するため、過去の出力にスピナー文字（`✻`等）があると誤検出の可能性がある。

**補足**: `detectThinking()` の呼び出し箇所ごとに入力範囲が異なる点にも注意が必要:
- `route.ts` / `[id]/route.ts`: lastLines（最後15行の非空行）に対して呼び出し
- `auto-yes-manager.ts`（行284）: cleanOutput 全文に対して呼び出し
- `current-output/route.ts`: 同様に cleanOutput に対して呼び出し

auto-yes-manager.ts で全文を渡しているのは、thinking 中の prompt 検出スキップが目的であり、末尾限定にすると防御効果が減少する可能性がある。設計時にこの不一致を統一すべきかどうかを明確にすること。

## 修正案

### 現在のロジック（問題あり）

```typescript
// route.ts (行56-84のisRunning内ロジック、forループ全体は行47-111)
// route.ts と [id]/route.ts の両方に同一コードが存在
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

**注意**: `status-detector.ts` の `detectSessionStatus()` が既に類似の優先順位構造を実装している（1.interactivePrompt -> 2.thinking -> 3.inputPrompt -> 4.time-based -> 5.default）。ただし、このモジュールはアプリケーション内で一切使用されていない（テストのみ）。このモジュールはIssue #54で作成されたが、route.ts側のインラインロジックが先に統合されたため、未使用のまま残存していると考えられる。設計方針書で、`detectSessionStatus()` を拡張して使用するか、新規に共通関数を作成するかを比較検討すること。`detectSessionStatus()` を使用する場合、既存のテスト（`src/lib/__tests__/status-detector.test.ts`）も活用できる利点がある。

#### 軸2: detectPrompt() の検索範囲制限

`detectPrompt()` 内部の検索範囲が広すぎる問題への対処方式として、以下の3つの選択肢がある:

- **(A) route.ts側で末尾N行に切り出してからdetectPrompt()に渡す方式**: route.tsの呼び出し側で `cleanOutput` の末尾2-3行を切り出し、`detectPrompt()` に渡す。`detectPrompt()` 自体の変更不要
- **(B) detectPrompt()内部の検索範囲を制限する方式**: `detectPrompt()` の `slice(-10)` を `slice(-3)` 等に変更する。呼び出し側の変更不要
- **(C) detectPrompt()に末尾位置検証を追加する方式**: 検出されたパターンが出力の末尾N行以内にあるかを検証するロジックを追加。検索範囲は広いまま維持し、結果のフィルタリングで対処

設計時に各方式のトレードオフを分析し、根拠とともに選択すること。

**各方式の影響ファイル一覧**:

| 方式 | 変更対象ファイル | 影響範囲 |
|------|-----------------|---------|
| **(A) route.ts側切り出し** | `route.ts` x2 のみ | 最も限定的。ただし根本的修正ではない（他の呼び出し元で同じ問題が起きうる） |
| **(B) detectPrompt内部制限** | `detectPrompt()` を呼ぶ全8ファイル: `route.ts` x2, `current-output/route.ts`, `prompt-response/route.ts`, `response-poller.ts`, `claude-poller.ts`, `auto-yes-manager.ts`, `status-detector.ts` | 最も広範囲。全呼び出し箇所のテストが必要 |
| **(C) 末尾位置検証追加** | 方式Bと同範囲 | 検索自体は広いまま維持し、結果のフィルタリングで対処 |

方式Bは最も広範囲に影響するため、全呼び出し箇所のテストが必要。方式Aは影響範囲が最も限定的だが、根本的な修正にはならない（他の呼び出し元で同じ問題が起きうる）。方式選択の判断材料としてこの一覧を活用すること。

**方式B/Cにおける response-poller.ts の個別分析**: response-poller.ts には `detectPrompt()` の呼び出しが3箇所あり、それぞれ用途が異なる。行248・行442は `extractResponse()` 内でインタラクティブプロンプト検出による完了判定に使用され、行556は `checkForResponse()` 内で完了レスポンスがプロンプトかどうかを `result.response`（抽出済みレスポンス全文）で再判定する。方式B/Cで検索範囲を制限する場合、行556の呼び出しは入力データの性質が他の2箇所と異なるため、個別に影響を分析する必要がある。

#### 優先順位変更のトレードオフ

入力プロンプト(❯)検出を最優先にする場合、以下のエッジケースに注意が必要:
- **❯プロンプト表示行の直前にyes/noプロンプトがある場合**: Claude CLIが質問直後に新しいプロンプトを出す場合、本来waitingであるべき状態がreadyと誤判定される可能性がある
- 設計時にこのケースの挙動を明確に定義し、テストケースとして含めること

### ロジック重複の解消

`route.ts` と `[id]/route.ts` のステータス検出ロジック（行47-111のforループ内、コアロジックは行56-84）が完全に同一であるため、共通関数への抽出を検討する。`status-detector.ts` の `detectSessionStatus()` が既に同等の構造を持っているため、このモジュールを共通関数として活用することで、ロジック重複を解消できる可能性がある。

## detectPrompt() コールマップ

`detectPrompt()` を呼び出している全箇所の一覧。検索範囲変更の方式選択により影響範囲が異なるため、設計時に参照すること。

| 呼び出し元ファイル | 呼び出し箇所 | 入力内容 | 目的 |
|-------------------|-------------|---------|------|
| `src/app/api/worktrees/route.ts` | 行62 | `cleanOutput`（全文） | ステータス検出 |
| `src/app/api/worktrees/[id]/route.ts` | 行62 | `cleanOutput`（全文） | ステータス検出 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 行88 | `cleanOutput`（全文、ただしthinking検出時はdetectPrompt自体をスキップ）。**注意**: thinking検出（行83）は `lastSection`（最後15行の非空行）に対して行われるため、thinking検出の入力スコープとdetectPromptの入力スコープ（全文）が非対称である。thinkingインジケーターが15行以上前に表示されている場合、thinking検出に失敗しdetectPromptがスキップされずに呼ばれる可能性がある（既存のIssue #161設計と一致した動作であり、thinkingの「最近の出力」限定は意図的な可能性が高い） | Auto-Yesクライアント側入力 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 行75 | 5000行分のキャプチャ出力 | プロンプト再検証（レースコンディション防止） |
| `src/lib/response-poller.ts` | 行248, 行442, 行556 | 行248: `cleanFullOutput`（全文）、行442: `fullOutput`（全文）、行556: `result.response`（抽出済みレスポンス全文） | 行248/442: レスポンス抽出時のプロンプト検出、行556: 完了レスポンスのプロンプト再判定 |
| `src/lib/claude-poller.ts` | 行164, 行232 | `fullOutput` / `result.response`（全文） | レスポンス抽出（レガシー） |
| `src/lib/auto-yes-manager.ts` | 行290 | 全文（thinking検出時はdetectPrompt自体をスキップ） | サーバー側Auto-Yesポーリング |
| `src/lib/status-detector.ts` | 行80（detectSessionStatus内） | `lastLines`（stripAnsi適用後の最後15行の結合文字列） | ステータス検出（未使用モジュール） |

**注意**: `claude-poller.ts` は `session-cleanup.ts` および `cli-tools/manager.ts` から `stopPolling` が import されているため、完全には未使用ではない。ただし `startPolling` は呼び出されておらず、ポーリングのメインパスでは `response-poller.ts` が使用されている。`detectPrompt()` の呼び出し（行164, 行232）はポーリングが開始されない限り到達しないため、修正の優先度は低い。

## 受け入れ条件

### 機能要件

- [ ] 1. `❯`プロンプトが出力末尾にある場合、ステータスは `ready` と表示されること
- [ ] 2. 過去の `(y/n)` プロンプトがスクロールバックに残っていても、末尾が`❯`の場合、ステータスは `ready` と表示されること
- [ ] 3. thinkingインジケーター（`✻`等）が末尾にある場合、ステータスは `running` と表示されること
- [ ] 4. `(y/n)` プロンプトが末尾にある場合、ステータスは `waiting` と表示されること
- [ ] 5. 既存の正常なステータス表示が壊れないこと（回帰テスト）
- [ ] 6. `route.ts` と `[id]/route.ts` の両方に修正が適用されていること（共通関数化により1箇所での修正で両方に反映される場合はそれで可）

### テスト要件

以下の既存テストが全てパスすること:
- [ ] 7. `tests/unit/prompt-detector.test.ts` - 特に Issue #161 で追加された「False Positive Prevention」と「Defense Layer Boundary Tests」セクションの回帰テストがパスすること
- [ ] 8. `tests/unit/lib/auto-yes-manager.test.ts` - `pollAutoYes` の thinking スキップテストがパスすること
- [ ] 9. `tests/unit/api/prompt-response-verification.test.ts` - プロンプト再検証テストがパスすること
- [ ] 10. `src/lib/__tests__/status-detector.test.ts` - status-detector テストがパスすること
- [ ] 11. `src/lib/__tests__/cli-patterns.test.ts` および `tests/unit/lib/cli-patterns.test.ts` - `detectThinking` テストがパスすること（両ファイルに detectThinking のテストが存在する）

### UI表示確認

以下のUIコンポーネントの表示が正常であることを確認すること（API側ステータス判定の変更が間接的に影響するため）:
- [ ] 12. `WorktreeDetailRefactored` のヘッダーステータス表示が正常であること
- [ ] 13. `WorktreeCard` のステータスドット表示が正常であること
- [ ] 14. サイドバーの `cliStatus` ドット表示（`BranchListItem`）が正常であること

## 影響範囲

### 直接変更対象（ステータス検出ロジック）

- `src/app/api/worktrees/route.ts` - ステータス検出ロジック
- `src/app/api/worktrees/[id]/route.ts` - 同一のステータス検出ロジック（重複コード）
- `src/lib/status-detector.ts` - 既存の `detectSessionStatus()` が本 Issue の修正方針と類似構造を持つ。共通関数として活用するか、ロジック重複解消の参照実装として検討すること

### detectPrompt() 関連（方式選択により影響範囲が変動）

- `src/lib/prompt-detector.ts` - プロンプト検出関数（方式B/Cの場合に変更）
- `src/app/api/worktrees/[id]/current-output/route.ts` - 行88で `detectPrompt(cleanOutput)` を呼び出し（thinking検出時はdetectPrompt自体がスキップされる）。このAPIが返す `isPromptWaiting` と `promptData` はクライアント側の `useAutoYes` フックに渡され、自動応答のトリガーとなる
- `src/app/api/worktrees/[id]/prompt-response/route.ts` - 行75で `detectPrompt()` によるプロンプト再検証（レースコンディション防止、Issue #161）。5000行分のキャプチャ出力に対して呼び出すため、方式Bの影響が大きい
- `src/lib/response-poller.ts` - `extractResponse()` 内で `detectPrompt(cleanFullOutput)`（行248）と `detectPrompt(fullOutput)`（行442）、および `checkForResponse()` 内で `detectPrompt(result.response)`（行556）の計3箇所で呼び出し。行556は完了レスポンスのプロンプト再判定であり、他の2箇所とは入力データの性質が異なる。方式Bの場合、ポーラーが有効なプロンプトを見逃す可能性がある
- `src/lib/claude-poller.ts` - `extractClaudeResponse()` で `detectPrompt(fullOutput)`（行164）と `detectPrompt(result.response)`（行232）を呼び出し。`stopPolling` は `session-cleanup.ts` および `cli-tools/manager.ts` から使用されているが、`startPolling` は呼び出されておらず、`detectPrompt()` 呼び出しは到達不能コードである
- `src/lib/auto-yes-manager.ts` - `pollAutoYes()` 関数内でも `detectPrompt()` を使用（行290）。Layer 1（thinking状態スキップ）による防御が別途あるため影響度は限定的だが、検索範囲変更は波及する

### 間接影響（UI表示）

- `src/hooks/useAutoYes.ts` - `current-output` API の結果を消費するクライアント側フック
- `src/components/worktree/WorktreeDetailRefactored.tsx` - API レスポンスの `isWaitingForResponse` / `isProcessing` フラグを参照してステータス表示
- `src/components/worktree/WorktreeCard.tsx` - ステータスドット表示
- `src/types/sidebar.ts` - `deriveCliStatus()` が `sessionStatusByCli` を変換
- `src/components/sidebar/BranchListItem.tsx` - サイドバーCLI別ステータスドット

### テストファイル

- `tests/unit/prompt-detector.test.ts` - detectPrompt() の直接テスト（835行、Issue #161の回帰テスト含む）
- `tests/unit/lib/auto-yes-manager.test.ts` - pollAutoYes の thinking スキップテスト
- `tests/unit/api/prompt-response-verification.test.ts` - プロンプト再検証テスト
- `src/lib/__tests__/status-detector.test.ts` - status-detector テスト
- `src/lib/__tests__/cli-patterns.test.ts` - detectThinking テスト
- `tests/unit/lib/cli-patterns.test.ts` - detectThinking テスト（行142-161）

## スクリーンショット

調査時に確認した問題（スクリーンショットなし、テキスト記録のみ）：
- feature/161-worktree: `❯`プロンプト表示なのに青スピナー（running）
- develop: `❯ Issue #177 を対応して`表示なのに黄色（waiting）

## 関連

- Issue #4 (CLIツールサポート)
- Issue #31 (サイドバーUX改善)
- Issue #161 (Auto-Yes誤検出修正 - prompt-detector.ts の2パス検出方式。同じファイルへの変更であり密接に関連)
- Issue #152 (セッション初回メッセージ送信の信頼性向上 - プロンプト検出強化)

---

## レビュー履歴

### イテレーション 1 - 影響範囲レビュー (2026-02-07)

- S3-001: `status-detector.ts` を影響範囲に追加。既存の `detectSessionStatus()` が本 Issue の修正方針と類似構造を持つことを記載
- S3-002: `response-poller.ts` と `claude-poller.ts` を影響範囲に追加。detectPrompt() コールマップを新設
- S3-003: `current-output/route.ts` と `useAutoYes.ts` を影響範囲に追加
- S3-004: `prompt-response/route.ts` を影響範囲に追加
- S3-005: 各方式（A/B/C）の影響ファイル一覧を修正案セクションに追加
- S3-006: テスト要件を受け入れ条件に追加（5ファイルの既存テストパス要件）
- S3-007: 問題1セクションに route.ts と status-detector.ts の前処理不一致を記載
- S3-008: 問題3セクションに detectThinking() の呼び出し箇所ごとの入力範囲不一致を記載
- S3-009: UI表示確認項目を受け入れ条件に追加
- S3-010: claude-poller.ts のレガシー可能性について注記を追加
- S3-011: 軸1セクションに status-detector.ts の既存実装活用の検討項目を追加

### イテレーション 2 - 通常レビュー2回目 (2026-02-07)

- S5-001: response-poller.ts の detectPrompt() 呼び出しを2箇所から3箇所（行248, 行442, 行556）に修正。行556の checkForResponse() 内の用途（完了レスポンスのプロンプト再判定）を追記
- S5-002: current-output/route.ts の入力内容説明を「thinkingスキップ後」から「全文、ただしthinking検出時はdetectPrompt自体をスキップ」に修正。スキップメカニズムが入力加工ではなく呼び出し回避であることを明確化
- S5-003: コールマップの行番号を実コードに合わせて修正。route.ts x2は「行62」（「行47付近」から修正）、current-output/route.tsは「行88」、prompt-response/route.tsは「行75」
- S5-004: コードスニペットのコメントを「行56-84のisRunning内ロジック、forループ全体は行47-111」に修正し、行番号範囲の意味を明確化
- S5-005: auto-yes-manager.ts の行番号を「行290付近」から「行290」に修正し、他の行番号記載との一貫性を確保
- S5-006: 方式B/Cにおける response-poller.ts の3箇所の detectPrompt() 呼び出しの個別分析の必要性を追記。行556の checkForResponse() 内の用途が他と異なることを明記
- S5-007: 受け入れ条件6に「共通関数化により1箇所での修正で両方に反映される場合はそれで可」の補足を追加
- S5-008: status-detector.ts が未使用である経緯（Issue #54で作成されたがroute.ts側のインラインロジックが先に統合されたため残存）を追記
- S5-009: コールマップの status-detector.ts 行に前処理パイプライン（stripAnsi適用後の最後15行の結合文字列）を明記

### イテレーション 2 - 影響範囲レビュー2回目 (2026-02-07)

- S7-001: 受け入れ条件11に `tests/unit/lib/cli-patterns.test.ts` を追加。テストファイルセクションにも同ファイルを追加。detectThinking のテストが2ファイルに存在することを明記
- S7-002: claude-poller.ts の注記を更新。`stopPolling` が `session-cleanup.ts` および `cli-tools/manager.ts` から import されていることを明記し、`startPolling` は呼び出されていないため `detectPrompt()` 呼び出しは到達不能コードであることを正確に記載。影響範囲セクションの claude-poller.ts の説明も同様に更新
- S7-003: コールマップの current-output/route.ts 行に、thinking検出（lastSection: 最後15行）と detectPrompt（cleanOutput: 全文）の入力スコープ非対称性に関する注記を追加
