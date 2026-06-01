# Issue #730 仮説検証レポート (Phase 0.5)

**対象Issue**: #730 fix(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#727 follow-up)
**検証日**: 2026-05-30
**検証担当**: Claude (PM Auto Issue2Dev)

## 抽出した仮説・主張一覧

| # | 種別 | 内容 | 出典（Issue内記述） |
|---|------|------|---------------------|
| H1 | 前提 | `ActivityBar.tsx:103` で `title={activity.label}` 設定 | 「問題1」セクション |
| H2 | 前提 | `WorktreeDetailRefactored.tsx:1727-1749` のJSX構造 | 「問題2」セクション |
| H3 | 前提 | ActivityBar 6アイコン定義（Files/Git/Notes/Schedules/Agent/Timer） | 「対応方針」 |
| H4 | 前提 | ActivityBar は WorktreeDesktopLayout の `activityBar` prop 経由で内部に閉じ込められている | 「問題2」 |
| H5 | 前提 | History は独立した第3カラム | 「問題3」 |
| H6 | 前提 | localStorage 永続化キー `commandmate:historyVisible` / `commandmate:historyWidth` | 「受入条件 History 内包」 |
| H7 | 仮説 | `title` 属性によるブラウザネイティブツールチップは約500ms 遅延 | 「問題1」 |
| H8 | 仮説 | 6アイコン中 Agent / Timer がスクロール領域に押し出されて見えない（実機検証で確認） | 「問題2」 |
| H9 | 前提 | `useHistoryPaneState` がhistory表示状態を管理 | 「TerminalContainer」コード例 |
| H10 | 前提 | `src/components/common/Tooltip.tsx` および `src/components/worktree/TerminalContainer.tsx` は未実装（新規追加対象） | 「想定影響範囲」 |

---

## 検証結果

### H1: ActivityBar.tsx:103 で `title={activity.label}` 設定

**判定**: ✅ **Confirmed**

`src/components/worktree/ActivityBar.tsx:103` で `title={activity.label}` を確認。
追加発見: `aria-label={activity.label}` (L101) も併存しており、Tooltip 化する場合は `title` 削除と同時に `aria-describedby` 連携で `aria-label` との重複を避ける必要あり。

---

### H2: WorktreeDetailRefactored.tsx:1727-1749 のJSX構造

**判定**: ✅ **Confirmed**

`src/components/worktree/WorktreeDetailRefactored.tsx` の該当範囲は:
- L1727-1736: `<WorktreeDesktopLayout activityBar={activityBarMemo} activityPane={...} historyPane={...} rightPane={...} ...>`
- L1738-1747: NavigationButtons（条件付き）
- L1748-1757: MessageInput

実際の縦方向構造（外側）:
```
<div className="h-full flex flex-col relative">  (L1703)
  <DesktopHeader />                                (L1705)
  <BranchMismatchAlert />                          (L1719-1725, 条件付き)
  <div className="flex-1 min-h-0">                 (L1726)
    <WorktreeDesktopLayout ... />                  (L1727-1736)
  </div>
  <NavigationButtons (wrapper)>                    (L1739-1747, 条件付き)
  <MessageInput (wrapper)>                         (L1748-1757)
  <PromptPanel (overlay)>                          (L1759-1771)
</div>
```

→ Issueの「ActivityBarが WorktreeDesktopLayout の内部に閉じ込められており、MessageInput が下にあるため縦領域が圧縮される」という主張は構造的に正しい。

---

### H3: ActivityBar 6アイコン定義

**判定**: ✅ **Confirmed**

`src/config/activity-bar-config.ts:40-47`:
```ts
export const ACTIVITIES: readonly ActivityDefinition[] = [
  { id: 'files', label: 'Files', icon: File },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'timer', label: 'Timer', icon: Timer },
] as const;
```

各アイコンは 48px × 48px (`h-12 w-12`)、合計縦サイズ約 288px。

---

### H4: ActivityBar は WorktreeDesktopLayout 内部に配置

**判定**: ✅ **Confirmed**

- 親側: `WorktreeDetailRefactored.tsx:1728` `activityBar={activityBarMemo}` で渡す
- 子側: `WorktreeDesktopLayout.tsx:325-332` で `activity-bar-slot` div 内に描画
- 結論: ActivityBar の最大高さ = WorktreeDesktopLayout コンテナの高さ = `(viewport - header - branchMismatch - navButtons - messageInput)`

---

### H5: History は独立した第3カラム

**判定**: ✅ **Confirmed**

`WorktreeDesktopLayout.tsx:1-7` JSDocコメントで明示:
> `[ActivityBar 48px] + Resizer + [ActivityPane (variable, optional)] + Resizer + [HistoryPane (variable, optional)] + Resizer + [Right (flex)]`

L348-362 で historyPane を `ResizableColumn` として独立カラム描画。

---

### H6: localStorage 永続化キー名

**判定**: ❌ **Rejected**

Issue 記述: `commandmate:historyVisible` / `commandmate:historyWidth` (コロン区切り)

**実コード** (`src/hooks/useHistoryPaneState.ts:22-23`):
```ts
export const HISTORY_VISIBLE_STORAGE_KEY = 'commandmate.worktree.historyVisible';
export const HISTORY_WIDTH_STORAGE_KEY = 'commandmate.worktree.historyWidth';
```

→ Issueの受入条件のキー名が誤り。正: `commandmate.worktree.historyVisible` / `commandmate.worktree.historyWidth` (ドット区切り)。

**Stage 1への申し送り**: 受入条件のキー名を実コードに合わせて修正する必要あり。CLAUDE.md にも `useHistoryPaneState.ts` の節で `commandmate.worktree.activeActivity` / `historyVisible` / `historyWidth` と記載されており、ドット区切りが正である。

---

### H7: ブラウザネイティブ tooltip 約500ms 遅延

**判定**: ✅ **Confirmed** (ブラウザ仕様)

主要ブラウザ（Chrome/Firefox/Safari）の `title` 属性 tooltip は約500-700ms 遅延が標準。即時表示するにはカスタム実装が必須。
ダークテーマ非対応も事実（OS/ブラウザのデフォルトスタイルに依存）。

---

### H8: 6アイコン中 Agent / Timer が見えない

**判定**: ⚠️ **Partially Confirmed (条件依存)**

ActivityBar 自身は `flex flex-col items-stretch w-12 flex-shrink-0` のみで `overflow-y-auto` 等のスクロール設定なし。
親 `activity-bar-slot` も `flex-shrink-0` のみ。

- アイコン合計 = 6 × 48px = **288px**
- WorktreeDesktopLayout の高さ < 288px の場合、下方アイコンが**クリップ**される
- 標準デスクトップ画面 (>=768px) でも、Header (約56px) + MessageInput (約100-150px) + 余白を引くと、画面分割や DevTools 開で 288px を切る可能性あり

→ 「実機検証で問題2が顕在化」というIssue記述は再現性のある観察。`overflow-y-auto` の追加でも回避可能だが、Issue の方針通り「全高貫通」させる方が VS Code 流の正攻法。

---

### H9: `useHistoryPaneState` がhistory表示状態を管理

**判定**: ✅ **Confirmed (ただし API 名に差異あり)**

実 API (`src/hooks/useHistoryPaneState.ts:30-39`):
```ts
export interface UseHistoryPaneStateReturn {
  visible: boolean;   // ← Issue サンプルコードの `isVisible` ではない
  width: number;
  toggle: () => void; // ← Issue サンプルコードに含まれない
  setWidth: (next: number) => void;
}
```

Issue「実装方針」セクションのコードサンプル `const { isVisible, width, setWidth } = useHistoryPaneState();` は誤り。正: `const { visible, width, toggle, setWidth }`。

**Stage 1への申し送り**: Issue 内サンプルコードの API 名を実装と整合させる必要あり。

---

### H10: 新規ファイル `Tooltip.tsx` / `TerminalContainer.tsx` は未実装

**判定**: ✅ **Confirmed**

- `src/components/common/` 配下: LocaleSwitcher / LogoutButton / NotificationDot / ThemeToggle / Toast のみ → Tooltip なし
- `src/components/worktree/` 配下に TerminalContainer なし
- 両ファイルは本Issueで新規作成対象として正当

---

## サマリー

| 判定 | 件数 | 仮説# |
|------|------|------|
| Confirmed | 7 | H1, H2, H3, H4, H5, H7, H10 |
| Partially Confirmed | 1 | H8 (条件依存だが実機観察は正) |
| Rejected | 1 | H6 (localStorage キー名誤り) |
| API 差異 | 1 | H9 (`isVisible` → `visible`, `toggle` 抜け) |

## Stage 1への申し送り事項

1. **必須修正(Must Fix)**: H6 — 受入条件「History 内包」セクション内の localStorage キー名を **`commandmate.worktree.historyVisible` / `commandmate.worktree.historyWidth`** （ドット区切り）に修正する。
2. **推奨修正(Should Fix)**: H9 — 「実装方針 3. TerminalContainer」のコードサンプル `const { isVisible, width, setWidth } = useHistoryPaneState();` を `const { visible, width, toggle, setWidth } = useHistoryPaneState();` に修正する（折りたたみは `toggle()` を使う）。
3. **構造的に注意(Should Fix)**: 「変更後」のJSX例で Header / BranchMismatchAlert / NavigationButtons / PromptPanel の取り扱いが省略されている。実装時にこれらをどこに配置するか（ActivityBar の右側で全高フルカラム内に集約する想定か）を明確化すべき。
4. **アクセシビリティ(Should Fix)**: ActivityBar の各ボタンには既に `aria-label={activity.label}` が設定されている (L101)。Tooltip 化時に `aria-describedby` を追加する場合、`aria-label` と Tooltip コンテンツの重複読み上げを避けるため、`title` 削除に加えて読み上げ仕様を明示する必要あり。
