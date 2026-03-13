# Issue #490 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: acceptable

Issue #490は既存のファイル表示基盤（image/video/markdown）と同様のパターンで拡張する設計であり、アーキテクチャ的には妥当である。ただし、CSP設定との競合と既存テスト破壊の2点はMust Fixとして実装前に対処が必要。

---

## Must Fix（必須対応）

### S3-001: CSPにframe-srcディレクティブが未定義のためiframe srcDocがブロックされる可能性

**カテゴリ**: セキュリティ・CSP設定との競合
**影響コンポーネント**: `next.config.js`, `HtmlPreview.tsx`（新規）, `FilePanelContent.tsx`

**問題**:
`next.config.js`（57-67行目）のCSPヘッダーに`frame-src`/`child-src`が定義されていない。`default-src 'self'`がフォールバックとして適用されるため、`srcdoc`属性を使用したiframeのコンテンツ表示がブロックされる可能性がある。

**証拠**:
```javascript
// next.config.js 行58-67
value: [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
].join('; '),
```

`frame-src`が未定義のため、iframeの`srcdoc`コンテンツが`default-src 'self'`の制約を受ける。

**推奨対応**:
1. `next.config.js`のCSPに `frame-src 'self' blob:` を追加
2. Issueの影響範囲テーブルに`next.config.js`を追加
3. 受入条件に「CSP設定下でiframeプレビューが動作すること」を追加

---

### S3-002: editable-extensions.tsへの.html/.htm追加により既存テストが失敗する

**カテゴリ**: 既存テストの破壊
**影響コンポーネント**: `tests/unit/config/editable-extensions.test.ts`, `src/config/editable-extensions.ts`

**問題**:
既存テスト（28-31行目）が`EDITABLE_EXTENSIONS`の長さが1であることをアサートしている。

**証拠**:
```typescript
// tests/unit/config/editable-extensions.test.ts 行28-31
it('should only include .md for now', () => {
  expect(EDITABLE_EXTENSIONS).toHaveLength(1);
  expect(EDITABLE_EXTENSIONS[0]).toBe('.md');
});
```

`.html`と`.htm`を追加すると長さが3になり、このテストが失敗する。

**推奨対応**:
1. テストを更新: 長さを3に、`.html`/`.htm`の存在確認を追加
2. `EXTENSION_VALIDATORS`テストにHTMLエントリの検証を追加
3. Issueの実装タスクに「既存テスト修正」を明記

---

## Should Fix（推奨対応）

### S3-003: FileContent.isHtml追加時のcanCopy判定およびcodeViewData生成への影響

**カテゴリ**: 型定義変更の波及効果
**影響コンポーネント**: `FileViewer.tsx`, `FilePanelContent.tsx`, `models.ts`

**問題**:
`FileViewer.tsx`の`canCopy`（78-80行目）は`isImage`と`isVideo`のみを除外条件としている。`codeViewData`（258-280行目）の生成にも`isHtml`チェックが必要。HTMLプレビュー表示時にcodeViewDataが不要に生成される。

`FilePanelContent.tsx`では`content.extension === 'md'`（660行目）による分岐があり、HTML分岐を同様のパターンで追加する際の排他制御が必要。

**推奨対応**:
- `renderContent()`に`isHtml`分岐を`isVideo`チェックの後に追加
- `codeViewData`の`useMemo`に`isHtml`条件を追加
- Issueの実装タスクに具体的な修正ポイントを列挙

---

### S3-004: HTMLファイル編集・保存時のvalidateContent対応

**カテゴリ**: PUT APIルートへの影響
**影響コンポーネント**: `route.ts`, `editable-extensions.ts`, `file-operations.ts`

**問題**:
PUTハンドラ（312-360行目）では`isEditableFile()` -> `validateContent()`の順で処理する。`EDITABLE_EXTENSIONS`に`.html`を追加するが`EXTENSION_VALIDATORS`に追加しないと、`validateContent()`が`'Unsupported extension'`を返して保存APIが壊れる。

POST（366-413行目）でも同様の影響がある。

**推奨対応**:
- `EDITABLE_EXTENSIONS`と`EXTENSION_VALIDATORS`は必ず同時に追加（アトミック変更）
- HTML用`maxFileSize`: `5 * 1024 * 1024`（5MB）
- `additionalValidation`の実装有無を明示

---

### S3-005: FileViewer.tsxのHTML表示分岐でモバイル固有の考慮事項

**カテゴリ**: モバイル版への影響
**影響コンポーネント**: `FileViewer.tsx`

**問題**:
`FileViewer.tsx`はモーダル内にコンテンツを表示し、`max-h-[60vh]`の制約がある。MARPでは`isFullscreen`に応じた高さ切り替えを実装している（行321-322）が、HTMLプレビューにも同様の対応が必要。また、FileViewer.tsxにはタブ切り替えUIの既存基盤がないため、ソース/プレビュー切り替えは新規実装が必要。

**推奨対応**:
- iframeの高さを`isFullscreen`で分岐
- タブ切り替えUIをMARPナビゲーションの後に配置
- 実装タスクにFileViewer.tsx内のタブ切り替えUI新規実装を具体的に記載

---

### S3-006: editable-extensions追加がMarkdownEditorの動作に影響しないことの確認

**カテゴリ**: MarkdownEditorへの影響
**影響コンポーネント**: `MarkdownEditor.tsx`, `editable-extensions.ts`

**問題**:
`MarkdownEditor.tsx`は`EDITABLE_EXTENSIONS`を直接参照していない。呼び出し元の`FilePanelContent.tsx`では`extension === 'md'`の条件分岐内でのみ呼び出される。直接的影響はないが、HTMLファイルの保存バリデーションパスがMDと異なる（`additionalValidation`の有無）点はドキュメント化すべき。

**推奨対応**:
- HTMLファイルの編集はHtmlPreview.tsxで行い、MarkdownEditorを再利用しない方針をIssueに明記

---

## Nice to Have（あれば良い）

### S3-007: useFileContentPollingとHTMLプレビューの相互作用

**カテゴリ**: ポーリング・パフォーマンス
**影響コンポーネント**: `useFileContentPolling.ts`, `HtmlPreview.tsx`（新規）

**問題**:
HTMLプレビューモード（編集なし）ではisDirtyは常にfalseでポーリングが継続する。外部変更時にsrcDocが更新されると、インタラクティブ状態（ゲーム進行中等）がリセットされる。

**推奨対応**:
- Interactiveモード以上でのポーリング抑制オプションを将来の改善として検討

---

### S3-008: 影響範囲テーブルにnext.config.jsとテストファイルが含まれていない

**カテゴリ**: 影響範囲の網羅性

**問題**:
影響範囲テーブルに以下が欠落:
- `next.config.js`（CSP設定変更）
- `tests/unit/config/editable-extensions.test.ts`（既存テスト更新）
- 新規テストファイル（具体的なパス未記載）

**推奨対応**:
影響範囲テーブルに以下を追加:
1. `next.config.js` - CSPにframe-src追加
2. `tests/unit/config/editable-extensions.test.ts` - 既存テスト更新
3. `tests/unit/config/html-extensions.test.ts` - 新規テスト
4. `tests/unit/components/html-preview.test.ts` - 新規テスト

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `next.config.js` (行57-67) | CSPヘッダー定義。frame-src未定義が問題 |
| `tests/unit/config/editable-extensions.test.ts` (行28-31) | EDITABLE_EXTENSIONS長さアサート。破壊される |
| `src/components/worktree/FileViewer.tsx` (行78-80, 258-280) | canCopy判定とcodeViewData生成 |
| `src/components/worktree/FilePanelContent.tsx` (行630-702) | ファイルタイプ別表示分岐 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` (行259-360) | GET/PUTハンドラ |
| `src/config/editable-extensions.ts` (行14, 32-37) | EDITABLE_EXTENSIONSとEXTENSION_VALIDATORS |
| `src/types/models.ts` (行278-293) | FileContentインターフェース |
| `src/hooks/useFileContentPolling.ts` | ポーリングフック |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | モジュールリファレンスとの整合性確認 |
