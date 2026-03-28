# Issue #565 作業計画

## Issue: Copilot CLI（TUI/alternate screen）対応: レスポンス保存・重複・メッセージ送信の問題
**Issue番号**: #565
**サイズ**: L
**優先度**: High
**ブランチ**: `feature/565-copilot-tui-support`（既存）

---

## 詳細タスク分解

### Phase 1: 基盤（パターン定義・定数・独立モジュール）

- [ ] **Task 1.1**: 遅延定数ファイル作成
  - 成果物: `src/config/copilot-constants.ts`
  - 内容: `COPILOT_SEND_ENTER_DELAY_MS`, `COPILOT_TEXT_INPUT_DELAY_MS` 定義
  - テスト: 不要（定数のみ）
  - 依存: なし

- [ ] **Task 1.2**: COPILOT_SKIP_PATTERNS拡張
  - 成果物: `src/lib/detection/cli-patterns.ts`
  - 内容: 実機確認済みパターン追加（SEPARATOR, THINKING, SELECTION_LIST）
  - テスト: `tests/unit/lib/cli-patterns-copilot.test.ts`（新規）
  - 依存: なし

- [ ] **Task 1.3**: prompt-dedup.ts独立モジュール作成
  - 成果物: `src/lib/polling/prompt-dedup.ts`
  - 内容: `isDuplicatePrompt()`, `clearPromptHashCache()` 実装
  - テスト: `tests/unit/lib/prompt-dedup.test.ts`（新規）
  - 依存: なし

### Phase 2: TuiAccumulator Copilot対応

- [ ] **Task 2.1**: extractCopilotContentLines/normalizeCopilotLine実装
  - 成果物: `src/lib/tui-accumulator.ts`（既存修正）
  - 内容: Copilot用コンテンツ抽出関数・正規化関数の新設、export
  - テスト: `tests/unit/lib/tui-accumulator-copilot.test.ts`（新規）
  - 依存: Task 1.2（COPILOT_SKIP_PATTERNS）

- [ ] **Task 2.2**: accumulateTuiContentシグネチャ拡張
  - 成果物: `src/lib/tui-accumulator.ts`（既存修正）
  - 内容: cliToolIdパラメータ追加（デフォルト'opencode'で後方互換）、分岐ロジック
  - テスト: 既存テスト（response-poller-tui-accumulator.test.ts）が壊れないこと確認 + cliToolId='copilot'のテスト追加
  - 依存: Task 2.1

### Phase 3: レスポンス整形・抽出

- [ ] **Task 3.1**: cleanCopilotResponse本実装
  - 成果物: `src/lib/response-cleaner.ts`（既存修正）
  - 内容: placeholder → normalizeCopilotLine再利用 + COPILOT_SKIP_PATTERNSフィルタ
  - テスト: `tests/unit/lib/response-cleaner-copilot.test.ts`（新規）
  - 依存: Task 2.1（normalizeCopilotLine export）

- [ ] **Task 3.2**: resolveExtractionStartIndex Copilot分岐追加
  - 成果物: `src/lib/response-extractor.ts`（既存修正）
  - 内容: OpenCodeのBranch 2aにcopilotを追加
  - テスト: 既存テスト更新 + Copilot用テストケース追加
  - 依存: なし

### Phase 4: ポーリング制御統合

- [ ] **Task 4.1**: response-poller.ts accumulateTuiContent呼び出し修正
  - 成果物: `src/lib/polling/response-poller.ts`（既存修正）
  - 内容: L605-608のaccumulateTuiContent呼び出しにcliToolId引数追加
  - 依存: Task 2.2

- [ ] **Task 4.2**: プロンプト重複防止統合
  - 成果物: `src/lib/polling/response-poller.ts`（既存修正）
  - 内容: checkForResponse()内のpromptメッセージ保存前にisDuplicatePromptチェック挿入（L661直後、L665 createMessage前）
  - 依存: Task 1.3

- [ ] **Task 4.3**: Copilot蓄積コンテンツ→レスポンス保存フロー
  - 成果物: `src/lib/polling/response-poller.ts`（既存修正）
  - 内容: cliToolId === 'copilot' の場合にgetAccumulatedContent(pollerKey)で蓄積コンテンツをレスポンス本文として使用（OpenCodeには影響させない）
  - 依存: Task 4.1

### Phase 5: メッセージ送信安定化

- [ ] **Task 5.1**: send/route.ts遅延定数化
  - 成果物: `src/app/api/worktrees/[id]/send/route.ts`（既存修正）
  - 内容: ハードコード200ms → COPILOT_SEND_ENTER_DELAY_MS参照
  - 依存: Task 1.1

- [ ] **Task 5.2**: terminal/route.ts遅延定数化
  - 成果物: `src/app/api/worktrees/[id]/terminal/route.ts`（既存修正）
  - 内容: ハードコード200ms → COPILOT_SEND_ENTER_DELAY_MS参照
  - 依存: Task 1.1

- [ ] **Task 5.3**: copilot.ts sendMessage()遅延定数化
  - 成果物: `src/lib/cli-tools/copilot.ts`（既存修正）
  - 内容: ハードコード100ms/200ms → COPILOT_TEXT_INPUT_DELAY_MS/COPILOT_SEND_ENTER_DELAY_MS
  - 依存: Task 1.1

### Phase 6: クリーンアップ統合

- [ ] **Task 6.1**: stopPolling promptHashCacheクリア
  - 成果物: `src/lib/polling/response-poller.ts`（既存修正）
  - 内容: stopPolling()内でclearPromptHashCache()呼び出し追加
  - 依存: Task 1.3

- [ ] **Task 6.2**: session-cleanup.ts promptHashCacheクリア
  - 成果物: `src/lib/session-cleanup.ts`（既存修正）
  - 内容: killWorktreeSession()内でclearPromptHashCache()呼び出し追加
  - 依存: Task 1.3

### Phase 7: 品質検証

- [ ] **Task 7.1**: 既存テスト回帰確認
  - 内容: `npm run test:unit` 全パス確認
  - 依存: Phase 1-6 全完了

- [ ] **Task 7.2**: 静的解析
  - 内容: `npx tsc --noEmit && npm run lint` エラー0件
  - 依存: Phase 1-6 全完了

- [ ] **Task 7.3**: ビルド確認
  - 内容: `npm run build` 成功
  - 依存: Task 7.2

---

## タスク依存関係

```
Phase 1（並列実行可能）
  Task 1.1 ─────────────────── Task 5.1, 5.2, 5.3
  Task 1.2 ─── Task 2.1 ─── Task 2.2 ─── Task 4.1 ─── Task 4.3
                  │
                  └─── Task 3.1
  Task 1.3 ─── Task 4.2, 6.1, 6.2

Phase 3（Task 3.2は独立）
  Task 3.2（独立）

Phase 7（全完了後）
  Task 7.1 → 7.2 → 7.3
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| ESLint | `npm run lint` | エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

---

## 成果物チェックリスト

### 新規ファイル
- [ ] `src/config/copilot-constants.ts` — 遅延定数
- [ ] `src/lib/polling/prompt-dedup.ts` — 重複防止モジュール
- [ ] `tests/unit/lib/tui-accumulator-copilot.test.ts` — Copilot用TuiAccumulatorテスト
- [ ] `tests/unit/lib/response-cleaner-copilot.test.ts` — cleanCopilotResponseテスト
- [ ] `tests/unit/lib/prompt-dedup.test.ts` — 重複防止テスト

### 修正ファイル
- [ ] `src/lib/tui-accumulator.ts` — extractCopilotContentLines, normalizeCopilotLine, accumulateTuiContentシグネチャ拡張
- [ ] `src/lib/detection/cli-patterns.ts` — COPILOT_SKIP_PATTERNS拡張
- [ ] `src/lib/response-cleaner.ts` — cleanCopilotResponse本実装
- [ ] `src/lib/response-extractor.ts` — resolveExtractionStartIndex Copilot分岐
- [ ] `src/lib/polling/response-poller.ts` — accumulateTuiContent呼び出し修正, 重複防止統合, 蓄積コンテンツ→レスポンス保存
- [ ] `src/app/api/worktrees/[id]/send/route.ts` — 遅延定数化
- [ ] `src/app/api/worktrees/[id]/terminal/route.ts` — 遅延定数化
- [ ] `src/lib/cli-tools/copilot.ts` — 遅延定数化
- [ ] `src/lib/session-cleanup.ts` — promptHashCacheクリア追加

---

## Definition of Done

- [ ] すべてのタスクが完了
- [ ] CIチェック全パス（lint, type-check, test, build）
- [ ] Copilot用TuiAccumulatorテスト追加済み
- [ ] cleanCopilotResponseテスト追加済み
- [ ] prompt-dedupテスト追加済み
- [ ] 既存テスト（OpenCode TuiAccumulator含む）が壊れないこと
- [ ] 遅延値が3箇所で統一参照されていること

---

## 実装順序（推奨）

1. Phase 1（Task 1.1, 1.2, 1.3）を並列実行
2. Phase 2（Task 2.1 → 2.2）
3. Phase 3（Task 3.1, 3.2）を並列実行
4. Phase 4（Task 4.1 → 4.2, 4.3）
5. Phase 5（Task 5.1, 5.2, 5.3）を並列実行
6. Phase 6（Task 6.1, 6.2）を並列実行
7. Phase 7（Task 7.1 → 7.2 → 7.3）

---

*Generated by /work-plan command for Issue #565*
*Date: 2026-03-28*
