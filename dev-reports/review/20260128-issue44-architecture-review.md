# アーキテクチャレビュー: Issue #44 メモ機能の命名変更

**レビュー日**: 2026-01-28
**対象**: `dev-reports/design/issue-44-memo-rename-design-policy.md`
**レビュアー**: Claude (Architecture Review)

---

## 1. 設計原則の遵守確認

### SOLID原則チェック

- [x] **Single Responsibility**: 変更は「命名の統一」という単一目的に絞られている
- [x] **Open/Closed**: 作業支援用メモ側を一切変更しない設計で、拡張に対して開いている
- [x] **Liskov Substitution**: 該当なし（継承関係なし）
- [x] **Interface Segregation**: `Worktree` 型と `WorktreeMemo` 型が適切に分離されている
- [x] **Dependency Inversion**: DB層→型定義→UI層の依存方向が維持されている

### その他の原則

- [x] **KISS**: `ALTER TABLE RENAME COLUMN` 1文で済むシンプルなマイグレーション
- [x] **YAGNI**: 案Aで必要最小限の変更に留めている
- [x] **DRY**: 該当なし（命名変更のため重複は発生しない）

---

## 2. アーキテクチャ評価

### 構造的品質

| 評価項目 | スコア(1-5) | コメント |
|---------|------------|----------|
| モジュール性 | 4 | 変更対象と据え置き対象が明確に分離されている |
| 結合度 | 4 | DB→BL→API→UI の依存方向が一方向で健全 |
| 凝集度 | 3 | `WorktreeDetailRefactored.tsx` に複数のmemo関連責務が集中（後述） |
| 拡張性 | 4 | 将来の案B（作業支援用も改名）への道が閉じていない |
| 保守性 | 4 | 全レイヤー一括リネームで内部名とUI表示名が一致する |

### パフォーマンス観点

- 影響なし。カラム名変更のみでクエリ構造は変わらない
- `ALTER TABLE RENAME COLUMN` はメタデータ操作のみでデータコピー不要

---

## 3. セキュリティレビュー

### OWASP Top 10 チェック

- [x] **インジェクション対策**: Prepared statement使用が維持される（変更なし）
- [x] **機微データの露出対策**: `description` フィールドに機微データは含まれない
- [x] **XSS対策**: UIでのレンダリング方法は変更なし（React のエスケープが有効）

セキュリティ上の懸念なし。

---

## 4. 既存システムとの整合性

### API互換性

**注意**: PATCH `/api/worktrees/:id` のリクエストボディが `{ memo }` → `{ description }` に変わるため、**破壊的変更**となる。ただし、本プロジェクトはフロントエンドとバックエンドが同一デプロイのNext.jsアプリであるため、外部クライアントの互換性問題はない。

### データモデル整合性

マイグレーション順序 v2→v10→v13 の整合性は確認済み。問題なし。

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的 | React `memo` とフィールド `memo` の混同による誤置換 | 高 | 中 | **必須** |
| 技術的 | `WorktreeDetailRefactored.tsx` の変更漏れ | 中 | 中 | **必須** |
| 技術的 | SQLite バージョンが 3.25.0 未満 | 低 | 低 | 低 |
| 運用 | 既存DBのマイグレーション失敗 | 高 | 低 | 中 |

---

## 6. 改善提案

### 必須改善項目（Must Fix）

#### MF-1: `WorktreeDetailRefactored.tsx` の変更スコープが過少

設計方針書では「props/変数名変更」とだけ記載されているが、実際には以下の3箇所で独立したブランチ管理用メモの編集UIが存在する:

| コンポーネント | 行 | 内容 |
|--------------|-----|------|
| `DesktopHeader` | 141, 151-165 | props `memo` → `description`、変数 `worktreeMemo`/`truncatedMemo` |
| `InfoModal` | 291-420 | state `isEditingMemo`/`memoText`、`handleSaveMemo`/`handleCancelMemo`、UIラベル "Memo"×3、"No memo added yet" |
| `MobileInfoContent` | 533-664 | `InfoModal` とほぼ同一の編集UI（state/handler/ラベル全て） |

**対策**: 変更一覧に各コンポーネントの変更箇所を個別に列挙すること。特に `InfoModal` と `MobileInfoContent` が漏れている。

#### MF-2: React `memo` 関数との名前衝突に注意

`WorktreeDetailRefactored.tsx:19` で `import { ..., memo, ... } from 'react'` している。一括置換で `memo` → `description` を実行すると、React の `memo` まで破壊される。

**対策**: 変更時は機械的な一括置換を避け、文脈に応じた個別置換を行うこと。設計方針書にこの注意事項を追記すべき。

### 推奨改善項目（Should Fix）

#### SF-1: `WorktreeDetail.tsx` のタブID `'memo'`

`WorktreeDetail.tsx:28` で `type TabView = 'claude' | 'logs' | 'info' | 'memo'` と定義されている。この `'memo'` タブは作業支援用メモ（MemoPane）のタブではなく、ブランチ管理用メモ（旧memo）の編集タブとして使われている。

`'memo'` → `'description'` に変更するか、少なくともコメントで区別を明記すべき。

#### SF-2: テスト変更範囲の補完

以下のテストファイルも影響を受ける可能性がある:

| ファイル | 理由 |
|---------|------|
| `tests/unit/components/worktree/WorktreeCard.test.tsx`（存在する場合） | `memo` プロパティのテスト |
| `tests/unit/components/sidebar/BranchListItem.test.tsx`（存在する場合） | `branch.memo` 参照 |

テストファイルの網羅性を確認し、漏れがあれば追加すること。

#### SF-3: `db.ts` の export 一覧

`db.ts` は `updateWorktreeMemo` を export している。この関数を import しているファイルが `route.ts` 以外にもないか確認すること。

### 検討事項（Consider）

#### C-1: `WorktreeDetailRefactored.tsx` の `InfoModal` と `MobileInfoContent` の重複

両コンポーネントのブランチ管理用メモ編集UIはほぼ同一のコード（state/handler/JSX）を持つ。今回の命名変更では2箇所を同じように修正する必要がある。将来的にはメモ編集UIを共通コンポーネントに切り出すことで保守性が向上するが、本Issueのスコープ外とする。

---

## 7. ベストプラクティスとの比較

### マイグレーション戦略

`ALTER TABLE RENAME COLUMN` の採用は適切。SQLite 3.25.0+（2018年9月リリース）で対応しており、Node.js の better-sqlite3 が使用するSQLiteバージョン（3.40+）で問題なし。

テーブル再作成方式と比較して:
- メリット: データコピー不要、高速、安全
- デメリット: なし（このケースでは最適解）

### 既存マイグレーション不変の原則

v2/v10 を変更しない方針は正しい。マイグレーション履歴は不可変であるべき。

---

## 8. 総合評価

### レビューサマリ

- **全体評価**: 4/5
- **強み**:
  - 案Aの選定理由が明確で合理的
  - 変更対象と据え置き対象の境界が明確
  - DBマイグレーション戦略がシンプルかつ安全
  - トレードオフの整理が丁寧
- **弱み**:
  - `WorktreeDetailRefactored.tsx` の変更スコープが過少（MF-1）
  - React `memo` との名前衝突リスクが未記載（MF-2）

### 承認判定

- [x] **条件付き承認（Conditionally Approved）**

以下の条件を満たした上で実装に着手すること:

1. **MF-1**: `WorktreeDetailRefactored.tsx` の `InfoModal`/`MobileInfoContent` の変更箇所を設計方針書とIssueに追記
2. **MF-2**: React `memo` 関数との混同注意を設計方針書の要注意ポイントに追記
3. **SF-1**: `WorktreeDetail.tsx` のタブID `'memo'` の扱いを決定

### 次のステップ

1. 上記 MF-1, MF-2 を設計方針書に反映
2. SF-2 のテストファイル網羅性を確認
3. 実装着手（TDDで進行推奨）
