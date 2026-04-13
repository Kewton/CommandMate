# CLAUDE.md

このドキュメントはClaude Code向けのプロジェクトガイドラインです。

---

## プロジェクト概要

### 基本情報
- **プロジェクト名**: CommandMate
- **説明**: Git worktree管理とClaude CLI/tmuxセッション統合ツール
- **リポジトリ**: https://github.com/Kewton/CommandMate

### 技術スタック
| カテゴリ | 技術 |
|---------|------|
| **フレームワーク** | Next.js 14 |
| **言語** | TypeScript |
| **スタイル** | Tailwind CSS |
| **データベース** | SQLite (better-sqlite3) |
| **テスト** | Vitest (unit/integration), Playwright (e2e) |

---

## ブランチ構成

### ブランチ戦略
```
main (本番) ← PRマージのみ
  │
develop (受け入れ・動作確認)
  │
feature/*, fix/*, hotfix/* (作業ブランチ)
```

### 命名規則
| ブランチ種類 | パターン | 例 |
|-------------|----------|-----|
| 機能追加 | `feature/<issue-number>-<description>` | `feature/123-add-dark-mode` |
| バグ修正 | `fix/<issue-number>-<description>` | `fix/456-fix-login-error` |
| 緊急修正 | `hotfix/<description>` | `hotfix/critical-security-fix` |
| ドキュメント | `docs/<description>` | `docs/update-readme` |

---

## 標準マージフロー

### 通常フロー
```
feature/* ──PR──> develop ──PR──> main
fix/*     ──PR──> develop ──PR──> main
hotfix/*  ──PR──> main (緊急時のみ)
```

### PRルール
1. **PRタイトル**: `<type>: <description>` 形式
   - 例: `feat: add dark mode toggle`
   - 例: `fix: resolve login error`
2. **PRラベル**: 種類に応じたラベルを付与
   - `feature`, `bug`, `documentation`, `refactor`
3. **レビュー**: 1名以上の承認必須（main向けPR）
4. **CI/CD**: 全チェックパス必須

### コミットメッセージ規約
```
<type>(<scope>): <subject>

<body>

<footer>
```

| type | 説明 |
|------|------|
| `feat` | 新機能 |
| `fix` | バグ修正 |
| `docs` | ドキュメント |
| `style` | フォーマット（機能変更なし） |
| `refactor` | リファクタリング |
| `test` | テスト追加・修正 |
| `chore` | ビルド・設定変更 |
| `ci` | CI/CD設定 |

---

## コーディング規約

### TypeScript
- 厳格な型定義を使用（`strict: true`）
- `any` 型の使用は最小限に
- 明示的な戻り値の型定義を推奨

### React/Next.js
- 関数コンポーネントを使用
- Server Components優先
- クライアントコンポーネントは `'use client'` を明示

### ファイル構成
```
bin/
└── commandmate.js     # CLIエントリポイント（shebang付き）

src/
├── app/           # Next.js App Router
│   ├── api/       # APIルート
│   ├── sessions/  # Sessions画面（Issue #600）
│   ├── repositories/ # Repositories画面（Issue #600）
│   ├── review/    # Review画面（Issue #600）
│   └── more/      # More画面（Issue #600）
├── cli/           # CLIモジュール（Issue #96）
│   ├── index.ts       # CLIメインロジック（commander設定）
│   ├── commands/      # サブコマンド（init, start, stop, status, ls, send, wait, respond, capture, auto-yes）
│   ├── utils/         # 依存チェック、環境設定、デーモン管理
│   ├── config/        # 依存関係定義
│   └── types/         # CLI共通型定義（ExitCode enum）
├── components/    # UIコンポーネント
│   ├── common/    # 再利用可能な共通UIコンポーネント（Toast等）
│   ├── home/      # Home画面コンポーネント（Issue #600）
│   ├── layout/    # レイアウトコンポーネント（Header, AppShell）
│   ├── mobile/    # モバイル専用
│   ├── providers/ # プロバイダーコンポーネント（Issue #600）
│   ├── review/    # Review画面コンポーネント（Issue #600）
│   ├── sidebar/   # サイドバー関連
│   └── worktree/  # ワークツリー詳細
├── config/        # 設定（ステータス色、編集可能拡張子など）
├── contexts/      # React Context
├── hooks/         # カスタムフック（useContextMenu等）
├── lib/           # ユーティリティ・ビジネスロジック
│   ├── api/       # APIユーティリティ（Issue #600）
│   ├── cli-tools/ # CLIツール抽象化層
│   ├── db/        # データベース（Issue #481）
│   ├── tmux/      # tmuxセッション管理・トランスポート（Issue #481）
│   ├── security/  # 認証・IP制限・パス検証・サニタイズ（Issue #481）
│   ├── detection/ # ステータス検出・プロンプト検出（Issue #481）
│   ├── session/   # セッション管理・実行エンジン（Issue #481）
│   ├── polling/   # ポーリング・Auto-Yes（Issue #481）
│   └── git/       # Git操作・worktree管理・クローン（Issue #481）
└── types/         # 型定義

tests/
├── helpers/       # テスト共通ヘルパー（型ガード、loggerモック等）
├── unit/          # 単体テスト
└── integration/   # 結合テスト
```

### 主要モジュール一覧

詳細（Issue番号・関数シグネチャ・定数・セキュリティ注釈）は [モジュールリファレンス](./docs/module-reference.md) を参照。

| モジュール | 役割 |
|-----------|------|
| `src/middleware.ts` | 認証ミドルウェア（Edge Runtime） |
| `src/lib/security/auth.ts` | トークン認証コア |
| `src/lib/security/ip-restriction.ts` | IP/CIDR制限 |
| `src/config/auth-config.ts` | 認証設定定数 |
| `src/lib/env.ts` | 環境変数取得・フォールバック |
| `src/lib/db/db-instance.ts` | DBインスタンス管理 |
| `src/lib/db/db-path-resolver.ts` | DBパス解決 |
| `src/lib/db/db-migration-path.ts` | DBマイグレーション |
| `src/lib/db/db-repository.ts` | リポジトリDB操作 |
| `src/lib/db/worktree-db.ts` | Worktree CRUD操作、archivedフィルタ対応（Issue #479, #168） |
| `src/lib/db/chat-db.ts` | チャットメッセージCRUD操作、論理削除（archived）・GetMessagesOptions・ACTIVE_FILTER（Issue #479, #168） |
| `src/lib/db/session-db.ts` | セッション状態管理（Issue #479） |
| `src/lib/db/memo-db.ts` | メモ管理CRUD（Issue #479） |
| `src/lib/db/timer-db.ts` | タイマーメッセージCRUD操作（Issue #534） |
| `src/lib/db/template-db.ts` | レポートテンプレートCRUD操作（getAllTemplates, getTemplateById, createTemplate, updateTemplate, deleteTemplate, getTemplateCount）（Issue #618） |
| `src/lib/tmux/tmux.ts` | tmuxセッション管理基盤（execFile使用） |
| `src/lib/tmux/tmux-capture-cache.ts` | tmux captureキャッシュ（TTL=2秒、singleflight） |
| `src/lib/session/claude-session.ts` | Claude CLIセッション管理・ヘルスチェック |
| `src/lib/detection/status-detector.ts` | セッションステータス検出、SELECTION_LIST_REASONS Set定数（Issue #547） |
| `src/lib/session/worktree-status-helper.ts` | Worktreeセッションステータス一括検出 |
| `src/lib/polling/response-poller.ts` | レスポンスポーリング・ポーリング制御バレルファイル（Issue #479）、重複防止(prompt-dedup統合)・蓄積コンテンツ保存機能（Issue #565） |
| `src/lib/polling/prompt-dedup.ts` | プロンプト重複検出（SHA-256ハッシュキャッシュ）（Issue #565） |
| `src/lib/response-extractor.ts` | レスポンス抽出ロジック（resolveExtractionStartIndex, isOpenCodeComplete）（Issue #479）、Copilot分岐追加（Issue #565） |
| `src/lib/response-cleaner.ts` | CLIツール別レスポンスクリーニング（cleanClaudeResponse, cleanCopilotResponse等）（Issue #479, #565） |
| `src/lib/tui-accumulator.ts` | TUIアキュムレータ状態管理（Issue #479）、extractCopilotContentLines/normalizeCopilotLine追加（Issue #565） |
| `src/lib/detection/prompt-detector.ts` | プロンプト検出（2パス方式） |
| `src/lib/detection/cli-patterns.ts` | CLIツール別パターン定義、COPILOT_SELECTION_LIST_PATTERN（Issue #547）、COPILOT_SKIP_PATTERNS拡張（Issue #565） |
| `src/lib/polling/auto-yes-manager.ts` | Auto-Yes状態管理・バレルファイル・複合キーヘルパー（Issue #479, #525） |
| `src/lib/auto-yes-poller.ts` | Auto-Yesポーリングループ本体・複合キー対応（Issue #479, #525） |
| `src/lib/auto-yes-state.ts` | Auto-Yes状態管理・複合キーヘルパー（Issue #479, #525） |
| `src/lib/polling/auto-yes-resolver.ts` | Auto-Yes自動応答判定 |
| `src/config/auto-yes-config.ts` | Auto-Yes設定定数・バリデーション |
| `src/config/html-extensions.ts` | HTML拡張子定義・判定関数・SandboxLevel型・SANDBOX_ATTRIBUTES（Issue #490） |
| `src/config/file-polling-config.ts` | ファイルポーリング定数（FILE_TREE_POLL_INTERVAL_MS, FILE_CONTENT_POLL_INTERVAL_MS）（Issue #469） |
| `src/config/timer-constants.ts` | タイマー定数定義（TIMER_DELAYS, MAX_TIMERS_PER_WORKTREE, TIMER_STATUS, isValidTimerDelay）（Issue #534） |
| `src/config/copilot-constants.ts` | Copilot CLIタイミング定数（COPILOT_SEND_ENTER_DELAY_MS, COPILOT_TEXT_INPUT_DELAY_MS）（Issue #565）、MODEL_NAME_PATTERN/MAX_MODEL_NAME_LENGTH追加（Issue #588） |
| `src/config/repository-config.ts` | リポジトリ共有定数（MAX_DISPLAY_NAME_LENGTH）（Issue #644） |
| `src/config/editable-extensions.ts` | 編集可能拡張子定義・バリデーション（EDITABLE_EXTENSIONS, EXTENSION_VALIDATORS, isEditableExtension, validateContent）。.yaml/.yml 追加・YAML危険タグバリデーション（Issue #646） |
| `src/lib/detection/prompt-key.ts` | promptKey重複排除ユーティリティ |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/cli-tools/types.ts` | CLIツール型定義（IImageCapableCLITool/isImageCapableCLITool追加）（Issue #474）（Issue #545: copilot追加、6ツール対応） |
| `src/lib/cli-tools/codex.ts` | Codex CLIセッション管理 |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local CLIツール |
| `src/lib/cli-tools/opencode.ts` | OpenCode CLIツール |
| `src/lib/cli-tools/opencode-config.ts` | OpenCode設定自動生成（Ollama/LM Studio） |
| `src/lib/cli-tools/copilot.ts` | GitHub Copilot CLIセッション管理（Issue #545） |
| `src/lib/selected-agents-validator.ts` | エージェント選択バリデーション（2-4エージェント） |
| `src/lib/session/claude-executor.ts` | CLI非インタラクティブ実行エンジン |
| `src/lib/timer-manager.ts` | タイマーマネージャー（globalThis singleton、setTimeout管理、サーバー再起動リカバリ）（Issue #534） |
| `src/lib/schedule-manager.ts` | スケジューラーメイン・ジョブ登録管理（Issue #409, Issue #479）、ActiveScheduleInfo.model追加（Issue #588） |
| `src/lib/cron-parser.ts` | CMATE.md mtime検出・スケジュール一括更新（Issue #479） |
| `src/lib/job-executor.ts` | ジョブ実行エンジン・実行ログCRUD（Issue #479） |
| `src/lib/cmate-parser.ts` | CMATE.md汎用パーサー、parseAndValidateCliToolColumn連携（Issue #588） |
| `src/lib/cmate-cli-tool-parser.ts` | CLI Tool列パース・model名バリデーション共有モジュール（parseCliToolColumn, validateCopilotModelName, TOOLS_WITH_MODEL_SUPPORT）（Issue #588） |
| `src/lib/session-cleanup.ts` | セッション/ポーラー/スケジューラー停止（Facade）、killWorktreeSession共通化、syncWorktreesAndCleanup（Issue #526） |
| `src/lib/session-key-sender.ts` | Claudeセッションキー送信ロジック（Issue #479） |
| `src/lib/prompt-answer-input.ts` | プロンプト応答入力ロジック（getAnswerInput）（Issue #479） |
| `src/lib/resource-cleanup.ts` | リソースリーク対策（孤立プロセス/Map検出） |
| `src/lib/security/env-sanitizer.ts` | 環境変数サニタイズ |
| `src/lib/proxy/handler.ts` | HTTPプロキシハンドラ |
| `src/lib/proxy/config.ts` | プロキシ設定定数 |
| `src/lib/security/path-validator.ts` | パスバリデーション・symlink防御 |
| `src/lib/file-operations.ts` | ファイルCRUD操作（5層セキュリティ） |
| `src/lib/git/clone-manager.ts` | クローン処理管理（排他制御） |
| `src/lib/version-checker.ts` | バージョンアップ通知 |
| `src/lib/slash-commands.ts` | スラッシュコマンドローダー（.claude/commands, .claude/skills, .codex/skills対応、getCopilotBuiltinCommands追加）（Issue #166, #547） |
| `src/lib/link-utils.ts` | リンク種別判定・相対パス解決・hrefサニタイズ（Issue #505） |
| `src/lib/url-path-encoder.ts` | ファイルパスURLエンコード |
| `src/lib/file-search.ts` | ファイル内容検索 |
| `src/lib/terminal-highlight.ts` | CSS Custom Highlight API ラッパー（Issue #47）XSS安全なターミナルハイライト |
| `src/lib/file-tree.ts` | ディレクトリツリー構造生成 |
| `src/lib/git/git-utils.ts` | Git情報取得・コミット履歴/diff取得（Issue #447）、getCommitsByDateRange/collectRepositoryCommitLogs追加（Issue #627） |
| `src/types/git.ts` | Git関連型定義（CommitInfo, ChangedFile, GitLogResponse等）（Issue #447）、CommitLogEntry/RepositoryCommitLogs追加（Issue #627） |
| `src/lib/sidebar-utils.ts` | サイドバーソート・グループ化ユーティリティ（SortKey, SortDirection, ViewMode型, BranchGroup型, sortBranches(), groupBranches(), generateRepositoryColor()）（Issue #449, #504） |
| `src/contexts/SidebarContext.tsx` | サイドバー状態管理Context（isOpen, sortKey, viewMode, localStorageパターン）（Issue #449）、DEFAULT_SIDEBAR_WIDTH=224(w-56)に変更（Issue #651） |
| `src/lib/utils.ts` | 汎用ユーティリティ（withTimeout追加: Issue #627） |
| `src/lib/date-utils.ts` | 相対時刻フォーマット |
| `src/lib/clipboard-utils.ts` | クリップボードコピー |
| `src/lib/pasted-text-helper.ts` | Pasted text検知・Enter再送 |
| `src/lib/api-logger.ts` | 開発環境APIロギング |
| `src/lib/log-export-sanitizer.ts` | エクスポート用データサニタイズ |
| `src/i18n.ts` | next-intl設定 |
| `src/lib/locale-cookie.ts` | ロケールCookie管理 |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（メイン画面、ツリーポーリング対応、履歴・メモ挿入state管理、NewFileDialog連携）（Issue #469, #485, #646） |
| `src/components/worktree/AgentSettingsPane.tsx` | エージェント選択UI |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力（下書き永続化対応、pendingInsertText外部挿入対応）（Issue #485） |
| `src/components/worktree/ConversationPairCard.tsx` | 会話ペアカード（ユーザー/アシスタントメッセージ表示、挿入ボタン）（Issue #485） |
| `src/components/worktree/MemoCard.tsx` | メモカード（メモ表示・コピー・挿入ボタン）（Issue #485） |
| `src/components/worktree/HistoryPane.tsx` | 履歴ペイン（会話履歴表示、onInsertToMessage伝播）（Issue #485） |
| `src/components/worktree/MemoPane.tsx` | メモペイン（メモ一覧表示、onInsertToMessage伝播）（Issue #485） |
| `src/components/worktree/NotesAndLogsPane.tsx` | Notes&Logsペイン（メモ・ログタブ、onInsertToMessage伝播）（Issue #485） |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | Worktree詳細サブコンポーネント（MobileContent等、onInsertToMessage伝播）（Issue #485） |
| `src/components/worktree/MarkdownEditor.tsx` | マークダウンエディタメイン（Issue #479）、汎用テキストエディタ化・YAML等非mdファイルのプレビュー非表示対応（Issue #646） |
| `src/components/worktree/NewFileDialog.tsx` | 新規ファイル作成ダイアログ（ファイル名入力・拡張子選択、拡張子決定ロジック3パターン）（Issue #646） |
| `src/components/worktree/TerminalSearchBar.tsx` | ターミナル内テキスト検索バーUI（Issue #47）件数表示・前/次ナビ・Esc閉じ |
| `src/components/worktree/FilePanelSplit.tsx` | ターミナル+ファイルパネル分割 |
| `src/components/worktree/FilePanelTabs.tsx` | ファイルタブバーUI |
| `src/components/worktree/FilePanelContent.tsx` | ファイルコンテンツ表示（ファイル内容ポーリング対応）（Issue #469）、YAMLファイル編集ルーティング追加（Issue #646） |
| `src/components/worktree/HtmlPreview.tsx` | HTMLファイルプレビューコンポーネント（iframe srcdoc + Safe/Interactiveサンドボックス）（Issue #490） |
| `src/components/worktree/FileViewer.tsx` | ファイルビューア |
| `src/components/worktree/FileSearchBar.tsx` | ファイル検索バー共通コンポーネント（Issue #469） |
| `src/components/worktree/FileTreeView.tsx` | ファイルツリービュー（Issue #479） |
| `src/components/worktree/TreeNode.tsx` | ファイルツリーノードコンポーネント（Issue #479） |
| `src/components/worktree/TreeContextMenu.tsx` | ファイルツリーコンテキストメニュー（Issue #479） |
| `src/components/worktree/MarkdownToolbar.tsx` | マークダウンエディタツールバーUI（Issue #479） |
| `src/components/worktree/MarkdownPreview.tsx` | マークダウンプレビュー表示（Issue #479） |
| `src/components/worktree/GitPane.tsx` | Gitタブ（コミット履歴・diff表示）（Issue #447） |
| `src/components/worktree/TimerPane.tsx` | タイマーUI（登録・カウントダウン・キャンセル、visibilitychange対応ポーリング）（Issue #534） |
| `src/hooks/useFilePolling.ts` | ポーリングライフサイクル管理（visibilitychange対応）（Issue #469） |
| `src/hooks/useFileContentPolling.ts` | ファイル内容ポーリング（If-Modified-Since/304）（Issue #469） |
| `src/hooks/useFileContentSearch.ts` | ファイル内容検索共通フック（Issue #469） |
| `src/hooks/useFileTabs.ts` | タブ状態管理フック（isDirty管理対応）（Issue #469） |
| `src/hooks/useImageAttachment.ts` | 画像添付カスタムフック（バリデーション・アップロード・状態管理・resetAfterSend）（Issue #474） |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック |
| `src/hooks/useTerminalSearch.ts` | ターミナル内テキスト検索フック（Issue #47）debounce 300ms、最大500件、最小2文字 |
| `src/hooks/useFragmentLogin.ts` | フラグメントベース自動ログイン |
| `src/hooks/useReportGeneration.ts` | レポート生成モード管理フック（GenerationMode: none/template/custom、テンプレート選択・userInstruction管理）（Issue #618） |
| `src/app/api/worktrees/[id]/terminal/route.ts` | ターミナルコマンド送信API（Copilot全コマンドをsendMessage()に委譲）（Issue #559） |
| `src/app/api/worktrees/[id]/capture/route.ts` | ターミナル出力キャプチャAPI |
| `src/app/api/worktrees/[id]/marp-render/route.ts` | MARPスライドレンダリングAPI |
| `src/app/api/worktrees/[id]/git/log/route.ts` | Gitコミット履歴取得API（Issue #447） |
| `src/app/api/worktrees/[id]/git/show/[commitHash]/route.ts` | Gitコミット変更ファイル一覧API（Issue #447） |
| `src/app/api/worktrees/[id]/git/diff/route.ts` | Gitファイルdiff取得API（Issue #447） |
| `src/app/api/worktrees/[id]/special-keys/route.ts` | 特殊キー送信API（Up/Down/Left/Right/Enter/Escape、6層防御）（Issue #473, #592） |
| `src/app/api/templates/route.ts` | レポートテンプレートAPI（GET全件取得/POST作成、5件上限・バリデーション）（Issue #618） |
| `src/app/api/templates/[id]/route.ts` | レポートテンプレート個別API（PUT更新/DELETE削除、UUID検証）（Issue #618） |
| `src/components/worktree/NavigationButtons.tsx` | OpenCode TUI選択リストナビゲーションボタン、Left/Right対応（Issue #473, #592） |
| `src/cli/utils/api-client.ts` | CLI用HTTPクライアント（認証トークン解決・エラー分類・ApiClient/ApiError）（Issue #518） |
| `src/cli/utils/command-helpers.ts` | CLI共通ヘルパー（TOKEN_WARNING定数・handleCommandError統一エラーハンドラ）（Issue #518） |
| `src/cli/types/api-responses.ts` | CLI側APIレスポンス型定義（WorktreeListResponse, CurrentOutputResponse, PromptResponseResult等）（Issue #518） |
| `src/cli/config/duration-constants.ts` | CLI側duration定数（DURATION_MAP, parseDurationToMs）（Issue #518） |
| `src/cli/config/cli-tool-ids.ts` | CLI側ツールID定義（CLI_TOOL_IDS, isCliToolId、copilot含む6ツール）（Issue #518, #545） |
| `src/cli/config/model-validation.ts` | CLI側model名バリデーション（validateCopilotModelName、MODEL_NAME_PATTERN、クロスバリデーション対象）（Issue #588） |
| `src/config/review-config.ts` | Review設定定数・テンプレート定数（STALLED_THRESHOLD_MS, REVIEW_POLL_INTERVAL_MS, MAX_TEMPLATES, MAX_TEMPLATE_NAME_LENGTH, MAX_TEMPLATE_CONTENT_LENGTH）（Issue #600, #618）、MAX_COMMIT_LOG_LENGTH/GIT_LOG_TOTAL_TIMEOUT_MS追加（Issue #627） |
| `src/lib/session/next-action-helper.ts` | 次アクション算出ヘルパー（getNextAction, getReviewStatus, ReviewStatus型）（Issue #600） |
| `src/lib/detection/stalled-detector.ts` | Stalled判定（isWorktreeStalled）（Issue #600） |
| `src/lib/deep-link-validator.ts` | Deep linkバリデーション（isDeepLinkPane, normalizeDeepLinkPane, VALID_PANES, DeepLinkPane型）（Issue #600） |
| `src/lib/api/worktrees-include-parser.ts` | API includeパラメータパーサー（Issue #600） |
| `src/hooks/useLayoutConfig.ts` | レイアウト設定フック（LayoutConfig, LAYOUT_MAP, resolveLayoutConfig）（Issue #600） |
| `src/hooks/useSendMessage.ts` | メッセージ送信フック（Issue #600） |
| `src/hooks/useWorktreeList.ts` | Worktreeリスト共通フック（ソート・フィルタ・グループ化）（Issue #600） |
| `src/hooks/useWorktreesCache.ts` | Worktrees共有キャッシュフック（Issue #600） |
| `src/hooks/useWorktreeTabState.ts` | Worktreeタブ状態管理フック（deep link対応）（Issue #600） |
| `src/components/mobile/GlobalMobileNav.tsx` | モバイルグローバルナビ（4タブ）（Issue #600） |
| `src/components/home/HomeSessionSummary.tsx` | Home画面セッション集計サマリー（Issue #600） |
| `src/components/review/ReviewCard.tsx` | Reviewカード（Issue #600） |
| `src/components/review/SimpleMessageInput.tsx` | 軽量メッセージ入力（Review画面用）（Issue #600） |
| `src/components/review/TemplateTab.tsx` | テンプレート管理UI（一覧・作成・編集・削除、最大5件制限）（Issue #618） |
| `src/components/worktree/WorktreeDetailHeader.tsx` | Worktree詳細ヘッダー（Repository名・Branch名・Agent・Status・次アクション）（Issue #600） |
| `src/components/providers/WorktreesCacheProvider.tsx` | Worktreesキャッシュプロバイダー（Issue #600） |
| `src/components/repository/RepositoryList.tsx` | リポジトリ一覧表示・インライン別名編集UI（Issue #644） |
| `src/app/sessions/page.tsx` | Sessions画面（Issue #600） |
| `src/app/repositories/page.tsx` | Repositories画面（Issue #600, #644: RepositoryList上部配置・refreshKey連携） |
| `src/app/review/page.tsx` | Review画面（Issue #600） |
| `src/app/more/page.tsx` | More画面（Issue #600） |
| `src/components/layout/Header.tsx` | PC 5画面ナビゲーション（Issue #600） |
| `src/components/layout/AppShell.tsx` | アプリケーションシェル（useLayoutConfig統合）（Issue #600） |
| `src/types/ui-state.ts` | UI状態型定義（DeepLinkPane型追加）（Issue #600） |

### CLIモジュール

| モジュール | 役割 |
|-----------|------|
| `src/cli/index.ts` | CLIメインロジック（commander設定） |
| `src/cli/commands/init.ts` | initコマンド（対話/非対話） |
| `src/cli/commands/start.ts` | startコマンド（--issue対応） |
| `src/cli/commands/stop.ts` | stopコマンド |
| `src/cli/commands/status.ts` | statusコマンド（--all対応） |
| `src/cli/commands/issue.ts` | issueコマンド（gh CLI連携） |
| `src/cli/commands/docs.ts` | docsコマンド |
| `src/cli/commands/ls.ts` | lsコマンド（worktree一覧表示、--json/--quiet/--branch対応）（Issue #518） |
| `src/cli/commands/send.ts` | sendコマンド（エージェントへのメッセージ送信、--auto-yes/--agent対応）（Issue #518） |
| `src/cli/commands/wait.ts` | waitコマンド（エージェント完了/プロンプト検出待機、--timeout/--stall-timeout/--on-prompt対応）（Issue #518） |
| `src/cli/commands/respond.ts` | respondコマンド（エージェントプロンプトへの応答、--agent対応）（Issue #518） |
| `src/cli/commands/capture.ts` | captureコマンド（ターミナル出力取得、--json/--agent対応）（Issue #518） |
| `src/cli/commands/auto-yes.ts` | auto-yesコマンド（Auto-Yes制御、--enable/--disable/--duration/--stop-pattern対応）（Issue #518） |
| `src/cli/utils/` | preflight, env-setup, daemon, pid-manager, port-allocator, api-client, command-helpers 等 |
| `src/cli/config/` | 依存関係定義、duration-constants, cli-tool-ids |
| `src/cli/types/index.ts` | CLI共通型定義 |
| `src/cli/types/api-responses.ts` | CLI側APIレスポンス型定義（Issue #518） |

---

## 品質担保

### 必須チェック（CI/CD）
- ESLint: `npm run lint`
- TypeScript: `npx tsc --noEmit`
- Unit Test: `npm run test:unit`
- Build: `npm run build`

### 推奨チェック
- Integration Test: `npm run test:integration`
- E2E Test: `npm run test:e2e`

---

## 禁止事項

### ブランチ操作
1. **mainへの直push禁止**
   - 全ての変更はPRを通じて行う
   - `git push origin main` は拒否される
   - **Git Hook（pre-push）で強制**: ローカル環境でmainブランチへの直接pushをブロック

2. **force push禁止**
   - `git push --force` は原則禁止
   - 例外: 自分のfeatureブランチのみ許可

### Git Hook設定

`.git/hooks/pre-push` でmainブランチへの直接pushを防止。クローン後に手動設定が必要（`--no-verify`で回避可能なためチームルールとしての遵守が重要）。

### コード
1. **console.logの本番残留禁止**
   - デバッグ用のログは削除すること

2. **未使用importの残留禁止**
   - ESLintで検出・除去

### 例外対応
- 緊急時はhotfix/*ブランチを使用
- チーム責任者の承認を得てからマージ

---

## 開発コマンド

```bash
# 開発サーバー起動
npm run dev

# ビルド
npm run build          # Next.jsビルド
npm run build:cli      # CLIモジュールビルド
npm run build:server   # サーバーモジュールビルド（Issue #113）
npm run build:all      # 全ビルド（Next.js + CLI + server）

# テスト
npm test              # 全テスト
npm run test:unit     # 単体テスト
npm run test:integration  # 結合テスト
npm run test:e2e      # E2Eテスト

# リント
npm run lint

# データベース
npm run db:init       # DB初期化
npm run db:reset      # DBリセット
```

### CLIコマンド（グローバルインストール後）

```bash
# バージョン確認
commandmate --version

# 初期化
commandmate init              # 対話形式
commandmate init --defaults   # デフォルト値で非対話

# サーバー起動
commandmate start             # フォアグラウンド
commandmate start --dev       # 開発モード
commandmate start --daemon    # バックグラウンド

# サーバー停止・状態確認
commandmate stop
commandmate status

# Worktree並列開発（Issue #136）
commandmate start --issue 135 --auto-port  # Issue #135用サーバー起動（自動ポート割当）
commandmate start --issue 135 --port 3135  # 特定ポートで起動
commandmate stop --issue 135               # Issue #135用サーバー停止
commandmate status --issue 135             # Issue #135用サーバー状態確認
commandmate status --all                   # 全サーバー状態確認

# Worktree操作コマンド（Issue #518）
commandmate ls                             # worktree一覧表示
commandmate ls --json                      # JSON形式で出力
commandmate ls --quiet                     # IDのみ出力（1行1ID）
commandmate ls --branch feature/           # ブランチ名プレフィックスでフィルタ

# メッセージ送信
commandmate send <worktree-id> "メッセージ"                    # エージェントにメッセージ送信
commandmate send <worktree-id> "メッセージ" --agent claude     # エージェント指定
commandmate send <worktree-id> "メッセージ" --auto-yes         # Auto-Yes有効化して送信
commandmate send <worktree-id> "メッセージ" --auto-yes --duration 3h  # Auto-Yes時間指定

# 完了待機
commandmate wait <worktree-id>                                 # エージェント完了まで待機
commandmate wait <worktree-id> --timeout 300                   # 300秒でタイムアウト（exit 124）
commandmate wait <worktree-id> --stall-timeout 60              # 60秒出力変化なしでタイムアウト
commandmate wait <worktree-id> --on-prompt human               # プロンプト検出時も待機継続
commandmate wait <id1> <id2>                                   # 複数worktree同時待機

# プロンプト応答
commandmate respond <worktree-id> "yes"                        # プロンプトに応答
commandmate respond <worktree-id> "yes" --agent claude         # エージェント指定

# ターミナル出力取得
commandmate capture <worktree-id>                              # ターミナル出力をテキストで取得
commandmate capture <worktree-id> --json                       # JSON形式で取得
commandmate capture <worktree-id> --agent codex                # エージェント指定

# Auto-Yes制御
commandmate auto-yes <worktree-id> --enable                    # Auto-Yes有効化（デフォルト1h）
commandmate auto-yes <worktree-id> --enable --duration 3h      # 時間指定（1h, 3h, 8h）
commandmate auto-yes <worktree-id> --enable --stop-pattern "error"  # 停止パターン指定
commandmate auto-yes <worktree-id> --disable                   # Auto-Yes無効化
```

---

## Claude Code コマンド・エージェント

本プロジェクトではClaude Code用のスラッシュコマンドとサブエージェントを整備しています。

### 利用可能なコマンド

| コマンド | 説明 |
|---------|------|
| `/work-plan` | Issue単位の作業計画立案 |
| `/create-pr` | PR自動作成 |
| `/progress-report` | 進捗報告書作成 |
| `/tdd-impl` | TDD実装 |
| `/pm-auto-dev` | 自動開発フロー |
| `/bug-fix` | バグ修正ワークフロー |
| `/refactoring` | リファクタリング実行 |
| `/acceptance-test` | 受け入れテスト |
| `/uat` | 実機受入テスト（UAT）計画・レビュー・実行・報告 |
| `/issue-create` | Issue一括作成 |
| `/issue-enhance` | Issueの対話的補完（不足情報をユーザーに質問して補完） |
| `/issue-split` | Issue分割計画 |
| `/architecture-review` | アーキテクチャレビュー（サブエージェント対応） |
| `/apply-review` | レビュー指摘事項の実装反映 |
| `/multi-stage-design-review` | 設計書の4段階レビュー（通常→整合性→影響分析→セキュリティ） |
| `/multi-stage-issue-review` | Issueの多段階レビュー（通常→影響範囲）×2回 |
| `/design-policy` | 設計方針策定 |
| `/worktree-setup` | Worktree環境の自動構築（Issue #136） |
| `/worktree-cleanup` | Worktree環境のクリーンアップ（Issue #136） |

### 利用可能なエージェント

| エージェント | 説明 |
|-------------|------|
| `tdd-impl-agent` | TDD実装専門 |
| `progress-report-agent` | 進捗報告生成 |
| `investigation-agent` | バグ調査専門 |
| `acceptance-test-agent` | 受入テスト |
| `refactoring-agent` | リファクタリング |
| `architecture-review-agent` | アーキテクチャレビュー |
| `apply-review-agent` | レビュー指摘反映 |
| `issue-review-agent` | Issue内容レビュー |
| `apply-issue-review-agent` | Issueレビュー結果反映 |

### 利用可能なスキル

| スキル | 説明 |
|--------|------|
| `/release` | バージョン更新、CHANGELOG更新、Gitタグ作成、GitHub Releases作成を自動化 |
| `/rebuild` | サーバーをリビルドして再起動 |

---

## 最近の実装機能

[実装機能一覧](./docs/implementation-history.md) - Issue別の概要・主要変更ファイル・設計書リンク

---

## 関連ドキュメント

- [README.md](./README.md) - プロジェクト概要
- [アーキテクチャ](./docs/architecture.md) - システム設計
- [移行ガイド](./docs/migration-to-commandmate.md) - MyCodeBranchDesk からの移行手順
- [リリースガイド](./docs/release-guide.md) - バージョン管理とリリース手順
- [クイックスタートガイド](./docs/user-guide/quick-start.md) - 5分で始める開発フロー
- [コマンド利用ガイド](./docs/user-guide/commands-guide.md) - コマンドの詳細
- [エージェント利用ガイド](./docs/user-guide/agents-guide.md) - エージェントの詳細
- [ワークフロー例](./docs/user-guide/workflow-examples.md) - 実践的な使用例
- [ステータスインジケーター](./docs/features/sidebar-status-indicator.md) - サイドバー機能詳細
- [実装機能一覧](./docs/implementation-history.md) - Issue別の実装履歴
