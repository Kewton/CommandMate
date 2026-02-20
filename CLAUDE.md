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
feature/* ──PR──> main
fix/*     ──PR──> main
hotfix/*  ──PR──> main
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
│   └── api/       # APIルート
├── cli/           # CLIモジュール（Issue #96）
│   ├── index.ts       # CLIメインロジック（commander設定）
│   ├── commands/      # サブコマンド（init, start, stop, status）
│   ├── utils/         # 依存チェック、環境設定、デーモン管理
│   ├── config/        # 依存関係定義
│   └── types/         # CLI共通型定義（ExitCode enum）
├── components/    # UIコンポーネント
│   ├── common/    # 再利用可能な共通UIコンポーネント（Toast等）
│   ├── sidebar/   # サイドバー関連
│   ├── mobile/    # モバイル専用
│   └── worktree/  # ワークツリー詳細
├── config/        # 設定（ステータス色、編集可能拡張子など）
├── contexts/      # React Context
├── hooks/         # カスタムフック（useContextMenu等）
├── lib/           # ユーティリティ・ビジネスロジック
│   └── cli-tools/ # CLIツール抽象化層
└── types/         # 型定義

tests/
├── helpers/       # テスト共通ヘルパー（型ガード等）
├── unit/          # 単体テスト
└── integration/   # 結合テスト
```

### 主要機能モジュール

| モジュール | 説明 |
|-----------|------|
| `src/lib/env.ts` | 環境変数取得・フォールバック処理、getDatabasePathWithDeprecationWarning() |
| `src/lib/db-path-resolver.ts` | DBパス解決（getDefaultDbPath()、validateDbPath()） |
| `src/lib/db-migration-path.ts` | DBマイグレーション（migrateDbIfNeeded()、getLegacyDbPaths()） |
| `src/lib/db-instance.ts` | DBインスタンス管理（getEnv().CM_DB_PATH使用） |
| `src/config/system-directories.ts` | システムディレクトリ定数（SYSTEM_DIRECTORIES、isSystemDirectory()） |
| `src/config/status-colors.ts` | ステータス色の一元管理 |
| `src/lib/cli-patterns.ts` | CLIツール別パターン定義（Issue #212: PASTED_TEXT_PATTERN定数追加、skipPatterns拡張。**Issue #265: セッションエラーパターン追加** - CLAUDE_SESSION_ERROR_PATTERNS/CLAUDE_SESSION_ERROR_REGEX_PATTERNSでセッション起動失敗検出） |
| `src/lib/pasted-text-helper.ts` | Pasted text検知とEnter再送の共通ヘルパー（Issue #212: detectAndResendIfPastedText関数、リトライロジック、構造化ログ） |
| `src/lib/clipboard-utils.ts` | クリップボードコピーユーティリティ（stripAnsi利用、空文字バリデーション、Issue #211） |
| `src/lib/status-detector.ts` | セッションステータス検出の共通関数（Issue #180: route.tsインラインロジック統合、hasActivePrompt、15行プロンプト検出ウィンドウイング。Issue #188: STATUS_THINKING_LINE_COUNT=5追加、thinking/prompt優先順位統一、SF-001/SF-002/SF-004設計根拠ドキュメント化） |
| `src/lib/claude-session.ts` | Claude CLI tmuxセッション管理（Issue #152で改善: プロンプト検出強化、タイムアウトエラー、waitForPrompt()、Issue #187: sendMessageToClaude安定化待機・セパレータパターン除外・エラー伝播・CLAUDE_SEND_PROMPT_WAIT_TIMEOUT定数。Issue #212: 複数行メッセージのPasted text検知+Enter再送。**Issue #265: キャッシュ無効化・ヘルスチェック・CLAUDECODE除去** - clearCachedClaudePath()でCLI更新時の自動回復、isSessionHealthy()/ensureHealthySession()で壊れたセッション検出・再作成、sanitizeSessionEnvironment()でCLAUDECODE環境変数除去、getCleanPaneOutput()共通ヘルパー、isValidClaudePath()でCLAUDE_PATHバリデーション。**Issue #306: セッション安定性改善** - HealthCheckResult interface（@internal export）でisSessionHealthy()戻り値をreason付き構造化、SHELL_PROMPT_ENDINGS多段防御（行長チェック先行+N%個別除外）でコンテキスト残量表示の誤検出防止、ensureHealthySession()にreason付きconsole.warnログ追加、MAX_SHELL_PROMPT_LENGTH=40定数） |
| `src/lib/response-poller.ts` | レスポンスポーリングとthinking検出（Issue #188: L353/L547-554ウィンドウ化、RESPONSE_THINKING_TAIL_LINE_COUNT=5定数、detectPromptWithOptions()ヘルパー、Gemini LOADING_INDICATORS配列抽出。Issue #212: cleanClaudeResponse skipPatternsにPASTED_TEXT_PATTERN追加。**Issue #235: rawContent優先DB保存** - DB保存時にrawContent || cleanContentを使用し、完全なプロンプト出力を保持。**Issue #326: プロンプト検出レスポンス抽出修正** - resolveExtractionStartIndex()ヘルパー関数（@internal export）でstartIndex決定ロジックを一元化、インタラクティブプロンプト検出時にlastCapturedLine以降の行のみをレスポンスとして返すよう修正、箇所2にstripAnsi()追加（XSSリスク軽減）） |
| `src/lib/prompt-detector.ts` | プロンプト検出ロジック（Issue #161: 2パス❯検出方式で誤検出防止、連番検証。Issue #193: DetectPromptOptions interface追加、requireDefaultIndicatorフラグによる❯なし形式対応、Layer 5 SEC-001ガード。Issue #208: SEC-001b質問行妥当性検証追加、isQuestionLikeLine()による番号付きリスト誤検出防止。**Issue #235: rawContentフィールド追加** - PromptDetectionResultにrawContent?:stringを追加し、truncateRawContent()で最大200行/5000文字に制限。lastLinesを末尾20行に拡張。**Issue #256: isQuestionLikeLine()の複数行質問対応**（行内?チェック、キーワード単独マッチ）、SEC-001b上方走査（findQuestionLineInRange()関数、SF-S4-001 scanRangeバリデーション）、Pass 2ループ内isQuestionLikeLine()先行チェック（MF-001: isContinuationLine SRP維持）、QUESTION_SCAN_RANGE=3） |
| `src/lib/version-checker.ts` | GitHub API呼び出し、semver比較、globalThisキャッシュ（Issue #257: バージョンアップ通知機能。Issue #278: cache: 'no-store'追加でNext.js Data Cache無効化。SEC-001 SSRF防止、SEC-SF-001レスポンスバリデーション、JSDocでglobalThisキャッシュ動作を明記） |
| `src/hooks/useUpdateCheck.ts` | アップデートチェック用カスタムフック（Issue #257: /api/app/update-check呼び出し、loading/error/data状態管理） |
| `src/components/worktree/VersionSection.tsx` | バージョン表示+通知統合コンポーネント（Issue #257: SF-001 DRY準拠、InfoModal/MobileInfoContent共通化） |
| `src/components/worktree/UpdateNotificationBanner.tsx` | アップデート通知バナーUI（Issue #257: MF-001 SRP準拠、i18n対応、GitHub Releasesリンク） |
| `src/lib/auto-yes-manager.ts` | Auto-Yes状態管理とサーバー側ポーリング（Issue #138）、thinking状態のprompt検出スキップ（Issue #161）。**Issue #306: 重複応答防止** - AutoYesPollerStateにlastAnsweredPromptKey追加、isDuplicatePrompt()ヘルパー、プロンプト非検出時nullリセット、COOLDOWN_INTERVAL_MS=5000クールダウン、scheduleNextPoll()にoverride_interval下限値ガード付き）。**Issue #314: Stop条件機能追加** - AutoYesStateにstopPattern/stopReason追加、disableAutoYes()専用関数（全フィールド明示設定）、checkStopCondition()独立関数（@internal export、safe-regex2+タイムアウト保護）、executeRegexWithTimeout()タイムアウト保護付き評価、pollAutoYes()にStop条件チェック挿入（thinking後・プロンプト検出前）、AutoYesStopReason型をauto-yes-config.tsに移動） |
| `src/config/auto-yes-config.ts` | Auto-Yes設定定数・共通バリデーション（ALLOWED_DURATIONS、DEFAULT_AUTO_YES_DURATION、isAllowedDuration、formatTimeRemaining）。**Issue #314: Stop条件バリデーション追加** - MAX_STOP_PATTERN_LENGTH=500定数、AutoYesStopReason型（クライアント/サーバー共用）、validateStopPattern()共通バリデーション関数（safe-regex2 ReDoS検出・構文検証・エラーメッセージ固定文字列）） |
| `src/lib/prompt-key.ts` | promptKeyデduplication共通ユーティリティ（Issue #306: generatePromptKey()でtype:questionキー生成、クライアント/サーバー間DRY原則対応、PromptKeyInput interface） |
| `src/lib/auto-yes-resolver.ts` | Auto-Yes自動応答判定ロジック |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック（重複応答防止対応。**Issue #287: promptType/defaultOptionNumber送信** - prompt-response APIリクエストにpromptType/defaultOptionNumberを含め、promptCheck再検証失敗時のフォールバック対応。**Issue #306: generatePromptKey()使用** - promptKey生成をprompt-key.tsの共通ユーティリティに統一） |
| `src/lib/prompt-response-body-builder.ts` | プロンプト応答リクエストボディ構築ユーティリティ（Issue #287: buildPromptResponseBody()関数でpromptType/defaultOptionNumberを含むリクエストボディを生成、DRY原則対応、useAutoYes/WorktreeDetailRefactoredから共通化） |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/cli-tools/codex.ts` | Codex CLI tmuxセッション管理（Issue #212: 複数行メッセージのPasted text検知+Enter再送、getErrorMessage()ヘルパー抽出） |
| `src/lib/session-cleanup.ts` | セッション/ポーラー停止の一元管理（Facade パターン） |
| `src/lib/url-normalizer.ts` | Git URL正規化（重複検出用） |
| `src/lib/url-path-encoder.ts` | ファイルパスのURLエンコード（Issue #300: encodePathForUrl()関数、スラッシュを保護しながら各セグメントを個別にencodeURIComponent、catch-allルートのパス分割を維持） |
| `src/lib/clone-manager.ts` | クローン処理管理（DBベース排他制御。**Issue #308: basePath修正** - resolveDefaultBasePath()でCM_ROOT_DIR/WORKTREE_BASE_PATH/process.cwd()優先順位制御、WORKTREE_BASE_PATH非推奨警告（モジュールスコープwarnedWorktreeBasePathフラグで初回のみ出力）、path.resolve()による絶対パス正規化、resetWorktreeBasePathWarning()テスト用エクスポート） |
| `src/lib/db-repository.ts` | リポジトリDB操作関数群（Issue #190: 除外・復活・パス正規化・バリデーション関数追加、Issue #202: registerAndFilterRepositories統合関数追加） |
| `src/types/sidebar.ts` | サイドバーステータス判定 |
| `src/types/clone.ts` | クローン関連型定義（CloneJob, CloneError等） |
| `src/lib/file-operations.ts` | ファイル操作（読取/更新/作成/削除/リネーム/移動）、Issue #162: moveFileOrDirectory()追加、5層セキュリティ（SEC-005〜009: 保護ディレクトリ/シンボリック/自己移動/最終パス/TOCTOU検証）、validateFileOperation()共通検証、mapFsError()エラーマッピング |
| `src/lib/date-utils.ts` | 相対時刻フォーマット（Issue #162: formatRelativeTime()、date-fnsベース、ロケール対応、無効日付ガード） |
| `src/lib/file-tree.ts` | ディレクトリツリー構造生成（Issue #162: readDirectory()でbirthtime取得、TreeItem.birthtimeフィールド対応） |
| `src/lib/git-utils.ts` | Git情報取得（getGitStatus関数、execFile使用、1秒タイムアウト） |
| `src/lib/utils.ts` | 汎用ユーティリティ関数（debounce、truncateString、escapeHtml等） |
| `src/config/editable-extensions.ts` | 編集可能ファイル拡張子設定 |
| `src/config/file-operations.ts` | 再帰削除の安全設定 |
| `src/types/markdown-editor.ts` | マークダウンエディタ関連型定義 |
| `src/hooks/useContextMenu.ts` | コンテキストメニュー状態管理フック（MouseEvent/TouchEvent対応） |
| `src/hooks/useFileOperations.ts` | ファイル操作フック（Issue #162: move操作の状態管理、MoveTarget型、UIロジック分離） |
| `src/hooks/useLongPress.ts` | タッチ長押し検出フック（Issue #123、500ms閾値、10px移動キャンセル） |
| `src/hooks/useSwipeGesture.ts` | スワイプジェスチャー検出フック（Issue #299: isInsideScrollableElement追加でscrollable要素内スワイプを抑制） |
| `src/hooks/useFullscreen.ts` | Fullscreen API ラッパー（CSSフォールバック対応） |
| `src/hooks/useLocalStorageState.ts` | localStorage永続化フック（バリデーション対応） |
| `src/config/z-index.ts` | z-index値の一元管理（Issue #299: JSDocコメント修正、レイヤー番号繰り上げ MODAL=50, MAXIMIZED_EDITOR=55, TOAST=60, CONTEXT_MENU=70） |
| `src/config/uploadable-extensions.ts` | アップロード可能拡張子・MIMEタイプ・マジックバイト検証（Issue #302: mp4バリデータ追加、15MB上限、ftypシグネチャ検証） |
| `src/config/image-extensions.ts` | 画像ファイル拡張子・マジックバイト・SVG XSS検証 |
| `src/config/video-extensions.ts` | 動画ファイル拡張子・マジックバイト・MIME定義（Issue #302: VIDEO_EXTENSIONS、isVideoExtension()、getMimeTypeByVideoExtension()、validateVideoContent()） |
| `src/config/mermaid-config.ts` | mermaid設定定数（securityLevel='strict'） |
| `src/config/binary-extensions.ts` | バイナリファイル拡張子設定（検索除外用） |
| `src/lib/file-search.ts` | ファイル内容検索ロジック（EXCLUDED_PATTERNSフィルタ、AbortControllerタイムアウト） |
| `src/components/worktree/SearchBar.tsx` | 検索UIコンポーネント（検索入力、モード切替、ローディング表示。Issue #299: MOBILE_BREAKPOINT定数使用） |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック（debounce処理、API呼び出し、結果管理） |
| `src/components/worktree/MoveDialog.tsx` | ファイル移動先選択ダイアログ（Issue #162: ディレクトリツリーブラウザ、ルート選択、ネスト対応、updateTreeNode/findNodeByPath抽出） |
| `src/components/ui/Modal.tsx` | モーダルダイアログコンポーネント（Issue #299: z-[9999]ハードコード除去、Z_INDEX.MODAL使用に統一） |
| `src/components/common/Toast.tsx` | トースト通知コンポーネント（Issue #299: z-50ハードコード除去、Z_INDEX.TOAST使用に統一） |
| `src/components/worktree/ContextMenu.tsx` | ファイル/ディレクトリコンテキストメニュー（Issue #162: 「移動」メニュー項目追加、FolderInputアイコン、onMoveコールバック。Issue #299: z-50除去、Z_INDEX.CONTEXT_MENU使用） |
| `src/components/worktree/FileViewer.tsx` | ファイルビューア（Issue #162: コピーボタン追加、Copy/Checkアイコン切替、useMemo最適化、画像ファイル非表示。**Issue #302: 動画表示分岐追加、canCopyロジック修正（isVideo除外）**） |
| `src/components/worktree/FileTreeView.tsx` | ファイルツリー表示（Issue #162: birthtime表示、formatRelativeTime()ロケール対応、sm:inline条件表示。Issue #300: 非空状態にツールバー追加、data-testid=file-tree-toolbar/toolbar-new-file-button/toolbar-new-directory-button、onNewFile('')/onNewDirectory('')でルートレベル作成） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（Issue #162: handleMoveハンドラー追加、MoveDialog統合、useFileOperations呼び出し。Issue #300: handleNewFile/handleNewDirectory/handleRename/handleDelete/handleFileInputChangeの5箇所でencodeURIComponentをencodePathForUrl()に置換） |
| `src/components/worktree/MemoCard.tsx` | メモカードコンポーネント（インライン編集・自動保存・削除ボタン。**Issue #321: コピーボタン追加**、Copy/Checkアイコン切替（2秒）、useRefタイマークリーンアップ（S1-002）、COPY_FEEDBACK_DURATION_MS定数、サイレントエラーハンドリング） |
| `src/components/worktree/MemoPane.tsx` | メモ一覧コンテナ（最大5件、GET/POST/DELETE操作、ローディング・エラー状態管理） |
| `src/components/worktree/MemoAddButton.tsx` | メモ追加ボタン（残件数表示、上限時disabled、ローディングインジケーター） |
| `src/components/worktree/ImageViewer.tsx` | 画像表示コンポーネント |
| `src/components/worktree/VideoViewer.tsx` | 動画再生コンポーネント（Issue #302: HTML5 videoタグ、controls属性、ローディングインジケーター、エラーフォールバックUI） |
| `src/components/worktree/MermaidDiagram.tsx` | mermaidダイアグラム描画コンポーネント |
| `src/components/worktree/MermaidCodeBlock.tsx` | mermaidコードブロックラッパー |
| `src/config/log-config.ts` | LOG_DIR定数の一元管理（getLogDir()関数、DRY原則対応） |
| `src/lib/log-export-sanitizer.ts` | エクスポート用パス・環境情報・機密データサニタイズ（Issue #11: sanitizeForExport()関数、HOME/CM_ROOT_DIR/CM_DB_PATH/ホスト名/トークン/パスワード/SSHキーのマスキング） |
| `src/lib/api-logger.ts` | 共通withLogging()ヘルパー（Issue #11: 開発環境APIリクエスト/レスポンスロギング、ジェネリクス型ApiHandler、skipResponseBodyオプション） |
| `src/config/i18n-config.ts` | i18n設定の一元管理（SUPPORTED_LOCALES, DEFAULT_LOCALE, LOCALE_LABELS, LOCALE_COOKIE_NAME） |
| `src/i18n.ts` | next-intl getRequestConfig（Cookie→Accept-Language→DEFAULT_LOCALEフォールバック、全名前空間マージ） |
| `src/lib/locale-cookie.ts` | ロケールCookieユーティリティ（SameSite=Lax、条件付きSecure、1年有効期限） |
| `src/hooks/useLocaleSwitch.ts` | ロケール切替フック（バリデーション、Cookie/localStorage永続化、reload） |
| `src/components/common/LocaleSwitcher.tsx` | 言語切替ドロップダウンコンポーネント（Sidebar下部配置） |
| `src/components/common/NotificationDot.tsx` | 通知ドットバッジ共通コンポーネント（Issue #278: DRY原則準拠、w-2 h-2 rounded-full bg-blue-500、Desktop/Mobile通知インジケーター統一） |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング（getDateFnsLocale()、enUS/jaサポート） |
| `src/config/github-links.ts` | GitHub URL定数の一元管理（Issue #264: GITHUB_REPO_BASE_URL派生、DRY原則対応、SSRF防止のためGITHUB_API_URLは除外） |
| `src/components/worktree/FeedbackSection.tsx` | フィードバックリンクセクション（Issue #264: Bug Report/Feature Request/Question/View Issues、noopener noreferrer、i18n対応） |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力コンポーネント（Issue #288: isFreeInputModeフラグ追加、フリー入力モード中のセレクター再表示防止、モバイルボタンガード、経路分析コメント） |
| `tests/helpers/message-input-test-utils.ts` | MessageInputテスト共通ヘルパー（Issue #288: モック定数、props factory、DOM queries、interaction helpers、DRY原則対応） |

### CLIモジュール（Issue #96, #136）

| モジュール | 説明 |
|-----------|------|
| `src/cli/index.ts` | CLIメインロジック（commander設定） |
| `src/cli/commands/init.ts` | initコマンド（対話形式/非対話形式対応、Issue #119） |
| `src/cli/commands/start.ts` | startコマンド（フォアグラウンド/デーモン起動、--issue対応 Issue #136） |
| `src/cli/commands/stop.ts` | stopコマンド（サーバー停止、--issue対応 Issue #136） |
| `src/cli/commands/status.ts` | statusコマンド（状態確認、--issue/--all対応 Issue #136） |
| `src/cli/utils/preflight.ts` | システム依存関係チェック |
| `src/cli/utils/env-setup.ts` | 環境設定ファイル生成、getPidFilePath()、パストラバーサル対策（Issue #125, #136） |
| `src/cli/utils/daemon.ts` | デーモンプロセス管理、dotenv読み込み、セキュリティ警告（Issue #125） |
| `src/cli/utils/pid-manager.ts` | PIDファイル管理（O_EXCLアトミック書き込み） |
| `src/cli/utils/security-logger.ts` | セキュリティイベントログ |
| `src/cli/utils/prompt.ts` | 対話形式プロンプトユーティリティ（Issue #119） |
| `src/cli/utils/install-context.ts` | インストールコンテキスト検出（isGlobalInstall, getConfigDir）（Issue #136） |
| `src/cli/utils/input-validators.ts` | 入力検証（Issue番号、ブランチ名）（Issue #136） |
| `src/cli/utils/resource-resolvers.ts` | リソースパス解決（DB、PID、Log）（Issue #136） |
| `src/cli/utils/port-allocator.ts` | ポート自動割り当て（MAX_WORKTREES=10制限）（Issue #136） |
| `src/cli/utils/worktree-detector.ts` | Worktree検出ユーティリティ（Issue #136） |
| `src/cli/utils/daemon-factory.ts` | DaemonManagerファクトリー（Issue #136） |
| `src/cli/commands/issue.ts` | issueコマンド（Issue #264: gh CLI連携、create/search/listサブコマンド、テンプレートマッピング、入力バリデーション） |
| `src/cli/commands/docs.ts` | docsコマンド（Issue #264: ドキュメント参照、--section/--search/--all、DocsReaderに委譲） |
| `src/cli/utils/docs-reader.ts` | ドキュメント読み取りユーティリティ（Issue #264: SECTION_MAPホワイトリスト、パストラバーサル防止、検索クエリ長制限） |
| `src/cli/config/cli-dependencies.ts` | 依存関係定義（Issue #264: gh CLIをオプション依存として追加） |
| `src/cli/config/ai-integration-messages.ts` | AIツール統合ガイドメッセージ（Issue #264: init完了後に表示） |
| `src/cli/types/index.ts` | CLI共通型定義（ExitCode enum、StartOptions、StopOptions、StatusOptions、IssueCreateOptions、DocsOptions） |

### テストヘルパー（Issue #256）

| モジュール | 説明 |
|-----------|------|
| `tests/helpers/prompt-type-guards.ts` | プロンプト型ガード関数（isMultipleChoicePrompt、isYesNoPrompt）共有化（DRY原則対応） |

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
