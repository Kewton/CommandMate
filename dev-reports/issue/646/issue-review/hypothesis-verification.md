# Issue #646 仮説検証レポート

## 検証対象

Issue: ファイル編集強化（YAML ファイル編集・拡張子選択対応）

---

## 仮説・前提条件の照合結果

### H1: `EDITABLE_EXTENSIONS` は `.md` / `.html` / `.htm` の 3 種のみ

**判定**: Confirmed（確認済み）

`src/config/editable-extensions.ts` の `EDITABLE_EXTENSIONS`:
```ts
export const EDITABLE_EXTENSIONS: readonly string[] = ['.md', '.html', '.htm'] as const;
```
事実と完全一致。

---

### H2: `isYamlSafe()` が `src/config/uploadable-extensions.ts` に実装済み

**判定**: Confirmed（確認済み）

`src/config/uploadable-extensions.ts` にて `isYamlSafe()` が実装済み（行 190 付近）:
```ts
export function isYamlSafe(content: string): boolean {
  const dangerousTags = [
    /!ruby\/object/i,
    /!python\/object/i,
    /!!python/i,
    /!!ruby/i,
    /!<tag:yaml\.org,2002:python/i,
    /!<tag:yaml\.org,2002:ruby/i,
  ];
  return !dangerousTags.some((pattern) => pattern.test(content));
}
```

**補足**: `isYamlSafe()` は危険なデシリアライゼーションタグのみをブロックし、YAML 構文の正当性は検証しない。これは Issue の記述の通り。

---

### H3: `WorktreeDetailRefactored.tsx:787` で `.md` が強制付与される

**判定**: Confirmed（確認済み）

実際のコード（行 787）:
```ts
const finalName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
```
Issue の記載と完全一致。

---

### H4: PUT/POST ハンドラが `isEditableExtension()` を参照している

**判定**: Confirmed（確認済み）

`src/app/api/worktrees/[id]/files/[...path]/route.ts` にて:
- 行 30: `isEditableFile` をインポート
- 行 32: `validateContent, isEditableExtension` をインポート
- 行 338: `if (!isEditableFile(relativePath))` でPUTハンドラが拡張子チェック
- 行 401: `if (isEditableExtension(ext))` でコンテンツバリデーション分岐

`isEditableFile()` は `isEditableExtension()` を内部で呼び出す（`src/lib/file-operations.ts:168`）。
拡張子を追加すれば API 側は自動的に対応されるという主張は正確。

---

### H5: YAML ファイルの閲覧は `FilePanelContent.tsx` の `CodeViewer` で可能

**判定**: Confirmed（確認済み）

`src/components/worktree/FilePanelContent.tsx` に `CodeViewer` コンポーネントが定義されており（行 223）、シンタックスハイライト付きコードビューとして機能する。YAML のデフォルト表示パスに利用可能。

---

## サマリー

| # | 仮説/前提条件 | 判定 |
|---|--------------|------|
| H1 | `EDITABLE_EXTENSIONS` が `.md/.html/.htm` のみ | Confirmed |
| H2 | `isYamlSafe()` が `uploadable-extensions.ts` に実装済み | Confirmed |
| H3 | `WorktreeDetailRefactored.tsx:787` で `.md` 強制付与 | Confirmed |
| H4 | API は `isEditableExtension()` 参照（拡張子追加で自動対応） | Confirmed |
| H5 | YAML 閲覧は `CodeViewer` で対応可能 | Confirmed |

**全仮説 Confirmed** — Issue に記載されたコードベースの事実はすべて正確。

---

## Stage 1 レビューへの申し送り

- Rejected な仮説なし
- `isYamlSafe()` は構文バリデーションではなくセキュリティフィルタのみ。YAML 構文エラー時のユーザーへのフィードバック設計について Issue に明示するとよい
- `EXTENSION_VALIDATORS` への追加忘れリスクあり（`EDITABLE_EXTENSIONS` と `EXTENSION_VALIDATORS` は別配列で管理されているため同期が必要）
