# Issue #716 仮説検証レポート

## 概要

Issue #716（HistoryPane メッセージテキスト検索機能追加）の本文に記載された技術的事実主張をコードベースと照合した結果。

## 検証結果サマリー

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | HistoryPane (`src/components/worktree/HistoryPane.tsx`) は検索UI/フィルタ機能を持たない | **Confirmed** |
| 2 | `useConversationHistory` でグループ化した `pairs` を `ConversationPairCard` で表示している | **Confirmed** |
| 3 | ターミナル出力検索の参考実装が存在する: `TerminalSearchBar.tsx`, `useTerminalSearch.ts`, `terminal-highlight.ts` | **Confirmed** |
| 4 | `useTerminalSearch` は debounce 300ms、最大500件、最小2文字 | **Confirmed** |
| 5 | `terminal-highlight.ts` は CSS Custom Highlight API ラッパー（XSS安全） | **Confirmed** |
| 6 | **履歴本体は `ChatMessage[]` を `ConversationPairCard` 内で Markdown レンダリングしている** | **Rejected（重要）** |
| 7 | CLIタブ切替時に `clearMessages()` が走る | **Confirmed** |
| 8 | `HistoryPane` には `scrollContainerRef` でスクロール位置を保持するロジックがある | **Confirmed** |
| 9 | `WorktreeDetailSubComponents.tsx` の `MobileContent` から `HistoryPane` が呼ばれており、props 伝播が必要 | **Confirmed** |
| 10 | Issue #701 で `historyDisplayLimit` / `showArchived` の props 伝播パターンが確立されている | **Confirmed** |

## 検証詳細

### #1: HistoryPane に検索機能なし — Confirmed

`src/components/worktree/HistoryPane.tsx`（1〜332行）を全文確認。
- 検索バー、検索input、検索state（query, matchCount等）の実装なし。
- ヘッダーには `Show archived` チェックボックス（Issue #168）と `History display limit` セレクト（Issue #701）のみ存在。

### #2: useConversationHistory + ConversationPairCard 構造 — Confirmed

`HistoryPane.tsx:211`:
```ts
const { pairs, isExpanded, toggleExpand } = useConversationHistory(messages);
```
`HistoryPane.tsx:254-269` で `pairs.map((pair) => <ConversationPairCard ... />)` を実行。仕様通り。

### #3-#5: TerminalSearchBar / useTerminalSearch / terminal-highlight.ts — Confirmed

- `src/hooks/useTerminalSearch.ts`:
  - `TERMINAL_SEARCH_MAX_MATCHES = 500`（21行）
  - `DEBOUNCE_MS = 300`（24行）
  - 最小2文字チェック（79行: `if (searchQuery.length < 2 || ...)`）
  - indexOf による検索（no RegExp、SEC-TS-001）
- `src/lib/terminal-highlight.ts`:
  - `isCSSHighlightSupported()` で CSS Custom Highlight API 検出
  - `applyTerminalHighlights()` でハイライト適用、`scrollIntoView({ block: 'center' })`
  - CSS Custom Highlight 未対応ブラウザは fallback overlay（DOM変更なし、XSS安全）

### #6: Markdown レンダリング — **Rejected（重要な事実誤認）**

Issue本文（実装方針 4.）:
> Markdownレンダリング後DOMへのハイライトのため、以下のいずれかを採用する：

**実コード**（`ConversationPairCard.tsx:301`）:
```tsx
<div className="text-sm text-gray-200 whitespace-pre-wrap break-words [word-break:break-word] max-w-full overflow-x-hidden">
  <MessageContent content={displayContent} onFilePathClick={onFilePathClick} />
  {!isExpanded && isTruncated && (
    <span className="text-gray-500">...</span>
  )}
</div>
```

`MessageContent` 実装（`ConversationPairCard.tsx:134-167`）:
- `parseContentParts()` でファイルパス正規表現 `FILE_PATH_REGEX` に基づき content を text/path に分割
- text 部は `<span>{part.content}</span>` で純テキストとしてレンダリング
- path 部は `<button>` 化（ファイルクリック対応）
- `react-markdown` などのMarkdownレンダリングは**使用していない**（grep結果でゼロ件確認済み）

**影響**:
- 検索ハイライトは「Markdown レンダリング後の DOM」ではなく「単純な `<span>` + `<button>` で構成された DOM」に対して適用される
- `terminal-highlight.ts` がそのまま流用可能（CSS Custom Highlight API は textContent ベースで動作）
- Issue 本文の「DOMトラバースで `<mark>` を挿入」または「`<mark>` フォールバック」言及は再検討が必要 — 実態としては `terminal-highlight.ts` のCSS Highlight + fallback overlay 方式と同じ設計でよい
- 「Markdownレンダリングを正規表現で再パースする」「textノードを `<mark>` で置換する」等の複雑な処理は**不要**

**Stage 1 レビューへの申し送り**:
- Issue 本文の「実装方針 4.」セクションの記述を、実際の `MessageContent`（pre-wrap + ファイルパス分割）に合わせて修正する必要がある
- 採用方針として CSS Custom Highlight API（`terminal-highlight.ts` パターン）が第一選択になることを明記

### #7: clearMessages on タブ切替 — Confirmed

`WorktreeDetailRefactored.tsx:547-550`:
```ts
if (prevCliTabRef.current !== activeCliTab) {
  prevCliTabRef.current = activeCliTab;
  actions.clearMessages();
  ...
}
```
worktreeId切替時（`:360-369`）、kill-session時（`:812`）にも `clearMessages()` が呼ばれる。検索状態もこれらのタイミングでクリアする必要がある。

### #8: scrollContainerRef のスクロール位置保持 — Confirmed

`HistoryPane.tsx:177-208`:
- `scrollPositionRef` に scrollTop を保存
- `useLayoutEffect` で `messages.length === prevCount` のときに scrollTop を復元

検索でジャンプする際は `element.scrollIntoView({ block: 'center' })` を使用するが、復元ロジック（messages.length変化なし時）と競合する可能性があるため、検索アクティブ時はスキップする方針が妥当（Issue 本文の留意点と一致）。

### #9: MobileContent から HistoryPane 呼出 — Confirmed

`WorktreeDetailSubComponents.tsx:972-984`:
```tsx
<ErrorBoundary componentName="HistoryPane">
  <HistoryPane
    messages={messages}
    worktreeId={worktreeId}
    onFilePathClick={onFilePathClick}
    className="flex-1 min-h-0"
    showToast={showToast}
    onInsertToMessage={onInsertToMessage}
    showArchived={showArchived}
    onShowArchivedChange={onShowArchivedChange}
    historyDisplayLimit={historyDisplayLimit}
    onHistoryDisplayLimitChange={onHistoryDisplayLimitChange}
  />
</ErrorBoundary>
```
モバイル版も同じ `HistoryPane` を使用しているため、検索バーはここでも自動的に動作する。追加のpropsを `MobileContent` に伝播する必要があるかは設計次第（`HistoryPane` 内部で完結させるか、外部から制御するか）。

### #10: Issue #701 の props 伝播パターン — Confirmed

`WorktreeDetailRefactored.tsx:310-333` で `historyDisplayLimit` を localStorage 永続化、`HistoryPane` および `MobileContent` 経由で伝播するパターンが確立されている。検索状態も同パターンを採用するか、HistoryPane 内部 state で完結させるかは Stage 1 レビューで議論する。

## Stage 1 への申し送り

1. **Rejected #6**: Issue 本文の「Markdownレンダリング後DOMへのハイライト」記述が事実誤認。実装方針 4. の選択肢 (A)/(B) の説明を修正し、`terminal-highlight.ts` のCSS Highlight API 流用を主軸に据える。
2. **Confirmed #7**: `clearMessages()` 起点は3箇所（worktreeId切替、CLIタブ切替、kill-session）。検索状態のクリアタイミングを明示すべき。
3. **検討事項**: 検索バーは `HistoryPane` 内部 state にするか、`WorktreeDetailRefactored` から props で制御するか（Issue #701 の限り、内部 state でも十分ワークしうる）。
