# Issue #300 整合性レビュー (Stage 2)

## Executive Summary

| 項目 | 値 |
|------|-----|
| Issue | #300 - ルートディレクトリにディレクトリを追加出来ない |
| レビュー種別 | 整合性レビュー (Stage 2) |
| レビュー日 | 2026-02-18 |
| ステータス | Conditionally Approved |
| スコア | 4/5 |
| Must Fix | 0件 |
| Should Fix | 3件 |
| Nice to Have | 3件 |

設計方針書と実装コード・Issue要件・既存アーキテクチャの整合性を精査した結果、全体的に高い整合性が確認された。行番号の参照精度は高く、設計の説明するコード動作は実際の実装と一致している。セキュリティ責務境界の記述（encodePathForUrl / isPathSafe の分離）も正確である。3件のShould Fixは設計方針書の記載精度向上に関するものであり、実装の正しさには影響しない。

---

## 整合性マトリクス

### 1. 設計方針書 <-> 実際のコード

| 設計項目 | 設計書の記載 | 実装状況 | 差異 |
|---------|------------|---------|------|
| encodeURIComponent L1252 (handleNewFile) | `/api/.../files/` で使用 | `/api/worktrees/${worktreeId}/files/${encodeURIComponent(newPath)}` (L1252) | 一致 |
| encodeURIComponent L1279 (handleNewDirectory) | `/api/.../files/` で使用 | `/api/worktrees/${worktreeId}/files/${encodeURIComponent(newPath)}` (L1279) | 一致 |
| encodeURIComponent L1305 (handleRename) | `/api/.../files/` で使用 | `/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}` (L1305) | 一致 |
| encodeURIComponent L1330 (handleDelete) | `/api/.../files/` で使用 | `/api/worktrees/${worktreeId}/files/${encodeURIComponent(path)}?recursive=true` (L1330) | 一致 |
| encodeURIComponent L1408 (handleFileInputChange) | `/api/.../files/` で使用 | `/api/worktrees/${worktreeId}/upload/${encodeURIComponent(uploadPath)}` (L1408) | **差異あり**: エンドポイントが `/upload/` であるが設計書は `/files/` と記載 |
| FileTreeView 空状態 (L827-861) | rootItems.length === 0 でNew File/New Directoryボタン表示 | L827: `if (rootItems.length === 0)`, L839/849: empty-new-file/directory-button | 一致 |
| FileTreeView 非空状態 (L877-919) | ツリー描画のみ、ルートレベルボタンなし | L877-919: filteredRootItems.map + ContextMenu のみ | 一致（設計書が指摘する通りツールバーが欠如） |
| path-validator.ts L41-47 | decodeURIComponent()でデコード後にパス検証 | L40-47: decodeURIComponent(targetPath) | 一致 |
| route.ts L112 | pathSegments.join('/') | L112: `const requestedPath = pathSegments.join('/');` | 一致 |
| isPathSafe() 検証チェーン | normalize() -> isPathSafe() -> path.resolve() + path.relative() | route.ts L112-122, path-validator.ts L29-67 | 一致 |

### 2. 設計方針書 <-> Issue要件

| Issue要件 | 設計方針書の対応 | 整合性 |
|-----------|----------------|--------|
| 非空状態でNew Directory/New Fileツールバー表示 | Section 3.1: ツールバーUI設計、data-testid定義 | 一致 |
| ルートレベルへのディレクトリ/ファイル作成が可能 | Section 3.1: onNewDirectory('') / onNewFile('') 呼び出し | 一致 |
| 空状態ボタン維持 (empty-new-directory-button) | Section 3.1 [SF-1]: 空状態ボタンは維持、D-2決定事項 | 一致 |
| encodePathForUrl共通ヘルパー抽出 | Section 3.2: src/lib/url-path-encoder.ts 新規作成 | 一致 |
| 全5箇所のencodeURIComponent修正 | Section 3.3: 5箇所のテーブル記載 | 一致 |
| 同名FILE_EXISTSエラー | 設計方針書に明示的な記載なし（バックエンドスコープ外） | 軽微な欠落 |
| コンテキストメニューの正常動作維持 | Section 8受け入れ条件: サブディレクトリ作成の正常動作確認 | 一致 |
| i18n注記 | Section 3.1: 英語ハードコード方針、D-6決定事項 | 一致（Issue注記と整合） |

### 3. 設計方針書 <-> 既存アーキテクチャ (CLAUDE.md)

| 確認ポイント | CLAUDE.mdガイドライン | 設計方針書 | 整合性 |
|-------------|---------------------|-----------|--------|
| ファイル配置 | `src/lib/` はユーティリティ・ビジネスロジック | `src/lib/url-path-encoder.ts` 新規 | 準拠 |
| 既存url-normalizerとの分離 | `src/lib/url-normalizer.ts` はGit URL正規化 | 用途の違いを明記、別ファイルとして作成 | 準拠 |
| テストファイル配置 | `tests/unit/` 配下 | `tests/unit/lib/url-path-encoder.test.ts` | 準拠 |
| コンポーネント設計 | `src/components/worktree/` 配下 | FileTreeView.tsx内部にツールバー配置 | 準拠 |
| 型定義 | 新規型定義なし（関数のみ） | encodePathForUrlは単純関数、型ファイル不要 | 準拠 |
| コーディング規約 | TypeScript strict, 明示的戻り値型 | `encodePathForUrl(path: string): string` | 準拠 |

### 4. テスト設計 <-> 実装設計

| テストケース | 対応する実装箇所 | data-testid | 整合性 |
|------------|----------------|------------|--------|
| encodePathForUrl 単一セグメント | encodePathForUrl('newdir') | N/A (ユニットテスト) | 一致 |
| encodePathForUrl 複数セグメント | path.split('/').map(encodeURIComponent).join('/') | N/A | 一致 |
| encodePathForUrl 空文字列 | `if (!path) return ''` ガード | N/A | 一致 |
| encodePathForUrl 特殊文字 | encodeURIComponent per segment | N/A | 一致 |
| [SF-3] 先頭/連続/末尾スラッシュ | split('/') の動作仕様 | N/A | 一致 |
| ツールバー表示（非空） | L877付近に挿入予定 | `file-tree-toolbar` | 一致 |
| ツールバー非表示（空） | L827 `rootItems.length === 0` 分岐 | N/A | 一致 |
| New File クリック | `onNewFile('')` 呼び出し | `toolbar-new-file-button` | 一致 |
| New Directory クリック | `onNewDirectory('')` 呼び出し | `toolbar-new-directory-button` | 一致 |
| コールバック未指定 | `(onNewFile \|\| onNewDirectory) &&` ガード | N/A | 一致 |
| 空状態ボタン維持 | L827-861 既存コード | `empty-new-directory-button` | 一致 |

---

## Detailed Findings

### Should Fix (3件)

#### SF-1: handleFileInputChangeのAPIエンドポイント記載不正確

- **重要度**: Should Fix
- **カテゴリ**: 設計方針書 <-> 実装コード: APIエンドポイント整合性
- **問題**: 設計方針書Section 3.3の修正箇所テーブルで、5番目のhandleFileInputChange (L1408)のAPI Path列が `/api/.../files/` と記載されているが、実際のコードは `/api/worktrees/${worktreeId}/upload/${encodeURIComponent(uploadPath)}` であり、エンドポイントは `/upload/` である。
- **根拠**: `WorktreeDetailRefactored.tsx` L1408を直接確認。他の4箇所が `/files/` エンドポイントを使用しているのに対し、5番目のみ `/upload/` エンドポイントを使用。
- **推奨**: テーブルの5番目のAPI Pathを `/api/.../upload/` に修正する。

#### SF-2: handleNewFileの.md拡張子自動付与ロジックの未記載

- **重要度**: Should Fix
- **カテゴリ**: 設計方針書 <-> 実装コード: 動作契約
- **問題**: handleNewFile (L1242)の実装には、L1246-1247で `.md` 拡張子を自動付与するロジックが含まれている (`const finalName = fileName.endsWith('.md') ? fileName : '${fileName}.md'`)。encodePathForUrlはこの自動付与後のnewPathに対して適用されるが、設計方針書にこの動作の記載がない。
- **根拠**: `WorktreeDetailRefactored.tsx` L1246-1248を直接確認。
- **推奨**: Section 3.3の修正箇所テーブルに備考として「handleNewFileは.md拡張子自動付与後のパスに対してencodePathForUrlを適用」と注記を追加する。

#### SF-3: useFileOperations.tsのパスエンコード未使用に関する注記欠落

- **重要度**: Should Fix
- **カテゴリ**: テスト設計 <-> 実装設計
- **問題**: `useFileOperations.ts` (L71) は `/api/worktrees/${worktreeId}/files/${moveTarget.path}` でパスエンコードなしでAPIを呼び出している。Issue本文の影響範囲セクションにはこの点が注記されているが、設計方針書のSection 4.3 (既存テスト影響) にはuseFileOperationsに関する言及がない。
- **根拠**: `useFileOperations.ts` L70-71を直接確認。encodeURIComponentもencodePathForUrlも使用されていない。
- **推奨**: Section 4.3にuseFileOperations.tsのパスエンコード未使用についての注記を追加し、Issue本文との整合性を確保する。

### Nice to Have (3件)

#### NTH-1: ツールバー挿入位置のより正確な行番号

- **重要度**: Nice to Have
- **カテゴリ**: 設計方針書 <-> 実装コード: 行番号精度
- **問題**: 設計方針書で「L877付近」としている挿入位置は、より正確にはL883（className属性閉じ `>` の後）とL884（filteredRootItems.mapの前）の間である。
- **推奨**: 「L883-884間」と記載すると実装者にとってより明確になる。

#### NTH-2: FILE_EXISTSエラーの受け入れ条件

- **重要度**: Nice to Have
- **カテゴリ**: 設計方針書 <-> Issue要件
- **問題**: Issue要件の「同名のディレクトリ/ファイルが存在する場合のみFILE_EXISTSエラー」が設計方針書のSection 8に含まれていない。バックエンドスコープ外だが明示的な確認があると望ましい。
- **推奨**: Section 8にバックエンドの既存動作維持を確認する項目を追加する。

#### NTH-3: 空状態ボタンの行番号の微修正

- **重要度**: Nice to Have
- **カテゴリ**: 設計方針書 <-> 実装コード: 行番号精度
- **問題**: [SF-1]で「L837-L858」と記載しているが、条件式の開始はL835 (`{(onNewFile || onNewDirectory) && (`）である。
- **推奨**: L835-858に修正する。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | upload APIのエンドポイント差異が実装時に見落とされる可能性 | Low | Low | P3 |
| セキュリティ | encodePathForUrlのセキュリティ責務境界は正しく定義済み。isPathSafe()による防御チェーンは影響なし | Low | Low | N/A |
| 運用リスク | handleNewFileの.md自動付与が将来変更された場合にencodePathForUrlの適用位置が影響を受ける | Low | Low | P3 |

---

## Approval Status

**Conditionally Approved** (Score: 4/5)

3件のShould Fixは全て設計方針書の記載精度に関するものであり、実装の正しさや安全性には影響しない。設計方針書の修正は推奨されるが、実装着手をブロックするものではない。

### 承認条件
1. SF-1: handleFileInputChangeのAPIエンドポイントを `/upload/` に修正（推奨）
2. SF-2: handleNewFileの.md拡張子自動付与ロジックの注記追加（推奨）
3. SF-3: useFileOperations.tsのパスエンコード未使用の注記追加（推奨）

---

*Generated by architecture-review-agent for Issue #300 Stage 2 (整合性レビュー)*
