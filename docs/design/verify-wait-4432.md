# verify の待ちを減らす（Issue #4432）— 設計

- 状態: 設計（第 2 版。設計レビュー 1〔`workspace/orchestration/runs/2026-11-18/review-4432-design-1.md`、P1 3・P2 7・P3 7〕の指摘を入れた。処分の一覧は §6）。実装は設計のレビューの後に別の契約で行う。この版はコード・試験・設定を変えない
- 範囲（人の決定 2026-11-18）: A（PR0・PR1・PR2）は #4462 へ移した。Sprint 7 は PR3（B2 の測定だけ）だけを実装する（PR4・B1 はしない）
- 前提: 並行のレーン V1（#4459・#4433）が**マージされた後の形**を前提にする（§3.3）
- 行番号は書かない（`origin/develop` `11bd76f12` 時点の名前で引く）
- 本書では **事実**（コード・記録で確かめたこと）、**見立て**（事実から計算したが試していないこと）、**未確認** を分ける
- 不変条件（PM の決定。全案に効く）:
  - **N1** ゲートの判定を弱めない。同じ変更で、同じ不合格が同じように出る
  - **N2** 結果の使い回しは、版（tree）・依存（lockfile・node の版・ゲートの宣言）・環境（`env=` の manifest、`verifyEnvState` が `same`）が同じときだけ
  - **N3** 関係する試験への絞り込みは、漏れる試験が無いことの根拠（import の追跡の範囲・リポジトリのファイルを読む試験の扱い・陽性対照＝既知の不合格の再現）を出す
  - **N4** mutex の枠を増やす案は、負荷の揺れが増えないことの確かめ方まで書く
  - **N5** 根拠が出せない案は「採らない」と書く
- 方針（team.md §6 の 5）: 穴はまず**狭めて塞ぐ**。使い回しの材料は、機械で結び付けを確かめられる記録だけに絞る

---

## 0. 結論

| 案 | 中身（既存との差分） | 見込み（段 5 / 段 6 の実績から） | 採否 |
|---|---|---|---|
| **A** precheck の `related` の段を、同じ HEAD で verify の `unit-related` が**全体**で通った記録で飛ばす | 今の precheck は試験のゲートをどの段の代わりにもしない。材料を「サーバーの run が自分の見た HEAD を持ち、それが今の HEAD と一致し、run の間に HEAD も作業ツリーも動いておらず、`result=ok`（判定の付いた exit 0）で、その HEAD の最新の verify 行」に限る。ゲートの走った環境（node・PATH 上の道具・`CI`・lockfile）はゲートの中で取り、precheck の環境と一致するときだけ使う。`tests` の段（変えた試験・名指しの試験・guards・docs）は今までどおり並列で走らせる。`verified` を使った HEAD は merge-pr が CI の `Unit Tests` を必ず待つ | precheck の `cpu.heavy` の待ち: 段 5 は 17,629 s のうち **9,109 s**（2 HEAD・3 回。exit 3 の保留 1 回を含む）。段 6 は 10,277 s が leader の裁定の行で、§5 の問い 2 で裁定の行を材料に認めたときだけ（認めなければ 0） | **採る**（PR0 で記録を足し、1 段溜めてから PR1 で使う。裁定の行は PR2・条件つき） |
| **B2** 文書・locale・integration の試験の変更で全体に倒さない | 実行時の読み取りの表（試験 → 読んだファイル）で選ぶ | 対象の run の `cpu.heavy` の保有: 段 5 は 83,157 s のうち 61,892 s、段 6 は 39,810 s のうち 23,675 s（上限）。**ただし表の鍵の命中率の実測は、日次の表で 3/30（10%）、ブランチの HEAD の鍵では 0/30**（§2.3.1） | **今の運用の条件では採らない**。develop の commit ごとに表を作る形で、命中率・網羅・f の 3 つの条件（§2.3.5）を PR3（測定だけ）で満たしたときだけ PR4 で切り替える |
| **B1** `scripts/` のコードを import の追跡に入れる | `run-related-unit-tests.mjs` は `scripts/**/*.mjs` の変更で全体に倒れる | 単独では 0（`scripts/` だけが全体の理由になった run が無い） | **B2 を採るときだけ PR4 に入れる**（選ぶ集合を狭めるので、測定の PR3 に入れない） |
| **C** `cpu.heavy` を 2 本にする | — | 再生で待ちが段 5 で 80,651 → 8,679 s・段 6 で 11,108 → 853 s（同時 2 本で実行時間が伸びる分を入れていない上限） | **採らない**（揺れが増えない根拠に 60 組の試走が要る。#4370 に渡す。§2.5） |
| **D** 安い契約ゲートが落ちたら試験を打ち切る | — | — | **採らない**（N1 に反する。§2.6） |
| **E** verify どうしで同じ tree の試験の合格を使い回す | — | 段 5・段 6 とも 0 | **採らない**（効果が無い。§2.7） |

段 6 の verify の待ちのうち最大の塊（exit 99 の 20 行・計 89,864 s の `waited-for=run N(still running)`）は、V1（#4459 項目 1: busy 待ちの上限 3,600 s が mutex 待ちの上限 5,400 s より短い）が直す。本書の見込みには数えない（§1.2）。

---

## 1. 現状の待ちの内訳（数字）

### 1.1 対象の run と集計の方法

| 段 | run-log | 期間（UTC） | Issue |
|---|---|---|---|
| 段 5 | `workspace/orchestration/runs/2026-11-14/run-4385,4395,4396,4397.jsonl` | 2026-11-14T15:09〜11-16T11:57 | 13（4344・4385〜4389・4395〜4397・4403・4413・4418・4419） |
| 段 6 | `workspace/orchestration/runs/2026-11-17/run-4344,4388,4436,4437,4438,4439.jsonl` | 2026-11-16T14:20〜11-18T04:08 | 6 |

`workspace/` は MyCodeBranchDesk の checkout（オーケストレーターの作業場所）にある。各行の `durationSec` は wait-verify の呼び出し全体（ワーカーの作業の終わりを待つ時間を含む）、`queueSec` / `mutexSec` / `runSec` は verify の run の枠の待ち・ロックの待ち・全ゲートの実行の和（`wait-verify.mjs` `verifyTiming`。ゲートの `[timing]` の行から）。

集計のコマンド（段ごとに `F` を差し替える）:

```bash
cd <MyCodeBranchDesk>/workspace/orchestration/runs
F="2026-11-14/run-4385,4395,4396,4397.jsonl"
jq -s -r 'def s(f): map(f // 0) | add // 0;
  ["verify","precheck"][] as $st | [.[]|select(.stage==$st)] as $r |
  "\($st) n=\($r|length) results=\($r|group_by(.result)|map("\(.[0].result):\(length)")|join(",")) withTiming=\([$r[]|select(.mutexSec!=null)]|length) dur=\($r|s(.durationSec)) q=\($r|s(.queueSec)) m=\($r|s(.mutexSec)) run=\($r|s(.runSec))"' "$F"
# verify の行を「busy の 99」「mutex の SKIP」「待ちの記録あり」「記録なし（人の裁定の行など）」に分ける
jq -s -r '[.[]|select(.stage=="verify")] as $v |
  def cat: if (.note|test("still running")) then "busy99" elif (.note|test("unit-related@contract:SKIP")) then "mutex99" elif .mutexSec!=null then "timed" else "untimed" end;
  ($v|group_by(cat)|map({c:(.[0]|cat), n:length, dur:(map(.durationSec//0)|add), m:(map(.mutexSec//0)|add), r:(map(.runSec//0)|add)}))[] | "\(.c) n=\(.n) dur=\(.dur) m=\(.m) r=\(.r)"' "$F"
```

### 1.2 verify と precheck の合計（事実）

| | 段 5 | 段 6 |
|---|---|---|
| verify の行（ok / fail） | 82（55 / 27） | 62（25 / 37） |
| verify の `durationSec` の和 | 225,288 s（62.6 h） | 232,127 s（64.5 h） |
| うち `mutexSec`（`cpu.heavy` の待ち） | **98,701 s（27.4 h）** | **43,298 s（12.0 h）** |
| うち `queueSec`（実行枠の待ち） | 22 s | 0 s |
| うち `runSec`（全ゲートの実行） | 84,269 s | 40,580 s |
| busy の exit 99（`waited-for=… (still running)`、待ちの記録なし） | 0 | **20 行・89,864 s**（V1 の範囲） |
| mutex の待ち切り（`unit-related@contract:SKIP`） | 1 行（mutex 16,200 s＝5,400 × 3、`mutex-requeue=2`） | 6 行（mutex 27,000 s） |
| precheck の行（ok / fail / skip） | 38（36 / 1 / 1） | 19（18 / 0 / 1） |
| precheck の `durationSec` / `mutexSec` / `runSec` | 20,257 / **17,629（87%）** / 2,626 s | 11,000 / **10,277（93%）** / 721 s |

Issue 本文の「verify 80 回・失敗 26 回・約 59 時間のうち約 27 時間」「precheck 36 回・約 4.8 時間のうち約 4.1 時間」とは行の数え方の差で少し違う（本文の集計の条件は書かれていない）。本書は上のコマンドの数字を使う（レビュー 1 が同じコマンドで再現した）。

### 1.3 待ちはどのゲートで起きたか（事実）

`cpu.heavy` を取る verify のゲートは、段 5・段 6 とも契約のゲート `unit-related@contract`（`contract.mjs` `UNIT_RELATED_GATE`、`mutex: cpu.heavy`、5,400 s）だけだった（verify.yaml の `unit` / `integration` を選んだ契約は無い）。待ちの記録がある verify の行はすべて `unit-related` を含む（段 5: 28 行、段 6: 19 行）。

`unit-related`（`scripts/run-related-unit-tests.mjs`）は、変更ファイルを `classifyChanges` で `none` / `related` / `full` に分け、`src/**` のコードと `tests/unit|helpers/**` 以外が 1 つでもあれば **`full`（`npm run test:unit`＝`tests/unit` 全部）** に倒す。その run の HEAD の差分（`git merge-base <head> origin/develop` からの差分。当時の `origin/develop` ではないので近似）で分け直すと:

| 全体に倒した理由になったファイルの種類（`src`・`tests/unit` 以外） | 段 5 の行 / mutex / run | 段 6 の行 / mutex / run |
|---|---|---|
| `md` のみ | 6 / 27,093 / 19,897 | 2 / 9,005 / 2,995 |
| `locales` ＋ `md` | 3 / 0 / 10,347 | 3 / 0 / 8,954 |
| `locales` ＋ `md` ＋ integration・e2e の試験 | 3 / 6,181 / 10,247 | 3 / 10,138 / 6,528 |
| `locales` ＋ integration・e2e の試験 | 3 / 6,671 / 9,575 | — |
| `md` ＋ integration・e2e の試験 | 3 / 20,757 / 6,661 | 2 / 0 / 5,690 |
| integration・e2e の試験のみ | 2 / 8,349 / 6,272 | — |
| **小計（B2 の対象: `*.md`・`locales/**`・`tests/(integration|e2e)/**` だけ）** | **20 / 69,051 / 62,999** | **10 / 19,143 / 24,167** |
| `scripts` のコード・設定（`.env.example`・`.gitignore`・`flow.yaml`）・`.sh` を含む | 5 / 14,487 / 15,348 | 9 / 24,155 / 16,413 |
| `related`（全体に倒れていない） | 3 / 15,163 / 5,830 | 0 |

`*.md` には `docs/` の文書のほか `.claude/**/*.md`（スラッシュコマンドの本文＝製品の挙動の一部）も入る。B2 の対象を「文書」と呼ばず「`*.md`」と呼ぶのはこのため（`.claude` の md の挙動は unit の範囲外で、`full` でも見ていない。B2 が判定を弱める対象ではない）。

つまり **`unit-related` の 47 行のうち 44 行が実際には全体（`tests/unit` 約 3,070 ファイル）を走らせていた**。製品のランナーは `CI=true` を注入するので vitest は直列（`vitest.config.ts` の `fileParallelism: false`・`maxConcurrency: 1`）で、1 回の `runSec` は平均で段 5 が約 3,000 s、段 6 が約 2,100 s。重い 1 本が長く持つので、後ろの待ちが積み上がる。

分け直しのコマンド（`<repo>` は CommandMate の worktree。`cls.mjs` は付録 A）:

```bash
jq -r 'select(.stage=="verify" and (.note|test("unit-related@contract")) and .mutexSec!=null) | "\(.head) \(.mutexSec) \(.runSec)"' "$F" |
while read h m r; do (cd <repo>; mb=$(git merge-base $h origin/develop); node cls.mjs "$(git diff --name-only $mb $h | tr '\n' ' ')" $m $r); done |
awk '{k=$1" "$2; n[k]++; m[k]+=$3; r[k]+=$4} END{for(k in n) print k, "n="n[k], "mutex="m[k], "run="r[k]}' | sort
```

leader が手で走らせた `unit-related` のログ（`runs/2026-11-17/unit-related-*.log`、11 本）でも 10 本が `mode=full`（理由は `docs/en/**`・`README.md`・`.env.example`・`docs/orchestrate/**`）。残る 1 本（`mode=related changed=19 textscan=925`）は 2 つの量を持つ:

- **ファイル数**: `--changed` の 751 ファイル＋リポジトリを読む試験（`findTextScanTests`）925 ファイル＝全体 3,065 の約 55%。うち textscan だけなら約 30%
- **時間**（standalone の並列）: `--changed` 64 s ＋ textscan 278 s ＝ 342 s。全体（253〜473 s）とほとんど変わらない

B2 の効果の比 f は**時間**（選ばれた試験の実行時間の和 ÷ 全体の実行時間の和）で測る（ファイル数の比は重い試験の偏りを見落とす）。**今の textscan で選ぶ形のままでは、全体に倒さなくしても時間はほとんど減らない**（B2 が実行時の読み取りの表を要る理由。§2.3）。

### 1.4 precheck の待ち（事実）

precheck の `mutexSec` が 0 でない行（＝広い段が `cpu.heavy` を待った行）と、同じ作業単位（issue＋item）・**同じ HEAD** の verify の記録。待ったのは 6 HEAD とも `related` の段だった（`runs/2026-11-14/precheck-*.out`・`precheck-*.log` の `related ok (… waited cpu.heavy …)` / `related held`。`tests` の段はどれもロックを取らずに走った）:

| 段 | precheck | 同じ HEAD の verify の記録 | `unit-related` の mode（分け直し） | 第 2 版の A の材料か |
|---|---|---|---|---|
| 5 | 4403 `80c749387` m=1,122 | なし | — | いいえ |
| 5 | 4419-1 `f5acddf57` m=2,602 | fail（`scope` だけ FAIL） | related | いいえ（`result≠ok`・related） |
| 5 | 4388-1 `ffe804892` m=5,400 **skip（exit 3）** | ok | full | **はい**（PR0 の記録がある前提） |
| 5 | 4387 `1ac4cfb86` m=4,796 | なし | — | いいえ |
| 5 | 4388-1 `ffe804892` m=749（上の再実行） | ok | full | **はい** |
| 5 | 4389 `c856bf553` m=2,960 | ok | full | **はい** |
| 6 | 4344-pr3 `43979112d` m=4,877 | **leader の裁定**（文で「unit-related 含む pass」。`passed=` が無い） | full | §5 の問い 2 による |
| 6 | 4436-l0 `23e71b9f6` m=5,400 **skip（exit 3）** | **leader の裁定**（文で「unit-related（全件 exit 0）passed」） | full | §5 の問い 2 による |

`ffe804892`・`c856bf553` は verify ok → precheck の順で、`env=` の hash も同じ（`d6684efeb45d`・`de7c47c600d9`。レビュー 1 が確かめた）。

### 1.5 見逃しの実績（事実）

- verify が `unit-related` で赤を出した行: 段 5 で 3（`dd7a2bb23` 4385-a4・`fb80935e4` 4418-b・`ed6be1c6b` 4386）、段 6 で 2（`526dfd460` 4436-a2・`bd5ffbd6f` 4344-pin）。うち 3 本（`dd7a2bb23`・`ed6be1c6b`・`526dfd460`）は B2 の対象の種類だけで全体に倒れた run で、B2 の陽性対照に使える既知の不合格
- CI の `Unit Tests` が落ちた 6 回（2026-11-13〜17、4197・4290×2・4439・4437×2）は、4437 `a01abc55f` の `Integration Tests`（次の HEAD で直った本物の不合格）を除き、同じ HEAD の再実行で合格した（揺れ）。`unit-related` の選び方の漏れで CI だけが捕まえた実例は、この期間に見つからなかった
- leader の手での全体の実行で落ちた試験（`runs/2026-11-17/unit-related-*.log` の `FAIL`）は、`tests/unit/guards/handoff-no-kill-4227.test.ts`・`tests/unit/lib/brief/brief-retry-paths-4223.test.ts`・`tests/unit/scripts/stop-waits-for-exit-2488.test.ts`・`tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts` などで、どれも standalone（並列・5 秒の上限）の負荷での時間切れ。#4254・verify.yaml の `unit` / `integration` の注記と同じ型の揺れ（C を採らない根拠の 1 つ。§2.5）

---

## 2. 案ごとの設計

### 2.1 案 A: precheck の `related` を verify の全体の合格で飛ばす

#### 2.1.1 既存（docs/orchestrate/ci-merge.md 6-1-1「precheck の段と再利用」）

- precheck は同じ HEAD・同じ引数・同じ作業の HEAD・`verifyEnvState` が `changed` / `missing` でない `precheck=ok` を再利用する
- 同じ HEAD の**最新の** verify 行が `result=ok` のとき、その `passed=`（`passedGates`）から `COVERED_BY_GATE`（`lint`→`eslint`・`typecheck`→`tsc`・`lint-sh`→`lint-sh`）の段を飛ばす
- 試験のゲート（`unit` / `unit-related`）は**どの段の代わりにもならない**（`tests/unit/scripts/orchestrate/precheck.test.ts` の `a unit / unit-related pass does not stand in for the test steps`）
- merge-pr は `needUnit: o.unitRelated || heavyToCi || !ranFullUnit(verify)` で、`passed=` に verify.yaml の `unit` があるときだけ CI の `Unit Tests` を待たない

#### 2.1.2 第 1 版からの狭め（レビュー 1 の F-1・F-2・F-3・F-10・F-13・F-14）

| 狭めたもの | 理由 |
|---|---|
| 材料は `result=ok` の行だけ。`unconfirmed:`・`waited-for=`・exit 0 以外の行は使わない。その作業単位・その HEAD の**最新の** verify 行だけを見る（後の行が FAIL なら古い合格は使わない） | wait-verify は判定にならなかった行（supersede・合図なし・working・late supersede・dirty・inputs の変化・exit 99）も `passed=` 付きの `fail` で書く。記録の `head` は記録時の `headNow()` で、run が見た commit ではない（F-1） |
| run が見た HEAD をサーバーが記録し、その HEAD が開始と終わりで同じ・作業ツリーが開始と終わりで clean・それが今の HEAD と一致、の 3 つを機械で確かめる。記録の無い行は使わない | 同上（F-1・R5）。tree ではなく **HEAD の一致**にする（merge-pr・publish-pr は verify を HEAD で見る。同じ tree・別 HEAD の当たりは段 5・段 6 で 0。F-13） |
| 対象は `unit-related@contract` の `full` だけ。verify.yaml の `unit` は対象にしない | `unit` の合格では merge-pr が CI の `Unit Tests` を待たない。A で precheck も飛ばすと、マージ前の試験がサーバーの env の verify 1 回だけになる（F-3 の (b)） |
| `verified` を使った HEAD は、`--last` の有無によらず merge-pr が CI の `Unit Tests` を待つ | 「PR の CI が全体をもう一度見る」を安全網に数えるため。`unit` を外した今も、将来 `ranFullUnit` が広がったときの網として明示する（F-3 の (a)） |
| 飛ばすのは `related` の段だけ。`tests` の段（変えた試験・名指しの試験・guards・docs）は今までどおり precheck の process で並列に走らせる | precheck の並列実行（`fileParallelism: true`・`maxConcurrency: 10`）は、マージ前で唯一の並列の観測。試験の隔離の不具合（共有の一時ディレクトリ・ポートの衝突）は並列でしか出ない。変えた試験は新しい隔離の不具合が最も入りやすい（F-10）。§1.4 の 6 HEAD はどれも `related` の段が待っていたので、見込みは減らない |
| 既存の `passedGates`・`ranFullUnit`・`COVERED_BY_GATE` の意味は変えない。A は別の関数（`reusableUnitRelatedPass`）で判定する | `passedGates` を `ok` 以外に広げると、eslint / tsc の再利用と merge-pr の `Unit Tests` の待ちにも波及する（F-2） |
| leader の裁定の行（`result=ok` だが元の run は `fail`）は PR1 では使わない。PR2 で、§5 の問い 2 が認めたときだけ、失敗したゲートが `scope` と `$HOME`・`~/.commandmate` の項目だけの `env-clean` に限って使う（listener・tmux の項目を含む行は使わない） | 残ったサーバー・セッションは試験の結果に効きうる（F-14） |

#### 2.1.3 PR0: 記録を足す（判定は変えない）

1. **サーバーの run に HEAD と作業ツリーの状態を記録する**: `src/lib/verification/gate-runner.ts` が run の開始（最初のゲートの前）と終わり（最後のゲートの後）に `git rev-parse HEAD` と作業ツリーの dirty（`git status --porcelain`。precheck が許す `.commandmate/tasks/`・`dev-reports/` は除く）を取り、`verification_runs` の新しい列（`head_start`・`head_end`・`dirty_start`・`dirty_end`。DB の migration）に書く。`verify show --json` と `src/cli/types/` の写しに出す。取れなければ null（null の run は A の材料にならない）
2. **ゲートの中で環境を取る**: `scripts/run-related-unit-tests.mjs` は `full` のとき、既存の最後の行 `run-related-unit-tests: full exit=<code>` の**後に** 1 行 `run-related-unit-tests: verdict selection=full exit=<code> gate-env=<hash>` を出す。`gate-env` はゲートの process の中で取る（サーバーの PATH・env をそのまま見る）: `process.version`・`process.execPath` の実体・`CI`・`NODE_OPTIONS`・uid が 0 か・`process.platform`/`arch`・PATH 上の道具の有無（試験が `skipIf` に使う集合: `shellcheck`・`lsof`・`jq`・`tmux`・`ffmpeg`・`pm2`・`git`・`bash`・`sqlite3` など。一覧は PR0 で `tests/unit` の `skipIf` の条件から作り、新しい `HAS_*` の名前が一覧に無ければ落ちる guard を足す）・`package-lock.json` の sha256・`node_modules` の実体と直接依存の版。計算は `scripts/lib/gate-env.mjs`（新規。precheck と共有）
   - 既存の行と期待（`tests/unit/scripts/run-related-unit-tests.test.ts` の `expect(logs).toContain('run-related-unit-tests: full exit=0')`）は変えない
   - 読み手は log tail の**最後の非空行**だけを見て、その直前の非空行が `run-related-unit-tests: full exit=0` であることを突き合わせる。2 行とも vitest の子が終わった後にスクリプトが出すので、試験の出力が同じ文字列を含んでも最後の 2 行にはならない（F-12。試験で固定）
3. **ゲートの宣言の hash**: 契約の `gateDefinitions` の `unit-related` の項目**全体**（`command`・`timeoutSec`・`mutex`・`env` などすべての欄。`contract.mjs` が書く形）を正規化して sha256 を取り、wait-verify が要約に `unit-related-def=<12 桁>` と書く（F-11）
4. **wait-verify が要約に写す**: 既に読んでいる `verify show --json` の view から、`run-head=<sha>`（`head_start` と `head_end` が同じときだけ。違えば `run-head=moved`）・`run-clean=<1|0>`（両方 clean で 1）・`unit-related-verdict=full:0:<gate-env>`（最後の 2 行が正しいときだけ）・`unit-related-def=` を足す
5. **env-manifest は変えない**: node の版は manifest に足さず `gate-env` に入れる。既存の `verifyEnvState`・`diffManifest`・pr-common・merge-pr の比較は今のままなので、導入の時点で進行中の記録が一斉に `changed` になって publish・merge が止まることは無い（F-7）
6. PR0 の後、**1 段（並列の run 1 回）走らせて記録を溜め**、記録が正しく付いていること（`run-head=` が `head` と一致する率、`unit-related-verdict=` が付く率）を run-log で数えてから PR1 を入れる

#### 2.1.4 PR1: precheck の判定

`related` の段を走らせず、要約に `related=verified` と書く（結果は `ok`。新しい状態語。`parseNote` の語彙に足す）のは、次の**すべて**を満たすとき:

1. その作業単位（issue＋item）で `head` が今の HEAD に等しい verify 行のうち、**最新の行**が:
   - `result=ok`、要約が `exit=0(passed)` で始まり、`unconfirmed:`・`waited-for=` を持たない
   - `run-head=<今の HEAD>`（`moved` でない）・`run-clean=1`
   - `passed=` に `unit-related@contract`、`unit-related-verdict=full:0:<gate-env>`
   - `unit-related-def=` が precheck の知っている `UNIT_RELATED_GATE` の正規化の hash と一致
2. `verifyEnvState(その行)` が **`same`**（`unrecorded`・`missing`・`changed` は使わない。eslint / tsc の再利用が `unrecorded` を警告で通すのより厳しい）
3. precheck の process で `scripts/lib/gate-env.mjs` が計算した `gate-env` が、記録の `gate-env` と一致（node の版・PATH の道具・`CI` を除く欄。`CI` は verify で `true`、precheck では無いのが正しい差なので比較から外し、§2.1.5 で差として扱う）
4. `--force` が無い

満たさなければ今までどおり走らせる（重ければ `cpu.heavy`、`--heavy-to-ci` なら `ci`）。`tests` の段はいつも今までどおり。

merge-pr: HEAD の precheck の要約に `related=verified` があれば `needUnit` を真にする（`leftHeavyToCi` と同じ扱い。関数 `usedVerifiedPass`）。`run-log.mjs status` の `next`・publish-pr / merge-pr の `unmetStage` は `verified` を `ok` の段として読む。

#### 2.1.5 品質の根拠

- **包含**: `unit-related` の `full` は `vitest run tests/unit`。precheck の `related`（`vitest related --dir tests/unit`）は `tests/unit` の部分集合。同じ HEAD（run の間に動いていない・clean）・同じ依存・同じゲートの宣言なら、`related` の試験はすべて verify で走って通っている
- **走らせ方の差（3 つ。§5 の問い 1a）**:
  1. 時間の予算: verify は `CI=true`（試験の上限 20 s）、precheck は 5 s。5 s を超えて 20 s 以内で通る試験は precheck の `related` でだけ赤になる。これは揺れとは限らない（毎回 7 s かかる試験は決定的に手元の 5 s の予算で赤い）。本書は**「手元の予算の差」**と呼び、PR の CI（`CI=true`・20 s）を正の判定とする整理を受け入れるかを §5 で問う（F-15）
  2. 並列: `related` の試験の並列の観測は無くなる。`tests` の段（変えた試験・名指し・guards・docs）は並列のまま残す（F-10）。変えていない試験が、ブランチの `src/` の変更で並列でだけ壊れる形（共有の場所への書き込みを `src/` に足した等）は、precheck の `related` でしか見えていなかった。CI は直列の shard なのでこれを見ない。**手放すか**を §5 の問い 1a で問う
  3. skip の集合: `gate-env` の一致で、PATH の道具の有無による `skipIf` の差を潰す（F-4）。一覧の外の `skipIf`（uid・環境変数による分岐）は guard で一覧に入れる
- **manifest の外の入力（§5 の問い 1b）**: `$HOME` の下・ignore されたファイルは `env=` の manifest にも `gate-env` にも入らない。`tests/setup.ts` が一時の場所へ向けるのは `CODEX_HOME`・`COPILOT_HOME` など個別の変数で、`HOME` 全体ではない。使い回すのは同じ作業単位の verify の直後の precheck に限られ、`verified` の HEAD は CI の `Unit Tests` を必ず待つ（§2.1.4）。この危険は今の eslint / tsc の再利用にもあるが、試験は lint より tree の外を読みやすい
- **論理の不合格**（同じ HEAD で毎回落ちるもの）は verify の全体で必ず出て、その行は `result=ok` にならないので材料にならない。N1 は保たれる（出る場所が verify に寄るだけ）

#### 2.1.6 陽性対照・陰性対照

試験は一時の run dir・一時の worktree（`os.tmpdir()` の下）で作る。

1. 同じ HEAD で `unit-related` が FAIL した行 → 走らせ、同じ試験で落ちる
2. `selection=full` で通った後に、試験 1 本を赤にする commit を足す → HEAD が違うので走らせ、`related` がその試験で落ちる
3. **working の場面**（F-1）: verify が H0 を見て走っている間に H1 を commit → サーバーの `head_end`≠`head_start` で `run-head=moved`、記録は `unconfirmed:` 付き → H1 の precheck は走らせる
4. **dirty の場面**（F-1）: verify が HEAD＋未コミットの修正で通り、修正を捨てる → `run-clean=0` → 走らせる
5. superseded・合図なし・late supersede・inputs の変化・exit 99（busy / mutex）の各行 → 走らせる（V1 の後の行の形で、V1 の試験の fixture を流用する）
6. 同じ HEAD の後の verify 行が FAIL（前の行は ok）→ 最新の行を見て走らせる
7. `package-lock.json` だけ違う（`env=` が `changed`）、`gate-env` の node の版だけ違う、PATH から `shellcheck` を抜いた precheck → それぞれ走らせる
8. `unit-related-def` の `timeoutSec` だけ違う → 走らせる
9. 最後の行の偽装: 試験が `run-related-unit-tests: verdict selection=full exit=0 …` を stdout に出し、ゲートは exit 1 → 最後の 2 行の突き合わせで材料にならない
10. **陰性対照**: `run-head=` などの無い今の形の ok 行では今までどおり走らせる（既存の `a unit / unit-related pass does not stand in for the test steps` はそのまま通る）。`scope` だけ落ちた行で eslint / tsc を飛ばさない、`unit` の fail 行で `ranFullUnit` が false（F-2 の固定）
11. **実データの再生**: 段 5 の 4388-1 `ffe804892`（precheck が exit 3 で保留になった HEAD）と同じ形の記録（PR0 の欄つき）を一時の run dir に置くと、`related=verified tests=ok` で exit 0 になる
12. merge-pr: `related=verified` の HEAD は `--last` なしでも `Unit Tests` を待つ

#### 2.1.7 削減の見込み（§1.4 から）

| 段 | 対象 | precheck の mutex の削減 | 保留（exit 3）の回避 | 条件 |
|---|---|---|---|---|
| 5 | 4388-1（5,400＋749）・4389（2,960） | **9,109 s / 17,629 s（52%）** | 1 回 | PR0 の記録が付いていること（当時の記録には無いので、記録があったと仮定した見込み） |
| 6 | 4344-pr3（4,877）・4436-l0（5,400） | 10,277 s / 10,277 s | 1 回 | §5 の問い 2 で裁定の行を認め、PR2 の条件を満たすときだけ。認めなければ 0 |

見立ての注意: precheck が `cpu.heavy` の列から抜けると後ろの verify の待ちも縮む。その分は数えていない（下限）。

#### 2.1.8 PR2: 裁定の行を機械で読める形にする（§5 の問い 2 が認めたときだけ）

`run-log.mjs append --verify-run <run id>` を足す。写すのは、サーバーの run（`verify show <id> --json`）の `head_start`/`head_end`/`dirty_*`・ゲートの結果・最後の 2 行・`gate-env`。次をすべて機械で確かめ、1 つでも外れたら写さない（裁定の行は書けるが A の材料にならない）（F-6）:

- run の `head_start`＝`head_end`＝今の HEAD、`dirty_start`＝`dirty_end`＝clean
- `env=`: 同じ作業単位の run-log の verify 行のうち、要約に `run=<id>` か `waited-for=run <id>` を持ち `env=` と `key=` のある行を探し、`keptManifest(runDir, key, hash)` が見つかること
- 失敗したゲートが `scope` と、`$HOME`・`~/.commandmate` の項目だけの `env-clean`（`wait-verify.mjs` `envCleanItems` で分類。listener・tmux の項目があれば写さない。F-14）
- 裁定の理由は今までどおり要約の自由文に書く

#### 2.1.9 変えるファイル

- PR0: `src/lib/verification/gate-runner.ts`・`src/lib/db/` の migration と行の型・`verify show` の API の型と `src/cli/types/` の写し・`scripts/run-related-unit-tests.mjs`（最後の行）・`scripts/lib/gate-env.mjs`（新規）・`scripts/orchestrate/wait-verify.mjs`（要約の語。**V1 #4459 と同じファイル**）・試験（gate-runner・migration・run-related・wait-verify・gate-env・`skipIf` の一覧の guard）
- PR1: `scripts/orchestrate/precheck.mjs`（`reusableUnitRelatedPass`・`verified`）・`scripts/orchestrate/merge-pr.mjs`（`needUnit`）・`scripts/orchestrate/pr-common.mjs`・`run-log.mjs`（`verified` を読む）・試験・`docs/orchestrate/ci-merge.md` 6-1-1
- PR2: `scripts/orchestrate/run-log.mjs`（`--verify-run`）・試験・`docs/orchestrate/exit-codes.md` 3-4

#### 2.1.10 危険と採否

- 危険: 記録の偽り（手で `run-head=` などを書く）。→ PR1 は wait-verify が書いた行（`run=<id>` を持つ）と PR2 の `--verify-run` の行だけを読む。手書きの要約は `unit-related-verdict=` を持たないので材料にならない
- 危険: サーバーの HEAD の記録と、ゲートが読んだ作業ツリーの間の競合（開始と終わりの間に HEAD が動いて戻る）。→ 開始と終わりの 2 点しか見ないので、間で動いて戻った場合は検出しない。ワーカーが verify の間に commit して reset で戻す形で、wait-verify の `working`（confirmCompletion）でも拾えない。**残る危険**として明示する
- **採る**（PR0 → 1 段 → PR1。PR2 は §5 の問い 2 による）

### 2.2 案 B1: `scripts/` のコードを import の追跡に入れる

#### 仕組み

`classifyChanges` の「コード」の正規表現を `^(src|scripts)/.+\.(ts|tsx|js|jsx|mjs|cjs)$` にする。precheck の `RELATED_SOURCE` と同じ範囲になる。`vitest --changed <merge-base>` は試験から import される `scripts/*.mjs` を module graph でたどる。

#### 品質の根拠と穴

- import で届く試験: `vitest --changed` の graph（`src/` と同じ扱い）
- 子プロセスで `node scripts/x.mjs` を起こす試験: 本文に `spawnSync` などと `'scripts/` があれば `findTextScanTests` が選ぶ（今 `src/` の変更で頼っているのと同じ根拠）
- 穴（レビュー 1 の F-9）: (a) `npm run …` を `execSync` で呼ぶ試験（`'scripts/` の文字列が無い）、(b) `tests/helpers`（`real-shell-budget.ts`・`real-server-fence.ts`・`claude-launch-command.ts`）越しに子を起こす試験、(c) `tests/setup.ts` から import される script の変更を `vitest --changed` が setupFiles としてどう扱うか（**未確認**）。どれも B2 の表（実行時の記録）で拾える形なので、B1 は B2 と同じ網羅の確かめ（§2.3.4）で確かめる

#### 陽性対照

- 一時の worktree で `scripts/orchestrate/precheck.mjs` の `HEAVY_TEST_FILES` を 49 に変える → `tests/unit/scripts/orchestrate/precheck-heavy-3884.test.ts` が選ばれて落ちる（import の経路）
- `scripts/check-token-discipline.mjs` の判定を 1 つ壊す → `spawnSync(process.execPath, [scripts/check-token-discipline.mjs, …])` で起こす `tests/unit/scripts/check-token-discipline.test.ts` が選ばれて落ちる（子プロセスの経路）
- 上の (a)〜(c) の経路を 1 本ずつ壊す → 選ばれて落ちる

#### 採否

単独の効果は段 5・段 6 で 0（§1.3: `scripts` を含む run はいつも `md` か設定も変えている）なのに、選ぶ集合を狭める。**B2 を採るときだけ PR4 に入れる**（測定の PR3 には入れない。F-9）。

### 2.3 案 B2: `*.md`・locale・integration の試験の変更で全体に倒さない

#### 2.3.1 表の鍵の命中率（事実。レビュー 1 の F-5）

表は「その tree で全体を走らせたときの読み取り」なので、読み手のコード（`src`・`scripts`・`tests/unit`・`tests/helpers`・`tests/setup.ts`・`vitest.config.ts`・`package-lock.json`）が同じ tree でしか正しくない。B2 の対象の 30 run（段 5 の 20・段 6 の 10）で測った（付録 C の `keyhit*.mjs`）:

| 鍵の取り方 | 段 5 | 段 6 | 計 |
|---|---|---|---|
| ブランチの HEAD の読み手の tree と、その日 00:00Z の develop の表 | 0 / 20 | 0 / 10 | **0 / 30** |
| ブランチの HEAD と、同じ作業単位（または任意の作業単位）の先の全体の run の表 | 0 / 20 | 0 / 10 | **0 / 30** |
| merge-base の tree（`tests` 全体・`src`・`scripts`・`vitest.config.ts`・lockfile）と、その日 00:00Z の develop の表 | 3 / 20 | 0 / 10 | **3 / 30（10%）** |
| ブランチが読み手のコードを変えていない run | 0 / 20 | 0 / 10 | **0 / 30** |
| 異なる merge-base の数 | 5 | 5 | 10 |

B2 の対象の run は**すべて**読み手のコードも変えていた（`md` だけの差分の run は無い）。したがって:

- 表を HEAD の鍵で引く形（安全）は**一度も当たらない**
- 当てるには「merge-base の表＋ブランチのコードの変更は今の `related`（graph＋textscan）で選ぶ」の合成（§2.3.2）が要り、その上で merge-base の表が要る。日次の表では 10%

#### 2.3.2 仕組み（合成の選び方）

B2 の対象の変更（全体の理由になったファイルが**すべて** `*.md`・`locales/**`・`tests/(integration|e2e)/**`）のときだけ、次の和を走らせる:

- (i) ブランチのコードの変更に対する今の `related` の選び方（`--changed <merge-base>`＋textscan）。ブランチのコードの変更で読み取りが変わりうる試験は、そのコードに graph か子プロセスで届く試験なので (i) に入る（M11 への手当て）。残る穴は今の `related` mode と同じ（新しい仮定を足さない）
- (ii) **merge-base の表**で、変更したデータのファイル（とその祖先のディレクトリ。存在しないパスは最も近い既存の祖先で引く）を読んだ試験
- (iii) merge-base の表で「不透明」の試験すべて（§2.3.3）
- (iv) 変更した試験・`tests/unit/guards`・`tests/unit/docs`

**全体に倒す条件**（fail-closed）: merge-base の表が無い／表の鍵（merge-base の読み手の tree の hash）が合わない／表が読めない／B2 の対象の外のファイル（設定・`.sh`・`package.json` など）が 1 つでもある → 今までどおり `mode=full`。

**表を作る場所**: 日次では 10% しか当たらないので、**develop の commit ごと**に表が要る。候補は develop の push の CI（`Unit Tests` の shard を traced で走らせ、artifact に置く）。CI の VM は Linux で PATH の道具も違うので、表の run で pass 以外（skip・fail・時間切れ）の試験は不透明にする（M7）。手元で作るなら `CI=true`・verify と同じ機械・同じ PATH で、develop の commit ごとに `cpu.heavy` を 1 回取る費用が要る（§5 の問い 5）。

#### 2.3.3 表の作り方の要件（レビュー 1 の M1〜M12）

| # | 取りこぼしの経路 | 要件 |
|---|---|---|
| M1 | vite の変換を通る読み取り（`src/i18n.ts` の `import(\`../locales/${locale}/common.json\`)`・`?raw`・JSON の import） | ワーカーの `fs` の包みには見えない。graph に乗るかは**未確認**。`src/i18n.ts` 経由の locale の変異を陽性対照に足し、届かなければ `locales/**` を B2 の対象から外す |
| M2 | 外部化された依存の ESM の名前付き import（`import { readFileSync } from 'node:fs'`） | 包んだ後に `module.syncBuiltinESMExports()` を呼ぶ。tracer の試験で固定 |
| M3 | setup より前に `fs` の関数を捕まえた依存 | 「`fs` のすべての読み取りの経路が記録される」を tracer の試験で固定。捕まえられない依存を使う試験は不透明 |
| M4 | 包む API の漏れ（`copyFileSync`・`cpSync`・`createReadStream`・callback の `readFile`・`openSync`/`readSync`・`accessSync`・`realpathSync`・`watch`。tests/unit で `copyFileSync`/`cpSync`/`createReadStream` を使う試験は 23 ファイル） | API の列挙でなく、`fs`・`fs/promises` の**すべての関数**を包み、パスの引数を記録する |
| M5 | 明示の env（`env: { PATH, HOME }`）で起こした node の子に `NODE_OPTIONS` が届かない | `child_process` を包み、tracer が子に届いたことを子から返事させる。返事の無い子を起こした試験は不透明。node 以外の子（`bash`・`git`・`shellcheck` など）を起こした試験も不透明 |
| M6 | `worker_threads` | Worker を起こした試験は不透明 |
| M7 | 表の run で skip・fail・時間切れの試験 | pass 以外はすべて不透明 |
| M8 | 存在しないパスの読み取り・新しいディレクトリ | 失敗した lookup も記録する。引くときは最も近い既存の祖先まで辿る |
| M9 | 非同期の読み取りの帰属 | 帰属は `testPath` ではなく process（`isolate` で 1 ファイル 1 process）で取る |
| M10 | 枝の差（tree の外の入力に依る分岐） | 表の run と verify の `gate-env` が違えば表を使わない。残りは網羅の確かめ（§2.3.4）で実害の有無を見る |
| M11 | ブランチのコードの変更で読み取りの集合が変わる | §2.3.2 の (i)。ブランチのコードの変更に届く試験は表に頼らない |
| M12 | `tests/setup.ts` 自身の読み取り | 帰属から除く |

#### 2.3.4 品質の根拠（N3）と網羅の確かめ方（レビュー 1 の F-8）

- import の追跡の範囲: `vitest --changed` の graph（今と同じ）＋ M1 の陽性対照
- リポジトリのファイルを読む試験の扱い: 実行時の読み取りの観測（本文の正規表現の推定ではない）。見えない読み取りは不透明として常に選ぶ
- **網羅の確かめ（壊し方）**: 段 5・段 6 の `unit-related` の run（47 行）で変わったデータのファイルは **44 本**（`md` 30・`locales` 4・integration/e2e の試験 10）。1 本ずつ（中身を空にする・1 行消す の 2 通り）壊し、**表で選ばれなかった試験だけ**を `CI=true` で走らせて赤が 0 であることを確かめる。88 回 ×（1−f）× 全体の時間（2,100〜3,000 s）で、f=0.5 なら約 25〜37 時間の機械の時間（一時の worktree で、`cpu.heavy` を取って走らせる）
- **既知の不合格の再現**: §1.5 の 3 本（`dd7a2bb23`・`ed6be1c6b`・`526dfd460`）について、その HEAD の全体で落ちた試験の集合 F（merge-base でも落ちる試験は別に記録）と B2 の選ぶ集合 S で **F ⊆ S**
- **変異の対照**（経路ごと。一時の worktree で 1 つずつ）: `docs/en/security-guide.md` の見出しを消す（直接の読み取り）／`locales/en/common.json` のキーを消す（`tests/helpers/real-intl.ts` 越し、と `src/i18n.ts` の dynamic import 越しの 2 経路。M1）／`.claude/commands/orchestrate.md` を 118,000 bytes 超にする（import した script の中の読み取り）／node の子がリポジトリのファイルを読む試験・明示の env で起こした node の子・`worker_threads`・`skipIf` で skip する試験を表から 1 本ずつ選び、そのファイルを壊す（M5〜M7）／`tests/integration/` の試験を名指しで読む guard の対象を壊す
- **陰性対照**: `src/` だけの差分では選ぶ集合が今と同じ。表が無い・鍵が合わないときは `mode=full`

#### 2.3.5 採否の条件

PR3（測定だけ。判定は変えない）で次の**すべて**を出し、満たしたときだけ PR4 で切り替える。1 つでも満たさなければ**採らない**（N5）:

1. **鍵の命中率**: develop の commit ごとに表を作る運用を 1 段（並列の run 1 回）走らせ、B2 の対象の run のうち merge-base の表が使えた率が **80% 以上**（閾値は §5 の問い 4）。日次の表（実測 10%）では満たさない
2. **網羅**: §2.3.4 の壊し方 88 回で、選ばれなかった試験の赤が 0。既知の不合格 3 本で F ⊆ S。変異の対照がすべて選ばれて落ちる
3. **効果**: f（時間の比、§1.3）が 0.5 以下。かつ「命中率 × (1−f) × 対象の保有時間」が、表を作る費用（CI の traced run・手元で作るなら `cpu.heavy` の保有）を引いて正

#### 2.3.6 削減の見込み（上限）

`cpu.heavy` を持つ時間（verify の `runSec` から `unit-related` 以外のゲートの分 52 s を引いた和。付録 B）のうち B2 の対象の run の分（事実）:

| 段 | 持つ時間の和 | うち B2 の対象 |
|---|---|---|
| 5 | 83,157 s | 61,892 s（20 run） |
| 6 | 39,810 s | 23,675 s（10 run） |

待ちの削減は、run-log の到着時刻を使った先着順・1 本の列の再生で見立てる（付録 B の `sim.mjs`。対象の run の保有時間だけを f 倍）。**これは命中率 100% を仮定した上限**で、実際の削減は命中率を掛けたものになる:

| 段 | 観測した待ち（verify＋precheck） | 再生（f=1、今のまま） | f=0.5 | f=0.25 | f=0 |
|---|---|---|---|---|---|
| 5 | 116,330 s | 80,651 s | 23,280 s（−71%） | 15,717 s（−81%） | 10,232 s（−87%） |
| 6 | 53,575 s | 11,108 s | 7,368 s（−34%） | 6,671 s（−40%） | 6,671 s（−40%） |

再生は観測の待ちを段 5 で 69%、段 6 で 21% しか再現しない（run-log に載らない `cpu.heavy` の保有者がいる: leader の手での `unit-related`・`combo-*`・busy の 99 で wait-verify が見失ったサーバーの run）。**削減率（同じ再生の中での前後の比）だけを見込みに使い、秒数は使わない**。

#### 2.3.7 変えるファイル

- PR3（判定を変えない）: `tests/setup.ts`（環境変数 `CM_TRACE_REPO_READS` があるときだけ。無いときに `fs`・`child_process` が包まれていないことを試験で固定）・`scripts/read-trace/*.mjs`（新規。tracer・表の作成・命中率と f の測定・壊し方の網羅の実行）・CI の develop の push の job（表の artifact）・試験・本書（測定の結果）
- PR4（切り替え。§2.3.5 を満たしたとき）: `scripts/run-related-unit-tests.mjs`（B1 の正規表現と B2 の合成の選び方）・`tests/unit/scripts/run-related-unit-tests.test.ts`（既存の `classifies changelog.d/2865.md and locales/ja/worktree.json as full with locales reason` などは**表が無いとき**の期待として名前・期待を変えずに残し、表があるときの `it` を足す）・`docs/orchestrate/ci-merge.md` 6-1-1。導入後 2 段の間、表で選んだ HEAD の PR の CI `Unit Tests` の不合格（揺れでないもの）が 1 件でも出たら、環境変数で `mode=full` に戻して原因を調べる

### 2.4 案 B3（検討して外した）: 本文の正規表現で選ぶ

`findTextScanTests` と `findTestsNaming`（パスの文字列）だけで選ぶ形。helper 越しに読む試験（`real-intl.ts` など）と、親のディレクトリを `path.join(root, 'docs')` で組み立てて一覧する試験を落とす根拠が示せない。かつ §1.3 のとおり時間がほとんど減らない。**採らない**。

### 2.5 案 C: `cpu.heavy` の枠を 2 本にする

#### 仕組みと見込み

`cpu.heavy` をマシンで 2 本にする（#4370 PR3 のセマフォの重み、または mutex の多重化）。2 本の列の再生（付録 B、`K=2`）では待ちが段 5 で 80,651 → 8,679 s、段 6 で 11,108 → 853 s。ただし**同時 2 本で 1 本あたりの実行時間が伸びる分を入れていない**（上限の見立て）。

#### 負荷の揺れが増えないことの確かめ方（N4）

既存の実測（verify.yaml の注記）:

- `unit`: 単独 486〜553 s は PASS、同時実行の 640 s で `monitor-exit-codes.test.ts` が FAIL（#1917）
- `integration`: モード B（standalone・並列）で負荷下 11 ラン中 10 ランが赤、`cpu.heavy` を持つ条件で 6/6 緑。モード A（製品・直列）は 9/9 緑
- #4254（`worktrees-status-split-2060.test.ts`）など CI の揺れが今も続いている。§1.5 の手での全体の実行でも負荷の時間切れが毎回 2〜6 本出ている

確かめ方（採るなら PR の前に要る）:

1. 条件: モード A（`CI=true`）で `npm run test:unit` を (a) 単独と (b) 2 本同時、同じ commit・同じ環境（manifest が `same`）で交互に走らせる。CI のランナーが動いている時間帯を含める
2. 判定の規則: **(b) の 60 回（2 本 × 30 組ではなく、(b) の各 1 本を 1 回と数えて 60 回）で赤 0 なら採る**。0 件の観測で「揺れの率が 5% 未満」と 95% で言うには 3/n ≤ 0.05 から n ≥ 60（rule of three）。(b) に 1 件でも赤が出たら、(a) にも同じ試験の赤が同じ条件で出ていても採らない（(a) と (b) の差を 60 回で区別する検出力が無いため、決定を変える証拠として数えない）
3. 費用: モード A の全体は段 5・段 6 の実績で 1 本 2,100〜3,000 s。(a) 60 回＋(b) 30 組（60 本）の計 120 本で約 70〜100 時間の機械の時間

#### 採否

**採らない**。(1) 揺れが増えないことの根拠が今は無く、取るには上の試走が要る。(2) 枠の数の決め方は #4370（PR3 で `cpu.heavy` の取り手をセマフォへ移す）の範囲で、`weights.cpu_heavy`（今 4）と `ci_vm.cpus` の配分と一緒に決めるべき。#4370 に上の判定の規則つきで渡す（§5 の問い 3）。

### 2.6 案 D（採らない）: 安い契約ゲートが落ちたら試験を打ち切る

verify の赤の多くは `scope`・`env-clean`（段 5: 27 のうち scope 14・env-clean 9）で、試験の前に分かる。落ちた時点で `unit-related` を打ち切れば待ちは減るが、(1) その run で試験の不合格が出なくなり N1 を満たさない、(2) 段 5・段 6 の scope・env-clean の赤の多くは leader の裁定で合格にしたので、試験の結果がその裁定に要った。**採らない**。

### 2.7 案 E（採らない）: verify どうしで同じ tree の試験の合格を使い回す

同じ作業単位で、前の verify が `unit-related` を通した tree と同じ tree で次の verify が走った行は、段 5・段 6 とも **0**（付録 A の `reuse.mjs`）。再指示のたびに commit が増えて tree が変わるため。効果が 0 なので**採らない**。

---

## 3. 実装の分け方（PR の境目。team.md §6 の 3）

### 3.1 PR の一覧

| PR | 中身 | 危険の種類 | 依存 |
|---|---|---|---|
| **PR0**（A の記録） | サーバーの run の HEAD・dirty の列（DB の migration）・`run-related-unit-tests.mjs` の最後の行と `gate-env`・`scripts/lib/gate-env.mjs`・wait-verify の要約の語・`skipIf` の一覧の guard | 記録だけ（判定は変えない）。DB の migration を含む | V1 のマージ後（§3.3） |
| （1 段） | PR0 の記録を 1 段溜め、付く率を数える | — | PR0 |
| **PR1**（A の判定） | `precheck.mjs` の `reusableUnitRelatedPass`・`related=verified`・`merge-pr.mjs` の `needUnit`・`pr-common.mjs`・`run-log.mjs` の読み手・ci-merge.md 6-1-1 | 再利用の判定（品質に直結） | PR0 と 1 段 |
| **PR2**（A の裁定の行） | `run-log.mjs append --verify-run`・exit-codes.md 3-4 | 記録の形。§5 の問い 2 が認めたときだけ | PR1・#4433 |
| **PR3**（B2 の測定） | traced の表の作成（`tests/setup.ts` は環境変数のときだけ）・develop の push の CI の job・命中率・f・壊し方の網羅の実行 | 判定を変えない。全試験が読む `tests/setup.ts` に触る | §5 の問い 4・5 の答え |
| **PR4**（B1＋B2 の切り替え） | `run-related-unit-tests.mjs` の B1 と合成の選び方・ci-merge.md 6-1-1 | 選ぶ集合（品質に直結） | PR3 で §2.3.5 をすべて満たし、PM が承認 |

C は PR にしない（#4370 に渡す）。D・E は作らない。

### 3.2 各 PR の受入条件の確かめ方（Issue の受入条件との対応）

| PR | 前後の数字（run-log） | 見逃しが増えていない根拠 |
|---|---|---|
| PR0 | 判定は変わらないので待ちは変わらない。導入後の段で `run-head=` が `head` と一致する率・`unit-related-verdict=` が付く率・`run-head=moved` の数 | 記録の正しさの試験（§4.1 の P 行） |
| PR1・PR2 | 導入後の段で、precheck の行の `mutexSec` の和・`related=verified` の行の数・exit 3 の precheck の数を §1.2 と同じコマンドで出し、段 5・段 6 と比べる | §2.1.6 の対照 1〜12 を試験で固定。導入後の段で、`verified` の HEAD の PR の CI `Unit Tests` が合格していること（`ci` の行） |
| PR3 | 判定は変えないので待ちの数字は変わらない。命中率・f・網羅の結果を本書に書く | §2.3.4 の壊し方・既知の不合格・変異・陰性対照 |
| PR4 | 導入後の段で、verify の `unit-related` の行の `runSec`・`mutexSec` の和と、`selection=` の内訳を出し、段 5・段 6 と比べる | PR3 の対照を PR4 の試験にも残す。導入後 2 段の監視と戻す環境変数（§2.3.7） |

### 3.3 V1（#4459・#4433）との関係

- **挙動の依存**（ファイルの重なりより重い）: V1 は busy 待ちの上限と、exit 99 の行の書き方を変える。A が拒む「判定にならなかった行」の集合が V1 で変わるので、PR1 の受け入れ条件（`unconfirmed:`・`waited-for=`・exit 0 だけ）は **V1 の後の行の形**で確かめ、V1 の試験の fixture を §2.1.6 の対照 5 に流用する
- 前提: V1 の後、段 6 の busy の 99（20 行・89,864 s）は消える。本書の見込みに数えていない。PR1 の後の比較では、busy の 99 が残っていれば V1 の問題として分けて数える
- **同じファイルを書く箇所**:
  - `scripts/orchestrate/wait-verify.mjs`: V1 は busy 待ちの上限（`VERIFY_BUSY_TIMEOUT_SEC` まわり）、PR0 は要約の語（`verifyTiming` の近くで view を読む所）。PR0 は V1 のマージ後に切る
  - `scripts/orchestrate/contract.mjs`: V1 は scope の `[id]` の書き方。本書の PR は `UNIT_RELATED_GATE` を**読むだけ**（PR0 の `unit-related-def` の比較元）
  - env-clean（#4433）: 本書の PR は env-clean のコードを書かない。ただし PR2 は `env-clean` の FAIL の項目の種類（`$HOME` か listener・tmux か）を読むので、#4433 が判定のラベル（FAIL/ERROR/UNKNOWN）や項目の形を変えるなら PR2 は追従が要る（PR2 は #4433 の後）。scope の `[id]`（V1）の後は `scope:FAIL` の意味が変わりうるので、PR2 の「失敗したゲートが `scope` だけ」の条件も V1 の後の形で確かめる
  - lock の試験の揺れ（`tests/unit/verification/lock-pr1af-impl2-4288.test.ts`）: 触らない

---

## 4. 試験の観点（全組み合わせの表）

### 4.1 案 A（PR0 の記録・PR1 の判定）

PR0（記録）:

| # | 場面 | 期待 |
|---|---|---|
| P1 | run の間に HEAD が動かない・clean | `head_start`＝`head_end`、`dirty_*`＝0、要約に `run-head=<sha> run-clean=1` |
| P2 | run の間に commit | `run-head=moved` |
| P3 | 開始時に未コミットの変更 | `run-clean=0` |
| P4 | git が読めない | 列は null、要約に `run-head=` を書かない |
| P5 | `full` で exit 0 | 最後の 2 行が `full exit=0` と `verdict selection=full exit=0 gate-env=<hash>`、要約に `unit-related-verdict=full:0:<hash>` |
| P6 | `full` で exit 1 | `verdict … exit=1`、要約に `full:1:` |
| P7 | `related` / `none` | `verdict` 行は `selection=related` / `none`。要約の `unit-related-verdict=` は `related` / `none`（A の材料にならない） |
| P8 | 試験の stdout に `verdict` 行の偽物 | 最後の 2 行でなければ読まない |
| P9 | log tail が切れている | 最後の 2 行は残る（切れるのは先頭） |
| P10 | `gate-env` | ゲートの process の node・PATH の道具・`CI`・uid・lockfile・`node_modules` で計算される。precheck の process で同じ関数を呼ぶと、同じ環境なら同じ hash |
| P11 | `skipIf` の新しい `HAS_*` が一覧に無い | guard が落ちる |
| P12 | 契約の `unit-related` の定義の欄を 1 つ変える | `unit-related-def` が変わる |
| P13 | 既存の `verifyEnvState`・`diffManifest` | 変わらない（導入時に既存の記録が `changed` にならない） |

PR1（`related` の段）。期待は「verified（走らせない）」か「走らせる（今までどおり）」:

| # | 最新の同じ HEAD の verify 行 | `run-head` / `run-clean` | `unit-related-verdict` | def | `verifyEnvState` | gate-env | 期待 |
|---|---|---|---|---|---|---|---|
| A1 | なし | — | — | — | — | — | 走らせる |
| A2 | `ok`・`exit=0(passed)` | HEAD / 1 | full:0 | 一致 | same | 一致 | **verified** |
| A3 | `ok` だが verify.yaml の `unit` だけ（`unit-related` なし） | HEAD / 1 | — | — | same | — | 走らせる（F-3） |
| A4 | `fail`（`scope` だけ FAIL） | HEAD / 1 | full:0 | 一致 | same | 一致 | 走らせる（F-1） |
| A5 | `fail`・`unconfirmed: working` | moved / — | full:0 | 一致 | same | 一致 | 走らせる |
| A6 | `fail`・`unconfirmed: uncommitted changes` | HEAD / 0 | full:0 | 一致 | same | 一致 | 走らせる |
| A7 | `fail`・`unconfirmed:` supersede / 合図なし / late / inputs の変化 | HEAD / 1 | full:0 | 一致 | same | 一致 | 走らせる |
| A8 | `fail`・exit 99（`waited-for=`・mutex の SKIP） | — | — | — | — | — | 走らせる |
| A9 | 古い行は A2、最新の行は `unit-related@contract:FAIL` | HEAD / 1 | full:1 | 一致 | same | 一致 | 走らせる |
| A10 | `ok`・今の形（PR0 の欄なし） | なし | なし | なし | same | なし | 走らせる（既存の `a unit / unit-related pass does not stand in for the test steps`） |
| A11 | A2 で `unit-related-verdict=related` | HEAD / 1 | related | 一致 | same | 一致 | 走らせる |
| A12 | A2 で def が不一致 | HEAD / 1 | full:0 | **不一致** | same | 一致 | 走らせる |
| A13 | A2 で `run-head` が別の HEAD | 別 / 1 | full:0 | 一致 | same | 一致 | 走らせる |
| A14 | A2 で env が changed（lockfile） | HEAD / 1 | full:0 | 一致 | **changed** | 一致 | 走らせる |
| A15 | A2 で env が missing / unrecorded | HEAD / 1 | full:0 | 一致 | **missing / unrecorded** | 一致 | 走らせる |
| A16 | A2 で gate-env の node の版が違う | HEAD / 1 | full:0 | 一致 | same | **不一致** | 走らせる |
| A17 | A2 で precheck の PATH に `shellcheck` が無い | HEAD / 1 | full:0 | 一致 | same | **不一致** | 走らせる |
| A18 | 別の作業単位の A2 の行 | — | — | — | — | — | 走らせる |
| A19 | A2 ＋ `--heavy-to-ci` | HEAD / 1 | full:0 | 一致 | same | 一致 | **verified**（`ci` にしない） |
| A20 | A1 ＋ `--heavy-to-ci`、重い段 | — | — | — | — | — | `ci`（今までどおり） |
| A21 | A2 ＋ `--force` | HEAD / 1 | full:0 | 一致 | same | 一致 | 走らせる |
| A22 | A2 で `related` の段が無い（`src`・`scripts` の変更なし） | HEAD / 1 | full:0 | 一致 | same | 一致 | `related` は今までどおり skip |
| A23 | leader の裁定の行（自由文、PR0 の欄なし） | なし | なし | — | — | — | 走らせる |
| A24 | `--verify-run` で写した裁定の行（PR2。条件をすべて満たす） | HEAD / 1 | full:0 | 一致 | same | 一致 | **verified** |
| A25 | `--verify-run` で、失敗に `env-clean` の listener の項目 | — | — | — | — | — | 写さない → 走らせる |
| A26 | `--verify-run` で、`env=` の manifest が見つからない | — | — | — | — | — | 写さない → 走らせる |

どの行でも、`tests` の段は今までどおり走る（A2 でも）。加えて:

- `scope` だけ落ちた行・`fail` の行で eslint / tsc を飛ばさない、`unit` の `fail` 行で `ranFullUnit` が false（`passedGates` の意味を変えない。F-2）
- merge-pr: `related=verified` の precheck の HEAD は `--last` なしでも `needUnit` が真（A2・A19・A24）。`verified` の無い HEAD は今までどおり
- `verified` を持つ precheck の記録を、別の precheck が再利用するときも上の条件が効く（自己再利用で弱さを継承しない。R1）。`run-log.mjs status` の `next`・`unmetStage` が `verified` を `ok` の段として読む

### 4.2 案 B1・B2（PR4 の選び方。PR3 の表の要件は §2.3.3）

| # | 変更ファイルの種類 | merge-base の表 | 期待の mode | 選ぶ試験 |
|---|---|---|---|---|
| B1 | `src` のみ | 任意 | related | 今と同じ（陰性対照） |
| B2 | `tests/unit`・`tests/helpers` のみ | 任意 | related | 今と同じ |
| B3 | `scripts/**/*.mjs` のみ | 任意 | related | graph ＋ textscan（B1） |
| B4 | `md` ＋ `src` | あり・鍵一致 | related（合成） | (i) `src` の related ＋ (ii) 表で `md` を読んだ試験 ＋ (iii) 不透明 ＋ (iv) |
| B5 | `md` ＋ `src` | **なし** | full | 全体 |
| B6 | `md` ＋ `src` | **鍵不一致** | full | 全体 |
| B7 | `md` ＋ `src` | **読めない** | full | 全体 |
| B8 | `locales` ＋ `src` | あり・鍵一致 | related（合成） | B4 と同じ（helper 越しと `src/i18n.ts` 越しの読み取りを含む。M1 の対照が通らなければ B8 は full） |
| B9 | integration/e2e の試験 ＋ `tests/unit` | あり・鍵一致 | related（合成） | B4 と同じ |
| B10 | `md` のみ | あり・鍵一致 | related（合成） | (ii)〜(iv) |
| B11 | `md` ＋ `scripts` | あり・鍵一致 | related（合成） | B4 ＋ B3 |
| B12 | `md` ＋ `.env.example` / `.gitignore` / `.sh` / `package.json` / `vitest.config.ts` / `tests/setup.ts` | 任意 | full | 全体 |
| B13 | `changelog.d`・`dev-reports`・`.commandmate/tasks` のみ | 任意 | none | なし（今と同じ） |
| B14 | `md` の削除 | あり・鍵一致 | related（合成） | 消したファイルとその祖先を読んだ試験 |
| B15 | `md` の rename | あり・鍵一致 | related（合成） | 旧・新の両方のパスと祖先を読んだ試験 |
| B16 | 新規の `md`（祖先のディレクトリも新規） | あり・鍵一致 | related（合成） | 最も近い既存の祖先を一覧・lookup した試験 |
| B17 | 表の run で skip / fail / 時間切れだった試験 | あり・鍵一致 | — | 不透明として常に選ばれる |
| B18 | 戻す環境変数が立っている | 任意 | full | 全体 |

### 4.3 案 C（採らないが、#4370 に渡す試走の観点）

| # | 条件 | 測るもの |
|---|---|---|
| C1 | モード A・単独 × 60 | 赤の数と試験名、`runSec` |
| C2 | モード A・2 本同時 × 30 組（60 回。C1 と交互） | 同上。赤が 1 件でもあれば採らない（§2.5 の規則） |
| C3 | C2 の間に CI のランナーが動いている組 | 同上（実際の負荷の形） |

---

## 5. 決めてほしいこと

1. **A の品質の方針**（3 つに分けた）
   - **1a 走らせ方の差**: `related` の段を verify の全体（`CI=true`・直列・上限 20 s）の合格で飛ばすと、(1) 5〜20 s の試験の「手元の予算の差」による赤（揺れとは限らない。毎回 7 s の試験は決定的に赤い）と、(2) `related` の試験の**並列の観測**（隔離の不具合）を precheck で手放す。skip の集合の差は `gate-env` の一致で潰す。`tests` の段（変えた試験など）の並列は残す。推奨: 受け入れる。根拠は、`verified` の HEAD は CI の `Unit Tests`（直列・20 s。PR の正の判定）を必ず待つこと、§1.4 の待ちはすべて `related` の段で、変えた試験の並列は残ること。手放すのは「変えていない試験が、ブランチの `src/` の変更で並列でだけ壊れる」形の観測で、これは CI でも見ていない
   - **1b manifest の外の入力**: `$HOME` の下・ignore されたファイルの変化は `env=` にも `gate-env` にも入らない。推奨: 受け入れる（同じ作業単位の verify の直後に限る・CI の `Unit Tests` を待つ）
   - **1c `result≠ok` の行**: 第 1 版は `scope` だけ落ちた行も材料にしていた。第 2 版は `result=ok` の行だけにした（ci-merge.md 6-1-1 の「契約に結び付く判定は流用しない」と `passedGates` の ok 限定の方針のまま）。推奨: ok だけ（段 5 の 4419-1 の 2,602 s は手放す）
2. **裁定の行を材料にするか**: leader の裁定の行（元の run は `fail`）を、PR0 のサーバーの HEAD の記録で run と HEAD を機械で結び付け、`env=` の manifest が見つかり、失敗が `scope` と `$HOME` の項目だけの `env-clean` に限るとき、A の材料にしてよいか。段 6 の precheck の待ち 10,277 s の全部がこれ。推奨: PR0・PR1 の後に、PR0 の記録で結び付けが正しく取れていること（§3.2 の PR0 の率）を見てから決める（今は保留）
3. **C を #4370 に渡す**: `cpu.heavy` を 2 本にする判断を、§2.5 の試走（(b) 60 回で赤 0、1 件でも出たら採らない）を条件として #4370 PR3 に移すか。推奨: 移す
4. **B2 の採否の条件**: f より先に、(a) 鍵の命中率の閾値（案 80%。日次の表の実測は 10%、HEAD の鍵では 0%）と、(b) 網羅の確かめ方（44 本 × 2 通りの壊し方で、選ばれなかった試験の赤 0。機械の時間 約 25〜37 時間）を決めてほしい。その後に f の閾値（案 0.5）。推奨: この 3 つで PR3 に進むかを決める。費用に見合わないと見るなら B2・B1 は採らない
5. **表を作る条件**: 場所より先に、(a) どの tree で作るか（develop の commit ごと。日次では命中しない）、(b) どの条件で作るか（`CI=true`・表の run で pass 以外は不透明・`gate-env` の記録）を決めてほしい。その上で場所（develop の push の CI か、手元で `cpu.heavy` を取って作るか）。推奨: develop の push の CI（手元の `cpu.heavy` を増やさない）。CI の VM は手元と PATH の道具が違うので、表の `gate-env` と verify の `gate-env` の差を不透明の側へ倒す規則が要る

---

## 6. レビュー 1 の処分

レビュー: `workspace/orchestration/runs/2026-11-18/review-4432-design-1.md`（implementable with changes、P1 3・P2 7・P3 7）。

| 指摘 | 処分 | 本文 |
|---|---|---|
| **F-1**（P1）`result≠ok` の行・run が見た HEAD が無い | **狭めて塞ぐ**: `result=ok`・exit 0・`unconfirmed:`/`waited-for=` なし・同じ HEAD の最新の行だけ。サーバーの run に開始と終わりの HEAD・dirty を記録（PR0）し、記録の無い行は使わない | §2.1.2・§2.1.3・§2.1.4・§4.1 A4〜A9 |
| **F-3**（P1）「PR の CI がもう一度見る」が `unit` の経路で成り立たない | **採用（両方）**: `unit` を A の対象から外す（(b)）。`verified` の HEAD は merge-pr が `Unit Tests` を必ず待つ（(a)。試験で固定）。§5 の問い 1a の根拠を直した | §2.1.2・§2.1.4・§4.1 A3・§5 の 1a |
| **F-5**（P1）表の鍵の命中率 | **採用**: 命中率を実測（日次 3/30、HEAD の鍵 0/30）して書き、命中率 80% 以上を採否の条件の 1 番目に置いた。日次の表では採らない。合成の選び方（merge-base の表＋ブランチのコードは今の related）にした | §2.3.1・§2.3.2・§2.3.5・§5 の 4・5 |
| **F-2**（P2）`passedGates` の意味の範囲 | **採用**: A は別の関数。`passedGates`・`ranFullUnit`・`COVERED_BY_GATE` は変えない。試験で固定 | §2.1.2・§4.1 の加えて |
| **F-4**（P2）「同じ環境」が verify と precheck の process の差を見ない | **採用**: 環境をゲートの中で取る `gate-env`（node・PATH の道具・`CI`・uid・lockfile・`node_modules`）。precheck の process で同じ関数を計算して一致を要る。`skipIf` の一覧の guard | §2.1.3 の 2・§2.1.4 の 3・§4.1 A16・A17 |
| **F-6**（P2）`--verify-run` が run と tree を結び付けない | **狭めて塞ぐ**: サーバーの HEAD の記録（PR0）で結び付け、`env=` は run id を名指す run-log の行の key から引く。満たさなければ写さない。材料にするかは §5 の問い 2 で保留 | §2.1.8・§5 の 2 |
| **F-7**（P2）manifest に `node` を足すと進行中の記録が一斉に `changed` | **採用（形を変えて）**: node は manifest に足さず `gate-env`（ゲートの最後の行）に入れる。既存の比較は変わらない。PR0 を先に入れ 1 段溜めてから PR1 | §2.1.3 の 5・6・§3.1・§4.1 P13 |
| **F-8**（P2）B2 の N3 の根拠が弱い | **採用**: 44 本 × 2 通りの壊し方で選ばれなかった試験の赤 0 を採否の条件に入れた。変異の対照に M1・M5〜M7 の経路を足した | §2.3.4・§2.3.5 の 2 |
| **F-9**（P2）B1 を測定の PR3 に同梱 | **採用**: B1 は PR4 へ。B2 を採るときだけ。B1 の穴（`npm run` の `execSync`・helper 越し・setupFiles）を書き、B2 の網羅の確かめで確かめる | §2.2・§3.1 |
| **F-10**（P2）並列の観測が無くなる | **狭めて塞ぐ**: 飛ばすのは `related` だけ、`tests` の段（変えた試験・名指し・guards・docs）は並列で残す。手放す残り（変えていない試験の並列）は §5 の問い 1a で受け入れるかを問う | §2.1.2・§2.1.5・§5 の 1a |
| **F-11**（P3）def の hash が command だけ | **採用**: `gateDefinitions` の項目全体の正規化の hash | §2.1.3 の 3・§4.1 P12・A12 |
| **F-12**（P3）`selection=` の読み方 | **採用**: 最後の非空行だけ、直前の行の `full exit=0` と突き合わせる。既存の行と期待は変えない。偽装の対照を足した | §2.1.3 の 2・§4.1 P8・P9 |
| **F-13**（P3）tree より HEAD の一致 | **採用**: HEAD の一致に絞った | §2.1.2・§2.1.4 |
| **F-14**（P3）env-clean の FAIL を独立とみなす | **採用**: `result=ok` だけにしたので PR1 では該当なし。PR2 の裁定の行で `$HOME`・`~/.commandmate` の項目だけを許し、listener・tmux を含む行は写さない | §2.1.2・§2.1.8・§4.1 A25 |
| **F-15**（P3）「5〜20 s は揺れ」は言えない | **採用**: 「手元の予算の差」と書き直した | §2.1.5・§5 の 1a |
| **F-16**（P3）`.claude/**/*.md` は製品の挙動 | **採用**: 「文書」と呼ばず `*.md` と書き、`.claude` の md が unit の範囲外であることを明記 | §1.3 |
| **F-17**（P3）30% と 55% の量の曖昧さ | **採用**: ファイル数と時間を分けて書き、f は時間で測ると決めた | §1.3 |
| M1〜M12（表の取りこぼしの経路） | **採用**: 表の作り方の要件の表にした。M1 は未確認として陽性対照に足し、届かなければ `locales` を外す | §2.3.3 |
| §4 V1 との挙動の依存 | **採用**: 挙動の依存として書き、V1 の後の行の形で受け入れ条件を確かめる・fixture を流用する | §3.3 |
| §4 #4433・scope `[id]` の依存 | **採用**: PR2 は #4433 の後。`scope:FAIL` の意味も V1 の後の形で確かめる | §3.3 |
| §4 PR0 を先に | **採用** | §3.1 |
| §5 の問いの立て方 | **採用**: 問い 1 を 1a・1b・1c に分け、問い 2 を run と HEAD の機械の結び付けに、問い 4・5 を命中率・網羅・表を作る条件を先にした。問い 3 に赤が出たときの判定の規則を足した | §5・§2.5 |
| R1（自己再利用が弱さを継承） | **採用**: `verified` の記録の再利用にも同じ条件が効くことを試験の観点に入れた | §4.1 の加えて |

採らなかった指摘: なし。

---

## 付録 A: 分け直し・使い回しの集計のスクリプト

`cls.mjs`（§1.3。`<repo>` の `scripts/run-related-unit-tests.mjs` の `classifyChanges` をそのまま使う）:

```js
const m = await import(process.cwd() + '/scripts/run-related-unit-tests.mjs');
const files = process.argv[2].trim().split(' ').filter(Boolean);
const r = m.classifyChanges(files);
const src = /^src\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/, t = /^tests\/(unit|helpers)\/.+\.(ts|tsx)$/;
const cls = new Set();
for (const f of r.considered) {
  if (src.test(f) || t.test(f)) continue;
  if (/\.md$/.test(f)) cls.add(f.startsWith('.claude/') ? 'claude-md' : 'md');
  else if (/^scripts\/.+\.(mjs|js|cjs|ts)$/.test(f)) cls.add('scripts-code');
  else if (/\.sh$/.test(f)) cls.add('sh');
  else if (/^locales\//.test(f)) cls.add('locales');
  else if (/^tests\//.test(f)) cls.add('tests-int-e2e');
  else cls.add('other-config');
}
console.log(r.mode, [...cls].sort().join('+') || '-', process.argv[3], process.argv[4]);
```

`reuse.mjs`（§1.4・§2.7）の判定: run-log を時刻順に読み、`verify` の行で `passed=` に `unit-related@contract` があれば（作業単位・`git rev-parse <head>^{tree}`・`env=`）を覚える。後の `verify` の行（`unit-related` を含み待ちの記録あり）と `precheck` の行（`mutexSec` > 0）について、同じ作業単位・同じ tree の記録があるかを数える。§1.4 の表はこの出力に HEAD・mode と、precheck のログ（`precheck-*.out` の `related … waited cpu.heavy`）を足したもの。

## 付録 B: `cpu.heavy` の列の再生（`sim.mjs`）

- 対象の行: `verify` で `unit-related@contract` を含み `mutexSec` がある行、`precheck` で `mutexSec` > 0 の行
- 保有時間: verify は `runSec − 52`（`unit-related` 以外のゲート〔lint・typecheck・build-server〕の分。`unit-related` を含まない verify の行の `runSec` は段 5 で 2 行の平均 46 s、2026-11-13 の run-3574-4317 で 51〜52 s。大きい方を引く）、precheck は `runSec`。待ち切り（`SKIP` / `held`）の行は保有 0
- 到着時刻: `at − 保有時間 − mutexSec`
- 先着順・K 本（既定 1）の列に流し、各行の待ちの和を出す。B2 の対象の verify の行だけ保有時間を f 倍する
- 限界: run-log に載らない保有者（§2.3.6）を含まないので、秒数ではなく同じ再生の中の前後の比だけを使う。K=2 は同時実行で保有時間が伸びる分を入れていない。命中率は 100% を仮定している

```bash
for f in 1 0.5 0.25 0; do node sim.mjs <repo> "$F" $f; done      # §2.3.6 の表
K=2 node sim.mjs <repo> "$F" 1                                      # §2.5
```

## 付録 C: 表の鍵の命中率（`keyhit*.mjs`、§2.3.1）

- 対象: §1.3 の分け直しで B2 の対象（`full` で、全体の理由がすべて `md`・`locales`・integration/e2e の試験）の verify の行
- 読み手の鍵: `git rev-parse <commit>:<path>` を `src`・`scripts`・`tests/unit`・`tests/helpers`・`tests/setup.ts`・`vitest.config.ts`・`package-lock.json` について並べたもの（`keyhit2/3`）。merge-base の鍵の版（`keyhit`）は `tests` 全体・`src`・`scripts`・`vitest.config.ts`・`package-lock.json`
- 日次の表: その行の `at` の日の 00:00Z 以前の最後の `origin/develop` の first-parent の commit（`git rev-list -1 --first-parent --before=<日>T00:00:00Z origin/develop`）。merge-base の鍵では、前日の表も許す数え方でも同じ 3 / 30 だった
- 先の全体の run の表: 時刻順に読み、`full` で `SKIP` でない `unit-related` の行の HEAD の鍵を覚え、後の行の HEAD の鍵と比べる
- merge-base は今の `origin/develop` との `git merge-base`（当時の develop ではないので近似）
- 壊し方の網羅の対象（44 本）: 47 行の HEAD の差分のうち `*.md`・`locales/**`・`tests/(integration|e2e)/**`（`changelog.d/`・`dev-reports/`・`CHANGELOG.md`・`docs/module-reference.md` を除く）の重複なしの数
