## 概要

Issue #728（PCターミナル1-3分割）でPC版の footer を per-split 構造に再構成した際、**`AutoYesToggle` の移行が漏れた**ため、PC版で **Agent (CLI) ごとに Auto-Yes をON/OFFするUIが存在しない** 状態になっている。本Issueで各 split footer に AutoYesToggle を追加し、CLI 単位で独立した Auto-Yes 操作を可能にする。

> **レビュー反映（#740 Issue review, 2026-05-31）**: 当初の「対応方針（案A）」は `useAutoYes({worktreeId, cliToolId})` が enabled/expiresAt/toggle を返す前提だったが、実 API と不一致で実装不能だったため、**親 (`WorktreeDetailRefactored`) が per-CLI Map `autoYesStateMap` を単一の真実源として保持し、各 split に props を配布する方針**へ修正した（下記「対応方針」参照）。

## 症状

- PC版で worktree詳細を開いてもターミナル領域に **Auto-Yes トグルが見当たらない**
- Agent (Claude / Codex / Gemini 等) ごとに Auto-Yes をON/OFFしたくても **操作する手段がない**
- モバイル版は引き続き動作（影響なし）

## 根本原因

> ⚠ 行番号は #732/#736 の編集でシフトしうるため目安。

### 1. PC版のfooterからAutoYesToggleが消えている

`src/components/worktree/WorktreeDetailRefactored.tsx` の `renderSplitPane` 直前（現行 L1423 付近）のコメント:

```
Issue #728: NavigationButtons / PromptPanel / MessageInput are
rendered for every split. The activeCliTab still tracks split 0 so
HistoryPane / Auto-Yes UI / kill session controls continue working.
```

**`MessageInput` / `NavigationButtons` / `PromptPanel`** は per-split に移されたが、**`AutoYesToggle` が含まれていない**。旧PC layout には共有 footer に AutoYesToggle が存在したが、#728 でその共有 footer が削除された際に **AutoYesToggle の移行が漏れた**。

### 2. TerminalSplitPaneContent.tsx の footer に AutoYesToggle がない

`src/components/worktree/TerminalSplitPaneContent.tsx` の `footerSlot`（現行 L161-213）:

```tsx
const footerSlot = useMemo(
  () => (
    <div className="space-y-2">
      {showNav ? <NavigationButtons .../> : null}
      {showPrompt ? <PromptPanel .../> : null}
      <MessageInput .../>
    </div>
  ),
  [...]
);
```

→ **AutoYesToggle が描画されていない**。なお当コンポーネントは既に `autoYesEnabled?: boolean` prop を受け取り（L60,74）、`showPrompt = prompt.visible && !autoYesEnabled`（L138）で PromptPanel 抑制に使用済み。**不足しているのはトグルUIとトグル操作**である。

### 3. Mobile版（現行 L1897-1904）にのみ存在する

```tsx
{/* Auto Yes + CLI Tool Tabs combined row (Mobile) */}
<AutoYesToggle
  enabled={autoYesEnabled}
  expiresAt={autoYesExpiresAt}
  onToggle={handleAutoYesToggle}
  lastAutoResponse={lastAutoResponse}
  cliToolName={activeCliTab}
  inline
/>
```

### 4. 二次的問題: 真の欠落箇所（※当初記載「activeCliTab 単一キー管理」は不正確のため訂正）

enabled/expiresAt 状態自体は **Issue #525 で既に per-CLI の Map**（`autoYesStateMap`, `WorktreeDetailRefactored.tsx:218` = `Map<string,{enabled,expiresAt}>`）で保持され、各 split は既に `paneAutoYesEnabled = autoYesStateMap.get(paneCli)?.enabled`（L1450）を受け取り PromptPanel 抑制に使用済み（L1467 で配布）。

したがって「3独立状態が無い」は誤り。**enabled 状態は既に per-CLI で追跡・配布済み**であり、欠落しているのは次の3点のみ:

- **(a) PC split footer のトグル UI**（AutoYesToggle 描画）
- **(b) `handleAutoYesToggle`（L810-835）の cliToolId パラメータ化**（現状 `cliToolId: activeCliTab`（L817）と `next.set(activeCliTab, ...)`（L827）がハードコードされており、非アクティブ split の CLI を ON/OFF できない）
- **(c) 非アクティブ split のサーバー側 Auto-Yes 同期**（→ スコープ外、後述）

## 対応方針（親所有 + per-split 配布）

各 split の footer に AutoYesToggle を追加する。**状態は親 (`WorktreeDetailRefactored`) の `autoYesStateMap`（既に per-CLI の Map）が単一の真実源**であり、各 split には親が `enabled`/`expiresAt`/`lastAutoResponse`/`onToggle` を **props で配布**する。

> ❌ **`TerminalSplitPaneContent` 内で `useAutoYes` を新規に呼んではならない**。`useAutoYes`（`src/hooks/useAutoYes.ts`）は入力 `{ worktreeId, cliTool, isPromptWaiting, promptData, autoYesEnabled, ... }`・出力 `{ lastAutoResponse }` のみで、enabled/expiresAt/toggle を返さない **client-side auto-response 専用フック**である。

> 📝 **client-side auto-response は per-split 化しない**。実際の自動応答は Issue #501 のサーバー側 poller が担う（`useAutoYes` は `serverPollerActive` 時クライアント応答をスキップ: `useAutoYes.ts:77-81`）。PC split で必要なのは (1) `enabled` に応じた PromptPanel 抑制（既存 L138）と (2) トグル UI のみ。親 L1175 の `useAutoYes(activeCliTab)` は Mobile/通知用途で従来どおり 1 インスタンス維持。

### レイアウト（TerminalSplitPaneContent の footer）

```tsx
const footerSlot = useMemo(
  () => (
    <div className="space-y-2">
      <AutoYesToggle
        enabled={autoYesEnabled}        // 親 props（autoYesStateMap.get(cliToolId)?.enabled）
        expiresAt={autoYesExpiresAt}     // 親 props（autoYesStateMap.get(cliToolId)?.expiresAt）
        onToggle={onAutoYesToggle}       // 親 props（cliToolId を束縛済み）
        lastAutoResponse={lastAutoResponse}  // 親 props
        cliToolName={cliToolId}
      />
      {showNav ? <NavigationButtons .../> : null}
      {showPrompt ? <PromptPanel .../> : null}
      <MessageInput .../>
    </div>
  ),
  [...]  // 新規 props を依存配列に追加
);
```

### state 管理（親所有・per-CLI Map を真実源に）

- key: `(worktreeId, cliToolId)`（`autoYesStateMap` は worktreeId スコープ内で cliToolId keyed）
- `handleAutoYesToggle` を **cliToolId 引数化**（カリー化 `(cliToolId) => (params) => ...` か デフォルト引数 `(params, cliToolId = activeCliTab)`）。API body の `cliToolId` と `setAutoYesStateMap` の key を引数値にする。Mobile は既定 `activeCliTab` 経路を維持。
- `renderSplitPane`（L1432-1479）で各 split に `autoYesStateMap.get(paneCli)?.expiresAt` と、paneCli を束縛した onToggle、lastAutoResponse を追加配布。
- 同じ CLI を 2 split で開いた場合は同一 Map エントリを参照するため state を共有（ただし下記「スコープ外」の通り UI 上は同一 CLI 2 split は不可）。

## 受入条件

- [ ] PC版で各 split footer に AutoYesToggle が表示される
- [ ] スプリットA=Claude, B=Codex の構成で、Aの Auto-Yes をONにしてもBの Auto-Yes 状態は変わらない（**主目的**: handleAutoYesToggle の cliToolId パラメータ化で達成）
- [ ] worktreeを切り替えても各CLI の Auto-Yes 状態は worktree スコープで保持される（既存仕様）
- [ ] Auto-Yes ON 中は対応する split の PromptPanel が非表示になる（既存挙動維持: `showPrompt = prompt.visible && !autoYesEnabled`）
- [ ] モバイル版の AutoYesToggle 挙動は変更なし。**handleAutoYesToggle のシグネチャ変更後も Mobile 呼び出し（L1897-1904）が activeCliTab 既定で従来どおり動作する**
- [ ] **split0 の CLI 変更が activeCliTab へ同期される既存挙動（L1461）が維持される**
- [ ] 非アクティブ split のサーバー主導 Auto-Yes 同期は**本Issueのスコープ外**であることを確認（下記スコープ外参照）
- [ ] client-side auto-response は per-split 化しない（サーバー poller 委譲）ことを確認
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS
- [ ] 回帰テスト追加（下記テスト方針参照）

### テスト方針

- **(1) TerminalSplitPaneContent 単体テスト**: `autoYesEnabled`/`autoYesExpiresAt`/`onAutoYesToggle` props を与えたとき AutoYesToggle が footer に描画され、トグル操作時に `onAutoYesToggle` が（その split の）`cliToolId` スコープで呼ばれることを検証。
- **(2) per-split 独立性**: `renderSplitPane` の props 配布ロジック（`autoYesStateMap.get(paneCli)`）または `handleAutoYesToggle(cliToolId)` の単体検証で、CLI ごとに独立して enabled/expiresAt が解決されることを確認。
- ※「A=Claude, B=Claude で同期」は UI 上 **同一 CLI を 2 split で選択できない**（`useTerminalSplits.setSplitCliTool` が同一 CLI を no-op で禁止: L175-178、`availableCliTools` が使用済み CLI を除外: L192-201）ため受入条件から除外。Map が cliToolId keyed であることの単体検証で代替する。

## 想定影響範囲

| ファイル | 変更内容 |
|----------|----------|
| `src/components/worktree/TerminalSplitPaneContent.tsx` | props 追加（`autoYesExpiresAt: number\|null` / `lastAutoResponse: string\|null` / `onAutoYesToggle`）、footerSlot 先頭に AutoYesToggle 描画、useMemo 依存配列更新。props JSDoc（L56-59 の auto-yes 説明）を per-CLI トグル対応に更新。**`useAutoYes` の新規呼び出しはしない** |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `handleAutoYesToggle`（L810-835）を cliToolId 引数化（API body の `cliToolId` と `setAutoYesStateMap` の key を activeCliTab ハードコードから引数値へ、依存配列見直し）。`renderSplitPane`（L1432-1479）で各 split に `autoYesExpiresAt`/`lastAutoResponse`/`onAutoYesToggle`（cliToolId 束縛）を追加配布。Mobile 経路の AutoYesToggle（L1897-1904）と split0→activeCliTab 同期（L1461）の後方互換維持 |
| `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` | AutoYesToggle 描画テスト・onAutoYesToggle 呼び出しテスト追加 |
| 必要に応じて `tests/unit/components/worktree/WorktreeDetailRefactored*.test.tsx` | handleAutoYesToggle の per-cliToolId 独立性 / Mobile 既定経路の後方互換テスト |
| `CHANGELOG.md` | [Unreleased] Fixed 追記 |
| `CLAUDE.md` | モジュールリファレンス更新（TerminalSplitPaneContent / WorktreeDetailRefactored） |

## スコープ外

- AutoYesToggle のデザイン変更
- `useAutoYes` 自体のリファクタ（per-split key 化等）
- Mobile 版の挙動変更
- AutoYes の挙動仕様変更（停止パターン等）
- **非アクティブ split（活性 CLI 以外）に対するサーバー主導の自動 OFF（expiry / stop_pattern_matched / consecutive_errors）の即時反映**。現状の親ポーリング `fetchCurrentOutput`（L501-545）は `activeCliTab` 分のみ `autoYesStateMap` を同期し、`useTerminalPanePolling` は設計上 Auto-Yes を保持しない（`useTerminalPanePolling.ts:15-18`）。このため非アクティブ split のトグルは、ユーザー操作 or その split を活性化するまで ON 表示が残る場合がある。AutoYesToggle のカウントダウンは `expiresAt` からクライアント側算出（`AutoYesToggle.tsx:56-69`）されるため表示上の残り時間は減る。全 split ポーリング化は別Issueで検討。

## 関連

- 親Issue: #728（PCターミナル1-3分割）
- 由来: #728 で per-split footer 構造に移行時に AutoYesToggle 移行漏れ
- 既存実装:
  - `src/components/worktree/AutoYesToggle.tsx`（props `enabled`/`expiresAt`/`onToggle`/`lastAutoResponse` 必須）
  - `src/components/worktree/TerminalSplitPaneContent.tsx`
  - `src/hooks/useAutoYes.ts`（client-side auto-response 専用、戻り値 `{ lastAutoResponse }` のみ）
  - `src/hooks/useTerminalPanePolling.ts`（Auto-Yes を意図的に保持しない）
  - `src/components/worktree/WorktreeDetailRefactored.tsx`（`autoYesStateMap` L218 / `handleAutoYesToggle` L810-835 / `renderSplitPane` L1432-1479 / Mobile AutoYesToggle L1897-1904）
- Issue #525（per-agent auto-yes 状態 Map 導入）
- Issue #501（サーバー側 auto-yes poller）

## 検証手順

```bash
# 修正前の症状再現
1. http://localhost:3000 起動
2. 任意 worktree を開く（PC版幅）
3. ターミナル領域を見ると、AutoYesToggle が見当たらない（バグ）
4. モバイル幅にすると AutoYesToggle が表示される（モバイルのみ機能）

# 修正後の検証
1. PC版で各 split の footer 領域に AutoYesToggle が表示される
2. +Split で 2分割、左に Claude / 右に Codex を選択
3. 左 split で Auto-Yes ON → 左のみ ON 表示
4. 右 split で Auto-Yes ON → 右のみ ON 表示（左は変わらず）
5. リロード後も各 CLI の Auto-Yes 状態が保持される
```
