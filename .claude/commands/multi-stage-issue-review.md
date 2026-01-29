---
model: opus
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

---

## レビューステージ

| Stage | レビュー種別 | フォーカス | 目的 |
|-------|------------|----------|------|
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

### Stage 1: 通常レビュー（1回目）

#### 1-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage1-review-context.json`

```json
{
  "issue_number": {issue_number},
  "focus_area": "通常",
  "iteration": 1,
  "stage": 1,
  "stage_name": "通常レビュー（1回目）"
}
```

#### 1-2. レビュー実行

```
Use issue-review-agent to review Issue #{issue_number} with focus on 通常.

Context file: dev-reports/issue/{issue_number}/issue-review/stage1-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage1-review-result.json
```

#### 1-3. Stage 1完了確認

- レビュー結果ファイル作成完了
- 指摘事項が分類されている

---

### Stage 2: 指摘事項反映（1回目）

#### 2-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage2-apply-context.json`

```json
{
  "issue_number": {issue_number},
  "review_result_path": "dev-reports/issue/{issue_number}/issue-review/stage1-review-result.json",
  "iteration": 1,
  "stage": 2,
  "stage_name": "指摘事項反映（1回目）"
}
```

#### 2-2. 指摘事項反映

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 1 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage2-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage2-apply-result.json
```

#### 2-3. Stage 2完了確認

- Must Fix項目すべて対応済み
- Issue更新完了

---

### Stage 3: 影響範囲レビュー（1回目）

#### 3-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage3-review-context.json`

```json
{
  "issue_number": {issue_number},
  "focus_area": "影響範囲",
  "iteration": 1,
  "stage": 3,
  "stage_name": "影響範囲レビュー（1回目）",
  "previous_stages": ["stage1", "stage2"]
}
```

#### 3-2. レビュー実行

```
Use issue-review-agent to review Issue #{issue_number} with focus on 影響範囲.

Context file: dev-reports/issue/{issue_number}/issue-review/stage3-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage3-review-result.json
```

#### 3-3. Stage 3完了確認

- 影響範囲の分析完了
- 指摘事項が分類されている

---

### Stage 4: 指摘事項反映（1回目）

#### 4-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage4-apply-context.json`

```json
{
  "issue_number": {issue_number},
  "review_result_path": "dev-reports/issue/{issue_number}/issue-review/stage3-review-result.json",
  "iteration": 1,
  "stage": 4,
  "stage_name": "指摘事項反映（1回目）"
}
```

#### 4-2. 指摘事項反映

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 3 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage4-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage4-apply-result.json
```

#### 4-3. Stage 4完了確認

- 影響範囲に関するMust Fix項目すべて対応済み
- Issue更新完了

---

### Stage 5: 通常レビュー（2回目）

#### 5-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage5-review-context.json`

```json
{
  "issue_number": {issue_number},
  "focus_area": "通常",
  "iteration": 2,
  "stage": 5,
  "stage_name": "通常レビュー（2回目）",
  "previous_stages": ["stage1", "stage2", "stage3", "stage4"],
  "previous_review": "dev-reports/issue/{issue_number}/issue-review/stage1-review-result.json"
}
```

#### 5-2. レビュー実行

```
Use issue-review-agent to review Issue #{issue_number} with focus on 通常 (2nd iteration).

Context file: dev-reports/issue/{issue_number}/issue-review/stage5-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage5-review-result.json

Check that previous findings have been addressed and identify any new issues.
```

#### 5-3. Stage 5完了確認

- 前回の指摘が対応されていることを確認
- 新規指摘事項が分類されている

---

### Stage 6: 指摘事項反映（2回目）

#### 6-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage6-apply-context.json`

```json
{
  "issue_number": {issue_number},
  "review_result_path": "dev-reports/issue/{issue_number}/issue-review/stage5-review-result.json",
  "iteration": 2,
  "stage": 6,
  "stage_name": "指摘事項反映（2回目）"
}
```

#### 6-2. 指摘事項反映

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 5 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage6-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage6-apply-result.json
```

#### 6-3. Stage 6完了確認

- 2回目の通常レビュー指摘すべて対応済み
- Issue更新完了

---

### Stage 7: 影響範囲レビュー（2回目）

#### 7-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage7-review-context.json`

```json
{
  "issue_number": {issue_number},
  "focus_area": "影響範囲",
  "iteration": 2,
  "stage": 7,
  "stage_name": "影響範囲レビュー（2回目）",
  "previous_stages": ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6"],
  "previous_review": "dev-reports/issue/{issue_number}/issue-review/stage3-review-result.json"
}
```

#### 7-2. レビュー実行

```
Use issue-review-agent to review Issue #{issue_number} with focus on 影響範囲 (2nd iteration).

Context file: dev-reports/issue/{issue_number}/issue-review/stage7-review-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage7-review-result.json

Check that previous findings have been addressed and identify any new issues.
```

#### 7-3. Stage 7完了確認

- 前回の影響範囲指摘が対応されていることを確認
- 新規指摘事項が分類されている

---

### Stage 8: 指摘事項反映（2回目）

#### 8-1. コンテキスト作成

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/stage8-apply-context.json`

```json
{
  "issue_number": {issue_number},
  "review_result_path": "dev-reports/issue/{issue_number}/issue-review/stage7-review-result.json",
  "iteration": 2,
  "stage": 8,
  "stage_name": "指摘事項反映（2回目）"
}
```

#### 8-2. 指摘事項反映

```
Use apply-issue-review-agent to update Issue #{issue_number} based on Stage 7 review.

Context file: dev-reports/issue/{issue_number}/issue-review/stage8-apply-context.json
Output file: dev-reports/issue/{issue_number}/issue-review/stage8-apply-result.json
```

#### 8-3. Stage 8完了確認

- 2回目の影響範囲レビュー指摘すべて対応済み
- Issue更新完了

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

## レビュー日時
- 開始: {start_time}
- 完了: {end_time}

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（1回目） | X | - | ✅ |
| 2 | 指摘事項反映（1回目） | - | X | ✅ |
| 3 | 影響範囲レビュー（1回目） | X | - | ✅ |
| 4 | 指摘事項反映（1回目） | - | X | ✅ |
| 5 | 通常レビュー（2回目） | X | - | ✅ |
| 6 | 指摘事項反映（2回目） | - | X | ✅ |
| 7 | 影響範囲レビュー（2回目） | X | - | ✅ |
| 8 | 指摘事項反映（2回目） | - | X | ✅ |

## 統計

- **総指摘数**: X件
- **対応完了**: X件
- **スキップ**: X件

## 主な改善点

1. {改善点1}
2. {改善点2}
3. {改善点3}

## Issue差分サマリー

### 追加されたセクション
- {セクション1}
- {セクション2}

### 修正されたセクション
- {セクション1}: {修正内容}
- {セクション2}: {修正内容}

## 次のアクション

- [ ] Issueの最終確認
- [ ] 実装開始（/tdd-impl または /pm-auto-dev）

## 関連ファイル

- 元のIssue: `dev-reports/issue/{issue_number}/issue-review/original-issue.json`
- レビュー結果: `dev-reports/issue/{issue_number}/issue-review/stage*-review-result.json`
- 反映結果: `dev-reports/issue/{issue_number}/issue-review/stage*-apply-result.json`

---

*Generated by multi-stage-issue-review command*
```

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
└── issue-review/
    ├── original-issue.json          # 元のIssue内容
    ├── stage1-review-context.json   # Stage 1 レビューコンテキスト
    ├── stage1-review-result.json    # Stage 1 レビュー結果
    ├── stage2-apply-context.json    # Stage 2 反映コンテキスト
    ├── stage2-apply-result.json     # Stage 2 反映結果
    ├── stage3-review-context.json   # Stage 3 レビューコンテキスト
    ├── stage3-review-result.json    # Stage 3 レビュー結果
    ├── stage4-apply-context.json    # Stage 4 反映コンテキスト
    ├── stage4-apply-result.json     # Stage 4 反映結果
    ├── stage5-review-context.json   # Stage 5 レビューコンテキスト
    ├── stage5-review-result.json    # Stage 5 レビュー結果
    ├── stage6-apply-context.json    # Stage 6 反映コンテキスト
    ├── stage6-apply-result.json     # Stage 6 反映結果
    ├── stage7-review-context.json   # Stage 7 レビューコンテキスト
    ├── stage7-review-result.json    # Stage 7 レビュー結果
    ├── stage8-apply-context.json    # Stage 8 反映コンテキスト
    ├── stage8-apply-result.json     # Stage 8 反映結果
    └── summary-report.md            # 最終サマリーレポート
```

---

## 完了条件

以下をすべて満たすこと：

- 全8ステージ完了（またはスキップ指定分を除く）
- 各ステージのMust Fix指摘が対応済み
- GitHubのIssueが更新されている
- サマリーレポート作成完了

---

## 使用例

```
User: /multi-stage-issue-review 83

Multi-Stage Issue Review:

📋 Stage 1/8: 通常レビュー（1回目）
  レビュー実行中...
  - 指摘: Must Fix 2件, Should Fix 3件, Nice to Have 1件
  ✅ Stage 1 完了

📋 Stage 2/8: 指摘事項反映（1回目）
  Issue更新中...
  - 反映: 5/6件（Nice to Have 1件スキップ）
  ✅ Stage 2 完了

📋 Stage 3/8: 影響範囲レビュー（1回目）
  レビュー実行中...
  - 指摘: Must Fix 1件, Should Fix 2件
  ✅ Stage 3 完了

📋 Stage 4/8: 指摘事項反映（1回目）
  Issue更新中...
  - 反映: 3/3件
  ✅ Stage 4 完了

📋 Stage 5/8: 通常レビュー（2回目）
  レビュー実行中...
  - 指摘: Must Fix 0件, Should Fix 1件
  ✅ Stage 5 完了

📋 Stage 6/8: 指摘事項反映（2回目）
  Issue更新中...
  - 反映: 1/1件
  ✅ Stage 6 完了

📋 Stage 7/8: 影響範囲レビュー（2回目）
  レビュー実行中...
  - 指摘: Must Fix 0件, Should Fix 0件
  指摘なし - スキップ
  ✅ Stage 7 完了

📋 Stage 8/8: 指摘事項反映（2回目）
  指摘なしのためスキップ
  ✅ Stage 8 完了

🎉 マルチステージIssueレビュー完了！

| イテレーション | 通常レビュー | 影響範囲レビュー |
|--------------|------------|----------------|
| 1回目 | 6件 → 5件反映 | 3件 → 3件反映 |
| 2回目 | 1件 → 1件反映 | 0件 |

総指摘数: 10件
対応完了: 9件
スキップ: 1件

更新Issue: https://github.com/Kewton/CommandMate/issues/83
レポート: dev-reports/issue/83/issue-review/summary-report.md

次のアクション:
- Issueの最終確認
- /tdd-impl または /pm-auto-dev で実装を開始
```

---

## 関連コマンド

- `/design-policy`: 設計方針策定
- `/architecture-review`: アーキテクチャレビュー
- `/pm-auto-dev`: 自動開発フロー
- `/tdd-impl`: TDD実装
