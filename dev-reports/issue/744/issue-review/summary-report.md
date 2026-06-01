# Issue #744 マルチステージレビュー完了報告

**Issue**: feat(terminal): move HistoryPane into each split with per-cliToolId message filtering (#728 follow-up)
**種別**: 機能追加（PC専用UI、#728/#736/#740/#743 follow-up シリーズ）

## 仮説検証結果（Phase 0.5）

Issue内の「現状アーキテクチャに関する事実主張」をコードベースと照合（9件）。

| # | 主張 | 判定 |
|---|------|------|
| 1 | WorktreeDetailRefactored が historyPaneMemo を TerminalContainer に渡す | Confirmed |
| 2 | TerminalContainer が history prop を受け useHistoryPaneState で管理 | Confirmed |
| 3 | HistoryPane は messages を受け useConversationHistory で表示（cliToolId prop 未実装） | Confirmed |
| 4 | TerminalSplitPaneContent が per-(worktreeId,cliToolId) polling、HistoryPane 未描画 | Confirmed |
| 5 | chat-db.getMessages が cliToolId フィルタ対応 | Confirmed |
| 6 | ChatMessage 型に cliToolId フィールドあり | Confirmed |
| **7** | **「state.messages は全CLI保持、UI側フィルタで十分、バックエンド変更不要」** | **❌ Rejected（重大）** |
| 8 | TerminalSplitPane が headerExtras/terminal/footer slot 公開 | Confirmed |
| 9 | useHistoryPaneState は全split共通の単一グローバル | Confirmed |

**最重要**: 主張#7 は誤り。`fetchMessages` (WorktreeDetailRefactored.tsx:472-497) は `?cliTool=<activeCliTab>` で既にサーバ側フィルタ済みのため `state.messages` は activeCliTab 1種類のみ保持。→ 受入条件「A=Claude/B=Codex 同時表示」は state.messages フィルタでは実現不能。各 split が自分の cliToolId で独立 fetch する設計（#728/#736 の per-split polling と同型）に修正が必要。

## ステージ別結果

| Stage | レビュー種別 | レビュアー | Must | Should | Nice | ステータス |
|-------|------------|----------|------|--------|------|----------|
| 0.5 | 仮説検証 | claude | 1 Rejected | - | - | 完了 |
| 1 | 通常レビュー（1回目） | claude-opus | 2 | 4 | 2 | 完了 |
| 2 | 指摘事項反映（1回目） | sonnet | - | 8件反映 | - | 完了 |
| 3 | 影響範囲レビュー（1回目） | claude-opus | 1 | 4 | 2 | 完了 |
| 4 | 指摘事項反映（1回目） | sonnet | - | 7件反映 | - | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | - | - | **スキップ**（ユーザー方針: Codex委任スキップ） |

## 主要な反映内容

### Must Fix（設計の根幹修正）
- **S1-001 / S1-002**: `state.messages` の activeCliTab フィルタ済み問題。設計を「各 split が `useSplitMessages({worktreeId, cliToolId})` で独立 fetch（`/api/worktrees/[id]/messages?cliTool=<paneCli>`、API/DB は既存対応）」に全面修正。受入条件との整合を回復。
- **S3-001**: 検索ハイライト名前空間（`HISTORY_SEARCH_NAMESPACE`、`applyHistoryHighlights`/`clearHistoryHighlights`、fallback overlay の `getElementById`）が全split共有のため、複数 HistoryPane 同時 mount で互いのハイライトを消し合う correctness バグ。`makeHistoryNamespace(splitIndex)` で per-instance 化（additive、mobile は単一 namespace 維持）。

### Should Fix（反映済み）
- per-split fetch と親 pollData の N+1 fetch 重複 → useTerminalPanePolling 同等の cadence/visibility/stale-guard 要求
- 影響テストファイルの正確な列挙（TerminalContainer/WorktreeDetailRefactored/cli-tab-switching/WorktreeDesktopLayout + 新規 useSplitMessages/terminal-highlight/HistoryPane/TerminalSplitPaneContent）
- split 内 history 幅は useTerminalSplits の split 幅とは別の意味で扱う（グローバル width 流用回避）
- 挿入ルーティングは splitIndex 直指定（focusedSplitIndex 間接参照回避）
- mobile は構造非影響だが HistoryPane body 共有 → 全変更は additive 必須、HISTORY_PANE_ID 重複回避

## 次のアクション

- [x] Issueの最終確認（本文更新済み）
- [ ] /work-plan で作業計画立案（Phase 2 設計方針・Phase 3 設計レビューはユーザー方針によりスキップ）
- [ ] /pm-auto-dev で TDD 実装
