# Issue #485 レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 3 |

**総合評価**: Medium -- Issue全体の方向性は妥当だが、コードベースとの事実齟齬が3件あり、影響範囲の記載漏れが複数存在する。

---

## Must Fix（必須対応）

### MF-1: 「draftKey」はMessageInput.tsxに存在しない

**カテゴリ**: 正確性
**場所**: コードベースのコンテキスト セクション

**問題**:
Issueに「MessageInput.tsx: localStorageから下書きを復元する仕組みがある（draftKey）」と記載されているが、`draftKey`というpropや変数はMessageInput.tsxに存在しない。

**証拠**:
- MessageInput.tsx L34: `const DRAFT_STORAGE_KEY_PREFIX = 'commandmate:draft-message:';`
- `draftKey`という識別子はファイル内に存在しない

**推奨対応**:
「DRAFT_STORAGE_KEY_PREFIX + worktreeIdによるlocalStorage下書き保存」に記載を修正する。

---

### MF-2: useInfiniteMessagesは未使用であり「既存の無限スクロール」は存在しない

**カテゴリ**: 正確性
**場所**: 関連コンポーネント セクション / 受入条件 セクション

**問題**:
Issueに「useInfiniteMessages - 履歴データ取得（変更なし、既存活用）」と記載され、受入条件にも「既存の無限スクロールを活用」とあるが、`useInfiniteMessages`フックは定義のみ存在し、どのコンポーネントでもimportされていない。

**証拠**:
- `src/hooks/useInfiniteMessages.ts` は存在する
- `src/components/` 配下でimportしているファイルは0件
- HistoryPaneは `messages: ChatMessage[]` をpropsとして受け取る（HistoryPane.tsx L37）

**推奨対応**:
- 関連コンポーネントから `useInfiniteMessages` の記載を削除
- 受入条件の「既存の無限スクロールを活用」を「既存のメッセージ取得フロー（WorktreeDetailRefactored -> HistoryPane props）を活用」に修正

---

### MF-3: ConversationPairCardは「useConversationHistoryフックを使用」していない

**カテゴリ**: 整合性
**場所**: コードベースのコンテキスト セクション

**問題**:
Issueに「ConversationPairCard.tsx: useConversationHistory フックを使用」と記載されているが、useConversationHistoryを使用しているのはHistoryPaneであり、ConversationPairCardではない。

**証拠**:
- ConversationPairCard.tsx: `useConversationHistory`のimportなし
- HistoryPane.tsx L191: `const { pairs, isExpanded, toggleExpand } = useConversationHistory(messages);`

**推奨対応**:
「ConversationPairCard.tsx: ConversationPair型のデータをpropsで受け取り表示するコンポーネント」に修正する。

---

## Should Fix（推奨対応）

### SF-1: MessageInputへの外部テキスト挿入方式が未決定

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

**問題**:
「コールバック or ref経由」と記載されているが、どの方式を採用するか未決定。方式により影響範囲が大きく異なる。

**証拠**:
- MessageInput.tsx はReact.memo()でラップ（L36）
- `setMessage`はコンポーネント内部のstate
- 外部からテキストを注入するインターフェースは現時点で存在しない

**推奨対応**:
以下のいずれかを選択し明記する:
1. `useImperativeHandle` + `forwardRef` で `insertText(text: string)` メソッドを公開する
2. WorktreeDetailRefactored内で `pendingInsertText` stateを管理し、MessageInputにpropとして渡す（MessageInput内部でuseEffectで検知して挿入）

---

### SF-2: 影響範囲にWorktreeDetailSubComponents.tsxが含まれていない

**カテゴリ**: 完全性
**場所**: 影響範囲 セクション

**問題**:
モバイルビューではMobileContent（WorktreeDetailSubComponents.tsx内）がHistoryPaneとNotesAndLogsPaneをレンダリングしており、このファイルのprops変更が必要。

**証拠**:
- WorktreeDetailSubComponents.tsx L750: MobileContent コンポーネント
- MobileContentProps（L698-747）への挿入コールバック追加が必要

**推奨対応**:
影響範囲に `src/components/worktree/WorktreeDetailSubComponents.tsx` を追加し、MobileContentPropsの変更を明記する。

---

### SF-3: MemoPane -> NotesAndLogsPaneの伝播経路が影響範囲に不足

**カテゴリ**: 完全性
**場所**: 影響範囲 セクション

**問題**:
MemoCardに挿入ボタンを追加する場合、コールバックを MemoCard -> MemoPane -> NotesAndLogsPane -> WorktreeDetailRefactored と伝播させる必要がある。NotesAndLogsPane.tsxのprops変更が影響範囲に含まれていない。

**証拠**:
- NotesAndLogsPane.tsx L33-52: NotesAndLogsPanePropsに挿入系コールバックは未定義
- MemoPane.tsx L31-36: MemoPanePropsにも未定義

**推奨対応**:
影響範囲に `NotesAndLogsPane.tsx` のprops変更を明記する。

---

### SF-4: 「末尾に追加」の区切り仕様が未定義

**カテゴリ**: 明確性
**場所**: 受入条件 セクション

**問題**:
「入力欄に既存テキストがある場合は末尾に追加されること」とあるが、区切り文字（改行、スペース、なし）の仕様が不明確。

**推奨対応**:
区切り仕様を明記する。提案: 既存テキストがある場合は改行2つ（空行）を挟んで追加する。

---

### SF-5: HistoryPanePropsへの型変更が未記載

**カテゴリ**: 整合性
**場所**: 影響範囲 セクション

**問題**:
HistoryPaneは現在onCopyコールバックをConversationPairCardに伝播している。同様パターンでonInsertコールバックを追加する場合、HistoryPanePropsの型変更が必要。

**証拠**:
- HistoryPane.tsx L36-48: 現在のHistoryPanePropsにonInsert系プロパティは未定義
- 既存パターン: `onCopy` -> `handleCopy` -> ConversationPairCard

**推奨対応**:
影響範囲に「HistoryPanePropsにonInsertToMessageコールバック追加」を明記する。

---

## Nice to Have（あれば良い）

### NTH-1: 挿入ボタンのUIデザインが未定義

**カテゴリ**: 完全性
**場所**: 実装タスク セクション

ConversationPairCardには既にCopy（コピー）ボタンが存在する（lucide-react Copyアイコン）。挿入ボタンも同様の配置パターンを採用し、lucide-reactの`ArrowDownToLine`等のアイコンを使用することを推奨。

---

### NTH-2: 挿入成功時のユーザーフィードバックが未定義

**カテゴリ**: 完全性
**場所**: 受入条件 セクション

既存のCopyボタンではToast通知を表示している（`showToast?.('Copied to clipboard', 'success')`）。挿入操作でも同様にToast通知を表示するとUXが向上する。

---

### NTH-3: LeftPaneTabSwitcherのmemoタブとMemoPane（Notes）の関係が不明確

**カテゴリ**: 完全性
**場所**: 関連コンポーネント セクション

LeftPaneTabSwitcherのmemoタブは「CMATE」（CMATE.mdエディタ）であり、WorktreeMemo（Notes）とは別物。この構造の説明があると実装者にとって分かりやすい。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MessageInput.tsx` | 主要変更対象: 外部テキスト挿入インターフェース追加 |
| `src/components/worktree/ConversationPairCard.tsx` | 変更対象: 挿入ボタン追加 |
| `src/components/worktree/MemoCard.tsx` | 変更対象: 挿入ボタン追加 |
| `src/components/worktree/HistoryPane.tsx` | 変更対象: コールバック伝播 |
| `src/components/worktree/MemoPane.tsx` | 変更対象: コールバック伝播（Issue未記載） |
| `src/components/worktree/NotesAndLogsPane.tsx` | 変更対象: コールバック伝播（Issue未記載） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 変更対象: コールバック接続起点 |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | 変更対象: MobileContent props追加（Issue未記載） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構造・モジュール一覧の整合性確認 |
