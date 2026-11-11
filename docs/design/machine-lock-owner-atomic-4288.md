# #4288 PR1a-f: owner の書き込みの原子性・旧版の `owner.tmp.*` の回収・D7 の TZ 依存（設計の 4 つと試験の表）

- Issue: #4288（2 番 run-lock・supervisor.lock の土台の続き）。土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) §1.6（D3・D7）・§1.9・§1.10・§1.14（PR1a の実装と D12 の不変条件）、[verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md) §2.8（観測点の表）
- PM の決定: `pm-return-4288-upstream.md` の共通の決定 1（PR1b・PR1c の上流のレビューから切り出した小さな PR）。上流 1 回目の指摘: `prereview/review-4288-pr1af-upstream.md`（codex、P1 1・P2 4・P3 1）・`pm-review-4288-pr1af-upstream-claude.md`（PM Claude、P2 6・P3 15）。PM の処分: `pm-return-4288-pr1af-upstream.md`（直す 1〜9。この版で全て入れた。対応は §7）
- この文書は上流の段（設計の 4 つ・試験の表）。実装は別の契約で、表の雛形 `tests/unit/verification/machine-lock-owner-atomic-4288.test.ts` の `it.todo` を赤から緑にする
- 骨格は 1 回目のまま: **I1 tmp → `link`**、**I3 一時ファイルの名前だけ消して `rmdir`**、**I5 2 つの証拠が揃ったときだけ死**。D12（持ち主自身の解放）は触らない
- 事実の行番号は `fd2f4a589`（develop、PR1a `c3387cbe7` を含む）

## 0. 今の振る舞い（事実）

| # | 事実 | 場所 |
|---|---|---|
| E1 | bash の owner の作成は `set -C; : > owner`（空のファイルを排他で作る）→ `cat >> owner`（**名前で**追記）→ 読み直し、の 3 段。1 段目と 2 段目の間で SIGKILL されると **0 バイトの owner** が残る | `verify-run.sh:1014`・`:1019`・`:1023`（`lock_obs_create`） |
| E2 | 同期 JS・TS も `openSync(file, 'wx')` → `writeSync(fd, text)` の 2 段で、間の SIGKILL で 0 バイトの owner が残る。`writeSync` の戻り値（書けたバイト数）は見ず、`closeSync` の失敗は握り潰す | sync `machine-lock-sync.mjs:229`・`:234`・`:240`、TS `machine-lock.ts:440`・`:445`・`:451` |
| E3 | 0 バイトや解けない owner は `corrupt`。取得は回収せず待ち続け、待ちの終わりの文面は holder の欄が空の `busy`（`rec` の文面が欠けたもの）。回収だけの D6 は `kept`、退避の整理（`lock_settle_gone`）は corrupt の退避を読み飛ばす（待ちを止めない） | `verify-run.sh:936-937`・`:1660`・`:2027`・`:1401`、sync `:197-199`・`:666`・`:1160`、TS `:409-412`・`:841` |
| E4 | owner の無い `<lock>` の回収（D3）は「owner が missing で**中が空**」のときだけ（`lock_ownerless_empty` が `yes`）。旧版の取得者（run-lock・supervisor.lock）は `owner.tmp.$$` に書いてから `mv -f` するので、その間の SIGKILL では `<lock>` に `owner.tmp.<pid>` だけが残り、新しい形では誰も回収しない | `verify-run.sh:1293-1307`・`:1501-1532`、sync `:487-504`・`:557-566`、旧版 `scripts/uat/run-lock.sh:62`・`:69`、`scripts/agent-health/product/lib.sh:174-176`（取得）・`:141-144`（`find -mmin +1`） |
| E5 | D7（supervisor.lock の pid の再利用）は、記録の `lstart=` と `LC_ALL=C ps -o lstart=` の**文字列の一致**で判定する。`ps -o lstart=` は地方時で出す（実測: 同じ pid で `TZ=UTC` は `Wed Nov 11 09:32:44 2026`、`TZ=Asia/Tokyo` は `Wed Nov 11 18:32:44 2026`）。書いた側と読む側の TZ が違うと、**生きた持ち主を「違う lstart＝再利用＝死んだ」と読み、ロックを回収する**（消す側） | `machine-lock.sh:83-96`・`:111-127`、書き手 `lib.sh:66-68`（`proc_lstart`） |
| E6 | D7 の包みは元の判定が `alive` のときだけ働く。`kill -0` が EPERM なら元の判定は `unknown:pid:EPERM` で、死んだ持ち主の pid を別ユーザーが再利用している間、取得も D6 も断り続ける | `machine-lock.sh:85`、`verify-run.sh:1107-1112` |
| E7 | 札の pid の再利用は `ps -o etime=` から起動時刻を出し、`createdAt + LOCK_PID_REUSE_SLACK_MS`（2000）より後に起動していれば再利用と読む。bash の解き方（`lock_pid_start_ms`）は**形を確かめない**: `bad:bad` も 2 つの欄として扱い、awk の数値変換で経過 0 秒（＝今起動した）になる。同期 JS・TS の `parseEtime` は正規表現で数字だけを受けるが、欄の範囲（分・秒が 60 未満、時が 24 未満）は見ない | `verify-run.sh:1129-1151`、sync `:80-86`、TS `:282-290` |
| E8 | 札の公開は「tmp に書く → `ln tmp <name>`（EEXIST なら別の番号）」。札の宛先は「最大の番号＋1」で、ディレクトリができる経路が無い | `verify-run.sh:1212-1240`（`:1223`） |
| E9 | 引渡し（D4）の owner の書き直しは `<lock>/.owner-<T1>` に書いてから `mv` する。pid は**後で起動した子**に替わり、`started_at` は `LOCK_ACQUIRED_AT` のまま、`LOCK_OWNER_EXTRA`（`lstart=` を含みうる）もそのまま書く | `verify-run.sh:1923-1944`（`:1930`）、sync `:943-947`・`:960-970` |
| E10 | kv の記録の `started_at=` は `machine_lock_iso`（UTC の ISO、秒に切り捨て）で書く。BSD の `date -u -j -f '%Y-%m-%dT%H:%M:%SZ' <v> +%s` で秒に戻せる（実測 `2026-11-10T00:00:00Z` → `1794268800`） | `machine-lock.sh:167`・`:174-177` |
| E11 | `ln src dst` は dst がディレクトリ（またはディレクトリへの symlink）なら**その中に** `dst/<basename src>` を作って 0 を返す。`/bin/link`（link(2) をそのまま呼ぶ）はどちらも `link: <dst>: File exists` で 1。`--` を受け、宛先の親が無ければ `No such file or directory`（実測 macOS、この版で再現。`lock_errno_of` で EEXIST・ENOENT に読める） | `/usr/share/man/man1/ln.1`、`/bin/link` |
| E12 | PR1a 版の取得者は作成の間ずっと**自分の札を持つ**（札を退かすのは公開の成功の後、`lock_retire_own_ticket`）。札は `kill -0` で生きている間は退かされず、先頭は札の列で 1 人。PR1a 版の書き込みの失敗の後始末は `rm -f "$LOCK_PATH/owner"`（名前で）→ `rmdir` | `verify-run.sh:1619-1650`（`:1624`・`:1645`） |
| E13 | 旧版の run-lock・supervisor.lock の取得者は札を持たない（`mkdir` を直に試す）。`mv` の失敗の後始末は `rm -rf "$dir"`（`lib.sh:178`、`run-lock.sh:127`）。旧版の読み手は「owner が無く 1 分より古い `<lock>`」を中身ごと取る（`lib.sh:141-144`） | `lib.sh:166-185`、`run-lock.sh:60-79` |
| E14 | `lock_parse_owner_text`（kv の codec）は読みの最初に `LPO_*` を空に戻すが、`started_at=` は読まない。`lock_holder_state` は pid が gone でも G が生きていれば `alive` を返す | `machine-lock.sh:135-160`、`verify-run.sh:1107-1112` |

## 1. (a) 不変条件

変えないもの（土台）:

- **I0-a（D12、PR1a-c）**: 持ち主自身の解放が直接消すのは「記録の pid が呼び手自身、かつ記録に `pgid` があれば G が空」のときだけ。この PR は解放の経路に触れない（`lock_release_held`・`release`・`lock_release_as_head` は変えない）
- **I0-b（札の規約 #4277）**: `mkdir`・回収・owner の無い `<lock>` の片付け・空の owner の回収は列の先頭だけ。先頭でない者は何も動かさない
- **I0-c（§2.8）**: 不明は何とも読まない（取らない・消さない・解放しない）。生きた保有者のロックは誰も動かさない

前提:

- **P0（札を持つ書き手）**: 保証は #4277 の札の規約に従う書き手（この repo の #4277 以降の `verify-run.sh`・skills の cmate-verify 0.7.0 以降・同期 JS・TS）の間で成り立つ。札を持つ書き手は、作成の途中で止まっている間も札が生きているので、他の誰も先頭にならない（E12）。札を持たない書き手は 2 種類で、扱いを分ける: (1) 旧版の run-lock・supervisor.lock（`owner.tmp.<pid>` の名前に pid がある）は I3 の pid の確かめで守る、(2) cmate-verify 0.7.0 より前の写し（札の規約そのものを知らない）は今も先頭の規約を無視して `mkdir` するので、親 §1.9 の「旧い取得者が動く間」と同じく保証の外。§5 の skills の port と sync-map.json の pin で減らす

足すもの:

- **I1（owner は完全な形でしか現れない。SIGKILL の範囲）**: どの実装も owner を「`<lock>/.owner-<token>` に**全て書き**（JS・TS は `writeSync` の戻り値の合計が `Buffer.byteLength(text)` と同じ、bash は tmp を読み直して書いた中身と同じ）、**閉じ**（`closeSync` が成功）→ `link(tmp, owner)`（排他。在れば EEXIST）→ 読み直し → tmp を消す」の順で公開する。`<lock>/owner` という名前が見える時点で中身は全て書かれている。よって**どの中断点（SIGKILL）も 0 バイトや書きかけの owner を残さない**（§2.6 の表 K）。fsync はしないので、停電・カーネルの停止の後は `link` 済みの 0 バイトの owner が残りうる。それは I4 の空の owner の回収で扱う（書いた者はもう居ない）
- **I2（排他は今のまま。公開は link(2) の意味）**: 公開は `link(2)` なので、在る owner（他者の記録・symlink・ディレクトリ・ディレクトリへの symlink）を書き換えない・その中に作らない。bash は `ln` でなく `LC_ALL=C /bin/link -- "$tmp" "$lock/owner"` を使う（E11。`ln` は宛先がディレクトリなら中に作って成功する）。EEXIST・ENOENT は `lock_errno_of` で読む。`mv`（`rename`）は在る owner を置き換えるので公開には使わない。札の `ln`（E8）は宛先にディレクトリができる経路が無いので変えない
- **I2-b（戻しは自分のものだけ）**: 公開の後の戻し（読み直しが不明: F13）は、`<lock>/owner` が自分の tmp と**同じ inode**（bash は `[ "$lock/owner" -ef "$tmp" ]`、JS・TS は `lstat(owner)` と `fstat(tmp)` の `dev`・`ino`）のときだけ owner を消す。tmp を消す前に確かめる。違えば owner は他者のもので消さない。`link` が ENOENT（F11: 自分の `<lock>` か tmp が片付けられた）なら、今ある `<lock>` は他者のものなので `rmdir` しない
- **I3（owner の無い `<lock>` の片付けの範囲）**: 片付けるのは**猶予つきの先頭**（`LOCK_OWNERLESS_GRACE_MS`／`ownerlessGraceMs` を渡した呼び手: run-lock・supervisor.lock、と D6 のガード）だけ。判定は**新しい述語** `lock_ownerless_temps_only`（bash）／`ownerlessTempsOnly`（同期 JS）で、呼ぶのは片付け `lock_expire_ownerless`／`expireOwnerless` **だけ**。既存の `lock_ownerless_empty`／`ownerlessEmptyLock`（「owner が無く中が**空**」）は意味を変えない（途中の戻し §2.7 の `lock_restore_from_gone` の `exists` の枝 `verify-run.sh:1338`、take-back-half `:1360`、D6 の `absent` の確かめ `:2030`、sync `:597`・`:622`・`:1164`、TS `:778`・`:800` が使うので）。新しい述語の答えは `no`（owner が在る）・`empty`・`temps:<names>`・`stray`・`absent`・`unknown:<point>:<path>:<errno>`。対象は「owner が missing」かつ「中の名前が全て一時ファイルの形で通常ファイル」かつ「`<lock>` と全ての一時ファイルの mtime が猶予より古い」かつ「**`owner.tmp.<pid>` の全てについて、その pid が `kill -0` で gone（ESRCH）**」のもの。`.owner-<token>` は新しい形と引渡しの tmp で、書き手は札を持つ（P0）ので年齢だけで足りる。`owner.tmp.<pid>` の pid が alive なら回収せず `machine-lock-ownerless-old-taker <lock> pid=<pid>` と名指す（旧版の書き手が猶予を超えて止まっている。再開すれば自分で `mv` する）。pid が EPERM・EIO（unknown）でも回収しない。pid が数字でなければ `stray`。消すのは**その一時ファイルの名前だけ**（`owner` という名前は消さない）と、最後の `rmdir <lock>`（空でなければ失敗する）。一時ファイルの unlink が ENOENT なら「もう無い」と読んで次へ進む（旧版の片付けと同時。F23）。途中で誰かが公開すれば `owner` が在るので `rmdir` が失敗し、ロックはそのまま残る
- **I4（壊れた owner）**: 解けない owner（`garbage-owner`）は今のまま**誰も自動で消さない**。取得の断り・D6 の結果で `<lock>/owner` を名指す（`machine-lock-owner-corrupt <lock>/owner unparsable`）。**0 バイトの owner（`empty-owner`）は回収する**: 列の先頭（取得の先頭・猶予の無い取得の先頭・D6 のガード。D5 と同じ「先頭になってから」）が、owner の mtime が `LOCK_EMPTY_OWNER_GRACE_MS`（固定 60000。書き手の `: >` と `cat >>` の窓〔μs〕より十分長い。呼び手の猶予のオプションとは別で、猶予の無い呼び手にも効く）より古いことを確かめ、`<lock>` を `<lock>.gone-<自分の token>-<serial>` へ `mv` で退かし、退かした先の owner が**まだ 0 バイト**で mtime も古いことを確かめてから `rm -rf`。0 バイトでなくなっていれば（書き手が退かす間に書き終えた）退避を残し、次の周回で `lock_settle_gone` が記録として判定する（生きていれば戻す。既存の §2.7）。若い（60 秒以内の）空の owner は消さず、文面は `taking`（書いている途中）。空の owner を生むのは P0 の書き手では E1・E2 の窓だけで、その書き手は札を持つので、止まっている間に誰かが先頭になることは無い（E12）。旧い写し（PR1a 版・skills の port の前）は今後も生むので、回収は一度きりの掃除でなく恒常の規則
- **I5（D7 の再利用の判定は 2 つの証拠が揃ったときだけ死に変える。TZ にも時計にも依らない）**: `lstart=` の行を持つ記録（D7 の対象。supervisor.lock）に限り、元の判定（`lock_holder_state`）のうち **`kill -0` の pid の観測が alive か EPERM** のとき（G だけで alive の記録には当てない: F44）、`machine_lock_pid_identity`（§4）を呼び、`reused` のときだけ gone（その後に G を見る）。2 つの証拠は (1) **lstart の違いが TZ の違いでない**（記録と `ps` の `lstart` を同じ規則で「地方時の付いていない日時」として秒に直し、差が 15 分の倍数かつ 26 時間以内なら TZ の違いだけ＝同じ起動。それ以外が違い）、(2) **etime の起動時刻が `started_at` ＋ `LOCK_PID_REUSE_SLACK_MS`（2000）より後**。どちらかが欠ければ `alive`、読めなければ `unknown:<point>:<errno>`（元が EPERM なら EPERM のまま）。**D7 は何かを alive に変えることはなく、死に変えるのは 2 つが揃ったときだけ**。前提: `lstart=`・`started_at=` は記録の pid のもので、その pid は `started_at` より前に起動した。これを崩す D4 の引渡し（pid が後で起動した子に替わる。E9）は、`LOCK_OWNER_EXTRA` に `lstart=` の行があれば**拒む**（`LHO_STAGE=lstart`、owner を書き直さない。F45。本番の呼び手は無い: supervisor は引き渡さない）
  - `started_at=` が無い旧い記録（旧版の supervisor.lock）は、`<lock>/owner` の mtime（`lock_obs_mtime owner-mtime`）を `started_at` の代わりに使う。旧版の書き手は tmp に書いてから `mv` するので、owner の mtime は取得の時刻で、TZ に依らない。mtime が読めなければ D7 を当てず元の判定（pid だけ。F38）。`started_at=` が解けなければ（`date` が失敗）D7 を当てず元の判定（F39）
  - `LOB_STARTED_AT` は**読みごとに空へ戻す**（`lock_parse_owner_text` の冒頭と `lock_obs_owner_fail`）。`lock_settle_gone` は退避を続けて読むので、戻さないと前の記録の時刻が `started_at=` の無い記録に持ち越される（F40）
  - 時刻: `now` は `ps -o etime=` の**前**に取る（`ps` の遅れが計算値を早める＝生きている側に倒れる）。macOS の `lock_now_ms` は秒単位で、生きた持ち主の計算値は `started_at` ＋ 1 秒以下（`started_at` は秒に切り捨て）。閾値 2 秒に 1 秒の余裕
- **I6（3 実装の分担）**: I1・I2・I2-b・I4 は bash（`verify-run.sh` の節。`machine-lock.sh` が読み込む）・同期 JS・TS で同じ。I3 は猶予の口を持つ bash・同期 JS だけ（TS は `ownerlessGraceMs` も D6 のガードも持たない。呼び手が無い組み合わせは作らない）。I5 は bash の読み込み口だけ（supervisor.lock は bash だけが触る）。表は実装の軸を持ち、適用しない組み合わせは理由つきで「到達しない」（§2）
- **I7（例外を残さない）**: 表 F に「消す側に倒れうる残り（residual）」の行は無い（型で `residual` を持たない）。解けない形は「回収しない＋文面」に倒す（旧版の tmp の生きた／不明な pid、TZ と時計の後退の重なりは I5 の (1) が TZ の違いだけを同じ起動と読むので起きない）

I5 が TZ・時計・EPERM の全てを解く理由: `ps -o lstart=` は起動の瞬間に記録された壁時計の値を地方時で出すだけなので、同じプロセスなら 2 つの `lstart` の差は TZ の差（15 分の倍数）にしかならない。時計の段差は起動の後には `lstart` を変えない。別のプロセスが同じ秒・15 分の倍数ずれて起動した偶然は alive に読む（消さない側）。別ユーザーに再利用された pid は `ps` で読めるので (1)(2) が揃う。

## 2. (b) 状態と遷移の表

### 2.1 軸

- **実装（3）**: `bash`・`sync`（同期 JS）・`ts`
- **owner の形（17）**:
  - 空・tmp だけ（9）: `empty-dir`（owner も中身も無い。D3 の対照）・`tmp-new`（`.owner-<token>` だけ）・`tmp-old-young`（`owner.tmp.<pid>` だけで猶予の内）・`tmp-old`（`owner.tmp.<pid>` だけで猶予を過ぎた。観測は名前の pid）・`tmp-stray`（一時ファイルの形でない名前やディレクトリが混ざる）・`tmp-new+gone-dead`（canonical に `tmp-new`、死んだ記録の `.gone-*` がある。codex P2 の組。途中の戻しの述語を広げる変異の対照）・`tmp-new+gone-alive`（canonical に `tmp-new`、生きた記録の `.gone-*`）
  - 壊れ（2）: `empty-owner`（0 バイト）・`garbage-owner`（解けない中身）
  - 完全で D7 の対象（8、`lstart=` あり）: `lstart-match`・`lstart-tz`（TZ が違うだけの生きた持ち主）・`lstart-reused`（再利用）・`lstart-fails`（`ps -o lstart=` が読めない）・`etime-fails`（lstart は違い、`etime` が読めない・形が不正）・`lstart-same-etime-fails`（lstart は同じ、`etime` は読めない＝読まないので alive）・`lstart-legacy`（`started_at=` 無し、TZ が違うだけ、owner の mtime で判定）・`lstart-legacy-reused`（`started_at=` 無し、再利用）
  - 完全で `lstart=` の無い記録は D7 の対象外で、この PR で振る舞いが変わらない（PR1a の表のまま）ので軸に入れない
- **呼び手（4）**: `acquire-head-grace`（猶予つきの先頭の取得: run-lock・supervisor.lock）・`acquire-head-nograce`（猶予の無い先頭の取得: verify のゲート・merge-pr・precheck・gate-runner）・`acquire-behind`（先頭でない取得者）・`guard-head`（回収だけの先頭: D6 `lock_recover_only`／`recoverIfDead`）
- **観測の 3 値**: 形ごとに決め手が違う（雛形の `OBS_MEANING`）。空・tmp だけ（`tmp-old*` を除く）・壊れは「年齢」（`alive`＝猶予以内、`gone`＝猶予より古い、`unknown`＝一覧・lstat・mtime・owner の読みの失敗）。`tmp-old*` は「名前の pid の `kill -0`」（`tmp-old-young` は年齢が先なので読まない）。`tmp-new+gone-alive` は退避の記録が生きているので canonical の年齢を読まない。D7 の形は「記録の pid の `kill -0`」（`alive`、`gone`＝ESRCH、`unknown`＝EPERM。EIO などは表 F の F32）

### 2.2 結果

- 取得: `acquired`（ロックは `mine`）／`refused:<文面>`（`rec`〔生きた記録〕・`taking`〔owner の無い若い `<lock>`・若い空の owner、または猶予の無い呼び手〕・`queue`〔先頭でない〕・`unk`〔不明〕・`corrupt`〔解けない owner、新〕・`stray`〔I3 の対象外の中身、新〕・`old-taker`〔旧版の tmp の pid が生きている、新〕）
- D6: `removed`／`kept`
- ロックの行方は結果から決まる: `acquired`→`mine`、`removed`→`absent`、それ以外→`unchanged`
- 陽性の対照は結果と文面の組（`refused:taking` と `refused:stray` は違う結果として数える。P3-12）

### 2.3 表 T（bash。sync・ts との違いは §2.4）

各セルは alive / gone / unknown。「→今」は直す前の実装の結果（陽性の対照）。

| 形 | acquire-head-grace | acquire-head-nograce | guard-head |
|---|---|---|---|
| empty-dir | taking / acquired / unk | taking / taking / unk | kept / removed / kept |
| tmp-new | taking / **acquired**（→今 taking） / unk | taking / taking / unk | kept / **removed**（→今 kept） / kept |
| tmp-old-young | taking ×3 | taking ×3 | kept ×3 |
| tmp-old | **old-taker**（→今 taking） / **acquired**（→今 taking） / **unk**（→今 taking） | taking ×3 | kept / **removed**（→今 kept） / kept |
| tmp-stray | **stray**（→今 taking）×2 / unk | taking / taking / unk | kept ×3 |
| tmp-new+gone-dead | taking / **acquired**（→今 taking） / unk | taking / taking / unk | kept / **removed**（→今 kept） / kept |
| tmp-new+gone-alive | rec ×3 | rec ×3 | kept ×3 |
| empty-owner | **taking**（→今 rec） / **acquired**（→今 rec） / unk | 同左 | kept / **removed**（→今 kept） / kept |
| garbage-owner | **corrupt**（→今 rec）×2 / unk | 同左 | kept ×3 |
| lstart-match | rec / acquired / unk | 到達しない | kept / removed / kept |
| lstart-tz | **rec**（→今 acquired） / acquired / unk | 到達しない | **kept**（→今 removed） / removed / kept |
| lstart-reused | acquired / acquired / **acquired**（→今 unk） | 到達しない | removed / removed / **removed**（→今 kept） |
| lstart-fails | unk / acquired / unk | 到達しない | kept / removed / kept |
| etime-fails | **unk**（→今 acquired） / acquired / unk | 到達しない | **kept**（→今 removed） / removed / kept |
| lstart-same-etime-fails | rec / acquired / unk | 到達しない | kept / removed / kept |
| lstart-legacy | **rec**（→今 acquired） / acquired / unk | 到達しない | **kept**（→今 removed） / removed / kept |
| lstart-legacy-reused | acquired / acquired / **acquired**（→今 unk） | 到達しない | removed / removed / **removed**（→今 kept） |

`acquire-behind` は全ての形・値で `refused:queue`（I0-b）。

### 2.4 実装ごとの違い（到達しない組み合わせ）

| 実装 | 到達しない | 理由 |
|---|---|---|
| bash | `acquire-head-nograce` × D7 の 8 形（24） | `lstart=` を持つのは kv の記録（supervisor.lock）だけで、猶予の無い呼び手は JSON の owner を別の置き場で使い、読み込み口の D7 を読み込まない（`no-kv-for-nograce`） |
| sync | D7 の 8 形 × 4 呼び手（96） | D7 は bash の読み込み口だけ（`d7-bash-only`） |
| ts | D7 の 8 形 × 4 呼び手（96）、`acquire-head-grace` × 9 形（27）、`guard-head` × 9 形（27） | `d7-bash-only`、TS は `ownerlessGraceMs` を持たない（`ts-no-grace`）、TS は D6 のガードを持たない（`ts-no-guard`） |

到達する組み合わせでは 3 実装の期待は同じ（雛形は 3 つの表を別々の字面で書き、規則から計算した期待と、互いとを比べる）。

### 2.5 数（雛形の型と試験が固定する）

- 表 T: 3 実装 × 17 形 × 4 呼び手 × 3 値 = **612 セル**、到達しない **270**、到達する **342 行**
- 表 K（中断点 × 実装、§2.6）: 5 × 3 = **15 行**
- 表 F（外部の呼び出しの失敗、§3）: **46 行**
- 合計 **403 行**（雛形の `it.todo` は、これに表 K の陽性の対照 3 本〔実装ごとに今の実装が `empty-owner` を残すこと、§2.6〕を足した 406）

### 2.6 表 K: 取得の中断点（SIGKILL）× 実装 → 残る形

| 中断点 | 割込みの口（3 実装同じ名前） | 残る形 | 猶予つきの先頭（bash・sync） | 猶予の無い先頭（3 実装） |
|---|---|---|---|---|
| K1 `mkdir` の後・tmp の作成の前 | `owner-lock-made` | `empty-dir` | 猶予の後に片付ける（今のまま） | 片付けない（人が消す。§8 の 2） |
| K2 tmp を開いた後・書く前 | `owner-tmp-opened` | `tmp-new`（0 バイトの tmp。読まれない） | 猶予の後に片付ける（I3、新） | 片付けない |
| K3 tmp を書いて閉じた後・`link` の前 | `owner-tmp-written` | `tmp-new` | 同上 | 片付けない |
| K4 `link` の後・tmp を消す前 | `owner-linked` | 完全な owner＋`.owner-<token>` | 通常の回収（pid が死ねば `lock_recover` が `<lock>` ごと退避して `rm -rf`） | 同左 |
| K5 tmp を消した後 | `owner-tmp-removed` | 完全な owner | 同上 | 同左 |

TS は猶予つきの先頭を持たないので、その列は「到達しない（`no-grace-caller`）」。**どの行も `empty-owner`・`garbage-owner` を残さない**（I1）。

割込みの口: bash は `lock_test_pause <stage>`（`CM_VERIFY_TEST_HANDOFF=pause:<stage>`）、同期 JS は `hooks.onOwnerStage(stage)`、TS は `__testHooks.onOwnerStage(stage)`。**口は PR1a-f が持つ**（`lock_obs_create`・`makeObserver().create`・TS の `create` の中にあるので）。親 §1.10 が PR1b・PR1c の台に挙げた `owner-create`・`owner-written` の pause はこの 5 つの名前に置き換え、PR1b・PR1c は口を足さずに使うだけ（同じ関数を 2 本の PR が書かない）。

陽性の対照（今の実装が `empty-owner` を残すこと）: bash は `lock_obs_create` を `machine-lock.sh` 越しに直に呼び、標準入力をまだ書かれない FIFO にする（`: >` で 0 バイトの owner を作った後、`cat >>` が入力を待つ）→ SIGKILL → `<lock>/owner` が 0 バイト。同期 JS・TS は子プロセスで `hooks.fault('owner-write', …)` を返さない関数にし（`openSync` の後・`writeSync` の前に呼ばれる）→ SIGKILL → 0 バイト。

## 3. (c) 外部の呼び出しの失敗の倒れ方（表 F、46 行）

倒れ方は 2 つだけ（I7）: `keep`＝何も消さない・取らない（I3・I4 の規則どおりの片付けは「規則」で、失敗の倒れ方ではない）、`own-only`＝この呼び手が自分で作ったもの（自分の tmp・この `mkdir` が作った空の `<lock>`・この `link` が作った owner〔同じ inode を確かめて〕）だけを戻す。雛形の型は呼び手・実装・点・結果・ロックの行方を列挙で持つ。

| # | 実装 | 呼び手 | 呼び出し・失敗（点） | 倒れ方 | 結果 | ロックの行方 |
|---|---|---|---|---|---|---|
| F1 | 3 | 取得 | `mkdir <lock>` が EEXIST 以外（`mkdir-lock`） | keep | unk | 何も作らない |
| F2 | 3 | 取得 | tmp の排他作成が EEXIST（同じ token の tmp が在る。`owner-create`） | own-only | unk | 変わらない（tmp は開いていないので消さない。`rmdir` は空でないので残る） |
| F3 | 3 | 取得 | tmp の作成がその他の errno（EACCES・ENOSPC。`owner-create`） | own-only | unk | 自分の `<lock>` を戻す（先頭は自分なので他者の `<lock>` ではない） |
| F4 | 3 | 取得 | tmp の書き込みの失敗（ENOSPC・EIO。`owner-write`） | own-only | write-failed | 自分の tmp と `<lock>` を戻す |
| F5 | 3 | 取得 | 短い書き込み（JS・TS は戻り値の合計が足りない、bash は tmp の読み直しが違う。`owner-write-short`、新） | own-only | write-failed | 同上 |
| F6 | sync・ts | 取得 | `closeSync` の失敗（`owner-close`、新。bash はリダイレクトの閉じの失敗を F5 の読み直しで捕まえる） | own-only | write-failed | 同上 |
| F7 | 3 | 取得 | `link` が EEXIST: owner が通常ファイル（`owner-publish`、新） | own-only | owner-exists | 変わらない（自分の tmp だけ消す） |
| F8 | 3 | 取得 | `link` が EEXIST: owner がディレクトリ | own-only | owner-exists | 変わらない。**ディレクトリの中に何も作らない**（`ln` なら作る。E11） |
| F9 | 3 | 取得 | `link` が EEXIST: owner がディレクトリへの symlink（`<lock>` の外を指す） | own-only | owner-exists | 変わらない。symlink の先に何も作らない |
| F10 | 3 | 取得 | `link` が EEXIST: owner がファイルへの symlink | own-only | owner-exists | 変わらない |
| F11 | 3 | 取得 | `link` が ENOENT（自分の tmp か `<lock>` が片付けられた） | own-only | unk | 変わらない。自分の tmp を（在れば）消し、**`rmdir` しない**（今ある `<lock>` は他者のもの。P3-6・P3-7） |
| F12 | 3 | 取得 | `link` がその他（EPERM・ENOTSUP・EIO。`owner-publish`） | own-only | unk | 自分の tmp と `<lock>` を戻す |
| F13 | 3 | 取得 | 読み直しが不明（EIO。`owner-readback`）、owner が自分の tmp と同じ inode | own-only | unk | owner と tmp を消し `rmdir`（今の `70+i` と同じ。同じ inode を確かめてから） |
| F14 | 3 | 取得 | 読み直しが不明、owner が自分の tmp と違う inode（間に置き換えられた） | own-only | unk | 変わらない（owner を消さない。自分の tmp だけ） |
| F15 | 3 | 取得 | 読み直しが他者の記録（`owner-readback`） | own-only | not-ours | 変わらない（自分の tmp だけ消す） |
| F16 | 3 | 取得 | 公開の後の tmp の削除の失敗（`owner-unlink`） | keep | acquired | 取った。tmp は owner の隣に残り、解放・回収の `rm -rf` で消える |
| F17 | 3 | 取得 | 戻しの tmp の削除の失敗（`owner-unlink`） | keep | write-failed | `<lock>` と自分の tmp が残る（`tmp-new`）。猶予つきの先頭が猶予の後に片付ける（I3） |
| F18 | 3 | 取得 | 戻しの `rmdir <lock>` の失敗（`lock-rmdir`） | keep | write-failed | 空の `<lock>` が残る（今のまま） |
| F19 | bash・sync | 片付け | 一覧の失敗（`lock-list`） | keep | unk | その周回は `mkdir` しない |
| F20 | bash・sync | 片付け | 一時ファイルの lstat の失敗（`ownerless-tmp-lstat`、新） | keep | unk | 同上 |
| F21 | bash・sync | 片付け | `<lock>`・一時ファイルの mtime の失敗（`ownerless-mtime`） | keep | unk | 同上 |
| F22 | bash・sync | 片付け | 一時ファイルの削除の失敗（ENOENT 以外。`ownerless-tmp-unlink`、新） | keep | unk | その周回は `rmdir` も `mkdir` もしない |
| F23 | bash・sync | 片付け | 一時ファイルの削除が ENOENT（旧版の片付けと同時） | keep | 次の段へ進む | 「もう無い」と読み、次の名前・`rmdir` へ（unknown にしない） |
| F24 | bash・sync | 片付け | `rmdir` が ENOTEMPTY／EEXIST（途中で誰かが公開した。`ownerless-rmdir`） | keep | 次の周回 | 消さず、次の周回で記録として判定する |
| F25 | bash・sync | 片付け | `rmdir` がその他の errno（`ownerless-rmdir`） | keep | unk | その周回は `mkdir` しない |
| F26 | bash・sync | 片付け | 旧版の tmp の pid の `kill -0` が EPERM・EIO（`owner-tmp-pid`、新） | keep | unk | 変わらない |
| F27 | bash・sync | 片付け | 旧版の tmp の pid が生きている（旧版の書き手が tmp と `mv` の間で猶予を超えて止まった。codex P1） | keep | old-taker | 変わらない。名指す。書き手が再開すれば自分で `mv` する（消していないので後継の `<lock>` を `rm -rf` する経路が生まれない） |
| F28 | bash・sync | 片付け | 旧版の tmp の名前の pid が数字でない | keep | stray | 変わらない |
| F29 | 3 | 空の owner の回収 | owner の mtime が 60 秒以内 | keep | taking | 変わらない（書いている途中かもしれない。P3-8） |
| F30 | 3 | 空の owner の回収 | 退かす `mv` の失敗（`empty-owner-move`、新） | keep | unk | 変わらない |
| F31 | 3 | 空の owner の回収 | 退かした先の owner が 0 バイトでなくなった（書き手が間に書き終えた） | keep | rec | 退避を残す。次の周回で `lock_settle_gone` が記録として判定する |
| F32 | bash | D7 | `kill -0` が EPERM 以外の失敗（EIO） | keep | 元の判定 | 不明のまま（D7 は当てない） |
| F33 | bash | D7 | `ps -o lstart=` の失敗・空（`lstart`） | keep | unknown | 元が alive なら `unknown:lstart:<errno>`、EPERM なら EPERM のまま |
| F34 | bash | D7 | 記録か `ps` の `lstart` が日時として解けない（`lstart`） | keep | unknown | 同上 |
| F35 | bash | D7 | `ps -o etime=` の失敗・空（`etime`、新） | keep | unknown | 元が alive なら `unknown:etime:<errno>`、EPERM なら EPERM のまま |
| F36 | bash | D7 | `etime` の形が不正（`bad:bad`・`1:99`・`-1:00`・欄が 4 つ。`etime`） | keep | unknown | 同上（不正を経過 0 秒と読まない。codex P2） |
| F37 | 3 | 札の退かし | 札の pid の `etime` の形が不正 | keep | 札を退かさない | bash の `lock_pid_start_ms` は新しい厳しい解き方を使う（今は `bad:bad` を「今起動した」と読み、生きた札を再利用として退かしうる）。JS・TS の `parseEtime` は範囲を足す |
| F38 | bash | D7 | `started_at=` が無く、owner の mtime も読めない（`owner-mtime`） | keep | 元の判定 | D7 を当てず pid だけ |
| F39 | bash | D7 | `started_at=` が `date` で解けない | keep | 元の判定 | 同上 |
| F40 | bash | D7 | `started_at=` のある記録の後に、無い記録を読む（`lock_settle_gone` の続けての読み） | keep | alive | `LOB_STARTED_AT` は読みごとに空。前の記録の時刻を使わず、自分の owner の mtime で判定する |
| F41 | bash | D7 | `hostname` が記録の `host=` と違う | keep | 元の判定 | 他 host の記録は alive（D7 は当てない） |
| F42 | bash | D7 | 持ち主の起動から取得までの間に時計が 2 秒より大きく戻り、かつ書き手と読み手の TZ が違う（1 回目の F24） | keep | alive | (1) の証拠が「TZ の違いだけ」と読むので reused にならない（I5・I7。1 回目の residual を消した） |
| F43 | bash | D7 | launchd の環境（`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`TZ`・`LC_ALL` 未設定）で書いた記録を `TZ=UTC`・`TZ=Asia/Tokyo` の読み手が読む | keep | alive | `lstart-tz` の具体の 1 行。`date -j -f` が BSD の `/bin/date` で効くこともここで固定する |
| F44 | bash | D7 | 記録に `pgid=` と `lstart=` の両方、pid は gone・G は生（元の判定が G で alive） | keep | 元の判定 | D7 を当てない（`kill -0` の pid が gone）。本番の記録には無い形 |
| F45 | bash | 引渡し | `LOCK_OWNER_EXTRA` に `lstart=` の行がある `lock_hand_off` | keep | 引渡しの失敗 | owner を書き直さない（`LHO_STAGE=lstart`）。I5 の前提を守る |
| F46 | 3 | 取得 | 解けない owner（読めた） | keep | corrupt | 誰も消さない。断りと D6 の結果で `<lock>/owner` を名指す（I4） |

消す操作は全て own-only（自分の tmp・自分の `mkdir`・同じ inode を確かめた自分の `link`）か、規則（I3 の「pid が gone の旧版の tmp・猶予を過ぎた新しい tmp の名前と空の `<lock>` の `rmdir`」、I4 の「先頭が退かして 0 バイトのままと確かめた空の owner」、I5 の「2 つの証拠が揃った再利用」）。どれも生きた記録（`owner`）を消さない。

流用する既存の部品の倒れ方: `lock_obs_mv`・`lock_obs_list`・`lock_obs_lstat`・`lock_obs_mtime` は 3 値で答える（§2.8）。`lock_pid_start_ms` の解き方は使わない（E7）: §4 の `machine_lock_etime_ms` に替え、札の退かしもそれを使う（F37）。10 秒のキャッシュは `$(…)` のコマンド置換の中では親に残らない（効かないだけで害は無い）ので D7 は使わない。

## 4. TZ に依らない比較の関数（PR1c が呼ぶ）

PM の決定（案 A）: PR1c は独自の tz の包み（記録の `tz=` と読み手の `${TZ-}` の比較）を持たず、この関数を呼ぶ。マージの順は **PR1a-f → PR1c**。PR1c の設計の S3・§2.1 の tz の包み・F8・F9・前提 P3 は、この節を参照して直す（PR1c の上流 3 回目）。

### 4.1 bash（`scripts/lib/machine-lock.sh`）

```sh
machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>
# 標準出力に 1 行: alive | reused | unknown:<point>:<errno>   （<point> は lstart か etime）
# 終了コードは常に 0。呼び手は kill -0 の pid の観測が alive か EPERM のときだけ呼ぶ。
```

手順（この順）:

1. `now=$(lock_now_ms)`（**`ps` の前**）
2. `cur=$(LC_ALL=C ps -o lstart= -p <pid>)` を空白を詰めて読む。失敗・空なら `unknown:lstart:<errno>`（注入 `CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO>`）
3. `cur` が `<recorded-lstart>`（同じく詰めたもの）と同じなら `alive`
4. 両方を `machine_lock_lstart_naive_s`（`LC_ALL=C TZ=UTC0 date -j -f '%a %b %d %T %Y' <s> +%s`、BSD。GNU は `date -u -d <s> +%s`。標準エラーに何か出たら失敗と読む）で秒に直す。どちらか失敗なら `unknown:lstart:EUNKNOWN`
5. 差の絶対値が 900 の倍数かつ 93600（26 時間）以下なら `alive`（TZ の違いだけ）
6. `et=$(ps -o etime= -p <pid>)` を `machine_lock_etime_ms` で解く。失敗・空・形が不正なら `unknown:etime:<errno>`（注入 `etime=<ERRNO>`）。`machine_lock_etime_ms` は `^([0-9]+-)?([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}$` だけを受け（日の欄があるときは時の欄も要る）、時 < 24・分 < 60・秒 < 60 を確かめる。日の無い形で時の欄が 24 以上も不正
7. `now - et > <started-at-ms> + LOCK_PID_REUSE_SLACK_MS` なら `reused`、そうでなければ `alive`

読み込み口の包み（`lock_record_state` の D7）の写像: 元の判定 `alive`（`kill -0` の pid が alive）→ 関数の答えをそのまま（`reused` は G を見る）。元の判定 `unknown:pid:EPERM` → `reused` なら G を見る、それ以外は EPERM のまま。`<started-at-ms>` は `started_at=`、無ければ owner の mtime（I5）、どちらも無ければ呼ばない。

### 4.2 3 実装の対応

| 実装 | 関数 | 今の呼び手 | 備考 |
|---|---|---|---|
| bash | `machine_lock_pid_identity`（新）・`machine_lock_etime_ms`（新）・`machine_lock_lstart_naive_s`（新） | D7 の包み（supervisor.lock）、PR1c の supervisor・deadline-guard | `verify-run.sh` の `lock_pid_start_ms` も `machine_lock_etime_ms` と同じ規則の解き方に替える（節の中に写しを置く: `verify-run.sh` は `machine-lock.sh` を読み込まない） |
| sync | 足さない。`parseEtime` に範囲の検査を足す | 札の退かし（`ticketRetirable`） | `lstart=` の記録を読む JS の呼び手が無い（I6）。生まれたら、その PR で `pidIdentity(pid, recordedLstart, startedAtMs, hooks)` を同じ 3 値で足す |
| ts | 足さない。`parseEtime` に範囲の検査を足す | 札の退かし（`retirable`） | 同上 |

## 5. (d) PR の切り方

- **1 本（PR1a-f）**。書くファイル:
  - `.claude/skills/cmate-verify/scripts/verify-run.sh`・`.agents/skills/cmate-verify/scripts/verify-run.sh`（バイト一致）の機械ロックの節: `lock_obs_create` の中身（tmp → 読み直し → `/bin/link` → 読み直し → tmp の削除。引数・標準入力・戻り値 0/3/6/10+i/40+i/70+i は変えない）、K の割込みの口 5 つ、F13 の `-ef`、F11 の `rmdir` をしない、新しい述語 `lock_ownerless_temps_only` と `lock_expire_ownerless` からの呼び出し（`lock_ownerless_empty` は変えない）、空の owner の回収（I4）、取得と D6 の文面（`corrupt`・`stray`・`old-taker`・`taking`）、`lock_obs_owner` が codec の `LPO_STARTED_AT` を `LOB_STARTED_AT` に写す（読みごとに空）、`lock_pid_start_ms` の解き方、`lock_hand_off` の `lstart=` の拒否、`lock_recover` の `:1486` のコメント（「owner が無い退避は、持ち主の tmp が退かした先にあり、持ち主の `link` は ENOENT で断る」に直す）
  - `scripts/lib/machine-lock.sh`: kv の codec が `started_at=` を読む、§4 の 3 関数、D7 の包みを I5 に替える（`machine_lock_lstart_state` は残す）
  - `scripts/orchestrate/machine-lock-sync.mjs`: `makeObserver().create` の中身（`wx` の tmp → 全量の書き込み → `closeSync` → `linkSync` → 読み直し → tmp の削除。戻り値の形は同じ）、`hooks.onOwnerStage`、新しい述語 `ownerlessTempsOnly` と `expireOwnerless` からの呼び出し、空の owner の回収、文面、`parseEtime` の範囲
  - `src/lib/verification/machine-lock.ts`: `create` の中身（同上）、`__testHooks.onOwnerStage`、空の owner の回収、文面、`parseEtime` の範囲（I3 は足さない）
  - `.claude/skills/sync-map.json`: `verify-run.sh` の pin を再計算し、rationale に PR1a-f を足す（PR1a と同じ書き方、親 §1.11）
  - `docs/design/verify-lock-holder-group-4288.md` §2.8: 点 `owner-write-short`・`owner-close`・`owner-publish`・`ownerless-tmp-lstat`・`ownerless-tmp-unlink`・`owner-tmp-pid`・`empty-owner-move`・`owner-mtime` を足し、`owner-create` の説明を「tmp の排他作成」に直す。読み込み口の点 `etime` は `lstart` と同じく注記と注入の試験で固定する
  - 試験: この雛形を実装で埋める。下の「意図した変更」の既存の試験
- **skills の port の追跡**: `verify-run.sh` の変更は skills 側（cmate-verify）へ移植する PR を**作るところまで**（公開は伺う）。それまで skills の写しは E1 の窓を持つので、空の owner は生まれ続ける（I4 の回収は恒常の規則）。pin の rationale に「移植は別 PR、それまで byte-identical でない」と書く
- **文面の持ち主**: `machine-lock-owner-corrupt`・`machine-lock-ownerless-stray`・`machine-lock-ownerless-old-taker`・`machine-lock-empty-owner-removed` の文面は PR1a-f が節の中で出す。PR1c の上流の設計が lib.sh で出すとしていた `corrupt`・`ownerless-tmp` の文面は、PR1a-f の後は節の文面を伝えるだけにする（二重にしない）
- **API は呼び手と同じ PR**: 新しい公開の API は作らない（`machine_lock_pid_identity` の呼び手は同じ PR の D7 の包み）。オプション（`ownerlessGraceMs`／`LOCK_OWNERLESS_GRACE_MS`）の意味を I3 に広げるのは PR1a で入れたオプションの意味の拡張で、新しい API ではない（今それを渡すのは試験だけ。本番の呼び手は PR1b・PR1c）。空の owner の回収はオプションではなく既定の規則（I4）
- **PR1b・PR1c との関係**: ファイルは重ならない（PR1b は `run-lock.ts`・`run-lock.sh`・`run-server.sh`・`daily.sh`、PR1c は `lib.sh`・`deadline-guard.sh`）が、D7（§4）・K の口（§2.6）・文面は PR1a-f が持ち、PR1b・PR1c は使うだけ。**マージは PR1a-f を先**にし、PR1b・PR1c の表はその後の振る舞いを期待にする
- 難易度: 表が閉じていれば中（sonnet）。I5 の時刻の扱い（BSD/GNU の `date`、etime の解き方の共有）と 3 実装の一致があるので、上流のレビューで表 F が閉じなければ opus

### 5.1 意図した変更（既存の試験）

期待を消す側に変えるものは無い。次の 4 か所は**変異の口か残るものの名前**が変わる（実装の契約で直し、試験のコメントにこの節を書く）:

| 場所 | 今 | 変更 | 理由 |
|---|---|---|---|
| `tests/unit/verification/machine-lock-options-4288.test.ts:272-285`（陽性の対照） | `set -C` を外す・`'wx'` を `'w'` にする変異で「在る owner を上書きする」 | 変異を「公開の `/bin/link`／`linkSync` を `mv -f`／`renameSync` にする」に替える。期待（上書きして取ったと言う）は同じ | 排他は tmp の作成でなく公開の `link` が担う（I2） |
| `tests/unit/verification/lock-pr1a-review-fixes-4288.test.ts:206-219`（TS の陽性の対照） | `openSync(file, 'wx')` → `'w'` | 同上（`linkSync` → `renameSync`） | 同上 |
| `tests/unit/verification/machine-lock-options-4288.test.ts:293-295`（bash の `owner-unlink` の注入） | 戻しの削除に失敗すると `<lock>/owner` が残る | `<lock>/.owner-<token>` が残り、`<lock>/owner` は無い | 書きかけは tmp にしか無い（I1） |
| `tests/unit/verification/machine-lock-options-4288.test.ts:308-309`（同期 JS の同じ注入） | 同上 | 同上 | 同上 |

既存の D3 の試験（`machine-lock-options-4288.test.ts:246-247`、owner がディレクトリ・ディレクトリへの symlink）は変えない。ただし「ディレクトリ」の行は `isDirectory()` しか見ないので、実装の契約で「ディレクトリの中が空のまま」の検査を**新しい行**（表 F の F8）として足す（既存の期待は変えない）。

固定している注入の点の名前（`owner-create`・`owner-write`・`owner-readback`・`owner-unlink`・`lock-rmdir`）と、`owner-create` の注入の対象（`<lock>/owner`。`lock-pr1a-review-fixes-4288.test.ts:186-198` が注入で後継の owner を置く）は変えない: `owner-create` の注入は tmp を開く前に `<lock>/owner` を対象に走らせ、後継が置かれれば公開の `link` が EEXIST になって取らない（期待どおり）。D7 の既存の試験（`machine-lock-options-4288.test.ts:560-596`）は `started_at=2026-11-10T00:00:00Z` で、生きた `sleep` は今日起動する。「違う lstart → removed」の行は `lstart` を TZ の違いでない値（秒の欄が違う）で置いていれば I5 でもそのまま通る。15 分の倍数だけずらした値で置いていれば、I5 では「TZ の違いだけ」で kept になる（実装の契約で行の値を確かめ、そうなら本文に無い指摘として報告する）。

## 6. 新旧の混在

| 書き手（旧） | 新しい読み手が見る形 | 新しい読み手の動き | 判定 |
|---|---|---|---|
| PR1a 版の `lock_obs_create`（`: >` → `cat >>`）が書いている途中 | 0 バイトの owner（若い） | 60 秒以内は `taking` で待つ。書き手は札を持つので、止まっていても他の誰も先頭にならず、回収されない（P0・E12） | ○ |
| PR1a 版・PR1a より前の写し（`printf > owner`、`cfffb31c9:1416`）が SIGKILL で残した 0 バイトの owner | 古い `empty-owner` | 先頭が退かして 0 バイトのままを確かめて回収（I4）。猶予の無い呼び手（ゲート）も回収する | ○（P2-6 を閉じる） |
| 新しい `link` と旧い `set -C` の取り合い | どちらも名前 `owner` の排他（EEXIST）で、上書きしない | ○ | ○ |
| 旧い読み手（PR1a 版・#4277 版）が新しい K2・K3 の `.owner-<token>` だけの `<lock>` を見る | 空でない、owner 無し | 旧い読み手は待つだけ（今の `empty-dir` と同じく取らない） | ○ |
| 旧い `lib.sh`・`run-lock.sh`（札なし、`owner.tmp.$$` → `mv -f`、失敗で `rm -rf "$dir"`） | `tmp-old` | 名前の pid が gone のときだけ回収（I3）。書き手が猶予を超えて止まっていても生きていれば回収しない（`old-taker`）ので、再開した書き手の `rm -rf "$dir"` が後継の `<lock>` を消す経路は生まれない（codex P1） | ○ |
| 旧い `lib.sh` の読み手（`find -mmin +1` で owner の無い `<lock>` を中身ごと取る） | 新しい取得者の K1〜K3 で 1 分を超えて止まった `<lock>` | 旧い読み手が取ると、新しい取得者の `link` は ENOENT（F11）で断り、何も消さない | ○（親 §1.9 の範囲） |
| 旧い `lib.sh` の退避 `<lock>.stale.*` | 読まない | 結果を変えない | ○ |
| 旧い supervisor.lock の記録（`pid lstart label token`、`host=`・`started_at=` 無し） | `lstart-legacy*` | owner の mtime を `started_at` の代わりに I5（TZ が違うだけの生きた持ち主は残し、再利用は回収） | ○（P3-1） |
| PR1a 版の `machine-lock.sh` を読む旧いチェックアウト（同期の前のガード） | 新しい記録 | `lstart=` の文字列だけで判定するので TZ の穴は旧いチェックアウトの同期まで残る | 範囲の文（§8 の 3） |
| cmate-verify 0.7.0 より前の写し（札を知らない） | — | 札を無視して `mkdir` する。P0 の外（親 §1.9） | 範囲の文 |

## 7. 処分（pm-return-4288-pr1af-upstream）の対応

| 処分 | 入れた場所 |
|---|---|
| 1 旧版の再開で生きた後継のロックを消す（codex P1） | I3（`owner.tmp.<pid>` は pid が gone のときだけ）、表 T `tmp-old`・`tmp-old-young`、F26〜F28、§6 |
| 2 I4 の前提の誤り（PM Claude P2-6） | P0、I4（空の owner は 60 秒を過ぎ先頭として退かして確かめて回収）、表 T `empty-owner`、F29〜F31、§5 の sync-map.json と skills の port |
| 3 I3 は別の述語（PM Claude P2-2・codex P2） | I3 の `lock_ownerless_temps_only`／`ownerlessTempsOnly`、表 T `tmp-new+gone-dead`・`tmp-new+gone-alive` |
| 4 bash の公開は link(2) の意味（PM Claude P2-1） | I2（`/bin/link --`、errno の読み）、I2-b（`-ef`）、E11、F7〜F11・F13・F14 |
| 5 etime のパーサー（codex P2）ほか | I5、§4.1 の `machine_lock_etime_ms`、F35〜F37、F38〜F40、F45 |
| 6 F24 の例外 | I5 の (1) を TZ の違いを同じ起動と読む比較にし、F42 を keep に。I7 と型（`residual` を持たない） |
| 7 表は型つきの列挙、3 実装の軸（PM Claude P2-3・P2-4・codex P2） | §2.4・§2.6・§3、雛形（3 つの表を別々の字面で書き、規則と互いとを比べる。TS の K1〜K3 は `no-grace-caller`、F5・F6） |
| 8 TZ と PR1c の契約 | §4 |
| 9 K の割込みの口・P3 の残り | §2.6、下の表 |

| P3（PM Claude） | 入れた場所 |
|---|---|
| P3-1 legacy の再利用 | I5（owner の mtime）、`lstart-legacy-reused`、§6 |
| P3-2 `LOB_STARTED_AT` の持ち越し | I5、F40 |
| P3-3 引渡しの後の D7 | I5、F45 |
| P3-4 G だけで alive の記録 | I5、F44 |
| P3-5 旧い取得者の長い停止 | I3、F27 |
| P3-6 F3・F6 の `rmdir`、F16 の ENOENT | I2-b、F3・F11、F23 |
| P3-7 `lock_recover` のコメント | §5 の書くファイル、F11 |
| P3-8 若い corrupt の文面 | I4、F29、表 T `empty-owner` × alive |
| P3-9 I1 は SIGKILL の範囲 | I1 |
| P3-10 launchd の環境 | F43 |
| P3-11 `lstart-ps-fails` を分ける | 表 T `lstart-fails`・`etime-fails`・`lstart-same-etime-fails` |
| P3-12 文面の陽性の対照・`KILL_NOW` | §2.2（結果は文面の組）、§2.6 の陽性の対照、雛形の `KILL_NOW` |
| P3-13 now を取る順と余裕 | I5、§4.1 の 1 |
| P3-14 割込みの口 | §2.6 |
| P3-15 文面の持ち主・API の例外 | §5 |

## 8. 残る判断（PM へ）

1. **TS（`machine-lock.ts`）を PR1a-f に入れるか**: 1 回目のまま入れる案（同じ窓 E2、§2.8 の `owner-create` は 3 実装の点）。1 回目の PM Claude は賛成
2. **猶予の無い呼び手の K1〜K3 の残り（`empty-dir`・`tmp-new`）**: 今も人が消すまで残る（#4277 からの振る舞い）。空の owner は I4 で回収するようになったが、owner の無い `<lock>` の既定の猶予は別の Issue にする案（この PR では既存の利用者の既定を変えない、§1.6 の方針のまま）
3. **PR1a 版の `machine-lock.sh` を読む旧いチェックアウト**: TZ の穴は同期まで残る。supervisor.lock を使う常駐（`../commandmate-agent-health`）を PR1a-f のマージの後に同期する手順を PR1c の切替の手順に入れる案

## 9. 本文に無い指摘

- `scripts/agent-health/product/deadline-guard.sh:55` と `supervisor.sh:105`・`:187`・`:238`（台帳の `lstart`）の `proc_matches` も地方時の `lstart` の文字列の比較で、E5 と同じ TZ 依存がある（台帳の判定で、ロックの外）。§4 の `machine_lock_pid_identity` を呼べば塞げる（PR1c か別 Issue）
- `lock_settle_gone`（`verify-run.sh:1400`）は owner の無い退避先を `rmdir` するだけなので、一時ファイルが残った `.gone-*` は空にならず残り続ける（保有中とは読まれないので害は無く、散らかるだけ）
- `verify-run.sh:1129-1151` の `lock_pid_start_ms` は `etime` の形を確かめず、不正な出力を「今起動した」と読む（E7）。札の退かしで、生きた札を再利用と読みうる（消す側。ロックではなく列の順を崩す）。PR1a-f で同じ規則の解き方に替える（F37）が、今の develop にある欠陥として記録する
- PR1a 版の書き込みの失敗の後始末 `rm -f "$LOCK_PATH/owner"`（`verify-run.sh:1645`）は名前で消すので、`cat >>` が失敗するまでの間に owner が他者のものに替わっていれば他者の owner を消す。P0 の札で先頭は 1 人なので今の develop では起きないが、PR1a-f で消える形（I2-b の `-ef`）
