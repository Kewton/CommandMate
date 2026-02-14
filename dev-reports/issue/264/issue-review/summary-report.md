# Issue #264 マルチステージレビュー完了報告

## レビュー日時
- 開始: 2026-02-14
- 完了: 2026-02-14

## 仮説検証結果（Phase 0.5）

| # | 仮説/主張 | 判定 |
|---|----------|------|
| - | 仮説なし（機能追加Issue） | スキップ |

**概要**: Issue #264 は新機能追加の提案であり、バグ修正や問題分析ではないため、コードベースと照合すべき仮説・原因分析・前提条件の記述が含まれていない。仮説検証フェーズはスキップ。

## ステージ別結果

| Stage | レビュー種別 | 指摘数 | 対応数 | ステータス |
|-------|------------|-------|-------|----------|
| 0.5 | 仮説検証 | - | - | ⏭️ スキップ（仮説なし） |
| 1 | 通常レビュー（1回目） | 12 | - | ✅ |
| 2 | 指摘事項反映（1回目） | - | 12 | ✅ |
| 3 | 影響範囲レビュー（1回目） | 9 | - | ✅ |
| 4 | 指摘事項反映（1回目） | - | 9 | ✅ |
| 5 | 通常レビュー（2回目） | 6 | - | ✅ |
| 6 | 指摘事項反映（2回目） | - | 6 | ✅ |
| 7 | 影響範囲レビュー（2回目） | 5 | - | ✅ |
| 8 | 指摘事項反映（2回目） | - | 5 | ✅ |

## 統計

- **総指摘数**: 32件
  - Stage 1: Must Fix 3件, Should Fix 5件, Nice to Have 4件
  - Stage 3: Must Fix 2件, Should Fix 4件, Nice to Have 3件
  - Stage 5: Must Fix 1件, Should Fix 3件, Nice to Have 2件
  - Stage 7: Must Fix 1件, Should Fix 2件, Nice to Have 2件
- **対応完了**: 32件
- **スキップ**: 0件

## 主な改善点

### 1回目イテレーション（Stage 1-4）

**Stage 1: 通常レビュー（1回目）**
1. **gh CLI依存関係の登録**: `cli-dependencies.ts` に gh CLI を `required: false` で追加
2. **Issueタイトルの誤字修正**: "ユーザのからの" → "ユーザーからの"
3. **CLI i18n方針の明確化**: CLI出力は英語固定、UI側のみi18n対応（既存CLIコマンドとの一貫性）
4. **docsコマンド対象ドキュメントリストの完全化**: `cli-setup-guide.md` と `agents-guide.md` を追加
5. **commandmate issue createオプションの明示化**: `--title`, `--body`, `--labels` オプションと `gh issue create` への引数マッピングを定義
6. **FeedbackSection配置の具体化**: InfoModal（line 509付近）/ MobileInfoContent（line 774付近）のVersionSection直下に配置
7. **CLAUDE.md更新タスクの追加**: 新規モジュール情報の追記を実装タスクに含める
8. **GitHub Issue URL生成の正確性テスト**: テンプレートパラメータ（`template=bug_report.md`等）の検証を受入条件に追加

**Stage 3: 影響範囲レビュー（1回目）**
1. **テスト影響範囲の網羅**: `cli-dependencies.test.ts` を変更対象ファイルに追加（gh CLI追加に伴う `getOptionalDependencies` テスト更新）
2. **i18n翻訳キーパリティ対応**: en/ja 両方に同一キー構造で追加する注意事項を明記
3. **docsコマンドのパス解決方針**: `path.join(__dirname, '../../docs/')` でパッケージルートからの相対パス使用、`package.json` の `files` フィールドに `docs/` を追加
4. **GitHub URL一元管理の設計**: `GITHUB_REPO_BASE_URL` 定数を定義し、Issue/Release/Security Guide URLを派生。`GITHUB_RELEASE_URL_PREFIX` は re-export で既存importパス維持
5. **コマンド名と既存オプションの混同防止**: `issue` コマンドと `-i/--issue` オプションの違いをヘルプテキストで明確化
6. **CLIドキュメント配置の適正化**: `commands-guide.md`（スラッシュコマンド専門）ではなく `cli-setup-guide.md` に記載
7. **テスト計画の具体化**: issue.test.ts / docs.test.ts のテスト観点（gh CLI連携モック、テンプレート選択、エラーハンドリング、セクション表示、検索、ファイル読み込みエラー）を明記
8. **preflight.tsへの影響**: `getInstallHint()` に gh CLI用ヒントを追加
9. **GitHub URL分散問題の解消**: `GITHUB_REPO_BASE_URL` から全URLを派生させる設計

### 2回目イテレーション（Stage 5-8）

**Stage 5: 通常レビュー（2回目）**
1. **gh CLI `--template` 引数マッピングの修正**: ファイル名（`bug_report.md`）からテンプレート名（`"Bug Report"`）に修正。gh CLI は front matter の `name` 値で照合
2. **security-messages.tsの影響**: Security Guide URL を `github-links.ts` から派生（cross-boundary import）
3. **gh CLI DependencyCheckエントリの具体化**: `{ name: 'gh CLI', command: 'gh', versionArg: '--version', required: false }` と明示
4. **`-i/--issue` オプション説明の統一**: start/stop/status の3箇所（line 44, 62, 75）すべてで "Specify worktree by issue number" に統一
5. **GITHUB_API_URLのSSRF防止方針**: SEC-001のため `version-checker.ts` 内にハードコード維持、`GITHUB_REPO_BASE_URL` からの派生対象外
6. **テスト影響範囲の正確化**: `tests/unit/lib/version-checker.test.ts`（GITHUB_RELEASE_URL_PREFIXを直接import）を関連ファイルに含める

**Stage 7: 影響範囲レビュー（2回目）**
1. **CLI ビルド cross-boundary import 方針の明示**: 「設計判断」セクション新設。`src/config/github-links.ts` を `src/cli/config/security-messages.ts` から参照する際の `tsconfig.cli.json` スコープ外アクセスについて、`port-allocator.ts` の前例を根拠に設計判断を文書化
2. **version-checker.test.ts 既存テストの保証**: re-export 後も `GITHUB_RELEASE_URL_PREFIX` の既存テスト（line 238-243）が修正なしでパスすることを受入条件に追加
3. **ExitCode方針の明確化**: issue/docs コマンドは既存の `DEPENDENCY_ERROR(1)` / `UNEXPECTED_ERROR(99)` を流用、新規 ExitCode は追加しない。`src/cli/types/index.ts` の ExitCode enum 変更は不要
4. **docsコマンドの `__dirname` パス修正**: `../../docs/` → `../../../docs/`（`dist/cli/commands/` からプロジェクトルートは3階層上）
5. **cli-setup-guide.md セクション構成の明示**: Issue Management / Documentation Access の詳細アウトラインを追加

## Issue差分サマリー

### 追加されたセクション
- **設計判断**: CLI ビルドにおける cross-boundary import 方針（`src/config/github-links.ts` の CLI側からの参照）
- **レビュー履歴**: Stage 1-8 の各段階で反映した指摘事項の詳細記録
- **ExitCode方針**: issue/docs コマンドのエラーコード設計（既存コードの流用、新規追加なし）
- **⑤ドキュメント整備セクションのアウトライン**: `cli-setup-guide.md` への追記セクションの詳細構成

### 修正されたセクション
- **タイトル**: "ユーザのからの問い合わせリンク" → "ユーザーからの問い合わせリンク"
- **①UIにフィードバックリンクを追加**: FeedbackSection配置先の詳細（WorktreeDetailRefactored.tsx内ローカルコンポーネント、line 509 / 774付近）を明記
- **②CLIにissueコマンドを追加**:
  - gh CLI依存関係の登録方針（`cli-dependencies.ts` に `required: false` で追加、未インストール時のエラー処理）
  - DependencyCheckエントリの具体化（`versionArg: '--version'` 含む）
  - `--template` 引数マッピングの修正（ファイル名 → テンプレート名）
  - オプション一覧表の追加（`--bug/--feature/--question/--title/--body/--labels`）
  - コマンド名と `-i/--issue` オプションの混同防止策
  - ExitCode方針（既存コード流用、新規追加なし）
  - CLI出力言語方針（英語固定、UI側のみi18n対応）
- **④ドキュメント取得コマンド**:
  - ドキュメントファイルのパス解決方針（`path.join(__dirname, '../../../docs/')`）
  - `package.json` の `files` フィールドへの `docs/` 追加
  - 対象ドキュメントリストの完全化（`cli-setup-guide.md`, `agents-guide.md` 追加）
- **⑤ドキュメント整備**:
  - CLIドキュメント配置先の変更（`commands-guide.md` → `cli-setup-guide.md`）
  - 詳細セクション構成の追加
- **主要な変更点**:
  - GitHub URL定数一元管理の詳細設計（`GITHUB_REPO_BASE_URL` 定数、`GITHUB_RELEASE_URL_PREFIX` re-export、`GITHUB_API_URL` SSRF防止ハードコード維持）
  - cross-boundary import の設計判断追加
- **実装タスク**:
  - UI: `github-links.ts` の詳細設計（`GITHUB_REPO_BASE_URL` 派生、re-export、SSRF防止）
  - CLI: gh CLI依存登録、preflight.ts ヒント追加、`--template` テンプレート名指定、ExitCode方針、cross-boundary import 動作確認
  - テスト: `cli-dependencies.test.ts` 更新、issue.test.ts / docs.test.ts テスト観点具体化
  - ドキュメント: `cli-setup-guide.md` への追記（詳細アウトライン）、CLAUDE.md 更新
- **受入条件**:
  - gh CLI未インストール時のエラー処理（`DEPENDENCY_ERROR(1)`）
  - `--template` テンプレート名指定の正確性
  - コマンドインジェクション防止（`shell: true` 不使用）
  - i18n翻訳キーパリティ（en/ja同一構造）
  - GitHub URL一元管理（`GITHUB_REPO_BASE_URL` 派生、`GITHUB_API_URL` 対象外）
  - version-checker.test.ts 既存テスト保証（re-export 後も修正なしでパス）
  - cross-boundary import 動作確認（`npm run build:cli` 正常完了）
  - `cli-setup-guide.md` セクション整備
- **影響範囲 > 変更対象ファイル**:
  - `src/config/github-links.ts` の詳細設計追記
  - `src/cli/config/security-messages.ts` の追加
  - `src/cli/commands/issue.ts` / `docs.ts` の詳細仕様追記
  - `package.json` (`files` に `docs/` 追加)
  - ExitCode enum 変更不要の明記
- **影響範囲 > テストファイル**:
  - `cli-dependencies.test.ts` 更新内容の詳細化
  - `issue.test.ts` / `docs.test.ts` テスト観点の具体化
- **影響範囲 > 関連コンポーネント**:
  - `tests/unit/lib/version-checker.test.ts` の追加（re-export 影響確認）
  - `tsconfig.cli.json` の cross-boundary import 前例記載
- **関連Issue**: Issue #124（i18n対応）へのリンク追加

## 次のアクション

- [x] Issueの最終確認
- [ ] 設計方針書の確認・作成（`/design-policy 264`）
- [ ] マルチステージ設計レビュー（`/multi-stage-design-review 264`）
- [ ] 作業計画立案（`/work-plan 264`）
- [ ] TDD実装開始（`/pm-auto-dev 264`）

## 関連ファイル

- 元のIssue: `dev-reports/issue/264/issue-review/original-issue.json`
- 仮説検証: `dev-reports/issue/264/issue-review/hypothesis-verification.md`
- レビュー結果:
  - `dev-reports/issue/264/issue-review/stage1-review-result.json`
  - `dev-reports/issue/264/issue-review/stage3-review-result.json`
  - `dev-reports/issue/264/issue-review/stage5-review-result.json`
  - `dev-reports/issue/264/issue-review/stage7-review-result.json`
- 反映結果:
  - `dev-reports/issue/264/issue-review/stage2-apply-result.json`
  - `dev-reports/issue/264/issue-review/stage4-apply-result.json`
  - `dev-reports/issue/264/issue-review/stage6-apply-result.json`
  - `dev-reports/issue/264/issue-review/stage8-apply-result.json`
- 更新されたIssue: https://github.com/Kewton/CommandMate/issues/264

---

*Generated by multi-stage-issue-review command at 2026-02-14*
