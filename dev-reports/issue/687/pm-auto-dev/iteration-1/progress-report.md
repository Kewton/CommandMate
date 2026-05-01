# 進捗レポート - Issue #687 (Iteration 1)

## 概要

**Issue**: #687 - MessageHistoryに日付も表示してほしい
**Iteration**: 1
**ブランチ**: `feature/687-worktree`
**報告日時**: 2026-05-01
**総合ステータス**: 成功

MessageHistory（ConversationPairCard）のタイムスタンプを `toLocaleTimeString()` の時刻のみ表示から、`date-fns` の `'PPp'` フォーマットによる日付＋時刻の表示に変更。`MessageList.tsx` / `PromptMessage.tsx` と同一フォーマットに統一し、ロケール（日本語/英語）切替にも対応。

---

## フェーズ別結果

### Phase 1: TDD実装

**ステータス**: 成功

| 指標 | 値 |
|------|-----|
| 新規テスト | 7件（`formatMessageTimestamp`） |
| `date-utils` テスト合計 | 16/16 passed |
| 全ユニットテスト | 6406 passed / 7 skipped |
| `ConversationPairCard` 回帰テスト | 36/36 passed |
| TypeScript (`tsc --noEmit`) | pass |
| ESLint (`npm run lint`) | pass |

**TDDサイクル**:
- **Red**: `formatMessageTimestamp` の 7 失敗テストを追加（ja/enUS/no-locale フォーマット、ロケール差サニティ、Invalid Date ガード、非 Date ガード、PPp 出力一貫性）
- **Green**: `src/lib/date-utils.ts` に `formatMessageTimestamp(timestamp, locale?)` を実装。`date-fns` の `format(date, 'PPp', { locale })` を使用し、Invalid Date / 非 Date 入力時は空文字を返す防御的フォールバックを実装
- **Refactor**: `ConversationPairCard.tsx` の `UserMessageSection` / `AssistantMessageItem` の `toLocaleTimeString()` を新ヘルパー＋ `useLocale` ＋ `getDateFnsLocale` に置換し、`MessageList.tsx` / `PromptMessage.tsx` のスタイルに合わせた

**変更ファイル**:
- `src/lib/date-utils.ts` - `formatMessageTimestamp(timestamp: Date, locale?: Locale): string` を追加
- `src/components/worktree/ConversationPairCard.tsx` - 2 箇所の `toLocaleTimeString()` を `formatMessageTimestamp()` に置換
- `tests/unit/lib/date-utils.test.ts` - `formatMessageTimestamp` 用テスト 7 ケース追加

**コミット**:
- `f73ec695`: feat(#687): show date+time in MessageHistory timestamps

---

### Phase 2: 受入テスト

**ステータス**: 成功（5/5 受入条件パス）

| 受入条件 | 結果 | 検証内容 |
|---------|------|---------|
| MessageHistory に `'PPp'` 形式の日付＋時刻が表示される | passed | `src/lib/date-utils.ts` lines 71-76 で `format(timestamp, 'PPp', locale ? { locale } : undefined)` を使用 |
| ロケールに応じて表示形式が切り替わる（日本語/英語） | passed | `UserMessageSection` (line 215-217) / `AssistantMessageItem` (line 283-285) で `useLocale()` ＋ `getDateFnsLocale()` 解決済 locale を渡している |
| `formatMessageTimestamp` のユニットテスト 7 ケース全パス | passed | Test Files 1 passed, Tests 16 passed (16)。Invalid Date ガードも実装済 (line 72) |
| ConversationPairCard 既存テスト（unit / integration）回帰なし | passed | 34/34 全パス。`toLocaleTimeString` 残存 0 件、`formatMessageTimestamp` 参照 3 件（import + 2 使用箇所） |
| TypeScript 型チェックパス | passed | `npx tsc --noEmit` EXIT_CODE=0 |
| ESLint エラーなし | passed | `npm run lint`: No ESLint warnings or errors |

**ユニット/結合テスト集計**:
- `date-utils`: 16/16 passed
- ConversationPairCard 関連: 34/34 passed
- 全 unit suite (filter date-utils): 6406 passed / 7 skipped
- 全 unit suite (filter ConversationPairCard): 6430 passed / 7 skipped

---

### Phase 3: リファクタリング

**ステータス**: 成功（動作変更なし、3 ファイル修正、+8 / -17 行）

**変更内容**:
1. `src/lib/date-utils.ts` - `formatMessageTimestamp` の JSDoc を簡潔化。`MessageList`/`PromptMessage` との整合性および `getDateFnsLocale()` 利用方針を 1 段落に圧縮し、テスト固有の `as any` 記述を API ドキュメントから削除（テスト関心事の漏れを排除）
2. `src/components/worktree/ConversationPairCard.tsx` - `UserMessageSection` と `AssistantMessageItem` に重複していた `Issue #687: Show PPp ...` の 2 行コメントを両箇所から削除し、`MessageList.tsx` / `PromptMessage.tsx` と同じ無コメント・スタイルに統一（YAGNI / 一貫性向上）
3. `tests/unit/lib/date-utils.test.ts` - 4 行重複していた per-line `eslint-disable @typescript-eslint/no-explicit-any` をブロック単位の `/* eslint-disable */ /* eslint-enable */` 1 組に集約（DRY）

**変更不要と判断した項目**:
- `date-utils.ts`: import 集約済、未使用 import / `console.log` なし
- `ConversationPairCard.tsx`: `toLocaleTimeString` 残骸なし、import 順序整合済、`useMemo` 使わない直接呼出が `MessageList` / `PromptMessage` と一致、整形ロジックは両セクションで対称
- `tests/unit/lib/date-utils.test.ts`: `afterEach` のスコープは `formatRelativeTime` describe 内に限定されており適切。エッジケース網羅済

**テスト結果**:
- 全 unit テスト: 6406 passed / 7 skipped (340 test files)
- TypeScript: pass
- ESLint: pass

**コミット**:
- `c1f71a08`: refactor(#687): tighten timestamp helper docs and remove redundant comments

---

### Phase 4: ドキュメント最新化

**ステータス**: 成功

- `CLAUDE.md` の `src/lib/date-utils.ts` セクション説明を更新し、`formatMessageTimestamp` の追加を反映

---

### Phase 5: UAT（実機受入テスト）

**ステータス**: 成功（8/8 全パス、合格率 100%）

| 指標 | 値 |
|------|-----|
| TC合格 | 8 |
| TC合計 | 8 |
| 合格率 | 100% |

---

## 総合品質メトリクス

| 指標 | 値 | 状態 |
|------|-----|------|
| 全 unit テスト | 6406 passed / 7 skipped | パス |
| 新規テスト追加 | 7 件（`formatMessageTimestamp`） | パス |
| `ConversationPairCard` 回帰 | 36/36 passed | 回帰なし |
| TypeScript エラー | 0 | パス |
| ESLint エラー/警告 | 0 | パス |
| 受入条件達成 | 5/5 | 全達成 |
| UAT TC合格率 | 8/8 (100%) | パス |

---

## ブロッカー / 課題

**ブロッカーなし**。全フェーズ成功、回帰なし、品質基準を満たしている。

懸念事項として特筆するレベルのものはなし。

---

## 次のステップ

すべてのフェーズが成功しているため、PR 作成フェーズへ進むことを推奨。

1. **PR 作成** - `feature/687-worktree` から `develop` ブランチへの PR を作成
   - PRタイトル例: `feat: show date+time in MessageHistory timestamps (#687)`
   - 関連コミット: `f73ec695`（実装）, `c1f71a08`（リファクタ）
2. **レビュー依頼** - チームメンバーにコードレビュー依頼
3. **マージ後の確認** - `develop` でのスモーク確認後、`main` へのリリース PR 計画

---

## 備考

- TDD → 受入 → リファクタ → ドキュメント → UAT のすべてのフェーズが計画通り完了
- `MessageList.tsx` / `PromptMessage.tsx` のフォーマット（`'PPp'`）に統一したことで、コードベース全体のタイムスタンプ表示が一貫
- ロケール切替（日本語/英語）に対応済み
- 動作変更を伴わない品質改善（JSDoc 整理、コメント整理、eslint-disable 集約）まで実施済み

**Issue #687 の実装が完了しました。**
