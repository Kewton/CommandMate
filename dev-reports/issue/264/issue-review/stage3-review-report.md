# Issue #264 影響範囲レビューレポート

**レビュー日**: 2026-02-14
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目（Stage 3）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #264は5つのサブ機能（UI FeedbackSection、CLI issueコマンド、initガイド追加、docsコマンド、ドキュメント整備）で構成される大規模な機能追加であり、影響範囲は広い。新規ファイル6件、既存変更10件、テスト影響5件以上に及ぶ。最も注意すべき点は、既存テストの破壊リスク（MF-1, MF-2）とnpmパッケージ配布時のdocsファイル欠落（SF-1）である。

---

## Must Fix（必須対応）

### MF-1: 既存テスト cli-dependencies.test.ts が gh CLI 追加で破壊される

**カテゴリ**: テスト範囲
**場所**: `tests/unit/cli/config/cli-dependencies.test.ts` (line 77-88)

**問題**:
`src/cli/config/cli-dependencies.ts` に gh CLI を `required: false` で追加すると、既存の `getOptionalDependencies` テストが失敗する。現在のテストは optional 依存が Claude CLI のみであることを前提としている。

**証拠**:
```typescript
// tests/unit/cli/config/cli-dependencies.test.ts line 82-88
describe('getOptionalDependencies', () => {
  it('should include Claude CLI', () => {
    const optional = getOptionalDependencies();
    const names = optional.map(d => d.name);
    expect(names).toContain('Claude CLI');
  });
});
```

gh CLI 追加後は optional 依存が2件になるため、テストの更新が不可欠。

**推奨対応**:
影響範囲の「変更対象ファイル」表に `tests/unit/cli/config/cli-dependencies.test.ts` を追加し、gh CLI 追加に伴うテスト更新を実装タスクに含める。

---

### MF-2: i18n 翻訳キーパリティテストへの影響

**カテゴリ**: テスト範囲
**場所**: `tests/integration/i18n-translation-keys.test.ts` / `locales/en/worktree.json` / `locales/ja/worktree.json`

**問題**:
`tests/integration/i18n-translation-keys.test.ts` は en/ja の全翻訳キーの一致を自動検証している。`worktree.json` に feedback セクションの翻訳キーを追加する際、en/ja 両方に完全に同一構造のキーを追加しないと統合テストが失敗する。

**証拠**:
```typescript
// tests/integration/i18n-translation-keys.test.ts line 14
const NAMESPACES = ['common', 'worktree', 'autoYes', 'error', 'prompt'] as const;
```

`worktree` 名前空間は検証対象に含まれており、en/ja 間でキーの不一致があると CI が即座に失敗する。

**推奨対応**:
実装タスクの翻訳キー追加項目に「en/ja 両方に同一キー構造で追加すること（i18n-translation-keys.test.ts のパリティチェック対応）」という注意事項を明記する。

---

## Should Fix（推奨対応）

### SF-1: docsコマンドのファイルパス解決とパッケージ配布の問題

**カテゴリ**: 影響ファイル
**場所**: 提案する解決策 > (4)ドキュメント取得コマンド

**問題**:
`commandmate docs` コマンドが `docs/` 配下のファイルを読み込む設計だが、以下の2点が未解決:

1. npm グローバルインストール時とローカル実行時でドキュメントファイルの相対パスが異なる
2. `package.json` の `files` フィールドに `docs/` が含まれていないため、`npm publish` 時にドキュメントファイルが配布されない

**証拠**:
```json
// package.json の files フィールド
"files": [
  "bin/",
  "dist/",
  ".next/",
  "public/",
  ".env.example"
]
```

`docs/` が含まれていないため、グローバルインストールされた `commandmate docs` コマンドはドキュメントファイルにアクセスできない。

**推奨対応**:
- `package.json` の `files` に `docs/` を追加する実装タスクを含める
- docsコマンドのファイルパス解決方針（`path.join(__dirname, '../../docs/')` 等）を明記する
- 変更対象ファイル表に `package.json` を追加する

---

### SF-2: GITHUB_RELEASE_URL_PREFIX 移設の影響範囲

**カテゴリ**: 依存関係
**場所**: 主要な変更点 / 実装タスク > UI > github-links.ts

**問題**:
`version-checker.ts` の `GITHUB_RELEASE_URL_PREFIX` を `github-links.ts` に移設する場合、`version-checker.ts` 内の `validateReleaseUrl()` とそのテスト（`tests/unit/api/update-check.test.ts`）の import パスが変更される。

**証拠**:
```typescript
// src/lib/version-checker.ts line 33, 141
export const GITHUB_RELEASE_URL_PREFIX = 'https://github.com/Kewton/CommandMate/releases/' as const;
// ...
export function validateReleaseUrl(url: string): string | null {
  if (!url.startsWith(GITHUB_RELEASE_URL_PREFIX)) {
```

**推奨対応**:
移設を行う場合と行わない場合の判断基準を明記する。移設する場合は `version-checker.ts` で re-export するパターンで後方互換性を維持するか、全参照箇所を一括更新するかを決定する。Issue文面の「統合も検討」を具体的な方針に置き換える。

---

### SF-3: 'issue' コマンド名と '-i, --issue' オプションの命名重複

**カテゴリ**: 破壊的変更
**場所**: 提案する解決策 > (2)CLIにissueコマンドを追加 / `src/cli/index.ts`

**問題**:
既存の `start`, `stop`, `status` コマンドはすべて `-i, --issue <number>` オプションを持つ。新規 `issue` コマンドとの命名の重複がユーザーの混乱を招く可能性がある。

**証拠**:
```typescript
// src/cli/index.ts
program.command('start').option('-i, --issue <number>', ...)
program.command('stop').option('-i, --issue <number>', ...)
program.command('status').option('-i, --issue <number>', ...)
// 新規追加予定
program.command('issue').description('Manage GitHub issues')
```

commander ライブラリでは command と option は別スコープなため技術的な衝突はないが、`commandmate --help` の出力で 'issue' が2つの異なる文脈で表示される。

**推奨対応**:
ヘルプ出力で `issue` コマンドと `-i/--issue` オプションの区別を明確にするか、コマンド名の代替案（`feedback`, `gh-issue` 等）を検討する旨を記載する。

---

### SF-4: commands-guide.md への追記場所の不適切性

**カテゴリ**: ドキュメント更新
**場所**: 実装タスク > ドキュメント > commands-guide.md

**問題**:
`docs/user-guide/commands-guide.md` はClaude Code のスラッシュコマンド（`/work-plan`, `/create-pr` 等）とスキル（`/release`, `/rebuild`）の専門ガイドである。commandmate CLI コマンド（`commandmate issue`, `commandmate docs`）の追記場所としては文脈が異なる。

**証拠**:
`commands-guide.md` の見出しは「コマンド一覧」「/work-plan」「/create-pr」「CLIツール標準スラッシュコマンド」「スキル一覧」であり、全てスラッシュコマンドに関する内容。一方 `cli-setup-guide.md` は CLI セットアップに関するガイドであり、CLI コマンドの追記先としてより適切。

**推奨対応**:
CLI コマンド（`commandmate issue`, `commandmate docs`）の記載先を `docs/user-guide/cli-setup-guide.md` に変更するか、`commands-guide.md` に 'CommandMate CLI Commands' セクションを新設する方針を決定し、実装タスクに反映する。

---

## Nice to Have（あれば良い）

### NTH-1: 新規コマンドのテスト方針の具体化

**カテゴリ**: テスト範囲
**場所**: 実装タスク > ドキュメント > ユニットテスト追加

**問題**:
既存 CLI コマンドには各々テストファイルが存在する（`init.test.ts`, `start.test.ts` 等、計7ファイル）が、`issue`/`docs` コマンドのテストファイル名やテスト観点が未定義。

**推奨対応**:
以下のテストファイルを明記する:
- `tests/unit/cli/commands/issue.test.ts`: gh CLI 連携のモック、テンプレート選択、エラーハンドリング、gh 未インストール時の挙動
- `tests/unit/cli/commands/docs.test.ts`: セクション表示、検索、ファイル読み込みエラー、存在しないセクション指定時のエラー
- `tests/unit/config/github-links.test.ts`: URL 定数の検証

---

### NTH-2: PreflightChecker.getInstallHint() への gh CLI ヒント追加

**カテゴリ**: 影響ファイル
**場所**: `src/cli/utils/preflight.ts` (line 135-145)

**問題**:
`PreflightChecker.getInstallHint()` の hints マップに gh CLI のインストールヒントが含まれていない。

**推奨対応**:
影響ファイルに `src/cli/utils/preflight.ts` を追加し、hints に以下を追加する:
```typescript
'gh': 'Install with: brew install gh (macOS) or visit https://cli.github.com/'
```

---

### NTH-3: GitHub URL の一元管理設計

**カテゴリ**: 移行考慮

**問題**:
GitHub URL が現在3箇所に分散しており、Issue #264 で更に追加される:
- `src/lib/version-checker.ts`: `GITHUB_API_URL`, `GITHUB_RELEASE_URL_PREFIX`
- `src/cli/config/security-messages.ts`: security-guide URL
- 新規 `src/config/github-links.ts`: Issue URL 定数

**推奨対応**:
`github-links.ts` に `GITHUB_REPO_BASE_URL = 'https://github.com/Kewton/CommandMate'` を定義し、全ての GitHub URL をこの定数から派生させる設計を検討する。将来のリポジトリ名変更やオーナー変更時の変更箇所を1箇所に集約できる。

---

## 影響範囲マトリクス

### ファイル影響一覧

| ファイル | 変更種別 | 影響度 | 備考 |
|---------|---------|--------|------|
| `src/config/github-links.ts` | 新規作成 | 低 | 定数定義のみ |
| `src/components/worktree/FeedbackSection.tsx` | 新規作成 | 低 | 独立コンポーネント |
| `src/cli/commands/issue.ts` | 新規作成 | 中 | gh CLI 外部依存 |
| `src/cli/commands/docs.ts` | 新規作成 | 中 | ファイルパス解決要検討 |
| `src/cli/config/ai-integration-messages.ts` | 新規作成 | 低 | 定数定義のみ |
| `docs/user-guide/support-and-feedback.md` | 新規作成 | 低 | ドキュメントのみ |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 変更 | 低 | FeedbackSection追加（2箇所） |
| `src/cli/index.ts` | 変更 | 中 | 2コマンド登録 + ヘルプテキスト |
| `src/cli/types/index.ts` | 変更 | 低 | 型定義追加のみ |
| `src/cli/config/cli-dependencies.ts` | 変更 | 低 | gh CLI エントリ追加 |
| `src/cli/commands/init.ts` | 変更 | 低 | ガイドメッセージ追加 |
| `locales/en/worktree.json` | 変更 | 低 | 翻訳キー追加 |
| `locales/ja/worktree.json` | 変更 | 低 | 翻訳キー追加 |
| `package.json` | 変更 | 中 | files フィールドに docs/ 追加が必要 |
| `tests/unit/cli/config/cli-dependencies.test.ts` | 要更新 | 高 | MF-1: 既存テスト破壊 |
| `tests/integration/i18n-translation-keys.test.ts` | 間接影響 | 高 | MF-2: en/ja キー不一致で失敗 |
| `src/lib/version-checker.ts` | 条件付き | 中 | URL定数移設の場合のみ影響 |
| `src/cli/utils/preflight.ts` | 推奨更新 | 低 | installHint 追加 |

### セキュリティ影響

| 領域 | リスク | 対策 |
|------|--------|------|
| FeedbackSection 外部URL | 低 | ハードコード定数 + rel="noopener noreferrer" |
| gh CLI 実行 (issueコマンド) | 中 | execFile/spawnSync 配列引数（shell: true 禁止） |
| docs ファイル読み込み | 低 | セクション名ホワイトリスト管理、パストラバーサル防止 |

### ビルドプロセス影響

| ビルド | 影響 |
|--------|------|
| Next.js ビルド (`npm run build`) | FeedbackSection.tsx, github-links.ts が自動包含 |
| CLI ビルド (`npm run build:cli`) | issue.ts, docs.ts が tsconfig.cli.json の include パターンで自動包含 |
| npm パッケージ配布 | `docs/` を files フィールドに追加する必要あり |

---

## 参照ファイル

### コード
- `tests/unit/cli/config/cli-dependencies.test.ts`: gh CLI 追加で既存テストが影響を受ける
- `tests/integration/i18n-translation-keys.test.ts`: 翻訳キー追加時の en/ja パリティチェック
- `package.json`: files フィールドに docs/ が未包含
- `src/lib/version-checker.ts`: GITHUB_RELEASE_URL_PREFIX 移設の影響元
- `src/cli/index.ts`: issue コマンド名と -i/--issue オプションの命名重複
- `src/cli/utils/preflight.ts`: getInstallHint() への gh CLI ヒント追加
- `src/cli/config/security-messages.ts`: GitHub URL 分散の証拠

### ドキュメント
- `docs/user-guide/commands-guide.md`: スラッシュコマンド専門ガイド（CLI コマンド追記の適切性要検討）
- `docs/user-guide/cli-setup-guide.md`: CLI コマンド追記の代替配置先候補
- `CLAUDE.md`: 新規モジュール情報追記対象
