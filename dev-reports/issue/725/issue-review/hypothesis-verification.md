# Issue #725 仮説検証レポート

対象: HistoryPane の User/Assistant 視覚優先度改善

## 抽出した仮説/前提条件

| # | 種別 | 主張 | 出典 |
|---|------|------|------|
| H1 | 前提 | `UserMessageSection` (行 218) は `bg-blue-900/30 border-l-4 p-3 / text-sm`、truncate なし | Issue 「現状」表 |
| H2 | 前提 | `AssistantMessagesSection` (行 349) は `bg-gray-800/50 border-l-4 p-3 / text-sm`、`COLLAPSED_MAX_LINES = 5`、`COLLAPSED_MAX_CHARS = 300` で truncate | Issue 「現状」表 |
| H3 | 原因 | `COLLAPSED_MAX_LINES = 5` が緩い（5行 + ラベル + タイムスタンプ + "..." 表示で実質7-8行分の高さ）| Issue 「根本原因」 |
| H4 | 原因 | 1ペア内に複数 Assistant メッセージがあると `space-y-3` で積み上がる | Issue 「根本原因」 |
| H5 | 原因 | User と Assistant が同じ `p-3` / `text-sm` で視覚的優先度の差がない | Issue 「根本原因」 |
| H6 | 前提 | `HISTORY_DISPLAY_LIMIT_STORAGE_KEY` の localStorage 永続化パターンが既存にある | Issue 「実装方針」 |
| H7 | 前提 | `commandmate:showArchived` の localStorage 永続化トグルパターンが既存にある | Issue 「関連」 |
| H8 | 前提 | `ConversationPair.status === 'orphan'` で Assistant のみの孤立メッセージが表現される | Issue 「実装方針 3.4」 |
| H9 | 前提 | `ConversationPairCard.tsx` / `HistoryPane.tsx` / `history-display-config.ts` / 関連テストファイルが現に存在する | Issue 「想定影響範囲」 |

## 検証結果

| # | 判定 | 検証根拠 |
|---|------|---------|
| H1 | **Confirmed** | `src/components/worktree/ConversationPairCard.tsx:218,225` — `bg-blue-900/30 border-l-4 border-blue-500 p-3` / `text-sm text-gray-200 whitespace-pre-wrap break-words`、truncate なし（全文 `MessageContent` に渡される） |
| H2 | **Confirmed** | 同 `:349,306,57,60` — `bg-gray-800/50 border-l-4 border-gray-600 p-3 ... space-y-3`、`text-sm`、`COLLAPSED_MAX_CHARS = 300`、`COLLAPSED_MAX_LINES = 5` |
| H3 | **Partially Confirmed** | 定数 5 行は事実だが「実質 7-8 行分」は実測ではなく推測の表現。Assistant ヘッダ（ラベル + タイムスタンプ）は `flex items-center gap-2 mb-1` の1行、本文5行、"..." 1行の計 約7行は概ね妥当。UI 設計判断としては数字の前後（例: 2-3）が妥当か実機で要確認 |
| H4 | **Confirmed** | `:349` `space-y-3`、`:350-367` でメッセージ毎に `AssistantMessageItem` を `React.Fragment` で繰り返し描画 |
| H5 | **Confirmed** | User (`:218,225`) と Assistant (`:349,306`) 共に `p-3` / `text-sm`。Tailwind トーン差（blue-900/30 vs gray-800/50）はあるが情報階層を示す差は弱い |
| H6 | **Confirmed** | `src/config/history-display-config.ts:47` で `HISTORY_DISPLAY_LIMIT_STORAGE_KEY = 'commandmate:historyDisplayLimit'`、`src/components/worktree/WorktreeDetailRefactored.tsx:99,313,324` で localStorage 連携 |
| H7 | **Confirmed** | `WorktreeDetailRefactored.tsx:295-307` — `commandmate:showArchived` を localStorage で永続化する既存パターン（state + useEffect setItem）あり |
| H8 | **Confirmed** | `src/types/conversation.ts:15-29` で `ConversationStatus = 'pending' \| 'completed' \| 'orphan'`、`ConversationPair` の `userMessage` は nullable（orphan は user 無し） |
| H9 | **Confirmed** | 以下すべて存在:<br>- `src/components/worktree/ConversationPairCard.tsx`<br>- `src/components/worktree/HistoryPane.tsx`<br>- `src/config/history-display-config.ts`<br>- `src/components/worktree/__tests__/ConversationPairCard.test.tsx`<br>- `src/components/worktree/__tests__/HistoryPane.integration.test.tsx` |

## Stage 1 への申し送り事項

- H3 のみ Partially。指摘事項というよりは UI 数値選定（COLLAPSED_MAX_LINES 候補値）の妥当性検討が必要。実装時にスクリーンショット比較で 2 vs 3 行を要検証。
- 他はすべて Confirmed のため、Issue 本文の「現状の問題」「実装方針」セクションは事実関係に基づく。
- Issue が提示する 案A/案B/案C は互いに独立しており、段階的にコミット可能。案A は最小工数で最大効果が期待できる。
- `WorktreeDetailRefactored.tsx` で `showArchived` は親が state を持ち子に props として渡している。案C の userOnly トグルも同パターン（親持ち＋props 伝播）が一貫性高い。Issue は `HistoryPane.tsx` 内に state を置く実装例を示しているが、これは設計選定で要検討（Stage 1 で論点化候補）。
