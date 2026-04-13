# Issue #651 作業計画

## Issue概要

PC版サイドバーをコンパクト化（288px → 224px）し、ブランチ詳細情報をCSSカスタムツールチップで表示する。ツリー表示時はリポジトリ名を省略してコンパクト化を補完し、WAI-ARIA準拠のアクセシビリティも確保する。

## サイズ・優先度

- **サイズ**: M（影響ファイル6本 + テスト4本）
- **優先度**: 中（UI改善・UX向上、既存機能への破壊的変更は軽微）
- **リスク**: 低〜中（LocalStorage互換性対応が唯一のデータ互換懸念）

---

## 詳細タスク

### Phase 1: 型定義・データ層

**対象ファイル:** `src/types/sidebar.ts`

#### タスク 1-1: `SidebarBranchItem` に `worktreePath` フィールド追加

現状: `SidebarBranchItem` インターフェースに `worktreePath` が存在しない。ツールチップで表示するには `Worktree.path`（worktreeの絶対パス）が必要。

変更内容:
```typescript
export interface SidebarBranchItem {
  // ... 既存フィールド ...
  /** Absolute path to worktree directory (for tooltip display) */
  worktreePath?: string;
}
```

#### タスク 1-2: `toBranchItem()` 関数で `worktreePath` をマッピング

変更内容（return 文に追加）:
```typescript
return {
  // ... 既存フィールド ...
  worktreePath: worktree.path,
};
```

---

### Phase 2: 状態管理・コンテキスト層

**対象ファイル:** `src/contexts/SidebarContext.tsx`、`src/hooks/useSidebar.ts`

#### タスク 2-1: `DEFAULT_SIDEBAR_WIDTH` を 288 → 224 に変更

変更内容:
- 定数値を `224` に変更
- コメントを `/** Default sidebar width in pixels (w-56 = 224px) */` に更新

#### タスク 2-2: `useSidebar.ts` にLocalStorage互換性マイグレーション追加

変更内容: `getPersistedSidebarState()` 関数内で旧幅値マイグレーション追加:

```typescript
const LEGACY_SIDEBAR_WIDTH = 288;
// getPersistedSidebarState()内でwidth === 288の場合は224に置き換え
```

---

### Phase 3: UIコンポーネント実装

#### タスク 3-1: `AppShell.tsx` — サイドバー幅クラスの変更

**対象ファイル:** `src/components/layout/AppShell.tsx`

変更箇所（デスクトップのみ変更、モバイルは維持）:
1. **122行目**: デスクトップサイドバー `w-72` → `w-56`
2. **140行目**: メインコンテンツのパディング `md:pl-72` → `md:pl-56`
- **88行目（モバイル）**: Issue要件が「PC版」に限定しているため、現状維持

#### タスク 3-2: `BranchListItem.tsx` — `showRepositoryName` props 追加

**対象ファイル:** `src/components/sidebar/BranchListItem.tsx`

変更内容:
```typescript
export interface BranchListItemProps {
  branch: SidebarBranchItem;
  isSelected: boolean;
  onClick: () => void;
  showRepositoryName?: boolean; // default: true
}
```

コンポーネント内でリポジトリ名表示を条件分岐:
```tsx
{showRepositoryName !== false && (
  <p className="text-xs text-gray-400 truncate">
    {branch.repositoryName}
  </p>
)}
```

#### タスク 3-3: `BranchListItem.tsx` — CSSカスタムツールチップ実装

WAI-ARIA対応ツールチップをTailwind CSSで実装（group + group-hover/group-focus-within）。

実装方針:
1. `<button>` に `group relative` クラスを追加
2. ツールチップ用 `<div>` を絶対位置で追加
3. `invisible group-hover:visible group-focus-within:visible` でhover/focus時に表示
4. `role="tooltip"` および `id={tooltipId}` を付与
5. `<button>` に `aria-describedby={tooltipId}` を追加

ツールチップ表示内容:
- ブランチ名（フルパス）
- リポジトリ名
- ステータス
- worktreeパス（`branch.worktreePath`）

ツールチップ表示方向: サイドバーの `overflow-y-auto` を考慮し、`top-full left-0`（下方向）を基本に検討。

#### タスク 3-4: `Sidebar.tsx` — `showRepositoryName` props の受け渡し

**対象ファイル:** `src/components/layout/Sidebar.tsx`

変更内容:
- grouped 表示の BranchListItem: `showRepositoryName={false}`
- flat 表示の BranchListItem: `showRepositoryName` なし（デフォルト true）

---

### Phase 4: テスト実装・更新

#### タスク 4-1: `BranchListItem.test.tsx` 更新・追加

追加テスト:
- `showRepositoryName=false` でリポジトリ名が非表示
- `showRepositoryName=true` でリポジトリ名が表示
- ツールチップの `role="tooltip"` レンダリング
- ツールチップに各情報（ブランチ名、リポジトリ名、ステータス、worktreePath）が含まれる
- `aria-describedby` と tooltip `id` の対応

#### タスク 4-2: `AppShell-layout.test.tsx` 更新

追加テスト:
- デスクトップサイドバーに `w-56` クラスが含まれる
- メインコンテンツに `md:pl-56` クラスが含まれる

#### タスク 4-3: `SidebarContext.test.tsx` 更新

変更内容:
- `DEFAULT_SIDEBAR_WIDTH` アサート値: `288` → `224`
- コメント: `w-72 = 288px` → `w-56 = 224px`

#### タスク 4-4: `useSidebar.test.ts` 更新・追加

追加テスト:
- 旧幅値 288 が 224 にマイグレーションされる
- 288 以外の値はそのまま保持される

---

## タスク依存関係

```mermaid
graph TD
    T11[1-1: SidebarBranchItem型にworktreePath追加]
    T12[1-2: toBranchItem()でworktreePathマッピング]
    T21[2-1: DEFAULT_SIDEBAR_WIDTH 288→224]
    T22[2-2: useSidebar LocalStorageマイグレーション]
    T31[3-1: AppShell w-72→w-56]
    T32[3-2: BranchListItem showRepositoryName props]
    T33[3-3: BranchListItem ツールチップ実装]
    T34[3-4: Sidebar showRepositoryName受け渡し]
    T41[4-1: BranchListItem.test.tsx 更新]
    T42[4-2: AppShell-layout.test.tsx 更新]
    T43[4-3: SidebarContext.test.tsx 更新]
    T44[4-4: useSidebar.test.ts 更新]

    T11 --> T12
    T12 --> T33
    T21 --> T31
    T21 --> T43
    T22 --> T44
    T32 --> T34
    T32 --> T41
    T33 --> T41
    T31 --> T42
    T34 --> T41
```

---

## 品質チェック項目

| チェック項目 | コマンド | 基準 |
|-------------|----------|------|
| ESLint | `npm run lint` | エラー0件 |
| TypeScript | `npx tsc --noEmit` | 型エラー0件 |
| Unit Test | `npm run test:unit` | 全テストパス |
| Build | `npm run build` | 成功 |

### コードレビュー観点
- [ ] `worktreePath` が `undefined` の場合にツールチップが壊れないこと
- [ ] `showRepositoryName` のデフォルト値が既存テスト・動作と互換
- [ ] ツールチップIDの一意性（`tooltip-${branch.id}` が重複しない）
- [ ] overflow-y-auto 親要素でツールチップが切れないこと

### アクセシビリティ観点
- [ ] `role="tooltip"` の付与
- [ ] `aria-describedby` と `id` の対応
- [ ] キーボードフォーカス時にツールチップが表示
- [ ] スクリーンリーダーでツールチップ内容が読み上げ可能

### LocalStorage互換性
- [ ] 旧ユーザー（width=288）が224に正しくマイグレーション
- [ ] 288以外の値はそのまま保持

---

## Definition of Done

- [ ] `SidebarBranchItem.worktreePath` が追加され、`toBranchItem()` がマッピング済み
- [ ] `DEFAULT_SIDEBAR_WIDTH = 224`、AppShell デスクトップが `w-56`、メインが `md:pl-56`
- [ ] grouped モードの BranchListItem でリポジトリ名が非表示
- [ ] flat モードの BranchListItem でリポジトリ名が従来通り表示
- [ ] hover/focus 時にツールチップが表示（ブランチ名・リポジトリ名・ステータス・worktreeパス）
- [ ] `role="tooltip"`、`aria-describedby` が正しく設定
- [ ] `width=288` の旧LocalStorageデータが `224` に自動変換
- [ ] 全テストパス（既存更新 + 新規追加）
- [ ] `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` パス

---

## 次のアクション

1. **Phase 1〜2**: 型定義・状態管理の変更（並列実施可能）
2. **Phase 3**: UIコンポーネント実装（Phase 1完了後）
3. **Phase 4**: テスト実装・更新（Phase 3完了後）
4. **PR作成**: `/create-pr` で自動作成
