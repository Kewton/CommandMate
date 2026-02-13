# Architecture Review: Issue #246 - Design Principles Review (Stage 1)

**Issue**: #246 スマホにて再開時Error loading worktreeとなる
**Focus Area**: 設計原則 (Design Principles: SOLID/KISS/YAGNI/DRY)
**Stage**: 1 - 通常レビュー
**Date**: 2026-02-13
**Status**: Conditionally Approved
**Score**: 4/5

---

## Executive Summary

Issue #246 の設計方針書は、スマートフォンのバックグラウンド復帰時における「Error loading worktree」エラーの自動回復機構を定義している。全体として設計原則への準拠度は高く、特に KISS と YAGNI の適用が優れている。debounce ではなく timestamp ガードを選択した判断、usePageVisibility カスタムフック化を行わない判断、setInterval の停止/再開を行わない判断はいずれも適切である。

唯一の必須改善項目は、handleRetry 同等フローの再実装に関する DRY 違反である。既存の handleRetry 関数を直接呼び出す設計に変更することで、この問題は容易に解決できる。設計方針書の Section 13 で「直接の関数呼び出しを検討」と言及されているが、具体的な設計が示されていないため、これを明確化する必要がある。

---

## Design Principles Evaluation

### SOLID Principles

#### S - Single Responsibility Principle (SRP): 3/5 - Partial

**評価**: visibilitychange ハンドラ自体は「フォアグラウンド復帰時のデータ再取得」という単一の責務を持ち、SRP を守っている。しかし、追加先の WorktreeDetailRefactored.tsx は既に 2006 行と大きく、以下の責務を抱えている:

- API フェッチ関数群 (fetchWorktree, fetchMessages, fetchCurrentOutput)
- ポーリング制御 (setInterval)
- エラー/ローディング状態管理
- UI レイアウト制御 (デスクトップ/モバイル)
- ファイル操作ハンドラ群
- プロンプト応答処理
- auto-yes 連携

ここに visibilitychange ハンドラを追加すると、ファイルレベルの責務が更に増加する。ただし、本 Issue のスコープでこの問題を解決する必要はなく、設計方針書の YAGNI 判断として妥当である。

**該当箇所**: 設計方針書 Section 13 「SOLID - 単一責任: visibilitychangeリスナーは復帰処理のみを担当」

#### O - Open/Closed Principle (OCP): 4/5 - Good

**評価**: 既存の handleRetry パターンを再利用し、新しい API エンドポイントや状態管理の仕組みを追加しない設計は、既存コードへの変更を最小限に抑えており OCP に適っている。visibilitychange ハンドラの追加は useEffect を1つ追加するだけで、既存の useEffect やコールバック関数への修正は不要。

**該当箇所**: 設計方針書 Section 10-2 「既存パターンとの一貫性」の全項目が一致

#### L - Liskov Substitution Principle (LSP): N/A

本設計にはサブタイプや継承の構造が含まれないため該当しない。

#### I - Interface Segregation Principle (ISP): N/A

新規インターフェースの追加がないため該当しない。

#### D - Dependency Inversion Principle (DIP): 4/5 - Good

**評価**: visibilitychange イベントは `document.addEventListener` を通じてブラウザ API に直接依存するが、テスト手法として `Object.defineProperty` によるモックが設計方針書 Section 12-1 に明記されており、テスタビリティは確保されている。将来的にカスタムフックへ抽出すれば、ブラウザ API への依存をフックの内部に閉じ込めることができるが、現時点では YAGNI 判断として適切。

---

### KISS Principle: 5/5 - Excellent

**評価**: 本設計方針書における KISS 原則の適用は非常に優れている。

1. **timestamp ガード**: `useRef<number>` + `Date.now()` のみで実装可能。外部ライブラリの throttle/debounce を使わず、追加のユーティリティ関数も不要。設計方針書 Section 4-1 の「シンプル: useRefのみで実装可能で、追加のユーティリティ関数が不要」という根拠は明確。

2. **debounce 不採用の判断**: 設計方針書 Section 3-2 で「最後の呼び出しからN ms後に実行する設計のため、即時復帰が必要なvisibilitychangeには不適切」と記載されており、src/lib/utils.ts の debounce 関数の実際のシグネチャ・挙動とも整合する。debounce では復帰直後の即時実行ができないため、この判断は技術的に正しい。

3. **setInterval 停止/再開の不実施**: 設計方針書 Section 9-2 で「冪等性、一時的、複雑性回避、API負荷」の4つの根拠を示しており、いずれも妥当。setInterval の停止/再開を追加すると、useEffect の依存配列管理が複雑化するリスクがある。

4. **SWR/React Query 不採用**: 既存の fetch + useState 構成への最小変更の方針は、バグ修正 Issue としてのスコープに適切。

**該当箇所**: 設計方針書 Section 3-1, 3-2, 9-2

---

### YAGNI Principle: 5/5 - Excellent

**評価**: YAGNI 原則の適用が最も優れている点の一つ。

1. **usePageVisibility カスタムフック化の不採用**: 変更対象が 2 ファイルのみであり、現時点でフック化する必要がない。設計方針書 Section 3-2 および Section 10-1 で明記。

2. **auto-yes 追加対策の不採用**: 設計方針書 Section 6 で既存の保護機構（DUPLICATE_PREVENTION_WINDOW_MS、lastServerResponseTimestamp）が十分であることを分析し、追加対策を不要と判断。useAutoYes.ts の実装（L19: `DUPLICATE_PREVENTION_WINDOW_MS = 3000`）とサーバー側の保護が確認できており、この判断は妥当。

3. **WorktreeList.tsx のタイマー再設定不実施**: WorktreeList.tsx では error 状態によるポーリング停止が発生しないため、エラーリセットは不要という判断は正確。実際のコード（L123-L129）を確認すると、setInterval は無条件で fetchWorktrees(true) を呼び出しており、error/loading ガードがないことが確認できる。

**該当箇所**: 設計方針書 Section 3-2, 6-3, 10-1

---

### DRY Principle: 3/5 - Needs Improvement

**評価**: DRY 原則の適用に改善の余地がある。

**問題点**: 設計方針書 Section 4-2 では handleRetry 同等フローを visibilitychange ハンドラに再実装する設計を示している。既存の handleRetry（L1434-L1442）は以下のフローである:

```typescript
const handleRetry = useCallback(async (): Promise<void> => {
  setError(null);
  setLoading(true);
  const worktreeData = await fetchWorktree();
  if (worktreeData) {
    await Promise.all([fetchMessages(), fetchCurrentOutput()]);
  }
  setLoading(false);
}, [fetchWorktree, fetchMessages, fetchCurrentOutput]);
```

このフローを visibilitychange ハンドラ内に再実装すると、以下のコードが重複する:
- `setError(null)` の呼び出し
- `setLoading(true)` / `setLoading(false)` の呼び出し
- `fetchWorktree()` の null チェック後の `Promise.all` パターン

設計方針書 Section 13 では「handleRetryと同等のフローを再利用（ただし直接の関数呼び出しを検討）」と記載されているが、「直接の関数呼び出し」の具体的設計が示されていない。

**推奨**: visibilitychange ハンドラは以下のように handleRetry を直接呼び出す設計にすべきである:

```typescript
const handleVisibilityChange = useCallback(() => {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastRecoveryTimestampRef.current < RECOVERY_THROTTLE_MS) return;
  lastRecoveryTimestampRef.current = now;
  handleRetry();
}, [handleRetry]);
```

これにより、フロー全体の重複を完全に排除でき、handleRetry のロジック変更時に visibilitychange ハンドラも自動的に追従する。

**補足**: RECOVERY_THROTTLE_MS（5000ms）と IDLE_POLLING_INTERVAL_MS（5000ms）の値の重複も軽微な DRY の問題である。設計根拠が同じ（ポーリング1サイクル分）であるなら参照関係を明示すべき。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | handleRetry フロー重複による将来のメンテナンス不整合 | Medium | Medium | P2 |
| 技術的リスク | WorktreeDetailRefactored.tsx のファイルサイズ増大 | Low | High | P3 |
| セキュリティ | なし（GET API のみ、既存エンドポイント利用） | Low | Low | - |
| 運用リスク | visibilitychange と setInterval の同時発火による一時的 API 負荷 | Low | Medium | P3 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

#### MF-001: handleRetry 直接呼び出しによる DRY 違反の解消

**対象**: 設計方針書 Section 4-2

**現状**: handleRetry 同等フロー（setError(null) -> setLoading(true) -> fetchWorktree -> Promise.all -> setLoading(false)）を visibilitychange ハンドラに再実装する設計。

**改善案**: visibilitychange ハンドラから既存の handleRetry 関数を直接呼び出す。handleRetry は既に `useCallback` でメモ化されており、依存配列 `[fetchWorktree, fetchMessages, fetchCurrentOutput]` も適切であるため、そのまま呼び出し可能。

設計方針書 Section 4-2 の擬似コードを以下のように修正:

```
visibilitychange(visible) 発火
  -> timestampガードチェック
  -> ガード通過: handleRetry() を呼び出し
  -> ガード不通過: スキップ
```

Section 13 の記載「handleRetryと同等のフローを再利用（ただし直接の関数呼び出しを検討）」を「handleRetry関数を直接呼び出す」に確定すべきである。

---

### 推奨改善項目 (Should Fix)

#### SF-001: RECOVERY_THROTTLE_MS と IDLE_POLLING_INTERVAL_MS の関係明示

**対象**: 設計方針書 Section 4-1, Section 11

RECOVERY_THROTTLE_MS（5000ms）の定義時に IDLE_POLLING_INTERVAL_MS との関係をコメントで明記するか、IDLE_POLLING_INTERVAL_MS を参照して定義する。

```typescript
/** Throttle for visibility recovery (matches idle polling interval) */
const RECOVERY_THROTTLE_MS = IDLE_POLLING_INTERVAL_MS;
```

または将来独立して変更する可能性がある場合:

```typescript
/**
 * Throttle for visibility recovery.
 * Currently matches IDLE_POLLING_INTERVAL_MS (5000ms) but may diverge in future.
 */
const RECOVERY_THROTTLE_MS = 5000;
```

#### SF-002: 将来の SRP 改善方向の設計方針書への記載

**対象**: 設計方針書 Section 1-3 スコープ外

WorktreeDetailRefactored.tsx が 2006 行に達しており、visibilitychange ハンドラの追加で更に増加する。設計方針書のスコープ外セクションに「将来的な useVisibilityRecovery フック抽出の検討」を明記し、SRP 改善の方向性を記録しておくとよい。

#### SF-003: 2コンポーネントの visibilitychange パターン差異の比較表

**対象**: 設計方針書 Section 4-3

WorktreeDetailRefactored.tsx と WorktreeList.tsx で visibilitychange の実装パターンが異なる（timestamp ガード有無、エラーリセット有無）。この差異が意図的であることを明確にするため、以下のような比較表を追記するとよい:

| 項目 | WorktreeDetailRefactored.tsx | WorktreeList.tsx |
|------|------------------------------|-----------------|
| timestampガード | あり | なし |
| エラーリセット | あり（setError(null)） | なし（エラー状態でポーリング停止しない） |
| ローディング表示 | あり（setLoading(true)） | なし（サイレント更新） |
| 根拠 | error による setInterval 停止がある | setInterval は無条件で動作する |

---

### 検討事項 (Consider)

#### C-001: カスタムフック化の将来判断基準

設計方針書 Section 3-2 に「3箇所目の visibilitychange 利用が発生した場合にカスタムフック化を再検討する」といった具体的な判断基準を追記すると、将来のメンテナが判断しやすくなる。

#### C-002: 正常状態からの復帰時のローディング表示

error 状態からの復帰ではローディング表示が自然であるが、正常にポーリングしていた状態からの復帰では一瞬のローディングフラッシュが発生する可能性がある。handleRetry を直接呼び出す設計（MF-001）を採用した場合、この挙動は handleRetry と同一になり一貫性は保たれるが、UX 観点では検討の余地がある。

#### C-003: ポーリング制御の統合管理

将来的に WebSocket への完全移行やポーリング戦略の変更が行われる場合、setInterval ポーリングと visibilitychange ハンドラを統合的に管理するカスタムフック（usePollingManager 等）の導入を検討するとよい。

---

## CLAUDE.md Guidelines Compliance

| ガイドライン | 準拠状況 | 備考 |
|-------------|---------|------|
| TypeScript 厳格な型定義 | 準拠 | useRef<number>, useCallback の型推論が適切 |
| 関数コンポーネント使用 | 準拠 | 既存の関数コンポーネント内に追加 |
| Server Components 優先 | N/A | 本変更は Client Components のみ |
| 'use client' 明示 | 準拠 | 対象ファイルは既に 'use client' 宣言済み |
| console.log 本番残留禁止 | 要確認 | 設計方針書 Section 4-1 でガード不通過時に「ログのみ」と記載。開発環境限定かどうかを明確にすべき |
| テスト (Vitest) | 準拠 | Section 12 で 4 テストケースを定義。テスト手法も具体的 |

---

## Approval Decision

**Status: Conditionally Approved**

MF-001（handleRetry 直接呼び出しによる DRY 違反の解消）を設計方針書に反映した上で実装に進むことを推奨する。この修正は設計方針書 Section 13 で既に「直接の関数呼び出しを検討」と言及されているため、検討結果を確定させるだけの変更であり、設計の大幅な見直しは不要。

推奨改善項目（SF-001 ~ SF-003）は実装時に対応するか、設計方針書の次回更新時に反映するかを選択できる。

---

*Reviewed by: Architecture Review Agent*
*Review Date: 2026-02-13*
*Design Document: dev-reports/design/issue-246-visibility-recovery-design-policy.md*
