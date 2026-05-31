# テスト計画レビュー（2回目）

## 1回目指摘事項の対応確認

| # | 種別 | 指摘内容 | 対応状況 |
|---|------|---------|---------|
| 1 | should_fix | `file-panel-pane` testid の実在確認 | ✅ 解消: `src/components/worktree/FilePanelSplit.tsx:198` に `data-testid="file-panel-pane"` 実在を確認 |
| 2 | should_fix | 既存 worktree の存在確認 | ✅ 解消: DB に `mymlxserver-main`（`/Users/maenokota/share/work/github_kewton/MyMLXServer`）が存在。パス実在・ファイル(README.md等)あり |
| 3 | should_fix | 確実に存在するルート直下ファイルを対象に | ✅ 解消: `README.md` をクリック対象に確定 |
| 4 | nice_to_have | before/after 対比 | after のみで判定（修正適用済み）。before 参照値(2825px)は設計方針書から報告書に併記 |

## 網羅性再チェック

| # | 受入条件 | 対応TC | ステータス |
|---|---------|-------|----------|
| 1-2 | FilePanel viewport内 / right<=innerWidth | TC-001 | ✅ |
| 3 | desktop-layout 幅 viewport内 | TC-002 | ✅ |
| 4 | History/ActivityPane変更でもviewport内 | TC-003, TC-004 | ✅ |
| 5 | 既存挙動維持 | TC-005 | ✅ |
| 6-7 | モバイル非変更 / 品質ゲート | TC-006 | ✅ |

## 結論
must_fix: 0件、未解消 should_fix: 0件。テスト計画は実行可能。Phase 5（環境セットアップ）へ進む。
