# Issue #644 実機受入テスト計画

## テスト概要

- **Issue**: #644 feat(repositories): リポジトリ一覧表示と別名編集UI
- **テスト日**: 2026-04-12
- **テスト環境**: CommandMate サーバー (localhost:UAT_PORT)

## 前提条件

- テスト用リポジトリが存在していること
- サーバーが指定ポートで起動していること

## テストケース一覧

### Backend API テスト

#### TC-001: GET /api/repositories - 成功レスポンス

- **テスト内容**: GETリクエストでリポジトリ一覧が取得できること
- **前提条件**: リポジトリが1件以上登録済み
- **実行手順**: 
  ```bash
  curl -s http://localhost:{UAT_PORT}/api/repositories
  ```
- **期待結果**:
  - HTTPステータス 200
  - `{ "success": true, "repositories": [...] }` 形式
  - 各要素に `id, name, displayName, path, enabled, worktreeCount` フィールドあり
- **確認観点**: 受入条件「/repositories 画面で登録済みリポジトリの一覧が表示される」「各行でリポジトリ名・別名・パス・worktree数・enabled状態が確認できる」

#### TC-002: GET /api/repositories - worktreeCount 集計が repository_path ベース

- **テスト内容**: `worktreeCount` が `repository_path` ベースで正しく集計されていること
- **実行手順**: `curl -s http://localhost:{UAT_PORT}/api/repositories | jq '.repositories[0].worktreeCount'`
- **期待結果**: 数値が返り、エラーにならない（`repository_id` カラムは存在しないため、その場合クエリ失敗する）
- **確認観点**: 受入条件「worktreeCount 集計クエリが repository_path ベースで動作すること」（S3-001 回帰防止）

#### TC-003: PUT /api/repositories/[id] - displayName 更新成功

- **テスト内容**: 別名がDBに永続化されること
- **前提条件**: TC-001 でリポジトリIDを取得
- **実行手順**: 
  ```bash
  curl -s -X PUT http://localhost:{UAT_PORT}/api/repositories/{id} \
    -H "Content-Type: application/json" \
    -d '{"displayName":"My Test Alias"}'
  ```
- **期待結果**: 
  - HTTPステータス 200
  - `{ "success": true, "repository": { ..., "displayName": "My Test Alias" } }` 形式
  - worktreeCount は返されない
- **確認観点**: 受入条件「各行で別名をインライン編集し、保存すると DBに永続化される」「別名がリロード後に反映される」

#### TC-004: PUT /api/repositories/[id] - 100文字超で400エラー

- **テスト内容**: バリデーションが機能すること
- **実行手順**: 
  ```bash
  curl -sw "\n%{http_code}" -X PUT http://localhost:{UAT_PORT}/api/repositories/{id} \
    -H "Content-Type: application/json" \
    -d '{"displayName":"'$(printf 'a%.0s' {1..101})'"}'
  ```
- **期待結果**:
  - HTTPステータス 400
  - エラーメッセージ: `displayName must be 100 characters or less`
- **確認観点**: 受入条件「100文字超入力時にバリデーションエラー」「エラーメッセージ文言が従来通り」（S3-003 回帰防止）

#### TC-005: PUT /api/repositories/[id] - 空文字でdisplayNameクリア

- **テスト内容**: 空文字送信で別名がクリアされること
- **実行手順**: 
  ```bash
  curl -s -X PUT http://localhost:{UAT_PORT}/api/repositories/{id} \
    -H "Content-Type: application/json" \
    -d '{"displayName":""}'
  ```
- **期待結果**: 
  - HTTPステータス 200
  - `displayName: null` が返る
- **確認観点**: 受入条件「空文字 / null 保存で別名がクリアされる」

#### TC-006: PUT /api/repositories/[id] - 存在しないIDで404

- **テスト内容**: 404が正しく返ること
- **実行手順**: 
  ```bash
  curl -sw "\n%{http_code}" -X PUT http://localhost:{UAT_PORT}/api/repositories/nonexistent-id \
    -H "Content-Type: application/json" \
    -d '{"displayName":"foo"}'
  ```
- **期待結果**: HTTPステータス 404
- **確認観点**: 異常系テスト

#### TC-007: GET /api/repositories - Sessions画面APIと比較

- **テスト内容**: GET /api/repositories（新規）と GET /api/worktrees（既存）が両立して動作すること
- **実行手順**: 
  ```bash
  curl -s http://localhost:{UAT_PORT}/api/repositories | jq '.repositories | length'
  curl -s http://localhost:{UAT_PORT}/api/worktrees | jq '.repositories | length'
  ```
- **期待結果**: どちらもエラーなくレスポンスを返し、件数を取得できる
- **確認観点**: 既存 API との棲み分け（S3-002）・後方互換

### UI / 統合テスト

#### TC-008: /repositories ページ - HTTP 200 応答

- **テスト内容**: ページがエラーなくレンダリングできること
- **実行手順**: 
  ```bash
  curl -s -o /dev/null -w "%{http_code}" http://localhost:{UAT_PORT}/repositories
  ```
- **期待結果**: HTTPステータス 200
- **確認観点**: ページレンダリング

#### TC-009: /repositories ページ - RepositoryList コンポーネント存在確認

- **テスト内容**: HTML出力に RepositoryList の要素が含まれること
- **実行手順**: 
  ```bash
  curl -s http://localhost:{UAT_PORT}/repositories | grep -c "repository-row\|Repositories"
  ```
- **期待結果**: 1件以上マッチ（ページ要素が存在）
- **確認観点**: 受入条件「/repositories 画面で登録済みリポジトリの一覧が表示される」

### ファイル存在確認テスト

#### TC-010: 必須ファイル存在確認

- **テスト内容**: Issue #644 で追加・変更したファイルがすべて存在すること
- **実行手順**: 
  ```bash
  test -f src/config/repository-config.ts && \
  test -f src/components/repository/RepositoryList.tsx && \
  test -f tests/integration/api-repositories-list.test.ts && \
  test -f tests/integration/api-repositories-put.test.ts && \
  test -f tests/unit/components/repository/RepositoryList.test.tsx && \
  echo "OK"
  ```
- **期待結果**: `OK` が出力される
- **確認観点**: 実装ファイルの存在

#### TC-011: 既存 getAllRepositories シグネチャ不変

- **テスト内容**: 既存関数のシグネチャが変更されていないこと
- **実行手順**: 
  ```bash
  grep -A 3 "export function getAllRepositories" src/lib/db/db-repository.ts | head -5
  ```
- **期待結果**: 既存と同じシグネチャ `(db: Database.Database): Repository[]`
- **確認観点**: 受入条件「既存 getAllRepositories(db) のシグネチャが変更されていないこと」

### 品質チェックテスト

#### TC-012: TypeScript エラー確認

- **テスト内容**: 型エラーが0件であること
- **実行手順**: `npx tsc --noEmit 2>&1 | wc -l`
- **期待結果**: 0
- **確認観点**: 受入条件「npx tsc --noEmit がパスする」

#### TC-013: ESLint エラー確認

- **テスト内容**: Lintエラーが0件であること
- **実行手順**: `npm run lint 2>&1 | grep -c "error\|warning"`
- **期待結果**: 0（または最低限）
- **確認観点**: 受入条件「npm run lint がパスする」

#### TC-014: Integration テスト実行

- **テスト内容**: 新規追加したintegration testが全パス
- **実行手順**: `npm run test:integration -- tests/integration/api-repositories-list.test.ts tests/integration/api-repositories-put.test.ts`
- **期待結果**: 全テストパス
- **確認観点**: 受入条件「新規テスト3ファイル」

#### TC-015: Unit テスト実行（RepositoryList）

- **テスト内容**: RepositoryList component test が全パス
- **実行手順**: `npm run test:unit -- tests/unit/components/repository/RepositoryList.test.tsx`
- **期待結果**: 全テストパス
- **確認観点**: 受入条件「RepositoryList.test.tsx が追加されている」

## 受入条件カバレッジ

| # | 受入条件 | 対応TC |
|---|---------|--------|
| 1 | /repositories 画面でリポジトリ一覧が表示される | TC-001, TC-008, TC-009 |
| 2 | 各行でリポジトリ名・別名・パス・worktree数・enabled状態 | TC-001 |
| 3 | enabled=false が無効バッジで表示される | TC-015 (unit test) |
| 4 | 別名をインライン編集して保存 | TC-003, TC-015 |
| 5 | 保存した別名がリロード後反映 | TC-003 |
| 6 | 空文字/null で別名クリア | TC-005 |
| 7 | 100文字超でバリデーションエラー | TC-004, TC-015 |
| 8 | MAX_DISPLAY_NAME_LENGTH 共有定数化 | TC-004, TC-010 |
| 9 | worktreeCount が repository_path ベース | TC-002 |
| 10 | getAllRepositories シグネチャ不変 | TC-011 |
| 11 | refreshKey 連携 | TC-015 (unit test) |
| 12 | 認証ミドルウェア通過 | TC-001, TC-008 |
| 13 | 保存成功/失敗フィードバック | TC-015 (unit test) |
| 14 | ダークモード対応 | 実装確認のみ |
| 15 | lint/typecheck/tests パス | TC-012, TC-013, TC-014, TC-015 |
| 16 | 新規テスト3ファイル追加 | TC-010, TC-014, TC-015 |
