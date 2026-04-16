# Issue #649 作業計画書 - アシスタントチャット機能

## Issue概要

**Issue番号**: #649  
**タイトル**: アシスタントチャット機能  
**サイズ**: Large（新規APIルート4本 + 新規コンポーネント2本 + 既存ファイル変更3本）  
**優先度**: Medium（Home画面機能拡張、既存worktree機能への副作用リスクあり）

---

## コードベース調査で確認した重要事項

- `BaseCLITool.getSessionName('__global__')` は `mcbd-{cli_tool_id}-__global__` を生成する（既存の SESSION_NAME_PATTERN に適合）
- `chat_messages` / `session_states` テーブルは `worktrees.id` への FOREIGN KEY を持つ → Phase 1 では DB 操作を一切行わない方針が必須
- 既存 `response-checker.ts` は冒頭の `getWorktreeById()` チェックで `__global__` を即停止するため、専用ポーリング関数が必要
- `worktrees/[id]/terminal/route.ts` のAPIパターンを参考に全APIルートを実装

---

## タスク分解

### Phase 1: 型・定数定義

- [ ] **Task 1.1**: グローバルセッション定数定義
  - 成果物: `src/lib/session/global-session-constants.ts` (新規)
  - 定義: `GLOBAL_SESSION_WORKTREE_ID = '__global__'`, `GLOBAL_POLL_INTERVAL_MS`, `GLOBAL_POLL_MAX_RETRIES`
  - 依存: なし

- [ ] **Task 1.2**: アシスタントAPI型定義
  - 成果物: `src/types/assistant.ts` (新規)
  - 定義: `StartAssistantRequest`, `StartAssistantResponse`, `AssistantTerminalRequest`, `AssistantCurrentOutputResponse`, `DeleteAssistantSessionRequest`
  - 依存: なし

---

### Phase 2: バックエンド実装

- [ ] **Task 2.1**: グローバルセッション専用ポーリング関数
  - 成果物: `src/lib/polling/global-session-poller.ts` (新規)
  - 内容: `pollGlobalSession(cliToolId)`, `stopGlobalSessionPolling(cliToolId)`, `stopAllGlobalSessionPolling()`
  - DB チェック（`getWorktreeById`）をスキップ、tmux capturePane のみ使用
  - キー: `__global__:{cliToolId}` 形式
  - 依存: Task 1.1, `tmux-capture-cache.ts`, `tmux.ts`

- [ ] **Task 2.2**: POST /api/assistant/start
  - 成果物: `src/app/api/assistant/start/route.ts` (新規)
  - 処理: cliToolId検証 → ディレクトリバリデーション → ツールインストール確認 → セッション作成 → デフォルトコンテキスト送信
  - DB操作なし
  - 依存: Task 1.1, 1.2, 2.6

- [ ] **Task 2.3**: POST /api/assistant/terminal
  - 成果物: `src/app/api/assistant/terminal/route.ts` (新規)
  - 処理: cliToolId検証 → commandバリデーション → `hasSession()` チェック → `sendKeys()` → キャッシュ無効化
  - DB操作なし
  - 依存: Task 1.1, 1.2

- [ ] **Task 2.4**: GET /api/assistant/current-output
  - 成果物: `src/app/api/assistant/current-output/route.ts` (新規)
  - 処理: cliTool検証 → `hasSession()` → `capturePane()` → レスポンス返却
  - DB操作なし
  - 依存: Task 1.1, 1.2

- [ ] **Task 2.5**: DELETE /api/assistant/session
  - 成果物: `src/app/api/assistant/session/route.ts` (新規)
  - 処理: cliToolId検証 → `stopGlobalSessionPolling()` → `killSession()` → キャッシュ無効化
  - DB操作なし
  - 依存: Task 1.1, 1.2, 2.1

- [ ] **Task 2.6**: デフォルトコンテキスト生成ロジック
  - 成果物: `src/lib/assistant/context-builder.ts` (新規)
  - 関数: `buildGlobalContext(cliToolId, db): string`
  - 内容: `getAllRepositories(db)` + CLIツール毎の使い方テキスト
  - 依存: Task 1.1, `db-repository.ts`

- [ ] **Task 2.7**: session-cleanup.ts に cleanupGlobalSessions() 追加
  - 成果物: `src/lib/session-cleanup.ts` (変更)
  - 関数: `cleanupGlobalSessions(): Promise<string[]>`
  - `CLI_TOOL_IDS` ループで `mcbd-{cli_tool_id}-__global__` パターンを検出・停止
  - `syncWorktreesAndCleanup()` から呼び出し
  - 依存: Task 1.1, 2.1

- [ ] **Task 2.8**: worktree-status-helper.ts のグローバルセッション除外フィルタ
  - 成果物: `src/lib/session/worktree-status-helper.ts` (変更)
  - `detectWorktreeSessionStatus()` の冒頭に `__global__` 早期リターンを追加
  - 依存: Task 1.1

- [ ] **Task 2.9**: APIクライアント追加
  - 成果物: `src/lib/api-client.ts` (変更) または `src/lib/api/assistant-api.ts` (新規)
  - `assistantApi.start()`, `assistantApi.sendCommand()`, `assistantApi.getCurrentOutput()`, `assistantApi.stopSession()`
  - 依存: Task 1.2

---

### Phase 3: フロントエンド実装

- [ ] **Task 3.1**: AssistantMessageInput コンポーネント
  - 成果物: `src/components/home/AssistantMessageInput.tsx` (新規)
  - 送信専用（スラッシュコマンド・画像添付なし）
  - Props: `cliToolId`, `isSessionRunning`, `onMessageSent`
  - 送信時: `assistantApi.sendCommand()` 呼び出し
  - ダークモード対応
  - 依存: Task 2.9

- [ ] **Task 3.2**: AssistantChatPanel コンポーネント
  - 成果物: `src/components/home/AssistantChatPanel.tsx` (新規)
  - 機能: 折りたたみ・最大50vh・ポーリング・セッション開始/停止・出力表示
  - リポジトリ選択（`repositoryApi.list()`）+ CLIツール選択
  - モバイル: タブ切替（`useIsMobile` hook利用）
  - 出力表示: `sanitizeTerminalOutput` 経由でXSS防止
  - ダークモード対応
  - 依存: Task 3.1, 2.9

- [ ] **Task 3.3**: src/app/page.tsx への組み込み
  - 成果物: `src/app/page.tsx` (変更)
  - `AssistantChatPanel` を Session Overview の上部に挿入
  - モバイル: 「Assistant」「Overview」タブ
  - デスクトップ: Session Overview の上に追加
  - 依存: Task 3.2

---

### Phase 4: テスト

- [ ] **Task 4.1**: global-session-poller.ts ユニットテスト
  - 成果物: `tests/unit/global-session-poller.test.ts` (新規)
  - セッション存在/非存在時のキャプチャ動作・ポーリング停止テスト
  - 依存: Task 2.1

- [ ] **Task 4.2**: cleanupGlobalSessions テスト
  - 成果物: `tests/unit/session-cleanup-global.test.ts` (新規)
  - 実行中/非実行中セッションの停止動作・既存テストの回帰確認
  - 依存: Task 2.7

- [ ] **Task 4.3**: /api/assistant/* APIルートのユニットテスト
  - 成果物: `tests/unit/api-assistant.test.ts` (新規)
  - 正常系・異常系（不正cliToolId, 未インストール, 404）・認証テスト
  - 依存: Task 2.2〜2.5

- [ ] **Task 4.4**: context-builder.ts テスト
  - 成果物: `tests/unit/assistant-context-builder.test.ts` (新規)
  - リポジトリ情報出力確認・CLIツール別ヘルプテキスト確認
  - 依存: Task 2.6

- [ ] **Task 4.5**: 品質チェック
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm run test:unit`

---

### Phase 5: ドキュメント

- [ ] **Task 5.1**: CLAUDE.md のモジュール一覧更新
  - 成果物: `CLAUDE.md` (変更)
  - 追加: 新規APIルート・コンポーネント・lib モジュール

---

## タスク依存関係

```
1.1, 1.2 (型定数)
  └→ 2.1 (global-session-poller)
  └→ 2.2, 2.3, 2.4 (APIルート)
  └→ 2.5 (DELETE session)
  └→ 2.6 (context-builder)
  └→ 2.7 (session-cleanup拡張)
  └→ 2.8 (status-helper フィルタ)

2.1, 2.5, 2.6 → 2.2 (start API でコンテキスト送信・ポーリング停止)
2.2, 2.3, 2.4, 2.5 → 2.9 (APIクライアント)
2.9 → 3.1, 3.2
3.1, 3.2 → 3.3

Phase 2,3 → Phase 4 (テスト)
Phase 4 → Phase 5 (ドキュメント)
```

---

## 品質チェック項目

| カテゴリ | チェック項目 |
|---------|------------|
| セキュリティ | `directory` パラメータの null byte / system directory チェック |
| セキュリティ | `cliToolId` の `isCliToolType()` 検証が全APIルートに存在 |
| セキュリティ | `command` の `MAX_COMMAND_LENGTH` 制限 |
| セキュリティ | `/api/assistant/*` が `AUTH_EXCLUDED_PATHS` に含まれないこと |
| セキュリティ | `sanitizeTerminalOutput` 経由でのXSS防止 |
| DB制約 | 全APIルートで INSERT/UPDATE がないこと |
| 既存機能 | `detectWorktreeSessionStatus()` が `__global__` を除外すること |
| 既存機能 | 既存 worktree セッション API の挙動に影響がないこと |
| 型安全性 | `npx tsc --noEmit` パス |
| スタイル | `npm run lint` パス |
| テスト | `npm run test:unit` パス |
| UI | ダークモード対応（`dark:` クラス） |
| UI | `useIsMobile` によるモバイル対応 |

---

## Definition of Done

- [ ] Home 画面でアシスタントチャットが表示・利用できる
- [ ] 登録済みリポジトリの一覧から作業ディレクトリを選択できる
- [ ] インストール済み全CLIツール（最大6種）からセッションを開始できる
- [ ] セッション開始時に CLI 使い方・リポジトリ情報がコンテキストとして付与される
- [ ] メッセージの送受信・ターミナル出力表示が正常に動作する
- [ ] セッション停止 UI が機能する
- [ ] グローバルセッションがサーバー起動/終了時にクリーンアップされる
- [ ] グローバルセッションが worktree サイドバーに表示されない
- [ ] 既存の worktree セッション機能に影響がない
- [ ] ダークモード対応
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` がパスする
- [ ] `/api/assistant/*` が認証保護されている

---

## Phase 1 スコープ外（Phase 2 引き継ぎ事項）

| 機能 | 理由 | Phase 2 での対応 |
|-----|------|----------------|
| Auto-Yes | resource-cleanup の孤立判定問題 | 予約 ID スキップロジック追加 |
| スラッシュコマンド | `worktreeId` 必須の現実装 | グローバルセッション対応版に拡張 |
| 画像添付 | アップロードパスの整合性問題 | パス解決ロジック再設計 |
| チャット履歴 DB 保存 | FOREIGN KEY 制約 | worktrees テーブル拡張または別テーブル作成 |
| 会話ログ出力 | DB 保存なし方針との矛盾 | DB 保存実装後に対応 |
| resource-cleanup 予約 ID | `__global__` が孤立判定される | `__global__` スキップ条件追加 |
