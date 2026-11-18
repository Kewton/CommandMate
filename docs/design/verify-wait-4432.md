# verify の待ちを減らす（Issue #4432）— 設計

- 状態: 設計（第 1 版）。実装は設計のレビューの後に別の契約で行う。この版はコード・試験・設定を変えない
- 前提: 並行のレーン V1（#4459・#4433）が**マージされた後の形**を前提にする（§3.3）
- 行番号は書かない（`origin/develop` `11bd76f12` 時点の名前で引く）
- 本書では **事実**（コード・記録で確かめたこと）、**見立て**（事実から計算したが試していないこと）、**未確認** を分ける
- 不変条件（PM の決定。全案に効く）:
  - **N1** ゲートの判定を弱めない。同じ変更で、同じ不合格が同じように出る
  - **N2** 結果の使い回しは、版（tree）・依存（lockfile・node の版・ゲートの宣言）・環境（`env=` の manifest、`verifyEnvState` が `same`）が同じときだけ
  - **N3** 関係する試験への絞り込みは、漏れる試験が無いことの根拠（import の追跡の範囲・リポジトリのファイルを読む試験の扱い・陽性対照＝既知の不合格の再現）を出す
  - **N4** mutex の枠を増やす案は、負荷の揺れが増えないことの確かめ方まで書く
  - **N5** 根拠が出せない案は「採らない」と書く

---

## 0. 結論

| 案 | 中身（既存との差分） | 見込み（段 5 / 段 6 の実績から） | 採否 |
|---|---|---|---|
| **A** precheck が verify の**全体の**試験の合格を使い回す | 今の precheck は試験のゲート（`unit` / `unit-related`）をどの段の代わりにもしない。同じ tree・同じ環境・同じ node・同じゲートのコマンドで、`unit-related` が **mode=full**（＝`tests/unit` 全部）で通った記録に限り、`related` / `tests` の段（どちらも `tests/unit` の部分集合）を走らせない | precheck の `cpu.heavy` の待ち: 段 5 は 17,629 s のうち **9,109 s**（3 回。exit 3 の保留 1 回を含む）、段 6 は 10,277 s のうち **10,277 s**（2 回。A-2 の記録が要る） | **採る**（PR1・PR2） |
| **B1** `scripts/` のコードを import の追跡に入れる | `run-related-unit-tests.mjs` は `src/` 以外のコード（`scripts/**/*.mjs`）が変わると全体に倒れる。precheck の `related` は既に `scripts/` を追う | 単独では段 5・段 6 で 0（`scripts/` だけが全体の理由になった run が無い）。B2 と組んで効く | **採る**（B2 と同じ PR） |
| **B2** 文書・locale・integration の試験の変更で全体に倒さない | 実行時のファイル読み取りを記録した表（試験 → 読んだファイル）で選ぶ。表が無い・古い・子プロセスで読み取りが見えない試験は全体／常に選ぶ側へ倒す | `cpu.heavy` を持つ時間のうち、対象になる run の分: 段 5 は 83,157 s のうち **61,892 s**（20 run / 28）、段 6 は 39,810 s のうち **23,675 s**（10 run / 19）。待ちの削減は §2.3 の再生で、選ばれる量の比 f に応じて段 5 で −71%（f=0.5）〜 −87%（f=0） | **条件つきで採る**（PR3 で表と陽性対照を出し、合格したときだけ PR4 で切り替える。出せなければ採らない） |
| **C** `cpu.heavy` を 2 本にする | — | 再生では待ちが段 5 で 80,651 → 8,679 s・段 6 で 11,108 → 853 s。ただし同時 2 本で実行時間が伸びる分を入れていない上限 | **採らない**（N4 の確かめに 60 組・約 96 時間の試走が要り、今は根拠が無い。#4370 PR3 の枠に渡す。§2.5） |
| **D** 安い契約ゲート（scope・env-clean）が落ちたら試験を打ち切る | — | — | **採らない**（N1 に反する。§2.6） |
| **E** verify どうしで同じ tree の試験の合格を使い回す | — | 段 5・段 6 とも **0**（再指示のたびに tree が変わっていた） | **採らない**（効果が無い。§2.7） |

段 6 の verify の待ちのうち最大の塊（exit 99 の 20 行・計 89,864 s の `waited-for=run N(still running)`）は、V1（#4459 項目 1: busy 待ちの上限 3,600 s が mutex 待ちの上限 5,400 s より短い）が直す。本書の見込みには数えない（§1.4）。

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

Issue 本文の「verify 80 回・失敗 26 回・約 59 時間のうち約 27 時間」「precheck 36 回・約 4.8 時間のうち約 4.1 時間」とは行の数え方の差で少し違う（本文の集計の条件は書かれていない）。本書は上のコマンドの数字を使う。

### 1.3 待ちはどのゲートで起きたか（事実）

`cpu.heavy` を取る verify のゲートは、段 5・段 6 とも契約のゲート `unit-related@contract`（`contract.mjs` `UNIT_RELATED_GATE`、`mutex: cpu.heavy`、5,400 s）だけだった（verify.yaml の `unit` / `integration` を選んだ契約は無い）。待ちの記録がある verify の行はすべて `unit-related` を含む（段 5: 28 行、段 6: 19 行）。

`unit-related`（`scripts/run-related-unit-tests.mjs`）の決め方は、変更ファイルを `classifyChanges` で `none` / `related` / `full` に分け、`src/**` のコードと `tests/unit|helpers/**` 以外が 1 つでもあれば **`full`（`npm run test:unit`＝`tests/unit` 全部）** に倒す。その run の HEAD の差分（`git merge-base <head> origin/develop` からの差分。当時の `origin/develop` ではないので近似）で分け直すと:

| 全体に倒した理由になったファイルの種類（`src`・`tests/unit` 以外） | 段 5 の行 / mutex / run | 段 6 の行 / mutex / run |
|---|---|---|
| `md` のみ | 6 / 27,093 / 19,897 | 2 / 9,005 / 2,995 |
| `locales` ＋ `md` | 3 / 0 / 10,347 | 3 / 0 / 8,954 |
| `locales` ＋ `md` ＋ integration・e2e の試験 | 3 / 6,181 / 10,247 | 3 / 10,138 / 6,528 |
| `locales` ＋ integration・e2e の試験 | 3 / 6,671 / 9,575 | — |
| `md` ＋ integration・e2e の試験 | 3 / 20,757 / 6,661 | 2 / 0 / 5,690 |
| integration・e2e の試験のみ | 2 / 8,349 / 6,272 | — |
| **小計（B2 の対象: 文書・locale・integration/e2e の試験だけ）** | **20 / 69,051 / 62,999** | **10 / 19,143 / 24,167** |
| `scripts` のコード・設定（`.env.example`・`.gitignore`・`flow.yaml`）・`.sh`・`.claude` を含む | 5 / 14,487 / 15,348 | 9 / 24,155 / 16,413 |
| `related`（全体に倒れていない） | 3 / 15,163 / 5,830 | 0 |

つまり **`unit-related` の 47 行のうち 44 行が実際には全体（`tests/unit` 約 3,070 ファイル）を走らせていた**。製品のランナーは `CI=true` を注入するので vitest は直列（`vitest.config.ts` の `fileParallelism: false`・`maxConcurrency: 1`）で、1 回の `runSec` は平均で段 5 が約 3,000 s、段 6 が約 2,100 s。重い 1 本が長く持つので、後ろの待ちが積み上がる。

分け直しのコマンド（`<repo>` は CommandMate の worktree。`cls.mjs` は付録 A）:

```bash
jq -r 'select(.stage=="verify" and (.note|test("unit-related@contract")) and .mutexSec!=null) | "\(.head) \(.mutexSec) \(.runSec)"' "$F" |
while read h m r; do (cd <repo>; mb=$(git merge-base $h origin/develop); node cls.mjs "$(git diff --name-only $mb $h | tr '\n' ' ')" $m $r); done |
awk '{k=$1" "$2; n[k]++; m[k]+=$3; r[k]+=$4} END{for(k in n) print k, "n="n[k], "mutex="m[k], "run="r[k]}' | sort
```

leader が手で走らせた `unit-related` のログ（`runs/2026-11-17/unit-related-*.log`、11 本）でも 10 本が `mode=full`（理由は `docs/en/**`・`README.md`・`.env.example`・`docs/orchestrate/**`）。残る 1 本（`mode=related changed=19 textscan=925`）は `--changed` の 751 ファイル＋リポジトリを読む試験 925 ファイルで、全体の約 55%。後者の 925 ファイルだけで 278 s（standalone の並列）かかり、全体（253〜473 s）とほとんど変わらない。**今の「リポジトリを読む試験」（`findTextScanTests`）で選ぶ形のままでは、全体に倒さなくしても時間はほとんど減らない**（B2 が実行時の読み取りの表を要る理由。§2.3）。

### 1.4 precheck の待ち（事実）

precheck の `mutexSec` が 0 でない行（＝広い `related` / `tests` の段が `cpu.heavy` を待った行）と、同じ作業単位（issue＋item）で**同じ tree** の verify が `unit-related` を通していたか:

| 段 | precheck | 同じ HEAD の verify | その HEAD の `unit-related` の mode（分け直し） |
|---|---|---|---|
| 5 | 4403 `80c749387` m=1,122 | なし | — |
| 5 | 4419-1 `f5acddf57` m=2,602 | fail（`scope` だけが FAIL。`unit-related` は passed） | related |
| 5 | 4388-1 `ffe804892` m=5,400 **skip（exit 3）** | ok | full |
| 5 | 4387 `1ac4cfb86` m=4,796 | なし | — |
| 5 | 4388-1 `ffe804892` m=749（上の再実行） | ok | full |
| 5 | 4389 `c856bf553` m=2,960 | ok | full |
| 6 | 4344-pr3 `43979112d` m=4,877 | **leader の裁定**（文で「unit-related 含む pass」。`passed=` が無い） | full |
| 6 | 4436-l0 `23e71b9f6` m=5,400 **skip（exit 3）** | **leader の裁定**（文で「unit-related（全件 exit 0）passed」） | full |

同じ tree で HEAD だけ違う当たりは 0（すべて同じ HEAD）。leader の裁定の行（exit-codes 3-4 の override）は `passed=` も `env=` も持たないので、今の precheck は機械的に読めない。

### 1.5 見逃しの実績（事実）

- verify が `unit-related` で赤を出した行: 段 5 で 3（`dd7a2bb23` 4385-a4・`fb80935e4` 4418-b・`ed6be1c6b` 4386）、段 6 で 2（`526dfd460` 4436-a2・`bd5ffbd6f` 4344-pin）。うち 3 本（`dd7a2bb23`・`ed6be1c6b`・`526dfd460`）は B2 の対象の種類（`locales`・`md`・integration の試験）だけで全体に倒れた run で、**B2 の陽性対照に使える既知の不合格**
- CI の `Unit Tests` が落ちた 6 回（2026-11-13〜17、4197・4290×2・4439・4437×2）は、4437 `a01abc55f` の `Integration Tests`（次の HEAD で直った本物の不合格）を除き、同じ HEAD の再実行で合格した（揺れ）。`unit-related` の選び方の漏れで CI だけが捕まえた実例は、この期間に見つからなかった
- leader の手での全体の実行で落ちた試験（`runs/2026-11-17/unit-related-*.log` の `FAIL`）は、`tests/unit/guards/handoff-no-kill-4227.test.ts`・`tests/unit/lib/brief/brief-retry-paths-4223.test.ts`・`tests/unit/scripts/stop-waits-for-exit-2488.test.ts`・`tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts` などで、どれも standalone（並列・5 秒の上限）の負荷での時間切れ。これは #4254・verify.yaml の `unit` / `integration` の注記と同じ型の揺れ（C を採らない根拠の 1 つ。§2.5）

---

## 2. 案ごとの設計

### 2.1 案 A: precheck が verify の全体の試験の合格を使い回す

#### 仕組み（既存との差分）

既存（docs/orchestrate/ci-merge.md 6-1-1「precheck の段と再利用」）:

- precheck は同じ HEAD・同じ引数・同じ作業の HEAD・`verifyEnvState` が `changed` / `missing` でない `precheck=ok` を再利用する
- 同じ HEAD の `verify=ok` の `passed=` から、`COVERED_BY_GATE`（`lint`→`eslint`・`typecheck`→`tsc`・`lint-sh`→`lint-sh`）の段を飛ばす。環境が `same` でなければ（`unrecorded` は警告つきで使う）使わない
- 試験のゲート（`unit` / `unit-related`）は「選ぶ試験が違う」ので、**どの段の代わりにもならない**（`tests/unit/scripts/orchestrate/precheck.test.ts` の `a unit / unit-related pass does not stand in for the test steps`）

足すもの:

1. **A-1 選び方の記録**: `run-related-unit-tests.mjs` が**最後の行**に `run-related-unit-tests: selection=<full|related|none> base=<merge-base の sha>` を出す（今の `mode=` の行は出力の先頭にあり、全体の vitest の出力は `maxLogTailBytes` 32,768 を超えうるので、log tail からは切れうる）。`wait-verify.mjs` は既に `verify show --json` の各ゲートの log tail を読んでいる（`verifyTiming`）ので、同じ view からこの行を読み、記録の要約に `unit-related-selection=full` を足す。`unit`（verify.yaml）のゲートは定義から全体なので `unit-related-selection` は要らない（`passed=` に `unit` があれば全体）
2. **A-1 環境の記録**: `env-manifest.mjs` の `takeManifest` に **`node`（worktree で `node --version` が返す版）** を足す。今の manifest は lockfile・`node_modules` の実体と版・Claude の設定を持つが node の版を持たない。足した後は古い manifest との比較が `changed`（`node` の欄が違う）になり、導入の時点の記録は使い回されない（安全側）
3. **A-1 ゲートの宣言**: 契約のゲートの宣言（コマンド文字列）は tree の外（`.commandmate/tasks/`）にある。記録の要約に `unit-related-cmd=<sha256 の先頭 12 桁>` を足し、precheck は自分の知っている `UNIT_RELATED_GATE.command` と一致するときだけ使う。`verify.yaml` は tree に入っているので tree の一致で覆われる
4. **A-1 precheck の判定**: `related` / `tests` の段を、次の**すべて**を満たす verify の記録があれば走らせず、要約に `<段>=verified` と書く（結果は `ok`。新しい状態語。`ci`・`held` と同じく `parseNote` の語彙に足す）:
   - 同じ作業単位（issue＋item）、`git rev-parse <head>^{tree}` が一致（HEAD が同じなら必ず一致）
   - `passed=` に `unit` があるか、`unit-related@contract` があり `unit-related-selection=full`
   - `unit-related-cmd` が一致（`unit` のときは不要）
   - `verifyEnvState` が **`same`**（`unrecorded`・`missing`・`changed` は使わない。`eslint` / `tsc` の再利用が `unrecorded` を警告で通すのより厳しくする。N2）
   - 記録の `result` は `ok` でなくてもよい。`failed=` が `work-evidence`・`scope`・`env-clean`（契約に結び付く判定で試験の結果と独立）だけのときも使う（§1.4 の 4419-1 の型）
   - `--heavy-to-ci` の有無で変えない（`verified` は手元で全体が通った記録なので `ci` より強い）。merge-pr が取り込んだ HEAD は tree が違うので当たらない（6-2 の組み合わせの確認は今までどおり）
5. **A-2 裁定の記録を機械で読める形にする**: leader の override の行（exit-codes 3-4）を `run-log.mjs append` の自由文で書く今の形では A-1 が読めない。`run-log.mjs append --verify-run <run id>` を足し、`verify show <id> --json` から `passed=`・`failed=`・`unit-related-selection=`・`unit-related-cmd=` と、その run の `env=`（wait-verify の `<log>.env.json` の終わりの manifest）を写す。override の理由は今までどおり要約に書く。`result` は裁定どおり（`ok`）

#### 使い回しの条件と品質の根拠

- **包含**: `unit-related` の `full` は `npm run test:unit`＝`vitest run tests/unit` で、precheck の `related`（`vitest related --dir tests/unit`）・`tests`（変更した `tests/unit` の試験・パスを名指しする試験・`tests/unit/guards`・`tests/unit/docs`）はどちらも `tests/unit` の部分集合。同じ tree・同じ依存・同じ環境なら、precheck が走らせるはずの試験はすべて verify で走って通っている
- **走らせ方の差（明示する）**: verify のゲートは `CI=true`（直列・試験の上限 20 s）、precheck は `CI` なし（並列・上限 5 s）。違うのは時間の予算だけで、試験の論理は同じ。5 s を超えて 20 s 以内で通る試験は precheck だけで赤になりうるが、それは負荷の揺れ（§1.5）で、PR の CI（`CI=true`）が正の判定である。**論理の不合格（同じ tree で毎回落ちるもの）は verify の全体で必ず出る**ので、N1 の「同じ不合格が同じように出る」は保たれる（出る場所が verify に寄るだけ）
- **related の記録は使わない**: `selection=related` の選び方（`--changed <merge-base>`＋リポジトリを読む試験）は precheck の選び方（`vitest related`＋名指し＋guards・docs）を含むと示せない（名指しの試験が `findTextScanTests` の正規表現に当たらない形がありうる）。§1.4 の 4419-1（2,602 s）は数えない
- **使い回さないもの（今までどおり）**: `changelog`・`removed-tests`・`eslint`・`lint-sh`・`suppressions`・`tsc`（`COVERED_BY_GATE` の規則のまま）、`--build` の段、PR の CI の全体の検証

#### 陽性対照（既知の不合格の再現）

1. 同じ tree で `unit-related` が **FAIL** した記録 → precheck は試験の段を走らせ、同じ試験で落ちる（`fail` は使い回しの材料にならない）
2. `selection=full` で通った記録の後に、試験 1 本を赤にする commit を足す → tree が違うので使い回さず、precheck の `tests` がその試験で落ちる
3. 同じ tree で `package-lock.json` だけ違う manifest（`env=` の差）→ `changed` で使わず走らせる。`node` の版だけ違う manifest でも同じ
4. 実データの再生: 段 5 の 4388-1 `ffe804892`（precheck が exit 3 で保留になった HEAD）と同じ形の記録を一時の run dir に置き、precheck が `related=verified tests=verified` で `ok`（exit 0）になること。`selection` の無い同じ記録（今の形）では今までどおり走らせること（陰性対照。既存の試験 `a unit / unit-related pass does not stand in for the test steps` はそのまま通る）

#### 削減の見込み（§1.4 から）

| 段 | 対象 | precheck の mutex の削減 | 保留（exit 3）の回避 |
|---|---|---|---|
| 5 | 4388-1（5,400＋749）・4389（2,960） | **9,109 s / 17,629 s（52%）** | 1 回 |
| 6 | 4344-pr3（4,877）・4436-l0（5,400）※A-2 が要る | **10,277 s / 10,277 s（100%）** | 1 回 |

見立ての注意: 待ちは `cpu.heavy` の列なので、precheck が列から抜けると後ろの verify の待ちも縮む。その分は数えていない（下限）。

#### 変えるファイル

- `scripts/run-related-unit-tests.mjs`（最後の行）
- `scripts/orchestrate/wait-verify.mjs`（要約に 2 語。**V1 #4459 項目 1 と同じファイル**。§3.3）
- `scripts/orchestrate/env-manifest.mjs`（`node` の欄）
- `scripts/orchestrate/precheck.mjs`（判定・`verified` の語）
- `scripts/orchestrate/run-log.mjs`（A-2 の `--verify-run`）
- `scripts/orchestrate/pr-common.mjs`・`merge-pr.mjs`（`verified` を `ok` の段として読む。`unmetStage`・`status` の `next`）
- 試験: `tests/unit/scripts/orchestrate/precheck*.test.ts`・`wait-verify*.test.ts`・`env-manifest*.test.ts`・`run-log*.test.ts`、`tests/unit/scripts/run-related-unit-tests.test.ts`
- 文書: `docs/orchestrate/ci-merge.md` 6-1-1「precheck の段と再利用」の「テストのゲートは、どの段の代わりにもならない」を条件つきに書き換え、`docs/orchestrate/exit-codes.md` 3-4 の override の書き方に `--verify-run` を足す

#### 危険と採否

- 危険: 記録の偽り（手で `unit-related-selection=full` を書く）。→ A-2 の `--verify-run` はサーバーの run から写す。手書きの要約は `selection` を持たないので使われない
- 危険: tree は同じでも tree の外の入力（ignore されたファイル・`$HOME` の下）が違う。manifest が見るのは Claude の設定・lockfile・`node_modules`・（A-1 で足す）node の版だけで、`tests/setup.ts` が一時の場所へ向けるのも `CODEX_HOME`・`COPILOT_HOME` など個別の変数で、`HOME` 全体ではない。→ 残る危険として明示する。軽くする手当て: (1) 使い回すのは同じ作業単位の verify の直後の precheck に限られ（間に入るのは PR 本文の作成とレビュー）、(2) PR の CI（`$HOME` も ignore されたファイルも持たない）が全体をもう一度見る。この危険は今の `eslint` / `tsc` の再利用にも同じ形であり、本案で新しく生まれるものではないが、試験は lint より tree の外を読みやすいので §5 の 1 で受け入れるかを決めてもらう
- **採る**

### 2.2 案 B1: `scripts/` のコードを import の追跡に入れる

#### 仕組み

`classifyChanges` の「コード」の正規表現を `^(src|scripts)/.+\.(ts|tsx|js|jsx|mjs|cjs)$` にする。precheck の `RELATED_SOURCE`（`^(?:src|scripts)/…`）と同じ範囲になる。`vitest --changed <merge-base>` は試験から import される `scripts/*.mjs` を module graph でたどる。

#### 品質の根拠

- import で届く試験: `vitest --changed` の graph（`src/` と同じ扱い）
- 子プロセスで `node scripts/x.mjs` を起こす試験: 試験の本文に `spawnSync` などと `'scripts/` があれば `findTextScanTests` が選ぶ（今 `src/` の変更で頼っているのと同じ根拠。新しい仮定を足さない）
- 例外: 試験の本文が呼び出しを持たず、`tests/helpers`（`real-shell-budget.ts`・`real-server-fence.ts`・`claude-launch-command.ts` は子プロセスを起こす）越しに起こす試験は `findTextScanTests` に当たらない。→ helper を import する試験は `vitest --changed` の graph では helper まで届くが、helper が起こす script の中身の変更は graph に無い。**B1 の PR で、子プロセスを起こす helper を import する試験も `textscan` に足す**（helper の一覧は `tests/helpers` の静的な走査で出す）

#### 陽性対照

- 一時の worktree で `scripts/orchestrate/precheck.mjs` の `HEAVY_TEST_FILES` を 49 に変える → `tests/unit/scripts/orchestrate/precheck-heavy-3884.test.ts` が選ばれて落ちる（import の経路）
- `scripts/check-token-discipline.mjs` の判定を 1 つ壊す → `spawnSync(process.execPath, [scripts/check-token-discipline.mjs, …])` で起こす `tests/unit/scripts/check-token-discipline.test.ts` が選ばれて落ちる（子プロセスの経路）
- `scripts/` の helper 越しの経路: `tests/helpers/real-shell-budget.ts` が起こす script を壊す → それを import する試験が選ばれて落ちる

#### 削減の見込み

段 5・段 6 には `scripts/` のコードだけが全体の理由になった run が無い（§1.3: `scripts` を含む run はいつも `md` か設定も変えている）。**単独の効果は 0**。B2 と組んだときに「`scripts` ＋ `md`」の run（段 5 の 5 行の一部・段 6 の 1 行）が全体に倒れなくなる。

#### 変えるファイル・採否

`scripts/run-related-unit-tests.mjs`、`tests/unit/scripts/run-related-unit-tests.test.ts`（既存の期待値は `src/` のケースだけで、`scripts/` のケースを足す。既存の `it` は変えない）。**採る**（B2 の PR3 と同じ PR。単独では効果が無いので PR を分けない）。

### 2.3 案 B2: 文書・locale・integration の試験の変更で全体に倒さない

#### 仕組み

全体に倒している理由の大半（§1.3）は「試験がリポジトリのファイルを**実行時に読む**」ことで、import の graph には出ない。今の `findTextScanTests`（本文に読み取りの呼び出しとリポジトリのディレクトリ名がある試験、925〜932 ファイル）で選ぶと、全体の約 30% のファイルが残るうえ重い試験が集まっていて、時間がほとんど減らない（§1.3 の 278 s 対 253〜473 s）。かつ helper 越しに読む試験（`tests/helpers/real-intl.ts` が locale を、`tolerant-walk.ts` がディレクトリを読む）を落とす。

そこで**実行時の読み取りの表**を使う:

1. **表を作る**（PR3）: 試験用の環境変数 `CM_TRACE_REPO_READS=<出力先>` のときだけ、`tests/setup.ts` に読み取りの記録を入れる。`fs` の読み取りの入口（`readFileSync`・`readdirSync`・`existsSync`・`statSync`・`lstatSync`・`opendirSync`・`globSync`・`fs.promises` の同名）を包み、リポジトリの中のパスを試験ファイルごとに記録する。node の子プロセスには `NODE_OPTIONS=--import <tracer>` で同じ記録を引き継ぐ。**node 以外の子（`bash`・`git`・`shellcheck` など）を起こした試験は「不透明」**として記録する（中で何を読むか見えない）
2. 表は `tests/` ・`src/`・`scripts/`・`vitest.config.ts`・`package-lock.json` の tree の hash を鍵にして保存する。作るのは develop の HEAD で 1 日 1 回（agent-health の日次の計測と同じ場所）か、手で。保存先は `~/.commandmate/` ではなくリポジトリの外のキャッシュ（`CM_TRACE_CACHE`、既定 `<git common dir>/commandmate/read-trace/`）
3. **選ぶ**（PR4）: `classifyChanges` で全体の理由になったファイルが**すべて** `*.md`・`locales/**`・`tests/(integration|e2e)/**` のとき（B2 の対象）だけ、次の和を走らせる:
   - 今の `related` の選び方（`--changed <merge-base>`。graph で届く試験。json の locale を import する `src/` があればここで届く）
   - 表で、変更したファイル（とその親のディレクトリ。`readdirSync` で一覧を読んだ試験）を読んだ試験
   - 不透明な試験すべて
   - 変更した試験・`tests/unit/guards`・`tests/unit/docs`（precheck の `ALWAYS_TESTS` と揃える）
4. **全体に倒す条件**（fail-closed）: 表が無い／鍵（merge-base の上の tree の hash）が合わない／表の形が読めない／B2 の対象の外のファイル（設定・`.sh`・`package.json` など）が 1 つでもある → 今までどおり `mode=full`

#### 品質の根拠（N3）

- import の追跡の範囲: `vitest --changed` の graph（今と同じ）
- リポジトリのファイルを読む試験の扱い: 実際にその tree で全体を走らせたときの読み取りで決める（本文の正規表現の推定でなく観測）。helper 越しの読み取りも同じ process の中なので記録される。node の子の中の読み取りも記録される。見えない読み取り（node 以外の子）は不透明として常に選ぶ
- 残る穴（明示する）: (a) 試験の中の条件分岐で、表を作った run では通らなかった枝だけが読むファイル（分岐が tree の外の入力に依るもの）、(b) ネットワーク・ソケット越しに読むもの（試験の中でサーバーを起こしてそこがファイルを読む。サーバーが node の子なら記録される）。(a) は陽性対照の再生（下）で実害の有無を確かめ、見つかったらその試験を不透明に足す
- 選ばれる量は**測ってから**決める: 表を作った後、段 5・段 6 の 30 run の差分で選ばれる試験の実行時間の和 ÷ 全体の実行時間の和（f）を出す。**f が 0.5 を超えるなら採らない**（全体に倒すのと差が小さく、表の維持の手間に見合わない）

#### 陽性対照（既知の不合格の再現）

1. **実データの再生**: §1.5 の B2 の対象の 3 本（`dd7a2bb23`・`ed6be1c6b`・`526dfd460`）について、一時の worktree でその HEAD の全体を `CI=true` で走らせて落ちた試験の集合 F を出す（同じ HEAD の merge-base でも落ちる試験は揺れか既存の不合格として別に記録する）。B2 が選ぶ集合 S について **F ⊆ S** を確かめる。1 本でも外れたら採らない
2. **変異の対照**（一時の worktree で 1 つずつ）:
   - `docs/en/security-guide.md` の見出しを 1 つ消す → それを読む `tests/unit/docs` の試験が選ばれて落ちる
   - `locales/en/common.json` のキーを 1 つ消す → `tests/helpers/real-intl.ts` 越しに読む試験が選ばれて落ちる（helper 越しの経路）
   - `.claude/commands/orchestrate.md` を 118,000 bytes 超にする → それを読む `tests/unit/docs/orchestrate-size-3481.test.ts`（`scripts/check-orchestrate-size.mjs` を import して呼ぶ）が選ばれて落ちる（import した script の中の読み取りの経路）
   - node の子プロセスがリポジトリのファイルを読む試験を表から 1 本選び（PR3 で表を作った後に名指す）、そのファイルを壊す → 選ばれて落ちる（node の子の経路）
   - `tests/integration/` の試験の本文を、それを名指しで読む `tests/unit/guards` の試験が見る形で壊す → 選ばれて落ちる
3. **陰性対照**: `src/` だけの差分では選ぶ集合が今と同じ（`mode=related` の経路を変えない）。表が無いときは今と同じ `mode=full`

#### 削減の見込み（事実＋再生による見立て）

`cpu.heavy` を持つ時間（verify の `runSec` から `unit-related` 以外のゲートの分 52 s を引いた和。付録 B）のうち B2 の対象の run の分（事実）:

| 段 | 持つ時間の和 | うち B2 の対象 |
|---|---|---|
| 5 | 83,157 s | **61,892 s（20 run）** |
| 6 | 39,810 s | **23,675 s（10 run）** |

待ちの削減は、run-log の到着時刻を使った先着順・1 本の列の再生で見立てる（付録 B の `sim.mjs`。対象の run の保有時間だけを f 倍）:

| 段 | 観測した待ち（verify＋precheck） | 再生（f=1、今のまま） | f=0.5 | f=0.25 | f=0 |
|---|---|---|---|---|---|
| 5 | 116,330 s | 80,651 s | 23,280 s（−71%） | 15,717 s（−81%） | 10,232 s（−87%） |
| 6 | 53,575 s | 11,108 s | 7,368 s（−34%） | 6,671 s（−40%） | 6,671 s（−40%） |

再生は観測の待ちを段 5 で 69%、段 6 で 21% しか再現しない。run-log に載らない `cpu.heavy` の保有者（leader の手での `unit-related`・`combo-*` の組み合わせの確認・busy の 99 で wait-verify が見失ったサーバーの run・integration）がいるため。**削減率（同じ再生の中での前後の比）だけを見込みに使い、秒数は使わない**。f は PR3 で測る（推測の f で採否を決めない）。

#### 変えるファイル

- PR3（表と測定。判定は変えない）: `tests/setup.ts`（環境変数があるときだけ）、`scripts/read-trace/*.mjs`（新規。tracer・表の作成・`f` の測定）、試験 `tests/unit/scripts/read-trace*.test.ts`、`docs/design/verify-wait-4432.md`（測定の結果を足す）
- PR4（切り替え）: `scripts/run-related-unit-tests.mjs`、`tests/unit/scripts/run-related-unit-tests.test.ts`（既存の `classifies changelog.d/2865.md and locales/ja/worktree.json as full with locales reason` などは**表が無いとき**の期待として残し、表があるときの `it` を足す）、`docs/orchestrate/ci-merge.md` 6-1-1「テスト全体と unit-related の分け方」

#### 危険と採否

- 危険: `tests/setup.ts` は全試験が読む。記録は環境変数があるときだけ入れ、無いときの差は `if` 1 つ（PR3 の試験で、無いときに `fs` が包まれていないことを固定する）
- 危険: 表の古さ。鍵が合わなければ全体に倒すので、古い表で選ぶ経路は無い
- 危険: 読み取りの包みが試験の動き（時間）を変える。表を作る run だけの話で、判定の run には入らない
- **条件つきで採る**: PR3 の陽性対照 1（再生で F ⊆ S）と 2（変異の 4 本）が全部通り、f ≤ 0.5 のときだけ PR4 に進む。どれかが出せなければ **採らない**（N5）

### 2.4 案 B3（検討して外した）: 本文の正規表現で選ぶ

`findTextScanTests` と `findTestsNaming`（パスの文字列）だけで文書・locale の変更の試験を選ぶ形。helper 越しに読む試験（`real-intl.ts` など）と、親のディレクトリを `path.join(root, 'docs')` で組み立てて一覧する試験を落とす根拠が示せない。かつ §1.3 のとおり時間がほとんど減らない。**採らない**。

### 2.5 案 C: `cpu.heavy` の枠を 2 本にする

#### 仕組みと見込み

`cpu.heavy` をマシンで 2 本にする（#4370 PR3 のセマフォの重み、または mutex の多重化）。2 本の列の再生（付録 B、`K=2`）では待ちが段 5 で 80,651 → 8,679 s、段 6 で 11,108 → 853 s。ただし**同時 2 本で 1 本あたりの実行時間が伸びる分を入れていない**（上限の見立て）。

#### 負荷の揺れが増えないことの確かめ方（N4）

既存の実測（verify.yaml の注記）:

- `unit`: 単独 486〜553 s は PASS、同時実行の 640 s で `monitor-exit-codes.test.ts` が FAIL（#1917）
- `integration`: モード B（standalone・並列）で負荷下 11 ラン中 10 ランが赤、`cpu.heavy` を持つ条件で 6/6 緑。モード A（製品・直列）は 9/9 緑
- #4254（`worktrees-status-split-2060.test.ts`）など CI の揺れが今も続いている（7 日で失敗 1 回）。§1.5 の手での全体の実行でも負荷の時間切れが毎回 2〜6 本出ている

確かめ方（採るなら PR の前に要る）:

1. 条件: モード A（`CI=true`）で `npm run test:unit` を (a) 単独と (b) 2 本同時、同じ commit・同じ環境（manifest が `same`）で交互に走らせる。CI のランナー（Docker の VM 16 CPU）が動いている時間帯を含める（実際の負荷の形）
2. 判定: (b) の赤の率が (a) を上回らないこと。0 件の観測で「揺れの率が 5% 未満」と 95% で言うには 3/n ≤ 0.05 から **n ≥ 60 組**が要る（rule of three）
3. 費用: モード A の全体は段 5・段 6 の実績で 1 本 2,100〜3,000 s。60 組 × (単独 1 ＋ 同時 1) で約 **96 時間**の機械の時間（その間ほかの検証が止まるか、揺れの条件が混ざる）

#### 採否

**採らない**。理由: (1) 揺れが増えないことの根拠が今は無く、取るには上の 60 組が要る。(2) B2 が通れば `cpu.heavy` の保有時間そのものが減り（§2.3）、2 本にする必要が下がる。(3) 枠の数の決め方は #4370（PR3 で `cpu.heavy` の取り手をセマフォへ移す）の範囲で、`weights.cpu_heavy`（今 4）と `ci_vm.cpus` の配分と一緒に決めるべき。#4370 に「`cpu.heavy` を 2 本にするなら上の 60 組の試走を条件にする」と渡す（§5 の決めてほしいこと 3）。

### 2.6 案 D（採らない）: 安い契約ゲートが落ちたら試験を打ち切る

verify の赤の多くは `scope`・`env-clean`（段 5: 27 のうち scope 14・env-clean 9）で、試験の前に分かる。落ちた時点で `unit-related` を打ち切れば待ちは減るが、(1) その run で試験の不合格が出なくなり「同じ変更で同じ不合格が同じように出る」（N1）を満たさない、(2) 段 5・段 6 の scope・env-clean の赤の多くは leader の裁定で合格にした（契約の写しの古さ・ワーカー外の `$HOME` の項目）ので、試験の結果がその裁定に要った。**採らない**。

### 2.7 案 E（採らない）: verify どうしで同じ tree の試験の合格を使い回す

同じ作業単位で、前の verify が `unit-related` を通した tree と同じ tree で次の verify が走った行は、段 5・段 6 とも **0**（付録 A の `reuse.mjs`）。再指示のたびに commit が増えて tree が変わるため。メッセージだけの amend（4439 `cad646258`、tree `8ebd875fa`）の例はあるが、その verify は busy の 99 で、V1 で直る形だった。効果が 0 なので**採らない**（作る費用だけが残る）。

---

## 3. 実装の分け方（PR の境目。team.md §6 の 3）

### 3.1 PR の一覧

| PR | 中身 | 危険の種類 | 依存 |
|---|---|---|---|
| **PR1**（A-1） | `run-related-unit-tests.mjs` の最後の行・`wait-verify.mjs` の要約 2 語・`env-manifest.mjs` の `node`・`precheck.mjs` の `verified`・`pr-common.mjs` / `merge-pr.mjs` の読み手・ci-merge.md 6-1-1 | 再利用の判定（品質に直結）。送信・ロックの経路は変えない | V1 のマージ後（`wait-verify.mjs` が重なる） |
| **PR2**（A-2） | `run-log.mjs append --verify-run`・exit-codes.md 3-4 | 記録の形（読み手は PR1 の precheck だけ） | PR1 |
| **PR3**（B1＋B2 の表と測定） | `classifyChanges` の `scripts/`・helper 越しの textscan・`tests/setup.ts` の記録（環境変数のときだけ）・`scripts/read-trace/*`・測定の結果（本書に追記） | 全試験が読む `tests/setup.ts` に触る。判定（選ぶ集合）は B1 の分だけ変わる | なし（PR1 と並べてよい。書くファイルが重ならない） |
| **PR4**（B2 の切り替え） | `run-related-unit-tests.mjs` が表で選ぶ・ci-merge.md 6-1-1 | 選ぶ集合（品質に直結） | PR3 の陽性対照が全部通り f ≤ 0.5（§2.3）。PM の承認 |

C は PR にしない（#4370 に渡す）。D・E は作らない。

### 3.2 各 PR の受入条件の確かめ方（Issue の受入条件との対応）

| PR | 前後の数字（run-log） | 見逃しが増えていない根拠 |
|---|---|---|
| PR1・PR2 | 導入後の段で、precheck の行の `mutexSec` の和と、`related=verified` / `tests=verified` の行の数を §1.2 と同じコマンドで出し、段 5・段 6 と比べる。exit 3 の precheck の数も | §2.1 の陽性対照 1〜4 を試験で固定（一時の run dir・一時の worktree）。導入後の段で、`verified` を使った HEAD の PR の CI `Unit Tests` が合格していること（`ci` の行） |
| PR3 | 判定は変えないので待ちの数字は変わらない。f と F ⊆ S の結果を本書に書く | §2.3 の陽性対照 1（3 本の再生）・2（変異 4 本）・3（陰性対照）。B1 の §2.2 の 3 本 |
| PR4 | 導入後の段で、verify の `unit-related` の行の `runSec`・`mutexSec` の和と、`selection=` の内訳（A-1 の記録で数えられる）を出し、段 5・段 6 と比べる | PR3 の対照を PR4 の試験にも残す。導入後 2 段の間、`selection` が表で選んだ HEAD の PR の CI `Unit Tests` の不合格を数え、揺れ（同じ HEAD の再実行で合格）でない不合格が 1 件でも出たら表の選び方を止めて（`mode=full` に戻す環境変数）原因を調べる |

### 3.3 V1（#4459・#4433）との関係

- 前提: V1 の後、wait-verify の busy 待ちの上限は mutex 待ちの上限（5,400 s）以上になる。段 6 の busy の 99（20 行・89,864 s）は V1 で消える前提で、本書の見込みに数えていない。PR1 の後の比較では、busy の 99 が残っていれば V1 の問題として分けて数える
- **同じファイルを書く箇所**:
  - `scripts/orchestrate/wait-verify.mjs`: V1 は busy 待ちの上限（`VERIFY_BUSY_TIMEOUT_SEC` まわり）、PR1 は要約の語（`verifyTiming` の近くで view を読む所）。関数は違うが同じファイルなので PR1 は V1 のマージ後に切る
  - `scripts/orchestrate/contract.mjs`: V1 は scope の `[id]` の書き方。本書の PR は `UNIT_RELATED_GATE` を**読むだけ**（PR1 の `unit-related-cmd` の比較元）で書かない
  - env-clean（`src/lib/verification/env-clean-gate.ts` など、#4433）: 本書の PR は触らない。A-1 が見る `env=` の manifest（`env-manifest.mjs`）は env-clean とは別物
  - lock の試験の揺れ（`tests/unit/verification/lock-pr1af-impl2-4288.test.ts`）: 触らない

---

## 4. 試験の観点（全組み合わせの表）

### 4.1 案 A（precheck の `related` / `tests` の段）

入力の次元: 記録の有無と形 × tree × 環境 × 選び方 × コマンド × 結果 × `--heavy-to-ci`。期待は「走らせない（`verified`）」か「走らせる（今までどおり。重ければ `cpu.heavy`）」。

| # | verify の記録 | tree | `verifyEnvState` | 選び方 | `unit-related-cmd` | 記録の結果（`failed=`） | 期待 |
|---|---|---|---|---|---|---|---|
| A1 | なし | — | — | — | — | — | 走らせる |
| A2 | `passed=` に `unit` | 同じ | same | （全体） | （不要） | ok | **verified** |
| A3 | `passed=` に `unit-related@contract` | 同じ | same | full | 一致 | ok | **verified** |
| A4 | 同上 | 同じ | same | full | 一致 | fail（`scope` のみ） | **verified** |
| A5 | 同上 | 同じ | same | full | 一致 | fail（`scope`・`env-clean`・`work-evidence` の組み合わせのみ） | **verified** |
| A6 | 同上 | 同じ | same | full | 一致 | fail（`lint` など試験以外のゲートを含む） | **verified**（試験の結果は独立。`eslint` の段は別に走る） |
| A7 | `failed=` に `unit-related@contract:FAIL` | 同じ | same | full | 一致 | fail | 走らせる |
| A8 | `unit-related@contract:SKIP`（mutex 待ち切り） | 同じ | same | — | 一致 | error | 走らせる |
| A9 | `passed=` に `unit-related@contract` | 同じ | same | **related** | 一致 | ok | 走らせる |
| A10 | 同上 | 同じ | same | **記録なし（今の形）** | — | ok | 走らせる（既存の試験 `a unit / unit-related pass does not stand in for the test steps`） |
| A11 | 同上 | 同じ | same | full | **不一致** | ok | 走らせる |
| A12 | 同上 | **違う** | same | full | 一致 | ok | 走らせる |
| A13 | 同上 | 同じ | **changed**（lockfile） | full | 一致 | ok | 走らせる |
| A14 | 同上 | 同じ | **changed**（`node` の版） | full | 一致 | ok | 走らせる |
| A15 | 同上 | 同じ | **missing** | full | 一致 | ok | 走らせる |
| A16 | 同上 | 同じ | **unrecorded**（`env=` なし） | full | 一致 | ok | 走らせる（`eslint` / `tsc` の再利用と違い、警告で通さない） |
| A17 | 別の作業単位（issue / item が違う）の記録 | 同じ | same | full | 一致 | ok | 走らせる |
| A18 | A3 の条件 ＋ `--heavy-to-ci` | 同じ | same | full | 一致 | ok | **verified**（`ci` にしない） |
| A19 | A1 の条件 ＋ `--heavy-to-ci`、重い段 | — | — | — | — | — | `ci`（今までどおり） |
| A20 | A2 で `related` の段が無い（`src`・`scripts` の変更なし） | 同じ | same | — | — | ok | `tests` だけ verified、`related` は今までどおり skip |
| A21 | leader の裁定の行（自由文、`passed=` なし） | 同じ | — | — | — | ok | 走らせる |
| A22 | `--verify-run` で写した裁定の行（A3 の欄つき） | 同じ | same | full | 一致 | ok | **verified** |
| A23 | `--force` | 同じ | same | full | 一致 | ok | 走らせる（今の `--force` と同じ） |

加えて: `verified` の段を持つ precheck の記録が、`run-log.mjs status` の `next`・`merge-pr` / `publish-pr` の `unmetStage` で `ok` の段として読まれること、`parseNote` が `verified` を読むこと、`verified` の precheck の記録を別の precheck が再利用するときも上の条件（tree・環境）が効くこと。

### 4.2 案 B1・B2（`run-related-unit-tests.mjs` の選び方）

| # | 変更ファイルの種類 | 表 | 期待の mode | 選ぶ試験 |
|---|---|---|---|---|
| B1 | `src` のみ | 任意 | related | 今と同じ（陰性対照） |
| B2 | `tests/unit`・`tests/helpers` のみ | 任意 | related | 今と同じ |
| B3 | `scripts/**/*.mjs` のみ | 任意 | related | graph ＋ textscan（子プロセスを起こす helper を import する試験を含む） |
| B4 | `md` のみ | あり・鍵一致 | related（表） | graph ＋ 表で読んだ試験 ＋ 不透明 ＋ 変更した試験・guards・docs |
| B5 | `md` のみ | **なし** | full | 全体 |
| B6 | `md` のみ | **鍵不一致** | full | 全体 |
| B7 | `md` のみ | **読めない** | full | 全体 |
| B8 | `locales` のみ | あり・鍵一致 | related（表） | B4 と同じ（helper 越しの読み取りを含む） |
| B9 | `tests/integration`・`tests/e2e` のみ | あり・鍵一致 | related（表） | B4 と同じ |
| B10 | `md` ＋ `src` | あり・鍵一致 | related（表） | B4 ＋ `src` の graph |
| B11 | `md` ＋ `scripts` | あり・鍵一致 | related（表） | B4 ＋ B3 |
| B12 | `md` ＋ `.env.example` / `.gitignore` / `.sh` / `package.json` / `vitest.config.ts` / `tests/setup.ts` | 任意 | full | 全体（対象の外が 1 つでもあれば） |
| B13 | `changelog.d`・`dev-reports`・`.commandmate/tasks` のみ | 任意 | none | なし（今と同じ） |
| B14 | 削除だけ（`md` を消す） | あり・鍵一致 | related（表） | 消したファイルとその親のディレクトリを読んだ試験 |
| B15 | rename（`md` の移動） | あり・鍵一致 | related（表） | 旧・新の両方のパスと親を読んだ試験 |
| B16 | 新規の `md`（表に無いパス） | あり・鍵一致 | related（表） | 親のディレクトリを一覧した試験 |

表を作る側（PR3）の観点: node の子の読み取りが記録される／node 以外の子を起こした試験が不透明になる／helper 越しの読み取りが試験ファイルに帰属する／環境変数が無いとき `fs` を包まない／記録の外（リポジトリの外のパス）を書かない。

### 4.3 案 C（採らないが、#4370 に渡す試走の観点）

| # | 条件 | 測るもの |
|---|---|---|
| C1 | モード A・単独 × 60 | 赤の数と試験名、`runSec` |
| C2 | モード A・2 本同時 × 60（C1 と交互） | 同上。C1 より多ければ採らない |
| C3 | C2 の間に CI のランナーが動いている組 | 同上（実際の負荷の形） |

---

## 5. 決めてほしいこと

1. **A の走らせ方の差を受け入れるか**: verify の全体（`CI=true`・直列・試験の上限 20 s）の合格で、precheck の試験（並列・上限 5 s）を飛ばす。論理の不合格は verify で必ず出るが、「5 s を超えて 20 s 以内」の時間切れは precheck で出なくなる（それは負荷の揺れで、PR の CI と同じ判定に揃うと本書は読む）。あわせて、manifest の外（`$HOME` の下・ignore されたファイル）の入力が verify と precheck の間で変わる危険が残る（§2.1 の危険）。推奨: 受け入れる（PR の CI が全体をもう一度見るため）
2. **A-2 の override の記録**: leader の裁定の行を `run-log.mjs append --verify-run <id>` で書く運用にするか（exit-codes 3-4 の手順の変更）。推奨: する（段 6 の precheck の待ちの全部がこれで消える見込み）
3. **C を #4370 に渡す**: `cpu.heavy` を 2 本にする判断を、60 組の試走（§2.5・§4.3）を条件として #4370 PR3 に移すか。推奨: 移す（本 Issue では採らない）
4. **B2 の進め方**: PR3（表と測定だけ）を先に出し、陽性対照と f ≤ 0.5 を見てから PR4 を決める 2 段にするか。PR4 では `tests/unit/scripts/run-related-unit-tests.test.ts` の既存の `it` の期待（`locales` で `full`）を「表が無いとき」の期待として残す（名前は変えない）。推奨: 2 段にする。f の閾値 0.5 も決めてほしい
5. **表を作る場所**: develop の HEAD で 1 日 1 回（agent-health の日次の計測と同じ機械）か、CI の `Unit Tests` の shard で作って artifact にするか。前者は `cpu.heavy` を 1 日 1 回取る（モード A の全体 1 本分＋記録の重さ）。推奨: 前者（CI の shard は 4 分割で、子プロセスの記録を合わせる手間が増える）

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

`reuse.mjs`（§1.4・§2.7）の判定: run-log を時刻順に読み、`verify` の行で `passed=` に `unit-related@contract` があれば（作業単位・`git rev-parse <head>^{tree}`・`env=`）を覚える。後の `verify` の行（`unit-related` を含み待ちの記録あり）と `precheck` の行（`mutexSec` > 0）について、同じ作業単位・同じ tree の記録があるかを数える。§1.4 の表はこの出力に HEAD と mode を足したもの。

## 付録 B: `cpu.heavy` の列の再生（`sim.mjs`）

- 対象の行: `verify` で `unit-related@contract` を含み `mutexSec` がある行、`precheck` で `mutexSec` > 0 の行
- 保有時間: verify は `runSec − 52`（`unit-related` 以外のゲート〔lint・typecheck・build-server〕の分。`unit-related` を含まない verify の行の `runSec` は段 5 で 2 行の平均 46 s、2026-11-13 の run-3574-4317 で 51〜52 s。大きい方を引く）、precheck は `runSec`。待ち切り（`SKIP` / `held`）の行は保有 0
- 到着時刻: `at − 保有時間 − mutexSec`
- 先着順・K 本（既定 1）の列に流し、各行の待ちの和を出す。B2 の対象の verify の行だけ保有時間を f 倍する
- 限界: run-log に載らない保有者（§2.3）を含まないので、秒数ではなく同じ再生の中の前後の比だけを使う。K=2 は同時実行で保有時間が伸びる分を入れていない

```bash
for f in 1 0.5 0.25 0; do node sim.mjs <repo> "$F" $f; done      # §2.3 の表
K=2 node sim.mjs <repo> "$F" 1                                      # §2.5
```
