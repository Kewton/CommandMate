# Issue #690 マルチステージレビュー完了報告

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | `visible` カラムをDBに追加（マイグレーション `v3x` → 実際は `v31`） | Partially Confirmed |
| 2 | `enabled` フラグパターンを参考実装として利用 | Partially Confirmed |
| 3 | Sidebar.tsx でフロント側フィルタリング（追加データが必要） | Partially Confirmed |
| 4 | Issue #644 のUIパターン再利用 | Confirmed |
| 5 | `RepositoryManager.tsx` が存在する | Confirmed |
| 6 | PUT `/api/repositories/{id}` に `visible` 追加 | Confirmed |

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 1 | 通常レビュー（1回目） | 10件（Must:3/Should:4/Nice:3） | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 7件（Must3+Should4） | 完了 |
| 3 | 影響範囲レビュー（1回目） | 10件（Must:3/Should:5/Nice:2） | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | 8件（Must3+Should5） | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | スキップ（ユーザーフィードバックによりSkip） |

## 主要な改善点

### Must Fix（計6件すべて対応済み）
1. マイグレーションファイル名 `v3x` → `v31-repository-visible.ts` に修正
2. Sidebarフィルタリングのデータパス（案A: `getRepositories()` → `RepositorySummary.visible` → Sidebar）を明記
3. `enabled`（sync除外）と `visible`（表示制御）の概念分離を明記
4. `useWorktreesCache` / `WorktreesCacheProvider` / `WorktreeSelectionContext` の伝播経路修正タスクを追加
5. `RepositorySummary` 型に `visible: boolean` 追加タスクを追記
6. `runner.ts` の `CURRENT_SCHEMA_VERSION` 30→31 更新タスクを追記

## 次のアクション

- [x] Issueレビュー完了（Issue本文更新済み）
- [ ] /work-plan で作業計画立案（Phase 4）
- [ ] /pm-auto-dev でTDD実装（Phase 5）
