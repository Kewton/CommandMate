# Issue #391 仮説検証レポート

## 検証日時
- 2026-03-02

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `AgentSettingsPane`のPATCH API呼び出し条件：選択数がちょうど2の時のみ（L152） | Confirmed | `AgentSettingsPane.tsx:152` `if (next.size === MAX_SELECTED_AGENTS)` を確認 |
| 2 | `WorktreeDetailRefactored`はポーリングでfetchWorktree()を呼び、毎回setSelectedAgents()を実行（L1035-1036） | Confirmed | `WorktreeDetailRefactored.tsx:1035-1036` および `L1796-1804` でポーリング設定を確認 |
| 3 | `AgentSettingsPane`のuseEffect（L98-100）がselectedAgents prop変更でcheckedIdsを上書き | Confirmed | `AgentSettingsPane.tsx:98-100` を確認 |

## 詳細検証

### 仮説 1: PATCH APIは選択数が2の時のみ呼ばれる

**Issue内の記述**: `AgentSettingsPane`はチェックボックスが**ちょうど2つ選択された時のみ**PATCH APIを呼ぶ設計（`handleCheckboxChange` L152）

**検証手順**:
1. `src/components/worktree/AgentSettingsPane.tsx` の L141-176 を確認

**判定**: Confirmed

**根拠**:
```tsx
// L141-173: handleCheckboxChange
const handleCheckboxChange = useCallback(
  async (toolId: CLIToolType, checked: boolean) => {
    const next = new Set(checkedIdsRef.current);
    if (checked) {
      next.add(toolId);
    } else {
      next.delete(toolId);
    }
    setCheckedIds(next);

    // Only persist when exactly 2 are selected
    if (next.size === MAX_SELECTED_AGENTS) {  // L152: MAX_SELECTED_AGENTS=2
      // ... PATCH API call ...
    }
  }, ...
);
```

---

### 仮説 2: ポーリングでfetchWorktree()が定期呼び出しされ毎回setSelectedAgents()が実行される

**Issue内の記述**: `WorktreeDetailRefactored`は`fetchWorktree()`を定期ポーリングしており（IDLE: 5秒/ACTIVE: 2秒、L1796-1804）、毎回サーバーから`selectedAgents`を取得して`setSelectedAgents()`を呼ぶ（L1035-1036）

**検証手順**:
1. `src/components/worktree/WorktreeDetailRefactored.tsx` の L1026-1050 と L1792-1807 を確認

**判定**: Confirmed

**根拠**:
```tsx
// L1026-1037: fetchWorktree関数
const fetchWorktree = useCallback(async (): Promise<Worktree | null> => {
  // ...
  const data: Worktree = await response.json();
  setWorktree(data);
  // Issue #368: Sync selectedAgents from API response
  if (data.selectedAgents) {
    setSelectedAgents(data.selectedAgents);  // L1035-1036: 毎回呼ばれる
  }
  // ...
}, ...);

// L1792-1807: ポーリング設定
const pollingInterval = state.terminal.isActive
  ? ACTIVE_POLLING_INTERVAL_MS   // ACTIVE状態
  : IDLE_POLLING_INTERVAL_MS;    // IDLE状態

const pollData = async () => {
  await Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()]);
};
const intervalId = setInterval(pollData, pollingInterval);
```

**注記**: Issue記載の行番号（L1796-1804）は実際のコード（L1792-1807）と若干ズレているが、動作内容は完全一致。

---

### 仮説 3: useEffectがselectedAgents prop変更でcheckedIdsを無条件上書き

**Issue内の記述**: `AgentSettingsPane`の`useEffect`（L98-100）が`selectedAgents` propの変更を検知し、ローカルの`checkedIds`をサーバーの古い値で上書きする

**検証手順**:
1. `src/components/worktree/AgentSettingsPane.tsx` の L97-100 を確認

**判定**: Confirmed

**根拠**:
```tsx
// L97-100: selectedAgents propの変更を検知してcheckedIdsを上書き
useEffect(() => {
  setCheckedIds(new Set(selectedAgents));
}, [selectedAgents]);
```

guardは一切なく、`isEditing`フラグ等の保護機構も存在しない。`selectedAgents`が変化するたびに（React参照変化含む）無条件でローカルstateが上書きされる。

---

## 再現フロー（確認済み）

```
User unchecks → checkedIds.size=1 → API NOT called (requires 2)  [AgentSettingsPane.tsx:152]
         ↓ (2-5秒後)
Polling → fetchWorktree() → setSelectedAgents(old value from server)  [WorktreeDetailRefactored.tsx:1035-1036]
         ↓
useEffect → setCheckedIds(new Set(selectedAgents)) → Reverted!  [AgentSettingsPane.tsx:98-100]
```

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedであり、Issue内の根本原因分析は正確
- 修正方針（案A+案B組み合わせ）の妥当性検証が必要:
  - 案A（isEditingフラグ）: `isEditing=true`時のリセット方法、タイムアウト処理の要否
  - 案B（同一値チェック）: `setSelectedAgents()`をスキップする条件の正確な定義
- 受入条件の網羅性確認（エラー時リバート、ページリロード時の正常動作）
