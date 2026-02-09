# Issue #188: 応答完了後もスピナーが表示され続ける（thinkingインジケータの誤検出）設計方針書

## 1. 概要

### 問題の概要
Claude CLIの応答が完了し `>` プロンプトが表示されているにもかかわらず、サイドバーのステータスがスピナー（`running`）のまま更新されない。

### 根本原因
1. **P0**: `current-output/route.ts`がthinking検出を非空行15行ウィンドウで実行し、完了済みのthinkingサマリー行を誤検出。さらにthinking=trueでプロンプト検出を無条件スキップ
2. **P1**: 6箇所でthinking検出のウィンドウサイズ・方式が不統一

### 修正方針
`current-output/route.ts`のthinking/prompt優先順位を`status-detector.ts`と統一し、`detectSessionStatus()`を共通関数として再利用する（DRY原則）。

---

## 2. アーキテクチャ設計

### 2.1 修正前の状態検出フロー

```
current-output/route.ts              status-detector.ts
┌───────────────────────────┐        ┌──────────────────────┐
│ 1. stripAnsi+非空行フィルタ │        │ 1. 全行15行取得        │
│    (L73: lines.map(stripAnsi)│       │ 2. プロンプト検出（最優先）│
│     .filter(trim!=''))     │        │ 3. thinking検出         │
│ 2. 非空行15行取得           │        │ 4. 入力プロンプト検出    │
│ 3. thinking検出             │        │ 5. 時間ベースヒューリスティック│
│ 4. thinking=true →          │        └──────────────────────┘
│    プロンプト検出スキップ    │                ✅ 正しい優先順位
│ 5. プロンプト検出            │
└───────────────────────────┘
        ❌ 異なる優先順位
```

> **SF-003**: 修正前の`current-output/route.ts`は非空行フィルタリングの前に`stripAnsi()`も個別適用している（L73: `lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '')`）。この2段階処理が`status-detector.ts`の全行ベースウィンドウと異なる。修正後は`detectSessionStatus()`で全行ベースの統一ウィンドウに移行するため、この差異は解消される。

### 2.2 修正後の状態検出フロー

```
current-output/route.ts        status-detector.ts
┌─────────────────────┐        ┌──────────────────────┐
│ detectSessionStatus()│───────→│ 共通の検出ロジック      │
│ を呼び出し           │        │ 1. プロンプト検出（最優先）│
│                     │        │ 2. thinking検出         │
│ + 個別フィールド設定  │        │ 3. 入力プロンプト検出    │
└─────────────────────┘        └──────────────────────┘
        ✅ 統一された優先順位
```

### 2.3 レイヤー構成

| レイヤー | コンポーネント | 修正内容 |
|---------|-------------|---------|
| API Routes（プレゼンテーション層） | `current-output/route.ts` | `detectSessionStatus()`呼び出しに統合 |
| ビジネスロジック層 | `status-detector.ts` | ウィンドウサイズ調整、thinking検出用ウィンドウ分離 |
| ビジネスロジック層 | `response-poller.ts` | L353全文thinkingチェックのウィンドウ化 |
| 共通パターン層 | `cli-patterns.ts` | 変更なし（既存のdetectThinking()を活用） |

---

## 3. 設計パターン

### 3.1 採用パターン

#### DR-001: `detectSessionStatus()` 共通化（DRY原則）

`current-output/route.ts`のインラインthinking/prompt判定ロジックを`detectSessionStatus()`に統合する。

**根拠**:
- `worktrees/route.ts`は既にIssue #180で`detectSessionStatus()`に統合済み
- 同じ優先順位ロジックを2箇所で維持するのはDRY違反
- `status-detector.ts`の優先順位（プロンプト最優先）が正しい動作

**実装方針**:

```typescript
// current-output/route.ts 修正後
const statusResult = detectSessionStatus(output, cliToolId);

// statusResultから必要なフィールドを導出
const thinking = statusResult.status === 'running' && statusResult.reason === 'thinking_indicator';
const isPromptWaiting = statusResult.hasActivePrompt;
```

**注意**: `current-output/route.ts`は`isGenerating`、`thinking`、`isPromptWaiting`、`promptData`等の個別フィールドをJSON応答に含める必要がある。`detectSessionStatus()`の戻り値だけでは`promptData`（プロンプトの詳細情報）が取得できないため、追加の拡張が必要。

> **SF-001 (Stage 3)**: クライアントサイドの`WorktreeDetailRefactored.tsx`は`data.thinking`フィールドを`setTerminalThinking()`にマッピングする。新しいthinking導出ロジック（`statusResult.status === 'running' && statusResult.reason === 'thinking_indicator'`）は、以前の`detectThinkingState()`による非空行15行チェックから、`detectSessionStatus()`による全行5行チェックに変更される。これによりthinking=true/false遷移のタイミングが変わる可能性がある。テスト設計（セクション6.1）にこの遷移タイミングの検証テストを追加する。

#### DR-002: `StatusDetectionResult`の拡張

`detectSessionStatus()`の戻り値に`promptData`を追加し、`current-output/route.ts`が必要とする情報を全て提供する。

```typescript
export interface StatusDetectionResult {
  status: SessionStatus;
  confidence: StatusConfidence;
  reason: string;
  hasActivePrompt: boolean;
  // DR-002: current-output/route.ts用の追加情報
  promptData?: PromptData;           // プロンプト検出時の詳細データ
}
```

**代替案: `detectSessionStatus()`に戻り値を追加せず、`current-output/route.ts`で個別にプロンプト検出を行う**

```typescript
// 代替案: ステータス検出後、プロンプト検出を個別実行
const statusResult = detectSessionStatus(output, cliToolId);
const thinking = statusResult.status === 'running' && statusResult.reason === 'thinking_indicator';

// プロンプトの詳細データが必要な場合のみ個別実行
let promptDetection = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(cleanOutput, promptOptions);
}
```

**採用判断**: **代替案を採用する**。理由:
1. `StatusDetectionResult`に`promptData`を追加すると、`status-detector.ts`が`prompt-detector.ts`の内部型に結合する（SRP違反）
2. `worktrees/route.ts`は`promptData`を必要としない（`hasActivePrompt`のみ使用）
3. `current-output/route.ts`のみが`promptData`を必要とし、呼び出し元で個別に取得するのが自然
4. ステータス検出の結果（thinking=false）を使ってプロンプト検出の要否を判断でき、Issue #161の防御は維持される

> **SF-004 (Stage 2): detectPrompt()への入力の差異について**
>
> `detectSessionStatus()`内部では`detectPrompt(lastLines, promptOptions)`を呼び出し、`lastLines`は15行ウィンドウである（L83-88）。一方、DR-002代替案の`current-output/route.ts`での個別実行では`detectPrompt(cleanOutput, promptOptions)`を呼び出し、`cleanOutput`は全文（stripAnsi適用済み）である。
>
> この入力の差異は意図的であり、以下の理由により実用上の問題はない:
> 1. `detectPrompt()`内部で独自の50行ウィンドウを切り出す（`prompt-detector.ts` L297: `scanStart`）ため、入力が15行でも全文でも、プロンプト検出結果は同等
> 2. `detectSessionStatus()`の`hasActivePrompt`は15行ウィンドウベースで判定され、これがステータス表示の真値（source of truth）となる
> 3. `current-output/route.ts`の個別`detectPrompt()`は`promptData`取得が目的であり、`isPromptWaiting`の判定には`statusResult.hasActivePrompt`を使用する（`promptDetection.isPrompt`ではない）
>
> **isPromptWaitingの真値（source of truth）**: `statusResult.hasActivePrompt`を使用する。`current-output/route.ts`の個別`detectPrompt()`から取得する`promptDetection.isPrompt`はpromptData取得のための副産物であり、ステータス判定には使用しない。

#### DR-003: thinking検出ウィンドウの分離

`status-detector.ts`のウィンドウ（全行15行）をthinking検出とプロンプト検出で分離する。

**設計判断**: thinking検出は直近の出力（最後5行）に限定し、プロンプト検出は現在の15行ウィンドウを維持する。

**根拠**:
- thinkingインジケータ（`✻ Churned for 41s…`）はアクティブな処理中にのみ末尾数行に表示される
- 応答完了後はセパレータ+プロンプト行が末尾に来るため、5行ウィンドウにthinkingサマリーは含まれない
- プロンプト検出（特にmultiple_choice）は50行ウィンドウが必要（Issue #161/193設計を維持）

```typescript
// status-detector.ts 修正後
// SF-002: auto-yes-manager.tsのTHINKING_CHECK_LINE_COUNTとの名前衝突を回避するため
// STATUS_プレフィックスを付与（値も異なる: 5 vs 50、目的も異なる）
const STATUS_THINKING_LINE_COUNT: number = 5;  // thinking検出用: 直近5行
const STATUS_CHECK_LINE_COUNT: number = 15;    // プロンプト/入力プロンプト検出用: 15行

export function detectSessionStatus(...) {
  const cleanOutput = stripAnsi(output);
  const lines = cleanOutput.split('\n');
  const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
  const thinkingLines = lines.slice(-STATUS_THINKING_LINE_COUNT).join('\n');

  // 1. Interactive prompt detection (highest priority) - 15行ウィンドウ
  const promptOptions = buildDetectPromptOptions(cliToolId);
  const promptDetection = detectPrompt(lastLines, promptOptions);
  if (promptDetection.isPrompt) {
    return { status: 'waiting', confidence: 'high', reason: 'prompt_detected', hasActivePrompt: true };
  }

  // 2. Thinking indicator detection - STATUS_THINKING_LINE_COUNT行ウィンドウ（縮小）
  if (detectThinking(cliToolId, thinkingLines)) {
    return { status: 'running', confidence: 'high', reason: 'thinking_indicator', hasActivePrompt: false };
  }

  // 3以降は既存のまま
}
```

#### DR-004: `response-poller.ts` L353全文thinkingチェックのウィンドウ化

`extractResponse()`内のL353全文thinkingチェックをウィンドウ化する。

**現状の問題**:
```typescript
// L353: 応答全文に対するthinkingチェック → 誤ブロックリスク
if (thinkingPattern.test(response)) {
  return { response: '', isComplete: false, lineCount: totalLines };
}
```

**修正方針**: 応答末尾のN行のみをチェックする。

```typescript
// 修正後: 応答末尾5行のみチェック
// SF-003 (Stage 3): This magic number 5 should track STATUS_THINKING_LINE_COUNT=5
// in status-detector.ts. See design policy Section 14.3 (C-001) and Section 14.13 (SF-003 S3).
const responseLines = response.split('\n');
const tailLines = responseLines.slice(-5).join('\n');
if (thinkingPattern.test(tailLines)) {
  return { response: '', isComplete: false, lineCount: totalLines };
}
```

**根拠**:
- 応答テキスト中に`✻ Churned for 41s…`のようなサマリーが引用として含まれる場合、全文チェックでは誤ブロックされる
- thinking中の中間状態キャプチャ防止という元の目的は、末尾チェックでも達成できる（thinkingインジケータは常に末尾に表示される）

### 3.2 設計判断: ウィンドウサイズの統一戦略

#### 統一ポリシー

| 検出目的 | ウィンドウサイズ | 根拠 |
|---------|---------------|------|
| thinking検出（status-detector.ts: `STATUS_THINKING_LINE_COUNT`） | **5行** | thinkingインジケータは直近の出力にのみ存在。応答完了後のサマリーを誤検出しない。SF-002: `auto-yes-manager.ts`の`THINKING_CHECK_LINE_COUNT`との名前衝突回避のためリネーム |
| プロンプト検出（y/n, multiple_choice） | **15行**（`status-detector.ts`） / **50行**（`prompt-detector.ts`内部） | prompt-detector.tsの内部ウィンドウ（50行）はIssue #161/193設計に基づく |
| 入力プロンプト検出（>, ❯） | **15行** | 既存の動作を維持 |
| 応答完了検出 | **20行** | `response-poller.ts`の既存設計を維持 |
| Auto-Yes thinking検出 | **50行** | Issue #191設計に基づく。prompt-detector.tsの50行スキャン範囲と一致 |

> **C-002 (Stage 3)**: `auto-yes-manager.ts`（`THINKING_CHECK_LINE_COUNT=50`）と`status-detector.ts`（`STATUS_THINKING_LINE_COUNT=5`）のウィンドウサイズ差異について。同一ポーリングサイクル内で、auto-yes-managerがthinkingを検出（行6-50に残存するサマリー等）しているにもかかわらず、status-detectorが検出しない（行1-5のみチェック）ケースが理論的に発生し得る。これは設計上の意図的な差異であり、サイドバーが`ready`を表示しつつauto-yesがプロンプト検出を抑制する一時的なUI不整合が生じる可能性がある。この動作差異はCLAUDE.md更新時にIssue #188セクションに記載する。

#### auto-yes-manager.tsのTHINKING_CHECK_LINE_COUNTとの整合性

`auto-yes-manager.ts`の`THINKING_CHECK_LINE_COUNT=50`は、Issue #191で`prompt-detector.ts`の50行スキャン範囲との一致を根拠に設計されている（SF-001）。

**設計判断**: `auto-yes-manager.ts`のウィンドウサイズは変更しない。

**根拠**:
1. `auto-yes-manager.ts`のthinking検出は、プロンプト検出（50行）と同じスコープをカバーする必要がある（Issue #161 Layer 1防御）
2. `status-detector.ts`のthinking検出とは目的が異なる:
   - `status-detector.ts`: UIステータス表示（正確さ重視、5行で十分）
   - `auto-yes-manager.ts`: Auto-Yes誤発火防止（安全性重視、広いウィンドウが必要）
3. `THINKING_CHECK_LINE_COUNT`のコメント（L71-78）に設計根拠が明記されており、変更する場合はIssue #191の設計を再評価する必要がある

---

## 4. 修正対象ファイルと変更内容

### 4.1 P0修正（必須）

#### 4.1.1 `src/app/api/worktrees/[id]/current-output/route.ts`

**変更内容**: インラインのthinking/prompt判定ロジックを`detectSessionStatus()`ベースに統合

**修正前** (L72-94):

> **MF-001 (Stage 2)**: 行番号の詳細マッピング:
> - L72-74: 非空行フィルタリング+ウィンドウ取得（`nonEmptyLines`, `lastSection`）
> - L76-77: stripAnsiによるクリーン出力生成（`cleanOutput`）
> - L79-83: thinkingインジケータ検出（`detectThinkingState`呼び出し）
> - L85-90: プロンプト検出（thinking条件分岐付き）
> - L92-94: `isPromptWaiting`導出

```typescript
// Check last 15 non-empty lines for state detection
const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
const lastSection = nonEmptyLines.slice(-15).join('\n');

const cleanOutput = stripAnsi(output);
const thinking = detectThinkingState(cliToolId, lastSection);

const promptOptions = buildDetectPromptOptions(cliToolId);
const promptDetection = thinking
    ? { isPrompt: false, cleanContent: cleanOutput }
    : detectPrompt(cleanOutput, promptOptions);

const isPromptWaiting = promptDetection.isPrompt;
```

**修正後**:
```typescript
const cleanOutput = stripAnsi(output);

// DR-001: detectSessionStatus()で統一された優先順位によるステータス判定
const statusResult = detectSessionStatus(output, cliToolId);
const thinking = statusResult.status === 'running' && statusResult.reason === 'thinking_indicator';

// DR-002(代替案): プロンプト詳細データが必要な場合のみ個別検出
// SF-001: detectPrompt() is intentionally called separately from detectSessionStatus()
// to obtain promptData. This controlled DRY violation maintains SRP of StatusDetectionResult.
// See design policy Section 14.1 for full rationale.
// Issue #161維持: thinkingでない場合のみプロンプト検出を実行
let promptDetection: { isPrompt: boolean; cleanContent: string; promptData?: unknown } = { isPrompt: false, cleanContent: cleanOutput };
if (!thinking) {
  const promptOptions = buildDetectPromptOptions(cliToolId);
  promptDetection = detectPrompt(cleanOutput, promptOptions);
}

const isPromptWaiting = statusResult.hasActivePrompt;
```

**import変更**:
```typescript
// 削除
- import { detectThinking as detectThinkingState, stripAnsi, buildDetectPromptOptions } from '@/lib/cli-patterns';

// 追加
+ import { stripAnsi, buildDetectPromptOptions } from '@/lib/cli-patterns';
+ import { detectSessionStatus } from '@/lib/status-detector';
```

**Issue #161との整合性**: `detectSessionStatus()`内でプロンプト検出が最優先（L85-96）のため、thinkingインジケータがプロンプトを上書きすることはない。thinkingのみでプロンプトなしの場合はthinking優先（Issue #161 Layer 1維持）。

#### 4.1.2 `src/lib/status-detector.ts`

**変更内容**: thinking検出ウィンドウをプロンプト検出ウィンドウから分離し、5行に縮小

**修正前** (L50):

> **SF-001 (Stage 2)**: L50の`STATUS_CHECK_LINE_COUNT = 15`は正確。

```typescript
const STATUS_CHECK_LINE_COUNT: number = 15;
```

**修正後**:
```typescript
/**
 * Number of lines from the end to check for prompt and input indicators
 * @constant
 */
const STATUS_CHECK_LINE_COUNT: number = 15;

/**
 * Number of lines from the end to check for thinking indicators.
 * Thinking indicators (spinner + activity text) only appear in the most recent lines.
 * A small window prevents completed thinking summaries (e.g., "✻ Churned for 41s")
 * in scrollback from being falsely detected as active thinking.
 *
 * SF-002: Named STATUS_THINKING_LINE_COUNT (not THINKING_CHECK_LINE_COUNT) to avoid
 * naming collision with auto-yes-manager.ts's THINKING_CHECK_LINE_COUNT=50.
 * The two constants serve different purposes:
 *   - STATUS_THINKING_LINE_COUNT (5): UI status display (accuracy-focused)
 *   - THINKING_CHECK_LINE_COUNT (50): Auto-Yes false-fire prevention (safety-focused)
 * @constant
 */
const STATUS_THINKING_LINE_COUNT: number = 5;
```

**detectSessionStatus()内の修正**:

> **SF-001 (Stage 2)**: `detectSessionStatus()`関数はL75-143。修正対象の行は限定的:
> - L83: `lastLines`生成行（`thinkingLines`変数を追加）
> - L100: `detectThinking(cliToolId, lastLines)` -> `detectThinking(cliToolId, thinkingLines)`に変更
> - 旧表記「L82-107」は関数内のステップ1-2の範囲を示していたが、実際の変更はL83とL100の2行のみ。

```typescript
// 修正前 (L83)
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');

// 修正後 (SF-002: STATUS_THINKING_LINE_COUNTを使用)
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
const thinkingLines = lines.slice(-STATUS_THINKING_LINE_COUNT).join('\n');
```

```typescript
// 修正前 (L100)
if (detectThinking(cliToolId, lastLines)) {

// 修正後
if (detectThinking(cliToolId, thinkingLines)) {
```

### 4.2 P1修正

#### 4.2.1 `src/lib/response-poller.ts` L353全文thinkingチェックのウィンドウ化

**変更内容**: 応答全文チェックを末尾5行チェックに変更

**修正前** (L351-358):

> **SF-002 (Stage 2)**: 行番号を精緻化。L351はコメント行（`// Additional check: ensure response doesn't contain thinking indicators`）、L352は空行的ではなくL353が`if`文開始、L358が閉じ括弧。旧表記「L351-359」から「L351-358」に修正。L353の`thinkingPattern.test(response)`自体は正確。

```typescript
// Additional check: ensure response doesn't contain thinking indicators
// This prevents saving intermediate states as final responses
if (thinkingPattern.test(response)) {
  return {
    response: '',
    isComplete: false,
    lineCount: totalLines,
  };
}
```

**修正後**:
```typescript
// DR-004: Check only the tail of the response for thinking indicators
// Prevents false blocking when completed thinking summaries appear in the response body
// SF-003 (Stage 3): This tail line count (5) should track STATUS_THINKING_LINE_COUNT=5
// in status-detector.ts. If STATUS_THINKING_LINE_COUNT changes, update this value accordingly.
// See design policy Section 14.13 for rationale.
const responseTailLines = response.split('\n').slice(-5).join('\n');
if (thinkingPattern.test(responseTailLines)) {
  return {
    response: '',
    isComplete: false,
    lineCount: totalLines,
  };
}
```

#### 4.2.2 `src/app/api/worktrees/[id]/current-output/route.ts` の非空行フィルタリング除去

**変更内容**: P0修正（DR-001）で`detectSessionStatus()`を使用することで、非空行フィルタリングのロジックは自動的に不要になる。`detectSessionStatus()`は全行ベースでウィンドウを取得する。

> **SF-002 (Stage 3)**: 非空行フィルタリング除去により、tmuxバッファに空行パディングが多い場合、15行全行ウィンドウの有効可視コンテンツが減少する。プロンプトが末尾から15行以内の非空行には存在するが、15行以内の全行（空行含む）には存在しないケースで、プロンプト検出が失敗するリスクがある。テスト設計（セクション6.1）にこの境界ケースの検証を含める。

削除対象コード:
```typescript
// 削除: 非空行フィルタリング（detectSessionStatus()に統合済み）
- const nonEmptyLines = lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '');
- const lastSection = nonEmptyLines.slice(-15).join('\n');
```

### 4.3 P2修正（将来対応）

#### 4.3.1 `src/lib/claude-poller.ts` のdeprecation

本Issueのスコープ外。将来Issueとして`claude-poller.ts`の到達不能コード削除を検討。

> **C-001 (Stage 3)**: `claude-poller.ts` L144にも`thinkingPattern.test(response)`（全文thinkingチェック）が存在し、同じ脆弱性を持つ。L162およびL234のTODOコメントで既にsupersededとマークされている。claude-poller.tsのdeprecationを別のフォローアップIssueとして追跡し、技術的負債の蓄積を防ぐ。

#### 4.3.2 `src/lib/response-poller.ts` checkForResponse() L547-554の全文thinkingチェック

> **MF-001 (Stage 3)**: `checkForResponse()`内L547-554の`thinkingPattern.test(cleanOutput)`は、P0の根本原因と同じ全文thinkingチェックの脆弱性を持つ。スクロールバックにthinkingサマリーが残存する場合、pending promptが誤ってanswered処理されるリスクがある。

**既知の制限事項**: 本Issue（#188）のスコープ（ステータス表示の誤り）には直接影響しないが、Auto-Yesモードでpending promptの応答判定に影響する可能性がある。

**対応方針**: 以下の2つのオプションを提示する。

**オプションA（推奨）**: フォローアップIssueの作成
- `checkForResponse()` L547-554の全文thinkingチェックにウィンドウ化を適用する別Issueを作成
- 本Issue実装時に、L547-554に既知の制限事項コメントを追加する

```typescript
// L547-554 implementation comment:
// KNOWN LIMITATION (Issue #188 MF-001 Stage 3): This full-text thinking check
// may falsely match completed thinking summaries in scrollback, causing pending
// prompts to be incorrectly marked as answered. A follow-up Issue should apply
// the same tail-line windowing as DR-004 (extractResponse L353).
```

**オプションB**: 本Issue内でP2修正として実施
- L547-554にも末尾5行チェックを適用する（DR-004と同じパターン）
- リスクは低いが、pending promptのanswered処理の目的を十分に理解してからの適用が望ましい

**採用判断**: **オプションAを採用する**。理由:
1. L547-554はpending promptのanswered処理を目的としており、ステータス表示の修正（本Issueのスコープ）とは異なる
2. ウィンドウ化の適用がanswered判定の正確性に影響を与えないことを個別に検証する必要がある
3. 本Issueの変更範囲を最小限に保つことで、回帰リスクを低減する

---

## 5. セキュリティ設計

### 5.1 既存セキュリティ対策の維持

| 対策 | 関連Issue | 維持方法 |
|-----|---------|---------|
| Issue #161 Layer 1: thinking中のprompt検出スキップ | #161 | `detectSessionStatus()`の優先順位で維持（プロンプト最優先: L85-96でプロンプト検出、L98-107でthinking検出。プロンプト未検出時のみthinkingが有効となり、Layer 1防御が機能する） |
| Issue #161 Layer 3: 連番検証 | #161 | `prompt-detector.ts`は変更なし |
| Issue #193 Layer 5 SEC-001: requireDefaultIndicator=falseのガード | #193 | `prompt-detector.ts`は変更なし |
| Issue #191 SF-001: THINKING_CHECK_LINE_COUNTとprompt-detector.tsの50行一致 | #191 | `auto-yes-manager.ts`は変更なし |
| SEC-002: stripAnsi()の適用 | #193 | `detectSessionStatus()`内で一括適用 |

### 5.2 新たなリスクと対策

| リスク | 対策 |
|-------|------|
| thinking検出ウィンドウ縮小（5行）でアクティブなthinkingを見逃す可能性 | thinkingインジケータは常に末尾に表示されるため、5行で十分。テストで境界条件を検証 |
| `response-poller.ts` L353のウィンドウ化で中間状態キャプチャのリスク | thinking中は`isComplete=false`が`hasPrompt && !isThinking`で先に判定されるため、L353は二重チェック。ウィンドウ化しても安全 |
| `response-poller.ts` checkForResponse() L547-554の全文thinkingチェックによるpending prompt誤判定（MF-001 Stage 3） | 本Issueではコメントによる既知制限事項の明示と、フォローアップIssueの作成で対応。直接のウィンドウ化修正はフォローアップで実施 |

### 5.3 OWASP Top 10チェックリスト（Stage 4セキュリティレビュー結果）

| OWASP カテゴリ | ステータス | 備考 |
|---------------|-----------|------|
| A01: Broken Access Control | pass | params.idのDB参照はプリペアドステートメント使用。エラーメッセージにparams.idが含まれる点はSF-002-S4（スコープ外）として記録 |
| A02: Cryptographic Failures | N/A | 本変更は暗号化処理を含まない |
| A03: Injection | pass | tmux操作はsendKeys()経由。正規表現はモジュールレベル定数でReDoSリスク低。stripAnsi()のカバレッジ限界はC-002-S4として記録 |
| A04: Insecure Design | pass | プロンプト最優先のステータス検出設計でAuto-Yes誤発火防止。Issue #161/193セキュリティレイヤー全維持 |
| A05: Security Misconfiguration | pass | ウィンドウサイズ定数化でミス低減。STATUS_プレフィックスで誤参照リスク低減 |
| A06: Vulnerable Components | N/A | 新規依存ライブラリ追加なし |
| A07: Authentication Failures | N/A | 本変更は認証処理を含まない |
| A08: Data Integrity Failures | pass | detectSessionStatus()戻り値はメモリ内のみ使用。DB書き込みは既存ロジックで変更なし |
| A09: Logging & Monitoring | pass | 既存ログパターン維持。エラーメッセージにセンシティブ情報なし |
| A10: SSRF | N/A | 本変更は外部HTTPリクエストを含まない |

### 5.4 セキュリティ防御維持確認（Stage 4セキュリティレビュー結果）

Stage 4セキュリティレビューにおいて、以下の既存セキュリティ防御が全て維持されていることを確認済み:

| 防御レイヤー | ステータス | 説明 |
|-------------|-----------|------|
| Issue #161 Layer 1 (thinking skip) | maintained | detectSessionStatus()のプロンプト最優先順序で維持 |
| Issue #161 Layer 2 (2パス cursor 検出) | maintained | prompt-detector.ts変更なし |
| Issue #161 Layer 3 (連番検証) | maintained | prompt-detector.ts変更なし |
| Issue #193 Layer 5 SEC-001 (requireDefaultIndicatorガード) | maintained | prompt-detector.ts変更なし |
| Issue #193 SEC-002 (stripAnsi適用) | maintained | detectSessionStatus()内で一括適用 |
| Issue #193 SEC-003 (固定エラーメッセージ) | maintained | prompt-detector.ts変更なし |
| Issue #191 SF-001 (THINKING_CHECK_LINE_COUNT=50) | maintained | auto-yes-manager.ts変更なし |
| Issue #138 DoS防止 (MAX_CONCURRENT_POLLERS=50) | maintained | auto-yes-manager.ts変更なし |

### 5.5 既存のセキュリティ課題（Stage 4で発見、スコープ外）

以下はStage 4セキュリティレビューで発見された既存の課題であり、Issue #188のスコープ外として記録する:

| ID | 課題 | OWASP | リスク | フォローアップ |
|----|------|-------|--------|--------------|
| SF-001-S4 | `validateSessionName()`のエラーメッセージにユーザー入力が含まれる（`cli-tools/validation.ts`） | A01:2021 | low | フォローアップIssueで固定エラーメッセージに変更（Issue #193 SEC-003パターン適用） |
| SF-002-S4 | `current-output/route.ts`等の404エラーにparams.idが含まれる（広域課題） | A01:2021 | low | セキュリティ強化の別Issueで一括対応 |

---

## 6. テスト設計

### 6.1 新規テスト

#### `tests/unit/lib/status-detector.test.ts`（新規作成）

| テストケース | 入力 | 期待結果 |
|------------|------|---------|
| thinking+prompt共存時にプロンプト優先 | 末尾にプロンプト行 + 5行以上前にthinkingサマリー | `status: 'ready'` |
| thinking+prompt共存時にプロンプト優先（waiting） | 末尾にy/nプロンプト + 5行以上前にthinkingサマリー | `status: 'waiting'`, `hasActivePrompt: true` |
| アクティブthinking（末尾5行内） | 末尾にthinkingインジケータ | `status: 'running'` |
| thinkingサマリーが5行外（誤検出防止） | 末尾6行目にthinkingサマリー、プロンプトあり | `status: 'ready'` |
| thinkingサマリーが5行外（プロンプトなし） | 末尾6行目にthinkingサマリー、プロンプトなし | `status: 'running'` (low confidence, default) |
| STATUS_THINKING_LINE_COUNT境界テスト | 末尾ちょうど5行目にthinkingインジケータ | `status: 'running'` |
| C-002: 空行を多く含む出力でのthinking検出 | 末尾15行中に空行が多数、5行ウィンドウ内にthinkingインジケータ | `status: 'running'` |
| C-002: 空行を多く含む出力でのprompt検出 | 末尾15行中に空行が多数、プロンプト行あり | `status: 'waiting'` or `status: 'ready'` |
| SF-002 (S3): 空行パディングでプロンプトが15全行外だが15非空行内 | プロンプト行が末尾から16行目（全行）だが末尾から10行目（非空行） | `status`がプロンプト検出に失敗する可能性を確認（既知の動作変更として文書化） |

#### `src/lib/__tests__/cli-patterns.test.ts`（追加）

| テストケース | 入力 | 期待結果 |
|------------|------|---------|
| 完了済みthinkingサマリーのマッチ | `✻ Churned for 41s…` | `true`（パターン自体はマッチ。ウィンドウ制御で誤検出防止） |
| `(esc to interrupt)` のマッチ | `Planning · (esc to interrupt)` | `true` |
| アクティブthinkingのマッチ | `✻ Planning…` | `true` |

#### `tests/integration/current-output-thinking.test.ts`（新規作成）

| テストケース | シナリオ | 期待結果 |
|------------|---------|---------|
| 応答完了後のスピナー解除 | tmux出力にプロンプト + 古いthinkingサマリー | `isGenerating: false`, `isPromptWaiting: false` |
| thinking中のスピナー表示 | tmux出力にアクティブthinking | `isGenerating: true` |
| Issue #161回帰: numbered list | thinking中にnumbered listが出力 | `isPromptWaiting: false` |
| SF-001 (S3): thinking field遷移（アクティブthinking - 末尾5行内） | 末尾5行内にアクティブthinkingインジケータ | JSON応答の`thinking: true` |
| SF-001 (S3): thinking field遷移（サマリー5行外+プロンプト有） | 5行外にthinkingサマリー、末尾にプロンプト | JSON応答の`thinking: false`, `isPromptWaiting: true` |
| SF-001 (S3): thinking field遷移（サマリー5行外+プロンプト無） | 5行外にthinkingサマリー、プロンプトなし | JSON応答の`thinking: false` |
| SF-004 (S3): isPromptWaiting source of truth検証 | プロンプトが15行ウィンドウ外かつ全文50行ウィンドウ内に存在 | `isPromptWaiting: false`（`statusResult.hasActivePrompt`がsource of truthであり、15行ウィンドウ外のプロンプトは検出されない） |

### 6.2 既存テストの確認

- `prompt-detector.test.ts`: 変更なし（prompt-detector.tsは未修正）
- `auto-yes-manager.test.ts`: 変更なし（auto-yes-manager.tsは未修正）

---

## 7. パフォーマンス設計

### 7.1 影響分析

| 項目 | 影響 |
|-----|------|
| `detectSessionStatus()`呼び出し回数 | 変更なし（`current-output/route.ts`は既にポーリングで呼ばれている） |
| ウィンドウサイズ縮小（15行→5行） | thinking検出の処理量がわずかに減少（正のパフォーマンス影響） |
| `response-poller.ts`ウィンドウ化 | 全文チェック→5行チェックで処理量が減少（正のパフォーマンス影響） |

### 7.2 ポーリング間隔への影響

変更なし。既存のポーリング間隔（2秒）を維持。

---

## 8. 設計上の決定事項とトレードオフ

### 8.1 採用した設計

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| DR-001: `detectSessionStatus()`共通化 | DRY原則、Issue #180設計との一貫性 | `current-output/route.ts`で個別のpromptData取得が必要 |
| DR-002代替案: promptDataは呼び出し元で個別取得 | SRP維持、`status-detector.ts`の結合度を低く保つ | `detectPrompt()`がステータス判定後に再実行される（SF-001: 制御されたDRY違反として許容。計算コスト軽微、SRP/ISP維持を優先） |
| DR-003: thinking検出ウィンドウ5行 | 完了済みサマリーの誤検出防止 | アクティブthinkingが5行以上の出力を生成するケースでは見逃しリスク（実際には起こりにくい） |
| DR-004: L353ウィンドウ化 | 応答テキスト中のthinkingサマリー引用での誤ブロック防止 | thinking中の中間状態キャプチャの二重チェックが弱くなる（L282のチェックで十分） |
| auto-yes-manager.ts変更なし | Issue #191設計を維持、安全性重視 | `status-detector.ts`と異なるウィンドウサイズが残る（目的が異なるため許容） |
| MF-001 (S3): L547-554はフォローアップIssueで対応 | スコープ限定、回帰リスク低減 | 全文thinkingチェックの脆弱性がpending prompt判定に残存（コメントで明示） |

### 8.2 代替案との比較

#### 代替案A: `current-output/route.ts`のthinking/promptロジックを個別に修正

- **メリット**: 変更範囲が最小
- **デメリット**: DRY違反、`status-detector.ts`との優先順位の不整合が残る
- **不採用理由**: Issue #180で`worktrees/route.ts`を統合した設計方針との一貫性がない

#### 代替案B: thinking検出の完全無効化（プロンプト検出のみに依存）

- **メリット**: thinking誤検出が原理的に発生しない
- **デメリット**: Issue #161のLayer 1防御が無効化される。thinking中のnumbered listがmultiple_choiceとして誤検出されるリスク復活
- **不採用理由**: Issue #161との整合性が破壊される

#### 代替案C: 全箇所のウィンドウサイズを統一値に変更

- **メリット**: 一貫性が最大
- **デメリット**: `auto-yes-manager.ts`のIssue #191設計根拠を再評価する必要。各箇所の目的が異なるため単一値は不適切
- **不採用理由**: 目的別のウィンドウサイズ（セクション3.2）が適切

---

## 9. 実装順序

| 順序 | 対象 | 優先度 | 依存関係 |
|-----|------|-------|---------|
| 1 | `status-detector.ts` STATUS_THINKING_LINE_COUNT追加とウィンドウ分離（SF-002） | P0 | なし |
| 2 | `status-detector.test.ts` 新規テスト作成 | P0 | 1に依存 |
| 3 | `current-output/route.ts` detectSessionStatus()統合 | P0 | 1に依存 |
| 4 | `current-output-thinking.test.ts` 統合テスト作成 | P0 | 3に依存 |
| 5 | `cli-patterns.test.ts` detectThinking()テスト追加 | P1 | なし |
| 6 | `response-poller.ts` L353ウィンドウ化 | P1 | なし |
| 7 | `response-poller.ts` L547-554に既知制限事項コメント追加（MF-001 S3） | P1 | なし |
| 8 | CLAUDE.md更新（C-002 S3のウィンドウサイズ差異説明を含む） | P1 | 1-7完了後 |

---

## 10. 影響範囲まとめ

### 直接修正ファイル

| ファイル | 変更内容 | 優先度 |
|---------|---------|-------|
| `src/lib/status-detector.ts` | STATUS_THINKING_LINE_COUNT追加（SF-002: リネーム済み）、detectSessionStatus()ウィンドウ分離 | P0 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | detectSessionStatus()統合、インラインロジック削除 | P0 |
| `src/lib/response-poller.ts` | L353全文thinkingチェックのウィンドウ化、L547-554既知制限コメント追加 | P1 |

### 間接的に影響を受けるファイル

> **SF-001 (Stage 3)**: 以下のファイルは直接修正しないが、`current-output/route.ts`のJSON応答フィールド導出ロジック変更（特にthinking、isPromptWaitingフィールド）の影響を受ける。

| ファイル | 影響内容 | リスク |
|---------|---------|-------|
| `src/app/api/worktrees/route.ts` | `detectSessionStatus()`使用 - 内部動作変更（5行thinkingウィンドウ）がステータス結果に影響 | low |
| `src/app/api/worktrees/[id]/route.ts` | `detectSessionStatus()`使用 - 同上 | low |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | current-output API応答を消費（`data.thinking` -> `setTerminalThinking()`マッピング）。thinking導出ロジック変更によりthinking=true/false遷移タイミングが変わる可能性 | low |
| `src/hooks/useAutoYes.ts` | current-output APIの`isPromptWaiting`を消費。source of truthが`detectPrompt()`から`statusResult.hasActivePrompt`に変更 | low |
| `src/components/worktree/WorktreeDetail.tsx` | レガシーコンポーネント、current-output APIフィールドを消費 | low |

### 新規テストファイル

| ファイル | 内容 |
|---------|------|
| `tests/unit/lib/status-detector.test.ts` | thinking+prompt共存、ウィンドウ境界テスト |
| `tests/integration/current-output-thinking.test.ts` | thinking/prompt優先順位統合テスト、thinking field遷移テスト（SF-001 S3）、isPromptWaiting source of truthテスト（SF-004 S3） |

### 既存テスト追加

| ファイル | 追加内容 |
|---------|---------|
| `src/lib/__tests__/cli-patterns.test.ts` | detectThinking()パターンテスト追加 |

### 変更なしファイル（整合性確認のみ）

| ファイル | 確認内容 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | THINKING_CHECK_LINE_COUNT=50変更なし（Issue #191設計維持） |
| `src/lib/prompt-detector.ts` | 変更なし（CLIツール非依存設計維持） |
| `src/lib/cli-patterns.ts` | 変更なし（detectThinking()、CLAUDE_THINKING_PATTERN維持） |
| `src/app/api/worktrees/route.ts` | 変更なし（既にdetectSessionStatus()使用） |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | 独立したdetectPrompt()呼び出し - status-detector変更の影響なし |

---

## 11. 制約条件

### CLAUDE.md準拠事項

| 原則 | 適用 |
|-----|------|
| DRY | `detectSessionStatus()`共通化（DR-001） |
| SRP | `status-detector.ts`のステータス検出責任を維持、`promptData`は呼び出し元で取得（DR-002代替案） |
| OCP | ウィンドウサイズを定数化し、将来の調整を容易に |
| KISS | thinking検出ウィンドウ縮小というシンプルなアプローチ |
| YAGNI | 全箇所のウィンドウ統一は行わず、問題のある箇所のみ修正 |

### 関連Issue整合性

| Issue | 整合性 |
|-------|--------|
| #161 | Layer 1防御（thinking中のprompt検出スキップ）を維持。`detectSessionStatus()`の優先順位で実現 |
| #180 | `worktrees/route.ts`の`detectSessionStatus()`統合設計を`current-output/route.ts`にも適用。C-002 (Stage 2): Issue #188ではさらに`status-detector.ts`のウィンドウ構造を変更（15行一本 -> 15行+5行分離）。これはIssue #180設計からの進化であり矛盾ではないが、`detectSessionStatus()`の内部動作が変わる点に留意 |
| #191 | `auto-yes-manager.ts`のTHINKING_CHECK_LINE_COUNT=50は変更なし。C-002 (Stage 3): ウィンドウサイズ差異（5 vs 50）は設計上の意図的な差異であり、一時的なUI不整合（サイドバーreadyかつauto-yesがthinking検出中）が生じる可能性があるが許容 |
| #193 | `prompt-detector.ts`のDetectPromptOptions、buildDetectPromptOptions()は変更なし |

### ロールバック戦略

> **C-003 (Stage 3)**: 本修正は3ファイル（`status-detector.ts`、`current-output/route.ts`、`response-poller.ts`）の変更で構成される。DBマイグレーションや状態フォーマット変更を含まないため、問題発生時はこれら3ファイルの変更をgit revertすることで完全にロールバック可能。PR説明にこのロールバック手順を記載する。

---

## 12. レビュー履歴

| ステージ | レビュー日 | スコア | ステータス | レビュー結果 |
|---------|-----------|-------|-----------|------------|
| Stage 1 通常レビュー | 2026-02-09 | 4/5 | approved | Must Fix: 0件, Should Fix: 2件, Consider: 3件 |
| Stage 2 整合性レビュー | 2026-02-09 | 4/5 | conditionally_approved | Must Fix: 1件, Should Fix: 4件, Consider: 3件 |
| Stage 3 影響分析レビュー | 2026-02-09 | 4/5 | conditionally_approved | Must Fix: 1件, Should Fix: 4件, Consider: 3件 |
| Stage 4 セキュリティレビュー | 2026-02-09 | 4/5 | approved | Must Fix: 0件, Should Fix: 2件, Consider: 3件 |

---

## 13. レビュー指摘事項サマリー

### 13.1 Stage 1 Must Fix

該当なし。

### 13.2 Stage 1 Should Fix

| ID | タイトル | 原則 | 重要度 | 対応状態 |
|----|---------|------|--------|---------|
| SF-001 | detectPrompt()の二重実行リスク（DR-002代替案） | SRP / DRY | low | 設計方針として許容（トレードオフ文書化） |
| SF-002 | thinking検出ウィンドウサイズ定数名の重複 | DRY / KISS | low | 定数名をリネーム |

### 13.3 Stage 1 Consider（将来検討）

| ID | タイトル | 原則 | 備考 |
|----|---------|------|------|
| C-001 | response-poller.ts L353のウィンドウ化でマジックナンバー5 | DRY | YAGNIの観点から即座の対応は不要。将来のメンテナンス性向上のために留意 |
| C-002 | current-output/route.tsの非空行フィルタリング除去の暗黙的影響 | KISS | 空行を含む出力でのthinking/prompt検出テストシナリオの追加を検討 |
| C-003 | detectSessionStatus()の汎用化とcaller固有ロジックの分離 | OCP | callerが3箇所以上に増えた場合にマッピング関数の共通化を検討（現時点はYAGNIで許容） |

### 13.4 Stage 2 Must Fix

| ID | タイトル | 原則 | 重要度 | 対応状態 |
|----|---------|------|--------|---------|
| MF-001 | Section 4.1.1の修正前コードスニペットの行番号を精緻化 | 整合性 | low | 設計書を修正（行番号詳細マッピングを追記） |

### 13.5 Stage 2 Should Fix

| ID | タイトル | 原則 | 重要度 | 対応状態 |
|----|---------|------|--------|---------|
| SF-001 (S2) | Section 4.1.2のstatus-detector.ts行番号を精緻化 | 整合性 | low | 設計書を修正（L82-107 -> L83, L100に限定） |
| SF-002 (S2) | Section 4.2.1のresponse-poller.ts行番号を精緻化 | 整合性 | low | 設計書を修正（L351-359 -> L351-358に修正） |
| SF-003 (S2) | Section 2.1フロー図にstripAnsi+非空行フィルタの2段階処理を明記 | 整合性 | low | 設計書を修正（フロー図を更新、注釈追加） |
| SF-004 (S2) | detectPrompt()への入力差異（cleanOutput vs lastLines）の文書化 | 整合性 | medium | 設計書を修正（DR-002代替案にSF-004注釈を追加、isPromptWaitingのsource of truthを明記） |

### 13.6 Stage 2 Consider（将来検討）

| ID | タイトル | 原則 | 備考 |
|----|---------|------|------|
| C-001 (S2) | response-poller.ts checkForResponse()内L547-554の全文thinkingチェック | 整合性 | 別目的（pending promptのanswered処理）のため本Issue修正対象外。設計書の「6箇所の不統一」（P1）との関係を整理して文書化 |
| C-002 (S2) | Issue #180設計との整合性: status-detector.tsウィンドウ構造の変更 | 整合性 | Section 11の関連Issue整合性表にIssue #180のウィンドウ構造変更を追記 |
| C-003 (S2) | Section 5.1のthinking/prompt優先順位説明の表現修正 | 整合性 | 「thinking優先 = プロンプト未検出時のみ」を「プロンプト最優先」に修正 |

### 13.7 Stage 3 Must Fix

| ID | タイトル | 原則 | 重要度 | 対応状態 |
|----|---------|------|--------|---------|
| MF-001 (S3) | response-poller.ts checkForResponse() L547-554の全文thinkingチェックが未対応で回帰リスクあり | 影響範囲 | medium | フォローアップIssue作成を推奨。本Issue実装時にL547-554に既知制限コメントを追加（Section 4.3.2、Section 14.10） |

### 13.8 Stage 3 Should Fix

| ID | タイトル | 原則 | 重要度 | 対応状態 |
|----|---------|------|--------|---------|
| SF-001 (S3) | クライアントサイドのcurrent-output API消費者がthinking/isGeneratingフィールド導出に依存 | 下流影響 | low | テスト設計にthinking field遷移シナリオを追加（Section 6.1、Section 14.11） |
| SF-002 (S3) | 非空行フィルタリング除去によるプロンプト検出の有効ウィンドウ変更 | 動作変更 | medium | C-002テストケースの強化（空行パディング境界テスト追加）（Section 6.1、Section 14.12） |
| SF-003 (S3) | response-poller.ts L353のマジックナンバー5がSTATUS_THINKING_LINE_COUNTと連動しない | 保守性 | low | DR-004修正コードにSTATUS_THINKING_LINE_COUNTへの相互参照コメントを追加（Section 4.2.1、Section 14.13） |
| SF-004 (S3) | isPromptWaiting source of truth（SF-004 Stage 2）のテストカバレッジ不足 | テストカバレッジ | medium | 15行ウィンドウ外/全文50行内のプロンプトシナリオで`isPromptWaiting: false`を検証するテストケースを追加（Section 6.1、Section 14.14） |

### 13.9 Stage 3 Consider（将来検討）

| ID | タイトル | 原則 | 備考 |
|----|---------|------|------|
| C-001 (S3) | claude-poller.tsに同一の全文thinkingチェック脆弱性が存在 | レガシーコード | L162/L234のTODOコメントで既にsuperseded。deprecationを別フォローアップIssueで追跡 |
| C-002 (S3) | auto-yes-manager.tsとstatus-detector.tsのウィンドウサイズ差異による一時的UI不整合 | Issue間影響 | 設計上の意図的差異。CLAUDE.md更新時にIssue #188セクションに動作差異を記載 |
| C-003 (S3) | ロールバック戦略の文書化 | 運用 | 3ファイルの変更のみでDBマイグレーションなし。git revertで完全ロールバック可能。PR説明に記載 |

### 13.10 Stage 4 Must Fix

該当なし。

### 13.11 Stage 4 Should Fix

| ID | タイトル | カテゴリ | OWASP | 重要度 | 対応状態 |
|----|---------|---------|-------|--------|---------|
| SF-001-S4 | validateSessionName()のエラーメッセージにユーザー入力が含まれる | Information Disclosure | A01:2021 | low | Issue #188スコープ外。フォローアップIssueで対応（Section 14.16） |
| SF-002-S4 | current-output/route.tsの404エラーにparams.idが含まれる | Information Disclosure | A01:2021 | low | Issue #188スコープ外。セキュリティ強化の別Issueで対応（Section 14.16） |

### 13.12 Stage 4 Consider（将来検討）

| ID | タイトル | カテゴリ | 備考 |
|----|---------|---------|------|
| C-001-S4 | ウィンドウサイズ縮小によるセキュリティ防御への影響評価 | Defense-in-Depth | プロンプト最優先ロジックにより影響なし。Auto-Yes側THINKING_CHECK_LINE_COUNT=50は変更なし。防御完全維持（Section 14.17） |
| C-002-S4 | stripAnsi()のカバレッジ限界（SEC-002既知事項） | Input Sanitization (A03:2021) | detectSessionStatus()への移行でstripAnsi()影響表面が若干拡大。tmux capture-pane出力が特殊シーケンスを含む可能性は低く、リスクは低い（Section 14.17） |
| C-003-S4 | response-poller.ts L547-554の全文thinkingチェック残存（MF-001 S3関連） | Logic Vulnerability | Auto-Yes動作に間接的影響。フォローアップIssue（MF-001 S3）で対応予定（Section 14.17） |

---

## 14. レビュー指摘事項の詳細と設計反映

### 14.1 SF-001: detectPrompt()二重実行の制御されたDRY違反（許容されたトレードオフ）

**指摘内容**: `current-output/route.ts`で`detectSessionStatus()`を呼んだ後に`promptData`取得のため`detectPrompt()`を再実行する設計。`detectSessionStatus()`内部で既に`detectPrompt()`を実行しており、同じ入力に対する二重計算が発生する。

**レビュアー推奨**: `detectSessionStatus()`の戻り値にoptionalな`promptDetectionResult`を含めるか、キャッシュヘルパーを導入する。ただしSRP維持のために呼び出し元で個別取得する判断は合理的であり、トレードオフとして許容可能。

**設計判断: 現行のDR-002代替案を維持し、制御されたDRY違反として許容する**

**根拠**:
1. `detectPrompt()`の計算コストは軽微（文字列パターンマッチング、15行程度の入力）
2. `StatusDetectionResult`に`promptDetectionResult`を追加すると`status-detector.ts`が`prompt-detector.ts`の内部型に結合し、SRP違反を引き起こす
3. `worktrees/route.ts`は`promptData`を必要としないため、`StatusDetectionResult`に含めるとISP違反にもなる
4. キャッシュヘルパーの導入は複雑さを増し、KISSに反する
5. `detectPrompt()`の再実行は`thinking=false`の場合のみに限定されており、Issue #161 Layer 1防御は維持される

**実装時の注意事項**:
- `current-output/route.ts`の`detectPrompt()`再実行箇所にコメントでDRY違反の理由を明記すること
- コメント例: `// SF-001: detectPrompt() is intentionally called separately from detectSessionStatus() to obtain promptData. This controlled DRY violation maintains SRP of StatusDetectionResult (see design policy Section 14.1)`

### 14.2 SF-002: thinking検出ウィンドウサイズ定数名のリネーム

**指摘内容**: `THINKING_CHECK_LINE_COUNT`が`status-detector.ts`と`auto-yes-manager.ts`の両方に存在し、値が異なる（5 vs 50）。将来の混乱リスクがある。

**レビュアー推奨**: `status-detector.ts`の定数名を`THINKING_WINDOW_LINES`や`STATUS_THINKING_LINE_COUNT`など、`auto-yes-manager.ts`と区別可能な名称にする。

**設計判断: `status-detector.ts`の定数名を`STATUS_THINKING_LINE_COUNT`にリネームする**

**根拠**:
1. `auto-yes-manager.ts`の`THINKING_CHECK_LINE_COUNT=50`はIssue #191で設計根拠が明記されており変更不可
2. `status-detector.ts`の新規定数は本Issue #188で追加するものであり、名称変更が容易
3. `STATUS_`プレフィックスにより、ステータス検出目的の定数であることが名前から明確になる
4. grepやコード検索で`THINKING_CHECK_LINE_COUNT`を検索した際に、目的の異なる定数が混在しない

### 14.3 Stage 1 Consider項目の設計への反映

#### C-001: response-poller.ts L353のマジックナンバー5

DR-004の実装において、`response-poller.ts`の末尾5行チェックではインラインの数値リテラル`5`を使用する。YAGNIの観点から現時点では定数化しないが、将来`status-detector.ts`の`STATUS_THINKING_LINE_COUNT`と値を揃える必要が生じた場合は、`cli-patterns.ts`への共有定数配置を検討する。

> **SF-003 (Stage 3)**: マジックナンバー5の定数化は見送るが、コメントで`STATUS_THINKING_LINE_COUNT`との関連を明記し、将来のメンテナンス時に値の不整合を防ぐ。コメント例は Section 4.2.1の修正後スニペットに反映済み。

#### C-002: 空行を含む出力でのテストシナリオ

テスト設計（セクション6.1）に空行を含むバッファのテストケースを追加する（下記セクション15のチェックリスト参照）。

#### C-003: マッピング関数の共通化

現時点ではcallerが2箇所（`worktrees/route.ts`, `current-output/route.ts`）のみのためYAGNIで許容。callerが3箇所以上に増えた場合に`StatusDetectionResult`からJSON応答フィールドへのマッピング関数を共通化することを検討する。

### 14.4 Stage 2 MF-001: Section 4.1.1の行番号精緻化

**指摘内容**: 設計書はcurrent-output/route.tsの修正前コードを「L72-94」として記載。スニペット内容は実装と正確に一致するが、行番号の範囲が広く、各行がどの機能に対応するかが不明確。

**対応**: Section 4.1.1に行番号の詳細マッピングを追記:
- L72-74: 非空行フィルタリング+ウィンドウ取得
- L76-77: stripAnsiによるクリーン出力生成
- L79-83: thinkingインジケータ検出
- L85-90: プロンプト検出
- L92-94: isPromptWaiting導出

### 14.5 Stage 2 SF-001: Section 4.1.2の行番号精緻化

**指摘内容**: 設計書はstatus-detector.tsの修正対象を「L82-107」として記載。実装を確認すると`detectSessionStatus()`関数はL75-143で、修正対象行はL83（lastLines生成）とL100（detectThinking呼び出し）の2行のみ。

**対応**: Section 4.1.2の行番号表記を更新。「L82-107」を修正し、L83とL100を個別に示すように変更。関数全体の範囲（L75-143）も明記。

### 14.6 Stage 2 SF-002: Section 4.2.1の行番号精緻化

**指摘内容**: 設計書はresponse-poller.tsの修正対象を「L351-359」として記載。実装ではL351はコメント行、対象コードブロックはL351-358（L359ではなくL358が閉じ括弧）。

**対応**: Section 4.2.1の行番号を「L351-358」に修正。修正前スニペットにコメント行も含め、実コードとの一致を強化。

### 14.7 Stage 2 SF-003: Section 2.1フロー図の精緻化

**指摘内容**: 修正前のcurrent-output/route.tsフローで「非空行15行取得」と記載されているが、実装ではstripAnsi個別適用+非空行フィルタリングの2段階処理（L73: `lines.map(l => stripAnsi(l)).filter(line => line.trim() !== '')`）。

**対応**: Section 2.1のフロー図を更新し、stripAnsi+非空行フィルタの2段階処理を明記。修正後はdetectSessionStatus()による全行ベースウィンドウに統一されるため、この差異が解消される旨の注釈を追加。

### 14.8 Stage 2 SF-004: detectPrompt()入力差異の文書化

**指摘内容**: DR-002代替案では`detectPrompt(cleanOutput, promptOptions)`（全文渡し）と記載されているが、`detectSessionStatus()`内部では`detectPrompt(lastLines, promptOptions)`（15行ウィンドウ）を使用。入力の差異について設計書に明確な説明がない。

**対応**: Section 3.1 DR-002代替案の採用判断直後にSF-004注釈を追加。以下を明記:
1. 入力差異は意図的であること
2. `detectPrompt()`内部の50行ウィンドウにより実用上の差異はないこと
3. `isPromptWaiting`のsource of truthは`statusResult.hasActivePrompt`であり、個別`detectPrompt()`の`isPrompt`ではないこと
4. 個別`detectPrompt()`は`promptData`取得が目的であること

### 14.9 Stage 2 Consider項目の設計への反映

#### C-001 (S2): response-poller.ts checkForResponse()内L547-554の全文thinkingチェック

設計書がP1で言及する「6箇所のthinking検出の不統一」のうち、`checkForResponse()`内L547-554の`thinkingPattern.test(cleanOutput)`は、pending promptのanswered処理を目的としたチェックであり、`extractResponse()`内L353のレスポンス品質チェックとは異なる。本Issueの修正スコープ（ステータス表示の誤り）に直接影響しないため、修正対象外とする。将来Issueとして、全箇所のthinkingチェックの目的別分類と統一戦略を検討する際に再評価する。

> **MF-001 (Stage 3)**: Stage 3の影響分析レビューにより、C-001 (S2)がMust Fixに昇格。L547-554の全文thinkingチェックはP0の根本原因と同じ脆弱性を持ち、スクロールバックのthinkingサマリーによりpending promptが誤ってanswered処理されるリスクがある。詳細はSection 14.10を参照。

#### C-002 (S2): Issue #180設計との整合性

Section 11の関連Issue整合性表にIssue #180のウィンドウ構造変更に関する注釈を追記済み。Issue #188の修正は`detectSessionStatus()`の内部実装を変更（15行一本 -> 15行+5行分離）するものであり、関数のインターフェース（引数・戻り値）は変更しない。

#### C-003 (S2): Section 5.1の優先順位表現修正

Section 5.1の「thinking優先 = プロンプト未検出時のみ」という表現を「プロンプト最優先: L85-96でプロンプト検出、L98-107でthinking検出。プロンプト未検出時のみthinkingが有効」に修正済み。Section 2.2のフロー図とも整合する表現に統一。

### 14.10 Stage 3 MF-001: checkForResponse() L547-554の全文thinkingチェック回帰リスク

**指摘内容**: `checkForResponse()`内L547-554の`thinkingPattern.test(cleanOutput)`は、P0の根本原因と同じ全文thinkingチェックの脆弱性を持つ。設計書はC-001 (S2)で明示的にスコープ外としているが、スクロールバックにthinkingサマリーが残存する場合、pending promptが誤ってanswered処理されるリスクがある。

**レビュアー推奨**: 既知の制限事項をコメントで明示し、フォローアップIssueを作成する。あるいは、本Issue内でP2修正として同じ5行末尾チェックを適用する。

**設計判断: フォローアップIssue作成 + 本Issue実装時に既知制限コメントを追加する（オプションA）**

**根拠**:
1. L547-554はpending promptのanswered処理を目的としており、ステータス表示の修正（本Issueのスコープ）とは異なるコードパス
2. ウィンドウ化がanswered判定の正確性に影響を与えないことを個別検証する必要がある
3. 本Issueの変更範囲を3ファイルに限定し、回帰リスクを最小化する
4. コメントにより、将来の開発者が脆弱性を認識できる

**実装時の注意事項**:
- `response-poller.ts` L547-554の`thinkingPattern.test(cleanOutput)`の直前に以下のコメントを追加:
  ```typescript
  // KNOWN LIMITATION (Issue #188 MF-001 Stage 3): This full-text thinking check
  // may falsely match completed thinking summaries in scrollback, causing pending
  // prompts to be incorrectly marked as answered. A follow-up Issue should apply
  // the same tail-line windowing as DR-004 (extractResponse L353).
  ```
- 本Issue完了後にフォローアップIssueを作成し、L547-554のウィンドウ化を実施

### 14.11 Stage 3 SF-001: クライアントサイドthinking field遷移の影響

**指摘内容**: `WorktreeDetailRefactored.tsx`は`data.thinking`をcurrent-output APIから読み取り、`setTerminalThinking()`にマッピングする。新しいthinking導出ロジック（`statusResult.status === 'running' && statusResult.reason === 'thinking_indicator'`）は、以前の`detectThinkingState()`による非空行15行チェックから、`detectSessionStatus()`による全行5行チェックに変更される。これによりthinking=true/false遷移のタイミングが変わる可能性がある。

**レビュアー推奨**: 統合テストシナリオを追加し、JSON応答のthinkingフィールドが期待値と一致することを検証する。

**設計判断: テスト設計に3つのthinking field遷移シナリオを追加する**

**対応**: Section 6.1の`tests/integration/current-output-thinking.test.ts`テーブルに以下のテストケースを追加:
1. アクティブthinkingが末尾5行内にある場合 -> `thinking: true`
2. thinkingサマリーが5行外かつプロンプト有の場合 -> `thinking: false`, `isPromptWaiting: true`
3. thinkingサマリーが5行外かつプロンプト無の場合 -> `thinking: false`

これにより、クライアントサイドの`setTerminalThinking()`が正しい値を受け取ることを保証する。

### 14.12 Stage 3 SF-002: 非空行フィルタリング除去による有効ウィンドウ変更

**指摘内容**: 現行実装は空行をフィルタリングしてから末尾15行を取得するため、実質的に大きなウィンドウをカバーしている。修正後は全行ベースの15行ウィンドウに変わるため、空行パディングが多いtmuxバッファでは有効可視コンテンツが減少し、プロンプト検出が失敗するリスクがある。

**レビュアー推奨**: C-002テストケース（空行の多いバッファ）で、プロンプトが15非空行内かつ15全行外となる境界ケースをカバーする。

**設計判断: status-detector.test.tsに境界ケースのテストを追加する**

**対応**: Section 6.1の`tests/unit/lib/status-detector.test.ts`テーブルに以下のテストケースを追加:
- プロンプト行が末尾から16行目（全行カウント）だが末尾から10行目（非空行カウント）に位置する場合

このテストは、非空行フィルタリング除去による動作変更を明示的に検証し、既知の動作変更として文書化する。`detectSessionStatus()`は全行ベースの15行ウィンドウを使用するため、この場合プロンプトは検出されない（これが新しい正しい動作）。ただし、`detectPrompt()`内部の50行ウィンドウでは検出されるため、`promptData`取得（DR-002代替案）には影響しない。

### 14.13 Stage 3 SF-003: response-poller.ts L353マジックナンバー5の相互参照コメント

**指摘内容**: DR-004のインラインマジックナンバー5について、設計書はC-001（Stage 1）で将来の定数化を検討と記載しているが、実装時に`STATUS_THINKING_LINE_COUNT`との関連性を示すコメントがなく、将来のメンテナンス時に値の不整合が生じるリスクがある。

**レビュアー推奨**: response-poller.ts L353のウィンドウ化コードに、`STATUS_THINKING_LINE_COUNT`への相互参照コメントを追加する。

**設計判断: DR-004修正後のコードスニペットに相互参照コメントを追加する**

**対応**: Section 4.2.1の修正後スニペットを更新し、以下のコメントを含める:
```typescript
// SF-003 (Stage 3): This tail line count (5) should track STATUS_THINKING_LINE_COUNT=5
// in status-detector.ts. If STATUS_THINKING_LINE_COUNT changes, update this value accordingly.
```

これにより、YAGNIの観点から定数化は見送りつつ、将来のメンテナンス性を確保する。

### 14.14 Stage 3 SF-004: isPromptWaiting source of truthのテスト検証

**指摘内容**: 設計書はSF-004（Stage 2）で`isPromptWaiting`のsource of truthが`statusResult.hasActivePrompt`であることを明記しているが、テスト計画に`hasActivePrompt`と`promptDetection.isPrompt`が異なる結果を返すシナリオが含まれていない。

**レビュアー推奨**: 15行ウィンドウ（`detectSessionStatus()`使用）にプロンプトが含まれないが、全文出力（個別`detectPrompt()`使用）には含まれるシナリオをテストし、`isPromptWaiting: false`を検証する。

**設計判断: 統合テストにsource of truth検証シナリオを追加する**

**対応**: Section 6.1の`tests/integration/current-output-thinking.test.ts`テーブルに以下のテストケースを追加:
- プロンプトが末尾15行ウィンドウ外かつ全文50行ウィンドウ内に存在するバッファ
- 期待結果: `isPromptWaiting: false`（`statusResult.hasActivePrompt`がsource of truth）

このテストにより、`isPromptWaiting`が`promptDetection.isPrompt`ではなく`statusResult.hasActivePrompt`から導出されていることを実証する。開発者がsource of truthを誤って変更した場合の回帰防止テストとして機能する。

### 14.15 Stage 3 Consider項目の設計への反映

#### C-001 (S3): claude-poller.tsの全文thinkingチェック脆弱性

`claude-poller.ts` L144の`thinkingPattern.test(response)`は、`response-poller.ts` L353と同じ全文thinkingチェックの脆弱性を持つ。ただし、L162/L234のTODOコメントで既にsupersededとマークされているため、deprecationの一環として別フォローアップIssueで対応する。本Issueでは修正対象外。

#### C-002 (S3): auto-yes-manager.tsとstatus-detector.tsのウィンドウサイズ差異による一時的UI不整合

同一ポーリングサイクル内で、`auto-yes-manager.ts`（50行ウィンドウ）がthinkingを検出しつつ、`status-detector.ts`（5行ウィンドウ）が検出しないケースが理論的に発生し得る。これは設計上の意図的な差異であり、以下の理由で許容する:
1. `status-detector.ts`はUI表示用（正確さ重視）
2. `auto-yes-manager.ts`はAuto-Yes誤発火防止用（安全性重視）
3. 一時的なUI不整合は次のポーリングサイクルで解消される

CLAUDE.md更新時に、Issue #188セクションでこの動作差異を明記する。

#### C-003 (S3): ロールバック戦略の文書化

本修正は3ファイルの変更で構成され、DBマイグレーションや状態フォーマット変更を含まない。問題発生時は以下の手順でロールバック可能:
1. `git revert <commit-hash>` で3ファイルの変更を取り消し
2. サーバー再起動

この情報はPR説明に記載し、Section 11の制約条件にロールバック戦略セクションを追加した。

### 14.16 Stage 4 SF-001-S4 / SF-002-S4: 既存のエラーメッセージ情報漏洩リスク（スコープ外）

**SF-001-S4: validateSessionName()のエラーメッセージにユーザー入力が含まれる**

**指摘内容**: `cli-tools/validation.ts`の`validateSessionName()`が`throw new Error(\`Invalid session name format: ${sessionName}\`)`でユーザー入力をそのまま含む。`current-output/route.ts`がこの関数の呼び出しチェーンに存在するため、`error.message`がJSON応答に含まれた場合に情報漏洩のリスクがある。Issue #193 SEC-003で他の箇所（`getAnswerInput()`）は固定メッセージに修正済みだが、この箇所が残存している。

**OWASP分類**: A01:2021 - Broken Access Control / Information Leakage

**設計判断: Issue #188のスコープ外。フォローアップIssueで対応する。**

**根拠**:
1. `validateSessionName()`は本Issue #188の修正対象ファイルに含まれない（`cli-tools/validation.ts`は変更なし）
2. Issue #193 SEC-003で確立された固定エラーメッセージパターンを適用するのは自然な流れだが、変更範囲を限定する
3. 実際のリスクはlow（セッション名はユーザー制御可能だが、DB参照キーであり外部入力が直接到達する経路は限定的）

**フォローアップ時の修正方針**:
```typescript
// 修正前
throw new Error(`Invalid session name format: ${sessionName}`);

// 修正後（Issue #193 SEC-003パターン適用）
throw new Error('Invalid session name format');
```

**SF-002-S4: current-output/route.tsの404エラーにparams.idが含まれる**

**指摘内容**: `current-output/route.ts` L33で`{ error: \`Worktree '${params.id}' not found\` }`としてparams.idをそのままJSON応答に含む。他の複数のroute.tsにも同じパターンが存在する（既知の広域課題）。

**OWASP分類**: A01:2021 - Broken Access Control

**設計判断: Issue #188のスコープ外。セキュリティ強化の別Issueで対応する。**

**根拠**:
1. 本Issue #188ではcurrent-output/route.tsのthinking/prompt判定ロジックを修正するが、エラーハンドリング部分（L33）は修正対象外
2. 同じパターンが複数のroute.tsに存在するため、一括で修正するのが効率的
3. params.idはURLパスパラメータであり、攻撃者が既に知っている値。情報漏洩のインパクトは限定的

**フォローアップ時の修正方針**:
```typescript
// 修正前
return NextResponse.json({ error: `Worktree '${params.id}' not found` }, { status: 404 });

// 修正後
return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
```

### 14.17 Stage 4 Consider項目の設計への反映

#### C-001-S4: ウィンドウサイズ縮小によるセキュリティ防御への影響評価

thinking検出ウィンドウを15行から5行に縮小する変更（DR-003）がIssue #161 Layer 1防御に与える影響を評価した結果、以下の理由でセキュリティ防御は完全に維持されている:

1. **プロンプト最優先ロジック**: `detectSessionStatus()`内でプロンプト検出（ステップ1）がthinking検出（ステップ2）より先に実行される。プロンプトがアクティブな場合、thinkingの検出結果に関係なく正しく`waiting`ステータスが返される
2. **Auto-Yes側の防御維持**: `auto-yes-manager.ts`の`THINKING_CHECK_LINE_COUNT=50`は変更されないため、Auto-Yes誤発火防止の防御は完全に維持
3. **thinkingインジケータの表示特性**: thinkingインジケータ（スピナー + アクティビティテキスト）は常にtmuxバッファの末尾に表示されるため、5行ウィンドウで十分に検出可能

#### C-002-S4: stripAnsi()のカバレッジ限界（SEC-002既知事項）

`detectSessionStatus()`内で`stripAnsi()`を一括適用するパスへの移行により、`stripAnsi()`の品質が全体のセキュリティに影響する表面が若干拡大する。ただし:

1. `stripAnsi()`のカバレッジ限界（8-bit CSI、DEC private modes等）はIssue #193 SEC-002で既に文書化済み
2. tmux `capture-pane`の出力がこれらの特殊シーケンスを含む可能性は低い
3. `stripAnsi()`は本Issue #188で修正対象ではなく、既存の品質レベルがそのまま適用される

リスクは低く、現時点で追加対策は不要。将来的に`stripAnsi()`のカバレッジ拡大が必要になった場合は、SEC-002の文書を参照して対応する。

#### C-003-S4: response-poller.ts L547-554の全文thinkingチェック残存（MF-001 S3関連）

Stage 3 MF-001で既に分析・文書化済み（Section 14.10参照）。セキュリティレビューの観点からも、以下の対応方針を再確認:

1. 本Issue #188実装時にL547-554に既知制限事項コメントを追加する
2. フォローアップIssueで末尾行ウィンドウ化を適用する
3. Auto-Yes動作への間接的影響は、フォローアップIssueのスコープで検証する

---

## 15. 実装チェックリスト

### 15.1 P0修正（必須）

- [ ] `src/lib/status-detector.ts`: thinking検出用定数を`STATUS_THINKING_LINE_COUNT = 5`として追加（SF-002対応: `THINKING_CHECK_LINE_COUNT`ではなく`STATUS_THINKING_LINE_COUNT`を使用）
- [ ] `src/lib/status-detector.ts`: `detectSessionStatus()`内でthinking検出ウィンドウを`STATUS_THINKING_LINE_COUNT`で分離（DR-003）
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: インラインthinking/prompt判定を`detectSessionStatus()`ベースに統合（DR-001）
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: `detectPrompt()`再実行箇所にSF-001トレードオフコメントを追加
- [ ] `tests/unit/lib/status-detector.test.ts`: thinking+prompt共存、ウィンドウ境界テスト作成
- [ ] `tests/integration/current-output-thinking.test.ts`: 統合テスト作成

### 15.2 P1修正

- [ ] `src/lib/response-poller.ts`: L353全文thinkingチェックを末尾5行チェックに変更（DR-004）
- [ ] `src/lib/response-poller.ts`: L353修正箇所にSTATUS_THINKING_LINE_COUNTへの相互参照コメントを追加（SF-003 S3）
- [ ] `src/lib/response-poller.ts`: L547-554に既知制限事項コメントを追加（MF-001 S3）
- [ ] `src/lib/__tests__/cli-patterns.test.ts`: detectThinking()パターンテスト追加

### 15.3 テスト追加（C-002対応）

- [ ] `tests/unit/lib/status-detector.test.ts`: 空行を多く含む出力でのthinking/prompt検出テストケースを追加
- [ ] `tests/integration/current-output-thinking.test.ts`: 空行パディングを含むtmuxバッファのシナリオを追加

### 15.4 テスト追加（Stage 3対応）

- [ ] `tests/integration/current-output-thinking.test.ts`: thinking field遷移テスト3シナリオを追加（SF-001 S3: アクティブthinking 5行内、サマリー5行外+プロンプト有、サマリー5行外+プロンプト無）
- [ ] `tests/unit/lib/status-detector.test.ts`: 空行パディング境界テスト追加（SF-002 S3: プロンプトが15全行外/15非空行内のケース）
- [ ] `tests/integration/current-output-thinking.test.ts`: isPromptWaiting source of truth検証テスト追加（SF-004 S3: 15行外/全文50行内のプロンプト -> isPromptWaiting: false）

### 15.5 Stage 2整合性レビュー対応（設計書修正）

- [x] MF-001: Section 4.1.1の行番号詳細マッピングを追記（L72-94内の各行の機能対応を明記）
- [x] SF-001 (S2): Section 4.1.2の行番号を精緻化（L82-107 -> L83, L100に限定、関数範囲L75-143を明記）
- [x] SF-002 (S2): Section 4.2.1の行番号を精緻化（L351-359 -> L351-358に修正、コメント行含むスニペットに更新）
- [x] SF-003 (S2): Section 2.1フロー図にstripAnsi+非空行フィルタの2段階処理を明記
- [x] SF-004 (S2): Section 3.1 DR-002代替案にdetectPrompt()入力差異の説明を追加（isPromptWaitingのsource of truth明記）
- [x] C-002 (S2): Section 11の関連Issue整合性表にIssue #180ウィンドウ構造変更を追記
- [x] C-003 (S2): Section 5.1のthinking/prompt優先順位表現を「プロンプト最優先」に修正

### 15.6 Stage 3影響分析レビュー対応（設計書修正）

- [x] MF-001 (S3): Section 4.3.2追加（checkForResponse() L547-554の既知制限事項とフォローアップIssue方針）
- [x] MF-001 (S3): Section 5.2にL547-554リスクと対策を追加
- [x] MF-001 (S3): Section 8.1の採用設計テーブルにL547-554フォローアップ判断を追加
- [x] MF-001 (S3): Section 9の実装順序にL547-554コメント追加ステップを追加
- [x] MF-001 (S3): Section 14.10に詳細分析と設計判断を追加
- [x] SF-001 (S3): Section 3.1 DR-001に下流影響注釈を追加
- [x] SF-001 (S3): Section 6.1にthinking field遷移テストケースを追加
- [x] SF-001 (S3): Section 10に間接影響ファイルテーブルを追加
- [x] SF-001 (S3): Section 14.11に詳細分析と設計判断を追加
- [x] SF-002 (S3): Section 4.2.2にウィンドウ変更影響の注釈を追加
- [x] SF-002 (S3): Section 6.1に空行パディング境界テストケースを追加
- [x] SF-002 (S3): Section 14.12に詳細分析と設計判断を追加
- [x] SF-003 (S3): Section 4.2.1修正後スニペットにSTATUS_THINKING_LINE_COUNT相互参照コメントを追加
- [x] SF-003 (S3): Section 14.3 C-001にSF-003 (S3)注釈を追加
- [x] SF-003 (S3): Section 14.13に詳細分析と設計判断を追加
- [x] SF-004 (S3): Section 6.1にisPromptWaiting source of truth検証テストケースを追加
- [x] SF-004 (S3): Section 14.14に詳細分析と設計判断を追加
- [x] C-001 (S3): Section 4.3.1にclaude-poller.tsフォローアップ注釈を追加
- [x] C-002 (S3): Section 3.2統一ポリシーテーブル下にウィンドウサイズ差異注釈を追加
- [x] C-002 (S3): Section 11の関連Issue整合性表にIssue #191のウィンドウサイズ差異を追記
- [x] C-003 (S3): Section 11にロールバック戦略セクションを追加

### 15.7 Stage 3影響分析レビュー対応（実装時の確認事項）

- [ ] `current-output/route.ts`修正時: `isPromptWaiting`は`statusResult.hasActivePrompt`から導出すること（SF-004）。`promptDetection.isPrompt`はpromptData取得用の副産物であり、ステータス判定に使用しないこと
- [ ] `current-output/route.ts`修正時: 個別`detectPrompt()`呼び出しで`cleanOutput`（全文）を渡す設計を維持すること。`detectSessionStatus()`内部は15行ウィンドウだが、promptData取得には全文が必要（SF-004）
- [ ] `response-poller.ts`修正時: L351-358の範囲を確認し、コメント行（L351）も含めて修正すること（SF-002 (S2)）
- [ ] `response-poller.ts`修正時: L353のマジックナンバー5にSTATUS_THINKING_LINE_COUNTへの相互参照コメントを追加すること（SF-003 S3）
- [ ] `response-poller.ts`修正時: L547-554に既知制限事項コメント（MF-001 S3テンプレート）を追加すること
- [ ] `response-poller.ts` checkForResponse()内L547-554の全文thinkingチェック: 本Issue修正スコープ外であることを確認（C-001 (S2)、pending prompt用途のため変更不要。MF-001 (S3)でフォローアップIssue作成予定）
- [ ] 本Issue完了後: L547-554ウィンドウ化のフォローアップIssueを作成すること（MF-001 S3）
- [ ] CLAUDE.md更新時: Issue #188セクションにstatus-detector.tsとauto-yes-manager.tsのウィンドウサイズ差異を記載すること（C-002 S3）
- [ ] PR作成時: ロールバック手順（3ファイルgit revert、サーバー再起動）を記載すること（C-003 S3）

### 15.8 Stage 4セキュリティレビュー対応（設計書修正）

- [x] SF-001-S4: Section 14.16にvalidateSessionName()情報漏洩リスクの分析とフォローアップ方針を追加
- [x] SF-002-S4: Section 14.16にcurrent-output/route.ts 404エラー情報漏洩リスクの分析とフォローアップ方針を追加
- [x] C-001-S4: Section 14.17にウィンドウサイズ縮小のセキュリティ防御影響評価を追加
- [x] C-002-S4: Section 14.17にstripAnsi()カバレッジ限界の影響評価を追加
- [x] C-003-S4: Section 14.17にL547-554全文thinkingチェック残存のセキュリティ観点評価を追加
- [x] Section 5.3にOWASP Top 10チェックリスト結果を追加
- [x] Section 5.4にセキュリティ防御維持確認テーブルを追加
- [x] Section 5.5に既存セキュリティ課題（スコープ外）テーブルを追加
- [x] Section 12のレビュー履歴テーブルにStage 4を追加
- [x] Section 13.10-13.12にStage 4 findings summaryを追加

### 15.9 Stage 4セキュリティレビュー対応（実装時の確認事項）

- [ ] 本Issue完了後: `validateSessionName()`の固定エラーメッセージ化フォローアップIssue作成を検討すること（SF-001-S4）
- [ ] 本Issue完了後: route.ts群の404エラーメッセージからparams.id除去のフォローアップIssue作成を検討すること（SF-002-S4）

### 15.10 コード品質

- [ ] ESLint: `npm run lint` 通過
- [ ] TypeScript: `npx tsc --noEmit` 通過
- [ ] Unit Test: `npm run test:unit` 通過
- [ ] CLAUDE.md更新（完了後）

---

*Generated by design-policy command for Issue #188*
*Updated by apply-review-agent for Stage 1 review findings (2026-02-09)*
*Updated by apply-review-agent for Stage 2 consistency review findings (2026-02-09)*
*Updated by apply-review-agent for Stage 3 impact analysis review findings (2026-02-09)*
*Updated by apply-review-agent for Stage 4 security review findings (2026-02-09)*
