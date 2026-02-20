# Architecture Review: Issue #326 Impact Analysis (Stage 3)

## Executive Summary

Issue #326の設計方針書について、影響範囲(Impact Scope)の観点でレビューを実施した。設計書の影響範囲セクション(7節)は主要な変更対象と影響なしモジュールを適切に列挙しているが、部分レスポンスパスのスコープ外明記、assistant-response-saver.tsへの間接影響、Codex/Geminiへの波及明示について改善の余地がある。

**Status**: conditionally_approved
**Score**: 4/5

---

## 1. Review Focus: Impact Scope Analysis

### 1-1. 設計書影響範囲セクション(7節)の網羅性

設計書セクション7は以下の3区分で影響範囲を整理している。

| 区分 | 記載件数 | 評価 |
|------|---------|------|
| 7-1. 直接変更ファイル | 1件 (response-poller.ts) | 正確 |
| 7-2. 新規ファイル | 1件 (テストファイル) | 正確 |
| 7-3. 影響なし(確認済み) | 6件 | おおむね正確、一部不足あり |

### 1-2. 直接変更ファイルの検証

`src/lib/response-poller.ts`が唯一の直接変更対象であることを実コードで確認した。

**検証結果**: `extractResponse()`は非export関数であり、唯一の呼び出し元は同ファイル内の`checkForResponse()`である。新規追加される`resolveExtractionStartIndex()`は`@internal` exportだが、テスト専用であり他モジュールからの依存は発生しない。

```typescript
// response-poller.ts L274: extractResponseは非export
function extractResponse(
  output: string,
  lastCapturedLine: number,
  cliToolId: CLIToolType
): ExtractionResult | null {
```

**結論**: 直接変更ファイルの特定は正確。

---

## 2. resolveExtractionStartIndex()抽出の既存動作への影響

### 2-1. Claude早期プロンプト検出パス(箇所1: L326-341)

**現状**: バッファ全体を`stripAnsi(fullOutput)`として返却。
**修正後**: `resolveExtractionStartIndex()`でstartIndexを決定し、`lines.slice(startIndex)`で切り出し。

**Codex/Geminiへの影響**: 箇所1は`if (cliToolId === 'claude')`ブロック内に位置するため、Codex/Geminiには到達しない。設計書Stage 2 MF-001で正しく分析されている。

### 2-2. フォールバックプロンプト検出パス(箇所2: L487-499)

**現状**: `cliToolId`を問わずフォールバックとして到達可能。`fullOutput`をそのまま返却(stripAnsiなし)。
**修正後**: `resolveExtractionStartIndex()`でstartIndex決定、`stripAnsi`追加。

**Codex/Geminiへの影響**: 箇所2はすべてのcliToolIdで到達可能。ただし実際にこのパスに到達するのは、L357の完了条件(`isCodexOrGeminiComplete || isClaudeComplete`)が偽かつプロンプトが検出された場合のみ。Codex/Geminiの場合、`hasPrompt && !isThinking`が偽(プロンプトパターン未検出)のときにフォールバックに到達する。この場合でもstartIndex決定ロジックは正しく動作する。

### 2-3. 通常レスポンス抽出パス(L357-386)のリファクタリング

**検証**: L364-386の4分岐ロジックを`resolveExtractionStartIndex()`に置換する設計。このブロックは`isCodexOrGeminiComplete || isClaudeComplete`条件下にあるため、Claude/Codex/Gemini全てで使用される。

```typescript
// L354-356: すべてのcliToolIdで到達可能
const isCodexOrGeminiComplete = (cliToolId === 'codex' || cliToolId === 'gemini') && hasPrompt && !isThinking;
const isClaudeComplete = cliToolId === 'claude' && hasPrompt && hasSeparator && !isThinking;

if (isCodexOrGeminiComplete || isClaudeComplete) {
  // L364-386: startIndex決定ロジック - リファクタリング対象
```

**結論**: リファクタリングはCodex/Geminiにも影響するが、ロジック自体は同一のため動作変更なし。

---

## 3. 通常レスポンスパスのリファクタリングの安全性

### 3-1. 4分岐ロジックの完全性

設計書セクション3-2の4分岐テーブルと実コードL364-386を比較した。

| 分岐 | 設計書 | 実コード(L364-386) | 一致 |
|------|-------|-------------------|------|
| bufferWasReset | findRecentUserPromptIndex(40) + 1 or 0 | `findRecentUserPromptIndex(40)` -> foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0 | Yes |
| codex | Math.max(0, lastCapturedLine) | `Math.max(0, lastCapturedLine)` | Yes |
| lastCapturedLine >= totalLines - 5 | findRecentUserPromptIndex(50) + 1 or totalLines - 40 | `findRecentUserPromptIndex(50)` -> foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40) | Yes |
| 通常 | Math.max(0, lastCapturedLine) | `Math.max(0, lastCapturedLine)` | Yes |

**結論**: 4分岐ロジックの抽出は実コードと完全に一致している。

### 3-2. 部分レスポンスパス(L501-533)との区別

実コードL504-508には別のstartIndex決定ロジックが存在する。

```typescript
// L501-508: 部分レスポンスパス - 4分岐とは異なるロジック
const partialBufferReset = bufferReset || lastCapturedLine >= endIndex - 5;
const recentPromptIndex = partialBufferReset ? findRecentUserPromptIndex(80) : -1;
const startIndex = partialBufferReset
  ? (recentPromptIndex >= 0 ? recentPromptIndex + 1 : Math.max(0, endIndex - 80))
  : Math.max(0, lastCapturedLine);
```

このロジックは:
- `partialBufferReset`の閾値が異なる(`endIndex - 5` vs `totalLines - 5`)
- `findRecentUserPromptIndex`のwindowSizeが80(4分岐では40/50)
- フォールバック値が`endIndex - 80`(4分岐では`totalLines - 40`)

**これはresolveExtractionStartIndex()の対象外であり、リファクタリングスコープ外である。**

---

## 4. checkForResponse()の後続処理への影響

### 4-1. promptDetection再検出パス(L605)

設計書セクション4-1の分析を検証した。

```typescript
// L605: result.responseは修正後lastCapturedLine以降の部分出力
const promptDetection = detectPromptWithOptions(result.response, cliToolId);
```

プロンプトの質問文+選択肢はtmuxバッファ末尾に位置するため、`lastCapturedLine`以降に含まれる。`detectPromptWithOptions`内部では`detectPrompt`が末尾50行のスキャンウィンドウを使用しており、部分出力でも検出精度は維持される。

**検証結果**: 設計書の分析は正確。

### 4-2. rawContentへの影響(L614-615)

```typescript
// L614-615: promptDetection.rawContent || promptDetection.cleanContent
content: promptDetection.rawContent || promptDetection.cleanContent,
```

修正後、`detectPromptWithOptions`への入力が部分出力となるため、`rawContent`(prompt-detector.ts L583の`truncateRawContent(output.trim())`)も部分出力の範囲に限定される。

設計書セクション4-2の分析「前の会話の混入を除去することは#235の意図に反しない」は正当。Issue #235の「完全なプロンプト出力」は「現在のインタラクションの出力」と解釈すべきであり、前回会話の混入はそもそも不要データ。

### 4-3. normalレスポンスパスへの影響(L641-646)

設計書セクション4では明示的に記載されていないが、`promptDetection.isPrompt === false`の場合、`result.response`は`cleanClaudeResponse()`または`cleanGeminiResponse()`に渡される。

```typescript
// L641-646
let cleanedResponse = result.response;
if (cliToolId === 'gemini') {
  cleanedResponse = cleanGeminiResponse(result.response);
} else if (cliToolId === 'claude') {
  cleanedResponse = cleanClaudeResponse(result.response);
}
```

`cleanClaudeResponse()`は内部で「最後のユーザープロンプト以降を抽出」するロジック(L149-156)を持つ。修正後は入力がlastCapturedLine以降に限定されるため、最後のユーザープロンプトがその範囲内に含まれていれば正しく動作する。含まれていない場合は`lastUserPromptIndex = -1`となり`startIndex = 0`(入力全体)が使用される。いずれの場合も既存動作と同等以上の品質。

**結論**: normalレスポンスパスへの影響は品質向上方向であり、リスクは低い。

---

## 5. テストカバレッジの影響範囲カバー評価

### 5-1. ユニットテスト(セクション6-2)

8テストケースは`resolveExtractionStartIndex()`の4分岐ロジックを網羅している。

| テストケース | カバー分岐 | 評価 |
|------------|-----------|------|
| #1 通常ケース | 通常分岐 | OK |
| #2 バッファリセット(プロンプトあり) | bufferWasReset + findRecentUserPromptIndex >= 0 | OK |
| #3 バッファリセット(プロンプトなし) | bufferWasReset + findRecentUserPromptIndex = -1 | OK |
| #4 Codex通常ケース | codex分岐 | OK |
| #5 バッファスクロール境界(プロンプトあり) | lastCapturedLine >= totalLines - 5 + found | OK |
| #6 バッファスクロール境界(プロンプトなし) | lastCapturedLine >= totalLines - 5 + not found | OK |
| #7 Codex lastCapturedLine=0 | Math.max(0, ...)ガード | OK |
| #8 通常 lastCapturedLine=0 | Math.max(0, ...)ガード | OK |

### 5-2. テストカバレッジの不足事項

| 不足項目 | 重要度 | 備考 |
|---------|-------|------|
| Codex/Geminiでのフォールバックプロンプト検出(箇所2)の結合テスト | 推奨 | 箇所2はcliToolIdを問わず到達可能 |
| 部分レスポンスパスがresolveExtractionStartIndex()を使用しないことの確認 | 低 | リファクタリングスコープ外の保証 |
| normalレスポンスパスでのcleanClaudeResponse入力変更の結合テスト | 推奨 | 品質向上方向だが動作確認が望ましい |

---

## 6. 後方互換性(外部APIの変更有無)

### 6-1. export関数の変更

`response-poller.ts`のexport関数を確認した。

| export関数 | 変更 | 影響 |
|-----------|------|------|
| `cleanClaudeResponse()` | なし | - |
| `cleanGeminiResponse()` | なし | - |
| `startPolling()` | なし | - |
| `stopPolling()` | なし | - |
| `stopAllPolling()` | なし | - |
| `getActivePollers()` | なし | - |
| `resolveExtractionStartIndex()` | **新規追加(@internal)** | テスト専用、外部依存なし |

**結論**: 既存のexport APIに変更なし。新規追加は`@internal` exportのみ。完全な後方互換性。

### 6-2. 外部モジュールからの依存関係

| 依存元 | import対象 | 影響 |
|-------|-----------|------|
| `src/lib/assistant-response-saver.ts` | cleanClaudeResponse, cleanGeminiResponse | APIシグネチャ変更なし |
| `src/lib/session-cleanup.ts` | stopPolling | 変更なし |
| `src/lib/cli-tools/manager.ts` | stopPolling | 変更なし |
| `src/app/api/worktrees/[id]/send/route.ts` | startPolling | 変更なし |
| `src/app/api/worktrees/[id]/start-polling/route.ts` | startPolling | 変更なし |
| `src/app/api/worktrees/[id]/respond/route.ts` | startPolling | 変更なし |

**結論**: 外部APIの変更なし。DBマイグレーション不要。

---

## 7. Affected Files Analysis

| Category | File | Change/Impact | Risk |
|----------|------|--------------|------|
| Direct | `src/lib/response-poller.ts` | resolveExtractionStartIndex()追加、箇所1/2修正、通常レスポンスパスリファクタリング | Medium |
| Direct | `tests/unit/lib/resolve-extraction-start-index.test.ts` | 新規テストファイル | None |
| Indirect | `src/lib/response-poller.ts` (checkForResponse) | result.response内容変更 -> promptDetection再検出、cleanClaudeResponse入力変更 | Low |
| Indirect | `src/lib/assistant-response-saver.ts` | sessionState.lastCapturedLine更新タイミングの間接影響 | Low |
| No Impact | `src/lib/auto-yes-manager.ts` | 独自にtmuxバッファ取得、extractResponse経由しない | None |
| No Impact | `src/lib/session-cleanup.ts` | stopPollingのみimport | None |
| No Impact | `src/lib/prompt-detector.ts` | API変更なし | None |
| No Impact | `src/lib/cli-patterns.ts` | API変更なし | None |
| No Impact | `src/lib/status-detector.ts` | response-pollerと依存関係なし | None |
| No Impact | API routes (send/respond/start-polling) | startPollingのみimport、シグネチャ変更なし | None |

---

## 8. Risk Assessment

| Risk Type | Level | Description | Mitigation |
|-----------|-------|-------------|------------|
| Technical | Low | 4分岐ロジックの関数抽出は純粋なリファクタリング。箇所1/2の修正はデータフィルタリング範囲の変更のみ | ユニットテスト8ケース + 推奨の結合テスト |
| Security | Low | stripAnsi追加(箇所2)はANSIエスケープのDB保存防止で品質向上 | 既存のstripAnsi適用パターンと一致 |
| Operational | Low | DBマイグレーション不要、外部API変更なし、デプロイ特別手順不要 | - |

---

## 9. Improvement Recommendations

### 9-1. Must Fix (1 item)

**MF-001: 部分レスポンスパス(L501-533)のスコープ外明記**

セクション7に以下を追加すべき:

```markdown
### 7-4. スコープ外(意図的に対象外)

| 箇所 | 理由 |
|------|------|
| 部分レスポンスパス(L501-533)のstartIndex決定ロジック | 4分岐ロジックとは異なるpartialBufferReset判定・windowSize=80を使用しており、resolveExtractionStartIndex()の対象外。Stage 2 C-003で検討事項として記録済み。 |
```

### 9-2. Should Fix (3 items)

**SF-001: assistant-response-saver.tsへの間接影響の記載**

セクション7-3のassistant-response-saver.tsの記載を以下に修正:

```
- `src/lib/assistant-response-saver.ts` - cleanClaudeResponse/cleanGeminiResponseのみimport（APIシグネチャ変更なし）。
  ただしsavePendingAssistantResponse()はsessionState.lastCapturedLineを参照するため、
  checkForResponse()のupdateSessionState呼び出しタイミングが変わらないことを確認済み。
```

**SF-002: checkForResponse内normalレスポンスパスへの影響記載**

セクション4に4-4を追加:

```markdown
### 4-4. normalレスポンスパスへの影響

修正後、result.responseがlastCapturedLine以降に限定されるため、
cleanClaudeResponse()(L645)への入力も限定される。
cleanClaudeResponse()内部の「最後のユーザープロンプト以降抽出」ロジックは
入力範囲が狭まっても正しく動作する（ユーザープロンプト未検出時はstartIndex=0で入力全体を使用）。
結果としてcleanedResponseの品質は同等以上。
```

**SF-003: Codex/Geminiへの波及明示**

セクション7-1の変更内容欄を以下に修正:

```
| `src/lib/response-poller.ts` | resolveExtractionStartIndex()追加、箇所1/箇所2修正、
通常レスポンスパスリファクタリング（Claude/Codex/Gemini全completionパスに影響） |
```

### 9-3. Consider (3 items)

**C-001**: auto-yes-manager.tsとの二重プロンプト検出の整合性を運用上の留意事項として認識する。

**C-002**: Codex/Geminiでのフォールバックプロンプト検出パスの結合テスト追加を検討する。

**C-003**: extractResponse()の返却値lineCountフィールドが変更されない旨を設計書に明記することを検討する。

---

## 10. Approval Status

**Status: conditionally_approved**

設計書の影響範囲分析はおおむね正確であり、主要な変更対象の特定、外部APIの不変性確認、影響なしモジュールの列挙は適切である。ただし以下の条件を満たすことを推奨する。

1. **MF-001**: 部分レスポンスパスのスコープ外を影響範囲セクション(7節)に明記する
2. **SF-001/SF-002/SF-003**: 間接影響の記載を補強する（実装に影響はないが、設計書の網羅性のため）

これらは設計の本質的な問題ではなく、影響範囲ドキュメントの完全性に関する指摘である。実装の安全性は確認済み。

---

*Reviewed by: Architecture Review Agent (Stage 3: Impact Analysis)*
*Date: 2026-02-20*
*Design doc: dev-reports/design/issue-326-prompt-response-extraction-design-policy.md*
