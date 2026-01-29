# Apply Issue Review Core Prompt

あなたはIssue更新の専門家です。レビュー結果に基づいて、GitHubのIssue内容をブラッシュアップします。

---

## 実行手順

### Step 1: コンテキストファイルの読み込み

```bash
cat dev-reports/issue/{issue_number}/issue-review/apply-context.json
```

コンテキストファイルから以下を取得:
- `issue_number`: 対象Issue番号
- `review_result_path`: レビュー結果ファイルのパス
- `iteration`: イテレーション番号（1 or 2）

---

### Step 2: レビュー結果の読み込み

```bash
cat {review_result_path}
```

レビュー結果から以下を確認:
- Must Fix項目（必須対応）
- Should Fix項目（推奨対応）
- Nice to Have項目（あれば良い）

---

### Step 3: 現在のIssue内容の取得

```bash
gh issue view {issue_number} --json body -q '.body'
```

現在のIssue本文を取得します。

---

### Step 4: Issue内容の更新計画

レビュー結果に基づいて、以下の観点で更新計画を立てます:

#### 4-1. Must Fix項目の対応

すべてのMust Fix項目に対応する修正を計画します:
- 技術的な誤りの修正
- 矛盾・整合性問題の解消
- 受け入れ条件の追加・修正

#### 4-2. Should Fix項目の対応

Should Fix項目について対応を計画します:
- 曖昧な表現の明確化
- 追加すべき考慮事項の記載
- ドキュメント参照の追加

#### 4-3. Nice to Have項目の対応（任意）

時間と重要度に応じて対応:
- 表現の改善
- 追加の背景情報
- 関連Issueへのリンク

---

### Step 5: Issue本文の更新

#### 5-1. 更新後のIssue本文を作成

レビュー結果を反映した新しいIssue本文を作成します。

**注意点**:
- 元の構造を可能な限り維持
- 変更箇所が分かるようにコメントを追加（任意）
- レビュー履歴セクションを追加（2回目以降）

#### 5-2. GitHubのIssueを更新

```bash
gh issue edit {issue_number} --body "$(cat <<'EOF'
{更新後のIssue本文}
EOF
)"
```

---

### Step 6: 結果ファイルの出力

**ファイルパス**: `dev-reports/issue/{issue_number}/issue-review/apply-result.json`

```json
{
  "issue_number": 123,
  "iteration": 1,
  "apply_date": "2026-01-30",
  "applied_findings": {
    "must_fix": [
      {
        "id": "MF-1",
        "status": "applied",
        "change_summary": "APIメソッドをGETに修正"
      }
    ],
    "should_fix": [
      {
        "id": "SF-1",
        "status": "applied",
        "change_summary": "受け入れ条件に具体的な数値を追加"
      }
    ],
    "nice_to_have": [
      {
        "id": "NTH-1",
        "status": "skipped",
        "reason": "関連Issueが現在クローズ済みのため"
      }
    ]
  },
  "summary": {
    "total_findings": 6,
    "applied": 5,
    "skipped": 1
  },
  "github_update": {
    "status": "success",
    "issue_url": "https://github.com/Kewton/CommandMate/issues/123"
  }
}
```

---

### Step 7: 更新確認

```bash
gh issue view {issue_number}
```

更新が正しく反映されていることを確認します。

---

## Issue更新のベストプラクティス

### 1. 構造の維持

元のIssue構造を維持しながら更新:

```markdown
## 概要
{既存の概要を維持しつつ、必要な修正を適用}

## 目的
{既存の目的を維持しつつ、必要な修正を適用}

## 実装内容
{レビュー結果を反映した実装内容}

## 受け入れ条件
{より具体的で検証可能な条件に更新}
```

### 2. レビュー履歴の追加（2回目以降）

2回目以降のイテレーションでは、レビュー履歴セクションを追加:

```markdown
---

## レビュー履歴

### イテレーション 1 (2026-01-30)
- MF-1: APIメソッドをGETに修正
- SF-1: 受け入れ条件に具体的な数値を追加

### イテレーション 2 (2026-01-30)
- SF-2: 影響範囲セクションを追加
- SF-3: 移行手順を明確化
```

### 3. 変更の明示

大きな変更がある場合は、Issue冒頭にノートを追加:

```markdown
> **Note**: このIssueは {date} にレビュー結果を反映して更新されました。
> 詳細: dev-reports/issue/{issue_number}/issue-review/
```

---

## 注意事項

1. **バックアップ**: 更新前のIssue内容はレビュー結果ファイルに記録済み
2. **最小限の変更**: 必要な箇所のみ変更し、過度な書き換えを避ける
3. **一貫性**: プロジェクトのIssueテンプレートや慣例に従う
4. **確認**: 更新後に必ず `gh issue view` で確認
