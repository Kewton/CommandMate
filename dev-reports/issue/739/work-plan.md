# Issue #739 作業計画書

**Issue**: fix(terminal): removeSplit fails to re-normalize widths, leaving 50% empty space (#728 follow-up)
**ブランチ**: feature/739-worktree（設定済み）
**設計方針書**: dev-reports/design/issue-739-removesplit-width-normalization-design-policy.md
**作成日**: 2026-05-31

## ゴール

`removeSplit` 後とロード時に `widths` を再正規化し、合計を 1.0 に保つことで「`-Split` 後にターミナルが 50% 幅で残る」バグを解消する。

## タスク分解（TDD: Red → Green → Refactor）

| # | タスク | 対象ファイル | 依存 |
|---|--------|-------------|------|
| T1 | 回帰テスト追加（Red）: removeSplit後 sum≈1.0 / 比率保持 / 不正`[0.5]`ロード自己回復 | `tests/unit/hooks/useTerminalSplits.test.ts` | - |
| T2 | `normalizeWidths` 純関数を追加（module scope） | `src/hooks/useTerminalSplits.ts` | T1 |
| T3 | `removeSplit` で `normalizeWidths(slice)` 適用（Green） | `src/hooks/useTerminalSplits.ts` | T2 |
| T4 | `readInitialState` でバリデーション通過後に正規化コピー返却（Green） | `src/hooks/useTerminalSplits.ts` | T2 |
| T5 | CHANGELOG 追記 | `CHANGELOG.md` | T3,T4 |
| T6 | 品質ゲート: lint / tsc / test:unit / build 全 PASS | - | T1-T5 |

## 実装詳細

### T1 テスト（Red）— `toBeCloseTo(1)` を使用（`=== 1.0` 禁止 / 設計レビュー S3-001）

1. `removeSplit 後に widths 合計が ≈1.0`: 3→2→1 各段階で `expect(sum).toBeCloseTo(1)`。
2. `removeSplit が比率を保持`: 例 `[0.6,0.3,0.1]` 相当の状態から末尾除去 → `[0.667, 0.333]` 近似、sum≈1。
   （注: 状態は addSplit/setSplitWidth 経由で構築。setSplitWidth は length 一致＋全正値が条件）
3. `不正 widths=[0.5] のロード自己回復`: localStorage に `{splits:[{cliToolId:'claude'}], widths:[0.5]}`（isValidSplitConfig を通る）→ ロード後 `widths` が `[1]`（`toBeCloseTo(1)`）。
4. 既存 `restores a valid stored config`（`[0.6,0.4]`）が引き続き PASS（回帰なし確認）。

### T2-T4 実装（Green）

設計方針書 §3.1-3.3 のとおり:
- `normalizeWidths(widths)`: `sum>0 ? widths.map(w=>w/sum) : widths.map(()=>1/widths.length)`
- `removeSplit`: `const widths = normalizeWidths(prev.widths.slice(0, -1));`
- `readInitialState`: `if (isValidSplitConfig(parsed)) return { ...parsed, widths: normalizeWidths(parsed.widths) };`

### T5 CHANGELOG

`[Unreleased]` の `Fixed` に #739 を追記。

## 受入条件（Issue より）

- `+Split`→`-Split` で全幅占有（DOM `splitWidth === containerWidth`、e2e はスコープ外なので unit + 目視/手動）
- `removeSplit` 後 `sum ≈ 1.0`（`toBeCloseTo(1)`）
- 不正 localStorage 状態のロード自己回復
- 3→2→1 連続でも各段階で sum≈1.0
- 既存テスト全 PASS ＋ 回帰テスト追加
- `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全 PASS

## リスク・留意

- 浮動小数点: テスト assertion は `toBeCloseTo`。
- `widthsValid`/`isValidSplitConfig` は変更しない（スコープ外）。
- 実装は単一ファイル＋テスト＋CHANGELOG のみ。波及最小。
