# Issue #505 レビューレポート

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 2回目
**ステージ**: 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

## 前回指摘事項の対応状況

### Stage 3 指摘事項（F3-001 ~ F3-012）: 全12件対応済み

全ての Stage 3 指摘事項が Issue 本文に反映されている。特に以下の点が適切に対応されている:

- FilePanelSplit.tsx, FilePanelTabs.tsx, EditorProps の onOpenFile 伝播が変更対象ファイル表とコールバック伝播経路図に含まれている
- テスト計画が具体的なテストケースレベルで列挙されている（useFileTabs: 10項目, FilePanelTabs: 4項目）
- postMessage メッセージスキーマが `commandmate:link-click` として型定義されている
- MarkdownWithSearch, MarpEditorWithSlides への伝播がコールバック伝播経路図に含まれている
- デスクトップビューのみ対象がスコープに明記されている

### Stage 5 指摘事項（F5-001 ~ F5-005）: 全5件対応済み

全ての Stage 5 指摘事項が Issue 本文に反映されている:

- MarkdownPreview に currentFilePath props が追加され、伝播経路に記載されている
- HtmlPreview に onOpenFile コールバック props が追加されている
- rehype plugin 実行順序の注意事項が実装タスクとテスト計画に含まれている
- ACTIVATE_TAB / MOVE_TO_FRONT の使い分けが明確に記載されている
- split モードでの postMessage リスナー設計が明記されている

---

## Should Fix（推奨対応）

### F7-001: HtmlIframePreview サブコンポーネントへの srcDoc スクリプト注入の責務分離が不明確

**カテゴリ**: 影響ファイル漏れ
**場所**: HtmlPreview.tsx 内部設計

**問題**:
Issue のコールバック伝播経路では HtmlPreview.tsx に onOpenFile props を追加することが記載されているが、内部の HtmlIframePreview サブコンポーネントとの責務分離が不明確。現在の HtmlIframePreview は `srcDoc={htmlContent}` を直接渡しているだけであり、リンク検知スクリプトの注入を HtmlPreview 側で行うのか HtmlIframePreview 側で行うのかが定まっていない。

**証拠**:
- `src/components/worktree/HtmlPreview.tsx` 行88-107: HtmlIframePreview は `{ htmlContent, sandboxLevel, filePath }` のみを受け取り、`srcDoc={htmlContent}` をそのまま渡している
- Issue の実装タスクでは「HtmlIframePreview の srcDoc にスクリプトを注入」と記載されているが、注入のロジック配置が曖昧

**推奨対応**:
実装タスクに「HtmlPreview コンポーネント内で htmlContent にスクリプトを注入した上で HtmlIframePreview に渡す」という設計方針を明記する。または HtmlIframePreview の props 拡張を検討する。

---

### F7-002: HtmlPreview の postMessage 統合テストがテスト計画に含まれていない

**カテゴリ**: テスト範囲
**場所**: テスト計画セクション

**問題**:
テスト計画には useFileTabs.test.ts と FilePanelTabs.test.tsx のテストケースが列挙されているが、HtmlPreview.tsx 固有のテストファイルの言及がない。postMessage の origin 検証・スキーマ検証テストが useFileTabs.test.ts に含まれているが、これらは HtmlPreview コンポーネントの統合テストとして独立したテストファイルで実施すべき内容。

**証拠**:
- テスト計画に列挙されているテストファイルは `useFileTabs.test.ts` と `FilePanelTabs.test.tsx` の2つのみ
- 変更対象ファイル表の HtmlPreview.tsx には多数のセキュリティ要件（origin 検証、スキーマ検証、useEffect クリーンアップ、split モードのリスナー管理）があるが、対応するテストファイルが未定義

**推奨対応**:
テスト計画に `tests/unit/components/HtmlPreview.test.tsx` を追加し、postMessage 受信テスト、origin 検証テスト、スキーマ検証テスト、クリーンアップテスト、safe モードでのリスナー非登録テストを含める。

---

### F7-003: Toast メッセージのハードコードが2箇所に散在

**カテゴリ**: 影響ファイル漏れ
**場所**: WorktreeDetailRefactored.tsx 行476, 行494

**問題**:
WorktreeDetailRefactored.tsx 内の `handleFilePathClick`（行476）と `handleFileSelect`（行494）の2箇所で `'Maximum 5 file tabs. Close a tab first.'` が個別にハードコードされている。Issue の実装タスクでは「Toast メッセージの MAX_FILE_TABS 対応」と記載されているが、2箇所の変更が必要であることが明示されていない。

**証拠**:
- 行476: `showToast('Maximum 5 file tabs. Close a tab first.', 'info');`
- 行494: `showToast('Maximum 5 file tabs. Close a tab first.', 'info');`

**推奨対応**:
実装タスクを「handleFilePathClick と handleFileSelect の2箇所で MAX_FILE_TABS を参照した動的メッセージに変更」と具体化する。または Toast メッセージを定数化して一元管理する。

---

## Nice to Have（あれば良い）

### F7-004: クライアントサイドでの相対パス解決における path モジュール非使用

**カテゴリ**: 依存関係
**場所**: 実装タスク - 相対パス解決

**問題**:
Issue では相対パス解決に `path.resolve` 等で正規化すると記載されているが、MarkdownPreview はクライアントサイド（ブラウザ）で実行されるため Node.js の `path` モジュールは利用できない。また、Issue でパストラバーサル防止に活用すると記載されている `src/lib/security/path-validator.ts` はサーバーサイドモジュールであり、クライアントサイドからは直接利用できない。

**推奨対応**:
実装タスクにクライアントサイドで使用可能なパス解決方法（`new URL()` ベースや文字列操作ベースのユーティリティ）を作成する旨を注記として追加する。代替案として、ファイルオープン時の API 呼び出しでサーバーサイドのバリデーションが働くため、クライアントサイドでは基本的な正規化のみ行う設計も検討に値する。

---

### F7-005: onOpenFile コールバックの戻り値型

**カテゴリ**: 完全性
**場所**: コールバック伝播経路

**問題**:
`onOpenFile` コールバックは `(path: string) => void` として定義されており、`fileTabs.openFile()` の戻り値（`'opened' | 'activated' | 'limit_reached'`）を呼び出し元に返すことができない。現時点では WorktreeDetailRefactored 側で Toast 通知が行われるため実用上の問題はないが、将来的にリンク要素での視覚フィードバック（成功/失敗表示）を実装する場合に制約となる。

**推奨対応**:
現時点では void 型で問題ない。将来的なニーズが出た場合に型を拡張すればよい。

---

## 総合評価

Issue #505 は Stage 3 および Stage 5 の全指摘事項（計17件）が適切に反映されており、影響範囲の記載品質は高い。コールバック伝播経路図が詳細に記載されており、変更対象ファイル表も12ファイルを網羅している。セキュリティ考慮事項も充実しており、postMessage スキーマ、origin 検証、パストラバーサル防止、useEffect クリーンアップがすべて明記されている。

今回の Stage 7 で検出された指摘は主に実装時の詳細設計レベルの補足事項であり、must_fix 相当の重大な欠落は見当たらない。

---

## 参照ファイル

### コード
- `src/components/worktree/HtmlPreview.tsx`: HtmlIframePreview の srcDoc 注入責務（F7-001）、postMessage テスト対象（F7-002）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: Toast メッセージ 2箇所のハードコード（F7-003、行474-477、行492-497）
- `src/components/worktree/MarkdownPreview.tsx`: クライアントサイド相対パス解決（F7-004）
- `src/lib/security/path-validator.ts`: サーバーサイドパスバリデーション（F7-004）
