# Issue #474 仮説検証レポート

## 検証日時
- 2026-03-12

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | MessageInputは純粋なテキスト入力のみ | Confirmed | sendMessage(worktreeId, message: string) のみ |
| 2 | image-extensions.tsが既存で再利用可能 | Confirmed | src/config/image-extensions.ts 確認済み（png/jpg/jpeg/gif/webp/svg対応、magic bytes検証あり） |
| 3 | ICLIToolインターフェースにsendMessageがある | Confirmed | types.ts:56 に `sendMessage(worktreeId, message: string): Promise<void>` |
| 4 | src/lib/cli-tools/base.ts が存在する | Confirmed | ファイル確認済み |
| 5 | /api/worktrees/[id]/send route.ts にsendMessageが呼ばれる | Confirmed | route.ts:161 `await cliTool.sendMessage(params.id, body.content)` |
| 6 | 既存uploadAPI(/api/worktrees/[id]/upload/)が存在する | Confirmed | src/app/api/worktrees/[id]/upload/[...path] 確認済み |

## 詳細検証

### 前提条件 1: MessageInputはテキストのみ
**Issue内の記述**: 「現在のMessageInputコンポーネントは純粋なテキスト入力のみで、画像ファイルを添付する手段がない」

**判定**: Confirmed

**根拠**: src/lib/cli-tools/types.ts:56 の ICLITool インターフェースは `sendMessage(worktreeId: string, message: string): Promise<void>` のみ。画像関連パラメータなし。

---

### 前提条件 2: image-extensions.ts の再利用可能性
**Issue内の記述**: 「画像アップロード・バリデーションは既存のimage-extensions.tsを再利用」

**判定**: Confirmed

**根拠**: src/config/image-extensions.ts に png/jpg/jpeg/gif/webp/svg の magic bytes 検証、MIME型検証が実装済み。SVGはXSS対策のため特殊扱いあり。

---

### 前提条件 3: base.tsが存在しフォールバック実装の場所として適切
**Issue内の記述**: 「src/lib/cli-tools/base.ts ベースクラスに画像フォールバック実装」

**判定**: Confirmed

**根拠**: src/lib/cli-tools/base.ts ファイル確認済み。

---

## Stage 1レビューへの申し送り事項

- 全前提条件がConfirmedのため、特に修正が必要な事実関係の誤りはなし
- **要確認**: Issue内に「gemini.ts」が変更対象ファイルリストにない（src/lib/cli-tools/gemini.ts が存在するが、影響範囲テーブルに未記載）
- **要確認**: Claude CLIの具体的な画像送信フラグ（`--image`等）の記載がないため、調査タスクが適切に記載されているか確認を推奨
- **要確認**: SVGはXSS対策で既存コードで特殊扱いされているが、Issue内の受入条件では言及されていない
