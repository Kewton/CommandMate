# Architecture Review: Issue #287 - 選択肢プロンプト送信のフォールバック不備修正

**Review Date**: 2026-02-15
**Focus Area**: 設計原則 (Design Principles: SOLID, KISS, YAGNI, DRY)
**Stage**: 1 (通常レビュー)
**Reviewer**: Architecture Review Agent

---

## Executive Summary

Issue #287 の設計方針書は、`captureSessionOutput()` 失敗時にUI側から送信された `promptType` / `defaultOptionNumber` を使用してフォールバック判定を行うアプローチ(アプローチB)を採用している。全体として設計原則への準拠度は高く、特にYAGNI(不要な機能の排除)とOCP(非破壊的アプローチ)において優れた設計判断がなされている。

主な懸念点は、既存のDRY違反(route.ts と auto-yes-manager.ts のカーソルキー送信ロジック重複)がフォールバック導入により悪化するリスクと、route.tsのPOST関数の責務肥大化である。これらは別Issue対応として認識されているが、フォールバック導入の前提として共通ヘルパー抽出を検討すべきである。

**Status**: Conditionally Approved
**Score**: 4/5

---

## Detailed Findings

### 1. SOLID Principles

#### 1.1 Single Responsibility Principle (SRP) - Score: 3/5

**現状分析**:

`route.ts` の `POST` 関数(約180行)は以下の責務を内包している:

1. リクエストボディのパースと検証
2. Worktree存在確認(DB問い合わせ)
3. CLIツールセッション確認
4. プロンプト再検証(`captureSessionOutput` + `detectPrompt`)
5. 送信方式判定(`isClaudeMultiChoice`)
6. カーソルキー配列構築とsendSpecialKeys呼び出し
7. テキスト送信(sendKeys)

```typescript
// route.ts L96-100: 送信方式判定 - Issue #287でフォールバック条件が追加される
const isClaudeMultiChoice = cliToolId === 'claude'
  && promptCheck?.promptData?.type === 'multiple_choice'
  && /^\d+$/.test(answer);

if (isClaudeMultiChoice && promptCheck?.promptData?.type === 'multiple_choice') {
  // ... カーソルキー構築ロジック (L101-148)
}
```

Issue #287の変更により、責務(5)の条件分岐が複雑化する。設計方針書セクション6のコード例:

```typescript
const isClaudeMultiChoice =
  cliToolId === 'claude' &&
  (
    promptCheck?.promptData?.type === 'multiple_choice' ||
    (promptCheck === null && body.promptType === 'multiple_choice')
  ) &&
  /^\d+$/.test(answer);
```

**評価**: 単一関数内の責務数は多いが、APIルートハンドラとしては一般的な構成。フォールバック追加は既存の責務(5)の拡張であり、新たな責務の追加ではない。改善推奨だが必須ではない。

#### 1.2 Open/Closed Principle (OCP) - Score: 4/5

**評価対象**: 非破壊的アプローチの選定

設計方針書セクション3の比較表で示された通り、`onRespond` シグネチャを `(answer: string) => void` のまま維持し、内部で `state.prompt.data` からクロージャ経由でデータを取得する方式は、OCP に準拠している。

```typescript
// 変更なし: UI コンポーネントのインターフェース
onRespond={handlePromptRespond}  // (answer: string) => void

// 内部で拡張: handlePromptRespond 内
const promptType = state.prompt.data?.type;
const defaultOptionNumber = state.prompt.data?.type === 'multiple_choice'
  ? state.prompt.data.options.find(o => o.isDefault)?.number
  : undefined;
```

影響ファイル数を6ファイル以上から3ファイルに削減しており、既存インターフェースの安定性を維持しながら機能拡張を実現している。

`PromptResponseRequest` のオプショナルフィールド追加(`promptType?`, `defaultOptionNumber?`)も後方互換性を完全に維持しており、OCP準拠。

#### 1.3 Liskov Substitution Principle (LSP) - Score: 3/5

**懸念点**: フォールバックパスと通常パスの振る舞いの差異

| 機能 | 通常パス (promptCheck あり) | フォールバックパス (promptCheck null) |
|------|---------------------------|--------------------------------------|
| single-select | 完全対応 | 完全対応 |
| multi-select | 完全対応 | single-select として処理 (D-6) |
| defaultOptionNumber | promptCheck.promptData から正確に取得 | body.defaultOptionNumber ?? 1 (D-5) |

フォールバックパスは通常パスの「代替」として機能するが、完全な等価性は保証されない。設計方針書でトレードオフとして明記されており(D-5, D-6)、エッジケースの頻度を考慮すると実用上の問題は低い。

#### 1.4 Interface Segregation Principle (ISP) - Score: 4/5

UIコンポーネント(`PromptMessage`, `PromptPanel`, `MobilePromptSheet`)のインターフェースに変更を加えない設計判断は ISP に準拠している。これらのコンポーネントは `onRespond(answer: string)` のみを知っていればよく、内部の送信方式判定やフォールバックロジックから完全に分離されている。

#### 1.5 Dependency Inversion Principle (DIP) - Score: 4/5

UI層(handlePromptRespond) -> API層(route.ts) の依存方向は適切に維持されている。`state.prompt.data` からのクロージャ経由アクセスは React の標準的なパターンであり、`activeCliTabRef` と同等の手法が既にコードベースで使用されている。

---

### 2. KISS (Keep It Simple, Stupid) - Score: 4/5

**良い点**:

- フォールバックの基本概念は単純: 「promptCheck があればそれを使う、なければリクエストボディの情報を使う」
- `promptType` フィールドのリテラル型 (`'yes_no' | 'multiple_choice'`) による制約
- `defaultOptionNumber ?? 1` の安全なデフォルト

**改善余地**:

設計方針書セクション6のコード例において、`isClaudeMultiChoice` の条件式が1つの式に複数のデータソース(promptCheck と body)を OR で混在させている。

```typescript
// 現在の設計: 1つの条件式に2つのソースが混在
const isClaudeMultiChoice =
  cliToolId === 'claude' &&
  (
    promptCheck?.promptData?.type === 'multiple_choice' ||
    (promptCheck === null && body.promptType === 'multiple_choice')
  ) &&
  /^\d+$/.test(answer);
```

より読みやすい代替案:

```typescript
// 推奨: effectivePromptType を事前に決定
const effectivePromptType = promptCheck?.promptData?.type ?? body.promptType;
const effectiveDefaultNum = promptCheck
  ? (promptCheck.promptData?.options?.find(o => o.isDefault)?.number ?? 1)
  : (body.defaultOptionNumber ?? 1);

const isClaudeMultiChoice =
  cliToolId === 'claude' &&
  effectivePromptType === 'multiple_choice' &&
  /^\d+$/.test(answer);
```

この変換により:
- 判定ロジックの意図が明確になる
- `effectivePromptType` / `effectiveDefaultNum` をログ出力に含めやすくなる
- `defaultNum` 導出のif分岐(セクション6の2番目のコードブロック)が不要になる

---

### 3. YAGNI (You Aren't Gonna Need It) - Score: 5/5

設計方針書のYAGNI準拠は非常に優れている:

| 延期された機能 | 理由 | 評価 |
|---------------|------|------|
| `PromptResponseRequest` の `src/types/models.ts` への移動 | クライアント側が型を使用していない | 妥当 |
| `route.ts` と `auto-yes-manager.ts` のロジック統合 | 別Issueとしてスコープ分離 | 妥当 |
| multi-select フォールバック対応 | 極めてまれなエッジケース | 妥当 |
| `onRespond` シグネチャ変更 | 6ファイル以上への影響を回避 | 妥当 |

スコープ外の明確な定義(セクション1)により、実装時のスコープクリープを防止している。

---

### 4. DRY (Don't Repeat Yourself) - Score: 3/5

DRY は本設計方針書の最大の懸念点である。

#### 4.1 既存の重複: カーソルキー送信ロジック (Critical)

`route.ts` (L96-158) と `auto-yes-manager.ts` (L343-399) に完全に重複したカーソルキー送信ロジックが存在する。

**route.ts** (L96-148):
```typescript
const isClaudeMultiChoice = cliToolId === 'claude'
  && promptCheck?.promptData?.type === 'multiple_choice'
  && /^\d+$/.test(answer);

if (isClaudeMultiChoice && promptCheck?.promptData?.type === 'multiple_choice') {
  const targetNum = parseInt(answer, 10);
  const mcOptions = promptCheck.promptData.options;
  const defaultOption = mcOptions.find(o => o.isDefault);
  const defaultNum = defaultOption?.number ?? 1;
  const offset = targetNum - defaultNum;
  // ... keys 構築 ...
}
```

**auto-yes-manager.ts** (L343-393):
```typescript
const isClaudeMultiChoice = cliToolId === 'claude'
  && promptDetection.promptData?.type === 'multiple_choice'
  && /^\d+$/.test(answer);

if (isClaudeMultiChoice && promptDetection.promptData?.type === 'multiple_choice') {
  const targetNum = parseInt(answer, 10);
  const mcOptions = promptDetection.promptData.options;
  const defaultOption = mcOptions.find(o => o.isDefault);
  const defaultNum = defaultOption?.number ?? 1;
  const offset = targetNum - defaultNum;
  // ... 同一の keys 構築ロジック ...
}
```

Issue #287 のフォールバック追加は `route.ts` のみに適用されるため、2つのコードパスの乖離がさらに拡大する。

#### 4.2 新規の重複: リクエストボディ構築

Issue #287 では `handlePromptRespond` (WorktreeDetailRefactored.tsx) と `useAutoYes.ts` の両方で以下の導出ロジックが重複する:

```typescript
// 両方で必要な導出ロジック
const promptType = promptData?.type;
const defaultOptionNumber =
  promptData?.type === 'multiple_choice'
    ? promptData.options.find(o => o.isDefault)?.number
    : undefined;
```

#### 4.3 改善提案

**提案A: カーソルキー送信ヘルパーの抽出** (MF-001 対応)

```typescript
// src/lib/cursor-key-sender.ts
interface CursorKeySendParams {
  sessionName: string;
  answer: string;
  cliToolId: CLIToolType;
  promptType?: 'yes_no' | 'multiple_choice';
  options?: MultipleChoiceOption[];
  defaultNum?: number;
}

async function sendPromptAnswer(params: CursorKeySendParams): Promise<void> {
  // isClaudeMultiChoice 判定、offset 計算、keys 構築を一元化
}
```

**提案B: リクエストボディ構築ユーティリティ** (SF-003 対応)

```typescript
// src/lib/prompt-response-body.ts
function buildPromptResponseBody(
  answer: string,
  cliTool: string,
  promptData: PromptData | null
): Record<string, unknown> {
  return {
    answer,
    cliTool,
    promptType: promptData?.type,
    defaultOptionNumber:
      promptData?.type === 'multiple_choice'
        ? promptData.options.find(o => o.isDefault)?.number
        : undefined,
  };
}
```

---

### 5. Architectural Pattern Appropriateness

#### 5.1 フォールバックパターン

「正常パス優先 + フォールバック」のパターンは適切。設計方針書セクション6の判定優先順位:

1. `promptCheck` が存在 -> 既存ロジック (信頼性高)
2. `promptCheck` が null -> body.promptType フォールバック (UIの情報)
3. 両方なし -> テキスト送信 (安全なデフォルト)

この3段階のフォールバックは Graceful Degradation パターンに準拠しており、各段階で安全側に倒す設計は堅実。

#### 5.2 技術選定の妥当性

| 決定 | 評価 | 根拠 |
|------|------|------|
| アプローチB (UI側から情報送信) | 妥当 | answer="1" の曖昧性解消が不可能 |
| 非破壊的アプローチ | 妥当 | 影響ファイル数の大幅削減 |
| promptCheck 優先 | 妥当 | リアルタイム出力の信頼性が高い |
| ローカル型定義維持 | 妥当 | YAGNI準拠 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | カーソルキーロジック重複によるコードパス乖離 | Medium | Medium | P2 |
| 技術的リスク | useCallback dependency 肥大化 | Low | High | P3 |
| セキュリティリスク | promptType/defaultOptionNumber 偽装 | Low | Low | P3 |
| 運用リスク | フォールバックパスの動作が通常パスと異なるケース | Low | Low | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix) - 1 item

**MF-001**: `route.ts` と `auto-yes-manager.ts` のカーソルキー送信ロジック重複の解消を Issue #287 のスコープに含めるか、明確に先行Issueとして分離・対応する。フォールバックを片方にのみ追加すると、2つのコードパスの同期管理コストが増大する。

### 推奨改善項目 (Should Fix) - 3 items

**SF-001**: `route.ts` の送信方式判定+キー送信ロジックを関数として抽出し、SRP を改善する。

**SF-002**: `isClaudeMultiChoice` の条件式を `effectivePromptType` / `effectiveDefaultNum` の事前決定パターンに変更し、可読性を向上する。

**SF-003**: `handlePromptRespond` と `useAutoYes` のリクエストボディ構築を共通ユーティリティに抽出する。

### 検討事項 (Consider) - 4 items

**C-001**: `PromptResponseRequest` の型共有化(将来Issue)

**C-002**: `defaultOptionNumber ?? 1` のフォールバック値の妥当性(現状維持で可)

**C-003**: multi-select フォールバック非対応の許容(現状維持で可)

**C-004**: `state.prompt.data` を useRef に格納し、useCallback 依存配列の肥大化を回避(既存パターン `activeCliTabRef` と同様)

---

## Approval Status

**Status**: Conditionally Approved

**Conditions**:
1. MF-001 (カーソルキーロジック重複) について、Issue #287 のスコープ内で対応するか、先行Issueとして明確に分離・起票し、Issue #287 の前提条件として管理すること。どちらを選択するかはチーム判断に委ねるが、現状のまま片方にのみフォールバックを追加することは避けるべき。

**条件を満たす方法の例**:
- 方法A: Issue #287 のスコープにカーソルキー送信ヘルパー抽出を含める(推奨)
- 方法B: 先行Issueとしてヘルパー抽出を起票し、Issue #287 の前に実施する
- 方法C: Issue #287 のフォールバックロジックを auto-yes-manager.ts にも同時に追加し、重複を許容しつつ一貫性を維持する(非推奨だが最小工数)

---

*Generated by Architecture Review Agent for Issue #287*
*Review date: 2026-02-15*
