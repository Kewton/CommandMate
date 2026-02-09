---
model: sonnet
description: "Issue開発を完全自動化（TDD→テスト→報告）"
---

# PM自動開発スキル

## 概要
Issue開発（TDD実装 → 受入テスト → リファクタリング → 進捗報告）を**完全自動化**するプロジェクトマネージャースキルです。ユーザーはIssue番号を指定するだけで、開発完了まで自律的に実行します。

**アーキテクチャ**: サブエージェント方式を採用し、各フェーズを専門エージェントに委譲します。

## 使用方法
- `/pm-auto-dev [Issue番号]`
- `/pm-auto-dev [Issue番号] --max-iterations=5`（イテレーション回数変更）
- 「Issue #145を開発してください」

## 実行内容

あなたはプロジェクトマネージャーとして、Issue開発を統括します。各フェーズは**専門サブエージェント**に委譲し、結果ファイルを確認しながら品質基準を満たすまで完了させてください。

### パラメータ

- **issue_number**: 開発対象のIssue番号（必須）
- **max_iterations**: 最大イテレーション回数（デフォルト: 3）
- **target_coverage**: 目標カバレッジ（デフォルト: 80）

### サブエージェントモデル指定

| エージェント | モデル | 理由 |
|-------------|--------|------|
| tdd-impl-agent | **opus** | コード生成にOpus必要 |
| acceptance-test-agent | **opus** | テスト品質にOpus必要 |
| refactoring-agent | **opus** | コード改善にOpus必要 |
| progress-report-agent | sonnet（継承） | テンプレート埋め込み程度 |

---

## 実行フェーズ

### Phase 0: 初期設定とTodoリスト作成

まず、TodoWriteツールで作業計画を作成してください：

```
- [ ] Phase 1: Issue情報収集
- [ ] Phase 2: TDD実装 (イテレーション 0/3)
- [ ] Phase 3: 受入テスト
- [ ] Phase 4: リファクタリング
- [ ] Phase 5: ドキュメント最新化
- [ ] Phase 6: 進捗報告
```

---

### Phase 1: Issue情報収集

#### 1-1. Issue情報取得

```bash
gh issue view {issue_number} --json number,title,body,labels,assignees
```

#### 1-2. 必要情報の抽出

Issue本文から以下を抽出：
- **タイトル**: Issue件名
- **受入条件** (`## 受入条件`セクション)
- **技術要件** (`## 技術要件`セクション)
- **実装タスク** (`## 実装タスク`セクション)

#### 1-3. ディレクトリ構造作成

```bash
BRANCH=$(git branch --show-current)
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+')

BASE_DIR="dev-reports/issue/${ISSUE_NUM}/pm-auto-dev/iteration-1"
mkdir -p "$BASE_DIR"
```

---

### Phase 2: TDD実装（イテレーション可能）

**最大イテレーション回数**: `{max_iterations}`回（デフォルト: 3回）

#### 2-1. TDDコンテキストファイル作成

Writeツールで以下のファイルを作成：

**ファイルパス**: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/tdd-context.json`

```json
{
  "issue_number": {issue_number},
  "acceptance_criteria": [
    "受入条件1",
    "受入条件2"
  ],
  "implementation_tasks": [
    "実装タスク1",
    "実装タスク2"
  ],
  "target_coverage": 80
}
```

#### 2-2. TDD実装サブエージェント呼び出し

```
Use tdd-impl-agent (model: opus) to implement Issue #{issue_number} with TDD approach.

Context file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/tdd-context.json
Output file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/tdd-result.json
```

#### 2-3. 結果確認

**成功時**: Phase 3へ進む
**失敗時**: イテレーション回数を確認し、再試行またはエスカレーション

---

### Phase 3: 受入テスト

#### 3-1. 受入テストコンテキストファイル作成

**ファイルパス**: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/acceptance-context.json`

```json
{
  "issue_number": {issue_number},
  "feature_summary": "Issue件名",
  "acceptance_criteria": [
    "受入条件1",
    "受入条件2"
  ],
  "test_scenarios": [
    "シナリオ1: ...",
    "シナリオ2: ..."
  ]
}
```

#### 3-2. 受入テストサブエージェント呼び出し

```
Use acceptance-test-agent (model: opus) to verify Issue #{issue_number} acceptance criteria.

Context file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/acceptance-context.json
Output file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/acceptance-result.json
```

---

### Phase 4: リファクタリング

#### 4-1. リファクタリングコンテキストファイル作成

**ファイルパス**: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/refactor-context.json`

```json
{
  "issue_number": {issue_number},
  "refactor_targets": [
    "src/lib/xxx.ts",
    "src/components/xxx.tsx"
  ],
  "quality_metrics": {
    "before_coverage": 80.0
  },
  "improvement_goals": [
    "カバレッジを85%以上に向上",
    "重複コードの削除"
  ]
}
```

#### 4-2. リファクタリングサブエージェント呼び出し

```
Use refactoring-agent (model: opus) to improve code quality for Issue #{issue_number}.

Context file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/refactor-context.json
Output file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/refactor-result.json
```

---

### Phase 5: ドキュメント最新化

実装・リファクタリングの結果を踏まえ、関連ドキュメントを最新の状態に更新します。

#### 5-1. 更新対象の特定

以下の観点でドキュメントの更新要否を判断：

- **README.md**: 機能一覧・スクリーンショットの更新が必要か
- **CLAUDE.md**: プロジェクト構成・モジュール一覧の更新が必要か
- **docs/architecture.md**: アーキテクチャ変更があるか
- **docs/UI_UX_GUIDE.md**: UI変更があるか
- **docs/user-guide/**: ユーザー向け手順の追加・変更が必要か
- **docs/features/**: 機能詳細ドキュメントの追加・変更が必要か
- **JSDoc / コード内コメント**: 新規・変更した公開APIのドキュメント

#### 5-2. ドキュメント更新の実施

変更内容に応じて該当ドキュメントを更新します。以下のルールに従うこと：

1. **新機能追加時**: 該当機能の説明をドキュメントに追記
2. **既存機能変更時**: 既存の記述を最新の動作に合わせて修正
3. **設定・環境変数追加時**: `.env.example` および `docs/DEPLOYMENT.md` を更新
4. **API変更時**: 関連するAPIドキュメントを更新
5. **ファイル構成変更時**: `CLAUDE.md` のファイル構成セクションを更新

#### 5-3. 更新確認

- 更新したドキュメントの一覧をログに記録
- ドキュメントに記載のコマンド例が正しく動作するか確認（該当する場合）

---

### Phase 6: 進捗報告

#### 6-1. 進捗レポートコンテキストファイル作成

**ファイルパス**: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/progress-context.json`

```json
{
  "issue_number": {issue_number},
  "iteration": 1,
  "phase_results": {
    "tdd": {
      "status": "success",
      "coverage": 85.0
    },
    "acceptance": {
      "status": "passed"
    },
    "refactor": {
      "status": "success"
    }
  }
}
```

#### 6-2. 進捗レポートサブエージェント呼び出し

```
Use progress-report-agent to generate progress report for Issue #{issue_number} iteration 1.

Context file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/progress-context.json
Output file: dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/progress-report.md
```

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
├── work-plan.md                  ← 作業計画（/work-plan で作成）
└── pm-auto-dev/
    └── iteration-1/
        ├── tdd-context.json
        ├── tdd-result.json
        ├── acceptance-context.json
        ├── acceptance-result.json
        ├── refactor-context.json
        ├── refactor-result.json
        ├── progress-context.json
        └── progress-report.md
```

---

## 完了条件

以下をすべて満たすこと：

- Phase 1: Issue情報収集完了
- Phase 2: TDD実装成功（カバレッジ80%以上、静的解析エラー0件）
- Phase 3: 受入テスト成功（全シナリオ合格）
- Phase 4: リファクタリング完了
- Phase 5: 関連ドキュメントの最新化完了
- Phase 6: 進捗レポート作成完了

---

## 使用例

```
User: /pm-auto-dev 166

PM Auto-Dev:
Phase 1: Issue情報収集完了
  - Issue #166: 新機能追加
  - 受入条件: 2件
  - 実装タスク: 3件

Phase 2: TDD実装 (イテレーション 1/3)
  - カバレッジ: 85%
  - テスト: 10/10 passed

Phase 3: 受入テスト成功
  - テストシナリオ: 2/2 passed

Phase 4: リファクタリング成功
  - カバレッジ: 85% → 88%

Phase 5: ドキュメント最新化完了
  - 更新: README.md, CLAUDE.md

Phase 6: 進捗レポート作成完了

Issue #166 の開発が完了しました！
```
