# Issue #21 設計方針書 整合性レビュー報告書

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue番号 | #21 |
| 機能名 | ファイルツリー検索機能 |
| レビューステージ | Stage 2: 整合性レビュー |
| レビュー日 | 2026-01-31 |
| 設計書 | `dev-reports/design/issue-21-file-search-design-policy.md` |
| 結果ファイル | `dev-reports/issue/21/multi-stage-design-review/stage2-review-result.json` |

---

## レビュー結果サマリ

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2件 |
| Should Fix | 3件 |
| Nice to Have | 2件 |
| Positive Feedback | 5件 |

---

## Must Fix (実装前に必ず修正が必要)

### CONS-MF-001: isPathSafe関数のシグネチャが逆順

**カテゴリ**: 設計書と既存コードの整合性

**問題**:
設計書セクション5.2のisPathSafe呼び出しでは`isPathSafe(basePath, filePath)`と記載されているが、実際の`path-validator.ts`の実装では引数の順序が逆である。

**設計書の記載**:
```typescript
if (!isPathSafe(basePath, filePath)) {
  continue;
}
```

**実際の実装** (`src/lib/path-validator.ts:29`):
```typescript
export function isPathSafe(targetPath: string, rootDir: string): boolean
```

**修正案**:
設計書のコード例を正しい呼び出し順序に修正:
```typescript
if (!isPathSafe(filePath, basePath)) {
  continue;
}
```

---

### CONS-MF-002: APIレスポンス形式の不一致

**カテゴリ**: API設計パターン整合性

**問題**:
設計書のSearchResponseインターフェースは既存のAPIパターンと異なる形式を採用している。

**設計書の形式**:
```typescript
interface SearchResponse {
  success: boolean;
  data?: {
    results: SearchResultItem[];
    totalMatches: number;
    truncated: boolean;
  };
  error?: {
    code: string;
    message: string;
  };
}
```

**既存APIパターン** (`src/app/api/worktrees/[id]/files/[...path]/route.ts`):
```typescript
// 成功時
return NextResponse.json({
  success: true,
  path: relativePath,
  content: dataUri,
  extension,
  worktreePath: worktree.path,
  isImage: true,
  mimeType,
});

// エラー時
return NextResponse.json(
  { success: false, error: { code, message } },
  { status }
);
```

**修正案**:
既存パターンに統一:
```typescript
// 成功レスポンス
interface SearchSuccessResponse {
  success: true;
  results: SearchResultItem[];
  totalMatches: number;
  truncated: boolean;
  executionTimeMs: number;
}

// エラーレスポンス
interface SearchErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

type SearchResponse = SearchSuccessResponse | SearchErrorResponse;
```

---

## Should Fix (修正推奨)

### CONS-SF-001: EXCLUDED_PATTERNSの記載不完全

**カテゴリ**: 設計書内の整合性

**問題**:
設計書セクション5.1では機密ファイル除外パターンとして一部のみ記載しているが、実際の`file-tree.ts`にはより多くのパターンが定義されている。

**実際の定義** (`src/lib/file-tree.ts:34-47`):
```typescript
export const EXCLUDED_PATTERNS: string[] = [
  '.git',
  '.env',
  '.env.*',
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '*.pem',
  '*.key',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
];
```

**修正案**:
設計書に「EXCLUDED_PATTERNS準拠」と記載しているため詳細列挙は不要だが、`file-tree.ts`からインポートして使用する旨を明記すべき。

---

### CONS-SF-002: escapeRegExp関数の実装詳細が未定義

**カテゴリ**: 型定義整合性

**問題**:
設計書セクション5.3のコード例で`escapeRegExp`関数を使用しているが、現在の`utils.ts`には存在しない。実装チェックリストに記載はあるが、具体的な実装が定義されていない。

**現在のutils.ts**:
```typescript
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  // ...
}
```

**修正案**:
セクション9.2に具体的な実装を追記:
```typescript
/**
 * Escape special regex characters in a string
 * @param str - String to escape
 * @returns Escaped string safe for use in RegExp
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

---

### CONS-SF-003: MAX_DEPTH定数の参照方法が不統一

**カテゴリ**: 定数参照整合性

**問題**:
設計書セクション6.1ではディレクトリ深さを「MAX_DEPTH」として参照しているが、実際には`LIMITS.MAX_DEPTH`として定義されている。

**実際の定義** (`src/lib/file-tree.ts:52-59`):
```typescript
export const LIMITS = {
  MAX_ITEMS_PER_DIR: 500,
  MAX_DEPTH: 10,
  MAX_FILE_SIZE_PREVIEW: 1024 * 1024,
} as const;
```

**修正案**:
設計書セクション6.1の表を更新:

| 項目 | 制限値 | 参照 |
|------|--------|------|
| ディレクトリ深さ | 10階層 | `LIMITS.MAX_DEPTH` (file-tree.ts) |

---

## Nice to Have (あると良い)

### CONS-NTH-001: binary-extensions.tsの設計詳細

**問題**:
設計書では`src/config/binary-extensions.ts`を新規作成するが、既存の`image-extensions.ts`のように検証関数を含めるかどうかが明記されていない。

**修正案**:
`isBinaryExtension(ext: string): boolean`関数の定義追加を検討。

---

### CONS-NTH-002: CLAUDE.md更新内容の事前定義

**問題**:
実装チェックリストPhase 5で「CLAUDE.md更新」と記載があるが、具体的な追加内容が定義されていない。

**修正案**:
実装完了後にCLAUDE.mdに追加すべき内容のテンプレートを事前に定義。

---

## ポジティブフィードバック

### CONS-POS-001: 既存モジュールの再利用が適切

- `file-tree.ts`: EXCLUDED_PATTERNS, LIMITS, isExcludedPattern
- `path-validator.ts`: isPathSafe
- `utils.ts`: debounce

DRY原則に従った良い設計が行われている。

---

### CONS-POS-002: Stage 1レビュー指摘事項が反映済み

以下の指摘事項が適切に設計書に反映されている:
- DP-001: isPathSafeのインポート元修正
- DP-003: MAX_FILE_SIZE_PREVIEWの参照元修正
- DP-004: BINARY_EXTENSIONSの設定ファイル化

レビュープロセスが正常に機能している。

---

### CONS-POS-003: ファイル構成がプロジェクト規約に準拠

設計書セクション2.2のディレクトリ構成がCLAUDE.mdのファイル構成規約に準拠:
- APIルート: `src/app/api/worktrees/[id]/search/`
- フック: `src/hooks/useFileSearch.ts`
- ビジネスロジック: `src/lib/file-search.ts`
- 設定: `src/config/binary-extensions.ts`
- 型定義: `src/types/models.ts`

---

### CONS-POS-004: FileTreeViewへの統合設計が既存実装と整合

`WorktreeDetailRefactored.tsx`の既存実装と設計書のFileTreeView変更計画が整合:
- `onFileSelect`コールバックパターンの踏襲
- `refreshTrigger`による再読み込み機構の活用
- 既存機能への影響が最小限

---

### CONS-POS-005: セキュリティ対策が既存パターンに準拠

既存のセキュリティ対策パターンを踏襲:
- `isPathSafe`によるパストラバーサル防止
- `EXCLUDED_PATTERNS`による機密ファイル除外
- 入力バリデーション
- Reactの自動エスケープ活用

一貫したセキュリティアプローチが維持されている。

---

## 推奨アクション

1. **CONS-MF-001, CONS-MF-002は実装前に必ず修正すること**
   - isPathSafe関数の呼び出し順序修正
   - APIレスポンス形式の統一

2. **CONS-SF-001~003は実装時に対応すること**
   - EXCLUDED_PATTERNSの参照方法明記
   - escapeRegExp関数の実装詳細追記
   - MAX_DEPTHの参照方法統一

3. **Stage 3(影響範囲分析)に進む前に、Must Fixを解消すること**

---

## 次のステップ

Must Fix項目を設計書に反映後、Stage 3: 影響範囲分析レビューに進む。

---

*レビュー実施: Architecture Review Agent*
*レビュー日時: 2026-01-31*
