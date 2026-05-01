# Issue #687 実機受入テスト計画

## テスト概要

- **Issue**: #687 MessageHistoryに日付も表示してほしい
- **テスト日**: 2026-05-01
- **テスト環境**: CommandMate サーバー（ポートは自動検出）
- **ブランチ**: feature/687-worktree

## 変更内容

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/date-utils.ts` | `formatMessageTimestamp(timestamp: Date, locale?: Locale)` を追加 |
| `src/components/worktree/ConversationPairCard.tsx` | `toLocaleTimeString()` → `formatMessageTimestamp()` に置換 |
| `tests/unit/lib/date-utils.test.ts` | `formatMessageTimestamp` のユニットテスト追加（7ケース） |

## 受入条件

1. MessageHistory に date-fns `'PPp'` フォーマット相当の日付+時刻が表示される
2. ロケールに応じて表示形式が切り替わる（日本語/英語）
3. `MessageList.tsx` / `PromptMessage.tsx` と同一フォーマットで表示が統一される
4. `formatMessageTimestamp` のユニットテストがパスする
5. `ConversationPairCard` の既存テスト（unit / integration）が引き続きパスする

---

## テストケース一覧

### TC-001: ユニットテスト全件パス確認
- **テスト内容**: `npm run test:unit` で全ユニットテストがパスすること
- **前提条件**: なし
- **実行手順**: `npm run test:unit -- date-utils --reporter=verbose`
- **期待結果**: 16/16 テスト（うち新規7件）がパス
- **確認観点**: 受入条件 4

### TC-002: ConversationPairCard 回帰テストパス確認
- **テスト内容**: 既存テストが壊れていないこと
- **前提条件**: なし
- **実行手順**: `npm run test:unit -- ConversationPairCard --reporter=verbose`
- **期待結果**: 既存テストが全件パス
- **確認観点**: 受入条件 5

### TC-003: TypeScript 型チェックパス確認
- **テスト内容**: `npx tsc --noEmit` でエラーが出ないこと
- **前提条件**: なし
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: エラー 0件、exit code 0
- **確認観点**: 実装品質

### TC-004: ESLint パス確認
- **テスト内容**: `npm run lint` でエラーが出ないこと
- **前提条件**: なし
- **実行手順**: `npm run lint`
- **期待結果**: エラー・警告 0件
- **確認観点**: 実装品質

### TC-005: toLocaleTimeString 残留なし確認
- **テスト内容**: ConversationPairCard.tsx に `toLocaleTimeString()` が残留していないこと
- **前提条件**: なし
- **実行手順**: `grep -n "toLocaleTimeString" src/components/worktree/ConversationPairCard.tsx`
- **期待結果**: マッチなし（0件）
- **確認観点**: 受入条件 1

### TC-006: formatMessageTimestamp の import 確認
- **テスト内容**: ConversationPairCard.tsx が formatMessageTimestamp を正しく import しているか
- **前提条件**: なし
- **実行手順**: `grep -n "formatMessageTimestamp\|useLocale\|getDateFnsLocale" src/components/worktree/ConversationPairCard.tsx`
- **期待結果**: 3件以上（import行 + 使用箇所2件）
- **確認観点**: 受入条件 1, 2

### TC-007: date-utils.ts の実装確認
- **テスト内容**: formatMessageTimestamp が 'PPp' フォーマットと Invalid Date ガードを実装しているか
- **前提条件**: なし
- **実行手順**: `grep -n "PPp\|instanceof Date\|isNaN" src/lib/date-utils.ts`
- **期待結果**: 3件以上（PPp, instanceof Date, isNaN が含まれる）
- **確認観点**: 受入条件 1, 3

### TC-008: ビルド成功確認
- **テスト内容**: `npm run build` が成功すること
- **前提条件**: なし
- **実行手順**: `npm run build 2>&1 | tail -10`
- **期待結果**: ビルド成功（exit code 0）
- **確認観点**: 実装品質・デプロイ可能性

### TC-009: サーバー起動・UI表示確認（実機）
- **テスト内容**: 実機サーバーでHistoryPaneのタイムスタンプが日付+時刻で表示されること
- **前提条件**: サーバーが起動していること
- **実行手順**: サーバー起動 → API経由でチャット履歴を確認
- **期待結果**: タイムスタンプが日付+時刻形式（'PPp'フォーマット）で返る
- **確認観点**: 受入条件 1, 2
