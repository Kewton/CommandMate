# Issue #96 アーキテクチャレビュー - Stage 3: 影響分析レビュー

| 項目 | 値 |
|------|-----|
| Issue番号 | #96 |
| レビュー日 | 2026-01-31 |
| レビュータイプ | 影響範囲分析 |
| ステージ | 3/4 |
| 設計書 | dev-reports/design/issue-96-npm-cli-design-policy.md |

---

## 1. 概要

Issue #96「npm installからセットアップ可能にする」の設計方針書に対する影響範囲分析レビューを実施した。本レビューでは、変更対象ファイル、既存機能への影響、依存関係、テスト、ドキュメント、CI/CD、後方互換性の7つの観点から分析を行った。

---

## 2. 影響範囲サマリー

### 2.1 変更規模

| カテゴリ | 件数 |
|---------|------|
| 新規作成ファイル | 19件 |
| 修正対象ファイル | 7件 |
| 追加依存関係 | 1件（commander） |
| 必要テストファイル | 11件 |
| 更新ドキュメント | 6件 |
| CI/CD変更 | 2件 |
| 破壊的変更 | 2件 |

### 2.2 影響度分類

#### 高影響（High Impact）
- `server.ts` - サーバー起動ロジック変更（MCBD_* -> getEnvByKey()）
- `src/lib/env.ts` - 環境変数管理の中核変更
- `package.json` - npm設定・依存関係変更

#### 中影響（Medium Impact）
- `tsconfig.json` - ビルド構成変更（CLIビルド対応）
- 既存ユニットテスト - env.ts変更に伴う更新

#### 低影響（Low Impact）
- ドキュメント更新（README.md, CLAUDE.md, docs/*）
- シェルスクリプト（並行運用期間中は変更なし）

---

## 3. 新規作成ファイル詳細

### 3.1 CLIコアファイル

| ファイルパス | 目的 | 推定行数 |
|-------------|------|---------|
| `bin/commandmate.js` | CLIエントリポイント（shebang付き） | 2-3行 |
| `src/cli/index.ts` | CLIメインロジック（commander設定） | 50-80行 |

### 3.2 コマンドモジュール

| ファイルパス | 目的 | 推定行数 |
|-------------|------|---------|
| `src/cli/commands/init.ts` | initコマンド実装 | 80-120行 |
| `src/cli/commands/start.ts` | startコマンド実装 | 60-100行 |
| `src/cli/commands/stop.ts` | stopコマンド実装 | 40-60行 |
| `src/cli/commands/status.ts` | statusコマンド実装 | 40-60行 |

### 3.3 ユーティリティモジュール

| ファイルパス | 目的 | 推定行数 |
|-------------|------|---------|
| `src/cli/utils/preflight.ts` | 依存関係チェック | 150-200行 |
| `src/cli/utils/env-setup.ts` | 環境設定生成 | 200-300行 |
| `src/cli/utils/daemon.ts` | デーモンプロセス管理 | 60-80行 |
| `src/cli/utils/pid-manager.ts` | PIDファイル管理 | 40-60行 |
| `src/cli/utils/logger.ts` | CLI専用ロガー | 30-50行 |

### 3.4 設定・型定義

| ファイルパス | 目的 | 推定行数 |
|-------------|------|---------|
| `src/cli/config/cli-dependencies.ts` | 依存関係定義 | 30-40行 |
| `src/cli/interfaces/preflight-checker.ts` | IPreflightChecker | 15-20行 |
| `src/cli/interfaces/env-setup.ts` | IEnvSetup | 15-20行 |
| `src/cli/interfaces/daemon-manager.ts` | IDaemonManager | 15-20行 |
| `src/cli/types/index.ts` | CLI共通型定義 | 30-50行 |
| `src/config/defaults.ts` | 環境変数デフォルト値一元管理 | 15-25行 |

### 3.5 npm/CI設定

| ファイルパス | 目的 | 推定行数 |
|-------------|------|---------|
| `.npmignore` | npm publish除外設定 | 20-30行 |
| `.github/workflows/publish.yml` | npm publish自動化 | 25-35行 |

---

## 4. 修正対象ファイル詳細

### 4.1 package.json

**変更内容**:
```json
{
  "bin": {
    "commandmate": "./bin/commandmate.js"
  },
  "files": [
    "bin/",
    "dist/",
    ".env.example"
  ],
  "private": false,
  "dependencies": {
    "commander": "^12.0.0"
  }
}
```

**リスク**: 中（npm publish設定の影響）

### 4.2 server.ts

**変更内容**:
```typescript
// 変更前（43-44行目）
const hostname = process.env.MCBD_BIND || '127.0.0.1';
const port = parseInt(process.env.MCBD_PORT || process.env.PORT || '3000', 10);

// 変更後
import { getEnvByKey } from './src/lib/env';
const hostname = getEnvByKey('CM_BIND') || '127.0.0.1';
const port = parseInt(getEnvByKey('CM_PORT') || '3000', 10);
```

**リスク**: 高（サーバー起動に直接影響）

### 4.3 src/lib/env.ts

**変更内容**:
1. `CM_DB_PATH`デフォルト値を`db.sqlite`から`cm.db`に変更
2. `src/config/defaults.ts`からのインポート追加
3. デフォルト値を`ENV_DEFAULTS`から参照

**リスク**: 高（環境設定全体に影響）

### 4.4 tsconfig.json（または新規tsconfig.cli.json）

**変更内容**:
- CLIビルド出力設定の追加
- `noEmit: false`への変更（またはtsconfig.cli.json新規作成）

**リスク**: 中（ビルド構成への影響）

---

## 5. 依存関係の変更

### 5.1 追加依存関係

| パッケージ | バージョン | 種別 | サイズ影響 |
|-----------|----------|------|-----------|
| commander | ^12.0.0 | dependencies | 軽量（依存関係少） |

### 5.2 既存依存関係への影響

既存の依存関係への影響はなし。commanderは独立した軽量パッケージであり、既存パッケージとの競合リスクは低い。

---

## 6. テスト影響分析

### 6.1 必須テスト（新規作成）

| テストファイル | 優先度 |
|--------------|--------|
| `tests/unit/cli/preflight.test.ts` | 必須 |
| `tests/unit/cli/env-setup.test.ts` | 必須 |
| `tests/unit/cli/daemon.test.ts` | 必須 |
| `tests/unit/cli/pid-manager.test.ts` | 必須 |
| `tests/unit/cli/commands/init.test.ts` | 必須 |
| `tests/unit/cli/commands/start.test.ts` | 必須 |
| `tests/unit/cli/commands/stop.test.ts` | 必須 |
| `tests/unit/cli/commands/status.test.ts` | 必須 |
| `tests/unit/config/defaults.test.ts` | 必須 |

### 6.2 推奨テスト（新規作成）

| テストファイル | 優先度 |
|--------------|--------|
| `tests/integration/cli/workflow.test.ts` | 推奨 |

### 6.3 既存テストへの影響

| テストファイル | 影響内容 |
|--------------|---------|
| `tests/unit/env.test.ts` | DB_PATHデフォルト値変更に伴うアサーション更新が必要 |

---

## 7. ドキュメント更新

| ドキュメント | セクション | 変更内容 |
|-------------|----------|---------|
| README.md | Quick Start | CLIインストール手順を主要手順に追加 |
| CLAUDE.md | 開発コマンド | CLIコマンド追加 |
| docs/DEPLOYMENT.md | セットアップ手順 | CLI推奨、シェルスクリプトをレガシー化 |
| docs/migration-to-commandmate.md | 新規追加 | CLI移行手順、WORKTREE_REPOS移行手順 |
| docs/user-guide/quick-start.md | セットアップ | CLIコマンドの使い方追加 |
| CHANGELOG.md | Added | CLI機能追加の記録 |

---

## 8. CI/CD変更

### 8.1 新規ワークフロー

**ファイル**: `.github/workflows/publish.yml`

```yaml
name: Publish to npm
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**必要なシークレット**: `NPM_TOKEN`

### 8.2 既存ワークフローへの影響

**ファイル**: `.github/workflows/ci-pr.yml`

CLIテストは`tests/unit/cli/**`配下に配置されるため、`npm run test:unit`で自動的にカバーされる。追加の設定変更は不要。

---

## 9. 破壊的変更

### 9.1 BC-1: CM_DB_PATHデフォルト値変更

| 項目 | 内容 |
|------|------|
| 変更内容 | `db.sqlite` -> `cm.db` |
| 影響 | .envにCM_DB_PATHを明示設定していない既存ユーザー |
| 重大度 | 中 |
| 緩和策 | 移行ガイドにDB_PATH明示設定またはファイルリネームの手順を記載 |

### 9.2 BC-2: package.json private: false

| 項目 | 内容 |
|------|------|
| 変更内容 | `private: true` -> `private: false` |
| 影響 | 誤ってnpm publishが実行される可能性 |
| 重大度 | 低 |
| 緩和策 | npm publish直前まで`private: true`を維持、CI/CDでの自動publishを推奨 |

---

## 10. レビュー指摘事項

### 10.1 Must Fix（2件）

#### MF-1: CLIビルド出力設定の不足

| 項目 | 内容 |
|------|------|
| カテゴリ | ビルド構成 |
| 説明 | 現在のtsconfig.jsonは`noEmit: true`となっており、CLIのビルド出力（dist/cli/）が生成されない |
| 影響ファイル | tsconfig.json, package.json |
| 対策 | tsconfig.cli.jsonを新規作成し、CLI専用のビルド設定を定義。package.jsonにbuild:cliスクリプトを追加 |

#### MF-2: tsxによるserver.ts実行との整合性

| 項目 | 内容 |
|------|------|
| カテゴリ | 依存関係 |
| 説明 | 現在server.tsはtsxで直接実行されている。CLI startコマンドがserver.tsを起動する際の整合性が必要 |
| 影響ファイル | src/cli/commands/start.ts, package.json |
| 対策 | CLI startコマンドは`npm start`を内部的に実行する形式を推奨 |

### 10.2 Should Fix（3件）

#### SF-1: 既存テストへの影響確認

| 項目 | 内容 |
|------|------|
| カテゴリ | テスト |
| 説明 | src/lib/env.tsの変更により、tests/unit/env.test.tsの既存テストが影響を受ける可能性 |
| 対策 | env.ts変更前に既存テストを確認し、デフォルト値のアサーションを更新 |

#### SF-2: シェルスクリプトDeprecation警告の追加

| 項目 | 内容 |
|------|------|
| カテゴリ | ドキュメント |
| 説明 | Phase 2でシェルスクリプトにDeprecation警告を追加する計画だが、具体的な実装方法が未定義 |
| 対策 | 各シェルスクリプトの冒頭に警告メッセージを追加する実装計画を明確化 |

#### SF-3: PIDファイルのパス設定

| 項目 | 内容 |
|------|------|
| カテゴリ | セキュリティ |
| 説明 | PIDファイルの配置場所が設計書で明確でない。複数インスタンス実行時の競合リスク |
| 対策 | PIDファイルのパスを環境変数またはXDG仕様で設定可能にすることを検討 |

### 10.3 Nice to Have（3件）

#### NTH-1: CLI開発用のwatch機能

開発効率向上のため、`build:cli:watch`スクリプトの追加を推奨。

#### NTH-2: ポート競合時の詳細情報表示

トラブルシューティング効率向上のため、lsofコマンド結果のエラーメッセージ含有を推奨。

#### NTH-3: logs/restart/health-checkコマンドの将来計画

将来Issueとして登録し、設計書にIssue番号を参照として追記することを推奨。

---

## 11. 推奨実装順序

### Phase 1: 基盤準備（MF-1, MF-2対応）

1. `src/config/defaults.ts` 作成
2. `src/lib/env.ts` 修正（defaults.ts参照、DB_PATH変更）
3. `server.ts` 修正（getEnvByKey使用）
4. 既存テスト更新

**理由**: CLI実装の前提条件を整備

### Phase 2: CLIコア実装

1. `tsconfig.cli.json` 作成
2. `src/cli/types`, `interfaces` 作成
3. `src/cli/utils/*` 実装
4. ユニットテスト作成

**理由**: CLIユーティリティの基盤構築

### Phase 3: コマンド実装

1. `src/cli/commands/*` 実装
2. `src/cli/index.ts` 実装
3. `bin/commandmate.js` 作成
4. コマンドテスト作成

**理由**: ユーザー向け機能の実装

### Phase 4: npm publish準備

1. `package.json` 更新（bin, files）
2. `.npmignore` 作成
3. `.github/workflows/publish.yml` 作成
4. ドキュメント更新

**理由**: リリース準備

---

## 12. 結論

Issue #96の実装は約20個の新規ファイル作成と7個の既存ファイル修正が必要な中規模の変更である。

**主要リスク**:
1. server.tsとsrc/lib/env.tsの変更はサーバー起動と環境設定の中核部分に影響
2. ビルド構成（tsconfig.json）の変更とテストへの影響確認が重要

**推奨事項**:
1. 4フェーズに分けた段階的実装を推奨
2. 新規依存関係はcommander（軽量）のみで影響は最小限
3. DB_PATHデフォルト値変更の移行ガイド整備が必要

---

## 13. レビュー結果ファイル

- 結果JSON: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/issue/96/multi-stage-design-review/stage3-review-result.json`
- 本レポート: `/Users/maenokota/share/work/github_kewton/MyCodeBranchDesk/dev-reports/review/2026-01-31-issue96-architecture-review-stage3.md`

---

*Generated by architecture-review-agent*
