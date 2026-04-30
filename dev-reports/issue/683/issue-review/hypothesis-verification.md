# Issue #683 仮説検証レポート

## 検証対象

Issue: "refactor: useFileTabs の戻り値が毎レンダー新オブジェクトになる構造を改善"

---

## 仮説・主張一覧と検証結果

### 仮説 1: `src/hooks/useFileTabs.ts:384` の戻り値がオブジェクトリテラルである

**判定**: Confirmed（確認済み）

**根拠**: `src/hooks/useFileTabs.ts:387`（実際の行番号）にて以下のコードを確認：
```ts
return { state, dispatch, openFile, closeTab, activateTab, onFileRenamed, onFileDeleted, moveToFront };
```
オブジェクトリテラルで毎レンダー新参照が生成されることを確認。

---

### 仮説 2: 個別メソッド（openFile, closeTab 等）は内部で `useCallback` で stable にしてある

**判定**: Confirmed（確認済み）

**根拠**: `src/hooks/useFileTabs.ts` にて以下を確認：
- `openFile`: `useCallback`（line 348）
- `closeTab`: `useCallback`（line 367）
- `activateTab`: `useCallback`（line 371）
- `onFileRenamed`: `useCallback`（line 375）
- `onFileDeleted`: `useCallback`（line 379）
- `moveToFront`: `useCallback`（line 383）

全メソッドが `useCallback` でラップされており、stable な参照を持つ。

---

### 仮説 3: 消費側で `[fileTabs]` と書くと潜在的バグの温床になる

**判定**: Confirmed（確認済み）

**根拠**: `src/components/worktree/WorktreeDetailRefactored.tsx` にて以下を確認：
- line 551: `}, [isMobile, fileTabs, showTabLimitToast]` ← fileTabs 全体を deps に使用
- line 570: `}, [isMobile, fileTabs, showTabLimitToast]` ← 同上
- line 581: `}, [fileTabs, showTabLimitToast]` ← 同上
- line 875: `}, [worktreeId, fileTabs, tError]` ← 同上
- line 904: `}, [worktreeId, editorFilePath, fileTabs, tCommon, tError]` ← 同上

毎レンダーで新しい `fileTabs` オブジェクトが deps に入るため、これらの `useCallback` も毎レンダー再生成される。

一方、line 1304, 1309, 1314, 1320 では `[fileTabs.dispatch]` のように個別プロパティを使って回避している実例もある。

---

## 申し送り事項（Stage 1 レビューへ）

- 戻り値がオブジェクトリテラルである事実は Issue 記載通り正確
- `useCallback` による安定化は個々のメソッドには適用済みだが、戻り値オブジェクト自体が毎回新参照になるため消費側での安定化が崩れている
- 消費側の `WorktreeDetailRefactored.tsx` では `fileTabs` 全体を deps に使う箇所が複数存在し、Issue #675・#682 と同様のアンチパターンが残存している
- Issue 記載のA/B/C案はいずれも技術的に妥当。特に B 案（state と actions の分離）が useReducer の標準的スタイルに最も近く、安定性が高い
