# Issue #394 仮説検証レポート

## 検証日時
- 2026-03-02

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `isPathSafe()` はレキシカルパス正規化のみで`realpath()`を呼ばない | Confirmed | `path.resolve()`使用、`fs.realpathSync()`不使用を確認（path-validator.ts:54-56） |
| 2 | `moveFileOrDirectory()`はシンボリックリンク検証済み（`realpathSync()`あり） | Confirmed | file-operations.ts:546-553でrealpathSync()呼び出しを確認 |
| 3 | 他のファイル操作（read/write/create/delete/upload）には等価のrealpath検証がない | Confirmed | 各関数はisPathSafe()のみ使用、realpathSync()呼び出しなし |
| 4 | シンボリックリンクによるパストラバーサルバイパスが実現可能 | Confirmed | isPathSafe()はpath.resolve()（レキシカル）を使用するため、FS操作はシンボリックリンクを追跡 |
| 5 | 影響エンドポイントの特定（GET/PUT/POST/DELETE/PATCH/POST-upload） | Confirmed | 各APIルートのコードでisPathSafe()依存を確認 |

## 詳細検証

### 仮説 1: `isPathSafe()` はレキシカル正規化のみを実施

**Issue内の記述**:
> `isPathSafe()`: decodes URL encoding, resolves a lexical path under `rootDir`, checks with `path.relative()`. This only validates the path string and normalized path layout. It does not call `realpath()` on the target path or its parent directory.

**検証手順**:
1. `src/lib/path-validator.ts` を確認
2. `isPathSafe()` 関数の実装（行29-68）を詳細確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/path-validator.ts:54-56
const resolvedRoot = path.resolve(rootDir);
const resolvedTarget = path.resolve(rootDir, decodedPath);
```
- `path.resolve()` は純粋にレキシカル（文字列）処理でシンボリックリンクを解決しない
- `fs.realpathSync()` や `fs.realpath()` の呼び出しは一切存在しない
- `path.relative()` による比較もレキシカルのみ

**Issueへの影響**: 記述は正確。修正不要。

---

### 仮説 2: `moveFileOrDirectory()` にはシンボリックリンク検証が存在する

**Issue内の記述**:
> `moveFileOrDirectory()` includes a symlink-aware `realpathSync()` check for the destination directory. That indicates the codebase already recognizes symlink escape risks in at least one path-sensitive operation.

**検証手順**:
1. `src/lib/file-operations.ts` の `moveFileOrDirectory()` 関数（行501-606）を確認
2. SEC-006コメント付きのシンボリックリンク検証ロジックを確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/file-operations.ts:544-553
// 6. [SEC-006] Symlink validation for destination directory
try {
  const resolvedDest = realpathSync(destFullPath);
  const resolvedRoot = realpathSync(worktreeRoot);
  if (!resolvedDest.startsWith(resolvedRoot + sep) && resolvedDest !== resolvedRoot) {
    return createErrorResult('INVALID_PATH');
  }
} catch {
  return createErrorResult('INVALID_PATH');
}
```
- さらに行565: `resolvedSourceReal = realpathSync(resolvedSource)` でソースも検証
- `moveFileOrDirectory()` は `realpathSync` を3回呼び出している

**Issueへの影響**: 記述は正確。修正不要。

---

### 仮説 3: 他のファイル操作にはrealpath検証がない

**Issue内の記述**:
> However, the more general file APIs do not apply equivalent realpath validation.

**検証手順**:
1. `readFileContent()` (行225-251) を確認
2. `updateFileContent()` (行261-287) を確認
3. `createFileOrDirectory()` (行298-335) を確認
4. `deleteFileOrDirectory()` (行375-436) を確認
5. `writeBinaryFile()` (行674-709) を確認
6. `renameFileOrDirectory()` (行618-662) を確認

**判定**: Confirmed

**根拠**: 全関数で同一パターン:
```typescript
if (!isPathSafe(relativePath, worktreeRoot)) {
  return createErrorResult('INVALID_PATH');
}
const fullPath = join(worktreeRoot, relativePath);
// ← realpathSync() 呼び出しなし
```
各関数は `isPathSafe()` のみで検証し、`realpathSync()` を呼び出していない。

**Issueへの影響**: 記述は正確。修正不要。

---

### 仮説 4: シンボリックリンクバイパスが実現可能

**Issue内の記述**:
> A symlink placed inside a worktree can point outside the worktree root, and the API will still treat access as safe because the relative path string remains inside the worktree.

**検証手順**:
1. `isPathSafe()` の動作を追跡
2. シンボリックリンクのシナリオを想定検証

**判定**: Confirmed

**根拠**:
- `path.resolve('/worktree', 'external/passwd')` → `/worktree/external/passwd`（レキシカル）
- この結果は `/worktree` 配下に見えるため `path.relative()` チェックを通過
- しかし `external` がシンボリックリンク（例: `/etc`を指す）の場合、`readFile('/worktree/external/passwd')` は実際には `/etc/passwd` を読む
- APIルートの `getWorktreeAndValidatePath()` も同様に `isPathSafe()` のみを使用（route.ts:116, upload/route.ts:117）

**Issueへの影響**: 記述は正確。修正不要。

---

### 仮説 5: 影響エンドポイントの特定

**Issue内の記述**: 6エンドポイントが影響を受ける

**判定**: Confirmed

**根拠**:
- `GET /api/worktrees/:id/files/:path` → `readFileContent()` または `readFile()` 直接（行153, 200, 250）
- `PUT /api/worktrees/:id/files/:path` → `updateFileContent()` （行307）
- `POST /api/worktrees/:id/files/:path` → `createFileOrDirectory()` （行360）
- `DELETE /api/worktrees/:id/files/:path` → `deleteFileOrDirectory()` （行399）
- `PATCH /api/worktrees/:id/files/:path` → `renameFileOrDirectory()` / `moveFileOrDirectory()` （行440, 461）
  - 注: `moveFileOrDirectory()` はrealpath検証あり（SEC-006）、ただしsource pathは保護されていない
- `POST /api/worktrees/:id/upload/:path` → `writeBinaryFile()` （行189）

**追加発見**: `GET` エンドポイントでは画像・動画ファイルに対して `readFile()` を直接呼び出す箇所があり（行153, 157, 200, 211）、これも同様の脆弱性を持つ。Issueには明示されていない。

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedであり、Issueの記述は正確
- **追加発見**: GETエンドポイントで画像・動画ファイル処理時に `readFile()` を直接呼び出す箇所（route.ts行153, 200）がIssueの影響コードリストに含まれていない可能性がある
- `renameFileOrDirectory()` の影響についても確認が必要（ソースパスのシンボリックリンクに対するrealpath検証なし）
- **修正範囲の明確化**: `path-validator.ts` の `isPathSafe()` を修正するか、各ファイル操作関数に個別にrealpath検証を追加するかの方針を明確化すべき
