# Issue #168 Stage 1 Review Report

## Review Information

| Item | Value |
|------|-------|
| Issue | #168 - セッションをクリアしても履歴はクリアして欲しく無い |
| Stage | 1 - 通常レビュー（1回目） |
| Focus | Consistency & Correctness |
| Date | 2026-03-20 |

## Summary

Issue #168の技術的前提は全て正確（仮説検証でConfirmed済み）。kill-session APIがメッセージを物理削除している現状の課題認識、chat_messagesテーブルにarchived/session_idカラムが存在しないという前提は、コードベースと一致している。

ただし、**実装方針が未確定**（session_id方式 vs archived方式）であることが最大の問題点。加えて、実装タスクが高レベルすぎて着手可能な粒度に達していない。

## Findings Overview

| Severity | Count |
|----------|-------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |

---

## Must Fix

### F1: 実装方式が未確定（session_id vs archived）

**Category**: 要件の明確さ

実装タスクに「session_idまたはarchivedカラムを追加」と記載されているが、2つの方式は設計が根本的に異なる。

- **session_id方式**: セッション採番ロジック、session管理テーブル追加が必要。複雑度が高い。
- **archived方式**: 論理削除フラグ。getMessagesにWHERE条件追加で対応可能。シンプル。

Issue本文の「提案する解決策」では「論理削除（archivedフラグ）」と明記しているにもかかわらず、実装タスクで両方を列挙しており方針が矛盾している。

**推奨**: archived方式に確定し、実装タスクから「session_idまたは」を削除する。

---

## Should Fix

### F2: DBマイグレーションタスクの具体性不足

**Category**: 実装タスクの完全性

「DBマイグレーション」とだけ記載されているが、以下を具体化すべき。

- `chat_messages`テーブルに`archived INTEGER DEFAULT 0`をALTER TABLE ADDで追加
- 既存メッセージは`archived=0`（現行セッションとして表示）
- `db-migrations.ts`のMIGRATION_VERSIONインクリメント（現在22件のマイグレーション実績あり）
- インデックス追加: `idx_messages_archived (worktree_id, archived, timestamp DESC)`

**Evidence**: `src/lib/db/db-migrations.ts` に既存マイグレーション22件。ALTER TABLE ADD COLUMNパターンの実績多数。

### F3: getMessages関数への影響が未記載

**Category**: 実装タスクの完全性

kill-session APIの修正だけでは不十分。受入条件「新セッション開始時は過去メッセージが非表示（デフォルト）」を実現するには以下が必要:

1. `getMessages`関数に`archived?: boolean`パラメータ追加（デフォルト: `false`で非アーカイブのみ取得）
2. `/api/worktrees/[id]/messages` APIに`includeArchived`クエリパラメータ追加
3. `getMessages`呼び出し元の影響確認（4箇所）:
   - `src/app/api/worktrees/route.ts`
   - `src/app/api/worktrees/[id]/route.ts`
   - `src/app/api/worktrees/[id]/send/route.ts`
   - `src/app/api/worktrees/[id]/messages/route.ts`

**Evidence**: `src/lib/db/chat-db.ts:172-200` getMessages関数には現在archivedフィルタ条件なし。

### F4: UIトグルの仕様が未指定

**Category**: 要件の明確さ

「過去セッション履歴の表示/非表示トグル」の配置場所・UX・状態永続化が未定義。

**推奨**:
- 配置場所: `HistoryPane`のstickyヘッダー内（`src/components/worktree/HistoryPane.tsx:258-260`）
- 状態永続化: localStorage（`SidebarContext.tsx`で同パターンの実績あり）
- アーカイブメッセージの視覚的区別（背景色変更やセパレータ挿入）

---

## Nice to Have

### F5: データ蓄積への考慮

論理削除方式ではメッセージが蓄積し続ける。長期利用時のDBサイズ・クエリ性能への影響について、保持期間上限や一括削除機能の検討を考慮事項として追記することを推奨。

### F6: WebSocketブロードキャストペイロードの更新

`kill-session/route.ts:107`の`messagesCleared: true`フラグは、論理削除後は意味が変わる。`messagesArchived`への変更またはフラグ意味の再定義、およびフロントエンド側のイベントハンドラ確認が必要。

### F7: 代替案のIssue #11参照が不明確

代替案でIssue #11（ログエクスポート機能）との連携に言及しているが、#11の現状ステータスや連携可能性の根拠が不明。

---

## Reviewed Files

- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/app/api/worktrees/[id]/kill-session/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/lib/db/chat-db.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/lib/db/init-db.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/lib/db/db-migrations.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/app/api/worktrees/[id]/messages/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/components/worktree/HistoryPane.tsx`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-168/src/lib/session-cleanup.ts`
