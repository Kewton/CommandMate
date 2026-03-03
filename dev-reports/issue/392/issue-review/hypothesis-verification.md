# Issue #392 仮説検証レポート

## 検証日時
- 2026-03-02

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `targetPath = customTargetPath \|\| this.getTargetPath(repoName)` で未解決パスが代入される | Confirmed | `clone-manager.ts:337` |
| 2 | `isPathSafe(customTargetPath, basePath)` で検証するが、解決後パスを返さない | Confirmed | `path-validator.ts:56` vs `clone-manager.ts:341` |
| 3 | 検証後に `path.resolve(basePath, customTargetPath)` によるカノニカル化を行っていない | Confirmed | `clone-manager.ts:336-356` |
| 4 | 未解決の相対パスがそのまま `targetPath` として保持される | Confirmed | `clone-manager.ts:337,352,359` |
| 5 | `spawn('git', ['clone', '--progress', cloneUrl, targetPath])` が未解決パスを使用 | Confirmed | `clone-manager.ts:389` |

## 詳細検証

### 仮説 1: `targetPath = customTargetPath || this.getTargetPath(repoName)` で未解決パスが代入される

**Issue内の記述**: "targetPath is assigned as: customTargetPath || this.getTargetPath(repoName)"

**検証手順**:
1. `src/lib/clone-manager.ts` のL337を確認
2. `const targetPath = customTargetPath || this.getTargetPath(repoName);`

**判定**: Confirmed

**根拠**: `clone-manager.ts:337` にて `customTargetPath` が渡された場合、そのまま `targetPath` に代入される。`this.getTargetPath(repoName)` は `path.join(this.config.basePath!, repoName)` で絶対パスを返すが、`customTargetPath` を使う分岐では絶対パスへの解決が行われない。

---

### 仮説 2: `isPathSafe(customTargetPath, basePath)` が相対パスを安全と判定する

**Issue内の記述**: "isPathSafe("tmp-escape", "/srv/commandmate/repos") returns true"

**検証手順**:
1. `src/lib/path-validator.ts` の `isPathSafe()` 実装を確認
2. L55-56: `const resolvedRoot = path.resolve(rootDir);` / `const resolvedTarget = path.resolve(rootDir, decodedPath);`
3. L60: `const relative = path.relative(resolvedRoot, resolvedTarget);`
4. 相対パス `"tmp-escape"` を basePath `/srv/commandmate/repos` に対して評価すると:
   - `resolvedTarget = path.resolve("/srv/commandmate/repos", "tmp-escape")` = `"/srv/commandmate/repos/tmp-escape"`
   - `relative = "tmp-escape"` → `..` で始まらず、`true` を返す

**判定**: Confirmed

**根拠**: `isPathSafe` は第2引数 `rootDir` に対して第1引数を解決して検証する（L56）。よって相対パスは rootDir 内として評価され `true` を返すが、解決済みパスは呼び出し元に返却されない。

---

### 仮説 3: 検証後に `path.resolve()` カノニカル化が行われない

**Issue内の記述**: "customTargetPath is not canonicalized with: path.resolve(this.config.basePath!, customTargetPath)"

**検証手順**:
1. `clone-manager.ts:336-356`（`startCloneJob` のパス決定～job作成）を確認
2. L337: `targetPath = customTargetPath` が代入された後
3. L341: `isPathSafe(customTargetPath, ...)` で検証するが返り値は `boolean` のみ
4. L347-356: そのまま `targetPath` を `existsSync`, `createCloneJob`, `executeClone` に渡している

**判定**: Confirmed

**根拠**: `isPathSafe` 検証後、`customTargetPath` を `path.resolve(basePath, customTargetPath)` でカノニカル化するコードが存在しない。`validateWorktreePath()` (`path-validator.ts:89`) は解決済みパスを返す設計だが、`startCloneJob` ではこれを使用していない。

---

### 仮説 4: 未解決パスがそのまま `git clone` に渡される

**Issue内の記述**: "spawn('git', ['clone', '--progress', cloneUrl, targetPath]) uses that unresolved value directly"

**検証手順**:
1. `clone-manager.ts:359`: `this.executeClone(job.id, cloneUrl, targetPath)` に `targetPath` を渡す
2. `clone-manager.ts:389`: `spawn('git', ['clone', '--progress', cloneUrl, targetPath], {...})` で実際に呼び出す

**判定**: Confirmed

**根拠**: `executeClone` に渡された `targetPath` が直接 `spawn()` の引数として使用される。Node.js の `spawn` は相対パスをプロセスのカレントディレクトリ（`process.cwd()`）から解決するため、`basePath` (/srv/commandmate/repos) ではなく `process.cwd()` (/srv/commandmate) 以下に clone される。

---

## Stage 1レビューへの申し送り事項

- 全仮説が **Confirmed** のため、Issueの主張に誤りはない
- `path-validator.ts` に `validateWorktreePath()` という正しい設計の関数（解決済みパスを返す）が既に存在するが、`startCloneJob` では使われていない点を重点確認すること
- `resolveDefaultBasePath()` で CM_ROOT_DIR が未設定の場合 `process.cwd()` が basePath になるが、`route.ts` では `CM_ROOT_DIR` を明示的に渡しているため、basePath は通常絶対パスであることを確認
- `existsSync(targetPath)` のチェック（L347）も未解決パスに対して行われるため、同様にプロセスの cwd から解決されることに注意
