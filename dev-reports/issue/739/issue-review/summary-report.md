# Issue #739 マルチステージレビュー完了報告

対象: `fix(terminal): removeSplit fails to re-normalize widths, leaving 50% empty space (#728 follow-up)`

実施日: 2026-05-31

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | `removeSplit` は末尾切り捨てのみで再正規化しない（`[0.5,0.5]`→`[0.5]`） | **Confirmed** |
| 2 | CSS flex-grow 合計<1 で free space が余り空きスペース化 | **Confirmed** |
| 3 | `widthsValid`/`isValidSplitConfig` は合計=1.0 を検証しない | **Confirmed** |
| 4 | `addSplit` は合計保存（変更不要） | **Confirmed** |

全仮説が Confirmed。Issue の原因分析・対応方針はコードベースと完全整合。Rejected なし。

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（1回目） | MF:0 / SF:0 / NtH:2 | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 2 (NtH) | 完了 |
| 3 | 影響範囲レビュー（1回目） | MF:0 / SF:0 / NtH:1 | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | 1 (NtH) | 完了 |
| 5-8 | 2回目イテレーション | - | - | **自動スキップ**（iteration1 Must Fix=0） |

## 反映した改善（Nice to Have, 全3件）

- **S1-001**: `normalizeWidths` / `removeSplit` のフォールバックを「長さ保存（等分）」方式へ。`widths.length === splits.length` 不変条件を防御。
- **S1-002**: ロード時の統合ポイントを `readInitialState` のバリデーション通過直後に固定。`parsed` を mutate せず正規化コピーを返す旨を明記。
- **S3-001**: 想定影響範囲に「非影響ファイル」節を追加（Container / config / setSplitWidth / e2e / モバイルの非影響を確認済みとして明記）。

## 影響範囲確認の要点

- 既存テスト（`useTerminalSplits.test.ts`）は exact width を assert せず、`removeSplit` 再正規化で破壊されない。
- `normalizeWidths` は sum=1.0 の有効 config に対し no-op（`restores a valid stored config` の `[0.6,0.4]` も不変）。
- `useTerminalSplits` は PC専用（src/ 唯一の consumer は `TerminalSplitContainer`）。モバイル非影響。

## 次のアクション

- [x] Issueの最終確認（本文更新済み）
- [ ] /design-policy で設計方針策定（Phase 2）
- [ ] /multi-stage-design-review（Phase 3）
- [ ] /work-plan（Phase 4）
- [ ] /pm-auto-dev で実装（Phase 5）
