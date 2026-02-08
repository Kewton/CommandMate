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
| `src/lib/cli-patterns.ts` | CLIツール別パターン定義 |
| `src/lib/status-detector.ts` | セッションステータス検出の共通関数（Issue #180: route.tsインラインロジック統合、hasActivePrompt、15行ウィンドウイング） |
| `src/lib/claude-session.ts` | Claude CLI tmuxセッション管理（Issue #152で改善: プロンプト検出強化、タイムアウトエラー、waitForPrompt()） |
| `src/lib/prompt-detector.ts` | プロンプト検出ロジック（Issue #161: 2パス❯検出方式で誤検出防止、連番検証） |
| `src/lib/auto-yes-manager.ts` | Auto-Yes状態管理とサーバー側ポーリング（Issue #138）、thinking状態のprompt検出スキップ（Issue #161） |
| `src/lib/auto-yes-resolver.ts` | Auto-Yes自動応答判定ロジック |
| `src/hooks/useAutoYes.ts` | Auto-Yesクライアント側フック（重複応答防止対応） |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/session-cleanup.ts` | セッション/ポーラー停止の一元管理（Facade パターン） |
| `src/lib/url-normalizer.ts` | Git URL正規化（重複検出用） |
| `src/lib/clone-manager.ts` | クローン処理管理（DBベース排他制御） |
| `src/lib/db-repository.ts` | リポジトリDB操作関数群（Issue #190: 除外・復活・パス正規化・バリデーション関数追加） |
| `src/types/sidebar.ts` | サイドバーステータス判定 |
| `src/types/clone.ts` | クローン関連型定義（CloneJob, CloneError等） |
| `src/lib/file-operations.ts` | ファイル操作（読取/更新/作成/削除/リネーム） |
| `src/lib/git-utils.ts` | Git情報取得（getGitStatus関数、execFile使用、1秒タイムアウト） |
| `src/lib/utils.ts` | 汎用ユーティリティ関数（debounce、truncateString等） |
| `src/config/editable-extensions.ts` | 編集可能ファイル拡張子設定 |
| `src/config/file-operations.ts` | 再帰削除の安全設定 |
| `src/types/markdown-editor.ts` | マークダウンエディタ関連型定義 |
| `src/hooks/useContextMenu.ts` | コンテキストメニュー状態管理フック（MouseEvent/TouchEvent対応） |
| `src/hooks/useLongPress.ts` | タッチ長押し検出フック（Issue #123、500ms閾値、10px移動キャンセル） |
| `src/hooks/useFullscreen.ts` | Fullscreen API ラッパー（CSSフォールバック対応） |
| `src/hooks/useLocalStorageState.ts` | localStorage永続化フック（バリデーション対応） |
| `src/config/z-index.ts` | z-index値の一元管理 |
| `src/config/uploadable-extensions.ts` | アップロード可能拡張子・MIMEタイプ・マジックバイト検証 |
| `src/config/image-extensions.ts` | 画像ファイル拡張子・マジックバイト・SVG XSS検証 |
| `src/config/mermaid-config.ts` | mermaid設定定数（securityLevel='strict'） |
| `src/config/binary-extensions.ts` | バイナリファイル拡張子設定（検索除外用） |
| `src/lib/file-search.ts` | ファイル内容検索ロジック（EXCLUDED_PATTERNSフィルタ、AbortControllerタイムアウト） |
| `src/components/worktree/SearchBar.tsx` | 検索UIコンポーネント（検索入力、モード切替、ローディング表示） |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック（debounce処理、API呼び出し、結果管理） |
| `src/components/worktree/ImageViewer.tsx` | 画像表示コンポーネント |
| `src/components/worktree/MermaidDiagram.tsx` | mermaidダイアグラム描画コンポーネント |
| `src/components/worktree/MermaidCodeBlock.tsx` | mermaidコードブロックラッパー |

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
| `src/cli/config/cli-dependencies.ts` | 依存関係定義 |
| `src/cli/types/index.ts` | CLI共通型定義（ExitCode enum、StartOptions、StopOptions、StatusOptions） |

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

mainブランチへの直接pushを防止するpre-push hookが設置されています。

**設置場所**: `.git/hooks/pre-push`

**動作**:
```bash
$ git push origin main
❌ Error: Direct push to 'main' is not allowed.
   Please create a Pull Request instead.
```

**新規クローン時の設定**:
`.git/hooks/`はgit管理外のため、クローン後に手動設定が必要です。

```bash
cat > .git/hooks/pre-push << 'EOF'
#!/bin/bash
protected_branch='main'
while read local_ref local_sha remote_ref remote_sha; do
    remote_branch=$(echo "$remote_ref" | sed 's,.*/,,')
    if [ "$remote_branch" = "$protected_branch" ]; then
        echo ""
        echo "❌ Error: Direct push to '$protected_branch' is not allowed."
        echo "   Please create a Pull Request instead."
        echo ""
        exit 1
    fi
done
exit 0
EOF
chmod +x .git/hooks/pre-push
```

**注意**: `--no-verify`オプションで回避可能なため、チームルールとしての遵守が重要です。

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

### Issue #191: Auto-Yes detectThinking() ウィンドウイング修正
- **バグ修正**: Auto-Yesモード有効時、tmuxバッファ内に残存する過去のthinkingサマリー行（例: `· Simmering… (4m 16s)`）が`detectThinking()`にマッチし、プロンプト検出が永続的にスキップされる問題を修正
- **根本原因**: `auto-yes-manager.ts`の`pollAutoYes()`が`detectThinking()`に5000行バッファ全体を渡していたのに対し、`status-detector.ts`や`current-output/route.ts`は既に末尾15行に限定していた（一貫性の欠如）
- **修正方針**: `detectThinking()`呼び出し前にバッファ末尾50行のウィンドウイングを適用
- **ウィンドウサイズ50行の根拠**: `detectPrompt()`のmultiple_choice検出範囲（`prompt-detector.ts` L268: 末尾50行）と一致させ、Issue #161 Layer 1防御の整合性を維持
- **SF-001対応**: `THINKING_CHECK_LINE_COUNT`と`prompt-detector.ts`のウィンドウサイズの意味的結合をテストで検証（共有定数ではなくテストベースの一致検証を採用。`prompt-detector.ts`のCLIツール非依存設計を維持）
- **主要コンポーネント**:
  - `src/lib/auto-yes-manager.ts` - `THINKING_CHECK_LINE_COUNT = 50`定数追加、`pollAutoYes()`ウィンドウイング適用
- 詳細: [設計書](./dev-reports/design/issue-191-auto-yes-thinking-windowing-design-policy.md)

### Issue #190: リポジトリ削除後のSync All復活防止
- **バグ修正**: UIで削除したリポジトリがSync All実行時に再スキャン・再登録されて復活する問題を修正
- **根本原因**: `syncWorktreesToDB()`が環境変数パスを毎回スキャンし、削除されたリポジトリを除外する仕組みがなかった
- **修正方針**: 既存`repositories.enabled`カラム（Migration #14）を活用し、削除時に`enabled=0`で除外マーク。Sync All時に`enabled=0`のパスを除外フィルタリング
- **主要な変更点**:
  - `db-repository.ts`に7関数追加: `resolveRepositoryPath()`, `ensureEnvRepositoriesRegistered()`, `filterExcludedPaths()`, `disableRepository()`, `getExcludedRepositoryPaths()`, `getExcludedRepositories()`, `restoreRepository()`, `validateRepositoryPath()`
  - DELETE APIで`disableRepository()`を`worktreeIds`チェック前に配置（未Syncリポジトリも除外対応）
  - Sync APIで`ensureEnvRepositoriesRegistered()` + `filterExcludedPaths()`による除外フィルタリング
  - 新規API: `GET /api/repositories/excluded`（除外一覧）、`PUT /api/repositories/restore`（復活+自動sync）
  - UIに除外リポジトリ一覧セクション追加（折りたたみ形式、「再登録」ボタン付き）
- **セキュリティ対策**:
  - パストラバーサル防御（null byte + `isSystemDirectory()`チェック）
  - `MAX_DISABLED_REPOSITORIES = 1000`（DoS防止）
  - 固定エラーメッセージ（情報漏洩防止）
- **主要コンポーネント**:
  - `src/lib/db-repository.ts` - 除外・復活・パス正規化・バリデーション関数群
  - `src/app/api/repositories/route.ts` - DELETE handler修正
  - `src/app/api/repositories/sync/route.ts` - Sync handler修正
  - `src/app/api/repositories/excluded/route.ts` - 新規: 除外リポジトリ一覧API
  - `src/app/api/repositories/restore/route.ts` - 新規: 復活API
  - `src/lib/api-client.ts` - `getExcluded()`, `restore()`メソッド追加
  - `src/components/worktree/WorktreeList.tsx` - 削除ダイアログ更新、除外リポジトリセクション追加
- 詳細: [設計書](./dev-reports/design/issue-190-repository-exclusion-on-sync-design-policy.md)

### Issue #159: infoタブにてアプリバージョン表示
- **機能追加**: Worktree詳細画面のinfoタブ（デスクトップ: InfoModal、モバイル: MobileInfoContent）にCommandMateのアプリバージョンを表示
- **ビルド時環境変数方式**: `next.config.js` の `env` ブロックで `package.json` の `version` を `NEXT_PUBLIC_APP_VERSION` として公開
- **DRY対応**: モジュールレベル定数 `APP_VERSION_DISPLAY` で `v` プレフィックス付与・フォールバック `-` を集約
- **主要コンポーネント**:
  - `next.config.js` - `env.NEXT_PUBLIC_APP_VERSION` 追加
  - `src/components/worktree/WorktreeDetailRefactored.tsx` - InfoModal・MobileInfoContent にバージョン表示セクション追加
- 詳細: [設計書](./dev-reports/design/issue-159-info-tab-app-version-design-policy.md)

### Issue #180: ステータス表示の不整合修正
- **問題解決**: CLIがidle状態（`❯`プロンプト表示）であるにも関わらず、UIが「running」（スピナー）や「waiting」（黄色）ステータスを誤表示する問題を修正
- **根本原因**: `route.ts`の`detectPrompt()`に`cleanOutput`全文（最大100行）を渡していたため、スクロールバックに残る過去の`(y/n)`プロンプトを現在アクティブなプロンプトとして誤検出
- **修正方針**: `status-detector.ts`の`detectSessionStatus()`を共通関数として活用し、`route.ts`x2のインラインロジックを統合（DRY原則）
- **主要な変更点**:
  - `StatusDetectionResult`に`hasActivePrompt: boolean`フィールド追加（SRP遵守、カプセル化維持）
  - `detectSessionStatus()`が生のtmux出力を受け取る入力契約を明確化（stripAnsi二重呼び出し防止）
  - 15行ウィンドウイングにより過去のプロンプト誤検出を防止
- **主要コンポーネント**:
  - `src/lib/status-detector.ts` - セッションステータス検出共通関数（hasActivePrompt追加）
  - `src/app/api/worktrees/route.ts` - インラインロジック→detectSessionStatus()呼び出しに統合
  - `src/app/api/worktrees/[id]/route.ts` - 同上
- 詳細: [設計書](./dev-reports/design/issue-180-status-display-inconsistency-design-policy.md)

### Issue #161: Auto-Yes誤検出修正（番号付きリストの誤検出防止）
- **問題解決**: Auto-Yesモード有効時、Claude CLIの通常出力に含まれる番号付きリスト（例：「1. ファイルを作成」「2. テストを実行」）がmultiple_choiceプロンプトとして誤検出され、「1」が自動送信される問題を修正
- **根本原因**: `detectMultipleChoicePrompt`の`optionPattern`の`[❯ ]`文字クラスが空白文字も許容し、通常の番号付きリストが選択肢として蓄積されていた
- **2パス❯検出方式**（多層防御Layer 2）:
  - パス1: 50行ウィンドウ内で❯インジケーターの存在を確認
  - パス2: ❯が存在する場合のみ選択肢行を収集
  - ❯が存在しない場合、通常の番号付きリストは一切検出されない
- **thinking状態スキップ**（多層防御Layer 1）:
  - `auto-yes-manager.ts`の`pollAutoYes()`で`detectThinking()`による事前チェック
  - thinking中は`detectPrompt()`をスキップ
  - Issue #191: 末尾50行のウィンドウ検索を使用し、過去のthinkingサマリー行がプロンプト検出をブロックすることを防止
- **連番検証**（多層防御Layer 3、防御的措置）:
  - `isConsecutiveFromOne()`で選択肢番号が1始まり連番であることを検証
- **設計原則準拠**: prompt-detector.tsのCLIツール非依存性を維持（CLAUDE_THINKING_PATTERNをimportしない）
- **主要コンポーネント**:
  - `src/lib/prompt-detector.ts` - 2パス検出方式、連番検証（防御的措置）
  - `src/lib/auto-yes-manager.ts` - thinking状態のprompt検出スキップ
- 詳細: [設計書](./dev-reports/design/issue-161-auto-yes-false-positive-design-policy.md)

### Issue #151: worktree-cleanup サーバー検出機能改善
- **問題解決**: `/worktree-cleanup` スキル実行時、`npm run dev` で直接起動したサーバーを検出・停止できない問題を修正
- **ポートベース検出**: PIDファイル検出に加え、ポートベース検出をフォールバックとして追加
- **共通ライブラリ導入**:
  - `.claude/lib/validators.sh` - Issue番号検証関数（MAX_ISSUE_NO=2147483647）
  - `.claude/lib/process-utils.sh` - プロセス検出・停止関数群
- **検出対象ポート**:
  - デフォルトポート 3000
  - Issue専用ポート 3{issueNo}（4桁以下のIssue番号のみ）
- **OS互換性**: macOS（lsof -F n形式）とLinux（/proc/$PID/cwd）の両対応
- **セキュリティ対策**:
  - SEC-001: Issue番号検証（1-2147483647）
  - SEC-003: cwd検証による誤停止防止
  - SEC-006: プロセス終了の監査ログ（~/.commandmate/logs/security.log）
  - SEC-007: プロセスコマンド検証（node/npm）
- **主要コンポーネント**:
  - `.claude/lib/validators.sh` - Issue番号検証（validate_issue_no()）
  - `.claude/lib/process-utils.sh` - サーバー検出・停止（8関数）
  - `.claude/commands/worktree-cleanup.md` - Phase 1修正、Phase 2拡張
  - `.claude/commands/worktree-setup.md` - Phase 1検証範囲修正
- 詳細: [設計書](./dev-reports/design/issue-151-worktree-cleanup-server-detection-design-policy.md)

### Issue #152: セッション初回メッセージ送信の信頼性向上
- **問題解決**: 新規Worktree選択時に初回メッセージがClaude CLIに送信されない問題を解決
- **根本原因**: `startClaudeSession()`がタイムアウト超過でもエラーなく続行し、Claude CLI初期化前にメッセージ送信されていた
- **プロンプト検出強化**:
  - `CLAUDE_PROMPT_PATTERN`/`CLAUDE_SEPARATOR_PATTERN`をcli-patterns.tsから使用（DRY原則）
  - レガシー`>`と新形式`❯`(U+276F)の両方のプロンプト文字をサポート
- **タイムアウト処理改善**:
  - タイムアウト時に`Error('Claude initialization timeout (15000ms)')`をスロー
  - タイムアウト値を名前付き定数として抽出（OCP原則）
- **新規関数`waitForPrompt()`**:
  - メッセージ送信前にプロンプト状態を検証
  - タイムアウト時にエラースロー
- **安定待機追加**: プロンプト検出後に500ms待機（Claude CLI描画完了バッファ）
- **主要コンポーネント**:
  - `src/lib/claude-session.ts` - コア実装（startClaudeSession, waitForPrompt, sendMessageToClaude改善）
  - `src/lib/cli-patterns.ts` - CLAUDE_PROMPT_PATTERN, CLAUDE_SEPARATOR_PATTERN
- 詳細: [設計書](./dev-reports/design/issue-152-first-message-not-sent-design-policy.md)

### Issue #123: iPadタッチ長押しコンテキストメニュー
- **問題解決**: iPadでファイルツリーを長押ししてもコンテキストメニューが表示されない問題を解決
- **根本原因**: iPad Safari/Chromeでは`onContextMenu`イベントが長押しでトリガーされない仕様
- **実装内容**:
  - `useLongPress`フック新規作成（500ms閾値、10px移動キャンセル）
  - `useContextMenu`の`openMenu`を`MouseEvent | TouchEvent`に型拡張
  - `FileTreeView`にタッチイベントハンドラ統合
- **対応デバイス**: iPad Safari/Chrome, iPhone Safari/Chrome
- **CSS最適化**:
  - `touch-action: manipulation` - ダブルタップズーム抑制
  - `-webkit-touch-callout: none` - 標準コンテキストメニュー抑制
- **主要コンポーネント**:
  - `src/hooks/useLongPress.ts` - 長押し検出フック（LONG_PRESS_DELAY=500, MOVE_THRESHOLD=10）
  - `src/hooks/useContextMenu.ts` - コンテキストメニュー状態管理（TouchEvent対応）
  - `src/components/worktree/FileTreeView.tsx` - タッチイベント統合
- 詳細: [設計書](./dev-reports/design/issue-123-ipad-touch-context-menu-design-policy.md)

### Issue #138: サーバー側Auto-Yesポーリング
- **問題解決**: ブラウザのバックグラウンドタブで`setInterval`が抑制され、auto-yesが動作しない問題を解決
- **サーバー側ポーリング**: クライアントに依存せず、サーバーが直接プロンプトを検出して自動応答
- **ポーリング制御**: `startAutoYesPolling()`, `stopAutoYesPolling()`, `stopAllAutoYesPolling()`
- **エラーバックオフ**: 5回連続エラー後に指数バックオフ（最大60秒）
- **重複応答防止**: `lastServerResponseTimestamp`でクライアント側との同期
- **セキュリティ対策**:
  - worktreeID形式検証（コマンドインジェクション防止）
  - MAX_CONCURRENT_POLLERS=50（DoS防止）
  - ログへの機密情報非出力
- **クリーンアップ統合**:
  - session-cleanup.tsでworktree削除時に自動停止
  - server.tsのgracefulShutdownで全ポーラー停止
- **主要コンポーネント**:
  - `src/lib/auto-yes-manager.ts` - 状態管理とポーリングループ
  - `src/lib/auto-yes-resolver.ts` - 自動応答判定
  - `src/hooks/useAutoYes.ts` - クライアント側フォールバック（重複防止対応）
  - `src/app/api/worktrees/[id]/auto-yes/route.ts` - ポーリング開始/停止トリガー
  - `src/app/api/worktrees/[id]/current-output/route.ts` - タイムスタンプ提供
- 詳細: [設計書](./dev-reports/design/issue-138-server-side-auto-yes-polling-design-policy.md)

### Issue #153: Auto-Yes UIとバックグラウンドの状態不整合修正
- **バグ修正**: Auto-Yesモードを有効化後、モジュール再読み込み（ホットリロード/ワーカー再起動）が発生すると、バックグラウンドでは正常動作するがUIは「オフ」と表示される問題を修正
- **根本原因**: `auto-yes-manager.ts`のモジュールスコープMapがモジュール再読み込み時にリセットされる
- **解決策**: globalThisパターンを適用し、状態をプロセス内で永続化
- **コード変更**:
  ```typescript
  // Before: モジュールスコープMap（再読み込みでリセット）
  const autoYesStates = new Map<string, AutoYesState>();

  // After: globalThis参照（再読み込みでも永続化）
  declare global {
    var __autoYesStates: Map<string, AutoYesState> | undefined;
  }
  const autoYesStates = globalThis.__autoYesStates ??
    (globalThis.__autoYesStates = new Map<string, AutoYesState>());
  ```
- **制限事項**: マルチプロセス環境（クラスターモード等）では各プロセスが独自の状態を持つ。CommandMateは単一プロセス運用が前提のため許容
- **テスト追加**:
  - `tests/unit/lib/auto-yes-manager.test.ts` - globalThis初期化・クリア関数テスト（7件）
  - `tests/integration/auto-yes-persistence.test.ts` - `vi.resetModules()`によるモジュール再読み込みテスト（5件）
- **主要コンポーネント**:
  - `src/lib/auto-yes-manager.ts` - globalThis対応（約25行変更）
- **フォローアップ検討**: `response-poller.ts`, `claude-poller.ts`も同様のパターン適用候補（別Issue）
- 詳細: [設計書](./dev-reports/design/issue-153-auto-yes-state-inconsistency-design-policy.md)

### Issue #136: Git Worktree 並列開発環境の整備
- **目的**: 複数のIssue/機能を同時に開発できるWorktree環境を整備
- **CLIコマンド拡張**:
  - `commandmate start --issue {issueNo} [--auto-port]` - Issue専用サーバー起動
  - `commandmate stop --issue {issueNo}` - Issue専用サーバー停止
  - `commandmate status --issue {issueNo}` - Issue専用サーバー状態確認
  - `commandmate status --all` - 全サーバー状態確認
- **リソース分離**:
  - Issue専用DB: `~/.commandmate/data/cm-{issueNo}.db`
  - Issue専用PID: `~/.commandmate/pids/{issueNo}.pid`
  - ポート範囲: 3001-3100（メインは3000）
- **DBマイグレーション**: Migration #16でexternal_appsテーブルにissue_noカラム追加
- **セキュリティ対策**:
  - SEC-001: Issue番号の厳密な正整数検証（コマンドインジェクション防止）
  - SEC-002: ブランチ名のホワイトリスト検証（`[a-zA-Z0-9_/-]`）
  - SF-SEC-002: ポート枯渇攻撃対策（MAX_WORKTREES=10制限）
  - TOCTOU対策: ResourcePathResolver.validate()のtry-catchパターン
- **設計パターン**:
  - Strategy: ResourcePathResolver（DB, PID, Log）
  - Factory: DaemonManagerFactory
  - ISP準拠: WorktreeExternalApp派生型
- **スキル追加**:
  - `/worktree-setup {issueNo}` - Worktree環境の自動構築
  - `/worktree-cleanup {issueNo}` - Worktree環境のクリーンアップ
- **主要コンポーネント**:
  - `src/cli/utils/install-context.ts` - インストールコンテキスト検出
  - `src/cli/utils/input-validators.ts` - 入力検証（validateIssueNo, validateBranchName）
  - `src/cli/utils/resource-resolvers.ts` - リソースパス解決
  - `src/cli/utils/port-allocator.ts` - ポート自動割り当て
  - `src/cli/utils/daemon-factory.ts` - DaemonManagerファクトリー
  - `src/types/external-apps.ts` - WorktreeExternalApp型
  - `src/lib/external-apps/db.ts` - createWorktreeExternalApp(), getExternalAppsByIssueNo()
- 詳細: [設計書](./dev-reports/design/issue-136-worktree-parallel-dev-design-policy.md)

### Issue #135: DBパス解決ロジック修正
- **バグ修正**: グローバルインストール時のバージョンアップでDBが消失する問題を修正
- **根本原因**: `process.cwd()`依存のDBパス解決がグローバルインストールで予測不能な動作
- **修正内容**:
  - `getEnv().CM_DB_PATH`経由でDBパスを取得するよう統一
  - グローバルインストール: `~/.commandmate/data/cm.db`（絶対パス）
  - ローカルインストール: `<cwd>/data/cm.db`（絶対パスに解決）
- **マイグレーション機能**: 旧DB（`db.sqlite`）を自動検出し、新パスにマイグレーション
- **セキュリティ対策**:
  - SEC-001: システムディレクトリ保護（`/etc`, `/usr`等への書き込み禁止）
  - SEC-002: シンボリックリンク解決（TOCTOU攻撃防止）
  - SEC-003: ディレクトリ作成時に`mode: 0o700`
  - SEC-004: `DATABASE_PATH`使用時にdeprecation警告
  - SEC-005: `DATABASE_PATH`検証後にマイグレーション対象追加
  - SEC-006: バックアップファイルのパーミッション`0o600`
- **主要コンポーネント**:
  - `src/lib/db-path-resolver.ts` - DBパス解決（getDefaultDbPath(), validateDbPath()）
  - `src/lib/db-migration-path.ts` - マイグレーション（migrateDbIfNeeded()）
  - `src/lib/env.ts` - getDatabasePathWithDeprecationWarning()追加
  - `src/lib/db-instance.ts` - getEnv().CM_DB_PATH使用に変更
  - `src/config/system-directories.ts` - システムディレクトリ定数（DRY対応）
- 詳細: [設計書](./dev-reports/design/issue-135-db-path-resolution-design-policy.md)

### Issue #111: Gitブランチ可視化機能
- **ブランチ表示**: ワークツリー詳細画面のヘッダーに現在のgitブランチ名を表示
- **ブランチ不一致警告**: セッション開始時と現在のブランチが異なる場合、視覚的な警告を表示
- **モバイル対応**: モバイル表示でもブランチ情報が確認可能
- **定期更新**: ブランチ情報は定期的に更新（アクティブ時: 2秒、アイドル時: 5秒）
- **DBマイグレーション**: Migration #15でworktreesテーブルにinitial_branchカラム追加
- **セキュリティ対策**:
  - execFile使用によるコマンドインジェクション防止
  - 1秒タイムアウトによるDoS防止
  - React自動エスケープによるXSS防止
  - DBからの信頼パス取得によるパストラバーサル防止
- **エラーハンドリング**:
  - detached HEAD状態では警告を表示しない
  - gitコマンドタイムアウト時は`(unknown)`を返却しアプリは正常動作
- **主要コンポーネント**:
  - `src/lib/git-utils.ts` - Git情報取得ロジック（getGitStatus関数）
  - `src/components/worktree/BranchMismatchAlert.tsx` - ブランチ不一致警告コンポーネント
  - `src/types/models.ts` - GitStatus interface
  - `src/lib/db.ts` - saveInitialBranch, getInitialBranch関数
- 詳細: [設計書](./dev-reports/design/issue-111-branch-visualization-design-policy.md)

### Issue #21: ファイルツリー検索機能
- **検索UI**: ファイルツリー上部に検索バーを常時表示（デスクトップ）
- **検索モード切替**: ファイル名検索（クライアントサイド）/ ファイル内容検索（サーバーサイド）をトグルで切替
- **ファイル名検索**: 既にロード済みのツリーデータをフィルタリング（高速・APIコール不要）
- **ファイル内容検索**: サーバーサイドAPIで全文検索（5秒タイムアウト）
- **ツリーフィルタリング**: マッチしないファイルを非表示、マッチしたファイルの親ディレクトリを自動展開
- **ハイライト表示**: マッチ箇所を黄色ハイライト表示（XSS安全なReactコンポーネント方式）
- **セキュリティ対策**:
  - ReDoS対策（サーバーサイドで正規表現不使用、indexOf/includes使用）
  - ファイルパスは相対パスのみ返却
  - コンテンツ行500文字トランケート
  - 機密ファイル除外（EXCLUDED_PATTERNS適用）
  - 検索APIアクセスログ記録
  - パストラバーサル対策（isPathSafe使用）
  - XSS対策（React自動エスケープ、escapeRegExp使用）
- **主要コンポーネント**:
  - `src/config/binary-extensions.ts` - バイナリファイル拡張子設定
  - `src/lib/file-search.ts` - ファイル内容検索ロジック
  - `src/app/api/worktrees/[id]/search/route.ts` - 検索APIエンドポイント
  - `src/hooks/useFileSearch.ts` - 検索状態管理フック
  - `src/components/worktree/SearchBar.tsx` - 検索UIコンポーネント
- 詳細: [設計書](./dev-reports/design/issue-21-file-search-design-policy.md)

### Issue #114: npm install -g ドキュメント整備
- **ドキュメント更新**: `npm install -g commandmate` を標準セットアップ方法として明確化
- **対象ユーザーの分離**:
  - 一般ユーザー: `npm install -g commandmate`（推奨）
  - 開発者/コントリビューター: `git clone`
- **更新ファイル**:
  - `README.md` - Quick Startを npm install -g 方式に変更
  - `docs/DEPLOYMENT.md` - npm方式を追加、git clone を開発環境向けに移動
  - `docs/user-guide/webapp-guide.md` - 起動方法を更新
  - `docs/user-guide/quick-start.md` - 前提条件を追加
  - `CONTRIBUTING.md` - 開発者向けセットアップを明記
  - `docs/internal/TESTING_GUIDE.md` - 環境変数を `CM_*` に統一
  - `docs/internal/PRODUCTION_CHECKLIST.md` - npm方式を追加
- **新規ファイル**:
  - `docs/user-guide/cli-setup-guide.md` - CLIセットアップ専用ガイド（インストール、トラブルシューティング、アップグレード、アンインストール）
- **トラブルシューティング**: command not found、権限エラー、ポート競合の対応手順を文書化

### Issue #96: npm CLIサポート
- **CLIコマンド**: `npm install -g commandmate`でグローバルインストール可能
- **サブコマンド**:
  - `commandmate init` - 依存関係チェック、.env作成、DB初期化
  - `commandmate start` - サーバー起動（フォアグラウンド/デーモン）
  - `commandmate stop` - サーバー停止
  - `commandmate status` - サーバー状態確認
- **セキュリティ対策**:
  - spawnによるコマンドインジェクション対策（execSync禁止）
  - PIDファイルのアトミック書き込み（O_EXCL使用）
  - .envファイルのパーミッション0600
  - 入力値サニタイズ
  - セキュリティイベントログ
- **主要コンポーネント**:
  - `bin/commandmate.js` - CLIエントリポイント
  - `src/cli/index.ts` - commander設定
  - `src/cli/commands/` - サブコマンド実装
  - `src/cli/utils/preflight.ts` - 依存関係チェック
  - `src/cli/utils/env-setup.ts` - 環境設定
  - `src/cli/utils/daemon.ts` - デーモン管理
  - `src/cli/utils/pid-manager.ts` - PIDファイル管理
- **ビルド**: `npm run build:cli`（TypeScriptコンパイル）
- 詳細: [設計書](./dev-reports/design/issue-96-npm-cli-design-policy.md)

### Issue #119: commandmate init 対話形式対応
- **対話形式初期化**: `commandmate init`でTTY環境時に対話形式で設定を入力
- **チルダ展開**: `~/repos`のようなパス入力を自動的にホームディレクトリに展開
- **設定サマリー表示**: 設定完了後に入力した設定値の一覧を表示
- **非対話モード**: `--defaults`オプションでCI/CD環境向けの非対話実行をサポート
- **.envファイル配置**:
  - グローバルインストール: `~/.commandmate/.env`
  - ローカルインストール: カレントディレクトリの`.env`
- **主要コンポーネント**:
  - `src/cli/utils/prompt.ts` - 対話形式プロンプトユーティリティ（prompt, confirm, expandTilde, validatePort）
  - `src/cli/commands/init.ts` - initコマンド（対話形式/非対話形式対応）
  - `src/cli/utils/env-setup.ts` - getEnvPath(), isGlobalInstall(), getConfigDir()追加

### Issue #125: グローバルインストール時の.env読み込み修正
- **バグ修正**: `start`/`stop`/`status`コマンドがグローバルインストール時に`~/.commandmate/.env`を正しく読み込むよう修正
- **getPidFilePath()追加**: PIDファイルパス取得をDRY原則に従いenv-setup.tsに集約
- **パストラバーサル対策**: `fs.realpathSync()`によるシンボリックリンク解決とホームディレクトリ外チェック
- **セキュリティ警告**: CM_BIND=0.0.0.0の場合に外部公開警告、認証トークン未設定時に追加警告
- **環境変数伝播**: `dotenv`パッケージを使用して.envを読み込み、子プロセスに環境変数を伝播
- **主要コンポーネント**:
  - `src/cli/utils/env-setup.ts` - getPidFilePath(), resolveSecurePath()追加
  - `src/cli/utils/daemon.ts` - dotenvによる.env読み込み、セキュリティ警告追加
  - `src/cli/commands/start.ts` - getEnvPath(), getPidFilePath()使用
  - `src/cli/commands/stop.ts` - getPidFilePath()使用
  - `src/cli/commands/status.ts` - getPidFilePath()使用、dotenvConfig()追加
- 詳細: [設計書](./dev-reports/design/issue-125-global-install-env-loading-design-policy.md)

### Issue #100: Mermaidダイアグラム描画機能
- **ダイアグラム描画**: マークダウンプレビューでmermaidコードブロックをSVGダイアグラムとして描画
- **対応ダイアグラム**: フローチャート、シーケンス図、ER図、ガントチャート、状態遷移図など（mermaid.js対応全種）
- **セキュリティ対策**:
  - `securityLevel='strict'`設定（XSS防止）
  - mermaid内部DOMPurifyによるサニタイズ
  - scriptタグ・イベントハンドラ・危険なURLスキーム除去
  - securityLevel検証フェイルセーフ機構
  - Issue #95 SVG XSS対策との整合性確保
- **SSR対応**: `next/dynamic`による遅延読み込み（`ssr: false`）
- **エラーハンドリング**: 構文エラー時のエラーメッセージ表示（UIクラッシュ防止）
- **ローディングUI**: Loader2スピナー付き
- **主要コンポーネント**:
  - `src/config/mermaid-config.ts` - mermaid設定定数（securityLevel, startOnLoad, theme）
  - `src/components/worktree/MermaidDiagram.tsx` - mermaid描画コンポーネント
  - `src/components/worktree/MermaidCodeBlock.tsx` - コードブロックラッパー（動的import）
  - `src/components/worktree/MarkdownEditor.tsx` - ReactMarkdown components prop統合
- **テスト**: XSS回帰テスト、セキュリティ設定検証テスト、Issue #95整合性テスト
- 詳細: [設計書](./dev-reports/design/issue-100-mermaid-diagram-design-policy.md)

### Issue #95: 画像ファイルビューワ
- **画像表示**: FileTreeViewで選択した画像ファイルをビューワ領域に表示
- **対応ファイル形式**: PNG, JPG/JPEG, GIF, WebP, SVG
- **表示制約**: 最大幅100%、最大高さ500px（アスペクト比維持）
- **ファイルサイズ制限**: 最大5MB
- **セキュリティ対策**:
  - マジックバイト検証（PNG, JPEG, GIF, WebP）
  - WebP完全検証（RIFFヘッダー+WEBPシグネチャ）
  - SVG XSS対策（5項目）:
    - scriptタグ拒否
    - イベントハンドラ属性（on*）拒否
    - javascript:/data:/vbscript:スキーム拒否
    - foreignObject要素拒否
  - パストラバーサル防止（isPathSafe()）
- **API拡張**: GET `/api/worktrees/:id/files/:path` が画像ファイルをBase64 data URIで返却
- **レスポンス拡張**: `isImage`, `mimeType` フィールド追加
- **主要コンポーネント**:
  - `src/config/image-extensions.ts` - 画像拡張子・マジックバイト・SVG XSS検証ロジック
  - `src/components/worktree/ImageViewer.tsx` - 画像表示コンポーネント
  - `src/components/worktree/FileViewer.tsx` - 画像/テキスト条件分岐
  - `src/types/models.ts` - FileContent interface（isImage, mimeType追加）
- 詳細: [設計書](./dev-reports/design/issue-95-image-viewer-design-policy.md)

### Issue #94: ファイルアップロード機能
- **ファイルアップロード**: FileTreeViewで指定したディレクトリにファイルをアップロード可能
- **対応ファイル形式**: 画像（.png, .jpg, .jpeg, .gif, .webp）、テキスト（.txt, .log）、マークダウン（.md）、CSV（.csv）、設定（.json, .yaml, .yml）
- **ファイルサイズ制限**: 1ファイルあたり最大5MB
- **セキュリティ対策**:
  - マジックバイト検証（拡張子偽装防止）
  - MIMEタイプ検証
  - パストラバーサル防止（isPathSafe()）
  - ファイル名検証（制御文字、OS禁止文字）
  - SVG除外（XSSリスク回避）
  - YAML危険タグ検出
  - JSON構文検証
- **アップロードAPI**: `POST /api/worktrees/:id/upload/:path`（multipart/form-data）
- **UIトリガー**: 右クリックメニューから「ファイルをアップロード」選択
- **フィードバック**: Toast通知（成功/エラー）、ファイルツリー自動更新
- **主要コンポーネント**:
  - `src/config/uploadable-extensions.ts` - アップロード可能拡張子・検証ロジック
  - `src/app/api/worktrees/[id]/upload/[...path]/route.ts` - アップロードAPIエンドポイント
- 詳細: [設計書](./dev-reports/design/issue-94-file-upload-design-policy.md)

### Issue #113: server.tsビルド済みJS変換
- **tsx依存解消**: `npm install -g commandmate`後の`tsx: command not found`エラーを解消
- **ビルド方式**: `server.ts`を事前にJavaScriptにコンパイルし、`node dist/server/server.js`で実行
- **tsc-alias導入**: @/パスエイリアスをビルド時に相対パスに変換
- **TypeScript設定共通化**: `tsconfig.base.json`で共通設定を集約（DRY原則）
- **CI/CD更新**: `ci-pr.yml`と`publish.yml`に`build:server`ステップを追加
- **主要コンポーネント**:
  - `tsconfig.base.json` - 共通TypeScript設定
  - `tsconfig.server.json` - サーバービルド設定（依存ファイルのみをinclude）
  - `dist/server/server.js` - ビルド済みサーバーエントリポイント
- 詳細: [設計書](./dev-reports/design/issue-113-server-build-design-policy.md)

### Issue #112: サイドバートグルパフォーマンス改善
- **transform方式**: width方式からtransform方式に変更し、GPUアクセラレーションを活用
- **Reflow回避**: translate-x-0/-translate-x-fullでアニメーション、レイアウト再計算を削減
- **iPad最適化**: iPadでのサイドバー開閉時のモッサリ感を解消
- **z-index管理**: SIDEBAR定数（30）をz-index.tsに追加、階層管理を一元化
- **アクセシビリティ**: aria-hidden属性をisOpen状態に連動
- **主要コンポーネント**:
  - `src/components/layout/AppShell.tsx` - デスクトップレイアウトのtransform方式実装
  - `src/config/z-index.ts` - SIDEBAR定数追加（DROPDOWN(10) < SIDEBAR(30) < MODAL(50)）
- 詳細: [設計書](./dev-reports/design/issue-112-sidebar-transform-design-policy.md)

### Issue #99: マークダウンエディタ表示機能改善
- **最大化機能**: エディタを画面全体に最大化表示（Ctrl/Cmd+Shift+F、ESCで解除）
- **リサイズ機能**: Split View時にドラッグでエディタ/プレビュー比率を変更（ダブルクリックで50:50リセット）
- **モバイル対応**: 縦向き時はタブ切替UI、スワイプダウンで最大化解除
- **状態永続化**: リサイズ比率と最大化状態をlocalStorageに保存・復元
- **Fullscreen API**: CSSフォールバック対応（iOS Safari等）
- **主要コンポーネント**:
  - `src/hooks/useFullscreen.ts` - Fullscreen API ラッパー
  - `src/hooks/useLocalStorageState.ts` - localStorage永続化フック
  - `src/config/z-index.ts` - z-index値の一元管理
  - `src/components/worktree/PaneResizer.tsx` - onDoubleClick, minRatio props追加
- 詳細: [設計書](./dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md)

### Issue #49: マークダウンエディタとビューワー
- **マークダウンエディタ**: GUIからマークダウンファイルの作成・編集・保存が可能
- **リアルタイムプレビュー**: 分割ビュー / エディタのみ / プレビューのみの3モード切替
- **ファイル操作API**: PUT（更新）/ POST（作成）/ DELETE（削除）/ PATCH（リネーム）
- **右クリックメニュー**: FileTreeViewで新規ファイル/ディレクトリ作成、リネーム、削除
- **セキュリティ対策**: XSS保護（rehype-sanitize）、パストラバーサル防止（isPathSafe）、再帰削除の安全ガード
- **主要コンポーネント**:
  - `src/components/worktree/MarkdownEditor.tsx` - エディタ本体
  - `src/components/worktree/ContextMenu.tsx` - 右クリックメニュー
  - `src/components/common/Toast.tsx` - 通知コンポーネント
  - `src/lib/file-operations.ts` - ファイル操作ビジネスロジック
  - `src/hooks/useContextMenu.ts` - コンテキストメニュー状態管理
- **対応拡張子**: .md（編集可能拡張子は`src/config/editable-extensions.ts`で管理）
- 詳細: [設計書](./dev-reports/design/issue-49-markdown-editor-design-policy.md)

### Issue #77: 設定・コード内の名称置換（CommandMateリネーム Phase 3）
- **設定ファイル更新**: `.env.example`を新名称（CM_*）に更新、旧名称はコメントアウトで残存
- **package.json変更**: `name`を`mycodebranch-desk`から`commandmate`に変更
- **Env interface更新**: `src/lib/env.ts`のプロパティ名を`CM_*`に統一
- **シェルスクリプト更新**: 10ファイルをCommandMateブランディングとフォールバック対応
- **TypeScriptスクリプト更新**: 5ファイルのDBパスを`cm.db`に変更
- **テストコード修正**: 環境変数参照を`CM_*`に更新、E2Eテストのスキップ解除
- **CHANGELOG更新**: 破壊的変更を記録
- 詳細: [設計書](./dev-reports/design/issue-77-rename-phase3-design-policy.md)

### Issue #76: 環境変数フォールバック（CommandMateリネーム Phase 1）
- **フォールバック機能**: 新名称`CM_*`と旧名称`MCBD_*`の両方をサポート
- **対象環境変数**: 7種類（ROOT_DIR, PORT, BIND, LOG_LEVEL, LOG_FORMAT, LOG_DIR, DB_PATH）
- **Deprecation警告**: 旧名称使用時にログ出力（同一キー1回のみ）
- **Note**: AUTH_TOKEN関連はIssue #179で廃止済み。リバースプロキシ認証を推奨
- **コアモジュール**: `src/lib/env.ts`に`getEnvWithFallback()`, `getEnvByKey()`関数追加
- **CHANGELOG**: Keep a Changelogフォーマットで新規作成
- 詳細: [設計書](./dev-reports/design/issue-76-env-fallback-design-policy.md)

### Issue #71: クローンURL登録機能
- **クローンAPI**: `POST /api/repositories/clone` エンドポイント（非同期ジョブ）
- **ジョブ状態API**: `GET /api/repositories/clone/[jobId]` でポーリング
- **URL正規化**: HTTPS/SSH URL を正規化し重複登録を防止 (`url-normalizer.ts`)
- **DBスキーマ**: `repositories` テーブル（Migration #14）で独立管理
- **排他制御**: 同一URLの同時クローン防止（DBベース）
- **UIモード切替**: ローカルパス / クローンURL タブ切替
- **worktrees自動登録**: クローン完了時に自動でworktreesテーブルに登録
- **セキュリティ**: パストラバーサル対策（カスタムパス検証）
- 詳細: [設計書](./dev-reports/design/issue-71-clone-url-registration-design-policy.md)

### Issue #69: リポジトリ削除機能
- **削除API**: `DELETE /api/repositories` エンドポイント
- **セッションクリーンアップ**: Facadeパターンでポーラー停止を一元管理 (`session-cleanup.ts`)
- **段階的エラーハンドリング**: セッションkill失敗時もDB削除は続行
- **確認ダイアログ**: `delete`入力による誤削除防止
- **環境変数警告**: `WORKTREE_REPOS`設定リポジトリに警告表示
- 詳細: [設計書](./dev-reports/design/issue-69-repository-delete-design-policy.md)

### Issue #31: サイドバーのUX改善
- **リアルタイムステータス検出**: ターミナル出力を直接解析
- **ステータス色**: idle(グレー) / ready(緑) / running(スピナー) / waiting(黄)
- **ポーリング間隔**: 2秒
- 詳細: [ステータスインジケーター](./docs/features/sidebar-status-indicator.md)

### Issue #22: マルチタスクサイドバー
- **2カラムレイアウト**: デスクトップでサイドバー常時表示
- **ブランチ一覧**: リアルタイムステータス付き
- **ソート機能**: 更新日時、リポジトリ名、ブランチ名、ステータス

### Issue #4: CLIツールサポート（Codex CLI追加）
- **対応ツール**: Claude Code, Codex CLI
- **Strategy パターン**: 拡張可能な設計（BaseCLITool抽象クラス）
- **Codexタブ有効化**: WorktreeDetailにCodexタブを追加
- **個別セッション終了**: Claude/Codex/Geminiを個別に終了可能（確認ダイアログ付き）
- **セッション終了確認ダイアログ**: ENDボタン押下時にModal確認ダイアログを表示（誤操作防止）
- **CLI別ステータスドット**: サイドバーとCLIタブにClaude/Codex個別のステータスインジケータを表示
- **モバイルCLIタブ切替**: モバイル表示でAuto Yesトグルとインラインで配置
- **レスポンス保存バグ修正**: tmuxバッファの空行パディングによる行数不整合を修正（assistant-response-saver.ts）
- **セキュリティ対策**: sessionName検証によるコマンドインジェクション防止
- **パターン拡張**: CODEX_THINKING_PATTERNにRan, Deciding追加
- **スラッシュコマンドフィルタリング**: CLIツール別にスラッシュコマンドをフィルタリング
  - Claude標準（16）: 既存コマンドを維持（`/clear`, `/compact`, `/resume`, `/rewind`, `/config`, `/model`, `/permissions`, `/status`, `/context`, `/cost`, `/review`, `/pr-comments`, `/help`, `/doctor`, `/export`, `/todos`）
  - Codex専用（10）: `/new`, `/undo`, `/logout`, `/quit`, `/approvals`, `/diff`, `/mention`, `/mcp`, `/init`, `/feedback`
- **主要コンポーネント**:
  - `src/lib/cli-tools/validation.ts` - sessionName検証（SESSION_NAME_PATTERN）
  - `src/lib/cli-tools/types.ts` - CLI_TOOL_IDS定数、CLIToolType派生
  - `src/lib/cli-tools/manager.ts` - stopPollers()メソッド追加
  - `src/lib/cli-patterns.ts` - Codexパターン拡張
  - `src/lib/standard-commands.ts` - CLIツール別コマンド定義
  - `src/lib/command-merger.ts` - filterCommandsByCliTool()関数
  - `src/app/api/worktrees/[id]/kill-session/route.ts` - cliToolパラメータ対応
  - `src/app/api/worktrees/[id]/slash-commands/route.ts` - cliToolクエリパラメータ対応
  - `src/components/worktree/WorktreeDetailRefactored.tsx` - 確認ダイアログ、CLI別ステータスドット
  - `src/components/sidebar/BranchListItem.tsx` - サイドバーCLI別ステータスドット
  - `src/types/sidebar.ts` - deriveCliStatus()、SidebarBranchItem.cliStatus拡張
  - `src/lib/assistant-response-saver.ts` - tmuxバッファ行数トリミング修正
- 詳細: [設計書](./dev-reports/design/issue-4-codex-cli-support-design-policy.md)

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
