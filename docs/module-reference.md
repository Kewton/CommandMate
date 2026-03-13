# モジュールリファレンス

各モジュールの詳細な実装情報（Issue番号、関数シグネチャ、定数、セキュリティ注釈など）を記載しています。

---

## 主要機能モジュール

| モジュール | 説明 |
|-----------|------|
| `src/lib/security/ip-restriction.ts` | IPアドレス/CIDR制限コアモジュール（Issue #332: Edge Runtime互換、parseAllowedIps/getAllowedRanges/isIpAllowed/normalizeIp/isIpRestrictionEnabled/getClientIp、MAX_ALLOWED_IP_ENTRIES=256/MAX_CIDR_ENTRY_LENGTH=18 DoS防御、CM_TRUST_PROXY=true時X-Forwarded-For/false時X-Real-IP使用、モジュールスコープキャッシュ） |
| `src/config/auth-config.ts` | 認証設定定数（Issue #331: AUTH_COOKIE_NAME、AUTH_EXCLUDED_PATHS、Edge Runtime互換、auth.ts/middleware.ts共通。Issue #332: CM_ALLOWED_IPS、CM_TRUST_PROXY追加） |
| `src/lib/security/auth.ts` | トークン認証コアモジュール（Issue #331: generateToken/hashToken/verifyToken/parseDuration/parseCookies/isAuthEnabled/buildAuthCookieOptions/createRateLimiter、CLIビルド互換性制約: Next.js固有モジュール依存禁止） |
| `src/middleware.ts` | 認証ミドルウェア（Issue #331: HTTPリクエスト認証、CM_AUTH_TOKEN_HASH未設定時は即NextResponse.next()、AUTH_EXCLUDED_PATHSの完全一致マッチング） |
| `src/lib/env.ts` | 環境変数取得・フォールバック処理、getDatabasePathWithDeprecationWarning() |
| `src/lib/db/db-path-resolver.ts` | DBパス解決（getDefaultDbPath()、validateDbPath()） |
| `src/lib/db/db-migration-path.ts` | DBマイグレーション（migrateDbIfNeeded()、getLegacyDbPaths()） |
| `src/lib/db/db-instance.ts` | DBインスタンス管理（getEnv().CM_DB_PATH使用） |
| `src/config/system-directories.ts` | システムディレクトリ定数（SYSTEM_DIRECTORIES、isSystemDirectory()） |
| `src/config/status-colors.ts` | ステータス色の一元管理 |
| `src/lib/detection/cli-patterns.ts` | CLIツール別パターン定義（Issue #212: PASTED_TEXT_PATTERN定数追加、skipPatterns拡張。**Issue #265: セッションエラーパターン追加** - CLAUDE_SESSION_ERROR_PATTERNS/CLAUDE_SESSION_ERROR_REGEX_PATTERNSでセッション起動失敗検出。**Issue #379: OpenCodeパターン追加** - OPENCODE_PROMPT_PATTERN/OPENCODE_PROMPT_AFTER_RESPONSE/OPENCODE_THINKING_PATTERN/OPENCODE_LOADING_PATTERN/OPENCODE_RESPONSE_COMPLETE/OPENCODE_PROCESSING_INDICATOR/OPENCODE_SEPARATOR_PATTERN/OPENCODE_SKIP_PATTERNS定数、detectThinking()/getCliToolPatterns()/buildDetectPromptOptions()にcase 'opencode'追加、buildDetectPromptOptions('opencode')はrequireDefaultIndicator:false） |
| `src/lib/pasted-text-helper.ts` | Pasted text検知とEnter再送の共通ヘルパー（Issue #212: detectAndResendIfPastedText関数、リトライロジック、構造化ログ） |
| `src/lib/clipboard-utils.ts` | クリップボードコピーユーティリティ（stripAnsi利用、空文字バリデーション、Issue #211） |
| `src/lib/detection/status-detector.ts` | セッションステータス検出の共通関数（Issue #180: route.tsインラインロジック統合、hasActivePrompt、15行プロンプト検出ウィンドウイング。Issue #188: STATUS_THINKING_LINE_COUNT=5追加、thinking/prompt優先順位統一、SF-002/SF-004設計根拠ドキュメント化。**Issue #408: SF-001解消** - StatusDetectionResultにpromptDetection: PromptDetectionResult requiredフィールド追加（DR1-001）、current-output/route.tsの二重detectPrompt()呼び出し削除、全8箇所のreturnパスにpromptDetection追加） |
| `src/lib/tmux/tmux-capture-cache.ts` | tmux captureキャッシュモジュール（**Issue #405: N+1パターン解消・キャッシュ導入** - globalThisパターン（globalThis.__tmuxCaptureCache/globalThis.__tmuxCaptureCacheInflight）、TTL=2秒（CACHE_TTL_MS=2000）、CACHE_MAX_ENTRIES=100、CACHE_MAX_CAPTURE_LINES=10000。getCachedCapture()でlazy eviction、setCachedCapture()でfull sweep（SEC4-002: センシティブデータ長期残留防止）、invalidateCache()でdebugログ付き個別削除（SEC4-006）、clearAllCache()でgraceful shutdown、resetCacheForTesting()でテスト分離、getOrFetchCapture()でsingleflightパターン（inflight Mapで重複capturePane()防止）、sliceOutput()で行ベーススライス（DA3-001: lastCapturedLine整合性検証注記付き）。**Trust Boundary [SEC4-001]**: sessionNameはCLIToolManager.getTool(cliToolId).getSessionName()経由で取得すること（直接文字列構築は禁止）。**新規CLIツール追加時**: sendMessage()/killSession()実装にinvalidateCache(sessionName)を挿入すること） |
| `src/lib/session/worktree-status-helper.ts` | Worktreeセッションステータス検出ヘルパー（**Issue #405リファクタリング** - detectWorktreeSessionStatus()でworktrees/route.tsとworktrees/[id]/route.tsの重複セッション状態検出ロジックを一元化（~110行のDRY削減）。CliToolSessionStatus/WorktreeSessionStatus型定義。listSessions()一括取得→Set.has()判定→ClaudeToolのみisSessionHealthy()追加チェックのフローを実装） |
| `src/lib/session/claude-session.ts` | Claude CLI tmuxセッション管理（Issue #152で改善: プロンプト検出強化、タイムアウトエラー、waitForPrompt()、Issue #187: sendMessageToClaude安定化待機・セパレータパターン除外・エラー伝播・CLAUDE_SEND_PROMPT_WAIT_TIMEOUT定数。Issue #212: 複数行メッセージのPasted text検知+Enter再送。**Issue #265: キャッシュ無効化・ヘルスチェック・CLAUDECODE除去** - clearCachedClaudePath()でCLI更新時の自動回復、isSessionHealthy()/ensureHealthySession()で壊れたセッション検出・再作成、sanitizeSessionEnvironment()でCLAUDECODE環境変数除去、getCleanPaneOutput()共通ヘルパー、isValidClaudePath()でCLAUDE_PATHバリデーション。**Issue #306: セッション安定性改善** - HealthCheckResult interface（@internal export）でisSessionHealthy()戻り値をreason付き構造化、SHELL_PROMPT_ENDINGS多段防御（行長チェック先行+N%個別除外）でコンテキスト残量表示の誤検出防止、ensureHealthySession()にreason付きconsole.warnログ追加、MAX_SHELL_PROMPT_LENGTH=40定数。**Issue #393: 直接exec()廃止** - stopClaudeSession()内の直接exec()呼び出しをtmux.sendSpecialKey(sessionName, 'C-d')に置き換え（シェルインジェクション防止）。**Issue #405: @internal解除+キャッシュ無効化** - isSessionHealthy()/@HealthCheckResultを@internal除去してproduction export化（worktrees/route.tsからの直接呼び出しに対応）、sendMessageToClaude()/stopClaudeSession()後にinvalidateCache(sessionName)挿入） |
| `src/lib/tmux/tmux.ts` | tmuxセッション管理基盤（isTmuxAvailable/hasSession/listSessions/createSession/sendKeys/sendSpecialKeys/sendSpecialKey/capturePane/killSession/ensureSession。**Issue #393: exec()→execFile()全面移行** - 全9関数11箇所のexec()をexecFile()に移行（引数配列渡しでシェル非経由、シェルインジェクション根本防止）。SPECIAL_KEY_VALUES=['Escape','C-c','C-d','C-m','Enter'] const配列、SpecialKey型派生、ALLOWED_SINGLE_SPECIAL_KEYS=new Set<string>でsendSpecialKey()ランタイムバリデーション追加。capturePane()はmaxBuffer:10MB維持。sendKeys()のシングルクォートエスケープ不要化（execFile引数配列のため）） |
| `src/app/worktrees/[id]/terminal/page.tsx` | ターミナルページ（**Issue #410: TerminalComponentをnext/dynamicでdynamic import化（ssr: false、.then((mod) => ({ default: mod.TerminalComponent }))パターン、bg-gray-900テーマのローディングインジケーター付き）。xterm.jsのSSR互換性問題を解消** ） |
| `src/app/api/worktrees/[id]/terminal/route.ts` | ターミナルコマンド送信APIエンドポイント（**Issue #393: セキュリティ全面強化** - isCliToolType()バリデーション[D1-001]、getWorktreeById() DB存在確認[D1-002]、CLIToolManager経由セッション名取得[D1-003]、セッション自動作成廃止→404返却[D1-004]、MAX_COMMAND_LENGTH=10000 DoS防御[D1-006]、固定文字列エラーレスポンス[D1-007]、import * as tmux廃止→named import {hasSession,sendKeys}に変更、ローカルgetSessionName()/sendToTmux()廃止） |
| `src/app/api/worktrees/[id]/capture/route.ts` | ターミナル出力キャプチャAPIエンドポイント（**Issue #393: セキュリティ全面強化** - isCliToolType()バリデーション[D1-001]、getWorktreeById() DB存在確認[D1-002]、CLIToolManager経由セッション名取得[D1-003]、セッション不在404返却[D1-004]、linesパラメータ4段階バリデーション[D1-005]: typeof/Number.isInteger/境界値[1-100000]/Math.floor(defense-in-depth)、固定文字列エラーレスポンス[D1-007]、ローカルgetSessionName()廃止） |
| `src/lib/polling/response-poller.ts` | レスポンスポーリングとthinking検出（Issue #188: L353/L547-554ウィンドウ化、RESPONSE_THINKING_TAIL_LINE_COUNT=5定数、detectPromptWithOptions()ヘルパー、Gemini LOADING_INDICATORS配列抽出。Issue #212: cleanClaudeResponse skipPatternsにPASTED_TEXT_PATTERN追加。**Issue #235: rawContent優先DB保存** - DB保存時にrawContent || cleanContentを使用し、完全なプロンプト出力を保持。**Issue #326: プロンプト検出レスポンス抽出修正** - resolveExtractionStartIndex()ヘルパー関数（@internal export）でstartIndex決定ロジックを一元化、インタラクティブプロンプト検出時にlastCapturedLine以降の行のみをレスポンスとして返すよう修正、箇所2にstripAnsi()追加（XSSリスク軽減）。**Issue #379: OpenCode統合** - isOpenCodeComplete()（▣ Build·{model}·{time}パターンで完了検出）、cleanOpenCodeResponse()（TUI罫線文字・Build行・ローディングインジケーター除去）、extraction stop条件（OPENCODE_PROMPT_PATTERN/OPENCODE_PROMPT_AFTER_RESPONSE）、起動バナー防御（incompleteResult()返却）、cleanResponse分岐追加） |
| `src/lib/detection/prompt-detector.ts` | プロンプト検出ロジック（Issue #161: 2パス❯検出方式で誤検出防止、連番検証。Issue #193: DetectPromptOptions interface追加、requireDefaultIndicatorフラグによる❯なし形式対応、Layer 5 SEC-001ガード。Issue #208: SEC-001b質問行妥当性検証追加、isQuestionLikeLine()による番号付きリスト誤検出防止。**Issue #235: rawContentフィールド追加** - PromptDetectionResultにrawContent?:stringを追加し、truncateRawContent()で最大200行/5000文字に制限。lastLinesを末尾20行に拡張。**Issue #256: isQuestionLikeLine()の複数行質問対応**（行内?チェック、キーワード単独マッチ）、SEC-001b上方走査（findQuestionLineInRange()関数、SF-S4-001 scanRangeバリデーション）、Pass 2ループ内isQuestionLikeLine()先行チェック（MF-001: isContinuationLine SRP維持）、QUESTION_SCAN_RANGE=3。**Issue #402: 重複ログ抑制** - lastOutputTailモジュールスコープキャッシュで同一output末尾50行の重複ログをスキップ、resetDetectPromptCache() @internal exportでテスト分離） |
| `src/lib/version-checker.ts` | GitHub API呼び出し、semver比較、globalThisキャッシュ（Issue #257: バージョンアップ通知機能。Issue #278: cache: 'no-store'追加でNext.js Data Cache無効化。SEC-001 SSRF防止、SEC-SF-001レスポンスバリデーション、JSDocでglobalThisキャッシュ動作を明記） |
| `src/hooks/useUpdateCheck.ts` | アップデートチェック用カスタムフック（Issue #257: /api/app/update-check呼び出し、loading/error/data状態管理） |
| `src/hooks/useFragmentLogin.ts` | フラグメントベース自動ログインフック（Issue #383: URLフラグメント#token=xxxからトークン抽出、history.replaceState API前実行[S002]、processedRef重複防止[React Strict Mode]、decodeURIComponent try-catch、256文字上限、FragmentLoginErrorKey型、401/429/error対応） |
| `src/components/auth/QrCodeGenerator.tsx` | QRコード生成UIコンポーネント（Issue #383: react-qr-code使用、ngrok URL+トークン入力、QRデフォルト非表示[S001]、HTTPS警告、useTranslations('auth')直接使用、クライアントサイドのみ） |
| `src/components/worktree/VersionSection.tsx` | バージョン表示+通知統合コンポーネント（Issue #257: SF-001 DRY準拠、InfoModal/MobileInfoContent共通化） |
| `src/components/worktree/UpdateNotificationBanner.tsx` | アップデート通知バナーUI（Issue #257: MF-001 SRP準拠、i18n対応、GitHub Releasesリンク） |
| `src/lib/polling/auto-yes-manager.ts` | Auto-Yes状態管理とサーバー側ポーリング（Issue #138）、thinking状態のprompt検出スキップ（Issue #161）。**Issue #306: 重複応答防止** - AutoYesPollerStateにlastAnsweredPromptKey追加、isDuplicatePrompt()ヘルパー、プロンプト非検出時nullリセット、COOLDOWN_INTERVAL_MS=5000クールダウン、scheduleNextPoll()にoverride_interval下限値ガード付き）。**Issue #314: Stop条件機能追加** - AutoYesStateにstopPattern/stopReason追加、disableAutoYes()専用関数（全フィールド明示設定）、checkStopCondition()独立関数（@internal export、safe-regex2+タイムアウト保護）、executeRegexWithTimeout()タイムアウト保護付き評価、pollAutoYes()にStop条件チェック挿入（thinking後・プロンプト検出前）、AutoYesStopReason型をauto-yes-config.tsに移動）。**Issue #323: pollAutoYes()リファクタリング** - 関数群方式（設計選択肢B）による責務分割。validatePollingContext()/captureAndCleanOutput()/processStopConditionDelta()/detectAndRespondToPrompt()（全て@internal export）、getPollerState()内部ヘルパー追加。**Issue #404: globalThis Mapリーク対策** - deleteAutoYesState(worktreeId: string): boolean追加（isValidWorktreeId()バリデーション[SEC-404-001]、autoYesStates.delete()実行）、getAutoYesStateWorktreeIds(): string[]追加（@internal、定期クリーンアップ用）、getAutoYesPollerWorktreeIds(): string[]追加（@internal、定期クリーンアップ用）。**Issue #405: キャッシュ無効化** - detectAndRespondToPrompt()内のsendPromptAnswer()呼び出し後にtry-finallyパターンでinvalidateCache(sessionName)を実行（成功・失敗に関わらずキャッシュクリアを保証）） |
| `src/config/auto-yes-config.ts` | Auto-Yes設定定数・共通バリデーション（ALLOWED_DURATIONS、DEFAULT_AUTO_YES_DURATION、isAllowedDuration、formatTimeRemaining）。**Issue #314: Stop条件バリデーション追加** - MAX_STOP_PATTERN_LENGTH=500定数、AutoYesStopReason型（クライアント/サーバー共用）、validateStopPattern()共通バリデーション関数（safe-regex2 ReDoS検出・構文検証・エラーメッセージ固定文字列）） |
| `src/lib/detection/prompt-key.ts` | promptKeyデduplication共通ユーティリティ（Issue #306: generatePromptKey()でtype:questionキー生成、クライアント/サーバー間DRY原則対応、PromptKeyInput interface） |
| `src/lib/polling/auto-yes-resolver.ts` | Auto-Yes自動応答判定ロジック |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック（重複応答防止対応。**Issue #287: promptType/defaultOptionNumber送信** - prompt-response APIリクエストにpromptType/defaultOptionNumberを含め、promptCheck再検証失敗時のフォールバック対応。**Issue #306: generatePromptKey()使用** - promptKey生成をprompt-key.tsの共通ユーティリティに統一） |
| `src/lib/prompt-response-body-builder.ts` | プロンプト応答リクエストボディ構築ユーティリティ（Issue #287: buildPromptResponseBody()関数でpromptType/defaultOptionNumberを含むリクエストボディを生成、DRY原則対応、useAutoYes/WorktreeDetailRefactoredから共通化） |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/cli-tools/types.ts` | CLIツール型定義（Issue #368: CLI_TOOL_IDS=['claude','codex','gemini','vibe-local']、CLIToolType、CLI_TOOL_DISPLAY_NAMES、getCliToolDisplayName()で表示名共通化、isCliToolType()型ガード、getCliToolDisplayNameSafe()フォールバック付きラッパー。**Issue #374: VIBE_LOCAL_CONTEXT_WINDOW_MIN=128、VIBE_LOCAL_CONTEXT_WINDOW_MAX=2097152定数追加、isValidVibeLocalContextWindow(value:unknown):value is number 型ガード関数追加（API層・CLI層で共有）。Issue #379: CLI_TOOL_IDS=['claude','codex','gemini','vibe-local','opencode']（5ツール）、CLI_TOOL_DISPLAY_NAMES に opencode:'OpenCode' 追加**） |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local CLIツール実装（Issue #368: VibeLocalTool、BaseCLITool継承、tmuxセッション管理。**Issue #374: startSession()で--context-windowオプション対応、DBからvibeLocalContextWindow取得、defense-in-depth バリデーション後 --context-window ${Number(ctxWindow)} を追加（tmuxセッションのみ、-pモードはスコープ外）**） |
| `src/lib/cli-tools/opencode.ts` | OpenCode CLIツール実装（Issue #379: OpenCodeTool、BaseCLITool継承、tmuxセッション管理。startSession()でensureOpencodeConfig()+tmux 80カラム幅起動（サイドバー非表示）、sendMessage()でsend-keys+C-m+pasted-text検知、killSession()で/exitグレースフルシャットダウン→タイムアウト後tmux kill-sessionフォールバック（D1-006/D1-007）、interrupt()はBaseCLIToolのEscapeキー継承（D2-008）、OPENCODE_EXIT_COMMAND='/exit'、OPENCODE_INIT_WAIT_MS=15000） |
| `src/lib/cli-tools/opencode-config.ts` | OpenCode設定自動生成モジュール（Issue #379: ensureOpencodeConfig()でOllama API/api/tagsからモデル取得→opencode.json生成（存在時はスキップ）。SEC-001 SSRF防止: OLLAMA_API_URL/OLLAMA_BASE_URLはハードコード定数。D4-003: OLLAMA_MODEL_PATTERN=/^[a-zA-Z0-9._:/-]{1,100}$/（長さ制限付き）。D4-004: validateWorktreePath()で3層パストラバーサル防御（path.resolve+lstatSync+realpathSync）。D4-005: JSON.stringify()でopencode.json生成（テンプレートリテラル禁止）。D4-007: レスポンスサイズ制限1MB+スキーマバリデーション。MAX_OLLAMA_MODELS=100でDoS防御。Ollama未起動時は非致命的エラーで続行。**Issue #398: LM Studio統合** - fetchOllamaModels()/fetchLmStudioModels()独立関数化（Promise.all並列取得、失敗時は空{}返却）、LM_STUDIO_API_URL='http://localhost:1234/v1/models'/LM_STUDIO_BASE_URL='http://localhost:1234/v1'（SEC-001 SSRFハードコード）、LM_STUDIO_MODEL_PATTERN=/^[a-zA-Z0-9._:/@-]{1,200}$/（@許可・200文字制限）、MAX_LM_STUDIO_MODELS=100、ProviderModels型エイリアス（Record<string,{name:string}>）、動的プロバイダー構成（0件プロバイダー省略・両方0件時opencode.json非生成）、lmstudioプロバイダー（npm:@ai-sdk/openai-compatible、name:'LM Studio (local)'）） |
| `src/lib/selected-agents-validator.ts` | エージェント選択バリデーター（Issue #368: validateAgentsPair()共通コア、parseSelectedAgents()DB読取用・フォールバック付き、validateSelectedAgentsInput()API入力用、DEFAULT_SELECTED_AGENTS=['claude','codex']。**Issue #438: 2-4エージェント対応** - MIN_SELECTED_AGENTS=2/MAX_SELECTED_AGENTS=4、型を[CLIToolType,CLIToolType]からCLIToolType[]に変更、重複チェックをSet.sizeベースに統一） |
| `src/lib/cli-tools/codex.ts` | Codex CLI tmuxセッション管理（Issue #212: 複数行メッセージのPasted text検知+Enter再送、getErrorMessage()ヘルパー抽出。**Issue #393: 直接exec()廃止** - Down/Enter/C-m/C-dの4箇所のexecAsync('tmux send-keys...')をtmux.sendSpecialKeys()/sendSpecialKey()に置き換え、child_processインポート削除。**Issue #405: キャッシュ無効化** - sendMessage()後にinvalidateCache(sessionName)挿入） |
| `src/lib/session-cleanup.ts` | セッション/ポーラー/スケジューラー停止の一元管理（Facade パターン。**Issue #294: stopScheduleForWorktree()呼び出し追加**。**Issue #404: cleanupWorktreeSessions()の呼び出し順序変更** - stopAllSchedules()をstopScheduleForWorktree(worktreeId)に変更、deleteAutoYesState(worktreeId)追加（呼び出し順序: stopAutoYesPolling() → deleteAutoYesState() → stopScheduleForWorktree()）。**Issue #405: clearAllCache()追加** - cleanupWorktreeSessions()の先頭でtmuxキャプチャキャッシュを全クリア（shutdown開始時の即時無効化）） |
| `src/lib/resource-cleanup.ts` | リソースリーク対策モジュール（**Issue #404**: cleanupOrphanedMcpProcesses(): Promise<OrphanCleanupResult>でppid=1+MCP_PROCESS_PATTERNS複合チェック・execFile('ps')使用・PIDバリデーション・コンテナ環境[/proc/1/cgroup存在]スキップ、cleanupOrphanedMapEntries(): CleanupMapResultでDB照会+autoYesStates/autoYesPollerStates孤立エントリ検出・削除、initResourceCleanup()で24時間タイマー起動[CLEANUP_INTERVAL_MS=24h、__resourceCleanupTimerId重複防止]、stopResourceCleanup()でclearInterval停止。MCP_PROCESS_PATTERNS=['codex mcp-server','playwright-mcp']、MAX_PS_OUTPUT_BYTES=1MB） |
| `src/lib/security/env-sanitizer.ts` | 環境変数サニタイズユーティリティ（Issue #294: SENSITIVE_ENV_KEYS配列[CLAUDECODE, CM_AUTH_TOKEN_HASH, CM_AUTH_EXPIRE, CM_HTTPS_KEY, CM_HTTPS_CERT, CM_ALLOWED_IPS, CM_TRUST_PROXY, CM_DB_PATH] + sanitizeEnvForChildProcess()関数。S1-001/S4-001: CLAUDECODE除去ロジックの一元管理） |
| `src/lib/cmate-parser.ts` | CMATE.md汎用パーサー（Issue #294: parseCmateFile()→Map<string,string[][]>、parseSchedulesSection()→ScheduleEntry[]、sanitizeMessageContent()でUnicode制御文字除去[S4-002]、NAME_PATTERN/MAX_NAME_LENGTH でName列バリデーション[S4-011]、validateCmatePath()でパストラバーサル防御、isValidCronExpression()でcron式バリデーション。**Issue #406: 同期I/O非同期化** - import変更(fs→fs/promises)、validateCmatePath()をasync化(realpathSync→await realpath、Promise<boolean>戻り値)、readCmateFile()をasync化(readFileSync→await readFile、Promise<CmateConfig|null>戻り値)、ENOENTエラーハンドリング維持） |
| `src/types/cmate.ts` | CMATE.md型定義（Issue #294: ScheduleEntry interface、CmateConfig型） |
| `src/lib/session/claude-executor.ts` | CLI非インタラクティブ実行エンジン（Issue #294: child_process.execFile使用[SEC-001]、sanitizeEnvForChildProcess()でSENSITIVE_ENV_KEYS除去、MAX_OUTPUT_SIZE=1MB/MAX_STORED_OUTPUT_SIZE=100KB[S1-014]、EXECUTION_TIMEOUT_MS=5分、MAX_MESSAGE_LENGTH=10000、executeClaudeCommand()、truncateOutput()。**Issue #379: ALLOWED_CLI_TOOLSに'opencode'追加、buildCliArgs()にcase 'opencode'追加（['run', '-m', 'ollama/{model}', message]形式）**） |
| `src/lib/schedule-manager.ts` | サーバーサイドスケジューラー（Issue #294: globalThis.__scheduleManagerStates/globalThis.__scheduleActiveProcesses、cronパターンでcron評価[croner]、単一タイマー全worktree巡回[60秒]、同時実行防止、MAX_CONCURRENT_SCHEDULES=100、再起動リカバリ[status=running→failed]、initScheduleManager()はinitializeWorktrees()完了後に呼び出し[S3-010]、stopAllSchedules()でSIGKILL fire-and-forget[S3-001]。**Issue #409: パフォーマンス最適化** - ManagerStateに`cmateFileCache: Map<string, number>`追加（mtimeMs保持、SEC4-001サイズ上限根拠付きJSDoc）、`getCmateMtime()`でfs.statSync().mtimeMsキャッシュしCMATE.md未変更時のパース・DBクエリをスキップ（ENOENT→null、SEC4-003トラスト境界）、`batchUpsertSchedules()`でworktree単位バルクSELECT+db.transaction()バッチ化（旧`upsertSchedule()`を完全置換、SEC4-002 SQLインジェクション安全IN句）、stopAllSchedules()でcmateFileCache.clear()追加（DR1-008ライフサイクル管理）。**Issue #404: worktree単位停止** - stopScheduleForWorktree(worktreeId: string): void追加（schedulesマップ全イテレーションでworktreeIdフィルタ・cronJob停止・schedules削除、cmateFileCache DBルックアップでworktreeId→path変換・エントリ削除、DBルックアップ失敗時フォールバック、activeProcessesは自然回収委任）、getScheduleWorktreeIds(): string[]追加（@internal、Set重複除去）。**Issue #406: syncSchedules()非同期化** - syncSchedules()をasync化（await readCmateFile()）、ManagerStateにisSyncing: boolean追加（DJ-007並行実行防止ガード、try-finallyでリセット）、initScheduleManager()内をvoid syncSchedules()にfire-and-forget化（DJ-002: .catchなし、fail-fast）、setInterval内をvoid syncSchedules().catch()に変更（DJ-003: 繰返し実行安全性）） |
| `src/config/schedule-config.ts` | スケジュール関連設定定数の一元管理（Issue #294リファクタリング: UUID_V4_PATTERN、isValidUuidV4()、MAX_NAME_LENGTH、MAX_MESSAGE_LENGTH、MAX_CRON_LENGTH。DRY原則対応） |
| `src/lib/proxy/handler.ts` | HTTPプロキシハンドラ（Issue #42: proxyHttp/proxyWebSocket/buildUpstreamUrl/isWebSocketUpgrade。**Issue #376: buildUpstreamUrl()がpathPrefix含むフルパスを転送するよう修正**、コメント・JSDoc更新。**Issue #395: セキュリティ強化** - proxyHttp()リクエストヘッダフィルタにSENSITIVE_REQUEST_HEADERS追加（cookie/authorization/proxy-authorization/x-forwarded-for/x-forwarded-host/x-forwarded-proto/x-real-ip除去）、レスポンスヘッダフィルタにSENSITIVE_RESPONSE_HEADERS追加（set-cookie/CSP/HSTS/X-Frame-Options/CORS系11ヘッダ除去）、proxyWebSocket()からdirectUrlフィールド・内部URL情報を削除し固定文字列メッセージのみ返却、filterHeaders(source, ...exclusionLists)ヘルパー関数追加（DRY: リクエスト/レスポンス共通フィルタリングロジックを一元化）） |
| `src/lib/proxy/logger.ts` | プロキシリクエストログ（Issue #42: logProxyRequest/logProxyError、ProxyLogEntry型。**Issue #376: 二重プレフィックス修正** - pathが既に/proxy/{pathPrefix}/...形式のためpathPrefix手動結合を除去） |
| `src/lib/proxy/config.ts` | プロキシ設定定数（PROXY_TIMEOUT/HOP_BY_HOP_REQUEST_HEADERS/HOP_BY_HOP_RESPONSE_HEADERS/PROXY_STATUS_CODES/PROXY_ERROR_MESSAGES。**Issue #395: SENSITIVE_REQUEST_HEADERS追加**（cookie/authorization/proxy-authorization/x-forwarded-for/x-forwarded-host/x-forwarded-proto/x-real-ip の7ヘッダ、as const配列）、**SENSITIVE_RESPONSE_HEADERS追加**（set-cookie/content-security-policy/content-security-policy-report-only/x-frame-options/strict-transport-security/access-control-allow-origin/access-control-allow-credentials/access-control-allow-methods/access-control-allow-headers/access-control-expose-headers/access-control-max-age の11ヘッダ、as const配列）） |
| `src/lib/url-normalizer.ts` | Git URL正規化（重複検出用） |
| `src/lib/url-path-encoder.ts` | ファイルパスのURLエンコード（Issue #300: encodePathForUrl()関数、スラッシュを保護しながら各セグメントを個別にencodeURIComponent、catch-allルートのパス分割を維持） |
| `src/lib/git/clone-manager.ts` | クローン処理管理（DBベース排他制御。**Issue #308: basePath修正** - resolveDefaultBasePath()でCM_ROOT_DIR/WORKTREE_BASE_PATH/process.cwd()優先順位制御、WORKTREE_BASE_PATH非推奨警告（モジュールスコープwarnedWorktreeBasePathフラグで初回のみ出力）、path.resolve()による絶対パス正規化、resetWorktreeBasePathWarning()テスト用エクスポート。**Issue #392: クローン先パス検証バイパス修正** - resolveCustomTargetPath()[@internal export]でvalidateWorktreePath()をラップし例外→null変換+console.warnロギング[S1-001]、startCloneJob()でcustomTargetPathを解決済み絶対パスに変換してから使用[D1-002]、isPathSafe直接使用を廃止しvalidateWorktreePath経由に統一[D5-001]） |
| `src/lib/db/db-repository.ts` | リポジトリDB操作関数群（Issue #190: 除外・復活・パス正規化・バリデーション関数追加、Issue #202: registerAndFilterRepositories統合関数追加） |
| `src/types/sidebar.ts` | サイドバーステータス判定 |
| `src/types/clone.ts` | クローン関連型定義（CloneJob, CloneError等） |
| `src/lib/security/path-validator.ts` | パスバリデーション（isPathSafe()レキシカル検証、validateWorktreePath()ラッパー。**Issue #394: resolveAndValidateRealPath()追加** - realpathSyncによるsymlinkトラバーサル防御、祖先走査フォールバック（create/upload用）、isWithinRoot()境界チェックヘルパー、macOS tmpdir互換性、fail-safe設計、[SEC-394]ログ出力） |
| `src/lib/file-operations.ts` | ファイル操作（読取/更新/作成/削除/リネーム/移動）、Issue #162: moveFileOrDirectory()追加、5層セキュリティ（SEC-005〜009: 保護ディレクトリ/シンボリック/自己移動/最終パス/TOCTOU検証）、validateFileOperation()共通検証、mapFsError()エラーマッピング。**Issue #394: checkPathSafety()追加** - isPathSafe+resolveAndValidateRealPathの二重検証をDRY化、readFileContent/updateFileContent/createFileOrDirectory/deleteFileOrDirectory/writeBinaryFile/validateFileOperationに統合 |
| `src/lib/date-utils.ts` | 相対時刻フォーマット（Issue #162: formatRelativeTime()、date-fnsベース、ロケール対応、無効日付ガード） |
| `src/lib/file-tree.ts` | ディレクトリツリー構造生成（Issue #162: readDirectory()でbirthtime取得、TreeItem.birthtimeフィールド対応） |
| `src/lib/git/git-utils.ts` | Git情報取得（getGitStatus関数、execFile使用、1秒タイムアウト） |
| `src/lib/utils.ts` | 汎用ユーティリティ関数（debounce、truncateString、escapeHtml等） |
| `src/config/editable-extensions.ts` | 編集可能ファイル拡張子設定 |
| `src/config/file-operations.ts` | 再帰削除の安全設定 |
| `src/types/markdown-editor.ts` | マークダウンエディタ関連型定義（Issue #389: LOCAL_STORAGE_KEY_AUTO_SAVE='commandmate:md-editor-auto-save'、AUTO_SAVE_DEBOUNCE_MS=3000定数追加） |
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
| `src/components/worktree/FileViewer.tsx` | ファイルビューア（Issue #162: コピーボタン追加、Copy/Checkアイコン切替、useMemo最適化、画像ファイル非表示。**Issue #302: 動画表示分岐追加、canCopyロジック修正（isVideo除外）**。**Issue #411: React.memo()ラップ（named export形式、isOpen=false時のポーリング起因再レンダースキップ）**） |
| `src/components/worktree/FileTreeView.tsx` | ファイルツリー表示（Issue #162: birthtime表示、formatRelativeTime()ロケール対応、sm:inline条件表示。Issue #300: 非空状態にツールバー追加、data-testid=file-tree-toolbar/toolbar-new-file-button/toolbar-new-directory-button、onNewFile('')/onNewDirectory('')でルートレベル作成） |
| `src/components/worktree/AgentSettingsPane.tsx` | エージェント選択UIコンポーネント（Issue #368: checkbox UIで2ツールまで選択、2選択済み時未選択項目disabled、PATCH APIで永続化、getCliToolDisplayName()使用、useRef安定コールバック。**Issue #374: vibeLocalContextWindow props追加、Vibe Local選択時にコンテキストウィンドウ入力欄表示（type=number/min=128/max=2097152/step=1）、VIBE_LOCAL_CONTEXT_WINDOW_MIN/MAX定数使用**。**Issue #391: isEditing stateによるポーリング上書き抑制 - チェック解除中間状態でuseEffectガード（if (!isEditing)）、API完了時finally節でisEditing=false、API成功時setCheckedIds(pair)先行呼び出し**。**Issue #438: maxAgents propsで最大選択数を外部制御（PC=4、モバイル=2）、DEFAULT_MAX_AGENTS=2/MIN_AGENTS_FOR_PERSIST=2定数、2個以上選択時にAPI永続化**） |
| `src/components/worktree/NotesAndLogsPane.tsx` | Notes/Logs/Agentサブタブコンテナ（Issue #368: SubTab型に'agent'追加、AgentSettingsPane描画、SUB_TABS設定配列でDRY化。**Issue #438: maxAgents propsをAgentSettingsPaneにパススルー**） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（Issue #162: handleMoveハンドラー追加、MoveDialog統合、useFileOperations呼び出し。Issue #300: handleNewFile/handleNewDirectory/handleRename/handleDelete/handleFileInputChangeの5箇所でencodeURIComponentをencodePathForUrl()に置換。Issue #368: selectedAgents stateをAPIから取得、デスクトップ/モバイルのハードコード配列を動的置換、activeCliTab sync useEffect。**Issue #391: selectedAgentsRef（useRef+インライン代入）追加、fetchWorktree内でselectedAgents配列同一値チェック（要素順序込み個別比較）、同一値時setSelectedAgentsスキップでポーリング不要発火防止**。**Issue #410: MarkdownEditorをnext/dynamicでdynamic import化（ssr: false、.then((mod) => ({ default: mod.MarkdownEditor }))パターン、bg-whiteローディングインジケーター付き）**。**Issue #411: leftPaneMemo/rightPaneMemo（useMemo方式）でinline JSXをメモ化、ポーリング起因の不要再レンダーをスキップ。leftPane依存配列27項目にfileSearch個別プロパティ展開**。**Issue #438: fileViewerPath state削除→useFileTabs()フックに移行、handleDelete/handleRenameにfileTabs.onFileDeleted()/onFileRenamed()連携追加、rightPaneMemoをFilePanelSplitラップに変更、デスクトップ版FileViewer Modal削除（モバイル版は残す）、CLIツールタブをターミナルペインヘッダーに移動（terminalHeaderMemo）、左ペイン初期幅20%/最小15%で1:2:2比率、selectedAgents型をCLIToolType[]に変更（2-4エージェント対応）、デスクトップNotesAndLogsPaneにmaxAgents={4}、DesktopHeaderのdescriptionをブランチ名右に移動**） |
| `src/hooks/useFileTabs.ts` | タブ付きファイルパネル状態管理フック（**Issue #438**: useReducerベースのタブ状態管理。FileTab/FileTabsState/FileTabsAction型定義。MAX_FILE_TABS=5（5タブ上限）。openFile()が'opened'/'activated'/'limit_reached'を返す。closeTab()/activateTab()/onFileRenamed()/onFileDeleted()メソッド。dispatch参照安定化によるuseCallbackメモ化対応。localStorage永続化（STORAGE_KEY_PREFIX='commandmate:file-tabs:'、PersistedTabData型、readPersistedTabs()/writePersistedTabs()、worktreeId変更時のlastWorktreeIdRef+restoredRefリセット、stateRefパターンでopenFile依存配列[]化）） |
| `src/components/worktree/FilePanelSplit.tsx` | ターミナル+ファイルパネル水平分割コンポーネント（**Issue #438**: tabs.length=0時はTerminalのみ（フル幅）、tabs.length>0時はPaneResizerで水平分割（初期50%、最小20%、最大80%）。React.memo()ラップ） |
| `src/components/worktree/FilePanelTabs.tsx` | ファイルタブバーUIコンポーネント（**Issue #438**: タブバー上部固定、アクティブタブborder-cyan-500ハイライト、lucide-react XアイコンでcloseButton、アクティブタブに対応するFilePanelContentを表示。React.memo()ラップ） |
| `src/components/worktree/FilePanelContent.tsx` | ファイルコンテンツ表示コンポーネント（**Issue #438**: useEffectでファイルコンテンツをフェッチ（tab.content===null&&!tab.loading&&!tab.error時）。onLoadContent/onLoadError/onSetLoadingコールバックprops。コンテンツ分岐: ロード中/エラー/MARP iframeプレビュー（XSS対策: sandbox=""完全サンドボックス）/.mdプレビュー+編集ボタン/画像/動画/テキスト（hljs.highlight()言語ヒント付き+fallback）。FileToolbar: パスコピー/コンテンツコピー/フルスクリーン、setTimeoutクリーンアップ付き。React.memo()ラップ） |
| `src/app/api/worktrees/[id]/marp-render/route.ts` | MARPスライドサーバーサイドレンダリングAPIエンドポイント（**Issue #438**: POST /api/worktrees/[id]/marp-render、リクエスト: { markdownContent: string }、MAX_MARP_CONTENT_LENGTH=1MB DoS防御、worktree存在確認、@marp-team/marp-coreでHTMLスライド配列生成、レスポンス: { slides: string[] }、固定文字列エラーレスポンス） |
| `src/components/worktree/MarkdownEditor.tsx` | マークダウンエディタコンポーネント（**Issue #389: auto-saveモード追加** - auto-save ON/OFFトグル（data-testid="auto-save-toggle"）、useAutoSave統合（debounceMs=3000ms）、saveToApi（純粋API呼び出し、saveFnパラメータを使用）とsaveContent（isDirtyガード付き手動保存）の責務分離、保存状態インジケーター（data-testid="auto-save-indicator"）、auto-save ON時Save非表示、beforeunload条件拡張（isDirty OR isAutoSaving）、Ctrl+S分岐（auto-save ON時はsaveNow()+onSave()）、handleClose async化（saveNow()+autoSaveError確認ダイアログ）、エラーフォールバック（auto-save OFF切り替え+Toast）。**Issue #410: WorktreeDetailRefactored.tsxからnext/dynamicでdynamic importされる（ssr: false）、rehype-highlight/highlight.js CSSを含む全チャンクがコードスプリットされる**。**Issue #411: React.memo()ラップ（条件付き描画のため効果限定的）**） |
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
| `src/components/common/ThemeToggle.tsx` | ダーク/ライトテーマ切替トグルコンポーネント（Issue #424: `'use client'`、`useTheme()`でtheme/setTheme取得、mounted stateでSSR hydration対策、Sun/Moonアイコン切替（lucide-react）、Sidebar下部LocaleSwitcherの隣に配置、`focus:ring-cyan-500`） |
| `src/components/common/NotificationDot.tsx` | 通知ドットバッジ共通コンポーネント（Issue #278: DRY原則準拠、w-2 h-2 rounded-full bg-blue-500、Desktop/Mobile通知インジケーター統一） |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング（getDateFnsLocale()、enUS/jaサポート） |
| `src/config/github-links.ts` | GitHub URL定数の一元管理（Issue #264: GITHUB_REPO_BASE_URL派生、DRY原則対応、SSRF防止のためGITHUB_API_URLは除外） |
| `src/components/worktree/FeedbackSection.tsx` | フィードバックリンクセクション（Issue #264: Bug Report/Feature Request/Question/View Issues、noopener noreferrer、i18n対応） |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力コンポーネント（Issue #288: isFreeInputModeフラグ追加、フリー入力モード中のセレクター再表示防止、モバイルボタンガード、経路分析コメント。**Issue #411: React.memo()ラップ + 9ハンドラuseCallback化（handleCompositionStart/End[]、handleCommandSelect/Cancel[]、handleFreeInput[]、handleMessageChange[isFreeInputMode]、submitMessage[isComposing,message,sending,worktreeId,cliToolId,onMessageSent]、handleSubmit[submitMessage]、handleKeyDown[showCommandSelector,isFreeInputMode,isComposing,isMobile,submitMessage,handleCommandCancel]）**。**Issue #438: 下書きメッセージlocalStorage永続化** - DRAFT_STORAGE_KEY_PREFIX='commandmate:draft-message:'、worktreeId切替時に復元、500msデバウンス保存、送信成功時にremoveItem、draftSaveTimerRefでクリーンアップ） |
| `tests/helpers/message-input-test-utils.ts` | MessageInputテスト共通ヘルパー（Issue #288: モック定数、props factory、DOM queries、interaction helpers、DRY原則対応） |
| `src/lib/slash-commands.ts` | スラッシュコマンドローダー（Issue #343: loadSkills()追加、safeParseFrontmatter()でgray-matter RCE対策[S001]、deduplicateByName()でcommand優先重複排除[D001]、skillsCacheをcommandsCacheと独立管理[D011]、MAX_SKILLS_COUNT=100/MAX_SKILL_FILE_SIZE_BYTES=64KB DoS防御[S002]、getSlashCommandGroups()でskills統合） |
| `src/types/slash-commands.ts` | スラッシュコマンド型定義（Issue #343: SlashCommandCategoryに'skill'追加、SlashCommandSourceに'skill'追加、CATEGORY_LABELSにskill:'Skills'追加） |
| `src/lib/command-merger.ts` | コマンドマージロジック（Issue #343: CATEGORY_ORDERに'skill'をworkflowとstandard-sessionの間に追加） |

---

## CLIモジュール（Issue #96, #136）

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

---

## テストヘルパー（Issue #256）

| モジュール | 説明 |
|-----------|------|
| `tests/helpers/prompt-type-guards.ts` | プロンプト型ガード関数（isMultipleChoicePrompt、isYesNoPrompt）共有化（DRY原則対応） |
