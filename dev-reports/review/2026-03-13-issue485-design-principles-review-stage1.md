# Architecture Review: Issue #485 - 設計原則レビュー (Stage 1)

**Issue**: [#485 履歴、cmate_noteから選択してメッセージに初期表示したい](https://github.com/Kewton/CommandMate/issues/485)
**レビュー日**: 2026-03-13
**フォーカス**: 設計原則 (SOLID / KISS / YAGNI / DRY)
**ステータス**: 条件付き承認 (Conditionally Approved)
**スコア**: 4/5

---

## Executive Summary

Issue #485 の設計方針書は、既存のプロジェクトパターン（props バケツリレー、memo() ラップ、useCallback メモ化）との一貫性を重視した堅実な設計となっている。`pendingInsertText` props パターンの選択は、デスクトップ/モバイル2箇所対応の要件に対してシンプルかつ適切な解決策であり、`useImperativeHandle` + `forwardRef` パターンと比較して実装複雑度が大幅に低い。

主要な懸念点は WorktreeDetailRefactored の責務過多の加速と、コールバックバケツリレーによる中間コンポーネントの変更範囲の広さだが、いずれもプロジェクト全体の既存パターンと一致しており、今回のIssue単独では許容範囲内である。

---

## Detailed Findings

### D1-001: WorktreeDetailRefactored の責務過多が更に悪化する [Should Fix]

| 項目 | 内容 |
|------|------|
| **原則** | SRP (単一責任原則) |
| **深刻度** | Should Fix |

**詳細**:

WorktreeDetailRefactored は既に 21 個の `useState` と 44 個の `useCallback` を持つ巨大コンポーネントである。`pendingInsertText` state と `handleInsertToMessage` コールバックの追加は責務を更に広げる。このコンポーネントはターミナル管理、ファイル操作、エージェント設定、Git操作、Auto-Yes、プロンプト応答など多数の関心事を抱えており、テキスト挿入状態管理の追加は責務の肥大化を加速させる。

**改善提案**:

今回のIssue単独では許容範囲だが、将来的にカスタムフック `useTextInsertion(setPendingInsertText, pendingInsertText)` のような形で状態管理ロジックを抽出することを検討すべき。少なくとも TODO コメントとして技術的負債を明記しておくことを推奨する。

---

### D1-002: コールバック伝播による中間コンポーネントの修正範囲が広い [Should Fix]

| 項目 | 内容 |
|------|------|
| **原則** | OCP (開放閉鎖原則) |
| **深刻度** | Should Fix |

**詳細**:

`onInsertToMessage` コールバックの追加により、HistoryPane, MemoPane, NotesAndLogsPane, WorktreeDetailSubComponents (MobileContent) の4つの中間コンポーネントの Props 型とレンダリングロジックに変更が必要となる。これらのコンポーネントはコールバックを通過させるだけで自身のロジックには関係がなく、開放閉鎖原則に反する。将来、別の挿入ソース（例: ファイル内容、Git diff）を追加する場合にも同様の修正が発生する。

**改善提案**:

現時点ではプロジェクト全体が props バケツリレーパターンを採用しており一貫性は保たれている。ただし将来的に挿入ソースが増える場合は、React Context (`InsertToMessageContext`) による伝播に切り替えることで、中間コンポーネントへの変更を不要にできる。現段階では `onCopy` パターンとの一貫性を優先し、このまま進めて問題ない。

---

### D1-003: ConversationPairCard と MemoCard の挿入ボタン UI が重複する [Nice to Have]

| 項目 | 内容 |
|------|------|
| **原則** | DRY (Don't Repeat Yourself) |
| **深刻度** | Nice to Have |

**詳細**:

設計書では ConversationPairCard と MemoCard の両方に類似した挿入ボタン（`ArrowDownToLine` アイコン、hover 色変更、title 属性、conditional rendering）を個別に追加する。ボタンのスタイルクラスや表示ロジックが重複している。

**改善提案**:

`InsertToMessageButton` のような小さな共通コンポーネント（3-5行程度）を `src/components/common/` に作成し、両カードから利用する。ただし、現時点ではコピーボタンも同様にインラインで定義されているため、プロジェクトの既存パターンとの一貫性を考慮すると、今回はインライン実装でも許容できる。

---

### D1-004: pendingInsertText の useEffect 消費パターンにおける依存配列の注意点 [Nice to Have]

| 項目 | 内容 |
|------|------|
| **原則** | KISS (Keep It Simple, Stupid) |
| **深刻度** | Nice to Have |

**詳細**:

MessageInput 内の `useEffect` は `pendingInsertText` と `onInsertConsumed` を依存配列に持つ。`onInsertConsumed` が `useCallback` でラップされていない場合、毎レンダリングで `useEffect` が再実行され、意図しない二重挿入が発生する可能性がある。設計書にはこの注意点が記載されているが、実装時の見落としリスクがある。

**改善提案**:

`onInsertConsumed` を WorktreeDetailRefactored 側でインラインアロー関数ではなく `useCallback` でラップすることを設計書で明確に指定している点は良い。実装時に必ずこのパターンを遵守すること。また、`useEffect` 内で `onInsertConsumed` を呼ぶ前に `pendingInsertText` の null チェックが入っているため、最悪でも空の挿入にはならない安全設計になっている。

---

### D1-005: デスクトップ/モバイル両対応の pendingInsertText 同時配信 [Nice to Have]

| 項目 | 内容 |
|------|------|
| **原則** | YAGNI (You Aren't Gonna Need It) |
| **深刻度** | Nice to Have |

**詳細**:

`pendingInsertText` はデスクトップとモバイルの両方の MessageInput に渡される設計だが、実際にはどちらか一方しかアクティブにならない（`isMobile` フラグで切り替え）。両方の MessageInput が同時に `pendingInsertText` を受け取り、両方で `useEffect` が発火する可能性がある。

**改善提案**:

現在の実装では `isMobile` による条件分岐でどちらか一方のみがレンダリングされるため、実際には問題にならない。ただし、将来的にレイアウトが変わった場合に備え、`useEffect` 内で二重消費を防ぐガード（例: `pendingInsertText` が既に null かどうかの再チェック）を入れておくと堅牢性が上がる。

---

### D1-006: 挿入ロジックのエッジケース考慮 [Nice to Have]

| 項目 | 内容 |
|------|------|
| **原則** | KISS (Keep It Simple, Stupid) |
| **深刻度** | Nice to Have |

**詳細**:

挿入ロジックは `prev.trim() === ''` で空判定を行い、空でなければ `'\n\n'` で連結する。同じテキストを連続で挿入した場合、`pendingInsertText` が同じ値のままとなり `useEffect` が再発火しない可能性がある（React の state 同値比較）。

**改善提案**:

連続同一テキスト挿入のユースケースは稀だが、もし対応が必要なら `pendingInsertText` を `{ text: string; id: number }` のようなオブジェクトにして一意性を保証する方法がある。ただし YAGNI の観点からは、現時点では過剰な対応であり、実際にユーザーから要望が出た段階で対応すれば十分。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | WorktreeDetailRefactored の責務過多による保守性低下 | Medium | High | P2 |
| 技術的リスク | onInsertConsumed の useCallback ラップ漏れによる二重挿入 | Low | Low | P3 |
| 技術的リスク | 同一テキスト連続挿入時の useEffect 非発火 | Low | Low | P3 |
| セキュリティ | なし（テキスト操作のみ、React 自動エスケープ） | - | - | - |
| 運用リスク | なし（API追加なし、DB変更なし） | - | - | - |

---

## Design Principles Checklist

| 原則 | 評価 | 備考 |
|------|------|------|
| SRP (単一責任) | Warning | WorktreeDetailRefactored の責務過多が加速（D1-001） |
| OCP (開放閉鎖) | Warning | 中間コンポーネント4箇所の変更が必要（D1-002） |
| LSP (リスコフ置換) | Pass | 該当なし |
| ISP (インターフェース分離) | Pass | 全 props がオプショナルで既存互換性を維持 |
| DIP (依存性逆転) | Pass | 該当なし |
| KISS | Pass | pendingInsertText パターンはシンプルで適切 |
| YAGNI | Pass | 必要最小限の変更に留まっている |
| DRY | Minor | 挿入ボタンUIの軽微な重複（D1-003） |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

なし

### 推奨改善項目 (Should Fix)

1. **D1-001**: WorktreeDetailRefactored に追加する state/callback に TODO コメントで将来のフック抽出を明記する
2. **D1-002**: 将来の挿入ソース追加時に React Context 化を検討するメモを設計書に追記する

### 検討事項 (Consider)

1. **D1-003**: 挿入ボタンの共通コンポーネント化（既存パターンとの一貫性を考慮して判断）
2. **D1-006**: 同一テキスト連続挿入への対応（ユーザー要望が出た段階で検討）

---

## Approval Status

**条件付き承認 (Conditionally Approved)**

設計方針書は全体として高品質であり、既存のプロジェクトパターンとの一貫性が十分に考慮されている。`pendingInsertText` props パターンの選択理由も明確で、デスクトップ/モバイル2箇所対応の要件に対する適切なトレードオフ判断がなされている。

D1-001, D1-002 の Should Fix 項目は今回のIssue単独では許容範囲内だが、実装時に TODO コメントとして将来の改善ポイントを明記することを条件とする。
