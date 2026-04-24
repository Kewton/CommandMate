# Bug Fix Progress Report: Issue #676

## 1. 概要

| 項目 | 値 |
|------|-----|
| Issue 番号 | #676 |
| タイトル | サイドバーのブランチ tooltip が `isTooltipVisible=true` で固着し残り続ける |
| 重大度 | high |
| ブランチ | `feature/676-worktree` |
| Commit | `54d62d91bc4d06fe06402e458e592a643ec41534` |
| 採用方針 | A + B + C 全て適用（多層防御） |
| 最終ステータス | **passed**（全フェーズ完了、全品質ゲート pass） |

フェーズ進行:

| フェーズ | ステータス | 備考 |
|---------|-----------|------|
| Phase 1: 調査 | completed | Issue 本文に詳細な根本原因分析・対策案が既に記載済みのため investigation-agent 呼び出しをスキップ。実ファイルとの整合性は確認済み。 |
| Phase 2: 方針選定 | completed | ユーザー選定: `A+B+C 全て適用 (推奨)` |
| Phase 3: 作業計画 | completed | A/B/C の修正対象ファイル・行番号を確定 |
| Phase 4: TDD 修正 | passed | target file 45/45 passed、full suite 6390 passed / 7 skipped / 0 failed |
| Phase 5: 受入テスト | passed | 受入基準 7/7 met、lint/tsc/unit test 全 pass |

---

## 2. 根本原因

`src/components/sidebar/BranchListItem.tsx` の `isTooltipVisible` state が `true` のまま固定されるバグ。

- Issue #675 の無限ループが発生している最中、合成 `mouseleave` イベントと React 18 concurrent rendering のレースで `setIsTooltipVisible(false)` が dispatch されないケースがある。
- tooltip は portal によって **常時 DOM に存在し `opacity` で制御** しているだけの構造のため、state が異常な値になるとユーザー画面から物理的に除去できない。

結果としてユーザー体感上「選択済みのブランチに tooltip が貼り付いたまま残り続ける」という症状が発生していた。
Issue #675 の無限ループ本体修正は本 Issue スコープ外だが、本修正は **レースに対する多層防御** として `#675` 修正後も整合する設計にしてある。

---

## 3. 実施した修正内容

対象: `src/components/sidebar/BranchListItem.tsx`（本体）＋テスト 2 本

### 案 A: 選択中ブランチでは tooltip を表示しない

- 親コンポーネントで `showTooltip = isTooltipVisible && !isSelected` を算出し、`<BranchTooltip isVisible={showTooltip} />` に渡すように変更。
- 選択中ブランチの情報はメイン画面側に出ているため、そもそも tooltip を出す必要が薄い。スクショ症状（選択済みブランチの残留 tooltip）を根元から解消。

### 案 B: click 時に明示的に `setIsTooltipVisible(false)` を呼ぶ

- `handleClick` ラッパーを導入し、`setIsTooltipVisible(false)` を先に実行してから上位 `onClick` を呼ぶようにした。
- `click` という確実に発火するトリガで state を強制的に落とすため、`onMouseLeave` がスキップされるレースに依存しなくなる。

### 案 C: `isVisible=false` のとき portal 内部を `return null` で物理的に除去

- `BranchTooltip` の useEffect 宣言**後**に `if (!isVisible) return null;` を配置し、非表示時は DOM ノード自体が存在しないようにした。
- 従来の `opacity: isVisible ? 1 : 0` 制御は廃止し、常時マウント戦略を止めた（最終防御線）。
- `aria-describedby` は `showTooltip === true` のときだけ button に付与するよう変更（dangling reference 回避）。
- `BranchTooltip` の JSDoc コメントを「Always present in DOM / CSS-controlled visibility」から「mount-on-visible」ライフサイクル記述に更新。

### Hook 安全性の担保

`BranchTooltip` 内の Hook 呼び出し順序は `useState → useEffect → SSR ガード(typeof document) → 可視性 early return → createPortal` の順を厳守。`if (!isVisible) return null;` を必ず useEffect の**後**に置くことで、React が観測する Hook 呼び出し数は常に一定。SSR ガードも保持。

---

## 4. 変更ファイル一覧

| ファイル | 種別 | 概要 |
|---------|------|------|
| `src/components/sidebar/BranchListItem.tsx` | modified (本体) | A/B/C 全てを反映。`showTooltip` 算出、`handleClick` ラッパー、`BranchTooltip` の `!isVisible` 早期 return、`aria-describedby` のゲート、JSDoc 更新、`opacity` スタイル除去。 |
| `tests/unit/components/sidebar/BranchListItem.test.tsx` | modified (テスト) | 新 describe `Tooltip visibility lifecycle (Issue #676)` を追加（9 テスト）。既存 10 テストは「mouseEnter を先に発火してから tooltip 検証」に更新。`showRepositoryName` 系は DOM 部分木で `>=1` を検証する形に調整。 |
| `tests/unit/components/layout/Sidebar.test.tsx` | modified (隣接テスト) | `should show repository name for each branch` のカウント期待値を `>=3` から `>=1` に緩和。従来値は「常時マウントされた tooltip DOM の重複」に暗黙依存していたための調整で、グループヘッダに 1 回出る実ユーザー視認仕様と整合。 |

---

## 5. テスト結果

### 5.1 TDD サイクル

| フェーズ | 結果 |
|---------|------|
| Red | 修正前コードに対して 9 新規テストと更新 8 既存テストを追加・実行。**7 テストが failing** することを確認。 |
| Green | `BranchListItem.tsx` に A+B+C を適用。target file **45/45 passed**。 |
| Refactor | `BranchTooltip` の JSDoc を新ライフサイクル仕様に更新。古い `opacity` スタイルを削除。Issue #675 スコープ外のコードには触れず最小修正範囲を維持。 |

### 5.2 メトリクス

| 指標 | 修正前 | 修正後 | 増減 |
|------|--------|--------|------|
| target file (BranchListItem.test.tsx) | 36 | 45 | +9 |
| full suite total | 6388 | 6397 | +9 |
| full suite passed | 6381 | 6390 | +9 |
| skipped | 7 | 7 | ±0 |
| failed | 0 | 0 | ±0 |

新規追加 9 テスト:

- `should not render tooltip in DOM on initial render (C)`
- `should not attach aria-describedby on initial render (accessibility)`
- `should show tooltip on mouseEnter`
- `should hide tooltip on mouseLeave`
- `should hide tooltip on click (B)`
- `should still invoke onClick when click hides the tooltip (B)`
- `should not render tooltip when isSelected=true even on mouseEnter (A + C)`
- `should not attach aria-describedby when isSelected=true (A)`
- `should show tooltip on focus and hide on blur`

### 5.3 受入テスト（7/7 met）

| # | 受入基準 | 結果 |
|---|---------|------|
| 1 | 選択中ブランチでは tooltip が表示されないこと | passed |
| 2 | mouseLeave で tooltip が消えること | passed |
| 3 | click で tooltip が消えること（明示的リセット） | passed |
| 4 | focus → blur で tooltip が消えること | passed |
| 5 | `isVisible=false` のとき tooltip div が DOM に存在しないこと | passed |
| 6 | `aria-describedby` は tooltip 実在時のみ button に付くこと | passed |
| 7 | 既存の tooltip 表示機能（表示内容・トリガ）が壊れていないこと | passed |

### 5.4 品質ゲート

| チェック | コマンド | 結果 |
|---------|---------|------|
| Lint | `npm run lint` | passed（警告・エラーなし） |
| TypeCheck | `npx tsc --noEmit` | passed（型エラーなし） |
| Unit Tests (target) | `npx vitest run tests/unit/components/sidebar/BranchListItem.test.tsx` | **45 / 45 passed**（約 712ms） |
| Unit Tests (full) | `npm run test:unit` | 340 files / **6390 passed** / 7 skipped / 0 failed（約 13.87s） |

### 5.5 カバレッジ（branches covered）

- `BranchTooltip` の `!isVisible` 早期 return
- `BranchTooltip` の `isVisible=true` 通常描画
- `showTooltip = isTooltipVisible && !isSelected` の両分岐
- `handleClick` における visibility リセット → 上位 onClick 呼び出し順序
- `aria-describedby` の `showTooltip` ゲート
- `mouseEnter / mouseLeave / focus / blur` 各トリガ遷移

---

## 6. リスクと次のステップ

### 6.1 受容済みリスク

- **Issue #675（無限ループ本体）は未修正**。本 Issue スコープ外のため別 Issue で対応。本修正は race に対する多層防御であり、`#675` 修正後も破綻しない設計。

### 6.2 留意事項（致命的ではないが将来の考慮点）

- `transition-opacity duration-150` クラスはマウント/アンマウント方式に切り替わった現在は cosmetic のみで実効なし。将来的なクリーンアップ候補（非ブロッカー）。
- `BranchTooltip` 内の Hook 順序は「early return を `useState/useEffect` の後ろに置く」ことで保たれている。将来のリファクタで並びを崩さないようコードレビューで注意するとよい。
- Adjacent の `Sidebar.test.tsx` アサーションを `>=3` → `>=1` に緩和したのは DOM 構造変更の当然の帰結であり、機能的 regression ではない。

### 6.3 次のステップ

1. `/create-pr` で PR を作成（feature/676-worktree → develop）。
2. develop へのマージ後、**再現条件（`.md` ファイル表示中での選択操作）** を含む実機 UAT を `/uat` で実施。
3. Issue #675（無限ループ本体）を別途着手。

---

## 7. 関連 Issue（#675 との関係）

- Issue #675: サイドバーで発生する無限ループの本体（root cause は同画面の別コンポーネント由来）。
- 本 Issue #676 は、`#675` によるレース状況下で顕在化する「選択済みブランチ tooltip の残留」を修正する。
  - `#675` が直った場合でも、本修正で導入した A/B/C の防御は冗長な保険として機能し、副作用はない。
  - 逆に `#675` が未修正のままでも、本修正によりユーザー可視の残留 tooltip は解消される（C 案の DOM 物理除去が最終防御線）。
- よって本修正は **`#675` の解決を待たずに単独でマージしてよい** と判断する。

---

## 参考

- `dev-reports/bug-fix/issue676_20260424_201938/investigation-result.json`
- `dev-reports/bug-fix/issue676_20260424_201938/work-plan-context.json`
- `dev-reports/bug-fix/issue676_20260424_201938/tdd-fix-result.json`
- `dev-reports/bug-fix/issue676_20260424_201938/acceptance-result.json`
- commit `54d62d91bc4d06fe06402e458e592a643ec41534` on `feature/676-worktree`
