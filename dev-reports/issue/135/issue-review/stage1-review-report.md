# Issue #135 レビューレポート

**レビュー日**: 2026-02-03
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #135はグローバルインストール時のDBデータ消失バグを詳細に分析しており、技術的な根本原因の特定は正確である。コードスニペットと行番号も実際のコードと一致している。ただし、受け入れ条件の明示、DATABASE_PATH環境変数の扱い、マイグレーションロジックの優先度について補足が必要。

---

## Must Fix（必須対応）

### M1: コードスニペット行番号の検証結果

**カテゴリ**: 正確性

**問題**:
Issue内のコードスニペット行番号を検証した結果、全て正確であることを確認した。

**検証結果**:
- `src/lib/db-instance.ts:25` - 正確（process.cwd()とdb.sqliteを使用）
- `src/lib/env.ts:169-171` - 正確（CM_DB_PATHの解決ロジック）
- `server.ts:72` - 正確（getDbInstance()呼び出し）
- `start.ts:93` - 正確（dotenvConfig呼び出し）

**結論**: この指摘項目は取り下げ。Issueの記載は正確である。

---

### M2: ファイル名不一致の指摘は正確

**カテゴリ**: 整合性

**問題**:
Issueでは「ファイル名が cm.db（db-instance.ts は db.sqlite）で不一致」と指摘しているが、これは正確な指摘である。

**証拠**:
```typescript
// src/lib/db-instance.ts:25
const dbPath = process.env.DATABASE_PATH ||
    path.join(process.cwd(), 'data', 'db.sqlite');  // <-- db.sqlite

// src/lib/env.ts:171
const databasePath = getEnvByKey('CM_DB_PATH')
    || process.env.DATABASE_PATH
    || path.join(process.cwd(), 'data', 'cm.db');  // <-- cm.db
```

**結論**: 修正方針の「ファイル名の統一: cm.db に統一」は適切。

---

## Should Fix（推奨対応）

### S1: マイグレーションロジックの優先度

**カテゴリ**: 完全性

**問題**:
修正方針の「マイグレーションロジック追加」が推奨修正とされているが、既存ユーザーのデータ救済のためには必須修正として扱うべきではないか。

**推奨対応**:
- マイグレーションロジックの優先度を再検討
- 既存ユーザーのデータ救済手順を明記
- マイグレーション不可能な場合はその旨を明記

---

### S2: ローカルインストール時のパス表記の矛盾

**カテゴリ**: 明確性

**問題**:
修正方針に「ローカルインストール: ./.commandmate/data/cm.db（絶対パス）」と記載されているが、`./.commandmate/`は相対パス表記であり、「（絶対パス）」との注記と矛盾している。

**推奨対応**:
```
ローカルインストール: <cwd>/.commandmate/data/cm.db（絶対パスに解決）
```
のように修正し、矛盾を解消する。

---

### S3: 受け入れ条件の欠如

**カテゴリ**: 技術的妥当性

**問題**:
バグ修正Issueであっても、具体的な受け入れ条件が明示されていない。

**推奨対応**:
以下のような受け入れ条件を追加:
1. v0.1.10からv0.1.11へアップグレード後、リポジトリ情報が保持される
2. グローバルインストールで任意のディレクトリから `commandmate start` を実行しても同じDBを参照する
3. 単体テストでDBパス解決ロジックを検証する

---

### S4: DATABASE_PATH環境変数の扱い

**カテゴリ**: 完全性

**問題**:
`src/lib/db-instance.ts`と`src/lib/env.ts`の両方でDATABASE_PATH環境変数を参照しているが、これがCM_DB_PATHと重複しており、どちらを優先するか不明確。

**証拠**:
```typescript
// src/lib/db-instance.ts:25
const dbPath = process.env.DATABASE_PATH || ...

// src/lib/env.ts:170
const databasePath = getEnvByKey('CM_DB_PATH')
    || process.env.DATABASE_PATH
    || ...
```

**推奨対応**:
- DATABASE_PATH環境変数の扱い（廃止するか、CM_DB_PATHへのエイリアスとするか）を明記
- Issue #76のフォールバック機構との整合性を確認

---

## Nice to Have（あれば良い）

### N1: 関連Issueへのリンク

**カテゴリ**: 完全性

**問題**:
関連Issueへのリンクがない。

**推奨対応**:
以下の関連Issueへのリンクを追加:
- #96: npm CLIサポート（関連機能）
- #119: 対話形式init（関連機能）
- #125: グローバルインストール.env読み込み（関連バグ修正）

---

### N2: テスト計画

**カテゴリ**: 完全性

**問題**:
テスト計画が記載されていない。

**推奨対応**:
以下のテスト計画を追加:
1. **ユニットテスト**: `getDbInstance()`のパス解決ロジック
2. **統合テスト**: グローバルインストールシミュレーション
3. **E2Eテスト**: バージョンアップシナリオ

---

### N3: CLAUDE.mdへのドキュメント追加

**カテゴリ**: 整合性

**問題**:
CLAUDE.mdには`src/lib/db-instance.ts`の説明がない。

**推奨対応**:
CLAUDE.mdの「主要機能モジュール」セクションに`src/lib/db-instance.ts`の説明を追加:

```markdown
| `src/lib/db-instance.ts` | DBインスタンスシングルトン管理 |
```

---

## 参照ファイル

### コード

| ファイル | 行番号 | 関連性 | 検証済み |
|---------|--------|--------|---------|
| `src/lib/db-instance.ts` | 25 | DBパス解決ロジック | Yes |
| `src/lib/env.ts` | 169-171 | CM_DB_PATH環境変数の解決 | Yes |
| `src/cli/utils/env-setup.ts` | 31 | ENV_DEFAULTSの定義 | Yes |
| `server.ts` | 72 | getDbInstance()呼び出し | Yes |
| `src/cli/commands/start.ts` | 93 | dotenvConfig()呼び出し | Yes |
| `src/cli/commands/init.ts` | - | createDefaultConfig() | Yes |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | Issue #96, #119, #125の実装詳細 |

---

## 総評

Issue #135は、グローバルインストール時のDBデータ消失という重大なバグを正確に分析している。根本原因（process.cwd()依存、ファイル名不一致、相対パス使用）の特定は適切であり、修正方針も妥当である。

主な改善点:
1. 受け入れ条件を追加して検証可能にする
2. DATABASE_PATH環境変数の扱いを明確にする
3. 関連Issue（#96, #119, #125）へのリンクを追加する

これらの軽微な修正を行えば、実装可能な良質なIssueである。
