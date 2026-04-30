# Issue #683 作業計画書

## 概要

`useFileTabs` フックの戻り値をオブジェクトリテラルからタプル `[state, actions]` に変更することで、消費側の deps 安定性問題を根治する（B案採用）。

## 採用方針: B案（state/actions タプル分離）

```ts
// Before
return { state, dispatch, openFile, ... };

// After
return [state, actions] as const;  // actions は useMemo で完全 stable
```

## タスク一覧

### Task 1: `useFileTabs.ts` の型・実装変更

**ファイル**: `src/hooks/useFileTabs.ts`

1. `FileTabsActions` インターフェースを追加・export
   - `dispatch, openFile, closeTab, activateTab, onFileRenamed, onFileDeleted, moveToFront` を含む
2. `UseFileTabsReturn` インターフェースを削除
3. フック戻り値型を `readonly [FileTabsState, FileTabsActions]` に変更
4. `actions` オブジェクトを `useMemo` でラップ（stable 参照を保証）
5. `return [state, actions] as const` に変更

### Task 2: `tests/unit/hooks/useFileTabs.test.ts` の追従修正

**ファイル**: `tests/unit/hooks/useFileTabs.test.ts`

1. `result.current.state` → `result.current[0]` に変更
2. `result.current.openFile` 等 → `result.current[1].openFile` 等に変更
3. `UseFileTabsReturn` の import を `FileTabsActions` に変更（必要に応じて）
4. actions 参照安定性テストを追加（連続 render で `Object.is` 同一を確認）

### Task 3: `WorktreeDetailRefactored.tsx` の消費側追従

**ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`

1. `const fileTabs = useFileTabs(worktreeId)` → `const [tabsState, tabsActions] = useFileTabs(worktreeId)` に変更
2. `fileTabs.state` → `tabsState` に変更（JSX props: line 1418）
3. `fileTabs.xxx` → `tabsActions.xxx` に変更（全メソッド参照）
4. deps 配列を更新（`fileTabs` 全体 → 個別アクション参照）

**変更箇所（9箇所）**:
- line 546, 547: `fileTabs.openFile` → `tabsActions.openFile`
- line 551: deps `[..., fileTabs, ...]` → `[..., tabsActions.openFile, ...]`
- line 565: `fileTabs.openFile` → `tabsActions.openFile`
- line 570: deps `[..., fileTabs, ...]` → `[..., tabsActions.openFile, ...]`
- line 577: `fileTabs.openFile` → `tabsActions.openFile`
- line 581: deps `[..., fileTabs, ...]` → `[..., tabsActions.openFile, ...]`
- line 868: `fileTabs.onFileRenamed` → `tabsActions.onFileRenamed`
- line 875: deps `[..., fileTabs, ...]` → `[..., tabsActions.onFileRenamed, ...]`
- line 897: `fileTabs.onFileDeleted` → `tabsActions.onFileDeleted`
- line 904: deps `[..., fileTabs, ...]` → `[..., tabsActions.onFileDeleted, ...]`
- line 1302: `fileTabs.dispatch` → `tabsActions.dispatch`
- line 1304: deps `[fileTabs.dispatch]` → `[tabsActions.dispatch]`
- line 1307: `fileTabs.dispatch` → `tabsActions.dispatch`
- line 1309: deps `[fileTabs.dispatch]` → `[tabsActions.dispatch]`
- line 1312: `fileTabs.dispatch` → `tabsActions.dispatch`
- line 1314: deps `[fileTabs.dispatch]` → `[tabsActions.dispatch]`
- line 1318: `fileTabs.dispatch` → `tabsActions.dispatch`
- line 1320: deps `[fileTabs.dispatch]` → `[tabsActions.dispatch]`
- line 1418: `fileTabs={fileTabs.state}` → `fileTabs={tabsState}`
- line 1420: `onCloseTab={fileTabs.closeTab}` → `onCloseTab={tabsActions.closeTab}`
- line 1421: `onActivateTab={fileTabs.activateTab}` → `onActivateTab={tabsActions.activateTab}`
- line 1430: `onMoveToFront={fileTabs.moveToFront}` → `onMoveToFront={tabsActions.moveToFront}`
- line 1434: deps 内の `fileTabs.state, fileTabs.closeTab, fileTabs.activateTab, fileTabs.moveToFront` を更新

### Task 4: `WorktreeDetailRefactored.test.tsx` のモック更新

**ファイル**: `tests/unit/components/WorktreeDetailRefactored.test.tsx`

- モックをタプル形式に変更
- `moveToFront: vi.fn()` を追加

```ts
vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn().mockReturnValue('opened'),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));
```

### Task 5: `WorktreeDetailRefactored-cli-tab-switching.test.tsx` のモック更新

**ファイル**: `tests/unit/components/worktree/WorktreeDetailRefactored-cli-tab-switching.test.tsx`

- Task 4 と同様のモック更新

## 完了条件

- [ ] `FileTabsActions` 型が export されている
- [ ] `UseFileTabsReturn` 型が削除されている
- [ ] `useFileTabs` の戻り値が `readonly [FileTabsState, FileTabsActions]` になっている
- [ ] `actions` が `useMemo` でラップされており連続 render で同一参照
- [ ] `tests/unit/hooks/useFileTabs.test.ts` が全 pass
- [ ] actions 参照安定性テストが追加・pass
- [ ] `WorktreeDetailRefactored.tsx` の消費側が全て更新済み
- [ ] 両テストファイルのモックがタプル形式に更新済み
- [ ] `npx tsc --noEmit` がエラー0
- [ ] `npm run lint` がエラー0
- [ ] `npm run test:unit` が全 pass
