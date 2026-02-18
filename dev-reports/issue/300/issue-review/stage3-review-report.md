# Issue #300 影響範囲レビューレポート

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 3 |

**総合評価**: needs_improvement

Issue #300は主要修正（FileTreeViewツールバー追加）の影響範囲が限定的であり、破壊的変更はない。しかし、二次的問題として記載されている`encodeURIComponent`の影響範囲がIssue本文の記載より広く、`handleRename`/`handleDelete`/`handleUpload`にも同一パターンが存在する。修正対象の正確な範囲をIssueに明記すべきである。

---

## Must Fix（必須対応）

### MF-1: encodeURIComponent問題の影響範囲がIssue記載より広い

**カテゴリ**: API影響
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx` L1252, L1279, L1305, L1330, L1408

**問題**:
Issue本文では`handleNewDirectory`（L1279）と`handleNewFile`（L1252）の`encodeURIComponent`問題を二次的問題として記載しているが、同一パターンが`handleRename`（L1305）、`handleDelete`（L1330）、`handleUpload`（L1408）にも存在する。

具体的には、以下5箇所すべてで`encodeURIComponent(path)`を使用している:

```typescript
// L1252 handleNewFile
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(newPath)}`

// L1279 handleNewDirectory
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(newPath)}`

// L1305 handleRename
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}`

// L1330 handleDelete
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}?recursive=true`

// L1408 handleUpload
`/api/worktrees/${worktreeId}/upload/${encodeURIComponent(uploadPath)}`
```

`handleRename`と`handleDelete`では`path`がFileTreeViewから渡される既存ファイルの完全パス（例: `src/components/App.tsx`）であるため、`encodeURIComponent`によって`src%2Fcomponents%2FApp.tsx`にエンコードされ、Next.jsの`[...path]` catch-all routeで単一セグメントとして処理される。

**証拠**:
- `route.ts` L112: `const requestedPath = pathSegments.join('/')` -- `pathSegments`はNext.jsが自動分割した配列だが、`%2F`を含む単一セグメントは分割されない
- ただし実運用で問題が顕在化していない可能性がある（Next.jsの一部バージョンでは`%2F`を含むURLを自動的にデコードしてルーティングする挙動がある）

**推奨対応**:
共通ヘルパー関数を抽出して全5箇所を統一修正する:

```typescript
/** パスセグメントを個別にエンコードしてスラッシュで結合 */
function encodePathForUrl(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}
```

Issueの「影響範囲 > 変更対象ファイル」テーブルに、`handleRename`/`handleDelete`/`handleUpload`も同一修正が必要な旨を追記すべき。

---

### MF-2: FileTreeViewツールバーと空状態ボタンの共存方針が不明確

**カテゴリ**: UI影響
**場所**: `src/components/worktree/FileTreeView.tsx` L827-861, L877-919

**問題**:
Issue本文には「空状態のNew Directoryボタン（L827-861）は既存のまま維持」と記載されているが、以下の設計判断がIssueに明示されていない:

1. **UIの一貫性**: 空状態では縦並びのボタン（L836-857）、非空状態ではツールバー（横並び想定）という異なるレイアウトになる可能性。ユーザーがツリーの最後のアイテムを削除して空状態に遷移した場合、UIが大きく変わる
2. **data-testidの命名**: 空状態ボタンは`empty-new-directory-button`/`empty-new-file-button`。非空状態のボタンには異なるtestIdが必要だが、命名規則が未定義
3. **コールバック引数の一致**: 両方のボタンが`onNewDirectory('')`/`onNewFile('')`を呼ぶことを明示すべき

**証拠**:
- `FileTreeView.test.tsx` L607-608: `expect(screen.getByTestId('empty-new-directory-button'))` -- 空状態ボタンのtestIdが既にテストで使用されている
- Issue受け入れ条件に「空状態ボタンとの共存方針」に関する項目がない

**推奨対応**:
Issueの対策案セクションに以下を追記:
- 空状態ボタンは現状維持（空→非空遷移時のUI一貫性を優先）
- 非空状態ツールバーのdata-testid: `root-new-file-button`, `root-new-directory-button`
- 両方のボタンともparentPath=''（空文字列）をコールバックに渡す

---

## Should Fix（推奨対応）

### SF-1: 新規テストケースの具体的な一覧

**カテゴリ**: テスト影響
**場所**: `tests/unit/components/worktree/FileTreeView.test.tsx`, `tests/unit/components/WorktreeDetailRefactored.test.tsx`

**問題**:
Issue本文の変更対象ファイルにテスト追加が挙げられているが、具体的なテストケースの一覧がない。

**既存テストへの影響分析**:
- `FileTreeView.test.tsx`: 既存の全テスト（1435行）は壊れない。空状態テスト（L577-665）は`rootItems.length === 0`のケースのみで、ツールバー追加は`rootItems.length > 0`のパスに影響するため干渉しない
- `WorktreeDetailRefactored.test.tsx`: FileTreeViewをモックしているため（L146-171）、FileTreeView内部の変更に影響されない。encodeURIComponent修正は既存テスト（L567-646）でフェッチURLの検証に影響する可能性がある
- `tests/unit/lib/file-operations.test.ts`: バックエンド側は変更なし、影響なし

**推奨テストケース**:

FileTreeView.test.tsx に追加:
1. `should show root-level toolbar buttons when tree has items`
2. `should call onNewFile with empty string from root toolbar`
3. `should call onNewDirectory with empty string from root toolbar`
4. `should not show root toolbar when onNewFile and onNewDirectory are undefined`

WorktreeDetailRefactored.test.tsx に追加（encodeURIComponent修正時）:
5. `should encode path segments individually when creating nested directory`
6. `should encode path segments individually when creating nested file`

---

### SF-2: FileTreeView内部のi18n未対応

**カテゴリ**: i18n
**場所**: `src/components/worktree/FileTreeView.tsx` L844, L854

**問題**:
FileTreeView内部の空状態ボタンラベル `New File` / `New Directory` はハードコードされている。新規ツールバーのラベルも同様にハードコードされる見込み。

ContextMenu.tsx（L116-127）の`New File` / `New Directory` / `Rename` / `Delete`も同様にハードコードされており、プロジェクト全体としてファイル操作UIのi18n対応が未着手であることがわかる。

**証拠**:
- FileTreeViewは`useLocale()`を日付フォーマット用にのみ使用（L541）
- `useTranslations()`はFileTreeView内で未使用
- `locales/en/common.json`にファイル操作関連のキーは未定義（`confirmDelete`のみ存在）

**推奨対応**:
本Issue内でのi18n対応は必須ではない（既存パターンとの整合性が保たれるため）。ただし、Issueの影響範囲として「i18n未対応ラベルが追加される」旨を注記として記載しておくと、将来のi18n対応Issue作成時に漏れがない。

---

### SF-3: encodeURIComponent修正に伴うセキュリティ検証

**カテゴリ**: セキュリティ
**場所**: `src/lib/path-validator.ts` L29-68, `route.ts` L96-123

**問題**:
`encodeURIComponent`の修正（`path.split('/').map(encodeURIComponent).join('/')`）が、パストラバーサル防止の`isPathSafe()`検証を回避しないことの確認が必要。

**分析結果**:
1. `path-validator.ts` L41-47: `decodeURIComponent(targetPath)`で入力パスをデコードしてから検証する。個別セグメントエンコード方式でも、Next.jsが自動デコードした後のパスが`pathSegments.join('/')`で結合されるため、`isPathSafe()`に渡される時点では通常の相対パスになっている
2. Next.jsの`[...path]` catch-all routeは、URLの各スラッシュ区切りセグメントを配列要素として提供する。`/api/worktrees/id/files/src/newdir`は`params.path = ['src', 'newdir']`となり、`pathSegments.join('/') = 'src/newdir'`で正しいパスになる
3. 攻撃ベクトル: `..%2F`のようなエンコードされたトラバーサルパターンは、Next.jsのURL解析時に`..`セグメントとして認識されるか、`isPathSafe()`内のdecodeURIComponentで検出される

**推奨対応**:
統合テストレベルで以下のケースを検証:
- `encodePathForUrl('../etc/passwd')` が `..%2Fetc%2Fpasswd` ではなく `../etc/passwd` を生成し、Next.jsが適切にルーティング拒否すること
- `isPathSafe('..', root)` が `false` を返すこと（既存テストで検証済みの可能性が高い）

---

## Nice to Have（あれば良い）

### NTH-1: モバイルでのツールバータッチターゲットサイズ

**カテゴリ**: UI影響
**場所**: `src/components/worktree/WorktreeDetailRefactored.tsx` L850-881

MobileContentコンポーネントはFileTreeViewをそのまま使用しているため、ツールバーはデスクトップ・モバイル両方で自動表示される。追加変更は不要だが、モバイルでのタッチターゲットサイズ（最小44x44px推奨、WCAG 2.5.5）を考慮したスタイリングが望ましい。

---

### NTH-2: WorktreeDetailRefactored.test.tsxのFileTreeViewモック更新

**カテゴリ**: テスト影響
**場所**: `tests/unit/components/WorktreeDetailRefactored.test.tsx` L146-171

FileTreeViewのモックにツールバーUIが含まれていないため、E2Eレベルでの統合検証が必要になる可能性がある。ただし、既存のonNewFile/onNewDirectoryコールバック接続テスト（L543-646）は影響を受けない。

---

### NTH-3: コンテキストメニューとツールバーの動作差異の明示

**カテゴリ**: UI影響
**場所**: `src/components/worktree/ContextMenu.tsx` L100-108

コンテキストメニューの`New Directory`はtargetPathを渡し（対象ディレクトリ配下に作成）、ツールバーの`New Directory`は空文字列を渡す（ルートに作成）。ツールバーボタンにtitle属性（例: `title="Create in root directory"`）を追加するとユーザビリティが向上する。

---

## 影響範囲マトリクス

### 変更が必要なファイル

| ファイル | 変更種別 | 影響度 | 備考 |
|---------|---------|--------|------|
| `src/components/worktree/FileTreeView.tsx` | UI追加 | **高** | 非空状態にルートレベルツールバーを追加 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | ロジック修正 | **中** | encodeURIComponent修正（5箇所） |
| `tests/unit/components/worktree/FileTreeView.test.tsx` | テスト追加 | **中** | 非空状態ツールバーのテスト追加 |
| `tests/unit/components/WorktreeDetailRefactored.test.tsx` | テスト追加（任意） | **低** | パスエンコードのテスト追加 |

### 変更不要なファイル

| ファイル | 理由 |
|---------|------|
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | フロントエンド側のエンコード修正のみで対応可能 |
| `src/lib/path-validator.ts` | decodeURIComponent処理が既にあり影響なし |
| `src/lib/file-operations.ts` | パス処理は正常動作（検証済み） |
| `src/components/worktree/ContextMenu.tsx` | 動作変更不要 |
| `tests/unit/lib/file-operations.test.ts` | バックエンド変更なし |
| `locales/en/*.json`, `locales/ja/*.json` | i18nキー追加は本Issue範囲外 |

### 破壊的変更

なし。ツールバー追加は既存UIに影響せず、encodeURIComponent修正は既存動作を改善するのみ。

### 依存関係への影響

なし。外部ライブラリの追加・更新は不要。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/FileTreeView.tsx`: 主要修正対象（ツールバー追加）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/WorktreeDetailRefactored.tsx`: encodeURIComponent修正対象
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/ContextMenu.tsx`: コンテキストメニュー動作確認
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/app/api/worktrees/[id]/files/[...path]/route.ts`: APIルートパス処理
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/lib/path-validator.ts`: パストラバーサル防止ロジック

### テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/tests/unit/components/worktree/FileTreeView.test.tsx`: 空状態ボタンの既存テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/tests/unit/components/WorktreeDetailRefactored.test.tsx`: ファイル操作ハンドラーテスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/tests/unit/lib/file-operations.test.ts`: バックエンドファイル操作テスト（影響なし）
