# Issue #525 実機受入テスト計画

## テスト概要
- Issue: #525 auto yesの改善（エージェント毎独立制御）
- テスト日: 2026-03-20
- テスト環境: CommandMate サーバー (localhost:{UAT_PORT})

## 前提条件
- CommandMateサーバーが起動していること
- テスト用リポジトリが登録されていること
- worktreeが1つ以上存在すること

## テストケース一覧

### TC-001: auto-yes API POST - cliToolId指定でenable
- **テスト内容**: POST /api/worktrees/:id/auto-yes でcliToolId指定のauto-yes有効化
- **前提条件**: worktreeが存在すること
- **実行手順**: `curl -X POST http://localhost:{port}/api/worktrees/{id}/auto-yes -H "Content-Type: application/json" -d '{"enabled":true,"duration":3600000,"cliToolId":"claude"}'`
- **期待結果**: 200 OK、`{"enabled":true,"expiresAt":...}`
- **確認観点**: 受入条件1（UIから各エージェント毎にauto-yesを独立してON/OFFできる）

### TC-002: auto-yes API POST - 異なるエージェントで同時enable
- **テスト内容**: claude と codex を同時にauto-yes有効化
- **前提条件**: TC-001完了後
- **実行手順**:
  1. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"claude"}'`
  2. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":10800000,"cliToolId":"codex"}'`
- **期待結果**: 両方200 OK、それぞれ異なるexpiresAt
- **確認観点**: 受入条件5（複数エージェントで同時有効化、期間を個別設定可能）

### TC-003: auto-yes API GET - cliToolId指定で状態取得
- **テスト内容**: GET /api/worktrees/:id/auto-yes?cliToolId=claude で特定エージェントの状態取得
- **前提条件**: TC-002完了後（claude, codex共にenable済み）
- **実行手順**: `curl http://localhost:{port}/api/worktrees/{id}/auto-yes?cliToolId=claude`
- **期待結果**: 200 OK、claudeのみの状態（`{"enabled":true,"expiresAt":...}`）
- **確認観点**: 受入条件2（どのエージェントでauto-yesが有効か分かる）

### TC-004: auto-yes API GET - cliToolId省略で全エージェント状態取得
- **テスト内容**: GET /api/worktrees/:id/auto-yes（パラメータなし）で全エージェントの状態取得
- **前提条件**: TC-002完了後
- **実行手順**: `curl http://localhost:{port}/api/worktrees/{id}/auto-yes`
- **期待結果**: 200 OK、全エージェント分のマップ形式（`{"claude":{"enabled":true,...},"codex":{"enabled":true,...}}`）
- **確認観点**: 受入条件2

### TC-005: auto-yes API POST - 特定エージェントのみdisable
- **テスト内容**: claude のみdisable、codexは維持
- **前提条件**: TC-002完了後
- **実行手順**:
  1. `curl -X POST .../auto-yes -d '{"enabled":false,"cliToolId":"claude"}'`
  2. `curl .../auto-yes?cliToolId=claude` → disabled確認
  3. `curl .../auto-yes?cliToolId=codex` → 依然enabled確認
- **期待結果**: claudeはdisabled、codexはenabled維持
- **確認観点**: 受入条件1, 5

### TC-006: auto-yes API POST - 不正cliToolIdで400エラー
- **テスト内容**: 存在しないcliToolIdを指定して400エラーが返ること
- **前提条件**: worktreeが存在すること
- **実行手順**: `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"invalid_tool"}'`
- **期待結果**: 400 Bad Request、エラーメッセージ
- **確認観点**: セキュリティ（不正入力の拒否）

### TC-007: auto-yes API POST - cliToolId省略でデフォルトclaude
- **テスト内容**: cliToolId省略時にデフォルトのclaudeとして扱われること
- **前提条件**: worktreeが存在すること
- **実行手順**:
  1. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000}'`
  2. `curl .../auto-yes?cliToolId=claude`
- **期待結果**: claudeのauto-yesがenabled
- **確認観点**: 受入条件6（既存のauto-yes動作に影響がない）

### TC-008: current-output API - エージェント毎のautoYes状態
- **テスト内容**: GET /api/worktrees/:id/current-output?cliTool=claude でautoYes状態確認
- **前提条件**: claudeのauto-yesがenable済み
- **実行手順**: `curl http://localhost:{port}/api/worktrees/{id}/current-output?cliTool=claude`
- **期待結果**: レスポンスのautoYesフィールドにclaude固有の状態
- **確認観点**: 受入条件4（UIからの設定変更がcapture --jsonに反映）

### TC-009: auto-yes API POST - cliToolId未指定でdisable（全エージェント停止）
- **テスト内容**: cliToolId未指定のdisableで全エージェント停止
- **前提条件**: claude, codex共にenable済み
- **実行手順**:
  1. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"claude"}'`
  2. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"codex"}'`
  3. `curl -X POST .../auto-yes -d '{"enabled":false}'`
  4. `curl .../auto-yes` で全状態確認
- **期待結果**: 全エージェントがdisabled
- **確認観点**: 受入条件1

### TC-010: auto-yes API POST - stopPattern個別設定
- **テスト内容**: エージェント毎に異なるstopPatternを設定
- **前提条件**: worktreeが存在すること
- **実行手順**:
  1. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"claude","stopPattern":"error"}'`
  2. `curl -X POST .../auto-yes -d '{"enabled":true,"duration":3600000,"cliToolId":"codex","stopPattern":"fatal"}'`
  3. 各エージェントの状態を確認
- **期待結果**: 各エージェントが個別のstopPatternを保持
- **確認観点**: 受入条件5（停止条件を個別設定可能）

### TC-011: auto-yes API GET - 不正worktreeIdで400/404エラー
- **テスト内容**: 不正なworktreeIdでAPIアクセス時にエラー
- **前提条件**: なし
- **実行手順**: `curl http://localhost:{port}/api/worktrees/invalid../auto-yes`
- **期待結果**: 400または404エラー
- **確認観点**: セキュリティ（入力バリデーション）

### TC-012: 静的解析の確認
- **テスト内容**: TypeScript型チェックとESLintがパスすること
- **前提条件**: なし
- **実行手順**:
  1. `npx tsc --noEmit`
  2. `npm run lint`
- **期待結果**: エラー0件
- **確認観点**: 品質保証
