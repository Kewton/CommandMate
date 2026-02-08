# Issue #99 整合性レビュー報告書

## 基本情報

| 項目 | 内容 |
|------|------|
| レビュー種別 | 整合性（Consistency） |
| ステージ | Stage 2 |
| Issue番号 | #99 |
| 設計書 | dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md |
| レビュー日 | 2026-01-30 |
| レビュー結果 | approved_with_recommendations |
| 整合性スコア | B+ |

---

## 1. レビュー概要

Issue #99「マークダウンエディタ表示機能改善」設計書に対する整合性レビューを実施した。本レビューでは以下の観点から設計書と既存コードの整合性を検証した。

- 設計書と既存コードパターンの一貫性
- 提案された型定義と既存型定義の整合性
- フックAPIの使用方法の正確性
- Issue #49設計書との設計パターンの一貫性

---

## 2. 検証対象ファイル

### 2.1 設計書

- `dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md`

### 2.2 既存実装ファイル

| ファイル | 検証内容 |
|----------|---------|
| `src/components/worktree/MarkdownEditor.tsx` | 現在の実装状態、拡張ポイント |
| `src/components/worktree/PaneResizer.tsx` | インターフェース、リサイズパターン |
| `src/types/markdown-editor.ts` | 型定義、定数 |
| `src/hooks/useIsMobile.ts` | API、戻り値 |
| `src/hooks/useSwipeGesture.ts` | API、戻り値、使用方法 |
| `src/hooks/useVirtualKeyboard.ts` | API、戻り値 |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | PaneResizerの使用パターン |
| `dev-reports/design/issue-49-markdown-editor-design-policy.md` | 設計パターンの一貫性 |

---

## 3. 指摘事項サマリー

| 重要度 | 件数 |
|--------|------|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 4 |
| **合計** | **8** |

---

## 4. 指摘事項詳細

### 4.1 High（対応必須）

#### CS-001: LOCAL_STORAGE_KEYS定数名の不整合

**カテゴリ**: 型定義の整合性

**問題**:
設計書ではLOCAL_STORAGE_KEYSオブジェクト（VIEW_MODE, SPLIT_RATIO, MAXIMIZED）を定義しているが、既存の`markdown-editor.ts`では`LOCAL_STORAGE_KEY`（単数形）として単一の文字列を定義している。

設計書の記述（セクション4.1）:
```typescript
export const LOCAL_STORAGE_KEYS = {
  VIEW_MODE: 'commandmate:md-editor-view-mode',
  SPLIT_RATIO: 'commandmate:md-editor-split-ratio',
  MAXIMIZED: 'commandmate:md-editor-maximized',
} as const;
```

既存コード（src/types/markdown-editor.ts:177）:
```typescript
export const LOCAL_STORAGE_KEY = 'commandmate:md-editor-view-mode';
```

**推奨対応**:
- 既存の`LOCAL_STORAGE_KEY`を維持しつつ、新規キーを同じ命名規則で追加する
- 例: `LOCAL_STORAGE_KEY_SPLIT_RATIO`, `LOCAL_STORAGE_KEY_MAXIMIZED`
- または設計書を既存パターンに合わせて修正する

---

### 4.2 Medium（対応推奨）

#### CS-002: useSwipeGestureフックのAPI使用方法の不整合

**カテゴリ**: フックAPI整合性

**問題**:
設計書では`onSwipeDown`を直接プロパティとして取得する記述があるが、実際の`useSwipeGesture`はrefベースの実装である。

設計書の記述（セクション5.1、187-190行目）:
```typescript
const { onSwipeDown } = useSwipeGesture({
  onSwipeDown: () => setIsMaximized(false),
});
```

実際のAPI（src/hooks/useSwipeGesture.ts:37-46）:
```typescript
export interface UseSwipeGestureReturn {
  ref: React.RefObject<HTMLElement>;
  isSwiping: boolean;
  swipeDirection: SwipeDirection | null;
  resetSwipeDirection: () => void;
}
```

**推奨対応**:
設計書のコード例を実際のAPIに合わせて修正:
```typescript
const { ref: swipeRef } = useSwipeGesture({
  onSwipeDown: () => setIsMaximized(false),
});
// swipeRefをコンテナ要素に適用
```

---

#### CS-003: PaneResizerのonDoubleClickがAPIに未定義

**カテゴリ**: PaneResizerインターフェース

**問題**:
設計書ではPaneResizerに`onDoubleClick` propを追加する計画だが、現在の`PaneResizerProps`には定義されていない。

現在のインターフェース（src/components/worktree/PaneResizer.tsx:23-30）:
```typescript
export interface PaneResizerProps {
  onResize: (delta: number) => void;
  orientation?: ResizerOrientation;
  ariaValueNow?: number;
}
```

**推奨対応**:
設計書では「後方互換性維持」と記載されており、実装時に以下を追加する計画は適切:
```typescript
onDoubleClick?: () => void;
minRatio?: number;
```

---

#### CS-007: ViewModeStrategyの拡張可能性

**カテゴリ**: リサイズ実装パターン

**問題**:
既存の`VIEW_MODE_STRATEGIES`定数はsplitモード時に固定幅（`w-1/2`）を使用している。設計書のリサイズ機能では`splitRatio`で動的な幅を設定するため、strategyオブジェクトの使用方法が変更される。

**推奨対応**:
splitモード時は`strategy.editorWidth`/`strategy.previewWidth`を使用せず、`splitRatio`に基づいて動的にスタイルを設定する必要がある。設計書のコード例（218-230行目）はこの方針を反映しているが、既存のstrategy使用箇所との関係を設計書に明記することを推奨。

---

### 4.3 Low（任意対応）

#### CS-005: MarkdownEditorに未実装の機能が設計書に記載

**ステータス**: 想定される差分（expected_gap）

設計書の新規追加部分（`splitRatio`状態、`isMaximized`状態、`PaneResizer`コンポーネント）は明確に「新規状態（追加）」と記載されており、設計上は問題なし。

---

#### CS-006: useFullscreen, useLocalStorageStateフックは新規作成

**ステータス**: 想定される新規ファイル（expected_new_file）

設計書のセクション10.2で新規作成ファイルとして明記されており、整合している。

---

#### CS-008: Issue #49設計書との一貫性

**ステータス**: 肯定的所見（positive_finding）

Issue #99設計書はIssue #49設計書の構造・フォーマットを踏襲しており、一貫性が保たれている。

---

## 5. 肯定的所見

### PF-001: 既存フックの再利用

設計書で参照されている3つのフック（`useIsMobile`, `useSwipeGesture`, `useVirtualKeyboard`）は全て存在し、APIドキュメントも整備されている。

### PF-002: PaneResizerのonResize APIの一貫性

設計書でPaneResizerの`onResize`がピクセル単位のdeltaを返す設計は、既存実装と完全に一致している。

### PF-003: EditorLayoutState型の設計

設計書で提案されている`EditorLayoutState`型は既存の`ViewMode`型を再利用しており、型定義の一貫性が保たれている。

### PF-004: リサイズ処理パターンの整合性（CS-004）

設計書のSF-003対応でピクセル->比率変換を`MarkdownEditor`側で実施する方針は、`WorktreeDesktopLayout`の既存パターンと一致している。

WorktreeDesktopLayoutの実装パターン（246-264行目）:
```typescript
const handleResize = useCallback(
  (delta: number) => {
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;
    const percentageDelta = (delta / containerWidth) * 100;
    setLeftWidth((prev) => {
      const newWidth = prev + percentageDelta;
      return Math.min(maxLeftWidth, Math.max(minLeftWidth, newWidth));
    });
  },
  [minLeftWidth, maxLeftWidth]
);
```

---

## 6. 整合性チェックリスト

| 項目 | 状態 | 備考 |
|------|------|------|
| 型定義 | Partial | ViewMode型は一致。LOCAL_STORAGE_KEYS命名に軽微な不整合 |
| フックAPI | Partial | useSwipeGestureのAPI使用例に不整合あり |
| コンポーネントインターフェース | Good | PaneResizerの拡張方針は後方互換性を維持 |
| 設計パターン | Good | WorktreeDesktopLayoutのリサイズパターンとの一貫性確保 |
| 命名規則 | Good | ファイル名、関数名、型名は既存規則に従う |

---

## 7. 推奨対応

### 7.1 Must Fix（対応必須）

| ID | 関連指摘 | 対応内容 |
|----|---------|---------|
| MF-001 | CS-001 | LOCAL_STORAGE_KEYS定数の命名を既存パターンに合わせるか、設計書を修正する |

### 7.2 Should Fix（対応推奨）

| ID | 関連指摘 | 対応内容 |
|----|---------|---------|
| SF-001 | CS-002 | 設計書のuseSwipeGesture使用例を実際のAPIに合わせて修正 |
| SF-002 | CS-007 | splitモード時のVIEW_MODE_STRATEGIES使用方法について、動的幅設定との関係を設計書に明記 |

### 7.3 Nice to Have（任意）

| ID | 対応内容 |
|----|---------|
| NTH-001 | z-index.tsの設計をプロジェクト全体のスタイル管理方針として文書化 |

---

## 8. 結論

Issue #99設計書は全体として既存コードパターンとの整合性が高く、**approved_with_recommendations**と評価する。

主な整合性の問題は以下の2点であり、いずれも設計書の修正で対応可能:

1. **LOCAL_STORAGE_KEYS命名の不整合**（High）: 既存の単一定数パターンとオブジェクトパターンの不一致
2. **useSwipeGestureのAPI使用例**（Medium）: 戻り値の記述が実際のAPIと異なる

肯定的な点として:
- PaneResizerのリサイズパターンはWorktreeDesktopLayoutと完全に一貫
- 既存フック（useIsMobile, useSwipeGesture, useVirtualKeyboard）の再利用計画は適切
- Issue #49設計書との構造・フォーマットの一貫性が保たれている

上記の推奨対応を設計書に反映することで、実装フェーズへの移行が可能となる。

---

*レビュー実施者: architecture-review-agent*
*レビュー日: 2026-01-30*
