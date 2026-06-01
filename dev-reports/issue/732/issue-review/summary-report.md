# Issue #732 マルチステージレビュー完了報告

## 対象
fix(layout): missing min-w-0 causes horizontal overflow, hiding FilePanel off-screen (#730 follow-up)

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | 外側コンテナ `flex flex-col flex-1 min-h-0` (line 1740) に `min-w-0` 欠落 | **Confirmed** |
| 2 | 中間 `flex-1 min-h-0` (line 1763) に `min-w-0` 欠落 | **Confirmed** |
| 3 | 該当箇所は1700行付近 | **Partially Confirmed**（実際は1740/1763） |
| 4 | 親 `overflow-hidden relative` (line 1738) でクリッピング | **Confirmed** |
| 5 | `right-pane-slot` は既に `min-w-0`（溢れ起点は上位） | **Confirmed** |
| 6 | Flexbox `min-width:auto` で content 最小幅以下に縮まない | **Confirmed** |
| 7 | `data-testid="desktop-layout"` の幅アサーションが受入条件 | **Confirmed** |

→ すべて Confirmed。Issue の原因分析・対応方針は実コードと整合。

## ステージ別結果

| Stage | レビュー種別 | レビュアー | Must Fix | Should Fix | Nice to Have | 対応 | ステータス |
|-------|------------|----------|:--------:|:----------:|:------------:|:----:|----------|
| 1 | 通常レビュー（1回目） | claude-opus | 0 | 1 | 2 | 3/3 | 完了 |
| 2 | 指摘事項反映（1回目） | sonnet | - | - | - | 3 | 完了 |
| 3 | 影響範囲レビュー（1回目） | claude-opus | 0 | 0 | 3 | 2/3 | 完了 |
| 4 | 指摘事項反映（1回目） | sonnet | - | - | - | 2 | 完了 |
| 5-8 | 2回目イテレーション | - | - | - | - | - | **自動スキップ**（1回目 Must Fix 合計0件） |

## 主な改善点（Issue本文へ反映済み）

1. **受入条件を2層に分離**（S1-001）: unit テスト検証可能（className に `min-w-0` を含む）/ e2e (Playwright) 検証可能（`getBoundingClientRect().right <= window.innerWidth`、desktop-layout 幅）。jsdom は幅を 0 で返すため後者は e2e のみ。
2. **主因と防御的補強の区別**（S1-002）: line 1740 が主因（flex-row の main 軸 flex item）、line 1763 は防御的補強（flex-col の cross 軸）。両方付与は無害。
3. **行番号精緻化＋モバイル注意**（S1-003）: 1700行付近 → 1740/1763。モバイル経路の `flex-1 min-h-0`（line ~1590）は編集対象外。
4. **既存テスト非破壊の明示**（S3-001/002）: `WorktreeDetailRefactored.test.tsx` は `WorktreeDesktopLayout`/`TerminalContainer` をモックしており、className アサーションなし。`TerminalContainer` の unit テストは存在しない。

## 次のアクション

- [x] Issueの最終確認
- [ ] /design-policy で設計方針策定
- [ ] /pm-auto-dev で実装を開始
