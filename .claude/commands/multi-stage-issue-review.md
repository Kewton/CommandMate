---
model: sonnet
description: "Issue記載内容の多段階レビュー（通常→影響範囲）×2回と指摘対応を自動実行"
---

# マルチステージIssueレビューコマンド

## 概要

Issueの記載内容を多角的にレビューし、ブラッシュアップするコマンドです。
通常レビューと影響範囲レビューを2回ずつ実施し、各段階でレビュー→反映のサイクルを回します。

> **目的**: Issueの品質を段階的に向上させ、実装前に問題点を洗い出す

## 使用方法

```bash
/multi-stage-issue-review [Issue番号]
/multi-stage-issue-review [Issue番号] --skip-stage=5,6,7,8
```

**例**:
```bash
/multi-stage-issue-review 83              # 全8段階を実行
/multi-stage-issue-review 83 --skip-stage=5,6,7,8  # 1回目のみ実行
```

## 実行内容

あなたはマルチステージIssueレビューの統括者です。8段階のレビューサイクルを順次実行し、各段階で指摘事項を対応してから次の段階に進みます。

### パラメータ

- **issue_number**: 対象Issue番号（必須）
- **skip_stage**: スキップするステージ番号（カンマ区切り）

### サブエージェント/レビュアー指定

| ステージ | レビュアー | 理由 |
|---------|----------|------|
| Stage 1-4（1回目） | **Claude opus**（サブエージェント） | 品質判断にOpus必要 |
| Stage 5-8（2回目） | **Codex**（commandmatedev `--agent codex` 経由） | 異なるモデルによるクロスレビュー |
| 指摘反映（全ステージ） | sonnet（継承） | JSON→Issue更新のみ |

> **⚠ 重要**: Stage 5-8 は必ず `commandmatedev send ... --agent codex` でCodexに委譲すること。
> Claude サブエージェント（Agent tool）で代替実行してはならない。
> commandmatedev が利用不可の場合はユーザーに報告して中断すること。

---

## レビューステージ

| Phase/Stage | レビュー種別 | フォーカス | 目的 |
|-------------|------------|----------|------|
| 0.5 | 仮説検証 | コードベース照合 | Issue内の仮説・原因分析を実コードで検証 |
| 1 | 通常レビュー（1回目） | 整合性・正確性 | 既存コード/ドキュメントとの整合性確認 |
| 2 | 指摘事項反映（1回目） | - | Stage 1の指摘をIssueに反映 |
| 3 | 影響範囲レビュー（1回目） | 影響範囲 | 変更の波及効果分析 |
| 4 | 指摘事項反映（1回目） | - | Stage 3の指摘をIssueに反映 |
| 5 | 通常レビュー（2回目） | 整合性・正確性 | 更新後のIssueを再チェック |
| 6 | 指摘事項反映（2回目） | - | Stage 5の指摘をIssueに反映 |
| 7 | 影響範囲レビュー（2回目） | 影響範囲 | 更新後の影響範囲を再チェック |
| 8 | 指摘事項反映（2回目） | - | Stage 7の指摘をIssueに反映 |

---

## 実行フェーズ

### Phase 0: 初期設定

#### 0-1. TodoWriteで作業計画作成

```
- [ ] Phase 0.5: 仮説検証
- [ ] Stage 1: 通常レビュー（1回目）
- [ ] Stage 2: 指摘事項反映（1回目）
- [ ] Stage 3: 影響範囲レビュー（1回目）
- [ ] Stage 4: 指摘事項反映（1回目）
- [ ] Stage 5: 通常レビュー（2回目）
- [ ] Stage 6: 指摘事項反映（2回目）
- [ ] Stage 7: 影響範囲レビュー（2回目）
- [ ] Stage 8: 指摘事項反映（2回目）
- [ ] 最終確認
```

#### 0-2. ディレクトリ構造作成

```bash
mkdir -p dev-reports/issue/{issue_number}/issue-review
```

#### 0-3. 初期Issue内容のバックアップ

```bash
gh issue view {issue_number} --json title,body > dev-reports/issue/{issue_number}/issue-review/original-issue.json
```

---

### Phase 0.5: 仮説検証

Issue内に記載された仮説・原因分析・前提条件をコードベースと照合し、レビュー開始前に事実関係を確定させます。
仮説が存在しない場合（機能追加Issueなど）はスキップします。

#### 0.5-1. Issue内容から仮説を抽出

`original-issue.json`を読み込み、以下のカテゴリに該当する記述を抽出する：

- **仮説（Hypothesis）**: 「〜が原因と考えられる」「〜ではないか」等の推測
- **原因分析（Root Cause）**: 「根本原因は〜」「〜が原因で〜が発生」等の因果関係の主張
- **前提条件（Assumption）**: 「〜という仕様である」「〜は〜を使用している」等のコードに関する事実の主張

> **仮説が存在しない場合**: 機能追加など仮説を含まないIssueでは、このフェーズをスキップし「仮説なし - スキップ」と記録してStage 1に進む。

#### 0.5-2. コードベース照合による検証

抽出した各仮説に対して以下の手順で検証する：

1. **関連コードの特定**: Explore agentまたはGrep/Glob/Readツールで該当ソースを特定
2. **事実確認**: コードの実際の動作・構造と仮説の主張を照合
3. **判定**: 以下のいずれかに分類
   - **Confirmed（確認済み）**: コードベースの事実と一致
   - **Rejected（否定）**: コードベースの事実と矛盾（正しい事実を記録）
   - **Partially Confirmed（部分確認）**: 一部は正しいが補足・修正が必要
   - **Unverifiable（検証不可）**: コードだけでは判断できない（実行時の動作に依存等）

#### 0.5-3. 検証レポート作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/hypothesis-verification.md`

#### 0.5-4. Phase 0.5完了確認

- 全仮説の検証が完了している
- 検証レポートが作成されている
- Rejectedな仮説がある場合、Stage 1レビューへの申し送り事項が記載されている

---

### Stage 1: 通常レビュー（1回目）

#### 1-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage1-review-context.json`

```json
{
  "issue_number": "{issue_number}",
  "focus_area": "通常",
  "iteration": 1,
  "stage": 1,
  "stage_name": "通常レビュー（1回目）",
  "hypothesis_verification_path": "dev-reports/issue/{issue_number}/issue-review/hypothesis-verification.md"
}
```

#### 1-2. レビュー実行

```
Use issue-review-agent (model: opus) to review Issue #{issue_number} with focus on 通常.

Context file: dev-reports/issue/{issue_number}/issue-review/stage1-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage1-review-result.json
```

---

### Stage 2: 指摘事項反映（1回目）

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 1 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage2-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage2-apply-result.json
```

---

### Stage 3: 影響範囲レビュー（1回目）

```
Use issue-review-agent (model: opus) to review Issue #{issue_number} with focus on 影響範囲.

Context file: dev-reports/issue/{issue_number}/issue-review/stage3-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage3-review-result.json
```

---

### Stage 4: 指摘事項反映（1回目）

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 3 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage4-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage4-apply-result.json
```

---

### 2回目イテレーション自動スキップ判定

Stage 4完了後、1回目イテレーションの Must Fix 件数を確認し、**2回目イテレーション（Stage 5-8）の実行要否を判定**します。

- **Must Fix 合計が 0件** → Stage 5-8 をスキップし、Phase Final に進む
- **Must Fix が 1件以上** → Stage 5-8 を通常通り実行する

---

### Stage 5-8: 2回目イテレーション（Codexによるクロスレビュー）

2回目イテレーションは**Codex**（`--agent codex`）にレビューを委譲し、異なるモデルによるクロスレビューで品質を向上させます。

> **⚠ 禁止事項**: このステージをClaudeサブエージェント（Agent tool）で代替実行しないこと。
> 必ず `commandmatedev send --agent codex` でCodexに送信すること。

#### 5-0. commandmatedev 利用可能性確認

```bash
# commandmatedev が利用可能か確認（利用不可の場合はユーザーに報告して中断）
which commandmatedev || { echo "ERROR: commandmatedev not available. Stage 5-8 requires Codex via commandmatedev."; exit 1; }
```

#### 5-1. Codexへのレビュー依頼

commandmatedev CLIを使い、同一worktreeの**Codex**セッション（`--agent codex`）にレビューを依頼します。

**worktree IDの取得**:
```bash
# 現在のworktreeディレクトリ名からIDを推定
WORKTREE_ID=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')
```

**Stage 5-6: 通常レビュー（2回目）+ 反映**:
```bash
commandmatedev send "$WORKTREE_ID" \
  "Issue #{issue_number} の2回目通常レビューを実施してください。

## 対象
- Issue番号: #{issue_number}
- 1回目レビュー結果: dev-reports/issue/{issue_number}/issue-review/stage1-review-result.json
- 1回目影響範囲レビュー結果: dev-reports/issue/{issue_number}/issue-review/stage3-review-result.json
- 仮説検証: dev-reports/issue/{issue_number}/issue-review/hypothesis-verification.md

## 指示
1. gh issue view {issue_number} --json body で最新のIssue本文を取得
2. 1回目レビュー（stage1, stage3）で指摘された内容が適切に反映されているか確認
3. 新たな問題点・改善点がないかレビュー
4. レビュー結果をJSON形式で dev-reports/issue/{issue_number}/issue-review/stage5-review-result.json に出力
5. Must Fix/Should Fix指摘があればIssue本文を更新（gh issue edit）
6. 反映結果を dev-reports/issue/{issue_number}/issue-review/stage6-apply-result.json に出力

## 出力フォーマット
stage5-review-result.json:
{
  \"stage\": 5,
  \"focus\": \"通常（2回目）\",
  \"reviewer\": \"codex\",
  \"findings\": [{\"id\": \"S5-NNN\", \"severity\": \"Must Fix|Should Fix|Nice to Have\", \"title\": \"...\", \"description\": \"...\"}],
  \"must_fix_count\": N,
  \"should_fix_count\": N,
  \"nice_to_have_count\": N
}" \
  --agent codex --auto-yes --duration 1h
```

Codexの完了を待機:
```bash
commandmatedev wait "$WORKTREE_ID" --timeout 3600 --on-prompt agent
```

**Stage 7-8: 影響範囲レビュー（2回目）+ 反映**:
```bash
commandmatedev send "$WORKTREE_ID" \
  "Issue #{issue_number} の2回目影響範囲レビューを実施してください。

## 対象
- Issue番号: #{issue_number}
- Stage 5レビュー結果: dev-reports/issue/{issue_number}/issue-review/stage5-review-result.json

## 指示
1. gh issue view {issue_number} --json body で最新のIssue本文を取得
2. 変更の波及効果を分析（影響ファイル、既存テスト、APIの後方互換性等）
3. レビュー結果をJSON形式で dev-reports/issue/{issue_number}/issue-review/stage7-review-result.json に出力
4. Must Fix/Should Fix指摘があればIssue本文を更新（gh issue edit）
5. 反映結果を dev-reports/issue/{issue_number}/issue-review/stage8-apply-result.json に出力

## 出力フォーマット
stage5と同じJSON形式（stageを7に変更、focusを「影響範囲（2回目）」に変更）" \
  --agent codex --auto-yes --duration 1h
```

Codexの完了を待機:
```bash
commandmatedev wait "$WORKTREE_ID" --timeout 3600 --on-prompt agent
```

#### 5-2. Codexレビュー結果の確認

Stage 5-8完了後、以下を確認:
- `stage5-review-result.json` が生成されている
- `stage7-review-result.json` が生成されている
- GitHubのIssueが更新されている（Must Fix指摘があった場合）

---

### Phase Final: 最終確認と報告

#### 最終Issue確認

```bash
gh issue view {issue_number}
```

#### サマリーレポート作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/summary-report.md`

```markdown
# Issue #{issue_number} マルチステージレビュー完了報告

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | {仮説} | Confirmed/Rejected/Partially/Unverifiable/スキップ |

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（1回目） | X | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | X | 完了 |
| 3 | 影響範囲レビュー（1回目） | X | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | X | 完了 |
| 5-8 | 2回目イテレーション | X | X | 完了/スキップ |

## 次のアクション

- [ ] Issueの最終確認
- [ ] /design-policy で設計方針策定
- [ ] /tdd-impl または /pm-auto-dev で実装を開始
```

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
└── issue-review/
    ├── original-issue.json
    ├── hypothesis-verification.md
    ├── stage1-review-context.json
    ├── stage1-review-result.json
    ├── stage2-apply-context.json
    ├── stage2-apply-result.json
    ├── stage3-review-context.json
    ├── stage3-review-result.json
    ├── stage4-apply-context.json
    ├── stage4-apply-result.json
    ├── stage5-review-context.json ~ stage8-apply-result.json
    └── summary-report.md
```

---

## 完了条件

以下をすべて満たすこと：

- 仮説検証完了（仮説がない場合はスキップ記録）
- 全8ステージ完了（またはスキップ指定分を除く）
  - **2回目イテレーション自動スキップ**: 1回目のMust Fix合計0件の場合、Stage 5-8は自動スキップ
- 各ステージのMust Fix指摘が対応済み
- GitHubのIssueが更新されている
- サマリーレポート作成完了

---

## 関連コマンド

- `/design-policy`: 設計方針策定
- `/architecture-review`: アーキテクチャレビュー
- `/pm-auto-dev`: 自動開発フロー
- `/tdd-impl`: TDD実装
