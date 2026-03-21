# Issue #168 実機受入テスト計画

## テスト概要
- Issue: #168 セッションをクリアしても履歴はクリアして欲しく無い
- テスト日: 2026-03-20
- テスト環境: CommandMate サーバー (localhost:UAT_PORT)

## 前提条件
- CommandMateサーバーが起動していること
- テスト用リポジトリ（本プロジェクト自体）がスキャン登録されていること
- worktreeが1つ以上存在すること

## テストケース一覧

### TC-001: メッセージ送信と表示（正常系基本動作）
- **テスト内容**: messages APIでメッセージが正常に取得できること
- **前提条件**: worktreeが登録済み
- **実行手順**: `GET /api/worktrees/{id}/messages`
- **期待結果**: 200レスポンス、メッセージ配列にarchivedフィールドが含まれる
- **確認観点**: 既存メッセージが正常に表示される（マイグレーション互換性）

### TC-002: kill-session後のメッセージ論理削除（cliTool指定あり）
- **テスト内容**: kill-session APIでメッセージが論理削除（archived=1）されること
- **前提条件**: worktreeにメッセージが存在する
- **実行手順**:
  1. `POST /api/worktrees/{id}/terminal` でメッセージ送信
  2. `GET /api/worktrees/{id}/messages` でメッセージ存在確認
  3. `POST /api/worktrees/{id}/kill-session?cliTool=claude`
  4. `GET /api/worktrees/{id}/messages` でメッセージが見えなくなったことを確認
  5. `GET /api/worktrees/{id}/messages?includeArchived=true` でアーカイブメッセージが取得できることを確認
- **期待結果**: kill-session後、通常取得ではメッセージ非表示、includeArchived=trueで取得可能
- **確認観点**: セッションクリア後も過去のメッセージ履歴が閲覧可能

### TC-003: kill-session後のメッセージ論理削除（cliTool未指定）
- **テスト内容**: cliTool未指定でkill-sessionした場合も論理削除されること
- **前提条件**: worktreeにメッセージが存在する
- **実行手順**:
  1. `POST /api/worktrees/{id}/kill-session`（cliTool未指定）
  2. `GET /api/worktrees/{id}/messages?includeArchived=true` でアーカイブ確認
- **期待結果**: 全メッセージがarchived=1になり、includeArchived=trueで取得可能
- **確認観点**: cliTool未指定でのセッション終了時もメッセージが論理削除される

### TC-004: includeArchivedパラメータのデフォルト動作
- **テスト内容**: includeArchived未指定時はアーカイブメッセージが除外されること
- **前提条件**: アーカイブ済みメッセージが存在する
- **実行手順**: `GET /api/worktrees/{id}/messages`（includeArchivedなし）
- **期待結果**: archived=1のメッセージが含まれない
- **確認観点**: 新セッション開始時は過去メッセージが非表示（デフォルト）

### TC-005: includeArchived=trueでアーカイブメッセージ取得
- **テスト内容**: includeArchived=true指定時にアーカイブメッセージも含めて取得できること
- **前提条件**: アーカイブ済みメッセージが存在する
- **実行手順**: `GET /api/worktrees/{id}/messages?includeArchived=true`
- **期待結果**: archived=0とarchived=1の両方のメッセージが返される
- **確認観点**: 過去履歴の表示/非表示を切り替えられる

### TC-006: includeArchivedの非正規値テスト
- **テスト内容**: includeArchived=TRUE, 1, yesなどが'false'として扱われること
- **前提条件**: アーカイブ済みメッセージが存在する
- **実行手順**:
  1. `GET /api/worktrees/{id}/messages?includeArchived=TRUE`
  2. `GET /api/worktrees/{id}/messages?includeArchived=1`
  3. `GET /api/worktrees/{id}/messages?includeArchived=yes`
- **期待結果**: いずれもアーカイブメッセージを含まない（strict 'true' のみ有効）
- **確認観点**: セキュリティ（SEC4-001）

### TC-007: kill-session後のlast_user_messageクリア
- **テスト内容**: kill-session後にworktreeのlast_user_messageがクリアされること
- **前提条件**: worktreeにメッセージが送信済み
- **実行手順**:
  1. `GET /api/worktrees/{id}` でlast_user_message確認
  2. `POST /api/worktrees/{id}/kill-session`
  3. `GET /api/worktrees/{id}` でlast_user_messageがnull/空になっていることを確認
- **期待結果**: kill-session後、last_user_messageがクリアされる
- **確認観点**: kill-session後、サイドバーのlast_user_messageがクリアされる

### TC-008: DBマイグレーションの正常動作
- **テスト内容**: サーバー起動時にDBマイグレーション（v22）が正常に適用されること
- **前提条件**: サーバーが起動可能
- **実行手順**: サーバー起動ログまたはDB直接確認
- **期待結果**: chat_messagesテーブルにarchivedカラムが存在し、インデックスが作成されている
- **確認観点**: 既存メッセージが正常に表示される（マイグレーション互換性）

### TC-009: 既存機能への非影響（worktree一覧）
- **テスト内容**: worktree一覧APIが正常に動作すること
- **前提条件**: worktreeが登録済み
- **実行手順**: `GET /api/worktrees`
- **期待結果**: 200レスポンス、worktree一覧が返される
- **確認観点**: 既存のセッション管理機能に影響がない

### TC-010: TypeScript・Lint・テストの全パス
- **テスト内容**: 静的解析とユニットテストが全パスすること
- **前提条件**: ビルド環境が整っていること
- **実行手順**:
  1. `npx tsc --noEmit`
  2. `npm run lint`
  3. `npm run test:unit`
- **期待結果**: すべてエラー0件
- **確認観点**: 既存テストがarchived方式に対応して全パス
