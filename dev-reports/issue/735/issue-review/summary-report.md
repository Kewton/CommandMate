# Issue #735 マルチステージレビュー完了報告

**Issue**: test(e2e): add Playwright e2e for PaneResizer 5-instance parallel + cross-worktree persistence (#728 R3-008)
**実施日**: 2026-05-31
**実施範囲**: Stage 1-4（1回目イテレーション）。Stage 5-8（Codexクロスレビュー）はユーザー設定によりスキップ。

---

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| H1 | playwright.config.ts 存在・e2e基盤整備済み | Confirmed |
| H2 | tests/e2e/ に既存spec（8件）あり | Confirmed |
| H3 | `npm run test:e2e` = `playwright test` | Confirmed |
| H4 | e2e が CI で実行される | **Rejected**（CI未統合） |
| H5 | `activity-bar-files` 存在 | **Rejected**（→ `activity-bar-button-files`） |
| H6 | `history-pane-expand` 存在 | **Rejected**（testid無し・要追加） |
| H7 | `terminal-split-add` 存在 | **Rejected**（→ `add-terminal-split`） |
| H8 | `pane-resizer-*` 存在 | **Rejected**（→ `split-resizer-{idx}`） |
| H9 | `terminal-split-pane-*` 存在 | Confirmed |
| H10 | PaneResizer は drag後 cursor リセット | Confirmed |
| H11 | 「5並列インスタンス」 | Partially Confirmed（基本4、FilePanel併用で5） |
| H12 | localStorage が worktree スコープ分離 | Confirmed |
| H13 | useTerminalSplits が worktreeId変更で再読込・永続化 | Confirmed |
| H14 | worktree詳細ルート `/worktrees/[id]` | Confirmed |

---

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 14検証（6 Rejected/1 Partial） | - | 完了 |
| 1 | 通常レビュー（1回目） | 7（Must2 / Should3 / Nice2） | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 7 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 7（Must2 / Should3 / Nice2） | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | 7 | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | **スキップ**（ユーザー設定） |

**1回目 Must Fix 合計**: 4件（すべて反映済み）

---

## 主要な改善点（Issue本文に反映済み）

1. **example spec は擬似コード**であることを明記し、**実 testid 対応表**を追加
   - `activity-bar-files`→`activity-bar-button-files`、`terminal-split-add`→`add-terminal-split`、`pane-resizer-*`→`split-resizer-{idx}`、`history-pane-expand`→**新規追加が必要**（TerminalContainer.tsx:56 の `<button>`）
2. **CI統合方針**を明文化（e2eは現状CI未統合。tmux/CLIセッション依存のため、データ非依存部分に絞る／API-routeモック／非ブロッキングjob）
3. **テストフィクスチャ戦略**: `page.route` によるAPI-routeモックを推奨（共有DB/git/セッション依存を切り離す）
4. **テスト隔離要件**: ユニークworktreeId、`beforeEach`/`afterEach` で `commandmate:terminalSplits:*` クリア（`fullyParallel: true` 対策）
5. **「5インスタンス」修正**: 基本4 resizer、FilePanel併用で5。アサーションは ≥4 または明示構成
6. **Mobile Safari対策**: in-spec self-skip（`test.skip(project.name !== 'chromium')`）、config変更しない
7. **Scenario 1の設計欠陥指摘**: `HistoryExpandBar` は History 折りたたみ時のみ描画／`visible` 既定 true。正しいシーケンス（初期visible → expand-click不要 or collapse→expand）に修正
8. **cursorアサーション**: `not.toBe('col-resize')`（実装は `cursor=''` にリセット）

---

## 次のアクション

- [x] Issue本文の更新完了
- [ ] /work-plan で作業計画立案（Phase 4）
- [ ] /pm-auto-dev で実装（Phase 5）

> 設計方針書（Phase 2）・設計レビュー（Phase 3）はユーザー設定によりスキップし、直接作業計画フェーズへ進む。
