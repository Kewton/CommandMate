# Issue #490 仮説検証レポート

## 検証日時
- 2026-03-13

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | MARPスライドと同じiframe srcDocパターンが参照実装として存在する | Confirmed | `src/app/api/worktrees/[id]/marp-render/route.ts` 存在確認。ただしMARPはサーバーサイドレンダリング（POST APIでHTML生成）であり、HTMLプレビューはクライアントサイドでsrcDocに直接流し込む別パターンになる |
| 2 | MarkdownEditorのソース/プレビュー分割パターンが参照実装として存在する | Confirmed | `src/components/worktree/MarkdownEditor.tsx` 存在確認。3モード（ソースのみ/プレビューのみ/分割）の実装パターン参照可 |
| 3 | `src/config/image-extensions.ts` がSVG XSS防止の参考実装として存在する | Confirmed | ファイル存在確認。`validateSvgContent`関数でscriptタグ・イベントハンドラ・危険URI検出を実装済み |
| 4 | `src/config/editable-extensions.ts` に `.html`, `.htm` を追加できる構造になっている | Confirmed | `EDITABLE_EXTENSIONS: readonly string[]` で`.md`のみ定義。`EXTENSION_VALIDATORS`配列にバリデーター追加も可能な設計 |
| 5 | `src/types/models.ts` の `FileContent` に `isHtml` フラグを追加できる | Confirmed | `isImage?: boolean`, `isVideo?: boolean` の既存パターンに合わせて `isHtml?: boolean` 追加が自然な設計 |
| 6 | `src/lib/security/sanitize.ts` が存在する | Confirmed | ファイル存在確認 |
| 7 | `FilePanelContent.tsx` はMarkdownEditor/MARPを動的importで扱っている | Confirmed | `dynamic()`でMarkdownEditorを遅延読み込み。HTMLPreviewも同様パターン適用可 |

## 詳細検証

### 仮説 1: MARP参照実装（iframe srcDocパターン）

**Issue内の記述**: 「iframe + sandbox属性を使用（MARPスライドと同じパターン）」

**検証手順**:
1. `src/app/api/worktrees/[id]/marp-render/route.ts` を確認
2. MARPはサーバーサイドで`@marp-team/marp-core`でMarkdownをHTMLに変換し、各スライドを`<!DOCTYPE html>...`形式で返すPOST API
3. フロントエンドはそのHTMLをiframeの`srcDoc`に設定

**判定**: Partially Confirmed

**根拠**: iframeを使うこと自体は同じパターンだが、MARPはサーバーサイドレンダリング、HTMLプレビューはクライアント側で生FileContentをsrcDocに流し込む形で実装が異なる。Issueに「同じパターン」と書かれているが、実際にはより単純な実装（APIは不要、ファイル取得APIの既存エンドポイントを流用）が適切。

**Issueへの影響**: 軽微。実装時に混乱しないよう「MARPとは異なりサーバーサイドAPIは不要」を明記すると良い。

### 仮説 2: FileContentの`isHtml`フラグ

**Issue内の記述**: `` `src/types/models.ts` に `isHtml?: boolean` フラグ追加 ``

**検証手順**:
1. `src/types/models.ts` の `FileContent` インターフェースを確認
2. `isImage?: boolean`, `isVideo?: boolean` が既存フィールドとして存在

**判定**: Confirmed

**根拠**: 既存の`isImage`/`isVideo`パターンに一致。`src/app/api/worktrees/[id]/files/[...path]/route.ts`でも画像・動画判定後に対応フラグをセットしている実装が確認済み。

### 仮説 3: `editable-extensions.ts`への追加

**Issue内の記述**: `` `src/config/editable-extensions.ts` に `.html`, `.htm` を追加 ``

**検証手順**:
1. `src/config/editable-extensions.ts` を確認
2. `EDITABLE_EXTENSIONS`は`readonly string[]`で`.md`のみ

**判定**: Confirmed

**根拠**: 設計上HTMLも編集可能にする実装タスクとして正当。ただし`EXTENSION_VALIDATORS`にも対応エントリを追加する必要がある。

---

## Stage 1レビューへの申し送り事項

- MARP参照実装との相違点（サーバーAPIが不要）について、Issueの説明が「同じパターン」と簡略化されており、実装者が誤解する可能性がある。
- HTMLファイルの編集機能（`editable-extensions.ts`への追加）がIssueに含まれているが、プレビュー機能とは独立した変更であり、タスクの独立性について検討が必要。
- `HtmlPreview.tsx` はMarkdownPreviewとの設計整合性（コンポーネント設計パターン）を確認すること。
