# Issue #728 マルチステージレビュー完了報告

- **対象 Issue**: #728 feat(terminal): add 1-3 horizontal terminal split with per-split CLI selection and MessageInput (PC)
- **ブランチ**: `feature/728-worktree` @ `73263e39` (Issue #730 マージ後の起点)
- **レビュー範囲**: Stage 0.5 仮説検証 + Stage 1-4（1回目イテレーション）
- **Stage 5-8 スキップ理由**: ユーザー標準フィードバック `feedback_skip_codex_review.md` により Codex 委任ステージは省略

## 仮説検証結果（Phase 0.5）

機能追加 Issue のため明示的な仮説は少ないが、本文中の「既存コード前提」を 8 項目検証。

| # | 主張 | 判定 |
|---|------|------|
| 1 | MessageInput draft key = `commandmate:messageDraft:{worktreeId}` | **Rejected**（実際は `commandmate:draft-message:`）|
| 2 | `mcbd-claude-{worktreeId}` を `splitIndex=0` で維持 | Confirmed |
| 3 | `FilePanelSplit` が現状のターミナル+ファイル分割パターン | Confirmed |
| 4 | Issue #730 後の構造（ActivityBar / WorktreeDesktopLayout / TerminalContainer / FilePanelSplit）| Confirmed |
| 5 | CLI 6種（claude/codex/gemini/copilot/opencode/vibe-local） | Confirmed |
| 6 | NavigationButtons / special-keys / Auto-Yes 再利用可能 | Confirmed（要注意点あり） |
| 7 | PaneResizer 流用可能 | Confirmed |
| 8 | LayoutState に terminalSplits 追加可能 | Confirmed（ただし Stage 3 判断で「追加しない」決定） |

詳細: `dev-reports/issue/728/issue-review/hypothesis-verification.md`

## ステージ別結果

| Stage | レビュー種別 | レビュアー | Must Fix | Should Fix | Nice to Have | ステータス |
|-------|------------|----------|---------:|-----------:|-------------:|----------|
| 0.5 | 仮説検証 | Explore agent | - | - | - | 完了 |
| 1 | 通常レビュー（1回目） | claude-opus | 3 | 5 | 2 | 完了 |
| 2 | 指摘事項反映（1回目通常） | sonnet | - | - | - | 完了（10/10 適用、本文 8954→19557 字） |
| 3 | 影響範囲レビュー（1回目） | claude-opus | 3 | 6 | 3 | 完了 |
| 4 | 指摘事項反映（1回目影響範囲） | sonnet | - | - | - | 完了（12/12 適用、本文 19557→31068 字） |
| 5-8 | 2回目イテレーション | Codex | - | - | - | スキップ（ユーザー方針） |

## 主要な意思決定（Issue 本文に反映済）

1. **MessageInput draft key**: `commandmate:draft-message:${worktreeId}:${splitIndex}` に統一。
2. **同一 (worktreeId, cliToolId) を複数スプリットで開く**: **禁止**。CLI セレクターで選択不可化。Auto-Yes/poller/tmux のキー設計は現状 `(worktreeId, cliToolId)` 複合キーのまま維持。
3. **localStorage キー**: `commandmate:terminalSplits:${worktreeId}`（worktree-scope）。stale state（splits.length 範囲外、widths 長不一致）はデフォルト fallback。
4. **MessageInput / NavigationButtons / PromptPanel の所属移管**: 現在 `WorktreeDetailRefactored.tsx` 直下 → `TerminalSplitPane` 内に移動。
5. **state.terminal の per-split 化**: `state.terminal.output / activeCliTab / fetchCurrentOutput` を per-split (Map keyed by splitIndex) に置換。
6. **置換対象の明確化**: `FilePanelSplit` 自体は維持。`terminal` prop に渡される領域を `TerminalSplitContainer` に置換。`terminalHeader` は null 化、CLI セレクター/検索ボタンは各スプリットヘッダーへ移管。
7. **HistoryPane / MemoPane 挿入先**: `focusedSplitIndex`（最後に focus した split）へ届ける。
8. **HistoryPane 階層維持**: TerminalSplitContainer は HistoryPane を内包しない。`HISTORY_PANE_ID` の一意性維持。
9. **状態フック分離**: `useTerminalSplits` 独立フックとし、`LayoutState` には追加しない。
10. **モバイル境界**: `WorktreeDetailRefactored.tsx` の `if (!isMobile)` ブランチ内のみ適用。MobileContent は単一 Terminal を維持。
11. **アクセシビリティ**: TerminalSplitContainer = `role="group"`、各 Pane = `role="region"` + aria-label。
12. **テスト方針**: Vitest 単体（hook/state/migration）+ Playwright e2e（UI遷移）。既存テスト影響リスト明示。
13. **CHANGELOG / CLAUDE.md**: Issue #727/#730 フォーマットに従う。

## 残課題 / 次フェーズへの申し送り

- Phase 4（作業計画）で、Issue 本文 31068 字の実装方針 + 12 + 12 件の決定事項をタスク分解する必要がある。
- 同一 CLI 複数スプリット禁止により CLI セレクターの disabled 状態管理が必要（既に他スプリットで選択済みの CLI を grey-out）。
- `state.terminal` の Map 化は既存 useReducer の比較的大きな改修になる可能性あり。Phase 4 で工数見積を要する。

## 次のアクション

- [x] Issue レビュー完了
- [ ] Phase 4: `/work-plan 728` 作業計画立案
- [ ] Phase 5: `/pm-auto-dev 728` TDD 自動開発
- [ ] Phase 6: 最終検証 + 完了報告
