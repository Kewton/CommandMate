# Architecture Review: Issue #302 - mp4 Upload Design Policy

## Stage 1: Design Principles Review (SOLID/KISS/YAGNI/DRY)

| Item | Value |
|------|-------|
| Issue | #302 |
| Stage | 1 - Design Principles Review |
| Date | 2026-02-18 |
| Status | Conditionally Approved |
| Score | 4/5 |

---

## Executive Summary

Issue #302 の設計方針書は、既存の画像ファイルパイプラインを動画に拡張する堅実なアプローチを採用しており、全体として高品質な設計である。`image-extensions.ts` -> `video-extensions.ts`、`ImageViewer` -> `VideoViewer` の対称的なパターンはコードベースの一貫性を維持し、SRP に準拠している。

しかし、DRY 原則に関して2点の必須修正事項がある。`normalizeExtension()` の共通化方針が曖昧であること、および `ERROR_CODE_TO_HTTP_STATUS` マッピングの既存重複を悪化させるリスクがある点は、実装前に設計方針書で明確化すべきである。

---

## Detailed Findings

### Must Fix (2 items)

#### DR-001: normalizeExtension() の重複定義リスク [DRY]

**深刻度**: must_fix

**問題**:
設計方針書の section 3-2 で `video-extensions.ts` に `normalizeExtension()` を定義する計画だが、同一関数が既に `image-extensions.ts` (L104-107) に存在する。設計方針書には以下の曖昧な記載がある:

> **[DRY]**: `normalizeExtension()`は`image-extensions.ts`からimportして共通化するか、同一実装を持つ。

この「するか」という表現は、重複実装を許容する余地を残している。

**現状のコードベース分析**:

| ファイル | normalizeExtension の実装方法 |
|---------|---------------------------|
| `src/config/image-extensions.ts` L104-107 | `export function normalizeExtension()` として定義 |
| `src/config/binary-extensions.ts` L99 | インラインで `ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()` |
| `src/config/uploadable-extensions.ts` L143, L155 | `extension.toLowerCase()` のみ（ドット正規化なし） |

**改善提案**:
`normalizeExtension()` を共通ユーティリティ（例: `src/lib/extension-utils.ts`）に抽出し、全ファイルからimportする形に統一する。設計方針書の表現を「`image-extensions.ts` からimportして共通化する」に確定させること。

---

#### DR-009: ERROR_CODE_TO_HTTP_STATUS マッピングの重複 [DRY]

**深刻度**: must_fix

**問題**:
`files/route.ts` (L46-71) と `upload/route.ts` (L41-57) に同一の `ERROR_CODE_TO_HTTP_STATUS` マッピングが重複定義されている。

```typescript
// files/[...path]/route.ts L46-71
const ERROR_CODE_TO_HTTP_STATUS: Record<string, number> = {
  FILE_NOT_FOUND: 404,
  WORKTREE_NOT_FOUND: 404,
  // ... 17 entries
};

// upload/[...path]/route.ts L41-57
const ERROR_CODE_TO_HTTP_STATUS: Record<string, number> = {
  FILE_NOT_FOUND: 404,
  WORKTREE_NOT_FOUND: 404,
  // ... 12 entries (subset)
};
```

Issue #302 で `files/route.ts` に動画分岐を追加し、`upload/route.ts` のサイズ検証順序を変更する際に、この既存の重複が更に乖離するリスクがある。

**改善提案**:
`ERROR_CODE_TO_HTTP_STATUS` を `src/lib/api-error-codes.ts` 等の共通モジュールに抽出し、両 `route.ts` から import する。Issue #302 のスコープ外であれば、設計方針書のトレードオフ/技術的負債セクションに明記すること。

---

### Should Fix (5 items)

#### DR-002: FileViewer の isImage/isVideo 条件分岐が OCP に反する [OCP]

**深刻度**: should_fix

**問題**:
`FileViewer.tsx` に `content.isVideo` の分岐を追加することで、既存コードを直接変更する必要がある。

```typescript
// 現在 (FileViewer.tsx L56)
const canCopy = useMemo(
  () => Boolean(content?.content && !content.isImage),
  [content]
);

// 変更後（設計方針書 section 3-7）
const canCopy = !content.isImage && !content.isVideo;
```

```typescript
// 現在 (FileViewer.tsx L169)
{content.isImage ? (
  <ImageViewer ... />
) : (
  // text rendering
)}

// 変更後: isVideo分岐追加が必要
```

将来 `isAudio`, `isPdf` 等が追加されるたびに FileViewer を修正し続ける必要がある。

**改善提案**:
現時点では mp4 のみの追加であり YAGNI 原則との兼ね合いで if-else 追加は許容範囲内。ただし、設計方針書に「将来のメディアタイプ追加時に mediaType ベースのルーティングへリファクタリングする」旨のコメントを記載すること。

---

#### DR-003: ImageExtensionValidator と VideoExtensionValidator の重複インターフェース [DRY]

**深刻度**: should_fix

**問題**:
3つの類似インターフェースが存在することになる:

| インターフェース | ファイル | フィールド |
|---------------|---------|----------|
| `ImageExtensionValidator` | `image-extensions.ts` L38-47 | extension, mimeType, magicBytes?, magicBytesOffset? |
| `VideoExtensionValidator` | `video-extensions.ts` (新規) | extension, mimeType, magicBytes?, magicBytesOffset? |
| `UploadableExtensionValidator` | `uploadable-extensions.ts` L27-36 | extension, maxFileSize, allowedMimeTypes, magicBytes? (MagicBytesDefinition[]) |

特に `ImageExtensionValidator` と `VideoExtensionValidator` は完全に同一構造。

**改善提案**:
共通の `MediaExtensionValidator` インターフェースを定義し、Image/Video がそれを利用する形に統一する。magic bytes の表現方法も `magicBytesOffset` (image) vs `MagicBytesDefinition.offset` (uploadable) の不統一を解消する。

---

#### DR-004: GET API route.ts の画像/動画処理ロジック重複 [DRY]

**深刻度**: should_fix

**問題**:
`route.ts` の GET ハンドラー (L146-191) の画像処理ブロックと、追加予定の動画処理ブロックで以下のロジックが重複する:

1. `readFile(absolutePath)` でバイナリ読み込み
2. バリデーション実行
3. `Buffer.toString('base64')` で Base64 変換
4. `data:${mimeType};base64,${base64}` で data URI 構築
5. JSON レスポンス構築（`isImage/isVideo: true`）
6. ENOENT エラーハンドリング

**改善提案**:
共通のメディアファイル処理ヘルパー関数を抽出する:

```typescript
async function processMediaFile(
  absolutePath: string,
  ext: string,
  mediaType: 'image' | 'video'
): Promise<{ content: string; mimeType: string } | { error: NextResponse }>
```

---

#### DR-008: binary-extensions.ts に VIDEO_EXTENSIONS の spread 追加が未記載 [DRY]

**深刻度**: should_fix

**問題**:
`binary-extensions.ts` (L20) では `IMAGE_EXTENSIONS` を spread して `BINARY_EXTENSIONS` に含めている:

```typescript
export const BINARY_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,  // L21
  // ...
  '.mp4',              // L55 (ハードコード)
  // ...
];
```

`video-extensions.ts` に `VIDEO_EXTENSIONS` 配列を定義する以上、`binary-extensions.ts` でも `VIDEO_EXTENSIONS` を import して spread するのが DRY 原則に適う。設計方針書の変更ファイル一覧に `binary-extensions.ts` が含まれていない。

**改善提案**:
設計方針書の変更ファイル一覧に `binary-extensions.ts` を追加し、`...VIDEO_EXTENSIONS` を含める修正を記載する。

---

#### DR-006: page.tsx の型統一は独立した改善 [DRY]

**深刻度**: should_fix

**問題**:
`page.tsx` (L16-21) のローカル `FileContent` 型には `isImage` フィールドが含まれておらず、画像ファイルの直接URL表示が既に正しく動作していない可能性がある:

```typescript
// page.tsx L16-21 (current)
interface FileContent {
  path: string;
  content: string;
  extension: string;
  worktreePath: string;
}
// isImage?, isVideo?, mimeType? が欠落
```

**改善提案**:
Issue #302 に含めて実施して問題ないが、コミットを分けて変更理由の追跡性を向上させること。

---

### Nice to Have (4 items)

#### DR-005: VideoViewerProps の alt プロパティの命名 [ISP]

HTML の `<video>` 要素には `alt` 属性が存在しない。ImageViewer との一貫性は保たれるが、セマンティクスとして不正確。JSDoc で「ファイル名（アクセシビリティ用ラベルとして使用）」と説明を付記すれば十分。

#### DR-007: video-extensions.ts の SRP 準拠は適切 [SRP]

動画拡張子の判定・バリデーション責務が image-extensions.ts の画像責務と適切に分離されている。エクスポート関数名のパターン（`isXxxExtension`, `getMimeTypeByXxxExtension`, `validateXxxMagicBytes`）も揃えられている。

#### DR-010: Base64 data URI 方式の性能テスト基準 [KISS]

15MB ファイルが約 20MB の JSON レスポンスとなる。KISS 原則に基づくトレードオフとして妥当だが、受け入れ基準（レスポンス時間、メモリ使用量等）が未定義。設計方針書のパフォーマンスセクションに追記推奨。

#### DR-011: VIDEO_EXTENSIONS 配列の YAGNI 考慮 [YAGNI]

mp4 のみなら配列にする必要はないが、`IMAGE_EXTENSIONS` との一貫性を考えると配列形式が妥当。YAGNI 違反には該当しない。

---

## Risk Assessment

| Risk Type | Level | Description |
|-----------|-------|-------------|
| Technical | Low | 既存パイプラインの拡張であり、新規アーキテクチャの導入はない |
| Security | Low | magic bytes 検証、MIME検証、サイズ制限、CSP設定が適切に計画されている |
| Operational | Low | Base64方式による15MBファイルのメモリ使用増加は限定的 |

---

## Design Principles Compliance Summary

| Principle | Assessment | Notes |
|-----------|-----------|-------|
| SRP | Compliant | video-extensions.ts の独立ファイル化は適切 |
| OCP | Partially Compliant | FileViewer への条件分岐追加は OCP に反するが、YAGNI との兼ね合いで許容 |
| LSP | Compliant | VideoViewer は ImageViewer と同一の Props パターン（src, alt, mimeType?, onError?）を採用 |
| ISP | Compliant | VideoViewerProps は必要最小限のプロパティのみ定義 |
| DIP | Compliant | 具体実装への直接依存なし、設定層を通じた拡張 |
| KISS | Compliant | Base64 data URI 方式はシンプルで既存パターンとの統一性がある |
| YAGNI | Compliant | mp4 のみのスコープ限定、ストリーミング等は将来検討に委ねている |
| DRY | Needs Improvement | normalizeExtension の共通化、ERROR_CODE_TO_HTTP_STATUS の重複、インターフェースの類似構造に改善余地 |

---

## Improvement Recommendations

### Must Fix (before implementation)

1. **DR-001**: `normalizeExtension()` の共通化方針を設計方針書で確定させる
2. **DR-009**: `ERROR_CODE_TO_HTTP_STATUS` の重複を共通モジュールに抽出するか、技術的負債として明記する

### Should Fix (during implementation)

3. **DR-002**: FileViewer に将来の mediaType ベースルーティングのコメントを追加
4. **DR-003**: `MediaExtensionValidator` 共通インターフェースの検討
5. **DR-004**: GET API のメディアファイル処理ヘルパー関数の抽出
6. **DR-008**: `binary-extensions.ts` の変更を設計方針書に追記
7. **DR-006**: `page.tsx` 型統一のコミット分離

### Consider (future improvement)

8. **DR-005**: VideoViewerProps の命名改善
9. **DR-010**: 性能テスト受け入れ基準の追記
10. **DR-011**: YAGNI 準拠確認済み（対応不要）

---

## Approval Status

**Conditionally Approved** - must_fix 2件（DR-001, DR-009）の設計方針書修正後に承認。設計全体の方向性は正しく、既存アーキテクチャとの整合性が高い。

---

*Reviewed by: Architecture Review Agent*
*Review date: 2026-02-18*
*Issue: #302 - mp4 Upload Design Policy*
