# Issue #688 仮説検証レポート

## 対象Issue
PC版にて、「History/Files/CMATE」タブの表示領域の表示/非表示を切り替え可能にしてほしい

## 判定サマリー

| # | 仮説/前提条件 | 判定 | 補足 |
|---|-------------|------|------|
| 1 | `WorktreeUIState` に `leftPaneCollapsed` を追加可能 | Confirmed | `LayoutState` インターフェースに追加可能 |
| 2 | `TOGGLE_LEFT_PANE` アクションを useReducer に追加可能 | Confirmed | `WorktreeUIAction` 型に追加可能 |
| 3 | `WorktreeDesktopLayout.tsx` が左右2分割レイアウトを管理している | Confirmed | `leftWidth` stateをパーセンテージで管理 |
| 4 | `LeftPaneTabSwitcher.tsx` が左パネルのタブUIを担当 | Confirmed | History/Files/CMATEの3タブ構成 |
| 5 | `useLocalStorageState` フックが存在し再利用可能 | Confirmed | `src/hooks/useLocalStorageState.ts` に実装済み |
| 6 | `tests/unit/components/WorktreeDetailRefactored.test.tsx` が存在 | Confirmed | 新規テストの追加先として適切 |
| 7 | モバイル版は `MobileLayout` で別処理されている | Confirmed | `useIsMobile()` での分岐が `WorktreeDesktopLayout` に実装済み |

## 詳細検証

### 1. WorktreeUIState の構造
- **ファイル**: `src/types/ui-state.ts`
- **現状**: `LayoutState` に `leftPaneTab: LeftPaneTab` は存在するが `leftPaneCollapsed` は未実装
- **判定**: Confirmed — 追加が必要

### 2. useReducer のアクション構造
- **ファイル**: `src/types/ui-actions.ts` / `src/hooks/useWorktreeUIState.ts`
- **現状**: `TOGGLE_LEFT_PANE` アクションは存在しない。`SET_LEFT_PANE_TAB` は実装済み
- **判定**: Confirmed — 追加が必要

### 3. WorktreeDesktopLayout のレイアウト管理
- **ファイル**: `src/components/worktree/WorktreeDesktopLayout.tsx`
- **現状**: `leftWidth` (パーセンテージ) を `useState` で管理、`PaneResizer` でリサイズ可能
- **補足**: 折りたたみ時は `leftWidth=0` または条件分岐でDOMから除外する方式が考えられる
- **判定**: Confirmed

### 4. localStorage 永続化の実装パターン
- **ファイル**: `src/hooks/useLocalStorageState.ts`
- **現状**: 汎用 `useLocalStorageState` フックが実装済み
- **補足**: `SidebarContext.tsx` は独自の `useLocalStorageSync` パターンを使用。`useLocalStorageState` フックの利用が推奨
- **判定**: Confirmed

### 5. 既存テスト構造
- **ファイル**: `tests/unit/components/WorktreeDetailRefactored.test.tsx` 他
- **現状**: 複数のテストファイルが存在する
- **判定**: Confirmed

## Stage 1 への申し送り事項

なし（機能追加Issueのため、否定された仮説はない）
