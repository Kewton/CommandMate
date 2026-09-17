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
- `/orchestrate [Issue番号1] [Issue番号2] --assign 123=claude` （担当を Issue ごとに指定。1-2b の判定より優先）
- `/orchestrate [Issue番号1] [Issue番号2] --claude-only` （振り分けを止め、全 Issue を Claude に回す）

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
- **--assign `<N>=<claude|antigravity>`**: Issue #N の開発担当を指定する（複数回指定可）。1-2b の判定より優先
- **--claude-only**: 1-2b の振り分けを行わず、全 Issue を Claude に回す（従来の動作）

---

## Phase 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Phase 1: 依存関係分析・実行計画（ラベル分類・難易度判定と担当割当を含む）
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
- **開発タスク**: 担当は 1-2b の難易度判定で決める。**易 → `--instance antigravity`**
  （モデルは agy の既定。`--model` は渡さない）、**難 → `--instance claude`**
  - 送り先は `--instance` で指定し、**send / wait / capture / respond で同じ値を渡す**。
    `wait` には `--agent` が無く、worktree の既定エージェントは claude なので、
    antigravity のワーカーに `--instance antigravity` を付け忘れると Claude のセッションを待つことになる
  - Antigravity がワーカー起因で 2 回不合格になったら Claude に切り替える（3-5）
- **レビュー系**（仕様レビュー、設計レビュー等）: 一部 `--agent codex` に依頼可
- **バグ根本原因分析**（Phase 2.5）: `--agent copilot --model claude-sonnet-5` を指定

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

### 1-2b. 難易度判定と担当割当

各 Issue の本文（1-1 で取得済み）から難易度を判定し、開発担当を決める。
**優先順位**: `--claude-only` ＞ `--assign <N>=<agent>` ＞ 下の判定表。

**Claude に回す（1 つでも当てはまれば「難」）**

| 観点 | 条件 |
|---|---|
| 危険な領域 | `src/lib/tmux/**`・セッション・`src/lib/detection/**`・`src/lib/polling/**`（Auto-Yes）・hooks・`src/lib/security/**`・DB migration・`src/lib/cli-tools/**`・`ws-server` を変更する（2-5 の対象を含む） |
| 規模 | 「影響ファイル」が 4 件以上、または「対応方針」が複数 Phase に分かれている |
| 原因 | バグで、原因が file:line まで特定されていない |
| 未決事項 | 「要調査」「未決」「実機で決める」などが残っている、または設計書が必要 |
| 検証 | 受入基準の合否が、画面・実機でしか決まらない（e2e や描画結果のテストで代替できないもの。下の注を参照） |
| 依存 | 他の Issue と強依存（1-4）、または同じ関数の書き換えを伴う |
| 新規 export | 新しいモジュールや公開関数を作り、その呼び出し元の配線も必要 |

**Antigravity に回す（すべて満たせば「易」）**

- 上の条件に 1 つも当てはまらない
- 「影響ファイル」が 3 件以下で、「確定仕様」または「対応方針」が具体的に書かれている
- 受入基準の合否がすべて自動で決まる（lint / typecheck / unit / e2e）。実機の項目は、見た目の念押しだけなら残っていてよい
- バグなら、原因（file:line）と対策が本文に書かれている

**「検証」の注**: 受入基準に実機・画面の項目があっても、それが**見た目の念押し**だけなら、この行では「難」にしない。
条件は、実装そのものが自動の受入基準（描画結果の class・DOM・e2e など）で一意に決まること。
実機の項目は、担当に関係なく UAT（Phase 7）で確かめる。

- 「難」にしない例: #2616（アイコンの差し替え）。描画された svg の class でテストに固定でき、実機の項目は「見分けやすいか」の確認だけだった。
  2026-09-17 にこの行で「難」にして Claude に回したが、変更は 6 ファイル・86 行で、コミットまで約 4.5 分だった
- 「難」にする例: 実機の CLI やブラウザの画面を見ないと、直し方や合否が決まらないもの（実画面の遷移に依存する検出の修正など）

**迷ったら Claude に回す。** 判定の根拠は 1 行で plan.md に残す（1-5）。
Phase 8 の改善案（8-3）は、この根拠と実際の結果を突き合わせて書く。

判定の背景（2026-09-17 のパイロット、#2595 / PR #2602）: テスト 1 ファイル・原因と確定仕様あり・
受入基準がすべて自動、という Issue を Antigravity に回したところ、作業ルールをすべて守って
実装は 5 分で終わった。Antigravity は `.claude/commands` を読まないので、`/pm-auto-issue2dev`
のような多段ワークフローは使えない。Issue 本文だけで実装が決まる粒度のものに限る。

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
- 対象Issue一覧（**難易度・担当・根拠**の列を含める。1-2b）

  ```markdown
  | Issue | 種別 | 難易度 | 担当 | 根拠 |
  |---|---|---|---|---|
  | #2595 | BUG | 易 | antigravity | テスト 1 ファイル／原因と確定仕様あり／受入基準すべて自動 |
  | #2598 | FEATURE | 難 | claude | 影響ファイル 7 以上（新規 hook あり）／対応方針が Phase 2 段／合否が実機でしか決まらない項目あり |
  ```
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
cd "../commandmate-issue-{N}" && npm install --include=dev
```

`--include=dev` は省かないこと。シェルが `NODE_ENV=production` だと devDependencies（vitest / eslint など）が入らない。
そうなると、ワーカーの確認コマンドも検証ゲートも動かない。2026-09-17 の run では 3 つの worktree すべてで起き、
ワーカーが自力で補った（Claude は `npm install --include=dev`、Antigravity は main dir の `node_modules` をコピー）。

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

### 2-4-2. 担当ごとの goal の書き方

**契約付き send では、goal の先頭にスラッシュコマンドを書いても起動しない。** 送信本文は
`## 実行契約`（変更可能パス・完了条件）から始まり、goal はその後ろの `## タスク` に入るため、
`/pm-auto-issue2dev 2598` は平文として届く（2026-09-17 #2598 で実測。ワーカーは skill を呼ばずに
直接実装した）。goal には**スラッシュコマンドに頼らず、実装に必要な指示をすべて書く**。

- **Claude 担当**: 従来どおり Issue 本文（事象・原因・対応方針・受入基準）と 2-4-1 の作業ルールを書く。
  Claude は指示が薄くても Issue レビューや設計相当の確認を自発的に行う。
- **Antigravity 担当**: `.claude/commands` を読まない（`.agents/skills` だけを探す）。
  次の雛形の**すべての節**を書くこと。特に「確認を求めない」「`IMPL_COMPLETED`」「一時ファイルは `os.tmpdir()`」は
  省かない。ワーカーが質問を書いてターンを終えると、Auto-Yes は答えられない。wait はそれを完了と読むので、
  作業が途中のまま検証に進み、exit 20 か 21 になる。

```yaml
goal: |
  https://github.com/Kewton/CommandMate/issues/<N> を実装する。
  スラッシュコマンドは使わず、このメッセージの手順どおりに直接実装すること。
  確認や質問は求めず、最後まで自分で進めること。

  ## 事象 / 原因 / 確定仕様 / 受入基準
  <Issue 本文から転記。原因は file:line つきで>

  ## 実装の進め方
  1. まず対象ファイルを読み、上の説明が実コードと合っているか確かめる。
     食い違っていたら実コードを正とし、判断をコミットメッセージ本文に書く。
  2. テストの陽性対照・陰性対照は、実リポジトリのファイルを書き換えずに示す
     （`os.tmpdir()` 配下に `fs.mkdtempSync` で作り、`afterEach` で必ず削除する）。
  3. 確認に使うコマンドは `npx vitest run <対のテスト>`、`npm run lint`、`npx tsc --noEmit` の 3 つだけにする。
     テスト全体（`npm run test:unit`）は実行しないこと。全体は検証ゲートが実行する。
     <全体の実行が必要な Issue では、この 2 行を「最後に `npm run test:unit` を 1 回実行する」に差し替える>
  4. コマンドはすべてフォアグラウンドで実行し、終わるまで待ってから次の手順へ進む。

  ## 作業ルール（厳守）
  - 変更してよいのは <scope.allow と同じ範囲> と、下の 2 つの断片ファイルだけ。
  - tmux セッション、サーバ、バックグラウンドプロセスを起動しない。
    `$HOME` 配下にファイルを作らない（一時ファイルは `os.tmpdir()` 配下のみ）。
  - worktree の外（`$HOME`、`/tmp` など）に既にあるファイルやディレクトリは、確認のためでも消したり書き換えたりしない。
    確認は `os.tmpdir()` 配下に作った一時ディレクトリ（private HOME など）の中で行う。
  - <2-4-1 の転記ブロック（断片ファイル 2 本と実例）>
  - コミットは 1 つにまとめる。メッセージは `<type>(<scope>): <要約> (#<N>)`。
    `.commandmate/tasks/issue-<N>.yaml` と `dev-reports/` はコミットに含めない。
  - push と PR 作成はしない（オーケストレーターが行う）。
  - すべて終わったら、最後に `IMPL_COMPLETED` とだけ出力する。
```

実例: パイロットの契約（#2595）は、この雛形のとおりに書いて一度で通った（goal は 3,282 文字。上限は 8,000 文字）。
Antigravity は、雛形にあるルールのうち次のものをすべて守った:
1 コミット・指定したメッセージ・scope 内・断片の形式・push/PR をしない・`IMPL_COMPLETED`・一時ディレクトリでの陰性対照。

**「worktree の外の既存ファイルを消さない」を書く理由**（2026-09-17 #2622）: #2622 は、テストが `$HOME` と `/tmp` に
ファイルを残す不具合だった。Antigravity は修正を確かめるために、残っていた本物のファイル
（`rm -f ~/.commandmate/hooks/claude-wt-1933-…json`、`rm -rf /tmp/cm-1933-worktree`）を消し、テストを実行して
再び作られないことを見た。確認の手順としては筋が通っているが、worktree の外の既存ファイルを消す操作であり、
goal では頼んでいなかった（goal の受入基準に「`/tmp/cm-1933-worktree` に何も残らない」と書いたことが、消す動機になったとみられる）。
scope ゲートは worktree の外の操作を見ないので、こうした操作は検証では捕まらない。今回は、消したのが不具合の残骸だけだったので害は無かった。

- 受入基準に「どこそこに残らない」と書くときは、「private HOME（`os.tmpdir()` 配下）で実行したときに」と、確かめる場所も書く
- 本物の `$HOME` や `/tmp` の後始末が要るなら、ワーカーにはさせず、オーケストレーターが行う

**「実装の進め方」の 3・4 を書く理由**（2026-09-17 #2605）: 以前の雛形は「テスト全体は自分で回さなくてよい」だった。
Antigravity はコミットの後にテスト全体をバックグラウンドで起動し、その終了を待つ間、何度もターンを閉じた
（自分を後で起こす機能を使った）。結果は次のとおり:

- wait がそのターン終了を完了と読み、作業途中で検証を始めた（3-3 の「完了の合図」、#2614）
- ワーカーのテスト全体と検証ゲートのテスト全体が同時に走った
- 負荷で赤くなった別のテストを、ワーカーが調べ直した

書き方は次の方針にしている:

- **禁止は「テスト全体」に限る**。対のテスト・lint・tsc は数十秒で終わるので、ワーカーが自分で確かめられる
- **待ち方は肯定形で書く**。特定の機能名を出して禁じると、かえってその機能を意識させるおそれがあるため
- **全体の実行が必要な Issue では、3 の該当行を差し替える**。例: テストの共通設定・ヘルパーを変える Issue、広い範囲の rename
- **守られる保証は無い**。3-3 の合図確認は、この指示の有無にかかわらず行う

**このために起きる不利**:

- 対のテスト以外の破損は、検証ゲートまで見つからない。再指示の往復が 1 回増えることがある
- その再指示は、3-5 の「2 回で切替」の回数に数える

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
    --agent copilot --model claude-sonnet-5 --auto-yes --duration 1h

  commandmatedev capture "$WORKTREE_ID" --instance copilot --pane --tail 20
  # 画面のモデル表記を確認し、想定外のモデルで動いていないかを確かめる

  commandmatedev wait "$WORKTREE_ID" --instance copilot --timeout 3600 --on-prompt agent
  commandmatedev capture "$WORKTREE_ID" --instance copilot
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
# assign.tsv は 1-2b の結果（1 行 = "<issue>\t<claude|antigravity>"）
while IFS="$(printf '\t')" read -r issue AGENT; do
  WT=$(commandmatedev ls --branch "feature/${issue}" --quiet)
  commandmatedev send "$WT" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" \
    --instance "$AGENT" --auto-yes --duration 3h \
    > "workspace/orchestration/runs/$DATE/send-${issue}.out" 2> "workspace/orchestration/runs/$DATE/send-${issue}.err"
  echo "exit=$? issue=${issue}"
  TASK_ID=$(head -1 "workspace/orchestration/runs/$DATE/send-${issue}.out")
  printf '%s\t%s\t%s\t%s\n' "$issue" "$WT" "$AGENT" "$TASK_ID" >> "workspace/orchestration/runs/$DATE/tasks.tsv"
done < "workspace/orchestration/runs/$DATE/assign.tsv"
```

stdout はパイプで切らずファイルに落とす（`| head` で切ると task が pending のまま残る）。
send の後に task が `cliToolId` / `instanceId` = 担当に紐づいていることを
`GET /api/worktrees/<WT>/tasks` で確かめる。

契約の goal だけでは足りない Issue（`/bug-fix` の調査手順、Phase 2.5 の分析結果の参照など）は、
**goal 本文にその指示を書く**。契約は送信メッセージそのものなので、素の send で送っていた文面は
すべて goal に入る。goal の先頭にスラッシュコマンドを書いても起動しないので、
必要な手順は goal に書き下す（2-4-2）。

- **冷間起動の失敗**: send が exit 99 で、stderr に `prompt not ready` と出たら、メッセージは送られていない
  （Codex / Command Code で実測。Antigravity は #2478 以降のパイロットでは起きていない）。
  約 2 分待ってから 1 回だけ再送する。再送では task が作り直されるので、tasks.tsv の task id を差し替える。

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
**Antigravity のワーカーは `<worktree-id>@antigravity` で渡す**（worktree の既定は claude なので、
付けないと Claude のペインを見る）。

**Antigravity のワーカーも monitor の画面判定で読める（#2606 で修正）。** 修正前は、生成中の目印
（`↓ N` / `esc to interrupt`）とプロンプトの目印（`❯ N.`）が Claude の画面の文言だけで、agy の画面
（`esc to cancel`・点字スピナー・`Run this command?`）には当たらなかった。しかも agy のペインは上端寄せ
（200x1000）なので、判定が読んでいた `realtimeSnippet`（末尾 100 行）は空行ばかりだった。2026-09-17 の
パイロットでは 59 回のポーリングがすべて `IDLE started=0` で、裁定に届いたのは `hooks-task.sh` の task 状態を
読んでいたからである。現在の `classify-state.sh` は、capture の `cliToolId` が `antigravity` のときだけ
agy 用の目印を使い、`realtimeSnippet` と `content` の長い方から空行を除いた末尾を読む:

- 生成中: ステータス行の `esc to cancel`、または点字スピナー。ただし `↑/↓ Navigate` フッターがある画面では
  生成中と読まない（agy のダイアログもステータス行に `esc to cancel` を出すため）
- プロンプト: `↑/↓ Navigate` フッター＋番号つきの選択肢（`> 1. Yes` など）
- 待機中: 入力欄の枠（罫線 / `>` / 罫線 / ステータス行）。`? for shortcuts` には頼らない（#2478）

Antigravity のワーカーについては次のように扱う:

- `hooks-task.sh` は引き続き**必ず**付け、完了の一次ソースにする。ポーラーのカーソルが画面の最終行を
  越えていると、`realtimeSnippet` にも `content` にもペインの行が無く、そのポーリングは `IDLE` になる
- 着手の確認は `GENERATING` / `PROMPT` の行で行える。補助として
  `commandmatedev capture "$WT" --instance antigravity --prompts --limit 5`（Auto-Yes が応答した
  許可ダイアログが時刻つきで並ぶ）や commits / uncommitted の増加も使える
- レート制限・API エラー（再送）の目印は Claude の文言のままで、agy の画面では当てにしない
  （agy のその画面は実機キャプチャが無い）
- 画面を見るときは `commandmatedev capture "$WT" --instance antigravity --pane --tail 30` を使う
  （`--json` の `realtimeSnippet` / `content` は agy の画面では空行ばかりになることがある）

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
for each worktree:   # AGENT は tasks.tsv の担当
  commandmatedev wait "$WT" --instance "$AGENT" --on-prompt human --verify --timeout 10800 \
    > "workspace/orchestration/runs/$DATE/wait-${issue}.log" 2>&1
  echo "exit=$?"
```

- `--instance "$AGENT"` を必ず付ける（`wait` に `--agent` は無い。付けないと既定の claude を待つ）。
- `--on-prompt human` を必ず付ける。既定（`agent`）はプロンプト検出で即 exit 10 を返すため、
  監督ループが空回りする。
- Antigravity のワーカーでは、Auto-Yes が許可ダイアログに応答している間も、wait のログに
  `Prompt detected … Waiting for human response...` が繰り返し出る。応答済みかどうかは
  `capture --prompts` の `[answered:auto]` で確かめる。このログだけを見て介入しないこと。
- `--verify` は完了検出**後**に全ゲート（`work-evidence` ＋ `scope` ＋ verify.yaml の宣言ゲート）を
  実行し、その結果を exit code にする。ここが「完了したが壊れていた」を目視から exit code へ
  移す一点である。

**Antigravity 担当は、完了の合図（`IMPL_COMPLETED`）を確かめてから裁定する。** agy は作業の途中でも
ターンを閉じることがある。例えば、バックグラウンドで起動したコマンドの終了を `schedule`（数十秒後に自分を起こす）で待つとき。
wait はそのターン終了を完了（`basis=hook_stop`）と読むので、作業が終わる前に検証が走る。

2026-09-17 #2605 の実測（`logs/server.log`）:
- 01:28:34 `schedule` の許可 → 01:28:36 stop → wait が完了と読んで検証を開始
- その後 4 回、`schedule` で起き直しては閉じる、をくり返した
- 最後の stop は 01:33:41 で、`IMPL_COMPLETED` もこのとき出た

検証が途中の成果物ですべて通ると、未完成の変更がマージに進む。wait が返ったら、まず合図を確かめる:

```bash
commandmatedev capture "$WT" --instance antigravity --pane --tail 40 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | grep -qE '^[[:space:]]*IMPL_COMPLETED[[:space:]]*$' && echo "signal: done" || echo "signal: not yet"
```

- **行全体が `IMPL_COMPLETED` である行だけ**を合図として数える。goal の文面（「最後に `IMPL_COMPLETED` とだけ出力する」）も
  画面に表示されるので、部分一致では誤判定する
- `not yet` なら、合図が出るまで待つ。作業が続いているかは、`capture --prompts` と commits の増加で確かめる
- 合図が出たら、wait の検証が合図より前に始まっていないかを確かめる。
  比べるのは、「wait が起動した直近の検証の開始時刻」と「最後のターン終了の時刻」（合図を出したターンの終了）の 2 つ:

  ```bash
  RUN_STARTED=$(curl -s "http://localhost:3000/api/worktrees/$WT/verify/runs" \
    | jq -r '[.runs[] | select(.trigger == "wait")][0].startedAt')          # 例 2026-09-17T01:28:40.776Z
  LAST_STOP=$(commandmatedev capture "$WT" --instance antigravity --json | jq -r '.lastStopEventAt')   # epoch ms
  node -e "console.log(Date.parse(process.argv[1]) < Number(process.argv[2]) ? 'before-signal' : 'after-signal')" \
    "$RUN_STARTED" "$LAST_STOP"
  git -C "../commandmate-issue-${issue}" log -1 --format=%cI   # 最後のコミット時刻
  git -C "../commandmate-issue-${issue}" status --porcelain    # 契約ファイル以外の変更が無いこと
  ```

  - **`after-signal`**: wait の exit code をそのまま使う
  - **`before-signal`**: 最後のコミットが検証の開始より後か、作業ツリーに変更があれば、検証は途中の状態を見ている。
    `commandmatedev verify "$WT" --json` で全ゲートを検証し直し、その結果で裁定する。
    どちらも無ければ、検証は最終状態を見ている。exit 0 はそのまま採用し、exit 20 は 3-4 の「合図の前に始まった検証」に従う
- #2605 の値: 検証の開始が 01:28:40.776Z、最後のターン終了が 01:33:41.574Z（`before-signal`）。
  最後のワーカーのコミットは 01:27:47 で、作業ツリーはクリーンだった

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
| `20` | 検証不合格（ゲートが落ちた） | 下記「20 の対応」。**再指示は上限2回**。超えたら Antigravity 担当は Claude へ切替（3-5）、Claude 担当は人間へエスカレーション |
| `21` | 作業証跡ゼロ（未着手） | 下記「21 の対応」 |
| `10` | プロンプト検出 | `commandmatedev capture <WT> --instance "$AGENT"` で内容確認 → `commandmatedev respond <WT> "<番号>" --instance "$AGENT"` → 再度 wait |
| `124` | タイムアウト | capture で状況確認 → 追加指示 or ユーザーに報告 |

以降の `capture` / `respond` / `send` にも、すべて `--instance "$AGENT"` を付ける。

**20 の対応**（検証不合格）:

```bash
commandmatedev verify "$WT" --json    # 失敗したゲートと exit code を特定
```

**先に、不合格がワーカー起因かを判定する。** 再指示と切替の回数に数えるのは、ワーカー起因の不合格だけである。

- **ワーカー起因**: `lint` / `typecheck` / `unit` など宣言ゲートの失敗、`scope` 違反、`work-evidence` の不足、
  および `env-clean` の違反のうちワーカーのコマンドが作ったもの
- **ワーカー起因ではない**: `env-clean` の違反のうち、ワーカーの作業と結び付かないもの。
  2026-09-17 のパイロットでは、`env-clean` だけが FAIL して exit 20 になった。違反は次の 3 件で、いずれもワーカーと無関係だった:
  - 別リポジトリの orchestrate が消した `mcbd-*` セッション（`-`）
  - 別プロセスの TCP listener（`-`）
  - ワーカーの最初のツール呼び出しより前の時刻が名前に入った `~/.commandmate-test-<ms>`（`+`）

  帰属は次の 3 つで確かめる:
  - ワーカーが実行したコマンド: `capture --prompts --limit 100` の `Run this command?` と、そこに書かれた `start with '<cmd>'`
  - 最初のツール呼び出しの時刻
  - 違反項目の時刻（`~/.commandmate-test-<ms>` の `<ms>` など）

  ワーカー起因でないと判定した場合の扱い:
  - 残りのゲートがすべて PASS なら、オーケストレーターの裁定で合格として扱う
  - 裁定の根拠は PR の Test plan と summary に書く
  - ワーカーには再指示しない

**合図の前に始まった検証**（Antigravity 担当。3-3 の「完了の合図」）で `env-clean` だけが落ちたとき:

- 違反は、ワーカー自身がまだ動かしていたもの（バックグラウンドのテスト実行の listener `[self]`、
  テストが作って後で消す `~/.commandmate-demo-vitest-*` など）であることが多い
- 合図の後に `commandmatedev verify "$WT" --gates env-clean` を再実行する
  （`work-evidence` と `scope` も一緒に走る）
- 再実行が PASS で、かつ 3-3 の確認で「最後のコミットが検証の開始より前・作業ツリーに変更なし」なら、合格として扱う。
  **再指示・切替の回数には数えない**。裁定の根拠は PR の Test plan と summary に書く
- 再実行でも落ちたら、残っている違反について、下のワーカー起因の判定に戻る
- #2605 がこの形だった: 検証の開始は 01:28、合図は 01:33。再実行は PASS で、コミットも変わっていなかった

ワーカー起因なら、失敗ゲートと `logTail` を添えて同じ worker に再指示する（契約は据え置き。再送は素の send でよく、
`--instance "$AGENT"` を付ける）。再指示は **同一 worktree につき最大2回**。
3回目に到達したら、**Antigravity 担当は 3-5 の手順で Claude に切り替える**。**Claude 担当は** worker を止め、ユーザーに判断を仰ぐ。

**21 の対応**（作業証跡ゼロ）: ワーカーは1行も書いていない。ほぼ常に起動側の問題なので capture で切り分ける。

```bash
commandmatedev capture "$WT" --instance "$AGENT" --pane --tail 30
```

- **composer に本文が残っている** → Enter 未確定。`tmux send-keys -t "mcbd-${AGENT}-$WT" Enter` で確定させる
  （`commandmatedev respond` は空文字を受け付けず exit 2 になるのでここでは使えない）。
  tmux セッション名は `mcbd-<エージェント>-<worktree-id>` である（Antigravity なら `mcbd-antigravity-<worktree-id>`）
- **Antigravity のアンケート画面**（`How's the CLI experience so far? [1] Good … [0] Skip`）で止まっている →
  Auto-Yes は答えず、`respond "0"` は `prompt_no_longer_active` になる。
  `tmux send-keys -t "mcbd-antigravity-$WT" -l -- 0` で閉じる（2026-09-09 実測。2026-09-17 のパイロットでは出なかった）
- **権限プロンプトで停止** → Enter で承認。monitor.sh に自動承認させる場合、送信先は
  capture の `cliToolId` から `mcbd-<cliToolId>-<worktree-id>[-<suffix>]` が導出されるので
  **オプション指定は要らない**（#1601）。`--session-prefix` は導出できないセッションを見るための
  escape hatch で、渡すと導出を丸ごとバイパスするため**混在フリートでは使わない**
  （例えば `mcbd-claude` を渡すと codex / copilot のワーカーまで claude 扱いに固定され、
  存在しないペインへ撃つことになる）。届かなかった介入は stderr に `NOT delivered` と出る
- **セッションが起動していない** → `commandmatedev ls` で存在確認、必要なら再送
- 判別のための知見は orchestrate-monitor skill の STARTED ガード（`verify-completion.sh`）を参照

### 3-5. Antigravity から Claude への切り替え

Antigravity 担当の Issue が、ワーカー起因の不合格を 2 回再指示しても合格しなかったとき（3-4 の 3 回目）に行う。
ユーザーには確認しない（2026-09-17 合意）。切り替えたことは 8-2 と 8-3 に必ず書く。

1. **Antigravity のセッションだけを止める**。他のインスタンスは止めない。
   ```bash
   commandmatedev instances "$WT" kill antigravity
   commandmatedev instances "$WT"        # antigravity の RUNNING が no であること
   ```
   止めるのは、次の task を作る**前**にする。env-clean のベースラインは task を作った時点で採られ、
   ベースラインにあったセッションが後から消えると違反になるため。
2. **Claude 用の契約** `.commandmate/tasks/issue-<N>-claude.yaml` を作る。
   - `scope` / `verify` / `success` は元の契約と同じにする
   - goal には、Claude 担当の通常の goal（2-4-2）に次の「引き継ぎ」節を足す
     ```markdown
     ## 引き継ぎ（前任: Antigravity、検証不合格 N 回）
     - 前任のコミット: <git log --oneline origin/develop..HEAD の出力>
     - 不合格だったゲートと logTail: <verify --json の該当部分。2 回分>
     - 前任の変更を読み、正しい部分は残し、誤っている部分は直すこと。作り直してもよい。
     - コミットは前任のコミットに追加してよい（1 つにまとめなくてよい）。
     ```
   - 前任のコミットがあるため、`work-evidence` は Claude が何もしなくても PASS する。
     Claude が実際に作業したかは、commits の増加と 3-3 のゲートで確かめる
3. **Claude に送る**。tasks.tsv の担当を `claude` に更新する（元の行は残し、切替の行を追記する）。
   ```bash
   AGENT=claude
   commandmatedev send "$WT" --contract ".commandmate/tasks/issue-${issue}-claude.yaml" \
     --instance claude --auto-yes --duration 3h \
     > "workspace/orchestration/runs/$DATE/send-${issue}-claude.out" 2>&1
   commandmatedev wait "$WT" --instance claude --on-prompt human --verify --timeout 10800
   ```
4. 以降は通常の Claude 担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）。

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
  --instance "$AGENT" --auto-yes --duration 1h
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

CI は使い捨ての self-hosted ランナー 8 台（2026-09-18 時点）で、PR あたり 14 ジョブを回すので
（#2638 で Unit Tests を 4 本に分割）、同時本数を上げると 1 本あたりが
伸びる。**が、伸び始めるのは 4 本を超えてからで、3〜4 本まではほぼ無償である。**

分割前の実測（CI 実行 118 本、2026-08-21〜24）:

| 同時実行ピーク | CI 中央値 | 最大 |
|---|---|---|
| 1 | 10.8 分 | 12.3 分 |
| 3 | 11.6 分 | 15.5 分 |
| 4 | 14.7 分 | 28.6 分 |
| **20** | **49.2 分** | **162.4 分** |

分割後は 1 本あたりのジョブ数が増えるので、同時本数の推奨は分割後の実測で見直す（#2638）。

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

### 担当と結果（1-2b / 3-5）

| Issue | 難易度 | 担当 | 判定の根拠 | 再指示 | 切替 | 実装時間 | 検証 | 帰属の裁定 |
|-------|--------|------|-----------|--------|------|---------|------|-----------|
| #{N} | 易 | antigravity | {plan.md の根拠} | 0 | なし | 5 分 | exit 20 → 合格扱い | env-clean の違反はワーカー起因でない（{根拠}） |
| #{M} | 易 | antigravity → claude | {根拠} | 2 | 切替（{失敗ゲート}） | {分} | exit 0 | — |

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

### 8-3. 振り分けの改善案

summary.md の末尾に「振り分けの改善案」節を書き、完了報告でユーザーにも示す。
**次のどれかが起きた run では必須**（何も起きなかった run でも、気付いた点があれば書く）:

- Antigravity から Claude への切り替え（3-5）
- ワーカー起因でない不合格を、オーケストレーターの裁定で合格扱いにした（3-4）
- 判定表と実際の結果が食い違った（「易」と判定したのに再指示が要った／「難」と判定したが小さい変更で終わった）
- Antigravity 固有の停止（アンケート画面、冷間起動の失敗、monitor の誤判定など）

各項目には次の 3 つを書く:

1. **事実**: Issue、担当、何が起きたか（ゲート名・時刻・コマンド）
2. **原因の見立て**: 判定表のどの観点が外れたか。または、道具のどの欠陥か
3. **改善案**: 判定表の条件の足し引き、goal の雛形（2-4-2）の追記、道具の Issue 起票の要否。
   起票はユーザーの了承を得てから行う

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |
| worktree作成失敗 | エラー表示、手動作成を案内 |
| ワーカーのタイムアウト（exit 124） | captureで状況確認→追加指示 or ユーザーに報告 |
| 検証不合格（exit 20） | `verify --json` で失敗ゲートを特定し、先にワーカー起因かを判定（3-4）。ワーカー起因なら再指示。上限2回で、Antigravity 担当は Claude へ切替（3-5）、Claude 担当は人間へエスカレーション |
| env-clean だけが FAIL（exit 20） | `capture --prompts` と違反項目の時刻で帰属を判定。ワーカー起因でなければ合格扱いにし、根拠を PR と summary に書く（3-4） |
| 作業証跡ゼロ（exit 21） | captureでcomposer未確定・権限プロンプト・未起動を切り分け（Phase 3-4） |
| send が exit 99（`prompt not ready`） | 未送信。約 2 分後に 1 回だけ再送し、task id を差し替える（3-1） |
| Antigravity がアンケート画面で停止 | `tmux send-keys -t "mcbd-antigravity-$WT" -l -- 0` で閉じる（3-4） |
| monitor が Antigravity を `IDLE` / `NOT_STARTED` と表示 | #2606 以降は agy 用の目印で読むので、生成中なら `GENERATING` になる。それでも出るのは、capture の `--json` にペインの行が無いポーリング。task 状態と `capture --prompts` で判断する（3-2） |
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
- [ ] 統合サマリーが出力されている（「担当と結果」表を含む。3-5 の切替か 3-4 の帰属裁定があった run では「振り分けの改善案」も含む）

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
