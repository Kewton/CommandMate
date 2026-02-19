# Issue #300 レビューレポート

**レビュー日**: 2026-02-18
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目（Stage 1）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

**総合評価**: needs_improvement

Issue #300 は「ルートディレクトリにディレクトリを追加出来ない」というバグを正しく特定していますが、再現手順に事実誤認があり、根本原因の仮説がバックエンドロジック（path-validator, file-operations）に偏っています。実際の根本原因はフロントエンド（FileTreeView.tsx）のUI欠落であることが仮説検証で確認されており、Issue本文の仮説・対策案・影響範囲を修正する必要があります。

---

## Must Fix（必須対応）

### MF-1: 再現手順が実際の動作と矛盾している

**カテゴリ**: 正確性
**場所**: ## 再現手順 セクション（ステップ3）

**問題**:
再現手順のステップ3に「ルートレベルの New Directory ボタンをクリックする」とありますが、このボタンは `rootItems.length === 0`（空状態）のときのみ表示されます。ステップ2で「1つ以上のディレクトリが既に存在する状態にする」と指示しているため、ステップ3のボタンは画面上に存在しません。

**証拠**:
`src/components/worktree/FileTreeView.tsx:827-861`:
```typescript
// Empty state
if (rootItems.length === 0) {
  return (
    <div data-testid="file-tree-empty" ...>
      <p className="text-sm">No files found</p>
      {(onNewFile || onNewDirectory) && (
        <div className="flex flex-col gap-2 mt-4">
          {/* ... New File button ... */}
          {onNewDirectory && (
            <button data-testid="empty-new-directory-button"
              onClick={() => onNewDirectory('')}
              ...>
              <FolderPlus ... />
              <span>New Directory</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

非空状態のツリー描画（L877-919）にはNew Directoryボタンが含まれていません。

**推奨対応**:
再現手順を以下のように修正:
1. Worktree詳細画面でファイルツリーを表示する
2. ルートディレクトリに1つ以上のディレクトリが既に存在する状態にする
3. ルートレベルに新しいディレクトリを作成しようとする
4. **New Directoryボタンが表示されていないため、操作手段がない**
5. コンテキストメニューの「New Directory」は右クリックした対象ディレクトリの配下にのみ作成される

---

### MF-2: 根本原因の仮説がバックエンドに偏っている

**カテゴリ**: 正確性
**場所**: ## 根本原因の仮説 セクション

**問題**:
3つの仮説が全てバックエンドロジック（isPathSafe, existsSync, getWorktreeAndValidatePath）に焦点を当てていますが、仮説検証の結果:

- **仮説1（isPathSafe）**: `isPathSafe('newdir', root)` は `true` を返し正常動作。根本原因ではない。
- **仮説2（existsSync）**: 対象パスのみをチェックしており正常動作。検証により **棄却（Rejected）**。
- **仮説3（encodeURIComponent）**: ルートレベル作成では `parentPath=''` のため影響なし（ネストパスでは別の問題あり）。

実際の根本原因は仮説検証レポートの **仮説4（追加発見）** として確認された「非空状態でのルートレベルNew Directory UIの欠落」です。

**証拠**:
仮説検証レポート（`dev-reports/issue/300/issue-review/hypothesis-verification.md`）の判定結果:
- 仮説1: Partially Confirmed（根本原因ではない）
- 仮説2: **Rejected**
- 仮説3: Partially Confirmed（ルートレベルでは影響なし）
- 仮説4: **Confirmed**（UI問題が根本原因）

**推奨対応**:
仮説の優先順位を再構成し、UI欠落を主要仮説として記載。バックエンド仮説は削除するか補足情報として記載。

---

## Should Fix（推奨対応）

### SF-1: encodeURIComponentの二次的問題が不十分に記載

**カテゴリ**: 完全性
**場所**: ## 根本原因の仮説 セクション（仮説3）

**問題**:
コンテキストメニュー経由でサブディレクトリ内に新規作成する場合、`encodeURIComponent` がスラッシュを `%2F` にエンコードする問題があります。この問題はIssue本文で仮説3として触れていますが、具体的な影響が不明確です。

`WorktreeDetailRefactored.tsx:1275-1279`:
```typescript
const newPath = parentPath ? `${parentPath}/${dirName}` : dirName;
// parentPath='src', dirName='newdir' の場合:
// newPath = 'src/newdir'
// encodeURIComponent('src/newdir') = 'src%2Fnewdir'
// URL: /api/worktrees/{id}/files/src%2Fnewdir
```

Next.js catch-all route `[...path]` では `%2F` を含む単一セグメントとして `params.path = ['src%2Fnewdir']` と解釈される可能性があります。この場合、`pathSegments.join('/')` が `'src%2Fnewdir'` を返し、`normalize()` では復号されません。

**推奨対応**:
Issue本文に以下を明記:
- `encodeURIComponent` はスラッシュもエンコードするため、ネストパスに使用すると不正なURLセグメントが生成される
- 修正案: パスセグメントを個別にエンコードしてスラッシュで結合する（例: `newPath.split('/').map(encodeURIComponent).join('/')`）

---

### SF-2: 影響範囲の変更対象ファイルが不正確

**カテゴリ**: 完全性
**場所**: ## 影響範囲 セクション

**問題**:
変更対象ファイル一覧で `path-validator.ts` と `file-operations.ts` が上位に記載されていますが、仮説検証で両方とも正常動作が確認されており変更不要です。一方、根本原因の `FileTreeView.tsx` は「関連コンポーネント」として下位に記載されています。

**推奨対応**:
変更対象ファイルを以下のように修正:

| ファイル | 変更内容 | 優先度 |
|---------|---------|----|
| `src/components/worktree/FileTreeView.tsx` | 非空状態でのルートレベルNew Directory/New Fileツールバー追加 | 高 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | encodeURIComponentのネストパス対応 | 中 |
| `tests/unit/components/worktree/FileTreeView.test.tsx` | 非空状態でのボタン表示テスト追加 | 中 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | %2Fを含むセグメントの処理確認 | 低 |

`src/lib/path-validator.ts` と `src/lib/file-operations.ts` は変更対象から除外。

---

### SF-3: 対策案が具体的な修正方針を含んでいない

**カテゴリ**: 明確性
**場所**: ## 対策案 セクション

**問題**:
対策案3項目が全て調査・確認フェーズの内容（エラーレスポンス確認、パス検証修正、エラーハンドリング改善）であり、UIの修正という本質的な対策が含まれていません。

**推奨対応**:
以下のような具体的な修正方針を対策案に追加:

1. **FileTreeView.tsxにツールバー追加**: `filteredRootItems.map(...)` の描画部分（L877-919）の上部に、ルートレベルの「New File」「New Directory」ボタンを含むツールバーを追加する
2. **encodeURIComponent修正**: `WorktreeDetailRefactored.tsx` の `handleNewFile` / `handleNewDirectory` で、パスの各セグメントを個別にエンコードする
3. **テスト追加**: 非空状態でのボタン表示とクリック動作のテストを追加

---

## Nice to Have（あれば良い）

### NTH-1: 受け入れ条件が明示されていない

**カテゴリ**: 完全性
**場所**: Issue本文全体

**推奨対応**:
以下の受け入れ条件を追加:
- [ ] 非空状態のルートディレクトリでNew Directoryボタンが表示される
- [ ] そのボタンからルートレベルにディレクトリを作成できる
- [ ] 同名ディレクトリが存在する場合のみFILE_EXISTSエラーとなる
- [ ] 既存のNew Fileボタンも同様に非空状態で利用可能
- [ ] コンテキストメニューからのサブディレクトリ作成が引き続き正常動作する

---

### NTH-2: New Fileボタンも同様の問題がある

**カテゴリ**: 完全性
**場所**: ## 概要 セクション

**推奨対応**:
`FileTreeView.tsx:827-861` の条件分岐は New File ボタンと New Directory ボタンの両方に影響します。Issue概要にNew Fileも同様の問題がある旨を記載し、修正スコープを明確にすべきです。

---

## 参照ファイル

### コード（根本原因関連）
- `src/components/worktree/FileTreeView.tsx:827-861` -- 空状態でのみNew Directory/New Fileボタンを表示する条件分岐（根本原因）
- `src/components/worktree/FileTreeView.tsx:877-919` -- 非空状態のツリー描画部分（修正対象）
- `src/components/worktree/WorktreeDetailRefactored.tsx:1271-1295` -- handleNewDirectory関数（encodeURIComponent問題）
- `src/components/worktree/WorktreeDetailRefactored.tsx:1242-1268` -- handleNewFile関数（同様の問題）
- `src/components/worktree/ContextMenu.tsx:100-108` -- handleItemClick（コンテキストメニューのパス渡し）

### コード（正常動作確認済み・変更不要）
- `src/lib/path-validator.ts:29-68` -- isPathSafe関数（正常動作）
- `src/lib/file-operations.ts:298-335` -- createFileOrDirectory関数（正常動作）
- `src/app/api/worktrees/[id]/files/[...path]/route.ts:96-123` -- getWorktreeAndValidatePath（パス処理）

### ドキュメント
- `CLAUDE.md` -- FileTreeView, ContextMenu, WorktreeDetailRefactoredの機能説明

### 仮説検証
- `dev-reports/issue/300/issue-review/hypothesis-verification.md` -- 仮説1-4の検証結果
