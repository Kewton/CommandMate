# Issue #687 通常レビュー（Stage 1）レポート

## 対象

- Issue番号: #687
- タイトル: MessageHistoryに日付も表示してほしい
- レビュー観点: 通常（整合性・正確性・完全性・明確性・実現可能性）
- 仮説検証: 全 4 件の前提が Confirmed

## サマリー

Issue の記述は具体的で、対象ファイル・行番号・現状コードの記載は仮説検証通り正確。`date-fns` の `'PPp'` フォーマット統一による解決方針も MessageList.tsx / PromptMessage.tsx の参考実装と整合し、技術的実現性は高い。

ただし、ロケール解決の統合手順（next-intl の `useLocale` + `getDateFnsLocale` 連携）、引数型のスコープ（共通化するか限定するか）、既存テストの扱いに関する記述が不足しており、実装着手前の補完が望ましい。

## 集計

| 重要度 | 件数 |
|--------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |
| **合計** | **6** |

## 指摘事項

### S1-001 [Should Fix] ロケール解決方法の不明確さ（next-intl連携が未記載）

**所在**: Issue「実装タスク」「受入条件」、`src/components/worktree/ConversationPairCard.tsx` L199-213, L262-280

**詳細**: Issue では関数シグネチャ `formatMessageTimestamp(timestamp: Date, locale?: Locale)` のみ示されているが、`ConversationPairCard.tsx` は現状 `next-intl` の `useLocale` や `getDateFnsLocale` を import していない。受入条件「ロケールに応じて表示形式が切り替わる」を満たすには、UserMessageSection / AssistantMessageItem の双方でロケール取得が必要。MessageList.tsx:62-66 と PromptMessage.tsx:69-74 は `useLocale()` + `getDateFnsLocale(locale)` のパターンで解決しており、同パターンに揃えるべき。

**改善提案**: 実装タスクに以下を追記。
- `useLocale` / `getDateFnsLocale` の import を `ConversationPairCard.tsx` に追加
- UserMessageSection / AssistantMessageItem 内で `getDateFnsLocale(useLocale())` を呼び出して `formatMessageTimestamp` に渡す（または親 props 経由で受け渡す）

### S1-002 [Should Fix] timestamp 型方針の不明確さ（共通化スコープ）

**所在**: `src/types/models.ts` L211-223、`src/components/worktree/MessageList.tsx:66`、`src/components/worktree/PromptMessage.tsx:74`

**詳細**: `ChatMessage.timestamp` は `Date` 型（models.ts L222-223）。一方、MessageList.tsx / PromptMessage.tsx は防御的に `format(new Date(message.timestamp), 'PPp', ...)` と Date 化している。Issue 提案の `(timestamp: Date, ...)` シグネチャは ConversationPairCard 現状と整合するが、参考実装側との二重ラップ問題に触れていない。

**改善提案**: 以下のいずれかを明記する。
- (a) ConversationPairCard 専用に `Date` のみ受ける関数とし、MessageList.tsx / PromptMessage.tsx の置換は今回スコープ外と明示
- (b) 共通化して `formatMessageTimestamp(timestamp: Date | string, locale?: Locale): string` とし、3 ファイルすべてを置換する

### S1-003 [Should Fix] 影響範囲に既存テストが含まれていない

**所在**:
- `tests/unit/components/worktree/ConversationPairCard.test.tsx`
- `src/components/worktree/__tests__/ConversationPairCard.test.tsx`
- `tests/integration/conversation-pair-card.test.tsx`

**詳細**: ConversationPairCard には既存テストが 3 ファイル存在する。timestamp 表示の検証は現状無いが、UI 文字列を変更するため回帰テスト確認が必要。Issue 影響範囲表には既存テストが未記載。

**改善提案**: 影響範囲テーブルに上記 3 ファイルを追加し、「既存テストが引き続きパスすること」を受入条件に追加する。

### S1-004 [Nice to Have] 他の toLocaleTimeString() 残存箇所の扱い

**所在**:
- `src/components/worktree/MessageList.tsx:603`（`new Date().toLocaleTimeString()`）
- `src/components/home/AssistantMessageList.tsx:22`（`timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`）

**詳細**: Issue は ConversationPairCard.tsx のみを対象としているが、他にも 2 箇所 `toLocaleTimeString` の使用がある。MessageList.tsx:603 はリアルタイム時刻表示の用途で目的が異なるため対象外と推察できるが、AssistantMessageList.tsx:22 は同種の問題（日付不明）が発生し得る。

**改善提案**: 「スコープ外」セクションを追加し、各残存箇所について対象外/別 Issue 化/今回含める のいずれかの判断を明記する。

### S1-005 [Nice to Have] 受入条件のフォーマット例の妥当性

**所在**: Issue「受入条件」

**詳細**: 受入条件に「日本語: `2026年1月1日 12:34` / 英語: `Jan 1, 2026, 12:34 PM`」とあるが、date-fns の `'PPp'` は Long Date + Long Time のため、実際の出力には秒や AM/PM が含まれる場合がある。Issue 例文と実出力の乖離可能性。

**改善提案**: 受入条件のサンプル文字列を「date-fns `'PPp'` 出力に従う（MessageList.tsx と同一）」と簡潔に表現するか、秒表示有無を明記する。

### S1-006 [Nice to Have] useMemo 依存配列の更新

**所在**: `src/components/worktree/ConversationPairCard.tsx` L210-213, L277-280

**詳細**: 現状の `useMemo(() => message.timestamp.toLocaleTimeString(), [message.timestamp])` は依存配列に `message.timestamp` のみ。locale を引数に取るよう変更する場合、依存配列に locale を追加する必要があるが、Issue 実装タスクには未記載。

**改善提案**: 実装タスクに「useMemo 依存配列を `[message.timestamp, dateFnsLocale]` に更新する」を明記する。

## 結論

Must Fix なし。Should Fix 3 件を補完すれば work-plan 段階に進める品質。Nice to Have 3 件は実装時に判断・補正可能なレベル。

仮説検証で前提条件は全て確認済みのため、コアロジック（`'PPp'` フォーマット統一）の方向性は変更不要。ロケール統合・スコープ境界・テスト方針の明確化が主な補完事項。
