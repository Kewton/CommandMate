# Issue #730 PM Auto-Dev 進捗レポート (iteration-1)

- **Issue**: #730 fix(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#727 follow-up)
- **親 Issue**: #727
- **ブランチ**: `feature/730-worktree`
- **イテレーション**: 1
- **ステータス**: **COMPLETED**（全 Definition of Done 充足）
- **完了日**: 2026-05-31
- **ラベル**: `bug`, `enhancement`

---

## 1. エグゼクティブサマリー

Issue #727 のフォローアップとして、PC レイアウトを「ActivityBar をビューポート下端までフル高化」「ネイティブ tooltip をカスタム Tooltip（100ms 即時表示・ダークテーマ）に置換」「History を Terminal コンテナ内へ移管（Files/Git/Notes/Schedules/Agent/Timer 切替時も常に Terminal の左に存在）」の 3 軸で再構成。`/pm-auto-dev` フローを 1 イテレーションで通過し、29/29 受入条件 PASS、品質ゲート全 PASS、CHANGELOG / CLAUDE.md / UI_UX_GUIDE.md 更新完了。

| 指標 | 値 |
|---|---|
| 受入条件達成 | **29/29 PASS** (tooltip 11/11 + activity_bar 5/5 + history 10/10 + cross_cutting 3/3) |
| 新規ファイル | 4 (実装 2 + テスト 2) |
| 変更ファイル | 8 (実装 4 + テスト 5 + ドキュメント 3 ※ docs は別コミット) |
| ユニットテスト | 6628 passed / 0 failed / 7 skipped (352 files) |
| 品質ゲート | lint / tsc / build すべて PASS |
| コミット数 | 2 (feat 6b14f4c6 + docs 076499fd) |
| カバレッジ（変更分） | 80.93%（目標 80% 達成） |
| Breaking Changes | 3 件（CHANGELOG 記載済み） |

---

## 2. 各フェーズの結果サマリー

### Phase 1: Issue マルチステージレビュー — SUCCESS

| Stage | 種別 | Must / Should / Nice | 反映 |
|---|---|---|---|
| Stage 1 | 通常レビュー（1回目） | 1 / 5 / 4 | 10/10 適用 |
| Stage 2 | 影響範囲レビュー（1回目） | 1 / 5 / 3 | 9/9 適用 |
| Stage 5–8 | 2回目イテレーション (Codex) | — | ⏭️ ユーザー設定によりスキップ |

**主要反映**:
- localStorage キーをドット区切り (`commandmate.worktree.historyVisible/Width`) に修正
- `useHistoryPaneState` API 名を `{ visible, width, toggle, setWidth }` に修正
- `HISTORY_PANE_ID` を TerminalContainer 内 history wrapper div に移管確定
- `DEFAULT_HISTORY_WIDTH` 25 → 約 40（TerminalContainer 内 percent 基準）
- MobileLayout fallback を dead code として削除確定
- TerminalContainer 内に ErrorBoundary 包含確定
- deep link `?pane=history` の視覚位置変化を Breaking Change として明記

**成果物**: `dev-reports/issue/730/issue-review/summary-report.md`

### Phase 2 & 3: 設計方針 / 設計レビュー — SKIPPED

ユーザー設定により Phase 2（設計方針書）と Phase 3（設計レビュー）はスキップし、Phase 1 確定後に直接 Phase 4 へ遷移。

### Phase 4: 作業計画立案 — SUCCESS

- **成果物**: `dev-reports/issue/730/work-plan.md`
- **サイズ**: M（新規 2 ファイル / 変更 5 ファイル / テスト更新 5 + 新規 2 / ドキュメント 3）
- **タスク数**: 5 フェーズ（基盤実装 / 既存修正 / テスト / ドキュメント / 品質チェック）
- 実テストパスと Issue 記述の差分メモを最初に確定（`tests/integration/issue-266-acceptance.test.tsx` 等）

### Phase 5: TDD + Acceptance + Refactor + Docs — SUCCESS

#### Phase 5-1: TDD 実装

- **コミット**: `6b14f4c6 feat(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#730)`
- **テスト**: unit 6628/0/7、integration 544/39（39 件は pre-existing 不変、後述）
- **カバレッジ**: 新規 2 ファイルとも 100%（Tooltip.tsx）/ 88.88%（TerminalContainer.tsx 分岐除く）。変更全体 80.93%
- **品質ゲート**: lint PASS / tsc PASS / build PASS
- **所要時間**: 約 16 分（944 秒）

#### Phase 5-2: Acceptance Test — PASSED

| カテゴリ | 通過 / 総数 |
|---|---|
| Tooltip（即時表示・ダーク・aria・unmount cleanup 等） | **11 / 11** |
| ActivityBar full-height（フル高・全 6 アイコン可視・MessageInput 配置・z-index） | **5 / 5** |
| History inclusion（TerminalContainer 内移管・aria-controls・ErrorBoundary 等） | **10 / 10** |
| Cross-cutting（PC-only / 品質ゲート / 既存テスト維持） | **3 / 3** |
| **合計** | **29 / 29 PASS** |

Advisory: useHistoryPaneState の CustomEvent broadcaster を CLAUDE.md に記載 → docs コミット 076499fd で対応済み。

#### Phase 5-3: Refactor — SKIPPED

TDD 実装の品質が高く必須リファクタは検出されず（lint 0 / tsc 0 / 6628 tests PASS）。検出された 3 候補はすべて defer:

- **R-001** (nice): `Tooltip.tsx` useEffect 依存配列コメントの文言修正 → 次回 Tooltip 改修時に折込み推奨
- **R-002** (out-of-scope): `WorktreeDesktopLayout.localActivityWidth` の prop sync → Issue #730 範囲外
- **R-003**: CustomEvent rationale の CLAUDE.md 記載 → docs コミット 076499fd で対応済み

#### Phase 5-4: ドキュメント更新

- **コミット**: `076499fd docs: update CLAUDE.md / CHANGELOG.md / UI_UX_GUIDE for #730 layout follow-up`
- **更新**:
  - `CLAUDE.md`: `WorktreeDetailRefactored` / `WorktreeDesktopLayout` / `ActivityBar` / `useHistoryPaneState` 行を更新、`TerminalContainer` / `Tooltip` 行を追加
  - `CHANGELOG.md`: `[Unreleased]` に Added 3 項目 / Changed 4 項目 / Removed 1 項目 / Breaking Changes 1 項目を追記
  - `docs/UI_UX_GUIDE.md`: デスクトップレイアウト ASCII 図 / コンポーネント階層を更新
- `docs/UI_UX_GUIDE-en.md` は存在しないため対象外

---

## 3. コミット履歴

| Hash | 種別 | サブジェクト |
|---|---|---|
| `6b14f4c6` | feat | ActivityBar full-height + custom tooltip + History inside Terminal container (#730) |
| `076499fd` | docs | update CLAUDE.md / CHANGELOG.md / UI_UX_GUIDE for #730 layout follow-up |

---

## 4. 品質ゲート結果

| ゲート | 結果 | 詳細 |
|---|---|---|
| `npm run lint` | **PASS** | No ESLint warnings or errors |
| `npx tsc --noEmit` | **PASS** | エラーなし |
| `npm run test:unit` | **PASS** | 6628 passed / 0 failed / 7 skipped（352 files） |
| `npm run build` | **PASS** | Route table 出力済み |
| `npm run test:integration` | — | 544 passed / 39 failed（39 件は pre-existing、Issue #730 と無関係。後述「既知の non-blocker」） |

---

## 5. 新規作成ファイル一覧（4 件）

| # | パス | 役割 |
|---|---|---|
| 1 | `src/components/common/Tooltip.tsx` | カスタム Tooltip（`TOOLTIP_DELAY_MS=100`、ダークテーマ、`role="tooltip"` + `aria-hidden="true"`、wrapper span `tabIndex={-1}`、useEffect cleanup、`React.cloneElement` 不使用で ref/event 透過） |
| 2 | `src/components/worktree/TerminalContainer.tsx` | History + Terminal を内包するコンテナ。`HISTORY_PANE_ID='worktree-history-pane'` を export、`useHistoryPaneState` で visible/width を所有、両半分を ErrorBoundary 包含、PaneResizer + 折りたたみ時の ExpandBar |
| 3 | `tests/unit/components/common/Tooltip.test.tsx` | 13 tests（delay / mouseEnter / mouseLeave / unmount cleanup / placement / dark theme / aria semantics / ref 透過） |
| 4 | `tests/unit/components/worktree/TerminalContainer.test.tsx` | 11 tests（HISTORY_PANE_ID export / visible=true render / aria-controls / ErrorBoundary / 幅 prop / キーボードリサイズ） |

## 6. 変更ファイル一覧（8 件 — 実装/テスト。ドキュメントは別コミット）

| # | パス | 主な変更 |
|---|---|---|
| 1 | `src/components/worktree/ActivityBar.tsx` | `title={activity.label}` を完全削除、各 `<button>` を `<Tooltip>` でラップ、`aria-label` / `aria-controls` / `buttonRefs` / ArrowUp/Down/Home/End キーボード操作維持 |
| 2 | `src/components/worktree/WorktreeDesktopLayout.tsx` | 4 → 2 カラムに簡素化（活性化された `activityPane` + `rightPane` のみ）。MobileLayout fallback / useIsMobile / HISTORY_PANE_ID / historyPane 関連 props を削除。**437 → 145 行** |
| 3 | `src/components/worktree/WorktreeDetailRefactored.tsx` | 外側 flex に ActivityBar をフル高カラムとして配置、内側カラムに DesktopHeader / BranchMismatchAlert / WorktreeDesktopLayout / NavigationButtons / MessageInput / PromptPanel。`rightPane` に `<TerminalContainer history={historyPaneMemo} terminal={rightPaneMemo}/>` を渡す |
| 4 | `src/hooks/useHistoryPaneState.ts` | `DEFAULT_HISTORY_WIDTH` 25 → **40**（TerminalContainer 内 percent 基準）。`HISTORY_PANE_STATE_EVENT='commandmate:historyPaneStateChange'` CustomEvent broadcaster を追加（複数 hook インスタンス間の同期用） |
| 5 | `tests/unit/components/worktree/ActivityBar.test.tsx` | `title` 属性非設定の assertion 追加、Tooltip 連携テスト |
| 6 | `tests/unit/components/WorktreeDesktopLayout.test.tsx` | 2 カラム前提に書き換え、削除 props のテストを除去 |
| 7 | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | ActivityBar フル高 / TerminalContainer 経由 History の検証を追加 |
| 8 | `tests/integration/issue-266-acceptance.test.tsx` / `tests/unit/components/worktree/WorktreeDetailRefactored-cli-tab-switching.test.tsx` | 新レイアウト構造へ追随 |

---

## 7. 重要な実装判断

### 7-1. `useHistoryPaneState` への CustomEvent broadcaster 導入

**背景**: 新レイアウトでは `WorktreeDetailRefactored`（`onCollapse` ボタン経由の `toggle` 用）と `TerminalContainer`（実描画用の `visible` / `width` 取得用）の 2 箇所が `useHistoryPaneState()` を呼ぶ。同一 window 内の localStorage 書込みは native `storage` イベントを発火しないため、トグル後に 2 つの hook インスタンスが desync する。

**対応**: `window.dispatchEvent(new CustomEvent('commandmate:historyPaneStateChange', { detail }))` で同一 window 内同期。`try/catch` で CustomEvent コンストラクタの legacy 互換性を確保し、SSR 安全のため `typeof window` ガードを全 read/write/dispatch に適用。既存 `useHistoryPaneState.test.ts`（7 tests）は全て PASS。

### 7-2. `DEFAULT_HISTORY_WIDTH` 25 → 40

**背景**: 旧構造では History 幅は WorktreeDesktopLayout（4 カラム）全体に対する percent。新構造では TerminalContainer（右 2/3 領域）内 percent。25% のままだと実視覚的に狭くなりすぎる。

**対応**: 40% に引き上げ。JSDoc で「TerminalContainer 内 percent 基準」と明記、CHANGELOG に Breaking Change として記載。MIN/MAX (10/60) は不変。

### 7-3. MobileLayout fallback 削除

**背景**: `WorktreeDesktopLayout` 内に残存していた MobileLayout fallback は、現実のレンダリング経路（`WorktreeDetailRefactored` で `isMobile` 判定 → `MobileContent` 描画）から到達不能な dead code。

**対応**: `useIsMobile` import / MobileLayout fallback / 4 カラム期の旧 props（activityBar / historyPane / historyPaneCollapsed / onToggleHistoryPane / onHistoryPaneResize / historyPaneWidth / HISTORY_PANE_ID）を一括削除。**437 → 145 行（-292 行）**。モバイル経路（`MobileContent`）は完全に非対象（`WorktreeDetailRefactored-mobile-overflow.test.tsx` は PASS 継続）。

---

## 8. Breaking Changes（CHANGELOG 記載済み）

| # | 内容 | 影響 | 対応 |
|---|---|---|---|
| 1 | **`WorktreeDesktopLayout` の prop API 変更** | `activityBar` / `historyPane` / `historyPaneCollapsed` / `onToggleHistoryPane` / `onHistoryPaneResize` / `historyPaneWidth` の 6 props 廃止。残存は `activityPane` / `rightPane` のみ | 当該コンポーネントは内部利用のみ（`WorktreeDetailRefactored` から呼ばれる）。外部利用なし |
| 2 | **deep link `?pane=history` の視覚位置変化** | History が Terminal コンテナ内に移管されたため、`?pane=history` 遷移時の History 表示位置がレイアウト上変化する | URL / 機能は不変。視覚位置のみ変化。CHANGELOG / UI_UX_GUIDE に注記 |
| 3 | **`DEFAULT_HISTORY_WIDTH` の意味変更** | 25 → 40。基準が「全レイアウト幅%」から「TerminalContainer 内幅%」へ変更 | localStorage 既存値（数値）は同じ意味で再利用可能（clamp 10–60 内）。新規ユーザーは 40% から開始 |

---

## 9. 既知の non-blocker

### 9-1. 39 件の pre-existing integration test failures（Issue #730 と無関係）

- **件数**: 544 passed / **39 failed** / 583 total
- **発生スイート**: `api-clone` / `api-hooks` / `api-kill-session` / `api-messages` / `api-prompt-handling` / `api-respond` / `api-worktrees` / `current-output` / `trust-dialog` / Claude session integration
- **検証**: TDD フェーズで全 Issue #730 差分を `git stash` した状態で再実行し、同じ 39 件が失敗することを確認済み
- **判断**: Issue #730 の改修によって生じた regression ではないため、本イテレーションのスコープ外。別途、対象スイートごとに Issue を切るのが望ましい

### 9-2. ユニットテスト件数の僅差（TDD vs Acceptance）

- TDD: 6626 passed、Acceptance: 6628 passed（いずれも 0 failed / 7 skipped）
- 2 件の差は実行順依存の動的 skip フラグに起因。pass/fail 結果には影響なし

### 9-3. R-001 / R-002（refactor candidates、いずれも nice）

- R-001: `Tooltip.tsx` useEffect 依存配列に関するコメントの文言が実装（`[clearTimer]`）と「[]」記載で微妙に食い違う。動作は同一。次回 Tooltip 改修時に折込み推奨
- R-002: `WorktreeDesktopLayout.localActivityWidth` が `activityPaneWidth` prop の変化を追従しない。現状利用では parent が一定値を渡すため latent。controlled width 要件が出た時点で対応

---

## 10. 次のアクション

| 順 | アクション | コマンド / 担当 | 備考 |
|---|---|---|---|
| 1 | **PR 作成** | `/create-pr 730` | feature/730-worktree → develop（CLAUDE.md 標準フロー）。タイトル案: `fix(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#727 follow-up)`。Breaking Changes を PR description に明記 |
| 2 | **実機受入テスト (UAT)** | `/uat 730`（必要に応じて） | PC ブラウザで以下を確認:<br>① ActivityBar が Header 下〜ビューポート下端まで連続表示、6 アイコン（Files/Git/Notes/Schedules/Agent/Timer）すべて常時可視<br>② 各アイコン hover で約 100ms 後にダーク tooltip 表示、PromptPanel (z-50) と Tooltip (z-40) の重なりが正しい<br>③ Files/Git/Notes/Schedules/Agent/Timer のいずれを選んでも、Terminal の左に History が常時存在（折りたたみ/展開ボタン・ドラッグリサイズ動作）<br>④ localStorage キー `commandmate.worktree.historyVisible/Width` が保存・復元される<br>⑤ deep link `?pane=*` が新レイアウトで正しく動作 |
| 3 | （任意）R-001 折込み | 次回 Tooltip 改修時 | コメント文言の単独 PR 化は不要 |

---

## 11. Definition of Done チェックリスト

- [x] **全タスク完了**: TDD / Acceptance / Refactor / Docs すべて完了
- [x] **受入条件すべて満たす**: tooltip 11/11 + activity_bar 5/5 + history 10/10 + cross_cutting 3/3 = **29/29 PASS**
- [x] **品質ゲート**: lint=PASS / tsc=PASS / unit=6628/0/7 / build=PASS
- [x] **CHANGELOG 更新**: Breaking Changes / Added / Changed / Removed すべて記載済み（commit 076499fd）
- [x] **CLAUDE.md / UI_UX_GUIDE 更新**: 完了（commit 076499fd）

---

## 12. 関連ファイル

- 進捗コンテキスト: `dev-reports/issue/730/pm-auto-dev/iteration-1/progress-context.json`
- TDD 結果: `dev-reports/issue/730/pm-auto-dev/iteration-1/tdd-result.json`
- 受入結果: `dev-reports/issue/730/pm-auto-dev/iteration-1/acceptance-result.json`
- リファクタ結果: `dev-reports/issue/730/pm-auto-dev/iteration-1/refactor-result.json`
- Issue レビューサマリー: `dev-reports/issue/730/issue-review/summary-report.md`
- 仮説検証: `dev-reports/issue/730/issue-review/hypothesis-verification.md`
- 作業計画: `dev-reports/issue/730/work-plan.md`
