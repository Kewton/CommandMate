## 概要

Issue #728（PCターミナル1-3分割）で footer per-split 構造に移行した際、**各 split header のAIエージェントステータスインジケーター（緑dot/黄dot/青スピナー等）が欠落**している。AutoYesToggle (#740) と同じく「移行漏れ」パターン。

## 症状

- PC版で worktree詳細を開いてもターミナル header に **session status（dot/スピナー）が表示されない**
- 各 split がどのAgent（Claude/Codex/Gemini 等）の何の状態（running / waiting / idle 等）か視覚的に分からない
- Mobile版は引き続き動作（影響なし）

## 根本原因

### 1. PC側 `TerminalSplitPane.tsx` header に status indicator がない

`src/components/worktree/TerminalSplitPane.tsx`（header は概ね line 88-136）の構成は:
- CLI セレクター（`<select>`）
- 検索ボタン（`ml-auto` で右寄せ）
- `headerExtras?` slot（props 定義 line 35 / 分割代入 line 51 / 描画 line 135）

```tsx
<div className="px-2 py-1 flex items-center gap-2 bg-gray-50 ...">
  <label className="sr-only" .../>
  <select id={`cli-selector-${splitIndex}`} ...>...</select>
  <button onClick={handleSearchClick} ...>{/* search icon */}</button>
  {headerExtras}  {/* ← 呼び出し側が null のため空のまま */}
</div>
```

`deriveCliStatus` / `SIDEBAR_STATUS_CONFIG` の import は無い。

### 2. `TerminalSplitPaneContent.tsx` から `headerExtras` が渡されていない

`src/components/worktree/TerminalSplitPaneContent.tsx` の return 文（`TerminalSplitPane` 呼び出し、line 256-268 付近）で `headerExtras` を指定していない:

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
    // headerExtras={...} ← 渡されていない
  />
);
```

### 3. Mobile版（`WorktreeDetailRefactored.tsx` line 1947-1974）にのみ status indicator がある

これが流用すべき**正準パターン**:

```tsx
const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
// ...
{statusConfig.type === 'spinner' ? (
  <span
    className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
    title={statusConfig.label}
  />
) : (
  <span
    className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`}
    title={statusConfig.label}
  />
)}
```

PC側 `TerminalSplitPane.tsx` / `TerminalSplitPaneContent.tsx` には `deriveCliStatus` / `SIDEBAR_STATUS_CONFIG` の import すらない。

## 対応方針

> 実装は Mobile 正準パターン（`WorktreeDetailRefactored.tsx:1947-1974`）と #740 AutoYesToggle の親→子 propagate パターンを踏襲する。

### 1. データ供給は親 `WorktreeDetailRefactored` から prop で propagate（必須）

`useTerminalPanePolling` の `PaneTerminalState`（`useTerminalPanePolling.ts:39-47`）は `isRunning` / `isThinking` / `isSelectionListActive` のみで、`deriveCliStatus` が必要とする `isWaitingForResponse` / `isProcessing` を持たない。よって**ローカル polling 状態からは status を導出できず**、親 `WorktreeDetailRefactored` が保持する `worktree.sessionStatusByCli[cliToolId]` を prop で渡す以外に方法がない（#740 AutoYesToggle と同型）。

`renderSplitPane`（`WorktreeDetailRefactored.tsx:1459-1517`）内で各 split の CLI に対応する status を解決し、新規 prop（例: `sessionStatus`）として `TerminalSplitPaneContent` へ配布する:

```tsx
// renderSplitPane 内（paneCli が当該 split の CLIToolType）
const paneSessionStatus = worktree?.sessionStatusByCli?.[paneCli];

return (
  <TerminalSplitPaneContent
    // ...既存 props...
    sessionStatus={paneSessionStatus}  // ← 追加（#740 と同型で per-CLI に配布）
  />
);
```

### 2. status を `TerminalSplitPaneContent.tsx` で計算

正しい import 元（Mobile 実装と同じ）:

```tsx
import { deriveCliStatus } from '@/types/sidebar';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';

// props で受け取った sessionStatus（= worktree.sessionStatusByCli[cliToolId]）から導出
const cliStatus = deriveCliStatus(sessionStatus);
const statusConfig = SIDEBAR_STATUS_CONFIG[cliStatus];
```

- `deriveCliStatus` の戻り値型は `'idle' | 'ready' | 'running' | 'waiting' | 'generating'`（`'processing'` という値は存在しない）。
- spinner / dot の分岐は `statusConfig.type === 'spinner'` で判定する（`running` / `generating` が `type='spinner'`、`idle` / `ready` / `waiting` が `type='dot'`）。
- 色クラスは `statusConfig.className`（`colorClass` というフィールドは存在しない）。

### 3. status indicator を `headerExtras` に渡す

Mobile と同じインライン span（専用 `<Spinner/>` コンポーネントは存在しないため使わない）:

```tsx
const statusIndicator = (
  <span
    data-testid={`split-status-indicator-${splitIndex}`}
    className={
      statusConfig.type === 'spinner'
        ? `w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`
        : `w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`
    }
    aria-label={`Session status: ${statusConfig.label}`}
    title={statusConfig.label}
  />
);

return (
  <TerminalSplitPane
    // ...既存 props...
    headerExtras={statusIndicator}
  />
);
```

## 受入条件

- [ ] PC版で各 split header に status indicator が表示される
- [ ] 状態に応じてアイコン/色が切替: `idle → グレー dot` / `ready → 緑 dot` / `waiting → 黄 dot` / `running・generating → 青スピナー`（実 `SIDEBAR_STATUS_CONFIG` のマッピングに準拠。`'processing'` という状態は存在しない）
- [ ] スプリットA=Claude（running）/ B=Codex（idle）の構成で、Aに青スピナー（running）・Bにグレー dot（idle）が独立して表示される
- [ ] worktree切替・CLI切替後も対応する status が反映される
- [ ] `sessionStatusByCli` がポーリング更新されたとき自動で indicator も更新される
- [ ] aria-label / title 等のアクセシビリティ属性が付与される
- [ ] モバイル版の status indicator 挙動は変更なし
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS
- [ ] 回帰テスト追加（status indicator 描画 / 状態切替）

## 想定影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | **必須**: `renderSplitPane`（L1459-1517）で `worktree?.sessionStatusByCli?.[paneCli]` を解決し、新規 prop（例 `sessionStatus`）として `TerminalSplitPaneContent` に配布（#740 AutoYesToggle と同型の親→子 propagate） |
| `src/components/worktree/TerminalSplitPaneContent.tsx` | `sessionStatus` prop 受領・`deriveCliStatus`/`SIDEBAR_STATUS_CONFIG` で statusConfig 算出・statusIndicator 生成・`headerExtras` 配線 |
| `src/components/worktree/TerminalSplitPane.tsx` | 既存 `headerExtras` slot を流用するため原則変更なし。ただし `headerExtras` は検索ボタンの右端に描画される点に留意（CLI セレクター直後・検索ボタンの左へ寄せたい場合のみ微修正） |
| `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` | status indicator 描画・状態切替テスト追加 |
| `CHANGELOG.md` | [Unreleased] Fixed 追記 |
| `CLAUDE.md` | モジュールリファレンス更新 |

## スコープ外

- status indicator のデザイン変更
- `SIDEBAR_STATUS_CONFIG` 自体の変更
- Mobile 版の挙動変更
- session status のポーリング仕様変更
- History の per-split 化（別Issue）

## 関連

- 親Issue: #728（PCターミナル1-3分割）
- 由来: #728 で per-split header 構造移行時に status indicator 移行漏れ
- 類似パターン: #740（AutoYesToggle 移行漏れ・親→子 propagate）
- 既存実装:
  - `src/components/worktree/TerminalSplitPane.tsx` (`headerExtras` slot)
  - `src/components/worktree/TerminalSplitPaneContent.tsx`
  - `src/components/worktree/WorktreeDetailRefactored.tsx:1947-1974`（**正準パターン**: Mobile の status indicator 実装）
  - `src/types/sidebar.ts` (`deriveCliStatus`)
  - `src/config/status-colors.ts` (`SIDEBAR_STATUS_CONFIG`)

## 検証手順

```bash
# 修正前の症状再現
1. http://localhost:3000 起動
2. 任意 worktree を開く（PC版幅）
3. ターミナル header を見る → CLI セレクター + 検索ボタン のみ、status indicator なし（バグ）
4. モバイル幅にすると status indicator が表示される（モバイルのみ機能）

# 修正後の検証
1. PC版で 1-3 分割し、それぞれ別CLIを選択
2. 各 split header に status indicator が表示される
3. 該当 CLI session を起動 → running 中は青スピナー、処理待ち（ready）は緑 dot に
4. 別 split は影響なし（独立して各自の status を表示）
```
