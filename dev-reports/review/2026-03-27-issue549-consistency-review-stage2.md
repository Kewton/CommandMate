# Issue #549 Stage 2: 整合性レビュー (Consistency Review)

**レビュー日**: 2026-03-27
**対象**: dev-reports/design/issue-549-mobile-markdown-viewer-design-policy.md
**ステータス**: approved_with_findings
**スコア**: 4/5

---

## 概要

設計方針書がコードベースの現状を正確に記述しているかを検証した。行番号、関数名、ファイルパス、コンポーネント関係図、状態管理パターン、テスト戦略の各観点で整合性を確認した。

全体として設計方針書は高い精度でコードベースを記述しており、提案されている変更も既存パターンと整合している。ただし、FilePanelContentの記述に不完全な点、テストモック戦略のプロジェクトパターンとの不一致がある。

---

## 検証結果サマリ

| チェック項目 | 結果 | 備考 |
|-------------|------|------|
| コードベース記述の正確性 | partial | FilePanelContentの記述不完全 |
| 行番号・関数名の一致 | pass | 全て正確に一致 |
| 既存パターンとの整合性 | pass | useEffect遅延初期化、initialViewMode prop使用ともに既存パターンと一致 |
| コンポーネント関係図 | partial | Desktop Modalパスの欠落 |
| 状態管理アプローチ | pass | mobileTab, viewMode, localStorageすべて既存と整合 |
| テスト戦略のAPI/パターン参照 | partial | MOBILE_BREAKPOINTエクスポート不足 |

---

## 検出事項

### MF-001: FilePanelContentのinitialViewMode記述が不正確 [should_fix]

設計方針書セクション2の「変更しないファイル」テーブルにて「FilePanelContent.tsx - PC側パネル。既にinitialViewMode='preview'を渡している」と記載されている。

実際のFilePanelContent.tsx内には2箇所のMarkdownEditor呼び出しがある:

- **MarpRenderableMarkdownコンポーネント内（line 405）**: `initialViewMode="split"`
- **MarkdownWithSearchコンポーネント内（line 478）**: `initialViewMode="preview"`

設計方針書は後者のみを記述しており不完全。

**推奨**: 両方のパスを記述するか、「2箇所で異なるinitialViewModeを渡している」と明記する。

---

### MF-002: useIsMobileモックにMOBILE_BREAKPOINTエクスポートが不足 [should_fix]

設計方針書セクション8のモック戦略:

```typescript
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true),
}));
```

プロジェクト既存パターン（7箇所以上で使用）:

```typescript
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true),
  MOBILE_BREAKPOINT: 768,
}));
```

MarkdownEditor自体はMOBILE_BREAKPOINTを直接importしていないため実行時エラーにはならないが、テストの一貫性のためプロジェクトパターンに合わせるべき。

---

### MF-004: Desktop側のMarkdownEditor呼び出しパスが関係図に不足 [nice_to_have]

コンポーネント関係図ではDesktop側を「FilePanelContent -> MarkdownEditor (initialViewMode='preview')」としているが、以下のパスが欠落:

1. FilePanelContent内のMarpRenderableMarkdown経由（initialViewMode='split'）
2. WorktreeDetailRefactored.tsx line 1597のDesktop Modal経由（initialViewModeなし）

今回の変更対象はMobile Modalパス（line 1869）のみであり、実装には影響しない。

---

## 行番号検証

| 設計方針書の記述 | 実際のコード | 結果 |
|----------------|------------|------|
| mobileTab state: 134行目付近 | MarkdownEditor.tsx line 134 | 一致 |
| Mobile MarkdownEditor: 1869行目付近 | WorktreeDetailRefactored.tsx line 1869 | 一致 |
| MobileTab型: MarkdownPreview.tsx export | MarkdownPreview.tsx line 39 | 一致 |
| MobileTabBar: MarkdownPreview.tsx export | MarkdownPreview.tsx line 50 | 一致 |
| getInitialViewMode関数 | MarkdownEditor.tsx line 80 | 一致 |
| useIsMobile: 初期値false | useIsMobile.ts line 55 | 一致 |
| LOCAL_STORAGE_KEY: 'commandmate:md-editor-view-mode' | markdown-editor.ts line 192 | 一致 |
| showMobileTabs計算 | MarkdownEditor.tsx line 211 | 一致 |
| EditorProps.initialViewMode | markdown-editor.ts line 85 | 一致 |

---

## リスク評価

**総合リスク**: 低

- 変更スコープが2ファイルに限定
- 設計方針書の不正確な点はすべて「変更しないファイル」に関する記述の不完全さ
- 提案されるuseEffect + initialViewMode='split'のアプローチは既存パターンと完全に整合
- テストモック戦略の不足は実装時に容易に修正可能

---

## 推奨アクション

| 優先度 | アクション | 理由 |
|--------|-----------|------|
| should_fix | FilePanelContentの記述を正確化する（MF-001） | 将来のリファクタリング参照時の誤解防止 |
| should_fix | テストモック戦略にMOBILE_BREAKPOINTを追加する（MF-002） | プロジェクト全体のテストパターン一貫性 |
| nice_to_have | コンポーネント関係図にDesktop Modalパスを追記する（MF-004） | 設計方針書の完全性向上 |
