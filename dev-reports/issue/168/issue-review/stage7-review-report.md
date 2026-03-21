# Issue #168 - Stage 7: 影響範囲レビュー（2回目）

## レビュー概要

| 項目 | 値 |
|------|-----|
| Issue | #168 セッションをクリアしても履歴はクリアして欲しく無い |
| ステージ | 7（影響範囲レビュー 2回目） |
| must_fix | 0件 |
| should_fix | 3件 |
| nice_to_have | 3件 |

## Stage 3 指摘事項の反映状況

Stage 3で検出された全13件の指摘は全てIssue本文に適切に反映されていることを確認した。

| ID | 状態 | 概要 |
|----|------|------|
| IS3-001 | 反映済み | getLastAssistantMessageAt のarchivedフィルタ |
| IS3-002 | 反映済み | getWorktrees/getWorktreeById サブクエリのフィルタ |
| IS3-003 | 反映済み | getLastMessagesByCliBatch のフィルタ |
| IS3-004 | 反映済み | getLastMessage/getLastUserMessage のフィルタ |
| IS3-005 | 反映済み | markPendingPromptsAsAnswered のフィルタ |
| IS3-006 | 反映済み | conversation-logger.ts の間接影響 |
| IS3-007 | 反映済み | マイグレーションバージョン記述の曖昧さ解消 |
| IS3-008 | 反映済み | WebSocketクライアント側 messagesCleared の影響調査 |
| IS3-009 | 反映済み | 既存テスト修正タスクの追加 |
| IS3-010 | 反映済み | log-export-sanitizer.ts の将来的影響 |
| IS3-011 | 反映済み | session-cleanup.ts は変更不要 |
| IS3-012 | 反映済み | CLIコマンドはAPI経由のため直接影響なし |
| IS3-013 | 反映済み | マイグレーション時のNULL安全策 |

## 新規指摘事項

### should_fix（3件）

#### IS7-001: worktrees.last_user_message がアーカイブ後にクリアされない

`worktrees` テーブルの `last_user_message` と `last_user_message_at` はデノーマライズされたフィールドで、`createMessage` 時に更新される。kill-session APIでメッセージをアーカイブした後、これらのフィールドはアーカイブされたセッションの最後のユーザーメッセージの値を保持し続ける。新セッションでメッセージを送信するまで、サイドバーにはアーカイブ済みセッションの情報が表示される。

- **影響ファイル**: `src/lib/db/chat-db.ts`, `src/app/api/worktrees/[id]/kill-session/route.ts`
- **提案**: kill-session APIでアーカイブ後に `last_user_message` / `last_user_message_at` をNULLクリアする処理を追加するか、方針をIssue本文に明記する

#### IS7-002: テスト影響範囲に db-repository-delete 関連テストが含まれていない

`tests/unit/db-repository-delete.test.ts` と `tests/integration/api-repository-delete.test.ts` の両テストが `SELECT * FROM chat_messages WHERE worktree_id = ?` でON DELETE CASCADEの動作を検証している。archivedカラム追加後もCASCADE削除が正常に動作することを確認するテストとして、テスト影響範囲に含めるべき。

- **影響ファイル**: `tests/unit/db-repository-delete.test.ts`, `tests/integration/api-repository-delete.test.ts`

#### IS7-003: テスト影響範囲に db-migrations.test.ts が含まれていない

`tests/unit/lib/db-migrations.test.ts` はchat_messagesテーブルのCASCADE削除テストやスキーマ検証を含んでおり、新しいマイグレーション（archivedカラム追加）のテストケースを追加すべきファイル。

- **影響ファイル**: `tests/unit/lib/db-migrations.test.ts`

### nice_to_have（3件）

#### IS7-004: 新規インデックスの検証テスト場所が不明確

タスク1で追加予定の `idx_messages_archived` 複合インデックスの存在を検証するテストの追加場所を明確にしておくとよい。

#### IS7-005: deleteMessageById の archived 方式導入後の方針が不明確

`send/route.ts` で孤立メッセージのクリーンアップに使用される `deleteMessageById` は物理削除のまま維持する方針を明記しておくと、実装時に迷わない。

#### IS7-006: DB関数の呼び出し元の可視化が不完全

`response-poller.ts` と `worktree-status-helper.ts` がgetMessages/markPendingPromptsAsAnsweredの呼び出し元だが、影響範囲テーブルに記載されていない。DB関数自体のフィルタ追加でカバーされるため実装影響はない。

## コード検証結果

以下のモジュールについてソースコードを直接確認し、Issue本文の影響範囲分析の正確性を検証した。

| モジュール | 結論 |
|-----------|------|
| `src/lib/session-cleanup.ts` | chat_messagesへの直接アクセスなし。変更不要（Issue本文通り） |
| `src/lib/polling/response-poller.ts` | chat_messagesへの直接アクセスなし。markPendingPromptsAsAnsweredをDB関数経由で呼び出し（フィルタ追加で自動対応） |
| `src/lib/polling/auto-yes-manager.ts` | chat_messagesへの参照なし。変更不要 |
| `src/cli/commands/` | DB関数の直接呼び出しなし（全てAPI経由）。変更不要 |
| `src/lib/log-export-sanitizer.ts` | chat_messagesへの直接参照なし。変更不要 |
| ON DELETE CASCADE | worktree削除時にarchivedメッセージも含めて全行を物理削除。正しい動作 |

## 総合評価

Issue #168は6回のレビュー・反映を経て、影響範囲の分析が十分に網羅的な状態に達している。must_fixレベルの見落としはない。should_fix 3件は主にテスト影響範囲の網羅性向上とデノーマライズフィールドの整合性に関するもので、実装の品質向上に寄与する指摘である。実装に進んで問題ないレベルの完成度と判断する。
