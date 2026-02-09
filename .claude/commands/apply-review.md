---
model: sonnet
description: "レビュー指摘事項を実装に反映"
---

# レビュー指摘反映コマンド

## 概要
アーキテクチャレビューの指摘事項（Must Fix, Should Fix）を**設計方針書に反映**するコマンドです。

> **重要**: このコマンドは**設計方針書のみ**を更新します。
> ソースコードの実装は行いません。レビュー結果を設計方針書に反映し、
> 実装時の指針として活用します。

## 使用方法
```bash
/apply-review [Issue番号]
/apply-review [Issue番号] --scope=must_fix
/apply-review [Issue番号] --skip="項目1,項目2"
```

**例**:
```bash
/apply-review 76                    # 全指摘事項を反映
/apply-review 76 --scope=must_fix   # 必須項目のみ
/apply-review 76 --skip="パフォーマンス最適化"  # 特定項目をスキップ
```

## 実行内容

あなたはレビュー指摘反映の統括者です。サブエージェントを使用して指摘事項を実装に反映します。

### パラメータ

- **issue_number**: 対象Issue番号（必須）
- **scope**: 反映範囲（all|must_fix|should_fix）デフォルト: all
- **skip**: スキップする項目（カンマ区切り）

---

## 実行フェーズ

### Phase 1: レビュー結果の確認

#### 1-1. レビュー結果ファイルの検索

```bash
ls dev-reports/issue/{issue_number}/review/review-result.json
# または
ls dev-reports/review/*-issue{issue_number}-*.md
```

#### 1-2. レビュー結果の読み込み

レビュー結果JSONから以下を抽出：
- **Must Fix**: 必須改善項目
- **Should Fix**: 推奨改善項目
- **Consider**: 検討事項（今回は対象外）

---

### Phase 2: コンテキストファイル作成

**ファイルパス**: `dev-reports/issue/{issue_number}/review/apply-review-context.json`

```json
{
  "issue_number": {issue_number},
  "review_result_path": "dev-reports/issue/{issue_number}/review/review-result.json",
  "design_doc_path": "dev-reports/design/issue-{issue_number}-xxx-design-policy.md",
  "scope": "all",
  "skip_items": [],
  "additional_instructions": ""
}
```

---

### Phase 3: サブエージェント呼び出し

```
Use apply-review-agent to update design policy for Issue #{issue_number}.
Target: dev-reports/design/issue-{issue_number}-*-design-policy.md

Context file: dev-reports/issue/{issue_number}/review/apply-review-context.json
Output file: dev-reports/issue/{issue_number}/review/apply-review-result.json

IMPORTANT: Only update design policy documents. Do NOT modify source code.
```

---

### Phase 4: 結果確認と報告

#### 4-1. 結果ファイルの確認

`apply-review-result.json` を読み込み、以下を確認：
- 設計方針書に反映した項目数
- スキップした項目
- 追加された実装チェックリスト

#### 4-2. 設計方針書の更新確認

設計方針書の内容を確認：
- レビュー指摘事項が適切に反映されているか
- 実装チェックリストが網羅的か
- 次のアクション（実装コマンド）の提案

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
├── review/
│   ├── review-context.json        ← レビュー実行時のコンテキスト
│   ├── review-result.json         ← レビュー結果
│   ├── apply-review-context.json  ← 反映コンテキスト
│   └── apply-review-result.json   ← 反映結果
└── work-plan.md
```

---

## 完了条件

以下をすべて満たすこと：

- Must Fix項目が全て**設計方針書に反映**完了
- Should Fix項目が**設計方針書に反映**完了（skipされたものを除く）
- **設計方針書が最新の状態に更新**されている
- 実装チェックリストが設計方針書に記載されている

> **Note**: このコマンドではソースコードの変更・テスト実行は行いません。
> 設計方針書の改善のみを実施します。

---

## 使用例

```
User: /apply-review 76

Apply Review:
Phase 1: レビュー結果確認
  - Must Fix: 2件
  - Should Fix: 3件
  - Consider: 1件（対象外）

Phase 2: コンテキスト作成完了

Phase 3: サブエージェント実行中...

Phase 4: 結果確認
  - Must Fix: 2/2 設計方針書に反映
  - Should Fix: 3/3 設計方針書に反映

レビュー指摘事項の設計方針書への反映が完了しました！
更新ファイル: dev-reports/design/issue-76-xxx-design-policy.md

次のアクション:
- 設計方針書に基づいてソースコードを実装
- /tdd-impl または /pm-auto-dev で実装を開始
```

---

## 関連コマンド

- `/architecture-review`: アーキテクチャレビュー実行
- `/refactoring`: コード改善
- `/tdd-impl`: TDD実装
