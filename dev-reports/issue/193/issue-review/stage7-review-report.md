# Issue #193 レビューレポート

**レビュー日**: 2026-02-08
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）
**ステージ**: 7/8（影響範囲レビュー 2回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

Stage 3（影響範囲レビュー 1回目）で指摘した全 10 件の指摘事項はすべて適切に対処されている。7 ステージのレビューを経て、Issue #193 の影響範囲分析は十分に成熟した状態にある。

---

## Stage 3 指摘事項の対処状況

| 指摘ID | ステータス | 概要 |
|--------|-----------|------|
| S3-001 | resolved | claude-poller.ts が変更対象テーブルと関連コンポーネントに追加済み |
| S3-002 | resolved | response-poller.ts L248/L442/L556 の区別が明確化済み |
| S3-003 | resolved | TUI ベースの代替設計パスが事前分析・文書化済み |
| S3-004 | resolved | 案B（パターンパラメータ化）が推奨案として明記、型定義例も提示済み |
| S3-005 | resolved | respond/route.ts が関連コンポーネントに追加済み |
| S3-006 | resolved | auto-yes-resolver.ts の isDefault 動作確認が前提条件と実装タスクに追加済み |
| S3-007 | resolved | STATUS_CHECK_LINE_COUNT=15 の制限が変更対象テーブルと受入条件に反映済み |
| S3-008 | resolved | PromptPanel.tsx/MobilePromptSheet.tsx が TUI 影響範囲と関連コンポーネントに追加済み |
| S3-009 | resolved | テストファイル更新テーブルが追加済み（api-prompt-handling.test.ts は影響なしとして除外済み） |
| S3-010 | resolved | detectPrompt 呼び出し箇所が「計 9 箇所」に修正、行番号と分類付きで列挙済み |

---

## Should Fix（推奨対応）

### S7-001: response-poller.ts L442/L556 の ANSI 未ストリップ不整合

**カテゴリ**: 影響範囲
**場所**: 影響範囲 > 変更対象ファイル > response-poller.ts

**問題**:
`response-poller.ts` の `extractResponse()` 内で、L442 と L556 は ANSI エスケープシーケンスを含む生のtmux出力を `detectPrompt()` に渡している。他の 7 箇所の呼び出し元（`status-detector.ts`、`auto-yes-manager.ts`、`prompt-response/route.ts`、`current-output/route.ts`、および `response-poller.ts` L248 自身）はいずれも事前に `stripAnsi()` を適用してから `detectPrompt()` に渡している。

**証拠**:
- `response-poller.ts` L441-442: `const fullOutput = lines.join('\n'); const promptDetection = detectPrompt(fullOutput);` -- `lines` は生の tmux 出力行であり、stripAnsi 未適用
- `response-poller.ts` L556: `const promptDetection = detectPrompt(result.response);` -- `result.response` は `extractResponse()` が返す生の行であり、stripAnsi 未適用
- 対照: `response-poller.ts` L247-248: `const cleanFullOutput = stripAnsi(fullOutput); const promptDetection = detectPrompt(cleanFullOutput);` -- stripAnsi 適用済み

**推奨対応**:
影響範囲テーブルの response-poller.ts の変更内容に「L442 と L556 で detectPrompt() に渡す前に stripAnsi() を適用する修正を含める（他の呼び出し箇所との整合性確保）」を追記する。Codex 固有のパターンが ANSI コード混入環境下で失敗するリスクを事前に排除できる。

---

### S7-002: 実装タスクの依存順序が明示されていない

**カテゴリ**: 依存関係
**場所**: 実装タスク

**問題**:
実装タスクはフラットなチェックボックスリストとして列挙されているが、タスク間の依存関係が暗黙的である。特に以下の順序制約が明示されていない:

1. **前提条件確認**（TUI vs テキスト実機確認） -> 他のすべてのタスク
2. **cli-patterns.ts** パターン定義 -> **prompt-detector.ts** 変更
3. **prompt-detector.ts** DetectPromptOptions 定義 + シグネチャ変更 -> 全呼び出し元の修正
4. 全実装完了 -> テスト追加・既存テスト更新
5. テスト完了 -> 動作検証

TUI ベースと判明した場合に「影響範囲テーブルを更新すること」と注記されているが、具体的にどのタスクが追加/変更されるかのフローが不明確。

**推奨対応**:
実装タスクをフェーズ分けして依存順序を明示する。例:
- Phase 1: 前提条件確認 -> 結果に基づく影響範囲更新
- Phase 2: パターン定義（cli-patterns.ts）-> 検出ロジック修正（prompt-detector.ts）
- Phase 3: 全呼び出し元の修正
- Phase 4: テスト追加・既存テスト更新
- Phase 5: 動作検証

---

### S7-003: getAnswerInput() の TUI ベース対応が影響範囲テーブルに未反映

**カテゴリ**: 影響範囲
**場所**: 対策案 > TUI ベースの場合の影響範囲

**問題**:
`prompt-detector.ts` の `getAnswerInput()` は multiple_choice の場合に数値文字列をそのまま返す（L413-418）。`respond/route.ts` L105 でこの関数を使用している。Issue の「TUI ベースの場合の影響範囲」セクションでは `getAnswerInput()` の multiple_choice ハンドリング変更に言及しているが、変更対象ファイルテーブルの `prompt-detector.ts` の変更内容には `getAnswerInput()` の変更が含まれていない。

**証拠**:
- `prompt-detector.ts` L413-418: `if (promptType === 'multiple_choice') { if (/^\d+$/.test(normalized)) { return normalized; } }` -- 数値文字列をそのまま返却
- `respond/route.ts` L105: `input = getAnswerInput(answer, message.promptData.type);` -- getAnswerInput の返却値を sendKeys に使用
- Issue 本文「TUI ベースの場合の影響範囲」: 「getAnswerInput(): multiple_choice ハンドリングの変更（番号 -> 矢印キー回数への変換）」と記載あり
- 変更対象テーブル prompt-detector.ts: 「detectMultipleChoicePrompt() の Codex 形式対応。案B採用時: DetectPromptOptions interface定義...」-- getAnswerInput() の変更は未記載

**推奨対応**:
TUI ベースの場合の変更対象テーブルまたは実装タスクに、`getAnswerInput()` の変更要否を設計判断項目として含める。sendKeys の呼び出し側（respond/route.ts、prompt-response/route.ts）で矢印キー変換を行うか、getAnswerInput() 内で CLI ツール別に分岐させるかの設計判断を前提条件確認後に行う旨を記載する。

---

## Nice to Have（あれば良い）

### S7-004: claude-poller.ts L164 の ANSI 未ストリップの認識事項

**カテゴリ**: 回帰リスク
**場所**: 影響範囲 > 関連コンポーネント（動作確認） > claude-poller.ts

**問題**:
`claude-poller.ts` の `extractClaudeResponse()` 内の L163-164 でも ANSI 未ストリップの生出力を `detectPrompt()` に渡している。S7-001 と同様の不整合だが、claude-poller.ts は Claude 専用ポーラーであり Codex セッションでは使用されないため、本 Issue の直接的な影響は低い。

**推奨対応**:
本 Issue のスコープを拡大する必要はない。detectPrompt() の入力契約を明確化する際のフォローアップ Issue 候補として認識する程度でよい。

---

### S7-005: PromptMessage.tsx が関連コンポーネント（動作確認）に含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 関連コンポーネント（動作確認）

**問題**:
`PromptMessage.tsx`（`src/components/worktree/PromptMessage.tsx` L95-96）も `multiple_choice` のブランチで選択肢を描画しているが、関連コンポーネントに含まれていない。PromptMessage.tsx はメッセージリスト内の既回答済みプロンプトの表示に使用される。

**推奨対応**:
関連コンポーネント（動作確認）に追加する。detectPrompt のシグネチャ変更の影響は受けないため、優先度は低い。

---

## 参照ファイル

### コード
- `src/lib/prompt-detector.ts`: detectPrompt() 定義、getAnswerInput() 定義（ANSI ストリップなし、パターンマッチの入力契約が暗黙的）
- `src/lib/response-poller.ts`: L442/L556 で ANSI 未ストリップ出力を detectPrompt() に渡している箇所
- `src/lib/claude-poller.ts`: L164/L232 で同様に ANSI 未ストリップ出力を detectPrompt() に渡している箇所
- `src/lib/status-detector.ts`: L81-87 で stripAnsi 後に detectPrompt() を呼び出している（整合的な箇所の参考例）
- `src/lib/auto-yes-manager.ts`: L279-290 で stripAnsi 後に detectPrompt() を呼び出している（整合的な箇所の参考例）
- `src/app/api/worktrees/[id]/respond/route.ts`: L105 で getAnswerInput() を使用、L148-156 で sendKeys ロジック
- `src/components/worktree/PromptMessage.tsx`: L95-96 で multiple_choice の選択肢を描画

### ドキュメント
- Issue #193 本文: 7 ステージのレビュー結果を反映した最新版
- `dev-reports/issue/193/issue-review/stage3-review-result.json`: Stage 3（影響範囲レビュー 1回目）の全 10 件の指摘事項

---

## 総合評価

Issue #193 は 7 ステージのレビューを経て、影響範囲分析が十分に成熟した状態にある。Stage 3 の全 10 件の指摘事項はすべて resolved であり、特に以下の点が高く評価される:

1. **detectPrompt() の全 9 箇所**の呼び出しが行番号・CLIツール種別・変更要否の分類付きで正確に列挙されている
2. **TUI ベースの代替設計パス**が影響範囲とともに事前分析されており、前提条件確認後のスムーズな設計移行が可能
3. **案B（パターンパラメータ化）**が推奨案として明記され、型定義例・推奨理由・Issue #161 との整合性が説明されている
4. **テストファイルの更新計画**が正確に文書化されている（影響を受けないファイルの除外根拠も含む）

残存する should_fix 3 件はいずれも実装フェーズで対処可能な範囲であり、Issue の全体品質に大きな影響を与えない。実装着手前の最終確認として対応するか、設計フェーズで具体化することを推奨する。
