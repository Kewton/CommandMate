## 概要

Issue #728（PCターミナル1-3分割）の受入条件 **AC-27**（PaneResizer複数インスタンス並列でcursor残留なし / cross-worktree永続化）は、unit/jsdomでは幅0のため検証不可で、現状は手動smokeのみで担保している。これを **Playwright e2e** で機械検証する。

#728 では 28/29 ACが自動化済みだが、AC-27 のみ手動検証 (`not_verifiable_in_unit_test`) として deferred されていた。

## 背景

#728 progress-report.md より:

| AC | 状況 |
|----|------|
| AC-01〜AC-26, AC-28〜AC-29（28件） | ✅ Unit/Integration test で自動化 |
| **AC-27** | ⚠️ 手動smokeのみ → 本Issueで自動化 |

### AC-27 の内容

1. **PaneResizer cursor残留問題**: 複数の Resizer 並列インスタンス（3スプリット + History + ActivityPane）でドラッグした際、ドラッグ終了後に cursor が初期状態（ドラッグ用カーソルが残留しない状態）に戻ること
2. **cross-worktree永続化**: worktree A で `splits=3` 設定 → worktree B 切替（A側設定保持）→ worktree A に戻ったら 3 復元 / B側は B 固有の設定（localStorage の worktreeId スコープ分離）

## 対応方針

`tests/e2e/` 配下に Playwright spec を追加。

### example spec は擬似コード（実 testid への整合が必須）

> **重要**: 以下の example spec は **説明用の擬似コード（pseudocode）** であり、**そのまま実行できるものではない**。本文中のセレクタの多くは現状コードと一致しない。実装時は後述の「実 testid 対応表」に従って整合させること。少なくとも `history-pane-expand` 相当の testid は**現状コードに存在しないため、実装で追加する必要がある**（受入条件参照）。

#### 実 testid 対応表（コードベース実測）

| Issue記載（擬似コード） | 実際のセレクタ | 対応 | 出典 |
|------------------------|----------------|------|------|
| `activity-bar-files` | `activity-bar-button-files` | spec修正で対応可 | `ActivityBar.tsx:116`（``activity-bar-button-${activity.id}``） |
| `terminal-split-add` | `add-terminal-split` | spec修正で対応可（語順が逆） | `TerminalSplitContainer.tsx:164` |
| `pane-resizer-terminal-split-1` | `split-resizer-{idx}`（**0始まり**, ラッパdiv） | spec修正で対応可。`pane-resizer-` プレフィックスは**存在しない**ため `[data-testid^="pane-resizer-"]` は常に0件になり即失敗する。PaneResizer 本体には testid 無し | `TerminalSplitContainer.tsx:251`（``split-resizer-${resizerIdx}``） |
| `history-pane-expand` | **testid 未付与**（展開ボタンに無し） | **コードに testid 追加が必要（実装スコープ）**。`terminal-container-expand-bar`（`TerminalContainer.tsx:52`）はラッパ要素で、その中のクリック対象ボタンへ `data-testid="history-pane-expand"` を付与すること | 該当ボタンに testid 無し |
| `terminal-split-pane-2` | 同名で正しい（``terminal-split-pane-{splitIndex}``） | そのまま利用可 | `TerminalSplitPane.tsx:81` |

### テストシナリオ

#### Scenario 1: PaneResizer cursor 非残留（複数 instance 並存）

```ts
// tests/e2e/terminal-split-resizer-cursor.spec.ts
// ※ 擬似コード。実装時は「実 testid 対応表」に従いセレクタを修正すること。
// ※ chromium プロジェクト限定で実行すること（Mobile Safari では本UIは描画されない）。
test('PaneResizer cursor reverts after drag (multiple parallel instances)', async ({ page }) => {
  await page.goto('/worktrees/{test-worktree-id}');

  // Activate Files activity (PaneResizer #1: ActivityPane vs Right)
  await page.click('[data-testid="activity-bar-button-files"]'); // ← 旧: activity-bar-files

  // Show History (PaneResizer #2: History vs Terminal)
  // ↓ 展開ボタンへ testid 追加が必要（実装スコープ）
  await page.click('[data-testid="history-pane-expand"]');

  // Split terminal up to 3 (PaneResizers #3, #4 = split 間×2)
  await page.click('[data-testid="add-terminal-split"]'); // ← 旧: terminal-split-add
  await page.click('[data-testid="add-terminal-split"]');

  // 基本構成では resizer は 4 件（ActivityPane↔Right + History↔Terminal + split間×2）。
  // FilePanel/Markdown を開くと +1 で5。よって「≥4」で検証する（厳密な 5 固定にしない）。
  await expect(page.locator('[data-testid^="split-resizer-"]')).toHaveCount(2); // split間のみ
  // 全 resizer 並存の確認は構成依存のため ≥4 を満たすことを意図する

  // Drag the split resizer
  const resizer = page.locator('[data-testid="split-resizer-0"]'); // ← 旧: pane-resizer-terminal-split-1
  await resizer.dragTo(page.locator('[data-testid="terminal-split-pane-2"]'));

  // After drag, cursor should NOT remain as drag cursor.
  // 実装は document.body.style.cursor='' にリセットする（PaneResizer.tsx:237）。
  // getComputedStyle 経由では環境依存で 'auto'/'default'/'' に解決されるため、
  // 'default' 厳密一致ではなく「col-resize でないこと」を検証する（flaky 回避）。
  const cursor = await page.evaluate(() => document.body.style.cursor);
  expect(cursor).not.toBe('col-resize'); // 残留していないこと（空文字 '' を期待）
});
```

#### Scenario 2: cross-worktree localStorage 分離

```ts
// ※ 擬似コード。chromium プロジェクト限定。セレクタは実 testid に整合させること。
test('terminal split config is isolated per worktree', async ({ page }) => {
  // Worktree A: split=3
  await page.goto('/worktrees/worktree-A');
  await page.click('[data-testid="add-terminal-split"]');
  await page.click('[data-testid="add-terminal-split"]');
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(3);

  // Switch to Worktree B (default split=1)
  await page.goto('/worktrees/worktree-B');
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(1);

  // Modify B: split=2
  await page.click('[data-testid="add-terminal-split"]');
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(2);

  // Return to A: should restore split=3 (not affected by B's split=2)
  await page.goto('/worktrees/worktree-A');
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(3);

  // Return to B: should restore split=2
  await page.goto('/worktrees/worktree-B');
  await expect(page.locator('[data-testid^="terminal-split-pane-"]')).toHaveCount(2);
});
```

> localStorage キーは `commandmate:terminalSplits:{worktreeId}`（`terminal-split-config.ts:49`）で worktree スコープ分離済み。`useTerminalSplits` は worktreeId 変化で再読込・config 変化で永続化する（`useTerminalSplits.ts:85-109`）。本シナリオが検証したいのは **split UI の DOM 件数 + localStorage の worktreeId スコープ分離**であり、tmux/CLI セッションは不要。

### Resizer インスタンス数の正確な内訳

| 構成 | Resizer 数 |
|------|-----------|
| ActivityPane ↔ Right | 1 |
| History ↔ Terminal | 1 |
| 3 split 間（split×3 → 隙間×2） | 2 |
| **基本合計** | **4** |
| + FilePanelSplit / MarkdownEditor を開いた場合 | **5** |

- 旧本文の「5並列インスタンス（3 splits + History + ActivityPane = Resizer×5）」は不正確で、**基本は 4**。`toHaveCount(5)` をデフォルト状態で固定すると失敗する。
- AC-27 の意図（複数 resizer 並存下での cursor 非残留回帰検出）は **≥4 で満たせる**。spec は「厳密に5固定」ではなく「≥4」または「5にするなら FilePanel/Markdown を開く前提操作を追加」で記述すること。

### 実行プロジェクトの限定（chromium のみ）

- `playwright.config.ts` の projects は `chromium` と `Mobile Safari (iPhone 13)` の2つ。
- ターミナル分割・ActivityBar・History pane は **PC（Desktop）レイアウト専用 UI** で、Mobile Safari では `add-terminal-split` 等が描画されない。
- 新規 spec は **chromium プロジェクト限定**で実行すること（`--project=chromium` フィルタ、または spec 内で project 判定して Mobile はスキップ）。1920x1080 viewport は Mobile Safari project とは独立に上書き指定する。

### テストフィクスチャ戦略

- Scenario 1/2 が検証するのは **split UI の DOM 挙動と localStorage 分離**であり、**実セッション（tmux/CLI）は不要**。
- worktree 詳細は DB（better-sqlite3）+ 実 git リポジトリ + セッション状態に依存するため、フィクスチャは具体的な準備手段が必要。以下のいずれかを採用する:
  - **(A) seed DB**: テスト用 worktree 2件を DB に投入（`db:init` 相当 + seed スクリプト）し、`/worktrees/{id}` を解決可能にする。
  - **(B) モック**: API レスポンスをモックして worktree 詳細を描画させる（セッション API はスタブ化）。
- 既存 e2e（`tests/e2e/worktree-detail.spec.ts` 等）は**フィクスチャを用意せず、要素の存在を条件分岐**して検証する防御的パターン（`if (count > 0)` 等）を採っている。これは確実な検証にはならないため、本 Issue では **seed もしくはモックで 2件の worktree を確定的に用意する**方針とする。共通ヘルパ（`tests/e2e/fixtures/` など）への切り出しを推奨。

### 環境設定

- 既存の `playwright.config.ts` を流用（`testDir: ./tests/e2e`, `baseURL: http://localhost:3000`, `webServer: npm run dev`）。
- テスト用 worktree 2 件のセットアップが必要（上記フィクスチャ戦略参照、CI でも再現可能であること）。
- viewport は `1920x1080` 固定（chromium project で上書き）。

## 受入条件

- [ ] `tests/e2e/terminal-split-resizer-cursor.spec.ts` 新規追加（chromium 限定）
- [ ] `tests/e2e/terminal-split-cross-worktree-persistence.spec.ts` 新規追加（または上記と統合、chromium 限定）
- [ ] **実 testid への整合**: example の擬似セレクタを上記「実 testid 対応表」に従い実コードへ整合させる
- [ ] **`history-pane-expand` testid の追加**: History 展開ボタン（`terminal-container-expand-bar` 内のクリック対象ボタン）へ `data-testid="history-pane-expand"` を付与する（実装スコープ）
- [ ] AC-27 の2シナリオ（cursor非残留 / cross-worktree分離）がいずれもPASSする
- [ ] cursor アサーションは `not.toBe('col-resize')`（残留なし＝空文字を期待）で検証し、`'default'` 厳密一致にしない
- [ ] resizer 件数アサーションは「厳密に5」ではなく実構成に合わせる（基本 ≥4。5 を成立させる場合は FilePanel/Markdown を開く前提操作を含める）
- [ ] フィクスチャ（テスト用 worktree 2件）が seed もしくはモックで確定的に用意され、CI でも再現可能
- [ ] **CI（GitHub Actions）統合の扱いを明確化**（下記「CI 統合方針」のいずれかを満たす）
- [ ] テスト実行時間が現実的（**localhost で全体3分以内が目安。hard requirement ではない**。CI は `retries=2`/`workers=1` のため時間が伸びる点に留意）
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS

### CI 統合方針（受入条件の検証可能化）

現状の CI（`.github/workflows/ci-pr.yml` / `publish.yml`）には **Playwright step が一切存在しない**（lint / type-check / unit test / build / security-audit のみ）。旧本文の受入条件「CIでe2eが実行され緑になる」は、前提（workflow 新設＋セッション非依存への限定）の定義がないと検証不能だったため、以下のいずれかを本 Issue で確定する:

- **方針 A（CI 統合を本 Issue スコープに含める）**:
  - e2e workflow を **新設**（または既存 workflow へ Playwright step 追記）することを必須タスクとする。
  - `webServer: npm run dev` で起動する worktree 詳細画面は **tmux/Claude CLI セッション依存**のため、CI（tmux/CLI 不在）では実セッションを張れない。よって **CI 上の検証範囲は「セッションに依存しない部分」（split UI の DOM 挙動・cursor 復帰・localStorage の worktreeId スコープ分離）に限定**し、セッション依存部分は seed DB / モックで代替する。
- **方針 B（CI 統合を本 Issue スコープ外とする）**:
  - 受入条件を「**ローカル e2e（chromium）PASS**」に緩和し、CI 統合は別 Issue とする旨を明記する。

> いずれを採るかを作業計画（/work-plan）で確定し、受入条件を「緑にできる現実的な前提」に紐づけて検証可能にすること。

## 想定影響範囲

### 新規
| ファイル | 内容 |
|----------|------|
| `tests/e2e/terminal-split-resizer-cursor.spec.ts` | AC-27 Scenario 1（chromium 限定） |
| `tests/e2e/terminal-split-cross-worktree-persistence.spec.ts` | AC-27 Scenario 2（chromium 限定） |
| `tests/e2e/fixtures/` | テスト用 worktree 2件の seed/モックヘルパ（推奨） |

### 既存変更
| ファイル | 変更内容 |
|----------|----------|
| `src/components/worktree/TerminalContainer.tsx` | History 展開ボタンへ `data-testid="history-pane-expand"` 追加（実装スコープ） |
| `playwright.config.ts` | 必要に応じて workers/timeout 調整、project filter 方針反映 |
| `.github/workflows/*.yml` | **方針 A 採用時**: e2e workflow 新設 or 既存へ Playwright step 追記（**現状 Playwright step は無い**） |
| `CHANGELOG.md` | [Unreleased] テスト追加記載 |

## スコープ外

- e2e全般のテストフレームワーク見直し
- 他Issue (#723/#725/#727/#730) のe2eカバレッジ拡充
- CI高速化（並列実行最適化）
- （方針 B 採用時）CI への e2e 統合

## 関連

- 親Issue: #728（PCターミナル1-3分割）
- 由来: #728 progress-report.md `R3-008`
- 既存テスト参考: `tests/e2e/worktree-detail.spec.ts`（フィクスチャ／防御的検証パターン）, `tests/integration/`（ターミナル分割関連の既存テスト）

---

<details>
<summary>Stage 1 レビュー反映履歴（2026-05-31）</summary>

本 Issue は multi-stage-issue-review Stage 1（通常レビュー）の指摘を反映済み。コードベース実測（hypothesis-verification）に基づく。

| 指摘ID | 重大度 | 内容 | 反映 |
|--------|--------|------|------|
| S1-001 | Must Fix | example spec の testid が実コードと不一致（4箇所中3箇所誤り） | 「擬似コード」明記＋実 testid 対応表を追加、`history-pane-expand` testid 追加を実装スコープ化 |
| S1-002 | Must Fix | 「CIで緑」が現状CI構成（Playwright step 無し）で検証不能 | CI 統合方針 A/B を定義、セッション依存部分の限定・seed/モック代替を明記し検証可能化 |
| S1-003 | Should Fix | テストフィクスチャ「worktree 2件」の準備方法が未定義 | seed DB / モックの具体策、既存 e2e の防御的パターン参照を追記 |
| S1-004 | Should Fix | 「5インスタンス」が実構成（基本4）と不一致 | resizer 内訳表を追加、受入条件を「厳密5」→「≥4」へ再定義 |
| S1-005 | Should Fix | Mobile Safari project への配慮欠如 | 新規 spec を chromium 限定にする方針を明記 |
| S1-006 | Nice to Have | cursor 期待値が曖昧（実装は空文字リセット） | `not.toBe('col-resize')` 検証へ変更 |
| S1-007 | Nice to Have | 「3分以内」の根拠・測定環境が未定義 | localhost 目安／hard requirement でない旨・CI 時間差を注記 |

</details>
