# Issue #739 仮説検証レポート（Phase 0.5）

対象: `fix(terminal): removeSplit fails to re-normalize widths, leaving 50% empty space (#728 follow-up)`

検証日: 2026-05-31

## 検証対象の仮説／主張

| # | 仮説/主張 | 根拠箇所 | 判定 |
|---|----------|----------|------|
| 1 | `removeSplit` は末尾を切り捨てるだけで widths を再正規化しない（`[0.5,0.5]`→`[0.5]`, sum=0.5） | `src/hooks/useTerminalSplits.ts:129-136` | **Confirmed** |
| 2 | CSS Flexbox は `flex-grow` 合計 < 1 のとき free space を割合分しか配分せず残りが空く | `src/components/worktree/TerminalSplitContainer.tsx:188-194` | **Confirmed** |
| 3 | `widthsValid` / `isValidSplitConfig` は各要素が正の有限数かのみ検証し、合計=1.0 を検証しない | `src/hooks/useTerminalSplits.ts:77-83`, `src/config/terminal-split-config.ts:62-82` | **Confirmed** |
| 4 | `addSplit` は合計を保存する設計（`lastWidth/2 + lastWidth/2 = lastWidth`）で変更不要 | `src/hooks/useTerminalSplits.ts:111-127` | **Confirmed** |

## 検証詳細

### 仮説1: removeSplit が再正規化しない — Confirmed

```ts
// useTerminalSplits.ts:129-136
const removeSplit = useCallback(() => {
  setConfig(prev => {
    if (prev.splits.length <= MIN_SPLITS) return prev;
    const splits = prev.splits.slice(0, -1);
    const widths = prev.widths.slice(0, -1);   // 末尾切り捨てのみ。再正規化なし
    return { splits, widths };
  });
}, []);
```

`[0.5, 0.5]` → `slice(0,-1)` → `[0.5]`（sum=0.5）。Issue記載のとおり。

### 仮説2: Flexbox free-space 配分 — Confirmed

```tsx
// TerminalSplitContainer.tsx:188-194
<div style={{ flexGrow: widths[idx] ?? 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }} className="h-full">
```

`flex-basis: 0` のため全幅が free space。子が1つで `flex-grow: 0.5`、合計 grow=0.5 < 1 のとき、配分は `container × 0.5` に留まり残り 50% が空く。CSS仕様どおりで、Issueの症状（193px / 387px）と整合。

### 仮説3: 合計=1.0 の検証なし — Confirmed

`widthsValid`（useTerminalSplits.ts:77-83）も `isValidSplitConfig`（terminal-split-config.ts:62-82）も、各 `w` が `Number.isFinite(w) && w > 0` かのみ検査。合計は未検査。

**重要な含意（自己回復経路の確認）**: 不正状態 `{ splits:[{cliToolId:'claude'}], widths:[0.5] }` は
- `splits.length=1` ∈ [1,3] ✓
- `widths.length=1 === splits.length` ✓
- `widths[0]=0.5 > 0` ✓

→ `isValidSplitConfig` を **通過する**。したがって対応方針の「ロード時に `normalizeWidths` を適用（バリデーション通過後）」により `[0.5]`→`[1]` へ自己回復できる。バリデーション仕様を変えずに回復可能であることを確認。

### 仮説4: addSplit は合計保存 — Confirmed

```ts
// useTerminalSplits.ts:116-121
const lastWidth = prev.widths[lastIdx];
const halved = lastWidth / 2;
newWidths[lastIdx] = halved;
newWidths.push(halved);
```

`[1]`→`[0.5,0.5]`（sum=1）、`[0.5,0.5]`→`[0.5,0.25,0.25]`（sum=1）。合計不変。変更不要との主張は妥当。

## Stage 1 への申し送り事項

- Rejected な仮説は **なし**（全 Confirmed）。Issueの原因分析・対応方針はコードベースと完全に整合。
- 設計レビュー向けの軽微な補強候補（Issue本文の欠陥ではない）:
  - `normalizeWidths` の `sum <= 0` フォールバックを `[...DEFAULT_SPLIT_CONFIG.widths]`（length=1固定）にすると、多要素配列で長さ不変条件 `widths.length === splits.length` を破る可能性が理論上ある。ただし呼び出し前提（全要素 > 0 ⇒ sum > 0）では当該分岐は到達不能。長さ保存フォールバック（`remaining.map(() => 1 / remaining.length)`）にすると防御的により安全 → Phase 3 設計レビューで扱う。
