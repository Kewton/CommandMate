# Issue #193 作業計画書

## Issue: claude Codexからの複数選択肢に対し、回答を送信出来ない
**Issue番号**: #193
**ラベル**: bug
**サイズ**: L
**優先度**: High
**依存Issue**: なし
**設計方針書**: `dev-reports/design/issue-193-codex-multiple-choice-detection-design-policy.md`

---

## 実装タスク

### Phase 1: 前提条件確認

> **重要**: Phase 1の結果によりPhase 2以降のタスク内容が変わる可能性がある（TUI vs テキストベース）

- [ ] **Task 1.1**: Codex CLIの選択肢出力形式を実機確認
  - tmuxバッファ（`tmux capture-pane -p`）でCodex選択肢表示時の出力を取得
  - `stripAnsi()`後のテキストに番号付き選択肢が残るか確認
  - テキストベース（番号入力）かTUIベース（矢印キー選択）かを特定
  - デフォルト選択マーカーの有無を確認
  - 成果物: Issueコメントに確認結果を記録
  - 依存: なし

- [ ] **Task 1.2**: auto-yes-resolver.tsのisDefaultフラグ動作確認
  - Codex選択肢でデフォルトマーカーが検出されるか確認
  - されない場合の「最初の選択肢を選択」動作が許容可能か検証
  - 依存: Task 1.1

### Phase 2: パターン定義・コア実装

- [ ] **Task 2.1**: prompt-detector.ts - DetectPromptOptions定義 + シグネチャ変更
  - `DetectPromptOptions`インターフェース定義（`choiceIndicatorPattern`, `normalOptionPattern`, `requireDefaultIndicator`）
  - `detectPrompt(output, options?)`シグネチャ変更（optional引数で後方互換）
  - `detectMultipleChoicePrompt(output, options?)`のパターンパラメータ化（Pass 1, Pass 2）
  - Layer 4を`requireDefaultIndicator`で条件分岐（`options.length < 2`チェックとは分離）
  - `getAnswerInput()`のエラーメッセージを固定メッセージに変更 [DR4-004]
  - `PromptDetectionResult`のexport確認 [DR3-008]
  - 成果物: `src/lib/prompt-detector.ts`
  - 依存: Phase 1完了

- [ ] **Task 2.2**: cli-patterns.ts - Codexパターン定義 + ラッパー関数
  - `CLAUDE_CHOICE_INDICATOR_PATTERN`, `CLAUDE_CHOICE_NORMAL_PATTERN`定義
  - `CODEX_CHOICE_INDICATOR_PATTERN`, `CODEX_CHOICE_NORMAL_PATTERN`定義（Phase 1結果に基づく）
  - Codexパターンは行頭/行末アンカー付き（ReDoS防止）
  - `getChoiceDetectionPatterns(cliToolId)`関数（明示的パターン返却）
  - `detectPromptForCli(cleanOutput, cliToolId)`コンビニエンスラッパー
  - 循環依存チェック（`cli-patterns.ts` -> `prompt-detector.ts`）[DR2-015]
  - ReDoS自動検証（`safe-regex`または`recheck`で1000文字入力が100ms以内）[DR4-002]
  - 成果物: `src/lib/cli-patterns.ts`
  - 依存: Task 2.1

### Phase 3: 全呼び出し元の修正

- [ ] **Task 3.1**: auto-yes-manager.ts修正
  - L290: `detectPromptForCli(cleanOutput, cliToolId)`に変更
  - 成果物: `src/lib/auto-yes-manager.ts`
  - 依存: Task 2.2

- [ ] **Task 3.2**: status-detector.ts修正
  - L87: `detectPromptForCli(cleanOutput, cliToolId)`に変更（lastLinesではなくfull cleanOutput渡し）[DR1-003]
  - 成果物: `src/lib/status-detector.ts`
  - 依存: Task 2.2

- [ ] **Task 3.3**: response-poller.ts修正
  - L442: `detectPromptForCli(stripAnsi(fullOutput), cliToolId)`に変更
  - L556: `detectPromptForCli(stripAnsi(result.response), cliToolId)`に変更
  - `stripAnsi()`結果を変数に格納して再利用 [DR1-002]
  - 成果物: `src/lib/response-poller.ts`
  - 依存: Task 2.2

- [ ] **Task 3.4**: prompt-response/route.ts修正
  - L75: `detectPromptForCli(cleanOutput, cliToolId)`に変更
  - 入力バリデーション追加: 数値/y/n検証 + 最大長1000文字 + 制御文字フィルタリング [DR4-005]
  - エラーメッセージ修正: worktreeID非エコーバック [DR4-004]
  - 成果物: `src/app/api/worktrees/[id]/prompt-response/route.ts`
  - 依存: Task 2.2

- [ ] **Task 3.5**: current-output/route.ts修正
  - L88: `detectPromptForCli(cleanOutput, cliToolId)`に変更（既存のthinking条件分岐を維持）[DR2-007]
  - cliToolId取得方法の確認・検証 [DR1-010]
  - 成果物: `src/app/api/worktrees/[id]/current-output/route.ts`
  - 依存: Task 2.2

- [ ] **Task 3.6**: respond/route.ts セキュリティ修正
  - テキスト入力サニタイズ: 最大長1000文字 + 制御文字フィルタリング [DR4-001]
  - エラーメッセージ修正: 固定メッセージ使用 [DR4-004]
  - 成果物: `src/app/api/worktrees/[id]/respond/route.ts`
  - 依存: Task 2.2

- [ ] **Task 3.7**: クライアント側cliToolパラメータ検証
  - `useAutoYes.ts`がcliToolクエリパラメータを付与していることを確認 [DR1-010]
  - `WorktreeDetailRefactored.tsx`がcliToolクエリパラメータを付与していることを確認
  - 不足している場合は修正
  - 依存: Task 2.2

### Phase 4: テスト追加・既存テスト更新

- [ ] **Task 4.1**: prompt-detector.test.ts テスト追加
  - Codex選択肢検出テスト（デフォルト付き/なし）
  - `requireDefaultIndicator=false`時のLayer 4スキップテスト [DR1-001]
  - `requireDefaultIndicator=true`（デフォルト）時のLayer 4適用テスト
  - options省略時の後方互換性テスト
  - Codexパターンで通常テキスト誤検出防止テスト
  - 成果物: `tests/unit/prompt-detector.test.ts`
  - 依存: Task 2.1

- [ ] **Task 4.2**: cli-patterns.test.ts テスト追加
  - `getChoiceDetectionPatterns()`の各CLIツール返却値テスト
  - `detectPromptForCli()`基本動作テスト [DR1-007]
  - Codexパターンのアンカー検証・ReDoS安全性テスト
  - ReDoS病理的入力テスト（1000文字以上、100ms以内）[DR4-002]
  - 成果物: `tests/unit/lib/cli-patterns.test.ts`
  - 依存: Task 2.2

- [ ] **Task 4.3**: status-detector.test.ts テスト更新
  - 15行ウィンドウ境界テスト（L374-385）の期待値確認 [DR3-002]
  - multiple choice prompt検出テスト（full cleanOutput渡し動作確認）
  - Issue #180 past promptsテストのwindowing変更後の動作確認
  - 成果物: `src/lib/__tests__/status-detector.test.ts`
  - 依存: Task 3.2

- [ ] **Task 4.4**: 既存テストのモック更新
  - `auto-yes-manager.test.ts`: detectPromptモック更新
  - `prompt-response-verification.test.ts`: detectPromptモック更新 + 入力バリデーションテスト追加 [DR4-005]
  - 成果物: `tests/unit/lib/auto-yes-manager.test.ts`, `tests/unit/api/prompt-response-verification.test.ts`
  - 依存: Task 3.1, Task 3.4

### Phase 5: 動作検証

- [ ] **Task 5.1**: 自動テスト実行
  - `npx tsc --noEmit` - 型チェック
  - `npm run lint` - ESLint
  - `npm run test:unit` - 全ユニットテスト
  - `npm run build` - ビルド確認
  - 依存: Phase 4完了

- [ ] **Task 5.2**: 回帰テスト
  - `tests/integration/api-prompt-handling.test.ts` 回帰実行 [DR3-005]
  - `src/lib/__tests__/cli-patterns.test.ts` 既存テスト確認 [DR3-007]
  - Claude CLI既存機能の回帰テストパス
  - 依存: Task 5.1

- [ ] **Task 5.3**: セキュリティ検証
  - prompt-response APIに制御文字を含む入力→フィルタリング確認 [DR4-001]
  - prompt-response APIに不正フォーマット回答→400エラー確認 [DR4-005]
  - APIエラーレスポンスにユーザー入力非エコーバック確認 [DR4-004]
  - 依存: Task 5.1

---

## タスク依存関係

```
Phase 1: 前提条件確認
  Task 1.1 (Codex出力形式確認)
    └─> Task 1.2 (isDefault動作確認)

Phase 2: コア実装（Phase 1完了後）
  Task 2.1 (prompt-detector.ts) ──> Task 2.2 (cli-patterns.ts)

Phase 3: 呼び出し元修正（Phase 2完了後）
  Task 2.2 ──> Task 3.1 (auto-yes-manager.ts)
           ──> Task 3.2 (status-detector.ts)
           ──> Task 3.3 (response-poller.ts)
           ──> Task 3.4 (prompt-response/route.ts)
           ──> Task 3.5 (current-output/route.ts)
           ──> Task 3.6 (respond/route.ts)
           ──> Task 3.7 (クライアント検証)

Phase 4: テスト（Phase 3完了後）
  Task 2.1 ──> Task 4.1 (prompt-detector.test.ts)
  Task 2.2 ──> Task 4.2 (cli-patterns.test.ts)
  Task 3.2 ──> Task 4.3 (status-detector.test.ts)
  Task 3.1/3.4 ──> Task 4.4 (モック更新)

Phase 5: 動作検証（Phase 4完了後）
  Phase 4 ──> Task 5.1 (自動テスト) ──> Task 5.2 (回帰) ──> Task 5.3 (セキュリティ)
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| ESLint | `npm run lint` | エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |
| Integration Test | `npm run test:integration` | 全テストパス |

---

## 成果物チェックリスト

### コード変更
- [ ] `src/lib/prompt-detector.ts` - DetectPromptOptions + シグネチャ変更 + Layer 4条件化
- [ ] `src/lib/cli-patterns.ts` - Codexパターン + getChoiceDetectionPatterns + detectPromptForCli
- [ ] `src/lib/auto-yes-manager.ts` - detectPromptForCli呼び出し
- [ ] `src/lib/status-detector.ts` - detectPromptForCli + ウィンドウイング修正
- [ ] `src/lib/response-poller.ts` - detectPromptForCli + stripAnsi追加
- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts` - detectPromptForCli + 入力バリデーション
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts` - detectPromptForCli
- [ ] `src/app/api/worktrees/[id]/respond/route.ts` - 入力サニタイズ + エラーメッセージ修正

### テスト
- [ ] `tests/unit/prompt-detector.test.ts` - Codex選択肢検出 + Layer 4条件化テスト
- [ ] `tests/unit/lib/cli-patterns.test.ts` - パターン返却 + ラッパー + ReDoSテスト
- [ ] `src/lib/__tests__/status-detector.test.ts` - ウィンドウイング変更テスト
- [ ] `tests/unit/lib/auto-yes-manager.test.ts` - モック更新
- [ ] `tests/unit/api/prompt-response-verification.test.ts` - モック更新 + バリデーションテスト

---

## Definition of Done

- [ ] Phase 1の前提条件確認完了（結果をIssueに記録）
- [ ] 全タスク（Task 1.1~5.3）が完了
- [ ] `npx tsc --noEmit` エラー0件
- [ ] `npm run lint` エラー0件
- [ ] `npm run test:unit` 全テストパス
- [ ] `npm run build` 成功
- [ ] Codex CLIの選択肢にUIから手動応答可能
- [ ] Codex CLIの選択肢にAuto-Yes自動応答可能
- [ ] Claude CLIの既存機能に回帰なし
- [ ] セキュリティ検証（入力バリデーション、エラーメッセージ）パス

---

## 次のアクション

1. **TDD実装開始**: `/pm-auto-dev 193` で自動開発フロー実行
2. **進捗報告**: `/progress-report` で定期報告
3. **PR作成**: `/create-pr` で自動作成

---

*Generated by work-plan command for Issue #193*
*Date: 2026-02-08*
