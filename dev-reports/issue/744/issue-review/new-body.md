## 概要

Issue #728（PCターミナル1-3分割）でターミナル領域が CLI ごとに分割可能になったが、**History は1つに集約**されたままで、どのメッセージがどのAgent (Claude/Codex/Gemini 等) のものか視覚的に判別できない。

本Issueで `HistoryPane` を**各 split 内に内包**し、その split の `cliToolId` で**独立に fetch** したメッセージのみを表示することで、Agent と履歴の対応を明示化する。これは #728/#736 の per-split `useTerminalPanePolling` と同型の per-split 独立 fetch 方式（後述）で実現する。

## 症状

- PC版で worktree詳細を開き 2-3 split に分割（例: Claude / Codex / Gemini）したとき:
  - History 領域は1つだけ表示される（現在の `activeCliTab` のメッセージのみ）
  - **各 split の Agent に対応する履歴が個別に表示されない**
- ユーザー要望: 「ターミナル領域内の左側に History を表示し、その split の CLI の履歴のみを表示してほしい」

## 現状アーキテクチャ

`src/components/worktree/WorktreeDetailRefactored.tsx` 抜粋:

```tsx
<TerminalContainer
  history={historyPaneMemo}        // ← activeCliTab のメッセージのみを1つに表示
  terminal={rightPaneSplitMemo}    // ← FilePanelSplit（= TerminalSplitContainer + FilePanel）
/>
```

`TerminalContainer.tsx` のレイアウト（現状は `[History | terminal]` の2分割であり、FilePanel は terminal スロット内の `FilePanelSplit` に含まれる）:

```
TerminalContainer
├ HistoryPane (activeCliTab のメッセージ)
└ terminal スロット = FilePanelSplit
    ├ TerminalSplitContainer (CLI別 split: Claude / Codex / Gemini ...)
    └ FilePanel
```

`HistoryPane` は `state.messages` を受け取り `useConversationHistory(messages)` で表示する。

> **重要（設計前提の訂正）**: `state.messages` は「全CLIのメッセージ」ではなく、**現在の `activeCliTab` 1種類のみ**を保持している。`fetchMessages`（`WorktreeDetailRefactored.tsx:472-497`）は `?cliTool=<activeCliTab>&limit=<#701>` を付与して取得し、API route（`src/app/api/worktrees/[id]/messages/route.ts`）→ `chat-db.ts getMessages`（L185-218 の `AND cli_tool_id = ?`）でサーバ側フィルタされる。`useTerminalPanePolling` のヘッダコメントも「History messages — globally keyed by activeCliTab」を per-split が所有しないと明記している。
>
> したがって「`state.messages` をクライアント側で `cliToolId` フィルタする」案では、スプリットA=Claude / B=Codex を**同時に**それぞれの CLI のみ表示することは**達成できない**（非アクティブ側 split が空表示になる）。本Issueは下記の **per-split 独立 fetch 方式**を採用する。

## バックエンドは既に per-CLI 対応済み

- `src/lib/db/chat-db.ts:185-218`: `getMessages` は `cliToolId` フィルタオプション対応（`AND cli_tool_id = ?`）
- `src/app/api/worktrees/[id]/messages/route.ts`: `?cliTool=` / `?limit=` / `?includeArchived=` クエリ対応済み
- DB schema: 各 message に `cli_tool_id` 列存在
- → **API/DB 側は per-CLI フィルタに対応済み。サーバ実装の新規追加は不要**。残るのは「フロント側を per-split で独立 fetch させる」ことのみ。

## 対応方針（案A: per-split History、per-split 独立 fetch）

### 1. レイアウト変更

各 split を「History + Terminal + Footer」の縦/横 3 領域に再構成。FilePanel は引き続き `terminal` スロット内（`FilePanelSplit`）に存在し、`TerminalSplitContainer` 配下の各 split に History が内包される。

**Before（現状）**:
```
TerminalContainer
├ HistoryPane (activeCliTab のメッセージのみ)
└ terminal スロット = FilePanelSplit
    ├ TerminalSplitContainer [ Split: Claude ] [ Split: Codex ] [ Split: Gemini ]
    └ FilePanel
```

**After（案A）**:
```
TerminalContainer（薄いラッパ or 撤去：§2 参照）
└ terminal スロット = FilePanelSplit
    ├ TerminalSplitContainer
    │   [ Split: Claude            ] [ Split: Codex             ] [ Split: Gemini            ]
    │     ├ History(Claude を独立 fetch)  ├ History(Codex を独立 fetch)  ├ History(Gemini を独立 fetch)
    │     ├ Terminal                      ├ Terminal                     ├ Terminal
    │     └ Footer (Auto-Yes, MI)         └ Footer                       └ Footer
    └ FilePanel
```

### 2. `TerminalContainer` から HistoryPane を削除

`src/components/worktree/TerminalContainer.tsx`:
- `history` prop 廃止。現状 TerminalContainer は `[History | terminal]` の2分割なので、History を外すと **terminal スロット（= FilePanelSplit）のパススルー**になる。
- **TerminalContainer の最終形を明記する**: (a) 単純パススルーとして残すか、(b) 撤去して `WorktreeDetailRefactored` から直接 `FilePanelSplit` を描画するかを実装時に決定（MVP は「薄いパススルーとして残す」を第一候補とし、不要なら撤去）。
- `useHistoryPaneState`（グローバル visible/width、`commandmate:historyPaneStateChange` CustomEvent 同期、HISTORY_PANE_ID）の扱い: **共通 visible/width を維持し、各 split の HistoryPane が同じ `useHistoryPaneState` を参照**する（MVP は全 split 共通折りたたみ。§5 参照）。
- `HISTORY_PANE_ID` / `HistoryExpandBar`（折りたたみ時の展開バー、e2e の `data-testid="history-pane-expand"`）の取り扱いを実装時に確定する。展開バーを各 split 側へ移すか TerminalContainer 側に残すかで e2e セレクタの帰結が変わるため、e2e 依存（`data-testid="history-pane-expand"`）を維持する方針とする。
- 既存テスト `tests/unit/components/worktree/TerminalContainer.test.tsx` は `history` prop と展開バーに依存しているため、削除/変更に伴い更新する（影響ファイル表に記載）。

### 3. `TerminalSplitPaneContent` 内に HistoryPane を内包

`src/components/worktree/TerminalSplitPaneContent.tsx`:
- 既存の `terminal` slot を `[History | Terminal]` の横並びレイアウトに変更
- HistoryPane には、**この split の `cliToolId` で独立 fetch したメッセージ**（§6 の `useSplitMessages`）を渡す

```tsx
// TerminalSplitPaneContent（per-(worktreeId, cliToolId) のスマートペイン）
const { messages, refresh: refreshMessages } = useSplitMessages({
  worktreeId,
  cliToolId,                 // この split の CLI
  limit: historyDisplayLimit, // #701（共通 state を配布）
  includeArchived: showArchived, // #168（共通 state を配布）
});

// メッセージ送信後は自 split の履歴を即時 refresh（§6 / S1-006）
const handleMessageSent = useCallback(() => {
  refresh();          // useTerminalPanePolling（ターミナル）
  refreshMessages();  // 自 split の History
}, [refresh, refreshMessages]);

<TerminalSplitPane
  ...
  terminal={
    <div className="flex h-full">
      <HistoryPane
        messages={messages}        // 自 split の cliToolId で fetch 済み
        onInsertToMessage={...}     // #728 の per-split 挿入ルーティングへ接続（§7）
        showArchived={showArchived}
        onShowArchivedChange={...}
        historyDisplayLimit={historyDisplayLimit}
        historyUserOnly={historyUserOnly}
        onCollapse={toggleHistoryPane} // 共通 useHistoryPaneState.toggle
        // 検索#716 / 展開状態は HistoryPane 内部 state のため per-split で自動独立
      />
      <PaneResizer />
      <TerminalDisplay .../>
    </div>
  }
  footer={...}
/>
```

### 4. `HistoryPane` のフィルタ責務

**フィルタは fetch クエリ（`cliTool`）側で完結**させ、`HistoryPane` は「渡された `messages` をそのまま表示する」設計とする（per-split fetch を採るため、HistoryPane にクライアント側 `cliToolId` フィルタを持たせない）。

- これにより `HistoryPane` への破壊的変更を最小化し、既存 `tests/unit/components/HistoryPane.test.tsx` との互換を維持できる。
- もし将来 HistoryPane 側でも防御的に `cliToolId` を持たせる場合は **optional prop（未指定時は素通し＝従来動作）** の additive 拡張とし、#740/#743 と同型の互換方針を踏襲する。

### 5. `useHistoryPaneState` の per-split 化検討

- 各 split で History 表示/非表示 + 幅を独立管理する場合は `useHistoryPaneState(splitIndex)` のような形に拡張
- **MVP は全 split 共通挙動**: 各 split の HistoryPane が共通の `useHistoryPaneState`（visible/width、CustomEvent 同期）を参照し、`<` 折りたたみ時は全 split の History が同時に折りたたまれる。独立管理は別Issueに切り出す（スコープ調整）。

### 6. メッセージ fetch（per-split 独立 fetch）

> **設計訂正（S1-001）**: 「`state.messages` は全メッセージを保持しているので UI 側フィルタで十分・バックエンド変更不要」という当初記述は**誤り**であり撤回する。`state.messages` は `activeCliTab` の1種類のみを保持しているため、クライアントフィルタ方式では per-split で各 CLI を同時表示できない。

代わりに **#728/#736 の `useTerminalPanePolling` と同型の per-split 独立 fetch** を採用する:

- 新規フック `useSplitMessages({ worktreeId, cliToolId, limit, includeArchived })`（仮称）を新設する。
  - `/api/worktrees/[id]/messages?cliTool=<paneCli>&limit=<#701>&includeArchived=<#168>` を fetch する。
  - `useTerminalPanePolling` と同じ **`requestId` による stale 応答破棄** / **`document.visibilityState` による polling 制御** を踏襲する。
  - `refresh()` を公開し、当該 split のメッセージ送信後（§3 の `handleMessageSent`）に自 split 履歴を即時更新する（**S1-006**: 親 `handleMessageSent` は `activeCliTab` スコープのため非アクティブ split の履歴更新が抜ける問題を解消）。
- API/DB は既に `cliTool` フィルタ対応済みのため、**サーバ実装の新規追加は不要**（フロント側の per-split fetch 追加のみ）。

### per-split / 共通の責務分担（S1-004）

| 機能 | per-split / 共通 | 所在 |
|------|------------------|------|
| 検索 #716・展開状態 | **per-split（自動）** | HistoryPane 内部 state（`useHistorySearch` / `useConversationHistory`） |
| User only トグル #725 | **共通** | 親の単一 state を全 split へ配布、localStorage キーは単一 |
| 表示件数 #701（limit） | **共通** | 親の単一 state を全 split の fetch クエリ（`useSplitMessages` の `limit`）へ配布 |
| showArchived #168 | **共通** | 親の単一 state を全 split の fetch クエリ（`includeArchived`）へ配布 |
| 折りたたみ visible/width | **共通**（MVP） | 共通 `useHistoryPaneState` を全 split が参照 |

> `limit` / `showArchived` は **fetch クエリに効く**ため、per-split 独立 fetch では各 split の `useSplitMessages` 引数として渡す経路を明示する（共通 state → 各 split の fetch 引数）。

## 受入条件

- [ ] PC版で 1-3 split に分割した時、各 split に独立した HistoryPane が表示される
- [ ] スプリットA=Claude, B=Codex の構成で、A History は Claude のメッセージのみ、B History は Codex のメッセージのみ（**同時に**成立。各 split が自分の `cliTool` で独立 fetch するため）
- [ ] スプリットA=Claude, B=Claude の構成で、両方とも Claude のメッセージ（同じ内容。2回 fetch・同一結果）
- [ ] 既存 HistoryPane の機能が per-split / 共通の別に従って動作:
  - 検索 #716・展開状態: per-split で独立
  - User only #725 / 表示件数 #701 / showArchived #168: 全 split 共通（共通 state を各 split の fetch 引数へ配布）
- [ ] 非アクティブ split でメッセージ送信した直後、当該 split の History が即時更新される（自 split の `refresh()`）
- [ ] History の `<` / `>` 折りたたみが各 split で動作（MVP は共通 state＝全 split 同時折りたたみ）
- [ ] worktree切替後も各 CLI の History が正しく表示
- [ ] モバイル版の History 挙動は変更なし
- [ ] 既存テストは PASS（HistoryPane はフィルタを fetch 側に委譲し、渡された messages を表示する従来動作を維持）
- [ ] 新規テスト: per-split fetch（split A=Claude は `cliTool=claude` を fetch し Claude のみ表示、split B=Codex は `cliTool=codex` を fetch し Codex のみ表示）を fetch モックで検証
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS

## 想定影響範囲

### 削除/変更
| ファイル | 変更内容 |
|----------|----------|
| `src/components/worktree/TerminalContainer.tsx` | `history` prop 削除、terminal スロット（FilePanelSplit）のパススルー化（最終形は実装時確定：薄いラッパ or 撤去）、`useHistoryPaneState` / HISTORY_PANE_ID / HistoryExpandBar の扱い整理 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | `historyPaneMemo` の TerminalContainer 渡し削除、各 split で History が描画されるよう変更、共通 state（userOnly/limit/showArchived/折りたたみ）を各 split へ配布 |
| `tests/unit/components/worktree/TerminalContainer.test.tsx` | `history` prop / 展開バー依存の既存テスト更新 |

### 新規/拡張
| ファイル | 変更内容 |
|----------|----------|
| `src/hooks/useSplitMessages.ts` | **新規**: per-(worktreeId, cliToolId) 独立 messages fetch フック（requestId stale-guard / visibility 制御 / refresh()） |
| `src/components/worktree/TerminalSplitPaneContent.tsx` | terminal slot を `[History | Terminal]` 横並びレイアウトに変更、`useSplitMessages` 駆動、`handleMessageSent` で自 split 履歴を refresh |
| `src/components/worktree/HistoryPane.tsx` | （フィルタは fetch 側に委譲のため）必要なら optional `cliToolId` の additive 拡張のみ。基本は props 配線（onInsertToMessage の per-split ルーティング含む） |
| `tests/unit/hooks/useSplitMessages.test.ts` | **新規**: per-split fetch（cliTool クエリ / stale-guard / refresh）の単体テスト |
| `tests/unit/components/HistoryPane.test.tsx` | （**正しいパス**）必要に応じ messages 素通し表示のテスト補強。※当初記載の `tests/unit/components/worktree/HistoryPane.test.tsx` は存在しない |
| `tests/unit/components/worktree/TerminalSplitPaneContent.test.tsx` | per-split History 描画・per-split fetch（cliTool 別）テスト追加 |
| `CLAUDE.md` | モジュールリファレンス更新 |
| `CHANGELOG.md` | [Unreleased] Changed/Added 記載 |

## スコープ外

- メッセージ取得 API / DB の per-CLI フィルタ**実装**（既に `cliTool` フィルタ対応済み。本Issueはフロント側の per-split fetch 追加のみ）
- History 状態（visible / width）の per-split 化（MVP は全 split 共通、別Issueで検討）
- HistoryPane 自体のデザイン変更
- Mobile 版の挙動変更
- メッセージ送信時の CLI 判定ロジック変更（既存 `cliToolId` を流用）

## 関連

- 親Issue: #728（PCターミナル1-3分割）
- 関連修正: #736（Mobile per-split polling 移行）、#740（AutoYesToggle 移行漏れ）、#743（status indicator 移行漏れ）
- 既存実装:
  - `src/components/worktree/HistoryPane.tsx`
  - `src/components/worktree/TerminalContainer.tsx` (#730)
  - `src/components/worktree/TerminalSplitPaneContent.tsx` (#728)
  - `src/hooks/useTerminalPanePolling.ts` (#728 — per-split fetch の参照モデル)
  - `src/lib/db/chat-db.ts` (`getMessages` with cliToolId)
  - `src/app/api/worktrees/[id]/messages/route.ts` (`?cliTool=` / `?limit=` / `?includeArchived=`)
  - `src/types/models.ts` (`ChatMessage` の `cliToolId` 型)

## 検証手順

```bash
# 修正前の症状再現
1. http://localhost:3000 起動
2. 任意 worktree を開く
3. +Split で2分割、左=Claude / 右=Codex
4. History 領域は1つ（activeCliTab のメッセージのみ）で、各 split の Agent に対応した履歴が個別表示されない（バグ）

# 修正後の検証
1. PC版で 2分割、左=Claude / 右=Codex
2. 左 split の History に Claude のメッセージのみ表示（cliTool=claude を独立 fetch）
3. 右 split の History に Codex のメッセージのみ表示（cliTool=codex を独立 fetch）
4. 右 split（非アクティブ側）でメッセージ送信 → 右 split の History が即時更新される
5. 各 split で検索・User onlyトグル等が動作
6. リロード後も状態保持
```

## 実装方針の補足

各 split のレイアウトは以下のように `TerminalSplitPaneContent` 内で構成:

```tsx
// この split の CLI で独立 fetch（#728 useTerminalPanePolling と同型）
const { messages, refresh: refreshMessages } = useSplitMessages({
  worktreeId,
  cliToolId,                      // この split の CLI
  limit: historyDisplayLimit,     // #701（共通 state を配布）
  includeArchived: showArchived,  // #168（共通 state を配布）
});

<TerminalSplitPane
  ...
  terminal={
    <div className="flex h-full">
      {/* 左: History (この split の cliToolId で独立 fetch 済み) */}
      <div style={{ width: historyWidth }} className="flex-shrink-0">
        <HistoryPane messages={messages} onInsertToMessage={...} ... />
      </div>
      <PaneResizer onResize={setHistoryWidth} />
      {/* 右: Terminal */}
      <div className="flex-1 min-w-0">
        <TerminalDisplay .../>
      </div>
    </div>
  }
  footer={footerSlot}
/>
```

`useHistoryPaneState`（visible/width）は全 split 共通で利用（MVP）し、`<` 折りたたみ時は全 split の History が同時に折りたたまれる挙動。`historyDisplayLimit` / `showArchived` / `historyUserOnly` は親の共通 state を各 split の `useSplitMessages` 引数 / HistoryPane props へ配布する。

## レビュー反映履歴 (Stage 2)

Stage 1 レビュー（`dev-reports/issue/744/issue-review/stage1-review-result.json`）の指摘を以下の通り反映:

- **S1-001 (Must Fix)**: 設計前提「`state.messages` は全CLI保持・UI側フィルタで十分・バックエンド変更不要」を撤回。`state.messages` は `activeCliTab` の1種類のみ保持である事実（`fetchMessages` の `?cliTool=` サーバ側フィルタ）を §現状アーキテクチャ / §6 に明記し、per-split 独立 fetch（`useSplitMessages`）方式に修正。スコープ外の「メッセージ取得 API の per-CLI 化」も実態（API/DB は対応済み・フロント側 per-split fetch のみ追加）に訂正。
- **S1-002 (Must Fix)**: 受入条件（A=Claude / B=Codex 同時表示）を per-split fetch 設計と整合させ、新規テストを per-split fetch モック検証に具体化。
- **S1-003 (Should Fix)**: テストパスを `tests/unit/components/HistoryPane.test.tsx`（実在）に修正。`TerminalSplitPaneContent.test.tsx` は正しいパスを維持。`useSplitMessages` 単体テストを影響ファイルに追加。
- **S1-004 (Should Fix)**: 検索#716 / User only#725 / 表示件数#701 / showArchived#168 の per-split / 共通の別を表で明記。limit/showArchived は fetch クエリに効くため各 split の fetch 引数へ配布する経路を明示。
- **S1-005 (Should Fix)**: FilePanel が `terminal` スロット内（FilePanelSplit）にある実構造に §1/§2 のレイアウト図を訂正。TerminalContainer の最終形・`useHistoryPaneState` / HISTORY_PANE_ID / HistoryExpandBar（e2e `data-testid="history-pane-expand"`）/ `TerminalContainer.test.tsx` 更新を明記。
- **S1-006 (Should Fix)**: 親 `handleMessageSent` が `activeCliTab` スコープである点を踏まえ、`useSplitMessages.refresh()` で自 split 履歴を即時更新する経路を §3/§6・受入条件に追加。
- **S1-007 (Nice to Have)**: HistoryPane へ配る props（共通配布 / per-split 配慮）と `onInsertToMessage` の #728 per-split 挿入ルーティング整合を §3 に明記。
- **S1-008 (Nice to Have)**: フィルタ責務を fetch クエリ側に統一し、HistoryPane は渡された messages を表示するだけとする方針を §4 に明記（cliToolId クライアントフィルタは不要。必要時のみ additive optional prop）。
