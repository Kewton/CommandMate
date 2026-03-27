# Issue #545 実機受入テスト計画

## テスト概要
- Issue: #545 Copilot-cliに対応したい
- テスト日: 2026-03-26
- テスト環境: CommandMate サーバー (localhost:TBD)

## 前提条件
- CommandMateサーバーがビルド・起動可能であること
- テスト用のGitリポジトリが存在すること
- gh copilot CLIのインストールは不要（コード統合レベルのテスト）

## テストケース一覧

### TC-001: CLI_TOOL_IDSにcopilotが含まれる
- **テスト内容**: サーバー起動後、CLIツール一覧APIでcopilotが返されること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s http://localhost:{port}/api/cli-tools | jq .`
- **期待結果**: レスポンスにcopilotツールのエントリが含まれる
- **確認観点**: copilotがAIエージェント一覧に表示される

### TC-002: copilotの表示名が正しい
- **テスト内容**: CLIツール情報APIでcopilotの表示名が'Copilot'であること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s http://localhost:{port}/api/cli-tools | jq '.[] | select(.id == "copilot")'`
- **期待結果**: `name` が "GitHub Copilot"、`id` が "copilot"
- **確認観点**: copilotがAIエージェント一覧に表示される

### TC-003: worktree一覧APIが正常動作する（既存機能影響確認）
- **テスト内容**: copilot追加後もworktree一覧APIが正常に動作すること
- **前提条件**: サーバー起動済み、リポジトリ登録済み
- **実行手順**: `curl -s http://localhost:{port}/api/worktrees | jq .`
- **期待結果**: HTTP 200、worktree一覧が返される
- **確認観点**: 既存エージェントに影響がない

### TC-004: リポジトリスキャンが正常動作する（既存機能影響確認）
- **テスト内容**: copilot追加後もリポジトリスキャンが正常に動作すること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s -X POST http://localhost:{port}/api/repositories/scan -H 'Content-Type: application/json' -d '{"repositoryPath":"..."}'`
- **期待結果**: HTTP 200、リポジトリ情報が返される
- **確認観点**: 既存エージェントに影響がない

### TC-005: Webフロントエンドが正常表示される
- **テスト内容**: ブラウザでトップページがエラーなく表示されること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s -o /dev/null -w '%{http_code}' http://localhost:{port}/`
- **期待結果**: HTTP 200（または302リダイレクト）
- **確認観点**: 既存エージェントに影響がない

### TC-006: ビルドが成功すること
- **テスト内容**: Next.jsビルドがエラーなく完了すること
- **前提条件**: なし
- **実行手順**: `npm run build` の結果確認
- **期待結果**: ビルド成功（exit code 0）
- **確認観点**: 既存エージェントに影響がない

### TC-007: TypeScript型チェックが通ること
- **テスト内容**: `npx tsc --noEmit` がエラーなく完了すること
- **前提条件**: なし
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: exit code 0、エラーなし
- **確認観点**: 既存エージェントに影響がない

### TC-008: ESLintがパスすること
- **テスト内容**: `npm run lint` がエラーなく完了すること
- **前提条件**: なし
- **実行手順**: `npm run lint`
- **期待結果**: exit code 0、エラーなし
- **確認観点**: 既存エージェントに影響がない

### TC-009: ユニットテストがパスすること
- **テスト内容**: `npm run test:unit` が全テストパスすること
- **前提条件**: なし
- **実行手順**: `npm run test:unit`
- **期待結果**: 全テストパス
- **確認観点**: 既存エージェントに影響がない、CLI側のCLI_TOOL_IDSがサーバー側と同期

### TC-010: CLIツール一覧が6ツール返す
- **テスト内容**: CLIToolManagerが6ツール（claude,codex,gemini,vibe-local,opencode,copilot）を返すこと
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s http://localhost:{port}/api/cli-tools | jq 'length'`
- **期待結果**: 6
- **確認観点**: copilotがAIエージェント一覧に表示される

### TC-011: copilotのインストール状態が取得できる
- **テスト内容**: copilotのインストール状態がAPIレスポンスに含まれること
- **前提条件**: サーバー起動済み
- **実行手順**: `curl -s http://localhost:{port}/api/cli-tools | jq '.[] | select(.id == "copilot") | .installed'`
- **期待結果**: true または false（エラーにならないこと）
- **確認観点**: copilotセッションの起動・停止ができる（前提となるインストール確認）

### TC-012: AgentSettingsPaneでcopilotが選択可能
- **テスト内容**: フロントエンドのエージェント設定画面でcopilotが選択肢として表示されること
- **前提条件**: サーバー起動済み、worktreeが存在すること
- **実行手順**: ブラウザで worktree 詳細画面のエージェント設定を確認
- **期待結果**: copilotのチェックボックスが表示される
- **確認観点**: copilotがAIエージェント一覧に表示される
