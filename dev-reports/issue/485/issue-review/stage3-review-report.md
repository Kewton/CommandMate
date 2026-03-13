# Issue #485 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲分析（1回目）
**ステージ**: Stage 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合品質**: Medium

Issue の影響範囲記述は概ね正確であるが、デスクトップ側のコールバック伝播経路に誤りがあり（LeftPaneTabSwitcher 経由と記載されているが実際は直接伝播）、MessageInput の memo() と forwardRef の組み合わせに関する技術的考慮が欠けている。また、leftPaneMemo の useMemo 依存配列への追加が必要であることが影響範囲に未記載である。

---

## Must Fix（必須対応）

### S3-001: デスクトップ履歴経路の LeftPaneTabSwitcher 伝播記述が不正確

**カテゴリ**: 伝播経路

**問題**:
Issue のコールバック伝播経路に「WorktreeDetailRefactored -> LeftPaneTabSwitcher -> HistoryPane -> ConversationPairCard」と記載されているが、実際のコード構造では LeftPaneTabSwitcher はタブ切替ボタンのみを描画するコンポーネントである。

WorktreeDetailRefactored.tsx の leftPaneMemo（1298行目）内で、LeftPaneTabSwitcher（1301行目）と HistoryPane（1334行目）は並列にレンダリングされている。LeftPaneTabSwitcher はタブ選択のコールバック（onTabChange）のみを受け取り、子コンポーネントへのコンテンツ伝播機能は持たない。

**証拠**:
- `LeftPaneTabSwitcherProps` の定義（LeftPaneTabSwitcher.tsx 21-28行目）: `activeTab` と `onTabChange` のみ
- leftPaneMemo のJSX構造: LeftPaneTabSwitcher と HistoryPane は同一階層のsiblings

**推奨対応**:
コールバック伝播経路（デスクトップ）を以下に修正:
- 修正前: `WorktreeDetailRefactored -> LeftPaneTabSwitcher -> HistoryPane -> ConversationPairCard`
- 修正後: `WorktreeDetailRefactored -> HistoryPane -> ConversationPairCard`

LeftPaneTabSwitcherProps の変更は不要であることを明記する。

---

### S3-002: MessageInput の memo() と forwardRef の組み合わせに関する技術的制約

**カテゴリ**: 影響範囲

**問題**:
MessageInput は現在 `memo(function MessageInput(...))` で定義されている（MessageInput.tsx 36行目）。useImperativeHandle + forwardRef パターンを採用する場合、`memo(forwardRef(...))` の形にリファクタリングする必要がある。

Issue 本文では両パターン（forwardRef / pendingInsertText props）を選択肢として記載しているが、memo() との組み合わせの技術的制約について言及がない。

**推奨対応**:
以下のいずれかを実装タスクに明記:
1. forwardRef パターン: `memo(forwardRef(function MessageInput(...)))` への変更が必要
2. pendingInsertText props パターン: memo() との親和性が高く、既存構造への影響が小さい（推奨）

---

### S3-003: leftPaneMemo の useMemo 依存配列への追加が必要

**カテゴリ**: 影響範囲

**問題**:
WorktreeDetailRefactored.tsx の `leftPaneMemo`（1298行目）は `useMemo` で包まれており、依存配列（1404行目）にすべての参照値を列挙する必要がある。コード内コメント（1294-1296行目）にも以下の注記がある:

> When adding a new prop or state variable to the left pane content, you MUST also add it to this dependency array, otherwise the memoized output will be stale.

onInsertToMessage コールバックを HistoryPane と NotesAndLogsPane に渡す場合、この依存配列にも追加しなければ stale closure の問題が発生する。

**推奨対応**:
影響範囲の WorktreeDetailRefactored.tsx の説明に「leftPaneMemo の useMemo 依存配列に onInsertToMessage コールバックを追加する必要がある」と明記する。

---

## Should Fix（推奨対応）

### S3-004: MemoPane の props 型変更が影響範囲に未記載

**カテゴリ**: 影響範囲

**問題**:
NotesAndLogsPane -> MemoPane -> MemoCard の伝播経路で、MemoPane は中間コンポーネントとしてコールバックを受け取り MemoCard に渡す必要がある。現在の `MemoPaneProps`（MemoPane.tsx 31-36行目）には `onInsertToMessage` がない。

**推奨対応**:
変更対象ファイルに `MemoPane.tsx: MemoPaneProps に onInsertToMessage コールバック追加、MemoCard への伝播` を明記する。

---

### S3-005: テスト追加対象が不足

**カテゴリ**: テスト

**問題**:
Issue のテストタスクには「MessageInput, ConversationPairCard, MemoCard」のユニットテスト追加のみ記載されている。しかし以下の既存テストファイルも影響を受ける:
- `tests/unit/components/HistoryPane.test.tsx`
- `tests/unit/components/worktree/MemoPane.test.tsx`
- `tests/unit/components/worktree/MemoCard.test.tsx`
- `tests/unit/components/worktree/NotesAndLogsPane.test.tsx`
- `tests/unit/components/worktree/MessageInput.test.tsx`

**推奨対応**:
テスト追加対象に以下を追記:
- HistoryPane: onInsertToMessage の ConversationPairCard への伝播テスト
- MemoPane: onInsertToMessage の MemoCard への伝播テスト
- 既存テストファイルの更新が必要であることを実装タスクに明記

---

### S3-006: ConversationPairCard のテストは新規作成が必要

**カテゴリ**: テスト

**問題**:
ConversationPairCard.test.tsx が tests/ 配下に存在しない。Issue の実装タスクでは既存テストの修正なのか新規作成なのか区別が不明確。

**推奨対応**:
「ConversationPairCard のユニットテスト新規作成（挿入ボタン表示、クリック時のコールバック呼び出し確認）」と具体化する。

---

### S3-007: src/types/ 配下のファイルへの変更は不要であることの確認

**カテゴリ**: 型定義

**問題**:
すべてのprops型（ConversationPairCardProps, MemoCardProps, HistoryPaneProps, MemoPaneProps, NotesAndLogsPaneProps, MobileContentProps）は各コンポーネントファイル内で定義されている。`src/types/conversation.ts` の `ConversationPair` 型はデータ構造であり、UIコールバックを含まないため変更不要。

**推奨対応**:
影響範囲に「src/types/ 配下のファイルへの変更は不要」と明記し、実装者の混乱を防ぐ。

---

## Nice to Have（あれば良い）

### S3-008: pendingInsertText パターンのリセット機構の設計方針

**カテゴリ**: 影響範囲

pendingInsertText props パターンを採用した場合、挿入実行後に pendingInsertText を null に戻すリセット処理のタイミングについて設計方針の記載があると実装がスムーズになる。

---

### S3-009: LeftPaneTabSwitcher が変更不要であることの明記

**カテゴリ**: 影響範囲

関連コンポーネントとして LeftPaneTabSwitcher が列挙されているが、S3-001 の通り変更不要。「変更不要（タブ切替UIのみ担当）」と明記すると実装者の混乱を防げる。

---

## 参照ファイル

### コード
| ファイル | 関連箇所 |
|---------|----------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | leftPaneMemo (1298-1404行), useMemo 依存配列 |
| `src/components/worktree/LeftPaneTabSwitcher.tsx` | LeftPaneTabSwitcherProps (21-28行) - 変更不要 |
| `src/components/worktree/MessageInput.tsx` | memo() 定義 (36行) |
| `src/components/worktree/MemoPane.tsx` | MemoPaneProps (31-36行) - onInsertToMessage 追加必要 |
| `src/components/worktree/WorktreeDetailSubComponents.tsx` | MobileContentProps (697-747行) |
| `src/types/conversation.ts` | ConversationPair 型 - 変更不要 |

### テスト
| ファイル | 状態 |
|---------|------|
| `tests/unit/components/worktree/MessageInput.test.tsx` | 既存 - 更新必要 |
| `tests/unit/components/HistoryPane.test.tsx` | 既存 - 更新必要 |
| `tests/unit/components/worktree/MemoCard.test.tsx` | 既存 - 更新必要 |
| `tests/unit/components/worktree/MemoPane.test.tsx` | 既存 - 更新必要 |
| `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` | 既存 - 更新必要 |
| `tests/unit/components/worktree/ConversationPairCard.test.tsx` | 新規作成必要 |
