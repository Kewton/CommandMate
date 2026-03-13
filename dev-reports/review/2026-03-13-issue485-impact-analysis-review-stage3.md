# Issue #485 Stage 3: 影響分析レビュー

**レビュー日**: 2026-03-13
**レビュー対象**: dev-reports/design/issue-485-insert-to-message-design-policy.md
**レビュータイプ**: 影響範囲 (Impact Analysis)
**判定**: conditionally_approved (4/5)

---

## 概要

Issue #485「履歴・メモからメッセージ入力欄への挿入機能」の設計方針書に対し、既存機能・テスト・パフォーマンス・後方互換性への影響を分析した。

設計方針書は既存コードの構造を正確に把握しており、全props追加がoptionalで後方互換性が確保されている。must_fixは1件(useEffect間の順序前提の明文化)のみで、致命的な問題はない。

---

## 調査対象ファイル

| ファイル | 行数 | useState数 | useCallback数 | 影響の種類 |
|---------|------|-----------|--------------|----------|
| WorktreeDetailRefactored.tsx | ~1760 | 21 | 44 | state追加、callback追加、props変更 |
| MessageInput.tsx | ~457 | 6 | 7 | props追加、useEffect追加 |
| HistoryPane.tsx | - | - | - | props追加(中継) |
| ConversationPairCard.tsx | - | - | - | props追加、UI追加 |
| MemoCard.tsx | - | - | - | props追加、UI追加 |
| MemoPane.tsx | - | - | - | props追加(中継) |
| NotesAndLogsPane.tsx | - | - | - | props追加(中継) |
| WorktreeDetailSubComponents.tsx | - | - | - | MobileContent props追加(中継) |

---

## 指摘事項

### must_fix (1件)

#### D3-003: MessageInputのuseEffect競合 -- pendingInsertText消費とlocalStorage下書き復元の順序問題

MessageInput内のlocalStorage復元useEffect(行72-84)とpendingInsertText消費useEffectの間で、コンポーネントマウント直後にpendingInsertTextが非nullで渡されるシナリオでの動作順序が設計書に明記されていない。

実際にはpendingInsertTextは初回レンダリング時にnullであるため問題は発生しないが、この前提条件を設計書セクション4-2に明記すべきである。

### should_fix (5件)

#### D3-001: pendingInsertText state変更による再レンダリングサイクル

挿入操作1回あたり2回のレンダリングサイクル(content設定 -> nullリセット)が発生する。memo()/useMemo()により実DOM更新は最小限だが、設計書セクション7にこの動作を明記すべき。

#### D3-002: leftPaneMemo依存配列へのhandleInsertToMessage追加

handleInsertToMessageはuseCallback(fn, [])で安定参照のためleftPaneMemoの再計算は発生しない。その理由をコードコメントで説明すべき。

#### D3-005: 既存テストのコンパイル互換性

全新規propsがoptionalのため既存テストにコンパイルエラーは発生しない。ただしNotesAndLogsPane.test.tsxのMemoPaneモックはonInsertToMessageを受け取れるよう更新が必要。

#### D3-008: handleInsertConsumedのuseCallback空依存配列の妥当性

setPendingInsertTextはReactの安定参照のため空依存配列は正しい。設計書に根拠コメントを追記すべき。

#### D3-010: デスクトップ/モバイル同時配信の安全性

isMobile条件分岐で排他的にレンダリングされるため安全だが、設計書にその根拠を明記すべき。

### nice_to_have (4件)

- **D3-004**: pendingInsertText=null時の既存動作への影響なし確認(検証済みの記載推奨)
- **D3-006**: ConversationPairCard.test.tsxが未存在(新規作成時にonCopyテストも含めることを推奨)
- **D3-007**: MobileContent(WorktreeDetailSubComponents.tsx)の4つの変更ポイント明記
- **D3-009**: HistoryPaneのshowToast propとの一貫性確認(問題なし)

---

## 影響範囲マトリクス

| 影響カテゴリ | 影響度 | 根拠 |
|------------|-------|------|
| 既存機能 | 低 | 全props optional、useEffect内early returnで安全 |
| テスト | 低 | 既存テストにコンパイルエラーなし、モック更新のみ必要 |
| パフォーマンス | 低 | useCallback/useMemo/memo()で再レンダリング最小化 |
| 後方互換性 | なし | 全props optional、呼び出しコード変更不要 |

---

## 結論

設計方針書は影響範囲を適切に制御した設計となっている。must_fix 1件はuseEffect間の前提条件の明文化であり、実装の正確性には影響しない。should_fix 5件はいずれも設計書の記述補強に関するものである。条件付きで承認とする。
