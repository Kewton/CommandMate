---
model: opus
description: "Issue分割計画書からGitHub Issueを一括作成"
---

# Issue一括作成コマンド

## 概要
Issue分割計画書（`issue-split.md`）を解析し、GitHubにIssueを一括作成します。
親Issue（Feature）と子Issue（実装単位）の関連付けを自動で行い、進捗を可視化します。

## 使用方法
```bash
/issue-create <親Issue番号> [issue-split.mdのパス]
```

**例**:
```bash
/issue-create 152
/issue-create 152 dev-reports/feature/issue/152/issue-split.md
```

**引数**:
- `<親Issue番号>`: Feature Issue番号（必須）
- `[issue-split.mdのパス]`: Issue分割計画書のパス（省略時は自動検索）

## 実行内容

あなたはプロジェクトマネージャーです。Issue分割計画書から子Issueを一括作成し、親Issueと関連付けてください：

### 1. 事前確認

#### 親Issueの検証
```bash
gh issue view <親Issue番号>
```
- 親Issueが存在するか確認
- Feature Issueであることを確認（ラベルに "feature" が含まれる）
- 既に子Issueが作成済みでないか確認

#### issue-split.mdの検索
引数で指定されない場合、以下の優先順位で検索：
1. `dev-reports/feature/issue/<親Issue番号>/issue-split.md`
2. カレントディレクトリの `issue-split.md`
3. `dev-reports/**/issue-split.md`（最新のもの）

### 2. issue-split.mdの解析

#### 抽出する情報
- **Issue一覧セクション**:
  - Issue番号（例: #152-1）
  - タイトル
  - 概要
  - サイズ（S/M/L）
  - 優先度（High/Medium/Low）
  - 作業見積（時間）
  - 担当候補
  - スコープ
  - 技術スタック
  - 受入基準（2層構造）

- **Phase情報**:
  - Phase番号
  - Phase名
  - 各Issueの所属Phase
  - Phase完了条件
  - Phaseの実行順序（Week情報）
  - 並列実行マーク（⚡）の有無

- **依存関係**:
  - 依存先Issue（ブロックされる側）
  - ブロック対象Issue（ブロックする側）
  - 並列実行可能性
  - 依存関係マトリクスからの情報

### 3. 子Issueの一括作成

#### Issue作成ループ
各Issueについて以下を実行：

```bash
gh issue create \
  --title "Issue #<親Issue番号>-<連番>: <タイトル>" \
  --body "$(cat /tmp/issue-body-<連番>.md)" \
  --label "<サイズ>,<優先度>,feature,<Phase>" \
  --assignee "@me" \
  --project "MyCodeBranchDesk"
```

#### Issue本文のテンプレート
```markdown
**親Issue**: #<親Issue番号>
**Phase**: <Phase名>
**サイズ**: <サイズ> (<作業見積>)
**優先度**: <優先度>

## 概要
<概要>

## 依存関係
<依存先Issueのリスト>

## ブロック対象
<ブロックするIssueのリスト>

## スコープ
<スコープのチェックリスト>

## 技術スタック
<技術スタック>

## 受入基準 (Acceptance Criteria)

### 🤖 自動検証可能な基準（pm-auto-devが実施）

**機能要件**:
<機能要件のチェックリスト>

**品質基準**:
<品質基準のチェックリスト>

**テストケース**:
<テストケースのチェックリスト>

### 👤 手動検証が必要な基準（ユーザーが実施）

**UX/UI検証**:
<UX/UI検証のチェックリスト>

**ビジネスロジック検証**:
<ビジネスロジック検証のチェックリスト>

**運用検証**:
<運用検証のチェックリスト>

---

📄 **詳細**: [Issue分割計画書](<issue-split.mdへのリンク>)
```

### 4. 親Issueの更新

#### タスクリストの追加
親Issueの本文を更新し、子Issueのタスクリストを追加：

```bash
gh issue edit <親Issue番号> --body "$(cat /tmp/parent-issue-body.md)"
```

#### 親Issue本文に追加する内容
- 実装Phase計画と実行順序
- 依存関係可視化（Mermaidグラフ）
- 実行シミュレーション（最短スケジュール）
- 推奨着手順序
- 子Issue進捗チェックリスト
- 全体進捗サマリー

### 5. 依存関係の設定

#### コメントによる依存関係の記録
各子Issueにコメントを追加：

```bash
# 依存先がある場合
gh issue comment <子Issue番号> --body "⚠️ **Blocked by**: #<依存先Issue番号>"

# ブロック対象がある場合
gh issue comment <依存先Issue番号> --body "🚧 **Blocks**: #<子Issue番号>"
```

### 6. issue-split.mdへのリンク追記

issue-split.mdの末尾に作成されたGitHub Issueのリンクを追記します。

### 7. 結果サマリーの出力

```
================================================================================
✅ 子Issueを一括作成しました
================================================================================

親Issue: #<親Issue番号> <Feature名>
  https://github.com/Kewton/CommandMate/issues/<親Issue番号>

作成された子Issue: <総Issue数>個

--------------------------------------------------------------------------------
Phase 1: <Phase名>（並列可）
--------------------------------------------------------------------------------
  #<子Issue番号>: Issue #<親Issue番号>-<連番>: <タイトル>（<見積>）
    https://github.com/Kewton/CommandMate/issues/<子Issue番号>
    📌 並列実行可能: #<子Issue番号>
    🚧 Blocks: #<子Issue番号>, #<子Issue番号>

================================================================================
📊 統計情報
================================================================================
- 総Issue数: <総Issue数>個
- 総見積工数: <総日数>日
- 並列実行可能: <並列グループ数>組
- ブロック関係: <ブロック関係リスト>

================================================================================
🎯 次のステップ
================================================================================
1. 親Issue（#<親Issue番号>）で全体進捗を確認
2. Phase 1の並列実行可能Issueから着手
3. 各Issueで /work-plan を実行して詳細作業計画を立案
4. /pm-auto-dev で自動開発・テスト実行

================================================================================
✅ Issue一括作成が完了しました
================================================================================
```

## エラーハンドリング

| エラー | 条件 | 対処 |
|--------|------|------|
| **親Issue不在** | 指定された親Issue番号が存在しない | エラーメッセージを表示し終了 |
| **非Feature Issue** | 親Issueに "feature" ラベルがない | 警告を表示し、続行するか確認 |
| **issue-split.md不在** | Issue分割計画書が見つからない | エラーメッセージを表示し終了 |
| **GitHub CLI未認証** | `gh auth status` が失敗 | 認証手順を案内 |
| **Issue作成失敗** | `gh issue create` がエラー | エラー詳細を表示し、ロールバック手順を案内 |
| **重複Issue検出** | 同じタイトルのIssueが既存 | 警告を表示し、続行するか確認 |

## 注意事項

### 前提条件
- [x] GitHub CLIがインストール済み（`gh --version`）
- [x] GitHub認証が完了済み（`gh auth status`）
- [x] リポジトリへの書き込み権限がある
- [x] issue-split.mdが正しい形式である

### ベストプラクティス
- `/issue-split` 実行直後に `/issue-create` を実行
- 親Issueのテンプレートは事前に整備しておく
- Issue作成後は親Issueで全体進捗を確認
- 並列実行可能なIssueを優先的に着手

## 関連コマンド

- `/issue-split`: Issue分割計画書の作成（本コマンドの前提）
- `/work-plan`: 各Issue単位の詳細作業計画立案
- `/pm-auto-dev`: 自動開発実行

---

**実行確認**: このコマンドはGitHub APIに変更を加えます。実行前に内容を確認してください。
