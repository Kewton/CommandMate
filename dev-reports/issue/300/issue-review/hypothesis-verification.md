# Issue #300 仮説検証レポート

## 検証日時
- 2026-02-18

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `isPathSafe()` でルートレベルのパス処理に問題がある | Partially Confirmed | 空文字列拒否は正しいが、本質的な原因は別 |
| 2 | `createFileOrDirectory()` の existsSync が親ディレクトリに対して実行される | Rejected | existsSync は対象パスのみをチェック |
| 3 | `getWorktreeAndValidatePath()` のパス解決で意図しないパスになる | Partially Confirmed | 直接の原因ではないが、encodeURIComponent+%2F の挙動は不明確 |
| 4 | (追加) 非空状態でルートレベルの「New Directory」ボタンが存在しない | Confirmed | 空状態のみ表示、非空状態では利用不可能 |

## 詳細検証

### 仮説 1: isPathSafe() のルートレベルパス処理

**Issue内の記述**: `src/lib/path-validator.ts:29-68` の `isPathSafe()` で、ルートレベルのパス処理に問題がある可能性

**検証手順**:
1. `src/lib/path-validator.ts:29-68` の実装確認
2. 空文字列チェック (L31-33): `if (!targetPath || targetPath.trim() === '') { return false; }`
3. 正常なディレクトリ名 ('newdir') での動作確認

**判定**: Partially Confirmed

**根拠**: 
- `isPathSafe('')` は `false` を返す (正しいセキュリティ設計)
- `isPathSafe('newdir', root)` は `true` を返し、正常動作
- 空文字列の拒否はセキュリティ上正しいが、本質的な原因は「UI側でroot-level New Directoryボタンが非空状態で表示されない」こと

**Issueへの影響**: 仮説1は部分的に正確だが、根本原因ではない

---

### 仮説 2: createFileOrDirectory() の既存チェック

**Issue内の記述**: `src/lib/file-operations.ts:298-335` の `createFileOrDirectory()` で `existsSync(fullPath)` による既存チェックが、親ディレクトリのパスに対して実行されている可能性

**検証手順**:
1. `file-operations.ts:309-314` の実装確認
2. `fullPath = join(worktreeRoot, relativePath)` で対象パスを構築
3. `existsSync(fullPath)` で対象パスの存在確認

**判定**: Rejected

**根拠**: 
- `existsSync(fullPath)` は `relativePath` そのもの (`newdir`) のパスをチェック
- 親ディレクトリのパスをチェックしているわけではない
- `join(worktreeRoot, 'newdir')` → `worktreeRoot/newdir` の存在確認

**正しい事実**: 既存チェックは対象パスに対して正常に動作する。`FILE_EXISTS` エラーが発生するのは同名ディレクトリが存在する場合のみ。

---

### 仮説 3: getWorktreeAndValidatePath() のパス解決

**Issue内の記述**: `[...path]` のNext.js catchallルートとの組み合わせで意図しないパスになる可能性

**検証手順**:
1. `route.ts:96-123` の実装確認
2. `pathSegments.join('/')` でパス結合
3. `normalize(requestedPath)` でパス正規化
4. `encodeURIComponent` の影響分析

**判定**: Partially Confirmed

**根拠**:
- ルートレベル作成 (`parentPath=''`): URL `/api/.../files/newdir` → `params.path=['newdir']` → 正常
- コンテキストメニュー経由 (`parentPath='src'`): URL `/api/.../files/src%2Fnewdir` 
  - `%2F` のNext.js App Routerでの扱いが不明確
  - `params.path=['src', 'newdir']` または `['src%2Fnewdir']` となる可能性
  - 後者の場合、`createFileOrDirectory` で `join(root, 'src%2Fnewdir')` → 誤ったパス生成の可能性

**Issueへの影響**: encodeURIComponent でスラッシュをエンコードした場合の挙動が問題になり得る。

---

### 仮説 4 (追加発見): 非空状態でのUI問題

**検証手順**:
1. `FileTreeView.tsx` の "New Directory" ボタン表示ロジック確認
2. `WorktreeDetailRefactored.tsx` のツールバー確認

**判定**: Confirmed

**根拠**:
- `FileTreeView.tsx:827-861`: 空状態 (`rootItems.length === 0`) でのみ "New Directory" ボタンを表示
- 非空状態では "New Directory" は右クリックコンテキストメニューからのみアクセス可能
- コンテキストメニューの "New Directory" は `handleItemClick(onNewDirectory)` を呼び、`targetPath` (右クリックしたディレクトリのパス) を渡す
- `handleNewDirectory('src')` → `newPath = 'src/newDirName'` → ルートではなくsrc内に作成
- **根本的なUI問題**: ファイルが存在する状態でルートレベルのディレクトリを作成するUIが存在しない

---

## Stage 1レビューへの申し送り事項

1. **主要な問題**: 非空状態でのルートレベル "New Directory" UIの欠落 - ファイルツリーに既存ディレクトリがある場合、ルートディレクトリへの新規ディレクトリ作成手段がない
2. **仮説1の修正**: `isPathSafe` の空文字列チェックは正しいが、UIレイヤーでのルートレベル操作が不足している
3. **仮説2の修正**: `existsSync` は対象パスのみをチェック（正常動作）
4. **encodeURIComponentの問題**: `parentPath` を含むパス (`'src/newdir'`) を `encodeURIComponent` でエンコードすると `%2F` が含まれ、Next.jsでの処理が不明確。ルートレベル作成では `parentPath=''` なので影響なし
5. **変更対象ファイルの更新**: `src/lib/path-validator.ts` よりも `src/components/worktree/FileTreeView.tsx` (ツールバー追加) と `src/components/worktree/WorktreeDetailRefactored.tsx` (ハンドラー) の修正が主要
