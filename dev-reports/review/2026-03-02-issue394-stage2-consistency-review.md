# Issue #394 Stage 2: 整合性レビュー

## Executive Summary

Issue #394（Symlink Traversal Fix）の設計方針書と実際のコードベースとの整合性を6つの観点で検証した。

**全体評価**: Good -- 設計方針書は既存コードの構造を正確に反映しており、修正方針は実装可能かつ合理的である。must_fix 1件、should_fix 3件、nice_to_have 3件を検出した。

**最重要指摘**: upload/tree APIルートが `getWorktreeAndValidatePath()` を使用していないにもかかわらず、設計方針書の防御責務分担セクションで「全ファイルAPIエンドポイントの共通入口」と記載されている不整合。

---

## Review Information

| 項目 | 値 |
|------|-----|
| Issue | #394 |
| Stage | 2 (整合性レビュー) |
| Focus | 設計方針書 vs 実コードの整合性 |
| Date | 2026-03-02 |
| Status | Conditionally Approved |

---

## Detailed Findings

### S2-001 [MUST FIX] upload/tree APIルートはgetWorktreeAndValidatePath()を使用していない

**カテゴリ**: API整合性

**設計方針書の記載**:
- セクション4「防御責務の分担方針」: 「API層のgetWorktreeAndValidatePath()は全ファイルAPIエンドポイント（files/upload/tree）の共通入口であり、ここにresolveAndValidateRealPath()を配置することで一元的な防御を実現する」
- セクション9 [S1-004]: 「getWorktreeAndValidatePath()への追加により、画像・動画のreadFile()直接呼び出しパスが自動保護される」

**実コードの状況**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/upload/[...path]/route.ts` (行117):
```typescript
if (!isPathSafe(normalizedDir, worktree.path)) {
  return createUploadErrorResponse('INVALID_PATH', 'Invalid file path');
}
```

`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/tree/[...path]/route.ts` (行75):
```typescript
if (!isPathSafe(relativePath, worktree.path)) {
  const errorResponse = createAccessDeniedError('Invalid path');
  // ...
}
```

これらのルートは `getWorktreeAndValidatePath()` を使用しておらず、独自にインラインでisPathSafe()を呼び出している。

**影響**: 設計方針書に基づいて「getWorktreeAndValidatePath()にresolveAndValidateRealPath()を追加すれば自動保護される」と判断した実装者が、upload/treeルートへの個別追加を見落とす可能性がある。

**改善提案**: セクション4の記述を修正し、getWorktreeAndValidatePath()がfiles APIルートのみの共通入口であることを明記する。upload/tree APIルートは個別にresolveAndValidateRealPath()を追加する旨を強調する。なお、セクション5.2のAPI routes表には既に正しい実装指示（「upload: isPathSafe後にresolveAndValidateRealPath追加」「tree: isPathSafe後にresolveAndValidateRealPath追加」）が記載されているため、防御責務分担セクションとの整合を取ること。

---

### S2-002 [SHOULD FIX] resolveAndValidateRealPath()のパラメータ順序が既存関数と逆順

**カテゴリ**: 関数整合性

**設計方針書の記載** (セクション4):
```typescript
export function resolveAndValidateRealPath(
  targetPath: string,
  rootDir: string
): boolean;
```

**実コードのパターン比較**:

- `isPathSafe(targetPath, rootDir)` -- path-validator.ts: targetPath-first
- `validateFileOperation(worktreeRoot, sourcePath)` -- file-operations.ts: rootDir-first
- `readFileContent(worktreeRoot, relativePath)` -- file-operations.ts: rootDir-first
- `moveFileOrDirectory(worktreeRoot, sourcePath, ...)` -- file-operations.ts: rootDir-first

設計の `resolveAndValidateRealPath(targetPath, rootDir)` は path-validator.ts 配置のため isPathSafe() と同じ順序であり、ファイル内の一貫性は保たれている。ただし file-operations.ts から呼び出す際にパラメータ順序が逆になる点は注意が必要。

**改善提案**: 設計方針書にパラメータ順序の設計根拠（path-validator.ts内の既存パターンに準拠）を注記し、file-operations.ts内から呼び出す際の順序に注意すべき旨を補足する。

---

### S2-003 [SHOULD FIX] validateFileOperation()のJSDocとrealpath統合設計の不一致

**カテゴリ**: 関数整合性

**実コードの現行JSDoc** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` 行439-477):
```typescript
/**
 * Common validation helper for file operations [MF-001]
 *
 * Validates source path safety (via isPathSafe) and existence.
 * [SF-S2-003] Only validates source path; destination validation
 * is the caller's responsibility.
 *
 * Used by: renameFileOrDirectory, moveFileOrDirectory
 */
```

**設計方針書の記載** (セクション5.2):
「validateFileOperation(): isPathSafe後にresolveAndValidateRealPath追加」

**不整合**: realpath検証を追加すると、validateFileOperation()の責務が「isPathSafe + 存在チェック」から「isPathSafe + realpath検証 + 存在チェック」に拡張される。しかし、設計方針書にはJSDoc更新の計画が含まれていない。

**改善提案**: 実装チェックリストにvalidateFileOperation()のJSDoc更新項目を追加する。

---

### S2-004 [NICE TO HAVE] テスト設計のセットアップ例がbeforeEach/afterEachパターンを示していない

**カテゴリ**: テスト整合性

設計方針書セクション8のテストセットアップ例は以下のみ:
```typescript
const worktreeRoot = path.join(os.tmpdir(), 'test-worktree');
const externalDir = path.join(os.tmpdir(), 'test-external');
fs.mkdirSync(worktreeRoot, { recursive: true });
// ...
```

Vitest環境(`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/vitest.config.ts`)では `globals: true` が設定されており、`beforeEach`/`afterEach` がグローバルに利用可能。symlink操作を伴うテストではクリーンアップが必須だが、テスト設計例にはこのパターンが含まれていない。

**影響**: 軽微。実装時に適切なsetup/teardownを追加すれば問題ない。

---

### S2-005 [NICE TO HAVE] 実装順序ステップ1でのユニットテストの範囲が不明確

**カテゴリ**: 実装順序

ステップ1「resolveAndValidateRealPath()関数の実装とユニットテスト」の「ユニットテスト」がどのファイルを指すか不明確。セクション8では `tests/unit/path-validator.test.ts` への追加と記載されているが、実装順序セクションでは具体的なファイル名が省略されている。

**影響**: 軽微。セクション8との相互参照で判断可能。

---

### S2-006 [SHOULD FIX] moveFileOrDirectory()のSEC-006パターンとresolveAndValidateRealPath()のアルゴリズムの差異

**カテゴリ**: 既存パターン整合性

**実コードのSEC-006** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` 行546-548):
```typescript
const resolvedDest = realpathSync(destFullPath);
const resolvedRoot = realpathSync(worktreeRoot);
if (!resolvedDest.startsWith(resolvedRoot + sep) && resolvedDest !== resolvedRoot) {
  return createErrorResult('INVALID_PATH');
}
```

条件: `!(startsWith(root+sep) || === root)` -- つまり root自体は許可。

**設計方針書のアルゴリズム** (セクション5.1 ステップ3b):
「resolvedTarget が resolvedRoot + sep で始まるか、resolvedRoot と等しいか確認」

設計方針書の記述はSEC-006パターンと論理的に等価であるが、「resolvedRoot と等しいか」のケースのセマンティクスが異なる:
- SEC-006: 移動先がworktreeRoot自体 = ルートへの移動（有効操作）
- resolveAndValidateRealPath(): ファイルパスがworktreeRoot自体 = ルートディレクトリへの直接アクセス

この差異が意図的なものか明記されていない。

**改善提案**: resolveAndValidateRealPath()のアルゴリズム記述に「resolvedTarget === resolvedRootの場合もtrueを返す理由」を注記する（isPathSafe()でもルート自体は許可されているため一貫性を保つ）。

---

### S2-007 [NICE TO HAVE] tree APIルートのエラーレスポンス形式がfiles APIルートと異なる

**カテゴリ**: API整合性

- tree route: `{ error: { ... } }` 形式 (`createAccessDeniedError()`)
- files route: `{ success: false, error: { code, message } }` 形式 (`createErrorResponse()`)

resolveAndValidateRealPath()失敗時のエラーレスポンスをどちらの形式で返すかが設計方針書に記載されていない。

**影響**: 軽微。既存パターンを踏襲すれば問題ない（本Issueスコープ外の統一は不要）。

---

## 整合性チェック一覧

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| resolveAndValidateRealPath()配置先 | src/lib/path-validator.ts | 該当ファイルにはisPathSafe/validateWorktreePathが存在 | 整合（追加可能） |
| isPathSafe()の使用箇所（8箇所） | 変更なし | 実際にsrc/以下8ファイルで使用確認 | 整合 |
| validateFileOperation()の使用範囲 | rename/moveのみ | 実コードでrenameFileOrDirectory/moveFileOrDirectoryのみ使用 | 整合 |
| moveFileOrDirectory()のSEC-006 | 既存パターンを汎用化 | 行546-548にrealpathSync+startsWith確認 | 整合（差異注記推奨） |
| file-tree.tsのlstat防御 | Layer 3として変更なし | 行178-183でlstat+isSymbolicLinkスキップ確認 | 整合 |
| file-search.tsのlstat防御 | 変更なし | 行303-307でlstat+isSymbolicLinkスキップ確認 | 整合 |
| getWorktreeAndValidatePath()の適用範囲 | files/upload/tree全エンドポイント | filesルートのみ使用 | **不整合（S2-001）** |
| upload routeのisPathSafe使用 | isPathSafe後にrealpath追加 | 行117でisPathSafe単独使用 | 整合（個別追加指示あり） |
| tree routeのisPathSafe使用 | isPathSafe後にrealpath追加 | 行75でisPathSafe単独使用 | 整合（個別追加指示あり） |
| テストフレームワーク | Vitest | vitest.config.ts確認済み | 整合 |
| realpathSyncの既存import | file-operations.tsで使用 | 行13で`{ existsSync, realpathSync, statSync }`確認 | 整合 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | S2-001の記述不整合によりupload/treeルートへのrealpath追加が漏れる | High | Medium | P1 |
| 技術的 | S2-002のパラメータ順序混乱による呼び出しミス | Low | Low | P3 |
| 技術的 | S2-006のルートパス等価判定の意図不明確 | Low | Low | P3 |
| 運用 | S2-003のJSDoc未更新による将来の保守困難 | Low | Medium | P2 |

---

## Approval Status

**Conditionally Approved** -- S2-001（must_fix）の修正後は実装に進んでよい。

### Summary Counts

| 重要度 | 件数 |
|--------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |

---

## Reviewed Files

| File | Path |
|------|------|
| 設計方針書 | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/dev-reports/design/issue-394-symlink-traversal-fix-design-policy.md` |
| path-validator.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/path-validator.ts` |
| file-operations.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` |
| files route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/files/[...path]/route.ts` |
| upload route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/upload/[...path]/route.ts` |
| tree route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/tree/[...path]/route.ts` |
| file-tree.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-tree.ts` |
| file-search.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-search.ts` |
| path-validator.test.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/path-validator.test.ts` |
| vitest.config.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/vitest.config.ts` |
| url-path-encoder.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/url-path-encoder.ts` |
| repositories/scan/route.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/repositories/scan/route.ts` |

---

*Generated by architecture-review-agent for Issue #394 Stage 2*
*Date: 2026-03-02*
