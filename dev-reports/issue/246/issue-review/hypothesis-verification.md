# Issue #246 仮説検証レポート

## 検証日時
- 2026-02-13

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `visibilitychange`イベントリスナーの欠如 | ✅ Confirmed | コードベース照合で未実装を確認 |
| 2 | ポーリングタイマーの停止 | ⚠️ Partially Confirmed | ブラウザの一般的な動作だが、コードでの対処なし |
| 3 | エラー状態からの自動復帰なし | ✅ Confirmed | コードベース照合で自動リトライなしを確認 |
| 4 | 初期化ガードの影響 | ✅ Confirmed | コードベース照合で再初期化防止ロジックを確認 |

## 詳細検証

### 仮説 1: `visibilitychange`イベントリスナーの欠如

**Issue内の記述**:
> `WorktreeDetailRefactored.tsx`にブラウザのフォーカス復帰やページ可視性変更を検知するイベントリスナーがない

**検証手順**:
1. `WorktreeDetailRefactored.tsx` ファイルを確認
2. `visibilitychange` パターンで検索実行

**判定**: ✅ **Confirmed**

**根拠**:
```bash
grep "visibilitychange" src/components/worktree/WorktreeDetailRefactored.tsx
# No matches found
```

ファイル全体を検索しましたが、`visibilitychange`イベントリスナーは実装されていません。

**Issueへの影響**: この仮説は正確です。対策案で提案されている`visibilitychange`イベントリスナーの追加は妥当な解決策です。

---

### 仮説 2: ポーリングタイマーの停止

**Issue内の記述**:
> スマホがバックグラウンドに入るとブラウザがタイマーを一時停止し、復帰時にポーリングが正常に再開されない

**検証手順**:
1. ポーリングエフェクトの実装を確認（L1479-1493）
2. ブラウザのバックグラウンド動作に関する一般的な知識を参照

**判定**: ⚠️ **Partially Confirmed**

**根拠**:

ポーリングエフェクトの実装（L1479-1493）:
```typescript
useEffect(() => {
  if (loading || error) return;

  const pollingInterval = state.terminal.isActive
    ? ACTIVE_POLLING_INTERVAL_MS
    : IDLE_POLLING_INTERVAL_MS;

  const pollData = async () => {
    await Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()]);
  };

  const intervalId = setInterval(pollData, pollingInterval);

  return () => clearInterval(intervalId);
}, [loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, state.terminal.isActive]);
```

ブラウザがバックグラウンドに入ると、`setInterval`のタイマーが最小化されたり、一時停止されたりするのは一般的なブラウザの動作です。ただし、コードベースだけではこの動作を直接確認することはできません（実行時の動作に依存）。

**Issueへの影響**: この仮説は一般的なブラウザの動作として妥当ですが、コードベースでは`visibilitychange`イベントによる明示的な対処がないことが問題です。対策案で提案されている`visibilitychange`イベントリスナーの追加により、この問題に対処できます。

---

### 仮説 3: エラー状態からの自動復帰なし

**Issue内の記述**:
> ポーリングエフェクト（L1479-1493）で`error`が`true`になるとポーリングが完全に停止し、自動リトライの仕組みがない

**検証手順**:
1. ポーリングエフェクトの実装を確認（L1479-1493）
2. `error`状態の扱いを確認

**判定**: ✅ **Confirmed**

**根拠**:

ポーリングエフェクト（L1479-1493）:
```typescript
useEffect(() => {
  if (loading || error) return;  // ← error が true ならポーリングしない

  const pollingInterval = state.terminal.isActive
    ? ACTIVE_POLLING_INTERVAL_MS
    : IDLE_POLLING_INTERVAL_MS;

  const pollData = async () => {
    await Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()]);
  };

  const intervalId = setInterval(pollData, pollingInterval);

  return () => clearInterval(intervalId);
}, [loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, state.terminal.isActive]);
```

`error`が`true`になると、エフェクトは早期リターンし、ポーリングが完全に停止します。自動リトライの仕組みはありません。

**Issueへの影響**: この仮説は正確です。対策案で提案されている「ページ復帰時のエラーリセット＆データ再取得ロジック」により、この問題に対処できます。

---

### 仮説 4: 初期化ガードの影響

**Issue内の記述**:
> `initialLoadCompletedRef`が一度`true`になると初期化処理が再実行されないため、復帰時の再初期化が行われない

**検証手順**:
1. `initialLoadCompletedRef`の使用箇所を確認
2. 初期化処理の実装を確認（L1449-1476）

**判定**: ✅ **Confirmed**

**根拠**:

初期化処理（L1449-1476）:
```typescript
/** Initial data fetch on mount - runs only once */
useEffect(() => {
  // Skip if already loaded to prevent re-triggering on dependency changes
  if (initialLoadCompletedRef.current) {
    return;
  }

  // ...初期化処理...

  if (isMounted) {
    setLoading(false);
    initialLoadCompletedRef.current = true;
  }
}, [fetchWorktree, fetchMessages, fetchCurrentOutput]);
```

`initialLoadCompletedRef.current`が一度`true`になると、初期化処理は再実行されません。ただし、worktreeId変更時にはリセットされています（L971）。

**Issueへの影響**: この仮説は正確です。バックグラウンド復帰時には初期化処理が再実行されないため、`visibilitychange`イベントで明示的にデータ再取得をトリガーする必要があります。

---

## Stage 1レビューへの申し送り事項

すべての仮説がConfirmedまたはPartially Confirmedとなったため、Issueの根本原因分析は正確です。以下の点に注意してレビューを実施してください：

### 重点確認ポイント

1. **対策案の妥当性**: `visibilitychange`イベントリスナーの追加は、上記4つの仮説すべてに対処できる適切な解決策です
2. **実装タスクの網羅性**: 提案されている実装タスクは、仮説に基づいた対策を網羅しています
3. **影響範囲の正確性**: `WorktreeDetailRefactored.tsx`と`WorktreeList.tsx`が主な変更対象として正しく特定されています

### 追加確認が必要な点

1. **WorktreeList.tsx**: `WorktreeList.tsx`にも同様の問題が存在するか確認が必要
2. **テスト戦略**: `visibilitychange`イベントのテスト方法について具体的な方針が必要
3. **エラーリセットのタイミング**: ページ復帰時に即座にエラーをリセットするのか、データ取得成功後にリセットするのか、詳細な動作仕様が必要

---

*検証完了: 2026-02-13*
