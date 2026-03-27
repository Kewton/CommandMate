# Issue #559 実機受入テスト計画

## テスト概要
- Issue: #559 fix: Copilot CLIのスラッシュコマンドがテキストとして処理される場合がある
- テスト日: 2026-03-27
- テスト環境: CommandMate サーバー (localhost:UAT_PORT)

## 前提条件
- CommandMateサーバーがビルド・起動可能であること
- テスト用Gitリポジトリが利用可能であること

## 変更概要
- `terminal/route.ts` にCopilot委譲ロジック追加（cliToolId === 'copilot' の場合にsendMessage()へ委譲）
- copilot.tsの変更なし

## テストケース一覧

### TC-001: ビルド成功確認
- **テスト内容**: 変更後のコードがビルドに成功すること
- **前提条件**: なし
- **実行手順**: `npm run build`
- **期待結果**: ビルドが正常に完了する（exit code 0）
- **確認観点**: 型安全性、コンパイルエラーなし

### TC-002: TypeScript型チェック
- **テスト内容**: 型エラーがないこと
- **前提条件**: なし
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: エラーなし（exit code 0）
- **確認観点**: terminal/route.tsの委譲ロジックが型安全であること

### TC-003: ESLintチェック
- **テスト内容**: コーディング規約違反がないこと
- **前提条件**: なし
- **実行手順**: `npm run lint`
- **期待結果**: エラーなし（exit code 0）
- **確認観点**: 新規コードがプロジェクトの規約に準拠

### TC-004: 単体テスト全パス
- **テスト内容**: 全単体テストがパスすること
- **前提条件**: なし
- **実行手順**: `npm run test:unit`
- **期待結果**: 全テストパス（exit code 0）
- **確認観点**: 既存テストの回帰なし、新規テスト5件パス

### TC-005: Copilot委譲テスト - スラッシュコマンド
- **テスト内容**: terminal/route.tsのCopilot委譲テストがパスすること（スラッシュコマンド）
- **前提条件**: なし
- **実行手順**: `npx vitest run tests/unit/terminal-route.test.ts --reporter=verbose`
- **期待結果**: "delegates slash command to sendMessage" テストがパス
- **確認観点**: cliToolId='copilot'でsendMessage()が呼ばれること

### TC-006: Copilot委譲テスト - 通常テキスト
- **テスト内容**: 通常テキストもCopilotの場合はsendMessage()に委譲されること
- **前提条件**: なし
- **実行手順**: TC-005と同じテストファイル内で確認
- **期待結果**: "delegates regular text to sendMessage" テストがパス
- **確認観点**: 通常テキストもwaitForPromptの恩恵を受けること
- **注記**: 受入条件5「先頭空白付きスラッシュコマンド」について、設計変更によりCopilotの全コマンドをsendMessage()に委譲するため、terminal/route.ts側での個別判定は不要。先頭空白処理はsendMessage()内のextractSlashCommand(message.trim())で対応済み

### TC-007: 他ツール非影響確認
- **テスト内容**: Claude等他ツールはsendKeys()で処理されること
- **前提条件**: なし
- **実行手順**: TC-005と同じテストファイル内で確認
- **期待結果**: "does not delegate for non-copilot tools" テストがパス
- **確認観点**: 他ツールの動作に影響がないこと

### TC-008: エラーハンドリング確認
- **テスト内容**: sendMessage()がthrowした場合に500エラーが返されること
- **前提条件**: なし
- **実行手順**: TC-005と同じテストファイル内で確認
- **期待結果**: "returns 500 when sendMessage throws" テストがパス
- **確認観点**: エラー情報が漏洩しないこと

### TC-009: サーバー起動・API疎通確認
- **テスト内容**: サーバーが起動し、worktrees APIが応答すること
- **前提条件**: ビルド完了
- **実行手順**: サーバー起動後 `curl -s http://localhost:{port}/api/worktrees`
- **期待結果**: JSON配列が返却される
- **確認観点**: サーバーが正常に動作すること

### TC-010: Terminal API エンドポイント疎通確認
- **テスト内容**: Terminal APIエンドポイントがリクエストを受け付けること
- **前提条件**: サーバー起動中
- **実行手順**: `curl -s -X POST http://localhost:{port}/api/worktrees/test-id/terminal -H "Content-Type: application/json" -d '{"cliToolId":"copilot","command":"/model"}'`
- **期待結果**: 404（worktree not found）が返る（実在しないIDのため）。400（Invalid cliToolId）が返らないことで、copilotがcliToolIdとして認識されていることを確認
- **確認観点**: copilotがisCliToolType()で有効なツールとして認識されること

### TC-011: CLAUDE.md更新確認
- **テスト内容**: CLAUDE.mdにterminal/route.tsのCopilot委譲ロジックが記載されていること
- **前提条件**: なし
- **実行手順**: `grep -c "Issue #559" CLAUDE.md`
- **期待結果**: 1以上のマッチ
- **確認観点**: ドキュメントが最新化されていること
- **注記**: 受入条件7のうち「copilot.tsエントリにpublicスラッシュコマンド判定メソッド追加を反映」は設計変更（アプローチC改）によりisSlashCommand()メソッド追加が不要になったため対象外。terminal/route.tsエントリのみ更新対象

### TC-012: terminal/route.ts 実装確認
- **テスト内容**: terminal/route.tsにCopilot委譲ロジックが正しく実装されていること
- **前提条件**: なし
- **実行手順**: `grep -A5 "cliToolId === 'copilot'" src/app/api/worktrees/\[id\]/terminal/route.ts`
- **期待結果**: sendMessage()への委譲コードが存在し、早期returnしていること
- **確認観点**: 設計方針書通りの実装であること
