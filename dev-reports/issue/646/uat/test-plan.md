# Issue #646 実機受入テスト計画

## テスト概要
- Issue: #646 ファイル編集強化（YAML ファイル編集・拡張子選択対応）
- テスト日: 2026-04-12
- テスト環境: CommandMate サーバー (localhost:{PORT})

## 前提条件
- `npm run build` が成功している
- CommandMate サーバーが起動している
- テスト用の worktree が登録されている

---

## テストケース一覧

### TC-001: EDITABLE_EXTENSIONS に .yaml/.yml が含まれる（単体テスト確認）
- **テスト内容**: `EDITABLE_EXTENSIONS` 配列に `.yaml` / `.yml` が含まれることを確認
- **前提条件**: ユニットテストが実行可能な状態
- **実行手順**: `npm run test:unit -- editable-extensions`
- **期待結果**: テストが全件 PASS（`toHaveLength(5)`、`.yaml`/`.yml` の `toContain` チェック含む）
- **確認観点**: AC-1 EDITABLE_EXTENSIONS に .yaml/.yml が含まれる

### TC-002: YAML ファイルの PUT API でバリデーション成功（安全なコンテンツ）
- **テスト内容**: 安全な YAML コンテンツを PUT API で保存できることを確認
- **前提条件**: サーバー起動済み、有効な worktree ID 取得済み
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  curl -s -X PUT "http://localhost:{PORT}/api/worktrees/${WTID}/files/test-uat.yaml" \
    -H "Content-Type: application/json" \
    -d '{"content":"name: test\nvalue: hello"}' \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 200, JSON レスポンスで success
- **確認観点**: AC-2 .yaml ファイルを新規作成・保存できる

### TC-003: YAML ファイルの PUT API で危険タグをブロック
- **テスト内容**: 危険な YAML タグ（`!ruby/object`）を含むコンテンツが PUT API で拒否されることを確認
- **前提条件**: TC-002 と同じ環境
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  curl -s -X PUT "http://localhost:{PORT}/api/worktrees/${WTID}/files/test-uat.yaml" \
    -H "Content-Type: application/json" \
    -d '{"content":"attack: !ruby/object:Gem::Installer {}"}' \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 400 または 422, エラーメッセージに "Dangerous YAML tags detected" が含まれる
- **確認観点**: AC-3 危険な YAML タグの保存がブロックされ、具体的なエラーメッセージが表示される

### TC-004: .yml 拡張子ファイルの PUT API で危険タグをブロック
- **テスト内容**: `.yml` 拡張子でも危険タグがブロックされることを確認
- **前提条件**: TC-002 と同じ環境
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  curl -s -X PUT "http://localhost:{PORT}/api/worktrees/${WTID}/files/test-uat.yml" \
    -H "Content-Type: application/json" \
    -d '{"content":"attack: !!python/object:__builtin__.compile {}"}' \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 400 または 422, エラーメッセージに "Dangerous YAML tags detected" が含まれる
- **確認観点**: AC-3 .yml でも同様にブロックされる

### TC-005: YAML ファイルの PUT API でサイズ超過をブロック
- **テスト内容**: 1MB 超の YAML コンテンツが拒否されることを確認
- **前提条件**: TC-002 と同じ環境
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  LARGE_CONTENT=$(python3 -c "print('key: ' + 'x' * (1024*1024+1))")
  curl -s -X PUT "http://localhost:{PORT}/api/worktrees/${WTID}/files/test-uat.yaml" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"${LARGE_CONTENT}\"}" \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 400 または 413
- **確認観点**: AC-2 バリデーション（ファイルサイズ制限）

### TC-006: .md ファイルの PUT API が正常動作（回帰確認）
- **テスト内容**: .md ファイル編集が引き続き正常動作することを確認（回帰テスト）
- **前提条件**: TC-002 と同じ環境
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  curl -s -X PUT "http://localhost:{PORT}/api/worktrees/${WTID}/files/test-uat-regression.md" \
    -H "Content-Type: application/json" \
    -d '{"content":"# Test\n\nHello World"}' \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 200, 保存成功
- **確認観点**: AC-4 既存の .md 編集機能に影響がない

### TC-007: isEditableExtension 関数の動作確認（単体テスト）
- **テスト内容**: `isEditableExtension('.yaml')` / `isEditableExtension('.yml')` が `true` を返すことを確認
- **前提条件**: ユニットテストが実行可能な状態
- **実行手順**: `npm run test:unit -- editable-extensions`
- **期待結果**: `.yaml` / `.yml` に対して `true` を返すテストが PASS
- **確認観点**: AC-1

### TC-008: validateContent の 3 分岐ロジック確認（単体テスト）
- **テスト内容**: `validateContent` が危険タグ検出時に string 型エラーメッセージを返すことを確認
- **前提条件**: ユニットテストが実行可能な状態
- **実行手順**: `npm run test:unit -- editable-extensions`
- **期待結果**: `validateContent('.yaml', '!ruby/object...')` が `{ valid: false, error: '危険な YAML ...' }` を返すテストが PASS
- **確認観点**: AC-3

### TC-009: NewFileDialog テスト（単体テスト）
- **テスト内容**: NewFileDialog の `resolveFileName` ヘルパーの 3 パターンが正しく動作することを確認
- **前提条件**: ユニットテストが実行可能な状態
- **実行手順**: `npm run test:unit -- NewFileDialog`
- **期待結果**: 20 件のテストが全て PASS
- **確認観点**: AC-5 拡張子選択 UI の動作仕様

### TC-010: TypeScript 型チェック・ESLint パス
- **テスト内容**: `npx tsc --noEmit` と `npm run lint` がエラー 0 件でパスすることを確認
- **前提条件**: なし
- **実行手順**:
  ```bash
  npx tsc --noEmit 2>&1 | wc -l
  npm run lint 2>&1 | tail -5
  ```
- **期待結果**: tsc: エラーなし、lint: エラーなし
- **確認観点**: AC-6 npm run lint / npx tsc --noEmit がパスする

### TC-011: 結合テスト（YAML ファイル操作）
- **テスト内容**: yaml-file-operations.test.ts の全テストがパスすることを確認
- **前提条件**: テスト環境が整っている
- **実行手順**: `npm run test:integration -- yaml-file-operations`
- **期待結果**: 12 件のテストが全て PASS
- **確認観点**: AC-2, AC-3

### TC-012: YAML POST API（新規作成）
- **テスト内容**: POST API で新規 YAML ファイルが作成できることを確認
- **前提条件**: サーバー起動済み
- **実行手順**:
  ```bash
  WTID=$(curl -s http://localhost:{PORT}/api/worktrees | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['worktrees'][0]['id'])" 2>/dev/null)
  curl -s -X POST "http://localhost:{PORT}/api/worktrees/${WTID}/files/new-test.yaml" \
    -H "Content-Type: application/json" \
    -d '{"type":"file","content":"version: \"3\"\nservices:\n  app:\n    image: nginx"}' \
    -w "\nHTTP_STATUS:%{http_code}"
  ```
- **期待結果**: HTTP 201, ファイル作成成功
- **確認観点**: AC-2 .yaml ファイルを新規作成できる
