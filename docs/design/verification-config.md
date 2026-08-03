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
  - id: lint              # 必須。^[a-z0-9][a-z0-9-]{0,31}$ で一意。予約ID: work-evidence, scope
    command: "npm run lint"   # 必須。worktree の cwd で shell 実行される
    timeoutSec: 600       # 省略時 600。範囲 1..7200
  - id: typecheck
    command: "npx tsc --noEmit"
  - id: unit
    command: "npm run test:unit"
    timeoutSec: 1800
options:
  baseRef: origin/develop      # work-evidence / scope 判定の基準。省略時はリポジトリのデフォルトブランチの origin
  skipInPrimaryCheckout: true  # 省略時 true。メイン checkout（稼働サーバの cwd になり得る場所）ではコマンド系ゲートを skip
  maxLogTailBytes: 8192        # 省略時 8192
  requireCommit: false         # 省略時 false。true で work-evidence が commit を要求する（Issue #1628）
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
| `id` | string | ✅ | — | `^[a-z0-9][a-z0-9-]{0,31}$`。設定内で一意。予約 ID（`work-evidence` / `scope`）は使用不可 |
| `command` | string | ✅ | — | 非空。`--cwd` を作業ディレクトリとして POSIX sh (`/bin/sh -c`) で実行される |
| `timeoutSec` | integer | — | `600` | `1..7200` |

`command` は **POSIX sh** で実行される。bash 固有構文（`[[ ]]` / 配列 / `function` キーワード）は
使わないこと。必要なら `bash -c "..."` と明示的に書く。

### 2.3 `options`

| キー | 型 | 既定 | 意味 |
|---|---|---|---|
| `baseRef` | string | `refs/remotes/origin/HEAD` の指す先 | `work-evidence` の比較基準。解決できない場合は設定エラー（`--base-ref` で明示する） |
| `skipInPrimaryCheckout` | boolean | `true` | プライマリ checkout ではコマンド系ゲートを skip する |
| `maxLogTailBytes` | integer | `8192` | 失敗ゲートのログを stderr に出す際の末尾バイト数。`0..1048576`。`0` で抑止 |
| `requireCommit` | boolean | `false` | `true` で `work-evidence` が「変更が在る」ではなく **「commit が在る」** を要求する。`commits=0 uncommitted=1` は failed（run は `not_started`）。実行契約の前文は「未 commit の作業は未完了とみなされる」と宣言するのに、ゲートは未 commit の変更 1 件で `passed` を返していた（Issue #1628 D-4）。既定を false に置いたのは、このゲートの本来の問いが「judge する work が在るか」だからで、リポジトリ単位の opt-in にしてある。**委任 1 件だけに要求したい場合は実行契約の `success.requireCommit`**（Issue #1642、[task-contract.md](./task-contract.md) §2.5）。両者は **OR** で合成し、契約が本オプションを緩めることはできない |

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
| skip | `GATE <id> SKIP reason=primary-checkout\|flag` |
| work-evidence | `GATE work-evidence PASS\|FAIL commits=<n> uncommitted=<n>` |
| 判定 | `RESULT passed\|failed\|not_started\|skipped` |

`--gates` で選択されなかったゲートは行を出さない（その実行の対象外であるため）。

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
