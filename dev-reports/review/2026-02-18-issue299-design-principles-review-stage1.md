# Architecture Review: Issue #299 - Stage 1 設計原則レビュー

## 概要

| 項目 | 内容 |
|------|------|
| **Issue** | #299 iPad/スマホ レイアウト崩れ・全画面表示不具合修正 |
| **レビューステージ** | Stage 1 通常レビュー（設計原則） |
| **レビュー対象** | 設計方針書 `issue-299-ipad-layout-fix-design-policy.md` |
| **ステータス** | 条件付き承認 (Conditionally Approved) |
| **スコア** | 4/5 |
| **日付** | 2026-02-18 |

## Executive Summary

設計方針書は全体として高品質であり、4つの症状を3つの独立したサブタスクに分解するアプローチは適切である。SOLID原則への準拠度は高く、特にSRP（単一責任）、OCP（開放閉鎖）、ISP（インターフェース分離）の観点で問題は見られない。

主な改善点は以下の通り:

1. **[must_fix]** Modal.tsx の z-index を 9999 から 50 に下げる際の競合分析が不足
2. **[should_fix]** z-index.ts への MOBILE_HEADER/MOBILE_DRAWER 定数追加がスコープ宣言と矛盾
3. **[should_fix]** MODAL と MOBILE_DRAWER の値重複（共に 50）に関する設計根拠の欠如

---

## 設計原則チェックリスト

### SOLID 原則

| 原則 | 評価 | 根拠 |
|------|------|------|
| **Single Responsibility** | Pass | isInsideScrollableElement はスクロール判定のみ、useSwipeGesture はスワイプ検出のみ、Z_INDEX は定数管理のみ。各モジュールの責務は単一に保たれている |
| **Open/Closed** | Pass | useSwipeGesture の options インターフェースは既存プロパティを変更せず拡張可能。Z_INDEX 定数も `as const` で変更不可かつ新規キーの追加が容易 |
| **Liskov Substitution** | N/A | 本設計に継承/インターフェース実装は含まれない |
| **Interface Segregation** | Pass | UseSwipeGestureOptions は各コールバック(onSwipeLeft/Right/Up/Down)がオプショナルであり、不要なコールバックの実装を強制しない |
| **Dependency Inversion** | Pass | Modal.tsx が Z_INDEX 定数をインポートする方向（コンポーネント -> 設定層）は適切。useSwipeGesture が DOM API に直接依存するのはフック層として自然 |

### KISS 原則

| 対象 | 評価 | 根拠 |
|------|------|------|
| **isInsideScrollableElement** | Pass | while ループによる親要素走査と getComputedStyle による判定はシンプルかつ直感的。再帰呼び出しではなくイテレーティブな実装で理解しやすい |
| **Modal.tsx の inline style 変更** | Pass | `z-[9999]` Tailwind クラスから `style={{ zIndex: Z_INDEX.MODAL }}` への移行は、定数一元管理のための最小限の変更 |
| **breakpoint 768px 維持** | Pass | 既存の Tailwind `md:` プレフィクスとの整合性を維持し、変更範囲を最小化する判断は KISS に準拠 |

### YAGNI 原則

| 対象 | 評価 | 根拠 |
|------|------|------|
| **MOBILE_HEADER/MOBILE_DRAWER 定数** | Conditional | 設計方針書のコード例に定数が含まれるが、利用箇所の z-40/z-50 ハードコード統一はスコープ外と宣言。使わない定数の追加は YAGNI 違反の可能性あり (F001) |
| **isInsideScrollableElement の overflowY 限定** | Pass | 現在の症状（下スワイプ解除）に対して overflowY のみの判定は必要十分。overflowX まで含めない判断は YAGNI に準拠 |
| **threshold 引き上げ (100 -> 150)** | Pass | 主対策（scrollable 判定）の補助として、必要最小限の変更 |

### DRY 原則

| 対象 | 評価 | 根拠 |
|------|------|------|
| **Z_INDEX 定数体系** | Conditional | Modal.tsx のマジックナンバー排除は DRY 改善だが、MOBILE_HEADER/MOBILE_DRAWER 定数と既存 z-40/z-50 ハードコードの整合性に矛盾 (F001, F002) |
| **MOBILE_BREAKPOINT 定数共有** | Pass | SearchBar.tsx が useIsMobile.ts からエクスポートされた定数を使用し、768 のハードコード重複を解消 |

---

## 詳細 Findings

### F001 [should_fix] MOBILE_HEADER/MOBILE_DRAWER 定数追加とスコープ宣言の矛盾

**カテゴリ**: DRY
**場所**: 設計方針書 3.1 z-index体系の統一 / セクション 8 スコープ判定 / セクション 10 変更ファイル一覧

**問題**:
設計方針書のコード例（セクション3.1）では z-index.ts に `MOBILE_HEADER: 40` と `MOBILE_DRAWER: 50` を追加する案が示されている。

```typescript
// 設計方針書のコード例
export const Z_INDEX = {
  DROPDOWN: 10,
  SIDEBAR: 30,
  MOBILE_HEADER: 40,     // 新規
  MOBILE_DRAWER: 50,     // 新規
  MODAL: 50,
  MAXIMIZED_EDITOR: 55,
  TOAST: 60,
  CONTEXT_MENU: 70,
} as const;
```

一方、セクション8のスコープ判定では「z-40/z-50 ハードコード全統一」はスコープ外（別Issue推奨）と明記されており、セクション10の変更ファイル一覧でも z-index.ts の変更は「JSDocコメント修正、MAXIMIZEDEDITORコメント修正」のみとなっている。

定数を定義しても利用箇所（AppShell.tsx, MobileHeader.tsx, MobileTabBar.tsx 等の z-40/z-50）を変更しないなら、未使用定数の追加となり YAGNI 違反となる。

**提案**:
方針を二択で明確化する:
- **(A) 推奨**: MOBILE_HEADER/MOBILE_DRAWER 定数追加をスコープ外とし、コード例から削除。JSDocコメントの修正（9999 -> 50）と MAXIMIZED_EDITOR の位置コメント修正のみに留める。
- **(B)**: 定数追加と同時に利用箇所も統一する。ただし変更範囲が拡大する。

### F002 [should_fix] MODAL と MOBILE_DRAWER の z-index 値重複

**カテゴリ**: DRY
**場所**: 設計方針書 3.1 z-index.ts コード例

**問題**:
`MODAL: 50` と `MOBILE_DRAWER: 50` が同一値となっている。これは意図的な設計である可能性が高いが（モバイルではModalとDrawerが同時表示されないため）、設計方針書にその理由が明記されていない。

**提案**:
F001 の提案(A)で定数追加自体をスコープ外とすれば本問題は解消される。もし定数を追加する場合は、同一値の理由を JSDoc コメントに記載すること。

### F003 [nice_to_have] isInsideScrollableElement の命名と overflowY 限定

**カテゴリ**: KISS
**場所**: 設計方針書 3.3 スワイプ/スクロール分離

**問題**:
関数名 `isInsideScrollableElement` は汎用的だが、実装は overflowY のみを判定する。横スクロール領域（例: コードブロック）での水平スワイプとの干渉は考慮していない。現在の用途（下スワイプ解除の防止）には overflowY のみで十分であるため、機能的な問題はない。

**提案**:
以下のいずれかで意図を明確化する:
- JSDoc コメントに「垂直方向のスクロール可能性のみを判定する」旨を追記
- 関数名を `isInsideVerticallyScrollableElement` に変更

### F004 [nice_to_have] isInsideScrollableElement の配置と SRP

**カテゴリ**: SRP (Single Responsibility)
**場所**: 設計方針書 3.3 useSwipeGesture.ts

**問題**:
DOM ユーティリティ関数である isInsideScrollableElement を useSwipeGesture.ts 内のプライベートヘルパーとして定義する設計が提示されている。SRP の厳密な観点ではフックの責務が広がるが、この関数が現時点で useSwipeGesture からのみ呼ばれることを考慮すると、ファイル分離は KISS に反する。

**提案**:
現在の設計を維持しつつ、コードコメントに「将来他のモジュールからも利用される場合は src/lib/dom-utils.ts 等への抽出を検討」と記載。

### F005 [nice_to_have] SearchBar.tsx の MOBILE_BREAKPOINT 使用と設計根拠

**カテゴリ**: 設計方針
**場所**: 設計方針書 3.2 SearchBar.tsx の修正方針

**問題**:
SearchBar.tsx での `window.innerWidth < 768` を `MOBILE_BREAKPOINT` 定数に置換する方針は適切だが、useIsMobile フックを使用しない理由（autofocus 制御のみの用途でリサイズ追従不要）が設計方針書に明記されていない。

**現在の SearchBar.tsx コード** (L156-166):
```typescript
useEffect(() => {
  const isMobile = window.innerWidth < 768;
  if (!isMobile) {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }
}, []);
```

**提案**:
設計方針書に「マウント時の1回限りの autofocus 制御であり、リサイズ追従は不要」という理由を明記する。

### F006 [nice_to_have] Phase 3 の曖昧な実装範囲

**カテゴリ**: 設計方針
**場所**: 設計方針書 11 実装順序

**問題**:
Phase 3 の AppShell.tsx と WorktreeDesktopLayout.tsx について「必要に応じて」という曖昧な表現があり、実装時に作業範囲が不明確になるリスクがある。

**提案**:
Phase 1 完了後に iPad 横置き（1024px）でのレイアウト確認ステップを挿入し、CSS 調整の要否を判定する基準を定義する。

### F007 [must_fix] Modal.tsx z-index 変更の競合分析不足

**カテゴリ**: 設計方針
**場所**: 設計方針書 3.1 / セクション 10

**問題**:
Modal.tsx の z-index を 9999 から 50 に下げる変更は本設計の中核であり、設計方針書でもリスク「高」と評価している。しかし、以下の競合分析が不足している:

**現在の z-index 状況（実コード調査結果）**:

| コンポーネント | 現在の z-index | 定数/ハードコード |
|--------------|---------------|-----------------|
| MobileHeader.tsx | z-40 | ハードコード |
| MobileTabBar.tsx | z-40 | ハードコード |
| AppShell drawer overlay | z-40 | ハードコード |
| AppShell drawer | z-50 | ハードコード |
| Header.tsx | z-50 | ハードコード |
| Toast | z-50 | ハードコード |
| SlashCommandSelector overlay | z-40 | ハードコード |
| SlashCommandSelector | z-50 | ハードコード |
| ContextMenu | z-50 | ハードコード |
| MobilePromptSheet | z-50 | ハードコード |
| **Modal.tsx** | **z-[9999]** -> **Z_INDEX.MODAL(50)** | **変更対象** |
| MarkdownEditor (maximized) | Z_INDEX.MAXIMIZED_EDITOR(55) | 定数 |
| Toast | Z_INDEX.TOAST(60) | 定数 |
| ContextMenu | Z_INDEX.CONTEXT_MENU(70) | 定数 |

Modal を z-50 に下げると、同一 z-index(50) のコンポーネント（Toast ハードコード z-50、SlashCommandSelector z-50、ContextMenu z-50 など）と同じレイヤーになる。

Modal は `createPortal(... , document.body)` でレンダリングされるため、DOM 順序で後に配置され、実質的に同一 z-index 要素の上に表示される。また、Modal 表示中は `body.style.overflow = 'hidden'` が設定されるため背面要素との操作競合は発生しない。さらに、Z_INDEX.TOAST(60) や Z_INDEX.CONTEXT_MENU(70) は Modal(50) より上であるため、Modal 表示中の Toast 通知は正しく表示される。

**しかしこれらの分析が設計方針書に記載されていない。**

**提案**:
設計方針書に以下を追加する:

1. Modal(Z_INDEX.MODAL=50) 変更後の z-index レイヤー競合分析表
2. Modal が createPortal で document.body に配置されるため、同一 z-index でも DOM 順序で上に表示される根拠
3. body.style.overflow='hidden' による背面要素との操作競合防止の説明
4. Z_INDEX.TOAST(60) > Z_INDEX.MODAL(50) であるため、Modal 表示中の Toast が正しく機能する確認
5. 影響を受ける8つの利用コンポーネントの具体的な列挙

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | Modal z-index 変更による既存 z-50 要素との表示順序競合 | Medium | Low | P1 |
| 技術的リスク | MOBILE_HEADER/MOBILE_DRAWER 未使用定数による混乱 | Low | Medium | P2 |
| 運用リスク | Phase 3 の曖昧なスコープによる作業範囲の膨張 | Low | Medium | P3 |
| セキュリティリスク | z-index 変更によるセキュリティ影響 | Low | Low | - |

---

## 設計原則別 総合評価

| 原則 | 評価 | コメント |
|------|------|---------|
| **SRP** | Good | 各関数・フック・定数モジュールの責務が単一に保たれている |
| **OCP** | Good | useSwipeGesture の options パターン、Z_INDEX の as const パターンが拡張に対して開いている |
| **ISP** | Good | UseSwipeGestureOptions の全プロパティがオプショナルで、不要なコールバック実装を強制しない |
| **DIP** | Good | コンポーネント -> 設定層の依存方向が適切 |
| **KISS** | Good | isInsideScrollableElement のイテレーティブ実装、breakpoint 維持判断が簡潔 |
| **YAGNI** | Conditional | MOBILE_HEADER/MOBILE_DRAWER 定数追加の要否を明確化すべき |
| **DRY** | Conditional | Z_INDEX 定数体系の部分的統一の整合性を改善すべき |

---

## 結論

設計方針書は SOLID 原則に概ね準拠しており、4つの症状を3つのサブタスクに分解するアプローチ、breakpoint 維持の判断、scrollable 要素判定の設計はいずれも適切である。

**条件付き承認**とし、以下の条件を満たした上で実装に進むことを推奨する:

1. **[must_fix]** F007: Modal.tsx z-index 変更の競合分析を設計方針書に追加する
2. **[should_fix]** F001: MOBILE_HEADER/MOBILE_DRAWER 定数追加のスコープを明確化する（推奨: スコープ外とし削除）
3. **[should_fix]** F002: F001 と連動して解消する

---

## レビュー対象ファイル

| ファイル | パス |
|---------|------|
| 設計方針書 | `dev-reports/design/issue-299-ipad-layout-fix-design-policy.md` |
| z-index 定数 | `src/config/z-index.ts` |
| Modal コンポーネント | `src/components/ui/Modal.tsx` |
| スワイプジェスチャーフック | `src/hooks/useSwipeGesture.ts` |
| モバイル判定フック | `src/hooks/useIsMobile.ts` |
| フルスクリーンフック | `src/hooks/useFullscreen.ts` |
| マークダウンエディタ | `src/components/worktree/MarkdownEditor.tsx` |
| 検索バー | `src/components/worktree/SearchBar.tsx` |
| アプリシェル | `src/components/layout/AppShell.tsx` |

---

*Generated by architecture-review-agent for Issue #299 Stage 1*
*Date: 2026-02-18*
