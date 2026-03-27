# Issue #547 実機受入テスト計画

## テスト概要
- Issue: #547 fix: Copilot CLIのデフォルトスラッシュコマンドと選択ウィンドウが動作しない
- テスト日: 2026-03-27
- テスト環境: CommandMate サーバー (localhost:{port})

## 前提条件
- ビルドが成功すること
- テスト用リポジトリが登録されていること

## テストケース一覧

### TC-001: ビルド成功確認
- **テスト内容**: 変更後のコードが正常にビルドできること
- **前提条件**: なし
- **実行手順**: `npm run build`
- **期待結果**: exit code 0、エラーなし
- **確認観点**: 型エラー・コンパイルエラーがないこと

### TC-002: TypeScript型チェック
- **テスト内容**: TypeScript strict modeで型エラーがないこと
- **前提条件**: なし
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: exit code 0
- **確認観点**: 新規追加コードの型安全性

### TC-003: ESLint チェック
- **テスト内容**: コーディング規約違反がないこと
- **前提条件**: なし
- **実行手順**: `npm run lint`
- **期待結果**: exit code 0
- **確認観点**: 新規コードのリント準拠

### TC-004: 単体テスト全パス
- **テスト内容**: 全単体テストがパスすること
- **前提条件**: なし
- **実行手順**: `npm run test:unit`
- **期待結果**: exit code 0、全テストパス
- **確認観点**: 新規テスト含む全テストの通過、回帰なし

### TC-005: スラッシュコマンドAPI - Copilotビルトインコマンド確認
- **テスト内容**: スラッシュコマンドAPIがCopilotビルトイン（/model）を返すこと
- **前提条件**: サーバー起動済み、worktree登録済み
- **実行手順**: `curl -s http://localhost:{port}/api/worktrees/{worktree_id}/slash-commands`
- **期待結果**: レスポンスにname: "model"のコマンドが含まれる
- **確認観点**: 受入条件「/ 入力時にCopilot CLIのスラッシュコマンド候補が表示される」

### TC-006: スラッシュコマンドAPI - 既存Claude/Codexコマンド影響なし
- **テスト内容**: 既存のClaude向けスラッシュコマンドが正常に返却されること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s http://localhost:{port}/api/worktrees/{worktree_id}/slash-commands`
- **期待結果**: 既存コマンド（claude系）が変わらず含まれる
- **確認観点**: 受入条件「既存エージェントのスラッシュコマンドに影響がない」

### TC-007: SELECTION_LIST_REASONS定数の確認（コード検証）
- **テスト内容**: SELECTION_LIST_REASONS SetにCopilot含む3ツールのreasonが含まれること
- **前提条件**: なし
- **実行手順**: `grep -A5 'SELECTION_LIST_REASONS' src/lib/detection/status-detector.ts`
- **期待結果**: opencode_selection_list, claude_selection_list, copilot_selection_list の3つが含まれる
- **確認観点**: 受入条件「STATUS_REASON.COPILOT_SELECTION_LIST定数が追加されている」

### TC-008: current-output/route.ts OR条件置換確認（コード検証）
- **テスト内容**: isSelectionListActiveがSELECTION_LIST_REASONS.has()を使用していること
- **前提条件**: なし
- **実行手順**: `grep 'SELECTION_LIST_REASONS' src/app/api/worktrees/\[id\]/current-output/route.ts`
- **期待結果**: SELECTION_LIST_REASONS.has(statusResult.reason) が存在、旧OR条件が存在しない
- **確認観点**: 受入条件「isSelectionListActiveがCopilot選択リストを含む」

### TC-009: getCopilotBuiltinCommands cliTools確認（コード検証）
- **テスト内容**: CopilotビルトインコマンドにcliTools: ['copilot']が設定されていること
- **前提条件**: なし
- **実行手順**: `grep -A3 "getCopilotBuiltinCommands" src/lib/slash-commands.ts | head -20`
- **期待結果**: cliTools: ['copilot'] が含まれる
- **確認観点**: 受入条件「CopilotビルトインコマンドにcliTools: ['copilot']が設定されている」

### TC-010: サーバー起動・基本動作確認
- **テスト内容**: サーバーが正常に起動し、基本APIが応答すること
- **前提条件**: ビルド成功
- **実行手順**: サーバー起動後、`curl -s http://localhost:{port}/api/worktrees`
- **期待結果**: JSON配列が返却される
- **確認観点**: 変更によるサーバー起動への影響なし
