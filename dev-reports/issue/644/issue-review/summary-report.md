# Issue #644 マルチステージレビュー完了報告

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | `/repositories` 画面は `RepositoryManager` のみを描画している | Confirmed |
| 2 | `RepositoryManager` は登録フォームとSyncボタンしか持たない | Confirmed |
| 3 | `src/app/api/repositories/route.ts` は `DELETE` のみ（GET なし） | Confirmed |
| 4 | `repositoryApi` に list 取得メソッドが存在しない | Confirmed |
| 5 | `getAllRepositories(db)` が `src/lib/db/db-repository.ts:290` に存在する | Confirmed |
| 6 | `PUT /api/repositories/[id]` が Issue #642 で追加済み | Confirmed |

## ステージ別結果

| Stage | レビュー種別 | Must Fix | Should Fix | Nice to Have | ステータス |
|-------|------------|---------|-----------|-------------|----------|
| 1 | 通常レビュー（1回目） | 0 | 4 | 3 | 完了 |
| 2 | 指摘事項反映（1回目） | - | 4/4 対応 | - | 完了 |
| 3 | 影響範囲レビュー（1回目） | 2 | 6 | 2 | 完了 |
| 4 | 指摘事項反映（1回目・影響範囲） | - | 8/8 対応 | - | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | - | スキップ（ユーザーメモリ設定） |

## 主な反映内容

### Must Fix 対応（計2件）

1. **S3-001**: worktreeCount 集計クエリの JOIN キー誤り修正
   - `repository_id` → `repository_path` ベースに修正
   - 推奨実装として `getAllRepositoriesWithWorktreeCount()` ヘルパー案を追記

2. **S3-002**: GET /api/worktrees との棲み分け方針明確化
   - Single Source of Truth 方針を確定（Repositories画面はrepositoriesテーブル起点）
   - 別名更新後の反映はリロード後前提（Option C）を明記

### Should Fix 対応（計10件）

- S1-001: updateDisplayName レスポンス型を `Omit<RepositoryListItem, 'worktreeCount'>` として分離
- S1-002: 既存 `getRepositories()`（worktree-db.ts）との棲み分けを明記
- S1-003: 無効化リポジトリの扱い（全件返却＋フロントでバッジ表示）を明確化
- S1-004: 共有定数 `MAX_DISPLAY_NAME_LENGTH` を `src/config/repository-config.ts` に配置
- S3-003: PUT ルートの定数置換手順・Integration テスト追加を明記
- S3-004: page.tsx の `refreshKey` バケツリレーパターンを実装例コード付きで確定
- S3-005: 既存 `getAllRepositories()` のシグネチャ不変・後方互換を明記
- S3-006: テスト戦略セクション新設（3ファイル追加要件）
- S3-007: 認証ミドルウェア通過確認を受け入れ条件に追加
- S3-008: ポーリング方針 Option A（ポーリングなし、イベント時のみ refresh）を確定

## 生成ファイル

- 元Issue: `dev-reports/issue/644/issue-review/original-issue.json`
- 仮説検証: `dev-reports/issue/644/issue-review/hypothesis-verification.md`
- Stage 1レビュー: `dev-reports/issue/644/issue-review/stage1-review-result.json`
- Stage 2反映: `dev-reports/issue/644/issue-review/stage2-apply-result.json`
- Stage 3レビュー: `dev-reports/issue/644/issue-review/stage3-review-result.json`
- Stage 4反映: `dev-reports/issue/644/issue-review/stage4-apply-result.json`

## 次のアクション

- [x] Issue レビュー完了（GitHub Issue更新済み）
- [ ] 作業計画立案（`/work-plan`）
- [ ] TDD実装（`/pm-auto-dev`）
