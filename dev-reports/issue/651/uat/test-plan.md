# Issue #651 実機受入テスト計画

## テスト概要
- Issue: #651 feat(sidebar): PC版サイドバーをコンパクト化し、ツールチップで詳細表示
- テスト日: 2026-04-13
- テスト環境: CommandMate サーバー（localhost:自動検出）

## 前提条件
- CommandMateが正常にビルドできること
- 少なくとも1つのリポジトリ・ワークツリーが存在すること

## テストケース一覧

### TC-001: サイドバー幅の縮小確認（AppShell.tsx）
- **テスト内容**: デスクトップサイドバーに `w-56` クラスが適用されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "w-56" src/components/layout/AppShell.tsx`
- **期待結果**: デスクトップサイドバーのクラスに `w-56` が含まれる行が存在
- **確認観点**: 受入条件「サイドバー幅が224px（w-56）に縮小」

### TC-002: メインコンテンツpadding確認
- **テスト内容**: メインコンテンツに `md:pl-56` が適用されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "pl-56" src/components/layout/AppShell.tsx`
- **期待結果**: `md:pl-56` が含まれる行が存在
- **確認観点**: 受入条件「DEFAULT_SIDEBAR_WIDTH定数とAppShell.tsxのレイアウト幅が一致」

### TC-003: DEFAULT_SIDEBAR_WIDTH定数確認
- **テスト内容**: DEFAULT_SIDEBAR_WIDTHが224に更新されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "DEFAULT_SIDEBAR_WIDTH" src/contexts/SidebarContext.tsx`
- **期待結果**: `DEFAULT_SIDEBAR_WIDTH = 224` が存在
- **確認観点**: 受入条件「定数との一致」

### TC-004: LocalStorageマイグレーション実装確認
- **テスト内容**: useSidebar.tsに旧値288→224マイグレーションが実装されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "LEGACY_SIDEBAR_WIDTH\|288" src/hooks/useSidebar.ts`
- **期待結果**: `LEGACY_SIDEBAR_WIDTH = 288` と変換ロジックが存在
- **確認観点**: 受入条件「localStorage互換性対応」

### TC-005: SidebarBranchItem型のworktreePath確認
- **テスト内容**: SidebarBranchItem型にworktreePathフィールドが追加されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "worktreePath" src/types/sidebar.ts`
- **期待結果**: `worktreePath?: string` が存在
- **確認観点**: 受入条件「ツールチップのworktreeパス表示」

### TC-006: toBranchItem()のworktreePathマッピング確認
- **テスト内容**: toBranchItem()でworktreePathがマッピングされている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "worktreePath" src/types/sidebar.ts`
- **期待結果**: `worktreePath: worktree.path` のマッピングが存在
- **確認観点**: 受入条件「SidebarBranchItem.worktreePathから正しく取得」

### TC-007: showRepositoryName propsの実装確認
- **テスト内容**: BranchListItemにshowRepositoryName propsが実装されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "showRepositoryName" src/components/sidebar/BranchListItem.tsx`
- **期待結果**: `showRepositoryName` propsの定義と条件分岐が存在
- **確認観点**: 受入条件「ツリー表示モード時、リポジトリ名が表示されない」

### TC-008: ツールチップWAI-ARIA実装確認
- **テスト内容**: BranchListItemにrole="tooltip"のツールチップが実装されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n 'role="tooltip"\|aria-describedby' src/components/sidebar/BranchListItem.tsx`
- **期待結果**: `role="tooltip"` と `aria-describedby` が存在
- **確認観点**: 受入条件「WAI-ARIA tooltipパターンに準拠」

### TC-009: ツールチップにworktreeパスの表示確認
- **テスト内容**: BranchTooltipコンポーネントでworktreePathを表示
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "worktreePath\|BranchTooltip" src/components/sidebar/BranchListItem.tsx`
- **期待結果**: worktreePathを表示するコードが存在
- **確認観点**: 受入条件「ツールチップにworktreeパス表示」

### TC-010: Sidebar.tsxのshowRepositoryName受け渡し確認
- **テスト内容**: grouped表示でshowRepositoryName={false}が渡されている
- **前提条件**: ビルド済みソースコード
- **実行手順**: `grep -n "showRepositoryName" src/components/layout/Sidebar.tsx`
- **期待結果**: `showRepositoryName={false}` がgrouped表示に存在
- **確認観点**: 受入条件「ツリー表示モード時リポジトリ名非表示」

### TC-011: ユニットテスト全件パス確認
- **テスト内容**: npm run test:unit が全件パスする
- **前提条件**: 実装済みコード
- **実行手順**: `npm run test:unit -- --reporter=verbose 2>&1 | tail -20`
- **期待結果**: 全テスト通過（0 failures）
- **確認観点**: 受入条件「npm run test:unit がパスする」

### TC-012: TypeScript型チェック確認
- **テスト内容**: npx tsc --noEmit が0エラー
- **前提条件**: 実装済みコード
- **実行手順**: `npx tsc --noEmit 2>&1 | tail -10`
- **期待結果**: エラーなし（exit code 0）
- **確認観点**: 受入条件「npx tsc --noEmit がパスする」

### TC-013: ESLintチェック確認
- **テスト内容**: npm run lint が0エラー
- **前提条件**: 実装済みコード
- **実行手順**: `npm run lint 2>&1 | tail -10`
- **期待結果**: エラー0件
- **確認観点**: 受入条件「npm run lint がパスする」

### TC-014: ビルド成功確認
- **テスト内容**: npm run build が成功する
- **前提条件**: 実装済みコード
- **実行手順**: `npm run build 2>&1 | tail -20`
- **期待結果**: ビルド成功（exit code 0）
- **確認観点**: 総合的な品質確認

### TC-015: 既存サイドバー機能の回帰確認
- **テスト内容**: 既存サイドバー機能（viewMode変更）が動作する
- **前提条件**: 実装済みコード
- **実行手順**: ユニットテストのSidebarContext.test.tsxが依然としてパスしている
- **期待結果**: SidebarContextに関連するテストが全件パス
- **確認観点**: 受入条件「既存のサイドバー機能が正常動作する」
