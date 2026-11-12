# 完了報告の根拠と実測

Phase 8（完了報告）の規則は本体にある。ここには、その根拠と実測を移した（#3481）。

## 8-3 重複を起票した実例

2026-09-30 に 2 回、この確認をせずに重複を起票した: #3024（日次確認が 36 分前に #3021 / #3022 を起票済み）と
#3031（同じ朝に別のセッションかワーカーが #3026 を起票済み）。

## 8-3 起票の前の確認と bug の分類節

**起票の前に、同じ不具合の開いている Issue を探す**（UAT の指摘・ワーカーの報告・8-3 の改善案のどれでも）。
日次確認（`agent-health`）は、毎朝 07:00 の Schedule が `<!-- agent-health:<tool>:<checkId> -->` を本文に入れた Issue を自動で起票する。
並行する別のセッションやワーカーが、先に起票していることもある。

```bash
gh issue list --repo Kewton/CommandMate --state open --label agent-health --json number,title,createdAt
gh issue list --repo Kewton/CommandMate --state open --search "<ファイル名か関数名> in:body" --json number,title,createdAt
```

見つかったら新しく起票せず、その Issue に追加の事実をコメントする。自動起票の Issue は残す
（翌朝の Schedule は `agent-health:<tool>:<checkId>` を本文に持つ開いた Issue を探してコメントするので、手で起票した別の Issue では重複を防げない）。

根拠: docs/orchestrate/report.md#8-3-重複を起票した実例

## 8-2 サマリーの実行フェーズ・品質チェック・成果物の節

summary.md に書く節（`### 実行フェーズ結果` から `### 成果物` まで）の雛形:

```markdown
### 実行フェーズ結果

| Phase | 内容 | ステータス |
|-------|------|-----------|
| 1 | 依存関係分析 | 完了 |
| 2 | Worktree準備 | 完了 |
| 3 | 並列開発 | 完了 |
| 4 | 設計突合 | 完了（問題なし） |
| 5 | 品質確認 | 完了（全Pass） |
| 6 | PR・マージ | 完了（PR #XX, #YY） |
| 7 | UAT | 完了（全PASS） |

### 品質チェック

| チェック項目 | 結果 |
|-------------|------|
| npm run lint | Pass |
| npx tsc --noEmit | Pass |
| npm run test:unit | Pass |
| npm run build | Pass |

### 成果物

- 設計書: dev-reports/design/issue-{N}-*-design-policy.md
- 作業計画: dev-reports/issue/{N}/work-plan.md
- 進捗報告: dev-reports/issue/{N}/pm-auto-dev/iteration-1/progress-report.md
- UATレポート: dev-reports/issue/{N}/uat/acceptance-test-report.html
- 統合サマリー: workspace/orchestration/runs/{DATE}/summary.md
```
