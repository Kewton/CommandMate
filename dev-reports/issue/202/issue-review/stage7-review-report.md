# Issue #202 レビューレポート（Stage 7）

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目
**ステージ**: 7/8（影響範囲レビュー 2回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 1 |

### 前回指摘（Stage 3）の対応状況

| 指摘ID | カテゴリ | 状態 |
|--------|---------|------|
| S3-MF-1 | tsconfig.server.json include 更新漏れ | 対応済み |
| S3-SF-1 | build:server 受け入れ条件追加 | 対応済み |
| S3-SF-2 | 間接依存の影響範囲記載 | 対応済み |
| S3-NTH-1 | 結合テストの言及追加 | 対応済み |
| S3-NTH-2 | CLAUDE.md server.ts 記載検討 | 対応済み |

**全5件が対応済み**。Stage 3 で検出された Must Fix 1件、Should Fix 2件、Nice to Have 2件のすべてが Issue 本文に適切に反映されている。

---

## 前回指摘の検証詳細

### S3-MF-1: tsconfig.server.json の include 配列更新（対応済み）

**元の指摘**: tsconfig.server.json の include 配列に `src/lib/db-repository.ts` と `src/config/system-directories.ts` が含まれていない。

**検証結果**: 修正方針に手順6として追加されている。以下が正確に記載されていることを確認した:
- `src/lib/db-repository.ts` -- server.ts から直接 import する対象
- `src/config/system-directories.ts` -- db-repository.ts の間接依存
- `src/types/clone.ts` は `src/types/**/*.ts` として既に含まれているため追加不要（正確な補足）

影響範囲テーブルにも tsconfig.server.json が含まれ、受け入れ条件にも「tsconfig.server.json の include 配列に src/lib/db-repository.ts と src/config/system-directories.ts が追加されていること」が記載されている。

**実ファイル確認**: `tsconfig.server.json` L8-24 の include 配列にこれらのファイルが含まれていないことを確認し、Issue 記載と一致する。

### S3-SF-1: build:server 成功確認の受け入れ条件追加（対応済み）

**元の指摘**: `npm run build:server` の成功確認が受け入れ条件に含まれていない。

**検証結果**: 以下の3箇所に反映されている:
1. 受け入れ条件: 「npm run build:server が成功すること」
2. 受け入れ条件: 「既存のテスト（単体テスト・結合テスト）がパスし、build:server を含む全ビルドが成功すること」
3. テスト方針: 「ビルド確認: npm run build:server を含む全ビルド（npm run build:all）が成功すること」

`package.json` の `build:all` が `npm run build && npm run build:cli && npm run build:server` であることと整合している。

### S3-SF-2: 間接依存テーブルの追加（対応済み）

**元の指摘**: db-repository.ts の間接依存（system-directories.ts, clone.ts）が影響範囲セクションに未記載。

**検証結果**: 「間接依存（変更なし）」サブセクションが新設され、以下のテーブルが追加されている:

| ファイル | 依存関係 | tsconfig.server.json での状態 |
|---------|---------|------------------------------|
| src/lib/db-repository.ts | server.ts から直接 import | 追加が必要 |
| src/config/system-directories.ts | db-repository.ts が isSystemDirectory を import | 追加が必要 |
| src/types/clone.ts | db-repository.ts が CloneJobStatus 型を import | 追加不要（既に含まれている） |

実際の `db-repository.ts` の import 文（L10: `@/types/clone`, L11: `@/config/system-directories`）と一致することを確認した。また、`system-directories.ts` は外部 import がなく自己完結的なモジュールであるため、追加の transitive dependency は存在しないことも確認した。

### S3-NTH-1: 結合テスト言及の追加（対応済み）

**元の指摘**: テスト方針に結合テスト（repository-exclusion.test.ts）の言及がない。

**検証結果**: テスト方針に「既存テスト（結合）: tests/integration/repository-exclusion.test.ts の Exclusion -> Sync フロー等の結合テストが引き続きパスすること」が追加されている。ファイルの存在も確認した。

### S3-NTH-2: CLAUDE.md server.ts 記載の検討（対応済み）

**元の指摘**: CLAUDE.md の主要機能モジュールテーブルに server.ts の記載がない。

**検証結果**: 備考セクションにスコープ外として将来的な検討事項として追記されている。スコープの切り分けが適切。

---

## 新規指摘事項

### Nice to Have

#### NTH-1: 手動テスト手順の明示化

**カテゴリ**: テスト範囲
**場所**: テスト方針セクション

**問題**:
受け入れ条件に「サーバー再起動後、削除済みリポジトリが復活しないこと（手動テスト）」と記載されているが、具体的な手動テスト手順（どのリポジトリを削除するか、DB内の enabled フラグの確認方法など）はテスト方針セクションでは明示されていない。

**証拠**:
再現手順セクションに「1. トップ画面でリポジトリを削除、2. npm run build && npm start、3. トップ画面に削除済みリポジトリが再表示される」と記載されており、これを逆転させれば手動テスト手順となる。そのため実質的に手順は記載されていると見なせる。

**推奨対応**:
対応は任意。再現手順が手動テストの手順と実質同等であるため、現状でも実装者が迷うリスクは低い。QA担当者向けに詳細な手順が必要な場合は、別途テスト計画書での対応を検討する。

---

## 影響範囲の検証結果

### 直接変更対象ファイル

| ファイル | 変更内容 | 検証状態 |
|---------|---------|---------|
| `server.ts` | initializeWorktrees() にフィルタリング追加、import文追加、ログ出力追加 | 検証済み: L69-100 に変更対象を確認 |
| `tsconfig.server.json` | include 配列に 2ファイル追加 | 検証済み: L8-24 に追加対象の欠如を確認 |

### 間接依存ファイル（変更なし）

| ファイル | 依存関係 | tsconfig.server.json | 検証状態 |
|---------|---------|---------------------|---------|
| `src/lib/db-repository.ts` | server.ts から直接 import | 追加が必要 | 検証済み: L7-11, L369-408 |
| `src/config/system-directories.ts` | db-repository.ts の依存 | 追加が必要 | 検証済み: 外部importなし |
| `src/types/clone.ts` | db-repository.ts の型依存 | 既に含まれている | 検証済み: L23 src/types/**/*.ts |

### 影響を受けないファイル

| ファイル | 理由 |
|---------|------|
| `src/app/api/repositories/sync/route.ts` | 参考実装。変更不要 |
| `src/app/api/repositories/scan/route.ts` | 除外ロジックは呼び出し元で制御 |
| `src/app/api/repositories/route.ts` | DELETE ハンドラー。スコープ外 |
| `src/app/api/repositories/restore/route.ts` | リストア API。スコープ外 |
| `src/cli/commands/start.ts` | npm run start を spawn するだけ |
| `src/lib/worktrees.ts` | 関数インターフェース変更なし |
| `src/lib/db-instance.ts` | 既に server.ts で import 済み |

### 破壊的変更

なし。内部的な初期化処理の修正であり、外部APIやUIの変更はない。

### 移行考慮

なし。既存ユーザーへの影響はない。サーバー再起動時の動作が改善される。

---

## 全体評価

**品質**: 高
**実装準備**: 完了

Stage 3 影響範囲レビューの全5件の指摘がすべて反映され、新規の Must Fix / Should Fix は検出されなかった。影響範囲の整理は以下の点で十分な品質を達成している:

1. **直接変更対象**: 2ファイル（server.ts, tsconfig.server.json）が明確で、変更内容が具体的
2. **間接依存**: 3ファイルがテーブル形式で整理され、tsconfig.server.json での対応状況が明記
3. **影響なし**: 7ファイルが理由付きで列挙され、変更不要であることが確認可能
4. **破壊的変更**: なし（内部処理の修正のみ）
5. **テスト範囲**: 単体テスト、結合テスト、手動テスト、ビルド確認の4層で網羅

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/server.ts` (L29-42, L69-100): 修正対象 initializeWorktrees() 関数
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tsconfig.server.json` (L8-24): 修正対象 include 配列
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/app/api/repositories/sync/route.ts` (L10, L27-30): 参考実装
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/lib/db-repository.ts` (L7-11, L369-408): 使用する関数と依存関係
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/config/system-directories.ts`: db-repository.ts の間接依存
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tests/unit/lib/db-repository-exclusion.test.ts`: 既存単体テスト
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tests/integration/repository-exclusion.test.ts`: 既存結合テスト

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/CLAUDE.md`: プロジェクト構成参照
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/package.json` (L23-24): build:server / build:all コマンド定義
