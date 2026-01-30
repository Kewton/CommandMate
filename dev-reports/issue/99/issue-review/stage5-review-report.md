# Issue #99 レビューレポート（Stage 5: 通常レビュー2回目）

**レビュー日**: 2026-01-30
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 5/6

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 2 |
| **前回指摘の解決数** | **7件** |

---

## 前回レビュー指摘事項の検証

### Stage 1 レビュー指摘事項（4件）

| ID | カテゴリ | 指摘内容 | 状態 | 検証結果 |
|----|---------|---------|------|---------|
| SF-001 | 明確性 | 最大化表示時のlocalStorage保存キー名が未定義 | **解決済** | Issue本文に`commandmate:md-editor-maximized`キーが明記され、LOCAL_STORAGE_KEYS定数での一元管理が規定された |
| SF-002 | 技術的妥当性 | Fullscreen APIのフォールバック戦略が未定義 | **解決済** | モバイルセクションに「CSS固定ポジション（`position: fixed` + `z-index: 9999` + `inset: 0`）によるモーダル表示にフォールバック」が明記された |
| SF-003 | 整合性 | 既存PaneResizerコンポーネントとの関係性が不明確 | **解決済** | 「既存の`PaneResizer.tsx`を**再利用**する」と明記され、拡張ポイント・後方互換性要件が詳細に記載された |
| SF-004 | 整合性 | Issue #49設計書との状態管理方針の不整合 | **解決済** | 「状態管理の拡張方針」セクションが追加され、isMaximizedがViewModeとは独立した状態として管理される方針が明記された |

### Stage 3 影響範囲レビュー指摘事項（2件: Must Fix）

| ID | カテゴリ | 指摘内容 | 状態 | 検証結果 |
|----|---------|---------|------|---------|
| MF-001 | 状態管理 | localStorageキー競合リスク | **解決済** | LOCAL_STORAGE_KEYS定数による一元管理が「localStorageキー一元管理」セクションとして追加された |
| MF-002 | 破壊的変更 | PaneResizer拡張の後方互換性 | **解決済** | 「後方互換性要件」が明記され、全新規propsはoptional、デフォルト値設定、既存使用箇所での検証が規定された |

---

## 今回の新規指摘事項

### Should Fix（推奨対応）

#### SF-001: 既存MarkdownEditor.tsxとの状態管理統合手順

**カテゴリ**: 整合性
**場所**: ## 技術的考慮事項 > 状態管理の拡張方針

**問題**:
Issue記載の`EditorLayoutState`型と、既存MarkdownEditor.tsx（L89）のviewMode状態の統合手順が不明確。

**現状**:
既存コード:
```typescript
// src/components/worktree/MarkdownEditor.tsx L89
const [viewMode, setViewMode] = useState<ViewMode>(() =>
  getInitialViewMode(initialViewMode)
);
```

Issue提案型:
```typescript
interface EditorLayoutState {
  viewMode: ViewMode;          // 既存: 'split' | 'editor' | 'preview'
  isMaximized: boolean;        // 新規: 最大化状態
  splitRatio: number;          // 新規: エディタ/プレビュー比率 (0.2-0.8)
}
```

**推奨対応**:
以下のいずれかの方針を明記:
1. **包含アプローチ**: 既存viewMode状態をEditorLayoutStateにリファクタリング
2. **追加アプローチ**: isMaximizedとsplitRatioを別の状態として追加（viewModeはそのまま維持）

---

### Nice to Have（あれば良い）

#### NTH-001: useFullscreenフックのAPI仕様

**カテゴリ**: 完全性
**場所**: ## 影響ファイル一覧 > 新規ファイル

**問題**:
`src/hooks/useFullscreen.ts`（80行）が新規ファイルとして記載されているが、具体的なAPI仕様が未定義。

**推奨対応**:
以下のAPI仕様を追加:
```typescript
interface UseFullscreenReturn {
  isFullscreen: boolean;
  isSupported: boolean;
  enterFullscreen: (element?: HTMLElement) => Promise<void>;
  exitFullscreen: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  // フォールバック時のCSS状態
  isFallbackMode: boolean;
}
```

---

#### NTH-002: orientationchange検出方針

**カテゴリ**: 技術的妥当性
**場所**: ## 機能要件 > 2. Split Viewの表示領域リサイズ > モバイル

**問題**:
横向き（landscape）/縦向き（portrait）の切替検出方法が未定義。既存useIsMobile.tsはwindow.innerWidthのみを使用。

**推奨対応**:
以下のいずれかの方針を明記:
1. useIsMobileフックを拡張してorientation検出を追加
2. 新規useOrientationフックを作成
3. 直接matchMedia APIを使用（`matchMedia('(orientation: portrait)')`）

---

## 評価スコア推移

| 観点 | Stage 1 | Stage 5 | 変化 |
|------|---------|---------|------|
| 完全性 | B+ | A- | +0.5 |
| 技術的実現性 | A- | A | +0.5 |
| 整合性 | B | A- | +1.0 |
| 明確性 | B+ | A | +0.5 |
| モバイルUX | B+ | A- | +0.5 |

---

## コード参照

### 変更対象ファイル
| ファイル | 関連性 |
|----------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | 主要変更対象。状態管理拡張、最大化機能追加 |
| `src/components/worktree/PaneResizer.tsx` | 拡張対象。onDoubleClick, minRatio props追加 |
| `src/types/markdown-editor.ts` | 型定義拡張。EditorLayoutState、LOCAL_STORAGE_KEYS追加 |

### 再利用ファイル
| ファイル | 関連性 |
|----------|--------|
| `src/hooks/useIsMobile.ts` | モバイル判定（そのまま再利用） |
| `src/hooks/useSwipeGesture.ts` | スワイプ検出（onSwipeDownコールバックで最大化解除） |

---

## 結論

Issue #99は前回のStage 1レビュー（4件のShould Fix）およびStage 3影響範囲レビュー（2件のMust Fix）の指摘事項を全て適切に反映しており、大幅に改善されている。

**残存指摘**:
- Should Fix: 1件（状態管理統合手順の明確化）
- Nice to Have: 2件（useFullscreen API仕様、orientation検出方針）

これらは実装フェーズで対応可能な範囲であり、Issueは実装開始可能な状態にある。

---

## レビュー履歴

| ステージ | 日付 | フォーカス | Must Fix | Should Fix | Nice to Have |
|---------|------|----------|----------|------------|--------------|
| Stage 1 | 2026-01-30 | 通常レビュー（1回目） | 0 | 4 | 3 |
| Stage 3 | 2026-01-30 | 影響範囲レビュー（1回目） | 2 | 5 | 3 |
| **Stage 5** | **2026-01-30** | **通常レビュー（2回目）** | **0** | **1** | **2** |
