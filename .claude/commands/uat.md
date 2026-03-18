---
model: opus
description: "実機受入テスト（UAT）の計画・レビュー・実行・報告を自動化"
---

# 実機受入テスト（UAT）コマンド

## 概要

Issueの受入条件に基づき、実機環境での受入テスト（User Acceptance Test）を計画・レビュー・実行・報告する自動化コマンドです。テスト環境のセットアップから停止まで一貫して実行します。

## 使用方法

```bash
/uat [Issue番号]
/uat [Issue番号] --repo /path/to/test/repo
```

**例**:
```bash
/uat 518
/uat 518 --repo /Users/user/projects/test-repo
```

## 実行内容

あなたはQAエンジニアとして、実機での受入テストを統括します。以下のフェーズを順次実行し、各フェーズの完了を確認しながら進めてください。

### パラメータ

- **issue_number**: テスト対象のIssue番号（必須）
- **--repo**: テストに使用するリポジトリパス（任意。コマンドによってはユーザーに確認）

---

## 実行フェーズ

### Phase 0: 初期設定

#### 0-1. TodoWriteで作業計画作成

```
- [ ] Phase 1: テスト計画立案
- [ ] Phase 2: テスト計画レビュー（1回目）
- [ ] Phase 3: レビュー指摘対応
- [ ] Phase 4: テスト計画レビュー（2回目）
- [ ] Phase 5: テスト環境セットアップ
- [ ] Phase 6: 実機受入テスト実行
- [ ] Phase 7: テスト報告書作成
- [ ] Phase 8: テスト環境停止
```

#### 0-2. ディレクトリ構造作成

```bash
mkdir -p dev-reports/issue/{issue_number}/uat
```

#### 0-3. Issue情報取得

```bash
gh issue view {issue_number} --json number,title,body
```

---

### Phase 1: テスト計画立案

#### 1-1. Issueの受入条件を抽出

Issue本文から以下を抽出：
- **受入条件** (`## 受入条件` / `## 受け入れ条件` / `## Acceptance Criteria` セクション)
- **実装対象** (`## 実装対象` / `## 実装対象コマンド` セクション)
- **共通仕様** (`## 共通仕様` セクション)
- **技術的な注意点** (`## 技術的な注意点` セクション)

#### 1-2. 実装ファイルの確認

Issueで変更・追加されたファイルを特定し、テスト対象の機能を把握する。
必要に応じてコードを読み、テスト可能な動作を特定する。

#### 1-3. テスト計画書の作成

**ファイルパス**: `dev-reports/issue/{issue_number}/uat/test-plan.md`

以下の観点でテストケースを設計する：

1. **正常系テスト**: 各機能が仕様通りに動作すること
2. **異常系テスト**: エラー時に適切なメッセージと終了コードが返ること
3. **オプション・フラグテスト**: 各オプションが正しく機能すること
4. **統合テスト**: 複数機能の連携が正しく動作すること
5. **既存機能への影響確認**: 既存機能が壊れていないこと

テスト計画書の形式:

```markdown
# Issue #{issue_number} 実機受入テスト計画

## テスト概要
- Issue: #{issue_number} {title}
- テスト日: {date}
- テスト環境: CommandMate サーバー (localhost:{port})

## 前提条件
- テストに必要なリポジトリ/データ
- 環境変数設定

## テストケース一覧

### TC-001: {テスト名}
- **テスト内容**: {何を確認するか}
- **前提条件**: {テスト実行前に必要な状態}
- **実行手順**: {具体的なコマンドまたは操作}
- **期待結果**: {正常時の出力・終了コード}
- **確認観点**: {Issueのどの受入条件に対応するか}

### TC-002: ...
```

#### 1-4. 不明点の確認

テスト計画作成中に以下の不明点がある場合、**AskUserQuestion ツールでユーザーに確認する**：
- テストに使用するリポジトリパス（`--repo` 未指定時）
- テストデータの準備方法
- テスト対象外とすべき項目
- 実機でのテストが困難な項目の代替手段

---

### Phase 2: テスト計画レビュー（1回目）

#### 2-1. レビュー観点

以下の観点でテスト計画をレビューする：

1. **Issue網羅性**: Issueに記載された全ての受入条件がテストケースでカバーされていること
2. **実機テスト適合性**: 全テストケースが実際のサーバーに対して実行可能であること（モックではなく実機）
3. **エビデンス取得可能性**: テスト結果のエビデンス（コマンド出力、exit code）が取得可能であること
4. **前提条件の明確性**: 各テストの前提条件と実行順序が明確であること
5. **異常系の網羅性**: エラーケース、バリデーション、境界値が含まれていること

#### 2-2. Issueとテスト計画の突合

Issue本文の受入条件を1つずつ確認し、対応するテストケースが存在するかチェックする。

```bash
gh issue view {issue_number} --json body
```

#### 2-3. レビュー結果の記録

**ファイルパス**: `dev-reports/issue/{issue_number}/uat/review-1.md`

```markdown
# テスト計画レビュー（1回目）

## 網羅性チェック

| # | 受入条件 | 対応テストケース | ステータス |
|---|---------|----------------|----------|
| 1 | {条件} | TC-XXX | ✅ カバー済 / ❌ 未カバー |

## 指摘事項

| # | 種別 | 内容 | 対応方針 |
|---|------|------|---------|
| 1 | must_fix / should_fix | {指摘} | {対応方針} |
```

#### 2-4. 不明点の確認

レビューで不明点がある場合、**AskUserQuestion ツールでユーザーに確認する**。

---

### Phase 3: レビュー指摘対応

テスト計画書（`test-plan.md`）を更新し、Phase 2 の指摘事項をすべて対応する。

---

### Phase 4: テスト計画レビュー（2回目）

Phase 2 と同じ観点で再レビューする。

**ファイルパス**: `dev-reports/issue/{issue_number}/uat/review-2.md`

全ての must_fix が対応済みであることを確認する。

---

### Phase 5: テスト環境セットアップ

#### 5-1. 利用可能なポートの検出

ポート 3010〜3030 の範囲で未使用のポートを検出する：

```bash
for port in $(seq 3010 3030); do
  if ! lsof -i :$port -t >/dev/null 2>&1; then
    echo "Available: $port"
    break
  fi
done
```

検出したポートを `UAT_PORT` として記録する。

#### 5-2. ビルドとサーバー起動

```bash
CM_PORT={UAT_PORT} ./scripts/stop.sh 2>/dev/null
CM_PORT={UAT_PORT} ./scripts/build-and-start.sh --daemon
```

ビルドに失敗した場合はエラーを報告して終了する。

#### 5-3. サーバー起動確認

```bash
curl -s http://localhost:{UAT_PORT}/api/worktrees | head -c 100
```

#### 5-4. テストデータ準備

`--repo` で指定されたリポジトリをスキャンして登録する：

```bash
curl -s http://localhost:{UAT_PORT}/api/repositories/scan -X POST \
  -H "Content-Type: application/json" \
  -d '{"repositoryPath":"{repo_path}"}'
```

#### 5-5. セットアップ結果を記録

使用ポート、登録リポジトリ、worktree ID 等をログに記録する。

---

### Phase 6: 実機受入テスト実行

#### 6-1. テスト実行

テスト計画書の各テストケースを順次実行する。

**各テストケースで以下を記録する**：

1. **テスト内容**: 何を確認したか
2. **実行した操作**: 実際に実行したコマンド（環境変数含む）
3. **結果（エビデンス）**: コマンドの実際の出力（stdout/stderr）と exit code

#### 6-2. テスト結果の記録

**ファイルパス**: `dev-reports/issue/{issue_number}/uat/test-results.json`

```json
{
  "issue_number": {issue_number},
  "test_date": "{date}",
  "environment": {
    "port": {UAT_PORT},
    "branch": "{branch}",
    "repo": "{repo_path}"
  },
  "results": [
    {
      "id": "TC-001",
      "title": "{テスト名}",
      "status": "pass|fail",
      "command": "{実行コマンド}",
      "stdout": "{実際の出力}",
      "stderr": "{stderrの出力}",
      "exit_code": 0,
      "evidence_note": "{補足}"
    }
  ],
  "summary": {
    "total": N,
    "passed": N,
    "failed": N,
    "pass_rate": "100%"
  }
}
```

#### 6-3. 失敗時の対応

テストが失敗した場合：
1. 失敗内容を記録する
2. 原因が実装の不具合の場合、修正を実施する
3. 修正後、該当テストケースを再実行する
4. 再実行結果を記録する（修正前・修正後の両方を記載）

---

### Phase 7: テスト報告書作成

#### 7-1. HTML形式の報告書を作成

**ファイルパス**: `dev-reports/issue/{issue_number}/uat/acceptance-test-report.html`

報告書には以下を含む：

1. **テスト概要**: Issue情報、テスト環境、実施日
2. **サマリー**: テスト総数、合格数、不合格数、合格率
3. **各テストケースの詳細**:
   - テスト内容（何を確認したか）
   - 実行した操作（実際のコマンド）
   - 結果・エビデンス（実際の出力、exit code）
   - 判定（PASS/FAIL）
4. **修正履歴**（失敗→修正→再テストがあった場合）

HTMLは自己完結型（外部CSS/JS依存なし）で、見やすいスタイリングを適用する。

---

### Phase 8: テスト環境停止

#### 8-1. サーバー停止

```bash
CM_PORT={UAT_PORT} ./scripts/stop.sh
```

#### 8-2. ポート解放確認

```bash
lsof -i :{UAT_PORT} -t 2>/dev/null && echo "WARNING: Port still in use" || echo "Port released"
```

ポートが解放されない場合は強制停止する：

```bash
lsof -i :{UAT_PORT} -t 2>/dev/null | xargs kill -9 2>/dev/null
```

#### 8-3. 完了報告

```
✅ 実機受入テスト完了

📋 テスト結果:
  Issue: #{issue_number}
  テスト総数: {total}
  合格: {passed}
  不合格: {failed}
  合格率: {pass_rate}

📄 報告書: dev-reports/issue/{issue_number}/uat/acceptance-test-report.html

🔧 テスト環境:
  ポート: {UAT_PORT} → 停止済み
```

---

## ファイル構造

```
dev-reports/issue/{issue_number}/
└── uat/
    ├── test-plan.md                    # テスト計画書
    ├── review-1.md                     # レビュー結果（1回目）
    ├── review-2.md                     # レビュー結果（2回目）
    ├── test-results.json               # テスト結果データ
    └── acceptance-test-report.html     # テスト報告書（HTML）
```

---

## 完了条件

以下をすべて満たすこと：

- Phase 1: テスト計画書が作成されている
- Phase 2: 1回目レビューでIssue受入条件の網羅性を確認
- Phase 3: レビュー指摘事項がすべて対応済み
- Phase 4: 2回目レビューで全 must_fix が解消
- Phase 5: テスト環境が起動し、テストデータが準備されている
- Phase 6: 全テストケースが実行され、結果が記録されている
- Phase 7: HTML形式のテスト報告書が `dev-reports/` 配下に作成されている
- Phase 8: テスト環境のサーバーが停止し、ポートが解放されている

---

## 使用例

```
User: /uat 518

UAT:

📋 Phase 1: テスト計画立案
  - Issue #518 の受入条件を抽出: 22件
  - テストケース作成: 24件
  ✅ テスト計画完了

📋 Phase 2: テスト計画レビュー（1回目）
  - Issue網羅性: 22/22 カバー
  - 指摘: must_fix 1件, should_fix 2件
  ✅ レビュー完了

📋 Phase 3: レビュー指摘対応
  - 対応: 3/3件
  ✅ 指摘対応完了

📋 Phase 4: テスト計画レビュー（2回目）
  - 指摘: 0件
  ✅ レビュー完了

📋 Phase 5: テスト環境セットアップ
  - ポート: 3015（自動検出）
  - ビルド: 成功
  - リポジトリ登録: 完了
  ✅ 環境セットアップ完了

📋 Phase 6: 実機受入テスト実行
  - テスト実行: 24/24 PASS
  ✅ テスト完了

📋 Phase 7: テスト報告書作成
  - 報告書: dev-reports/issue/518/uat/acceptance-test-report.html
  ✅ 報告書作成完了

📋 Phase 8: テスト環境停止
  - ポート 3015 停止・解放確認
  ✅ 環境停止完了

🎉 Issue #518 の実機受入テスト完了！ (24/24 PASS)
```

---

## 関連コマンド

- `/acceptance-test`: 受入テスト（サブエージェント方式、コードレベル確認）
- `/pm-auto-dev`: TDD自動開発（UATは Phase 3.5 として統合可能）
- `/tdd-impl`: TDD実装
