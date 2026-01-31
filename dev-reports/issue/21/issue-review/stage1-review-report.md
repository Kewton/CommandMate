# Issue #21 レビューレポート

**レビュー日**: 2026-01-31
**フォーカス**: 通常レビュー
**イテレーション**: 1回目（Stage 1）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**:
- 実装可能性: **HIGH**
- 明確性: **MEDIUM**
- セキュリティ考慮: **MEDIUM**

Issue全体としては明確に記載されており、実装可能性は高い。ただし、ファイル内容検索時のセキュリティ対策（機密ファイルの除外）と、パフォーマンス制約の明確化が必要。既存コード（debounce関数、EXCLUDED_PATTERNS、isPathSafe）を適切に再利用することで効率的に実装可能。

---

## Must Fix（必須対応）

### MF-1: ファイル内容検索のセキュリティ対策が不十分

**カテゴリ**: セキュリティ
**場所**: ## 技術要件 > セキュリティ セクション

**問題**:
既存の `isPathSafe()` は言及されているが、ファイル内容を読み取って返却する際のセキュリティ考慮（機密ファイルの内容漏洩防止等）が記載されていない。

**証拠**:
- `src/lib/file-tree.ts` の `EXCLUDED_PATTERNS` には `.env`, `.env.*`, `*.pem`, `*.key` 等が含まれる
- しかしファイル内容検索でこれらが除外されるかどうか、Issue本文では明示されていない

**推奨対応**:
ファイル内容検索時のセキュリティ対策を追加:

1. 検索対象ファイルのホワイトリスト（テキストファイル拡張子のみ）
2. 検索結果に含めるファイル内容のサニタイズ
3. 既存の `EXCLUDED_PATTERNS` を検索時にも適用することを明記
4. 正規表現インジェクション対策（将来対応時に必要）

---

## Should Fix（推奨対応）

### SF-1: ファイル内容検索時のパフォーマンス考慮が不十分

**カテゴリ**: 技術的妥当性
**場所**: ## 技術要件 > バックエンド セクション

**問題**:
検索結果は最大100件程度に制限とあるが、検索処理自体のタイムアウト以外のパフォーマンス制約が不明確。

**証拠**:
- `file-tree.ts` には `MAX_FILE_SIZE_PREVIEW: 1MB`, `MAX_DEPTH: 10` が定義済み
- これらを検索機能でも利用するか明記されていない

**推奨対応**:
以下を明確化すべき:

1. 検索対象ファイルの最大サイズ制限（例: 1MB以下）
2. 検索対象ディレクトリの深さ制限（例: MAX_DEPTH: 10）
3. 同時検索リクエスト数の制限
4. 検索キャンセル機能の有無

---

### SF-2: 既存のEXCLUDED_PATTERNSとの整合性が不明確

**カテゴリ**: 整合性
**場所**: ## 技術要件 > バックエンド セクション

**問題**:
`src/lib/file-tree.ts` の `EXCLUDED_PATTERNS` には `.git`, `.env`, `node_modules`, `*.pem`, `*.key` 等が定義されているが、Issue では検索対象の除外パターンについて言及がない。

**証拠**:
```typescript
// src/lib/file-tree.ts
export const EXCLUDED_PATTERNS: string[] = [
  '.git',           // Git internal directory
  '.env',           // Environment variables file
  '.env.*',         // Environment variables file (variants)
  'node_modules',   // Dependencies (excluded by default)
  '.DS_Store',      // macOS system file
  'Thumbs.db',      // Windows system file
  '*.pem',          // Private keys
  '*.key',          // Private keys
  '.env.local',     // Local environment file
  '.env.development',
  '.env.production',
  '.env.test',
];
```

**推奨対応**:
`EXCLUDED_PATTERNS` を検索対象から除外することを明記。特に `.env` ファイルはセキュリティ上重要。

---

### SF-3: 検索応答時間の具体的な基準がない

**カテゴリ**: 受け入れ条件
**場所**: ## 受け入れ条件 セクション

**問題**:
debounce処理（300ms程度）は言及されているが、検索完了までの応答時間の受け入れ条件が明示されていない。

**推奨対応**:
パフォーマンス基準を追加:

- ファイル名検索: 入力後300ms以内にフィルタリングが開始されること
- ファイル内容検索: 5秒以内に結果が返却されること（またはタイムアウト表示）

---

### SF-4: ファイル名検索がクライアントサイドかサーバーサイドか不明確

**カテゴリ**: 明確性
**場所**: ## 提案する解決策 > 検索対象 セクション

**問題**:
API設計では `mode=name|content` とあり両方APIを呼ぶように見えるが、ファイル名検索はクライアントサイドで実装可能な範囲。

**証拠**:
- 現在の `FileTreeView.tsx` は遅延読み込みで動作し、キャッシュを保持
- 既にロード済みのツリーデータでクライアントサイドフィルタリングが可能

**推奨対応**:
ファイル名検索の実装方針を明確化:

1. **案A（推奨）**: クライアントサイドフィルタリング - 既にロード済みのツリーデータを使用。高速でAPI呼び出し不要
2. **案B**: サーバーサイド検索 - 未ロードディレクトリも含めて検索可能だが、API負荷増加

---

## Nice to Have（あれば良い）

### NTH-1: エラーケースの具体例が不足

**カテゴリ**: 完全性
**場所**: ## 受け入れ条件 > 追加条件 セクション

**問題**:
「検索結果が0件の場合」のみ言及されている。

**推奨対応**:
以下のエラーケースを追加:

1. 検索タイムアウト時の表示
2. 検索対象ファイルへのアクセス権限エラー時の処理
3. 検索クエリが長すぎる場合の制限

---

### NTH-2: debounce関数の再利用について言及がない

**カテゴリ**: 完全性
**場所**: ## 技術要件 > フロントエンド セクション

**問題**:
既存の `src/lib/utils.ts` に `debounce` 関数が実装済みであることが参照されていない。

**証拠**:
```typescript
// src/lib/utils.ts
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  // ... implementation
}
```

MarkdownEditor等で既に使用されている。

**推奨対応**:
既存の `src/lib/utils.ts` の `debounce` 関数を再利用することを技術要件に追記。新規実装は不要。

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/FileTreeView.tsx` | 検索機能を追加する主要コンポーネント。現在は検索機能なし（約520行） |
| `src/lib/file-tree.ts` | ディレクトリ読み取りロジック。EXCLUDED_PATTERNS と LIMITS 定数を含む |
| `src/lib/path-validator.ts` | `isPathSafe()` 関数。パストラバーサル対策 |
| `src/lib/utils.ts` | debounce 関数が既に実装済み。検索入力で再利用可能 |
| `src/app/api/worktrees/[id]/tree/route.ts` | 既存のツリーAPI。検索API追加時の参考 |
| `src/types/models.ts` | TreeItem, TreeResponse 型定義。検索結果の型設計時の参考 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクトのコーディング規約と既存機能一覧。整合性確認の参照 |

---

## 次のアクション

1. **MF-1** の対応: セキュリティセクションに機密ファイル除外の明記を追加
2. **SF-1〜SF-4** の検討: パフォーマンス制約と実装方針の明確化
3. Stage 2（影響範囲レビュー）への進行準備
