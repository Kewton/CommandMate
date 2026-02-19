# Architecture Review Report: Issue #304 Stage 2 (整合性レビュー)

**Date**: 2026-02-20
**Issue**: #304 - テスト環境NODE_ENV分離
**Stage**: 2 - 整合性レビュー
**Focus**: 設計方針書と実際のコードベースの整合性
**Status**: conditionally_approved

---

## Executive Summary

Issue #304 の設計方針書に対して、実際のコードベースとの整合性レビュー（Stage 2）を実施した。全体として設計の方向性は正しく、対策1（NODE_ENV=test プレフィックス）と対策2（beforeEach での環境変数 delete）は矛盾なく独立して機能する。しかし、**db-migration-path.test.ts および worktree-path-validator.test.ts に対する修正方針で、ソースコードが参照していない環境変数の delete を指示している点が must_fix** として検出された。これは YAGNI 原則との矛盾であり、設計根拠の補足または修正方針の変更が必要である。

| 重要度 | 件数 |
|--------|------|
| must_fix | 1 |
| should_fix | 4 |
| nice_to_have | 3 |
| **合計** | **8** |

---

## Detailed Findings

### DR2-001 [must_fix] db-migration-path.test.ts の不要な環境変数 delete

**問題**: 設計書 Section 4.4 は `db-migration-path.test.ts` の `beforeEach` に `CM_DB_PATH` / `MCBD_DB_PATH` / `CM_ROOT_DIR` / `MCBD_ROOT_DIR` の delete 追加を指示している。しかし、`db-migration-path.ts` のソースコードを確認したところ、`getLegacyDbPaths()` 関数は `process.env.DATABASE_PATH` のみを参照しており、`CM_DB_PATH` / `MCBD_DB_PATH` / `CM_ROOT_DIR` / `MCBD_ROOT_DIR` への参照は一切存在しない。

**根拠（ソースコード）**:

```typescript
// src/lib/db-migration-path.ts L86
const envDbPath = process.env.DATABASE_PATH;
```

ファイル全体で `CM_DB_PATH`、`MCBD_DB_PATH`、`CM_ROOT_DIR`、`MCBD_ROOT_DIR` のいずれも参照していない。テストファイルも `env.ts` をインポートしていないため、間接的な影響もない。

**根拠（設計書）**:

> 設計書 Section 4.4: "CM_DB_PATH や MCBD_DB_PATH も追加で削除する"
> "delete process.env.CM_DB_PATH; delete process.env.MCBD_DB_PATH; delete process.env.CM_ROOT_DIR; delete process.env.MCBD_ROOT_DIR;"

**推奨対応**: 以下のいずれかを選択する:

A. 修正方針を変更し、`db-migration-path.test.ts` では `DATABASE_PATH` の delete のみとする（現状維持で十分）
B. 防御的措置として残す場合、設計書に「ソースコードが将来これらの変数を参照する可能性に備えた防御的設計」である旨と、YAGNI 原則との優先順位判断の根拠を明記する

---

### DR2-003 [should_fix] スコープ外ファイルのパス誤記

**問題**: 設計書 Section 1 のスコープ外テーブルにおいて、`api-logger.test.ts` のファイルパスが `tests/unit/lib/api-logger.test.ts` と記載されているが、実際のファイルは `tests/unit/api-logger.test.ts` に存在する（`lib/` サブディレクトリ配下ではない）。

**根拠**:

- 設計書記載: `tests/unit/lib/api-logger.test.ts`
- 実際のパス: `/Users/maenokota/share/work/github_kewton/commandmate-issue-304/tests/unit/api-logger.test.ts`
- `tests/unit/lib/api-logger.test.ts` は存在しない

**推奨対応**: 設計書のファイルパスを `tests/unit/api-logger.test.ts` に修正する。

---

### DR2-004 [should_fix] describe ブロック列挙順のコードとの不一致

**問題**: 設計書 Section 4.2 の対象 describe ブロック列挙順が、`env.test.ts` のコード上の出現順と異なる。内容的には正しい（7ブロックの名前は全て一致）が、実装時の照合で混乱が生じる可能性がある。

**設計書の列挙順**:
1. `getEnvWithFallback`
2. `getEnvByKey`
3. `resetWarnedKeys`
4. `getEnv with fallback`
5. `getLogConfig with fallback`
6. `getDatabasePathWithDeprecationWarning`
7. `getEnv with DB path resolution (Issue #135)`

**実コードの出現順**:
1. `getEnvWithFallback` (L18)
2. `getEnvByKey` (L98)
3. `resetWarnedKeys` (L124)
4. `getEnv with fallback` (L150)
5. `getLogConfig with fallback` (L189)
6. `ENV_MAPPING` (L226) -- 除外対象、正しい
7. `getDatabasePathWithDeprecationWarning` (L252)
8. `getEnv with DB path resolution (Issue #135)` (L317)

**推奨対応**: 設計書の列挙順をコード上の出現順に合わせる（6番目と7番目の順序を実コードに揃える）。

---

### DR2-007 [should_fix] worktree-path-validator.test.ts の不要な環境変数 delete

**問題**: DR2-001 と同様の問題。設計書 Section 4.3 は `worktree-path-validator.test.ts` の `beforeEach` に `CM_ROOT_DIR` / `MCBD_ROOT_DIR` の delete を指示しているが、`worktree-path-validator.ts` は `ALLOWED_WORKTREE_PATHS` のみを参照しており、`CM_ROOT_DIR` / `MCBD_ROOT_DIR` は参照していない。

**根拠（ソースコード）**:

```typescript
// src/lib/worktree-path-validator.ts L47
const envPaths = process.env.ALLOWED_WORKTREE_PATHS;
```

ファイル全体で `CM_ROOT_DIR` / `MCBD_ROOT_DIR` への参照はない。

**推奨対応**: DR2-001 と同様、防御的措置の根拠を明記するか、修正対象から除外する。ただし、DR2-001 とは異なり severity は should_fix とする。理由は、worktree-path-validator.test.ts は env.test.ts ほど多くの変数を操作しておらず、2変数の追加 delete による影響は限定的であるため。

---

### DR2-002 [should_fix] CM_LOG_DIR の .env 汚染リスクに関する補足不足

**問題**: `ENV_VARS_TO_CLEAN` に `CM_LOG_DIR` と `MCBD_LOG_DIR` が含まれているが、`.env` ファイルおよび `.env.example` のいずれにも `CM_LOG_DIR` は設定されていない。ENV_MAPPING に定義されているためリストへの包含自体は正当だが、実際の汚染リスクが低いことの補記がない。

**根拠**:

- `.env` ファイル: `CM_LOG_DIR` の記載なし（CM_ROOT_DIR, CM_PORT, CM_BIND, CM_DB_PATH, CM_LOG_LEVEL, CM_LOG_FORMAT のみ）
- `.env.example` ファイル: `CM_LOG_DIR` の記載なし
- `ENV_MAPPING` (src/lib/env.ts L31): `CM_LOG_DIR: 'MCBD_LOG_DIR'` が定義されている

**推奨対応**: 設計書の `ENV_VARS_TO_CLEAN` コメント内に、CM_LOG_DIR は現在の .env テンプレートには含まれないが ENV_MAPPING に定義されているため防御的に含める旨を追記する。

---

### DR2-005 [nice_to_have] 対策1と対策2の独立性の明示

**問題**: 対策1（NODE_ENV=test）と対策2（beforeEach での delete）は異なる問題を解決する独立した対策であり矛盾はないが、この独立性が設計書内で明示的に記述されていない。

**推奨対応**: Section 3 または Section 8 に「対策1は NODE_ENV 汚染を防止し、対策2は .env 由来の CM_*/MCBD_*/DATABASE_PATH 汚染を防止する。両者は独立した対策であり、片方のみの適用でも各問題は解決される」旨を追記する。

---

### DR2-006 [nice_to_have] 受入条件の対策2検証範囲の不足

**問題**: 受入条件（Section 7）で対策2の検証は `env.test.ts` のみを明示しているが、対策2は `worktree-path-validator.test.ts` と `db-migration-path.test.ts` にも適用される。これらは `npm run test:unit` でカバーされるが、個別検証コマンドとして明示されていない。

**推奨対応**: 受入条件セクションに3ファイル全ての個別検証コマンドを追記するか、注記を追加する。

---

### DR2-008 [nice_to_have] package.json テストスクリプト数の整合確認

**問題なし**: 設計書の「全6テストスクリプト」という記載と、`package.json` の実際のスクリプト定義（test, test:ui, test:coverage, test:unit, test:integration, test:watch）は完全に一致することを確認した。`test:e2e` の除外判断も正しい。

---

## Consistency Matrix

| 設計項目 | 設計書の記載 | 実装状況（現コード） | 差異 |
|---------|------------|-------------------|------|
| env.test.ts describe ブロック数 | process.envを操作する7つ | 全8ブロック中7つが該当（ENV_MAPPING除外は正しい） | 列挙順の不一致のみ (DR2-004) |
| worktree-path-validator.test.ts 修正方針 | CM_ROOT_DIR/MCBD_ROOT_DIR delete | ソースは ALLOWED_WORKTREE_PATHS のみ参照 | 不要な delete 指示 (DR2-007) |
| db-migration-path.test.ts 修正方針 | DATABASE_PATH + CM_DB_PATH + MCBD_DB_PATH + CM_ROOT_DIR + MCBD_ROOT_DIR delete | ソースは DATABASE_PATH のみ参照 | 不要な delete 指示 (DR2-001) |
| package.json 変更対象スクリプト | 6スクリプト | 6スクリプト存在 | 一致 |
| ENV_VARS_TO_CLEAN 変数リスト | 15変数（CM_*7 + MCBD_*7 + DATABASE_PATH） | ENV_MAPPING は7キー、DATABASE_PATH は env.ts で参照 | 一致（CM_LOG_DIR の補足推奨: DR2-002） |
| スコープ外ファイル一覧 | 3ファイル列挙 | 各ファイルの process.env 操作を確認、判断は妥当 | パス誤記1件 (DR2-003) |
| 対策1と対策2の整合性 | 独立した対策 | 矛盾なし | 独立性の明示推奨 (DR2-005) |
| CI ワークフローのカバー | npm script 経由で自動カバー | ci-pr.yml は npm run test:unit を実行 | 一致 |

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|--------|---------|-----------|
| 技術的リスク | 不要な環境変数 delete が YAGNI 違反となり、将来のメンテナー混乱 | Low | Medium | P2 |
| 設計品質リスク | ファイルパス誤記による実装時の混乱 | Low | High | P2 |
| 運用リスク | なし | - | - | - |
| セキュリティリスク | なし（テスト環境設定のみの変更） | - | - | - |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. **DR2-001**: `db-migration-path.test.ts` の修正方針において、ソースコードが参照していない `CM_DB_PATH` / `MCBD_DB_PATH` / `CM_ROOT_DIR` / `MCBD_ROOT_DIR` の delete 指示について、防御的設計の根拠を明記するか、`DATABASE_PATH` のみの delete に修正する。

### 推奨改善項目 (Should Fix)

2. **DR2-003**: スコープ外ファイルのパスを `tests/unit/api-logger.test.ts` に修正する。
3. **DR2-004**: describe ブロック列挙順を実コード出現順に合わせる。
4. **DR2-007**: `worktree-path-validator.test.ts` の修正方針について、DR2-001 と同様の対応を行う。
5. **DR2-002**: `CM_LOG_DIR` の `.env` 未定義に関する補足をコメントに追記する。

### 検討事項 (Consider)

6. **DR2-005**: 対策1と対策2の独立性を設計書に明記する。
7. **DR2-006**: 受入条件の対策2検証コマンドに3ファイル全てを含める。

---

## Approval Status

**Status**: conditionally_approved

設計の方向性は正しく、対策1と対策2の整合性にも問題はない。must_fix 1件（DR2-001: 不要な環境変数 delete の根拠明記または修正）を対応した上で、実装に進むことを推奨する。should_fix 4件は設計書の品質向上に寄与するが、実装のブロッカーではない。

**Score**: 4/5

---

*Generated by architecture-review-agent for Issue #304 Stage 2*
*Review date: 2026-02-20*
