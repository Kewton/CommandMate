# Architecture Review: Issue #299 Stage 2 - 整合性レビュー

## 基本情報

| 項目 | 内容 |
|------|------|
| Issue | #299 iPad/スマホ レイアウト崩れ・全画面表示不具合修正 |
| Stage | Stage 2 (整合性レビュー) |
| フォーカス | 設計方針書とコードベースの整合性 |
| ステータス | 条件付き承認 |
| スコア | 4/5 |
| 実施日 | 2026-02-18 |

---

## Executive Summary

設計方針書とコードベースの整合性を検証した結果、Z_INDEX定数値、MOBILE_BREAKPOINT export、Modal.tsxのz-[9999]ハードコード、useSwipeGesture.tsの統合可能性など主要な設計項目において整合性が確認された。

しかし、**1件のMust Fix**が発見された。設計方針書のz-index競合分析セクションにおいて、Toast.tsxが「Z_INDEX.TOAST=60で管理されている」と記載しているが、実際にはz-50がハードコードされており、Z_INDEX.TOASTを使用していない。この不整合は、Modal.tsxのz-[9999]をZ_INDEX.MODAL(50)に変更した際にToast通知がModalの背後に隠れる潜在的リスクに直結するため、設計方針書の競合分析の前提修正が必要である。

その他、z-50ハードコードコンポーネント一覧の網羅性不足、JSDocコメント修正案の番号体系ずれ、Playwright iPadプロファイル未設定など3件のShould Fix、4件のNice to Haveを検出した。

---

## 整合性マトリクス

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| Z_INDEX定数値 (MODAL:50, MAXIMIZED_EDITOR:55) | 既存値を維持 | 一致 | z-index.ts L30/L35で確認 |
| Modal.tsx z-[9999] | style={{ zIndex: Z_INDEX.MODAL }}に置換予定 | 未実装(現状一致) | Modal.tsx L86にz-[9999]が存在 |
| MOBILE_BREAKPOINT export | useIsMobile.tsからexport | 一致 | useIsMobile.ts L15で確認 |
| SearchBar.tsx 768ハードコード | MOBILE_BREAKPOINTに置換予定 | 未実装(現状一致) | SearchBar.tsx L158で768を確認 |
| Toast z-index管理 | 「Z_INDEX.TOAST=60で管理」 | **不整合** | Toast.tsx L205はz-50ハードコード |
| ContextMenu z-index管理 | Z_INDEX.CONTEXT_MENU=70定義あり | **不整合** | ContextMenu.tsx L228はz-50ハードコード |
| isInsideScrollableElement | overflowY + scrollHeight判定 | 統合可能 | useSwipeGesture.ts handleTouchStartに追加可能 |
| swipe threshold | 100から150に引き上げ | 未実装(現状一致) | MarkdownEditor.tsx L184: threshold: 100 |
| body.style.overflow | Modal表示時にhiddenを設定 | 一致 | Modal.tsx L64で確認 |
| createPortal | document.bodyに配置 | 一致 | Modal.tsx L85/L131で確認 |
| Playwright iPad emulation | E2Eテストで使用予定 | **要追加** | playwright.config.tsにiPadプロファイルなし |

---

## 詳細Findings

### Must Fix (1件)

#### F001: Toast/ContextMenuのz-index管理に関する競合分析の誤り

- **重要度**: Must Fix
- **カテゴリ**: コード整合
- **場所**: 設計方針書 3.1 [F007対応] Modal(z-50)変更後のz-index競合分析

**問題**:

設計方針書のz-index競合分析セクションでは以下の記述がある:

> Toast(Z_INDEX.TOAST=60)との表示順序: Toast通知はZ_INDEX.TOAST=60で管理されており、Modal(50)より上に表示される。

しかし、実際のコードベースを確認すると:

```typescript
// src/components/common/Toast.tsx (L205)
className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
// -> z-50 ハードコード。Z_INDEX.TOAST を使用していない。

// src/components/worktree/ContextMenu.tsx (L228)
className="fixed z-50 min-w-[160px] py-1 ..."
// -> z-50 ハードコード。Z_INDEX.CONTEXT_MENU を使用していない。
```

Z_INDEX定数はz-index.tsで定義されている(TOAST=60, CONTEXT_MENU=70)が、Toast.tsxとContextMenu.tsxはこれらの定数を使わずz-50をハードコードしている。実際にZ_INDEX定数を使用しているのはAppShell.tsx(Z_INDEX.SIDEBAR)とMarkdownEditor.tsx(Z_INDEX.MAXIMIZED_EDITOR)の2ファイルのみである。

Modal.tsxのz-[9999]をZ_INDEX.MODAL(50)に変更した場合、ModalとToastが同じz-index値(50)になり、DOM順序によってはToast通知がModalの背後に表示される可能性がある。

**改善提案**:

1. 競合分析セクションのToast/ContextMenuに関する記述を実装に合わせて修正する
2. Toast.tsxがz-50ハードコードである事実を記載し、Modalと同値になることを明記する
3. 以下のいずれかの対策を設計方針書に追加する:
   - (a) Issue #299のスコープ内でToast.tsxをZ_INDEX.TOAST(60)に修正する(変更は1行のみ、影響軽微)
   - (b) createPortalのDOM順序でToastが常にModalの上に描画される保証を技術的に説明する
   - (c) ModalのToastContainer内蔵(MarkdownEditor.tsx内部のToast)でカバーされることを説明し、グローバルToastとの競合ケースが存在しないことを証明する

---

### Should Fix (3件)

#### F002: z-50ハードコードコンポーネント一覧の不完全性

- **重要度**: Should Fix
- **カテゴリ**: コード整合
- **場所**: 設計方針書 3.1 [F007対応] z-50/z-40ハードコードコンポーネント一覧

**問題**:

設計方針書では5つのコンポーネントを記載しているが、実際には以下のコンポーネントも z-50 をハードコードしている:

| コンポーネント | ファイル:行 | 用途 |
|--------------|-------------|------|
| SortSelector | SortSelector.tsx:142 | ソートドロップダウン |
| MobilePromptSheet (overlay) | MobilePromptSheet.tsx:148 | モバイルプロンプトシート背景 |
| MobilePromptSheet (sheet) | MobilePromptSheet.tsx:164 | モバイルプロンプトシート本体 |
| Header | Header.tsx:25 | sticky header |
| WorktreeDetailRefactored | WorktreeDetailRefactored.tsx:1819 | fixedボタン |
| ContextMenu | ContextMenu.tsx:228 | 右クリックメニュー |

**改善提案**:

z-50ハードコードコンポーネントの一覧を網羅的に更新し、各コンポーネントがModal(z-50)と同値になった際の表示競合の有無を分析する。

---

#### F003: MAXIMIZED_EDITORコメント修正の実装済み確認

- **重要度**: Should Fix
- **カテゴリ**: コード整合
- **場所**: 設計方針書 3.1 z-index.ts変更内容、10. 変更ファイル一覧

**問題**:

設計方針書では変更ファイル一覧(セクション10)に「z-index.ts: MAXIMIZED_EDITORコメント修正」を記載し、実装チェックリスト(セクション12)に「MAXIMIZED_EDITORのコメントを修正」を含めている。

しかし、現在のz-index.ts L34のコメントは:

```typescript
/** Maximized editor overlay - above Modal for iPad fullscreen support */
MAXIMIZED_EDITOR: 55,
```

設計方針書セクション3.1のコード例で示されているコメントと既に同一であり、追加の修正は不要と見られる。

**改善提案**:

設計方針書のz-index.ts変更内容を「JSDocコメント修正のみ(MAXIMIZED_EDITORコメントは既に修正済み)」に更新する。

---

#### F004: JSDocコメント修正案のレイヤー番号体系

- **重要度**: Should Fix
- **カテゴリ**: コード整合
- **場所**: 設計方針書 3.1 JSDocコメント修正

**問題**:

現在のz-index.ts JSDoc (L11-20):

```
 * 1. Base content (default stacking)
 * 2. Dropdown menus (10)
 * 3. Sidebar (30) - Desktop layout only
 * 4. Modal dialogs (9999) - Issue #225
 * 5. Toast notifications (60)
 * 6. Context menus (70)
```

MAXIMIZED_EDITOR(55)がレイヤー一覧に含まれていない。設計方針書の修正案ではMAXIMIZED_EDITORをLayer 5に挿入しているが、既存のToast(Layer 5)とContext menus(Layer 6)の番号繰り上げを明示していない。

**改善提案**:

完全な修正後JSDoc案を提示する:

```
 * 1. Base content (default stacking)
 * 2. Dropdown menus (10)
 * 3. Sidebar (30) - Desktop layout only
 * 4. Modal dialogs (50)
 * 5. Maximized editor overlay (55)
 * 6. Toast notifications (60)
 * 7. Context menus (70)
```

---

### Nice to Have (4件)

#### F005: Playwright iPad device profile未設定

- **場所**: 設計方針書 9. テスト戦略 - E2Eテスト
- **内容**: playwright.config.tsにDesktop ChromeとiPhone 13のみ定義。iPadプロファイル(例: `devices['iPad Pro 11']`)が存在しない。
- **提案**: Phase 4の前提作業としてPlaywright設定更新が必要であることを明記する。

#### F006: useSwipeGesture既存テストの拡張必要性

- **場所**: 設計方針書 9. テスト戦略 - ユニットテスト
- **内容**: 既存のuseSwipeGesture.test.ts(179行)は初期化テストのみで、タッチイベントシミュレーションを含まない。isInsideScrollableElement追加テストにはgetComputedStyleモック等の大幅な拡張が必要。
- **提案**: テスト更新の具体的な手法をテスト戦略に補足する。

#### F007: handleTouchStart型ガードの明示的説明

- **場所**: 設計方針書 3.3 handleTouchStart実装例
- **内容**: `e.target instanceof HTMLElement`の型ガードが実装例に正しく含まれているが、TypeScript strictモードでの必要性の説明がない。
- **提案**: TouchEvent.targetがEventTarget型であるため型ガードが必要である旨の注記を追加する。

#### F008: SearchBar.tsx変更のカテゴリ分類

- **場所**: 設計方針書 11. 実装順序 Phase 3
- **内容**: SearchBar.tsxのMOBILE_BREAKPOINT変更がPhase 3「iPadレスポンシブ対応」に含まれているが、実際にはiPad固有ではなく定数統一の汎用改善である。
- **提案**: 分類の補足説明を追加する。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | Modal(z-50)変更後のToast(z-50ハードコード)との競合 | Medium | Medium | P1 |
| 技術的リスク | z-50ハードコードコンポーネントの網羅不足による予期しない表示順序 | Medium | Low | P2 |
| 運用リスク | Playwright iPad profile未設定によるE2Eテスト実施不可 | Low | High | P2 |
| セキュリティ | なし(UIレイヤーのCSS変更のみ) | - | - | - |

---

## 実装順序の依存関係確認

設計方針書のPhase 1-4の実装順序を検証した結果:

| Phase | 依存関係 | 評価 |
|-------|---------|------|
| Phase 1: z-index体系統一 | なし(独立した変更) | 正しい |
| Phase 2: スワイプ/スクロール分離 | Phase 1に依存しない | 正しい |
| Phase 3: iPadレスポンシブ対応 | Phase 1/2に依存しない | 正しい |
| Phase 4: テスト | Phase 1-3の完了が前提 | 正しい |

Phase 1-3は相互に独立しており、並行実装も可能。Phase 4はPhase 1-3の完了後に実施する順序は適切である。

---

## 結論

設計方針書は主要な設計項目(Z_INDEX定数、MOBILE_BREAKPOINT、isInsideScrollableElement実装方針)において実際のコードベースと整合している。しかし、z-index競合分析の前提(Toast/ContextMenuがZ_INDEX定数を使用しているとの記載)が実装と不一致であり、Modal.tsxのz-[9999]をz-50に変更した際のToast表示順序リスクが未評価である。この点を修正すれば実装に進むことが可能であるため、条件付き承認とする。

---

*Generated by architecture-review-agent for Issue #299*
*Stage: 2 (整合性レビュー)*
*Date: 2026-02-18*
