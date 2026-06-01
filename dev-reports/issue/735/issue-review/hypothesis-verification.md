# Issue #735 仮説検証レポート

**対象**: test(e2e): add Playwright e2e for PaneResizer 5-instance parallel + cross-worktree persistence (#728 R3-008)
**検証日**: 2026-05-31
**手法**: コードベース照合（Explore agent + Grep/Read）

---

## 検証サマリー

| # | 仮説/主張 | 判定 | 申し送り |
|---|----------|------|----------|
| H1 | `playwright.config.ts` が存在し e2e 基盤が整備済み | **Confirmed** | baseURL=localhost:3000, projects=[chromium, Mobile Safari], testDir=./tests/e2e, **timeout 明示なし（既定~30s）** |
| H2 | `tests/e2e/` に既存 spec があり流用できる | **Confirmed** | 8 specファイル存在（worktree-detail.spec.ts 等が参考になる） |
| H3 | `npm run test:e2e` が `playwright test` を実行 | **Confirmed** | package.json:47 |
| H4 | e2e が CI（GitHub Actions）で実行される | **Rejected** | ci-pr.yml / publish.yml に Playwright step **なし**。受入条件「CIで緑」を満たすにはworkflow新設/追記が必要 |
| H5 | `data-testid="activity-bar-files"` が存在 | **Rejected** | 実際は `activity-bar`（root, L93）/ `activity-bar-button-${id}`（L116）。`activity-bar-button-files` が正しい |
| H6 | `data-testid="history-pane-expand"` が存在 | **Rejected** | TerminalContainer に `terminal-container-expand-bar`（L52）はあるが**展開ボタン自体にtestidなし**。要追加 |
| H7 | `data-testid="terminal-split-add"` が存在 | **Rejected** | 実際は `add-terminal-split`（TerminalSplitContainer L164）。名前が逆 |
| H8 | `data-testid^="pane-resizer-"` / `pane-resizer-terminal-split-1` が存在 | **Rejected** | PaneResizer 本体に testid **なし**。ラッパdivに `split-resizer-${idx}`（TerminalSplitContainer L251）。`split-resizer-0/1` 形式 |
| H9 | `data-testid^="terminal-split-pane-"` / `terminal-split-pane-2` が存在 | **Confirmed** | TerminalSplitPane.tsx:81 `terminal-split-pane-${splitIndex}` |
| H10 | PaneResizer はドラッグ終了後に cursor を default に戻す | **Confirmed** | PaneResizer.tsx:218-239 useEffect。drag中 `document.body.style.cursor='col-resize'`、cleanup で `=''` にリセット |
| H11 | 「5並列インスタンス（3 splits + History + ActivityPane）」 | **Partially Confirmed** | 実際の resizer 描画箇所: ActivityPane↔Right(1) + History↔Terminal(1) + split間(3splitで2) = **4**。FilePanelSplit/MarkdownEditor が開くと +1 で5。「正確に5」は文脈依存 |
| H12 | localStorage キーが worktree スコープで分離 | **Confirmed** | terminal-split-config.ts:49 `commandmate:terminalSplits:{worktreeId}` |
| H13 | useTerminalSplits が worktreeId 変更で再読込・永続化 | **Confirmed** | useTerminalSplits.ts:85-109（worktreeId変化でsetConfig再読込、config変化でsetItem） |
| H14 | worktree詳細ルートは `/worktrees/{id}` | **Confirmed** | src/app/worktrees/[id]/page.tsx、param名は `id` |

---

## 詳細

### H4: e2e は CI に未統合（Rejected → 受入条件への影響大）

`.github/workflows/ci-pr.yml`・`publish.yml` を確認したところ、lint / type-check / unit test / build / security-audit のみで **Playwright step は存在しない**。

Issue 受入条件「CI（GitHub Actions）でe2eが実行され、緑になる」を満たすには、e2e workflow の新設または既存workflowへの追記が必要。ただし e2e は `webServer: npm run dev` 起動を要し、tmux/claude CLI 依存のworktree詳細画面はCI環境で実セッションを張れない可能性が高い。**CI上では「データ依存しない部分（split UIのDOM挙動・localStorage）」に絞る／モック化する設計判断が必要**。→ 作業計画で扱う。

### H5-H8: data-testid の不一致（Rejected → 実装時に要修正）

Issue の example spec のセレクタは**現状コードと多くが不一致**。実装時に以下のいずれかが必要:
- (A) spec を実際の testid に合わせる、または
- (B) コードに testid を追加する

| Issue記載 | 実際 | 対応 |
|-----------|------|------|
| `activity-bar-files` | `activity-bar-button-files`（L116, ActivityBar） | spec修正で対応可 |
| `history-pane-expand` | 展開ボタンにtestid無し | **コードにtestid追加が必要** |
| `terminal-split-add` | `add-terminal-split`（L164） | spec修正で対応可 |
| `pane-resizer-terminal-split-1` | `split-resizer-0/1`（L251, ラッパdiv） | spec修正で対応可（本体に付けるなら +testid） |
| `terminal-split-pane-2` | 同名で存在（L81） | そのまま利用可 |

> Issue の example spec は**擬似コード（説明用）**であり、そのまま動くものではない。実装では実 testid に整合させる必要がある。

### H10-H11: PaneResizer cursor / インスタンス数

cursor リセットは cleanup で `document.body.style.cursor=''` により実施済み（実装は正しい）。AC-27 はこの挙動を**5インスタンス並列でも回帰しない**ことを e2e で機械検証するのが目的。インスタンス数は「3 splits + History + ActivityPane = 4」が基本で、FilePanel/Markdown を開けば5になる。テスト設計では「複数（≥4）の resizer 並存下で drag→cursor 復帰」を検証できればAC-27の意図を満たす。spec は厳密な「5」固定ではなく実構成に合わせるべき。

---

## Stage 1 レビューへの申し送り

1. **受入条件「CIで緑」(H4)**: e2e は現状CI未統合。worktree詳細画面は tmux/CLI セッション依存のため、CI で実セッションを張れない懸念。「CI統合は scope に含めるか」「含める場合 data 非依存部分に絞るか」をIssueで明確化すべき。
2. **example spec の testid 不一致 (H5-H8)**: Issue の example は擬似コード。実 testid（`activity-bar-button-files` / `add-terminal-split` / `split-resizer-*` / 展開ボタンへの testid 追加）への整合、または必要な testid 追加を実装スコープとして明記すべき。
3. **「5インスタンス」表現 (H11)**: 厳密に5固定ではなく「≥4（3split+History+ActivityPane）、FilePanel併用で5」。spec は実構成依存で記述すべき。
4. **テストフィクスチャ (Issue記載)**: 「テスト用worktree 2件」が必要だが、worktree詳細はDB+実gitリポジトリ+セッション依存。フィクスチャの現実的な準備方法（seed DB / モック）を明確化すべき。
