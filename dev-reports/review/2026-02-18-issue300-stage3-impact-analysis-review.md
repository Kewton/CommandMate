# Architecture Review Report: Issue #300 Stage 3 - 影響分析レビュー

| 項目 | 内容 |
|------|------|
| Issue | #300 |
| Stage | 3 (影響分析レビュー) |
| Focus | 影響範囲 |
| Date | 2026-02-18 |
| Status | Approved |
| Score | 4/5 |

---

## Executive Summary

Issue #300の設計方針書「ルートディレクトリにディレクトリ/ファイルを追加」について、影響範囲の分析を実施した。直接変更対象3ファイル（`FileTreeView.tsx`、`WorktreeDetailRefactored.tsx`、`url-path-encoder.ts`新規）の影響は明確に限定されており、既存テストへの破壊的影響はない。Props変更が不要であること、APIエンドポイントの後方互換性が維持されること、パフォーマンス影響が無視できることを確認した。

Must Fix 0件、Should Fix 3件、Nice to Have 3件の指摘事項がある。Should Fixはいずれもテスト検証の補強とモバイル対応の確認に関するものであり、設計の根本的な問題ではない。

---

## 1. 直接的な変更の影響分析

### 1.1 FileTreeView.tsx - ツールバー追加

| 分析項目 | 結果 |
|---------|------|
| 変更箇所 | L877-919のreturn文内、`filteredRootItems.map()`の前に条件付きJSX挿入 |
| Props変更 | **不要** - `onNewFile`、`onNewDirectory`は既にFileTreeViewPropsに定義済み（L41, L43） |
| 既存UIへの影響 | 空状態ボタン（L827-861）は変更されない。空状態と非空状態は排他的にレンダリングされるため干渉なし |
| 既存テストへの影響 | **影響なし** - 既存テストは`data-testid="file-tree-view"`、`role="tree"`等のセレクタを使用。ツールバーは新規`data-testid`を使用するため干渉しない |

**確認した既存Props定義:**

```typescript
// FileTreeView.tsx L35-64
export interface FileTreeViewProps {
  onNewFile?: (parentPath: string) => void;    // L41 - 既に存在
  onNewDirectory?: (parentPath: string) => void; // L43 - 既に存在
  // ...
}
```

ツールバーはこれらの既存コールバックを`onNewFile('')`/`onNewDirectory('')`で呼び出すだけであり、新規propsは不要である。

### 1.2 WorktreeDetailRefactored.tsx - 5箇所のエンコード修正

| # | 関数 | 行 | 現在のコード | 修正後 |
|---|------|-----|-------------|--------|
| 1 | handleNewFile | L1252 | `encodeURIComponent(newPath)` | `encodePathForUrl(newPath)` |
| 2 | handleNewDirectory | L1279 | `encodeURIComponent(newPath)` | `encodePathForUrl(newPath)` |
| 3 | handleRename | L1305 | `encodeURIComponent(path)` | `encodePathForUrl(path)` |
| 4 | handleDelete | L1330 | `encodeURIComponent(path)` | `encodePathForUrl(path)` |
| 5 | handleFileInputChange | L1408 | `encodeURIComponent(uploadPath)` | `encodePathForUrl(uploadPath)` |

**既存テストへの影響:**

`WorktreeDetailRefactored.test.tsx`のFile Operations Handlerテスト（L530-808）はFileTreeViewをモック化しており、fetch URLの検証は`call[0].includes('/files/')`でパターンマッチのみを行っている。`encodeURIComponent` → `encodePathForUrl`の変更はこれらのテストに影響しない。

ただし、これは同時にテストが変更の正しさを検証できないことを意味する（SF-1として指摘）。

### 1.3 src/lib/url-path-encoder.ts - 新規ファイル

新規ファイルのため既存コードへの影響はない。`import`文がWorktreeDetailRefactored.tsxに追加される。

---

## 2. 間接的な影響分析

### 2.1 FileTreeViewのコンシューマー分析

`FileTreeView`を使用しているファイルをGrepで確認した結果:

| ファイル | 用途 | 影響 |
|---------|------|------|
| `WorktreeDetailRefactored.tsx` L758, L864 | デスクトップ左ペイン、モバイルfilesタブ | 直接変更対象。Props変更なし |
| `ContextMenu.tsx` | FileTreeView内部で使用 | 変更なし |
| `useContextMenu.ts` | FileTreeView内部で使用 | 変更なし |

FileTreeViewは`WorktreeDetailRefactored.tsx`からのみインポートされており、他のコンポーネントからの使用はない。Propsインターフェースに変更がないため、間接的な影響は発生しない。

### 2.2 MobileContent経由の影響

`WorktreeDetailRefactored.tsx`のMobileContentコンポーネント（L805-902）は`activeTab === 'files'`の場合にFileTreeViewをレンダリングする（L864）。FileTreeViewに`onNewFile`と`onNewDirectory`が渡されている（L867-868）ため、ツールバーはモバイルでも自動的に表示される。

ただし、モバイルでのツールバーの動作確認がテスト計画に含まれていない点を指摘する（SF-2）。

### 2.3 encodePathForUrl導入後の将来的影響

`encodePathForUrl()`は以下の箇所にも適用候補がある:

| ファイル | 行 | 現在の状態 | 備考 |
|---------|-----|-----------|------|
| `useFileOperations.ts` | L71 | `encodeURIComponent`も`encodePathForUrl`も未使用 | 設計書に既知の課題として記載済み、スコープ外 |
| `useFileSearch.ts` | L190 | `encodeURIComponent(worktreeId)`を使用 | worktreeIdのエンコードであり、パスエンコードとは用途が異なる |

---

## 3. 既存テストへの影響

### 3.1 FileTreeView.test.tsx

| テスト区分 | テスト数 | 影響 |
|-----------|---------|------|
| Basic rendering | 4件 | 影響なし - ツリーアイテムの存在確認のみ |
| Directory expand/collapse | 6件 | 影響なし - 展開/折りたたみロジック変更なし |
| File selection | 3件 | 影響なし - ファイル選択ロジック変更なし |
| Icons | 2件 | 影響なし |
| Indentation | 3件 | 影響なし |
| File size formatting | 2件 | 影響なし |
| Error handling | 2件 | 影響なし |
| **Empty state** | 1件 | **影響なし** - rootItems.length === 0 の分岐は変更されない |
| **Empty state with action buttons** | 4件 | **影響なし** - 空状態のdata-testid検証はそのまま通過 |
| Context menu | 3件 | 影響なし |
| Touch long press | 5件 | 影響なし |
| refreshTrigger | 6件 | 影響なし |

**新規テスト追加必要:** ツールバー表示テスト（非空状態でのボタン表示、クリック時のコールバック検証、コールバック未指定時の非表示確認）

### 3.2 WorktreeDetailRefactored.test.tsx

| テスト区分 | テスト数 | 影響 |
|-----------|---------|------|
| Desktop Mode | 4件 | 影響なし |
| Mobile Mode | 4件 | 影響なし |
| Loading State | 2件 | 影響なし |
| Error State | 1件 | 影響なし |
| State Management | 2件 | 影響なし |
| Terminal State | 2件 | 影響なし |
| Accessibility | 2件 | 影響なし |
| **File Operations Handlers** | 8件 | **影響なし** - FileTreeViewがモック化されているため、encodePathForUrlへの変更は検出されない |
| Visibility Change Recovery | 8件 | 影響なし |
| Update Notification | 5件 | 影響なし |

---

## 4. 破壊的変更の有無

### 4.1 空状態ボタンの維持

```
FileTreeView.tsx構造:
  L802-812: loading state → 早期リターン
  L815-824: error state → 早期リターン
  L827-861: empty state (rootItems.length === 0) → 早期リターン
    L839: empty-new-file-button ← 維持
    L849: empty-new-directory-button ← 維持
  L864-875: no search results state → 早期リターン
  L877-919: normal state ← ツールバー追加ここ
```

空状態（`rootItems.length === 0`）は非空状態（L877以降）より前に早期リターンするため、ツールバー追加が空状態ボタンに影響を与えることはない。`data-testid='empty-new-directory-button'`および`data-testid='empty-new-file-button'`は維持される。

### 4.2 コンテキストメニューの動作

ContextMenuコンポーネントはFileTreeViewのreturn文内の最後（L905-917）にレンダリングされる。ツールバーはContextMenuの前に追加されるが、同一のdiv内であり、ContextMenuのpropsやイベントハンドラに変更はない。

### 4.3 APIエンドポイントの後方互換性

| 項目 | encodeURIComponent | encodePathForUrl | 互換性 |
|------|-------------------|-----------------|--------|
| 単一セグメント (`newdir`) | `newdir` | `newdir` | 同一 |
| 複数セグメント (`src/newdir`) | `src%2Fnewdir` | `src/newdir` | **URLは異なるが、サーバー側で同一結果** |
| 特殊文字 (`file name.md`) | `file%20name.md` | `file%20name.md` | 同一 |

**サーバー側の処理:**
- `encodeURIComponent('src/newdir')` = `'src%2Fnewdir'` の場合:
  - Next.js catch-all route: `params.path = ['src%2Fnewdir']`
  - `pathSegments.join('/')` = `'src%2Fnewdir'`
  - `normalize('src%2Fnewdir')` = `'src%2Fnewdir'`
  - `decodeURIComponent('src%2Fnewdir')` = `'src/newdir'` (isPathSafe内)

- `encodePathForUrl('src/newdir')` = `'src/newdir'` の場合:
  - Next.js catch-all route: `params.path = ['src', 'newdir']`
  - `pathSegments.join('/')` = `'src/newdir'`
  - `normalize('src/newdir')` = `'src/newdir'`

両方のケースで最終的にサーバー側では同一のパスが処理される。後方互換性は維持される。

---

## 5. パフォーマンス影響

| 変更 | 影響度 | 詳細 |
|------|-------|------|
| ツールバーJSX追加 | 無視できるレベル | React.memo内の条件付きレンダリング。ボタン2個の追加は描画負荷に影響しない |
| encodePathForUrl()呼び出し | 無視できるレベル | `path.split('/').map(encodeURIComponent).join('/')` - O(n)の文字列操作、n=パスセグメント数（通常1-5） |
| import文追加 | 無視できるレベル | バンドルサイズ増加は数十バイト |

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | encodePathForUrl変更によるAPI通信不具合 | Low | Low | P3 - 単体テストでカバー |
| 技術的リスク | ツールバーによる既存UI破壊 | Low | Low | P3 - 空状態と非空状態は排他的 |
| テストリスク | 既存テストがエンコード変更を検出しない | Medium | High | P2 - SF-1で指摘 |
| UXリスク | モバイルでのタッチターゲットサイズ不足 | Medium | Medium | P2 - SF-3で指摘 |
| セキュリティリスク | パストラバーサル | Low | Low | P3 - サーバー側isPathSafe()で防御、変更なし |
| 運用リスク | なし | - | - | - |

---

## 7. 指摘事項一覧

### Should Fix (3件)

| ID | カテゴリ | 概要 |
|----|---------|------|
| SF-1 | テスト影響・検証漏れ | WorktreeDetailRefactored.test.tsxの既存テストがencodeURIComponent→encodePathForUrl変更を検出できない。テスト戦略の明確化が必要 |
| SF-2 | 間接的影響・MobileContent | MobileContent経由のツールバー表示確認がテスト計画に未記載。受け入れ条件への追加を推奨 |
| SF-3 | タッチターゲットサイズ | ツールバーボタンのpy-1 px-2がモバイルのWCAGガイドライン(44x44px)を満たさない可能性。設計判断の明記を推奨 |

### Nice to Have (3件)

| ID | カテゴリ | 概要 |
|----|---------|------|
| NTH-1 | 将来的な影響範囲 | encodePathForUrl適用候補一覧のまとめ（現在の設計書記載で十分） |
| NTH-2 | 後方互換性 | Before/Afterの具体的なURL文字列変化例の追記 |
| NTH-3 | パフォーマンス影響 | パフォーマンス影響は無視できるレベルであり、特に対応不要 |

---

## 8. 影響範囲サマリー図

```
変更あり:
  src/lib/url-path-encoder.ts (新規) ............ 低リスク
  src/components/worktree/FileTreeView.tsx ....... 低リスク (内部UI追加のみ)
  src/components/worktree/WorktreeDetailRefactored.tsx .. 低リスク (関数置換のみ)
  tests/unit/lib/url-path-encoder.test.ts (新規) .. -
  tests/unit/components/worktree/FileTreeView.test.tsx .. テスト追加

変更なし (確認済み):
  src/components/worktree/ContextMenu.tsx ........ 影響なし
  src/hooks/useFileOperations.ts ................ 影響なし (既知の課題、スコープ外)
  src/lib/path-validator.ts ..................... 影響なし
  src/lib/file-operations.ts ................... 影響なし
  src/app/api/worktrees/[id]/files/[...path]/route.ts .. 影響なし
  src/app/api/worktrees/[id]/upload/[...path]/route.ts . 影響なし
```

---

## 9. Approval

| 項目 | 結果 |
|------|------|
| Status | **Approved** |
| Score | **4/5** |
| Must Fix | 0件 |
| Should Fix | 3件 |
| Nice to Have | 3件 |
| Blocking Issues | なし |

設計方針書の影響範囲分析は概ね適切であり、直接変更・間接影響・破壊的変更・後方互換性の全観点で重大な問題はない。Should Fix 3件はテスト検証の補強とモバイルUXの確認に関するもので、実装フェーズで対応可能。

---

*Generated by architecture-review-agent for Issue #300 Stage 3*
