# Architecture Review: Issue #19 メモ機能改善

**レビュー日**: 2026-01-10
**レビュー対象**: `dev-reports/design/issue-19-memo-improvement-design-policy.md`
**対象Issue**: [#19 メモ機能改善](https://github.com/Kewton/MyCodeBranchDesk/issues/19)

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

| 原則 | 評価 | 詳細 |
|------|------|------|
| **S**ingle Responsibility | OK | MemoPane, MemoCard, MemoAddButton が各々単一の責任を持つ設計 |
| **O**pen/Closed | OK | タブ追加で既存コードへの影響が限定的。LeftPaneTabSwitcher は設定配列の追加のみ |
| **L**iskov Substitution | N/A | 継承階層なし |
| **I**nterface Segregation | OK | WorktreeMemo型は必要最小限のフィールドのみ |
| **D**ependency Inversion | OK | コンポーネントはAPIクライアント経由でデータ層にアクセス |

### その他の原則

| 原則 | 評価 | 詳細 |
|------|------|------|
| KISS | OK | シンプルなCRUD操作、既存パターンの再利用 |
| YAGNI | OK | 要件で明示された5メモ制限のみ実装、過度な拡張なし |
| DRY | OK | MemoCardコンポーネントの再利用設計 |

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | 明確なコンポーネント分離。MemoCardList は不要かもしれない（後述） |
| 結合度 | 4 | API経由の疎結合設計。既存パターンに準拠 |
| 凝集度 | 5 | 各コンポーネントは単一目的に集中 |
| 拡張性 | 4 | 別テーブル設計により将来の拡張が容易 |
| 保守性 | 4 | 既存コードパターンとの一貫性が高い |

### パフォーマンス観点

| 観点 | 評価 | コメント |
|------|------|---------|
| レスポンスタイム | 良好 | 最大5件の小規模データ、インデックス設計済み |
| スループット | 良好 | 軽量なCRUD操作のみ |
| リソース効率 | 良好 | JOINクエリでもデータ量が限定的 |
| スケーラビリティ | 良好 | worktree数に依存しない設計 |

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

| 項目 | 状態 | 対策 |
|------|------|------|
| SQLインジェクション | OK | プリペアドステートメント使用を明記 |
| XSS | OK | 入力バリデーションでエスケープ指定 |
| 認証の破綻 | N/A | ローカルアプリのため認証なし |
| 機微データ露出 | OK | メモは機密性の低いユーザーデータ |
| アクセス制御 | OK | worktree_id存在確認を明記 |
| 入力検証 | OK | title/content/position のバリデーション定義済み |

### 追加セキュリティ考慮事項

**要検討**: 設計書では入力バリデーションが定義されているが、具体的な実装場所が不明確。

**推奨**: APIルートハンドラ内でのバリデーション実装を明記すべき。

---

## 4. 既存システムとの整合性

### 統合ポイント

| 項目 | 整合性 | 詳細 |
|------|--------|------|
| API設計パターン | OK | 既存 `/api/worktrees/[id]/*` パターンに準拠 |
| データモデル | OK | 既存Worktree型への拡張、マイグレーション計画あり |
| UIパターン | OK | 既存タブ切り替えパターン（LeftPaneTabSwitcher）を踏襲 |
| 状態管理 | OK | ローカルstate + API fetch の既存パターン |
| api-client.ts | 要追加 | memoApi関数群の追加が必要（設計書に明記済み） |

### 技術スタック適合性

| 項目 | 評価 |
|------|------|
| Next.js 14 App Router | OK - 既存ルート構造に準拠 |
| TypeScript | OK - 型定義が明確 |
| SQLite (better-sqlite3) | OK - 既存DB操作パターンに準拠 |
| Tailwind CSS | OK - 既存コンポーネントスタイルに準拠 |

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | マイグレーション失敗時のデータ損失 | 中 | 低 | 中 |
| 技術的リスク | position UNIQUE制約の競合 | 低 | 低 | 低 |
| 運用リスク | 後方互換性の維持複雑化 | 中 | 中 | 中 |
| UXリスク | タブ数増加によるUI煩雑化 | 低 | 中 | 低 |

### リスク対策

1. **マイグレーション失敗対策**
   - トランザクション内で実行（設計書に記載済み）
   - バックアップ推奨をドキュメント化

2. **後方互換性**
   - 旧memo APIの内部変換が明記されている
   - 段階的廃止計画を追加推奨

---

## 6. 改善提案

### 必須改善項目（Must Fix）

#### 1. MobileTabBar タブ数上限の検討 - **対応済み**
**問題**: 現在のMobileTabBarは5タブ（Terminal, History, Files, Logs, Info）。Memoタブ追加で6タブになり、モバイルでのタップ領域が狭くなる。

**推奨対策**:
- Option A: Logs タブを削除（現在 "coming soon" 状態） **← 採用**
- Option B: Info と Memo を統合（Infoタブ内にメモセクション追加）
- Option C: タブの2行表示またはスクロール対応

**対応**: Option A を採用し、Logsタブを削除済み（2026-01-10）。
- `src/components/mobile/MobileTabBar.tsx` - Logsタブ削除
- `src/types/ui-state.ts` - MobileActivePaneから'logs'削除
- `src/components/worktree/WorktreeDetailRefactored.tsx` - logsケース削除
- `tests/unit/components/mobile/MobileTabBar.test.tsx` - テスト更新

#### 2. reorder API のposition更新ロジック明確化
**問題**: PATCH `/memos/reorder` の実装詳細が不明確。UNIQUE制約がある状態での並び替えは一時的な制約違反が発生する可能性。

**推奨対策**:
```sql
-- 一時的にposition を負値に設定してから再割り当て
UPDATE worktree_memos SET position = -1 - position WHERE worktree_id = ?;
-- その後、新しいpositionを割り当て
```

### 推奨改善項目（Should Fix）

#### 1. コンポーネント設計の簡素化
**問題**: `MemoCardList.tsx` は `MemoPane.tsx` 内で直接map処理すれば不要な可能性。

**推奨**: `MemoCardList` を削除し、MemoPane内で直接MemoCardをレンダリング。
```typescript
// MemoPane.tsx 内で十分
{memos.map(memo => <MemoCard key={memo.id} memo={memo} />)}
```

#### 2. オートセーブの詳細設計
**問題**: 「編集完了から1秒後」のトリガー条件が不明確。

**推奨**:
- onBlur イベント + 1秒debounce
- または、入力停止後300ms でdebounced save
- ネットワークエラー時のリトライ戦略

#### 3. 型定義のworktrees.memo廃止計画
**問題**: 旧memoフィールドがDEPRECATEDだが、削除タイミングが不明。

**推奨**: マイグレーションVersion 11 で旧カラム削除を計画。

### 検討事項（Consider）

#### 1. メモのテンプレート機能
将来的にユーザーがメモテンプレートを定義できると便利（「作業状況」「TODOリスト」「コマンドメモ」など）。現時点では不要だが、title フィールドの存在により将来対応可能。

#### 2. メモのエクスポート/インポート
worktree間でのメモコピー機能。複数ブランチで同じコマンドメモを使いたい場合など。

---

## 7. ベストプラクティスとの比較

### 業界標準との差異

| パターン | 本設計 | 業界標準 | 評価 |
|---------|--------|---------|------|
| データ正規化 | 別テーブル | 別テーブルまたはJSON | OK |
| REST API設計 | 標準CRUD | 標準CRUD | OK |
| 楽観的ロック | なし | 推奨 | 検討 |
| ソフトデリート | なし | ケースバイケース | OK（不要） |

### 代替アーキテクチャ案

#### 代替案: JSONカラム方式
設計書で却下されているが、再評価:

| 観点 | 別テーブル（採用） | JSONカラム |
|------|------------------|-----------|
| 部分更新 | 容易 | 困難 |
| バリデーション | SQL制約可能 | アプリ層のみ |
| クエリ性能 | インデックス可能 | 限定的 |
| スキーマ変更 | マイグレーション必要 | 柔軟 |

**結論**: 別テーブル方式の採用は適切。

---

## 8. 総合評価

### レビューサマリ

| 項目 | 評価 |
|------|------|
| **全体評価** | 4/5 |
| **強み** | 既存アーキテクチャとの一貫性、明確なデータモデル設計、段階的実装計画 |
| **弱み** | モバイルタブ数の考慮不足、一部実装詳細の曖昧さ |
| **総評** | 要件を満たす堅実な設計。モバイルUI考慮の修正で承認可能 |

### 承認判定

**承認（Approved）**

必須条件をクリアし、実装着手を推奨:

1. ~~**必須**: MobileTabBarのタブ数問題への対応方針決定~~ **対応済み（Logsタブ削除）**
2. **推奨**: reorder APIのposition更新ロジック詳細化（実装時に対応可）
3. **推奨**: MemoCardListコンポーネントの要否再検討（設計書で削除済み）

---

## 9. 次のステップ

1. **本レビュー結果の反映**
   - MobileTabBarのタブ構成決定
   - 設計書の微修正

2. **作業計画作成**
   - `/work-plan` コマンドで詳細タスク分解

3. **TDD実装開始**
   - Phase 1: データ層（DBマイグレーション、API）
   - Phase 2: UI実装（コンポーネント、タブ統合）
   - Phase 3: UX改善（オートセーブなど）

---

## 10. 参考情報

### 既存APIルート構造
```
src/app/api/worktrees/
├── route.ts                    # GET (list)
└── [id]/
    ├── route.ts                # GET, PATCH
    ├── messages/route.ts       # GET
    ├── logs/route.ts           # GET
    ├── logs/[filename]/route.ts
    ├── send/route.ts           # POST
    ├── kill-session/route.ts   # POST
    ├── tree/route.ts           # GET
    └── ... (その他)
```

### 新規APIルート（追加予定）
```
└── [id]/
    └── memos/
        ├── route.ts            # GET, POST
        ├── [memoId]/route.ts   # PUT, DELETE
        └── reorder/route.ts    # PATCH（検討中）
```

---

**レビュアー**: Claude Opus 4.5
**承認ステータス**: Conditionally Approved
