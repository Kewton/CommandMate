# Issue #690 仮説検証レポート

## 検証対象Issue

**タイトル**: Repositoriesから表示/非表示を切り替えたい

---

## 仮説・前提条件の抽出と検証

### 仮説1: `repositories` テーブルに `visible` カラムを追加できる

**主張**: 現在 `repositories` テーブルに `visible` カラムが存在しないため追加が必要

**検証結果**: **Confirmed（確認済み）**

- `src/lib/db/db-repository.ts` の `RepositoryRow` インターフェースに `visible` フィールドは存在しない
- `enabled` カラムは存在するが、これはリポジトリのsync除外用（Issue #190）で、表示/非表示とは別概念
- マイグレーションファイルは現在最大 `v30-assistant-context-snapshot.ts` であるため、新規マイグレーションは `v31-repository-visible.ts` が適切

**申し送り事項（Stage 1レビューへ）**: Issueに記載の `v3x-repository-visible.ts` というファイル名は不正確。最新マイグレーション `v30` の次であるため `v31-repository-visible.ts` が正しい命名規則。

---

### 仮説2: Issue #190の `enabled` フラグパターンが参考実装として有効

**主張**: Issue #190 の `enabled` フラグパターン（論理削除）が参考実装として使える

**検証結果**: **Partially Confirmed（部分確認）**

- `enabled` カラムはDB側 (`db-repository.ts`) に存在し、CRUD操作も実装済み
- しかし `enabled=false` は「sync対象外」の意味であり、Sidebar表示制御とは異なる用途
- `visible` フラグはサイドバー表示の制御専用に新設すべきで、`enabled` の意味を変更してはならない
- DBパターン（INTEGER DEFAULT 1）やCRUD実装パターンは参考にできる

---

### 仮説3: Sidebar.tsx でフロント側フィルタリングが実現可能

**主張**: `Sidebar.tsx` で `visible=false` リポジトリのworktreeをフロント側でフィルタリング除外できる

**検証結果**: **Partially Confirmed（部分確認）**

- `Sidebar.tsx` は `useWorktreeSelection` Contextから `worktrees` を取得し、`worktrees.map(toBranchItem)` でサイドバーアイテムに変換する
- `Worktree` 型 (`src/types/models.ts`) には現在 `repositoryVisible` フィールドが存在しない
- フロント側フィルタリングのためには以下のいずれかが必要:
  1. Worktrees APIのレスポンスに `repositoryVisible` フィールドを追加
  2. Sidebarが Repositories APIを別途フェッチして `visible` 状態をクロスリファレンス
- アプローチ1（Worktrees APIにフィールド追加）が既存パターンに沿った自然な実装

**申し送り事項（Stage 1レビューへ）**: Issueには「フロント側でフィルタリング」と記載があるが、実装するには Worktrees API のレスポンスまたは別途リポジトリ情報の取得が必要。この詳細が影響範囲として漏れている可能性がある。

---

### 仮説4: Issue #644 の RepositoryList インライン編集UIパターンが再利用できる

**主張**: Issue #644 のインライン編集UIパターン（`RepositoryList.tsx`）でトグルボタンを追加できる

**検証結果**: **Confirmed（確認済み）**

- `src/components/repository/RepositoryList.tsx` が存在し、インライン編集機能（displayName編集）が実装済み
- `EditState` インターフェース、`saving`フラグ、API呼び出しパターンが実装済みで再利用可能
- `repositoryApi` クライアントも `src/lib/api-client.ts` に定義済み

---

### 仮説5: `src/components/repository/RepositoryManager.tsx` が存在する

**主張**: 関連コンポーネントとして `RepositoryManager.tsx` が存在する

**検証結果**: **Confirmed（確認済み）**

- `src/components/repository/RepositoryManager.tsx` が存在する
- ただし `visible` 制御はこのコンポーネントではなく `RepositoryList.tsx` に実装すべき（Issue記載通り）

---

### 仮説6: PUT `/api/repositories/{id}` で `visible` 更新対応が可能

**主張**: 既存のPUT `/api/repositories/{id}` に `visible` 更新を追加できる

**検証結果**: **Confirmed（確認済み）**

- `src/app/api/repositories/[id]/route.ts` が存在し、現在は `displayName` のみPUT対応
- `visible` フィールドも同様のパターンで追加可能
- ただし `updateRepository` 関数 (`db-repository.ts`) に `visible` フィールド対応を追加する必要がある

---

## 検証サマリー

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | `visible` カラムをDBに追加（マイグレーション `v3x` → 実際は `v31`） | Partially Confirmed |
| 2 | `enabled` フラグパターンを参考実装として利用 | Partially Confirmed |
| 3 | Sidebar.tsx でフロント側フィルタリング（追加データが必要） | Partially Confirmed |
| 4 | Issue #644 のUIパターン再利用 | Confirmed |
| 5 | `RepositoryManager.tsx` が存在する | Confirmed |
| 6 | PUT `/api/repositories/{id}` に `visible` 追加 | Confirmed |

---

## Stage 1 レビューへの申し送り事項

1. **マイグレーションファイル名の誤り**: `v3x` → `v31` に修正が必要
2. **Sidebar フィルタリングの実装詳細不足**: Worktrees API レスポンスに `repositoryVisible` フィールドの追加が必要だが、Issueに記載がない
3. **`enabled` と `visible` の概念分離が明示されていない**: `enabled=false` はsync除外用であり、`visible` とは別概念であることをIssueに明記すべき
