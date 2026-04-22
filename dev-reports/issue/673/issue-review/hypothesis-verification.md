# Issue #673 仮説検証レポート

## 対象Issue

- **Issue番号**: #673
- **タイトル**: pdfビューワ
- **種別**: feature

## 抽出した仮説/事実主張

Issue本文から技術的主張を6件抽出し、コードベースで照合した。

## 検証結果

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | FilePanelContentは画像・動画・HTML・Markdown・編集可能ファイルに対応、PDFはフォールバックでコード表示 | Confirmed | `src/components/worktree/FilePanelContent.tsx` L679-792（isImage/isVideo/isHtml/md/editable分岐+CodeViewerWithSearchデフォルト） |
| 2 | HtmlPreview（Issue #490）はiframe srcDoc + sandbox=""パターンを採用 | Confirmed | `src/components/worktree/HtmlPreview.tsx` L119-137（`sandbox={SANDBOX_ATTRIBUTES[sandboxLevel]}`） |
| 3 | ファイル取得APIで画像/動画をBase64 data URI形式で返却 | Confirmed | `src/app/api/worktrees/[id]/files/[...path]/route.ts` L188-189, L240-241（`data:${mimeType};base64,${base64}` 生成→content フィールドで返却） |
| 4 | FileContent型にisImage/isVideo/isHtmlフラグが存在（isPdf追加の前提） | Confirmed | `src/types/models.ts` L310-327（isImage/isVideo/isHtmlすべてoptional boolean） |
| 5 | pdf.js/react-pdf等のPDF関連ライブラリ未導入 | Confirmed | `package.json` dependenciesにPDF関連パッケージなし |
| 6 | path-validatorによるパストラバーサル/シンボリックリンク防御が存在 | Confirmed | `src/lib/security/path-validator.ts` L44-254（`isPathSafe`, `resolveAndValidateRealPath`[SEC-394]） |

## 総合判定

**全仮説Confirmed**。Issue #673の前提はすべて現行コードと一致しており、Base64 data URI返却基盤・iframe sandbox""セキュリティパターン・path-validator防御の既存資産をそのまま流用可能。

## Stage 1レビューへの申し送り事項

- Rejected仮説なし
- 実装アプローチ（ブラウザネイティブ + iframe sandbox="" + Base64 data URI）は既存HtmlPreview実装と整合する
- 新規ファイル（`src/config/pdf-extensions.ts`, `src/components/worktree/PdfPreview.tsx`）の命名・配置も既存パターン踏襲で問題なし
