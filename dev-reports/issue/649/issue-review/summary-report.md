# Issue #649 マルチステージレビュー完了報告

## 仮説検証結果（Phase 0.5）

| # | 前提条件 | 判定 |
|---|---------|------|
| 1 | 現在の CLI セッションはすべて worktree 単位で紐づいている | Confirmed |
| 2 | repositoryApi.list() が Issue #644 で追加済み | Confirmed |
| 3 | MessageInput コンポーネントが流用候補として存在 | Confirmed（worktreeId必須のため拡張方針が必要） |
| 4 | HomeSessionSummary が既存 Home コンポーネントとして存在 | Confirmed |
| 5 | CLIToolManager が CLI ツール管理として存在 | Confirmed |
| 6 | src/app/page.tsx がHome画面のエントリポイント | Confirmed |
| 7 | Gemini が CLI ツールとしてサポート | Confirmed（全6種類サポート済み） |

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応状況 |
|-------|------------|-------|---------|
| 0.5 | 仮説検証 | - | 全7件 Confirmed（Rejected なし） |
| 1 | 通常レビュー（1回目） | Must Fix 4, Should Fix 7, Nice to Have 3 | 完了 |
| 2 | 指摘事項反映（1回目） | - | 全14件反映済み |
| 3 | 影響範囲レビュー（1回目） | Must Fix 3, Should Fix 7, Nice to Have 2 | 完了 |
| 4 | 指摘事項反映（2回目） | - | 全12件反映済み |
| 5-8 | 2回目イテレーション | - | スキップ（フィードバックによりCodex委任スキップ） |

## 主要な改善点（Issue #649 への反映内容）

### アーキテクチャ設計の明確化
1. **CLIツール選択範囲の拡張**: 3種→インストール済み全6種（`CLIToolManager.getInstalledTools()`）
2. **グローバルセッション専用コンポーネント**: `AssistantMessageInput` を新規作成（MessageInputの直接流用を廃止）
3. **ポーリング設計の変更**: 仮想worktreeID方式廃止→グローバルセッション専用 `pollGlobalSession()` 新規実装
4. **DB操作なし方針の確定**: Phase 1 はDB操作を行わない（FOREIGN KEY制約問題を回避）

### セッション管理の整備
5. **tmuxセッション命名規則**: `mcbd-global-home`→`mcbd-{cli_tool_id}-__global__`（既存 `getSessionName()` 再利用）
6. **セッションライフサイクル管理**: 停止UI、`cleanupGlobalSessions()` 実装タスク追加
7. **サイドバー除外フィルタ**: グローバルセッションをworktreeサイドバーから除外

### 受入条件・スコープの整備
8. **ターミナル出力表示の受入条件追加**
9. **Phase 1スコープ外機能の明確化**: Auto-Yes、スケジューラー、CLI連携等を明示
10. **セッション停止API追加**: `DELETE /api/assistant/session`

## 次のアクション

- [x] Issue #649 本文更新済み（Stage 1-4 反映済み）
- [ ] Phase 4: 作業計画立案（`/work-plan 649`）
- [ ] Phase 5: TDD自動開発（`/pm-auto-dev 649`）
- [ ] PR作成（`/create-pr`）

## 成果物ファイル

| ファイル | 内容 |
|---------|------|
| `original-issue.json` | 元のIssue内容 |
| `hypothesis-verification.md` | 仮説検証レポート |
| `stage1-review-result.json` | 通常レビュー結果 |
| `stage2-apply-result.json` | Stage 1指摘反映結果 |
| `stage3-review-result.json` | 影響範囲レビュー結果 |
| `stage4-apply-result.json` | Stage 3指摘反映結果 |
