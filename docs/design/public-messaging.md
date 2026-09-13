# 公開面 発信仕様（Public Messaging）

CommandMate の公開面（LP `website/` ・ README ・ チュートリアル ・ product-highlights ・ デモ動画）が
使う文言の **単一ソース**。Issue #1808（Epic #1807 Step A）で確定し、Issue #2493 で
**orchestrate を看板にした軸**へ改訂した。Issue #2549（Epic #2548）で、LP に足す節の文言
（§3b〜§3e ・ §13 FAQ ・ §14 Trust）と禁止語 3 語を追記した。

- 各面はこのファイルから **コピーして使う**。独自に言い換えない
- 言い換えたくなったら、まずこのファイルを直し、その差分で各面を追随させる
- ここに無い項目を新しく発明するより、ここに追記してから使うほうが速い
- 概念の正本（Vision / Mission / 中核原則 / 実装）は [docs/concept.md](../concept.md) ・
  [docs/en/concept.md](../en/concept.md)。このファイルは **その公開面向けの文言表** である

ガードは [`tests/unit/docs/public-messaging.test.ts`](../../tests/unit/docs/public-messaging.test.ts)。

---

## 1. Hero（LP 冒頭）

**採用案: orchestrate 軸**（Issue #2493）。Epic #1807 D6 の対比型 H1 を差し替えた。

理由: 読者が肯定形で自分に使う語は「orchestrate」であり、「vibe」を自称に使う人はいない
（2026-09-11〜12 の Reddit 調査。要点は Issue #2493 本文）。軸語 "Vibe Engineering" は
**思想の名**として §2 に残し、hero では **誰が指揮し、何が完了を決めるか**を先に言う。
「orchestrator」は製品の名詞にしない（動詞・形容 orchestrated で使う）。verify は H1 と同じ行に置く。

| 項目 | 文言 |
|---|---|
| H1（en / LP 本番） | One agent leads. Gates decide what's done. |
| H1（ja / README ja ・ 日本語面） | 指揮するのは、いつもの Agent。判定するのは、ゲート。 |
| lede（en、2 文） | CommandMate gives your lead agent the machinery to run the others: one Git worktree and one contract per task, gates that decide what is done, and a record of every run. Claude Code, Codex, Antigravity, Command Code, OpenCode, Gemini CLI, Copilot and local models. You approve; you don't relay. |
| lede（ja、2 文） | CommandMate は、あなたの lead エージェントに、ほかのエージェントを走らせる仕組みを渡します。タスクごとに Git worktree 1 つと契約 1 つ、完了を決めるゲート、そして毎回のランの記録。Claude Code ・ Codex ・ Antigravity ・ Command Code ・ OpenCode ・ Gemini CLI ・ Copilot、そしてローカルモデル。あなたがやるのは承認であって、伝言ではありません。 |
| 事実行（en） | Open source (MIT) · runs on your machine · macOS / Linux / Windows (WSL2) · no app to install |
| 事実行（ja） | オープンソース（MIT） · あなたのマシンで動く · macOS / Linux / Windows（WSL2） · アプリのインストールは不要 |

事実行は hero の直下に 1 行で置く。**比較ではなく事実として**書く（「〇〇と違って」を付けない）。

> **lede の「2 文」の数え方**: 制約「lede は 2 文以内」（Epic #1807）はいまも生きている。
> lede のピリオドは 3 つあるが、述語を持つ文は `CommandMate gives …` と
> `You approve; you don't relay.` の 2 つで、間の `Claude Code, Codex, … and local models.` は
> 対応エージェントを並べただけの名詞句である。**3 文に割らないこと**（割ると LP の hero が 3 行になる）。

> **旧 H1 の扱い**: `From vibe coding to Vibe Engineering.` ／ `vibe coding から、Vibe Engineering へ。` は
> 廃止していない。**§2 の「思想の名」へ降ろした**（README / LP では Philosophy 節の `##` 見出し）。

---

## 1b. More agents, same you（Problem）

エージェントを増やしたあとに残る困りごと。LP / README では hero の直後、思想（§2）より前に置く。
**解決策ではなく、読者の言葉で書く**。節番号が `1b` なのは、既存の §2 以降の番号をずらさないためである。

### en

```
## More agents, same you
- The agents are parallel. You are still single-threaded.
- From the outside, an idle agent and one waiting on you look the same.
- The agent's summary of what it did is not evidence of what it did.
- Nobody can safely merge a PR that nobody understands.

CommandMate puts the machinery around the CLIs you already run: a lead that hands out contracts, session state read from the agents' own hooks, gates after the work, and the record in between.
```

### ja

```
## エージェントは増えた。あなたは 1 人
- エージェントは並列になった。あなたはいまもシングルスレッドのままだ。
- 外から見ると、遊んでいるエージェントと、あなたの入力を待っているエージェントは同じに見える。
- エージェントが書いた「やったこと」の要約は、やったことの証拠ではない。
- 誰も理解していない PR は、誰も安全にマージできない。

CommandMate は、あなたがすでに動かしている CLI のまわりに仕組みを置く。契約を配る lead、エージェント自身の hooks から読んだセッション状態、作業のあとのゲート、そしてその間の記録。
```

---

## 2. 思想の名と定義文

**この 2 文は逐語で固定する**。concept.md（ja / en）と LP が同じ文字列を持つことをテストで固定している。

思想の名（旧 hero H1。README / LP では Philosophy 節の `##` 見出しとして使う）:

| 言語 | 思想の名 |
|---|---|
| en | From vibe coding to Vibe Engineering. |
| ja | vibe coding から、Vibe Engineering へ。 |

hero（§1）が「誰が指揮し、何が完了を決めるか」を言い、この節が「なぜそうするのか」を言う。

下の表の en 行は `def:en` の HTML コメントマーカーで囲ってある。LP のガード
（[`tests/unit/website/landing-page.test.ts`](../../tests/unit/website/landing-page.test.ts)）は
マーカーの中身を読んで `website/index.html` と突き合わせるので、**マーカーを外さないこと**
（外すとテストは「照合対象が無い」で落ちる。文言を直したいときはマーカーの中を直す）。

| 言語 | 定義文 |
|---|---|
| en | <!-- def:en -->Vibe Engineering — the AI does the building; the system, not your expertise, guarantees the engineering.<!-- /def:en --> |
| ja | Vibe Engineering — 作るのは AI。エンジニアリングを保証するのは、あなたの専門知識ではなく仕組み。 |

添える一節（芯）:

| 言語 | 一節 |
|---|---|
| en | We do not make the AI smarter. We make the software-engineering ability its user needed into a system. |
| ja | AI を賢くするのではなく、AI を使う側に必要だったソフトウェアエンジニアリング能力を仕組み化する。 |

---

## 3. 4 カード（タイトル + 1 文）

| # | タイトル（en） | 1 文（en） | タイトル（ja） | 1 文（ja） |
|---|---|---|---|---|
| 1 | One agent leads | One message to your lead session; it hands each task to a worker in its own worktree under a contract, and only what passes the gates comes back. Measured with Claude Code and Command Code as the lead. | 指揮するのは 1 体のエージェント | lead セッションへ 1 通送れば、各タスクはそれぞれの worktree にいる worker へ契約つきで渡り、ゲートを通ったものだけが返ってくる。lead としての実測は Claude Code と Command Code。 |
| 2 | Verified, not vibe-checked | Gates you declared decide whether the work is done, and the exit code is the verdict. The agent's summary is not the evidence; the run is. | 「たぶん動く」ではなく検証済み | 完了を決めるのはあなたが宣言したゲートで、判定は実 exit code である。証拠はエージェントの要約ではなく、ランそのものである。 |
| 3 | Know which one needs you | Waiting is a state read from the agent's hooks, not a guess from the screen. It reaches you as a badge, a toast, the tab title, a push, and you answer from your phone. | どれがあなたを待っているか分かる | 入力待ちは画面からの推測ではなく、エージェント自身の hooks から読んだ状態である。バッジ・トースト・タブタイトル・通知で届き、スマホから応答できる。 |
| 4 | Method as a system | The method is not in someone's head. It is installed as Skills and read by the agent. | 方法論を仕組みに | 方法論は誰かの頭の中にはない。Skill として導入され、エージェントが読む。 |

> **旧カードからの差分**（Issue #2493）: 旧 3「Any agent, in parallel」は 1 へ吸収し、
> 旧 4「Stay in control, anywhere」は 3「Know which one needs you」へ改題した。
> 旧 1「Method as a system」は 4 へ移動（順序だけ変更、文は 1 文を 2 文に割っただけ）。
> §5 の LP デモ 4 本はこの 4 カードと 1 対 1 なので、対応表の「対応カード」列も付け替えてある。

---

## 3b. Measured（as observed）

実測表。README の「One agent leads」節の `### Measured` から **逐語で** 収録した（Issue #2549）。
LP では「See it running」の収録 run の直下に置く（#2550）。節番号が `3b` なのは、§4 以降の番号をずらさないためである。

**数字は §11b「言えること」の範囲を超えない**。3 行は §11b の「lead として動かせる」
「worker として動かせる」「別 CLI のレビューが効いた」の根拠になった 3 本の収録そのもので、
表の数字（4/4 ・ 2 waves ・ 8 min 39 s ・ 7 min 46 s ・ 47/47）はその収録記録から読んだ値である
（収録記録との突合は #2494 の CHANGELOG エントリに書いてある）。**ここに無い数字を足さない**。

表の直下には必ず `as observed`（ja: `as observed（実測した範囲）`）を添える。表だけを切り出して使わない。

### en

| Run | Lead | Workers | Result |
|---|---|---|---|
| 4 issues, one message | Claude Code | 4 × Claude Code | 4/4 gates passed, 2 waves, PRs merged, UAT go, 8 min 39 s |
| 4 issues, one message | Command Code | 4 × Command Code | 4/4 gates passed, 7 min 46 s; then a human pulled develop: 47/47 tests |
| 1 issue, with a review step | Command Code | Codex builds, Claude Code tests, Antigravity reviews | Review REJECT → fix → APPROVE, RESULT passed |

as observed

### ja

| ラン | lead | worker | 結果 |
|---|---|---|---|
| 4 Issue、1 通 | Claude Code | Claude Code × 4 | ゲート 4/4 合格、2 wave、PR マージ、UAT go、8 分 39 秒 |
| 4 Issue、1 通 | Command Code | Command Code × 4 | ゲート 4/4 合格、7 分 46 秒。そのあと人が develop を pull して 47/47 テスト |
| 1 Issue、レビュー 1 段つき | Command Code | Codex が実装、Claude Code がテスト、Antigravity がレビュー | レビュー REJECT → 修正 → APPROVE、RESULT passed |

as observed（実測した範囲）

---

## 3c. Supported agents（8 種を同じ扱いで）

README の `## Supported agents` 冒頭の 1 段落。**逐語で固定する**。LP ではカード 1「One agent leads」の直下に置く（#2550）。

**数え方**: 「8 種」は `CLI_TOOL_IDS`（claude / codex / gemini / vibe-local / opencode / copilot /
antigravity / command-code）の要素数で、ローカルモデル（`vibe-local`）はその 1 つとして数える。
**「8 + ローカルモデル」「8 種のエージェント CLI とローカルモデル」とは書かない**（§11 の根拠表の
行名は実装との突合のための見出しで、公開面での数え方ではない）。

### en

```
All eight are first-class. Each one gets the same treatment inside CommandMate — its own launch path, its own hook source and its own status detection — so the worktree session, the task contract, the verification gates and the evidence trail behave the same way whichever agent you pick.
```

### ja

```
8 種すべてが第一級。CommandMate の内部ではどれも同じ扱い（専用の起動経路・hook ソース・ステータス検出）を受けるため、worktree セッション・実行契約・検証ゲート・証跡の挙動は、どのエージェントを選んでも変わらない。
```

---

## 3d. Method as a system — Catalog の一覧

LP のカード 4「Method as a system」の下に置くチップの並び（#2550）。見出し 1 行と、公式 Catalog の ID の並び 1 行から成る。

| 言語 | 見出し |
|---|---|
| en | Installable today from the official Catalog |
| ja | 公式 Catalog からいま導入できる Skill |

ID の並び（en / ja 共通。アルファベット順）:

`cmate-acceptance-test` `cmate-delegate` `cmate-issue-authoring` `cmate-issue-refinement` `cmate-orchestrate` `cmate-orchestrate-monitor` `cmate-repository-analysis` `cmate-task-contract` `cmate-verify` `cmate-verify-advisor` `cmate-worker-development` `cmate-workspace-research` `cmate-worktree-cleanup` `cmate-worktree-setup`

> **根拠**: 公式 Catalog `Kewton/commandmate-skills` の `skills/` 直下のディレクトリ 14 件
> （2026-09-13 に `gh api repos/Kewton/commandmate-skills/contents/skills` で確認）。
> Catalog に Skill が増えたり減ったりしたら、LP より先にこの行を直す。見出しに件数を書かないのは、
> Catalog が増えたときに見出しだけが古い数を言い続けないためである。

---

## 3e. One agent leads（lead の run と、worker 1 体の 1 ターン）

LP の新節「One agent leads」と、圧縮後の「The loop」（どちらも #2550）がコピーする文。6 つの部品から成る。

- **README から逐語で収録した部品**: 3e-2 ・ 3e-3 ・ 3e-4 ・ 3e-5。README の `## One agent leads` と
  `## Review by another agent` を実際に開いて写した。言い換えたくなったら、README とこのファイルを同じ PR で直す
- **LP のために書いた部品**: 3e-1（4 ステップの説明）と 3e-6（The loop の lede）。README には無い
- `loop` は節名「The loop」以外に書かない（§11b）。修正の繰り返しは「回数に上限のある修正」と書く
- cross-model review はランナーの外である（§4b の 3 行目）。3e-5 はそれを明記した段落で、ランナーがレビューを走らせるとは書かない

### 3e-1. lead の run（plan → dispatch → merge → uat）

根拠は `cmate-orchestrate` Skill の `SKILL.md`（4 つの runner の役割表と「1 つの runner が次の phase を勝手に始めることはない」）。

#### en

```
- plan — a dry run. It resolves the issues' dependencies and file conflicts into waves, and changes nothing.
- dispatch — once you approve the plan, each issue goes to a worker in its own worktree under a contract, one wave at a time, and the gates judge every one.
- merge — only the issues whose gates passed become PRs and get merged.
- uat — acceptance is checked, with a capped number of fix attempts when it fails.

Each step is its own invocation, and none of them starts the next. Nothing mutates without `--approve`, and a failed gate stops the run.
```

#### ja

```
- plan — dry-run。Issue 間の依存関係とファイルの衝突を解いて wave に分け、何も書き換えない。
- dispatch — plan を承認すると、各 Issue がそれぞれの worktree にいる worker へ契約つきで渡る。wave ごとに進み、1 件ずつゲートが判定する。
- merge — ゲートを通った Issue だけが PR になり、マージされる。
- uat — 受入を確認する。不合格なら、回数に上限のある修正を行う。

各ステップは別々の起動で、どれも次のステップを勝手に始めない。`--approve` なしには何も書き換わらず、ゲートが落ちればランはそこで止まる。
```

### 3e-2. 本文（README `## One agent leads` の段落）

#### en

```
One message to your lead session. It plans the issues — dependencies, file conflicts, waves — and hands each one to a worker in its own worktree under a contract. Gates decide which work comes back. Only what passed becomes a PR, gets merged, and goes through acceptance. Nothing mutates without an explicit approve, and a failed gate stops the run.
```

#### ja

```
lead セッションへ 1 通。lead は Issue を計画し — 依存関係、ファイルの衝突、wave — それぞれを、自分の worktree にいる worker へ契約つきで渡します。どの作業が返ってくるかを決めるのはゲートです。通ったものだけが PR になり、マージされ、受入まで進みます。明示的な承認なしに何かが書き換わることはなく、ゲートが落ちればランはそこで止まります。
```

### 3e-3. 契約 YAML と、組み込みゲートの注記

YAML は en / ja 共通（README の 2 言語とも同じ実例 `.commandmate/tasks/issue-21.yaml`）。

```yaml
# .commandmate/tasks/issue-21.yaml
version: 1
title: "Issue #21: pick(obj, keys)"
goal: |
  Implement pick(obj, keys) in src/util/pick.js with node:test cases in tests/pick.test.mjs.
  Run npm test, then commit.
scope:
  allow:
    - "src/util/pick.js"
    - "tests/pick.test.mjs"
verify:
  gates: [unit]
```

#### en

```
The scope gate and the work-evidence gate are built in and run on every contract; you declare only the gates that need your project's commands.
```

#### ja

```
scope ゲートと work-evidence ゲートは組み込みで、どの契約でも必ず走ります。あなたが宣言するのは、プロジェクト固有のコマンドが要るゲートだけです。
```

### 3e-4. lead の実測の範囲（README の Measured 表の下の段落）

§3b の表の直後に置く。

#### en

```
The lead is a session like any other: today it has been measured with Claude Code and Command Code. Any of the eight agents can take the work. It is a run, not a resident agent: it starts on your message and ends with a report.
```

#### ja

```
lead は他と同じ 1 つのセッションです。lead としての実測は、今日のところ Claude Code と Command Code。作業は 8 種のどのエージェントでも引き受けられます。これは常駐エージェントではなく 1 回のランで、あなたのメッセージで始まり、レポートで終わります。
```

### 3e-5. Review by another agent（README `## Review by another agent` の段落）

#### en

```
A session can hand its work to another session for review — `commandmate ask`, or the `cmate-delegate` Skill — and the answer comes back to the lead. In the measured run, Command Code led, Codex built, Claude Code wrote the tests, and Antigravity rejected the first version before approving the fix. This is a step you add; the orchestrate runner does not run a cross-model review for you.
```

#### ja

```
セッションは自分の作業を、別のセッションへレビューに出せます（`commandmate ask`、または `cmate-delegate` Skill）。答えは lead に返ります。実測したランでは Command Code が指揮し、Codex が実装し、Claude Code がテストを書き、Antigravity が最初の版を REJECT してから修正版を APPROVE しました。これはあなたが足す 1 ステップであって、orchestrate のランナーが別モデルのレビューを代わりに走らせるわけではありません。
```

### 3e-6. The loop の lede（worker 1 体の 1 ターン）

LP の「The loop」の `section-lede` を差し替える文。節は lead の run（3e-1）の中の **worker 1 体の 1 ターン**を拡大したものとして位置づけ、
要件 → 契約 → エージェントの実行 → 判定 の 4 拍はそのまま残す。lead を介さず自分で `send --contract` したタスクも同じ 4 拍を通る。

#### en

```
One worker's turn, up close. Every task the lead hands out goes through the same four beats — the requirement, the contract, the agent's run, the verdict — and so does a task you send yourself.
```

#### ja

```
worker 1 体の 1 ターンを近くで見る。lead が配るタスクはどれも、要件 → 契約 → エージェントの実行 → 判定 という同じ 4 拍を通る。あなたが自分で送ったタスクも同じである。
```

---

## 4. With / Without CommandMate（競合比較の置き換え）

**競合製品名は書かない**（§9）。比較対象は製品ではなく **やり方** である。
右列の各セルは実装済み機能に対応している（根拠は §11）。

### en（LP / README）

| Dimension | Vibe coding | Vibe Engineering with CommandMate |
|---|---|---|
| What "done" means | The agent says it's done | A verification run says so — exit 0 / 20 / 21 |
| Scope of change | Whatever the agent touched | Declared in the contract, enforced by the scope gate |
| Method | In someone's head | Installed as Skills from the Catalog (`cmate-task-contract`, `cmate-verify`, …) |
| Evidence | A chat transcript | Commits, gate logs, `verify history`, `report metrics` |
| Parallel work | Terminal tabs | One worktree and one contract per task |
| When it stops | You notice, eventually | Waiting is surfaced: badge, toast, tab title, push |
| Which agent | Locked to one | Claude Code, Codex, Gemini CLI, Copilot, OpenCode, Antigravity, local models |

### ja（README ja / チュートリアル）

| 観点 | vibe coding（丸投げ） | Vibe Engineering with CommandMate |
|---|---|---|
| 「完了」の意味 | エージェントが「できた」と言ったとき | 検証ランがそう言ったとき — exit 0 / 20 / 21 |
| 変更範囲 | エージェントが触った範囲すべて | 契約で宣言し、scope ゲートで強制する |
| 方法論 | 誰かの頭の中 | Catalog から Skill として導入する（`cmate-task-contract` / `cmate-verify` ほか） |
| 証跡 | チャットの履歴 | commit ・ ゲートログ ・ `verify history` ・ `report metrics` |
| 並列作業 | ターミナルのタブ | タスクごとに worktree 1 つと契約 1 つ |
| 止まったとき | そのうち気づく | 入力待ちが届く: バッジ ・ トースト ・ タブタイトル ・ 通知 |
| 使えるエージェント | 1 つに固定 | Claude Code ・ Codex ・ Gemini CLI ・ Copilot ・ OpenCode ・ Antigravity ・ ローカルモデル |

---

## 4b. What it does not do（やらないこと）

§4 の右列を読んだ人が次に確かめたくなること。**約束しないことを先に書く**。
LP / README では §4 の直後に置く。ここに書いた 5 行を超える約束を、ほかの節で書かない。

### en

```
- It is a run, not a resident agent. Nothing loops forever, and nothing mutates without an explicit approve.
- It does not read the code for you. Gates catch what your tests and checks catch.
- Review by another agent is a step you add, not something the runner does for you.
- Approvals still come to a person. Auto Yes is opt-in, time-boxed, and stops on the patterns you set.
- It does not replace tmux, Git worktrees, your terminal, or your agent CLI. An OS reboot ends the processes; what survives is the record.
```

### ja

```
- これは常駐エージェントではなく、1 回のランである。永久に回り続けるものは無く、明示的な承認なしに何かが書き換わることも無い。
- コードを代わりに読んではくれない。ゲートが捕まえるのは、あなたのテストとチェックが捕まえる範囲だけである。
- 別のエージェントによるレビューは、あなたが足す 1 ステップであって、ランナーが代わりにやってくれるものではない。
- 承認はいまも人のところに来る。Auto Yes は opt-in で、時間の上限つきで、あなたが指定したパターンで止まる。
- tmux ・ Git worktree ・ ターミナル ・ エージェント CLI を置き換えるものではない。OS を再起動すればプロセスは終わる。残るのは記録である。
```

---

## 5. LP デモ 4 本のキャプション

4 本は §3 の 4 カードと 1 対 1 に対応させる。
**キャプションには映像に映っていることだけを書く**。撮影後、実際の映像と突き合わせて確認すること。

| # | 対応カード | 内容（撮影対象） | キャプション（en） | キャプション（ja） |
|---|---|---|---|---|
| 1 | Method as a system（カード 4） | ターミナル: `commandmate send <id> --contract .commandmate/tasks/<name>.yaml` を実行し、契約の goal と scope がエージェントへ渡る | Hand the agent a contract before the work starts. | 作業を始める前に、エージェントへ契約を渡す。 |
| 2 | Verified, not vibe-checked（カード 2） | ターミナル: `commandmate wait <id> --verify` の `GATE` 行と `RESULT` 行、そして終了コード | Gates run, and the exit code is the verdict. | ゲートが走り、判定は exit code で返る。 |
| 3 | One agent leads（カード 1） | ブラウザ: 複数 worktree のセッションが同時に走り、サイドバーの状態が個別に変わる | One session per worktree, running in parallel. | worktree ごとに 1 セッション、並列で走る。 |
| 4 | Know which one needs you（カード 3） | ブラウザ / スマホ: 入力待ちがバッジ・トースト・タブタイトルに出て、スマホから応答する | Waiting reaches you, and you answer from your phone. | 入力待ちが届き、スマホから応答する。 |
| hero | README 冒頭（4 カードの前、Issue #2381） | ブラウザ → スマホ: ヘッダーのリポジトリタブ帯で worktree を切り替え、5 エージェントの roster とピッカー、チャット面で隣のセッションへ委任（`commandmate ask … --instance codex` のツール呼び出しチップ）、返答のリンクからファイルビューア、スマホで承認シートを 1 タップ、スマホでファイルを開く | Switch repos from the tab bar, delegate to the next session, open the file from the reply — then the same from your phone. | タブでリポジトリを切り替え、隣のセッションに委任し、返答のリンクからファイルを開く。同じことをスマホでも。 |

> **旧デモとの差分**: 旧 4 本目 `tmux-in-browser`（"Your tmux session, driven from the browser."）は
> 廃止し、入力待ち通知デモへ置き換える（Epic #1807 D1）。検証は Web UI を待たず
> ターミナル映像で見せる（同 D5）。

> **README hero（#2381）**: README 冒頭の 30 秒は体験を先に、保証を後に置く。契約 → 検証の
> カット（`contract-verify`）は "Verified, not vibe-checked" の節へ下げる（#2383）。live に動くのは
> Claude と Codex の 2 体で、「5 エージェント」は roster とピッカーに 5 体が並ぶ事実まで。
> 5 体全部が動いたとは言わない。

---

## 6. デモのテロップ

制約は `.claude/skills/demo-video/scripts/storyboard.ts` の検証規則そのもの
（`record`: ja 20 文字 / en 8 語以内、`card`: ja 40 文字 / en 12 語以内）。
下の値はテストで実際にこの上限に照らしている。

| デモ | 種別 | telop.ja | telop.en |
|---|---|---|---|
| 1 | card | 作業の前に、契約を渡す | Hand the agent a contract before the work. |
| 1 | record | 契約つきで送信する | Send with a contract. |
| 2 | card | 終わりを決めるのは検証。exit 0 / 20 / 21 | A verification run decides done, not the agent. |
| 2 | record | GATE と RESULT を読む | Gates run; the exit code judges. |
| 3 | card | worktree ごとに 1 セッション。7 種の CLI から選べる | One session per worktree, across seven agent CLIs. |
| 3 | record | 並列で走る worktree | Worktrees running side by side. |
| 4 | card | 入力待ちは、バッジ・トースト・タブ・通知で届く | Waiting reaches you: badge, toast, tab title, push. |
| 4 | record | スマホから応答する | Answer from your phone. |
| hero | card | CommandMate | CommandMate |
| hero | record | リポジトリはタブで切り替える | Switch repos from the tab bar. |
| hero | record | 5 エージェント、1 worktree | Five agents in one worktree. |
| hero | record | 隣のセッションに頼むだけ | Delegate to the next session. |
| hero | record | 返答のリンクからファイルを開く | Open the file from the reply. |
| hero | record | 承認はスマホから 1 タップ | Approve from your phone. |
| hero | record | ファイルもスマホで開く | Open files on your phone, too. |
| hero | card | github.com/Kewton/CommandMate | github.com/Kewton/CommandMate |

> **デモ 3 のテロップが `seven` / `7 種` のままな理由**: この 2 行は撮影済み映像に焼かれており、
> `.claude/skills/demo-video/storyboard/` の絵コンテと `tests/unit/skills/demo-video/storyboard.test.ts`
> が逐語で固定している。**対応ツール数の権威は §11 の根拠表（`CLI_TOOL_IDS` = 8 id）**であり、
> 数を直すときはテロップだけでなく映像と絵コンテを撮り直す（別 Issue）。§3 のカードは
> Issue #2493 で数を述べない文言に変わったので、ここが最後の `seven` である。

`hero` の 8 行は `.claude/skills/demo-video/storyboard/readme-hero.yaml` の絵コンテと 1 対 1 で、
`tests/unit/skills/demo-video/storyboard.test.ts` が絵コンテ側の文言がここに在ることを照合する
（Issue #2381）。「5 エージェント、1 worktree」は本文案の「5 エージェントが 1 つの worktree に」
（25 文字）を record の上限 20 文字に収めた形。

---

## 7. チュートリアル導入文

必須要素: **15 分** / **fork してから始める** / **契約 → 検証を体験する**。

| 言語 | 導入文 |
|---|---|
| ja | わざとバグを 2 つ残したサンプルリポジトリを使って、CommandMate の中核を 15 分ほどで一通り体験します。サンプルリポジトリを fork してから始めるので、あなたの操作が元のリポジトリ（upstream）に影響することはありません。作業の前に契約を渡し、作業の後に検証ゲートで判定するところまでを、実際の exit code で確かめます。 |
| en | Use a sample repository with two bugs left in on purpose to work through the core of CommandMate in about fifteen minutes. You fork the sample repository before you start, so nothing you do can touch the original repository (upstream). You hand the agent a contract before the work and let the verification gates judge it afterwards, and you read the verdict off the real exit code. |

---

## 8. Footer タグライン

`local control plane` は使わない（§9）。

| 言語 | タグライン |
|---|---|
| en | The method, built in — for any coding agent. |
| ja | 方法論を、仕組みに。どのコーディングエージェントでも。 |

---

## 9. 禁止語リスト

公開面の新しい文章に書かない語。**この表がテスト側の配列と一致していること**を
`tests/unit/docs/public-messaging.test.ts` で固定している（片方だけ更新されるのを防ぐ）。

この表を読んで走査している対象は 2 系統ある。`tests/unit/docs/public-messaging.test.ts` が
`docs/concept.md` ・ `docs/en/concept.md` ・ `README.md` ・ `docs/ja/README.md` を、
`tests/unit/website/landing-page.test.ts` がこの表と自分の `LP_BANNED_TERMS` の和集合で
`website/**` を走査する。したがって**この表に 1 行足すと LP と README にも同時に効く**。
チュートリアルはまだ対象に入っていない（#1813 で改稿してから加える）。

<!-- banned-terms:start -->

| 禁止語 | 代わりに | 理由 |
|---|---|---|
| `control plane` | §1 の hero / §8 の footer タグライン | 「複数のエージェント CLI を便利に操作するツール」という旧軸の語。方法論を提供する側面が落ちる |
| `コントロールプレーン` | §1 の hero（ja） | 同上（日本語面） |
| `control layer` | 何も置かない（文を落とす） | 「エージェントの上に薄い層を足す」という旧軸の言い換え。CommandMate が足すのは層ではなく、契約 → ゲート → 証跡という仕組みそのもの |
| `コントロールレイヤー` | 何も置かない（文を落とす） | 同上（日本語面） |
| `Orchestrate your agent CLIs, not your terminal tabs` | §1 の H1 | 旧 LP の H1。操作対象がターミナルタブになっており、軸が「操作」に留まる |
| `Vibe Coder` | vibe coding（行為）または「AI とプロダクトを作る人」 | 人の属性でセグメントを切る旧軸。CommandMate は属性ではなく仕組みで結果を揃える |
| `Remote Control` | §4 の With / Without 表 | 競合製品名。新しい文章に他社製品名を書かない（Epic #1807 D4） |
| `Happy Coder` | §4 の With / Without 表 | 同上 |
| `claude-squad` | §4 の With / Without 表 | 同上 |
| `Omnara` | §4 の With / Without 表 | 同上 |
| `Orca` | §4 の With / Without 表 | 同上（Epic #2548 の競合調査で追加） |
| `Herdr` | §4 の With / Without 表 | 同上（Epic #2548 の競合調査で追加） |
| `Lanes` | §4 の With / Without 表 | 同上（Epic #2548 の競合調査で追加） |

<!-- banned-terms:end -->

> **競合製品名の行は LP 側にも複写する**（Issue #2549）: 理由が「競合製品名」の行（`同上` は直前の行の理由を引き継ぐ）は、
> `tests/unit/website/landing-page.test.ts` の `LP_BANNED_TERMS` にも同じ語が在ることをテストで固定している。
> 競合名をこの表に足すときは、同じ PR で `LP_BANNED_TERMS` にも足す。
>
> **走査は大文字小文字を無視した部分一致**である。たとえば `Lanes` は `planes` ・ `swimlanes` にも当たる。
> 新しい文章でこれらの語が必要になったら、語を言い換える（禁止語の行は緩めない）。

---

## 10. 出典 — "vibe engineering" の一次情報確認

**確認済み**。2026-08-18 に一次情報（本文）を実際に取得して確認した。

| 項目 | 内容 |
|---|---|
| 語 | vibe engineering |
| 出典 | Simon Willison, "Vibe engineering", 2025-10-07, https://simonwillison.net/2025/Oct/7/vibe-engineering/ |
| 確認状況 | 確認済み（2026-08-18 に本文を取得） |
| 原文の定義 | "the other end of the spectrum, where seasoned professionals accelerate their work with LLMs while staying proudly and confidently accountable for the software they produce" |
| 原文が vibe coding と対比する形 | "This feels very different from classic vibe coding, where I outsource a simple, low-stakes task to an LLM and accept the result if it appears to work." |
| 原文のトーン | 著者自身が "with my tongue only partially in my cheek" と書いており、半ば冗談として提案された語である |
| 原文が挙げる必要な実践 | 自動テスト / 事前の計画 / 網羅的なドキュメント / 堅実なバージョン管理 / 自動化 / コードレビュー文化 / 手動 QA / 調査能力 / プレビュー環境 / AI を使う勘所 / 見積もりの更新 |
| CommandMate の用法との整合 | **整合する**。原文の実践一覧（テスト・計画・レビュー・自動化）は、CommandMate の実装 7 項目とほぼ同じ範囲を指している |
| ただし異なる前提 | 原文の主語は "seasoned professionals"（経験を積んだプロ）で、規律は**人が持っている**ことが前提。CommandMate はその規律を**仕組み側に置く**ので、主語が「専門知識を持たない人」まで広がる。定義文（§2）が "the system, not your expertise" と明示しているのはこの差分のためである |
| LP の脚注 | **置く**。既出語を自社造語のように見せないため |
| 脚注の文言（en） | The term "vibe engineering" was coined by Simon Willison (2025). |
| 脚注の文言（ja） | "vibe engineering" は Simon Willison 氏が 2025 年に提唱した語です。 |

---

## 11. 実装との突合（With / Without 右列の根拠）

§4 の右列は、すべて実装済み機能に対応している。存在しない機能は書いていない。

| §4 の主張 | 実装 | 根拠 |
|---|---|---|
| exit 0 / 20 / 21 | `VerifyExitCode`（SUCCESS 0 / VERIFY_FAILED 20 / NOT_STARTED 21） | `src/cli/types/index.ts` の `VerifyExitCode` |
| 契約で宣言する | `.commandmate/tasks/<name>.yaml` と `commandmate send --contract <path>` | `src/lib/tasks/contract-parser.ts` の `TASK_CONTRACT_DIR` ・ `src/cli/commands/send.ts` の `--contract` |
| scope ゲートで強制する | scope ゲート実装 | `src/lib/verification/scope-gate.ts` ・ `src/lib/verification/gate-runner.ts` |
| Catalog から Skill を導入する | `commandmate skill list` / `install` / `update` | `src/cli/commands/skill.ts` ・ [docs/user-guide/skills.md](../user-guide/skills.md) |
| `cmate-task-contract` / `cmate-verify` は実在する | 公式 Catalog `Kewton/commandmate-skills` の skill ディレクトリ | Catalog リポジトリの `skills/` 直下に両 ID が存在 |
| commit / ゲートログ | work-evidence ゲート（commit も未 commit の変更も証跡として数える） | `VerifyExitCode.NOT_STARTED` の説明（"no commits and no uncommitted changes"） |
| `verify history` | `commandmate verify history` サブコマンド | `src/cli/commands/verify.ts` |
| `report metrics` | `commandmate report metrics` サブコマンド | `src/cli/commands/report.ts` |
| worktree 1 つと契約 1 つ | worktree ごとの独立セッション + 契約ファイル | `src/lib/session/` ・ `.commandmate/tasks/` |
| 入力待ちが届く（バッジ / トースト / タブタイトル / 通知） | App Badge ・ Toast ・ `document.title` ・ Web Push | `src/hooks/useAttentionBadge.ts` ・ `src/lib/pwa/attention-badge.ts` ・ `src/components/common/Toast.tsx` ・ `src/lib/push/waiting-push-notifier.ts` |
| 8 種のエージェント CLI とローカルモデル | `CLI_TOOL_IDS`（claude / codex / gemini / vibe-local / opencode / copilot / antigravity / command-code） | `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS` |
| `wait --verify` | `commandmate wait --verify` オプション | `src/cli/commands/wait.ts` |

---

## 11b. 言えること / 言えないこと（実測の範囲）

公開面に書いてよい主張の**上限**。§11 が「機能が在ること」の根拠表であるのに対し、
この節は「**どこまで実測したか**」の範囲表である。ここに無い強さの主張は書かない（Issue #2493）。

### 言えること（実測がある）

| 主張 | 実測の内容 |
|---|---|
| lead として動かせる | Claude Code と Command Code で実測（4 Issue → 4/4 完了、8m39s / 7m46s） |
| worker として動かせる | Codex ・ Claude Code ・ Antigravity ・ Command Code で実測 |
| 別 CLI のレビューが効いた | 別 CLI のレビューで REJECT → 修正 → APPROVE まで到達した |
| plan は破壊しない | plan は dry-run。mutation は `--approve` を付けた invocation だけ |
| ゲート不合格で止まる | gate が不合格ならそこでランが停止する |
| 修正ループは有限 | 修正ループに上限がある |

### 言えないこと（未計測 / 事実に反する）

| 書かない表現 | 理由 |
|---|---|
| `your orchestrator` | 「orchestrator」を製品の名詞にしない。動詞・形容（orchestrated）で使う |
| `runs 24/7` | 常駐ではなく、承認つきで 1 回通すランである |
| `self-managing backlog` | backlog を自律管理する機能は無い |
| `loop` | 永久に回り続けるものは無い（§4b の 1 行目） |
| `orchestrate with any agent as the lead` | lead としての実測は Claude Code / Command Code の 2 つだけ |
| `review by a fresh agent is built in` | cross-model review はランナーの外。利用者が足すステップである（§4b の 3 行目） |
| `the only …` | 唯一性を検証していない |
| `no supervision` | 承認は人のところに来る（§4b の 4 行目） |
| モデルの安さ・賢さの序列 | 計測していない。公開面でモデルに順位を付けない |
| 未計測の数字 | 実測のない数値は書かない |

---

## 12. 後続 Issue との対応

| Issue | 面 | このファイルから使う節 |
|---|---|---|
| #1810 | デモ新シーン | §5 ・ §6 |
| #1811 | 特徴デモ 12 本 | §3 ・ §6 |
| #1812 | LP v2 | §1 ・ §2 ・ §3 ・ §4 ・ §5 ・ §8 ・ §9 ・ §10 |
| #1813 | チュートリアル v2 | §2 ・ §7 ・ §9 |
| #1814 | README 整合 | §1 ・ §2 ・ §3 ・ §4 ・ §9 |
| #1815 | README GIF | §5 ・ §6 |
| #2381 | README hero（UX 先行の 30 秒） | §5 ・ §6 |
| #2494 | README を orchestrate 軸へ | §1 ・ §1b ・ §2 ・ §3 ・ §4b ・ §9 ・ §11b |
| #2495 | LP を orchestrate 軸へ | §1 ・ §1b ・ §2 ・ §3 ・ §4 ・ §4b ・ §5 ・ §8 ・ §9 ・ §10 ・ §11b |
| #2549 | 本ファイルへの追記（Epic #2548 の先頭）と、README en / ja ・ LP の通信範囲の過大表現の撤回 | §3b ・ §3c ・ §3d ・ §3e ・ §9 ・ §13 ・ §14 |
| #2550 | LP: See it running の Measured 表 ・ 新節「One agent leads」 ・ The loop を worker 1 体の段に圧縮 | §3b ・ §3c ・ §3d ・ §3e ・ §4b ・ §9 ・ §11b |
| #2551 | LP: hero 右をゲート行つきセッション一覧の inline SVG に、ループ図を The loop へ | §1 ・ §9 ・ §11b |
| #2552 | LP: nav / footer ・ 版行 ・ `website/llms.txt` ・ GitHub の About | §1 ・ §3 ・ §9 |
| #2553 | LP: FAQ 節（8 問） | §9 ・ §13 |
| #2554 | LP: Trust 節「Runs on your machine」と通信範囲の図 | §9 ・ §14 |
| #2555 | LP: Track B を details に畳む ・ remote 節を 1 段落に ・ ギャラリー 4 枚 | §9（文言は足さない） |
| #2556 | LP: デモ動画の autoplay を IntersectionObserver に置き換える | §5（キャプションは変えない） |
| #2557 | LP: 流入の計測（UTM またはクッキー無しの計数） | §14（「テレメトリ無し」は本体の性質であり、LP の計数と混同させない） |

> **この表に載っていない公開面**: `docs/features/product-highlights.md` と
> `docs/en/features/product-highlights.md` は §2 の定義文と §3 の**旧**カード文言
> （`Method as a system` / `Verified, not vibe-checked` / 「方法論を仕組みに」）を
> #1811 でコピーしており、#2494（README）にも #2495（LP）にも含まれていない。
> **この 2 ファイルを縛っているテストは 1 つも無い**ので、放置すると単一ソースと静かに乖離する。
> 追随用の Issue を別に立てること（本 Issue のスコープ外）。

---

## 13. FAQ

LP の FAQ 節（#2553）が en を **逐語で** コピーする 8 問。**問の順序も固定**する。
表は `faq:en` / `faq:ja` の HTML コメントマーカーで囲ってあり、#2553 のテストはマーカーの中を読んで
LP と突き合わせる想定である（§2 の `def:en` と同じ型）。**マーカーを外さないこと**。

書き方の規則:

- 答は §4b ・ §11b ・ §14 を超える約束をしない。Q5 の答は §14 の文そのもの、Q8 の答は §4b の 4 行目を含む
- 他社の製品名・機能名を書かない（§9）。エージェント純正のスマホ機能と比べる問は、製品名・機能名を出さずに書けないので置かない
- `loop` ・ `the only …` ・ `no supervision` を書かない（§11b）
- 表のセルに `|` を書かない（表が割れる）。`<id>` のような山括弧も書かない（HTML として消える）

### en

<!-- faq:en -->

| # | Question | Answer |
|---|---|---|
| 1 | What is a gate? | A command you declared for your project in `.commandmate/verify.yaml` — tests, lint, a type check — whose exit code decides whether the work is done. A person's approval is not a gate. Two gates are built in and run on every contract: work-evidence, which needs a commit or an uncommitted change, and scope, which checks the changed files against the contract. |
| 2 | What happens after the agent says it is done? | `commandmate wait --verify` runs the gates once the agent stops, and its exit code is the verdict: `21` when there is no evidence of work at all, `20` when a gate failed, `0` when every gate passed. `verify history` keeps each run, so the verdict can be read again later. |
| 3 | Why is this not an IDE? | Because it does not replace the tools you already work in. Your terminal, your editor and your agent CLI stay as they are; CommandMate adds a contract before the work, gates after it, and a record of every run. |
| 4 | Is it free? | Yes. CommandMate is open source under the MIT License, needs no account, and needs no external server to run. The agent CLIs you use keep their own plans and pricing. |
| 5 | Where does my code go? | CommandMate runs on your machine. It sends no telemetry, needs no account, and needs no external server to run. What goes over the network depends on what you use: your agent CLI's own API calls; a check for a newer release on GitHub, from the web UI; the official Skills Catalog on GitHub, when you list or install Skills; your browser's push service, once you turn on Web Push; and Tailscale or cloudflared, while `commandmate remote` is running. |
| 6 | Which agents can lead? | Claude Code and Command Code have been measured as the lead. The lead is a session like any other, and any of the eight agents can take the work as a worker. |
| 7 | Does it run on Windows? Is tmux required? | On Windows it runs through WSL2; native Windows is not supported. tmux is required, because every worktree session runs in a tmux session of its own — but CommandMate operates tmux for you, so you do not need to know it. |
| 8 | Is Auto Yes safe? | Approvals still come to a person. Auto Yes is opt-in, time-boxed, and stops on the patterns you set. You choose one, three or eight hours when you turn it on (one by default), and it switches itself off when that time is up or when the output matches a stop pattern. |

<!-- /faq:en -->

### ja

<!-- faq:ja -->

| # | 問 | 答 |
|---|---|---|
| 1 | ゲートとは何か | プロジェクトのために `.commandmate/verify.yaml` に宣言したコマンド（テスト ・ lint ・ 型チェックなど）で、その exit code が作業の完了を判定する。人の承認はゲートではない。work-evidence（commit か未 commit の変更を要求する）と scope（変更したファイルを契約と突き合わせる）の 2 つは組み込みで、どの契約でも必ず走る。 |
| 2 | エージェントが「終わった」と言ったあと、何が起きるか | エージェントが止まると `commandmate wait --verify` がゲートを走らせ、その exit code が判定になる。作業の証跡がまったく無ければ `21`、ゲートが落ちれば `20`、すべて通れば `0`。`verify history` が毎回のランを残すので、判定はあとから読み直せる。 |
| 3 | なぜ IDE ではないのか | いま使っている道具を置き換えないからである。ターミナルもエディタもエージェント CLI もそのままで、CommandMate が足すのは、作業の前の契約、作業の後のゲート、そして毎回のランの記録である。 |
| 4 | 無料か | 無料である。CommandMate は MIT License のオープンソースで、アカウントは不要、動かすのに外部サーバも要らない。使うエージェント CLI の料金プランは、それぞれの提供元のままである。 |
| 5 | コードはどこへ行くのか | CommandMate はあなたのマシンで動く。テレメトリを送らず、アカウントも要らず、動かすのに外部サーバも要らない。ネットワークに出るのは、使う機能に応じて次のものである: エージェント CLI 自身の API 呼び出し、Web UI からの GitHub への新しいリリースの確認、Skill を一覧 ・ 導入するときの GitHub 上の公式 Catalog、Web Push を有効にしたときのブラウザの push サービス、`commandmate remote` を動かしている間の Tailscale または cloudflared。 |
| 6 | lead にできるのはどのエージェントか | lead としての実測は Claude Code と Command Code である。lead は他と同じ 1 つのセッションで、worker としては 8 種のどのエージェントでも作業を引き受けられる。 |
| 7 | Windows で動くか。tmux は必須か | Windows では WSL2 上で動く（ネイティブ Windows は非対応）。tmux は必須である。worktree ごとのセッションがそれぞれ自分の tmux セッションで動くためだが、tmux は CommandMate が操作するので、使い方を知っている必要はない。 |
| 8 | Auto Yes は安全か | 承認はいまも人のところに来る。Auto Yes は opt-in で、時間の上限つきで、あなたが指定したパターンで止まる。有効にするときに 1 ・ 3 ・ 8 時間から選び（既定は 1 時間）、その時間が切れるか、出力が停止パターンに一致すると自動で無効になる。 |

<!-- /faq:ja -->

> **答の根拠**: Q1 は `src/lib/verification/gate-runner.ts` ・ `src/lib/verification/scope-gate.ts`、
> Q2 は `VerifyExitCode`（§11）と `commandmate verify history`、Q7 は README の WSL2 の注記
> （CommandMate は tmux に依存するのでネイティブ Windows は非対応）、Q8 は
> `src/config/auto-yes-config.ts` の `ALLOWED_DURATIONS`（1 / 3 / 8 時間）・ `DEFAULT_AUTO_YES_DURATION`（1 時間）と、
> `src/lib/auto-yes-state.ts` の `disableAutoYes`（理由 `expired` / `stop_pattern_matched`）。
> Q6 の「8 種のどれでも worker になれる」は §3c と同じく**対応の主張**で、worker として実測したのは §11b の 4 つである。

---

## 14. Trust（通信の範囲）

「どこへ何が出ていくか」を公開面が言うときの文。README の `## Security` 節の冒頭（en / ja）、
LP の note（#2554 で独立節「Runs on your machine」へ格上げする）、§13 の Q5 がこの文をコピーする。

Issue #2549 で、README（en / ja）と LP にあった
"Runs 100% locally. No external server, no cloud relay, no account required. The only network traffic is the agent CLI's own API calls."
（ja: 「100% ローカル実行。外部サーバーなし、クラウド中継なし、アカウント登録不要。ネットワーク通信はエージェント CLI 自体の API 呼び出しのみ。」）
を撤回し、この文に置き換えた。Web Push を有効にすれば push サービスを、`commandmate remote` を使えば
Tailscale か Cloudflare を通り、Web UI の更新確認と Skills Catalog は GitHub へ出るので、元の文は成立しない。

下の表の en 行は `trust:en` マーカーで囲ってある（§2 の `def:en` と同じ型。#2554 が LP と逐語照合する想定）。
**マーカーを外さないこと**。

| 言語 | 文 |
|---|---|
| en | <!-- trust:en -->CommandMate runs on your machine. It sends no telemetry, needs no account, and needs no external server to run. What goes over the network depends on what you use: your agent CLI's own API calls; a check for a newer release on GitHub, from the web UI; the official Skills Catalog on GitHub, when you list or install Skills; your browser's push service, once you turn on Web Push; and Tailscale or cloudflared, while `commandmate remote` is running.<!-- /trust:en --> |
| ja | CommandMate はあなたのマシンで動く。テレメトリを送らず、アカウントも要らず、動かすのに外部サーバも要らない。ネットワークに出るのは、使う機能に応じて次のものである: エージェント CLI 自身の API 呼び出し、Web UI からの GitHub への新しいリリースの確認、Skill を一覧 ・ 導入するときの GitHub 上の公式 Catalog、Web Push を有効にしたときのブラウザの push サービス、`commandmate remote` を動かしている間の Tailscale または cloudflared。 |

書き分けの規則:

- **本体の性質**（テレメトリ無し ・ アカウント不要 ・ 動かすのに外部サーバ不要）と、**機能ごとの通信**を分けて書く。
  前者を「外部と通信しない」「外部サーバ無し」に広げない
- 機能ごとの通信は、**いつ起きるか**（使っている間 ・ 有効にしたとき ・ 動かしている間）を添えて列挙する。
  列挙から 1 つでも落とすなら、下の根拠表で「その通信が無くなった」ことを確かめてからにする

### 機能ごとの通信（根拠）

| 通信 | いつ | 行き先 | 根拠 |
|---|---|---|---|
| エージェント CLI 自身の API 呼び出し | エージェントを動かしている間 | 各 CLI の提供元（ローカルモデルなら自分でホストしている先） | CommandMate は CLI を tmux のセッションで起動するだけで、CLI の API 通信を中継しない |
| 新しいリリースの確認 | Web UI が版情報を取りに行くとき（サーバ側で 1 時間キャッシュ） | GitHub Releases API。送るのは `User-Agent: CommandMate/<version>` つきの GET 1 本 | `src/lib/version-checker.ts` の `GITHUB_API_URL` ・ `src/hooks/useUpdateCheck.ts` |
| 公式 Skills Catalog | Skill を一覧 ・ 導入 ・ 更新するとき | `raw.githubusercontent.com` の `Kewton/commandmate-skills` | `src/config/skill-catalog-config.ts` ・ `src/lib/skills/catalog-client.ts` |
| Web Push | VAPID 鍵を作り、ブラウザが通知を購読したとき | ブラウザの push サービス | `src/lib/push/push-sender.ts`（`web-push`） |
| `commandmate remote` | `remote` を動かしている間 | Tailscale（tailnet 内）または cloudflared（Cloudflare Quick Tunnel） | `src/lib/remote/tailscale.ts` ・ `src/lib/remote/cloudflare.ts` ・ `src/lib/remote/provider-registry.ts` |

> **公開文に列挙しないもの**: 利用者が行き先を名指しして起動する操作 —— git の clone / fetch / push
> （行き先は利用者自身の remote）、`commandmate update` の npm registry、`commandmate issue` の `gh`。
> 操作そのものが通信なので「動かすのに外部サーバは要らない」とは矛盾しない。
> ここに入らない通信を足す機能ができたら、上の文と表を同じ PR で直す。

### 書かない表現

| 書かない表現 | 理由 |
|---|---|
| `The only network traffic is the agent CLI's own API calls` | 撤回した（#2549）。Web Push ・ `remote` ・ 更新確認 ・ Skills Catalog の通信を含めると成立しない |
| `100% locally` ・ `100% ローカル` | 同上。`remote` を使えば接続は tunnel を通る |
| `No external server`（無条件） | 機能ごとの通信を消してしまう。「動かすのに外部サーバは要らない」と書く |
| `no cloud relay` ・ `クラウド中継なし` | `commandmate remote` の cloudflared は Cloudflare を中継に使う |
