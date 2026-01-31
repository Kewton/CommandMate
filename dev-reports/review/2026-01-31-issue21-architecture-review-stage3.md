# Issue #21 アーキテクチャレビュー - Stage 3 影響分析レビュー

## レビュー情報

| 項目 | 内容 |
|------|------|
| Issue番号 | #21 |
| 機能名 | ファイルツリー検索機能 |
| レビューステージ | Stage 3: 影響分析レビュー |
| レビュー日 | 2026-01-31 |
| レビュー対象 | dev-reports/design/issue-21-file-search-design-policy.md |

---

## サマリ

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2件 |
| Should Fix | 4件 |
| Nice to Have | 3件 |
| Positive Feedback | 5件 |

---

## Must Fix (実装前に必ず対応が必要)

### IMPACT-MF-001: FileTreeViewへの検索クエリprops追加による破壊的変更

**カテゴリ**: 変更の波及効果

**説明**: FileTreeView.tsxの既存propsインターフェース(FileTreeViewProps)に検索関連プロパティを追加する場合、このコンポーネントを使用している全ての箇所で対応が必要になる

**影響を受けるファイル**:
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/components/worktree/FileTreeView.tsx`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/components/worktree/WorktreeDetailRefactored.tsx`

**現状**: FileTreeViewPropsには検索関連propsが存在しない

**影響**: WorktreeDetailRefactored.tsx内でFileTreeViewを使用している箇所(デスクトップ、モバイル両方)で新規propsの追加が必要

**推奨対応**: 新規propsは全てオプショナル(?)として定義し、後方互換性を維持する

```typescript
// src/components/worktree/FileTreeView.tsx
export interface FileTreeViewProps {
  // 既存props...

  // 新規追加(全てオプショナル)
  searchQuery?: string;
  searchMode?: SearchMode;
  onSearchResultSelect?: (path: string) => void;
}
```

---

### IMPACT-MF-002: 新規APIエンドポイント追加に伴うルーティング影響

**カテゴリ**: 依存関係の影響

**説明**: GET /api/worktrees/:id/search エンドポイントの追加。既存APIパターンとの整合性および認証ミドルウェアの適用確認が必要

**影響を受けるファイル**:
- `src/app/api/worktrees/[id]/search/route.ts` (新規)
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/middleware.ts`

**現状**: src/app/api/worktrees/[id]/ 配下に search/ ディレクトリは存在しない

**影響**:
1. APIエンドポイントは認証トークンチェックの対象となる(既存middleware.tsにて/api/*パスは認証対象)
2. 他の既存エンドポイント(tree, files等)とのURLパターン競合はなし

**推奨対応**: 既存の/api/worktrees/[id]/tree/route.tsを参考に、同様のパターンでworktree存在チェック、パス検証を実装する

---

## Should Fix (対応推奨)

### IMPACT-SF-001: useFileSearchフック追加によるWorktreeDetailRefactoredの複雑度増加

**カテゴリ**: 変更の波及効果

**説明**: WorktreeDetailRefactored.tsxは既に1600行超の大規模コンポーネント。新たにuseFileSearchフックを統合すると状態管理がさらに複雑化する

**推奨対応**: useFileSearchフックを「検索状態とUI」と「API呼び出しロジック」に責務分離することを検討(Stage 1のDP-002で指摘済み)。実装時はuseWorktreeUIStateパターンを参考にし、状態をreducer化することで可読性を維持

---

### IMPACT-SF-002: models.tsへの型追加による型定義ファイル肥大化

**カテゴリ**: 型定義変更の波及範囲

**説明**: SearchMode, SearchQuery, SearchResult, SearchResultItem の4型をmodels.tsに追加予定。models.tsは既に269行あり肥大化傾向

**推奨対応**: 検索関連型は models.ts に追加で問題ないが、将来的に型定義が300行を超える場合は search.ts など専用ファイルへの分離を検討。現時点では追加のみで対応

---

### IMPACT-SF-003: utils.tsへのescapeRegExp追加とテストカバレッジ

**カテゴリ**: テストへの影響

**説明**: utils.tsにescapeRegExp関数を追加予定(Stage 2のCONS-SF-002対応済み)。既存のutils.test.tsにテストケース追加が必要

**推奨対応**: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/tests/unit/lib/utils.test.ts` にescapeRegExpのテストケースを追加

テスト項目:
- 特殊文字エスケープ(.*+?^${}()|[]\\ )
- 空文字列
- 日本語文字列
- 実際の検索パターンケース

---

### IMPACT-SF-004: binary-extensions.ts新規作成とimage-extensions.tsとの整合性

**カテゴリ**: 依存関係の影響

**説明**: 設計書(DP-004)でsrc/config/binary-extensions.tsの新規作成が予定されている。既存のimage-extensions.tsとの拡張子重複や設計パターンの整合性確認が必要

**影響を受けるファイル**:
- `src/config/binary-extensions.ts` (新規)
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/config/image-extensions.ts`
- `src/lib/file-search.ts` (新規)

**推奨対応**: binary-extensions.tsではimage-extensions.tsをインポートして拡張子を再利用するか、または設計書記載通りコメントで整合性を明記

```typescript
// src/config/binary-extensions.ts
import { IMAGE_EXTENSIONS } from './image-extensions';

export const BINARY_EXTENSIONS = [
  // 画像(image-extensions.tsと整合性を保つ)
  ...IMAGE_EXTENSIONS,
  // 実行ファイル
  '.exe', '.dll', '.so', '.dylib',
  // アーカイブ
  '.zip', '.tar', '.gz', '.rar', '.7z',
  // その他バイナリ
  '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.eot',
] as const;
```

---

## Nice to Have (あると良い)

### IMPACT-NTH-001: 検索結果ハイライト時のレンダリングパフォーマンス

**カテゴリ**: パフォーマンスへの影響

**説明**: 設計書のHighlightedTextコンポーネントは検索クエリでテキストを分割してハイライト表示する。大量のマッチ結果がある場合のレンダリングコストを考慮

**推奨対応**: 初期実装では現状の設計で進め、パフォーマンス問題が発生した場合にReact.memoやuseMemoで最適化を検討

---

### IMPACT-NTH-002: ファイル内容検索API追加によるサーバー負荷

**カテゴリ**: パフォーマンスへの影響

**説明**: ファイル内容検索APIはディレクトリを再帰的に走査し、テキストファイルを読み込んで検索する。大規模リポジトリでの負荷を考慮

**推奨対応**: 初期実装後、実際の使用状況を監視し、必要に応じて制限値を調整。ログにexecutionTimeMsを出力して性能監視

---

### IMPACT-NTH-003: モバイルUIでの検索バー表示/非表示アニメーション

**カテゴリ**: 変更の波及効果

**説明**: 設計書ではモバイルで検索バーをアイコンタップで表示/非表示とする仕様。MobileContentやMobileTabBarとのUI調整が必要

**推奨対応**: デスクトップ版を先に実装し、モバイル対応は後続フェーズで対応可能

---

## Positive Feedback (良い点)

| ID | タイトル | 説明 |
|----|---------|------|
| IMPACT-POS-001 | 既存モジュールの適切な再利用 | file-tree.ts(EXCLUDED_PATTERNS, LIMITS)、path-validator.ts(isPathSafe)、utils.ts(debounce)の再利用が計画されており、DRY原則に従っている |
| IMPACT-POS-002 | 段階的な実装計画 | Phase 1(基盤) -> Phase 2(API) -> Phase 3(フロントエンド)の段階的実装により、各フェーズで影響範囲を限定できる |
| IMPACT-POS-003 | テスト計画の明確化 | ユニットテスト、結合テスト、E2Eテストが計画されており、テストカバレッジへの配慮がある |
| IMPACT-POS-004 | オプショナルな機能追加設計 | 検索機能はファイルツリーの拡張機能として追加される設計であり、既存のファイルツリー機能に影響を与えない |
| IMPACT-POS-005 | 循環依存のリスクなし | 新規モジュールは既存モジュールに一方向で依存し、逆方向の依存は発生しない設計になっている |

---

## 依存関係分析

### 新規モジュールの依存関係

```
src/config/binary-extensions.ts
    depends_on: []
    depended_by: [src/lib/file-search.ts]

src/lib/file-search.ts
    depends_on:
      - src/lib/file-tree.ts (EXCLUDED_PATTERNS, isExcludedPattern, LIMITS)
      - src/lib/path-validator.ts (isPathSafe)
      - src/config/binary-extensions.ts (BINARY_EXTENSIONS)
    depended_by: [src/app/api/worktrees/[id]/search/route.ts]

src/app/api/worktrees/[id]/search/route.ts
    depends_on:
      - src/lib/file-search.ts (searchFileContents)
      - src/lib/db.ts (getWorktreeById)
    depended_by: []

src/hooks/useFileSearch.ts
    depends_on:
      - src/lib/utils.ts (debounce)
      - src/types/models.ts (SearchMode, SearchResult)
    depended_by: [src/components/worktree/WorktreeDetailRefactored.tsx]

src/components/worktree/SearchBar.tsx
    depends_on:
      - src/types/models.ts (SearchMode)
      - src/lib/utils.ts (escapeRegExp)
    depended_by: [src/components/worktree/WorktreeDetailRefactored.tsx]
```

**循環依存のリスク**: なし

---

## テスト影響分析

### 新規テストファイル

| ファイル | テストケース |
|---------|-------------|
| tests/unit/lib/file-search.test.ts | 検索ロジック、EXCLUDED_PATTERNS、タイムアウト、バイナリ除外 |
| tests/unit/hooks/useFileSearch.test.ts | 状態管理、debounce、エラーハンドリング |
| tests/unit/components/worktree/SearchBar.test.tsx | UI操作、モード切替、ローディング |
| tests/integration/api-search.test.ts | 検索API正常系/異常系 |

### 既存テストへの影響

| ファイル | 変更内容 |
|---------|----------|
| tests/unit/lib/utils.test.ts | escapeRegExp関数のテストケース追加 |

---

## パフォーマンス影響分析

### クライアントサイド

| 項目 | リスク | 説明 |
|------|--------|------|
| レンダリング | Low | FileTreeViewのrootItemsはmemo化で最適化可能 |
| メモリ | Low | 検索結果100件制限で許容範囲内 |

### サーバーサイド

| 項目 | リスク | 説明 | 軽減策 |
|------|--------|------|--------|
| CPU | Medium | ディレクトリ再帰走査 | タイムアウト5秒、結果100件制限 |
| I/O | Medium | 多数のファイル読み込み | EXCLUDED_PATTERNS、バイナリ除外 |

---

## 実装推奨事項

### 実装前

1. FileTreeViewProps拡張時はオプショナルプロパティとして定義し後方互換性を維持
2. 既存のfile-tree.tsのテストを確認し、EXCLUDED_PATTERNSのエクスポートが正しく機能することを確認

### 実装中

1. Phase 1(基盤)完了時点でmodels.tsの型定義とutils.tsのescapeRegExpをコミットし、レビューを実施
2. Phase 2(API)完了時点で結合テストを実行し、APIレスポンス形式が既存パターンと整合していることを確認

### 実装後

1. 検索APIのexecutionTimeMsをログに出力し、本番環境でのパフォーマンスを監視
2. CLAUDE.mdに検索機能のモジュール情報を追加

---

## 結論

影響分析の結果、Issue #21の設計方針書は既存コードベースへの影響を最小限に抑えた設計となっている。

**Must Fix 2件**:
- FileTreeViewProps拡張の後方互換性 -> オプショナルプロパティ化で解決
- 新規APIエンドポイントの認証確認 -> 既存パターン踏襲で解決

**循環依存リスク**: なし

**テスト計画**: 明確に定義されており、カバレッジへの配慮あり

**次のステップ**: Stage 4(セキュリティレビュー)への移行準備完了

---

## 関連ファイル

- 設計方針書: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/design/issue-21-file-search-design-policy.md`
- Stage 1結果: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/21/multi-stage-design-review/stage1-review-result.json`
- Stage 2結果: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/21/multi-stage-design-review/stage2-review-result.json`
- Stage 3結果: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/21/multi-stage-design-review/stage3-review-result.json`
