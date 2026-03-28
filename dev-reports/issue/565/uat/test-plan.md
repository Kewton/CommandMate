# Issue #565 実機受入テスト計画

## テスト概要
- Issue: #565 Copilot CLI（TUI/alternate screen）対応
- テスト日: 2026-03-28
- テスト環境: CommandMate サーバー (localhost:{UAT_PORT})

## 前提条件
- Node.js, npm が利用可能
- ビルドが成功すること
- テスト用リポジトリが存在すること

## テスト方針

本Issueはライブラリ層の変更（ポーリング・TUI蓄積・重複防止・定数化）が主であり、一部のテストケースはCopilot CLIセッションが必要。Copilot CLIの実機テストが困難な項目はコード検証で代替する。

## テストケース一覧

### TC-001: ビルド成功
- **テスト内容**: 全変更を含むプロジェクトが正常にビルドされること
- **実行手順**: `npm run build`
- **期待結果**: exit code 0
- **確認観点**: 全変更ファイルの型安全性

### TC-002: TypeScript型チェック
- **テスト内容**: 型エラーが0件であること
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: exit code 0、エラー0件
- **確認観点**: 新規・修正ファイルの型整合性

### TC-003: ESLint
- **テスト内容**: リントエラーが0件であること
- **実行手順**: `npm run lint`
- **期待結果**: exit code 0
- **確認観点**: コーディング規約準拠

### TC-004: ユニットテスト全パス
- **テスト内容**: 全ユニットテストがパスすること
- **実行手順**: `npm run test:unit`
- **期待結果**: 全テストパス、失敗0件
- **確認観点**: 既存テスト回帰なし

### TC-005: 新規テストファイルの存在確認
- **テスト内容**: Issue #565で追加されたテストファイルが存在すること
- **実行手順**: ファイル存在確認
- **期待結果**: 4つの新規テストファイルが存在
  - tests/unit/config/copilot-constants.test.ts
  - tests/unit/lib/prompt-dedup.test.ts
  - tests/unit/lib/tui-accumulator-copilot.test.ts
  - tests/unit/lib/response-cleaner-copilot.test.ts
- **確認観点**: テストカバレッジ

### TC-006: copilot-constants.ts定数値の検証
- **テスト内容**: 遅延定数が正しい値で定義されていること
- **実行手順**: ファイル内容確認
- **期待結果**: COPILOT_SEND_ENTER_DELAY_MS=200, COPILOT_TEXT_INPUT_DELAY_MS=100
- **確認観点**: 受入条件「200ms遅延値が定数化」

### TC-007: 遅延定数の3箇所参照確認
- **テスト内容**: COPILOT_SEND_ENTER_DELAY_MSがsend/route.ts, terminal/route.ts, copilot.tsで参照されていること
- **実行手順**: grep検索
- **期待結果**: 3ファイルでimport/使用が確認できる
- **確認観点**: 受入条件「3箇所で統一参照」

### TC-008: prompt-dedup.tsの独立モジュール確認
- **テスト内容**: 重複防止モジュールが独立ファイルとして存在すること
- **実行手順**: ファイル存在・内容確認
- **期待結果**: isDuplicatePrompt, clearPromptHashCacheがexportされている
- **確認観点**: SRP準拠（設計レビューDR1-008）

### TC-009: extractCopilotContentLines存在確認
- **テスト内容**: Copilot用コンテンツ抽出関数が実装されていること
- **実行手順**: tui-accumulator.tsの内容確認
- **期待結果**: extractCopilotContentLines, normalizeCopilotLineがexportされている
- **確認観点**: 受入条件「Copilot用TuiAccumulatorパターンが定義」

### TC-010: accumulateTuiContentのcliToolIdパラメータ確認
- **テスト内容**: accumulateTuiContentがcliToolIdパラメータを受け付けること
- **実行手順**: tui-accumulator.tsの関数シグネチャ確認
- **期待結果**: 第3引数にcliToolId（デフォルト'opencode'）が存在
- **確認観点**: 受入条件「Copilot用TuiAccumulatorパターンが定義」

### TC-011: cleanCopilotResponse本実装確認
- **テスト内容**: cleanCopilotResponseがplaceholderではなく本実装であること
- **実行手順**: response-cleaner.tsの内容確認
- **期待結果**: normalizeCopilotLineをimportし使用、COPILOT_SKIP_PATTERNSでフィルタ
- **確認観点**: 受入条件「cleanCopilotResponseがTUI装飾を正しく除去」

### TC-012: COPILOT_SKIP_PATTERNS拡張確認
- **テスト内容**: COPILOT_SKIP_PATTERNSが拡張されていること
- **実行手順**: cli-patterns.tsの内容確認
- **期待結果**: PASTED_TEXT_PATTERN以外にSEPARATOR, THINKING, SELECTION_LISTが含まれる
- **確認観点**: TUI装飾フィルタリング

### TC-013: response-poller.tsのisDuplicatePrompt統合確認
- **テスト内容**: checkForResponse内でisDuplicatePromptが呼ばれていること
- **実行手順**: response-poller.tsの内容確認
- **期待結果**: prompt-dedupからimportし、promptメッセージ保存前にチェック
- **確認観点**: 受入条件「同一promptメッセージの重複保存が発生しないこと」

### TC-014: Copilot蓄積コンテンツ保存フロー確認
- **テスト内容**: cliToolId === 'copilot'の場合にgetAccumulatedContentが使用されること
- **実行手順**: response-poller.tsの内容確認
- **期待結果**: Copilot条件でgetAccumulatedContent呼び出し、OpenCodeには適用されない
- **確認観点**: 受入条件「レスポンス本文が保存される」

### TC-015: resolveExtractionStartIndex Copilot分岐確認
- **テスト内容**: resolveExtractionStartIndexでCopilotがOpenCodeと同じ分岐に入ること
- **実行手順**: response-extractor.tsの内容確認
- **期待結果**: Branch 2aの条件にcopilotが含まれている
- **確認観点**: isFullScreenTui共通フラグの適切な分岐

### TC-016: session-cleanup.ts clearPromptHashCache確認
- **テスト内容**: killWorktreeSession()でpromptHashCacheがクリアされること
- **実行手順**: session-cleanup.tsの内容確認
- **期待結果**: clearPromptHashCacheのimportと呼び出しが存在
- **確認観点**: リソースリーク防止

### TC-017: サーバー起動・API応答確認
- **テスト内容**: 変更を含むサーバーが正常に起動しAPIが応答すること
- **実行手順**: ビルド→サーバー起動→API呼び出し
- **期待結果**: /api/worktrees が200応答を返す
- **確認観点**: 統合動作確認

### TC-018: 既存OpenCodeテスト回帰確認
- **テスト内容**: OpenCode用TuiAccumulatorテストが壊れていないこと
- **実行手順**: `npx vitest run tests/unit/lib/response-poller-tui-accumulator.test.ts`
- **期待結果**: 全テストパス
- **確認観点**: 受入条件「既存のOpenCode用TuiAccumulatorテストが壊れないこと」
