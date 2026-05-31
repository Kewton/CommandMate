# Issue #743 仮説検証レポート (Phase 0.5)

**検証日**: 2026-05-31
**対象**: PC per-split header の AI エージェント status indicator 欠落（#728 follow-up）

## 検証サマリー

| # | 仮説/主張 | 判定 |
|---|----------|------|
| H1 | `TerminalSplitPane.tsx` header に status indicator がない | ✅ Confirmed |
| H2 | `TerminalSplitPaneContent.tsx` から `headerExtras` が渡されていない | ✅ Confirmed |
| H3 | Mobile版（L1947）にのみ status indicator がある | ✅ Confirmed |
| H4 | `deriveCliStatus` は `@/lib/sidebar-utils` にある | ❌ Rejected |
| H5 | `SIDEBAR_STATUS_CONFIG` は `@/config/status-config` にある | ❌ Rejected |
| H6 | `statusConfig.colorClass` でcolor classを参照 | ❌ Rejected |
| H7 | `cliStatus === 'processing'` でspinner判定 | ❌ Rejected |
| H8 | `useWorktreeStatusByCli({ worktreeId, cliToolId })` hookを使う | ❌ Rejected |
| H9 | `<Spinner />` コンポーネントを使う | ❌ Rejected |
| H10 | `worktree.sessionStatusByCli[cliToolId]` 構造 `{isRunning, isWaitingForResponse, isProcessing}` | ✅ Confirmed |
| H11 | `useTerminalPanePolling` から status を取得できる | ❌ Rejected（補足） |
| H12 | `TerminalSplitPane.tsx` は変更不要（既存 headerExtras 流用） | ✅ Confirmed（注記あり） |

**結論**: **根本原因（Root Cause）の診断は100%正確**だが、**「対応方針」セクションのコードサンプルは複数の参照誤り**（誤ったimportパス・存在しないhook/component・誤ったフィールド名・存在しないstatus値）を含む。実装フェーズで誤参照を踏まないよう、Issue本文の対応方針を修正する必要がある。

---

## 詳細検証

### H1: PC側 `TerminalSplitPane.tsx` header に status indicator がない → ✅ Confirmed

`src/components/worktree/TerminalSplitPane.tsx:88-136` の header は確かに:
- `<label class="sr-only">` + `<select>` CLIセレクター（L90-110）
- 検索ボタン（L112-134、`ml-auto` で右寄せ）
- `{headerExtras}`（L135、呼び出し側が `null` → 空）

で構成され、`deriveCliStatus` / `SIDEBAR_STATUS_CONFIG` の import は無い。**正確。**

### H2: `TerminalSplitPaneContent.tsx` が `headerExtras` を渡していない → ✅ Confirmed

`src/components/worktree/TerminalSplitPaneContent.tsx:256-268`:
```tsx
return (
  <TerminalSplitPane
    worktreeId={worktreeId}
    splitIndex={splitIndex}
    cliToolId={cliToolId}
    availableCliTools={availableCliTools}
    onCliToolChange={onCliToolChange}
    onFocus={onFocus}
    attaching={terminal.attaching}
    terminal={terminalSlot}
    footer={footerSlot}
    // headerExtras 未指定
  />
);
```
**正確。**

### H3: Mobile版（L1947）にのみ status indicator → ✅ Confirmed

`src/components/worktree/WorktreeDetailRefactored.tsx:1947-1974` で:
```tsx
const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
// ...
{statusConfig.type === 'spinner' ? (
  <span className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`} title={statusConfig.label} />
) : (
  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`} title={statusConfig.label} />
)}
```
これが流用すべき**正準パターン**。**正確。**

### H4: `deriveCliStatus` の import パス → ❌ Rejected

- **Issue記載**: `import { deriveCliStatus } from '@/lib/sidebar-utils';`
- **実際**: `import { deriveCliStatus } from '@/types/sidebar';`（`src/types/sidebar.ts:32`）

### H5: `SIDEBAR_STATUS_CONFIG` の import パス → ❌ Rejected

- **Issue記載**: `import { SIDEBAR_STATUS_CONFIG } from '@/config/status-config';`
- **実際**: `import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';`（`src/config/status-colors.ts:64`）
- 補足: `src/config/status-config.ts` というファイルは**存在しない**。

### H6: `statusConfig.colorClass` → ❌ Rejected

- **Issue記載**: `statusConfig.colorClass`
- **実際**: `StatusConfig` インターフェース（`status-colors.ts:29-36`）のフィールドは `className` / `label` / `type`。`colorClass` は存在しない。

### H7: `cliStatus === 'processing'` で spinner判定 → ❌ Rejected

- **Issue記載**: `cliStatus === 'processing' ? <Spinner/> : <dot/>`
- **実際**: `deriveCliStatus` の戻り値（`BranchStatus`）は `'idle' | 'ready' | 'running' | 'waiting' | 'generating'`。`'processing'` という値は**存在しない**。
- spinner判定は `statusConfig.type === 'spinner'`（`running`/`generating` が spinner、`idle`/`ready`/`waiting` が dot）で行う。

### H8: `useWorktreeStatusByCli` hook → ❌ Rejected

- **Issue記載**: `const sessionStatus = useWorktreeStatusByCli({ worktreeId, cliToolId });`
- **実際**: `useWorktreeStatusByCli` という hook は**コードベースに存在しない**（grep結果 0件）。
- 正しいデータ供給: 親 `WorktreeDetailRefactored` が保持する `worktree.sessionStatusByCli[cliToolId]` を prop として `renderSplitPane` → `TerminalSplitPaneContent` へ propagate する（#740 AutoYesToggle と同じパターン）。

### H9: `<Spinner />` コンポーネント → ❌ Rejected

- **Issue記載**: `<Spinner className="w-3 h-3" />`
- **実際**: `src/components/` 配下に `Spinner` コンポーネントは**存在しない**（`src/cli/utils/spinner.ts` はターミナル用で無関係）。
- 正しい実装: Mobile（H3）と同じインライン span（`border-2 border-t-transparent animate-spin`）を使う。

### H10: `worktree.sessionStatusByCli[cliToolId]` の構造 → ✅ Confirmed

`src/types/models.ts:71`:
```ts
sessionStatusByCli?: Partial<Record<CLIToolType, { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean }>>;
```
`deriveCliStatus` の入力型 `CLIToolStatusInput`（`sidebar.ts:22-26`）と完全一致。**正確。**

### H11: `useTerminalPanePolling` から status を取得 → ❌ Rejected（補足）

Issueには明記されていないが、`TerminalSplitPaneContent` は既に `useTerminalPanePolling` で per-split polling を持つため「ローカル状態から status を出せるのでは」という暗黙の選択肢がある。検証の結果:
- `useTerminalPanePolling` の `PaneTerminalState`（`useTerminalPanePolling.ts:39-47`）は `isRunning` / `isThinking` / `isSelectionListActive` のみ。
- `deriveCliStatus` が必要とする `isWaitingForResponse` / `isProcessing` を**持たない**。
- → ローカル polling 状態では status を導出できない。**親の `sessionStatusByCli` を propagate する設計（H8の正しい版）が必須。**

### H12: `TerminalSplitPane.tsx` は変更不要 → ✅ Confirmed（注記あり）

`headerExtras` slot は既に存在（L35 props定義、L51 分割代入、L135 描画）し、`headerExtras` を渡すだけで描画される。**ただし**:
- JSDoc（L34）の "Rendered above the CLI selector" は不正確で、実際は検索ボタンの**後（右端）**に描画される。挙動上は問題ないが、配置を「CLIセレクター直後・検索ボタンの左」等に調整したい場合は `TerminalSplitPane.tsx` の微修正が必要になる可能性がある（スコープ判断は実装時）。

---

## Stage 1 への申し送り事項

1. **【Must Fix】対応方針のコードサンプルが実コードと乖離**: import パス2件（H4/H5）、フィールド名（H6）、status値（H7）、存在しないhook（H8）、存在しないcomponent（H9）。Issue本文の「対応方針」を正準パターン（Mobile L1947-1974）ベースに書き換えるべき。
2. **【確定】データ供給は親propagate方式**: `useTerminalPanePolling` では status を導出不可（H11）。`worktree.sessionStatusByCli[paneCli]` を `renderSplitPane`（WorktreeDetailRefactored L1459-1517）で解決し prop で渡す（#740 と同型）。
3. **【確認】根本原因の診断は正確**: H1/H2/H3 すべて Confirmed。修正方向性（headerExtras 配線）は妥当。
