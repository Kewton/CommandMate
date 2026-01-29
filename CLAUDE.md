# CLAUDE.md

このドキュメントはClaude Code向けのプロジェクトガイドラインです。

---

## プロジェクト概要

### 基本情報
- **プロジェクト名**: CommandMate
- **説明**: Git worktree管理とClaude CLI/tmuxセッション統合ツール
- **リポジトリ**: https://github.com/Kewton/MyCodeBranchDesk

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
src/
├── app/           # Next.js App Router
│   └── api/       # APIルート
├── components/    # UIコンポーネント
│   ├── sidebar/   # サイドバー関連
│   ├── mobile/    # モバイル専用
│   └── worktree/  # ワークツリー詳細
├── config/        # 設定（ステータス色など）
├── contexts/      # React Context
├── lib/           # ユーティリティ・ビジネスロジック
│   └── cli-tools/ # CLIツール抽象化層
└── types/         # 型定義
```

### 主要機能モジュール

| モジュール | 説明 |
|-----------|------|
| `src/lib/env.ts` | 環境変数取得・フォールバック処理 |
| `src/config/status-colors.ts` | ステータス色の一元管理 |
| `src/lib/cli-patterns.ts` | CLIツール別パターン定義 |
| `src/lib/prompt-detector.ts` | プロンプト検出ロジック |
| `src/lib/cli-tools/` | CLIツール抽象化（Strategy パターン） |
| `src/lib/session-cleanup.ts` | セッション/ポーラー停止の一元管理（Facade パターン） |
| `src/lib/url-normalizer.ts` | Git URL正規化（重複検出用） |
| `src/lib/clone-manager.ts` | クローン処理管理（DBベース排他制御） |
| `src/lib/db-repository.ts` | リポジトリDB操作関数群 |
| `src/types/sidebar.ts` | サイドバーステータス判定 |
| `src/types/clone.ts` | クローン関連型定義（CloneJob, CloneError等） |

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

2. **force push禁止**
   - `git push --force` は原則禁止
   - 例外: 自分のfeatureブランチのみ許可

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
npm run build

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
| `/issue-split` | Issue分割計画 |
| `/architecture-review` | アーキテクチャレビュー（サブエージェント対応） |
| `/apply-review` | レビュー指摘事項の実装反映 |
| `/multi-stage-review` | 4段階レビュー（通常→整合性→影響分析→セキュリティ） |
| `/design-policy` | 設計方針策定 |

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

---

## 最近の実装機能

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
- **対象環境変数**: 8種類（ROOT_DIR, PORT, BIND, AUTH_TOKEN, LOG_LEVEL, LOG_FORMAT, LOG_DIR, DB_PATH）
- **クライアント側**: `NEXT_PUBLIC_CM_AUTH_TOKEN` / `NEXT_PUBLIC_MCBD_AUTH_TOKEN`のフォールバック
- **Deprecation警告**: 旧名称使用時にログ出力（同一キー1回のみ）
- **セキュリティ**: `CM_AUTH_TOKEN`マスキングパターンを`logger.ts`に追加
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

### Issue #4: CLIツールサポート
- **対応ツール**: Claude Code
- **Strategy パターン**: 拡張可能な設計

---

## 関連ドキュメント

- [README.md](./README.md) - プロジェクト概要
- [アーキテクチャ](./docs/architecture.md) - システム設計
- [移行ガイド](./docs/migration-to-commandmate.md) - MyCodeBranchDesk からの移行手順
- [クイックスタートガイド](./docs/user-guide/quick-start.md) - 5分で始める開発フロー
- [コマンド利用ガイド](./docs/user-guide/commands-guide.md) - コマンドの詳細
- [エージェント利用ガイド](./docs/user-guide/agents-guide.md) - エージェントの詳細
- [ワークフロー例](./docs/user-guide/workflow-examples.md) - 実践的な使用例
- [ステータスインジケーター](./docs/features/sidebar-status-indicator.md) - サイドバー機能詳細
