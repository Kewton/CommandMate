# Issue #548 仮説検証レポート

## 検証日時
- 2026-03-27

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | スマホ版でファイル一覧がすべて表示されない | Confirmed | mainコンテナの二重パディングとoverflow-hiddenが原因 |

## 詳細検証

### 仮説 1: ファイル一覧がすべて表示されない

**Issue内の記述**: スクリーンショットのみ（テンプレート未記入）

**検証手順**:
1. `WorktreeDetailRefactored.tsx` のモバイルレイアウト構造を確認
2. `WorktreeDetailSubComponents.tsx` のMobileContentコンポーネントを確認
3. `FileTreeView.tsx` のスクロール関連CSS確認
4. モバイル固定要素（MobileTabBar, MessageInput）の配置確認

**判定**: Confirmed

**根拠**:

#### CRITICAL #1: mainコンテナの二重パディング
`WorktreeDetailRefactored.tsx:1761-1765`:
```tsx
<main
  className="flex-1 pb-32 overflow-hidden"  // pb-32 = 128px
  style={{
    paddingBottom: 'calc(8rem + env(safe-area-inset-bottom, 0px))',  // さらに128px+
  }}
>
```
- Tailwind `pb-32`（128px）とインラインスタイル `8rem`（128px）が重複
- 合計256px以上のパディングがFileTreeViewの表示領域を圧迫

#### CRITICAL #2: overflow-hiddenによるスクロール不可
- mainに `overflow-hidden` が設定されている
- FileTreeView内部の `overflow-auto` が親のoverflow-hiddenに制約される
- ファイルツリーが折り返し表示不可、スクロールできない

#### 空間配分分析（iPhone 12: 844px高さ想定）
```
MobileHeader:     ~56px (固定)
CLI Tool Tabs:    ~52px
SearchBar:        ~80px
FileTreeView:     ???px (256px+のパディングで大幅に縮小)
MessageInput:     ~52px (固定)
MobileTabBar:     ~64px (固定)
合計固定領域:     ~560px → FileTreeViewは約280pxしかない
```

**Issueへの影響**: Issue本文にバグの詳細（再現手順、期待動作、実際動作、原因分析）を追記すべき

---

## Stage 1レビューへの申し送り事項

- Issue本文がテンプレート未記入状態のため、調査結果に基づいて詳細を補完する必要がある
- 根本原因は2つ: 二重パディングとoverflow-hidden
- 影響ファイル: `WorktreeDetailRefactored.tsx`, `WorktreeDetailSubComponents.tsx`
