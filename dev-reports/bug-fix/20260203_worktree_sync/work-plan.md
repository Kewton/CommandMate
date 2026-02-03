# Worktree同期機能 不具合修正 作業計画

## 不具合概要

- **Issue**: `/worktree-setup` でworktreeを作成後、CommandMateトップ画面に表示されない
- **根本原因**:
  1. `/worktree-setup` スキルがworktree作成後にサーバーへの同期通知を行っていない
  2. `syncWorktreesToDB()` が削除されたworktreeをDBから削除するロジックを持っていない

## 修正内容

### 修正A: 同期API（/api/repositories/sync）の改修

**対象ファイル**: `src/lib/worktrees.ts`

**変更内容**:
- `syncWorktreesToDB()` を改修し、`git worktree list` に存在しないworktreeをDBから削除するロジックを追加

**実装方針**:
1. リポジトリごとにworktreeをグループ化
2. DBから該当リポジトリのworktree一覧を取得
3. `git worktree list` の結果と比較
4. 存在しないworktreeをDBから削除
5. 新規・更新worktreeをupsert

### 修正C: スキルに同期処理追加

**対象ファイル**:
- `.claude/commands/worktree-setup.md`
- `.claude/commands/worktree-cleanup.md`

**変更内容**:
- スキル完了時に `POST /api/repositories/sync` を呼び出す処理を追加

## 完了条件

1. `/worktree-setup` 実行後、トップ画面に新しいworktreeが表示される
2. `/worktree-cleanup` 実行後、トップ画面からworktreeが削除される
3. 既存のworktreeは影響を受けない
4. テストカバレッジ80%以上

## 作業順序

1. `syncWorktreesToDB()` の単体テスト作成（Red）
2. `syncWorktreesToDB()` の改修（Green）
3. スキルファイルの修正
4. 統合テスト
5. 受入テスト
