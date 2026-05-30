# Issue #725 マルチステージレビュー完了報告

## 対象
- Issue: #725 — feat(history): improve User/Assistant visual hierarchy in HistoryPane (折りたたみ強化 + 視覚優先度差 + User onlyフィルタ)
- 実行日: 2026-05-30
- イテレーション: 1回目のみ実行（Stage 5-8 は user feedback `feedback_skip_codex_review.md` によりスキップ）

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| H1 | UserMessageSection は `bg-blue-900/30 border-l-4 p-3 / text-sm` で truncate なし | Confirmed |
| H2 | AssistantMessagesSection は `bg-gray-800/50 border-l-4 p-3 / text-sm`、定数 5行/300文字 | Confirmed |
| H3 | `COLLAPSED_MAX_LINES = 5` が緩く実質 7-8 行分の高さ | Partially Confirmed |
| H4 | 複数 Assistant が `space-y-3` で積み上がる | Confirmed |
| H5 | User/Assistant が同 `p-3`/`text-sm` で視覚的優先度差なし | Confirmed |
| H6 | `HISTORY_DISPLAY_LIMIT_STORAGE_KEY` localStorage パターン既存 | Confirmed |
| H7 | `commandmate:showArchived` トグル localStorage パターン既存 | Confirmed |
| H8 | `ConversationPair.status === 'orphan'` で orphan 表現 | Confirmed |
| H9 | 想定影響範囲のファイル群が存在する | Confirmed |

## ステージ別結果

| Stage | レビュー種別 | Must Fix | Should Fix | Nice to Have | 反映 | ステータス |
|-------|------------|---------|-----------|--------------|------|----------|
| 1 | 通常レビュー（1回目） | 2 | 4 | 3 | - | 完了 |
| 2 | 指摘事項反映（1回目・通常） | - | - | - | 9/9 | 完了 |
| 3 | 影響範囲レビュー（1回目） | 1 | 3 | 5 | - | 完了 |
| 4 | 指摘事項反映（1回目・影響範囲） | - | - | - | 9/9 | 完了 |
| 5-8 | 2回目イテレーション | - | - | - | - | スキップ（user feedback） |

合計: Must Fix 3件 / Should Fix 7件 / Nice to Have 8件 = 18件指摘、すべて Issue 本文へ反映済み。

## 主要な反映内容（実装に直結）

### Must Fix（実装ブロッカー対応）
- **S1-001**: `pair.type === 'orphan'` → `pair.status === 'orphan'`（TypeScript 整合）
- **S1-002**: トグル ARIA を `aria-pressed` に統一（既存検索トグル準拠）
- **S3-001**: 影響範囲表に `tests/integration/conversation-pair-card.test.tsx` を追加（案B のクラス変更で破壊するセレクタを明示）

### Should Fix（実装品質）
- **S1-003**: 案C state を `WorktreeDetailRefactored` 親持ち + props 伝播パターンに統一
- **S1-004**: localStorage 値を `'true'/'false'` で統一（既存 `commandmate:showArchived` と整合）
- **S1-005**: 案A 定数 2行/100文字 の選定根拠を補強、PR description にスクリーンショット添付を受入条件化
- **S1-006**: 案C × 検索機能 #716 併用挙動を明示（`userOnly` > `autoExpandedIds` 優先、user role フィルタ）
- **S3-002**: `isExpanded`（truncate）と `showAssistant`（表示）が独立レイヤーであることを明示
- **S3-003**: モバイル `MobileContent` 経由（`WorktreeDetailSubComponents.tsx`）の props 伝播を影響範囲に追加
- **S3-004**: 案B 時に User 側にも `[word-break:break-word] max-w-full overflow-x-hidden` を付与

## 成果物

- 元 Issue バックアップ: `dev-reports/issue/725/issue-review/original-issue.json`
- 仮説検証: `dev-reports/issue/725/issue-review/hypothesis-verification.md`
- Stage 1 レビュー: `dev-reports/issue/725/issue-review/stage1-review-result.json`
- Stage 2 反映: `dev-reports/issue/725/issue-review/stage2-apply-result.json`
- Stage 3 レビュー: `dev-reports/issue/725/issue-review/stage3-review-result.json`
- Stage 4 反映: `dev-reports/issue/725/issue-review/stage4-apply-result.json`
- 更新後 Issue: https://github.com/Kewton/CommandMate/issues/725

## 次のアクション

- Phase 2/3（設計方針書・設計レビュー）は user feedback によりスキップ
- → Phase 4: `/work-plan 725` で作業計画立案
- → Phase 5: `/pm-auto-dev 725` で TDD 実装
