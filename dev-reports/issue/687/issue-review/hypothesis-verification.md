# Issue #687 仮説検証レポート

## 検証対象

Issue #687「MessageHistoryに日付も表示してほしい」に記載された仮説・前提条件をコードベースで検証。

---

## 仮説・前提条件の検証結果

| # | 仮説/主張 | 判定 | 詳細 |
|---|----------|------|------|
| 1 | `ConversationPairCard.tsx` で `toLocaleTimeString()` を使用し時刻のみ表示される | **Confirmed** | L211, L278 で `message.timestamp.toLocaleTimeString()` を使用 |
| 2 | `MessageList.tsx` / `PromptMessage.tsx` は `format(timestamp, 'PPp', { locale })` で日付+時刻表示 | **Confirmed** | `MessageList.tsx:66`, `PromptMessage.tsx:74` に同パターン確認 |
| 3 | `formatMessageTimestamp` 関数が `date-utils.ts` に存在しない | **Confirmed** | `date-utils.ts` には `formatRelativeTime` のみ存在 |
| 4 | `date-utils.ts` は `date-fns` の `formatDistanceToNow` を使用している | **Confirmed** | import文に `formatDistanceToNow` のみ確認 |

---

## 検証詳細

### 仮説1: ConversationPairCard.tsx の toLocaleTimeString() 使用

```typescript
// L210-213 (UserMessageSection)
const formattedTime = useMemo(
  () => message.timestamp.toLocaleTimeString(),
  [message.timestamp]
);

// L277-280 (AssistantMessageItem)
const formattedTime = useMemo(
  () => message.timestamp.toLocaleTimeString(),
  [message.timestamp]
);
```
→ **完全一致。Issueの記載通り。**

### 仮説2: MessageList.tsx / PromptMessage.tsx の format 使用

```typescript
// MessageList.tsx:66
const timestamp = format(new Date(message.timestamp), 'PPp', { locale: dateFnsLocale });

// PromptMessage.tsx:74
const timestamp = format(new Date(message.timestamp), 'PPp', { locale: dateFnsLocale });
```
→ **完全一致。参考実装として適切。**

### 仮説3: date-utils.ts に formatMessageTimestamp が存在しない

`date-utils.ts` の関数：`formatRelativeTime` のみ
→ **formatMessageTimestamp は未実装。追加が必要。**

---

## Stage 1 への申し送り事項

- 全仮説が確認済みのため、Issueの記述に誤りはない
- `MessageList.tsx:603` でも `new Date().toLocaleTimeString()` が使われているが（UIのリアルタイム時刻表示）、これは今回の対象外の可能性がある点を確認すること
- `date-utils.ts` への `formatMessageTimestamp` 追加時、`format` の import 追加も必要
