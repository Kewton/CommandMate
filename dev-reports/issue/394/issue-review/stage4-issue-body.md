> **Note**: This Issue was updated on 2026-03-02 to reflect Stage 1 and Stage 3 (impact analysis) review findings.
> Details: dev-reports/issue/394/issue-review/

## Summary

The file read/write/delete/upload APIs validate paths using lexical path normalization only. They do not resolve symlinks before performing filesystem operations.

This means a symlink placed inside a worktree can point outside the worktree root, and the API will still treat access as safe because the relative path string remains inside the worktree. The underlying filesystem calls then follow the symlink and operate on files outside the intended trust boundary.

This creates a path traversal bypass via symlink traversal.

## Severity

High

## Affected Endpoints

- `GET /api/worktrees/:id/files/:path`
- `PUT /api/worktrees/:id/files/:path`
- `POST /api/worktrees/:id/files/:path`
- `DELETE /api/worktrees/:id/files/:path`
- `PATCH /api/worktrees/:id/files/:path`
- `POST /api/worktrees/:id/upload/:path`
- `GET /api/worktrees/:id/tree/:path` -- directory listing via `readDirectory()`; after `isPathSafe()` validation, `readDirectory()` follows symlink directories and lists external contents. `lstat()` skips symlink child entries but does not prevent entering a symlink target directory itself. (F3-001)
- `GET /api/worktrees/:id/search` -- file search via `searchWithTimeout()`; depends on `isPathSafe()` in `file-search.ts`. Partial defense via `lstat()` symlink skip in `searchDirectory()`, but symlink directories passed as search root are not blocked. (F3-001)

### Indirect Impact (F3-006)

The following endpoint uses `isPathSafe()` but is not directly vulnerable to file content access:

- `POST /api/repositories/scan` -- calls `isPathSafe(repositoryPath, CM_ROOT_DIR)`. Does not perform file read/write, but `isPathSafe()` modifications will affect its validation behavior. If the implementation strategy preserves the existing `isPathSafe()` signature (see Recommended Direction), this endpoint is unaffected.

## Root Cause

1. `isPathSafe()`:
   - decodes URL encoding
   - resolves a lexical path under `rootDir`
   - checks with `path.relative()`
2. This only validates the path string and normalized path layout.
3. It does not call `realpath()` on the target path or its parent directory.
4. Subsequent filesystem operations (`readFile`, `writeFile`, `rm`, etc.) follow symlinks.

As a result, a relative path like `safe-link/secret.txt` passes validation if `safe-link` is inside the worktree, even when `safe-link` is a symlink to `/etc`, `/Users/...`, or another external location.

## Impact

- Read arbitrary files outside the worktree
- Overwrite arbitrary files outside the worktree
- Delete files/directories outside the worktree (subject to process permissions)
- Upload files into arbitrary directories reachable through symlinked parents
- List directory contents outside the worktree via tree API (F3-001)
- Search file contents outside the worktree via search API (F3-001)

This breaks the core assumption that file APIs are confined to the selected worktree.

## Example Exploit

Assume the worktree contains:

```bash
ln -s /etc external
```

Then a request to:

```http
GET /api/worktrees/:id/files/external/passwd
```

passes the current `isPathSafe()` check because `external/passwd` is lexically inside the worktree.

But the actual read resolves to:

```text
/etc/passwd
```

The same pattern applies to writes and uploads:
- `PUT /api/worktrees/:id/files/external/some.conf`
- `POST /api/worktrees/:id/upload/external`

And also to directory listing and search:
- `GET /api/worktrees/:id/tree/external` -- lists contents of `/etc`
- `GET /api/worktrees/:id/search?query=root` -- searches within symlink-targeted directories

## Affected Code

### Core validator
- `src/lib/path-validator.ts`

### File operations
- `src/lib/file-operations.ts`
  - `readFileContent()` (line 225)
  - `updateFileContent()` (line 261)
  - `createFileOrDirectory()` (line 298)
  - `deleteFileOrDirectory()` (line 375)
  - `writeBinaryFile()` (line 674)
  - `renameFileOrDirectory()` (lines 618-662) -- source path has no `realpathSync()` validation; a symlink source will be followed by `fs.rename()` without boundary check

### API routes
- `src/app/api/worktrees/[id]/files/[...path]/route.ts`
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts`
- `src/app/api/worktrees/[id]/tree/[...path]/route.ts` -- `readDirectory()` after `isPathSafe()` (F3-001)
- `src/app/api/worktrees/[id]/search/route.ts` -- `searchWithTimeout()` depends on `isPathSafe()` (F3-001)

### Directory listing and search modules
- `src/lib/file-tree.ts` -- `readDirectory()` targetPath calculation; `lstat()` skips symlink child entries but does not validate that the target directory itself is not a symlink escaping the worktree root (F3-001)
- `src/lib/file-search.ts` -- `searchDirectory()` uses `isPathSafe()` (lines 265, 298) and `lstat()` symlink skip; if `isPathSafe()` is modified, every entry in the search traversal will incur a `realpath()` call (F3-005, F3-007)

### Indirect impact via `validateWorktreePath()` (F3-010)
- `src/lib/clone-manager.ts` -- `resolveCustomTargetPath()` calls `validateWorktreePath()` which internally uses `isPathSafe()`
- `src/lib/cli-tools/opencode-config.ts` -- uses `validateWorktreePath()` directly (also has its own realpath validation)

These are automatically affected if `isPathSafe()` is modified. No additional changes needed if the new function approach (Option B) is adopted.

Key references:
- `src/lib/path-validator.ts:29`
- `src/lib/path-validator.ts:54`
- `src/lib/file-operations.ts:225`
- `src/lib/file-operations.ts:261`
- `src/lib/file-operations.ts:298`
- `src/lib/file-operations.ts:375`
- `src/lib/file-operations.ts:618` -- `renameFileOrDirectory()` missing source path symlink validation
- `src/lib/file-operations.ts:674`
- `src/app/api/worktrees/[id]/files/[...path]/route.ts:96`
- `src/app/api/worktrees/[id]/files/[...path]/route.ts:153` -- GET handler directly calls `readFile()` for image files, bypassing `file-operations.ts` entirely
- `src/app/api/worktrees/[id]/files/[...path]/route.ts:200-211` -- GET handler directly calls `readFile()` for video files, bypassing `file-operations.ts` entirely
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts:113`
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts:189`
- `src/app/api/worktrees/[id]/tree/[...path]/route.ts` -- readDirectory() after isPathSafe() (F3-001)
- `src/app/api/worktrees/[id]/search/route.ts` -- searchWithTimeout() depends on isPathSafe() (F3-001)
- `src/lib/file-tree.ts:149` -- targetPath calculation in readDirectory() (F3-001)
- `src/lib/file-search.ts:265` -- isPathSafe() in searchDirectory() (F3-005)

**Note on image/video code paths (F1-001):** The GET handler at lines 153 and 200-211 of route.ts calls `readFile()` directly for image and video responses. These code paths do not go through `readFileContent()` in `file-operations.ts`, so the only defense is `getWorktreeAndValidatePath()` which calls `isPathSafe()` -- the same lexical-only check. This is a separate vulnerable code path from the text file reading flow.

## Important Observation

`moveFileOrDirectory()` includes a symlink-aware `realpathSync()` check for the destination directory (SEC-006). That indicates the codebase already recognizes symlink escape risks in at least one path-sensitive operation.

However, this protection is limited:
- It covers only the **destination directory** boundary check.
- The **source path** uses `realpathSync()` only for the `MOVE_SAME_PATH` identity check (lines 564-565), not for a worktree boundary check. A source that is a symlink pointing outside the worktree will be followed without boundary validation.
- `renameFileOrDirectory()` (lines 618-662) has no `realpathSync()` validation on the source path at all.

The more general file APIs do not apply equivalent realpath validation.

## Recommended Direction

- Resolve `realpath()` on the target path (or the existing parent directory for create/upload) before read/write/delete
- Confirm the resolved path remains under the real worktree root
- Reject symlinked ancestors that escape the worktree
- Apply consistent symlink-safe validation across all file operations, not only move
- **Apply `realpathSync()` to `rootDir` (worktreeRoot) as well as the target path** to handle OS-level symlinks such as macOS `/var` -> `/private/var` (F3-003)

### Realpath Strategy for Create/Upload Operations (F3-002)

For operations that create new files or directories (`createFileOrDirectory()`, `writeBinaryFile()`), the target path does not yet exist, so `realpath()` will fail with `ENOENT`. The implementation must use the following strategy:

- **Existing file operations** (read/update/delete/rename): Apply `realpath()` directly to the target path.
- **New file creation operations** (create/upload): Find the nearest existing ancestor directory and apply `realpath()` to it. Validate that this resolved ancestor path is within the worktreeRoot.
- **Implementation approach**: Walk the path components from the full target path toward the root, finding the longest existing prefix. Apply `realpath()` to that existing prefix and verify it resolves within the `realpathSync(worktreeRoot)` boundary.
- **Edge case -- symlink parent directory**: If `worktree/symlink-to-external/newfile.md` is requested, the nearest existing ancestor is `worktree/symlink-to-external/`. Applying `realpath()` to this path will resolve the symlink, revealing the actual destination is outside the worktree. This correctly blocks the operation.

### worktreeRoot Symlink Resolution (F3-003)

On macOS, `tmpdir()` returns `/var/folders/...` but `/var` is a symlink to `/private/var`. If `realpath()` is applied only to the target path, the resolved path (`/private/var/folders/.../file.txt`) will not match the unresolved worktreeRoot (`/var/folders/...`), causing all operations to be falsely rejected.

**Requirement**: The realpath validation function must apply `realpathSync()` to both the target path and the `rootDir`/worktreeRoot before performing the `startsWith()` boundary check. This matches the existing pattern in `moveFileOrDirectory()` SEC-006 (lines 546-547).

### Implementation Strategy Options (F3-004, F3-005)

Modifying `isPathSafe()` directly would affect all 8 files that call it. The recommended approach is:

- **Option A**: Modify `isPathSafe()` directly -- affects all callers including `file-search.ts` and `repositories/scan`, with potential performance impact on recursive directory traversal.
- **Option B (Recommended)**: Create a new function (e.g., `isPathSafeWithSymlinkCheck()`) in `path-validator.ts` that wraps `isPathSafe()` and adds `realpath()` validation. Use this new function in file operation APIs (`files`, `upload`, `tree` routes) while leaving `file-search.ts` and `repositories/scan` on the existing `isPathSafe()`. This avoids performance regression in search and preserves backward compatibility.
- **Option C**: Add `realpath()` validation inside each function in `file-operations.ts` individually -- avoids changing the shared validator but creates duplication.

`file-search.ts` already uses `lstat()` to skip symlink entries during traversal, providing partial defense. Adding `realpath()` on every entry would be redundant and create unnecessary I/O overhead. The `lstat()`-based defense is sufficient for the search use case because it prevents symlink following during recursive traversal.

### Performance Considerations (F3-007)

- **Individual file operations** (files, upload APIs): Adding one `realpath()` call per request is negligible overhead.
- **Directory traversal APIs** (tree, search): If `isPathSafe()` itself is modified, every entry in `readDirectory()` (up to 500 per directory) and `searchDirectory()` would incur a `realpath()` system call. This is unacceptable for large worktrees.
- **Recommended strategy**: Apply `realpath()` validation at the API route level or in `file-operations.ts` functions, not inside the traversal loops. For tree/search APIs, validate only the root request path (the directory being listed or searched), not each discovered entry. Combine with the existing `lstat()` skip for child entries.

### Existing Symlink Patterns in Codebase (F1-003)

The codebase already has two distinct approaches to symlink handling:

1. **Symlink skip via `lstat()` + `isSymbolicLink()`**
   - `file-tree.ts:182` -- `lstat()` check skips symlinks from directory listings
   - `file-search.ts:306` -- `isSymbolicLink()` check skips symlinks during file search
   - These prevent symlinks from appearing in the UI, but do not protect against direct API calls with crafted paths.

2. **Realpath boundary validation via `realpathSync()`**
   - `file-operations.ts:544-553` (moveFileOrDirectory SEC-006) -- resolves the real destination path and validates it stays within the worktree root.

**Comparison:** The `lstat()` approach rejects symlink entries themselves (the link is not traversed), while the `realpath()` approach resolves symlinks and validates the final destination against a trust boundary. For API-level defense, the `realpath()` approach is more appropriate because it protects against direct API requests that bypass the UI file tree. However, both approaches may be combined: UI layers skip symlinks to reduce user confusion, while API layers use `realpath()` to enforce the security boundary.

The implementation should consider which layer to apply the fix: adding `realpath()` validation to `isPathSafe()` would protect all callers centrally, but `realpath()` requires the target to exist (or the parent directory for create/upload operations).

## Validation Notes

Dynamic verification should include:
1. Creating a symlink inside a worktree to an external directory
2. Reading a file through that symlink via the API
3. Attempting upload/write through that symlink
4. Confirming access escapes the intended worktree boundary
5. Listing a symlink directory via the tree API (F3-001)
6. Searching within a symlink directory via the search API (F3-001)

### Acceptance Criteria (F1-005)

The fix is considered complete when all of the following are satisfied:

- [ ] **Symlink rejection:** A request to any affected endpoint (`GET`/`PUT`/`POST`/`DELETE`/`PATCH`/Upload/Tree/Search) with a path that resolves through a symlink pointing outside the worktree root is rejected with an `INVALID_PATH` error.
- [ ] **Normal path preservation:** Requests to paths that do not involve symlinks continue to function correctly (read, write, create, delete, rename, move, upload).
- [ ] **Internal symlink preservation (F3-008):** Symlinks that point to locations within the worktreeRoot (internal symlinks) remain accessible. Only symlinks pointing outside the worktreeRoot (external symlinks) are rejected.
- [ ] **Image/video GET paths:** The direct `readFile()` code paths for image (line 153) and video (line 200-211) responses in the GET handler are also protected against symlink traversal.
- [ ] **Rename protection:** `renameFileOrDirectory()` validates the source path against symlink traversal before performing `fs.rename()`.
- [ ] **Tree API protection (F3-001):** `GET /api/worktrees/:id/tree/:path` rejects symlink directories that resolve outside the worktree root.
- [ ] **Search API protection (F3-001):** `GET /api/worktrees/:id/search` does not traverse or return results from symlink directories that resolve outside the worktree root.
- [ ] **Create/upload with symlink parent (F3-002):** Creating a file or uploading into a path where an intermediate directory is a symlink to an external location is rejected.
- [ ] **macOS tmpdir compatibility (F3-003):** File operations work correctly when the worktreeRoot path contains OS-level symlinks (e.g., macOS `/var` -> `/private/var`). Both target and rootDir are resolved via `realpathSync()` before comparison.
- [ ] **Existing tests pass (F3-004):** `moveFileOrDirectory()` SEC-006 tests and all other existing file operation tests continue to pass, including tests using `tmpdir()` as worktreeRoot on macOS.
- [ ] **New test coverage:** New test cases cover the following scenarios:
  1. External symlink read -> `INVALID_PATH`
  2. External symlink write -> `INVALID_PATH`
  3. External symlink delete -> `INVALID_PATH`
  4. External symlink rename (source) -> `INVALID_PATH`
  5. External symlink directory: new file creation -> `INVALID_PATH`
  6. External symlink directory: upload -> `INVALID_PATH`
  7. Internal symlink (within worktreeRoot) read -> success (F3-008)
  8. Dangling symlink (broken target) access -> appropriate error (F3-009)
  9. Multi-level symlink chain (symlink -> symlink -> external) -> `INVALID_PATH` (F3-009)
  10. worktreeRoot itself contains symlink (macOS tmpdir) -> normal operation (F3-003)

## Documentation Updates (F3-011)

After the fix is complete, the following documentation should be updated:
- `CLAUDE.md`: Add `src/lib/path-validator.ts` module description (isPathSafe, validateWorktreePath, and the new symlink-aware validation function)
- `CLAUDE.md`: Update `src/lib/file-operations.ts` module description to mention symlink validation
- `CLAUDE.md`: Update `src/lib/file-tree.ts` and `src/lib/file-search.ts` descriptions to note symlink handling approach

---

## Review History

### Stage 1 - Issue Review, Iteration 1 (2026-03-02)
- **F1-001** (should_fix): Added annotation for GET handler image/video `readFile()` direct calls (route.ts:153, 200-211) as separate vulnerable code paths bypassing `file-operations.ts`
- **F1-002** (should_fix): Added `renameFileOrDirectory()` (line 618) to affected code with note on missing source path symlink validation
- **F1-003** (should_fix): Added "Existing Symlink Patterns in Codebase" subsection comparing `lstat()`/`isSymbolicLink()` skip approach vs `realpath()` boundary validation approach
- **F1-005** (nice_to_have): Added concrete acceptance criteria checklist with pass/fail conditions

### Stage 3 - Impact Analysis Review, Iteration 1 (2026-03-02)
- **F3-001** (must_fix): Added tree API (`GET /api/worktrees/:id/tree/:path`) and search API (`GET /api/worktrees/:id/search`) to Affected Endpoints with detailed impact description; added `file-tree.ts` and `file-search.ts` to Affected Code; added tree/search to Example Exploit and Validation Notes
- **F3-002** (must_fix): Added "Realpath Strategy for Create/Upload Operations" subsection to Recommended Direction with nearest-existing-ancestor approach for non-existent paths
- **F3-003** (must_fix): Added "worktreeRoot Symlink Resolution" subsection; added macOS tmpdir compatibility acceptance criterion; added `realpathSync()` for rootDir requirement
- **F3-004** (should_fix): Enhanced "Existing tests pass" acceptance criterion with macOS tmpdir note; added test scenario #10 for worktreeRoot symlink
- **F3-005** (should_fix): Added "Implementation Strategy Options" subsection with Options A/B/C; recommended Option B (new function) to avoid performance regression in search
- **F3-006** (should_fix): Added "Indirect Impact" subsection for `repositories/scan` API; noted isPathSafe() modification side effects
- **F3-007** (should_fix): Added "Performance Considerations" subsection with per-API analysis and recommended strategy
- **F3-008** (should_fix): Added "Internal symlink preservation" acceptance criterion; added test scenario #7 (internal symlink success)
- **F3-009** (should_fix): Added test scenario #8 (dangling symlink) and #9 (multi-level chain) to acceptance criteria
- **F3-010** (nice_to_have): Added `validateWorktreePath()` indirect impact via `clone-manager.ts` and `opencode-config.ts` to Affected Code
- **F3-011** (nice_to_have): Added "Documentation Updates" section listing post-fix documentation tasks
