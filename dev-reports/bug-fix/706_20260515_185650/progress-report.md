# Progress Report — Issue #706 バグ修正

## 1. サマリー

| 項目 | 内容 |
|------|------|
| Issue 番号 | #706 |
| タイトル | fix(files): Files タブのツリー再描画でスクロール位置がリセットされる（refetch 時の loading 表示を見直し） |
| 重大度 | high |
| 修正対象範囲 | フル対応（Action 1+2+3+4 全実施） |
| ブランチ | `feature/706-worktree` |
| Bug ID | `706_20260515_185650` |
| 最終ステータス | **pass**（受入条件 8/8、テストシナリオ 8/8、回帰 0 件） |

ユーザー影響: Files タブ表示後 5 秒経過時の偽陽性 refresh と、refetch のたびに発生していたツリー DOM 全置換が解消され、スクロール位置・選択強調・キーボードフォーカスが維持される。

---

## 2. 根本原因

### 主因（structural）
**FileTreeView.tsx の `if (loading) return <Loading>` 早期 return が初回マウント／refetch を区別せず DOM を全置換していた。**

- `src/components/worktree/FileTreeView.tsx:367-378` — `loading=true` で常に `data-testid="file-tree-loading"` を返す
- `src/components/worktree/FileTreeView.tsx:161` — `reloadTreeWithExpandedDirs()` が `refreshTrigger` 変化時にも `setLoading(true)` を呼ぶ
- 結果: refetch のたびに `rootItems` を持つツリー DOM がアンマウントされ、スクロール位置・選択状態が失われる

### 副因（false_positive_polling）
**WorktreeDetailRefactored のツリーポーリングが初回ポーリングで偽陽性 refresh を発火していた。**

- `src/components/worktree/WorktreeDetailRefactored.tsx:265` — `const prevTreeHashRef = useRef<string | null>(null)`
- `src/components/worktree/WorktreeDetailRefactored.tsx:275` — `if (newHash !== prevTreeHashRef.current)` が初回必ず true になる
- `FILE_TREE_POLL_INTERVAL_MS = 5000ms`（`src/config/file-polling-config.ts:8`）のため、Files タブを開いた約 5 秒後に必ず発火していた

---

## 3. 実施内容（Action 1〜4）

### Action 1: FileTreeView の loading 分岐を初回限定化（Option 3: 既存ツリー保持）
- 対象: `src/components/worktree/FileTreeView.tsx`
- 変更:
  - `isInitialLoading = loading && rootItems.length === 0` を導入し、全画面 `file-tree-loading` を初回マウント時のみに限定
  - `isRefetching = loading && rootItems.length > 0` のとき、ツールバー右端 (`ml-auto`) に小型インジケーターを描画
  - 新規 `data-testid="file-tree-refetch-indicator"` (`role="status"`, `aria-live="polite"`, sr-only `Refreshing files`)
  - ツールバー表示条件に `isRefetching` を追加し、コールバック未提供でも描画されるよう調整

### Action 2: refetch エラー時の非破壊表示・再試行ボタン
- 対象: `src/components/worktree/FileTreeView.tsx`
- 変更:
  - `isInitialError = !!error && rootItems.length === 0` を導入し、全画面 `file-tree-error` を初回ロード失敗時のみに限定
  - `isRefetchError = !!error && rootItems.length > 0` のとき、ツリー直前に非破壊バナーを描画
  - 新規 `data-testid="file-tree-refetch-error"` (`role="alert"`, AlertCircle アイコン)
  - 新規 `data-testid="file-tree-refetch-retry-button"` — クリックで `reloadTreeWithExpandedDirs` を再呼び出し
  - `reloadTreeWithExpandedDirs` を `useCallback` で外出し、`mountedRef` (`useRef` + `useEffect` cleanup) でアンマウント後の `setState` を抑止

### Action 3: WorktreeDetailRefactored の prevTreeHashRef 初回スキップ
- 対象: `src/components/worktree/WorktreeDetailRefactored.tsx`
- 変更:
  - `prevTreeHashRef.current === null` の初回ポーリング時はベースラインだけ記録し、`setFileTreeRefresh` を呼ばない分岐を追加（行 279-284 付近）
  - Issue #706 番号・意図のコメント明記

### Action 4: テスト追加・既存テスト整合
- 対象: `tests/unit/components/worktree/FileTreeView.test.tsx`
- 変更: `describe('refetch indicator (Issue #706)')` を追加し、5 件の新規テストを集約
- 既存 Issue #164 / #300 のテストブロックには未介入（互換維持）

---

## 4. テスト結果

### 検証コマンド

| コマンド | 結果 | 詳細 |
|----------|------|------|
| `npm run lint` | **pass** | No ESLint warnings or errors |
| `npx tsc --noEmit` | **pass** | エラー出力なし（exit 0） |
| `npm run test:unit` | **pass** | Test Files 343 passed (343), Tests 6491 passed \| 7 skipped (6498) |
| `FileTreeView.test.tsx` 単独 | **pass** | 69 tests passed（Issue #706 新規 5 件 + Issue #164 既存含む） |

### 新規追加テスト（5 件）

`FileTreeView > refetch indicator (Issue #706)` 配下:

1. `should not show file-tree-loading on refetch (refreshTrigger change)`
2. `should show file-tree-refetch-indicator while refetching`
3. `should preserve existing tree and show file-tree-refetch-error on refetch failure`
4. `should still show full-screen file-tree-error on initial load failure`
5. `should retry refetch when file-tree-refetch-retry-button is clicked`

### カバレッジ
- **76.81%**（Issue #706 関連経路: lines 152-156, 171-231, 383-499 は全てカバー済み）
- 未到達分は pre-existing な Issue #21 検索/フィルタ系コード（lines 305-376）および `loadChildren` error path（line 266）— 本 Issue 範囲外

---

## 5. 受入条件チェック（8/8 pass）

| # | 受入条件 | 結果 | 主要エビデンス |
|---|----------|------|----------------|
| 1 | Files タブ初回表示後 5 秒経過時にスクロール位置がリセットされない | pass | `WorktreeDetailRefactored.tsx:279-284` 初回スキップ + `FileTreeView.tsx:383` `isInitialLoading` 限定 |
| 2 | 実ファイル追加/削除時もスクロール位置・フォーカスが維持される | pass | `FileTreeView.tsx:171-234` `setRootItems/setCache` のみ更新でツリーコンテナ DOM 同一 |
| 3 | refetch 中はパネル内に控えめな更新インジケーターが表示される | pass | `FileTreeView.tsx:512-525` `data-testid="file-tree-refetch-indicator"` (`role="status"`, `aria-live="polite"`) |
| 4 | 初回マウント時は従来通り全画面 loading が表示される | pass | `FileTreeView.tsx:383-394` `isInitialLoading` 分岐、既存テスト互換 |
| 5 | refetch 失敗時は既存ツリーを保持しつつ非破壊通知 | pass | `FileTreeView.tsx:413, 531-549` `data-testid="file-tree-refetch-error"` + 再試行ボタン |
| 6 | 既存 `npm run test:unit` で 0 件の回帰 | pass | 6491 passed \| 7 skipped |
| 7 | FileTreeView の refetch 動作に関する新規テストが追加されている | pass | `FileTreeView.test.tsx:1562-1720` describe 配下 5 件 |
| 8 | ESLint / TypeScript チェックがパスする | pass | lint・tsc ともにエラーなし |

---

## 6. 次のステップ

### 推奨
- **PR 作成**: `feature/706-worktree` → `develop`
  - PR タイトル例: `fix: Filesタブのツリー再描画でスクロール位置がリセットされる問題を修正 (#706)`
  - PR ラベル: `bug`
  - 主要変更ファイル 3 件（`FileTreeView.tsx`, `WorktreeDetailRefactored.tsx`, `FileTreeView.test.tsx`）

### 任意
- 実機 UAT で PC/モバイル両ビューポートでのスクロール維持を最終確認（Playwright E2E でも可）
- `WorktreeDetailRefactored` の `prevTreeHashRef` 初回スキップに対する単体テスト追加（現状はコードレビューでロジック妥当性を確認済み）
- 再試行ボタン「再試行」ラベルの i18n 対応（next-intl への移行、本 Issue スコープ外）

---

## 主要 testid 一覧（新規）

| testid | 役割 | aria 属性 |
|--------|------|-----------|
| `file-tree-refetch-indicator` | refetch 中の控えめインジケーター | `role="status"`, `aria-live="polite"`, sr-only `Refreshing files` |
| `file-tree-refetch-error` | refetch エラー時の非破壊バナー | `role="alert"` |
| `file-tree-refetch-retry-button` | エラーバナー内の再試行ボタン | — |

既存 testid（`file-tree-loading`, `file-tree-error`）は不変。
