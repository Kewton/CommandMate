# Issue #469 設計方針書: Filesタブ・ファイル内容の自動更新（外部変更検知）

## 1. 概要

CLIツール（Claude Code等）がファイルを作成・更新した際、FilesタブとファイルタブのUIが自動更新されるよう、ポーリングベースの外部変更検知を実装する。

### スコープ

| 対象 | 含む | 含まない |
|------|------|---------|
| ファイルツリー | ポーリングによる自動更新 | WebSocket/SSE |
| ファイル内容 | 開いているタブの自動更新 | FileViewer（モーダル）|
| 差分検知 | クライアント側JSONハッシュ / HTTP 304（Last-Modifiedベース） | chokidar/fs.watch |
| 編集保護 | isDirty時のスキップ | コンフリクト通知 |

## 2. アーキテクチャ設計

### システム構成

```
┌─────────────────────────────────────────────────────┐
│  Browser (Client)                                    │
│                                                      │
│  WorktreeDetailRefactored                            │
│  ├── fileTreeRefresh (state)                         │
│  ├── useFilePolling (tree) ← 新規 (F2: ここで管理)  │
│  │   └── setInterval → 差分検知 → refreshTrigger++  │
│  │                                                   │
│  ├── FileTreeView                                    │
│  │   └── useEffect([refreshTrigger]) ← 既存のみ     │
│  │                                                   │
│  └── FilePanelContent                                │
│      ├── useEffect (auto-fetch) ← 既存              │
│      └── useFileContentPolling ← 新規 (F7: 分離)    │
│          └── useFilePolling + If-Modified-Since/304  │
│                                                      │
│  useFilePolling (共通カスタムフック)                   │
│  ├── visibilitychange 監視 (F6: 既存ハンドラと独立)  │
│  ├── enabled 条件チェック                             │
│  └── cleanup on unmount                              │
│                                                      │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP
┌───────────────────▼─────────────────────────────────┐
│  Server (Next.js API Routes)                         │
│                                                      │
│  /api/worktrees/:id/tree                             │
│  └── GET → TreeResponse (変更なし)                   │
│                                                      │
│  /api/worktrees/:id/files/:path                      │
│  └── GET → FileContent                               │
│      ├── Last-Modified ヘッダ追加 ← 新規            │
│      └── If-Modified-Since → 304 応答 ← 新規        │
│                                                      │
└─────────────────────────────────────────────────────┘
```

### レイヤー構成

| レイヤー | ファイル | 変更内容 |
|---------|---------|---------|
| プレゼンテーション | FileTreeView.tsx | 変更最小限（ポーリング責務なし、F2対応） |
| プレゼンテーション | FilePanelContent.tsx | useFileContentPolling呼び出しのみ（F7対応） |
| プレゼンテーション | FilePanelTabs.tsx | isDirtyインジケーター表示 |
| プレゼンテーション | MarkdownEditor.tsx | onDirtyChangeコールバック追加（EditorProps型拡張、F2対応） |
| フック | useFilePolling.ts（新規） | ポーリングライフサイクル管理 |
| フック | useFileContentPolling.ts（新規） | ファイル内容ポーリング専用（F7対応） |
| フック | useFileTabs.ts | FileTab型にisDirty追加、SET_DIRTYアクション |
| API | files/[...path]/route.ts | Last-Modified/304応答 |
| 設定 | config/file-polling-config.ts（新規） | ポーリング定数定義 |

## 3. 技術選定

| 項目 | 選定 | 理由 | 代替案 |
|------|------|------|--------|
| 変更検知方式 | ポーリング | シンプル、既存パターンに統一 | WebSocket（過剰）、chokidar（サーバー負荷） |
| ツリー差分検知 | クライアント側JSONハッシュ | サーバー変更不要 | サーバー側ETag（実装コスト大） |
| ファイル差分検知 | HTTP条件付きリクエスト | HTTP標準準拠、転送量削減 | クライアント側ハッシュ（帯域無駄） |
| ポーリング管理 | カスタムフック | DRY、一元管理 | 各コンポーネントに分散（保守性低） |
| ツリーポーリング統合 | refreshTriggerインクリメント | 既存パスに統一、排他制御不要 | 別useEffect（競合リスク） |

## 4. 設計パターン

### 4-1. useFilePolling カスタムフック（新規）

ファイルツリーとファイル内容のポーリングライフサイクルを一元管理する。

```typescript
// src/hooks/useFilePolling.ts

interface UseFilePollingOptions {
  /** ポーリング間隔（ms） */
  intervalMs: number;
  /** ポーリング有効条件 */
  enabled: boolean;
  /** ポーリングコールバック */
  onPoll: () => void;
}

function useFilePolling({ intervalMs, enabled, onPoll }: UseFilePollingOptions): void {
  // 1. setInterval管理（enabled切替で開始/停止）
  // 2. document.visibilitychange監視
  //    - hidden → clearInterval
  //    - visible → 即時onPoll + setInterval再開
  // 3. unmount時のcleanup
}
```

**設計ポイント**:
- `enabled`にはFilesタブアクティブ状態を渡す
- `visibilitychange`でバックグラウンド時に自動停止
- コールバックはuseRefで保持し、最新を参照

**既存visibilitychangeハンドラとの共存方針** (レビュー指摘 F6):

WorktreeDetailRefactored.tsxには既存の`handleVisibilityChange`（行1841-1892）が存在し、独自のvisibilitychangeリスナーを登録している。useFilePollingのvisibilitychangeリスナーとは**独立して動作**する設計とする（方針A）。

- **共存が問題ない理由**: 既存の`handleVisibilityChange`はセッションデータの再取得（ターミナル出力、ステータス更新等）を担当し、useFilePollingのvisibilitychangeはファイルポーリングの開始/停止を担当する。スコープが異なる（セッションデータ vs. ファイルポーリング）ため、互いに干渉しない
- **各フックが独立してライフサイクルを管理**することで、カプセル化を維持する。useFilePollingはunmount時に自身のリスナーをクリーンアップし、既存ハンドラに影響を与えない
- **スロットル**: useFilePollingのvisible復帰時は即時onPoll + setInterval再開のみで、既存の`RECOVERY_THROTTLE_MS`相当のスロットルは不要。理由は、ポーリング間隔（5秒）自体が十分なスロットルとして機能するため

### 4-2. ツリーポーリング（WorktreeDetailRefactored管理）

**推奨構成** (レビュー指摘 F2):

FileTreeViewは既に963行で多数の責務（ツリー表示、検索フィルタリング、コンテキストメニュー、キーボードナビゲーション、遅延読み込み等）を担っているため、ポーリングと差分検知のロジックはFileTreeViewの外側（WorktreeDetailRefactored）に配置する。FileTreeView自体はポーリングを意識しない設計とする。

```typescript
// WorktreeDetailRefactored.tsx 内（FileTreeViewの外側で管理）

// 注意: fetchDirectory は FileTreeView 内部の useCallback として定義されており、
// WorktreeDetailRefactored からは直接呼び出せない。
// そのため、WorktreeDetailRefactored 内で直接 API を fetch する（整合性レビュー指摘 F3）。

useFilePolling({
  intervalMs: FILE_TREE_POLL_INTERVAL_MS,
  enabled: isActive,  // Filesタブアクティブ時のみ
  onPoll: async () => {
    // 差分検知: ルートディレクトリのみ直接APIフェッチしてJSON比較
    const response = await fetch(`/api/worktrees/${worktreeId}/tree`);
    if (!response.ok) return;  // エラーは無視（ポーリング）
    const data = await response.json();
    const newHash = JSON.stringify(data?.items);
    if (newHash !== prevTreeHashRef.current) {
      prevTreeHashRef.current = newHash;
      setFileTreeRefresh(prev => prev + 1);  // 既存のrefreshTriggerをインクリメント
    }
  },
});

// FileTreeView には isActive prop は不要（ポーリング責務を持たないため）
// 既存の refreshTrigger prop 経由で再取得が発火する
```

**設計根拠（SRP）**:
- FileTreeViewはツリーの表示と操作に専念する
- ポーリングの開始/停止判定、差分検知ロジックはWorktreeDetailRefactoredが管理する
- FileTreeViewの変更は最小限（isActive propの追加も不要）

**差分検知フロー**:
1. WorktreeDetailRefactored内のuseFilePollingがルートディレクトリのみ取得
2. JSON.stringifyで前回レスポンスと比較
3. 変更あり → setFileTreeRefresh(prev => prev + 1) → FileTreeView内の既存useEffectが全展開ディレクトリを再取得
4. 変更なし → 何もしない（ネットワーク負荷はルート1回のみ）

### 4-3. ファイル内容ポーリング（useFileContentPolling分離）

**推奨構成** (レビュー指摘 F7):

FilePanelContent.tsxは既に803行で多数の責務を担っているため、ポーリングロジックは専用フック`useFileContentPolling`として分離する。FilePanelContent内では1行の呼び出しで済むようにし、開放閉鎖原則（OCP）に従う。

```typescript
// src/hooks/useFileContentPolling.ts（新規）

interface UseFileContentPollingOptions {
  tab: FileTab;
  worktreeId: string;
  onLoadContent: (path: string, data: FileContent) => void;
}

function useFileContentPolling({ tab, worktreeId, onLoadContent }: UseFileContentPollingOptions): void {
  // 初期値null: 初回リクエストにはIf-Modified-Sinceヘッダを付与しない（影響分析レビュー指摘 F3）
  // これにより初回は必ず200応答となり、304応答の誤処理リスクを回避する
  const lastModifiedRef = useRef<string | null>(null);

  useFilePolling({
    intervalMs: FILE_CONTENT_POLL_INTERVAL_MS,
    enabled: tab.content !== null && !tab.loading && !tab.isDirty,
    onPoll: async () => {
      const url = buildFileUrl(worktreeId, tab.path);
      const headers: HeadersInit = {};
      if (lastModifiedRef.current) {
        headers['If-Modified-Since'] = lastModifiedRef.current;
      }
      const response = await fetch(url, { headers });

      if (response.status === 304) return;  // 変更なし
      if (!response.ok) return;  // エラーは無視（ポーリング）

      lastModifiedRef.current = response.headers.get('Last-Modified');
      const data = await response.json();
      onLoadContent(tab.path, data);
    },
  });
}
```

```typescript
// FilePanelContent.tsx 内（1行の呼び出しのみ）

useFileContentPolling({ tab, worktreeId, onLoadContent });
```

**注意事項: ポーリングによるSET_CONTENTとMarkdownEditor再マウントの競合リスク** (整合性レビュー指摘 F5):

ポーリングが200 OKを返した場合、`onLoadContent` 経由で `dispatch({ type: 'SET_CONTENT' })` が発火し、`tab.content` が更新される。この際にMarkdownEditorが再マウントされると、内部の `originalContent` がリセットされ、編集中のテキストが失われるリスクがある。

- **前提**: MarkdownEditorは `filePath` propで内容を管理しており、`content` propの変化のみでは再マウントされない。`SET_CONTENT` dispatch時も `filePath` が変わらない限り内部状態は保持される
- **安全策**: `useFileContentPolling` の `enabled` 条件に `!tab.isDirty` を含めているため、MarkdownEditorで編集中（isDirty=true）の場合はポーリング自体が停止する。これにより `SET_CONTENT` による意図しない上書きは発生しない
- **エッジケース**: isDirtyがfalse（未編集）の状態でMarkdownEditorが表示されている場合、ポーリングによるSET_CONTENTが発火する可能性がある。この場合、MarkdownEditorの内部で `originalContent` が更新され、最新のファイル内容が反映される（期待動作）
- **テストで検証すべき事項**: markdownファイルが開かれている状態でポーリングによるSET_CONTENTが発生した際に、MarkdownEditorのUX（カーソル位置、スクロール位置等）に影響がないことを確認する

**注意事項: タブ切替時のlastModifiedRefのライフサイクル** (影響分析レビュー指摘 F5):

FilePanelContent内でuseFileContentPollingが使用され、FilePanelContentがkey={activeTab.path}でマウント/アンマウントされる（FilePanelTabs.tsx行139）。タブ切替時にFilePanelContentがアンマウントされるとlastModifiedRefがリセット（null）されるため、タブに戻った際の最初のポーリングでは必ず200応答（フルボディ転送）が発生する。

- **許容理由**: 5タブ各5秒間隔での切替でも影響は軽微であり、304応答によるネットワーク最適化はタブがアクティブな間のみ有効であれば十分
- **設計上の制約**: lastModifiedRefはuseRef（コンポーネントローカル）であるため、タブの表示/非表示をkey切替で制御する現行設計ではライフサイクルに依存する。この制約は現時点では許容する

**注意事項: 検索ロジック重複の拡大防止** (レビュー指摘 F1):

FilePanelContent.tsx内のMarkdownWithSearch（行415-513）とCodeViewerWithSearch（行516-603）には、検索状態管理（searchOpen/searchQuery/searchMatches/searchCurrentIdx）とコールバック（openSearch/closeSearch/nextMatch/prevMatch）がほぼ完全に重複している。ポーリング機能の追加時にこの重複が拡大しないよう、以下に留意する:

- useFileContentPollingフックへのポーリング分離により、FilePanelContent自体への変更を最小限に抑え、検索ロジック周辺への影響を回避する
- 将来的には検索状態管理をuseFileContentSearchカスタムフックとして抽出し、検索バーUIをFileContentSearchBar共通コンポーネントとして分離することを推奨する（Issue #469スコープ外の技術的負債として記録）

### 4-4. isDirtyフラグの管理（useFileTabs拡張）

**現在の FileTab 型定義（Before）** (整合性レビュー指摘 F1):

```typescript
// src/hooks/useFileTabs.ts（現在の定義: 行36-47）
export interface FileTab {
  /** File path relative to worktree root */
  path: string;
  /** Display name (filename extracted from path) */
  name: string;
  /** Loaded file content (null until fetched) */
  content: FileContent | null;
  /** Whether content is being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
}
```

**変更後の FileTab 型定義（After）**:

```typescript
// src/hooks/useFileTabs.ts（変更後）
export interface FileTab {
  /** File path relative to worktree root */
  path: string;
  /** Display name (filename extracted from path) */
  name: string;
  /** Loaded file content (null until fetched) */
  content: FileContent | null;
  /** Whether content is being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Whether the file has unsaved edits (blocks auto-update polling) */
  isDirty: boolean;  // 追加
}
```

**現在の FileTabsAction 型定義（Before）**:

```typescript
// src/hooks/useFileTabs.ts（現在の定義: 行58-67）
export type FileTabsAction =
  | { type: 'OPEN_FILE'; path: string }
  | { type: 'CLOSE_TAB'; path: string }
  | { type: 'ACTIVATE_TAB'; path: string }
  | { type: 'SET_CONTENT'; path: string; content: FileContent }
  | { type: 'SET_LOADING'; path: string; loading: boolean }
  | { type: 'SET_ERROR'; path: string; error: string }
  | { type: 'RENAME_FILE'; oldPath: string; newPath: string }
  | { type: 'DELETE_FILE'; path: string }
  | { type: 'RESTORE'; paths: string[]; activePath: string | null };
```

**変更後の FileTabsAction 型定義（After）**:

```typescript
// src/hooks/useFileTabs.ts（変更後）
export type FileTabsAction =
  | { type: 'OPEN_FILE'; path: string }
  | { type: 'CLOSE_TAB'; path: string }
  | { type: 'ACTIVATE_TAB'; path: string }
  | { type: 'SET_CONTENT'; path: string; content: FileContent }
  | { type: 'SET_LOADING'; path: string; loading: boolean }
  | { type: 'SET_ERROR'; path: string; error: string }
  | { type: 'RENAME_FILE'; oldPath: string; newPath: string }
  | { type: 'DELETE_FILE'; path: string }
  | { type: 'RESTORE'; paths: string[]; activePath: string | null }
  | { type: 'SET_DIRTY'; path: string; isDirty: boolean };  // 追加
```

**reducer変更箇所**:

```typescript
// reducer内: 以下の各caseでisDirty初期値を設定
case 'OPEN_FILE':
  // 新規タブ作成時: isDirty: false
case 'RESTORE':
  // リストア時: isDirty: false（常にfalse、永続化しない）
case 'SET_CONTENT':
  // コンテンツ設定時: isDirty: false（外部更新で上書きされた場合もリセット）

// 新規case追加
case 'SET_DIRTY':
  return {
    ...state,
    tabs: state.tabs.map(tab =>
      tab.path === action.path ? { ...tab, isDirty: action.isDirty } : tab
    ),
  };
```

**localStorage永続化**:

```typescript
// readPersistedTabs: isDirtyは永続化しない（常にfalseでリストア）
// 理由: ブラウザリロード時に未保存状態を復元する意味がないため
```

**FilePanelContentのmemo化とisDirty変更の再レンダリング影響** (影響分析レビュー指摘 F2):

FilePanelContentはmemo化されており（行617）、tab propの浅い比較で再レンダリングが判定される。isDirtyフィールドの追加により、SET_DIRTYディスパッチのたびにtab参照が新しくなりFilePanelContent全体が再レンダリングされる。以下の分析により、現行設計で許容可能と判断する。

- **影響が限定的な理由**:
  - isDirtyの変化はMarkdownEditorでの編集開始時（false->true）と保存時（true->false）の2回のみ発生し、高頻度ではない
  - CodeViewerのhljs.highlightはuseMemoで保護されており、再計算は発生しない（行203-208）
  - MarpPreviewのiframe srcDocはtab.content依存であり、isDirty変化ではcontentが変わらないためsrcDocの再設定は発生しない
  - MarkdownEditorのReactMarkdownはプレビューモード時のみレンダリングされ、エディタモード（isDirtyが変化する状態）ではレンダリングされない

- **対策方針**: 初版ではカスタム比較関数を追加せず、パフォーマンスに問題が確認された場合に以下のいずれかを適用する
  - (A) FilePanelContentのmemo比較関数でisDirtyを除外し、isDirtyを独立propとして渡す
  - (B) useFileContentPollingフック内でtab.isDirtyを直接参照する代わりに、isDirtyをuseRefで管理してレンダリングから分離する

- **プロファイリング確認事項**: MarkdownEditor編集中のisDirty変化時に、FilePanelContent配下の重いコンポーネント（MarpPreview, CodeViewer）の不要な再レンダリングが発生していないことをReact DevTools Profilerで確認する

### 4-5. MarkdownEditor onDirtyChange 実装パターン（整合性レビュー指摘 F2）

MarkdownEditorが内部で管理するisDirty状態を外部（FilePanelContent）に伝搬するため、onDirtyChangeコールバックを追加する。

**EditorProps型の変更（Before）**:

```typescript
// src/types/markdown-editor.ts（現在の定義: 行75-91付近）
// onDirtyChange は存在しない
```

**EditorProps型の変更（After）**:

```typescript
// src/types/markdown-editor.ts に追加
export interface EditorProps {
  // ... 既存プロパティ
  /** isDirty状態変化時に呼び出されるコールバック（ポーリング制御用） */
  onDirtyChange?: (isDirty: boolean) => void;
}
```

**MarkdownEditor内での伝搬パターン**:

```typescript
// src/components/worktree/MarkdownEditor.tsx
// 既存のisDirty計算（行202付近）: const isDirty = content !== originalContent

// useEffectでisDirty変化時にコールバックを呼び出す
useEffect(() => {
  onDirtyChange?.(isDirty);
}, [isDirty, onDirtyChange]);
```

**MarkdownWithSearchでのprops中継**:

MarkdownEditorはFilePanelContent内でMarkdownWithSearchコンポーネント経由で使用されている。そのため、MarkdownWithSearchもonDirtyChangeプロパティを受け取り、MarkdownEditorに中継する必要がある。

```typescript
// FilePanelContent.tsx 内 MarkdownWithSearch コンポーネント
// props にonDirtyChangeを追加し、MarkdownEditor に透過的に渡す

<MarkdownWithSearch
  // ... 既存props
  onDirtyChange={(isDirty) => {
    dispatch({ type: 'SET_DIRTY', path: tab.path, isDirty });
  }}
/>
```

**MarpEditorWithSlidesでのprops中継** (影響分析レビュー指摘 F1):

FilePanelContent.tsx内のMarpEditorWithSlides（行319-383）も内部でMarkdownEditorを使用している（行373-378）。MARPファイルをエディタモードで編集した場合にisDirtyが正しく伝搬されないと、ポーリングによる上書きが発生するリスクがある。そのため、MarpEditorWithSlidesにもonDirtyChangeプロパティを追加し、MarkdownEditorへ中継する設計とする。

```typescript
// FilePanelContent.tsx 内 MarpEditorWithSlides コンポーネント
// props にonDirtyChangeを追加し、内部のMarkdownEditor に透過的に渡す

<MarpEditorWithSlides
  // ... 既存props
  onDirtyChange={(isDirty) => {
    dispatch({ type: 'SET_DIRTY', path: tab.path, isDirty });
  }}
/>
```

- MarpEditorWithSlidesのprops型定義にも `onDirtyChange?: (isDirty: boolean) => void` を追加する
- 内部のMarkdownEditor呼び出し（行373-378付近）でonDirtyChangeを透過的に渡す
- MarpPreviewモード（スライドプレビューのみ）では編集が発生しないため、isDirtyは常にfalseとなる（対応不要）

### 4-6. サーバー側304応答（files API）

```typescript
// src/app/api/worktrees/[id]/files/[...path]/route.ts

// GETハンドラ内（テキストファイルのみ）
const stat = await fs.stat(fullPath);
const lastModified = stat.mtime.toUTCString();

// If-Modified-Since チェック
const ifModifiedSince = request.headers.get('If-Modified-Since');
if (ifModifiedSince) {
  const clientDate = new Date(ifModifiedSince);
  // セキュリティレビュー指摘 F7: 不正な日時文字列のバリデーション
  // 不正な日時文字列（例: 'invalid', '9999-99-99'）が送信された場合、
  // new DateはInvalid Dateを返す。isNaNチェックで200応答にフォールバックし、
  // 安全にフルボディを返却する（HTTPヘッダサイズはNode.jsデフォルト8KB上限で制限済み）
  if (!isNaN(clientDate.getTime()) && stat.mtime <= clientDate) {
    return new Response(null, {
      status: 304,
      headers: {
        'Last-Modified': lastModified,
        'Cache-Control': 'no-store, private',  // セキュリティレビュー指摘 F2
      },
    });
  }
}

// 通常レスポンスにヘッダ追加
// 注意: Content-Length は設定しない（整合性レビュー指摘 F4）
// 理由: stat.size はファイルのバイト数であり、JSONレスポンス
// （{ success, path, content, extension, worktreePath }）の実サイズとは一致しない。
// Next.js が JSONレスポンスの Content-Length を自動設定するため、手動設定は不要。
return NextResponse.json(data, {
  headers: {
    'Last-Modified': lastModified,
    'Cache-Control': 'no-store, private',  // セキュリティレビュー指摘 F2: キャッシュポイズニング防止
  },
});
```

**304応答とauto-fetchの分離設計** (影響分析レビュー指摘 F3):

useFileContentPollingとFilePanelContent既存のauto-fetch（行646-678）は独立して動作する。304応答の誤処理を防ぐため、以下の前提を遵守する:

- **前提**: useFileContentPollingのlastModifiedRefの初期値は`null`であり、初回リクエストにはIf-Modified-Sinceヘッダが付与されない。これにより初回は必ず200応答が返る
- **既存auto-fetchとの関係**: 既存のauto-fetchはタブ選択時の初回ロードを担当し、If-Modified-Sinceヘッダを送信しない。useFileContentPollingは初回ロード完了後（tab.content !== null）に開始されるため、両者の責務は明確に分離されている
- **防衛的プログラミング（推奨）**: 既存auto-fetchの応答処理に`if (response.status === 304) return;`の早期リターンを追加する。これにより、将来的にヘッダ管理が変更された場合でも、304応答のボディなしレスポンスに対するJSONパースエラーを防止できる

## 5. 定数設計

```typescript
// src/config/file-polling-config.ts（新規）

/** ファイルツリーポーリング間隔（ms） */
export const FILE_TREE_POLL_INTERVAL_MS = 5000;

/** ファイル内容ポーリング間隔（ms） */
export const FILE_CONTENT_POLL_INTERVAL_MS = 5000;
```

## 6. データフロー

### ファイルツリー自動更新フロー（WorktreeDetailRefactored管理、F2対応）

```
WorktreeDetailRefactored 内
  useFilePolling (5秒間隔)
    │
    ├─ enabled = isActive (Filesタブがアクティブ)
    │
    └─ onPoll()
        ├─ fetch(`/api/worktrees/${worktreeId}/tree`) → ルートのみ取得（F3対応）
        ├─ JSON.stringify比較
        │
        ├─ 変更なし → return（何もしない）
        │
        └─ 変更あり
            └─ setFileTreeRefresh(prev => prev + 1)
                └─ FileTreeView内の既存useEffect発火
                    └─ ルート + 全展開ディレクトリ再取得
```

### ファイル内容自動更新フロー

```
useFilePolling (5秒間隔)
  │
  ├─ enabled = !isDirty && content !== null && !loading
  │
  └─ onPoll()
      ├─ fetch(url, { 'If-Modified-Since': lastModified })
      │
      ├─ 304 Not Modified → return（何もしない）
      │
      └─ 200 OK
          ├─ lastModifiedRef更新
          └─ onLoadContent(path, data)
              └─ dispatch SET_CONTENT → FileTab.content更新
```

### isDirty伝搬フロー

```
MarkdownEditor (content !== originalContent)
  └─ onDirtyChange(isDirty: boolean)
      ├─ via MarkdownWithSearch → FilePanelContent  (通常Markdownファイル)
      └─ via MarpEditorWithSlides → FilePanelContent  (MARPファイル、影響分析F1)
          └─ dispatch({ type: 'SET_DIRTY', path, isDirty })
              └─ useFileTabs reducer → FileTab.isDirty更新
                  └─ useFilePolling.enabled = !isDirty
```

## 7. セキュリティ設計

| 項目 | 対策 |
|------|------|
| パストラバーサル | 既存のpath-validator.tsによるバリデーション（変更なし） |
| XSSリスク | ポーリングレスポンスは既存のサニタイズパイプライン通過（変更なし） |
| DoSリスク | visibilitychangeによるバックグラウンド停止、最大タブ数5制限 |
| 情報漏洩 | Last-Modifiedヘッダはmtime情報のみ（低リスク）。認証無効環境（CM_AUTH_TOKEN_HASH未設定）ではネットワーク上の全ユーザーがファイル更新時刻を取得可能となり、更新パターン（作業時間帯等）が推測される可能性がある。CommandMateの想定利用環境（ローカル/信頼ネットワーク）では低リスクと判断（セキュリティレビュー指摘 F1） |
| キャッシュ制御 | 304応答および200応答にCache-Control: no-store, privateヘッダを付与し、中間プロキシによるキャッシュポイズニングを防止する（セキュリティレビュー指摘 F2） |
| ヘッダバリデーション | If-Modified-Sinceヘッダの不正日時文字列はisNaNチェックで検出し、200応答（フルボディ返却）にフォールバックする。HTTPヘッダサイズはNode.jsデフォルト8KB上限で制限済み（セキュリティレビュー指摘 F7） |

## 8. パフォーマンス設計

### ポーリング負荷見積もり

| シナリオ | ツリーReq/分 | ファイルReq/分 | 合計/分 |
|---------|:-----------:|:------------:|:------:|
| 1WT, 1タブ | 12 | 12 | 24 |
| 1WT, 5タブ（最大） | 12 | 60 | 72 |
| 3WT, 各3タブ | 36 | 108 | 144 |
| 3WT, バックグラウンド2 | 12 | 36 | 48 |

**最悪ケース（3WT x 5タブ, 全アクティブ）**: 216 req/分 → 3.6 req/秒
- 304応答の場合、ボディなしで低負荷
- ツリー差分なしの場合、ルート1回のみ
- 実際にはvisibilitychangeにより非アクティブタブは停止

### setFileTreeRefreshによるuseMemo再計算の影響 (影響分析レビュー指摘 F4)

WorktreeDetailRefactored.tsxの左ペインレンダリング（行2237付近）はuseMemoでメモ化されており、依存配列にfileTreeRefreshが含まれている。ツリーポーリングによるsetFileTreeRefreshの発火は、このuseMemoの再計算をトリガーし、左ペイン全体のReactノードを再生成する。

- **影響が限定的な理由**: FileTreeViewはleftPaneTab === 'files'時のみレンダリングされ（行2200付近の条件分岐）、NotesAndLogsPaneはleftPaneTab === 'memo'時のため、同時にレンダリングされることはない。したがってポーリングによる再計算は表示中のコンポーネントのみに影響する
- **SearchBarの影響**: SearchBarは左ペイン内で常にレンダリングされるため、useMemo再計算時にReactノードが再生成される。SearchBarコンポーネント側のmemo化が有効であることを確認し、内部状態（入力テキスト等）がリセットされないことを検証する
- **ポーリング停止による軽減**: enabled = isActive（Filesタブがアクティブ時のみ）のため、Filesタブ以外のタブ（memo等）が選択されている場合はポーリングが停止し、setFileTreeRefreshは発火しない。これにより不要なuseMemo再計算を回避する

### 軽量化戦略

1. **ツリー**: ルートのみ取得 → JSONハッシュ比較 → 変更時のみフル再取得
2. **ファイル**: If-Modified-Since → 304で内容転送スキップ
3. **バックグラウンド**: visibilitychange APIで停止
4. **タブ非アクティブ**: enabled=falseでポーリング停止

## 9. テスト設計

### ユニットテスト

| テスト対象 | テストファイル | テスト内容 |
|-----------|-------------|-----------|
| useFilePolling | tests/unit/hooks/useFilePolling.test.ts（新規） | 開始/停止、visibilitychange、cleanup |
| useFileTabs SET_DIRTY | tests/unit/hooks/useFileTabs.test.ts（既存拡張） | isDirtyフラグの更新、初期値false |
| ポーリング定数 | tests/unit/config/file-polling-config.test.ts（新規） | 定数値の検証 |
| MarkdownEditor onDirtyChange | tests/unit/components/MarkdownEditor.test.tsx（既存拡張） | (1) 編集時にonDirtyChangeがtrueで呼ばれること (2) 保存後にfalseで呼ばれること (3) onDirtyChange未指定時にエラーが発生しないこと（影響分析レビュー指摘 F6） |

### 結合テスト

| テスト対象 | テストファイル | テスト内容 |
|-----------|-------------|-----------|
| files API 304 | tests/integration/api/files-304.test.ts（新規） | If-Modified-Since → 304応答 |

### 追加テスト（整合性レビュー指摘 F5, F6）

| テスト対象 | テストファイル | テスト内容 |
|-----------|-------------|-----------|
| MarkdownEditor + ポーリング競合 | tests/unit/hooks/useFileContentPolling.test.ts | isDirty=false時のSET_CONTENT発火後にMarkdownEditorの内部状態が保持されることを検証 |

**注意** (整合性レビュー指摘 F6): Stage 1レビューのF2対応でFileTreeViewからポーリング責務を除去したため、FileTreeViewにisActive propは追加しない。従って `FileTreeView.test.tsx` への isActive prop テストは不要。代わりに、WorktreeDetailRefactored内でのツリーポーリング統合テスト（setFileTreeRefreshがポーリングで呼ばれること）をuseFilePolling.test.tsで検証する。

## 10. 変更対象ファイル一覧

### 新規作成

| ファイル | 内容 |
|---------|------|
| src/hooks/useFilePolling.ts | ポーリングライフサイクル管理フック |
| src/hooks/useFileContentPolling.ts | ファイル内容ポーリング専用フック（F7対応） |
| src/config/file-polling-config.ts | ポーリング定数定義 |
| tests/unit/hooks/useFilePolling.test.ts | フックのユニットテスト |
| tests/unit/hooks/useFileContentPolling.test.ts | ファイル内容ポーリングフックのユニットテスト |
| tests/integration/api/files-304.test.ts | 304応答の結合テスト |

### 既存変更

| ファイル | 変更内容 |
|---------|---------|
| src/components/worktree/FileTreeView.tsx | 変更最小限（ポーリング責務はWorktreeDetailRefactoredへ移動、F2対応） |
| src/components/worktree/FilePanelContent.tsx | useFileContentPolling呼び出し（1行のみ、F7対応） |
| src/hooks/useFileTabs.ts | FileTab型にisDirty追加、SET_DIRTYアクション、reducer/永続化修正 |
| src/components/worktree/MarkdownEditor.tsx | onDirtyChangeコールバック追加 |
| src/components/worktree/FilePanelTabs.tsx | isDirtyインジケーター表示 |
| src/app/api/worktrees/[id]/files/[...path]/route.ts | Last-Modified/304応答対応 |
| src/components/worktree/WorktreeDetailRefactored.tsx | ツリーポーリング（useFilePolling呼び出し、差分検知ロジック、F2対応） |

## 11. 設計上の決定事項とトレードオフ

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| ポーリング（WebSocketではない） | 既存パターンに統一、シンプル | リアルタイム性は5秒遅延 |
| クライアント側JSONハッシュ | サーバー変更不要 | ルート取得は毎回発生 |
| HTTP 304（ファイル内容） | HTTP標準、転送量削減 | サーバーにfs.stat追加 |
| refreshTrigger統合 | 排他制御不要、単一フロー | ポーリングの自由度低 |
| isDirtyフラグ方式 | MarkdownEditorの既存パターン活用 | 他エディタ追加時に拡張必要 |
| コンフリクト通知なし（初版） | スコープ限定 | ユーザーが変更に気づかない |
| ポーリング間隔固定5秒 | シンプル、十分なリアルタイム性 | ユーザー設定不可 |

## 12. 将来の拡張性

- **コンフリクト通知**: isDirty中の外部変更をトーストで通知
- **ユーザー設定**: ポーリング間隔のカスタマイズ
- **サーバーETag**: ツリーAPIにETagを追加し、304応答でネットワーク最適化
- **FileViewer対応**: モーダル表示のファイルにもポーリング適用
- **検索ロジックのDRY化** (技術的負債、Stage 1 F1): FilePanelContent内のMarkdownWithSearchとCodeViewerWithSearchの検索状態管理・UIの重複を、useFileContentSearchフックおよびFileContentSearchBar共通コンポーネントとして抽出する
- **lastModifiedのタブ間共有** (影響分析レビュー指摘 F5): lastModifiedをFileTab型に保持し、タブ切替時のlastModifiedRefリセットによるフル転送を回避する。これにより、タブ復帰時も304応答による軽量化が即座に有効になる

## 13. レビュー指摘事項の反映サマリー

### Stage 1: 通常レビュー（設計原則）

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 反映箇所 |
|----|--------|---------|---------|----------|---------|
| F1 | should_fix | DRY | 検索ロジック重複リスク | 反映済 | セクション4-3注意事項、セクション12 |
| F2 | should_fix | SOLID/SRP | ツリーポーリングの責務配置 | 反映済 | セクション4-2を全面改訂 |
| F3 | nice_to_have | SOLID | isDirty管理の依存関係分散 | スキップ | nice_to_haveのため対象外 |
| F4 | nice_to_have | KISS | JSON.stringify比較の制約明記 | スキップ | nice_to_haveのため対象外 |
| F5 | nice_to_have | YAGNI | ポーリング定数の設定ファイル分離 | スキップ | nice_to_haveのため対象外（現行設計維持） |
| F6 | must_fix | DRY | visibilitychangeハンドラの共存方針 | 反映済 | セクション4-1に共存方針を追記 |
| F7 | should_fix | SOLID/OCP | ファイル内容ポーリングのフック分離 | 反映済 | セクション4-3をuseFileContentPolling分離に改訂、セクション10に新規ファイル追加 |

### 実装チェックリスト（Stage 1指摘対応）

- [ ] **F6**: useFilePollingのvisibilitychangeリスナーが既存handleVisibilityChangeと独立動作することを確認。スロットル不要の根拠をコメントに記載
- [ ] **F2**: ツリーポーリングのuseFilePolling呼び出しをWorktreeDetailRefactored内に配置。FileTreeViewにはポーリング関連コードを追加しない
- [ ] **F7**: useFileContentPolling.tsを新規作成し、lastModifiedRef/If-Modified-Since/304判定をフック内に完結させる。FilePanelContentからは1行で呼び出す
- [ ] **F7**: useFileContentPolling.test.tsを新規作成し、ポーリング動作のユニットテストを追加
- [ ] **F1**: ポーリング追加時にFilePanelContent内の検索ロジック（MarkdownWithSearch/CodeViewerWithSearch）に変更を加えないことを確認

### Stage 2: 整合性レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 反映箇所 |
|----|--------|---------|---------|----------|---------|
| F1 | must_fix | 整合性 | FileTab型のBefore/After型定義を明示 | 反映済 | セクション4-4をBefore/After形式に全面改訂 |
| F2 | must_fix | 整合性 | MarkdownEditorのonDirtyChange実装パターン明記 | 反映済 | セクション4-5を新設（EditorProps型変更、useEffectパターン、MarkdownWithSearch中継） |
| F3 | should_fix | 整合性 | ツリーポーリングのfetch方法修正 | 反映済 | セクション4-2のコード例をfetchDirectory→直接APIフェッチに修正、データフロー図も修正 |
| F4 | should_fix | 整合性 | Content-Lengthヘッダの不整合修正 | 反映済 | セクション4-6からContent-Length削除、アーキテクチャ図も修正 |
| F5 | should_fix | 整合性 | SET_CONTENTとMarkdownEditor再マウント競合リスク | 反映済 | セクション4-3に注意事項追記、セクション9にテスト追加 |
| F6 | should_fix | 整合性 | isActive propテストの矛盾修正 | 反映済 | セクション9のisActive propテストを削除、代替テストを記載 |
| F7 | nice_to_have | 整合性 | FilePanelTabs isDirtyインジケーターUI未詳細 | スキップ | nice_to_haveのため対象外 |
| F8 | nice_to_have | 整合性 | パフォーマンス設計のタブレンダリング前提 | スキップ | nice_to_haveのため対象外 |

### 実装チェックリスト（Stage 2指摘対応）

- [ ] **F1**: FileTab型にisDirty: booleanを追加（Before/After通りに実装）
- [ ] **F1**: FileTabsActionにSET_DIRTYアクションを追加
- [ ] **F1**: reducerのOPEN_FILE/RESTORE/SET_CONTENTでisDirty: falseを設定
- [ ] **F1**: readPersistedTabsでisDirtyを常にfalseでリストア
- [ ] **F2**: EditorProps型にonDirtyChange?: (isDirty: boolean) => voidを追加
- [ ] **F2**: MarkdownEditor内でuseEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange])を実装
- [ ] **F2**: MarkdownWithSearchコンポーネントがonDirtyChangeをMarkdownEditorに中継することを確認
- [ ] **F3**: WorktreeDetailRefactored内のツリーポーリングでfetchDirectory()ではなくfetch(`/api/worktrees/${worktreeId}/tree`)を使用
- [ ] **F4**: files APIのGETレスポンスにContent-Lengthを手動設定しない（Next.js自動設定に委任）
- [ ] **F4**: Last-Modifiedヘッダのみ追加
- [ ] **F5**: markdownファイルが開かれている状態でのポーリングSET_CONTENTがMarkdownEditorのUXに影響しないことをテストで検証
- [ ] **F6**: FileTreeView.test.tsxにisActive propテストを追加しない（不要）

### Stage 3: 影響分析レビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 反映箇所 |
|----|--------|---------|---------|----------|---------|
| F1 | must_fix | 影響範囲 | MarpEditorWithSlidesでのonDirtyChange未伝搬 | 反映済 | セクション4-5にMarpEditorWithSlides中継設計を追記、セクション6 isDirty伝搬フロー更新 |
| F2 | must_fix | 影響範囲 | FilePanelContentのmemo化とisDirty再レンダリング影響 | 反映済 | セクション4-4にmemo再レンダリング影響分析・対策方針を追記 |
| F3 | should_fix | 影響範囲 | 304応答とauto-fetchの分離設計 | 反映済 | セクション4-3にlastModifiedRef初期値の前提明記、セクション4-6に防衛的プログラミング推奨を追記 |
| F4 | should_fix | 影響範囲 | ツリーポーリングのuseMemo依存配列への影響 | 反映済 | セクション8にsetFileTreeRefreshによるuseMemo再計算の影響分析を追記 |
| F5 | should_fix | 影響範囲 | タブ切替時のlastModifiedRefライフサイクル | 反映済 | セクション4-3に注意事項追記、セクション12に将来拡張として記載 |
| F6 | should_fix | 影響範囲 | onDirtyChangeの動作検証テスト未記載 | 反映済 | セクション9のユニットテスト一覧にMarkdownEditor onDirtyChangeテストを追加 |
| F7 | nice_to_have | 影響範囲 | ツリーポーリングのサブディレクトリ検知限界 | スキップ | nice_to_haveのため対象外 |
| F8 | nice_to_have | 影響範囲 | FilePanelTabsのTabButton再レンダリング | スキップ | nice_to_haveのため対象外 |

### 実装チェックリスト（Stage 3指摘対応）

- [ ] **F1**: MarpEditorWithSlidesのprops型にonDirtyChange?: (isDirty: boolean) => voidを追加
- [ ] **F1**: MarpEditorWithSlides内部のMarkdownEditor呼び出しでonDirtyChangeを透過的に渡す
- [ ] **F1**: FilePanelContent内のMarpEditorWithSlides呼び出しにonDirtyChangeコールバックを追加
- [ ] **F2**: FilePanelContentのmemo化がisDirty変更時に重いコンポーネント（MarpPreview, CodeViewer）を不要に再レンダリングしないことをReact DevTools Profilerで確認
- [ ] **F3**: useFileContentPollingのlastModifiedRef初期値がnullであることを確認（初回リクエストにIf-Modified-Sinceを付与しない）
- [ ] **F3**: 既存auto-fetchの応答処理にstatus === 304の早期リターンを追加（防衛的プログラミング）
- [ ] **F4**: ツリーポーリングのenabled条件がFilesタブアクティブ時のみtrueであることを確認（非Filesタブ時のuseMemo再計算を回避）
- [ ] **F4**: SearchBarコンポーネントのmemo化が有効であることを確認
- [ ] **F5**: タブ切替時のlastModifiedRefリセットによる初回フル転送が許容範囲であることを確認
- [ ] **F6**: MarkdownEditor.test.tsxにonDirtyChangeコールバック検証テストを追加（編集時true、保存後false、未指定時エラーなし）

### Stage 4: セキュリティレビュー

| ID | 重要度 | カテゴリ | タイトル | 対応状況 | 反映箇所 |
|----|--------|---------|---------|----------|---------|
| F1 | should_fix | A01:2021 Broken Access Control | Last-Modifiedヘッダによるファイル更新時刻の情報漏洩 | 反映済 | セクション7 セキュリティ設計テーブルの「情報漏洩」行に認証無効環境でのリスク注記を追加 |
| F2 | should_fix | A05:2021 Security Misconfiguration | 304応答のCache-Controlヘッダ未設定によるキャッシュポイズニングリスク | 反映済 | セクション4-6の304応答と200応答にCache-Control: no-store, privateを追加、セクション7にキャッシュ制御行を追加 |
| F3 | nice_to_have | A07:2021 Identification and Authentication Failures | ポーリングAPIの認証保護の明示的な設計記述の欠如 | スキップ | nice_to_haveのため対象外 |
| F4 | nice_to_have | A06:2021 Vulnerable and Outdated Components | ポーリングAPIへのDoS耐性設計の詳細化 | スキップ | nice_to_haveのため対象外 |
| F5 | nice_to_have | A01:2021 Broken Access Control | パストラバーサル保護の継続適用に関する明示的確認 | スキップ | nice_to_haveのため対象外（既存設計で適切に対応済みと確認） |
| F6 | nice_to_have | A03:2021 Injection | JSON.stringifyによるXSSリスクの評価 | スキップ | nice_to_haveのため対象外（ReactのJSX自動エスケープで排除済みと確認） |
| F7 | should_fix | A04:2021 Insecure Design | If-Modified-Sinceヘッダの日時パース安全性の未考慮 | 反映済 | セクション4-6にisNaNチェックによるバリデーションを追加、セクション7にヘッダバリデーション行を追加 |

### 実装チェックリスト（Stage 4指摘対応）

- [ ] **F1**: セキュリティ設計の情報漏洩リスクが認証無効環境で高まることを開発チームに共有
- [ ] **F2**: files APIの304応答にCache-Control: no-store, privateヘッダを設定
- [ ] **F2**: files APIの200応答にCache-Control: no-store, privateヘッダを設定
- [ ] **F7**: If-Modified-Sinceヘッダのパース結果に対してisNaN(clientDate.getTime())チェックを実装
- [ ] **F7**: isNaN検出時に304判定をスキップし200応答（フルボディ返却）にフォールバックすることを確認
- [ ] **F7**: 結合テスト（tests/integration/api/files-304.test.ts）に不正な日時文字列のテストケースを追加（'invalid', '9999-99-99'等で200応答が返ることを検証）

---

*Generated by /design-policy command for Issue #469*
*Date: 2026-03-11*
*Updated: 2026-03-11 (Stage 4 セキュリティレビュー指摘反映)*
