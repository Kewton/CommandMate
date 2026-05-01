# Issue #687 マルチステージレビュー完了報告

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| 1 | ConversationPairCard.tsx で toLocaleTimeString() を L211, L278 で使用 | Confirmed |
| 2 | MessageList.tsx:66, PromptMessage.tsx:74 で format(timestamp, 'PPp', { locale }) 使用 | Confirmed |
| 3 | date-utils.ts に formatMessageTimestamp は未実装 | Confirmed |
| 4 | date-utils.ts は date-fns の formatDistanceToNow を使用 | Confirmed |

全仮説が Confirmed。Issue 記載に事実誤りなし。

---

## ステージ別結果

| Stage | レビュー種別 | 指摘数 (M/S/N) | 反映 | ステータス |
|-------|------------|---------------|------|----------|
| 0.5 | 仮説検証 | - | - | 完了 |
| 1 | 通常レビュー（1回目） | 0/3/3 | - | 完了 |
| 2 | 指摘事項反映（1回目） | - | 6/6件 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 0/3/3 | - | 完了 |
| 4 | 指摘事項反映（1回目） | - | 5/6件 | 完了 |
| 5-8 | 2回目イテレーション（Codex） | - | - | **自動スキップ（Must Fix 合計 0件）** |

---

## 主要な改善内容

Stage 1-4 で以下の内容が Issue #687 に追記・整理された：

1. **next-intl ロケール統合手順の明記**: `useLocale()` + `getDateFnsLocale()` を ConversationPairCard に導入する具体的手順
2. **引数型方針の明確化**: `formatMessageTimestamp(timestamp: Date, locale?: Locale)` を ConversationPairCard 専用として限定
3. **既存テストの影響範囲追記**: ConversationPairCard の既存テスト 3 ファイルが回帰テスト対象として明示
4. **実装詳細の記載**: `format(timestamp, 'PPp', locale ? { locale } : undefined)` の内部実装、Invalid Date ガード（空文字フォールバック）
5. **スコープ外の整理**: MessageList.tsx 全体・PromptMessage.tsx・AssistantMessageList.tsx:22 の扱いを明確化
6. **memo 化との整合性**: `useLocale()` の安定参照と再レンダリング挙動の説明
7. **useMemo 依存配列の更新**: `[message.timestamp, dateFnsLocale]` への明示

---

## 次のアクション

- [x] Issueの最終確認（GitHub Issue #687 更新済み）
- [ ] `/design-policy` で設計方針策定
- [ ] `/work-plan` で作業計画立案
- [ ] `/tdd-impl` または `/pm-auto-dev` で実装を開始
