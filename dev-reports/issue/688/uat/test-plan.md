# Issue #688 実機受入テスト計画

## テスト概要
- **Issue**: #688 PC版にて、「History/Files/CMATE」タブの表示領域の表示/非表示を切り替え可能にしてほしい
- **テスト日**: 2026-05-01
- **テスト環境**: CommandMate サーバー (localhost:UAT_PORT)
- **テスト目的**: 左パネル折りたたみ/展開機能が受入条件を満たすことを確認する

## 前提条件
- ビルドが成功していること（`npm run build:all`）
- サーバーが起動していること（`CM_PORT=<port> ./scripts/build-and-start.sh --daemon`）
- 少なくとも1つのリポジトリ/Worktreeが登録されていること

## テストケース一覧

### TC-001: ユニットテスト - TOGGLE_LEFT_PANE reducer
- **テスト内容**: `TOGGLE_LEFT_PANE` アクションが `leftPaneCollapsed` を false→true にトグルする
- **前提条件**: テストコードが実装済み
- **実行手順**: `npm run test:unit -- --reporter=verbose 2>&1 | grep -E "TOGGLE_LEFT_PANE"`
- **期待結果**: テストがパスする
- **確認観点**: reducer の正常動作

### TC-002: ユニットテスト - SET_LEFT_PANE_COLLAPSED reducer
- **テスト内容**: `SET_LEFT_PANE_COLLAPSED` アクションが `leftPaneCollapsed` を指定値に設定する
- **前提条件**: テストコードが実装済み
- **実行手順**: `npm run test:unit 2>&1 | tail -5`
- **期待結果**: 全テスト（6416件以上）がパスする
- **確認観点**: reducer の正常動作

### TC-003: TypeScript型チェック
- **テスト内容**: 型エラーが0件であること
- **実行手順**: `npx tsc --noEmit`
- **期待結果**: exit code 0、エラーなし
- **確認観点**: 型定義の整合性

### TC-004: ESLint チェック
- **テスト内容**: ESLint エラー/警告が0件であること
- **実行手順**: `npm run lint`
- **期待結果**: "No ESLint warnings or errors"
- **確認観点**: コード品質

### TC-005: ビルド成功確認
- **テスト内容**: Next.js ビルドが成功すること
- **実行手順**: `npm run build 2>&1 | tail -10`
- **期待結果**: Build 成功（exit code 0）
- **確認観点**: ビルドの整合性

### TC-006: WorktreeDesktopLayout - 折りたたみUI実装確認
- **テスト内容**: `WorktreeDesktopLayout.tsx` に折りたたみ関連実装があること
- **実行手順**: `grep -n "expand-bar\|leftPaneCollapsed\|onToggleLeftPane\|EXPAND_BAR_WIDTH" src/components/worktree/WorktreeDesktopLayout.tsx`
- **期待結果**: 全キーワードがヒットすること
- **確認観点**: 受入条件「折りたたみ時の左パネル幅は 0px（完全非表示）、展開バーは 24px」

### TC-007: WorktreeDesktopLayout - aria 属性確認
- **テスト内容**: 展開バーのボタンに適切な aria 属性があること
- **実行手順**: `grep -n 'aria-label.*Expand\|aria-expanded.*false\|aria-controls.*worktree-left-pane' src/components/worktree/WorktreeDesktopLayout.tsx`
- **期待結果**: 3行ヒットすること
- **確認観点**: 受入条件「aria-label, aria-expanded, aria-controls を付与」

### TC-008: LeftPaneTabSwitcher - 折りたたみボタン実装確認
- **テスト内容**: `LeftPaneTabSwitcher.tsx` に ◀ ボタン実装があること
- **実行手順**: `grep -n "onCollapse\|Collapse left panel\|aria-controls.*worktree-left-pane" src/components/worktree/LeftPaneTabSwitcher.tsx`
- **期待結果**: 全キーワードがヒットすること
- **確認観点**: 受入条件「左パネル右端の ◀ ボタンをクリックするとパネルが非表示になる」

### TC-009: WorktreeDetailRefactored - props 連携確認
- **テスト内容**: `WorktreeDetailRefactored.tsx` が適切に props を渡しているか
- **実行手順**: `grep -n "leftPaneCollapsed\|onToggleLeftPane\|onCollapse.*toggleLeftPane" src/components/worktree/WorktreeDetailRefactored.tsx`
- **期待結果**: 各キーワードがヒットすること
- **確認観点**: コンポーネント連携の正確性

### TC-010: useWorktreeUIState - localStorage 連携確認
- **テスト内容**: `useWorktreeUIState.ts` に localStorage 連携実装があること
- **実行手順**: `grep -n "commandmate.worktree.leftPaneCollapsed\|useLocalStorageState\|toggleLeftPane" src/hooks/useWorktreeUIState.ts`
- **期待結果**: 全キーワードがヒットすること
- **確認観点**: 受入条件「ページリロード後も折りたたみ状態が維持される」

### TC-011: サーバー起動確認
- **テスト内容**: サーバーが正常起動することを確認
- **実行手順**: `curl -s http://localhost:<UAT_PORT>/api/worktrees | head -c 50`
- **期待結果**: JSONレスポンスが返ること
- **確認観点**: テスト環境の正常性

### TC-012: ワークツリー詳細API確認
- **テスト内容**: Worktree詳細APIが正常に応答すること
- **実行手順**: `curl -s "http://localhost:<UAT_PORT>/api/worktrees" | python3 -c "import json,sys; data=json.load(sys.stdin); print(f'worktrees: {len(data.get(\"worktrees\",[]))}')" 2>/dev/null || echo "API check"`
- **期待結果**: APIが正常にレスポンスすること
- **確認観点**: 既存機能への影響がないこと

## 優先順位
- TC-001〜TC-005: 必須（静的解析・テスト）
- TC-006〜TC-010: 必須（実装確認）
- TC-011〜TC-012: 推奨（サーバー動作確認）
