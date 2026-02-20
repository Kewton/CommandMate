# Issue #326 レビューレポート - Stage 5

**レビュー日**: 2026-02-20
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2
**ステージ**: 5/6（通常レビュー 2回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |

## 前回指摘事項の対応確認

### Stage 1 指摘事項（6件）

| ID | カテゴリ | 対応状況 | 備考 |
|----|---------|---------|------|
| SF-1 | 完全性 | **対応済み** | 箇所2のstripAnsi未適用を「補足（SF-1）」として追記。記述は正確 |
| SF-2 | 完全性 | **対応済み** | checkForResponse内のrawContent影響含め網羅的に追記 |
| SF-3 | 技術的妥当性 | **対応済み** | 4分岐の具体的記述と方針A/Bの選択肢を明記 |
| NTH-1 | 完全性 | **未対応** | 受け入れ条件セクションは未追加（NTH-1として再掲） |
| NTH-2 | 完全性 | **対応済み** | テスト戦略サブセクションとして3案提示 |
| NTH-3 | 明確性 | **対応済み** | 見出しレベルでコメントマーカー併記 |

### Stage 3 指摘事項（6件）

| ID | カテゴリ | 対応状況 | 備考 |
|----|---------|---------|------|
| MF-1 | 影響ファイル | **対応済み** | auto-yes-manager.tsの間接影響を追記。ただし影響メカニズムに不正確さあり（SF-1） |
| SF-1 | テスト範囲 | **対応済み** | テスト戦略サブセクションで3案提示、(A)を推奨 |
| SF-2 | 依存関係 | **対応済み** | rawContentへの影響をcheckForResponseセクション内に追記 |
| SF-3 | 影響ファイル | **対応済み** | assistant-response-saver.tsを影響なしとして明記 |
| NTH-1 | テスト範囲 | **対応済み** | テスト影響テーブルを追加 |
| NTH-2 | 移行考慮 | **対応済み** | DB保存データへの影響サブセクションを追加 |

**対応率**: 12件中10件対応済み、1件部分対応、1件未対応（Nice to Have）

---

## Should Fix（推奨対応）

### SF-1: auto-yes-manager.tsへの間接影響メカニズムの記述が不正確

**カテゴリ**: 技術的妥当性
**場所**: ## 影響範囲 > 間接影響 セクション

**問題**:
現在のIssue記述では、auto-yes-manager.tsの間接影響として「DB保存contentの変化によるlastAnsweredPromptKey重複判定ロジックに間接的影響がある可能性がある」とされている。しかし、実際のコードを検証すると、この影響は発生しない。

**証拠**:

`lastAnsweredPromptKey`は`generatePromptKey(promptDetection.promptData)`で生成される（`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/auto-yes-manager.ts` 行539）。

```typescript
// auto-yes-manager.ts L539
const promptKey = generatePromptKey(promptDetection.promptData);
```

`generatePromptKey()`は`promptData.type`と`promptData.question`の組み合わせでキーを生成する（`/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/prompt-key.ts` 行37-38）:

```typescript
// prompt-key.ts L38
return `${promptData.type}:${promptData.question}`;
```

このキーはDB保存される`content`（`rawContent || cleanContent`）とは全く別のフィールドである。`auto-yes-manager.ts`の`pollAutoYes()`は独自にtmuxバッファ全体をキャプチャして`detectPrompt()`を呼び出す（行529）ため、`response-poller`の修正（`extractResponse()`内のレスポンス切り出し範囲変更）は`promptData.question`に影響を与えない。

**推奨対応**:
間接影響セクションのauto-yes-manager.ts記述を以下のように修正:

> `auto-yes-manager.ts` - `pollAutoYes()`はtmuxバッファを独自にキャプチャして`detectPrompt()`を直接呼び出しており、`extractResponse()`を経由しないため**コード変更は不要**。`lastAnsweredPromptKey`は`promptData.type:question`の組み合わせで生成されるため、`response-poller`が保存する`content`（`rawContent || cleanContent`）の変化による影響もない。

---

## Nice to Have（あれば良い）

### NTH-1: 受け入れ条件セクションの追加

**カテゴリ**: 完全性
**場所**: Issue本文（セクション未存在）

**問題**:
Stage 1のNTH-1で指摘した受け入れ条件の明示的なセクションがIssueに追加されていない。修正方針やテスト戦略の記述から推定は可能だが、明示的な受け入れ条件があると実装完了時の検証基準が明確になる。

**推奨対応**:
以下のような受け入れ条件セクションを追加:

1. プロンプト検出時のAssistantメッセージに`lastCapturedLine`以前の会話内容が混入しないこと
2. プロンプト検出自体の精度が維持されること（検出はバッファ全体で行うこと）
3. 箇所1（Claude早期プロンプト検出）と箇所2（フォールバックプロンプト検出）の両方が修正されていること
4. 既存テスト（`cleanClaudeResponse`, `rawContent fallback`）がパスすること

---

### NTH-2: 方針A/Bのトレードオフ分析

**カテゴリ**: 明確性
**場所**: ## 修正方針 > startIndex決定ロジックの方針（SF-3）セクション

**問題**:
方針A（通常レスポンスと同一のstartIndex決定ロジック再利用）と方針B（簡略版）が提示されているが、それぞれの具体的なトレードオフが記載されていない。

**推奨対応**:
以下のようなトレードオフ分析を追加するとより有用:

- **方針A**: 完全性が高く、bufferWasReset/バッファスクロール/Codex固有処理の全ケースを網羅。ただし`findRecentUserPromptIndex`の再利用やロジック重複（DRY違反リスク）を考慮する必要あり。ヘルパー関数への抽出と組み合わせると最適
- **方針B**: シンプルで実装コスト低。大多数のケース（lastCapturedLineが有効な値を持つ通常ケース）では正しく動作する。ただしbufferWasResetの場合にlastCapturedLineが無効値になるエッジケースで不具合が残る可能性あり

---

## 新規追加記述の検証結果

| 検証項目 | 結果 | 詳細 |
|---------|------|------|
| stripAnsi補足（SF-1） | PASS | 箇所1のstripAnsi適用・箇所2の未適用の差異を正確に記述 |
| startIndex 4分岐の記述 | PASS | 実コード行370-386の4分岐と完全一致 |
| 方針A/Bの提示 | PASS | 技術的に妥当な2案を提示 |
| checkForResponse rawContent分析 | PASS | prompt-detector.ts行583のtruncateRawContent入力変化の指摘は正確 |
| テスト戦略3案 | PASS | (A)ヘルパー関数抽出推奨は合理的（SRP + テスト容易性） |
| 影響範囲5分類構造 | PASS | 直接/間接/影響なし/テスト/DB保存の分類が網羅的 |
| auto-yes間接影響 | MINOR_ISSUE | 結論（コード変更不要）は正しいが、影響メカニズムの説明に不正確さ（SF-1） |
| 行番号の正確性 | PASS | 全ての行番号参照が実コードと一致（326, 487, 364-386, 605, 583） |

---

## 参照ファイル

### コード

| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` | 326-341 | 箇所1: Claude早期プロンプト検出 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` | 487-499 | 箇所2: フォールバックプロンプト検出 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` | 364-386 | startIndex決定ロジック4分岐 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/response-poller.ts` | 605 | checkForResponse再検出 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/prompt-detector.ts` | 583 | rawContent生成（truncateRawContent） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/auto-yes-manager.ts` | 529, 539 | pollAutoYes()のdetectPrompt/generatePromptKey |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/src/lib/prompt-key.ts` | 37-38 | generatePromptKey() - type:question形式 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/tests/unit/lib/response-poller.test.ts` | - | 既存テスト（extractResponseテスト0件） |

### ドキュメント

- `/Users/maenokota/share/work/github_kewton/commandmate-issue-326/CLAUDE.md` - response-poller.ts, auto-yes-manager.ts, prompt-key.tsの記述整合性確認

---

## 総合評価

Issue #326は、Stage 1/3の指摘事項を適切に反映し、高品質なバグ報告として十分な情報を含んでいる。原因分析、修正方針（startIndex方針A/B）、テスト戦略（3案）、影響範囲（5分類構造）がいずれも技術的に正確かつ網羅的である。

残存する指摘は以下の3件のみ:
- **SF-1**: auto-yes-managerへの間接影響メカニズムの説明修正（結論は正しいが根拠の記述を正確にする）
- **NTH-1**: 受け入れ条件の明示的セクション追加（あると便利だが必須ではない）
- **NTH-2**: 方針A/Bのトレードオフ分析（実装者の判断材料として有用だが必須ではない）

Issueの品質は実装着手に十分なレベルに達している。
