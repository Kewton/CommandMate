# Architecture Review Report: Issue #485 Stage 2 (整合性)

**Issue**: #485 履歴・メモからメッセージ入力欄への挿入機能
**Review Type**: 整合性 (Consistency) - 設計書 vs 実コードベース
**Stage**: 2/4 (Multi-stage Design Review)
**Date**: 2026-03-13
**Status**: conditionally_approved
**Score**: 4/5

---

## Executive Summary

Issue #485 設計方針書の整合性レビューを実施した。設計書に記載された型定義、コード例、ファイルパス、インポート、テストファイルパスについて、実際のコードベースとの整合性を検証した。

全体的に設計書の品質は高く、影響ファイルパスやインポートの整合性は問題ない。ただし、1件の必須修正事項（onInsertConsumed の useCallback ラップに関するコード例の矛盾）と5件の推奨修正事項が検出された。

---

## Detailed Findings

### Must Fix (1件)

#### D2-002: onInsertConsumed がインライン関数で渡されており useCallback 未使用

- **カテゴリ**: コード例
- **箇所**: 設計書セクション 4-1 vs セクション 4-2 注意書き

設計書セクション4-1のコード例:
```typescript
<MessageInput
  ...
  onInsertConsumed={() => setPendingInsertText(null)}  // インライン関数
/>
```

設計書セクション4-2の注意書き:
> `onInsertConsumed`を依存配列に含めるため、WorktreeDetailRefactored側でuseCallbackでラップすること。

この2箇所が矛盾している。コード例をそのまま実装すると、MessageInput 内の useEffect が毎レンダリングで再発火し、パフォーマンス劣化や意図しない挙動を引き起こす。

**改善提案**: セクション4-1のコード例を以下のように修正する:

```typescript
const handleInsertConsumed = useCallback(() => setPendingInsertText(null), []);

<MessageInput
  ...
  onInsertConsumed={handleInsertConsumed}
/>
```

---

### Should Fix (5件)

#### D2-003: UserMessageSection への onInsertToMessage 伝播が未記載

- **カテゴリ**: 型定義
- **箇所**: 設計書セクション 4-3

ConversationPairCard の実装では、UserMessageSection は独立した内部サブコンポーネントであり、onCopy と同様に onInsertToMessage も個別に props として渡す必要がある。設計書にはこの内部伝播の詳細が記載されていない。

**改善提案**: UserMessageSection の props 拡張と ConversationPairCard からの伝播を明記する。

#### D2-004: 挿入ボタンの right-10 配置が広すぎる可能性

- **カテゴリ**: コード例
- **箇所**: 設計書セクション 4-3

既存 Copy ボタンは `right-2`（8px）に配置。設計書の挿入ボタンは `right-10`（40px）で、ボタン間に約32pxの間隔が生じる。ボタンサイズ（約22px幅）を考慮すると、やや間隔が広い。

**改善提案**: `right-8`（32px）への調整、または flexbox ベースのレイアウト変更を検討。

#### D2-007: HistoryPane テストファイルのディレクトリ構造不一致

- **カテゴリ**: テスト
- **箇所**: 設計書セクション 8

HistoryPane のテストは `tests/unit/components/HistoryPane.test.tsx` にあるが、他のコンポーネントテスト（MemoCard, MemoPane, NotesAndLogsPane）は全て `tests/unit/components/worktree/` 配下。設計書の記載自体は正しいが、一貫性がない。

**改善提案**: テスト追加のタイミングで `tests/unit/components/worktree/` への統一を検討。

#### D2-008: MemoPane から MemoCard への onInsertToMessage 伝播の注意喚起不足

- **カテゴリ**: 型定義
- **箇所**: 設計書セクション 4-6

MemoPane は MemoCard を直接レンダリングしており、onInsertToMessage の伝播漏れに注意が必要。

**改善提案**: 実装チェックリストに伝播確認項目を追加。

#### D2-009: leftPaneMemo のコード例が実際のタブ切り替え構造と乖離

- **カテゴリ**: コード例
- **箇所**: 設計書セクション 4-1

設計書では HistoryPane と NotesAndLogsPane が並列配置の記載だが、実装では LeftPaneTabSwitcher によるタブ切り替えで排他表示される。

**改善提案**: HistoryPane への追加は `historySubTab === 'message'` ブロック内、NotesAndLogsPane への追加は `leftPaneTab === 'memo'` ブロック内であることを明記。

---

### Nice to Have (4件)

| ID | カテゴリ | 内容 |
|----|---------|------|
| D2-001 | 型定義 | MessageInputProps の既存プロパティは設計書と一致（確認のみ） |
| D2-005 | ファイルパス | 全影響ファイルパスの実在を確認済み |
| D2-006 | インポート | lucide-react ArrowDownToLine は利用可能 |
| D2-010 | コード例 | MobileContent への伝播詳細が簡潔すぎる（22個のProps持ちインターフェース） |
| D2-011 | 型定義 | NotesAndLogsPaneProps の maxAgents が設計書 Props リストに未記載 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | onInsertConsumed インライン関数による useEffect 再発火 | Med | High | P1 |
| 技術的リスク | UserMessageSection への props 伝播漏れ | Low | Med | P2 |
| 技術的リスク | leftPaneMemo 構造の誤解による実装ミス | Low | Low | P3 |
| セキュリティ | なし（UI変更のみ、既存セキュリティ層に影響なし） | - | - | - |
| 運用リスク | なし | - | - | - |

---

## Consistency Verification Matrix

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| MessageInputProps | 4プロパティ + 2追加 | 4プロパティ | 整合 |
| ConversationPairCardProps | 5プロパティ + 1追加 | 5プロパティ | 整合 |
| MemoCardProps | 6プロパティ + 1追加 | 6プロパティ | 整合 |
| HistoryPaneProps | 6プロパティ + 1追加 | 6プロパティ | 整合 |
| MemoPaneProps | 2プロパティ + 1追加 | 2プロパティ | 整合 |
| NotesAndLogsPaneProps | 8プロパティ + 1追加 | 9プロパティ（maxAgents含む） | 軽微な差異（D2-011） |
| ファイルパス（8ファイル） | 全て記載 | 全て実在 | 整合 |
| lucide-react ArrowDownToLine | 使用予定 | ^0.554.0 インストール済み、エクスポート確認 | 整合 |
| テストファイルパス | 6ファイル記載 | 5ファイル実在、1ファイル新規作成予定 | 整合 |
| leftPaneMemo 構造 | 並列配置の記載 | タブ切り替え排他表示 | 差異あり（D2-009） |
| onInsertConsumed useCallback | 注意書きで言及 | コード例はインライン関数 | 矛盾あり（D2-002） |

---

## Implementation Checklist (Updated)

Stage 1 チェックリストに加え、以下を追加:

- [ ] D2-002: onInsertConsumed を useCallback でラップし、インライン関数で渡さない
- [ ] D2-003: UserMessageSection の props に onInsertToMessage を追加し、ConversationPairCard から伝播する
- [ ] D2-008: MemoPane から MemoCard への onInsertToMessage 伝播を実装・テストする
- [ ] D2-009: leftPaneMemo 内の正しいタブ条件ブロックに onInsertToMessage を追加する

---

## Approval

**Status**: conditionally_approved

D2-002（onInsertConsumed の useCallback ラップ矛盾）を設計書で修正すれば実装に進めてよい。他の should_fix 項目は実装時に対応可能。
