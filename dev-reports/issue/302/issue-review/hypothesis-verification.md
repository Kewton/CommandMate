# Issue #302 仮説検証レポート

## 検証日時
- 2026-02-18

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `UPLOADABLE_EXTENSIONS`にmp4が含まれていないためアップロードできない | Confirmed | `src/config/uploadable-extensions.ts`のUPLOADABLE_EXTENSION_VALIDATORS配列にmp4エントリが存在しない |
| 2 | `src/config/binary-extensions.ts` - mp4は既に登録済み（変更不要） | Confirmed | L55に`.mp4`が「Media files」セクションに登録済み |
| 3 | WorktreeDetailRefactored.tsx はUPLOADABLE_EXTENSIONSを動的参照しているため自動対応 | Confirmed | L1390/L1869/L2095でUPLOADABLE_EXTENSIONSをimportして`accept`属性に使用 |
| 4 | `src/lib/file-search.ts` - バイナリ除外リストにmp4が既に含まれている（変更不要） | Confirmed | `isBinaryExtension()`関数がbinary-extensions.tsを参照し、mp4を除外する |
| 5 | MP4 magic bytesはIssue記載の方法で検証可能（前提） | Partially Confirmed | MP4のftyp boxはoffset 4に位置し、box sizeが可変のため単純なoffset 0検証では不十分。複数パターン対応が必要 |

## 詳細検証

### 仮説 1: UPLOADABLE_EXTENSIONSにmp4が含まれていない

**Issue内の記述**: 「現在の`UPLOADABLE_EXTENSIONS`にmp4が含まれていないためアップロードできない」

**検証手順**:
1. `src/config/uploadable-extensions.ts`のUPLOADABLE_EXTENSION_VALIDATORS配列を確認
2. 対象拡張子: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.txt`, `.log`, `.md`, `.csv`, `.json`, `.yaml`, `.yml` のみ

**判定**: Confirmed

**根拠**: `uploadable-extensions.ts` L49-125の`UPLOADABLE_EXTENSION_VALIDATORS`配列に`.mp4`エントリは存在しない

---

### 仮説 2: binary-extensions.tsにmp4が既に登録済み

**Issue内の記述**: 「`src/config/binary-extensions.ts` - mp4は既に登録済み（変更不要）」

**検証手順**:
1. `src/config/binary-extensions.ts`のBINARY_EXTENSIONS配列を確認
2. Media filesセクション（L54-61）を確認

**判定**: Confirmed

**根拠**: `binary-extensions.ts` L55: `'.mp4'` がMedia filesセクションに登録済み

---

### 仮説 3: WorktreeDetailRefactored.tsxはUPLOADABLE_EXTENSIONSを動的参照

**Issue内の記述**: 「WorktreeDetailRefactored.tsx - アップロードUIは`UPLOADABLE_EXTENSIONS`を動的参照しているため自動対応」

**検証手順**:
1. `src/components/worktree/WorktreeDetailRefactored.tsx`でUPLOADABLE_EXTENSIONSの参照方法を確認

**判定**: Confirmed

**根拠**:
- L41: `import { UPLOADABLE_EXTENSIONS, getMaxFileSize, isUploadableExtension } from '@/config/uploadable-extensions';`
- L1869: `accept={UPLOADABLE_EXTENSIONS.join(',')}`
- L2095: `accept={UPLOADABLE_EXTENSIONS.join(',')}`

→ mp4をUPLOADABLE_EXTENSION_VALIDATORSに追加すると、accept属性は自動更新される

---

### 仮説 4: file-search.tsのバイナリ除外リストにmp4が含まれている

**Issue内の記述**: 「`src/lib/file-search.ts` - バイナリ除外リストにmp4が既に含まれている（変更不要）」

**検証手順**:
1. `src/lib/file-search.ts`での除外処理を確認
2. `isBinaryExtension()`関数の実装を確認

**判定**: Confirmed

**根拠**:
- `file-search.ts` L18: `import { isBinaryExtension, isBinaryContent } from '@/config/binary-extensions';`
- L350: `if (isBinaryExtension(ext)) { return; }` でmp4を含むバイナリファイルを除外

---

### 仮説 5: MP4 magic bytes検証の前提

**Issue内の記述**: 「不正なファイル（拡張子をmp4に偽装した非動画ファイル）がmagic bytes検証で拒否されること」（受入条件として記載）

**検証手順**:
1. MP4ファイル形式の仕様を検証
2. 既存の画像magic bytes実装パターンと比較

**判定**: Partially Confirmed

**詳細**:
MP4ファイルは`ISO Base Media File Format (ISOBMFF)`に基づく。ファイル構造:
- bytes 0-3: box size (4バイト、可変)
- bytes 4-7: box type = "ftyp" (`0x66 0x74 0x79 0x70`)

Issue記載の方針（magic bytes検証）は適切だが、offset 0ではなく**offset 4でftyp文字列**を検証すべき。ただし、box sizeが可変（通常は`0x00 0x00 0x00 0x14`などだが保証されない）のため、offset 4固定で`ftyp`を確認する方式が最も安全。

**Issueへの影響**: 実装タスクの「magic bytes検証」の詳細仕様を明確化する必要がある。

---

## Stage 1レビューへの申し送り事項

1. **MP4 magic bytes実装の仕様明確化**: offset 4で`ftyp` (0x66 0x74 0x79 0x70)を検証する方式を採用するよう、実装タスクに詳細仕様を追加することを推奨
2. **15MB Base64 data URIの性能影響**: 15MBのmp4をBase64エンコードすると約20MBのデータとなり、ブラウザのメモリ使用量が増加する。この点についてIssueに注意事項として記載することを推奨
3. **`FileViewer.tsx`の`canCopy`ロジック**: 現在 `!content.isImage` の場合にコピーを有効化しているが、`isVideo`フラグ追加後は動画もコピー除外対象にする必要がある（Stage 1で確認）
