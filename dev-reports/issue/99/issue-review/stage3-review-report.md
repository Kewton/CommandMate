# Issue #99 レビューレポート (Stage 3)

**レビュー日**: 2026-01-30
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**レビュアー**: issue-review-agent

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 3 |

**総合リスク評価**: Medium
**信頼度**: High

Issue #99「マークダウンエディタの表示機能改善」は、既存のMarkdownEditor (Issue #49) に対する機能拡張です。最大化表示機能、Split Viewのリサイズ機能、モバイル専用UX改善を含む包括的な改善提案となっています。

本レビューでは、既存コードベースへの影響範囲を分析し、実装時に考慮すべきリスクと対策を特定しました。

---

## Must Fix（必須対応）

### MF-001: localStorage キーの一元管理

**カテゴリ**: 状態管理の衝突リスク
**場所**: Issue本文 - 技術的考慮事項セクション

**問題**:
最大化状態（isMaximized）とviewMode状態の保存キーがlocalStorageで競合する可能性があります。

**証拠**:
- Issue #49設計書では `LOCAL_STORAGE_KEY = 'commandmate:md-editor-view-mode'` を使用
- Issue #99では以下を追加予定:
  - `'commandmate:md-editor-maximized'`
  - `'commandmate:md-editor-split-ratio'`
- 現行MarkdownEditor.tsxがLOCAL_STORAGE_KEYを使用しており、新規キーとの整合性確認が必要

**推奨対応**:
`src/types/markdown-editor.ts` にLOCAL_STORAGE_KEYS定数を追加し、全キーを一元管理する設計に変更してください。

```typescript
// 推奨実装例
export const LOCAL_STORAGE_KEYS = {
  VIEW_MODE: 'commandmate:md-editor-view-mode',
  SPLIT_RATIO: 'commandmate:md-editor-split-ratio',
  MAXIMIZED: 'commandmate:md-editor-maximized',
} as const;
```

---

### MF-002: PaneResizer拡張の後方互換性

**カテゴリ**: 破壊的変更リスク
**場所**: Issue本文 - Split Viewの表示領域リサイズセクション

**問題**:
既存PaneResizerコンポーネントへの拡張（onDoubleClick, minRatio props追加）が既存使用箇所に影響を与える可能性があります。

**証拠**:
- 現行PaneResizer.tsx (255行) は `onResize`, `orientation`, `ariaValueNow` propsのみを持つ
- Issueでは `onDoubleClick`, `minRatio` を追加予定
- 既存のPaneResizer使用箇所（WorktreeDesktopLayout等）への影響評価がない

**推奨対応**:
1. PaneResizerの拡張propsは全てoptionalとし、後方互換性を維持すること
2. 既存使用箇所の一覧と影響範囲をIssueに明記すること

```typescript
// 推奨Props定義
export interface PaneResizerProps {
  onResize: (delta: number) => void;
  orientation?: ResizerOrientation;
  ariaValueNow?: number;
  // 新規追加（全てoptional）
  onDoubleClick?: () => void;
  minRatio?: number;
  localStorageKey?: string;
}
```

---

## Should Fix（推奨対応）

### SF-001: z-index競合リスク

**カテゴリ**: CSS/スタイリング影響
**場所**: Issue本文 - モバイルセクション - フォールバック戦略

**問題**:
最大化表示時のz-index: 9999が、既存のModal, Toast, ContextMenuのz-index値と競合する可能性があります。

**推奨対応**:
`src/config/z-index.ts`等のz-index設定ファイルを新規作成し、全コンポーネントのz-index値を一元管理してください。

---

### SF-002: useSwipeGestureフックのAPI誤解

**カテゴリ**: フック依存関係
**場所**: Issue本文 - 技術的考慮事項 - 再利用可能な既存フック

**問題**:
Issueで参照されているuseSwipeGestureフックの実際のAPIと、Issueの想定が異なります。

**証拠**:
- useSwipeGestureの戻り値: `{ ref, isSwiping, swipeDirection, resetSwipeDirection }`
- onSwipeDownはコールバックとして**引数に渡す**設計（戻り値ではない）

**推奨対応**:
useSwipeGestureの実際のAPI（引数としてonSwipeDown等を渡す）に合わせてIssueの実装アプローチを修正してください。

```typescript
// 正しい使用方法
const { ref, isSwiping } = useSwipeGesture({
  onSwipeDown: () => setIsMaximized(false),
  threshold: 100,
});
```

---

### SF-003: 既存テストへの影響範囲

**カテゴリ**: テスト影響
**場所**: Issue本文 - 受け入れ条件 - テストセクション

**問題**:
既存のMarkdownEditor.test.tsx (646行), PaneResizer.test.tsx (285行) に対する変更範囲が明記されていません。

**推奨対応**:
- 既存テストファイルへの修正範囲を明記
- テストカバレッジ目標を設定
- 特にPaneResizer.test.tsxの拡張内容を具体化

---

### SF-004: モバイルE2Eテストの追加

**カテゴリ**: E2Eテスト影響
**場所**: Issue本文 - 受け入れ条件

**問題**:
モバイルビューポートでのE2Eテストが既存markdown-editor.spec.tsに含まれていません。

**推奨対応**:
1. `playwright.config.ts`にモバイルデバイスプロジェクトを追加
2. モバイル専用E2Eテストファイル（`markdown-editor-mobile.spec.ts`）を作成

---

### SF-005: 型定義の責務明確化

**カテゴリ**: 型定義の拡張影響
**場所**: Issue本文 - 状態管理の拡張方針

**問題**:
EditorLayoutState型の追加がEditorPropsやEditorState型との関係性を複雑化させます。

**推奨対応**:
型定義の関係図（どの型がどのコンポーネントで使用されるか）をIssueに追加し、責務を明確化してください。

---

## Nice to Have（あれば良い）

### NTH-001: requestAnimationFrame実装例

**カテゴリ**: パフォーマンス最適化
**場所**: Issue本文 - パフォーマンス考慮セクション

リサイズ中のrequestAnimationFrameによるスロットリングの具体的な実装例を設計書に追加することを推奨します。

---

### NTH-002: キーボードショートカット競合確認

**カテゴリ**: アクセシビリティ
**場所**: Issue本文 - 最大化表示機能 - デスクトップセクション

新規ショートカット（Ctrl/Cmd + Shift + F）のブラウザデフォルト動作との競合確認を推奨します。

---

### NTH-003: CLAUDE.md更新範囲の明記

**カテゴリ**: ドキュメント影響
**場所**: Issue本文全体

実装完了時にCLAUDE.mdへ追記すべき内容をIssueのTODOに追加することを推奨します。

---

## 影響ファイル一覧

### 変更対象ファイル

| パス | 変更タイプ | リスク |
|-----|----------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | 大幅変更 | **高** |
| `src/components/worktree/PaneResizer.tsx` | 変更 | 中 |
| `src/types/markdown-editor.ts` | 変更 | 低 |
| `tests/unit/components/MarkdownEditor.test.tsx` | 変更 | 中 |
| `tests/unit/components/PaneResizer.test.tsx` | 変更 | 低 |
| `tests/e2e/markdown-editor.spec.ts` | 変更 | 中 |

### 新規作成推奨ファイル

| パス | 説明 |
|-----|------|
| `src/hooks/useFullscreen.ts` | Fullscreen API操作とフォールバック処理のカスタムフック |
| `src/hooks/useLocalStorageState.ts` | localStorage永続化対応のstate hook |
| `tests/e2e/markdown-editor-mobile.spec.ts` | モバイルビューポート専用E2Eテスト |
| `src/config/z-index.ts` | z-index値の一元管理設定ファイル |

### 変更不要ファイル（既存フックをそのまま再利用）

- `src/hooks/useIsMobile.ts` - モバイル判定に使用
- `src/hooks/useSwipeGesture.ts` - スワイプジェスチャー検出
- `src/hooks/useVirtualKeyboard.ts` - 仮想キーボード検出

---

## Breaking Changes

| ID | コンポーネント | 説明 | 重大度 |
|----|--------------|------|--------|
| BC-001 | PaneResizer | 新規props追加。optionalにすれば影響なし | 低 |
| BC-002 | MarkdownEditor | 新規props追加。optionalにすれば影響なし | 低 |

---

## パフォーマンス影響

| 領域 | 影響度 | 説明 |
|------|--------|------|
| バンドルサイズ | 最小 | ブラウザ標準API使用、追加ライブラリ不要 |
| ランタイム | 低 | rAFスロットリングで高頻度re-render防止 |
| メモリ | 最小 | 新規state追加の影響は無視可能 |
| 初期レンダリング | 低 | localStorage同期読み込みの遅延は最小限 |

---

## モバイル固有の影響

| 領域 | 影響 | 対策 |
|------|------|------|
| Fullscreen API | iOS Safari制限 | CSS固定ポジションフォールバック（Issue記載済み） |
| タッチ操作 | 44px以上必要 | タッチ領域確保（Issue記載済み） |
| Portrait/Landscape | レイアウト切替 | orientation監視ロジック追加が必要 |
| 仮想キーボード | レイアウト調整 | useVirtualKeyboardフック活用 |

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx` - 主要変更対象
- `src/components/worktree/PaneResizer.tsx` - 拡張対象
- `src/types/markdown-editor.ts` - 型定義拡張対象
- `src/hooks/useIsMobile.ts` - 既存フック再利用
- `src/hooks/useSwipeGesture.ts` - 既存フック再利用
- `src/hooks/useVirtualKeyboard.ts` - 既存フック再利用

### ドキュメント
- `CLAUDE.md` - 実装後の更新が必要
- `dev-reports/design/issue-49-markdown-editor-design-policy.md` - 基盤設計書

---

## 実装チェックリスト

**Stage 3レビュー指摘対応:**

- [ ] **[MF-001]** LOCAL_STORAGE_KEYSを一元管理する定数オブジェクトを作成
- [ ] **[MF-002]** PaneResizerの新規propsを全てoptionalとして定義し、後方互換性を確保
- [ ] **[SF-001]** z-index設定ファイルを新規作成し、既存コンポーネントとの競合を回避
- [ ] **[SF-002]** useSwipeGestureの正しいAPIに基づいた実装を行う
- [ ] **[SF-003]** 既存テストファイルへの追加テスト範囲を明確化
- [ ] **[SF-004]** モバイルE2Eテストファイルを新規作成
- [ ] **[SF-005]** 型定義の責務分担を明確にする関係図を作成

---

## 結論

Issue #99の影響範囲は**中程度**と評価します。

主要な懸念点:
1. MarkdownEditor.tsxへの大幅な変更（481行 -> 約630行予想）
2. PaneResizerの拡張による後方互換性リスク
3. モバイル対応の追加によるテスト範囲の拡大

これらは全て適切な設計変更により軽減可能です。Must Fixの2件を優先的に対応することで、実装リスクを大幅に低減できます。
