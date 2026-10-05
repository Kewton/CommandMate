---
model: opus
description: "不具合の調査・対策案提示・修正実施を完全自動化"
---

# PMバグ修正スキル

## 概要

不具合（バグ、エラー、予期しない動作）の調査から修正、テスト、報告まで**完全自動化**するプロジェクトマネージャースキルです。ユーザーは不具合の概要を伝えるだけで、原因調査→対策案提示→修正実施を自律的に実行します。

**アーキテクチャ**: サブエージェント方式を採用し、各フェーズを専門エージェントに委譲します。

## 使用方法
- `/bug-fix [不具合の概要]`
- `/bug-fix "APIエラーが発生"`
- 「一覧ページでエラーが表示される問題を調査してください」

## 実行内容

あなたはプロジェクトマネージャーとして、不具合対応を統括します。各フェーズは**専門サブエージェント**に委譲し、結果ファイルを確認しながら修正完了まで導いてください。

### パラメータ

- **bug_description**: 不具合の概要（必須）
- **error_logs**: エラーログファイルパス（任意）
- **severity**: 重大度（critical/high/medium/low、デフォルト: high）
- **related_issue**: 関連Issue番号（任意）

---

## 実行フェーズ

### Phase 0: 初期設定とTodoリスト作成

まず、TodoWriteツールで作業計画を作成してください：

```
- [ ] Phase 1: 不具合調査
- [ ] Phase 2: 対策案提示・ユーザーフィードバック
- [ ] Phase 3: 作業計画立案
- [ ] Phase 4: TDD修正実施
- [ ] Phase 5: 受入テスト
- [ ] Phase 6: 進捗報告
```

---

### Phase 1: 不具合調査

#### 1-1. 不具合情報の収集

ユーザーから以下の情報を収集（不足している場合は質問）：

```markdown
## 不具合情報
- **概要**: [ユーザー入力]
- **エラーメッセージ**: [あれば]
- **再現手順**: [あれば]
- **影響範囲**: [全ユーザー / 特定条件のユーザー]
- **環境情報**: [ブラウザ, OS, Node.js バージョン]
```

#### 1-1b. bug Issue として起票するとき

不具合を bug Issue として起票するとき（`gh issue create --label bug --body …` でテンプレートを通らないときも）、本文の末尾に次の「分類」節を置く。
値は決まった語から選ぶ（`.github/ISSUE_TEMPLATE/bug_report.md` と同じ語。日次メトリクスの `bug-flow` がこの節を数える）。

```markdown
## 分類
- 原因の PR: #<番号> / 不明 / なし（以前から）/ 上流（<CLI> <版>）
- 発見経路: uat / review / orchestrate / daily-use / automated
- 影響する経路: chat / terminal / cli / mobile / auto-yes / push / なし（内部）
```

- 各行は 1 つを選んで書き換える（例: `- 原因の PR: #3191`、`- 原因の PR: 上流（codex 0.50.0）`、`- 発見経路: uat`）。
  影響する経路だけは複数を `, ` で区切って書ける（例: `- 影響する経路: chat, mobile`）。選択肢を残したままの行は「未記入」に数えられる
- 影響する経路は取りこぼしを防ぐ欄。直す人は、挙げた経路すべてを確かめる
- 影響する経路が `なし（内部）`（テスト・CI・開発用スキル・agent-health・orchestrate）なら、`bug` に加えて `internal` ラベルも付ける
  （`gh issue create … --label bug --label internal`）

#### 1-2. ディレクトリ構造作成

```bash
BUG_ID=$(date +%Y%m%d_%H%M%S)
BASE_DIR="dev-reports/bug-fix/${BUG_ID}"
mkdir -p "$BASE_DIR"
```

#### 1-3. 調査コンテキストファイル作成

**ファイルパス**: `dev-reports/bug-fix/{bug_id}/investigation-context.json`

```json
{
  "issue_description": "不具合の概要",
  "error_logs": ["エラーログ1"],
  "affected_files": ["src/lib/xxx.ts"],
  "reproduction_steps": ["1. xxx", "2. yyy"],
  "environment": {
    "os": "macOS",
    "node_version": "18.x",
    "browser": "Chrome"
  },
  "severity_hint": "high"
}
```

#### 1-4. 調査サブエージェント呼び出し

```
Use investigation-agent to investigate the bug.

Context file: dev-reports/bug-fix/{bug_id}/investigation-context.json
Output file: dev-reports/bug-fix/{bug_id}/investigation-result.json
```

---

### Phase 2: 対策案提示・ユーザーフィードバック

#### 2-1. 直す前に整える（対策案を作る前の判断）

対策案を作る前に、修正の形を 2 つの点で確かめる。

- **修正が「同じ処理の写しの片方だけを直す」形になるとき**: 先に整理の PR で写しを 1 つにする。その後で修正する。
  対策案には、整理の PR と修正の PR を、この順の 2 本として書く。
  整理の PR は振る舞いを変えず、既存のテストを書き換えない（`.claude/prompts/refactoring-core.md` の冒頭の決まり）
- **修正が「分岐を 1 つ足す」形になるとき**: なぜ今の仕組みで扱えないかを、Issue に書く。
  関連 Issue が無いときは、対策案の「内容」に書く

写しがあるかは、直す箇所の関数名・文言・正規表現を grep して確かめる。

理由（#3208、2026-10-04 の集計）: 2026-09-01 以降の fix 198 本は、中央値で 94 行を足し、9 行を消していた。
原因が分かる回帰 66 件のうち、35 件は bug の修正が原因だった。
同じ処理が 2 か所以上にあると、片方だけが直されて食い違う。

#### 2-2. 対策案の提示

調査結果から対策案をユーザーに提示：

```markdown
## 調査結果サマリー

**根本原因**: [原因の説明]
**影響範囲**: [影響範囲]
**重大度**: high

---

## 対策案（優先度順）

### 対策案1: [タイトル] [優先度: High]
- **内容**: [説明]
- **影響ファイル**: [ファイル一覧]

### 対策案2: [タイトル] [優先度: Medium]
- **内容**: [説明]
- **影響ファイル**: [ファイル一覧]

---

## どの対策案を実施しますか？

1. **対策案1のみ実施**
2. **対策案1+2を実施**
3. **カスタム対応**
```

AskUserQuestionツールを使用してユーザーに確認。

---

### Phase 3: 作業計画立案

選択された対策案に基づいて作業計画を作成：

**ファイルパス**: `dev-reports/bug-fix/{bug_id}/work-plan-context.json`

```json
{
  "bug_id": "{bug_id}",
  "bug_description": "不具合の説明",
  "selected_actions": [
    {
      "action_id": "1",
      "title": "対策案タイトル",
      "description": "対策の説明",
      "files_to_modify": ["src/lib/xxx.ts"]
    }
  ],
  "deliverables": ["ファイル1", "ファイル2"],
  "definition_of_done": ["条件1", "条件2"]
}
```

---

### Phase 4: TDD修正実施

#### 4-1. TDD修正コンテキストファイル作成

**ファイルパス**: `dev-reports/bug-fix/{bug_id}/tdd-fix-context.json`

```json
{
  "bug_id": "{bug_id}",
  "bug_description": "不具合の説明",
  "selected_actions": [...],
  "target_coverage": 80
}
```

#### 4-2. TDD実装サブエージェント呼び出し

```
Use tdd-impl-agent to fix the bug with TDD approach.

Context file: dev-reports/bug-fix/{bug_id}/tdd-fix-context.json
Output file: dev-reports/bug-fix/{bug_id}/tdd-fix-result.json
```

---

### Phase 5: 受入テスト

#### 5-1. 受入テストコンテキストファイル作成

**ファイルパス**: `dev-reports/bug-fix/{bug_id}/acceptance-context.json`

```json
{
  "bug_id": "{bug_id}",
  "bug_description": "不具合の説明",
  "fix_summary": "修正内容の要約",
  "acceptance_criteria": [
    "エラーが発生しないこと",
    "正常に動作すること"
  ],
  "test_scenarios": [
    "シナリオ1: 通常時のアクセス",
    "シナリオ2: エラー条件での動作確認"
  ]
}
```

#### 5-2. 受入テストサブエージェント呼び出し

```
Use acceptance-test-agent to verify the bug fix.

Context file: dev-reports/bug-fix/{bug_id}/acceptance-context.json
Output file: dev-reports/bug-fix/{bug_id}/acceptance-result.json
```

---

### Phase 6: 進捗報告

#### 6-1. 進捗レポートサブエージェント呼び出し

```
Use progress-report-agent to generate bug fix report.

Context file: dev-reports/bug-fix/{bug_id}/progress-context.json
Output file: dev-reports/bug-fix/{bug_id}/progress-report.md
```

---

## 完了条件

以下をすべて満たすこと：

- Phase 1: 不具合調査完了（根本原因特定）
- Phase 2: 対策案提示完了（ユーザーフィードバック取得）
- Phase 3: 作業計画立案完了
- Phase 4: TDD修正成功（カバレッジ80%以上）
- Phase 5: 受入テスト成功
- Phase 6: 進捗レポート作成完了

---

## 使用例

```
User: /bug-fix APIエラーが発生

PM Bug Fix:
Phase 1: 不具合調査完了
  - 根本原因: 接続タイムアウト
  - 重大度: high

対策案提示:
  1. [High] タイムアウト設定の変更
  2. [Medium] リトライ処理の追加

→ ユーザー選択: 対策案1+2を実施

Phase 4: TDD修正成功
  - カバレッジ: 85%

Phase 5: 受入テスト成功

Phase 6: 進捗レポート作成完了

不具合修正が完了しました！
```
