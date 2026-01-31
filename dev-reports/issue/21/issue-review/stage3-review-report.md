# Issue #21 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-01-31
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: Stage 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

---

## Must Fix（必須対応）

### MF-1: FileTreeView.tsxの変更範囲が大きく、既存機能との競合リスク

**カテゴリ**: 影響ファイル
**場所**: `src/components/worktree/FileTreeView.tsx`

**問題**:
FileTreeView.tsx（519行）は既に複雑で、useContextMenu、ContextMenu、TreeNodeコンポーネントと密結合しています。検索UI追加により更に複雑化するリスクがあります。

**証拠**:
```typescript
// 現在のFileTreeViewの構造
export const FileTreeView = memo(function FileTreeView({
  worktreeId,
  onFileSelect,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  className = '',
  refreshTrigger = 0,
}: FileTreeViewProps) {
  // 既に多くの状態管理あり
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rootItems, setRootItems] = useState<TreeItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cache, setCache] = useState<Map<string, TreeItem[]>>(() => new Map());
  const { menuState, openMenu, closeMenu } = useContextMenu();
  // ...
});
```

**推奨対応**:
検索バーUIは別コンポーネント（`SearchBar.tsx`）として新規作成し、FileTreeViewにはprops経由で検索クエリを渡す設計を推奨。これにより既存のContextMenu、TreeNode等との競合を最小化できます。

```
// 推奨するコンポーネント構成
<div className="file-tree-container">
  <SearchBar onSearchChange={handleSearchChange} />  // 新規
  <FileTreeView
    worktreeId={worktreeId}
    searchQuery={searchQuery}  // 新規props
    searchMode={searchMode}    // 新規props
    onFileSelect={handleFileSelect}
    // ...
  />
</div>
```

---

### MF-2: ファイル内容検索APIのタイムアウト実装方法が未定義

**カテゴリ**: 依存関係
**場所**: Issue本文 - 技術要件セクション

**問題**:
Issueでは「検索タイムアウト: 5秒」と記載がありますが、サーバーサイドでのファイル読み込み処理にタイムアウトを設定する具体的な実装方法が未定義です。

**証拠**:
```
| 検索タイムアウト | 5秒 | 新規設定 |
```

**推奨対応**:
Node.js環境でのタイムアウト実装方針を明記してください。

| 選択肢 | 説明 | 推奨度 |
|--------|------|--------|
| AbortController + setTimeout | Node.js 15+で利用可能。ファイル読み込み処理を中断可能 | 推奨 |
| Promise.race | タイムアウト用Promiseと検索Promiseを競争させる | 代替案 |
| child_process.exec with timeout | 外部プロセスでgrep実行時のタイムアウト | 特殊用途 |

```typescript
// AbortControllerを使用した実装例
async function searchWithTimeout(
  rootDir: string,
  query: string,
  timeoutMs: number = 5000
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await searchFiles(rootDir, query, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
```

---

## Should Fix（推奨対応）

### SF-1: 既存テストファイルへの影響と新規テスト範囲が未定義

**カテゴリ**: テスト範囲
**場所**: `tests/unit/lib/file-tree.test.ts`, `tests/integration/api-file-tree.test.ts`

**問題**:
既存のfile-tree.test.ts（475行）にはisExcludedPattern、filterExcludedItems、sortItems、readDirectoryのテストがあります。検索機能は新規ロジックのためテスト追加が必要です。

**推奨対応**:

| テストファイル | 種別 | 内容 |
|---------------|------|------|
| `tests/unit/lib/file-search.test.ts` | 新規 | ファイル内容検索ロジックのユニットテスト |
| `tests/unit/components/SearchBar.test.tsx` | 新規 | 検索UIコンポーネントテスト |
| `tests/integration/api-search.test.ts` | 新規 | 検索APIの結合テスト |
| `tests/e2e/file-search.spec.ts` | 新規 | 検索機能のE2Eテスト |

---

### SF-2: WorktreeDetailRefactoredへの検索状態管理の統合方法

**カテゴリ**: UI影響
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx`

**問題**:
WorktreeDetailRefactored.tsx（1612行）は既に多くの状態を管理しています。検索状態が追加されると更に複雑化します。

**推奨対応**:
検索状態（searchQuery, searchMode, isSearching）はカスタムフックに分離することを推奨。

```typescript
// src/hooks/useFileSearch.ts
export function useFileSearch(worktreeId: string) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);

  // debounce処理
  const debouncedSearch = useMemo(
    () => debounce((q: string) => performSearch(q), 300),
    [worktreeId, mode]
  );

  // ...

  return { query, setQuery, mode, setMode, isSearching, results };
}
```

---

### SF-3: モバイルUIでの検索バー配置が未定義

**カテゴリ**: UI影響
**場所**: `src/components/mobile/MobileTabBar.tsx`

**問題**:
MobileContent内でFileTreeViewが使用されています（行764-778）。モバイルでは画面が狭く、常時表示の検索バーはツリー表示領域を圧迫する可能性があります。

**推奨対応**:

| オプション | 説明 | 推奨度 |
|-----------|------|--------|
| 検索アイコンタップで表示/非表示切替 | ツリー表示領域を確保しつつ検索機能を提供 | 推奨 |
| ファイルタブ上部に固定表示 | 常時アクセス可能だが表示領域が減少 | 代替案 |
| フローティング検索ボタン | FABスタイルで配置、タップで検索UI表示 | 代替案 |

---

### SF-4: CLAUDE.mdへの新規API追加記載が必要

**カテゴリ**: ドキュメント更新
**場所**: `CLAUDE.md` - 主要機能モジュールセクション

**推奨対応**:
以下をCLAUDE.mdに追記：

```markdown
| `src/lib/file-search.ts` | ファイル内容検索ビジネスロジック |
| `src/components/worktree/SearchBar.tsx` | 検索UIコンポーネント |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック |
```

---

## Nice to Have（あれば良い）

### NTH-1: 大規模リポジトリでの検索パフォーマンス最適化オプション

**カテゴリ**: パフォーマンス
**場所**: Issue本文 - 対象外セクション

**推奨対応**:
将来検討として以下を対象外セクションに追記：
- 検索インデックスの事前構築
- ファイル内容のキャッシュ
- Web Workerによるバックグラウンド検索

---

### NTH-2: 型定義ファイルの更新箇所

**カテゴリ**: 影響ファイル
**場所**: `src/types/models.ts`

**推奨対応**:
以下の型定義追加を推奨：

```typescript
// src/types/models.ts に追加
export type SearchMode = 'name' | 'content';

export interface SearchQuery {
  query: string;
  mode: SearchMode;
}

export interface SearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  matchedLine?: string;      // content検索時のマッチ行
  lineNumber?: number;       // content検索時の行番号
}

export interface SearchResponse {
  results: SearchResult[];
  totalCount: number;
  hasMore: boolean;          // 100件上限に達した場合
  searchTime: number;        // 検索所要時間(ms)
}
```

---

## 影響分析サマリー

### 変更が必要なファイル

| ファイル | 変更種別 | 影響度 | 説明 |
|---------|---------|--------|------|
| `src/components/worktree/FileTreeView.tsx` | 修正 | 高 | 検索クエリによるツリーフィルタリング |
| `src/lib/file-tree.ts` | 修正 | 高 | ファイル内容検索ロジック追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 修正 | 中 | 検索状態管理の統合 |
| `src/types/models.ts` | 修正 | 低 | 検索関連型定義追加 |
| `CLAUDE.md` | 修正 | 低 | ドキュメント追加 |

### 新規作成が必要なファイル

| ファイル | 説明 |
|---------|------|
| `src/app/api/worktrees/[id]/search/route.ts` | 検索APIエンドポイント |
| `src/components/worktree/SearchBar.tsx` | 検索バーUIコンポーネント |
| `src/hooks/useFileSearch.ts` | 検索状態管理フック |
| `src/lib/file-search.ts` | 検索ビジネスロジック |
| `tests/unit/lib/file-search.test.ts` | ユニットテスト |
| `tests/integration/api-search.test.ts` | 結合テスト |
| `tests/e2e/file-search.spec.ts` | E2Eテスト |

### 破壊的変更

**なし** - 新規機能追加のため、既存APIやコンポーネントのインターフェースに破壊的変更はありません。

### パフォーマンス影響

**懸念事項**:
- ファイル内容検索時の大量ファイル読み込みによるメモリ使用量増加
- 深い階層のディレクトリ走査によるI/O負荷
- 検索結果のフィルタリング処理によるCPU負荷

**軽減策**:
- `MAX_FILE_SIZE_PREVIEW` (1MB) による大きなファイルのスキップ
- `MAX_DEPTH` (10階層) によるディレクトリ深さ制限
- 検索結果上限 (100件) による結果セット制限
- 5秒タイムアウトによる長時間検索の中断

---

## 参照ファイル

### コード
| ファイル | 行 | 関連性 |
|---------|-----|--------|
| `src/components/worktree/FileTreeView.tsx` | 1-519 | 検索UI追加の主要対象 |
| `src/lib/file-tree.ts` | 1-296 | EXCLUDED_PATTERNS、LIMITS定義 |
| `src/lib/utils.ts` | 1-41 | debounce関数の再利用 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 1379-1392 | FileTreeView使用箇所 |
| `src/lib/path-validator.ts` | 1-118 | isPathSafe()再利用 |
| `src/types/models.ts` | 214-242 | TreeItem、TreeResponse型 |

### ドキュメント
| ファイル | セクション | 関連性 |
|---------|-----------|--------|
| `CLAUDE.md` | 主要機能モジュール | 新規モジュール追加時の更新必要 |
| `CLAUDE.md` | 最近の実装機能 | 検索機能の設計書リンク追加 |

---

## 次のアクション

1. **MF-1対応**: SearchBar.tsxコンポーネントの設計・実装
2. **MF-2対応**: タイムアウト実装方針をIssueに追記
3. **SF-1対応**: テストファイル構成の決定
4. **SF-2対応**: useFileSearchフックの設計
5. **SF-3対応**: モバイルUI配置の決定
