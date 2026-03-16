# Issue #505 レビューレポート

**レビュー日**: 2026-03-16
**フォーカス**: 通常レビュー（Consistency & Correctness）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |
| **合計** | **8** |

---

## Must Fix（必須対応）

### F1-001: rehype-sanitize が a タグの href を除去する可能性

**カテゴリ**: 技術的妥当性
**場所**: 提案する解決策 > 1. ファイル内リンク対応 > Markdownプレビュー

**問題**:
MarkdownPreview.tsx は rehype-sanitize をデフォルトスキーマで使用している（SEC-MF-001）。react-markdown の a タグカスタムコンポーネントを追加しても、rehype-sanitize が先に処理を行い、相対パスの href 属性を除去またはサニタイズする可能性がある。これにより、カスタムコンポーネントが href を受け取れず、リンク機能が動作しない。

**証拠**:
- `src/components/worktree/MarkdownPreview.tsx:83` で `rehypeSanitize` がデフォルトスキーマで使用されている
- デフォルトスキーマでは相対パスリンクが許可されている場合もあるが、スキームなしの相対パスの扱いはスキーマ設定に依存する

**推奨対応**:
実装タスクに「rehype-sanitize スキーマの調整（a タグ href の相対パス許可）」を追加し、変更対象ファイルの MarkdownPreview.tsx の変更内容にも反映すべき。

---

### F1-002: MarkdownPreview に onOpenFile コールバックを渡す経路が未定義

**カテゴリ**: 整合性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
現在の MarkdownPreview コンポーネントは `{ content: string }` のみを props として受け取る。a タグカスタムコンポーネントからファイルタブを開くには、以下のコンポーネント階層全体にコールバックを伝播させる必要がある:

```
WorktreeDetailRefactored -> FilePanelSplit -> FilePanelTabs -> FilePanelContent -> MarkdownEditor -> MarkdownPreview
```

Issue の変更対象ファイル一覧には `MarkdownEditor.tsx` と `WorktreeDetailRefactored.tsx` が含まれておらず、この伝播経路の設計が欠落している。

**証拠**:
- `MarkdownPreview` の props は `{ content: string }` のみ（MarkdownPreview.tsx:38-41）
- `MarkdownEditor` は `MarkdownPreview` を呼び出す（MarkdownEditor.tsx:784,801）が `onOpenFile` 的な props は存在しない
- `FilePanelContent` も `MarkdownEditor` に `onOpenFile` を渡す仕組みがない

**推奨対応**:
変更対象ファイル一覧に `MarkdownEditor.tsx` と `WorktreeDetailRefactored.tsx` を追加すべき。または、Context API（例: FileTabsContext）を使ってコンポーネント階層を横断的にコールバックを提供する方法を検討し、設計に明記すべき。

---

## Should Fix（推奨対応）

### F1-003: タブ上限到達時のリンククリック動作が未定義

**カテゴリ**: 明確性
**場所**: 受入条件

**問題**:
タブ上限を30に引き上げても、30タブ開いた状態でリンクをクリックした際の動作が受入条件に含まれていない。

**推奨対応**:
受入条件に「タブ上限到達時にリンクをクリックした場合のフィードバック（Toast通知等）」を追加するか、LRU方式で最も古いタブを自動的に閉じる動作を検討すべき。

---

### F1-004: 「先頭5タブ」の定義と移動ロジックの曖昧さ

**カテゴリ**: 明確性
**場所**: 提案する解決策 > 2. タブUI改善

**問題**:
以下の点が曖昧:
1. 「先頭」がインデックス0への挿入なのか、表示領域の左端5つなのか
2. アクティブタブが6番目以降にある場合にタブバーに表示されるのか
3. `useFileTabs` の reducer には MOVE_TO_FRONT のようなアクションが存在せず、新規追加が必要

**推奨対応**:
以下を明記すべき:
- ドロップダウン選択時にタブ配列のインデックス0に移動するのか
- アクティブタブは常にタブバーに表示するのか（4+アクティブ方式）
- `useFileTabs` の reducer に必要な新規アクション（MOVE_TO_FRONT 等）の定義

---

### F1-005: HTMLプレビューの postMessage セキュリティ考慮が不足

**カテゴリ**: 完全性
**場所**: 提案する解決策 > 1. ファイル内リンク対応 > HTMLプレビュー

**問題**:
- `sandbox=''`（safe モード）ではスクリプトが実行できないため、postMessage は使えない
- safe モードでのリンク対応方法が未記載
- postMessage の origin チェックやメッセージスキーマ検証のセキュリティ要件がない

**推奨対応**:
- safe モードと interactive モードそれぞれのリンク対応方式を明記
- safe モードでは対応不可であることを明示するか、`allow-top-navigation-by-user-activation` の追加を検討
- postMessage 使用時の origin 検証・メッセージスキーマ検証の要件を追記

---

### F1-006: 相対パスの解決方法が未定義

**カテゴリ**: 完全性
**場所**: 提案する解決策 > 1. ファイル内リンク対応

**問題**:
「相対パスリンクをファイルタブとして開く」とあるが、相対パスの基準ディレクトリの決定方法、パストラバーサル防止、存在しないファイルのエラーハンドリングが未定義。現在の MarkdownPreview は `content` (string) のみ受け取り、ファイルパス情報を持たない。

**推奨対応**:
以下を明記すべき:
1. 相対パス解決の基準ディレクトリ（現在表示中のファイルの所在ディレクトリが自然）
2. パストラバーサル防止（worktree ルート外へのアクセス禁止）
3. 存在しないファイルへのリンクの動作（エラー表示等）

---

## Nice to Have（あれば良い）

### F1-007: トースト通知メッセージのハードコード値更新

**カテゴリ**: 完全性
**場所**: 影響範囲 > 変更対象ファイル

**問題**:
`WorktreeDetailRefactored.tsx:476` に `'Maximum 5 file tabs. Close a tab first.'` というハードコードされたメッセージがある。MAX_FILE_TABS を30に変更する場合、このメッセージも更新が必要。

**推奨対応**:
変更対象ファイルに `WorktreeDetailRefactored.tsx` を追加し、Toast メッセージを `MAX_FILE_TABS` 定数から動的に生成するか、数値を30に更新する。

---

### F1-008: アンカーリンクやフラグメント (#) への対応が未記載

**カテゴリ**: 完全性
**場所**: 提案する解決策 > 1. ファイル内リンク対応

**問題**:
Markdown 内の見出しリンク（`#section-name`）やページ内アンカーへの対応が未考慮。同一ファイル内のアンカーリンクをクリックした場合、新しいタブを開くのではなくスクロールさせる動作が自然だが、この区別が記載されていない。

**推奨対応**:
`#` で始まるリンクはページ内スクロールとして扱い、ファイルタブを開かないロジックを実装タスクに追加することを推奨。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownPreview.tsx` | a タグカスタムコンポーネント追加対象。rehype-sanitize との相互作用が重要 |
| `src/components/worktree/HtmlPreview.tsx` | postMessage 監視追加対象。sandbox 設定との整合性が必要 |
| `src/hooks/useFileTabs.ts` | MAX_FILE_TABS 変更対象。reducer にタブ移動アクション追加が必要 |
| `src/components/worktree/FilePanelTabs.tsx` | ドロップダウンUI追加対象 |
| `src/components/worktree/MarkdownEditor.tsx` | MarkdownPreview にコールバックを渡す中間層（変更対象ファイルに未記載） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | fileTabs.openFile コールバックの起点・Toast メッセージ更新（変更対象ファイルに未記載） |
| `src/config/html-extensions.ts` | SANDBOX_ATTRIBUTES 定義。sandbox レベルによる postMessage 可否に影響 |
