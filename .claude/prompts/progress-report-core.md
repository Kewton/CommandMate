# 進捗レポートコアプロンプト

このプロンプトは、スラッシュコマンドとサブエージェントの両方から実行されます。

---

## 入力情報の取得

### スラッシュコマンドモードの場合

ユーザーから対話的に以下の情報を取得してください：

```bash
# Issue情報を取得
gh issue view {issue_number} --json number,title,body,labels,assignees
```

- Issue番号
- 現在のイテレーション番号
- 確認する結果ファイル（tdd-result.json, acceptance-result.json, refactor-result.json）

### サブエージェントモードの場合

コンテキストファイルから情報を取得してください：

```bash
# 最新のコンテキストファイルを探す
CONTEXT_FILE=$(find dev-reports/issue/*/pm-auto-dev/iteration-*/progress-context.json 2>/dev/null | sort -V | tail -1)

if [ -z "$CONTEXT_FILE" ]; then
    echo "Error: progress-context.json not found"
    exit 1
fi

echo "Context file: $CONTEXT_FILE"
cat "$CONTEXT_FILE"
```

コンテキストファイル構造:
```json
{
  "issue_number": 166,
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

---

## 進捗レポート生成フロー

### Phase 1: 結果ファイル収集

各フェーズの結果ファイルを読み込みます。

```bash
# ベースディレクトリを取得
BASE_DIR=$(dirname "$CONTEXT_FILE")

# TDD結果
if [ -f "$BASE_DIR/tdd-result.json" ]; then
    echo "TDD Result:"
    cat "$BASE_DIR/tdd-result.json"
fi

# 受入テスト結果
if [ -f "$BASE_DIR/acceptance-result.json" ]; then
    echo "Acceptance Test Result:"
    cat "$BASE_DIR/acceptance-result.json"
fi

# リファクタリング結果
if [ -f "$BASE_DIR/refactor-result.json" ]; then
    echo "Refactoring Result:"
    cat "$BASE_DIR/refactor-result.json"
fi
```

---

### Phase 2: Git履歴確認

実装期間のコミット履歴を取得します：

```bash
# 現在のブランチ名とIssue番号を取得
BRANCH=$(git branch --show-current)
ISSUE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+')

# Issue関連のコミット履歴
git log --oneline --grep="$ISSUE_NUM" | head -10

# または、最近のコミット
git log --oneline -10
```

---

### Phase 3: 品質メトリクス集計

各フェーズの品質メトリクスを集計します。

#### TDDフェーズ
- テストカバレッジ
- テスト成功率
- 静的解析エラー数

#### 受入テストフェーズ
- テストシナリオ成功率
- 受入条件検証状況

#### リファクタリングフェーズ
- カバレッジ改善率
- 静的解析エラー削減

#### 検証メトリクス（対象期間の実績）

対象期間の Eval メトリクス（#1551）を取得します。**取れなくてもレポート生成は止めません。**

```bash
commandmate report metrics --days <対象期間の日数> --json > /tmp/vibe-metrics.json 2>&1; echo $?
```

- `--days` は **1..90 の整数のみ**。範囲外はクランプされず `exit 2` で失敗するので、
  期間を計算した側で 1..90 に丸めてから渡す。
- `> ファイル 2>&1; echo $?` の形を崩さないこと。`| grep` に繋ぐと exit code が消え、失敗を成功として読む。
- **exit code が 0 以外なら「検証メトリクス」セクションごと省略する**（サーバ未稼働は `1`、
  認証エラー・範囲外は `2`、`commandmate` 不在は `127`）。失敗時のファイルには JSON ではなく
  エラー文が入るため、パースしてから判断してはいけない。
- exit 0 でも `tasks.total` / `verification.runs` / `intervention.humanResponds` /
  `intervention.autoAnswered` が**すべて 0** なら、同じく**セクションごと省略する**
  （日次レポートの `buildMetricsSection()` と同じ方針。ゼロの羅列は「何も起きていない」を
  「発見」として語らせるため）。
- 比率は分母ゼロのとき `0` ではなく `null` で返る。`null` は `n/a` と書き、**`0%` と書いてはいけない**。
- `intervention.suppressedByPolicy` は v1 では常に `null`（抑止ログが未 DB 化）なので載せない。

---

### Phase 4: ブロッカー/課題の特定

各フェーズでの問題点を特定します。

```bash
# 失敗したフェーズがあるか確認
if grep -q '"status": "failed"' "$BASE_DIR"/*.json 2>/dev/null; then
    echo "失敗したフェーズがあります"
    grep -l '"status": "failed"' "$BASE_DIR"/*.json
fi
```

ブロッカー例:
- テストカバレッジ不足
- 受入条件未達成
- 静的解析エラー残存

---

### Phase 5: 次のステップ提案

現在の状況に基づいて次のアクションを提案します。

#### すべて成功の場合
```
次のステップ:
1. PR作成
2. レビュー依頼
3. マージ後のデプロイ計画
```

#### 一部失敗の場合
```
次のステップ:
1. 失敗したフェーズの再実行
2. 根本原因の調査
3. 実装の見直し
```

---

## 出力

### スラッシュコマンドモードの場合

ターミナルに進捗レポートを表示してください：

```markdown
# 進捗レポート - Issue #166 (Iteration 1)

## 概要

**Issue**: #166 - [Issue Title]
**Iteration**: 1
**報告日時**: 2025-12-05 15:30:00
**ステータス**: 成功

---

## フェーズ別結果

### Phase 1: TDD実装
**ステータス**: 成功

- **カバレッジ**: 85.0% (目標: 80%)
- **テスト結果**: 10/10 passed
- **静的解析**: ESLint 0 errors, TypeScript 0 errors

**変更ファイル**:
- `src/lib/xxx.ts`
- `tests/unit/xxx.test.ts`

**コミット**:
- `abc1234`: feat(xxx): implement feature XXX

---

### Phase 2: 受入テスト
**ステータス**: 成功

- **テストシナリオ**: 5/5 passed
- **受入条件検証**: 3/3 verified

---

### Phase 3: リファクタリング
**ステータス**: 成功

| 指標 | Before | After | 改善 |
|------|--------|-------|------|
| Coverage | 75.0% | 85.0% | +10.0% |

---

## 総合品質メトリクス

- テストカバレッジ: **85.0%** (目標: 80%)
- 静的解析エラー: **0件**
- すべての受入条件達成
- コード品質改善完了

---

## 検証メトリクス

> 取得できなかった場合（exit code ≠ 0）と、全カウンタが 0 の場合は**この見出しごと省略**する。

**対象期間**: 直近 7 日

| 群 | 実績 |
|------|------|
| tasks | total=3 / succeeded=1 / failed=1 / not_started=1 / success_rate=**33.3%** / avg_retry_loops=0.0 |
| verification | runs=6 / pass_rate=**66.7%** / top fails: `lint` x1, `work-evidence` x1 |
| intervention | human_responds=**0** / auto_answered=1 |

---

## 次のステップ

1. **PR作成** - 実装完了のためPRを作成
2. **レビュー依頼** - チームメンバーにレビュー依頼
3. **マージ後のデプロイ計画** - 本番環境へのデプロイ準備

---

## 備考

- すべてのフェーズが成功
- 品質基準を満たしている
- ブロッカーなし

**Issue #166の実装が完了しました！**
```

---

### サブエージェントモードの場合

進捗レポートをMarkdownファイルとして作成してください：

```bash
# レポートファイルパスを決定
REPORT_FILE=$(dirname "$CONTEXT_FILE")/progress-report.md
```

Write toolで上記と同じMarkdown内容を作成します。

**重要**: レポートファイルが作成されたことを報告してください。

---

## エラーハンドリング

### 結果ファイルが見つからない場合

```markdown
# 進捗レポート - Issue #166 (Iteration 1)

## エラー

**エラー内容**: 結果ファイルが見つかりません

- `tdd-result.json` が存在しません
- `acceptance-result.json` が存在します
- `refactor-result.json` が存在します

## 次のステップ

1. TDDフェーズを再実行してください
2. `tdd-result.json` が正しく作成されるか確認してください
```

---

## レポート作成原則

1. **事実ベース** - 推測ではなく結果ファイルの内容を報告
2. **明確な状態表示** - 成功/失敗/警告を明示
3. **次のアクション明示** - 何をすべきか具体的に記載
4. **視覚的にわかりやすく** - 表、箇条書きを活用

---

## 完了条件

以下をすべて満たすこと：

- すべての結果ファイルを読み込み済み
- Git履歴を確認済み
- 品質メトリクスを集計済み
- 次のステップを提案済み
- レポートファイルが作成済み（サブエージェントモード）
