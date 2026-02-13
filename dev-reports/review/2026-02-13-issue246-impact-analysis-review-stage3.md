# Architecture Review: Issue #246 Impact Analysis (Stage 3)

**Issue**: #246 - スマホにて再開時Error loading worktreeとなる
**Focus Area**: 影響範囲 (Impact Analysis)
**Stage**: 3 (影響分析レビュー)
**Date**: 2026-02-13
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #246の設計方針書に対する影響範囲分析レビューを実施した。設計方針書は前段のStage 1(設計原則)およびStage 2(整合性)のレビュー指摘を反映済みであり、変更対象ファイルは2つのコンポーネントファイルと1つのテストファイルに限定されている。影響範囲は適切にスコープされており、破壊的変更はない。

主な所見として、handleRetry()呼び出し時のloading状態遷移がポーリングuseEffectのライフサイクルに影響を与える副作用について、設計書での説明が不足している点を必須改善項目として指摘した。また、WebSocket再接続との三者間競合シナリオおよびExternalApps系コンポーネントのスコープ外判断根拠の明示を推奨改善項目として挙げた。いずれも機能的な安全性に問題はなく、設計書の記載充実で対応可能な範囲である。

---

## 1. Impact Scope Analysis

### 1-1. Direct Changes (直接変更)

| Category | File | Change Description | Risk |
|----------|------|--------------------|------|
| Direct | `src/components/worktree/WorktreeDetailRefactored.tsx` | visibilitychangeイベントリスナー追加、RECOVERY_THROTTLE_MS定数追加、lastRecoveryTimestampRef追加、handleVisibilityChange useCallback追加、useEffect追加 | Low |
| Direct | `src/components/worktree/WorktreeList.tsx` | visibilitychangeイベントリスナー追加、fetchWorktrees(true)呼び出し、useEffect追加 | Low |
| Direct | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | visibilitychangeテストケース4件追加 | Low |

### 1-2. Indirect Impacts (間接影響)

| Category | File | Impact Description | Risk |
|----------|------|--------------------|------|
| Indirect | `src/hooks/useAutoYes.ts` | visibilitychange復帰時のfetchCurrentOutputがprompt状態を更新し、auto-yes有効時に自動応答が発火する可能性。DUPLICATE_PREVENTION_WINDOW_MS(3秒)とサーバー側保護により安全 | Low |
| Indirect | `src/hooks/useWorktreeUIState.ts` | handleRetry経由でactions.showPrompt/clearPrompt等が呼ばれる。既存フローと同一であり新規リスクなし | Low |
| Indirect | `src/hooks/useWebSocket.ts` | バックグラウンド中のWebSocket切断時、復帰時のauto-reconnect→broadcast→fetchWorktrees(true)がvisibilitychangeハンドラと同時発火する可能性。GET冪等のため安全 | Low |
| Scope外 | `src/components/external-apps/ExternalAppsManager.tsx` | 60秒ポーリング。バックグラウンド復帰時の影響軽微 | Info |
| Scope外 | `src/components/external-apps/ExternalAppStatus.tsx` | ヘルスチェックポーリング。影響軽微 | Info |
| Scope外 | `src/components/worktree/AutoYesToggle.tsx` | 残り時間表示の1秒setInterval。精度低下は1秒以内に自動修正 | Info |

### 1-3. Breaking Changes

なし。本変更は純粋な機能追加(visibilitychangeイベントリスナー)であり、既存のAPI、プロパティ、データ構造に対する変更は含まれない。

### 1-4. Deployment Impact

フロントエンドのみの変更。API/DB/サーバー側への変更は不要。ビルド・デプロイの追加手順も不要。

---

## 2. Side Effect Analysis

### 2-1. WorktreeDetailRefactored.tsx - handleRetry()呼び出しの副作用チェーン

visibilitychange復帰時にhandleRetry()が呼ばれた場合の副作用チェーンを以下に示す。

```
visibilitychangeハンドラ
  |
  v
handleRetry()
  |
  +-- setError(null)      ... errorステートがnullに変更
  +-- setLoading(true)    ... loadingステートがtrueに変更
  |     |
  |     v
  |   [副作用1] ポーリングuseEffect(L1479-1493)のcleanupが実行される
  |             → setInterval(pollData)がclearIntervalされる
  |   [副作用2] renderがLoadingIndicatorに切り替わる(L1530-1532)
  |             → ターミナル出力、メッセージ履歴が一瞬非表示
  |
  +-- fetchWorktree()     ... Worktreeメタデータ取得
  |     |
  |     +-- 成功時: setWorktree(data)
  |     |     |
  |     |     v
  |     |   fetchMessages() + fetchCurrentOutput() ... 並列実行
  |     |     |
  |     |     +-- fetchCurrentOutput副作用:
  |     |     |     +-- actions.setTerminalOutput()  ... ターミナル出力更新
  |     |     |     +-- actions.setTerminalActive()  ... アクティブ状態更新
  |     |     |     +-- actions.showPrompt() or clearPrompt() ... プロンプト状態更新
  |     |     |     |     |
  |     |     |     |     v
  |     |     |     |   [副作用3] useAutoYes hookが反応
  |     |     |     |             auto-yes有効 + isPromptWaiting=true → 自動応答発火の可能性
  |     |     |     +-- setAutoYesEnabled() / setAutoYesExpiresAt() ... auto-yes状態同期
  |     |     |
  |     |     +-- fetchMessages副作用:
  |     |           +-- actions.setMessages()  ... メッセージリスト更新
  |     |
  |     +-- 失敗時: setError(message) → fetchMessages/fetchCurrentOutputはスキップ
  |
  +-- setLoading(false)   ... loadingステートがfalseに変更
        |
        v
      [副作用4] ポーリングuseEffect(L1479-1493)が再実行される
                → 新しいsetInterval(pollData)が作成される
                → 次のpollDataはinterval時間後に発火(即時ではない)
```

### 2-2. WorktreeList.tsx - fetchWorktrees(true)呼び出しの副作用

```
visibilitychangeハンドラ
  |
  v
fetchWorktrees(true)  ... silent=true
  |
  +-- setError(null)           ... errorステートをクリア
  +-- worktreeApi.getAll()     ... API呼び出し
  |     |
  |     +-- 成功時: setWorktrees(data.worktrees), setRepositories(data.repositories)
  |     +-- 失敗時: setError(handleApiError(err))
  |
  +-- setLoading変更なし(silent=trueのため)
```

副作用は軽微。setInterval(L122-129)は常時動作しているため、fetchWorktrees(true)との同時発火が発生し得るが、GETリクエストの冪等性により安全。

### 2-3. useAutoYes連動の安全性確認

設計書Section 6で分析されているautoYes連動について、実コードに基づき確認した。

**確認結果**: 安全

- `useAutoYes`(L1425-1431)は`lastServerResponseTimestamp`パラメータを渡していない(IC-002で記録済みの既存不整合)
- ただし、`DUPLICATE_PREVENTION_WINDOW_MS`(3秒)によるクライアント側保護と、`lastAutoRespondedRef`によるpromptKeyベースの重複防止が機能する
- サーバー側でもauto-yesエンドポイントが独自にタイムスタンプ検証を実施
- バックグラウンド中に新しいプロンプトが到着していた場合、復帰時に自動応答するのは正常な期待動作

---

## 3. Risk Assessment

| Risk Type | Description | Impact | Probability | Priority |
|-----------|-------------|--------|-------------|----------|
| Technical | handleRetry()によるloading状態遷移がポーリングuseEffectを一時停止/再作成する | Low | High | P2 |
| Technical | visibilitychange + setInterval + WebSocket再接続の三者間同時発火によるAPI集中 | Low | Medium | P3 |
| Technical | 正常状態からの復帰時にLoadingIndicatorが一瞬表示されるUX問題 | Low | High | P3 |
| Security | visibilitychangeイベントリスナーによるセキュリティリスク | None | N/A | N/A |
| Operational | デプロイ手順変更なし | None | N/A | N/A |

---

## 4. Detailed Findings

### 4-1. Must Fix

#### [IA-001] handleRetry()呼び出し時のloading状態遷移がポーリングuseEffectのガードを再トリガーする副作用

**Severity**: Medium

**Issue**: visibilitychange復帰時にhandleRetry()が呼ばれると、setLoading(true)により以下のuseEffect(L1479-1493)のcleanupが走る:

```typescript
// L1479-1493 (現在のコード)
useEffect(() => {
  if (loading || error) return;  // ← loading=trueになるとreturnされる

  const pollingInterval = state.terminal.isActive
    ? ACTIVE_POLLING_INTERVAL_MS
    : IDLE_POLLING_INTERVAL_MS;

  const pollData = async () => {
    await Promise.all([fetchCurrentOutput(), fetchWorktree(), fetchMessages()]);
  };

  const intervalId = setInterval(pollData, pollingInterval);

  return () => clearInterval(intervalId);  // ← cleanup: intervalが停止される
}, [loading, error, fetchCurrentOutput, fetchWorktree, fetchMessages, state.terminal.isActive]);
```

設計書Section 2-2のシーケンス図には「useEffect再実行 → setInterval再開」と記載されているが、以下のタイミング詳細が不足している:

1. handleRetry実行中(loading=true): setIntervalはclearされ、ポーリングは完全に停止
2. handleRetry完了(loading=false): useEffectが再実行され、新しいsetIntervalが作成される
3. 新しいsetIntervalのpollDataは「interval時間後」に最初の発火が行われる(即時発火ではない)

つまり、visibilitychange復帰後、handleRetryのAPI呼び出しが完了してからさらに2-5秒(アクティブ/アイドルに応じて)のブランク期間が存在する。これは機能的問題ではないが、設計書に明記すべき挙動である。

**Recommendation**: 設計書Section 4-2またはSection 9-2に、handleRetry()実行中のポーリングuseEffectライフサイクル(cleanup → 再作成)の挙動と、handleRetry完了後のsetInterval再開タイミング(次のinterval発火まで待機)を明記すること。

---

### 4-2. Should Fix

#### [IA-002] WebSocket再接続とvisibilitychangeの同時発火による一時的なAPI集中

**Severity**: Low

**Issue**: useWebSocket.ts L132-141に自動再接続ロジックがある:

```typescript
ws.onclose = () => {
  updateStatus('disconnected');
  wsRef.current = null;
  if (autoReconnect) {
    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, reconnectDelay);
  }
};
```

バックグラウンド中にWebSocket接続が切断された場合、フォアグラウンド復帰時に以下の3つのデータ取得フローが同時または近接して発火する:

1. **visibilitychangeハンドラ**: handleRetry() → fetchWorktree + fetchMessages + fetchCurrentOutput (最大3 API calls)
2. **WebSocket再接続 → broadcast受信**: handleWebSocketMessage → fetchWorktrees(true) (WorktreeList.tsx側、1 API call)
3. **setInterval再開**: pollData → fetchCurrentOutput + fetchWorktree + fetchMessages (最大3 API calls)

合計で最大7-9のGETリクエストが短時間に発生する。設計書Section 9-2ではsetIntervalとvisibilitychangeの競合(最大6回)のみ記載しているが、WebSocket再接続を含めた三者間競合シナリオが欠落している。

**Recommendation**: 設計書Section 9-2にWebSocket再接続イベントとの三者間競合シナリオを追記し、全てがGET冪等であるため安全である旨を明記すること。

---

#### [IA-003] ExternalAppsManager/ExternalAppStatusのvisibilitychange未対応の判断根拠

**Severity**: Low

**Issue**: 以下のコンポーネントもsetIntervalを使用しており、バックグラウンド復帰時のタイマー精度低下の影響を受ける:

| Component | Interval | Guard |
|-----------|----------|-------|
| `ExternalAppsManager.tsx` L56 | 60,000ms | なし |
| `ExternalAppStatus.tsx` L72 | 可変(pollInterval) | なし |
| `AutoYesToggle.tsx` L64 | 1,000ms | なし |

設計書Section 1-3のスコープ外セクションには「ExternalAppsManager等への横展開」と記載されているが、これらのコンポーネントについてvisibilitychange対応が不要と判断した根拠(ポーリング間隔が十分に長い、error状態によるポーリング停止がない等)が明示されていない。

**Recommendation**: 設計書Section 1-3に、ExternalAppsManager(60秒ポーリング)およびExternalAppStatus(可変ポーリング)について、ポーリング間隔が長くバックグラウンド復帰時の影響が軽微(次回interval発火で自然回復)であるためスコープ外とする判断根拠を記載すること。

---

#### [IA-004] loading=true中のUI表示がvisibilitychange復帰時のUXに与える影響

**Severity**: Low

**Issue**: 設計書Section 4-2のC-003注意事項に「正常状態からの復帰時にも一瞬setLoading(true)が実行される」と記載されているが、具体的なUI影響の説明が不足している。

WorktreeDetailRefactored.tsx L1530-1537の実装:

```typescript
// Handle loading state
if (loading) {
  return <LoadingIndicator />;
}

// Handle error state
if (error) {
  return <ErrorDisplay message={error} onRetry={handleRetry} />;
}
```

handleRetry()によりloading=trueになると、コンポーネント全体がLoadingIndicatorに置き換わる。これはデスクトップ/モバイル両レイアウトで以下のUX影響がある:

- ターミナル出力表示が消失し、ローディングスピナーに置き換わる
- メッセージ履歴が消失し、復帰後にre-renderされる
- FileTreeViewやSearchBarなどの状態がリセットされる可能性がある(ただしuseReducer管理のため永続)
- APIレスポンスが高速(100ms以下)であれば視覚的影響は軽微だが、ネットワーク遅延がある場合は顕著なフラッシュが発生

**Recommendation**: 設計書Section 4-2のC-003関連注意事項を拡充し、loading=true時にコンポーネント全体がLoadingIndicatorに置き換わるため、正常状態からの復帰時にターミナル出力やメッセージ履歴が一瞬消えて再表示される挙動になる点を明記すること。

---

### 4-3. Consider (Future Items)

#### [IA-005] AutoYesToggle.tsxのsetInterval(1000ms)は復帰時に残り時間表示がズレる可能性

本Issueスコープ外。残り時間表示のみの用途であり、1秒以内に自動修正されるため機能的影響なし。

#### [IA-006] handleRetry依存配列変更時のvisibilitychangeハンドラへの波及

handleRetry → visibilitychangeハンドラのuseCallback再生成チェーンにより、React StrictModeでの二重マウント時にリスナーの登録/解除が2回発生する。既存のuseEffectパターンと同一のため新規リスクは低い。テストケースでの確認を推奨。

#### [IA-007] fetchCurrentOutput内のstate.prompt.visible参照によるuseCallback再生成チェーン

fetchCurrentOutput(依存: state.prompt.visible) → handleRetry → visibilitychangeハンドラの再生成チェーンにより、prompt状態が変化するたびにvisibilitychangeリスナーが再登録される。既存のポーリングuseEffectと同じパターンであり、本Issue固有の新規リスクではない。

---

## 5. Consistency with Previous Reviews

### Stage 1 (設計原則レビュー) Findings Status

| ID | Title | Stage 3 Assessment |
|----|-------|-------------------|
| MF-001 | handleRetry直接呼び出し(DRY) | 影響範囲の観点でも適切。副作用チェーンは既存フローと同一 |
| SF-001 | RECOVERY_THROTTLE_MS独立定数 | 影響範囲の観点で問題なし |
| SF-002 | WorktreeDetailRefactored.tsx責務過多 | visibilitychangeリスナー追加により更に責務が増加するが、YAGNI原則の判断は妥当 |
| SF-003 | パターン差異の根拠明示 | 影響範囲の観点でも2コンポーネントの差異は合理的 |

### Stage 2 (整合性レビュー) Findings Status

| ID | Title | Stage 3 Assessment |
|----|-------|-------------------|
| IC-001 | handleRetryフロー条件分岐 | 副作用チェーン分析で条件分岐の影響を確認済み |
| IC-002 | lastServerResponseTimestamp未渡し | auto-yes連動の安全性分析で影響を再確認。スコープ外の既存不整合として妥当 |
| IC-004 | WorktreeList.tsxのerror状態 | 副作用分析でerror状態に関わらずsetIntervalが継続することを確認済み |

---

## 6. Performance Impact Assessment

| Scenario | Current | After Change | Delta |
|----------|---------|--------------|-------|
| Normal page load | 3 API calls | 3 API calls | 0 |
| Foreground recovery (normal state) | 0 API calls | 3 API calls (handleRetry) + 0-3 (setInterval overlap) | +3 to +6 |
| Foreground recovery (error state) | 0 API calls (polling stopped) | 3 API calls (handleRetry) | +3 |
| Foreground recovery (WorktreeList) | 0 API calls | 1 API call (fetchWorktrees) + 0-1 (setInterval overlap) | +1 to +2 |
| WebSocket reconnect + recovery | 0 API calls | Up to 9 API calls (three-way overlap) | +9 (worst case) |

全てのAPI呼び出しはGETリクエストで冪等。最悪ケースの9回同時GETリクエストでも、サーバー負荷は軽微。

---

## 7. Testing Impact Assessment

### 7-1. Existing Test Coverage

| Test File | Status | Impact |
|-----------|--------|--------|
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` (796行) | 要修正 | 4テストケース追加。document.visibilityStateのモック、Event dispatch、タイマー制御(vi.useFakeTimers)が必要 |

### 7-2. Test Gap Analysis

| Gap | Severity | Recommendation |
|-----|----------|----------------|
| WorktreeList.tsxのユニットテストが存在しない | Medium | 手動テストで代替(設計書Section 12-2の通り)。将来的にはテスト追加を推奨 |
| React StrictMode下でのvisibilitychangeリスナー二重登録テスト | Low | Consider項目(IA-006) |
| WebSocket切断→復帰時のend-to-endテスト | Low | E2Eテストまたは統合テストでカバーが望ましいが本Issueスコープ外 |

---

## 8. Approval Status

**Status**: Conditionally Approved (条件付き承認)

**Conditions for Approval**:

1. **[IA-001]** 設計書にhandleRetry()実行中のポーリングuseEffectライフサイクル(cleanup/再作成)の挙動とsetInterval再開タイミングを明記すること

**Recommended Improvements** (承認条件ではないが推奨):

- [IA-002] WebSocket再接続との三者間競合シナリオをSection 9-2に追記
- [IA-003] ExternalApps系コンポーネントのスコープ外判断根拠をSection 1-3に追記
- [IA-004] C-003注意事項にloading=trueによるUI全体置き換えの具体的影響を追記

---

*Review conducted by: Architecture Review Agent*
*Review date: 2026-02-13*
*Design policy document: dev-reports/design/issue-246-visibility-recovery-design-policy.md*
