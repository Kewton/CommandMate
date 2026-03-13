# Issue #480 Stage 3: 影響分析レビュー

## 概要

| 項目 | 値 |
|------|-----|
| Issue | #480 |
| レビュー種別 | Stage 3 - 影響分析レビュー |
| 対象文書 | `dev-reports/design/issue-480-console-log-logger-unification-design-policy.md` |
| レビュー日 | 2026-03-13 |
| 総合評価 | **fair** (条件付き承認) |
| Must Fix | 2件 |
| Should Fix | 5件 |
| Nice to Have | 3件 |

## エグゼクティブサマリー

設計方針書は Stage 1/2 のレビュー指摘を反映し、スコープ・件数が実測値に近い水準まで改善されている。しかし影響分析の観点からは、テスト影響一覧の正確性に重大な問題がある。具体的には、存在しないテストファイル6件が一覧に含まれ、逆にconsole spyを使用する実在ファイル5件が漏れている。また、段階的移行中の退行防止策、ログ形式変更の運用影響、独立PR化のマージ戦略について追記が必要である。

---

## 詳細所見

### Must Fix (2件)

#### DS3-001: 影響テスト一覧に存在しないテストファイルが6件含まれている

**深刻度**: Must Fix
**カテゴリ**: テスト影響の網羅性

設計方針書の DS2-007 で追記された13ファイルの「完全一覧」のうち、以下の6ファイルは実際には存在しないか、console spy を使用していない。

| 設計方針書記載のファイル | 実態 |
|------------------------|------|
| `tests/unit/lib/resource-cleanup.test.ts` | ファイル不在 |
| `tests/unit/lib/assistant-response-saver.test.ts` | ファイル不在 |
| `tests/unit/lib/session-cleanup.test.ts` | ファイル不在 |
| `tests/unit/lib/cli-tools/codex.test.ts` | ファイル不在 |
| `tests/unit/lib/cli-tools/gemini.test.ts` | ファイル不在 |
| `tests/unit/lib/ws-server.test.ts` | `ws-server-terminal.test.ts`は存在するがconsole spy なし |

**対応**: テスト一覧を実在するファイルのみに修正する。該当ソースファイル（resource-cleanup.ts, codex.ts 等）にconsole出力が含まれるがテストが存在しない場合は、logger移行後のテスト新規作成が必要であることを明記する。

#### DS3-002: console spy を使用している5つのテストファイルが影響一覧から漏れている

**深刻度**: Must Fix
**カテゴリ**: テスト影響の網羅性

以下のテストファイルは `vi.spyOn(console, ...)` を使用しているが、設計方針書の影響テスト一覧に記載されていない。

| テストファイル | spy対象 | 件数 |
|--------------|---------|------|
| `tests/unit/lib/tmux-capture-cache.test.ts` | console.debug | 1箇所 |
| `tests/unit/lib/cmate-parser.test.ts` | console.warn | 5箇所 |
| `tests/integration/security.test.ts` | console.warn | 1箇所 |
| `tests/integration/auth-middleware.test.ts` | console.warn | 3箇所 |
| `tests/unit/prompt-detector-cache.test.ts` | console.log, warn, error | 3箇所 |

**対応**: 影響テスト一覧にこの5ファイルを追加する。特に `cmate-parser.test.ts` の5箇所は対応漏れのリスクが高い。

---

### Should Fix (5件)

#### DS3-003: logger.ts 依存チェーンの間接影響明記不足

**カテゴリ**: 他モジュールへの依存影響

`logger.ts` -> `env.ts` -> `db-path-resolver.ts` -> `cli/utils/install-context.ts` という Node.js 専用の依存チェーンが存在する。新たに logger を import する約30ファイルがこの依存チェーンに組み込まれる点が明記されていない。Edge Runtime を使用する `middleware.ts` で logger が誤って import された場合にランタイムエラーとなるリスクがある。

**対応**: ESLint `no-restricted-imports` ルールで、Edge Runtime / クライアント環境からの logger import を禁止する設定の導入を検討する。

#### DS3-004: バンドル依存グラフ拡大の影響評価が未実施

**カテゴリ**: ビルド成果物への影響

現在 logger を import しているのは18ファイルだが、移行後は約50ファイルとなる。API ルート38ファイル全てに `logger.ts` -> `env.ts` -> `db-path-resolver.ts` の依存が追加される点について、コールドスタート時間への影響を事前に計測すべき。

**対応**: Phase 1 完了時点で `npm run build` を実行し、ビルド出力のチャンクサイズ変化を記録する。

#### DS3-005: 移行期間中の退行防止策が未定義

**カテゴリ**: フェーズ並行リスク

段階的移行中、Phase 1 完了後も Phase 2/3 対象ファイルには console.log が残る。この期間中に新規開発で console.log が追加されると、移行完了判定の品質保証コマンド結果が不正確になる。

**対応**: Phase 完了時に ESLint `no-console` ルールを段階的に有効化する。

| Phase完了 | ESLint設定追加 |
|-----------|--------------|
| Phase 1 | `src/lib/` に no-console: error（logger.ts, env.ts 除外） |
| Phase 2 | `src/app/api/` に no-console: error |
| Phase 3 | `src/components/`, `src/hooks/` に no-console: error（console.error 除外） |

#### DS3-006: ログ出力形式変更の運用影響が未評価

**カテゴリ**: リリース時の影響

`console.log('Running migration:', name)` から `[2026-03-13T...] [INFO] [db-migrations] migration:start {"name":"xxx"}` への変更は破壊的変更である。ログを tail/grep で監視しているユーザーの既存フィルタパターンが壊れる可能性がある。

**対応**: 設計方針書に「ログ形式変更による運用影響」セクションを追加し、CHANGELOG に破壊的変更として記載する方針を明記する。

#### DS3-007: db-migrations.ts 独立PR化のマージ戦略が未定義

**カテゴリ**: db-migrations.ts 独立PR

独立PRのベースブランチ、残りの Phase 1 ファイルとの依存関係、マージ順序の制約が未定義。

**推奨PR分割戦略**:

```
PR-A: tests/helpers/logger-mock.ts 作成 (基盤PR、最初にマージ)
  |
  +-- PR-B: db-migrations.ts 移行 (PR-Aに依存)
  |
  +-- PR-C: Phase 1 残りファイル (PR-Aに依存)
```

PR-B と PR-C は並行レビュー可能。

---

### Nice to Have (3件)

#### DS3-008: src/lib/ の件数微差

設計方針書の約220件に対し実測約223件。実装着手時に再確認すれば十分。

#### DS3-009: console.debug spy への対応方針未記載

`tmux-capture-cache.test.ts` が `console.debug` を spy しているが、logger 内部では `console.log` を使用している。テスト修正時の混乱を避けるため、「console.debug spy は logger.debug モックに置換する」旨を追記するとよい。

#### DS3-010: LOG_LEVEL=info でのログ出力量減少に関する注意書き

本番デフォルトの `LOG_LEVEL=info` では、従来 `console.log` で出力されていた debug レベルのログが出力されなくなる。リリースノートに設定方法の案内を記載するとよい。

---

## リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| テスト不備 | 影響テスト一覧の不正確さによりテスト修正漏れが発生 | High | High | P1 |
| 依存拡大 | logger依存チェーンのEdge Runtime誤使用 | Med | Low | P2 |
| 移行退行 | 移行期間中のconsole.log再追加 | Med | Med | P2 |
| 運用影響 | ログ形式変更による監視フィルタ破壊 | Med | Med | P2 |
| マージ競合 | 独立PR間のファイル競合 | Low | Med | P3 |
| ビルド影響 | コールドスタート時間増加 | Low | Low | P3 |

---

## 承認ステータス

**条件付き承認 (conditionally_approved)**

Must Fix 2件（DS3-001, DS3-002）のテスト影響一覧の修正が完了すれば実装に着手可能。Should Fix 項目は実装フェーズで順次対応しても問題ない。
