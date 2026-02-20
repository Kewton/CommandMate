# Architecture Review: Issue #326 設計原則レビュー (Stage 1)

| 項目 | 値 |
|------|-----|
| Issue | #326 |
| Focus | 設計原則 (Design Principles) |
| Stage | 1 - 通常レビュー |
| Status | **Conditionally Approved** |
| Score | **4/5** |
| Date | 2026-02-20 |

---

## Executive Summary

Issue #326 の設計方針書は、`extractResponse()` 内のインタラクティブプロンプト検出時にtmuxバッファ全体がレスポンスとして返される問題に対して、`resolveExtractionStartIndex()` ヘルパー関数を抽出し、3箇所のstartIndex決定ロジックを統合するアプローチを提案している。

設計原則の観点から、DRY原則への対応は適切であり、YAGNI原則に基づく最小限の変更範囲も妥当と評価する。`@internal` export戦略は既存コードベースの慣行に沿っている。

1件の必須改善項目（bufferWasReset再計算の責務境界の明確化）と3件の推奨改善項目を検出した。いずれも設計書の補記レベルの修正であり、設計方針自体の変更は不要と判断する。

---

## 1. SOLID原則評価

### 1-1. SRP (Single Responsibility Principle) -- Pass (注意点あり)

**評価**: `resolveExtractionStartIndex()` は「startIndex決定」という単一責務を持ち、SRPに準拠している。

**注意点 (MF-001)**: 設計書のヘルパー関数シグネチャでは `bufferReset: boolean` を引数として受け取る設計だが、実コード（`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` 行368）では以下のようにbufferWasResetを再計算している。

```typescript
// 行368 (response-poller.ts)
const bufferWasReset = lastCapturedLine >= totalLines || bufferReset;
```

この再計算がヘルパー関数の内部に移動するのか、呼び出し側で事前計算されるのかが設計書で不明確。ヘルパー関数が `bufferReset` (外部イベントフラグ) だけを受け取り、内部で `lastCapturedLine >= totalLines` との論理和を取るのであれば、関数が「バッファリセット判定」の一部を担うことになり、責務が拡大する。

**推奨**: ヘルパー関数の最初のステップとして `bufferWasReset` を内部計算することを設計書に明記するか、呼び出し側で `bufferWasReset` を事前計算して渡す設計にするかを確定すること。

### 1-2. OCP (Open/Closed Principle) -- Pass

`cliToolId` による分岐は既存パターンの移植であり、新しいCLIツール追加時はif/else分岐の追加で対応可能。既存コードのOCP特性を維持している。将来的にCLIツール数が増加した場合はStrategy Patternへの移行が考えられるが、現時点では3種類（claude, codex, gemini）であり、YAGNI原則から現設計が適切。

### 1-3. LSP / ISP -- Not Applicable

本設計は関数レベルであり、継承・サブタイプ関係やインターフェース分離の対象はない。

### 1-4. DIP (Dependency Inversion Principle) -- Pass

`findRecentUserPromptIndex` をコールバック引数として注入する設計はDIPに準拠している。テスト時にモック関数を渡すことでtmuxバッファやstripAnsiへの依存を切り離せる。

---

## 2. DRY原則評価

### resolveExtractionStartIndex() による重複排除の妥当性 -- Pass

**現状の重複箇所**: 実コード上、startIndex決定ロジックは以下の3箇所に存在または必要:

1. **通常レスポンス抽出パス** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` 行364-386): 明示的な4分岐ロジック
2. **箇所1: Claude早期プロンプト検出** (行326-341): 現状はstartIndex決定なし（バッファ全体を返す問題の根因）
3. **箇所2: フォールバックプロンプト検出** (行487-499): 現状はstartIndex決定なし（同上）

設計書では3箇所すべてを `resolveExtractionStartIndex()` の呼び出しに統一する方針であり、DRY原則に合致する。特に、バッファリセットやスクロール境界のエッジケース処理が自動的に3箇所で共有される点は大きなメリット。

---

## 3. KISS原則評価

### ヘルパー関数のインターフェース設計 -- Pass (注意点あり)

設計書で提案されているシグネチャ:

```typescript
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number
): number
```

**良い点**:
- 引数5つは関数の責務に対して妥当な数
- 戻り値が `number` という単純型
- 新規概念の導入なし（既存ロジックの純粋な抽出）

**注意点 (SF-001)**: `findRecentUserPromptIndex` をコールバック引数として渡す設計は、テスタビリティの観点で優れているが、本番コードでは呼び出し側がクロージャを渡す形になる。このクロージャは `lines`, `totalLines`, `cliToolId`, `stripAnsi` をキャプチャしている（行310-324）。コールバック引数パターンの選択理由を設計書に簡潔に記載すると、将来の保守者への説明になる。

---

## 4. YAGNI原則評価

### 必要最小限の変更範囲 -- Pass (注意点あり)

**変更ファイル**: `src/lib/response-poller.ts` のみ（1ファイル）
**新規ファイル**: `tests/unit/lib/resolve-extraction-start-index.test.ts`（テストのみ）
**DBマイグレーション**: 不要
**外部API変更**: なし

変更範囲は最小限に留まっており、YAGNI原則に準拠している。

**注意点 (SF-003)**: 箇所2への `stripAnsi` 追加はバグ修正に直接必要な変更ではなく、一貫性確保のための付随修正である。合理的な判断だが、設計書のセクション9 YAGNI欄でこの点に触れていない。YAGNI原則の例外として意識的に含めた判断であることを明記すべき。

---

## 5. テスタビリティ評価

### @internal export戦略の妥当性 -- Pass

既存コードベースでの `@internal` export 使用実績:

| モジュール | 関数/型 | 用途 |
|-----------|--------|------|
| `claude-session.ts` | `clearCachedClaudePath()` | 本番+テスト両用 |
| `claude-session.ts` | `HealthCheckResult` | テスト専用型 |
| `claude-session.ts` | `isSessionHealthy()` | テスト専用 |
| `version-checker.ts` | `resetCacheForTesting()` | テスト専用 |
| `auto-yes-manager.ts` | `clearAllAutoYesStates()`, `checkStopCondition()` 等 | テスト専用 |
| `clone-manager.ts` | `resetWorktreeBasePathWarning()` | テスト専用 |

`resolveExtractionStartIndex()` は本番コードから3箇所で呼び出される関数のexportであり、`clearCachedClaudePath()` と同じパターン（本番+テスト両用の `@internal` export）に該当する。命名にForTesting接尾辞を付けないのは正しい判断。

### テストケースの網羅性 -- Pass

設計書のテストケース6件は以下の分岐を網羅:

| # | 分岐 | カバレッジ |
|---|------|----------|
| 1 | 通常ケース (lastCapturedLine < totalLines - 5) | TC#1, TC#4 |
| 2 | bufferReset=true, ユーザープロンプトあり | TC#2 |
| 3 | bufferReset=true, ユーザープロンプトなし | TC#3 |
| 4 | cliToolId='codex' | TC#4 |
| 5 | バッファスクロール境界, プロンプトあり | TC#5 |
| 6 | バッファスクロール境界, プロンプトなし | TC#6 |

**推奨追加**: `lastCapturedLine=0` のケース（初回ポーリング）と、`lastCapturedLine >= totalLines` かつ `bufferReset=false` のケース（bufferWasReset内部計算の検証）。

---

## 6. 設計書の記述一貫性・完全性評価

### 良い点

- セクション3-2の比較表（4分岐条件の整理）が明確
- 不採用案（方針B）の理由が記載されている
- セクション4のcheckForResponse影響分析が丁寧
- セクション8のトレードオフ表が判断根拠を明示

### 改善点

1. **MF-001**: bufferWasReset再計算のヘルパー関数内包可否が不明確
2. **SF-002**: 行番号参照の保守性リスク。コード変更で行番号がずれた場合に設計書が陳腐化する
3. **SF-003**: YAGNI準拠セクションで箇所2のstripAnsi追加に触れていない
4. セクション3-3のヘルパー関数シグネチャで、`lastCapturedLine` と `totalLines` の両方を受け取りながら内部で `bufferWasReset` を再計算するかどうかが読み取れない

---

## 7. Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | bufferWasReset責務境界の曖昧さによる実装時の解釈ブレ | Low | Medium | P2 |
| セキュリティ | なし（データフィルタリング範囲変更のみ） | Low | Low | -- |
| 運用リスク | なし（外部API変更なし、DBマイグレーション不要） | Low | Low | -- |

---

## 8. Improvement Recommendations

### 必須改善項目 (Must Fix) -- 1件

| ID | 項目 | 原則 |
|----|------|------|
| MF-001 | resolveExtractionStartIndex内のbufferWasReset再計算が設計書に記載なし。ヘルパー関数が `bufferReset` だけを受け取り内部で `lastCapturedLine >= totalLines` との論理和を取るのか、呼び出し側で `bufferWasReset` を事前計算して渡すのかを明記すること。 | SRP / 設計書の完全性 |

### 推奨改善項目 (Should Fix) -- 3件

| ID | 項目 | 原則 |
|----|------|------|
| SF-001 | findRecentUserPromptIndexをコールバック引数とする設計選択の理由（テスタビリティ vs. 純粋関数化のトレードオフ）をJSDocまたは設計書に補記 | KISS |
| SF-002 | 設計書の行番号参照を「設計時点のスナップショット」であることの注記追加、またはコード内マーカー参照方式への変更 | 保守性 |
| SF-003 | セクション9のYAGNI欄に「箇所2のstripAnsi追加はYAGNIの例外として一貫性確保のために含める」旨を補記 | YAGNI |

### 検討事項 (Consider) -- 3件

| ID | 項目 | 原則 |
|----|------|------|
| C-001 | テストケースに lastCapturedLine=0 のケースとMath.max(0, ...)ガードの明記追加 | 防御的プログラミング |
| C-002 | lastCapturedLineが質問文途中を指す場合のrawContent品質に関する結合テスト検討 | テスタビリティ |
| C-003 | @internal export の命名がForTesting接尾辞でない理由（本番コードからも呼び出されるため）の設計書補記 | 命名規約の一貫性 |

---

## 9. Approval Status

**Conditionally Approved (条件付き承認)**

MF-001（bufferWasReset再計算の責務境界の明確化）を設計書に反映した上で実装に進むことを推奨する。SF-001～SF-003は実装と並行で設計書を補記可能。

---

*Reviewed by: Architecture Review Agent*
*Date: 2026-02-20*
