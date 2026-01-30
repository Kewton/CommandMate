# Issue #99 レビューレポート

**レビュー日**: 2026-01-30
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**ステージ**: Stage 1

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

### 総合評価

| 観点 | 評価 |
|------|------|
| 完全性 | B+ |
| 技術的実現可能性 | A- |
| 整合性 | B |
| 明確性 | B+ |
| モバイルUX | B+ |

Issue #99は全体的に詳細で適切に構成されている。機能要件、UI/UXデザイン、技術的考慮事項、受け入れ条件が明確に記載されている。主な改善点は、既存コンポーネント・フックとの関係性の明確化、およびIssue #49設計書との整合性確認である。

---

## Should Fix（推奨対応）

### SF-001: 最大化表示時のlocalStorage保存キー名が未定義

**カテゴリ**: 明確性
**場所**: ## 機能要件 > 1. 最大化表示機能

**問題**:
受け入れ条件に「リサイズ位置がlocalStorageに保存・復元される」とあるが、最大化状態の保存については言及がない。一貫性のため、最大化状態も保存するか否かを明確にすべき。

**証拠**:
- 受け入れ条件: 「リサイズ位置がlocalStorageに保存・復元される」
- 最大化状態の保存については記載なし

**推奨対応**:
リサイズ位置のlocalStorageキーと同様に、最大化状態の保存キー名を明示的に定義する。

```markdown
### localStorage キー設計
| キー | 型 | 説明 |
|-----|-----|------|
| `commandmate:md-editor-split-ratio` | `number` | Split Viewの比率（0-100%） |
| `commandmate:md-editor-maximized` | `boolean` | 最大化状態（オプション） |
```

---

### SF-002: Fullscreen APIのブラウザサポートとフォールバック戦略が未定義

**カテゴリ**: 技術的妥当性
**場所**: ## 機能要件 > 1. 最大化表示機能 > モバイル

**問題**:
技術的考慮事項では「CSS `position: fixed` + `z-index` / Fullscreen API」と両方記載されているが、モバイルセクションでは「フルスクリーンAPIを活用した没入型編集モード」のみ記載。iOS Safari等でのFullscreen API制限を考慮すると、フォールバックの明確化が必要。

**証拠**:
- モバイル要件: 「フルスクリーンAPIを活用した没入型編集モード」
- 技術的考慮事項: 「CSS `position: fixed` + `z-index` / Fullscreen API」
- iOS SafariはFullscreen API をユーザーインタラクション以外で許可しない制限あり

**推奨対応**:
Fullscreen APIのブラウザサポート状況を考慮し、フォールバック戦略を明記する。

```markdown
### モバイル最大化の実装戦略

| ブラウザ | 対応方法 |
|---------|---------|
| Fullscreen API対応 | Fullscreen API使用 |
| iOS Safari等 | CSS position: fixed + z-index + 100vh/100vw |

**フォールバック判定**:
```typescript
const supportsFullscreen = document.fullscreenEnabled ||
  (document as any).webkitFullscreenEnabled;
```
```

---

### SF-003: 既存PaneResizerコンポーネントとの関係性が不明確

**カテゴリ**: 整合性
**場所**: ## 機能要件 > 2. Split Viewの表示領域リサイズ

**問題**:
プロジェクトには既に`src/components/worktree/PaneResizer.tsx`が存在し、Issue #99で要求されている機能の多くを実装済み。再利用の検討が必要。

**証拠**:
既存PaneResizer.tsxの機能:
- ドラッグリサイズ（mouse/touch対応）
- キーボードナビゲーション（矢印キー）
- アクセシビリティ属性（`role="separator"`, `aria-orientation`, `aria-valuenow`）
- 視覚フィードバック（ホバー、ドラッグ中の色/サイズ変化）

Issue #99の要件との重複:
- リサイズハンドル（幅4-6px）
- ホバー時のカーソル変更（`col-resize`）
- キーボード操作でもリサイズ可能
- `role="separator"` + `aria-orientation="vertical"`

**推奨対応**:
既存のPaneResizerを再利用するか、新規実装するかを明確にする。

```markdown
### 既存コンポーネントとの関係

| 選択肢 | メリット | デメリット |
|--------|---------|-----------|
| PaneResizer再利用 | 実装済み、テスト済み | スタイル調整が必要 |
| 新規実装 | 要件に完全一致 | 重複コード |

**推奨**: PaneResizerを拡張または再利用し、MarkdownEditor固有のスタイルをprops経由で渡す。
```

---

### SF-004: Issue #49 設計書との状態管理方針の不整合

**カテゴリ**: 整合性
**場所**: ## 技術的考慮事項 > 状態管理

**問題**:
Issue #49の設計書では`ViewMode = 'split' | 'editor' | 'preview'`と`VIEW_MODE_STRATEGIES`が定義済み。最大化状態やリサイズ比率をどのように統合するかが不明確。

**証拠**:
既存の型定義（`src/types/markdown-editor.ts`）:
```typescript
export type ViewMode = 'split' | 'editor' | 'preview';

export interface ViewModeStrategy {
  showEditor: boolean;
  showPreview: boolean;
  editorWidth: string;  // Tailwindクラス: 'w-1/2', 'w-full'
  previewWidth: string;
}
```

Issue #99の新しい状態:
- 最大化状態（boolean）
- リサイズ比率（number、20-80%）

**推奨対応**:
状態管理の拡張方針を明記する。

```markdown
### 状態管理の拡張方針

**選択肢A: 別状態として管理**
```typescript
const [viewMode, setViewMode] = useState<ViewMode>('split');
const [isMaximized, setIsMaximized] = useState(false);
const [splitRatio, setSplitRatio] = useState(50); // %
```

**選択肢B: 統合型で管理**
```typescript
interface EditorLayout {
  viewMode: ViewMode;
  isMaximized: boolean;
  splitRatio: number;
}
```

**推奨**: 選択肢Aを採用。既存のviewMode状態との互換性を維持しつつ、新しい状態を独立して追加。
```

---

## Nice to Have（あれば良い）

### NTH-001: リサイズハンドルの視覚フィードバック詳細

**カテゴリ**: 完全性
**場所**: ## 機能要件 > 2. Split Viewの表示領域リサイズ > デスクトップ

**問題**:
既存PaneResizerでは詳細なスタイルが定義されているが、Issue #99では基本的な要件のみ。

**推奨対応**:
```markdown
### リサイズハンドルスタイル仕様
| 状態 | 幅 | 背景色 | トランジション |
|------|-----|--------|---------------|
| デフォルト | 4px | gray-200 | 150ms |
| ホバー | 6px | blue-400 | 150ms |
| ドラッグ中 | 6px | blue-500 | none |
```

---

### NTH-002: 既存フックの再利用可能性

**カテゴリ**: 完全性
**場所**: ## 技術的考慮事項

**問題**:
プロジェクトには関連するフックが既に存在するが、再利用の検討が記載されていない。

**既存フック一覧**:
| フック | 用途 | Issue #99での活用 |
|--------|------|------------------|
| `useIsMobile` | モバイル判定 | 縦向き/横向きレイアウト切替 |
| `useSwipeGesture` | スワイプ検出 | 最大化解除のスワイプ |
| `useVirtualKeyboard` | キーボード検出 | キーボード表示時のレイアウト調整 |

**推奨対応**:
```markdown
### 既存フックの活用
- `useIsMobile`: レスポンシブレイアウト切替に使用
- `useSwipeGesture`: モバイル最大化解除のスワイプダウン検出に使用
- `useVirtualKeyboard`: キーボード表示時のエディタ高さ調整に使用
```

---

### NTH-003: E2Eテストのビューポートサイズ定義

**カテゴリ**: 完全性
**場所**: ## 受け入れ条件 > テスト

**問題**:
モバイルE2Eテストの具体的なビューポートサイズが未定義。

**推奨対応**:
```markdown
### E2Eテストビューポート
| デバイス | 幅 x 高さ | 向き |
|---------|----------|------|
| iPhone 14 | 390 x 844 | Portrait |
| iPhone 14 | 844 x 390 | Landscape |
| iPad | 768 x 1024 | Portrait |
| Desktop | 1280 x 720 | - |
```

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|----------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | 既存エディタ実装。拡張対象のベース。 |
| `src/components/worktree/PaneResizer.tsx` | 既存リサイズコンポーネント。再利用候補。 |
| `src/types/markdown-editor.ts` | 既存型定義。ViewMode拡張が必要。 |
| `src/hooks/useIsMobile.ts` | モバイル判定。レイアウト切替に活用可能。 |
| `src/hooks/useSwipeGesture.ts` | スワイプ検出。最大化解除に活用可能。 |
| `src/hooks/useVirtualKeyboard.ts` | キーボード検出。レイアウト調整に活用可能。 |

### ドキュメント

| ファイル | 関連性 |
|----------|--------|
| `dev-reports/design/issue-49-markdown-editor-design-policy.md` | Issue #49設計書。整合性確認必須。 |
| `CLAUDE.md` | プロジェクトガイドライン。コーディング規約確認。 |

---

## 次のステップ

1. **SF-001〜SF-004の指摘事項を反映** - Issue本文を更新
2. **影響範囲レビュー（Stage 2）を実施** - 変更が影響するファイル・モジュールの特定
3. **実装計画の策定** - フェーズ分けと工数見積もり

---

## 更新履歴

| 日付 | バージョン | 内容 |
|------|----------|------|
| 2026-01-30 | 1.0 | Stage 1 通常レビュー完了 |
