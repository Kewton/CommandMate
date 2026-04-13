# Issue #651 仮説検証レポート

## 判定: スキップ（機能追加Issue）

本Issueは機能追加（feat）であり、バグ原因の仮説や推測を含まないため、仮説検証フェーズをスキップします。

## コードベース確認事項

以下はIssueの前提条件として記載された事実をコードで確認した結果です。

| # | 主張 | 判定 | 根拠 |
|---|------|------|------|
| 1 | `DEFAULT_SIDEBAR_WIDTH = 288px`（`w-72`） | Confirmed | `src/contexts/SidebarContext.tsx` line 30 に `DEFAULT_SIDEBAR_WIDTH = 288` の定数が存在 |
| 2 | サイドバーのViewModeは `grouped`（ツリー）と `flat` の2種類 | Confirmed | `src/lib/sidebar-utils.ts` で `ViewMode = 'grouped' \| 'flat'` として定義済み |
| 3 | ツールチップは `title` 属性のみで実装（専用ライブラリなし） | Confirmed | `BranchListItem.tsx`, `BranchStatusIndicator.tsx` 等で `title={}` のみ使用。専用ツールチップライブラリは未導入 |
| 4 | `src/components/sidebar/BranchListItem.tsx` がメイン変更対象 | Confirmed | BranchListItem がブランチ一覧の各行を担い、リポジトリ名・ブランチ名・ステータスを表示 |

## Stage 1 への申し送り

- 仮説の否定なし
- ツールチップ実装方針（既存`title`属性拡充 vs カスタムコンポーネント新規作成）がIssueに未記載 → レビューで確認が必要
