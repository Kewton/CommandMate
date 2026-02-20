# Architecture Review: Issue #326 - Stage 2 整合性レビュー

## Executive Summary

Issue #326の設計方針書（`issue-326-prompt-response-extraction-design-policy.md`）を、実装対象コードベース（`src/lib/response-poller.ts`）との整合性観点でレビューした。

**結論**: 設計方針書はコードベースとの整合性が高く、**conditionally_approved**（スコア4/5）と評価する。Stage 1レビュー指摘事項が適切に反映されており、4分岐ロジック・ヘルパー関数シグネチャ・Issue #235との整合性はいずれも正確に記述されている。ただし、いくつかの細部で実コードとの微小な差異・補足不足が確認されたため、条件付き承認とする。

---

## Review Context

| 項目 | 内容 |
|------|------|
| Issue | #326 |
| Stage | 2（整合性レビュー） |
| 設計書 | `dev-reports/design/issue-326-prompt-response-extraction-design-policy.md` |
| 対象コード | `src/lib/response-poller.ts` |
| 関連コード | `src/lib/prompt-detector.ts`, `src/lib/cli-tools/types.ts` |

---

## Detailed Findings

### 1. resolveExtractionStartIndex() シグネチャの整合性

設計書セクション3-3で定義されたシグネチャ:

```typescript
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number
): number
```

実コードの4分岐ロジック（`src/lib/response-poller.ts` 行364-386）が必要とする入力:
- `lastCapturedLine`: 行364の`let startIndex`決定に使用
- `totalLines`: 行368の`bufferWasReset`計算と行377の境界判定に使用
- `bufferReset`: 行368の`bufferWasReset`計算に使用
- `cliToolId`: 行374のCodex分岐に使用
- `findRecentUserPromptIndex`: 行372, 行380のユーザープロンプト検索に使用

**判定**: 全5引数が実コードの必要入力と一致。`CLIToolType`型は`src/lib/cli-tools/types.ts`行16の`typeof CLI_TOOL_IDS[number]`（= `'claude' | 'codex' | 'gemini'`）であり、型定義も整合。

### 2. 4分岐ロジックの整合性

| # | 条件 | 設計書（セクション3-2） | 実コード（行368-386） | 整合性 |
|---|------|------------------------|----------------------|--------|
| 1 | bufferWasReset | `findRecentUserPromptIndex(40) + 1 or 0` | `foundUserPrompt >= 0 ? foundUserPrompt + 1 : 0`（行372-373） | 一致 |
| 2 | codex | `lastCapturedLine` | `Math.max(0, lastCapturedLine)`（行376） | **差異あり**: Math.max(0, ...)が設計書で省略 |
| 3 | lastCapturedLine >= totalLines - 5 | `findRecentUserPromptIndex(50) + 1 or totalLines - 40` | `foundUserPrompt >= 0 ? foundUserPrompt + 1 : Math.max(0, totalLines - 40)`（行380-382） | **差異あり**: Math.max(0, ...)が設計書で省略 |
| 4 | 通常 | `lastCapturedLine` | `Math.max(0, lastCapturedLine)`（行385） | **差異あり**: Math.max(0, ...)が設計書で省略 |

**判定**: 条件分岐の構造と分岐順序は完全に一致。windowSize値（40, 50）も一致。ただし実コードの`Math.max(0, ...)`ガードが設計書の4分岐テーブルに反映されていない点はSF-001として指摘。

### 3. 箇所1・箇所2のコードスニペット整合性

#### 箇所1: Claude早期プロンプト検出

設計書の「現状」コード（セクション3-4）と実コード（行326-341）を比較:

```typescript
// 設計書: 行326-341
if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
    if (promptDetection.isPrompt) {
      return {
        response: stripAnsi(fullOutput),  // <- 設計書記載
        isComplete: true,
        lineCount: totalLines,
      };
    }
}
```

```typescript
// 実コード: 行328-341
if (cliToolId === 'claude') {
    const fullOutput = lines.join('\n');
    const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
    if (promptDetection.isPrompt) {
      return {
        response: stripAnsi(fullOutput),  // <- 実コード（一致）
        isComplete: true,
        lineCount: totalLines,
      };
    }
}
```

**判定**: 完全一致。

#### 箇所2: フォールバックプロンプト検出

設計書の「現状」コード（セクション3-4）と実コード（行489-499）を比較:

```typescript
// 設計書: 行487-499
const fullOutput = lines.join('\n');
const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
if (promptDetection.isPrompt) {
    return {
      response: fullOutput,  // <- stripAnsiなし（設計書記載通り）
      isComplete: true,
      lineCount: totalLines,
    };
}
```

```typescript
// 実コード: 行489-499
const fullOutput = lines.join('\n');
const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
if (promptDetection.isPrompt) {
    return {
      response: fullOutput,  // <- stripAnsiなし（実コード一致）
      isComplete: true,
      lineCount: totalLines,
    };
}
```

**判定**: 完全一致。箇所1（stripAnsiあり）と箇所2（stripAnsiなし）の非対称性も設計書が正確に指摘している。

### 4. テストケース6件の妥当性

| # | テストケース | 対応する実コード分岐 | 妥当性 |
|---|------------|---------------------|--------|
| 1 | 通常ケース（claude, lastCapturedLine=50, totalLines=100） | 行384-385: 通常分岐 | 妥当。期待値50は実コードのMath.max(0, 50)=50と一致。 |
| 2 | bufferReset+prompt有（lastCapturedLine=200, totalLines=80） | 行370-373: bufferWasReset分岐 | 妥当。ただしbufferReset=trueは冗長（200>=80で既にtrue）。 |
| 3 | bufferReset+prompt無（findRecentUserPromptIndex->-1） | 行370-373: bufferWasReset分岐のelse | 妥当。startIndex=0は-1 >= 0のfalse分岐で正確。 |
| 4 | Codex通常（lastCapturedLine=50, totalLines=100） | 行374-376: Codex分岐 | 妥当。期待値50は実コードのMath.max(0, 50)=50と一致。 |
| 5 | スクロール境界+prompt有（lastCapturedLine=96, totalLines=100） | 行377-382: スクロール境界分岐 | 妥当。96 >= 100-5=95でtrue。期待値86=85+1と一致。 |
| 6 | スクロール境界+prompt無（findRecentUserPromptIndex->-1） | 行377-382: スクロール境界のelse | 妥当。期待値60=Math.max(0, 100-40)=60と一致。 |

**判定**: 6テストケースは4分岐の主要パスを網羅。ただし以下の補足事項あり:
- テストケース#2のbufferReset=trueは冗長（C-002）
- Math.max(0, ...)ガードの境界値テスト（lastCapturedLine=0や負値）が未カバー（SF-001）

### 5. 設計書内の相互参照整合性

| 参照元 | 参照先 | 整合性 |
|--------|--------|--------|
| セクション9 SRP欄 -> MF-001 | セクション3-3-1 | 一致。「bufferWasResetの再計算もstartIndex決定に不可欠な前提条件」 |
| セクション9 KISS欄 -> SF-001 | セクション3-3-2 | 一致。「コールバック引数パターンは間接的」 |
| セクション9 YAGNI欄 -> SF-003 | セクション3-4 箇所2注意 | 一致。「YAGNI例外として意識的に含める」 |
| セクション10-1 MF-001 -> セクション3-3-1 | セクション3-3-1 | 一致。対応内容の記述が正確。 |
| セクション10-2 SF-001 -> セクション3-3-2 | セクション3-3-2 | 一致。トレードオフ比較表の追加を確認。 |
| セクション10-2 SF-002 -> セクション3-4冒頭 | セクション3-4冒頭注記 | 一致。行番号スナップショット注記が追加されている。 |
| セクション10-2 SF-003 -> セクション9 YAGNI欄 | セクション9 YAGNI欄 | 一致。YAGNI例外の補記を確認。 |
| セクション11 実装チェックリスト | 各セクション | 一致。全チェック項目が対応セクションを正しく参照。 |

**判定**: 全相互参照が整合。矛盾なし。

### 6. Issue #235（rawContent設計）との整合性

設計書セクション4-2の分析内容を実コードと照合:

- `prompt-detector.ts` 行583: `rawContent: truncateRawContent(output.trim())` -- 設計書の「rawContentはoutput引数全体をtruncateして保存」という記述と一致。
- `response-poller.ts` 行614-615: `content: promptDetection.rawContent || promptDetection.cleanContent` -- 設計書セクション4-2の「rawContent優先DB保存」パターンと一致。
- `PromptDetectionResult` インターフェース（`prompt-detector.ts` 行40-55）の`rawContent?: string`フィールド -- 設計書の参照と一致。

修正後、`detectPromptWithOptions()`への入力が`extractedLines.join('\n')`（部分出力）に変わるため、`rawContent`も部分出力に基づく値になる。設計書の「前の会話の混入除去は品質向上であり#235の意図に反しない」という分析は合理的であり、実コードの動作変更と整合している。

**判定**: 正確。Issue #235の設計意図との関係性の分析が適切。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | Math.max(0, ...)ガードが設計書テーブルに反映されていないことによる実装時の見落とし | Low | Low | P3 |
| 技術的リスク | 部分レスポンスパス（行501-533）のstartIndexロジックがスコープ外であることの未記載 | Low | Low | P3 |
| セキュリティ | なし | - | - | - |
| 運用リスク | なし | - | - | - |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix) - 1件

**MF-001**: 箇所1のコンテキストでCodex分岐が到達不能であることへの言及追加。

設計書セクション3-4の箇所1は`if (cliToolId === 'claude')`ブロック内で`resolveExtractionStartIndex()`を呼び出すため、関数内部のCodex分岐は到達しない。関数の汎用性を維持するために`cliToolId`を引数として渡す設計は正しいが、この点を設計書に明記すべき。

### 推奨改善項目 (Should Fix) - 4件

**SF-001**: 4分岐テーブルにおけるMath.max(0, ...)ガードの反映。実コード行376, 382, 385で使用されている`Math.max(0, ...)`を設計書テーブルに追加。

**SF-002**: 箇所2のstripAnsi未適用が既存バグか意図的設計かの明記。

**SF-003**: SF-002行番号注記のスコープをcheckForResponse()内の参照（セクション4）にも拡張。

**SF-004**: DRY記載の表現を「1か所の既存ロジックを抽出し、計3か所で共有」に修正。

### 検討事項 (Consider) - 3件

**C-001**: truncateRawContent()との相互作用への簡潔な言及。

**C-002**: テストケース#2のbufferReset=true冗長性の解消と、bufferResetフラグ単独でtrueとなるケースの追加。

**C-003**: 部分レスポンスパス（行501-533）がスコープ外であることの明記。

---

## Approval Status

| 項目 | 結果 |
|------|------|
| ステータス | **conditionally_approved** |
| スコア | **4/5** |
| 条件 | MF-001の補記完了後に承認 |

設計方針書はコードベースとの整合性が高い。4分岐ロジックの構造・条件・パラメータ値がいずれも実コードと一致し、Issue #235との関係性の分析も正確である。Stage 1レビュー指摘事項（MF-001, SF-001/002/003, C-001/002/003）が全て適切に反映されている点は評価に値する。指摘事項はいずれも細部の補足・明確化であり、設計の根本的な方向性に問題はない。

---

*Reviewed by: Architecture Review Agent (Stage 2 - 整合性)*
*Date: 2026-02-20*
*Design document: dev-reports/design/issue-326-prompt-response-extraction-design-policy.md*
*Target code: src/lib/response-poller.ts*
