# Issue #727 マルチステージレビュー完了報告

**対象Issue**: #727 feat(layout): replace LeftPaneTabSwitcher with VS Code-style Activity Bar + relocate History pane (PC)
**実施日**: 2026-05-30
**実施範囲**: Phase 0.5 仮説検証 + Stage 1-4（1st iteration のみ）
**Stage 5-8 (2nd iteration / Codex)**: ユーザー設定によりスキップ

---

## 仮説検証結果（Phase 0.5）

| # | 主張 | 判定 |
|---|------|------|
| H1 | LeftPaneTabSwitcher が History/Files/CMATE の3タブ式 | Partially Confirmed（内部ID `memo`） |
| H2 | NotesAndLogsPane は 4 サブタブ二層構造 | Confirmed |
| H3 | GitPane を Git Activity として流用可能 | Partially Confirmed（現状は History 内サブタブ） |
| H4-H8 | MemoPane/ExecutionLogPane/AgentSettingsPane/TimerPane/PaneResizer 流用 | Confirmed |
| H9 | LeftPaneTabSwitcher.tsx 削除可 | Confirmed |
| **H10** | **NotesAndLogsPane.tsx 削除可** | **Rejected**（モバイル経路で使用中） |
| **H11** | **モバイル現状維持で済む** | **Rejected**（H10と矛盾） |
| H12 | 既存テストは限定的な変更で済む | Partially Confirmed（実際は 11 ファイル） |
| H13-H15 | LayoutState 拡張・localStorage キー・leftPaneCollapsed パターン | Confirmed（要設計） |
| **H16** | **jest-axe で aria 検証** | **Rejected**（jest-axe 未導入） |

**主要矛盾**: H10/H11 のモバイル経路矛盾、H3 の History 内 Git サブタブ未記載、H16 の jest-axe 未導入。

---

## ステージ別結果

| Stage | 種別 | 指摘数 | 対応数 | Must Fix | Should Fix | Nice to Have | ステータス |
|-------|------|-------|-------|----------|-----------|--------------|----------|
| 1 | 通常レビュー（1回目） | 13 | — | 5 | 5 | 3 | 完了 |
| 2 | 指摘反映（1回目） | — | 13/13 | — | — | — | 完了（Issue: 234→325行） |
| 3 | 影響範囲レビュー（1回目） | 12 | — | 4 | 5 | 3 | 完了 |
| 4 | 指摘反映（1回目） | — | 12/12 | — | — | — | 完了（Issue: 325→404行） |
| 5-8 | 2回目イテレーション（Codex） | — | — | — | — | — | スキップ（ユーザー設定） |

**合計**: 25件指摘 / 25件反映 (100%)

---

## 主要な改善点

### Must Fix 対応（致命的整合性）
1. `NotesAndLogsPane.tsx` の取扱を「削除」→「PC 経路から参照除去のみ（モバイル維持）」に修正 → build破壊回避
2. History 内 Message/Git サブタブの廃止方針追加（PC のみ）
3. Deep-link 互換性セクション新設（`useWorktreeTabState` / `deep-link-validator` / `VALID_PANES` の改修方針）
4. `useFilePolling` ゲーティングを `leftPaneTab === 'files'` → `activeActivity === 'files'` に移行する手順明示
5. `useReducer` action 追加方針（SET_ACTIVE_ACTIVITY / TOGGLE_ACTIVITY 等）
6. テスト更新リストを 4 → 11 + 4 新規 + 4 E2E 確認 + 1 影響確認 = 20 件に拡張
7. `jest-axe` 不使用、Testing Library role/aria assertion で代替

### Should Fix 対応（実装方針具体化）
- localStorage 命名規約統一（`commandmate.worktree.*`）
- `LayoutState.leftPaneTab` / `leftPaneCollapsed` のマイグレーション戦略明示
- `leftPaneMemo` (38 deps) を `activityPaneMemo` / `historyPaneMemo` に分割する方針
- `activeActivity === null` 時の hydration / ポーリング挙動明示
- `docs/UI_UX_GUIDE.md` (ja/en) の 4 カラム化反映
- Issue #728 とのマージ順序ガイド追加

### Nice to Have 対応
- lucide-react 正式 export 名で例コード修正
- DOM ID 設計表追加（`worktree-activity-bar` 等）
- 「CMATE」内部 ID が `memo` である歴史的経緯補足
- ArrowUp/ArrowDown + `aria-orientation="vertical"` キーボードナビ仕様

---

## 次のアクション（pm-auto-issue2dev 続行）

ユーザー設定により Phase 2（設計方針書）・Phase 3（設計レビュー）はスキップし、Phase 4 へ直行する：

- [x] Phase 1: マルチステージIssueレビュー（本ファイル）
- [ ] Phase 4: `/work-plan 727` で作業計画立案
- [ ] Phase 5: `/pm-auto-dev 727` で TDD 実装
- [ ] Phase 6: 完了報告
