# Issue #747 作業計画

**タイトル**: feat(layout): move sidebar toggle (hamburger) from DesktopHeader to top of ActivityBar (PC)
**作成日**: 2026-06-01
**ブランチ**: feature/747-worktree
**種別**: PC専用UI変更（レイアウト）

## ゴール
PC版のサイドバートグル（ハンバーガー☰）を `DesktopHeader` 左端から `ActivityBar` 最上部へ移動する。モバイル経路は不変。

## 前提（仮説検証・レビュー済みの確定事実）
- `ActivityBar.tsx`: root が `role="tablist" aria-orientation="vertical"`、`w-12 flex flex-col items-stretch`。`ACTIVITIES.map` で6 tab を描画。`handleKeyDown` は `ACTIVITIES.length` / `buttonRefs` index ベース。
- `DesktopHeader`（`WorktreeDetailSubComponents.tsx`）: ハンバーガー＋separator は既に `{onMenuClick !== undefined && (<>...</>)}` でガードされ、内部に三本線SVG（path `M4 6h16M9 12h15M4 18h16`）。
- `WorktreeDetailRefactored.tsx`: `ActivityBar` 呼び出し（activeActivity/onActivityChange のみ）、`DesktopHeader` に `onMenuClick={toggle}`（toggle は L230 `useSidebarContext()` 由来）。
- `SidebarContext`: `useSidebarContext()` が `{ isOpen: boolean, toggle: () => void, ... }` を返す。
- `Tooltip`（`src/components/common/Tooltip.tsx`）: `content` / `placement` props、ActivityBar で既に利用。
- `onMenuClick` consumer は2箇所のみ。ActivityBar/DesktopHeader はそれぞれ単一呼び出し元（PC版のみ）。
- テスト: `ActivityBar.test.tsx`・DesktopHeaderテストは**存在しない**（新規作成）。e2e に activity-bar/tablist 参照なし。

## タスク分解

### T1: ActivityBar に sidebar toggle ボタンを追加（メイン）
**ファイル**: `src/components/worktree/ActivityBar.tsx`
- `useSidebarContext` を import（`@/contexts/SidebarContext`）し、`const { isOpen: isSidebarOpen, toggle: toggleSidebar } = useSidebarContext();`。
- **構造（must-fix M1 対応）**: toggle ボタンを `role="tablist"` の**外側**に配置する。root を以下の形に変更:
  ```tsx
  <div className="flex flex-col items-stretch w-12 flex-shrink-0 border-r ... bg-gray-50 dark:bg-gray-900">
    {/* Sidebar toggle (top, separated, NOT a tab) */}
    <Tooltip content="Toggle sidebar" placement="right">
      <button
        type="button"
        data-testid="activity-bar-toggle-sidebar"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
        aria-expanded={isSidebarOpen}
        className="flex items-center justify-center h-12 w-full text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M9 12h15M4 18h16" />
        </svg>
      </button>
    </Tooltip>
    {/* Separator */}
    <div className="border-b border-gray-200 dark:border-gray-700 mx-2 my-1" aria-hidden="true" />
    {/* Activity tabs */}
    <div role="tablist" aria-orientation="vertical" aria-label="Activity Bar" className="flex flex-col items-stretch">
      {ACTIVITIES.map(...)}  {/* 既存ロジックそのまま */}
    </div>
  </div>
  ```
- **重要**: 既存の `buttonRefs`・`handleKeyDown`・`ACTIVITIES.map` のindex計算は**変更しない**（toggle はこのループ外なので index 干渉なし）。
- SVG path は `M4 6h16M9 12h15M4 18h16` を**そのままCOPY**（既存挙動維持。should-fix）。
- separator / svg に `aria-hidden="true"`（consider）。
- root の `aria-label="Activity Bar"` は tablist 側に移すか、root は role なしの単純 div とする（上記案では tablist 内側に移動）。

### T2: DesktopHeader からハンバーガー＋区切り線を削除
**ファイル**: `src/components/worktree/WorktreeDetailSubComponents.tsx`
- `{onMenuClick !== undefined && (<> <button...>☰</button> <div separator /> </>)}` ブロック全体を**物理削除**（dead-code 化を避ける）。
- `DesktopHeaderProps` から `onMenuClick?` を削除（consumer は T3 で除去するため）。
  - ※後方互換性を最大限重視するなら optional のまま残す選択もあるが、レビュー方針＝dead-code削除のため prop も除去を基本とする。残骸の未使用 import がないか確認。
- 左端が Breadcrumb（← worktree名）から始まることを確認。

### T3: WorktreeDetailRefactored から onMenuClick 受け渡しを削除
**ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`
- `<DesktopHeader ... onMenuClick={toggle} ... />` の `onMenuClick={toggle}` 行を削除。
- `const { isOpen: _sidebarIsOpen, toggle } = useSidebarContext();`（L230）の `toggle` が他で未使用になる場合は ESLint unused 対策（`toggle` を destructure から外す or `_toggle`）。**注意**: ActivityBar 自身が `useSidebarContext()` を呼ぶようになるため、Refactored 側で toggle が不要になる可能性大 → 要確認・除去。
- ActivityBar 呼び出し側は変更不要（ActivityBar が自前で context 利用）。

### T4: 回帰テスト追加（新規）
**ファイル**: `tests/unit/components/worktree/ActivityBar.test.tsx`（新規作成）
- `SidebarProvider`（または `useSidebarContext` の mock）でラップしてレンダリング。
- テストケース:
  1. `data-testid="activity-bar-toggle-sidebar"` のボタンが描画される。
  2. ボタンに `aria-label="Toggle sidebar"` がある。
  3. クリックで `toggle`（context）が呼ばれる / `aria-expanded` が isOpen を反映。
  4. toggle ボタンが `role="tab"` を**持たない**こと（tablist 外 = ARIA整合のリグレッションガード）。
  5. 既存6 Activity tab（role="tab"）が引き続き描画される（count=6）。
  6. （任意）ArrowDown/Up ナビが従来どおり6 tab 間で循環する（toggle がindexに混入しない回帰防止）。
- DesktopHeader テストは既存なしのため新規不要（ActivityBar 側で sidebar toggle を担保。必要なら `WorktreeDetailSubComponents` の DesktopHeader にハンバーガーが無いことの軽い回帰テストを追加検討するが、テスト基盤が無いため optional）。

### T5: ドキュメント更新
- `CLAUDE.md`: モジュールリファレンスの `ActivityBar.tsx` 行に「Issue #747で最上部に sidebar toggle ボタン（tablist外・`useSidebarContext`）+ separator 追加」、`WorktreeDetailSubComponents.tsx` 行に「Issue #747で DesktopHeader からハンバーガー＋区切り線削除・onMenuClick 除去」を追記。
- `CHANGELOG.md`: `[Unreleased]` の `Changed` に PC sidebar toggle 移設を記載。

## 依存関係 / 実装順序
```
T1 (ActivityBar) ─┐
T2 (DesktopHeader)─┼─→ T3 (Refactored 配線除去) ─→ T4 (テスト) ─→ T5 (docs)
                   │   (T3 は T1/T2 の API変更に依存)
```
- 推奨順: T1 → T2 → T3（配線整合）→ 静的解析（tsc/lint）→ T4（テスト）→ T5（docs）。
- TDD観点: T4 のテストを先に書き（Red）、T1 実装で Green にする運用が望ましい。

## テスト計画
- `npm run test:unit`（ActivityBar.test.tsx 新規 + 既存全green）
- `npx tsc --noEmit`（型エラー0）
- `npm run lint`（unused 警告0：特に Refactored の toggle、DesktopHeader の onMenuClick 残骸）
- `npm run build`（Next.js ビルド成功）

## リスク / 留意点
| リスク | 対策 |
|--------|------|
| toggle を tablist 内に置き Arrow ナビ index が壊れる | T1 で tablist 外配置を厳守。T4 で回帰テスト（toggle に role="tab" なし / 6tab維持） |
| `toggle` / `onMenuClick` 削除で unused 変数 → lint fail | T3 で destructure 整理、tsc/lint で確認 |
| アクセシビリティ: tablist に非tab子が混在 | tablist を内側 div に分離（T1案） |
| SVG path を勝手に対称化して見た目変化 | `M4 6h16M9 12h15M4 18h16` をそのままCOPY |
| モバイル波及 | ActivityBar は PC専用マウント。MobileHeader/openMobileDrawer は無改修 |

## 完了条件（受入条件マップ）
- [ ] PC版 ActivityBar 最上部に ☰ 表示（T1）
- [ ] クリックで Branches サイドバー開閉（T1, toggle）
- [ ] ☰ と Files の間に separator（T1）
- [ ] hover で「Toggle sidebar」tooltip（T1, Tooltip）
- [ ] aria-label / aria-expanded（T1）
- [ ] data-testid="activity-bar-toggle-sidebar"（T1）
- [ ] DesktopHeader からハンバーガー＋区切り線が消える（T2）
- [ ] モバイル不変（無改修で担保）
- [ ] lint / tsc / test:unit / build 全PASS
- [ ] 回帰テスト追加（T4）
- [ ] CLAUDE.md / CHANGELOG.md 更新（T5）
