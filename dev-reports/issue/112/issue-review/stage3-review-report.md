# Issue #112 影響範囲レビュー報告書

## 基本情報

| 項目 | 内容 |
|------|------|
| Issue番号 | #112 |
| タイトル | perf: サイドバートグルのパフォーマンス改善（transform方式への変更） |
| レビューステージ | Stage 3: 影響範囲レビュー（1回目） |
| レビュー日 | 2026-02-01 |
| レビュー担当 | issue-review-agent |

---

## 1. 変更概要

Issue #112は、iPadでサイドバーの表示/非表示切り替え時の「モッサリ感」を解消するため、CSSアニメーション方式を`width`から`transform`に変更するパフォーマンス改善である。

### 現状の問題点

```typescript
// 現状 (AppShell.tsx L89-102)
<aside className={`${isOpen ? 'w-72' : 'w-0'} transition-all ...`}>
```

- `width`プロパティの変更はブラウザのReflow（レイアウト再計算）を発生させる
- iPadは画面が広く要素数が多いため、Reflowの影響が顕著
- `transition-all`は全プロパティを監視するためオーバーヘッドが大きい

### 提案される解決策

```typescript
// After (transform方式)
<aside className={`${isOpen ? 'translate-x-0' : '-translate-x-full'} transition-transform ...`}>
```

- `transform`はGPUコンポジットで処理されるためCPU負荷が低い
- モバイルレイアウトでは既にこの方式を採用済み

---

## 2. 影響範囲分析

### 2.1 直接的な影響

| ファイル | 影響度 | 説明 |
|---------|--------|------|
| `src/components/layout/AppShell.tsx` | 高 | 主な変更対象。デスクトップレイアウト部分の修正 |
| `tests/unit/components/layout/AppShell.test.tsx` | 高 | テストケースの更新必須（w-72/w-0 -> translate-x系） |
| `src/components/layout/SidebarToggle.tsx` | 中 | ボタン位置（left-[284px]）の確認・調整が必要 |
| `src/config/z-index.ts` | 中 | SIDEBAR定数の追加推奨 |

### 2.2 間接的な影響

| ファイル | 影響度 | 説明 |
|---------|--------|------|
| `tests/unit/components/layout/SidebarToggle.test.tsx` | 低 | 位置関連テストがあれば確認 |
| `tests/e2e/worktree-detail.spec.ts` | 低 | サイドバー関連E2Eテストの動作確認 |

### 2.3 影響なし

| ファイル | 理由 |
|---------|------|
| `src/contexts/SidebarContext.tsx` | 状態管理のみ、表示ロジックなし |
| `src/components/layout/Sidebar.tsx` | 内部コンポーネント、AppShellからは独立 |
| `src/hooks/useSidebar.ts` | フックの実装変更なし |
| モバイルレイアウト | 既にtransform方式で実装済み |

---

## 3. 発見事項

### 3.1 必須修正 (Must Fix)

#### MUST-001: テストケースの更新

**問題**: `AppShell.test.tsx`のL281, L302で`w-72`/`w-0`クラスの存在をチェックしている。

```typescript
// 現状のテスト
expect(sidebarContainer.className).toMatch(/w-72/);
expect(sidebarContainer.className).toMatch(/w-0/);
```

**対策**: `translate-x-0`/`-translate-x-full`のチェックに更新する。

---

#### MUST-002: SidebarToggleの位置計算

**問題**: `SidebarToggle.tsx`のL42でボタン位置を`left-[284px]`/`left-2`で制御している。

```typescript
${isOpen ? 'left-[284px]' : 'left-2'}
```

サイドバーがfixed/absolute配置になった場合、この位置計算が機能しなくなる可能性がある。

**対策**:
- オーバーレイ型: SidebarToggleをサイドバー内部に配置するか、fixed配置に変更
- プッシュ型: 現状維持可能だが、メインコンテンツのtransformに影響されないよう注意

---

#### MUST-003: z-index階層管理

**問題**: 提案コードで`z-30`を使用しているが、`src/config/z-index.ts`に定義がない。

現在の階層:
```
DROPDOWN: 10
MODAL: 50
MAXIMIZED_EDITOR: 55
TOAST: 60
CONTEXT_MENU: 70
```

また、`WorktreeDetailRefactored.tsx`（L1552, L1588）で既に`z-30`が使用されており、重複の可能性がある。

**対策**: `z-index.ts`に`SIDEBAR`定数を追加し、一元管理を維持する。

---

### 3.2 推奨修正 (Should Fix)

#### SHOULD-001: レイアウト方式の明確化

オーバーレイ型かプッシュ型か、実装方式を明確に決定する必要がある。

| 方式 | メリット | デメリット |
|------|---------|-----------|
| オーバーレイ型 | メインコンテンツのReflowなし | サイドバーがコンテンツに被る |
| プッシュ型 | デスクトップUXを維持 | メインコンテンツのtransformが必要 |

#### SHOULD-002: 不要なtransition削除

`main`要素（L105-114）の`transition-all`は現在使用されていない（ml-0で変化なし）。削除してパフォーマンス向上。

#### SHOULD-003: モバイル互換性確認

isMobileの判定ポイント（768px）前後でのレイアウト遷移を確認。iPadはuseIsMobileでfalseを返すことを担保。

#### SHOULD-004: アクセシビリティ

サイドバーがfixed配置になると、フォーカス管理に影響する可能性がある。閉じている時は`aria-hidden='true'`を検討。

---

### 3.3 改善提案 (Nice to Have)

#### NICE-001: GPUアクセラレーション強化

`will-change-transform`クラスを追加してGPU活用を最大化。

#### NICE-002: 将来拡張への備え

SidebarContextの`width`/`setWidth`機能は維持し、将来のリサイズ機能用途をコメントで明記。

#### NICE-003: DOM構造の簡素化

内部ラッパー（L99）はtransform方式では不要。削除してレンダリング効率向上。

---

## 4. 依存関係分析

### 直接依存

```
AppShell.tsx
  |-- SidebarProvider/useSidebarContext (isOpen状態)
  |-- useIsMobile (レイアウト分岐)
  |-- Sidebar.tsx (子コンポーネント)
```

### 間接依存（z-index競合確認）

| コンポーネント | z-index | 確認事項 |
|---------------|---------|---------|
| WorktreeDetailRefactored | z-30 | 提案と同じ値、競合確認必要 |
| Header | z-50 | サイドバーより上層、問題なし |
| MobileHeader | z-40 | サイドバーより上層、問題なし |
| Modal | z-50 | サイドバーより上層、問題なし |
| Toast | z-50 | サイドバーより上層、問題なし |
| ContextMenu | z-50 | サイドバーより上層、問題なし |

---

## 5. 破壊的変更リスク

| 観点 | リスク | 詳細 |
|------|--------|------|
| ユーザー向けAPI | なし | props変更なし |
| 外部コンポーネント | なし | 内部実装の変更のみ |
| テストコード | あり | AppShell.test.tsxの更新必須 |
| 既存機能 | なし | 動作は同等（パフォーマンス向上のみ） |

---

## 6. テスト影響

### 更新が必要なテスト

1. **AppShell.test.tsx**
   - `Initial Sidebar State` セクションの2つのテスト
   - `w-72`/`w-0` チェック -> `translate-x-0`/`-translate-x-full` チェック

2. **SidebarToggle.test.tsx**
   - 位置関連のテストがある場合は確認

### 追加推奨テスト

1. transform適用確認テスト
2. GPUアクセラレーション有効確認（Performance API）

---

## 7. 結論

Issue #112は影響範囲が限定的で、破壊的変更リスクは低い。主な修正対象は`AppShell.tsx`とそのテストファイルのみ。ただし、以下の3点は実装前に確認・決定が必要:

1. **オーバーレイ型 vs プッシュ型**: どちらの実装方式を採用するか
2. **z-index階層**: SIDEBAR定数の値と既存z-30との競合回避
3. **SidebarToggle位置**: transform方式での位置制御方法

これらが明確になれば、実装リスクは低く、期待されるパフォーマンス向上が見込める。

---

## 8. チェックリスト

- [x] コードの影響範囲（直接的・間接的）を分析
- [x] テストへの影響を特定
- [x] 関連機能への影響を確認
- [x] 依存コンポーネントへの影響を確認
- [x] 既存機能の破壊的変更リスクを評価
- [x] z-index階層管理との整合性を確認
- [x] モバイル互換性を確認
