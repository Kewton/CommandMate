# Issue #264 レビューレポート

**レビュー日**: 2026-02-14
**フォーカス**: 影響範囲レビュー
**イテレーション**: 2回目（Stage 7）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 前回（Stage 3）指摘事項の対応状況

Stage 3 で検出された全 9 件の指摘事項（Must Fix 2件、Should Fix 4件、Nice to Have 3件）は、Stage 4 の反映を経て **全件 resolved** となっています。

| ID | カテゴリ | ステータス | 対応内容 |
|----|---------|-----------|---------|
| MF-1 | テスト範囲 | resolved | cli-dependencies.test.ts を変更対象に追加、getOptionalDependencies テスト更新を実装タスクに含めた |
| MF-2 | テスト範囲 | resolved | en/ja 同一キー構造の注意事項を翻訳キー追加タスクに追加 |
| SF-1 | 影響ファイル | resolved | docs コマンドのパス解決方針を明記、package.json files に docs/ 追加 |
| SF-2 | 依存関係 | resolved | GITHUB_RELEASE_URL_PREFIX の re-export 方針を明確化（破壊的変更回避） |
| SF-3 | 破壊的変更 | resolved | issue コマンドと -i/--issue オプションの混同防止をヘルプテキストで対応 |
| SF-4 | ドキュメント更新 | resolved | CLI コマンド記載先を cli-setup-guide.md に変更 |
| NTH-1 | テスト範囲 | resolved | issue.test.ts / docs.test.ts のテスト観点を具体化 |
| NTH-2 | 影響ファイル | resolved | preflight.ts getInstallHint() への gh CLI ヒント追加をタスク化 |
| NTH-3 | 移行考慮 | resolved | GITHUB_REPO_BASE_URL から全 URL 派生の設計を採用 |

---

## Must Fix（必須対応）

### MF-1: src/config/github-links.ts の CLI ビルドスコープ問題

**カテゴリ**: 依存関係
**場所**: 実装タスク > CLIコマンド > src/cli/config/security-messages.ts / 影響範囲 > 変更対象ファイル

**問題**:

Issue の実装タスクでは、`src/cli/config/security-messages.ts` が `src/config/github-links.ts` から GitHub URL 定数を import して Security Guide URL を派生させると記載されています。しかし `tsconfig.cli.json` の `include` は `['src/cli/**/*']` のみであり、`src/config/` は CLI ビルドスコープに含まれていません。`paths` も空 `{}` であるため `@/` エイリアスは使用できず、相対パス `../../config/github-links` でのインポートが必要になります。

この cross-boundary import 自体は TypeScript のモジュール解決上は機能しますが（`src/cli/utils/port-allocator.ts` が `../../lib/errors` を import する前例があります）、設計判断として明示されていません。

加えて、同一の `github-links.ts` を Next.js ビルド側（`FeedbackSection.tsx` が `@/config/github-links` で参照）と CLI ビルド側（`security-messages.ts` が相対パスで参照）の双方から使用するため、モジュール形式の互換性に注意が必要です。

**証拠**:

```
// tsconfig.cli.json
{
  "include": ["src/cli/**/*"],
  "compilerOptions": { "paths": {} }
}

// 既存の cross-boundary import の前例
// src/cli/utils/port-allocator.ts line 12:
import { AppError, ErrorCode } from '../../lib/errors';
```

**推奨対応**:

実装タスクまたは影響範囲セクションに以下を追記してください。

- `src/config/github-links.ts` は `src/cli/` の外部にあるが、`security-messages.ts` からは相対パス `../../config/github-links` で import する（`port-allocator.ts` の `../../lib/errors` import と同パターン）
- 実装時に `npm run build:cli` が正常にビルドできることを確認する受入条件を追加する
- `tsconfig.cli.json` の `include` 拡張が必要な場合はその旨を明記する

---

## Should Fix（推奨対応）

### SF-1: version-checker.test.ts の既存テスト通過を受入条件に追加

**カテゴリ**: テスト範囲
**場所**: 受入条件 / テスト > tests/unit/lib/version-checker.test.ts

**問題**:

受入条件に「`src/lib/version-checker.ts` の既存 import パスが維持されていること」とありますが、import パスの維持だけでなく、re-export 後の値の同一性が正しく機能することの具体的な検証手段が不足しています。

`tests/unit/lib/version-checker.test.ts` の line 238-243 には `GITHUB_RELEASE_URL_PREFIX` の値を `'https://github.com/Kewton/CommandMate/releases/'` と厳密比較するテストが既に存在します。このテストが re-export 後も修正なしでパスすれば、import パス維持と値の同一性が同時に保証されます。

**証拠**:

```typescript
// tests/unit/lib/version-checker.test.ts line 238-243
describe('GITHUB_RELEASE_URL_PREFIX constant [SEC-SF-001]', () => {
  it('should be correct GitHub releases URL', () => {
    expect(GITHUB_RELEASE_URL_PREFIX).toBe(
      'https://github.com/Kewton/CommandMate/releases/'
    );
  });
});
```

**推奨対応**:

受入条件に「`tests/unit/lib/version-checker.test.ts` の既存テスト（GITHUB_RELEASE_URL_PREFIX 定数テスト、validateReleaseUrl テスト）が修正なしですべてパスすること」を追加してください。

---

### SF-2: issue/docs コマンドの ExitCode 方針が未定義

**カテゴリ**: 影響ファイル
**場所**: 実装タスク > CLIコマンド / src/cli/types/index.ts

**問題**:

既存 CLI コマンドはそれぞれ専用の `ExitCode` を使用しています（`START_FAILED=3`, `STOP_FAILED=4` 等）。新規の `issue` コマンドと `docs` コマンドでエラーが発生した場合（gh CLI 未インストール、ファイル読み込み失敗、gh コマンド実行失敗等）にどの `ExitCode` を返すかが Issue に記載されていません。

`src/cli/types/index.ts` の `ExitCode` enum に新規コードを追加するのか、既存の `DEPENDENCY_ERROR(1)` や `UNEXPECTED_ERROR(99)` を流用するのかの判断が実装者に委ねられています。

**証拠**:

```typescript
// src/cli/types/index.ts
export enum ExitCode {
  SUCCESS = 0,
  DEPENDENCY_ERROR = 1,
  CONFIG_ERROR = 2,
  START_FAILED = 3,
  STOP_FAILED = 4,
  UNEXPECTED_ERROR = 99,
}
```

**推奨対応**:

実装タスク内に ExitCode の使用方針を記載してください。例:

- gh CLI 未インストール時: `DEPENDENCY_ERROR(1)` を流用
- gh コマンド実行失敗時: `UNEXPECTED_ERROR(99)` を流用、または `ISSUE_FAILED(5)` を新設
- docs ファイル読み込み失敗時: `CONFIG_ERROR(2)` を流用、または `DOCS_FAILED(6)` を新設

---

## Nice to Have（あれば良い）

### NTH-1: docs コマンドの __dirname パス階層がビルド後の dist/ 構造と不一致の可能性

**カテゴリ**: 影響ファイル
**場所**: 実装タスク > CLIコマンド > src/cli/commands/docs.ts

**問題**:

実装タスクに `path.join(__dirname, '../../docs/')` と記載されていますが、`npm run build:cli` 後のファイル配置を考慮すると、`docs.ts` は `dist/cli/commands/docs.js` にコンパイルされます。`dist/cli/commands/` からパッケージルートの `docs/` へは 3 階層上（`../../../docs/`）であり、記載の 2 階層（`../../docs/`）とは一致しません。

ソースコード上の `src/cli/commands/docs.ts` 基準では `../../docs/` は `src/docs/` を指しますが、パッケージルートの `docs/` を指すには `../../../docs/` が必要です。

**証拠**:

```
// tsconfig.cli.json
outDir: './dist'
rootDir: './src'

// コンパイル後のパス
src/cli/commands/docs.ts -> dist/cli/commands/docs.js

// dist/cli/commands/ からの相対パス
../../docs/ -> dist/docs/  (存在しない)
../../../docs/ -> docs/     (正しい)
```

**推奨対応**:

パス解決の記載を以下のいずれかに修正することを検討してください。

- `path.join(__dirname, '../../../docs/')` に修正（ビルド後の dist/ 構造に合わせる）
- `path.resolve(__dirname, '..', '..', '..', 'docs')` と明示的に記載
- 既存の `src/cli/utils/paths.ts` の `getPackageRoot()` 関数を活用する方針を記載（`path.join(getPackageRoot(), 'docs')`）

---

### NTH-2: cli-setup-guide.md への追記内容のアウトラインが未定義

**カテゴリ**: ドキュメント更新
**場所**: 影響範囲 > 変更対象ファイル > docs/user-guide/cli-setup-guide.md

**問題**:

影響範囲テーブルに `cli-setup-guide.md` の変更内容が「issue/docsコマンドの使い方を追記」と記載されていますが、具体的なセクション構造や記載項目が未定義です。実装時にドキュメントの構成判断が発生します。

**推奨対応**:

以下のようなアウトラインを実装タスク内に追記することを検討してください。

- 「## Issue Management (`commandmate issue`)」セクション: create/search/list サブコマンド、オプション表、使用例
- 「## Documentation Access (`commandmate docs`)」セクション: --section/--search/--all オプション、利用可能セクション一覧、AI ツール連携例

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/utils/port-allocator.ts` | Line 12: CLI ビルドスコープ外の cross-boundary import 前例（MF-1） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tsconfig.cli.json` | CLI ビルドの include/paths 定義（MF-1） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/tests/unit/lib/version-checker.test.ts` | Lines 22, 238-243: GITHUB_RELEASE_URL_PREFIX の直接 import と値検証テスト（SF-1） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/types/index.ts` | ExitCode enum の現状定義（SF-2） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/config/security-messages.ts` | Line 26: github-links.ts からの URL 派生が必要（MF-1） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/lib/version-checker.ts` | Lines 27, 33: GITHUB_API_URL と GITHUB_RELEASE_URL_PREFIX の定義元 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/docs/user-guide/cli-setup-guide.md` | issue/docs コマンドドキュメントの追記先（NTH-2） |
| `/Users/maenokota/share/work/github_kewton/commandmate-issue-264/CLAUDE.md` | 新規モジュール情報の追記対象 |
