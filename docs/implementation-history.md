[English](./en/implementation-history.md)

# 実装機能一覧

各Issueの詳細（根本原因、修正方針、セキュリティ対策、テスト等）は設計書リンクを参照。

| Issue | 種別 | 概要 | 主要変更ファイル | 設計書 |
|-------|------|------|-----------------|--------|
| #257 | feat | バージョンアップ通知機能（GitHub Releases API、semver比較、globalThisキャッシュ、Silent Failure、OWASP Top 10準拠、i18n対応） | `version-checker.ts`, `useUpdateCheck.ts`, `UpdateNotificationBanner.tsx`, `VersionSection.tsx`, `update-check/route.ts`, `api-client.ts`, `WorktreeDetailRefactored.tsx` | [link](../dev-reports/design/issue-257-version-update-notification-design-policy.md) |
| #256 | fix | 選択メッセージ検出精度向上（複数行質問対応、isQuestionLikeLine Pattern 2/4追加、SEC-001b上方走査、MF-001 SRP遵守、リファクタリング） | `prompt-detector.ts`, `prompt-type-guards.ts`, unit/integration tests | [link](../dev-reports/design/issue-256-multiple-choice-prompt-detection-design-policy.md) |
| #246 | fix | スマホバックグラウンド復帰時のエラー自動回復（visibilitychange、timestampガード） | `WorktreeDetailRefactored.tsx`, `WorktreeList.tsx`, `WorktreeDetailRefactored.test.tsx` | [link](../dev-reports/design/issue-246-visibility-recovery-design-policy.md) |
| #124 | feat | i18n対応（next-intl、en/ja切替UI、ドキュメント英語化） | `i18n-config.ts`, `i18n.ts`, `locale-cookie.ts`, `useLocaleSwitch.ts`, `LocaleSwitcher.tsx`, `date-locale.ts`, `locales/`, `README.md`, `docs/en/` | - |
| #212 | fix | 複数行メッセージのPasted text検知+Enter自動送信（共通ヘルパー、skipPatterns拡張） | `pasted-text-helper.ts`, `cli-patterns.ts`, `claude-session.ts`, `codex.ts`, `response-poller.ts` | [link](../dev-reports/design/issue-212-pasted-text-detection-design-policy.md) |
| #211 | feat | 履歴メッセージコピーボタン（stripAnsi利用、Toast通知） | `clipboard-utils.ts`, `ConversationPairCard.tsx`, `HistoryPane.tsx`, `WorktreeDetailRefactored.tsx` | [link](../dev-reports/design/issue-211-history-copy-button-design-policy.md) |
| #201 | feat | Trust dialog自動応答（Claude CLI v2.x） | `claude-session.ts`, `cli-patterns.ts` | [link](../dev-reports/design/issue-201-trust-dialog-auto-response-design-policy.md) |
| #188 | fix | Thinking誤検出によるスピナー残留修正（5行ウィンドウ化、末尾空行トリム、インデント質問対応） | `status-detector.ts`, `response-poller.ts`, `current-output/route.ts`, `prompt-detector.ts` | [link](../dev-reports/design/issue-188-thinking-indicator-false-detection-design-policy.md) |
| #193 | fix | 複数選択肢プロンプト検出（DetectPromptOptions, requireDefaultIndicator） | `prompt-detector.ts`, `cli-patterns.ts`, `response-poller.ts` | [link](../dev-reports/design/issue-193-multiple-choice-prompt-detection-design-policy.md) |
| #191 | fix | Auto-Yes detectThinking()ウィンドウイング（末尾50行） | `auto-yes-manager.ts` | [link](../dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md) |
| #190 | fix | リポジトリ削除後のSync All復活防止（enabled=0除外） | `db-repository.ts`, repositories API routes | [link](../dev-reports/design/issue-190-repository-exclusion-on-sync-design-policy.md) |
| #159 | feat | infoタブにアプリバージョン表示 | `next.config.js`, `WorktreeDetailRefactored.tsx` | [link](../dev-reports/design/issue-159-info-tab-app-version-design-policy.md) |
| #180 | fix | ステータス表示の不整合修正（15行ウィンドウイング） | `status-detector.ts`, worktrees route.ts x2 | [link](../dev-reports/design/issue-180-status-display-inconsistency-design-policy.md) |
| #161 | fix | Auto-Yes番号付きリスト誤検出防止（2パス❯検出、連番検証） | `prompt-detector.ts`, `auto-yes-manager.ts` | [link](../dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md) |
| #151 | fix | worktree-cleanupサーバー検出改善（ポートベース検出） | `.claude/lib/process-utils.sh`, `.claude/lib/validators.sh` | [link](../dev-reports/design/issue-151-worktree-cleanup-server-detection-design-policy.md) |
| #152 | fix | セッション初回メッセージ送信の信頼性向上（waitForPrompt） | `claude-session.ts`, `cli-patterns.ts` | [link](../dev-reports/design/issue-152-first-message-not-sent-design-policy.md) |
| #187 | fix | セッション初回メッセージ送信信頼性改善（安定化待機500ms） | `claude-session.ts` | [link](../dev-reports/design/issue-187-session-first-message-reliability-design-policy.md) |
| #123 | fix | iPadタッチ長押しコンテキストメニュー（useLongPressフック） | `useLongPress.ts`, `useContextMenu.ts`, `FileTreeView.tsx` | [link](../dev-reports/design/issue-123-ipad-touch-context-menu-design-policy.md) |
| #138 | feat | サーバー側Auto-Yesポーリング（バックグラウンドタブ対応） | `auto-yes-manager.ts`, `auto-yes-resolver.ts` | [link](../dev-reports/design/issue-138-server-side-auto-yes-polling-design-policy.md) |
| #153 | fix | Auto-Yes UI状態不整合修正（globalThisパターン） | `auto-yes-manager.ts` | [link](../dev-reports/design/issue-153-auto-yes-state-inconsistency-design-policy.md) |
| #136 | feat | Git Worktree並列開発環境（--issue, --auto-port） | CLI utils/, `external-apps/db.ts` | [link](../dev-reports/design/issue-136-worktree-parallel-dev-design-policy.md) |
| #135 | fix | DBパス解決ロジック修正（グローバルインストール対応） | `db-path-resolver.ts`, `db-migration-path.ts`, `env.ts` | [link](../dev-reports/design/issue-135-db-path-resolution-design-policy.md) |
| #111 | feat | Gitブランチ可視化（不一致警告、定期更新） | `git-utils.ts`, `BranchMismatchAlert.tsx` | [link](../dev-reports/design/issue-111-branch-visualization-design-policy.md) |
| #21 | feat | ファイルツリー検索（名前/内容検索切替） | `file-search.ts`, `SearchBar.tsx`, `useFileSearch.ts` | [link](../dev-reports/design/issue-21-file-search-design-policy.md) |
| #114 | docs | npm install -g ドキュメント整備 | README.md, docs/ | - |
| #96 | feat | npm CLIサポート（init/start/stop/status） | `src/cli/` | [link](../dev-reports/design/issue-96-npm-cli-design-policy.md) |
| #119 | feat | commandmate init 対話形式対応 | `cli/commands/init.ts`, `cli/utils/prompt.ts` | - |
| #125 | fix | グローバルインストール時の.env読み込み修正 | `cli/utils/env-setup.ts`, `cli/utils/daemon.ts` | [link](../dev-reports/design/issue-125-global-install-env-loading-design-policy.md) |
| #100 | feat | Mermaidダイアグラム描画（securityLevel=strict） | `MermaidDiagram.tsx`, `mermaid-config.ts` | [link](../dev-reports/design/issue-100-mermaid-diagram-design-policy.md) |
| #95 | feat | 画像ファイルビューワ（マジックバイト/SVG XSS検証） | `image-extensions.ts`, `ImageViewer.tsx` | [link](../dev-reports/design/issue-95-image-viewer-design-policy.md) |
| #94 | feat | ファイルアップロード（5MB制限、マジックバイト検証） | `uploadable-extensions.ts`, upload API route | [link](../dev-reports/design/issue-94-file-upload-design-policy.md) |
| #113 | feat | server.tsビルド済みJS変換（tsx依存解消） | `tsconfig.server.json`, `dist/server/` | [link](../dev-reports/design/issue-113-server-build-design-policy.md) |
| #112 | fix | サイドバートグルパフォーマンス改善（transform方式） | `AppShell.tsx`, `z-index.ts` | [link](../dev-reports/design/issue-112-sidebar-transform-design-policy.md) |
| #99 | feat | マークダウンエディタ表示改善（最大化/リサイズ） | `useFullscreen.ts`, `useLocalStorageState.ts` | [link](../dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md) |
| #49 | feat | マークダウンエディタとビューワー | `MarkdownEditor.tsx`, `file-operations.ts` | [link](../dev-reports/design/issue-49-markdown-editor-design-policy.md) |
| #77 | chore | CommandMateリネーム Phase 3（CM_*名称統一） | `env.ts`, `.env.example`, `package.json` | [link](../dev-reports/design/issue-77-rename-phase3-design-policy.md) |
| #76 | feat | 環境変数フォールバック（CM_*/MCBD_*両対応） | `env.ts` | [link](../dev-reports/design/issue-76-env-fallback-design-policy.md) |
| #71 | feat | クローンURL登録（非同期ジョブ、URL正規化） | `clone-manager.ts`, `url-normalizer.ts` | [link](../dev-reports/design/issue-71-clone-url-registration-design-policy.md) |
| #69 | feat | リポジトリ削除（Facadeパターン、確認ダイアログ） | `session-cleanup.ts`, repositories API | [link](../dev-reports/design/issue-69-repository-delete-design-policy.md) |
| #31 | feat | サイドバーUX改善（リアルタイムステータス検出） | status-detector, sidebar components | [docs](../docs/features/sidebar-status-indicator.md) |
| #22 | feat | マルチタスクサイドバー（2カラム、ソート機能） | sidebar components | - |
| #4 | feat | CLIツールサポート（Codex CLI追加、Strategyパターン） | `cli-tools/`, `cli-patterns.ts`, `standard-commands.ts` | [link](../dev-reports/design/issue-4-codex-cli-support-design-policy.md) |
