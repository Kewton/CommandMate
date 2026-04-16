# Issue #652 仮説検証レポート

## 対象Issue
feat(memo): CMATE Notes の上限を 5 → 10 に引き上げ

## 仮説・前提条件の一覧

| # | 仮説/前提条件 | 判定 | 詳細 |
|---|-------------|------|------|
| 1 | `MAX_MEMOS = 5` が `src/components/worktree/MemoPane.tsx:25` に定義されている | **Confirmed** | 行25に `const MAX_MEMOS = 5;` が存在する |
| 2 | `MAX_MEMOS = 5` が `src/app/api/worktrees/[id]/memos/route.ts:15` に定義されている | **Confirmed** | 行15に `const MAX_MEMOS = 5;` が存在する |
| 3 | 既存テストが `tests/unit/lib/db-memo.test.ts` に存在する | **Rejected** | ファイルは存在しない。実際のテストは `tests/integration/api/memos.test.ts` に存在し、「5件制限」をテストしている（行234: `should return 400 when memo limit (5) exceeded`） |
| 4 | 共有定数ファイル `src/config/memo-config.ts` は存在しない（DRY違反） | **Confirmed** | `src/config/` ディレクトリに memo-config.ts は存在しない。`MAX_MEMOS` は2箇所（MemoPane.tsx、memos/route.ts）にそれぞれ独立して定義されている |
| 5 | `src/lib/db/memo-db.ts` に MAX_MEMOS 定数は定義されていない | **Confirmed** | memo-db.ts に MAX_MEMOS は存在しない（DBレイヤーは上限制御を持っていない） |

## コードベース照合結果

### 1. MemoPane.tsx
- **場所**: `src/components/worktree/MemoPane.tsx:25`
- **内容**: `const MAX_MEMOS = 5;` → 行230で `maxCount={MAX_MEMOS}` として使用

### 2. memos/route.ts
- **場所**: `src/app/api/worktrees/[id]/memos/route.ts:15`
- **内容**: `const MAX_MEMOS = 5;` → 行105, 107, 120で使用（POST時の上限チェック）

### 3. テストファイル
- **Issue記載**: `tests/unit/lib/db-memo.test.ts`（存在しない）
- **実際の場所**: `tests/integration/api/memos.test.ts`（行234）
- **影響**: IssueのTask「既存テスト更新（`tests/unit/lib/db-memo.test.ts` の制約テスト）」のファイルパスが誤り

## Stage 1への申し送り事項

- **Rejected仮説あり**: テストファイルパスが誤っている
  - Issue内の「`tests/unit/lib/db-memo.test.ts`」は存在しない
  - 正しいパスは `tests/integration/api/memos.test.ts`（integration test）
  - Issue本文の「実装タスク」セクションと「影響範囲」セクションのファイルパスを修正する必要がある
