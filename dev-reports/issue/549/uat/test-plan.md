# Issue #549 実機受入テスト計画

## テスト概要
- Issue: #549 スマホ版にてmarkdownファイル表示時、初期表示をビューワにしてほしい
- テスト日: 2026-03-27
- テスト方式: Playwright（ブラウザ自動テスト）+ モバイルviewport設定

## 前提条件
- CommandMateサーバーが起動していること
- Markdownファイルを含むworktreeが登録されていること
- Playwrightがインストールされていること

## テストケース一覧

### TC-001: モバイルviewportでMarkdownEditorを開く → Previewタブがデフォルト
- **テスト内容**: モバイル（375px幅）でMarkdownファイルを選択し、MarkdownEditorモーダルが開いた時にPreviewタブが選択されていること
- **前提条件**: worktreeにMarkdownファイルが存在
- **実行手順**: Playwrightでモバイルviewport設定 → worktree詳細 → ファイルツリーから.mdファイル選択 → Editorモーダル表示
- **期待結果**: MobileTabBarのPreviewタブがアクティブ状態（cyan border）で表示される
- **確認観点**: 受入条件1「Previewタブがデフォルトで選択されていること」

### TC-002: PCviewportでMarkdownEditorを開く → Editor表示が維持
- **テスト内容**: デスクトップ（1280px幅）でMarkdownファイルのMarkdownEditorを開いた時、通常のsplit/editorモードが表示されること
- **前提条件**: worktreeにMarkdownファイルが存在
- **実行手順**: Playwrightでデスクトップviewport → worktree詳細 → ファイルツリーから.mdファイル選択
- **期待結果**: split viewまたはlocalStorage保存のモードで表示される（MobileTabBarは非表示）
- **確認観点**: 受入条件3「PC版のMarkdownEditor動作に影響がないこと」

### TC-003: モバイルでEditorタブへの切替が可能
- **テスト内容**: モバイルでPreviewタブがデフォルト表示された後、Editorタブに切替できること
- **前提条件**: TC-001でPreviewタブが表示された状態
- **実行手順**: MobileTabBarのEditorタブをタップ
- **期待結果**: Editorタブに切り替わり、テキストエディタが表示される
- **確認観点**: 受入条件2「editorタブへの切替が引き続き可能であること」

### TC-004: ソースコード検証 - useEffect配置確認
- **テスト内容**: MarkdownEditor.tsxのuseEffectが正しく配置されていること
- **実行手順**: ソースコード読取で確認
- **期待結果**: mobileTab stateの後にuseEffect([isMobile])が存在、elseブランチなし

### TC-005: ソースコード検証 - initialViewMode='split'追加確認
- **テスト内容**: WorktreeDetailRefactored.tsxのモバイルModal MarkdownEditorにinitialViewMode="split"が追加されていること
- **実行手順**: ソースコード読取で確認
- **期待結果**: モバイルModal内のMarkdownEditorにinitialViewMode="split"が存在

### TC-006: ユニットテスト全パス確認
- **テスト内容**: 新規追加テストおよび既存テストが全てパスすること
- **実行手順**: npm run test:unit
- **期待結果**: 全テストパス、新規テスト4件含む

### TC-007: 静的解析パス確認
- **テスト内容**: TypeScript型チェック、ESLintが全てパスすること
- **実行手順**: npx tsc --noEmit && npm run lint
- **期待結果**: エラー0件
