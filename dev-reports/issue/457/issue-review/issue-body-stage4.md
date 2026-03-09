> **Note**: このIssueは 2026-03-09 にレビュー結果（Stage 3: 影響範囲レビュー）を反映して更新されました。
> 詳細: dev-reports/issue/457/issue-review/

## Summary

現在のREADMEのメッセージングは、CommandMateを実際よりもオピニオネーテッドに見せている。
最も強い価値は「issue-driven AI development」という必須ワークフローではなく、以下の点にある：

- 複数のエージェントCLIセッション管理
- Git worktreeによる作業分離
- diffとプロンプトのレビュー
- ブラウザ・モバイルからのセッション監視

プロダクトをこのコアバリューを中心にリポジショニングし、ワークフロー重視のメッセージングはページ下部に移動する。

## Problem

現在のREADMEとトップレベルのメッセージングは以下をリードにしている：

- `IDE for issue-driven AI development`
- フルの構造化ワークフロー
- `Auto Yes`のような自動化コンセプト

これにより3つの問題が生じている：

1. CommandMateが独自のワーキングスタイルを要求するように見える
2. フルIDEとの比較を招く（エージェントCLIマネージャーではなく）
3. 最も広く有用な価値（既存CLIツールのオーケストレーション・監視・レビュー）が隠れる

**補足（セクション構成の観点）**: README全体のセクション構成において、Issue-Driven DevelopmentセクションがKey Featuresセクションの前に配置されている点が主な構造的問題である。Key Featuresテーブル内の並び自体は Git Worktree Sessions と Multi-Agent Support が1-2番目に配置されており、テーブル内の順序は適切である。

## Proposed Direction

CommandMateを以下としてリフレーム：

> A local control plane for agent CLIs

**プライマリメッセージ：**
- 既存のエージェントCLIと連携
- 1セッション = 1 worktree
- ブラウザ/モバイルから監視・介入
- tmuxにアタッチせずプロンプトとdiffをレビュー
- 完全ローカル

**セカンダリメッセージ：**
- Issue精査・計画・実装・受入チェックのオプショナルなワークフローテンプレート

## Concrete Changes

### 1. ヒーローコピーの書き換え

**Replace:**
```
CommandMate is an IDE for issue-driven AI development.
```

**推奨案（採用）:**
```
CommandMate is a local control plane for agent CLIs.
```

**代替案（PRレビュー時に検討可）:**
```
Manage Claude Code, Codex, Gemini CLI, and other agent CLIs across Git worktrees.
```

サブコピー案：
```
CommandMate adds orchestration and visibility on top of your existing agent CLIs.
It does not replace tmux, Git worktrees, or your terminal. It makes them easier to manage at scale.
```

### 2. バリュープロポジションの順序変更

**上部に配置（広いマーケット向け管理価値）：**
1. Parallel worktree sessions
2. Multi-agent CLI support
3. Prompt handling and session monitoring
4. Diff review and file inspection
5. Browser and mobile access

**下部に移動（パワーユーザー向け拡張）：**
6. Scheduled execution
7. Advanced workflow automation
8. Issue-driven workflow
9. Slash-command workflow system
10. Auto-yes

### 3. Auto Yesのリフレーム

ヒーロー機能としての提示をやめ、以下のワーディングに：

`Optional unattended mode for trusted workflows`

理由：
- 信頼が確立する前はリスキーに見える
- ユーザーからコントロールを奪う印象を与える
- オプショナルな上級モードとしてフレームする方が適切

### 4. 互換性の明示的な言語追加

以下のようなコピーを追加：
- `works with your existing terminal workflow`
- `does not replace tmux or Git worktrees`
- `drop down to tmux anytime`
- `adds orchestration and visibility`
- `fully local`

### 5. ワークフローレイヤーを「Optional」セクションに移動

推奨ヘッディング：`Optional Workflow Layer`

```md
## Optional Workflow Layer

If your team wants more structure, CommandMate can also help you standardize
issue refinement, design review, planning, implementation, and acceptance checks.
These workflows build on top of the same CLI sessions and worktrees. They are optional, not required.
```

### 6. Feature Copyの推奨フレーミング

| Feature | Recommended framing |
|---------|---------------------|
| Git Worktree Sessions | Run one agent session per worktree without collisions |
| Multi-Agent Support | Use Claude Code, Codex, Gemini CLI, OpenCode, or local models in the same control surface |
| Prompt Review | Detect prompts, answer approvals, and resume sessions without attaching to tmux |
| Diff Review | Inspect commit history and diffs before accepting agent output |
| Browser and Mobile Access | Check progress and intervene from anywhere on your local network |
| Auto Yes | Optional unattended mode for trusted flows |
| Scheduled Execution | Run recurring tasks or queued agent jobs automatically |

**日本語訳について**: Feature Copyの日本語訳は実装者に委ねる。英語コピーのニュアンスを維持しつつ、日本語READMEの既存トーンに合わせて翻訳すること。

### 7. ポジショニングガードレール

**一貫して伝えるべきこと：**
- 既存CLIと連携する
- ターミナルを置き換えない
- 新しい開発哲学を要求しない
- 上級ワークフロー機能はオプショナル
- いつでもtmuxとネイティブCLIにフォールバック可能

**リードで避けるべき表現：**
- `IDE`
- `the center of your development workflow`
- `issue-driven AI development` をプライマリラベルとして
- `no babysitting`（信頼確立前）

## 更新対象ファイル

| ファイル | 更新内容 |
|---------|---------|
| `README.md` | ヒーローコピー、バリュープロポジション順序、Auto Yesリフレーム、互換性言語追加、ワークフローセクション移動 |
| `docs/ja/README.md` | 上記と同等の日本語版更新（下記の日本語版固有の注意事項を参照） |
| `package.json` | descriptionフィールドを新しいポジショニングに合わせて更新（例: "A local control plane for agent CLIs -- manage Claude Code, Codex, Gemini CLI, and other agents across Git worktrees"）。keywordsに "agent-cli-manager", "control-plane" 等を追加検討 |
| `src/app/page.tsx` | トップページのサブコピー（L23-26）を新しいポジショニングに合わせて更新。現在の「Stop managing terminal tabs. Start running issue-driven development.」を変更 |

**CLAUDE.mdについて**: CLAUDE.mdのプロジェクト概要「説明」フィールド（現在: 「Git worktree管理とClaude CLI/tmuxセッション統合ツール」）は既にcontrol plane的な表現であり、本Issueでの変更は不要。

## Acceptance Criteria

- [ ] READMEのヒーローが `IDE for issue-driven AI development` でリードしなくなっている
- [ ] ヒーローコピーとして `A local control plane for agent CLIs` を採用する（代替案を採用する場合はPRレビュー時に合意を得ること）
- [ ] READMEトップセクションが既存エージェントCLIとの連携を明示している
- [ ] ワークフロー重視のメッセージングがコアセッション管理価値の下に移動している
- [ ] Auto Yesがヒーローレベルのポジショニングから降格している
- [ ] READMEにtmux/CLIとの互換性・フォールバック言語が含まれている
- [ ] 日本語README（docs/ja/README.md）も同様に更新されている
- [ ] package.jsonのdescriptionが新しいポジショニングと一致している
- [ ] package.jsonのkeywordsが新しいポジショニングを反映している（"agent-cli-manager", "control-plane" 等の追加）
- [ ] src/app/page.tsxのランディングページコピーが新しいポジショニングと一致している
- [ ] GitHubリポジトリのAbout descriptionが新しいポジショニングに更新されている（`gh repo edit` またはGitHub UIで更新）
- [ ] CHANGELOGに本Issue対応のエントリが追加されている（例: "README repositioned from issue-driven IDE to agent CLI control plane (Issue #457)"）

## Notes

- これはポジショニング/ドキュメントのIssueであり、上級ワークフロー機能の削除を求めるものではない
- 推奨は順序とフレーミングの変更であり、プロダクトスコープの縮小ではない
- CLAUDE.mdのプロジェクト概要は既にcontrol plane的な表現（「Git worktree管理とClaude CLI/tmuxセッション統合ツール」）であり、変更不要
- **日本語READMEの注意事項**: 日本語README（docs/ja/README.md）のKey Featuresテーブルでは1番目が「Issue ドリブンコマンド」であり、英語版（1番目: Git Worktree Sessions）と構成が異なっている。日本語版の更新では、英語版と同様にセッション管理系機能を上位に配置する構造変更が必要となり、英語版より作業範囲が広くなる可能性がある
- **GitHubリポジトリのAbout description**: 現在「Issue-driven AI development IDE for Claude Code and Codex CLI. Run multiple issues in parallel and keep work moving from desktop or mobile.」となっており、READMEと同様に新しいポジショニングに合わせて更新が必要。`gh repo edit --description "..."` またはGitHub UIで対応可能
- **docs/concept.md**: 主要機能テーブル（L134-141）のCLIサポート一覧が古い（Claude Code, Codex CLIのみ記載）。Gemini CLI, Vibe-Local, OpenCode が反映されていないが、本Issueの直接スコープ外のため、別Issueで対応を検討する
- **user-guideドキュメント群**: quick-start.md等のユーザーガイドはissue-drivenワークフロー前提で構成されている。機能自体の削除ではなくフレーミング変更のため即時対応は不要だが、将来的なドキュメント整合性タスクとして認識しておく

---

## レビュー履歴

### Stage 1-2: 通常レビュー + 影響範囲レビュー 1回目 (2026-03-09)
- Issueの基本構造・Acceptance Criteria・更新対象ファイルを整備

### Stage 3-4: 影響範囲レビュー + 指摘事項反映 (2026-03-09)
- F1 (must_fix): package.jsonのdescription更新を更新対象ファイルとAcceptance Criteriaに追加
- F2 (must_fix): GitHubリポジトリのAbout description更新をAcceptance CriteriaとNotesに追加
- F3 (must_fix): src/app/page.tsxのランディングページコピー更新を更新対象ファイルとAcceptance Criteriaに追加
- F4 (should_fix): package.jsonのkeywords更新をAcceptance Criteriaに追加
- F5 (should_fix): docs/concept.mdのCLIツール一覧が古い点をNotesに記載（別Issue対応）
- F7 (should_fix): user-guideドキュメント群のissue-driven前提構成をNotesに記載（将来タスク）
- F8 (should_fix): CHANGELOG更新をAcceptance Criteriaに追加
- F6 (should_fix): docs/architecture.mdは技術ドキュメントのため即時対応不要（スキップ）
- F9 (nice_to_have): user-guideドキュメントの構成変更は本Issue対象外（スキップ）
- F10 (nice_to_have): webapp-guide.mdのAuto Yesセクションは現状維持で問題なし（スキップ）
