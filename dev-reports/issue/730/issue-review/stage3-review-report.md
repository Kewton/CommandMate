# Issue #730 Stage 3 影響範囲レビュー レポート

- **対象Issue**: #730 fix(layout): ActivityBar full-height + custom tooltip + History inside Terminal container (#727 follow-up)
- **レビュー日**: 2026-05-30
- **レビュー観点**: 影響範囲・後方互換性・回帰リスク
- **レビュアー**: claude-opus
- **Issue 本文取得**: Stage 2 反映後の最新 (`gh issue view 730 --json body`)

---

## サマリー

Stage 1 通常レビュー（10/10 件反映）後の Issue #730 本文に対し、影響範囲・波及効果・後方互換性を精査した。**Must Fix 1 件 / Should Fix 5 件 / Nice to Have 3 件** の計 **9 件** を指摘する。

骨格（ActivityBar 全高化 / Tooltip 化 / TerminalContainer 化）は実装可能だが、特に **既存テスト 4 ファイル以上が影響** を受け、Issue 想定の 1 ファイルでは大きく不足する点が最重要指摘。

---

## 指摘事項一覧

| ID | 重要度 | カテゴリ | タイトル |
|----|--------|----------|----------|
| S3-001 | Must Fix | テスト | `WorktreeDesktopLayout` の `activityBar` / `historyPane` / `historyPaneCollapsed` props を参照する既存テストが Issue 想定の 1 ファイルでは不足（4 ファイル × 多数ケース） |
| S3-002 | Should Fix | 回帰リスク | Tooltip ラップで ActivityBar の `buttonRefs.current[index]?.focus()` が壊れる可能性（DOM 構造変化） |
| S3-003 | Should Fix | 後方互換 | `HistoryPane.tsx:494` の `aria-controls="worktree-history-pane"` は TerminalContainer 内 id 継続維持が前提 |
| S3-004 | Should Fix | 回帰リスク | TerminalContainer 内 History の `width: ${width}%` 計算基準が WorktreeDesktopLayout 全体 → TerminalContainer 内（右ペイン）に変わるため、既存 width 値（DEFAULT_HISTORY_WIDTH=25）の意味が変わる |
| S3-005 | Should Fix | テスト | `WorktreeDesktopLayout.test.tsx` の `Mobile fallback` ブロック (L151-184) の扱いが未明示（モバイル経路維持なら移管、廃止なら削除） |
| S3-006 | Should Fix | 回帰リスク | TerminalContainer の ErrorBoundary 包含が Issue で未明示（既存 WorktreeDesktopLayout は HistoryPane を ErrorBoundary でラップ） |
| S3-007 | Nice to Have | ドキュメント | `UI_UX_GUIDE.md` (L24, L219, L223) と `CHANGELOG.md` [Unreleased] (L11, L18, L26) の更新範囲が Issue で未明示 |
| S3-008 | Nice to Have | 後方互換 | deep link `?pane=history` の挙動が「画面中央の独立 History 列」→「右端 Terminal 領域内 History」と視覚位置が変わる |
| S3-009 | Nice to Have | パフォーマンス | Tooltip の `setTimeout`/`clearTimeout` が useEffect cleanup で解除されない場合、アンマウント時にタイマーリーク |

---

## 影響範囲マトリックス

### プロダクションコード

#### 変更
- `src/components/worktree/ActivityBar.tsx` — `title` 削除、Tooltip ラップ
- `src/components/worktree/WorktreeDesktopLayout.tsx` — `activityBar` / `historyPane` prop 削除、3 カラム化
- `src/components/worktree/WorktreeDetailRefactored.tsx` — ActivityBar 全高化、TerminalContainer 配置、Header/Alert/NavBtn/MessageInput 再構成
- `src/components/worktree/HistoryPane.tsx` — onCollapse 経路は維持

#### 新規
- `src/components/common/Tooltip.tsx`
- `src/components/worktree/TerminalContainer.tsx`

#### 削除
- なし（MobileLayout fallback を dead code として削除する場合は `WorktreeDesktopLayout.tsx` 内のみ）

### テストコード

#### 必須更新（Issue 想定外含む）
| ファイル | 影響内容 |
|----------|---------|
| `tests/unit/components/WorktreeDesktopLayout.test.tsx` | 11 ケース以上（historyPaneCollapsed 6 / Mobile fallback 5 / Resize callback 1） |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | L72-91 の mock 定義から `historyPane` 削除 + L600-1377 で `getByTestId('activity-bar')` を呼ぶ 12 ケース以上 |
| `tests/integration/issue-266-acceptance.test.tsx` | L67-91 の mock 定義から `historyPane` 削除 |
| `tests/unit/components/worktree/WorktreeDetailRefactored-cli-tab-switching.test.tsx` | 同等の mock 定義変更 |
| `tests/unit/components/worktree/ActivityBar.test.tsx` | Tooltip 統合下での `ArrowUp/Down` 動作 + a11y テスト追加 |

#### 新規
- `tests/unit/components/common/Tooltip.test.tsx`
- `tests/unit/components/worktree/TerminalContainer.test.tsx`

#### 維持（影響なし）
- `tests/unit/components/HistoryPane.test.tsx`（aria-controls assertion は TerminalContainer 内 id 移管継続前提で維持）
- `tests/unit/hooks/useHistoryPaneState.test.ts`（API 変更なし）
- `tests/unit/hooks/useActivityBarState.test.ts`（API 変更なし）
- E2E (`tests/e2e/*.spec.ts`) は layout 識別子を直接参照していないため影響なし

### 外部 API 互換性

| 項目 | 互換性 | 備考 |
|------|--------|------|
| URL deep link `?pane=...` | 維持（意味的） | 視覚位置のみ変化 (S3-008) |
| localStorage `commandmate.worktree.historyVisible` | 完全維持 | キー名・型変更なし |
| localStorage `commandmate.worktree.historyWidth` | 部分互換 | 値は読めるが percent 基準が変わるため見た目が縮む (S3-004) |
| localStorage `commandmate.worktree.activeActivity` | 完全維持 | 変更なし |
| DOM ID `worktree-activity-bar` | 維持 | ActivityBar 自身が持つ |
| DOM ID `worktree-activity-pane` | 維持 | ActivityPane 自身が持つ |
| DOM ID `worktree-history-pane` | 移管 | TerminalContainer 内 history wrapper div に移管 (Issue で明示) |
| DOM ID `worktree-right-pane` | 維持または変更 | WorktreeDesktopLayout の右カラム = TerminalContainer 全体になる |

### ドキュメント

- `CLAUDE.md`: L246 `WorktreeDesktopLayout` 記述、新規 `TerminalContainer.tsx` / `Tooltip.tsx` 行追加
- `docs/UI_UX_GUIDE.md`: L24, L47-63（ASCII 図）, L219-223
- `docs/en/UI_UX_GUIDE.md`: 同等英語版
- `CHANGELOG.md`: [Unreleased] に Issue #730 として追記（Changed / Added / Breaking Changes）

### 関連 Issue への影響

| Issue | 影響度 | 内容 |
|-------|--------|------|
| #727 | 限定的 | 親 Issue。API は維持されるため #727 関連テスト・ドキュメントへの影響は限定的 |
| #716 | 影響なし | History 内テキスト検索は HistoryPane 内に閉じているため動作維持 |
| #725 | 影響なし | User only フィルタは prop 伝播で維持 |
| #728 | 整合 | TerminalContainer の `terminal` prop が #728 のターミナル分割の親コンテナになる前提。Issue Stage 2 で明示済み |

---

## 総合判定

Stage 1 反映後の Issue 本文は骨格・実装方針・受入条件いずれも実装可能なレベルに到達している。

Stage 3 影響範囲レビューでは、**Must Fix 1 件（S3-001 既存テストの修正範囲）** を Stage 4 で必ず反映する必要がある。これを反映することで実装フェーズのテスト戦略が確定し、CI 失敗による手戻りを防止できる。

**Should Fix 5 件（S3-002〜S3-006）** を反映することで:
- Tooltip と ActivityBar の DOM/event 整合性（S3-002）
- TerminalContainer 内 aria-controls / id 移管整合（S3-003）
- percent 基準変化の UX 影響と方針確定（S3-004）
- MobileLayout fallback の削除 or 互換維持判断（S3-005）
- TerminalContainer の ErrorBoundary 包含による fault isolation 設計継承（S3-006）

の各回帰リスクと実装ぶれを大幅に削減できる。

**Nice to Have 3 件（S3-007〜S3-009）** はドキュメント更新範囲・deep link 視覚位置変更・Tooltip タイマーリーク対策で、実装中に判明しても致命的ではないが Issue 段階で明示しておくとレビュー・QA 効率が向上する。

---

## 次のアクション

**Stage 4: `apply-issue-review-agent` で Issue 本文を更新**

優先度:
- 必須: S3-001（テスト範囲具体化）
- 推奨: S3-002〜S3-006（回帰リスク対策）
- 任意: S3-007〜S3-009（ドキュメント・UX 細部）
