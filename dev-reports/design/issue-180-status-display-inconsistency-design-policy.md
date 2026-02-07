# 設計方針書: Issue #180 ステータス表示の不整合修正

## 1. 概要

### 問題
CLIがidle状態（`❯`プロンプト表示）であるにも関わらず、UIが「running」（スピナー）や「waiting」（黄色）ステータスを誤表示する。根本原因はAPIレスポンス段階でステータス判定が誤っているため、全プラットフォーム（モバイル・デスクトップ共通）で発生する。

### 根本原因
1. **過去のプロンプト誤検出**: `detectPrompt()`が`cleanOutput`全文を受け取り、スクロールバックに残る過去の`(y/n)`プロンプトを現在アクティブなプロンプトとして誤検出
2. **末尾検証の欠如**: 検出されたパターンが出力の末尾（現在のカーソル位置付近）にあるか未確認
3. **検出優先順位の問題**: `detectPrompt`（interactive）が`promptPattern`（input prompt ❯）より先に評価され、過去のinteractive promptが残存すると常にwaitingと判定

### 修正方針
`status-detector.ts`の`detectSessionStatus()`を拡張し、`route.ts`x2のインラインロジックを共通関数に統合する。

---

## 2. 技術選定

### 方式選択: 方式A（route.ts側で末尾N行に切り出し）+ status-detector.ts共通化

#### 選定理由

| 方式 | 変更ファイル数 | リスク | 選定 |
|------|-------------|--------|------|
| **A: route.ts側切り出し** | 2ファイル（route.ts x2） | 最小。他の呼び出し元に影響なし | **採用** |
| B: detectPrompt内部制限 | 8ファイル以上 | 最大。全呼び出し元のテストが必要 | 不採用 |
| C: 末尾位置検証追加 | 8ファイル以上 | 方式Bと同等 | 不採用 |

**方式A採用の根拠**:
1. **影響範囲最小**: `route.ts`と`[id]/route.ts`のステータス検出ロジックのみ変更
2. **`detectPrompt()`は汎用関数**: `response-poller.ts`, `prompt-response/route.ts`, `auto-yes-manager.ts`等の呼び出し元は、それぞれの用途で適切な入力範囲を渡しており、これらの動作を変更すべきではない
3. **`status-detector.ts`が参照実装**: 既に`lastLines`（最後15行）に切り出してから`detectPrompt()`に渡す方式を実装済み。これを共通関数として活用することでDRY原則を満たす
4. **`claude-poller.ts`の`detectPrompt()`呼び出しは到達不能コード**: `startPolling`が呼ばれないため修正不要

#### 方式Aの制約と許容
- 他の呼び出し元（`response-poller.ts`等）で同じ問題が起きる可能性は残る
- ただし、これらは用途が異なる（レスポンス抽出、プロンプト再検証）ため、ステータス表示の不整合問題とは別の文脈
- 必要に応じて将来のIssueで個別対応

> **[DR-008] フォローアップ推奨**: `claude-poller.ts`の`detectPrompt()`呼び出しが到達不能コードである点は現在のスコープでは問題ないが、将来コードが到達可能になった場合に同じバグが顕在化するリスクがある。フォローアップタスクとして、到達不能コードの削除または同様の修正適用を検討すべきである。

> **[IS-005] claude-poller.ts到達不能性の脆弱性**: Stage 3影響分析レビューにより、`startPolling`が現在どこからもインポート・呼び出しされていないことが`grep`で確認された。ただし、この到達不能性の判定は静的解析ではなく検索に基づくものであり、将来のコード変更で容易に到達可能になり得る。フォローアップで`claude-poller.ts`にlegacy/deprecated マークのコードコメントを追加し、意図しない有効化を防止することを推奨する。

---

## 3. アーキテクチャ設計

### 変更対象モジュール構成

```
src/lib/status-detector.ts          <- 共通関数化（既存を拡張）
src/app/api/worktrees/route.ts      <- インラインロジック -> 共通関数呼び出し
src/app/api/worktrees/[id]/route.ts <- インラインロジック -> 共通関数呼び出し
```

### データフロー（修正後）

```
tmuxバッファ
  | captureSessionOutput(id, cliToolId, 100) -> 最後100行
  |
detectSessionStatus(rawOutput, cliToolId: CLIToolType)  <- status-detector.ts
  |-- 内部で stripAnsi(output) -> cleanOutput
  |-- 内部で lastLines = 最後15行 に切り出し
  |-- 1. detectPrompt(lastLines)   -> waiting  （末尾限定で誤検出防止）
  |-- 2. detectThinking(lastLines) -> running
  |-- 3. promptPattern.test(lastLines) -> ready
  '-- 4. default -> running (low confidence)
  |
route.ts: 結果を isWaitingForResponse / isProcessing に変換
```

> **[DR-001] stripAnsiの呼び出し契約**: `detectSessionStatus()`は**生のtmux出力（ANSIエスケープコード含む）**を受け取ることを契約とする。関数内部で`stripAnsi()`を呼び出すため、呼び出し側で事前にストリップする必要はない。route.tsでは`captureSessionOutput()`の戻り値をそのまま`detectSessionStatus()`に渡す。これにより、stripAnsiの二重呼び出し（DRY違反）を防止する。

> **[DR-005] DRY原則**: 上記の契約により、stripAnsiの呼び出しは`detectSessionStatus()`内部の1箇所に集約される。route.tsからの`stripAnsi`インポートは不要となる。

> **[DR-007] レイヤードウィンドウイングに関する注記**: `detectPrompt()`は内部で独自のウィンドウイングを適用する。y/nパターンは最後10行、multiple choiceパターンは最後50行が検索対象となる。`detectSessionStatus()`から`lastLines`（15行）を渡した場合の実効ウィンドウは以下の通り:
> - y/n検出: min(10, 15) = 10行
> - multiple choice検出: min(50, 15) = 15行
>
> この多層ウィンドウイングは許容される。外側の15行ウィンドウが過去のプロンプト誤検出を防ぐ主要な防御として機能し、`detectPrompt()`内部のウィンドウイングは追加の安全層として作用する。

### status-detector.ts の修正内容

現在の`detectSessionStatus()`は既に以下の優先順位を実装:
1. Interactive prompt (detectPrompt) -> waiting
2. Thinking indicator (detectThinking) -> running
3. Input prompt (promptPattern) -> ready
4. Time-based -> ready (low confidence)
5. Default -> running (low confidence)

**修正点**:
- **`detectPrompt()`への入力を`lastLines`（最後15行）に制限** -- 現在のコードで既に実装済み。変更不要
- **pending prompt cleanup ロジックの統合**: route.tsからの呼び出し時に`hasActivePrompt`フラグを参照してstale prompt cleanupを実行
- **`SessionStatus`型とroute.tsの`isWaitingForResponse`/`isProcessing`フラグのマッピング関数追加**

### route.ts の修正内容

現在のインラインロジック（行56-99、route.ts x2で完全重複、stale prompt cleanup含む）を`detectSessionStatus()`呼び出しに置き換え:

```typescript
// Before (行56-99のインラインステータス検出・クリーンアップロジック全体)
if (isRunning) {
  const output = await captureSessionOutput(worktree.id, cliToolId, 100);
  const cleanOutput = stripAnsi(output);
  const promptDetection = detectPrompt(cleanOutput);  // <- 全文を渡す（問題）
  if (promptDetection.isPrompt) {
    isWaitingForResponse = true;
  } else {
    // ... 15行でthinking/promptPattern判定
  }
}

// After (route.ts の場合。[id]/route.ts では worktree.id を params.id に読み替え)
if (isRunning) {
  const output = await captureSessionOutput(worktree.id, cliToolId, 100);
  const statusResult = detectSessionStatus(output, cliToolId);  // 生出力を渡す
  isWaitingForResponse = statusResult.status === 'waiting';
  isProcessing = statusResult.status === 'running';

  // Stale pending prompt cleanup
  // NOTE: !statusResult.hasActivePrompt === !promptDetection.isPrompt (C-004)
  if (!statusResult.hasActivePrompt) {
    const messages = getMessages(db, worktree.id, undefined, 10, cliToolId);
    const hasPendingPrompt = messages.some(
      msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
    );
    if (hasPendingPrompt) {
      markPendingPromptsAsAnswered(db, worktree.id, cliToolId);
    }
  }
}
```

---

## 4. 設計パターン

### Facade パターン（既存活用）
`detectSessionStatus()`がステータス検出の複雑な判定ロジックを隠蔽し、シンプルなインターフェースを提供。

> **[DR-004] Facadeの責務境界**: `detectSessionStatus()`の責務は以下に限定される:
> - 出力の前処理（ANSIストリップ、行抽出）
> - ステータス判定ロジック（prompt検出、thinking検出、promptPattern検出）
> - 判定結果の返却（`hasActivePrompt`含む）
>
> 以下はFacadeの責務外であり、呼び出し側（route.ts）が担当する:
> - stale pending promptのクリーンアップ（DB操作を伴う副作用）
> - `isWaitingForResponse`/`isProcessing`フラグへの変換（API固有のレスポンス形式）

### Strategy パターン（既存活用）
`getCliToolPatterns()`によるCLIツール別のパターン選択は既存のStrategy パターンをそのまま利用。

---

## 5. 詳細設計

### 5-1. status-detector.ts の変更

#### 変更箇所
- `detectSessionStatus()` の戻り値型に`hasActivePrompt`を追加（stale prompt cleanup用）
- `detectSessionStatus()` の入力パラメータの契約を明確化（生のtmux出力を期待）

```typescript
export interface StatusDetectionResult {
  status: SessionStatus;
  confidence: StatusConfidence;
  reason: string;
  /**
   * Whether an active interactive prompt (y/n, multiple choice) was detected
   * in the last N lines. Used by callers for stale prompt cleanup logic.
   * Does NOT expose internal PromptDetectionResult details (encapsulation).
   */
  hasActivePrompt: boolean;
}
```

> **[DR-002] 設計判断**: `promptDetection?: PromptDetectionResult`（完全なPromptDetectionResultオブジェクト）ではなく、`hasActivePrompt: boolean`を採用する。理由:
> - **単一責任原則（SRP）**: `StatusDetectionResult`はセッションステータスの結果を表現する型であり、内部検出アーティファクト（PromptDetectionResult）を公開APIに露出すべきではない
> - **カプセル化**: 呼び出し側（route.ts）のstale prompt cleanupロジックが必要とする情報は「アクティブなプロンプトが存在するか否か」のブーリアン値のみであり、プロンプトの種別やプロンプトテキスト等の内部詳細は不要
> - **変更耐性**: `PromptDetectionResult`の構造変更が`StatusDetectionResult`の利用者に波及しない

> **[IS-003] Stage 3 影響分析レビュー反映 -- 後方互換性の検証**: `StatusDetectionResult`に`hasActivePrompt: boolean`フィールドを追加することは後方互換である。これは以下の検証に基づく:
> - **読み取り側**: 既存の消費者（テストコード含む）は`status`, `confidence`, `reason`のみを参照しており、新フィールド追加でTypeScriptコンパイルエラーは発生しない
> - **構築側**: `StatusDetectionResult`オブジェクトを構築するコードは`status-detector.ts`内部のみに存在する。コード検索により、外部のモックやファクトリ関数で`StatusDetectionResult`リテラルを構築するコードが**存在しない**ことを確認済み。したがって、新しいrequiredフィールド追加でTypeScript strictモードのコンパイルエラーが外部に波及することはない
> - テストファイル（`status-detector.test.ts`）は`detectSessionStatus()`関数の戻り値を読み取るのみであり、`StatusDetectionResult`を直接構築していない

#### detectSessionStatus() 入力契約

> **[DR-001] 入力契約の明確化**: `detectSessionStatus()`の`output`パラメータは**生のtmux出力**（ANSIエスケープコード含む）を期待する。関数内部で`stripAnsi()`を呼び出すため、呼び出し側で事前にストリップしてはならない。JSDoc `@param output - Raw tmux output` はこの契約を反映している。

```typescript
import { CLIToolType } from './cli-tools/types';

/**
 * Detect session status from tmux output.
 * @param output - Raw tmux output (including ANSI escape codes).
 *                 This function handles ANSI stripping internally.
 * @param cliToolId - CLI tool identifier for pattern selection (CLIToolType: 'claude' | 'codex' | 'gemini').
 * @param lastOutputTimestamp - Optional timestamp (Date) for time-based heuristic.
 */
export function detectSessionStatus(
  output: string,
  cliToolId: CLIToolType,
  lastOutputTimestamp?: Date
): StatusDetectionResult;
```

> **[C-001/C-002] Stage 2 整合性レビュー反映**: 上記シグネチャは実コード (`src/lib/status-detector.ts`) と正確に一致する。`cliToolId`の型は`string`ではなく`CLIToolType`（`'claude' | 'codex' | 'gemini'`のユニオン型、`./cli-tools/types`からインポート）。`lastOutputTimestamp`の型は`number`ではなく`Date`（内部で`.getTime()`を呼び出して数値比較に使用）。

#### detectSessionStatus() 内部ロジック（変更なし確認）

現在のコード（行74-76）:
```typescript
const cleanOutput = stripAnsi(output);
const lines = cleanOutput.split('\n');
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
```

`STATUS_CHECK_LINE_COUNT = 15` で最後15行に制限してから`detectPrompt(lastLines)`を呼ぶ。これが Issue #180 の修正方針と整合。**この部分は変更不要**。

> **[DR-003] 空行フィルタリングの動作差異**: 現在のroute.tsのインラインロジック（行67）は空行をフィルタリングしてから最後15行を取得する（`nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '').slice(-15)`）。一方、`status-detector.ts`（行75-76）は空行を含めて最後15行を取得する（`lines.slice(-STATUS_CHECK_LINE_COUNT)`）。共通化により`status-detector.ts`の方式（空行を含む）に統一される。
>
> **この動作変更は許容される**:
> - tmux出力の末尾には通常、空のパディング行が存在する場合がある
> - 空行を含む15行でも、プロンプトパターンやthinkingパターンの検出精度に実質的な影響はない（正規表現は行内マッチングであり、空行はスキップされる）
> - `status-detector.ts`の既存テストが空行を含むケースをカバーしている
>
> **[IS-006] Stage 3 影響分析レビュー反映 -- tmux空行パディングリスクの明確化**: tmuxバッファには末尾に大量の空行パディングが含まれることがある。例えば、プロンプト行の後に20行以上の空行が存在する場合、`status-detector.ts`の15行ウィンドウには有用なコンテンツが含まれず、全て空行になる可能性がある。この場合、プロンプトパターンもthinkingパターンもマッチせず、default-to-running（低信頼度）となり、UIが誤って「running」を表示する。
>
> **対応方針**:
> 1. テスト補強（Section 8-2 テストケース7）で末尾に大量の空行がある場合を必ず検証する。特に、プロンプト行が15行ウィンドウの外に押し出されるシナリオをカバーする
> 2. 初期実装では現行の`STATUS_CHECK_LINE_COUNT=15`（空行含む）方式で進める
> 3. テスト結果で空行パディングによる誤検出が確認された場合、以下の対応を検討する:
>    - **Option A**: `STATUS_CHECK_LINE_COUNT`を増加（例: 30行）
>    - **Option B**: `status-detector.ts`に空行フィルタリングを追加（route.tsの旧方式と同等）
>    - **Option C**: 空行フィルタリング後に15行ウィンドウを適用するハイブリッド方式

#### hasActivePrompt の保持

`detectSessionStatus()`内で`detectPrompt()`の結果を`hasActivePrompt`フィールドに変換して返す:

```typescript
const promptDetection = detectPrompt(lastLines);
if (promptDetection.isPrompt) {
  return {
    status: 'waiting',
    confidence: 'high',
    reason: 'prompt_detected',
    hasActivePrompt: true,
  };
}
// ... 以降のロジック
return {
  status: ...,
  confidence: ...,
  reason: ...,
  hasActivePrompt: false,
};
```

### 5-2. route.ts / [id]/route.ts の変更

#### 削除するコード
行56-99のインラインステータス検出・クリーンアップロジック全体（stale prompt cleanup含む、以下と同等）:

> **[C-003] Stage 2 整合性レビュー反映**: 実際のroute.tsのステータス検出ロジックは行56-99に及ぶ（行84はelseブロックの閉じ括弧、行86-95がstale prompt cleanup、行96-99がtry-catchの閉じ）。行番号ではなくコードブロックの論理的境界（ステータス検出 + クリーンアップ全体）で範囲を定義する。
```typescript
const promptDetection = detectPrompt(cleanOutput);
if (promptDetection.isPrompt) {
  isWaitingForResponse = true;
} else {
  const nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '');
  const lastLines = nonEmptyLines.slice(-15).join('\n');
  if (detectThinking(cliToolId, lastLines)) {
    isProcessing = true;
  } else {
    const { promptPattern } = getCliToolPatterns(cliToolId);
    const hasInputPrompt = promptPattern.test(lastLines);
    if (!hasInputPrompt) {
      isProcessing = true;
    }
  }
}
```

#### 置き換えるコード

> **[C-005] Stage 2 整合性レビュー反映**: 以下のコード例は疑似コードとして記述している。実際のroute.tsでは`worktree.id`、`[id]/route.ts`では`params.id`を使用すること。下記の`{worktreeIdentifier}`はそれぞれのファイルに応じた変数に読み替えること。

> **[C-004] Stage 2 整合性レビュー反映**: Afterコードの`!statusResult.hasActivePrompt`条件は、現行route.tsの`!promptDetection.isPrompt`条件と**論理的に等価**である。`detectSessionStatus()`内部で`hasActivePrompt: true`がセットされるのは`detectPrompt().isPrompt === true`のときのみであるため、両条件は同一の判定結果を返す。ただし、将来`detectSessionStatus()`が`hasActivePrompt`を異なる条件（例: 追加の検出ロジック）で設定した場合、動作が変わる可能性がある。この間接参照は意図的であり、route.tsがdetectPromptの内部実装詳細ではなくdetectSessionStatusの公開API（hasActivePrompt）に依存することでカプセル化を維持する設計判断である。

```typescript
const statusResult = detectSessionStatus(output, cliToolId);  // 生出力を渡す（stripAnsi不要）
isWaitingForResponse = statusResult.status === 'waiting';
isProcessing = statusResult.status === 'running';

// Clean up stale pending prompts if no prompt is showing
// NOTE: !statusResult.hasActivePrompt is logically equivalent to !promptDetection.isPrompt
//       in the current implementation (see C-004 note above)
if (!statusResult.hasActivePrompt) {
  // route.ts: worktree.id / [id]/route.ts: params.id
  const messages = getMessages(db, worktree.id, undefined, 10, cliToolId);
  const hasPendingPrompt = messages.some(
    msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
  );
  if (hasPendingPrompt) {
    markPendingPromptsAsAnswered(db, worktree.id, cliToolId);
  }
}
```

#### import の変更
```typescript
// 削除
import { detectThinking, stripAnsi, getCliToolPatterns } from '@/lib/cli-patterns';
import { detectPrompt } from '@/lib/prompt-detector';

// 追加
import { detectSessionStatus } from '@/lib/status-detector';
```

注: `stripAnsi`のインポートも不要となる。`detectSessionStatus()`が内部でストリップを処理するため、route.tsから`captureSessionOutput()`の生の戻り値をそのまま渡す。

### 5-3. 優先順位変更のトレードオフ対応

#### エッジケース: 入力プロンプト直前にyes/noプロンプトがある場合

`status-detector.ts`の現在の優先順位:
1. `detectPrompt(lastLines)` -> waiting（最後15行でinteractive prompt検出）
2. `detectThinking()` -> running
3. `promptPattern` -> ready

**この優先順位は維持する**。理由:
- interactive prompt（y/n等）は最後15行に制限されるため、スクロールバック上の過去プロンプトは検出されない
- 最後15行以内にinteractive promptと入力プロンプトが共存する場合、interactive prompt優先は正しい（Claude CLIの動作として、y/nプロンプト表示中に入力プロンプトは表示されない）
- `status-detector.ts`の既存テストがこの優先順位をカバー

---

## 6. セキュリティ設計

### 既存のセキュリティ対策の継承
- `captureSessionOutput()`の行数制限（100行）: DoS防止
- `stripAnsi()`: ANSIエスケープコードの除去
- `STATUS_CHECK_LINE_COUNT = 15`: 検索範囲の制限

### 新たなセキュリティリスク
本修正で新たなセキュリティリスクは発生しない。共通関数化によりコード重複が解消され、セキュリティ修正の適用漏れリスクが低減する。

> **[SEC-008] DRY原則によるセキュリティ改善**: 本変更の主要なセキュリティ上の利点は、2つのroute.tsファイルにまたがるステータス検出ロジックの重複排除である。現状では、ステータス検出ロジックへのセキュリティ修正を3箇所（status-detector.ts、route.ts、[id]/route.ts）に適用する必要がある。変更後はstatus-detector.tsの1箇所のみとなる。これにより、部分的なセキュリティパッチ適用（脆弱性の一般的な原因）のリスクが低減する。

> **[SEC-009] 空行ウィンドウイングによるステータス誤表示リスク**: tmuxバッファの末尾に大量の空行パディングが存在する場合、プロンプト行が15行ウィンドウの外に押し出される可能性がある。この場合、`detectSessionStatus()`はdefault-to-running（低信頼度）を返し、UIが誤って「running」（スピナー）を表示する。これは伝統的なセキュリティ脆弱性ではないが、ステータスの誤表示はユーザーの混乱を招く可能性がある。auto-yesが有効な環境では、正確なステータス検出が自動応答の判断に影響し得る（ただし、auto-yesパスは独自の検出ロジックを使用するため、本コードパスとは独立）。テスト補強（Section 8-2 テストケース7b）による検証と、結果に基づく`STATUS_CHECK_LINE_COUNT`調整または空行フィルタリング追加で対応する。

### Stage 4 セキュリティレビュー観察事項

Stage 4セキュリティレビュー（2026-02-07）により、以下の事前存在条件と安全性確認が記録された。これらは本Issue #180で導入されるものではなく、既存コードベースの観察事項である。

| ID | カテゴリ | 観察内容 | リスク | 対応 |
|----|---------|---------|--------|------|
| SEC-001 | ANSI Injection | `stripAnsi()`パターンはCSI/OSC/orphaned SGRをカバーするが、C1制御コード（0x80-0x9F）、APC/PM/SOSシーケンス、ST終端OSCシーケンスは未対応。tmux出力（信頼されたローカルプロセス）が入力源であるため、悪意あるANSIシーケンスのリスクは無視できる | 無視可能 | 将来のハードニングパスでstrip-ansi npmパッケージ等の採用を検討 |
| SEC-002 | ReDoS | 本変更はReDoS耐性を**改善**する。正規表現処理ウィンドウが最大100行から15行に縮小。全パターンがアンカー付きまたは有界量指定子を使用 | 無視可能（改善） | 対応不要 |
| SEC-003 | 情報漏洩 | エラーハンドリングのcatchブロックは汎用エラーメッセージを返却し、スタックトレースをクライアントに露出しない。既存動作を変更しない | 無視可能 | 対応不要 |
| SEC-004 | レースコンディション | `hasActivePrompt`は`detectPrompt()`から同期的に導出されるため、新たなTOCTOUウィンドウは発生しない | 無視可能 | 対応不要 |
| SEC-005 | DoS / パフォーマンス | 正規表現処理ウィンドウの縮小（100行 -> 15行）はDoS耐性を改善する | 無視可能（改善） | 対応不要 |
| SEC-006 | 入力検証 | ステータス検出はtmux出力（サーバー側キャプチャ）に対して動作し、ユーザー供給のHTTPリクエストデータは直接処理しない。`cliToolId`はTypeScriptの型システムで制約。worktree IDはDBから取得 | 無視可能 | 対応不要 |
| SEC-007 | XSS / 出力エンコーディング | APIレスポンス形式（boolean/object値）は変更なし。Reactの自動エスケープで保護。新たな文字列値のUI描画は発生しない | 無視可能 | 対応不要 |
| SEC-010 | Defense in Depth | `stripAnsi()`が行分割前の生tmux出力に対して呼び出される順序は正しい。複数行ANSIシーケンスによる誤った行境界を防止。統合後もこの順序は維持される | 無視可能 | 対応不要 |

### OWASP Top 10 チェックリスト（Stage 4検証済み）

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| A01: アクセス制御の不備 | PASS | アクセス制御変更なし。エラーハンドリングで機密情報非露出 |
| A02: 暗号化の失敗 | N/A | 暗号化操作なし |
| A03: インジェクション | PASS | 新たなインジェクションベクターなし。stripAnsiがANSIコード処理。tmux出力は信頼されたローカルプロセス |
| A04: 安全でない設計 | PASS | 重複ロジック統合により保守性向上、セキュリティ修正漏れリスク低減 |
| A05: セキュリティ設定ミス | N/A | 設定変更なし |
| A06: 脆弱なコンポーネント | N/A | 新規依存なし |
| A07: 認証の失敗 | N/A | 認証/セッション管理変更なし |
| A08: ソフトウェアとデータ整合性の失敗 | PASS | デシリアライゼーション/CI/CDパイプライン変更なし |
| A09: ログとモニタリングの失敗 | PASS | 既存のログ出力を維持 |
| A10: SSRF | N/A | サーバーサイドリクエストフォージェリベクターなし |
| ReDoS安全性 | PASS | 入力ウィンドウ100行から15行に縮小。全パターンがアンカー付き・有界量指定子使用 |
| レースコンディション | PASS | 新たなTOCTOUウィンドウなし。hasActivePromptは同期的に導出 |
| ANSI Injection | PASS | stripAnsiが行分割前に呼び出される。tmux出力に対して十分なカバレッジ |

---

## 7. パフォーマンス設計

### パフォーマンスへの影響
- **改善**: `route.ts`で`detectPrompt(cleanOutput)`（全文検索）-> `detectPrompt(lastLines)`（最後15行検索）に変更されるため、正規表現のマッチング対象が大幅に縮小
- **中立**: 共通関数呼び出しのオーバーヘッドは無視できるレベル
- **改善**: ロジック重複解消により、将来の最適化が1箇所で済む

---

## 8. テスト戦略

### 8-1. 既存テストの活用

`src/lib/__tests__/status-detector.test.ts`に既に包括的なテストが存在:
- ready（input prompt検出）
- running（thinking indicator検出）
- waiting（interactive prompt検出）
- edge cases（空出力、ANSI、15行制限）

これらのテストは全てパスすることが必須（回帰テスト）。

### 8-2. 新規テスト追加

#### Issue #180 固有のテストケース（status-detector.test.ts に追加）

1. **過去のy/nプロンプト + 末尾入力プロンプト**: 15行以上前にy/nプロンプトがある場合 -> ready
2. **過去のmultiple choice + 末尾入力プロンプト**: 50行以上前にmultiple choice promptがある場合 -> ready
3. **末尾にy/nプロンプト**: 最後の数行にy/nプロンプトがある場合 -> waiting
4. **末尾にmultiple choice**: 最後の数行にmultiple choice promptがある場合 -> waiting
5. **route.ts統合テスト**: `detectSessionStatus()`の戻り値からisWaitingForResponse/isProcessingへの変換が正しいこと
6. **hasActivePrompt検証**: プロンプト検出時に`hasActivePrompt: true`、非検出時に`hasActivePrompt: false`が返却されること
7. **[DR-003/IS-006/SEC-009] 末尾空行テスト（強化版）**: 末尾に多数の空行を含む出力でステータスが正しく検出されること。以下のサブシナリオを含む:
   - (a) 末尾に5行の空行パディング + 入力プロンプト -> ready（プロンプトが15行ウィンドウ内に収まる場合）
   - (b) **[SEC-009]** 末尾に20行以上の空行パディング + 入力プロンプト -> プロンプト行が15行ウィンドウの**外**に押し出される場合の動作を検証。default-to-running（低信頼度）が期待される場合、これが問題であれば`STATUS_CHECK_LINE_COUNT`の調整または空行フィルタリング追加の根拠とする。セキュリティレビューにより、このテストの実施がSTATUS_CHECK_LINE_COUNT判断の根拠として必須と指摘されている
   - (c) 末尾に10行の空行パディング + y/nプロンプト -> waiting（プロンプトが15行ウィンドウ内に収まる場合）
8. **[DR-001] 生出力テスト**: ANSIエスケープコード含む生出力を直接`detectSessionStatus()`に渡し、正しくストリップ・検出されること

### 8-3. 既存テストのパス確認

以下の全テストがパスすること:
- `tests/unit/prompt-detector.test.ts`（Issue #161回帰テスト含む）
- `tests/unit/lib/auto-yes-manager.test.ts`
- `tests/unit/api/prompt-response-verification.test.ts`
- `src/lib/__tests__/status-detector.test.ts`
- `src/lib/__tests__/cli-patterns.test.ts`
- `tests/unit/lib/cli-patterns.test.ts`

---

## 9. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ | レビュー指摘 |
|---------|------|-------------|------------|
| 方式A採用 | 影響範囲最小、既存の`status-detector.ts`活用 | 他の呼び出し元の同問題は未修正（別Issue対応） | - |
| `status-detector.ts`共通化 | DRY原則、既存テスト活用 | 既存の未使用モジュールへの依存発生 | - |
| 優先順位維持 | `status-detector.ts`の既存設計が適切 | 入力プロンプト直前にy/nがある超エッジケースでwaiting判定 | - |
| `STATUS_CHECK_LINE_COUNT=15` 維持 | 既存値、テスト済み | 2-3行ではなく15行（保守的選択） | - |
| `hasActivePrompt: boolean`採用 | SRP遵守、カプセル化維持 | `StatusDetectionResult`から詳細なプロンプト情報は取得不可 | DR-002 |
| `hasActivePrompt`フィールド追加は後方互換 | 既存テスト（status-detector.test.ts）はstatus/confidence/reasonのみ検証しており、新フィールド追加でテスト破壊なし。TypeScriptインターフェースはフィールド追加に対して安全。**[IS-003] 外部でStatusDetectionResultを構築するコードが存在しないことをコード検索で確認済み** | 既存テストでhasActivePromptの値を検証していないため、新テスト追加が必要（Section 8-2 テスト項目6でカバー） | C-006, IS-003 |
| `detectPrompt()`自体は変更しない | 汎用関数として他の用途（auto-yes, response-poller）で使用中 | `prompt-detector.ts`の根本修正は別Issue | - |
| `detectSessionStatus()`は生出力を受け取る | DRY原則（stripAnsi二重呼び出し防止）、既存JSDoc契約と整合 | 呼び出し側でストリップ済み出力を再利用できない（必要な場合は個別にstripAnsi呼び出し） | DR-001, DR-005 |
| 空行フィルタリングはstatus-detector.ts方式に統一 | 既存のテスト済みロジックを採用、空行は検出精度に実質影響なし | route.tsの旧動作（空行除外後15行）とは微妙に異なるウィンドウ。**[IS-006/SEC-009] tmux空行パディングでプロンプトがウィンドウ外に出るリスクあり -- テスト補強で検証。セキュリティレビューにより、空行フィルタリングがより安全なデフォルトとして推奨** | DR-003, IS-006, SEC-009 |
| `lastOutputTimestamp`はroute.tsから渡さない | 現在のアーキテクチャではAPI層で出力タイムスタンプを追跡していない。`lastOutputTimestamp`未指定時はtime-basedヒューリスティック（priority 4: 'no_recent_output'）がスキップされ、default-to-running フォールバックとなるが、これは安全な動作（false negativeよりfalse positiveの方が許容できる） | time-basedヒューリスティックが活用されない | DR-006 |

### 将来の検討事項

| 項目 | 内容 | レビュー指摘 |
|------|------|------------|
| `claude-poller.ts`の到達不能コード | `detectPrompt()`呼び出しが到達不能コードとして存在する。将来`startPolling`が有効化された場合、同じバグ（全文渡しによる誤検出）が顕在化するリスクがある。到達不能コードの削除、または到達可能になった時点での同様の修正適用を検討すべき。**[IS-005] legacy/deprecatedマークのコードコメント追加を推奨し、意図しない有効化を防止する** | DR-008, IS-005 |
| 他の呼び出し元への適用 | `response-poller.ts`等の他の`detectPrompt()`呼び出し元でも末尾制限の適用が有益な可能性がある。ただし用途が異なるため、個別のIssueで対応。**[IS-004] Stage 3影響分析レビューにより、response-poller.tsの3箇所のdetectPrompt呼び出し（行248, 442, 556）が全て全文出力を渡していることが確認された。これらはレスポンス抽出目的であり、ステータス表示とは異なる用途であるため、本Issueのスコープ外は妥当** | IS-004 |
| **[IS-007] `auto-yes-manager.ts`の同一脆弱性パターン** | `auto-yes-manager.ts`（行290）の`detectPrompt(cleanOutput)`は最大5000行の全文クリーン出力を渡している。これはroute.tsで修正する問題と同一のパターンである。thinking skip（Layer 1, 行284）と`detectPrompt()`内部のウィンドウイング（y/n: 最後10行、multiple choice: 最後50行）が部分的な防御を提供するが、過去のy/nプロンプトが全文出力の最後10行以内に残存している場合、誤検出が発生し得る。フォローアップIssueで、`auto-yes-manager.ts`にも末尾N行制限を適用することを検討すべき | IS-007 |
| **[IS-001] `current-output/route.ts`の同一脆弱性パターン** | `src/app/api/worktrees/[id]/current-output/route.ts`（行88）も`detectPrompt(cleanOutput)`に全文クリーン出力を渡している。thinking skip（Layer 1）が防御層として機能するものの、route.tsと同じ根本的な脆弱性パターンを持つ。本Issueのスコープでは「独自のthinking skipロジックあり、影響なし」として変更対象外としているが、フォローアップ候補として`response-poller.ts`、`claude-poller.ts`と並んで管理すべき | IS-001 |

---

## 10. 実装順序

1. `status-detector.ts`: `StatusDetectionResult`に`hasActivePrompt: boolean`フィールド追加、`detectSessionStatus()`で`detectPrompt()`結果をboolean変換して保持
2. `status-detector.ts`: 入力パラメータのJSDocを更新（生出力を期待する契約を明記）
3. `status-detector.test.ts`: Issue #180固有のテストケース追加（Red）
4. `status-detector.ts`: テストがパスすることを確認（Green -- 既存ロジックで対応済みのはず）
5. `route.ts`: インラインロジック -> `detectSessionStatus(output, cliToolId)`呼び出しに置き換え（生出力を渡す）
6. `[id]/route.ts`: 同上
7. 全テスト実行・回帰テスト確認
8. リファクタリング: 不要なimport削除（`stripAnsi`, `detectThinking`, `getCliToolPatterns`, `detectPrompt`）

---

## 11. 影響範囲サマリー

### 直接変更ファイル（3ファイル）
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/status-detector.ts` | `StatusDetectionResult`に`hasActivePrompt: boolean`追加、JSDoc更新 |
| `src/app/api/worktrees/route.ts` | インラインロジック -> `detectSessionStatus()`呼び出し、`stripAnsi`呼び出し削除 |
| `src/app/api/worktrees/[id]/route.ts` | 同上 |

### テスト変更ファイル（1ファイル）
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/__tests__/status-detector.test.ts` | Issue #180固有テストケース追加（hasActivePrompt検証、空行テスト含む） |

### 変更しないファイル（影響なし確認済み）
| ファイル | 理由 | 備考 |
|---------|------|------|
| `src/lib/prompt-detector.ts` | 汎用関数、変更不要 | - |
| `src/lib/response-poller.ts` | 用途が異なる（レスポンス抽出）、方式Aでは影響なし | [IS-004] 3箇所のdetectPrompt呼び出しが全文出力を渡すが、用途が異なるためスコープ外は妥当。将来のフォローアップ候補 |
| `src/lib/claude-poller.ts` | detectPrompt呼び出しは到達不能コード（将来のフォローアップ候補: DR-008） | [IS-005] startPollingがどこからも呼ばれていないことをgrep確認済み。legacy/deprecatedコメント追加を推奨 |
| `src/lib/auto-yes-manager.ts` | 独自のthinking skipロジックあり、影響なし | **[IS-007] 同一脆弱性パターンあり（行290: detectPrompt(cleanOutput)で最大5000行の全文を渡す）。thinking skipとdetectPrompt内部ウィンドウイングが部分防御を提供するが、完全ではない。フォローアップ候補** |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 独自のthinking skipロジックあり、影響なし | **[IS-001] 同一脆弱性パターンあり（行88: detectPrompt(cleanOutput)で全文を渡す）。フォローアップ候補** |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | レースコンディション防止用、影響なし | - |

### APIレスポンス消費側（影響なし確認済み）

> **[IS-002] Stage 3 影響分析レビュー反映**: APIレスポンス形式（`isWaitingForResponse`, `isProcessing`, `sessionStatusByCli`）は変更されないため、以下の下流コンポーネントは全て影響を受けない。網羅的なリストとして明記する。

| ファイル | 消費するフィールド | 影響 |
|---------|-----------------|------|
| `src/types/models.ts` | `Worktree`インターフェース定義（`isWaitingForResponse`, `isProcessing`, `sessionStatusByCli`） | なし -- データモデル定義は変更不要 |
| `src/types/sidebar.ts` | `deriveCliStatus()`が`sessionStatusByCli`を消費 | なし -- API形式不変 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `sessionStatusByCli`からCLIタブのステータスドット表示 | なし -- API形式不変 |
| `src/components/worktree/WorktreeCard.tsx` | `isWaitingForResponse`からバッジ表示 | なし -- API形式不変 |
| `src/contexts/WorktreeSelectionContext.tsx` | `isProcessing`/`isWaitingForResponse`からポーリング間隔決定 | なし -- API形式不変 |

---

## 12. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（2026-02-07）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応状況 |
|----|--------|---------|---------|---------|
| DR-001 | must_fix | DRY | `detectSessionStatus()`の入力契約（生出力 vs ストリップ済み）が不明確。route.tsとdetectSessionStatus内部でstripAnsiが二重呼び出しになる | 対応済み: 生出力を受け取る契約を明記、route.tsからstripAnsi呼び出しを削除（Section 3, 5-1, 5-2） |
| DR-002 | should_fix | SOLID | `promptDetection?: PromptDetectionResult`フィールドがSRP違反。内部検出詳細をStatusDetectionResultの公開APIに露出 | 対応済み: `hasActivePrompt: boolean`に変更（Section 5-1, 9） |
| DR-003 | should_fix | KISS | route.tsとstatus-detector.tsで空行フィルタリングの動作が異なる。共通化時の動作変更が未説明 | 対応済み: 動作差異と許容理由を文書化、テストケース追加を明記（Section 5-1, 8-2, 9） |
| DR-007 | should_fix | KISS | `detectPrompt()`内部のレイヤードウィンドウイング（y/n: 10行、multiple choice: 50行）が未文書化 | 対応済み: レイヤードウィンドウイングの注記をSection 3に追加 |
| DR-004 | nice_to_have | SOLID | Facadeパターンの責務境界が未定義 | 対応済み: Facadeの責務境界をSection 4に明記 |
| DR-005 | nice_to_have | DRY | stripAnsiの二重呼び出し（DR-001のDRY観点再掲） | 対応済み: DR-001の対応で解決（Section 3） |
| DR-006 | nice_to_have | YAGNI | `lastOutputTimestamp`がroute.tsから渡されない理由が未文書化 | 対応済み: 設計判断としてSection 9に追加 |
| DR-008 | nice_to_have | SOLID | `claude-poller.ts`の到達不能コードに基づく設計判断の脆弱性 | 対応済み: フォローアップ推奨をSection 2, 9に追加 |

### Stage 2: 整合性レビュー（2026-02-07）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応状況 |
|----|--------|---------|---------|---------|
| C-001 | must_fix | 整合性 | `detectSessionStatus()`の`lastOutputTimestamp`型が設計書では`number`だが実コードでは`Date` | 対応済み: 設計書のシグネチャを`lastOutputTimestamp?: Date`に修正（Section 5-1） |
| C-002 | must_fix | 整合性 | `detectSessionStatus()`の`cliToolId`型が設計書では`string`だが実コードでは`CLIToolType` | 対応済み: 設計書のシグネチャを`cliToolId: CLIToolType`に修正、import文追加（Section 5-1） |
| C-003 | should_fix | 整合性 | 設計書のBefore/Afterコードでの行番号参照「行56-84」が概算値。実際は行56-99（stale prompt cleanup含む） | 対応済み: 行番号を「行56-99」に修正、論理的境界での記述に変更（Section 3, 5-2） |
| C-004 | should_fix | 整合性 | Afterコードの`!statusResult.hasActivePrompt`が現行の`!promptDetection.isPrompt`と論理的に等価であることが未説明 | 対応済み: 等価性の説明と設計判断の根拠を注記として追加（Section 5-2） |
| C-005 | nice_to_have | 整合性 | Afterコードで`worktreeId`変数を使用しているが、実際のコードでは`worktree.id`（route.ts）/`params.id`（[id]/route.ts） | 対応済み: コード例を`worktree.id`に修正、[id]/route.tsでは`params.id`に読み替える旨を注記（Section 3, 5-2） |
| C-006 | nice_to_have | 整合性 | `StatusDetectionResult`への`hasActivePrompt`追加は後方互換であることの確認 | 対応済み: 後方互換性の確認結果をSection 9の設計判断テーブルに追記。既存テストでは新フィールド未検証のため、Section 8-2テスト項目6で補完 |

### Stage 3: 影響分析レビュー（2026-02-07）

| ID | 重要度 | カテゴリ | 指摘内容 | 対応状況 |
|----|--------|---------|---------|---------|
| IS-007 | must_fix | 影響範囲 | `auto-yes-manager.ts`（行290）が`detectPrompt(cleanOutput)`に最大5000行の全文出力を渡しており、route.tsと同一の脆弱性パターンを持つ。thinking skipとdetectPrompt内部ウィンドウイングは部分的防御のみ | 対応済み: Section 9将来の検討事項とSection 11変更しないファイルの備考にフォローアップ候補として追加 |
| IS-003 | should_fix | 影響範囲 | `StatusDetectionResult`型への`hasActivePrompt`追加がTypeScript strictモードで外部構築コードに影響する可能性 | 対応済み: コード検索により外部で構築するコードが存在しないことを確認した旨をSection 5-1とSection 9に明記 |
| IS-006 | should_fix | 影響範囲 | 空行フィルタリング動作変更（DR-003）でtmux空行パディングがプロンプト行を15行ウィンドウ外に押し出すリスク | 対応済み: Section 5-1のDR-003注記を強化し、具体的なリスクシナリオと段階的対応方針（Option A/B/C）を追加。Section 8-2テストケース7をサブシナリオ付きで強化 |
| IS-001 | nice_to_have | 影響範囲 | `current-output/route.ts`（行88）にも同一の全文出力渡しパターンが存在するが、フォローアップ候補として未記載 | 対応済み: Section 9将来の検討事項とSection 11変更しないファイルの備考に追加 |
| IS-002 | nice_to_have | 影響範囲 | APIレスポンス消費側のUI コンポーネント依存チェーンが個別に列挙されていない | 対応済み: Section 11に「APIレスポンス消費側」テーブルを新設し、5ファイルを個別列挙 |
| IS-004 | nice_to_have | 影響範囲 | `response-poller.ts`の3箇所のdetectPrompt呼び出しが全文出力を渡すことの確認（設計分析の妥当性確認） | 確認済み: 設計分析が妥当であることをStage 3レビューが確認。Section 9将来の検討事項に確認結果を注記 |
| IS-005 | nice_to_have | 影響範囲 | `claude-poller.ts`のstartPolling到達不能性評価は正確だが、将来の有効化リスクに対してlegacy/deprecatedコメントを推奨 | 対応済み: Section 2とSection 9のDR-008フォローアップにlegacy/deprecatedコメント追加推奨を追記 |

### Stage 4: セキュリティレビュー（2026-02-07）

**判定: APPROVE** -- セキュリティ観点で設計は健全。新たな攻撃面は導入されない。

| ID | 重要度 | カテゴリ | 指摘内容 | 対応状況 |
|----|--------|---------|---------|---------|
| SEC-008 | should_fix | DRYによるセキュリティ改善 | ロジック統合により、セキュリティ修正の適用箇所が3箇所から1箇所に減少。部分的パッチ適用リスクの低減はセキュリティ上の改善 | 対応済み: Section 6セキュリティ設計にDRYセキュリティ改善効果を明記 |
| SEC-009 | should_fix | Defense in Depth | tmux空行パディングでプロンプト行が15行ウィンドウ外に押し出される場合、default-to-running（低信頼度）が返却されステータス誤表示の可能性。auto-yesパスとは独立だが、ユーザー混乱リスクあり。テストケース8-2 item 7bで検証し、結果に基づきSTATUS_CHECK_LINE_COUNT調整または空行フィルタリング追加を判断 | 対応済み: Section 6セキュリティ設計に誤表示リスクとauto-yes独立性を明記。Section 8-2テストケース7bにSEC-009参照を追加 |
| SEC-001 | nice_to_have | ANSI Injection | `stripAnsi()`パターンはtmux出力に対して十分だが、C1制御コード等の一部エキゾチックなシーケンスは未カバー。事前存在条件（Issue #180で導入されたものではない） | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-002 | nice_to_have | ReDoS | 本変更はReDoS耐性を改善（処理ウィンドウ100行->15行に縮小）。全パターンがアンカー付き/有界量指定子使用 | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-003 | nice_to_have | 情報漏洩 | エラーハンドリングは汎用メッセージを返却し、スタックトレース非露出。既存動作を変更しない | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-004 | nice_to_have | レースコンディション | `hasActivePrompt`は同期導出のため新たなTOCTOUウィンドウなし | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-005 | nice_to_have | DoS / パフォーマンス | 正規表現処理ウィンドウ縮小によるDoS耐性改善 | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-006 | nice_to_have | 入力検証 | ユーザー制御入力の処理に変更なし。tmux出力はサーバー側キャプチャ | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-007 | nice_to_have | XSS / 出力エンコーディング | APIレスポンス形式不変。Reactの自動エスケープで保護 | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |
| SEC-010 | nice_to_have | Defense in Depth | `stripAnsi()`が行分割前に呼び出される順序は正しく、統合後も維持される | 記録済み: Section 6セキュリティレビュー観察事項テーブルに記載 |

---

## 13. 実装チェックリスト

### Must Fix 対応
- [ ] [DR-001] `detectSessionStatus()`のJSDocに生出力（ANSIコード含む）を期待する契約を明記
- [ ] [DR-001] route.tsで`stripAnsi()`呼び出しを削除し、`captureSessionOutput()`の戻り値をそのまま`detectSessionStatus()`に渡す
- [ ] [DR-001] route.tsから`stripAnsi`のインポートを削除
- [ ] [DR-001] `[id]/route.ts`に同様の変更を適用

### Should Fix 対応
- [ ] [DR-002] `StatusDetectionResult`の`promptDetection?: PromptDetectionResult`を`hasActivePrompt: boolean`に変更
- [ ] [DR-002] `detectSessionStatus()`内で`detectPrompt()`結果をbooleanに変換して`hasActivePrompt`に設定
- [ ] [DR-002] route.tsのstale prompt cleanup条件を`!statusResult.hasActivePrompt`に変更
- [ ] [DR-003] 末尾に多数の空行を含む出力のテストケースを追加
- [ ] [DR-007] テストケースでレイヤードウィンドウイングの動作を検証（15行入力でy/n, multiple choiceの検出確認）

### Nice to Have 対応
- [ ] [DR-004] Facadeパターンの責務境界コメントを`detectSessionStatus()`のJSDocに追加
- [ ] [DR-008] `claude-poller.ts`の到達不能コード対応をフォローアップIssueとして起票検討

### Stage 2 整合性レビュー対応（Must Fix）
- [ ] [C-001] `detectSessionStatus()`の`lastOutputTimestamp`パラメータの型を`Date`として実装（`number`ではない）
- [ ] [C-002] `detectSessionStatus()`の`cliToolId`パラメータの型を`CLIToolType`として実装（`string`ではない）
- [ ] [C-002] `CLIToolType`を`./cli-tools/types`からインポート

### Stage 2 整合性レビュー対応（Should Fix）
- [ ] [C-003] route.ts修正時に行56-99の全体（stale prompt cleanup含む）を置き換え対象とする
- [ ] [C-004] Afterコードの`!statusResult.hasActivePrompt`が`!promptDetection.isPrompt`と等価であることをコードコメントで明記

### Stage 2 整合性レビュー対応（Nice to Have）
- [ ] [C-005] route.tsでは`worktree.id`、[id]/route.tsでは`params.id`を正しく使用する（疑似コードの`worktreeId`を使わない）
- [ ] [C-006] `hasActivePrompt`追加後、既存テストが破壊されないことを確認（後方互換性検証）

### Stage 3 影響分析レビュー対応（Must Fix）
- [ ] [IS-007] `auto-yes-manager.ts`を将来のフォローアップ候補として設計書に記載（全文出力をdetectPromptに渡す同一脆弱性パターンの存在を明記）

### Stage 3 影響分析レビュー対応（Should Fix）
- [ ] [IS-003] `StatusDetectionResult`を外部で構築するコードが存在しないことをコード検索で確認し、設計書に明記（後方互換性の根拠）
- [ ] [IS-006] テストケース8-2 item 7を強化: tmux空行パディングがプロンプト行を15行ウィンドウ外に押し出すシナリオを含める。テスト結果に基づきSTATUS_CHECK_LINE_COUNTの調整または空行フィルタリング追加を判断

### Stage 3 影響分析レビュー対応（Nice to Have）
- [ ] [IS-001] `current-output/route.ts`をフォローアップ候補として設計書に追加
- [ ] [IS-002] APIレスポンス消費側のUIコンポーネント依存チェーンを設計書に個別列挙
- [ ] [IS-005] `claude-poller.ts`にlegacy/deprecatedコメント追加をフォローアップで検討

### Stage 4 セキュリティレビュー対応（Should Fix）
- [ ] [SEC-008] ロジック統合によるセキュリティ修正適用箇所の一元化を実装（route.ts x2のインラインロジック削除 -> detectSessionStatus()呼び出しへの統合）
- [ ] [SEC-009] テストケース8-2 item 7b（空行パディングによるプロンプトのウィンドウ外押し出し）を実装し、STATUS_CHECK_LINE_COUNTの妥当性を検証。テスト結果に基づき、必要であれば空行フィルタリング追加を検討
- [ ] [SEC-009] route.tsのインラインロジック削除後、`stripAnsi`, `detectThinking`, `getCliToolPatterns`, `detectPrompt`のimport参照が残存していないことを確認

### Stage 4 セキュリティレビュー対応（Nice to Have -- 将来のハードニング候補）
- [ ] [SEC-001] 将来のハードニングパスで`stripAnsi()`をstrip-ansi npmパッケージまたはC1制御コード対応パターンに置換検討
- [ ] [SEC-010] `stripAnsi()`の行分割前呼び出し順序が維持されていることを実装時に確認

### 基本実装
- [ ] `StatusDetectionResult`インターフェース更新
- [ ] `detectSessionStatus()`のhasActivePromptフィールド設定
- [ ] `route.ts`のインラインロジック置き換え
- [ ] `[id]/route.ts`のインラインロジック置き換え
- [ ] 不要なimport削除
- [ ] Issue #180固有テストケース追加（8ケース）
- [ ] 既存テスト全パス確認

---

## 14. レビュー履歴

| Stage | 日付 | レビュー種別 | 指摘数 | Must Fix | Should Fix | Nice to Have | 判定 |
|-------|------|------------|--------|----------|------------|-------------|------|
| 1 | 2026-02-07 | 通常レビュー | 8 | 1 | 3 | 4 | - |
| 2 | 2026-02-07 | 整合性レビュー | 6 | 2 | 2 | 2 | - |
| 3 | 2026-02-07 | 影響分析レビュー | 7 | 1 | 2 | 4 | - |
| 4 | 2026-02-07 | セキュリティレビュー | 10 | 0 | 2 | 8 | **APPROVE** |

---

*Generated by design-policy command for Issue #180*
*Stage 1 review findings applied on 2026-02-07*
*Stage 2 consistency review findings applied on 2026-02-07*
*Stage 3 impact analysis review findings applied on 2026-02-07*
*Stage 4 security review findings applied on 2026-02-07 -- Verdict: APPROVE*
