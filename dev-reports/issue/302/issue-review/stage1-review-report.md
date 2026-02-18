# Issue #302 レビューレポート

**レビュー日**: 2026-02-18
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 5 |
| Nice to Have | 2 |

**総合評価**: 要改善

Issue の全体構成は良好で、背景・提案・実装タスク・受入条件が体系的に記述されている。しかし、Next.js の設定レベルでの制約（bodySizeLimit、CSP）が見落とされており、これらは実装時にブロッキングイシューとなる。また、既存コードパターンとの整合性（image-extensions.ts と対になる video-extensions.ts の設計）や、Base64 方式での大容量ファイル配信の注意事項についても補足が必要。

---

## Must Fix（必須対応）

### FINDING-001: next.config.js の bodySizeLimit 更新が実装タスクに未記載

**カテゴリ**: 完全性
**場所**: 実装タスク / 影響範囲セクション

**問題**:
現在の `next.config.js` では `experimental.serverActions.bodySizeLimit` が `'6mb'` に設定されている（L20、コメントに「5MB + overhead」と記載）。15MB の mp4 ファイルをアップロードするには、この値を `'16mb'` 程度に引き上げる必要がある。しかし Issue の実装タスクおよび影響範囲の変更対象ファイルに `next.config.js` が含まれていない。

**証拠**:
```javascript
// next.config.js L17-21
experimental: {
  serverActions: {
    // [CONS-006] Increased from 2mb to 6mb for file upload support (5MB + overhead)
    bodySizeLimit: '6mb',
  },
},
```

この設定変更がなければ、15MB の mp4 アップロードは Next.js のリクエストボディサイズ制限により HTTP 413 エラーで失敗する。

**推奨対応**:
実装タスクに「`next.config.js` の `bodySizeLimit` を `'16mb'`（15MB + overhead）に更新する」を追加し、影響範囲の変更対象ファイルにも `next.config.js` を含める。

---

### FINDING-002: Content-Security-Policy に media-src ディレクティブが未設定

**カテゴリ**: 完全性
**場所**: 実装タスク / 影響範囲セクション

**問題**:
`next.config.js` の CSP ヘッダーには `img-src 'self' data: blob:` が設定されているが、`media-src` ディレクティブが存在しない。CSP の仕様上、`media-src` が未指定の場合は `default-src`（現在 `'self'`）にフォールバックする。VideoViewer で `data:` URI 方式（Base64）を使用する場合、`media-src` に `'self' data:` を追加しないと、ブラウザが `<video>` 要素の `data:` URI ソースをブロックする。

**証拠**:
```javascript
// next.config.js L58-66
value: [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",        // 画像は data: 許可済み
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  // media-src が存在しない -> default-src 'self' にフォールバック -> data: URI がブロックされる
].join('; '),
```

**推奨対応**:
実装タスクに「`next.config.js` の CSP ヘッダーに `media-src 'self' data:` を追加する」を追加する。影響範囲にも `next.config.js` を含める。

---

## Should Fix（推奨対応）

### FINDING-003: FileViewer.tsx の canCopy ロジックに isVideo 除外が受入条件に含まれていない

**カテゴリ**: 完全性
**場所**: 受入条件 / 実装タスク「FileViewer に動画表示分岐を追加」

**問題**:
現在の `FileViewer.tsx` の `canCopy` は以下の判定ロジックを使用している:

```typescript
// src/components/worktree/FileViewer.tsx L55-58
const canCopy = useMemo(
  () => Boolean(content?.content && !content.isImage),
  [content]
);
```

`isVideo` フラグ追加後、動画ファイルに対してもコピーボタンが表示されてしまう（20MB 程度の Base64 data URI がクリップボードにコピーされても無意味）。

**推奨対応**:
実装タスクの「FileViewer に動画表示分岐を追加」の項目に、`canCopy` ロジックの修正（`!content.isImage && !content.isVideo`）を明記する。または受入条件に「動画ファイルにコピーボタンが表示されないこと」を追加する。

---

### FINDING-004: MP4 magic bytes 検証の仕様詳細が不足

**カテゴリ**: 正確性
**場所**: 実装タスク「uploadable-extensions.ts に mp4 バリデータを追加」

**問題**:
Issue には「magic bytes 検証」と記載されているが、MP4 ファイルの具体的な magic bytes 仕様が明記されていない。仮説検証結果で「offset 4 で ftyp 文字列を検証すべき」と確認されているが、Issue 本文に反映されていない。

MP4 は ISOBMFF (ISO Base Media File Format) 構造を持ち:
- Offset 0-3: ボックスサイズ（可変値）
- Offset 4-7: ボックスタイプ `ftyp` (0x66, 0x74, 0x79, 0x70)

既存の `MagicBytesDefinition` は `offset` フィールドをサポートしている:

```typescript
// src/config/uploadable-extensions.ts L14-19
export interface MagicBytesDefinition {
  bytes: number[];
  offset?: number;
}
```

**推奨対応**:
実装タスクに具体的な magic bytes 仕様を追記する:
```typescript
magicBytes: [{ bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }] // 'ftyp' at offset 4
```

---

### FINDING-005: video-extensions.ts 新規作成の必要性について設計根拠が不明確

**カテゴリ**: 整合性
**場所**: 新規作成ファイル（候補）/ 実装タスク

**問題**:
Issue では「新規作成ファイル（候補）」として `src/config/video-extensions.ts` を挙げつつ、実装タスクでは `src/config/uploadable-extensions.ts` への直接追加を記載している。方針が二つ存在し、どちらを採用するか明確でない。

既存の `image-extensions.ts` は `uploadable-extensions.ts` とは別に独立したユーティリティを提供しており、GET API ルート（`route.ts`）で `isImageExtension()` を使った画像判定分岐に利用されている:

```typescript
// src/app/api/worktrees/[id]/files/[...path]/route.ts L146
if (isImageExtension(ext)) {
```

動画判定でも同様のパターン（`isVideoExtension(ext)` による分岐）が必要であり、`video-extensions.ts` を作成する方が `image-extensions.ts` との整合性が保たれる。

**推奨対応**:
`video-extensions.ts` を新規作成する方針を明確にし、最低限以下を含める:
- `VIDEO_EXTENSIONS` 定数
- `isVideoExtension()` 関数
- `getMimeTypeByVideoExtension()` 関数
- `validateVideoMagicBytes()` 関数

---

### FINDING-006: 15MB Base64 data URI 方式の性能・UX 影響に関する注意事項が未記載

**カテゴリ**: 性能
**場所**: 設計方針セクション

**問題**:
15MB のバイナリファイルを Base64 エンコードすると約 20MB の文字列になる。これを JSON レスポンスに含めて返却すると:
1. サーバー側で 15MB バッファ + 20MB Base64 文字列のメモリ消費
2. クライアント側で 20MB の JSON パース
3. ブラウザの DOM に 20MB の data URI が埋め込まれる

画像の場合は最大 5MB（Base64 で約 6.7MB）なので問題にならなかったが、15MB は約 3 倍のサイズ。

**推奨対応**:
設計方針に以下を追記する:
- Base64 変換で約 1.33 倍（~20MB）のデータ量になること
- レスポンスの読み込みに数秒かかる可能性があること
- VideoViewer にローディングインジケーターを実装すること
- 将来的にストリーミング方式への移行を検討する旨

---

### FINDING-007: binary-extensions.ts の統合パターンに関する検討事項

**カテゴリ**: 整合性
**場所**: 影響範囲セクション「関連コンポーネント」

**問題**:
Issue では `binary-extensions.ts` について「mp4 は既に登録済み（変更不要）」と記載している。しかし `binary-extensions.ts` は `IMAGE_EXTENSIONS` を import してスプレッドするパターンを採用している:

```typescript
// src/config/binary-extensions.ts L11, L20-21
import { IMAGE_EXTENSIONS } from './image-extensions';

export const BINARY_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  // ...
  '.mp4',  // L55: 直接リテラルで記載
```

`video-extensions.ts` を新規作成する場合、`VIDEO_EXTENSIONS` も同様にスプレッドする形に統合すべきか検討が必要。

**推奨対応**:
影響範囲の確認事項に `binary-extensions.ts` の統合パターン検討を追記する。

---

## Nice to Have（あれば良い）

### FINDING-008: i18n 対応に関する記載がない

**カテゴリ**: 完全性
**場所**: 実装タスク「VideoViewer 新規作成」

**問題**:
VideoViewer コンポーネントを新規作成する際、エラーメッセージやアクセシビリティラベルの i18n 対応方針が記載されていない。既存の ImageViewer はハードコードされた英語メッセージを使用しているため同じパターンで問題ないが、方針を明記しておくと実装時の判断が容易。

**推奨対応**:
「ImageViewer と同等の方針（現時点では英語ハードコード）」を付記する。

---

### FINDING-009: アクセシビリティ要件が明示されていない

**カテゴリ**: 完全性
**場所**: 設計方針 / 受入条件

**問題**:
受入条件に「再生/停止コントロール付き」とあるが、HTML5 `<video>` タグの `controls` 属性使用かカスタムコントロールかが明確でない。

**推奨対応**:
「HTML5 `<video>` タグの `controls` 属性を使用し、ブラウザネイティブの再生コントロールを利用する」旨を明記する。

---

## 参照ファイル

### コード
| ファイル | 関連内容 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/next.config.js` (L20) | bodySizeLimit が '6mb' に設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/next.config.js` (L58-66) | CSP ヘッダーに media-src 未設定 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/components/worktree/FileViewer.tsx` (L55-58) | canCopy ロジック |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/config/uploadable-extensions.ts` (L14-19) | MagicBytesDefinition（offset 対応済み） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/config/image-extensions.ts` | video-extensions.ts の設計パターン参考元 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/config/binary-extensions.ts` (L55) | mp4 が直接リテラルで登録済み |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/app/api/worktrees/[id]/files/[...path]/route.ts` (L146-191) | 画像判定・Base64変換ロジック |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/app/api/worktrees/[id]/upload/[...path]/route.ts` | アップロード API |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/src/components/worktree/ImageViewer.tsx` | VideoViewer の参考実装パターン |

### ドキュメント
| ファイル | 関連内容 |
|---------|---------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-302/CLAUDE.md` | プロジェクト構成・モジュール一覧 |
