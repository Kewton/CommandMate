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

#### prop は「導出済み `BranchStatus` 文字列」に絞って渡す（再レンダリング回避・必須／S3-001）

> **重要（memo 境界の referential 安定化）**: `renderSplitPane`（`WorktreeDetailRefactored.tsx:1459-1517`）の `useCallback` 依存配列（L1507-1516）に `worktree` または `sessionStatusByCli` を**そのまま**追加すると、`worktree` は `useState<Worktree|null>`（L205）でポーリングループ（L1371-1385、ACTIVE=2000ms / IDLE=5000ms）が毎周期 `fetchWorktree()`→`setWorktree(JSON.parse 結果)`（L444）で**毎回新規オブジェクト参照**に置換する。その結果、
> 1. `renderSplitPane` が毎ポーリングで再生成 → `terminalSplitRegion`（`useMemo` 依存 `[worktreeId, renderSplitPane]`、L1519-1528）も再生成 → memo 化 `TerminalSplitContainer` の `renderPane` が毎周期再実行（最大3 split）。
> 2. さらに `worktree.sessionStatusByCli[paneCli]` 自体が毎回新オブジェクト参照になり、memo 化 `TerminalSplitPaneContent`（L88）に渡る `sessionStatus` prop の shallow 比較が毎回 false → 全 split が 2 秒毎に全再render する。

**回避策（採用方針）**: prop には**オブジェクトではなく導出済みの enum 値（文字列）`cliStatus: BranchStatus`** を渡す。`renderSplitPane` 内で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を計算し、その結果（`'idle' | 'ready' | 'running' | 'waiting' | 'generating'` のいずれか）を渡す。文字列は値が同じなら参照ブレが起きず shallow 一致するため、`TerminalSplitPaneContent` の memo が「**status が実際に変化したときだけ**」破られる。これにより「`sessionStatusByCli` がポーリング更新されたとき自動で indicator も更新される」要件と「毎ポーリングでの無駄 render を起こさない」要件を両立できる（#740 AutoYesToggle で前例のある「最小 primitive を per-CLI に配布」方針に整合）。

```tsx
// renderSplitPane 内（paneCli が当該 split の CLIToolType）
// deriveCliStatus は WorktreeDetailRefactored で Mobile 経路（L1947）が既に import 済みのため import 追加不要
const paneCliStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli]); // → BranchStatus（文字列）

return (
  <TerminalSplitPaneContent
    // ...既存 props...
    cliStatus={paneCliStatus}  // ← 導出済み文字列（参照安定）を per-CLI に配布
  />
);
```

> 代替案として `TerminalSplitPaneContent` 側で `sessionStatus` オブジェクトを `useMemo`/個別 primitive 分解して安定化する手もあるが、本Issueでは**(a) 導出済み `cliStatus: BranchStatus` を渡す案を採用**し、prop 名・型を確定させる。

### 2. status を `TerminalSplitPaneContent.tsx` で `statusConfig` に解決

正しい import 元（Mobile 実装と同じ）。なお `deriveCliStatus` は親で計算するため、**子では `SIDEBAR_STATUS_CONFIG` の import のみで足りる**（`cliStatus` を直接受け取る場合）:

```tsx
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';

// props で受け取った cliStatus（導出済み BranchStatus）から statusConfig を解決
const statusConfig = SIDEBAR_STATUS_CONFIG[cliStatus];
```

- `cliStatus` の値域は `'idle' | 'ready' | 'running' | 'waiting' | 'generating'`（`'processing'` という値は存在しない）。
- spinner / dot の分岐は `statusConfig.type === 'spinner'` で判定する（`running` / `generating` が `type='spinner'`、`idle` / `ready` / `waiting` が `type='dot'`）。
- 色クラスは `statusConfig.className`（`colorClass` というフィールドは存在しない）。
- `SIDEBAR_STATUS_CONFIG[cliStatus]` は**モジュール定数参照**であり、`cliStatus`（文字列）が同値なら `statusConfig` も参照安定である（依存設計時に留意）。

### 3. status indicator を `useMemo` で安定化して `headerExtras` に渡す（S3-003）

`TerminalSplitPaneContent` の return（L256-268）の `<TerminalSplitPane>` 要素自体は現状 useMemo 化されていない（`terminalSlot`/`footerSlot` のみ useMemo）。statusIndicator span を毎 render 新規生成すると memo 化 `TerminalSplitPane`（L44）の `headerExtras` prop が毎回新参照になり memo を破る。よって **statusIndicator は `useMemo`（依存: `cliStatus`、または `statusConfig.type` / `statusConfig.className` / `statusConfig.label` と `splitIndex`）で生成**し、TerminalSplitPane の memo を不要に壊さない。

Mobile と同じインライン span（専用 `<Spinner/>` コンポーネントは存在しないため使わない）:

```tsx
const statusIndicator = useMemo(() => (
  <span
    data-testid={`split-status-indicator-${splitIndex}`}
    className={
      statusConfig.type === 'spinner'
        ? `w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`
        : `w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`
    }
    title={statusConfig.label}
  />
), [statusConfig.type, statusConfig.className, statusConfig.label, splitIndex]);

return (
  <TerminalSplitPane
    // ...既存 props...
    headerExtras={statusIndicator}
  />
);
```

### 4. アクセシビリティ属性は Mobile 正準（`title` のみ）と一貫させる（S3-006）

Mobile 正準パターン（L1960-1970）は `title` のみで `aria-label` は付与していない。span に `aria-label` と `title` を併記すると一部 SR で二重読み上げになる懸念があり（プロジェクトには `Tooltip.tsx` で「role=tooltip+aria-hidden=true で aria-label 重複読み上げ回避」の前例あり）、**本Issueでは Mobile に合わせ `title` のみ付与**する方針とする。`data-testid`（`split-status-indicator-${splitIndex}`）はテスト用に additive で付与する。ヘッダーには既に CLI セレクターの sr-only label / 検索ボタンの aria-label があるため、status indicator の SR 文言が冗長にならないことを実装時に一度確認する。

## 受入条件

- [ ] PC版で各 split header に status indicator が表示される
- [ ] 状態に応じてアイコン/色が切替: `idle → グレー dot` / `ready → 緑 dot` / `waiting → 黄 dot` / `running・generating → 青スピナー`（実 `SIDEBAR_STATUS_CONFIG` のマッピングに準拠。`'processing'` という状態は存在しない）
- [ ] スプリットA=Claude（running）/ B=Codex（idle）の構成で、Aに青スピナー（running）・Bにグレー dot（idle）が独立して表示される
- [ ] worktree切替・CLI切替後も対応する status が反映される
- [ ] `sessionStatusByCli` がポーリング更新されたとき自動で indicator も更新される（**かつ status が変化しないポーリング周期では split が再renderされない＝S3-001 の memo-safe 設計が機能している**）
- [ ] 新 prop（`cliStatus`）は **optional** とし、未指定時は `deriveCliStatus(undefined)` 相当の `'idle'`（グレー dot）にフォールバックする（既存テスト・呼び出し元を無改修で温存／S3-002）
- [ ] アクセシビリティ属性は Mobile 正準に合わせ `title` のみ付与（aria-label との二重読み上げを避ける／S3-006）
- [ ] モバイル版の status indicator 挙動は変更なし（`WorktreeDetailRefactored.tsx:1947-1974` を変更しない）
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS
- [ ] 回帰テスト追加（後述「テスト方針」の3系統）

## テスト方針（S3-005）

`tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` は `useTerminalPanePolling` を実フックのまま動かし fetch をモックする構造であり、**status は polling では供給されない（prop 経由で供給される）**点を前提にテストを追加する。`headerExtras` 内の indicator は `data-testid={split-status-indicator-${splitIndex}}` で assert する。追加する系統:

1. **状態別描画**: `cliStatus` 各値での indicator 描画 — `idle → グレー dot` / `ready → 緑 dot` / `waiting → 黄 dot` / `running・generating → 青スピナー`（`statusConfig.type` と `className` を assert）
2. **prop 未指定フォールバック**: `cliStatus` 未指定時に `idle`（グレー dot）が描画される（後方互換／既存8ケースを無改修で温存）
3. **per-split 独立**: splitA=`running`（青スピナー） / splitB=`idle`（グレー dot）が独立して描画される
4. **memo-safe 確認（任意）**: `useTerminalPanePolling` は status を供給せず prop 経由である前提を明示するケース

`tests/unit/components/worktree/TerminalSplitPane.test.tsx` は TerminalSplitPane を変更しない前提のため原則変更不要だが、「`headerExtras` に任意 ReactNode が描画される契約」の回帰確認を additive ケースで補強しても良い。

## 想定影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | **必須**: `renderSplitPane`（L1459-1517）で `deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli])` を計算し、**導出済み `cliStatus: BranchStatus`（文字列）**を新規 prop として `TerminalSplitPaneContent` に配布（#740 AutoYesToggle と同型の親→子 propagate）。**`deriveCliStatus`/`SIDEBAR_STATUS_CONFIG` は Mobile 経路（L1947-1948）で既に import 済みのため import 追加不要**。`useCallback` 依存に `worktree` 全体を入れず、毎ポーリング再生成を避ける memo-safe 設計（S3-001）。**Mobile 経路 L1947-1974 は変更しない（回帰防止）** |
| `src/components/worktree/TerminalSplitPaneContent.tsx` | `cliStatus?: BranchStatus`（**optional**、未指定時 `'idle'` フォールバック／S3-002）prop 受領・`SIDEBAR_STATUS_CONFIG` で statusConfig 解決・statusIndicator を `useMemo` で安定化（S3-003）・`headerExtras` 配線。**本ファイルのみ新規 import（`SIDEBAR_STATUS_CONFIG`、cliStatus を子で導出する場合は `deriveCliStatus`/型 `BranchStatus`）が必要**（S3-004）。**再レンダリング/パフォーマンス観点**: 導出済み文字列を受け取ることで memo の shallow 比較が status 変化時のみ false になる |
| `src/components/worktree/TerminalSplitPane.tsx` | 既存 `headerExtras` slot を流用するため原則変更なし。ただし `headerExtras` は検索ボタンの右端に描画される点に留意（CLI セレクター直後・検索ボタンの左へ寄せたい場合のみ微修正） |
| `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` | 「テスト方針」の3系統を追加（状態別描画 / 未指定フォールバック / per-split 独立）。**既存8ケースは `cliStatus` 未指定でも idle フォールバックで無改修温存**（S3-002, S3-005） |
| `tests/unit/components/worktree/TerminalSplitPane.test.tsx` | 変更しない前提（必要なら `headerExtras` 描画契約の additive ケースのみ／S3-005） |
| `CHANGELOG.md` | [Unreleased] Fixed 追記 |
| `CLAUDE.md` | モジュールリファレンス更新 |

> **再レンダリング/パフォーマンス観点（S3-001 まとめ）**: 親の `renderSplitPane` で `worktree`/`sessionStatusByCli` を `useCallback` 依存にそのまま入れると、`worktree` が毎ポーリング（ACTIVE=2000ms / IDLE=5000ms）で新規オブジェクト参照に置換されるため、`renderSplitPane`→`terminalSplitRegion`→memo 化 `TerminalSplitContainer` の `renderPane` 再生成および memo 化 `TerminalSplitPaneContent` の prop shallow 不一致を招き、最大3 split が 2 秒毎に全再render する。回避策として **prop を導出済み `BranchStatus` 文字列に絞り**、status 値が変化したときだけ再render させる。

## スコープ外

- status indicator のデザイン変更
- `SIDEBAR_STATUS_CONFIG` 自体の変更
- **Mobile 版の挙動変更（`WorktreeDetailRefactored.tsx:1947-1974` は無改修）**
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
5. session status が変化しないポーリング周期では split が無駄に再renderしない（memo-safe／S3-001）
```
