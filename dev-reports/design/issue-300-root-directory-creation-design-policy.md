# Issue #300 設計方針書: ルートディレクトリにディレクトリ/ファイルを追加

## 1. 概要

### 背景
`FileTreeView.tsx` が空状態（`rootItems.length === 0`）のときのみ「New Directory」「New File」ボタンを表示し、非空状態ではルートレベルへの作成手段がない。

### 目的
- 非空状態のファイルツリーでルートレベルのディレクトリ/ファイル作成を可能にする
- `encodeURIComponent` によるパスエンコード問題を修正する

### スコープ
- **IN**: FileTreeViewへのツールバー追加、encodePathForUrlヘルパー抽出
- **OUT**: バックエンドAPI変更、ContextMenuの動作変更、i18n対応

---

## 2. アーキテクチャ設計

### 変更レイヤー

```
┌─────────────────────────────────────────────────────┐
│ プレゼンテーション層（変更あり）                       │
│  ┌─────────────────────────────────────────────┐    │
│  │ FileTreeView.tsx                            │    │
│  │  - 非空状態にツールバー追加                    │    │
│  │  - onNewFile('') / onNewDirectory('') 呼出   │    │
│  └─────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────┐    │
│  │ WorktreeDetailRefactored.tsx                │    │
│  │  - handleNewFile/handleNewDirectory のURL修正 │    │
│  │  - 全5箇所の encodeURIComponent 修正         │    │
│  └─────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────┤
│ ユーティリティ層（新規追加）                          │
│  ┌─────────────────────────────────────────────┐    │
│  │ src/lib/url-path-encoder.ts（新規）          │    │
│  │  - encodePathForUrl() ヘルパー関数           │    │
│  └─────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────┤
│ APIルート層（変更なし）                              │
│  route.ts, path-validator.ts, file-operations.ts    │
│  → 既存実装は正常動作確認済み                         │
└─────────────────────────────────────────────────────┘
```

### コンポーネント関係図

```
WorktreeDetailRefactored
  ├── handleNewFile(parentPath)    ← .md自動付与後に encodePathForUrl() 使用 [SF-2]
  ├── handleNewDirectory(parentPath) ← encodePathForUrl() 使用
  ├── handleRename(path)           ← encodePathForUrl() 使用
  ├── handleDelete(path)           ← encodePathForUrl() 使用
  ├── handleFileInputChange()      ← encodePathForUrl() 使用 (/upload/ EP) [SF-1]
  │
  └── FileTreeView
        ├── [非空状態] ツールバー（NEW）
        │     ├── "New File"      → onNewFile('')
        │     └── "New Directory" → onNewDirectory('')
        │
        ├── [空状態] 空状態ボタン（既存維持）
        │     ├── "New File"      → onNewFile('')
        │     └── "New Directory" → onNewDirectory('')
        │
        ├── TreeNode × N
        │     └── onContextMenu → ContextMenu
        │           ├── "New File"      → onNewFile(targetPath)
        │           └── "New Directory" → onNewDirectory(targetPath)
        │
        └── ContextMenu
```

---

## 3. 設計詳細

### 3.1 FileTreeView ツールバー追加

#### 設計方針: Option A（空状態ボタン維持 + 非空状態ツールバー追加）

**理由**: 空状態と非空状態は異なるレイアウト（中央揃え vs ツリー上部）のため、別々のUIが適切。

#### UI配置

```
┌─────────────────────────────┐
│ [+ New File] [+ New Dir]    │  ← ツールバー（非空状態のみ）
│─────────────────────────────│
│ ▶ src/                      │
│ ▶ tests/                    │
│   README.md                 │
│   package.json              │
└─────────────────────────────┘
```

#### 実装方針

```typescript
// FileTreeView.tsx 非空状態レンダリング（L877付近）
return (
  <div data-testid="file-tree-view" role="tree" ...>
    {/* ツールバー: コールバックが提供されている場合のみ表示 */}
    {(onNewFile || onNewDirectory) && (
      <div data-testid="file-tree-toolbar" className="flex items-center gap-1 p-1 border-b border-gray-200">
        {onNewFile && (
          <button
            data-testid="toolbar-new-file-button"
            onClick={() => onNewFile('')}
            className="flex items-center gap-1 px-2 py-1 text-xs ..."
            title="Create new file at root"
          >
            <FilePlus className="w-3.5 h-3.5" />
            <span>New File</span>
          </button>
        )}
        {onNewDirectory && (
          <button
            data-testid="toolbar-new-directory-button"
            onClick={() => onNewDirectory('')}
            className="flex items-center gap-1 px-2 py-1 text-xs ..."
            title="Create new directory at root"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            <span>New Directory</span>
          </button>
        )}
      </div>
    )}
    {/* 既存ツリー描画 */}
    {filteredRootItems.map(...)}
    <ContextMenu ... />
  </div>
);
```

#### [SF-1] ボタン共通化に関する設計判断

空状態ボタン（L837-L858）と非空状態ツールバーボタンは、アイコン（FilePlus/FolderPlus）・テキスト・コールバック呼び出しパターンが同一であり、共通サブコンポーネント（例: `CreateItemButton`）への抽出が検討対象となる。しかし、以下の理由から現行設計（別々のJSX）を許容する:

- **スタイル差異**: ツールバーボタンは `text-xs py-1 px-2 w-3.5 h-3.5`、空状態ボタンは `text-sm py-2 w-4 h-4` とサイズ・パディングが異なる
- **レイアウト差異**: 空状態は中央揃え（`flex-col items-center justify-center`）、非空状態はツリー上部の水平ツールバー
- **YAGNI原則**: 差異が小さくprops経由で制御可能ではあるが、現時点でボタンが2箇所のみであり、共通化による複雑性増加に見合うメリットがない
- **将来的なリファクタリング候補**: ボタンが3箇所以上に増加した場合、共通コンポーネントへの抽出を再検討する

#### data-testid 命名規則

| 状態 | data-testid | 説明 |
|------|------------|------|
| 空状態 | `empty-new-file-button` | 既存維持 |
| 空状態 | `empty-new-directory-button` | 既存維持 |
| 非空状態 | `toolbar-new-file-button` | 新規 |
| 非空状態 | `toolbar-new-directory-button` | 新規 |
| ツールバー | `file-tree-toolbar` | 新規（コンテナ） |

#### スタイリング方針

- ツールバーは `border-b border-gray-200` で区切り
- ボタンは `text-xs` で小さく、既存UIを圧迫しない
- `hover:bg-gray-50` でインタラクション表示
- アイコンサイズ `w-3.5 h-3.5`（空状態の `w-4 h-4` より小さく）
- タッチターゲット: `py-1 px-2`（デスクトップ向けサイズ、下記設計判断参照）
- ラベルは英語ハードコード（既存空状態ボタンと一貫性）

#### [Stage3 SF-3] タッチターゲットサイズに関する設計判断

ツールバーボタンの `py-1 px-2` パディング（約24x32px）は、WCAGガイドラインが推奨する最低44x44pxのタッチターゲットサイズを下回る。これは以下の設計判断に基づく意図的な選択である:

| 観点 | 判断 |
|------|------|
| **対象デバイス** | ツールバーはデスクトップ向けのUIとして設計する |
| **モバイルでの主要導線** | モバイルではコンテキストメニュー（長押し）経由のルート作成を推奨する。コンテキストメニューのタッチターゲットは十分なサイズが確保されている |
| **UIの一貫性** | ツールバーはファイルツリー上部の省スペース配置であり、44x44pxにすると既存UIのバランスを崩す |
| **空状態との差異** | 空状態ボタンは `py-2`（約16px上下パディング）で中央揃えの目立つ配置だが、非空状態ツールバーはツリーを圧迫しないコンパクト設計を優先する |

**結論**: 現行の `py-1 px-2` を維持する。モバイルユーザーはコンテキストメニュー経由でルートディレクトリへのファイル/ディレクトリ作成が可能であり、ツールバーは補助的な操作手段と位置づける。将来的にモバイルでのツールバー操作ニーズが高まった場合、`min-h-[44px] min-w-[44px]` の指定またはモバイル専用UIの検討を行う。

---

### 3.2 encodePathForUrl ヘルパー

#### 配置先

`src/lib/url-path-encoder.ts`（新規ファイル）

**理由**:
- `src/lib/utils.ts` は汎用ユーティリティであり、URL固有のロジックを混在させない
- `src/lib/url-normalizer.ts` はGit URL正規化用（用途が異なる）
- 単一責任のファイルとして新規作成

#### インターフェース

```typescript
/**
 * URL Path Encoder
 *
 * Encodes file/directory paths for use in API URLs.
 * Splits path on '/' and encodes each segment individually,
 * preserving '/' as path separators for Next.js catch-all routes.
 *
 * @module lib/url-path-encoder
 * @see Issue #300 - encodeURIComponent problem with slash-containing paths
 */

/**
 * Encode a file path for use in API URL.
 *
 * Each path segment is individually encoded with encodeURIComponent,
 * then joined with '/' to preserve the path structure.
 *
 * @param path - Relative file/directory path (e.g., 'src/components/foo.tsx')
 * @returns URL-safe encoded path (e.g., 'src/components/foo.tsx')
 *
 * @example
 * encodePathForUrl('src/newdir')      // 'src/newdir'
 * encodePathForUrl('file name.md')    // 'file%20name.md'
 * encodePathForUrl('dir/file#1.txt')  // 'dir/file%231.txt'
 * encodePathForUrl('')                // ''
 */
export function encodePathForUrl(path: string): string {
  if (!path) return '';
  return path.split('/').map(encodeURIComponent).join('/');
}
```

#### [SF-3] エッジケースの動作契約

`encodePathForUrl()` は汎用ヘルパーとして新規ファイルに切り出すため、以下のエッジケースにおける動作契約を明文化する。実際の呼び出し元（`WorktreeDetailRefactored.tsx`）では相対パスのみが渡されるため実用上の問題は発生しないが、汎用関数としての契約を定義する。

| エッジケース | 入力例 | 動作 | 出力例 |
|------------|--------|------|--------|
| **空文字列** | `''` | 空文字列を返す（`if (!path)` ガード） | `''` |
| **先頭スラッシュ** | `'/src/file'` | `split('/')` で先頭に空文字列要素が生成され、`encodeURIComponent('')` = `''` となる。スラッシュはエンコードせず、各セグメントのみエンコードする | `'/src/file'` |
| **連続スラッシュ** | `'src//file'` | `split('/')` で中間に空文字列要素が生成される。各セグメントをエンコードするが、パスの正規化（空セグメント除去）は行わない | `'src//file'` |
| **末尾スラッシュ** | `'src/'` | `split('/')` で末尾に空文字列要素が生成される。各セグメントをエンコードし、末尾の空文字列はそのまま保持される | `'src/'` |

**設計判断**: パスの正規化（連続スラッシュの除去、先頭/末尾スラッシュの処理）は `encodePathForUrl()` の責務外とする。正規化はサーバー側の `normalize()` が担当する（SF-2の責務境界と一貫）。

#### セキュリティ考慮

##### [SF-2] 責務境界の明確化

`encodePathForUrl()` のセキュリティにおける責務境界を以下のように定義する:

| レイヤー | 責務 | 担当モジュール |
|---------|------|--------------|
| **クライアント側** | URLエンコードのみ（パスセグメントの安全なURL表現） | `encodePathForUrl()` |
| **サーバー側** | パストラバーサル防御・パス正規化・アクセス制御 | `normalize()` + `isPathSafe()` (route.ts) |

**設計意図**: `encodePathForUrl()` はURLエンコードのみを担当し、パストラバーサル防御は一切担当しない。これはSRP（単一責任原則）に基づく意図的な設計判断である。セキュリティ防御は全てサーバー側の `isPathSafe()` に委譲される。

##### 検証チェーンの詳細

- `isPathSafe()` (path-validator.ts L41-47) は `decodeURIComponent()` でデコードしてからパス検証
- 個別セグメントエンコード方式でも、Next.js catch-all route がセグメントを分割してから `join('/')` するため、デコード後のパスは同一
- パストラバーサル攻撃（`../`）: `encodeURIComponent('..')` は `'..'` を返す（ドットはRFC 3986のunreserved characterであるため）。つまり `encodePathForUrl()` はパストラバーサルを防御しないが、これは意図的である。防御はサーバー側の `isPathSafe()` → `path.resolve()` + `path.relative()` による正規化チェーンで行われる

---

### 3.3 WorktreeDetailRefactored.tsx 修正

#### 修正箇所（5箇所）

```typescript
// Before（4箇所: handleNewFile, handleNewDirectory, handleRename, handleDelete）
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}`
// Before（1箇所: handleFileInputChange ― エンドポイントが /upload/ である点に注意 [SF-1]）
`/api/worktrees/${worktreeId}/upload/${encodeURIComponent(uploadPath)}`

// After（共通修正パターン）
import { encodePathForUrl } from '@/lib/url-path-encoder';
// /files/ エンドポイント（4箇所）
`/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}`
// /upload/ エンドポイント（1箇所: handleFileInputChange）
`/api/worktrees/${worktreeId}/upload/${encodePathForUrl(uploadPath)}`
```

| # | 関数 | 行 | API Path | 備考 |
|---|------|-----|----------|------|
| 1 | `handleNewFile()` | L1252 | `/api/.../files/` | `.md`拡張子の自動付与後のパスに`encodePathForUrl()`を適用（L1246-1247で拡張子がない場合`.md`を自動付与）[SF-2] |
| 2 | `handleNewDirectory()` | L1279 | `/api/.../files/` | |
| 3 | `handleRename()` | L1305 | `/api/.../files/` | |
| 4 | `handleDelete()` | L1330 | `/api/.../files/` | |
| 5 | `handleFileInputChange()` | L1408 | `/api/.../upload/` | エンドポイントは `/upload/`（他の4箇所は `/files/`）。ファイルアップロード専用APIルートを使用 [SF-1] |

---

## 4. テスト設計

### 4.1 ユニットテスト: encodePathForUrl

**ファイル**: `tests/unit/lib/url-path-encoder.test.ts`

| テストケース | 入力 | 期待出力 |
|------------|------|---------|
| 単一セグメント | `'newdir'` | `'newdir'` |
| 複数セグメント | `'src/newdir'` | `'src/newdir'` |
| 空文字列 | `''` | `''` |
| スペース含む | `'my dir'` | `'my%20dir'` |
| 特殊文字含む | `'file#1.txt'` | `'file%231.txt'` |
| ネストパスの特殊文字 | `'src/my file.ts'` | `'src/my%20file.ts'` |
| **[SF-3] 先頭スラッシュ** | `'/src/file'` | `'/src/file'` |
| **[SF-3] 連続スラッシュ** | `'src//file'` | `'src//file'` |
| **[SF-3] 末尾スラッシュ** | `'src/'` | `'src/'` |

### 4.2 コンポーネントテスト: FileTreeView ツールバー

**ファイル**: `tests/unit/components/worktree/FileTreeView.test.tsx`（既存に追加）

| テストケース | 検証内容 |
|------------|---------|
| ツールバー表示（非空） | `rootItems.length > 0` でツールバーが表示される |
| ツールバー非表示（空） | `rootItems.length === 0` でツールバーが表示されない |
| New Directory クリック | `onNewDirectory('')` が呼ばれる |
| New File クリック | `onNewFile('')` が呼ばれる |
| コールバック未指定 | `onNewFile` / `onNewDirectory` が undefined のときボタン非表示 |
| 空状態ボタン維持 | 空状態で `empty-new-directory-button` が引き続き表示される |

#### [Stage3 SF-2] MobileContent経由のツールバー表示確認

FileTreeViewのツールバーはコンポーネント内部に実装されるため、`MobileContent` 経由で `FileTreeView` が描画される場合（`WorktreeDetailRefactored.tsx` L864付近）にも自動的にツールバーが表示される。FileTreeView単体テストは直接レンダリングによる検証であり、MobileContent経由のprops伝搬パスは検証されない。

**検証方針**: FileTreeView単体テストでツールバーの表示・動作が保証されているため、MobileContent経由の検証は手動確認で行う。Section 8受け入れ条件にモバイル表示確認項目を追加済み。統合テストの追加はコスト対効果を考慮し現時点では見送る。

### 4.3 既存テスト影響

- `tests/unit/lib/file-operations.test.ts`: 変更なし（バックエンド変更なし）
- `tests/unit/path-validator.test.ts`: 変更なし
- `tests/unit/components/worktree/FileTreeView.test.tsx`: テスト追加（既存は破壊しない）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx`: [NTH-3] `encodePathForUrl` 自体の単体テスト（Section 4.1）で十分なカバレッジが得られるため、WorktreeDetailRefactoredレベルでの確認テストは優先度低。統合テストが必要であればE2E（Playwright）でルートディレクトリへのファイル/ディレクトリ作成シナリオを検証する方が効果的

#### [Stage3 SF-1] encodeURIComponent → encodePathForUrl 変更の検証戦略

既存の `WorktreeDetailRefactored.test.tsx` のFile Operations Handlerテストは `call[0].includes('/files/')` でURLパターンのみを検証しており、`encodeURIComponent` から `encodePathForUrl` への変更を検出できない（例: `encodeURIComponent('src/newfile.md')` = `'src%2Fnewfile.md'` と `encodePathForUrl('src/newfile.md')` = `'src/newfile.md'` の違いを区別しない）。

**採用するテスト戦略: 2層アプローチ**

1. **`url-path-encoder.test.ts` 単体テスト（Section 4.1）**: `encodePathForUrl()` のエンコード動作を網羅的にテスト（スラッシュ含むパス、特殊文字、エッジケース）。関数自体の正確性を保証する。
2. **WorktreeDetailRefactored.test.tsx モックテスト（追加推奨）**: File Operations Handlerテストにおいて、パスにスラッシュを含む場合（例: `onNewFile('src/subdir')` 呼び出し）の `fetch` URLが `'/api/.../files/src/subdir/...'` となること（`'src%2Fsubdir'` ではないこと）を検証するテストケースを1件追加する。

**設計根拠**: 単体テストだけでは「`encodePathForUrl` が正しくインポート・使用されていること」を保証できない。モックテスト1件の追加でインテグレーション観点のカバレッジを確保できるため、コスト対効果が高い。E2Eテストは代替手段として有効だが、実行コストが高いため補助的な位置づけとする。

| テスト層 | ファイル | 検証内容 | 優先度 |
|---------|--------|---------|-------|
| 単体テスト | `tests/unit/lib/url-path-encoder.test.ts` | `encodePathForUrl()` の入出力正確性 | High |
| モックテスト | `tests/unit/components/WorktreeDetailRefactored.test.tsx` | スラッシュ含むパスでのfetch URL検証（1件追加） | Medium |
| E2E（任意） | Playwright | ルートディレクトリ操作の統合シナリオ | Low |

#### [SF-3] 既知の課題: useFileOperations.ts のパスエンコード未使用

`useFileOperations.ts` L71 の move 操作 API 呼び出しでは、`encodeURIComponent` も `encodePathForUrl` も使用されていない:

```typescript
// useFileOperations.ts L70-71（現状）
const response = await fetch(`/api/worktrees/${worktreeId}/files/${moveTarget.path}`, ...)
```

この箇所はパスにスペースや特殊文字が含まれる場合に潜在的な問題を引き起こす可能性があるが、**本 Issue (#300) のスコープ外**とする。理由:

- Issue #300 は `WorktreeDetailRefactored.tsx` 内の 5 箇所の `encodeURIComponent` 修正と `FileTreeView` ツールバー追加がスコープ
- `useFileOperations.ts` は別フック（move 操作専用）であり、修正は独立した Issue で対応すべき
- Issue 本文の影響範囲セクションにも同様の注記が記載済み

---

## 5. 設計上の決定事項とトレードオフ

### 決定事項

| # | 決定事項 | 理由 | トレードオフ |
|---|---------|------|-------------|
| D-1 | ツールバーをFileTreeView内部に配置 | MobileContent経由の自動対応、SRP維持 | FileTreeViewの責務が若干増加 |
| D-2 | 空状態ボタンは維持 | 既存テスト・UIの破壊回避 | 2箇所にNew Dir/Fileボタンが存在 |
| D-3 | encodePathForUrl を新規ファイルに配置 | 単一責任、テスト容易性 | ファイル数が1つ増える |
| D-4 | 全5箇所のencodeURIComponentを一括修正 | DRY原則、一貫性 | 変更範囲が広がる |
| D-5 | バックエンドは変更しない | 検証済みで正常動作 | フロントエンドのみの修正 |
| D-6 | i18n対応はスコープ外 | 既存UIがi18n未対応、一貫性 | 将来追加修正が必要 |
| D-7 | [SF-1] 空状態/ツールバーボタンの共通化は見送り | YAGNI原則（2箇所のみ、差異が小さい） | 将来ボタン増加時に再検討 |
| D-8 | [NTH-1] ツールバーアクション配列のprops化は見送り | YAGNI原則（現在2ボタンのみ） | 将来アクション増加時に再検討 |
| D-9 | [NTH-2] URL構築パターンのヘルパー共通化は見送り | スコープ外、各ハンドラのHTTPメソッド/パラメータが異なる | 将来的なリファクタリング候補 |

### 代替案との比較

#### ツールバー配置: FileTreeView内部 vs WorktreeDetailRefactored

| 観点 | FileTreeView内部（採用） | WorktreeDetailRefactored |
|------|------------------------|-------------------------|
| モバイル対応 | MobileContentに自動反映 | 別途MobileContent修正要 |
| SRP | FileTreeViewの責務増加（軽微） | 呼び出し側の責務増加 |
| テスト | FileTreeViewのテストで完結 | 結合テスト必要 |
| 再利用性 | 他の場所でFileTreeView使用時もツールバー付き | 場所ごとにツールバー配置必要 |

**結論**: FileTreeView内部配置が優位（モバイル自動対応が決定的）

#### encodePathForUrl: 新規ファイル vs utils.ts に追加

| 観点 | 新規ファイル（採用） | utils.ts に追加 |
|------|-------------------|---------------|
| SRP | URL固有ロジック分離 | 汎用ユーティリティに混在 |
| テスト | 独立テストファイル | utils.test.ts に追加 |
| インポート | `@/lib/url-path-encoder` | `@/lib/utils` |

**結論**: 新規ファイル（SRP優先、テスト容易性）

---

## 6. セキュリティ設計

### パストラバーサル防止

#### [SF-2] セキュリティ責務境界

```
クライアント側                    サーバー側
┌─────────────────────┐      ┌──────────────────────────────┐
│ encodePathForUrl()  │      │ route.ts                     │
│ ・URLエンコードのみ   │  →   │ ・pathSegments.join('/')     │
│ ・セキュリティ防御なし │      │ ・normalize()                │
│                     │      │ ・isPathSafe() ← 防御はここ   │
└─────────────────────┘      └──────────────────────────────┘
```

- **`encodePathForUrl()` はパストラバーサル防御を担当しない**（責務外、SRP準拠の意図的判断）
- **防御は全てサーバー側**の `isPathSafe()` が担当する
- `isPathSafe()` は `decodeURIComponent()` 後のパスを検証（path-validator.ts L41-47）
- `encodePathForUrl()` で個別エンコードしても、APIルート側で `pathSegments.join('/')` → `normalize()` → `isPathSafe()` の検証チェーンは変わらない
- `path.resolve()` + `path.relative()` による正規化でトラバーサル攻撃を検出

### [Stage4 SF-1] isPathSafe() の二重デコードに関するスコープ外注記

`isPathSafe()` (path-validator.ts L40-47) は内部で `decodeURIComponent()` を適用してからパス検証を行う。一方、Next.js の catch-all route (`[...path]`) は `pathSegments` を API ハンドラに渡す時点で各セグメントを自動デコードしている。このため、`isPathSafe()` が受け取るパスは既にデコード済みであり、`decodeURIComponent()` の再適用は通常の文字列に対しては冪等（無変化）である。

しかし、ファイル名にリテラル `%` 文字を含む場合（例: `report%20v2.md` というファイル名が実際に `%20` をリテラル文字として持つ場合）、以下の挙動が発生する:

1. `encodePathForUrl('report%20v2.md')` -> `'report%2520v2.md'`
2. Next.js 自動デコード: `params.path = ['report%20v2.md']` (`%25` が `%` にデコード)
3. `isPathSafe()` 内の `decodeURIComponent('report%20v2.md')` -> `'report v2.md'`
4. 実際のファイル操作は `join(worktreeRoot, 'report%20v2.md')` でリテラル `%20` のファイルに対して実行

バリデーション対象パス (`report v2.md`) と実際のファイル操作パス (`report%20v2.md`) に不一致が生じるが、パス安全性チェックはディレクトリレベルの脱出（rootDir 外へのアクセス）を検出するものであり、ファイル名レベルの不一致ではセキュリティ上の実害はない。

**これは既存実装の設計特性であり、Issue #300 の変更（`encodeURIComponent` -> `encodePathForUrl`）はこの挙動を変更しないため、本 Issue のスコープ外とする。**

### 入力バリデーション

- `window.prompt` の戻り値が空の場合は `handleNewDirectory` / `handleNewFile` 内で早期リターン
- ファイル名のバリデーションは `createFileOrDirectory` 内の `isPathSafe` で実施
- セキュリティチェーンに変更なし

#### [Stage4 SF-2] クライアント側バリデーション非実施の設計判断

`window.prompt()` で入力されたファイル名/ディレクトリ名に対して、クライアント側での悪意ある文字バリデーション（`..` パストラバーサル、ヌルバイト `\x00`、制御文字、OS 禁止文字 `<>:"|?*` 等）は実施しない。

**理由**:
- サーバー側の `isPathSafe()` による多層防御で十分であり、クライアント側バリデーションはセキュリティ上の必須要件ではない
- `handleNewFile` / `handleNewDirectory` ではパス全体が `window.prompt()` から入力されるのではなく、ファイル名のみが入力され `parentPath` と結合されるため、パストラバーサルリスクは限定的
- `encodePathForUrl()` のセキュリティ責務境界（Section 3.2 SF-2）と一貫し、セキュリティ防御はサーバー側に一元化する

**UX 上の課題**: ユーザーが `../malicious` のようなファイル名を入力した場合、現在はサーバーエラーが返却されるだけでクライアント側での分かりやすいフィードバックがない。クライアント側バリデーションの追加はセキュリティではなく UX 改善の文脈で、将来的に検討する余地がある。

### [Stage4 SF-3] createFileOrDirectory() の isValidNewName() 非呼出に関する既知の課題

`createFileOrDirectory()` (file-operations.ts L298-335) は `isPathSafe()` のみを呼び出し、`isValidNewName()` を呼び出していない。一方、`renameFileOrDirectory()` (file-operations.ts L618-662) では L630 で `isValidNewName()` が呼び出されており、バリデーションが非対称になっている。

| 関数 | isPathSafe() | isValidNewName() |
|------|:---:|:---:|
| `createFileOrDirectory()` | 呼出あり | **呼出なし** |
| `renameFileOrDirectory()` | 呼出あり | 呼出あり |

この非対称性により、`renameFileOrDirectory()` では拒否されるファイル名（制御文字、OS 禁止文字等を含むもの）が `createFileOrDirectory()` 経由では受け入れられてしまう。

**これは既存実装の問題であり、Issue #300 の変更で新たに導入される問題ではない。** ただし、Issue #300 で追加されるツールバーボタンによりルートレベルでのファイル/ディレクトリ作成の機会が増えるため、影響範囲が拡大する。将来的に `createFileOrDirectory()` にも `isValidNewName()` 呼び出しを追加することを推奨する（別 Issue で対応）。

---

## 7. 変更対象ファイル一覧

| ファイル | 変更種別 | 優先度 | 説明 |
|---------|---------|-------|------|
| `src/lib/url-path-encoder.ts` | 新規 | High | `encodePathForUrl()` ヘルパー |
| `src/components/worktree/FileTreeView.tsx` | 修正 | High | 非空状態ツールバー追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 修正 | High | 全5箇所のencodeURIComponent修正 |
| `tests/unit/lib/url-path-encoder.test.ts` | 新規 | High | ヘルパー関数テスト |
| `tests/unit/components/worktree/FileTreeView.test.tsx` | 追加 | Medium | ツールバーテスト追加 |

### 変更不要ファイル

| ファイル | 理由 |
|---------|------|
| `src/lib/path-validator.ts` | 正常動作確認済み |
| `src/lib/file-operations.ts` | 正常動作確認済み |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | バックエンド変更不要 |
| `src/components/worktree/ContextMenu.tsx` | 動作変更不要 |

---

## 8. 受け入れ条件

### UI
- [ ] 非空状態のFileTreeViewにルートレベルのNew File/New Directoryツールバーが表示される
- [ ] ツールバーのNew Directoryボタンクリック時、`onNewDirectory('')` が呼ばれる（ルート作成）
- [ ] ツールバーのNew Fileボタンクリック時、`onNewFile('')` が呼ばれる（ルート作成）
- [ ] 空状態の既存ボタン（`data-testid='empty-new-directory-button'`）は残存する
- [ ] `onNewFile`/`onNewDirectory` が undefined の場合、ツールバーボタンは表示されない
- [ ] コンテキストメニューからのサブディレクトリ作成が引き続き正常動作する
- [ ] [Stage3 SF-2] モバイル表示時（MobileContent経由）もツールバーが正常に表示されること（手動確認）

### パスエンコード
- [ ] 共通ヘルパー `encodePathForUrl()` が `src/lib/url-path-encoder.ts` に実装されている
- [ ] `WorktreeDetailRefactored.tsx` の全5箇所で `encodePathForUrl()` を使用している
- [ ] パスにスラッシュを含む場合、各セグメントが個別にエンコードされる

### テスト
- [ ] `encodePathForUrl` の単体テストが存在する
- [ ] 非空状態でのツールバーボタン表示テストが存在する
- [ ] ボタンクリック時のコールバックテストが存在する
- [ ] 全テストがパスする
- [ ] [SF-3] `encodePathForUrl` のエッジケーステスト（先頭スラッシュ、連続スラッシュ、末尾スラッシュ）が存在する

---

## 9. レビュー履歴

| Stage | レビュー名 | 実施日 | 結果 |
|-------|----------|--------|------|
| 1 | 通常レビュー（設計原則） | 2026-02-18 | Must Fix: 0件, Should Fix: 3件, Nice to Have: 3件 |
| 2 | 整合性レビュー | 2026-02-18 | Must Fix: 0件, Should Fix: 3件, Nice to Have: 3件 |
| 3 | 影響分析レビュー | 2026-02-18 | Must Fix: 0件, Should Fix: 3件, Nice to Have: 3件 |
| 4 | セキュリティレビュー | 2026-02-18 | Must Fix: 0件, Should Fix: 3件, Nice to Have: 3件 |

---

## 10. レビュー指摘事項サマリー

### Stage 1: 通常レビュー（2026-02-18）

| ID | 重要度 | カテゴリ | 概要 | 対応状況 |
|----|--------|---------|------|---------|
| SF-1 | Should Fix | DRY原則 | 空状態ボタンとツールバーボタンのJSX重複 | 設計方針書に記録済み（YAGNI判断で現行維持） |
| SF-2 | Should Fix | セキュリティ設計 | encodePathForUrlのセキュリティ責務境界の明確化 | 設計方針書のSection 6に責務境界を追記 |
| SF-3 | Should Fix | エッジケース考慮 | encodePathForUrlのエッジケース動作契約の不足 | 設計方針書のSection 3.2/4.1に追記 |
| NTH-1 | Nice to Have | OCP | ツールバーボタンのハードコード | 将来課題として記録 |
| NTH-2 | Nice to Have | DRY原則 | URL構築パターンの重複 | 将来課題として記録 |
| NTH-3 | Nice to Have | テスト設計 | WorktreeDetailRefactored統合テストのコスト対効果 | テスト戦略に注記追加 |

### Stage 2: 整合性レビュー（2026-02-18）

| ID | 重要度 | カテゴリ | 概要 | 対応状況 |
|----|--------|---------|------|---------|
| SF-1 | Should Fix | APIエンドポイント整合性 | handleFileInputChangeのエンドポイントが/upload/であり/files/と異なる | 設計方針書Section 3.3テーブル・コード例・コンポーネント関係図を修正 |
| SF-2 | Should Fix | handleNewFile動作契約 | handleNewFileの.md拡張子自動付与ロジックが設計方針書に未記載 | 設計方針書Section 3.3テーブル備考・コンポーネント関係図に注記追加 |
| SF-3 | Should Fix | パスエンコード未使用 | useFileOperations.ts L71のパスエンコード未使用が設計書に未記載 | 設計方針書Section 4.3に既知の課題として注記追加（スコープ外明記） |
| NTH-1 | Nice to Have | 行番号精度 | FileTreeView非空状態の挿入位置をL883-884間と具体化 | 将来課題として記録 |
| NTH-2 | Nice to Have | 受け入れ条件 | FILE_EXISTSエラーの受け入れ条件が設計書に未記載 | 将来課題として記録（バックエンドスコープ外） |
| NTH-3 | Nice to Have | 行番号精度 | 空状態ボタンの行番号L837-L858をL835-858に修正 | 将来課題として記録 |

### Stage 3: 影響分析レビュー（2026-02-18）

| ID | 重要度 | カテゴリ | 概要 | 対応状況 |
|----|--------|---------|------|---------|
| SF-1 | Should Fix | テスト影響・検証漏れ | WorktreeDetailRefactored.test.tsxの既存テストがencodeURIComponent→encodePathForUrl変更を検出できない | Section 4.3に2層テスト戦略（単体テスト+モックテスト）を追記 |
| SF-2 | Should Fix | 間接的影響・MobileContent | MobileContent経由のツールバー表示検証がテスト計画に含まれていない | Section 8受け入れ条件にモバイル表示確認項目を追加 |
| SF-3 | Should Fix | タッチターゲットサイズ | ツールバーボタンpy-1 px-2（約24x32px）がWCAG推奨44x44pxを下回る | Section 3.1にデスクトップ向けUI設計判断を明記（モバイルはコンテキストメニュー推奨） |
| NTH-1 | Nice to Have | 将来的な影響範囲 | encodePathForUrlの将来的な適用候補一覧 | 既にSection 4.3に記載済み（対応不要） |
| NTH-2 | Nice to Have | 後方互換性 | Before/AfterのURL文字列変化の具体例追記 | 将来課題として記録（実装影響なし） |
| NTH-3 | Nice to Have | パフォーマンス影響 | パフォーマンスへの影響は無視できるレベル | 対応不要（レビュー結果でも追記不要と判定） |

### Stage 4: セキュリティレビュー（2026-02-18）

| ID | 重要度 | カテゴリ | 概要 | 対応状況 |
|----|--------|---------|------|---------|
| SF-1 | Should Fix | 二重デコード・エッジケース | isPathSafe()内のdecodeURIComponentが既にNext.jsにより自動デコードされたパスに対して再適用される。リテラル%を含むファイル名でバリデーション対象と実操作パスに不一致が生じるが、rootDir外脱出は不可能で実害なし | 設計方針書Section 6にスコープ外注記を追記 |
| SF-2 | Should Fix | 入力バリデーション（クライアント側） | window.prompt()入力に対するクライアント側での悪意ある文字バリデーション（.., ヌルバイト, 制御文字, OS禁止文字）が存在しない | 設計方針書Section 6にサーバー側防御で十分とする設計判断を追記 |
| SF-3 | Should Fix | createFileOrDirectoryのバリデーション不足 | createFileOrDirectory()はisPathSafe()のみ呼出し、isValidNewName()を呼ばない（renameFileOrDirectoryとの非対称） | 設計方針書Section 6に既知の課題として追記（スコープ外明記） |
| NTH-1 | Nice to Have | XSS対策 | encodePathForUrl()の出力がHTML安全ではない旨の明記 | 将来課題として記録 |
| NTH-2 | Nice to Have | アクセス制御（OWASP A01） | localhost専用ツールの前提明記 | 将来課題として記録 |
| NTH-3 | Nice to Have | OWASP A03 インジェクション | OWASP Top 10チェックリスト形式の整理 | 将来課題として記録 |

---

## 11. レビュー指摘に基づく実装チェックリスト

### Stage 1 対応（Should Fix）

- [ ] **[SF-1]** 空状態ボタンとツールバーボタンを共通化しない設計判断をコード内コメントに記載（任意）
- [ ] **[SF-2]** `encodePathForUrl()` のJSDocに「パストラバーサル防御は責務外」であることを明記
- [ ] **[SF-2]** セキュリティ防御がサーバー側 `isPathSafe()` に委譲される旨をJSDocに記載
- [ ] **[SF-3]** 先頭スラッシュ（`'/src/file'`）のテストケースを追加
- [ ] **[SF-3]** 連続スラッシュ（`'src//file'`）のテストケースを追加
- [ ] **[SF-3]** 末尾スラッシュ（`'src/'`）のテストケースを追加
- [ ] **[SF-3]** 空文字列（`''`）のテストケースが存在することを確認（既存）

### Stage 1 対応（Nice to Have / 将来課題）

- [ ] **[NTH-1]** ツールバーアクション増加時にprops配列化を検討（現時点では不要）
- [ ] **[NTH-2]** URL構築パターンの共通ヘルパー化を検討（現時点ではスコープ外）
- [ ] **[NTH-3]** E2Eテストでルートディレクトリ操作シナリオを検討（コスト対効果を評価）

### Stage 2 対応（Should Fix）

- [x] **[SF-1]** Section 3.3修正箇所テーブルの5番目（handleFileInputChange）のAPI Pathを `/api/.../upload/` に修正し、他4箇所との差異を明記
- [x] **[SF-1]** Section 3.3のBefore/Afterコード例に `/upload/` エンドポイントのパターンを追加
- [x] **[SF-1]** Section 2コンポーネント関係図の handleFileInputChange に `/upload/` EP 注記を追加
- [x] **[SF-2]** Section 3.3修正箇所テーブルの handleNewFile 備考に `.md` 拡張子自動付与ロジック（L1246-1247）の注記を追加
- [x] **[SF-2]** Section 2コンポーネント関係図の handleNewFile に `.md` 自動付与後エンコードの注記を追加
- [x] **[SF-3]** Section 4.3に useFileOperations.ts L71 のパスエンコード未使用を既知の課題として追加
- [x] **[SF-3]** 本Issue (#300) のスコープ外であることを明記

### Stage 2 対応（Nice to Have / 将来課題）

- [ ] **[NTH-1]** FileTreeView非空状態のツールバー挿入位置をL883-884間と具体化（現状L877付近で十分特定可能）
- [ ] **[NTH-2]** Section 8受け入れ条件にFILE_EXISTSエラーの既存バックエンド処理確認項目を追加（バックエンドスコープ外）
- [ ] **[NTH-3]** 空状態ボタンの行番号をL835-858に修正（実装影響なし）

### Stage 3 対応（Should Fix）

- [ ] **[SF-1]** `tests/unit/lib/url-path-encoder.test.ts` でスラッシュ含むパスのエンコード動作を網羅的にテスト（Section 4.1のテストケース）
- [ ] **[SF-1]** `tests/unit/components/WorktreeDetailRefactored.test.tsx` にスラッシュ含むパスでのfetch URL検証テスト1件を追加（例: `onNewFile('src/subdir')` でfetch URLが `'/api/.../files/src/subdir/...'` となることを検証）
- [ ] **[SF-2]** モバイル表示時（MobileContent経由）のツールバー表示を手動確認（受け入れ条件Section 8に追加済み）
- [ ] **[SF-3]** ツールバーボタンのタッチターゲットサイズはデスクトップ向け `py-1 px-2` を維持（設計判断をSection 3.1に明記済み）

### Stage 3 対応（Nice to Have / 将来課題）

- [ ] **[NTH-1]** `encodePathForUrl` の将来的な適用候補（`useFileOperations.ts` L71等）を別Issueで対応（既にSection 4.3に記載済み）
- [ ] **[NTH-2]** Before/AfterのURL文字列変化の具体例をSection 3.3に追記（例: `'src%2Fnewfile.md'` → `'src/newfile.md'`）
- [ ] **[NTH-3]** パフォーマンス影響は無視できるレベル（対応不要）

### Stage 4 対応（Should Fix）

- [x] **[SF-1]** Section 6にisPathSafe()の二重デコードに関するスコープ外注記を追記（Next.js自動デコード済みパスへのdecodeURIComponent再適用、リテラル%文字を含むファイル名のエッジケース、Issue #300スコープ外の明記）
- [x] **[SF-2]** Section 6入力バリデーションに、window.prompt()入力に対するクライアント側バリデーション非実施の設計判断を追記（サーバー側isPathSafe()による多層防御で十分、UX課題としての将来検討余地を記録）
- [x] **[SF-3]** Section 6にcreateFileOrDirectory()がisValidNewName()を呼び出さない既知の課題を追記（renameFileOrDirectory()との非対称性、ツールバー追加による影響範囲拡大、別Issue対応推奨）

### Stage 4 対応（Nice to Have / 将来課題）

- [ ] **[NTH-1]** Section 6にXSS対策サブセクションを追加し、encodePathForUrl()はURL構築専用でありHTML出力には使用しない旨を明記
- [ ] **[NTH-2]** Section 6にCommandMateがlocalhost専用ツールであり認証・認可機構を設けていない前提を明記
- [ ] **[NTH-3]** Section 6にOWASP Top 10チェックリスト形式の体系的整理を追加（A01, A03, A05, A06）

---

*Generated by design-policy command for Issue #300*
