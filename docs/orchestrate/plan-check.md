# 共有状態・経路・重い検証の計画時の検査

本体の 1-3・1-4（依存関係）と 2-4（契約）から、共有状態の表・経路表と割込み表の書き方と、起動の前の検査 `scripts/orchestrate/plan-check.mjs` の使い方を置く（#3884）。
表を書くかどうかの条件は本体にある。

## 1-3 共通ファイルの取り直し

1-3 の共通ファイルは Issue 本文から見積もった仮のもの。マージの順を決める前に、全ワーカーのコミットの後で各 worktree の `git show --name-only --format= origin/develop..HEAD | grep -v '^$' | sort -u` を作り、`comm -12` で突き合わせ直す。作業の途中の `git status` では後から増えるファイルを取りこぼす。`git show --stat` は長いパスを `...` で切るので使わない。ルート直下のファイル（`CHANGELOG.md` など）を `grep '/'` で落とさない。衝突するかどうかは挿入の行番号から予測せず、`git merge` / `git rebase` の実際の結果で決める。衝突を解いたら、そのファイルのテストを単独で走らせる。

## 1-3 並列にするときの落とし穴

- ファイルが重ならなくても壊れる。同じ異常入力に別の層でガードを足す 2 本は、手前のガードが先に発火して奥のテストを空振りさせる。互いを「スコープ外」と書いた 2 本は、相手が直す挙動を現状のままテストで固定しやすい。計画の段で「同じ入力を別の層で扱う Issue」を探す
- 共通のユーティリティ（新しい共有ファイル）を並列のワーカーに作らせない。複数本が同じ名前の新規ファイルを作って衝突する。各ワーカーにはローカルに実装させ、共通化は後で 1 本の整理の Issue にする
- 同じファイルを触る Issue を続けて流すときは、先にマージした Issue で後の Issue の引用行番号がずれる。委任の前に引用箇所を grep で実測し直し、先にマージした兄弟の関数を「再利用する」と契約に書く
- 他の Issue の影響範囲の漏れを指摘するだけの Issue（独立したコード変更を持たない）は並列にせず、本体の Issue と同じワーカー・同じ PR に入れる
- 完了したワーカーの変更を `git diff origin/develop..HEAD`（2 点）で見ない。他の PR のマージで develop が進むと無関係なファイルが差分に出る。`git diff origin/develop...HEAD`（3 点）を使う

## 1-3 配線の持ち主を決める

- 並列の契約は「担当の外を触らない」ので、モジュール間の配線（`server.ts` の起動列・ヘッダへのマウント・呼び出し元）は全員が「後続 Issue の担当」と先送りしやすい。配線の担当を計画の段で 1 つに決める。決まらなければオーケストレーターの直列タスクにし、全 PR のマージ後に配線の PR を 1 本出す
- 「次の段が埋める」seam（`return null` だけの関数など）を置く契約では、埋める側の契約の `scope.allow` に seam のファイルを入れ、受入基準に「値が載る」テストを 1 本入れる。null を許すスキーマ検証だけでは両方緑のまま穴が残る
- ワーカーのコミットメッセージの「後続 Issue の担当」「port として提供」は未配線の自己申告として扱い、マージの時に配線の Issue を起票するか自分で配線する。完了の確認は docs/orchestrate/report.md の「8-1 届かないコードの確認」

## 1-4 共有状態の表を書く理由

2026-10-23〜24 の run（#3749〜#3839・#3880〜#3884）では、poller の tick と送信、prompt-push-gate の猶予、current-output の公開、wait の人待ちを、
別々の PR が「変更箇所が違うので弱依存」として同じ波で直した。取り込みの衝突（`runs/2026-10-23/summary-3749-3839.md`）と、
独立レビューでの await の順序・別経路の漏れ（#3821 の内部の同一性と公開キーの差、#3863 B のタイル／新規タスクの欠落）が続いた。
共通の関数の署名が同じでも、意味を変えれば他の PR の読者に届く。**ファイルの重なり（弱依存）と、同じ状態・不変条件の変更（強依存）を分ける**ために、
plan に「変更する共有状態・その書き手・公開値・読む経路・不変条件」を機械で読める形で残す。

## 1-4 同じ関数を触る item の弱依存と強依存

同じ関数を触る item でも、既存の制御フローへ小さく追記するもの（引数を 1 つ足す・成功の経路に呼び出しを 1 行足す）は弱依存で、3-way merge が意味を保ったまま解ける。その関数の制御フロー（早期 return・分岐の順）を書き換えるものは強依存で、先の item のマージを待ってから worktree を切る。
並列にすると、書き換え側は古い関数の形に対して実装し、マージで先の変更（呼び出し 1 行など、型に出ないもの）を黙って落とす。書き換え側の契約には「消してはいけない行・引数」を識別子で書き、挿入位置は Issue 本文ではなくマージ後の実物（`sed -n` で当該の分岐を出す）に合わせる。

## 1-4 既定値・寸法を変える Issue と並行する e2e

既定値（パネルを開くか・初期の選択）や寸法・レイアウトを変える Issue は、同じ画面の e2e を持つ並行の Issue の前提を壊す（ファイルが重ならなくても）。そういう Issue があるときは、並行する Issue の契約に「その既定に依存しない書き方（開いていなければ開く、寸法は定数から読む）」を最初から入れる。UI の Epic では各 PR を `--last` でマージし、最初のマージの後に残りの worktree へ develop を取り込ませて e2e 全体を 1 回流させる。

## 1-4 状態ファイルの書き方

置き場所は plan と同じ run のフォルダの `plan-$RUN_ISSUES.state.yaml`（JSON でもよい）。書くのは、**共有状態（複数の経路が読む値・記録・キー・寿命）を変える Issue／work item がある run** だけ。
無い run はファイルを作らない（`plan-check.mjs check` は `skipped` と出して exit 0 になり、今までどおり進む）。

```yaml
version: 1
# heavyGateLimit: 1        # 1 つの波で起動してよい「重いゲートを持つ item」の数（既定 1）
waves:                      # 同時に投入する組。順に投入する
  - { id: "1", items: ["3880-a1", "3882"] }
  - { id: "2", items: ["3880-a2"] }
items:                      # work item（同じ Issue の 2 本目は 1-5 の --item と同じ名前）
  - { id: "3880-a1", contract: contract-3880-a1.yaml }   # contract.mjs の設定。このファイルからの相対パス
  - { id: "3880-a2", contract: contract-3880-a2.yaml }
  - { id: "3882", gates: [lint, typecheck, unit-related] } # 設定が無いときは gates（既定 lint / typecheck / unit-related）
sharedState:
  - state: auto-yes-confirmation-key
    writers:                # 状態を書き換えるコードを変える item（code は file と関数名）
      - { item: "3880-a1", code: "src/lib/polling/auto-yes-decision-state.ts recordDecision" }
    published: ["autoYesConfirmationKey（current-output の応答）"]
    readers:                # 読む経路。route は契約の routes の列名（下の表）
      - { route: poller, code: "src/lib/polling/auto-yes-poller.ts tick" }
      - { route: current-output, code: "src/app/api/worktrees/[id]/current-output/route.ts" }
    invariant: "記録・比較・公開は同じキーを使い、await の後に古いキーで書かない"
```

- **1 つの状態は 1 行（1 レコード）に書く。** 同じ名前の `state` を 2 行に分けると `plan` で止まる（行ごとに判定すると、同じ波の書き手と読者の一覧が分かれて見えなくなるため）
- **状態の名前の照合**は、前後の空白の除去・Unicode の NFKC 正規化・内部の連続する空白を 1 つに畳む・大文字小文字を区別しない、の 4 つを行った名前で行う。`Auto-Yes Key` と `auto-yes  key`、全角の `ＡＵＴＯ` と `AUTO` は同じ状態（2 行に分けると `plan` で止まる）。`auto-yes-key` と `auto yes key` のように、空白以外の文字が違うものは別の状態
- **書き手が 2 つ以上の item にある状態は、書き手を別々の波に置く**（先行の 1 本に寄せ、読者側をその後に置く）。同じ波に置くと `shared-writer` で止まる
- 書き手の item は契約の設定に `routes` を書く。読む経路（`readers[].route`）のそれぞれに、テストを結び付けたセルが要る（無いと `routes-missing` / `routes-reader`）
- 重いゲート（`unit` / `integration` / `build` / `e2e`）を持つ item は、1 つの波に `heavyGateLimit` 本まで。`unit-related` は数えない（既定のゲートで、全 item が持つ）

## 1-4 全体実行に広がる item の順

（#4148。2026-11-04 の run で、並列の `unit-related` が全体実行に広がって順番待ちが 1〜3 時間になり、#4133 は mutex の 5400 秒で SKIP を 2 回出した。）

`unit-related` は、`src/` のコードと `tests/unit`・`tests/helpers` 以外のファイルが変わるとテスト全体に切り替わり、`cpu.heavy` で 1 本ずつになる（ci-merge.md#6-1-1-テスト全体と-unit-related-の分け方）。`docs/`・`.claude/`・`scripts/` の変更はどれも当たる。これを計画の段階で見分ける:

- `contract.mjs generate` は、scope が全体実行に広げうる契約に `contract: note: #<N>: unit-related runs the whole unit suite when a file under "<pattern>" changes` を stderr へ出す（状態ファイルが無い run でも出る）。判定は `run-related-unit-tests.mjs` の `classifyChanges` そのもの
- `plan-check.mjs check` は、1 つの波で `cpu.heavy` に並びうる item（`unit` / `integration` と、上の `unit-related`）が 2 本以上なら `plan-check: notice: cpu-heavy: wave <id>: …` を stdout へ出す（`--json` は `notices`）。契約の設定が無い item の `unit-related` は、scope が分からないので数えない

**出たら、plan にその item の順を書く**（波を分けるか、同じ波で先に検証へ入れる順を決める）。`unit-related` の 5400 秒は待ちと実行の両方の上限で、2026-11-04 の run では全体実行の 1 本に 2158 秒かかったので、前に 3 本並ぶと待ち切りうる。

止めない（exit は変わらない）のは、scope が「触ってよい範囲」で実際の差分ではなく、`docs/` を scope に持つ item の多くは同じ波で問題なく流れるから。`heavy-gates` の違反は今までどおり `unit-related` を数えない。

待ちと実行の上限を分ける案は採らなかった。mutex の待ちの上限は `timeoutSec` で、`src/lib/verification/gate-runner.ts` と `.commandmate/verify.yaml` の変更になる。待ち切った検証は `wait-verify.mjs` が並び直す（#3938）。

### 1-4 全体に広がる item は同じ波に 2 本まで

（#4192。2026-11-06 の run で、検証がテスト全体に広がる item が 4 本同じ波に重なり、2 本が mutex 待ち 5400 秒で SKIP、precheck が 2 回保留になった。）

- 上の `notice: cpu-heavy` / `note:` が出た item（`unit` / `integration` を持つ item を含む）は、**1 つの波に 2 本まで**にする。3 本目からは次の波に送る
- 2 本の中でも、検証に入れる順（先に入れる 1 本）を plan に書く。全体実行の 1 本が 2158 秒（2026-11-04）かかった実測では、3 本目は待ちだけで 5400 秒に届きうる
- 並べる数を上げるのは、全体実行の 1 本の実測が短くなったときだけ。`mutexWaitSec` の宣言（待ちの上限を別に持つ）は #4172 で扱う

## 2-4 経路表と割込み表の書き方

契約の設定（`contract.mjs` の YAML）に `routes` を足すと、goal の「Issue 本文」の後に「経路表と割込み表」の節が入る。**省略したときの goal は今までと 1 文字も変わらない。**
行は割込み、列は経路。セルはどれも、テストに結び付けるか、理由をつけて除外する（行・列ごとに除外してもよい）。テストが 1 つも無い表は生成が止まる。

| 列（経路） | 名前 | 行（割込み） | 名前 |
|---|---|---|---|
| poller | `poller` | 無効化 | `disable` |
| hook | `hook` | 手動回答 | `manual-answer` |
| prompt-response | `prompt-response` | 区間変更 | `interval-change` |
| current-output | `current-output` | 世代変更 | `generation-change` |
| WS | `ws` | 欠落 | `missing` |
| push | `push` | 旧形式 | `legacy` |
| wait | `wait` | | |
| 観測 | `observe` | | |
| PC | `pc` | | |
| スマホ／タイル | `mobile` | | |

```yaml
routes:
  order: ["記録 → await 送信 → 比較。await の後は呼び出しごとの文脈の値だけを使う"]   # 割込みの順序（変えないもの）
  exclude:
    columns: { push: "通知は確認画面のキーを読まない", ws: "WS は current-output と同じ値を流すだけ" }
    rows: { legacy: "旧形式の記録はこの状態を持たない" }
  cells:
    - { row: disable, column: poller, tests: ["tests/unit/polling/auto-yes-poller.test.ts > 無効化の後の tick は送らない"] }
    - { row: disable, column: hook, excluded: "hook は無効化を読まない" }
    # …残りのセルもすべて tests か excluded を書く
  # extraColumns: [tile]   # 足りない経路は列を足す（extraRows も同じ）
```

- テストは `tests/` の下のテストファイル（`<file> > <テスト名>` も可）。既存のテストでも、この契約で足すテストでもよい
- 除外の理由は「なぜこの経路はこの割込みを読まないか」を書く。「関係ない」だけにしない

## 2-4 起動の前の検査

3-1 の最初の送信の前に 1 回、波を組み替えたときにもう 1 回実行する。exit 1 なら送らない。

```bash
node scripts/orchestrate/plan-check.mjs check --plan "workspace/orchestration/runs/$DATE/plan-$RUN_ISSUES.state.yaml"
# → plan-check: ok (8 items)                    exit 0（状態ファイルが無い run は skipped で exit 0）
# → plan-check: shared-writer: …                 exit 1（1 行に 1 件）
```

| 規則 | 止まる条件 | 直し方 |
|---|---|---|
| `plan` | 状態ファイルの形の誤り（知らない item、どの波にも無い・2 つの波にある item、同じ名前の `state` が 2 行など） | ファイルを直す |
| `shared-writer` | 同じ共有状態の書き手が同じ波に 2 本以上 | 書き手を別の波へ（先行 1 本に寄せる） |
| `routes-missing` | 共有状態を書く item に契約の設定が無い・設定に `routes` が無い | 設定に `routes` を書く |
| `routes-contract` | 契約の設定が生成できない（表のセルの欠け・理由の無い除外を含む） | 出た項目を直す |
| `routes-reader` | 状態の読む経路が、書き手の表の列に無い・テストのセルが無い | 列を足す（`extraColumns`）かテストを結び付ける |
| `heavy-gates` | 1 つの波で重いゲートを持つ item が上限を超える | `unit-related` にするか、後の波へ |

終了コード: 0＝違反なし（状態ファイルが無いときも）／1＝違反あり／2＝引数の誤り。`--json` で `{ skipped, plan, items, violations }` を 1 行出す。

## 2-4-4 事前レビューと 5-2b に渡す一覧

事前レビュー（2-4-4）と整合性レビュー（5-2b）には、item ごとの「割込み順序と読者の一覧」を渡す。状態ファイルが無い run では渡さない（レビューの依頼文には「渡されていない」と入る）。

```bash
node scripts/orchestrate/plan-check.mjs routes --plan "workspace/orchestration/runs/$DATE/plan-$RUN_ISSUES.state.yaml" \
  --item <item> > "workspace/orchestration/runs/$DATE/routes-<item>.md"
```

`routes` も同じ検査を通す。違反がある plan では一覧を出さず、違反を `check` と同じ形で stderr に出して exit 1 になる。
出力は、その item が書く共有状態ごとの不変条件・書き手・公開値・読む経路と、契約の経路表・割込み表。
事前レビューでは半ページの文書の後に貼り、5-2b では `consistency-review.mjs … --routes routes-<item>.md` で渡す。
最後の独立レビュー（再レビュー）の雛形は、前回の指摘の判定に加えて、**修正した共通規則の全読者**を一覧と呼び出しの連鎖の両方で再確認させる。
再レビューの上限（自動は 3 回まで）と試行の期限は変えない。
