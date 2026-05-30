# Issue #727 PM Auto-Dev 進捗レポート（Iteration 1）

## 1. ヘッダー

| 項目 | 値 |
|------|---|
| **Issue 番号** | #727 |
| **Issue タイトル** | feat(layout): replace `LeftPaneTabSwitcher` with VS Code-style Activity Bar + relocate History pane (PC) |
| **ブランチ** | `feature/727-worktree` |
| **Iteration** | 1 |
| **実施日** | 2026-05-30 |
| **PR ベース** | `main` |

---

## 2. 全体ステータスサマリー

**判定**: **passed_with_notes**（受入テスト 15/15 合格、手動 UAT 6 項目残置）

- Phase 1 (Issue Review): 25 件指摘 / 25 件反映済み（100%）
- Phase 2-3 (Design Policy / Review): スキップ（ユーザー設定 `feedback_skip_codex_review.md`）
- Phase 4 (Work Plan): 9 Phase / 39 タスクへ分解完了
- Phase 5 (TDD): 4 品質ゲート全 PASS、6610/6617 ユニットテスト PASS
- Phase 6 (Acceptance): 15 シナリオすべて合格（13 件 unit / 2 件 code-inspection）、不変条件 4/4 確認済み
- Phase 7 (Refactoring): `ResizableColumn` ヘルパー抽出のみ（minor、品質ゲート再 PASS）
- Phase 8 (Docs): `CLAUDE.md` / `CHANGELOG.md` / `docs/UI_UX_GUIDE.md` / `docs/en/UI_UX_GUIDE.md` 更新済み
- Phase 9 (UAT): 実機 UAT 6 項目は別途 `/uat 727` で実行可能（deferred_to_manual）

---

## 3. Phase 別実行結果

| Phase | 内容 | ステータス | 主要メトリクス |
|-------|------|----------|---------------|
| **Phase 1** | Issue Review（Stage 1-4） | success | 25 件指摘 → 25 件反映、Issue 本文 234 → 404 行（+170 行） |
| **Phase 2** | Design Policy | skipped | ユーザー設定によりスキップ |
| **Phase 3** | Design Review | skipped | ユーザー設定によりスキップ |
| **Phase 4** | Work Plan | success | 9 Phase / 39 タスク分解、`dev-reports/issue/727/work-plan.md` |
| **Phase 5** | TDD 実装 | success | 5 新規 / 8 更新 / 3 削除 / 4 新規テスト / 8 更新テスト / 2 削除テスト |
| **Phase 6** | Acceptance Test | passed_with_notes | 15 シナリオ全合格（13 unit / 2 code-inspection）、手動 UAT 6 項目 |
| **Phase 7** | Refactoring | success_minor | 1 変更（`ResizableColumn` 抽出による dedup） |
| **Phase 8** | Docs | success | 4 ファイル更新（commit `ad17bfdd`） |
| **Phase 9** | UAT | deferred_to_manual | 受入テスト agent で 15 シナリオ verify 済、実機 UAT は `/uat 727` |

---

## 4. 成果物リスト

### 新規ファイル（5 件）
- `src/config/activity-bar-config.ts`
- `src/hooks/useActivityBarState.ts`
- `src/hooks/useHistoryPaneState.ts`
- `src/components/worktree/ActivityBar.tsx`
- `src/components/worktree/ActivityPane.tsx`

### 変更ファイル（8 件）
- `src/types/ui-state.ts`
- `src/types/ui-actions.ts`
- `src/hooks/useWorktreeUIState.ts`
- `src/hooks/useWorktreeTabState.ts`
- `src/lib/deep-link-validator.ts`
- `src/components/worktree/HistoryPane.tsx`
- `src/components/worktree/WorktreeDesktopLayout.tsx`（Refactor Phase で `ResizableColumn` 追記）
- `src/components/worktree/WorktreeDetailRefactored.tsx`

### 削除ファイル（3 件）
- `src/components/worktree/LeftPaneTabSwitcher.tsx`
- `tests/unit/components/worktree/LeftPaneTabSwitcher.test.tsx`
- `tests/unit/types/left-pane-tab.test.ts`

### 追加テスト（4 件）
- `tests/unit/components/worktree/ActivityBar.test.tsx`
- `tests/unit/components/worktree/ActivityPane.test.tsx`
- `tests/unit/hooks/useActivityBarState.test.ts`
- `tests/unit/hooks/useHistoryPaneState.test.ts`

### 更新テスト（8 件）
- `tests/unit/components/HistoryPane.test.tsx`（Collapse ボタン 3 ケース追加）
- `tests/unit/components/WorktreeDesktopLayout.test.tsx`（4 カラム API へ全面書換）
- `tests/unit/hooks/deep-link-mapping.test.ts`（`activityId` 列を `MAPPING_TABLE` に追加）
- `tests/unit/hooks/useWorktreeTabState.test.ts`（`activityId` 9 ケース追加）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`（mock 差し替え + 11 件の Files クリック手順削除 + TC-4 `/tree` polling 除外）
- `tests/unit/components/worktree/WorktreeDetailRefactored-cli-tab-switching.test.tsx`（mock 差し替え）
- `tests/integration/issue-266-acceptance.test.tsx`（mock 差し替え + Scenario 5 `/tree` polling 除外）
- `tests/unit/components/app-version-display.test.tsx`（mock 差し替え）

---

## 5. 品質ゲート結果

| ゲート | コマンド | 結果 |
|--------|---------|------|
| **tsc** | `npx tsc --noEmit` | pass（0 errors） |
| **lint** | `npm run lint` | pass（No ESLint warnings or errors） |
| **unit_tests** | `npm run test:unit` | pass（**6610 passed / 0 failed / 7 skipped / 6617 total / 350 files**） |
| **build** | `npm run build` | pass（Next.js compiled successfully, all routes generated） |

すべて TDD Phase と Refactor Phase の両方で再実行・確認済み。

---

## 6. 不変条件チェック（モバイル経路保全）

| 不変条件 | 結果 | 確認方法 |
|----------|------|---------|
| `WorktreeDetailSubComponents.tsx` 未変更 | OK | `git diff --stat` empty |
| `NotesAndLogsPane.tsx` 残置 | OK | ファイル存在 + mobile MobileContent が引き続き参照 |
| `historySubTab` state 残置 | OK | `WorktreeDetailRefactored.tsx:312` で alive |
| `LeftPaneTabSwitcher.tsx` 削除 | OK | ファイル削除確認、参照 0 |

加えて、`state.layout.leftPaneTab` reducer フィールドはモバイル互換のため保持（PC は無視）。

---

## 7. リファクタリング内容

- **対象**: `src/components/worktree/WorktreeDesktopLayout.tsx`
- **種別**: dedup（重複排除）
- **概要**: activity-pane / history-pane カラムブロックの重複構造（id + data-testid + aria-label + width style + transition class + ErrorBoundary + PaneResizer）を `ResizableColumn` ヘルパーコンポーネントへ抽出。約 32 行の重複 JSX を 2 箇所 × 9 行のコールサイトに圧縮（net negative LOC）。DOM contract（id / data-testid / aria-label / `style.width`）は完全保持、`WorktreeDesktopLayout.test.tsx` のアサーション全件 PASS。
- **Deferred（不採用）**:
  - `useActivityBarState` / `useHistoryPaneState` の hydration ロジックを `useWorktreeUIState` の `isHydratedRef` パターンに揃える件は、独自パターン採用が意図的（直接 localStorage I/O を所有・storage 再 emit に依存しない）と判定し見送り。
  - `handleActivityToggle` / `handleHistoryPaneResize` の 1-line passthrough wrapper 削除も、stable identity 維持のため見送り。

---

## 8. ドキュメント更新箇所

commit `ad17bfdd` で以下 4 ファイル更新済み：

| ファイル | 主要変更 |
|----------|---------|
| `CLAUDE.md` | モジュールリファレンスから `LeftPaneTabSwitcher.tsx` 削除、`ActivityBar.tsx` / `ActivityPane.tsx` / `useActivityBarState.ts` / `useHistoryPaneState.ts` / `activity-bar-config.ts` 追加 |
| `CHANGELOG.md` | `[Unreleased]` セクションに視覚的破壊的変更（"BREAKING (PC layout): VS Code 風 Activity Bar + History 独立カラム化（Issue #727）"）明記 |
| `docs/UI_UX_GUIDE.md` | `WorktreeDesktopLayout` を 2 カラム → 4 カラム（ActivityBar / ActivityPane / History / Right）構成へ更新 |
| `docs/en/UI_UX_GUIDE.md` | 上記英訳版更新 |

---

## 9. 残課題 / 手動 UAT 項目

PM Auto-Dev フローでブロッカーなし。以下 6 項目は実機 UAT で別途確認推奨：

1. **Tooltip hover 表示** — Activity Bar アイコンの `title` 属性によるツールチップは Unit Test では検証不能（ブラウザ既定動作）
2. **4 カラム視覚レイアウト** — Activity Bar 48px 幅、垂直アイコン整列、active-tab 左端ボーダー、dark/light テーマパリティのピクセル確認
3. **Deep link `?pane=` 4 種動作確認** — ライブ URL で `?pane=git` / `?pane=notes` / `?pane=logs`（→ Schedules） / `?pane=agent` / `?pane=timer` / `?pane=files` / `?pane=history` / `?pane=terminal` を実機検証
4. **E2E spec 影響確認** — `tests/e2e/{mobile-cmate-tab,worktree-detail,file-tree-operations,markdown-editor}.spec.ts` を PR マージ前に実行推奨
5. **Network polling 停止確認** — DevTools Network タブで `useFilePolling` が `activeActivity !== 'files'` 時に `/tree` GET を発行停止するか確認
6. **History pane drag-resize 範囲確認** — `[MIN_HISTORY_WIDTH=10%, MAX_HISTORY_WIDTH=60%]` 範囲での PaneResizer 連動

加えて、受入テストでは TS-09（PC History に Message/Git サブタブが無いこと）と TS-14（`useFilePolling` の `activeActivity='files'` ゲーティング）は専用ユニットテストではなくコード検査で合格判定。挙動は正しく意図的だが、フォローアップで専用テスト追加が望ましい。

---

## 10. コミット履歴

| Hash | メッセージ |
|------|----------|
| `16726fec` | feat(worktree): introduce VS Code-style Activity Bar + dedicated History pane (#727) |
| `ad17bfdd` | docs: update CLAUDE.md / CHANGELOG.md / UI_UX_GUIDE for Activity Bar (#727) |

---

## 11. 次のアクション

1. **（任意）** ユーザーが `/uat 727` を実行して実機受入テストを完了する（手動 UAT 6 項目を網羅）
2. **`/create-pr`** で `main` 向け PR を作成（base: `main`、head: `feature/727-worktree`）
3. PR 作成後、CI（lint / tsc / unit / build）が再 PASS することを確認

---

## サマリー

Issue #727 の PM Auto-Dev iteration 1 は **passed_with_notes** で完了。VS Code 風 Activity Bar（6 アイコン縦並び）+ History 独立カラム化（折りたたみ + width 永続化）を実装し、PC レイアウトを 4 カラム構造（Activity Bar / Activity Pane / History / Right）に再構成した。新規 5 ファイル・既存 8 ファイル更新・3 ファイル削除・新規テスト 4 件・更新テスト 8 件で、全品質ゲート（tsc / lint / 6610 unit tests / build）が PASS。受入テスト 15 シナリオすべて合格、モバイル経路 4 不変条件（`WorktreeDetailSubComponents.tsx` 未変更 / `NotesAndLogsPane.tsx` 残置 / `historySubTab` state 残置 / `LeftPaneTabSwitcher.tsx` 削除）も確認済み。リファクタリングは `ResizableColumn` ヘルパー抽出 1 件のみ（minor）。ドキュメント 4 ファイル更新済み。残作業は実機 UAT 6 項目（任意）と PR 作成のみ。
