# Issue #549 影響範囲レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |

## 影響範囲マップ

### 直接影響ファイル

| ファイル | 変更種別 |
|---------|---------|
| `src/components/worktree/MarkdownEditor.tsx` | modify（mobileTab初期値ロジック変更） |

### 間接影響（要確認）ファイル

| ファイル | 変更種別 |
|---------|---------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | modify（initialViewMode='split'の明示的渡し推奨） |

### 影響なしファイル

| ファイル | 理由 |
|---------|------|
| `src/components/worktree/MarkdownPreview.tsx` | MobileTabBarはprops受取のみ |
| `src/components/worktree/FileViewer.tsx` | mobileTab変更とは独立した表示フロー |
| `src/components/worktree/FilePanelContent.tsx` | PC側パネル。既にinitialViewMode='preview'を渡している |
| `src/hooks/useIsMobile.ts` | 変更不要。既存ロジックを利用 |
| `src/types/markdown-editor.ts` | 型・定数に変更不要 |

### 機能別影響

| 機能 | 影響 |
|------|------|
| MARPファイル表示 | 影響なし（MARP検出は別パスで処理） |
| ファイルコンテンツポーリング | 影響なし |
| ファイル内検索 | 影響なし |
| PC版MarkdownEditor | 影響なし |
| 破壊的変更 | なし |

---

## Must Fix（必須対応）

### MF-1: useIsMobile hookのSSR初期値によるmobileTab初期化タイミング問題

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/MarkdownEditor.tsx:134`, `src/hooks/useIsMobile.ts:55`

**問題**:
`useIsMobile` hookはSSR hydration対策として初期値を `false` に設定している（useIsMobile.ts line 55）。そのため、MarkdownEditorの `useState` 初期値に `isMobile` を直接使う方式（例: `useState(isMobile ? 'preview' : 'editor')`）では、常に `'editor'` が初期値になってしまう。useStateの初期値はコンポーネントの最初のレンダー時に一度だけ評価されるため、後からisMobileがtrueに変わっても初期値は変わらない。

**証拠**:
- `useIsMobile.ts` line 55: `useState<boolean>(false)` -- SSRを考慮してfalseスタート
- `MarkdownEditor.tsx` line 134: `useState<MobileTab>('editor')` -- 現在の初期値

**推奨対応**:
`useEffect` を使ってisMobileの値が確定した後（マウント後の最初のレンダー）にmobileTabを `'preview'` に設定する方式を採用する。Issueの実装アプローチにこの制約と推奨パターンを明記すべき。

```typescript
// 推奨実装パターン
const [mobileTab, setMobileTab] = useState<MobileTab>('editor');
const initialMobileTabSetRef = useRef(false);

useEffect(() => {
  if (isMobile && !initialMobileTabSetRef.current) {
    setMobileTab('preview');
    initialMobileTabSetRef.current = true;
  }
}, [isMobile]);
```

---

## Should Fix（推奨対応）

### SF-1: WorktreeDetailRefactored.tsxでinitialViewModeが未指定

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx:1869-1875`

**問題**:
モバイルのMarkdownEditor Modal呼び出し時に `initialViewMode` プロパティが渡されていない。このため `getInitialViewMode()` がlocalStorageから値を読み、PCで `'editor'` モードに変更していた場合、モバイルでも `viewMode='editor'` となる。その結果 `showMobileTabs` が `false` になり（`showMobileTabs = isMobilePortrait && viewMode === 'split'`）、MobileTabBarが表示されずmobileTabの変更が実質的に無効になる。

**証拠**:
```tsx
// WorktreeDetailRefactored.tsx line 1869-1875
<MarkdownEditor
  worktreeId={worktreeId}
  filePath={editorFilePath}
  onClose={handleEditorClose}
  onSave={handleEditorSave}
  onMaximizedChange={setIsEditorMaximized}
/>
// initialViewModeが未指定
```

**推奨対応**:
Issue本文に「モバイル時はlocalStorageのviewModeを無視」と記載があるため、MarkdownEditor内部でモバイル時に `viewMode` を強制的に `'split'` にするか、WorktreeDetailRefactored.tsxから `initialViewMode="split"` を明示的に渡す方針を実装アプローチに追記すべき。

---

### SF-2: mobileTab初期値に関するテストケースの不足

**カテゴリ**: テスト範囲
**場所**: `tests/unit/components/MarkdownEditor.test.tsx`

**問題**:
既存のテストファイルにmobileTab関連のテストケースが存在しない。変更の回帰リスクを検出するためにテストが必要。

**推奨対応**:
以下のテストケースを追加:
1. モバイル環境（useIsMobile=true）でMarkdownEditorを開いた際、Previewタブがデフォルト選択されること
2. PC環境（useIsMobile=false）では既存動作と変わらずeditorが初期表示されること
3. モバイルでlocalStorageに `'editor'` が保存されていても、previewが初期表示されること
4. モバイルでeditorタブへの切替が正常に動作すること

---

### SF-3: FilePanelContent.tsxのinitialViewMode='preview'との整合性整理

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/FilePanelContent.tsx:478`

**問題**:
PC版 `FilePanelContent` 内の `MarkdownWithSearch` は既に `initialViewMode="preview"` をMarkdownEditorに渡している。このパスでは `viewMode='preview'` のため `showMobileTabs=false` となり、MobileTabBarは表示されない。モバイルでは通常FilePanelContentは使用されない（FileViewer Modal経由）ため直接の問題はないが、影響範囲分析として明記しておくべき。

**推奨対応**:
Issueの影響範囲セクションに、FilePanelContent経由のパスは今回の変更の影響外であることを明記する。

---

## Nice to Have（あれば良い）

### NTH-1: タブレット端末での挙動の注記

**カテゴリ**: 移行考慮
**場所**: `src/components/worktree/MarkdownEditor.tsx:210-211`

**問題**:
タブレット端末（768px未満かつランドスケープ）では、`isMobile=true` だが `isMobilePortrait=false` となり、showMobileTabsがfalseになる。この場合はデスクトップレイアウトが表示されるため、mobileTabの変更は影響しない。

**推奨対応**:
Issueの補足情報にタブレット端末での挙動を注記すると、実装者・テスターの混乱を防げる。

---

### NTH-2: CLAUDE.mdへの変更履歴追記

**カテゴリ**: ドキュメント更新

**推奨対応**:
実装完了後、CLAUDE.mdの `MarkdownEditor.tsx` エントリにIssue #549による変更（モバイル時mobileTab初期値変更）を追記する。

---

## 回帰リスク分析

| リスク | 影響度 | 可能性 | 対策 |
|--------|--------|--------|------|
| PC版のviewMode/localStorageに影響 | 高 | 低 | isMobile条件による分岐で隔離 |
| モバイルでMobileTabBar非表示 | 中 | 中 | SF-1対応（viewMode='split'の確保） |
| SSR hydration mismatch | 高 | 中 | MF-1対応（useEffect方式） |
| MARPファイル表示の破壊 | 高 | なし | MARP検出は別パス |
| ファイルポーリングへの影響 | 中 | なし | mobileTab変更はポーリングに無関係 |

---

## 参照ファイル

### コード
- `src/components/worktree/MarkdownEditor.tsx`: 変更対象（mobileTab初期値、viewMode制御）
- `src/components/worktree/MarkdownPreview.tsx`: MobileTabBarコンポーネント定義（影響なし）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: モバイルMarkdownEditor呼び出し元
- `src/components/worktree/FilePanelContent.tsx`: PC版ファイルパネル（影響なし確認済み）
- `src/components/worktree/FileViewer.tsx`: モバイルファイルビューアModal（影響なし確認済み）
- `src/hooks/useIsMobile.ts`: モバイル判定hook（SSR初期値制約）
- `src/types/markdown-editor.ts`: 型定義・定数（変更不要）
- `tests/unit/components/MarkdownEditor.test.tsx`: 既存テスト（テスト追加推奨）

### ドキュメント
- `CLAUDE.md`: モジュールリファレンス（実装後に更新推奨）
