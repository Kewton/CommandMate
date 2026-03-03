# Issue #394 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）
**Issue**: security: symlink traversal in file APIs allows access outside worktree root

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 2 |
| **合計** | **11** |

**総合評価**: needs_improvement

Issue #394は脆弱性の根本原因分析と影響範囲の特定が高品質であるが、実装に直結する影響範囲分析において3件の必須修正事項が確認された。特に、tree/search APIルートの漏れ、新規ファイル作成時のrealpath適用戦略の欠如、OS固有symlink（macOS /var -> /private/var）の考慮不足は、実装段階でのバグや全テスト失敗を引き起こすリスクがある。

---

## Must Fix（必須対応）

### F3-001: tree APIルートとsearch APIルートが影響範囲に含まれていない

**カテゴリ**: 影響ファイル
**場所**: ## Affected Endpoints セクション

**問題**:
Issue本文のAffected Endpointsにはfiles API（6エンドポイント）とupload API（1エンドポイント）のみが記載されているが、以下の2エンドポイントも同じ脆弱性の影響を受ける。

1. `GET /api/worktrees/:id/tree/[...path]`
   - `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/tree/[...path]/route.ts` line 75 で `isPathSafe()` による検証後に `readDirectory()` を呼び出す
   - `readDirectory()` は `lstat()` で子エントリのsymlinkをスキップするが、ターゲットディレクトリ自体がsymlinkである場合は検出しない
   - 例: `GET /api/worktrees/:id/tree/symlink-to-etc` は `/etc` の内容をリストする

2. `GET /api/worktrees/:id/search`
   - `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/search/route.ts` line 139 で `searchWithTimeout()` にworktree.pathを渡す
   - `file-search.ts` 内で `lstat()` によるsymlinkスキップがあるが、パスの検証は `isPathSafe()` に依存

**証拠**:
```typescript
// src/app/api/worktrees/[id]/tree/[...path]/route.ts:75
if (!isPathSafe(relativePath, worktree.path)) {
  // ... error
}
// line 84: symlink先のディレクトリ内容を返す
const result = await readDirectory(worktree.path, relativePath);
```

```typescript
// src/lib/file-tree.ts:149
const targetPath = relativePath ? join(rootDir, relativePath) : rootDir;
// line 178-183: 子エントリのsymlinkはスキップするが、targetPath自体は未検証
const entryStat = await lstat(entryPath);
if (entryStat.isSymbolicLink()) { continue; }
```

**推奨対応**:
Affected Endpointsに上記2エンドポイントを追加し、各エンドポイントの防御方針を明記する。

---

### F3-002: 新規ファイル/ディレクトリ作成時のrealpath()適用戦略が未記載

**カテゴリ**: エッジケース
**場所**: ## Recommended Direction セクション

**問題**:
`realpath()` は既存のパスに対してのみ機能する。新規ファイル/ディレクトリ作成時には対象パスが存在しないため、`realpath()` は ENOENT を返す。

具体的な問題箇所:
- `createFileOrDirectory()` (`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts` line 298): `mkdir(fullPath, { recursive: true })` で中間ディレクトリも作成される
- `writeBinaryFile()` (line 674): 同様に親ディレクトリが存在しない場合がある

例: `worktree/symlink-to-external/newSubDir/newFile.md` を作成する場合:
1. `symlink-to-external` は `/external/path` を指すsymlink
2. `isPathSafe()` のlexical checkはパスする（`symlink-to-external/newSubDir/newFile.md` はworktree内）
3. `realpath('worktree/symlink-to-external/newSubDir/newFile.md')` はENOENT（newSubDirが未作成）
4. 親ディレクトリ `worktree/symlink-to-external` に対して `realpath()` を適用すると `/external/path` が返る
5. worktreeRoot外のため拒否すべき

**推奨対応**:
Recommended Directionに以下の戦略を明記する:
- 既存ファイル操作(read/update/delete/rename): 対象パスに `realpath()` を適用
- 新規作成操作(create/upload): 最も近い**既存の祖先ディレクトリ**に `realpath()` を適用し、resolved pathがworktreeRoot内であることを検証
- 実装例: パスを先頭から走査し、存在する最長の祖先パスを見つけて `realpath()` 検証を行うヘルパー関数

---

### F3-003: worktreeRoot自体にOSレベルのsymlinkが含まれるケース（macOS /var -> /private/var）の考慮不足

**カテゴリ**: エッジケース
**場所**: ## Recommended Direction / Acceptance Criteria セクション

**問題**:
macOSでは `tmpdir()` は `/var/folders/...` を返すが、`/var` は `/private/var` へのsymlinkである。`realpathSync('/var/folders/...')` は `/private/var/folders/...` を返す。

既存の `moveFileOrDirectory()` SEC-006 (line 546-547) はこの問題を認識しており、worktreeRootにも `realpathSync()` を適用している:

```typescript
// src/lib/file-operations.ts:546-547
const resolvedDest = realpathSync(destFullPath);
const resolvedRoot = realpathSync(worktreeRoot);
```

しかし、`isPathSafe()` を修正する場合、worktreeRoot（DBから取得した `worktree.path`）がsymlinkを含む可能性を考慮しないと:
- targetPathのrealpath: `/private/var/folders/.../file.txt`
- rootDirのrealpath未適用: `/var/folders/...`
- 比較結果: **不一致** → 全ファイル操作がINVALID_PATHで失敗

全既存テスト（`tmpdir()` ベース）がmacOSで失敗するリスクがある。

**推奨対応**:
- realpath検証時にrootDirにもrealpathSync()を適用してから比較する
- Acceptance Criteriaに「macOS tmpdir()ベースのworktreeで正常動作すること」を追加

---

## Should Fix（推奨対応）

### F3-004: 既存テストのtmpdir()使用がrealpath導入後に互換性問題を起こす可能性

**カテゴリ**: テスト影響
**場所**: ## Acceptance Criteria - 既存テストパスの項目

**問題**:
以下の既存テストファイルが `tmpdir()` をworktreeRootとして使用:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations.test.ts` (line 33)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations-move.test.ts` (line 18)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations-validate.test.ts` (line 18)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/integration/api-file-operations.test.ts` (line 61)

F3-003で述べた理由により、isPathSafe()の修正方法次第では全テストが失敗する。

**推奨対応**:
Acceptance Criteriaの「Existing tests pass」に以下を補足:
- macOS環境でtmpdir()ベースのテストが引き続きパスすることを確認
- npm run test:unit 実行で全テストパスを確認

---

### F3-005: isPathSafe()のシグネチャ変更がfile-search.tsのパス安全性チェックに影響する可能性

**カテゴリ**: 他モジュール影響
**場所**: ## Affected Code / Recommended Direction セクション

**問題**:
`file-search.ts` の `searchDirectory()` (line 265, 298) で `isPathSafe()` を呼び出している。isPathSafe()にrealpath()を追加すると、検索対象ディレクトリ内の全エントリに対してrealpath()が呼ばれ、パフォーマンス劣化とlstat()との二重チェックが発生する。

**推奨対応**:
以下のいずれかの設計方針を明記する:
- **方針A**: isPathSafe()自体にrealpath()を追加（全呼び出し元に影響）
- **方針B**: `isPathSafeWithRealpath()` 等の新関数を作成（ファイルAPIのみで使用）
- **方針C**: file-operations.tsの各関数内でrealpath検証を追加（isPathSafe()は変更なし）

**推奨は方針BまたはC**。file-search.tsは既にlstat()でsymlinkスキップしているため、追加のrealpath()は不要。

---

### F3-006: repositories/scan APIのisPathSafe()呼び出しへの影響が未考慮

**カテゴリ**: 一貫性
**場所**: ## Affected Code セクション

**問題**:
`/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/repositories/scan/route.ts` (line 29) で `isPathSafe(repositoryPath, CM_ROOT_DIR)` が呼び出されている。isPathSafe()を変更する場合、副作用として影響を受ける。

**推奨対応**:
Affected Codeに間接影響として追記するか、F3-005の方針B/Cを採用してisPathSafe()自体は変更しない。

---

### F3-007: realpath()の追加によるI/Oパフォーマンスへの影響分析が未記載

**カテゴリ**: パフォーマンス
**場所**: ## Recommended Direction セクション

**問題**:
realpath()はシステムコールであり、パスの各コンポーネントのsymlink解決のために複数のstat()を内部実行する。影響の大きい箇所:
- `file-tree.ts` `readDirectory()`: 最大500エントリ/ディレクトリ
- `file-search.ts` `searchDirectory()`: 再帰走査で多数のファイル

**推奨対応**:
パフォーマンス考慮事項をRecommended Directionに追加:
- ファイルAPI: realpath()追加は軽微（1リクエスト1回）
- ツリー/検索API: lstat()ベースの既存防御を維持し、realpath()は不要

---

### F3-008: worktree内部を指すsymlink（正当なsymlink）の取り扱いが未定義

**カテゴリ**: 後方互換性
**場所**: ## Acceptance Criteria セクション

**問題**:
symlink traversalの修正により、worktree内のsymlinkを通じたファイルアクセスが全て拒否される可能性がある。しかし、worktreeRoot内を指すsymlink（内部symlink）は正当な利用であり、拒否すべきではない。

クライアント側はAPIレスポンスのsuccess/failureを汎用的にハンドリングしており、error.codeに依存していないため、技術的な後方互換性の問題はない。ただし、ユーザーが意図的に設置したworktree内部symlinkが使用不能になるUX変更がある。

**推奨対応**:
Acceptance Criteriaに以下を追加:
- worktreeRoot**内**を指すsymlinkは引き続きアクセス可能であること
- worktreeRoot**外**を指すsymlinkのみが拒否されること

---

### F3-009: 新規テストケースの具体的なシナリオが不足

**カテゴリ**: テスト影響
**場所**: ## Acceptance Criteria - New test coverage

**問題**:
Acceptance Criteriaの「New test coverage」は概要的な記述のみ。

**推奨する10シナリオ**:
1. 外部symlinkを通じた読み取り → INVALID_PATH
2. 外部symlinkを通じた書き込み → INVALID_PATH
3. 外部symlinkを通じた削除 → INVALID_PATH
4. 外部symlinkを通じたリネーム（source） → INVALID_PATH
5. 外部symlinkディレクトリ内への新規作成 → INVALID_PATH
6. 外部symlinkディレクトリへのアップロード → INVALID_PATH
7. **内部symlink（worktreeRoot内を指す）を通じた読み取り → 成功**
8. 壊れたsymlink（dangling symlink） → 適切なエラー
9. 多段symlink（symlink → symlink → external） → INVALID_PATH
10. **worktreeRoot自体がsymlinkの場合 → 正常動作**

特にシナリオ7と10は、修正の正確性を保証するために重要。

---

## Nice to Have（あれば良い）

### F3-010: validateWorktreePath()の呼び出し元への間接影響が未言及

**カテゴリ**: 一貫性
**場所**: ## Affected Code セクション

`validateWorktreePath()` は内部的に `isPathSafe()` を呼び出しており、`clone-manager.ts` と `opencode-config.ts` で使用されている。isPathSafe()修正時に自動的に影響を受ける。

---

### F3-011: 修正後のドキュメント更新が未言及

**カテゴリ**: ドキュメント更新
**場所**: Issue本文全体

CLAUDE.mdの主要機能モジュール一覧にpath-validator.tsが明記されていない。修正完了後にドキュメント更新が望ましい。

---

## 影響範囲マップ

### 直接影響（修正対象）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/path-validator.ts` | isPathSafe()へのrealpath検証追加（または新関数作成） |
| `src/lib/file-operations.ts` | readFileContent/updateFileContent/createFileOrDirectory/deleteFileOrDirectory/renameFileOrDirectory/writeBinaryFileのsymlink検証 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | GET handler image/video直接readFile()パスの保護 |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | アップロードパスのsymlink検証 |

### 間接影響（修正方針によって影響）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/tree/[...path]/route.ts` | **Issueに未記載** - readDirectory()へのパスがsymlinkの場合 |
| `src/app/api/worktrees/[id]/search/route.ts` | **Issueに未記載** - searchWithTimeout()のbasePath |
| `src/lib/file-tree.ts` | readDirectory()のtargetPathが外部symlinkの場合 |
| `src/lib/file-search.ts` | searchDirectory()のisPathSafe()呼び出し |
| `src/app/api/repositories/scan/route.ts` | isPathSafe()修正の副作用 |
| `src/lib/clone-manager.ts` | validateWorktreePath()経由の間接影響 |
| `src/lib/cli-tools/opencode-config.ts` | validateWorktreePath()経由の間接影響 |

### テスト影響

| テストファイル | 影響内容 |
|--------------|---------|
| `tests/unit/lib/file-operations.test.ts` | tmpdir()使用、macOSでの互換性リスク |
| `tests/unit/lib/file-operations-move.test.ts` | 既存symlinkテスト参考、tmpdir()使用 |
| `tests/unit/lib/file-operations-validate.test.ts` | tmpdir()使用 |
| `tests/integration/api-file-operations.test.ts` | tmpdir()使用、symlink traversalテスト追加必要 |
| `tests/unit/path-validator.test.ts` | symlink関連テストケース追加必要 |

---

## 推奨される設計方針

本レビューの分析結果に基づき、以下の設計方針を推奨する:

1. **isPathSafe()は変更しない** -- 影響範囲が大きく（8ファイル）、file-search.ts等のパフォーマンスに影響するため
2. **新関数 `isPathSafeWithSymlinkCheck()` を作成** -- realpath()検証を含むバリデーション関数をpath-validator.tsに追加
3. **file-operations.tsの各関数とAPIルートで新関数を使用** -- 既存のisPathSafe()呼び出し元は変更なし
4. **rootDirにもrealpathSync()を適用** -- macOS tmpdir()問題を回避
5. **create/upload操作では既存の最長祖先パスにrealpath()を適用** -- ENOENTエッジケースを回避
6. **tree/search APIはlstat()ベースの既存防御を維持** -- パフォーマンスを維持しつつ、ターゲットディレクトリのsymlink検証のみ追加

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/path-validator.ts`: コアバリデーター（修正対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-operations.ts`: ファイル操作関数（修正対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/files/[...path]/route.ts`: Files APIルート（修正対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/upload/[...path]/route.ts`: Upload APIルート（修正対象）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/tree/[...path]/route.ts`: Tree APIルート（影響範囲漏れ）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/app/api/worktrees/[id]/search/route.ts`: Search APIルート（影響範囲漏れ）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-tree.ts`: ディレクトリツリー生成（間接影響）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/file-search.ts`: ファイル検索（間接影響）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/src/lib/cmate-parser.ts`: realpath検証の既存実装例

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/path-validator.test.ts`: パスバリデーターテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations.test.ts`: ファイル操作テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/unit/lib/file-operations-move.test.ts`: 移動操作テスト（SEC-006 symlinkテスト含む）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/tests/integration/api-file-operations.test.ts`: API統合テスト

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-394/CLAUDE.md`: プロジェクトガイドライン（path-validator.ts説明未記載）
