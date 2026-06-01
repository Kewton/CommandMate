# Issue #730 マルチステージレビュー完了報告

**完了日**: 2026-05-31
**Issue**: #730 fix(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#727 follow-up)

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| H1 | `ActivityBar.tsx:103` で `title={activity.label}` 設定 | ✅ Confirmed |
| H2 | `WorktreeDetailRefactored.tsx:1727-1749` のJSX構造 | ✅ Confirmed |
| H3 | ActivityBar 6アイコン定義 | ✅ Confirmed |
| H4 | ActivityBar は WorktreeDesktopLayout 内部 | ✅ Confirmed |
| H5 | History は独立した第3カラム | ✅ Confirmed |
| H6 | localStorage キー `commandmate:historyVisible/Width` | ❌ Rejected (正: `commandmate.worktree.historyVisible/Width`) |
| H7 | ブラウザネイティブ tooltip 約500ms 遅延 | ✅ Confirmed |
| H8 | Agent / Timer がスクロール領域に押し出される | ⚠️ Partially Confirmed (条件依存) |
| H9 | `useHistoryPaneState` 状態管理 (API は `visible`/`width`/`toggle`/`setWidth`) | ✅ Confirmed (API 名差異あり) |
| H10 | `Tooltip.tsx` / `TerminalContainer.tsx` は未実装 | ✅ Confirmed |

## ステージ別結果

| Stage | レビュー種別 | Must/Should/Nice | 対応数 | ステータス |
|-------|------------|------------------|-------|----------|
| 1 | 通常レビュー（1回目） | 1 / 5 / 4 | - | ✅ 完了 |
| 2 | 指摘事項反映（1回目） | - | 10/10 | ✅ 完了 |
| 3 | 影響範囲レビュー（1回目） | 1 / 5 / 3 | - | ✅ 完了 |
| 4 | 指摘事項反映（1回目） | - | 9/9 | ✅ 完了 |
| 5-8 | 2回目イテレーション (Codex) | - | - | ⏭️ ユーザー設定によりスキップ |

## 主要な反映内容

### Stage 1 → Stage 2 (通常レビュー反映)
- S1-001 (Must): localStorage キーをドット区切り (`commandmate.worktree.historyVisible/Width`) に修正
- S1-002: `useHistoryPaneState` API 名を `{ visible, width, toggle, setWidth }` に修正
- S1-003: 「変更後」JSX に Header/BranchMismatchAlert/NavigationButtons/PromptPanel の配置明示
- S1-004: Tooltip 化時の aria 仕様明示
- S1-005: 更新対象テストの具体化
- S1-006〜S1-010: モバイル経路非対象明示、Tooltip 遅延統一、z-index 整合性、id 移管、Issue #728 整合

### Stage 3 → Stage 4 (影響範囲反映)
- S3-001 (Must): 更新対象テストを 5 ファイル+新規2ファイルに具体化
- S3-002: Tooltip の ref/イベント透過設計 (forwardRef 維持)
- S3-003: `HISTORY_PANE_ID` を TerminalContainer 内 history wrapper div に移管
- S3-004: `DEFAULT_HISTORY_WIDTH` 25 → 約 40 に調整方針
- S3-005: MobileLayout fallback を dead code として削除確定
- S3-006: TerminalContainer 内に ErrorBoundary 包含
- S3-007: ドキュメント更新範囲を具体化
- S3-008: deep link `?pane=history` 視覚位置変化注記
- S3-009: Tooltip setTimeout cleanup を unmount 時に実装

## 次のアクション

- [x] Issue本文の最終確認
- [ ] Phase 4: 作業計画立案 (`/work-plan 730`)
- [ ] Phase 5: TDD自動開発 (`/pm-auto-dev 730`)
- [ ] Phase 6: 完了報告

## 出力ファイル

- 仮説検証: `dev-reports/issue/730/issue-review/hypothesis-verification.md`
- Stage 1 結果: `dev-reports/issue/730/issue-review/stage1-review-result.json`
- Stage 2 結果: `dev-reports/issue/730/issue-review/stage2-apply-result.json`
- Stage 3 結果: `dev-reports/issue/730/issue-review/stage3-review-result.json`
- Stage 4 結果: `dev-reports/issue/730/issue-review/stage4-apply-result.json`
- 元Issueバックアップ: `dev-reports/issue/730/issue-review/original-issue.json`
