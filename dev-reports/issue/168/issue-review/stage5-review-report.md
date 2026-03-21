# Issue #168 Stage 5 Review Report -- Normal Review (2nd Iteration)

**Issue**: セッションをクリアしても履歴はクリアして欲しく無い
**Stage**: 5 (通常レビュー 2回目)
**Date**: 2026-03-20

---

## Previous Findings Resolution Status

All 7 findings from Stage 1 have been resolved.

| ID | Severity | Status | Summary |
|----|----------|--------|---------|
| F1-DESIGN-AMBIGUITY | must_fix | Resolved | archived方式に確定。設計判断の根拠も記載済み |
| F2-MIGRATION-TASK-INCOMPLETE | should_fix | Resolved | マイグレーション5項目に具体化 |
| F3-GETMESSAGES-IMPACT | should_fix | Resolved | 8関数のarchivedフィルタ追加を個別リスト化 |
| F4-UI-TOGGLE-UNDERSPECIFIED | should_fix | Resolved | HistoryPaneヘッダー配置、localStorage永続化を明記 |
| F5-ACCEPTANCE-NO-DATA-GROWTH | nice_to_have | Resolved | 将来の検討事項セクションに方針記載 |
| F6-WEBSOCKET-BROADCAST | nice_to_have | Resolved | WebSocketペイロード変更タスク追加 |
| F7-ALTERNATIVE-UNEXPLORED | nice_to_have | Resolved | #11ステータス次第の注記追加 |

---

## New Findings

### F5-1-DELETE-ALL-MESSAGES-MISSING [must_fix]

**Category**: 実装タスクの完全性

kill-session APIには2つのメッセージ削除パスがある:

1. `deleteMessagesByCliTool` -- cliTool指定時 (route.ts L95)
2. `deleteAllMessages` -- cliTool未指定時 (route.ts L98)

実装タスク2は前者のみ言及しており、`deleteAllMessages` の論理削除変更が漏れている。cliTool未指定でセッション終了した場合、メッセージが物理削除されてしまう。

**Recommendation**: 実装タスク2に `deleteAllMessages` 関数の論理削除変更を追加する。影響範囲テーブルにも `deleteAllMessages` を追加する。

---

### F5-2-WEBSOCKET-CLIENT-OVERCLAIMED [nice_to_have]

**Category**: 記載内容の正しさ

影響範囲セクションが「WorktreeDetailRefactored.tsx でメッセージリストをクリアするロジックがある場合」と記載しているが、実際には `messagesCleared` を参照するクライアントコードは存在しない。`messagesCleared` は `useWebSocket.ts` の型定義にのみ存在し、`WorktreeList.tsx` のハンドラは `isRunning` のみを使用している。

**Recommendation**: 影響範囲の記述を実態に合わせて修正し、型定義の変更のみが必要である旨に書き換える。

---

### F5-3-MIGRATION-VERSION-ACCURACY [nice_to_have]

**Category**: 記載内容の正しさ

「CURRENT_SCHEMA_VERSIONを22にインクリメント（現在のバージョンは21）」は現時点で正確だが、他Issueのマージで実装時に陳腐化する可能性がある。

**Recommendation**: 「CURRENT_SCHEMA_VERSIONを1インクリメント（実装時点のバージョン+1）」に変更すると堅牢。

---

### F5-4-SQLITE-ALTER-TABLE-DEFAULT [nice_to_have]

**Category**: 記載内容の正しさ

SQLiteのALTER TABLE ADD COLUMNに関する安全策のUPDATE文は防御的で適切。記載のままで問題なし。

---

## Summary

| Severity | Count |
|----------|-------|
| must_fix | 1 |
| should_fix | 0 |
| nice_to_have | 3 |

Stage 1の指摘7件は全て適切に解消されている。Issueは実装可能なレベルまで充実しており、DB関数の影響範囲、テスト修正タスク、受入条件が網羅的に記載されている。

新規の must_fix は1件のみ: `deleteAllMessages` 関数の論理削除変更がタスクから漏れている。これは kill-session API の2つの削除パスのうち1つが欠落しているという具体的な漏れであり、修正が必要。

その他は記述の正確性に関する軽微な改善提案であり、実装の障害にはならない。
