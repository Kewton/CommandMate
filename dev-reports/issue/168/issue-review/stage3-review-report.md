# Issue #168 影響範囲レビュー（Stage 3 - 1回目）

**Issue**: セッションをクリアしても履歴はクリアして欲しく無い
**レビュー日**: 2026-03-20
**対象**: 影響範囲分析（Impact Scope）

---

## 概要

Issue #168はkill-session時のメッセージ物理削除を論理削除（archivedフラグ）に変更する提案である。Issue本文では主にgetMessages関数へのarchivedパラメータ追加とkill-session APIの修正に焦点を当てているが、実際のコードベースを調査した結果、chat_messagesテーブルを参照するDB関数・サブクエリが他に多数存在し、それらへの影響が十分に検討されていないことが判明した。

---

## 指摘サマリー

| 深刻度 | 件数 |
|--------|------|
| must_fix | 5 |
| should_fix | 5 |
| nice_to_have | 3 |

---

## must_fix（5件）

### IS3-001: getLastAssistantMessageAt にarchivedフィルタが必要

**影響ファイル**: `src/lib/db/chat-db.ts` (L68-85)

getLastAssistantMessageAt はサイドバーの未読トラッキング（Issue #31）で使用される。archivedメッセージを含む MAX(timestamp) を返すと、アーカイブ済みメッセージのtimestampが最新と判定され、未読バッジが正しく表示されなくなる。

**修正提案**: SQLに `AND archived = 0` を追加する。

---

### IS3-002: worktree-db.ts のサブクエリ2箇所にarchivedフィルタが必要

**影響ファイル**: `src/lib/db/worktree-db.ts` (L93-94, L208-209)

getWorktrees() と getWorktreeById() の両方が、chat_messagesからlast_assistant_message_atをサブクエリで取得している。IS3-001と同じ未読トラッキングの問題が発生する。

**修正提案**: 両サブクエリに `AND (archived IS NULL OR archived = 0)` を追加する。

---

### IS3-003: getLastMessagesByCliBatch にarchivedフィルタが必要

**影響ファイル**: `src/lib/db/worktree-db.ts` (L23-75)

サイドバーに表示される「最後のメッセージ」プレビューに、アーカイブ済みメッセージが表示されてしまう。

**修正提案**: ranked_messages CTEの WHERE句に `AND (archived IS NULL OR archived = 0)` を追加する。

---

### IS3-004: getLastMessage / getLastUserMessage にarchivedフィルタが必要

**影響ファイル**: `src/lib/db/chat-db.ts` (L205-241)

これらの関数は以下の重要なロジックで使用されている:

1. **send/route.ts (L215)**: 重複メッセージ検出 -- アーカイブ済みメッセージが最新として取得されると、同一内容の新規メッセージが誤って重複と判定される
2. **worktree-status-helper.ts (L102)**: stale prompt検出 -- アーカイブ済みpromptが検出されると不要なmarkPendingPromptsAsAnsweredが実行される
3. **conversation-logger.ts (L24)**: ログ記録 -- アーカイブ済みユーザーメッセージが誤ってログに記録される

**修正提案**: 両関数のSQLに `AND archived = 0` を追加する。

---

### IS3-013: マイグレーションにおけるNULL安全性の考慮

**影響ファイル**: `src/lib/db/db-migrations.ts`, `src/lib/db/chat-db.ts`

ALTER TABLE ADD COLUMN時のDEFAULT値の挙動確認が必要。SQLiteではDEFAULT値が指定されていれば既存行にも適用されるが、安全策としてマイグレーション内で明示的にUPDATE文を実行するか、全クエリで `(archived IS NULL OR archived = 0)` を使用する方針を決定すべき。

**修正提案**: マイグレーション内に `UPDATE chat_messages SET archived = 0 WHERE archived IS NULL` を追加するか、全クエリでNULLセーフな条件を使用する。

---

## should_fix（5件）

### IS3-005: markPendingPromptsAsAnswered にarchivedフィルタが必要

**影響ファイル**: `src/lib/db/chat-db.ts` (L376-420)

アーカイブ済みpromptメッセージが対象に含まれ、不要なDB更新が発生する。実害は限定的だが、不要なI/Oを避けるためフィルタを追加すべき。

---

### IS3-006: conversation-logger.ts への間接影響

**影響ファイル**: `src/lib/conversation-logger.ts`

IS3-004のgetLastUserMessage修正で自動的に解決されるが、影響範囲として認識しておく必要がある。

---

### IS3-007: マイグレーションバージョン番号の曖昧さ

**影響ファイル**: `src/lib/db/db-migrations.ts`

現在のCURRENT_SCHEMA_VERSIONは21。Issue本文の「既存22件の次の番号」は曖昧。バージョン22を追加し、Issue本文を修正すべき。

---

### IS3-008: WebSocketクライアント側のmessagesClearedハンドラ影響

**影響ファイル**: `src/app/api/worktrees/[id]/kill-session/route.ts`, `src/components/worktree/WorktreeDetailRefactored.tsx`

WebSocketの `messagesCleared: true` を受信するクライアント側コンポーネントが、archived方式に合わせてメッセージの再フェッチにロジック変更が必要な可能性がある。

---

### IS3-009: 既存テスト5ファイルの修正タスクが未記載

**影響ファイル**:
- `tests/unit/db.test.ts`
- `tests/unit/db-delete-messages-by-cli-tool.test.ts`
- `tests/integration/api-messages.test.ts`
- `tests/integration/api-hooks.test.ts`
- `tests/integration/api-send-cli-tool.test.ts`

Issue本文の実装タスクにテスト修正セクションがない。特にdeleteMessagesByCliToolのテストは「削除後メッセージ0件」の検証がarchived方式では変更が必要。

---

## nice_to_have（3件）

### IS3-010: log-export-sanitizer.ts への影響なし（確認済み）

直接的な影響なし。将来のエクスポート機能追加時に考慮。

### IS3-011: session-cleanup.ts への影響なし（確認済み）

メッセージDB操作は行わない。ON DELETE CASCADEによるworktree削除時はarchivedメッセージ含め全削除で問題なし。

### IS3-012: CLIコマンドへの影響は限定的

API経由のため、API側の修正で自動的に対応される。api-client.tsにincludeArchivedオプション追加が推奨。

---

## 影響範囲マップ

### 直接変更が必要なファイル（Issue未記載分）

| ファイル | 関数/箇所 | 変更内容 |
|---------|----------|---------|
| `src/lib/db/chat-db.ts` | getLastAssistantMessageAt | WHERE archived = 0 追加 |
| `src/lib/db/chat-db.ts` | getLastMessage | WHERE archived = 0 追加 |
| `src/lib/db/chat-db.ts` | getLastUserMessage | WHERE archived = 0 追加 |
| `src/lib/db/chat-db.ts` | markPendingPromptsAsAnswered | WHERE archived = 0 追加 |
| `src/lib/db/worktree-db.ts` | getWorktrees サブクエリ (L93) | AND archived = 0 追加 |
| `src/lib/db/worktree-db.ts` | getWorktreeById サブクエリ (L208) | AND archived = 0 追加 |
| `src/lib/db/worktree-db.ts` | getLastMessagesByCliBatch (L44) | AND archived = 0 追加 |

### Issue本文に既に含まれているファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/db/db-migrations.ts` | archivedカラム追加マイグレーション |
| `src/lib/db/chat-db.ts` (getMessages) | archivedパラメータ追加 |
| `src/lib/db/chat-db.ts` (deleteMessagesByCliTool) | DELETE -> UPDATE archived=1 |
| `src/lib/db/chat-db.ts` (deleteAllMessages) | DELETE -> UPDATE archived=1 |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | 論理削除呼び出しに変更 |
| `src/app/api/worktrees/[id]/messages/route.ts` | includeArchivedパラメータ追加 |

### 間接的に影響を受けるファイル（変更は上流修正で解決）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/conversation-logger.ts` | getLastUserMessage経由 |
| `src/app/api/worktrees/[id]/send/route.ts` | getMessages経由 |
| `src/lib/session/worktree-status-helper.ts` | getMessages経由 |
| `src/app/api/worktrees/route.ts` | getMessages経由 |
| `src/app/api/worktrees/[id]/route.ts` | getMessages経由 |

---

## 推奨アクション

1. Issue本文の実装タスク「3. getMessages関数・API修正」を拡張し、上記7箇所の関数/サブクエリへのarchivedフィルタ追加を明示する
2. 「5. 既存テスト修正」セクションを追加し、影響を受ける5テストファイルを列挙する
3. マイグレーションバージョン番号を「22」に明確化する
4. WebSocketクライアント側のmessagesClearedハンドラの影響調査タスクを追加する
