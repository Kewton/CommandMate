---
model: sonnet
description: "開発進捗サマリ作成、ブロッカー報告"
---

# 進捗報告スキル

## 概要
開発の各フェーズ（TDD、テスト、リファクタリング）の結果を集約し、進捗レポートを作成するスキルです。

このスキルは**スラッシュコマンドモード**で動作します（ユーザーが直接実行）。

## 使用方法
- `/progress-report [Issue番号]`
- 「Issue #[番号]の進捗レポートを作成してください」
- 「現在の開発状況をまとめてください」

---

## 実行内容

**共通プロンプトを読み込んで実行します**:

```bash
cat .claude/prompts/progress-report-core.md
```

↑ **このプロンプトの内容に従って、進捗レポートを作成してください。**

---

## 動作モード

**スラッシュコマンドモード**:
- ユーザーから対話的に情報を取得
- Issue番号を確認
- 各フェーズの結果ファイルを読み込み
- Git履歴を確認
- 結果をMarkdown形式でターミナルに表示

---

## レポート内容

1. **概要** - Issue番号、ステータス
2. **フェーズ別結果** - TDD、テスト
3. **総合品質メトリクス** - カバレッジ、静的解析エラー
4. **検証メトリクス** - 対象期間の `report metrics` 出力（tasks / verification / intervention）
5. **ブロッカー** - 問題点、課題（あれば）
6. **次のステップ** - 具体的なアクション提案

### 4. 検証メトリクスの取り方

```bash
commandmate report metrics --days <対象期間の日数> --json > /tmp/vibe-metrics.json 2>&1; echo $?
```

- `--days` は **1..90 の整数のみ**。範囲外はクランプされず `exit 2` で失敗するので、
  期間を計算した側で 1..90 に丸めてから渡す。
- `> ファイル 2>&1; echo $?` の形を崩さないこと。`| grep` に繋ぐと exit code が消え、失敗を成功として読む。
- **exit code が 0 以外なら、このセクションごと省略する**（サーバ未稼働は `1`、認証エラー・範囲外は `2`、
  `commandmate` 不在は `127`）。**進捗レポートの生成自体は止めない**。失敗時のファイルには JSON ではなく
  エラー文が入るため、パースしてから判断してはいけない。
- exit 0 でも `tasks.total` / `verification.runs` / `intervention.humanResponds` / `intervention.autoAnswered`
  が**すべて 0** なら、同じく**セクションごと省略する**（日次レポートの `buildMetricsSection()` と同じ方針。
  ゼロの羅列は「何も起きていない」をモデルに「発見」として語らせるため）。
- 比率は分母ゼロのとき `0` ではなく `null` で返る。`null` は `n/a` と書き、**`0%` と書いてはいけない**。

載せる項目:

| 群 | フィールド |
|---|---|
| tasks | `total` / `succeeded` / `failed` / `notStarted` / `successRate` / `avgRetryLoops` |
| verification | `runs` / `passRate` / `gateFailBreakdown`（`failCount` 降順・最大 10 件） |
| intervention | `humanResponds` / `autoAnswered` |

> `intervention.suppressedByPolicy` は v1 では常に `null`（抑止ログが DB 化されていない）なので載せない。

---

## 完了条件

以下をすべて満たすこと：
- すべての結果ファイルを読み込み済み
- Git履歴を確認済み
- 品質メトリクスを集計済み
- 次のステップを提案済み

---

## サブエージェントモード

サブエージェントとして呼び出す場合は、PM Auto-Devが以下のように実行します：

```
Use progress-report-agent to generate progress report for Issue #166.
```

この場合、`.claude/agents/progress-report-agent.md` が使用されます。
