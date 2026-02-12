# Architecture Review Report: Issue #235 Stage 3 - 影響分析レビュー

| 項目 | 内容 |
|------|------|
| **Issue** | #235 |
| **設計書** | `dev-reports/design/issue-235-prompt-rawcontent-design-policy.md` |
| **レビューステージ** | Stage 3: 影響分析レビュー |
| **レビュー観点** | 影響範囲 |
| **レビュー日** | 2026-02-11 |
| **ステータス** | 条件付き承認 (Conditionally Approved) |
| **スコア** | 4/5 |

---

## 1. エグゼクティブサマリー

Issue #235 の設計方針書を**影響範囲**の観点からレビューした。設計書は全体として変更の波及効果を適切に分析しており、直接変更ファイル3件と影響なし確認済みコンポーネント11件の分類は実コードと整合している。ただし、`response-poller.ts` 内の `extractResponse()` 関数に存在するclaude専用の早期プロンプト検出パス（L296-310）のフロー分析が設計書に明示されていない点、および `lastLines` ウィンドウ拡張に伴う回帰テスト不足が指摘事項として挙がった。Must Fix 1件、Should Fix 4件、Consider 3件の指摘を行う。

---

## 2. 影響範囲分析

### 2.1 直接変更ファイル

| カテゴリ | ファイル | 変更内容 | リスク |
|---------|---------|---------|-------|
| 直接変更 | `src/lib/prompt-detector.ts` | `PromptDetectionResult`型にrawContent追加、`truncateRawContent()`関数追加、`lastLines` 10->20行拡張、3パターンのreturn文にrawContent追加 | Low |
| 直接変更 | `src/lib/response-poller.ts` | L618のcontent値を`rawContent \|\| cleanContent`に変更 | Low |
| 直接変更 | `src/components/worktree/PromptMessage.tsx` | `getDisplayContent()`関数追加、指示テキスト表示JSX追加 | Low |

**評価**: 直接変更ファイルの選定は適切。変更箇所は最小限に抑えられており、KISS原則に準拠している。

### 2.2 間接影響ファイル

| カテゴリ | ファイル | 影響 | リスク | 設計書記載 |
|---------|---------|------|-------|-----------|
| 間接影響 | `src/lib/auto-yes-manager.ts` | `detectPrompt`の戻り値にrawContentが追加されるが、`isPrompt`と`promptData`のみ使用。影響なし | None | Section 11 記載あり |
| 間接影響 | `src/lib/auto-yes-resolver.ts` | `PromptData`型のみ使用。`PromptDetectionResult`未参照。影響なし | None | Section 11 記載あり |
| 間接影響 | `src/lib/status-detector.ts` | `detectPrompt`結果の`isPrompt`のみ参照。rawContent追加による影響なし | None | Section 11 記載あり |
| 間接影響 | `src/lib/claude-poller.ts` | 到達不能コード。L245で`detectPrompt().cleanContent`を使用するがrawContentは無視される | None | Section 11 記載あり |
| 間接影響 | `src/app/api/.../current-output/route.ts` | L91のローカル型注釈にrawContentは含まれないが、TypeScript構造的部分型により代入は安全 | None | Section 11 記載あり |
| 間接影響 | `src/app/api/.../prompt-response/route.ts` | `detectPrompt`結果の`isPrompt`と`promptData`のみ使用 | None | Section 11 記載あり |
| 間接影響 | `src/components/worktree/MessageList.tsx` | promptメッセージはPromptMessageコンポーネントで描画される（L536-544）ため、MessageBubbleのReactMarkdown表示パスは到達しない | None | **未記載** |

**評価**: 間接影響の分析は概ね網羅的。`auto-yes-manager.ts`、`auto-yes-resolver.ts`、`status-detector.ts`、`claude-poller.ts` については実コードを確認し、設計書の「影響なし」判定が正しいことを検証した。`MessageList.tsx` が設計書Section 11に記載されていない点は指摘事項とする（SF-S3-001）。

### 2.3 影響なし確認の検証結果

設計書Section 11に列挙された全11コンポーネントについて実コードを確認した結果を以下に示す。

**auto-yes-manager.ts** (L319-325):
```typescript
const promptDetection = detectPrompt(cleanOutput, promptOptions);
if (!promptDetection.isPrompt || !promptDetection.promptData) {
  // No prompt detected, schedule next poll
  scheduleNextPoll(worktreeId, cliToolId);
  return;
}
```
`isPrompt`と`promptData`のみ参照。`cleanContent`も`rawContent`も使用していない。設計書の判定は**正しい**。

**auto-yes-resolver.ts** (全体):
`PromptData`型のみimport。`PromptDetectionResult`への依存なし。設計書の判定は**正しい**。

**status-detector.ts** (L135-136):
```typescript
const promptDetection = detectPrompt(lastLines, promptOptions);
if (promptDetection.isPrompt) {
```
`isPrompt`のみ参照。設計書の判定は**正しい**。

**claude-poller.ts** (L162, L236, L245):
L162のTODOコメントに到達不能コードであることが記載されている。仮に到達した場合、L245で`promptDetection.cleanContent`を使用しており`rawContent`は未参照。設計書の判定は**正しい**。

**current-output/route.ts** (L91):
```typescript
let promptDetection: { isPrompt: boolean; cleanContent: string; promptData?: unknown } = { isPrompt: false, cleanContent: cleanOutput };
```
ローカル型注釈にrawContentは含まれないが、L94で`detectPrompt()`の戻り値が代入される際、TypeScript構造的部分型により余分なプロパティ（rawContent）は無視される。DB保存は行われない。設計書の判定は**正しい**。

**prompt-response/route.ts** (L72-85):
```typescript
promptCheck = detectPrompt(cleanOutput, promptOptions);
if (!promptCheck.isPrompt) {
```
`isPrompt`と`promptData`（L100-102のmcOptions参照）のみ使用。`cleanContent`も`rawContent`も未参照。設計書の判定は**正しい**。

---

## 3. 波及効果分析の妥当性

### 3.1 response-poller.ts の内部フロー

設計書Section 4.2はresponse-poller.ts L615-623（`checkForResponse`内）の変更のみを記載している。しかし、`response-poller.ts`の内部フローを精査すると、プロンプト検出が行われるパスが2系統存在する。

**パス1: extractResponse()内の早期検出（L296-310）**
```typescript
// L298-310 (claude専用)
if (cliToolId === 'claude') {
  const fullOutput = lines.join('\n');
  const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
  if (promptDetection.isPrompt) {
    return {
      response: stripAnsi(fullOutput),
      isComplete: true,
      lineCount: totalLines,
    };
  }
}
```
このパスでは`detectPromptWithOptions`が呼ばれ、結果が`promptDetection`に格納されるが、戻り値として使用されるのは`stripAnsi(fullOutput)`であり、`promptDetection.rawContent`は使用されない。`extractResponse`の戻り値`result.response`には`stripAnsi(fullOutput)`が格納される。

**パス2: checkForResponse()内の再検出（L609）**
```typescript
const promptDetection = detectPromptWithOptions(result.response, cliToolId);
```
`checkForResponse`はextractResponseの戻り値を受け取った後、L609で再度`detectPromptWithOptions`を呼び出す。このとき`result.response`（= `stripAnsi(fullOutput)`）に対して`detectPrompt`が実行されるため、rawContentはこの時点で正しく生成される。

**結論**: パス1→パス2の流れにおいて、rawContentはパス2で正しく生成されるため、DB保存時のcontent値は設計通り`rawContent || cleanContent`となる。ただし、パス1で`detectPromptWithOptions`が呼ばれる際にもrawContentが生成されるが使用されず捨てられるという冗長性がある。**機能的な問題はないが、設計書にこのフローの分析が明示されていない**点を Must Fix（MF-S3-001）として指摘する。

### 3.2 extractResponse()内の非claudeパス（L487-498）

```typescript
// L489-498
const fullOutput = lines.join('\n');
const promptDetection = detectPromptWithOptions(fullOutput, cliToolId);
if (promptDetection.isPrompt) {
  return {
    response: fullOutput,
    isComplete: true,
    lineCount: totalLines,
  };
}
```
codex/gemini用のパスでも同様にdetectPromptWithOptionsが呼ばれるが、戻り値として`fullOutput`（ANSI未除去）が使用される。checkForResponse L609で再度detectPromptWithOptionsが呼ばれるため、rawContentは正しく生成される。影響なし。

---

## 4. テスト戦略の網羅性

### 4.1 計画されたテスト（設計書Section 6）

| テスト | 項目数 | 評価 |
|-------|-------|------|
| prompt-detector.test.ts: rawContent検証 | 7項目 | 十分 |
| response-poller.test.ts: DB保存フォールバック | 2項目 | 十分 |
| PromptMessage.test.tsx: コンポーネントテスト | 4項目 | 概ね十分 |
| **合計** | **13項目** | |

### 4.2 テストカバレッジのギャップ

**Gap 1: lastLines拡張に伴う回帰テスト不足** (SF-S3-002)

`lastLines`が10行から20行に拡張されることで、Yes/Noパターン検出のスキャン範囲が広がる。現在のテストスイートには末尾11-20行目にパターンが存在するケースのテストがない。YES_NO_PATTERNSの正規表現は`/^(.+)\s+\(y\/n\)\s*$/m`のように行頭アンカーを使用しているため行中パターンの誤検出リスクは低いが、行頭に出現するケースのテストは有用。

**Gap 2: extractResponse早期プロンプト検出パスの統合テスト不在**

`extractResponse`内のclaude早期プロンプト検出パス（L296-310）経由でcheckForResponseに到達し、最終的にDB保存されるフローの統合テストが計画されていない。ユニットテストレベルではresponse-poller.test.tsの2項目で`rawContent || cleanContent`のフォールバックが検証されるが、extractResponse→checkForResponseの完全なフローは対象外。

**Gap 3: 既存DBデータとの混在表示テスト不在**

既存データ（content=cleanContent）と新規データ（content=rawContent）が混在する時期のPromptMessage表示テストが計画されていない。getDisplayContent()の「content.trim() === question.trim() -> null」条件が既存データに正しく適用されることを確認するテストが有用。

### 4.3 テスト対象外の妥当性

設計書Section 6.3で以下を「テスト対象外」としている。

- `auto-yes-manager.ts`: rawContentを参照しないため影響なし -- **妥当**。実コードL319-325を確認済み。
- `claude-poller.ts`: 到達不能コードのため変更・テスト不要 -- **妥当**。L162のTODOコメントで到達不能が明示されている。

---

## 5. パフォーマンスへの影響評価

### 5.1 設計書の評価（Section 7）の検証

| 観点 | 設計書の評価 | レビュー結果 | 判定 |
|------|------------|------------|------|
| DB保存 | Low（最大5000文字、低頻度） | 妥当。プロンプトメッセージはセッション中に数回〜数十回程度 | 合格 |
| WebSocket broadcast | Low（低頻度） | 妥当。broadcastMessage呼び出しは変更なし | 合格 |
| メモリ | Low（一時保持、truncate制御） | 妥当。truncateRawContentにより上限あり | 合格 |

### 5.2 追加のパフォーマンス観点

**truncateRawContent()の実行コスト**:
- `content.split('\n')`: O(n) で文字列全体を走査
- `lines.slice(-200)`: O(200) で一定
- `result.slice(-5000)`: O(5000) で一定
- multiple_choiceパターンでのみ呼び出され、output最大10000行に対して実行される
- 総計 O(n) で n は最大10000行。プロンプト検出の頻度を考慮すると無視できるレベル

**lastLines拡張（10→20行）の影響**:
- `lines.slice(-20).join('\n')`: 10行追加分のjoinコスト
- YES_NO_PATTERNSの正規表現マッチ範囲が2倍に拡大
- ただし正規表現は4パターンのシンプルなマッチであり、20行程度のテキストに対する実行時間は無視できる

**結論**: パフォーマンスへの影響は設計書の評価通りLow。追加の懸念なし。

---

## 6. 既存機能への影響分析

### 6.1 Auto-Yes機能

`auto-yes-manager.ts`は`detectPrompt`の結果から`isPrompt`と`promptData`のみを取得し、`resolveAutoAnswer(promptData)`で応答を決定する。`rawContent`フィールドの追加はAuto-Yes機能に一切影響しない。

### 6.2 ステータス検出機能

`status-detector.ts`の`detectSessionStatus()`は`detectPrompt`の`isPrompt`のみを参照して`hasActivePrompt`フラグを設定する。rawContentの追加によるステータス表示への影響はない。

### 6.3 プロンプト応答機能

`prompt-response/route.ts`はプロンプトのアクティブ状態を再確認するために`detectPrompt`を呼び出すが、`isPrompt`とpromptData（選択肢のナビゲーション用）のみを使用する。rawContentは未参照。

### 6.4 current-output API

L91のローカル型注釈が`{ isPrompt: boolean; cleanContent: string; promptData?: unknown }`であり、rawContentは含まれない。TypeScript構造的部分型により、`detectPrompt()`の戻り値からrawContentが存在しても代入時に型エラーは発生しない。APIレスポンスにrawContentは含まれない（promptDataのみ）。

### 6.5 MessageList.tsx内のMessageBubble

`MessageList.tsx`のL534-545で、`message.messageType === 'prompt'`の場合は`PromptMessage`コンポーネントが使用される。`MessageBubble`のReactMarkdown表示パス（L196-217）にはpromptメッセージは到達しない。ただし、MessageBubbleのReact.memoカスタム比較関数（L362-371）で`message.content`が比較対象に含まれているため、rawContentへの変更によりMemo判定が変わる。しかし、promptメッセージはMessageBubbleパスに到達しないため影響なし。

---

## 7. エッジケースのカバレッジ

### 7.1 設計書で対応済みのエッジケース

| エッジケース | 対策 | 評価 |
|------------|------|------|
| rawContentが巨大（10000行） | truncateRawContent()で200行/5000文字に制限 [MF-001] | 適切 |
| rawContentがundefined | `rawContent \|\| cleanContent`でフォールバック | 適切 |
| content === question（重複回避） | getDisplayContent()でnull返却 | 適切 |
| 空文字content | getDisplayContent()で`!content?.trim()`チェック | 適切 |
| ANSIエスケープコード混入 | stripAnsi()適用済みのrawContentを使用 | 適切 |
| XSS攻撃 | React defaultエスケープ、dangerouslySetInnerHTML不使用 | 適切 |

### 7.2 追加で検討すべきエッジケース

**EC-1: contentにquestionが含まれるが先頭ではないケース**

設計書Section 4.3.1のgetDisplayContent()のケース3「contentにquestionが含まれる -> content全体を表示」は適切。例：content="指示テキスト\n質問文", question="質問文" の場合、content全体が表示される。ただし、この場合prompt.questionセクション（L49-54）でも同じ質問文が表示されるため、視覚的に質問文が2回表示される。設計書Section 4.3.2のUIレイアウトではこれが意図的であることが示唆されているが、明示的な記載はない。テスト項目（Section 6.2の「content に question が含まれるケース」）で検証されるため問題は小さい。

**EC-2: 既存DBデータのApprove?パターン表示**

既存データでは`content = 'Approve?'`（cleanContent）が格納されている。getDisplayContent('Approve?', 'Approve?')はcontent.trim() === question.trim()条件によりnullを返し、指示テキスト領域は表示されない。これは従来と同じ表示となるため後方互換性は維持される。新規データでは`content = lastLines`（末尾20行）が格納されるため、Approve?の前にある指示テキストが表示される。この表示差異は意図的だが、設計書で明示されていない（SF-S3-004）。

**EC-3: truncateRawContentの末尾切り出しによるマルチバイト文字切断**

`result.slice(-RAW_CONTENT_MAX_CHARS)`は JavaScript の String.prototype.slice() であり、UTF-16コードユニット単位で動作する。通常の日本語文字（BMP内）では問題ないが、絵文字やCJK統合漢字拡張（サロゲートペア）の途中で切断される可能性が理論的に存在する。実際のClaude出力でこれが問題になる確率は極めて低い（C-S3-003）。

---

## 8. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | response-poller.tsの早期プロンプト検出パスでのrawContent未分析 | Low | Low | P2 |
| 技術的リスク | lastLines拡張による誤検出リスク微増 | Low | Low | P3 |
| 運用リスク | 既存/新規DBデータの表示差異 | Low | Medium | P3 |
| セキュリティリスク | XSS（React defaultエスケープで対策済み） | Low | Low | N/A |
| パフォーマンスリスク | truncateRawContentの実行コスト | Low | Low | N/A |

---

## 9. 指摘事項サマリー

### Must Fix (1件)

| ID | タイトル | 重要度 | 対象 |
|----|---------|-------|------|
| MF-S3-001 | response-poller.ts内の2箇所目のプロンプト検出パスでrawContent反映漏れの分析 | medium | 設計書Section 11 |

**詳細**: 設計書Section 4.2はresponse-poller.ts L615-623（checkForResponse内）の変更のみ記載しているが、同ファイル内extractResponse()のL296-310（claude用の早期プロンプト検出パス）のフロー分析が設計書に明示されていない。機能的な問題はないが、パス1でdetectPromptWithOptionsが呼ばれる→パス2のL609で再度呼ばれてrawContentが生成される→DB保存時にrawContent || cleanContentとなる、という流れを設計書に追記すべき。

### Should Fix (4件)

| ID | タイトル | 重要度 | 対象 |
|----|---------|-------|------|
| SF-S3-001 | MessageList.tsxのMessageBubbleコンポーネントにおけるpromptData表示の影響評価不足 | low | 設計書Section 11 |
| SF-S3-002 | lastLines変更（10行→20行）がYes/Noパターン検出精度に与える影響の分析不足 | low | テスト戦略 |
| SF-S3-003 | getDisplayContent関数の2回呼び出しによるパフォーマンスの非効率 | low | 設計書Section 4.3.2 |
| SF-S3-004 | 既存DBデータとの表示一貫性に関するエッジケース | low | 設計書Section 5.2 |

### Consider (3件)

| ID | タイトル | 重要度 |
|----|---------|-------|
| C-S3-001 | codex.tsのPromptDetectionResult使用に関する間接影響 | info |
| C-S3-002 | prompt-response/route.tsのpromptCheck変数のrawContent利用可能性 | info |
| C-S3-003 | truncateRawContentの末尾切り出しにおける文字列途中切断 | info |

---

## 10. 総合評価

設計方針書の影響範囲分析は**概ね適切**であり、直接変更3ファイルと間接影響11コンポーネントの分類は実コードと整合している。変更の波及効果は最小限に抑えられており、後方互換性も維持されている。テスト戦略は13項目で主要パスをカバーしているが、lastLines拡張に伴う回帰テストと既存DBデータとの混在表示テストの追加が推奨される。Must Fix 1件は設計書の記載追加のみで対応可能であり、コード変更は不要。

**承認条件**: MF-S3-001の設計書追記が完了すること。

---

*Generated by architecture-review-agent for Issue #235 Stage 3*
*Date: 2026-02-11*
