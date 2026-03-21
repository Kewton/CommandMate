---
model: sonnet
description: "複数Issueを並列オーケストレーション（準備→開発→PR→マージ→UAT→修正ループ→完了）"
---

# 並列Issueオーケストレーション

## 概要
developブランチをオーケストレーターとして、複数Issueの並列開発からUAT合格までの全ライフサイクルを統括します。各Issueはfeatureブランチのworktreeで並列に開発され、commandmatedev CLIで制御します。

**原則**: オーケストレーターはコードに触れない。制御と判断のみ。

## 使用方法
- `/orchestrate [Issue番号1] [Issue番号2] ...`
- `/orchestrate [Issue番号1] [Issue番号2] --phase design` （設計フェーズまで）
- `/orchestrate [Issue番号1] [Issue番号2] --phase impl` （実装まで）
- `/orchestrate [Issue番号1] [Issue番号2] --full` （UAT合格まで全自動）

## 前提条件
- developブランチ上で実行すること
- CommandMateサーバーが稼働していること（`commandmatedev ls` で確認）
- GitHubリポジトリ（https://github.com/Kewton/CommandMate）にアクセス可能

## 実行内容

あなたはプロジェクトマネージャーとして、複数Issueの並列開発を統括します。

### パラメータ
- **issue_numbers**: 開発対象のIssue番号（スペース区切り、2つ以上）
- **--phase**: 実行範囲の制限（design, impl, pr, uat）。省略時はPRマージまで
- **--full**: UAT合格まで全自動で実行

---

## Phase 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Phase 1: 依存関係分析・実行計画
- [ ] Phase 2: Worktree準備
- [ ] Phase 3: 並列開発
- [ ] Phase 4: 設計突合（バリア）
- [ ] Phase 5: 品質確認
- [ ] Phase 6: PR作成・マージ（/pr-merge-pipeline）
- [ ] Phase 7: UAT（--full時のみ）
- [ ] Phase 8: 完了報告
```

---

## Phase 1: 依存関係分析・実行計画

### 1-1. Issue情報の取得

各Issueの詳細を取得：

```bash
for issue_num in {issue_numbers}; do
  gh issue view "$issue_num" --repo Kewton/MyCodeBranchDesk --json number,title,body,labels
done
```

### 1-2. 依存関係の分析

各Issueについて以下を分析：
- **影響ファイル**: Issue本文の「影響ファイル」セクションから抽出
- **共通ファイル**: 複数Issueが同じファイルを変更する場合のコンフリクトリスク
- **依存関係**: Issue間の前後関係（A の成果物が B の入力になるか）

### 1-3. 並列実行可否の判定

```
独立:     共通ファイルなし → 完全並列
弱依存:   共通ファイルあるが変更箇所が異なる → 並列可（設計突合で確認）
強依存:   A の出力が B の入力 → 直列実行（A完了後にB開始）
```

### 1-4. 実行計画の記録

```bash
DATE=$(date +%Y-%m-%d)
mkdir -p workspace/orchestration/runs/$DATE
```

実行計画を `workspace/orchestration/runs/$DATE/plan.md` に出力：
- 対象Issue一覧
- 依存関係グラフ
- 並列実行グループ
- マージ推奨順序

---

## Phase 2: Worktree準備

### 2-1. 既存worktreeの確認

```bash
commandmatedev ls --branch feature/
```

### 2-2. 不足worktreeの作成

各Issueについて、対応するworktreeが存在しない場合は作成：

```bash
# /worktree-setup を使用
/worktree-setup {issue_numbers}
```

または手動で:

```bash
git worktree add -b "feature/{N}-worktree" "../commandmate-issue-{N}" develop
cd "../commandmate-issue-{N}" && npm install
```

### 2-3. CommandMateへの登録確認

```bash
curl -s -X POST http://localhost:3000/api/repositories/sync
commandmatedev ls --branch feature/
```

全worktreeが表示されることを確認。

---

## Phase 3: 並列開発

### 3-1. 各ワーカーにタスク送信

```bash
for each issue:
  WT=$(commandmatedev ls --branch "feature/{N}" --quiet)
  commandmatedev send "$WT" "/pm-auto-issue2dev {issue_number}" \
    --auto-yes --duration 3h
```

独立したIssueは並列で送信する。強依存のIssueは直列実行（先行Issue完了後に送信）。

### 3-2. 進捗監視

定期的にステータスを確認：

```bash
commandmatedev ls --branch feature/
```

### 3-3. 完了待機

全ワーカーの完了を待つ：

```bash
for each worktree:
  commandmatedev wait <worktree-id> --timeout 10800
```

### 3-4. プロンプト対応

`commandmatedev wait` が exit code 10 を返した場合、プロンプト内容を確認して応答：

```bash
commandmatedev wait <worktree-id> --timeout 60 --on-prompt agent
# exit 10 → プロンプト検出
commandmatedev respond <worktree-id> "yes"
```

**`--phase design` 指定時**: 全ワーカーの設計フェーズ完了を確認して終了。

---

## Phase 4: 設計突合（バリア）

弱依存のIssueがある場合、設計書をクロスチェックする。

### 4-1. 各ワーカーの設計書を取得

```bash
commandmatedev capture <worktree-id>
```

各worktreeの `dev-reports/design/issue-{N}-*-design-policy.md` を確認。

### 4-2. クロスチェック観点

- **影響ファイルの重複**: 同じファイルを変更する場合のコンフリクトリスク
- **型定義の整合性**: 共通型への変更が矛盾しないか
- **アーキテクチャの一貫性**: 設計方針が相反しないか
- **モジュール境界**: 新規モジュールの責務が重複しないか

### 4-3. 問題がある場合

該当ワーカーに修正指示を送信：

```bash
commandmatedev send <worktree-id> "設計書の以下の点を修正してください: {具体的な指摘}" \
  --auto-yes --duration 1h
```

**`--phase impl` 指定時**: 全ワーカーの実装完了を確認して終了。

---

## Phase 5: 品質確認

### 5-1. 各ワーカーに品質チェック送信

```bash
QUALITY_CMD="以下を順に実行し結果を報告してください:
1. npm run lint
2. npx tsc --noEmit
3. npm run test:unit
4. npm run build
最後に Pass/Fail のサマリーを出力してください。"

for each worktree:
  commandmatedev send <worktree-id> "$QUALITY_CMD" --auto-yes --duration 1h
```

### 5-2. 結果収集

```bash
for each worktree:
  commandmatedev wait <worktree-id> --timeout 600
  commandmatedev capture <worktree-id>
```

### 5-3. 品質NGの場合

ワーカーに修正を指示し、再度品質チェック。最大3回まで自動リトライ。

---

## Phase 6: PR作成・マージ

`/pr-merge-pipeline` コマンドの内容を実行する：

```
/pr-merge-pipeline {issue_numbers}
```

詳細は `/pr-merge-pipeline` コマンドを参照。

**`--phase pr` 指定時**: PR作成・マージ完了を確認して終了。

---

## Phase 7: UAT（--full時のみ）

### 7-1. 受入テスト実行

developブランチ（オーケストレーター自身）で実行：

```bash
git pull origin develop
/uat {issue_numbers}
```

### 7-2. UAT結果判定

- **全PASS**: Phase 8（完了）へ
- **FAILあり**: `/uat-fix-loop` を実行

```
/uat-fix-loop {fail_issue_numbers}
```

詳細は `/uat-fix-loop` コマンドを参照。

---

## Phase 8: 完了報告

### 8-1. 最終検証

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 8-2. 結果レポート

`workspace/orchestration/runs/$DATE/summary.md` に統合サマリーを出力：

```markdown
## オーケストレーション完了報告

### 対象Issue

| Issue | タイトル | ステータス |
|-------|---------|-----------|
| #{N} | {title} | 完了 |
| #{M} | {title} | 完了 |

### 実行フェーズ結果

| Phase | 内容 | ステータス |
|-------|------|-----------|
| 1 | 依存関係分析 | 完了 |
| 2 | Worktree準備 | 完了 |
| 3 | 並列開発 | 完了 |
| 4 | 設計突合 | 完了（問題なし） |
| 5 | 品質確認 | 完了（全Pass） |
| 6 | PR・マージ | 完了（PR #XX, #YY） |
| 7 | UAT | 完了（全PASS） |

### 品質チェック

| チェック項目 | 結果 |
|-------------|------|
| npm run lint | Pass |
| npx tsc --noEmit | Pass |
| npm run test:unit | Pass |
| npm run build | Pass |

### 成果物

- 設計書: dev-reports/design/issue-{N}-*-design-policy.md
- 作業計画: dev-reports/issue/{N}/work-plan.md
- 進捗報告: dev-reports/issue/{N}/pm-auto-dev/iteration-1/progress-report.md
- UATレポート: dev-reports/issue/{N}/uat/acceptance-test-report.html
- 統合サマリー: workspace/orchestration/runs/{DATE}/summary.md
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |
| worktree作成失敗 | エラー表示、手動作成を案内 |
| ワーカーのタイムアウト | captureで状況確認→追加指示 or ユーザーに報告 |
| 品質チェック3回連続失敗 | ユーザーに報告して中断 |
| コンフリクト解消失敗 | ユーザーに報告して中断 |
| UAT 4回連続FAIL | ユーザーに判断を仰ぐ |

---

## 完了条件

- [ ] 全Issueの開発が完了している
- [ ] 品質チェック全パス（ESLint, TypeScript, テスト, ビルド）
- [ ] 全IssueのPRがdevelopにマージ済み
- [ ] developブランチでの統合ビルド・テストが全パス
- [ ] （--full時）UAT全テストPASS
- [ ] 統合サマリーが出力されている

## 関連コマンド

- `/pm-auto-issue2dev`: Issue単位の全自動開発（各ワーカーに送信）
- `/pr-merge-pipeline`: PR作成からマージ完了まで
- `/uat`: 受入テスト
- `/uat-fix-loop`: UAT不合格時の修正ループ
- `/issues-exec-plan`: 複数Issueの実行計画策定
- `/worktree-setup`: worktree個別作成
- `/worktree-cleanup`: worktree個別削除
