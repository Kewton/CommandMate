# Issue #732 実機受入テスト計画

## テスト概要
- Issue: #732 fix(layout): missing min-w-0 causes horizontal overflow, hiding FilePanel off-screen (#730 follow-up)
- テスト環境: CommandMate サーバー（本 worktree のビルド = 修正適用済み, localhost:3010）
- DB: 実 DB (`~/.commandmate/data/cm.db`) のコピーを使用（既存 worktree を流用、本番非干渉）
- 検証手段: Playwright MCP による実ブラウザ操作（viewport 1920×1080）

## 前提条件
- viewport を 1920×1080 に設定（バグは横幅依存）
- 既存の worktree が1件以上 DB に存在すること
- Files アクティビティでツリー表示 → 任意ファイルをクリックできること

## 検証の中核
バグは「flex item の `min-w-0` 欠落により、FilePanel が viewport 右外に押し出される」。
中核アサーション:
```js
document.querySelector('[data-testid="file-panel-pane"]').getBoundingClientRect().right <= window.innerWidth
```
および `[data-testid="desktop-layout"]` の幅が viewport に収まること。

## テストケース一覧

### TC-001: ファイル選択時に FilePanel が viewport 内に表示される（主受入条件）
- **テスト内容**: PC版1920pxで Files→ファイルクリック後、`file-panel-pane` が viewport 内
- **実行手順**:
  1. viewport 1920×1080 で worktree 詳細を開く
  2. ActivityBar の Files を選択
  3. ツリー内の任意ファイルをクリック
  4. `file-panel-pane.getBoundingClientRect().right` を測定
- **期待結果**: `.right <= window.innerWidth (1920)`、`.left >= 0`、要素が可視
- **確認観点**: 受入条件1, 2

### TC-002: desktop-layout の幅が viewport 内に収まる
- **テスト内容**: `desktop-layout` の幅が viewport - sidebar - ActivityBar 以下
- **実行手順**: TC-001 の状態で `desktop-layout.getBoundingClientRect()` を測定
- **期待結果**: `.right <= window.innerWidth`、幅が 2825px のような溢れをしない
- **確認観点**: 受入条件3

### TC-003: History 非表示でも FilePanel が viewport 内
- **テスト内容**: History ペインを折りたたんだ状態でも溢れない
- **実行手順**: History 折りたたみトグル → ファイルクリック → 測定
- **期待結果**: `file-panel-pane.right <= window.innerWidth`
- **確認観点**: 受入条件4

### TC-004: ActivityPane 幅変更でも FilePanel が viewport 内
- **テスト内容**: ActivityPane の幅をリサイズしても溢れない
- **実行手順**: PaneResizer で ActivityPane 幅を変更 → 測定
- **期待結果**: `file-panel-pane.right <= window.innerWidth`
- **確認観点**: 受入条件4

### TC-005: 既存挙動（ターミナル/履歴表示）が壊れない
- **テスト内容**: ターミナル領域・履歴ペインが正常に表示される
- **実行手順**: worktree を開いた直後の表示と Files/Terminal 切替を確認
- **期待結果**: ターミナル・履歴が表示され、レイアウト崩れがない
- **確認観点**: 受入条件5（既存挙動維持）

### TC-006: 静的検証（モバイル経路非変更・品質ゲート）
- **テスト内容**: モバイル経路 (~L1590) 未変更、lint/tsc/test/build 全PASS
- **実行手順**: git diff 確認 + 各品質コマンド（Phase 5 で実施済みの結果を引用）
- **期待結果**: モバイル経路 diff なし、全ゲート PASS
- **確認観点**: 受入条件6, 7

## エビデンス取得方法
- `mcp__playwright__browser_evaluate` で `getBoundingClientRect()` / `window.innerWidth` を取得
- `mcp__playwright__browser_take_screenshot` でスクリーンショット保存
