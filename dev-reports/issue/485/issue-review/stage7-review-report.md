# Issue #485 レビューレポート - Stage 7

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 1 |

**総合評価**: high

Stage 3 で指摘した 9 件（S3-001 ~ S3-009）はすべて適切に対応済み。Issue 本文の影響範囲記述は高い精度で整備されている。今回の指摘は実装時の参考情報レベルの補足が中心であり、必須対応はなし。

---

## Stage 3 指摘事項の対応状況

| ID | 内容 | 対応状況 |
|----|------|---------|
| S3-001 | デスクトップ履歴経路の LeftPaneTabSwitcher 誤記修正 | 対応済み |
| S3-002 | MessageInput の memo() と forwardRef 組み合わせ注記 | 対応済み |
| S3-003 | leftPaneMemo useMemo 依存配列への追加明記 | 対応済み |
| S3-004 | MemoPane.tsx の変更内容詳細化 | 対応済み |
| S3-005 | テスト対象拡充（HistoryPane, MemoPane 伝播テスト） | 対応済み |
| S3-006 | ConversationPairCard テスト「新規作成」明記 | 対応済み |
| S3-007 | src/types/ 配下の変更不要明記 | 対応済み |

---

## Should Fix（推奨対応）

### S7-001: NotesAndLogsPane から MemoPane への伝播の実装注記

**カテゴリ**: 影響範囲

**問題**:
NotesAndLogsPane.tsx の114行目で MemoPane をレンダリングしている箇所には現在 onInsertToMessage が渡されていない。Issue 本文では NotesAndLogsPane の変更内容に「内部のMemoPane呼び出し箇所へのコールバック伝播」と記載されており認識は正しい。NotesAndLogsPane は notes/logs/agent の3サブタブを持ち、MemoPane は notes サブタブ内でのみレンダリングされる。

**推奨対応**:
実装上の支障はないが、コールバック伝播経路に「NotesAndLogsPane 内では notes サブタブの MemoPane レンダリング箇所にのみ伝播」と補足すると、実装者にとって明確になる。

---

### S7-002: MobileContent のテスト対象が未記載

**カテゴリ**: テスト

**問題**:
WorktreeDetailSubComponents.tsx の MobileContentProps に onInsertToMessage を追加する変更が影響範囲テーブルに記載されているが、テスト追加・更新対象リストに MobileContent が含まれていない。現在 WorktreeDetailSubComponents のテストファイルは存在せず、新規作成が必要。MobileContent は大きなコンポーネントであり、テスト作成コストを考慮するとこの Issue スコープでは任意とする判断も妥当。

**推奨対応**:
テスト対象一覧に MobileContent の伝播確認テストを「任意（テストファイル新規作成が必要）」として追記するか、スコープ外であることを明記する。

---

## Nice to Have（あれば良い）

### S7-003: MessageInput の 2 箇所レンダリングと実装パターン選択の補足

**カテゴリ**: 影響範囲

**問題**:
WorktreeDetailRefactored.tsx では MessageInput がデスクトップ版（1465行目）とモバイル版（1726行目）の 2 箇所でレンダリングされている。useImperativeHandle + forwardRef パターンを採用する場合、両方の MessageInput に ref を渡す必要がある（条件分岐で排他的にレンダリングされるため実際には同一 ref で対応可能だが、実装上の考慮点ではある）。pendingInsertText props パターンであれば単に state を両方に渡すだけで済む。

**推奨対応**:
MessageInput の説明に「デスクトップ/モバイルで 2 箇所レンダリングされるため、pendingInsertText props パターンの方が実装が簡潔になる」旨を補足してもよい。

---

## 調査結果

### 1. コールバック伝播経路の漏れ確認

Issue 記載の 4 つの伝播経路を実コードと照合し、すべて正確であることを確認した。

| 経路 | Issue 記載 | コード検証結果 |
|------|-----------|--------------|
| デスクトップ（履歴） | WorktreeDetailRefactored -> HistoryPane -> ConversationPairCard | 正確（1334行目） |
| モバイル（履歴） | WorktreeDetailRefactored -> MobileContent -> HistoryPane -> ConversationPairCard | 正確（829行目） |
| メモ（デスクトップ） | WorktreeDetailRefactored -> NotesAndLogsPane -> MemoPane -> MemoCard | 正確（1388行目 -> 114行目） |
| メモ（モバイル） | WorktreeDetailRefactored -> MobileContent -> NotesAndLogsPane -> MemoPane -> MemoCard | 正確（885行目 -> 114行目） |

漏れているファイルはなし。

### 2. テスト対象ファイルの漏れ確認

| テスト対象 | Issue 記載 | 確認結果 |
|-----------|-----------|---------|
| ConversationPairCard.test.tsx | 新規作成 | 正確（テストファイル未存在） |
| HistoryPane.test.tsx | 更新 | 正確（テストファイル存在） |
| MemoPane.test.tsx | 更新 | 正確（テストファイル存在） |
| MemoCard.test.tsx | 更新 | 正確（テストファイル存在） |
| NotesAndLogsPane.test.tsx | 更新 | 正確（テストファイル存在） |
| MessageInput.test.tsx | 更新 | 正確（テストファイル存在） |
| WorktreeDetailSubComponents.test.tsx | 未記載 | S7-002 で指摘（任意） |

### 3. TypeScript 型の変更連鎖

すべての Props 型はコンポーネントファイル内で定義されており、src/types/ 配下への変更波及はない。変更が必要な Props 型は以下の通りで、Issue の記載と一致する。

- MessageInputProps（MessageInput.tsx 18行目）
- ConversationPairCardProps（ConversationPairCard.tsx 22行目）
- MemoCardProps（MemoCard.tsx 33行目）
- HistoryPaneProps（HistoryPane.tsx 35行目）
- MemoPaneProps（MemoPane.tsx 31行目）
- NotesAndLogsPaneProps（NotesAndLogsPane.tsx 33行目）
- MobileContentProps（WorktreeDetailSubComponents.tsx 698行目）

### 4. モバイル固有の考慮点

MobileContentProps への onInsertToMessage 追加は Issue に記載済み。MobileContent 内での HistoryPane、NotesAndLogsPane への伝播も経路として明記されている。maxAgents 不整合の件はスコープ外として明記済み。

---

## 参照ファイル

### コード
- `src/components/worktree/NotesAndLogsPane.tsx`: MemoPane 呼び出し箇所（114行目）
- `src/components/worktree/WorktreeDetailSubComponents.tsx`: MobileContentProps 定義（698行目）、NotesAndLogsPane レンダリング（885行目）
- `src/components/worktree/WorktreeDetailRefactored.tsx`: MessageInput 2箇所レンダリング（1465行目、1726行目）
