# 共有状態・経路・重い検証の計画時の検査

本体の 1-3・1-4（依存関係）と 2-4（契約）から、共有状態の表・経路表と割込み表の書き方と、起動の前の検査 `scripts/orchestrate/plan-check.mjs` の使い方を置く（#3884）。
表を書くかどうかの条件は本体にある。

## 1-4 共有状態の表を書く理由

2026-10-23〜24 の run（#3749〜#3839・#3880〜#3884）では、poller の tick と送信、prompt-push-gate の猶予、current-output の公開、wait の人待ちを、
別々の PR が「変更箇所が違うので弱依存」として同じ波で直した。取り込みの衝突（`runs/2026-10-23/summary-3749-3839.md`）と、
独立レビューでの await の順序・別経路の漏れ（#3821 の内部の同一性と公開キーの差、#3863 B のタイル／新規タスクの欠落）が続いた。
共通の関数の署名が同じでも、意味を変えれば他の PR の読者に届く。**ファイルの重なり（弱依存）と、同じ状態・不変条件の変更（強依存）を分ける**ために、
plan に「変更する共有状態・その書き手・公開値・読む経路・不変条件」を機械で読める形で残す。

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

- **書き手が 2 つ以上の item にある状態は、書き手を別々の波に置く**（先行の 1 本に寄せ、読者側をその後に置く）。同じ波に置くと `shared-writer` で止まる
- 書き手の item は契約の設定に `routes` を書く。読む経路（`readers[].route`）のそれぞれに、テストを結び付けたセルが要る（無いと `routes-missing` / `routes-reader`）
- 重いゲート（`unit` / `integration` / `build` / `e2e`）を持つ item は、1 つの波に `heavyGateLimit` 本まで。`unit-related` は数えない（既定のゲートで、全 item が持つ）

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
| `plan` | 状態ファイルの形の誤り（知らない item、どの波にも無い・2 つの波にある item など） | ファイルを直す |
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

出力は、その item が書く共有状態ごとの不変条件・書き手・公開値・読む経路と、契約の経路表・割込み表。
事前レビューでは半ページの文書の後に貼り、5-2b では `consistency-review.mjs … --routes routes-<item>.md` で渡す。
最後の独立レビュー（再レビュー）の雛形は、前回の指摘の判定に加えて、**修正した共通規則の全読者**を一覧と呼び出しの連鎖の両方で再確認させる。
再レビューの上限（自動は 3 回まで）と試行の期限は変えない。
