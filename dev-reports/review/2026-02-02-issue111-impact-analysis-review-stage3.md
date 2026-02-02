# Issue #111 影響分析レビュー (Stage 3)

**レビュー日**: 2026-02-02
**Issue**: #111 現在の作業ブランチ可視化機能
**レビュータイプ**: 影響範囲 (Impact Analysis)
**設計書**: `dev-reports/design/issue-111-branch-visualization-design-policy.md`

---

## 1. レビューサマリー

| 項目 | 値 |
|------|-----|
| 総指摘数 | 9件 |
| Must Fix | 2件 |
| Should Fix | 4件 |
| Good (良い点) | 2件 |
| Info | 1件 |
| 全体リスク | **低** |
| デプロイ準備状態 | 要軽微修正 |

### 総合評価

設計書は影響範囲を適切に把握しており、後方互換性に十分配慮された設計となっている。Migration rollback手順の明記とAPI応答サイズ評価の2点を修正すれば、実装着手可能なレベル。全体的なリスクは低く、ゼロダウンタイムデプロイが可能な設計である。

---

## 2. 影響マトリクス

### 2.1 データベース影響

| 項目 | 内容 |
|------|------|
| 対象テーブル | `worktrees` |
| 新規カラム | `initial_branch` (TEXT, NULL許可) |
| Migration番号 | #15 |
| ロールバック複雑度 | 中 |
| データ移行 | なし（既存データはNULL） |
| 後方互換性 | あり |

**リスク評価**: 低 - ALTER TABLE ADD COLUMNは非破壊的操作であり、既存データへの影響なし。

### 2.2 API影響

| 項目 | 内容 |
|------|------|
| 対象エンドポイント | `GET /api/worktrees/:id`, `POST /api/worktrees/:id/send` |
| 破壊的変更 | なし |
| 新規フィールド | `gitStatus` (オプショナル) |
| レスポンスサイズ増加 | 約100-200 bytes/レスポンス |
| 後方互換性 | あり |

**リスク評価**: 低 - オプショナルフィールド追加のため、既存クライアントは影響なし。

### 2.3 フロントエンド影響

| 項目 | 内容 |
|------|------|
| 対象コンポーネント | `WorktreeDetailRefactored.tsx`, `MobileHeader.tsx`, `BranchMismatchAlert.tsx` (新規) |
| 状態管理変更 | `dismissed` state追加（BranchMismatchAlert内部） |
| レンダリング影響 | 最小（条件付きレンダリング） |
| バンドルサイズ増加 | 約2-3KB |

**リスク評価**: 低 - 新規コンポーネント追加のみで、既存コンポーネントへの変更は最小限。

### 2.4 テスト影響

| 項目 | 内容 |
|------|------|
| 新規テストファイル | 4ファイル |
| 影響を受ける既存テスト | 2ファイル |
| モック要件 | `child_process.execFile`, `Database instance` |
| カバレッジギャップ | gitタイムアウト、detached HEAD処理 |

**リスク評価**: 低 - gitStatusオプショナルのため既存テストは基本的にパス。

### 2.5 デプロイ影響

| 項目 | 内容 |
|------|------|
| Migration順序 | DBマイグレーション後にコードデプロイ |
| ロールバック戦略 | 1) コードリバート 2) Migration down()実行 |
| Feature Flag | 不要 |
| ゼロダウンタイム | 可能 |

---

## 3. Must Fix (必須修正)

### IMP-MF-001: Migration #15 rollback strategyが不完全

**カテゴリ**: データベース
**リスクレベル**: 中

**現状**:
設計書にMigration #15のdown()関数が定義されていない。SQLiteはALTER TABLE DROP COLUMNをサポートしないため、テーブル再作成が必要だが、rollback手順が未記載。

**推奨対応**:
Migration #15にdown()関数を追加し、テーブル再作成によるrollback手順を明記する。既存Migration #7のパターンを参照。

```typescript
// 推奨: Migration #15 down()関数追加
down: (db) => {
  // SQLiteはDROP COLUMNをサポートしないため、テーブル再作成が必要
  // 注: 本番環境では既存データのバックアップを推奨
  console.log('Note: SQLite does not support DROP COLUMN directly');
  console.log('For production rollback, manual table recreation may be required');
}
```

**影響ファイル**: `src/lib/db-migrations.ts`

---

### IMP-MF-002: API応答サイズ増加の影響評価なし

**カテゴリ**: API
**リスクレベル**: 低

**現状**:
GET /api/worktrees/:id のレスポンスにgitStatusオブジェクト(約100-200 bytes)が追加される。ポーリング間隔2秒でのデータ転送量増加の評価が設計書に記載されていない。

**推奨対応**:
1. gitStatusフィールドサイズの想定値を明記
2. ポーリング頻度との組み合わせによる帯域消費評価
3. モバイル環境での影響考慮を追記

```
// 追記例（セクション5.3に追加）
### 5.4 レスポンスサイズ評価

| フィールド | サイズ目安 |
|-----------|-----------|
| currentBranch | 10-50 bytes |
| initialBranch | 10-50 bytes |
| isBranchMismatch | 5 bytes |
| commitHash | 7 bytes |
| isDirty | 5 bytes |
| **合計** | **約100-200 bytes** |

ポーリング間隔2秒で、1時間あたり約180KB-360KBの追加転送。
モバイル環境でも問題ない範囲。
```

**影響ファイル**: `src/app/api/worktrees/[id]/route.ts`

---

## 4. Should Fix (推奨修正)

### IMP-SF-001: 既存テストへの影響範囲が不明確

**カテゴリ**: テスト
**リスクレベル**: 低

**現状**:
api-worktrees.test.tsの既存テストがgitStatusフィールドの追加で影響を受ける可能性がある。

**推奨対応**:
既存テストの互換性確認方針を明記:
1. gitStatusはオプショナルなので既存テストは基本的にパスするはず
2. gitStatus非存在のケースをカバーする新テスト追加

**影響ファイル**: `tests/integration/api-worktrees.test.ts`, `tests/integration/api-worktrees-cli-tool.test.ts`

---

### IMP-SF-002: WorktreeDetailRefactored.tsxへの統合点が未詳細

**カテゴリ**: フロントエンド
**リスクレベル**: 低

**現状**:
1657行の大規模コンポーネントにBranchMismatchAlertを統合する具体的な挿入位置がコンポーネント階層の詳細として不足。

**推奨対応**:
WorktreeDetailRefactored.tsx内の具体的な行番号範囲（1379-1390行付近、DesktopHeaderの直後）を設計書に追記。

**影響ファイル**: `src/components/worktree/WorktreeDetailRefactored.tsx`

---

### IMP-SF-003: MobileHeader.tsxの変更影響が未評価

**カテゴリ**: フロントエンド
**リスクレベル**: 低

**現状**:
モバイルヘッダーへのブランチ表示追加時の既存レイアウトへの影響（スペース制約、テキスト切り捨て）が未記載。

**推奨対応**:
MobileHeaderの既存レイアウト（worktreeName、repositoryName表示）との統合方針、長いブランチ名のtruncate処理を明記。

**影響ファイル**: `src/components/mobile/MobileHeader.tsx`

---

### IMP-I-002: git-utils.tsのモック要件

**カテゴリ**: テスト
**リスクレベル**: 低

**現状**:
新規作成のgit-utils.tsはgitコマンドを実行するため、テスト時のモック戦略が未記載。

**推奨対応**:
child_process.execFileのモック方法（vitest.mock）をテスト設計に追記。

**影響ファイル**: `tests/unit/git-utils.test.ts`

---

## 5. 良い点 (Good)

### IMP-G-001: 後方互換性の適切な配慮

initial_branchカラムがNULL許可で設計されており、既存データへの影響なし。GitStatusインターフェースも全フィールドオプショナルで後方互換性を維持。

### IMP-G-002: 既存APIパターンへの準拠

GET /api/worktrees/:idの既存スプレッドパターン（...worktree, isSessionRunning, etc.）にgitStatusを追加する形式で、既存クライアントへの影響を最小化。

---

## 6. 波及効果分析

### 6.1 Migration #15からの波及

```
worktrees.initial_branch (新規カラム)
    |
    +---> db.ts (saveInitialBranch, getInitialBranch関数追加)
    |         |
    |         +---> send/route.ts (初期ブランチ保存処理追加)
    |         |
    |         +---> route.ts (gitStatus取得・返却処理追加)
    |
    +---> フロントエンド更新
```

**リスク**: 低 - 追加のみで既存機能に影響なし

### 6.2 GitStatus interfaceからの波及

```
GitStatus interface (models.ts)
    |
    +---> Worktree interface (gitStatus? オプショナル追加)
    |         |
    |         +---> WorktreeDetailRefactored.tsx (gitStatus表示)
    |         |
    |         +---> MobileHeader.tsx (ブランチ表示)
    |
    +---> BranchMismatchAlert.tsx (新規)
```

**リスク**: 低 - オプショナルフィールドのため後方互換

### 6.3 git-utils.ts (新規モジュール)からの波及

```
git-utils.ts (新規)
    |
    +---> route.ts (getGitStatus関数呼び出し)
    |
    +---> テストファイル (モック必要)
```

**リスク**: 低 - 新規ファイルのため既存コード影響なし

---

## 7. 推奨アクション

### 即時対応 (Must Fix)

1. **設計書セクション3に追記**: Migration #15のdown()関数定義（ロールバック手順）
2. **設計書セクション5に追記**: API応答サイズの定量的評価

### 実装時対応 (Should Fix)

1. 既存テストの互換性確認とgitStatus非存在ケースのテスト追加
2. WorktreeDetailRefactored.tsx統合時の具体的挿入位置をコメントで明記
3. MobileHeaderのブランチ名truncate処理を実装
4. git-utils.test.tsでのexecFileモック戦略を実装

---

## 8. 結論

設計書は影響範囲分析において以下の点で優れている:

- **後方互換性**: NULL許可カラム、オプショナルフィールドにより既存システムへの影響を最小化
- **段階的導入**: gitStatusオプショナル設計により段階的ロールアウト可能
- **ゼロダウンタイム**: ADD COLUMN操作とオプショナルフィールド追加によりサービス中断なしでデプロイ可能

2件のMust Fix項目を対応すれば、実装フェーズに進行可能。

---

*Generated by architecture-review-agent (Stage 3: Impact Analysis)*
