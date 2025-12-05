# 要件定義: Commands & Agents 整備

**作成日**: 2025-12-05
**プロジェクト**: MyCodeBranchDesk
**参考**: MySwiftAgent (.claude/commands, .claude/agents)

---

## 1. 概要

### 目的
MyCodeBranchDeskの開発効率を向上させるため、Claude Codeのスラッシュコマンド（Commands）とサブエージェント（Agents）を整備する。

### 背景
- MySwiftAgentでは17種類のコマンドと5種類のエージェントが定義されている
- これらを参考に、MyCodeBranchDeskの技術スタックと開発フローに最適化したコマンド/エージェントを定義する

### プロジェクト特性

| 項目 | MySwiftAgent | MyCodeBranchDesk |
|------|--------------|------------------|
| 言語 | Python | TypeScript |
| フレームワーク | FastAPI, LangGraph | Next.js 14 |
| テスト | pytest, Playwright | Vitest, Playwright |
| DB | PostgreSQL, SQLite | SQLite (better-sqlite3) |
| リンター | Ruff, MyPy | ESLint, TypeScript |
| パッケージ管理 | uv | npm |

---

## 2. Commands（スラッシュコマンド）一覧

### 2.1 必須コマンド（Phase 1）

| コマンド | 説明 | 優先度 | 参考元 |
|---------|------|--------|--------|
| `/work-plan` | Issue単位の作業計画立案 | 高 | work-plan.md |
| `/create-pr` | PR自動作成（タイトル・説明自動生成） | 高 | pm-create-pr.md |
| `/progress-report` | 進捗報告書作成 | 高 | progress-report.md |
| `/tdd-impl` | TDD実装（Red-Green-Refactor） | 高 | tdd-impl.md |

### 2.2 推奨コマンド（Phase 2）

| コマンド | 説明 | 優先度 | 参考元 |
|---------|------|--------|--------|
| `/pm-auto-dev` | 自動開発（TDD→テスト→報告） | 中 | pm-auto-dev.md |
| `/bug-fix` | バグ修正ワークフロー | 中 | pm-bug-fix.md |
| `/refactoring` | リファクタリング実行 | 中 | refactoring.md |
| `/acceptance-test` | 受け入れテスト実行 | 中 | acceptance-test.md |

### 2.3 オプションコマンド（Phase 3）

| コマンド | 説明 | 優先度 | 参考元 |
|---------|------|--------|--------|
| `/issue-create` | Issue一括作成 | 低 | issue-create.md |
| `/issue-split` | Issue分割計画 | 低 | issue-split.md |
| `/architecture-review` | アーキテクチャレビュー | 低 | architecture-review.md |
| `/design-policy` | 設計方針策定 | 低 | design-policy.md |

---

## 3. Agents（サブエージェント）一覧

### 3.1 必須エージェント（Phase 1）

| エージェント | 説明 | 用途 |
|-------------|------|------|
| `tdd-impl-agent` | TDD実装専門 | `/tdd-impl`, `/pm-auto-dev` |
| `progress-report-agent` | 進捗報告生成 | `/progress-report`, `/pm-auto-dev` |

### 3.2 推奨エージェント（Phase 2）

| エージェント | 説明 | 用途 |
|-------------|------|------|
| `investigation-agent` | バグ調査専門 | `/bug-fix` |
| `acceptance-test-agent` | 受け入れテスト | `/acceptance-test`, `/pm-auto-dev` |
| `refactoring-agent` | リファクタリング | `/refactoring`, `/pm-auto-dev` |

---

## 4. 詳細仕様

### 4.1 /work-plan コマンド

```yaml
---
model: opus
description: "Issue単位の作業計画立案"
---
```

**入力**: Issue番号または概要
**出力**: 作業計画書（Markdown）

**機能**:
1. Issue情報取得（`gh issue view`）
2. タスク分解（実装、テスト、ドキュメント）
3. 依存関係の可視化（Mermaid図）
4. スケジュール策定
5. 成果物チェックリスト作成

**出力先**: `dev-reports/issue/{issue_number}/work-plan.md`

---

### 4.2 /create-pr コマンド

```yaml
---
model: opus
description: "PR自動作成"
---
```

**入力**: Issue番号（自動検出可）
**出力**: GitHub PR

**機能**:
1. ブランチ名からIssue番号検出
2. 変更内容の分析
3. PRタイトル自動生成（Conventional Commits形式）
4. PR説明文自動生成
   - 概要
   - 変更内容
   - テスト結果
   - チェックリスト
5. PR作成（`gh pr create`）

**事前チェック**:
- 未コミット変更なし
- CIチェックパス（`npm run lint && npm run test:unit && npm run build`）

---

### 4.3 /progress-report コマンド

```yaml
---
model: opus
description: "進捗報告書作成"
---
```

**入力**: Issue番号
**出力**: 進捗報告書（Markdown）

**機能**:
1. 作業状況の確認
2. テスト結果の集計
3. 残タスクの確認
4. ブロッカーの特定
5. 次のアクション提示

**出力先**: `dev-reports/issue/{issue_number}/progress-report.md`

---

### 4.4 /tdd-impl コマンド

```yaml
---
model: opus
description: "TDD実装（Red-Green-Refactor）"
---
```

**入力**: Issue番号、コンテキストファイル
**出力**: 実装コード、テストコード

**機能**:
1. 受け入れ条件の確認
2. テストファースト実装
   - Red: 失敗するテスト作成
   - Green: 最小実装
   - Refactor: コード改善
3. カバレッジ確認（目標: 80%以上）
4. 静的解析チェック（ESLint, TypeScript）

**技術スタック**:
- テストフレームワーク: Vitest
- カバレッジ: `npm run test:coverage`
- リンター: `npm run lint`
- 型チェック: `npx tsc --noEmit`

---

### 4.5 /pm-auto-dev コマンド

```yaml
---
model: opus
description: "Issue開発を完全自動化"
---
```

**入力**: Issue番号
**出力**: 実装完了、進捗報告

**フェーズ**:
1. Issue情報収集
2. TDD実装（tdd-impl-agent）
3. 受け入れテスト（acceptance-test-agent）
4. リファクタリング（refactoring-agent）
5. 進捗報告（progress-report-agent）

**イテレーション制御**:
- 最大3回のイテレーション
- テスト失敗時は自動修正を試行

---

### 4.6 /bug-fix コマンド

```yaml
---
model: opus
description: "バグ修正ワークフロー"
---
```

**入力**: Issue番号またはエラー説明
**出力**: 修正コード、テスト

**フェーズ**:
1. 現状把握（investigation-agent）
2. 根本原因分析
3. 修正実装
4. リグレッションテスト
5. 進捗報告

---

## 5. ディレクトリ構造

```
.claude/
├── commands/           # スラッシュコマンド定義
│   ├── work-plan.md
│   ├── create-pr.md
│   ├── progress-report.md
│   ├── tdd-impl.md
│   ├── pm-auto-dev.md
│   ├── bug-fix.md
│   ├── refactoring.md
│   └── acceptance-test.md
│
├── agents/             # サブエージェント定義
│   ├── tdd-impl-agent.md
│   ├── progress-report-agent.md
│   ├── investigation-agent.md
│   ├── acceptance-test-agent.md
│   └── refactoring-agent.md
│
├── prompts/            # 共通プロンプト
│   ├── tdd-impl-core.md
│   ├── progress-report-core.md
│   └── refactoring-core.md
│
└── settings.local.json # ローカル設定
```

---

## 6. 出力ファイル構造

```
dev-reports/
└── issue/
    └── {issue_number}/
        ├── work-plan.md           # 作業計画
        ├── progress-report.md     # 進捗報告
        └── pm-auto-dev/
            └── iteration-{N}/
                ├── tdd-context.json
                ├── tdd-result.json
                ├── acceptance-context.json
                ├── acceptance-result.json
                ├── refactor-context.json
                └── refactor-result.json
```

---

## 7. 技術仕様

### 7.1 品質チェックコマンド

```bash
# リント
npm run lint

# 型チェック
npx tsc --noEmit

# 単体テスト
npm run test:unit

# 結合テスト
npm run test:integration

# カバレッジ付きテスト
npm run test:coverage

# ビルド
npm run build
```

### 7.2 必須通過基準

| チェック項目 | 基準 |
|-------------|------|
| ESLint | エラー0件 |
| TypeScript | 型エラー0件 |
| Unit Test | 全テストパス |
| Coverage | 80%以上（推奨） |
| Build | 成功 |

### 7.3 コミットメッセージ規約

```
<type>(<scope>): <subject>

<body>

<footer>
```

| type | 説明 |
|------|------|
| feat | 新機能 |
| fix | バグ修正 |
| docs | ドキュメント |
| style | フォーマット |
| refactor | リファクタリング |
| test | テスト |
| chore | ビルド・設定 |
| ci | CI/CD |

---

## 8. 実装計画

### Phase 1: 基盤整備（優先度: 高）

1. `.claude/commands/` ディレクトリ作成
2. `.claude/agents/` ディレクトリ作成
3. `/work-plan` コマンド実装
4. `/create-pr` コマンド実装
5. `/progress-report` コマンド実装
6. `/tdd-impl` コマンド実装

### Phase 2: 自動化強化（優先度: 中）

1. `tdd-impl-agent` 実装
2. `progress-report-agent` 実装
3. `/pm-auto-dev` コマンド実装
4. `/bug-fix` コマンド実装
5. `investigation-agent` 実装

### Phase 3: 拡張機能（優先度: 低）

1. `/refactoring` コマンド実装
2. `/acceptance-test` コマンド実装
3. `refactoring-agent` 実装
4. `acceptance-test-agent` 実装

---

## 9. 成功基準

### 定量指標

| 指標 | 目標 |
|------|------|
| コマンド数 | Phase 1: 4個、Phase 2: 8個 |
| エージェント数 | Phase 1: 2個、Phase 2: 5個 |
| ドキュメント完備率 | 100% |

### 定性指標

- 開発者がスラッシュコマンドで主要タスクを実行可能
- Issue→PR作成までの一連のフローが自動化可能
- 進捗報告が標準化されている

---

## 10. 参照ドキュメント

### MySwiftAgent参考ファイル

- `/Users/maenokota/share/work/github_kewton/MySwiftAgent/.claude/commands/`
- `/Users/maenokota/share/work/github_kewton/MySwiftAgent/.claude/agents/`
- `/Users/maenokota/share/work/github_kewton/MySwiftAgent/.claude/prompts/`

### Claude Code公式ドキュメント

- [Slash Commands](https://docs.anthropic.com/claude-code/slash-commands)
- [Custom Agents](https://docs.anthropic.com/claude-code/agents)

---

## 11. 承認

この要件定義に基づき、Phase 1から順次実装を進めてよろしいでしょうか？

### 選択肢

1. **全Phase実施を承認** → Phase 1から順次実行
2. **Phase 1のみ実施** → 基盤コマンドのみ
3. **要件の見直し** → 修正点を指摘
