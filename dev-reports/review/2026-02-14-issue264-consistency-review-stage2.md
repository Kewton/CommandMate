# Architecture Review: Issue #264 - Stage 2 整合性レビュー

**Issue**: #264 - ユーザーからの問い合わせリンク
**Focus**: 整合性 (Consistency between design policy and existing implementation)
**Stage**: 2
**Date**: 2026-02-14
**Status**: conditionally_approved
**Score**: 4/5

---

## 1. Executive Summary

Issue #264の設計方針書と既存コードベースの整合性を精査した。全体として設計方針は既存のアーキテクチャパターンを良く理解した上で策定されており、大部分の設計項目は既存実装と整合している。ただし、CLIコマンド登録パターンにおいて既存パターンとの不一致が1件（Must Fix）、i18nキー設計の記述上の問題やテストファイルパスの不整合など5件（Should Fix）が検出された。

主要な整合項目（11項目中10項目が整合）はgithub-links.ts定数設計、FeedbackSectionコンポーネント設計、cli-dependencies拡張、型定義、ExitCode、セキュリティパターンなど全て既存パターンに準拠しており、実装リスクは低い。

---

## 2. 整合性マトリクス

### 2-1. 設計方針と既存実装パターンの整合性

| # | 設計項目 | 設計書の記載 | 既存実装パターン | 整合性 |
|---|---------|------------|----------------|--------|
| 1 | GitHub URL一元管理 (SF-001) | `src/config/github-links.ts` に `GITHUB_REPO_BASE_URL` から全URL派生 | `version-checker.ts` に `GITHUB_RELEASE_URL_PREFIX` ハードコード、`security-messages.ts` にURL文字列ハードコード | OK - 既存分散問題を解消する設計 |
| 2 | FeedbackSection (MF-001) | VersionSectionパターン準拠、className props | `VersionSection.tsx`: `version + className` props、CONS-005パターン | OK |
| 3 | cli-dependencies拡張 (SF-2) | gh CLI エントリ追加 `required: false` | `DEPENDENCIES` 配列に Claude CLI を optional で追加済み | OK - OCP準拠 |
| 4 | CLI型定義 | `IssueCreateOptions / DocsOptions` 追加 | `InitOptions / StartOptions / StopOptions / StatusOptions` が同ファイル | OK |
| 5 | ExitCode方針 | 新規追加なし | `ExitCode` enum に既存6値 | OK |
| 6 | CLIコマンド登録 | `createIssueCommand()` + `addCommand()` | `xxxCommand(options)` 関数 + インライン登録 | **不整合** |
| 7 | 外部リンクセキュリティ | `rel='noopener noreferrer'` | `UpdateNotificationBanner.tsx` line 79 | OK |
| 8 | execFile配列引数 | `shell: true` 禁止 | `preflight.ts` line 25: `spawnSync` 配列引数 | OK |
| 9 | gh CLIテンプレート名 | `"Bug Report"` / `"Feature Request"` / `"Question"` | `.github/ISSUE_TEMPLATE/*.md` front matter `name` フィールド | OK |
| 10 | i18n パリティ保証 | en/ja worktree.json に feedback キー追加 | `i18n-translation-keys.test.ts` が自動検証 | OK |
| 11 | SECTION_MAP パス | 8セクション定義 | `docs/user-guide/` 配下に全ファイル存在 | OK |

### 2-2. 型定義の整合性

| 型 | 設計書の定義 | 既存パターンとの整合性 | 評価 |
|----|------------|---------------------|------|
| `IssueCreateOptions` | `bug?, feature?, question?, title?, body?, labels?` (全optional) | `InitOptions`/`StartOptions`等と同パターン（optional booleanとstring） | OK |
| `DocsOptions` | `section?, search?, all?` | `StatusOptions`（`issue?, all?`）と同パターン | OK |
| `IssueOptions`（不作成） | MF-001 YAGNI対応で事前定義しない | 既存に空interfaceの前例なし | OK - YAGNI準拠 |
| `FeedbackSectionProps` | `className?: string` のみ | `VersionSectionProps: { version: string; className?: string }` と構造差あり | 許容（データ依存性の差異） |

### 2-3. コンポーネントインターフェースの整合性

| コンポーネント | 設計のインターフェース | 参考既存コンポーネント | 整合性 |
|--------------|--------------------|--------------------|--------|
| `FeedbackSection` | `FC<{ className?: string }>` + `useTranslations('worktree')` | `VersionSection`: `FC<{ version: string; className?: string }>` + `useTranslations('worktree')` | OK - CONS-005パターン準拠 |
| FeedbackSection配置(InfoModal) | `<FeedbackSection className="bg-gray-50 rounded-lg p-4" />` | `<VersionSection ... className="bg-gray-50 rounded-lg p-4" />` (line 509) | OK - 完全一致 |
| FeedbackSection配置(Mobile) | `<FeedbackSection className="bg-white rounded-lg border border-gray-200 p-4" />` | `<VersionSection ... className="bg-white rounded-lg border border-gray-200 p-4" />` (line 774) | OK - 完全一致 |
| 外部リンクパターン | `<a href={URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800 underline">` | `UpdateNotificationBanner.tsx` line 76-84 | OK - 完全一致 |

### 2-4. テスト設計と既存テストの整合性

| テストファイル | 設計書のパス | 既存パターン | 差異 |
|--------------|------------|------------|------|
| github-links | `tests/unit/config/github-links.test.ts` | 既存: `tests/unit/cli/config/cli-dependencies.test.ts` (.ts) | OK - 非Reactテストは .ts |
| FeedbackSection | `tests/unit/components/FeedbackSection.test.ts` | 既存: `tests/unit/components/worktree/version-section.test.tsx` (.tsx, worktreeサブディレクトリ, ケバブケース) | **不整合3点**: 拡張子(.ts -> .tsx)、ディレクトリ(components/ -> components/worktree/)、ファイル名(PascalCase -> kebab-case) |
| issue | `tests/unit/cli/commands/issue.test.ts` | 既存: `tests/unit/cli/commands/init.test.ts` | OK |
| docs | `tests/unit/cli/commands/docs.test.ts` | 既存: `tests/unit/cli/commands/init.test.ts` | OK |
| docs-reader | `tests/unit/cli/utils/docs-reader.test.ts` | 既存: `tests/unit/cli/config/cli-dependencies.test.ts` パターン | OK |
| cli-dependencies | 更新 | 既存テスト: 各依存をname検証するパターン | OK |

---

## 3. 詳細指摘事項

### 3-1. Must Fix

#### MF-CONS-001: CLIコマンド登録パターンの不整合

**概要**: 設計方針書 Section 5-3 で提案されているコマンド登録パターンが既存パターンと異なる。

**設計書の記載** (Section 5-3):
```typescript
// src/cli/index.ts
import { createIssueCommand } from './commands/issue';
import { createDocsCommand } from './commands/docs';

program.addCommand(createIssueCommand());
program.addCommand(createDocsCommand());
```

**既存パターン** (`/Users/maenokota/share/work/github_kewton/commandmate-issue-264/src/cli/index.ts`):
```typescript
// 全既存コマンドがこのパターン
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';

program
  .command('init')
  .description('...')
  .option(...)
  .action(async (options) => { await initCommand(options); });
```

**影響**: 実装者が既存コードと設計書の差異に混乱する可能性がある。

**推奨対応**: issueコマンドはサブコマンド（create/search/list）を持つため、技術的にはcommander.jsの`addCommand()`パターンが妥当。この差異が意図的であることを設計書に明記すること。具体的には以下を追記:
- 「既存コマンド（init/start/stop/status）はサブコマンドを持たないためインライン登録パターンを使用。issueコマンドはcreate/search/listサブコマンドを持つため、commander.jsの`Command`サブコマンド方式を採用する。docsコマンドはオプション切替のみのためインライン登録でも可能だが、issueコマンドとの統一性のためaddCommandパターンで統一する。」

---

### 3-2. Should Fix

#### SF-CONS-001: i18n翻訳キー構造の記述上の不一致

**概要**: 設計方針書 Section 4-2 の JSON 例が既存の i18n パターンと異なる表記。

**設計書の記載** (Section 4-2):
```json
{
  "feedback": {
    "title": "Feedback & Support",
    "titleJa": "フィードバック・サポート",
    ...
  }
}
```

**既存パターン** (`locales/en/worktree.json` / `locales/ja/worktree.json`):
各言語ファイルが独立しており、同一キーに対して異なる値を持つ。`titleJa` のような言語サフィックスキーは存在しない。

**推奨対応**: Section 4-2 を以下のように修正:
```
// locales/en/worktree.json に追加
"feedback": { "title": "Feedback & Support", "bugReport": "Report a bug", ... }

// locales/ja/worktree.json に追加
"feedback": { "title": "フィードバック・サポート", "bugReport": "バグを報告", ... }
```

#### SF-CONS-002: FeedbackSectionテストファイル拡張子の不一致

**概要**: 設計書で `.test.ts` だが、既存のReactコンポーネントテストは全て `.test.tsx`。

- **設計書**: `tests/unit/components/FeedbackSection.test.ts`
- **既存パターン**: `tests/unit/components/worktree/version-section.test.tsx`

**推奨対応**: `.test.tsx` に変更。

#### SF-CONS-003: FeedbackSectionテストファイルのディレクトリパス不一致

**概要**: 設計書で `tests/unit/components/` 直下だが、worktreeコンポーネントのテストは `tests/unit/components/worktree/` に配置。

**推奨対応**: `tests/unit/components/worktree/feedback-section.test.tsx` に変更。

#### SF-CONS-004: FeedbackSectionのProps設計の「VersionSectionパターン準拠」記載の曖昧さ

**概要**: 設計書で「VersionSectionパターン（Issue #257 SF-001）に準拠」と記載しているが、FeedbackSectionPropsはclassNameのみ、VersionSectionPropsはversion+classNameで構造が異なる。

**推奨対応**: 「準拠」の範囲を明確化する一文を追記:「CONS-005パターン（className propによる親コンテナスタイル差異吸収）に準拠。FeedbackSectionは外部データ依存がないため、Props設計はclassNameのみの最小構成とする。」

#### SF-CONS-005: CLIコマンドのログ出力パターンの未明記

**概要**: 設計方針書のdocsコマンドコード例で`console.log`を直接使用しているが、既存コマンドではCLILoggerとconsole.logが混在。設計方針書でどちらを採用するか明記されていない。

- `init.ts` / `start.ts` / `stop.ts`: `CLILogger` 使用
- `status.ts`: `console.log` 直接使用

**推奨対応**: issue/docsコマンドのログ出力方針を設計書に追記。データ出力のみのコマンド（status, docs, issue list）はconsole.log直接使用、操作実行コマンド（init, start, stop, issue create）はCLILogger使用のような方針を明記。

---

### 3-3. Consider

#### C-CONS-001: テストファイル命名規則の統一

既存のworktreeコンポーネントテストはケバブケース（`version-section.test.tsx`）を使用。設計書のパスカルケース（`FeedbackSection.test.ts`）との不統一。ケバブケースへの統一を推奨するが強制ではない。

#### C-CONS-002: tsconfig.cli.json のcross-boundary importの挙動補足

設計方針書 Section 6-2 で cross-boundary import の前例を示しているが、`tsconfig.cli.json` の `include: src/cli/**/*` と `rootDir: ./src` の関係による挙動を補足すると、実装者の理解が深まる。`include` はエントリポイントの指定であり、`rootDir` 配下のファイルは依存解決で自動的にコンパイル対象に含まれる。

#### C-CONS-003: SECTION_MAP定義箇所の重複記載

設計方針書 Section 3-5 では `SECTION_MAP` を `docs.ts` 内に定義しているが、Section 3-6 の SF-003 対応で `docs-reader.ts` に移動している。Section 3-5 のコード例が古い情報のまま残っており、混乱を招く可能性がある。Section 3-5 のコメントに「実際の定義箇所は Section 3-6 の docs-reader.ts を参照」と追記するか、Section 3-5 のコード例を docs-reader.ts からの import に修正すること。

---

## 4. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | CLIコマンド登録パターンの差異により実装者が混乱する可能性 | Low | Medium | P2 |
| テスト整合性 | テストファイルパス・拡張子の不整合によりCI失敗の可能性 | Low | Medium | P2 |
| i18n整合性 | 翻訳キー記載の曖昧さによる実装ミスの可能性 | Low | Low | P3 |
| セキュリティリスク | 全セキュリティ設計項目が既存パターンに準拠 | N/A | N/A | N/A |
| 運用リスク | package.json files フィールドへの docs/ 追加によるパッケージサイズ増加 | Low | High (確実) | P3 |

---

## 5. 整合性スコア詳細

| 評価カテゴリ | スコア | コメント |
|------------|--------|---------|
| 設計パターン整合性 | 4/5 | CLIコマンド登録パターンに1件の不整合。他は全て既存パターンに準拠。 |
| 型定義整合性 | 5/5 | IssueCreateOptions/DocsOptions は既存 Options 型パターンに完全準拠。 |
| コンポーネントIF整合性 | 5/5 | FeedbackSection の Props、配置位置、スタイルパターンは VersionSection に準拠。 |
| テスト設計整合性 | 3/5 | FeedbackSection テストのパス・拡張子・命名規則に複数の不整合。 |
| セキュリティ整合性 | 5/5 | 全セキュリティ項目（SSRF、XSS、コマンドインジェクション、パストラバーサル）が既存パターン準拠。 |
| **総合スコア** | **4/5** | |

---

## 6. 承認状況

**Status**: conditionally_approved

**条件**:
1. MF-CONS-001（CLIコマンド登録パターンの差異説明）を設計書に追記すること
2. SF-CONS-002, SF-CONS-003（テストファイルパスの修正）を設計書に反映すること

上記条件を満たせば、設計方針書に基づく実装を開始して問題ない。

---

*Generated by architecture-review-agent (Stage 2: Consistency Review) at 2026-02-14*
