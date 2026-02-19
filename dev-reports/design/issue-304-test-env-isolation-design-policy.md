# Issue #304 設計方針書: テスト環境NODE_ENV分離

## 1. 概要

### 目的
テスト実行時に `NODE_ENV` が明示的に設定されず、シェル環境の `NODE_ENV=production` が残留する場合にReactの production build が使用されてテストが失敗する問題を修正する。併せて、`.env` ファイルの環境変数がテスト内のモック値を上書きする問題を解消する。

### スコープ
- `package.json` の全テストスクリプトへの `NODE_ENV=test` 追加
- `env.test.ts` およびパターンAテストファイルの環境変数分離処理追加
- ソースコードの変更なし（テスト環境設定のみ）

### スコープ外
- `test:e2e`（Playwright / ブラウザ環境テスト）
- `vitest.config.ts` の `envPrefix` 設定（フォローアップ Issue で検討）
- パターンB/Cのテストファイル修正（現時点で影響なし）

#### スコープ外ファイルの判断根拠 [DR1-004]

以下のテストファイルも `process.env` を操作しているが、本修正のスコープ外とする。各ファイルの判断根拠を以下に記す。

| ファイル | process.env操作対象 | スコープ外の理由 |
|---------|-------------------|----------------|
| `tests/unit/components/app-version-display.test.tsx` | `NEXT_PUBLIC_APP_VERSION` のみ | `.env` 由来の `CM_*` / `MCBD_*` 変数を操作しない。`NEXT_PUBLIC_APP_VERSION` はビルド時にインライン化される変数であり、`.env` ファイルの `CM_*` 変数による汚染の影響を受けない。 |
| `tests/unit/lib/version-checker.test.ts` | 特定の環境変数のみ（バージョンチェック関連） | `CM_*` / `MCBD_*` 変数を操作せず、`.env` ファイルの環境変数残留による影響がない。 |
| `tests/unit/api-logger.test.ts` | `NODE_ENV` のみ | 対策1（package.json の `NODE_ENV=test` プレフィックス）により `NODE_ENV` は自動的に正しく設定されるため、追加の修正は不要。**[DR3-015]** 対策1の適用により、L41 の `const originalEnv = process.env.NODE_ENV` には常に `'test'` が格納されるようになる。これにより afterEach（L48）の `setNodeEnv(originalEnv ?? 'test')` における `?? 'test'` フォールバックは実質的に不要となるが、`setNodeEnv('test')` と等価であるため既存のテスト動作に変化はない。 |

これらのファイルは `CM_*` / `MCBD_*` / `DATABASE_PATH` 変数の `.env` 残留問題の影響を受けないため、本 Issue のスコープ外とする。将来的にこれらの変数を操作する必要が生じた場合は、個別に対応する。

---

## 2. アーキテクチャ設計

### 変更対象レイヤー

本修正はインフラストラクチャ層（テスト実行環境設定）のみに限定される。

```
[変更対象]
├── package.json               <- テストスクリプト定義（NODE_ENV=test追加）
├── tests/unit/env.test.ts     <- 環境変数分離処理追加
├── tests/unit/lib/worktree-path-validator.test.ts  <- 環境変数分離処理追加
└── tests/unit/db-migration-path.test.ts            <- 環境変数分離処理追加

[変更なし]
├── src/           <- ソースコードは一切変更しない
├── vitest.config.ts  <- 現時点では変更しない
└── .github/workflows/ci-pr.yml  <- npm script経由のため自動カバー（下記補足参照）
```

#### CI ワークフローのカバーメカニズム [DR1-005]

`.github/workflows/ci-pr.yml` の `test-unit` ジョブでは `NODE_ENV` が明示的に設定されていないが、以下の理由により本修正で自動的にカバーされる。

- CI ジョブは `npm run test:unit` を実行する
- `package.json` のスクリプト定義が `NODE_ENV=test vitest run tests/unit` に変更される
- Unix シェルでは `NODE_ENV=test vitest ...` の形式でコマンド直前に変数を設定すると、その変数は子プロセス（vitest）の環境変数として渡される
- この動作は CI 環境で `NODE_ENV` が未設定の場合だけでなく、**別の値（例: `NODE_ENV=production`）が設定されている場合でも**、npm script のプレフィックスが子プロセスの `NODE_ENV` を `test` に上書きする
- したがって、CI ワークフローの YAML 修正は不要であり、将来的な CI 設定変更にも耐性がある

### 設計原則

| 原則 | 適用 |
|------|------|
| KISS | package.jsonスクリプトへの `NODE_ENV=test` プレフィックス追加のみ |
| DRY | 環境変数削除ロジックはヘルパー関数化しない（対象3ファイルのみ、抽象化は過剰）[DR1-001 補足参照] |
| YAGNI | vitest.config.tsのenvPrefix設定は今回見送り（現時点で問題なし） |

---

## 3. 技術選定

### 対策1: NODE_ENV設定方式

**採用: package.jsonスクリプトプレフィックス方式**

| 方式 | メリット | デメリット | 判定 |
|------|---------|-----------|------|
| `NODE_ENV=test` in package.json | 明示的、既存パターン統一（`start`と同様） | スクリプト追加時に設定漏れリスク | **採用** |
| `test.env` in vitest.config.ts | 一元的、漏れにくい | vitestの仕様依存、他ツール非対応 | 不採用 |
| `.env.test` ファイル | テスト環境を明示管理 | 二重管理、同期コスト | 不採用 |

**選定理由**: プロジェクト内で `"start": "NODE_ENV=production node dist/server/server.js"` が既に使用されており、環境変数プレフィックスパターンが統一される。

### 対策2: 環境変数分離方式

**採用: beforeEachでの明示的delete**

テストファイル内で `beforeEach` で対象の環境変数を `delete` し、`afterEach` で `process.env` を復元する。

**不採用の代替案**:
- グローバル `tests/setup.ts` での一括削除 -> テストファイルの依存関係が暗黙的になり可読性低下
- ヘルパー関数化 -> 対象3ファイルのみで抽象化は過剰（YAGNI）

---

## 4. 設計パターン

### 4.1 対策1: package.jsonスクリプト変更

全6テストスクリプトに `NODE_ENV=test` プレフィックスを追加する。

```json
{
  "test": "NODE_ENV=test vitest",
  "test:ui": "NODE_ENV=test vitest --ui",
  "test:coverage": "NODE_ENV=test vitest --coverage",
  "test:unit": "NODE_ENV=test vitest run tests/unit",
  "test:integration": "NODE_ENV=test vitest run tests/integration",
  "test:watch": "NODE_ENV=test vitest --watch"
}
```

**変更しないスクリプト**:
- `test:e2e`: Playwright（ブラウザ環境）のためスコープ外

### 4.2 対策2: env.test.tsの環境変数分離

#### 現状の問題パターン

```typescript
// モジュールスコープで参照を保存（.env値が含まれる）
const originalEnv = process.env;

beforeEach(() => {
  // スプレッドコピーしても.env値が残る
  process.env = { ...originalEnv };
});
```

#### 修正パターン

process.envを操作する7つのdescribeブロック [DR1-002] の `beforeEach` で `.env` 由来の環境変数を明示的に `delete` する。

**対象describeブロック一覧** [DR1-002] [DR2-004]（実コードの出現順に列挙）:
1. `getEnvWithFallback`
2. `getEnvByKey`
3. `resetWarnedKeys`
4. `getEnv with fallback` -- **[DR3-006]** このブロックのテスト（L164-173 'should work without warning when new names are used'）では `CM_ROOT_DIR` / `CM_PORT` / `CM_BIND` のみを設定し、`CM_DB_PATH` は設定していない。`getEnv()` 内部では `CM_DB_PATH` -> `DATABASE_PATH` -> `getDefaultDbPath()` のフォールバックチェーン（env.ts L205-207）が走るため、`CM_DB_PATH` が delete されていない場合は `.env` 由来の値が残留する。`ENV_VARS_TO_CLEAN` に `CM_DB_PATH` が含まれているため、設計通り実装すれば問題は解消されるが、このテストは `CM_DB_PATH` 未設定時に `getDefaultDbPath()` へフォールバックすることを暗黙に依存している点に留意すること。
5. `getLogConfig with fallback`
6. `getDatabasePathWithDeprecationWarning`（実コードでは `ENV_MAPPING` の後に位置する）
7. `getEnv with DB path resolution (Issue #135)`

**除外**: `ENV_MAPPING` ブロック（実コード上6番目のdescribeブロック）は `process.env` を操作せず、ENV_MAPPINGオブジェクトの構造検証のみを行うため、環境変数deleteの追加は不要。

**対象変数（ENV_MAPPINGの全7キー + レガシー変数）**:

```typescript
// .env由来のCM_*変数
const ENV_VARS_TO_CLEAN = [
  'CM_ROOT_DIR',
  'CM_PORT',
  'CM_BIND',
  'CM_DB_PATH',
  'CM_LOG_LEVEL',
  'CM_LOG_FORMAT',
  'CM_LOG_DIR',
  // レガシーMCBD_*変数（テスト対象コードがMCBD_*フォールバックを実装しているため、
  // 外部環境やCI設定変更からの混入に備えた防御的設計として含める）
  'MCBD_ROOT_DIR',
  'MCBD_PORT',
  'MCBD_BIND',
  'MCBD_DB_PATH',
  'MCBD_LOG_LEVEL',
  'MCBD_LOG_FORMAT',
  'MCBD_LOG_DIR',
  // その他
  'DATABASE_PATH',
];
```

**env.test.tsの修正方針**: process.envを操作する7つのdescribeブロック（上記一覧参照）の `beforeEach` で上記変数をdeleteする。`afterEach` の `process.env = originalEnv` は参照復元のため変更不要。

#### 実装時の検討: ファイルローカルヘルパー関数 [DR1-006]

env.test.ts 内で15変数のdeleteを7箇所に複製する場合、ファイルローカルのヘルパー関数（例: `cleanEnvVars()`）を定義して各 `beforeEach` から呼び出す方式を実装時に検討する。これはファイル内の重複排除であり、外部モジュールへの抽象化とは異なるため YAGNI に反しない。

```typescript
// 実装時の検討例（ファイルローカル、exportしない）
function cleanEnvVars(): void {
  for (const key of ENV_VARS_TO_CLEAN) {
    delete process.env[key];
  }
}
```

採否は実装時の可読性・保守性を考慮して判断する。

### 4.3 対策2適用: worktree-path-validator.test.ts [DR2-007]

**修正方針**: `beforeEach` に環境変数のdelete追加。

**ソースコード依存分析**: `worktree-path-validator.ts` の `getAlllowedBasePaths()` は `process.env.ALLOWED_WORKTREE_PATHS` のみを参照している（L47）。`CM_ROOT_DIR` / `MCBD_ROOT_DIR` への直接参照はソースコード内に存在しない。

したがって、delete対象は `ALLOWED_WORKTREE_PATHS` のみとする。`CM_ROOT_DIR` / `MCBD_ROOT_DIR` の delete は、ソースコードが参照していないため YAGNI 原則に基づき不要である。なお、現在のテストでは各テストケース内で `ALLOWED_WORKTREE_PATHS` を明示設定しているため、既存の動作に問題は確認されていないが、`.env` ファイルに `ALLOWED_WORKTREE_PATHS` が設定された場合の汚染防止として `beforeEach` での delete を追加する。

```typescript
beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
  // .env由来の変数をクリア（ソースコードが参照する変数のみ）
  delete process.env.ALLOWED_WORKTREE_PATHS;
});
```

### 4.4 対策2適用: db-migration-path.test.ts [DR2-001]

**ソースコード依存分析**: `db-migration-path.ts` の `getLegacyDbPaths()` は `process.env.DATABASE_PATH` のみを参照している（L86）。`CM_DB_PATH` / `MCBD_DB_PATH` / `CM_ROOT_DIR` / `MCBD_ROOT_DIR` への直接参照はソースコード内に存在しない。また、`db-migration-path.test.ts` は `env.ts` をインポートしておらず、間接的な参照もない。

**修正方針**: `getLegacyDbPaths` の `beforeEach` はすでに `delete process.env.DATABASE_PATH` を行っており、ソースコードの実際の依存に対しては現状維持で十分である。`CM_DB_PATH` / `MCBD_DB_PATH` / `CM_ROOT_DIR` / `MCBD_ROOT_DIR` の追加 delete は、ソースコードが参照していないため YAGNI 原則に基づき不要とする。

```typescript
beforeEach(() => {
  process.env = { ...originalEnv };
  // ソースコードが参照する変数のみ delete（getLegacyDbPaths は DATABASE_PATH のみ参照）
  delete process.env.DATABASE_PATH;
});
```

**注記**: 将来的に `db-migration-path.ts` が `CM_DB_PATH` 等を参照するよう変更された場合は、その時点でテストの `beforeEach` にも対応する delete を追加する。

---

## 5. セキュリティ設計

本修正はテスト環境設定のみであり、セキュリティへの影響はない。

- ソースコードの変更なし
- 本番環境への影響なし
- `NODE_ENV=test` はReactの開発モードを使用（`act()` が有効）

---

## 6. パフォーマンス設計

テスト実行パフォーマンスへの影響なし。

- `NODE_ENV=test` の設定はプロセス起動時に1回のみ
- `beforeEach` のdelete操作は O(1)

---

## 7. テスト戦略

### テスト不要（テスト環境自体の修正）

本修正はテスト環境の設定変更であるため、新規テストの追加は不要。修正後の検証は受入条件で確認する。

### 受入条件の検証方法

```bash
# 対策1の検証: NODE_ENV=productionが設定されたシェルでテスト実行
NODE_ENV=production npm run test:unit
NODE_ENV=production npm run test:integration

# 対策2の検証: 対象3ファイルの全テストがパス [DR2-006]
npm run test:unit -- tests/unit/env.test.ts
npm run test:unit -- tests/unit/lib/worktree-path-validator.test.ts
npm run test:unit -- tests/unit/db-migration-path.test.ts

# 既存テストの回帰確認
npm run test:unit
npm run test:integration
```

---

## 8. 設計上の決定事項とトレードオフ

### 対策1と対策2の独立性 [DR2-005]

対策1（`NODE_ENV=test` プレフィックス）と対策2（`beforeEach` での環境変数 delete）は、異なる問題を解決する**独立した対策**である。

- **対策1** は `NODE_ENV` が未設定またはシェル環境の値（例: `production`）が残留する問題を解決する。
- **対策2** は `.env` ファイル由来の `CM_*` / `MCBD_*` / `DATABASE_PATH` 変数がテスト内のモック値を上書きする問題を解決する。

両対策は互いに依存関係を持たず、どちらか一方のみの適用でも各問題は個別に解決される。本 Issue では両方の問題が確認されているため、両対策を同時に適用する。

### 採用した設計

| 決定事項 | 理由 | トレードオフ |
|---------|------|-------------|
| package.jsonプレフィックス方式 | 既存パターン(`start`)との統一、明示性 | スクリプト追加時の設定漏れリスク |
| 各ファイル個別のdelete | 依存関係が明示的、変更範囲が限定 | 対象ファイル増加時のスケーラビリティ |
| envPrefix設定見送り | YAGNI、現時点で他ファイルの問題なし | 潜在的.env汚染リスクは残る |
| ヘルパー関数なし | 対象3ファイルのみで過剰な抽象化 | ファイル間のdelete対象変数リストの重複 |

#### DRY に関するトレードオフ補足 [DR1-001]

`ENV_VARS_TO_CLEAN` リストが `env.test.ts`、`worktree-path-validator.test.ts`、`db-migration-path.test.ts` の3ファイルに分散して重複定義される。定数を `tests/helpers/env-test-constants.ts` 等に一元定義してインポートする方式も考えられるが、以下の理由から現行の個別定義を採用する。

- **各ファイルで必要な変数セットが異なる**: `env.test.ts` は全15変数、`worktree-path-validator.test.ts` は1変数（`ALLOWED_WORKTREE_PATHS`）、`db-migration-path.test.ts` は1変数（`DATABASE_PATH`、既存の delete で対応済み）。共通定数として抽出するには「全変数セット」か「ファイル別サブセット」かの設計判断が必要となり、単純なデータ共有以上の複雑さが生じる。[DR2-001][DR2-007]
- **対象ファイルが3つに限定**: 同期漏れリスクは存在するが、影響範囲が限定的であり管理可能。
- **将来的な変数追加時の同期漏れリスク**: `CM_*` 変数の追加は `ENV_MAPPING` の変更を伴い、`env.test.ts` のテスト修正が必然的に発生するため、同期漏れの実質的リスクは低い。

ただし、将来的に対象ファイルが増加した場合は、共通定数への抽出を再検討すべきである。

### 不採用の代替案

| 代替案 | 不採用理由 |
|--------|----------|
| vitest.config.ts `test.env` | vitest仕様依存、他ツール非対応 |
| `.env.test` ファイル | 二重管理のコスト |
| `tests/setup.ts` グローバル削除 | 暗黙的依存、可読性低下 |
| `cross-env` パッケージ | Unix前提プロジェクト（tmux依存）、不要 |
| `envPrefix: ['VITE_']` | `import.meta.env` のみ制御、`process.env` への影響は不確実 |

---

## 9. 変更ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `package.json` | 修正 | 全6テストスクリプトに `NODE_ENV=test` プレフィックス追加 |
| `tests/unit/env.test.ts` | 修正 | process.envを操作する7つのdescribeブロックのbeforeEachに環境変数deleteを追加 |
| `tests/unit/lib/worktree-path-validator.test.ts` | 修正 | beforeEachにALLOWED_WORKTREE_PATHS deleteを追加 [DR2-007] |
| `tests/unit/db-migration-path.test.ts` | 修正 | 既存のDATABASE_PATH deleteで十分（追加変更なし）[DR2-001] |

---

## 10. Stage 1 レビュー指摘反映サマリー

### 反映済み指摘事項

| ID | 重要度 | 原則 | 対応内容 | 反映箇所 |
|----|--------|------|---------|---------|
| DR1-004 | must_fix | 整合性 | スコープ外ファイル（app-version-display.test.tsx, version-checker.test.ts, api-logger.test.ts）の判断根拠を明記 | Section 1 スコープ外 |
| DR1-001 | should_fix | DRY | ENV_VARS_TO_CLEANリスト重複のトレードオフ分析を追記 | Section 8 トレードオフ補足 |
| DR1-002 | should_fix | 整合性 | 「全7 describeブロック」を「process.envを操作する7つのdescribeブロック」に修正し、対象ブロック名を列挙。ENV_MAPPINGブロック除外理由を明記 | Section 4.2 |
| DR1-005 | should_fix | 整合性 | CI ワークフローでのNODE_ENV上書きメカニズムを詳細に説明 | Section 2 変更なしセクション |
| DR1-006 | nice_to_have | SOLID | ファイルローカルcleanEnvVars()ヘルパー関数の検討を追記 | Section 4.2 実装時検討 |

### スキップした指摘事項

| ID | 重要度 | 原則 | スキップ理由 |
|----|--------|------|-------------|
| DR1-003 | nice_to_have | KISS | 設計方針書にフォローアップ Issue での検討が既に明記されており、現行設計で問題なし |
| DR1-007 | nice_to_have | YAGNI | レガシーMCBD_*変数を含める理由のコメントをENV_VARS_TO_CLEANのコードブロック内に追記済み（DR1-006対応の一部として反映） |
| DR1-008 | should_fix | 実装可能性 | プラットフォーム制約の明記は本Issue #304のスコープ外。cross-envの不採用理由は既に設計方針書に記載済み |

---

## 11. Stage 2 レビュー指摘反映サマリー

### 反映済み指摘事項

| ID | 重要度 | 対応内容 | 反映箇所 |
|----|--------|---------|---------|
| DR2-001 | must_fix | db-migration-path.test.tsの修正方針を実際のソースコード依存（DATABASE_PATHのみ）に合わせて修正。CM_DB_PATH/MCBD_DB_PATH/CM_ROOT_DIR/MCBD_ROOT_DIRのdelete指示をYAGNI原則に基づき削除 | Section 4.4, Section 8, Section 9 |
| DR2-003 | should_fix | スコープ外ファイルのパス誤記修正: `tests/unit/lib/api-logger.test.ts` を `tests/unit/api-logger.test.ts` に修正 | Section 1 スコープ外テーブル |
| DR2-004 | should_fix | describeブロック列挙順を実コードの出現順に合わせ、ENV_MAPPINGの位置関係を明記 | Section 4.2 |
| DR2-005 | nice_to_have | 対策1と対策2が異なる問題を解決する独立した対策であることを明示 | Section 8 対策独立性 |
| DR2-006 | nice_to_have | 受入条件の対策2検証にworktree-path-validator.test.tsとdb-migration-path.test.tsの個別コマンドを追記 | Section 7 |
| DR2-007 | should_fix | worktree-path-validator.test.tsの修正方針を実際のソースコード依存（ALLOWED_WORKTREE_PATHSのみ）に合わせて修正。CM_ROOT_DIR/MCBD_ROOT_DIRのdelete指示をYAGNI原則に基づき削除 | Section 4.3, Section 8, Section 9 |

### スキップした指摘事項

| ID | 重要度 | スキップ理由 |
|----|--------|-------------|
| DR2-002 | should_fix | CM_LOG_DIRがENV_VARS_TO_CLEANに含まれていることの補記。ENV_VARS_TO_CLEANのコードブロック内コメントで既にレガシー変数を含める理由を説明しており、CM_LOG_DIRもENV_MAPPINGの全キーとして含まれる設計意図は明確。過度な注釈追加は可読性を低下させるため見送り |
| DR2-008 | nice_to_have | 情報としての記録のみ。package.jsonのテストスクリプト数は正確に一致しており、対応不要 |

---

## 12. Stage 3 レビュー指摘反映サマリー

### 反映済み指摘事項

| ID | 重要度 | 対応内容 | 反映箇所 |
|----|--------|---------|---------|
| DR3-006 | should_fix | `getEnv with fallback` テストにおける `CM_DB_PATH` 未設定時の `getDefaultDbPath()` フォールバックへの暗黙的依存について注記を追加。`ENV_VARS_TO_CLEAN` に `CM_DB_PATH` が含まれているため設計通り実装すれば問題は解消される旨を併記 | Section 4.2 describeブロック一覧 項目4 |
| DR3-015 | should_fix | `api-logger.test.ts` のスコープ外判断根拠に、対策1適用後の動作変化（`originalEnv` が常に `'test'` となり `?? 'test'` フォールバックが実質不要になるが既存テスト動作に変化なし）を補記 | Section 1 スコープ外テーブル |

### スキップした指摘事項

| ID | 重要度 | スキップ理由 |
|----|--------|-------------|
| DR3-001 | nice_to_have | `getLogConfig()` の `NODE_ENV=test` 時デフォルトログレベルに関する注記。テスト結果には影響せず、テストで `CM_LOG_LEVEL` を明示設定しているため実質的な問題なし。任意対応のため見送り |

### 情報（info）項目

Stage 3 影響分析レビューでは 12 件の info 項目（DR3-002 -- DR3-005, DR3-007 -- DR3-014）が報告された。いずれも「対応不要」「設計書の判断は正しい」と結論されており、設計方針書の変更は不要である。主な確認事項:

- **DR3-002**: `api-logger.ts` の `NODE_ENV !== 'development'` チェックとの整合性は問題なし
- **DR3-005**: CI ワークフローの `NODE_ENV` 上書きメカニズムは設計書 DR1-005 の記述通り
- **DR3-007**: `env.test.ts` の既存 `afterEach` 復元パターンとの整合性は問題なし
- **DR3-010**: テストファイル間の依存関係はなし
- **DR3-013**: ソースコード変更なしのため本番ビルド/実行への影響なし

---

*Generated by design-policy command for Issue #304*
*Stage 1 review findings applied: 2026-02-20*
*Stage 2 review findings applied: 2026-02-20*
*Stage 3 review findings applied: 2026-02-20*
