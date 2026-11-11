# Issue #4288 PR1c の設計: supervisor.lock を machine-lock に載せる（上流の段・3 回目）

- 状態: 上流の段の 3 回目（設計の 4 つと試験の表の雛形）。コードは変えない。実装は、この表がレビューで P2 0 になった後に「表を赤から緑にする」別の契約で行う（PM の依頼 `pm-brief-claude3-upstream-1111.md` の段 1・2）
- 2 回目の入力: Claude 5 `prereview/review-4288-pr1c-upstream.md`（P2 5・P3 5）、PM Claude `pm-review-4288-pr1c-upstream-claude.md`（P2 4・P3 9）、PM の処分 `pm-return-4288-upstream.md`（共通の決定 1〜5 と PR1c の個別の決定）。不変条件は全員一致で正しいので変えず、表と既存の試験との契約を直した（§9 に指摘ごとの処分）
- 3 回目の入力: PM Claude `pm-review-4288-pr1c-upstream2-claude.md`（P2 2・P3 6）、Claude 5 `prereview/review-4288-pr1c-upstream2.md`、PM の処分 `pm-return-4288-pr1c-upstream2.md` の 1・2・4。直したのは文と期待値だけで、規則・不変条件・表の形は変えない（§10）。処分の 3（TZ を PR1a-f の比較に寄せる）は、PR1a-f の上流 2 回目で関数の名前と契約が決まった後の追加の指示（`reinstruct-4288-pr1c-tz.md`）で直した: 独自の tz の包みを消し、生死の判定の時刻の比較を PR1a-f の関数に寄せた（S3・§2.1・F8・F9・前提 P3、形 `other-tz` → `other-eperm`、文面 `tz` を外して 10 種類。§10）
- 土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) の §1（2 番、D1〜D12）・§1.11（PR1c の書くファイル）・§1.14（PR1a の実装と D12 の不変条件）・§7。PR1a は develop に入っている（`c3387cbe7`、この文書の行番号は `b57c2aba6`）
- 対象: `scripts/agent-health/product/lib.sh` の `product_lock_*` と `scripts/agent-health/product/deadline-guard.sh` の回収を、PR1a の読み込み口 `scripts/lib/machine-lock.sh` の上に載せる部分だけ。run-lock（PR1b）は対象外
- 試験の表の雛形: `tests/unit/scripts/agent-health/supervisor-lock-machine-lock-4288.test.ts`。表は型つきの列挙（足し忘れ・答えられない結果は `satisfies` で typecheck が落とす）。雛形は次の数をこの行から読み、自分の表の数と比べる（別々に作ったオブジェクトの比較）:
  - 表の数: セル 297・行 185・拒否 39・不可能 73・失敗 34・拒否の検査 9・読み込み 5
- 表記: **事実**＝コード・実行で確かめたこと（`file:line`）、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと、**決定**＝この文書で決めること（レビューで覆りうる）

## 0. 今の形と、載せた後の形（事実）

| 箇所 | 今（`b57c2aba6`） | 載せた後（PR1c） |
|---|---|---|
| 読み込み | `lib.sh:26-27` が `scripts/uat/run-lock.sh` を source（`run_lock_field`・`run_lock_pid_alive` を使う） | 今の source を残し（表示と `proc_running` が使う。`lib.sh:76`）、**加えて** `scripts/lib/machine-lock.sh` を直に source し、その戻り値を `PRODUCT_MACHINE_LOCK_OK` に持つ（§5.2 の契約）。読み込みは 1 回だけ（`machine-lock.sh:49-51`） |
| 取得 | `product_lock_acquire`（`lib.sh:167-197`）: 札なしの `mkdir` を 5 回まで、owner は tmp→`mv -f`。失敗の後始末は `rm -rf "$dir"`（`:179`） | `lock_acquire_path <base>/supervisor.lock <base>/supervisor.queue 0`（`verify-run.sh:1544`）を kv の codec（`machine-lock.sh:135-171`）・`LOCK_OWNERLESS_GRACE_MS=60000`・`LOCK_OWNER_EXTRA="label=…\nlstart=…"` で呼ぶ（`tz=` は書かない。§2.1） |
| 保有者の判定 | `product_lock_owner_alive`（`lib.sh:132-137`）: pid と `lstart` を**欄ごとに別々の読み**で取り、`proc_matches`（`:84-86`）。`lstart` が空なら死と読む（`[ -n "$2" ]`） | owner の 1 回の読み（`lock_obs_owner` `verify-run.sh:905`）→ `lock_record_state`（`:1119`）を D7 で包んだもの（`machine-lock.sh:83-96`）。D7 の時刻の比較は PR1a-f の `machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>`（PR1a-f の設計 `docs/design/machine-lock-owner-atomic-4288.md` §4.1・§4.2、`be8275def`） が受け持つ（PR1a-f が D7 の包みの中で呼ぶ。lib.sh は包みを足さない。§2.1） |
| owner の無いディレクトリ | `find -mmin +1`（`lib.sh:143-145`） | `lock_expire_ownerless`（`verify-run.sh:1501`、ms で比べる。先頭だけ。中が空のときだけ） |
| 回収 | 誰でも `mv "$dir" "$dir.stale.$$.$RANDOM"`（`lib.sh:153-164`）。戻せなければ退避のまま | 先頭だけが `lock_recover`（`verify-run.sh:1459`）。退避は `<lock>.gone-*`、戻せなければ保有中と読む（`lock_settle_gone` `:1382`） |
| 解放 | `product_lock_release`（`lib.sh:200-205`）: token を読んで `rm -rf` | `lock_release_held`（`machine-lock.sh:198-257`、D12）。`needs-head` を受けても D5 は呼ばない（S5）。サブシェルからは拒む（§5） |
| ガードの回収 | `deadline-guard.sh:85-88`: `product_lock_is_stale` → `product_lock_take_stale` | `product_lock_recover_only` → `lock_recover_only`（`verify-run.sh:2011`、D6）。`mkdir` しない |
| 呼び手 | `supervisor.sh:78`（取得）・`:82`（EXIT で解放）・`:83-84`（INT・TERM は `exit`）、`deadline-guard.sh:86-87` | 同じ。`supervisor.sh` は関数名が変わらないので書かない |

supervisor.lock だけの性質（事実）:

- 記録の pid は常に取得したシェルの `$$`（`supervisor.sh` は 1 回だけ取る、`:78`）。`LOCK_OWNER_PID`・`LOCK_WANT_TOKEN`・引渡し（D4）・子のグループ（D9）を使わない。守りたい子（runner）は `setsid` で別のセッションに置かれ（`supervisor.sh:233-236`）、台帳（`ledger acquire … pgid=$runner`、`:238`）と次の監督役・ガードの回収（`reclaim_ledger`）が止める。ロックは子を守らない（`supervisor.sh:33-35`）
- `supervisor.sh:48`・`deadline-guard.sh:28` は `set -u` だけ（`set -e` ではない）。読み込み口は `set -e` の下では読み込まない（`machine-lock.sh:43-47`）ので、今の 2 つの呼び手は条件を満たす
- `MACHINE_LOCK_LOADED` は export されない（`machine-lock.sh:98`）。監督役が起こす `run-server.sh up`（別プロセス）は自分で読み込む
- 本番の解放は `supervisor.sh:82` の EXIT（main シェル）だけ。サブシェルから取得・解放するのは既存の試験（`product-supervisor-3312.test.ts:629-637` の 8 者の取り合い）だけ（事実、`git grep product_lock_`）

## 1. (a) 不変条件（どの経路でも成り立つ文）

土台は PR1a の D12（§1.14「release が直接消すのは自己 pid かつ G 空のときだけ」）と §1.8 の守る条件 (1)〜(5)。supervisor.lock は引渡し・子のグループを持たないので (6) は当てはまらない。S1〜S11 の文は 1 回目から変えていない（S5・S6 は「呼び手の無い経路は拒む」の決定 2 に合わせて**狭めた**。消す側への変更は無い）。S12 は個別の決定（予算 0 で札の後ろ）で足した。

| # | 不変条件 | 根拠（事実） |
|---|---|---|
| S1 | **異なる token の保有区間は重ならない**（新しい実装どうし・前提 P1〜P3 の下。旧版との混在は §4 の範囲に狭める） | §1.8 の (1)〜(5)。`mkdir`・回収の `mv`・owner の無い `<lock>` の `rmdir` をするのは札の先頭 1 人だけ（`verify-run.sh:1607-1609`・`:2034-2039`） |
| S2 | **取ったと言えるのは、先頭が `mkdir` した `<lock>` に owner を排他作成し、読み直しで自分の token を見たときだけ**。取得の予算は常に 0（1 回で断る） | `lock_obs_create`（`verify-run.sh:1010-1033`）。予算 0 は `la_deadline = start`（`:1559`）で 1 周 |
| S3 | **回収（退かす・`rmdir`）は札の先頭だけ**（取得の先頭か D6 のガードの先頭）。判定は owner の **1 回の読み**から。死んだと読むのは、pid が ESRCH のとき、または記録に空でない `lstart=` があり、`kill -0` の pid の観測が alive か EPERM で、PR1a-f の `machine_lock_pid_identity` が `reused` と答えたときだけ（D7。TZ の違いだけなら関数が `alive` と答える）。それ以外（EIO・関数の `unknown:lstart|etime:…`・関数が `reused` と言わない EPERM・別 host）は生きている／不明で、**不明は取らない・消さない・解放しない** | `lock_obs_kill0`（`:848-856`。EPERM は `unknown:pid:EPERM`）、`lock_holder_state`（`verify-run.sh:1107-1112`）、PR1a-f の `machine_lock_pid_identity`（PR1a-f の設計 §4.1。今の `machine_lock_lstart_state` `machine-lock.sh:111-127` を置き換える） |
| S4 | **解放が直接消すのは、記録の token が自分の token で、記録の pid が呼び手自身（main シェル〔`BASH_SUBSHELL=0`〕の `$$` で、`kill -0 $$` が alive）のときだけ**。supervisor.lock の記録は `pgid=` を持たないので G の判定は「空」に倒れる。それ以外の自分の token の記録は `needs-head`（消さない）、pid が観測できなければ `deferred`。missing・corrupt・他の token は canonical を消さない。解放は 1 回きり（2 回目は `none`） | `machine-lock.sh:198-257`（§1.14 の表） |
| S5 | **`product_lock_*` は D5（`lock_release_as_head`）を呼ばない**（狭めた。決定 2）。`needs-head`・`deferred` を受けた解放は記録を残し（消さない側）、記録の pid＝監督役の `$$` が死んだ後に次の先頭（取得かガードの D6）が回収する。supervisor の EXIT は終わる途中なので再試行しない。D5 の行は表で「不可能」 | `needs-head` に至るのは `kill -0 $$` が 2 回の読みで食い違うときだけ（F3）。本番の呼び手は main シェルの EXIT だけ（§0） |
| S6 | **bash の呼び手は main シェル**。`product_lock_release`・`product_lock_recover_only` はサブシェル（`BASH_SUBSHELL≠0`）からの呼び出しを**拒む**（exit 2、何も触らない。狭めた。決定 2）。サブシェルからの**取得**は拒まない: 本番には無いが、既存の 8 者の試験（`3312.test.ts:629-637`）が依り、拒むと期待（GOT がちょうど 1）が 0 になる。その形は `acquire-head` と同じ判定を通り、記録の pid が親の `$$` になるだけ（表の呼び手にしない理由。§2.1） | `machine-lock.sh:240`。8 者の試験の期待は「GOT が 1」だけ。勝者の解放は拒まれ、ロックは `bash -c` の終了後に次の先頭が回収する（試験はそれを見ない） |
| S7 | **自己グループの例外（pid＝pgid＝自分なら G を判定しない）は supervisor.lock では起きない**。記録に `pgid=` を書かない（決定）。supervisor は**背景の子を残す呼び手**（runner は `&` と `setsid`、サーバーは `up` が起こす。INT・TERM の経路では子が生きたまま EXIT が直接消す）だが、自己グループの例外の前提「解放の前に子をすべて待つ」に頼らない。それでも D9 の別グループが要らないのは、(1) 次の取得者の最初の段が台帳の RECLAIM（`supervisor.sh:124-148`）で、残った runner・サーバーを止めてから SAFETY・RUN に進む、(2) ガードはロックを取らず作業もしない、(3) runner が `planned` のまま残った窓も marker で見つかる、の 3 つで子が守られるから（親 §1.14「背景の子を残す呼び手は D9 の別グループ」への答え: supervisor.lock は台帳が代わる） | `machine-lock.sh:229`、§1.14 の「例外の限界」、`supervisor.sh:124-148`・`:233-238` |
| S8 | **ガード（D6）は `mkdir` しない**。札は全ての経路で `done`。回収の結果はガードの exit code に効かせない（今どおり） | `lock_recover_only`（`verify-run.sh:2011-2063`） |
| S9 | **読み込みに失敗したら取らない**: `product_lock_acquire` は 1 を返し（監督役は exit 75、文面 `loader` で「他の監督役が持っている」と区別する）、ガードはロックの回収だけを飛ばし（結果 `unloaded`、文面 `loader`）、台帳の回収と確定は今どおり行う。判定は lib.sh 自身が持つ `PRODUCT_MACHINE_LOCK_OK` で、run-lock.sh 経由で読まれたかに依らない（§5.2） | 決定（`machine-lock.sh:32-33`「the caller must treat that as "not acquired", never run unlocked」） |
| S10 | **1 つのシェルが持つ machine-lock は 1 つ**。`product_lock_*` は**呼ぶたびに**、大域変数（`LOCK_OWNER_CODEC`・`LOCK_OWNERLESS_GRACE_MS`・`LOCK_OWNER_EXTRA`）を自分の値にし、`LOCK_WANT_TOKEN`・`LOCK_OWNER_PID`・`LOCK_PENDING_TOKEN` を空にし、**関数の差し替え**（`machine_lock_use_kv_codec` が定義する `lock_parse_owner_text`・`lock_format_owner`）も置き直してから machine-lock の操作を呼ぶ（source の時点で設定しない。PR1b の run-lock が同じシェルで別の値・別の関数を置いても混ざらない。PR1b の側の同じ約束は PR1b の設計 §4.3 の「あわせて」〔`run-lock.sh` は source の時点で大域の状態を変えず、`lock_note_recovered` などの差し替えは `run_lock_*` を呼ぶたびにそのロックのパスに限る〕） | 決定（`verify-run.sh:661-670` の大域変数は 1 組。`machine-lock.sh:135-171` は変数でなく関数を差し替える〔Claude 5 P3〕） |
| S11 | **取得が生きた記録に対して断るとき、`lib.sh` は stderr に何も書かない**（文面は `PRODUCT_LOCK_ERROR` に入れ、呼び手が出す）。不明・札の取り下げ・戻しなど machine-lock 自身の `verify-run:` の行は出てよい | 既存の試験 `product-supervisor-3312.test.ts:625`（`expect(res.stderr).toBe('')`）。**未確認**: 生きた記録・予算 0 の 1 周で `lock_acquire_path` が何も書かないこと（目で見た範囲では `:1610-1720` が書くのは unknown・`owner-exists`・`owner-not-ours`・`write-failed` だけ）。実装の契約の最初の赤の候補 |
| S12 | **どの呼び手も、どの結果でも自分の札を残さない**。予算 0 の取得が札の後ろに並んだら、判定もせず札を取り下げて（`done`）抜け、文面 `queue`（「前の札 <t>〔pid N〕が先頭にいた。この監督役は札を取り下げ、ロックを判定していない」）で exit 75 の「他の監督役が持っている」と区別する（個別の決定。`mark-done` 自体の失敗は F31） | `lock_acquire_path` の期限の枝（`verify-run.sh:1697-1704` の `lock_retire_own_ticket`）。`lock_recover_only`・`lock_release_as_head` も全経路で `lock_retire_own_ticket` |

前提（S1 が成り立つ範囲。事実でなく前提として書く）:

- **P1** 書き手と読み手は同じ machine（`<base>` はローカル）。`host=` の違いは「別の machine」と読み、回収しない（F10）
- **P2** 新旧の混在は「同期の前の朝」の 1 回（§4）。同期のタイミングは**未確認**（監督役が動いている間に同期されると §4 の 3 行目が当たる）
- **P3** 生死の判定の時刻の比較は PR1a-f の `machine_lock_pid_identity` を呼ぶ（§2.1）。PR1c はその関数を持つ PR1a-f に依存し、マージの順は **PR1a-f → PR1c**。PR1c 単独の版（PR1a-f の前に入る版）は作らない

## 2. (b) 状態と遷移の表（記録の形 × 呼び手 × 観測 → 結果）

### 2.1 列挙

**記録の形（11）**: 操作が読む時点の supervisor.lock の状態。1 回目の 7 形に、人が消すまで残る形を区別するための 4 形（`stale-old`・`ownerless-tmp`・`other-eperm`・`other-host`）を足した（共通の決定 1・3。`other-eperm` は 2 回目までの `other-tz` を、TZ を PR1a-f の関数に寄せた 3 回目で置き換えた）。

| 形 | 中身 |
|---|---|
| `absent` | `<base>/supervisor.lock` が無い（退避も無い） |
| `stale-old` | canonical が無く、旧版の退避 `<lock>.stale.*` だけがある。新しい読み手は読まない（`.gone-` の形でない。`verify-run.sh:1277-1278`）ので、全セルが `absent` と同じ（P3-6） |
| `ownerless` | `<lock>` はあるが owner が無く、中が空 |
| `ownerless-tmp` | `<lock>` に owner が無く、旧版の `owner.tmp.<pid>` だけがある（旧版が `mkdir` と `mv` の間で死んだ。`lib.sh:173-176`）。`lock_ownerless_empty` は `no`（`verify-run.sh:1305`）で誰も取らない。**PR1a-f で塞ぐ**。それまでは文面 `tmp` で人に知らせ、消さない |
| `corrupt` | owner はあるが `pid=` か `token=` が無い。生じ方は 2 つ: 取得中の SIGKILL（`lock_obs_create` が `: >` で作ってから `cat >>` で書く間。`verify-run.sh:1014-1020`。F17）と、後始末の `rm -f owner` の失敗（F15）。**PR1a-f で塞ぐ**（tmp→`mv` に戻す）。それまでは文面 `corrupt` で人に知らせ、消さない |
| `own` | 呼び手の token の記録（pid＝取得した main シェルの `$$`、`lstart=`・`started_at=` あり、`pgid=` 無し） |
| `other-plain` | 他の token の記録で `lstart=` が無いか空（F7）。D7 の関数を呼ばず pid だけで判定 |
| `other-lstart` | 他の token の記録で `lstart=` があり、`kill -0` の pid の観測が alive・ESRCH・EPERM 以外の失敗のどれか。alive のとき D7 が `machine_lock_pid_identity` を呼ぶ（TZ の違いもここ。旧版の記録で `started_at=` が無ければ関数は owner の mtime を使う、PR1a-f I5） |
| `other-eperm` | 他の token の記録で `lstart=` があり、`kill -0` が EPERM（別の利用者のプロセス）。D7 が `machine_lock_pid_identity` を呼び、`reused` なら死、それ以外は EPERM のまま（PR1a-f §4.1 の写像。文面 `eperm`） |
| `other-host` | 他の token の記録で `host=` が `LOCK_HOST` と違う（`hostname` の変化を含む。Claude 5 P2-5・PM Claude P3-5）。`lock_holder_state` が `kill -0` を呼ばずに alive と答える（`verify-run.sh:1108`）。文面 `host` で人に知らせ、消さない |
| `aside` | canonical の `<lock>` が無く、他の token の退避 `<lock>.gone-*` がある（戻しが途中で止まった） |

自分の token の退避は列挙しない: 自分の記録は自分が生きている間は回収されない（S3: pid が生きていれば、`machine_lock_pid_identity` は TZ の違いでも `alive` と答える）ので、自分の退避が生じるのは自分が死んだ後で、そのとき自分は解放を呼べない。1 回目の「TZ が同じ」という暗黙の前提は、PR1a-f の関数で前提でなくなった（PM Claude P2-3）。

**生死の判定の時刻の比較（決定、PM の処分 3・案 A）**: PR1c は独自の tz の包み（記録の `tz=` と読み手の `${TZ-}` の比較）を持たず、PR1a-f の `machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>`（PR1a-f の設計 `docs/design/machine-lock-owner-atomic-4288.md` §4.1・§4.2、`be8275def`） を呼ぶ（読み込み口の D7 の包み `lock_record_state` が呼ぶので、lib.sh は関数を足さず、記録に `tz=` も書かない）。契約: 標準出力に 1 行 `alive | reused | unknown:<point>:<errno>`（`<point>` は `lstart` か `etime`）、終了コードは常に 0、呼ぶのは `kill -0` の pid の観測が alive か EPERM のときだけ。写像（PR1a-f §4.1）: 元が alive → `alive` は生、`reused` は死（G を見る。supervisor.lock は `pgid=` を書かないので死）、`unknown:…` は不明。元が `unknown:pid:EPERM` → `reused` は死、それ以外は EPERM のまま。`<started-at-ms>` は `started_at=`、無ければ owner の mtime（PR1a-f I5）。2 回目にあった「`tz=` の値に改行が入ると行を差し込める」件（PM Claude P3-3）は、PR1c が `tz=` を書かなくなったので PR1c には無く、記録の欄の検査は PR1a-f の側に寄せた。依存: PR1c は PR1a-f の後にマージし（PR1a-f → PR1c）、PR1c 単独の版は作らない。

**呼び手（9）**: 本番の呼び手が無い経路は表に残し、セルを「拒否」か「不可能」にする（共通の決定 2）。

| 呼び手 | 操作 | 到達 |
|---|---|---|
| `acquire-head` | `product_lock_acquire`（予算 0）で、札の先頭になれた | 到達（`supervisor.sh:78`） |
| `acquire-behind` | 同じで、生きた札が前にある（別の取得・ガードが先頭） | 到達。判定せず札を取り下げて `refused(queue)`（S12） |
| `release-main` | `product_lock_release` を main シェルから（`supervisor.sh:82` の EXIT）。保持の印あり | 到達 |
| `release-subshell` | 同じをサブシェルから | **拒否**（`release-in-subshell`、§5） |
| `release-unheld` | 保持の印が無いときの `product_lock_release`（2 回目の解放・既存の試験 `:641` の形） | 到達（`none`） |
| `guard-head` | ガードの `product_lock_recover_only`（D6、予算 10）で先頭になれた | 到達（`deadline-guard.sh:86-87`） |
| `guard-behind` | 同じで、先頭になれない | 到達（`not-head`） |
| `d5-head`・`d5-behind` | D5 `lock_release_as_head` | **不可能**: `product_lock_*` は D5 を呼ばない（S5）。1 回目の `release-as-head`・`release-as-head-behind` を改名して残した（Claude 5 P2-1・PM Claude P3-3） |

除外（呼び手にしない）: サブシェルからの**取得**（S6。拒まず、`acquire-head`・`acquire-behind` と同じ判定。記録の pid が親の `$$` になる。PM Claude P3-2）。

**観測の軸**: pid の軸とグループの軸を分ける（共通の決定 3）。

- **pid の軸（3 値）**: 形ごとに、結果を決める観測を 1 つ決めて 3 値にする（試験はその観測を作るか注入する）。コードでは EPERM も `unknown`（`lock_obs_kill0` `:848-856`、`unknown:pid:EPERM`。1 回目の F1 と雛形の `OBS_MEANING` は「alive と読む」と書いていて誤り。Claude 5 P2-3・P3）。**この表の `unknown` の列は EPERM 以外の不明**（EIO など）で、文面は `unk`。記録の pid の EPERM は §3 の F1 だけが受け、文面は `eperm`（同じ入力に 2 つの期待を置かない。PM Claude P2-A）
- **グループの軸（`-g`）**: `none`（記録に `pgid=` が無い）だけが到達する。`alive`・`gone`・`unknown` は不可能（supervisor.lock に `pgid=` を書く者がいない。S7、ラベルの改行は §5 で拒む）。雛形の `GROUP_AXIS`

| 形 | 決める観測（pid の軸） | `alive` | `gone` | `unknown` |
|---|---|---|---|---|
| `absent`・`stale-old` | 取得: `<lock>` の `mkdir`（`lock_obs_mkdir` `:976`）。ガード: `<lock>` の一覧（`lock_obs_list` `:859`）。解放: 読まない | 間に誰かが作った（EEXIST／一覧が出た） | 作れた／ENOENT | 他の errno |
| `ownerless` | `<lock>` の mtime の年齢（`lock_obs_mtime` `:1039`） | 60 秒以下（作りかけ） | 60 秒より古い | `stat`・一覧の失敗 |
| `ownerless-tmp`・`corrupt`・`other-host` | 観測しない（判定に使われないことを見る） | — | — | — |
| `own` | 解放: `kill -0 $$` | 生きている | ESRCH（不可能） | 2 回とも失敗（注入） |
| `other-plain` | `kill -0` の記録の pid | 生きている | ESRCH | EIO など（ESRCH・EPERM 以外。EPERM は F1） |
| `other-lstart` | `kill -0` の後、生きた pid の `machine_lock_pid_identity`（D7） | 生きていて関数が `alive`（TZ の違いだけのときも） | ESRCH、または関数が `reused` | `kill -0` の EIO など（ESRCH・EPERM 以外）、または関数が `unknown:lstart|etime:…`（F6） |
| `other-eperm` | `kill -0` が EPERM の後の `machine_lock_pid_identity`（D7） | 関数が `alive`（EPERM のまま） | 関数が `reused`（死んだ監督役の pid を別の利用者が再利用） | 関数が `unknown:…`（EPERM のまま） |
| `aside` | 退避の記録の `lock_record_state` | 生きている | ESRCH | EIO など（ESRCH・EPERM 以外。EPERM は F1） |

`other-lstart` の pid が死んでいる場合は `kill -0` が先に ESRCH を返し、関数（`ps`）を呼ばない（PR1a-f §4.1 の「alive か EPERM のときだけ呼ぶ」）。既存の `:647` の試験の割込み（`ps` の stub）が新しい形で働かない理由（§5.1）。

### 2.2 表

セルは「結果（文面）／ 記録の行方 ／ 札」。記録の行方: `unchanged`・`absent`（その記録が消える）・`mine`（呼び手の記録が canonical になる）・`restored`（退避が canonical に戻る）。§3 の失敗の行だけが使う行方: `aside`（退避のまま残り保有中と読まれる）・`own-half-left`・`own-empty-left`（この取得が作りかけた `<lock>` が残る）。札: `retired`（取って `done` にした）・`none-taken`（取らない）、§3 だけ `left-until-retirable`。

結果の値はコードの結果の集合から書く（PM Claude P2-1）: 取得は `lock_acquire_path` の 0/1（`acquired`・`refused`）、解放は `LRH_RESULT`（`none|released|kept|deferred|needs-head`）、ガードは `LRO_RESULT`（`removed|kept|restore-failed|absent|not-head`）、D5 は `LRAH_RESULT`（`released|missing|deferred|kept|unknown|not-head`）。lib.sh が足すのは `rejected`（§5、exit 2）とガードの `unloaded`（S9）だけ。雛形はこの集合を `machine-lock.sh`・`verify-run.sh` から読み出して（行頭が `#` の注釈の行は読まない。`machine-lock.sh:194` の `(LRH_RESULT=needs-head)` のような注釈だけが残っても集合が欠けないことにならないように。PM Claude P3-4）手書きの `CODE_RESULTS` と比べ、各値がいずれかの行（§2・§3・§5）に現れることを確かめる。

文面（取得の `PRODUCT_LOCK_ERROR`、ガードが人に見せる stderr の 1 行）:

| 種類 | 文面 | 優先 |
|---|---|---|
| `loader` | `busy: the machine lock could not be loaded (<reason>); not taken` | 1 |
| `unk` | `busy: <dir> cannot be judged (point=… path=… errno=…); not taken` | 3 |
| `eperm` | `busy: <dir> held by pid N, which belongs to another user (EPERM): the holder may have died and its pid been reused — check and remove <dir> by hand (#4288 PR1a-f)` | 2 |
| `queue` | `busy: queue ticket <t> (pid N) was ahead for <dir>; this supervisor withdrew its ticket and did not judge the lock` | 4 |
| `corrupt` | `busy: <dir>/owner is not a lock record (pid= or token= missing: an acquisition died while writing it) — not taken; remove <dir> by hand when no supervisor runs (#4288 PR1a-f)` | 5 |
| `tmp` | `busy: <dir> has no owner but holds <names> (an older supervisor died while taking it) — not taken; remove <dir> by hand (#4288 PR1a-f)` | 5 |
| `host` | `busy: <dir> held by pid N on host <H>, not this host <h> — not judged; if the host name changed, remove <dir> by hand (#4288 PR1a-f)` | 5 |
| `aside` | `busy: <dir> is held by a record moved aside (<gone>) that could not be put back` | 5 |
| `rec` | `busy: <label> pid N holds <dir>`（今の文面、`lib.sh:188`） | 6 |
| `taking` | `busy: <dir> is being taken by another supervisor right now`（今の文面、`:190`） | 7 |

優先は小さい数が勝つ。同じ数（5）の種類は条件が互いに排他で、重なったときは表の上の行が勝つ。`eperm` と `unk` は同じ 1 つの記された不明から決まり、両方にはならない（`eperm`＝`point=pid` かつ `errno=EPERM`、`unk`＝それ以外。PM Claude P2-A）。

**文面の出どころ**（PM Claude P2-B。雛形の `MESSAGE_SOURCES`）: 種類は、machine-lock の操作が返った後に残した**大域変数**か、断った後に lib.sh が**文面のためだけに読むもの**（判定と回収には使わない。今の `run_lock_field` の使い方と同じ）から決める。同じ失敗がもう一度起きる保証は無いので、不明（`unk`・`eperm`）は読み直さず、操作が記した値だけから決める。

| 種類 | 出どころ（大域・読み） | 条件 |
|---|---|---|
| `loader` | `PRODUCT_MACHINE_LOCK_OK`（lib.sh の大域。lib.sh が `machine-lock.sh` を source したときに 1 回だけ決まる。§5.2） | 0 でない。machine-lock の操作を呼ばない |
| `eperm` | 取得: `LOCK_UNKNOWN`（`lock_note_unknown` が 1 周の最初の不明だけを `point=… path=… errno=…` で記す `verify-run.sh:1075-1077`。周の頭で空にする `:1563`。予算 0 は 1 周なので返った後も残る）。ガード: `LRO_UNKNOWN`（`:2018`・`:2053`） | `point=pid` で `errno=EPERM`（記録の pid の `kill -0`。`lock_holder_state` `:1109`） |
| `unk` | 同上 | 空でなく、`eperm` でない |
| `queue` | `la_blocker`（`lock_acquire_path` が周の頭で空にし `:1583`、前の生きた札を入れる `:1601`。関数は `local` を使わないので返った後も 1 周目の値が残る）。取得だけ（ガードは先頭になれなければ `not-head` で文面を出さない） | 空でない |
| `corrupt` | 文面のための owner の 1 回の読み（`<lock>/owner` を `lock_parse_owner_text` に通す） | owner があり、`pid=` か `token=` が空 |
| `tmp` | 文面のための `<lock>` の一覧 | owner が無く、`owner.tmp.*` がある |
| `host` | 文面のための owner の読み（`corrupt` と同じ 1 回） | 記録の `host=` が `LOCK_HOST` と違う |
| `aside` | `LOCK_GONE_PENDING`（`lock_settle_gone` が記す `:1381-1421`。周の頭で空にする `:1564`）と、文面のための owner の読み | 空でなく、canonical の `<lock>` に記録が無い（戻しが失敗した。戻せた `aside` × `alive` は記録があるので `rec`） |
| `rec` | 文面のための owner の読み | `pid=` と `token=` がある記録（上のどれにも当たらない） |
| `taking` | 上のどれにも当たらない | owner が無い。札の `ln` の失敗（F29）もここ: `lock_acquire_path` は stderr に 1 行出して 1 を返すだけで不明を記さず（`:1576-1579`）、自分の札も残らない（`LOCK_TICKET` は空）ので、今の大域変数からは `unk` を導けない（`unk` に揃える読みは足さない。小さい方を選んだ） |

ガードが stderr に 1 行出すのは、`unloaded` の `loader`、`LRO_UNKNOWN` が空でないときの `unk`・`eperm`（`kept` と、F30 の `not-head`）、`kept` の `corrupt`・`tmp`・`host` だけ（exit code は変えない。S8）。それ以外の種類（`rec`・`taking`・`aside`）はガードでは出さない（表の `kept` の行が文面を持たない）。

| 形 / 観測 | acquire-head | acquire-behind | release-main | release-subshell | release-unheld | guard-head | guard-behind | d5-head・d5-behind |
|---|---|---|---|---|---|---|---|---|
| absent・stale-old / alive | refused(taking) / unchanged / retired | refused(queue) / unchanged / retired | kept / unchanged / none-taken | 拒否 | none / unchanged / none-taken | kept / unchanged / retired | not-head / unchanged / retired | 不可能 |
| absent・stale-old / gone | **acquired / mine** / retired | refused(queue) | kept | 拒否 | none | absent / unchanged / retired | not-head | 不可能 |
| absent・stale-old / unknown | refused(unk) / unchanged | refused(queue) | kept | 拒否 | none | kept(unk) / unchanged | not-head | 不可能 |
| ownerless / alive | refused(taking) / unchanged | refused(queue) | kept | 拒否 | none | kept / unchanged | not-head | 不可能 |
| ownerless / gone | **acquired / mine** | refused(queue) | kept | 拒否 | none | **removed / absent** | not-head | 不可能 |
| ownerless / unknown | refused(unk) / unchanged | refused(queue) | kept | 拒否 | none | kept(unk) / unchanged | not-head | 不可能 |
| ownerless-tmp / 3 値とも | refused(tmp) / unchanged | refused(queue) | kept | 拒否 | none | kept(tmp) / unchanged | not-head | 不可能 |
| corrupt / 3 値とも | refused(corrupt) / unchanged | refused(queue) | kept | 拒否 | none | kept(corrupt) / unchanged | not-head | 不可能 |
| own / alive | 拒否 | 拒否 | **released / absent** | 拒否 | none | 不可能 | 不可能 | 不可能 |
| own / gone | 拒否 | 拒否 | 不可能 | 拒否 | none | 不可能 | 不可能 | 不可能 |
| own / unknown | 拒否 | 拒否 | deferred / unchanged | 拒否 | none | 不可能 | 不可能 | 不可能 |
| other-plain・other-lstart / alive | refused(rec) / unchanged | refused(queue) | kept | 拒否 | none | kept / unchanged | not-head | 不可能 |
| other-plain・other-lstart / gone | **acquired / mine** | refused(queue) | kept | 拒否 | none | **removed / absent** | not-head | 不可能 |
| other-plain・other-lstart / unknown | refused(unk) / unchanged | refused(queue) | kept | 拒否 | none | kept(unk) / unchanged | not-head | 不可能 |
| other-eperm / alive | refused(eperm) / unchanged | refused(queue) | kept | 拒否 | none | kept(eperm) / unchanged | not-head | 不可能 |
| other-eperm / gone | **acquired / mine** | refused(queue) | kept | 拒否 | none | **removed / absent** | not-head | 不可能 |
| other-eperm / unknown | refused(eperm) / unchanged | refused(queue) | kept | 拒否 | none | kept(eperm) / unchanged | not-head | 不可能 |
| other-host / 3 値とも | refused(host) / unchanged | refused(queue) | kept | 拒否 | none | kept(host) / unchanged | not-head | 不可能 |
| aside / alive | refused(rec) / restored | refused(queue) | kept | 拒否 | none | kept / restored | not-head | 不可能 |
| aside / gone | **acquired / mine** | refused(queue) | kept | 拒否 | none | absent / absent | not-head | 不可能 |
| aside / unknown | refused(unk) / restored | refused(queue) | kept | 拒否 | none | kept(unk) / restored | not-head | 不可能 |

札の列は省略したセルも、取得とガードは `retired`、解放は `none-taken`。`refused(queue)` は全て `unchanged / retired`、`kept`（解放）は `unchanged / none-taken`、`none` は `unchanged / none-taken`、`not-head` は `unchanged / retired`。

数: 11 形 × 9 呼び手 × 3 観測 ＝ **297 セル**。うち**拒否 39**（`release-subshell` の 33 と `own` × 取得の 6）、**不可能 73**（D5 の 66、`own` × ガードの 6、`own` × `release-main` × `gone` の 1）、**試験の行 185**。

拒否・不可能の理由:

- `release-subshell`（33、拒否）: `product_lock_release` は `BASH_SUBSHELL≠0` で拒む（§5）。本番の解放は main シェルの EXIT だけ（§0）。既存の 8 者の試験の期待（GOT が 1）は変わらない
- `own` × 取得（6、拒否）: このシェルが既に保持している（`LOCK_HELD_PATH` が空でない）取得は拒む。監督役は 1 シェルで 1 回だけ取る（`supervisor.sh:78`）
- D5（66、不可能）: `product_lock_*` は D5 を呼ばない（S5）
- `own` × ガード（6、不可能）: ガードは取得しない（D6）。ガードの token の記録は存在しない
- `own` × `release-main` × `gone`（1、不可能）: main シェルの `$$` は呼んでいる本人で、`kill -0 $$` は ESRCH にならない

読み方の要点（セルの根拠、事実）:

- `release-*` は `own` 以外の形で canonical を消さない（`machine-lock.sh:208-226`）
- `acquire-head` × `gone` は回収（`lock_recover`）の後 `continue` で同じ周の続きに入り、予算 0 でも `mkdir` まで進む（`verify-run.sh:1660-1666`。期限の確かめ `:1697` は `continue` で飛ぶ）
- `acquire-behind` は札の前に生きた札がある（`la_blocker`）ので `mkdir`・回収・判定に進まず、期限の枝で札を取り下げて 1 を返す（`:1697-1704`）。形に依らず `refused(queue)`（S12、Claude 5 P2-2 への個別の決定）
- `aside` × `alive`・`unknown` は先頭が退避を戻す（`lock_restore_from_gone` `:1327`）。取得は断り、ガードは `kept`
- `ownerless` × `gone` × `acquire-head` は先頭の `rmdir`（`lock_expire_ownerless` `:1501-1535`）→ `mkdir`。既存の試験 `:603-608` の期待のまま
- `ownerless-tmp` は `lock_ownerless_empty` が `no` なので `lock_expire_ownerless` が何もせず、`mkdir` が EEXIST、owner が missing で `LOCK_HELD_BY` が空のまま期限の枝で断る（`:1301-1306`・`:1610`）。ガードは `LRO_RESULT=kept`（`:2027-2031`）

### 2.3 表と不変条件の突き合わせ（試験の雛形で表そのものに掛ける）

雛形は、実装を呼ばずに表のデータへ次を掛ける（表を直すと落ちる）:

1. `acquired` は `acquire-head` だけで、行方は `mine`（S2）
2. `*-behind` の行の行方は全て `unchanged`、`acquire-behind` は全て `refused(queue) / unchanged / retired`（S1・S3・S12）
3. 観測が `unknown` の行は、行方が `unchanged` か `restored` で、結果が `acquired`・`released`・`removed` でない（S3）
4. `own` 以外の記録を消す（行方が `absent`・`mine`）のは `acquire-head`・`guard-head` の `gone` だけで、`corrupt`・`ownerless-tmp`・`other-host` は誰も消さない（S3・決定 1）
5. `own` を消すのは `release-main` × `alive` だけ（S4。1 回目の D5 経由の 2 行は不可能に移った）
6. `release-subshell` と D5 の行は 1 つも無い（S5・S6）
7. `release-unheld` は全て `none / unchanged / none-taken`（S4 の 1 回きり）
8. 解放は `own` 以外の記録を動かさない（S4）
9. 失敗で消す側（`own-only`）は F13・F14 だけ（§3）
10. 取得の `refused` には文面があり、文面を持つのは `refused` とガードの `kept` だけ（S11）
11. 人が消す形（`corrupt`・`ownerless-tmp`・`other-host`）は、`acquire-head`・`guard-head` の全観測でその文面を出す（決定 1）。人に知らせる文面の失敗の行は記録を消さない
12. `restored` は `aside` の形だけ、ガードは `mine` にしない（S8、PM Claude P3-7）
13. §2 の行は、取った札を必ず `retired` にし、解放は札を取らない（S8・S12）
14. `stale-old` の列は `absent` と同じ（§4、P3-6）
15. 失敗の行で他者の記録を消す（`absent`・`mine`）のは、死んだと示されたもの・既に消えたものだけ（F5・F22・F27・F31）

## 3. (c) 外部の呼び出しごとの失敗の倒れ方（呼び手 × 失敗 → 結果・行方・札・文面）

「消す側」＝その失敗で何かを消す（取る）向き、「消さない側」＝何も消さず・取らず、記録を残す向き。supervisor.lock の経路で消す側に倒れるのは、**この取得が作ったもの**（排他作成で開いた owner・自分の `mkdir` した `<lock>`）の後始末だけ（F13・F14）。表は雛形の `FAILURE_TABLE`（型 `{ point, errno, direction, callers: { [呼び手]?: 結果 }, excluded: { [呼び手]?: 理由 } }`。呼び手が答えられない結果は typecheck が落とす）。到達する 6 つの呼び手（`acquire-head`・`acquire-behind`・`release-main`・`release-unheld`・`guard-head`・`guard-behind`）は、行ごとに `callers` か `excluded` の**ちょうど一方**に書く。書き忘れ・両方に書いたものは、行を作る関数 `failure()` の型（`Complete`）で typecheck が落とす（PM Claude P3-5。雛形に `@ts-expect-error` の対照と、実行時の同じ検査を置いた）。`excluded` の理由は 1 語の閉じた集合: `behind`（札の後ろで、この点の前に札を取り下げる・`not-head`）・`pre-queue`（札の段かそれより前の失敗で、先頭か後ろかが決まる前。head の列が両方の答え）・`unheld`（保持の印が無い解放は何も読まず `none`）・`own-pid-only`（解放は自分の記録と `$$` しか見ない）・`not-on-path`（その呼び手の関数がこの点を通らない）・`no-effect`（解放が通るが supervisor.lock には自分の退避が無く何も変わらない）。下の表の「release-main・他」の列で書いていない呼び手は `excluded` にある。`as-form` は §2 のその形のセルのまま。

| # | 点（場所） | 失敗 | 向き | acquire-head | guard-head | release-main・他 |
|---|---|---|---|---|---|---|
| F1 | `pid`（`lock_obs_kill0` `verify-run.sh:848`） | EPERM のまま（`lstart=` の無い記録、または `machine_lock_pid_identity` が `reused` と言わない。`lstart=` のある記録では `other-eperm` × `alive`・`unknown` と同じ答え。`reused` なら `other-eperm` × `gone`） | 消さない | refused(eperm) / unchanged | kept(eperm) | — |
| F2 | 同上 | EIO など | 消さない | refused(unk) | kept(unk) | release-main: deferred |
| F3 | `$$` の `kill -0`（`lock_release_held` の自己の確かめが不明、次の読みが alive） | EIO が 1 回 | 消さない | — | — | release-main: needs-head / unchanged（D5 は呼ばない。S5） |
| F4 | `kill -0` がゾンビを alive と読む | ガードの KILL の直後で launchd が刈り取る前 | 消さない | refused(rec) | kept | —（刈り取りの後の先頭が回収。旧版の `proc_running` はゾンビを死と読んだ。PM Claude P3-4） |
| F5 | 監督役が `stop_and_wait` の KILL で死に EXIT が走らない（`lib.sh:88-109`） | — | 消さない | acquired / mine（翌朝） | removed / absent | —（Claude 5 P3 の「D6 と EXIT の順序」の行） |
| F6 | `machine_lock_pid_identity` の `unknown:lstart:…`・`unknown:etime:…`（`ps -o lstart=`・`ps -o etime=`・`date` の失敗・空。PR1a-f §4.1 の 2・4・6） | 失敗 | 消さない | refused(unk)（元が EPERM なら refused(eperm)＝`other-eperm` × `unknown`） | kept(unk)（同じく kept(eperm)） | — |
| F7 | 書く時の `proc_lstart $$`（`lib.sh:66-68`） | 失敗して `lstart=` が空 | 消さない（新しい読み手は pid だけ） | refused(rec) | kept | —（旧い読み手は空を不一致と読む＝§4・§8 の判断 1） |
| F8 | `machine_lock_pid_identity` の 5（`lstart` の差が 900 秒の倍数かつ 26 時間以下） | 書き手と読み手の TZ が違う（生きた保有者） | 消さない | refused(rec)（関数が `alive`。`other-lstart` × `alive` と同じ） | kept | —（2 回目の文面 `tz` は外した） |
| F9 | `machine_lock_pid_identity` の `<started-at-ms>` | 記録に `started_at=` が無い（旧版の記録）: owner の mtime を使う（PR1a-f I5）。生きた保有者 | 消さない | refused(rec)（関数が `alive`） | kept | — |
| F10 | `LOCK_HOST`（`hostname`、`verify-run.sh:612`）と記録の `host=` | host 名が変わった | 消さない | refused(host) | kept(host) | —（**未確認**: 実機の `scutil --get HostName` が固定されているか） |
| F11 | `mkdir-lock`（`:976`） | EEXIST 以外 | 消さない | refused(unk) | — | — |
| F12 | `owner-create`（`:1010`） | EEXIST・他の記録を読み直した | 消さない | refused(rec) | — | — |
| F13 | 同上 | 開けない（10+i） | **自分の `mkdir` だけ戻す** | refused(unk) / unchanged | — | — |
| F14 | 同上・`owner-readback` | 開いた後の書き込みの失敗（40+i）・読み直しが不明（70+i） | **自分の owner と `<lock>` だけ戻す** | refused(unk) / unchanged | — | — |
| F15 | F13・F14 の後始末の `rm -f owner`（`fault:owner-unlink`） | 失敗 | 消さない | refused(unk) / own-half-left | — | —（残りは `corrupt` の形になり文面 `corrupt`） |
| F16 | 同上の `rmdir <lock>`（`fault:lock-rmdir`） | 失敗 | 消さない | refused(unk) / own-empty-left | — | —（60 秒の後に先頭が `rmdir`） |
| F17 | 取得中の SIGKILL（`: >owner` と `cat >>owner` の間） | — | 消さない | refused(corrupt)（次の取得） | kept(corrupt) | —（PR1a-f で tmp→`mv` に戻して塞ぐ） |
| F18 | 旧版が `mkdir` と `mv` の間で死んだ（`owner.tmp.<pid>` だけ） | — | 消さない | refused(tmp) | kept(tmp) | —（PR1a-f で回収） |
| F19 | owner の読み（`lock-owner`・`release-owner`・`recover-owner`・`gone-owner`・`reclaim-owner`） | EACCES・EIO | 消さない | refused(unk) | kept(unk) | release-main: deferred |
| F20 | 退避の一覧（`list-root`・`gone-lstat`） | 失敗 | 消さない | refused(unk) | as-form（`lock_settle_gone … \|\| true` の後 canonical を読む `:2032`） | — |
| F21 | `ownerless-rmdir`（`lock_expire_ownerless`） | 失敗 | 消さない | refused(unk) | kept(unk) | — |
| F22 | 回収の `rename-aside`（`:1463`） | ENOENT（誰かが先に消した） | 消さない | acquired / mine | absent / absent | — |
| F23 | 同上 | その他 | 消さない | refused(rec)（`lock_recover` は unknown を記さない `:1467`） | kept | — |
| F24 | `lock_recover` の戻しの `restore-mkdir`（`:1477`） | 失敗 | 消さない | refused(aside) / aside | restore-failed / aside | — |
| F25 | `lock_restore_from_gone` の `restore-mkdir`（`:1328`） | 失敗 | 消さない | refused(aside) / aside | kept / aside | — |
| F26 | `restore-rename`（`:1312`） | 失敗 | 消さない | refused(aside) / aside | kept / aside | —（空の `<lock>` を戻して退避を残す `:1319-1322`） |
| F27 | 回収の `rm -rf <gone>`（`:1472`、`\|\| true`） | 失敗 | 消さない | acquired / mine | removed / absent | —（死んだ退避が残り次の先頭が片付ける） |
| F28 | 解放の `rm -rf <lock>`（`machine-lock.sh:241`、`\|\| true`） | 失敗 | 消さない | — | — | release-main: released / unchanged（答えが実態と違う＝本文に無い指摘） |
| F29 | 札の `ln`（`lock_take_ticket` `:1212`） | EEXIST 以外 | 消さない | refused(taking) / none-taken（不明を記さず札も残らないので、文面の出どころから導けるのは `taking`。PM Claude P2-B） | not-head / none-taken | — |
| F30 | 札の列の一覧（`list-queue`） | 失敗 | 消さない | refused(unk) | not-head(unk) | — |
| F31 | 自分の札の `lock_mark_done` | 失敗 | 消さない | acquired / mine / left-until-retirable | as-form | acquire-behind: refused(queue) / unchanged / left-until-retirable、guard-behind: not-head / unchanged / left-until-retirable（後ろの呼び手も期限の枝で自分の札を取り下げる `:1698`・`:1908`。P3-5 の列挙で書き足した）。札は pid の死か期限＋60 秒で外れる。その間ガード・他の取得は `not-head`・`queue` |
| F32 | 前の札の `ps -o etime=`（`lock_pid_start_ms` `:1129`） | 失敗 | 消さない | refused(queue) | not-head | —（再利用と読まず、待つ） |
| F33 | 読み込み口（`machine_lock_load`） | `verify-run.sh` が無い・印が 1 つずつでない・`set -e` | 消さない | refused(loader) | unloaded(loader) / none-taken | acquire-behind: refused(loader)、guard-behind: unloaded(loader) / none-taken（読み込みが無ければ札を取らないので head と同じ行。P3-5 の列挙で書き足した）、release-main: none |
| F34 | `reclaim-rename`・`reclaim-rmdir`（戻しが不明な間の空の `<lock>`） | 失敗 | 消さない | refused(unk) | kept(unk) | — |

使わないもの（事実）: supervisor.lock の経路は **tmux を呼ばない**（`lib.sh:121-205` と読み込み口の節に tmux は無い）。`lock_drain_group`（`KILL_GRACE_SEC`）・`lock_hand_off`・`lock_child_wait`・`lock_release_as_head` も呼ばない（S5・S7）。

流用する既存の部品の倒れ方（事実）:

- `proc_lstart`（`lib.sh:66`）: 書く側だけに使う（記録の `lstart=` の値。旧い読み手と同じ形に揃えるため squeeze しない）。判定は PR1a-f の `machine_lock_pid_identity`。失敗は F7
- `run_lock_field`（`run-lock.sh:44-47`）: 取得が断ったときの文面だけに使う。判定には使わない。失敗は空の文字列（文面が欠けるだけ）
- `run_lock_pid_alive`（`run-lock.sh:50-56`、2 値）: 0＝`kill -0` か `ps -p` が成功（EPERM の生きた pid を含む）、1＝`kill -0` も `ps -p` も失敗（ESRCH に限らない。`ps` の失敗も 1 になる）、または pid が数字でない。ロックの判定には使わない（`proc_running` が台帳の回収に使う）。2 値のまま（§5.2）

## 4. 新旧の混在（supervisor.lock に限る）

同じチェックアウトの `lib.sh` を監督役とガードの両方が source するので、混在は「同期の前の朝」の 1 回に限る（§1.9 の切替の表の行。前提 P2、同期のタイミングは未確認）。

| 読み手・取得者 | 新しい記録（生きている） | 新しい記録（死んでいる） | `.gone-*` | `supervisor.queue/` | 空 `lstart=` の新しい記録 |
|---|---|---|---|---|---|
| 旧い取得者・旧いガード（`lib.sh` の旧版） | `pid=` と `lstart=` を `sed` で読める（`label=` もある）ので断る | 退かして回収（旧い穴） | 見えない（2 者が持ちうる） | 見えない（札を抜かす） | **死んだと読んで奪う**（F7） |
| 新しい取得者・ガード | — | 先頭が回収 | 先頭が片付け・戻し | 札の順 | pid だけで判定 |
| 新しい読み手 × 旧い記録（`host=`・`started_at=` 無し、`lstart=` あり） | 「この host」と読む（`machine-lock.sh:157`）、`machine_lock_pid_identity` は owner の mtime を `<started-at-ms>` に使う（F9、PR1a-f I5） | 回収 | — | — | — |

旧い `<lock>.stale.*`（旧版の退避）は新しい読み手が読まない（形 `stale-old`。`verify-run.sh:1277-1278`）。生きた記録がそこに残っていても守れない（§1.9 の (c) と同じ）。旧い `owner.tmp.<pid>` だけの `<lock>` は形 `ownerless-tmp`（文面 `tmp`、PR1a-f）。

## 5. (d) PR の切り方

- **PR1c は 1 本**（PR1a-f に依存。マージの順は PR1a-f → PR1c、PR1c 単独の版は作らない）: `scripts/agent-health/product/lib.sh`、`scripts/agent-health/product/deadline-guard.sh`、`tests/unit/scripts/agent-health/supervisor-lock-machine-lock-4288.test.ts`（この雛形を赤から緑に）、`tests/unit/scripts/agent-health/product-supervisor-3312.test.ts:647` の割込みの口、`changelog.d/4288.md` への統合（2 本目の work item の規則）、`dev-reports/module-reference/issue-4288-pr1c.md`（PR ごとの名前。PR1b は `-pr1b.md`）。依存は PR1a（develop に入っている）と PR1a-f（`machine_lock_pid_identity`）。PR1b（run-lock）と並行してよい（書くファイルが重ならない）。PR1a-f とは実装を並行してよいが、マージは PR1a-f が先。`changelog.d/4288.md` のマージは直列
- **API は呼び手と同じ PR**: `product_lock_recover_only`（D6 の包み）は呼び手 `deadline-guard.sh` と同じ PR で入れる。PR1a で入った `lock_recover_only`・`lock_release_held` は、PR1c で初めて本番の呼び手を持つ。`lock_release_as_head`（D5）は PR1c でも本番の呼び手を持たない（S5。1 回目の「初めて本番の呼び手を持つ」は誤り、Claude 5 P2-1）。消すもの: `product_lock_owner_alive`・`product_lock_is_stale`・`product_lock_take_stale`（呼び手は `lib.sh` 自身と `deadline-guard.sh:86-87` だけ）
- **呼び手の無い組み合わせは引数・文脈で拒む**（決定。拒んだら 2 を返し、`PRODUCT_LOCK_ERROR` に理由。何も触らない）。雛形の `REJECTIONS`（9）:
  - `product_lock_acquire`: 引数がちょうど 1 つ（ラベル）でない、ラベルが空・改行を含む（ラベルは `LOCK_OWNER_EXTRA` の 1 行になる。改行で `pgid=` などを差し込むと codec の「最初の行が勝つ」で書式の後ろの `pgid=` より先に読まれる。`machine-lock.sh:150`・`:168-169`）、このシェルが既に保持している
  - `product_lock_release`: 引数がある、サブシェルから（`BASH_SUBSHELL≠0`）
  - `product_lock_recover_only`: 引数がある、このシェルが保持している、サブシェルから
  - 3 つとも `PRODUCT_BASE` が空
  - 引渡し（`lock_hand_off`）・`LOCK_OWNER_PID`・`LOCK_WANT_TOKEN`・`pgid=`・D5 は `product_lock_*` から出さない（呼び手が無い）
- **`product-supervisor-3312.test.ts:647` の書き換え**: PM の決定（`pm-return-4288-design-rev2.md` の (1)、`pm-return-4288-upstream.md` の PR1c の個別の決定で認められた）どおり PR1c で行う。期待（assert）は 1 行も変えず、割込みの口を `ps` の stub から `CM_VERIFY_TEST_HANDOFF=pause:recover-only-judged`（`verify-run.sh:2038`）に替える。書き換えた試験が、守る振る舞いを壊す変異（例: `lock_recover` の token の確かめ `:1471` を外す）で赤になることを PR1c の中で示し、変異の内容と赤の件数をコミット本文に書く。期待を変える必要が出たら止めて返す
- **既存の試験との対**: `3312.test.ts` の supervisor.lock の 5 本と guard の 2 本は期待を変えない。`:612` の死んだ owner（`pid=999999 lstart=x`）は `kill -0` の ESRCH→取る（関数を呼ばない）。`:618-626` の生きた owner は `kill -0` alive→関数（`started_at=` 無しなので mtime）→ `alive` で断る（**未確認**: 試験の `lstart=` の値が `ps` と同じか。違えば関数の 4〜7 で決まる。実装の契約で確かめる）、stderr 空（S11 の未確認の点）。`:629-637` の 8 者はサブシェルの取得（拒まない）で GOT が 1、勝者の解放は拒まれる（試験は見ない）。`:641` は main シェルの保持の印の無い解放で `none`
- **ガードの札の列**: ガードは `<lock>` が無くても D6 を呼ぶので、毎回 `<base>/supervisor.queue/` を作る（`lock_wait_head` の `mkdir -p`）。base の中身を数える既存の試験・`finalize.ts` の出力に影響しないかは**未確認**（実装の契約で `git grep` して確かめる。PM Claude P3-9 (c)）
- 難易度: 上流の 2 回目で表が閉じたら実装は sonnet、閉じなければ opus（PM の処分）。親 §7 の「中（opus）」はこの処分で読み替える

### 5.1 `:647` の割込みが新しい形で働かない理由（事実）

`other-lstart` の pid が死んでいる記録は `kill -0` が先に ESRCH を返し、`ps` を呼ばない（`machine-lock.sh:85`）。`:647` の `ps` の stub（`999999` を見たら canonical を差し替える）が呼ばれないので、割込みの口を `pause:recover-only-judged` に付け替える（期待は同じ）。

### 5.2 PR1b と PR1c の契約（両方の設計に同じ文で書く。共通の決定 4）

契約の文（PR1b の設計 `docs/design/run-lock-machine-lock-4288.md` §4.3 の引用と一字一句同じ。PM Claude P3-2）。PR1b の上流の 3 回目が「今の実装に合わせた文を正とし、PR1c の §5.2 を同じ文に差し替える」と決めた文（PR1b の worktree の作業中の版、2026-11-11 に読んだもの。2 回目の `24a437a47` の文ではない）をそのまま写した。どちらかの文が変わったら、もう一方も同じ回で直す:

> `scripts/uat/run-lock.sh` は `scripts/lib/machine-lock.sh` の読み込みに失敗しても `run_lock_field`・`run_lock_pid_alive` を含む自分の関数をすべて定義し、source は成功（0）で返す（読み込みの失敗は、run-lock 自身の取得・引渡し・解放を呼んだときに `RUN_LOCK_ERROR` と 1 で断る）。`run_lock_pid_alive` は 2 値で、今の実装（`run-lock.sh:50-56`: 引数が空か数でなければ 1、`kill -0` が通るか `ps -p` が通れば 0、どちらも通らなければ 1。EPERM の生きた pid は `ps -p` で 0）のまま変えない（3 値が要るなら別名の関数にする）。`scripts/agent-health/product/lib.sh` は `scripts/lib/machine-lock.sh` を自分で source し、その戻り値を自分の変数 `PRODUCT_MACHINE_LOCK_OK` に持ち、run-lock.sh 経由で読まれたかに依らずそれで「取らない・ロックの回収だけ飛ばす」（PR1c の S9）を決める。

PR1c の側の読み方（契約の文の外。契約を狭めも広げもしない）:

- 2 回目の PR1c の文の「1＝ESRCH」は不正確だった（`ps -p` の失敗も 1 になる。PM Claude P3-2）。上の文の「どちらも通らなければ 1」が正。PR1c はこの関数をロックの判定に使わない（§3 の「流用する既存の部品」）
- PR1b §4.3 の「あわせて」（`run-lock.sh` は `source` の時点で大域の状態を変えず、run-lock の文面の差し替えは `run_lock_*` を呼ぶたびにそのロックのパスに限る）を、PR1c は S10 で前提にする

PR1c の側の行（雛形の `LOADER_ROWS`、実装の契約で赤から緑に）:

| 行 | 作り方（`os.tmpdir()` の一時ツリー） | 読み込み | 取得 | ガード |
|---|---|---|---|---|
| `load-once` | machine-lock.sh を source する偽の `run-lock.sh` を置き、lib.sh がもう一度 source する | 1 回 | 表どおり | 表どおり |
| `run-lock-load-failed` | 偽の `run-lock.sh` の machine-lock.sh の source が失敗する（印が 2 つある `verify-run.sh` の写し）。`run-lock.sh` は関数を定義し 0 で返す | 0 回（lib.sh の 2 回目も同じ写しで失敗） | refused(loader) | unloaded、台帳の回収は今どおり |
| `old-run-lock-copy` | 今の（旧い）`run-lock.sh` の写し（machine-lock.sh を読まない） | 1 回（lib.sh） | 表どおり | 表どおり |
| `lib-load-failed` | 今の（旧い）`run-lock.sh` の写し（machine-lock.sh を読まない）と、`MACHINE_LOCK_VERIFY_RUN` で印が 2 つある `verify-run.sh` の写しを名指す。lib.sh 自身の source だけが失敗する（`PRODUCT_MACHINE_LOCK_OK` が 0 でない）。新しい `run-lock.sh` 経由の読み込みが成功すると lib.sh の 2 回目は `MACHINE_LOCK_LOADED` で 0 を返す（`machine-lock.sh:49-51`）ので、この形は旧い写しでしか作れない（PM Claude P3-6） | 0 回 | refused(loader) | unloaded、台帳の回収は今どおり |
| `pid-alive-two-valued` | 生きた pid・ESRCH・EPERM の `run_lock_pid_alive`（1 は `kill -0` も `ps -p` も失敗したとき） | 1 回 | 表どおり | 表どおり（`proc_running` が 0／1／0） |

1 回目の失敗では `MACHINE_LOCK_LOADED` が立たないので、lib.sh の 2 回目の source は読み直す（`machine-lock.sh:49-51`）。読み込みの失敗の文面は 2 度出うる（害は無い。P3）。

## 6. review-4288h の P2 3・P3 1 と PR1c

| 指摘 | PR1c での扱い |
|---|---|
| P2-1（読み込み口だけでは `KILL_GRACE_SEC` が初期化されない） | PR1a で閉じた（節の中で設定、`verify-run.sh:611`）。supervisor.lock は `lock_drain_group` を呼ばない（§3 の「使わないもの」）。試験の雛形は `set -u` の下で設定なしに読み込む形を前提にする |
| P2-2（D9 の tmp の段） | 当てはまらない: supervisor.lock は引渡し・子のグループを持たない（S7）。`LOCK_PENDING_TOKEN` は呼ぶたびに空にする（S10） |
| P2-3（UAT の長が死に G の子が残った `down`） | 当てはまらない（UAT は PR1b）。監督役の子は台帳が守る（S7） |
| P3（pending の後・`mv` の前の失敗の T0） | 当てはまらない（引渡しが無い）。表の `own` の行は「T0 だけ」の 1 種類 |

## 7. 対になる場所（探した結果）

- 同じロックの写し: supervisor.lock を触るのは `lib.sh`・`deadline-guard.sh`・`supervisor.sh`（関数名で呼ぶだけ）の 3 つ（`git grep 'product_lock_\|supervisor\.lock'`）。TS・`src/` に写しは無い。`src/cli/types/` にも無い
- 説明: `docs/user-guide/agent-health.md:773`（「2 つ目の監督役は exit 75 で何もしない」）は載せた後も正しい（文面の種類が増えるだけ）。`lib.sh:121-126` のコメントは PR1c で書き直す。`docs/en` に写しは無い
- 古い動きを固定する試験: `product-supervisor-3312.test.ts` の supervisor.lock の 5 本（`:580-644`）と guard の 2 本（`:647-694`）。期待は変えない（`:647` は口だけ、§5.1）。`:603-608` の 60 秒・`:625` の stderr 空・`:641` の他者のロックを消さない、は表の行（`ownerless` × `gone`、S11、`release-unheld`）に当たる
- PR1b の設計（`docs/design/run-lock-machine-lock-4288.md`、別の worktree で並行して直している）: §5.2 の契約の文を同じ文で持つ（共通の決定 4）

## 8. 決めたこと・残る判断

決めたこと（この文書）: 記録に `pgid=` を書かない（S7）、ガードの予算は 10 秒、読み込みの失敗はガードの exit code に効かせない（S9）、大域変数と関数の差し替えは呼ぶたびに置く（S10）、D5 を呼ばない（S5）・サブシェルの解放とガードを拒む（S6）、予算 0 で札の後ろは札を取り下げて `queue` で抜ける（S12）、時刻の比較は PR1a-f の `machine_lock_pid_identity` に寄せる（§2.1、マージの順 PR1a-f → PR1c）、引数・文脈での拒否（§5）、文面の 10 種類と優先と出どころ（§2.2）。

PR1a-f へ（共通の決定 1。PR1c では形を区別して文面で人に知らせ、消さない）: 取得中の SIGKILL の空の owner（`corrupt`、F17）、旧版の `owner.tmp.*` だけの `<lock>`（`ownerless-tmp`、F18）、D7 の TZ 依存と EPERM の再利用 pid は PR1a-f の `machine_lock_pid_identity` で解き、PR1c はそれを呼ぶ（§2.1。F1・F8・F9・`other-eperm`）。

残る判断（PM へ。止める条件ではない）:

1. F7（空の `lstart=`）を混在の朝のために塞ぐか（推奨: 受け入れる。旧版どうしにも同じ穴がある。1 回目から変えていない）
2. F10 の host 名の変化を、PR1c の文面だけで受けるか（推奨: 文面だけ。`host=` を書かない形は `lock_format_owner` の変更なので PR1a-f か別 Issue）

## 9. 上流の 1 回目の指摘と処分

| 指摘 | 処分（この文書） |
|---|---|
| Claude 5 P2-1・PM Claude P3-3（D5・サブシェルの解放に本番の呼び手が無い） | 決定 2: `release-subshell` は拒否、D5 は不可能の行（S5・S6・§2.1）。表の 54 セルを到達扱いから外した |
| Claude 5 P2-2（予算 0 で札の後ろが exit 75） | 個別の決定: 札を取り下げて `refused(queue)`、文面で区別（S12） |
| Claude 5 P2-3・P3（EPERM の再利用 pid、F1 の誤り） | 個別の決定: unknown で消さず文面 `eperm`、PR1a-f で解く（F1）。`OBS_MEANING` と F1 の文を直した |
| Claude 5 P2-4・PM Claude P2-2（`corrupt`・`owner.tmp` だけが永久に止まる） | 決定 1: 形 `corrupt`・`ownerless-tmp` と文面、F15・F17・F18。塞ぐのは PR1a-f |
| Claude 5 P2-5・PM Claude P3-5（host 名の変化） | 形 `other-host`・文面 `host`・F10。§8 の判断 2 |
| PM Claude P2-1（F が呼び手の次元を持たない・`RESULTS` がコードと合わない） | 決定 3: F を呼び手ごとの型つきの表に（34 行）、`RESULTS` をコードの集合から組み、雛形がスクリプトから読んだ集合と比べる。owner の読み・退避の一覧・札の done・2 つの `restore-mkdir` を足した |
| PM Claude P2-3（TZ） | 2 回目は tz の包みで消さない側に移した。3 回目で包みを消し PR1a-f の `machine_lock_pid_identity` に寄せた（§2.1・§10） |
| PM Claude P2-4（PR1b との契約） | 決定 4: §5.2 の文と `LOADER_ROWS` |
| PM Claude P3-1（S7 の理由） | S7 に書いた |
| PM Claude P3-2（サブシェルの取得） | 拒まず、呼び手から除外（S6・§2.1） |
| PM Claude P3-4（ゾンビ） | F4 |
| PM Claude P3-6（`.stale.*`） | 形 `stale-old`（`absent` と同じ列であることを雛形で確かめる） |
| PM Claude P3-7（`restored`・ガードの `mine`） | §2.3 の 12 |
| PM Claude P3-8（S10 の大域・関数、F12 の文面、読み込みの失敗の文面） | S10、F23（`rec`）、文面 `loader` |
| PM Claude P3-9（断片名・難易度・札の列） | 決定 5: `issue-4288-pr1c.md`、changelog は統合。難易度は PM の処分。札の列は §5 の未確認 |
| Claude 5 P3（S11 の未確認・D6 と EXIT の順序・§4 の前提） | S11 に未確認と最初の赤の候補、F5、前提 P2 |
| 観測の軸（共通の決定 3） | pid とグループの軸を分けた（§2.1、`GROUP_AXIS`） |

## 10. 上流の 2 回目の指摘と処分（3 回目で直したもの）

| 指摘 | 処分（この文書・雛形） |
|---|---|
| PM Claude P2-A（EPERM の期待が §2 と F1 で食い違う） | §2.1 の `unknown` の列を「EIO など（ESRCH・EPERM 以外。EPERM は F1）」に狭めた（`other-plain`・`other-tz`・`other-lstart`・`aside`）。`OBS_MEANING` の 4 か所も同じ文に。文面の優先を `eperm` 2・`unk` 3 に分け、条件を排他にした（`point=pid` かつ `errno=EPERM` が `eperm`）。雛形に「`eperm` を出すのは F1 だけ」の検査 |
| PM Claude P2-B（文面 11 種の出どころ・F29） | §2.2 に文面の出どころの表（雛形の `MESSAGE_SOURCES`）。F29 の取得の期待を `refused(taking)` に直した（今の大域変数から導ける値。`unk` に揃える読みは足さない） |
| PM Claude P3-2（契約の文） | §5.2 を PR1b §4.3 の文（PR1b の上流の 3 回目が正とした、今の実装に合わせた文）の一字一句同じ引用に差し替えた（`PRODUCT_MACHINE_LOCK_OK` と、`run_lock_pid_alive` の 1 は `ps -p` の失敗も含むことは引用の中にある）。PR1c の側の読み方（「1＝ESRCH」の訂正、S10 から「あわせて」を参照）は引用の外に分けた。§3 の `run_lock_pid_alive` の行番号と 2 値の説明も直した |
| PM Claude P3-4（`RESULTS` の読み出しが注釈を拾う） | 雛形の `codeResultSet` は行頭が `#` の行を読まない。陽性の対照（コードから `needs-head` を消し注釈だけ残した写しで欠けを捉える）と陰性の対照（注釈だけの代入は集合を変えない）を足した |
| PM Claude P3-5（影響のある呼び手の書き忘れが型で落ちない） | F ごとに到達する 6 呼び手を `callers` か `excluded`（1 語の理由）のちょうど一方に書き、`failure()` の型で書き忘れ・二重を落とす（`@ts-expect-error` の対照と実行時の検査）。列挙で F31 の後ろの 2 呼び手（札が期限まで残る）と F33 の `guard-behind` を書き足した |
| PM Claude P3-6（`lib-load-failed` の作り方） | §5.2 の行と `LOADER_ROWS` を「旧い `run-lock.sh` の写し＋印が 2 つある `verify-run.sh` の写し（`MACHINE_LOCK_VERIFY_RUN`）」に狭めた |
| PM Claude P3-1・P3-3、Claude 5 P2-A（TZ）＝PM の処分 3 | 追加の指示 `reinstruct-4288-pr1c-tz.md` で直した: 独自の tz の包みを消し、PR1a-f の `machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>`（PR1a-f の設計 `docs/design/machine-lock-owner-atomic-4288.md` §4.1・§4.2、`be8275def`） を呼ぶ形に（S3・§2.1・F6・F8・F9・前提 P3）。形 `other-tz` を関数の 3 値を受ける `other-eperm`（EPERM の記録）に置き換え、`other-lstart` の観測を関数の 3 値にした。文面 `tz` を外した（10 種類）。`tz=` の改行の件は PR1c が `tz=` を書かなくなったので PR1a-f の側の検査に寄せた。マージの順 PR1a-f → PR1c（§5） |
