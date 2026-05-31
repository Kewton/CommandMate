# Issue #740 仮説検証レポート

対象: `fix(terminal): missing AutoYesToggle in PC per-split footer (#728 follow-up)`

検証日: 2026-05-31 / ブランチ: `feature/740-worktree`

---

## 検証サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | PC版の per-split footer に AutoYesToggle が存在しない | **Confirmed** | `TerminalSplitPaneContent.tsx:161-213` footer に AutoYesToggle 描画なし |
| 2 | `TerminalSplitPaneContent` footer に AutoYesToggle がない | **Confirmed** | 同上。footer は NavigationButtons / PromptPanel / MessageInput のみ |
| 3 | Mobile版にのみ AutoYesToggle が存在 | **Confirmed** | `WorktreeDetailRefactored.tsx:1897-1903`（Mobile経路）に存在 |
| 4 | useAutoYes が `activeCliTab` 単一キーで管理され、3独立状態が無い | **Partially Confirmed（不正確）** | enabled/expiresAt は既に **per-CLI Map**（`autoYesStateMap`, L218）で保持。ただし **更新（toggle/poll同期）が activeCliTab スコープ** |
| 5 | 案A の `useAutoYes({worktreeId, cliToolId})` が `autoYesEnabled / autoYesExpiresAt / toggleAutoYes` を返す | **Rejected** | `useAutoYes` の戻り値は `{ lastAutoResponse }` のみ（`useAutoYes.ts:42-45,115`）。enabled/expiresAt/toggle は返さない |

---

## 詳細検証

### 仮説1・2: AutoYesToggle が PC split footer / TerminalSplitPaneContent に無い → **Confirmed**

`src/components/worktree/TerminalSplitPaneContent.tsx:161-213` の `footerSlot`:

```tsx
const footerSlot = useMemo(() => (
  <div className="space-y-2">
    {showNav ? <NavigationButtons .../> : null}
    {showPrompt ? <PromptPanel .../> : null}
    <MessageInput .../>
  </div>
), [...]);
```

→ AutoYesToggle は描画されていない。Issue の主張どおり。

補足: 当コンポーネントは既に `autoYesEnabled?: boolean` prop を**受け取って**おり（L60,74）、`showPrompt = prompt.visible && !autoYesEnabled`（L138）で PromptPanel 抑制に使用済み。つまり「enabled の受け渡し」は既に存在し、**不足しているのはトグルUIとトグル操作**である。

### 仮説3: Mobile版に AutoYesToggle → **Confirmed**

`src/components/worktree/WorktreeDetailRefactored.tsx:1897-1903`（`if (!isMobile) return ...` の後段=Mobile経路）:

```tsx
<AutoYesToggle
  enabled={autoYesEnabled}
  expiresAt={autoYesExpiresAt}
  onToggle={handleAutoYesToggle}
  lastAutoResponse={lastAutoResponse}
  cliToolName={activeCliTab}
  inline
/>
```

### 仮説4: 「activeCliTab 単一キー管理」 → **Partially Confirmed（要修正）**

実コードでは **per-CLI Map** で複数CLIの状態を同時保持している:

- `WorktreeDetailRefactored.tsx:218`
  `const [autoYesStateMap, setAutoYesStateMap] = useState<Map<string, {enabled, expiresAt}>>(new Map())`
- `L264-265`: 表示用 `autoYesEnabled/autoYesExpiresAt` は `autoYesStateMap.get(activeCliTab)` から導出
- `L1450`: 各 split は既に `paneAutoYesEnabled = autoYesStateMap.get(paneCli)?.enabled` を取得し `TerminalSplitPaneContent` に渡している（L1467）

したがって「3独立状態が無い」は不正確。**enabled 状態自体は既に per-CLI で追跡され各 split に配布済み**。真の欠落は:

1. **トグルUI（AutoYesToggle）が split footer に無い**
2. **`handleAutoYesToggle`（L810-835）が `cliToolId: activeCliTab` をハードコード** → 非アクティブ split の CLI を ON/OFF できない
3. **サーバー同期の偏り**: 親ポーリング `fetchCurrentOutput`（L501-559）は `autoYesStateMap` を `activeCliTab`（=split0）の分しか更新しない（L540-544）。`useTerminalPanePolling` は Auto-Yes を**意図的に保持しない**（`useTerminalPanePolling.ts:15-18`）

### 仮説5: 案A のコードスニペット → **Rejected（実装不能）**

Issue 案A は以下を提示:
```tsx
const { autoYesEnabled, autoYesExpiresAt, lastAutoResponse, toggleAutoYes } =
  useAutoYes({ worktreeId, cliToolId });
```

しかし `useAutoYes`（`src/hooks/useAutoYes.ts`）の実シグネチャは:
- 入力: `{ worktreeId, cliTool, isPromptWaiting, promptData, autoYesEnabled, lastServerResponseTimestamp?, serverPollerActive? }`
- 出力: `{ lastAutoResponse }` のみ（L42-45, L115）

`useAutoYes` は**クライアント側 auto-response 専用フック**であり、enabled/expiresAt の状態管理も toggle 操作も持たない。状態は親の `autoYesStateMap` と `handleAutoYesToggle`（→ `POST /api/worktrees/[id]/auto-yes`）と親ポーリング同期に分散している。

→ 案A の通りに実装すると **コンパイルエラー / 機能不全**になる。実装方針の修正が必要。

---

## Stage 1 レビューへの申し送り事項

1. **案A のコードスニペットは実APIと不一致**。`useAutoYes` は enabled/expiresAt/toggle を返さない。受入条件は維持しつつ、実装方針を「親が `autoYesStateMap` を保持し、各 split に per-CLI の `onToggle`/`expiresAt`/`lastAutoResponse` を配布」へ修正すべき。
2. **`handleAutoYesToggle` の cliToolId パラメータ化**が必須（現状 `activeCliTab` ハードコード）。これが想定影響範囲表に明示されていない。
3. **非アクティブ split のサーバー同期ギャップ**（expiry/stop-pattern が反映されない可能性）を受入条件 or スコープ外に明記すべき。AutoYesToggle の countdown は `expiresAt` からクライアント側で算出（`AutoYesToggle.tsx:56-69`）されるため**表示上のカウントダウンは動作**するが、サーバー主導の stop 遷移は非アクティブ split に届かない。
4. **client-side auto-response（`useAutoYes`）の per-split 化要否**: 受入条件には「PromptPanel 非表示」までしか求めていない。実応答は Issue #501 のサーバー側 poller（`serverPollerActive`）が担うため、per-split の client-side `useAutoYes` は必須でない可能性。スコープを明確化すべき。
