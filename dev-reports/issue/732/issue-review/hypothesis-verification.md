# Issue #732 仮説検証レポート（Phase 0.5）

## 対象Issue
fix(layout): missing min-w-0 causes horizontal overflow, hiding FilePanel off-screen (#730 follow-up)

## 検証方法
`src/components/worktree/WorktreeDetailRefactored.tsx` および `WorktreeDesktopLayout.tsx` を直接 Read/Grep で照合。

## 検証結果

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | Issue #730 で追加された外側コンテナ `flex flex-col flex-1 min-h-0` に `min-w-0` が欠落 | **Confirmed** | `WorktreeDetailRefactored.tsx:1740` に `<div className="flex flex-col flex-1 min-h-0">` を確認。`min-w-0` なし。 |
| 2 | 中間の `flex-1 min-h-0` にも `min-w-0` が欠落 | **Confirmed** | `WorktreeDetailRefactored.tsx:1763` に `<div className="flex-1 min-h-0">` を確認。`min-w-0` なし。 |
| 3 | 該当箇所は1700行付近 | **Partially Confirmed** | 実際は 1740 行・1763 行（"付近"として妥当）。Issueの「1700行付近」は概算として許容範囲。 |
| 4 | 親 `flex h-full overflow-hidden relative` は overflow-hidden でクリッピングする | **Confirmed** | `WorktreeDetailRefactored.tsx:1738` に `<div className="flex h-full overflow-hidden relative">` を確認。 |
| 5 | `right-pane-slot` は flex-grow（溢れの起点は上位コンテナ） | **Confirmed** | `WorktreeDesktopLayout.tsx:136` で `className="flex-grow overflow-hidden min-w-0"`。right-pane-slot 自体は既に `min-w-0` を持つため、溢れの起点ではない。上位の 1740/1763 が欠落要因。 |
| 6 | `flex-1` は `flex:1 1 0%` だが min-width デフォルトは auto で content min width 以下に縮まない（Flexbox 仕様） | **Confirmed** | CSS Flexbox 仕様通り。1738 は flex-row のため、その flex item である 1740 は main 軸（横）に min-width:auto が適用され content 最小幅まで拡大する。`min-w-0` 付与で 0 にリセットされ overflow-hidden が機能する。 |
| 7 | desktop-layout (`data-testid="desktop-layout"`) の幅アサーションが受入条件 | **Confirmed** | `WorktreeDesktopLayout.tsx:107` に `data-testid="desktop-layout"` を確認。`containerClassName = flex h-full min-h-0`（min-w-0 なしだが block 子として 1763 幅に追従）。 |

## 申し送り事項（Stage 1へ）

- **根本原因の主因は line 1740**（flex-row コンテナ 1738 の直接の flex item）。`min-w-0` 付与が必須。
- **line 1763 への `min-w-0` 付与**は、column flex コンテナ内 flex item として理論上は cross 軸であり主因ではない可能性があるが、Issue の Playwright 実測で 2825px の溢れが両 div で確認されており、防御的・確実な修正として両方への付与が妥当。冗長であっても無害。
- 修正は CSS クラス文字列末尾への `min-w-0` 追記のみ。ロジック・props 変更なし。後方互換性リスクなし。
- 受入条件の自動テストは、jsdom では実レイアウト計算が行われないため、`getBoundingClientRect` ベースの厳密検証は Playwright（e2e）が適切。unit テストでは className に `min-w-0` が含まれることのアサーションが現実的。

## 総合判定
**仮説はすべて Confirmed（一部 Partially）**。Issue の原因分析・対応方針は実コードと整合しており、記載の最小修正（2箇所への `min-w-0` 追記）で妥当。
