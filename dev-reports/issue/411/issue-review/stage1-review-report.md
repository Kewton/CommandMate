# Issue #411 Stage 1 レビューレポート

**レビュー日**: 2026-03-03
**フォーカス**: 通常レビュー（整合性・正確性・明確性・完全性）
**イテレーション**: 1回目

## サマリー

Issue #411の仮説・前提条件は概ね正確であり、技術的方向性に大きな問題はない。仮説検証レポートで確認された通り、全6件の仮説がConfirmedまたはPartially Confirmedである。

しかし、以下の点について改善が必要である:
1. 受け入れ条件が測定不能（ベースラインなし、検証手順不明確）
2. MessageInputのuseCallback化における依存関係の複雑性とハンドラ別の効果差に言及がない
3. MarkdownEditorのmemo化効果が限定的である点の注記が不足
4. inline JSX抽出の具体的な設計方針が欠如

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |
| **合計** | **8** |

---

## Must Fix（必須対応）

### F1-001: 受入条件「React DevTools Profilerで不要な再レンダーが削減されていること」が測定不能

**カテゴリ**: 明確性
**場所**: 受入条件セクション - 1項目目

**問題**:
受入条件の「React DevTools Profilerで不要な再レンダーが削減されていること」は、ベースライン値が定義されておらず、何をもって「削減された」と判断するか不明確。開発者によって判断が異なり、PRレビュー時に合否を客観的に判定できない。また、React DevTools Profilerの確認は手動プロセスであり、CIで自動検証できない。

**推奨対応**:
具体的なシナリオと期待される結果を明記する。例:
- 「WorktreeDetailRefactoredの親状態（ポーリングによるterminal.output更新）が変化した際、FileViewer（isOpen=false時）が再レンダーされないこと」
- 「MessageInputのprops（worktreeId, cliToolId, isSessionRunning）が変化しない場合、MessageInput自体が再レンダーされないこと」
- テスト手法も「手動でReact DevTools Profilerを使用して確認」と明記すべき

---

### F1-002: MessageInputのuseCallback化に伴う依存関係の複雑性への言及が欠如

**カテゴリ**: 完全性
**場所**: 実装タスクセクション - MessageInput

**問題**:
MessageInputの9個のハンドラをuseCallbackで包む場合、多くのハンドラが内部state（`message`, `isComposing`, `sending`, `showCommandSelector`, `isFreeInputMode`等）に依存しており、依存配列が大きくなる。

特に以下のハンドラはstate依存が多い:
- `submitMessage`: `isComposing`, `message`, `sending`, `cliToolId`, `worktreeId`, `onMessageSent`
- `handleKeyDown`: `isComposing`, `showCommandSelector`, `isFreeInputMode`, `isMobile` + `submitMessage`への依存

useCallbackの依存配列が頻繁に変化するため、memo化の恩恵が限定的になる可能性がある。Issueには「全ハンドラuseCallback化」とだけ記載されているが、効果が薄いものと効果的なものの区別が必要。

**推奨対応**:
以下の分類を実装タスクに追記する:
1. **高効果**: `handleCommandSelect`, `handleCommandCancel`, `handleFreeInput`, `handleCompositionStart`（state依存が少なく安定）
2. **中効果**: `handleMessageChange`, `handleKeyDown`（state依存あるが子コンポーネントへの伝播を抑制）
3. **低効果**: `submitMessage`, `handleSubmit`（state依存が多く参照安定性が低い。ただしsubmitMessageはhandleSubmit/handleKeyDownから参照されるため、useCallback化しないと連鎖的に依存配列を不安定にする）

`handleCompositionEnd`のsetTimeout内ref更新パターンの動作確認についても注意事項として記載すること。

---

## Should Fix（推奨対応）

### F1-003: MarkdownEditorのmemo化は効果が限定的であるという注意書きが必要

**カテゴリ**: 正確性
**場所**: 背景・課題セクション - F4

**問題**:
MarkdownEditorは既に内部で19箇所のuseCallback/useMemoを使用しており、内部最適化は十分に行われている。実際の使用パスでは、MarkdownEditorは条件付き描画（`editorFilePath && ...`）されており、`editorFilePath`がnullの時はそもそもマウントされていない。

エディタが開いている間の親再レンダーでpropsが変化しないケースは確かに存在する（ポーリングによるterminal.output更新時など）が、propsはすべて安定している（`onClose`/`onSave`/`onMaximizedChange`はuseCallbackまたはsetState関数、`worktreeId`/`filePath`は文字列で安定）ため、memo化の実効性はある。ただし条件付き描画という特性上、影響範囲は限定的。

**証拠**:
- `src/components/worktree/MarkdownEditor.tsx`: useCallback 15箇所、useMemo 6箇所（既に内部最適化済み）
- `src/components/worktree/WorktreeDetailRefactored.tsx` L2061: `{editorFilePath && (...)}` で条件付き描画

**推奨対応**:
Issue本文のF4セクションに「MarkdownEditorは条件付き描画であり、memo化の主な効果はエディタ表示中の親ポーリング更新時のスキップに限定される。優先度は他タスクより低い」旨の注記を追加する。

---

### F1-004: inline JSX抽出の設計方針が不明確

**カテゴリ**: 完全性
**場所**: 実装タスクセクション - WorktreeDetailRefactored

**問題**:
「leftPane/rightPaneを別コンポーネントに抽出してmemo化」と記載されているが、具体的な設計方針が不明確:
1. 抽出後のコンポーネント名とファイル配置
2. 新コンポーネントが受け取るprops設計
3. `useMemo`でJSXをメモ化する方式と別コンポーネント抽出方式のどちらを採用するか

特にleftPaneは`state.messages`, `fileSearch`, `selectedAgents`等多くのstate/propsに依存しており、別コンポーネントに抽出しても結局多くのpropsが頻繁に変化する（`state.messages`はポーリングで更新される）。

一方、`WorktreeDesktopLayout`は既にmemo化されているため、leftPane/rightPaneのReactNode参照が安定すれば内部の`DesktopLayout`/`MobileLayout`の再レンダーもスキップされる。

**証拠**:
- `src/components/worktree/WorktreeDesktopLayout.tsx` L230: `export const WorktreeDesktopLayout = memo(function WorktreeDesktopLayout({...`
- leftPane (L1935-1998): `state.messages`, `fileSearch`, `selectedAgents`, `worktreeId`等に依存
- rightPane (L2000-2008): `state.terminal.*`, `handleAutoScrollChange`, `disableAutoFollow`のみに依存

**推奨対応**:
2つのアプローチを明示し、判断基準を記載する:
- **(A) useMemo方式**: leftPane/rightPaneのJSXをuseMemoで包み、依存するstate/propsを依存配列に列挙。シンプルだがstate依存が多い場合は効果薄。
- **(B) コンポーネント抽出方式**: LeftPaneContent/RightPaneContentコンポーネントを同一ファイル内に定義しmemo化。propsの変化検知が明確。

推奨: rightPaneはprops数が少ない（5個）ので**useMemo方式**、leftPaneはタブ切り替えにより描画内容が変わるので**コンポーネント抽出方式**を検討。

---

### F1-005: 子コンポーネント（SlashCommandSelector, InterruptButton）の未memo化への言及不足

**カテゴリ**: 完全性
**場所**: 影響範囲セクション

**問題**:
MessageInputをmemo()でラップしても、内部で使用している`SlashCommandSelector`と`InterruptButton`はmemo化されていない。MessageInputの再レンダーがスキップされるシナリオでは問題ないが、MessageInput自体のstateが変化して再レンダーされる場合、useCallbackで安定化したhandlerを受け取っても、これらの子コンポーネントはmemo化されていないため再レンダーされる。

**証拠**:
- `src/components/worktree/SlashCommandSelector.tsx` L48: `export function SlashCommandSelector({` (memo未適用)
- `src/components/worktree/InterruptButton.tsx` L42: `export function InterruptButton({` (memo未適用)

**推奨対応**:
影響範囲テーブルに`SlashCommandSelector.tsx`と`InterruptButton.tsx`を追加するか、「MessageInputのuseCallback化により子コンポーネントのmemo化が効果を発揮する前提条件が整う。将来的にSlashCommandSelector/InterruptButtonのmemo化を検討する」旨の注記を追加する。

---

### F1-006: FileViewerのmemoカスタム比較関数の記述が紛らわしい

**カテゴリ**: リスク
**場所**: 実装タスクセクション - FileViewer

**問題**:
「FileViewer: memo() ラップ（isOpen/filePathの変更時のみ再レンダー）」という記述は、カスタム比較関数（areEqual）の必要性を示唆しているが、実際には`handleFileViewerClose`が`useCallback([], ...)`で空の依存配列で定義されており安定しているため、デフォルトのshallow comparisonで十分機能する。

不要なカスタム比較関数を実装すると、将来的にpropsが追加された際にバグの原因になるリスクがある。

**証拠**:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1194: `const handleFileViewerClose = useCallback(() => { setFileViewerPath(null); }, []);`

**推奨対応**:
「FileViewer: memo() ラップ（デフォルトのshallow comparison。onCloseは呼び出し元でuseCallback済みのため安定。カスタム比較関数は不要）」に修正する。

---

## Nice to Have（あれば良い）

### F1-007: パフォーマンス改善の定量的な期待効果の記載がない

**カテゴリ**: 完全性
**場所**: 概要セクション

**問題**:
どの程度の改善が期待されるか（例: 特定操作時の再レンダー回数の削減量）が記載されていない。

**推奨対応**:
「ターミナルポーリング（2秒間隔）による親コンポーネント再レンダー時に、FileViewer（isOpen=false）/MessageInput（props不変時）の不要な再レンダーがスキップされ、レンダリングツリーの評価コストが削減される」など、具体的なシナリオベースの期待効果を追記する。

---

### F1-008: mobileコマンドボタンのインラインonClickハンドラが最適化対象外である理由の補足

**カテゴリ**: スコープ
**場所**: 背景・課題セクション - F3

**問題**:
MessageInput.tsx L241-244のmobileコマンドボタンの`onClick`はインラインの無名関数であるが、9個のハンドラの数に含まれていない。HTML要素のイベントハンドラであるため、useCallbackで包んでもパフォーマンス上の効果はほぼない。

**推奨対応**:
最適化対象外とする理由（HTML要素のためmemo化の恩恵なし）を補足的に記載するか、コード整理のためuseCallbackで切り出すかを判断事項として記載する。

---

## 参照ファイル

### コード

| ファイル | 行数 | 関連性 |
|---------|------|--------|
| `src/components/worktree/MessageInput.tsx` | 308 | memo化 + useCallback適用対象。9個のハンドラすべてがuseCallbackなし |
| `src/components/worktree/MarkdownEditor.tsx` | 989 | memo化対象。既にuseCallback 15箇所、useMemo 6箇所使用済み |
| `src/components/worktree/FileViewer.tsx` | 197 | memo化対象。onCloseは呼び出し元でuseCallback済み |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 2376 | inline JSX抽出対象。leftPane/rightPaneがインラインJSX |
| `src/components/worktree/WorktreeDesktopLayout.tsx` | 285 | 既にmemo化済み。leftPane/rightPane参照安定化の恩恵を受ける |
| `src/components/worktree/SlashCommandSelector.tsx` | - | MessageInputの子コンポーネント。未memo化 |
| `src/components/worktree/InterruptButton.tsx` | - | MessageInputの子コンポーネント。未memo化 |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/components/worktree/MessageInput.test.tsx` | MessageInputの既存テスト。memo化後の動作確認対象 |
| `tests/unit/components/MarkdownEditor.test.tsx` | MarkdownEditorの既存テスト。memo化後の動作確認対象 |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | WorktreeDetailRefactoredの既存テスト。inline JSX抽出後の動作確認対象 |
