# Issue #723 仮説検証レポート

**対象Issue**: #723 perf(file-panel): 大規模ファイルでPC版がハングする問題への対応
**検証方法**: Exploreエージェント（very thorough）によるコードベース照合
**検証日**: 2026-05-28

## 結論サマリー

| # | 仮説 | 判定 |
|---|------|------|
| H1 | テキストファイル読み込みにサイズ上限なし | **Partially Confirmed** |
| H2 | CodeViewer の同期ハイライト | Confirmed |
| H3 | 仮想化なしで全行マウント | Confirmed |
| H4 | ポーリング毎の全文再取得 | **Partially Confirmed** |
| H5 | 検索の同期実行・debounceなし | Confirmed |
| H6 | 画像/動画/PDF/HTML には既にサイズ上限あり | **Partially Confirmed** |
| H7 | hljs は全文無しに正しく着色できない | Confirmed |
| H8 | `isEditableExtension` の対象 | Confirmed |
| H9 | `src/lib/file-operations.ts` 拡張可能 | Confirmed |
| H10 | `ERROR_CODE_TO_HTTP_STATUS` 流用可能 | Confirmed |

---

## 詳細検証結果

### H1. テキストファイル一括読み込みにサイズ上限なし（Partially Confirmed）

**Issueの主張**: `src/app/api/worktrees/[id]/files/[...path]/route.ts:335` でテキストファイルだけサイズ上限なしで `readFile(..., 'utf-8')` 一括実行。

**実コード**:
- `route.ts:335` の `readFileContent()` は確かにサイズチェックなしで全文読み込み。
- ただし**編集系ファイル**（`isEditableExtension` 該当）には `editable-extensions.ts:17` で `TEXT_MAX_SIZE_BYTES = 1MB` が定義され、`validateContent()` で**事後チェック**されている。
- HTML（`route.ts:311`）は事前チェック有り（HTML_MAX_SIZE_BYTES = 5MB）。

**正確な現状**:
| ファイル種別 | サイズ上限 |
|------------|-----------|
| 通常テキスト（非編集系） | **なし** |
| 編集系テキスト（`.md`, `.yaml`, `.yml`, `.html`, `.htm`） | 1MB（事後検証） |
| HTML | 5MB（事前検証） |
| 画像 | 20MB |
| 動画 | 100MB |
| PDF | 20MB |

**Issue本文への修正示唆**:
- 「テキストファイルだけサイズ上限なし」→「**通常テキスト（非編集系）だけ**サイズ上限なし」と明確化が必要。
- Issueが提案する編集系上限値 **2MB** は、既存の `TEXT_MAX_SIZE_BYTES = 1MB` と矛盾。既存値との整合を整理する必要あり（既存値を引き上げるのか、新規上限とするのか）。

---

### H2. CodeViewer の同期ハイライト（Confirmed）

**実コード**: `FilePanelContent.tsx:239-246` の `useMemo` 内で `hljs.highlight(content, {language: extension})` を同期実行。失敗時 `hljs.highlightAuto(content)` フォールバック。Web Worker 化なし。

**判定**: 仮説通り。万行単位でメインスレッド長時間ブロック。

---

### H3. 仮想化なしで全行マウント（Confirmed）

**実コード**: 
- `FilePanelContent.tsx:248` で `Array.from({length: content.split('\n').length})` で全行数の配列作成。
- L270-291 で `lineNumbers.map()` により全行の `<tr>` をマウント。
- `package.json` に `@tanstack/react-virtual` 等の仮想化依存なし。

**判定**: 仮説通り。

---

### H4. ポーリング毎の全文再取得（Partially Confirmed）

**実コード**: `useFileContentPolling.ts:48-67`、`file-polling-config.ts:11` の `FILE_CONTENT_POLL_INTERVAL_MS = 5000`。

**ただし**:
- L51 の `enabled` で `isPdf || isDirty || loading` で無効化済み。
- L56 で `If-Modified-Since` ヘッダ送信、304 応答ならスキップ。

**判定**: ポーリング間隔とmtime変更時の全文取得は事実。ただし「全文再取得→再ハイライト→再レンダリングが反復」のうち、**未変更時は304で抑止される**ことをIssueは記述していない。

**Issue本文への修正示唆**: 「mtime未変更時は304スキップ済み。問題はmtime変更時に5秒毎の全文再ロードが連鎖する点」と精緻化推奨。

---

### H5. 検索の同期実行・debounceなし（Confirmed）

**実コード**: `useFileContentSearch.ts:72-88`。
- L78: `content.split('\n')`
- L81-84: `lines.forEach()` で全行 `toLowerCase().includes()` 同期実行。
- debounce 無し（setTimeout は focusDelay のみ L61）。
- `useEffect` 依存配列 `[searchQuery, content]` で毎入力ごと再計算。

**判定**: 仮説通り。

---

### H6. 画像/動画/PDF/HTML には既にサイズ上限あり（Partially Confirmed）

**実コード**:
| 種別 | 定数 | 値 |
|------|------|-----|
| 画像 | `IMAGE_MAX_SIZE_BYTES` | **20MB** |
| 動画 | `VIDEO_MAX_SIZE_BYTES` | 100MB |
| PDF | `PDF_MAX_SIZE_BYTES` | 20MB |
| HTML | `HTML_MAX_SIZE_BYTES` | 5MB |

**Issueの主張との不一致**: Issueは「画像 5MB」と記述しているが**実際は 20MB**。

**Issue本文への修正示唆**: 「画像 5MB」→「画像 20MB」へ修正。並びの一貫性をどう取るかの議論も再整理。

---

### H7. hljs は全文無しに正しく着色できない（Confirmed・設計判断妥当）

シンタックスハイライタは複数行コメント、テンプレートリテラル、Markdownコードブロック等の構文境界に文脈依存があり、部分読み込みでは正しい着色ができない。Issue のハイブリッド方針の根拠として妥当。

**Issueの「言語依存の境界問題は既知の制約として許容、ドキュメントに明記」**: ドキュメント明記必須。

---

### H8. `isEditableExtension` の対象（Confirmed・補足あり）

**実コード**: `editable-extensions.ts:23`
```
EDITABLE_EXTENSIONS = ['.md', '.html', '.htm', '.yaml', '.yml']
```

**補足**: `.html` / `.htm` が**編集系に含まれている**。Issueは `.md / .yaml / .yml` のみを例示しているが、HTML も編集対象。

**設計上の重要点**: HTML は `route.ts:311` で 5MB 上限（事前）+ `editable-extensions.ts:17` で 1MB 上限（事後）の二重ガードがある形。Issue の編集系上限 2MB は HTML の 5MB 事前ガードと整合させる必要あり。

---

### H9. `src/lib/file-operations.ts` 拡張可能（Confirmed）

**実コード**: `file-operations.ts:251-276` に `readFileContent(worktreeRoot, relativePath)` が存在。現状は `readFile(..., 'utf-8')` 直接呼び出し。ストリーム読み基盤（`readline` 利用）はまだ存在しない。新規 `readFileLineRange()` 追加可能。

---

### H10. `ERROR_CODE_TO_HTTP_STATUS` 流用可能（Confirmed）

**実コード**: `route.ts:60-87` の `ERROR_CODE_TO_HTTP_STATUS` に既に `FILE_TOO_LARGE: 413` が定義（L79）。`createErrorResponse()` が参照（L97）。Issue の提案通り流用可能。

---

## Stage 1 への申し送り事項

以下、レビュー時に重点的に扱うべき論点：

1. **H1 / H8 の整合**: 「編集系には既に1MB上限あり」と「Issueが提案する2MB上限」が矛盾。既存上限の引き上げか、新定数の定義か、選択肢を明示。
2. **H6 の数値修正**: 「画像 5MB」→「画像 20MB」。Issue本文の保守的設定の根拠も再整理。
3. **H4 の精緻化**: 304スキップ機構の存在を明記し、問題は mtime 変更時の連鎖再ロードに限定すること。
4. **H8 の拡張子拡張**: `.html`, `.htm` も編集系扱い。設計方針に追記必要。
5. **設計上の留意**: 同じファイル（特に HTML）に複数のサイズガードが共存することの整合性検討。

これらは Stage 1 「通常レビュー」の Must Fix / Should Fix 候補となる。
