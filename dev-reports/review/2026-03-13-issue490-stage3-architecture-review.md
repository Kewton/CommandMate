# Issue #490 Stage 3 影響分析レビュー

- **Issue**: #490 HTMLファイル レンダリング
- **Stage**: 3 (影響分析レビュー)
- **レビュー日**: 2026-03-13
- **対象文書**: `dev-reports/design/issue-490-html-preview-design-policy.md`

---

## 総合評価: good

設計方針書はHTMLプレビュー機能の影響範囲を概ね適切に把握しており、主要な変更対象ファイル（FilePanelContent, FileViewer, editable-extensions, route.ts, models.ts）が明確に列挙されている。ただし、CSP変更と既存MARP機能の整合性、POST APIへの波及効果、ポーリング制御のデータフロー詳細に関して補足が必要である。

| 区分 | 件数 |
|------|------|
| must_fix | 2 |
| should_fix | 3 |
| nice_to_have | 2 |

---

## must_fix (2件)

### DR3-001: frame-src追加とX-Frame-Options: DENYの矛盾、および既存MARPプレビューへの影響分析の欠如

**カテゴリ**: CSP設定変更の既存機能への影響

**影響コンポーネント**:
- `next.config.js`
- `src/components/worktree/FilePanelContent.tsx` (MARPプレビュー部分)
- `src/components/worktree/FileViewer.tsx` (MARPプレビュー部分)

**詳細**:
`next.config.js`に`frame-src 'self' blob:`を追加する設計だが、同じ設定ファイルに`X-Frame-Options: DENY`が存在する（行32-33）。srcdocのiframeは同一ページ内のインラインフレームであるためX-Frame-Optionsの影響は受けないが、設計方針書にこの技術的整理が不足している。

さらに重要な点として、既存のMARPプレビュー（FilePanelContent.tsx行312-315、FileViewer.tsx行316-320）は現在`frame-src`未定義のまま`srcDoc` iframeが動作している。`frame-src`を明示追加すると`default-src 'self'`フォールバックが上書きされるため、追加後も既存MARPプレビューが問題なく動作することの確認が設計方針書に記載されていない。

**改善提案**:
設計方針書のセクション4-2に以下を追記する:
1. `X-Frame-Options: DENY`はページが他サイトのiframeに埋め込まれることを防ぐヘッダーであり、ページ内のsrcdoc iframeには影響しない旨
2. 既存MARPプレビュー（`sandbox=""`のsrcDoc iframe）が`frame-src`追加後も正常動作する旨の確認記述
3. `frame-src 'self' blob:`の追加前後で既存iframe動作が変わらないことの根拠

---

### DR3-002: editable-extensions.tsへのhtml/htm追加がPOST APIのコンテンツバリデーションにも波及する

**カテゴリ**: PUT API書き込み許可リスト拡大の影響

**影響コンポーネント**:
- `src/config/editable-extensions.ts`
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` (POST handler)

**詳細**:
設計方針書はPUT APIへの影響を正しく認識しているが、POST API（route.ts行386-394）でも`isEditableExtension()`と`validateContent()`が呼ばれている。POST APIでは新規ファイル作成時に拡張子チェックし、該当する場合にコンテンツバリデーションを適用する。`.html`/`.htm`を`EDITABLE_EXTENSIONS`と`EXTENSION_VALIDATORS`に追加すると、POST APIでHTMLファイルを新規作成する際にも5MBサイズ制限とバイナリ検出が適用される。これは意図した動作だが、設計方針書に明示されていない。

**改善提案**:
設計方針書のセクション5に「POST APIへの影響: POST /api/worktrees/[id]/files/[...path]で.htmlファイルを新規作成する場合にもEXTENSION_VALIDATORSによるサイズ制限（5MB）とバイナリ検出が適用される。これは意図した動作である。」と追記する。受入テスト（セクション6-2）にもPOST APIでのHTML新規作成テストケースを追加する。

---

## should_fix (3件)

### DR3-003: useFileContentPollingがHTMLファイルのisDirty制御と連携するパスの詳細不足

**カテゴリ**: ファイルポーリングとの相互作用

**影響コンポーネント**:
- `src/hooks/useFileContentPolling.ts`
- `src/components/worktree/HtmlPreview.tsx` (新規)
- `src/hooks/useFileTabs.ts`

**詳細**:
`useFileContentPolling`（行50）は`tab.isDirty`が`true`の場合にポーリングを無効化する。HtmlPreviewの`onDirtyChange`コールバックからuseFileTabs経由で`tab.isDirty`が更新されるデータフローが設計方針書で明示されていない。

**改善提案**:
セクション3-4に「HtmlPreview.onDirtyChange -> FilePanelContent.onDirtyChange(tab.path, isDirty) -> useFileTabs.setDirty -> tab.isDirty -> useFileContentPolling.enabled=false」というデータフロー図を追加する。

---

### DR3-004: isEditableExtensionとisHtmlExtensionのドット正規化非対称性に関するテスト不足

**カテゴリ**: 既存テストへの影響

**影響コンポーネント**:
- `tests/unit/config/editable-extensions.test.ts`
- `src/config/editable-extensions.ts`
- `src/config/html-extensions.ts` (新規)

**詳細**:
`isHtmlExtension`は`normalizeExtension`を使用してドットなし入力も受け付ける一方、`isEditableExtension`は`toLowerCase()`のみで処理する非対称設計（DR2-001で意図的と説明済み）。しかし、テスト設計で`isEditableExtension('html')`（ドットなし）がfalseを返すことを確認するケースが明示されていない。

**改善提案**:
テスト設計（セクション6-1）に`isEditableExtension('html')`がfalseを返すテストケースを追加する。

---

### DR3-005: FilePanelContent.tsxのisHtml分岐挿入位置の根拠明記

**カテゴリ**: FilePanelContentの分岐順序と拡張子判定の整合性

**影響コンポーネント**:
- `src/components/worktree/FilePanelContent.tsx`

**詳細**:
現在の分岐順序は`isImage -> isVideo -> md(extension) -> default`。HTML分岐は`isVideo`の後かつ`md`の前に配置する必要がある。`isHtml`はブーリアンフラグ判定のため`extension === 'md'`とは干渉しないが、挿入位置の根拠が設計方針書で不十分。

**改善提案**:
セクション3-5に分岐挿入位置が「isVideo分岐の後、extension==='md'分岐の前」であることを明示し、isHtmlフラグがAPIレスポンスのブーリアンフラグであり拡張子文字列比較と明確に分離される旨を追記する。

---

## nice_to_have (2件)

### DR3-006: FilePanelSplitへの変更不要確認

**カテゴリ**: FilePanelSplitへの影響なし確認

`FilePanelSplit.tsx`はpropsを透過的に委譲するレイアウトコンポーネントであり、`FileContent`型のフィールドを直接参照しない。設計方針書の変更対象一覧にFilePanelSplitが含まれていないのは正しい。対応不要。

---

### DR3-007: FileContent型を参照する15ファイルの影響なし確認

**カテゴリ**: FileContent型の波及効果

`isHtml?: boolean`はオプショナルフィールドであり、既存の`isImage`/`isVideo`と同パターン。`useFileTabs`、`FilePanelTabs`等のモジュールは`FileContent`オブジェクトを受け渡すのみでフィールドを直接参照しないため変更不要。

**改善提案**:
セクション3-2に「FileContentを参照する他のモジュールはオブジェクトの受け渡しのみを行い、isHtmlフィールドを直接参照しないため変更不要」と追記すると実装者の安心材料となる。

---

## 影響範囲マップ

```
変更元                          影響先
------                          ------
src/types/models.ts             -> 15ファイルが参照（オプショナル追加のため互換性問題なし）
  (FileContent.isHtml?)

src/config/editable-extensions  -> PUT API（route.ts行336-341）: バリデーション適用
  (.html/.htm追加)              -> POST API（route.ts行386-394）: バリデーション適用 [DR3-002]
                                -> isEditableFile()（file-operations.ts行167-169）: 編集可能判定
                                -> tests/unit/config/editable-extensions.test.ts: テスト更新必要

next.config.js                  -> 全ページのCSPヘッダー
  (frame-src追加)               -> 既存MARPプレビューのiframe [DR3-001]
                                -> 新規HtmlPreviewのiframe

src/components/worktree/        -> useFileContentPolling: isDirtyフラグ連携 [DR3-003]
  HtmlPreview.tsx (新規)        -> useFileTabs: isDirty状態管理
```

---

## 結論

設計方針書の影響範囲分析は概ね適切であり、主要な変更対象と既存パターンとの整合性が確保されている。must_fix 2件（CSP/MARP整合性、POST API波及）は設計方針書への追記で対応可能であり、実装上のリスクは低い。should_fix 3件はテスト網羅性と設計文書の明確化に関する指摘であり、実装品質の向上に寄与する。
