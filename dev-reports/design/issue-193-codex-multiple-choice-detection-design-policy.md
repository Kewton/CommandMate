# Issue #193 設計方針書: Codex CLI複数選択肢検出・応答対応

## 1. 概要

### 背景
CommandMateのプロンプト検出機能（`prompt-detector.ts`の`detectMultipleChoicePrompt()`）はClaude CLI固有の`❯`(U+276F)マーカーに依存した2パス検出方式（Issue #161）を使用している。Codex CLIの複数選択肢メッセージはこの形式と異なるため検出できず、UIからの手動応答およびAuto-Yes自動応答の両方が機能しない。

### 目的
Codex CLIの複数選択肢に対して、UIからの手動応答とAuto-Yes自動応答を可能にする。

### 制約条件
- `prompt-detector.ts`のCLIツール非依存性原則（Issue #161）を維持する
- Claude CLIの既存検出ロジックに影響を与えない（後方互換性）
- SOLID原則、特にOCP（開放/閉鎖原則）に準拠する

---

## 2. アーキテクチャ設計

### 2.1 現行アーキテクチャ（問題点）

```
                                         +---------------------------+
  tmux session output (raw + ANSI codes) |
                                         +-------------+-------------+
                                                       |
                                               +-------v--------+
                                               |  stripAnsi()   |  <-- cli-patterns.ts
                                               +-------+--------+
                                                       |
                                               +-------v----------------------------+
                                               |  detectPrompt(cleanOutput)         |  <-- prompt-detector.ts
                                               |  +-------------------------+       |
                                               |  | Pass 1: U+276F          |       |  <-- Claude CLI marker
                                               |  | existence check         |       |
                                               |  +------------+------------+       |
                                               |               | not found          |
                                               |               v                    |
                                               |    return { isPrompt:false}        |  <-- Codex choices lost here
                                               +------------------------------------+
```

**問題**: `detectPrompt()`はCLIツール種別を受け取らず、Claude CLI固有のパターンのみでハードコードされている。

### 2.2 新アーキテクチャ（案B: パターンパラメータ化）

```
                                         +---------------------------+
  tmux session output (raw + ANSI codes) |
                                         +-------------+-------------+
                                                       |
                                               +-------v--------+
                                               |  stripAnsi()   |  <-- cli-patterns.ts
                                               +-------+--------+
                                                       |
                               +-----------------------v---------------------------+
                               | detectPromptForCli(cleanOutput, cliToolId)       |  <-- cli-patterns.ts (new)
                               |  +-----------------------------------------------+
                               |  | getChoiceDetectionPatterns(cliToolId)          |
                               |  |   claude -> { indicator: default, ...}         |
                               |  |   codex  -> { indicator: Codex pattern, ...}   |
                               |  +------------------------+-----------------------+
                               |                           |
                               |  +------------------------v-----------------------+
                               |  | detectPrompt(cleanOutput, opts?)               |  <-- prompt-detector.ts
                               |  |  +-----------------------------+               |
                               |  |  | Pass 1: opts.indicator      |               |  <-- Parameterized
                               |  |  | pattern existence check     |               |
                               |  |  +-------------+---------------+               |
                               |  |                | found                         |
                               |  |  +-------------v---------------+               |
                               |  |  | Pass 2: Collect options     |               |
                               |  |  | using indicator + normal    |               |
                               |  |  | patterns from opts          |               |
                               |  |  +-----------------------------+               |
                               |  +-----------------------------------------------|
                               +--------------------------------------------------+
```

**設計判断**: 案Bを採用。`detectPrompt()`にオプショナルなパターン設定を渡すことで、CLIツール非依存性を維持しつつ拡張可能にする。さらに、呼び出し元のDRY違反を軽減するため、`detectPromptForCli()`ラッパー関数を`cli-patterns.ts`に追加する（DR1-007対応）。

---

## 3. 設計パターン

### 3.1 パターンパラメータ化（Strategy的なアプローチ）

`prompt-detector.ts`はCLIツール固有の知識を持たず、呼び出し元がパターンセットを注入する。

```typescript
// src/lib/prompt-detector.ts

/**
 * Options for customizing prompt detection patterns.
 * When omitted, defaults to Claude CLI patterns (backward compatible).
 */
export interface DetectPromptOptions {
  /**
   * Pattern for the default option indicator line.
   * Claude: /^\s*\u276F\s*(\d+)\.\s*(.+)$/ (marker)
   * Codex: TBD after prerequisite confirmation
   */
  choiceIndicatorPattern?: RegExp;

  /**
   * Pattern for normal option lines (no indicator).
   * Default: /^\s*(\d+)\.\s*(.+)$/
   */
  normalOptionPattern?: RegExp;

  /**
   * Whether Layer 4 validation (at least one default indicator must exist)
   * should be enforced. Defaults to true for backward compatibility (Claude).
   *
   * Set to false for CLI tools that do not have a default-indicator concept
   * (e.g., Codex may present choices without marking a default).
   *
   * [DR1-001] This field addresses the concern that Layer 4's
   * hasDefaultIndicator check would cause silent detection failures
   * for CLI tools that do not use a default selection marker.
   */
  requireDefaultIndicator?: boolean;
}
```

**[DR1-005] 型定義の配置に関する設計決定**: `DetectPromptOptions`は`prompt-detector.ts`に定義する。`cli-patterns.ts`がこの型をimportすることで、`cli-patterns.ts` -> `prompt-detector.ts`方向の型依存が発生するが、以下の理由で許容する:
- インターフェースは小さく安定している（3フィールド）
- `prompt-detector.ts`が`cli-patterns.ts`をimportすることはないため、循環依存は発生しない
- 別途`src/types/prompt-detection.ts`に抽出する案も有力だが、現時点ではインターフェースが小さいためKISSを優先する
- 将来インターフェースが拡張された場合は、共有型ファイルへの抽出を検討する

**[DR1-004] TUIパスに関するISP注意事項**: 現在の`DetectPromptOptions`はテキストベース検出に特化している。将来TUIベース（矢印キー選択）のCLIツール対応が必要になった場合、`DetectPromptOptions`に入力方式のフィールドを追加するのではなく、検出（detection）と応答方式（response method）を分離した別インターフェース（例: `PromptResponseStrategy`）を導入すべきである。これによりISP（インターフェース分離原則）を維持する。

### 3.2 パターンファクトリ（cli-patterns.ts拡張）

CLIツール別のパターンセットを提供する新関数を`cli-patterns.ts`に追加する。

```typescript
// src/lib/cli-patterns.ts

/**
 * Get choice detection patterns for a CLI tool.
 * Used by callers to pass to detectPrompt() options.
 *
 * [DR1-006] Claude patterns are returned explicitly (not as empty object)
 * to make behavior self-documenting at the call site. Each CLI tool's
 * patterns are fully specified, eliminating the need to trace through
 * fallback logic in detectPrompt().
 */
export function getChoiceDetectionPatterns(cliToolId: CLIToolType): DetectPromptOptions {
  switch (cliToolId) {
    case 'claude':
      // Explicitly return Claude patterns for self-documenting behavior.
      // These match the DEFAULT_OPTION_PATTERN and NORMAL_OPTION_PATTERN
      // in prompt-detector.ts.
      return {
        choiceIndicatorPattern: CLAUDE_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CLAUDE_CHOICE_NORMAL_PATTERN,
        requireDefaultIndicator: true,
      };
    case 'codex':
      return {
        choiceIndicatorPattern: CODEX_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CODEX_CHOICE_NORMAL_PATTERN,
        // [DR1-001] Codex may not have a default indicator concept.
        // Set to false to prevent Layer 4 from silently rejecting
        // valid Codex multiple-choice prompts.
        requireDefaultIndicator: false,
      };
    default:
      return {
        choiceIndicatorPattern: CLAUDE_CHOICE_INDICATOR_PATTERN,
        normalOptionPattern: CLAUDE_CHOICE_NORMAL_PATTERN,
        requireDefaultIndicator: true,
      };
  }
}
```

### 3.3 コンビニエンスラッパー関数（DR1-007対応）

**[DR1-007] DRY原則遵守**: 5箇所以上の呼び出し元で同一の3行パターン（import + getChoiceDetectionPatterns + detectPrompt）を繰り返す代わりに、`cli-patterns.ts`にコンビニエンスラッパー関数を導入する。これにより、将来`DetectPromptOptions`にフィールドが追加された場合の修正箇所が1箇所に集約される。

```typescript
// src/lib/cli-patterns.ts

import { detectPrompt, PromptDetectionResult } from './prompt-detector';

/**
 * Convenience wrapper: detect prompts using CLI-tool-specific patterns.
 *
 * Encapsulates getChoiceDetectionPatterns() + detectPrompt() into a single call
 * to reduce DRY violations across 5+ call sites.
 *
 * @param cleanOutput - ANSI-stripped output text (caller must call stripAnsi first)
 * @param cliToolId - CLI tool type
 * @returns PromptDetectionResult
 */
export function detectPromptForCli(
  cleanOutput: string,
  cliToolId: CLIToolType
): PromptDetectionResult {
  const options = getChoiceDetectionPatterns(cliToolId);
  return detectPrompt(cleanOutput, options);
}
```

**依存方向**: `cli-patterns.ts` -> `prompt-detector.ts` (型import + 関数import)。これは「パターン定義モジュールが検出モジュールを利用する」方向であり、`prompt-detector.ts`がCLIツール知識を持たないという原則は維持される。

**呼び出し元の修正パターン**:

```typescript
// 修正前
const promptDetection = detectPrompt(cleanOutput);

// 修正後（ラッパー関数使用）
import { detectPromptForCli } from '@/lib/cli-patterns';
const promptDetection = detectPromptForCli(cleanOutput, cliToolId);
```

**注意**: `prompt-detector.ts`の`detectPrompt()`は引き続きpublic APIとして維持する。`detectPromptForCli()`は呼び出し元の利便性を高めるための追加APIであり、`detectPrompt()`を直接使用することも可能（テストコード等で有用）。

---

## 4. 前提条件: Codex CLI選択肢出力形式

### 4.1 確認が必要な項目

実装前に以下を実機確認し、結果に基づいて設計を確定する。

| # | 確認項目 | テキストベースの場合 | TUIベースの場合 |
|---|---------|-------------------|---------------|
| 1 | tmux capture-paneに選択肢テキストが含まれるか | 含まれる | ANSIエスケープのみの可能性 |
| 2 | 入力方式 | 番号入力+Enter | 矢印キー+Enter |
| 3 | デフォルト選択マーカー | パターンで検出可能 | ハイライトのみの可能性 |
| 4 | 設計パスの選択 | パターンマッチアプローチ（本設計書のメインパス） | TUI操作アプローチ（別途設計追補を作成） |

### 4.2 TUIベース選択肢の場合の代替設計

**[DR1-008] YAGNI適用**: スクリーンショット分析（4.3節）ではテキストベース入力の可能性が高い。TUIベース（矢印キー選択）の場合は、Phase 1の実機確認後に別途設計追補（design addendum）を作成する。現時点での詳細なTUI設計はYAGNI原則により省略する。

**TUI対応時の主な追加影響範囲**:
- `prompt-response/route.ts`: sendKeysで番号を矢印キーシーケンスへ変換
- `auto-yes-manager.ts`: sendKeysの変更
- 応答方式のインターフェース分離（3.1節のISP注意事項参照）

**既存の設計参考**: `codex.ts:91-96`のDown arrow + Enter操作パターン。

### 4.3 スクリーンショット分析

Issue #193のスクリーンショットから推測される形式:
- 1~4の番号付き選択肢が表示されている
- テキストベースで番号入力を要求している可能性が高い
- ただし、実際のtmuxバッファ出力は実機確認が必要

---

## 5. 詳細設計

### 5.1 cli-patterns.ts 変更

#### 追加パターン定義

```typescript
/**
 * Claude CLI choice indicator pattern (explicit, was previously DEFAULT_OPTION_PATTERN).
 * Exported for use in getChoiceDetectionPatterns().
 */
export const CLAUDE_CHOICE_INDICATOR_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;

/**
 * Claude CLI normal choice option pattern (explicit).
 */
export const CLAUDE_CHOICE_NORMAL_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

/**
 * Codex CLI choice indicator pattern.
 * TBD: Actual pattern to be determined after prerequisite confirmation.
 *
 * Possible patterns based on screenshot analysis:
 * - Highlighted/selected option marker
 * - Number with special prefix
 *
 * [DR4-002] SECURITY: When finalizing this pattern, it MUST:
 * - Use line-start (^) and line-end ($) anchors
 * - Avoid nested quantifiers (e.g., (a+)+)
 * - Avoid overlapping alternatives
 * - Limit repetition quantifiers
 * - Pass automated ReDoS safety verification (see Phase 2 checklist)
 */
export const CODEX_CHOICE_INDICATOR_PATTERN = /TBD_AFTER_CONFIRMATION/;

/**
 * Codex CLI normal choice option pattern.
 * TBD: Actual pattern to be determined after prerequisite confirmation.
 *
 * [DR4-002] Same ReDoS safety requirements as CODEX_CHOICE_INDICATOR_PATTERN.
 */
export const CODEX_CHOICE_NORMAL_PATTERN = /TBD_AFTER_CONFIRMATION/;
```

#### 新規関数

```typescript
/**
 * Get choice detection patterns for multiple choice prompt detection.
 * Returns DetectPromptOptions to pass to detectPrompt().
 *
 * @param cliToolId - CLI tool type
 * @returns Pattern options with explicit pattern values for all CLI tools
 */
export function getChoiceDetectionPatterns(cliToolId: CLIToolType): DetectPromptOptions;

/**
 * Convenience wrapper: detect prompts using CLI-tool-specific patterns.
 * Reduces DRY violations across call sites.
 *
 * @param cleanOutput - ANSI-stripped output text
 * @param cliToolId - CLI tool type
 * @returns PromptDetectionResult
 */
export function detectPromptForCli(
  cleanOutput: string,
  cliToolId: CLIToolType
): PromptDetectionResult;
```

### 5.2 prompt-detector.ts 変更

#### シグネチャ変更

```typescript
// Before
export function detectPrompt(output: string): PromptDetectionResult;

// After (backward compatible)
export function detectPrompt(
  output: string,
  options?: DetectPromptOptions
): PromptDetectionResult;
```

#### detectMultipleChoicePrompt 変更 (module-private)

**[DR2-009] 注記**: `detectMultipleChoicePrompt`はmodule-private関数（exportされていない）であり、外部からは`detectPrompt()`経由でのみアクセスされる。

```typescript
// Before (module-private, not exported)
function detectMultipleChoicePrompt(output: string): PromptDetectionResult;

// After (module-private, not exported)
function detectMultipleChoicePrompt(
  output: string,
  options?: DetectPromptOptions
): PromptDetectionResult;
```

**Pass 1変更**:
```typescript
// Before: hardcoded pattern
const DEFAULT_OPTION_PATTERN = /^\s*\u276F\s*(\d+)\.\s*(.+)$/;

// After: from options, default to Claude pattern
const indicatorPattern = options?.choiceIndicatorPattern ?? DEFAULT_OPTION_PATTERN;
```

**Pass 2変更**:
```typescript
// Before: hardcoded pattern
const NORMAL_OPTION_PATTERN = /^\s*(\d+)\.\s*(.+)$/;

// After: from options, default to existing pattern
const normalPattern = options?.normalOptionPattern ?? NORMAL_OPTION_PATTERN;
```

#### [DR1-001] Layer 3/4 バリデーションのCLIツール別適用

**Layer 3（連番検証: isConsecutiveFromOne）**: CLIツール非依存の一般的な検証であり、全てのCLIツールに適用する。番号が1始まりの連番であることは、任意のCLIツールの選択肢リストに共通する特性である。

**Layer 4（hasDefaultIndicator検証）**: Claude CLI固有の前提に基づく検証。Claude CLIは常にデフォルト選択肢を`❯`マーカーで示すため、`hasDefaultIndicator`が`true`であることを必須条件としている。しかし、Codex CLIではデフォルト選択マーカーが存在しない可能性がある。

**対応方針**: `DetectPromptOptions.requireDefaultIndicator`フィールドにより条件分岐する。`options.length < 2`チェックは`requireDefaultIndicator`に関わらず常に適用する独立した検証である（DR2-020対応）。

```typescript
// Layer 4a: Minimum options count validation (always applied, independent of requireDefaultIndicator)
// This check exists in the current code as: if (options.length < 2 || !hasDefaultIndicator)
// After refactoring, the two conditions are separated for clarity.
if (options.length < 2) {
  return { isPrompt: false, type: 'none', ... };
}

// Layer 4b: Default indicator validation (conditional on requireDefaultIndicator)
const requireDefault = options?.requireDefaultIndicator ?? true; // backward compatible
if (requireDefault && !hasDefaultIndicator) {
  return { isPrompt: false, type: 'none', ... };
}
// If requireDefault is false, skip Layer 4b and proceed with detection
```

**[DR2-020] 条件分離の根拠**: 実際のコード（L344-350）では`options.length < 2 || !hasDefaultIndicator`がOR条件で結合されている。`requireDefaultIndicator=false`の場合に`hasDefaultIndicator`チェックのみをスキップし、`options.length < 2`チェックは独立して維持する必要がある。上記の分離により、各条件の責務が明確になる。

**根拠**: Codex CLIの選択肢表示では、全選択肢が同等（デフォルトなし）の場合がある。Layer 4bをスキップすることで、このケースでも正常に検出できる。Layer 3（連番検証）およびLayer 4a（最小選択肢数検証）は引き続き適用されるため、通常テキストの誤検出防止は維持される。

**[DR4-003] requireDefaultIndicator=false時の防御低下に関する残余リスク**: `requireDefaultIndicator=false`（Codex用）の場合、Layer 4bのデフォルトインジケーター検証がスキップされ、防御レイヤーが減少する。Issue #161で対処したClaude CLIの番号付きリスト誤検出と同様のシナリオがCodex CLIでも発生しうる。以下の残存レイヤーで緩和する:
- **Layer 1（thinking check）**: `auto-yes-manager.ts`の`pollAutoYes()`で`detectThinking()`が事前チェックを行い、thinking中はプロンプト検出をスキップする。Codexの場合も`CODEX_THINKING_PATTERN`が存在するため、この防御は有効。**Codex Auto-Yesの主要防御として位置付ける。**
- **Layer 3（連番検証: isConsecutiveFromOne）**: 1始まりの連番であることを検証。偶発的な番号付きリストが連番でない場合に防御として機能する。
- **Phase 1での実機検証必須事項**: Codex CLIが通常出力（非選択肢）において連番の番号付きリスト（1. xxx, 2. xxx, ...）をnon-thinking状態で出力するかどうかを検証する。この状況が頻発する場合、Layer 4bの代替として以下のいずれかを導入する:
  - (a) 選択肢リストの直前に質問行（`?`で終わる行）が存在することを検証する
  - (b) 選択肢リストの前に空行またはセパレーターが存在することを検証する
  - (c) Codex固有の選択肢ヘッダーパターンを追加のLayer 4代替として検出する
- **許容される残余リスク**: ローカルデプロイモデル（CM_BIND=127.0.0.1）のため、誤検出時の影響はtmuxセッションに`1`が送信される程度であり、セキュリティ上の重大リスクは低い。ただしAuto-Yesが有効な場合のユーザー体験への影響を最小化するため、Phase 1での検証を必須とする。

### 5.3 呼び出し元の修正

**[DR1-007] 全呼び出し元は`detectPromptForCli()`ラッパーを使用する。** これにより修正パターンが統一され、将来のインターフェース変更時の修正箇所が集約される。

| ファイル | 行番号 | cliToolId取得元 | 修正内容 |
|---------|--------|---------------|---------|
| `auto-yes-manager.ts` | L290 | 引数`cliToolId` (L262) | `detectPromptForCli(cleanOutput, cliToolId)` |
| `status-detector.ts` | L87 | 引数`cliToolId` (L77) | `detectPromptForCli(cleanOutput, cliToolId)` (**注: 入力をlastLinesからcleanOutputに変更**、DR1-003参照) |
| `prompt-response/route.ts` | L75 | `cliToolId` (L50) | `detectPromptForCli(cleanOutput, cliToolId)` |
| `current-output/route.ts` | L88 | クエリパラメータ `cliTool` (L39-40)、フォールバック: `worktree.cliToolId` | `thinking ? { isPrompt: false, cleanContent: cleanOutput } : detectPromptForCli(cleanOutput, cliToolId)` (**注: 既存のthinking条件分岐を維持する**、DR2-007, DR2-017参照) |
| `response-poller.ts` | L442, L556 | 関数パラメータ`cliToolId`（`extractResponse()`の引数） | L442: `detectPromptForCli(stripAnsi(fullOutput), cliToolId)`, L556: `detectPromptForCli(stripAnsi(result.response), cliToolId)` (DR1-002, DR2-001, DR2-003参照) |
| `response-poller.ts` | L248 | N/A | 変更不要（Claude専用ガード内） |
| `claude-poller.ts` | L164, L232 | N/A | 変更不要（Claude専用 + optional引数で後方互換） |

**[DR1-010] current-output/route.ts の cliToolId 取得方法**: 現在のソースコード（L40付近）では、URLクエリパラメータ`cliTool`から取得し、未指定時は`worktree.cliToolId`にフォールバックする。この方式は以下の条件で正しく動作する:
- クライアント側の`useAutoYes.ts`および各ポーリングフックが、API呼び出し時に必ず`cliTool`クエリパラメータを付与すること
- `worktree.cliToolId`フォールバックがデフォルトで`'claude'`を返す場合、Codexセッションでクエリパラメータが欠落するとClaude用パターンが適用され、Codex選択肢の検出に失敗する

**確認事項**: Phase 3実装時に、以下のクライアント側呼び出し元が`cliTool`パラメータを付与していることを検証する:
- `src/hooks/useAutoYes.ts` - Auto-Yesポーリング時のAPI呼び出し
- `src/components/worktree/WorktreeDetailRefactored.tsx` - current-output取得時
- その他current-output APIを呼び出すコンポーネント/フック

### 5.4 response-poller.ts ANSI stripping修正とヘルパー関数抽出

**[DR2-001] 構造の明確化**: `response-poller.ts`はクラスではなくモジュールレベル関数で構成されている。`extractResponse()`はスタンドアロン関数であり、`cliToolId`は関数パラメータとして受け取る（`this.cliToolId`ではない）。

**[DR1-002, DR2-003] DRY改善**: L442とL556で同一のdetectPrompt呼び出しパターンが重複している。`detectPromptForCli()`ラッパーの導入により、各呼び出し箇所は以下の1行に統一される:

```typescript
// Before (L442) -- 変数名はfullOutput（lines.join('\n')）
const promptDetection = detectPrompt(fullOutput);

// Before (L556) -- 変数名はresult.response
const promptDetection = detectPrompt(result.response);

// After (L442)
const promptDetection = detectPromptForCli(stripAnsi(fullOutput), cliToolId);

// After (L556)
const promptDetection = detectPromptForCli(stripAnsi(result.response), cliToolId);
```

**追加推奨**: response-poller.ts内部でstripAnsiの結果を変数に格納して再利用する方式を推奨する。

```typescript
// extractResponse() 関数内（cliToolIdは関数パラメータ）
// ... L442付近
const cleanFullOutput = stripAnsi(fullOutput);
const promptDetection = detectPromptForCli(cleanFullOutput, cliToolId);
// ... L556付近
const cleanResponse = stripAnsi(result.response);
const promptDetection2 = detectPromptForCli(cleanResponse, cliToolId);
```

**注意**: L442の`fullOutput`とL556の`result.response`は異なる変数であるため、それぞれ個別にstripAnsiを適用する必要がある。

### 5.5 [DR1-003] status-detector.ts ウィンドウイング修正

**問題**: `status-detector.ts`はL87で`detectPrompt(lastLines)`を呼び出しているが、`lastLines`は`STATUS_CHECK_LINE_COUNT = 15`行に制限された出力である。一方、`detectMultipleChoicePrompt()`の内部では最新50行をスキャンウィンドウとして使用する。status-detectorから15行のみが渡された場合、50行ウィンドウは実質15行に制限される。

**他の呼び出し元との不整合**: `auto-yes-manager.ts`（L290）はフルの`cleanOutput`を`detectPrompt()`に渡しており、`detectMultipleChoicePrompt()`が自身の50行ウィンドウイングを正しく適用できる。status-detectorのみがプリウィンドウされた出力を渡しているため、Codexの選択肢が4個以上ある場合に検出が不安定になるリスクがある。

**修正方針**: status-detector.tsの`detectPrompt()`呼び出しにおいて、`lastLines`（15行）ではなくフルの`cleanOutput`を渡すように変更する。これにより、ウィンドウイングの責務は`detectMultipleChoicePrompt()`内部に統一される。

```typescript
// Before (status-detector.ts L87)
const promptDetection = detectPrompt(lastLines);

// After
// Pass full cleanOutput to let detectMultipleChoicePrompt handle its own
// 50-line windowing consistently with other call sites (auto-yes-manager.ts etc.)
const promptDetection = detectPromptForCli(cleanOutput, cliToolId);
```

**注意**: `lastLines`は他のステータス判定ロジック（promptパターンマッチ等）で引き続き使用される。変更するのは`detectPrompt()`呼び出しのみ。

**[DR2-013] 内部ウィンドウイングの詳細**: `detectPrompt()`内部では、yes/noパターン検出は最後の10行（`lines.slice(-10)`、prompt-detector.ts L48）を使用し、multiple_choice検出は最後の50行をスキャンウィンドウとして使用する。status-detectorの`STATUS_CHECK_LINE_COUNT = 15`行は10行より大きいため、yes/noパターン検出には影響しない。影響を受けるのはmultiple_choice検出のみであり、フルの`cleanOutput`を渡す変更はこのmultiple_choice検出の一貫性を確保するためのものである。

**既知の制限事項**: この変更後も、Codex CLIの選択肢数が50個を超える場合は検出できない。ただし一般的なCLIの選択肢数（2~10個）では問題にならない。

---

## 6. セキュリティ設計

### 6.1 既存のセキュリティ対策との整合性

| 対策 | 内容 | 影響 |
|------|------|------|
| ReDoS防止 | パターンは行頭/行末アンカー付き | Codexパターンも同様にアンカー付きとする |
| コマンドインジェクション防止 | `sendKeys()`経由のtmux操作 | **[DR4-001]** 入力サニタイズ要件を追加（6.3節参照） |
| worktreeID検証 | `isValidWorktreeId()` | 変更なし |
| 入力バリデーション | `getAnswerInput()`の数値検証 | **[DR4-005]** prompt-response/route.tsにも検証を追加（6.4節参照） |
| エラーメッセージ | 各API routeのエラーレスポンス | **[DR4-004]** 固定エラーメッセージを使用（6.5節参照） |

### 6.2 新規パターンのセキュリティ要件

- Codex選択肢パターンは**行頭・行末アンカー**付きとする（S4-001準拠）
- `.*`や`\s+`の無制限繰り返しを避ける
- テスト時にReDoS脆弱性チェックを含める

**[DR4-002] ReDoS安全パターン構成ルール**:

Codexパターン確定時に以下のルールを厳守する:

1. **常にアンカーを使用**: `^` と `$` で行頭・行末を固定する
2. **ネストされた量指定子を禁止**: `(a+)+`, `(a*)*`, `(a+)*` のような構成を使用しない
3. **重複する選択肢を避ける**: `(a|a)` や `(\s| )+` のようなパターンを使用しない
4. **繰り返し量指定子を制限する**: `{0,}` の代わりに `{0,100}` のような上限付き量指定子を使用する
5. **自動検証ツールによる検証を必須とする**: `safe-regex` または `recheck` npmパッケージでReDoS安全性を検証する

**検証手順**:
```bash
# safe-regex パッケージで検証
npx safe-regex '/^your-pattern$/'

# または recheck パッケージで検証
npx recheck '/^your-pattern$/'
```

**病理的入力によるテスト**: 各新規パターンに対して以下のテストケースを実行する:
- 1000文字以上の行（部分一致を含む）
- 繰り返しパターンを含む入力（例: "1. " x 200）
- 混合文字種の長文入力

**[DR4-009] TEXT_INPUT_PATTERNS改善推奨**: 既存の`TEXT_INPUT_PATTERNS`配列（prompt-detector.ts L169-175）のパターン（例: `/type\s+here/i`）は実用上のReDoSリスクは最小限（tmux出力のラベルは短い）だが、以下の改善を推奨する:
- 単語境界（`\b`）を追加して部分文字列の誤マッチを防止する（例: `/\btype\s+here\b/i`）
- これにより "prototype here" のような文字列でのfalse positiveを防止できる
- 優先度は低いが、Phase 4のテスト追加時に併せて対応を検討する

### 6.3 [DR4-001] sendKeys コマンドインジェクション防止

**リスク**: `prompt-response/route.ts`（L92）および`respond/route.ts`（L99-101）では、ユーザーが入力した`answer`値が`sendKeys(sessionName, answer, false)`を通じてtmuxセッションに送信される。`sendKeys()`関数はシングルクォートのエスケープのみを行い（`keys.replace(/'/g, "'\\''")`）、tmux固有の制御シーケンスやキー名のインジェクションは防御されていない。特に`respond/route.ts`はmultiple_choiceプロンプトに対してユーザーが入力した任意テキスト（`answer`が数値でない場合）をそのまま送信する。

**OWASP分類**: A03:2021-Injection

**現行の緩和策**:
- `sessionName`は`SESSION_NAME_PATTERN`で検証済み
- `sendKeys()`はシングルクォートをエスケープ
- デフォルトデプロイは`CM_BIND=127.0.0.1`（ローカルのみ）

**追加対策（本Issue範囲）**:

1. **multiple_choice回答の数値バリデーション強化**: `getAnswerInput()`で回答が数値であることを検証する既存ロジックを、`prompt-response/route.ts`でも適用する（6.4節参照）
2. **テキスト入力の長さ制限**: `respond/route.ts`でカスタムテキスト入力（`answer`が数値でない場合）に最大長制限（1000文字）を適用する
3. **制御文字のフィルタリング**: `answer`文字列から非印刷制御文字（`\x00`-`\x1F`、`\x7F`、ただし改行は除く）を除去する

**[DR4-006] tmux.ts exec() vs execFile() について**: `sendKeys()`は`exec()`（child_process）を使用しており、コマンドがシェルを通じて解釈される。`execFile()`や`spawn()`に移行すればシェル解釈を回避できるが、tmuxのsend-keysコマンドの引数渡し方式の変更が必要であり、本Issue（#193）のスコープ外とする。

- **残余リスク**: シングルクォートエスケープ + セッション名検証により、一般的なシェルインジェクションは防御されている。ただし、特殊なバイトシーケンス（nullバイト等）がシェル層で異なる解釈を受ける理論的可能性がある。
- **フォローアップ**: 別Issueで`tmux.ts`の`exec()` -> `execFile()`移行を検討する。移行例: `execFile('tmux', ['send-keys', '-t', sessionName, keys])`
- **暫定対策**: 入力テキストの長さ制限（1000文字）と制御文字フィルタリングにより、残余リスクを低減する

### 6.4 [DR4-005] prompt-response/route.ts 入力バリデーション追加

**問題**: `prompt-response/route.ts`（L92）は`answer`値をtmuxに送信する前にフォーマット検証を行っていない。`respond/route.ts`は`getAnswerInput()`で検証を行うが、`prompt-response/route.ts`はプロンプト状態の再検証のみ行い、回答フォーマットの検証がない。

**追加バリデーション要件**:

```typescript
// prompt-response/route.ts に追加するバリデーション
// (1) プロンプトタイプに応じた回答フォーマット検証
if (promptData.type === 'multiple_choice') {
  // 数値のみ許可（既存の getAnswerInput() ロジックと一貫性）
  if (!/^\d+$/.test(answer)) {
    return NextResponse.json(
      { error: 'Invalid answer format for multiple choice prompt' },
      { status: 400 }
    );
  }
}
if (promptData.type === 'yes_no') {
  // y/n/yes/no のみ許可
  if (!/^(y|n|yes|no)$/i.test(answer)) {
    return NextResponse.json(
      { error: 'Invalid answer format for yes/no prompt' },
      { status: 400 }
    );
  }
}

// (2) 最大長制限
const MAX_ANSWER_LENGTH = 1000;
if (answer.length > MAX_ANSWER_LENGTH) {
  return NextResponse.json(
    { error: 'Answer exceeds maximum length' },
    { status: 400 }
  );
}

// (3) 制御文字フィルタリング
const sanitizedAnswer = answer.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
```

### 6.5 [DR4-004] エラーメッセージの情報漏洩防止

**問題**: `getAnswerInput()`（prompt-detector.ts L418）のエラーメッセージ`Error('Invalid answer for multiple choice: ${answer}')`がユーザー入力をエコーバックする。`respond/route.ts`（L109）はこのエラーメッセージをクライアントにそのまま返却する。`prompt-response/route.ts`（L44）はworktreeIDを404エラーに含める。`CM_BIND=0.0.0.0`設定時にネットワーク経由で情報収集に利用されるリスクがある。

**OWASP分類**: A01:2021-Broken Access Control / Information Disclosure

**対応方針**: 既存の`db-repository.ts`パターン（CLAUDE.md記載の「固定エラーメッセージ（情報漏洩防止）」）と一貫性を保ち、固定エラーメッセージを使用する:

| 箇所 | 現在のメッセージ | 修正後のメッセージ |
|------|----------------|------------------|
| `getAnswerInput()` | `Invalid answer for multiple choice: ${answer}` | `Invalid answer format for multiple choice prompt` |
| `respond/route.ts` エラーレスポンス | エラーメッセージのエコーバック | 固定メッセージ `Invalid answer format` |
| `prompt-response/route.ts` 404 | `Worktree not found: ${id}` | `Worktree not found` |

**ログ出力**: 詳細な入力値はサーバーサイドの`console.error()`（デバッグログ）にのみ出力し、クライアントレスポンスには含めない。

### 6.6 [DR4-010] ANSI_PATTERN /gフラグに関する情報的注記

`ANSI_PATTERN`（cli-patterns.ts L167）は`/g`フラグ付きのモジュールレベルRegExpオブジェクトであり、`lastIndex`の内部状態を持つ。`String.prototype.replace()`はこの状態を正しくリセットするため、`stripAnsi()`の現行使用方法では問題ない。ただし、将来`test()`や`exec()`メソッドで使用する場合は`lastIndex`のリセットが必要となる。本件は現時点で対応不要であり、情報的注記のみとする。

---

## 7. パフォーマンス設計

### 7.1 影響分析

| 箇所 | 影響 | 理由 |
|------|------|------|
| `detectMultipleChoicePrompt()` | 最小限 | パターンオブジェクトの参照渡しのみ、計算量は変わらない |
| 呼び出し元 | 最小限 | `getChoiceDetectionPatterns()`は単純なswitch文 |
| `detectPromptForCli()` | 最小限 | `getChoiceDetectionPatterns()` + `detectPrompt()`の薄いラッパー |
| ポーリング間隔 | 変更なし | 2秒間隔は維持 |

### 7.2 status-detector.ts のウィンドウイング

**[DR1-003] ウィンドウイング方針変更**: 以前は`STATUS_CHECK_LINE_COUNT = 15`行のみを`detectPrompt()`に渡していたが、フルの`cleanOutput`を渡す方式に変更する（5.5節参照）。

- `detectMultipleChoicePrompt()`内部の50行ウィンドウイングが一貫して適用される
- `detectPrompt()`内部のyes/noパターン検出は最後の10行（L48）を使用するが、status-detectorの15行渡しでも50行渡しでもこの10行スライスは正しく機能する [DR2-013]
- status-detector.tsの他のステータス判定ロジック（`lastLines`使用箇所）は変更しない
- パフォーマンスへの影響は最小限（`detectMultipleChoicePrompt()`が内部で50行にスライスするため）
- **[DR3-004] 並列処理時のパフォーマンス影響**: `worktrees/route.ts`は`captureSessionOutput(worktree.id, cliToolId, 100)`（capture_count=100行）で出力を取得し、`Promise.all`で全ワークツリーを並列処理する（L33-99）。各ワークツリーにつき最大3つのCLIツール（claude, codex, gemini）について`detectSessionStatus()`が呼び出される。`detectPrompt`に渡される出力は最大100行であり、15行から100行への変更は、`detectMultipleChoicePrompt`内部の50行スライスにより実質的な計算量増加はない。ただし、複数ワークツリーの並列処理時のメモリ使用量は微増する（各呼び出しで15行分ではなく100行分の文字列が`detectPrompt`に渡されるため）。一般的な使用条件（10ワークツリー以下）では問題にならない。

---

## 8. テスト設計

### 8.1 新規テスト

#### prompt-detector.test.ts 追加テストケース

| テストケース | 入力 | 期待出力 |
|------------|------|---------|
| Codex選択肢検出（デフォルト付き） | Codex形式の選択肢出力 | `isPrompt: true, type: 'multiple_choice'` |
| Codex選択肢検出（デフォルトなし） | Codex形式（マーカーなし） | `isPrompt: true, type: 'multiple_choice'` |
| Claude選択肢（既存動作確認） | Claude形式の選択肢出力 | 既存と同じ結果（回帰テスト） |
| options省略時のデフォルト動作 | Claude形式 + options未指定 | 既存と同じ結果（後方互換） |
| Codexパターンで通常テキスト | 番号付きリスト（非選択肢） | `isPrompt: false`（誤検出防止） |
| requireDefaultIndicator=false | 選択肢（デフォルトマーカーなし） | `isPrompt: true`（Layer 4スキップ） |
| requireDefaultIndicator=true（デフォルト） | 選択肢（デフォルトマーカーなし） | `isPrompt: false`（Layer 4でリジェクト） |

#### cli-patterns.test.ts 追加テストケース

**[DR3-007] テストファイル配置方針**: cli-patternsのテストファイルは2つ存在する: (1) `src/lib/__tests__/cli-patterns.test.ts`（Issue #132, #54向け）、(2) `tests/unit/lib/cli-patterns.test.ts`（Issue #4向け）。新規テスト（`getChoiceDetectionPatterns`, `detectPromptForCli`）は `tests/unit/lib/cli-patterns.test.ts` に追加する。`src/lib/__tests__/cli-patterns.test.ts` は既存のまま維持し、テストファイルの統合は別Issueで検討する。

| テストケース | 入力 | 期待出力 |
|------------|------|---------|
| `getChoiceDetectionPatterns('claude')` | - | Claude用パターン設定（明示的な値） |
| `getChoiceDetectionPatterns('codex')` | - | Codex用パターン設定 + `requireDefaultIndicator: false` |
| `getChoiceDetectionPatterns('gemini')` | - | デフォルト（Claude用）パターン設定 |
| Codexパターンのアンカー検証 | 各種入力 | ReDoS安全性確認 |
| `detectPromptForCli()` 基本動作 | cleanOutput + cliToolId | detectPromptと同じ結果 |
| **[DR4-002] ReDoS病理的入力テスト** | 1000文字以上の部分マッチ入力 | 100ms以内に完了すること |

### 8.2 既存テストのモック更新

`detectPrompt`のシグネチャ変更に伴い、以下のテストファイルのモック定義を更新する。

| ファイル | モック箇所 | 修正内容 |
|---------|----------|---------|
| `auto-yes-manager.test.ts` | `vi.mock()`宣言内の`detectPrompt`モック定義（ファイル先頭付近） | 第2引数（optional）を受け付けるモックに更新 [DR2-012]。**[DR3-011] 注記**: auto-yes-manager.ts の import が `detectPrompt`（from prompt-detector）から `detectPromptForCli`（from cli-patterns）に変わった場合、このテストファイルでは prompt-detector を直接モックしていないため（L22-38: cli-session, tmux, cli-tools/manager のみモック）、モック設定への直接的な影響はない。ただし、auto-yes-manager.ts の import 変更後に既存テストが正しく動作することを確認すること。 |
| `prompt-response-verification.test.ts` | L50（モック定義）、L112/L141付近（`vi.mocked(detectPrompt).mockReturnValue()`呼び出し） | 同上 [DR2-012] |
| `src/lib/__tests__/status-detector.test.ts` | `detectSessionStatus()`を直接呼び出すテスト全体 | **[DR3-002]** 以下のテスト更新が必要: (1) 15行ウィンドウ境界テスト（L374-385）: full cleanOutput渡しへの変更後の期待値確認、(2) multiple choice prompt検出テスト（L92-104）: full cleanOutput渡しの動作確認、(3) Issue #180 past promptsテスト（L203-351）: windowing変更後の動作確認。内部的に`detectPrompt()`が`detectPromptForCli()`経由で呼ばれるため、テスト内でのモック設定変更または統合テストとしての動作確認が必要。 |

**[DR2-012] テストモック特定のガイドライン**: 行番号はコード変更に伴いずれる可能性があるため、実装時は行番号よりもモック名・関数名で対象箇所を特定すること。`detectPrompt`のモック定義は`vi.mock('../../../src/lib/prompt-detector')`ブロック内の`detectPrompt`キーを検索する。

---

## 9. データモデル設計

### 9.1 既存モデルへの影響

`PromptData`型（`src/types/models.ts`）は変更不要。

```typescript
// 既存のMultipleChoiceOption - Codex選択肢にもそのまま使用可能
export interface MultipleChoiceOption {
  number: number;
  label: string;
  isDefault?: boolean;        // Codexにデフォルトがない場合はfalse（明示的に設定）
  requiresTextInput?: boolean;
}
```

**[DR2-011] isDefaultフィールドの取り扱い**: `isDefault`はoptional boolean（`isDefault?: boolean`）であり、`undefined`と`false`はJavaScript的に同じfalsyだが、型安全性の観点から以下のルールを適用する:
- **Claude CLI**: 既存のprompt-detector.tsの処理に従い、`isDefault: true`（デフォルトマーカー付き）または`isDefault: false`（マーカーなし）を**明示的に設定**する
- **Codex CLI**: 全選択肢に`isDefault: false`を**明示的に設定**する（`undefined`のままにしない）
- `auto-yes-resolver.ts`のフォールバック動作: `promptData.options.find(o => o.isDefault)`がundefinedの場合、`options[0]`（最初の選択肢）が自動選択される。Codexの場合、全選択肢が`isDefault: false`のため、常に最初の選択肢がAuto-Yes応答の対象となる

### 9.2 DBスキーマへの影響

なし。プロンプト検出はインメモリ処理のみ。

---

## 10. API設計

### 10.1 既存APIへの影響

| API | 変更 | 詳細 |
|-----|------|------|
| `POST /api/worktrees/[id]/prompt-response` | 動作改善 + 入力バリデーション追加 | Codex選択肢を正しく検出するようになる。**[DR4-005]** 回答フォーマット検証（数値/y/n）、最大長制限（1000文字）、制御文字フィルタリングを追加（6.4節参照）。 |
| `GET /api/worktrees/[id]/current-output` | 動作改善 | Codex選択肢時に`isPromptWaiting: true`を正しく返す |
| `POST /api/worktrees/[id]/respond` | 動作確認 + テキスト入力サニタイズ | `getAnswerInput()`経由で動作確認。**[DR4-001]** カスタムテキスト入力に対する最大長制限（1000文字）と制御文字フィルタリングを追加。 |

**[DR4-007] レート制限に関する注記**: `prompt-response` APIエンドポイントにはレート制限がない。急速な連続リクエストにより、tmuxセッションへのキー送信が連続発生する可能性がある。ローカルデプロイモデルのためリスクは低いが、将来的にperワークツリーのレート制限（例: 5リクエスト/秒）の導入を検討する。Auto-Yesポーリングパスは`MAX_CONCURRENT_POLLERS=50`で保護されている。

### 10.2 レスポンス形式の変更

なし。既存の`PromptData`型で表現可能。

---

## 11. 設計上の決定事項とトレードオフ

### 11.1 採用した設計

| 決定事項 | 採用案 | 理由 | トレードオフ |
|---------|-------|------|-------------|
| パターン注入方式 | 案B: パターンパラメータ化 | Issue #161のCLIツール非依存性を維持 | 呼び出し元すべてに修正が必要 |
| 後方互換性 | optional引数 | 既存呼び出し元の段階的移行が可能 | デフォルト値の暗黙的依存 |
| パターン提供元 | cli-patterns.ts | 既存のCLIパターン管理と一貫性 | prompt-detector.tsの依存方向を維持 |
| DRYラッパー | detectPromptForCli() | 5+呼び出し元の修正パターン統一（DR1-007） | 関数が1つ増える（薄いラッパー） |
| Layer 4条件化 | requireDefaultIndicator | Codexのデフォルトマーカー非存在に対応（DR1-001） | インターフェースフィールドが1つ増加 |
| ウィンドウイング統一 | status-detectorでfull output渡し | 呼び出し元間の一貫性確保（DR1-003） | status-detectorの処理量がわずかに増加 |

**[DR1-009] デフォルトパターンのClaude結合について**: `prompt-detector.ts`の`DEFAULT_OPTION_PATTERN`と`NORMAL_OPTION_PATTERN`がモジュールレベル定数としてClaude CLIパターンをハードコードしている件は、意図的な設計判断である。完全なDIP準拠（デフォルトパターンも外部注入）は過度な抽象化となり、KISS原則に反する。後方互換性のため、`options`未指定時はこれらのデフォルトが使用されることを明記する。`getChoiceDetectionPatterns()`が全CLIツールの明示的パターンを返す設計（DR1-006）により、新規呼び出し元ではこのデフォルトフォールバックに依存しない。

### 11.2 不採用の代替案

| 代替案 | 不採用理由 |
|--------|----------|
| 案A: cliToolId引数 | prompt-detector.tsにCLIToolType依存が入り、非依存性原則に違反 |
| 案C: ラッパー関数のみ（パラメータ化なし） | detectPrompt内部のパターンが拡張不能 |
| detectPrompt内でパターン自動判定 | CLIツール知識がprompt-detector.tsに入り、SRP違反 |
| DetectPromptOptionsを別ファイルに抽出 | 現時点ではインターフェースが小さくKISS優先（DR1-005）。将来拡張時に再検討 |

---

## 12. 変更対象ファイル一覧

### 12.1 変更が必要なファイル

| ファイル | 変更種別 | 優先度 |
|---------|---------|--------|
| `src/lib/cli-patterns.ts` | パターン追加 + `getChoiceDetectionPatterns()` + `detectPromptForCli()` | Phase 2 |
| `src/lib/prompt-detector.ts` | `DetectPromptOptions`追加 + シグネチャ変更 + Layer 4条件化 + エラーメッセージ修正 [DR4-004] | Phase 2 |
| `src/lib/auto-yes-manager.ts` | `detectPromptForCli()`呼び出しに変更 | Phase 3 |
| `src/lib/status-detector.ts` | `detectPromptForCli(cleanOutput, cliToolId)`に変更（ウィンドウイング修正含む） | Phase 3 |
| `src/lib/response-poller.ts` | L442: `detectPromptForCli(stripAnsi(fullOutput), cliToolId)`, L556: `detectPromptForCli(stripAnsi(result.response), cliToolId)`に変更（2箇所）[DR2-001, DR2-003] | Phase 3 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | `detectPromptForCli()`呼び出しに変更 + 入力バリデーション追加 [DR4-005] + エラーメッセージ修正 [DR4-004] | Phase 3 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | `detectPromptForCli()`呼び出しに変更 + cliToolId取得確認 | Phase 3 |
| `src/app/api/worktrees/[id]/respond/route.ts` | テキスト入力サニタイズ追加 [DR4-001] + エラーメッセージ修正 [DR4-004] | Phase 3 |
| `tests/unit/prompt-detector.test.ts` | テスト追加（Layer 4条件化含む） | Phase 4 |
| `tests/unit/lib/cli-patterns.test.ts` | テスト追加（`detectPromptForCli()`含む + ReDoS病理的入力テスト）[DR3-007, DR4-002] | Phase 4 |
| `tests/unit/lib/auto-yes-manager.test.ts` | モック更新 | Phase 4 |
| `tests/unit/api/prompt-response-verification.test.ts` | モック更新 | Phase 4 |
| `src/lib/__tests__/status-detector.test.ts` | テスト更新（15行ウィンドウ境界テスト、multiple choice prompt検出テスト、Issue #180 past promptsテスト）[DR3-002] | Phase 4 |

### 12.2 変更不要なファイル（後方互換性による）

| ファイル | 理由 |
|---------|------|
| `src/lib/claude-poller.ts` | Claude専用 + optional引数で後方互換。**[DR3-009]** `startPolling()`は現在呼び出されておらず、内部の`detectPrompt()`呼び出し（L164, L232）は到達不能コードである（Issue #180で確認済み）。将来の廃止/統合を別Issueで検討すること。 |
| `src/lib/response-poller.ts` L248 | Claude専用ガード内（`if (cliToolId === 'claude')` L244）。**[DR3-003]** L248は既に`stripAnsi(fullOutput)`を`cleanFullOutput`に格納した上で`detectPrompt(cleanFullOutput)`を呼び出しており、stripAnsi適用済みである。一方、L442は`detectPrompt(fullOutput)`でstripAnsi未適用のままであった。この差異が本修正の背景であり、L442は`detectPromptForCli(stripAnsi(fullOutput), cliToolId)`に変更する（12.1節参照）。L248はClaude専用ガード内かつstripAnsi適用済みのため現時点では変更不要。 |

**[DR2-002] 将来の検討事項**: `response-poller.ts` L248の`detectPrompt()`呼び出しはClaude専用ガード（`if (cliToolId === 'claude')`）内にあるため、現時点では変更不要と判断している。ただし、将来的にCodexセッションでもresponse-poller.tsの同一パスが使用される場合、このClaude専用ガードの拡張（ガードの撤廃またはCodex条件の追加）が必要になる可能性がある。その際は`detectPromptForCli()`への移行を検討すること。

### 12.3 動作確認が必要なファイル

| ファイル | 確認内容 |
|---------|---------|
| `src/lib/auto-yes-resolver.ts` | isDefaultフラグのCodex動作（requireDefaultIndicator=false時） |
| `src/lib/cli-tools/codex.ts` | TUI操作パターンの参照 |
| `src/components/worktree/PromptPanel.tsx` | Codex選択肢のUI描画 |
| `src/components/worktree/MobilePromptSheet.tsx` | モバイル版UI描画 |
| `src/components/worktree/PromptMessage.tsx` | 回答済みプロンプト描画 |
| `src/hooks/useAutoYes.ts` | 重複応答防止の動作 + cliToolクエリパラメータ付与確認 |
| `src/app/api/worktrees/[id]/respond/route.ts` | getAnswerInput経由の動作。**[DR3-010]** respond/route.ts L178は`startPolling(params.id, cliToolId)`を呼び出してresponse-poller.tsのポーリングを再開する。呼び出しチェーン: respond/route.ts -> startPolling() -> checkForResponse() -> extractResponse() -> detectPrompt()。Codexセッションでmultiple_choice promptに応答した後のポーリング再開時に、extractResponse()内のdetectPromptForCli()がCodex用パターンを正しく適用することを確認する。 |
| `src/app/api/worktrees/route.ts` | **[DR3-001]** `detectSessionStatus()`を呼び出している（L16, L58）。`detectSessionStatus()`内部の`detectPrompt()`呼び出しが`lastLines`から`cleanOutput`に変更されることで、サイドバーステータス表示への影響を確認する。特にmultiple_choice prompt表示時のwaitingステータスが正しく反映されることを検証。 |
| `src/app/api/worktrees/[id]/route.ts` | **[DR3-001]** `detectSessionStatus()`を呼び出している（L13, L58）。上記と同様、個別ワークツリーのステータス取得APIにおいて、内部動作変更（full cleanOutputをdetectPromptに渡す変更）による影響を確認する。 |

### 12.4 [DR1-010] クライアント側cliToolパラメータ付与の検証対象

Phase 3で以下のファイルがAPI呼び出し時に`cliTool`クエリパラメータを付与していることを検証する:

**[DR3-006] 補正**: `useAutoYes.ts`は`current-output` APIを直接呼び出していない。`useAutoYes.ts`（L86-89）は`/api/worktrees/${worktreeId}/prompt-response` APIに`cliTool`パラメータを渡している。`current-output` APIの呼び出しは`WorktreeDetailRefactored.tsx`（L972）が行い、`activeCliTabRef.current`から`cliTool`パラメータを付与している。サーバー側Auto-Yesポーリング（`auto-yes-manager.ts`）の結果は`current-output` APIのレスポンスを通じて間接的にクライアントに伝わる。

| ファイル | API呼び出し箇所 | 確認内容 |
|---------|----------------|---------|
| `src/hooks/useAutoYes.ts` | `prompt-response` API（L86-89） | `cliTool`パラメータが`prompt-response` APIに渡されていること（current-output APIは直接呼び出していない） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `current-output` API取得（L972） | `cliTool`パラメータの有無（`activeCliTabRef.current`から取得） |

---

## 13. 実装フェーズ

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | 前提条件確認（Codex CLIの出力形式を実機確認） | なし |
| 2 | パターン定義・コア実装（cli-patterns.ts + prompt-detector.ts） | Phase 1 |
| 3 | 全呼び出し元の修正（`detectPromptForCli()`使用、cliToolパラメータ検証含む）+ 入力バリデーション追加 [DR4-001, DR4-004, DR4-005] | Phase 2 |
| 4 | テスト追加・既存テスト更新 + ReDoS病理的入力テスト [DR4-002] | Phase 3 |
| 5 | 動作検証（UI手動 + Auto-Yes） | Phase 4 |

---

## 14. リスクと緩和策

| リスク | 影響 | 緩和策 |
|--------|------|--------|
| Codex CLIがTUIベース | パターンマッチが機能しない | Phase 1確認後に別途設計追補を作成（4.2節） |
| 既存Claude検出の回帰 | 重大 | optional引数 + 回帰テスト |
| Codexパターンの誤検出 | Auto-Yesの誤動作 | Layer 1(thinking check) + Layer 3(連番検証)は維持。**[DR4-003]** Phase 1でCodex出力の番号付きリスト頻度を検証し、Layer 4b代替を要否判定する |
| response-poller.tsのstripAnsi追加 | 既存動作への影響 | 他の呼び出し箇所と同じ挙動に統一するため低リスク |
| Layer 4スキップによる誤検出増加 | Codexで偽陽性 | Layer 3（連番検証）が防御、Phase 1で実機検証。**[DR4-003]** Layer 1（thinking check）をCodex Auto-Yesの主要防御として位置付け |
| current-output APIのcliToolパラメータ欠落 | Codex検出失敗 | Phase 3でクライアント側呼び出し元を全数検証（DR1-010） |
| **[DR4-001] tmux sendKeysへの未サニタイズ入力送信** | コマンドインジェクション | 回答フォーマット検証 + 最大長制限 + 制御文字フィルタリング（6.3節、6.4節） |
| **[DR4-002] TBD Codexパターンによるリソース枯渇** | ReDoS（DoS） | 自動化されたReDoS検証ツールの必須使用 + 病理的入力テスト（6.2節） |
| **[DR4-004] エラーメッセージ経由の情報漏洩** | 情報収集（CM_BIND=0.0.0.0時） | 固定エラーメッセージ使用（6.5節） |

---

## 15. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（2026-02-08）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 対応箇所 |
|----|--------|---------|---------|---------|---------|
| DR1-003 | must_fix | OCP | status-detector.ts 15行ウィンドウとprompt-detector.ts 50行ウィンドウの不整合 | 反映済 | 5.5節、5.3節、7.2節 |
| DR1-001 | should_fix | OCP | Layer 4 hasDefaultIndicator のCodex対応 | 反映済 | 3.1節、3.2節、5.2節 |
| DR1-002 | should_fix | DRY | response-poller.ts の2箇所の重複detectPrompt呼び出し | 反映済 | 5.4節 |
| DR1-005 | should_fix | SRP | DetectPromptOptions の配置と依存方向 | 反映済 | 3.1節 |
| DR1-007 | should_fix | DRY | 5+呼び出し元の3行パターン重複 | 反映済 | 2.2節、3.3節、5.3節、11.1節 |
| DR1-010 | should_fix | OCP | current-output/route.ts の cliToolId 取得方法 | 反映済 | 5.3節、12.4節 |
| DR1-004 | nice_to_have | ISP | TUIベースへのインターフェース拡張時のISP注意 | 反映済 | 3.1節 |
| DR1-006 | nice_to_have | KISS | Claude用パターンの明示的返却 | 反映済 | 3.2節 |
| DR1-008 | nice_to_have | YAGNI | TUI代替設計セクションの簡素化 | 反映済 | 4.2節 |
| DR1-009 | nice_to_have | DIP | デフォルトパターンのClaude結合の意図的許容 | 反映済 | 11.1節 |

### Stage 2: 整合性レビュー（2026-02-08）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 対応箇所 |
|----|--------|---------|---------|---------|---------|
| DR2-001 | must_fix | 整合性 | response-poller.ts: `this.cliToolId`は誤り -- モジュール関数ベース構造で`cliToolId`は関数パラメータ | 反映済 | 5.3節、5.4節、12.1節、16節 |
| DR2-002 | must_fix | 整合性 | response-poller.ts L248: Claude専用ガード内の将来的Codex対応の注記 | 反映済 | 12.2節 |
| DR2-003 | must_fix | 整合性 | response-poller.ts: L442の変数名は`fullOutput`、L556は`result.response`（設計書の`lastOutput`は不正確） | 反映済 | 5.3節、5.4節、12.1節、16節 |
| DR2-004 | must_fix | 整合性 | auto-yes-manager.ts: L290/L262の行番号参照は実コードと一致 | 確認済（修正不要） | 5.3節 |
| DR2-005 | must_fix | 整合性 | status-detector.ts: L87/L77の行番号参照は実コードと一致 | 確認済（修正不要） | 5.3節、5.5節 |
| DR2-008 | must_fix | 整合性 | claude-poller.ts: L164/L232の行番号参照は実コードと一致、変更不要判断も妥当 | 確認済（修正不要） | 12.2節 |
| DR2-012 | must_fix | 整合性 | テストファイルのモック行番号が不正確（auto-yes-manager.test.tsのL431） | 反映済 | 8.2節 |
| DR2-016 | must_fix | 整合性 | Phase 3チェックリストの変数名不一致（`this.cliToolId`、`lastOutput`） | 反映済 | 16節 |
| DR2-006 | should_fix | 整合性 | prompt-response/route.ts: L75/L50の行番号参照は実コードと一致 | 確認済（修正不要） | 5.3節 |
| DR2-007 | should_fix | 整合性 | current-output/route.ts: L88のthinking条件分岐との統合方法を明記 | 反映済 | 5.3節、16節 |
| DR2-009 | should_fix | 整合性 | detectMultipleChoicePromptはmodule-private関数（exportされていない）であることを注記 | 反映済 | 5.2節 |
| DR2-010 | should_fix | 整合性 | auto-yes-resolver.ts: isDefaultフラグのフォールバック動作は設計意図と一致 | 確認済（修正不要） | 9.1節 |
| DR2-011 | should_fix | 整合性 | Codex選択肢では`isDefault: false`を明示的に設定すべき（undefined vs false） | 反映済 | 9.1節 |
| DR2-013 | should_fix | 整合性 | yes/noパターン検出は10行、multiple_choice検出は50行の内部ウィンドウイング詳細を追記 | 反映済 | 5.5節、7.2節 |
| DR2-015 | should_fix | 整合性 | cli-patterns.ts -> prompt-detector.tsの新規依存方向の循環依存チェックを実装チェックリストに追加 | 反映済 | 16節 |
| DR2-017 | should_fix | 整合性 | current-output/route.ts: thinking条件分岐込みの修正後コード例を記載 | 反映済 | 5.3節、16節 |
| DR2-020 | should_fix | 整合性 | Layer 4コード例: `options.length < 2`と`hasDefaultIndicator`を分離 | 反映済 | 5.2節 |
| DR2-014 | nice_to_have | 整合性 | codex.ts L91-96のTUI操作パターン参照は正確 | 確認済（修正不要） | 4.2節 |
| DR2-018 | nice_to_have | 整合性 | detectPromptのBeforeシグネチャ表記は実コードと一致 | 確認済（修正不要） | 5.2節 |
| DR2-019 | nice_to_have | 整合性 | DEFAULT_OPTION_PATTERN/NORMAL_OPTION_PATTERNの設計書記載は実コードと一致 | 確認済（修正不要） | 5.2節 |

### Stage 3: 影響分析レビュー（2026-02-08）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 対応箇所 |
|----|--------|---------|---------|---------|---------|
| DR3-001 | must_fix | 影響範囲漏れ | worktrees/route.tsとworktrees/[id]/route.tsが間接的影響を受けるが設計書に記載なし | 反映済 | 12.3節 |
| DR3-002 | must_fix | テスト影響範囲漏れ | status-detector.test.tsが設計書の更新対象テストに未記載 | 反映済 | 8.2節、12.1節、16節（Phase 4） |
| DR3-003 | must_fix | 影響範囲漏れ | response-poller.ts L248のClaude専用ガード内でdetectPromptにstripAnsi適用済み vs L442のstripAnsi未適用の差異が未記載 | 反映済 | 12.2節 |
| DR3-004 | should_fix | 影響範囲検証 | status-detector.tsのウィンドウイング変更がPromise.all並列処理時のパフォーマンスに影響する可能性 | 反映済 | 7.2節 |
| DR3-005 | should_fix | テスト影響範囲 | api-prompt-handling.test.tsの回帰テスト実行がPhase 5に未記載 | 反映済 | 16節（Phase 5） |
| DR3-006 | should_fix | 影響範囲検証 | useAutoYes.tsはcurrent-output APIを直接呼び出していない（設計書12.4節の記載が不正確） | 反映済 | 12.4節 |
| DR3-007 | should_fix | 影響範囲検証 | cli-patterns.tsのテストファイルが2つ存在し、新規テストの配置先が不明確 | 反映済 | 8.1節 |
| DR3-008 | should_fix | 影響範囲検証 | Phase 2チェックリストにPromptDetectionResultのexport確認項目がない | 反映済 | 16節（Phase 2） |
| DR3-009 | nice_to_have | 波及効果分析 | claude-poller.tsのdetectPrompt呼び出しは到達不能コードだが将来のメンテナンスリスク | 反映済 | 12.2節 |
| DR3-010 | nice_to_have | 波及効果分析 | respond/route.ts -> startPolling() -> detectPrompt()の呼び出しチェーンを12.3節に記載すべき | 反映済 | 12.3節、16節（Phase 5） |
| DR3-011 | nice_to_have | 影響範囲検証 | auto-yes-manager.test.tsのpollAutoYesテストがdetectPromptForCli移行後に期待通り動作するか | 反映済 | 8.2節 |
| DR3-012 | nice_to_have | 波及効果分析 | detectSessionStatus()の内部動作変更によりE2Eテストでの動作確認が推奨 | 反映済 | 16節（Phase 5） |

### Stage 4: セキュリティレビュー（2026-02-08）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 対応箇所 |
|----|--------|---------|---------|---------|---------|
| DR4-001 | must_fix | Command Injection | prompt-response/route.tsがtmux sendKeysに未サニタイズの回答を送信 | 反映済 | 6.1節、6.3節、10.1節、12.1節、14節、16節（Phase 3） |
| DR4-002 | must_fix | ReDoS Prevention | TBDプレースホルダーのCodex正規表現パターンに自動ReDoS検証が必要 | 反映済 | 5.1節、6.2節、8.1節、16節（Phase 2, Phase 4） |
| DR4-003 | should_fix | Defense in Depth | requireDefaultIndicator=falseによるCodex Auto-Yesの防御低下 | 反映済 | 5.2節、14節 |
| DR4-004 | should_fix | Information Disclosure | getAnswerInput()およびAPI routeのエラーメッセージがユーザー入力をエコーバック | 反映済 | 6.1節、6.5節、12.1節、16節（Phase 3） |
| DR4-005 | should_fix | Input Validation | prompt-response/route.tsが回答フォーマット検証なしにtmuxへ送信 | 反映済 | 6.1節、6.4節、10.1節、12.1節、16節（Phase 3） |
| DR4-006 | should_fix | Command Injection | tmux.tsのexec() vs execFile() -- 不完全なシェルメタ文字保護 | 反映済（スコープ外フォローアップとして記録） | 6.3節 |
| DR4-007 | nice_to_have | Rate Limiting | prompt-response APIエンドポイントにレート制限がない | 反映済 | 10.1節 |
| DR4-008 | nice_to_have | Logging | Auto-Yesレスポンスログに送信した回答が含まれていない | 反映済 | 6.7節 |
| DR4-009 | nice_to_have | Defense in Depth | TEXT_INPUT_PATTERNSにアンカーがなく部分文字列マッチの可能性 | 反映済 | 6.2節 |
| DR4-010 | nice_to_have | ANSI Stripping | ANSI_PATTERN正規表現の/gフラグとlastIndex状態リスク（情報的注記） | 反映済 | 6.6節 |

---

## 16. 実装チェックリスト

### Phase 2: コア実装

- [ ] `src/lib/prompt-detector.ts`: `DetectPromptOptions`インターフェース定義（`requireDefaultIndicator`フィールド含む）[DR1-001]
- [ ] `src/lib/prompt-detector.ts`: `detectPrompt()`シグネチャ変更（optional `options`引数）
- [ ] `src/lib/prompt-detector.ts`: `detectMultipleChoicePrompt()`パターンパラメータ化（Pass 1, Pass 2）
- [ ] `src/lib/prompt-detector.ts`: Layer 4を`requireDefaultIndicator`で条件分岐 [DR1-001]
- [ ] `src/lib/prompt-detector.ts`: `getAnswerInput()`のエラーメッセージを固定メッセージに変更（`Invalid answer format for multiple choice prompt`）[DR4-004]
- [ ] `src/lib/cli-patterns.ts`: `CLAUDE_CHOICE_INDICATOR_PATTERN`, `CLAUDE_CHOICE_NORMAL_PATTERN`定義 [DR1-006]
- [ ] `src/lib/cli-patterns.ts`: `CODEX_CHOICE_INDICATOR_PATTERN`, `CODEX_CHOICE_NORMAL_PATTERN`定義（Phase 1確認結果に基づく）
- [ ] `src/lib/cli-patterns.ts`: Codexパターン確定時にReDoS安全パターン構成ルール（6.2節）を遵守すること [DR4-002]
- [ ] `src/lib/cli-patterns.ts`: **自動ReDoS検証**: Codexパターン確定後に `safe-regex` または `recheck` npmパッケージで安全性を検証する。病理的入力（1000文字以上の部分マッチ）に対して100ms以内に完了することを確認する [DR4-002]
- [ ] `src/lib/cli-patterns.ts`: `getChoiceDetectionPatterns()`関数実装（明示的パターン返却）[DR1-006]
- [ ] `src/lib/cli-patterns.ts`: `detectPromptForCli()`コンビニエンスラッパー実装 [DR1-007]
- [ ] `src/lib/prompt-detector.ts`: `PromptDetectionResult`が正しくexportされていることを確認。`detectPromptForCli()`の戻り値型として`cli-patterns.ts`でimportする [DR3-008]
- [ ] 循環依存チェック: `cli-patterns.ts` -> `prompt-detector.ts` の新規依存方向が循環を形成していないことを確認（`npx madge --circular` または手動確認）[DR2-015]

### Phase 3: 呼び出し元修正

- [ ] `src/lib/auto-yes-manager.ts`: `detectPromptForCli(cleanOutput, cliToolId)` に変更 [DR1-007]
- [ ] `src/lib/status-detector.ts`: `detectPromptForCli(cleanOutput, cliToolId)` に変更（lastLinesではなくfull cleanOutput渡し）[DR1-003, DR1-007]
- [ ] `src/lib/response-poller.ts` L442: `detectPromptForCli(stripAnsi(fullOutput), cliToolId)` に変更（`fullOutput`は`lines.join('\n')`、`cliToolId`は関数パラメータ）[DR1-002, DR1-007, DR2-001, DR2-003, DR2-016]
- [ ] `src/lib/response-poller.ts` L556: `detectPromptForCli(stripAnsi(result.response), cliToolId)` に変更 [DR1-002, DR1-007, DR2-003, DR2-016]
- [ ] `src/lib/response-poller.ts`: `stripAnsi()`の結果を変数に格納して再利用（`fullOutput`と`result.response`は異なる変数のため個別に適用）[DR1-002]
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: `detectPromptForCli()` に変更 [DR1-007]
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: **[DR4-005] 入力バリデーション追加**: (1) multiple_choiceの場合は数値のみ許可、(2) yes_noの場合はy/n/yes/noのみ許可、(3) 最大長1000文字制限、(4) 制御文字フィルタリング（6.4節参照）
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: **[DR4-004] エラーメッセージ修正**: 404レスポンスのworktreeID非エコーバック（`Worktree not found`）
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: `detectPromptForCli()` に変更（**既存のthinking条件分岐を維持**: `thinking ? { isPrompt: false, cleanContent: cleanOutput } : detectPromptForCli(cleanOutput, cliToolId)`）[DR1-007, DR2-007, DR2-017]
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: cliToolIdの取得方法を確認・検証 [DR1-010]
- [ ] `src/app/api/worktrees/[id]/respond/route.ts`: **[DR4-001] テキスト入力サニタイズ追加**: カスタムテキスト入力（answer が数値でない場合）に最大長制限（1000文字）と制御文字フィルタリングを適用
- [ ] `src/app/api/worktrees/[id]/respond/route.ts`: **[DR4-004] エラーメッセージ修正**: `getAnswerInput()`のエラーメッセージをクライアントにエコーバックしない（固定メッセージ `Invalid answer format` を使用）
- [ ] クライアント側: `useAutoYes.ts`が`cliTool`クエリパラメータを付与していることを検証 [DR1-010]
- [ ] クライアント側: `WorktreeDetailRefactored.tsx`が`cliTool`クエリパラメータを付与していることを検証 [DR1-010]

### Phase 4: テスト

- [ ] `tests/unit/prompt-detector.test.ts`: Codex選択肢検出テスト追加
- [ ] `tests/unit/prompt-detector.test.ts`: `requireDefaultIndicator=false`時のLayer 4スキップテスト [DR1-001]
- [ ] `tests/unit/prompt-detector.test.ts`: `requireDefaultIndicator=true`（デフォルト）時のLayer 4適用テスト [DR1-001]
- [ ] `tests/unit/prompt-detector.test.ts`: options省略時の後方互換性テスト
- [ ] `tests/unit/lib/cli-patterns.test.ts`: `getChoiceDetectionPatterns()`の各CLIツール返却値テスト [DR1-006]
- [ ] `tests/unit/lib/cli-patterns.test.ts`: `detectPromptForCli()`基本動作テスト [DR1-007]
- [ ] `tests/unit/lib/cli-patterns.test.ts`: Codexパターンのアンカー検証・ReDoS安全性テスト
- [ ] `tests/unit/lib/cli-patterns.test.ts`: **[DR4-002] ReDoS病理的入力テスト**: 1000文字以上の入力に対する処理時間が100ms以内であることを検証
- [ ] `tests/unit/lib/auto-yes-manager.test.ts`: モック更新
- [ ] `tests/unit/api/prompt-response-verification.test.ts`: モック更新
- [ ] `tests/unit/api/prompt-response-verification.test.ts`: **[DR4-005] 入力バリデーションテスト追加**: 不正フォーマット（非数値のmultiple_choice回答、不正なyes_no回答）の拒否を検証
- [ ] `src/lib/__tests__/status-detector.test.ts`: 15行ウィンドウ境界テスト（L374-385）の期待値確認 [DR3-002]
- [ ] `src/lib/__tests__/status-detector.test.ts`: multiple choice prompt検出テスト（L92-104）のfull cleanOutput渡し動作確認 [DR3-002]
- [ ] `src/lib/__tests__/status-detector.test.ts`: Issue #180 past promptsテスト（L203-351）のwindowing変更後の動作確認 [DR3-002]

### Phase 5: 動作検証

- [ ] Codex CLI: 複数選択肢のUI手動応答が動作すること
- [ ] Codex CLI: Auto-Yes自動応答が動作すること
- [ ] **[DR4-003]** Codex CLI: Auto-Yes有効時に、通常出力の番号付きリストが誤検出されないことを確認（Layer 1 thinking check + Layer 3連番検証の動作確認）
- [ ] Claude CLI: 全既存機能の回帰テストパス
- [ ] `auto-yes-resolver.ts`: `isDefault`フラグの動作確認（`requireDefaultIndicator=false`時）[DR1-001]
- [ ] `tests/integration/api-prompt-handling.test.ts`: 回帰テストとして実行し、Codex multiple_choiceの`getAnswerInput()`動作を確認する [DR3-005]
- [ ] `src/lib/__tests__/cli-patterns.test.ts`: 回帰テストとして実行し、既存テストがパスすることを確認する [DR3-007]
- [ ] `src/app/api/worktrees/[id]/respond/route.ts` -> `startPolling()` -> `checkForResponse()` -> `extractResponse()` -> `detectPrompt()`の呼び出しチェーンについて、Codexセッションでmultiple_choice prompt応答後のポーリング再開が正しく動作することを確認する [DR3-010]
- [ ] **[DR3-012] E2E推奨**: E2Eテスト（Playwright）でサイドバーのステータスインジケータ（idle/ready/running/waiting）の動作を確認。特にmultiple_choiceプロンプト表示時のwaitingステータスが正しく反映されることを検証。
- [ ] **[DR4-001] セキュリティ検証**: prompt-response APIに制御文字を含む入力を送信し、フィルタリングされることを確認
- [ ] **[DR4-005] セキュリティ検証**: prompt-response APIに不正フォーマットの回答（multiple_choice時に非数値）を送信し、400エラーが返されることを確認
- [ ] **[DR4-004] セキュリティ検証**: 各API routeのエラーレスポンスにユーザー入力値がエコーバックされていないことを確認

---

## 17. レビュー履歴

| 日付 | ステージ | レビュー種別 | 結果 | 指摘数 |
|------|---------|------------|------|--------|
| 2026-02-08 | Stage 1 | 通常レビュー（設計原則） | must_fix: 1, should_fix: 5, nice_to_have: 4 | 10件 |
| 2026-02-08 | Stage 2 | 整合性レビュー（ソースコードとの整合性検証） | must_fix: 8, should_fix: 9, nice_to_have: 3 | 20件 |
| 2026-02-08 | Stage 3 | 影響分析レビュー（影響範囲の網羅性検証） | must_fix: 3, should_fix: 5, nice_to_have: 4 | 12件 |
| 2026-02-08 | Stage 4 | セキュリティレビュー（OWASP Top 10準拠） | must_fix: 2, should_fix: 4, nice_to_have: 4 | 10件 |

---

### セキュリティレビューサマリー（Stage 4）

**全体評価**: acceptable_with_recommendations（推奨事項付き承認）

**リスク評価**: 低（ローカルデプロイモデルにより攻撃面が限定的）

**OWASP Top 10 準拠状況**:

| カテゴリ | 状態 | 備考 |
|---------|------|------|
| A01: Broken Access Control | N/A | ローカルアプリケーション、認証レイヤーなし |
| A02: Cryptographic Failures | N/A | スコープ内に暗号操作なし |
| A03: Injection | 部分対応 | sendKeysは基本的なエスケープ付き。execFile移行はスコープ外フォローアップ [DR4-006]。入力バリデーション追加 [DR4-001, DR4-005] |
| A04: Insecure Design | Pass | パターンパラメータ化が関心の分離を維持 |
| A05: Security Misconfiguration | Pass | スコープ内に設定変更なし |
| A06: Vulnerable Components | N/A | 新規依存パッケージの追加なし |
| A07: Identification & Authentication | N/A | ローカルアプリケーション |
| A08: Software & Data Integrity | Pass | デシリアライゼーションやインテグリティの懸念なし |
| A09: Logging & Monitoring | 部分対応 | Auto-Yesログに回答詳細の追加を推奨 [DR4-008] |
| A10: SSRF | N/A | スコープ内に外部リクエストなし |

**残余リスク**:
1. `CM_BIND=0.0.0.0`設定時、未検証のprompt-response入力がネットワーク経由で悪用される可能性 -> 入力バリデーション追加で緩和 [DR4-001, DR4-005]
2. Codex Auto-Yesで連番番号付きリストが非thinking状態で出力された場合の誤検出 -> Phase 1実機検証で判定 [DR4-003]
3. TBDのCodex正規表現パターンがReDoSを導入する可能性 -> 自動検証ツール必須 [DR4-002]

---

### 6.7 [DR4-008] Auto-Yesレスポンスログの改善推奨

`auto-yes-manager.ts`（L323）のAuto-Yes成功ログは現在worktreeIdのみを出力し、送信した回答内容を含まない。セキュリティ監査の観点から、回答の種類（yes_no/multiple_choice）と回答値（y, n, 1等）をログに含めることを推奨する。回答値は短い文字列であり機密情報ではない。

**推奨ログ形式**:
```
[Auto-Yes Poller] Sent response '${answer}' (type: ${promptData.type}) for worktree: ${worktreeId}
```

**優先度**: nice_to_have（本Issue実装時に併せて対応可能だが必須ではない）

---

*Generated by design-policy command for Issue #193*
*Date: 2026-02-08*
*Updated: 2026-02-08 (Stage 4 security review findings applied)*
