# Issue #552 実機受入テスト計画

## テスト概要
- Issue: #552 infoのPathをコピペするアイコンを追加してほしい
- テスト日: 2026-03-27
- テスト環境: CommandMate サーバー (localhost:{port})

## 前提条件
- CommandMateサーバーが起動していること
- 少なくとも1つのWorktreeが登録されていること
- ブラウザ（Playwright）でアクセス可能であること

## テストケース一覧

### TC-001: Pathフィールドにコピーアイコンが表示される
- **テスト内容**: InfoモーダルのPathフィールド横にClipboardCopyアイコンが表示されることを確認
- **前提条件**: Worktree詳細画面を開き、Infoモーダルを表示
- **実行手順**: Infoモーダル内のPathセクションを確認
- **期待結果**: Pathラベルの右にコピーアイコンボタンが表示される（aria-label="Copy worktree path"）
- **確認観点**: 受入条件1

### TC-002: Repository Pathフィールドにコピーアイコンが表示される
- **テスト内容**: InfoモーダルのRepositoryフィールド横にClipboardCopyアイコンが表示されることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: Infoモーダル内のRepositoryセクションを確認
- **期待結果**: Repositoryラベルの右にコピーアイコンボタンが表示される（aria-label="Copy repository path"）
- **確認観点**: 受入条件2

### TC-003: Pathコピーが動作する
- **テスト内容**: Pathコピーアイコンをクリックしてクリップボードにパスがコピーされることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: Pathのコピーアイコンをクリック
- **期待結果**: worktree.pathの値がクリップボードにコピーされる
- **確認観点**: 受入条件3

### TC-004: Repository Pathコピーが動作する
- **テスト内容**: Repository Pathコピーアイコンをクリックしてクリップボードにパスがコピーされることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: Repositoryのコピーアイコンをクリック
- **期待結果**: worktree.repositoryPathの値がクリップボードにコピーされる
- **確認観点**: 受入条件3

### TC-005: コピー後のアイコンフィードバック（Path）
- **テスト内容**: Pathコピー成功後にCheckアイコンに切り替わり、2秒後に戻ることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: Pathコピーアイコンをクリックし、アイコン変化を観察
- **期待結果**: クリック直後にCheckアイコン（緑）に変わり、約2秒後にClipboardCopyアイコンに戻る
- **確認観点**: 受入条件4

### TC-006: コピー後のアイコンフィードバック（Repository Path）
- **テスト内容**: Repository Pathコピー成功後にCheckアイコンに切り替わり、2秒後に戻ることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: Repository Pathコピーアイコンをクリックし、アイコン変化を観察
- **期待結果**: クリック直後にCheckアイコン（緑）に変わり、約2秒後にClipboardCopyアイコンに戻る
- **確認観点**: 受入条件4

### TC-007: アクセシビリティ属性の確認
- **テスト内容**: 各コピーボタンにaria-labelとtitle属性が設定されていることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: ボタン要素の属性を検査
- **期待結果**:
  - Pathボタン: aria-label="Copy worktree path", title="Copy path"
  - Repository Pathボタン: aria-label="Copy repository path", title="Copy repository path"
- **確認観点**: 受入条件7

### TC-008: 既存機能への影響確認
- **テスト内容**: Infoモーダルの既存フィールド（Worktree名、Status、Description等）が正常に表示されることを確認
- **前提条件**: Infoモーダルを表示
- **実行手順**: 全フィールドの表示を確認
- **期待結果**: 既存フィールドの表示・動作に変化がない
- **確認観点**: 既存機能への非影響
