# Issue #474 設計方針書: メッセージ入力時画像ファイル添付機能

**作成日**: 2026-03-12
**Issue**: [#474 メッセージ入力時画像ファイルの添付をしたい](https://github.com/Kewton/CommandMate/issues/474)

---

## 1. アーキテクチャ設計

### システム構成図

```mermaid
graph TD
    UI[MessageInput.tsx<br/>画像添付ボタン] -->|①画像選択| FileInput[hiddenFileInput]
    FileInput -->|②FormData| UploadAPI[/api/worktrees/:id/upload/<br/>.commandmate/attachments/]
    UploadAPI -->|③保存完了 + imagePath| UI
    UI -->|④message + imagePath| SendAPI[/api/worktrees/:id/send]
    SendAPI -->|⑤cliTool.sendMessageWithImage| CLIManager[CLIToolManager]
    CLIManager -->|⑥固有方式 or フォールバック| CLITool[CLITool実装]
    CLITool -->|⑦tmux sendKeys| Session[tmuxセッション]
```

### 2層送信アーキテクチャ（Strategy パターン + ISP）

```
画像対応ツール（IImageCapableCLITool 実装クラス）
  → isImageCapableCLITool() 型ガードで判定
  → sendMessageWithImage(worktreeId, message, imagePath) で送信
  → 各CLIのネイティブ画像送信方式を使用

フォールバック方式（ICLITool のみ実装 / IImageCapableCLITool 未実装）
  → 送信ルート側でメッセージにパスを埋め込む
  → `${message}\n\n[添付画像: ${imagePath}]` 形式で sendMessage 呼び出し
```

### レイヤー構成

| レイヤー | 役割 | 対象ファイル |
|---------|------|-------------|
| プレゼンテーション層 | 画像添付UIボタン・状態管理 | MessageInput.tsx, WorktreeDetailRefactored.tsx |
| API層 | 画像アップロード・メッセージ送信 | upload/route.ts, send/route.ts |
| ビジネスロジック層 | CLIツール抽象化・画像送信 | cli-tools/*.ts, api-client.ts |
| 設定/バリデーション層 | 画像形式・セキュリティ検証 | image-extensions.ts, path-validator.ts |

---

## 2. 技術選定

| カテゴリ | 選定技術 | 選定理由 |
|---------|---------|---------|
| 画像アップロード | 既存 /upload/ API 拡張 | 既存のmagic bytes検証・パストラバーサル防御を再利用 |
| 画像バリデーション | image-extensions.ts | SVGセキュリティ・magic bytes検証が実装済み |
| パスバリデーション | path-validator.ts | isPathSafe / resolveAndValidateRealPath で防御済み |
| 画像保存先 | .commandmate/attachments/ | gitignore対象で意図しないgit追跡を防止 |
| 送信方式判定 | IImageCapableCLITool + 型ガード | ISP準拠 + Strategy パターン + 後方互換性の両立 [S1-M1] |

---

## 3. 設計パターン

### Strategy パターン（画像送信方式） + ISP準拠のインターフェース分離

各CLIツールが固有の送信方式を持つか、フォールバックを使うかを `IImageCapableCLITool` インターフェースの実装有無で判定する。

> **[S1-M1] ISP準拠**: `ICLITool` インターフェースには画像関連メソッドを追加しない。画像対応は別インターフェース `IImageCapableCLITool` として分離し、Interface Segregation Principle に準拠する。画像非対応のCLIツール実装が不要なメソッドを持たないようにする。

```typescript
// src/lib/cli-tools/types.ts への追加（ICLIToolは変更しない）
export interface IImageCapableCLITool extends ICLITool {
  supportsImage(): true;
  sendMessageWithImage(worktreeId: string, message: string, imagePath: string): Promise<void>;
}

// 型ガード関数
export function isImageCapableCLITool(tool: ICLITool): tool is IImageCapableCLITool {
  return typeof (tool as IImageCapableCLITool).supportsImage === 'function'
    && (tool as IImageCapableCLITool).supportsImage() === true;
}
```

> **[S1-S1] CLIToolInfo型は変更しない**: `CLIToolInfo` に `supportsImage` プロパティを追加しない（YAGNI原則）。UIは常に画像添付ボタンを表示し、送信時に `isImageCapableCLITool()` 型ガードで判定してフォールバック方式で動作する。CLIツール情報の取得時に画像対応可否を事前判定する必要はない。

### BaseCLITool デフォルト実装（フォールバック）

BaseCLIToolは `IImageCapableCLITool` を実装せず、フォールバック処理は送信ルート側で行う。

```typescript
// src/app/api/worktrees/[id]/send/route.ts での送信判定
// [S3-M3] 注意: 既存の send/route.ts は sendMessage に body.content を渡しているが、
// 新規追加する画像送信ロジックでは trimmedContent（バリデーション済み）を一貫して使用すること。
if (body.imagePath) {
  if (isImageCapableCLITool(cliTool)) {
    // 画像対応ツール: ネイティブ方式で送信
    await cliTool.sendMessageWithImage(params.id, trimmedContent, absoluteImagePath);
  } else {
    // フォールバック: ファイルパスをメッセージに含めて送信
    const messageWithPath = trimmedContent
      ? `${trimmedContent}\n\n[添付画像: ${absoluteImagePath}]`
      : `[添付画像: ${absoluteImagePath}]`;
    await cliTool.sendMessage(params.id, messageWithPath);
  }
} else {
  await cliTool.sendMessage(params.id, trimmedContent);
}
```

### 画像対応CLIツールの実装例

```typescript
// src/lib/cli-tools/claude.ts（Claude CLIが画像対応の場合）
export class ClaudeTool extends BaseCLITool implements IImageCapableCLITool {
  supportsImage(): true {
    return true;
  }

  async sendMessageWithImage(
    worktreeId: string,
    message: string,
    imagePath: string
  ): Promise<void> {
    // Claude CLI固有の画像送信方式
    const imageMarkdown = `\n![](${imagePath})`;
    await this.sendMessage(worktreeId, `${message}${imageMarkdown}`);
  }
}
```

### CLIツール別画像サポート方針

| CLIツール | supportsImage | 送信方式 | 根拠 |
|-----------|--------------|---------|------|
| Claude CLI | true | `\n![](@path)` または `--image` フラグ（調査必須） | Claude はマルチモーダル対応 |
| Codex | 要調査 | フォールバック or 固有方式 | OpenAI Codex CLI の仕様確認が必要 |
| Gemini | 要調査 | フォールバック or 固有方式 | Gemini CLI の仕様確認が必要 |
| Vibe Local | false | フォールバック（パス埋め込み） | ローカルモデルは画像非対応の可能性大 |
| OpenCode | 要調査 | フォールバック or 固有方式 | OpenCode CLI の仕様確認が必要 |

> **重要**: 実装前に各CLIツールの画像送信方式を調査し、この表を更新すること。

---

## 4. データモデル設計

### 型定義の変更

```typescript
// src/app/api/worktrees/[id]/send/route.ts への追加
interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;
  imagePath?: string;  // 追加: .commandmate/attachments/ 相対パス
}
```

```typescript
// src/lib/api-client.ts への変更
// [S1-M2] オプショナル引数はオブジェクト形式に変更（型安全性向上）
// 位置引数の追加は引数順序の混乱を招くため、options オブジェクトで拡張する
async sendMessage(
  id: string,
  content: string,
  options?: { cliToolId?: CLIToolType; imagePath?: string }
): Promise<{ success: boolean }>

// 新規追加
async uploadImageFile(
  worktreeId: string,
  file: File,
  attachmentsDir: string
): Promise<{ filename: string; path: string }>
```

> **[S1-M2] 移行方針**: 既存の `sendMessage(id, content, cliToolId)` 呼び出し箇所は `sendMessage(id, content, { cliToolId })` に変更する。後方互換性のためにオーバーロードシグネチャを提供することも可能だが、呼び出し箇所が限定的であるため一括置換を推奨する。

### 画像保存パス構造

```
{worktreePath}/
└── .commandmate/
    └── attachments/
        ├── 1741762800000-screenshot.png   # タイムスタンプ-オリジナルファイル名
        └── 1741762900000-mockup.jpg
```

- タイムスタンププレフィックスで名前衝突を防ぐ
- .commandmate/attachments/ を worktree の .gitignore に追加（attachments/ サブディレクトリのみ）

---

## 5. API設計

### 既存 upload API の拡張

**エンドポイント**: `POST /api/worktrees/[id]/upload/[...path]`
**変更内容**: `.commandmate/attachments/` パスへの書き込み許可

現在の upload API はパスの制限を `isPathSafe()` で行っており、`.commandmate/` 配下への書き込みが許可されているか確認が必要。許可されていない場合は allowedPaths に追加するか、別途バリデーションロジックを調整する。

**[S3-S2] ディレクトリ自動作成**: `.commandmate/attachments/` ディレクトリが存在しない場合は upload 処理前に自動作成する（`mkdir -p` 相当）。`fs.mkdirSync(dir, { recursive: true })` を使用すること。初回アップロード時にディレクトリが存在しないケースに対応するために必須である。

**リクエスト** (変更なし):
```
Content-Type: multipart/form-data
body: file（バイナリ）
```

**レスポンス** (変更なし):
```json
{ "filename": "1741762800000-screenshot.png", "path": ".commandmate/attachments/1741762800000-screenshot.png" }
```

### [S2-M3] uploadImageFile の fetch 実装制約

> **[S2-M3] `fetchApi` 使用不可**: `uploadImageFile` は `FormData` を使用するため、`fetchApi` ラッパー（`Content-Type: application/json` 固定）は使用できない。直接 `fetch()` を呼び出す実装とする（`WorktreeDetailRefactored.tsx` の `handleUpload` パターンを参照）。

### send API の拡張

**エンドポイント**: `POST /api/worktrees/[id]/send`

**リクエスト**（変更後）:
```json
{
  "content": "このUIのバグを修正してください",
  "cliToolId": "claude",
  "imagePath": ".commandmate/attachments/1741762800000-screenshot.png"
}
```

**[S2-S4] imagePath バリデーション挿入位置**: `imagePath` のバリデーションは `body.content` の処理後、`cliTool.sendMessage` 呼び出し前に行う。パストラバーサル防御は `isPathSafe(body.imagePath, worktree.path)` で行い、失敗時は400エラーを返す。[S3-S5] 変数名は実際の `send/route.ts` に合わせ `worktree.path`（`getWorktreeById()` の戻り値）を使用する。

**ロジック変更**（[S1-M1] `isImageCapableCLITool` 型ガード使用、[S3-M3] `trimmedContent` 使用）:
```typescript
// [S3-M3] 既存の send/route.ts では trimmedContent = body.content.trim() でバリデーション後、
// sendMessage には body.content を渡している。新規画像送信ロジックでは trimmedContent を一貫して使用する。
if (body.imagePath) {
  if (isImageCapableCLITool(cliTool)) {
    await cliTool.sendMessageWithImage(params.id, trimmedContent, absoluteImagePath);
  } else {
    // フォールバック: パス埋め込み
    const messageWithPath = trimmedContent
      ? `${trimmedContent}\n\n[添付画像: ${absoluteImagePath}]`
      : `[添付画像: ${absoluteImagePath}]`;
    await cliTool.sendMessage(params.id, messageWithPath);
  }
} else {
  await cliTool.sendMessage(params.id, trimmedContent);
}
```

---

## 6. セキュリティ設計

### 画像アップロードのセキュリティチェック（image-extensions.ts を使用）

| チェック | 実装 | 対象 |
|--------|------|------|
| 拡張子ホワイトリスト | ATTACHABLE_IMAGE_EXTENSIONS（png/jpg/jpeg/gif/webp） | 全画像 |
| SVG除外 | SVGはスコープ外（XSSリスク） | SVG |
| Magic bytes検証 | IMAGE_EXTENSION_VALIDATORS | png/jpg/jpeg/gif/webp |
| ファイルサイズ上限 | IMAGE_MAX_SIZE_BYTES (5MB) | 全画像 |

> **[S4-S2] MIME typeスプーフィング対策**: Magic bytes検証により拡張子偽装（MIME typeスプーフィング）を防止している。例えば.pngに名前変更されたJPEGファイルはmagic bytes検証で拒否される。

> **注意**: uploadable-extensions.ts ではなく image-extensions.ts を使用する。

#### [S2-S3] バリデーションモジュールの使い分け

| コンテキスト | 使用モジュール | 説明 |
|-------------|---------------|------|
| upload/route.ts（サーバー側アップロード） | `uploadable-extensions.ts`（既存のまま変更しない） | `.commandmate/attachments/` へのアップロードは既存の upload API を経由するため、`uploadable-extensions.ts` のホワイトリストに `.png/.jpg/.jpeg/.gif/.webp` が含まれていることを事前確認すること |
| クライアント側バリデーション（ファイル選択ダイアログ） | `image-extensions.ts` の `ATTACHABLE_IMAGE_EXTENSIONS` | SVG除外済みの画像添付専用ホワイトリスト |
| send/route.ts（imagePath検証） | `path-validator.ts` の `isPathSafe()` + `resolveAndValidateRealPath()` | パストラバーサル防御のみ（拡張子チェックはアップロード時に完了済み） |

#### [S1-S3] 添付可能画像拡張子の定数定義（DRY原則）

SVGを除外した添付用ホワイトリスト定数を `image-extensions.ts` に追加する。ファイル選択ダイアログの `accept` 属性もこの定数から生成し、拡張子リストの重複定義を防ぐ。

```typescript
// src/config/image-extensions.ts への追加
/** 画像添付で許可する拡張子（SVGを除外） */
export const ATTACHABLE_IMAGE_EXTENSIONS = IMAGE_EXTENSIONS.filter(
  (ext) => ext !== '.svg'
);

/** ファイル選択ダイアログの accept 属性値 */
export const ATTACHABLE_IMAGE_ACCEPT = ATTACHABLE_IMAGE_EXTENSIONS.join(',');
```

UI側では以下のように使用する:
```typescript
// MessageInput.tsx
import { ATTACHABLE_IMAGE_ACCEPT } from '@/config/image-extensions';

<input type="file" accept={ATTACHABLE_IMAGE_ACCEPT} ... />
```

### パストラバーサル防御

> **[S2-M1][S2-M2] シグネチャ修正**: `resolveAndValidateRealPath(targetPath, rootDir)` は `boolean` を返す（パスの文字列ではない）。`isPathSafe(targetPath, rootDir)` の引数順序は `targetPath` が第1引数、`rootDir` が第2引数である。いずれも `src/lib/path-validator.ts` の実際のシグネチャに準拠すること。

```typescript
// send/route.ts での imagePath バリデーション
import { isPathSafe, resolveAndValidateRealPath } from '@/lib/path-validator';
import path from 'path';

// [S3-S5] 変数名は実際の send/route.ts に合わせ worktree.path を使用
// （worktree は getWorktreeById(db, params.id) の戻り値）

// [S4-M2] URLスキーム拒否（SSRF対策）
const DANGEROUS_SCHEMES = ['file://', 'http://', 'https://', 'ftp://', 'data:'];
if (DANGEROUS_SCHEMES.some(scheme => body.imagePath.startsWith(scheme))) {
  return errorResponse('INVALID_PATH', 'URL schemes are not allowed in imagePath', 400);
}

// 1. isPathSafe で論理パスのトラバーサル防御（第1引数: targetPath, 第2引数: rootDir）
if (!isPathSafe(body.imagePath, worktree.path)) {
  return errorResponse('INVALID_PATH', 'Invalid image path', 400);
}

// 2. resolveAndValidateRealPath でシンボリックリンク経由のトラバーサル防御
//    シグネチャ: resolveAndValidateRealPath(targetPath: string, rootDir: string): boolean
if (!resolveAndValidateRealPath(body.imagePath, worktree.path)) {
  return errorResponse('INVALID_PATH', 'Invalid image path (symlink)', 400);
}

// 3. 絶対パスを自前で構築（resolveAndValidateRealPath は boolean を返すため）
const absoluteImagePath = path.resolve(worktree.path, body.imagePath);

// [S4-S4] imagePath のホワイトリスト検証（.commandmate/attachments/ プレフィックス強制）
const ALLOWED_IMAGE_DIR = path.join(worktree.path, '.commandmate', 'attachments');
const resolvedPath = path.resolve(worktree.path, body.imagePath);
if (!resolvedPath.startsWith(ALLOWED_IMAGE_DIR + path.sep) && resolvedPath !== ALLOWED_IMAGE_DIR) {
  return errorResponse('INVALID_PATH', 'imagePath must be within .commandmate/attachments/', 400);
}
```

### [S4-M1] フォールバック方式のインジェクション対策

フォールバック方式で `absoluteImagePath` をメッセージに埋め込む前に、以下のホワイトリスト検証を行う:

- パスが `worktree.path + '/.commandmate/attachments/'` で始まること
- パスに制御文字（`\n`, `\r`, `\t`, `\0` 等）が含まれないこと
- 検証失敗時はフォールバック送信自体を中断し、エラーを返す

```typescript
// send/route.ts のフォールバック送信前バリデーション
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
if (CONTROL_CHAR_REGEX.test(absoluteImagePath)) {
  return errorResponse('INVALID_PATH', 'Path contains control characters', 400);
}
const expectedPrefix = path.join(worktree.path, '.commandmate', 'attachments') + path.sep;
if (!absoluteImagePath.startsWith(expectedPrefix)) {
  return errorResponse('INVALID_PATH', 'Image path must be within .commandmate/attachments/', 400);
}
```

### .gitignore 管理

各worktreeの `.gitignore` に以下を自動追加（.commandmate/ 全体ではなく attachments/ のみ）:
```
# CommandMate image attachments
.commandmate/attachments/
```

> **[S4-S1] .gitignore 追加の失敗時挙動**: `.gitignore` 追加に失敗した場合でも upload/send は継続する（ベストエフォート）。ただし失敗時はユーザーに警告トースト表示を推奨する。

---

## 7. UI設計

### [S1-S2] useImageAttachment カスタムフック（SRP準拠）

> **[S1-S2] SRP準拠**: 画像添付の状態管理・バリデーション・アップロードロジックは `useImageAttachment` カスタムフックに抽出する。MessageInput.tsx はフックの戻り値を使ってUIを描画するだけにし、単一責任原則に準拠する。

```typescript
// src/hooks/useImageAttachment.ts
import { useState, useRef, useCallback } from 'react';
import { ATTACHABLE_IMAGE_ACCEPT } from '@/config/image-extensions';

interface AttachedImage {
  file: File;
  path: string;  // アップロード後のサーバー側パス
}

interface UseImageAttachmentReturn {
  attachedImage: AttachedImage | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
  isUploading: boolean;
  error: string | null;
  acceptAttribute: string;
  openFileDialog: () => void;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  removeAttachment: () => void;
  resetAfterSend: () => void;
}

export function useImageAttachment(
  worktreeId: string,
  uploadFn: (worktreeId: string, file: File) => Promise<{ path: string }>
): UseImageAttachmentReturn {
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setIsUploading(true);
    try {
      const result = await uploadFn(worktreeId, file);
      setAttachedImage({ file, path: result.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [worktreeId, uploadFn]);

  const removeAttachment = useCallback(() => {
    setAttachedImage(null);
    setError(null);
  }, []);

  const resetAfterSend = useCallback(() => {
    setAttachedImage(null);
  }, []);

  return {
    attachedImage,
    fileInputRef,
    isUploading,
    error,
    acceptAttribute: ATTACHABLE_IMAGE_ACCEPT,
    openFileDialog,
    handleFileSelect,
    removeAttachment,
    resetAfterSend,
  };
}
```

### MessageInput.tsx の変更方針

MessageInput.tsx は `useImageAttachment` フックを利用し、UI描画に集中する。

```typescript
// MessageInput.tsx
const {
  attachedImage, fileInputRef, isUploading, error, acceptAttribute,
  openFileDialog, handleFileSelect, removeAttachment, resetAfterSend,
} = useImageAttachment(worktreeId, worktreeApi.uploadImageFile);

// UI要素
<button onClick={openFileDialog} disabled={isUploading}>
  {/* 画像添付ボタン */}
</button>
<input
  ref={fileInputRef}
  type="file"
  accept={acceptAttribute}
  style={{ display: 'none' }}
  onChange={handleFileSelect}
/>
{attachedImage && (
  <span>{attachedImage.file.name} <button onClick={removeAttachment}>x</button></span>
)}
{error && <span className="text-red-500">{error}</span>}
```

### 画像送信フロー（UI側）

1. ユーザーが添付ボタンをクリック
2. ファイル選択ダイアログ（`ATTACHABLE_IMAGE_ACCEPT` で制御）
3. ファイル選択後、`useImageAttachment` フックが upload API で `.commandmate/attachments/` に即座にアップロード
4. アップロード成功 -> attachedImage 状態にパスを保存、ボタン近くにファイル名表示
5. 送信ボタン押下 -> `sendMessage(id, content, { cliToolId, imagePath })` を呼び出し
6. 送信完了後 -> `resetAfterSend()` で attachedImage 状態をリセット

### CLIツール非対応時のUI挙動

> **[S1-S1] UIは常に画像添付ボタンを表示する**: CLIToolInfo に `supportsImage` プロパティは追加しない。画像添付ボタンは全てのCLIツールで常に表示し、送信時にサーバー側で `isImageCapableCLITool()` 型ガードを使って判定する。画像非対応ツールの場合はフォールバック（パス埋め込み）で動作するため、ユーザーに対してツールチップで「このツールではファイルパスとして送信されます」と表示する。

---

## 8. 設計上の決定事項とトレードオフ

| 決定事項 | 採用案 | 理由 | トレードオフ |
|---------|--------|------|-------------|
| 画像送信方式 | 2段階方式（upload→send） | api-client.tsのContent-Type維持 | クライアント側でAPIを2回呼び出す |
| 画像保存先 | .commandmate/attachments/ | git追跡防止、セキュリティ管理 | ディスク容量に蓄積（クリーンアップ未実装）。[S4-S3] 孤立ファイル対策: upload成功後にsendが失敗した場合、UIから再送信またはファイル選択のやり直しを促す。サーバー側の自動クリーンアップは今回スコープ外（Nice to Haveで対応）。 |
| バリデーション | image-extensions.ts 使用 | magic bytes + SVGセキュリティ実装済み | uploadable-extensions.tsとの二重管理 |
| 後方互換性 | IImageCapableCLITool 未実装=フォールバック | 既存ツールへの影響ゼロ（ICLITool変更なし） | 全ツールがフォールバック動作になるリスク |
| SVGスコープ | 今回は対象外（XSSリスク） | 既存コードのSVGセキュリティが複雑 | SVG添付ユースケースが未対応 |
| 添付数 | 1枚のみ（今回） | シンプルな実装 | 複数画像ユースケース未対応 |
| CLIToolManager変更 | 変更不要 [S3-S4] | 型ガードは送信ルート側で使用 | なし |

> **[S3-S4] CLIToolManager の変更不要**: `CLIToolManager` クラスは `ICLITool` の配列を管理しており、`IImageCapableCLITool` の追加による変更は不要。型ガード `isImageCapableCLITool()` は `send/route.ts` 側で使用するため、マネージャーには影響しない。

### 代替案との比較

| 案 | メリット | デメリット | 採用可否 |
|---|---------|-----------|---------|
| upload APIを新規作成 | クリーンな分離 | 既存のセキュリティ実装の重複 | ❌ 不採用 |
| FormDataでsend APIに画像を直送 | 1ステップ | api-client.tsのContent-Type変更が必要 | ❌ 不採用 |
| Base64エンコード送信 | シンプル | ペイロードサイズが大きい、パフォーマンス劣化 | ❌ 不採用 |
| **2段階方式（採用）** | 既存インフラ再利用、Content-Type維持 | 2回のAPI呼び出し | ✅ 採用 |

---

## 9. 実装順序（推奨）

1. **CLIツール画像送信方式調査**（ブロッキング）
   - Claude CLI: `--image` フラグまたはマークダウン記法の確認
   - Codex / Gemini / OpenCode: 公式ドキュメント確認
   - 調査結果を本設計書の「CLIツール別画像サポート方針」テーブルを更新

2. **型定義・インターフェース追加** [S1-M1][S3-M2]
   - `IImageCapableCLITool` インターフェースを `types.ts` に追加（`ICLITool` は変更しない）
   - `isImageCapableCLITool()` 型ガード関数を追加
   - `src/lib/cli-tools/index.ts` に `IImageCapableCLITool` と `isImageCapableCLITool` のエクスポートを追加すること [S3-M2]
   - `CLIToolInfo` は変更しない [S1-S1]

3. **ATTACHABLE_IMAGE_EXTENSIONS 定数追加** [S1-S3]
   - `image-extensions.ts` に SVG除外済み定数と accept 属性値を追加

4. **画像対応CLIツール実装**（調査結果に基づく）
   - 画像対応ツールは `IImageCapableCLITool` を実装

5. **upload API 拡張**（.commandmate/attachments/ パス許可）

6. **send/route.ts 拡張**（imagePath パラメータ + `isImageCapableCLITool` 型ガード + パストラバーサル防御）
   - フォールバック時のimagePathホワイトリスト検証を追加（制御文字拒否、`.commandmate/attachments/` プレフィックス強制） [S4-M1]
   - imagePathのURLスキーム拒否バリデーションを追加（SSRF対策: `file://`, `http://`, `https://`, `ftp://`, `data:` を拒否） [S4-M2]
   - imagePathのホワイトリスト検証（`.commandmate/attachments/` プレフィックス強制） [S4-S4]

7. **api-client.ts 拡張** [S1-M2][S2-S5][S3-M1]
   - `sendMessage` のオプショナル引数をオブジェクト形式に変更
   - `uploadImageFile` メソッド追加
   - **[S2-S5] 既存呼び出し箇所の移行**: `src/components/worktree/MessageInput.tsx`（109行目付近）の `worktreeApi.sendMessage(worktreeId, message.trim(), effectiveCliTool)` を新シグネチャ `worktreeApi.sendMessage(worktreeId, message.trim(), { cliToolId: effectiveCliTool })` に変更すること
   - **[S3-M1] テスト更新**: `MessageInput.test.tsx`（9箇所のアサーション）と `issue-288-acceptance.test.tsx`（3箇所のアサーション）で `sendMessage` のアサーション形式を `(id, content, { cliToolId })` オブジェクト形式に更新すること。シグネチャ変更に伴い、既存テストが失敗するため実装と同時にテスト修正が必須である。

8. **useImageAttachment フック実装** [S1-S2]
   - 画像添付の状態管理・バリデーション・アップロードロジックをフックに集約

9. **MessageInput.tsx UI変更**
   - `useImageAttachment` フックを利用、UI描画に集中

10. **WorktreeDetailRefactored.tsx 対応**

11. **ユニットテスト追加**

---

## 10. SOLID原則への準拠

| 原則 | 対応 |
|-----|------|
| SRP | MessageInput はUI描画のみ、画像添付ロジックは `useImageAttachment` フックに抽出 [S1-S2]、送信ロジックは api-client.ts に委譲 |
| OCP | `IImageCapableCLITool` を実装して画像対応を追加（`ICLITool` / `BaseCLITool` は変更不要） [S1-M1] |
| LSP | `IImageCapableCLITool` を実装するサブクラスは `ICLITool` としても正しく動作する |
| ISP | `ICLITool` に画像メソッドを追加せず、別インターフェース `IImageCapableCLITool` に分離 [S1-M1] |
| DIP | send/route.ts は `ICLITool` / `IImageCapableCLITool` 抽象に依存（具体クラスに依存しない） |

---

## 11. Stage 1 レビュー指摘事項サマリー

### 反映済み指摘事項

| ID | 重要度 | 内容 | 反映先セクション |
|----|--------|------|-----------------|
| S1-M1 | Must Fix | ISP違反: `ICLITool` に画像メソッドを直接追加せず、`IImageCapableCLITool` インターフェースに分離 | 3. 設計パターン, 5. API設計, 9. 実装順序, 10. SOLID原則 |
| S1-M2 | Must Fix | 型安全性: `sendMessage` の引数をオブジェクト形式 `options?` に変更 | 4. データモデル設計, 9. 実装順序 |
| S1-S1 | Should Fix | YAGNI: `CLIToolInfo` への `supportsImage` 追加を削除、UIは常に添付ボタン表示 | 3. 設計パターン, 7. UI設計 |
| S1-S2 | Should Fix | SRP: 画像添付ロジックを `useImageAttachment` カスタムフックに抽出 | 7. UI設計, 9. 実装順序, 10. SOLID原則 |
| S1-S3 | Should Fix | DRY: `ATTACHABLE_IMAGE_EXTENSIONS` 定数をSVG除外で定義、accept属性も定数から生成 | 6. セキュリティ設計, 9. 実装順序 |

### スキップした指摘事項

| ID | 重要度 | 理由 |
|----|--------|------|
| S1-N1 | Nice to Have | 設計方針書への反映不要（実装時の微調整事項） |
| S1-N2 | Nice to Have | 設計方針書への反映不要（実装時の微調整事項） |

### 実装チェックリスト

以下のチェックリストは、本設計方針書に基づく実装時に確認すべき項目である。

- [ ] `IImageCapableCLITool` インターフェースを `src/lib/cli-tools/types.ts` に追加 [S1-M1]
- [ ] `isImageCapableCLITool()` 型ガード関数を `src/lib/cli-tools/types.ts` に追加 [S1-M1]
- [ ] `ICLITool` インターフェースに画像関連メソッドを追加していないことを確認 [S1-M1]
- [ ] `CLIToolInfo` 型に `supportsImage` を追加していないことを確認 [S1-S1]
- [ ] `api-client.ts` の `sendMessage` 引数をオブジェクト形式に変更 [S1-M2]
- [ ] 既存の `sendMessage` 呼び出し箇所を新シグネチャに移行 [S1-M2]
- [ ] `ATTACHABLE_IMAGE_EXTENSIONS` 定数を `image-extensions.ts` に追加 [S1-S3]
- [ ] `ATTACHABLE_IMAGE_ACCEPT` 定数を `image-extensions.ts` に追加 [S1-S3]
- [ ] ファイル選択ダイアログの accept 属性が `ATTACHABLE_IMAGE_ACCEPT` を使用 [S1-S3]
- [ ] `useImageAttachment` カスタムフックを `src/hooks/useImageAttachment.ts` に作成 [S1-S2]
- [ ] `MessageInput.tsx` が `useImageAttachment` フックを利用し、直接の状態管理を持たない [S1-S2]
- [ ] `send/route.ts` が `isImageCapableCLITool()` 型ガードで送信方式を判定 [S1-M1]

---

## 12. Stage 2 レビュー指摘事項サマリー（整合性レビュー）

### 反映済み指摘事項

| ID | 重要度 | 内容 | 反映先セクション |
|----|--------|------|-----------------|
| S2-M1 | Must Fix | `resolveAndValidateRealPath(targetPath, rootDir)` の実際のシグネチャ（`boolean` 返却、第1引数が `targetPath`）に合わせてコード例を修正 | 6. セキュリティ設計 |
| S2-M2 | Must Fix | `isPathSafe(targetPath, rootDir)` の引数順序（第1引数: `targetPath`、第2引数: `rootDir`）に合わせてコード例を修正 | 6. セキュリティ設計 |
| S2-M3 | Must Fix | `uploadImageFile` が `FormData` を使用するため `fetchApi` ラッパーが使えない制約を明記 | 5. API設計 |
| S2-S1 | Should Fix | クラス名 `ClaudeCLITool` を実際のクラス名 `ClaudeTool` に修正 | 3. 設計パターン |
| S2-S2 | Should Fix | `apiClient.uploadImageFile` を実際のAPI名前空間 `worktreeApi.uploadImageFile` に修正 | 7. UI設計 |
| S2-S3 | Should Fix | `uploadable-extensions.ts` と `image-extensions.ts` の使い分けを明確化 | 6. セキュリティ設計 |
| S2-S4 | Should Fix | `send/route.ts` の `imagePath` バリデーション挿入位置（`body.content` 処理後、`sendMessage` 呼び出し前）を明記 | 5. API設計 |
| S2-S5 | Should Fix | `sendMessage` シグネチャ変更の影響箇所（`MessageInput.tsx`）を実装順序に明記 | 9. 実装順序 |

### スキップした指摘事項

なし

### 追加実装チェックリスト（Stage 2）

- [ ] `isPathSafe()` の引数順序が `(targetPath, rootDir)` であることを確認 [S2-M2]
- [ ] `resolveAndValidateRealPath()` が `boolean` を返すことを前提としたコードであることを確認 [S2-M1]
- [ ] `uploadImageFile` の実装で `fetchApi` ではなく直接 `fetch()` を使用 [S2-M3]
- [ ] `ClaudeTool` クラス名で実装（`ClaudeCLITool` ではない） [S2-S1]
- [ ] `worktreeApi.uploadImageFile` として実装（`apiClient` ではない） [S2-S2]
- [ ] `uploadable-extensions.ts` に `.png/.jpg/.jpeg/.gif/.webp` が含まれていることを事前確認 [S2-S3]
- [ ] `send/route.ts` の `imagePath` バリデーションが `body.content` 処理後に配置されていることを確認 [S2-S4]
- [ ] `MessageInput.tsx` の `sendMessage` 呼び出しを新シグネチャ `{ cliToolId }` 形式に移行 [S2-S5]

---

## 13. Stage 3 レビュー指摘事項サマリー（影響分析レビュー）

### 反映済み指摘事項

| ID | 重要度 | 内容 | 反映先セクション |
|----|--------|------|-----------------|
| S3-M1 | Must Fix | `sendMessage` シグネチャ変更のテスト影響（`MessageInput.test.tsx` 9箇所、`issue-288-acceptance.test.tsx` 3箇所）を実装順序に明記 | 9. 実装順序 |
| S3-M2 | Must Fix | `src/lib/cli-tools/index.ts` に `IImageCapableCLITool` と `isImageCapableCLITool` のエクスポート追加を明記 | 9. 実装順序 |
| S3-M3 | Must Fix | `send/route.ts` のコード例で `body.content` ではなく `trimmedContent`（バリデーション済み変数）を一貫して使用 | 3. 設計パターン, 5. API設計 |
| S3-S2 | Should Fix | `.commandmate/attachments/` ディレクトリ自動作成（`fs.mkdirSync(dir, { recursive: true })`）を明記 | 5. API設計 |
| S3-S4 | Should Fix | `CLIToolManager` クラスの変更不要を明示（型ガードは送信ルート側で使用） | 8. 設計上の決定事項 |
| S3-S5 | Should Fix | コード例の変数名を `worktreePath` から `worktree.path`（実際の `send/route.ts` の変数名）に修正 | 5. API設計, 6. セキュリティ設計 |

### スキップした指摘事項

| ID | 重要度 | 理由 |
|----|--------|------|
| S3-S1 | Should Fix | テスト詳細は実装時対応（設計方針書にはテスト更新の必要性のみ記載で十分） |
| S3-S3 | Should Fix | 既存の `cli-tools/index.ts` エクスポート不整合は別Issue対応（S3-M2でエクスポート追加は対応済み） |

### 追加実装チェックリスト（Stage 3）

- [ ] `src/lib/cli-tools/index.ts` に `IImageCapableCLITool` と `isImageCapableCLITool` のエクスポートを追加 [S3-M2]
- [ ] `MessageInput.test.tsx` の `sendMessage` アサーション9箇所を `(id, content, { cliToolId })` 形式に更新 [S3-M1]
- [ ] `issue-288-acceptance.test.tsx` の `sendMessage` アサーション3箇所を `(id, content, { cliToolId })` 形式に更新 [S3-M1]
- [ ] `send/route.ts` の画像送信ロジックで `trimmedContent` を使用（`body.content` ではなく） [S3-M3]
- [ ] `.commandmate/attachments/` ディレクトリの自動作成処理を upload API に実装 [S3-S2]
- [ ] `CLIToolManager` クラスに変更を加えていないことを確認 [S3-S4]
- [ ] `send/route.ts` のコード内で `worktree.path` を使用（`worktreePath` 変数は存在しない） [S3-S5]

---

## 14. Stage 4 レビュー指摘事項サマリー（セキュリティレビュー）

### 反映済み指摘事項

| ID | 重要度 | 内容 | 反映先セクション |
|----|--------|------|-----------------|
| S4-M1 | Must Fix | フォールバック方式でCLIインジェクション対策（制御文字拒否、`.commandmate/attachments/` プレフィックス検証） | 6. セキュリティ設計, 9. 実装順序 |
| S4-M2 | Must Fix | imagePathのURLスキーム拒否（`file://`, `http://`, `https://`, `ftp://`, `data:` によるSSRF対策） | 6. セキュリティ設計, 9. 実装順序 |
| S4-S1 | Should Fix | `.gitignore` 自動追加の失敗時はベストエフォートで継続、警告トースト表示を推奨 | 6. セキュリティ設計 |
| S4-S2 | Should Fix | Magic bytes検証によるMIME typeスプーフィング対策の明文化 | 6. セキュリティ設計 |
| S4-S3 | Should Fix | 孤立ファイル（upload成功・send失敗）の緩和策をUIから再送信で対応、自動クリーンアップはスコープ外 | 8. 設計上の決定事項 |
| S4-S4 | Should Fix | imagePathの`.commandmate/attachments/`プレフィックス強制（ホワイトリスト検証） | 6. セキュリティ設計, 9. 実装順序 |

### スキップした指摘事項

| ID | 重要度 | 理由 |
|----|--------|------|
| S4-N1 | Nice to Have | Nice to Have - 設計方針書への反映不要 |
| S4-N2 | Nice to Have | Nice to Have - スコープ外 |
| S4-N3 | Nice to Have | Nice to Have - 設計方針書への反映不要 |

### 追加実装チェックリスト（Stage 4）

- [ ] `send/route.ts` でURLスキーム拒否バリデーションを実装（`file://`, `http://`, `https://`, `ftp://`, `data:` を拒否） [S4-M2]
- [ ] `send/route.ts` のフォールバック送信前に制御文字チェックを実装 [S4-M1]
- [ ] `send/route.ts` のフォールバック送信前に `.commandmate/attachments/` プレフィックス検証を実装 [S4-M1]
- [ ] `send/route.ts` で `imagePath` が `.commandmate/attachments/` 配下であることをホワイトリスト検証 [S4-S4]
- [ ] `.gitignore` 追加処理を try-catch で囲み、失敗時もアップロード/送信を継続する実装 [S4-S1]
- [ ] `.gitignore` 追加失敗時の警告レスポンスまたはログ出力を実装 [S4-S1]
- [ ] Magic bytes検証がMIME typeスプーフィングを防止していることをテストで確認 [S4-S2]
- [ ] upload成功・send失敗時にUIからファイル選択のやり直しが可能であることを確認 [S4-S3]

---

*Generated by /design-policy command for Issue #474*
*Stage 1 review findings applied on 2026-03-12*
*Stage 2 review findings (consistency review) applied on 2026-03-12*
*Stage 3 review findings (impact analysis review) applied on 2026-03-12*
*Stage 4 review findings (security review) applied on 2026-03-12*
