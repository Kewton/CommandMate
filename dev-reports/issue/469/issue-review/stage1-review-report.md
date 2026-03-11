# Issue #469 Stage 1 レビューレポート

**レビュー日**: 2026-03-11
**フォーカス**: 通常レビュー（整合性・正確性・実装の明確性）
**ステージ**: 1回目
**総合評価**: Good（問題記述は正確だが、対策案の実装詳細に補完が必要）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue本文の問題分析（現状の問題セクション）は仮説検証で全て確認済みであり、正確かつ的確な記述である。対策案A/B/Cの方向性も妥当である。ただし、実装に着手するにあたり、差分検知方法・編集中保護の設計・ポーリング間隔の具体値について明確化が必要である。

---

## Should Fix（推奨対応）

### SF-1: ポーリング間隔が「5-10秒」と幅があり、具体的な初期値が未定義

**カテゴリ**: 明確性
**場所**: 対策案A・対策案B

**問題**:
案A・案Bともにポーリング間隔が「5-10秒」と範囲で記載されている。実装時にどの値を採用するか、またユーザー設定可能にするかの判断基準がない。既存のターミナルポーリングは `CACHE_TTL_MS = 2000`（2秒）で固定されており（`src/lib/tmux-capture-cache.ts:36`）、ファイルツリーポーリングとの整合性も考慮が必要。

**推奨対応**:
初期値を明示する（例: 5秒）。定数として `FILE_TREE_POLL_INTERVAL_MS = 5000`、`FILE_CONTENT_POLL_INTERVAL_MS = 5000` のように定義し、将来的にユーザー設定可能にするかどうかも記載する。

---

### SF-2: 案Aの「ルートディレクトリのレスポンスハッシュ比較」の実装方法が不明確

**カテゴリ**: 技術的妥当性
**場所**: 対策案A

**問題**:
「ルートディレクトリのレスポンスハッシュ比較で変更有無を判定」と記載されているが、現在のTree API（`GET /api/worktrees/:id/tree`）は `TreeResponse` にハッシュやETag等のメタデータを返していない（`src/types/models.ts:262-271` の `TreeResponse` 型を確認）。クライアント側でJSONをシリアライズしてハッシュ計算するのか、サーバー側でハッシュヘッダを返すのかが不明。

**証拠**:
- `src/app/api/worktrees/[id]/tree/route.ts`: `NextResponse.json(result)` のみ返却、ETag/ハッシュヘッダなし
- `src/types/models.ts`: `TreeResponse` 型に hash/etag フィールドなし

**推奨対応**:
差分検知の具体的な方法を明記する。推奨: (1) クライアント側で `JSON.stringify(rootItems)` のハッシュを保持し前回値と比較する簡易方式、または (2) サーバー側でETagヘッダを返し `If-None-Match` で304を返すHTTP標準方式。

---

### SF-3: 案Bの「編集中の保護」の具体的な判定方法が未記載

**カテゴリ**: 完全性
**場所**: 対策案B、受け入れ条件

**問題**:
受け入れ条件に「ユーザーが編集中のファイルは自動更新で上書きされない」とあるが、`FilePanelContent` から `MarkdownEditor` の `isDirty` 状態を取得する方法が記載されていない。現在の `MarkdownEditor` は `isDirty` 状態を内部で管理しており（`content !== originalContent`、line 202）、`FilePanelContent` 側からは参照できない。また、`useFileTabs` の `FileTab` 型にも unsaved/dirty 状態のフィールドが存在しない。

**証拠**:
- `src/components/worktree/MarkdownEditor.tsx:202`: `const isDirty = content !== originalContent;`（内部状態のみ）
- `src/hooks/useFileTabs.ts:36-47`: `FileTab` 型に `isDirty` フィールドなし

**推奨対応**:
編集中検知の設計を追加する。選択肢:
1. `FileTab` 型に `isDirty` フィールドを追加し `MarkdownEditor` から伝搬
2. `FilePanelContent` が `onDirtyChange` コールバックを受け取りポーリングスキップ判定に使用
3. `MarkdownEditor` が表示されている場合（`.md` ファイル）はポーリングを一律スキップ（簡易方式）

`useFileTabs.ts` の変更も関連ファイルに含めるべき。

---

### SF-4: 案Bのmtime/sizeヘッダが「オプション」だが、負荷軽減の基本設計に関わる

**カテゴリ**: 完全性
**場所**: 対策案B

**問題**:
「サーバー側でファイルのmtime/sizeをレスポンスヘッダに含め、変更がなければ内容取得をスキップ（軽量チェック）」が「オプション」とされている。しかし、この軽量チェックなしでは毎回ファイル全体を取得することになり、受け入れ条件の「ポーリングによるサーバー負荷が許容範囲内（不要な再取得を避ける）」を満たすことが困難になる。

**証拠**:
- `src/app/api/worktrees/[id]/files/[...path]/route.ts`: テキストファイルのGETハンドラは `stat()` を呼んでいない（動画ファイルのみ `stat()` でサイズチェック、line 211）

**推奨対応**:
mtime/sizeによる軽量チェックを「オプション」ではなく基本設計に含める。HTTP標準の `Last-Modified` / `If-Modified-Since` による条件付きリクエストが望ましい。

---

## Nice to Have（あれば良い）

### NTH-1: FileViewer.tsx（モーダル表示）のスコープが不明

**カテゴリ**: 完全性
**場所**: 関連ファイル

関連ファイルに `FileViewer.tsx` が含まれているが、対策案では `FilePanelContent`（タブ表示）のみ言及されている。`FileViewer` はモーダル表示のファイルビューアであり、スコープ内かスコープ外かを明記すべき。

---

### NTH-2: ポーリングのライフサイクル管理について詳細な記載がない

**カテゴリ**: 完全性
**場所**: 対策案A・B

以下のライフサイクル考慮事項の追記を推奨:
1. Filesタブからの切り替え時の `setInterval` クリア
2. `document.visibilitychange` API によるブラウザタブのバックグラウンド時のポーリング停止
3. `useEffect` のクリーンアップでの interval クリア

---

### NTH-3: 関連ファイルにFilePanelSplit.tsx・FilePanelTabs.tsxが含まれていない

**カテゴリ**: 整合性
**場所**: 関連ファイル

`FilePanelSplit.tsx` はターミナルとファイルパネルの分割表示を管理しており、Filesタブのアクティブ状態判定に関与する可能性がある。影響がない場合でも理由を記載すると良い。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/FileTreeView.tsx:594-666` | refreshTrigger依存のuseEffect - ポーリング追加箇所 |
| `src/components/worktree/FilePanelContent.tsx:646-678` | 初回fetchのみ - 自動リフレッシュ追加箇所 |
| `src/components/worktree/MarkdownEditor.tsx:202` | isDirty状態 - 編集中保護の判定元 |
| `src/hooks/useFileTabs.ts:36-47` | FileTab型 - isDirtyフィールド追加候補 |
| `src/components/worktree/WorktreeDetailRefactored.tsx:1096` | fileTreeRefresh状態管理 |
| `src/app/api/worktrees/[id]/tree/route.ts` | ツリーAPI - ETag未対応 |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | ファイルAPI - mtime未返却 |
| `src/types/models.ts:244-271` | TreeItem/TreeResponse型 |
| `src/lib/tmux-capture-cache.ts:36` | CACHE_TTL_MS=2000（既存ポーリング参考値） |
