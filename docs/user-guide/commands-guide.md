# コマンド利用ガイド

CommandMateで使用できるスラッシュコマンドの詳細ガイドです。

---

## コマンド一覧

| コマンド | 説明 | 優先度 |
|---------|------|--------|
| `/work-plan` | Issue単位の作業計画立案 | 高 |
| `/create-pr` | PR自動作成 | 高 |
| `/progress-report` | 進捗報告書作成 | 高 |
| `/tdd-impl` | TDD実装 | 高 |

---

## /work-plan

### 概要

Issue単位での具体的な作業計画を立案し、実装タスクの詳細化を策定するコマンドです。

### 使用方法

```
/work-plan [Issue番号または概要]
```

### パラメータ

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| Issue番号 | 任意 | 対象IssueのGitHub Issue番号 |

### 出力内容

1. **Issue概要** - タイトル、サイズ、優先度
2. **タスク分解** - 実装、テスト、ドキュメントタスク
3. **依存関係図** - Mermaid形式の依存関係
4. **品質チェック項目** - 必須チェック一覧
5. **成果物チェックリスト** - 完了条件

### 出力例

```markdown
## Issue: ダークモード追加
**Issue番号**: #123
**サイズ**: M
**優先度**: High

### タスク分解

#### 実装タスク（Phase 1）
- [ ] **Task 1.1**: テーマ型定義
  - 成果物: `src/types/theme.ts`
```

### 出力先

`dev-reports/issue/{issue_number}/work-plan.md`

### ベストプラクティス

- Issue着手前に必ず実行
- 計画は関係者とレビュー
- 計画変更時は再実行

---

## /create-pr

### 概要

Pull Request作成を自動実行するコマンドです。Issue情報から自動でタイトル・説明を生成します。

### 使用方法

```
/create-pr [オプション]
```

### パラメータ

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| Issue番号 | 任意 | 明示的に指定（省略時はブランチ名から自動検出） |
| --draft | 任意 | Draft PRとして作成 |

### 事前条件

以下をすべて満たす必要があります：

- 未コミットの変更がない
- CIチェックが全てパス
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm run test:unit`
  - `npm run build`

### 出力内容

1. **PRタイトル** - Conventional Commits形式
2. **PR説明文** - 変更内容、テスト結果、チェックリスト
3. **ラベル** - Issueから継承

### 出力例

```markdown
## Summary

ダークモード機能を追加しました。

Closes #123

## Changes

### Added
- テーマ切り替えコンポーネント
- ダークモード用スタイル

## Test Results

- Unit Tests: 15/15 passed
- ESLint: 0 errors
- TypeScript: 0 errors
```

### エラー対処

| エラー | 原因 | 対処 |
|--------|------|------|
| Issue番号検出失敗 | ブランチ名が規約外 | Issue番号を明示的に指定 |
| CIチェック失敗 | lint/test/buildエラー | エラーを修正してから再実行 |
| 未コミット変更あり | 変更がステージングされていない | `git add` & `git commit` |

---

## /progress-report

### 概要

開発の各フェーズの結果を集約し、進捗レポートを作成するコマンドです。

### 使用方法

```
/progress-report [Issue番号]
```

### パラメータ

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| Issue番号 | 任意 | 対象IssueのGitHub Issue番号 |

### 出力内容

1. **概要** - Issue番号、ステータス
2. **フェーズ別結果** - TDD、テスト結果
3. **品質メトリクス** - カバレッジ、静的解析エラー
4. **ブロッカー** - 問題点、課題
5. **次のステップ** - 推奨アクション

### 出力例

```markdown
# 進捗レポート - Issue #123

## 概要
**Issue**: #123 - ダークモード追加
**ステータス**: 成功

## フェーズ別結果

### TDD実装
- カバレッジ: 85%
- テスト: 15/15 passed
- 静的解析: 0 errors

## 次のステップ
1. PR作成
2. レビュー依頼
```

### ベストプラクティス

- 定期的に実行して進捗を可視化
- ブロッカーがあれば早期に対処
- 完了時は最終確認として実行

---

## /tdd-impl

### 概要

テスト駆動開発（TDD）の手法に従って、高品質なコードを実装するコマンドです。

### 使用方法

```
/tdd-impl [機能名]
```

### パラメータ

| パラメータ | 必須 | 説明 |
|-----------|------|------|
| 機能名 | 任意 | 実装する機能の名前 |

### TDDサイクル

```
┌─────────┐
│   Red   │ ← 失敗するテストを作成
└────┬────┘
     │
     ▼
┌─────────┐
│  Green  │ ← 最小限の実装でテストをパス
└────┬────┘
     │
     ▼
┌─────────┐
│Refactor │ ← コードを改善
└────┬────┘
     │
     └──────→ 繰り返し
```

### 出力内容

1. **実装内容** - 作成/変更したファイル
2. **テスト結果** - パス/失敗数、カバレッジ
3. **静的解析結果** - ESLint、TypeScriptエラー数
4. **コミット** - 作成されたコミット

### 出力例

```
TDD実装完了

## 実装内容
- src/lib/theme.ts
- src/components/ThemeToggle.tsx

## テスト結果
- Total: 10 tests
- Passed: 10
- Coverage: 85%

## 静的解析
- ESLint: 0 errors
- TypeScript: 0 errors

## Commits
- abc1234: feat(theme): add dark mode toggle
```

### 完了条件

- すべてのテストがパス
- カバレッジ80%以上
- 静的解析エラー0件
- コミット完了

---

## コマンドファイルの場所

```
.claude/
├── commands/
│   ├── work-plan.md
│   ├── create-pr.md
│   ├── progress-report.md
│   └── tdd-impl.md
├── agents/
│   ├── tdd-impl-agent.md
│   └── progress-report-agent.md
└── prompts/
    ├── tdd-impl-core.md
    └── progress-report-core.md
```

---

## ベストプラクティス

### 1. コマンドの実行順序

```
/work-plan → /tdd-impl → /progress-report → /create-pr
```

### 2. 品質チェックの徹底

コマンド実行前に以下を確認：

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 3. コミットメッセージ規約

Conventional Commits形式を使用：

```
feat(scope): add new feature
fix(scope): fix bug
docs(scope): update documentation
test(scope): add tests
refactor(scope): refactor code
```

---

## CLIツール標準スラッシュコマンド

CommandMateはClaude CodeとCodex CLIをサポートしています。各CLIツールには固有のスラッシュコマンドがあり、CommandMateは選択中のCLIツールに応じて利用可能なコマンドを自動的にフィルタリングします。

### Claude Codeコマンド（16種類）

Claudeタブ選択時に表示される標準コマンドです。

| コマンド | 説明 | カテゴリ |
|---------|------|---------|
| `/clear` | 会話履歴をクリアして新規開始 | セッション |
| `/compact` | コンテキストを圧縮して容量を節約 | セッション |
| `/resume` | 前の会話を続行 | セッション |
| `/rewind` | 会話またはコードを前の状態にリセット | セッション |
| `/config` | 設定インターフェースを開く | 設定 |
| `/model` | 使用するAIモデルを切り替え | 設定 |
| `/permissions` | ツールアクセス権限を表示・更新 | 設定 |
| `/status` | 現在のステータス情報を表示 | モニタリング |
| `/context` | コンテキスト使用量をカラーグリッドで表示 | モニタリング |
| `/cost` | トークン使用量と費用統計を表示 | モニタリング |
| `/review` | 現在の変更内容をコードレビュー | Git |
| `/pr-comments` | プルリクエストコメントを表示 | Git |
| `/help` | 利用可能なスラッシュコマンド一覧 | ユーティリティ |
| `/doctor` | インストール問題をチェック | ユーティリティ |
| `/export` | 会話をファイルやクリップボードにエクスポート | ユーティリティ |
| `/todos` | 現在のTODOエントリを一覧表示 | ユーティリティ |

### Codex CLIコマンド（10種類）

Codexタブ選択時に表示される専用コマンドです。

| コマンド | 説明 | カテゴリ |
|---------|------|---------|
| `/new` | 新しい会話を開始 | セッション |
| `/undo` | 直前の変更を取り消し | セッション |
| `/logout` | 現在のアカウントからログアウト | セッション |
| `/quit` | Codex CLIを終了 | セッション |
| `/approvals` | 承認ポリシーを管理 | 設定 |
| `/diff` | 変更差分を表示 | Git |
| `/mention` | @メンションを管理 | ユーティリティ |
| `/mcp` | MCPサーバー接続を管理 | ユーティリティ |
| `/init` | プロジェクトを初期化 | ユーティリティ |
| `/feedback` | フィードバックを送信 | ユーティリティ |

### コマンドの使い方

1. メッセージ入力欄で `/` を入力すると、利用可能なコマンドが表示されます
2. 選択中のCLIツール（Claude / Codex）に応じて、対応するコマンドのみが表示されます
3. コマンドを選択するか、直接入力して送信します

---

## スキル一覧

スキルはClaude Codeの拡張機能として、特定のワークフローを自動化します。

| スキル | 説明 | 引数 |
|--------|------|------|
| `/release` | リリース自動化 | `patch` / `minor` / `major` / バージョン番号 |
| `/rebuild` | サーバー再起動 | なし |

### /release

#### 概要

新しいバージョンをリリースします。以下を自動化します：

- package.json / package-lock.json のバージョン更新
- CHANGELOG.md の更新
- Gitタグの作成・プッシュ
- GitHub Releasesの作成

#### 使用方法

```
/release patch      # パッチバージョンアップ (0.1.0 → 0.1.1)
/release minor      # マイナーバージョンアップ (0.1.0 → 0.2.0)
/release major      # メジャーバージョンアップ (0.1.0 → 1.0.0)
/release 1.0.0      # 直接バージョン指定
```

#### 事前条件

- mainブランチで実行
- 未コミットの変更がない
- リモートと同期済み

#### 詳細

[リリースガイド](../release-guide.md) を参照してください。

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - 5分で始める開発フロー
- [リリースガイド](../release-guide.md) - リリース手順とスキル詳細
- [CLAUDE.md](../../CLAUDE.md) - プロジェクトガイドライン
