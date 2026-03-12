# Issue #474 影響分析レビュー (Stage 3)

**日付**: 2026-03-12
**Issue**: #474 メッセージ入力時画像ファイル添付機能
**レビュー種別**: 影響分析 (Impact Analysis)
**設計書**: dev-reports/design/issue-474-image-attachment-design-policy.md

---

## 1. レビューサマリー

設計方針書に記載されたファイル変更の波及効果をコードベースを調査して分析した。主な発見事項は以下の通り。

- **テストファイルへの波及**: `api-client.ts` の `sendMessage` シグネチャ変更により、テスト9箇所以上のアサーション更新が必要。設計書では1箇所 (MessageInput.tsx) のみ言及。
- **エクスポート不足**: `cli-tools/index.ts` に `IImageCapableCLITool` / `isImageCapableCLITool` のエクスポート追加が未記載。
- **upload API 前提条件**: `uploadable-extensions.ts` は png/jpg/jpeg/gif/webp を既に含んでおり、設計書の前提条件は満たされている。
- **ディレクトリ自動作成**: `.commandmate/attachments/` が初回アップロード時に存在しない場合の対応が未記載。

---

## 2. 影響範囲マップ

### 2.1 設計書に記載された変更ファイルの上流依存関係

| 変更対象ファイル | 依存元 (上流コンポーネント) | 影響の種類 |
|---|---|---|
| `src/lib/api-client.ts` (sendMessage) | `src/components/worktree/MessageInput.tsx` | シグネチャ変更 (位置引数 -> オブジェクト) |
| `src/lib/api-client.ts` (sendMessage) | `tests/unit/components/worktree/MessageInput.test.tsx` (9箇所) | アサーション更新 |
| `src/lib/api-client.ts` (sendMessage) | `tests/integration/issue-288-acceptance.test.tsx` (3箇所) | アサーション更新 |
| `src/lib/cli-tools/types.ts` (IImageCapableCLITool) | `src/lib/cli-tools/index.ts` | エクスポート追加 |
| `src/lib/cli-tools/types.ts` (IImageCapableCLITool) | `src/app/api/worktrees/[id]/send/route.ts` | インポート追加 |
| `src/lib/cli-tools/types.ts` (IImageCapableCLITool) | `tests/unit/cli-tools/types.test.ts` | テストケース追加 |
| `src/app/api/worktrees/[id]/send/route.ts` | `tests/integration/api-send-cli-tool.test.ts` | モッククラス更新 + テストケース追加 |

### 2.2 ICLITool 実装クラス全体への影響

| CLIツール実装 | ファイル | 影響 |
|---|---|---|
| ClaudeTool | `src/lib/cli-tools/claude.ts` | IImageCapableCLITool 実装候補 (画像対応の場合) |
| CodexTool | `src/lib/cli-tools/codex.ts` | 要調査。未実装の場合は変更なし (フォールバック動作) |
| GeminiTool | `src/lib/cli-tools/gemini.ts` | 要調査。未実装の場合は変更なし (フォールバック動作) |
| VibeLocalTool | `src/lib/cli-tools/vibe-local.ts` | 変更なし (フォールバック動作) |
| OpenCodeTool | `src/lib/cli-tools/opencode.ts` | 要調査。未実装の場合は変更なし (フォールバック動作) |
| BaseCLITool | `src/lib/cli-tools/base.ts` | 変更なし (ICLITool のみ実装、IImageCapableCLITool は実装しない) |

### 2.3 設計書に記載されていない影響範囲

| ファイル | 影響内容 | 重要度 |
|---|---|---|
| `src/lib/cli-tools/index.ts` | IImageCapableCLITool, isImageCapableCLITool のエクスポート追加 | Must Fix |
| `tests/unit/components/worktree/MessageInput.test.tsx` | sendMessage アサーション9箇所の引数形式更新 | Must Fix |
| `tests/integration/issue-288-acceptance.test.tsx` | sendMessage アサーション3箇所の引数形式更新 | Must Fix |
| `tests/integration/api-send-cli-tool.test.ts` | モッククラスへの IImageCapableCLITool 対応 + imagePath テストケース追加 | Should Fix |
| `tests/unit/cli-tools/types.test.ts` | IImageCapableCLITool インターフェースの型テスト追加 | Nice to Have |
| `src/lib/file-operations.ts` | writeBinaryFile が .commandmate/attachments/ ディレクトリを自動作成するか確認 | Should Fix |

---

## 3. 破壊的変更 (Breaking Change) リスク分析

### 3.1 sendMessage シグネチャ変更

**変更内容**: `sendMessage(id, content, cliToolId?)` -> `sendMessage(id, content, options?)`

**既存呼び出し箇所**:

| 箇所 | ファイル | 行 | 現在の呼び出し |
|---|---|---|---|
| 本体 | MessageInput.tsx | L109 | `worktreeApi.sendMessage(worktreeId, message.trim(), effectiveCliTool)` |
| テスト | MessageInput.test.tsx | L116等 (9箇所) | `expect(...).toHaveBeenCalledWith('id', 'content', 'claude')` |
| テスト | issue-288-acceptance.test.tsx | L97等 (3箇所) | `expect(...).toHaveBeenCalledWith('id', 'content', 'claude')` |

**リスク評価**: 中。呼び出し箇所は限定的だが、テスト側のアサーション更新を漏らすとCIが失敗する。一括置換で対応可能。

### 3.2 ICLITool インターフェースへの影響

**結論**: ICLITool インターフェースは変更しない (ISP準拠)。既存の全 CLI ツール実装は変更なしで動作する。IImageCapableCLITool を実装しないツールはフォールバック方式で動作するため、破壊的変更なし。

### 3.3 テストモックの ICLITool インターフェース準拠

`tests/integration/api-send-cli-tool.test.ts` のモッククラスは ICLITool の最小実装のみ。IImageCapableCLITool を実装するテストケースを追加する場合、モッククラスの拡張が必要。

---

## 4. upload API 拡張の影響分析

### 4.1 パスバリデーション

- `isPathSafe('.commandmate/attachments', worktree.path)`: `.commandmate` はドットで始まるが、isPathSafe は相対パスが `..` で始まるかのチェックのみ行うため、ドットファイルへのアクセスはブロックされない。**通過する**。
- `resolveAndValidateRealPath('.commandmate/attachments', worktree.path)`: ディレクトリが存在しない場合、祖先ディレクトリ (worktree root) まで辿って検証する。worktree root は存在するため、**通過する**。

### 4.2 uploadable-extensions.ts の画像形式確認

確認結果: UPLOADABLE_EXTENSION_VALIDATORS には以下が含まれている。

| 拡張子 | maxFileSize | magic bytes | 状態 |
|---|---|---|---|
| .png | 5MB | 0x89504E47 | 含まれている |
| .jpg | 5MB | 0xFFD8FF | 含まれている |
| .jpeg | 5MB | 0xFFD8FF | 含まれている |
| .gif | 5MB | GIF87a/GIF89a | 含まれている |
| .webp | 5MB | RIFF header | 含まれている |
| .svg | - | - | 除外済み (SEC-002) |

**結論**: 設計書の前提条件 [S2-S3] は満たされている。追加の変更は不要。

### 4.3 ディレクトリ自動作成

upload/route.ts は `writeBinaryFile(worktree.path, relativePath, buffer)` を呼び出す。`.commandmate/attachments/` ディレクトリが存在しない場合に `writeBinaryFile` が中間ディレクトリを作成するかは `file-operations.ts` の実装に依存する。設計書にこの点の記述がない。

---

## 5. 指摘事項一覧

### Must Fix (3件)

| ID | 内容 |
|---|---|
| S3-M1 | sendMessage シグネチャ変更によるテストファイル大量更新の漏れリスク。MessageInput.test.tsx (9箇所)、issue-288-acceptance.test.tsx (3箇所) のアサーション更新を設計書に追記すること。 |
| S3-M2 | cli-tools/index.ts への IImageCapableCLITool / isImageCapableCLITool エクスポート追加が未記載。実装順序 Step 2 に追記すること。 |
| S3-M3 | send/route.ts の body.content vs trimmedContent の使い分け。フォールバック時のメッセージ構築で trimmedContent の使用を検討すること。 |

### Should Fix (5件)

| ID | 内容 |
|---|---|
| S3-S1 | api-send-cli-tool.test.ts のモッククラスに imagePath 対応テストケース追加が必要。 |
| S3-S2 | .commandmate/attachments/ ディレクトリの自動作成に関する記述を設計書に追加すること。 |
| S3-S3 | cli-tools/index.ts に VibeLocalTool / OpenCodeTool のエクスポートが不足 (既存の不整合)。 |
| S3-S4 | CLIToolManager の型定義を変更しない方針を設計書に明記すること。 |
| S3-S5 | 設計書のコード例で worktreePath を実際の変数名 worktree.path に合わせること。 |

### Nice to Have (4件)

| ID | 内容 |
|---|---|
| S3-N1 | types.test.ts に IImageCapableCLITool の型テストケースを追加。 |
| S3-N2 | uploadable-extensions.ts の画像形式確認完了 (対応不要)。 |
| S3-N3 | .gitignore 自動追加のタイミングと実装箇所を決定すること。 |
| S3-N4 | ATTACHABLE_IMAGE_EXTENSIONS の派生ロジックを JSDoc に記載すること。 |

---

## 6. リスク評価

| リスク | 確率 | 影響度 | 対策 |
|---|---|---|---|
| テストアサーション更新漏れ | 高 | 中 (CIで検出可能) | grep で toHaveBeenCalledWith を一括検索して更新 |
| index.ts エクスポート不足 | 中 | 中 (TypeScriptコンパイルエラーで検出) | 実装チェックリストに追加 |
| ディレクトリ未作成エラー | 中 | 高 (ランタイムエラー) | writeBinaryFile の挙動を事前確認 |
| body.content 空白問題 | 低 | 低 (既存挙動) | trimmedContent への統一を推奨 |

---

*Generated by architecture-review-agent for Issue #474 Stage 3*
