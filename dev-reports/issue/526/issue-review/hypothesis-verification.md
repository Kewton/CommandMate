# Issue #526 仮説検証レポート

## 検証日時
- 2026-03-20

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | syncWorktreesToDB()でtmuxセッション削除が欠落 | Confirmed | `src/lib/git/worktrees.ts:294-301` deleteWorktreesByIds()のみでtmux処理なし |
| 2 | DELETE /api/repositoriesではcleanupMultipleWorktrees()が呼ばれる | Confirmed | `src/app/api/repositories/route.ts:93-96` |
| 3 | cleanupWorktreeSessions()が既存インフラとして存在 | Confirmed | `src/lib/session-cleanup.ts:71-144` |
| 4 | killSession()が存在 | Confirmed | `src/lib/tmux/tmux.ts:372-390` |

## 詳細検証

### 仮説 1: syncWorktreesToDB()でtmuxセッション削除が欠落

**Issue内の記述**: `syncWorktreesToDB()`で削除対象worktreeのtmuxセッション削除が欠落している

**検証手順**:
1. `src/lib/git/worktrees.ts:265-308` の `syncWorktreesToDB()` を確認
2. 行294-301の削除ロジックを確認

**判定**: Confirmed

**根拠**: 行298-301で `deleteWorktreesByIds(db, deletedIds)` のみ呼び出し。tmuxセッション削除処理は一切なし。

### 仮説 2: DELETE /api/repositoriesではcleanupMultipleWorktrees()が呼ばれる

**Issue内の記述**: リポジトリ削除ではtmuxセッションも削除される

**検証手順**:
1. `src/app/api/repositories/route.ts:93-96` を確認

**判定**: Confirmed

**根拠**: `cleanupMultipleWorktrees(worktreeIds, killWorktreeSession)` が明示的に呼ばれている。

### 仮説 3: cleanupWorktreeSessions()が既存インフラとして存在

**Issue内の記述**: `src/lib/session-cleanup.ts` にクリーンアップ関数が存在

**検証手順**:
1. `src/lib/session-cleanup.ts:71-144` を確認

**判定**: Confirmed

**根拠**: `cleanupWorktreeSessions()` が存在し、CLIセッションkill、response-poller停止、auto-yes停止、スケジュール停止を行う。

### 仮説 4: killSession()が存在

**Issue内の記述**: `src/lib/tmux/tmux.ts` にtmuxセッション削除関数が存在

**検証手順**:
1. `src/lib/tmux/tmux.ts:372-390` を確認

**判定**: Confirmed

**根拠**: `killSession(sessionName)` が存在し、`tmux kill-session -t` コマンドを実行する。

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedのため、Issue記載の原因分析は正確
- 修正方針も妥当（既存の`cleanupMultipleWorktrees()`/`cleanupWorktreeSessions()`を活用）
- sync APIルート側で削除前にクリーンアップを挟むか、`syncWorktreesToDB()`内部で処理するかの設計判断が必要
