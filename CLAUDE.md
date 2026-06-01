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
| `src/lib/db/db-repository.ts` | リポジトリDB操作、`visible` フラグ対応CRUD（Issue #690）、`enabled` フラグ対応CRUD（Issue #190） |
| `src/lib/db/worktree-db.ts` | Worktree CRUD操作、archivedフィルタ対応（Issue #479, #168）、getRepositories に visible/enabled 追加（Issue #690） |
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
| `src/config/memo-config.ts` | メモ共有定数（MAX_MEMOS）（Issue #652） |
| `src/config/repository-config.ts` | リポジトリ共有定数（MAX_DISPLAY_NAME_LENGTH）（Issue #644） |
| `src/config/history-display-config.ts` | History表示件数定数（HISTORY_DISPLAY_LIMIT_OPTIONS, MAX_MESSAGES_LIMIT派生, DEFAULT_MESSAGES_LIMIT, HISTORY_DISPLAY_LIMIT_STORAGE_KEY, HistoryDisplayLimit型, isHistoryDisplayLimit型ガード）（Issue #701）。Issue #725で `HISTORY_USER_ONLY_STORAGE_KEY` 追加 |
| `src/config/editable-extensions.ts` | 編集可能拡張子定義・バリデーション（EDITABLE_EXTENSIONS, EXTENSION_VALIDATORS, isEditableExtension, validateContent）。.yaml/.yml 追加・YAML危険タグバリデーション（Issue #646）。TEXT_MAX_SIZE_BYTES を 2MB に引き上げ・PUT/GET 共通定数化（Issue #723） |
| `src/config/file-viewer-config.ts` | 大規模ファイル閲覧用定数（VIEWER_CHUNK_LINE_SIZE, VIEWER_OVERSCAN_LINES, POLLING_DISABLED_THRESHOLD_BYTES）（Issue #723） |
| `src/config/pdf-extensions.ts` | PDF拡張子・サイズ(20MB)・magic bytes(`%PDF-`)・iframe sandbox定数、isPdfExtension / validatePdfMagicBytes / validatePdfContent（Issue #673） |
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
| `src/lib/session-cleanup.ts` | セッション/ポーラー/スケジューラー停止（Facade）、killWorktreeSession共通化、syncWorktreesAndCleanup（Issue #526）、cleanupGlobalSessions追加（Issue #649） |
| `src/lib/session/global-session-constants.ts` | グローバルセッション定数（GLOBAL_SESSION_WORKTREE_ID='\_\_global\_\_', GLOBAL_POLL_INTERVAL_MS等）（Issue #649） |
| `src/lib/polling/global-session-poller.ts` | グローバルセッション専用ポーリング（pollGlobalSession, stopGlobalSessionPolling, stopAllGlobalSessionPolling, isGlobalPollerActive）（Issue #649） |
| `src/lib/assistant/context-builder.ts` | グローバルセッション用デフォルトコンテキスト生成（buildGlobalContext, getEnabledRepositories）（Issue #649） |
| `src/lib/api/assistant-api.ts` | アシスタントAPIクライアント（startSession, sendCommand, getCurrentOutput, stopSession, getInstalledTools）（Issue #649） |
| `src/types/assistant.ts` | アシスタント機能型定義（StartAssistantRequest, StartAssistantResponse, AssistantCurrentOutputResponse等）（Issue #649） |
| `src/lib/session-key-sender.ts` | Claudeセッションキー送信ロジック（Issue #479） |
| `src/lib/prompt-answer-input.ts` | プロンプト応答入力ロジック（getAnswerInput）（Issue #479） |
| `src/lib/resource-cleanup.ts` | リソースリーク対策（孤立プロセス/Map検出） |
| `src/lib/security/env-sanitizer.ts` | 環境変数サニタイズ |
| `src/lib/proxy/handler.ts` | HTTPプロキシハンドラ |
| `src/lib/proxy/config.ts` | プロキシ設定定数 |
| `src/lib/security/path-validator.ts` | パスバリデーション・symlink防御 |
| `src/lib/file-operations.ts` | ファイルCRUD操作（5層セキュリティ）、`readFileLineRange` で行範囲ストリーミング読み取り（createReadStream + readline、メモリO(チャンク)）（Issue #723） |
| `src/lib/git/clone-manager.ts` | クローン処理管理（排他制御） |
| `src/lib/version-checker.ts` | バージョンアップ通知 |
| `src/lib/slash-commands.ts` | スラッシュコマンドローダー（.claude/commands, .claude/skills, .codex/skills対応、getCopilotBuiltinCommands追加）（Issue #166, #547） |
| `src/lib/link-utils.ts` | リンク種別判定・相対パス解決・hrefサニタイズ（Issue #505） |
| `src/lib/url-path-encoder.ts` | ファイルパスURLエンコード |
| `src/lib/file-search.ts` | ファイル内容検索 |
| `src/lib/terminal-highlight.ts` | CSS Custom Highlight API ラッパー（Issue #47）XSS安全なターミナルハイライト。Issue #716で名前空間分離（HighlightNamespace型、HISTORY_SEARCH_NAMESPACE、applyHistoryHighlights/clearHistoryHighlights追加）。Issue #744で `makeHistoryNamespace(splitIndex)` ファクトリ追加（`history-search-${splitIndex}` 等の per-split namespace で `CSS.highlights` グローバルレジストリの上書き衝突を回避）、`applyHistoryHighlights`/`clearHistoryHighlights` に optional `namespace` 引数を additive 追加（default=`HISTORY_SEARCH_NAMESPACE`＝後方互換） |
| `src/lib/file-tree.ts` | ディレクトリツリー構造生成 |
| `src/lib/git/git-utils.ts` | Git情報取得・コミット履歴/diff取得（Issue #447）、getCommitsByDateRange/collectRepositoryCommitLogs追加（Issue #627） |
| `src/types/git.ts` | Git関連型定義（CommitInfo, ChangedFile, GitLogResponse等）（Issue #447）、CommitLogEntry/RepositoryCommitLogs追加（Issue #627） |
| `src/lib/sidebar-utils.ts` | サイドバーソート・グループ化ユーティリティ（SortKey, SortDirection, ViewMode型, BranchGroup型, sortBranches(), groupBranches(), generateRepositoryColor()）（Issue #449, #504）、buildHiddenRepositoryPathSet/filterWorktreesByVisibility追加（Issue #690） |
| `src/contexts/SidebarContext.tsx` | サイドバー状態管理Context（isOpen, sortKey, viewMode, localStorageパターン）（Issue #449）、DEFAULT_SIDEBAR_WIDTH=224(w-56)に変更（Issue #651） |
| `src/lib/utils.ts` | 汎用ユーティリティ（withTimeout追加: Issue #627） |
| `src/lib/date-utils.ts` | 相対時刻フォーマット（formatRelativeTime）、メッセージタイムスタンプフォーマット（formatMessageTimestamp、'PPp'フォーマット・ロケール対応）（Issue #687） |
| `src/lib/clipboard-utils.ts` | クリップボードコピー |
| `src/lib/pasted-text-helper.ts` | Pasted text検知・Enter再送 |
| `src/lib/api-logger.ts` | 開発環境APIロギング |
| `src/lib/log-export-sanitizer.ts` | エクスポート用データサニタイズ |
| `src/i18n.ts` | next-intl設定 |
| `src/lib/locale-cookie.ts` | ロケールCookie管理 |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（メイン画面、ツリーポーリング対応、履歴・メモ挿入state管理、NewFileDialog連携）（Issue #469, #485, #646）、左パネル折りたたみprops連携（Issue #688）、historyUserOnly state＋localStorage永続化（Issue #725）。Issue #727で leftPaneMemo(38 deps) を activityBarMemo/activityContent/activityPaneMemo/historyPaneMemo に分割（R3-007 メンテナンスコメント付与）、useFilePolling を activeActivity==='files' で gate、PC の Message/Git サブタブ UI 除去。Issue #730で ActivityBar を WorktreeDesktopLayout の外側に出して全高貫通化（Header 下〜画面下端）、TerminalContainer に history/terminal を渡す構造に再構成。Issue #728でPC経路の `renderSplitPane` を `TerminalSplitPaneContent` 委譲に簡素化（`state.terminal.*` 参照を撤去、各 split が自前で polling）、`pendingInsertTextMap: Map<splitIndex, string|null>` + `focusedSplitIndex` で per-split 挿入ルーティング、splitIndex=0 の CLI 変更を `setActiveCliTab` に同期（History/Auto-Yes/Kill が activeCliTab スコープのため）。Mobile 経路は `state.terminal.*` を継続利用。Issue #732で PC 経路の外側 2 flex コンテナ（L1740 主因 = flex-row 直下の flex item / L1763 防御的補強）に `min-w-0` を追記し、Flexbox `min-width:auto` 既定による横溢れで FilePanel が viewport 外へ押し出される #730 follow-up 不具合を修正。Issue #736で Mobile 経路も `useTerminalPanePolling` へ移行し terminal reducer slice を撤去（親側は cadence gate と `MessageInput isSessionRunning` を `worktree.sessionStatusByCli[activeCliTab].isRunning` 由来に切替、`fetchCurrentOutput` の terminal 書き込み除去＝prompt/selection/Auto-Yes は維持、worktreeId/CLIタブ/kill の terminal リセットと未使用 `handleAutoScrollChange` を除去）。Issue #740で `handleAutoYesToggle` を `makeAutoYesToggleHandler(cliToolId)`（`useCallback`、依存 `worktreeId` で安定参照、API body の `cliToolId` と `setAutoYesStateMap` キーを引数値に）にパラメータ化し PC per-split footer の per-CLI 独立 Auto-Yes を実現。`handleAutoYesToggle` は `makeAutoYesToggleHandler(activeCliTab)` の薄いラッパとして残し Mobile 呼び出しを無改修で維持、`renderSplitPane` で `autoYesStateMap.get(paneCli)` の enabled/expiresAt と `onAutoYesToggle={makeAutoYesToggleHandler(paneCli)}` を各 split に配布（`prevAutoYesEnabledRef` は activeCliTab 一致時のみ更新）。Issue #743で `renderSplitPane` で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を導出し各 split に `cliStatus`（`BranchStatus` 文字列）を配布、PC per-split header の AIエージェント status indicator を復活（memo 境界を越えるのは導出済み文字列のみ＝status 不変ポーリング周期では再renderしない、`useCallback` 依存に `worktree?.sessionStatusByCli` を追加／S3-001 memo-safe）。Mobile 経路（L1947-1974）は無改修 |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | PC版 2カラム構成（ActivityPane / Right）+ ResizableColumn ヘルパーで dedup（Issue #727、Issue #730 で 4→2 カラムに簡素化、MobileLayout fallback と activityBar/historyPane/historyPaneCollapsed/onToggleHistoryPane/onHistoryPaneResize/historyPaneWidth props を削除、HISTORY_PANE_ID は TerminalContainer に移管） |
| `src/components/worktree/ActivityBar.tsx` | VS Code 風 Activity Bar（48px垂直、6 Activity: Files/Git/Notes/Schedules/Agent/Timer、role=tablist、aria-orientation=vertical、ArrowUp/Down/Home/End/Enter/Space キーボード対応）（Issue #727）。Issue #730で title 属性削除＋カスタム Tooltip（100ms 遅延、role=tooltip+aria-hidden=true、wrapper span tabIndex=-1）ラップ、ref/イベント透過設計 |
| `src/components/worktree/TerminalContainer.tsx` | History + Terminal 内包コンテナ（HISTORY_PANE_ID='worktree-history-pane' 移管 export、useHistoryPaneState で visible/width/toggle/setWidth 管理、PaneResizer/折りたたみ expand bar、History/Terminal を ErrorBoundary 包含）（Issue #730）。Issue #735 で expand `<button>` に `data-testid="history-pane-expand"` を付与（e2e 用・additive）。Issue #744で `history` prop を optional 化（History は各 split 内へ移管）。未指定時（PC default）は terminal エリアのみ描画し、history カラム/PaneResizer/expand bar は history 提供時のみ描画（Issue #730 単一カラム挙動の後方互換） |
| `src/components/common/Tooltip.tsx` | カスタム Tooltip コンポーネント（TOOLTIP_DELAY_MS=100、placement=top/right/bottom/left、ダークテーマ、wrapper span tabIndex=-1、useEffect cleanup で clearTimeout、ref/onClick/onKeyDown 透過、role=tooltip+aria-hidden=true で aria-label 重複読み上げ回避）（Issue #730） |
| `src/components/worktree/ActivityPane.tsx` | 選択 Activity の描画コンテナ（ActivityContentMap で table-driven、各子は ErrorBoundary 包含、id=worktree-activity-pane）（Issue #727） |
| `src/components/worktree/AgentSettingsPane.tsx` | エージェント選択UI |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力（下書き永続化対応、pendingInsertText外部挿入対応）（Issue #485）。Issue #728で `splitIndex?: number`（default 0）+ `onFocus?` props 追加、下書き localStorage キーを `commandmate:draft-message:${worktreeId}:${splitIndex}` に変更、旧 `commandmate:draft-message:${worktreeId}` から splitIndex=0 への 1-shot マイグレーション |
| `src/components/worktree/ConversationPairCard.tsx` | 会話ペアカード（ユーザー/アシスタントメッセージ表示、挿入ボタン）（Issue #485）。Issue #716でMessageContent親divに data-message-id 付与（memo維持、props追加なし）。Issue #725で COLLAPSED_MAX_CHARS=100/COLLAPSED_MAX_LINES=2 へ折りたたみ強化、Assistantスタイル弱化（text-xs/p-2/bg-gray-900/30）、User側に防御セット追加、`showAssistant?: boolean` prop追加 |
| `src/components/worktree/MemoCard.tsx` | メモカード（メモ表示・コピー・挿入ボタン）（Issue #485） |
| `src/components/worktree/HistoryPane.tsx` | 履歴ペイン（会話履歴表示、onInsertToMessage伝播）（Issue #485）。Issue #716でメッセージテキスト検索機能（検索アイコン+HistorySearchBar、autoExpandedIds自動展開、useLayoutEffect副作用でapplyHistoryHighlights、searchStartScrollPositionRef scroll復帰、worktreeId/activeCliTab変化でcloseSearch）。Issue #725で User onlyフィルタトグル追加（lucide-react User/UserCheck、aria-pressed）、searchableMessagesをuser roleフィルタ、orphanペアスキップ。Issue #744で additive な `splitIndex?`/`cliToolId?` props 追加：`splitIndex` 指定時は内部検索ハイライトで `makeHistoryNamespace(splitIndex)` を使用（未指定時は従来の `HISTORY_SEARCH_NAMESPACE`＝後方互換）、`cliToolId` はメタ情報のみ（フィルタは呼び出し側 fetch=`useSplitMessages` で実施済みのため client-side フィルタは持たない／S1-008） |
| `src/components/worktree/HistorySearchBar.tsx` | 履歴内テキスト検索バーUI（Issue #716）TerminalSearchBar踏襲、role="search"、aria-live、件数表示・前/次ナビ・Esc閉じ、IME composition handler |
| `src/components/worktree/MemoPane.tsx` | メモペイン（メモ一覧表示、onInsertToMessage伝播）（Issue #485） |
| `src/components/worktree/NotesAndLogsPane.tsx` | Notes&Logsペイン（メモ・ログタブ、onInsertToMessage伝播）（Issue #485）。Issue #727 後はモバイル経路のみで使用（PC は Activity Bar で個別 Activity に分解） |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | Worktree詳細サブコンポーネント（MobileContent等、onInsertToMessage伝播）（Issue #485）。Issue #725で MobileContentProps に historyUserOnly/onHistoryUserOnlyChange を追加・モバイル経路にもUser only props伝播。Issue #736で `MobileTerminalTab`（`useTerminalPanePolling({worktreeId, cliToolId})` を駆動、terminal タブ表示時のみマウント）を新設し、`MobileContent` の terminal 表示 props（terminalOutput/isTerminalActive/isThinking/autoScroll/onScrollChange）を `cliToolId` に置換 |
| `src/components/worktree/MarkdownEditor.tsx` | マークダウンエディタメイン（Issue #479）、汎用テキストエディタ化・YAML等非mdファイルのプレビュー非表示対応（Issue #646） |
| `src/components/worktree/NewFileDialog.tsx` | 新規ファイル作成ダイアログ（ファイル名入力・拡張子選択、拡張子決定ロジック3パターン）（Issue #646） |
| `src/components/worktree/TerminalSearchBar.tsx` | ターミナル内テキスト検索バーUI（Issue #47）件数表示・前/次ナビ・Esc閉じ |
| `src/components/worktree/FilePanelSplit.tsx` | ターミナル+ファイルパネル分割。Issue #728でPCの`terminal`スロットに`TerminalSplitContainer`が入る前提（シグネチャ自体は無変更、`terminalHeader={null}`で利用） |
| `src/components/worktree/TerminalSplitContainer.tsx` | PCの1〜3ターミナル横分割コンテナ（`role="group" aria-label="Terminal splits"`、`useTerminalSplits`で状態管理、Add/Remove ボタン、`PaneResizer`ラッパで isResizing 検知、`renderPane` render-prop でペイン本体を委譲、`onFocusedSplitChange` で `focusedSplitIndex` を親へ通知）（Issue #728） |
| `src/components/worktree/TerminalSplitPane.tsx` | 単一スプリットのプレゼンテーション層（`role="region" aria-label="Terminal split N"`、CLI セレクタ＋検索ボタン＋`headerExtras` ヘッダー、`terminal`/`footer` スロット、`attaching` 時の attach skeleton `role="status"`、`onFocusCapture`/`onMouseDown` で親へ focus 伝達）（Issue #728） |
| `src/components/worktree/TerminalSplitPaneContent.tsx` | スマートな per-(worktreeId, cliToolId) ペイン本体（`useTerminalPanePolling` を駆動、`TerminalDisplay`/`NavigationButtons`/`PromptPanel`/`MessageInput` を実描画、`autoYesEnabled` で PromptPanel を抑制、`onMessageSent` で親に伝播し履歴を再取得）（Issue #728 R3-005）。Issue #740で footer 先頭に `AutoYesToggle`（`cliToolName={cliToolId}` / `inline`）を追加し per-CLI 独立トグルに対応、`autoYesExpiresAt`/`lastAutoResponse`/`onAutoYesToggle` props を追加（client-side auto-response は per-split 化せず #501 サーバー poller に委譲）。Issue #743で header の AIエージェント status indicator を復活：optional `cliStatus?: BranchStatus`（未指定時 `'idle'`）prop を追加し `SIDEBAR_STATUS_CONFIG[cliStatus]`（`@/config/status-colors`）から解決、Mobile 正準（`WorktreeDetailRefactored.tsx:1947-1974`）と同じインライン span（spinner=`animate-spin`/dot=`rounded-full`、`title` のみ、`data-testid="split-status-indicator-${splitIndex}"`）を `useMemo` 安定化して既存 `headerExtras` slot に配線。status は親が `deriveCliStatus` で導出した文字列のみを渡すため memo-safe（#728/#740 と同型の移行漏れ修正）。Issue #744で terminal slot を `[HistoryPane | PaneResizer | TerminalDisplay]` 横並びに再構成し HistoryPane を内包：`useSplitMessages({worktreeId, cliToolId, limit, includeArchived})` でこの split の cliToolId のメッセージのみ独立 fetch し HistoryPane に配布、`splitIndex`（per-split highlight namespace）/`cliToolId` を伝播、`onHistoryInsertToMessage`（splitIndex 直指定ルーティング／S3-005）、メッセージ送信後に `useSplitMessages.refresh()`（S1-006）。History の visible/width は MVP では `useHistoryPaneState`（全split共通）参照で split 内相対適用。additive props（`onFilePathClick`/`showToast`/`onHistoryInsertToMessage`/`showArchived`/`historyDisplayLimit`/`historyUserOnly` 等）で既存 call site 無改修 |
| `src/components/worktree/FilePanelTabs.tsx` | ファイルタブバーUI |
| `src/components/worktree/FilePanelContent.tsx` | ファイルコンテンツ表示（ファイル内容ポーリング対応）（Issue #469）、YAMLファイル編集ルーティング追加（Issue #646）、CodeViewer の `@tanstack/react-virtual` 仮想化・行範囲チャンク fetch・ハイライトキャッシュ追加（Issue #723） |
| `src/components/worktree/HtmlPreview.tsx` | HTMLファイルプレビューコンポーネント（iframe srcdoc + Safe/Interactiveサンドボックス）（Issue #490） |
| `src/components/worktree/PdfPreview.tsx` | PDFファイルプレビューコンポーネント（data URI → Blob URL → iframe `sandbox="allow-scripts"`、cleanup revokeObjectURL、fetch失敗時ダウンロードフォールバック）（Issue #673） |
| `src/components/worktree/FileViewer.tsx` | ファイルビューア、検索ロジックを `useFileContentSearch` に統一（Issue #723） |
| `src/components/worktree/FileSearchBar.tsx` | ファイル検索バー共通コンポーネント（Issue #469） |
| `src/components/worktree/FileTreeView.tsx` | ファイルツリービュー（Issue #479） |
| `src/components/worktree/TreeNode.tsx` | ファイルツリーノードコンポーネント（Issue #479） |
| `src/components/worktree/TreeContextMenu.tsx` | ファイルツリーコンテキストメニュー（Issue #479） |
| `src/components/worktree/MarkdownToolbar.tsx` | マークダウンエディタツールバーUI（Issue #479） |
| `src/components/worktree/MarkdownPreview.tsx` | マークダウンプレビュー表示（Issue #479） |
| `src/components/worktree/GitPane.tsx` | Gitタブ（コミット履歴・diff表示）（Issue #447） |
| `src/components/worktree/TimerPane.tsx` | タイマーUI（登録・カウントダウン・キャンセル、visibilitychange対応ポーリング）（Issue #534） |
| `src/hooks/useFilePolling.ts` | ポーリングライフサイクル管理（visibilitychange対応）（Issue #469） |
| `src/hooks/useFileContentPolling.ts` | ファイル内容ポーリング（If-Modified-Since/304）（Issue #469）、大ファイル時無効化（`POLLING_DISABLED_THRESHOLD_BYTES`）（Issue #723） |
| `src/hooks/useFileContentSearch.ts` | ファイル内容検索共通フック（Issue #469）、debounce 300ms・最小2文字（`SEARCH_DEBOUNCE_MS` / `SEARCH_MIN_QUERY_LENGTH` 流用）（Issue #723） |
| `src/hooks/useFileTabs.ts` | タブ状態管理フック（isDirty管理対応）（Issue #469） |
| `src/hooks/useImageAttachment.ts` | 画像添付カスタムフック（バリデーション・アップロード・状態管理・resetAfterSend）（Issue #474） |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック |
| `src/hooks/useTerminalSearch.ts` | ターミナル内テキスト検索フック（Issue #47）debounce 300ms、最大500件、最小2文字。Issue #716で SEARCH_DEBOUNCE_MS/SEARCH_MIN_QUERY_LENGTH を共通定数として追加export |
| `src/hooks/useHistorySearch.ts` | 履歴メッセージテキスト検索フック（Issue #716）messages入力、HistoryMatch[]（messageId単位）、currentMatch{messageId,localIndex}解決、debounce 300ms・最小2文字・最大500件、IME composition aware、messages fingerprint memo |
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
| `src/app/api/assistant/start/route.ts` | グローバルセッション開始API（POST、DB操作なし、cliToolId検証・ディレクトリバリデーション・コンテキスト送信）（Issue #649） |
| `src/app/api/assistant/terminal/route.ts` | グローバルセッションメッセージ送信API（POST、sendKeys使用）（Issue #649） |
| `src/app/api/assistant/current-output/route.ts` | グローバルセッション出力取得API（GET、capturePane使用）（Issue #649） |
| `src/app/api/assistant/session/route.ts` | グローバルセッション停止API（DELETE、stopGlobalSessionPolling+killSession）（Issue #649） |
| `src/app/api/assistant/tools/route.ts` | インストール済みCLIツール一覧API（GET、CLIToolManager.getAllToolsInfo()使用）（Issue #649） |
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
| `src/hooks/useWorktreeUIState.ts` | WorktreeUI状態管理フック（useReducer、WorktreeUIActions、localStorage連携）、leftPaneCollapsed永続化・toggleLeftPane追加（Issue #688）。Issue #727で activityBar/historyPane の LayoutState セクション、setActiveActivity/toggleActivity/toggleHistoryPane/setHistoryWidth actions 追加。Issue #736で terminal slice（SET_TERMINAL_OUTPUT/ACTIVE/THINKING/SET_AUTO_SCROLL）と未使用の複合 action（START_WAITING_FOR_RESPONSE/RESPONSE_RECEIVED/SESSION_ENDED）の reducer case・action creator・WorktreeUIActions member を削除（terminal はper-split `useTerminalPanePolling` に移譲） |
| `src/hooks/useActivityBarState.ts` | Activity Bar 選択状態フック（active/setActive/toggle、`commandmate.worktree.activeActivity` 永続化、null 状態は非永続化、不正値時 DEFAULT_ACTIVITY='files' フォールバック、SSR/hydration 安全）（Issue #727） |
| `src/hooks/useHistoryPaneState.ts` | History ペイン状態フック（visible/width/toggle/setWidth、`commandmate.worktree.historyVisible`/`historyWidth` 永続化、default visible=true）（Issue #727）。Issue #730で DEFAULT_HISTORY_WIDTH=25→40 に調整（TerminalContainer 内 percent 基準）、`commandmate:historyPaneStateChange` CustomEvent broadcaster を追加し WorktreeDetailRefactored / TerminalContainer の 2 instance 同期 |
| `src/config/activity-bar-config.ts` | Activity Bar 定数定義（ActivityId 型、ACTIVITIES 配列、lucide-react アイコン {File, GitBranch, StickyNote, Calendar, Bot, Timer}、ACTIVITY_BAR_STORAGE_KEY、DEFAULT_ACTIVITY）（Issue #727） |
| `src/config/terminal-split-config.ts` | PC ターミナル分割設定定数（`MIN_SPLITS=1` / `MAX_SPLITS=3`、`DEFAULT_SPLIT_CONFIG`、`getTerminalSplitsStorageKey(worktreeId)='commandmate:terminalSplits:'+worktreeId`、`isValidSplitConfig` 型ガード、`TerminalSplitEntry` / `TerminalSplitConfig` 型）（Issue #728） |
| `src/hooks/useTerminalSplits.ts` | 1〜3分割の状態管理フック（`splits`/`widths`/`addSplit`/`removeSplit`/`setSplitCliTool`/`setSplitWidth`/`availableCliTools(idx)`/`focusedSplitIndex`/`setFocusedSplitIndex`、worktreeId切替で再読込、localStorage永続化＋stale fallback、同一CLI複数選択禁止 S1-002 を no-op で強制）（Issue #728） |
| `src/hooks/useTerminalPanePolling.ts` | per-(worktreeId, cliToolId) ターミナル出力ポーリング（`/current-output` を独立に fetch、`output`/`isRunning`/`isThinking`/`isSelectionListActive`/`prompt`/`attaching`/`autoScroll` を所有、`requestId`+`inFlightCliToolRef` で stale 応答破棄、`document.visibilityState='hidden'` で polling 停止、`refresh()` で手動再取得）（Issue #728 R3-005） |
| `src/hooks/useSplitMessages.ts` | per-(worktreeId, cliToolId) メッセージ履歴ポーリング（Issue #744）。`/api/worktrees/[id]/messages?cliTool=<id>&limit=<n>&includeArchived=<bool>` を独立 fetch し `parseMessageTimestamps` 適用、`{messages, isLoading, refresh}` を返す。`useTerminalPanePolling` 同型（`requestId`+`inFlightCliToolRef` stale-guard、visibilitychange pause、`SPLIT_MESSAGES_POLL_INTERVAL_MS=5000`、(worktreeId,cliToolId) 変化で reset）。各 PC split の内包 HistoryPane が自分の cliToolId のメッセージのみを同時表示するために使用（`state.messages` は activeCliTab フィルタ済みのため流用不可） |
| `src/hooks/useLayoutConfig.ts` | レイアウト設定フック（LayoutConfig, LAYOUT_MAP, resolveLayoutConfig）（Issue #600） |
| `src/hooks/useSendMessage.ts` | メッセージ送信フック（Issue #600） |
| `src/hooks/useWorktreeList.ts` | Worktreeリスト共通フック（ソート・フィルタ・グループ化）（Issue #600） |
| `src/hooks/useWorktreesCache.ts` | Worktrees共有キャッシュフック（Issue #600）、repositories: RepositorySummary[] state追加（Issue #690） |
| `src/hooks/useWorktreeTabState.ts` | Worktreeタブ状態管理フック（deep link対応）（Issue #600）。Issue #727で toActivityId() 追加（?pane=git→git, logs→schedules, notes/agent/timer/files→同名, history/terminal/info→null）、UseWorktreeTabStateReturn に activityId 追加。既存 toLeftPaneTab/toHistorySubTab はモバイル互換のため残置 |
| `src/components/mobile/GlobalMobileNav.tsx` | モバイルグローバルナビ（4タブ）（Issue #600） |
| `src/components/home/HomeSessionSummary.tsx` | Home画面セッション集計サマリー（Issue #600） |
| `src/components/home/AssistantChatPanel.tsx` | Home画面アシスタントチャットパネル（折りたたみ可能・最大50vh・ポーリング・セッション開始/停止）（Issue #649） |
| `src/components/home/AssistantMessageInput.tsx` | アシスタント専用メッセージ入力（送信のみ・スラッシュコマンド/画像添付なし）（Issue #649） |
| `src/components/review/ReviewCard.tsx` | Reviewカード（Issue #600） |
| `src/components/review/SimpleMessageInput.tsx` | 軽量メッセージ入力（Review画面用）（Issue #600） |
| `src/components/review/TemplateTab.tsx` | テンプレート管理UI（一覧・作成・編集・削除、最大5件制限）（Issue #618） |
| `src/components/worktree/WorktreeDetailHeader.tsx` | Worktree詳細ヘッダー（Repository名・Branch名・Agent・Status・次アクション）（Issue #600） |
| `src/components/providers/WorktreesCacheProvider.tsx` | Worktreesキャッシュプロバイダー（Issue #600）、repositories伝播追加（Issue #690） |
| `src/components/repository/RepositoryList.tsx` | リポジトリ一覧表示・インライン別名編集UI（Issue #644）、Visibility列トグルUI追加・楽観的更新・エラーロー��バック（Issue #690） |
| `src/app/sessions/page.tsx` | Sessions画面（Issue #600） |
| `src/app/repositories/page.tsx` | Repositories画面（Issue #600, #644: RepositoryList上部配置・refreshKey連携） |
| `src/app/review/page.tsx` | Review画面（Issue #600） |
| `src/app/more/page.tsx` | More画面（Issue #600） |
| `src/components/layout/Header.tsx` | PC 5画面ナビゲーション（Issue #600） |
| `src/components/layout/AppShell.tsx` | アプリケーションシェル（useLayoutConfig統合）（Issue #600） |
| `src/types/ui-state.ts` | UI状態型定義（DeepLinkPane型追加）（Issue #600）、LayoutStateにleftPaneCollapsed追加（Issue #688）。Issue #736で `TerminalState` 型・`initialTerminalState`・`WorktreeUIState.terminal` を削除（terminalは`useTerminalPanePolling`へ移譲） |

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
