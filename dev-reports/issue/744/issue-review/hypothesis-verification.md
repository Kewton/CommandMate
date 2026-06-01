# Issue #744 仮説検証レポート（Phase 0.5）

Issue種別: 機能追加（PC専用UI、#728 follow-up）。仮説そのものは少ないが、設計の前提として **現状アーキテクチャに関する事実主張** を多数含むため、それらをコードベースと照合した。

## 検証サマリー

| # | Issueの主張（前提/仮説） | 判定 | 補足 |
|---|--------------------------|------|------|
| 1 | `WorktreeDetailRefactored.tsx` が `historyPaneMemo` を `<TerminalContainer history=...>` に渡す | **Confirmed** | L1717-1749 で memo 構築、L1813-1816 で `history={historyPaneMemo} terminal={rightPaneSplitMemo}` |
| 2 | `TerminalContainer.tsx` が `history` prop を受け取り `useHistoryPaneState()` で visible/width 管理し HistoryPane を描画 | **Confirmed** | props L38-43、`useHistoryPaneState()` L92、レイアウト L108-137 |
| 3 | `HistoryPane.tsx` が `state.messages` を受け取り `useConversationHistory(messages)` で表示。**cliToolId prop は未実装** | **Confirmed** | props L48-79（cliToolId なし）、`useConversationHistory(messages)` L197、フィルタは archived/historyUserOnly のみ L205-215 |
| 4 | `TerminalSplitPaneContent.tsx` が per-(worktreeId, cliToolId) で `useTerminalPanePolling` を駆動。HistoryPane は未描画 | **Confirmed** | polling L116-127、terminal slot=TerminalDisplay L203-222、footer slot=AutoYes/Nav/Prompt/MessageInput L224-289。HistoryPane 描画なし |
| 5 | `chat-db.ts` `getMessages` が `cliToolId` フィルタ対応 | **Confirmed** | `GetMessagesOptions.cliToolId` L19-25、SQL `AND cli_tool_id = ?` L206-209 |
| 6 | `ChatMessage` 型に `cliToolId` フィールドあり | **Confirmed** | `src/types/models.ts` L233 `cliToolId?: CLIToolType`。`CLIToolType` は `src/lib/cli-tools/types.ts` L10-16（6ツール union） |
| 7 | **「state.messages は全CLIのメッセージを保持しているため、UI側フィルタで十分・バックエンド変更不要」** | **❌ Rejected（重大）** | 下記参照 |
| 8 | `TerminalSplitPane.tsx` は `headerExtras`/`terminal`/`footer` slot を公開 | **Confirmed** | props L23-42 |
| 9 | `useHistoryPaneState` は全split共通（単一グローバル）であり MVP は共通挙動で進められる | **Confirmed（ただし設計含意あり）** | 引数なし、localStorage キー固定、CustomEvent で2インスタンス同期。per-split 化は別途必要なら拡張 |

## 重大な指摘: 主張#7 は Rejected

### Issueの主張
> 現状 `state.messages` は全メッセージを保持しているため、UI側でのフィルタで十分。バックエンド変更不要。

### コードベースの事実
`WorktreeDetailRefactored.tsx` の `fetchMessages` (L472-497):

```ts
const requestedCliTool = activeCliTabRef.current;
const params = new URLSearchParams({ cliTool: requestedCliTool });
...
const response = await fetch(`/api/worktrees/${worktreeId}/messages?${params.toString()}`);
...
actions.setMessages(parseMessageTimestamps(data));
```

- `state.messages` は **`activeCliTab` で既にサーバ側フィルタ済み**（`/api/worktrees/[id]/messages` → `getMessages(db, id, { cliToolId })` L60）。
- つまり `state.messages` は「全CLI」ではなく「**現在アクティブなCLIタブの1種類のみ**」を保持している。

### 設計への影響（Must Fix 級）
受入条件「スプリットA=Claude, B=Codex の構成で、A History は Claude のみ / B History は Codex のみ（**同時に**）」を、`state.messages` を `cliToolId` でクライアントフィルタする方式では **満たせない**。`state.messages` には activeCliTab（=1種類）の messages しか入っていないため、もう一方の split は空になる。

### 正しい設計方針（#728 アーキテクチャと整合）
#728 で確立された「各 split が `useTerminalPanePolling({worktreeId, cliToolId})` で **自分の cliToolId のメッセージ/出力を独立 fetch**」する設計に合わせ、**per-split History も各 split が自分の cliToolId で messages を独立 fetch** すべき。

- 案A-1（推奨）: 各 split 用に messages を独立取得するフック（例: `useSplitMessages({worktreeId, cliToolId})` ＝ `/api/worktrees/[id]/messages?cliTool=<paneCli>` を fetch）を新設し、`TerminalSplitPaneContent` 内の HistoryPane に渡す。これは #728/#736 の per-split polling と同型。
- 案A-2（非推奨）: 親で全CLI分の messages をまとめて fetch（cliTool パラメータを外す）し UI フィルタ。ただし `fetchMessages` の activeCliTab フィルタ・履歴表示件数（#701）・User only（#725）・検索（#716）と整合させる改修が広範になり、Issue の「バックエンド変更不要」という前提も崩れる。

→ **Stage 1 への申し送り**: Issue 本文の「対応方針 §6 メッセージfetch」と「§3 の messages props 流用」記述を、**per-split 独立 fetch** 方式へ修正する必要がある。受入条件「A=Claude/B=Codex を同時表示」と現行 `state.messages`（activeCliTab フィルタ済み）の矛盾を明示すべき。

## その他の申し送り

- **検索 #716 / User only #725 / 表示件数 #701 の per-split 動作**: これらは現状 `HistoryPane` 内部 state ＋ 一部 `WorktreeDetailRefactored` の props（historyUserOnly/historyDisplayLimit/showArchived）で制御されている。per-split History にした場合、これらの状態を per-split で持つのか共通にするのかを Issue で明確化すべき（MVP は共通でも、表示件数 limit は fetch クエリに効くため per-split fetch なら各 split で limit 指定が要る）。
- **`useHistoryPaneState` の折りたたみ/幅**: 主張#9 の通りグローバル単一。MVP「全split共通折りたたみ」は実現可能だが、Issue After 図では「各 split 内に History を内包」するため、グローバル visible=false 時に全 split の History が同時に消える挙動になる。Issue 記載通りで問題ないが、レイアウト的に各 split 内で `<` を押すと全 split が畳まれる点はUX申し送りとして残す。
