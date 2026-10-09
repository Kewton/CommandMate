---
model: sonnet
description: "複数Issueを並列オーケストレーション（準備→開発→PR→マージ→UAT→修正ループ→完了）"
---

# 並列Issueオーケストレーション

## 概要
developブランチをオーケストレーターとして、複数Issueの並列開発からUAT合格までの全ライフサイクルを統括します。各Issueはfeatureブランチのworktreeで並列に開発され、commandmatedev CLIで制御します。

**原則**: オーケストレーターはコードに触れない。制御と判断のみ。

## 必ず守ること

**実測・根拠は docs/orchestrate/ へ。本体には規則を 1 行だけ書く。** 根拠は「根拠: docs/orchestrate/<file>.md#<見出し>」の行で指し、
run のたびには読まない手順（exit code ごとの対処・担当の切り替え・monitor）は、本体に「いつ・どの文書を読むか」を書いて docs/orchestrate/ に置く。
本体のバイト数の上限は `scripts/check-orchestrate-size.mjs` が持つ（CI の `orchestrate-size`）。超えたら、実測・根拠を docs/orchestrate/ へ移す。
下は、本文に散らばった必須・禁止の規則を 1 行ずつ集めたもの。括弧は元の見出しで、規則は元の場所にも残っている。

- オーケストレーターはコードに触れない。制御と判断のみ（概要）
- develop ブランチ上で実行する。契約系フラグ（`--contract` / `--verify`）が使えることを最初に確かめる（前提条件）
- 送り先は `--instance` で指定し、send / wait / capture / respond で同じ値を渡す（Phase 0）
- ワーカーに `/model` を送らない。Claude のモデルは起動時に `.claude/settings.local.json` で決める（Phase 0）
- 迷ったら難（opus）にする。迷ったら Claude に回す（1-2b）
- worktree の `npm install` では `--include=dev` を省かない（2-2）
- `requireCommit: true` を外さない（2-4）
- 同じブランチに契約を積むときは、`scope.allow` を前の契約の allow との和集合にする（2-4）
- `.sh` を触る Issue では `gates` に `lint-sh` を足す（2-4）
- `CHANGELOG.md` と `docs/module-reference.md` を `scope.allow` に入れない。ワーカーには断片を書かせる（2-4-1）
- 整理と、振る舞いの変更を同じ PR に入れない。整理の契約の `scope.allow` に `tests/**` を入れない（2-4-3）
- tmux・セッションに触れる Issue は、2-5 の 4 項目を契約に転記する（2-5）
- 実機でエージェント CLI・サーバーを動かす Issue は、隔離の項目を契約に転記する（2-6）
- 2.5 の分析の依頼は契約を使わない（素の send）（2.5-1）
- assign.tsv / tasks.tsv を stdin で読まない（fd 3 から読む）（3-1）
- send が exit 99 なら、待つ前に画面を見る（3-1）
- send の stdout はパイプで切らずファイルに落とし、送信後に `started=1` を確かめる（3-1）
- monitor の COMPLETE 判定をマージ可否の裁定に使わない。裁定は `wait --verify` の exit code（3-2）
- `wait` には `--instance "$AGENT"` と `--on-prompt human` を付ける（3-3）
- 裁定が作業の終わりのものだと確かめてから Auto-Yes を切る。合格の記録は再利用しない（3-3）
- Antigravity 担当は、完了の合図（`IMPL_COMPLETED`）を確かめてから裁定する（3-3）
- 不合格は先にワーカー起因かを判定する。再指示は同一 worktree につき最大 2 回（3-4）
- 再指示の後の裁定は `wait` → `verify --task` の 2 段で行う（3-4）
- ワーカーに「lint/tsc/test を実行して結果を報告して」と送らない（5-1）
- 未処置の指摘（5-3）が残っている PR はマージしない（5-3）
- 検証の順番待ちの間に、オーケストレーターが worktree にコミットしない（5-3）
- 同時 CI は 3〜4 本。1 本に落とすのも失敗である（6-1）
- `MERGEABLE` を組み合わせがコンパイルできる証拠にしない。refresh → tsc ＋ 影響テストを通してからマージする（6-2）
- PR の `pull_request` run を手でキャンセルしない（6-2）
- `bucket` に `fail` / `cancel` が 1 つでもあればマージしない。判定はスクリプトで行う（6-3）
- 断片が無い PR・`check` が exit 0 にならない PR はマージしない（6-4）
- 起票の前に同じ不具合の開いている Issue を探す。起票はユーザーの了承を得てから行う（8-3）

## 使用方法
- `/orchestrate [Issue番号1] [Issue番号2] ...`
- `/orchestrate [Issue番号1] [Issue番号2] --phase design` （設計フェーズまで）
- `/orchestrate [Issue番号1] [Issue番号2] --phase impl` （実装まで）
- `/orchestrate [Issue番号1] [Issue番号2] --full` （UAT合格まで全自動）
- `/orchestrate [Issue番号1] [Issue番号2] --assign 123=claude` （担当を Issue ごとに指定。1-2b の判定より優先）
- `/orchestrate [Issue番号1] [Issue番号2] --assign 123=claude-sonnet` （Claude のモデルまで指定する。`claude` と `claude-opus` は opus、`claude-sonnet` は sonnet）
- `/orchestrate [Issue番号1] [Issue番号2] --claude-only` （振り分けを止め、全 Issue を Claude（opus）に回す）

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
- **--assign `<N>=<claude|claude-opus|claude-sonnet|antigravity>`**: Issue #N の開発担当を指定する（複数回指定可）。1-2b の判定より優先。
  `claude` と `claude-opus` は同じ意味（Claude・opus）。`claude-sonnet` は Claude・sonnet。
  **これは assign.tsv の 2 列目と 3 列目を決める書き方であって、`--instance` に渡す値ではない**（`--instance` は常に `claude`）
- **--claude-only**: 1-2b の振り分けを行わず、全 Issue を Claude（opus）に回す（従来の動作）

---

## Phase 0: 初期設定

TodoWriteツールで作業計画を作成：

```
- [ ] Phase 1: 依存関係分析・実行計画（ラベル分類・難易度判定と担当割当を含む）
- [ ] Phase 2: Worktree準備・実行契約の起案
- [ ] Phase 2: 2-4-4 新しい仕組みの設計の事前レビュー（試行中・対象の Issue のみ。バグは Phase 2.5 の後）
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
  （モデルは agy の既定。`--model` は渡さない）、**中 → `--instance claude`（sonnet＝Sonnet 5.5）**、**難 → `--instance claude`（opus）**
  - **Claude のモデルは `--instance` でも `--model` でも決まらない**（`send --model` は copilot / antigravity 専用で、claude に渡すと 400）。
    セッションの**起動時**に、worktree の `.claude/settings.local.json` から決まる。書くのは 3-1 の `set_claude_model`
  - **ワーカーに `/model` を送らない。** Enter が `~/.claude/settings.json` のグローバル既定を書き換える（#1495 / #2297）
  - sonnet 担当がワーカー起因で 2 回不合格になったら opus に格上げする（3-5b）
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

#### 計測が起票した Issue

日次の計測が起票した Issue（ラベル `agent-health`/`metrics`）は、契約を書く前に **まず数え方を確かめる**。

1. 増分の内訳（どのファイルのどの行が数に入ったか）を出す
2. 本物の後退か、数え方の誤りかを分ける
3. 数え方の誤りなら、計測を直す Issue を先に立てる。この Issue の契約には「数え方を変えない」（2-4-3）を書く

PR の前に `node scripts/count-suppressions.mjs --base origin/develop` を走らせ、0 でなければ止める（verify.yaml のゲートにはしない）。

根拠: docs/orchestrate/difficulty.md#1-2-計測の誤りを目標にした実測

### 1-2b. 難易度判定と担当割当

各 Issue の本文（1-1 で取得済み）から難易度を判定し、開発担当を決める。
**優先順位**: `--claude-only` ＞ `--assign <N>=<agent>` ＞ 下の判定表。

**Claude に回す（1 つでも当てはまれば「難」）**

| 観点 | 条件 |
|---|---|
| 危険な領域 | `src/lib/tmux/**`・セッション・`src/lib/detection/**`・`src/lib/polling/**`（Auto-Yes）・hooks・`src/lib/security/**`・DB migration・`src/lib/cli-tools/**`・`ws-server` を変更する（2-5 の対象を含む） |
| 判断の余地 | **ワーカーが「どう直すか」を自分で決める箇所が 1 つでもある**（本文が `file:line` ＋置換後のコードまで確定していない変更がある）。**件数ではなく、決まっていない箇所の有無で見る**（下の実測を参照） |
| 設計 | **ワーカーが**新規のガード・テストを 1 本まるごと**設計して**書く（構造で対象を特定する、陽性/陰性対照を置く、など）。**本文にテスト全文があるなら転記であって設計ではないので、この行には当てはまらない**（下の実測を参照）。既存テストへの assert 追加・書き換えも含まない |
| 原因 | バグで、原因が file:line まで特定されていない |
| 未決事項 | 「要調査」「未決」「実機で決める」などが残っている、または設計書が必要 |
| 検証 | 受入基準の合否が、画面・実機でしか決まらない（e2e や描画結果のテストで代替できないもの。下の注を参照） |
| 依存 | 他の Issue と強依存（1-4）、または同じ関数の書き換えを伴う |
| 新規 export | 新しいモジュールや公開関数を作り、その呼び出し元の配線も必要 |

**Antigravity に回す（すべて満たせば「易」）**

- 上の条件に 1 つも当てはまらない
- **変更する全箇所が `file:line` ＋「置換後のコード」または「削除」まで確定している。件数は問わない**
- 受入基準の合否がすべて自動で決まる（lint / typecheck / unit / e2e）。実機の項目は、見た目の念押しだけなら残っていてよい
- バグなら、原因（file:line）と対策が本文に書かれている
- **逸脱時の退避路が本文に書いてある** — 「本文に無い指摘が出た場合は、そのファイルを変更せず、
  コミットメッセージ本文に『本文に無い指摘: `<file>:<line>` `<rule>`』と書いて報告すること（勝手に直さない）」。
  これが**規模を上げられる条件そのもの**である（下の実測を参照）

**退避路で報告された重複は、整理の Issue の候補として残す**: 退避路が決めているのは「直さずに報告する」までである。
報告の行き先が無いと、重複は残り続ける。ワーカーが「本文に無い指摘」で、同じ処理の写し（重複）を報告したら、次のようにする。

- その run では直させない（整理と、振る舞いの変更を同じ PR に入れない。2-4-3）
- オーケストレーターが、`workspace/orchestration/runs/$DATE/refactor-candidates.md` に 1 件 1 行で残す
  （報告した Issue・`file:line`・何と何が写しか）
- run の最後に、候補を整理の Issue として起票するかを利用者に訊く（8-4）

根拠: docs/orchestrate/difficulty.md#1-2b-重複の報告の行き先の根拠

**確定 diff は、対象のコードを読んでから書く**: 起票で確定 diff を書くときは、対象の範囲を `sed -n '<開始>,<終了>p' <file>` などで
実際に読んでから書く。

根拠: docs/orchestrate/difficulty.md#1-2b-確定-diff-を読まずに書いた例

**Claude の中の振り分け（opus / sonnet）— 2026-09-30 改定（Sonnet 5.5）**

Claude の担当は、Issue の中で**ワーカーが自分で見つけなければならないもの**の大きさで opus と sonnet に分ける。

根拠: docs/orchestrate/difficulty.md#1-2b-中の範囲を広げた経緯

| 難易度 | 担当 | モデル | 条件 |
|---|---|---|---|
| 易 | antigravity | —（agy の既定） | 「Antigravity に回す」をすべて満たす |
| 中 | claude | sonnet | 「Claude に回す」の観点のうち当てはまるのが「危険な領域」「依存」と、次の「閉じた判断」「閉じた設計」**だけ**で、受入基準がすべて自動・逸脱時の退避路がある。**閉じた判断**＝直し方の候補が本文に列挙されている、または「置き場所・書き方はあなたが決めてよい」の範囲が 1 関数・1 節に収まる。**閉じた設計**＝新しいテストを書くが、確かめる項目と陽性/陰性対照が受入基準に列挙されている |
| 難 | claude | opus | 次のどれかに当てはまる: **原因**（バグで原因が file:line まで特定されていない）・**未決事項**（「要調査」「実機で決める」など、結論が作業の結果で変わる）・**検証**（合否が実機・画面でしか決まらない）・**新規 export**（新しいモジュールと呼び出し元の配線）・**開いた判断/設計**（候補も確かめる項目も本文に無い） |

- 「中」と「難」の境目は、**作業の前に結論が決まっているか**である。候補や手順が本文にあれば、ワーカーの仕事は選んで正確に書くことで、Sonnet 5.5 で足りる。
  結論が実機の結果や調査で変わる Issue（#2955 のような原因調査、#2997 のような「再現したら直す」）は opus に残す
- 「危険な領域」と「依存」は、**壊したときの被害**と**順序の調整**の話で、「どう直すかが決まっているか」とは別の軸である。これは改定前と同じ
- それでも Antigravity には上げない。過去の Antigravity の事故（#2605 / #2622）は道具に由来し、道具の事故がいちばん高くつくのが危険な領域だからである
- **迷ったら難（opus）にする**。sonnet がワーカー起因で 2 回不合格になったら opus へ格上げする（3-5b）ので、中に回した判断の誤りは往復 2 回で取り返せる
- `.claude/settings.local.json` の `{"model":"sonnet"}` は、claude 2.1.284 で `claude-sonnet-5-5` に解決する（#2955 の fixture `tests/fixtures/claude-session-start-2955/`、SessionStart の `model`）。
  版を固定したいときだけ `claude-sonnet-5-5` と書く

根拠: docs/orchestrate/difficulty.md#1-2b-中の範囲を広げた実測

- **Sonnet 5.5 での実測はまだ無い（閉じた判断・閉じた設計への拡大はパイロット）。** 改定後の最初の run から、中の Issue ごとに再指示の回数・格上げの有無と、③④のどちらで中にしたかを 8-2 に記録し、8-3 で見直す

**「検証」の注**: 受入基準に実機・画面の項目があっても、それが**見た目の念押し**だけなら、この行では「難」にしない。
条件は、実装そのものが自動の受入基準（描画結果の class・DOM・e2e など）で一意に決まること。
実機の項目は、担当に関係なく UAT（Phase 7）で確かめる。

根拠: docs/orchestrate/difficulty.md#1-2b-検証の注の例

**迷ったら Claude に回す。** 判定の根拠は 1 行で plan.md に残す（1-5）。
Phase 8 の改善案（8-3）は、この根拠と実際の結果を突き合わせて書く。

根拠: docs/orchestrate/difficulty.md#1-2b-件数をやめて判断の余地にした根拠

根拠: docs/orchestrate/antigravity.md#1-2b-冷間起動と信頼ダイアログの運用メモ

**新規 worktree では信頼ダイアログがほぼ必ず出る**（2026-09-20 の run、#2770 で実測）ので、
exit 99 を受けたら**待たずにまず画面を見る**。手順は 3-1 の「冷間起動の失敗」に書いてある。

Antigravity は `.claude/commands` を読まないので、`/pm-auto-issue2dev`
のような多段ワークフローは使えない。Issue 本文だけで実装が決まる粒度のものに限る。

根拠: docs/orchestrate/difficulty.md#1-2b-判定の背景

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
DATE=$(date +%Y-%m-%d)      # run の開始日。日付をまたいでも変えない（run のディレクトリは引数で渡す）
RUN_ISSUES=<最小>-<最大>     # run の Issue の範囲（例 3477-3481）。記録のファイル名に入れ、同じ日の別の run と分ける
mkdir -p workspace/orchestration/runs/$DATE
```

**run の記録**（#3477）: 各 Issue の段（`contract` / `send` / `verify` / `review`（5-2b）/ `findings`（5-3）/ `precheck` / `pr` / `ci` / `merge`。
この順が run の順で、整合性レビューと指摘の処置は PR の前、CI はゲートと並走（6-1-1））が終わるたびに、`scripts/orchestrate/run-log.mjs` で 1 行を追記する。置き場所は `workspace/orchestration/runs/$DATE/run-$RUN_ISSUES.jsonl`。
記録の中身（1 行の項目）と `status` の `next` の決まり（作業の HEAD と公開する HEAD・`skip` の扱い・`--work-head`）は、HEAD を重ねたコミットを手で記録するときと、再開先が思ったものと違うときに docs/orchestrate/run-log.md#1-5-記録の中身と-next-の決まり を読む。

**セッションが落ちたら、会話の記録ではなくこれを読んで再開する**:

```bash
node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue <N> --stage verify --result ok --head <sha> --duration-sec <秒>
node scripts/orchestrate/run-log.mjs status --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES"
# → #<N>  reached=verify  next=review  head=<sha>  send=ok verify=ok  (review: no result for <sha>)   （次に行う段が next）
```

実行計画を `workspace/orchestration/runs/$DATE/plan.md` に出力：
- 対象Issue一覧（**難易度・担当・モデル・根拠**の列を含める。1-2b）

  ```markdown
  | Issue | 種別 | 難易度 | 担当 | モデル | 根拠 |
  |---|---|---|---|---|---|
  | #2595 | BUG | 易 | antigravity | — | テスト 1 ファイル／原因と確定仕様あり／受入基準すべて自動 |
  | #2760 | BUG | 中 | claude | sonnet | 当てはまる観点は「危険な領域」（`src/lib/tmux/**`）だけ／全変更が確定 diff／受入基準すべて自動／退避路あり |
  | #2598 | FEATURE | 難 | claude | opus | 影響ファイル 7 以上（新規 hook あり）／対応方針が Phase 2 段／合否が実機でしか決まらない項目あり |
  ```
- `workspace/orchestration/runs/$DATE/assign.tsv` も同時に書く。1 行 = `<issue>\t<claude|antigravity>\t<opus|sonnet|->`
  （3 列目は Claude のモデル。antigravity は `-`。`--assign 123=claude-sonnet` は `123\tclaude\tsonnet` になる）
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
そうなると、ワーカーの確認コマンドも検証ゲートも動かない。

根拠: docs/orchestrate/contract.md#2-2-devdependencies-を入れる理由

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
    - "changelog.d/<N>.md"   # CHANGELOG の断片。ワーカーが実装と同じコミットに含める（2-4-1）
  deny: []             # 共有ファイル（CHANGELOG.md / docs/module-reference.md）は入れない。2-4-1 参照
verify:
  # 既定は unit-related（変更に関係するテスト＋リポジトリのファイルを読むテスト）。テスト全体が必要な Issue だけ unit にする（#2639）
  gates: [lint, typecheck, unit-related]
  gateDefinitions:
    - id: unit-related
      command: "node scripts/run-related-unit-tests.mjs --base origin/develop"
      timeoutSec: 5400
      mutex: cpu.heavy
success:
  requireWorkEvidence: true
  requireCommit: true  # コミット前の状態を合格にしない（#3430: ワーカーが途中でターンを閉じ、未コミットのまま exit 0 になった）
  requireScopeClean: true
```

**契約は `scripts/orchestrate/contract.mjs` で作る**（#3477）。Issue ごとに設定ファイル（YAML か JSON）を 1 つ書き、
そこから上の形の契約を生成する。goal は `scripts/orchestrate/templates/` の雛形（2-4-1・2-4-2）から組み立てるので、
手で転記しない。

```bash
# 設定は run のディレクトリに置く（workspace/ は git に無視される）。Issue 本文は gh で取ってファイルにする
gh issue view <N> --json body -q .body > "workspace/orchestration/runs/$DATE/issue-<N>.md"
cat > "workspace/orchestration/runs/$DATE/contract-<N>.yaml" <<'YAML'
issue: <N>
key: "<N>"                # 契約のファイル名 issue-<key>.yaml。同じブランチの 2 本目は "<N>-opus" など（断片は <N> のまま）
title: "<Issueタイトル>"
kind: feature             # feature | bug | refactor | docs（CHANGELOG の節とコミットの type の既定）
agent: claude             # claude | antigravity
model: opus               # opus | sonnet（antigravity は書かない）
gates: [lint, typecheck, unit-related]
scope: ["src/lib/<module>/**", "tests/unit/<module>/**"]   # changelog.d/<N>.md は自動で足される
decisions: []             # Issue の「決めること」への答え（goal の「この契約での決定」になる）
changelog: { section: Added }   # 節の上書き（既定は kind から）。最低の版を上げるなら bump: minor を足す
commit: { type: feat, scope: <scope> }
issueBodyFile: issue-<N>.md     # 設定ファイルからの相対パス
# isolatedLiveCheck: [server, tmux]   # 隔離した実機の確認を許す（2-5 は tmux、2-6 は server）。起動の禁止の文が隔離の手順に置き換わる
# refactor: { mergesCopies: true }    # kind: refactor では必須（2-4-3）。写しをまとめる手順は true、長い関数を分ける手順は false
YAML
node scripts/orchestrate/contract.mjs generate \
  --config "workspace/orchestration/runs/$DATE/contract-<N>.yaml" --worktree "$WT_PATH"
```

- 生成が失敗したとき・止まったときは docs/orchestrate/contract.md#2-4-生成器が止まる条件 を読む（検査する制約・goal の上限・scope に書けないファイル・再実行と `--force`）
- 2-4-2 の差し替え（テスト全体）は雛形に入っていない。生成した契約に手で足す
- `kind: refactor` では 2-4-3 の整理の決まりが goal に入り、gates の既定が `[lint, typecheck]` になる。`tests/` の下の glob を scope に書くと生成が失敗する

- **`requireCommit: true` を外さない**（#3430）。外すと未コミットの変更も作業証跡に数え、ワーカーがコミット前に
  ターンを閉じたとき `wait --verify` が exit 0 を返す。契約の「1 つにコミットする」と裁定をそろえる。
- **契約は未コミットで配ってよい**。`work-evidence` / `scope` ゲートは変更集合から契約ファイル自身を
  除外する（#1580）ので、契約を置いただけの worktree が「作業済み」に見えることはない。
- `scope.allow` は**Issueが触ると宣言した範囲**を書く。広すぎる allow は scope ゲートを無力化し、
  狭すぎる allow は正当な変更を不合格にする。迷ったら Phase 1 の依存関係分析で洗い出した
  ファイル集合をそのまま使う。
- **同じブランチに契約を積むとき**（設計の契約の後の実装の契約、実装を 2 本に分けたときの 2 本目など）は、
  `scope.allow` を**前の契約の allow との和集合**にする。scope ゲートは origin/develop 比のブランチ全体の差分を
  見るので、その契約で触る範囲だけを書くと、前の契約で入れたファイルが範囲外になる。
  根拠: docs/orchestrate/contract.md#2-4-和集合にする実測
- `verify.gates` を絞ると**絞ったゲートしか裁定しない**。`unit-related` は、変更に関係するテストと、
  リポジトリのファイルを読むテストだけを実行する（`scripts/run-related-unit-tests.mjs`。import されない
  ファイルが変わったときはテスト全体に切り替わる）。テスト全体の合否は CI の `Unit Tests` で見るので、
  `unit-related` で裁定した PR は 6-2 の例外に従う。テストの共通設定・ヘルパーの変更や広い範囲の rename
  など、テスト全体が必要な Issue では `gates: [lint, typecheck, unit]` にする（#2639）。
- **`.sh` を触る Issue**（`scope.allow` に `.sh` が入りうる。`scripts/**` など）では、`gates` に `lint-sh` を足す
  （例: `gates: [lint, lint-sh, typecheck, unit-related]`）。`lint-sh` は `.sh` の変更が無ければ何もせず合格するので、
  迷ったら足してよい。`lint` は ESLint だけで、shellcheck（CI の Lint ジョブの `npm run lint:sh`）は見ない（#3478）。
- **`$HOME` 配下に新しい置き場所（ファイル・ディレクトリ・環境変数で移せる場所）を足す Issue** では、
  goal の受入基準に「`tests/setup.ts` に、その置き場所をテスト用の一時パスへ向ける既定を足す
  （`CM_OPENCODE_PORT_FILE` / `CM_OPENCODE_V2_DIR` と同じ形）」を書く。`scope.allow` に `tests/setup.ts` を入れ、
  共通設定の変更なので `gates` は `unit` にする。
  根拠: docs/orchestrate/contract.md#2-4-home-配下の置き場所の実例

#### 画面・CLI に見える変化を含む Issue

利用者に見える変化（画面・CLI の表示）を含む Issue は、部品だけを範囲にすると、文言が一度も描画されないまま検証に合格する。起案のとき、次の 3 点を契約に書く。

- **経路図を goal に書き、変更が要る段だけを `scope.allow` に入れる。** 値の出どころ → API／WebSocket → フック → 親のコンポーネント → 部品（CLI の表示なら API → CLI の型 → コマンドの出力）を goal に全段書く。`scope.allow` には、そのうち変更が要る段だけを入れる（読むだけの段は入れない）。段を漏らすと、ワーカーは「本文に無い指摘」としか報告できない。
- **経路ごとの表示の確認を受入基準に入れる。** 変化が届く経路ごとに（PC とスマホ、poll と push、HTTP と WebSocket など）、「その変化が起きる状態のまま、親から通して描画される（または出力される）」ことを確かめるテストを入れる（例: Auto-Yes 有効のまま、親を描画して文言を探す）。部品だけのテストでは足りない。
- **実際の応答とつなぐ。** 応答は手で作ったモックだけにしない。サーバーが実際に返す応答（実装が返す値）と表示がつながることを 1 本で固定する（2-4-3 の「実際の応答」と同じ方針）。

起案のとき、表示の条件（親が隠す条件・モード）を確かめる。2-4-2 の「表示されない条件」を探す。

根拠: docs/orchestrate/contract.md#2-4-画面に見える変化の例

### 2-4-1. 共有ファイルはワーカーに書かせない（必須）

**`CHANGELOG.md` と `docs/module-reference.md` を `scope.allow` に入れてはならない。**
代わりに各ワーカーには**断片ファイル**を書かせる。2 つの扱いは次のように異なる:

- **CHANGELOG**: ワーカーが `changelog.d/<N>.md` を書き、**実装と同じコミットに含める**（2-4 の雛形のとおり
  `scope.allow` に `"changelog.d/<N>.md"` を入れる）。`CHANGELOG.md` へはリリース時に `/release` が
  `node scripts/changelog-fragments.mjs apply` で集約する。オーケストレーターは書き写さない（6-4）
- **module-reference**: ワーカーが `dev-reports/module-reference/issue-<N>.md` に書き（commit には入らない）、
  従来どおりオーケストレーターがマージ時に本体へ一本化する（6-4）

契約の「作業ルール（厳守）」に入る断片の書き方（実例つき）は **`scripts/orchestrate/templates/fragment-rules.md` が持つ**（#3477。ここには写さない）。
`scripts/orchestrate/contract.mjs`（2-4）が `<N>` を Issue 番号に置き換えて goal に入れるので、手で転記しない。

根拠: docs/orchestrate/contract.md#2-4-1-断片方式にした理由

`docs/module-reference.md` は **表**なので、両側保持で解決してはいけない（同じ行が 2 本になる）。
断片方式ならこの解決自体が不要になる。

根拠: docs/orchestrate/contract.md#2-4-1-実例を丸ごと貼る理由

### 2-4-2. 担当ごとの goal の書き方

**契約付き send では、goal の先頭にスラッシュコマンドを書いても起動しない。** 送信本文は
`## 実行契約`（変更可能パス・完了条件）から始まり、goal はその後ろの `## タスク` に入るため、
`/pm-auto-issue2dev 2598` は平文として届く。goal には**スラッシュコマンドに頼らず、実装に必要な指示をすべて書く**。

根拠: docs/orchestrate/contract.md#2-4-2-スラッシュコマンドが起動しなかった実測

- **Claude 担当**: 従来どおり Issue 本文（事象・原因・対応方針・受入基準）と 2-4-1 の作業ルールを書く。
  Claude は指示が薄くても Issue レビューや設計相当の確認を自発的に行う。
  - **sonnet 担当（1-2b の「中」）の goal には、次の 1 行をそのまま足す**:
    ```
    Issue 本文に無い変更が必要に見えたら、そのファイルを変更せず、コミットメッセージ本文に「本文に無い指摘: <file>:<line> <内容>」と書いて報告すること。
    ```
    「中」に振り分けた前提（全変更が確定 diff）が崩れたときの退避路で、Antigravity の雛形と同じもの。
    サブエージェントについての指示は要らない: `.claude/agents/*.md` は `model: inherit` なので、ワーカーがサブエージェントを呼んでも
    セッションと同じモデル（sonnet）で走る（`model: opus` 固定だった頃は、その部分だけ opus で走っていた）
- **Antigravity 担当**: `.claude/commands` を読まない（`.agents/skills` だけを探す）。
  次の雛形の**すべての節**を書くこと。特に「確認を求めない」「`IMPL_COMPLETED`」「一時ファイルは `os.tmpdir()`」は
  省かない。ワーカーが質問を書いてターンを終えると、Auto-Yes は答えられない。wait はそれを完了と読むので、
  作業が途中のまま検証に進み、exit 20 か 21 になる。

goal の雛形は **`scripts/orchestrate/templates/goal.md` が持つ**（#3477。ここには写さない）。担当で雛形を分けず、
`scripts/orchestrate/contract.mjs`（2-4）が Issue ごとの設定から埋める（sonnet には上の 1 行も足す）。

根拠: docs/orchestrate/contract.md#2-4-2-雛形の実例と外のファイルを消した件

- 受入基準に「どこそこに残らない」と書くときは、「private HOME（`os.tmpdir()` 配下）で実行したときに」と、確かめる場所も書く
- 本物の `$HOME` や `/tmp` の後始末が要るなら、ワーカーにはさせず、オーケストレーターが行う

根拠: docs/orchestrate/contract.md#2-4-2-既存のテストと実装の進め方を書く理由

書き方は次の方針にしている:

- **禁止は「テスト全体」に限る**。対のテスト・lint・tsc は数十秒で終わるので、ワーカーが自分で確かめられる
- **待ち方は肯定形で書く**。特定の機能名を出して禁じると、かえってその機能を意識させるおそれがあるため
- **守られる保証は無い**。3-3 の合図確認は、この指示の有無にかかわらず行う

**差し替えの条件（2026-09-20 の run で狭めた）**: 差し替えてよいのは
**対のテストでは破損が見えない Issue**（テストの共通設定・ヘルパーを変える、広い範囲の rename）**だけ**である。
**Issue の受入基準に `npm run test:unit` と書いてあることは、差し替えの理由にならない。**

根拠: docs/orchestrate/contract.md#2-4-2-差し替えの条件の理由

根拠: docs/orchestrate/contract.md#2-4-2-差し替えの条件を狭めた実測

**このために起きる不利**:

- 対のテスト以外の破損は、検証ゲートまで見つからない。再指示の往復が 1 回増えることがある
- その再指示は、3-5 の「2 回で切替」の回数に数える

#### 対になる場所を探す（全担当共通・実装の**前**）

Issue と契約は「変える場所」を名指しし、ワーカーはそこを変え、テストは変えた場所を確かめ、オーケストレーターは差分を見る。
**変えるべきだったのに変えなかった場所**を見る段は、ここで入れないと無い。goal には、実装の前に次を探し、
結果（見つけた場所と、直す・直さないの判断）をコミットメッセージ本文に記録するよう書く。

- 同じ処理の写し（PC とスマホ、チャット面とターミナル、ルートどうし、ツールごとの実装、同じ関数を別の関数越しに呼ぶ経路）
- 同じ値・型の写し（サーバーの型と `src/cli/types/`、定数、辞書の ja / en）
- 説明（`docs/` の ja と en、コメント、JSDoc）
- 古い動きを固定しているテスト（回数・文言・タイミング）
- **表示されない条件**（親が隠す条件・モード。例: Auto-Yes 中はプロンプト欄を出さない）。変えた表示が、その条件で隠れないか
- 直した理由が、**同じ場所の別の条件**にも当てはまらないか

契約の範囲の中なら、一緒に直す。範囲の外なら直さず、「本文に無い指摘: <file>:<line> <内容>」として報告する（上の退避路と同じ）。
探した結果は、見つからなかったときも「探した対象と、無かったこと」を書かせる。

根拠: docs/orchestrate/contract.md#2-4-2-対になる場所を探す実測

### 2-4-3. 整理（refactor）の Issue の契約の型

整理（refactor）の Issue は、**振る舞いを変えないこと**を契約で縛る。2-4 の雛形に、次の 3 つの決まりを足す。

- **`scope.allow` に `tests/**` を入れない。** テストを書き換えると、scope ゲートが不合格にする。
  import 行の付け替えが要るテストだけを、ファイルを名指しで入れる
- **goal に「整理の決まり」を書く**（下の雛形。`contract.mjs` が `kind: refactor` で入れる）
- **整理と、振る舞いの変更を同じ PR に入れない。** 不具合の修正や機能の追加は、別の Issue・別の PR にする

```yaml
scope:
  allow:
    - "src/lib/<module>/**"
    - "tests/unit/<module>/<名指しのテスト>.test.ts"   # import 行の付け替えが要るときだけ。tests/** は入れない
    - "changelog.d/<N>.md"
  deny: []
verify:
  gates: [lint, typecheck]   # テスト全体は PR の CI で見る（下の「検証ゲート」）
success:
  requireWorkEvidence: true
  requireCommit: true  # 上の雛形と同じ（#3430: コミット前の状態を合格にしない）
  requireScopeClean: true
```

契約の「作業ルール（厳守）」に入る「整理の決まり」は **`scripts/orchestrate/templates/refactor-rules.md` が持つ**（#3477。ここには写さない）。
`scripts/orchestrate/contract.mjs`（2-4）が、設定の `kind: refactor` のときに `<N>` を Issue 番号に置き換えて goal に入れるので、手で転記しない。
設定には `refactor: { mergesCopies: true }`（写しをまとめる手順）か `false`（長い関数を分ける手順）を必ず書く。
決まりの見出し（本文は雛形）: 振る舞いを変えない／`tests/` の下のファイルは変えない／写しは新しいモジュールに置く／循環を作らない／
コメントは書き換えずに移す／`await` を足さない／見つけた食い違いや不具合は直さない／テストを変えずには通らないなら `IMPL_BLOCKED`／
`git diff --shortstat` で行が減らないなら採用しない（`mergesCopies: true` のときだけ）／
数え方を変えない（計測のコード・除外の一覧・抑止のコメントを足して数字を下げない）／
どう届いたかを書く（言い換え・書き方の変更だけで数が変わった箇所は、そう書く）。

**数字だけの変更を止める確認（#3483）**: 整理・計測の Issue の PR を出す前に、オーケストレーターが
PR の前の確認（6-1-1 の `scripts/orchestrate/precheck.mjs`）を `--kind refactor`（計測の Issue は `--metrics`）で走らせる。
その中で `node scripts/count-suppressions.mjs --base origin/develop` が走る。追加された抑止のコメントと、計測の設定
（`src/lib/agent-health/metrics*.ts`・`scripts/agent-health/metrics*.ts`）の変更が 0 でなければ、PR の前に止めて再指示する。
雛形の 2 つの決まり（数え方を変えない・どう届いたかを書く）は、すべての整理の契約に入る。

`git diff --shortstat` の 1 行は、写しをまとめる手順の契約（`mergesCopies: true`）にだけ入る。長い関数を分ける手順（`false`）には入らない（下の「採用の基準」）。

ワーカーが `IMPL_BLOCKED` で終わったら、オーケストレーターは理由のファイルを読む。
置き場所などの指示を変えてやり直すか、その手順を採用しないと決めて Issue に書く。

根拠: docs/orchestrate/contract.md#2-4-3-整理の決まりと実測の記録

**採用の基準**: 写しが 1 つになって行が減るか、長い関数が短くなるなら採用する。
行が増えて、重複が引数の受け渡しに置き換わるだけなら採用しない。
写しをまとめる手順の契約は `mergesCopies: true` にして（`git diff --shortstat` の 1 行が入る）、ワーカーに行数で判定させる。

根拠: docs/orchestrate/refactor.md#2-4-3-採用の基準の実測

根拠: docs/orchestrate/contract.md#2-4-3-採用しなかった手順

根拠: docs/orchestrate/contract.md#2-4-3-置き場所と同期の理由

整理の Issue の契約を起案するとき（`kind: refactor`）と、整理の PR がゲートや CI で落ちたときは、docs/orchestrate/refactor.md#2-4-3-整理の-issue-でだけ使う手順 を読み、その手順（ファイルや名前を消す前の確かめ方・コメント・同じ列の手順・テストが自分どうしの比較になる変更・範囲外の食い違い・検証ゲート）に従う。

### 2-4-4. 新しい仕組みの設計の事前レビュー（試行中の段、2026-11-06 まで）

5-2b の整合性レビューはマージの前の段で、設計の穴を実装の後に見つける。そこで、最終の契約をワーカーに送る**前**に、設計の要点を Codex に 1 回見せる。**期限つきの試行**で、常設しない。

根拠: docs/orchestrate/contract.md#2-4-4-事前レビューを足した理由

- **期限:** 2026-11-06 まで（4 週間）。期限の日に、下の記録を集計して、続ける・入れる・やめるの判断案を書き、Codex のレビューを受けてから利用者に伺う
- **対象の条件:** 危険な領域（hook・セッション・検出・ポーリング／Auto-Yes・tmux・security・応答の形・隔離）で、**状態・副作用・寿命を変える** Issue。
  新しい自動の動作・新しい状態や記録だけでなく、**既存の動作の修正で新しい経路や状態の遷移を生むもの**も含む。接頭辞（feat / fix）では判定しない。
  対象でないもの（表示だけの変更・docs だけ・テストだけ・状態や寿命に触れない修正）は飛ばし、飛ばした理由を plan.md に 1 行残す
- **置き場所:** 実行契約の起案（2-4）の後、最終の契約を送る（3-1）前。**バグは Phase 2.5（原因の分析）の後**に行う。
  レビューで変わった scope と受入基準は、最終の契約に反映してから送る
- **書くもの・依頼の形・指摘の契約への入れ方・記録:** 対象の Issue では docs/orchestrate/trials.md#2-4-4-事前レビューの書き方と記録 を読み、その手順で行う
- **依頼文は送る前に利用者に見せる**（高難易度の意思決定の既存の決まりと同じ）。承認を得てから送る
- **5-2b は残す。** 事前レビューをした Issue も 5-2b の対象に含める
- **期限の集計の手順:** 期限の日に docs/orchestrate/trials.md#2-4-4-期限の集計の手順 を読む

### 2-5. tmux / セッションに触れる Issue の追加ルール（必須）

`src/lib/tmux/**`・セッション名・`tmux` コマンドそのものを扱う Issue（#1163 / #1621 Phase 3 /
#1623 / #1624 など）では、**次の 4 項目を契約の「作業ルール（厳守）」にそのまま転記する**。
契約を `contract.mjs` で作るときは、設定に `isolatedLiveCheck: [tmux]` を書く（下の 4 項目が起動の禁止の文と置き換わって入る。手で転記しない）。

> - **実 tmux を触る検証は必ず `tmux -L <専用socket>` で行う。** `-L` / `-S` は `$TMUX` より優先される。
>   ワーカーは tmux ペインの中で動いていて `$TMUX` が既定サーバを指しているため、フラグ無しの
>   `tmux` 呼び出しは全て**ユーザーの本番サーバ**に届く。
> - **`kill-server` を `-L` 無しで書かない。** 後始末は `kill-session -t '=<name>:'`（完全一致）で行う。
> - **`TMUX_TMPDIR` を隔離手段に使わない。** `$TMUX` が設定されていると完全に無視される。
>   socket 引数を取らない本番コード（`src/lib/tmux/tmux.ts`）を動かすときは `process.env.TMUX` を
>   私設サーバへ向け、**転送が効いていることをテスト内で assert する**。
> - **`bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。** サーバグローバルなので
>   他の全セッションに波及する。

根拠: docs/orchestrate/contract.md#2-5-実害の記録

### 2-6. 実機でエージェント CLI / サーバーを動かす Issue の隔離の雛形（必須）

実機でエージェント CLI や CommandMate のサーバーを動かして確かめる Issue では、**次の項目を契約の「作業ルール（厳守）」に転記する**
（tmux を触るなら 2-5 の 4 項目も一緒に転記する）。
契約を `contract.mjs` で作るときは、設定に `isolatedLiveCheck: [server]`（tmux も触るなら `[server, tmux]`）を書く（下の項目が起動の禁止の文と置き換わって入る）。

> - **CommandMate のサーバーは別ポート（`CM_PORT`）・一時データベースで動かす。** `CM_DB_PATH` は worktree の `data/` 配下などに置く
>   （`/tmp` は検証で拒まれる）。起動後に `lsof -p <pid> | grep '\.db'` で、本番のデータベースを掴んでいないことを確かめる。
> - **エージェント CLI の状態の置き場所を一時ディレクトリへ向ける。** `XDG_STATE_HOME`（必要なら `XDG_DATA_HOME` / `XDG_CONFIG_HOME` /
>   `XDG_CACHE_HOME`）と、OpenCode V2 の記録（`CM_OPENCODE_V2_DIR`）。**環境変数を書いただけで済ませず、
>   プロセスの環境に実際に効いていることを `ps eww <pid>` などで確かめる。**
> - **tmux は `-L <専用socket>` で使う**（2-5）。
> - **作ったものを後始末する。** 作ったエージェントのセッション（opencode なら `DELETE /api/session/{id}`）、サーバー、ポート、一時ファイル。
> - **利用者の状態を前後で比べる。** `service.json`・`~/.commandmate/*`・`~/.local/state/*` の一覧（`ls -la`）を作業の前後で取り、
>   変わっていないことを結果（コミットメッセージ本文か報告）に書く。

根拠: docs/orchestrate/contract.md#2-6-隔離の雛形の理由

---

## Phase 2.5: 根本原因分析（バグIssueのみ）

Phase 1-2 で `bug` ラベルと分類されたIssueに対して、他エージェント経由で根本原因分析を実行する。
機能Issue（FEATURE_ISSUES）はこのフェーズをスキップする。

**`bug` ラベルでも、本文に原因（`file:line`）と対策が既に書かれているならスキップする。**
判定は 1-2b の「原因」の観点と同じ基準（`バグで、原因が file:line まで特定されていない`）で行う。
2.5 が生む成果物は「再現パスの特定・根本原因・対策案」の 3 つで、**それが本文に既にあるなら、
委譲しても同じものを書き直させるだけ**である。スキップしたことと理由は plan.md に 1 行残す。

根拠: docs/orchestrate/contract.md#25-原因が本文にあってスキップした例

### 2.5-1. 他エージェントに分析依頼

**このフェーズは契約を使わない（素の send のまま）。** 分析はコードを変更しない依頼であり、
`--verify` は必ず `work-evidence` ゲートを含む（`--gates` で外そうとしても `wait --verify` は
全ゲート要求になる）ため、成功した分析ほど exit 21 になる。契約付き委任は**変更を伴う委任**にだけ使う。

バグ Issue ごとの分析の依頼は、develop worktree の上で 1 本ずつ送る。送るときは docs/orchestrate/workers.md#25-1-分析の依頼の送り方 を読み、その送り方（`--agent copilot --model claude-sonnet-5`・モデル表記の確認・`wait --on-prompt agent`）で送る。

### 2.5-2. 分析結果のIssue追記

分析結果をオーケストレーターが検証し、Issue本文に追記する：

```bash
gh issue edit "$bug_issue" --repo Kewton/CommandMate --body "${CURRENT_BODY}${ANALYSIS_SECTION}"
```

### 2.5-3. 複数バグIssueの場合

バグIssueが複数ある場合は**順次実行**する（develop worktree 1つで共有するため）。

### 2.5-4. 直す前に整える（対策の形を見る）

対策案を Issue に追記する前に、オーケストレーターは対策の形を 2 つの点で見る。
2.5 をスキップした Issue（原因と対策が本文にある）でも、本文の対策に同じ判断をする。

- **修正が「同じ処理の写しの片方だけを直す」形になるとき**: 先に整理の PR で写しを 1 つにする。その後で修正する。
  整理は別の Issue・別の PR にし、契約は 2-4-3 の型で書く。修正は、整理の PR がマージされてから始める（1-4 の強依存）
- **修正が「分岐を 1 つ足す」形になるとき**: なぜ今の仕組みで扱えないかを、Issue に書く

- **写しが要るとき（1 つにできないとき）**: ずれを検出するテストを足す。**欄の名前の一致だけでは足りない。**
  必須・省略可、値の型まで比べる。テストは、手で作った応答ではなく、**実際の応答**（実装が返す値）を使う
  根拠: docs/orchestrate/contract.md#25-4-写しと全経路のテストの実例
- **「全部の場所が同じ決まりを守る」とき**: **同じ事例を各経路に当てるテスト**で固定する
  （例: 別サーバーのセッションを各ルートに当て、409 が返ることと、送信されないことを確かめる）。
  名前の grep の列挙を、取りこぼしの検査にしない。
  import があることだけで合格にしない
  根拠: docs/orchestrate/contract.md#25-4-写しと全経路のテストの実例

写しがあるかは、分析結果の「類似リスク」と、直す箇所の関数名・文言の grep で確かめる。
判断の結果は、Issue への追記（2.5-2）に含め、plan.md にも 1 行残す。

根拠: docs/orchestrate/contract.md#対策の形を見る理由

---

## Phase 3: 並列開発

### 3-1. 各ワーカーにタスク送信（契約付き）

**標準経路は契約付き send。** 契約は Phase 2-4 で worktree に配置済み。
`--contract` は goal を送信メッセージ本文として組み立てるので、**メッセージ引数は渡さない**
（両方渡すと exit 2）。stdout に task id が出るので控える（stderr の `Task created:` は人間向け）。

```bash
# Claude のモデルは「セッションの起動時」に、worktree の .claude/settings.local.json から決まる。
# sonnet は {"model":"sonnet"} を書く。opus は model キーを「書かない」＝ ~/.claude/settings.json の既定（opus[1m]）を継ぐ
# （"opus" と書くと 1M コンテキストが外れる。既定が opus でない環境でだけ jq '.model = "opus"' にする）。
set_claude_model() {  # <worktree-path> <opus|sonnet>
  f="$1/.claude/settings.local.json"
  # このファイルが git に無視されていること（diff にも scope ゲートにも出ないこと）を先に確かめる。無視されていなければ書かない
  git -C "$1" check-ignore -q .claude/settings.local.json || { echo "NOT ignored: $f" >&2; return 1; }
  mkdir -p "$1/.claude"; [ -s "$f" ] || echo '{}' > "$f"
  if [ "$2" = sonnet ]; then jq '.model = "sonnet"' "$f" > "$f.tmp"; else jq 'del(.model)' "$f" > "$f.tmp"; fi
  mv "$f.tmp" "$f"
}

# assign.tsv は 1-2b の結果（1 行 = "<issue>\t<claude|antigravity>\t<opus|sonnet|->"）。3 列目は Claude のモデル
# assign.tsv は fd 3 から読む（stdin にすると、ループの中の commandmatedev が残りの行を読み尽くす。下の注を参照）
while IFS="$(printf '\t')" read -r issue AGENT MODEL <&3; do
  WT=$(commandmatedev ls --branch "feature/${issue}" --quiet)
  if [ "$AGENT" = claude ]; then
    WT_PATH=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
    # モデルは起動時に固定される。既に Claude のセッションが動いていたら、task を作る「前」に止める
    commandmatedev instances "$WT" --json | jq -e '.[] | select(.instanceId == "claude" and .running)' > /dev/null \
      && commandmatedev instances "$WT" kill claude
    set_claude_model "$WT_PATH" "$MODEL" || { echo "exit=skip issue=${issue} (model not set)"; continue; }
  fi
  commandmatedev send "$WT" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" \
    --instance "$AGENT" --auto-yes --duration 3h \
    > "workspace/orchestration/runs/$DATE/send-${issue}.out" 2> "workspace/orchestration/runs/$DATE/send-${issue}.err"
  echo "exit=$? issue=${issue}"
  TASK_ID=$(head -1 "workspace/orchestration/runs/$DATE/send-${issue}.out")
  # 送れたことは exit code ではなく、サーバーに task ができたことで確かめる
  if curl -s "http://localhost:3000/api/worktrees/$WT/tasks" \
    | jq -e --arg id "$TASK_ID" '.tasks[] | select(.id == $id)' > /dev/null; then
    SENT=ok; echo "task ok issue=${issue} id=${TASK_ID}"
  else
    SENT=fail; echo "task MISSING issue=${issue}"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$issue" "$WT" "$AGENT" "$TASK_ID" "$MODEL" >> "workspace/orchestration/runs/$DATE/tasks.tsv"
  # run の記録（1-5）。送った HEAD を残す。再開時は status の next=send の Issue だけ送り直す
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --stage send --result "$SENT" --head "$(git -C "$WT_DIR" rev-parse HEAD)" --task "$TASK_ID" \
    --contract ".commandmate/tasks/issue-${issue}.yaml" --agent "$AGENT" --model "$MODEL"
  if [ "$AGENT" = claude ]; then
    # 起動したセッションが実際にどのモデルで動いているかを確かめる（SessionStart の hook とバナーから読まれる）
    GOT=$(commandmatedev capture "$WT" --instance claude --json | jq -r '.model // ""' | tr 'A-Z' 'a-z')
    case "$GOT" in
      *"$MODEL"*) echo "model ok issue=${issue} want=${MODEL} got=${GOT}" ;;
      "")         echo "model UNKNOWN issue=${issue} want=${MODEL}" ;;
      *)          echo "model MISMATCH issue=${issue} want=${MODEL} got=${GOT}" ;;
    esac
  fi
done 3< "workspace/orchestration/runs/$DATE/assign.tsv"
```

**assign.tsv を stdin で読まない**（2026-09-30 実測）: `while read …; done < assign.tsv` にすると、
ループの中の `commandmatedev`（`ls` / `send` / `capture`）が stdin を読み、残りの行を消費する。
上の雛形は fd 3 から読むので、ループの中のコマンドに `</dev/null` を付けなくてよい。雛形を書き換えて使うときも、
stdin で読む形に戻さないこと。ループを使わずに 1 件ずつ送るときは、各 `commandmatedev` に `</dev/null` を付ける。
`task MISSING` が出たら、その Issue は送れていない。`send-<issue>.err` を読み、3-1 の「冷間起動の失敗」に従って再送する。

根拠: docs/orchestrate/workers.md#3-1-assigntsv-を-stdin-で読んで止まった実測

**モデルの確認結果の扱い**:

- `model ok`: そのまま 3-2 へ
- `model UNKNOWN`: 20 秒おいて capture をもう一度読む。それでも空なら止めずに進め、8-2 のモデル欄に「未確認」と書く
- `model MISMATCH`: **1 回だけやり直す**。`commandmatedev instances "$WT" kill claude` → `cat "$WT_PATH/.claude/settings.local.json"` で中身を確かめる →
  同じ契約で再送し、tasks.tsv の task id を差し替える（exit 99 の再送と同じ扱い）。2 回目も MISMATCH なら、そのモデルのまま進めて 8-3 に書く
- tasks.tsv は 5 列になった（`issue` / `WT` / `AGENT` / `TASK_ID` / `MODEL`）。**`--instance` に渡すのは 3 列目の `AGENT`**（`claude`）で、5 列目ではない

stdout はパイプで切らずファイルに落とす（`| head` で切ると task が pending のまま残る）。
send の後に task が `cliToolId` / `instanceId` = 担当に紐づいていることを
`GET /api/worktrees/<WT>/tasks` で確かめる。

契約の goal だけでは足りない Issue（`/bug-fix` の調査手順、Phase 2.5 の分析結果の参照など）は、
**goal 本文にその指示を書く**。契約は送信メッセージそのものなので、素の send で送っていた文面は
すべて goal に入る。goal の先頭にスラッシュコマンドを書いても起動しないので、
必要な手順は goal に書き下す（2-4-2）。

- **冷間起動の失敗**: send が exit 99 で、stderr に `prompt not ready` と出たら、メッセージは送られていない
  （Codex / Command Code で実測。Antigravity は 2026-09-20 の run、#2770 で再発）。
  **待つ前に画面を見る。** 待ってから再送する手順だと、新規 worktree でほぼ必ず出る信頼ダイアログに
  2 分を払ったうえで 2 回目も同じ exit 99 になる（#2770 で実測）。

  exit 99 を受けたら docs/orchestrate/exit-codes.md#3-1-冷間起動の失敗-exit-99 を読み、画面ごとの表（信頼ダイアログ・既にプロンプト・まだ起動中）で分岐して再送する。

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

より詳細な監視は orchestrate-monitor skill を使う。monitor を起動するときは docs/orchestrate/workers.md#3-2-monitor-の起動と読み方 を読み、その手順（`hooks-task.sh` を付ける・Antigravity のワーカーは `<worktree-id>@antigravity` で渡す・起動直後に `monitor hooks ERROR` が無いことを確かめる・ログを絞るときは `ERROR|WARN|alive` を含める）で動かす。

**monitor の COMPLETE 判定をマージ可否の裁定に使わないこと。** 裁定は 3-3 の
`wait --verify` の exit code である。

### 3-3. 完了待機と検証（`wait --verify`）

**`scripts/orchestrate/wait-verify.mjs` で待つ**（#3477）。`commandmatedev wait --verify` を呼び、裁定が**作業の終わりの状態のもの**だと
確かめてから（下の「完了の合図」と「合図の前に始まった検証」をスクリプトが行う）Auto-Yes を切り、判定の行（`GATE` / `RESULT` / `Completed`）を
1 行に要約して、run の記録（1-5）の `verify` 段に、検証が見た HEAD つきで書く。
exit code は裁定（0 / 20 / 21）か wait のもの（10 / 124 …）なので、3-4 の表がそのまま使える。
**3 は「裁定を作業の終わりに結び付けられない」**（合図が `--signal-timeout`（既定 1800 秒）の間に出ない・検証の開始の後にコミットがあり `--task` が無い・
再検証の最中にコミットされた・合格なのに作業ツリーに未コミットの変更がある）。記録は `fail`。capture で状況を見て、待ち直すか再指示する。
1 は記録の失敗、2 は引数の誤り。

```bash
# tasks.tsv（3-1）は 1 行 = "<issue>\t<WT>\t<AGENT>\t<TASK_ID>\t<MODEL>"。fd 3 から読む（3-1 の注と同じ理由）
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL <&3; do
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  node scripts/orchestrate/wait-verify.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --wt "$WT" --worktree "$WT_DIR" --instance "$AGENT" --task "$TASK_ID" --model "$MODEL"
  echo "exit=$? issue=${issue}"   # wait のログは runs/$DATE/wait-<issue>.log
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

- スクリプトは `wait` に `--instance "$AGENT"` を必ず付ける（`wait` に `--agent` は無い。付けないと既定の claude を待つ）。
- `--on-prompt human` も必ず付ける。既定（`agent`）はプロンプト検出で即 exit 10 を返すため、
  監督ループが空回りする。
- **裁定が作業の終わりのものだと確かめてから Auto-Yes を切る**（`auto-yes "$WT" --disable --instance "$AGENT"`）。ワーカーが
  `/create-pr` などを composer に残していると、生きた Auto-Yes の Enter で確定してしまう。exit 124 / 10 と exit 3 の「作業中かもしれない」側では切らない。
  切った後に `capture --json` の `autoYes.enabled` を読み直し、切れていなければ 3 回まで再試行する。切れなかったら警告を出し、
  記録の要約に `auto-yes=NOT-disabled` と残す。切り直しだけをするときは `wait-verify.mjs --auto-yes-off --wt "$WT" --instance "$AGENT"`（切れなければ exit 1）。
  20 の再指示（3-4）の send には `--auto-yes --duration 3h` を付け直す
- 完了の確定（合図を待つ・検証の開始時刻と最後のターン終了とコミットを比べる）はスクリプトが行う。中身は exit 3 の理由を読むときに docs/orchestrate/workers.md#3-3-wait-verifymjs-が行う完了の確定 を読む
- **合格の記録は再利用しない。** 合格は task・契約（そのゲートの定義）・その task の開始時の env-clean の基準に結び付いていて、
  HEAD だけでは同じ確認と言えない（同じブランチに次の契約を送った直後も HEAD は同じ）。呼ぶたびに待って検証する。
  落ちた後の再開では、`run-log.mjs status` で `verify=ok` の Issue を呼び直さない（終わった task を `wait --verify` で裁定し直すと、
  紐づかない再検証になり #3118 の形で exit 20 になる）。裁定をやり直すときは `--after-reinstruct --task "$TASK_ID"`
- 再指示の後（3-4）は `--after-reinstruct --task "$TASK_ID"` を付ける。`--verify` を付けない wait → `verify --task` の 2 段になる
- Antigravity のワーカーの wait のログに `Prompt detected` が繰り返し出ても、それだけを見て介入しない。確かめ方は docs/orchestrate/antigravity.md#3-3-wait-のログの-prompt-detected を読む
- `--verify` は完了検出**後**に全ゲート（`work-evidence` ＋ `scope` ＋ verify.yaml の宣言ゲート）を
  実行し、その結果を exit code にする。ここが「完了したが壊れていた」を目視から exit code へ
  移す一点である。
- 契約の `gates` が `unit-related` のとき、`--verify` の裁定はテスト全体を含まない。テスト全体の合否は CI の `Unit Tests` で見る（6-2 の例外）。

**Antigravity 担当は、完了の合図（`IMPL_COMPLETED`）を確かめてから裁定する。**

根拠: docs/orchestrate/antigravity.md#3-3-途中でターンを閉じる理由

`wait-verify.mjs` を通さずに待ったとき（3-5・3-5b の `commandmatedev wait --verify` など）や、exit 3 の理由を確かめるときは、docs/orchestrate/antigravity.md#3-3-完了の合図を手で確かめる を読み、その手順で合図と検証の開始時刻を確かめる。

**完了検出が壊れているときは `verify --gates` へ退避する。** `wait --verify` はゲートの前に
完了検出を通すので、検出層の欠陥が裁定そのものを止める。

退避手順は docs/orchestrate/workers.md#3-3-完了検出が壊れたときの退避 を読む（`verify --gates` に渡すゲートの一覧と、そのとき落ちる `work-evidence` / `scope` を手で照合する方法）。

根拠: docs/orchestrate/workers.md#3-3-完了検出が壊れた実例

### 3-4. exit code 分岐

| exit | 意味 | 対応 |
|------|------|------|
| `0` | 完了・検証合格 | Phase 4（設計突合）／Phase 6（マージ）へ進む |
| `20` | 検証不合格（ゲートが落ちた） | 下記「20 の対応」。**再指示は上限2回**。超えたら Antigravity 担当は Claude（opus）へ切替（3-5）、Claude（sonnet）担当は opus へ格上げ（3-5b）、Claude（opus）担当は人間へエスカレーション |
| `21` | 作業証跡ゼロ（未着手） | 下記「21 の対応」 |
| `10` | プロンプト検出 | `commandmatedev capture <WT> --instance "$AGENT"` で内容確認 → `commandmatedev respond <WT> "<番号>" --instance "$AGENT"` → 再度 wait |
| `124` | タイムアウト | capture で状況確認 → 追加指示 or ユーザーに報告 |
| `3` | 裁定を作業の終わりに結び付けられない（`wait-verify.mjs`、3-3） | 記録の要約の `unconfirmed:` の理由を読む。作業中なら待ち直し、未コミットなら再指示 |

以降の `capture` / `respond` / `send` にも、すべて `--instance "$AGENT"` を付ける。

**20 の対応**（検証不合格）:

```bash
# 1 回目の run を読む（再実行しない）。直近の run id を取り、gates[] から失敗したゲートを読む
RUN_ID=$(commandmatedev verify history --worktree "$WT" --limit 1 --json | jq -r '.[0].id')
commandmatedev verify show "$RUN_ID" --json | jq '.gates[] | select(.status != "passed") | {gateId, status, logTail}'
```

`wait --verify` のログの `GATE <id> FAIL` 行で失敗したゲートを読んでもよい。
`--task` を付けずに `verify "$WT"` を再実行すると、task に紐づかない別の run になり、全ゲートが走る（scope は SKIP・env-clean は「ベースライン無し」）ので、ここでは再実行しない。

**先に、不合格がワーカー起因かを判定する。** 再指示と切替の回数に数えるのは、ワーカー起因の不合格だけである。

exit 20 を受けたら docs/orchestrate/exit-codes.md#3-4-20-の対応 を読み、その判定（ワーカー起因・ワーカー起因ではない 3 つの形・合図の前に始まった検証）で、再指示するか、オーケストレーターの裁定で合格として扱うかを決める。

ワーカー起因なら、失敗ゲートと `logTail` を添えて同じ worker に再指示する（契約は据え置き。再送は素の send でよく、
`--instance "$AGENT"` を付ける）。再指示は **同一 worktree につき最大2回**。
3回目に到達したら、**Antigravity 担当は 3-5 の手順で Claude に切り替える**。**Claude 担当は** worker を止め、ユーザーに判断を仰ぐ。

**再指示の後の裁定は `wait --verify` ではなく、`wait` → `verify --task` の 2 段で行う。**

```bash
# 1. 完了を待つ（--verify を付けない）
commandmatedev wait "$WT" --instance "$AGENT" --on-prompt human --timeout 10800
# 2. 契約の task を名指しして裁定する。$TASK_ID は tasks.tsv の 4 列目
commandmatedev verify "$WT" --task "$TASK_ID" --json
```

`--task` を付ければゲートは契約の `verify.gates` ＋必須の builtin（work-evidence / scope / env-clean）になるので `--gates` は要らない。

exit code の読み方は上の表と同じ。

根拠: docs/orchestrate/exit-codes.md#3-4-再指示の後に-2-段で裁定する理由

**21 の対応**（作業証跡ゼロ）: ワーカーは1行も書いていない。ほぼ常に起動側の問題なので capture で切り分ける。

```bash
commandmatedev capture "$WT" --instance "$AGENT" --pane --tail 30
```

画面ごとの対応（composer の未確定・Antigravity のアンケート画面・権限プロンプト・セッションの未起動）は、exit 21 を受けたら docs/orchestrate/exit-codes.md#3-4-21-の対応 を読み、その手順で切り分ける。

### 3-5. Antigravity から Claude への切り替え

Antigravity 担当の Issue が、ワーカー起因の不合格を 2 回再指示しても合格しなかったとき（3-4 の 3 回目）に行う。
ユーザーには確認しない（2026-09-17 合意）。切り替えたことは 8-2 と 8-3 に必ず書く。

切り替えるときは docs/orchestrate/switching.md#3-5-antigravity-から-claude-への切り替え を読み、その手順 1〜4（Antigravity のセッションだけを止める・引き継ぎ節つきの Claude 用の契約を作る・opus で送る・以降は 3-4 に従う）で進める。

### 3-5b. sonnet から opus への格上げ

Claude（sonnet）担当の Issue が、ワーカー起因の不合格を 2 回再指示しても合格しなかったとき（3-4 の 3 回目）に行う。
ユーザーには確認しない。格上げしたことは 8-2 と 8-3 に必ず書く。**モデルは起動時に固定されるので、セッションを作り直す以外に上げる方法は無い。**

格上げするときは docs/orchestrate/switching.md#3-5b-sonnet-から-opus-への格上げ を読み、その手順 1〜5（Claude のセッションだけを止める・モデルの指定を外す・opus 用の契約を作る・送ってモデルを確かめてから待つ・以降は 3-4 に従う）で進める。

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
指示の反映は、3-4 の同じ手順（`wait` → `verify --task "$TASK_ID"`）で裁定する。

**`--phase impl` 指定時**: 全ワーカーの実装完了を確認して終了。

---

## Phase 5: 品質確認

### 5-1. 検証ゲートの実行

Phase 3 の `scripts/orchestrate/wait-verify.mjs`（3-3）が exit 0 を返し、run の記録にその HEAD の `verify=ok` があれば
（`run-log.mjs status` で確かめる）、そのワーカーの品質は**既に裁定済み**なのでこのフェーズは飛ばしてよい。
契約無しで委任した場合（`--contract` が使えない CLI など）だけ、オーケストレーターが直接ゲートを回し、結果を run の記録に書く:

```bash
while IFS="$(printf '\t')" read -r issue WT AGENT TASK_ID MODEL <&3; do
  WT_DIR=$(commandmatedev ls --json | jq -r --arg id "$WT" '.[] | select(.id == $id) | .path')
  commandmatedev verify "$WT" --json > "workspace/orchestration/runs/$DATE/verify-${issue}.json"; RC=$?; echo "exit=$RC"
  node scripts/orchestrate/run-log.mjs append --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
    --issue "$issue" --stage verify --result "$([ "$RC" = 0 ] && echo ok || echo fail)" \
    --head "$(git -C "$WT_DIR" rev-parse HEAD)" --agent "$AGENT" --note "exit=$RC (verify without a contract)"
done 3< "workspace/orchestration/runs/$DATE/tasks.tsv"
```

**CI にあって手元のゲートに無い手順は、`tests/unit/guards/ci-steps-local-coverage-3478.test.ts` の除外の一覧（理由つき）にだけ置く**（#3478）。
shellcheck は `lint-sh` ゲート（`scripts/run-lint-sh-if-changed.mjs`。`.sh` を変えたときだけ `npm run lint:sh`）が見る。
orchestrate の道具の置き場所は #3477 で `scripts/orchestrate/`（`lint:sh` の走査の中）に決まったので、`.claude/skills/**` は走査に足さない。

**ワーカーに「lint/tsc/test を実行して結果を報告して」と送らないこと。** 報告文の解析は
「全部 Pass です」という散文を信じることであり、`wait --verify` / `verify` の exit code が
置き換えた当のもの。exit code は `0`=合格 / `20`=不合格 / `21`=作業証跡ゼロ。

### 5-2. 品質NGの場合

`--json` の失敗ゲートと `logTail` を添えてワーカーに修正を指示し、再度 `verify`。
最大3回まで自動リトライ。

### 5-2b. 整合性レビュー（試行中の段、2026-10-20 まで）

#3308 の試行（整合性レビュー、30 回・22 本）を受けた利用者の判断（2026-10-06）により、**対象を絞って、期限付きで続ける。** 常設はしない。期限の後に、数えた結果で続ける・入れる・やめるを決める。

- **期限:** 2026-10-20 まで（2 週間）。期限の日に、下の数え方で集計し、Codex のレビューを受けてから利用者に伺う
- **対象（変更の影響で選ぶ。接頭辞の一律の除外はしない）:** 危険な変更（hook・セッション・検出・ポーリング・tmux・security・応答の形・隔離）と、対になる場所がある変更。refactor でも、共有の処理を動かすもの・検証の条件を変えるものは対象に残す。docs だけ・テストだけは除く。**除外した PR からも、run ごとに 1 本を抜き出してレビューし、偏りを確かめる**
- **段:** ワーカーの完了の後・PR の前。依頼したときの HEAD を記録し、その後の変更と区別する。ワーカーの「対になる場所を探した結果」（2-4-2）を入力に使い、レビューの独自の発見を見分ける
- **担当:** Codex（暫定。優位が実証されたとは扱わない）。Claude を足すのは、重大な変更・ワーカーが「未確認」と書いた所・判断が割れた所（隔離・所有・security に限らない）
- **再レビュー:** 自動は 3 回まで。3 回目の後に重大な指摘が残ったら、**止めて人の判断へ**（別の Issue に送ってマージしない）
- **進め方と記録:** 対象の PR でレビューするときは docs/orchestrate/trials.md#5-2b-整合性レビューの進め方と記録 を読み、その手順（Codex のセッション・数え方・記録の様式・再指示の書き方・前回の指摘の確かめ方）で行う

**2026-10-20 の集計の手順。** 期限の日に docs/orchestrate/trials.md#5-2b-2026-10-20-の集計の手順 を読む。

### 5-3. 「本文に無い指摘」を処置する（Phase 6 の前・マージの条件）

ワーカーが報告した「本文に無い指摘」を、オーケストレーターが 1 件ずつ、次のどれかに決めて、run の記録（8-2）に書く。

- 再指示する（契約の範囲を広げて、同じ PR で直す）
- 追跡する Issue にする（8-4）
- 対応しない（理由を書く）

計測の誤り（数え方の穴）の報告は、ワーカーに直させない。計測の誤りは、別の Issue にして計測を直す（#3270 → #3389）。

**未処置の指摘が残っている PR は、マージしない。** 報告を一覧に残すだけでは、指摘は最後まで処置されない。

根拠: docs/orchestrate/ci-merge.md#5-3-未処置の指摘が残った実例

PR を出す前に、次も確かめる:

- **ガードのテスト（`tests/unit/guards`）を全部通す。**
- **検証の順番待ちの間に、オーケストレーターが worktree にコミットしない。**

根拠: docs/orchestrate/ci-merge.md#5-3-pr-の前の確認の実測

---

## Phase 6: PR作成・マージ

PR の作成とマージは、次の 2 本のスクリプトを呼ぶ（#3477）。ワーカーに `/create-pr` を送る流れは使わない。止まる条件と run の記録を持たないためである。

- `scripts/orchestrate/publish-pr.mjs`（6-1）: push・module-reference の断片の控え（`runs/$DATE/module-reference-<N>.md`）・PR の作成。記録の `pr` 段
- `scripts/orchestrate/merge-pr.mjs`（6-2・6-3）: develop が進んでいれば試しのマージ・CI の待ち（落ちたジョブは HEAD ごとに 1 回だけ再実行）・
  squash でマージ・Issue のクローズ（`--close -` なら閉じない。1 本の Issue を複数の PR に分けたときの途中の PR など）。記録の `ci`・`merge` 段

**止まる条件。** どちらも、run の記録に、**作業の HEAD**（ワーカーの最後のコミット）の `verify=ok`（3-3・5-1）・`review=ok`（5-2b）・`findings=ok`（5-3）と、
**公開する HEAD**（push する・マージする HEAD）の `precheck=ok`（6-1-1）が無ければ、何も公開せずに止まり、欠けたものを出す（exit 1）。
**5-2b の対象でない Issue は `review` 段に `skip` を記録しておく**（忘れたレビューと、対象でないレビューを区別するため）。
公開する HEAD は、作業の HEAD そのものか、その上に develop の取り込み（6-2）と module-reference の一本化だけのコミット（6-4）を重ねたもの。
重ねたときは、その HEAD の precheck が要る（`merge-pr.mjs` は無ければ自分で走らせ、`publish-pr.mjs` は止まる）。
この判定は `run-log.mjs status` と同じ関数（`unmetStage`）で行い、記録には両方の HEAD を書く（`head` と `workHead`）ので、再開先と公開側の判定がずれない。
衝突の印が追跡ファイルにある・`changelog.d/<N>.md` がコミットに無い・module-reference の断片が無いときも止まる（6-4）。

**二重に実行しない。** ブランチに開いた PR があれば作らない（push だけして、その PR を記録する）。別のブランチの開いた PR が同じ Issue を指していれば止まる
（題名の `(#<N>)`、`/create-pr` が書く本文の `Closes #<N>`（`Fixes` / `Resolves` / `Refs` も）、ブランチ名の番号）。
マージ済みの PR はマージしない（記録が無ければ記録し、Issue が開いていれば閉じるだけ）。どちらも、途中で落ちた後に同じ引数で再実行すると続きから同じ結果になる。

ただし**並列オーケストレーションでは次を守る**。

### 6-1. 同時 CI は 3〜4 本。**1 本に落とすのも失敗である**

根拠: docs/orchestrate/ci-merge.md#6-1-同時本数の前提

根拠: docs/orchestrate/ci-merge.md#6-1-同時に回す本数の実測

裁定が終わったワーカーが 5 本目以降になったら、PR を作らずに待たせる。worktree は残してよい。

PR は 6-1-1 の確認（precheck）が通ってから出す:

```bash
node scripts/orchestrate/publish-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR" --label feature   # ラベルは種類に応じて feature / bug / documentation / refactor
echo "exit=$?"   # 0 → PR がある（作った・既に開いていた・マージ済み） / 1 → 出力の欠けた記録・断片を埋めて再実行 / 2 → 作業ツリーが汚れている
```

### 6-1-1. PR はゲートの**前**に出す（CI とローカルゲートを並走させる）

`wait --verify` / `verify --gates` のローカルゲートと CI は**同じテストを見ている**。

**PR の前は速い確認（`scripts/orchestrate/precheck.mjs`、#3477）だけを通して PR を出し、
残りのゲート（`integration` / `unit` / `build`）は CI と並走させる。**

根拠: docs/orchestrate/ci-merge.md#6-1-1-並走させる理由

```bash
# 段の順: verify（3-3）→ review（5-2b）→ findings（5-3）→ precheck → PR → CI（残りのゲートと並走）→ merge
node scripts/orchestrate/precheck.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR"            # 整理の Issue は --kind refactor、計測の Issue は --metrics を足す
echo "exit=$?"   # 0 → PR を出す / 1 → runs/$DATE/precheck-<issue>-<sha>.log で落ちた段を読み、再指示 / 2 → 作業ツリーが汚れている
```

- precheck の段（何を走らせるか）と、結果を走らせずに再利用する条件は、precheck が落ちたときと、走らずに再利用されたことを確かめるときに docs/orchestrate/ci-merge.md#6-1-1-precheck-の段と再利用 を読む
- **build は PR の前の確認に入れない（CI の `Build` と並走させる）。** その代わり、マージの前に CI の `Build` が `pass` であること、
  または同じ HEAD の precheck の記録に `build=ok`・`build-cli=ok`・`build-server=ok` があること（`--build` を付けて走らせたとき。CI の `Build` と同じ 3 つ）を確かめる（6-2・6-3）

### 6-2. マージは「先行をマージ → 後続を refresh → tsc ＋ 影響テスト → マージ」

**`gh pr view --json mergeable` の `MERGEABLE` は「テキスト衝突が無い」しか意味しない。
組み合わせがコンパイルできる証拠ではない。**

根拠: docs/orchestrate/ci-merge.md#6-2-統合破壊の実測

マージの条件の 1 つとして、**未処置の指摘（5-3）が残っている PR はマージしない**。

1 本マージするたびに、残りの各 PR で `merge-pr.mjs` を呼ぶ。develop が進んでいれば `git fetch` と `git merge origin/develop`（衝突したら
`git merge --abort` して止まる）を行い、**マージする HEAD について**（取り込んだ HEAD・`publish-pr.mjs` が先に push した取り込みの HEAD・未 push の HEAD のどれでも）
衝突の印の走査（全追跡ファイル）と、その HEAD の precheck（`precheck.mjs`。`npx tsc --noEmit` で実際の統合破壊が出て、`vitest related --dir tests/unit` が import の関係
（`@/` の alias を含む）で選ぶテストと、変えたパスを名指しするテスト・ガードで、型に出ない相互作用が出る）を通してから `git push` する。
precheck は作業の HEAD の precheck と同じ引数で走り、同じ HEAD の `precheck=ok` が記録にあれば走らせない。どれかが落ちたら push せずに止まる。

```bash
node scripts/orchestrate/merge-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue "$issue" --worktree "$WT_DIR"            # 最後の 1 本は --last。Issue を閉じないときは --close -
echo "exit=$?"   # 0 → マージ済み / 1 → 出力の欠けたもの・落ちた段を読む / 2 → 作業ツリーが汚れている / 124 → CI が --ci-timeout（既定 3600 秒）に収まらない
```

衝突で止まったときは、意味を見て解消（機械解決は module-reference などの共有ファイルだけ）してコミットし、同じ引数で再実行する。

機械的に解決してよい衝突は、`docs/module-reference.md` などの共有ファイルでだけ起こりうる。CHANGELOG の断片は
Issue ごとに別ファイル（`changelog.d/<N>.md`）で、`CHANGELOG.md` はリリースまで書き換えないので、ここでは衝突しない（2-4-1）。

**マーカー走査を共有ファイル（`docs/module-reference.md` など）の決め打ちにしないこと。**

根拠: docs/orchestrate/ci-merge.md#6-2-コメントの中の衝突マーカーの実例

上記が通れば**フル CI の完走を待たずにマージしてよい**。develop 側の CI（12〜25 分）が安全網に
なる。**最後の 1 本だけ**はフル CI を待つ。

**例外: 契約の `gates` が `unit-related` の PR は、CI の `Unit Tests` が `pass` になってからマージする**（#2639）。
ローカルの裁定がテスト全体を含まないため。整理の契約（`lint`・`typecheck` だけ、2-4-3）も同じ。`merge-pr.mjs` は、検証が verify.yaml の `unit`
（テスト全体）を通していないかぎり `Unit Tests` を待つ（契約が定義した `unit@contract` は代わりにしない）。

**例外: build。CI の `Build` が `pass` になってからマージする**（#3477）。6-1-1 で build を PR の前の確認から外し、契約の既定のゲートにも
precheck にも build が無いので、ローカルのどの裁定もビルドを見ていない。ただし、マージする HEAD（refresh の後の HEAD）の precheck の記録に
`build=ok` があれば（`precheck.mjs --build`）、`Build` の `pending` は待たなくてよい。`--build` は CI の `Build` と同じ 3 つ
（`npm run build`・`build:cli`・`build:server`）を走らせ、`build=ok`・`build-cli=ok`・`build-server=ok` が揃ったときだけ代わりになる。ほかのジョブの扱いは上のとおり。

マージ（または close）すると、**その PR の `pull_request` run は
`.github/workflows/cancel-pr-runs-on-close.yml` が自動で止める**（Issue #2330）。**手でキャンセル
しないこと。** マージ後に PR のチェックが `cancelled` と表示されるのは**正常であって失敗の証拠では
ない** — 裁定を出すのは develop 側の push run のほうである。この自動キャンセルは
`--event pull_request` と PR の head ref で絞るので、**develop / main の push run には構造的に
届かない**（＝安全網は止まらない）。

### 6-3. マージ前に `fail` / `cancel` が無いことを機械的に確認する

`gh pr checks <PR> --json name,bucket` を読み、**`bucket` に `fail` / `cancel` が 1 つでも
あればマージしない**。判定は目視ではなくスクリプトで行うこと。

根拠: docs/orchestrate/ci-merge.md#6-3-fail-を見落とした実例

`merge-pr.mjs` がこの判定を行う（落ちたジョブは HEAD ごとに 1 回だけ `gh run rerun --failed` で再実行し、それでも落ちればマージしない）。
`pending` の扱いは 6-2 に従う: **6-2 のローカルゲート（refresh → マーカー走査 → `tsc` →
影響テスト）を通していれば `pending` は待たなくてよい**。develop 側の CI が安全網になるからで、
待つと 1 issue あたり 12〜25 分が消える。**最後の 1 本だけ**は全 `pass` を待つ。

`unit-related` で裁定した PR（と、テスト全体を通していない整理の PR）では、`Unit Tests` のチェックが `pass` になってからマージする（6-2 の例外）。
`Build` のチェックも `pass` になってからマージする（6-2 の例外。マージする HEAD の precheck の記録に `build=ok`（と `build-cli=ok`・`build-server=ok`）があるときだけ、その `pending` は待たなくてよい）。

`merge-pr.mjs` が `Build` について見る条件は次と同じ（手で確かめるときもこれを使う）:

```bash
# Build が pass か、マージする HEAD に build=ok の precheck の記録があるか。どちらも無ければマージしない
gh pr checks "$PR" --json name,bucket | jq -e '.[] | select(.name == "Build" and .bucket == "pass")' > /dev/null \
  || jq -e --arg h "$(git -C "$WT_DIR" rev-parse HEAD)" --argjson n "$issue" \
       'select(.issue == $n and .stage == "precheck" and .head == $h and .result == "ok" and (.note | test("(^| )build=ok( |$)") and test("(^| )build-cli=ok( |$)") and test("(^| )build-server=ok( |$)")))' \
       "workspace/orchestration/runs/$DATE/run-$RUN_ISSUES.jsonl" > /dev/null \
  || echo "NOT mergeable: Build is not pass and there is no build=ok precheck for this HEAD"
```

### 6-4. module-reference の断片を本体へ一本化する（オーケストレーターの仕事）

2-4-1 でワーカーに書かせた module-reference の断片を、**オーケストレーターが PR ブランチ上で
本体へ写してから push する**（マージの直前、6-2 の refresh と同じタイミング）。
CHANGELOG は書き写さない。ワーカーがコミットした `changelog.d/<N>.md` を、リリース時に `/release` が
`CHANGELOG.md` へ集約する（2-4-1）。

```bash
# module-reference: 行キーごとに既存行の注記セルへ追記（行を増やさない）。
# publish-pr.mjs が PR を出すときに run のディレクトリへ控えている（dev-reports/ は worktree と一緒に消える）
cat "workspace/orchestration/runs/$DATE/module-reference-<N>.md"
```

一本化のコミットは `docs/module-reference.md` だけを変える。`merge-pr.mjs` はこのコミットを越えてワーカーのコミットの `verify`・`review`・`findings` を使い、
一本化の後の HEAD の precheck は自分で走らせる（ほかのファイルも変えたコミットを足すと、そのコミットが作業の HEAD になり、`verify` から止まる）。

一本化したら**必ず機械的に検証する**:

```bash
# module-reference: 同じ行キーが 2 本になっていない
awk -F'|' '/^\| `/{print $2}' docs/module-reference.md | sort | uniq -d
```

`changelog.d/<N>.md` がこの PR のコミットにあることと断片の書式、消えた `it` / `describe` の数は、`publish-pr.mjs`・`merge-pr.mjs` と precheck（6-1-1）が確かめる。手で確かめるときは docs/orchestrate/ci-merge.md#6-4-断片と消えたテストを手で確かめる を読む。

**断片が無い PR はマージしない**（`publish-pr.mjs`・`merge-pr.mjs` が止まる）。`changelog.d/<N>.md` がコミットに含まれていない PR も、
module-reference の断片が無い PR も同じ扱いにする。リリースノートに載らない Issue が出る。`check` が exit 0 にならない PR もマージしない
（リリース時の `apply` は、1 つでも不正な断片があると何も書かずに止まる）。

根拠: docs/orchestrate/ci-merge.md#6-4-断片が無い-pr-の実例

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

| Issue | 難易度 | 担当 | モデル（実測） | 判定の根拠 | 再指示 | 切替 | 実装時間 | 検証 | 帰属の裁定 |
|-------|--------|------|---------------|-----------|--------|------|---------|------|-----------|
| #{N} | 易 | antigravity | — | {plan.md の根拠} | 0 | なし | 5 分 | exit 20 → 合格扱い | env-clean の違反はワーカー起因でない（{根拠}） |
| #{M} | 易 | antigravity → claude | opus | {根拠} | 2 | 切替（{失敗ゲート}） | {分} | exit 0 | — |
| #{L} | 中 | claude | sonnet（`claude-sonnet-5-5`） | {根拠} | 0 | なし | {分} | exit 0 | — |
| #{K} | 中 | claude | sonnet → opus | {根拠} | 2 | 格上げ（{失敗ゲート}） | {分} | exit 0 | — |

「モデル（実測）」には、3-1 で `capture --json` の `.model` から読んだ値を書く（指定した値ではなく、動いていた値）。

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
- sonnet から opus への格上げ（3-5b）、または sonnet 担当が再指示を要した（1-2b の「中」の条件が甘い証拠になる）
- `model MISMATCH` / `model UNKNOWN` のまま進めた（3-1）
- ワーカー起因でない不合格を、オーケストレーターの裁定で合格扱いにした（3-4）
- 判定表と実際の結果が食い違った（「易」と判定したのに再指示が要った／「難」と判定したが小さい変更で終わった）
- Antigravity 固有の停止（アンケート画面、冷間起動の失敗、monitor の誤判定など）

各項目には次の 3 つを書く:

1. **事実**: Issue、担当、何が起きたか（ゲート名・時刻・コマンド）
2. **原因の見立て**: 判定表のどの観点が外れたか。または、道具のどの欠陥か
3. **改善案**: 判定表の条件の足し引き、goal の雛形（2-4-2。`scripts/orchestrate/templates/goal.md`）の追記、道具の Issue 起票の要否。
   起票はユーザーの了承を得てから行う

**起票の前に、同じ不具合の開いている Issue を探す**（UAT の指摘・ワーカーの報告・8-3 の改善案のどれでも）。
日次確認（`agent-health`）は、毎朝 07:00 の Schedule が `<!-- agent-health:<tool>:<checkId> -->` を本文に入れた Issue を自動で起票する。
並行する別のセッションやワーカーが、先に起票していることもある。

```bash
gh issue list --repo Kewton/CommandMate --state open --label agent-health --json number,title,createdAt
gh issue list --repo Kewton/CommandMate --state open --search "<ファイル名か関数名> in:body" --json number,title,createdAt
```

見つかったら新しく起票せず、その Issue に追加の事実をコメントする。自動起票の Issue は残す
（翌朝の Schedule は `agent-health:<tool>:<checkId>` を本文に持つ開いた Issue を探してコメントするので、手で起票した別の Issue では重複を防げない）。

根拠: docs/orchestrate/report.md#8-3-重複を起票した実例

**bug として新しく起票するときの「分類」節**:

不具合を bug Issue として起票するとき（`gh issue create --label bug --body …` でテンプレートを通らないときも）、本文の末尾に次の「分類」節を置く。
値は決まった語から選ぶ（`.github/ISSUE_TEMPLATE/bug_report.md` と同じ語。日次メトリクスの `bug-flow` がこの節を数える）。

```markdown
## 分類
- 原因の PR: #<番号> / 不明 / なし（以前から）/ 上流（<CLI> <版>）
- 発見経路: uat / review / orchestrate / daily-use / automated
- 影響する経路: chat / terminal / cli / mobile / auto-yes / push / なし（内部）
```

- 各行は 1 つを選んで書き換える（例: `- 原因の PR: #3191`、`- 原因の PR: 上流（codex 0.50.0）`、`- 発見経路: uat`）。
  影響する経路だけは複数を `, ` で区切って書ける（例: `- 影響する経路: chat, mobile`）。選択肢を残したままの行は「未記入」に数えられる
- 影響する経路は取りこぼしを防ぐ欄。直す人は、挙げた経路すべてを確かめる
- 影響する経路が `なし（内部）`（テスト・CI・開発用スキル・agent-health・orchestrate）なら、`bug` に加えて `internal` ラベルも付ける
  （`gh issue create … --label bug --label internal`）

### 8-4. 整理の Issue の候補

ワーカーが報告した重複（1-2b の退避路の「本文に無い指摘」）を、整理の Issue の候補として利用者に示す。
報告を一覧に残すだけでは、重複は減らない。run の最後に、起票するかを必ず訊く。

1. `workspace/orchestration/runs/$DATE/refactor-candidates.md` の一覧を、summary.md の末尾の「整理の Issue の候補」節に写す。
   1 件 1 行で、報告した Issue・`file:line`・何と何が写しかを書く。候補が無ければ「候補なし」と書く
2. 完了報告で、候補を整理の Issue として起票するかを、利用者に訊く。起票は了承を得てから行う（8-3 と同じ）
3. 起票の前に、同じ内容の開いている Issue を探す（8-3 の手順）。見つかったら新しく起票せず、その Issue にコメントする
4. 起票する Issue には、まとめる写しの場所（`file:line`）と、振る舞いを変えないことを書く。契約は 2-4-3 の型で書く

5. 意図して残した制限を、追跡する Issue にする。「この PR では直さなかった」「この条件のときは誤る」と分かっているものは、
   コードのコメントやコミット文に書くだけで済ませない。1 件 1 Issue で、残した場所（`file:line`）・誤る条件・直さなかった理由を書く
   （起票は 2 と同じく了承を得てから行う）。5-3 で「追跡する Issue にする」と決めた指摘も、ここで起票する

写しどうしに食い違いがある報告は、整理の候補に混ぜない。振る舞いを変えずには、1 つにできないからである。
仕分け用の Issue に集める（2-4-3 の「範囲外の食い違い」）。

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| developブランチでない | エラー表示し中断 |
| CommandMateサーバー未起動 | `commandmatedev start --daemon` を案内 |
| worktree作成失敗 | エラー表示、手動作成を案内 |
| ワーカーのタイムアウト（exit 124） | captureで状況確認→追加指示 or ユーザーに報告 |
| 検証不合格（exit 20） | `verify --json` で失敗ゲートを特定し、先にワーカー起因かを判定（3-4）。ワーカー起因なら再指示。上限2回で、Antigravity 担当は Claude（opus）へ切替（3-5）、Claude（sonnet）担当は opus へ格上げ（3-5b）、Claude（opus）担当は人間へエスカレーション |
| env-clean だけが FAIL（exit 20） | `capture --prompts` と違反項目の時刻で帰属を判定。ワーカー起因でなければ合格扱いにし、根拠を PR と summary に書く（3-4） |
| 再指示の後の検証で scope が SKIP（`was not attached to it`）／env-clean が `no baseline snapshot exists for this run` | task に紐づいていない。`verify --task <task id>` で検証し直す（3-4） |
| 作業証跡ゼロ（exit 21） | captureでcomposer未確定・権限プロンプト・未起動を切り分け（Phase 3-4） |
| send が exit 99（`prompt not ready`） | 未送信。**待つ前に capture で画面を見て**、信頼ダイアログ / 既にプロンプト / まだ起動中で分岐する（3-1 の表）。task id は再送のたびに差し替える |
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
- [ ] 各Issueの `changelog.d/<N>.md` がコミットに含まれ（`check` が exit 0）、module-reference の注記が本体に一本化されている（6-4）
- [ ] developブランチでの統合ビルド・テストが全パス
- [ ] （--full時）UAT全テストPASS
- [ ] 統合サマリーが出力されている（「担当と結果」表を含む。3-5 の切替か 3-4 の帰属裁定があった run では「振り分けの改善案」も含む）

## 関連コマンド

- `/pm-auto-issue2dev`: Issue単位の全自動開発（機能Issueに送信）
- `/bug-fix`: バグ調査→修正→テスト（バグIssueに送信）
- `/cause-analysis`: 根本原因分析（他エージェント経由、バグIssueのPhase 2.5で使用）
- `/current-situation`: 不具合事象の整理とIssue登録
- `scripts/orchestrate/publish-pr.mjs` / `merge-pr.mjs`: PR作成からマージ完了まで（Phase 6）
- `/uat`: 受入テスト
- `/uat-fix-loop`: UAT不合格時の修正ループ
- `/issues-exec-plan`: 複数Issueの実行計画策定
- `/worktree-setup`: worktree個別作成
- `/worktree-cleanup`: worktree個別削除
