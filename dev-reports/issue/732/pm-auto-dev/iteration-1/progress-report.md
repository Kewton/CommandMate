# 進捗レポート - Issue #732 (Iteration 1)

## 概要

| 項目 | 内容 |
|------|------|
| **Issue** | #732 - fix(layout): missing min-w-0 causes horizontal overflow, hiding FilePanel off-screen (#730 follow-up) |
| **Iteration** | 1 |
| **報告日時** | 2026-05-31 |
| **ブランチ** | `feature/732-worktree` |
| **ステータス** | ✅ 成功（全フェーズ完了 / 全品質ゲートPASS / UAT 6/6 PASS） |

---

## バグ概要

`#730`（ActivityBar 全高化 + History を Terminal コンテナ内包化）のフォローアップ。

PC（デスクトップ）レイアウトの flex コンテナに `min-w-0` が欠落していたため、flex item の既定値である
`min-width: auto` が効いてしまい、子孫の `FilePanelSplit` 固定幅ペインのコンテンツ要求まで
親コンテナが膨張。結果として **FilePanel が viewport 外（画面右側）へ押し出され、ファイルパネルが
画面に表示されない**横溢れ（horizontal overflow）が発生していた。

- 修正前実測（1920px viewport）: `file-panel-pane` の `right = 3160`（viewport 1920 を大きく超過、画面外）
- `desktop-layout` 要素が viewport から約 2825px 溢れていた

---

## 修正内容（CSSのみ・2行）

`src/components/worktree/WorktreeDetailRefactored.tsx` の PC デスクトップ flex コンテナ2箇所に
`min-w-0` を追記（いずれも設計方針 DR1-001 に従い Issue #732 トレーサビリティ用の日本語コメント付き）。

| 箇所 | 変更 | 役割 |
|------|------|------|
| **L1740** | `flex flex-col flex-1 min-h-0` → `... min-w-0` | **主因（PRIMARY）**: L1738 の `flex-row` の直接 flex item。main 軸に `min-width:auto` が効くため横溢れの根本原因 |
| **L1763** | `flex-1 min-h-0` → `... min-w-0`（`WorktreeDesktopLayout` ラッパ） | **防御的補強（DEFENSIVE）**: 主因と併せて付与。将来のクリーンアップでの誤削除防止コメント付き |

- モバイル経路（~L1590 の `flex-1 min-h-0`）は**意図的に未変更**（diff に含まれない）
- ロジック・props・公開API の変更なし（className のみ）

---

## フェーズ別結果

### Phase 1: TDD実装 — ✅ 成功

- **Red/Green**: Red 確認済み（修正前にテスト失敗）→ Green 確認済み（修正後にPASS）
  - RED: `Expected the element to have class: flex-1 min-h-0 min-w-0 / Received: flex-1 min-h-0`
  - GREEN: `min-w-0` 追記後にPASS
- **追加した回帰テスト**:
  `tests/unit/components/WorktreeDetailRefactored.test.tsx` ::
  `Desktop Mode > desktop layout containers carry min-w-0 to prevent horizontal overflow (Issue #732)`
  - モック `desktop-layout` testid から DOM を遡り（parent = L1763、grandparent = L1740）、両コンテナが `min-w-0` を持つことを `toHaveClass` で検証
  - 対象ファイル単体: **42 passed / 1 skipped**（skip は既存）
- **変更ファイル**:
  - `src/components/worktree/WorktreeDetailRefactored.tsx`
  - `tests/unit/components/WorktreeDetailRefactored.test.tsx`
  - `CHANGELOG.md`

> 補足: jsdom はレイアウト計算を行わず幅を 0 で返すため、幅ベースの検証（`right <= innerWidth` 等）は
> 単体テストでは不可能。Playwright e2e（UAT）に委譲。

---

### Phase 2: 受入テスト — ✅ 成功（passed）

| 受入条件 | 結果 |
|----------|------|
| 対象2コンテナ（L1740, L1763）の className に `min-w-0` が含まれる | ✅ passed |
| モバイル経路（~L1590 の `flex-1 min-h-0`）は未変更（静的確認） | ✅ passed |
| ターミナル/履歴の既存挙動が壊れない（既存テスト非破壊） | ✅ passed |
| lint / tsc / test:unit / build 全PASS | ✅ passed |
| 幅ベース条件（FilePanel が viewport 内 / `right<=innerWidth` 等） | ⏩ e2e-required → UATで検証 |

幅ベースの受入条件は jsdom の制約上 e2e でのみ検証可能なため、後続の UAT（Playwright）で確認。

---

### Phase 3: リファクタリング — ⏸️ N/A（not-applicable）

CSS className 2箇所の追記のみのため、リファクタリング対象なし。

---

### Phase 4: ドキュメント更新 — ✅ 成功

- `CHANGELOG.md`: `[Unreleased]` に `### Fixed` セクションを新設しバグ修正エントリを追加
- `CLAUDE.md`: `WorktreeDetailRefactored.tsx` エントリに Issue #732 を追記

---

### Phase 5: UAT（実機受入テスト） — ✅ 成功（6/6 PASS）

実機環境: port 3010 / viewport 1920x1080 / Playwright MCP (Chromium) / `feature/732-worktree` プロダクションビルド。

| ID | タイトル | 結果 | 主要エビデンス |
|----|----------|------|----------------|
| TC-001 | ファイル選択時に FilePanel が viewport 内に表示 | ✅ pass | `file-panel-pane` right=**1920** (≤ innerWidth 1920)、overflow=false |
| TC-002 | desktop-layout の幅が viewport 内に収まる | ✅ pass | `desktop-layout` left=272 / right=1920 / width=1648（修正前の 2825px 溢れ解消） |
| TC-003 | History 非表示でも FilePanel が viewport 内 | ✅ pass | History 折りたたみ後も right=1920 維持（width=658 に拡大） |
| TC-004 | ActivityPane 幅変更でも FilePanel が viewport 内 | ✅ pass | ActivityPane を 18%→40.75%(672px) に拡大しても right=1920 維持 |
| TC-005 | 既存挙動（ターミナル/ファイルパネル）が壊れない | ✅ pass | terminal-pane と file-panel-pane が正常に並列表示、崩れなし |
| TC-006 | 静的検証（モバイル経路非変更・品質ゲート） | ✅ pass | モバイル経路 diff 非含、品質ゲート全PASS |

**核心エビデンス**: `file-panel-pane` の `right` が **修正前 3160（画面外）→ 修正後 1920（viewport内）**。
History 折りたたみ・ActivityPane 拡大のいずれの状態でも `right=1920` を維持し、横溢れ（`scrollWidth=clientWidth=1920`）が解消されていることを確認。

---

## 総合品質メトリクス

| 品質ゲート | 結果 |
|-----------|------|
| ESLint (`npm run lint`) | ✅ pass（No ESLint warnings or errors） |
| TypeScript (`npx tsc --noEmit`) | ✅ pass（exit 0） |
| Unit Test (`npm run test:unit`) | ✅ pass（**6700 passed / 7 skipped / 0 failed**、358 test files） |
| Build (`npm run build`) | ✅ pass |
| UAT（Playwright e2e 相当） | ✅ **6/6 PASS（100%）** |

- 静的解析エラー: **0件**
- 回帰: なし（追加テスト除き既存テスト非破壊）

---

## ブロッカー / 課題

- **ブロッカーなし。**
- 既知の注記: フルスイート実行時の `useWorktreesCacheContext must be used within a WorktreesCacheProvider` コンソール出力は、
  既存の `WorktreesCacheProvider.test.tsx` エラーパステスト由来であり、本変更とは無関係。

---

## 次のステップ

1. **コミット** — 作業ツリーの変更（`WorktreeDetailRefactored.tsx` / テスト / `CHANGELOG.md` / `CLAUDE.md`）を `feature/732-worktree` にコミット
   - 例: `fix(layout): add min-w-0 to desktop flex containers to prevent FilePanel overflow (#732)`
2. **PR作成** — `/create-pr` で `feature/732-worktree` → `develop` への PR を作成（ラベル: `bug`）
3. **レビュー依頼** — `#730` フォローアップである旨と UAT エビデンス（right 3160→1920）を PR 本文に記載
4. **マージ後** — `develop` での動作確認後、`develop` → `main` の標準フローへ

---

## 備考

- `#730`（ActivityBar 全高化 + History 内包化）導入で顕在化した横溢れの後追い修正。
- CSS（className）2行のみの低リスク変更だが、回帰テストと実機 UAT で再発防止を担保済み。
- リファクタリングは対象なし（N/A）。

**Issue #732 の実装・検証が完了しました。コミット → PR 作成（develop 向け）に進める状態です。**
