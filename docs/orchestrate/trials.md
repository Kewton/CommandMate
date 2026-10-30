# 試行中の段の集計の手順

本体の 2-4-4・5-2b（期限つきの試行）から、対象の Issue でだけ使う進め方と記録の様式、期限の日にだけ使う集計の手順を移した（#3481）。対象かどうかの条件は本体にある。

## 2-4-4 期限の集計の手順

- **期限の集計の手順:** 1. 各 run の `consistency-review.md` を、事前レビューの有無で分けて合計する（総時間・再レビュー回数・独自の発見）
  2. 続ける・入れる・やめるの判断案を書く 3. Codex のレビューを受ける 4. 利用者に伺う

## 2-4-4 事前レビューの書き方と記録

- **書くもの（半ページ）:** 「何が・いつ・どの経路で起きるか」。入力の取り方、状態の寿命と消える条件、同じ値を読む他の経路、画面に出る条件。
  **事実と見立てを分け、参照したコード（file:line）と未確認の事項を必ず書く**
- **入力に添えるもの（#3884）:** run に状態ファイルがあれば、`plan-check.mjs routes --item <item>` の出力（割込みの順序、書く共有状態ごとの不変条件・書き手・公開値・読む経路、契約の経路表と割込み表）を文書の後に貼る。
  依頼には「一覧に無い読者・順序の穴も挙げてほしい」と足す。書き方は docs/orchestrate/plan-check.md#2-4-4-事前レビューと-5-2b-に渡す一覧
- **Codex への依頼の形:** `--agent codex` に 1 本ずつ（セッションは直列）。半ページの文書を渡し、「設計の穴（寿命・経路・競合・他の読み手）を、
  守るべき条件・全経路・対照のテストの形で挙げてほしい」と頼む。コードの書き方の指摘は求めない
- **指摘の契約への入れ方:** 指摘を契約の goal に「守るべき条件」「全経路の一覧」「対照のテスト（陽性・陰性）」として書き、
  scope と受入基準を直す。採らない指摘は理由を plan.md に残す

- **記録（総時間と再レビューの回数の比較）:** 5-2b と同じ run のフォルダの `consistency-review.md` の表に「事前レビューの有無」の列を足して記録する（新しい表は作らない）。
  事前レビューの待ち時間を含む 1 本あたりの総時間と、5-2b の再レビューの回数を、有無で比べる

## 5-2b 2026-10-20 の集計の手順

**2026-10-20 の集計の手順。**

1. 各 run の `consistency-review.md` の表を合計する（独自の発見を 動作／説明／テスト × 新規／既存 で数え、1 本あたりの総時間を出す）
2. 続ける・入れる・やめるの判断案を書く
3. 判断案について Codex のレビューを受ける
4. 利用者に伺う（#3308 と同じ流れ）

前の記録（`runs/2026-10-05/consistency-review-trial.md`）を基準線として参照する。

## 5-2b 整合性レビューの進め方と記録

- **Codex のセッション:** 1 つを直列で使う。依頼は 1 本ずつ（ロック）。待ち時間を記録する
- **依頼の手順:** run ごとに `review-<N>.sh` を手で写さず、`scripts/orchestrate/consistency-review.mjs` を 1 回呼ぶ（#3528）。
  `--brief` には、その Issue の変更の種類と特に見たいこと（数行）だけを書く。状態ファイルがある run は `--routes <plan-check.mjs routes の出力>` を足すと、依頼文に「割込み順序と読者の一覧」が入る（無いときは「渡されていない」と入る。#3884）。依頼文の残り（目的・対象・手順・出力の形・触ってはいけないもの・`DONE:` の締め方）は
  雛形 `scripts/orchestrate/templates/consistency-review.md` から作られ、再レビュー（`--rereview --previous <前回の review-<N>.md>`）は
  `consistency-review-rereview.md` が前回の指摘ごとの判定を先に書かせる

```bash
node scripts/orchestrate/consistency-review.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --issue <N> --head <sha> --brief "workspace/orchestration/runs/$DATE/brief-review-<N>.txt"
# 再レビュー: … --rereview --previous "workspace/orchestration/runs/$DATE/review-<N>.md"
```

  スクリプトが行うこと: worktree（既定 `../commandmate-issue-<N>`、`--item` を付けると `../commandmate-issue-<N>-<item>`、`--worktree` で指定）の HEAD が `--head` と同じかを確かめる → Codex のロック
  （`workspace/proposals/<date>/.lock` を mkdir で取る。ほかの Codex への依頼と共有。中の `owner.json` に持ち主の pid・host・開始時刻を書く。
  持ち主が既に居ない（kill されたレビューが残した）ロックは外して取り（外すのは `<lock>.reclaim` を mkdir で取った待機者 1 人だけで、持ち主を読み直して同じ死んだ持ち主のときだけ動かす。別の待機者が取った新しいロックは動かさない。`.reclaim` を残して kill された場合は消すよう告げて止まる）、生きている持ち主のロックは 1 分ごとに stderr へ `lock … held by pid …` を出して待つ。
  待ちの上限は ask の上限＋600 秒（3000 秒）で、超えたら `review=fail`。`owner.json` の無いロックは持ち主を判断できないので待つ（#3633））→ `capture --instance codex --json` の `sessionStatus` が
  ready を 3 回続けて読むまで待つ（**止まっている instance は起動してから待つ**: 最初の読みが `isRunning: false`／`sessionStatusReason: session_not_running` で `startingSince` が無いなら、
  作業を頼まない短い起動の文（`START_MESSAGE`。launch-worker の `INIT_MESSAGE` と同じ趣旨）を `send <wt> <文> --instance <id>` で 1 回だけ送り、
  出力を `review-<N>.start.out` / `.start.err` に残してから、短い上限（30 回）で ready を待つ。起動の send が失敗したら依頼は送らず `review=fail`（note に send の exit code）。
  動いている instance（`running` など）と、`startingSince` がある起動中の instance（pane を作る前の起動中も `isRunning: false` を返す）は今までどおり待つだけで、起動の文は送らない。#3936）→ `ask <wt> <依頼文> --instance codex --timeout 2400 --json` → 返答の本文（行頭の `> **Thinking (` より前。
  本文が `> **Thinking**` を引用していても切れない）を `review-<N>.md` に保存（2 回目からは `review-<N>b.md`・`c`…。依頼文・JSON・stderr も同じ名前で残す）→
  どう終わったら run の記録・記録の様式の表への 1 行・残るファイル・exit がどうなるかは、下の「5-2b 終了コードと記録の条件表」が正（#3984）。`review=ok`・表に 1 行・exit 0 は `ok` の行だけで、**`DONE:` 行があっても exit 1 になる行がある**（`overlapped`。`dependency-links`・`upstream-fault` は `.md` も残らない）。
  **ask の exit 11（上流のエラー）は他の失敗と分けて記録する**（条件表の `upstream-fault`。#3936）: 相手の画面に上流のエラー（codex の `Selected model is at capacity`＝`id=model-capacity` など、
  `src/lib/detection/upstream-faults.ts` の一覧）が出て、ターンが答えないまま終わった。note は `upstream fault id=<id> (…) on <instance>; ask exit=11, not a verdict — …`（`model-capacity` は `switch --instance`、ほかは `retry later or switch --instance, by the id`）。
  **`id=model-capacity` は同じモデルでは答えない**ので、この note を見たら下の `--instance codex-2` へ切り替えて依頼し直す（スクリプトは自動では切り替えない。ロックと記録の agent が変わるため人が決める）。
  ほかの id は一覧の `selfRetrying` で読む: `overloaded`／`retrying` は `selfRetrying: true`（相手が自分で再試行し、待てば答える）なので、時間をおいて同じ instance へ依頼し直してよい。`context-limit` は同じセッションでは通らない（新しいセッションか別 instance へ）。
  レビューの相手を変えるとき（上の `id=model-capacity` の note が出たとき、Codex の `stream disconnected` が続くときなど）は `--instance codex-2` を足す（既定 `codex`）。capture・ask・記録の agent・ロック（`.lock-<id>`）が同じ値になる（alias も渡せる。サーバーの resolve-target で実 ID に直し、解決できなければ exit 2）ので、`--cli` のラッパーは要らない（#3618）。
  ID への解決は capture・ask と同じ `--cli`（`reply <wt> --instance <指定> --json` の `instanceId`）を通すので、`.env`・`CM_BIND`・HTTPS で決まる接続先も同じになる。
  受け付ける `--instance` は CLI・サーバーと同じ条件（instance id か、制御文字を含まない 50 文字以内の alias。`/` を含む alias も可）で、ロック名には解決後の ID を使う（#3633）。
  表の「独自の発見」から「事前レビューの有無」までの列は `未` で入るので、返答を読んで埋める
  **依存への書き込みを裁定に使わない**（#3883 P6）: ask の前後で、対象の worktree と `git worktree list` の全 worktree の `node_modules` 直下（`@scope/` の下も）の
  リンクを読む（`scripts/orchestrate/dependency-links.mjs`）。実体のパスが自分の worktree（と自分の `node_modules` の実体）の外を指すリンクが増えた・向き先が変わったら、
  条件表の `dependency-links` の行で終わる（返答は `review-<N>.json` の中だけ。note は `not a verdict — … dependency link(s) outside their worktree appeared during the review`）。
  stderr に増えたリンクを 1 行ずつ出すので、人が確かめてから外す（スクリプトは消さない）。前から在ったリンクは数えない。雛形も、依存に書かない・
  実験は `mktemp -d` の隔離コピーの中だけで行い他の worktree の `node_modules` にリンクを作らない、と依頼する
  **overlapped は裁定に使わない**（#3957）: `ask --json` が `"overlapped": true` を返した返答（相手のターンに別の依頼が入った。#3955）は、別の依頼への返答かもしれないので、`DONE:` 行があっても条件表の `overlapped` の行で終わる。
  同じ `--instance` に重ねず、1 本ずつ送り直す（ほかの依頼が終わってから、同じ呼び出しをもう一度。`review-<N>.md` は読むために残る）
- **数え方（期限の集計で使う）:** 延べではなく、重複・既報（ワーカーが報告済み・5-3 で処置できた）を除いた「レビューの独自の発見」を、**動作／説明／テスト** と **新規／既存** の 2 軸で数える。指摘の正しさは、一部を別の判定者（Codex と Claude の相互）で再判定する。費用は 1 本あたり、待ち時間・再指示・修正を含めた総時間で測る。後の段（CI・ガード・実機・UAT）で見つかった漏れも記録する

**記録の様式。** 置き場所は `workspace/orchestration/runs/<date>/consistency-review.md`。1 レビュー 1 行の表にする。

```
| # | Issue | 担当 | 依頼した HEAD | 時間（待ちを含む） | 指摘 | 独自の発見（重複・既報を除く） | 種類（動作／説明／テスト） | 新規／既存 | 再判定 | 処置 | 事前レビューの有無 |
```

**再指示の書き方（#3397 で前回の指摘の一部の未対応が続いた）。** 整合性レビューの指摘で再指示するときは、指摘の文をそのまま貼らず、
**守るべき条件・全経路・対照のテストに言い換えて**契約に書く。守るべき条件は 1 文で、全経路は直す場所の一覧で、対照のテストは陽性と陰性の組で示す。

**再レビューでは、前回の指摘が解消したかを先に確かめる。** 新しい指摘を探す前に、前回の指摘を 1 件ずつ「解消／一部未対応／未対応」に判定して記録する。
続けて、**前回の指摘への修正で変わった共通の規則（共有状態・関数・定数・型）の全読者**を、一覧と呼び出しの連鎖の両方で再確認させる（雛形 `consistency-review-rereview.md` の (0b)。#3884）。再レビューの上限（自動は 3 回まで）は変えない。

### 5-2b 終了コードと記録の条件表

`scripts/orchestrate/consistency-review.mjs` の `OUTCOMES` の写し（#3984）。写しはここ 1 か所だけで、テストが行・列ごとに `OUTCOMES` と照合する（script のヘッダ・orchestrate.md 5-2b・module-reference はここを指す）。
上から順に判定し、最初に当てはまった行で終わる。「記録」は run の記録の `review` 段、「表に行」は `consistency-review.md`（上の記録の様式）への追記、「残るファイル」は run のディレクトリの `review-<N>…`
（`.prompt.txt` 依頼文・`.json` ask の stdout（返答の全文）・`.err` ask の stderr・`.md` 返答の本文）。起動の文を送ったとき（#3936）は、その後のどの行でも `.start.out`・`.start.err` が加わる。
表に無い例外（書き込みの失敗など）は `exception` と同じく `fail`・行なし・exit 1 で、ファイルはその時点までに書いたもの。

| 条件 | id | 記録（`review`） | 表に行 | exit | 残るファイル |
|---|---|---|---|---|---|
| 引数の誤り（`--instance` を解決できないときも）。何も送らない | `usage` | なし | なし | 2 | なし |
| worktree の HEAD が `--head` と違う・git が失敗（ラベルを取る前） | `head-mismatch` | fail | なし | 1 | なし |
| ロックを待ち切った（ラベルを取った後の例外） | `exception` | fail | なし | 1 | `.prompt.txt` |
| 止まっていた相手の起動の send が失敗（依頼は送らない） | `start-failed` | fail | なし | 1 | `.prompt.txt` `.start.out` `.start.err` |
| ready を 3 回続けて読めない（依頼は送らない） | `not-ready` | fail | なし | 1 | `.prompt.txt` |
| ask の間に worktree の外を指す依存のリンクが増えた | `dependency-links` | fail | なし | 1 | `.prompt.txt` `.json` `.err` |
| ask の exit 11（上流のエラー） | `upstream-fault` | fail | なし | 1 | `.prompt.txt` `.json` `.err` |
| ask のその他の非 0 | `ask-failed` | fail | なし | 1 | `.prompt.txt` `.json` `.err` |
| `ask --json` に `reply` の文字列が無い | `no-reply` | fail | なし | 1 | `.prompt.txt` `.json` `.err` |
| 返答の本文に `DONE:` 行が無い | `no-done` | fail | なし | 1 | `.prompt.txt` `.json` `.err` `.md` |
| `"overlapped": true`（`DONE:` 行があっても。1 本ずつ送り直す） | `overlapped` | fail | なし | 1 | `.prompt.txt` `.json` `.err` `.md` |
| 上のどれでもない（裁定） | `ok` | ok | 1 行 | 0 | `.prompt.txt` `.json` `.err` `.md` |
