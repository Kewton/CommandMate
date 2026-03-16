# Issue #504 仮説検証レポート

## 検証日時
- 2026-03-16

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | サイドバーでリポジトリをグループ表示している | Confirmed | Sidebar.tsx:265-297 GroupHeaderコンポーネント存在 |
| 2 | 全グループが同一フォルダアイコン | Confirmed | Sidebar.tsx:349-365 GroupIcon は静的SVGで全グループ共通 |
| 3 | 変更対象: Sidebar.tsx GroupHeader + sidebar-utils.ts | Confirmed | 両ファイル存在、役割も正確 |
| 4 | BranchListItem.tsx にCLIステータスドットがある | Confirmed | BranchListItem.tsx:33-55 CliStatusDotコンポーネント存在 |

## 詳細検証

### 前提条件 1: サイドバーのリポジトリグループ表示

**Issue内の記述**: 「サイドバーでリポジトリをグループ表示しているが、全グループが同一アイコンのため視覚的な区別がつかない」

**検証手順**:
1. `src/components/layout/Sidebar.tsx` を確認
2. GroupHeaderコンポーネント（265-297行目）の存在を確認
3. viewMode === 'grouped' 時にgroupBranches()でグループ化（82-84行目）

**判定**: Confirmed

**根拠**: GroupHeaderコンポーネントが存在し、repositoryName, branchCount, isExpanded, onClickをpropsとして受け取る。

### 前提条件 2: 全グループが同一アイコン

**Issue内の記述**: 「全グループが同一アイコンのため視覚的な区別がつかない」

**検証手順**:
1. GroupIcon コンポーネント（349-365行目）を確認
2. 静的なフォルダSVGアイコンで、色やバリエーションのパラメータなし

**判定**: Confirmed

**根拠**: GroupIconは固定のSVGパスを描画し、全グループで同一の表示。

### 前提条件 3: 変更対象ファイル

**Issue内の記述**: 変更対象として `Sidebar.tsx` の `GroupHeader` と `sidebar-utils.ts` を指定

**検証手順**:
1. `src/components/layout/Sidebar.tsx` - GroupHeaderコンポーネント存在確認
2. `src/lib/sidebar-utils.ts` - sortBranches(), groupBranches()等のユーティリティ関数確認

**判定**: Confirmed

**根拠**: 両ファイルとも存在し、Issueの記載通りの役割を担っている。sidebar-utils.tsには色生成ロジックは未実装（追加予定）。

### 前提条件 4: BranchListItem.tsx のCLIステータスドット

**Issue内の記述**: 「BranchListItem.tsx（CLIステータスドットとのデザイン整合性）」

**検証手順**:
1. `src/components/sidebar/BranchListItem.tsx` を確認
2. CliStatusDotコンポーネント（33-55行目）を確認

**判定**: Confirmed

**根拠**: CliStatusDotは `w-2 h-2 rounded-full` のドットUIで、SIDEBAR_STATUS_CONFIGから色を取得。リポジトリ色ドットのデザイン時にサイズ・形状の整合性を考慮する必要あり。

---

## Stage 1レビューへの申し送り事項

- 全前提条件がConfirmedのため、特別な修正は不要
- CLIステータスドット（w-2 h-2）とリポジトリ色ドットのサイズ差別化の検討が望ましい
