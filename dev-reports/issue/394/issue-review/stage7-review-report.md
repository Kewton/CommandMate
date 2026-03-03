# Issue #394 Stage 7 レビューレポート -- 影響範囲レビュー（2回目）

**レビュー日**: 2026-03-02
**フォーカス**: 影響範囲レビュー（2回目イテレーション）
**ステージ**: 7/8

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 1 |

Stage 3で報告した11件の指摘（F3-001〜F3-011）は**全て正しくIssue本文に反映**されている。2回目の影響範囲レビューとして、全isPathSafe()呼び出し元、全worktree APIルート、関連モジュールを精査した結果、**重大な影響範囲の漏れは発見されなかった**。

---

## Stage 3 指摘事項の反映状況

| ID | 重要度 | タイトル | 反映状況 |
|----|--------|---------|---------|
| F3-001 | must_fix | tree/search APIルートの影響範囲追加 | addressed |
| F3-002 | must_fix | create/upload時のrealpath適用戦略 | addressed |
| F3-003 | must_fix | macOS /var -> /private/var等のOS固有symlink | addressed |
| F3-004 | should_fix | tmpdir()テストのrealpath互換性 | addressed |
| F3-005 | should_fix | isPathSafe()修正方針(Option A/B/C) | addressed |
| F3-006 | should_fix | repositories/scan間接影響 | addressed |
| F3-007 | should_fix | realpath()のI/Oパフォーマンス影響 | addressed |
| F3-008 | should_fix | 内部symlinkの後方互換性 | addressed |
| F3-009 | should_fix | テストシナリオの具体化(10項目) | addressed |
| F3-010 | nice_to_have | validateWorktreePath()間接影響 | addressed |
| F3-011 | nice_to_have | ドキュメント更新計画 | addressed |

### 反映の詳細

**F3-001 (must_fix)**: Affected Endpointsに `GET /api/worktrees/:id/tree/:path` と `GET /api/worktrees/:id/search` が追加されている。Affected Codeセクションに `file-tree.ts` と `file-search.ts` が詳細説明付きで追加されている。Example ExploitとValidation Notesにもtree/searchの具体例が含まれている。F5-002の追加反映により、`stat()` vs `lstat()` の動作差異も明記されている。

**F3-002 (must_fix)**: Recommended Directionに「Realpath Strategy for Create/Upload Operations」サブセクションが追加されている。nearest-existing-ancestorアプローチ、symlink親ディレクトリのエッジケース（worktree/symlink-to-external/newfile.md）が具体的に記載されている。

**F3-003 (must_fix)**: 「worktreeRoot Symlink Resolution」サブセクションが追加されている。macOS tmpdir()の `/var` -> `/private/var` 問題が説明され、rootDir/worktreeRootにもrealpathSync()を適用する要件が明記されている。moveFileOrDirectory() SEC-006 (lines 546-547) の既存パターンとの整合性も言及されている。

**F3-005 (should_fix)**: 「Implementation Strategy Options」サブセクションにOption A/B/Cが比較検討されている。Option B（新関数）が推奨として明示されている。file-search.tsのlstat()による既存防御の十分性も記載されている。

**F3-006 (should_fix)**: 「Indirect Impact」サブセクションにrepositories/scan APIが記載されている。Option B採用時は影響なしの注記も含まれている。

**F3-007 (should_fix)**: 「Performance Considerations」サブセクションに個別操作API（軽微）とツリー/検索API（不要）の区別が記載されている。推奨戦略としてAPI route層でのみrealpath()検証を適用する方針が明記されている。

**F3-008 (should_fix)**: Acceptance Criteriaに「Internal symlink preservation」項目が追加されている。テストシナリオ7として内部symlink読み取り成功ケースが含まれている。

**F3-009 (should_fix)**: Acceptance Criteriaのテスト項目が10シナリオに具体化されている（外部symlink read/write/delete/rename、外部symlinkディレクトリcreate/upload、内部symlink、dangling symlink、多段symlinkチェーン、worktreeRoot symlink）。

---

## 影響範囲カバレッジ検証

### isPathSafe()呼び出し元の網羅性

ソースコードのgrep結果に基づき、`isPathSafe()`の全呼び出し元を確認した。

| ファイル | 呼び出し箇所 | Issue記載 | 備考 |
|---------|-------------|----------|------|
| `src/lib/file-operations.ts` | lines 230, 267, 305, 381, 464, 520, 580, 643, 680 | 記載済み | 全7関数 + validateFileOperation |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | line 116 | 記載済み | getWorktreeAndValidatePath() |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | line 117 | 記載済み | |
| `src/app/api/worktrees/[id]/tree/[...path]/route.ts` | line 75 | 記載済み (F3-001) | |
| `src/lib/file-search.ts` | lines 265, 298 | 記載済み (F3-005) | |
| `src/app/api/repositories/scan/route.ts` | line 29 | 記載済み (F3-006) | 間接影響 |
| `src/lib/path-validator.ts` | line 101 | 記載済み (F3-010) | validateWorktreePath()内部呼び出し |

**結論**: 全ての`isPathSafe()`呼び出し元がIssueに記載されている。漏れなし。

### worktree APIルートの網羅性

全27個のworktree APIルートを確認した。ファイルシステムアクセスを行うルートのうち、worktreeのファイルパスに対してユーザー入力が影響するものは以下の通り。

| API Route | ファイルアクセス | Issue記載 | 備考 |
|-----------|----------------|----------|------|
| files/[...path] | ユーザー指定パスでread/write/create/delete/rename/move | 記載済み | |
| upload/[...path] | ユーザー指定パスでupload | 記載済み | |
| tree/[...path] | ユーザー指定パスでreadDirectory() | 記載済み (F3-001) | |
| tree/ (root) | worktree rootでreadDirectory() | 影響外 | パスはDB由来、ユーザー入力なし |
| search/ | worktree.pathでsearchWithTimeout() | 記載済み (F3-001) | |
| slash-commands/ | worktree.path/.claude/commands/ | 影響外 | パスはサーバー側構成 |
| logs/[filename] | getLogDir()から読み取り | 影響外 | worktreeパスに非依存 |

**結論**: 影響を受ける全APIルートがIssueに記載されている。漏れなし。

### 実装戦略の一貫性

Issue本文で推奨されているOption B（新関数作成）を採用した場合の影響範囲を検証した。

- `isPathSafe()` 自体は変更されない -> `file-search.ts`、`repositories/scan`、`clone-manager.ts` への副作用なし
- 新関数（例: `isPathSafeWithSymlinkCheck()`）を `path-validator.ts` に追加 -> files/upload/tree APIルートで使用
- `file-operations.ts` の各関数は内部で `isPathSafe()` を呼んでいるため、APIルート層で新関数を適用するか、`file-operations.ts` の各関数内に追加するかの選択が残る

Option B + Recommended Directionの「API route層またはfile-operations.ts関数内でrealpath検証を適用」という記述は一貫している。

### 受け入れ基準と影響範囲の整合性

| 受け入れ基準項目 | 対応する影響範囲 | 整合 |
|----------------|----------------|------|
| Symlink rejection | files/upload/tree/search API | OK |
| Normal path preservation | 全API | OK |
| Internal symlink preservation | 全API (F3-008) | OK |
| Image/video GET paths | files API lines 153, 200-211 (F1-001) | OK |
| Rename protection | files API PATCH + renameFileOrDirectory() (F1-002) | OK |
| Tree API protection | tree API (F3-001) | OK |
| Search API protection | search API (F3-001) | OK |
| Create/upload with symlink parent | files POST + upload POST (F3-002) | OK |
| macOS tmpdir compatibility | 全テスト環境 (F3-003) | OK |
| Existing tests pass | file-operations tests (F3-004) | OK |
| New test coverage (10 scenarios) | 包括的 (F3-009) | OK |

**結論**: 受け入れ基準が影響範囲を完全にカバーしている。

---

## Nice to Have

### F7-001: deleteFileOrDirectory()内のstat()がsymlinkをフォローする動作の補足

**カテゴリ**: 正確性
**場所**: Affected Code > File operations セクション

**問題**:
`file-operations.ts` の `deleteFileOrDirectory()` line 398 で `const fileStat = await stat(fullPath)` を使用している。`stat()` は `lstat()` と異なりsymlinkを自動解決する。ただし、Node.jsの `rm()` はsymlink自体を削除する（symlink先の実体を削除するわけではない）ため、この動作の実質的なセキュリティ影響は、`isPathSafe()` バイパスの問題に集約される。

Issue本文では `deleteFileOrDirectory() (line 375)` として既に言及されており、`isPathSafe()` バイパスの観点は正しくカバーされている。`readDirectory()` の `stat()` vs `lstat()` はF5-002で補足済みであるが、`deleteFileOrDirectory()` の `stat()` に関する同様の補足は追加されていない。

**推奨対応**:
実装時に認識しておく程度で十分。Issue本文への追記は不要。

---

## 参照ファイル

### コード（影響範囲確認済み）

| ファイル | 影響 |
|---------|------|
| `src/lib/path-validator.ts` | 修正対象のコアバリデーター |
| `src/lib/file-operations.ts` | 修正対象。全7関数が影響 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 修正対象。画像/動画直接readFile()含む |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | 修正対象 |
| `src/app/api/worktrees/[id]/tree/[...path]/route.ts` | 修正対象 (F3-001) |
| `src/app/api/worktrees/[id]/search/route.ts` | Option B時は変更不要 (F3-001) |
| `src/lib/file-tree.ts` | Option B時は変更不要。既存lstat()防御で十分 |
| `src/lib/file-search.ts` | Option B時は変更不要。既存lstat()防御で十分 |
| `src/app/api/repositories/scan/route.ts` | Option B時は影響なし (F3-006) |
| `src/lib/clone-manager.ts` | Option B時は影響なし (F3-010) |
| `src/lib/cli-tools/opencode-config.ts` | 独自realpath検証あり。isPathSafe()非依存 |

### 影響外と判断したAPIルート

| ファイル | 理由 |
|---------|------|
| `src/app/api/worktrees/[id]/tree/route.ts` | worktree rootのみ。ユーザー入力パスなし |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | パスはサーバー側構成(.claude/commands/) |
| `src/app/api/worktrees/[id]/logs/[filename]/route.ts` | ログ専用ディレクトリ。worktreeパス非依存 |

---

## 総合評価

**品質**: good

Issue #394は4回のレビューイテレーションを通じて、以下の品質基準を全て満たしている。

1. **影響範囲の完全性**: 全isPathSafe()呼び出し元と全関連APIルートが網羅されている
2. **実装戦略の一貫性**: Option A/B/Cが比較検討され、推奨案(B)が他の指摘事項と矛盾しない
3. **受け入れ基準の網羅性**: 10テストシナリオが影響範囲の全側面をカバーしている
4. **エッジケースの考慮**: create/upload時のrealpath戦略、macOS tmpdir互換性、内部symlink保持が記載されている
5. **パフォーマンス考慮**: tree/search APIへのrealpath()追加回避の方針が明記されている
6. **後方互換性**: 破壊的変更の有無と対策が記載されている
7. **ドキュメント更新**: 修正後のドキュメント更新計画が記載されている

**実装着手を推奨する。**
