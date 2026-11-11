# Issue #4288 PR1b: run-lock を machine-lock に載せる（上流の段: 設計の 4 つと試験の表）

- 状態: **上流の 2 回目**（設計と試験の表だけ。`src/`・`scripts/`・既存の試験は変えない）。1 回目（`ee92499cd`）への上流のレビュー（Claude 5 `prereview/review-4288-pr1b-upstream.md`・PM Claude `pm-review-4288-pr1b-upstream-claude.md`）と PM の処分（`pm-return-4288-upstream.md` の共通の決定 1〜5・PR1b の個別の決定）を反映した。**不変条件 I-1〜I-11 の文は変えていない**（全員一致で正しい）。直したのは表（型つきの列挙に組み直した）と、既存の試験との契約（§4.4）。実装は、この表が上流のレビューで P2 0 になった後の「赤から緑にする」契約で行う
- 対象: run-lock（`src/lib/agent-health/run-lock.ts`・`scripts/uat/run-lock.sh`・`scripts/uat/run-server.sh`・`scripts/agent-health/daily.sh`）を、PR1a（#4309、develop `b57c2aba6`）でマージ済みの machine-lock（`scripts/lib/machine-lock.sh`・`scripts/orchestrate/machine-lock-sync.mjs`・`.claude/skills/cmate-verify/scripts/verify-run.sh` のロックの節）に載せる部分だけ。supervisor.lock は PR1c（別の上流の段）。owner の書き込みの原子性・旧版の `owner.tmp.*` だけの `<lock>`・lstart の TZ は PR1a-f（PM 共通の決定 1）
- 土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) の §1（D1〜D12）・§1.8・§1.9・§1.11・§1.14（D12 の不変条件）・§7。本書はそれを**置き換えない**。D 番号・§1.14 の表はそのまま引く
- 行番号は develop `b57c2aba6` のもの。名前で引くこと
- 表記: **事実**＝コードを読んで（または実行して）確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 試験の表: [`tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts`](../../tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts)。**表の正は試験のファイルの型つきの列挙**で、本書 §2 の表はその読み下し。セルの足し忘れは `satisfies` で型の誤り、各行は §1 の不変条件の検査に当たる。実装を呼ぶ所は `it.todo`

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| (a) 不変条件 | 11 本（I-1〜I-11、文は 1 回目のまま）。消すのは 3 つの経路だけ・不明は空きと読まない・needs-head は D5・bash は main シェル・自己グループの例外は使わない・引渡しは自分の T0 から・子は合図の後だけ・token と欄の字・down は確かめた G だけに送る ほか | §1 |
| (b) 状態と遷移の表 | 行は 3 種: **到達**（本番の呼び手がある）・**拒否**（本番の呼び手が無く、包みの引数・文脈の検査が `<lock>` に触る前に断る。表 E を指す）・**到達しない**（起きない、理由つき）。表 A（記録の形 18 × 呼び手 10 × 観測〔pid と G を別の軸に〕= **900 行**）、表 B（D9 の段 = **24 行**）、表 C（UAT `down`: 記録 6 × 長 5 × G の残り 4 = **120 行**）と C′（D5 の結果 → 状態 **6 行**）、表 D（引渡しの段の失敗 × 流れ = **20 行**）、表 D2（ゾンビ・host の変化・EPERM・空にならない G × 呼び手 = **20 行**）、表 E（引数・文脈の検査 × 実装 = **20 行**）。**計 1110 行**（到達 697・拒否 90・到達しない 323） | §2 |
| (c) 失敗の倒れ方 | 1 回目の表に、合図の `mkdir go`・子の `mkdir ack`・状態ファイルの書き込み・ゾンビ・host の変化を足し、`lsof` の行を「送る側」に直した。消す側に倒れるのは 2 か所（rm の部分失敗・TS の `rmSync` の例外）のままで、どちらも他者のロックを消さない | §3 |
| (d) PR の切り方 | PR1b を 1 本。引数・文脈で拒否する検査 10 種（表 E）。PR1b と PR1c の契約（§4.3、PR1c の設計と同じ文）。既存の試験の**意図した変更** 2 本と台の変更 2 本、形を変えない 1 本（§4.4） | §4 |

---

## 0. 前提の確かめ（事実）

1 回目の F1〜F14 はそのまま（F11 だけ直した）。上流のレビューを受けて確かめ直したものを F15〜F22 に足した。

| # | 事実 | 場所 | 本書での扱い |
|---|---|---|---|
| F1 | 停止の猶予 `KILL_GRACE_SEC=5` は節の中にある | `verify-run.sh:611`、`machine-lock.sh:29-31` | review-4288h P2-1 は PR1a で閉じている（§5） |
| F2 | bash の取得の owner の pid は `${LOCK_OWNER_PID:-$$}`、token は `LOCK_WANT_TOKEN` | `verify-run.sh:1620`、`:1549-1553` | run-lock.sh の包みは `LOCK_OWNER_PID=<pid 引数>`・`LOCK_WANT_TOKEN=<token 引数>` で呼ぶ |
| F3 | 取得に失敗したときの `LOCK_HELD_BY` は JSON の欄の読みで作り、kv の記録では空になる | `verify-run.sh:1680-1685`、`:719` | 文面は PR1b の `run_lock_holder` が kv から作る（§4.6） |
| F4 | 退避の名前は `<lock>.gone-<取得者の token>-<連番>` で、読み手は接尾辞が `[A-Za-z0-9-]` だけのものしか読まない | bash `:1461`・`:1278`、sync `:630`・`:704`・`:129` | I-8 で token の字を限り、引数で拒否する（表 E `token-chars`） |
| F5 | 同期 JS の `cleanupOwnGone` は自分の token の退避を G を見ずに消す。bash の `lock_release_own_gone` は G が空でなければ残す | sync `:680-690`、bash `:1434-1449` | TS の run-lock は pgid を書かないので PR1b では届かない（表 A の `ts-release × aside-own-g` は到達しない）。§7 |
| F6 | 同期 JS の取得は `mkdir` の不明・owner の作成の失敗・札の `link` の失敗で例外を投げる | sync `:450-453`・`:474-476`・`:392`・`:805`、`run-lock.ts:160-163` | TS の包みは例外を捕まえて `{ ok: false, error }` にする |
| F7 | macOS の `/bin/bash` は 3.2.57 で `BASHPID` が無い | — | 子は `bash -c` で起こす（§4.5） |
| F8 | `stop_recorded` は記録の pid が生きていなければ「止めた」と同じ 0 を返す | `run-server.sh:110-112` | 表 C の `dead` は `kill -0` の ESRCH で決め、G の残りを見る |
| F9 | 既存の試験は bash の取得に `$$` でない pid を渡す（`run_lock_acquire uat <node の pid> sh-token /r`）。期待は exit 0 で、解放はしない | `run-lock-3359.test.ts:114-121` | bash の取得は pid≠`$$` を受ける（期待を変えない）。その取得の**解放と引渡しを拒む**（表 E `sh-release-after-foreign-pid`・`handoff-pid-not-self`）。TS は pid≠`process.pid` を拒む（`ts-pid-not-self`。TS の試験は `process.pid` しか渡さない `:60`） |
| F10 | kv の codec は呼び手の欄を `pgid=` の行の**前**に書き、読みは各鍵の最初の行を取る | `machine-lock.sh:168-169`、`:146-150` | I-8 で欄の改行を引数で拒否する（表 E `field-newline`） |
| F11（直した） | D5 は記録が `missing` のとき**自分の token の退避を `lock_release_own_gone` で片付ける**（1 回目は「退避を片付けない」と書いていた。誤り）。`released` の後も同じ。canonical の owner の無い `<lock>` は `missing` で消さない | `verify-run.sh:1955-2003`（`missing)` の枝と `released` の後） | 表 A の D5 の `aside-own*` のセル（`missing(aside-removed)`） |
| F12 | UAT の `up` は今も `state_set … server_pid` を `run_lock_set_pid` の**前**に書くが、`state_set` の失敗を見ない | `run-server.sh:472-473` | I-6 の条件に「書けなければ引き渡さずに exit 1」を足す（表 D `state-write`） |
| F13 | D12・D5 の削除は `rm -rf … \|\| true` で、失敗しても `released` と答える。同期 JS は `fs.rmSync` で、失敗は例外 | `machine-lock.sh:241`、`verify-run.sh:1986`、sync `:930`・`:1127` | §3 の rm の行。§7 |
| F14 | 壊れた記録（`pid=` か `token=` が無い owner）は、新しい取得では回収されない | sync `:981-984`、bash `:1660` | 表 A の `corrupt` は全呼び手で消さない・取らない。PR1a-f で塞ぐまで文面で人に知らせる（§4.6、PM 共通の決定 1） |
| F15 | `lock_release_own_gone` は退避の記録の **G だけ**を見る。`lock_group_state ''` は `gone` を返すので、`pgid=` の無い退避は pid を見ずに消す | `verify-run.sh:1087-1089`、`:1434-1449` | 表 A で `aside-own`（pgid 無し）と `aside-own-g` を分けた（Claude 5 P2-2）。退避ができるのは先頭が gone と判定した記録だけなので、`aside-own` の pid の今の観測は再利用の観測で、セルはこの部品どおり（§2.2 の注） |
| F16 | D12 は `LOCK_HELD_PATH` がこのロックでなければ何も読まずに `LRH_RESULT=none` を返す（取得していないシェル・継いだシェル・2 度目の呼び出し）。最初に `LOCK_HELD_PATH` を消す | `machine-lock.sh:198-206` | `none` を結果の列挙に足し、呼び手 `sh-release-unheld` の列にした（Claude 5 P3）。daily の EXIT は G を空にしてから D12 を 1 回だけ呼ぶ（§4.2） |
| F17 | `daily.sh` は `CM_RUN_LOCK_TOKEN` を**同じシェルの中で**設定してから取得するので、自分の取得が継承の経路（D8）を通る | `daily.sh:91-92` | PR1b は取得の後に `export CM_RUN_LOCK_TOKEN=…` する形に直し、`up`・`cleanup` は冒頭で `CM_RUN_LOCK_TOKEN` を消す（§4.2。表 A の継承の `own-other` が到達しない理由） |
| F18 | `uat-yaml-2590.test.ts` は `$SERVER_ENTRY` を含む論理行が `env -i ` で**始まり**、代入が `env -i` と最初の `nohup` の間にあることを固定している（行継続は 1 行に畳む） | `uat-yaml-2590.test.ts:65-71`・`:154-160`・`:187-193` | 子の待ちは `nohup` の後ろの `bash -c` に入れ、形を変えない（§4.5、PM 個別の決定） |
| F19 | `run-server-3359.test.ts:357-378` は「owner の `pid=` を死んだ pid に書き換え、サーバーを生かしたまま 2 回目の `up` が取れて片付ける」、`:430-437` は「新しいシェルの `run_lock_release parent` で `<lock>` が消える」を固定している | 同 | 新しい形では両方とも断る（生きた G のロックは消さない）。**意図した変更**（§4.4、PM 個別の決定） |
| F20 | `daily-sh.test.ts:95`・`metrics-sh.test.ts:42` は種のリポジトリに `run-lock.sh` **だけ**を写す | 同 | 新しい `run-lock.sh` が読む `scripts/lib/machine-lock.sh` と `verify-run.sh` も写す（台の変更、期待は変えない。§4.4） |
| F21 | `lock_child_wait` は `go` を見るか、親が生きていない・期限を過ぎたら自分で `go` を作って 1 を返す。`ack` を作れなければ 1 | `verify-run.sh:2065-2078` | 表 B・表 D の `abort`・`ack` |
| F22 | ゲートの引渡しは合図の `mkdir go` の結果で `created`→続ける・`exists`→`abort`・それ以外で `go` が無い→`signal` に分ける | `verify-run.sh:2370-2386` | 表 D の `signal`・`abort` は同じ分け方 |

---

## 1. (a) 不変条件

文は 1 回目（`ee92499cd`）のまま。「守る場所」の列だけ、上流のレビューの指摘（I-5 の試験が空振り・I-11 の検査が同じオブジェクトを比べていた・I-10 の根拠の範囲）に合わせて直した。

| # | 不変条件 | 根拠（事実）と、守る場所 |
|---|---|---|
| **I-1 消す経路は 3 つ** | canonical の `<lock>` を消すのは次の 3 つだけ: (i) **持ち主自身の解放**（D12）: 記録の token が自分のもので、記録の pid が呼び手自身（TS は `process.pid`、bash は main シェルの `$$` で `kill -0 $$` が alive）、かつ記録に `pgid=` があればその G が空。(ii) **先頭としての解放**（D5）: 札の先頭で、記録の token が渡された自分の token のどれかで、保有者の判定（pid、`pgid=` があれば G も）が `gone`。(iii) **先頭の回収**: 札の先頭が、保有者が `gone` の記録を退かしてから token を確かめて消す／owner が無く空で 60 秒を超えた `<lock>` を `rmdir` する（D3）。missing・corrupt・不明・他の token の記録は、どの解放でも消さない | D12 `machine-lock.sh:198-257`・sync `:906-940`、D5 `verify-run.sh:1955-2003`・sync `:1109-1131`、回収 `:1459-1489`・sync `:703-731`、D3 `:1501-1535`・sync `:487-504`。試験: 表 A の `after = removed` の行は、`removalAllowed`（呼び手 × 形 × pid × G）に**ちょうど**一致する（1 回目は観測を見ていなかった。Claude 5 P3） |
| **I-2 不明は空きと読まない** | 観測が不明のとき、取らない・継がない・消さない・引き渡さない。不明は `refused`／`deferred`／`kept`／`unknown`／拒否のどれかで、後の先頭に残す | 試験: 行が**判定に使った軸**が unknown なら、取得・継承・`released`・`handed`・`removed`・`mine`・`t1`・`aside-removed` のどれも無い（`decidedOnUnknown`: 保有者の判定は pid が先で gone のときだけ G、D12 は G が先で gone のときだけ pid、自分の退避の片付けは G だけ。1 回目は `aside-removed` を見ていなかった。PM Claude P3-2） |
| **I-3 needs-head は D5、再試行も D5** | 解放が `needs-head` を返したら、呼び手は同じ実行の中で D5 を呼ぶ。`deferred`・`not-head`・`unknown` は消さずに残し、保有者が死んだ後に次の先頭か D5 の再実行が消す。`lock_release_held`／`release` を 2 度呼ばない | `run_lock_release`（bash の D12 の包み）が needs-head を受けたら中で `run_lock_release_as_head` を `[T0, T1]` で 1 回呼ぶ。needs-head が出るのは UAT の T1（pid＝サーバー）の G が空になった後だけ（試験で固定）。TS は pid≠`process.pid` を拒むので needs-head は出ない |
| **I-4 bash の呼び手は main シェル** | `run_lock_acquire`・`run_lock_set_pid`・`run_lock_release`（D12）・D5 は main シェル（`BASH_SUBSHELL=0`）から呼ぶ。1 つのシェルが持つ run-lock は 1 つ | サブシェルからの引渡しと解放は包みが拒否する（表 E `handoff-subshell`・`release-subshell`。本番の呼び手は無い） |
| **I-5 自己グループの例外は使わない** | D12 の例外（記録の pid と `pgid` がどちらも呼び手自身なら G を判定しない）は、子をすべて待つ呼び手（merge-pr）だけのもの。run-lock はその形の記録を作らない | 試験: 形 `own-self-selfg`（pid＝pgid＝呼び手）を表 A に置き、bash の全呼び手で**拒否**（表 E `handoff-pgid-self`: `run_lock_set_pid` が pgid＝`$$`・pgid＝このシェルの pgid を断る）、TS の全呼び手で到達しない（pgid を書かない）。1 回目の「`own-self-g` で deferred」は例外の枝に入らない空振りだった（PM Claude P2-5） |
| **I-6 引渡しは自分の T0 から、仕事の前に** | `run_lock_set_pid`（D4）は、owner を 1 回読んで「token が T0・記録の pid が `$$`・main シェル・`kill -0 $$` が alive」のときだけ `lock_hand_off` を呼ぶ。T1＝`<T0>-g<G>`。UAT は `server_pid` を状態ファイルへ書いてから引き渡す | 加えて（上流の 2 回目）: `state_set server_pid` が失敗したら引き渡さずに exit 1（表 D `state-write`、PM Claude P2-1）。2 度目の引渡し・pgid＝`$$` は拒否（表 E） |
| **I-7 子は合図の後だけ働く** | 保護する実作業は、自分のグループ G の長として起こされ、`go` を見て `ack` を作るまで exec しない。親が死んだ・期限を過ぎたら自分で `go` を作って取り下げる。`go` は T1 の読み直しが通った後にだけ親が作る | `lock_child_wait`（F21）。表 B・表 D |
| **I-8 token と欄の字** | token は `[A-Za-z0-9-]+`。`label`・`run_dir` は改行を含まない。外れたら取得しない | 表 E `token-chars`・`field-newline` |
| **I-9 保有区間は重ならない** | 異なる token の保有区間は重ならない（土台 §1.8 の条件 (1)〜(6) をそのまま受け継ぐ） | 取得・回収・`rmdir` は札の先頭 1 人 |
| **I-10 down は確かめた G だけに送る** | `down` が G に信号を送るのは、(1) 長が生きていて、今の確かめ（`CM_DB_PATH`・port・`ps -o pgid=` が G）を通ったとき、または (2) 長が死んでいて、G の残りの**全員**の `CM_DB_PATH` が run dir の下のときだけ。どちらでもなければ何も送らず、ロックを残し、「停止完了」と書かない | 根拠の範囲（Claude 5 P3 で狭めた）: (1) は**長が生きている間**だけ「G の番号は再利用されない」が成り立つ。長を TERM して `wait`（up の trap）／ESRCH を見た（down）後に G へ送るのは (2) と同じく、送る直前に一覧し直して全員を確かめる。G が `unknown`（EPERM）のときは長だけに送る（1 回目の表の `leader+group` は誤り。Claude 5 P2-4）。`go` の前の失敗は待っている子の **pid だけ**に送る（表 D、PM Claude P3-6） |
| **I-11 1 つの run-lock に 1 つの実装** | TS と bash は同じ `<lock>`・`.queue`・`.gone-*` を同じ規則で扱う。表 A の取得と継承の列は TS と bash で同じセル | 試験: TS と bash の取得・継承の表を**別々に書いたオブジェクト**にして比べる（1 回目は同じオブジェクトを比べていて常に通った。PM Claude P3-1）。違うのは `own-self-selfg` の「なぜ到達しないか」だけ（TS は pgid を書かない、bash は拒否）。実装の一致は `it.todo`（両方を同じ行で走らせて比べる） |

全経路で成り立つ理由（経路 → 効く不変条件）:

| 経路 | 効く不変条件 |
|---|---|
| `main.ts` の取得・解放・signal | I-1 (i)・I-2・I-8・I-9。signal・`kill -9` は解放しない→次の先頭が (iii) で回収 |
| `daily.sh` の取得・引渡し・子・EXIT・INT／TERM | I-4・I-6・I-7・I-5（pid≠pgid）・I-1 (i)（G が空のときだけ）・I-3 |
| `run.ts`（とその bash の子）の継承 | I-2・D8。継ぐ者は G の中なので T1 は gone にならない |
| UAT `up` の取得・引渡し・失敗の trap | I-6・I-7・I-1 (i)（T0）／(ii)（T1 は needs-head→D5）・I-3・I-10（go の後の trap は down と同じ手続き） |
| UAT `down` | I-10・I-1 (ii)・I-3 |
| UAT `cleanup` | I-1 (i)・I-4。生きた G の T1 があれば取得を断る |

---

## 2. (b) 状態と遷移の表

### 2.1 列挙と行の 3 種

**行の 3 種**（PM 共通の決定 2）: **到達**＝本番の呼び手がこの行に来る（セルが期待）。**拒否**＝本番の呼び手が無い組み合わせで、包みの引数・文脈の検査（表 E）が `<lock>`・札・退避に触る前に断る（試験: 指す検査が、その実装で到達の行であること）。**到達しない**＝起きない（理由の文つき）。

**記録の形（18）**: pid だけで観測する 12 形と、G を名乗る 6 形（`-g`）。

| 形 | 中身 |
|---|---|
| `none` | `<lock>` も退避も前の札も無い |
| `ticket-ahead` | `<lock>` は無く、他者の札が前に居る |
| `ownerless-young`／`ownerless-old` | owner の無い**空の** `<lock>`、mtime ≤ 60 秒／> 60 秒 |
| `ownerless-nonempty` | owner の無い**空でない** `<lock>`（旧版の `owner.tmp.*`・`rm -rf` の部分失敗の残り）。D3 の `rmdir` が効かない。**PR1a-f で塞ぐ**、それまでは断り続けて文面で知らせる |
| `unreadable` | owner が読めない（EIO・EACCES・数でない `pgid=`） |
| `corrupt` | owner は読めたが `pid=` か `token=` が無い（排他作成と追記の間の SIGKILL で残る空の owner を含む、PM Claude P3-8）。**PR1a-f で塞ぐ** |
| `own-self` | 自分の token・記録の pid が呼び手自身・`pgid=` 無し（main.ts、引渡しの前の daily・UAT `up`・`cleanup` の T0） |
| `own-other` | 自分の token・pid が呼び手でない・`pgid=` 無し（`down` から見た `up` の T0、旧い形の記録、bash の pid≠`$$` の取得） |
| `foreign` | 他の token・`pgid=` 無し |
| `aside-own`／`aside-foreign` | `<lock>` は無く、自分の／他の token の `pgid=` の無い退避 `<lock>.gone-*` がある |
| `own-self-g` | 自分の T1・pid が呼び手自身・`pgid=G`（引渡しの後の daily） |
| `own-self-selfg` | 自分の記録で pid＝pgid＝呼び手（D12 の自己グループの例外の形）。**作らない**（I-5） |
| `own-other-g` | 自分の T1・pid が呼び手でない・`pgid=G`（UAT の T1＝サーバー＝G の長、`run.ts` から見た daily の T1） |
| `foreign-g` | 他の token・`pgid=` あり |
| `aside-own-g`／`aside-foreign-g` | `<lock>` は無く、自分の／他の token の `pgid=` のある退避 |

**呼び手（10）**: `ts-acquire`・`ts-inherit`（D8）・`ts-release`（取った handle の `release()`）・`ts-release-inherited`（継いだ handle の `release()`。何もしない）・`sh-acquire`・`sh-inherit`・`sh-release-held`（取った main シェルの `run_lock_release`＝D12。needs-head なら中で D5）・`sh-release-unheld`（何も持たないシェルの `run_lock_release`: 新しいシェル・継いだシェル・2 度目。D12 は `none`）・`sh-hand-off`（`run_lock_set_pid`）・`sh-release-as-head`（D5: `down` と、`run_lock_release` の needs-head の後）。

**観測（PM 共通の決定 3: pid と G を別の軸に）**: 各軸は「聞けば返る値」`alive`・`gone`（ESRCH）・`unknown`（それ以外の失敗）。pid だけの形は 1 軸 3 値（`none`・`ownerless-*` などは一覧・mtime の観測で、alive・gone は「見えた」）、`-g` の形は pid × G の 9 値。セルがその軸を聞かないなら、軸の 3 値で同じセル。保有者の判定は **pid が先で、pid が gone のときだけ G**（`lock_holder_state`）。D12 は **G が先で、G が gone のときだけ pid**（`lock_release_held`）。自分の退避の片付けは **G だけ**（F15）。

**結果（コードの結果から）**: 取得系 `acquired`・`recovered-acquired`・`expired-acquired`・`reclaimed-acquired`・`refused`・`inherited`。解放系 `none`（F16）・`released`・`needs-head`・`deferred`・`kept`・`missing`・`unknown`・`not-head`（`LRH_RESULT`・`LRAH_RESULT`・sync の `release` の値）。引渡し `handed`・`stage-token`。引数・文脈の拒否は「拒否」の行（表 E の `refused-arg`）。後の `<lock>`: `mine`・`removed`・`unchanged`・`restored`・`aside-removed`・`t1`。次: `D5`・`next-head`。

**断る文面の種類**（`refused` のセルは必ず 1 つ持つ。型で必須）: `held`・`held-group`・`ticket`・`unknown`・`corrupt`・`ownerless-young`・`ownerless-nonempty`・`aside`。文面の規則は §4.6。

### 2.2 表 A: 記録の形 × 呼び手 × 観測（900 行）

記号: `A`＝acquired(mine)、`Rc`＝recovered-acquired(mine)、`Ex`＝expired-acquired(mine)、`Rl`＝reclaimed-acquired(mine)、`✕m`＝refused（文面 m。`r` は restored）、`In`＝inherited、`rel`＝released(removed)、`nh→D5`、`def→`＝deferred→next-head、`kept`、`miss`＝missing、`unk→`、`nh-`＝not-head→next-head、`hand`＝handed(t1)、`stk`＝stage-token、`0`＝none、`—`＝到達しない、`⊘x`＝拒否（表 E の x）。`/` は観測の 3 値（alive／gone／unknown）。

**pid だけの形（12 形 × 3）— 取得と継承**（TS と bash で同じ。I-11）

| 形 | 取得（ts-acquire・sh-acquire） | 継承（ts-inherit・sh-inherit） |
|---|---|---|
| `none` | A / A / ✕unknown | 取得と同じ |
| `ticket-ahead` | ✕ticket / A / ✕unknown | 取得と同じ |
| `ownerless-young` | ✕ownerless-young ×3 | 取得と同じ |
| `ownerless-old` | Ex / Ex / ✕unknown | 取得と同じ |
| `ownerless-nonempty` | ✕ownerless-nonempty ×3 | 取得と同じ |
| `unreadable` | ✕unknown ×3 | 取得と同じ |
| `corrupt` | ✕corrupt ×3 | 取得と同じ |
| `own-self` | — ×3 ¹ | — ×3 ² |
| `own-other` | — ×3 ¹ | — ×3 ³ |
| `foreign` | ✕held / Rc / ✕unknown | 取得と同じ |
| `aside-own` | — ×3 ¹ | — ×3 ³ |
| `aside-foreign` | ✕aside r / Rl / ✕unknown r | 取得と同じ |

**pid だけの形 — 解放と引渡し**

| 形 | ts-release | ts-release-inherited | sh-release-held（D12） | sh-release-unheld | sh-hand-off | sh-release-as-head（D5） |
|---|---|---|---|---|---|---|
| `none`・`ownerless-*` | kept ×3 | 0 ×3 | kept ×3 | 0 ×3 | stk ×3 | miss ×3 |
| `ticket-ahead` | kept ×3 | 0 ×3 | kept ×3 | 0 ×3 | stk ×3 | nh- / miss / nh- |
| `unreadable` | def→ ×3 | 0 ×3 | def→ ×3 | 0 ×3 | stk ×3 | unk→ ×3 |
| `corrupt` | kept ×3 | 0 ×3 | kept ×3 | 0 ×3 | stk ×3 | kept ×3 |
| `own-self` | rel / — ⁴ / — ⁴ | 0 ×3 | rel / — ⁵ / — ⁵ | 0 ×3 | hand / — ⁵ / — ⁵ | — ×3 ⁶ |
| `own-other` | ⊘ts-pid-not-self ×3 | 0 ×3 | ⊘sh-release-after-foreign-pid ×3 | 0 ×3 | ⊘handoff-pid-not-self ×3 | def→ / rel / def→ |
| `foreign` | kept ×3 | 0 ×3 | kept ×3 | 0 ×3 | stk ×3 | kept ×3 |
| `aside-own` | — ×3 ⁷ | 0 ×3 | — ×3 ⁷ | 0 ×3 | — ×3 ⁷ | miss(aside-removed) ×3 ⁸ |
| `aside-foreign` | kept ×3 | 0 ×3 | kept ×3 | 0 ×3 | stk ×3 | miss ×3 |

**G を名乗る形（6 形 × pid 3 × G 3）**: セルは `pid alive: [G alive / gone / unknown] ; pid gone: […] ; pid unknown: […]`。軸 1 つで同じなら `×9`。

| 形 | 取得（TS＝bash） | 継承（TS＝bash） |
|---|---|---|
| `own-self-g` | — ×9 ¹ | — ×9 ² |
| `own-self-selfg` | TS — ×9（pgid を書かない）、bash ⊘handoff-pgid-self ×9 | 同左 |
| `own-other-g` | — ×9 ¹ | pid alive: In / — ⁹ / In ; pid gone: In / — ⁹ / ✕unknown ; pid unknown: ✕unknown / — ⁹ / ✕unknown |
| `foreign-g` | pid alive: ✕held ×3 ; pid gone: ✕held-group / Rc / ✕unknown ; pid unknown: ✕unknown ×3 | 取得と同じ |
| `aside-own-g` | — ×9 ¹ | — ×9 ⁹ |
| `aside-foreign-g` | pid alive: ✕aside r ×3 ; pid gone: ✕aside r / Rl / ✕unknown r ; pid unknown: ✕unknown r ×3 | 取得と同じ |

| 形 | ts-release | ts-release-inherited | sh-release-held（D12） | sh-release-unheld | sh-hand-off | D5 |
|---|---|---|---|---|---|---|
| `own-self-g` | — ×9 ¹⁰ | 0 ×9 | pid alive: def→ / rel / def→ ; pid gone・unknown: — ⁵ | 0 ×9 | ⊘handoff-twice ×9 | — ×9 ⁶ |
| `own-self-selfg` | — ×9 ¹⁰ | — ×9 ¹⁰ | ⊘handoff-pgid-self ×9 | ⊘handoff-pgid-self ×9 | ⊘handoff-pgid-self ×9 | ⊘handoff-pgid-self ×9 |
| `own-other-g` | — ×9 ¹⁰ | 0 ×9 | pid alive: def→ / — ¹¹ / def→ ; pid gone: def→ / nh→D5 / def→ ; pid unknown: def→ ×3 | 0 ×9 | ⊘handoff-twice ×9 | pid alive: def→ / — ¹¹ / def→ ; pid gone: def→ / rel / def→ ; pid unknown: def→ ×3 |
| `foreign-g` | kept ×9 | 0 ×9 | kept ×9 | 0 ×9 | stk ×9 | kept ×9 |
| `aside-own-g` | — ×9 ¹⁰ | 0 ×9 | pid alive: kept / — ¹¹ / kept ; pid gone・unknown: kept / kept(aside-removed) / kept | 0 ×9 | ⊘handoff-twice ×9 | pid alive: miss / — ¹¹ / miss ; pid gone・unknown: miss / miss(aside-removed) / miss |
| `aside-foreign-g` | kept ×9 | 0 ×9 | kept ×9 | 0 ×9 | stk ×9 | miss ×9 |

注（到達しない理由。試験の `never(…)` と同じ文）: ¹ 取得の token は毎回新しいので、自分の token の記録は取得の前に無い。² 継ぐ者は記録の pid ではない。³ 継ぐ者は daily の子だけで、子は `go` の後に始まる（I-7）ので見る記録は T1。`up`・`cleanup` は `CM_RUN_LOCK_TOKEN` を消してから取る（F17）。⁴ Node は自分の pid を観測しない。⁵ main シェルの `$$` は呼び手自身で生きている（自分の uid の生きた pid への `kill -0` は ESRCH にも EPERM にもならない。サブシェルは表 E で拒否）。⁶ D5 を呼ぶのは `down` と `run_lock_release` の needs-head の後だけで、どちらも記録の pid は呼び手の `$$` でない（Claude 5 P2-1・PM Claude P3-9）。⁷ `$$`／`process.pid` で取った記録は、その pid が生きている間 gone と判定されず退かされない。⁸ 下の「読み方」。⁹ 継ぐ者は G の中に居るので G は ESRCH にならない。¹⁰ TS は pgid を書かない。¹¹ UAT の T1 の pid は G の長なので、pid が生きていれば G は空でない。

読み方の要点:

- **消すのは 4 か所だけ**（I-1。試験の `removalAllowed` と一致）: `ts-release × own-self × alive`、`sh-release-held × own-self × alive`、`sh-release-held × own-self-g × pid alive × G gone`、D5 の `own-other × gone` と `own-other-g × pid gone × G gone`
- **needs-head は 1 行だけ**: `sh-release-held × own-other-g × pid gone × G gone`（UAT の T1 の G が空になった後）。`run_lock_release` が中で D5 を呼び、最終の結果は D5 の同じ行（`rel`）。実装の試験は中の結果（stderr の `needs-head`）と最終の結果（`<lock>` が無い）の両方を見る（Claude 5 P3）
- **自分の退避の片付け**（⁸）: D5 は `missing` のとき `lock_release_own_gone` を呼ぶ（F11）。これは G だけを見るので、`pgid=` の無い `aside-own` は pid を見ずに消す（F15）。退避は先頭が gone と判定した記録しか作らない（I-6 の下では引渡しは生きた T0 からだけなので、判定と `mv` の間に記録が替わることもない）ので、pid の今の観測は再利用の観測で、判定に使わない。`aside-own-g` は G が gone のときだけ消す（G unknown は残す。I-2）
- **`own-self-g` の D12**: G が空（ESRCH）のときだけ消し、G が生きている・不明なら `def→`（daily の EXIT は G を空にしてから呼ぶ。§4.2）
- **TS は needs-head を出さない**: pid≠`process.pid` の取得を拒むので、`ts-release` の `own-other` は拒否。1 回目の「TS の包みは needs-head なら中で `releaseAsHead`」は呼び手が無いので**足さない**（§4.1。呼び手の無い API は足さない）

### 2.3 表 B: D9 の引渡しの段 × 流れ × 事象（24 行、review-4288h P2-2）

段は `forked`→`group`→`tmp`→`published`→`signalled`→`acked`。事象は「親（`up`・`daily.sh`）だけを `kill -9`」と「G の長だけが終わり、他のメンバーが残る」。UAT と daily は**別々に書いたオブジェクト**で同じセル（試験で比べる）。違うのは T1 の記録の pid（UAT はサーバー＝G の長、daily は `daily.sh`）。

| 段 | 親だけ `kill -9` | 長だけ終わり、メンバーが残る |
|---|---|---|
| `forked`・`group`・`tmp` | 記録 **T0**。子は始まらない（親の死で取り下げ）。別の取得者は取れる（T0 は正当に回収される） | 到達しない（`ack` の前の G は待っている長 1 人だけ） |
| `published` | 記録 **T1**。子は始まらない。G に待ちの子が居る間は断られ、子が取り下げて G が空になったら取れる | 到達しない |
| `signalled` | 記録 T1。子は始まる。G が生きている間は断られ、空になったら取れる | 到達しない |
| `acked` | 同上 | 記録 T1。長が死んでも G のメンバーが居る間は断られる（UAT: pid は ESRCH で G が生きている＝pgid の判定を試す行）。G が空になったら取れる |

親が**生きたまま**段が失敗する場合は表 D（1 回目に無かった。PM Claude P2-3・Claude 5 P3）。

### 2.4 表 C: UAT `down` — 記録 × 長 × G の残り（120 行、review-4288h P2-3・PM P1-1）

`down` は**信号を送る前に** owner を 1 回読み、状態ファイル（`run_id`＝T0・`server_pid`＝G・`lock_token`＝T1）と突き合わせて記録の軸を決める（Claude 5 P2-3・PM Claude P2-1・P2-2）。

| 記録 | 判定 |
|---|---|
| `t1` | 記録の token が `lock_token`（無ければ `<run_id>-g<server_pid>`）で `pgid=server_pid` |
| `t0-up-alive` | token が `run_id`、pid が `server_pid` でない（＝`up` の `$$`）、`kill -0` が alive |
| `t0-up-dead` | 同じで pid が ESRCH（`up` が公開の前に死んだ） |
| `old` | 状態に `lock_token` が無く、記録に `pgid=` が無く、pid が `server_pid`（旧い `up`。PM 共通の決定 2: 今の pid だけの停止） |
| `other` | token がこの run のどれでもない（我々の記録が回収され、別の run が取った） |
| `absent` | `<lock>` が無い |

長（`server_pid`）: `alive-verified`（`kill -0` が alive・ゾンビでない・`CM_DB_PATH` が run dir の下・port の LISTEN が長だけ・`ps -o pgid=` が G。`old` は pgid を条件にしない）、`alive-unverified`（どれかが通らない・確かめられない。再利用された pid の EPERM を含む）、`zombie`（`kill -0` は alive だが `ps -o stat=` が `Z`）、`dead`（ESRCH）、`unrecorded`（`server_pid` が無い）。G の残り: `none`（ESRCH。`old` では「観測しない」）・`verified`（全員の `CM_DB_PATH` が run dir の下）・`unverified`（1 人でも違う・読めない・ゾンビ）・`unknown`（`kill -0 -G`・`ps` が言えない）。

**手続き**（新しい形 `t1`・`t0-up-dead`・`other`・`absent` に共通。試験の `newForm`）:

| 長 ＼ G の残り | `none` | `verified` | `unverified` | `unknown` |
|---|---|---|---|---|
| `alive-verified` | 長に TERM → `wait`／ESRCH を待つ → D5 | 長に TERM → G を一覧し直して全員を確かめ TERM・猶予・KILL（`lock_drain_group` の順）→ D5 | 同左（長を確かめた時点の G は run のもの、I-10 (1)） | **長にだけ** TERM → G を空と示せない → D5 を呼ばない・`stop-refused-group`・1 |
| `alive-unverified` | 何も送らない・D5 を呼ばない・`stop-refused`・1（今のまま） | 同左 | 同左 | 同左 |
| `zombie` | 何も送らない・`stop-refused`・1、文面に「pid N はゾンビ（親 P が回収していない）」 | 同左 | 同左 | 同左 |
| `dead` | 何も送らない → D5 | G だけを空に（I-10 (2)）→ D5 | 何も送らない・`stop-refused-group`・1（残った pid を文面に） | 同左 |

**C′ — D5 の結果 → 状態**（PM 共通の決定 3: `stopped`・0 は `released` か `missing` のときだけ。6 行）:

| D5 | 状態 | exit | 文面 |
|---|---|---|---|
| `released`・`missing` | `stopped` | 0 | 停止完了 |
| `deferred` | `stop-refused-lock` | 1 | 保有者（pid・pgid）がまだ生きている／不明 |
| `kept` | `stop-refused-lock` | 1 | ロックは別の run（token）が持っている。この run のサーバーは止まっている |
| `not-head` | `stop-refused-lock` | 1 | 10 秒で札の先頭になれなかった。もう一度 `down` |
| `unknown` | `stop-refused-lock` | 1 | owner が読めない（point・errno） |

**記録ごとの行**（到達 52・到達しない 68）:

| 記録 | 到達する行 | 到達しない行（理由） |
|---|---|---|
| `t1` | 長 4（`unrecorded` 以外）× 残り 4＝16: 手続きの表のとおりで、D5 は `released` | `unrecorded` ×4（T1 は `server_pid` を書いた後にだけ公開される、I-6） |
| `t0-up-alive` | 長 5 × `none`＝5: **何も送らず D5 を呼ばない**・`stop-refused-lock`・1、文面「`up`（pid N）がまだ動いている。終わるのを待つか止めてから `down`」 | 残り `verified`・`unverified`・`unknown` ×5（公開の前の G は待つ子 1 人。`unrecorded` は G を名指せない） |
| `t0-up-dead` | 長 5 × `none`＝5: `alive-verified`（待っている子）は TERM → D5 `released`、`dead`・`unrecorded` は D5 `released`、`alive-unverified`・`zombie` は `stop-refused` | 残り `verified` 以下 ×5 |
| `old` | `alive-verified`→長に TERM（今の `stop_recorded`）→ D5 `released`、`dead`→ D5 `released`、`alive-unverified`・`zombie`→`stop-refused`。4 行 | 残り ×4（旧い形は G を観測しない）、`unrecorded` ×4（旧い形の記録の pid は `server_pid`） |
| `other` | 長 5 × `none`＝5: 手続きのとおりで、D5 は `kept` → `stop-refused-lock`・1 | 残り ×5（記録が替わるのは先頭が我々の記録を gone と判定した後だけ。T1 なら G はそのとき空、T0 なら G は待つ子 1 人） |
| `absent` | 長 4 × 残り 4 ＋ `unrecorded × none`＝17: 手続きのとおりで、D5 は `missing` → `stopped`・0（2 度目の `down` もここ） | `unrecorded` × 残り 3（G を名指せない） |

**PM 個別の決定（P1-1）の行**: `run-server.sh down <run>` が生きた G の自分の T1 を確実に片付けるのは、`t1 × alive-verified × none／verified` と `t1 × dead × none／verified`（試験で `released`・`stopped` を固定）。`up` が断るときの文面はこの `down` を名指す（§4.6）。

**`up` の失敗の trap**（1 回目は 1 文だけだった。PM Claude P2-1）: `go` の前は表 D の行。`go` の後は `down` と**同じ手続き**（記録 `t1`）を呼び、サーバーは `up` の子なので送った後に `wait` する（ゾンビで残さない）。状態は `stopped`→`failed`、それ以外→`failed-server-left`（今の値のまま）。今の `stop_recorded`（2 値の `run_lock_pid_alive`）で「長だけ死に G が残る」を `failed` と書く穴は、この手続きで閉じる。

`stop-refused-group`・`stop-refused-lock` の後の扱い: ロックは保護中のまま（I-9）。G が空になった後（人が止めた後）に `down` をもう一度呼ぶか、次の取得者の先頭が回収する。`cleanup` は G が生きている間は取得を断るので、生きた子を止めない。

### 2.5 表 D: 親が生きたまま引渡しの段が失敗する（20 行、PM Claude P2-3）

型（PM 共通の決定 3）: 流れ × 失敗 → 記録・信号・子・解放の経路・後のロック・状態・exit・文面。

| 失敗 | UAT（`up`） | daily |
|---|---|---|
| `state-write`（`state_set server_pid` の失敗） | 記録 T0。待っている子の **pid だけ**に KILL して `wait`。子は始まらない。D12 `released`。状態 `failed`、exit 1、`state-write-failed` | 到達しない（daily は状態ファイルを書かない） |
| `group`・`tmp`・`mv` | 記録 T0。pid だけに KILL・`wait`。子は始まらない。D12 `released`。`failed`、1、`handoff-failed stage=<段>` | 記録 T0。同じ。D12 `released`。sync の失敗、exit 2、同じ文面 |
| `verify`（読み直しが T1 でない） | 記録 T1。長が生きていて `ps -o pgid=` が G のときだけ `-G` に KILL・`wait`。子は始まらない。D12 needs-head → D5 `released`。`failed`、1 | 記録 T1。同じ確かめで `-G` に KILL・`wait`。D12 `released`（G が空の後）。exit 2 |
| `verify-unreadable`（読み直せない） | 記録不明。`-G` に KILL・`wait`。D12 `deferred`、**ロックは残る**。状態 `failed-lock-left`（新しい値）、1 | 同じで D12 `deferred`、ロックは残る。exit 2 |
| `signal`（`mkdir go` の失敗で `go` が無い） | 記録 T1。`-G` に KILL・`wait`。子は始まらない。D12 needs-head → D5 `released`。`failed`、1 | 記録 T1。同じ。D12 `released`。exit 2 |
| `abort`（`go` が既にある＝子が期限で取り下げた） | 記録 T1。送らない（子は自分で終わる）・`wait`。D12 needs-head → D5 `released`。`failed`、1 | 同じ。D12 `released`。exit 2 |
| `ack`（子の `mkdir ack` の失敗） | 子は exec せず終わる。`go` の後なので trap は `down` と同じ手続き（表 C `t1 × dead × none`）→ D5 `released`。`failed`、1、`server-exited` | 子が終わる → EXIT が G を空にして D12 `released`。exit 2、`handoff-failed stage=ack` |
| `child-exits`（exec の後すぐ終わる） | 同上（今の「the server exited at once」`run-server.sh:479`） | `run.ts` の終了。EXIT が G を空にして D12 `released`。exit は子の exit |

試験が固定する規則: 公開の前（`state-write`・`group`・`tmp`・`mv`）は記録が T0 で、送るのは pid だけ（PM Claude P3-6）。`-G` に送るのは公開の後だけ。`go` の前の失敗では子は始まらない（I-7）。ロックが残るのは owner が読めないときだけで、状態にそう書く。UAT の T1 は needs-head → D5、daily の T1 は G が空になってから D12。

### 2.6 表 D2: ゾンビ・host の変化・EPERM・空にならない G（20 行、PM 共通の決定 3）

どれも**消さない側**に倒れ、文面で人に知らせる。唯一消すのは daily 自身の記録（D12 の自己の経路は `host=` を読まない）。

| 事象 ＼ 呼び手 | 取得 | daily の EXIT | UAT の trap | `down` |
|---|---|---|---|---|
| `zombie`（記録の pid・G のメンバーがゾンビ） | 断る（`held` に「ゾンビ: 親 P が回収していない」） | 到達しない（EXIT は長を `wait` する `lock_stop_gate` で G を空にする） | 到達しない（trap は送った後に `wait`） | `stop-refused`、文面にゾンビ |
| `host-changed`（記録の `host=` が今の hostname でない） | 断る（「host H で記録された。H がこの機械なら人が `<lock>` を消す」） | `released`（自分の記録） | `deferred`、ロックは残る（D5 の保有者の判定は別の host を alive と読む） | `stop-refused-lock`（holder-alive、host を文面に） |
| `eperm-pid` | 断る（`unknown`、errno=EPERM） | 到達しない（自分の `$$`） | `deferred` | `stop-refused`（長を確かめられない） |
| `eperm-group` | 断る（`unknown`、point=group） | `deferred` | `deferred` | `stop-refused-group` |
| `group-not-emptied`（KILL の後も G が空でない） | 到達しない（取得は送らない） | `deferred`（残った pid を文面に） | `deferred` | `stop-refused-group`（残った pid） |

### 2.7 表 E: 引数・文脈の検査（20 行）

§4.2。表 A の「拒否」の行が指す検査で、試験は「指す検査がその実装で到達の行であること」を全行で確かめる。

### 2.8 行数

| 表 | 列挙 | 行 | 到達 | 拒否 | 到達しない |
|---|---|---|---|---|---|
| A | 呼び手 10 ×（pid だけの形 12 × 3 ＋ `-g` の形 6 × 9） | 900 | 578 | 90 | 232 |
| B | 段 6 × 流れ 2 × 事象 2 | 24 | 14 | 0 | 10 |
| C | 記録 6 × 長 5 × 残り 4 | 120 | 52 | 0 | 68 |
| C′ | D5 の結果 6 | 6 | 6 | 0 | 0 |
| D | 流れ 2 × 失敗 10 | 20 | 19 | 0 | 1 |
| D2 | 事象 5 × 呼び手 4 | 20 | 16 | 0 | 4 |
| E | 検査 10 × 実装 2 | 20 | 12 | 0 | 8 |
| 計 | — | **1110** | **697** | **90** | **323** |

表 A の呼び手ごとの到達: `ts-acquire` 45・`ts-inherit` 51・`ts-release` 46・`ts-release-inherited` 81・`sh-acquire` 45・`sh-inherit` 51・`sh-release-held` 65・`sh-release-unheld` 81・`sh-hand-off` 46・`sh-release-as-head` 67。

試験のファイルはこの数を固定する。陽性の対照（この段で実行して確かめた）: (1) 表 A の D5 の `aside-foreign-g` を消すと `tsc` が型の誤り（`satisfies CallerTable`）。(2) D5 の `own-other-g × pid gone × G unknown` を `released(removed)` にすると I-1・I-2 の検査が赤。(3) C′ の `deferred` を `stopped`・0 にすると C′ の検査が赤。

---

## 3. (c) 外部の呼び出しごとの失敗の倒れ方

「消す側」＝ロック（canonical・退避）を消す・取る・信号を送る方向、「消さない側」＝残す・断る・送らない方向。1 回目の表から変えた行と足した行だけ太字にした。行ごとの期待は表 A・C・D・D2 のセル。

| 呼び出し | 場所 | 失敗 | 倒れる側 | 理由・PR1b の扱い |
|---|---|---|---|---|
| `kill -0 <pid>`・`kill -0 -<G>`（bash） | `lock_obs_kill0` `verify-run.sh:848-857` | ESRCH 以外（EPERM・文面が読めない） | 消さない | unknown。表 D2 `eperm-*` |
| `process.kill(pid, 0)`（TS） | sync `:153-161`、`hooks.kill`（D10） | ESRCH 以外 | 消さない | 同上 |
| 旧い `run_lock_pid_alive` | `run-lock.sh:50-56` | EPERM を生・`ps` の失敗を死 | 消す側にもなる（2 値） | **ロックの判定に使わない**。2 値のまま残す（§4.3 の契約）。`down`・`up` の trap の判定は表 C の手続き（`kill -0` の ESRCH と `ps -o stat=`）で、この関数の「死」で決めない |
| **ゾンビ** | `kill -0` は alive を返す | — | 消さない | 長・メンバーがゾンビなら G は空にならない。daily の EXIT は長を `wait` する `lock_stop_gate`、`up` の trap は送った後に `wait`。`down` は `ps -o stat=` で見分けて文面に出す（表 D2） |
| **`hostname` の変化** | `LOCK_HOST`（`verify-run.sh:612`）と `lock_holder_state` `:1107` | 記録の `host=` が今と違う | 消さない | 保有者は alive と読まれ、誰も回収しない。文面で知らせる（表 D2）。D12 の自己の経路は host を読まないので daily は自分で消せる |
| `ps -o pgid= -p` | `lock_obs_pgid` `:1055-1060` | 失敗・空・数でない | 消さない | `stage=group`。子は始めない。`down` は `alive-verified` にしない |
| `ps eww -o command=`（`CM_DB_PATH`） | `env_value_of` `run-server.sh:97-99` | 失敗・空（ゾンビも空） | 消さない | `alive-unverified`／`unverified` → 送らない |
| `ps -o etime=` | `lock_pid_start_ms` `:1129-`、sync `:89` | 失敗 | 消さない | 札を外さない |
| **`lsof`（LISTEN の確かめ）** | `find_listen_pids_by_port` `port-pids.sh:33-42` | 無い・失敗 | **送る側**（1 回目は「消さない側」と書いていた。PM Claude P3-7） | 空の一覧は「誰も listen していない」と読まれ、port の条件を素通りする。長への信号は `CM_DB_PATH` と `ps -o pgid=` の条件で守られる（どちらも通らなければ送らない）。今の `stop_recorded:127` と同じ（PR1b で変えない） |
| `mv`（回収の退かし・戻し・引渡しの公開） | `lock_obs_mv`・`lock_recover`・`lock_hand_off` | 各失敗 | 消さない | 1 回目のとおり。引渡しの公開の失敗は表 D `mv` |
| `printf > tmp`（引渡しの tmp） | `lock_hand_off` | 失敗 | 消さない | 表 D `tmp` |
| **owner の読み直し（引渡し）** | `lock_hand_off` の verify | 違う記録・読めない | 消さない | 表 D `verify`・`verify-unreadable`（読めなければロックを残し、状態にそう書く） |
| **合図の `mkdir go`** | `lock_obs_mkdir handoff-signal` | `exists`／それ以外 | 消さない | `abort`（子が取り下げた）／`signal`（作れない）。どちらも子は始まらない（表 D） |
| **子の `mkdir ack`** | `lock_child_wait` | 失敗 | 消さない | 子は exec しない（表 D `ack`） |
| **状態ファイルの書き込み** | `state_set` `run-server.sh` | 失敗 | 消さない | 引き渡さずに exit 1（表 D `state-write`、I-6） |
| owner の排他作成 | `lock_obs_create`・sync `claim` | 書き込みの途中の SIGKILL | **消さない側（取れなくなる）** | 空の owner＝`corrupt` が残り、誰も回収しない。**PR1a-f で tmp→mv に戻して塞ぐ**（PM 共通の決定 1）。それまでは `corrupt` の文面で人に知らせる（§4.6） |
| `mkdir <lock>`・`rmdir`（D3） | `lock_obs_mkdir`・`lock_expire_ownerless` | EEXIST 以外／空でない | 消さない | `ownerless-nonempty` は D3 が効かず断り続ける。**PR1a-f で塞ぐ**。それまでは中身の一覧を文面に出す |
| `rm -rf <lock>` | `machine-lock.sh:241`、`verify-run.sh:1986` | 部分失敗 | 消す側に寄る（他者のロックは消さない） | 1 回目のとおり。空でない残りは `ownerless-nonempty`（上の行） |
| `fs.rmSync(lockPath)`（TS） | sync `:930` | EACCES・EIO | 消さない（例外） | TS の包みが捕まえる |
| 札の `ln`・退避の一覧・owner の読み | 1 回目のとおり | — | 消さない | — |
| `tmux` | `run-server.sh:148-160` | 失敗 | 関係しない | keepalive は G の外（土台 §1.8 の保証の外） |
| 時計 | `lock_now_ms` | `%3N` が無い | 消さない側に寄る | 1 回目のとおり。lstart の TZ は supervisor.lock（PR1c）の話で、PR1a-f で塞ぐ |
| 子の起動（`set -m` の背景ジョブ） | §4.5 | G が親と同じ | 消さない | `stage=group` → pid だけに KILL（表 D） |

---

## 4. (d) PR の切り方

### 4.1 PR1b は 1 本

| 中身 | ファイル |
|---|---|
| TS の包み（D8・D10・D11、F6 の例外の捕まえ、I-8、pid≠`process.pid` の拒否） | `src/lib/agent-health/run-lock.ts` |
| bash の包み（D1 の kv・D2・D3・D8・D12 の包み〔needs-head なら中で D5〕・D5 の包み・I-6 の `run_lock_set_pid`・表 E の検査・§4.3 の読み込み・§4.6 の文面） | `scripts/uat/run-lock.sh` |
| UAT の呼び手（§4.5 の起動、`server_pid` の書き込みの確かめ、`lock_token`、表 C の `down`、表 D の trap、`CM_RUN_LOCK_TOKEN` を消す） | `scripts/uat/run-server.sh` |
| daily の呼び手（§4.5 の子、取得の後の `export`、EXIT・INT／TERM の `lock_stop_gate`、D12） | `scripts/agent-health/daily.sh` |
| 試験（この雛形を実装に当てる・台・凍結した旧版） | `tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts` ほか |
| **既存の試験**（§4.4） | `tests/unit/scripts/uat/run-server-3359.test.ts`（期待の変更 2 か所）・`tests/unit/scripts/agent-health/daily-sh.test.ts`・`metrics-sh.test.ts`（台） |
| コメントの 1 語 | `src/lib/agent-health/claude3-reservation.ts:12`（土台 §1.12） |
| UAT を起こす worktree に develop を取り込む手順の 1 行 | `docs/orchestrate/` の該当文書（PM の決定 rev2 の追記 (3)） |

**API は呼び手と同じ PR**。呼び手の無い API は足さない（1 回目にあった「TS の `release()` の needs-head → `releaseAsHead`」は呼び手が無くなったので外した。§2.2）。**TS と bash を分けない理由**は 1 回目のとおり（片方だけ新しくすると develop の上に新旧混在を作る）。PR1b に**入れない**もの: PR1a の部品（`machine-lock.sh`・`verify-run.sh`・`machine-lock-sync.mjs`）の変更、supervisor.lock（PR1c）、owner の原子性・`owner.tmp` だけ・TZ（PR1a-f）、`run_lock_pid_alive` の 3 値化。

### 4.2 呼び手の無い組み合わせは引数・文脈で拒否する（表 E）

| 検査 | TS | bash | 理由 |
|---|---|---|---|
| `token-chars`（token が `[A-Za-z0-9-]+` でない） | `{ ok: false }` | `RUN_LOCK_ERROR`・1 | I-8・F4 |
| `field-newline`（`label`・`run_dir` に改行） | `{ ok: false }` | `RUN_LOCK_ERROR`・1 | I-8・F10 |
| `ts-pid-not-self`（`pid ≠ process.pid`） | `{ ok: false }` | 到達しない（bash は pid≠`$$` の取得を受ける、F9） | PM Claude P3-3 |
| `sh-release-after-foreign-pid`（pid≠`$$` で取ったシェルの `run_lock_release`） | 到達しない | `RUN_LOCK_ERROR`・1。記録は pid の死の後に次の先頭が回収 | Claude 5 P2-1。本番の呼び手は無い（`daily.sh:92`・`run-server.sh:412`・`:567` は `$$`） |
| `handoff-pid-not-self`（記録の pid が `$$` でない） | 到達しない（TS は handOff を出さない） | `stage=arg`・1。何も書かず `LOCK_PENDING_TOKEN` も立てない | I-6 |
| `handoff-pgid-self`（pgid＝`$$`、または pgid＝このシェルの pgid） | 同 | `stage=arg`・1 | I-5（PM Claude P2-5）。`set -m` が効かず子が親のグループに居る場合も、`ps -o pgid= -p <子>` の後にここで止まる |
| `handoff-twice`（引渡しの後の 2 度目） | 同 | `stage=arg`・1 | Claude 5 P2-1（2 度目の引渡しの呼び手は無い） |
| `handoff-subshell`・`release-subshell` | 到達しない（Node にサブシェルは無い） | `stage=arg`・1／`RUN_LOCK_ERROR`・1。D12 を呼ばない | I-4 |
| `machine-lock-unloaded`（§4.3） | 到達しない（静的 import） | `source` は 0 で返り、関数を呼ぶと `RUN_LOCK_ERROR "machine-lock not loaded: …"`・1 | PM 共通の決定 4 |

ほかに呼び手の側で守ること（表の「到達しない」の理由になっているもの）:

- **D5 の包み**は `down` と、`run_lock_release` が needs-head を受けた後からだけ呼ぶ。`daily.sh` は D12 だけ（記録の pid は自分）
- **bash の継承は `LOCK_HELD_*` を立てない**（継いだシェルの `run_lock_release` は `none`。PM Claude P3-5）。TS の継いだ handle の `release()` は何もしない（今のまま）
- **`up`・`cleanup` は冒頭で `CM_RUN_LOCK_TOKEN` を消す**（run の子ではない。環境に残った token で daily の記録を「継いで」から引渡しで止まる経路を消す。Claude 5 P3）。**`daily.sh` は取得の後に `export CM_RUN_LOCK_TOKEN=<T0>`** し、自分の取得を継承の経路に通さない（F17）。引渡しの後は子に `<T0>-g<G>`（T1）を渡す
- **daily の EXIT**: `lock_stop_gate "$G" "$leader"`（長を `wait` してから G を TERM・猶予・KILL）→ G が空になってから `run_lock_release` を 1 回（F16: D12 は最初に `LOCK_HELD_PATH` を消すので、空にする前に呼ばない）。INT／TERM は `exit 130／143` で EXIT に落とす（Claude 5 P2-5: 待っていない長に `lock_drain_group` を使うと長がゾンビで残り、D12 が `deferred` になる）

### 4.3 PR1b と PR1c の契約（PM 共通の決定 4。PR1c の設計にも同じ文を置く）

> **PR1b と PR1c の契約**: PR1b の `scripts/uat/run-lock.sh` は、`scripts/lib/machine-lock.sh` の読み込みに失敗しても `run_lock_*` の関数をすべて定義し、`source` は成功（0）で返す（失敗は関数を呼んだときに `RUN_LOCK_ERROR` と 1 で出す）。`run_lock_pid_alive` は 2 値（生きている／いない）のまま変えない。`scripts/agent-health/product/lib.sh` は `scripts/lib/machine-lock.sh` を自分で `source` し、その戻り値を自分で持つ（`run-lock.sh` 経由の読み込みの成否に頼らない）。

あわせて（PM Claude P3-11、PR1c の S10）: `run-lock.sh` は `source` の時点で大域の状態を変えない（`lock_note_recovered` の上書きなど run-lock の文面の差し替えは、`run_lock_*` を呼ぶたびにそのロックのパスに限って行う）。`lib.sh` 経由で supervisor のシェルに読み込まれても、supervisor.lock の回収の文面は変わらない。`machine-lock.sh` の読み込みは 1 回だけ（`machine-lock.sh:49-51`）なので、`run-lock.sh` が先でも `lib.sh` が先でも同じ。

### 4.4 既存の試験への影響（PM 個別の決定・PM Claude P1-1）

**意図した変更**（消す側 → 消さない側の狭め。弱めではない。試験のコメントに本書のこの節を書く）:

| 試験 | 今の期待 | 新しい期待 | 根拠の行 |
|---|---|---|---|
| `run-server-3359.test.ts:357-378`「the next up cleans what a killed run left…」 | owner の `pid=` を死んだ pid に書き換え、サーバーは生かしたまま、2 回目の `up` が status 0・前のサーバーを止める・状態 `cleaned` | 2 回目の `up` は **status 1** で断り、文面に `another run holds <dir> (` と **`run-server.sh down --run-dir <1 回目の run dir>`**（§4.6）。その `down` が status 0・前のサーバーが止まる・socket dir が消える・状態 `stopped`。続く 3 回目の `up` が status 0（名前の「次の up が片付ける」は「`down` の後の次の up」として残る） | 記録は T1（`pgid=G`）。pid を死んだ pid にしても G（サーバー）が生きているので保有中（表 A `sh-acquire × foreign-g × pid gone × G alive` → ✕held-group）。`down` は表 C `t1 × alive-verified × none` → D5 `released`・`stopped` |
| `run-server-3359.test.ts:430-437`「…and release touches only its own token」の最後の 2 行 | 新しいシェルの `run_lock_release parent` で `<lock>` が消える | 新しいシェルの `run_lock_release parent` は**何もしない**（`<lock>` は残る）。持ち主の記録を消すのは持ち主のシェルの D12 と、保有者が死んだ後の D5（同じ試験の中で、owner の pid を死んだ pid にしてから `run_lock_release_as_head parent` が消すことを示す） | 表 A `sh-release-unheld × own-other × alive` → `none`（F16）。D5 は `own-other × gone` → `rel` |

**台の変更**（期待は変えない）: `daily-sh.test.ts:95`・`metrics-sh.test.ts:42` の種のリポジトリに `scripts/lib/machine-lock.sh` と `.claude/skills/cmate-verify/scripts/verify-run.sh` を写して追跡させる（写さないと読み込みが失敗し、§4.3 の契約で `run_lock_acquire` が 1 → `reason=run-locked:` の期待が `machine-lock not loaded` に変わる）。

**形を変えない**: `uat-yaml-2590.test.ts` の `env -i ` で始まる論理行・代入の位置（F18）は §4.5 の形で保つ。試験は変えない。

**期待が変わらないことを確かめたもの**（読みで。実行は実装の契約）: `run-lock-3359.test.ts` 全体（TS は `pid: process.pid` だけ、bash の pid≠`$$` の取得は exit 0 のまま・解放しない）、`run-server-3359.test.ts` の他の `it`（`down` が他の owner を止めない・`CM_DB_PATH` が違えば断る・状態ファイル無しで断る・`up` の途中の失敗が自分のものだけ消す〔表 D `child-exits` → D5 `released`・`failed`〕・生きた run が持つ間 `up` が断る・8 者の競争で 1 者・7 件が `another run holds`）。

### 4.5 子の起動の形（PM Claude P3-13・PM 個別の決定）

UAT（`env -i ` で始まる論理行・代入は `env -i` と最初の `nohup` の間、を保つ）:

```bash
set -m
env -i HOME="$HOME" PATH="$PATH" … CM_OPENCODE_PORT_FILE="$RUN_DIR/opencode-ports.json" \
    nohup /bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; shift 6; exec "$@"' \
    cm-uat-child "$MACHINE_LOCK_SH" "$go" "$ack" "$deadline" "$$" -- node "$SERVER_ENTRY" >"$RUN_DIR/server.log" 2>&1 </dev/null &
server_pid=$!
set +m
state_set "$UP_STATE" server_pid "$server_pid" || { kill -KILL "$server_pid"; wait "$server_pid"; exit 1; }
run_lock_set_pid "$run_id" "$server_pid" "$server_pid" || exit 1   # T0 → T1（pid＝pgid＝サーバー）、通れば go
```

`env` → `nohup` → `bash` → `node` は同じ pid のまま exec するので、`server_pid`＝G の長＝記録の pid。`MACHINE_LOCK_SH` は絶対パスで渡す（`env -i` の後に環境から引かない）。

daily（`npx tsx run.ts` の行を置き換える。pull と `npm install` の後）:

```bash
set -m
/bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; shift 6; exec "$@"' \
    cm-daily-child "$PWD/scripts/lib/machine-lock.sh" "$go" "$ack" "$deadline" "$$" -- npx tsx scripts/agent-health/run.ts … &
child=$!
set +m
run_lock_set_pid "$T0" "$$" "$child" || fail_sync "handoff-failed stage=$RUN_LOCK_STAGE"   # T1（pid＝daily、pgid＝子）
wait "$child"; code=$?
```

子は pull の**後**の `machine-lock.sh` を読み、親は pull の**前**に読んだ版を使う。`go`・`ack`・期限・親の pid の約束は PR1a で決めた名前と意味で、版を跨いでも同じ（変えるときは版の跨ぎを設計する）。子の exit 75 は「取り下げた」で、daily は `handoff-failed stage=abort|ack` として扱う（表 D）。

### 4.6 文面

- **断る文面の頭は今と同じ `another run holds <dir> (`**（`run-server-3359.test.ts:410` が 8 者の競争で 7 件を数え、`daily-sh.test.ts:249` が `reason=run-locked:` を見る）。括弧の中は表 A の文面の種類で変わる: `held`→`pid N, label L, since T[, run_dir]`、`held-group`→`pid N gone, pgid G alive, label L …`、`ticket`→`ticket of pid N ahead`、`unknown`→`cannot tell: point=… path=… errno=…`、`corrupt`→`<lock>/owner has no pid= or token=: check and remove <lock> by hand`、`ownerless-young`→`no owner yet`、`ownerless-nonempty`→`no owner and not empty: <中身>: check and remove <lock> by hand`、`aside`→`a moved-aside record <name> is alive`（PM Claude P3-10）
- **UAT の `up` が断るとき**、記録に `run_dir=` があれば末尾に `; stop it with: scripts/uat/run-server.sh down --run-dir <run_dir>` を足す（PM 個別の決定）。`down` がそれを確実に片付ける行は表 C の `t1` の行
- `corrupt`・`ownerless-nonempty` は PR1a-f で塞ぐまで消さず、上の文面で人に知らせる（PM 共通の決定 1）
- ゾンビ・host の変化・EPERM は表 D2 の文面

### 4.7 断片（PM 共通の決定 5）

- module-reference は PR ごとの名前: `dev-reports/module-reference/issue-4288-pr1b.md`（PR1c は `-pr1c.md`）
- `changelog.d/4288.md` は同じ Issue の 2 本目以降の work item の規則（`scripts/orchestrate/templates/fragment-rules.md` の `second-work-item`）: 既存の 1 項目へ統合し、1 本目の文を消さない。PR1b と PR1c のマージは直列

### 4.8 実装の契約への引継ぎ

- 表は閉じている（§2.8。行の追加は列挙の追加で、型が落ちる）。PM の決定（上流の 2 回目で表が閉じたら実装は sonnet、閉じなければ opus）の判断材料
- 実装の試験は `it.todo`（表 A の呼び手ごと 10 本と I-11 の 1 本・表 B の流れごと 2 本・表 C の 2 本・表 D の流れごと 2 本・表 D2 の 1 本・表 E の 1 本）を `it.each` に置き換える。行の期待は変えない（変えるときは上流に戻す）。pid と G は別々に作る（生きた pid／ESRCH の pid に生きた G のメンバー、など。PM Claude P2-4）
- 表 B・C・D は実プロセスの試験で、#4288 の 1 番の台（`lock-4288-harness.ts`）と止め所（`CM_VERIFY_TEST_HANDOFF=pause:<stage>`）を流用できる
- **混在の試験**（Claude 5 P3、土台 §1.9・§1.10）: 凍結した旧版の `run-lock.sh` の `up` と新しい `down`（表 C の `old` の行）、旧版の取得者と新しい取得者の 3 者の割込み
- 陽性の対照: 凍結した旧版で §1.2 の 3 者の割込みが 2 者を通す・今の `run-server.sh:470-473` で `set_pid` の前に `up` を `kill -9` するとサーバーが動いたまま取れる・今の `stop_recorded` で長だけが死ぬと `down` が `stopped` を書く

---

## 5. review-4288h（codex-2 の最後の再確認）の処置

| # | 指摘 | 処置 | 場所 |
|---|---|---|---|
| P2-1 | 読み込み口だけでは `KILL_GRACE_SEC` が初期化されない | **PR1a で閉じている**（F1） | 土台 §1.14 |
| P2-2 | D9 の `tmp` 段では待機中の G があっても回収できる | **採る**。公開の前と後で期待を分けた | 表 B、I-7 |
| P2-3 | UAT の長が死に G の子だけ残ったときの `down` が未完 | **採る**。表 C（上流の 2 回目で記録の軸・ゾンビ・C′ を足した） | 表 C、I-10 |
| P3 | pending の後・`mv` の前の失敗で D5 は T0 を消さない | **PR1a で閉じている**。PR1b の呼び手の流れは表 D | 表 A・表 D |

---

## 6. PM の決定（上流の 1 回目の §6 の 3 つ）

1. **`corrupt` を回収しない** → PM 共通の決定 1 で、owner の原子性（`corrupt` の主な出どころ）・`owner.tmp` だけの `<lock>`・TZ を **PR1a-f** で塞ぐ。PR1b はそれまで形を区別して文面で知らせ、消さない（表 A の `corrupt`・`ownerless-nonempty`、§4.6）
2. **daily の EXIT で G を空にする** → 採る。手本は長を `wait` する `lock_stop_gate`（1 回目の `run_gate_handoff` の指定は、待っていない長に使うと 7 秒後に失敗する。Claude 5 P2-5）
3. **`stop-refused-group` の後の手順** → 文面だけ（残った pid と `CM_DB_PATH`）。`up` の断る文面は `down --run-dir` を名指す（PM 個別の決定）。`docs/user-guide/` には足さない（推奨のまま。変えるなら PM）

---

## 7. 本文に無い指摘（直さない）

- `scripts/orchestrate/machine-lock-sync.mjs:680-690` の `cleanupOwnGone` は自分の token の退避を G を見ずに消す（F5）。PR1b では届かない
- `.claude/skills/cmate-verify/scripts/verify-run.sh:1434-1449` の `lock_release_own_gone` は退避の G だけを見て、`pgid=` の無い退避を pid を見ずに消す（F15）。run-lock では退避が gone と判定された記録からしかできないので消してよい形に限られるが、3 実装の規則として pid も見るかは PR1a-f の候補
- `scripts/lib/machine-lock.sh:241` の `rm -rf` と `verify-run.sh:1986` は削除の失敗を見ずに `released` と答える（F13）
- `scripts/lib/machine-lock.sh:168-169` の kv の codec は呼び手の欄を `pgid=` の前に書く（F10）
- `verify-run.sh:1680-1685` の `LOCK_HELD_BY` は JSON の読みで、kv の記録では空になる（F3）
- `scripts/uat/run-server.sh:472` は `state_set server_pid` の失敗を見ない（F12。PR1b で直す側だが、今の develop の穴として記録）

---

## 8. 上流のレビューの処置（上流の 2 回目）

| 指摘 | 処置 | 場所 |
|---|---|---|
| Claude 5 P2-1 呼び手の無い行が到達扱い | 3 種の行に分け、D5 × `own-self*` は到達しない、`own-other` の解放・引渡しと 2 度目の引渡しは拒否（表 E）。TS は pid≠`process.pid` を拒否。bash の pid≠`$$` の取得は既存の試験（F9）のため受け、解放と引渡しを拒否 | §2.2・§4.2 |
| Claude 5 P2-2 `aside-own` の pgid | `aside-own`／`aside-own-g` に分け、セルを PR1a の部品どおりに（F15） | §2.2 |
| Claude 5 P2-3 表 C に記録と `up` の生死の軸が無い | 記録 6 値の軸。`t0-up-alive` は送らず D5 を呼ばない。`stopped` は D5 が `released`・`missing` のときだけ（C′） | §2.4 |
| Claude 5 P2-4 `alive-verified × unknown` の食い違い | 長にだけ送る、に揃えた（試験で G の `unknown` に送らないことを固定） | §2.4・I-10 |
| Claude 5 P2-5 ゾンビ | 表 C の長の `zombie`、表 D2、daily の EXIT は `lock_stop_gate`、`up` の trap は `wait` | §2.4・§2.6・§4.2 |
| Claude 5 P3（9） | `none` を結果に（F16）／daily の取得が継承を通る（F17、§4.2）／I-1 の検査が観測を見る／needs-head の中と最終の結果（§2.2）／信号の後に G が空にならない（表 D2 `group-not-emptied`）／親が生きたままの失敗（表 D）／I-10 (1) の根拠を狭めた／`dead × unverified` が人を待つ（`stop-refused-group` の文面、§6-3。サーバーが環境を置き換えて起こした子が G に残るかは**未確認**のまま）／旧版の取得者の列（§4.8 の混在の試験） | 各節 |
| PM Claude P1-1 既存の試験の期待 | §4.4 の「意図した変更」2 本・台 2 本・形を変えない 1 本 | §4.4・§4.5 |
| PM Claude P2-1 表 C の D5 の軸・trap・`state_set` | C′・記録の軸・trap は同じ手続き・表 D `state-write` | §2.4・§2.5 |
| PM Claude P2-2 旧い `up` | 記録の `old`（pid だけの停止、G を観測しない） | §2.4 |
| PM Claude P2-3 引渡しの段の失敗 | 表 D | §2.5 |
| PM Claude P2-4 pgid の判定が空振り | pid と G を別の軸に（`-g` の形は 9 値）。実装の試験は pid と G を別々に作る | §2.1・§4.8 |
| PM Claude P2-5 I-5 の試験が空振り | 形 `own-self-selfg` を置き、bash は `handoff-pgid-self` で拒否 | §2.2・I-5 |
| PM Claude P3-1〜P3-13 | P3-1 別々のオブジェクト（I-11）／P3-2 I-2 に `aside-removed`（§1）／P3-3 TS の pid（表 E）／P3-4 `run_lock_release` が needs-head で D5（I-3）／P3-5 継承の `LOCK_HELD_*`・継いだ handle（§4.2、呼び手 `ts-release-inherited`・`sh-release-unheld`）／P3-6 `go` の前は pid だけ（表 D）／P3-7 `lsof` は送る側（§3）／P3-8 `corrupt`・空でない owner 無し（PR1a-f、§4.6）／P3-9 D5 × `own-self*` は到達しない／P3-10 文面の規則（§4.6）／P3-11 S10（§4.3）／P3-12 スケジューラのグループへの SIGKILL は**未確認**（`run.ts` が別のグループで残りうる。土台 §1.8 の保証の外として記録）／P3-13 子の起動の形（§4.5） | 各節 |

---

## 9. 確かめたこと・探した対

- 読んだもの（上流の 2 回目で読み直した）: `machine-lock.sh` の D12（`:190-257`）、`verify-run.sh` の `lock_group_state`・`lock_holder_state`・`lock_release_own_gone`・`lock_recover`・`lock_release_as_head`・`lock_child_wait`・ゲートの合図の分け方、`machine-lock-sync.mjs` の `release`、`run-server.sh` の `stop_recorded`・`up_on_exit`・`cmd_up` のサーバーの起動・`cmd_down`、`daily.sh` の取得から最後まで、`run-lock-3359.test.ts`・`run-server-3359.test.ts`・`daily-sh.test.ts`・`metrics-sh.test.ts`・`uat-yaml-2590.test.ts` の該当箇所、PR1c の設計（`commandmate-issue-4288-pr1c` の `f7fc6a837`）の読み込みの行
- 実行したもの: 試験の雛形（`npx vitest run` のこのファイルだけ。PM の今夜の負荷の決まりで広い vitest は走らせていない）、陽性の対照 3 つ（§2.8）、`npm run lint`・`npx tsc --noEmit`。サーバー・tmux・エージェント CLI・`~/.commandmate` には触っていない
- 探した対: `run_lock_*`・`acquireRunLock`・`CM_RUN_LOCK_*` の呼び手と、run-lock を固定する試験（`git grep`）は §4.4 の 5 本と `product/lib.sh`（PR1c）・`supervisor.sh:73` だけ。`docs/en` に run-lock の写しは無い。`src/cli/types/` にロックの型の写しは無い
- 未確認: `set -m` の下の `env -i … nohup … &` が macOS の bash 3.2 で子を新しいグループに置くこと（失敗しても表 D `group` で子は始まらない）、スケジューラ・launchd が daily を止めるときにグループへ送るか（PM Claude P3-12）、サーバーが環境を置き換えて起こした子が G に残るか（Claude 5 P3）
