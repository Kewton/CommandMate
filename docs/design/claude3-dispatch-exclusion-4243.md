# Issue #4243 設計: claude-3 への送信の排他（PM のブリーフと毎朝の dispatch）

開発リーダー `claude-3`（worktree `mycodebranchdesk`）は、PM のブリーフと agent-health の自動依頼（毎朝 08:30 の dispatch）の両方を受ける（#4239 / PR #4240）。
両者の送信の間に排他が無い。この文書は排他の仕組みを決める設計の段で、コードは変えない。実装は Codex の事前レビューの後、同じブランチの別の契約で行う。

表記: **事実** = このブランチ（`bbfadb387`）のファイルで確かめたこと。**見立て** = 事実からの推論。**未確認** = 実機で確かめていないこと。
行番号は `bbfadb387` のもの（Issue 本文の `533022af1` と、dispatch-main.ts の `:202` `:251` は一致した）。

---

## 1. 今の動き（事実）

### 1.1 dispatch（`scripts/agent-health/dispatch-main.ts`）

| 行 | 内容 |
|---|---|
| `dispatch-main.ts:144-146` | 状態ディレクトリ `stateDir` = `--state-dir` → `$AGENT_HEALTH_DIR` → `~/.commandmate/agent-health`。記録は `dispatch/<JST 日付>.json`（`dispatch-record.ts` の `dispatchRecordPath`） |
| `dispatch-main.ts:160-167` | `fail()`: 送らなかったときは `status: 'skipped-busy'`・選んだ Issue を全部 `deferred`・`reason` を付けて記録し exit 2 |
| `dispatch-main.ts:169-175` | 当日に `sent` の記録があれば再依頼しない（`skipped-busy` の記録は再実行を止めない） |
| `dispatch-main.ts:196-198` | 対象 0 件は `no-target` で終わる（`claude-3` を見ない） |
| `dispatch-main.ts:201-202` | `commandmate ls --json` を **一時点で** 読み `judgeAgentState()` で判定 |
| `dispatch-main.ts:204-216` | `busy` なら `skipped-busy`（理由 `Claude 3 が<detail>`）・全件持ち越し・**exit 0** |
| `dispatch-main.ts:231-235` | 条件ファイルを書く（状態確認と `/clear` の間の処理） |
| `dispatch-main.ts:238-247` | `send()`: `commandmate send`、exit 99 なら 120 秒後に 1 回だけ再送（`COLD_START_RETRY_MS`） |
| `dispatch-main.ts:251` | **`/clear` を送る**。予約・ロックは見ない |
| `dispatch-main.ts:253-260` | 5 秒ごとに状態を見て `ready` を待つ（90 秒まで） |
| `dispatch-main.ts:261` | 依頼（1 行の `/orchestrate …`）を `--auto-yes --duration 8h` つきで送る |
| `dispatch-main.ts:266-275` | ラベル `auto-dispatched` とコメント |
| `dispatch-main.ts:74-82` | `exec` は `spawnSync`、1 コマンドの `timeout` は 300 秒 |

### 1.2 純粋関数（`src/lib/agent-health/dispatch.ts`）

| 行 | 内容 |
|---|---|
| `dispatch.ts:19-22` | 送り先は定数 `DISPATCH_WORKTREE_ID='mycodebranchdesk'`・`DISPATCH_INSTANCE_ID='claude-3'`・cliTool `claude` |
| `dispatch.ts:20` | コメントに「Claude 3 — dedicated to this hand-off, so it may be `/clear`ed first」。#4239 で専用ではなくなった（見立て: このコメントは実装の契約で直す対象） |
| `dispatch.ts:161-168` | `AgentState` = `ready` / `not-running` / `busy` / `unknown` |
| `dispatch.ts:182-211` | `judgeAgentState()`: `sessionStatusByInstance['claude-3']` の `isRunning` / `isWaitingForResponse` / `isProcessing` だけを見る |
| `dispatch.ts:217-226` | `sendArgv()`: 送り先は定数のみ |
| `dispatch.ts:46` | `DISPATCH_AUTO_YES_DURATION = '8h'` |
| `dispatch.ts:330-340` | `DISPATCH_USAGE`（exit 0 = sent / skipped-busy / no-target） |
| `dispatch-record.ts:13` | `DISPATCH_STATUSES = ['sent', 'skipped-busy', 'no-target']` |

### 1.3 PM の送り方

| 場所 | 内容 |
|---|---|
| `docs/orchestrate/team.md:13,16` | `claude-3` は開発リーダーで、08:30 の dispatch の送り先も兼ねる |
| `docs/orchestrate/team.md:27-34` | PM → 開発リーダーのブリーフの 4 点。送る手段は書かれていない（見立て: `commandmate send mycodebranchdesk "<ブリーフ>" --instance claude-3`。CLAUDE.md の「送り先」規則と同じ） |
| `docs/orchestrate/team.md:36-44` | 重なったときは**手順だけ**: PM は送る前に `claude-3` が手すきで 08:20〜09:00 でないことを確かめる。「仕組みとしての排他は未対応（追跡）」 |
| `docs/user-guide/agent-health.md:591-594` | 同じ手順の写し（dispatch 側の説明） |
| `docs/user-guide/agent-health.md:595-596` | 送信の手順（`/clear` → 90 秒待ち → 依頼） |
| `docs/agent-health/dispatch-prompt.md` 手順 1-3 | Schedule の AI が読む依頼文。dispatch の段取りを列挙している（実装で写しとして直す） |

`commandmate send`（`src/cli/commands/send.ts`）に送り先インスタンスの予約・ロックは無い（`grep -niE 'reserv|lock'` の該当は、relay の予約 `send.ts:1063`（#3957）とオプション説明のコメントだけ）。

### 1.4 既存のロック（`src/lib/agent-health/run-lock.ts`）

- `mkdir` の原子性で 1 者だけが取る。`owner` に `pid=` `started_at=` `label=` `token=`。持ち主の pid が死んでいれば rename で退けて取り直す（`run-lock.ts:106-137`）
- 置き場所は `$CM_RUN_LOCK_DIR` か `<os.tmpdir()>/commandmate-run.lock`（`run-lock.ts:56-60`）。UAT（`scripts/uat/run-lock.sh`）・`daily.sh`・`run.ts`（`scripts/agent-health/main.ts:226`）が**共有**する
- 期限は無く、生死は pid だけで決まる

### 1.5 問題の窓（事実からの見立て）

1. `:202`（状態確認）→ `:231`（条件ファイル）→ `:251`（`/clear`）の間に PM のブリーフが届くと、`/clear` がそれを消す
2. PM の run の途中で `claude-3` が入力待ち（例: PM の返事待ち・承認待ち）に戻った時点に 08:30 が来ると、`judgeAgentState` は `ready` と読み、`/clear` で PM の run の文脈を消して別の run を始める
3. dispatch が依頼を送った後は `claude-3` は `busy` が続くので、PM が手順どおり状態を見れば重ならない。ただし手順なので守られる保証は無い

---

## 2. 仕組みの候補と選択

| 候補 | 中身 | 長所 | 短所 |
|---|---|---|---|
| **A. 予約ディレクトリ（新設）** | `<stateDir>/claude3.reservation/` を `mkdir` で原子的に作り、`owner.json` に持ち主・期限を書く。PM は小さなスクリプトで取る・延ばす・外す。dispatch も送る窓の間だけ同じ予約を取る | dispatch がすでに使う `stateDir` に置けるので、PM と dispatch が同じ場所を解決する。期限を持てる。run-lock と同じ実証済みの `mkdir`/rename の型。サーバーにも DB にも触らない | PM が予約せずに素の `commandmate send` を打つことは止められない（手順で補う） |
| B. CommandMate の DB に行を足す | SQLite に予約の表を足し、API と `commandmate` の CLI から取る | `commandmate send` 自体に組み込める | migration が要る（本番 DB を上げる事故の前例あり）。サーバーの再ビルドが要る。リポジトリ内部の開発手順のために製品の表と API を増やす |
| C. 既存の run-lock を再利用 | `acquireRunLock({ label: 'claude3-pm' })` をそのまま使う | 新しいコードが少ない | UAT・日次確認と**同じ 1 本**のロックなので、PM の run の数時間、UAT と 07:00 の日次確認が全部止まる。生死が pid だけで、PM が「予約して終わる」スクリプトの pid はすぐ消えるので予約として持続しない。期限が無い |

**A を選ぶ。** 理由: C は意味の違うロックを共有して関係の無い処理を止め、pid の寿命が予約の寿命と合わない。B は効き目は最も強いが、内部の手順のために migration と製品の API を増やし、本番 DB の事故の型に入る。A は dispatch がすでに読む `stateDir` だけで閉じ、期限を持てる。

A の残る穴（PM が予約を飛ばして素の `send` を打つ）は、PM 用の送信口 `send` サブコマンド（下記）を手順の正にすることで狭める。製品の `commandmate send` には手を入れない（他の利用者に関係の無い制約を足すため）。

### 2.1 置き場所

- `<stateDir>/claude3.reservation/`。`stateDir` は dispatch と同じ解決（`--state-dir` → `$AGENT_HEALTH_DIR` → `~/.commandmate/agent-health`）。解決の関数は dispatch-main.ts:144-145 から切り出して共有し、二つの写しを作らない
- run-lock が `~/.commandmate` を避けた理由（テストがそこで動く）は、dispatch の記録が同じ場所にある以上ここでも同じ扱いとし、テストは必ず `--state-dir` に `os.tmpdir()` の一時ディレクトリを渡す
- **未確認**: PM のセッション（tmux はサーバーの環境を継ぐ）と Schedule の実行環境で `$AGENT_HEALTH_DIR` が同じか。対策として、予約のスクリプトの `status` と dispatch の出力に、解決したディレクトリの絶対パスを必ず出す

### 2.2 中身（`owner.json`）

```json
{
  "schemaVersion": 1,
  "holder": "pm",
  "label": "#4243 #4244",
  "token": "pm-12345-ab12cd34",
  "pid": 12345,
  "reservedAt": "2026-11-08T07:00:00.000Z",
  "expiresAt": "2026-11-08T15:00:00.000Z"
}
```

- `holder` は `pm` か `dispatch` の 2 値。`pid` は `dispatch` のときだけ生死の判定に使う（PM のスクリプトはすぐ終わるので記録用）
- 書き方は run-lock と同じ: `mkdir`（EEXIST なら持ち主を読む）→ `owner.json.tmp.<pid>` に書いて rename。持ち主ファイルの無いディレクトリは 60 秒までは作成中とみなす
- 古い予約を外すときは rename で退けてから消す（run-lock.ts:117-137 の型。二者が同時に「古い」と判断しても一者だけが取る）

### 2.3 PM が手で予約する口

新規スクリプト `npx tsx scripts/agent-health/claude3-reserve.ts <sub>`（入口は `dispatch.ts` と同じく `-main.ts` を動的 import する形）:

| サブコマンド | 動き | exit |
|---|---|---|
| `reserve --label "<Issue 番号など>" [--hours <1-24>]` | 予約が無い（または古い）かつ `claude-3` が `ready` / `not-running` なら、`holder: pm` で取る。既定 8 時間 | 0 取った / 3 別の持ち主（dispatch か、期限内の PM）/ 4 `claude-3` が busy / 2 引数・I/O の誤り |
| `reserve --renew [--hours <n>]` | PM の予約の期限を今から n 時間に延ばす（`token` は変えない） | 0 / 3 PM の予約が無い |
| `send "<本文>"` | PM の予約が期限内に在るときだけ `commandmate send mycodebranchdesk "<本文>" --instance claude-3` を実行する（送り先は定数、`dispatch.ts` の `DISPATCH_*` を使う）。本文を送るのは予約の確認の後だけ | `commandmate send` の exit を返す / 3 PM の予約が無い・dispatch が持っている |
| `release` | `holder: pm` の予約を外す。`dispatch` の予約は外さない | 0 外した・もともと無い / 3 dispatch が持っている |
| `status [--json]` | 予約の有無・持ち主・期限・解決したディレクトリを出す | 0 |

- PM の手順: ブリーフの前に `reserve` → ブリーフも途中の返事も `send` で送る → 開発リーダーの `DONE:` を読んだら `release`。run が 8 時間を超えそうなら `reserve --renew`
- `reserve` が `claude-3` の busy を見る理由: dispatch の run は `/clear` の後に送られて長く走るが、dispatch は送った後に予約を持ち続けない（下記 3.2）。dispatch の run の最中であることは `claude-3` の busy で分かる（見立て: orchestrate はコマンドを前面で回すので run の間はほぼ busy。途中で入力待ちに戻る瞬間があれば重なりうる。残る穴として 7 章に書く）

---

## 3. 予約の寿命

### 3.1 PM の予約

- **期限の既定値: 8 時間**（`--hours` で 1〜24、1 時間刻み）。理由: dispatch の Auto-Yes（`DISPATCH_AUTO_YES_DURATION='8h'`）と、利用者が出す自走の許可の単位に合わせる。長い run は `--renew` で延ばす
- **期限切れ**: 予約は無いものとして扱う。次に取る者（dispatch か PM）が退けて取り、退けたことを出力と記録の `reason` に残す（`期限切れの予約を外した（<label>、<expiresAt>）`）
- **PM のセッションの終了・再起動**: 予約は**自動では外さない**。理由: PM が再起動しても `claude-3` の run は続き、再起動後の PM が引き継ぎメモから続ける（`workspace/mem`）。持ち主の生死を `commandmate ls --json` の `sessionStatusByInstance.claude.isRunning` で見る案は採らない — 再起動の前後を区別できる値（セッションの開始時刻・ID）が `ls --json` に在るかは**未確認**で、`isRunning` だけでは「再起動直後の PM」と「別の PM」を区別できず、一瞬の停止で予約が外れて dispatch が `/clear` を送る方が害が大きい
- 期限内に PM が二度と戻らない場合、最大 8 時間（延長していればその分）dispatch が止まる。dispatch は記録に「PM が予約中」と残すので、翌日のリリース判断レポートで分かる。利用者は `release` で手で外せる

### 3.2 dispatch の予約

- dispatch は**送る窓の間だけ** `holder: dispatch` の予約を取る: 取る位置は対象の選定の後（`no-target` は `claude-3` に触らないので取らない）・状態確認（現 `:201`）の前。外す位置は依頼の送信（現 `:261`）の直後。`fail()` を含む全ての出口で外す（`try/finally`）
- 期限は 30 分（窓の最悪: 2 回の送信の再送 2×120 秒＋待ち 90 秒＋`spawnSync` の上限 300 秒×数回）。期限に加えて **pid の生死** を見る（dispatch のプロセスが落ちたら即座に古いとみなす。run-lock と同じ）
- `--dry-run` は予約を取らない。読んで「予約中なら送らない」を出力に出すだけ

---

## 4. dispatch が予約を見つけたときの振る舞い

- PM の予約（期限内）が在れば: `/clear` も依頼も送らず、ラベルもコメントも付けず、条件ファイルも書かない。記録は `status: 'skipped-busy'`・全件 `deferred`・`reason: 'claude-3 を PM が予約中（<label>、<expiresAt> まで）'`、**exit 0**（今の busy と同じ扱い。`:204-216`）
- **待たない**（上限 0）。理由: PM の run は時間単位で、数分待っても空く見込みが小さい。Schedule の依頼文は「最大で 5 分ほど」と書いており（dispatch-prompt.md 手順 1）、待ちを足すとそれも崩れる。持ち越しは翌日の 08:30 が拾う
- 状態の新しい値（例 `skipped-reserved`）は足さない。理由: `DISPATCH_STATUSES` は release-readiness（`release-readiness.ts:671`・`release-readiness-html.ts:282`）が読み、記録の `schemaVersion: 1` を変えずに済ませたい。区別は `reason` の先頭の文言で行う。ただし release-readiness の文面「orchestrate が実行中だったため」は予約のときに不正確になるので、実装の契約で `reason` を見て文言を分けるか、文言を「claude-3 が使用中のため」に広げる（7 章）
- dispatch 自身の予約を取ろうとして**期限内の別の dispatch**（同日の手動実行と重なった等）が持っていれば、同じく送らずに `skipped-busy`・exit 0

---

## 5. 対照のテスト

置き場所: `tests/unit/scripts/agent-health/dispatch.test.ts`（既存。`exec` スタブと `--state-dir` の一時ディレクトリをそのまま使う）と新規 `tests/unit/lib/agent-health/claude3-reservation.test.ts`・`tests/unit/scripts/agent-health/claude3-reserve.test.ts`。一時ディレクトリは `fs.mkdtempSync(os.tmpdir())`、`afterEach` で削除。既存の `it` は消さない・名前を変えない。

### dispatch（陽性・陰性・持ち主が消えた予約）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | `stateDir` に期限内の `holder: pm` 予約、`claude-3` は `ready` | `commandmate send` の呼び出しが **0 回**（`/clear` も依頼も無い）・`gh issue edit/comment` も 0 回・記録 `skipped-busy`・`reason` に「PM が予約中」・全件 `deferred`・exit 0・予約はそのまま残る（PM の token が変わらない） |
| 陽性 | 同上で `--dry-run` | send 0 回・出力に予約中の旨・記録を書かない |
| 陽性 | 期限内の `holder: dispatch` 予約（pid は生きている扱いの `isAlive` スタブ） | send 0 回・`skipped-busy` |
| 陰性 | 予約ディレクトリが無い | 今どおり `/clear` → 依頼（既存のテスト「sends /clear then the request…」と同じ呼び出し列）。終わった後に予約ディレクトリが**残っていない** |
| 陰性 | `fail()` の経路（例: `/clear` の送信失敗、条件ファイルが書けない） | 予約ディレクトリが残っていない |
| 持ち主が消えた | `holder: pm` で `expiresAt` が過去 | 退けて今どおり送る・記録の `reason` に「期限切れの予約を外した」 |
| 持ち主が消えた | `holder: dispatch` で pid が死んでいる（期限内） | 退けて今どおり送る |
| 持ち主が消えた | 持ち主ファイルの無いディレクトリ（作成中）が 60 秒未満 / 超え | 未満は送らない（`skipped-busy`）／超えは退けて送る |
| 窓の排他 | `exec` スタブの中で、`ls --json` を返した直後に PM の `reserve` を呼ぶ | PM の `reserve` が exit 3（dispatch が持っている）になり、dispatch は今どおり送る — 「状態確認の後・`/clear` の前に PM が割り込めない」ことの固定 |

### 予約のスクリプト

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | 予約が無い・`claude-3` ready | `reserve` exit 0、`owner.json` の `holder: pm`・`expiresAt` = 今＋8h |
| 陽性 | PM の予約が在る | `send` が `commandmate send mycodebranchdesk <本文> --instance claude-3` を 1 回だけ呼ぶ（送り先は定数のみ） |
| 陰性 | 予約が無い | `send` は exit 3 で `commandmate` を**呼ばない** |
| 陰性 | dispatch の予約が在る | `reserve` exit 3・`release` exit 3 で dispatch の予約を消さない |
| 陰性 | `claude-3` busy | `reserve` exit 4、ディレクトリを作らない |
| 寿命 | 期限切れの PM 予約 | `reserve` が取り直せる。`send` は exit 3（期限切れの予約では送らない） |
| 寿命 | `--renew` | `expiresAt` だけが延び、`token` は同じ |
| 引数 | `--hours 0` / `25` / `1.5` | exit 2 |

---

## 6. 実装の範囲

### 新規

- `src/lib/agent-health/claude3-reservation.ts` — 予約の取得・延長・解放・読み取り・古さの判定（`now` / `isAlive` を注入）。`stateDir` の解決関数もここか `dispatch.ts` に置き dispatch-main と共有する
- `scripts/agent-health/claude3-reserve.ts`（入口）・`scripts/agent-health/claude3-reserve-main.ts`（`exec` 注入。dispatch-main と同じ形）
- 上記 5 章のテスト 2 本
- `changelog.d/4243.md`、`dev-reports/module-reference/issue-4243.md`（`scripts/agent-health/` 行 `docs/module-reference.md:350`・`src/lib/agent-health/` 行 `:352` への追記）

### 変える既存ファイル

- `scripts/agent-health/dispatch-main.ts` — 選定の後に予約を取る・予約中なら `skipped-busy` で終わる・全出口で外す
- `src/lib/agent-health/dispatch.ts` — `:20` のコメント（専用ではない）・`DISPATCH_USAGE` に予約中の `skipped-busy` を足す・`stateDir` 解決を共有するなら移す
- `tests/unit/scripts/agent-health/dispatch.test.ts` — ケースの追加のみ
- `docs/orchestrate/team.md` §4 — 「未対応（追跡）」を消し、`reserve` → `send` → `release` の手順に置き換える
- `docs/user-guide/agent-health.md:591-596` — 状態確認の前に予約を見ること・予約中は送らないこと
- `docs/agent-health/dispatch-prompt.md` 手順 1-3 — 「PM の予約中は送らずに終わる（`skipped-busy`）」を足す（Schedule の AI が読む写し）
- 必要なら `src/lib/agent-health/release-readiness.ts:671`・`release-readiness-html.ts:282` の文言（4 章）

変えないもの: `src/lib/agent-health/run-lock.ts` と `scripts/uat/run-lock.sh`（意味の違うロック）、`src/cli/commands/send.ts`（製品の CLI）、DB。

---

## 7. 残る穴・未確認

- **（見立て）** PM が `send` を使わず素の `commandmate send … --instance claude-3` を打つことは止められない。手順で補う。止めるなら候補 B（製品側）を別 Issue で考える
- **（見立て）** dispatch の run の途中で `claude-3` が一瞬 `ready` に見える時点があれば、PM の `reserve` が通ってブリーフが dispatch の run に重なる。dispatch は送った後に予約を持たないため。dispatch の run の完了を知る口が無いので、この設計では塞がない
- **（未確認）** PM のセッションと Schedule の実行環境で `$AGENT_HEALTH_DIR` が同じ値か（2.1）
- **（未確認）** `commandmate ls --json` に、セッションの再起動を区別できる値があるか（3.1 で採らなかった理由）
- release-readiness の「orchestrate が実行中だったため」の文言が予約のときに不正確になる（4 章）
