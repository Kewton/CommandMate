# Issue #135 影響分析レビュー (Stage 3)

**レビュー日**: 2026-02-03
**対象Issue**: #135 DBパス解決ロジック修正
**設計書**: dev-reports/design/issue-135-db-path-resolution-design-policy.md
**レビュー種別**: 影響分析レビュー (Stage 3)

---

## 1. レビュー概要

Issue #135の設計方針書に対する影響分析レビューを実施した。設計書Section 11（影響範囲）を中心に、実際のコードベースとの整合性を検証し、以下の観点でレビューを行った:

1. 直接的影響の完全性
2. 間接的影響の分析
3. 後方互換性
4. テスト影響
5. ドキュメント影響
6. リスク評価

---

## 2. 実施した調査

### 2.1 getDbInstance()の呼び出し箇所調査

```bash
grep -r "getDbInstance" --include="*.ts" | wc -l
```

**結果**: 75ファイルがヒット（dev-reports含む）

**主な影響ファイル**:
- `src/app/api/` 配下: 30+ APIルートファイル
- `src/lib/`: response-poller.ts, claude-poller.ts
- `tests/integration/`: 20+ テストファイル
- `server.ts`: サーバーエントリポイント

### 2.2 DATABASE_PATH/CM_DB_PATH参照箇所調査

```bash
grep -r "DATABASE_PATH\|CM_DB_PATH" --include="*.ts" --include="*.sh" --include="*.md"
```

**結果**:
- `src/lib/db-instance.ts:25`: `process.env.DATABASE_PATH` 直接参照（修正対象）
- `src/lib/env.ts:169-170`: CM_DB_PATH/DATABASE_PATHフォールバック
- `scripts/health-check.sh:44`: DATABASE_PATHのみ参照
- `scripts/status.sh:58-59`: DATABASE_PATHのみ参照
- `.env.example:36`: CM_DB_PATH=./data/db.sqlite（ファイル名旧式）

### 2.3 isGlobalInstall()の使用箇所調査

```bash
grep -r "isGlobalInstall" --include="*.ts"
```

**結果**: src/cli/utils/env-setup.ts に既存実装あり。設計書で再利用を明記しており、DRY原則に準拠。

---

## 3. 指摘事項

### 3.1 必須修正 (must_fix): 2件

#### IMPACT-001: server.tsの修正対象リスト漏れ

**深刻度**: High

**問題**: 設計書Section 11.1の修正対象ファイルに`server.ts`が含まれていない。

**証拠**:
```typescript
// server.ts:3
import { getDbInstance } from './src/lib/db-instance';
```

**影響**: server.tsはgetDbInstance()を直接importしており、DBパス解決ロジックの変更による影響を受ける。インターフェース変更はないため動作への影響は軽微だが、修正対象として認識されていないと動作検証が漏れる可能性がある。

**推奨対応**: Section 11.1にserver.tsを追加し、「インターフェース変更なし、動作検証のみ必要」と明記。

---

#### IMPACT-002: シェルスクリプトの具体的修正内容不足

**深刻度**: High

**問題**: scripts/health-check.shとscripts/status.shが設計書に記載されているが、具体的な修正内容が不明。

**現在の実装**:
```bash
# health-check.sh:44
DB_PATH="${DATABASE_PATH:-./data/db.sqlite}"

# status.sh:58-59
if [ -f "${DATABASE_PATH:-./data/db.sqlite}" ]; then
  DB_PATH="${DATABASE_PATH:-./data/db.sqlite}"
```

**問題点**:
1. CM_DB_PATHへのフォールバックがない
2. デフォルトファイル名がdb.sqlite（旧式）のまま

**推奨修正**:
```bash
# 修正後
DB_PATH="${CM_DB_PATH:-${DATABASE_PATH:-./data/cm.db}}"
```

---

### 3.2 推奨修正 (should_fix): 4件

#### IMPACT-003: 間接的影響のファイル数不正確

**問題**: 設計書では「約34ファイル、74箇所」と記載されているが、実際には75ファイルがヒット。

**推奨対応**: 正確な数値に更新し、以下の分類で記載:
- src/app/api/: 30+ ファイル
- src/lib/: 5 ファイル
- tests/integration/: 20+ ファイル
- その他: server.ts等

#### IMPACT-004: テスト影響の詳細不足

**問題**: 統合テスト20+件がgetDbInstance()をモックしているが、具体的な対応方法が不明。

**影響を受けるテストファイル例**:
```
tests/integration/api-file-operations.test.ts
tests/integration/api-repository-delete.test.ts
tests/integration/api-messages.test.ts
tests/integration/api-hooks.test.ts
tests/integration/security.test.ts
... (計20+ファイル)
```

**推奨対応**: Section 12.2に影響テストファイルリストと対応方法を追記。

#### IMPACT-005: .env.exampleの不整合

**問題**: .env.example:36にはCM_DB_PATH=./data/db.sqliteと記載されているが、Issue #77以降の標準ファイル名はcm.db。

**推奨対応**: Phase 4で.env.exampleの更新を明記し、以下に修正:
```bash
# CM_DB_PATH=~/.commandmate/data/cm.db  # グローバルインストール時のデフォルト
# CM_DB_PATH=./data/cm.db               # ローカルインストール時のデフォルト
```

#### IMPACT-006: docs/architecture.mdの旧環境変数参照

**問題**: docs/architecture.mdにMCBD_*環境変数が多数残存。

**推奨対応**: Issue番号を明記した別Issue（例: #77 Phase 4）として対応を計画。

---

### 3.3 改善提案 (nice_to_have): 3件

| ID | 内容 |
|----|------|
| IMPACT-007 | マイグレーション検出パターンにnpm prefix -gベースの検出を将来的に検討 |
| IMPACT-008 | 影響を受けるドキュメントファイルの完全なリストを追記 |
| IMPACT-009 | ロールバック戦略のセクションを追加 |

---

## 4. 影響サマリー

### 4.1 直接的影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/db-instance.ts` | getEnv()経由のパス解決に変更 |
| `src/lib/env.ts` | DATABASE_PATH廃止警告、デフォルトパス解決ロジック追加 |
| `src/cli/utils/env-setup.ts` | getDefaultDbPath()関数追加、ENV_DEFAULTSからCM_DB_PATH削除 |
| `src/cli/commands/init.ts` | getDefaultDbPath()使用 |
| `scripts/health-check.sh` | CM_DB_PATHフォールバック対応 |
| `scripts/status.sh` | CM_DB_PATHフォールバック対応 |
| `server.ts` | **追加**: 動作検証必要 |

### 4.2 新規作成ファイル

| ファイル | 目的 |
|---------|------|
| `src/lib/db-path-resolver.ts` | DBパス解決ロジック（オプション、関数ベース実装推奨） |
| `src/lib/db-migration-path.ts` | DBマイグレーションロジック |

### 4.3 間接的影響

| 対象 | 影響 |
|------|------|
| 30+ APIルートファイル | インターフェース変更なし、動作検証必要 |
| 20+ 統合テストファイル | モック更新不要、環境変数設定の見直し |
| 7+ ドキュメントファイル | DATABASE_PATH廃止、CM_DB_PATH説明更新 |

### 4.4 後方互換性

| 項目 | 対応 |
|------|------|
| DATABASE_PATH | フォールバックサポート付きで廃止。Deprecation警告出力、v2.0で完全削除予定 |
| db.sqliteファイル名 | cm.dbへの自動マイグレーション |
| 相対パス指定 | path.resolve()で絶対パスに変換 |

---

## 5. リスク評価

**リスクレベル**: Medium

**リスク要因**:
1. DBパス解決ロジックの変更は全APIルートに影響するため、リグレッションリスクがある
2. マイグレーション処理の失敗時にデータ損失の可能性（バックアップで軽減）
3. シェルスクリプトの更新漏れによるヘルスチェック/ステータス表示の不整合

**軽減策**:
- 包括的なユニットテストと統合テストの実施
- マイグレーション時の自動バックアップ
- 段階的なロールアウト（まずローカル環境でテスト）

---

## 6. 判定

**判定**: PROCEED_WITH_MINOR_CHANGES

**理由**:
設計書の影響分析は概ね適切だが、以下の修正が必要:
1. server.tsを修正対象リストに追加 (IMPACT-001)
2. シェルスクリプトの具体的な修正内容を明記 (IMPACT-002)

上記2点の修正後、実装フェーズに進むことを推奨する。

---

## 7. 次のアクション

1. **必須**: IMPACT-001, IMPACT-002の設計書修正
2. **推奨**: IMPACT-003〜006の設計書改善
3. **実装**: Phase 1（基盤修正）から着手

---

*Generated by architecture-review-agent (Stage 3: Impact Analysis Review)*
