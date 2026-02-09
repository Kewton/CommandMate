# Issue #202 影響範囲レビューレポート

**レビュー日**: 2026-02-09
**フォーカス**: 影響範囲レビュー（影響ファイル、依存関係、破壊的変更、テスト範囲、ドキュメント更新）
**イテレーション**: 1回目（Stage 3）

## 前提: Stage 1-2 の対応状況

Stage 1（通常レビュー）で検出された6件の指摘事項は、Stage 2 ですべて Issue 本文に反映済みです。具体的には:

- import 文の相対パス形式の明記（MF-1）
- 呼び出し順序制約の明文化（SF-1）
- ログ出力の追加（SF-2）
- テスト方針の具体化（SF-3）
- DRY 原則に基づく共通関数化の検討（NTH-1）
- 再現手順コマンド表記の修正（NTH-2）

本レビューでは、上記の修正を踏まえた Issue の影響範囲の網羅性を中心に評価します。

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 2 |
| Nice to Have | 2 |

**総合評価**: Issue #202 の影響範囲セクションは server.ts のみを対象としていますが、サーバービルド構成ファイル（tsconfig.server.json）への影響が考慮されていません。server.ts に db-repository.ts の関数を import するためには、tsconfig.server.json の include 配列にも追加が必要です。これはビルド失敗に直結する問題であるため、Must Fix としています。

---

## Must Fix（必須対応）

### MF-1: tsconfig.server.json の include 配列への追加が必要

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション

**問題**:
Issue の影響範囲テーブルには `server.ts` のみが記載されていますが、`tsconfig.server.json` の変更が漏れています。

server.ts のビルドは `npm run build:server` で実行され、内部的に `tsc --project tsconfig.server.json && tsc-alias -p tsconfig.server.json` が走ります。このとき、tsconfig.server.json の `include` 配列はコンパイル対象ファイルを明示的にリストしています。

現在の tsconfig.server.json の include:

```json
"include": [
    "server.ts",
    "src/lib/env.ts",
    "src/lib/ws-server.ts",
    "src/lib/worktrees.ts",
    "src/lib/db.ts",
    "src/lib/db-instance.ts",
    "src/lib/db-migrations.ts",
    "src/lib/response-poller.ts",
    "src/lib/cli-session.ts",
    "src/lib/prompt-detector.ts",
    "src/lib/conversation-logger.ts",
    "src/lib/claude-output.ts",
    "src/lib/cli-patterns.ts",
    "src/lib/cli-tools/**/*.ts",
    "src/types/**/*.ts"
]
```

この一覧に `src/lib/db-repository.ts` と `src/config/system-directories.ts` が含まれていません。

**証拠**:

1. `server.ts` に `import { ensureEnvRepositoriesRegistered, filterExcludedPaths } from './src/lib/db-repository';` を追加すると、TypeScript コンパイラは `db-repository.ts` を解決する必要がある
2. `db-repository.ts`（L10-11）は以下を import している:
   - `import type { CloneJobStatus } from '@/types/clone';` -- `src/types/**/*.ts` で既にカバー
   - `import { isSystemDirectory } from '@/config/system-directories';` -- **tsconfig.server.json の include に含まれていない**
3. TypeScript は import チェーンを自動解決する場合があるが、`tsc-alias` によるパス変換（`@/` -> `./src/`）は include にリストされたファイルに対して行われるため、明示的に含めないとパス解決が不完全になるリスクがある

**推奨対応**:

影響範囲テーブルに `tsconfig.server.json` を追加し、修正方針に以下の手順を追記してください:

> `tsconfig.server.json` の `include` 配列に以下を追加:
> - `"src/lib/db-repository.ts"`
> - `"src/config/system-directories.ts"`

---

## Should Fix（推奨対応）

### SF-1: build:server の成功確認が受け入れ条件に未記載

**カテゴリ**: テスト範囲
**場所**: 受け入れ条件セクション / テスト方針セクション

**問題**:
受け入れ条件に「既存のテストがパスすること」は記載されていますが、`npm run build:server` の成功確認が含まれていません。server.ts は Next.js ビルド（`npm run build`）とは別に、専用の TypeScript プロジェクト（tsconfig.server.json）でコンパイルされます。

import 文の追加は `npm run build` では問題なく通る可能性がありますが（tsconfig.json は `**/*.ts` を include しているため）、`npm run build:server` では include が限定されているため失敗する可能性があります。

**証拠**:

- `package.json`: `"build:server": "tsc --project tsconfig.server.json && tsc-alias -p tsconfig.server.json"`
- `tsconfig.json`（Next.js 用）: `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]` -- 全 `.ts` ファイルを含む
- `tsconfig.server.json`: include は明示的にリストされたファイルのみ -- **db-repository.ts を含まない**
- CLAUDE.md の CI/CD 必須チェックは `npm run build` のみで `build:server` は明示されていない

**推奨対応**:
受け入れ条件に「`npm run build:server` が成功すること」を追加するか、「既存のテストがパスすること」を「既存のテストがパスし、`npm run build:all`（Next.js + CLI + server）が成功すること」に拡充してください。

---

### SF-2: db-repository.ts の間接依存の明記

**カテゴリ**: 依存関係
**場所**: 影響範囲セクション

**問題**:
server.ts から db-repository.ts を import すると、db-repository.ts の内部依存も間接的に影響を受けます。Issue の影響範囲セクションではこの間接依存チェーンについて言及がありません。

**証拠**:

`db-repository.ts` の import チェーン:
```
server.ts
  -> src/lib/db-repository.ts
       -> src/types/clone.ts         (type import: CloneJobStatus)
       -> src/config/system-directories.ts  (value import: isSystemDirectory)
```

- `src/types/clone.ts`: tsconfig.server.json の `src/types/**/*.ts` でカバー済み -- 問題なし
- `src/config/system-directories.ts`: tsconfig.server.json の include に**含まれていない** -- 追加が必要

**推奨対応**:
影響範囲テーブルに以下の注記を追加してください:

| ファイル | 変更内容 |
|---------|---------|
| `tsconfig.server.json` | include に `src/lib/db-repository.ts`, `src/config/system-directories.ts` を追加（server.ts のビルドに必要な依存解決） |

---

## Nice to Have（あれば良い）

### NTH-1: 結合テストの言及

**カテゴリ**: テスト範囲
**場所**: テスト方針セクション

**問題**:
テスト方針に「既存テスト: `db-repository-exclusion.test.ts` の filterExcludedPaths / ensureEnvRepositoriesRegistered 単体テストが引き続きパスすること」と記載されていますが、結合テスト `tests/integration/repository-exclusion.test.ts` にも関連テストが存在します。

**証拠**:

`tests/integration/repository-exclusion.test.ts` には以下のテストスイートが含まれています:
- `Exclusion -> Sync flow`（L62-107）: ensureEnvRepositoriesRegistered + disableRepository + filterExcludedPaths のフルフロー
- `Full round-trip flow`（L244-275）: exclude -> list -> restore の完全なサイクル

**推奨対応**:
テスト方針に結合テストの参照を追加することで、検証対象がより明確になります。

---

### NTH-2: CLAUDE.md のモジュール記載

**カテゴリ**: ドキュメント更新
**場所**: Issue 本文全体

**問題**:
CLAUDE.md の主要機能モジュールテーブルに `server.ts` の記載がありません。本 Issue で `initializeWorktrees()` に除外フィルタリングが追加されるため、このテーブルへの追記があるとプロジェクトドキュメントの網羅性が向上します。

ただし、これは本 Issue のスコープ外であり、備考セクションの DRY 共通関数化と同様にフォローアップとして検討する程度で十分です。

---

## 影響範囲マトリクス

### 直接変更が必要なファイル

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `server.ts` | 修正 | `initializeWorktrees()` に除外フィルタリング追加、import 文追加、ログ出力追加 |
| `tsconfig.server.json` | 修正 | include に `src/lib/db-repository.ts`, `src/config/system-directories.ts` を追加 |

### 間接的に影響を受けるファイル（変更不要）

| ファイル | 影響 |
|---------|------|
| `src/lib/db-repository.ts` | server.ts から新たに呼び出される。関数自体の変更は不要。 |
| `src/config/system-directories.ts` | db-repository.ts の間接依存。tsconfig.server.json の include 対象にする必要あり。 |
| `src/types/clone.ts` | db-repository.ts の型依存。既に `src/types/**/*.ts` で tsconfig.server.json に含まれている。 |

### 影響なし（根拠付き）

| ファイル | 根拠 |
|---------|------|
| `src/app/api/repositories/sync/route.ts` | 参考実装。server.ts がこれと同一パターンを採用するが、sync/route.ts 自体は変更不要。 |
| `src/app/api/repositories/scan/route.ts` | 個別リポジトリスキャン API。除外ロジックは呼び出し元（sync, server.ts）で制御する方式のため影響なし。 |
| `src/app/api/repositories/route.ts` | DELETE ハンドラー。disableRepository() を呼び出す側であり、スコープ外。 |
| `src/app/api/repositories/restore/route.ts` | リストア API。スコープ外。 |
| `src/cli/commands/start.ts` | CLI start コマンド。`npm run start` を spawn するだけで、initializeWorktrees() は server.ts 側で実行される。 |

### 破壊的変更

なし。内部的な初期化処理の修正であり、外部 API やUI の変更はありません。

### 移行考慮

なし。既存ユーザーへの影響はありません。サーバー再起動時に削除済みリポジトリが復活しなくなるという動作改善のみです。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/server.ts` (L29-42, L69-100) | 修正対象。initializeWorktrees() に除外フィルタリング追加。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tsconfig.server.json` (L8-24) | 修正対象。include 配列の拡張が必要。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/app/api/repositories/sync/route.ts` (L10, L27-33) | 参考実装。同一パターンの適用元。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/lib/db-repository.ts` (L10-11, L369-408) | 使用する関数。間接依存チェーンの起点。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/src/config/system-directories.ts` | db-repository.ts の間接依存。tsconfig.server.json への追加が必要。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tests/unit/lib/db-repository-exclusion.test.ts` | 既存単体テスト。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/tests/integration/repository-exclusion.test.ts` | 既存結合テスト。 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/CLAUDE.md` | プロジェクト構成参照。server.ts のモジュール記載なし。 |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-202/package.json` | build:server コマンド定義の参照。 |
