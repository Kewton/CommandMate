# Issue #469 レビューレポート - Stage 7

**レビュー日**: 2026-03-11
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 1 |

**総合評価**: good

Stage 3（影響範囲レビュー1回目）で指摘した8件の指摘事項のうち、must_fix 2件・should_fix 4件が全て適切にIssue本文に反映されている。nice_to_have 2件は実装後対応として認識されており問題なし。Stage 5で追加された2件のshould_fixも反映済み。

2回目の影響範囲レビューでは、Stage 5で新たに導入されたuseFilePollingカスタムフックの設計に関連する追加的な影響範囲の指摘が中心となった。いずれもmust_fixではなく、Issue全体の品質は十分に高い。

---

## 前回指摘事項の反映状況

### Stage 3 指摘事項（全8件）

| ID | 重要度 | 反映 | 概要 |
|----|--------|------|------|
| F1 | must_fix | 済 | refreshTriggerとの排他制御 |
| F2 | must_fix | 済 | バックグラウンドタブでのポーリング停止 |
| F3 | should_fix | 済 | FileTab型isDirty影響範囲 |
| F4 | should_fix | 済 | 304レスポンスのクライアント側ハンドリング |
| F5 | should_fix | 済 | テスト計画 |
| F6 | should_fix | 済 | WorktreeDetailRefactored.tsxとの統合設計 |
| F7 | nice_to_have | - | CLAUDE.md更新（実装後対応） |
| F8 | nice_to_have | - | APIログ影響（スコープ外） |

### Stage 5 指摘事項（全2件）

| ID | 重要度 | 反映 | 概要 |
|----|--------|------|------|
| F1 | should_fix | 済 | ポーリング設計パターンの統一 |
| F2 | should_fix | 済 | isDirty中の外部変更通知 |

---

## Should Fix（推奨対応）

### F1: useFilePollingカスタムフックの新規ファイルが関連ファイル一覧に未記載

**カテゴリ**: 影響ファイル・新規ファイル追加

**問題**:
案Cのポーリング設計統一方針で `useFilePolling` カスタムフックの導入が明記されているが、関連ファイル一覧および各案の変更対象ファイルにこの新規フックファイルが含まれていない。新規ファイル作成は実装計画上重要であり、変更対象から漏れると工数見積もりや影響分析が不正確になる。

**証拠**:
- 案Cに「useFilePolling等のカスタムフックとして設計し」と記載あり
- 関連ファイルセクションに `src/hooks/useFilePolling.ts` の記載なし
- 変更対象ファイルにも未記載

**推奨対応**:
関連ファイルセクションに `src/hooks/useFilePolling.ts（新規作成）- ファイルツリー/ファイル内容ポーリングのライフサイクル一元管理` を追加する。

---

### F2: useFilePollingカスタムフックのテストがテスト要件に含まれていない

**カテゴリ**: テスト範囲

**問題**:
テスト要件にはポーリング開始/停止のライフサイクルテストが含まれているが、useFilePollingカスタムフック自体の単体テストが明示的に記載されていない。案Cでvisibilitychange一括管理の中核として位置づけられたフックであり、テスト対象として明示すべき。

**証拠**:
- テスト要件の3番目の項目「ポーリング開始/停止のライフサイクルテスト」はFilesタブ切替とvisibilitychangeに言及しているが、useFilePollingフック自体のテストとは明記されていない
- 案CでuseFilePollingは両方のポーリングのライフサイクルを一元管理する設計

**推奨対応**:
テスト要件に「useFilePollingフックの単体テスト（初期化、visibilitychange連携、アンマウント時cleanup）」を追加する。または既存項目の説明にuseFilePollingフックのテストを含む旨を追記する。

---

### F3: FileTreeViewPropsへのisActive prop追加時の既存テストへの影響

**カテゴリ**: 影響ファイル・依存関係

**問題**:
案Aの統合設計で「isActive propまたは既存のrefreshTrigger propを活用する」と記載されている。FileTreeViewPropsにisActive propを追加する場合、既存のFileTreeView.test.tsx（`tests/unit/components/worktree/FileTreeView.test.tsx`）でrenderに渡すpropsの更新が必要になる。

**証拠**:
- `tests/unit/components/worktree/FileTreeView.test.tsx` が存在し、FileTreeViewコンポーネントのレンダリングテストを実施
- 現在のFileTreeViewPropsにisActiveは未定義（行35-55）
- isActiveを必須propsとして追加するとテストがコンパイルエラーになる

**推奨対応**:
isActiveはオプショナルpropとしデフォルトtrueとすることで後方互換性を維持する設計を推奨。テスト要件に「FileTreeView既存テストへのprop追加に伴う修正」を追記する。

---

## Nice to Have（あれば良い）

### F4: ポーリング定数の定義場所が未確定

**カテゴリ**: 影響ファイル・ドキュメント

**問題**:
`FILE_TREE_POLL_INTERVAL_MS` と `FILE_CONTENT_POLL_INTERVAL_MS` の定数がどのファイルに定義されるかが未記載。WorktreeDetailRefactored.tsxでは `ACTIVE_POLLING_INTERVAL_MS` 等がコンポーネントファイル内に直接定義されている（行131-134）パターンがある。

**推奨対応**:
実装者の判断に委ねる旨を記載するか、既存パターンに合わせてuseFilePollingフック内に定義する方針を記載する。

---

## 参照ファイル

### コード
- `src/hooks/useFileTabs.ts`: FileTab型・FileTabsAction型の変更箇所（行36-67）
- `src/components/worktree/FileTreeView.tsx`: FileTreeViewProps定義（行35-55）、refreshTrigger依存useEffect（行594-666）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 既存ポーリング定数（行131-134）、handleVisibilityChange（行1841-1945）
- `src/components/worktree/FilePanelContent.tsx`: auto-fetch useEffect（行646-678）
- `src/components/worktree/MarkdownEditor.tsx`: isDirty計算（行202）
- `tests/unit/components/worktree/FileTreeView.test.tsx`: 既存テスト（isActive prop追加時に修正必要）

### ドキュメント
- `CLAUDE.md`: モジュール一覧（実装完了後にuseFilePollingフック追記が必要）
