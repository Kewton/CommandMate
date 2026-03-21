# Issue #526 実機受入テスト計画

## テスト概要
- Issue: #526 syncWorktreesToDB()でworktree削除時にtmuxセッションがクリーンアップされない
- テスト日: 2026-03-20
- テスト環境: CommandMate サーバー (localhost:UAT_PORT)

## 前提条件
- tmuxがインストールされていること
- テスト用のGitリポジトリが利用可能であること
- CommandMateサーバーがビルド・起動可能であること

## テストケース一覧

### TC-001: sync APIでworktree削除時にtmuxセッションがクリーンアップされる
- **テスト内容**: worktreeを物理削除した後にsync APIを呼び出し、対応するtmuxセッションが削除されることを確認
- **前提条件**: worktreeが登録済みで、対応するtmuxセッションが存在する状態
- **実行手順**:
  1. worktree一覧を取得し、テスト対象を特定
  2. テスト対象worktreeのtmuxセッションを手動で作成（セッション名はCommandMateの命名規則に従う）
  3. `git worktree remove` で物理削除
  4. `POST /api/repositories/sync` を実行
  5. `tmux list-sessions` でセッションが削除されていることを確認
- **期待結果**: 削除されたworktreeのtmuxセッションが存在しないこと
- **確認観点**: 受入条件1「sync API実行時にtmuxセッションがkillされる」

### TC-002: sync APIのレスポンスにcleanupWarningsが含まれる
- **テスト内容**: sync APIのレスポンスにcleanupWarnings フィールドが含まれることを確認
- **前提条件**: サーバーが起動している
- **実行手順**:
  1. `POST /api/repositories/sync` を実行
  2. レスポンスJSONを確認
- **期待結果**: レスポンスにsynced/deleted等の情報が含まれること
- **確認観点**: APIレスポンスの整合性

### TC-003: syncWorktreesToDB()のSyncResult戻り値確認（コードレベル）
- **テスト内容**: syncWorktreesToDB()がSyncResult（deletedIds, upsertedCount）を返すことをユニットテストで確認
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit -- --grep "syncWorktreesToDB"` を実行
- **期待結果**: 関連テストがすべてパス
- **確認観点**: 受入条件1-5のコアロジック

### TC-004: killWorktreeSession()共通化の動作確認（コードレベル）
- **テスト内容**: killWorktreeSession()の共通化テストがパスすること
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit -- --grep "killWorktreeSession"` を実行
- **期待結果**: 関連テストがすべてパス
- **確認観点**: 受入条件1-5、8の共通関数

### TC-005: syncWorktreesAndCleanup()ヘルパー関数テスト（コードレベル）
- **テスト内容**: syncWorktreesAndCleanup()のテストがパスすること
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit -- --grep "syncWorktreesAndCleanup"` を実行
- **期待結果**: 関連テストがすべてパス（削除あり/なし、cleanup失敗時）
- **確認観点**: 受入条件7「セッションkill失敗時にsync成功」

### TC-006: cleanupMultipleWorktrees()の並列化テスト（コードレベル）
- **テスト内容**: Promise.allSettled()による並列実行テストがパスすること
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit -- --grep "cleanupMultipleWorktrees"` を実行
- **期待結果**: 並列実行関連テストがすべてパス
- **確認観点**: 受入条件9「パフォーマンス対策」

### TC-007: 既存DELETE /api/repositoriesの動作確認（コードレベル）
- **テスト内容**: 既存のリポジトリ削除APIが正常動作することを確認
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit -- --grep "repository"` を実行
- **期待結果**: 既存テストがすべてパス
- **確認観点**: 受入条件8「既存機能への影響なし」

### TC-008: 全体テスト実行
- **テスト内容**: 全ユニットテストがパスすること
- **前提条件**: テストが実行可能
- **実行手順**: `npm run test:unit` を実行
- **期待結果**: 全テストパス
- **確認観点**: 全体的な品質

### TC-009: TypeScript型チェック
- **テスト内容**: 型エラーが0件であること
- **前提条件**: ソースコードがビルド可能
- **実行手順**: `npx tsc --noEmit` を実行
- **期待結果**: エラー0件
- **確認観点**: 型安全性

### TC-010: ESLintチェック
- **テスト内容**: lintエラーが0件であること
- **前提条件**: ソースコードが存在
- **実行手順**: `npm run lint` を実行
- **期待結果**: エラー0件
- **確認観点**: コード品質

### TC-011: ビルド成功確認
- **テスト内容**: Next.jsビルドが成功すること
- **前提条件**: 依存パッケージがインストール済み
- **実行手順**: `npm run build` を実行
- **期待結果**: ビルド成功
- **確認観点**: デプロイ可能性

### TC-012: scan APIでworktree削除時にクリーンアップされる（実機）
- **テスト内容**: scan API経由でもクリーンアップが動作することを確認
- **前提条件**: サーバーが起動、worktreeが登録済み
- **実行手順**: `POST /api/repositories/scan` を実行
- **期待結果**: レスポンスが正常に返り、クリーンアップが実行されること
- **確認観点**: 受入条件2「scan API」

### TC-013: server.ts excludedPaths処理の確認（コードレベル）
- **テスト内容**: server.ts のexcludedPaths処理でクリーンアップが呼ばれることを確認
- **前提条件**: コードレビューで確認
- **実行手順**: server.tsのexcludedPaths処理のコードを確認
- **期待結果**: cleanupMultipleWorktrees()がdeleteWorktreesByIds()の前に呼ばれていること
- **確認観点**: 受入条件5「server.ts excludedPaths」

### TC-014: clone-manager.tsのエラーハンドリング確認（コードレベル）
- **テスト内容**: clone-manager.tsでsyncWorktreesAndCleanup()のエラーがtry-catchで吸収されることを確認
- **前提条件**: コードレビューで確認
- **実行手順**: clone-manager.tsのonCloneSuccess()のコードを確認
- **期待結果**: try-catchでエラーが吸収され、クローン処理自体は失敗しないこと
- **確認観点**: 受入条件4「clone-manager経由」
