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
- [ ] Phase 6: PR作成・マージ（同時CIは2〜3本 / refresh→tsc→影響テスト→マージ / 断片の一本化）
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
  deny: []             # 共有ファイル（CHANGELOG.md / docs/module-reference.md）は入れない。2-4-1 参照
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

### 2-4-1. 共有ファイルはワーカーに書かせない（必須）

**`CHANGELOG.md` と `docs/module-reference.md` を `scope.allow` に入れてはならない。**
代わりに各ワーカーには**断片ファイル**を書かせ、オーケストレーターがマージ時に本体へ一本化する。

契約の「作業ルール（厳守）」に次をそのまま転記する:

> - **`CHANGELOG.md` と `docs/module-reference.md` を編集しないでください**（scope 外です）。
>   代わりに次の 2 ファイルを書いてください。どちらも `dev-reports/` 配下なので commit には入りません。
>   - `dev-reports/changelog/issue-<N>.md` — `CHANGELOG.md` の `## [Unreleased]` にそのまま
>     貼れる **1 エントリ**（先頭は `- **<type>(<scope>): …** (#<N>): …`）。どの節
>     （`### Added` / `### Changed` / `### Fixed`）に入るかを 1 行目にコメントで書く。
>     **形式は次の実例に合わせてください**（develop の `CHANGELOG.md` にある実エントリを丸ごと 1 本。
>     エントリは**ファイル中では 1 行**で、下で折り返して見えるのは表示上の都合です）:
>
>     ```markdown
>     <!-- ### Fixed -->
>     - **fix(cli): `send` 直後の `wait` が「まだ始まっていない」を完了と読む問題を修正** (#1975): `wait` が `sessionStatus==='ready'` を完了と判定する直前に、**「このインスタンスに最後に渡されたプロンプト」と「エージェント自身が最後に報告したターン終了（`lastStopEventAt`）」を突き合わせる**ゲートを追加。`send` 直後は最新の構造化イベントが直前ターンの `stop` のままなので #1839 の `adoptTurnStart()` が何も採用せず、`turnStartedAt === null` が「決着済み」と読まれてアイドル composer をそのまま完了にしていた（隔離サーバ実測 2026-08-22 / copilot 1.0.80: `send`→`wait` 5 回中 3 回が約 0.3 秒・`basis=scraper_ready`・成果物ゼロで exit 0）。ゲートは `GET /api/worktrees/:id/messages?limit=1&unit=pairs` を `--instance`（無指定ならサーバが解決した `cliToolId`）でスコープして読む。**hook を出さないツールは挙動不変** — `structuredEvents.source.capabilities.supportedEvents`（#1924 の宣言値）が `stop` とターン開始語の両方を宣言しているソースだけがこのゲートに入り、legacy-relay（`supportedEvents: []`）と #1924 以前のサーバは従来経路のまま台帳も引かない。保留は `PENDING_PROMPT_HOLD_MS`=60 秒で打ち切り（hooks は全経路 fail-open なので `Stop` の取りこぼしで `wait` が返らなくなってはいけない）、`--timeout` / `--stall-timeout` はそれより短ければ従来どおり優先される。完了行の `basis=` は、エージェントが最新プロンプトの終了を報告していれば `hook_stop` になる（`scraper_ready` は「画面しか言っていない」という文書どおりの意味に戻る）。
>     ```
>
>     - `- **` で始めること — 集計は `grep -cE '^- \*\*'`（6-4 の検証手順）なので、外れるとエントリとして数えられません。
>     - `(#<N>)` は要約の**外**（`**` を閉じた後）に置くこと — `（Issue #<N>）` を要約の中に埋めると機械的に取り出せません。
>     - `<type>` は CLAUDE.md のコミットメッセージ規約と同じ語彙（`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `ci` / `style`）— リリースノート作成時の分類に使います。
>     - 1 エントリ＝1 行（折らない）— `CHANGELOG.md` は 1 エントリ 1 行で運用しています。本文がどれだけ長くても改行を入れません。
>   - `dev-reports/module-reference/issue-<N>.md` — `docs/module-reference.md` の表に足す注記を
>     **行キー（`| \`path\` |`）ごと**に列挙する。既存行への追記なら「どの行に何を足すか」を書く。
>     **既存行に足すときは `grep -n '^| \`<path>\`' docs/module-reference.md` を実行し、その出力
>     （行番号つきの行キー）を断片に書き写してから**書くこと。0 件だった行への追記を指示しない
>     （新しい行を足すなら「新規行」と明記する）。足すものが無ければ「追記なし」の 1 行でよい。実例:
>
>     ```markdown
>     ## 既存行への追記
>     - `src/lib/session/worktree-status-helper.ts` — 実在確認: `docs/module-reference.md:103`（行番号は確認時点のもの）
>       追記内容: 「private `getStatusCaptureLines()` を削除し `resolveCaptureSpec(cliToolId).statusLines` に置換（Issue #1933）」
>
>     ## 新規行
>     追記なし
>     ```
> - 断片が無いとリリースノートと module-reference に載らない。**実装と同じ commit の時点で書くこと。**

**なぜこうするか（2026-08-22 の実測）**: 全ワーカーが `CHANGELOG.md` の同じ節に追記すると、
**1 本マージするたびに残りの PR が全部 CONFLICTING になり、refresh → CI 全周やり直しが必要**になる。
CI は中央値 38 分（self-hosted 1 台・11 ジョブ、同時 5〜6 本なら 55 分）なので、
N 本のマージが N 回の直列 CI に化ける。実測では PR 21 本に対し CI 53 回（1 PR あたり 2.5 回）で、
やり直しの大半がこの結合に起因していた。断片方式なら PR 間の強制直列がほぼ消える。

`docs/module-reference.md` は **表**なので、両側保持で解決してはいけない（同じ行が 2 本になる）。
断片方式ならこの解決自体が不要になる。

**実例を丸ごと貼る理由（2026-08-22〜23 の実測）**: 形式を上の 1 行の抽象仕様だけで示していた Phase 4 では、
**4 ワーカー中 3 つが形式から外した**（#1930 は `- 構造化層の状態導出を…（Issue #1930、Epic #1921 Phase 4）`、
#1931 は `- opencode の SSE / REST 経路が…（Issue #1931）。`、#1933 は要約と Issue 番号をまとめて `**…**` の中へ入れた）。
規約どおりだったのは #1932 だけで、3 本ともオーケストレーターが一本化時に書き直している。一方、契約に実例を
丸ごと 1 本貼った #1994 の断片は初回から規約どおりだった。**抽象的な形式指定では守られず、実例なら守られる。**

module-reference 側は**実例だけでは足りない**（判断の根拠つき）。#1927 と #1932 の契約には既に
「`grep -n '^| \`<path>\`' docs/module-reference.md` で実在を確認してから書く」が入っていたのに、
**存在しない行への追記指示が #1927 で 4 件・#1932 で 1 件**出た（オーケストレーターが一本化時に裁定）。
CHANGELOG 側が**形式**の誤りで断片を見れば分かるのに対し、こちらは**事実**の誤りなので断片を読んでも分からない
──手本を足しても検出できる誤りが増えない。そこで指示を「確認する」から**「確認した出力（行番号つきの行キー）を
断片に書き写す」**へ変え、6-4 で断片を `cat` した時点で証拠の無い追記指示が目に見えるようにした
（**6-4 の手順自体は変更していない**。既存の `awk … uniq -d` は行が 2 本になった後しか捕まえられないが、
証拠の有無は写した瞬間に読めるので手順を足す必要が無い）。なお実在確認は**転記ブロックには入っていなかった**
（実測: 変更前の `.claude/commands/orchestrate.md` に `grep -n` は 1 箇所も無く、上記 2 本の契約は
オーケストレーターが手で足していた）ので、あわせて転記ブロックへ引き上げた。

### 2-5. tmux / セッションに触れる Issue の追加ルール（必須）

`src/lib/tmux/**`・セッション名・`tmux` コマンドそのものを扱う Issue（#1163 / #1621 Phase 3 /
#1623 / #1624 など）では、**次の 4 項目を契約の「作業ルール（厳守）」にそのまま転記する**。

> - **実 tmux を触る検証は必ず `tmux -L <専用socket>` で行う。** `-L` / `-S` は `$TMUX` より優先される。
>   ワーカーは tmux ペインの中で動いていて `$TMUX` が既定サーバを指しているため、フラグ無しの
>   `tmux` 呼び出しは全て**ユーザーの本番サーバ**に届く。
> - **`kill-server` を `-L` 無しで書かない。** 後始末は `kill-session -t '=<name>:'`（完全一致）で行う。
> - **`TMUX_TMPDIR` を隔離手段に使わない。** `$TMUX` が設定されていると完全に無視される。
>   socket 引数を取らない本番コード（`src/lib/tmux/tmux.ts`）を動かすときは `process.env.TMUX` を
>   私設サーバへ向け、**転送が効いていることをテスト内で assert する**。
> - **`bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。** サーバグローバルなので
>   他の全セッションに波及する。

2026-08-02 の実害に基づく。live tmux テストが `TMUX_TMPDIR` で隔離したつもりのまま `kill-server` を
撃ち、**稼働中の全 `mcbd-*` セッションを消して並列ワーカーを即死させた**。テストは 3/3 緑で、CI は
tmux 非導入で skip するため誰も気付かない。`tests/unit/config/tmux-live-test-safety.test.ts` が
unit ゲートで同型を弾くが、契約側にも明示すること。

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
  --interval 20 --idle-threshold 8 <worktree-id> ... 2>&1 | tee monitor.log
```

介入先の tmux セッションは capture の `cliToolId` から導出されるので**指定は不要**（#1601）。
既定インスタンス以外を見るときだけ `<worktree-id>@<instance-id>`（例 `w1@codex-2`）で指定する。

**起動直後に `monitor hooks ERROR` が出ていないことを確認する（#1728）。** 出ていたら
worktree-id が checkout に解決できておらず、`commits` / `uncommitted` は**測定値ではなく恒久 0** で、
「未起動 idle を COMPLETE と誤報しない」STARTED ガードが実質的に無効になっている。
その場合は checkout の親ディレクトリを渡して回避する:

```bash
MONITOR_WORKTREE_ROOT=.. MONITOR_HOOKS_BASE=origin/develop \
.claude/skills/orchestrate-monitor/scripts/monitor.sh ... # 以下同じ
```

**ログを `grep` で絞るときは `ERROR|WARN|alive` をパターンに必ず含めること。** 上の
`| tee` なら全部残るが、実運用でよくやる
`| grep -Ei "STALL|IDLE|BLOCKED|PROMPT|COMPLETE|NOT_STARTED|ERROR|FAIL"` 形だと、
フック側の診断（上記）と監視自身の生存報告（`monitor: alive (poll=N, …)`、既定 10 ポーリングごと）が
落ちる。2026-08-06 に監視が **exit 144 で沈黙終了**し、ワーカー 2 本が約 25 分間無監視のまま
走り続けたのはこれが理由である。`alive` が途切れた所が最後に生きていたポーリングで、
異常終了時は `caught SIG…` / `exiting on poll round …` が stderr に出る。

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

**完了検出が壊れているときは `verify --gates` へ退避する。** `wait --verify` はゲートの前に
完了検出を通すので、検出層の欠陥が裁定そのものを止める。2026-08-24 に #2011（`isUnclassifiedActive`
の回帰）でこれが起き、**3 ワーカーの `wait --verify` が `Unclassified interactive frame …
Waiting for human response...` を並べたまま 18 分空転した**（`--on-prompt human` なので
exit 10 にもならない）。退避手順:

```bash
# 完了検出を経由せずゲートだけ回す（--gates を渡すと scope が選択されず exit 99 に落ちない）
commandmatedev verify "$WT" --gates token-discipline,control-chars,claudemd-size,route-exports,\
build-cli,build-server,lint,build,typecheck,integration,unit
```

このとき `work-evidence` と `scope` は落ちるので、**オーケストレーターが手で照合する**
（commits ≥ 1 かつ作業ツリークリーン／`git diff --name-only origin/develop...HEAD` を契約の
`allow` と `deny` に突き合わせる）。ワーカーが完了しているかは commits と作業ツリーの状態で見る。

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
- **権限プロンプトで停止** → Enter で承認。monitor.sh に自動承認させる場合、送信先は
  capture の `cliToolId` から `mcbd-<cliToolId>-<worktree-id>[-<suffix>]` が導出されるので
  **オプション指定は要らない**（#1601）。`--session-prefix` は導出できないセッションを見るための
  escape hatch で、渡すと導出を丸ごとバイパスするため**混在フリートでは使わない**
  （例えば `mcbd-claude` を渡すと codex / copilot のワーカーまで claude 扱いに固定され、
  存在しないペインへ撃つことになる）。届かなかった介入は stderr に `NOT delivered` と出る
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

詳細は `/pr-merge-pipeline` コマンドを参照。ただし**並列オーケストレーションでは次の 3 つを守る**。

### 6-1. 同時 CI は 3〜4 本。**1 本に落とすのも失敗である**

CI は self-hosted ランナー 1 台で PR あたり 11 ジョブを回すので、同時本数を上げると 1 本あたりが
伸びる。**が、伸び始めるのは 4 本を超えてからで、3〜4 本まではほぼ無償である。**

実測（CI 実行 118 本、2026-08-21〜24）:

| 同時実行ピーク | CI 中央値 | 最大 |
|---|---|---|
| 1 | 10.8 分 | 12.3 分 |
| 3 | 11.6 分 | 15.5 分 |
| 4 | 14.7 分 | 28.6 分 |
| **20** | **49.2 分** | **162.4 分** |

**3〜4 本までは +8〜36% で、スループットはほぼ線形に伸びる。** 20 本は 4.5 倍の劣化で、
増やした分を食い潰す（この帯では 1 マージあたりの CI 実行回数も 3.7 回まで膨らんでいた＝
refresh のやり直し）。

**逆方向の失敗の方が高くつく。** 2026-08-23〜24 に同時 1 本で回した帯では、CI 単体は
10.8 分と最速だったのに**スループットは 2.50 → 0.50 PR/h（5 分の 1）**まで落ちた。
1 本あたりの品質指標（CI 実行回数 3.7 → 2.0、PR 作成→マージ 最長 6 時間 → 11〜13 分）は
すべて改善していたので、落ちたのは並列度だけである。**「丁寧にやる」を「1 本ずつやる」と
取り違えないこと。**

裁定が終わったワーカーが 5 本目以降になったら、PR を作らずに待たせる。worktree は残してよい。

### 6-1-1. PR はゲートの**前**に出す（CI とローカルゲートを並走させる）

`wait --verify` / `verify --gates` のローカルゲートと CI は**同じテストを見ている**。
順に回すと 1 issue あたり約 22 分（ローカル 10.8 分 ＋ CI 10.8 分）を直列で払う。

**速い 3 本（`lint` / `typecheck` / `build`、合計 40 秒前後）だけ先に通したら PR を出し、
残りのゲート（`integration` / `unit`）は CI と並走させる。** 実測でローカルゲートの
85〜90% は `unit` 単独（545〜584 秒）なので、**1 issue あたり約 10 分が消える。**

壊れた PR で CI を焼くリスクは、先に通す 3 本でほぼ潰せる。両方が緑になってからマージするので
裁定の強さは変わらない。

### 6-2. マージは「先行をマージ → 後続を refresh → tsc ＋ 影響テスト → マージ」

**`gh pr view --json mergeable` の `MERGEABLE` は「テキスト衝突が無い」しか意味しない。
組み合わせがコンパイルできる証拠ではない。** 2026-08-22 に、単独でどちらも全ゲート緑・CI 11/11 の
2 本を続けてマージして develop の `tsc` と `test:unit` を壊した（一方が関数を rename し、
他方のテストが旧名を使っていた）。同型の統合破壊はこの run で 2 件あり、**どちらも
`npx tsc --noEmit` と影響テストのローカル実行で捕まった**。

1 本マージするたびに、残りの各 PR で次を順に行う:

```bash
git fetch origin && git merge origin/develop     # 衝突は意味を見て解消（機械解決は共有ファイルだけ）
git grep -l -E '^(<<<<<<< |>>>>>>> |={7}$)' -- .  # 0 件であること。ここは必ず全追跡ファイルを走査する
npx tsc --noEmit                                  # 実際の統合破壊はここで出る
CI=true npx vitest run <衝突したファイルに関係するテスト>   # 型に出ない相互作用はここで出る
git push
```

**マーカー走査を CHANGELOG などの決め打ちにしないこと。** 2026-08-22 に JSDoc ブロックコメントの
内側へ落ちた衝突マーカーをコミットした事例がある（**コメント内なので `tsc` は exit 0、
関連テストも緑**だった）。

上記が通れば**フル CI の完走を待たずにマージしてよい**。develop 側の CI（12〜25 分）が安全網に
なる。**最後の 1 本だけ**はフル CI を待つ。

マージ（または close）すると、**その PR の `pull_request` run は
`.github/workflows/cancel-pr-runs-on-close.yml` が自動で止める**（Issue #2330）。**手でキャンセル
しないこと。** マージ後に PR のチェックが `cancelled` と表示されるのは**正常であって失敗の証拠では
ない** — 裁定を出すのは develop 側の push run のほうである。この自動キャンセルは
`--event pull_request` と PR の head ref で絞るので、**develop / main の push run には構造的に
届かない**（＝安全網は止まらない）。

### 6-3. マージ前に `fail` / `cancel` が無いことを機械的に確認する

`gh pr checks <PR> --json name,bucket` を読み、**`bucket` に `fail` / `cancel` が 1 つでも
あればマージしない**。2026-08-22 に「10 pass / 1 fail（Build）」の PR を、fail を目視で見落として
マージし develop のビルドを壊した。判定は目視ではなくスクリプトで行うこと。

`pending` の扱いは 6-2 に従う: **6-2 のローカルゲート（refresh → マーカー走査 → `tsc` →
影響テスト）を通していれば `pending` は待たなくてよい**。develop 側の CI が安全網になるからで、
待つと 1 issue あたり 12〜25 分が消える。**最後の 1 本だけ**は全 `pass` を待つ。

### 6-4. 断片を本体へ一本化する（オーケストレーターの仕事）

2-4-1 でワーカーに書かせた断片を、**オーケストレーターが PR ブランチ上で本体へ写してから
push する**（マージの直前、6-2 の refresh と同じタイミング）。

```bash
D=<worktree>
# CHANGELOG: 断片を [Unreleased] の指定された節の先頭へ 1 エントリだけ挿入
sed -n '2,$p' "$D/dev-reports/changelog/issue-<N>.md"   # 1 行目は節名のコメント
# module-reference: 行キーごとに既存行の注記セルへ追記（行を増やさない）
cat "$D/dev-reports/module-reference/issue-<N>.md"
```

一本化したら**必ず機械的に検証する**:

```bash
# CHANGELOG: エントリ集合が develop と完全一致 ＋ 自分の 1 行だけ増えている
diff <(git show origin/develop:CHANGELOG.md | grep -cE '^- \*\*') <(grep -cE '^- \*\*' CHANGELOG.md)
# module-reference: 同じ行キーが 2 本になっていない
awk -F'|' '/^\| `/{print $2}' docs/module-reference.md | sort | uniq -d
```

**断片が無い PR はマージしない。** リリースノートに載らない Issue が出る（過去に実際に発生し、
後追いで docs PR が必要になった）。

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
- [ ] 各Issueの CHANGELOG エントリと module-reference の注記が本体に一本化されている（6-4）
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
