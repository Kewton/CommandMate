# Issue #299 Stage 1 レビューレポート

**レビュー日**: 2026-02-18
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: Medium

Issue #299は4つの症状を体系的に整理しており、再現手順・期待動作・仮説が構造化されている点は良い。しかし、コード実態との照合で**z-indexの値に重大な不一致**が発見され、白画面（症状3）の根本原因分析が不正確である。また、breakpointの値や受け入れ条件の欠如など、修正が必要な点がある。

---

## Must Fix（必須対応）

### MF-1: z-index値がコード実態と不一致（白画面の根本原因分析が不正確）

**カテゴリ**: 正確性
**場所**: 根本原因の仮説 > 症状3: 全画面表示時の白画面

**問題**:
Issueの仮説ではModal=z-50（`Z_INDEX.MODAL`定数）として分析しているが、**実際のModal.tsxはz-[9999]をハードコードしている**。このため、`MAXIMIZED_EDITOR`(z-55)がModalの上に来るという前提が誤っている。

**証拠**:
- `src/config/z-index.ts` line 32: `MODAL: 50` (定数定義)
- `src/components/ui/Modal.tsx` line 86: `z-[9999]` (実際の実装)
- `src/components/worktree/MarkdownEditor.tsx` line 886,493: Portal z-55

```typescript
// z-index.ts - 定数定義
MODAL: 50,
MAXIMIZED_EDITOR: 55,  // "above Modal" というコメント

// Modal.tsx - 実際の実装
<div className="fixed inset-0 z-[9999] overflow-y-auto">
```

**白画面の推定メカニズム**:
1. MarkdownEditorはModal(z-9999)内部でレンダリングされる（`WorktreeDetailRefactored.tsx` line 1847-1863）
2. 全画面モード時、MarkdownEditorはPortal(z-55)でdocument.bodyに脱出する
3. しかしModalのbackdrop(z-9999)がPortalの上に残留する
4. 結果として、白い背景（Modalのbackdrop）がエディタを覆い隠す

**推奨対応**:
- Modalの実際のz-index（9999）を明記した上で、Portal z-55がModal backdrop z-9999より下に位置するメカニズムを記載する
- `z-index.ts`のMODAL定数(50)とModal.tsxの実装値(9999)の乖離を根本課題として記載する
- 対策案に「Modal backdrop制御」または「Portal z-indexの修正」を含める

---

### MF-2: iPad breakpointの記載が不正確

**カテゴリ**: 正確性
**場所**: 根本原因の仮説 > 症状1・2

**問題**:
IssueではiPad横置きを「1024px以上」と記載しているが、実際のbreakpointは`MOBILE_BREAKPOINT = 768`であり、**iPad portrait（768px）でも `768 < 768 = false` でデスクトップ扱い**になる。症状1・2が「横置きのみ」と報告されているが、技術的にはiPad全般でデスクトップレイアウトが適用される。

**証拠**:
```typescript
// src/hooks/useIsMobile.ts line 15, 62
export const MOBILE_BREAKPOINT = 768;
const checkIsMobile = (): boolean => {
  return window.innerWidth < breakpoint; // 768 < 768 = false
};
```

**推奨対応**:
- `MOBILE_BREAKPOINT=768`であること、iPad portrait(768px)でもisMobile=falseになることを正確に記載
- 「横置きのみ」ではなく「iPad全般でデスクトップ扱い」であることを明記
- 縦置きで崩れにくい理由（画面幅がデスクトップレイアウトに近い等）の考察を追加

---

### MF-3: スワイプ解除問題の対策案が不十分

**カテゴリ**: 正確性
**場所**: 根本原因の仮説 > 症状4 / 対策案 > 症状4

**問題**:
対策案では「thresholdの引き上げ（100px -> 150px以上）」を主要対策としているが、根本原因はスクロールとスワイプの区別がないことであり、threshold引き上げだけでは解決しない。コンテンツの上スクロール（指を下方向に100px以上動かす）は日常操作であり、150pxでも発動する。

**証拠**:
```typescript
// src/hooks/useSwipeGesture.ts line 160-171
} else {
  if (absY >= threshold) {
    if (deltaY < 0) { onSwipeUp?.(); }
    else { onSwipeDown?.(); }  // スクロールアップ操作で発動
  }
}

// src/components/worktree/MarkdownEditor.tsx line 178-186
const { ref: swipeRef } = useSwipeGesture({
  onSwipeDown: () => { if (isMaximized) exitFullscreen(); },
  threshold: 100,
  enabled: isMaximized && isMobile,  // iPadでは無効(isMobile=false)
});
```

**推奨対応**:
- 主要対策として「scrollable要素内でのスワイプ検出無効化」を明記
  - touchstart時にevent.targetがscrollable要素内かを判定
  - スクロール可能領域ではswipe検出を抑制
- threshold引き上げは補助的対策として位置づける
- 代替案として「コンテンツ領域最上部（scrollTop=0）でのみスワイプダウンを許可」も検討すべき

---

## Should Fix（推奨対応）

### SF-1: navigator.platform非推奨の問題が未記載

**カテゴリ**: 完全性
**場所**: 根本原因の仮説 > 症状3 / 影響範囲

**問題**:
`useFullscreen.ts`の`isIOSDevice()`は`navigator.platform`（MDNで非推奨）を使用している。将来のブラウザバージョンで動作しなくなるリスクがあるが、Issue本文に記載がない。

**証拠**:
```typescript
// src/hooks/useFullscreen.ts line 67
if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
  return true;
}
```

Codebase全体で`navigator.userAgentData`の使用は0件。

**推奨対応**:
- navigator.platform非推奨の問題を対策案に追記
- 代替案（navigator.userAgentData、UA Client Hints）の検討を含める
- このIssueのスコープに含めるか、別Issueとするかを判断して明記

---

### SF-2: 受け入れ条件（Acceptance Criteria）が未定義

**カテゴリ**: 明確性
**場所**: Issue全体

**問題**:
「期待する動作」セクションはあるが、テスト可能な受け入れ条件が定義されていない。修正完了の判定基準が曖昧。

**推奨対応**:
以下のような受け入れ条件を追加:
1. iPad Chrome横置き・縦置きでWorktree一覧画面のレイアウトが正常表示される
2. iPad Chrome横置き・縦置きでMarkdownファイル表示が正常
3. iPad Chrome縦・横でMarkdownエディタ全画面表示が白画面にならず、コンテンツが表示される
4. スマホChrome全画面表示中の上スクロールで全画面が解除されない
5. 既存のデスクトップ・モバイルのレイアウトにリグレッションがない
6. E2Eテストまたは手動テストチェックリストの追加

---

### SF-3: 症状3の因果関係（Portal/Modalの相互作用）が不十分

**カテゴリ**: 完全性
**場所**: 根本原因の仮説 > 症状3

**問題**:
MarkdownEditorがModal内部でレンダリングされる構造と、Portal脱出時のz-index競合の因果関係が記載されていない。

**証拠**:
```tsx
// WorktreeDetailRefactored.tsx line 1847-1863
<Modal isOpen={true} onClose={handleEditorClose} size="full" disableClose={isEditorMaximized}>
  <div className="h-[80vh]">
    <MarkdownEditor ... />
  </div>
</Modal>
```

**推奨対応**:
レンダリングパスを明記:
1. `WorktreeDetailRefactored.tsx` -> `Modal`(z-9999) -> `MarkdownEditor`
2. 全画面時: `createPortal`(z-55)でdocument.bodyへ脱出
3. Modalのbackdrop(z-9999)が上に残留 -> 白画面

---

### SF-4: 影響範囲にModal.tsxが含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル（候補）

**問題**:
z-index管理の見直しには`Modal.tsx`の修正が必要だが、変更対象ファイル一覧に含まれていない。

**推奨対応**:
変更対象ファイルに以下を追加:
| ファイル | 変更内容 |
|---------|---------|
| `src/components/ui/Modal.tsx` | z-index値の統一（z-index.ts定数への移行）、またはMaximized Editor時のbackdrop制御 |

---

## Nice to Have（あれば良い）

### NTH-1: スマホの再現スクリーンショットがない

**カテゴリ**: 完全性
**場所**: スクリーンショット > スマホ

症状4（スマホ全画面スクロール解除）のスクリーンショットまたは画面収録があると、問題の正確な理解に役立つ。

---

### NTH-2: iPad環境の詳細情報がない

**カテゴリ**: 完全性
**場所**: 環境

iPadモデル名、iPadOSバージョン、Chromeバージョンの記載があると再現性が向上する。iPad Air（768px）とiPad Pro（1024px）ではViewportが異なり、レイアウト崩れの程度が変わる可能性がある。

---

### NTH-3: 関連Issue #104へのリンクがない

**カテゴリ**: 完全性
**場所**: Issue全体

Issue #104（iOS全画面表示対応）で導入されたCSS fallback/Portal機構がこの問題の前提技術基盤であるため、`Related: #104` を追記すると文脈が明確になる。

---

## 参照ファイル

### コード

| ファイル | 関連性 | 重要な行 |
|---------|--------|---------|
| `src/hooks/useIsMobile.ts` | MOBILE_BREAKPOINT=768の判定ロジック | L15, L62 |
| `src/hooks/useFullscreen.ts` | isIOSDevice()検出、CSS fallback制御 | L57, L67, L219 |
| `src/hooks/useSwipeGesture.ts` | スワイプ検出。scroll/swipe区別なし | L49, L160-171 |
| `src/components/worktree/MarkdownEditor.tsx` | 全画面/Portal/スワイプの統合ポイント | L178-185, L476, L493, L886 |
| `src/components/ui/Modal.tsx` | **z-[9999]ハードコード。白画面の直接要因** | L86 |
| `src/config/z-index.ts` | z-index定数。MODAL=50が実態と乖離 | L32, L35 |
| `src/components/layout/AppShell.tsx` | レスポンシブレイアウト分岐 | L59, L62, L98 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | MarkdownEditorをModal内で使用 | L1847-1863, L2073-2089 |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | 2カラムレイアウト | L238, L267 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | モジュール説明・z-index設計の概要 |

---

*Generated by issue-review-agent Stage 1 (2026-02-18)*
