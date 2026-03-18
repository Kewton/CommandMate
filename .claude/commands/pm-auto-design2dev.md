---
model: sonnet
description: "設計レビューから実装完了まで完全自動化（設計レビュー→作業計画→TDD実装）"
---

# PM自動 設計→開発スキル

## 概要
設計レビューから実装完了までの全工程（設計レビュー → 作業計画立案 → TDD実装）を**完全自動化**するプロジェクトマネージャースキルです。ユーザーはIssue番号を指定するだけで、設計から開発完了まで自律的に実行します。

**アーキテクチャ**: 3つの既存コマンドを順次実行し、各フェーズの成果物を次フェーズに引き継ぎます。

## 使用方法
- `/pm-auto-design2dev [Issue番号]`
- 「Issue #XXXを設計から開発まで自動実行してください」

## 実行内容

あなたはプロジェクトマネージャーとして、設計から開発までの全工程を統括します。以下の3つのフェーズを順次実行し、各フェーズの完了を確認しながら進めてください。

### パラメータ

- **issue_number**: 開発対象のIssue番号（必須）

### サブエージェントモデル指定

各サブコマンド内で個別にモデル指定されています（レビュー・TDD系=opus、反映・報告系=sonnet継承）。

---

## 実行フェーズ

### Phase 0: 初期設定とTodoリスト作成

まず、TodoWriteツールで作業計画を作成してください：

```
- [ ] Phase 1: 設計方針書確認・作成
- [ ] Phase 2: マルチステージ設計レビュー
- [ ] Phase 3: 作業計画立案
- [ ] Phase 4: TDD自動開発
- [ ] Phase 5: 完了報告
```

---

### Phase 1: 設計方針書の確認・作成

#### 1-1. 設計方針書の存在確認

```bash
ls dev-reports/design/issue-{issue_number}-*-design-policy.md 2>/dev/null
```

#### 1-2. 設計方針書がない場合

設計方針書が存在しない場合は、`/design-policy` コマンドを実行して作成：

```
/design-policy {issue_number}
```

---

### Phase 2: マルチステージ設計レビュー

#### 2-1. 設計レビュー実行

`/multi-stage-design-review` コマンドを実行：

```
/multi-stage-design-review {issue_number}
```

**このフェーズで行われること**:
- Stage 1: 通常レビュー（設計原則）
- Stage 2: 整合性レビュー
- Stage 3: 影響分析レビュー
- Stage 4: セキュリティレビュー
- 各ステージの指摘事項を設計方針書に反映

#### 2-2. 完了確認

- サマリーレポートが生成されていること
- 設計方針書が更新されていること

**出力ファイル**: `dev-reports/issue/{issue_number}/multi-stage-design-review/summary-report.md`

---

### Phase 3: 作業計画立案

#### 3-1. 作業計画作成

`/work-plan` コマンドを実行：

```
/work-plan {issue_number}
```

**このフェーズで行われること**:
- 設計方針書に基づいたタスク分解
- 依存関係の整理
- 実装順序の決定

#### 3-2. 完了確認

- 作業計画書が生成されていること

**出力ファイル**: `dev-reports/issue/{issue_number}/work-plan.md`

---

### Phase 4: TDD自動開発

#### 4-1. TDD実装実行

`/pm-auto-dev` コマンドを実行：

```
/pm-auto-dev {issue_number}
```

**このフェーズで行われること**:
- TDD実装（Red-Green-Refactor）
- 受入テスト
- リファクタリング
- ドキュメント更新
- 実機受入テスト（UAT: `/uat` コマンド）
- 進捗報告

#### 4-2. 完了確認

- 全テストがパスしていること
- 静的解析エラーが0件であること
- 進捗レポートが生成されていること

**出力ファイル**: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/progress-report.md`

---

### Phase 5: 完了報告

#### 5-1. 最終検証

```bash
npx tsc --noEmit
npm run lint
npm run test:unit
```

#### 5-2. 成果物サマリー

完了時に以下を報告：

```markdown
## PM Auto Design2Dev 完了報告

### Issue #{issue_number}

#### 実行フェーズ結果

| Phase | 内容 | ステータス |
|-------|------|-----------|
| 1 | 設計方針書確認・作成 | ✅ |
| 2 | マルチステージ設計レビュー | ✅ |
| 3 | 作業計画立案 | ✅ |
| 4 | TDD自動開発 | ✅ |

#### 生成ファイル

- 設計方針書: `dev-reports/design/issue-{issue_number}-*-design-policy.md`
- 設計レビュー: `dev-reports/issue/{issue_number}/multi-stage-design-review/summary-report.md`
- 作業計画: `dev-reports/issue/{issue_number}/work-plan.md`
- 進捗報告: `dev-reports/issue/{issue_number}/pm-auto-dev/iteration-1/progress-report.md`

#### 次のアクション

- [ ] コミット確認
- [ ] PR作成（`/create-pr`）
```

---

## ファイル構造

```
dev-reports/
├── design/
│   └── issue-{issue_number}-*-design-policy.md  ← 設計方針書
└── issue/{issue_number}/
    ├── multi-stage-design-review/
    │   ├── stage1-*.json
    │   ├── stage2-*.json
    │   ├── stage3-*.json
    │   ├── stage4-*.json
    │   └── summary-report.md
    ├── work-plan.md
    └── pm-auto-dev/
        └── iteration-1/
            ├── tdd-*.json
            ├── acceptance-*.json
            ├── refactor-*.json
            └── progress-report.md
```

---

## 完了条件

以下をすべて満たすこと：

- Phase 1: 設計方針書が存在する
- Phase 2: マルチステージ設計レビュー完了（4ステージすべて）
- Phase 3: 作業計画書が作成されている
- Phase 4: TDD自動開発完了（テスト全パス、静的解析エラー0件）
- Phase 5: 完了報告

---

## 使用例

```
User: /pm-auto-design2dev 105

PM Auto Design2Dev:

📋 Phase 1/5: 設計方針書確認
  - 設計方針書: dev-reports/design/issue-105-xxx-design-policy.md
  ✅ 設計方針書確認完了

📋 Phase 2/5: マルチステージ設計レビュー
  - Stage 1: 通常レビュー ✅
  - Stage 2: 整合性レビュー ✅
  - Stage 3: 影響分析レビュー ✅
  - Stage 4: セキュリティレビュー ✅
  - 指摘対応: 8/8件
  ✅ 設計レビュー完了

📋 Phase 3/5: 作業計画立案
  - タスク分解: 6タスク
  - 依存関係: 整理済み
  ✅ 作業計画完了

📋 Phase 4/5: TDD自動開発
  - TDD実装: ✅ (カバレッジ 85%)
  - 受入テスト: ✅ (6/6 passed)
  - リファクタリング: ✅
  - ドキュメント更新: ✅
  ✅ TDD自動開発完了

📋 Phase 5/5: 完了報告
  - TypeScript: ✅ Pass
  - ESLint: ✅ Pass
  - Unit Tests: ✅ 1950/1950 Pass

🎉 Issue #105 の設計から開発まで完了しました！

次のアクション:
- /create-pr でPR作成
```

---

## 関連コマンド

- `/design-policy`: 設計方針書作成
- `/multi-stage-design-review`: マルチステージ設計レビュー
- `/work-plan`: 作業計画立案
- `/pm-auto-dev`: TDD自動開発
- `/create-pr`: PR作成
