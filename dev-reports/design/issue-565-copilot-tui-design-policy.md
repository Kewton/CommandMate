# Issue #565 設計方針書: Copilot CLI（TUI/alternate screen）対応

## 1. 概要

### 目的
Copilot CLI（`gh copilot`）のalternate screenモード（全画面TUI）に対応し、レスポンス保存・重複防止・メッセージ送信の3つの問題を解決する。

### スコープ
- Copilot用TuiAccumulator対応（コンテンツ抽出・蓄積）
- TUI向けプロンプト重複防止（content hashベース）
- メッセージ送信のマルチラインモード対策安定化
- 暫定対策の整理

### 前提条件
- OpenCode TUI対応（Issue #379）が既に実装済み
- Copilot暫定対策がコミット7c68640eで適用済み
- cli-toolsのStrategyパターンが確立済み（6ツール対応）

---

## 2. アーキテクチャ設計

### 2.1 レイヤー構成

```
┌─────────────────────────────────────────────┐
│ API Routes (send/route.ts, terminal/route.ts)│  ← メッセージ送信
├─────────────────────────────────────────────┤
│ response-poller.ts                           │  ← ポーリング制御・レスポンス抽出
│   ├── extractResponse()                      │     checkForResponse()
│   ├── checkForResponse()                     │
│   └── isFullScreenTui分岐                    │
├─────────────────────────────────────────────┤
│ tui-accumulator.ts                           │  ← TUIコンテンツ蓄積（Layer 2）
│   ├── accumulateTuiContent(key, lines, cliToolId) │
│   ├── extractTuiContentLines() [OpenCode]    │
│   └── extractCopilotContentLines() [NEW]     │
├─────────────────────────────────────────────┤
│ cli-patterns.ts                              │  ← パターン定義
│   ├── COPILOT_SKIP_PATTERNS [拡張]           │
│   └── COPILOT_COMPLETE_PATTERN [NEW]         │
├──────────────────────────────��──────────────┤
│ response-cleaner.ts                          │  ← レスポンス整形
│   └── cleanCopilotResponse() [本実装化]      │
├─────────────────────────────────────────────┤
│ response-extractor.ts                        │  ← 抽出インデックス解決
│   └── resolveExtractionStartIndex() [Copilot分岐追加] │
├──────────��──────────────────────────────────┤
│ cli-tools/copilot.ts                         │  ← Copilotセッション管理
│   └── sendMessage() [遅延定数化]             │
└─────────────────────────────────────────────┘
```

### 2.2 データフロー

> **Layer番号の注記 [DR2-007]**: Layer番号は処理の抽象度（深さ）を表す。Layer 2（TUIコンテンツ蓄積）はLayer 1（レスポンス抽出）より先に実行されるが、Layer 2の方がより低レベルな蓄積処理であり、Layer 1がその結果を利用する上位処理であるため、この番号付けとしている。

```
tmux capture-pane (約24行)
  │
  ├── [Layer 2] accumulateTuiContent(pollerKey, rawOutput, 'copilot')  [DR2-009]
  │     ├── extractCopilotContentLines(rawOutput)  ← NEW
  │     │     ├── COPILOT_SKIP_PATTERNS でフィルタ
  │     │     └── normalizeCopilotLine() でTUI装飾除去
  │     ├── findOverlapIndex() で前回との重複検出
  │     └── 新規行を蓄積バッファに追加
  │
  ├── [Layer 1] extractResponse()
  │     ├── 早期プロンプト検出（L344, copilot含む）
  │     ├── レスポンス抽出ループ（L390-421）
  │     │     └── 方針(B): cleanCopilotResponseで後段フィルタリング
  │     │     └── skipPatternsフィルタ（L414-418）でもCOPILOT_SKIP_PATTERNSが適用される [DR2-002]
  │     └── ExtractionResult返却
  │
  ├── [重複防止] checkForResponse()
  │     ├── isFullScreenTui → lineCountベース重複チェックスキップ
  │     └── [NEW] content hashベース重複チェック（createMessage()の前に配置）[DR2-006]
  │           └── インメモリキャッシュ（Map<pollerKey, string>）[DR1-006, DR1-008]
  │
  └── [レスポンス保存] [DR2-010, DR3-001]
        ├── cliToolId === 'copilot' の場合のみ: getAccumulatedContent(pollerKey) で蓄積コンテンツを取得
        │     └── extractResponse()のresult.responseではなく、TuiAccumulator蓄積コンテンツを使用
        │     └── NOTE: OpenCodeではgetAccumulatedContent()を使用しない（過去Q&A履歴リークのため）
        ├── cleanCopilotResponse() でTUI装飾除去
        └── DB保存 + ポーリング停止
```

---

## 3. 設計パターン

### 3.1 Strategy統合（cliToolIdベース分岐）

既存のcli-toolsのStrategyパターンに準拠し、cliToolIdで処理を分岐する。

**方針**: 新しいフラグやインターフェースは追加せず、既存の `cliToolId === 'copilot'` パターンで分岐。

```typescript
// tui-accumulator.ts
export function accumulateTuiContent(
  pollerKey: string,
  rawOutput: string,
  cliToolId: CLIToolType = 'opencode'  // 後方互換
): void {
  const contentLines = cliToolId === 'copilot'
    ? extractCopilotContentLines(rawOutput)
    : extractTuiContentLines(rawOutput)  // OpenCode
  // ... 既存の蓄積ロジック
}
```

> **拡張メモ [DR1-002]**: 現在は opencode / copilot の2ツールのみのため if/else 分岐で許容範囲だが、3ツール目の alternate screen 対応が発生した場合は、extractContentLines 関数を `CLIToolType` をキーとした **レジストリパターン**（`Map<CLIToolType, ExtractContentLinesFn>`）に移行すること。これにより開放/閉鎖原則（OCP）に準拠し、accumulateTuiContent 本体を修正せずに新ツールを追加可能になる。

### 3.2 インメモリキャッシュ（重複防止）

> **設計判断 [DR1-006]**: 当初は「第2層: キャッシュミス時のみDB参照」を検討したが、インメモリキャッシュ（第1層）のみで十分であり、DB参照層は不要と判断した。プロセス再起動時に初回重複が発生する可能性はあるが、実害は軽微（同一プロンプトが1回余分に保存されるだけ）であり、KISS原則を優先する。DB参照層が必要になった場合は別Issueで対応する。

```typescript
// src/lib/polling/prompt-dedup.ts（独立モジュール）
const promptHashCache = new Map<string, string>()  // pollerKey → SHA-256

export function isDuplicatePrompt(pollerKey: string, content: string): boolean {
  const hash = createHash('sha256').update(content).digest('hex')

  // インメモリキャッシュのみで重複判定
  if (promptHashCache.get(pollerKey) === hash) return true

  promptHashCache.set(pollerKey, hash)
  return false
}

export function clearPromptHashCache(pollerKey: string): void {
  promptHashCache.delete(pollerKey)
}
```

---

## 4. 詳細設計

### 4.1 Copilot用TuiAccumulator対応

#### 4.1.1 extractCopilotContentLines（新規関数）

**ファイル**: `src/lib/tui-accumulator.ts`

```typescript
export function extractCopilotContentLines(rawOutput: string): string[] {
  const strippedOutput = stripAnsi(rawOutput)
  const lines = strippedOutput.split('\n')
  const contentLines: string[] = []

  for (const line of lines) {
    const normalized = normalizeCopilotLine(line)
    const trimmed = normalized.trim()
    if (!trimmed) continue
    if (COPILOT_SKIP_PATTERNS.some(p => p.test(trimmed))) continue
    contentLines.push(normalized)
  }

  return contentLines
}

/** Copilot TUI固有の装飾除去（export して cleanCopilotResponse からも再利用） [DR1-001] */
export function normalizeCopilotLine(line: string): string {
  // - ink/React CLIのbox-drawing文字
  // - ショートカットキー表示領域
  return line
    .replace(/[\u2500-\u257F]/g, '')  // box-drawing
    .replace(/\s{2,}/g, ' ')          // 連続空白を正規化
    .trim()
}
```

#### 4.1.2 COPILOT_SKIP_PATTERNS拡張

**ファイル**: `src/lib/detection/cli-patterns.ts`

> **実装方針 [DR1-007]**: パターン追加は **TDD方式** で進める。「実際のCopilot TUI出力サンプルを取得 -> テストケース作成 -> パターン追加」の順序とし、推測に基づくパターンの先行追加は行わない。以下のパターン一覧は実際の出力観察に基づくもののみを記載し、未確認パターンは確認後に段階的に追加する。

```typescript
export const COPILOT_SKIP_PATTERNS: readonly RegExp[] = [
  PASTED_TEXT_PATTERN,
  COPILOT_SEPARATOR_PATTERN,           // ─{10,} ※実機確認済み
  COPILOT_THINKING_PATTERN,            // ブレイユ文字スピナー等 ※実機確認済み
  // 以下のパターンは実際のTUI出力サンプルで確認後に追加する
  // /^shortcuts\s*↵/,                  // ショートカット表示行
  // /shift\+tab\s+switch\s+mode/,      // モード切替指示
  // /^\s*↑↓\s+to navigate/,           // ナビゲーション指示
  // /ctrl\+[a-z]\s+\w+/,              // ctrl+x ショートカット表示
  // /^Esc\s+/,                         // Escキー指示
  COPILOT_SELECTION_LIST_PATTERN,       // セレクションUI ※実機確認済み
] as const
```

**パターン追加手順**: 各パターンを有効化する際は、対応するCopilot TUI出力のスクリーンショットまたはテキストサンプルをテストケースに含めること。

> **ReDoS防止ルール [DR4-002]**
> パターン追加時は以下のReDoS防止ルールに従うこと:
> 1. ネストした量指定子（`.*.*` 等）の使用を禁止する
> 2. `.*` より `[^\n]*` を推奨する（改行をまたがないことを明示）
> 3. 既存パターンの第3分岐 `/to navigate.*Enter to select/` は `/to navigate[^\n]*Enter to select/` に変更し、改行をまたがないことを明示する（tmux capture-pane出力は行単位のため実用上のReDoSリスクは極めて低いが、防御的な記述とする）

> **初回リリース時のリスク [DR3-006]**
> 初回リリース時点ではCOPILOT_SKIP_PATTERNSはPASTED_TEXT_PATTERN、COPILOT_SEPARATOR_PATTERN、COPILOT_THINKING_PATTERN、COPILOT_SELECTION_LIST_PATTERNの最小限のパターンのみで構成される。このため、extractCopilotContentLinesのフィルタリング効果は限定的であり、TUIの装飾行（ショートカット表示、ナビゲーション指示等）がそのまま蓄積コンテンツに混入する可能性がある。
>
> **リスク緩和策**: 蓄積コンテンツの品質が低い場合でも、cleanCopilotResponseの後段フィルタリング（方針B、セクション4.1.4）で吸収される設計としている。完全なフィルタリングは段階的なパターン拡充で達成する。
>
> **フォローアップ計画**: 初回リリース後にCopilot TUI出力サンプルを体系的に収集し、以下の手順でパターンを拡充する:
> 1. 実際の使用中にcleanCopilotResponse適用後のレスポンスに残るTUI装飾行を特定
> 2. 対応するスキップパターンをテストケースと共に追加
> 3. 必要に応じてフォローアップIssueを起票

#### 4.1.3 accumulateTuiContent シグネチャ拡張

**ファイル**: `src/lib/tui-accumulator.ts`

> **現状の問題 [DR2-003]**: 現在のコードではcliToolIdに関わらずextractTuiContentLines()（OpenCode専用）が呼ばれるため、CopilotのTUI出力はOpenCode用のnormalizeOpenCodeLine()とOPENCODE_SKIP_PATTERNSで処理されている。これはCopilotのTUI出力形式に適合しておらず、正しくコンテンツ抽出できていない。本変更はこの誤動作を修正し、cliToolIdに基づいて適切な抽出関数を呼び分けるようにするものである。

```typescript
// Before
export function accumulateTuiContent(pollerKey: string, rawOutput: string): void

// After（セクション3.1と統一、デフォルト値付き）[DR2-004]
export function accumulateTuiContent(
  pollerKey: string,
  rawOutput: string,
  cliToolId: CLIToolType = 'opencode'  // 後方互換: 既存のOpenCode呼び出し元を修正不要にする
): void
```

> **デフォルト引数に関する注意 [DR3-003]**
> デフォルト値 `'opencode'` は、既存テスト（response-poller-tui-accumulator.test.ts）での2引数呼び出し（約10箇所）の後方互換性のために維持している。現在の本番コード呼び出し元（response-poller.ts L605-608）は `cliToolId === 'opencode' || cliToolId === 'copilot'` の条件分岐内にあり、常にcliToolIdを明示的に渡すため、デフォルト値が使用されるケースは本番コードには存在しない。
>
> **コーディング規約**: 本番コードからaccumulateTuiContentを呼び出す際は、常にcliToolIdを明示的に渡すこと。デフォルト値に依存した呼び出しは既存テスト互換のみに限定する。JSDocにこの意図を記載すること。

**呼び出し元修正**: `response-poller.ts` L605-608

```typescript
// Before
accumulateTuiContent(pollerKey, output)

// After
accumulateTuiContent(pollerKey, output, cliToolId)
```

#### 4.1.4 cleanCopilotResponse 本実装

**ファイル**: `src/lib/response-cleaner.ts`

**方針**: extractResponseループではフィルタリングせず（方針B）、cleanCopilotResponseで後段フィルタリング。

> **設計判断: COPILOT_SKIP_PATTERNS の三箇所適用について [DR1-003, DR2-002]**
> COPILOT_SKIP_PATTERNS は以下の3箇所で適用される。これは意図的な設計であり、各箇所の役割が異なる。
> 1. **蓄積時（Layer 2: extractCopilotContentLines）**: インクリメンタルなフィルタリング。tmux capture-paneの各スナップショットから不要行を除去しながら蓄積する。
> 2. **extractResponseループ（L414-418: skipPatternsフィルタ）**: getCliToolPatterns('copilot').skipPatternsがCOPILOT_SKIP_PATTERNSを返すため、レスポンス抽出ループ内でも適用される。方針(B)では主要なフィルタリングをcleanCopilotResponseに委ねるが、extractResponseループ内のskipPatternsフィルタは全ツール共通の仕組みとして動作する。
> 3. **保存時（cleanCopilotResponse）**: 防御的フィルタリング。蓄積時・抽出時にフィルタ漏れした行を最終段で捕捉する安全ネット。
>
> **重要**: COPILOT_SKIP_PATTERNSを変更する際は、上記3箇所すべてへの影響を確認すること。getCliToolPatterns()からskipPatternsとして返されるため、cli-patterns.tsの変更がextractResponseとcleanCopilotResponseの両方に波及する。

```typescript
import { normalizeCopilotLine } from '../tui-accumulator'  // [DR1-001] 共通関数を再利用

export function cleanCopilotResponse(response: string): string {
  const strippedResponse = stripAnsi(response)
  const lines = strippedResponse.split('\n')
  const cleanedLines: string[] = []

  for (const line of lines) {
    const normalized = normalizeCopilotLine(line)  // [DR1-001] インライン実装を廃止し共通関数を使用

    if (!normalized) continue
    if (COPILOT_SKIP_PATTERNS.some(p => p.test(normalized))) continue

    cleanedLines.push(line.trim())
  }

  return cleanedLines.join('\n').trim()
}
```

**設計判断: 方針(B)を採用する理由**:
- Copilot TUIの画面構造は変動が大きく、extractResponseループ内でのbreak条件が脆弱になるリスク
- cleanCopilotResponseに集約することで、テスタビリティとメンテナンス性が向上
- OpenCodeのcleanOpenCodeResponseも同様のパイプラインパターンを採用

### 4.2 TUI向けプロンプト重複防止

#### 4.2.1 content hashベース重複チェック

**新規ファイル**: `src/lib/polling/prompt-dedup.ts` **[DR1-008]**

> **設計判断 [DR1-008]**: isDuplicatePrompt() と promptHashCache を response-poller.ts から独立モジュールに切り出す。response-poller.ts は既にポーリング制御・レスポンス抽出・保存判定など多くの責務を持つため、重複防止のキャッシュ管理を独立モジュールにすることでSRP準拠とテスタビリティを向上させる。

```typescript
// src/lib/polling/prompt-dedup.ts
import { createHash } from 'crypto'

const promptHashCache = new Map<string, string>()  // pollerKey → SHA-256

/**
 * プロンプトの重複を検出する。SHA-256ハッシュを使用して同一コンテンツの連続検出をスキップする。
 *
 * SHA-256衝突時の挙動 [DR4-004]: ハッシュ衝突が発生した場合はfalse positive
 * （異なるプロンプトが重複と判定されスキップされる）が発生するが、SHA-256の衝突確率は
 * 天文学的に低く（2^128回の計算で50%の確率）、実用上は無視できるレベルであり対策不要。
 *
 * 拡張容易性 [DR3-009]: pollerKeyとcontentの汎用シグネチャにより、isFullScreenTui条件を
 * 外すだけで全ツール（claude, codex, gemini, vibe-local）にも適用可能。
 */
export function isDuplicatePrompt(pollerKey: string, content: string): boolean {
  const hash = createHash('sha256').update(content).digest('hex')
  const cached = promptHashCache.get(pollerKey)
  if (cached === hash) return true
  promptHashCache.set(pollerKey, hash)
  return false
}

export function clearPromptHashCache(pollerKey: string): void {
  promptHashCache.delete(pollerKey)
}
```

**呼び出し元**: `src/lib/polling/response-poller.ts` checkForResponse() 内

> **配置位置の注意 [DR2-006]**: isDuplicatePrompt()の呼び出しは、createMessage()（L665）の**前**に配置する必要がある。createMessage()でDB保存が実行された後では重複防止が手遅れになるため、L661 `if (promptDetection.isPrompt)` の直後、L663 `clearInProgressMessageId` の前に配置すること。

```typescript
import { isDuplicatePrompt } from './prompt-dedup'

// checkForResponse() 内
// L661: if (result.promptDetection?.isPrompt) {
//   ★ここにisDuplicatePromptチェックを挿入（createMessage L665の前）[DR2-006]
if (result.promptDetection?.isPrompt) {
  const pollerKey = getPollerKey(worktreeId, cliToolId)
  const promptContent = result.promptDetection.promptMessage || result.response

  // 重複チェック: createMessage()の前に実行すること [DR2-006]
  if (isFullScreenTui && isDuplicatePrompt(pollerKey, promptContent)) {
    // 重複 → 保存スキップ（createMessageを呼ばない）
    return false
  }

  // L663: clearInProgressMessageId (既存)
  // L665: createMessage() (既存) ← この前にチェック済み
  // ...
}
```

**スコープ**: messageType='prompt' を優先。responseメッセージは蓄積内容が毎回異なるため重複が発生しにくい。

> **拡張容易性 [DR3-009]**
> isDuplicatePromptの関数シグネチャは汎用的（pollerKey, content）であり、isFullScreenTui条件を外すだけで全ツール（claude, codex, gemini, vibe-local）にも適用可能。現時点ではisFullScreenTui条件内に限定するが、将来的にline-countベースの重複防止に問題が発見された場合の拡張パスは確保されている。この拡張容易性をprompt-dedup.tsのJSDocに記載すること。

#### 4.2.2 キャッシュクリア

ポーリング停止時およびセッションクリーンアップ時にキャッシュをクリア:

**クリア箇所1**: `src/lib/polling/response-poller.ts` stopPolling()

```typescript
import { clearPromptHashCache } from './prompt-dedup'  // [DR1-008]

export function stopPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId)
  // 既存の停止処理...
  clearPromptHashCache(pollerKey)  // NEW [DR1-008]
}
```

**クリア箇所2 [DR4-005]**: `src/lib/session-cleanup.ts` killWorktreeSession()

> **設計判断 [DR4-005]**: ブラウザタブを閉じた場合など、stopPollingが呼ばれずにセッションが終了するシナリオでは、promptHashCacheのキーが残り続ける。session-cleanup.tsのkillWorktreeSession()は既にTuiAccumulatorのクリアやポーラー停止を行う統合クリーンアップポイントであるため、promptHashCacheのクリアも同じ箇所に配置する。

```typescript
import { clearPromptHashCache } from '../polling/prompt-dedup'

// killWorktreeSession() 内
// 既存のクリーンアップ処理（TuiAccumulator, ポーラー停止等）に追加
clearPromptHashCache(pollerKey)  // [DR4-005]
```

### 4.3 メッセージ送信の安定化

#### 4.3.1 遅延定数化

**新規ファイル**: `src/config/copilot-constants.ts`

```typescript
/** Copilot CLI メッセージ送信時のテキスト入力後Enter送信までの遅延（ms） */
export const COPILOT_SEND_ENTER_DELAY_MS = 200

/** Copilot CLI sendMessage()内のテキスト入力待ち遅延（ms） */
export const COPILOT_TEXT_INPUT_DELAY_MS = 100
```

**適用箇所**:
1. `src/app/api/worktrees/[id]/send/route.ts` L262 → `COPILOT_SEND_ENTER_DELAY_MS`
2. `src/app/api/worktrees/[id]/terminal/route.ts` L88 → `COPILOT_SEND_ENTER_DELAY_MS`
3. `src/lib/cli-tools/copilot.ts` L272 �� `COPILOT_TEXT_INPUT_DELAY_MS`
4. `src/lib/cli-tools/copilot.ts` L278 → `COPILOT_SEND_ENTER_DELAY_MS`

#### 4.3.2 送信パス統一方針

**方針(B)を採用**: `send/route.ts`のインライン実装を正とする。

**理由**:
- copilot.tsのsendMessage()にはwaitForPromptのブロッキング問題（Issue #559）があり、根本解決にはICLIToolインターフェースの非同期設計変更が必要
- send/route.tsのインライン実装はシンプルで、問題の切り分けが容易
- 長期的にはcli-tools層に統合するが、本Issueのスコープ外

**copilot.ts sendMessage()の扱い**:
- 非推奨化はしない（CLIからの直接呼び出しで使用されている可能性）
- 遅延定数の共通化のみ実施

> **技術的負債管理 [DR1-005] (MUST FIX)**
>
> **現状の呼び出し元**:
> - `send/route.ts`: Copilotメッセージ送信のメインパス（インライン実装）
> - `terminal/route.ts`: Copilot全コマンドをsendMessage()に委譲（Issue #559で変更）
> - `copilot.ts sendMessage()`: CLIコマンド (`commandmate send`) から間接的に呼び出される可能性がある（cli/commands/send.ts -> API -> send/route.ts 経由のため、実際にはcopilot.ts sendMessage()は直接呼ばれない）
>
> **結論**: copilot.ts の sendMessage() は terminal/route.ts からのみ呼び出されており、send/route.ts のインライン実装と二重化している。
>
> **統合の前提条件**:
> 1. ICLITool.sendMessage() の戻り値を `Promise<void>` から `Promise<SendResult>` に変更し、ブロッキングを回避可能にする
> 2. waitForPrompt の非同期化（sendMessage内でのポーリング待機を廃止）
> 3. 上記2点の設計変更は全6ツールに影響するため、別Issueで対応する
>
> **TODO**: 技術的負債チケットを作成し、以下を記載する
> - 送信パス二重実装の統合
> - ICLITool.sendMessage() の非同期設計変更
> - 対象Issue番号: (Issue #565完了後に起票)

### 4.4 resolveExtractionStartIndex Copilot分岐

**ファイル**: `src/lib/response-extractor.ts`

**方針**: OpenCodeのBranch 2aと同様に、Copilot用の分岐を追加。

> **設計意図の注記 [DR1-004]**: resolveExtractionStartIndex は `cliToolId` ベースで分岐し、セクション4.5の isFullScreenTui フラグベース分岐とは異なるアプローチをとる。これは意図的な選択である。resolveExtractionStartIndex は response-extractor.ts に位置し、cliToolId を直接受け取るシグネチャが確立されている（OpenCode対応時から）。一方、isFullScreenTui は response-poller.ts 内のローカル判定フラグである。インターフェースの変更を最小限に抑えるため、resolveExtractionStartIndex は cliToolId ベースを維持する。ただし、内部の判定条件 `cliToolId === 'opencode' || cliToolId === 'copilot'` は isFullScreenTui の判定条件と同一であり、両者が乖離しないよう注意すること。

> **findRecentUserPromptIndex のCopilot検出精度に関する注意 [DR3-002]**
> Branch 2aではfindRecentUserPromptIndex(totalLines)を呼び出してユーザープロンプト行を検索する。OpenCodeの場合はOPENCODE_PROMPT_PATTERN（`/Ask anything.../`）で一意に特定できるが、CopilotのCOPILOT_PROMPT_PATTERN（`/^[>❯]\s|^\?\s+/m`）は応答本文内にも `>` や `?` が出現しうるため、誤検出のリスクがある。
>
> **検証計画**: Copilot TUIのalternate screen出力サンプルを用いて、findRecentUserPromptIndexが正しくユーザープロンプト行を検出できるかのテストケースを追加する。誤検出が頻発する場合は、Branch 2aではなく別ブランチ（常にindex 0から開始）への変更を検討する。

```typescript
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number
): number {
  // Branch 2a: OpenCode/Copilot（full-screen TUI）
  // NOTE: この条件は isFullScreenTui の判定条件と同一であること [DR1-004]
  if (cliToolId === 'opencode' || cliToolId === 'copilot') {
    const idx = findRecentUserPromptIndex(totalLines)
    return idx >= 0 ? idx + 1 : 0
  }
  // ... 既存分岐
}
```

### 4.5 extractResponse L518 一般プロンプト検出のCopilotスキップ判断 [DR2-001]

**ファイル**: `src/lib/response-extractor.ts`（extractResponse L518付近）

**現状**: extractResponse L518の一般プロンプト検出は `if (cliToolId !== 'opencode')` でOpenCodeのみスキップしている。Copilotは早期プロンプト検出（L344）で既にカバーされている。

**設計判断**: CopilotもL518の一般プロンプト検出からスキップする。

**理由**:
- Copilotは早期プロンプト検出（L344）で専用パターンにより検出済み
- L518の一般プロンプト検出はalternate screen以外のCLIツール向けであり、TUIモードのCopilotには不適切
- OpenCode同様にスキップすることで、isFullScreenTuiの判定条件との一貫性を保つ

**変更内容**:
```typescript
// Before
if (cliToolId !== 'opencode') {
  // 一般プロンプト検出
}

// After
if (cliToolId !== 'opencode' && cliToolId !== 'copilot') {
  // 一般プロンプト検出
}
// NOTE: この条件はisFullScreenTuiの判定条件と同一になること [DR2-001, DR1-004]
```

> **Copilot完了検出の網羅性保証 [DR3-007]**
> L518をスキップすることで、Copilotの一般プロンプト検出パスが無効化される。Copilotのプロンプト/完了検出は以下の2パスで保証される:
>
> 1. **早期プロンプト検出（L344）**: `cliToolId === 'copilot'` が含まれており、COPILOT_PROMPT_PATTERNで検出
> 2. **isCodexOrGeminiComplete（L372）**: `hasPrompt && !isThinking` 条件でCopilotの完了も検出
>
> CopilotのpromptPattern（COPILOT_PROMPT_PATTERN）はL344とL372の両方で参照されるため、いずれかのパスで必ず検出される。L518の一般プロンプト検出はalternate screen以外のCLIツール向けであり、TUIモードのCopilotではパターン不一致による誤検出リスクの方が高いため、スキップが正しい判断である。

### 4.6 Copilotレスポンス完了検出 [DR2-008]

**設計判断**: 現在のisCodexOrGeminiComplete条件（`hasPrompt && !isThinking`）をCopilotにも適用し続ける。isCopilotComplete独自関数は新設しない。

**理由**:
- Copilotの完了検出は、プロンプト検出（早期プロンプト検出 L344）と思考状態（isThinking）の組み合わせで十分に判定可能
- TuiAccumulatorで蓄積されたコンテンツは、完了検出時にgetAccumulatedContent(pollerKey)で取得可能（セクション4.7参照）
- isCodexOrGeminiCompleteの条件はTUI系ツール共通の完了判定パターンとして妥当
- 独自関数を新設するほどの差異がCopilotの完了条件にはない

**検証基準**: TuiAccumulatorからの蓄積コンテンツが完了検出時に正しくレスポンスとして取得できること（Issue本文の判断基準に準拠）

### 4.7 蓄積コンテンツのレスポンス保存フロー [DR2-010]

**ファイル**: `src/lib/polling/response-poller.ts` checkForResponse() L691以降

**問題**: extractResponse()の戻り値 `result.response` はtmuxの現在表示行から抽出したものであり、TUI全体の蓄積コンテンツではない。Copilotの場合、TuiAccumulatorで蓄積したコンテンツをレスポンス本文として使用しなければ、事象1（レスポンス本文が保存されない）の根本解決にならない。

**設計方針**: checkForResponse()のレスポンス保存パス（L691以降）において、Copilotの場合にresult.responseをgetAccumulatedContent(pollerKey)で置換する。

```typescript
// checkForResponse() L691以降、レスポンス保存パス
if (result.response) {
  let responseContent = result.response

  // Copilotの場合のみ: 蓄積コンテンツをレスポンス本文として使用 [DR2-010, DR3-001]
  // NOTE: isFullScreenTuiの一括条件ではなく、cliToolId === 'copilot' の個別条件で適用する。
  // OpenCodeではgetAccumulatedContent()を意図的に使用していない（response-poller.ts L715-723参照）。
  // accumulatedContentはTUI全体の過去Q&A履歴を含むため、旧レスポンスがリークするリスクがあるためである。
  if (cliToolId === 'copilot') {
    const accumulated = getAccumulatedContent(pollerKey)
    if (accumulated) {
      responseContent = accumulated
    }
    // cleanCopilotResponseで装飾除去
    responseContent = cleanCopilotResponse(responseContent)
  }

  // DB保存
  createMessage(worktreeId, cliToolId, 'assistant', responseContent)
}
```

> **重要: OpenCodeとの差異 [DR3-001]**
> OpenCodeの既存実装（response-poller.ts L715-723）では、getAccumulatedContent()を**使用していない**。コメント（L718-720）に明示的に記載されているように、accumulatedContentはTUI全体の過去Q&A履歴を含むため、cleanOpenCodeResponseでトリミングしても旧レスポンスがリークする問題があるためである。
>
> したがって、`isFullScreenTui` の一括条件ではなく、`cliToolId === 'copilot'` の個別条件でgetAccumulatedContent()を適用する。Copilotの蓄積コンテンツにも同様の過去Q&A履歴混入が発生しないか、実機検証で確認すること。混入が確認された場合は、cleanCopilotResponse内でトリミング戦略（最新のQ&Aペアのみを抽出するロジック）を追加する。

### 4.8 isFullScreenTui分岐の整理

**方針**: `isFullScreenTui`は共通フラグとして維持。Copilot固有ロジックは `cliToolId === 'copilot'` で個別分岐。

> **具体的な変更箇所 [DR2-005]**: response-poller.ts内のisFullScreenTui分岐ポイントと変更内容を以下に明示する。

| ロジック | 行番号 | 現在 | 変更後 | 備考 |
|---------|--------|------|--------|------|
| lineCount重複チェックスキップ | L642 | `isFullScreenTui` | `isFullScreenTui`（維持） | 変更なし |
| Layer 2蓄積呼び出し | L650 | `opencode \|\| copilot` | `isFullScreenTui`（統一） | cliToolId引数を追加 |
| プロンプト後ポーリング継続 | L684 | `!isFullScreenTui` | `!isFullScreenTui`（維持） | 変更なし |
| content hash重複防止 | L661直後 | なし | `isFullScreenTui`（新規） | createMessage前に配置 [DR2-006] |
| レスポンス保存時蓄積コンテンツ使用 | L691以降 | なし | `cliToolId === 'copilot'`（新規） | getAccumulatedContent使用。OpenCodeでは未使用のため個別条件 [DR2-010, DR3-001] |
| レスポンス後ポーリング停止 | L749 | `isFullScreenTui` | `isFullScreenTui`（維持） | 変更なし |

---

## 5. テ���ト計画

### 5.1 新規テストファイル

| ファイル | テスト対象 | 想定テスト数 |
|---------|----------|------------|
| `tests/unit/lib/tui-accumulator-copilot.test.ts` | extractCopilotContentLines, normalizeCopilotLine | 15+ |
| `tests/unit/lib/response-cleaner-copilot.test.ts` | cleanCopilotResponse | 12+ |
| `tests/unit/lib/prompt-dedup.test.ts` | isDuplicatePrompt, clearPromptHashCache [DR1-008] | 8+ |

### 5.2 既存テスト更新

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/lib/response-poller-tui-accumulator.test.ts` | accumulateTuiContentのcliToolIdパラメータ追加テスト |

> **追加すべきテストケース [DR3-004]**
> 既存のresponse-poller-tui-accumulator.test.tsでは、accumulateTuiContent(key, rawOutput)を2引数で呼び出しているケースが約10箇所存在する。シグネチャ変更後もデフォルト値により既存テストは壊れないが、以下のテストケースを追加してcliToolId分岐の網羅性を確保する:
>
> 1. `accumulateTuiContent(key, rawOutput, 'copilot')` が extractCopilotContentLines を呼ぶことの検証
> 2. `accumulateTuiContent(key, rawOutput, 'opencode')` が extractTuiContentLines を呼ぶことの検証（明示的引数）
> 3. Copilot用テストキー（例: `'test-worktree:copilot'`）での動作確認（既存テストは `'test-worktree:opencode'` 固定）

### 5.2.1 統合テストの検討 [DR3-010]

prompt-dedup.test.tsはisDuplicatePromptの単体テストのみをカバーする。checkForResponse内でisDuplicatePromptが正しく呼ばれ、createMessageの前に重複をスキップする統合的な動作のテストは、response-poller.tsのモック依存が複雑なため、以下の方針で対応する:

1. **単体テスト（必須）**: prompt-dedup.test.tsでisDuplicatePromptの全分岐をカバー
2. **既存テストへの追加（推奨）**: response-poller.test.tsにCopilotの重複プロンプト検出シナリオのテストケースを追加（モック構成が許容範囲であれば）
3. **手動テスト手順書（フォールバック）**: モック構成が複雑で統合テストが困難な場合は、手動テスト手順書に統合シナリオ（同一プロンプトの連続検出でcreateMessageが1回のみ呼ばれること）を記載

### 5.3 テストケース概要

#### extractCopilotContentLines
- Copilot TUI出力からコンテンツ行のみ抽出
- ステータスバー行のスキップ
- セパレーター行のスキップ
- ショートカット表示行のスキップ
- 思考インジケータのスキップ
- 正常レスポンステキストの保持
- 空行のフィルタリング
- box-drawing文字の除去

#### cleanCopilotResponse
- TUI装飾の完全除去
- ステータスバー文字列のフィルタリング
- 正常レスポンス本文の保持
- ANSIエスケープコードの除去
- 連続空白の正規化

#### isDuplicatePrompt
- 同一コンテンツの重複検出
- 異なるコンテンツの非重複判定
- pollerKey別の独立管理
- キャッシュクリア後の動作

---

## 6. セキュリティ設計

### 6.1 入力バリデーション

**多層防御構造 [DR4-003]**

メッセージ送信時のインジェクション防御は以下の多層構造で実現されている:

1. **API層（send/route.ts）**: CONTROL_CHAR_REGEX（`\x00-\x1f`, `\x7f`）による制御文字拒否。Copilot固有のコマンド（`/explain`等）もこの検証を通過する
2. **tmux層（tmux.ts）**: execFile()によるシェル解釈回避。sendKeys()はexecFileを使用しており、シェルインジェクションは構造的に防御されている
3. **Copilot固有の遅延送信（COPILOT_SEND_ENTER_DELAY_MS）**: テキスト入力後にEnterキーを遅延送信する仕組みであるが、遅延の有無はインジェクション防御に影響しない（execFileによる防御が遅延とは独立に機能するため）

- SHA-256ハッシュ計算は内部データのみ対象（外部入力のハッシュではない）

**フロントエンド表示時のXSS防御 [DR4-006]**

> **前提条件**: DB保存されたレスポンス（Copilot TUI出力由来のテキスト）のフロントエンド表示は、既存のReactコンポーネント（ConversationPairCard等）のテキストレンダリングに委譲している。これらのコンポーネントはdangerouslySetInnerHTMLを使用しておらず、Reactの標準的なエスケープ機構によりXSSが防御されている。将来のUI変更時にdangerouslySetInnerHTMLを導入する場合は、stripAnsi()済みのコンテンツであっても追加のサニタイズが必要である。

### 6.2 リソースリーク対策
- promptHashCacheはpollerKey単位で管理、stopPolling時およびkillWorktreeSession時にクリア [DR4-005]
- TuiAccumulator蓄積バッファは既存のclearTuiAccumulator()で管理。**蓄積行数上限を設ける [DR4-001]**（下記参照）
- **将来の検討事項 [DR3-005]**: プロセス異常終了やuncaughtExceptionの場合、stopPollingが呼ばれずキャッシュが残り続ける可能性がある。ただし、pollerKey単位でMap.setが上書きするため同一キーの蓄積は発生せず、キー数はアクティブセッション数に比例するため実際のメモリリスクは極めて低い。resource-cleanup.tsの孤立リソース検出にpromptHashCacheのサイズ監視を追加することを将来の検討事項とする

**TuiAccumulator蓄積バッファ上限 [DR4-001]**

> **問題**: TuiAccumulatorStateのlinesフィールドには蓄積行数の上限が設けられていない。Copilotセッションが長時間継続した場合（数時間のセッションで数千ポーリングサイクル）、state.linesが無制限に増加し、Node.jsプロセスのメモリを圧迫する可能性がある。OpenCode実装でも同様の問題が潜在しているが、Copilot対応によりTuiAccumulatorを使用するツールが増えるため、リスクが顕在化する確率が上がる。
>
> **対策**: accumulateTuiContent()内でstate.linesの行数に上限を設け、超過した場合は古い行を破棄するスライス方式を導入する。

```typescript
// src/lib/tui-accumulator.ts または src/config/copilot-constants.ts
export const MAX_ACCUMULATED_LINES = 10000

// accumulateTuiContent() 内
state.lines.push(...newLines)
if (state.lines.length > MAX_ACCUMULATED_LINES) {
  state.lines = state.lines.slice(-MAX_ACCUMULATED_LINES)
}
```

> **定数配置**: MAX_ACCUMULATED_LINESはTuiAccumulator全体に適用されるため、tui-accumulator.ts内に配置する（copilot-constants.tsではなく、OpenCodeにも適用されるため）。

**promptHashCacheクリーンアップ強化 [DR4-005]**

> stopPolling()に加えて、session-cleanup.tsのkillWorktreeSession()内でもclearPromptHashCache()を呼び出す。詳細はセクション4.2.2を参照。

---

## 7. パフォーマンス設��

### 7.1 ポーリング影響
- 2秒毎のポーリングサイクルにSHA-256計算を追加（<1ms）
- インメモリキャッシュ第1層でDBクエリを回避
- extractCopilotContentLinesはextractTuiContentLinesと同等の計算量（O(n*m)、n=行数約24行、m=パターン数） [DR3-008]
- **パターン数増加時の対策**: 現在のパターン数（4個程度）では計算量は無視できる。将来パターン数が20個以上に増加した場合は、正規表現のOR結合（単一の正規表現に統合）による最適化を検討する

### 7.2 メッセージ送信遅延
- 200ms遅延はCopilotのTUI描画サイクルに依存
- 検証基準: 100文字/200文字/500文字で送信成功率95%以上

---

## 8. 設計上の決定事項とトレードオフ

| 決定事項 | 採用案 | 理由 | トレードオフ |
|---------|--------|------|-------------|
| extractResponseループ | (B) 後段フィルタリング | テスタビリティ、TUI変動への耐性 | cleanCopilotResponseの品質が重要に |
| 送信パス統一 | (B) send/route.tsインライン | Issue #559のブロッキング回避 | 二重実装が残る（技術的負債チケットで管理 [DR1-005]） |
| 重複防止 | インメモリhash | パフォーマンス、DBスキーマ変更不要 | プロセス再起動で初回重複の可能性 |
| TuiAccumulator分岐 | cliToolIdパラメータ追加 | 最小限の変更、後方互換 | デフォルト値がOpenCode固定 |
| resolveExtractionStartIndex | OpenCodeと同一分岐 | alternate screen共通特性 | Copilot固有の最適化余地を残す |

### 代替案との比較

#### TuiAccumulator拡張方式
- **案A**: cliToolIdパラメータ追加（採用）→ 最小変更、既存テスト影響小
- **案B**: Strategy統合（cli-tools層に移動）→ 大規模リファクタ、本Issueスコープ超過
- **案C**: 別モジュール新設（copilot-accumulator.ts）→ コード重複

#### 重複防止方式
- **案A**: content hash（採用）→ シンプル、汎用的
- **案B**: DBハッシュカラム追加 → スキーマ変更のオーバーヘッド
- **案C**: タイムスタンプベース → 異なるプロンプトの連続検出に脆弱

---

## 9. 影響範囲まとめ

### 変更ファイル

| ファイル | 変更種別 | 概要 |
|---------|---------|------|
| `src/lib/tui-accumulator.ts` | 機能追加 | extractCopilotContentLines新設、accumulateTuiContentシグネチャ拡張 |
| `src/lib/detection/cli-patterns.ts` | 機能追加 | COPILOT_SKIP_PATTERNS拡張 |
| `src/lib/response-cleaner.ts` | 機能修正 | cleanCopilotResponse本実装化 |
| `src/lib/polling/prompt-dedup.ts` | 新規 | プロンプト重複防止（isDuplicatePrompt, clearPromptHashCache）[DR1-008] |
| `src/lib/polling/response-poller.ts` | 機能追加 | prompt-dedup呼び出し、accumulateTuiContent呼び出し修正 |
| `src/lib/response-extractor.ts` | 機能追加 | resolveExtractionStartIndex Copilot分岐、L518一般プロンプト検出Copilotスキップ [DR2-001] |
| `src/config/copilot-constants.ts` | 新規 | 遅延定数定義 |
| `src/app/api/worktrees/[id]/send/route.ts` | 修正 | 遅延定数参照 |
| `src/app/api/worktrees/[id]/terminal/route.ts` | 修正 | 遅延定数参照 |
| `src/lib/cli-tools/copilot.ts` | 修正 | 遅延定数参照 |

### 新規テストファイル

| ファイル | 概要 |
|---------|------|
| `tests/unit/lib/tui-accumulator-copilot.test.ts` | Copilot用TuiAccumulatorテスト |
| `tests/unit/lib/response-cleaner-copilot.test.ts` | cleanCopilotResponse���スト |
| `tests/unit/lib/prompt-dedup.test.ts` | 重複防止テスト（独立モジュール）[DR1-008] |

---

---

## 10. Stage 1 設計原則レビュー対応サマリー

### レビュー指摘一覧

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|----------|---------|----------|
| DR1-001 | should_fix | SOLID/DRY | normalizeCopilotLine の正規化ロジック重複 | 対応済み: normalizeCopilotLine を export し cleanCopilotResponse から再利用（セクション4.1.1, 4.1.4） |
| DR1-002 | should_fix | SOLID/OCP | accumulateTuiContent の cliToolId 分岐がOCPに反する | 対応済み: 拡張メモとして3ツール目対応時のレジストリパターン移行方針を追記（セクション3.1） |
| DR1-003 | nice_to_have | DRY | COPILOT_SKIP_PATTERNS の二重適用理由の明示不足 | 対応済み: 蓄積時と保存時の適用理由を設計判断として明記（セクション4.1.4） |
| DR1-004 | should_fix | SOLID | resolveExtractionStartIndex と isFullScreenTui の整合性 | 対応済み: cliToolIdベース維持の設計意図と注意点を注記（セクション4.4） |
| DR1-005 | must_fix | DRY | 送信パスの二重実装が技術的負債として未管理 | 対応済み: 呼び出し元特定、統合前提条件、負債チケット作成TODOを追記（セクション4.3.2） |
| DR1-006 | nice_to_have | KISS | 2層キャッシュ設計の第2層が未実装のまま言及 | 対応済み: 第2層DB参照の記載を削除、インメモリのみが最終形と明記（セクション3.2, データフロー図） |
| DR1-007 | nice_to_have | YAGNI | COPILOT_SKIP_PATTERNS の一部パターンが実装前に追加 | 対応済み: TDD方式での段階的追加方針を明記、未確認パターンをコメントアウト（セクション4.1.2） |
| DR1-008 | should_fix | SOLID/SRP | promptHashCache がresponse-poller.tsに直接配置 | 対応済み: prompt-dedup.ts 独立モジュールに切り出す設計に変更（セクション3.2, 4.2.1, 4.2.2） |

### 実装チェックリスト

Stage 1 レビュー指摘に基づく実装時の確認事項:

- [ ] **[DR1-001]** normalizeCopilotLine を tui-accumulator.ts から export する
- [ ] **[DR1-001]** cleanCopilotResponse で normalizeCopilotLine を import して使用する（インライン実装を廃止）
- [ ] **[DR1-002]** accumulateTuiContent に拡張メモのコメントを残す（3ツール目対応時のレジストリパターン移行）
- [ ] **[DR1-003]** cleanCopilotResponse の JSDoc に COPILOT_SKIP_PATTERNS 二重適用の意図を記載する
- [ ] **[DR1-004]** resolveExtractionStartIndex の Branch 2a 条件に isFullScreenTui との同一性コメントを付与する
- [ ] **[DR1-005]** copilot.ts sendMessage() の実際の呼び出し元をコード上で確認する
- [ ] **[DR1-005]** Issue #565 完了後に送信パス統合の技術的負債チケットを起票する
- [ ] **[DR1-006]** prompt-dedup.ts にインメモリキャッシュのみで実装する（DB参照層は実装しない）
- [ ] **[DR1-007]** COPILOT_SKIP_PATTERNS の各パターンは実際のTUI出力サンプルで確認してから有効化する
- [ ] **[DR1-008]** isDuplicatePrompt / clearPromptHashCache を src/lib/polling/prompt-dedup.ts に配置する
- [ ] **[DR1-008]** response-poller.ts から prompt-dedup.ts の関数を呼び出すだけにする
- [ ] **[DR1-008]** prompt-dedup.test.ts を独立テストファイルとして作成する

---

## 11. Stage 2 整合性レビュー対応サマリー

### レビュー指摘一覧

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|----------|---------|----------|
| DR2-001 | should_fix | コード整合性 | extractResponse L518のCopilotスキップ条件が未設計 | 対応済み: セクション4.5にL518一般プロンプト検出のCopilotスキップ設計判断を追加 |
| DR2-002 | should_fix | コード整合性 | COPILOT_SKIP_PATTERNSの3箇所適用が不明確 | 対応済み: セクション4.1.4の設計判断を「二重適用」から「三箇所適用」に更新、データフロー図にskipPatternsフィルタの適用を追記（セクション2.2） |
| DR2-003 | must_fix | コード整合性 | accumulateTuiContent呼び出し時にOpenCode用関数が常に使用される問題が未記載 | 対応済み: セクション4.1.3に現状の誤動作（CopilotがOpenCode用パターンで処理される問題）を明記 |
| DR2-004 | nice_to_have | 内部整合性 | accumulateTuiContentデフォルト引数がセクション間で不統一 | 対応済み: セクション4.1.3のシグネチャをセクション3.1と統一（`cliToolId: CLIToolType = 'opencode'` デフォルト値付き） |
| DR2-005 | should_fix | Issue整合性 | isFullScreenTui分岐の具体的コード変更箇所が不足 | 対応済み: セクション4.8の対応表にresponse-poller.tsの具体的な行番号（L642, L650, L661, L684, L691, L749）と変更内容を追加 |
| DR2-006 | should_fix | コード整合性 | isDuplicatePromptの呼び出し位置がcreateMessage後で手遅れ | 対応済み: セクション4.2.1のコード例を修正し、isDuplicatePromptがcreateMessage(L665)の前に配置されることを明示 |
| DR2-007 | nice_to_have | 内部整合性 | Layer 1とLayer 2の番号付けが実行順序と逆 | 対応済み: セクション2.2にLayer番号が処理の抽象度（深さ）を表すことの注記を追加 |
| DR2-008 | should_fix | Issue整合性 | Copilotレスポンス完了検出の設計判断が不足 | 対応済み: セクション4.6を新設し、isCodexOrGeminiComplete条件をCopilotにも適用する設計判断と根拠を記載 |
| DR2-009 | nice_to_have | 内部整合性 | データフロー図で引数名「key」と「pollerKey」が混在 | 対応済み: セクション2.2のデータフロー図の引数名を「pollerKey」に統一 |
| DR2-010 | must_fix | Issue整合性 | 蓄積コンテンツがレスポンス保存時に使用されるフローが未記載 | 対応済み: セクション4.7を新設し、getAccumulatedContent(pollerKey)でresult.responseを置換するフローを設計、データフロー図にも反映 |

### 実装チェックリスト

Stage 2 レビュー指摘に基づく実装時の確認事項:

- [ ] **[DR2-001]** extractResponse L518の条件に `cliToolId !== 'copilot'` を追加する
- [ ] **[DR2-002]** COPILOT_SKIP_PATTERNSの変更時に3箇所（extractCopilotContentLines, extractResponseループ, cleanCopilotResponse）への影響を確認する
- [ ] **[DR2-003]** accumulateTuiContent内でcliToolIdに基づいてextractCopilotContentLines/extractTuiContentLinesを呼び分ける
- [ ] **[DR2-004]** accumulateTuiContentのシグネチャを `cliToolId: CLIToolType = 'opencode'` とする
- [ ] **[DR2-005]** response-poller.tsのL642, L650, L661, L684, L691, L749の各分岐ポイントを設計方針書通りに実装する
- [ ] **[DR2-006]** isDuplicatePrompt()をcreateMessage()の前（L661直後、L663の前）に配置する
- [ ] **[DR2-008]** isCodexOrGeminiComplete条件がCopilotにも適用されることを確認する（isCopilotComplete新設は不要）
- [ ] **[DR2-010, DR3-001]** checkForResponse()のレスポンス保存パスで `cliToolId === 'copilot'` 条件でgetAccumulatedContent(pollerKey)を使用する（isFullScreenTui一括条件にしない。OpenCodeではgetAccumulatedContent()を使用しないため）

---

## 12. Stage 3 影響分析レビュー対応サマリー

### レビュー指摘一覧

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|----------|---------|----------|
| DR3-001 | must_fix | 波及効果 | getAccumulatedContent()によるレスポンス置換がOpenCodeの既存実装と矛盾 | 対応済み: セクション4.7をisFullScreenTui一括条件からcliToolId === 'copilot'個別条件に修正。OpenCodeでのgetAccumulatedContent()未使用の事実を明記。データフロー図（セクション2.2）、分岐表（セクション4.8）も更新 |
| DR3-002 | should_fix | 波及効果 | resolveExtractionStartIndex Branch 2aにCopilot追加時のfindRecentUserPromptIndex動作未検証 | 対応済み: セクション4.4にCOPILOT_PROMPT_PATTERNの誤検出リスクと検証計画を追記 |
| DR3-003 | should_fix | 後方互換性 | accumulateTuiContentのデフォルト引数'opencode'が将来の混乱を招く | 対応済み: セクション4.1.3にデフォルト値の存在理由（既存テスト互換）と本番コードでの明示的引数渡しのコーディング規約を追記 |
| DR3-004 | should_fix | テスト | 既存テストresponse-poller-tui-accumulator.test.tsのaccumulateTuiContent呼び出しが暗黙的にOpenCode動作を検証 | 対応済み: セクション5.2にcliToolId分岐の具体的テストケース3件を追記 |
| DR3-005 | nice_to_have | パフォーマンス | promptHashCacheのメモリリーク対策が不十分 | 対応済み: セクション6.2にプロセス異常終了時のリスク評価と将来の監視検討を追記 |
| DR3-006 | should_fix | 波及効果 | COPILOT_SKIP_PATTERNSの現状がほぼ空のため実効性が低い | 対応済み: セクション4.1.2に初回リリース時のリスク、リスク緩和策（方針Bによる後段フィルタリング）、フォローアップ計画を追記 |
| DR3-007 | should_fix | 波及効果 | extractResponse L518のCopilotスキップが早期プロンプト検出L344と重複する意図の明確化 | 対応済み: セクション4.5にCopilot完了検出の2パス網羅性保証（L344早期検出 + L372 isCodexOrGeminiComplete）の根拠を追記 |
| DR3-008 | nice_to_have | パフォーマンス | extractCopilotContentLinesの計算量はO(n*m)だが実用上問題なし | 対応済み: セクション7.1に計算量の明示とパターン数増加時の最適化方針を追記 |
| DR3-009 | should_fix | 後方互換性 | isDuplicatePromptがisFullScreenTui条件内のみで適用される設計だが将来的な全ツール適用の可能性を考慮すべき | 対応済み: セクション4.2.1にisDuplicatePromptの汎用シグネチャによる拡張容易性とJSDoc記載方針を追記 |
| DR3-010 | nice_to_have | テスト | テスト計画でresponse-poller.tsの統合テストが欠如 | 対応済み: セクション5.2.1を新設し、統合テストの3段階対応方針（単体テスト必須、既存テスト追加推奨、手動テスト手順書フォールバック）を記載 |

### 実装チェックリスト

Stage 3 レビュー指摘に基づく実装時の確認事項:

- [ ] **[DR3-001]** checkForResponse()のレスポンス保存パスでgetAccumulatedContent()を `cliToolId === 'copilot'` 条件で適用する（isFullScreenTui一括条件にしない）
- [ ] **[DR3-001]** Copilotの蓄積コンテンツに過去Q&A履歴が混入しないか実機検証する
- [ ] **[DR3-001]** 混入が確認された場合、cleanCopilotResponse内にトリミング戦略を追加する
- [ ] **[DR3-002]** Copilot TUI出力サンプルでfindRecentUserPromptIndexの検出精度をテストする
- [ ] **[DR3-003]** accumulateTuiContentのJSDocにデフォルト値が既存テスト互換のためである旨を記載する
- [ ] **[DR3-003]** 本番コードからの呼び出しでは常にcliToolIdを明示的に渡す
- [ ] **[DR3-004]** response-poller-tui-accumulator.test.tsにcliToolId='copilot'のテストケースを追加する
- [ ] **[DR3-004]** response-poller-tui-accumulator.test.tsにcliToolId='opencode'（明示的引数）のテストケースを追加する
- [ ] **[DR3-005]** resource-cleanup.tsのpromptHashCacheサイズ監視は将来の検討事項として保留
- [ ] **[DR3-006]** 初回リリース後にCopilot TUI出力サンプルを収集してCOPILOT_SKIP_PATTERNSを拡充する
- [ ] **[DR3-007]** Copilotのプロンプト検出がL344とL372の2パスで網羅されていることを実装時に確認する
- [ ] **[DR3-008]** パターン数増加時（20個以上）の正規表現OR結合最適化は将来の検討事項として保留
- [ ] **[DR3-009]** prompt-dedup.tsのJSDocにisDuplicatePromptの全ツール拡張容易性を記載する
- [ ] **[DR3-010]** response-poller.test.tsにCopilot重複プロンプト検出の統合テストケースの追加を検討する

---

## 13. Stage 4 セキュリティレビュー対応サマリー

### レビュー結果

- **ステータス**: conditionally_approved（条件付き承認）
- **スコア**: 4/5
- **リスク評価**: 技術 low / セキュリティ low / 運用 low

### レビュー指摘一覧

| ID | 重要度 | カテゴリ | タイトル | 対応状況 |
|----|--------|----------|---------|----------|
| DR4-001 | should_fix | メモリ安全性 | TuiAccumulator蓄積バッファに上限が設定されていない | 対応済み: セクション6.2にMAX_ACCUMULATED_LINES定数（10000行）とスライス方式による上限制御を追記 |
| DR4-002 | nice_to_have | ReDoS | COPILOT_SELECTION_LIST_PATTERNに潜在的なReDoSリスク | 対応済み: セクション4.1.2にReDoS防止ルール（`.*`より`[^\n]*`推奨、ネスト量指定子禁止）を追記 |
| DR4-003 | nice_to_have | インジェクション | sendKeys経由のコマンドインジェクション防御が適切に文書化されていない | 対応済み: セクション6.1を多層防御構造の文書化に拡張（API層CONTROL_CHAR_REGEX、tmux層execFile、Copilot遅延送信の影響なし） |
| DR4-004 | nice_to_have | その他 | SHA-256ハッシュ使用の目的が明確だが、衝突時の挙動が未文書化 | 対応済み: セクション4.2.1のisDuplicatePromptのJSDocにSHA-256衝突時のfalse positive挙動と対策不要の根拠を追記 |
| DR4-005 | should_fix | メモリ安全性 | promptHashCacheのサイズ監視が将来の検討事項に留まっている | 対応済み: セクション4.2.2にkillWorktreeSession()でのclearPromptHashCache()呼び出しを追記。セクション6.2も更新 |
| DR4-006 | nice_to_have | OWASP | 蓄積コンテンツのDB保存時にXSSベクトルの考慮が未記載 | 対応済み: セクション6.1にフロントエンド表示時のXSS防御の前提条件（dangerouslySetInnerHTML不使用）を追記 |

### 実装チェックリスト

Stage 4 レビュー指摘に基づく実装時の確認事項:

- [ ] **[DR4-001]** tui-accumulator.tsにMAX_ACCUMULATED_LINES定数（10000）を追加する
- [ ] **[DR4-001]** accumulateTuiContent()内でstate.lines.lengthがMAX_ACCUMULATED_LINESを超過した場合にslice(-MAX_ACCUMULATED_LINES)で古い行を破棄する
- [ ] **[DR4-002]** COPILOT_SELECTION_LIST_PATTERNの第3分岐を `/to navigate[^\n]*Enter to select/` に変更する
- [ ] **[DR4-002]** パターン追加時にReDoS防止ルール（ネスト量指定子禁止、`[^\n]*`推奨）に従う
- [ ] **[DR4-003]** send/route.ts、tmux.ts、copilot.tsの多層防御構造がコード上で確認できることを検証する
- [ ] **[DR4-004]** prompt-dedup.tsのisDuplicatePromptのJSDocにSHA-256衝突時の挙動を記載する
- [ ] **[DR4-005]** session-cleanup.tsのkillWorktreeSession()内でclearPromptHashCache(pollerKey)を呼び出す
- [ ] **[DR4-006]** ConversationPairCard等のコンポーネントがdangerouslySetInnerHTMLを使用していないことを確認する

---

*Generated by /design-policy command for Issue #565*
*Date: 2026-03-28*
*Stage 1 設計原則レビュー対応: 2026-03-28*
*Stage 2 整合性レビュー対応: 2026-03-28*
*Stage 3 影響分析レビュー対応: 2026-03-28*
*Stage 4 セキュリティレビュー対応: 2026-03-28*
