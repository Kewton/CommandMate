# Worktree同期機能 不具合修正 進捗報告

## 概要

| 項目 | 内容 |
|------|------|
| **不具合ID** | 20260203_worktree_sync |
| **報告日** | 2026-02-03 |
| **ステータス** | ✅ 修正完了 |
| **重大度** | Medium |

## 不具合概要

`/worktree-setup` スキルでworktreeを作成後、CommandMateのトップ画面に新しいworktreeが表示されない問題。

## 根本原因

1. **スキルの同期処理欠落**: `/worktree-setup` と `/worktree-cleanup` スキルがworktree作成/削除後にサーバーへの同期通知を行っていなかった
2. **同期APIの削除ロジック欠落**: `syncWorktreesToDB()` 関数が、削除されたworktreeをDBから削除するロジックを持っていなかった

## 修正内容

### 1. 同期API（syncWorktreesToDB）の改修

**対象ファイル**: `src/lib/worktrees.ts`

**変更内容**:
- リポジトリごとにworktreeをグループ化
- DBから既存のworktree IDを取得
- `git worktree list`の結果と比較
- 存在しなくなったworktreeをDBから削除
- 新規・更新worktreeをupsert

```typescript
export function syncWorktreesToDB(db, worktrees): void {
  // リポジトリごとにグループ化
  const worktreesByRepo = new Map<string, Worktree[]>();
  // ...

  for (const [repoPath, repoWorktrees] of worktreesByRepo) {
    // 既存IDと新規IDを比較
    const existingIds = getWorktreeIdsByRepository(db, repoPath);
    const newIds = new Set(repoWorktrees.map(wt => wt.id));

    // 削除されたworktreeをDBから削除
    const deletedIds = existingIds.filter(id => !newIds.has(id));
    if (deletedIds.length > 0) {
      deleteWorktreesByIds(db, deletedIds);
    }

    // 現在のworktreeをupsert
    for (const worktree of repoWorktrees) {
      upsertWorktree(db, worktree);
    }
  }
}
```

### 2. DB関数の追加

**対象ファイル**: `src/lib/db.ts`

**追加関数**:
- `deleteWorktreesByIds()`: 指定されたIDのworktreeをDBから削除

### 3. スキルファイルの更新

**対象ファイル**:
- `.claude/commands/worktree-setup.md`
- `.claude/commands/worktree-cleanup.md`

**変更内容**:
- Phase 6として「Worktree同期」ステップを追加
- 同期APIの呼び出し手順を記載

## テスト結果

### 単体テスト

| テストケース | 結果 |
|-------------|------|
| 新しいworktreeをDBに追加 | ✅ Pass |
| 既存のworktreeを更新 | ✅ Pass |
| 削除されたworktreeをDBから削除 | ✅ Pass |
| 他リポジトリのworktreeに影響しない | ✅ Pass |
| 空のworktreeリストを適切に処理 | ✅ Pass |

### 受入テスト

| シナリオ | 結果 |
|---------|------|
| worktree作成後に同期→DBに登録される | ✅ Pass |
| worktree削除後に同期→DBから削除される | ✅ Pass |

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/worktrees.ts` | `syncWorktreesToDB()` 改修 |
| `src/lib/db.ts` | `deleteWorktreesByIds()` 追加 |
| `src/lib/__tests__/worktrees-sync.test.ts` | 新規テスト追加 |
| `.claude/commands/worktree-setup.md` | Phase 6追加 |
| `.claude/commands/worktree-cleanup.md` | Phase 6追加 |
| `dev-reports/bug-fix/20260203_worktree_sync/work-plan.md` | 作業計画 |
| `dev-reports/bug-fix/20260203_worktree_sync/progress-report.md` | 本レポート |

## 今後の推奨事項

1. **サーバー再起動の推奨**: `/worktree-setup` または `/worktree-cleanup` 実行後、同期APIが呼ばれるまでトップ画面に反映されないため、サーバー再起動を推奨
2. **自動同期の検討**: 将来的にはファイルシステム監視による自動同期機能の実装を検討
