# CLAUDE.md

このドキュメントはClaude Code向けのプロジェクトガイドラインです。

---

## ⚠️ 重要: モジュール詳細を CLAUDE.md に書かないこと

- モジュールの実装詳細・関数シグネチャ・Issue 履歴は **必ず [docs/module-reference.md](./docs/module-reference.md)** に記載する（CLAUDE.md には書かない）
- CLAUDE.md は brief overview のみ。各 module 説明は **1 行 100 文字以内** を厳守
- `Issue #N で…追加` のような履歴 narrative を CLAUDE.md に append しない。履歴は git log / CHANGELOG / PR description で辿る
- docs/module-reference.md も append-only で肥大化させない（既存行の更新を優先する）
- 違反すると CI でブロックされる（`## 品質担保` の CLAUDE.md size check 参照）

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

### モジュール一覧

各モジュールの責務・関数シグネチャ・Issue 履歴は [docs/module-reference.md](./docs/module-reference.md) を参照。

> **重要**: モジュール詳細を CLAUDE.md に記述しないこと。詳細・Issue 履歴は必ず docs/module-reference.md に書く。

---

## 品質担保

### 必須チェック（CI/CD）
- ESLint: `npm run lint`
- TypeScript: `npx tsc --noEmit`
- Unit Test: `npm run test:unit`
- Build: `npm run build`
- **CLAUDE.md size check**: `CLAUDE.md` は **35,000 bytes 以下**（CI で hard-fail）。超過した場合は詳細を [docs/module-reference.md](./docs/module-reference.md) へ移送すること（Issue #809）

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
