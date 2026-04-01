# Issue #600 実機受入テスト計画

## テスト概要
- Issue: #600 ホーム中心のUX刷新とWorktree Detail中心導線の再設計
- テスト日: 2026-04-01
- テスト環境: CommandMate サーバー (localhost:自動検出ポート)

## 前提条件
- CommandMateサーバーがビルド・起動可能であること
- リポジトリが1つ以上登録されていること
- worktreeが1つ以上存在すること

## テストケース一覧

### TC-001: Home画面の表示
- **テスト内容**: Home画面（/）にセッション集計サマリーとショートカットカードが表示されること
- **実行手順**: `curl -s http://localhost:{port}/` でHTMLを取得し、HomeSessionSummaryとショートカットカードの存在を確認
- **期待結果**: Running/Waitingカウント表示、Sessions/Repositories/Review/Moreへのリンクが存在する
- **確認観点**: AC-001（6画面の責務分離）、AC-002（1クリック導線）

### TC-002: Sessions画面の表示
- **テスト内容**: /sessions でWorktree一覧が表示されること
- **実行手順**: `curl -s http://localhost:{port}/sessions` でHTMLを取得
- **期待結果**: 200応答、Sessionsページのコンテンツが返る
- **確認観点**: AC-001

### TC-003: Repositories画面の表示
- **テスト内容**: /repositories でリポジトリ管理画面が表示されること
- **実行手順**: `curl -s http://localhost:{port}/repositories` でHTMLを取得
- **期待結果**: 200応答、Repositoriesページのコンテンツが返る
- **確認観点**: AC-001

### TC-004: Review画面の表示
- **テスト内容**: /review でReview画面が表示され、Done/Approval/Stalledタブが存在すること
- **実行手順**: `curl -s http://localhost:{port}/review` でHTMLを取得
- **期待結果**: 200応答、Reviewページのコンテンツが返る
- **確認観点**: AC-001、AC-006

### TC-005: More画面の表示
- **テスト内容**: /more でMore画面が表示されること
- **実行手順**: `curl -s http://localhost:{port}/more` でHTMLを取得
- **期待結果**: 200応答、Moreページのコンテンツが返る
- **確認観点**: AC-001

### TC-006: Worktree Detail画面の既存機能維持
- **テスト内容**: /worktrees/:id が引き続き利用でき、既存機能が維持されていること
- **実行手順**: worktree IDを取得し、`curl -s http://localhost:{port}/worktrees/{id}` でアクセス
- **期待結果**: 200応答、Worktree詳細ページのコンテンツが返る
- **確認観点**: AC-003

### TC-007: worktrees API 基本応答（後方互換性）
- **テスト内容**: GET /api/worktrees が既存形式で応答すること
- **実行手順**: `curl -s http://localhost:{port}/api/worktrees | jq .`
- **期待結果**: `{ worktrees: [...], repositories: [...] }` 形式、既存フィールドが変更なし
- **確認観点**: AC-011（後方互換性）

### TC-008: worktrees API ?include=review 応答
- **テスト内容**: ?include=review で追加フィールドが返ること
- **実行手順**: `curl -s "http://localhost:{port}/api/worktrees?include=review" | jq '.worktrees[0] | {reviewStatus, isStalled, nextAction}'`
- **期待結果**: reviewStatus, isStalled, nextAction フィールドが含まれる
- **確認観点**: AC-006、AC-007、AC-011

### TC-009: worktrees API ?include=invalid（不正パラメータ）
- **テスト内容**: 不正なinclude値がサイレントに無視されること
- **実行手順**: `curl -s "http://localhost:{port}/api/worktrees?include=invalid" | jq '.worktrees[0] | has("reviewStatus")'`
- **期待結果**: reviewStatusフィールドが含まれない（falseを返す）
- **確認観点**: AC-011（セキュリティ）

### TC-010: 新規URL認証保護（/sessions）
- **テスト内容**: 認証なしで/sessionsにアクセスした場合にリダイレクトされること
- **実行手順**: 認証トークンなしで `curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}/sessions`
- **期待結果**: 認証設定が有効な場合は307（/loginへリダイレクト）、無効な場合は200
- **確認観点**: AC-009

### TC-011: 新規URL認証保護（/repositories）
- **テスト内容**: 認証なしで/repositoriesにアクセスした場合の挙動確認
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}/repositories`
- **期待結果**: TC-010と同じ挙動
- **確認観点**: AC-009

### TC-012: 新規URL認証保護（/review）
- **テスト内容**: 認証なしで/reviewにアクセスした場合の挙動確認
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}/review`
- **期待結果**: TC-010と同じ挙動
- **確認観点**: AC-009

### TC-013: 新規URL認証保護（/more）
- **テスト内容**: 認証なしで/moreにアクセスした場合の挙動確認
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:{port}/more`
- **期待結果**: TC-010と同じ挙動
- **確認観点**: AC-009

### TC-014: deep link pane=terminal
- **テスト内容**: /worktrees/:id?pane=terminal でページが正常に表示されること
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:{port}/worktrees/{id}?pane=terminal"`
- **期待結果**: 200応答
- **確認観点**: AC-008

### TC-015: deep link pane=history
- **テスト内容**: /worktrees/:id?pane=history でページが正常に表示されること
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:{port}/worktrees/{id}?pane=history"`
- **期待結果**: 200応答
- **確認観点**: AC-008

### TC-016: deep link 不正pane値フォールバック
- **テスト内容**: /worktrees/:id?pane=invalid でページが正常に表示されること（terminalにフォールバック）
- **実行手順**: `curl -s -o /dev/null -w "%{http_code}" "http://localhost:{port}/worktrees/{id}?pane=invalid"`
- **期待結果**: 200応答（エラーにならない）
- **確認観点**: AC-008

### TC-017: ユニットテスト全パス
- **テスト内容**: npm run test:unit で全テストが通過すること
- **実行手順**: `npm run test:unit`
- **期待結果**: 全テストパス、失敗0件
- **確認観点**: AC-010

### TC-018: TypeScript型チェック
- **テスト内容**: npx tsc --noEmit でエラーがないこと
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: エラー0件
- **確認観点**: AC-010

### TC-019: ESLint
- **テスト内容**: npm run lint でエラーがないこと
- **実行手順**: `npm run lint`
- **期待結果**: エラー0件
- **確認観点**: AC-010

### TC-020: docs/architecture.md URL設計セクション
- **テスト内容**: docs/architecture.md にURL設計セクションが追記されていること
- **実行手順**: `grep -c "URL設計\|DeepLinkPane\|ナビゲーション" docs/architecture.md`
- **期待結果**: 複数ヒット
- **確認観点**: AC-005

### TC-021: DBスキーマ変更なし
- **テスト内容**: DBマイグレーションファイルが追加されていないこと
- **実行手順**: `git diff main --name-only | grep -i migration` で確認
- **期待結果**: マイグレーションファイルの追加なし
- **確認観点**: AC-012

### TC-022: ビルド成功
- **テスト内容**: npm run build が成功すること
- **実行手順**: ビルド結果を確認（テスト環境セットアップ時に実行済み）
- **期待結果**: ビルド成功
- **確認観点**: AC-010
