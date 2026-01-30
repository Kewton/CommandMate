# Issue #49 整合性レビュー報告書

**レビュー日**: 2026-01-30
**レビュー種別**: Stage 2 - 整合性レビュー
**対象Issue**: #49 マークダウンエディタとビューワー
**設計書**: `dev-reports/design/issue-49-markdown-editor-design-policy.md`

---

## 1. エグゼクティブサマリー

| 項目 | 内容 |
|------|------|
| **ステータス** | Conditionally Approved |
| **スコア** | 4/5 |
| **Must Fix** | 1件 |
| **Should Fix** | 3件 |
| **Nice to Have** | 3件 |

設計方針書は全体として高い品質であり、既存コードベースとの整合性も良好です。ただし、**debounce関数の参照先が存在しない**という1件のMust Fix項目があり、実装前に解決が必要です。

---

## 2. 詳細レビュー結果

### 2.1 Must Fix (実装前に対応必須)

#### MF-001: debounce関数の参照先が存在しない

| 項目 | 内容 |
|------|------|
| **カテゴリ** | 設計 vs コード |
| **重要度** | High |
| **設計書参照** | Section 8.2 デバウンス実装 |

**問題**:
設計書 Section 8.2 で以下のコードが示されています。

```typescript
import { debounce } from '@/lib/utils';
```

しかし、実際のコードベースには `src/lib/utils.ts` ファイルが存在しません。

**現状のsrc/lib/配下のファイル一覧**（一部抜粋）:
- path-validator.ts
- file-tree.ts
- api-client.ts
- env.ts
- db.ts
- logger.ts
- ... (utils.ts は存在しない)

**推奨対応**:
以下のいずれかの方法で対応してください。

1. **Option A**: `src/lib/utils.ts` を新規作成し、debounce関数を実装
   ```typescript
   // src/lib/utils.ts
   export function debounce<T extends (...args: Parameters<T>) => ReturnType<T>>(
     fn: T,
     delay: number
   ): (...args: Parameters<T>) => void {
     let timeoutId: NodeJS.Timeout | undefined;
     return (...args: Parameters<T>) => {
       if (timeoutId) clearTimeout(timeoutId);
       timeoutId = setTimeout(() => fn(...args), delay);
     };
   }
   ```

2. **Option B**: カスタムhook `useDebounce` を作成
   ```typescript
   // src/hooks/useDebounce.ts
   export function useDebounce<T>(value: T, delay: number): T { ... }
   ```

3. **Option C**: 設計書を修正し、コンポーネント内でインラインで実装する方針を明記

---

### 2.2 Should Fix (実装時に対応推奨)

#### SF-001: PATCHリクエストのエンドポイント設計の曖昧さ

| 項目 | 内容 |
|------|------|
| **カテゴリ** | 設計内部整合性 |
| **重要度** | Medium |
| **設計書参照** | Section 6.1, 6.2 |

**問題**:
- 設計書 Section 6.1 では PATCH を `/api/worktrees/:id/files/:path` に配置と記載
- Issue #49 では `/api/worktrees/:id/files/:path/rename` との記載もあり
- 設計書 Section 6.2 では `action: "rename"` をリクエストボディで使用

**推奨対応**:
設計書にて、PATCHエンドポイントが `[...path]/route.ts` 内で処理され、`action: "rename"` フィールドで識別される旨を明確に記載してください。

#### SF-002: 既存route.tsのパス検証との統合方針の具体化

| 項目 | 内容 |
|------|------|
| **カテゴリ** | 設計 vs コード |
| **重要度** | Medium |
| **設計書参照** | Section 7.2 |

**現状のコード** (route.ts L34-39):
```typescript
// Security: Prevent path traversal attacks
if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
  return NextResponse.json(
    { error: 'Invalid file path' },
    { status: 400 }
  );
}
```

**isPathSafe() の機能** (path-validator.ts):
- URLデコード対応
- null byte インジェクション検出
- 相対パス検証（path.relative を使用）

**推奨対応**:
isPathSafe() はより堅牢な実装ですが、移行時に既存の正当なリクエストが拒否されないことをテストで確認してください。

#### SF-003: FileTreeView.tsx の行数と変更規模の再確認

| 項目 | 内容 |
|------|------|
| **カテゴリ** | 設計 vs コード |
| **重要度** | Medium |
| **設計書参照** | Section 2.1, 11.2 |

**現状**:
- FileTreeView.tsx: 465行（設計書と一致）
- 右クリックメニュー追加により推定150-200行の追加

**推奨対応**:
右クリックメニュー機能を `ContextMenu.tsx` として分離することで、FileTreeView.tsx の肥大化を防止することを検討してください。

---

### 2.3 Nice to Have (将来検討)

| ID | タイトル | 概要 |
|----|---------|------|
| NTH-001 | Toast コンポーネントの配置ディレクトリ | `src/components/common/` ディレクトリ作成方針をCLAUDE.mdに追記 |
| NTH-002 | 大容量ファイル警告の閾値 | 設計どおり既存定数（LIMITS.MAX_FILE_SIZE_PREVIEW）を流用で問題なし |
| NTH-003 | WorktreeDetailRefactored.tsx の変更箇所 | handleFileSelect (L895-897) への拡張子判定追加は設計どおり |

---

## 3. 整合性チェック結果

### 3.1 設計書 vs 既存コード

| 確認項目 | 設計書 | 実装 | 状態 |
|----------|--------|------|------|
| 既存API route.ts の構造 | GET のみ実装、新規メソッド追加 | GET のみ実装（95行） | Consistent |
| react-markdown の使用 | 既存依存として使用 | package.json に存在、MessageList.tsx で使用 | Consistent |
| path-validator.ts の isPathSafe | パストラバーサル対策に使用 | L29-68 に堅牢な実装あり | Consistent |
| file-tree.ts の EXCLUDED_PATTERNS | .env, .git 等への書き込み禁止 | L34-47 に定義済み | Consistent |
| TreeItem インターフェース | types/models.ts に準拠 | 定義済み | Consistent |
| **debounce 関数** | @/lib/utils から import | **ファイル存在せず** | **Inconsistent** |

### 3.2 設計書内部整合性

| 確認項目 | セクションA | セクションB | 状態 |
|----------|-------------|-------------|------|
| API エンドポイントの一貫性 | 6.1 エンドポイント一覧 | 6.2 リクエスト/レスポンス仕様 | Consistent |
| エラーコードの一貫性 | 6.3 エラーコード一覧 | 7.1 脅威と対策 | Consistent |
| ファイル操作ロジックの配置 | 4.3 Facadeパターン | 11.2 変更ファイル一覧 | Consistent |
| 表示モードの型定義 | 4.2 Strategyパターン | 5.1 型定義 | Consistent |

### 3.3 設計書 vs Issue #49

| 確認項目 | 設計書 | Issue | 状態 |
|----------|--------|-------|------|
| 機能要件のスコープ | md のみ編集可、画像アップロードなし | 対象外として同項目明記 | Consistent |
| トースト通知の実装方針 | 自作 Toast.tsx を src/components/common/ に配置 | 同上 | Consistent |
| ローカルストレージキー | commandmate:md-editor-view-mode | 同上 | Consistent |
| 再帰削除の確認フロー | recursive=true クエリパラメータ | 同上 | Consistent |
| リネームAPIの実装方法 | PATCH + action: rename | 推奨実装方法として記載 | Consistent |

---

## 4. リスク評価

| リスク種別 | 評価 | 説明 |
|-----------|------|------|
| 技術的リスク | Low | 既存の堅牢なセキュリティ関数（isPathSafe, EXCLUDED_PATTERNS）を活用 |
| セキュリティリスク | Low | パストラバーサル対策が設計に組み込まれている |
| 運用リスク | Low | 後方互換性が維持される設計 |

---

## 5. 推奨アクション

### 実装前に必須

1. **MF-001 解決**: debounce関数の実装方針を決定し、設計書を更新または`src/lib/utils.ts`を作成

### 実装時に推奨

2. **SF-001**: PATCHエンドポイントの実装方法を設計書で明確化
3. **SF-002**: isPathSafe() への移行時に回帰テストを実施
4. **SF-003**: FileTreeView.tsx の肥大化を防ぐためContextMenu分離を検討

---

## 6. 承認

| 項目 | 内容 |
|------|------|
| **レビュー結果** | 条件付き承認（Conditionally Approved） |
| **条件** | MF-001（debounce関数）の解決 |
| **次のステップ** | MF-001解決後、Stage 3（影響範囲レビュー）へ進行可能 |

---

## 7. レビュー対象ファイル

- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/design/issue-49-markdown-editor-design-policy.md`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/app/api/worktrees/[id]/files/[...path]/route.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/components/worktree/FileTreeView.tsx`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/path-validator.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/lib/file-tree.ts`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/components/worktree/MessageList.tsx`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/components/worktree/WorktreeDetailRefactored.tsx`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/package.json`
- `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/src/types/models.ts`
