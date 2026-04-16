# Issue #652 実機受入テスト計画

## テスト概要
- Issue: #652 feat(memo): CMATE Notes の上限を 5 → 10 に引き上げ
- テスト日: 2026-04-13
- テスト環境: CommandMate サーバー (localhost:3010)

## 前提条件
- npm run build が成功すること
- サーバーが port 3010 で起動済みであること
- テスト用 worktree が登録されていること

## 受入条件との対応

| # | 受入条件 | 対応テストケース |
|---|---------|----------------|
| 1 | Notes を 10 件まで登録できる | TC-001, TC-002 |
| 2 | 11 件目の登録時にエラーメッセージが表示される | TC-003 |
| 3 | 既存の Notes 機能（作成・編集・削除）が正常動作する | TC-004, TC-005, TC-006 |
| 4 | npm run lint がパスする | TC-007 |
| 5 | npx tsc --noEmit がパスする | TC-008 |
| 6 | npm run test:unit がパスする | TC-009 |
| 7 | npm run test:integration がパスする | TC-010 |

---

## テストケース一覧

### TC-001: メモを10件まで登録できること（APIレベル）
- **テスト内容**: POST /api/worktrees/:id/memos を10回呼び出し、全て成功すること
- **前提条件**: サーバー起動済み、worktree 登録済み
- **実行手順**:
  ```bash
  # worktree IDを取得
  WORKTREE_ID=$(curl -s http://localhost:3010/api/worktrees | jq -r '.[0].id')
  # 10件登録
  for i in $(seq 1 10); do
    curl -s -X POST http://localhost:3010/api/worktrees/$WORKTREE_ID/memos \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"Memo $i\",\"content\":\"Content $i\"}" | jq '.memo.id'
  done
  ```
- **期待結果**: 10回全て HTTP 201 が返り、memo.id が返却される
- **確認観点**: 受入条件1「Notes を 10 件まで登録できる」

### TC-002: 10件登録後にリスト取得で10件表示されること
- **テスト内容**: GET /api/worktrees/:id/memos で10件取得できること
- **前提条件**: TC-001完了後（10件登録済み）
- **実行手順**:
  ```bash
  curl -s http://localhost:3010/api/worktrees/$WORKTREE_ID/memos | jq 'length'
  ```
- **期待結果**: 10 が返る
- **確認観点**: 受入条件1

### TC-003: 11件目の登録でエラーになること
- **テスト内容**: 10件登録済みの状態で11件目をPOSTすると 400 エラーが返ること
- **前提条件**: TC-001完了後（10件登録済み）
- **実行手順**:
  ```bash
  RESULT=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    http://localhost:3010/api/worktrees/$WORKTREE_ID/memos \
    -H "Content-Type: application/json" \
    -d '{"title":"Memo 11","content":"Content 11"}')
  echo "HTTP Status: $RESULT"
  curl -s -X POST http://localhost:3010/api/worktrees/$WORKTREE_ID/memos \
    -H "Content-Type: application/json" \
    -d '{"title":"Memo 11","content":"Content 11"}' | jq '.error'
  ```
- **期待結果**: HTTP 400 が返り、error メッセージに "limit" または "10" が含まれる
- **確認観点**: 受入条件2「11 件目の登録時にエラーメッセージが表示される」

### TC-004: メモの編集（PUT）が正常動作すること
- **テスト内容**: 登録済みメモのタイトル・内容を更新できること
- **前提条件**: TC-001完了（少なくとも1件登録済み）
- **実行手順**:
  ```bash
  MEMO_ID=$(curl -s http://localhost:3010/api/worktrees/$WORKTREE_ID/memos | jq -r '.[0].id')
  curl -s -X PUT http://localhost:3010/api/worktrees/$WORKTREE_ID/memos/$MEMO_ID \
    -H "Content-Type: application/json" \
    -d '{"title":"Updated Title","content":"Updated Content"}' | jq '.memo.title'
  ```
- **期待結果**: "Updated Title" が返る（HTTP 200）
- **確認観点**: 受入条件3「既存の Notes 機能（編集）が正常動作する」

### TC-005: メモの削除（DELETE）が正常動作すること
- **テスト内容**: 登録済みメモを削除できること
- **前提条件**: TC-001完了（少なくとも1件登録済み）
- **実行手順**:
  ```bash
  MEMO_ID=$(curl -s http://localhost:3010/api/worktrees/$WORKTREE_ID/memos | jq -r '.[0].id')
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
    http://localhost:3010/api/worktrees/$WORKTREE_ID/memos/$MEMO_ID)
  echo "HTTP Status: $HTTP_STATUS"
  ```
- **期待結果**: HTTP 200 が返る
- **確認観点**: 受入条件3「既存の Notes 機能（削除）が正常動作する」

### TC-006: メモ削除後に再び10件まで登録できること
- **テスト内容**: 10件満杯→1件削除→1件追加登録が成功すること（上限管理が正常）
- **前提条件**: TC-001〜TC-005完了後
- **実行手順**:
  ```bash
  # TC-003で11件目が拒否されているので、1件削除してから再登録
  MEMO_ID=$(curl -s http://localhost:3010/api/worktrees/$WORKTREE_ID/memos | jq -r '.[0].id')
  curl -s -X DELETE http://localhost:3010/api/worktrees/$WORKTREE_ID/memos/$MEMO_ID
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    http://localhost:3010/api/worktrees/$WORKTREE_ID/memos \
    -H "Content-Type: application/json" \
    -d '{"title":"Memo After Delete","content":"..."}')
  echo "HTTP Status: $HTTP_STATUS"
  ```
- **期待結果**: HTTP 201 が返る
- **確認観点**: 受入条件3「既存の Notes 機能（作成）が正常動作する」

### TC-007: npm run lint がパスすること
- **テスト内容**: ESLint が 0 エラー・0 警告で完了すること
- **前提条件**: 実装完了済み
- **実行手順**: `npm run lint`
- **期待結果**: exit code 0、エラーなし
- **確認観点**: 受入条件4

### TC-008: npx tsc --noEmit がパスすること
- **テスト内容**: TypeScript 型チェックが 0 エラーで完了すること
- **前提条件**: 実装完了済み
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: exit code 0
- **確認観点**: 受入条件4

### TC-009: npm run test:unit がパスすること
- **テスト内容**: 全ユニットテストがパスすること（MemoAddButton, MemoPane含む）
- **前提条件**: 実装完了済み
- **実行手順**: `npm run test:unit`
- **期待結果**: 全テストパス、failed 0
- **確認観点**: 受入条件4

### TC-010: npm run test:integration がパスすること（memos関連）
- **テスト内容**: memos統合テストがパスすること（10件制限テスト含む）
- **前提条件**: 実装完了済み
- **実行手順**: `npx vitest run tests/integration/api/memos.test.ts`
- **期待結果**: 全テストパス（24件）
- **確認観点**: 受入条件4

### TC-011: 定数が memo-config.ts から正しくimportされていること
- **テスト内容**: MemoPane.tsx と route.ts にローカルのMAX_MEMOS定義がないこと
- **前提条件**: 実装完了済み
- **実行手順**:
  ```bash
  # ローカル定数が残っていないか確認
  grep -n "const MAX_MEMOS" src/components/worktree/MemoPane.tsx
  grep -n "const MAX_MEMOS" src/app/api/worktrees/\[id\]/memos/route.ts
  # importが正しいか確認
  grep -n "memo-config" src/components/worktree/MemoPane.tsx
  grep -n "memo-config" src/app/api/worktrees/\[id\]/memos/route.ts
  ```
- **期待結果**: ローカル定数なし（grep結果空）、memo-configからのimportあり
- **確認観点**: DRY原則の実施確認
