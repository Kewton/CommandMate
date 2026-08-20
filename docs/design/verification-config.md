# 仕様: `.commandmate/verify.yaml` v1（検証ゲート設定）

- **Issue**: [#1540](https://github.com/Kewton/CommandMate/issues/1540)（親 [#1539](https://github.com/Kewton/CommandMate/issues/1539) / Phase 0）
- **ステータス**: Accepted
- **対象 version**: `1`
- **参照実装**: `.claude/skills/cmate-verify/scripts/verify-run.sh`（= `.agents/skills/cmate-verify/...`、byte-identical）
- **テスト**: `.claude/skills/cmate-verify/scripts/tests/`（fixture ベース）＋ `tests/unit/skills/cmate-verify/`（vitest ラッパ）

本書は `.commandmate/verify.yaml` の **正準仕様**である。Phase 0 の Skill（`cmate-verify`）は
bash + awk で、Phase 1 以降の製品ローダは一般的な YAML パーサでこの仕様を実装する。
**同じ verify.yaml が両方で読めること**が本仕様の目的であり、Skill 期に書かれた設定は
製品化後もそのまま使える。

---

## 1. 全体像

```yaml
# .commandmate/verify.yaml — v1
version: 1
gates:
  - id: lint              # 必須。^[a-z0-9][a-z0-9-]{0,31}$ で一意。予約ID: work-evidence, scope, env-clean
    command: "npm run lint"   # 必須。worktree の cwd で shell 実行される
    timeoutSec: 600       # 省略時 600。範囲 1..7200
  - id: typecheck
    command: "npx tsc --noEmit"
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
    mutex: e2e-port    # 省略時なし。マシン全体で同名 mutex のゲートを同時に 1 つに制限（§9）
options:
  baseRef: origin/develop      # work-evidence / scope 判定の基準。省略時はリポジトリのデフォルトブランチの origin
  skipInPrimaryCheckout: true  # 省略時 true。メイン checkout（稼働サーバの cwd になり得る場所）ではコマンド系ゲートを skip
  maxLogTailBytes: 8192        # 省略時 8192
  requireCommit: false         # 省略時 false。true で work-evidence が commit を要求する（Issue #1628）
  requireEnvClean: false       # 省略時 false。true で組み込み env-clean ゲートがリポジトリ外の副作用を裁定する（Issue #1740）
```

---

## 2. フィールド仕様

### 2.1 トップレベル

| キー | 型 | 必須 | 既定 | 制約 |
|---|---|---|---|---|
| `version` | integer | ✅ | — | `1` のみ。他の値・欠落は設定エラー |
| `gates` | list | ✅ | — | 1 件以上。0 件は設定エラー |
| `options` | map | — | 全既定値 | 未知キーは設定エラー |

未知のトップレベルキーは設定エラー。v1 は閉じた集合として扱う。

### 2.2 `gates[]`

| キー | 型 | 必須 | 既定 | 制約 |
|---|---|---|---|---|
| `id` | string | ✅ | — | `^[a-z0-9][a-z0-9-]{0,31}$`。設定内で一意。予約 ID（`work-evidence` / `scope` / `env-clean`）は使用不可 |
| `command` | string | ✅ | — | 非空。`--cwd` を作業ディレクトリとして POSIX sh (`/bin/sh -c`) で実行される |
| `timeoutSec` | integer | — | `600` | `1..7200` |
| `mutex` | string | — | （無し） | `^[A-Za-z0-9_.-]+$`、64 文字以内。マシン全体のロック名（§9） |

`command` は **POSIX sh** で実行される。bash 固有構文（`[[ ]]` / 配列 / `function` キーワード）は
使わないこと。必要なら `bash -c "..."` と明示的に書く。

### 2.3 `options`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `baseRef` | string | `refs/remotes/origin/HEAD` の指す先 | `work-evidence` の比較基準。解決できない場合は設定エラー（`--base-ref` で明示する） |
| `skipInPrimaryCheckout` | boolean | `true` | プライマリ checkout ではコマンド系ゲートを skip する |
| `maxLogTailBytes` | integer | `8192` | 失敗ゲートのログを stderr に出す際の末尾バイト数。`0..1048576`。`0` で抑止 |
| `requireCommit` | boolean | `false` | `true` で `work-evidence` が「変更が在る」ではなく **「commit が在る」** を要求する。`commits=0 uncommitted=1` は failed（run は `not_started`）。実行契約の前文は「未 commit の作業は未完了とみなされる」と宣言するのに、ゲートは未 commit の変更 1 件で `passed` を返していた（Issue #1628 D-4）。既定を false に置いたのは、このゲートの本来の問いが「judge する work が在るか」だからで、リポジトリ単位の opt-in にしてある。**委任 1 件だけに要求したい場合は実行契約の `success.requireCommit`**（Issue #1642、[task-contract.md](./task-contract.md) §2.5）。両者は **OR** で合成し、契約が本オプションを緩めることはできない |
| `requireEnvClean` | boolean | `false` | `true` で組み込み `env-clean` ゲート（Issue #1740、[task-contract.md](./task-contract.md) §2.6）を既定ゲート集合に加える。`scope` がリポジトリ**内**の変更を裁定するのに対し、こちらは**外**（稼働中の CommandMate サーバのポート・`mcbd-*` tmux セッション・`$HOME` 直下・`~/.commandmate` 直下）を裁定する。**このフラグは判定だけでなく計測の有無も決める** — ベースラインのスナップショットは task 作成時（`POST /api/worktrees/:id/tasks` ＝ `send --contract`）に、**本フラグまたは契約の `success.requireEnvClean` が true のときにのみ**記録される。off の既定はファイルを 1 つも書かない。後から on にしても過去の task のベースラインは作れないため、そのランは **UNKNOWN**（gate `error` → run `failed`）になり、決して `passed` にはならない |

---

## 3. 実行モデル

### 3.1 順序

1. 設定の読み込みと検証。**1 つでも違反があれば `RESULT` を出さずに exit 2**
   （不正な設定が `passed` を出すのが最悪の失敗モードのため、best-effort 解釈はしない）。
2. 組み込みゲート `work-evidence`（`--skip-work-evidence` 指定時は SKIP）。
3. `skipInPrimaryCheckout` によるプライマリ checkout 判定。
4. `gates` を **定義順に逐次実行**。

### 3.2 途中で失敗しても止まらない

**あるゲートが失敗しても残りのゲートは実行し、全結果を報告する。** 1 回の実行で全指摘を
回収できることを優先する。定義順は打ち切りの制御ではなく、読みやすさのための並びである。

### 3.3 判定

| 条件 | RESULT | exit code |
|---|---|---|
| 実行したコマンド系ゲートが全て PASS | `passed` | 0 |
| 設定エラー（不正な verify.yaml / ファイル無し / git でない cwd / 未知の `--gates` id 等） | （出力しない） | 2 |
| 1 つ以上が FAIL または TIMEOUT | `failed` | 20 |
| `work-evidence` が FAIL | `not_started` | 21 |
| 実行したコマンド系ゲートが 0 件 | `skipped` | 22 |

Issue #1540 本文は「1 つでも failed/timeout/error → `failed`」としている。参照実装が持つ
ゲート状態は `PASS` / `FAIL` / `TIMEOUT` / `SKIP` の 4 つで、本文の *error* は独立した状態を
持たない（ランナーがゲートを起動できない事象は、ゲートの非ゼロ exit code か設定エラー
（exit 2）のいずれかとして必ず観測される）。判定への寄与は本文どおり「FAIL と TIMEOUT は
`failed`」である。

`skipped` (22) も本文には無い。本文の 3 値だけでは「`skipInPrimaryCheckout` により
コマンドを 1 つも実行しなかった実行」を表現できず、`passed` と報告すれば
**何も検証していない実行が緑になる**（本仕様が最も避けたい偽の緑）。`failed` も
`not_started` も事実と異なるため、専用の値を追加した。**`skipped` を `passed` と
同一視しないこと。**

### 3.4 出力フォーマット

stdout は 1 ゲート 1 行、最終行が判定。**stdout は機械可読を保ち、ログ末尾や診断は stderr に出す。**

```
GATE work-evidence PASS commits=3 uncommitted=2
GATE lint PASS exit=0 duration=12s
GATE unit FAIL exit=1 duration=45s
RESULT failed
```

| 行 | 形式 |
|---|---|
| コマンド系ゲート | `GATE <id> PASS\|FAIL exit=<code> duration=<n>s` |
| タイムアウト | `GATE <id> TIMEOUT exit=124 duration=<n>s` |
| skip | `GATE <id> SKIP reason=primary-checkout\|flag\|mutex-wait` |
| work-evidence | `GATE work-evidence PASS\|FAIL commits=<n> uncommitted=<n>` |
| 判定 | `RESULT passed\|failed\|not_started\|skipped` |

`--gates` で選択されなかったゲートは行を出さない（その実行の対象外であるため）。

**`mutex` を宣言したゲートは `waited=<n>s` を追加する**（Issue #1771、§9.3）。
`duration` に足さないことが規約である。

### 3.5 exit code は絶対にパイプで失わない

各ゲートは `sh -c "$cmd" > "$log" 2>&1` の形で実行し、`$?` を直接読む。
**出力を grep して合否を決めない。** `cmd | grep ...` は `$?` を grep のものにすり替え、
vitest が「全テスト緑」と表示しながら Unhandled Rejection で exit 1 する状況を
PASS と誤報告する（`.claude/skills/orchestrate-monitor/scripts/quality-gate.sh` と同じ規律）。

### 3.6 タイムアウト

macOS には `timeout(1)` が無い前提で実装する。参照実装は、ゲートを job control 有効
（`set -m`）でバックグラウンド起動して独立したプロセスグループに置き、監視サブシェルが
`timeoutSec` 経過後に **プロセスグループごと** SIGTERM → 猶予後 SIGKILL する。

プロセスグループ単位であることは必須である。直接の子だけを kill する実装では、
ゲートが起動した孫プロセス（`npm run` 配下の node 等）が生き残る（実測: 孤児 2 件）。

ただし **プロセスグループ ID を確認してから** signal を送ること。`kill -TERM -N` は
「ID が N のプロセスグループ」に signal を送るので、job control を有効化できず子が
独立したグループに入らなかった場合、N は単なる pid であり、たまたま同じ ID を持つ
**無関係なプロセスツリー**を巻き込む。参照実装は `ps -o pgid= -p <pid>` が pid と
一致することを確認してからグループ形式を使い、一致しなければ pid のみに送る。

### 3.7 タイムスタンプは実行を表す（Issue #1625）

`verification_gate_results` の `started_at` / `finished_at` は**ゲートの実行区間**であり、
行を書いた時刻ではない。不変条件は 1 つだけ:

```
finished_at - started_at === duration_ms   (ミリ秒単位で厳密に一致)
```

`duration_ms` は従来から正しく計測されているので、**打刻はその計測値そのものを書く**。
実装は 2 段構えである。

1. **行はゲート実行の前に開く。** `createGateResult` を spawn の前に呼ぶので、実行中は
   `status='running'` の行が観測でき、途中でプロセスが死んだときに**どのゲートで死んだか**が
   残る。#1543 の起動時 reconcile が持つ「開いたままの gate 行を error で閉じる」ループは、
   従来 create と finish が隣接していたため gate-runner 由来の行には**到達不能**だった。
2. **閉じるときに計測区間を明示的に書く。** 行を開いた時刻は「ゲートに入った」ことの仮置きで、
   実際の spawn はその数ミリ秒後になる。その差を報告区間に含めないため、`finishGateResult` は
   `executionWindow`（`startedAt` / `finishedAt`）を受け取り `started_at` を上書きする。

**実行しなかったゲート**（`skipped`、および config 読み込み失敗を run に載せる擬似ゲート
`config`）は、**判断した瞬間を指す長さ 0 の区間**（`started_at === finished_at`、
`duration_ms = 0`）とする。`started_at` は NOT NULL であり、`finished_at = NULL` は既に
「まだ閉じていない」を意味するので、NULL には「実行していない」を表現させない
（意図的な skip と孤児行が区別できなくなるほうが害が大きい）。この扱いなら上記の不変条件が
全ステータスで成立し、読む側は状態ごとの例外規則を持たなくてよい。

**過去の行は書き換えない。** #1625 以前の行は両方の打刻が実行後に打たれており復元不能だが、
UPDATE で辻褄を合わせるのは履歴の改竄である。代わりに読む側が判別できるよう、
`VerificationGateResult.timingsMeasured`（**導出値**。カラムではない）を返す。判定は上記の
不変条件そのもので、両方向に健全である — 修正後の行は構成上必ず真になり、修正前の行は
2 つの書き込みが隣接していたため区間が常に ~0 で、真になりうるのは `duration_ms` も 0 の
ときだけ＝記録時刻と実行時刻が同一の瞬間であるときだけである。`false` は
「この打刻を所要時間として読むな」を意味し、#1625 以前の行・実行中の行・再起動 reconcile で
閉じた行（終了時刻を誰も観測していない）を覆う。

`duration_ms` の計測方法は変えていない。**裁定（gate status / run status / exit code）は
timestamp を一切使っていない**ので、この変更で合否は動かない。

---

## 4. 組み込みゲート `work-evidence`

コマンド系ゲートより先に実行される、**そもそも作業が行われたか**の判定。

- PASS 条件: `merge-base(baseRef, HEAD)` から HEAD までのコミット数 > 0、
  **または** `git status --porcelain -z -uall` の非契約エントリ数 > 0
- 両方 0 → 実行全体を `not_started`（exit 21）とし、**コマンド系ゲートは 1 つも実行しない**

変更が 1 バイトも無いリポジトリでは lint も typecheck も当然通るので、このガードが無いと
「未起動のセッション」が「全ゲート PASS」として報告される。`--skip-work-evidence` で
明示的に無効化できる（その場合 `GATE work-evidence SKIP reason=flag` を出す）。

### 4.1 実行契約は作業証跡から除外する（Issue #1580 / #1651）

`.commandmate/tasks/` 配下は実行契約で、**オーケストレーターの証跡であってエージェントの
証跡ではない**。委任直後の worktree（契約ファイルが 1 件置かれただけの状態）が「作業済み」に
見えると exit 21 の検出が無意味になるため、**両実装とも両方のカウンタから除外する**。

| カウンタ | コマンド |
|---|---|
| commits | `git rev-list --count <base>..HEAD -- ':(top)' ':(exclude,top).commandmate/tasks/'` |
| uncommitted | `git status --porcelain -z --untracked-files=all` を**エントリ単位**で解析し、全パスが契約ファイルのエントリを数えない |

- `:(top)` を明示するのは、除外だけの pathspec にしないためと、両パターンを cwd ではなく
  リポジトリルートに固定するため。**契約だけを載せた setup commit は 1 コミット分の作業として
  数えない。** 副作用として、**ファイルを 1 つも変更しない commit（`--allow-empty`）も
  数えない**（pathspec 指定時の履歴単純化）
- `-z` / `-uall` は必須。人間向けフォーマットは空白を含むパスを C クォートし、rename を
  ` -> ` で連結し、既定の untracked モードは新規の `.commandmate/tasks/` を
  `?? .commandmate/` の 1 エントリに畳む — いずれもパスでないものを判定に渡す
- **エントリ内のいずれかのパスが契約ファイルでなければ**作業として数える。契約を実作業へ
  rename した場合（逆向きも）を取りこぼさないため
- **`.commandmate/verify.yaml` は除外しない。** 契約は送信時にスナップショットされるが
  verify.yaml は毎ラン読み直すため、ゲートを弱める改竄を検出できる状態を残す
- 参照実装（bash）は契約ファイルを**開かない**。パス名だけを見るので、§7 の
  「実行契約を読まない」は成立したままである

`options.requireCommit: true` のときは PASS 条件が **コミット数 > 0 のみ**になり、
未 commit の変更は作業証跡として数えない（§2.3 / §7.1）。ゲート行には
`requireCommit=true` が付く（false のときは付かないので、既定の出力は不変）。
`--skip-work-evidence` はゲートごと飛ばすので requireCommit も効かない
— このフラグはゲートを**弱める**のではなく**止める**ものである。

予約 ID `scope` は、スコープ逸脱・未達検証の組み込みゲート用に確保してあり、v1 では未実装。
ユーザー定義ゲートの ID としては使用できない。

---

## 5. プライマリ checkout での skip

`options.skipInPrimaryCheckout`（既定 `true`）が有効なとき、プライマリ checkout では
コマンド系ゲートを実行せず `RESULT skipped`（exit 22）とする。

プライマリ checkout は稼働中の開発サーバの cwd になっていることがあり、その足元で
build / test を回すと配信中のビルド成果物を壊す。判定は `git rev-parse --git-dir` と
`--git-common-dir` が同じディレクトリを指すか（linked worktree は前者が
`<common>/worktrees/<name>` になる）で行う。

両者は `pwd -P` で **実パスに正規化してから**比較する。macOS の `$TMPDIR` は
`/var -> /private/var` シンボリックリンク配下にあり、論理パスと実パスを比較すると
どの checkout も linked と判定され、このガードが黙って無効化される。

---

## 6. bash サブセット制約

Phase 0 の `verify-run.sh` は awk / sed でパースするため、YAML のサブセットのみを受け付ける。

| 規則 | 内容 |
|---|---|
| インデント | 2 スペース固定。タブは拒否。2 の倍数でない字下げは拒否 |
| 値 | 1 行スカラーのみ |
| アンカー / エイリアス | `&` `*` で始まる値は拒否 |
| 複数行文字列 | `|` `>`（`|-` 等の修飾つきを含む）は拒否 |
| フロースタイル | `[...]` `{...}` で始まる値は拒否 |
| コメント | 行頭（インデント可）の `#` のみ。行内コメントは値の一部として扱う |
| クォート | 値全体が `"..."` または `'...'` で囲まれていれば外側のクォートのみ除去 |
| キーと値の分割 | 行内の**最初のコロン**で分割。値の中のコロンはそのまま書ける |

**制約に反する verify.yaml は best-effort で解釈せず設定エラー（exit 2）として拒否する。**
一部を黙って読み飛ばすと「設定したつもりのゲートが走っていないのに `passed`」になる。

Phase 1 の製品ローダは一般的な YAML パーサを使うため上記より広い入力を受け付けうるが、
**この形式で書いておけば両方で読める**。製品ローダ側は、上記サブセットを満たす文書を
本仕様と同じ意味に解釈しなければならない。

---

## 7. CLI（Phase 0 参照実装）

```
verify-run.sh [--config <path>] [--cwd <worktree-path>] [--base-ref <ref>]
              [--gates id1,id2] [--skip-work-evidence]
```

| オプション | 既定 | 意味 |
|---|---|---|
| `--config` | `<cwd>/.commandmate/verify.yaml` | 設定ファイル |
| `--cwd` | カレントディレクトリ | ゲートを実行する worktree。git リポジトリでなければ設定エラー |
| `--base-ref` | `options.baseRef` → `origin/HEAD` | `options.baseRef` より優先 |
| `--gates` | 全ゲート | 実行するゲートの絞り込み（カンマ区切り）。**存在しない id は設定エラー**（黙って 0 件実行→`passed` を防ぐ） |
| `--skip-work-evidence` | 無効 | `work-evidence` を SKIP する |

### 7.1 `options.requireCommit` の適用範囲（Issue #1639）

Phase 0 参照実装は `options.requireCommit` に対応している（未対応だった時期は、
awk パーサの閉じたキー集合に引っかかって **exit 2 の設定エラー**になっていた。
黙って無視してはいなかったが、設定を書いたリポジトリでは bash 版が一切走らなかった）。
`true` のとき `commits=0` は FAIL で `RESULT not_started` / exit 21、ゲート行に
`requireCommit=true` が付き、理由は stderr に出る。

**参照実装は実行契約を読まない。** 実行契約の `success.requireCommit`
（[task-contract.md](./task-contract.md) §2.5 / Issue #1642）は製品実装だけが見る。
シェルから起動したランはどの委任にも紐付いていないため、スタンドアロンランナーが
見るのは `options.requireCommit` だけである。**両方のランナーで効かせたい要求は
verify.yaml に書く** — 2 実装が共に読む唯一のファイルだからである。

2 実装の一致は `tests/unit/skills/cmate-verify/require-commit-conformance.test.ts` が
同一の git サンドボックスに両方を当てて固定している。**Issue #1651 で既知の差分は 2 件とも
解消し、pin は「一致する」側へ書き換えた**:

| 旧・差分 | 解消 |
|---|---|
| 契約ファイルの除外（Issue #1580） | bash 版は `.commandmate/tasks/` を除外せず、契約ファイルだけが変更された worktree で判定が食い違っていた（bash が PASS、TS が not_started ＝ **bash が緩い向き**で requireCommit と同種の欠陥）。#1651 で §4.1 を移植し一致 |
| 未追跡ディレクトリの数え方 | TS は `-uall` でファイル単位、bash は既定の porcelain でディレクトリ 1 エントリ（**数字だけが違い判定は一致していた**）。#1651 が除外の解析に `-z -uall` を導入した副産物として一致 |

同テストは verdict だけでなく `commits=N uncommitted=N` を**数値として**突き合わせる。
2 件目は両方 > 0 のまま数字だけがズレる差分で、verdict の比較では見えないためである。

---

## 8. Phase 1 実装時の申し送り

- `version` は fail closed。`2` 以上・欠落・型不一致はすべて拒否し、best-effort parse はしない。
- 未知キー（トップレベル / gate / options）は拒否する。v1 は閉じた集合。
- 実行順・「失敗しても継続」・判定表（§3.3）・出力フォーマット（§3.4）は互換性の対象。
  RESULT 値と exit code は API とみなす。
- `work-evidence` / `scope` の予約は維持する。`scope` を実装するときは本書の §4 を更新する。
- タイムアウトはプロセスグループ単位で kill する（§3.6）。Node で実装する場合は
  `child_process.spawn(..., { detached: true })` ＋ `process.kill(-pid, ...)` が対応物。

---

## 9. 並列 worktree と共有資源（Issue #1771）

v1 のゲートはコマンドと timeout しか宣言できず、「このゲートはマシン上で同時に 1 つしか
走れない」（固定ポート・ローカル DB・エミュレータ等の共有資源）を表現できなかった。
並列 worktree で同じゲートが重なると後発が資源衝突で即 fail し、記録には
`GATE e2e FAIL exit=1` としか残らない — **変更の欠陥と環境の衝突が区別できない。**

実測（BorderFreeKidsMap、2026-08-19）: planner が 9 wave を計算したのに、e2e ゲートが
60303 番ポートを専有するため 16 回の直列 dispatch に手で開き直した。wave 化が一度も使われなかった。

対処は 2 段構えで、**優先されるのは 9.1 の env 注入**である。9.2 の `mutex` は偽の赤を
消すが検証は直列のままなので、資源を worktree ごとに分けられるならそちらを先に使う。

### 9.1 `CM_WORKTREE_INDEX` / `CM_WORKTREE_ID`（env 注入）

すべてのコマンド系ゲートは、以下の環境変数つきで実行される（組み込みゲートには無い —
どれも外部コマンドを起動しないため）。

| 変数 | 値 | 用途 |
|---|---|---|
| `CM_WORKTREE_ID` | worktree ID（`worktrees.id`） | コンテナ名・DB 名・ログディレクトリなど、数値で表せないもの |
| `CM_WORKTREE_INDEX` | `0..1023` の整数 | ポート等の数値資源。`E2E_PORT=$((60400+CM_WORKTREE_INDEX))` |

```yaml
gates:
  - id: e2e
    command: "sh -c 'E2E_PORT=$((60400+CM_WORKTREE_INDEX)) npm run test:e2e'"
    timeoutSec: 1800
```

これが**衝突そのものを無くす**唯一の手段であり、並列度を保てるのはこちらだけである。

**採番は CommandMate 由来ではない。** Issue #1771 本文は「サーバが worktree を採番している」
としていたが、実測ではしていない: `worktrees.id` はディレクトリ basename 由来の TEXT 主キー
（`src/lib/git/worktree-id.ts:73`）で、順序列も作成時刻も列に無く
（`src/lib/db/migrations/v01-v05-initial-schema.ts:104`）、唯一の並び順は
`updated_at DESC`（`src/lib/db/worktree-db.ts:113`）＝エージェントが発言するたびに入れ替わる。
そこで番号は**この機能が自分で払い出す**。満たすべき性質を代替案とともに明示する。

| 性質 | 実現方法 |
|---|---|
| 同じ worktree なら同じ番号 | 払い出しをディスクに永続化する（プロセス再起動・DB リセットを跨いで不変） |
| 同時に走る 2 worktree が同じ番号にならない | 枠の確保が `O_EXCL` のファイル作成＝アトミック。競合した側は必ず次の枠へ進む |

- **レジストリ**: `~/.commandmate/worktree-index/<n>` は、枠 `n` を保有する worktree ID を
  1 行で持つファイル。**両ランナーが従う規約**であり、standalone 側は
  `set -C; printf '%s\n' "$id" > "$root/$n"`（noclobber）で同じ意味を実装できる。
- 環境変数 `CM_VERIFY_WORKTREE_INDEX_ROOT` でルートを差し替えられる（テスト・隔離 CI 用）。
- **worktree を削除しても枠は解放しない。** 再利用すると、生きている worktree の番号が
  動き、削除された側のサーバがまだ握っているポートに載る可能性がある。
- **ハッシュは採用しなかった**（Issue 本文の代替案）。同じ番号になる性質は満たすが、
  30 worktree × 1024 枠で衝突確率は約 35% であり、衝突こそがこの機能で消したいものである。
  レジストリが**書けない**マシンだけ `sha256(worktreeId) mod 1024` にフォールバックする
  （変数が未設定だと `$((60400+CM_WORKTREE_INDEX))` が全 worktree で 60400 に潰れるため、
  値は必ず渡す）。

### 9.2 `mutex: <name>` — マシン全体のロック

資源を worktree ごとに分けられない場合に、同名 `mutex` を宣言したゲートを
**マシン全体で同時に 1 つ**に制限する。

```yaml
gates:
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
    mutex: e2e-port
```

**両ランナーが従う規約**（一致していなければ排他にならない。同じマシンで CommandMate の
runner と standalone runner が同じ資源に触れる）:

| 項目 | 規約 |
|---|---|
| パス | `~/.commandmate/locks/<name>.lock` |
| 方式 | **`mkdir` によるアトミックな作成**。macOS に `flock(1)` が無いため、移植可能な方式を採る |
| 保有者記録 | ロックディレクトリ内の `owner` ファイル。JSON `{"pid":N,"host":"…","token":"…","acquiredAt":ms}` |
| 待ち | ロックが空くまでポーリング（既定 250ms 間隔）。待ち時間の上限は**そのゲートの `timeoutSec`** |
| 解放 | `owner` の `token` が自分のものであるときだけディレクトリを削除する |
| 死んだ保有者 | `host` が自ホストと一致し、かつ `pid` が存在しない（`kill(pid,0)` が ESRCH）ときのみ、待つ側が奪ってよい。**他ホストの pid では判断しない**（共有 home で 2 台が同時実行しうる） |
| 名前 | `^[A-Za-z0-9_.-]+$` / 64 文字以内。ゲート ID ではなく**資源**の名前なので、別リポジトリのゲート同士が `port.60303` のような名前で排他し合ってよい |

環境変数 `CM_VERIFY_LOCK_ROOT` でルートを差し替えられる（テストは必ずこれを使うこと。
実 `~/.commandmate/locks` を使うテストは、並列 worktree の稼働中ランと排他して偽の赤を作る）。

`token` は必須である。これが無いと、pid が死んで見えたために奪われた側が、あとから解放した
ときに**次の保有者のロックを消す**（＝2 ランが同時に資源へ入る）。

### 9.3 待ち時間は duration と別に記録する

```
GATE e2e PASS exit=0 duration=190s waited=42s
```

- `duration` は**ゲート自身のコマンドが動いていた時間**。`waited` は**ロック待ちの時間**。
  混ぜると timeout の調整も advisor の入力も歪む。**`waited` を `duration` に足さないこと。**
- 待たなかった mutex ゲートも `waited=0s` を出す。「排他されていて待たなかった」と
  「mutex が無い」は別の事実であり、読む側が区別できる必要がある。
- `mutex` を宣言していないゲートの行は**従来どおり**（`waited=` は付かない）。
  この機能を使わないリポジトリの出力は 1 バイトも変わらない。

**CommandMate CLI の描画は括弧つきで、値の綴りだけが共通である**（実測: 製品 CLI は
`GATE lint PASS (exit=0, 12.3s)` 形式を #1544 から使っており、standalone runner の
空白区切りとは元から別物。`src/cli/utils/verify-runner.ts:145-150`）。
**契約はフィールド名 `waited` と単位 `s`、および「duration に足さない」ことであって、
区切り文字ではない。**

| ランナー | 綴り |
|---|---|
| standalone（`verify-run.sh`） | `GATE e2e PASS exit=0 duration=190s waited=42s` |
| CommandMate CLI | `GATE e2e PASS (exit=0, 190.0s, waited=42.3s)` |

製品実装には `verification_gate_results` に待ち時間の列が無いため、`log_tail` の先頭に
機械可読の 1 行 `[mutex] name=<name> waited=<n.n>s lock=<path>` を置き、CLI がそれを読んで
GATE 行に載せる（`work-evidence` の `commits=`/`uncommitted=` と scope ゲートの証跡が既に
使っている経路）。行頭アンカーで照合するので、ゲート自身の出力に `waited=` が現れても
拾わない。

### 9.4 ロックが取れないまま timeout に達したとき

**TIMEOUT ではない。** コマンドは 1 度も起動していないので「長く走った」は事実ではなく、
FAIL でもない — 資源衝突と変更の欠陥が同じ顔をするのを止めるのが本 Issue の目的である。

```
GATE e2e SKIP reason=mutex-wait waited=600s
```

- ゲートは `skipped`、`exit_code` は null。
- run 全体は `error`（`skipped` は `passed` を塞ぐ、§3.3 と同じ規律）＝ CLI の exit code は
  **99（判定不能）**であり、20（不合格）ではない。20 で分岐する呼び出し側は
  「ゲートが実際に work を裁定した」と信じてよい、という既存の約束を守る。

### 9.5 両ランナーが受理すべきキー集合（parity）

skills 側（`.claude/skills/cmate-verify` と `.agents/skills/cmate-verify`、および
commandmate-skills リポジトリの実装）は**この表を正として**追随する。

| 場所 | キー | CommandMate | standalone runner |
|---|---|---|---|
| `gates[]` | `id` / `command` / `timeoutSec` | ✅ | ✅ |
| `gates[]` | `mutex` | ✅ #1771 | **未移植**（skills #223） |
| `options` | `baseRef` / `skipInPrimaryCheckout` / `maxLogTailBytes` / `requireCommit` | ✅ | ✅ |
| `options` | `requireEnvClean` | ✅ #1740 | **未移植** |

**未移植のキーは「無視される」のではなく設定エラー（exit 2）になる。** 両実装とも v1 を
閉じた集合として扱うためで、`mutex:` を書いた verify.yaml は移植が済むまで standalone
runner では**一切走らない**。移植が完了するまで、両ランナーで回すリポジトリの
verify.yaml に `mutex:` を書かないこと。
