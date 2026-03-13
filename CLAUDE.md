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
├── helpers/       # テスト共通ヘルパー（型ガード、loggerモック等）
├── unit/          # 単体テスト
└── integration/   # 結合テスト
```

### 主要モジュール一覧

詳細（Issue番号・関数シグネチャ・定数・セキュリティ注釈）は [モジュールリファレンス](./docs/module-reference.md) を参照。

| モジュール | 役割 |
|-----------|------|
| `src/middleware.ts` | 認証ミドルウェア（Edge Runtime） |
| `src/lib/auth.ts` | トークン認証コア |
| `src/lib/ip-restriction.ts` | IP/CIDR制限 |
| `src/config/auth-config.ts` | 認証設定定数 |
| `src/lib/env.ts` | 環境変数取得・フォールバック |
| `src/lib/db-instance.ts` | DBインスタンス管理 |
| `src/lib/db-path-resolver.ts` | DBパス解決 |
| `src/lib/db-migration-path.ts` | DBマイグレーション |
| `src/lib/db-repository.ts` | リポジトリDB操作 |
| `src/lib/tmux.ts` | tmuxセッション管理基盤（execFile使用） |
| `src/lib/tmux-capture-cache.ts` | tmux captureキャッシュ（TTL=2秒、singleflight） |
| `src/lib/claude-session.ts` | Claude CLIセッション管理・ヘルスチェック |
| `src/lib/status-detector.ts` | セッションステータス検出 |
| `src/lib/worktree-status-helper.ts` | Worktreeセッションステータス一括検出 |
| `src/lib/response-poller.ts` | レスポンスポーリング・thinking検出 |
| `src/lib/prompt-detector.ts` | プロンプト検出（2パス方式） |
| `src/lib/cli-patterns.ts` | CLIツール別パターン定義 |
| `src/lib/auto-yes-manager.ts` | Auto-Yes状態管理・サーバー側ポーリング |
| `src/lib/auto-yes-resolver.ts` | Auto-Yes自動応答判定 |
| `src/config/auto-yes-config.ts` | Auto-Yes設定定数・バリデーション |
| `src/config/file-polling-config.ts` | ファイルポーリング定数（FILE_TREE_POLL_INTERVAL_MS, FILE_CONTENT_POLL_INTERVAL_MS）（Issue #469） |
| `src/lib/prompt-key.ts` | promptKey重複排除ユーティリティ |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/cli-tools/types.ts` | CLIツール型定義（IImageCapableCLITool/isImageCapableCLITool追加）（Issue #474） |
| `src/lib/cli-tools/codex.ts` | Codex CLIセッション管理 |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local CLIツール |
| `src/lib/cli-tools/opencode.ts` | OpenCode CLIツール |
| `src/lib/cli-tools/opencode-config.ts` | OpenCode設定自動生成（Ollama/LM Studio） |
| `src/lib/selected-agents-validator.ts` | エージェント選択バリデーション（2-4エージェント） |
| `src/lib/claude-executor.ts` | CLI非インタラクティブ実行エンジン |
| `src/lib/schedule-manager.ts` | cronベーススケジューラー |
| `src/lib/cmate-parser.ts` | CMATE.md汎用パーサー |
| `src/lib/session-cleanup.ts` | セッション/ポーラー/スケジューラー停止（Facade） |
| `src/lib/resource-cleanup.ts` | リソースリーク対策（孤立プロセス/Map検出） |
| `src/lib/env-sanitizer.ts` | 環境変数サニタイズ |
| `src/lib/proxy/handler.ts` | HTTPプロキシハンドラ |
| `src/lib/proxy/config.ts` | プロキシ設定定数 |
| `src/lib/path-validator.ts` | パスバリデーション・symlink防御 |
| `src/lib/file-operations.ts` | ファイルCRUD操作（5層セキュリティ） |
| `src/lib/clone-manager.ts` | クローン処理管理（排他制御） |
| `src/lib/version-checker.ts` | バージョンアップ通知 |
| `src/lib/slash-commands.ts` | スラッシュコマンドローダー |
| `src/lib/url-path-encoder.ts` | ファイルパスURLエンコード |
| `src/lib/file-search.ts` | ファイル内容検索 |
| `src/lib/terminal-highlight.ts` | CSS Custom Highlight API ラッパー（Issue #47）XSS安全なターミナルハイライト |
| `src/lib/file-tree.ts` | ディレクトリツリー構造生成 |
| `src/lib/git-utils.ts` | Git情報取得・コミット履歴/diff取得（Issue #447） |
| `src/types/git.ts` | Git関連型定義（CommitInfo, ChangedFile, GitLogResponse等）（Issue #447） |
| `src/lib/sidebar-utils.ts` | サイドバーソート・グループ化ユーティリティ（SortKey, SortDirection, ViewMode型, BranchGroup型, sortBranches(), groupBranches()）（Issue #449） |
| `src/contexts/SidebarContext.tsx` | サイドバー状態管理Context（isOpen, sortKey, viewMode, localStorageパターン）（Issue #449） |
| `src/lib/utils.ts` | 汎用ユーティリティ |
| `src/lib/date-utils.ts` | 相対時刻フォーマット |
| `src/lib/clipboard-utils.ts` | クリップボードコピー |
| `src/lib/pasted-text-helper.ts` | Pasted text検知・Enter再送 |
| `src/lib/api-logger.ts` | 開発環境APIロギング |
| `src/lib/log-export-sanitizer.ts` | エクスポート用データサニタイズ |
| `src/i18n.ts` | next-intl設定 |
| `src/lib/locale-cookie.ts` | ロケールCookie管理 |
| `src/lib/date-locale.ts` | date-fnsロケールマッピング |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | Worktree詳細画面（メイン画面、ツリーポーリング対応）（Issue #469） |
| `src/components/worktree/AgentSettingsPane.tsx` | エージェント選択UI |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力（下書き永続化対応） |
| `src/components/worktree/MarkdownEditor.tsx` | マークダウンエディタ（auto-save対応） |
| `src/components/worktree/TerminalSearchBar.tsx` | ターミナル内テキスト検索バーUI（Issue #47）件数表示・前/次ナビ・Esc閉じ |
| `src/components/worktree/FilePanelSplit.tsx` | ターミナル+ファイルパネル分割 |
| `src/components/worktree/FilePanelTabs.tsx` | ファイルタブバーUI |
| `src/components/worktree/FilePanelContent.tsx` | ファイルコンテンツ表示（ファイル内容ポーリング対応）（Issue #469） |
| `src/components/worktree/FileViewer.tsx` | ファイルビューア |
| `src/components/worktree/FileSearchBar.tsx` | ファイル検索バー共通コンポーネント（Issue #469） |
| `src/components/worktree/FileTreeView.tsx` | ファイルツリー表示 |
| `src/components/worktree/GitPane.tsx` | Gitタブ（コミット履歴・diff表示）（Issue #447） |
| `src/hooks/useFilePolling.ts` | ポーリングライフサイクル管理（visibilitychange対応）（Issue #469） |
| `src/hooks/useFileContentPolling.ts` | ファイル内容ポーリング（If-Modified-Since/304）（Issue #469） |
| `src/hooks/useFileContentSearch.ts` | ファイル内容検索共通フック（Issue #469） |
| `src/hooks/useFileTabs.ts` | タブ状態管理フック（isDirty管理対応）（Issue #469） |
| `src/hooks/useImageAttachment.ts` | 画像添付カスタムフック（バリデーション・アップロード・状態管理・resetAfterSend）（Issue #474） |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック |
| `src/hooks/useTerminalSearch.ts` | ターミナル内テキスト検索フック（Issue #47）debounce 300ms、最大500件、最小2文字 |
| `src/hooks/useFragmentLogin.ts` | フラグメントベース自動ログイン |
| `src/app/api/worktrees/[id]/terminal/route.ts` | ターミナルコマンド送信API |
| `src/app/api/worktrees/[id]/capture/route.ts` | ターミナル出力キャプチャAPI |
| `src/app/api/worktrees/[id]/marp-render/route.ts` | MARPスライドレンダリングAPI |
| `src/app/api/worktrees/[id]/git/log/route.ts` | Gitコミット履歴取得API（Issue #447） |
| `src/app/api/worktrees/[id]/git/show/[commitHash]/route.ts` | Gitコミット変更ファイル一覧API（Issue #447） |
| `src/app/api/worktrees/[id]/git/diff/route.ts` | Gitファイルdiff取得API（Issue #447） |
| `src/app/api/worktrees/[id]/special-keys/route.ts` | 特殊キー送信API（Up/Down/Enter/Escape、6層防御）（Issue #473） |
| `src/components/worktree/NavigationButtons.tsx` | OpenCode TUI選択リストナビゲーションボタン（Issue #473） |

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
| `src/cli/utils/` | preflight, env-setup, daemon, pid-manager, port-allocator 等 |
| `src/cli/types/index.ts` | CLI共通型定義 |

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
