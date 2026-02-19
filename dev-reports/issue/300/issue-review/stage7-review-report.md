# Issue #300 レビューレポート - Stage 7

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー（2回目）
**Stage**: 7 / 影響範囲レビュー（2回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 1 |

**総合評価**: good

Stage 3で指摘した全ての問題（MF-1: encodeURIComponent全5箇所、MF-2: ツールバー共存方針、SF-1/SF-2/SF-3）はIssue本文に正しく反映されている。Stage 5で指摘した関数名修正（handleUpload -> handleFileInputChange）も反映済み。新たに1件のShould Fixを検出した。

---

## Stage 3 指摘事項の対応確認

### MF-1: encodeURIComponent全5箇所の修正 -- RESOLVED

Issue本文の「二次的問題」セクションに全5箇所が正確にテーブル形式で記載されている:

| 関数 | 行 | 状態 |
|------|-----|------|
| handleNewFile() | L1252 | 記載済み |
| handleNewDirectory() | L1279 | 記載済み |
| handleRename() | L1305 | 記載済み |
| handleDelete() | L1330 | 記載済み |
| handleFileInputChange() | L1408 | 記載済み（Stage 5 SF-1で関数名修正済み） |

共通ヘルパー `encodePathForUrl()` の抽出が対策案・受け入れ条件の両方に含まれている。

### MF-2: ツールバーと空状態ボタンの共存方針 -- RESOLVED

Option A（空状態ボタン維持 + 非空状態ツールバー追加）が明確に選択・記載されている。data-testid命名規則も受け入れ条件に含まれている:
- `data-testid='empty-new-directory-button'` -- 空状態用（既存）
- `data-testid='toolbar-new-directory-button'` -- 非空状態ツールバー用（新規）
- `data-testid='toolbar-new-file-button'` -- 非空状態ツールバー用（新規）

### SF-1 (テスト), SF-2 (i18n), SF-3 (セキュリティ) -- 全てRESOLVED

受け入れ条件のテストセクション、影響範囲のi18n注記、セキュリティ確認セクションに全て反映されている。

---

## Should Fix（推奨対応）

### SF-1: useFileOperations.tsおよび他コンポーネントのエンコーディング不統一が影響範囲として未記載

**カテゴリ**: 影響範囲の網羅性
**場所**: Issue本文の「二次的問題」セクション、影響範囲テーブル

**問題**:

コードベース内でファイルパスをAPIのURLに埋め込む際に2つの異なるパターンが混在しているが、Issueではこの不統一について言及されていない:

**パターン A: encodeURIComponent使用（WorktreeDetailRefactored.tsx -- 5箇所、Issue記載済み）**:
```typescript
// 問題: スラッシュが%2Fにエンコードされる
`/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}`
```

**パターン B: エンコーディングなし（useFileOperations.ts, FileViewer.tsx, MarkdownEditor.tsx, page.tsx）**:
```typescript
// スラッシュはそのまま -- catch-all routeで正しく動作
// ただし #, ?, % 等の特殊文字では問題が発生する
`/api/worktrees/${worktreeId}/files/${moveTarget.path}`
`/api/worktrees/${worktreeId}/files/${filePath}`
```

該当箇所:
| ファイル | 行 | 関数/コンテキスト |
|---------|-----|-------------------|
| `src/hooks/useFileOperations.ts` | L71 | handleMoveConfirm |
| `src/components/worktree/FileViewer.tsx` | L91 | fetchFile |
| `src/components/worktree/MarkdownEditor.tsx` | L216 | loadContent |
| `src/components/worktree/MarkdownEditor.tsx` | L252 | saveContent |
| `src/app/worktrees/[id]/files/[...path]/page.tsx` | L40 | fetchFile |

**推奨対応**:

Issueの影響範囲セクションに以下の注記を追加する:

> **注記（エンコーディング不統一）**: コードベース内にはパスをURLに直接埋め込む箇所（useFileOperations.ts L71、FileViewer.tsx L91、MarkdownEditor.tsx L216/L252）も存在する。これらはencodeURIComponentを使用していないため、スラッシュはcatch-all routeで正しくセグメント分割されるが、ファイル名に#や?等の特殊文字が含まれる場合に問題が発生するリスクがある。encodePathForUrl()ヘルパー導入後、将来的にこれらの箇所にも適用することを推奨する。ただし本Issue内での修正は任意とする。

この注記により、実装者がencodePathForUrl()ヘルパーの適用範囲を正しく判断でき、将来的な統一化への道筋が明確になる。

---

## Nice to Have（あれば良い）

### NTH-1: encodePathForUrl()ヘルパーの配置先ファイルが未指定

**カテゴリ**: 影響範囲の明確性
**場所**: Issue本文の「対策案」セクション

**問題**:

`encodePathForUrl()` ヘルパー関数の配置先として、具体的なファイルパスが記載されていない。

**推奨対応**:

`src/lib/url-utils.ts`（新規ファイル）または既存の `src/lib/utils.ts` への追加を推奨として明記する。プロジェクトには `src/lib/url-normalizer.ts`（Git URL正規化）が既に存在するが、用途が異なるため別ファイルが望ましい。

---

## 影響範囲の検証結果

### 変更対象ファイル -- 適切

Issue記載の4ファイルは全て適切:
- `src/components/worktree/FileTreeView.tsx` -- 主要修正（高優先度）
- `src/components/worktree/WorktreeDetailRefactored.tsx` -- encodeURIComponent修正（中優先度）
- `tests/unit/components/worktree/FileTreeView.test.tsx` -- テスト追加（高優先度）
- `tests/unit/components/WorktreeDetailRefactored.test.tsx` -- テスト追加（中優先度）

### 変更不要ファイル -- 適切

以下のファイルが変更不要とされている理由が妥当:
- `route.ts` -- APIルート側変更不要（catch-all routeの仕様で対応可能）
- `path-validator.ts` -- decodeURIComponent処理が既にあり正常動作
- `file-operations.ts` -- 検証済みで正常動作
- `ContextMenu.tsx` -- 既存動作に変更なし

### 破壊的変更 -- なし

空状態の既存UIは維持され、新規ツールバーの追加のみ。既存テストへの影響もない。

### テスト範囲 -- 適切

受け入れ条件に4つの具体的なテストケースが記載されている。

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/hooks/useFileOperations.ts` L66-80: handleMoveConfirmのパス直接埋め込み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/FileViewer.tsx` L90-92: filePathの直接埋め込み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/MarkdownEditor.tsx` L215-217, L251-253: filePathの直接埋め込み
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/WorktreeDetailRefactored.tsx` L1252, L1279, L1305, L1330, L1408: encodeURIComponent使用5箇所
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/components/worktree/FileTreeView.tsx` L827-861, L877-919: 空状態条件と非空状態ツリー描画
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/src/lib/path-validator.ts` L29-68: isPathSafe関数

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-300/CLAUDE.md`: モジュール構成・機能説明
