# Issue #394 Stage 1 レビューレポート

**レビュー日**: 2026-03-02
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**レビュー対象**: security: symlink traversal in file APIs allows access outside worktree root

---

## サマリー

Issue #394はセキュリティ脆弱性として高品質にまとめられている。Root Causeの分析、影響範囲の特定、再現手順の記述はすべてコードベースの実態と整合している。仮説検証により全5項目がConfirmedとなった。

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 4 |

**総合品質**: Good

---

## Should Fix（推奨対応）

### F1-001: GETエンドポイントの画像・動画処理におけるreadFile()直接呼び出しが影響コードに未記載

**カテゴリ**: 完全性
**場所**: Affected Code > Key references セクション

**問題**:
GET `/api/worktrees/:id/files/:path` では、画像ファイル（`route.ts:153`行）と動画ファイル（`route.ts:200`行）に対して`readFile()`を直接呼び出している。これらは`readFileContent()`を経由しないため、`file-operations.ts`の`isPathSafe()`チェックを通らず、`route.ts`内の`getWorktreeAndValidatePath()`の`isPathSafe()`のみが防御ラインとなる。

Issueの「Key references」には`route.ts:153`は記載されているが、この箇所が`readFileContent()`とは異なる別の脆弱なコードパスであることが明示されていない。

**証拠**:
```typescript
// src/app/api/worktrees/[id]/files/[...path]/route.ts:153
const absolutePath = join(worktree.path, relativePath);
// ...
const fileBuffer = await readFile(absolutePath);  // readFileContent()を経由しない

// src/app/api/worktrees/[id]/files/[...path]/route.ts:200
const absolutePath = join(worktree.path, relativePath);
// ...
const fileBuffer = await readFile(absolutePath);  // 同様にreadFileContent()を経由しない
```

**推奨対応**:
`route.ts:153`と`route.ts:200-211`の画像・動画処理パスが`readFileContent()`を経由しない独立した脆弱コードパスであることを明記する。修正時にこの箇所も確実に保護する必要があるため、影響コードのセクションで明確に区別すべき。

---

### F1-002: renameFileOrDirectory()のソースパスに対するsymlink脆弱性が未言及

**カテゴリ**: 完全性
**場所**: Affected Code > File operations セクション

**問題**:
Issueでは`moveFileOrDirectory()`のSEC-006（destination）の`realpathSync()`検証に言及しているが、`renameFileOrDirectory()`（`file-operations.ts:618-662`）がソースパスに対して`realpathSync()`を呼んでいないことに触れていない。

**証拠**:
```typescript
// src/lib/file-operations.ts:618-662
export async function renameFileOrDirectory(
  worktreeRoot: string,
  relativePath: string,
  newName: string
): Promise<FileOperationResult> {
  const sourceValidation = validateFileOperation(worktreeRoot, relativePath);
  // validateFileOperation() は isPathSafe() のみ使用
  // realpathSync() は呼び出されない
  // ...
  await rename(fullPath, newFullPath);  // symlinkを追跡する
}
```

**推奨対応**:
`renameFileOrDirectory()`もソースパスのsymlink検証が欠如していることを影響範囲に明記する。

---

### F1-003: 既存のsymlink対策パターン（file-tree.ts, file-search.ts）への参照がない

**カテゴリ**: 修正方針
**場所**: Recommended Direction セクション

**問題**:
コードベースには既に複数のsymlink対策が存在するが、Recommended Directionで言及されていない:

1. `src/lib/file-tree.ts:182` -- `lstat()`による`isSymbolicLink()`チェックでsymlinkをスキップ
2. `src/lib/file-search.ts:306` -- 同様のsymlinkスキップ
3. `src/lib/cli-tools/opencode-config.ts:185` -- `lstatSync()`によるsymlink検出

**証拠**:
```typescript
// src/lib/file-tree.ts:178-184
const entryStat = await lstat(entryPath);
if (entryStat.isSymbolicLink()) {
  continue;  // symlinkをディレクトリ一覧から除外
}
```

**推奨対応**:
修正方針に既存パターンの参照を追加し、以下の2アプローチの比較・選定理由を記載する:
- **Approach A**: `realpath()`による解決パス検証（Issueの現在の提案）
- **Approach B**: `lstat()`によるsymlinkエントリ自体の拒否（file-tree.ts/file-search.tsのパターン）

`file-tree.ts`がsymlinkをスキップしていることは、UI経由ではsymlinkターゲットを選択できないことを意味するが、直接APIを叩く攻撃は防げない。

---

## Nice to Have（あれば良い）

### F1-004: 修正の集約ポイント（isPathSafe vs 各関数）の設計判断が未記載

**カテゴリ**: 修正方針
**場所**: Recommended Direction セクション

**問題**:
修正を`isPathSafe()`に集約するか各ファイル操作関数に分散するかの設計判断基準が記載されていない。

**検討すべき3つのアプローチ**:
| アプローチ | 利点 | 課題 |
|-----------|------|------|
| `isPathSafe()`に統合 | 一箇所の修正で全操作を保護 | 存在しないパス（create/upload）では`realpath()`が使えない |
| 各関数に分散 | 操作ごとの柔軟な制御 | 漏れリスクが高い |
| SEC-006パターンの横展開 | 実績あるパターン | コード重複 |

**推奨対応**:
設計判断の基準を記載し、実装者が迷わず着手できるようにする。

---

### F1-005: 受け入れ基準（Validation Notes）が検証手順のみで合格基準が不明確

**カテゴリ**: 受け入れ基準
**場所**: Validation Notes セクション

**問題**:
Validation Notesは「動的検証に含めるべきこと」として4項目を挙げているが、合否判定基準が明示されていない。

**推奨対応**:
以下のような具体的な受け入れ基準を追加する:
1. worktree外を指すsymlinkを含むパスへのGET/PUT/POST/DELETE/PATCH/Upload要求が`INVALID_PATH`エラーで拒否される
2. symlinkを含まない通常パスへのアクセスが引き続き正常動作する
3. `moveFileOrDirectory()`の既存SEC-006テストが引き続きパスする
4. 新規テストケースが追加される（最低限: read/write/delete/uploadの各操作でsymlink拒否を確認）

---

### F1-006: 脅威モデルの前提条件（攻撃者がsymlinkを配置できる条件）が未記載

**カテゴリ**: 完全性
**場所**: Summary / Example Exploit セクション

**問題**:
攻撃者がworktree内にsymlinkを配置できる条件の前提が明示されていない。

**考えられるシナリオ**:
1. **gitリポジトリ内symlink**（最も現実的）: `git clone`や`git worktree add`でsymlinkが自動展開
2. サーバーに直接アクセスできるユーザーが手動でsymlink作成
3. POST APIではmkdirを使用するためsymlink作成は不可

**推奨対応**:
脅威モデルの前提条件を明記することで、修正の優先度判断に役立てる。

---

### F1-007: moveFileOrDirectory()のsymlink保護範囲の正確性

**カテゴリ**: 正確性
**場所**: Important Observation セクション

**問題**:
`moveFileOrDirectory()`のsymlink検証が「destination directoryのバウンダリチェック」と「source pathのrealpathSync（MOVE_SAME_PATH判定用のみ）」に限定されている。source pathが実際にworktree外を指すsymlinkである場合のバウンダリ逸脱チェックは行われていない。

**証拠**:
```typescript
// file-operations.ts:564-565 - MOVE_SAME_PATHチェック用のみ
resolvedSourceReal = realpathSync(resolvedSource);
// ↑ これはバウンダリチェックではなく同一パス判定用
// source pathがworktree外を指すsymlinkかどうかは検証していない
```

**推奨対応**:
Important Observationの記述をより正確にし、moveの保護が「destination directoryのみ」であることを明示する。

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 |
|---------|--------|--------|
| `src/lib/path-validator.ts` | 29-68 | `isPathSafe()`の実装 -- レキシカルパス正規化のみ |
| `src/lib/file-operations.ts` | 225-251 | `readFileContent()` -- `isPathSafe()`のみ使用 |
| `src/lib/file-operations.ts` | 261-287 | `updateFileContent()` -- `isPathSafe()`のみ使用 |
| `src/lib/file-operations.ts` | 298-335 | `createFileOrDirectory()` -- `isPathSafe()`のみ使用 |
| `src/lib/file-operations.ts` | 375-436 | `deleteFileOrDirectory()` -- `isPathSafe()`のみ使用 |
| `src/lib/file-operations.ts` | 544-553 | `moveFileOrDirectory()` SEC-006 -- `realpathSync()`あり（destinationのみ） |
| `src/lib/file-operations.ts` | 618-662 | `renameFileOrDirectory()` -- `isPathSafe()`のみ、`realpathSync()`なし |
| `src/lib/file-operations.ts` | 674-709 | `writeBinaryFile()` -- `isPathSafe()`のみ使用 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 96-123 | `getWorktreeAndValidatePath()` -- `isPathSafe()`のみ |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 153, 200 | GETの画像・動画`readFile()`直接呼び出し |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | 113-119, 189 | Upload `isPathSafe()`検証 |
| `src/lib/file-tree.ts` | 178-184 | 既存symlink対策: `lstat()` + `isSymbolicLink()` スキップ |
| `src/lib/file-search.ts` | 306 | 既存symlink対策: `isSymbolicLink()` スキップ |
| `tests/unit/lib/file-operations-move.test.ts` | 169-191 | 既存symlinkテスト: SEC-006 destination検証 |

---

## 総合評価

Issue #394は技術的に正確で、セキュリティ脆弱性の記述として十分な品質を持つ。Must Fixの指摘はなく、3件のShould Fix（影響コードの完全性、rename関数の漏れ、既存パターンとの整合性）と4件のNice to Have（修正方針の設計判断、受け入れ基準の具体化、脅威モデル、move保護の正確性）を反映することで、実装者が迷いなく修正に着手できるIssueとなる。
