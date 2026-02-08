# Issue #104 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-01
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 3 |

**総合評価**: Issue #104の影響範囲は適切に特定されています。修正案1（z-index条件の変更）は最も影響が小さく、リグレッションリスクも低いと評価されます。ただし、テスト戦略とデスクトップ環境への影響について追加の考慮が必要です。

---

## Should Fix（推奨対応）

### SF-1: iPad Chrome固有のテストケースがテスト戦略に含まれていない

**カテゴリ**: テスト範囲
**場所**: ## 受け入れ条件

**問題**:
iPad Chrome（横置き）での動作確認を受け入れ条件に明記しているが、自動テストでこの環境をどのようにカバーするか（E2Eテスト、手動テスト等）が明確化されていません。

**証拠**:
- 現在のテストスイートはjsdom環境でのユニットテストが中心
- `tests/unit/components/MarkdownEditor.test.tsx` にMaximize機能のテストはあるが、iPad Chrome固有のFullscreen API挙動はモック環境では再現不可能

**推奨対応**:
- Playwrightのwebkit/chromiumエミュレーションの利用を検討
- または、BrowserStackなどのクロスブラウザテストサービスの利用を検討
- 最低限、手動テストチェックリストを受け入れ条件に追加

---

### SF-2: 修正案1（z-index条件の変更）によるデスクトップへの影響が分析されていない

**カテゴリ**: 影響ファイル
**場所**: ## 修正方針案 > 案1

**問題**:
z-index条件を `isMaximized` のみに変更した場合、デスクトップのFullscreen API成功時にも不必要にz-indexが設定されます。これがパフォーマンスや他のz-index要素との競合に影響しないかの確認が必要です。

**証拠**:
`src/config/z-index.ts` のz-index階層:
```typescript
MAXIMIZED_EDITOR: 40,
MODAL: 50,
TOAST: 60,
CONTEXT_MENU: 70
```

- 最大化エディタのz-index(40)はModal(50)やToast(60)より低い
- Fullscreen API成功時はブラウザが要素を最上位に配置するためz-indexは本来不要
- 条件を緩和すると不必要なスタイル適用が発生する

**推奨対応**:
- デスクトップ環境でのテスト実施時に、z-index設定による視覚的問題がないことを確認
- 必要であれば、Issue本文にデスクトップ環境への影響が限定的である旨を追記

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.mdへの影響記載がない

**カテゴリ**: ドキュメント更新
**場所**: Issue本文全体

**問題**:
Issue #99の設計がIssue #104のバグ原因である可能性があるため、修正後のドキュメント更新について言及がありません。

**推奨対応**:
CLAUDE.mdの「最近の実装機能」セクションにある Issue #99 の記載を更新し、iPad Chrome対応についての注記を追加することを検討。

---

### NTH-2: WorktreeDetailRefactored.tsx でのMarkdownEditor使用箇所への影響確認が不足

**カテゴリ**: 依存関係
**場所**: ## 影響範囲

**問題**:
WorktreeDetailRefactored.tsxでMarkdownEditorをModal内で使用しています（L1510-1517, L1627-1634）。最大化機能がModal内で使用された場合の挙動を確認すべきです。

**証拠**:
```typescript
// WorktreeDetailRefactored.tsx L1503-1519
{editorFilePath && (
  <Modal
    isOpen={true}
    onClose={handleEditorClose}
    title={editorFilePath.split('/').pop() || 'Editor'}
    size="full"
  >
    <div className="h-[80vh]">
      <MarkdownEditor
        worktreeId={worktreeId}
        filePath={editorFilePath}
        onClose={handleEditorClose}
        onSave={handleEditorSave}
      />
    </div>
  </Modal>
)}
```

**推奨対応**:
Modal(z-index=50)とMaximizedEditor(z-index=40)の関係を確認するテストを追加。

---

### NTH-3: 既存のE2Eテストへの影響確認が記載されていない

**カテゴリ**: リグレッション
**場所**: Issue本文全体

**問題**:
既存のE2Eテストへの影響確認について言及がありません。

**推奨対応**:
- セレクタ（data-testid）やスタイルに依存するテストへの影響を確認
- 変更なしであれば明記

---

## 影響分析

### 影響を受けるコンポーネント

| ファイル | 行番号 | 変更種別 | リスク |
|---------|--------|----------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | L436-441 | 修正 | 中 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | L1503-1519, L1620-1636 | 影響確認必要 | 低 |
| `src/hooks/useFullscreen.ts` | N/A | 変更なし | 低 |
| `src/hooks/useIsMobile.ts` | N/A | 変更なし | 低 |
| `src/config/z-index.ts` | N/A | 変更なし | 低 |

### テストへの影響

| ファイル | 変更要否 | 説明 |
|---------|---------|------|
| `tests/unit/components/MarkdownEditor.test.tsx` | 追加推奨 | isFallbackMode=falseかつisMaximized=trueの場合のz-index設定確認テスト |
| `tests/unit/hooks/useFullscreen.test.ts` | なし | フック動作は正常 |
| `tests/unit/hooks/useIsMobile.test.ts` | なし | 案1では変更不要 |

### リグレッションリスク

| ID | 重要度 | 説明 | 影響環境 |
|----|--------|------|----------|
| RR-1 | 低 | デスクトップでのFullscreen API成功時の挙動変化 | Windows/Mac Chrome, Safari |
| RR-2 | 低 | iOS Safari（縦向き）での挙動への影響 | iOS Safari |
| RR-3 | 中 | Modal内でMarkdownEditorを使用した際のz-index競合 | 全環境 |

### 破壊的変更

なし

---

## z-index階層分析

現在の設定（`src/config/z-index.ts`）:

```
Layer 1: DROPDOWN      (10) - ドロップダウンメニュー
Layer 2: MAXIMIZED_EDITOR (40) - 最大化エディタ
Layer 3: MODAL         (50) - モーダルダイアログ
Layer 4: TOAST         (60) - トースト通知
Layer 5: CONTEXT_MENU  (70) - コンテキストメニュー
```

**分析結果**:
- Modal(50) > MaximizedEditor(40) の関係により、Modal内でのMarkdownEditor最大化は正常に機能する
- 案1の適用後もこの階層関係は維持される
- Fullscreen API成功時はブラウザが要素を最上位に配置するため、z-indexの重複設定は視覚的に問題なし

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownEditor.tsx` L436-441 | 修正対象。containerStyleのz-index条件 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` L1503-1519, L1620-1636 | MarkdownEditorの使用箇所（Modal内） |
| `src/config/z-index.ts` L21-36 | z-index階層定義 |
| `tests/unit/components/MarkdownEditor.test.tsx` L590-729 | Maximize Feature, Keyboard Shortcuts テスト |
| `tests/unit/hooks/useFullscreen.test.ts` | useFullscreenフックのテスト |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md` | Issue #99設計書。z-index条件設計の根拠 |
| `CLAUDE.md` | Issue #99の機能説明。iPad Chrome対応についての追記が必要な可能性 |

---

## 結論

Issue #104の影響範囲分析は概ね適切ですが、以下の点について追加の考慮を推奨します：

1. **テスト戦略の明確化**: iPad Chrome環境でのテスト方法（E2E、手動テスト等）を明記
2. **デスクトップ影響の確認**: 案1適用後のデスクトップ環境での動作確認をテスト計画に含める

修正案1（z-index条件の変更）は影響範囲が最も小さく、リグレッションリスクも低いため、推奨されるアプローチです。

---

*レビュー実施日: 2026-02-01*
