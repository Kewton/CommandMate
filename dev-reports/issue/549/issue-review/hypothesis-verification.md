# Issue #549 仮説検証レポート

## 検証日時
- 2026-03-27

## 検証結果サマリー

仮説なし - スキップ（機能追加Issue）

## 補足: コードベース調査結果

Issue内容「スマホ版にてmarkdownファイル表示時、初期表示をビューワにしてほしい」に関する現状コード調査。

### 現状の動作

1. **MarkdownEditor** (`src/components/worktree/MarkdownEditor.tsx`)
   - 3つのビューモード: `split`, `editor`, `preview`
   - `initialViewMode` propまたはlocalStorageから復元
   - モバイルポートレート時、splitモードはタブ切替UI（MobileTabBar）に変換

2. **FilePanelContent** (`src/components/worktree/FilePanelContent.tsx`)
   - MARPファイル: `initialViewMode="split"`
   - 通常MD（検索付き）: `initialViewMode="preview"`

3. **モバイル検出**
   - `useIsMobile` hook: viewport width < 768px
   - ポートレート検出: `isMobile && window.innerHeight > window.innerWidth`

### 現状の課題

- `initialViewMode="preview"` が渡されているが、localStorageに保存済みの値があればそちらが優先される
- モバイルユーザーが一度editorモードを使うと、以降常にeditorが初期表示になる可能性がある
- モバイルでは編集よりビューワ利用がメインであるため、常にpreviewを初期表示にすべき

## Stage 1レビューへの申し送り事項

- MarkdownEditorのinitialViewMode決定ロジックとlocalStorage優先の挙動を確認
- モバイル時のデフォルト表示モード指定方法の検討が必要
