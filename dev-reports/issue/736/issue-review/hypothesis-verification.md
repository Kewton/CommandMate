# Issue #736 仮説検証レポート

Issue #736 はリファクタリングIssueであり、コードベースに対する事実主張（前提条件）を多数含む。各主張をコードと照合した結果を記す。

| # | 主張（Assumption / 前提） | 判定 | 根拠 |
|---|--------------------------|------|------|
| 1 | PC経路は `useTerminalPanePolling` 方式に移行済み | **Confirmed** | `useTerminalPanePolling` は `TerminalSplitPaneContent.tsx` / `WorktreeDetailRefactored.tsx` で使用。PC経路は `renderSplitPane` → `TerminalSplitPaneContent` 委譲（#728） |
| 2 | `state.terminal.*` reducer slice が二重実装として残置 | **Confirmed** | `grep -rn "state.terminal" src/` で16件。`useWorktreeUIState.ts`（reducer）, `WorktreeDetailRefactored.tsx`（mobile描画+polling gating）, `TerminalSplitPaneContent.tsx`（コメントのみ） |
| 3 | Mobile経路は旧方式（`state.terminal.*`）を消費 | **Confirmed** | `WorktreeDetailRefactored.tsx` L1986-2008 で `MobileContent` に `state.terminal.output/isActive/isThinking/autoScroll` を渡す。`MessageInput` L2044 も `isSessionRunning={state.terminal.isActive}` |
| 4 | `TerminalState` 型は `src/types/ui-state.ts` に定義 | **Confirmed** | L25 `export interface TerminalState`、L154 `terminal: TerminalState`、L170 `initialTerminalState`、L221 `createInitialUIState` |
| 5 | `SET_TERMINAL_*` action は `src/types/ui-actions.ts` に定義 | **Confirmed（ただし3種）** | L22 `SET_TERMINAL_OUTPUT`, L23 `SET_TERMINAL_ACTIVE`, L24 `SET_TERMINAL_THINKING`。**注: `autoScroll` は `SET_TERMINAL_*` ではなく別系統 action（`setAutoScroll`）で管理**（要確認） |
| 6 | 影響ファイル（テスト3件）が存在 | **Confirmed** | `WorktreeDetailRefactored-cli-tab-switching.test.tsx`, `useWorktreeUIState.test.ts`, `WorktreeDetailRefactored.test.tsx` すべて存在 |
| 7 | `useTerminalPanePolling` は output/isActive/isThinking/prompt/selectionList/attaching/autoScroll を提供 | **Confirmed** | hook JSDoc + `PaneTerminalState`/`PanePromptState` 型で確認 |

## 申し送り事項（Stage 1 レビューへ）

Issueのpseudocodeは `state.terminal.*` の削除を単純化して描いているが、実コードでは以下の**追加考慮点**が存在する。Stage 1（通常）/ Stage 3（影響範囲）で精査すべき:

1. **`fetchCurrentOutput`（L501-567）は `state.terminal.*` 以外も駆動する**: `state.prompt`（showPrompt/clearPrompt）, `isSelectionListActive`, Auto-Yes state（autoYesStateMap, lastServerResponseTimestamp, serverPollerActive, stopReason）。これらは Issue scope（`state.terminal.*` のみ削除）外。mobile が hook 化された後、parent の `fetchCurrentOutput` のうち terminal 部分のみ除去し、prompt/auto-yes 部分は残す必要がある。

2. **親ポーリングループ（L1353-1367）が `state.terminal.isActive` で間隔を gate**: 削除後は代替の gating（固定間隔 or 別ソース）が必要。

3. **二重ポーリング懸念**: mobile が `useTerminalPanePolling`（/current-output を独立 fetch）を使うと、親の `fetchCurrentOutput`（auto-yes 用に継続）と合わせ /current-output が二重 fetch される。PC経路は既にこの構造（親 fetchCurrentOutput + per-split hook）なので整合はするが、Issueに明記すべき。

4. **`MessageInput isSessionRunning={state.terminal.isActive}`（L2044）**: 代替ソース（hook の isActive/isRunning）が必要。

5. **CLIタブ切替 effect（L605-619）が `setTerminalOutput('','')` 等を呼ぶ**: slice 削除に伴い除去が必要。hook は worktreeId/cliToolId 変化で自前リセットするため整合。

6. **`autoScroll` の扱い**: `state.terminal.autoScroll` は `SET_AUTO_SCROLL`（要確認: action 名）で管理。hook 化後は hook 内 autoScroll に移譲。`handleAutoScrollChange`（L811 `actions.setAutoScroll`）の扱いを明確化。

7. **prompt slice（`state.prompt`）の去就**: Issue scope は `state.terminal.*` のみ。mobile prompt が hook に移ると `state.prompt` も実質 mobile-only の dead code 化しうるが、削除はscope外として明示すべき（あるいは hook 化せず parent 駆動を維持する設計判断が必要）。
