# Architecture Review Report: Issue #168 Stage 2 - 整合性レビュー

**Date**: 2026-03-20
**Issue**: #168 - Session History Retention (kill-session後の履歴閲覧)
**Stage**: 2 - 整合性レビュー (Consistency Review)
**Design Doc**: `dev-reports/design/issue-168-session-history-retention-design-policy.md`

---

## Executive Summary

設計書と現行コードベースの整合性レビューを実施した。設計書は行番号参照、関数シグネチャ、マイグレーションバージョン、UIコンポーネント構造のいずれも高い精度で現行コードを反映している。主要な指摘事項は、設計書が意図的に省略した箇所（getMessageById の変更言及漏れ）と、実装時に注意が必要な戻り値型の不一致に集中している。

| 重要度 | 件数 |
|--------|------|
| must_fix | 5 |
| should_fix | 5 |
| nice_to_have | 4 |

---

## Findings

### must_fix (5件)

#### CR2-001: getMessages の現行シグネチャが設計と異なる

- **File**: `src/lib/db/chat-db.ts` L172-200
- **Issue**: 設計書では getMessages をオプションオブジェクトパターン (GetMessagesOptions) に変更するとしているが、現行コードは位置パラメータ5個のシグネチャ。呼び出し元が3箇所存在する。
  - `src/app/api/worktrees/[id]/messages/route.ts` L57
  - `src/app/api/worktrees/[id]/send/route.ts` L215
  - `src/lib/session/worktree-status-helper.ts` L102
- **Action**: 実装時に3箇所の呼び出し元を確実にオプションオブジェクト形式に更新すること。

#### CR2-002: ChatMessage 型に archived フィールドが存在しない

- **File**: `src/types/models.ts` L181-204
- **Issue**: 設計書では `archived: boolean` を required フィールドとして追加するが、現行コードには存在しない。
- **Action**: `archived: boolean` を ChatMessage インターフェースに追加（DR1-006 の通り required）。

#### CR2-003: ChatMessageRow 型に archived フィールドが存在しない

- **File**: `src/lib/db/chat-db.ts` L16-44
- **Issue**: ChatMessageRow に `archived: number` がなく、mapChatMessage にも archived マッピングがない。
- **Action**: ChatMessageRow に `archived: number` を追加し、mapChatMessage に `archived: row.archived === 1` を追加。

#### CR2-004: init-db.ts の chat_messages テーブル定義に archived カラムが存在しない

- **File**: `src/lib/db/init-db.ts` L33-48
- **Issue**: 新規DB作成時の CREATE TABLE 文に `archived INTEGER DEFAULT 0` がない。
- **Action**: テーブル定義に archived カラムと idx_messages_archived インデックスを追加。

#### CR2-005: clearLastUserMessage 関数が現行コードに存在しない

- **File**: `src/lib/db/chat-db.ts` (新規追加)
- **Issue**: 設計書で定義された新規関数がまだ存在しない。db.ts バレルファイルへのエクスポート追加も必要。
- **Action**: chat-db.ts に実装し、`src/lib/db/db.ts` のエクスポートリストに追加。

### should_fix (5件)

#### CR2-006: deleteAllMessages の戻り値型が設計と異なる

- **File**: `src/lib/db/chat-db.ts` L248-259
- **Issue**: 設計書では戻り値を `number` (result.changes) としているが、現行コードは `void`。deleteMessagesByCliTool は既に number を返しており不統一。
- **Action**: 戻り値型を void から number に変更。呼び出し元は戻り値を使用していないため非破壊的変更。

#### CR2-007: HistoryPaneProps に showArchived / onShowArchivedChange が存在しない

- **File**: `src/components/worktree/HistoryPane.tsx` L35-50
- **Issue**: DR1-005 で指摘された状態オーナーシップ統一のための props が未定義。
- **Action**: 2つの props を追加し、トグルUIを組み込む。

#### CR2-008: HistoryPane のヘッダーがトグルUI無しのシンプル構造

- **File**: `src/components/worktree/HistoryPane.tsx` L258-260
- **Issue**: 現行ヘッダーは h3 テキストのみ。設計書の flex justify-between トグル配置と異なる。
- **Action**: ヘッダー構造を設計書に合わせて変更。

#### CR2-009: SELECT文に archived カラムが含まれていない

- **File**: `src/lib/db/chat-db.ts` L180, 210, 231
- **Issue**: getMessages, getLastUserMessage, getLastMessage の SELECT 文に archived カラムがない。
- **Action**: 全ての SELECT 文に archived を追加。

#### CR2-010: getMessageById が設計書で言及されていない

- **File**: `src/lib/db/chat-db.ts` L335-352
- **Issue**: getMessageById の SELECT 文にも archived カラムの追加が必要だが、設計書の変更対象関数一覧に含まれていない。
- **Action**: 設計書に追記するか、実装時に漏れなく対応すること。

### nice_to_have (4件)

#### CR2-011: CURRENT_SCHEMA_VERSION の前提確認

- 現行コード `CURRENT_SCHEMA_VERSION = 21` は設計書の前提（21 -> 22）と一致。問題なし。

#### CR2-012: kill-session/route.ts の行番号参照が正確

- 設計書の "L92-99相当" は現行コードと正確に一致。

#### CR2-013: worktree-db.ts のサブクエリ行番号参照が正確

- getWorktrees の L93-94、getWorktreeById の L208-209 ともに正確。

#### CR2-014: db.ts バレルファイルに GetMessagesOptions のエクスポートが必要

- 外部モジュールが型を参照する場合に備え、バレルファイルへの追加を検討。

---

## Verification Matrix

| 設計書の記述 | 現行コードとの一致 | 判定 |
|-------------|-------------------|------|
| CURRENT_SCHEMA_VERSION = 21 (変更前) | db-migrations.ts L14: `= 21` | 一致 |
| 最新マイグレーション version: 21 | db-migrations.ts L967 | 一致 |
| kill-session L92-99 の delete 呼び出し | route.ts L92-99 | 一致 |
| worktree-db.ts L93-94 サブクエリ | worktree-db.ts L93-94 | 一致 |
| worktree-db.ts L208-209 サブクエリ | worktree-db.ts L208-209 | 一致 |
| getMessages 位置パラメータ5個 (変更前) | chat-db.ts L172-178 | 一致 |
| deleteAllMessages: void 戻り値 (変更前) | chat-db.ts L248-251 | 一致 (設計書は変更後を記述) |
| deleteMessagesByCliTool: number 戻り値 | chat-db.ts L296-308 | 一致 |
| ChatMessage に archived なし (変更前) | models.ts L181-204 | 一致 |
| WebSocket messagesCleared フィールド | kill-session/route.ts L107 | 一致 |
| HistoryPaneProps 構造 (変更前) | HistoryPane.tsx L35-50 | 一致 |
| db.ts バレルファイルのエクスポート | db.ts L37-52 | 一致 |

---

## Conclusion

設計書は現行コードベースを正確に参照しており、行番号・関数シグネチャ・マイグレーションバージョン・UIコンポーネント構造の全てで高い整合性が確認された。must_fix 5件のうち4件は「まだ実装されていない変更点」であり、設計書が変更後の姿を記述していることによる差分である。実質的な設計上の問題は CR2-010（getMessageById の変更漏れ）のみであり、設計品質は高いと評価する。
