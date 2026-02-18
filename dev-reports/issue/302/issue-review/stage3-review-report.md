# Issue #302 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 2 |

**総合評価**: 要改善

Stage 1-2 で Issue 本文は大幅に改善されているが、影響範囲の分析においていくつかの重要な漏れが検出された。特に `bodySizeLimit` の適用範囲の誤認識と、FileViewerPage のローカル型定義の影響が Must Fix として対応が必要。

---

## Must Fix（必須対応）

### FINDING-S3-001: bodySizeLimit は Server Actions 専用であり、Route Handler（upload API）には適用されない

**カテゴリ**: 影響範囲
**対象ファイル**: `next.config.js`, `src/app/api/worktrees/[id]/upload/[...path]/route.ts`

**問題**:

`next.config.js` の `experimental.serverActions.bodySizeLimit` は Next.js の Server Actions のリクエストボディサイズ制限であり、Route Handler には直接適用されない可能性がある。

現在のコード:

```javascript
// next.config.js (L17-22)
experimental: {
  serverActions: {
    // [CONS-006] Increased from 2mb to 6mb for file upload support (5MB + overhead)
    bodySizeLimit: '6mb',
  },
},
```

upload API は Route Handler（`route.ts` の `POST` 関数）であり、Server Action ではない:

```typescript
// src/app/api/worktrees/[id]/upload/[...path]/route.ts (L100)
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; path: string[] } }
) {
```

Next.js 14.2.x では `serverActions.bodySizeLimit` が Route Handler にも影響する挙動が報告されているが、公式ドキュメントでは Server Actions 専用と明記されている。16mb に変更しても upload API に効果がない可能性がある。

**推奨対応**:

Issue の実装タスクに以下を追記する:
1. 15MB mp4 ファイルの実アップロードテストを行い、`bodySizeLimit` の適用範囲を検証する
2. Route Handler に適用されない場合は、upload API の `route.ts` に Route Segment Config を追加するか、代替手段を適用する

---

### FINDING-S3-002: FileViewerPage がローカル FileContent 型を定義しており isVideo に未対応

**カテゴリ**: 影響範囲
**対象ファイル**: `src/app/worktrees/[id]/files/[...path]/page.tsx`

**問題**:

FileViewerPage コンポーネントは `src/types/models.ts` の `FileContent` 型を import せず、独自のローカル `FileContent` インターフェースを定義している:

```typescript
// src/app/worktrees/[id]/files/[...path]/page.tsx (L16-21)
interface FileContent {
  path: string;
  content: string;
  extension: string;
  worktreePath: string;
}
```

この型には `isImage` も `isVideo` も含まれていない。mp4 ファイルを直接 URL でアクセスした場合（`/worktrees/[id]/files/path/to/video.mp4`）、API は `isVideo: true` と Base64 data URI を返すが、FileViewerPage はこのフラグを認識できず、約 20MB の Base64 文字列がテキストとしてそのまま `<code>` ブロック内に表示されてしまう。

Issue の変更対象ファイルにこのページが含まれていない。

**推奨対応**:

変更対象ファイルに `src/app/worktrees/[id]/files/[...path]/page.tsx` を追加する。対応方針として:
- ローカル `FileContent` 型を `src/types/models.ts` からの import に置き換える
- `isImage`/`isVideo` フラグに基づく適切な表示分岐を追加する
- または、このページが実運用で使われていない場合はその旨を明記する

---

## Should Fix（推奨対応）

### FINDING-S3-003: テスト対象の網羅性が不十分

**カテゴリ**: 完全性
**対象ファイル**: 各テストファイル

**問題**:

Issue の実装タスクには「ユニットテスト・結合テストを追加」とあるが、具体的なテストケースが未記載。既存のテスト構造を分析すると、最低限以下が必要:

| テストファイル | テスト内容 | 種別 |
|-------------|---------|------|
| `tests/unit/config/uploadable-extensions.test.ts` | mp4 の isUploadableExtension/validateMimeType/validateMagicBytes/getMaxFileSize | Unit |
| `tests/unit/config/video-extensions.test.ts` | 新規作成。isVideoExtension/getMimeTypeByVideoExtension | Unit |
| `tests/integration/api/file-upload.test.ts` | mp4 アップロードバリデーション | Integration |
| `tests/integration/api-file-operations.test.ts` | GET API 動画ファイル取得 | Integration |

**推奨対応**:

実装タスクのテスト項目を上記の具体的なテストファイル名とテストケースで置き換える。

---

### FINDING-S3-004: FileTreeView.tsx の FileIcon に mp4 用アイコン色が未定義

**カテゴリ**: 影響範囲
**対象ファイル**: `src/components/worktree/FileTreeView.tsx`

**問題**:

FileIcon コンポーネントの `colorMap` に mp4 が含まれていない:

```typescript
// src/components/worktree/FileTreeView.tsx (L241-254)
const colorMap: Record<string, string> = {
  ts: 'text-blue-500',
  tsx: 'text-blue-500',
  js: 'text-yellow-400',
  // ... mp4 が未定義
};
```

デフォルト色 `'text-gray-400'` が適用されるため表示自体は問題ないが、動画ファイルであることを視覚的に区別できない。

**推奨対応**:

影響範囲の「変更不要だが確認が必要」セクションに、FileIcon の colorMap への mp4 エントリ追加を検討事項として記載する。

---

### FINDING-S3-005: CSP の media-src に blob: URI を含めるかどうかの設計判断

**カテゴリ**: 影響範囲
**対象ファイル**: `next.config.js`

**問題**:

Issue では `media-src 'self' data:` を追加する方針だが、`img-src` には `blob:` が含まれている（`'self' data: blob:`）。現在の設計では Base64 data URI 方式を使用するため `blob:` は不要だが、将来的にストリーミング方式に移行する場合は `blob:` が必要になる。

**推奨対応**:

設計方針に「現時点では data: のみで十分。将来ストリーミング方式に移行する場合は blob: の追加を検討する」旨を追記する。最小権限原則に従い、現時点では `blob:` を含めない判断は正しい。

---

### FINDING-S3-006: FileContent 型の isVideo フラグ追加による後方互換性確認

**カテゴリ**: 整合性
**対象ファイル**: `src/types/models.ts`, `src/components/worktree/FileViewer.tsx`

**問題**:

`FileContent` インターフェースに `isVideo?: boolean` をオプショナルフィールドとして追加する方針は後方互換性を維持する。FileContent を参照している箇所:

1. `FileViewer.tsx` (L49) - canCopy ロジック修正が必要（Issue に記載済み）
2. `FileViewerPage` (L16-21) - ローカル型のため影響なし（ただし FINDING-S3-002 の問題あり）
3. `FileContentResponse` 型 (L299) - 自動的に isVideo が含まれる

TypeScript のコンパイルエラーは発生しないが、canCopy の修正漏れがないことを確認する必要がある。

**推奨対応**:

Issue に isVideo がオプショナルフィールドであることを明記し、既存コードの TypeScript コンパイルに影響がないことを確認する。

---

### FINDING-S3-007: upload API のサイズ検証順序最適化

**カテゴリ**: 影響範囲
**対象ファイル**: `src/app/api/worktrees/[id]/upload/[...path]/route.ts`

**問題**:

現在の upload API では以下の順序で処理している:

```typescript
// L136: ファイルサイズ取得
const fileSize = file.size;

// L149-151: ファイル全体をメモリに読み込み
const arrayBuffer = await file.arrayBuffer();
const buffer = Buffer.from(arrayBuffer);

// L154: Magic bytes 検証
// L159: サイズ検証（ここで初めてサイズチェック）
const maxSize = getMaxFileSize(ext);
if (fileSize > maxSize) { ... }
```

15MB のファイルでは `arrayBuffer()` + `Buffer.from()` で約 30MB のメモリを消費した後にサイズチェックが行われる。`file.size` は `formData()` 取得時点で利用可能なため、サイズ検証を `arrayBuffer()` 前に移動することで、大きすぎるファイルを早期に拒否できる。

**推奨対応**:

サイズ検証の順序を最適化し、`file.size` チェックを `arrayBuffer()` 呼び出し前に移動する。

---

## Nice to Have（あれば良い）

### FINDING-S3-008: CLAUDE.md のモジュール一覧更新

**カテゴリ**: 完全性
**対象ファイル**: `CLAUDE.md`

**問題**:

実装完了後、CLAUDE.md の主要モジュール一覧に `video-extensions.ts` と `VideoViewer.tsx` のエントリを追記する必要がある。

**推奨対応**:

実装完了時のドキュメント更新チェックリストとして記録する。

---

### FINDING-S3-009: モバイルレイアウトでの動画再生の動作確認

**カテゴリ**: 影響範囲
**対象ファイル**: `src/components/worktree/VideoViewer.tsx`, `src/components/worktree/FileViewer.tsx`

**問題**:

FileViewer はデスクトップとモバイルの両方で使用されている（WorktreeDetailRefactored.tsx の L1839-1844 と L2065-2070）。モバイル固有の変更は不要だが、VideoViewer の表示サイズが FileViewer の `max-h-[60vh] sm:max-h-[70vh]` 制約内で適切かどうかの確認が必要。

**推奨対応**:

受入条件または実装タスクに、モバイル画面での動画プレーヤー表示確認を追記する。

---

## 影響ファイル総覧

### Issue に記載済みの変更対象ファイル

| ファイル | 影響 | 状態 |
|---------|------|------|
| `next.config.js` | bodySizeLimit / CSP 更新 | 記載済み（FINDING-S3-001 の追加確認が必要） |
| `src/config/uploadable-extensions.ts` | mp4 バリデータ追加 | 記載済み |
| `src/config/video-extensions.ts` | 新規作成 | 記載済み |
| `src/types/models.ts` | isVideo フラグ追加 | 記載済み |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 動画判定ロジック追加 | 記載済み |
| `src/components/worktree/VideoViewer.tsx` | 新規作成 | 記載済み |
| `src/components/worktree/FileViewer.tsx` | 動画分岐 + canCopy 修正 | 記載済み |

### Issue に未記載の影響ファイル（本レビューで検出）

| ファイル | 影響 | 重要度 |
|---------|------|--------|
| `src/app/worktrees/[id]/files/[...path]/page.tsx` | ローカル FileContent 型に isVideo 未定義 | Must Fix |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | サイズ検証順序の最適化 | Should Fix |
| `src/components/worktree/FileTreeView.tsx` | FileIcon colorMap に mp4 未定義 | Should Fix |
| `CLAUDE.md` | モジュール一覧更新 | Nice to Have |

### Issue に「変更不要」と記載済みで確認完了のファイル

| ファイル | 確認結果 |
|---------|---------|
| `src/config/binary-extensions.ts` | mp4 は L55 に直接リテラルとして登録済み。変更不要。 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | UPLOADABLE_EXTENSIONS を動的参照（L41, L1869, L2095）。mp4 追加で自動対応。変更不要。 |
| `src/lib/file-search.ts` | BINARY_EXTENSIONS 経由で mp4 除外済み。変更不要。 |

---

## 参照ファイル

### コード

| ファイル | 関連箇所 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/next.config.js` (L17-22) | `experimental.serverActions.bodySizeLimit` 設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/app/api/worktrees/[id]/upload/[...path]/route.ts` (L100-210) | upload Route Handler |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/app/worktrees/[id]/files/[...path]/page.tsx` (L16-21) | ローカル FileContent 型 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/components/worktree/FileTreeView.tsx` (L236-274) | FileIcon colorMap |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/types/models.ts` (L280-293) | FileContent インターフェース |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/components/worktree/FileViewer.tsx` (L49-58) | canCopy ロジック |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/config/image-extensions.ts` | video-extensions.ts の設計パターン参考元 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/tests/unit/config/uploadable-extensions.test.ts` | 既存テスト（mp4 テスト追加が必要） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/tests/integration/api/file-upload.test.ts` | 既存テスト（mp4 テスト追加が必要） |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/CLAUDE.md` | モジュール一覧への追記が必要 |
