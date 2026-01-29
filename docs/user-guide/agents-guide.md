# エージェント利用ガイド

CommandMateで使用できるサブエージェントの詳細ガイドです。

---

## エージェントとは

エージェントは、特定のタスクに特化した専門家として動作するサブプロセスです。PM Auto-Dev（`/pm-auto-dev`）やPM Bug Fix（`/bug-fix`）などのオーケストレーションコマンドから呼び出され、コンテキストファイルを受け取って処理を実行し、結果ファイルを出力します。

---

## エージェント一覧

| エージェント | 説明 | 呼び出し元 |
|-------------|------|-----------|
| `tdd-impl-agent` | TDD実装専門 | `/tdd-impl`, `/pm-auto-dev` |
| `progress-report-agent` | 進捗報告生成 | `/progress-report`, `/pm-auto-dev` |
| `investigation-agent` | バグ調査専門 | `/bug-fix` |
| `acceptance-test-agent` | 受入テスト | `/acceptance-test`, `/pm-auto-dev` |
| `refactoring-agent` | リファクタリング | `/refactoring`, `/pm-auto-dev` |

---

## tdd-impl-agent

### 概要
TDD（テスト駆動開発）の手法に従って、高品質なコードを実装する専門エージェントです。

### 入力
**コンテキストファイル**: `tdd-context.json`

```json
{
  "issue_number": 166,
  "acceptance_criteria": ["条件1", "条件2"],
  "implementation_tasks": ["タスク1", "タスク2"],
  "target_coverage": 80
}
```

### 出力
**結果ファイル**: `tdd-result.json`

```json
{
  "status": "success",
  "coverage": 85.0,
  "unit_tests": {
    "total": 10,
    "passed": 10,
    "failed": 0
  },
  "static_analysis": {
    "eslint_errors": 0,
    "typescript_errors": 0
  },
  "files_changed": ["src/lib/xxx.ts"],
  "commits": ["abc1234: feat(xxx): implement feature"]
}
```

### 完了条件
- すべてのテストが成功
- カバレッジが目標値以上
- 静的解析エラーがゼロ
- コミット完了

---

## progress-report-agent

### 概要
開発の各フェーズの結果を集約し、進捗レポートを作成する専門エージェントです。

### 入力
**コンテキストファイル**: `progress-context.json`

```json
{
  "issue_number": 166,
  "iteration": 1,
  "phase_results": {
    "tdd": { "status": "success", "coverage": 85.0 },
    "acceptance": { "status": "passed" },
    "refactor": { "status": "success" }
  }
}
```

### 出力
**結果ファイル**: `progress-report.md`

Markdown形式の進捗レポート。

### 完了条件
- すべての結果ファイルを読み込み済み
- Git履歴を確認済み
- 品質メトリクスを集計済み
- 次のステップを提案済み

---

## investigation-agent

### 概要
不具合の現状把握と原因調査を専門に行うエージェントです。エラーログ分析、コード調査、依存関係の確認を通じて、根本原因を特定し、対策案を提示します。

### 入力
**コンテキストファイル**: `investigation-context.json`

```json
{
  "issue_description": "エラーの説明",
  "error_logs": ["エラーログ1"],
  "affected_files": ["src/lib/xxx.ts"],
  "reproduction_steps": ["1. xxx", "2. yyy"],
  "environment": {
    "os": "macOS",
    "node_version": "18.x"
  },
  "severity_hint": "high"
}
```

### 出力
**結果ファイル**: `investigation-result.json`

```json
{
  "status": "completed",
  "root_cause_analysis": {
    "category": "コードバグ",
    "primary_cause": "未処理のnull参照"
  },
  "recommended_actions": [
    {
      "action_id": "1",
      "priority": "high",
      "title": "対策案1",
      "description": "対策の説明"
    }
  ]
}
```

### 完了条件
- 根本原因が特定された
- 対策案が1つ以上提示された
- 優先度・リスクが評価された

---

## acceptance-test-agent

### 概要
Issue要件に基づいて受入テストを自動実行し、すべての受入条件が満たされていることを検証する専門エージェントです。

### 入力
**コンテキストファイル**: `acceptance-context.json`

```json
{
  "issue_number": 166,
  "feature_summary": "機能概要",
  "acceptance_criteria": ["条件1", "条件2"],
  "test_scenarios": ["シナリオ1", "シナリオ2"]
}
```

### 出力
**結果ファイル**: `acceptance-result.json`

```json
{
  "status": "passed",
  "test_cases": [
    { "scenario": "シナリオ1", "result": "passed" },
    { "scenario": "シナリオ2", "result": "passed" }
  ],
  "acceptance_criteria_status": [
    { "criterion": "条件1", "verified": true },
    { "criterion": "条件2", "verified": true }
  ]
}
```

### 完了条件
- すべてのテストシナリオが成功
- すべての受入条件が検証済み
- エビデンスが収集済み

---

## refactoring-agent

### 概要
コード品質を改善し、SOLID原則に基づく設計パターンを適用して、技術的負債を解消する専門エージェントです。

### 入力
**コンテキストファイル**: `refactor-context.json`

```json
{
  "issue_number": 166,
  "refactor_targets": ["src/lib/xxx.ts"],
  "quality_metrics": {
    "before_coverage": 75.0
  },
  "improvement_goals": [
    "カバレッジを80%以上に向上",
    "重複コードの削除"
  ]
}
```

### 出力
**結果ファイル**: `refactor-result.json`

```json
{
  "status": "success",
  "quality_metrics": {
    "before_coverage": 75.0,
    "after_coverage": 82.0
  },
  "refactorings_applied": [
    "長い関数の分割",
    "重複コードの削除"
  ],
  "files_changed": ["src/lib/xxx.ts"]
}
```

### 完了条件
- すべてのテストが成功
- 品質メトリクスが改善
- 静的解析エラーがゼロ

---

## エージェントの呼び出し方法

### PM Auto-Devからの呼び出し

```
Use tdd-impl-agent to implement Issue #166 with TDD approach.

Context file: dev-reports/issue/166/pm-auto-dev/iteration-1/tdd-context.json
Output file: dev-reports/issue/166/pm-auto-dev/iteration-1/tdd-result.json
```

### PM Bug Fixからの呼び出し

```
Use investigation-agent to investigate the bug.

Context file: dev-reports/bug-fix/20251205_120000/investigation-context.json
Output file: dev-reports/bug-fix/20251205_120000/investigation-result.json
```

---

## ファイル構造

```
.claude/
├── agents/
│   ├── tdd-impl-agent.md
│   ├── progress-report-agent.md
│   ├── investigation-agent.md
│   ├── acceptance-test-agent.md
│   └── refactoring-agent.md
└── prompts/
    ├── tdd-impl-core.md
    ├── progress-report-core.md
    ├── refactoring-core.md
    └── acceptance-test-core.md

dev-reports/
├── issue/{issue_number}/
│   └── pm-auto-dev/
│       └── iteration-{N}/
│           ├── tdd-context.json
│           ├── tdd-result.json
│           ├── acceptance-context.json
│           ├── acceptance-result.json
│           ├── refactor-context.json
│           ├── refactor-result.json
│           ├── progress-context.json
│           └── progress-report.md
└── bug-fix/{bug_id}/
    ├── investigation-context.json
    ├── investigation-result.json
    └── ...
```

---

## 関連ドキュメント

- [クイックスタートガイド](./quick-start.md) - 5分で始める開発フロー
- [コマンド利用ガイド](./commands-guide.md) - コマンドの詳細
- [ワークフロー例](./workflow-examples.md) - 実践的な使用例
