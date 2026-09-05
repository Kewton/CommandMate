[English](../en/user-guide/quick-start.md)

# クイックスタートガイド

> **先に [チュートリアル](./tutorial.md) をどうぞ。** CommandMate の中核（契約 → 検証ゲート → 証跡）を、
> サンプルリポジトリで 15 分ほどで一通り体験できます。
>
> **このページのスラッシュコマンドは CommandMate リポジトリ専用です。** `/work-plan` `/tdd-impl` などは
> CommandMate 自身の `.claude/commands` に置かれているもので、あなたのリポジトリには導入されません。
> 可搬な代替は公式 Catalog の Skill（`cmate-verify` / `cmate-task-contract` ほか）です。

CommandMateでClaude Codeのスラッシュコマンドとエージェントを使った開発フローを始めましょう。

---

## 前提条件

CommandMate がインストール・起動されている必要があります。

```bash
# インストール（初回のみ）
npm install -g commandmate
commandmate init --defaults

# サーバー起動
commandmate start --daemon
```

詳しくは [CLI セットアップガイド](./cli-setup-guide.md) を参照してください。

---

## どのエージェントでも回る最小ループ

この先の `/work-plan` `/tdd-impl` は **Claude Code のスラッシュコマンド**で、しかも CommandMate
リポジトリ自身の `.claude/commands` に置かれているものです。一方、CommandMate の中核である
**契約 → 送信 → 検証ゲート**のループは、どのエージェントでも同じコマンドで回ります。

契約は YAML で、エージェントに届くのはそこから組み立てられたただのテキストです。ゲートは worktree の
作業ディレクトリで走るシェルコマンドで、合否はその exit code で決まります。どちらもエージェント別の
分岐を持ちません。**変わるのは送り先の名指し方だけ**です。

```bash
# 送り先は --instance で名指しする（ツール名そのものを渡すとプライマリインスタンスに解決される）
commandmate send <worktree-id> --contract .commandmate/tasks/<task>.yaml --instance opencode
commandmate wait <worktree-id> --instance opencode --verify
echo $?   # 0=合格 / 20=ゲート不合格 / 21=作業証跡なし / 10=応答待ち
```

`opencode` のところを `claude` `codex` `command-code` などに置き換えれば、そのまま別の
エージェントの 1 周になります。`wait` には `--agent` が無いので、**`send` と `wait` の両方に
`--instance` を書いてください**（片方だけだと worktree の既定エージェントを待ちます）。

opencode / Command Code で実際に 1 周する手順（送り先の解決の確かめ方、エージェントによって
変わるところ）は、[チュートリアルの別紙](./tutorial.md#別紙-opencode--command-code-で同じ-1-周を回す)
にあります。

---

## 5分で始める開発フロー

### Step 1: Issue確認

GitHubでIssueを確認し、作業対象を決定します。

```bash
# Issue一覧を確認
gh issue list

# 特定のIssueを確認
gh issue view 123
```

### Step 2: 作業計画立案

`/work-plan` コマンドで作業計画を立案します。

```
/work-plan 123
```

出力される内容：
- タスク分解
- 依存関係図
- 品質チェック項目
- 成果物チェックリスト

### Step 3: TDD実装

`/tdd-impl` コマンドでテスト駆動開発を実行します。

```
/tdd-impl 新機能名
```

TDDサイクル：
1. **Red**: 失敗するテストを作成
2. **Green**: 最小限の実装でテストをパス
3. **Refactor**: コードを改善

### Step 4: 進捗確認

`/progress-report` コマンドで進捗を確認します。

```
/progress-report 123
```

### Step 5: PR作成

`/create-pr` コマンドでPull Requestを自動作成します。

```
/create-pr
```

自動生成される内容：
- PRタイトル（Conventional Commits形式）
- 変更内容の説明
- テスト結果
- チェックリスト

---

## よく使うコマンド一覧

| コマンド | 説明 | 使用タイミング |
|---------|------|---------------|
| `/work-plan` | 作業計画立案 | Issue着手時 |
| `/tdd-impl` | TDD実装 | 機能実装時 |
| `/progress-report` | 進捗報告 | 定期報告、完了確認時 |
| `/create-pr` | PR自動作成 | 実装完了時 |

---

## 開発フロー図

```
[Issue確認]
    │
    ▼
[/work-plan] ──→ 作業計画書
    │
    ▼
[ブランチ作成]
    │
    ▼
[/tdd-impl] ──→ テスト＆実装
    │
    ▼
[/progress-report] ──→ 進捗確認
    │
    ▼
[/create-pr] ──→ PR作成
    │
    ▼
[レビュー＆マージ]
```

---

## 品質チェックコマンド

開発中は以下のコマンドで品質を確認できます：

```bash
# リント
npm run lint

# 型チェック
npx tsc --noEmit

# 単体テスト
npm run test:unit

# 結合テスト
npm run test:integration

# ビルド
npm run build
```

---

## 困ったときは

### コマンドが見つからない

`.claude/commands/` ディレクトリにコマンドファイルが存在するか確認してください。

```bash
ls -la .claude/commands/
```

### テストが失敗する

1. エラーメッセージを確認
2. 関連するテストファイルを確認
3. 実装を修正
4. 再度テストを実行

```bash
npm run test:unit -- --verbose
```

### PRが作成できない

1. 未コミットの変更がないか確認
2. CIチェックが通っているか確認

```bash
git status
npm run lint && npx tsc --noEmit && npm run test:unit && npm run build
```

---

## 次のステップ

- [CLI セットアップガイド](./cli-setup-guide.md) - インストールとトラブルシューティング
- [コマンド利用ガイド](./commands-guide.md) - 各コマンドの詳細な使い方
- [エージェント利用ガイド](./agents-guide.md) - サブエージェントの詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例

---

## 関連ドキュメント

- [CLAUDE.md](../../CLAUDE.md) - プロジェクトガイドライン
- [README.md](../../README.md) - プロジェクト概要
