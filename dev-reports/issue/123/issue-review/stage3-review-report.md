# Issue #123 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-04
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 4 |
| Nice to Have | 3 |

**総合評価**: Issue #123の影響範囲は限定的で、主な変更は`FileTreeView.tsx`（TreeNodeコンポーネント）と`useContextMenu.ts`に集中しています。参照実装が複数存在し、実装パターンは確立されています。

---

## 影響範囲分析

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/components/worktree/FileTreeView.tsx` | TreeNodeにタッチイベントハンドラを追加 |
| `src/hooks/useContextMenu.ts` | openMenu関数の型をTouchEvent対応に拡張 |
| `src/types/markdown-editor.ts` | 変更なし（確認のみ） |

### 影響を受けるコンポーネント

- **FileTreeView**: 主要な変更対象
- **TreeNode**: タッチイベントハンドラの追加
- **useContextMenu**: 型定義の拡張
- **ContextMenu**: 変更なし（既存の呼び出し元として確認）

### 依存関係

```
WorktreeDetailRefactored.tsx
    └── FileTreeView.tsx  <-- 変更対象
            ├── useContextMenu.ts  <-- 変更対象
            └── ContextMenu.tsx
```

### 参照実装

1. **PaneResizer.tsx** (行133-178, 219-239)
   - タッチドラッグ操作の実装
   - `handleTouchStart`, `handleTouchMove`, `handleDragEnd`パターン
   - useEffectでのイベントリスナークリーンアップ

2. **MobilePromptSheet.tsx** (行82-110)
   - スワイプ操作の実装
   - `touchStartY`, `translateY`による状態管理

---

## テスト影響

### 既存テストファイル

| ファイル | 現状 | 必要な追加 |
|---------|------|-----------|
| `tests/unit/components/worktree/FileTreeView.test.tsx` | マウスイベントのみ | タッチイベントテスト追加 |
| `tests/unit/hooks/useContextMenu.test.ts` | MouseEventのみ | TouchEventテスト追加 |
| `tests/unit/components/ContextMenu.test.tsx` | 変更不要 | - |

### 追加が必要なテストケース

**FileTreeView.test.tsx**:
- 長押し（500ms）でコンテキストメニューが表示される
- 10px以上移動でメニューがキャンセルされる
- タッチキャンセル時にタイマーがクリアされる

**useContextMenu.test.ts**:
- React.TouchEventでopenMenuを呼び出せる
- タッチ座標からメニュー位置が正しく設定される

---

## パフォーマンス影響

**評価**: 軽微

- タッチイベントハンドラ追加による影響は最小限
- useCallback/useRefでハンドラを最適化することで再レンダリングを回避可能
- 500msタイマーはuseRefで管理することでパフォーマンス問題を回避

---

## セキュリティ影響

**評価**: なし

- タッチイベント処理自体にセキュリティリスクはない
- 既存のcontextMenuハンドラを再利用するため、新たな脆弱性は生じない

---

## Should Fix（推奨対応）

### SF-001: タッチイベントのテストケース明記

**カテゴリ**: テスト影響
**場所**: 受け入れ条件 セクション

**問題**:
受け入れ条件にタッチイベント関連のユニットテスト追加が明記されていない。

**証拠**:
既存テストファイルにはタッチイベントのテストが存在しない。

**推奨対応**:
受け入れ条件に以下を追加:
```markdown
- [ ] タッチイベント関連のユニットテストが追加されている
```

---

### SF-002: 型定義への影響確認の明記

**カテゴリ**: 依存関係
**場所**: ## 解決方針 > ### 3. 型定義の拡張 セクション

**問題**:
useContextMenuの型拡張がContextMenuState型に影響しないことが明記されていない。

**証拠**:
`src/types/markdown-editor.ts:168-177`にContextMenuState型が定義されている。

**推奨対応**:
以下を明記:
```markdown
**注記**: ContextMenuState型（src/types/markdown-editor.ts）は変更不要。
position: { x: number; y: number }はタッチイベントでも同じ座標系を使用するため。
```

---

### SF-003: 他のタッチ実装との整合性検討

**カテゴリ**: 整合性
**場所**: ## 参照実装 セクション

**問題**:
MobilePromptSheetにもタッチイベント実装があるが、整合性検討の記載がない。

**証拠**:
`src/components/mobile/MobilePromptSheet.tsx:82-110`に`handleTouchStart/Move/End`の実装がある。

**推奨対応**:
参照実装セクションに追加:
```markdown
**MobilePromptSheet.tsx** (行82-110):
- スワイプ操作のパターン（長押しとは異なるが状態管理パターンは参考）
- touchStartY, translateYによる状態管理
```

---

### SF-004: TreeNode変更箇所の具体化

**カテゴリ**: 完全性
**場所**: ## 該当コード セクション

**問題**:
TreeNodeコンポーネントの具体的な変更箇所が記載されていない。

**証拠**:
`FileTreeView.tsx:302`に`onContextMenu`のみ実装されている。

**推奨対応**:
以下を追記:
```markdown
### TreeNodeコンポーネントの変更箇所
- TreeNodeProps（行59-76）: タッチイベントハンドラpropsの追加
- TreeNode内div要素（行292-302）: onTouchStart/End/Move/Cancelの追加
```

---

## Nice to Have（あれば良い）

### NTH-001: CLAUDE.md更新の言及

実装完了後にCLAUDE.mdの「最近の実装機能」セクションにタッチ対応の記載を追加することを検討。

---

### NTH-002: タイマーのメモリリーク防止策明記

setTimeoutのクリーンアップ処理（useEffectのcleanup関数）の実装を明記することを推奨。

**参照**: `PaneResizer.tsx:231-238`でクリーンアップ処理が実装されている。

---

### NTH-003: 触覚フィードバックの考慮

長押し検出時のvibration APIによるフィードバックは将来の拡張として検討可能。スコープ外として明記してもよい。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/FileTreeView.tsx` | 主要な変更対象（行59, 69, 281, 302） |
| `src/hooks/useContextMenu.ts` | 型拡張対象（行35, 39, 85, 86） |
| `src/components/worktree/PaneResizer.tsx` | 参照実装（行133, 161, 176, 219） |
| `src/components/mobile/MobilePromptSheet.tsx` | 整合性確認用（行82, 89, 104） |
| `src/types/markdown-editor.ts` | 型定義確認用（行168, 177） |

### テスト

| ファイル | 関連性 |
|---------|--------|
| `tests/unit/components/worktree/FileTreeView.test.tsx` | タッチテスト追加必要 |
| `tests/unit/hooks/useContextMenu.test.ts` | TouchEventテスト追加必要 |
| `tests/unit/components/ContextMenu.test.tsx` | 変更不要 |
