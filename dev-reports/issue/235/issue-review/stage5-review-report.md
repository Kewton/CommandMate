# Issue #235 レビューレポート（Stage 5）

**レビュー日**: 2026-02-11
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: Stage 5（最終確認）

---

## 前回指摘の対応状況

### Stage 1（通常レビュー 1回目）: 全7件 -- 全て対応済み

| ID | カテゴリ | 指摘内容 | 状態 |
|----|---------|---------|------|
| MF-1 | 完全性 | claude-poller.ts の記載漏れ | 対応済み |
| SF-1 | 完全性 | Approveパターンの rawContent 返却タスク欠如 | 対応済み |
| SF-2 | 明確性 | PromptMessage.tsx の表示方法不明確 | 対応済み |
| SF-3 | 技術的妥当性 | rawContent 定義の統一化 | 対応済み |
| SF-4 | 完全性 | current-output/route.ts の影響分析欠如 | 対応済み |
| NTH-1 | 完全性 | rawContent フォールバックテスト条件 | 対応済み |
| NTH-2 | 完全性 | codex.ts の変更要否不明確 | 対応済み |

### Stage 3（影響範囲レビュー 1回目）: 全9件 -- 全て対応済み

| ID | カテゴリ | 指摘内容 | 状態 |
|----|---------|---------|------|
| MF-1 | テスト範囲 | prompt-detector.test.ts の rawContent テスト未明記 | 対応済み |
| MF-2 | テスト範囲 | response-poller.test.ts のフォールバックテスト欠如 | 対応済み |
| SF-1 | 影響ファイル | ANSI エスケープコード対処方針未記載 | 対応済み |
| SF-2 | 破壊的変更 | 既存DBデータとの後方互換性未分析 | 対応済み |
| SF-3 | 依存関係 | auto-yes-manager.ts の型互換性分析不足 | 対応済み |
| SF-4 | テスト範囲 | PromptMessage.tsx のUIテスト未検討 | 対応済み |
| NTH-1 | ドキュメント | CLAUDE.md 更新タスク欠如 | 対応済み |
| NTH-2 | 移行考慮 | rawContent サイズのパフォーマンス考慮未記載 | 対応済み |
| NTH-3 | ドキュメント | prompt-response/route.ts の影響範囲テーブル欠如 | 対応済み |

**結論**: Stage 1 および Stage 3 の全 16 件の指摘事項が全て適切に Issue 本文に反映されていることを確認した。

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

---

## Should Fix（推奨対応）

### SF-1: 問題箇所セクションの行番号・関数名がソースコードと不一致

**カテゴリ**: 正確性
**場所**: ## 問題箇所

**問題**:

Issue の「問題箇所」セクションで以下の不正確な記載がある。

1. **項目1「471-486行目: `extractQuestionText()` が `questionEndIndex - 5` で5行制限」** -- `extractQuestionText()` という関数は `src/lib/prompt-detector.ts` 内に存在しない。該当ロジックは `detectMultipleChoicePrompt()` 関数内の L471-486 にインラインで記述されている質問テキスト抽出ループである。

2. **項目2「488-509行目: `cleanContent: question.trim()` で質問テキストのみ返却」** -- 関数名の前提が項目1に依存しているため、こちらも `detectMultipleChoicePrompt()` の return ブロック内であることを明記すべき。

**証拠**:

`src/lib/prompt-detector.ts` 全体に対して `extractQuestionText` を検索した結果、0件である。L471-486 は `detectMultipleChoicePrompt()` 関数内のインラインコードであり、独立した関数としては抽出されていない。

```
// L471-486 の実際のコード（detectMultipleChoicePrompt() 内）
// Extract question text
let question = '';
if (questionEndIndex >= 0) {
    const questionLines: string[] = [];
    for (let i = Math.max(0, questionEndIndex - 5); i <= questionEndIndex; i++) {
        const line = lines[i].trim();
        if (line && !SEPARATOR_LINE_PATTERN.test(line)) {
            questionLines.push(line);
        }
    }
    question = questionLines.join(' ');
}
```

**推奨対応**:

項目1 を「`detectMultipleChoicePrompt()` 内の質問テキスト抽出ロジック（471-486行目）が `questionEndIndex - 5` で5行制限」に修正する。項目2 も同様に関数コンテキストを明記する。

---

### SF-2: multiple_choice の rawContent サイズに関するパフォーマンス考慮の記述が不正確

**カテゴリ**: 正確性
**場所**: ## rawContent の定義 / ## rawContent のサイズに関するパフォーマンス考慮

**問題**:

Issue のパフォーマンス考慮セクションに「プロンプト検出は末尾50行ウィンドウで処理されるため、rawContent が極端に大きくなるケースは限定的」と記載されているが、これは不正確である。

`rawContent = output.trim()` の `output` は `detectMultipleChoicePrompt()` に渡されるパラメータ全体であり、50行ウィンドウはスキャン範囲（`scanStart` 〜 `effectiveEnd`）を限定するものに過ぎない。`output` 変数自体は `captureSessionOutput(worktreeId, cliToolId, 10000)` の出力全体を保持したままであるため、rawContent は最大で 10000 行分の出力を含む可能性がある。

**証拠**:

データフロー:
1. `response-poller.ts:570` -- `captureSessionOutput(worktreeId, cliToolId, 10000)` で最大 10000 行取得
2. `response-poller.ts:100` -- `detectPrompt(stripAnsi(output), promptOptions)` で全出力を渡す
3. `prompt-detector.ts:105` -- `detectMultipleChoicePrompt(output, options)` に全出力を渡す
4. `prompt-detector.ts:372` -- `scanStart = Math.max(0, effectiveEnd - 50)` はスキャン範囲であり、`output` のサイズ制限ではない

**推奨対応**:

パフォーマンス考慮セクションを以下のように修正する: 「`multiple_choice` パターンでは `rawContent = output.trim()` で `captureSessionOutput` の出力全体（最大 10000 行）を含む可能性がある。ただし prompt メッセージの発生頻度は低く、SQLite TEXT 型に理論上の制限はないため、ストレージへの影響は許容範囲内である。WebSocket broadcast のペイロード増加についても、prompt メッセージの頻度の低さから無視できるレベルと判断する」

---

## Nice to Have（あれば良い）

### NTH-1: current-output/route.ts の影響なし理由をより具体化

**カテゴリ**: 整合性
**場所**: ## 影響範囲 > 影響なしの確認済みコンポーネント > current-output/route.ts

**問題**:

影響なし確認済みテーブルでは「L91で `cleanContent: cleanOutput` と独自にデフォルト値を設定しており、`PromptDetectionResult` 型を直接参照していない」と記載している。しかしより正確には、L91 のローカル型注釈 `{ isPrompt: boolean; cleanContent: string; promptData?: unknown }` が `PromptDetectionResult` ではなく手動定義されているため、L94 で `detectPrompt()` が rawContent を返しても TypeScript の構造的型付けにより rawContent フィールドが無視される、という構造が「影響なし」の本質的な理由である。

**推奨対応**:

影響なしの理由に「ローカル型注釈で rawContent を含まないため、detectPrompt() の戻り値から rawContent が構造的に除外される」旨を補足すると、影響分析の精度が向上する。

---

### NTH-2: PromptMessage.tsx UI仕様のフォールバック比較ロジックの具体化

**カテゴリ**: 完全性
**場所**: ## PromptMessage.tsx UI仕様

**問題**:

UI 仕様の項目3「重複回避」で「`message.content` が空または `prompt.question` と同一の場合は従来通り `prompt.question` を表示するフォールバック」とあるが、「同一」の判定方法（完全一致/trim後一致/含有判定）が未定義である。

**推奨対応**:

実装時に詳細化すれば十分だが、Issue 段階で方針を記載しておくと実装者の判断が容易になる。例:
- `message.content` が空文字列/undefined/null の場合 --> `prompt.question` を表示
- `message.content.trim() === prompt.question.trim()` の場合 --> `message.content` のみ表示（重複回避）
- それ以外 --> `message.content` 全体を表示

---

### NTH-3: レビュー履歴への Stage 5 結果の追記

**カテゴリ**: 完全性
**場所**: ## レビュー履歴

**問題**:

レビュー履歴セクションには Stage 1 と Stage 3 の記録のみ記載されている。Stage 5（本レビュー）の結果反映時にレビュー履歴を更新することで、4段階レビュープロセスの完了記録が残る。

---

## 総合評価

Issue #235 は4段階のレビュープロセス（Stage 1〜4）を経て、高い品質に達している。

**強み**:
- 根本原因分析が詳細かつ正確（データフロー図、問題箇所の特定）
- 修正方針が明確で、不採用案の理由も記載されている
- 実装タスクが具体的で、テストケースも網羅的に列挙されている
- 影響範囲分析が体系的で、影響なし確認済みコンポーネントの理由が明記されている
- 受入条件が基本機能/フォールバック/後方互換性/テストの4カテゴリに整理されている
- セキュリティ（ANSI, XSS, dangerouslySetInnerHTML 不使用）およびパフォーマンスの考慮が含まれている

**新規指摘**:
- Must Fix: 0 件
- Should Fix: 2 件（行番号/関数名の不正確さ、パフォーマンス記述の不正確さ）
- Nice to Have: 3 件（影響分析の精度向上、UI仕様の具体化、レビュー履歴更新）

**実装着手可否**: 実装着手に十分な品質である。Should Fix の2件は Issue 記載の正確性に関する修正であり、実装ロジック自体には影響しない。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/prompt-detector.ts`: PromptDetectionResult 型定義（L40-47）、detectPrompt()（L93）、detectMultipleChoicePrompt()（L357）、質問テキスト抽出ロジック（L471-486）、cleanContent返却（L508）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/response-poller.ts`: detectPromptWithOptions()（L95-101）、DB保存（L618）、captureSessionOutput（L570）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/components/worktree/PromptMessage.tsx`: 現在の表示ロジック（prompt.question のみ、L52）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/app/api/worktrees/[id]/current-output/route.ts`: ローカル型注釈によるrawContent除外（L91-94）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/CLAUDE.md`: prompt-detector.ts / response-poller.ts モジュール説明
