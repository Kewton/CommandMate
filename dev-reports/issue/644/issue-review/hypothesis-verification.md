# Issue #644 仮説検証レポート

## 検証対象
Issue #644: feat(repositories): リポジトリ一覧表示と別名編集UI

## 検証結果サマリー

全6つの前提条件を検証。全て **Confirmed**（正確）。

---

## 前提条件の検証

### H-1: `/repositories` 画面は `RepositoryManager` のみを描画している

**判定**: ✅ Confirmed

**根拠**: `src/app/repositories/page.tsx` を確認。`<RepositoryManager />` のみ描画しており、リポジトリ一覧コンポーネントは存在しない。

```tsx
export default function RepositoriesPage() {
  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <RepositoryManager />
      </div>
    </AppShell>
  );
}
```

---

### H-2: `RepositoryManager` は登録フォームと Sync ボタンしか持たない

**判定**: ✅ Confirmed

**根拠**: `src/components/repository/RepositoryManager.tsx` を検索。`Add Repository` ボタン、`Sync All` ボタン、Add Repository フォームのみが存在。リポジトリ一覧表示機能は含まれない。

---

### H-3: `src/app/api/repositories/route.ts` は `DELETE` のみ（GET なし）

**判定**: ✅ Confirmed

**根拠**: ファイルを直接確認。`DELETE` ハンドラのみが実装されており、`GET` 関数は存在しない。ファイルには `export async function DELETE(...)` のみ定義されている。

---

### H-4: `repositoryApi` に list 取得メソッドが存在しない

**判定**: ✅ Confirmed

**根拠**: `src/lib/api-client.ts` の `repositoryApi` オブジェクトを確認。定義されているメソッドは以下のみ：
- `scan()`
- `sync()`
- `delete()`
- `clone()`
- `getCloneStatus()`
- `getExcluded()`
- `restore()`

`list()` や `updateDisplayName()` は存在しない。

---

### H-5: `getAllRepositories(db)` が `src/lib/db/db-repository.ts:290` に存在する

**判定**: ✅ Confirmed

**根拠**: `grep -n "getAllRepositories"` でライン290に関数定義を確認。実装内容は `SELECT * FROM repositories ORDER BY name ASC` を実行し、全リポジトリを返す。ただし `worktreeCount` は含まれていない（Issueの実装方針では付与が必要）。

---

### H-6: `PUT /api/repositories/[id]` が Issue #642 で追加済み

**判定**: ✅ Confirmed

**根拠**: `src/app/api/repositories/[id]/route.ts` が存在し、`PUT` ハンドラが実装されている。`MAX_DISPLAY_NAME_LENGTH = 100` がこのファイル内にローカル定数として定義されており（line 13）、フロントエンドと共有されていない。Issueの方針通り、共有定数化が必要。

---

## Stage 1 へのレビュー申し送り事項

- H-5の補足: `getAllRepositories()` は `worktreeCount` を含まないため、APIルートで worktree 数のカウントを JOIN または別クエリで付与する実装が必要
- H-6の補足: `MAX_DISPLAY_NAME_LENGTH` が API ルートにローカル定義されているため、Issue指摘通り `src/config/` への共有定数化が必要

---

## 結論

Issue #644 に記載された全ての前提条件はコードベースと一致しており、実装方針の妥当性が確認された。仮説検証でのコード修正は不要。
