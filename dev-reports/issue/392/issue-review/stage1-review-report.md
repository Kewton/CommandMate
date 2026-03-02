# Issue #392 Stage 1 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（Consistency & Correctness）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 5 |
| Nice to Have | 3 |

Issue #392 の主張は技術的に正確であり、仮説検証で全5点が Confirmed されている。根本原因の特定、再現シナリオ、推奨方向性のいずれも妥当である。Must Fix レベルの誤りは検出されなかった。主な改善点は、(1) 既存 `validateWorktreePath()` 関数の活用を修正方針に明示すること、(2) `executeClone` 内の `mkdirSync` や `onCloneSuccess` での DB 登録など影響範囲の網羅的記載、(3) `route.ts` 層の入力サニタイズ、(4) 具体的なテスト要件の追加である。

---

## Should Fix（推奨対応）

### F-001: 修正方針で既存の validateWorktreePath() 関数の活用を明示すべき

**カテゴリ**: 完全性
**場所**: Issue本文 ## Recommended Direction セクション

**問題**:
Issue の Recommended Direction では `path.resolve()` による手動カノニカル化を提案しているが、`src/lib/path-validator.ts` には既に `validateWorktreePath()` 関数が存在する。この関数は `isPathSafe()` による検証と `path.resolve()` によるカノニカル化の両方を一括で行い、解決済み絶対パスを返す設計になっている（L89-117）。

**証拠**:
```typescript
// path-validator.ts:89-117
export function validateWorktreePath(targetPath: string, rootDir: string): string {
  if (!targetPath || targetPath.trim() === '') {
    throw new Error('Invalid path: Path cannot be empty');
  }
  if (targetPath.includes('\x00')) {
    throw new Error('Invalid path: Null bytes not allowed');
  }
  if (!isPathSafe(targetPath, rootDir)) {
    throw new Error(`Path is outside allowed directory: ${targetPath} (allowed root: ${rootDir})`);
  }
  let decodedPath = targetPath;
  try { decodedPath = decodeURIComponent(targetPath); } catch { decodedPath = targetPath; }
  return path.resolve(rootDir, decodedPath);  // <-- 解決済み絶対パスを返す
}
```

**推奨対応**:
修正方針を「`isPathSafe()` を `validateWorktreePath(customTargetPath, this.config.basePath!)` に置き換え、返り値の解決済みパスを `targetPath` として使用する」に具体化する。これにより検証とカノニカル化が単一関数呼び出しで完結する。

---

### F-002: executeClone 内の mkdirSync による親ディレクトリ作成リスクへの言及不足

**カテゴリ**: 完全性
**場所**: Issue本文 ## Affected Code / ## Impact セクション

**問題**:
`clone-manager.ts:382-385` の `executeClone()` 内で、未解決 `targetPath` の親ディレクトリを `mkdirSync(parentDir, { recursive: true })` で作成している。未解決相対パスの場合、`process.cwd()` 基準で任意のディレクトリ構造が作成される。

**証拠**:
```typescript
// clone-manager.ts:382-385
const parentDir = path.dirname(targetPath);
if (!existsSync(parentDir)) {
  mkdirSync(parentDir, { recursive: true });
}
```

**推奨対応**:
Impact セクションに「`executeClone()` 内の `mkdirSync(parentDir, { recursive: true })` により、`CM_ROOT_DIR` 外に任意のディレクトリ構造が作成される」ことを追記する。

---

### F-003: onCloneSuccess での DB 登録時の影響が未記載

**カテゴリ**: 完全性
**場所**: Issue本文 ## Impact セクション

**問題**:
`clone-manager.ts:479-515` の `onCloneSuccess()` では、未解決の `targetPath` が `createRepository()` の `path` フィールドおよび `name`（`path.basename(targetPath)`）として DB に保存される。さらに `scanWorktrees(targetPath)` で `CM_ROOT_DIR` 外のディレクトリをスキャンし worktree として登録する。DB 内に不正なパスが永続化されると、後続の操作（ファイル表示、セッション管理等）で `CM_ROOT_DIR` 外のパスが操作対象となる。

**証拠**:
```typescript
// clone-manager.ts:488-500
const repo = createRepository(this.db, {
  name: path.basename(targetPath),  // 未解決パスのbasenameがDB登録される
  path: targetPath,                  // 未解決パスがそのままDB登録される
  ...
});
const worktrees = await scanWorktrees(targetPath);  // CM_ROOT_DIR外をスキャン
```

**推奨対応**:
Impact に「DB に不正パスが永続化され、後続 API 操作で `CM_ROOT_DIR` 外のファイルシステムが操作対象となる二次リスク」を追記する。

---

### F-004: route.ts での targetDir 入力サニタイズ不足への言及

**カテゴリ**: 完全性
**場所**: `src/app/api/repositories/clone/route.ts:96`

**問題**:
`route.ts:96` で `targetDir` は `trim()` されずにそのまま `startCloneJob()` に渡される（`cloneUrl` は `trim()` されている）。また `targetDir` が空文字列の場合の処理が定義されていない。空文字列は `isPathSafe()` で `false` を返すため即座にバイパスにはならないが、一貫した入力バリデーションの観点から問題がある。

**証拠**:
```typescript
// route.ts:96
const result = await cloneManager.startCloneJob(cloneUrl.trim(), targetDir);
//                                              ^^^^^^^^^^^^^^   ^^^^^^^^^
//                                              trimされている    trimされていない
```

**推奨対応**:
`route.ts` 側でも `targetDir` に対する `trim()` 処理と空文字チェックを追加することを推奨事項に含める。

---

### F-005: テスト要件が具体的に記載されていない

**カテゴリ**: テストカバレッジ
**場所**: Issue本文 ## Validation Notes セクション

**問題**:
Validation Notes では動的検証の3項目のみ記載されているが、修正後に必要となる具体的なテストケースが定義されていない。既存テスト（`tests/unit/lib/clone-manager.test.ts:208-225`）では絶対パスの `customPath`（`'/tmp/repos/custom/target/path'`）でのテストのみ存在し、相対パスでの `customTargetPath` テストが欠如している。

**証拠**:
```typescript
// 既存テスト - 絶対パスのみテスト
it('should use custom target path if provided (within basePath)', async () => {
  const customPath = '/tmp/repos/custom/target/path';  // 絶対パス
  const result = await cloneManager.startCloneJob(
    'https://github.com/test/custompath.git',
    customPath
  );
  expect(job?.targetPath).toBe(customPath);
});
```

**推奨対応**:
以下のテストケースを受け入れ条件として明記する:
1. 相対パスの `customTargetPath` が `basePath` 基準で解決されること
2. 解決済みパスが `existsSync`/`createCloneJob`/`executeClone` の全てで使用されること
3. DB に保存される `targetPath` が絶対パスであること
4. `mkdirSync` で作成される親ディレクトリが `basePath` 配下であること
5. path traversal を含む相対パス（例: `'../escape'`）が拒否されること

---

## Nice to Have（あれば良い）

### F-006: Severity の根拠に攻撃前提条件の記載がない

**カテゴリ**: 明確性
**場所**: Issue本文 ## Severity セクション

**問題**:
Severity を「High」と評価しているが、攻撃の前提条件に関する記載がない。`CM_AUTH_TOKEN_HASH` による認証が有効な場合は認証済みユーザーのみが API を呼び出せるため攻撃可能性は低下する。一方、認証未設定時は未認証アクセスが可能。

**推奨対応**:
認証有効時/無効時の攻撃シナリオの違いと、それぞれのリスクレベルを補足する。

---

### F-007: getTargetPath() の安全性の明記

**カテゴリ**: 完全性
**場所**: Issue本文 ## Root Cause セクション Step 1

**問題**:
`customTargetPath` が未指定の場合、`getTargetPath(repoName)` が `path.join(this.config.basePath!, repoName)` で絶対パスを返すため安全である。Issue はこの安全なケースと脆弱なケースを対比して明示していない。

**推奨対応**:
`getTargetPath()` 分岐は安全である旨を明記し、脆弱性が `customTargetPath` 分岐に限定されることを明確にする。

---

### F-008: validateWorktreePath() のエラーメッセージにおける basePath 漏洩リスク

**カテゴリ**: 明確性
**場所**: `src/lib/path-validator.ts:102-104`, `src/lib/clone-manager.ts:341-342`

**問題**:
`validateWorktreePath()` のエラーメッセージには `rootDir` の値が含まれる。現在の実装では `isPathSafe()` + 定型エラー（D4-001）で `basePath` 漏洩を防いでいる。`validateWorktreePath()` に移行する場合、例外メッセージのクライアント露出に注意が必要。

**推奨対応**:
`validateWorktreePath()` の `try-catch` で例外をキャッチし、クライアントには定型エラーメッセージ（`ERROR_DEFINITIONS.INVALID_TARGET_PATH`）を返す設計とすることを修正方針に含める。

---

## 参照ファイル

### コード
| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/lib/clone-manager.ts` | 301-367, 374-474, 479-515 | 脆弱性の主要箇所（startCloneJob, executeClone, onCloneSuccess） |
| `src/lib/path-validator.ts` | 29-68, 89-117 | isPathSafe() と validateWorktreePath() の実装 |
| `src/app/api/repositories/clone/route.ts` | 49-96 | API エンドポイント（targetDir の入力バリデーション） |
| `src/lib/env.ts` | 252 | CM_ROOT_DIR の path.resolve() による絶対パス化確認 |
| `tests/unit/lib/clone-manager.test.ts` | 208-235 | 既存の customTargetPath テスト |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | path-validator.ts, clone-manager.ts のモジュール説明との整合性確認 |
