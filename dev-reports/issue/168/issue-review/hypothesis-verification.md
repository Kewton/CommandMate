# Issue #168 仮説検証レポート

## 検証日時
- 2026-03-20

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | kill-session APIでセッション終了時にメッセージも削除される（deleteMessagesByCliTool） | Confirmed | kill-session/route.ts:95でdeleteMessagesByCliTool、:98でdeleteAllMessagesを実行 |
| 2 | chat_messagesテーブルにsession_idやarchivedカラムが存在しない | Confirmed | init-db.ts:33-47のスキーマに該当カラムなし |

## 詳細検証

### 仮説 1: kill-session APIでメッセージ物理削除される

**Issue内の記述**: 「現在、kill-session APIでセッション終了時にメッセージも削除される（deleteMessagesByCliTool）」

**検証手順**:
1. `src/app/api/worktrees/[id]/kill-session/route.ts` を確認
2. `src/lib/db/chat-db.ts` の `deleteMessagesByCliTool` 関数を確認

**判定**: Confirmed

**根拠**:
- `kill-session/route.ts:93-98`: targetCliTool指定時は `deleteMessagesByCliTool(db, params.id, targetCliTool)` で該当ツールのメッセージを物理削除、未指定時は `deleteAllMessages(db, params.id)` で全メッセージを物理削除
- `chat-db.ts:301-304`: `DELETE FROM chat_messages WHERE worktree_id = ? AND cli_tool_id = ?` で物理DELETEを実行

### 仮説 2: chat_messagesテーブルにsession_id/archivedカラムが未実装

**Issue内の記述**: 「chat_messagesテーブルにsession_idまたはarchivedカラムを追加」（実装タスクとして記載）

**検証手順**:
1. `src/lib/db/init-db.ts` のテーブルスキーマを確認
2. マイグレーションファイルでカラム追加の有無を確認

**判定**: Confirmed

**根拠**:
- `init-db.ts:33-47`: chat_messagesテーブルのカラムは `id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id` のみ
- session_id, archived等のカラムは存在しない

---

## Stage 1レビューへの申し送り事項

- Issueの仮説はすべてConfirmed。追加の修正は不要
- 実装方針の妥当性（archivedフラグ vs session_id方式）についてはレビューで検討が必要
