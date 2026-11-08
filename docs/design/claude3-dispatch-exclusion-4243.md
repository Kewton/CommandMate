# Issue #4243 設計: claude-3 への送信の排他（PM のブリーフと毎朝の dispatch）

開発リーダー `claude-3`（worktree `mycodebranchdesk`）は、PM のブリーフと agent-health の自動依頼（毎朝 08:30 の dispatch）の両方を受ける（#4239 / PR #4240）。
両者の送信の間に排他が無い。この文書は排他の仕組みを決める設計の段で、コードは変えない。実装は Codex の事前レビュー（処置は 9 章）の後、同じブランチの別の契約で行う。

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
- **rename で退ける方式は、それだけでは排他の根拠にならない**（事前レビュー R4。静的な割込み例で、実再現は未確認）: A が古いと判断 → B が取り直す → A が B の生きたディレクトリを退避 → 空いた名前を C が取る。`run-lock.ts:126-133` は退避後に持ち主の変化を見つけても、C が既に作っていれば B を戻さない（`if (!fs.existsSync(dir))`）ので、B と C が両方「取った」と信じる。生きた持ち主の置き場を一時的に空けること自体が穴

### 1.5 問題の窓（事実からの見立て）

1. `:202`（状態確認）→ `:231`（条件ファイル）→ `:251`（`/clear`）の間に PM のブリーフが届くと、`/clear` がそれを消す
2. PM の run の途中で `claude-3` が**ふつうの入力待ち**（ターンを終えて PM の次の返事を待っている状態）に戻った時点に 08:30 が来ると、`judgeAgentState` は `ready` と読み、`/clear` で PM の run の文脈を消して別の run を始める。なお、プロンプト・ダイアログの承認待ち（`isWaitingForResponse=true`）は今でも `busy` になる（`dispatch.ts:204-205`）。窓は承認待ちではなく、ターンの合間の入力待ち
3. 同じことが逆向きにも起きる: dispatch の run の途中で `claude-3` がターンの合間の入力待ちに戻れば、PM が状態を見ても `ready` に見え、ブリーフが dispatch の run に重なる
4. `:170`（当日 `sent` の確認）は状態確認より前で、記録の書き込み（`:109-114`）は同じ日付のファイルを無条件に置き換える。dispatch が同時に 2 つ動くと、後から来た見送りが先の `sent` を上書きしうる（事前レビュー R5）
5. `:253-259` の 90 秒は `sleep` の累計で、各 `ls --json`（`spawnSync` の上限 300 秒、`:79`）の時間を含まない。実時間の上限は 90 秒ではない

---

## 2. 仕組みの候補と選択

| 候補 | 中身 | 長所 | 短所 |
|---|---|---|---|
| **A. 世代ファイルの予約（新設）** | 予約の状態を `gen-<N>.json` の連番ファイルで持ち、次の世代を **`fs.linkSync` の排他作成**（EEXIST で負ける）でしか進めない。現在の世代は最大の N。消す・退けるで状態を変えない | 全操作（取得・延長・送信中の印・引継ぎ・解放）が「N を見て N+1 を作る」1 つの比較交換になる。生きた持ち主の置き場を空けない。サーバーにも DB にも触らない | PM が素の `commandmate send` を打つことは止められない（手順で補う。7 章） |
| B. CommandMate の DB に行を足す | SQLite に予約の表を足し、API と CLI から取る | `commandmate send` 自体に組み込める | migration が要る（本番 DB を上げる事故の前例あり）。再ビルドが要る。内部の手順のために製品の表と API を増やす |
| C. 既存の run-lock を再利用 | `acquireRunLock({ label: 'claude3-pm' })` | 新しいコードが少ない | UAT・日次確認と同じ 1 本で、PM の run の数時間それらが止まる。生死が pid だけで、予約して終わるスクリプトの pid はすぐ消える。期限が無い。1.4 の rename の穴をそのまま持ち込む |

**A を選ぶ。** 初版は「run-lock と同じ `mkdir`＋rename」としたが、1.4 の穴（R4）があるため、退避・削除で状態を変える操作をやめ、世代を進める排他作成だけにした。

---

## 3. 予約の規則

### 3.1 置き場所（R6）

- 本番の置き場所は **`path.join(os.homedir(), '.commandmate', 'agent-health', 'claude3.reservation')` の絶対パス 1 つだけ**。`$AGENT_HEALTH_DIR`・`--state-dir`・cwd・環境変数からは**解決しない**（dispatch の `stateDir` とは別に固定する）。相対指定は受け付けない
- テストでは、置き場所を `main()` の注入（`deps.reservationDir`）でだけ差し替える。CLI のオプションと環境変数には差し替えの口を作らない（本番の 2 者が別の実体を見る経路を作らないため）
- 各世代に `target: { worktreeId: 'mycodebranchdesk', instanceId: 'claude-3', cliTool: 'claude' }` を書き、読む側は自分の定数（`dispatch.ts` の `DISPATCH_*`）と照らす。食い違えば**何もせず exit 2（設定不一致）**。PM 用のスクリプトと dispatch は送り先の定数を同じ `dispatch.ts` から読む（写しを作らない）
- ファイルなのでサーバーの再起動では消えない
- **未確認**: Schedule の実行環境の `os.homedir()` が PM のセッションと同じか（同じ OS ユーザーなら同じはず）。導入時に `status` を両方の環境で実行し、出た絶対パスが一致することを確かめる手順を docs に書く

### 3.2 世代ファイルの中身

```json
{
  "schemaVersion": 1,
  "generation": 7,
  "target": { "worktreeId": "mycodebranchdesk", "instanceId": "claude-3", "cliTool": "claude" },
  "state": "held",
  "holder": "pm",
  "token": "pm-20261108T070000Z-ab12cd34",
  "label": "#4243 #4244",
  "date": "2026-11-08",
  "heldSince": "2026-11-08T07:00:00.000Z",
  "reviewAfter": "2026-11-08T15:00:00.000Z",
  "sending": null,
  "previousToken": null
}
```

- `state`: `held`（誰かが claude-3 を使っている）／`released`（空き）。ファイルが 1 つも無いのは `released` と同じ
- `holder`: `pm` か `dispatch`。`date` は dispatch のとき、その依頼の JST 日付
- `sending`: 送信の最中だけ `{ "parentPid": 123, "childPid": 456 | null, "since": "<ISO>" }`。それ以外は `null`
- `previousToken`: 引継ぎ・強制解除で前の持ち主の token を残す（監査用）

### 3.3 原子性（R4）

- 書き方: 次の世代の中身を同じディレクトリの `tmp-<pid>-<乱数>.json` に書き切り、`fs.linkSync(tmp, 'gen-<N+1>.json')` で公開し、tmp を消す。`link` は既存の名前があれば EEXIST で失敗するので、同じ N+1 を作れるのは 1 者だけ。公開の時点で中身は書き切られている（途中で止まっても半端な世代は見えない。残るのは tmp だけで、読む側は `gen-*.json` 以外を無視する）
- 読み方: `gen-*.json` の最大の N を現在とする。操作はすべて「現在の N と、その中身が自分の前提どおりか」を確かめてから N+1 を作る。EEXIST なら前提が崩れたので、読み直して最初から判断し直す（最大 5 回、超えたら exit 2）
- **現在の世代を消さない・動かさない**。掃除は N+1 を公開した者が `gen-<N-10>.json` 以下だけを消す（読む側は、最大を読もうとして消えていたら読み直す）
- 古い予約を「回収」する操作は無い。状態を変えるのは 3.4 の操作だけで、どれも同じ比較交換

### 3.4 操作と、通る条件（R1・R2・R3）

すべて新規スクリプト `npx tsx scripts/agent-health/claude3-reserve.ts <sub>` と、dispatch-main からの同じライブラリの呼び出し。token は秘密ではなく**世代の持ち主の識別子**（古い持ち主の遅れた操作を弾くためのもの）。

| 操作 | 誰が | 通る条件（現在の世代に対して） | 作る世代 |
|---|---|---|---|
| `reserve --label <s> [--hours 1-24]` | PM | `released`、かつ `claude-3` が `ready`／`not-running` | `held`・`holder: pm`・新しい token（標準出力に出す）・`reviewAfter` = 今＋既定 8h |
| `send --token <t> "<本文>"` | PM | `held`・`holder: pm`・token が一致・`sending: null` | 送信前に `sending` 付きの世代 → 送信 → `sending: null` の世代（3.5） |
| `renew --token <t> [--hours n]` | PM | `held`・token が一致・`sending: null` | `reviewAfter` だけを進めた世代（token は同じ） |
| `release --token <t>` | PM、dispatch の run の最後の claude-3 | `held`・token が一致・`sending: null` | `released` |
| `takeover --from <t> --reason restart` | 再起動後の PM | `held`・`holder: pm`・token が `<t>` と一致・送信中でない（3.5） | `held`・`holder: pm`・新しい token・`previousToken: <t>` |
| `takeover --from <t> --reason dispatch-finished` | PM | `held`・`holder: dispatch`・token 一致・送信中でない・**その run の完了の証拠**がある（3.6）・`claude-3` が `ready`／`not-running` | 同上（PM の新しい予約になる） |
| `release --force --from <t>` | 人 | `held`・token 一致・送信中でない | `released`・`previousToken: <t>` |
| `status [--json]` | 誰でも | — | **作らない**（読むだけ。tmp も作らない） |
| dispatch の取得 | dispatch | `released`（PM の `reserve` と同じ判断） | `held`・`holder: dispatch`・`date`・`reviewAfter` = 今＋8h |

- 旧 token の操作は必ず失敗する: A が持つ → A の解放 → B が取得（token B）→ A の遅れた `send`／`renew`／`release`（token A）は token が一致しないので exit 3、B の世代は変わらない
- `--from <t>` を要るのは、人や再起動後の PM が**見た世代**だけを引き継ぐため（見ている間に別の引継ぎが起きていたら失敗する）。`<t>` は `status` で読める。PM は `reserve` の出力の token を引き継ぎメモ（`workspace/mem`）にも書く
- **期限（`reviewAfter`）は所有を終わらせない**（R1）。期限を過ぎても予約は `held` のままで、自動の回収は無い。期限は「要確認」を知らせるだけ: `status` と dispatch の見送りの `reason` に「期限超過・要確認」と出る。所有が終わるのは `release`・`takeover`・`release --force` のどれかだけ
- PM のセッションの終了・再起動でも予約は残る。再起動後の PM は `status` で自分の予約を見て `takeover --from <t> --reason restart` で token を取り直す（PM の run は claude-3 の上で続いているので、claude-3 の busy は条件にしない）

### 3.5 送信の最中（R3）

- 送る者（PM の `send`、dispatch の `/clear`・依頼・それぞれの 120 秒後の再送）は、**送るたびに**次を行う: 現在の世代が自分の token で `sending: null` か確かめる → `sending: { parentPid, childPid: null, since }` の世代を作る → `commandmate send` を非同期の `spawn` で起動し、子の pid を載せた世代を作る → 子の終了を待つ → `sending: null` の世代を作る
- 送信中の世代がある間、`renew`・`release`・`takeover`・`release --force` はすべて失敗する（exit 3、「送信中」）。例外: `parentPid` と `childPid`（記録されていれば）がどちらも死んでいて、かつ `since` から 15 分を過ぎていれば「送信中」とみなさない。15 分は子の `commandmate send` の上限（`spawn` に付ける kill の 300 秒）に余裕を足したもの。`childPid` が記録される前に親が死んだ場合（子の pid が分からない）も、15 分の経過だけで判断する
- dispatch は `/clear` → ready 待ち → 依頼 → ラベル → 記録の全区間で同じ token を持ち続ける。区間の途中で予約の状態を変えられるのは送信中でないときの引継ぎ・強制解除だけで、dispatch はそれを各送信の前の確かめで検出し、**送らずに**止まる（記録は `skipped-busy`・`reason: 予約が途中で引き継がれた`）
- 期限で所有が終わらないので、窓の長さ（1.5 の 5）は排他の正しさに関係しない。初版の「30 分」の根拠は撤回する

### 3.6 dispatch の予約の寿命（R1）

- dispatch は依頼を送った後も予約を**外さない**。run の間ずっと `holder: dispatch` で持つ
- 外すのは run の最後の claude-3: 条件ファイル（`buildTerms`）に「完了後（途中で止まったときも）、リリース判断レポートを書いた後に `npx tsx scripts/agent-health/claude3-reserve.ts release --token <t>` を実行する」の 1 行を足す。`<t>` は dispatch が書く
- claude-3 が外し忘れたとき: PM は `takeover --from <t> --reason dispatch-finished` で引き継げる。完了の証拠は `workspace/agent-health/<date>/release-readiness.html`（条件ファイルが run の完了後に書かせるもの。`dispatch.ts` の `buildTerms`）が在り、その mtime が予約の `heldSince` より後であること。証拠が無ければ引継ぎは失敗し、人が `release --force` で判断する
- dispatch が依頼を送る前に止まる経路（対象の再確認で中止、`/clear` の失敗、ready に戻らない、条件ファイルが書けない、例外）では、dispatch は自分の token で `release` する（`try/finally`。token が一致しなければ何もしない）
- 依頼の送信が exit 99（起動直後で未送信）を再送の後も返したときは未送信なので `release`。それ以外の非 0 は「届いたか分からない」ので**外さない**（`reason` に書く。人か PM が状況を見て `release --force`／`takeover`）

### 3.7 PM の予約の寿命

- `reviewAfter` の既定は 8 時間（`--hours` 1〜24、1 時間刻み）。dispatch の Auto-Yes（`DISPATCH_AUTO_YES_DURATION='8h'`）と自走の許可の単位に合わせた。過ぎても所有は続く（3.4）
- 外すのは PM の `release --token <t>`（開発リーダーの `DONE:` を読んだ後）。PM が戻らなければ、毎朝の dispatch の見送りの `reason` とリリース判断レポートに「PM が予約中（期限超過・要確認）」が出続け、人が `release --force` で外す

---

## 4. dispatch の流れと記録（R3・R5）

```
当日 sent の確認（:170、今どおり。早い見切り）
→ 対象の選定（:178-198）。0 件なら予約に触れず no-target
→ 予約の取得（3.4。released でなければ下の「見送り」）
→ 当日の記録を読み直す（取得の後。sent なら自分の token で release し、記録を書かずに今の「本日は送信済み」の行を出して exit 0）
→ claude-3 の状態（:201-216。busy なら release して skipped-busy）
→ 条件ファイル（token を含む）
→ /clear（3.5、再送も同じ）→ ready 待ち → 依頼（3.5、再送も同じ）
→ ラベル・コメント → 記録 sent（予約は持ったまま）
```

- **見送り**（取得できなかった）: `/clear` も依頼も送らず、条件ファイル・ラベル・コメントも作らない。待たない（上限 0）。PM の run は時間単位で、数分待っても空く見込みが小さく、Schedule の依頼文は「最大で 5 分ほど」（dispatch-prompt.md 手順 1）と書いているため
  - 持ち主が PM、または**別の日付**の dispatch（前日の run が続いている）: 記録 `status: 'skipped-busy'`・全件 `deferred`・`reason: 'claude-3 を PM が予約中（<label>、<reviewAfter> まで[・期限超過・要確認]）'` か `'前日（<date>）の自動依頼の run が予約中'`・exit 0
  - 持ち主が**同じ日付**の dispatch（同日の手動実行と重なった）: 当日の記録はその dispatch のものなので**書かない**。標準出力に `AGENT_HEALTH_DISPATCH` の行だけを出し exit 0
- **記録の書き込みの規則**: 書く直前に同じ日付の記録を読み、`sent` が在れば `sent` 以外では置き換えない（書かずに標準出力にだけ出す）。`sent` を書くのは予約を持つ dispatch だけなので、`sent` どうしの競合は起きない
- 状態の新しい値（`skipped-reserved` など）は足さない。`DISPATCH_STATUSES` と `schemaVersion: 1` を変えずに、区別は `reason` の文言で行う

### 4.1 記録の読者（変えるか・確かめるか）

| 読者 | 扱い |
|---|---|
| 翌日の dispatch（`dispatch-main.ts:170`） | `skipped-busy` は再実行を止めない — 今どおり |
| `scripts/agent-health/release-report-main.ts:341,459` | `status`・`deferred` を読むだけ — 変えない。テストで予約の見送りの記録を読ませて落ちないことを確かめる |
| `src/lib/agent-health/release-readiness.ts:671` | 文言「orchestrate の実行中のため見送られた」を「claude-3 が使用中（orchestrate の実行中か予約中）のため見送られた」に広げる |
| `src/lib/agent-health/release-readiness-html.ts:278-283` | `reason` が在ればそれを出す（:278）ので予約の見送りは `reason` が出る — 変えない。`reason` の無い `skipped-busy` の文言だけ 671 と揃える |
| `src/lib/agent-health/dispatch-record.ts:29` のコメント | `skipped-busy` の説明を「orchestrate が実行中、または claude-3 が予約中」に直す |
| Schedule の最終出力（`formatDispatchLine`、dispatch-prompt.md 手順 3） | 行の形は変えない。`reason=` に予約の文言が載る |

---

## 5. 全経路の一覧

| 経路 | 予約に対して | 失敗・例外の出口 |
|---|---|---|
| PM: `reserve` | `released` から `held(pm)` | 別の持ち主 exit 3／claude-3 busy exit 4／設定不一致・I/O exit 2。どれも世代を作らない |
| PM: ブリーフ・途中の返事の `send --token` | 3.5 の送信中の世代を挟む | token 不一致・予約無し exit 3（`commandmate` を呼ばない）。送信の失敗は `commandmate send` の exit を返し、`sending: null` に戻す |
| PM: `renew` | token 一致で `reviewAfter` だけ | 不一致・送信中 exit 3 |
| PM: `DONE:` の後の `release` | `released` | 不一致・送信中 exit 3 |
| PM: 再起動後の `takeover --reason restart` | 新しい token | 不一致・dispatch の予約・送信中 exit 3 |
| PM: 旧 token からの遅い操作 | 何も変えない | exit 3 |
| PM: dispatch の外し忘れの `takeover --reason dispatch-finished` | `held(dispatch)` から `held(pm)` | 完了の証拠が無い・claude-3 busy exit 3／4 |
| 人: `release --force --from` | `released` | 不一致・送信中 exit 3 |
| dispatch: 当日 sent → 選定 → 取得 → 再確認 → 状態 → 条件ファイル → `/clear`・再送 → ready 待ち → 依頼・再送 → ラベル・コメント → 記録 | 4 章 | 依頼の前に止まる出口はすべて自分の token で `release`。依頼の後は持ち続ける。exit 99 以外の依頼の失敗は持ち続ける（3.6） |
| dispatch の run の最後の claude-3: `release --token` | `released` | 不一致 exit 3（PM が引き継いだ後など。何もしない） |
| 読むだけ: `status`、dispatch の `--dry-run` | 世代も tmp も記録も作らない。期限超過・持ち主不明でも回収しない | — |

手順の読者: `docs/orchestrate/team.md` §4、`docs/user-guide/agent-health.md:591-596`、`docs/agent-health/dispatch-prompt.md` 手順 1-3。予約を忘れたときは `send` が送らずに exit 3 で終わること、素の `commandmate send` は保護の外であることを 3 か所とも書く。

---

## 6. 対照のテスト

置き場所: 既存 `tests/unit/scripts/agent-health/dispatch.test.ts`（`exec` スタブと一時ディレクトリをそのまま使う）、新規 `tests/unit/lib/agent-health/claude3-reservation.test.ts`・`tests/unit/scripts/agent-health/claude3-reserve.test.ts`。一時ディレクトリは `fs.mkdtempSync(path.join(os.tmpdir(), …))`、`afterEach` で削除。予約の置き場所は `deps.reservationDir` で必ず一時ディレクトリへ差し替える。既存の `it` は消さない・名前を変えない。競合はライブラリに「N を読んだ後・N+1 を作る前」の差し込み口（注入の `beforePublish` フック）を置いて順序を決めて再現する（実プロセスの競合は未確認のまま）。

### 6.1 Issue の受入基準

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | `held(pm)`、claude-3 ready | dispatch の `commandmate send` 0 回（`/clear` も依頼も無い）・`gh issue edit/comment` 0 回・条件ファイル無し・記録 `skipped-busy`・`reason` に「PM が予約中」・全件 `deferred`・exit 0・世代は変わらない |
| 陽性 | 同上で `--dry-run` | send 0 回・世代も記録も作らない |
| 陰性 | 予約ファイルが無い | 今どおり `/clear` → 依頼（既存の「sends /clear then the request…」と同じ呼び出し列）。終わった後の現在の世代は `held(dispatch)`・`date` = 当日 |
| 陰性 | `released` の世代 | 同上 |

### 6.2 R1（run の終わりまでの所有）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | dispatch が依頼を送った後（`held(dispatch)`）、claude-3 が ready | PM の `reserve` exit 3・`send` は `commandmate` を呼ばない |
| 陽性 | `held(pm)` の `reviewAfter` が過去、claude-3 ready | dispatch は送らない・`reason` に「期限超過・要確認」・世代は変わらない |
| 陽性 | `held(dispatch)` で完了の証拠（release-readiness.html）が無い | `takeover --reason dispatch-finished` exit 3 |
| 陰性 | claude-3 が `release --token` した後 | PM の `reserve` が通る |
| 陰性 | 外し忘れで、`heldSince` より新しい release-readiness.html が在り claude-3 ready | `takeover --reason dispatch-finished` が通り `held(pm)`・`previousToken` = dispatch の token |
| 陰性 | 条件ファイル | `buildTerms` の出力に `release --token <dispatch の token>` の 1 行が在る |

### 6.3 R2（token と世代）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | A 取得 → A release → B 取得 → A の `send`／`renew`／`release` | 3 つとも exit 3・`commandmate` を呼ばない・現在の世代は B のまま |
| 陽性 | dispatch の `finally` の `release` の時点で、PM が `takeover`／人が `release --force` していた | dispatch は何も変えない |
| 陰性 | 正しい token | `send` が `commandmate send mycodebranchdesk <本文> --instance claude-3` を 1 回だけ呼ぶ・`renew` は `reviewAfter` だけ進み token 同じ・`release` で `released` |
| 陰性 | 再起動後の `takeover --from <A> --reason restart` | 新しい token の `held(pm)`・`previousToken: A`。その後 A の操作は exit 3 |

### 6.4 R3（確認から送信まで）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | 送信中の世代（親 pid 生存） | `renew`／`release`／`takeover`／`release --force` すべて exit 3 |
| 陽性 | dispatch の `/clear` の後・依頼の前（ready 待ちのスタブの中）に PM が `takeover --reason dispatch-finished`／人が `release --force` | dispatch は依頼を送らない・記録 `skipped-busy`・`reason: 予約が途中で引き継がれた` |
| 陽性 | exit 99 の 120 秒の再送待ち（`sleep` のスタブの中）に `release --force` | 再送しない |
| 陽性 | 状態取得のスタブが毎回 `now` を 300 秒進め、合計 30 分を超える | 期限で所有が切れず、PM の `reserve` は exit 3 のまま（二者が送らない） |
| 陽性 | 送信中の世代で親・子とも死亡、`since` から 15 分未満 | 引継ぎ exit 3 |
| 陰性 | 同上で 15 分超 | 引継ぎが通る |
| 陰性 | 所有が続く | dispatch の呼び出し列は今どおり（`/clear` → ls … → 依頼 → gh） |
| 陰性 | 依頼が再送の後も exit 99（未送信） | `released` に戻る |
| 陽性 | 依頼が exit 1（届いたか不明） | `held(dispatch)` のまま・`reason` に「届いたか不明」 |

### 6.5 R4（原子性）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | `beforePublish` で A と B が同じ N を読んだ状態にし、両方が N+1 を作る | 一方だけが成功（もう一方は EEXIST で読み直し、`held` を見て exit 3）。`gen-<N+1>.json` は 1 つ |
| 陽性 | tmp を書いた後・`link` の前で止まった（tmp だけ残る） | 読む側は tmp を無視し、現在の世代は N のまま |
| 陽性 | 旧版の rename の割込み（A が古いと判断 → B が取得 → A 再開） | A の操作は EEXIST か token 不一致で失敗し、B の世代は残る。どの順序でも「held の世代が 2 者の token を同時に持つ」状態にならない |
| 陰性 | 人が `release --force` した予約に、PM と dispatch が同時に取りに来る | 一者だけが取れる |
| 陰性 | 掃除 | 現在の世代は消えない。`gen-<N-10>` 以下だけが消える |

### 6.6 R5（記録）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | D2 が当日 sent の確認を通過 → D1 が取得・送信・`sent` を記録 → D2 再開 | D2 は取得できず（同じ日付の dispatch が持つ）、send 0 回・記録を書かない・D1 の `sent` が残る |
| 陽性 | D1 の `sent` の後に D2 が別の理由（PM の予約に替わっていた等）で見送り | `sent` を置き換えない |
| 陽性 | 取得の後の読み直しで当日 `sent` が見つかる | send 0 回・自分の token で `release` |
| 陰性 | 単独の dispatch が PM の予約で見送る | 今どおり `skipped-busy` の記録を書く |
| 陰性 | `release-report-main` に予約の見送りの記録を読ませる | 落ちない・`dispatchStatus: 'skipped-busy'` |

### 6.7 R6（置き場所）

| 区分 | 前提 | 期待 |
|---|---|---|
| 陽性 | 既定の置き場所の関数に、異なる cwd・`AGENT_HEALTH_DIR`・`--state-dir` を与える | どれでも `<homedir>/.commandmate/agent-health/claude3.reservation` の同じ絶対パス |
| 陽性 | 世代の `target.instanceId` が `claude-3` でない | `reserve`／`send`／dispatch は何もせず exit 2（設定不一致） |
| 陽性 | 書いた世代を新しいプロセス（サーバー再起動の代わりに新しい `main()`）で読む | 同じ予約が見える |
| 陰性 | テスト | `deps.reservationDir` を一時ディレクトリに差し替えたとき、本物の `os.homedir()` 配下に何も作らない（呼び出しの前後で既定のパスの存在が変わらないこと） |
| 陰性 | CLI の引数 | `--reservation-dir` のような差し替えの引数は exit 2（未知の引数） |

---

## 7. 実装の範囲

### 新規

- `src/lib/agent-health/claude3-reservation.ts` — 世代の読み書き・3.4 の操作・3.5 の送信中の判定（`now`・`isAlive`・`beforePublish` を注入）・既定の置き場所
- `scripts/agent-health/claude3-reserve.ts`（入口）・`scripts/agent-health/claude3-reserve-main.ts`（`exec`・`spawn` を注入。dispatch-main と同じ形）
- 6 章のテスト 2 本（新規）
- `changelog.d/4243.md`、`dev-reports/module-reference/issue-4243.md`（`docs/module-reference.md:350` の `scripts/agent-health/` 行・`:352` の `src/lib/agent-health/` 行への追記）

### 変える既存ファイル

- `scripts/agent-health/dispatch-main.ts` — 4 章の流れ・送信を 3.5 の手順に（`send` を非同期の `spawn` に）・記録の書き込みの規則・`deps.reservationDir`
- `src/lib/agent-health/dispatch.ts` — `buildTerms` に `release --token` の行（引数に token）・`:20` のコメント（専用ではない）・`DISPATCH_USAGE` の exit 0 の説明に予約中の `skipped-busy`
- `src/lib/agent-health/dispatch-record.ts:29` のコメント
- `src/lib/agent-health/release-readiness.ts:671`・`release-readiness-html.ts:282` の文言（4.1）
- `tests/unit/scripts/agent-health/dispatch.test.ts`、`tests/unit/lib/agent-health/dispatch.test.ts`（`buildTerms`）— ケースの追加のみ。`buildTerms` の出力を固定している既存の期待値が変わる場合は変えずに報告する
- `docs/orchestrate/team.md` §4 — 「未対応（追跡）」を消し、`reserve` → `send --token` → `release` と、再起動後の `takeover`、`status` で置き場所を確かめる手順に
- `docs/user-guide/agent-health.md:591-596` — 予約の取得・見送り・run の最後の `release`
- `docs/agent-health/dispatch-prompt.md` 手順 1-3 — 「claude-3 が予約中なら送らずに終わる（`skipped-busy`）」

変えないもの: `src/lib/agent-health/run-lock.ts` と `scripts/uat/run-lock.sh`（1.4 の rename の穴は別の Issue。本文に無い指摘）、`src/cli/commands/send.ts`（製品の CLI）、DB、`:253-259` の待ちの数え方（排他の正しさに関係しなくなった。実時間の上限にするかは別の Issue）。

---

## 8. 残る穴・未確認

- **（見立て）** PM が `send` を使わず素の `commandmate send … --instance claude-3` を打つことは止められない。手順の 3 か所に書く。止めるなら候補 B を別 Issue で
- **（見立て）** 期限で所有が切れないため、PM や claude-3 が外し忘れると dispatch は人が外すまで毎日見送る。毎日の `reason` とリリース判断レポートに出ることで気づける、という前提
- **（未確認）** Schedule と PM のセッションで `os.homedir()` が同じか（3.1）
- **（未確認）** 実プロセス間の競合（テストは差し込み口で順序を決めて再現するだけ）、送信の途中で親が死んだときの子の `commandmate send` の実際の寿命（3.5 の 15 分の前提）
- **（未確認）** `commandmate ls --json` に、セッションの再起動を区別できる値があるか（再起動の検出は使わず、明示の `takeover` にした）

---

## 9. 事前レビューの処置

レビュー: `workspace/orchestration/runs/2026-11-08/prereview/review-4243.md`（Codex、P1 4 件・P2 2 件）。

| # | 指摘 | 処置 | 理由と反映先 |
|---|---|---|---|
| R1 | dispatch の run を送信後の予約で守っていない／期限切れを run の終わりと同一視 | 採る | dispatch は run の間ずっと予約を持ち、run の最後に claude-3 が `release`（3.6）。期限は「要確認」の表示だけで所有を終わらせない（3.4・3.7）。外し忘れは完了の証拠つきの `takeover` か人の強制解除。1.5 の「承認待ちを ready と読む」は誤りだったので、ターンの合間の入力待ちに直した。対照は 6.2 |
| R2 | token を操作する持ち主に結び付ける規則が無い | 採る | `send`／`renew`／`release` は token の一致を、世代の比較交換の中で確かめる。再起動後の引継ぎ（`takeover --reason restart`）と人の強制解除（`release --force --from`）を別の明示操作にした。dispatch の `finally` も自分の token だけ（3.4・3.6）。対照は 6.3 |
| R3 | 予約の確認から実送信までの保護と途中失効が未定義／30 分の根拠が成り立たない | 採る | 送るたびに送信中の世代を挟み、その間は状態を変える操作を全部拒む。親・子の pid と 15 分で送信の終わりを判断（3.5）。期限で所有が切れなくなったので 30 分の根拠は撤回。対照は 6.4。待ちの数え方（実時間でない）を直すことは本 Issue に入れない（排他の正しさに関係しなくなったため）— 送信の保護は採り、待ちの直しだけ別 Issue |
| R4 | run-lock の rename 方式は排他の根拠にならない | 採る | 退避・削除で状態を変える方式をやめ、`link` の排他作成で世代を進める比較交換だけにした。現在の世代は消さない（2 章・3.3）。run-lock 自体の穴は scope 外として別に報告。対照は 6.5 |
| R5 | 予約の外の送信済み確認・記録更新が同時 dispatch で食い違う | 採る | 取得の後に当日の記録を読み直す。同じ日付の dispatch が持つときは記録を書かない。`sent` は `sent` 以外で置き換えない（4 章）。記録の読者（release-report-main・release-readiness・HTML・`DispatchRecord.status` のコメント・Schedule の最終出力）を 4.1 に列挙。対照は 6.6 |
| R6 | 同じ予約の実体を見る前提をパス表示だけに委ねている | 採る | 置き場所を `os.homedir()` からの絶対パス 1 つに固定し、環境変数・`--state-dir`・cwd から解決しない。テストの差し替えは注入だけ。世代の `target` を送り先の定数と照らし、食い違えば exit 2（3.1）。`os.homedir()` が両環境で同じかは未確認として残し、導入時の確認手順を docs に書く。対照は 6.7 |
| — | 全経路の一覧を入れること | 採る | 5 章（PM・dispatch・読むだけ・記録の読者・手順の読者） |

---

## 10. 実装で決めたこと（設計との差と理由）

実装の契約（同じブランチ）で、7 章の範囲から次のとおり決めた。どれも排他の規則（3〜5 章）は変えていない。

| # | 決めたこと | 理由 |
|---|---|---|
| I1 | `main()` に `exec` だけを注入し `reservationDir` を渡さない呼び出し（既存の `dispatch.test.ts` の `it`）は、`os.tmpdir()` の下の使い捨てのディレクトリを予約の置き場所にし、終わりに消す。`spawnExec` も同じく注入の `exec` を使う | 既存のテストは `reservationDir` を知らず、既定（`os.homedir()` の下）に落ちると本物の置き場所に書く。既存の `it` と期待値は変えない契約のため。本番は `exec` を注入しないので、本番の 2 者が別の実体を見る経路にはならない（3.1 の R6 を保つ） |
| I2 | 非同期の送信は新規 `scripts/agent-health/spawn-exec.ts`（`defaultSpawnExec`、kill は 300 秒）に置き、dispatch と PM のスクリプトで共有する | 7 章に無いファイル。2 つの入口で同じ写しを持たないため |
| I3 | dispatch が送信の直前に「予約が途中で引き継がれた」を見つけたときは `skipped-busy`・**exit 0**（busy と同じ扱い）。予約の読み書きの失敗・`target` の不一致は今の失敗と同じ `fail()`（記録 `skipped-busy`・exit 2）。いずれも送らない | 引継ぎは PM か人の明示操作で、Schedule の AI が失敗として報告するものではない。設定不一致は人が見るべき失敗 |
| I4 | `release` も `previousToken` に外した token を残す（強制解除と同じ形） | 監査で「誰が外したか」を世代から読めるようにするため。規則は変わらない |
| I5 | `reserve` と `takeover` は token だけを標準出力に出し、説明は標準エラーに出す | `T=$(npx tsx … reserve --label …)` で受け取れるようにするため |
| I6 | （I10 で置き換え）`takeover --reason dispatch-finished` の証拠のパスは、スクリプトのあるチェックアウト（`path.resolve(__dirname, '..', '..')`）の `workspace/agent-health/<予約の date>/release-readiness.html`。手順は main のチェックアウトで実行すると書いた | dispatch の条件ファイルとリリース判断レポートは main のチェックアウトに書かれるため |
| I7 | `docs/orchestrate/team.md` は「未対応（追跡）」の語を、素の `commandmate send` を仕組みで止めていないこと（8 章の 1 点目）にだけ残した | 既存の `tests/unit/docs/dev-team-doc-4239.test.ts` がこの語を固定している。期待値は変えない契約のため、残る穴の記述として残した |
| I8 | 英語版の `docs/en/user-guide/agent-health.md` は存在しないため直していない | — |

### 10.1 整合性レビュー（Codex、`workspace/orchestration/runs/2026-11-08/review-4243.md`、P1 2・P2 2）の処置

| # | 指摘 | 変えたこと | 対照 |
|---|---|---|---|
| I9 | P1-1: 掃除で名前が空いた世代番号へ、止まっていた古い操作が link して成功しうる（3.3 の比較交換が崩れる） | 各世代に `publishId`・`parentPublishId` を持たせ、link の直後に「自分が最大の世代」か「次の世代の `parentPublishId` が自分」でなければ古い公開とみなして自分の名前を消し、競合として読み直す（掃除された名前が空くのは現在が N+12 以上のときだけで、最大は減らないので必ず見つかる）。本物の公開の直後に 11 回以上の公開が割り込んだときも失敗側に倒れる（誰も送らない側） | `claude3-reservation.test.ts` P1-1: 陽性＝止めた `beginSend` の間に引継ぎと 12 回の延長で gen-2 を掃除 → 再開した送信は exit 3・送らない（修正前は送る）。陰性＝長い履歴の後の通常の送信は通り、世代が鎖でつながる |
| I10 | P1-2: `takeover --reason dispatch-finished` の証拠が HTML の mtime だけで、run の途中の手動のレポート生成でも証拠になる | 条件ファイルの最後の行を `finish --token <t>` に替えた。`finish` はその token が自動依頼の予約を持っているときだけ予約の置き場所に `finished-<token>.json` を書き、続けて解除する。引継ぎの証拠はこの印だけ（HTML は見ない）。印は、token が現在の持ち主でなくなった世代の公開時に掃除する | `claude3-reserve.test.ts`: 陽性＝run の途中に更新された HTML では exit 3。陰性＝印を残して解除が送信中で拒まれた後は引き継げる。PM の token では `finish` できない |
| I11 | P2-1: 当日の `sent` の確認と記録の置き換えの間に別の dispatch が割り込める | `sent` は `dispatch/<日付>.json.sent` を link で 1 回だけ排他作成してから記録を書く（2 本目の `sent` は書かない）。読む側（当日の確認・取得後の読み直し）は印を先に見る。見送り・失敗・no-target の書き手は、印が無いことを見て rename し、rename の後にもう一度印を見て、在れば `sent` を書き戻す。どの順序でも最後は `sent` が残る | `dispatch.test.ts` P2-1: 陽性＝確認と rename の間・rename の直後に `sent` が入っても最終は `sent`、予約取得前の失敗（gh の失敗）も `sent` を置き換えない。陰性＝`sent` が無ければ今どおり書く |
| I12 | P2-2: PM 用の `send` が dispatch の token でも送れる | `beginSend` に送る側の `holder` を渡し、送信中の印を付ける同じ比較交換の中で持ち主を確かめる（PM の入口は `pm`、dispatch は `dispatch`） | `claude3-reserve.test.ts` P2-2: 陽性＝dispatch の token で PM の `send` は exit 3・`commandmate` を呼ばない。陰性＝PM の token の送信は今どおり |

### 10.2 再レビュー（`workspace/orchestration/runs/2026-11-08/review-4243b.md`、P2 2）の処置

| # | 指摘 | 変えたこと | 対照 |
|---|---|---|---|
| I13 | I11 の `sent` の印への追従が、リリース判断レポート（`release-report-main.ts`）に届いていない。見送りの rename の後・`sent` の書き戻しの前に読むと非 `sent` を採る | 当日の記録の読み方を `dispatch-record.ts` の `readDispatchRecordOfDay()`（印 `dispatchSentMarkerPath()` を先に読み、`sent` ならそれ、無ければ記録ファイル）に 1 つにし、dispatch（当日の確認・取得後の読み直し）とレポートの両方がそれを通る | `release-report.test.ts`: 陽性＝印が `sent`・記録ファイルが見送りの状態で読むと `dispatched=1`・Issue が出る（修正前は 0）。陰性＝印が無ければ記録ファイルを今どおり読む |
| I14 | 古い公開の後処理（掃除）が、今の予約の完了の印を消す（印を「`next.token` と違う」で消していた） | 公開が消す印は、その公開の前提の世代の token（この公開で予約を失う token）のものだけにした。token は一意で二度と持ち主に戻らないので、いつ遅れて掃除が走っても今の持ち主の印には触れない。予約を失う公開は必ずその token を前提に作られるので、自分の古い印はそこで消える（失った後に書かれた印だけは残りうるが、引継ぎは今の token の印しか見ないので無害） | `claude3-reservation.test.ts`: 陽性＝旧 release の掃除の前で止め、その間に新しい dispatch が取得・`finish`（送信中で解除失敗）→ 再開しても新しい印が残り、送信の終了後に引継ぎの証拠になる（修正前は消える）。陰性＝`finish` の解除・後の強制解除で自分の印は消える |

### 10.3 3 回目のレビュー（`workspace/orchestration/runs/2026-11-08/review-4243c.md`、P2 1）の処置

| # | 指摘 | 変えたこと | 対照 |
|---|---|---|---|
| I15 | `readDispatchRecordOfDay()` が記録ファイルを読んだ後に印を見直さない。「印なしを読む → 別の dispatch が `sent` の印を公開 → 見送りの rename → 記録ファイルを読む」で `sent` を読み落とす | 記録ファイルを読んだ後にもう一度印を読み、`sent` があればそれを返す。印は消されないので、記録ファイルを読む前に公開された `sent` は 2 回目で必ず見つかる | `dispatch-record.test.ts`: 陽性＝上の順序を読み取りの差し込みで作ると `sent` が返る（修正前は見送りを返す）。陰性＝印が無ければ記録ファイルのまま。印が先に `sent` なら記録ファイルを読まない |
