# Issue #264 レビューレポート

**レビュー日**: 2026-02-14
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目（Stage 1）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 4 |

Issue #264 は5つの機能（UIフィードバックリンク、CLIのissueコマンド、AIツール連携ガイド、docsコマンド、ドキュメント整備）を包括する大きなIssueです。全体的に要件は具体的に記述されていますが、既存コードベースとの整合性や実装タスクの網羅性にいくつかの問題が確認されました。

---

## Must Fix（必須対応）

### MF-1: gh CLIが依存関係に未登録

**カテゴリ**: 整合性
**場所**: 提案する解決策 > (2)CLIにissueコマンドを追加 / 実装タスク

**問題**:
`commandmate issue` コマンドは `gh` CLI に依存しますが、`src/cli/config/cli-dependencies.ts` にはghが登録されていません。現在の依存関係リストには Node.js, npm, tmux, git, Claude CLI のみが定義されています。

**証拠**:
- `src/cli/config/cli-dependencies.ts` (line 12-44): DEPENDENCIES配列にghが存在しない
- issueコマンドは `gh issue create`, `gh issue list`, `gh issue search` を内部で呼び出す設計

**推奨対応**:
1. 実装タスクに「`src/cli/config/cli-dependencies.ts` に gh CLI を追加（`required: false`）」を追加する
2. gh CLIが未インストールの場合のフォールバック動作（わかりやすいエラーメッセージとインストール手順の表示）を受入条件に含める

---

### MF-2: Issueタイトルに誤字

**カテゴリ**: 正確性
**場所**: Issueタイトル

**問題**:
Issueタイトルが「ユーザのからの問い合わせリンク」となっていますが、「の」が余分です。

**推奨対応**:
タイトルを「ユーザーからの問い合わせリンク」に修正してください。

---

### MF-3: CLIコマンドのi18n方針が未定義

**カテゴリ**: 完全性
**場所**: 受入条件 / 実装タスク > CLIコマンド

**問題**:
受入条件に「i18n対応（英語/日本語）が完了している」とありますが、これがUI側のみなのかCLI側も含むのかが不明確です。

**証拠**:
- 既存CLIコマンド（`src/cli/commands/init.ts`, `start.ts`, `stop.ts`, `status.ts`）は全て英語ハードコードで出力している
- CLIでnext-intlを利用するのは技術的に大きなアーキテクチャ変更が必要

**推奨対応**:
受入条件のi18n項目を「UI側のi18n対応（英語/日本語）が完了している。CLIコマンドの出力は既存コマンドと同様に英語固定とする」のように明確化する。

---

## Should Fix（推奨対応）

### SF-1: docsコマンドの対象ドキュメントリストが不完全

**カテゴリ**: 明確性
**場所**: 提案する解決策 > (4)ドキュメント取得コマンド > 対象ドキュメント

**問題**:
`docs/user-guide/` 配下に6ファイルが存在しますが、Issueの対象リストには4ファイルしか含まれていません。

**証拠**:
実際に存在するファイル:
- `docs/user-guide/quick-start.md` -- Issueに記載あり
- `docs/user-guide/commands-guide.md` -- Issueに記載あり
- `docs/user-guide/webapp-guide.md` -- Issueに記載あり
- `docs/user-guide/workflow-examples.md` -- Issueに記載あり
- `docs/user-guide/agents-guide.md` -- **欠落**
- `docs/user-guide/cli-setup-guide.md` -- **欠落**

**推奨対応**:
`cli-setup-guide.md` は特にCLI機能に直接関連するため、対象リストに追加すべきです。意図的に除外しているならその理由を記載してください。

---

### SF-2: commandmate issue createのオプション仕様が曖昧

**カテゴリ**: 明確性
**場所**: 提案する解決策 > (2)CLIにissueコマンドを追加

**問題**:
コマンド定義部分では `commandmate issue create --bug` のみが記載されていますが、AI利用例では `commandmate issue create --bug --title "..." --body "..."` と `--title` / `--body` オプションが使われています。コマンドの完全なオプション仕様が不明確です。

**推奨対応**:
以下のようにオプション一覧を明示する:
```
commandmate issue create [options]
  --bug          バグ報告テンプレート
  --feature      機能要望テンプレート
  --question     質問テンプレート
  --title <text> Issueタイトル
  --body <text>  Issue本文
```
また、`--title` / `--body` を省略した場合の動作（対話モードまたはエディタ起動）も明記すると望ましいです。

---

### SF-3: FeedbackSectionの配置箇所の具体性不足

**カテゴリ**: 技術的妥当性
**場所**: 提案する解決策 > (1)UIにフィードバックリンクを追加 / 実装タスク > UI

**問題**:
「InfoModal/MobileInfoContentにFeedbackSectionを組み込み」とありますが、これらはWorktreeDetailRefactored.tsx内のローカルコンポーネント（exportされていない）であり、具体的な配置位置が不明確です。

**証拠**:
- InfoModal: `WorktreeDetailRefactored.tsx` line 346-528 のmemoコンポーネント
- MobileInfoContent: `WorktreeDetailRefactored.tsx` line 609-792 のmemoコンポーネント
- VersionSection使用箇所: InfoModal line 509, MobileInfoContent line 774

**推奨対応**:
「WorktreeDetailRefactored.tsx内のInfoModalコンポーネント（line 509のVersionSectionの下）とMobileInfoContentコンポーネント（line 774のVersionSectionの下）にFeedbackSectionを追加する」のように、VersionSectionの下に配置することを明記する。

---

### SF-4: CLAUDE.mdの更新タスクが欠落

**カテゴリ**: 完全性
**場所**: 実装タスク > ドキュメント

**問題**:
新規CLIコマンド（issue, docs）と新規コンポーネント（FeedbackSection, github-links.ts）の追加に伴い、CLAUDE.mdの更新が必要ですが、実装タスクに含まれていません。

**証拠**:
- CLAUDE.mdのCLIモジュール表にはinit/start/stop/statusのみ記載
- 主要機能モジュール表にFeedbackSectionやgithub-linksの記載はない
- 過去のIssue実装時にはCLAUDE.mdの更新が慣例的に行われている

**推奨対応**:
実装タスクのドキュメントセクションに以下を追加:
- CLAUDE.mdのCLIモジュール表に `src/cli/commands/issue.ts` と `src/cli/commands/docs.ts` を追記
- CLAUDE.mdの主要機能モジュール表に `src/config/github-links.ts` と `src/components/worktree/FeedbackSection.tsx` を追記

---

### SF-5: GitHub Issue URL生成の正確性テストが受入条件に欠落

**カテゴリ**: 受け入れ条件
**場所**: 受入条件

**問題**:
UIのフィードバックリンクが正しいGitHub Issue URLを生成するかの検証条件がありません。テンプレートパラメータのフォーマットが正しくないと、リンク先でテンプレートが適用されません。

**証拠**:
- `.github/ISSUE_TEMPLATE/` 配下のテンプレートファイル名: `bug_report.md`, `feature_request.md`, `question.md`
- GitHub Issue URLのテンプレート形式: `https://github.com/Kewton/CommandMate/issues/new?template=bug_report.md`

**推奨対応**:
受入条件に「GitHub Issue URLが正しいテンプレートパラメータ（`template=bug_report.md` 等）で生成され、クリック時にテンプレートが適用されること」を追加する。

---

## Nice to Have（あれば良い）

### NTH-1: docsコマンドの対象にagents-guide.mdを追加

**場所**: 提案する解決策 > (4)ドキュメント取得コマンド > 対象ドキュメント

`docs/user-guide/agents-guide.md` はClaude Code/Codexユーザーにとって有用なドキュメントです。docsコマンドの主要ユースケースがAIツール連携であることを考えると、対象リストへの追加が望ましいです。

---

### NTH-2: 既存のGitHub URL定数との一元管理方針

**場所**: 実装タスク > UI > src/config/github-links.ts

`src/lib/version-checker.ts` に既に `GITHUB_RELEASE_URL_PREFIX = 'https://github.com/Kewton/CommandMate/releases/'` が定義されています。新規の `src/config/github-links.ts` との関係（リポジトリURLベースを共通化するか、別管理とするか）を検討・明記するとよいです。

---

### NTH-3: commandmate --helpのAI Tool Integrationセクションの実装方法

**場所**: 提案する解決策 > (2) > --helpの出力イメージ

commanderライブラリで `--help` の出力にカスタムセクション（「AI Tool Integration」）を追加する方法は `program.addHelpText('after', ...)` APIが適しています。実装方針があらかじめ決まっていると実装者にとって有用です。

---

### NTH-4: 関連Issue #124へのリンク

**場所**: Issue本文

Issue #124「メッセージとドキュメントの英語対応」はi18n対応に関連しており、本Issueのi18n要件と関連があります。関連Issueとしてリンクを追加するとコンテキストが明確になります。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | FeedbackSectionの組み込み先（InfoModal: line 509, MobileInfoContent: line 774のVersionSectionの下に配置） |
| `src/components/worktree/VersionSection.tsx` | FeedbackSectionの隣接コンポーネント（className propsパターンの参照） |
| `src/cli/index.ts` | issue/docsコマンドの登録先（commanderベースの既存パターン） |
| `src/cli/types/index.ts` | IssueOptions/DocsOptions型の追加先 |
| `src/cli/config/cli-dependencies.ts` | gh CLIの依存関係登録先（MF-1: 現在未登録） |
| `src/cli/commands/init.ts` | AIツール連携ガイドの追加先（line 244-253のNext stepsセクションの後） |
| `src/lib/version-checker.ts` | 既存GitHub URL定数の参照（NTH-2） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `.github/ISSUE_TEMPLATE/bug_report.md` | UIフィードバックリンクのテンプレート参照先（存在確認済み） |
| `.github/ISSUE_TEMPLATE/feature_request.md` | UIフィードバックリンクのテンプレート参照先（存在確認済み） |
| `.github/ISSUE_TEMPLATE/question.md` | UIフィードバックリンクのテンプレート参照先（存在確認済み） |
| `docs/user-guide/commands-guide.md` | issue/docsコマンドの追記先 |
| `docs/user-guide/cli-setup-guide.md` | docsコマンド対象リストからの欠落候補（SF-1） |
| `docs/user-guide/agents-guide.md` | docsコマンド対象リストからの欠落候補（NTH-1） |
| `CLAUDE.md` | 新規モジュール情報の追記が必要（SF-4） |

---

*Generated at 2026-02-14 by issue-review-agent (Stage 1: 通常レビュー)*
