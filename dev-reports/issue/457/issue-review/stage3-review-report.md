# Issue #457 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-09
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 2 |

Issue #457は更新対象を `README.md` と `docs/ja/README.md` の2ファイルに限定しているが、影響範囲レビューの結果、READMEだけの変更では一貫性を担保できない重要な波及箇所が3件発見された。特に package.json、GitHub About description、トップページUI（src/app/page.tsx）は、ユーザーがプロダクトに最初に接触するタッチポイントであり、旧メッセージングが残るとリポジショニング変更の効果が大幅に減殺される。

---

## Must Fix（必須対応）

### F1: package.json の description がissue-driven表現のまま

**カテゴリ**: 一貫性
**場所**: `package.json` L4 / Issue 更新対象ファイル セクション

**問題**:
package.json の description が `"IDE for issue-driven AI development -- define, plan, and let coding agents execute across Git worktrees"` であり、npmレジストリ（`https://www.npmjs.com/package/commandmate`）の検索結果やパッケージページに直接表示される。READMEを変更しても package.json が旧メッセージのままだと、npmからの流入ユーザーに矛盾したメッセージが表示される。

**推奨対応**:
package.json の description を新しいポジショニングに合わせて更新する。例: `"A local control plane for agent CLIs -- manage Claude Code, Codex, Gemini CLI, and other agents across Git worktrees"`。更新対象ファイルリストに package.json を追加する。

---

### F2: GitHub リポジトリ About description がissue-driven表現のまま

**カテゴリ**: 一貫性
**場所**: GitHub リポジトリ About / Issue 更新対象ファイル セクション

**問題**:
GitHub リポジトリの About が `"Issue-driven AI development IDE for Claude Code and Codex CLI. Run multiple issues in parallel and keep work moving from desktop or mobile."` であり、GitHub検索結果やリポジトリトップページに表示される。READMEの変更だけではこの表示は更新されない。

**推奨対応**:
GitHub リポジトリの About description を新しいポジショニングに合わせて更新する作業を Acceptance Criteria に追加する。`gh repo edit --description "..."` コマンドまたはGitHub UIで更新可能。

---

### F3: トップページUIのサブコピーがissue-driven表現

**カテゴリ**: UI影響
**場所**: `src/app/page.tsx` L23-26

**問題**:
アプリのトップページに以下のコピーがハードコードされている:

```
Stop managing terminal tabs. Start running issue-driven development.
CommandMate helps you refine issues, run them in parallel, switch agents when needed, and keep work moving wherever you are.
```

READMEのリポジショニングを変更してもアプリのランディングページが旧メッセージのままだと、実際にアプリを使用するユーザーに矛盾したメッセージが表示される。

**推奨対応**:
`src/app/page.tsx` のサブコピーを新しいポジショニングに合わせて更新する。更新対象ファイルリストに追加する。

---

## Should Fix（推奨対応）

### F4: package.json keywords にissue-driven-development

**カテゴリ**: 一貫性
**場所**: `package.json` L8

**問題**:
keywords 配列に `"issue-driven-development"` が含まれており、npm検索でのディスカバリに影響する。新しいポジショニングでは `control-plane`、`agent-cli`、`orchestration` 等のキーワードがより適切。

**推奨対応**:
keywords を見直し、新しいポジショニングを反映するキーワードを追加する。既存のキーワードは残しつつ優先度を調整する。

---

### F5: docs/concept.md のCLIツール一覧が古い

**カテゴリ**: ドキュメント波及
**場所**: `docs/concept.md` L134-141

**問題**:
主要機能テーブルの「CLI サポート」が「Claude Code, Codex CLI」のみ記載。現在対応しているGemini CLI、Vibe-Local（Ollama）、OpenCodeが反映されていない。新ポジショニングではマルチエージェントCLI対応がコアバリューになるため、ここが古いと説得力が低下する。

**推奨対応**:
本Issueのスコープ外として別Issueで対応するか、または本Issueの更新対象に含めるか判断をNotesに明記する。

---

### F6: docs/architecture.md 冒頭の表現

**カテゴリ**: ドキュメント波及
**場所**: `docs/architecture.md` L7

**問題**:
冒頭説明が「チャット操作できる開発コンパニオンツール」と記述されており、新ポジショニングの「control plane」トーンと若干異なる。ただし技術ドキュメントのため影響は軽微。

**推奨対応**:
本Issueのスコープ外。architecture.mdは技術ドキュメントであり、マーケティングコピーとは性質が異なるため即時対応は不要。

---

### F7: user-guide がissue-drivenワークフロー前提の構成

**カテゴリ**: ドキュメント波及
**場所**: `docs/user-guide/quick-start.md`

**問題**:
quick-start.mdの開発フローが「Step 1: Issue確認 -> Step 2: 作業計画立案 -> Step 3: TDD実装 -> ...」とissue-drivenワークフローを前提とした順序構成になっている。新ポジショニングではワークフロー機能はオプショナルなセカンダリ機能だが、クイックスタートでは最初に案内される。

**推奨対応**:
Notesセクションにuser-guideドキュメント群がissue-drivenワークフロー前提で書かれている点を記載し、将来的なドキュメント整合性タスクとして認識する。本Issueでの変更は不要。

---

### F8: CHANGELOG に経緯を記録すべき

**カテゴリ**: ドキュメント波及
**場所**: `CHANGELOG.md`

**問題**:
CHANGELOG.md L76に「README repositioned around issue-driven AI development messaging (Issue #433)」という過去の変更記録がある。Issue #457は #433 と逆方向のリポジショニング変更であり、経緯を記録しないとプロジェクトの方向性が追跡困難になる。

**推奨対応**:
Issue #457のPR完了時にCHANGELOGに適切なエントリを追加する。

---

## Nice to Have（あれば良い）

### F9: user-guide 全体のissue-driven前提構成

**カテゴリ**: ドキュメント波及
**場所**: `docs/user-guide/`

workflow-examples.md と commands-guide.md はissue-drivenワークフローのコマンド使用例を中心に構成されているが、機能自体の削除ではなくフレーミング変更のため、ドキュメントの変更は不要。必要に応じて別Issueで対応。

---

### F10: webapp-guide.md の Auto Yes セクション

**カテゴリ**: ドキュメント波及
**場所**: `docs/user-guide/webapp-guide.md` L166-219

webapp-guide.mdのAuto Yesセクションは機能ドキュメントとして適切に記述されており、ヒーロー機能としての提示はしていない。新ポジショニングでのリフレームとは矛盾しない。現状維持で問題ない。

---

## 影響範囲マップ

### 直接影響（更新必須）

| ファイル/リソース | 現在の表現 | 更新内容 |
|-------------------|-----------|---------|
| `README.md` | IDE for issue-driven AI development | Issue本文で定義済み |
| `docs/ja/README.md` | Issue ドリブン AI 開発のための IDE | Issue本文で定義済み |
| `package.json` description | IDE for issue-driven AI development | 新ポジショニングに合わせて更新 |
| GitHub About description | Issue-driven AI development IDE | 新ポジショニングに合わせて更新 |
| `src/app/page.tsx` サブコピー | issue-driven development | 新ポジショニングに合わせて更新 |

### 間接影響（将来対応検討）

| ファイル | 状況 | 対応方針 |
|---------|------|---------|
| `docs/concept.md` | CLIツール一覧が古い | 別Issueで対応 |
| `docs/user-guide/quick-start.md` | issue-driven前提の構成 | 将来対応 |
| `docs/user-guide/workflow-examples.md` | issue-driven前提の構成 | 将来対応 |
| `docs/architecture.md` | 技術ドキュメント、軽微 | 対応不要 |
| `CHANGELOG.md` | PR完了時に追記 | PR作業に含める |

### 影響なし（確認済み）

| ファイル | 確認結果 |
|---------|---------|
| `CLAUDE.md` | プロジェクト概要は既にcontrol plane的表現（「Git worktree管理とClaude CLI/tmuxセッション統合ツール」）。変更不要 |
| `docs/user-guide/webapp-guide.md` | 機能ドキュメントとして適切。矛盾なし |
| `docs/user-guide/cli-setup-guide.md` | CLIセットアップ手順のみ。ポジショニング表現なし |
| `docs/user-guide/cmate-schedules-guide.md` | スケジュール機能ガイドのみ。ポジショニング表現なし |
| `docs/user-guide/agents-guide.md` | エージェント利用ガイドのみ。ポジショニング表現なし |
| `docs/user-guide/commands-guide.md` | コマンド詳細のみ。ポジショニング表現なし |

---

## 参照ファイル

### コード
- `src/app/page.tsx`: トップページのサブコピーに「issue-driven development」表現（L23）
- `package.json`: description（L4）とkeywords（L8）にissue-driven表現

### ドキュメント
- `README.md`: リポジショニング変更の主要対象
- `docs/ja/README.md`: 日本語版の対象
- `docs/concept.md`: CLIツール一覧が古い（別Issue推奨）
- `docs/architecture.md`: 冒頭説明の確認（変更不要）
- `docs/user-guide/quick-start.md`: issue-driven前提の構成（将来対応）
- `CHANGELOG.md`: Issue #433の記録あり（PR時に追記）
