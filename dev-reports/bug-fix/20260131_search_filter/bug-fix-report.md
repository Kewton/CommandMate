# バグ修正レポート: ファイルツリー検索フィルタリング

## 不具合概要

**日時**: 2026-01-31
**重大度**: High
**関連Issue**: #21 (ファイルツリー検索機能)

### 症状
ファイル名/コンテンツ検索で、検索結果が対象ファイルだけでなく、マッチしたファイルが存在するディレクトリ配下の**全ファイル**が表示されてしまう。

### 期待動作
- **Name検索**: 検索クエリにマッチするファイル名のアイテムのみ表示
- **Content検索**: `matchedPaths`に含まれるパスのアイテムのみ表示

---

## 根本原因

`FileTreeView.tsx`の`TreeNode`コンポーネント内で、展開されたディレクトリの子アイテム（`children`）にフィルタリングが適用されていなかった。

### 問題箇所
```tsx
// 修正前: children をそのまま全て表示
{children.map((child) => (
  <TreeNode ... />
))}
```

- `filteredRootItems`はルートレベルのみフィルタリング
- 子アイテムはフィルタリングなしで全て表示

---

## 修正内容

`TreeNode`コンポーネント内の`children.map()`の前にフィルタリングロジックを追加。

### 修正ファイル
- `src/components/worktree/FileTreeView.tsx` (341-400行目)

### 修正内容
```tsx
{children
  .filter((child) => {
    const childFullPath = fullPath ? `${fullPath}/${child.name}` : child.name;

    // No filtering if no search query
    if (!searchQuery?.trim()) {
      return true;
    }

    // Name search: filter by name match
    if (searchMode === 'name') {
      const lowerQuery = searchQuery.toLowerCase();
      if (child.name.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      // Show directories to allow expansion
      if (child.type === 'directory') {
        return true;
      }
      return false;
    }

    // Content search: filter by matchedPaths
    if (searchMode === 'content' && matchedPaths && matchedPaths.size > 0) {
      if (matchedPaths.has(childFullPath)) {
        return true;
      }
      // Show directories if they contain matched paths
      if (child.type === 'directory') {
        for (const path of matchedPaths) {
          if (path.startsWith(childFullPath + '/')) {
            return true;
          }
        }
      }
      return false;
    }

    return true;
  })
  .map((child) => (
    <TreeNode ... />
  ))}
```

---

## 検証結果

| チェック項目 | 結果 |
|-------------|------|
| TypeScript型チェック | ✅ エラーなし |
| ESLint | ✅ エラーなし |
| ユニットテスト | ✅ 2164件パス |
| ビルド | ✅ 成功 |
| サーバー再起動 | ✅ HTTP 200 |

---

## 動作確認手順

1. http://localhost:3000 にアクセス
2. worktreeを選択してFilesタブを開く
3. 検索バーに検索クエリを入力
4. **Name検索**: マッチするファイル名のみ表示されることを確認
5. **Content検索**: マッチしたファイルのみ表示されることを確認

---

## 今後の改善点

- Name検索時、ディレクトリは常に表示される（ネストされたマッチ発見のため）
  - 将来的にキャッシュを活用して、マッチする子孫がないディレクトリを非表示にする最適化が可能
