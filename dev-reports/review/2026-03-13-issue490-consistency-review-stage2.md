# Issue #490 Stage 2 整合性レビュー報告書

**レビュー日**: 2026-03-13
**対象**: Issue #490 HTMLファイル レンダリング 設計方針書
**レビュー種別**: 整合性レビュー（Stage 2）
**総合評価**: good

---

## 1. レビュー概要

設計方針書と既存コードベースの整合性を6つの観点から検証した。全体的に既存のvideo-extensions.ts / image-extensions.tsのパターンを正確に踏襲しており、型定義の拡張パターンやAPIルートの分岐パターンも適切に設計されている。

must_fix指摘2件、should_fix指摘3件、nice_to_have指摘2件の合計7件を報告する。

---

## 2. 指摘事項一覧

| ID | 重要度 | カテゴリ | タイトル |
|----|--------|---------|---------|
| DR2-001 | must_fix | 型定義・API整合性 | isEditableExtensionのドット正規化がisHtmlExtensionと不整合 |
| DR2-002 | must_fix | UIコンポーネント整合性 | FileViewer.tsxのcanCopyとcodeViewDataにisHtml考慮が未記載 |
| DR2-003 | should_fix | CSP設定整合性 | iframe srcdocのCSP frame-src要件の技術的根拠に不正確な記述 |
| DR2-004 | should_fix | 実装順序の依存関係整合性 | テスト実装が最後に配置されTDD原則と不整合 |
| DR2-005 | should_fix | テスト設計の網羅性 | editable-extensions.test.tsの既存テストとの整合性考慮が不足 |
| DR2-006 | nice_to_have | 用語・命名規則の一貫性 | srcdoc/srcDoc表記の混在 |
| DR2-007 | nice_to_have | 受入条件の網羅性 | エディタ保存フローのテストケースが未記載 |

---

## 3. 詳細分析

### DR2-001: isEditableExtensionのドット正規化不整合 [must_fix]

**問題**: 設計方針書ではhtml-extensions.tsのisHtmlExtension()がimage-extensions.tsのnormalizeExtension()を再利用する方針（DR1-002への対応）だが、editable-extensions.tsのisEditableExtension()は現在normalizeExtension()を使用していない。

**既存コード** (`src/config/editable-extensions.ts` 行45-49):
```typescript
export function isEditableExtension(extension: string): boolean {
  if (!extension) return false;
  const normalizedExt = extension.toLowerCase();
  return EDITABLE_EXTENSIONS.includes(normalizedExt);
}
```

ドットなし入力（例: `'html'`）を渡すとfalseが返る。現行ではAPIルート（route.ts行337）がextname()の結果（常にドット付き）を渡すため問題が顕在化していないが、html-extensions.tsとeditable-extensions.tsでドット正規化の実装が異なることは保守上の懸念となる。

**推奨対応**: 設計方針書に設計判断として明記する。統一するか、既存動作への依存を明示する。

---

### DR2-002: FileViewer.tsxのcanCopy/codeViewDataにisHtml考慮が未記載 [must_fix]

**問題**: 設計方針書セクション3-6ではFileViewer.tsx（モバイル版）にHTML分岐を追加する方針を示しているが、実装の詳細が不足している。

**既存コード** (`src/components/worktree/FileViewer.tsx` 行258-261):
```typescript
const codeViewData = useMemo(() => {
  if (!content || content.isImage || content.isVideo || (isMarp && marpSlides)) {
    return null;
  }
```

isHtmlフラグのファイルがこの分岐を通過し、CodeViewerとしてレンダリングされてしまう。renderContent()内にisHtml分岐を追加し、codeViewDataのガード条件にもcontent.isHtmlを含める必要がある。

**推奨対応**: セクション3-6に以下の実装詳細を追加する。
- renderContent()のcontent.isVideo分岐の後にcontent.isHtml分岐を追加
- codeViewDataのuseMemo内で`content.isHtml`を除外条件に追加
- canCopyはisHtml時もtrue（ソースHTMLのコピーは有用）

---

### DR2-003: CSP frame-srcの技術的根拠が不正確 [should_fix]

**問題**: 設計方針書セクション4-2の記述「srcdoc属性のiframeはブラウザによってblob: originとして扱われる」は技術的に正確ではない。srcdoc iframeのオリジンはHTML仕様上about:srcdocである。

**現行CSP** (`next.config.js` 行58-67):
frame-srcは未定義でdefault-src 'self'にフォールバック。frame-srcの明示追加自体は防御的で良い判断。

**推奨対応**: 技術的根拠を「ブラウザ実装間の互換性確保」に修正する。

---

### DR2-004: テスト実装順序がTDD原則と不整合 [should_fix]

**問題**: 実装順序ステップ9にユニットテストが配置されているが、既存テストファイル（video-extensions.test.ts等）のヘッダーに「TDD Approach: Red (test first) -> Green (implement) -> Refactor」と明記されている。

**推奨対応**: html-extensions.test.tsの作成をステップ1に繰り上げ、TDDサイクルに沿った順序にする。

---

### DR2-005: editable-extensions.test.tsの既存テスト更新詳細が不足 [should_fix]

**問題**: 既存テスト（editable-extensions.test.ts行28-31）に「should only include .md for now」というハードコードされた期待値がある。設計方針書のテスト設計ではlength更新のみ言及しているが、テスト名の変更、.html/.htmそれぞれのvalidateContentテスト、NULLバイト拒否テストが未記載。

**推奨対応**: テスト更新の詳細を網羅的に記載する。

---

### DR2-006: srcdoc/srcDoc表記の混在 [nice_to_have]

**問題**: HTML仕様の文脈では「srcdoc」、React JSXの文脈では「srcDoc」が正しいが、設計方針書内で文脈に関係なく混在している。

---

### DR2-007: 編集・保存フローのテストケース不足 [nice_to_have]

**問題**: HtmlPreviewにonFileSavedコールバックが定義されているが、受入テストにHTMLファイルの保存フローが含まれていない。

---

## 4. 整合性チェック結果

### 4-1. 設計方針書 vs 既存コード整合性

| 確認項目 | 結果 | 備考 |
|---------|------|------|
| FileContent型の拡張パターン（isImage/isVideo同様のisHtml追加） | OK | 既存パターンと一致 |
| video-extensions.tsのnormalizeExtension再利用パターン | OK | DR1-002で方針明記済み |
| APIルートの分岐パターン（isImage -> isVideo -> テキスト） | OK | isHtml分岐位置が適切 |
| FilePanelContent.tsxの分岐パターン（dynamic import + if分岐） | OK | 既存パターンと一致 |
| editable-extensions.tsのドット正規化方式 | NG | DR2-001参照 |
| FileViewer.tsxのisHtml対応詳細 | NG | DR2-002参照 |

### 4-2. 設計方針書の内部一貫性

| 確認項目 | 結果 | 備考 |
|---------|------|------|
| SandboxLevel型の定義場所（html-extensions.tsのみ） | OK | DR1-001反映済み |
| SANDBOX_ATTRIBUTESの2段階制限 | OK | DR1-003反映済み |
| EDITABLE_EXTENSIONS JSDoc更新方針 | OK | DR1-004反映済み |
| srcdoc/srcDoc用語の統一 | NG | DR2-006参照 |
| テスト設計とTDD原則の整合性 | NG | DR2-004参照 |

### 4-3. Issueの受入条件 vs テスト設計の網羅性

| 受入条件 | テストカバレッジ | 備考 |
|---------|---------------|------|
| HTMLファイルのプレビュー表示 | OK | 受入テスト記載あり |
| 3モード切り替え | OK | 受入テスト記載あり |
| サンドボックスのSafe/Interactive | OK | 受入テスト記載あり |
| 5MB超エラー表示 | OK | ユニットテスト+受入テスト記載あり |
| PC/モバイル両対応 | OK | 受入テスト記載あり |
| HTMLファイルの編集・保存 | NG | DR2-007参照 |

---

## 5. 総合評価

設計方針書は既存コードベースのパターンを的確に分析・踏襲しており、Stage 1レビュー指摘（DR1-001〜DR1-007）への対応も適切に反映されている。must_fix 2件は実装品質に直接影響するため設計方針書の修正が必要だが、設計の根幹に関わる問題ではなく、局所的な追記で対応可能。

**評価**: good（must_fix対応後、Stage 3レビューに進行可能）
