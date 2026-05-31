# Issue #736 作業計画書

**Issue**: refactor(terminal): remove state.terminal.* reducer slice by migrating Mobile to useTerminalPanePolling (#728 R3-007 + R3-010)
**ブランチ**: feature/736-worktree
**作成日**: 2026-05-31（Issueレビュー反映後）

## ゴール

Mobile 経路の terminal 表示を `useTerminalPanePolling` に移行し、`state.terminal.*` reducer slice（型・action・reducer case・action creator）を完全削除する。挙動はPC/Mobile共に不変（behavior-preserving refactor）。

## 設計判断（Issueレビュー M2 を踏まえた確定方針）

`prompt`（`state.prompt`）と `isSelectionListActive`（独立 `useState`）は **`state.terminal` の一部ではない** → 本Issueでは触らず、引き続き parent `fetchCurrentOutput` 駆動を維持。
削除対象 `state.terminal.*`（output/realtimeSnippet/isActive/isThinking/autoScroll/lastUpdated）の各 consumer に対し、以下の新ソースを割り当てる:

| 旧ソース | 用途 | 新ソース |
|----------|------|----------|
| `state.terminal.output/isActive/isThinking/autoScroll` | Mobile terminal タブ表示 | 新 `MobileTerminalTab` 内 `useTerminalPanePolling({worktreeId, cliToolId})`（**mobile-only マウント** → PC二重polling回避） |
| `state.terminal.isActive` | `MessageInput isSessionRunning`（parent mobile） | `worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning ?? false` |
| `state.terminal.isActive` | 親ポーリング cadence gate（L1356/L1367） | 派生 `activeCliRunning = worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning ?? false` |
| `state.terminal.autoScroll` + `handleAutoScrollChange` | Mobile autoScroll | hook の `terminal.autoScroll` + `setAutoScroll`（`MobileTerminalTab` 内） |

**重要**: hook 実シグネチャは `useTerminalPanePolling({ worktreeId, cliToolId, enabled? })` で **splitIndex 引数なし**（Issue擬似コードの `splitIndex:0` は誤り）。

## タスク分解と依存関係

```
T1(tests-first) ─┐
                 ├─> T2(mobile hook) ─> T3(parent cleanup) ─> T4(slice deletion) ─> T5(comment cleanup) ─> T6(green: all tests) ─> T7(docs)
T1 で red を確認 ─┘
```

実装順序は「置換が先・削除が後」。action creator を参照したまま削除するとコンパイルエラーになるため、T2/T3 で全参照を置換 → T4 で slice/action/creator を削除。

### T1: テスト先行（Red）
- `tests/unit/hooks/useWorktreeUIState.test.ts`: terminal slice（SET_TERMINAL_OUTPUT/ACTIVE/THINKING/SET_AUTO_SCROLL）と複合action（START_WAITING_FOR_RESPONSE/RESPONSE_RECEIVED/SESSION_ENDED）の assertion を削除。`createInitialUIState` から `terminal` を期待しないよう更新。
- `tests/unit/components/worktree/WorktreeDetailRefactored-cli-tab-switching.test.tsx`: **R3-010 完全書き直し**。`useTerminalPanePolling` をモックし、CLI切替時に新しい `{worktreeId, cliToolId}` で hook が再マウント/reset されること、stale CLI の表示が残らないことを検証。`mockIsMobile=false`（PC経路）維持。
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: `state.terminal` 参照を含む mock 戦略を更新。

### T2: Mobile terminal 表示の hook 移行
- `src/components/worktree/WorktreeDetailSubComponents.tsx`:
  - `MobileContentProps` に `cliToolId: CLIToolType` 追加。`terminalOutput/isTerminalActive/isThinking/autoScroll/onScrollChange` props を削除。
  - `case 'terminal':` を新 `MobileTerminalTab` コンポーネント呼び出しに置換。`MobileTerminalTab` は `useTerminalPanePolling({worktreeId, cliToolId})` を呼び、`TerminalDisplay` に `output={terminal.output} isActive={terminal.isRunning} isThinking={terminal.isThinking} autoScroll={terminal.autoScroll} onScrollChange={setAutoScroll} disableAutoFollow={...}` を渡す。terminal タブ表示時のみ hook マウント。

### T3: Parent 側 state.terminal 参照の置換
- `src/components/worktree/WorktreeDetailRefactored.tsx`:
  - `MobileContent` 呼び出し（L1986-1988, L2008-2009）から terminal props 削除、`cliToolId={activeCliTab}` 追加。
  - `MessageInput isSessionRunning`（L2044）→ `worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning ?? false`。
  - 親ポーリング cadence（L1356/L1367）→ 派生 `activeCliRunning` を使用。
  - `fetchCurrentOutput`（L524/527/528）の `setTerminalOutput/Active/Thinking` 除去（prompt/selection/auto-yes 部分は維持）。
  - worktreeId reset（L426）の `setTerminalOutput('','')` 除去。
  - CLIタブ切替 effect（L610-612）の terminal reset 除去。
  - `handleKillConfirm`（L871-874）の terminal reset 除去。
  - `handleAutoScrollChange`（L809-811）削除（hook に移譲、他参照なしを確認済み）。

### T4: state.terminal slice 削除
- `src/types/ui-state.ts`: `TerminalState` interface、`WorktreeUIState.terminal`、`initialTerminalState`、`createInitialUIState` の `terminal` 削除。
- `src/types/ui-actions.ts`: `SET_TERMINAL_OUTPUT`/`SET_TERMINAL_ACTIVE`/`SET_TERMINAL_THINKING`/`SET_AUTO_SCROLL`/`START_WAITING_FOR_RESPONSE`/`RESPONSE_RECEIVED`/`SESSION_ENDED` union member 削除。
- `src/hooks/useWorktreeUIState.ts`: 上記 reducer case 削除、`initialTerminalState` import 削除、action creator（`setTerminalOutput`/`setTerminalActive`/`setTerminalThinking`/`setAutoScroll`/`startWaitingForResponse`/`responseReceived`/`sessionEnded`）と `WorktreeUIActions` interface member 削除。

### T5: コメント整理（AC: grep==0）
- `src/components/worktree/TerminalSplitPaneContent.tsx` L11/L15、`WorktreeDetailRefactored.tsx` L1436 の `state.terminal.*` を含む doc コメントを更新。

### T6: グリーン確認
- `npx tsc --noEmit` / `npm run lint` / `npm run test:unit` / `npm run build` 全PASS。
- `grep -rn "state\.terminal" src/ tests/` == 0。

### T7: ドキュメント
- `CLAUDE.md` モジュールリファレンス更新（WorktreeDetailRefactored/WorktreeDetailSubComponents/useWorktreeUIState の #736 注記）。
- `CHANGELOG.md` [Unreleased] に refactor エントリ追記。

## 受入条件（Issue準拠）

- [ ] モバイルで terminal 出力表示・CLI切替・Auto-Yes・特殊キーが動作（hook移行後も）
- [ ] `state.terminal.*` 参照 0件（コード+コメント）
- [ ] `terminal` slice / `SET_TERMINAL_*`(+SET_AUTO_SCROLL) / 複合action / 関連 creator 削除
- [ ] `cli-tab-switching.test.tsx` が hook モックベースで書き直し
- [ ] PC経路の動作不変
- [ ] lint / tsc / test:unit / build 全PASS
- [ ] CLAUDE.md / CHANGELOG.md 更新

## リスク

- `WorktreeDetailRefactored.tsx` は ~2000行の中核。terminal 参照除去で他 state（prompt/auto-yes/messages）を誤って壊さないこと。→ 段階的 typecheck で担保。
- `MobileTerminalTab` を terminal タブ表示時のみマウントするため、タブ切替で `attaching` skeleton が一瞬出る（PC同等の挙動、許容）。
