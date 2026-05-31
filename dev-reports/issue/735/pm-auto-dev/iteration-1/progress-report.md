# Issue #735 進捗報告（pm-auto-dev iteration-1）

**Issue**: test(e2e): add Playwright e2e for PaneResizer 複数インスタンス並列 + cross-worktree persistence (#728 R3-008)
**ブランチ**: `feature/735-worktree`
**実施日**: 2026-05-31
**CI 統合方針**: **方針 B**（CI 統合は本 Issue スコープ外。ローカル chromium e2e PASS が受入バー。`playwright.config.ts` / `.github/workflows` 無変更）

---

## サマリー

#728 で唯一手動 smoke のみだった受入条件 **AC-27**（PaneResizer 複数インスタンス並存下の cursor 非残留 / cross-worktree split 永続化）を **Playwright e2e で機械検証**できるようにした。プロダクション変更は testid 1 個の追加のみ（純 additive）。2 シナリオとも chromium で PASS、Mobile Safari は self-skip。

---

## 成果物

### プロダクション（1 行・additive）
| ファイル | 変更 |
|----------|------|
| `src/components/worktree/TerminalContainer.tsx` | History 展開 `<button>` に `data-testid="history-pane-expand"` 付与 |

### テスト（新規）
| ファイル | 内容 |
|----------|------|
| `tests/e2e/fixtures/terminal-split-helpers.ts` | `page.route` による worktree API モック（DB/git/tmux 非依存で split UI 描画）＋ sessionStorage ガード付き localStorage 隔離＋一意 worktreeId（`e2e-split-a/b`）＋`ensureFilesActivityVisible` |
| `tests/e2e/terminal-split-resizer-cursor.spec.ts` | AC-27 Scenario 1（≥4 resizer 並存 → `split-resizer-0` drag → cursor 'col-resize'→reset） |
| `tests/e2e/terminal-split-cross-worktree-persistence.spec.ts` | AC-27 Scenario 2（A=3 / B=1→2 / A復帰=3 / B復帰=2 の worktreeId スコープ分離） |

### ドキュメント
| ファイル | 変更 |
|----------|------|
| `CHANGELOG.md` | `[Unreleased] > Added` に e2e 追加と testid 追加を記載 |
| `CLAUDE.md` | TerminalContainer 行に testid 追加注記 |

---

## フェーズ結果

| Phase | 内容 | 状況 |
|-------|------|------|
| 1 | Issue 情報収集 | ✅ |
| 2 | TDD 実装（e2e-first） | ✅ 2 シナリオ PASS |
| 3 | 受入テスト | ✅ 14/14 AC pass（`acceptance-result.json`） |
| 4 | リファクタリング | ✅ 不要（最小・クリーン。fixture/spec は単一責務・コメント付き） |
| 5 | ドキュメント最新化 | ✅ CHANGELOG / CLAUDE.md |
| 6 | 実機受入テスト（UAT） | ✅ e2e specs が実 Next.js アプリ（live dev server）に対する自動 UAT を兼ねる（下記） |
| 7 | 進捗報告 | ✅ 本書 |

---

## 品質チェック結果

| チェック | コマンド | 結果 |
|---------|----------|------|
| TypeScript | `npx tsc --noEmit` | ✅ exit 0 |
| ESLint | `npm run lint` | ✅ No warnings or errors |
| Unit Test | `npm run test:unit` | ✅ 358 files / 6700 passed / 7 skipped |
| Build | `npm run build` | ✅ compiled |
| **E2E（chromium）** | `playwright test terminal-split-*` | ✅ 2 passed（`--repeat-each=3` で 6/6 安定） |
| **E2E（Mobile Safari）** | 同上 | ✅ 2 skipped（self-skip 動作確認・webkit install 済） |

---

## 実機受入テスト（UAT）の扱い

本 Issue の成果物は **それ自体が実ブラウザ自動テスト**であり、検証は以下の実機構成で実施済み:

- 本 worktree から `NODE_ENV=development CM_PORT=3217` で**専用 dev サーバを起動**（共有 :3000 は別 worktree〔MyCodeBranchDesk〕稼働中のため不可侵）。
- 実際の `/worktrees/[id]` ページを Chromium で描画し、ActivityBar / TerminalSplitContainer / PaneResizer を**実 DOM 操作**（split 追加・mouse drag・worktree 切替ナビゲーション）で検証。
- 2 シナリオとも PASS。

→ 別途 `/uat`（3010–3030 のサーバ起動 + 手動相当テスト）を重複実行せず、上記 e2e 実行を UAT 証跡とする。

---

## 既知の制約・フォローアップ

1. **CI 未統合（方針 B）**: e2e は GitHub Actions に未配線。新規 spec は API モック / chromium self-skip / localStorage 隔離で **CI-ready** に記述済み。配線は別 Issue で低コストに追加可能（非ブロッキング job + `actions/cache` + `playwright install --with-deps chromium`）。
2. **共有 :3000 サーバ**: 別 worktree 由来でチャンク不整合のため検証に使えず、専用ポートで実施（プロダクト挙動とは無関係の環境事情）。

---

## 次のアクション

- [ ] コミット（`feature/735-worktree`）
- [ ] PR 作成（`/create-pr`）— 方針 B＝CI 配線なしを明記、CI 統合 follow-up を提案
