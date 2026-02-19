# Issue #299 仮説検証レポート

## 検証日時
- 2026-02-18

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `useIsMobile.ts`のbreakpoint問題（iPad横置き=デスクトップ扱い） | Confirmed | `MOBILE_BREAKPOINT = 768`、iPad横置き(≥768px)はisMobile=false |
| 2 | Hydration mismatch（初期値false問題） | Partially Confirmed | 初期値falseは意図的設計だが、iPad横置きでは問題なし。モバイル→デスクトップ判定変更時のflashは存在 |
| 3 | z-index stacking context混在 | Partially Confirmed | Desktop sidebar=z-30、Mobile drawer=z-50が存在するが、実際の競合は未確認 |
| 4 | CSS Fallback `fixed inset-0`白画面問題 | Partially Confirmed | isFallbackMode時にfixed inset-0適用・Portal機構あり、z-index 55設定済みだが完全な動作検証不可 |
| 5 | Portal位置指定の問題 | Partially Confirmed | Portal機構(`markdown-editor-portal`)はdocument.bodyに追加、z-index 55はModal(50)より上だが一部要素より低い可能性 |
| 6 | `useFullscreen.ts`のiOS検出ロジック | Confirmed | iPadOS 13+の`MacIntel + maxTouchPoints > 1`検出ロジック実装済み |
| 7 | `useSwipeGesture`のthreshold問題（100px） | Confirmed | threshold=100px、かつコンテンツスクロールとスワイプ判定が区別されていない |
| 8 | スクロール方向の誤判定 | Confirmed | コンテンツを上スクロール（指を下方向に動かす）とswipeDownが発動しexitFullscreenが呼ばれる |

---

## 詳細検証

### 仮説 1: `useIsMobile.ts`のbreakpoint問題

**Issue内の記述**: 「`useIsMobile.ts`のbreakpoint問題: iPad横置き（1024px以上）はデスクトップ扱いになるが、画面サイズに対してデスクトップレイアウトが最適化されていない」

**検証手順**:
1. `src/hooks/useIsMobile.ts` を確認
2. `MOBILE_BREAKPOINT = 768` (line 15)
3. `window.innerWidth < breakpoint` でisMobileを判定 (line 62)

**判定**: Confirmed

**根拠**:
```typescript
export const MOBILE_BREAKPOINT = 768;
// ...
const checkIsMobile = (): boolean => {
  return window.innerWidth < breakpoint; // iPad横置きは1024px等 → false
};
```
iPad（最小幅768px）は portrait でも `768 < 768 = false` でデスクトップ扱い。横置きは1024px以上でisMobile=false。

**Issueへの影響**: 仮説は正確。iPad横置き時のデスクトップレイアウト調整が必要。

---

### 仮説 2: Hydration mismatch

**Issue内の記述**: 「`useIsMobile`の初期値が`false`のため、SSR時とクライアント初期化時でレイアウトが異なる可能性」

**検証手順**:
1. `src/hooks/useIsMobile.ts` line 55確認
2. `useState<boolean>(false)` – コメント「Always start with false to match SSR」

**判定**: Partially Confirmed

**根拠**:
```typescript
// IMPORTANT: Always start with false to match SSR and avoid hydration mismatch
const [isMobile, setIsMobile] = useState<boolean>(false);
```
初期値falseは意図的設計でHydration mismatch回避のため。ただしiPad（>768px）では初期値false・更新後もfalseのため、この問題は症状1・2の直接原因ではない。モバイル（<768px）では初期はデスクトップ表示→hydration後にモバイル表示に切り替わる軽微なフラッシュが発生する可能性あり。

**Issueへの影響**: iPad向けには直接の影響なし。ただしisMobileの判定がfalseのままのため、デスクトップレイアウト（サイドバーなど）がiPad画面サイズに最適化されていないことが問題の根本。

---

### 仮説 3: z-index stacking context混在

**Issue内の記述**: 「Desktop sidebar（z-30）とMobile drawer（z-50）が混在する可能性」

**検証手順**:
1. `src/config/z-index.ts` 確認
2. `src/components/layout/AppShell.tsx` 確認

**判定**: Partially Confirmed

**根拠**:
```typescript
// z-index.ts
SIDEBAR: 30,  // Desktop sidebar
MODAL: 50,    // Modal
MAXIMIZED_EDITOR: 55,  // Maximized editor
```
```typescript
// AppShell.tsx – Mobile layout
"fixed inset-0 bg-black/50 z-40"  // Drawer overlay
"fixed left-0 top-0 h-full w-72 z-50"  // Mobile drawer
```
iPadはisMobile=falseのためDesktopレイアウト（z-30サイドバー）が使用される。実際の混在は起きていないが、z-30のサイドバーとその他要素の重なりは確認が必要。

---

### 仮説 4・5: CSS Fallback白画面・Portal問題

**Issue内の記述**: 「CSSフォールバック（`fixed inset-0`）が使用されるが、stacking contextやz-indexの問題で内容が非表示になる可能性」「Portalが`document.body`に追加されるが、z-indexやoverflowの制御が不適切な可能性」

**検証手順**:
1. `src/hooks/useFullscreen.ts` – CSS fallback実装確認
2. `src/components/worktree/MarkdownEditor.tsx` – Portal使用確認（line 884-893）
3. `src/config/z-index.ts` – z-index値確認

**判定**: Partially Confirmed

**根拠**:
```typescript
// MarkdownEditor.tsx line 476-485
const containerClasses = useMemo(() => {
  const base = 'flex flex-col bg-white';
  if (isMaximized && isFallbackMode) {
    return `${base} fixed inset-0`;  // CSS fallback
  }
  return `${base} h-full`;
}, [isMaximized, isFallbackMode]);

// line 486-498
const containerStyle = useMemo(() => {
  if (isMaximized) {
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR }; // = 55
  }
  return undefined;
}, [isMaximized]);

// line 884-892
const usePortal = isMaximized && isFallbackMode && portalContainer;
if (usePortal) {
  return createPortal(editorContent, portalContainer);
}
```
Portal機構は実装済み。z-index 55はModal(50)より上。ただしPortalが使用されるのは`isMaximized && isFallbackMode`の場合のみ。iPadOS ChromeでisIOSDevice()がtrueを返す場合はisFallbackMode=trueになる。白画面の原因として、`bg-white`のfixed inset-0コンテナ内にPortalコンテンツが正しく描画されていない可能性がある。

---

### 仮説 6: `useFullscreen.ts`のiOS検出ロジック

**Issue内の記述**: 「iPadOS ChromeがiOSデバイスとして正しく検出されるかの問題」

**検証手順**:
1. `src/hooks/useFullscreen.ts` line 57-72確認

**判定**: Confirmed

**根拠**:
```typescript
function isIOSDevice(): boolean {
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
  // iPad Pro (iPadOS 13+) は MacIntel + maxTouchPoints > 1
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}
```
iPadOS 13+のChromeは`platform === 'MacIntel'`かつタッチポイント複数のため検出される。ただし`navigator.platform`は非推奨APIであり、将来の環境では機能しなくなる可能性あり。

---

### 仮説 7・8: swipeGestureのthreshold・スクロール誤判定問題

**Issue内の記述**: 「threshold（100px）が小さく、通常のスクロール操作でも全画面解除が発動する可能性」「コンテンツ内の上方向スクロールがswipeDown gestureとして検出される」

**検証手順**:
1. `src/hooks/useSwipeGesture.ts` line 49, 136-171確認
2. `src/components/worktree/MarkdownEditor.tsx` line 177-186確認

**判定**: Confirmed

**根拠**:
```typescript
// MarkdownEditor.tsx line 177-186
const { ref: swipeRef } = useSwipeGesture({
  onSwipeDown: () => {
    if (isMaximized) exitFullscreen();
  },
  threshold: 100,
  enabled: isMaximized && isMobile,
});

// swipeRef をコンテナ全体にマージ（line 592-596）
ref={(el) => {
  (containerRef as ...).current = el;
  (swipeRef as ...).current = el;  // 全コンテナにスワイプ検出
}}
```

```typescript
// useSwipeGesture.ts line 160-171
} else {
  // Vertical swipe
  if (absY >= threshold) {
    if (deltaY < 0) { onSwipeUp?.(); }
    else { onSwipeDown?.(); }  // deltaY > 0 = 指が下方向に移動 = コンテンツ上スクロール
  }
}
```

**核心問題**: コンテンツをスクロールアップ（指を下方向に動かしてコンテンツを上に移動）すると、deltaY > 0 → `onSwipeDown` → `exitFullscreen()` が呼ばれる。コンテンツ内スクロールとスワイプジェスチャーを区別するロジックがない。また、スワイプイベントがコンテンツエリアのスクロール可能要素から発生した場合でも、コンテナ全体にイベントが伝播して検出される。

---

## Stage 1レビューへの申し送り事項

1. **症状3（白画面）の追加調査が必要**: isFallbackMode時のPortal+z-index 55機構は実装済みだが、実際に白画面が発生する理由を詳細調査が必要。`bg-white`の適用、PortalコンテナのCSS、親要素のoverflow/transformの影響を確認すること。
2. **navigator.platformの非推奨対応**: iOS検出に`navigator.platform`を使用しているが、非推奨APIのため代替手段の検討が必要（`navigator.userAgentData`等）。
3. **症状1・2（レイアウト崩れ）の具体的な原因**: `isMobile=false`でデスクトップレイアウトが適用されるが、具体的にどのCSSが崩れているかの分析が必要。タブレット向けの中間レイアウト追加を検討すること。
4. **swipeとscrollの分離戦略**: threshold引き上げだけでなく、scrollable要素内でのswipe検出を無効化する実装が根本的な解決策。

*Generated by multi-stage-issue-review Phase 0.5*
