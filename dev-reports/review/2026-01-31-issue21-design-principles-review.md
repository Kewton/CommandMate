# Issue #21 設計原則レビュー報告書

## 概要

| 項目 | 内容 |
|------|------|
| Issue番号 | #21 |
| レビュー対象 | ファイルツリー検索機能 設計方針書 |
| 設計書パス | `dev-reports/design/issue-21-file-search-design-policy.md` |
| レビュー日 | 2026-01-31 |
| レビュータイプ | 設計原則レビュー（SOLID, KISS, YAGNI, DRY） |

## サマリー

| カテゴリ | 件数 |
|----------|------|
| Must Fix (MF) | 1 |
| Should Fix (SF) | 3 |
| Nice to Have (NTH) | 4 |
| **合計** | **8** |

## 評価結果

設計方針書は全体的にSOLID原則、KISS、YAGNI、DRYに従った良い設計になっている。Must Fixは1件のみで、これは設計書内の参照先の記載ミスである。設計思想自体には問題がなく、既存コードの再利用も適切に計画されている。

---

## Must Fix（実装前に修正必須）

### DP-001: isPathSafe関数のインポート元が誤っている

**原則**: DRY

**問題**: 設計書のセクション5.2では`isPathSafe`を`file-tree.ts`からインポートすると記載されているが、実際には`path-validator.ts`に定義されている。

**現在の設計書の記載**:
```typescript
import { isPathSafe } from './file-tree';
```

**正しい記載**:
```typescript
import { isPathSafe } from './path-validator';
```

**影響**: 実装時にインポートエラーが発生し、混乱を招く可能性がある。

---

## Should Fix（修正推奨）

### DP-002: useFileSearchフックの責務が多い

**原則**: SRP（単一責任の原則）

**問題**: useFileSearchフックは以下の4つの責務を持つ設計になっている:
1. 検索状態管理
2. debounce処理
3. API呼び出し
4. エラーハンドリング

**推奨**: API呼び出し部分を`src/lib/search-api-client.ts`として分離し、useFileSearchは状態管理に集中させる。

**影響**: 現状でも動作するが、テストしづらく、APIクライアントの再利用が難しい。初期実装では許容可能だが、将来のリファクタリング候補として記録すべき。

---

### DP-003: MAX_FILE_SIZE_PREVIEW定数の参照元が不統一

**原則**: DRY

**問題**: 設計書セクション9.1では`src/config/file-operations.ts`から`MAX_FILE_SIZE_PREVIEW`を参照すると記載しているが、実際には`src/lib/file-tree.ts`の`LIMITS.MAX_FILE_SIZE_PREVIEW`に定義されている。

`file-operations.ts`には`DELETE_SAFETY_CONFIG`のみが存在する。

**正しい参照先**:
```typescript
import { LIMITS } from '@/lib/file-tree';
// LIMITS.MAX_FILE_SIZE_PREVIEW を使用
```

**影響**: 実装時に定数が見つからず、別途定義される可能性がある（DRY違反）。

---

### DP-004: BINARY_EXTENSIONSの拡張性が考慮されていない

**原則**: OCP（開放閉鎖の原則）

**問題**: バイナリファイル除外のための`BINARY_EXTENSIONS`がfile-search.ts内でハードコードされる設計になっている。

**現在の設計**:
```typescript
const BINARY_EXTENSIONS = ['.png', '.jpg', '.gif', '.webp', '.exe', '.dll', '.so', '.zip', '.tar.gz'];
```

**推奨**: `src/config/binary-extensions.ts`として設定ファイル化し、`image-extensions.ts`など既存設定との整合性を取る。

**影響**: 初期実装では問題ないが、将来の拡張時にコード変更が必要になる。

---

## Nice to Have（あると良い）

### DP-005: searchFileContentsのファイルシステム依存

**原則**: DIP（依存性逆転の原則）

**現状**: `searchFileContents`関数がfsモジュールに直接依存する設計になっている。

**備考**: テスト時にモック化が難しくなる可能性があるが、現状のスコープでは`FileSystemInterface`抽象の導入はオーバーエンジニアリングとなる。将来の検討事項として記録。

---

### DP-006: SearchOptionsインターフェースが細分化可能

**原則**: ISP（インターフェース分離の原則）

**現状**: `SearchOptions`インターフェースに4つのオプション（maxResults, timeoutMs, maxFileSize, maxDepth）が含まれている。

**備考**: 全オプションがoptionalなため実用上の問題はない。将来的に`LimitOptions`, `TimeoutOptions`などに分離することも可能だが、現時点では不要。

---

### DP-007: HighlightedTextコンポーネントの正規表現処理

**原則**: KISS

**現状**: XSS対策として示されている`HighlightedText`の実装は、`escapeRegExp`でエスケープ後に`split/map`で処理している。

**備考**: 検索結果は100件制限があるため、パフォーマンス問題は発生しない。現状維持で問題なし。

---

### DP-008: 将来検討項目が適切にスコープ外化されている（ポジティブ）

**原則**: YAGNI

**評価**: 以下の項目が明確に「対象外」「将来検討」として記載されており、YAGNIに従った良い設計判断がなされている:
- 正規表現検索
- 大文字/小文字の区別オプション
- 検索履歴の保存
- 検索インデックスの事前構築
- Web Workerでのバックグラウンド検索

---

## 良い点（Positive Points）

| 原則 | 評価内容 |
|------|----------|
| **DRY** | `debounce`関数、`EXCLUDED_PATTERNS`、`MAX_DEPTH`定数などの既存コードを再利用する設計になっている |
| **SRP** | SearchBarコンポーネントをFileTreeViewから分離することで単一責任を維持。レイヤー構成が明確 |
| **KISS** | 外部ライブラリの追加なし。React標準機能とAbortController（標準API）で実装する方針は適切 |
| **YAGNI** | 検索インデックス、Web Worker、正規表現検索などの高度な機能を明確にスコープ外としている |
| **OCP** | SearchModeを`'name' | 'content'`の型で定義しており、将来的なモード追加に対応しやすい |

---

## 推奨アクション

| 優先度 | アクション | 理由 |
|--------|-----------|------|
| **高** | isPathSafeのインポート元を`path-validator.ts`に修正 | 実装時のエラー防止 |
| **中** | MAX_FILE_SIZE_PREVIEWの参照元を正確に記載（file-tree.tsのLIMITS） | DRY原則に従い既存定数を正しく参照 |
| **中** | BINARY_EXTENSIONSを設定ファイルとして分離することを検討 | image-extensions.tsとの整合性確保 |
| **低** | APIクライアント分離は将来のリファクタリングとして検討 | 初期実装では許容可能 |

---

## 結論

設計方針書は全体的に良好な設計品質を維持している。主な指摘事項は設計書内の参照先の記載ミス（isPathSafe、MAX_FILE_SIZE_PREVIEW）であり、設計思想自体には問題がない。

**実装前に対応が必要な項目**: DP-001（isPathSafeのインポート元修正）

**実装可能判定**: 上記1件を修正後、実装を開始して問題なし。

---

## 関連ファイル

- 設計方針書: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/design/issue-21-file-search-design-policy.md`
- レビュー結果JSON: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/21/multi-stage-design-review/stage1-review-result.json`
- 参照された既存コード:
  - `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/path-validator.ts`
  - `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/file-tree.ts`
  - `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/utils.ts`
  - `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/config/file-operations.ts`
