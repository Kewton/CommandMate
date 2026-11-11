# Issue #4288 PR1c の設計: supervisor.lock を machine-lock に載せる（上流の段）

- 状態: 上流の段（設計の 4 つと試験の表の雛形）。コードは変えない。実装は、この表がレビューで P2 0 になった後に「表を赤から緑にする」別の契約で行う（PM の依頼 `pm-brief-claude3-upstream-1111.md` の段 1・2）
- 土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) の §1（2 番、D1〜D12）・§1.11（PR1c の書くファイル）・§1.14（PR1a の実装と D12 の不変条件）・§7。PR1a は develop に入っている（`c3387cbe7`、この文書の行番号は `b57c2aba6`）
- 対象: `scripts/agent-health/product/lib.sh` の `product_lock_*` と `scripts/agent-health/product/deadline-guard.sh` の回収を、PR1a の読み込み口 `scripts/lib/machine-lock.sh` の上に載せる部分だけ。run-lock（PR1b）は対象外
- 試験の表の雛形: `tests/unit/scripts/agent-health/supervisor-lock-machine-lock-4288.test.ts`（§2 の表を型つきの列挙から作る。**189 セル＝到達する 176 行＋到達しない 13 セル**、失敗の倒れ方 §3 の **22 行**）
- 表記: **事実**＝コード・実行で確かめたこと（`file:line`）、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと、**決定**＝この文書で決めること（レビューで覆りうる）

## 0. 今の形と、載せた後の形（事実）

| 箇所 | 今（`b57c2aba6`） | 載せた後（PR1c） |
|---|---|---|
| 読み込み | `lib.sh:26-27` が `scripts/uat/run-lock.sh` を source（`run_lock_field`・`run_lock_pid_alive` を使う） | 今の source を残し（表示と `proc_running` が使う。`lib.sh:76`）、**加えて** `scripts/lib/machine-lock.sh` を直に source する（§1.7 の改訂 2、g-P2-7）。読み込みは 1 回だけ（`machine-lock.sh:49-51`） |
| 取得 | `product_lock_acquire`（`lib.sh:167-197`）: 札なしの `mkdir` を 5 回まで、owner は tmp→`mv -f`。失敗の後始末は `rm -rf "$dir"`（`:179`） | `lock_acquire_path <base>/supervisor.lock <base>/supervisor.queue 0`（`verify-run.sh:1544`）を kv の codec（`machine-lock.sh:135-171`）・`LOCK_OWNERLESS_GRACE_MS=60000`・`LOCK_OWNER_EXTRA="label=…\nlstart=…"` で呼ぶ |
| 保有者の判定 | `product_lock_owner_alive`（`lib.sh:132-137`）: pid と `lstart` を**欄ごとに別々の読み**で取り、`proc_matches`（`:84-86`）。`lstart` が空なら死と読む（`[ -n "$2" ]`） | owner の 1 回の読み（`lock_obs_owner` `verify-run.sh:905`）→ `lock_record_state`（`:1119`）を D7 で包んだもの（`machine-lock.sh:83-96`）。`lstart=` が空・無い記録は pid だけで判定 |
| owner の無いディレクトリ | `find -mmin +1`（`lib.sh:143-145`） | `lock_expire_ownerless`（`verify-run.sh:1501`、ms で比べる。先頭だけ） |
| 回収 | 誰でも `mv "$dir" "$dir.stale.$$.$RANDOM"`（`lib.sh:153-164`）。戻せなければ退避のまま | 先頭だけが `lock_recover`（`verify-run.sh:1459`）。退避は `<lock>.gone-*`、戻せなければ保有中と読む（`lock_settle_gone` `:1382`） |
| 解放 | `product_lock_release`（`lib.sh:200-205`）: token を読んで `rm -rf` | `lock_release_held`（`machine-lock.sh:198-257`、D12）。`needs-head` を受けたら `lock_release_as_head`（`verify-run.sh:1955`、D5） |
| ガードの回収 | `deadline-guard.sh:85-88`: `product_lock_is_stale` → `product_lock_take_stale` | `lock_recover_only`（`verify-run.sh:2011`、D6）。`mkdir` しない |
| 呼び手 | `supervisor.sh:78`（取得）・`:82`（EXIT で解放）・`:83-84`（INT・TERM は `exit`）、`deadline-guard.sh:86-87` | 同じ。`supervisor.sh` は関数名が変わらないので書かない |

supervisor.lock だけの性質（事実）:

- 記録の pid は常に取得したシェルの `$$`（`supervisor.sh` は 1 回だけ取る、`:78`）。`LOCK_OWNER_PID`・`LOCK_WANT_TOKEN`・引渡し（D4）・子のグループ（D9）を使わない。守りたい子（runner）は `setsid` で別のセッションに置かれ（`supervisor.sh:233-236`）、台帳（`ledger acquire … pgid=$runner`、`:238`）と次の監督役・ガードの回収（`reclaim_ledger`）が止める。ロックは子を守らない（`supervisor.sh:33-35` の「whatever kills this script, the next supervisor or the deadline guard can find and stop what it left」）
- `supervisor.sh:48`・`deadline-guard.sh:28` は `set -u` だけ（`set -e` ではない）。読み込み口は `set -e` の下では読み込まない（`machine-lock.sh:43-47`）ので、今の 2 つの呼び手は条件を満たす
- `MACHINE_LOCK_LOADED` は export されない（`machine-lock.sh:98`）。監督役が起こす `run-server.sh up`（別プロセス）は自分で読み込む

## 1. (a) 不変条件（どの経路でも成り立つ文）

土台は PR1a の D12（§1.14「release が直接消すのは自己 pid かつ G 空のときだけ、他は needs-head→D5」）と §1.8 の守る条件 (1)〜(5)。supervisor.lock は引渡し・子のグループを持たないので (6) は当てはまらない。

| # | 不変条件 | 根拠（事実） |
|---|---|---|
| S1 | **異なる token の保有区間は重ならない**（新しい実装どうし。旧版との混在は §4 の範囲に狭める） | §1.8 の (1)〜(5)。`mkdir`・回収の `mv`・owner の無い `<lock>` の `rmdir` をするのは札の先頭 1 人だけ（`verify-run.sh:1607-1609`・`:2034-2039`） |
| S2 | **取ったと言えるのは、先頭が `mkdir` した `<lock>` に owner を排他作成し、読み直しで自分の token を見たときだけ**。取得の予算は常に 0（1 回で断る。今の「待たない」と同じ） | `lock_obs_create`（`verify-run.sh:1010-1033`）。予算 0 は `la_deadline = start`（`:1559`）で 1 周 |
| S3 | **回収（退かす・`rmdir`）は札の先頭だけ**（取得の先頭か D6 のガードの先頭）。判定は owner の **1 回の読み**から。死んだと読むのは、pid が ESRCH のとき、または pid が生きていて記録に空でない `lstart=` があり、`ps` が読めて記録と**違う**ときだけ（D7）。それ以外（EPERM・EIO・`ps` の失敗・別 host）は生きている／不明で、**不明は取らない・消さない・解放しない** | `lock_obs_kill0`（`:848-856`）、`machine_lock_lstart_state`（`machine-lock.sh:111-127`）、`lock_holder_state`（`verify-run.sh:1107-1112`） |
| S4 | **解放が直接消すのは、記録の token が自分の token で、記録の pid が呼び手自身（main シェル〔`BASH_SUBSHELL=0`〕の `$$` で、`kill -0 $$` が alive）のときだけ**。supervisor.lock の記録は `pgid=` を持たないので G の判定は「空」に倒れる。それ以外の自分の token の記録は `needs-head`（消さない）、pid が観測できなければ `deferred`。missing・corrupt・他の token は canonical を消さない。解放は 1 回きり（2 回目は `none`） | `machine-lock.sh:198-257`（§1.14 の表） |
| S5 | **`needs-head` を受けた呼び手は D5（`lock_release_as_head <lock> <queue> 10 <token>`）を呼ぶ**。`deferred` を受けた後に再び解放を試みるなら、それも D5。直接消してよいのは最初の 1 回だけ。supervisor の EXIT は終わる途中なので再試行しない（記録の pid が死んだ後に次の先頭が回収する） | §1.14 の「needs-head を受けた呼び手の扱い」「deferred を受けた後の再試行も D5」 |
| S6 | **bash の呼び手は main シェル**。`supervisor.sh` の取得と EXIT の解放は main シェル（`supervisor.sh:78`・`:82`。INT・TERM は `exit` で EXIT trap に入る `:83-84`）。サブシェルからの解放は常に `needs-head`→D5 に倒れ（記録の pid＝親の `$$` が生きていれば `deferred`）、直接は消さない | `machine-lock.sh:240`。既存の試験の 8 者の取り合い（`product-supervisor-3312.test.ts:629-637`）はサブシェルで取って解放するが、期待は「GOT が 1」だけなので変わらない（§2 の `release-subshell` の行） |
| S7 | **自己グループの例外（pid＝pgid＝自分なら G を判定しない）は supervisor.lock では起きない**。記録に `pgid=` を書かない（決定）ので、例外の前提「解放の前に子をすべて待つ呼び手」に頼らない。子（runner・サーバー）はロックではなく台帳が守る（§0） | `machine-lock.sh:229`、§1.14 の「例外の限界」 |
| S8 | **ガード（D6）は `mkdir` しない**。札は全ての経路で `done`。回収の結果はガードの exit code に効かせない（今どおり） | `lock_recover_only`（`verify-run.sh:2011-2063`） |
| S9 | **読み込みに失敗したら取らない**: `product_lock_acquire` は 1 を返し（監督役は exit 75）、ガードはロックの回収を飛ばして記す（台帳の回収と確定は今どおり行う。exit code は変えない） | 決定（`machine-lock.sh:32-33`「the caller must treat that as "not acquired", never run unlocked」） |
| S10 | **1 つのシェルが持つ machine-lock は 1 つ**。`product_lock_*` は呼ぶたびに読み込み口の大域変数（`LOCK_OWNER_CODEC`・`LOCK_OWNERLESS_GRACE_MS`・`LOCK_OWNER_EXTRA`）を自分の値に設定してから machine-lock の操作を呼ぶ（source の時点で設定しない。PR1b の run-lock が同じシェルで別の値を置いても混ざらない） | 決定（`verify-run.sh:661-670` の大域変数は 1 組） |
| S11 | **取得が断るとき、`lib.sh` は生きた記録に対して stderr に何も書かない**（文面は `PRODUCT_LOCK_ERROR` に入れ、呼び手が出す）。不明・札の取り下げ・戻しなど machine-lock 自身の `verify-run:` の行は出てよい | 既存の試験 `product-supervisor-3312.test.ts:625`（`expect(res.stderr).toBe('')`） |

## 2. (b) 状態と遷移の表（記録の形 × 呼び手 × 観測の 3 値 → 結果）

### 2.1 列挙

**記録の形（7）**: 操作が読む時点の supervisor.lock の状態。

| 形 | 中身 |
|---|---|
| `absent` | `<base>/supervisor.lock` が無い（退避も無い） |
| `ownerless` | `<lock>` はあるが owner が無く、中が空 |
| `corrupt` | owner はあるが `pid=` か `token=` が無い（壊れた記録。pid だけはあることがある） |
| `own` | 呼び手の token の記録（pid＝取得したシェル、`lstart=` あり、`pgid=` 無し） |
| `other-plain` | 他の token の記録で `lstart=` が無いか空（旧版の `ps` の失敗で空になった記録を含む） |
| `other-lstart` | 他の token の記録で `lstart=` があり、記録の pid が生きている |
| `aside` | canonical の `<lock>` が無く、他の token の退避 `<lock>.gone-*` がある（戻しが途中で止まった） |

自分の token の退避は列挙しない: 自分の記録は自分が生きている間は回収されない（S3: pid が生きていて `lstart` が同じ）ので、自分の退避が生じるのは自分が死んだ後で、そのとき自分は解放を呼べない。

**呼び手（9）**:

| 呼び手 | 操作 |
|---|---|
| `acquire-head` | `product_lock_acquire`（予算 0）で、札の先頭になれた |
| `acquire-behind` | 同じで、生きた札が前にある（別の取得・D5・ガードが先頭） |
| `release-main` | `product_lock_release` を main シェルから（`supervisor.sh:82` の EXIT）。保持の印あり |
| `release-subshell` | 同じをサブシェルから（既存の 8 者の試験の形）。`needs-head` なら続けて D5 |
| `release-unheld` | 保持の印が無いときの `product_lock_release`（2 回目の解放・既存の試験 `:641` の形） |
| `release-as-head` | D5 `lock_release_as_head`（予算 10）で先頭になれた。token は自分のもの |
| `release-as-head-behind` | 同じで、予算のうちに先頭になれない |
| `guard-head` | ガードの D6 `product_lock_recover_only`（予算 10）で先頭になれた |
| `guard-behind` | 同じで、先頭になれない |

**観測の 3 値**: 形ごとに、結果を決める観測を 1 つ決めて 3 値にする（試験はその観測を作るか注入する）。

| 形 | 決める観測 | `alive` | `gone` | `unknown` |
|---|---|---|---|---|
| `absent` | 取得: `<lock>` の `mkdir`（`lock_obs_mkdir` `:976`）。ガード: `<lock>` の一覧（`lock_obs_list` `:859`）。解放: 読まない | 間に誰かが作った（EEXIST／一覧が出た） | 作れた／ENOENT | 他の errno |
| `ownerless` | `<lock>` の mtime の年齢（`lock_obs_mtime` `:1039`） | 60 秒以下（作りかけ） | 60 秒より古い | `stat`・一覧の失敗 |
| `corrupt` | 記録に残る pid の `kill -0`（判定には使われないことを見る） | 生きている | ESRCH | EPERM・EIO |
| `own` | 解放: `kill -0` の記録の pid（main は `$$`）。D5: `lock_record_state`（D7 込み） | 生きている（`lstart` も同じ） | ESRCH | EPERM・EIO・`ps` の失敗 |
| `other-plain` | `kill -0` の記録の pid | 生きている | ESRCH | EPERM・EIO |
| `other-lstart` | 生きた pid の `ps -o lstart=`（D7） | 記録と同じ | 記録と違う（pid の再利用） | `ps` の失敗・空 |
| `aside` | 退避の記録の `lock_record_state` | 生きている | ESRCH | EPERM・EIO |

`other-lstart` の pid が死んでいる場合は `kill -0` が先に ESRCH を返し、`ps` を呼ばない（`machine-lock.sh:85`）。その形は `other-plain` の `gone` と同じ判定の道を通る（既存の `:647` の試験の割込みが新しい形で働かない理由。§5）。

### 2.2 表

セルは「結果 ／ 記録の行方」。記録の行方: `unchanged`（その場に残る）、`absent`（その記録が消える。canonical か退避）、`mine`（呼び手の記録が canonical になる。前の記録は消える）、`restored`（退避が canonical に戻る）。取得の `refused` には文面の種類を添える: `rec`＝`busy: <label> pid N holds <dir>`（今の文面、`lib.sh:188`）、`taking`＝`busy: <dir> is being taken by another supervisor right now`（今の文面、`:190`）、`queue`＝`busy: queue ticket <t> (pid N) is ahead for <dir>`（新しい枝）、`unk`＝`busy: <dir> cannot be judged (point=… errno=…); not taken`（新しい枝）。文面の優先は `unk` ＞ owner のファイルがある（`rec`）＞ 前の札（`queue`）＞ `taking`。`—` は到達しない（理由は表の下）。

| 形 / 観測 | acquire-head | acquire-behind | release-main | release-subshell | release-unheld | release-as-head | release-as-head-behind | guard-head | guard-behind |
|---|---|---|---|---|---|---|---|---|---|
| absent / alive | refused(taking) / unchanged | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| absent / gone | **acquired / mine** | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | absent / unchanged | not-head / unchanged |
| absent / unknown | refused(unk) / unchanged | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| ownerless / alive | refused(taking) / unchanged | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| ownerless / gone | **acquired / mine** | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | **removed / absent** | not-head / unchanged |
| ownerless / unknown | refused(unk) / unchanged | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| corrupt / 3 値とも | refused(rec) / unchanged | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| own / alive | — | — | **released / absent** | needs-head→deferred / unchanged | none / unchanged | deferred / unchanged | not-head / unchanged | — | — |
| own / gone | — | — | — | **needs-head→released / absent** | none / unchanged | **released / absent** | not-head / unchanged | — | — |
| own / unknown | — | — | deferred / unchanged | deferred / unchanged | none / unchanged | deferred / unchanged | not-head / unchanged | — | — |
| other-plain / alive | refused(rec) / unchanged | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| other-plain / gone | **acquired / mine** | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | **removed / absent** | not-head / unchanged |
| other-plain / unknown | refused(unk) / unchanged | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| other-lstart / alive | refused(rec) / unchanged | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| other-lstart / gone | **acquired / mine** | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | **removed / absent** | not-head / unchanged |
| other-lstart / unknown | refused(unk) / unchanged | refused(rec) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | kept / unchanged | not-head / unchanged | kept / unchanged | not-head / unchanged |
| aside / alive | refused(rec) / restored | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / restored | not-head / unchanged |
| aside / gone | **acquired / mine** | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | **absent / absent** | not-head / unchanged |
| aside / unknown | refused(unk) / restored | refused(queue) / unchanged | kept / unchanged | kept / unchanged | none / unchanged | missing / unchanged | not-head / unchanged | kept / restored | not-head / unchanged |

行数: 7 形 × 9 呼び手 × 3 観測 ＝ **189 セル**（`corrupt` の 1 行は 3 観測を 1 行に畳んだ表示）。到達しない 13 セル（`own` × `acquire-head`・`acquire-behind`・`guard-head`・`guard-behind` の 12 と、`own` × `release-main` × `gone` の 1）を除いた **176 行**が試験の行。

到達しない理由:

- `own` × 取得（6）: 監督役は 1 シェルで 1 回だけ取り（`supervisor.sh:78`）、取得の token は毎回新しい（`lock_acquire_path` の `LOCK_TOKEN`、`verify-run.sh:1548-1552`。`LOCK_WANT_TOKEN` を使わない）。2 回目の取得は (d) で引数として拒む
- `own` × ガード（6）: ガードは取得しない（D6）。ガードの token の記録は存在しない
- `own` × `release-main` × `gone`（1）: main シェルの `$$` は呼んでいる本人で、`kill -0 $$` は ESRCH にならない

読み方の要点（セルの根拠、事実）:

- `release-*` は `own` 以外の形で canonical を消さない（`machine-lock.sh:208-226`、`verify-run.sh:1972-1987`）。D5 は owner が無ければ `rmdir` もしない（`ownerless` × `release-as-head` は `missing / unchanged`）
- `release-subshell` × `own` × `alive` は `needs-head`（`machine-lock.sh:246-251`）→ D5 が記録の pid（親の `$$`）を生きていると読んで `deferred`（`verify-run.sh:1988-1990`）。ロックは親が終わった後に次の先頭が回収する
- `acquire-head` × `gone` は回収（`lock_recover`）の後 `continue` で同じ周の続きに入り、予算 0 でも `mkdir` まで進む（`verify-run.sh:1660-1666`。期限の確かめ `:1697` は `continue` で飛ぶ）
- `aside` × `alive`・`unknown` は先頭が退避を戻す（`lock_restore_from_gone` `:1327`）。取得は断り、ガードは `kept`
- `ownerless` × `gone` × `acquire-head` は先頭の `rmdir`（`lock_expire_ownerless` `:1501-1535`）→ `mkdir`。既存の試験 `:603-608` の期待のまま

### 2.3 表と不変条件の突き合わせ（試験の雛形で表そのものに掛ける）

雛形の `describe('the table keeps the invariants (a)')` は、実装を呼ばずに表のデータへ次を掛ける（表を直すと落ちる）:

1. `acquired` は `acquire-head` だけで、行方は `mine`（S2）
2. `*-behind` の行の行方は全て `unchanged`（S1・S3: 先頭でない者は動かさない）
3. 観測が `unknown` の行は、行方が `unchanged` か `restored` で、結果が `acquired`・`released`・`removed`・`needs-head→released` でない（S3）
4. `own` 以外の記録を消す（行方が `absent`・`mine`）のは `acquire-head`・`guard-head` の `gone` だけで、`corrupt` は誰も消さない（S3）
5. `own` を消すのは `release-main` × `alive`、`release-subshell` × `gone`（D5 経由）、`release-as-head` × `gone` だけ（S4・S5）
6. `release-subshell` は `released` を直に返さない（S6）
7. `release-unheld` は全て `none / unchanged`（S4 の 1 回きり）
8. 取得の `refused` には文面の種類があり、それ以外には無い（S11 と文面の固定）

## 3. (c) 外部の呼び出しごとの失敗の倒れ方

「消す側」＝その失敗で何かを消す（取る）向き、「消さない側」＝何も消さず・取らず、記録を残す向き。supervisor.lock の経路で消す側に倒れるのは、**自分が作ったもの**（排他作成で開いた owner・自分の `mkdir` した `<lock>`）の後始末だけ。

| # | 呼び出し（場所） | 失敗 | 倒れ方 | 終状態 |
|---|---|---|---|---|
| F1 | `kill -0`（`lock_obs_kill0` `verify-run.sh:848`） | EPERM | 消さない側（alive と読む。EPERM は「居る」） | 取らない・回収しない・解放は `needs-head` に進まない（`own` は `deferred`） |
| F2 | 同上 | EIO など ESRCH 以外 | 消さない側（unknown） | 同上。取得は `refused(unk)`、ガードは `kept` と `LRO_UNKNOWN` |
| F3 | `ps -o lstart=`（`machine_lock_lstart_state` `machine-lock.sh:117`） | 失敗・空の出力 | 消さない側（unknown） | 同上。`CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO>` で注入できる |
| F4 | `ps -o lstart=`（取得の時の `proc_lstart $$`、`lib.sh:66-68`） | 失敗して `lstart=` が空で書かれる | 新しい読み手: 消さない側（pid だけで判定）。**旧い読み手: 消す側**（`proc_matches` が空の `lstart` を不一致と読む `lib.sh:85`） | 新旧の混在の間だけの穴（§4。旧版どうしでも同じ穴がある＝本文に無い指摘） |
| F5 | `mkdir <lock>`（`lock_obs_mkdir` `:976`） | EEXIST 以外 | 消さない側（unknown） | `refused(unk)`、何も作らない |
| F6 | owner の排他作成（`lock_obs_create` `:1010`） | EEXIST（3）・他の記録を読み直した（6） | 消さない側 | 何も消さない（`:1632-1633`） |
| F7 | 同上 | 開けない（10+i） | 自分の `mkdir` だけを戻す | `rmdir <lock>`（空のときだけ消える。`:1646`） |
| F8 | 同上 | 開いた後の書き込みの失敗（40+i）・読み直しが不明（70+i） | 自分が開いた owner と自分の `<lock>` だけを戻す | `rm -f <lock>/owner` → `rmdir <lock>`（`:1636-1650`） |
| F9 | 同上の後始末の `rm -f owner`（`fault:owner-unlink`） | 失敗 | 消さない側 | `<lock>` と途中の owner が残る（「could not be taken out again」`:1649`）。完全な記録なら監督役の終了後に回収される。**書きかけ（`corrupt`）なら誰も回収しない**（見立て: 人が消すまで翌朝以降も exit 75。今の `lib.sh:179` の `rm -rf` は他者のロックも消しうる形で、こちらを採る。§1.10 の (b) と同じ判断） |
| F10 | 同上の `rmdir <lock>`（`fault:lock-rmdir`） | 失敗 | 消さない側 | 空の `<lock>` が残り、60 秒の後に先頭が `rmdir`（`ownerless` × `gone`） |
| F11 | 回収の `mv <lock> <lock>.gone-*`（`lock_obs_mv rename-aside` `:1463`） | ENOENT | 消さない側 | `absent`（誰かが先に消した） |
| F12 | 同上 | その他 | 消さない側 | `LRC_RESULT=unknown`。取得は同じ token を 2 度回収しない（`la_broken` `:1661`）ので断る、ガードは `kept` |
| F13 | 戻しの `mkdir <lock>`（`restore-mkdir` `:1477`） | 失敗 | 消さない側 | 退避を残す（`restore-failed`）。生きている間は先頭が保有中と読む（`lock_settle_gone`） |
| F14 | 戻しの `mv <gone>/owner <lock>/owner`（`restore-rename` `:1312`） | 失敗 | 消さない側 | 空の `<lock>` を `rmdir` して退避を残す（`:1319-1322`） |
| F15 | 回収の `rm -rf <gone>`（`:1472`、`|| true`） | 失敗 | 消さない側 | 死んだ記録の退避が残り、次の先頭が `lock_settle_gone` で片付ける |
| F16 | 解放の `rm -rf <lock>`（`machine-lock.sh:241`、`|| true`） | 失敗 | 消さない側（結果は `released` と答える） | 自分の記録が残り、監督役の終了で pid が死んだ後に次の先頭が回収する（結果の値が実態と違う点は本文に無い指摘） |
| F17 | D5 の `rm -rf <lock>`（`verify-run.sh:1986`、`|| true`） | 失敗 | 消さない側（結果は `released`） | 死んだ記録が残り、次の先頭が回収する |
| F18 | 札の `ln`（`lock_take_ticket` `:1212`） | EEXIST 以外 | 消さない側 | 取得は断る（「cannot publish a ticket」`:1577`）、D5・ガードは `not-head` |
| F19 | 札の列の一覧（`lock_obs_list list-queue`） | 失敗 | 消さない側（unknown） | 取得は `mkdir` へ進まず断る（`:1600-1606`）、D5・ガードは予算まで待って `not-head` |
| F20 | 札の判定の `ps -o etime=`（`lock_pid_start_ms` `:1129`） | 失敗 | 消さない側 | 再利用と読まず、前の札は生きた札として待つ |
| F21 | 読み込み口（`machine_lock_load` `machine-lock.sh:63-100`） | `verify-run.sh` が無い・印が 1 つずつでない・`set -e` | 消さない側 | S9: 取得は断る（exit 75）、ガードはロックの回収だけ飛ばす |
| F22 | `hostname`（`LOCK_HOST`、`verify-run.sh:612`） | 監督役とガードで値が違う | 消さない側 | `host=` が違う記録は生きている扱い（`lock_holder_state` `:1108`）。回収されず、翌朝以降も busy（見立て: host 名の変更は起きない前提） |

使わないもの（事実）: supervisor.lock の経路は **tmux を呼ばない**（`lib.sh:121-205` と読み込み口の節に tmux は無い。tmux は台帳の資源の回収 `reclaim_tmux` だけ）。`lock_drain_group`（`KILL_GRACE_SEC`）・`lock_hand_off`・`lock_child_wait` も呼ばない（S7: グループを持たない）。

流用する既存の部品の倒れ方（事実）:

- `proc_lstart`（`lib.sh:66`）: 書く側だけに使う（記録の `lstart=` の値。旧い読み手と同じ形に揃えるため squeeze しない）。判定は `machine_lock_lstart_state`（前後の空白を詰めて比べる `machine-lock.sh:103-107`・`:126`）。失敗は F4
- `run_lock_field`（`run-lock.sh:44-47`）: 取得が断ったときの文面（`label`・`pid`）だけに使う。判定には使わない。失敗は空の文字列（文面が欠けるだけ）
- `run_lock_pid_alive`（`run-lock.sh:75-83`、2 値）: ロックの判定には使わない（`proc_running` が台帳の回収に使う。§1.12 で直さないと決めた写し）

## 4. 新旧の混在（supervisor.lock に限る）

同じチェックアウトの `lib.sh` を監督役とガードの両方が source するので、混在は「同期の前の朝」の 1 回に限る（§1.9 の切替の表の行）。

| 読み手・取得者 | 新しい記録（生きている） | 新しい記録（死んでいる） | `.gone-*` | `supervisor.queue/` | 空 `lstart=` の新しい記録 |
|---|---|---|---|---|---|
| 旧い取得者・旧いガード（`lib.sh` の旧版） | `pid=` と `lstart=` を `sed` で読める（`label=` もある）ので断る | 退かして回収（旧い穴） | 見えない（2 者が持ちうる） | 見えない（札を抜かす） | **死んだと読んで奪う**（F4） |
| 新しい取得者・ガード | — | 先頭が回収 | 先頭が片付け・戻し | 札の順 | pid だけで判定 |
| 新しい読み手 × 旧い記録（`host=` 無し、`lstart=` あり） | 「この host」と読む（`machine-lock.sh:157`）、`lstart` も D7 で判定 | 回収 | — | — | — |

旧い `<lock>.stale.*`（旧版の退避）は新しい読み手が読まない（`.gone-` の形でない。`verify-run.sh:1277-1278`）。生きた記録がそこに残っていても守れない（§1.9 の (c) と同じ）。

## 5. (d) PR の切り方

- **PR1c は 1 本**: `scripts/agent-health/product/lib.sh`、`scripts/agent-health/product/deadline-guard.sh`、`tests/unit/scripts/agent-health/supervisor-lock-machine-lock-4288.test.ts`（この雛形を赤から緑に）、`tests/unit/scripts/agent-health/product-supervisor-3312.test.ts:647` の割込みの口、`changelog.d/4288.md` への書き足し、`dev-reports/module-reference/issue-4288.md`。依存は PR1a だけ（develop に入っている）。PR1b（run-lock）と並行してよい
- **API は呼び手と同じ PR**: `product_lock_recover_only`（D6 の包み）は呼び手 `deadline-guard.sh` と同じ PR で入れる。PR1a で入った `lock_recover_only`・`lock_release_as_head`・`lock_release_held` は、PR1c で初めて本番の呼び手を持つ。消すもの: `product_lock_owner_alive`・`product_lock_is_stale`・`product_lock_take_stale`（呼び手は `lib.sh` 自身と `deadline-guard.sh:86-87` だけ。`git grep` で試験からの呼び出しは無い）
- **呼び手の無い組み合わせは引数で拒む**（決定。拒んだら 2 を返し、`PRODUCT_LOCK_ERROR` に理由）:
  - `product_lock_acquire` は引数がちょうど 1 つ（ラベル）で、空・改行を含むものは拒む（ラベルは `LOCK_OWNER_EXTRA` の 1 行になる。改行で `pgid=` などを差し込むと、codec の「最初の行が勝つ」で書式の後ろの `pgid=` より先に読まれる。`machine-lock.sh:150`・`:168-169`）。このシェルが既に保持している（`LOCK_HELD_PATH` が空でない）なら拒む（表の `own` × 取得が到達しない理由）
  - `product_lock_release` と `product_lock_recover_only` は引数を取らない（渡されたら拒む）。`product_lock_recover_only` はこのシェルが保持しているなら拒む（ガードは取得しない）。`PRODUCT_BASE` が空なら 3 つとも拒む
  - 引渡し（`lock_hand_off`）・`LOCK_OWNER_PID`・`LOCK_WANT_TOKEN`・`pgid=` は `product_lock_*` から出さない（呼び手が無い）
- **`product-supervisor-3312.test.ts:647` の書き換え**: PM の決定（`pm-return-4288-design-rev2.md` の (1)）どおり PR1c で行う。期待（assert）は 1 行も変えず、割込みの口を `ps` の stub から `CM_VERIFY_TEST_HANDOFF=pause:recover-only-judged`（`verify-run.sh:2038`）に替える。書き換えた試験が、守る振る舞いを壊す変異（例: `lock_recover` の token の確かめ `:1471` を外す）で赤になることを PR1c の中で示し、変異の内容と赤の件数をコミット本文に書く。期待を変える必要が出たら止めて返す
- **PR1b との関係**: `lib.sh` は今の `run-lock.sh` を source したまま。PR1c の試験は今の（旧い）`run-lock.sh` で通し、`run-lock.sh` の版に依らないことを見る（§7 の PR1c の行）。PR1b が後で `run-lock.sh` から同じ読み込み口を source しても読み込みは 1 回だけ。PR1b は S10（大域変数は呼ぶたびに設定）を守る（PR1b の契約へ引き継ぐ）
- 難易度の見立て: 表が閉じていれば中（sonnet）。実装は包み 3 つと文面の対応、ガードの 4 行で、試験の量が主

## 6. review-4288h の P2 3・P3 1 と PR1c

| 指摘 | PR1c での扱い |
|---|---|
| P2-1（読み込み口だけでは `KILL_GRACE_SEC` が初期化されない） | PR1a で閉じた（節の中で設定、`verify-run.sh:611`）。supervisor.lock は `lock_drain_group` を呼ばない（§3 の「使わないもの」）。試験の雛形は `set -u` の下で設定なしに読み込む形を前提にする |
| P2-2（D9 の tmp の段） | 当てはまらない: supervisor.lock は引渡し・子のグループを持たない（S7）。`LOCK_PENDING_TOKEN` は常に空で、`lock_release_held` の token は取得の 1 つだけ |
| P2-3（UAT の長が死に G の子が残った `down`） | 当てはまらない（UAT は PR1b）。監督役の子は台帳が守る（§0） |
| P3（pending の後・`mv` の前の失敗の T0） | 当てはまらない（引渡しが無い）。表の `own` の行は「T0 だけ」の 1 種類 |

## 7. 対になる場所（探した結果）

- 同じロックの写し: supervisor.lock を触るのは `lib.sh`・`deadline-guard.sh`・`supervisor.sh`（関数名で呼ぶだけ）の 3 つ（`git grep 'product_lock_\|supervisor\.lock'`）。TS・`src/` に写しは無い。`src/cli/types/` にも無い
- 説明: `docs/user-guide/agent-health.md:773`（「2 つ目の監督役は exit 75 で何もしない」）は載せた後も正しい。`lib.sh:121-126` のコメントは PR1c で書き直す。`docs/en` に写しは無い
- 古い動きを固定する試験: `product-supervisor-3312.test.ts` の supervisor.lock の 5 本（`:580-644`）と guard の 2 本（`:647-694`）。期待は変えない（`:647` は口だけ、§5）。`:603-608` の 60 秒・`:625` の stderr 空・`:641` の他者のロックを消さない、は表の行（`ownerless` × `gone`、S11、`release-unheld`）に当たる

## 8. 決めたこと・残る判断

決めたこと（この文書）: 記録に `pgid=` を書かない（S7）、ガードの予算は 10 秒（D5 と同じ）、読み込みの失敗はガードの exit code に効かせない（S9）、大域変数は呼ぶたびに設定（S10）、引数での拒否（§5）、文面の 2 つの新しい枝（`queue`・`unk`）と優先の順。

残る判断（PM へ。止める条件ではない）:

1. F4（空の `lstart=`）を混在の朝のために塞ぐか。塞ぐなら取得の時に `proc_lstart $$` が空なら取らない（その朝の監督役は exit 75）。塞がないなら混在の朝だけの穴として受け入れる（推奨: 受け入れる。`ps -o lstart= -p $$` が自分自身で失敗する経路は未確認で、旧版どうしにも同じ穴がある）
2. F9（書きかけの owner が後始末の失敗で残る）を人が消すまで残す今の判断でよいか（推奨: よい。2 者が持つ側に倒さない）
