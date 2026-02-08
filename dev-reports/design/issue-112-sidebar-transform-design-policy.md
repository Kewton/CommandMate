# Issue #112 サイドバートグル パフォーマンス改善 設計方針書

## 1. 概要

### 1.1 目的
iPadでサイドバーの表示/非表示を切り替える際の動作遅延（モッサリ感）を改善する。

### 1.2 背景
デスクトップ向けサイドバー（`AppShell.tsx`）が`width`プロパティのCSSトランジションを使用しているため、レイアウト再計算（Reflow）が発生しパフォーマンスが低下している。

### 1.3 スコープ
- デスクトップレイアウトのサイドバーアニメーション方式をwidth方式からtransform方式に変更
- モバイルレイアウトは既にtransform方式のため変更対象外

---

## 2. 現状分析

### 2.1 問題のあるコード

```typescript
// 現状 (AppShell.tsx:86-116) ※デスクトップレイアウト部分
<aside
  data-testid="sidebar-container"
  className={`
    flex-shrink-0 h-full
    transition-all duration-300 ease-out
    ${isOpen ? 'w-72' : 'w-0'}  // ← width変更がReflowを引き起こす
    overflow-hidden
  `}
  role="complementary"
>
  <div className="w-72 h-full">  {/* ← 内部ラッパー（常時w-72固定） */}
    <Sidebar />
  </div>
</aside>
```

### 2.2 原因分析

| 項目 | 現状（デスクトップ/iPad） | モバイル |
|------|--------------------------|----------|
| アニメーション方式 | `width: 0` ↔ `width: 18rem` | `transform: translateX()` |
| レンダリング | レイアウト再計算 (Reflow) | GPUコンポジット |
| パフォーマンス | 重い（CPU負荷） | 軽い（GPU活用） |

---

## 3. 設計方針

### 3.1 採用アプローチ

**オーバーレイ型（推奨）**: サイドバーをposition: fixedで固定し、メインコンテンツのレイアウトに影響を与えない

### 3.2 サイドバー幅のCSS変数管理

> **[MF-001] DRY原則対応**: サイドバー幅をCSS変数で一元管理し、複数箇所での値重複を防ぐ。

サイドバー幅（`w-72` = `18rem`）は複数箇所で参照されるため、以下の方式で一元管理する。

**[SF-S2-003] 現在のハードコード箇所一覧**:
- `AppShell.tsx` line 68: モバイルdrawerの`w-72`
- `AppShell.tsx` line 94: デスクトップasideの`w-72`/`w-0`
- `AppShell.tsx` line 99: デスクトップ内部ラッパーの`w-72`
- `SidebarToggle.tsx` line 42: `left-[284px]`（= `w-72` + 12px = 18rem + 0.75rem）

**[SF-S3-003] CSS変数とTypeScript定数の整合性**:

CSS変数の定義場所は`globals.css`に統一する。SidebarContext.tsxの`DEFAULT_SIDEBAR_WIDTH`定数（line 27）との二重管理を避けるため、以下のいずれかを採用する：

1. **推奨案**: CSS変数を単一のソースオブトゥルースとし、TypeScript定数を削除
2. **代替案**: 両者の値が一致することをユニットテストで保証する

> 実装時にSidebarContext.tsxの`DEFAULT_SIDEBAR_WIDTH`との同期方法を決定すること。

**推奨実装方法**:
```css
/* globals.css */
:root {
  --sidebar-width: 18rem;
}
```

```typescript
// 使用例
<aside className="w-[var(--sidebar-width)] ...">
<main className="pl-[var(--sidebar-width)] ...">
```

**代替案**: Tailwindのカスタムユーティリティとして定義
```javascript
// tailwind.config.js
theme: {
  extend: {
    width: {
      'sidebar': 'var(--sidebar-width)',
    },
    padding: {
      'sidebar': 'var(--sidebar-width)',
    }
  }
}
```

### 3.3 実装イメージ

```typescript
// After (transform方式 - オーバーレイ型)
<aside className={`
  fixed left-0 top-0 h-full w-[var(--sidebar-width)] z-30
  ${isOpen ? 'translate-x-0' : '-translate-x-full'}
  ${SIDEBAR_TRANSITION_CLASSES}
`}>
  <Sidebar />
</aside>

// メインコンテンツ側
<main className={`
  flex-1 min-w-0 h-full overflow-hidden
  ${isOpen ? 'md:pl-[var(--sidebar-width)]' : 'md:pl-0'}
`}>
  {children}
</main>
```

### 3.4 共通トランジションクラスの定数化

> **[SF-004] DRY原則対応**: モバイルとデスクトップで共通のトランジションクラスを定数として切り出す。

```typescript
// AppShell.tsx 上部に定義
const SIDEBAR_TRANSITION_CLASSES = 'transition-transform duration-300 ease-out';
```

これにより、モバイルレイアウト（既存）とデスクトップレイアウト（変更後）でのトランジション設定の重複を解消する。

### 3.5 代替案：プッシュ型（不採用）

> **[SF-003] YAGNI原則対応**: 検討したが不採用とした方式の概要のみ記載。

プッシュ型はサイドバーとメインコンテンツの両方にtransformを適用する方式だが、以下の理由で不採用：
- メインコンテンツにもtransformが必要となり、stacking contextの管理が複雑化する
- オーバーレイ型の方がシンプルで、既存のモバイルレイアウトとの一貫性が高い

---

## 4. 詳細設計

### 4.1 z-index階層管理

**目標階層定義（実装後の`src/config/z-index.ts`）**：
```
DROPDOWN(10) < SIDEBAR(20) [新規追加] < MOBILE_FIXED_UI(30) < MODAL(50) < MAXIMIZED_EDITOR(55) < TOAST(60) < CONTEXT_MENU(70)
```

**[MF-S3-001] z-index競合リスク対応**:

WorktreeDetailRefactored.tsx（line 1552, 1588）でモバイルレイアウトの固定要素（AutoYesToggle, MessageInput）が既にz-30を使用している。iPadがデスクトップレイアウトとして扱われる場合、これらの要素とSIDEBARのz-indexが競合する可能性がある。

**対応方針**:
- SIDEBARのz-indexを`20`に設定（z-30ではなく）
- これにより、モバイル固定要素（z-30）が確実にサイドバーより上に表示される

**z-index.tsへの追加**:
```typescript
export const Z_INDEX = {
  DROPDOWN: 10,
  SIDEBAR: 20,  // デスクトップレイアウト専用 (MF-S3-001: z-30競合回避のため20に設定)
  MODAL: 50,
  MAXIMIZED_EDITOR: 55,
  TOAST: 60,
  CONTEXT_MENU: 70,
} as const;
```

> **[SF-S2-001] 注記**: 現在モバイルレイアウト（AppShell.tsx:58, 68）では`z-40`（overlay）と`z-50`（sidebar drawer）がハードコードされている。将来的にはモバイル用の値も`z-index.ts`で一元管理することを検討する（例: `MOBILE_OVERLAY: 40`, `MOBILE_DRAWER: 50`, `MOBILE_FIXED_UI: 30`）。

> **[SEC-S4-002] セキュリティ観点からのz-index一元管理の重要性**: z-index階層が複雑化すると、意図しない要素の重なりによるクリックジャッキングリスクが高まる。モバイル/デスクトップのz-index値を`z-index.ts`で一元管理することで、UI層の明確化とセキュリティ強化の両方を実現できる。実装優先度は低いが、将来的な課題として認識しておくこと。

### 4.2 SidebarToggle配置方針

> **[SF-002] KISS原則対応**: SidebarToggleをサイドバー内部に配置することで、位置計算ロジックを簡素化する。

**推奨方式**: SidebarToggleをサイドバー内部（右端）に配置する

**現状の実装** (SidebarToggle.tsx:42):
```typescript
// 状態依存の位置切り替え
${isOpen ? 'left-[284px]' : 'left-2'}  // left-[284px] = w-72(18rem) + 12px
```

**変更後の実装**（推奨）:
```typescript
// サイドバー内部に配置し、transformに自動追従
<aside className="fixed left-0 top-0 h-full ...">
  <Sidebar />
  <SidebarToggle className="absolute right-0 top-4 -mr-10" />
</aside>
```

> **[SF-S2-002] 確認**: 上記の現状実装と変更後の実装の対比により、実装時の変更点が明確になっている。

**[SF-S3-004] SidebarToggle使用箇所の確認**:

実装前に以下を確認すること：
1. `grep -r "SidebarToggle" src/`でSidebarToggleの全使用箇所を特定
2. AppShell.tsx以外での使用有無を確認
3. Header.tsx（z-50使用）との相互作用を検証

> SidebarToggleがAppShell外部で使用されている場合、配置変更の影響範囲が広がる可能性がある。

**メリット**:
- サイドバーのtransformに自動追従し、個別の位置計算ロジックが不要
- `left-[284px]/left-2`のような状態依存の位置切り替えを削除可能
- シンプルで保守しやすい実装

### 4.3 CSSトランジション最適化

- `transition-all` → `transition-transform`に変更
- `<main>`要素のpadding変更はトランジションなし（即座に切り替え）で実装
  - これによりサイドバーのtransformアニメーションのみで視覚的な遷移を実現
  - padding変更にトランジションを適用するとwidth方式と同様のReflow問題が発生する可能性があるため

**[MF-S3-002] padding-left変更の視覚的影響への考慮**:

サイドバーがtransformでスライドアウトする間にメインコンテンツのpadding-leftが即座に変わると、コンテンツが突然ジャンプして見え、UXが低下する恐れがある。特にiPad横向きでサイドバートグル時に顕著になる可能性がある。

**検討すべき代替案**:
1. main要素にも`transition-[padding-left]`を追加（ただしパフォーマンス影響を計測すること）
2. paddingではなくmarginを使用
3. メインコンテンツを固定幅にせずflexで自動調整

> **実装前にiPad実機でのプロトタイプ検証を強く推奨する。**視覚的ジャンプが顕著な場合は上記代替案のいずれかを採用すること。

**[SF-S2-004] 現状mainタグのクリーンアップ項目**:

現在の`AppShell.tsx`(line 108-109)には以下の問題があり、transform方式への変更時にクリーンアップする：
1. `transition-all duration-300 ease-out`が適用されている（不要なトランジション）
2. `${isOpen ? 'ml-0' : 'ml-0'}`の条件分岐が機能していない（両方とも`ml-0`を返す無意味なコード）

これらは設計変更時に削除し、必要に応じて`padding-left`による余白制御に置き換える。

### 4.4 アクセシビリティ

- `role="complementary"`は維持
- サイドバー閉じ時に`aria-hidden="true"`を追加

**[SEC-S4-001] aria-hiddenとフォーカス管理の連動**:

`aria-hidden="true"`を設定する際、内部のインタラクティブ要素へのフォーカス管理も連動させる必要がある。スクリーンリーダーとキーボードナビゲーションの整合性を確保するため、以下のいずれかの方式を実装すること：

1. **推奨案**: `inert`属性を使用（aria-hiddenとフォーカス無効化を一括で処理）
   ```typescript
   <aside inert={!isOpen} ...>
   ```
2. **代替案**: サイドバー閉じ時に内部のインタラクティブ要素に`tabindex="-1"`を設定
   ```typescript
   <button tabIndex={isOpen ? 0 : -1} ...>
   ```

> `inert`属性はモダンブラウザでサポートされており、aria-hiddenとtabindex管理を一括で行えるため推奨。ただし、古いブラウザサポートが必要な場合は代替案を採用すること。

### 4.5 将来的な拡張性についての注記

> **[SF-001] SRP考慮事項**: 現状の規模では過度な分離は不要だが、将来的な拡張時に検討すべき事項を記載。

AppShell.tsxがモバイルレイアウトとデスクトップレイアウトの両方を条件分岐で処理している。transform方式への変更後、ロジックが複雑化した場合は以下の分離を検討する：
- `MobileLayout.tsx`: モバイル専用レイアウト
- `DesktopLayout.tsx`: デスクトップ専用レイアウト

現時点では分離の必要性は低いが、条件分岐が増加した場合に検討すること。

---

## 5. 影響範囲

### 5.1 直接変更対象

| ファイル | 変更内容 |
|---------|---------|
| `src/components/layout/AppShell.tsx` | width方式からtransform方式に変更、CSS変数使用 |
| `src/config/z-index.ts` | SIDEBAR定数を追加（z-20） |
| `src/app/globals.css` または `tailwind.config.js` | `--sidebar-width`変数を定義 |

### 5.2 テスト更新必須

| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/components/layout/AppShell.test.tsx` | `w-72`/`w-0` → `translate-x-0`/`-translate-x-full`に変更 |

**[MF-S2-002] 影響を受けるテストケース詳細**:
- `'should start with sidebar open on desktop by default'` (line 281): `w-72`チェックを`translate-x-0`に変更
- `'should render with custom initial state'` (line 302): `w-0`チェックを`-translate-x-full`に変更

**[SF-S3-001] 追加テストケース要件**:

以下のテストケースを新規追加すること：
1. サイドバー閉じ時の`aria-hidden="true"`属性の存在確認
2. SidebarToggle配置変更後の位置・クリック動作検証
3. `transform`/`transition-transform`クラスの存在確認
4. CSS変数`var(--sidebar-width)`を使用したクラスの検証

> `tests/unit/components/layout/SidebarToggle.test.tsx`の存在確認を行い、存在しない場合は新規作成を検討すること。

### 5.3 確認・調整必要

| ファイル | 確認内容 |
|---------|---------|
| `src/components/layout/SidebarToggle.tsx` | サイドバー内部配置への変更を検討 |
| `src/contexts/SidebarContext.tsx` | `DEFAULT_SIDEBAR_WIDTH`定数とCSS変数の同期確認 |
| `src/components/layout/Header.tsx` | z-50使用箇所との相互作用確認 |

### 5.4 E2Eテスト要件

**[SF-S3-002] E2Eテストギャップ対応**:

現在のE2Eテスト（`tests/e2e/worktree-detail.spec.ts`）にはデスクトップレイアウトでのサイドバートグル動作のテストが存在しない。以下のE2Eテストを追加することを推奨：

1. iPadビューポート（1024x768）でのサイドバートグル動作確認
2. トグル後のメインコンテンツ領域のレイアウト確認
3. サイドバー開閉時のアニメーション完了確認

> Visual Regression Testingの導入も将来的に検討すること。

### 5.5 影響なし

- `src/components/layout/Sidebar.tsx`
- `src/hooks/useSidebar.ts`

---

## 6. 実装チェックリスト

### 6.1 レビュー指摘対応（Stage 1-2）

- [ ] **[MF-001]** CSS変数`--sidebar-width`を定義し、サイドバー幅を一元管理する
- [ ] **[SF-002]** SidebarToggleをサイドバー内部に配置する方式を採用する
- [ ] **[SF-004]** `SIDEBAR_TRANSITION_CLASSES`定数を定義し、トランジションクラスの重複を解消する

### 6.2 レビュー指摘対応（Stage 3: 影響分析）

- [ ] **[MF-S3-001]** z-index競合対応: SIDEBARのz-indexを20に設定（z-30ではなく）
- [ ] **[MF-S3-002]** padding-left視覚的ジャンプ: iPad実機でプロトタイプ検証を実施し、必要に応じて代替案を採用
- [ ] **[SF-S3-001]** テストカバレッジ: aria-hidden、SidebarToggle、transform関連のテストケースを追加
- [ ] **[SF-S3-002]** E2Eテスト: iPadビューポートでのサイドバートグルテストを追加（または将来課題として記録）
- [ ] **[SF-S3-003]** CSS変数統合: globals.cssに定義し、SidebarContext.tsxとの同期方法を決定
- [ ] **[SF-S3-004]** SidebarToggle使用箇所: grepで全使用箇所を特定し、影響範囲を確認

### 6.3 機能要件
- [ ] サイドバートグル時にスムーズなアニメーションが実現される
- [ ] iPadでモッサリ感が解消される
- [ ] デスクトップPCで既存動作に問題がない
- [ ] モバイル表示に影響がない

### 6.4 品質要件
- [ ] ESLint/TypeScriptチェックがパスする
- [ ] AppShell.test.tsxのテストが更新され、パスする
- [ ] z-index階層管理にSIDEBAR定数が追加される
- [ ] SidebarToggle.test.tsxの存在確認と必要に応じた更新

### 6.5 アクセシビリティ要件
- [ ] `role="complementary"`が維持される
- [ ] サイドバー閉じ時に`aria-hidden="true"`の追加
- [ ] **[SEC-S4-001]** aria-hidden使用時のフォーカス管理: `inert`属性または`tabindex="-1"`でフォーカス制御を連動させる

### 6.6 セキュリティ要件（Stage 4）
- [ ] **[SEC-S4-002]** z-index一元管理の将来課題として記録（実装は任意だが認識は必須）

---

## 7. 関連Issue

- Issue #104（iPad フルスクリーン対応）の調査中に発見
- Issue #99（マークダウンエディタ表示機能改善）のz-index管理との整合性確認

---

## 8. レビュー履歴

| 日付 | ステージ | レビュー種別 | 結果 |
|------|---------|-------------|------|
| 2026-02-01 | Stage 1 | 通常レビュー（設計原則） | 指摘事項反映済 |
| 2026-02-01 | Stage 2 | 整合性レビュー | 指摘事項反映済 |
| 2026-02-01 | Stage 3 | 影響分析レビュー | 指摘事項反映済 |
| 2026-02-01 | Stage 4 | セキュリティレビュー | 指摘事項反映済 |

---

## 9. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（2026-02-01）

| ID | カテゴリ | 重要度 | 内容 | 対応状況 |
|----|---------|--------|------|----------|
| MF-001 | DRY原則 | Must Fix | サイドバー幅の重複定義をCSS変数で一元管理 | 3.2項、6.1項に反映 |
| SF-001 | SRP | Should Fix | 将来的なレイアウトコンポーネント分離の検討 | 4.5項に注記追加 |
| SF-002 | KISS原則 | Should Fix | SidebarToggleをサイドバー内部に配置 | 4.2項に推奨方式として記載 |
| SF-003 | YAGNI原則 | Should Fix | 代替案（プッシュ型）の詳細コード削除 | 3.5項を簡潔化 |
| SF-004 | DRY原則 | Should Fix | トランジションクラスの定数化 | 3.4項に追加 |

### Stage 2: 整合性レビュー（2026-02-01）

| ID | カテゴリ | 重要度 | 内容 | 対応状況 |
|----|---------|--------|------|----------|
| MF-S2-001 | 設計書の記述誤り | Must Fix | 行番号89-102を実際のコード(86-116)に修正 | 2.1項に反映 |
| MF-S2-002 | テスト更新計画の不備 | Must Fix | テストケース名と行番号を詳細化 | 5.2項に反映 |
| SF-S2-001 | z-index階層の整合性 | Should Fix | モバイルz-index値の一元管理検討を注記 | 4.1項に反映 |
| SF-S2-002 | SidebarToggle配置方針の整合性 | Should Fix | 現状と変更後の実装対比を明確化 | 4.2項に反映 |
| SF-S2-003 | CSS変数の現状確認 | Should Fix | ハードコード箇所を網羅的にリストアップ | 3.2項に反映 |
| SF-S2-004 | mainタグの現状実装との差異 | Should Fix | 無意味な条件分岐とtransition-allをクリーンアップ項目として明記 | 4.3項に反映 |

### Stage 3: 影響分析レビュー（2026-02-01）

| ID | カテゴリ | 重要度 | 内容 | 対応状況 |
|----|---------|--------|------|----------|
| MF-S3-001 | z-index競合リスク | Must Fix | WorktreeDetailRefactored.tsxのz-30との競合回避（SIDEBAR: 20に変更） | 4.1項に反映、6.2項にチェックリスト追加 |
| MF-S3-002 | padding-left変更の視覚的影響 | Must Fix | コンテンツジャンプのリスクとプロトタイプ検証の必要性を明記 | 4.3項に反映、6.2項にチェックリスト追加 |
| SF-S3-001 | テストカバレッジ不足 | Should Fix | aria-hidden、SidebarToggle、transform関連テスト追加要件 | 5.2項に反映、6.2項にチェックリスト追加 |
| SF-S3-002 | E2Eテスト影響 | Should Fix | iPadビューポートでのサイドバーテスト追加推奨 | 5.4項に新規追加、6.2項にチェックリスト追加 |
| SF-S3-003 | CSS変数の段階的導入 | Should Fix | globals.css統一とSidebarContext.tsxとの同期方法明確化 | 3.2項に反映、6.2項にチェックリスト追加 |
| SF-S3-004 | SidebarToggle配置変更の波及影響 | Should Fix | 使用箇所特定の確認要件を追加 | 4.2項に反映、6.2項にチェックリスト追加 |

### Stage 4: セキュリティレビュー（2026-02-01）

**総合評価**: セキュリティリスクは**最小限**。CSS/レイアウトのパフォーマンス改善が主目的であり、OWASP Top 10の脆弱性カテゴリには該当しない。

| ID | カテゴリ | 重要度 | 内容 | 対応状況 |
|----|---------|--------|------|----------|
| SEC-S4-001 | アクセシビリティセキュリティ | Should Fix | aria-hidden使用時のフォーカス管理連動（inert属性またはtabindex=-1） | 4.4項に反映、6.5項にチェックリスト追加 |
| SEC-S4-002 | クリックジャッキング防御 | Should Fix | z-index一元管理の将来課題認識（モバイル値のz-index.ts統合） | 4.1項に注記追加、6.6項にチェックリスト追加 |
| SEC-S4-003 | CSS変数インジェクション | Nice to Have | CSS変数はコード内固定値のみ使用、ユーザー入力からの設定禁止 | 現時点で問題なし（将来的なガイドライン検討） |
| SEC-S4-004 | localStorage使用 | Nice to Have | 既存のlocalStorage使用は非機密データのみ、Issue #112で新規使用なし | 現時点で問題なし |

**セキュリティ評価サマリー**:
- XSSリスク: なし（動的コンテンツレンダリングなし）
- CSSインジェクションリスク: なし（CSS変数は固定値）
- クリックジャッキングリスク: 低（z-index階層管理が設計書に明記済み）
- クライアント状態操作リスク: なし（状態管理の仕組みに変更なし）

---

*Created: 2026-02-01*
*Last Updated: 2026-02-01 (Stage 4 Security Review Applied)*
