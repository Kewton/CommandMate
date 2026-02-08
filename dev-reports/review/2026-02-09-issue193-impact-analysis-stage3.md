# Issue #193 影響範囲分析レビュー (Stage 3)

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue | #193 Claude Code複数選択肢プロンプト検出 |
| レビューステージ | Stage 3: 影響分析レビュー |
| レビュー日 | 2026-02-09 |
| レビュー対象 | 設計方針書 + 実装対象ファイル群 |
| 総合評価 | 条件付き承認 (conditionally_approved) |
| スコア | 4/5 |

---

## Executive Summary

Issue #193の設計変更は、`detectPrompt()`のoptionalパラメータ追加を中心とした後方互換性を維持する変更であり、影響範囲は適切に制御されている。直接変更対象は7ファイル(P0+P1)、間接影響を受けるモジュールは7ファイルで、全てコード変更不要である。新たなモジュール依存(`cli-patterns.ts -> prompt-detector.ts`のtype-only import)は1つのみで、循環依存は発生しない。

主要なリスクとして、`response-poller.ts` L442/L556のANSI未ストリップ修正におけるstripAnsi適用方針の明確化が必要(IA-001)。その他の影響は限定的であり、既存テストの破壊も発生しない。

---

## 1. detectPrompt()のoptionalパラメータ追加による後方互換性への影響

### 分析結果: 影響なし (後方互換性完全維持)

**現在のシグネチャ**:
```typescript
// src/lib/prompt-detector.ts L44
export function detectPrompt(output: string): PromptDetectionResult
```

**変更後のシグネチャ**:
```typescript
export function detectPrompt(output: string, options?: DetectPromptOptions): PromptDetectionResult
```

**影響範囲の詳細**:

TypeScriptのoptionalパラメータ追加は後方互換の変更である。既存の全ての`detectPrompt(output)`呼び出しは、`options`が`undefined`として解釈され、内部で`options?.requireDefaultIndicator ?? true`により既存動作(`true`)が維持される。

| 呼び出し元 | 現在の呼び出し | 変更後 | 後方互換 |
|-----------|--------------|--------|---------|
| prompt-response/route.ts L75 | `detectPrompt(cleanOutput)` | `detectPrompt(cleanOutput, promptOptions)` | 互換 |
| auto-yes-manager.ts L290 | `detectPrompt(cleanOutput)` | `detectPrompt(cleanOutput, promptOptions)` | 互換 |
| status-detector.ts L87 | `detectPrompt(lastLines)` | `detectPrompt(lastLines, promptOptions)` | 互換 |
| response-poller.ts L248 | `detectPrompt(cleanFullOutput)` | `detectPromptWithOptions(cleanFullOutput, cliToolId)` | 互換 |
| response-poller.ts L442 | `detectPrompt(fullOutput)` | `detectPromptWithOptions(fullOutput, cliToolId)` | 互換 |
| response-poller.ts L556 | `detectPrompt(result.response)` | `detectPromptWithOptions(result.response, cliToolId)` | 互換 |
| current-output/route.ts L88 | `detectPrompt(cleanOutput)` | `detectPrompt(cleanOutput, promptOptions)` | 互換 |
| claude-poller.ts L164 | `detectPrompt(fullOutput)` | P2: TODOコメント | 到達不能 |
| claude-poller.ts L232 | `detectPrompt(result.response)` | P2: TODOコメント | 到達不能 |

**結論**: `detectMultipleChoicePrompt()`は非export関数(ファイル内部)であるため、外部からの呼び出しは存在せず、シグネチャ変更の影響は`detectPrompt()`経由のみ。`?? true`パターンによりデフォルト動作が完全に保持される。

---

## 2. buildDetectPromptOptions()をcli-patterns.tsに配置することによるモジュール依存関係の変化

### 分析結果: 新規依存1つ追加、循環依存なし

**変更前のモジュール依存グラフ**:

```
cli-patterns.ts -----> cli-tools/types.ts (CLIToolType)
                       logger.ts

status-detector.ts --> cli-patterns.ts (stripAnsi, detectThinking, getCliToolPatterns)
                   --> prompt-detector.ts (detectPrompt)
                   --> cli-tools/types.ts (CLIToolType)

prompt-detector.ts --> types/models.ts (PromptData)
                   --> logger.ts
```

**変更後のモジュール依存グラフ**:

```
cli-patterns.ts -----> cli-tools/types.ts (CLIToolType)
                   --> prompt-detector.ts (DetectPromptOptions) [NEW: type-only import]
                       logger.ts

status-detector.ts --> cli-patterns.ts (stripAnsi, detectThinking, getCliToolPatterns, buildDetectPromptOptions) [ADDED]
                   --> prompt-detector.ts (detectPrompt)
                   --> cli-tools/types.ts (CLIToolType)

prompt-detector.ts --> types/models.ts (PromptData)
                   --> logger.ts
```

**新規依存の分析**:

| 依存元 | 依存先 | Import内容 | 種別 | リスク |
|--------|--------|-----------|------|-------|
| cli-patterns.ts | prompt-detector.ts | `DetectPromptOptions` | type-only import | なし |

- `cli-patterns.ts` -> `prompt-detector.ts` は新しい依存方向だが、`prompt-detector.ts` は `cli-patterns.ts` をimportしていないため、循環依存は発生しない。
- `import type` を使用するため、ランタイムの依存関係には影響しない(TypeScriptコンパイル時のみ)。
- `cli-patterns.ts`は既にCLIツール別のパターン定義を担当しており、`buildDetectPromptOptions()`の配置先として自然な位置にある。

**結論**: モジュール依存関係の変化は最小限であり、設計として適切。

---

## 3. response-poller.ts内部ヘルパー(detectPromptWithOptions)追加による内部構造の影響

### 分析結果: 内部変更のみ、外部APIに影響なし

`response-poller.ts`内の`detectPrompt()`呼び出しは3箇所:

| 箇所 | 行 | コンテキスト | 現在のstripAnsi状態 | 変更後 |
|------|-----|-------------|-------------------|--------|
| 箇所1 | L248 | Claude専用ガード内 (`if (cliToolId === 'claude')`) | L247で`stripAnsi(fullOutput)`済み | ヘルパー経由 |
| 箇所2 | L442 | 全CLIツール共通パス | **未適用** (ANSI残存) | ヘルパー経由 + stripAnsi追加 |
| 箇所3 | L556 | 全CLIツール共通パス (result.response) | **未適用** (ANSI残存の可能性) | ヘルパー経由 + stripAnsi追加 |

**ヘルパー関数の設計**:

```typescript
function detectPromptWithOptions(
  output: string,
  cliToolId: CLIToolType
): PromptDetectionResult {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  return detectPrompt(output, promptOptions);
}
```

**IA-001 (Must Fix)**: stripAnsiの適用方針が設計書内で分散している。

- セクション4.5: 「`detectPromptWithOptions()`ヘルパー内で`stripAnsi()`を適用するか、L556呼び出し前に適用する必要がある」
- セクション6.3: 「`detectPromptWithOptions()`ヘルパー内、または呼び出し前に`stripAnsi(result.response)`を適用する」

ヘルパー内で一律適用する方式を推奨する。理由:
1. 変更漏れリスクの最小化(3箇所全てで統一的に適用)
2. L248では既にstripAnsi済みだが、stripAnsiは冪等(二重適用しても結果は同じ)なため問題なし
3. ヘルパーの責務として「ANSI-safe + options-aware なdetectPrompt呼び出し」を明確化

**箇所1 (L248) の追加分析**: L248はClaude専用ガード(`if (cliToolId === 'claude')`)内にある。ヘルパーは`cliToolId`を汎用的に受け取るため、将来ガード外に移動しても正しく動作する。設計書のIC-002対応で記載済み。

**箇所3 (L556) のデータフロー詳細分析**:

```
extractResponse() L308-331:
  for (let i = startIndex; i < totalLines; i++) {
    const line = lines[i];              // 生のline
    const cleanLine = stripAnsi(line);  // パターンマッチ用にstripAnsi
    // ...
    responseLines.push(line);           // 生のlineをpush (ANSIコード残存)
  }
  return { response: responseLines.join('\n').trim(), ... };
```

`result.response`には`stripAnsi`未適用の行が混在している。これは`extractResponse()`の意図的な設計(表示用にANSIを保持)だが、`detectPrompt()`に渡す際にはstripAnsiが必要。ヘルパー内でのstripAnsi適用は必須。

**結論**: ヘルパー追加は変更漏れリスクを低減する適切な設計。stripAnsi適用方針の明確化が必要(IA-001)。

---

## 4. status-detector.tsでbuildDetectPromptOptions()をimportすることによる依存関係の変化

### 分析結果: 依存方向に変化なし、import行追加のみ

**現在の`status-detector.ts`のimport**:
```typescript
// L12-14
import { stripAnsi, detectThinking, getCliToolPatterns } from './cli-patterns';
import { detectPrompt } from './prompt-detector';
import type { CLIToolType } from './cli-tools/types';
```

**変更後のimport**:
```typescript
import { stripAnsi, detectThinking, getCliToolPatterns, buildDetectPromptOptions } from './cli-patterns';
import { detectPrompt } from './prompt-detector';
import type { CLIToolType } from './cli-tools/types';
```

- `cli-patterns.ts`への既存依存にシンボルが1つ追加されるのみ。新たなモジュール依存方向は発生しない。
- `detectSessionStatus()`の第2引数`cliToolId`(L77)から`buildDetectPromptOptions(cliToolId)`を呼び出すため、新たな引数の追加も不要。

**cliToolId伝搬パスの確認**:

```
worktrees/route.ts:
  L58: const statusResult = detectSessionStatus(output, cliToolId);
       ↓
status-detector.ts:
  L76: export function detectSessionStatus(output, cliToolId, lastOutputTimestamp?)
  L87: const promptDetection = detectPrompt(lastLines);
       ↓ (変更後)
  L87: const promptOptions = buildDetectPromptOptions(cliToolId);
       const promptDetection = detectPrompt(lastLines, promptOptions);
```

`cliToolId`は呼び出し元から既に渡されており、追加の引数変更は不要。設計書のIC-003対応として正しく記載されている。

**SF-002対応の確認**: `status-detector.ts`自身にoptions構築ロジック(例: `cliToolId === 'claude' ? ... : ...`)を埋め込まず、`buildDetectPromptOptions()`を呼び出すのみとする方針は、SRP遵守として適切。

**結論**: 既存の依存方向に沿ったシンボル追加のみであり、影響は最小限。

---

## 5. ANSI未ストリップ修正(stripAnsi追加)による既存動作への影響

### 分析結果: 正の影響 (バグ修正)

**現状のANSI適用状況**:

| ファイル | 行 | 現在のstripAnsi | 変更後 |
|---------|-----|---------------|--------|
| status-detector.ts | L81 | 適用済み | 変更なし |
| auto-yes-manager.ts | L279 | 適用済み | 変更なし |
| prompt-response/route.ts | L74 | 適用済み | 変更なし |
| response-poller.ts | L247 (箇所1) | 適用済み | 変更なし |
| response-poller.ts | L442 (箇所2) | **未適用** | stripAnsi追加 |
| response-poller.ts | L556 (箇所3) | **未適用** | stripAnsi追加 |
| claude-poller.ts | L164 | **未適用** | P2: オプション |
| claude-poller.ts | L232 | **未適用** | P2: オプション |

**L442の影響分析**:

```typescript
// L441-442 (現在)
const fullOutput = lines.join('\n');
const promptDetection = detectPrompt(fullOutput);
```

`fullOutput`にANSIエスケープシーケンスが残存したまま`detectPrompt()`に渡されるため、正規表現パターンマッチが正確に動作しない可能性がある。例えば、`\x1b[32m(y/n)\x1b[0m`はyes/noパターン`/^(.+)\s+\(y\/n\)\s*$/m`にマッチしない。stripAnsi追加はこのバグを修正する正の変更。

**L556の影響分析**:

前述の通り、`extractResponse()`の`responseLines.push(line)`が生の行をpushするため、`result.response`にはANSIコードが残存する可能性がある。stripAnsi追加は正の変更。

**既存動作への影響**:

stripAnsi追加により、これまでANSIコードの影響でプロンプト検出に失敗していたケースが正しく検出されるようになる。これは機能改善であり、リグレッションではない。ただし、以下の極めて低確率なリスクが存在する:

- ANSIコード残存時にたまたまパターンマッチが成功していたケースが、stripAnsi後にマッチしなくなる可能性。実用上このケースは存在しない(ANSIコードがパターンマッチを助けるケースは理論的にあり得ない)。

**結論**: stripAnsi追加は既存のバグ修正であり、リグレッションリスクはなし。

---

## 6. 既存テストへの影響（モック更新の必要性）

### 分析結果: 既存テストの破壊なし、一部追加推奨

| テストファイル | モック/直接使用 | 影響 | 更新必要性 |
|-------------|--------------|------|----------|
| `tests/unit/prompt-detector.test.ts` | 直接使用 (`detectPrompt(output)`) | なし (optionalパラメータは省略可能) | 新テスト追加のみ |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 直接使用 (`resolveAutoAnswer(promptData)`) | なし (detectPromptを使用しない) | isDefault=falseテスト確認 |
| `src/lib/__tests__/status-detector.test.ts` | 直接使用 (`detectSessionStatus(output, cliToolId)`) | なし (内部実装変更のみ) | 新テスト追加推奨 |
| `tests/unit/api/prompt-response-verification.test.ts` | モック (`vi.mock`) | 要確認 | 引数検証箇所を確認 |
| `tests/unit/lib/auto-yes-manager.test.ts` | dynamic import | なし | 動作確認 |

**prompt-detector.test.ts詳細分析**:

全84テストケースは`detectPrompt(output)`を引数1つで呼び出している。optionalパラメータ追加後も全テストがそのまま通過する。新たに追加が必要なテスト:

1. `requireDefaultIndicator: false`での❯なし形式検出テスト
2. `requireDefaultIndicator: true`(デフォルト)でのリグレッションテスト
3. `requireDefaultIndicator: false`で連番検証(Layer 3)が維持されることのテスト
4. `requireDefaultIndicator: false`で`options.length < 2`がブロックされることのテスト

**prompt-response-verification.test.ts詳細分析**:

```typescript
// L49-51
vi.mock('@/lib/prompt-detector', () => ({
  detectPrompt: vi.fn().mockReturnValue({ isPrompt: false, cleanContent: '' }),
}));
```

このモックは`detectPrompt`の呼び出し引数を無視して固定値を返す。新シグネチャ(`output, options?`)でも問題なく動作する。テスト内で`expect(detectPrompt).toHaveBeenCalledWith(cleanOutput)`のような引数検証がある場合のみ、`expect(detectPrompt).toHaveBeenCalledWith(cleanOutput, expectedOptions)`への更新が必要。テストファイルを確認したところ、引数の完全一致検証は行われていないため、モック更新は不要。

ただし、変更後にprompt-response/route.tsが`buildDetectPromptOptions()`をimportするため、テスト内で`cli-patterns.ts`のモックが必要になる可能性がある。現在のテスト(L53-56)では`cli-patterns`を既にモックしているが、`buildDetectPromptOptions`は含まれていない。

```typescript
// L53-56 (現在)
vi.mock('@/lib/cli-patterns', () => ({
  stripAnsi: vi.fn((s: string) => s),
}));
```

変更後は以下が必要:
```typescript
vi.mock('@/lib/cli-patterns', () => ({
  stripAnsi: vi.fn((s: string) => s),
  buildDetectPromptOptions: vi.fn().mockReturnValue(undefined),
}));
```

**IA-004 (Should Fix)**: `prompt-response-verification.test.ts`のcli-patternsモックに`buildDetectPromptOptions`を追加する必要がある。

**status-detector.test.ts詳細分析**:

18テストケースは全て`detectSessionStatus(output, cliToolId)`を直接呼び出す。内部で`detectPrompt(lastLines)`が呼び出されるが、変更後は`detectPrompt(lastLines, buildDetectPromptOptions(cliToolId))`となる。テスト入力のうち、multiple_choiceプロンプトを含むものは:

- L92-104: `❯ 1. Option A` / `2. Option B` / `3. Option C` (❯マーカーあり)
- L250-264: `❯ 1. Option A` / `2. Option B` / `3. Option C` (❯マーカーあり)

これらのテスト入力は全て❯マーカーを含むため、`requireDefaultIndicator=false`でもPass 1の❯スキャンで同じ結果が得られる。既存テストへの影響はない。

**結論**: 既存テストは破壊されない。`prompt-response-verification.test.ts`のcli-patternsモックにbuildDetectPromptOptionsの追加が必要(IA-004)。

---

## 7. UIコンポーネント（PromptPanel, MobilePromptSheet）への間接影響

### 分析結果: 影響なし

**データフロー**:

```
detectPrompt() -> PromptDetectionResult -> API Response -> React Component
                  { isPrompt, promptData, cleanContent }
```

`PromptDetectionResult`のインターフェースは変更されない。`promptData`内の`options[].isDefault`が`false`になるケースが増えるが:

- `PromptPanel.tsx`: optionsの`number`と`label`を表示。`isDefault`フィールドはUI表示に使用されていない。
- `MobilePromptSheet.tsx`: 同様にoptionsの`number`と`label`を表示。
- `WorktreeDetailRefactored.tsx`: `isPromptWaiting`と`promptData`をprops経由で子コンポーネントに渡すのみ。

`isDefault`の変化がUIに影響を与える唯一のパスは、将来的にデフォルト選択肢をハイライト表示する場合であるが、現時点でそのような実装はない。

**結論**: UIコンポーネントへの影響はなし。コード変更不要。

---

## 8. Codex/Gemini CLIツールへの影響がないことの確認

### 分析結果: 影響なし (完全に確認済み)

**buildDetectPromptOptions()の動作確認**:

```typescript
export function buildDetectPromptOptions(
  cliToolId: CLIToolType
): DetectPromptOptions | undefined {
  if (cliToolId === 'claude') {
    return { requireDefaultIndicator: false };
  }
  return undefined; // Codex, Gemini はここに到達
}
```

| cliToolId | 戻り値 | detectPrompt()の動作 |
|-----------|--------|-------------------|
| `'claude'` | `{ requireDefaultIndicator: false }` | Pass 1スキップ、Layer 4の❯チェックスキップ |
| `'codex'` | `undefined` | `options?.requireDefaultIndicator ?? true` = `true` (既存動作) |
| `'gemini'` | `undefined` | `options?.requireDefaultIndicator ?? true` = `true` (既存動作) |

**response-poller.tsでの全CLIツールパス確認**:

- L248: `if (cliToolId === 'claude')` ガード内のため、Codex/Geminiは到達しない。
- L442: 全CLIツール共通パス。`detectPromptWithOptions(fullOutput, cliToolId)` でcliToolIdが正しく渡され、Codex/Geminiの場合はundefinedが返る。
- L556: 全CLIツール共通パス。同上。

**status-detector.tsでの全CLIツールパス確認**:

`detectSessionStatus(output, cliToolId)`は全CLIツールで共通のインターフェース。`buildDetectPromptOptions(cliToolId)`はCodex/Geminiでundefinedを返し、既存動作が維持される。

**既存テスト確認**:

`status-detector.test.ts`にCodexテスト(L162-186)、Geminiテスト(L188-199)が存在し、これらは変更の影響を受けない。

**結論**: Codex/Gemini CLIツールへの影響は完全にゼロ。`buildDetectPromptOptions()`のデフォルト戻り値`undefined`と`?? true`パターンにより、既存動作が保証される。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | stripAnsi適用方針の分散による実装時混乱 | Low | Medium | P1 (IA-001) |
| 技術的リスク | テストモック更新漏れ | Low | Low | P2 (IA-004) |
| セキュリティ | ANSI未ストリップは修正される方向のため、リスク低減 | Low | N/A | N/A |
| 運用リスク | 後方互換性維持のため、デプロイリスクなし | Low | N/A | N/A |

---

## 影響範囲マトリクス (総括)

### 直接変更 (P0+P1: 7ファイル)

| ファイル | 変更種別 | リスク | 後方互換 |
|---------|---------|-------|---------|
| `src/lib/prompt-detector.ts` | Interface追加 + シグネチャ変更 + 条件分岐 | Low | Yes |
| `src/lib/cli-patterns.ts` | 関数追加 + type-only import追加 | Low | Yes |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | import追加 + 引数追加 | Low | Yes |
| `src/lib/auto-yes-manager.ts` | import追加 + 引数追加 | Low | Yes |
| `src/lib/status-detector.ts` | import追加 + 引数追加 | Low | Yes |
| `src/lib/response-poller.ts` | ヘルパー追加 + stripAnsi追加 | Medium | Yes |
| `src/app/api/worktrees/[id]/current-output/route.ts` | import追加 + 引数追加 | Low | Yes |

### 間接影響 (コード変更不要: 7ファイル)

| ファイル | 影響経路 | リスク |
|---------|---------|-------|
| `src/app/api/worktrees/route.ts` | detectSessionStatus()経由 | None |
| `src/app/api/worktrees/[id]/route.ts` | detectSessionStatus()経由 | None |
| `src/lib/auto-yes-resolver.ts` | isDefault=falseフォールバック | None |
| `src/hooks/useAutoYes.ts` | API経由のpromptData | None |
| `src/components/worktree/PromptPanel.tsx` | props経由のpromptData | None |
| `src/components/mobile/MobilePromptSheet.tsx` | props経由のpromptData | None |
| `src/lib/claude-poller.ts` | 到達不能コード | None |

### テスト影響 (5ファイル)

| ファイル | 更新必要性 |
|---------|----------|
| `tests/unit/prompt-detector.test.ts` | 新テスト追加のみ |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 確認のみ (既存テストでカバー) |
| `src/lib/__tests__/status-detector.test.ts` | 新テスト追加推奨 |
| `tests/unit/api/prompt-response-verification.test.ts` | モック更新必要 (IA-004) |
| `tests/unit/lib/auto-yes-manager.test.ts` | 確認のみ |

---

## 改善勧告

### 必須改善項目 (Must Fix)

| ID | タイトル | 対応方針 |
|----|---------|---------|
| IA-001 | stripAnsi適用方針の一元化 | detectPromptWithOptions()ヘルパー内で一律stripAnsiを適用する方針を明記。二重適用の冪等性をコメントで記載。 |

### 推奨改善項目 (Should Fix)

| ID | タイトル | 対応方針 |
|----|---------|---------|
| IA-002 | モジュール依存方向の明示 | cli-patterns.ts -> prompt-detector.ts のtype-only importが循環依存を生じないことを設計書に明記 |
| IA-003 | status-detector.test.tsのClaude用❯なしテスト追加 | requireDefaultIndicator=false時の検出動作をstatus-detector.test.tsでも検証 |
| IA-004 | prompt-response-verification.test.tsのモック更新 | cli-patternsモックにbuildDetectPromptOptionsを追加 |

### 検討事項 (Consider)

| ID | タイトル | 備考 |
|----|---------|------|
| IA-005 | UIコンポーネントへの影響なし確認 | isDefaultのUI非参照を確認済み |
| IA-006 | Codex/Gemini影響なし確認 | undefinedフォールバックで完全維持 |
| IA-007 | claude-poller.ts到達不能コード | P2でTODOコメント追加で十分 |
| IA-008 | useAutoYes.tsクライアントフック | resolveAutoAnswerのフォールバック動作で対応済み |

---

## 承認ステータス

**条件付き承認 (conditionally_approved)**

IA-001 (stripAnsi適用方針の一元化) を設計書に反映した上で、実装を進めることを推奨する。IA-004 (テストモック更新) は実装フェーズで対応可能。

影響範囲は適切に制御されており、後方互換性は完全に維持される。Codex/Geminiへの影響はゼロであり、UIコンポーネントへの間接影響も発生しない。全体として、変更のリスクは低く管理可能である。
