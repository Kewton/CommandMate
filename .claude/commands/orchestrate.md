---
model: sonnet
description: "複数Issueを並列オーケストレーション（準備→開発→PR→マージ→UAT→修正ループ→完了）"
---

# 並列Issueオーケストレーション

## 概要
developブランチをオーケストレーターとして、複数Issueの並列開発からUAT合格までの全ライフサイクルを統括します。各Issueはfeatureブランチのworktreeで並列に開発され、commandmatedev CLIで制御します。

**原則**: オーケストレーターはコードに触れない。制御と判断のみ。

## 使用方法
- `/orchestrate [Issue番号1] [Issue番号2] ...`
- `/orchestrate [Issue番号1] [Issue番号2] --phase design` （設計フェーズまで）
- `/orchestrate [Issue番号1] [Issue番号2] --phase impl` （実装まで）
- `/orchestrate [Issue番号1] [Issue番号2] --full` （UAT合格まで全自動）

## 前提条件
- developブランチ上で実行すること
- CommandMateサーバーが稼働していること（`commandmatedev ls` で確認）
- GitHubリポジトリ（https://github.com/Kewton/CommandMate）にアクセス可能
- **契約系フラグが使えること**を最初に確認する。`--contract` / `--verify` は develop 系にのみ存在し、
  v0.16.0 リリースには含まれない。無ければ委任は素の send にフォールバックする（完了判定は目視に戻る）:
  ```bash
  commandmatedev send --help | grep -q -- --contract && commandmatedev wait --help | grep -q -- --verify \
    && echo "contract delegation: available" || echo "contract delegation: UNAVAILABLE (fallback to plain send)"
  ```
- 委任先リポジトリに `.commandmate/verify.yaml` があること（無ければ `/cmate-verify` で起案する）

## 実行内容

あなたはプロジェクトマネージャーとして、複数Issueの並列開発を統括します。

### パラメータ
- **issue_numbers**: 開発対象のIssue番号（スペース区切り、2つ以上）
- **--phase**: 実行範囲の制限（design, impl, pr, uat）。省略時はPRマージまで
- **--full**: UAT合格まで全自動で実行

---

## Phase 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Phase 1: 依存関係分析・実行計画（ラベル分類含む）
- [ ] Phase 2: Worktree準備・実行契約の起案
- [ ] Phase 2.5: 根本原因分析（バグIssueのみ、他エージェント経由）
- [ ] Phase 3: 並列開発（契約付き send → wait --verify）
- [ ] Phase 4: 設計突合（バリア）
- [ ] Phase 5: 品質確認
- [ ] Phase 6: PR作成・マージ（/pr-merge-pipeline）
- [ ] Phase 7: UAT（--full時のみ）
- [ ] Phase 8: 完了報告
```

**重要（エージェント指定ルール）**: `commandmatedev send` でワーカーにタスクを送信する際のエージェント指定は以下に従うこと：
- **開発タスク**（`/pm-auto-issue2dev`, `/bug-fix` 等）: `--agent claude` を指定
- **レビュー系**（仕様レビュー、設計レビュー等）: 一部 `--agent codex` に依頼可
- **バグ根本原因分析**（Phase 2.5）: `--agent copilot --model claude-opus-4.6` を指定

---

## Phase 1: 依存関係分析・実行計画

### 1-1. Issue情報の取得

各Issueの詳細を取得：

```bash
for issue_num in {issue_numbers}; do
  gh issue view "$issue_num" --repo Kewton/CommandMate --json number,title,body,labels
done
```

### 1-2. Issue種別の分類

各Issueのラベルを確認し、バグと機能追加を分類する：

```bash
for issue_num in {issue_numbers}; do
  labels=$(gh issue view "$issue_num" --repo Kewton/CommandMate --json labels -q '[.labels[].name] | join(",")')
  if echo "$labels" | grep -q "bug"; then
    echo "BUG: #${issue_num}"
  else
    echo "FEATURE: #${issue_num}"
  fi
done
```

分類結果を記録し、Phase 2.5 と Phase 3 で使用する：
- **BUG_ISSUES**: `bug` ラベルを持つIssue → Phase 2.5（根本原因分析）+ Phase 3（/bug-fix）
- **FEATURE_ISSUES**: それ以外 → Phase 3（/pm-auto-issue2dev）

### 1-3. 依存関係の分析

各Issueについて以下を分析：
- **影響ファイル**: Issue本文の「影響ファイル」セクションから抽出
- **共通ファイル**: 複数Issueが同じファイルを変更する場合のコンフリクトリスク
- **依存関係**: Issue間の前後関係（A の成果物が B の入力になるか）

### 1-4. 並列実行可否の判定

```
独立:     共通ファイルなし → 完全並列
弱依存:   共通ファイルあるが変更箇所が異なる → 並列可（設計突合で確認）
強依存:   A の出力が B の入力 → 直列実行（A完了後にB開始）
```

### 1-5. 実行計画の記録

```bash
DATE=$(date +%Y-%m-%d)
mkdir -p workspace/orchestration/runs/$DATE
```

実行計画を `workspace/orchestration/runs/$DATE/plan.md` に出力：
- 対象Issue一覧
- 依存関係グラフ
- 並列実行グループ
- マージ推奨順序

---

## Phase 2: Worktree準備

### 2-1. 既存worktreeの確認

```bash
commandmatedev ls --branch feature/
```

### 2-2. 不足worktreeの作成

各Issueについて、対応するworktreeが存在しない場合は作成：

```bash
# /worktree-setup を使用
/worktree-setup {issue_numbers}
```

または手動で:

```bash
git worktree add -b "feature/{N}-worktree" "../commandmate-issue-{N}" develop
cd "../commandmate-issue-{N}" && npm install
```

### 2-3. CommandMateへの登録確認

```bash
curl -s -X POST http://localhost:3000/api/repositories/sync
commandmatedev ls --branch feature/
```

全worktreeが表示されることを確認。

### 2-4. 実行契約の起案

各Issueについて、オーケストレーターが実行契約 `.commandmate/tasks/issue-<N>.yaml` を起案し、
**対象 worktree の中に**配置する。正準仕様は `docs/design/task-contract.md`（v1）、見本は
`.commandmate/tasks/example.yaml`。

```yaml
version: 1
title: "Issue #<N>: <Issueタイトル>"
goal: |
  https://github.com/Kewton/CommandMate/issues/<N> を実装する。
  <Issue本文の受入条件チェックリストをそのまま転記する>
scope:
  allow:               # Issueの影響範囲。requireScopeClean が true なら1件以上必須
    - "src/lib/<module>/**"
    - "tests/unit/<module>/**"
    - "docs/module-reference.md"
  deny: []
verify:
  # キーごと省略が既定（= 全ゲート）。時間制約がある時だけ絞る
  gates: [lint, typecheck, unit]
success:
  requireWorkEvidence: true
  requireScopeClean: true
```

- **契約は未コミットで配ってよい**。`work-evidence` / `scope` ゲートは変更集合から契約ファイル自身を
  除外する（#1580）ので、契約を置いただけの worktree が「作業済み」に見えることはない。
- `scope.allow` は**Issueが触ると宣言した範囲**を書く。広すぎる allow は scope ゲートを無力化し、
  狭すぎる allow は正当な変更を不合格にする。迷ったら Phase 1 の依存関係分析で洗い出した
  ファイル集合をそのまま使う。
- `verify.gates` を絞ると**絞ったゲートしか裁定しない**。既定（省略）を第一選択にする。

---

## Phase 2.5: 根本原因分析（バグIssueのみ）

Phase 1-2 で `bug` ラベルと分類されたIssueに対して、他エージェント経由で根本原因分析を実行する。
機能Issue（FEATURE_ISSUES）はこのフェーズをスキップする。

### 2.5-1. 他エージェントに分析依頼

**このフェーズは契約を使わない（素の send のまま）。** 分析はコードを変更しない依頼であり、
`--verify` は必ず `work-evidence` ゲートを含む（`--gates` で外そうとしても `wait --verify` は
全ゲート要求になる）ため、成功した分析ほど exit 21 になる。契約付き委任は**変更を伴う委任**にだけ使う。

develop worktree上でバグIssueごとに根本原因分析を実行する：

```bash
WORKTREE_ID="mycodebranchdesk-develop"

for bug_issue in $BUG_ISSUES; do
  ISSUE_BODY=$(gh issue view "$bug_issue" --repo Kewton/CommandMate --json body -q '.body')

  # 必ず --agent copilot 等でclaude以外のエージェントを指定
  commandmatedev send "$WORKTREE_ID" "Issue #${bug_issue} の根本原因分析を実施してください。コードを変更せず分析のみ行い、結果をテキストで出力してください。

## Issue内容
${ISSUE_BODY}

## 分析要求
1. 事象の再現パスをコード上で特定
2. 根本原因を特定（直接原因、設計上の問題、類似リスク）
3. 対策案を策定（即座対策、恒久対策、予防策）" \
    --agent copilot --model claude-opus-4.6 --auto-yes --duration 1h

  commandmatedev wait "$WORKTREE_ID" --timeout 3600 --on-prompt agent
  commandmatedev capture "$WORKTREE_ID" --agent copilot
done
```

### 2.5-2. 分析結果のIssue追記

分析結果をオーケストレーターが検証し、Issue本文に追記する：

```bash
gh issue edit "$bug_issue" --repo Kewton/CommandMate --body "${CURRENT_BODY}${ANALYSIS_SECTION}"
```

### 2.5-3. 複数バグIssueの場合

バグIssueが複数ある場合は**順次実行**する（develop worktree 1つで共有するため）。

---

## Phase 3: 並列開発

### 3-1. 各ワーカーにタスク送信（契約付き）

**標準経路は契約付き send。** 契約は Phase 2-4 で worktree に配置済み。
`--contract` は goal を送信メッセージ本文として組み立てるので、**メッセージ引数は渡さない**
（両方渡すと exit 2）。stdout に task id が出るので控える（stderr の `Task created:` は人間向け）。

```bash
for issue in $ISSUES; do
  WT=$(commandmatedev ls --branch "feature/${issue}" --quiet)
  TASK_ID=$(commandmatedev send "$WT" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" \
    --agent claude --auto-yes --duration 3h)
  echo "$issue $WT $TASK_ID" >> "workspace/orchestration/runs/$DATE/tasks.tsv"
done
```

契約の goal だけでは足りない Issue（`/bug-fix` の調査手順、Phase 2.5 の分析結果の参照など）は、
**goal 本文にその指示を書く**。契約は送信メッセージそのものなので、素の send で送っていた文面は
すべて goal に入る。Issue種別ごとのスラッシュコマンド（`/bug-fix`・`/pm-auto-issue2dev`）も
goal の先頭行に書けばよい。

- **スラッシュコマンドは CommandMate リポジトリの worktree でのみ有効**。外部リポジトリの worker に
  送ると `Unknown command` で無反応になる（send は exit 0、composer も空なので気づけない）。
  外部リポジトリには素のプロンプトを書く。
- 独立したIssueは並列で送信する。強依存のIssueは直列実行（先行Issue完了後に送信）。
- **送信後 `started=1`（＝ワーカーが実際に生成を開始したこと）を確認する**。send が exit 0 でも
  composer に本文が残って Enter 未確定のことがある。確認は `commandmatedev capture "$WT"` か
  orchestrate-monitor skill の `classify-state.sh`。

### 3-2. 進捗監視

定期的にステータスを確認：

```bash
commandmatedev ls --branch feature/
```

より詳細な監視は orchestrate-monitor skill を使う。契約付き委任では**タスク状態を一次ソース**に
できるので、`hooks-task.sh` を併せて読み込む:

```bash
MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh \
  --verbose \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-git.sh \
  --hooks .claude/skills/orchestrate-monitor/scripts/hooks-task.sh \
  --session-prefix mcbd-claude \
  --interval 20 --idle-threshold 8 <worktree-id> ... 2>&1 | tee monitor.log
```

**monitor の COMPLETE 判定をマージ可否の裁定に使わないこと。** 裁定は 3-3 の
`wait --verify` の exit code である。

### 3-3. 完了待機と検証（`wait --verify`）

```bash
for each worktree:
  commandmatedev wait "$WT" --on-prompt human --verify --timeout 10800
  echo "exit=$?"
```

- `--on-prompt human` を必ず付ける。既定（`agent`）はプロンプト検出で即 exit 10 を返すため、
  監督ループが空回りする。
- `--verify` は完了検出**後**に全ゲート（`work-evidence` ＋ `scope` ＋ verify.yaml の宣言ゲート）を
  実行し、その結果を exit code にする。ここが「完了したが壊れていた」を目視から exit code へ
  移す一点である。

### 3-4. exit code 分岐

| exit | 意味 | 対応 |
|------|------|------|
| `0` | 完了・検証合格 | Phase 4（設計突合）／Phase 6（マージ）へ進む |
| `20` | 検証不合格（ゲートが落ちた） | 下記「20 の対応」。**再指示は上限2回**、超えたら人間へエスカレーション |
| `21` | 作業証跡ゼロ（未着手） | 下記「21 の対応」 |
| `10` | プロンプト検出 | `commandmatedev capture <WT>` で内容確認 → `commandmatedev respond <WT> "yes"` → 再度 wait |
| `124` | タイムアウト | capture で状況確認 → 追加指示 or ユーザーに報告 |

**20 の対応**（検証不合格）:

```bash
commandmatedev verify "$WT" --json    # 失敗したゲートと exit code を特定
```

失敗ゲートと `logTail` を添えて同じ worker に再指示する（契約は据え置き。再送は素の send でよい）。
再指示は **同一 worktree につき最大2回**。3回目に到達したら worker を止め、ユーザーに判断を仰ぐ。

**21 の対応**（作業証跡ゼロ）: ワーカーは1行も書いていない。ほぼ常に起動側の問題なので capture で切り分ける。

```bash
commandmatedev capture "$WT"
```

- **composer に本文が残っている** → Enter 未確定。`tmux send-keys -t "mcbd-claude-$WT" Enter` で確定させる
  （`commandmatedev respond` は空文字を受け付けず exit 2 になるのでここでは使えない）。
  tmux セッション名は `mcbd-<エージェント>-<worktree-id>` である
- **権限プロンプトで停止** → Enter で承認。monitor.sh に自動承認させる場合は
  `--session-prefix mcbd-claude` を渡すこと（既定の `cm` はこの製品のセッション名と一致しない）
- **セッションが起動していない** → `commandmatedev ls` で存在確認、必要なら再送
- 判別のための知見は orchestrate-monitor skill の STARTED ガード（`verify-completion.sh`）を参照

**`--phase design` 指定時**: 全ワーカーの設計フェーズ完了を確認して終了。

---

## Phase 4: 設計突合（バリア）

弱依存のIssueがある場合、設計書をクロスチェックする。

### 4-1. 各ワーカーの設計書を取得

```bash
commandmatedev capture <worktree-id>
```

各worktreeの `dev-reports/design/issue-{N}-*-design-policy.md` を確認。

### 4-2. クロスチェック観点

- **影響ファイルの重複**: 同じファイルを変更する場合のコンフリクトリスク
- **型定義の整合性**: 共通型への変更が矛盾しないか
- **アーキテクチャの一貫性**: 設計方針が相反しないか
- **モジュール境界**: 新規モジュールの責務が重複しないか

### 4-3. 問題がある場合

該当ワーカーに修正指示を送信：

```bash
commandmatedev send <worktree-id> "設計書の以下の点を修正してください: {具体的な指摘}" \
  --auto-yes --duration 1h
```

修正指示は**契約を作り直さない**（契約は Issue 単位の宣言であり、1往復の指摘ではない）。
指示の反映は次の `wait --verify` で裁定される。

**`--phase impl` 指定時**: 全ワーカーの実装完了を確認して終了。

---

## Phase 5: 品質確認

### 5-1. 検証ゲートの実行

Phase 3 で `wait --verify` が exit 0 を返していれば、そのワーカーの品質は**既に裁定済み**なので
このフェーズは飛ばしてよい。契約無しで委任した場合（`--contract` が使えない CLI など）だけ、
オーケストレーターが直接ゲートを回す:

```bash
for each worktree:
  commandmatedev verify "$WT" --json > "verify-${WT}.json"; echo "exit=$?"
```

**ワーカーに「lint/tsc/test を実行して結果を報告して」と送らないこと。** 報告文の解析は
「全部 Pass です」という散文を信じることであり、`wait --verify` / `verify` の exit code が
置き換えた当のもの。exit code は `0`=合格 / `20`=不合格 / `21`=作業証跡ゼロ。

### 5-2. 品質NGの場合

`--json` の失敗ゲートと `logTail` を添えてワーカーに修正を指示し、再度 `verify`。
最大3回まで自動リトライ。

---

## Phase 6: PR作成・マージ

`/pr-merge-pipeline` コマンドの内容を実行する：

```
/pr-merge-pipeline {issue_numbers}
```

詳細は `/pr-merge-pipeline` コマンドを参照。

**`--phase pr` 指定時**: PR作成・マージ完了を確認して終了。

---

## Phase 7: UAT（--full時のみ）

### 7-1. 受入テスト実行

developブランチ（オーケストレーター自身）で実行：

```bash
git pull origin develop
/uat {issue_numbers}
```

### 7-2. UAT結果判定

- **全PASS**: Phase 8（完了）へ
- **FAILあり**: `/uat-fix-loop` を実行

```
/uat-fix-loop {fail_issue_numbers}
```

詳細は `/uat-fix-loop` コマンドを参照。

---

## Phase 8: 完了報告

### 8-1. 最終検証

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 8-2. 結果レポート

`workspace/orchestration/runs/$DATE/summary.md` に統合サマリーを出力：

```markdown
## オーケストレーション完了報告

### 対象Issue

| Issue | タイトル | ステータス |
|-------|---------|-----------|
| #{N} | {title} | 完了 |
| #{M} | {title} | 完了 |

### 実行フェーズ結果

| Phase | 内容 | ステータス |
|-------|------|-----------|
| 1 | 依存関係分析 | 完了 |
| 2 | Worktree準備 | 完了 |
| 3 | 並列開発 | 完了 |
| 4 | 設計突合 | 完了（問題なし） |
| 5 | 品質確認 | 完了（全Pass） |
| 6 | PR・マージ | 完了（PR #XX, #YY） |
| 7 | UAT | 完了（全PASS） |

### 品質チェック

| チェック項目 | 結果 |
|-------------|------|
| npm run lint | Pass |
| npx tsc --noEmit | Pass |
| npm run test:unit | Pass |
| npm run build | Pass |

### 成果物

- 設計書: dev-reports/design/issue-{N}-*-design-policy.md
- 作業計画: dev-reports/issue/{N}/work-plan.md
- 進捗報告: dev-reports/issue/{N}/pm-auto-dev/iteration-1/progress-report.md
- UATレポート: dev-reports/issue/{N}/uat/acceptance-test-report.html
- 統合サマリー: workspace/orchestration/runs/{DATE}/summary.md
```

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |
| worktree作成失敗 | エラー表示、手動作成を案内 |
| ワーカーのタイムアウト（exit 124） | captureで状況確認→追加指示 or ユーザーに報告 |
| 検証不合格（exit 20） | `verify --json` で失敗ゲートを特定し再指示。上限2回で人間へエスカレーション |
| 作業証跡ゼロ（exit 21） | captureでcomposer未確定・権限プロンプト・未起動を切り分け（Phase 3-4） |
| 契約エラー（send が exit 2） | 契約の全エラーが一度に出るので、`docs/design/task-contract.md` と突き合わせて修正し再送 |
| 品質チェック3回連続失敗 | ユーザーに報告して中断 |
| コンフリクト解消失敗 | ユーザーに報告して中断 |
| UAT 4回連続FAIL | ユーザーに判断を仰ぐ |

---

## 完了条件

- [ ] 全Issueの開発が完了している（契約付き委任は `wait --verify` が exit 0）
- [ ] 品質チェック全パス（ESLint, TypeScript, テスト, ビルド）
- [ ] 全IssueのPRがdevelopにマージ済み
- [ ] developブランチでの統合ビルド・テストが全パス
- [ ] （--full時）UAT全テストPASS
- [ ] 統合サマリーが出力されている

## 関連コマンド

- `/pm-auto-issue2dev`: Issue単位の全自動開発（機能Issueに送信）
- `/bug-fix`: バグ調査→修正→テスト（バグIssueに送信）
- `/cause-analysis`: 根本原因分析（他エージェント経由、バグIssueのPhase 2.5で使用）
- `/current-situation`: 不具合事象の整理とIssue登録
- `/pr-merge-pipeline`: PR作成からマージ完了まで
- `/uat`: 受入テスト
- `/uat-fix-loop`: UAT不合格時の修正ループ
- `/issues-exec-plan`: 複数Issueの実行計画策定
- `/worktree-setup`: worktree個別作成
- `/worktree-cleanup`: worktree個別削除
