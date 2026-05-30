# Issue #725 pm-auto-dev iteration-1 進捗レポート

## 1. Issue 概要

| 項目 | 内容 |
|------|------|
| **Issue 番号** | #725 |
| **タイトル** | feat(history): improve User/Assistant visual hierarchy in HistoryPane (折りたたみ強化 + 視覚優先度差 + User onlyフィルタ) |
| **サイズ** | M（案A 5分 + 案B 30分 + 案C 半日 ≒ 5-6時間） |
| **優先度** | Medium（UI/UX 改善、機能追加・破壊的変更なし） |
| **作業ブランチ** | `feature/725-worktree` |
| **イテレーション** | 1（完了） |
| **総合ステータス** | Success — 全フェーズ完了、PR 作成準備完了 |

---

## 2. 実行フェーズサマリ

| Phase | フェーズ名 | ステータス | 備考 |
|-------|----------|----------|------|
| 1 | Issue Review (Stage 1-4) | Success | 18 件指摘、全 18 件反映、Issue 本文更新済み |
| 2 | Design Policy | **Skipped** | user feedback `feedback_skip_codex_review.md` — Stage 1-4 後は Phase 4 へ直行 |
| 3 | Design Review | **Skipped** | 同上（Codex 委任の設計レビューはスキップ） |
| 4 | Work Plan | Success | `work-plan.md` 作成、21 タスクに分解（案A/B/C + docs） |
| 5 | TDD 実装 | Success | 3 コミット (案A/B/C)、Red-Green-Refactor 完了 |
| 5.1 | 受入テスト | Passed | 9 シナリオ全 pass、品質ゲート 5/5 pass |
| 5.2 | リファクタ判定 | YAGNI 見送り | 候補 4 件評価、適用 0 件（既存パターン踏襲で十分） |
| 5.3 | docs 更新 | Success | CLAUDE.md（5 行）+ CHANGELOG.md（Added + Changed） |
| 6 | UAT | **Skipped** | user opt-out — 6588 unit + 9 受入シナリオ + 5 品質ゲートでカバー済み |
| 7 | PR 作成 | Pending | `/create-pr` で次に実行（スクリーンショット添付付き） |

---

## 3. Issue Review 結果（Phase 1）

### 仮説検証（Stage 0.5）

9 仮説中 **8 Confirmed / 1 Partially Confirmed**（H3: `COLLAPSED_MAX_LINES = 5` の体感行数を再評価）。

### Stage 別指摘・反映

| Stage | レビュー種別 | Must Fix | Should Fix | Nice to Have | 反映 |
|-------|------------|---------|-----------|--------------|------|
| 1 | 通常レビュー | 2 | 4 | 3 | — |
| 2 | 反映（通常） | — | — | — | 9/9 |
| 3 | 影響範囲レビュー | 1 | 3 | 5 | — |
| 4 | 反映（影響範囲） | — | — | — | 9/9 |
| **合計** | — | **3** | **7** | **8** | **18/18** |

### 主要 Must Fix 反映

- **S1-001**: `pair.type === 'orphan'` → `pair.status === 'orphan'`（TS 型整合）
- **S1-002**: トグル ARIA を `aria-pressed` に統一（既存 HistoryPane 検索トグル準拠）
- **S3-001**: 影響範囲表に `tests/integration/conversation-pair-card.test.tsx` を追加（案B のクラス変更で破壊するセレクタを明示）

Issue URL: https://github.com/Kewton/CommandMate/issues/725

---

## 4. 実装サマリ（Phase 5）

### コミット一覧（4 コミット）

| # | コミット | 種別 | 内容 |
|---|---------|------|------|
| 1 | `46c5f510` | feat (案A) | Assistant メッセージのデフォルト折りたたみを **2行/100文字** に強化（旧 5行/300文字） |
| 2 | `c6a81639` | feat (案B) | Assistant スタイル弱化（`text-xs`, `p-2`, `bg-gray-900/30`, `border-gray-700`, `space-y-2`）+ User 側に防御セット（`[word-break:break-word]`, `max-w-full`, `overflow-x-hidden`）追加 |
| 3 | `91cba686` | feat (案C) | HistoryPane に **User only** フィルタトグル追加（lucide-react `User`/`UserCheck`、`aria-pressed`、localStorage 永続化、検索併用優先順位制御） |
| 4 | `08778d94` | docs | CLAUDE.md モジュールリファレンス 5 行更新 + CHANGELOG.md Added/Changed セクション追記 |

### 主要変更ファイル

- `src/components/worktree/ConversationPairCard.tsx` — 定数変更 + スタイル弱化 + `showAssistant` prop 追加
- `src/components/worktree/HistoryPane.tsx` — User only トグル UI + `searchableMessages` role フィルタ + orphan スキップ
- `src/components/worktree/WorktreeDetailRefactored.tsx` — `historyUserOnly` state + localStorage 永続化 + props 伝播
- `src/components/worktree/WorktreeDetailSubComponents.tsx` — `MobileContentProps` 拡張 + props フォワード
- `src/config/history-display-config.ts` — `HISTORY_USER_ONLY_STORAGE_KEY` 追加
- テスト 2 ファイル（HistoryPane.integration / conversation-pair-card.integration）

### 設計制約遵守

- 案C state は `WorktreeDetailRefactored` 親持ち + props 伝播（#168/#701 パターン踏襲）
- localStorage 値は `'true'/'false'` 表現（`commandmate:showArchived` と整合、旧 `'1'/'0'` は false 扱い）
- `userOnly > autoExpandedIds` 優先（Assistant マッチでも `showAssistant=false` で非表示）
- アイコンは lucide-react（絵文字回避）

---

## 5. 品質指標

### 静的解析・ビルド

| 項目 | コマンド | 結果 |
|------|---------|------|
| TypeScript | `npx tsc --noEmit` | 0 errors |
| ESLint | `npm run lint` | 0 errors / 0 warnings |
| Build | `npm run build` | success (worktrees/[id] 400 kB, middleware 28.9 kB) |

### テスト結果

| テストファイル | Pass | Fail | Skip | 備考 |
|--------------|------|------|------|------|
| `ConversationPairCard.test.tsx` | 24 | 0 | 0 | 既存トランケーションテストが新定数で全 green |
| `HistoryPane.integration.test.tsx` | 20 | 0 | 0 | **13 既存 + 7 新規（Issue #725）** |
| `tests/integration/conversation-pair-card.test.tsx` | 5 | 0 | 0 | Assistant 側セレクタ更新済み |
| `npm run test:unit` 全体 | 6588 | 0 | 7 | 348 ファイル |

### 新規テスト 7 件（Issue #725 describe block）

1. `historyUserOnly=true` で AssistantMessagesSection 非表示
2. `historyUserOnly=false` で AssistantMessagesSection 表示
3. orphan ペア（userMessage なし）が User only モードで非表示
4. `aria-pressed` がトグル state を反映
5. クリックで `onHistoryUserOnlyChange(!historyUserOnly)` 呼び出し
6. 検索 × User only 優先順位（Assistant マッチでも非表示）
7. `onHistoryUserOnlyChange` 未指定時はトグルボタン非描画

### 既知の無関係失敗

- `tests/integration/trust-dialog-auto-response.test.ts` AC5 timeout — Issue #725 適用前から失敗、無関係（`tdd-result.json` 記録済み）

---

## 6. リファクタ判定（YAGNI で見送り）

`refactor_applied: false` — 候補 4 件すべて評価の上、適用なし。

| # | 候補 | 判定 | 主な理由 |
|---|------|------|---------|
| 1 | HistoryPane ヘッダーのサブコンポーネント抽出 | no-extract | props drilling 増加、行数増、専用 UI で再利用なし |
| 2 | `useLocalStorageBool` 共通フック | out-of-scope | #168 既存実装への影響、ジェネリック化で複雑化、Issue スコープ超え |
| 3 | テスト render helper 統一 | no-extract | 既存 13 テストとの一貫性、各テスト自己完結のデバッグ性 |
| 4 | `searchableMessages` filter の関数抽出 | no-simplify | 短絡評価は慣用句、コメントで意図明示済み |

### Nice to Have（将来 Issue 候補）

1. `useLocalStorageBool` 共通フック（cross-issue リファクタ）
2. `HeaderControls` サブコンポーネント抽出（要素 5 つ超えた時）
3. テスト render helper 一括統一（file-wide cleanup PR）
4. `ConversationPairCard` 折りたたみ定数を `history-display-config.ts` へ移動

---

## 7. 残課題・次アクション

### 次のアクション

1. **`/create-pr` で PR 作成** — 4 コミット構成（案A/B/C + docs）でレビュアーが段階的にレビュー可能
2. **PR description にスクリーンショット添付**
   - 案A: 2 行 vs 旧 5 行表示の比較
   - 案B: ダークモードコントラスト（`text-gray-300` on `bg-gray-900/30` の WCAG AA 4.5:1 検証）
   - 案C: User only トグル ON/OFF 状態
3. **develop ブランチへのマージ後、Issue #725 クローズ**

### UAT スキップの背景

- ユーザー判断によりスキップ
- 品質はすでに以下で網羅:
  - **6588 unit/integration tests** 全 pass
  - **9 受入シナリオ** 全 pass
  - **5 品質ゲート** (tsc/lint/test_unit/test_integration_target/build) 全 pass
- スクリーンショット撮影・WCAG AA コントラスト確認は PR レビュー時に実機検証で代替

### 残課題

- なし（実装スコープ内のブロッカーは無し、PR 作成のみ残）
