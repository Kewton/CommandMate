---
name: cmate-verify
description: リポジトリの検証ゲート（lint / typecheck / test / build 等）を .commandmate/verify.yaml に宣言し、worktree の cwd で逐次実行して exit code で合否を判定する。verify.yaml が無いリポジトリでは CI 定義から起案する。作業完了を主張する前の検証や、並列ワーカーの完了判定に使う。
allowed-tools: Bash(.claude/skills/cmate-verify/scripts/*), Bash(.agents/skills/cmate-verify/scripts/*), Bash(git worktree list), Read, Write, Glob, Grep
---

# cmate-verify

「このリポジトリで何が通れば合格か」を `.commandmate/verify.yaml` に宣言し、
**実 exit code で** 判定するランナー。CommandMate 本体の検証ゲート
（`commandmate verify <worktree-id>` / `commandmate wait <worktree-id> --verify`）の
代替ではなく、**verify.yaml の起案**（手順 1）と、**CommandMate が無い環境でも bash と git
だけで同じ判定を出すスタンドアロンランナー**（手順 2）の 2 役である。

正準仕様は CommandMate リポジトリの [`docs/design/verification-config.md`](../../../docs/design/verification-config.md)。
本体のローダ（`src/lib/verification/verify-config.ts`）は同じ仕様を一般的な YAML パーサで
実装するので、この Skill で書いた verify.yaml はそのまま引き継げる。

> **なぜ exit code か**: `cmd | grep ...` は `$?` を grep に渡して非ゼロ終了を隠す。vitest は
> 全テスト緑でも Unhandled Rejection で exit 1 を出しうるので、出力を grep した要約は
> それを PASS と報告してしまう。ゲートは必ず `sh -c "$cmd" > log 2>&1` で走らせ `$?` を直接読む。

## 構成

```
cmate-verify/
├── SKILL.md
└── scripts/
    ├── verify-run.sh        # ゲート実行ランナー（bash 3.2 互換）
    └── tests/
        ├── run-tests.sh     # fixture ベーステスト（bash + git だけで動く）
        └── fixtures/*.yaml
```

`scripts/tests/run-tests.sh` は vitest に依存しない。Node の無い導入先でも
`bash scripts/tests/run-tests.sh` だけで検証できる（CommandMate 本体では
`tests/unit/skills/cmate-verify/` の薄いラッパが `npm run test:unit` から同じ suite を回す）。

install 先は `.claude/skills/cmate-verify/` と `.agents/skills/cmate-verify/` の両方で、
中身は byte-identical である（Claude は前者、Codex は後者を読む）。以下のコマンド例は
`.claude/...` で書いてあるが、`.agents/...` に読み替えても同じものが走る。

## 手順 1: init（`.commandmate/verify.yaml` が無い場合）

**コードを書かず、リポジトリをスキャンしてゲートを起案し、ユーザーの確認を得てから書き出す。**
検出優先順位は次のとおり。上位が見つかったら下位は補助として扱う。

1. **`.github/workflows/*.yml` の CI ジョブ** — そのリポジトリにおける「何が通れば合格か」の
   既存の定義。`run:` の各ステップが第一候補。
2. **`package.json` の `scripts`** — `lint` / `test` / `test:unit` / `typecheck` / `build` 系。
3. **`Makefile` のターゲット** — `make lint` / `make test` 等。
4. **言語マニフェスト** — `Cargo.toml`（`cargo clippy` / `cargo test`）、`pyproject.toml`
   （`ruff` / `pytest` / `mypy`）、`go.mod`（`go vet` / `go test ./...`）等。

起案時の注意:

- 実行時間の長いゲートには `timeoutSec` を明示する（既定は 600 秒）。
- ゲートの並び順がそのまま実行順になる。速いゲートを先に置くと失敗が早く読める
  （途中で失敗しても残りは実行されるので、順序は打ち切りではなく可読性のための選択）。
- **デプロイ・publish・リリース・外形変更を伴うコマンドはゲートにしない。** ゲートは
  何度でも安全に再実行できるものに限る。
- 起案結果は「どこから拾ったか」（CI ジョブ名 / npm script 名）とセットで提示し、
  **ユーザーの確認を得てから** `.commandmate/verify.yaml` を書き出す。

書き出したら、その場で 1 回実行して `RESULT passed` になることまで確認する。

## 手順 2: run（verify.yaml がある場合）

```bash
.claude/skills/cmate-verify/scripts/verify-run.sh --cwd <worktree-path>
```

主なオプション:

| オプション | 意味 |
|---|---|
| `--config <path>` | 既定は `<cwd>/.commandmate/verify.yaml` |
| `--cwd <path>` | ゲートを実行する worktree。既定はカレントディレクトリ |
| `--base-ref <ref>` | work-evidence の基準。`options.baseRef` より優先 |
| `--gates id1,id2` | 一部のゲートだけ実行する。存在しない id は設定エラー |
| `--skip-work-evidence` | 未着手ガードを飛ばす |

出力は stdout に 1 ゲート 1 行、最終行が判定:

```
GATE work-evidence PASS commits=3 uncommitted=2
GATE lint PASS exit=0 duration=12s
GATE unit FAIL exit=1 duration=45s
RESULT failed
```

| 行 | 形式 |
|---|---|
| コマンド系ゲート | `GATE <id> PASS\|FAIL exit=<code> duration=<n>s` |
| 再実行したゲート | `GATE <id> FLAKY\|FAIL exit=<c1>,<c2> duration=<n>s,<n>s` |
| タイムアウト | `GATE <id> TIMEOUT exit=124 duration=<n>s` |
| skip | `GATE <id> SKIP reason=primary-checkout\|flag\|mutex-wait\|no-baseline` |
| work-evidence | `GATE work-evidence PASS\|FAIL commits=<n> uncommitted=<n>` |
| 判定 | `RESULT passed\|failed\|not_started\|skipped` |

`mutex` を宣言したゲートは末尾に `waited=<n>s` が付く。
**CommandMate CLI は同じ値を括弧で描画する**（`GATE lint PASS (exit=0, 12.3s)`）—— 元から
別形式であり、契約は**フィールド名・単位・「waited を duration に足さない」ことであって
区切り文字ではない**（`docs/design/verification-config.md` §9.3 の表が綴りの確定形）。

失敗ゲートのログ末尾は **stderr** に出る（stdout をパース可能に保つため）。
FAIL / TIMEOUT では**必ず理由行が出る**。ゲートが 1 バイトも出力しなかった場合は
`no output captured`、`maxLogTailBytes: 0` なら `log tail disabled` と明示する
（無言で終わると「不合格」しか残らず原因を追えない。Issue #1607）。
出力ゼロで exit 126/127 のときは「コマンドが起動できていない可能性」を追加で出す
（**断定ではなく調査の手がかり**。exec/spawn の失敗は背景ジョブの `wait` 越しには
非 0 としてしか見えない）。

| RESULT | exit code | 意味 |
|---|---|---|
| `passed` | 0 | 実行した全ゲートが PASS |
| — | 2 | 設定エラー（verify.yaml 不正 / ファイル無し / git でない cwd 等） |
| `failed` | 20 | 1 つ以上のゲートが FAIL / FLAKY（`flakyIsPass` 未宣言）/ TIMEOUT |
| `not_started` | 21 | work-evidence が「作業の痕跡ゼロ」と判定（コマンド系ゲートは走らない） |
| `skipped` | 22 | 実行したコマンド系ゲートが 0 件、または `mutex` が空かず**裁定に到達しなかった**ゲートが在る |

**`skipped` を `passed` と読まないこと。** 何も検証していない状態であり、緑ではない。
CommandMate 本体はこの「判定不能」を exit 99 で表すが、本ランナーの語彙に 99 は無い。
22 が「ここでは何も裁定していない。これは緑ではない」を既に意味しているので、そちらに寄せている。
**実際に落ちたゲートが在れば 20 が勝つ** —— 在る裁定は無い裁定より強い。

## verify.yaml の書き方

```yaml
# .commandmate/verify.yaml — v1
version: 1
gates:
  - id: lint
    command: "npm run lint"
    timeoutSec: 600
  - id: typecheck
    command: "npx tsc --noEmit"
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
    retryOnFail: 1            # 落ちたら同一 tree でもう 1 回だけ回す（0 か 1 のみ）
    flakyIsPass: false        # FLAKY を pass と数えるか（既定 false = 数えない）
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
    mutex: e2e-port           # マシン全体で同時に 1 つ
options:
  baseRef: origin/develop
  skipInPrimaryCheckout: true
  maxLogTailBytes: 8192
  requireCommit: false        # true で work-evidence が commit を要求する（既定 false）
  requireEnvClean: false      # CommandMate の組み込み env-clean ゲート（本ランナーは判定できない）
```

### キーの一覧（両ランナーが受理する集合）

正準は CommandMate の `src/lib/verification/verify-config.ts`
（`docs/design/verification-config.md` §9.5 の parity 表）。**本ランナーはこの集合に追随する。**
**v1 は閉じた集合なので、ここに無いキーは無視されるのではなく exit 2 である。**

| 場所 | キー | 値域 | 既定 |
|---|---|---|---|
| `gates[]` | `id` | `^[a-z0-9][a-z0-9-]{0,31}$`。`work-evidence` / `scope` / `env-clean` は予約 | 必須 |
| `gates[]` | `command` | 1 行スカラー | 必須 |
| `gates[]` | `timeoutSec` | 整数 1..7200 | 600 |
| `gates[]` | `mutex` | `^[A-Za-z0-9_.-]+$` / 64 文字以内 | 宣言しない |
| `gates[]` | `retryOnFail` | **`0` か `1` のみ**（2 以上は設定エラー） | 0 |
| `gates[]` | `flakyIsPass` | `true` / `false`。**`true` は `retryOnFail: 1` を伴わないと設定エラー** | false |
| `options` | `baseRef` | ref 名 | `refs/remotes/origin/HEAD` |
| `options` | `skipInPrimaryCheckout` | `true` / `false` | true |
| `options` | `maxLogTailBytes` | 整数 0..1048576 | 8192 |
| `options` | `requireCommit` | `true` / `false` | false |
| `options` | `requireEnvClean` | `true` / `false` | false |

このランナーは awk / sed で読むため、**YAML のサブセットしか受け付けない**:

- インデントは 2 スペース固定（タブは不可）
- 値は 1 行スカラーのみ。アンカー / エイリアス（`&` `*`）・複数行文字列（`|` `>`）・
  フロースタイル（`[...]` `{...}`）は拒否する
- 行内コメントは無し。`#` で始まる行のみコメント
- `key:` の**最初のコロン**で分割するので、値の中のコロンはそのまま書ける

**制約に反する verify.yaml は「best-effort で解釈」せず exit 2 で拒否する。**
黙って一部を読み飛ばすと「設定したつもりのゲートが走っていないのに passed」になるため。
本体のローダは一般的な YAML パーサを使うが、この形式で書いておけば両方で読める。

各フィールドの型・既定値・範囲は上記の表と `docs/design/verification-config.md` の仕様表が正準。

## 組み込みゲート work-evidence

コマンド系ゲートより先に、**そもそも作業が行われたか**を判定する。

- PASS 条件: `merge-base(baseRef, HEAD)..HEAD` のコミット数 > 0 **または**
  `git status --porcelain -z -uall` の非契約エントリ数 > 0
- 両方 0 なら `RESULT not_started` (exit 21)。コマンド系ゲートは 1 つも実行しない

未起動のセッションを「全ゲート PASS」と誤報告しないためのガードである
（変更ゼロのリポジトリでは lint も typecheck も当然通る）。

### 実行契約は作業証跡ではない（Issue #1651 / #1580）

`.commandmate/tasks/` 配下は CommandMate の実行契約で、**オーケストレーターの証跡で
あってエージェントの証跡ではない**。委任した直後の worktree（契約ファイルが 1 件置かれた
だけの状態）が「作業済み」に見えると exit 21 が意味を失うため、**両方のカウンタから除外する**。

- コミット側: `git rev-list --count <base>..HEAD -- ':(top)' ':(exclude,top).commandmate/tasks/'`
  — 契約だけを載せた setup commit は 1 コミット分の作業として数えない。
  副作用として**ファイルを 1 つも変更しない commit（`--allow-empty`）も数えない**
  （pathspec 指定時の履歴単純化。製品実装も同じ）
- 未コミット側: `git status --porcelain -z --untracked-files=all` を**エントリ単位**で解析し、
  **エントリ内のいずれかのパスが契約ファイルでなければ**作業として数える
  （契約を実作業へ rename した場合も拾う）

`-z` と `-uall` は必須である。人間向けフォーマットは空白を含むパスを C クォートし、
rename を ` -> ` で連結し、既定の untracked モードは新規の `.commandmate/tasks/` を
`?? .commandmate/` の 1 エントリに畳む — いずれもパスでないものを判定に渡す。
このランナーは契約ファイルを**開かない**（パス名だけを見る）。

両カウンタが 0 かつ変更自体は存在する場合、除外が効いたことを stderr に 1 行出す
（`FAIL commits=0 uncommitted=0` を「ゲートのバグ」と読ませないため）。

### `options.requireCommit`（既定 false）

`true` にすると、work-evidence は「変更が在る」ではなく **「commit が在る」** を要求する。
`commits=0 uncommitted=1` は PASS ではなく FAIL（`RESULT not_started` / exit 21）になり、
ゲート行に `requireCommit=true` が付く。

```
GATE work-evidence FAIL commits=0 uncommitted=3 requireCommit=true
RESULT not_started
```

理由は stderr に出る（`commits=0 uncommitted=3` は「作業が在る」ようにも読めるため、
FAIL の理由が行から読み取れない唯一のケースである）。

`commits=0 uncommitted=1` は「ここで何か起きたか」への答えとしては正しく、
「これは完了したか」への答えとしては誤りである。後者を訊きたいリポジトリだけが
opt-in する。**既定を false にしているのは、このゲート本来の問いが前者だから。**

**このランナーは実行契約を読まない。** CommandMate の実行契約
（`.commandmate/tasks/*.yaml`）にも `success.requireCommit` があり、製品実装は両者を
**OR** で合成するが（Issue #1642）、本ランナーが見るのは `options.requireCommit` だけである
— シェルから起動したランは、どの委任にも紐付いていないため。**両方のランナーで効かせたい
要求は verify.yaml に書く**。それが 2 実装が共に読む唯一のファイルである（Issue #1639）。

TS 実装（`src/lib/verification/gate-runner.ts`）との一致は CommandMate 側の
conformance テスト（`tests/unit/skills/cmate-verify/require-commit-conformance.test.ts`）が
同一の git サンドボックスに両実装を当てて固定している。**Issue #1651 で既知の差分は
2 件とも解消した** — 契約ファイルの除外（bash が緩い向きだった）と、未追跡ディレクトリの
数え方（`-uall` の有無で数字だけが違った）。同テストは verdict だけでなく
`commits=N uncommitted=N` を**数値として**突き合わせる（両方 > 0 のままズレる差分は
verdict の比較では見えないため）。

## 並列 worktree と共有資源（Issue #1771）

### `mutex: <name>` — マシン全体の排他

固定ポート・ローカル DB・エミュレータのように **worktree ごとに分けられない資源**を持つゲートに
宣言する。同じ名前を宣言したゲートはマシン全体で同時に 1 つしか走らない。

```
GATE e2e PASS exit=0 duration=190s waited=42s
```

- `duration` は**ゲート自身のコマンドが動いていた時間**、`waited` は**ロック待ちの時間**。
  **足さないこと** —— 混ぜると timeout の調整も advisor の入力も歪む。
- `mutex` を宣言していて待たなかったゲートも `waited=0s` を出す（「排他されていて待たなかった」と
  「排他していない」は別の事実である）。宣言していないゲートの行は従来どおりで、`waited=` は付かない。
- ロックが空かないまま `timeoutSec` に達したら `GATE <id> SKIP reason=mutex-wait waited=<n>s`。
  **TIMEOUT ではない**（コマンドは 1 度も起動していない）し **FAIL でもない**（work を裁定していない）。
  その run は `RESULT skipped` / exit 22 になる。

**ロックの置き場と方式は規約であり実装詳細ではない。** CommandMate の runner
（`src/lib/verification/machine-lock.ts`）と本ランナーは同じマシンに対して独立に
起動されるので、どちらか一方でも違えば排他にならない。

| 項目 | 規約 |
|---|---|
| パス | `~/.commandmate/locks/<name>.lock`（環境変数 `CM_VERIFY_LOCK_ROOT` で差し替え可。**テストは必ずこれを使う**） |
| 方式 | **`mkdir` によるアトミックな作成**（macOS に `flock(1)` が無いため） |
| 保有者記録 | ロックディレクトリ内の `owner`。JSON `{"pid":N,"host":"…","token":"…","acquiredAt":ms}` |
| 待ち | 空くまでポーリング（250ms 間隔）。上限は**そのゲートの `timeoutSec`** |
| 解放 | `owner.token` が自分のものであるときだけ削除する |
| 死んだ保有者 | `host` が自ホストと一致し、かつ `pid` が存在しないときのみ、待つ側が奪ってよい。**他ホストの pid では判断しない** |

`token` が無いと、pid が死んで見えたために奪われた側が、あとから解放したときに
**次の保有者のロックを消す**（＝2 ランが同時に資源へ入る）。

### `CM_WORKTREE_INDEX` / `CM_WORKTREE_ID`

CommandMate はゲートに worktree ごとの採番を渡す（`~/.commandmate/worktree-index/<n>` を
`O_EXCL` で確保する）。**本ランナーはこの 2 つを設定しない。** 呼び出し側が export していれば
それがそのまま子プロセスへ渡り、していなければ未設定のまま走る。

理由は臆病さではなく**採番を知らないこと**である。CommandMate の番号は worktree ID に紐づいて
永続化されており、standalone 側が別の根拠で振った番号は**同じ worktree に別の番号を与える** ——
その結果、製品 run が既に握っているポートにゲートを載せることになる。無いより悪い。

**ゲート側が既定値を持つこと。**

```yaml
gates:
  - id: e2e
    command: "sh -c 'E2E_PORT=$((60400+${CM_WORKTREE_INDEX:-0})) npm run test:e2e'"
```

`${CM_WORKTREE_INDEX:-0}` と書いておけば、CommandMate 経由でも素の shell からでも同じ
verify.yaml が走る。既定値なしで `$((60400+CM_WORKTREE_INDEX))` と書くと、変数が未設定の
経路で全 worktree が 60400 に潰れる。

## `retryOnFail` / `flakyIsPass` — FLAKY（Issue #1772）

環境・乱数由来の赤に名前を付ける。`retryOnFail: 1` を宣言したゲートが**非ゼロ終了したときだけ**、
**同一 tree でもう 1 回だけ**回す。

| outcome | 条件 | GATE 行 | 裁定 |
|---|---|---|---|
| FLAKY | 1 回目 fail → 2 回目 pass、`flakyIsPass` 未宣言／`false` | `FLAKY` | **fail**（`RESULT failed` / exit 20） |
| FLAKY | 1 回目 fail → 2 回目 pass、`flakyIsPass: true` | `FLAKY` | pass（`RESULT passed` / exit 0） |
| FAIL | 2 回とも fail | `FAIL` | fail |

- **値域は `0` か `1` のみ。** 十分な回数を回せばどんな赤も緑になるので、**上限そのものが機能の中身**である。
- **再実行するのは `FAIL` だけ。** `TIMEOUT` は再実行しない（既に予算を使い切っており、2 回目は
  予算が最も大きいゲートの実時間を倍にする）。`SKIP`（mutex 待ち）はコマンドが 1 度も走っていない。
- 2 回目が裁定に到達しなかったとき（TIMEOUT・mutex 待ち）は **1 回目の FAIL がそのまま立つ**。
- **既定では FLAKY は fail 扱い。** 再実行を宣言してもゲートは 1 bit も弱くならない。
  `retryOnFail: 1` が買うのは「何が起きたか」に名前が付くことであって、pass ではない。
- **`FLAKY` の綴りは `flakyIsPass` で変わらない。** 変わるのは RESULT と exit code だけである。
  FLAKY を `PASS` と綴ると、この機能が可視化するために存在する唯一の事実が消える。
- `mutex` と併用したとき、ロックは**試行ごとに取得・解放する**。

両ランの記録は stderr に出る機械可読アンカーで運ばれる（`maxLogTailBytes` は**ラン単位**に適用）:

```
[flaky] runs=2 outcome=flaky exit=1,0 duration=45.0s,44.0s verdict=fail
--- [flaky] run 1/2: failed exit=1 duration=45.0s ---
--- [flaky] run 2/2: passed exit=0 duration=44.0s ---
[mutex] name=e2e-port waited=42.0s lock=/Users/me/.commandmate/locks/e2e-port.lock
```

**`outcome=fail`（2 回とも fail）でもアンカーを書く。** 2 回落ちたゲートは flakiness に対する
**反証**であり、flake advisor はその分母を必要とする。flaky 側にしか印が無ければ、再実行した
ゲートは全て flaky に見える。

## `options.requireEnvClean`（既定 false）

CommandMate の組み込み `env-clean` ゲート（Issue #1740）を有効にするキー。**本ランナーは
受理するが判定はできない** —— このゲートは「タスク作成時（`send --contract`）に撮ったマシンの
スナップショット」と現在を比較するものであり、shell から起動した run はどのタスクにも
紐付いていないので、比較対象のベースラインが存在しない。

宣言されたときは `GATE env-clean SKIP reason=no-baseline` を出し、理由を stderr に書く
（黙って飲み込まない）。**この行は判定を変えない** —— 有効にしただけの repository の run を
すべて緑でなくしてしまえば、読めない設定（exit 2）を別の読めない設定（決して緑にならない）に
置き換えただけになる。このゲートの裁定を持っているのは `commandmate verify` である。

## メイン checkout での skip

`options.skipInPrimaryCheckout`（既定 `true`）が有効なとき、**プライマリ checkout では
コマンド系ゲートを実行しない**。プライマリ checkout は稼働中サーバの cwd になっている
ことがあり、その足元で build / test を回すと動いている画面を壊す。判定は
`git rev-parse --git-dir` と `--git-common-dir` が同じ実パスを指すかで行う。

検証は linked worktree で回すこと。

## テスト

```bash
bash .claude/skills/cmate-verify/scripts/tests/run-tests.sh
# ... ok - / not ok - の行が並び、最後に
# tests: 317 passed, 0 failed
```

fixture は `scripts/tests/fixtures/*.yaml`。カバーしているのは
全 PASS / 1 ゲート FAIL / timeout / work-evidence の not_started / 設定ファイル無し
の 5 ケースに加えて、対になる反証ケース（同じ設定が linked worktree では実行される、
`--skip-work-evidence` を付ければ同じ clean repo でも実行される）と、27 種の設定エラー、
出力ゼロで落ちるゲート・`maxLogTailBytes: 0` の診断可能性（Issue #1607）、
`options.requireCommit`（未 commit のみ → 21 / 同じ変更を commit → 0 / 既定では同じ dirty tree が
PASS / 作業ゼロは commit 規則のせいにしない / `--skip-work-evidence` は要求ごと飛ばす。
Issue #1639）、契約ファイルの除外（契約だけの untracked → 21 / 契約だけの setup commit → 21 /
同じツリーに実作業を足すと 0 / 契約を実作業へ rename・その逆向きも作業として数える /
空白を含む契約パスも非契約パスも誤判定しない / 新規ディレクトリはファイル単位で数える。
Issue #1651）、`mutex`（ロックは `<root>/<name>.lock` のディレクトリ・`owner` に pid/host/token /
待った側が `waited=` を duration と別に出す / 待たなかった側も `waited=0s` / 既定のロック根が
`$HOME/.commandmate/locks` / 他ホストの保有者は奪わず `SKIP reason=mutex-wait` + exit 22 /
自ホストの死んだ保有者だけ奪う / 解放される）、`retryOnFail` / `flakyIsPass`
（FLAKY は既定 fail・`flakyIsPass: true` で pass・綴りは変わらない / 2 回 fail は FAIL のまま /
再実行はちょうど 1 回 / TIMEOUT は再実行しない / `outcome=fail` でもアンカーを書く。Issue #1772）、
`CM_WORKTREE_INDEX` / `CM_WORKTREE_ID` の素通し（Issue #1771）、
`options.requireEnvClean` の受理と `GATE env-clean SKIP reason=no-baseline`（Issue #1740）、
アサーションヘルパ自身の自己検査。

失敗ログの追跡可能性も固定してある。ランナーの stdout / stderr は分離したまま
（それが契約）だが、`run_verify` は **exit code ≠ 0 のときだけ** stderr を `out.N` に
追記し、失敗した assert は `out.N` の path と中身の両方を出す。CI に残るのは suite の
標準出力だけなので、`err.N` は sandbox の EXIT trap で消えてしまい後から読めない。
`assert_stdout_contract` は stdout が `GATE ...` / `RESULT ...` の 2 形式だけであることを
確認する（out.N が stderr を運んでも stdout 契約は壊れていない、という反証側）。

判定が空振りしていないことは変異注入で確認してある（`set -m` の除去 → orphan 検出が赤 /
失敗時の打ち切り → 継続実行の assert が赤 / work-evidence の OR を AND に → 33 件赤 /
全 skip を passed と報告 → skip 判定が赤 / プライマリ判定の無効化 → 6 件赤 /
`out.N` への stderr 追記の停止 → 診断系 7 件だけ赤 / 空 log・tail 無効の fallback 除去 →
5 件だけ赤 / spawn ヒントの除去 → 2 件だけ赤 / ログ末尾を stdout に流す → 3 件赤
（うち 1 件が `assert_stdout_contract`））。
`requireCommit` も同様（判定分岐の除去 → 5 件赤 / awk が再びキーを拒否 → 15 件赤 /
`requireCommit=true` を無条件に出力 → 1 件赤）。
契約ファイルの除外も同様（commit 側の pathspec 除去 → 6 件赤＋conformance 3 件赤 /
未コミット側の除外除去 → 9 件赤＋conformance 2 件赤 / `-uall` 除去 → 10 件赤 /
rename の 2 パス目を見ない → 1 件赤 / `-z` をやめて人間向けフォーマットを行単位で読む
→ 21 件赤）。
`MIN_ASSERTIONS` はケースが黙って落ちたときに 0 failed で緑にならないための下限である。
