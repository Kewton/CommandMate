# Issue #505 レビューレポート（Stage 5）

**レビュー日**: 2026-03-16
**フォーカス**: 通常レビュー（2回目）
**ステージ**: 5（通常レビュー 2nd iteration）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |
| **合計** | **5** |

## 前回レビュー指摘事項の対応状況

### Stage 1（通常レビュー 1回目）: 全8件 -- 全て対応済み

| ID | タイトル | 対応状況 |
|----|---------|---------|
| F1-001 | rehype-sanitize の href 除去問題 | 対応済み: カスタムスキーマ作成がソリューション・タスク・受入条件すべてに記載 |
| F1-002 | onOpenFile コールバック伝播経路未定義 | 対応済み: 伝播経路が図示され、変更対象ファイルに追加 |
| F1-003 | タブ上限到達時の動作未定義 | 対応済み: Toast 通知が受入条件に追加 |
| F1-004 | 先頭5タブの定義と移動ロジックの曖昧さ | 対応済み: MOVE_TO_FRONT アクション・アクティブタブ表示保証が明記 |
| F1-005 | postMessage セキュリティ考慮不足 | 対応済み: safe/interactive モード別対応・origin 検証が詳細に記載 |
| F1-006 | 相対パス解決方法未定義 | 対応済み: 基準ディレクトリ・正規化・パストラバーサル防止・エラーハンドリングが明記 |
| F1-007 | Toast 通知メッセージのハードコード値 | 対応済み: WorktreeDetailRefactored.tsx が変更対象に追加 |
| F1-008 | アンカーリンク対応未記載 | 対応済み: # リンクのスクロール処理が受入条件に追加 |

### Stage 3（影響範囲レビュー 1回目）: 全12件 -- 全て対応済み

| ID | タイトル | 対応状況 |
|----|---------|---------|
| F3-001 | FilePanelSplit.tsx 未記載 | 対応済み |
| F3-002 | FilePanelTabs.tsx の onOpenFile 伝播 | 対応済み |
| F3-003 | EditorProps に onOpenFile 追加 | 対応済み |
| F3-004 | useFileTabs.test.ts テスト具体化 | 対応済み: テスト計画セクション追加 |
| F3-005 | FilePanelTabs.test.tsx テスト不足 | 対応済み: テストケース列挙 |
| F3-006 | postMessage スキーマ未定義 | 対応済み: CommandMateLinkClickMessage 型定義追加 |
| F3-007 | localStorage への MAX_FILE_TABS 変更影響 | 対応済み（認識済み、現設計で十分） |
| F3-008 | MarkdownWithSearch への伝播 | 対応済み |
| F3-009 | srcDoc へのスクリプト注入 | 対応済み: 具体的手順記載 |
| F3-010 | i18n 未対応 | 対応済み（既存パターン踏襲） |
| F3-011 | postMessage リスナーのライフサイクル | 対応済み: useEffect クリーンアップ・event.source 記載 |
| F3-012 | モバイルビュー未定義 | 対応済み: デスクトップのみスコープと明記 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F5-001: MarkdownPreview に currentFilePath props が必要だが Issue の記載に不足

**カテゴリ**: 整合性
**場所**: コールバック伝播経路セクション

**問題**:
Issue では MarkdownPreview に `onOpenFile` コールバックを渡すことが記載されているが、相対パスを解決するには「現在表示中のファイルのパス」情報も MarkdownPreview に渡す必要がある。現在の `MarkdownPreviewProps` は `{ content: string }` のみ。相対パス解決の基準ディレクトリを算出するために `currentFilePath` も追加しなければならないが、コールバック伝播経路には `onOpenFile` のみ記載されている。

**証拠**:
- `src/components/worktree/MarkdownPreview.tsx:38-41`: `MarkdownPreviewProps` は `{ content: string }` のみ
- Issue の相対パス解決ルールでは「現在表示中のファイルの所在ディレクトリ」を基準と定義
- コールバック伝播経路に `currentFilePath` の伝播が含まれていない

**推奨対応**:
コールバック伝播経路に `onOpenFile` と並んで `currentFilePath` (string) の伝播を追加する。MarkdownEditor は既に `filePath` props を持っているため伝播は容易だが、Issue に明記されていないと実装時に見落とされる可能性がある。

---

#### F5-002: HtmlPreview への onOpenFile コールバック伝播が変更対象ファイル表で不足

**カテゴリ**: 整合性
**場所**: 影響範囲 > 変更対象ファイル > HtmlPreview.tsx

**問題**:
変更対象ファイル表の HtmlPreview.tsx の変更内容には「srcDoc スクリプト注入、postMessage 監視、origin 検証、useEffect クリーンアップ」が記載されているが、postMessage を受信した後にファイルタブを開くための `onOpenFile` コールバック props の追加が記載されていない。現在の `HtmlPreviewProps` には `onOpenFile` が存在しない。

**証拠**:
- `src/components/worktree/HtmlPreview.tsx:30-36`: `HtmlPreviewProps` に `onOpenFile` がない
- `src/components/worktree/FilePanelContent.tsx:681-686`: HtmlPreview に渡している props に `onOpenFile` がない
- postMessage 受信後のファイルオープンにはコールバックが不可欠

**推奨対応**:
- 変更対象ファイル表の HtmlPreview.tsx の変更内容に「onOpenFile コールバック props 追加」を追記
- 実装タスクに HtmlPreviewProps への onOpenFile 追加を追加
- FilePanelContent.tsx の isHtml ブロックで HtmlPreview に onOpenFile を渡す変更も含める

---

#### F5-003: rehype-sanitize の plugin 実行順序への注意が未記載

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク > rehype-sanitize カスタムスキーマ作成

**問題**:
現在の MarkdownPreview の rehypePlugins は `[rehypeSanitize, rehypeHighlight]` の順で指定されている。カスタムスキーマを適用して `a` タグの `href` を許可する際、この実行順序が正しく機能するか（sanitize が先に実行され、その後 highlight が実行される）の確認が実装タスクに含まれていない。react-markdown の components は rehype 処理後の AST に適用されるため、スキーマ設定が正しければ問題ないが、実装者への注意喚起として順序依存性を明記すると安全。

**推奨対応**:
実装タスクの rehype-sanitize カスタムスキーマ作成タスクに「rehype plugin の実行順序（sanitize -> highlight）を確認し、a タグの href がサニタイズ後も保持されることをテストで検証する」旨を注記として追加。

---

### Nice to Have（あれば良い）

#### F5-004: ACTIVATE_TAB と MOVE_TO_FRONT の使い分けが曖昧

**カテゴリ**: 明確性
**場所**: 提案する解決策 > 2. タブUI改善

**問題**:
新たに `MOVE_TO_FRONT` アクションを追加するが、通常のタブバー内クリックでは `ACTIVATE_TAB`（順序変更なし）を使い、ドロップダウンからの選択時のみ `MOVE_TO_FRONT`（先頭移動）を使うのかが明確に書かれていない。テスト計画には「ドロップダウン選択時に MOVE_TO_FRONT が dispatch される」とあるが、タブバー内クリック時の動作との対比が不足。

**推奨対応**:
「タブバー内の先頭5タブをクリック -> ACTIVATE_TAB（順序維持）」「ドロップダウンからの選択 -> MOVE_TO_FRONT（先頭移動）」という使い分けを明記する。

---

#### F5-005: split ビューモードでの HtmlIframePreview の postMessage 重複

**カテゴリ**: 完全性
**場所**: セキュリティ考慮事項

**問題**:
HtmlPreview の split ビューモードでは HtmlIframePreview が2つレンダリングされる。postMessage リスナーは HtmlPreview コンポーネント単位で1つ登録すれば良いが、2つの iframe からのメッセージをどう扱うかが記載されていない。

**推奨対応**:
split モードでは同じ htmlContent を表示するため、どちらの iframe からのクリックも同じ結果になる。HtmlPreview コンポーネント単位でリスナーを1つ登録し、メッセージスキーマ検証のみで十分という設計判断を記載すると良い。

---

## 総合評価

Issue #505 は Stage 1-4 を経て大幅に改善されており、前回の全20件の指摘事項（Stage 1: 8件、Stage 3: 12件）が全て適切に対応されている。特に以下の点が優れている:

1. **コールバック伝播経路の図示**: コンポーネント階層全体の伝播経路が明確に文書化されている
2. **postMessage セキュリティ設計**: メッセージスキーマの型定義、namespace prefix、origin 検証が具体的
3. **テスト計画の具体性**: テストケースが個別に列挙されており、実装者が迷わない
4. **スコープの明確化**: デスクトップのみを対象とすることが明記されている

新規の指摘事項は must_fix が0件であり、Issue の品質は高い水準にある。should_fix の3件はいずれもコールバック伝播に関する記載の補完であり、実装時に気づいて対応可能な範囲ではあるが、Issue の完全性を高めるために対応を推奨する。

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownPreview.tsx` | currentFilePath props 追加が必要（F5-001） |
| `src/components/worktree/HtmlPreview.tsx` | onOpenFile props 追加が必要（F5-002） |
| `src/components/worktree/FilePanelContent.tsx` | HtmlPreview への onOpenFile 伝播が必要（F5-002） |
| `src/components/worktree/MarkdownEditor.tsx` | filePath を MarkdownPreview に伝播する中間層（F5-001） |
| `src/types/markdown-editor.ts` | EditorProps に onOpenFile 追加予定（F5-002） |
| `src/hooks/useFileTabs.ts` | ACTIVATE_TAB と MOVE_TO_FRONT の使い分け（F5-004） |
