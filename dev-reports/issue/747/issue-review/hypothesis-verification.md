# Issue #747 仮説検証結果

**Issue**: feat(layout): move sidebar toggle (hamburger) from DesktopHeader to top of ActivityBar (PC)
**検証日時**: 2026-06-01

## 検証サマリー

Issue記載の技術的主張・ファイルパス・コード参照をコードベースと照合。**大筋で正確**だが、行番号と一部のテスト前提に乖離あり。

| # | Issueの主張 | 検証結果 | 備考 |
|---|------------|---------|------|
| 1 | ハンバーガーは `DesktopHeader` (PC上部ヘッダー左端) にある | ✅ 正確 | `WorktreeDetailSubComponents.tsx` の `DesktopHeader` 内に存在 |
| 2 | ハンバーガーは line 485-505、区切り線は line 506 | ⚠️ 行番号ずれ | 実際は L458-481 付近（button）+ L482 付近（separator `w-px h-6`）。既に `{onMenuClick !== undefined && (...)}` でラップ済み |
| 3 | `onMenuClick` は `useSidebarContext().toggle` にバインド | ✅ 正確 | `WorktreeDetailRefactored.tsx:1779` `onMenuClick={toggle}`、toggle は L230 `useSidebarContext()` 由来 |
| 4 | SVGアイコンは三本線 `M4 6h16M9 12h15M4 18h16` | ✅ 正確 | DesktopHeader 内SVGと一致（※`M9 12h15` は元コードのまま。`M4 12h16` ではない点に注意してCOPY） |
| 5 | `ActivityBar.tsx` は `ACTIVITIES` 6個を `role="tablist"` で縦表示 | ✅ 正確 | `w-12`、`flex flex-col items-stretch`、Tooltip でラップ済み |
| 6 | `useSidebarContext()` が `isOpen` / `toggle` を提供 | ✅ 正確 | `SidebarContext.tsx` `SidebarState` に `isOpen: boolean` / `toggle: () => void` 定義 |
| 7 | `Tooltip` コンポーネント (#730) が利用可能 | ✅ 正確 | `src/components/common/Tooltip.tsx` export 済み、ActivityBar で既に使用 |
| 8 | line 1795 `<DesktopHeader ... onMenuClick={toggle} />` | ⚠️ 行番号ずれ | 実際は `WorktreeDetailRefactored.tsx:1776-1781`、`onMenuClick={toggle}` は L1779 |
| 9 | ActivityBar 呼び出し側 (L1770-1773) は activeActivity/onActivityChange のみ | ✅ 正確 | sidebar toggle 用 prop は現状なし |
| 10 | テスト `tests/unit/components/worktree/ActivityBar.test.tsx` を更新 | ❌ 不正確 | **既存ファイルなし**。新規作成が必要 |
| 11 | 「関連テスト（DesktopHeader）」のアサーション更新 | ❌ 不正確 | DesktopHeader / WorktreeDetailSubComponents のテストファイルは**存在しない**。更新対象なし |

## 重要な発見

### 発見1: `onMenuClick` は既に optional 化されている
DesktopHeader の現コードは `{onMenuClick !== undefined && (<>...</>)}` でハンバーガー＋separatorをまとめてガードしている。Issue の「optional 化推奨」は**既に実現済み**。よって `WorktreeDetailRefactored.tsx` の `onMenuClick={toggle}` を**削除するだけ**で、DesktopHeader 側のハンバーガー＋separator は自動的に描画されなくなる（条件式が false になるため）。

→ ただし将来の混乱を避けるため、DesktopHeader 側の dead-code（ハンバーガーブロック）を物理削除し、`onMenuClick` prop も型から除去（または optional のまま明示的非使用）するのが望ましい。**実装方針はPhase 4 work-planで確定**。

### 発見2: ActivityBar は PC専用マウント
`ActivityBar` は `WorktreeDesktopLayout` の `activityBar` slot（PC版レイアウト）でのみ描画される。モバイル経路は別。よって ActivityBar に sidebar toggle を足してもモバイルへの影響なし（Issue のスコープ宣言と整合）。

### 発見3: ActivityBar のキーボードナビゲーション干渉に注意
`ActivityBar` の `handleKeyDown` は `ACTIVITIES.length` と `buttonRefs` index ベースで Arrow ナビゲーションを実装。sidebar toggle ボタンを追加する場合、**tablist の tab 群とは別要素**（toggle は tab ではない）として配置し、`buttonRefs`/index 計算・`role="tab"` 群に含めないこと。さもないと ArrowUp/Down のインデックスがずれる。
→ 推奨: toggle ボタンを `role="tablist"` div の**外**（または tablist 内でも `role="tab"` を付けず buttonRefs に登録しない独立要素）に置く。Issue のレイアウト案は tablist div 内に toggle を置いているため、この点は実装時に明示的に対処が必要（must-fix候補）。

### 発見4: aria-orientation/role の整合
現 `ActivityBar` の root div が `role="tablist"`。toggle ボタンを同 div 直下に置くと「tablist の子に非tab要素」が混在する。アクセシビリティ的には toggle を tablist の外側ラッパに出すのが正しい。

## 結論

- Issue の**意図・対象ファイル・API は正確**。実装可能。
- 行番号は軽微にずれているが致命的でない。
- **テスト前提が不正確**: ActivityBar.test.tsx も DesktopHeader テストも存在しない → 「更新」ではなく「新規作成」。
- **追加考慮事項**: ActivityBar キーボードナビ index 干渉・tablist role 整合（アクセシビリティ）を実装で対処する必要あり。
