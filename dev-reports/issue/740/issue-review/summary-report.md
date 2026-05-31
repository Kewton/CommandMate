# Issue #740 マルチステージレビュー完了報告

対象: `fix(terminal): missing AutoYesToggle in PC per-split footer breaks per-Agent Auto-Yes selection (#728 follow-up)`

実施日: 2026-05-31 / ブランチ: `feature/740-worktree`

> **注**: 保存済みフィードバック（feedback_skip_codex_review）に従い、Stage 5-8（Codex クロスレビュー）はスキップ。Stage 1-4 を統合実施。

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | PC版 per-split footer に AutoYesToggle が無い | **Confirmed** |
| 2 | TerminalSplitPaneContent footer に AutoYesToggle が無い | **Confirmed** |
| 3 | Mobile版にのみ AutoYesToggle が存在 | **Confirmed** |
| 4 | useAutoYes が activeCliTab 単一キー管理 / 3独立状態が無い | **Partially Confirmed（不正確）** — 状態は既に per-CLI Map |
| 5 | 案A の `useAutoYes({worktreeId,cliToolId})` が enabled/expiresAt/toggle を返す | **Rejected** — 戻り値は `{lastAutoResponse}` のみ |

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | 5仮説 | - | 完了 |
| 1+3 | 通常+影響範囲（opus, 統合） | 10（Must3/Should5/Nice2） | - | 完了 |
| 2+4 | 指摘事項反映 | - | 10/10 | 完了 |
| 5-8 | 2回目（Codex） | - | - | **スキップ（feedback）** |

## 主要な修正内容

1. **対応方針を全面修正（S1-001 Must Fix）**: 案A の `useAutoYes({worktreeId,cliToolId})` は実API不一致で実装不能 → 「親が `autoYesStateMap`(per-CLI Map) を真実源として保持し、各 split に enabled/expiresAt/lastAutoResponse/onToggle を props 配布」へ変更。
2. **`handleAutoYesToggle` の cliToolId パラメータ化を明記（S1-002 Must Fix）**: 現状 activeCliTab ハードコードのため per-split トグル不可。
3. **影響範囲表を補強（S1-003 Must Fix）**: renderSplitPane の追加配布、TerminalSplitPaneContent の props 追加、AutoYesToggle 描画を明記。
4. **根本原因 §4 の不正確記述を訂正（S1-004）**: 「3独立状態が無い」→「enabled は既に per-CLI Map で配布済み、欠落は3点」。
5. **スコープ外を明確化（S1-005, S1-006）**: 非アクティブ split のサーバー同期ギャップ、client-side auto-response の per-split 化不要（#501 サーバー poller 委譲）。
6. **受入条件の再構成（S1-008, S1-010）**: 実現不能な「A=Claude,B=Claude 同期」を削除（同一CLI 2split は UI で禁止）。テスト方針追加、Mobile/split0 後方互換を明記。

## 次のアクション

- [x] Issueの最終確認（GitHub 反映済み）
- [ ] /work-plan で作業計画立案（Phase 4）
- [ ] /pm-auto-dev で TDD実装（Phase 5）

> 設計方針書（Phase 2）・設計レビュー（Phase 3）は保存済みフィードバックによりスキップ。
