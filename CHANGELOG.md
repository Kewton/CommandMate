# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-07-05

> **Highlight**: worktree（ブランチ）単位の **ToDo リスト**を新設（PC=アクティビティバー / スマホ=Tools、PC/スマホ共通 `TodoPane`、`worktree_todos` テーブル + migration v37、#1015）。あわせて Codex の**ページャ/選択リスト状態で選択ウィンドウ（NavigationButtons）が表示されない不具合**を修正し、ページャキー（PgUp/PgDn/Home/End/q）と検出非依存の脱出ハッチ `TerminalEscapeHatch`（Esc/q）を追加（#1017）、**History パネルのヘッダー（Message History）を固定**してスクロールをヘッダーの下に限定した（#1019）。

### Added
- feat(worktree): worktree（ブランチ）単位の **ToDo リスト**を追加。PC 版はアクティビティバー、スマホ版は Tools（NotesAndLogsPane）から利用でき、PC/スマホ共通の `TodoPane` を共有。`worktree_todos` テーブル（migration v37、`worktree_id` FK・ON DELETE CASCADE）＋ `worktree-todo-db`（CRUD）、`/api/worktrees/[id]/todos`（GET/POST・PATCH/DELETE）、クライアント `todo-api`、i18n `todoTab`（en/ja パリティ）を追加。既存のリポジトリ単位 ToDo（`repository_todos`）とは独立して併存 (Issue #1015)

### Fixed
- fix(terminal): Codex が**ページャ/edit-previous モード**のとき選択ウィンドウ（NavigationButtons）が表示されず、読み取り専用ターミナルから操作・脱出できない問題を修正（複数インスタンス codex-2/codex-3 で顕在化）。`CODEX_PAGER_FOOTER_PATTERN` とステータスバー非依存のページャ検出分岐（`STATUS_REASON.CODEX_PAGER`、`/model` 等の "press enter to confirm/select" には非マッチでリグレッションなし）を追加し、NavigationButtons にページャキー（PgUp/PgDn/Home/End/q・PC分割＋モバイル）、共有 `useSpecialKeys` フックと検出非依存の脱出ハッチ `TerminalEscapeHatch`（Esc/q、未分類 interactive 状態のみ表示）を新設 (Issue #1017)
- fix(history): History パネルの「Message History」ヘッダーがスクロールコンテナ内で `sticky` だったため、メッセージがヘッダーの背後を通過する違和感を修正。固定ヘッダー行 ＋ 独立スクロール領域のレイアウトに変更（ヘッダー/検索バーを `flex-shrink-0`、メッセージを内側 `overflow-y-auto` へ、`scrollContainerRef` を内側 div へ移設、未使用の `STICKY_HEADER_HEIGHT` を撤去）。PC（`TerminalSplitPaneContent`）/モバイル（`WorktreeDetailMobile`）共用のため両方で検証 (Issue #1019)

## [0.8.0] - 2026-07-03

> **Highlight**: 新エージェント **Antigravity（agy）CLI 対応**が中心。inline TUI として `agy` を選択可能なエージェントに登録（Phase A #988）し、Auto-Yes（`--dangerously-skip-permissions`）／`--model` 起動フラグ（Phase B #989）、Assistant Chat・Schedule・日次レポート等すべての非インタラクティブ実行経路（`agy -p`、Phase C #990）まで一貫対応した。あわせて選択 TUI／権限承認メニューのステータス検出と Auto-Yes 応答の不具合を修正（#995 / #997 / #999）。CLI 側では **1 エージェント複数セッションの管理**（`instances` サブコマンド＋`send --instance --register`、#1000）、`ls --branch` を実ブランチ名で絞り込む修正（#1003）と `ls --id <prefix>` フィルタ（#1005）を追加。UI では **PC 版マークダウンビューワーおよび worktree 詳細インラインプレビューにサイド TOC（目次）** を追加した（#1007 / #1009）。

### Added
- feat(agent): 新エージェント **Antigravity（agy, v1.0.14）CLI を選択可能なエージェントとして登録**（Phase A / MVP）。`agy` は scrollback を保持する inline TUI（Codex 型、alternate-screen アプリではない）のため inline セッションモデルを再利用: `agy` 起動、初回の "Do you trust the contents of this project?" ダイアログを Enter で自動確定、"? for shortcuts" idle フッター検出後に送信、sendMessage/killSession で capture キャッシュを無効化。`CLI_TOOL_IDS` に `antigravity` と表示名 `Antigravity` を追加し `AntigravityTool` を登録、`ANTIGRAVITY_*` 検出パターンと inline ステータスブロックを追加（running はステータスバーの "esc to cancel" / "Generating" / braille スピナーで検出し常時表示の素の "> " 入力欄より優先、idle "> " は ready）。検出パターンは実 `agy` バイナリで確認済み (Issue #988)
- feat(agent): Antigravity（agy）に **Auto-Yes（`--dangerously-skip-permissions`）と `--model` サポート**を追加し他エージェントと機能同等に（Phase B）。`agy` はセッション内 `/model` コマンドを持たないため `--model` は起動フラグとして実装、モデル名に空白/括弧を含むため Copilot と別の専用検証パターン（新規 `antigravity-constants.ts` + `validateAntigravityModelName`）を導入。CMATE.md Schedule 機能の権限ハンドリング（schedule-config/cmate-parser/cmate-validator）、send.ts / send API の `--model` 受理（起動済みセッションのモデル変更は拒否）、`MAX_SELECTED_AGENTS` を 5→6 に拡大し `DEFAULT_SELECTED_AGENTS` に antigravity を追加、send/respond/capture/auto-yes の CLI ヘルプ更新を含む (Issue #989)
- feat(agent): Antigravity（`agy -p`）を **claude/codex と同様にすべての非インタラクティブ実行経路へ統合**（Phase C）。Assistant Chat（`ASSISTANT_ALLOWED_TOOLS` / `NON_INTERACTIVE_TOOLS` に追加、`non-interactive-runner` の `-p --dangerously-skip-permissions`＋prompt を stdin、`parseAntigravityPlainOutput` で agy -p のクリーンなプレーンテキストを ANSI 除去+trim）、Schedule / 日次レポート（`claude-executor` / `report.ts` の `ALLOWED_TOOLS` / `review-config` の `SUMMARY_ALLOWED_TOOLS`）、標準コマンド・ログ表示（`standard-commands` / logs route / `LogViewer` のフィルタ）に antigravity を追加 (Issue #990)
- feat(cli): **1 エージェント複数セッションの CLI 管理・ドキュメント整備**。`commandmate instances` サブコマンドで roster + 稼働状況を一覧・add/remove/alias/kill 操作可能にし、`send --instance <id> --register` でアドホックセッションを roster に自動登録。`ApiClient` に PATCH サポートを追加し `agentInstances` を型定義（`ls --json` 含む）、埋め込み docs/user-guide にマルチセッション節と `--instance` の ID 規約例を追記 (Issue #1000)
- feat(cli): 同一ブランチ名（develop 等）が複数リポジトリに存在する環境向けに **`ls --id <prefix>` で worktree ID の前方一致フィルタ**を追加。既存の `--branch` フィルタと独立した AND 条件として適用でき、特定リポジトリの worktree を一意に絞り込める (Issue #1005)
- feat(ui): 独立ファイルビューワーページ（`/worktrees/[id]/files/[...path]`）のマークダウン表示に **PC 幅限定のサイド TOC（目次）** を追加。`rehype-slug@^6` / `github-slugger@^2` を導入して見出しに id を付与し、純粋関数 `extractToc`（`src/lib/markdown-toc.ts`、ATX 見出しを抽出し rehype-slug と完全一致する id を生成、コードブロック除外・重複 suffix 対応、setext 非対応）と `MarkdownToc` コンポーネント（depth インデント・クリックでスムーズスクロール・IntersectionObserver によるスクロールスパイ）を新設。sticky サイドバー / 見出しへの scroll-margin-top / トグルボタン（`aria-pressed`、lg 未満は非表示）/ localStorage 永続化（`commandmate:md-toc-visible`）/ 見出し 0〜1 件は自動非表示、i18n `worktree.toc.*`（en/ja パリティ）を追加 (Issue #1007)
- feat(ui): **worktree 詳細ページのインライン Markdown プレビューにもサイド TOC** を追加。`MarkdownPreview` が `rehype-slug` を `rehype-sanitize` 後段で適用して見出しにプレーンな id を付与、`MarkdownToc` に `root` prop を追加してプレビューペイン内のスクロールコンテナ基準でスクロールスパイ、`MarkdownEditor` のプレビューペインに `ResizeObserver` でコンテナ幅を判定する TOC サイドバー＋トグルを追加。表示状態は #1007 と同じ localStorage キー（`commandmate:md-toc-visible`）で共有 (Issue #1009)

### Fixed
- fix(detection): agy の "Switch Model" 等の**選択 TUI が running/thinking と誤検出され NavigationButtons が表示されず ↑↓/Enter でのモデル選択が不能**だった問題を修正。選択画面の "esc to cancel" フッターを `ANTIGRAVITY_THINKING_PATTERN` が拾っていたため、`ANTIGRAVITY_SELECTION_LIST_PATTERN`（Switch Model ヘッダ / ↑↓ Navigate + enter Select）と `STATUS_REASON.ANTIGRAVITY_SELECTION_LIST` を追加し、status-detector で汎用 thinking 検出より前の優先度 0.9 で `waiting` を返す（Copilot 0 / Codex 0.8 と同様の early-detection 順序） (Issue #995)
- fix(detection): agy の**権限承認メニュー（"Do you want to proceed?"）を選択 TUI として検出できるよう `ANTIGRAVITY_SELECTION_LIST_PATTERN` を緩和**。権限メニューのフッターは "↑/↓ Navigate · tab Amend · …"（"enter Select" なし）で #995 のパターンが取りこぼしていたため、"↑/↓ Navigate" フッター単独で成立するよう変更（`.*enter Select` 除去で ReDoS 的にもより安全化）。Switch Model・権限承認メニュー・将来の agy 選択 TUI を `cliToolId === 'antigravity'` ガードで agy 限定のまま網羅 (Issue #997)
- fix(auto-yes): **Auto-Yes が agy の権限承認メニュー（"Do you want to proceed?"）に応答しない**問題（poller は動くが送信ゼロ）を修正。①検出: `buildDetectPromptOptions('antigravity')` が `requireDefaultIndicator=true` で undefined を返し Pass 1 gate がメニューを弾いていた（agy は既定を ASCII ">" で強調、フッターに "press enter to confirm" なし）ため `{ requireDefaultIndicator: false }` を返し（claude/opencode/copilot と同様）Pass 2 で選択肢を収集。②送信: `sendPromptAnswer` のカーソルキー操作が `cliToolId === 'claude'` に限定されていたため antigravity へ拡張（agy は矢印キー TUI で番号入力を無視、"Yes"=option 1 → offset 0 → 素の Enter で確定） (Issue #999)
- fix(cli): **`ls --branch` を実ブランチ名で絞り込む**よう修正（方針 A）。`worktrees` テーブルに `branch` カラムを追加（v36 マイグレーション、`CURRENT_SCHEMA_VERSION` 35→36）し sync 時に実ブランチ名を保存・API/型で伝播、`ls --branch` フィルタを `name` 直接参照から `(wt.branch ?? wt.name)` の前方一致へ変更（後方互換）。`Worktree` / `WorktreeItem` 型に `branch?` を追加、書込み（`scanWorktrees` / `upsertWorktree`、ON CONFLICT は COALESCE で非 sync writer の上書きを防止）・読み取り（`getWorktrees` / `getWorktreeById` の SELECT・マッピング）両パスに配線 (Issue #1003)
- fix(ui): worktree 詳細ページの**インライン Markdown プレビューで TOC が常に自動非表示になる**問題を修正。詳細ページの既定レイアウトではプレビューペインが約 551px 幅となり従来の TOC 表示しきい値 640px を下回っていたため、`TOC_SIDEBAR_MIN_WIDTH_PX` を 640→480 に下げ、TOC サイドバー幅を `w-56`(224px)→`w-48`(192px) に縮小して本文の可読幅を確保（全画面化せずとも目次を表示可能に） (Issue #1009)

## [0.7.5] - 2026-06-30

> **Highlight**: worktree 詳細画面の UI 改善が中心。Files ツリーにメタデータ列（size / created / modified）のトグル表示を追加（#969）し、ファイル行のメタデータと名前のツールチップを単一バブルに統合（#975）。マークダウンファイルプレビューのコードブロックにコピーボタンを追加（#981、inline code への誤付与を #983 で修正）。あわせて PaneResizer の仕切りを VS Code 風の控えめな 1px 細線化（#970）、PC ターミナルヘッダーのアクションバーボタンを左寄せ + 順序統一（#977）、サイドバーの横スクロールバーを truncate + hover ツールチップで除去（#971）し、狭幅時にヘッダーボタンを折り返して ActivityBar との重なりを解消（#976）した。

### Added
- feat(files): Files ツリーの各行に常時インライン表示されていた **size / created（birthtime）/ modified（mtime）のメタデータ列を個別にトグル表示**できるよう変更（既定は VS Code 流に size のみインライン、タイムスタンプは hover）。`readDirectory` が `mtime` を返すよう拡張し `TreeItem` に `mtime?` を追加（`ctime` は意図的に非採用）、新規 `useFileMetadataDisplay`（localStorage + CustomEvent でタブ間同期）、ツールバーに 3 チェックボックスのギアポップオーバー `FileMetadataToggle`、`TreeNode` が列を条件描画しつつ `formatMessageTimestamp` / `formatFileSize` でロケール対応の複数行 title ツールチップを構築。i18n `worktree.fileTree.metadata`（en/ja パリティ）を追加 (Issue #969)
- feat(markdown): マークダウンファイルプレビュー（PC / mobile 両レンダーパス）の **非 mermaid コードブロックにコピーボタンを追加**。`CopyButton` を `src/components/common/CopyButton.tsx` へ抽出して `AssistantMessageList`（挙動不変）と新規ラッパで共有、`CodeBlockWithCopy` が code/pre を relative group で包んで `CopyButton` をオーバーレイし `rehype-highlight` の React ツリーから再帰的にプレーンテキストを抽出してコピー。md+ では hover 表示・タッチ幅では常時表示、React レンダラ経由で付与し `rehype-sanitize` に落とされないようにした（mermaid 図 / inline code は不変） (Issue #981)

### Changed
- feat(ui): worktree 詳細画面の 4 つのドラッグ可能な仕切り（`PaneResizer`）を**太く濃い線から VS Code 風の控えめな 1px 細線**に変更。線色を `bg-gray-700` から `bg-gray-200 dark:bg-gray-700`（固定パネル枠線と同色）へ、hover 時の線幅拡大（`hover:w-2` / `hover:h-2`）を撤去して常時 1px を維持し hover/focus 時のみ accent 色（cyan-500）を表示。`darkMode: 'class'` で base の `dark:bg-gray-700` が specificity で勝つため `dark:hover:bg-cyan-500` とドラッグ時の `dark:bg-cyan-500` を明示、透明な `::before` 疑似要素でクリック判定を ±4px に拡張（見た目 1px でも掴みやすさ維持）、focus ring offset をテーマ対応化、ドラッグ中のみ線幅拡大 + accent をライブフィードバックとして維持 (Issue #970)
- feat(files): ファイル行の**2 つの独立ツールチップ（#969 のメタデータ native `title` と #859 の名前 `TruncationTooltip`）を単一のスタイル付きバブルに統合**。従来は遅延（native 約 0.5〜1s vs custom 200ms）とスタイルが異なっていた。`TruncationTooltip` に optional `metadata` prop を追加し「名前が省略表示 OR メタデータあり」のとき hover で名前 + メタデータ（複数行）を 1 つの portal バブルに描画、`TreeNode` は native `title` を撤去して整形済み size/created/modified を `metadata` で渡す（インライン列のトグル状態に関わらず hover で全項目を参照可能＝#969 の意図を保持）。サイドバー利用箇所は optional/additive のため無影響 (Issue #975)
- feat(terminal): PC ターミナルヘッダーのアクションバーボタンを**左寄せ + +Split → -Split → Equal widths → History → Files の順に統一**。+Split の `ml-auto`（バーを左右グループに分割していた）を撤去し JSX を並べ替えて全ボタンを左→右に整列。PC 専用（`TerminalSplitContainer` は `WorktreeDetailDesktop` のみで描画）でモバイル経路は無影響、ボタンの挙動・有効/無効条件・aria 状態は不変。順序検証の単体テストを追加 (Issue #977)

### Fixed
- fix(sidebar): 長いリポジトリ名がグループヘッダーをはみ出して生じる**サイドバーの横スクロールバーを除去**。グループヘッダーを `min-w-0` flex コンテナ化して既存の `truncate` を効かせ、リポジトリ名を `TruncationTooltip` で包んで省略時のみ hover でフルネーム表示（`BranchListItem` と同様）、ブランチリストに `overflow-x-hidden` を safeguard として追加、DnD sortable ラッパを `w-full min-w-0` で制約してドラッグ中の overflow を防止 (Issue #971)
- fix(sidebar): サイドバーを狭めた際に**ヘッダーの見出し + アクションボタン群（ViewModeToggle / SortSelector / SyncButton / Repositories）が横方向にあふれ隣接 ActivityBar と重なる**問題を修正。ヘッダー行が `flex-nowrap` + 既定 `overflow:visible` だったため、ヘッダー行に `flex-wrap` + `gap-y-2` を付与してボタン群を入りきらない時に改行、ボタン群自体にも `flex-wrap`、Branches 見出しに `min-w-0 truncate` を付与して縮小させた（下方向に開く Sort ドロップダウンが切れるため overflow clip は不使用） (Issue #976)
- fix(markdown): react-markdown v10 が `code` コンポーネントに `inline` prop を渡さなくなったため `MermaidCodeBlock` の inline 判定が常に undefined となり、**全ての inline code に誤ってコピーボタンが付き `as="span"` のブロッククラスで単独行に押し出される**問題（#981 で混入）を修正。コピーボタンの付与を `MarkdownPreview` の `pre` レンダラ（fenced/indented コードブロックでのみ発火、inline code では決して発火しない）へ移して誤検出を構造的に不可能化、mermaid ブロックはプレーン `<pre>`（ボタンなし）で不変、ファイルビューアページの壊れた `inline` 判定もクラスベース検出へ置換。inline code はボタンなし/改行なし、fenced ブロックは言語有無を問わずボタンが機能、mermaid 図はボタンなしを固定する回帰テストを追加 (Issue #983)

## [0.7.4] - 2026-06-25

> **Highlight**: モバイル Agent タブヘッダーの操作性改善が中心。タブを横スクロール可能化（#958）したうえで横スクロールバーを非表示化（#964）、ステータスを CLI ツール単位ではなくインスタンス単位で解決（#960）、kill-session 確認ダイアログにインスタンスのエイリアスを表示（#956）。あわせて Auto-Yes をカウントダウン 0 到達の正確なタイミングで無効化（#959）し、サイドバークリック→詳細表示の体感遅延を低減する perf クイックウィン 4 件（#965）を追加した。

### Fixed
- fix(worktree): モバイルヘッダーの Agent インスタンスタブを**横スクロール可能**に。Auto Yes トグルを左、検索 + End（kill session）ボタンを右にピン留めし、中央のタブ領域を `flex-1 min-w-0 overflow-x-auto` 化。従来は 3 つ以上のエージェントでタブと End ボタンが画面外に押し出されスクロール不能だった (Issue #958)
- fix(worktree): モバイル Agent タブヘッダーの**横スクロールバーを非表示**に（スワイプ/スクロールは維持）。新規 `.scrollbar-hide` ユーティリティを追加し当該 nav にのみ適用、表示領域の圧迫を解消（`.scrollbar-thin` は他 3 箇所で使用中のため不変） (Issue #964)
- fix(worktree): モバイル Agent タブの**ステータスを CLI ツール単位ではなくインスタンス単位で解決**。エイリアスインスタンスごとに正しい稼働ステータスがサイドバー/タブに反映されるよう修正 (Issue #960)
- fix(worktree): セッションクローズ確認ダイアログ（ヘッダー「✕ End」）のタイトルが CLI ツール名（Claude/Codex）を表示していた問題を修正。新規 `getActiveInstanceLabel()` で**インスタンスのエイリアスを優先表示**（未設定/stale 時は CLI 表示名へフォールバック＝後方互換） (Issue #956)
- fix(auto-yes): カウントダウンが 00:00 に到達した**正確なタイミングで Auto-Yes を無効化**。期限判定を `>` から `>=` に変更し、UI も次のサーバーポーリングを待たず即座に OFF 反映（`onExpire` コールバック追加、呼び出し側は無改修） (Issue #959)

### Performance
- perf(worktree): **サイドバークリック→worktree 詳細表示の体感遅延を低減**するクイックウィン 4 件。①一覧キャッシュから詳細を楽観的に即描画し `getById` はバックグラウンド反映（stale-while-revalidate、キャッシュミス時のみローディング）②ステータス検出用キャプチャ行数を表示用（10000）と分離し 1000 に削減（末尾空行トリム前提で #604 退行なし）③`/api/worktrees/[id]` で git status を listSessions と並走 ④tmux キャプチャキャッシュ TTL を 3000→5000ms に延長 (Issue #965)

## [0.7.3] - 2026-06-23

> **Highlight**: Timer / メモ / サイドバー周りの UX 改善が中心。Timer と Schedule を AgentInstance システム（#869）に追従させ登録済みインスタンスを選択可能に（#942）、Timer 入力を Schedule と同様の「+ Create Timer」ボタン + モーダル化（#945）、Activity Bar の Notes に並び替えを追加（#944）、サイドバーヘッダーのアクションアイコンを拡大（#946）。あわせて codex で Timer 送信が確定しない不具合を sendMessage 委譲で修正（#947）し、自動生成物（dev-reports 等）を untrack してリポジトリを軽量化（#953）した。

### Added
- feat(timer): **Timer と Schedule で登録済みエージェントインスタンスを選択可能**に。Timer（#534）/ Schedule（#824-827）は AgentInstance システム（#869）以前の実装で、エージェントセレクタが静的な `CLI_TOOL_IDS` に束縛され Agents パネルで登録したインスタンスを指定できなかった。**Timer はフルインスタンス対応**: migration v35 で nullable な `timer_messages.instance_id` 列を追加（`cli_tool_id` ＝ primary instance anchor で backfill）、`timer-db` / timers API が instanceId を通し（登録済みインスタンス + primary anchor に対して検証）、`timer-manager` が `isRunning` / `getSessionName(worktreeId, instanceId)` で当該インスタンスの tmux セッションへ実行をルーティング。`TimerPane` はセレクタを登録済みインスタンス（alias ラベル）から駆動し選択インスタンスを記録/表示（未登録時は全 CLI ツールの primary インスタンスへフォールバックし legacy 挙動を byte-for-byte 維持）。**Schedule は UI ラベルのみ**: `ScheduleEditDialog` がインスタンス alias を列挙しつつ永続化/実行は選択インスタンスの backing CLI ツール基準（Schedule は新規 `claude -p` プロセスを起動するため per-instance ルーティングは無意味、CMATE.md スキーマ変更なし）。`instances` を `WorktreeDetailDesktop`（PC）/ `NotesAndLogsPane`（mobile）経由で `TimerPane` / `ExecutionLogPane` / `ScheduleEditDialog` へ配線 (Issue #942)
- feat(timer): Timer 入力を常時表示のインラインフォームから **「+ Create Timer」空状態 CTA / 「+ New Timer」ボタン + モーダルダイアログ**化（PC=Modal、mobile=FullScreenModal）し Schedule UX に揃えた。`formatDelayLabel` を `timers/timer-format.ts` へ抽出しペインとダイアログで共有。一覧/ポーリング/キャンセル/履歴クリア/さらに読み込みは維持し public props も不変のため呼び出し側（`WorktreeDetailDesktop` / `NotesAndLogsPane`）は無改修 (Issue #945)
- feat(memo): **Activity Bar の Notes（メモ）に ↑↓ 並び替えボタンを追加**。`PATCH /api/worktrees/[id]/memos` が position の再採番を検証付きで実行（新規 `src/lib/memo-reorder-validator.ts` が件数/重複/未知 ID を pure に検証）、`memoApi.reorder()` クライアントメソッド、`MemoCard` の ↑↓ 移動ボタン（両端で disabled、後方互換 props）、`MemoPane` の `handleMove`（楽観更新 + ロールバック、検索中は無効化）、i18n `memoMoveUp` / `memoMoveDown`（en/ja）を追加 (Issue #944)
- feat(sidebar): サイドバーヘッダー上段の **アクションアイコン（view-mode toggle / sort / sort-direction / sync / Repositories リンク）を視認性向上のため 12px → 16px に拡大**。共有 `HEADER_ICON_CLASS`（`w-4 h-4`）を導入し 5 つのアイコンへ適用。`SortSelectorBase` に optional `iconClassName` prop（既定 `w-3 h-3`）を追加し Sessions ページなど他の利用箇所は従来サイズを維持 (Issue #946)

### Fixed
- fix(timer): Timer 発火時に **メッセージが入力欄に残ったまま送信されない**不具合（特に codex）を修正。発火処理が tmux に直接 `sendKeys(text+Enter 一括)` を投入していたため、codex の TUI がテキスト確定前に Enter を受け取っていた。恒久対策として `executeTimer` の送信を `cliTool.sendMessage(worktreeId, message, instanceId)` に委譲し、手動送信と完全に同じコードパス（CLI ツールごとのテキスト/Enter 分離・待機）を通して claude / codex / gemini すべてで Enter 確定を保証。セッション名は `sendMessage` 内で `(worktreeId, instanceId)` から解決されるため `timer-manager` 側の `getSessionName` / 直 `sendKeys` 呼び出しを削除 (Issue #947)

### Chore
- chore(repo): リポジトリ肥大化（追跡 8,481 ファイル中 7,136＝84% が `dev-reports/` の AI エージェント自動生成ログ）とローカル絶対パスのリークに対応。`git rm -r --cached` で **`dev-reports` / `workspace` / `.playwright-mcp` を追跡解除**（計 7,169 件、ローカル実ファイルは保持）、`.gitignore` に `/dev-reports/` を追加（既存の `/workspace/` `.playwright-mcp/` ルールは追跡済みで空振りしていたため追跡解除で実効化）、`tests/unit/prompt-detector.test.ts` のテストフィクスチャ内の絶対パスを汎用化（`/Users/maenokota` → `/Users/example`、検証ロジックは不変）。履歴の書き換えは行わず既存クローン/fork に無影響 (Issue #953)

## [0.7.2] - 2026-06-21

> **Highlight**: PC 版に表示サイズ切替（大/中/小/極小、既定=中）を追加（#915/#919）。本リリースは大きな機能追加よりも、God モジュール／God コンポーネント／God フックを per-concern に分解する**内部リファクタ**（#920-#923）と、旧リポジトリ名・環境変数表記・リンク・i18n パリティを揃える**ドキュメント整備**（#924-#929）が中心。いずれも振る舞い不変で、既存テストをセーフティネットに据えている。

### Added
- feat(display): PC 専用の**表示サイズ切替（大/中/小/極小、既定=中）**を rem カスケード（案A）で実装。`usePcDisplaySize`（localStorage `mcbd-pc-display-size`・検証付き永続化、サイズ係数表／ターミナル fontSize／root font-size のメタ定義）と `PcDisplaySizeContext`/Provider（単一の真実源、PC（`!isMobile`）時のみ `<html data-pc-size>` を付与し rem カスケード適用、モバイル/アンマウント時は除去）を新設。`globals.css` で `html[data-pc-size=...]` を 18/16/14/12.5px に切替、Header に表示サイズドロップダウンを追加、`AppShell` のサイドバー幅 MIN/MAX/表示幅をサイズ係数で連動（clamp 維持・往復で非破壊）、`Terminal` の `fontSize` を prop 化し変更時は `term.options.fontSize` 更新＋`fit()` で再接続なし再フィット。モバイル（<768px）は非適用 (Issue #915)

### Fixed
- fix(display): #915 で追加した表示サイズセレクタが **worktree 詳細ページ（`/worktrees/[id]`）で表示されない**問題（#917、`useLayoutConfig showGlobalNav:false` がグローバル Header を抑止）を、`DesktopHeader` トップバーにセレクタを surface して修正（PC 専用・モバイルは null）。あわせてセレクタのラベル（大/中/小/極小）と aria-label が**ハードコード日本語でロケール非追従**だった問題（#918）を、文言を i18n 辞書（`common.displaySize.*`）へ移し `useTranslations` 経由で消費するよう修正（英語では Large/Medium/Small/Extra small を表示、未使用化した `PC_DISPLAY_SIZE_META.label` を撤去して i18n を単一の真実源に統一）。回帰テストを追加 (Issue #919)

### Changed
- refactor(git): 2327 行・37 export の `src/lib/git/git-utils.ts` God モジュールを **per-concern モジュールに分割**（git-errors / git-exec / git-default-branch / git-status / git-log / git-diff / git-commit / git-branches / git-stash / git-reset / git-remote、循環依存なし）。`git-utils.ts` は後方互換の re-export barrel として残置し barrel 経由の全 caller を不変に保つ。public API / export signature は不変（振る舞い不変）、203 ケースのテストを 11 ファイルへ verbatim 分割 (Issue #921)
- refactor(worktree): 約 3.1k 行の `GitPane.tsx` God コンポーネントを、focused custom hooks（ロジック）と memo 化した panel コンポーネント（プレゼンテーション）を共有レイアウトで束ねる薄い coordinator へ**分解**。副作用を `useGitStatus`/`useCommitHistory`/`useChanges`/`useBranches`/`useStash`/`useDangerZone` に抽出（既存 `useGitPaneNetworkOps`/`useGitPaneTabState` に合流、refetch カスケードは callback 注入で疎結合）、プレゼンテーションを `git/panels/*` + `gitPaneShared` へ、レスポンシブ（mobile-tabs / desktop-grouping）を `GitPaneLayout` へ移設、ambient config を `GitPaneContext` で供給し prop-drilling を排除。external props / data-testid / 振る舞いは不変、112 件の既存テストをセーフティネットに据え新フック・context/layout の focused test を追加 (Issue #922)
- refactor(worktree): `useWorktreeDetailController` God フックの低リスク・無結合な 3 関心事を独立サブフックへ**抽出**（純構造リファクタ・振る舞い不変）: `useHistoryFilters`（historySubTab / showArchived / historyUserOnly / historyDisplayLimit + localStorage 同期）、`useDiffViewerState`（diffContent / diffFilePath + open/close、mobile は no-op）、`useVisibilityRecovery`（visibilitychange リスナ + スロットル復帰処理）。`fetchMessages` 結合用の ref ミラーは polling 関心として controller に残置。本体は 1671→1514 行に縮小、focused unit test 18 ケースを追加 (Issue #923)
- refactor(worktree): レンダーパスを持たない dead-code の **`WorktreeDetailHeader` コンポーネントを削除**（PC worktree 詳細トップバーの実体は `WorktreeDetailSubComponents.tsx` の `DesktopHeader`、参照は自身の unit test のみの test-backed dead code）。`WorktreeDetailHeader.tsx` とそのテストを削除し repo 全体で残参照ゼロを確認（barrel は未 export）、振る舞い不変 (Issue #920)

### Docs
- docs: 旧リポジトリ名 `Kewton/MyCodeBranchDesk` を `Kewton/CommandMate` に統一修正 (Issue #924)
- docs(architecture): 環境変数表記を `MCBD_` から `CM_` に統一 (Issue #925)
- docs: implementation-history の **design-policy リンク切れを修正** (Issue #926)
- docs: CLI ガイドに **report コマンドおよび start/stop/status フラグを追記** (Issue #927)
- docs: **CLAUDE.md の tree と module-reference.md を現状の `src/` に同期** (Issue #928)
- docs(i18n): `docs/` ↔ `docs/en/` の**英訳パリティ**を達成（英訳を追加） (Issue #929)

## [0.7.1] - 2026-06-20

> **Highlight**: リポジトリ別の軽量 ToDo 機能（#894）。Home に対象リポジトリを選択して書けるチェックボックス形式の ToDo / 備忘録ウィジェットを追加。さらに全リポジトリ横断表示（#908）・モバイルレイアウト最適化（#909）・リポジトリ名表示（#903）・即時反映の担保（#911）まで一連で拡張した。あわせてエイリアスインスタンス周りの Auto-Yes / terminal-split / codex 起動の修正を取り込んでいる。

### Added
- feat(home): Home に対象リポジトリを選択して書けるチェックボックス形式の**軽量 ToDo / 備忘録ウィジェット**を追加。新規 `repository_todos` テーブル（migration v34、FK→`repositories` ON DELETE CASCADE）と API（`/api/repositories/[id]/todos` GET/POST、`/[todoId]` PATCH/DELETE）、`todo-db`（CRUD）/ `todo-api`（client）/ `todo-config`（上限定数）を新設。`TodoWidget` はリポジトリ選択を localStorage に永続化し、完了トグルを楽観更新で反映。`page.tsx` に ToDo セクションを追加 (Issue #894)
- feat(todo): ホーム ToDo ウィジェットの一覧を選択リポジトリでフィルタせず**全リポジトリ横断**で表示するよう変更（#907 案A、登録時のリポジトリ選択は維持）。`getAllTodos(db)`（`TODO_SELECT` の WHERE 無し版、リポジトリ名→position→created_at→id の安定順）と新規 API `GET /api/todos`（`{ todos }` 形式）、`todoApi.listAll()` を追加。`TodoWidget` は一覧取得を `listAll()` に変更しドロップダウン変更で再フィルタせず（ドロップダウンは追加先選択専用）、toggle/delete を `selectedRepoId` → `todo.repositoryId` に変更して横断操作での 404 を回避 (Issue #908)
- feat(todo): ホーム ToDo ウィジェットを**モバイル向けに最適化**。リスト行を 2 段組化（<sm は checkbox+content / badge+delete の 2 段、>=sm は従来の 1 行を維持）、削除ボタンの hover 依存を解消（モバイルは常時表示、デスクトップのみ hover-reveal を維持）、チェックボックス／削除ボタンに min-h/min-w 44px のタップ領域を確保（>=sm はコンパクトに復帰）、セレクタ行を `flex-col sm:flex-row` でレスポンシブ化（狭幅は縦積み、select は全幅・>=sm で `max-w-[16rem]`）。機能ロジック（listAll/create/update/remove、#907 の横断表示）は不変 (Issue #909)

### Fixed
- fix(todo): ホーム ToDo ウィジェットが参照する `/api/todos` がビルド時に静的プリレンダリングされ、ToDo の追加/done 切替/削除がリロードするまで一覧へ反映されない問題を修正。`/api/worktrees` と同じ idiom で `export const dynamic = 'force-dynamic';` を追加しリクエスト毎にライブ DB を読むよう変更（build 後 `/api/todos` が `○`(Static) ではなく `ƒ`(Dynamic) になることを確認）。force-dynamic を保証する回帰テストを追加 (Issue #911)
- fix(todo): リポジトリ別 ToDo（#894）で各項目に**リポジトリ名が表示されない**問題（#900、名前解決の経路が UI/API/DB のどの層にも未実装）を修正。採用案（案2）はデータ境界での名前解決で、テーブルは正規化を維持（`repository_id` のみ保持）し read 時に `repositories` を JOIN。`getTodosByRepositoryId` / `getTodoById` のクエリに JOIN を追加し `repositoryName` / `repositoryDisplayName` を解決（`createTodo` は INSERT 後に再取得し GET と POST のレスポンスを一致）、`TodoItem` 型に両フィールドを追加、`TodoWidget` が各項目にリポジトリ名バッジを表示。リポジトリリネームにも追従 (Issue #903)
- fix(auto-yes): 複数の同一エージェントインスタンス（例 `claude` + `claude-2`）を 1 ブランチで起動した際、**Auto-Yes がプライマリインスタンスでしか効かない**問題を修正。state と poller が `worktreeId:cliToolId` のみでキー付けされ、poller の capture/`getSessionName` が instanceId を渡していなかったため常にプライマリの tmux セッションを解決していた。instanceId を composite key・state・poller・auto-yes/current-output API ルート・`worktree-status-helper`・CLI(send/auto-yes)・フロントエンド（controller/desktop pane）に通し、各インスタンスが独立した Auto-Yes state と poller を持つよう変更。キーはプライマリで 2-part（後方互換）、エイリアスで 3-part `worktreeId:cliToolId:instanceId` になる (Issue #896)
- fix(auto-yes): サイドバーからの worktree 遷移→復帰時に **Auto-Yes 表示がリセット**（特に alias instance が OFF 固定）する問題を、案1（根本）＋案2（過渡汚染遮断）の併用で修正。案1: worktreeId 変更時 or rosterReady 成立時に既存の `GET /api/worktrees/[id]/auto-yes`（cliToolId なし）を 1 回呼び、返る instances マップを `autoYesStateMap` 全体へ反映（primary も alias も一括復元、従来の current-output ポーリングは primary しか再シードしなかった）。案2: worktreeId 変更リセット effect で `autoYesStateMap` を破棄し旧 worktree の同名キー汚染を遮断。最新リクエストガード（`latestAutoYesRequestIdRef`）で高速な A→B→A 遷移でも古いレスポンスが新 map を汚染しないようにした (Issue #902)
- fix(terminal-split): split で同一 cliTool の複数 instance（例 claude / claude-2）が稼働中のとき、片方の Stop（interrupt）が**もう片方の split にも Escape を送ってしまう**問題を修正。原因は `InterruptButton` が body に instanceId を含めず POST し、API がブロードキャスト分岐に落ちて同一 cliTool の全 alias instance を宛先に追加していたこと（send / special-keys / prompt-response は instanceId を伝播済みで interrupt だけ漏れ）。`InterruptButton` に instanceId prop を追加し `instanceId !== cliToolId` のとき `{ cliToolId, instanceId }` を送信（primary は `{ cliToolId }` のみで完全後方互換、CLI のツール全体停止ブロードキャストも維持） (Issue #901)
- fix(terminal-split): split 復帰時に **2 個目以降のターミナル選択がドロップダウン先頭にリセット**される不具合（#898）を修正。根本原因は、実 roster（claude-2 等のエイリアスを含む）が API から届く前の過渡 roster に対し `useTerminalSplits` の reconcile が走り、永続化済みの claude-2 を evict して未使用 primary で補填していたこと。案A として実 roster 確定までは reconcile を抑止：`useWorktreeDetailController` に `rosterWorktreeId` を追加し fetchWorktree が実 roster を反映した時点で worktreeId をタグ付け、`rosterReady = (rosterWorktreeId === worktreeId)` を派生。`useTerminalSplits` は `rosterReady=false` の間 reconcile を抑止し永続化設定を保持、false→true で一度のみ reconcile。worktree 切替直後の永続化汚染も effect ガードで解消 (Issue #899)
- fix(file-tree): Files 表示中に**展開済みサブディレクトリ内に作成されたファイルが自動反映されない**問題を修正。対策A（監視範囲の是正）として、ツリー変更検知を `useWorktreeDetailController` から `FileTreeView` 内へ移設し、ルートに加え展開中の全サブディレクトリをディレクトリ単位の合成シグネチャ（path→items ハッシュの Map）で検知（検知範囲が `reloadTreeWithExpandedDirs()` の再描画範囲と一致）。両スナップショット共通ディレクトリの内容変化のみを変化と判定し新規展開/折り畳みでは誤再読込しない。有効化は `pollingEnabled` prop（PC: activeActivity==='files' / モバイル: files タブ）で既存 5 秒周期・visibilitychange 制御を流用。対策B として Files パネルヘッダーに更新ボタンを常設 (Issue #888)
- fix(codex): codex 初回起動（update あり）で**初期化が非決定的に失敗**する問題を修正。主因は番号選択を Enter 付きで送信していたこと — `waitForReady` の update skip('2') / trust('1') を `sendKeys(..., false)`（Enter なし）に変更（codex の選択ダイアログは番号キー単独で即確定し、末尾 Enter は次画面に当たる迷子キーで最悪 "Update now" 確定→npm install 暴発になっていた）。増幅要因として `CODEX_PROMPT_PATTERN` が選択肢行も拾うため `CODEX_DIALOG_PATTERN` / `isCodexPromptReady()` を追加し `waitForReady` / `waitForPrompt` 両方に適用（常駐バナー "Update available" は誤って常時 false 化するのを避けるため意図的に除外） (Issue #890)
- fix(codex): `capturePane(50)` が scrollback 込みで返すため、skip 済み update/trust ダイアログ行が live プロンプト上部に残り whole-window 判定が再発火し、**送信メッセージへの `222...` prefix / ready 検出の張り付き**が発生していた問題を修正。`isCodexPromptReady` を位置ベース化（本物プロンプト行が全ダイアログマーカーより下＝最下部アクティブ要素のとき ready）、`getCodexActiveDialog` を新設しプロンプトより下の active 領域のみで分類（scrollback 残存は null）。`waitForReady` の全分岐を位置ベース化し update に `updateDialogHandled` ガードを追加（'2' 再送防止）、`waitForPrompt` はタイムアウト時 throw（fall-through 廃止で検出失敗→誤入力を是正） (Issue #892)

## [0.7.0] - 2026-06-17

> **Highlight**: 別名インスタンス対応（1 エージェント複数セッション、Epic #866）。セッション識別を `(worktreeId, cliToolId)` から `(worktreeId, instanceId)` へ拡張し、1 つの CLI ツールが 1 worktree 内で複数の独立セッションを並行実行可能になった。エイリアス管理 UI（PC / Mobile）、サイドバー / ヘッダー / ターミナルでの per-instance ステータス表示まで一貫対応。

### Added
- feat(agent-instances): セッション識別を `(worktreeId, cliToolId)` から **`(worktreeId, instanceId)`** に一般化し、1 つの CLI ツールが 1 worktree 内で **複数の並行セッション**を tmux/DB/poller の衝突なく実行可能に（Epic #866 の中核）。安定 `instanceId` + alias を導入し同一 CLI ツールの複数インスタンスを `MAX_AGENT_INSTANCES=10` まで許可（id/tool validation + 重複 reject）。primary インスタンス（`instanceId === cliToolId`）は #868 以前の識別子（tmux session `mcbd-{tool}-{wt}` / poller key `{wt}:{tool}`）を完全維持し、追加インスタンスは `deriveSessionSuffix` で `-{suffix}` を付与（完全後方互換）。新規 `agent_instances` テーブル + DB migration v33（`CURRENT_SCHEMA_VERSION` 32→33、既存 `selectedAgents` を primary instance に backfill、`session_states` PK を `(worktree_id, instance_id)` へ再構築、`chat_messages.instance_id` 追加、fresh/既存 DB を 1 migration で self-heal）を追加。API（send/capture/respond/kill-session/special-keys/interrupt/current-output/prompt-response）と CLI（send/capture/wait/respond の `--instance <id>`）が optional `instanceId`（未指定時 primary）を受理 (Issue #871)
- feat(agents): CLI ツールのチェックボックス設定を **agent-instance マネージャ**に置換し、各インスタンスの **alias を header/terminal の全セッション表示に反映**。`AgentInstancesPane`（PC、add/rename/delete/reorder、`1..MAX_AGENT_INSTANCES`、`PATCH /api/worktrees/[id] { agentInstances }` で永続化、同一 CLI ツールの複数インスタンス対応）を追加。PC ターミナル split サブシステムを instance-key 化（split が `cliToolId` + `instanceId` を保持し、同一 CLI の 2 インスタンスを別 split で実行可能）。`getInstanceLabel`（alias 優先）が Header バッジ / Terminal agent タブ / Split CLI selector を駆動。サーバー側 `validateAgentInstancesInput` で bounds / id 一意性 / `id===cliTool` primary anchor / alias 長を guard。永続化状態を migrate（`activeCliTab-<wt>` → `activeInstanceId-<wt>`、`normalizeSplitConfig` が #869 以前の split payload に `instanceId=cliToolId` を導出） (Issue #869)
- feat(agents): **Mobile の Notes/Tools Agent タブからエイリアスインスタンスを管理**（add/rename/delete/reorder）でき、**Mobile ターミナルタブを per-agent-instance 化**して同一 CLI ツールの複数インスタンス（例 Claude×2）を alias で独立選択・利用可能に。折衷案として instance ROSTER（id/cliTool/alias/order）は PC と共有し DB 永続化（共有 `AgentInstancesPane` を `MobileAgentInstancesPane` ラッパで再利用）、**どのインスタンスをタブ表示するかは per-device の view preference として localStorage に保持**（`useMobileSelectedInstances`、DB 非書込、最低 1 インスタンス `MIN_VISIBLE_INSTANCES=1` を維持）。#837/#851 の「Mobile でのタブ絞り込みが PC 表示を縮小しない」意図を継承。`activeInstanceId` を Mobile terminal pane / MessageInput / NavigationButtons / prompt-respond / kill 経路に配線（PC リクエストは byte-identical、instance param は mobile-gated で `instanceId !== cliTool` 時のみ付与） (Issue #874)
- feat(sidebar): サイドバーでエージェント別に最大 5 個並んでいたステータスドットを、**最も重要なステータスを示す単一の `BranchStatusIndicator` に集約**。`aggregateCliStatus()`（優先度 waiting > running/generating > ready > idle）と内訳文字列を生成する `formatCliStatusBreakdown()` を `types/sidebar.ts` に追加し、`BranchListItem` の複数ドットループを集約アイコン 1 つに置換。ホバー/フォーカスで各エージェントの内訳（例 "Claude: running, Codex: idle"）を表示。既存ソート（`STATUS_PRIORITY`, waiting 優先）は `branch.status` 基準のため挙動不変 (Issue #867)
- feat(repositories): サイドバーヘッダーに **`/repositories` への Database アイコンリンク**を `SyncButton` の隣に追加（既存ダークテーマの hover/focus スタイル踏襲）。`/repositories` ページで `RepositoryManager`（Add Repository / Sync All アクション + フォーム）を `RepositoryList` の**上**に描画し、Add/Sync All ボタンを上部に配置 (Issue #880)
- feat(sidebar): サイドバーヘッダーの 4 ボタン（view-mode toggle / sort selector / sync / `/repositories` リンク）に**共有 `Tooltip`（100ms delay、placement bottom）を適用して hover tooltip を統一**。action-oriented な i18n テキスト（`tooltips.{viewMode,sort,sync,repositories}`）で「各ボタンが何をするか」を表示し、低速・名詞のみの native `title` 属性を撤去（`aria-label` は screen reader 用に維持＝二重読み上げ回避） (Issue #882)
- feat(terminal-split): ターミナル split 幅と Message History 幅を 1 アクションで均等化する **"Equal widths" アクションバーボタン**を追加。可視 split 幅を各 `1/n` に、split 共有 Message History 幅を default（40%）にリセット。`useTerminalSplits.resetWidths()`（length-preserving 1/n 均等化、splits/CLI 割当は不変、既存 localStorage effect で永続化）を追加し、terminal resizer の `PaneResizer` ダブルクリックで terminal 幅のみ均等化（VS Code 風、History 幅は据え置き）。`terminal.equalizeWidths` / `terminal.equalizeWidthsHint`（en/ja）を追加 (Issue #861)
- feat(file-tree): Files ツールバー（PC & Mobile）から **obsolete な CMATE ボタン（#294 由来の CMATE.md 手動セットアップ/検証）を撤去**。Schedules UX は `ScheduleEditDialog` / `/cmate/schedules` API / `ExecutionLogPane` へ移行済み。共有 `FileTreeView` から `onCmateSetup` prop / ツールバーボタン / 未使用 handler・props・import をクリーンアップ（cmate-validator は `ExecutionLogPane` で継続使用のため Schedules 機能は無影響、New File / New Directory は不変） (Issue #864)
- feat(activity-bar): **Activity Bar の開閉状態を worktree 単位で永続化**。従来は単一のグローバル localStorage キー（`commandmate.worktree.activeActivity`）に保存し closed（null）状態を永続化していなかったため、ブランチ（worktree）切替で detail view が再マウントされ「A で隠したペインが B 経由で A に戻ると再表示される」問題があった。`useActivityBarState(worktreeId)` 化して `commandmate.worktree.activeActivity-<id>`（per-worktree CLI タブキーと同型）に保存し、`ACTIVITY_CLOSED_SENTINEL` で closed 状態も永続化（未訪問 worktree は引き続き Files デフォルト）。`worktreeId` 変化時に re-hydrate（SSR-safe） (Issue #858)

### Fixed
- fix(db): migration v33（#868）が `worktrees` への FOREIGN KEY を持つ `session_states` を再構築する際、長期運用 DB（`foreign_keys=ON`）に蓄積した**孤立 `session_states` 行**（worktree 削除済み）で full-table copy が "FOREIGN KEY constraint failed" で中断し、`agent_instances` が未作成・worktrees API が破綻する問題を修正。`v33.up()` で worktree が現存する行のみコピー（`WHERE worktree_id IN (SELECT id FROM worktrees)`、孤立行は dead data）。あわせて `scripts/init-db.ts` が **`CM_DB_PATH` を尊重**（従来 `./db.sqlite` をハードコードしていたため `db:init` がサーバー実使用 DB を migrate しなかった）。`foreign_keys=ON` + 孤立行の回帰テストを追加 (Issue #873)
- fix(agents): #868/#869 でタブ/split identity を `instanceId` に移行した一方で **session-status 検出が per-cliTool のままだった**ため、エイリアスインスタンス（`instanceId !== cliToolId`）が PC でステータスアイコンも "✕ End" ボタンも表示しなかった問題を修正。`worktree-status-helper` が `getSessionName(worktreeId, instanceId)` で各インスタンスのセッションを独立検出し、un-aggregated な `sessionStatusByInstance`（instanceId キー）を返却。`sessionStatusByCli` は alias の稼働を logical-OR で畳み込みサイドバー（#867）/ ヘッダードットを正しく維持（primary インスタンスは byte-identical）。`DesktopHeader` / split pane がステータスドット・"End" ボタンを `sessionStatusByInstance[instanceId]` から解決（`sessionStatusByCli` に後方互換フォールバック）。`kill-session` が常に `instance=` を渡し alias 終了が当該インスタンスのみを終了 (Issue #875)
- fix(sidebar): サイドバーのブランチ左ステータスアイコンが **`selectedAgents` 外で起動したインスタンス（例 claude）やエイリアスインスタンス（claude-2）の稼働を反映しない**不具合を修正（#875 で詳細ヘッダーは per-instance 化済みだがサイドバー集約経路が取り残されていた）。`toBranchItem` を `sessionStatusByInstance` / `agentInstances` ロスターベースの per-instance 集約に変更し、`selectedAgents` に依存せずロスター + 稼働中の非ロスターインスタンスを union して `BranchStatus` を導出（`sessionStatusByInstance` 不在時は従来経路にフォールバック）。`aggregateCliStatus` / `formatCliStatusBreakdown` のキーを `CLIToolType` から instanceId（string）へ拡張し、一覧 API `GET /api/worktrees` が `agentInstances` を返すよう修正（共有 `resolveAgentInstances` を `src/lib/session/agent-instances-resolver.ts` へ抽出） (Issue #878)
- fix(worktree): MemoCard ヘッダーの **長いタイトルで insert/copy/delete ボタンがヘッダー行からはみ出る**問題を修正。タイトル `<input>` が `min-w-0` なしの `flex-1` で content intrinsic width（flex `min-width: auto`）により縮小できずボタンを押し出していたため、タイトル input に `min-w-0`（縮小許可）と各アクションボタンに `flex-shrink-0`（自然サイズ維持）を付与 (Issue #885)
- fix(file-tree): PC 版 Files のファイルツリーで、ファイル名 hover 時の**ツールチップ表示が遅い**（ブラウザ制御の native `title` 属性のため Chrome で約 0.5〜1 秒）問題を解消。新規 `TruncationTooltip`（省略表示＝`scrollWidth > clientWidth` 時のみ表示、遅延 200ms、`createPortal` で `document.body` に `position:fixed` 描画しスクロールコンテナでの見切れを回避、`role=tooltip` + `aria-hidden=true`）を追加し、`TreeNode` のファイル/ディレクトリ名 span の `title`（#852）を置換 (Issue #862)

## [0.6.4] - 2026-06-10

### Added
- feat(agents): PC `DesktopHeader` の per-agent status indicator のデフォルトを **3 → 5 エージェント**に拡張（claude/codex/gemini → claude/codex/gemini/opencode/copilot）。`selected-agents-validator` の `MAX_SELECTED_AGENTS` を 4 → 5、`DEFAULT_SELECTED_AGENTS` に opencode/copilot を追加し、`validateAgentsPair` を 2〜5 の一意 ID を受理（6 件以上は reject）するよう変更。`WorktreeDetailDesktop` の `AgentSettingsPane` を `maxAgents` 4 → 5 に拡大。stored `selectedAgents` を持つ既存 worktree は無改修（migration なし、新規 worktree のみ 5-agent デフォルト）、Mobile の `DEFAULT_MAX_AGENTS=2` は無影響 (Issue #836)
- feat(agents): Mobile の Agent タブの選択を **localStorage に分離し PC（DB `selectedAgents`）から独立**。従来 Mobile の選択が worktree の `selectedAgents` DB カラムを PATCH していたため、Mobile で 2 エージェントを選ぶと PC 側の DesktopHeader indicator も 2 に縮小していた。Option A として Mobile は preference を `commandmate:worktree:mobileAgents:<id>` に localStorage 永続化し DB を書かない（PC が単一の真実源を維持）。`useMobileSelectedAgents` フック / `AgentSettingsPane` の `availableAgents`・`persistToServer` props を追加し `NotesAndLogsPane` / `MobileContent` 経由で配線。PC 経路は無改修 (Issue #837)
- feat(agents): Mobile の Agent タブで **PC とは独立に全 6 CLI ツールから自由に選択可能**に。従来は localStorage preference を PC の DB 選択に対して解決し 2 件に capping していたため Claude/Codex しか選べなかった。`useMobileSelectedAgents` の解決対象を全 agent pool（`CLI_TOOL_IDS`）に変更し `MOBILE_MAX_AGENTS` を 6 へ、`MOBILE_DEFAULT_AGENTS=2`（初期タブ）を追加。`resolveMobileAgents(raw, pool)` で validate/dedupe/cap、未使用の `dbSelectedAgents` option を撤去。DB は引き続き書かない (Issue #851)
- feat(terminal-split-action-bar): `TerminalSplitContainer` の既存 +Split/-Split Action bar に **History / Files 表示トグルボタンを追加**（Phase 2）。「N / 3 splits」カウントと +Split コントロールの間に配置し split 数に関わらず常時表示。History トグルは `useHistoryPaneState().toggle()`、Files トグルは `useFilePanelState().toggle()` を呼び、両フックの broadcast により縦の collapse strip と単一の真実源を共有。active（可視）= cyan アクセント / inactive = グレー、`aria-pressed` で可視状態を反映、`aria-label`/`title` は Show/Hide 文言（`worktree.terminal` i18n キー再利用）を切替 (Issue #841)
- feat(mobile): Mobile 下部 tab bar の **'CMATE' タブ label を 'Notes' にリネーム**。PC Activity Bar の Notes activity と用語統一し、実体（`NotesAndLogsPane` の主要コンテンツ＝メモ）を正確に表す。`id='memo'` / icon / 内部 routing は不変（deep-link 影響なし） (Issue #838)
- feat(mobile): Mobile の **4 番目の tab label を 'Notes' → 'Tools' にリネーム**（より明確な intent）。内部 id（`'memo'`）と deep-link slug（`'notes'`）は既存 pane routing / deep-link 互換のため不変 (Issue #850)
- feat(file-tree): file tree（`TreeNode`）と `FilePanelContent` ツールバーの open-file path で CSS `truncate` により切り詰められた **ファイル/ディレクトリ名・パスを hover 時に title tooltip でフルネーム表示**。`TreeNode` の name span（PC/Mobile）と `FilePanelContent` の path span に native `title` 属性を追加 (Issue #852)
- perf(worktree-detail): `useWorktreeDetailController` の worktree/loading state を **共有 worktree リストキャッシュから prime**（stale-while-revalidate）し、キャッシュ済み worktree の詳細画面を開いた際に「Loading worktree info...」のフラッシュなく即座に描画。background `fetchWorktree()` は引き続き走り authoritative payload で上書きする。non-throwing `useOptionalWorktreesCacheContext()` を追加して #709 の single-poller 保証（2 つ目の `/api/worktrees` poller を作らない）を維持し provider 不在でも graceful degrade。cache miss は従来どおり loading-first（回帰なし） (Issue #839)

### Fixed
- fix(file-panel): PC History/File panel 可視性改善の Phase 1。file-panel の **折りたたみ状態を localStorage（`commandmate.worktree.filePanelCollapsed`）に永続化**（`useFilePanelState` フックを新設し `useHistoryPaneState` をミラー、`FilePanelSplit` の非永続 `useState(false)` を置換）し reload / re-mount を跨いで状態を保持。折りたたみバーを 24 → 36px に拡幅し FilePanel / History の collapsed bar に CSS `vertical-rl` の縦ラベル（"Files" / "History"）を追加。`HistoryPane` / `TerminalContainer` / `TerminalSplitPaneContent` の aria-label/title 文言を新 i18n キー `worktree.terminal.*`（en/ja）由来の "Show / Hide" に統一。既存の collapse/expand 挙動は不変 (Issue #840)
- fix(terminal-pane): エージェント終了（kill / 自然終了）後に **PC ターミナル split へ残留していた古い出力をクリア**。root cause は `useTerminalPanePolling` が「出力あり または セッション実行中」のときのみ出力をクリアしていたため、「空 + 停止」ケース（まさに kill / 終了ケース）で stale 出力が残っていたこと。`isRunning === false` になったら一度上書き（クリア）するよう修正（実行中セッションは無影響）。加えて `TerminalDisplay` に `attaching` prop を追加し、attaching 中は「読込中...」、active セッションが出力なしで非アクティブ化した際は「セッションは終了しました（メッセージ送信で再開できます）」の ended placeholder を表示（never-started / attaching pane には ended placeholder を出さない） (Issue #842)

## [0.6.3] - 2026-06-05

### Added
- feat(git-pane): **GitPane の UX を全 4 Phase でリデザイン**。情報設計の 2-tier 化からモバイル tab UI・AI 委任までを段階的に改善。
  - **Phase 1 — 2-tier information design (#815)**: GitPane を Core（常時表示: Current Status / Quick actions（Pull/Push のみ）+ 昇格した `BranchCheckoutDropdown` / Changes / Commit History）と「Advanced operations」グループ（`AdvancedSection`、デフォルト折り畳み・Fetch / Branches（create/delete のみ）/ Stash / Danger Zone を内包）に再編。開閉は `useLocalStorageState`（SSR-safe）で `commandmate:gitPane:advancedOpen` に永続化。Checkout を新規 core `BranchCheckoutDropdown`（confirm ダイアログ + S3-001/S3-002 警告 + force フラグを verbatim 移設、testid 同一）に抽出し、Fetch を `NetworkOperationsSection` の optional `onFetch` + dropdown 用 `extraActions` slot で Pull/Push から分離。全 handler / API 呼び出しは不変（純情報設計） (Issue #815)
  - **Phase 2 — action shortcuts (#816)**: core git workflow を短縮する 3 つのショートカットを追加。Changes に Commit 隣の「Commit + Push」複合ボタン（commit フローを `doCommit()` に切り出し成功時のみ push、push 失敗時は commit を保持＝rollback なし、既存の canCommit/amend ガードを継承）、Commit History の各行にインライン「View diff」ボタン（`GET /git/show` で file list をアコーディオン展開、`selectedCommit` 詳細経路とは独立 state で後方互換維持）、Changes の各ファイルに展開キャレット（unstaged/staged/untracked diff の先頭 20 行をインライン表示、既存「Diff」ボタンの全 diff 表示は維持）を追加 (Issue #816)
  - **Phase 3 — 'Ask AI' buttons (#817)**: Advanced グループの複雑な Git 操作に「Ask AI」ボタンを配置し、手動実行の代わりに active CLI agent へ委任可能に。クリックで context-rich な ja プロンプトを active CLI タブの `MessageInput` composer に下書き（auto-send なし＝送信前にレビュー/編集可）。既存 `pendingInsertTextMap` 経路（`handleInsertToMessage` / #728 / #744）を流用。新規 `src/lib/git-ai-prompt-templates.ts` を SSOT pure builder（branch create/delete・stash cleanup・stash pop/apply conflict・reset（hard-reset reflog 復旧 note 付き）・revert・force-push）として新設。`GitPane` に再利用可能な `AskAiButton` を追加し Branches / Stash / Danger Zone セクションへ配線（handler 未配線時は非表示でグレースフルデグレード、既存 execute 経路ボタンは不変） (Issue #817)
  - **Phase 4 — mobile tab UI + visual grouping + persistence (#818)**: Mobile は 4-tab UI（Status/Changes/History/Advanced、新規 `GitPaneMobileTabs`、active タブのみマウント＝非 active グループは unmount、最後のタブを永続化）。Desktop は read/write/advanced ブロックへの視覚的グルーピング（bg tint + accent border、セクション順序と overflow-hidden+flex-1 history レイアウトは不変）。永続化は active タブ + Commit History/Advanced 折り畳み状態を新規 `useGitPaneTabState` フック（`commandmate:gitPane:` namespace、Phase 1 `advancedOpen` キーを維持）に統合。`useIsMobile` / `isMobile` prop 経路・handler・API 呼び出しは不変 (Issue #818)
- feat(schedules): **Schedules ペインの UX を全 4 Phase でリデザイン**。CMATE.md 手編集なしでのスケジュール CRUD から、モバイル full-screen modal・AI 委任までを段階的に追加。
  - **Phase 1 — ScheduleEditDialog modal (#824)**: CMATE.md を手編集せずスケジュールを作成/編集できる Desktop/Mobile 共用 modal を追加。Option C（UI は CMATE.md のみ書き込み、既存 `schedule-manager` mtime watcher が DB を同期）を採用し DB の POST/PUT/DELETE を UI から呼ばない。`src/lib/cmate-writer.ts`（cmate-parser の対称版・section 順序/format を保持する pure upsert/remove/toggle 変換 + cell escaping + atomic 書き込み（tmp→rename）+ `validateScheduleInput`）、`ScheduleEditDialog.tsx`（name/cron（+presets）/CLI tool/model（copilot）/動的 Permission dropdown/message（counter）/enabled、inline validation）、API route `/api/worktrees/[id]/cmate/schedules`（POST upsert / PATCH toggle / DELETE remove、`syncSchedulesNow()` で即時反映）を新設。`getPermissionOptionsForTool`（動的 dropdown の単一ソース）を追加 (Issue #824)
  - **Phase 2 — mobile full-screen modal + section accordion + sticky footer (#825)**: `ScheduleEditDialog` を 3 アコーディオンセクション（Basic / Advanced / Message）に分割し、viewport で shell を切替。Mobile（<768px）は新規 `FullScreenModal`（slide-up・右上 close・sticky footer、accordion はデフォルトで先頭のみ open、`visualViewport` を追跡し focus 中の input をスクロールしてオンスクリーンキーボードに隠れないように）、Desktop（>=768px）は Phase 1 の中央 Modal を維持（3 セクション全展開）。各アコーディオンヘッダーに section icon + 動的サマリ（CLI tool · permission 等）を表示。`src/components/common/FullScreenModal.tsx` を新設、tailwind に slide-up keyframe を追加 (Issue #825)
  - **Phase 3 — empty-state CTA + Logs tab separation + inline row actions (#826)**: Schedules ペイン（`ExecutionLogPane`）を再編。Empty state に中央寄せ「Create Schedule」CTA（旧 4-step CMATE.md 手順は「Or edit CMATE.md manually」折り畳みトグル＝デフォルト closed の背後へ移動）、Execution Logs を in-pane tabs（「Schedules」/「Logs」）で分離（Logs は自身の展開/詳細取得 state を持つ `ExecutionLogsView` に抽出）、Schedule 行に inline enabled トグル（role=switch・1-click・modal なし）+ edit/delete アイコンボタン（aria-labelled）+ last-run/next-run/log timestamp を統一する共有 format helper を追加。CRUD 挙動と data-testid は不変 (Issue #826)
  - **Phase 4 — 'Ask AI' buttons for cron / message drafting (#827)**: `ScheduleEditDialog` の cron / message フィールドに「Ask AI」ボタンを追加。クリックで context-aware な ja プロンプトを active CLI タブ composer に下書き（auto-send なし）し modal を閉じて AI 応答を確認可能に。既存 #817（GitPane）と同じ `pendingInsertTextMap` 経路を流用。新規 `src/lib/schedule-ai-prompt-templates.ts`（cronPrompt / messageDraftPrompt の pure builder で ja プロンプトを SSOT 管理）、`ScheduleEditDialog` に `onInsertToMessage` prop + `AskAiButton`（未配線時は非表示でグレースフルデグレード）を追加 (Issue #827)

### Fixed
- fix(schedules): 無効化（`enabled=false`）されたスケジュールが Schedules ペインに表示されず UI から管理不能だった問題を修正。`/api/worktrees/[id]/schedules` GET クエリが `AND enabled = 1` をハードコードしており、ペインが read-only だった #294 時代は問題なかったが、#824 で create/edit/delete/toggle UI を追加した後は CMATE.md 内の disabled スケジュールが不可視となり、再有効化/編集/削除に CMATE.md 手編集が必要になっていた。SELECT から `AND enabled = 1` を除去（1 行修正）し、enabled/disabled 両方の行が返ること・SQL が filter を再導入しないことを検証する回帰テストを追加。Active Schedules セクション（実行中 cron job を filter する別 endpoint）・cron-parser の CMATE.md sync・soft-delete（削除時 `enabled=0`）ロジックは不変 (Issue #832)

## [0.6.2] - 2026-06-04

### Added
- feat(message-input): busy なセッションへメッセージを送信した際に **「queued (session busy)」warning toast** を表示。先行タスク処理中のセッションに送信すると API は 200 を返して CLI 側でメッセージをキューイングするため composer が空になり「何も起きない（no-op）」ように見えていた挙動を改善。`MessageInput` に `isProcessing` / `showToast` props を追加し、送信成功時に `isProcessing === true` なら「現在のタスクの後ろにキューされた」旨の warning toast を表示（idle 送信時は従来どおり toast なし）。`TerminalSplitPaneContent` は当該 split 自身の poller（`useTerminalPanePolling` の `terminal.isRunning`）から `isProcessing` を導出し、既存の `history.showToast` surface を再利用して両者を `MessageInput` へ配線 (Issue #806)

### Fixed
- fix(status-detector): `/pm-auto-dev` + subagent Task 実行中に Claude セッションが誤って "Ready"（`isProcessing: false`）と検出される問題を修正。footer 下部に subagent task panel（`⏺ main` / `◯ general-purpose ... 55s` 行）が描画されると、`✶ Running…` スピナー（footer 上部）と `esc to interrupt` status bar の両方が step 2（thinking 検出）の狭い 5 行 `THINKING_TAIL_LINE_COUNT` window の外へ押し出され、可視のままの `❯` input box が step 3 の input-prompt チェックに合致して `status='ready'` を返していたことが原因。input-prompt フォールバックの前に、より広い 15 行（`STATUS_CHECK_LINE_COUNT`）footer window 内で `esc to interrupt` status bar を照合する Claude 専用チェック（step 2.6 / `CLAUDE_INTERRUPT_HINT_PATTERN`）を追加。status bar は Claude が能動的に処理中のみ表示され live で再描画されるため（idle 時は `? for shortcuts`）、Issue #188 の spinner-summary 誤検出は再発しない (Issue #805)
- fix(prompt-detector): Claude Code v2.x の **AskUserQuestion picker** で auto-yes が 30 分以上沈黙する問題を修正。新 picker は `Enter to select · ↑/↓ to navigate · Esc to cancel` footer の**下**に overlay（`/pm-auto-dev` task panel、例 `6 tasks (4 done, 2 open)`）を描画するため、`NORMAL_OPTION_PATTERN` が `6 tasks …` 行を option 6 と誤マッチし逆方向スキャンが footer で停止、本来の `1./2./3.` picker options が収集されず検出が `no_prompt` を返していたことが原因。`CLAUDE_ASK_USER_QUESTION_FOOTER_PATTERN` を追加し `effectiveEnd` footer-trim（Issue #704 機構）を picker footer でもトリムするよう拡張（trailing panel をスキャン窓の外へ排除、`isAskUserQuestion` フラグ付与）。回答送信側（`prompt-answer-sender.ts`）は AskUserQuestion picker でハイライト済みデフォルト（`offset === 0`）選択時に Enter 前へ net-zero の Down+Up nudge を送り picker cursor を確実に engage（裸 Enter での commit 失敗を回避）。legacy footer / 旧フォーマット経路は byte-for-byte 不変 (Issue #807)

### Chore
- chore(docs): CLAUDE.md の肥大化を構造的に防止。CLAUDE.md からインライン module table（240 行）を削除（92,229 → ~15kB）し全 module detail を `docs/module-reference.md` へ集約、CLAUDE.md 冒頭に anti-pattern directive（モジュール詳細を書かない指示）を追加、CI に CLAUDE.md size の hard-cap（35,000 byte 上限・hard-fail）を追加して回帰を防止 (Issue #809)

## [0.6.1] - 2026-06-03

### Added
- feat(git): **GitPane に Git 操作機能を全 5 Phase で追加**。worktree 詳細の Git タブから status 確認〜stage/commit〜branch 操作〜stash/reset/revert〜push/pull/fetch までを UI 完結で実行可能に。
  - **Phase 1 — Current Status (#779)**: 既存内部実装 `getGitStatus` を API 化（`GET /api/worktrees/[id]/git/status`、`currentBranch` / `isDirty` / `aheadBehind` 等）し、GitPane 最上部に Current Status セクション（branch chip / dirty badge / ↑N ↓M / refresh、branch mismatch 警告、Mobile コンパクト版、visibilitychange 対応ポーリング）を追加 (Issue #779)
  - **Phase 2 — stage/unstage/commit (#780)**: ローカル完結の write 操作を追加。`git/staged`（Staged/Unstaged/Untracked）/ `git/stage` / `git/unstage` / `git/commit`（空 commit 拒否）/ `git/working-diff` の各 API と Changes セクション（3 折り畳みリスト＋ファイル単位 Diff/Stage/Unstage）を追加。書き込みは Map 直列化 + `index.lock`→409 で排他制御し、#779 の `getGitStatus` バイト不変性を厳守 (Issue #780)
  - **Phase 3 — branch list/checkout/create/delete (#781)**: `listBranches` / `checkoutBranch` / `createBranch` / `deleteBranch` と専用 typed error 6 種を追加。`git/branches` / `git/checkout`（remote は `switch -c --track` で detached HEAD 回避、`force` で dirty 破棄）/ `git/branch/create` / `git/branch/delete` の API、GitPane に Branches セクション（local/remote タブ、checkout/create/delete モーダル、dirty 時 checkout 警告・履歴喪失警告）を追加 (Issue #781)
  - **Phase 4 — stash + reset/revert (Danger Zone) (#782)**: `stashPush/Pop/Apply/Drop` / `gitReset` / `gitRevert` と conflict リカバリ（200 で `{conflict, conflictFiles}` 返却）を追加。default branch への hard reset はサーバー側で拒否（`GitResetDefaultBranchError`→409）。GitPane に Stash セクションと Danger Zone（赤・デフォルト折り畳み、Reset/Revert モーダル＋hard branch-confirm・履歴喪失/実行中セッション警告）を追加。pop/apply の conflict は専用 notice として表面化 (Issue #782)
  - **Phase 5 — push/pull/fetch + credential 処理 (#783)**: `gitFetch` / `gitPull` / `gitPush`、ネットワーク stderr 分類、credential 委譲（git credential helper / SSH-agent）、進捗 polling、abort semantics を追加。push は明示 refspec `${branch}:refs/heads/${branch}` で remote default 誤更新を封鎖、`main`/`develop` への force push は拒否し `forceWithLease` を推奨デフォルト化。logger に userinfo-URL redaction を追加し credential 付き URL の平文ログ漏洩を防止。force push は Danger Zone 内＋多段確認モーダル (Issue #783)
- feat(memo): メモ登録上限を **10 → 20** に拡張し、MemoPane に title+content の client-side テキスト検索（`useMemoSearch` / `MemoSearchBar`、indexOf ベースで ReDoS 回避、debounce 300ms・最小2文字・IME 対応、フィルタ＋next/prev スクロール）を追加 (Issue #787)
- feat(layout): PC版 `DesktopHeader` の per-agent status indicator を **HTML5 ネイティブ drag-and-drop** で terminal split にドロップして、その split の CLI tool を切り替え可能に。専用 MIME `application/x-commandmate-cli-tool` で cliId を publish、drop 先で allowed=cyan ring / forbidden=red ring を表示、同一 CLI 複数選択は reject＋warning toast。クリックでの `activeCliTab` 切替（#751）は維持、新規 props は全 optional で既存 call site 非破壊、Mobile 経路は非描画 (Issue #786)

### Fixed
- fix(layout): PC版でセッションを強制クローズする kill ボタンが消失していた問題を修正。#728（PC ターミナル 1-3 split 化）で Terminal header の kill ボタンを削除した際、#755（Desktop/Mobile 分割）で Mobile 経路のみ復活し Desktop 経路が復活漏れだった（#740 / #743 と同型の per-split 移行漏れパターン）。`DesktopHeader` に per-agent status row と worktree status dropdown の間へ kill button（赤・✕ icon・"End" label、表示条件 `sessionStatusByCli?.[activeCliTab]?.isRunning === true`、`data-testid="desktop-kill-session"`）を配置 (Issue #784)
- fix(slash-commands): Codex CLI は skill を `$NAME` 構文で起動し `.codex/prompts/` を読まないため、`codex-skill` ソースのコマンド表記を `$NAME` に変更（Claude/Copilot/Gemini は `/NAME` 維持）し、未使用の `.codex/prompts` ローダー（`loadCodexPrompts` 等）と `codex-prompt` invocation を削除 (Issue #790)
- fix(slash-commands): PC版 Codex タブの composer で先頭 `$` を入力しても slash command palette が開かなかった問題を修正（#790 で `$NAME` 表記化したが trigger 側が未対応だった）。`cliToolId === 'codex'` のときのみ先頭 `$` で palette を開くよう trigger 条件を拡張し、他タブでは `$` を通常文字として扱い誤発火を回避。既存 `/` trigger は不変 (Issue #799)
- fix(slash-commands): 同名の `.claude/commands/*.md`（`cliTools: undefined`）が `deduplicateByName` で Codex skill を上書きし、その後 `filterCommandsByCliTool` で Claude 専用エントリが Codex タブから除外されて Codex palette からスキルが消える問題を修正。dedup マップのキーを `name` 単独から **`name + cliTools`** に変更し、CLI tool スコープが異なるエントリは共存、name と cliTool スコープが完全一致する場合のみ重複排除（後勝ち）するよう変更 (Issue #800)

## [0.6.0] - 2026-06-02

### Added (v0.6.0 リリース準備)
- feat(branding): favicon を `apple-icon.png` ソースに 32/96/192 px 3 サイズ生成（タイトクロップ）。`src/app/icon.png` (32×32) のキャラクター描画領域が canvas の ~50% しか占めず透明パディングが多いためブラウザタブで小さく見える UX 問題を解消。方式A（ファイル規約のみ、`layout.tsx` 無改修）採用 — Next.js 14.2.35 では `metadata.icons` 設定が file-based icon を上書きするため `apple-touch-icon` 喪失リスクを回避 (Issue #753)
- feat(layout): PC版 `DesktopHeader` の per-agent indicator を **icon-only + hover Tooltip** から **インライン常時テキスト** `<icon> ${AgentName}: ${StatusLabel}` に変更（`● Claude: Ready  ⟳ Codex: Running`）。Tooltip wrapper と未使用 `import { Tooltip }` を撤去、dot/spinner icon をテキストの左に first child span として配置 (Issue #751)

### Refactored (v0.6.0 リリース準備)
- refactor(worktree): `WorktreeDetailRefactored.tsx` を責務別に分割（2205 → **610 行**、-1595）。`useWorktreeDetailController` (1489行) / `usePendingInsertText` (116行) hook と `WorktreeDetailDesktop.tsx` (696行) / `WorktreeDetailMobile.tsx` (368行) component に抽出。TODO:[D1-001] 解消、`useFileOperations.ts` の `MoveTarget` 型を export、`tests/integration/issue-278-acceptance.test.ts` pre-existing 2 FAIL を 10/10 に解消。新規 `usePendingInsertText.test.tsx` 10 tests pass (Issue #755)
- refactor(terminal): `TerminalSplitPaneContent` Props を **27 個 → 13 個**にドメイン別型分割。`src/types/terminal-split-pane.ts` 新設に `TerminalSplitPaneCoreProps` / `SplitAutoYesProps` / `HistoryPaneProps` を export、`autoYes` / `history` を nested 型で受け取り。`AutoYesToggleParams` を `src/types/auto-yes.ts` に抽出して TSX → 非 TSX module へ移動（`tsconfig.server.json` の TS6142 回避） (Issue #756)
- refactor(cli): `CLI_TOOL_IDS` 配列の重複定義を `src/lib/cli-tools/types.ts` の単一ソースに統合し、`src/cli/config/cli-tool-ids.ts` から re-export（参照同一性保証） (Issue #757)
- refactor(config): timeout/delay の magic number 約 44 箇所を新規 3 config (`cli-tool-timing-config.ts` / `ui-feedback-config.ts` / `external-apps-config.ts`) + 既存拡張に集約。値保存監査全 44 対で全件一致確認 (Issue #760)
- refactor(fullscreen): `useFullscreen.ts` の `@ts-expect-error` 19 個クラスタを `src/lib/browser-compat/fullscreen-api.ts` の互換ラッパー 4 関数に抽出 (Issue #763)

### Documentation (v0.6.0 リリース準備)
- docs(history): `docs/implementation-history.md` および `docs/en/implementation-history.md` に #723〜#754 の約 30 件のエントリを Issue 別テーブル形式で追記 (Issue #758)
- docs(architecture): `docs/architecture.md` および `docs/en/architecture.md` に §6 UI Layout Architecture (#727/#730) / §7.1 TerminalSplits Strategy (#728/#744) / §X Per-agent Status Architecture (#743/#749/#751) の主要章を追記（Mermaid 図 + Issue 内部リンク） (Issue #759)
- docs(cleanup): `docs/` 配下の過去 Issue 参照 (#4, #31, #69, #80, #600 等) を 3 分類で棚卸し。`DEFAULT_SELECTED_AGENTS` / `MAX_FILE_TABS` 5→30 をコードと整合、migration の「#80完了後」前提を除去、en/UI_UX_GUIDE を #730 後の 3 カラム構成へ同期、エージェント 2→2〜4 を MIN=2/MAX=4 に統一。markdown-link-check リンク切れ 0 (Issue #767)

### Chore (v0.6.0 リリース準備)
- chore(test): `tests/` 配下の `.skip` / `.only` を棚卸し（5 件復活 / 2 件削除）。`it.only` / `describe.only` 残留 0 件 (Issue #764)
- chore(lint): プロジェクト全体の `eslint-disable` コメントを棚卸し。`any` → `unknown` / 適切な型への置換、依存配列の明示化を 14 ファイルに適用。`.eslintrc.json` 調整。テスト 6778 pass (Issue #765)

### Fixed
- fix(terminal): PC版の各ターミナル split header に AIエージェント status indicator（dot/スピナー）を復活（#728 で per-split header 構造移行時に取りこぼされていた、#740 と同型の「移行漏れ」パターン）。`TerminalSplitPaneContent.tsx` に optional `cliStatus?: BranchStatus` prop（未指定時 `'idle'` フォールバック）を追加し、`SIDEBAR_STATUS_CONFIG[cliStatus]` から解決した status indicator を `useMemo`（依存 `statusConfig.type`/`className`/`label`/`splitIndex`）で生成して既存 `headerExtras` slot に配線。Mobile 正準（`WorktreeDetailRefactored.tsx:1947-1974`）と同じインライン span（spinner=`animate-spin border-2 border-t-transparent`、dot=`rounded-full`）・`title` のみの a11y・`data-testid="split-status-indicator-${splitIndex}"` を踏襲。データは親 `WorktreeDetailRefactored` の `renderSplitPane` で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を導出し、**memo 境界を越えるのは導出済み `BranchStatus` 文字列のみ**（status 不変のポーリング周期では split を再renderしない memo-safe 設計／S3-001）。Mobile 経路（L1947-1974）は無改修 (Issue #743)
- fix(terminal): PC版の各ターミナル split footer に `AutoYesToggle` を復活（#728 で per-split footer 移行時に取りこぼされていた）。CLI 単位で独立した Auto-Yes ON/OFF 操作を可能化。`WorktreeDetailRefactored.tsx` の `handleAutoYesToggle` を `makeAutoYesToggleHandler(cliToolId)`（`useCallback`、依存 `worktreeId` で安定参照）にパラメータ化し、API body の `cliToolId` と `setAutoYesStateMap` のキーを引数値に変更。Mobile 経路（L1897-1904）は `makeAutoYesToggleHandler(activeCliTab)` の薄いラッパで従来どおり動作。`TerminalSplitPaneContent` に `autoYesExpiresAt` / `lastAutoResponse` / `onAutoYesToggle` props を追加し footer 先頭で `<AutoYesToggle cliToolName={cliToolId} inline />` を描画。状態は親の per-CLI `autoYesStateMap` を単一の真実源とし、`renderSplitPane` で各 split に per-CLI 値を配布。client-side auto-response は per-split 化せず #501 サーバー poller に委譲。`showPrompt = prompt.visible && !autoYesEnabled` の既存挙動・split0→activeCliTab 同期は維持 (Issue #740)

### Added
- feat(layout): PC版 `DesktopHeader` 右側（worktree status dropdown の左）に **per-agent（CLI 単位）session status indicator row** を追加。`selectedAgents` 各エージェントの状態（idle=グレーdot / ready=緑dot / waiting=黄dot / running・generating=青スピナー、`SIDEBAR_STATUS_CONFIG` 準拠）を並べて表示し、3 split 表示中でも全 agent の状態を一目で把握可能に。クリックで `activeCliTab` を該当 CLI に切替（`onActiveCliTabChange(cliId)`）、active indicator は `bg-cyan-100 dark:bg-cyan-900/30` + `aria-pressed` で強調、hover で `Tooltip`（content=`${displayName}: ${label}`, placement=bottom）。`WorktreeDetailSubComponents.tsx` の `DesktopHeader` に 4 つの **optional** props（`sessionStatusByCli` / `selectedAgents` / `activeCliTab` / `onActiveCliTabChange`）を追加し、`WorktreeDetailRefactored.tsx` の呼び出しから配線。導出は既存 `deriveCliStatus`/`SIDEBAR_STATUS_CONFIG` を再利用（新規導出ロジックなし）、内側 status span は `title` のみ（`role="status"` なし＝ポーリング毎の多重読み上げ回避）。左側の worktree-level status dot（`DESKTOP_STATUS_CONFIG`）は無改修・別系統として併存。全 props optional のため既存呼び出し元・既存テストは無改修、props 未指定時（Mobile 経路含む）は row 非描画で後方互換（`data-testid="desktop-agent-status-row"` / `desktop-agent-status-${cliId}`） (Issue #749)
- feat(terminal): PC版で `HistoryPane` を各ターミナル split（1-3 split、#728）内に内包し、各 split がその split の `cliToolId` のメッセージのみを**同時に**表示（A=Claude / B=Codex で各々の履歴を並列表示）。新フック `src/hooks/useSplitMessages.ts` を新設し、各 split が自分の `cliToolId` で `/api/worktrees/[id]/messages?cliTool=<id>&limit=<n>&includeArchived=<bool>` を独立 fetch（`useTerminalPanePolling` 同型：requestId stale-guard ＋ visibilitychange pause ＋ `refresh()`、API/DB は既存対応で backend 変更なし）。`state.messages` は `fetchMessages` が activeCliTab でサーバ側フィルタ済みのため split 並列表示には流用不可、という制約への対応。検索ハイライトは `src/lib/terminal-highlight.ts` に `makeHistoryNamespace(splitIndex)` ファクトリを追加し `history-search-${splitIndex}` 等へ per-split 化（`CSS.highlights` グローバルレジストリの上書き衝突を回避）、`src/app/globals.css` に split 0-2 分の `::highlight()` rule を静的追加（MAX_SPLITS=3）。`HistoryPane` に additive な `splitIndex?` / `cliToolId?` props（splitIndex 指定時のみ per-split namespace 使用、未指定時は従来の `HISTORY_SEARCH_NAMESPACE` 動作）、`TerminalSplitPaneContent` に `onFilePathClick` / `showToast` / `onHistoryInsertToMessage`（splitIndex 直指定ルーティング／S3-005）/ `showArchived` / `historyDisplayLimit` / `historyUserOnly` 等の props を追加。メッセージ送信後はその split の `useSplitMessages.refresh()` を呼ぶ（S1-006）。`applyHistoryHighlights` / `clearHistoryHighlights` は optional `namespace` 引数を additive 追加（default=`HISTORY_SEARCH_NAMESPACE`）。全変更は additive（optional props）で Mobile 経路（`WorktreeDetailRefactored.tsx:1947-1974` 周辺）と既存テストを無改修維持 (Issue #744)
- test(e2e): #728 AC-27 を Playwright e2e で機械検証。`tests/e2e/terminal-split-resizer-cursor.spec.ts`（PaneResizer 複数インスタンス並存下での drag 後 cursor 非残留）と `tests/e2e/terminal-split-cross-worktree-persistence.spec.ts`（`commandmate:terminalSplits:{worktreeId}` の worktreeId スコープ永続化＝cross-worktree 分離）を新規追加。chromium 限定（`beforeEach` 内 `testInfo.project.name` self-skip で Mobile Safari を除外、`playwright.config.ts` は無変更）、`test.use` で 1920×1080 viewport を spec ローカル指定。フィクスチャ `tests/e2e/fixtures/terminal-split-helpers.ts` は `page.route` による worktree API モック（DB/git/tmux セッション非依存で split UI を描画）＋ sessionStorage ガード付き localStorage 隔離（一意 worktreeId `e2e-split-a/b`）を提供 (Issue #735)
- test(terminal): `src/components/worktree/TerminalContainer.tsx` の History 展開ボタン（`aria-label="Expand history panel"`）に `data-testid="history-pane-expand"` を付与（e2e 用、純 additive・ランタイム挙動不変） (Issue #735)
- feat(terminal): add PC terminal 1-3 horizontal split with per-split CLI selector and MessageInput (#728)
- Layout (PC): **カスタム Tooltip** コンポーネント `src/components/common/Tooltip.tsx` を新設。`TOOLTIP_DELAY_MS = 100` の即時表示、ダークテーマ（`bg-gray-900` / `text-gray-100`）、`placement=top/right/bottom/left`、`role="tooltip"` + `aria-hidden="true"`（`aria-label` 重複読み上げ回避）、wrapper `<span>` の `tabIndex={-1}`、`useEffect` cleanup で `clearTimeout`、`React.cloneElement` を使わず ref/onClick/onKeyDown を透過する設計 (Issue #730)
- Layout (PC): **TerminalContainer** コンポーネント `src/components/worktree/TerminalContainer.tsx` を新設。History + Terminal+FilePanel を内包する親コンテナ。`HISTORY_PANE_ID = 'worktree-history-pane'` を `WorktreeDesktopLayout` から移管・export。`useHistoryPaneState` で visible/width/toggle/setWidth を管理、可視時は History wrapper div + PaneResizer、非表示時は expand bar（`aria-controls=HISTORY_PANE_ID`）、History/Terminal をそれぞれ `ErrorBoundary` で包含 (Issue #730)
- Hook: `useHistoryPaneState` に `commandmate:historyPaneStateChange` CustomEvent broadcaster を追加。同一 window 内で `WorktreeDetailRefactored`（HistoryPane onCollapse 用）と `TerminalContainer`（render 用）の 2 instance の visible/width 状態を同期 (Issue #730)
- Layout (PC): VS Code 風 **Activity Bar** + History 独立カラムを導入。`ActivityBar.tsx` / `ActivityPane.tsx` / `useActivityBarState.ts` / `useHistoryPaneState.ts` / `activity-bar-config.ts` を新設。6 Activity（Files/Git/Notes/Schedules/Agent/Timer）、ArrowUp/Down/Home/End/Enter/Space キーボード対応、`role="tablist"` + `aria-orientation="vertical"` + `aria-selected` + `aria-label` + `aria-controls="worktree-activity-pane"`。History pane は `<` / `>` 折りたたみ + ドラッグリサイズ。`commandmate.worktree.activeActivity` / `historyVisible` / `historyWidth` を localStorage 永続化 (Issue #727)
- Deep link: `?pane=git|notes|logs|agent|timer|files|history` を新 Activity 体系へマッピングするため `useWorktreeTabState.toActivityId()` を追加。`logs → schedules` リネーム、`history/terminal/info → null` (Issue #727)
- API: `GET /api/worktrees/:id/files/:path?startLine=N&endLine=M` 行範囲モードを追加。行範囲モード時は `If-Modified-Since` をスキップして常に 200 を返す。レスポンス JSON に `totalLines` / `totalBytes` / `encoding` / `range` のオプショナルメタを追加（`FileContent` 型拡張、後方互換） (Issue #723)
- i18n: `fileTooLarge.editableLimit` / `fileTooLarge.viewerLimit` を `locales/ja/error.json` / `locales/en/error.json` に追加 (Issue #723)
- History: HistoryPaneヘッダーに「User only」フィルタトグルを追加。トグルON時はAssistantメッセージとorphanペアを非表示にし、検索もuser roleのみに絞る。localStorage（`commandmate:historyUserOnly`, `'true'`/`'false'`）で永続化、aria-pressed準拠、lucide-react `User`/`UserCheck` アイコン、PC/モバイル両経路（MobileContent）に対応 (Issue #725)

### Changed
- feat(layout): PC版のサイドバートグル（ハンバーガー ☰）を `DesktopHeader` 左端から **`ActivityBar` 最上部**へ移動（VS Code 風の「縦の ActivityBar 系操作＝サイドバー表示制御」メンタルモデルに統一）。`ActivityBar.tsx` は `useSidebarContext()` で `isOpen`/`toggle` を取得し、トグルを `role="tablist"` の**外側**に配置（既存の roving-tabindex Arrow/Home/End ナビと WAI-ARIA tab 数に非干渉）、`Tooltip content="Toggle sidebar"`・`data-testid="activity-bar-toggle-sidebar"`・`aria-label`/`aria-expanded`・separator を追加。`WorktreeDetailSubComponents.tsx` の `DesktopHeader` からハンバーガー＋区切り線を物理削除し `onMenuClick` を optional 化、`WorktreeDetailRefactored.tsx` から `onMenuClick={toggle}` と未使用化した `toggle` 分割代入を除去。モバイル経路（`MobileHeader`/`openMobileDrawer`）は無改修 (Issue #747)
- refactor(terminal): PC版で top-level の History カラムを撤去（History は各ターミナル split 内へ移管／Issue #744）。`TerminalContainer.tsx` の `history` prop を optional 化し、未指定時（PC default）は terminal エリアのみを描画（`useHistoryPaneState`/`HISTORY_PANE_ID`/expand bar・PaneResizer は history 提供時のみ＝後方互換）。`WorktreeDetailRefactored.tsx` から `historyPaneMemo` と `HistoryPane`/`useHistoryPaneState`(top-level) import を削除し、`<TerminalContainer terminal={rightPaneSplitMemo} />` へ簡素化。`renderSplitPane` で各 split に History 表示系 props（`historyUserOnly`/`historyDisplayLimit`/`showArchived` 共通値、`onFilePathClick`/`showToast`、splitIndex 直指定の `onHistoryInsertToMessage`）を配布。`#735` の `data-testid="history-pane-expand"` は history 提供時のみ残置（PC default では非描画）。Mobile 経路は `MobileContent` 内の HistoryPane を継続使用で無改修 (Issue #744)
- refactor(terminal): `state.terminal.*` reducer slice を完全削除し、Mobile 経路を `useTerminalPanePolling` に移行（#728 R3-007 + R3-010）。`WorktreeDetailSubComponents.tsx` に `MobileTerminalTab`（terminal タブ表示時のみ hook をマウント、cliToolId 変化で self-reset）を新設し、`MobileContent` の `terminalOutput`/`isTerminalActive`/`isThinking`/`autoScroll`/`onScrollChange` props を `cliToolId` 1 本に置換。`src/types/ui-state.ts` から `TerminalState` 型 / `initialTerminalState` / `WorktreeUIState.terminal`、`src/types/ui-actions.ts` から `SET_TERMINAL_OUTPUT`/`SET_TERMINAL_ACTIVE`/`SET_TERMINAL_THINKING`/`SET_AUTO_SCROLL` + 未使用の複合 action `START_WAITING_FOR_RESPONSE`/`RESPONSE_RECEIVED`/`SESSION_ENDED`、`useWorktreeUIState.ts` から対応する reducer case / action creator / `WorktreeUIActions` member を削除。`WorktreeDetailRefactored.tsx` 親側の terminal 参照を移行（親ポーリング cadence gate と `MessageInput isSessionRunning` を `worktree.sessionStatusByCli[activeCliTab].isRunning` 由来に切替、`fetchCurrentOutput` の terminal 書き込み除去・prompt/selection/Auto-Yes は維持、worktreeId reset / CLI タブ切替 / `handleKillConfirm` の terminal リセットと未使用 `handleAutoScrollChange` を除去）。PC 経路の挙動は不変。`WorktreeDetailRefactored-cli-tab-switching.test.tsx` を `useTerminalPanePolling` モックベースに完全書き直し（R3-010、CLI 切替時の hook re-key を明示検証）、`useWorktreeUIState.test.ts` の terminal slice / 複合 action assertion を削除・slice 不在の回帰テストを追加 (Issue #736)
- Layout (PC): `WorktreeDesktopLayout` を 4 カラム→**2 カラム**（ActivityPane + Right=TerminalContainer）に簡素化。`activityBar` / `historyPane` / `historyPaneCollapsed` / `onToggleHistoryPane` / `onHistoryPaneResize` / `historyPaneWidth` props を削除。`HISTORY_PANE_ID` は `TerminalContainer` に移管。dead code だった `MobileLayout` fallback（`useIsMobile=true` 時は `WorktreeDetailRefactored.tsx:1700` の `MobileContent` 分岐済みのため非経由）を削除。ファイル行数 437→145 (Issue #730)
- Layout (PC): `WorktreeDetailRefactored` の JSX 構造を再構成。`ActivityBar` を `WorktreeDesktopLayout` の外側に配置し、Header の下から画面下端まで貫通する VS Code 流レイアウトに変更。`WorktreeDesktopLayout` の `rightPane` に `<TerminalContainer history={historyPaneMemo} terminal={rightPaneMemo}/>` を渡す構造へ (Issue #730)
- Layout (PC): `ActivityBar` の各 `<button>` から `title` 属性を削除し、新しい `Tooltip` コンポーネントでラップ。`aria-label` は維持。`buttonRefs` は `<button>` への ref を継続付与（ref 透過のため `ArrowUp/Down/Home/End` キーボードナビは無変更で動作）(Issue #730)
- Hook: `useHistoryPaneState` の `DEFAULT_HISTORY_WIDTH` を **25 → 40** に変更。percent 基準が「`WorktreeDesktopLayout` 全体」から「`TerminalContainer` 内 (Right Pane)」に変わるための補正 (Issue #730)
- Layout (PC): `WorktreeDesktopLayout` を 2 カラム→**4 カラム**（`[ActivityBar 48px] + ActivityPane + History + Right`）に再構成。`leftPane` props を廃止し `activityBar` / `activityPane` / `historyPane` / `rightPane` 構造へ。`ResizableColumn` ヘルパーで activity/history カラム JSX を dedup。モバイル時は 2-pane swipe へ縮退 (Issue #727)
- WorktreeDetailRefactored: 旧 `leftPaneMemo`（38 deps、Issue #411 R3-007）を `activityBarMemo` / `activityContent` / `activityPaneMemo` / `historyPaneMemo` に分割。各 memo にメンテナンスコメント付与。`useFilePolling` の `enabled` 条件を `state.layout.leftPaneTab === 'files'` → `activeActivity === 'files'` に置換 (Issue #727)
- HistoryPane: `onCollapse` props 追加、ヘッダー右端に `<` 折りたたみボタン追加 (Issue #727)
- Config: `TEXT_MAX_SIZE_BYTES` を 1MB → **2MB** に引き上げ。`.md` / `.yaml` / `.yml` の PUT/GET 共通定数として一元化 (Issue #723)
- FileViewer: 検索ロジックを `useFileContentSearch` に統一（旧 `content.split('\n')` + 同期 `toLowerCase().includes` のインライン実装を撤去） (Issue #723)
- History: HistoryPaneのUser/Assistant視覚優先度を改善。Assistantメッセージのデフォルト折りたたみを2行/100文字に強化（COLLAPSED_MAX_LINES: 5→2、COLLAPSED_MAX_CHARS: 300→100）、Assistantスタイル弱化（text-xs/p-2/bg-gray-900/30、space-y-2）、User側コンテナに防御セット（`[word-break:break-word]` `max-w-full` `overflow-x-hidden`）追加 (Issue #725)

### Removed
- `WorktreeDesktopLayout.tsx` 内の `MobileLayout` コンポーネント定義と `HistoryExpandBar` を削除（dead code: `WorktreeDetailRefactored.tsx:1700` で `MobileContent` 分岐済みのため `WorktreeDesktopLayout` を経由しない）。関連テスト `tests/unit/components/WorktreeDesktopLayout.test.tsx` の Mobile fallback ブロックも削除 (Issue #730)
- `src/components/worktree/LeftPaneTabSwitcher.tsx` を削除（Activity Bar に置換）。関連テスト `tests/unit/components/worktree/LeftPaneTabSwitcher.test.tsx` / `tests/unit/types/left-pane-tab.test.ts` も削除 (Issue #727)
- PC 版 History ペイン内の `Message | Git` サブタブ UI を除去（Git は独立 Activity に昇格）。`historySubTab` ローカル state はモバイル経路 `MobileContent` props 伝播のため残置 (Issue #727)

### Performance
- FilePanel: 大規模ファイルでPC版がハングする問題に対するハイブリッド対応（行ベースAPI ＋ `@tanstack/react-virtual` 仮想化 ＋ 編集系2MBサイズ上限）。CodeViewer は `useVirtualizer` で可視範囲＋オーバースキャンのみマウントし、行範囲モード（`startLine`/`endLine` クエリ）でチャンク取得・ハイライトキャッシュを実装。サーバ側は `readFileLineRange` で `createReadStream`＋`readline` ストリーミング（メモリ O(チャンク)）。`useFileContentSearch` に debounce 300ms＋最小2文字、`useFileContentPolling` に大ファイル時無効化（`POLLING_DISABLED_THRESHOLD_BYTES = 1MB`）を追加 (Issue #723)

### Fixed
- Terminal (PC): ターミナル分割を `+Split` で増やした後 `-Split` で戻すと、本来全幅に戻るべきターミナルが 50% 幅で残り右側が空きスペースになる問題を修正（#728 follow-up）。`useTerminalSplits` の `removeSplit` が末尾 width を切り捨てるだけで再正規化せず合計が 1.0 未満（例 `[0.5,0.5]`→`[0.5]`）となり、CSS `flex-grow` 合計 < 1 で free space が配分されないことが原因。`normalizeWidths` ヘルパーを追加し `removeSplit` 後とロード時（`isValidSplitConfig` 通過後）に widths を比率保持のまま合計 1.0 へ正規化。既存ユーザーの localStorage に残った不正状態（`widths=[0.5]` 等）もロード時に自己回復。`widthsValid`/`isValidSplitConfig` の仕様・モバイル経路・公開 API は無変更 (Issue #739)
- Layout (PC): `min-w-0` 欠落により PC 版でファイル選択時に FilePanel が viewport 外へ押し出され隠れる問題を修正（#730 follow-up）。`WorktreeDetailRefactored.tsx` の外側 2 flex コンテナ（L1740 主因 / L1763 防御的補強）に `min-w-0` を追記し、Flexbox の `min-width: auto` 既定によって flex item がコンテンツ最小幅以下に縮まずレイアウトが viewport を超えて膨張する問題を解消。CSS クラス追記のみでロジック・props・公開API・モバイル経路は無変更 (Issue #732)

### Breaking Changes
- **Layout (PC) BREAKING (Issue #730)**: PC デスクトップで `ActivityBar` が `WorktreeDesktopLayout` の外側に出て VS Code 風に全高貫通（Header の下から画面下端まで）し、History が `TerminalContainer` 内の左サブパネルに移動します。視覚的な影響:
  - `?pane=history` deep link の History 表示位置が「画面中央の独立列」→「画面右端 Terminal 領域内」に変わります（表示の意味は維持されます）
  - `DEFAULT_HISTORY_WIDTH` の意味が「`WorktreeDesktopLayout` 全体に対する %」→「`TerminalContainer` 内 Right Pane に対する %」に変わり、既定値も 25 → **40** に変更。既存ユーザの localStorage 値（25 等）はそのまま使われ続けるため、初回は狭めに見える可能性あり
  - `WorktreeDesktopLayout` の props API が破壊的に変更: `activityBar` / `historyPane` / `historyPaneCollapsed` / `onToggleHistoryPane` / `onHistoryPaneResize` / `historyPaneWidth` の 6 props を削除。残る公開 props は `activityPane` / `rightPane` / `activityPaneWidth` / `onActivityPaneResize` / `minPaneWidth` / `maxPaneWidth`
  - モバイル経路は変更なし（`MobileContent` 経由のまま）。詳細仕様: Issue #730
- **Layout (PC) BREAKING**: PC デスクトップの左パネルが「History/Files/CMATE タブ式 2 カラム」から「Activity Bar + Activity Pane + History 独立カラム + Right の 4 カラム」へ視覚的に変更されます。モバイル経路（`GlobalMobileNav` / `WorktreeDetailSubComponents` / `NotesAndLogsPane`）は変更なし。旧 localStorage キー `commandmate.worktree.leftPaneCollapsed` は読み捨て（マイグレーション処理なし）。詳細仕様: Issue #727
- 編集系ファイルの GET 事前ガード追加: `.md` / `.yaml` / `.yml` の GET 上限が新規 **2MB** になりました。
  - 2MB 以下: 従来通り開け、保存も可能（改善: 旧来 1MB 超は PUT 失敗していたが 1〜2MB 帯が保存可能に）。
  - 2MB 超: GET 時点で `FILE_TOO_LARGE` (HTTP 413) を返却し、ファイルが開けなくなります。
  - 既にタブで開いている 2MB 超ファイルは、ポーリング再フェッチ時に 413 を受け取り、エラー表示に切り替わります。
  - HTML (`.html` / `.htm`) は本変更の対象外で、既存 5MB ガード（Issue #490）を維持します。
  - 2MB 超の編集系を扱う必要がある場合は、ファイル分割または将来の閲覧専用モードフォールバック（別 Issue で検討）をご利用ください (Issue #723)

## [0.5.8] - 2026-05-28

### Added
- History: Worktree詳細 HistoryPaneにメッセージテキスト検索機能を追加（名前空間分離CSS Custom Highlight API、debounce/最小2文字/最大500件） (Issue #716)
- History: 履歴(History)表示件数を50〜250件で選択可能にする（HistoryDisplayLimitセレクタ・localStorage永続化） (Issue #701)

### Fixed
- Executor: execFile maxBufferエラー（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）の診断ログを改善し上限を10MBに引き上げ (Issue #719)
- Files: ファイルツリー再フェッチ時のスクロール位置を保持（非破壊的refetch indicator・retryボタン追加） (Issue #706)
- Detection: Claude Code v2.1.142 スキル承認プロンプトの末尾サマリ行（"… +1 pending"）の誤検出を修正（SUMMARY_LINE_PATTERN/フッタトリミングの多層防御） (Issue #704)

### Performance
- DB: chat_messagesにrole列を含む複合インデックス（idx_messages_worktree_role_archived_time）を追加し相関サブクエリの線形劣化を解消（Migration v32） (Issue #708)
- Sidebar: useWorktreesCacheをWorktreesCacheProvider Context経由に統合しポーリングの二重起動を解消 (Issue #709)
- Sidebar: active/idle遷移時のポーリング間隔（5s/30s）をアダプティブに更新するよう修正 (Issue #710)
- Sync: scanMultipleRepositoriesをPromise.allSettledで並列化しsync APIのスケーラビリティを改善 (Issue #711)

## [0.5.7] - 2026-05-11

### Added
- Worktree: PC版Worktree詳細ビューに左パネル折りたたみ機能を追加 (Issue #688)
- Repository: サイドバー表示制御用のリポジトリ可視性トグルを追加 (Issue #690)
- MessageHistory: メッセージタイムスタンプに日付+時刻を表示 (Issue #687)
- CLI: STANDARD_COMMANDSを最新のClaude CodeおよびCodexコマンドに更新 (Issue #689)

### Fixed
- Sidebar: ブランチホバー時のリスト並び替えフラッシュを解消（useDeferredValue + ref-only freeze方式） (Issue #699)
- Sidebar: リポジトリグループ順序をキャッシュしてホバー時の並び替えを防止 (Issue #699)
- Sidebar: ブランチクリック後のツールチップ表示によるリスト再描画チラつきを抑制 (Issue #699)
- Sidebar: startTransitionでポーリング更新をラップしフラッシュを防止 (Issue #699)
- Sidebar: ドキュメントクリック時に古いツールチップを閉じるよう修正 (Issue #699)
- Sidebar: 選択済みブランチのスタックしたツールチップをリセット (Issue #699)
- Worktree: 狭い幅でのパネルトグルUXを改善しファイルパネル折りたたみを追加 (Issue #698)
- HtmlPreview: 未使用のonDirtyChange propを除去しリグレッションテストを追加 (Issue #681)
- Tests: クロステスト汚染によるBranchListItemツールチップテスト失敗を修正

### Refactored
- FileTab: useFileTabsの戻り値を[state, actions]タプル形式に変更 (Issue #683)
- Sidebar: サイドバー可視性ヘルパーを抽出しact()警告を修正 (Issue #690)

## [0.5.6] - 2026-04-27

### Added
- PDF: PDFファイルプレビュー機能を追加（Blob URL + iframe sandbox方式） (Issue #673)

### Fixed
- PDF: 実際のChrome（デスクトップ・モバイル）でPDFプレビューが動作するよう修正 (Issue #673)
- Sidebar: ブランチ切り替え時にツールチップが固定表示される問題を修正 (Issue #676)
- Worktree: 再レンダリングループによってworktree URL更新がブロックされる問題を修正 (Issue #675)
- Proxy: External AppsへのWebSocket upgradeをプロキシで中継するよう修正 (Issue #671)
- Proxy: プロキシ応答から `content-encoding` / `content-length` ヘッダを除去

### Refactored
- PDF: `normalizeExtension` の共有化と冗長コメントの整理 (Issue #673)

## [0.5.5] - 2026-04-17

### Added
- Assistant: Home画面に非インタラクティブなClaude/Codex対応のアシスタントチャット機能を追加 (Issue #649)
- Assistant: 専用Chatタブを追加し、commandmate CLI起動とスクリプト起動をコンテキストで区別 (Issue #649)
- Sidebar: PC用サイドバーをw-56にコンパクト化しツールチップで詳細表示 (Issue #651)
- Sidebar: ブランチ間ナビゲーション時にスクロール位置を保持 (Issue #651)
- Sidebar: ブランチツールチップで説明文全文を表示 (Issue #651)
- Sidebar: サイドバー背景の差別化とDnDによるグループ並び替えを追加 (Issue #651)
- Memo: CMATE Notesの上限を5件から10件に拡張 (Issue #652)

### Fixed
- Assistant: ドロップダウンの高さを揃えコントロール配置を修正 (Issue #649)
- Sidebar: コンパクト化後のリサイズ・ツールチップ・オーバーフロー問題を修正 (Issue #651)
- Sidebar: ドラッグリサイズのラグとグループヘッダー下線を除去 (Issue #651)
- Sidebar: ブランチ高速クリック時のフルページリロードを防止 (Issue #651)
- Sidebar: アンマウント時にフォールバックタイマーをキャンセル (Issue #651)
- Sidebar: フルページリロードを誘発していたフォールバックタイマーを除去 (Issue #651)
- Sidebar: group-orderルートに dynamic export を追加し静的キャッシュを回避 (Issue #651)

### Refactored
- Assistant: インストール済みツールAPIを追加しCLIツールセレクタのUXを改善 (Issue #649)
- Sidebar: BranchTooltipサブコンポーネントを抽出し保守性コメントを整理 (Issue #651)
- Memo: MemoPaneのimport順を統一 (Issue #652)

### Style
- Assistant: AssistantChatPanelのUIレイアウトとビジュアルデザインを調整 (Issue #649)

### Tests
- Assistant: Chatタブおよびcontext-builder変更に合わせて既存テストを更新 (Issue #649)

## [0.5.4] - 2026-04-12

### Added
- Editor: YAMLファイル編集と拡張子選択ダイアログを追加 (Issue #646)
- DB: リポジトリにdisplay_name（カスタム別名）を追加 (Issue #642)
- Markdown: HTML imgタグの相対パスとwidth/height属性をサポート
- Upload: 画像アップロード上限を20MBに引き上げ、マークダウンビューアで相対画像パスを解決

### Fixed
- Detection: React error #31 と Claude `/model` 選択リスト検出を修正 (Issue #648)

### Refactored
- Editor: ファイル編集機能のコード品質改善 (Issue #646)
- Repository: display_name保存時のエラーメッセージ解決ロジックの重複排除 (Issue #644)

### Tests
- Test: ファイルサイズテストを5MBから20MBに更新し設定変更に追従

## [0.5.3] - 2026-04-05

### Added
- Report: レポート生成ステータスをUIとCLIで可視化 (Issue #638)
- CLI: `report` コマンドを追加（日次レポートの生成・表示・一覧表示） (Issue #636)
- Report: 日次レポートのプロンプトにGitHub Issueコンテキストを追加 (Issue #630)
- Report: 日次レポート生成にコミットログ収集を追加 (Issue #627)

### Fixed
- Report: ステータスエンドポイントのdynamic renderingを強制 (Issue #638)
- Report: セクション別プロンプト長制限でcommit_logとissue_contextを保持 (Issue #634)
- Report: コミットログ収集前に無効なリポジトリをフィルタリング (Issue #632)
- Codex: daily summary生成にツール固有パーミッションを使用 (Issue #626)

### Refactored
- Utils: JSDocの関連付け修正とタイムアウトユーティリティの整理 (Issue #627)

## [0.5.2] - 2026-04-04

### Added
- Review: レポートテンプレート機能を追加し、CRUD API と 3 モード生成UIを実装 (Issue #618)
- Report: レポート本文のコピーボタンを追加

### Fixed
- Codex: `/model` Step 1 のモデル選択UIを selection list として検出 (Issue #622)
- Codex: `/model` 選択UIを waiting status として検出 (Issue #619)
- Detection: Codex Reasoning Level UI を `multiple_choice` prompt と `submitMode` 対応で処理

### Refactored
- Template API: 共有ヘルパーを抽出して重複を削減 (Issue #618)
- Prompt handling: `SubmitMode` バリデーションヘルパーを抽出して重複を削減 (Issue #616)

## [0.5.1] - 2026-04-02

### Added
- Report: ユーザー指示入力とUI改善 (Issue #612)
- Daily Summary: デイリーサマリー機能の実装 (Issue #607)
- Sessions: ソートオプションとメッセージプレビューを追加 (Issue #606)

### Fixed
- Sessions: デフォルトソートを「最終送信（新しい順）」に変更
- Sessions: 表示順をリポジトリ名→ブランチ名の順に変更
- Sidebar: セッションフラグからworktreeステータスを導出し、適応型ポーリングを追加 (Issue #608)
- Status: キャプチャ行数統一によりスピナーがreadyで停止する問題を修正 (Issue #604)

### Refactored
- Daily Summary / Sessions: ヘルパー関数を抽出し重複を削減
- Sessions: sanitizePreviewを共有configモジュールに抽出

## [0.5.0] - 2026-04-02

### Added
- UX Refresh: 5画面構成（Home / Sessions / Repositories / Review / More）への全面リニューアル (Issue #600)
  - Phase 1: Foundation（共通フック、キャッシュプロバイダー、レイアウト設定）
  - Phase 2: Screen framework（Sessions / Repositories / Review / More画面、モバイルグローバルナビ）
  - Phase 3: Deep link、API拡張、Review stalled検出
  - Phase 4: 統合・デモGIF更新・動画アップロード上限100MB
- UX: ステータスシステム刷新とReviewページフィルター (Issue #600)
- UI: WorktreeDetailHeaderにPC用Homeリンクを追加 (Issue #600)

### Fixed
- Worktree: stale CLI tab responsesのガード処理 (Issue #602)
- Gemini: ステータススピナーの不一致を修正
- Gemini: スラッシュコマンドの復元
- Commands: Codex共有スラッシュコマンドの表示修正
- CI: lint/テストエラーの修正 (Issue #600)

### Docs
- UX Refresh設計レポート・CLAUDE.md更新 (Issue #600)

## [0.4.16] - 2026-04-01

### Added
- Navigation: add Left/Right keys to NavigationButtons for Copilot TUI (Issue #592)

## [0.4.15] - 2026-03-31

### Added
- Schedule: allow Copilot model selection in CMATE schedule CLI Tool column (Issue #588)
- Schedule: add Copilot CLI permission flag support for CMATE schedules (Issue #584)
- Schedule: expose active schedule state
- Commands: add current-situation, cause-analysis commands and update orchestrate for bug workflow
- Commands: add Codex cross-review to multi-stage review commands

### Fixed
- Slash commands: prevent Copilot builtins from overriding Claude standard commands (Issue #586)
- Schedule: recover inactive schedule cron jobs
- Schedule: stop cron job when schedule is disabled via Enabled=false
- Commands: correct agent assignment rules in orchestrate command
- Scripts: add .env auto-loading to all shell scripts
- Schedule: add missing new files for Copilot model selection (Issue #588)

### Docs
- Add Copilot model selection syntax to CMATE schedules guide (ja/en)

## [0.4.14] - 2026-03-29

### Added
- CLI: `--model` option for `send` command to support Copilot model switching (Issue #576)
- Copilot: TUI response handling with deduplication and accumulated content saving (Issue #565)
  - `extractCopilotContentLines` / `normalizeCopilotLine` in tui-accumulator
  - Copilot-specific branching in response-extractor
  - Prompt deduplication with SHA-256 hash cache (`prompt-dedup.ts`)
  - Copilot timing constants (`copilot-constants.ts`)
- WSL2: Windows environment support with setup guide and troubleshooting (Issue #551)

### Fixed
- Copilot: extract latest response only in `cleanCopilotResponse` (Issue #571)
- Copilot: clean up History redundant display (Issue #571)
- Copilot: add TUI decoration skip patterns to `COPILOT_SKIP_PATTERNS` (Issue #565)
- Copilot: fix message sending, selection list detection, and pane size (Issue #565)
- tmux: set explicit window size on session creation to fix TUI display (Issue #565)
- Timer: show all tools including copilot in agent selector
- CLI: add copilot to `--agent` help text in send/respond/capture/auto-yes commands
- Test: mock `sendSpecialKey` in base.test.ts to prevent unhandled rejection

### Refactored
- Module split: split large modules into sub-files, Phase 1 (Issue #575)
- Security: unify security comment identifiers and strengthen input sanitization (Issue #574)
- Type safety: remove dangerous type casts and improve silent failure handling (Issue #573)
- DB: remove deprecated forwarding files and unify import paths (Issue #550)
- Copilot: improve naming clarity and remove redundant code
- Test: fix assertion format and indentation in ip-restriction tests
- Test: remove unused imports in db-toValidAppType test
- Test: use `vi.stubGlobal` for NODE_ENV assignment in api-client test

### Changed
- chore: bump vitest 4.1.1 → 4.1.2

## [0.4.13] - 2026-03-28

### Added
- Copilot: GitHub Copilot CLI tool support with gh-based command and 2-stage install check (Issue #545)
  - CopilotTool class, CLI_TOOL_IDS/display names updated to 6 tools
  - Copilot patterns, response cleaning, and completion detection
  - GH_DEBUG added to env-sanitizer sensitive keys
- Copilot: builtin slash commands (46 commands) and selection list detection (Issue #547)
  - COPILOT_SELECTION_LIST_PATTERN for detecting selection UIs
  - getCopilotBuiltinCommands() with 'builtin' source type
  - SELECTION_LIST_REASONS Set for unified selection list handling
- Worktree info: copy-to-clipboard for Path and Repository Path fields (Issue #552)
- Mobile: default to preview tab in mobile markdown viewer (Issue #549)

### Fixed
- Copilot: delegate slash commands to sendMessage for prompt-aware execution (Issue #559)
- Copilot: use sendKeys directly in terminal and send APIs to avoid waitForPrompt blocking
- Copilot: fix prompt detection pattern to match "❯ " with trailing hint text
- Copilot: improve thinking detection ("Esc to cancel") and selection list patterns
- Copilot: prevent /model text leaking into selection list search field
- Mobile: enable vertical scrolling on mobile file list (Issue #548)
- Mobile: fix file list overflow hidden behind input bar with increased paddingBottom
- Navigation: improve selection list button responsiveness with immediate refresh after key send

### Refactored
- Test: improve mobile overflow test robustness with MobileContent-anchored regex matching

## [0.4.12] - 2026-03-24

### Added
- Timer: delayed message sending feature with configurable delay times (Issue #534)
  - `timer-constants.ts` with dynamic delay generation
  - `timer-db.ts` with full CRUD operations and cursor-based pagination
  - `timer-manager.ts` with globalThis singleton and setTimeout management
  - Timer API route (POST/GET/DELETE) with security validations
  - `TimerPane.tsx` with countdown, polling, and visibilitychange support
  - Timer sub-tab in NotesAndLogsPane
- Timer: session check before timer execution with NO_SESSION status (Issue #539)
  - `isRunning()` check to detect no-session state
  - Session warning in POST API response and UI
- Timer: history limit, pagination, and automatic cleanup (Issue #540)
  - Cursor-based pagination with configurable limits
  - Automatic cleanup of old timers on startup (30-day retention)
  - Recovery of stuck sending timers
  - "Load more" and "Clear history" UI controls

### Fixed
- Timer: add agent selector to TimerPane registration form (#538)
- Timer: fix flaky cleanupOldTimers boundary test with fixed timestamps

### Refactored
- Timer: extract MAX_TIMER_MESSAGE_LENGTH and TIMER_COLUMNS constants for DRY compliance
- Timer: optimize stopTimersForWorktree to use in-memory map instead of DB query
- Timer: extract startIntervals/stopIntervals helpers in TimerPane to eliminate duplication

## [0.4.11] - 2026-03-21

### Added
- Auto-Yes: per-agent composite key support for independent Auto-Yes control per agent (Issue #525)
- Auto-Yes: per-agent UI controls with agent name display in AutoYesToggle
- Session history: retain message history after session clear with archived toggle (Issue #168)
  - Logical deletion (archived column) instead of physical DELETE
  - `showArchived` toggle in HistoryPane with localStorage persistence
- CLI: `/orchestrate` command for parallel issue development lifecycle
- CLI: `/pr-merge-pipeline` command for PR creation through merge automation
- CLI: `/uat-fix-loop` command for UAT failure repair cycle automation

### Fixed
- Sync: clean up orphaned tmux sessions when worktrees are deleted during sync (Issue #526)
- Auto-Yes: separate per-agent auto-yes state in UI to avoid stale display on tab switch
- Auto-Yes: fix disable-all to properly disable all agents (not just default claude)
- Test: make session-cleanup tests resilient to mock reset timing in CI
- bin/commandmate.js: add execute permission

### Refactored
- Logging: standardize logger action strings to `module:action` format
- Auto-Yes: extract `filterCompositeKeysByWorktree` shared utility for DRY compliance
- Auto-Yes: rename state/poller ID functions to `CompositeKeys` for naming clarity
- Release skill: use git worktree + commandmatedev delegation

## [0.4.10] - 2026-03-19

### Added
- CLI: implement base commands for agent orchestration — ls, send, wait, respond, capture, auto-yes (Issue #518)
- CLI: add sessionStatus to wait completion detection (Issue #520)
- Docs: CLI operations guide (Japanese and English)

### Fixed
- MARP: prevent slide reset on file content polling
- CLI: improve timeout and elapsed time display

## [0.4.9] - 2026-03-16

### Added
- Sidebar: branch sync button to sidebar header (Issue #506)
- Sidebar: colored folder icons for repository group headers (Issue #504)
- File panel: in-file link navigation and tab UI improvements (Issue #505)
- Mobile: open external links from HTML preview in new browser tab (Issue #505)

### Fixed
- Auto-Yes: prioritize prompt detection over thinking check
- Auto-Yes: prevent dual response and status instability (Issue #501)
- Auto-Yes: prevent client-side duplicate response when server poller is active
- File panel: tab overflow, dropdown click, and link handling issues (Issue #505)
- Markdown preview: stabilize DOM to make links clickable (Issue #505)
- Message list: stabilize ReactMarkdown plugin arrays and callback refs
- Sidebar: replace color dot with colored folder icon for repository identification
- Sync: include DB-registered repositories in worktree sync

### Performance
- Auto-Yes: implement 7-item polling performance improvements (Issue #499)

### Refactored
- Sidebar: improve parseGroupCollapsed testability and add comprehensive tests

## [0.4.8] - 2026-03-14

### Added
- HTML file rendering in file panel with sandboxed iframe preview (Issue #490)
  - `HtmlPreview` component with configurable sandbox levels
  - HTML extension detection config
- Insert-to-message from history and memo cards (Issue #485)
  - Copy content directly into message input from ConversationPairCard and MemoCard
- Codex custom skills loader from `.codex/skills/` directory (Issue #166)
  - Codex custom prompts and `.system` skills support
  - Slash command format utility

### Fixed
- Prompt detector: detect long confirmation prompts with commit messages
- Prompt detector: prevent diff line numbers from corrupting Codex prompt detection
- Status detector: detect Codex TUI idle prompt above padding gap
- Codex: improve TUI status detection and prompt detection
- HTML preview: force iframe re-mount on sandbox level change

## [0.4.7] - 2026-03-13

### Added
- OpenCode TUI selection list navigation support (Issue #473)
  - Detect prompt state in OpenCode TUI content area
  - NavigationButtons for TUI selection lists
- Image file attachment for message input (Issue #474)
  - Image attachment UI integrated into MessageInput
  - Mobile: split message input into two rows
- Claude CLI selection list prompt detection with NavigationButtons

### Fixed
- OpenCode: selection list pattern, mobile layout overlap, and button responsiveness
- Build: remove logger imports from auth.ts and selected-agents-validator (client bundle compatibility)
- Logger: fix remaining console.error in conversation-logger

### Refactored
- Logger: migrate console.log/warn/error to structured logger (#480)
- TODO/FIXME markers cleanup (#482)
- Large file splitting into smaller modules (Issue #479)
  - Phase 1: split schedule-manager, FileTreeView, MarkdownEditor
  - Phase 2: split 5 large files into smaller modules
  - Phase 3: split db.ts and response-poller.ts
- lib/ directory restructuring (Issue #481)
  - Phase 1-7: reorganize into db/, tmux/, security/, detection/, session/, polling/, git/ groups
  - Add @deprecated compatibility layer for old import paths

## [0.4.6] - 2026-03-11

### Added
- File auto-update polling for external change detection (Issue #469)
  - `useFilePolling` hook with visibility-change lifecycle management
  - `useFileContentPolling` hook with If-Modified-Since/304 support
  - `useFileContentSearch` shared search hook
  - `FileSearchBar` shared component
  - `file-polling-config.ts` for polling interval constants
  - File tree and content auto-refresh when agent modifies files

### Fixed
- Auto-Yes: add retry expiry to prevent permanent duplicate prompt blocking
- Codex: detect approval prompts with wrapped preview lines
- Codex: handle long wrapped approval options
- Sidebar: add fallback navigation when Next.js router.push silently fails

### Refactored
- File panel: extract duplicated search logic into shared hook and component

## [0.4.5] - 2026-03-10

### Added
- Persist active CLI tool tab selection via localStorage

### Fixed
- Codex: detect approval prompts by expanding detection window and skipping collapsed lines
- Codex: skip update notification instead of triggering npm install
- Codex: polling-based init with trust dialog and update notification handling

### Performance
- Parallelize CLI tool status detection, git commands, and initial data fetch

## [0.4.4] - 2026-03-10

### Added
- tmux control mode transport for live terminal interaction (Issue #460)
  - `SessionTransport` interface abstraction
  - `PollingTmuxTransport` wrapping existing send-keys/capture-pane
  - `ControlModeTmuxTransport` with live output streaming via WebSocket
  - `TmuxControlClient`, `TmuxControlParser`, `TmuxControlRegistry`
  - Terminal page migration to control-mode streaming
  - Feature flag (`tmux-control-mode-flags.ts`) and metrics tracking

### Fixed
- Gemini CLI model selection dialog detection with description lines between options
- Codex prompt detection: skip unreasonably large option numbers
- OpenCode: use full output for prompt detection to support long prompts
- OpenCode: strip scrollbar character in stripBoxDrawing for status detection
- Gemini CLI: strip ANSI codes and wait for prompt before sending messages
- Prompt detector: tolerate garbage prefix and single-gap in option detection
- CLI patterns: support new Gemini CLI prompt format with placeholder text
- Prompt detector: tolerate garbage chars between indicator and option number
- Prompt detector: handle missing period in tmux capture-pane option lines

### Changed
- docs: reposition CommandMate as "a local control plane for agent CLIs" instead of "IDE for issue-driven AI development" (#457)
  - Updated README.md hero copy, sub copy, and section ordering
  - Updated docs/ja/README.md with corresponding Japanese translations
  - Updated package.json description and keywords
  - Updated src/app/page.tsx hero copy

## [0.4.3] - 2026-03-08

### Fixed
- Reset hljs padding in CodeViewer to fix line height issue

## [0.4.2] - 2026-03-08

### Added
- Terminal text search with highlight and navigation (Issue #47)
  - TerminalSearchBar component with match count and prev/next buttons
  - File content search with line highlighting in file panels
  - Mobile search UX with overlay highlight and header buttons
- Git tab with commit history and diff viewer (Issue #447)
  - GitPane with commit log, diff display, and collapsible sections
  - Git API endpoints (log, diff, show)
- Sidebar repository-based grouping with collapse/expand (Issue #449)
  - useLocalStorageSync hook extraction
- File content search in PC file panel (Issue #47)
- Default selected agents changed to include Gemini (claude, codex, gemini)

### Fixed
- Sidebar branch name alignment regardless of agent count
- Mobile CLI tool tabs limited to 2 agents
- Mobile agent selection clamped to maxAgents (max 2)
- File viewer line number alignment on mobile with table layout

### Changed
- Detailed module descriptions extracted from CLAUDE.md to docs/module-reference.md
- Branch strategy documentation updated to include develop branch

## [0.4.1] - 2026-03-06

### Added
- Tabbed split file panel replacing desktop file viewer modal (Issue #438)
  - Code highlighting, MARP slide rendering, fullscreen mode, path copy
  - Line numbers in code viewers and markdown editor
  - File tab persistence to localStorage per worktree
  - Content copy buttons for file panels
- Show description next to branch name in PC header
- Persist draft message input across worktree switches
- Allow up to 4 agents on PC, keep 2 on mobile

### Fixed
- File panel XSS, sandbox escape, and edge case hardening (Issue #438)
- Encode file paths and reset MARP slide state
- Center placeholder text vertically in message input

### Changed
- Move CLI tool tabs into terminal pane header (Issue #438)
- Move AutoYesToggle to CLI tool tab bar (Issue #438)
- Narrow left pane initial width for 1:2:2 layout ratio (Issue #438)
- Add --port option and stop guidance to rebuild skill

## [0.4.0] - 2026-03-05

### Added
- Comprehensive dark mode support (Issue #424)
  - Dark mode foundation with cyan accent migration
  - Mobile header, tab bar, detail views, sidebar, editor components
  - AutoYes toggle/confirm dialog, home, CMATE tabs, slash commands, navigation
- Resource leak prevention for long-running servers (Issue #404)
- Tmux capture cache with TTL, singleflight, and N+1 elimination (Issue #405)
- Schedule sync performance with mtime caching and batch upsert (Issue #409)
- Server log rotation in build-and-start.sh (Issue #403)

### Changed
- README repositioned around issue-driven AI development messaging (Issue #433)

### Fixed
- Process stop logic hardened with PID validation and graceful shutdown (Issue #401)
- Dark mode text contrast in AutoYes confirm dialog (Issue #424)
- Dark mode support for MobilePromptSheet

### Performance
- Async-ify CMATE parser synchronous I/O to unblock event loop (Issue #406)
- Dynamic import for TerminalComponent and MarkdownEditor (Issue #410)
- React memo/useCallback/useMemo to prevent unnecessary re-renders (Issue #411)
- Suppress duplicate prompt-detector log output (Issue #402)
- Status detector promptDetection caching (Issue #408)

## [0.3.6] - 2026-03-03

### Added
- LM Studio provider support for OpenCode configuration (Issue #398)
  - Parallel model fetching from Ollama and LM Studio
  - Dynamic provider configuration with zero-provider skip
- Auto-save mode toggle for Markdown editor (Issue #389)
  - 3-second debounce, save state indicator, error fallback

### Fixed
- Prevent credential leakage and same-origin trust break in proxy (Issue #395)
  - Sensitive request/response header filtering (cookie, authorization, CORS, CSP, etc.)
  - Internal URL information removal from WebSocket messages
- Prevent RCE/shell injection in terminal and capture APIs (Issue #393)
  - `exec()` → `execFile()` migration in tmux module (all 9 functions, 11 call sites)
  - Input validation for terminal/capture API endpoints
  - `sendSpecialKey()` with allowlist-based runtime validation
- Prevent symlink traversal in file APIs (Issue #394)
  - `resolveAndValidateRealPath()` with realpathSync-based defense
  - `checkPathSafety()` DRY helper for dual validation
- Prevent relative path bypass in clone customTargetPath validation (Issue #392)
  - `resolveCustomTargetPath()` wrapper with validateWorktreePath integration
- Polling overwriting checkbox state during agent settings editing (Issue #391)
  - `isEditing` state guard and `selectedAgentsRef` same-value skip
- Dark background fallback for unspecified-language code blocks (Issue #390)

## [0.3.5] - 2026-03-01

### Added
- OpenCode as 5th CLI tool with ICLITool implementation (Issue #379)
  - 2-layer TUI response capture for complete output (alternate screen handling)
  - ANSI/box-drawing stripping and extraction start fix
  - Slash commands, status detection, and response saving
  - Scroll to top button for terminal pane
  - `disableAutoFollow` for TUI-based tools
- QR code login for mobile access via ngrok (Issue #383)
  - `QrCodeGenerator` component with URL fragment-based token delivery
  - `useFragmentLogin` hook for automatic token extraction
  - Security hardening for QR login flow

### Fixed
- OpenCode response detection, `┃` stripping, and duplicate prevention
- OpenCode terminal scroll issues with TUI tools
- QR code S001 bypass, autoLoginError clearing, and URL trailing slash

## [0.3.4] - 2026-02-28

### Added
- vibe-local `--context-window` setting for Ollama context window size (Issue #374)
- AGENTS.md for Codex workflow guidance
- Cache-Control: no-store header to API routes

### Fixed
- Proxy route pathPrefix preservation for basePath-configured apps (Issue #376)
- Codex CLI prompt detection support (U+203A `›` indicator) (Issue #373)
  - Early prompt detection for Codex in response-poller
  - Prompt detection result carried through ExtractionResult to avoid truncated re-detection
  - TUI indentation and buffer reset handling
- Mobile safe-area-inset-top in fixed elements
- Mobile main content padding-top increased for header visibility
- Mobile CMATE tab header visibility on worktree page

## [0.3.3] - 2026-02-26

### Added
- Agent settings feature with multi-CLI tool support (Issue #368)
  - `AgentSettingsPane` component with checkbox UI for selecting up to 2 CLI tools
  - Gemini CLI support with interactive REPL mode and trust folder auto-handling
  - vibe-local (Ollama) CLI support with interactive REPL mode and model selection
  - `selected-agents-validator.ts` for agent selection validation
  - Dynamic terminal tabs based on selected agents
  - DB migration #19: `selected_agents` column in worktrees table
  - PATCH API for persisting agent selection per worktree
  - Ollama model list API (`/api/ollama/models`)
  - CMATE schedule execution support for Gemini and vibe-local
  - `stripBoxDrawing()` for Gemini CLI box-bordered prompt detection
  - CLI tool display names centralized via `getCliToolDisplayName()`

### Fixed
- Cache-Control: no-store header added to API routes
- Worktree patch validation and agent settings sync hardened
- Gemini CLI box-bordered prompt detection with `stripBoxDrawing()`

### Changed
- README optimized for GitHub star conversion
- Feature comparison tables updated with Token Authentication, Scheduled Execution, and Remote Control

## [0.3.2] - 2026-02-24

### Added
- CMATE schedule execution feature (Issue #294)
  - CMATE.md-based schedule definition with cron syntax
  - Claude CLI executor with permission support (`--permission-mode`)
  - Execution log viewer with Message/Response detail and schedule name display
  - CMATE setup/validate button in FileTreeView toolbar
  - Step-by-step setup guide for empty schedules state
  - Environment variable sanitization for secure execution
  - i18n support (en/ja) for schedule UI
  - CMATE schedules user guide documentation (ja/en)
- Mobile tab renamed from "Notes" to "CMATE"

### Fixed
- CLAUDE_PERMISSIONS corrected to match `claude` CLI `--permission-mode` values
- Disabled schedules now filtered from active execution
- Header column validation added to CMATE.md validator
- Tree API response parsing fixed (object instead of array)
- Executor hanging prevention with CLI-specific args support

## [0.3.1] - 2026-02-23

### Fixed
- False negative in `isSessionHealthy()` for recovered sessions (Issue #354)
  - Prevent healthy sessions from being incorrectly marked as unhealthy after recovery

## [0.3.0] - 2026-02-22

### Added
- Token authentication and HTTPS support (Issue #331)
  - `CM_AUTH_TOKEN` for bearer token authentication
  - HTTPS with self-signed or custom certificate support
  - Login page UI with token input
  - AuthContext and middleware for Edge Runtime compatibility
  - Logout button with server-side auth status
  - Security documentation for token auth and HTTPS setup
- IP address/CIDR restriction for HTTP and WebSocket access (Issue #332)
  - `CM_ALLOWED_IPS` environment variable for IP whitelist
  - CIDR notation support for subnet ranges
  - 401 redirect handling in API client with polling stop
- Skills loader: display `.claude/skills` in slash command selector (Issue #343)
  - YAML frontmatter parsing with regex fallback
  - JSDoc documentation and TODO annotations per design policy

### Changed
- Auto-yes-manager refactored: decomposed `pollAutoYes()` into focused functions (Issue #323)
  - Removed misleading type assertion in test
- README rewritten with pain-first narrative elevator pitch
- vitest updated to 4.0.16

### Fixed
- SKILL.md YAML frontmatter parse errors with quoted values (Issue #351)
- Auth redirect handling in API client and polling stop on 401
- Login page flicker eliminated by using AuthContext instead of async status fetch
- LogoutButton flicker eliminated by using server-side auth status
- next-intl v4 SSR timeZone configuration
- Middleware made Edge Runtime compatible
- Server TypeError prevention in handleRequestImpl on Node.js 19+
- Slash command regex fallback for YAML-unfriendly SKILL.md frontmatter

## [0.2.13] - 2026-02-20

### Added
- Memo card copy to clipboard functionality (Issue #321)

### Fixed
- Prompt response extraction limited to `lastCapturedLine` onwards to prevent stale data (Issue #326)

## [0.2.12] - 2026-02-20

### Added
- Auto-Yes stop condition with regex pattern matching (Issue #314)
  - Custom regex pattern input to auto-stop when output matches
  - Regex tips tooltip for pattern guidance
  - Delta-based stop condition check to prevent false triggers
  - `AutoYesStopReason` moved to shared config
- Desktop demo GIF, mobile FAQ, and Cloudflare Tunnel guide in README

### Fixed
- Test environment NODE_ENV isolation (Issue #304)
  - `NODE_ENV=test` enforced in vitest config and test scripts
  - Infinite re-render loop fix in `useLocalStorageState`
  - `process.env` cast to avoid read-only NODE_ENV type error

### Changed
- README rewritten with "Mobile Dev Cockpit" positioning

## [0.2.11] - 2026-02-19

### Added
- MP4 video file upload and browser playback support (Issue #302)
  - Video security validation aligned with image upload pattern
- Root-level file/directory creation toolbar (Issue #300)
  - Dark mode support for empty state buttons
  - Path encoding fix for special characters
- Session stability improvements with duplicate prevention (Issue #306)
  - JSDoc improvements, constant extraction, DRY/ISP principles applied
- npm keywords for package discoverability

### Fixed
- Clone basePath now uses `CM_ROOT_DIR` instead of hardcoded `/tmp/repos` (Issue #308)
- iPad layout: unified z-index system, swipe/scroll separation, layout fixes (Issue #299)
  - Unreachable code fix in MarkdownEditor

## [0.2.10] - 2026-02-17

### Fixed
- Prompt-response API fallback for promptType mismatch (Issue #287)
  - `promptType` / `defaultOptionNumber` sent from client for server-side re-verification fallback
  - `isClaudeMultiChoice` broadened for type mismatch edge cases
  - User input prompt barrier to prevent false positive detection
  - `prompt-answer-sender.ts` shared module to eliminate cursor-key logic duplication
  - `prompt-response-body-builder.ts` shared utility for DRY request body construction
- Slash command selector re-display during free input mode (Issue #288)
  - `isFreeInputMode` flag prevents selector from re-appearing after custom command input
  - Enter key interception fix and filter text carry-over to free input mode
  - Mobile send button guard during free input mode

### Changed
- README improved as project landing page with complete CLI command reference (Issue #286)

## [0.2.9] - 2026-02-15

### Added
- File move/rename feature with `MoveDialog` component (Issue #162)
  - Context menu "Move/Rename" option for files and directories
  - Path validation and overwrite prevention
- File creation date (birthtime) display in `FileViewer` header and mobile view (Issue #162)
  - `date-utils.ts` with locale-aware formatting
- Content copy button in `MarkdownEditor` toolbar (Issue #162)
  - `useFileOperations` hook for file operation logic extraction

## [0.2.8] - 2026-02-14

### Fixed
- Update check API fetch caching issue with `cache: 'no-store'` (Issue #278)
- Update notification indicator dot on Info tab and mobile tab bar (Issue #278)
  - `NotificationDot` reusable component for visual update alerts

## [0.2.7] - 2026-02-14

### Fixed
- Claude CLI session recovery: cache invalidation, health check, and CLAUDECODE env removal (Issue #265)
  - `clearCachedClaudePath()` for automatic recovery on CLI update
  - `isSessionHealthy()` / `ensureHealthySession()` for broken session detection and recreation
  - `sanitizeSessionEnvironment()` to remove CLAUDECODE environment variable
  - `getCleanPaneOutput()` common helper and `isValidClaudePath()` validation
  - Session error pattern detection via `CLAUDE_SESSION_ERROR_PATTERNS` / `CLAUDE_SESSION_ERROR_REGEX_PATTERNS`
- Preserve input content on browser tab visibility change (Issue #266)
  - Input field content no longer cleared when switching browser tabs

### Changed
- Refactored `WorktreeDetailRefactored` component for DRY compliance (Issue #266)
  - Extracted shared hooks and components

## [0.2.6] - 2026-02-14

### Fixed
- Update-check API route static prerender error (Issue #270)
  - Added `force-dynamic` export to prevent Next.js static generation at build time

## [0.2.5] - 2026-02-14

### Added
- User feedback links in Info modal (Issue #264)
  - `FeedbackSection` component with bug report, feature request, question links
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - i18n support (en/ja)
- `commandmate issue` CLI command with gh CLI integration (Issue #264)
  - `commandmate issue create --bug/--feature/--question` for templated issue creation
  - `commandmate issue search <query>` for issue search
  - `commandmate issue list` for issue listing
- `commandmate docs` CLI command for RAG-like documentation access (Issue #264)
  - `commandmate docs --section <name>` for specific documentation sections
  - `commandmate docs --search <query>` for documentation search
  - `commandmate docs --all` for full documentation output
- AI tool integration guide displayed after `commandmate init` (Issue #264)
- GitHub URL constants centralized in `src/config/github-links.ts` (Issue #264)

### Fixed
- docs-reader path resolution for built CLI (Issue #264)

## [0.2.4] - 2026-02-13

### Added
- Version update notification feature (Issue #257)
  - `UpdateNotificationBanner` component for new version alerts
  - `VersionSection` component for Info screen
  - `useUpdateCheck` hook and `version-checker.ts` library
  - `/api/app/update-check` API endpoint

### Fixed
- Multiple choice prompt detection for wrapped questions (Issue #256)
  - `isQuestionLikeLine()` now handles multi-line question wrapping (trailing `。` / `.`)
  - Keyword-based detection for non-question prompts (model selection, etc.)
  - Added `questionBlockScan()` for multi-line question block analysis
- Mobile background resume error "Error loading worktree" (Issue #246)
  - Added `visibilitychange` event listener for automatic data recovery
  - Error state reset and data re-fetch on page visibility restore

## [0.2.3] - 2026-02-13

### Added
- i18n support with next-intl for English and Japanese (Issue #124)
  - Locale-based routing (`/en`, `/ja`)
  - Document translations and integration/e2e tests
- Log export feature with LogViewer (Issue #11)
  - `LogViewer` component in Info screen (desktop modal & mobile)
  - `withLogging()` API logger middleware applied to log routes
  - `log-config.ts` for centralized LOG_DIR constant
  - Log-manager regression tests
- Prompt instructionText display in active prompt UI (Issue #235)
  - `PromptPanel` and `MobilePromptSheet` show instruction text
  - Complete prompt output preserved with `rawContent` field

### Fixed
- Full prompt block included in instructionText for multiple_choice prompts (Issue #235)
- Full output passed to detectPrompt in status-detector for long prompts (Issue #235)
- next-intl middleware removed to fix redirect loop with custom server (Issue #124)
- Image and document links corrected in README files (Issue #124)
- Rebuild skill branch specification to prevent worktree misexecution

### Removed
- Dead code: claude-poller, terminal-websocket, WorktreeDetail legacy code, simple-terminal (Issue #237)

## [0.2.2] - 2026-02-10

_No changes recorded._

## [0.2.1] - 2026-02-10

_No changes recorded._

## [0.2.0] - 2026-02-08

### Changed
- **BREAKING**: Removed `CM_AUTH_TOKEN` authentication mechanism (Issue #179)
  - `src/middleware.ts` deleted (Next.js authentication middleware)
  - `CM_AUTH_TOKEN`, `NEXT_PUBLIC_CM_AUTH_TOKEN`, `MCBD_AUTH_TOKEN` environment variables are no longer used
  - Existing AUTH_TOKEN settings are silently ignored (no errors, no effect)
  - External access now requires reverse proxy authentication (Nginx + Basic Auth, Cloudflare Access, Tailscale)
  - `commandmate init` and `commandmate start` show reverse proxy warning when `CM_BIND=0.0.0.0`
  - ENV_MAPPING reduced from 8 to 7 entries
  - Client-side `api-client.ts` no longer sends Authorization header

### Added
- Codex CLI support (Issue #4)
  - Codex tab in WorktreeDetail
  - Per-CLI tool status indicators in sidebar and tabs
  - Individual session termination with confirmation dialog
  - Mobile CLI tab switcher inline with Auto Yes toggle
  - CLI tool-specific slash command filtering (Claude: 16, Codex: 10)
  - Response saving fix for tmux buffer empty line padding
- Multiline message support via tmux `paste-buffer` (Issue #163)
  - `sendTextViaBuffer()` for accurate multiline text delivery
  - Single-line uses `sendKeys`, multiline uses `paste-buffer`
- App version display in info tab (Issue #159)
  - Desktop (InfoModal) and mobile (MobileInfoContent) support
  - Build-time `NEXT_PUBLIC_APP_VERSION` from `package.json`
- New security guide: `docs/security-guide.md` (Issue #179)
  - Threat model for localhost vs external access
  - Nginx + Basic Auth configuration example
  - Cloudflare Access and Tailscale setup instructions
  - Migration steps from CM_AUTH_TOKEN
  - Security checklist for external deployment
- `src/cli/config/security-messages.ts` with shared REVERSE_PROXY_WARNING constant (Issue #179)

### Fixed
- Auto-Yes false positive detection of numbered lists as multiple_choice prompts (Issue #161)
  - Two-pass `❯` detection to prevent misidentification
  - Thinking state pre-check skips prompt detection
  - Consecutive number validation as defensive measure
  - Prompt re-verification before sendKeys in prompt-response API
- Status display inconsistency: UI showing "running"/"waiting" when CLI is idle (Issue #180)
  - Consolidated inline logic into `detectSessionStatus()` in `status-detector.ts`
  - 15-line windowing to prevent past prompt false positives
- Multiline option text detection in multiple choice prompts (Issue #181)
- Deleted repositories reappearing after Sync All (Issue #190)
  - `enabled=0` exclusion marking on delete
  - Excluded repository list UI with restore button
  - New APIs: `GET /api/repositories/excluded`, `PUT /api/repositories/restore`
- File tree directory expand state lost after file operations

### Removed
- `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN` environment variable support (Issue #179)
- `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN` client-side token support (Issue #179)
- `isAuthRequired()` function from `src/lib/env.ts` (Issue #179)
- `generateAuthToken()` method from `EnvSetup` class (Issue #179)
- `CM_AUTH_TOKEN` masking patterns from logger and security-logger (Issue #179)

### Security
- Removed broken authentication that exposed tokens in client-side JavaScript (Issue #179)
- Added reverse proxy authentication recommendation for external deployments (Issue #179)

## [0.1.12] - 2026-02-04

_No changes recorded._

## [0.1.11] - 2026-02-04

### Added
- Server-side Auto-Yes polling feature (Issue #138)
  - `src/lib/auto-yes-manager.ts` for centralized polling management
  - Background polling when browser tab is inactive
  - Exponential backoff after 5 consecutive errors (max 60s)
  - Duplicate response prevention with `lastServerResponseTimestamp`
  - MAX_CONCURRENT_POLLERS=50 limit for DoS prevention
- Git Worktree parallel development environment (Issue #136)
  - `commandmate start --issue {issueNo} [--auto-port]` for issue-specific servers
  - `commandmate stop/status --issue {issueNo}` for worktree management
  - Port range 3001-3100 (main server uses 3000)
  - Issue-specific DB: `~/.commandmate/data/cm-{issueNo}.db`
  - `/worktree-setup` and `/worktree-cleanup` skills
- DB path resolution fix for global installs (Issue #135)
  - Consistent DB path via `getEnv().CM_DB_PATH`
  - Auto-migration from legacy DB paths
  - System directory protection

### Fixed
- Terminal scroll behavior on worktree switch (Issue #131)
  - Uses instant scroll for worktree changes
  - Smooth scroll only for new messages in same worktree
- Empty state now shows New File/New Directory buttons (Issue #139)
- Ready status detection for prompts with recommended commands (Issue #141)
- Worktree sync now removes deleted worktrees from DB

### Security
- worktreeID format validation (command injection prevention)
- Issue number validation (1-999999 range)
- Branch name whitelist validation (`[a-zA-Z0-9_/-]`)
- Graceful shutdown stops all auto-yes pollers

## [0.1.10] - 2026-02-02

### Added
- Git branch visualization feature (Issue #111)
  - Display current branch name in worktree detail header
  - Show warning when current branch differs from session start branch
  - Mobile support for branch information display
  - Automatic refresh (active: 2s, idle: 5s)
  - Migration #15: added `initial_branch` column to worktrees table
  - New `src/lib/git-utils.ts` module with `getGitStatus()` function
  - `BranchMismatchAlert` component for branch mismatch warnings

### Fixed
- Repository filter UI now displays even when only one repository exists (Issue #129)

### Security
- Branch visualization uses `execFile` instead of `exec` to prevent command injection
- 1 second timeout for git commands to prevent DoS
- React auto-escaping for XSS prevention in branch name display

## [0.1.9] - 2026-02-02

### Fixed
- Foreground mode (`commandmate start`) now loads .env file (Issue #125 follow-up)
  - v0.1.8 only fixed daemon mode, foreground mode was missing .env loading
  - Now both modes load .env from `~/.commandmate/.env` for global installs
  - Security warnings for external access also added to foreground mode

## [0.1.8] - 2026-02-02

### Fixed
- Global install CLI commands now load .env from correct location (Issue #125)
  - `commandmate start/stop/status` use `getEnvPath()` and `getPidFilePath()`
  - .env loaded from `~/.commandmate/.env` for global installs
  - PID file created at `~/.commandmate/.commandmate.pid`
  - Path traversal protection with symlink resolution
  - Security warnings for external network access (CM_BIND=0.0.0.0)
  - Fallback to process.env when .env loading fails

### Security
- Added path traversal protection in getConfigDir() (OWASP A01:2021)
- Security warning when server is exposed externally without authentication (OWASP A05:2021)

## [0.1.7] - 2026-02-02

### Added
- Interactive mode for `commandmate init` command (Issue #119)
  - TTY detection for automatic interactive/non-interactive mode selection
  - Prompts for CM_ROOT_DIR, CM_PORT, external access, CM_DB_PATH
  - `--defaults` flag for CI/CD environments (non-interactive)
  - Tilde expansion for paths (`~/repos` → `/Users/xxx/repos`)
  - Configuration summary display after setup
  - Global install: `.env` saved to `~/.commandmate/`
  - Local install: `.env` saved to current directory

## [0.1.6] - 2026-02-02

### Added
- Documentation updated to use `npm install -g commandmate` as primary setup method (Issue #114)
  - New CLI setup guide at `docs/user-guide/cli-setup-guide.md`
  - README.md Quick Start uses npm global install
  - git clone method moved to "Developer Setup" section
  - `--port` option documented in CLI commands table

### Fixed
- iPad fullscreen mode now uses Portal to cover full viewport (Issue #104)
- Test z-index expectations updated from 40 to 55 to match Z_INDEX.MAXIMIZED_EDITOR

### Changed
- Sidebar toggle animation uses transform instead of width for GPU acceleration (Issue #112)
  - Improves performance on iPad
  - Added SIDEBAR constant (30) to z-index.ts
- Pre-built JS compilation for server.ts enables npm CLI without TypeScript compilation (Issue #113)

## [0.1.5] - 2026-02-01

### Fixed
- Added `repository` field to package.json for npm provenance verification

## [0.1.4] - 2026-02-01

### Fixed
- Re-enabled `environment: npm-publish` in publish workflow
  - npm Trusted Publisher requires exact match of environment name

## [0.1.3] - 2026-02-01

### Fixed
- npm publish workflow now upgrades npm to ^11.5.1 for OIDC Trusted Publishers support
  - Node 20 ships with npm 10.8.2, but Trusted Publishers requires npm >= 11.5.1

## [0.1.2] - 2026-02-01

### Added
- Security audit job in PR CI workflow (ci-pr.yml)
  - Catches vulnerabilities before merge/release

### Changed
- Updated Next.js to 14.2.35 (latest 14.x patch)
- Updated eslint-config-next to 14.2.35
- Changed audit-level from `high` to `critical` in CI/publish workflows
  - Allows high-severity vulnerabilities that require breaking changes to fix
  - Next.js 15+ migration tracked separately

### Security
- Added npm audit to PR checks to catch vulnerabilities early

## [0.1.1] - 2026-02-01

### Added
- npm CLI support (`npm install -g commandmate`) (Issue #96)
  - `commandmate init` - Initialize configuration
  - `commandmate start` - Start server (foreground or daemon mode)
  - `commandmate stop` - Stop server
  - `commandmate status` - Show server status
- File tree search functionality (Issue #21)
  - Name search with real-time filtering (300ms debounce)
  - Content search via server API (5s timeout)
  - Search result highlighting
  - Auto-expand parent directories of matched files
  - Desktop/Mobile responsive design
- Mermaid diagram rendering in markdown preview (Issue #100)
- Image file viewer with security validation (Issue #95)
- File upload feature with security validation (Issue #94)
- Markdown editor with XSS protection (Issue #49)
- Markdown editor display improvements (Issue #99)
- pm-auto-design2dev slash command for automated workflow

### Fixed
- CLI now uses package directory instead of cwd for npm run
- Search filtering applied to nested tree items
- File tree refresh after operations
- Markdown preview code block styling

### Security
- ReDoS prevention (no regex on server-side search)
- Relative paths only in search results
- Magic byte validation for file uploads
- SVG XSS protection for image viewer
- Mermaid securityLevel='strict' setting

### Added
- Preflight check script `scripts/preflight-check.sh` for dependency validation (Issue #92)
  - Checks Node.js (v20+), npm, tmux, git, openssl
  - Claude CLI check with warning (optional)
  - Help option (`-h`/`--help`)
- Interactive environment setup script `scripts/setup-env.sh` (Issue #92)
  - Generates `.env` with CM_* variables
  - Auto-generates auth token for external access
  - Backs up existing `.env` to `.env.backup.{timestamp}`
  - Help option (`-h`/`--help`)

### Changed
- `scripts/build-and-start.sh` now includes database initialization (Issue #92)
  - Creates data directory
  - Runs `npm run db:init` before build
  - Help option (`-h`/`--help`)
- `scripts/setup.sh` now uses preflight-check.sh, setup-env.sh, and build-and-start.sh (Issue #92)
  - Integrated dependency checking
  - Interactive environment configuration
  - Streamlined 4-step setup process (preflight → npm install → env → build & start)
  - Application starts automatically after setup
- `.env.production.example` updated to use CM_* variables (Issue #92)
  - Migrated from MCBD_* to CM_* format
  - Added logging configuration options
  - Added legacy support documentation
- Updated README.md Quick Start with simplified setup (Issue #92)
- Updated docs/DEPLOYMENT.md with new setup scripts (Issue #92)
- Updated docs/internal/PRODUCTION_CHECKLIST.md with CM_* variables (Issue #92)

## [0.1.0] - 2026-01-30

### Changed
- **BREAKING**: GitHub repository renamed from `Kewton/MyCodeBranchDesk` to `Kewton/CommandMate` (Issue #80)
- All documentation links updated to new repository URL (Issue #80)
- Project branding updated from MyCodeBranchDesk to CommandMate (Issue #75)
- UI titles and headers now display "CommandMate"
- Documentation updated with new branding terminology
- Removed "chat" terminology that caused confusion (now uses "Message/Console/History")
- **BREAKING**: package.json name changed from `mycodebranch-desk` to `commandmate` (Issue #77)
- **BREAKING**: Env interface properties renamed from `MCBD_*` to `CM_*` (Issue #77)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `DATABASE_PATH` -> `CM_DB_PATH`
- .env.example updated to use CM_* environment variables as primary (Issue #77)
- All shell scripts updated to use CommandMate branding and CM_* variables (Issue #77)
- E2E tests updated to test for CommandMate heading (Issue #77)

### Added
- Migration guide for existing users (`docs/migration-to-commandmate.md`) (Issue #79)
  - Complete environment variable mapping (9 variables)
  - systemd service migration instructions
  - Claude Code settings update instructions
  - Docker environment migration guide
  - Troubleshooting section
- Environment variable fallback support for backwards compatibility (Issue #76)
  - New `CM_*` prefix supported alongside legacy `MCBD_*` prefix
  - Deprecation warnings logged when legacy names are used (once per key)
  - All 8 environment variables support fallback:
    - `CM_ROOT_DIR` / `MCBD_ROOT_DIR`
    - `CM_PORT` / `MCBD_PORT`
    - `CM_BIND` / `MCBD_BIND`
    - `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN`
    - `CM_LOG_LEVEL` / `MCBD_LOG_LEVEL`
    - `CM_LOG_FORMAT` / `MCBD_LOG_FORMAT`
    - `CM_LOG_DIR` / `MCBD_LOG_DIR`
    - `CM_DB_PATH` / `MCBD_DB_PATH`
  - Client-side fallback for `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN`
- `CM_AUTH_TOKEN` masking pattern in logger for security
- Unit tests for environment variable fallback functionality

### Deprecated
- `MCBD_*` environment variables - use `CM_*` instead (will be removed in next major version)
  - `MCBD_ROOT_DIR` -> `CM_ROOT_DIR`
  - `MCBD_PORT` -> `CM_PORT`
  - `MCBD_BIND` -> `CM_BIND`
  - `MCBD_AUTH_TOKEN` -> `CM_AUTH_TOKEN`
  - `MCBD_LOG_LEVEL` -> `CM_LOG_LEVEL`
  - `MCBD_LOG_FORMAT` -> `CM_LOG_FORMAT`
  - `MCBD_LOG_DIR` -> `CM_LOG_DIR`
  - `MCBD_DB_PATH` -> `CM_DB_PATH`
- `NEXT_PUBLIC_MCBD_AUTH_TOKEN` -> `NEXT_PUBLIC_CM_AUTH_TOKEN`

[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Kewton/CommandMate/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Kewton/CommandMate/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Kewton/CommandMate/compare/v0.4.16...v0.5.0
[0.4.16]: https://github.com/Kewton/CommandMate/compare/v0.4.15...v0.4.16
[0.4.15]: https://github.com/Kewton/CommandMate/compare/v0.4.14...v0.4.15
[0.4.14]: https://github.com/Kewton/CommandMate/compare/v0.4.13...v0.4.14
[0.4.13]: https://github.com/Kewton/CommandMate/compare/v0.4.12...v0.4.13
[0.4.12]: https://github.com/Kewton/CommandMate/compare/v0.4.11...v0.4.12
[0.4.11]: https://github.com/Kewton/CommandMate/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/Kewton/CommandMate/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/Kewton/CommandMate/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/Kewton/CommandMate/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/Kewton/CommandMate/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/Kewton/CommandMate/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/Kewton/CommandMate/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/Kewton/CommandMate/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/Kewton/CommandMate/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Kewton/CommandMate/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Kewton/CommandMate/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Kewton/CommandMate/compare/v0.3.6...v0.4.0
[0.3.6]: https://github.com/Kewton/CommandMate/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/Kewton/CommandMate/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Kewton/CommandMate/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Kewton/CommandMate/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Kewton/CommandMate/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Kewton/CommandMate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kewton/CommandMate/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/Kewton/CommandMate/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/Kewton/CommandMate/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/Kewton/CommandMate/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/Kewton/CommandMate/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/Kewton/CommandMate/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/Kewton/CommandMate/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/Kewton/CommandMate/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Kewton/CommandMate/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Kewton/CommandMate/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Kewton/CommandMate/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Kewton/CommandMate/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kewton/CommandMate/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kewton/CommandMate/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kewton/CommandMate/compare/v0.1.12...v0.2.0
[0.1.12]: https://github.com/Kewton/CommandMate/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/Kewton/CommandMate/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/Kewton/CommandMate/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/Kewton/CommandMate/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/Kewton/CommandMate/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Kewton/CommandMate/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Kewton/CommandMate/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Kewton/CommandMate/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Kewton/CommandMate/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Kewton/CommandMate/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Kewton/CommandMate/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
