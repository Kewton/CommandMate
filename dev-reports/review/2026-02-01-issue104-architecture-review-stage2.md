# Issue #104 整合性レビュー報告書

**レビュー日**: 2026-02-01
**ステージ**: 2（整合性レビュー）
**対象**: iPad全画面表示バグ修正 設計方針書
**設計書**: `dev-reports/design/issue-104-ipad-fullscreen-bugfix-design-policy.md`
**スコア**: A-

---

## 1. レビュー概要

Issue #104の設計方針書について、以下の観点で整合性レビューを実施した。

- 行番号の正確性
- 変数名・関数名の一致
- z-index値の一致
- Issue #99設計書との整合性

---

## 2. 整合性チェック結果

| 項目 | 結果 | 備考 |
|------|------|------|
| 行番号 | pass | L436-441は正確 |
| 変数名 | pass | 全て一致 |
| z-index値 | partial | Issue #99設計書との不整合あり |
| 設計書参照 | partial | Issue #99設計書の値が古い |

---

## 3. 検証済み項目

### 3.1 行番号の正確性

設計書で参照されている`src/components/worktree/MarkdownEditor.tsx`のL436-441は、実装と完全一致。

**設計書の記載**:
```typescript
const containerStyle = useMemo(() => {
  if (isMaximized && isFallbackMode) {  // <- 両方trueが必要
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized, isFallbackMode]);
```

**実装（L436-441）**:
```typescript
const containerStyle = useMemo(() => {
  if (isMaximized && isFallbackMode) {
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized, isFallbackMode]);
```

### 3.2 変数名・関数名

| 名前 | 設計書 | 実装 | 結果 |
|------|--------|------|------|
| `containerStyle` | L436 | L436 | 一致 |
| `isMaximized` | 使用 | `useFullscreen`から取得 | 一致 |
| `isFallbackMode` | 使用 | `useFullscreen`から取得 | 一致 |
| `Z_INDEX.MAXIMIZED_EDITOR` | 使用 | `@/config/z-index`から取得 | 一致 |

### 3.3 z-index値

| 定数 | 設計書#104 | 設計書#99 | 実装 | 備考 |
|------|-----------|-----------|------|------|
| MAXIMIZED_EDITOR | 40 | 9999 | 40 | #99設計書が古い |
| MODAL | 50 | 200 | 50 | #99設計書が古い |
| TOAST | 60 | 300 | 60 | #99設計書が古い |
| CONTEXT_MENU | 70 | 400 | 70 | #99設計書が古い |
| DROPDOWN | - | 100 | 10 | #99設計書が古い |

**結論**: Issue #104設計書は実装の正しい値（40）を参照している。Issue #99設計書のz-index値は実装時に変更されたが、設計書が更新されていない。

---

## 4. 指摘事項

### 4.1 修正推奨（should_fix）

#### SF-001: Issue #99設計書のz-index値が実装と不整合

**場所**: `dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md` セクション4.2

**内容**:
Issue #99設計書のセクション4.2では以下のように記載されている：

```typescript
export const Z_INDEX = {
  DROPDOWN: 100,
  MODAL: 200,
  TOAST: 300,
  CONTEXT_MENU: 400,
  MAXIMIZED_EDITOR: 9999, // 最上位
} as const;
```

しかし、実際の実装（`src/config/z-index.ts`）では：

```typescript
export const Z_INDEX = {
  DROPDOWN: 10,
  MAXIMIZED_EDITOR: 40,
  MODAL: 50,
  TOAST: 60,
  CONTEXT_MENU: 70,
} as const;
```

**推奨対応**:
- Issue #99設計書のz-index値を実装に合わせて更新
- または、変更経緯を「レビュー履歴」セクションに追記

### 4.2 改善提案（nice_to_have）

#### NTH-001: containerClasses条件との差異の明示

**場所**: `dev-reports/design/issue-104-ipad-fullscreen-bugfix-design-policy.md` セクション2.1

**内容**:
`containerClasses`（L424-433）も`isMaximized && isFallbackMode`の条件を持つ：

```typescript
const containerClasses = useMemo(() => {
  const base = 'flex flex-col bg-white';

  if (isMaximized && isFallbackMode) {
    // CSS fallback for fullscreen (iOS Safari, etc.)
    return `${base} fixed inset-0`;
  }

  return `${base} h-full`;
}, [isMaximized, isFallbackMode]);
```

**推奨対応**:
設計書のセクション2.2「問題のメカニズム」に、`containerClasses`と`containerStyle`が同じ条件を共有していることを明示すると、修正方針の影響範囲が明確になる。

---

## 5. 肯定的評価

| ID | 内容 |
|----|------|
| PF-001 | 設計書の行番号参照（L436-441）が実装と完全一致 |
| PF-002 | z-index階層設計が明確に文書化されており、競合リスクが適切に評価されている |
| PF-003 | 修正方針（isFallbackMode条件の削除）は最小限の変更で問題を解決する設計 |
| PF-004 | Issue #99設計書との関連性が明示されており、トレーサビリティが確保されている |

---

## 6. 結論

Issue #104設計方針書は実装との整合性が高く、スコア**A-**と評価する。

**主な評価ポイント**:
- 行番号、変数名、z-index値は全て正確に記載されている
- 問題箇所の特定が正確で、修正方針が明確
- 影響範囲の分析が適切

**注意点**:
- 参照元のIssue #99設計書にz-index値の不整合がある（設計書9999 vs 実装40）
- これはIssue #104の問題ではなく、Issue #99設計書の更新漏れ

**実装への推奨**:
Issue #104の修正方針自体は妥当であり、実装に進めて問題ない。Issue #99設計書の更新は別途対応を推奨する。

---

*レビュー実施者: Architecture Review Agent*
*生成日時: 2026-02-01*
