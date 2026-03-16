# Issue #506 レビューレポート

**レビュー日**: 2026-03-16
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue全体の方向性は適切であり、背景・課題の説明も明確です。ただし、Toast通知の実現方法に関する設計上の問題が1件あり、既存アーキテクチャとの整合性の観点から解決が必要です。

---

## Must Fix（必須対応）

### MF-1: Toast通知の実現方法が設計上不明確

**カテゴリ**: 整合性
**場所**: 提案する解決策 / 実装タスク

**問題**:
受入条件に「同期成功/失敗時にフィードバックが表示される」とあり、実装タスクに「Toast通知等」と記載されていますが、現在のSidebar.tsxにはToast表示の仕組みがありません。

既存のToast利用パターン（MarkdownEditor, LogViewer, WorktreeDetailRefactored）では、各コンポーネント内でuseToast+ToastContainerを配置するローカル方式を採用しています。Sidebar.tsxはmemo化されたコンポーネントであり、内部にToastContainerを追加するとレイアウトに影響する可能性があります。

**証拠**:
- `MarkdownEditor.tsx` (L36, L139, L808): ローカルuseToast+ToastContainer
- `WorktreeDetailRefactored.tsx` (L78, L463, L1599): 同上
- `Sidebar.tsx`: Toast関連のimportは一切なし

**推奨対応**:
以下のいずれかの方針を明記してください。
1. Sidebar.tsx内にToastContainer+useToastを追加する（レイアウト影響の検討が必要）
2. グローバルToast Contextを導入する（影響範囲が広い）
3. Toastではなくボタン上のインラインフィードバック（アイコン変化等）に限定する

---

## Should Fix（推奨対応）

### SF-1: syncAndRefresh関数の配置場所の妥当性

**カテゴリ**: 完全性
**場所**: 主要な変更点

**問題**:
WorktreeSelectionContextにsyncAndRefresh関数を追加する案ですが、既存のContextはworktree一覧の取得・選択のみを責務としており、repositoryApiへの依存がありません。リポジトリ同期はrepositoryApiの責務であり、Contextの責務範囲を超える可能性があります。

**証拠**:
- `WorktreeSelectionContext.tsx`: worktreeApiのみimport、repositoryApiの依存なし
- `WorktreeList.tsx` (L335): Refreshはcontext外でfetchWorktrees()を直接呼び出し
- `RepositoryManager.tsx` (L162): repositoryApi.syncを個別に呼び出し

**推奨対応**:
Sidebar.tsx内のローカルハンドラとして実装し、sync完了後にrefreshWorktrees()を呼ぶ方が既存の責務分離と整合します。Contextへの追加が必要な場合は、その理由（他のコンポーネントからも同期を呼びたい等）を明記してください。

---

### SF-2: 受入条件の曖昧さ（手動 vs 自動）

**カテゴリ**: 明確性
**場所**: 受入条件

**問題**:
「新しく作成したworktreeがリロードなしでサイドバーに反映される」という受入条件は、ボタンクリックによる手動同期を前提としているのか、自動検知を前提としているのか曖昧です。

**証拠**:
- 背景・課題: 「手動同期の手段が必要」 -- 手動操作の意図
- 受入条件: 「リロードなしで反映」 -- 自動同期とも解釈可能

**推奨対応**:
「同期ボタンをクリックすることで、新しく作成したworktreeがリロードなしでサイドバーに反映される」と明確化してください。

---

### SF-3: モバイル表示での同期ボタンの扱い

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
モバイルドロワー内でもSidebarコンポーネントが使用されていますが、モバイル表示時の同期ボタンの動作・表示については言及がありません。

**証拠**:
- `AppShell.tsx` L85: デスクトップ用Sidebar
- `AppShell.tsx` L113: モバイルドロワー用Sidebar

**推奨対応**:
モバイルドロワー内でも同期ボタンが正しく動作することを受入条件またはテスト項目に追加してください。

---

### SF-4: 同期ボタンの連打防止

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク

**問題**:
sync APIはリポジトリのファイルシステムスキャンを伴う重い処理であり、連打防止策についての記載がありません。

**証拠**:
- `WorktreeList.tsx` L335: `disabled={loading}` で連打防止を実装済み

**推奨対応**:
ローディング中のボタンdisabled化を実装タスクに明記してください（ローディング表示の一環として暗黙的に含まれる可能性はありますが、明示が望ましい）。

---

## Nice to Have（あれば良い）

### NTH-1: ホーム画面Refreshボタンとの機能的な違いの明記

**カテゴリ**: 完全性
**場所**: 背景・課題

**問題**:
Issueでは「ホーム画面にはRefreshボタンがあるが、サイドバーには同等の機能がない」と記載されていますが、実際にはホームのRefreshボタンはDB上のworktree一覧を再取得するだけであり、今回のサイドバー同期ボタンはファイルシステムスキャン+DB同期+一覧再取得を行う点で機能が異なります。

**推奨対応**:
「同等の機能」ではなく「DB同期を含む同期機能」であることを明記すると、実装者の理解が明確になります。

---

### NTH-2: i18n対応の記載

**カテゴリ**: 完全性
**場所**: 実装タスク

**問題**:
プロジェクトはnext-intlを使用しており、Sidebar.tsx内ではLocaleSwitcherも使用されていますが、新規ボタンのaria-labelやToastメッセージのi18n対応についての記載がありません。

**推奨対応**:
i18n対応の要否を実装タスクに追加するとよいでしょう。

---

## 参照ファイル

### コード
- `src/components/layout/Sidebar.tsx`: 同期ボタン追加先のメインコンポーネント
- `src/contexts/WorktreeSelectionContext.tsx`: syncAndRefresh関数の追加先として提案されているContext
- `src/components/worktree/WorktreeList.tsx`: 既存のRefreshボタン実装（整合性確認用）
- `src/app/api/repositories/sync/route.ts`: 同期APIエンドポイント（既存・変更なし）
- `src/lib/api-client.ts`: repositoryApi.sync関数の定義（既存）
- `src/components/common/Toast.tsx`: Toast通知コンポーネント・useToastフック
- `src/components/layout/AppShell.tsx`: Sidebarの配置（デスクトップ+モバイルドロワー）
- `src/contexts/SidebarContext.tsx`: サイドバー状態管理Context

### ドキュメント
- `CLAUDE.md`: プロジェクト構成・モジュール一覧の整合性確認
