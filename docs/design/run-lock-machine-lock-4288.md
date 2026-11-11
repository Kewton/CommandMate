# Issue #4288 PR1b: run-lock を machine-lock に載せる（上流の段: 設計の 4 つと試験の表）

- 状態: **上流の 4 回目**（設計と試験の表だけ。`src/`・`scripts/`・既存の試験は変えない）。4 回目は 3 回目（`743b83e39`）への PM Claude のレビュー `pm-review-4288-pr1b-upstream3-claude.md`（P2 1・P3 5）と PM の処分 `pm-return-4288-pr1b-upstream3.md` の直す 1・2 を、設計の文と表のセルで反映した（表 D の列挙に `token`・`abort-acked` の 2 値を足した。§8.3）。3 回目は 2 回目（`24a437a47`）への上流のレビュー（PM Claude `pm-review-4288-pr1b-upstream2-claude.md`・Claude 5 `prereview/review-4288-pr1b-upstream2.md`）と PM の処分 `pm-return-4288-pr1b-upstream2.md` の直す 1〜6 を、設計の文と表のセルだけで反映した（表の作りは変えない。§8.2）。2 回目は 1 回目（`ee92499cd`）への上流のレビュー（Claude 5 `prereview/review-4288-pr1b-upstream.md`・PM Claude `pm-review-4288-pr1b-upstream-claude.md`）と PM の処分（`pm-return-4288-upstream.md` の共通の決定 1〜5・PR1b の個別の決定）を反映した。**不変条件 I-1〜I-11 の文は変えていない**（全員一致で正しい）。直したのは表（型つきの列挙に組み直した）と、既存の試験との契約（§4.4）。実装は、この表が上流のレビューで P2 0 になった後の「赤から緑にする」契約で行う
- 対象: run-lock（`src/lib/agent-health/run-lock.ts`・`scripts/uat/run-lock.sh`・`scripts/uat/run-server.sh`・`scripts/agent-health/daily.sh`）を、PR1a（#4309、develop `b57c2aba6`）でマージ済みの machine-lock（`scripts/lib/machine-lock.sh`・`scripts/orchestrate/machine-lock-sync.mjs`・`.claude/skills/cmate-verify/scripts/verify-run.sh` のロックの節）に載せる部分だけ。supervisor.lock は PR1c（別の上流の段）。owner の書き込みの原子性・旧版の `owner.tmp.*` だけの `<lock>`・lstart の TZ は PR1a-f（PM 共通の決定 1）
- 土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) の §1（D1〜D12）・§1.8・§1.9・§1.11・§1.14（D12 の不変条件）・§7。本書はそれを**置き換えない**。D 番号・§1.14 の表はそのまま引く
- 行番号は develop `b57c2aba6` のもの。名前で引くこと
- 表記: **事実**＝コードを読んで（または実行して）確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 試験の表: [`tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts`](../../tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts)。**表の正は試験のファイルの型つきの列挙**で、本書 §2 の表はその読み下し。セルの足し忘れは `satisfies` で型の誤り、各行は §1 の不変条件の検査に当たる。実装を呼ぶ所は `it.todo`

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| (a) 不変条件 | 11 本（I-1〜I-11、文は 1 回目のまま）。消すのは 3 つの経路だけ・不明は空きと読まない・needs-head は D5・bash は main シェル・自己グループの例外は使わない・引渡しは自分の T0 から・子は合図の後だけ・token と欄の字・down は確かめた G だけに送る ほか | §1 |
| (b) 状態と遷移の表 | 行は 3 種: **到達**（本番の呼び手がある）・**拒否**（本番の呼び手が無く、包みの引数・文脈の検査が `<lock>` に触る前に断る。表 E を指す）・**到達しない**（起きない、理由つき）。表 A（記録の形 18 × 呼び手 10 × 観測〔pid と G を別の軸に〕= **900 行**）、表 B（D9 の段 = **24 行**）、表 C（UAT `down`: 記録 6 × 長 5 × G の残り 4 = 120 行 ＋ `t1` × D5 の結果 25 行 = **145 行**）と C′（D5 の結果 → 状態 **6 行**）、表 D（引渡しの段の失敗 × 流れ = **24 行**）、表 D2（ゾンビ・host の変化・EPERM・空にならない G × 呼び手 = **20 行**）、表 E（引数・文脈の検査 × 実装 = **20 行**）。**計 1139 行**（到達 738・拒否 90・到達しない 311） | §2 |
| (c) 失敗の倒れ方 | 1 回目の表に、合図の `mkdir go`・子の `mkdir ack`・状態ファイルの書き込み・ゾンビ・host の変化を足し、`lsof` の行を「送る側」に直した。消す側に倒れるのは 2 か所（rm の部分失敗・TS の `rmSync` の例外）のままで、どちらも他者のロックを消さない | §3 |
| (d) PR の切り方 | PR1b を 1 本。引数・文脈で拒否する検査 10 種（表 E）。PR1b と PR1c の契約（§4.3、PR1c の設計と同じ文にする）。子の起動と `go`・EXIT の形（§4.5、表 D の各行がどの行で起きるか。UAT の `go`／`ack` は run ごとの名前で、fork の前に消して無いことを確かめる）。既存の試験の**意図した変更** 2 本と台の変更 2 本、形を変えない 1 本（§4.4） | §4 |

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
| F17 | `daily.sh` は `CM_RUN_LOCK_TOKEN` を**同じシェルの中で**設定してから取得するので、自分の取得が継承の経路（D8）を通る | `daily.sh:91-92` | PR1b は取得の後に `export CM_RUN_LOCK_TOKEN=<T0>` する形に直し、`up`・`cleanup` は冒頭で `CM_RUN_LOCK_TOKEN` を消す（§4.2）。新しい daily の子は exec の前に T1 を作って継ぐ（§4.5）。継承の `own-other`・`aside-own` は既存の試験と旧い daily の T0 で到達する（§2.2 注 ³、上流の 3 回目） |
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
| **I-10 down は確かめた G だけに送る** | `down` が G に信号を送るのは、(1) 長が生きていて、今の確かめ（`CM_DB_PATH`・port・`ps -o pgid=` が G）を通ったとき、または (2) 長が死んでいて、G の残りの**全員**の `CM_DB_PATH` が run dir の下のときだけ。どちらでもなければ何も送らず、ロックを残し、「停止完了」と書かない | 根拠の範囲（Claude 5 P3 で狭めた）: (1) は**長が生きている間**だけ「G の番号は再利用されない」が成り立つ。長を TERM して `wait`（up の trap）／ESRCH を見た（down）後に G へ送るのは (2) と同じく、送る直前に一覧し直して全員を確かめる。G が `unknown`（EPERM）のときは長だけに送る（1 回目の表の `leader+group` は誤り。Claude 5 P2-4）。引渡しの段の失敗（表 D。上流の 3 回目で「`go` の前」を表 D の「公開の前」に揃えた、PM Claude P3-3）: **公開の前**（記録が T0: `state-write`・`group`・`tmp`・`mv`、表 E の `stage=arg`。`token` は記録が読めない）は待っている子の **pid だけ**に送る。**公開の後で `go` の前**（`verify`・`verify-unreadable`・`signal`）は、**どの行も**長が生きていて `ps -o pgid=` が G のときだけ `-G` に送り、確かめられなければ pid だけで、**pid だけに送った枝は後で G を排水しない**（`lock_drain_group` も `-G` に送るので。上流の 4 回目、PM Claude P3-4）。`abort` は送らない。`abort` で `ack` が在る（子は始まっている、`abort-acked`）は `go` の後と同じ扱い（UAT は表 C の手続き）。長を `wait` で回収した後（daily の通常の終わり）は `lock_drain_group`（空なら何も送らない）で、`lock_stop_gate`（無条件に `-G` へ TERM）は長をまだ回収していない経路だけ（§4.5、Claude 5 P2-C） |
| **I-11 1 つの run-lock に 1 つの実装** | TS と bash は同じ `<lock>`・`.queue`・`.gone-*` を同じ規則で扱う。表 A の取得と継承の列は TS と bash で同じセル | 試験: TS と bash の取得・継承の表を**別々に書いたオブジェクト**にして比べる（1 回目は同じオブジェクトを比べていて常に通った。PM Claude P3-1）。違うのは `own-self-selfg` の「なぜ到達しないか」だけ（TS は pgid を書かない、bash は拒否）。実装の一致は `it.todo`（両方を同じ行で走らせて比べる） |

全経路で成り立つ理由（経路 → 効く不変条件）:

| 経路 | 効く不変条件 |
|---|---|
| `main.ts` の取得・解放・signal | I-1 (i)・I-2・I-8・I-9。signal・`kill -9` は解放しない→次の先頭が (iii) で回収 |
| `daily.sh` の取得・引渡し・子・EXIT・INT／TERM | I-4・I-6・I-7・I-5（pid≠pgid）・I-1 (i)（G が空のときだけ）・I-3・I-10（公開の前は pid だけ、回収の後は `lock_drain_group`） |
| `run.ts`（とその bash の子）の継承 | I-2・D8。新しい daily の子は T1 を継ぎ、継ぐ者は G の中なので T1 は gone にならない。旧い daily の T0（`pgid=` 無し）を継ぐのは混在の朝（`own-other`） |
| UAT `up` の取得・引渡し・失敗の trap | I-6・I-7・I-1 (i)（T0）／(ii)（T1 は needs-head→D5）・I-3・I-10（go の後の trap は、自分で終わった長を `wait` で回収してから down と同じ手続き） |
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
| `own-other` | 自分の token・pid が呼び手でない・`pgid=` 無し（`down` から見た `up` の T0、旧い形の記録、bash の pid≠`$$` の取得、継ぐ者から見た旧い daily の T0） |
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
| `own-other` | — ×3 ¹ | In / Rc / ✕unknown ³ |
| `foreign` | ✕held / Rc / ✕unknown | 取得と同じ |
| `aside-own` | — ×3 ¹ | In / Rl / ✕unknown r ³ ⁱ |
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

注（実装の契約で直した 1 点。ⁱ）: 継承の `aside-own` × unknown は、先頭が不明な持ち主の退避の記録を `<lock>` へ戻す（PR1a の `settleGone`／`lock_settle_gone`、土台 §2.7）ので `r`（restored）。上流の 3・4 回目の表は `r` を付けていなかったが、TS・bash の両方の実装がそう動く（`aside-foreign` と同じ）。行の中身が変わったのではなく、後の `<lock>` の欄の誤りを直した。

注（到達しない理由。試験の `never(…)` と同じ文）: ¹ 取得の token は毎回新しいので、自分の token の記録は取得の前に無い。² 継ぐ者は記録の pid ではない。³（到達の注。上流の 3 回目で 1 回目の値に戻した、PM Claude P2-1・Claude 5 P3-B）継承の `own-other`・`aside-own` は到達する: `run-lock-3359.test.ts:89-97`（pgid 無しの `daily-token` の記録を TS が `inherited`）、`run-server-3359.test.ts:430-433`（bash が `GOT`）、デプロイの朝（旧い `daily.sh` が T0 を pgid 無しで持ち、pull の後の新しい `run.ts` を起こす。土台 §1.9 の「新しい継承 × (a)」）。`aside-own` は D8 の 2 つ目の文（`<lock>` が missing の間は同じ token の生きた退避を継ぐ）。**新しい** daily の子が見る記録は T1（`own-other-g`。§4.5 で子が exec の前に T1 を作る）。`up`・`cleanup` は `CM_RUN_LOCK_TOKEN` を消してから取る（F17）ので、この行に来るのは継ぐ者だけ。狭めて塞ぐ（PM 共通の決定 2）のは本番の呼び手が無い行だけで、この 2 形には当てない。⁴ Node は自分の pid を観測しない。⁵ main シェルの `$$` は呼び手自身で生きている（自分の uid の生きた pid への `kill -0` は ESRCH にも EPERM にもならない。サブシェルは表 E で拒否）。⁶ D5 を呼ぶのは `down` と `run_lock_release` の needs-head の後だけで、どちらも記録の pid は呼び手の `$$` でない（Claude 5 P2-1・PM Claude P3-9）。⁷ `$$`／`process.pid` で取った記録は、その pid が生きている間 gone と判定されず退かされない。⁸ 下の「読み方」。⁹ 継ぐ者は G の中に居るので G は ESRCH にならない。¹⁰ TS は pgid を書かない。¹¹ UAT の T1 の pid は G の長なので、pid が生きていれば G は空でない。

読み方の要点:

- **継承の `own-other`・`aside-own` は到達する**（³）。継承は `<lock>` も退避も消さず（`inherited` は `unchanged`）、pid が gone なら通常の取得（回収・退避の片付けは先頭の (iii)）、unknown なら断る（I-2）
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

### 2.4 表 C: UAT `down` — 記録 × 長 × G の残り（145 行＝120 ＋ `t1` × D5 の結果 25、review-4288h P2-3・PM P1-1）

`down` は**信号を送る前に** owner を 1 回読み、状態ファイル（`run_id`＝T0・`server_pid`＝G・`lock_token`＝T1）と突き合わせて記録の軸を決める（Claude 5 P2-3・PM Claude P2-1・P2-2）。

| 記録 | 判定 |
|---|---|
| `t1` | 記録の token が `lock_token`（無ければ `<run_id>-g<server_pid>`）で `pgid=server_pid` |
| `t0-up-alive` | token が `run_id`、pid が `server_pid` でない（＝`up` の `$$`）、`kill -0` が alive |
| `t0-up-dead` | 同じで pid が ESRCH（`up` が公開の前に死んだ） |
| `old` | 状態に `lock_token` が無く、記録に `pgid=` が無く、pid が `server_pid`（旧い `up`。PM 共通の決定 2: 今の pid だけの停止） |
| `other` | token がこの run のどれでもない（我々の記録が回収され、別の run が取った） |
| `absent` | `<lock>` が無い |

**旧い形かどうかは状態ファイルの形で決める**（上流の 3 回目、PM Claude P3-4。4 回目で表の後ろへ移した、PM Claude P3-1）: 長の確かめに `ps -o pgid=`＝G を求めるか・G を観測するかは、記録の軸と別に、状態に `lock_token` があるか（新しい `up` が書いた）で決める。`lock_token` が無ければ（旧い `up`）、記録が `absent`・`other` でも pgid を条件にせず、G は観測しない（`none` と読む）。この読みの行は表 C の `absent`・`other` の `alive-verified × none`・`dead × none` にすでにあり、セルは変わらない（旧い生きたサーバーは `alive-unverified` に落ちず、今の pid だけの停止で止まる）

長（`server_pid`）: `alive-verified`（`kill -0` が alive・ゾンビでない・`CM_DB_PATH` が run dir の下・port の LISTEN が長だけ・`ps -o pgid=` が G。状態に `lock_token` が無ければ pgid を条件にしない）、`alive-unverified`（どれかが通らない・確かめられない。再利用された pid の EPERM を含む）、`zombie`（`kill -0` は alive だが `ps -o stat=` が `Z`）、`dead`（ESRCH）、`unrecorded`（`server_pid` が無い）。G の残り: `none`（ESRCH。`old` では「観測しない」）・`verified`（全員の `CM_DB_PATH` が run dir の下）・`unverified`（1 人でも違う・読めない・ゾンビ）・`unknown`（`kill -0 -G`・`ps` が言えない）。

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

**記録ごとの行**（到達 52＋25・到達しない 68）:

| 記録 | 到達する行 | 到達しない行（理由） |
|---|---|---|
| `t1` | 長 4（`unrecorded` 以外）× 残り 4＝16: 手続きの表のとおりで、D5 は `released`（何も割り込まないときの行）。**加えて D5 の結果の軸 25 行**（上流の 3 回目、PM 決定 3・Claude 5 P3-A）: D5 を呼ぶ 5 つ（`alive-verified × none／verified／unverified`・`dead × none／verified`）× D5 の結果 5（`deferred`＝TERM の後 `STOP_WAIT` で長が終わらない・G にメンバーが戻った、`not-head`＝10 秒札の先頭になれない、`unknown`＝D5 の読みで owner が読めない、`kept`＝G が空になった後に別の取得者の先頭が我々の T1 を回収して取った、`missing`＝その先頭が解放まで済ませた）。信号は同じ、状態は C′ のとおり（`missing` だけ `stopped`・0） | `unrecorded` ×4（T1 は `server_pid` を書いた後にだけ公開される、I-6） |
| `t0-up-alive` | 長 5 × `none`＝5: **何も送らず D5 を呼ばない**・`stop-refused-lock`・1、文面「`up`（pid N）がまだ動いている。終わるのを待つか止めてから `down`」 | 残り `verified`・`unverified`・`unknown` ×5（公開の前の G は待つ子 1 人。`unrecorded` は G を名指せない） |
| `t0-up-dead` | 長 5 × `none`＝5: `alive-verified`（待っている子）は TERM → D5 `released`、`dead`・`unrecorded` は D5 `released`、`alive-unverified`・`zombie` は `stop-refused` | 残り `verified` 以下 ×5 |
| `old` | `alive-verified`→長に TERM（今の `stop_recorded`）→ D5 `released`、`dead`→ D5 `released`、`alive-unverified`・`zombie`→`stop-refused`。4 行 | 残り ×4（旧い形は G を観測しない）、`unrecorded` ×4（旧い形の記録の pid は `server_pid`） |
| `other` | 長 5 × `none`＝5: 手続きのとおりで、D5 は `kept` → `stop-refused-lock`・1 | 残り ×5（記録が替わるのは先頭が我々の記録を gone と判定した後だけ。T1 なら G はそのとき空、T0 なら G は待つ子 1 人） |
| `absent` | 長 4 × 残り 4 ＋ `unrecorded × none`＝17: 手続きのとおりで、D5 は `missing` → `stopped`・0（2 度目の `down` もここ） | `unrecorded` × 残り 3（G を名指せない） |

**PM 個別の決定（P1-1）の行**: `run-server.sh down <run>` が生きた G の自分の T1 を確実に片付けるのは、`t1 × alive-verified × none／verified` と `t1 × dead × none／verified`（試験で `released`・`stopped` を固定）。`up` が断るときの文面はこの `down` を名指す（§4.6）。

**`up` の失敗の trap**（1 回目は 1 文だけだった。PM Claude P2-1）: `go` の前は表 D の行。`go` の後は `down` と**同じ手続き**（記録 `t1`）を呼ぶ。表 D の `abort-acked`（`go` が既にあったが `ack` が在る＝子は始まっている）も `go` の後と同じに扱う（上流の 4 回目、PM Claude P2-1。§4.5 の `up_on_exit`）。サーバーは `up` の子なので、**手続きに入る前に**長が自分で終わっていないかを見る: `kill -0` が ESRCH でなく `ps -o stat=` が `Z`（`up` が回収していないゾンビ）なら `wait "$server_pid"` で回収し（すぐ返る）、長を `dead` と読む。送ったときは送った後に `wait` する。こうして長は trap の中で `zombie` にならない（表 C の `zombie` の行に来るのは `down` だけ）。**送らずに長が自分で終わる経路**（表 D の `ack`＝子が exec せずに終わる・`child-exits`＝exec の後すぐ終わる）もこの回収を通り、表 C の `t1 × dead × none` → D5 `released` → `failed` になる（上流の 3 回目、Claude 5 P2-B）。`up` の中の「すぐ終わった」「LISTEN の前に終わった」の判定（今の `run-server.sh:479`・`:497` の `run_lock_pid_alive`）も同じ規則で、ゾンビを生と読まない（`Z` か ESRCH なら `wait` してから「終わった」とする）。状態は `stopped`→`failed`、それ以外→`failed-server-left`（今の値のまま）。今の `stop_recorded`（2 値の `run_lock_pid_alive`）で「長だけ死に G が残る」を `failed` と書く穴は、この手続きで閉じる。

`stop-refused-group`・`stop-refused-lock` の後の扱い: ロックは保護中のまま（I-9）。G が空になった後（人が止めた後）に `down` をもう一度呼ぶか、次の取得者の先頭が回収する。`cleanup` は G が生きている間は取得を断るので、生きた子を止めない。

### 2.5 表 D: 親が生きたまま引渡しの段が失敗する（24 行、PM Claude P2-3。4 回目で `token`・`abort-acked` を足した）

型（PM 共通の決定 3）: 流れ × 失敗 → 記録・信号・子・解放の経路・後のロック・状態・exit・文面。

| 失敗 | UAT（`up`） | daily |
|---|---|---|
| `state-write`（`state_set server_pid` の失敗） | 記録 T0。待っている子の **pid だけ**に KILL して `wait`。子は始まらない。D12 `released`。状態 `failed`、exit 1、`state-write-failed` | 到達しない（daily は状態ファイルを書かない） |
| `token`（`lock_hand_off` の最初の読みが T0 でない・読めない。I-6 の下では読めないときだけ。上流の 4 回目、PM Claude P3-2） | 記録不明（公開の前）。待っている子の **pid だけ**に KILL・`wait`。子は始まらない。D12 `deferred`、**ロックは残る**。状態 `failed-lock-left`、1、`handoff-failed stage=token` | 同じ。D12 `deferred`、ロックは残る。sync の失敗、exit 2（`verify-unreadable` と同じ扱い） |
| `group`・`tmp`・`mv` | 記録 T0。pid だけに KILL・`wait`。子は始まらない。D12 `released`。`failed`、1、`handoff-failed stage=<段>` | 記録 T0。同じ。D12 `released`。sync の失敗、exit 2、同じ文面 |
| `verify`（読み直しが T1 でない） | 記録 T1。長が生きていて `ps -o pgid=` が G のときだけ `-G` に KILL（確かめられなければ pid だけ）・`wait`。子は始まらない。D12 needs-head → D5 `released`。`failed`、1 | 記録 T1。同じ確かめで `-G` に KILL・`wait`。D12 `released`（G が空の後）。exit 2 |
| `verify-unreadable`（読み直せない） | 記録不明。同じ確かめで `-G` に KILL・`wait`。D12 `deferred`、**ロックは残る**。状態 `failed-lock-left`（新しい値）、1 | 同じで D12 `deferred`、ロックは残る。exit 2 |
| `signal`（`mkdir go` の失敗で `go` が無い） | 記録 T1。同じ確かめで `-G` に KILL・`wait`。子は始まらない。D12 needs-head → D5 `released`。`failed`、1 | 記録 T1。同じ。D12 `released`。exit 2 |
| `abort`（`go` が既にあり、`ack` が現れない＝子が期限で取り下げた） | 記録 T1。送らない（子は自分で終わる）・`wait`。D12 needs-head → D5 `released`。`failed`、1 | 同じ。D12 `released`（G は長 1 人で回収済み。排水しない）。exit 2 |
| `abort-acked`（`go` が既にあったが `ack` が在る＝子は始まっている。上流の 4 回目、PM Claude P2-1） | 記録 T1。**`abort` の `wait` に入らない**（始まったサーバーを待ち続けない）。`go` の後と同じに trap が表 C の手続き（記録 `t1`。長を確かめて TERM・G を排水）→ D5 `released`。`failed`、1、`handoff-failed stage=abort` | 記録 T1。子は T1 の下で働いているので (D) と同じく `wait "$child"`（子の終わりまで）→ (E) の排水 → D12 `released`。exit 2、`handoff-failed stage=abort` |
| `ack`（子の `mkdir ack` の失敗） | 子は exec せず終わる（`up` のゾンビ）。送らない。`go` の後なので trap は**まず `wait` で回収**し（§2.4）、`down` と同じ手続き（表 C `t1 × dead × none`）→ D5 `released`。`failed`、1、`server-exited` | 子が終わる → daily の `wait "$child"` が回収し、その直後の `lock_drain_group`（空なら送らない）→ EXIT で D12 `released`。exit 2、`handoff-failed stage=ack` |
| `child-exits`（exec の後すぐ終わる） | 同上（今の「the server exited at once」`run-server.sh:479`。ゾンビを生と読まず `wait` で回収してから） | `run.ts` の終了。`wait` で回収 → `lock_drain_group` → EXIT で D12 `released`。exit は子の exit |

表 D の各行が §4.5 のどの行で起きるかは §4.5 の注（(A)〜(F)）。表 D の `it.todo` は §4.5 の形のまま、止め所（`CM_VERIFY_TEST_HANDOFF=pause:<stage>`・`fault:<stage>`）と偽の子で駆動できる（UAT は §4.5 の試験の口の渡し方で `env -i` を越える）。

試験が固定する規則: 公開の前（`state-write`・`token`・`group`・`tmp`・`mv`）は送るのは pid だけで、記録は T0（`token` だけは読めない記録で、D12 は `deferred`）（PM Claude P3-6）。`-G` に送るのは公開の後だけで、その全ての行（`verify`・`verify-unreadable`・`signal`、UAT の `abort-acked` は表 C の手続きの確かめ）が「長が生きていて `ps -o pgid=` が G」の確かめを持ち、確かめられず pid だけに送った枝は G を排水しない（I-10。試験の型 `FailCell.signals` の注に書いた）。`abort-acked` は子が始まっている（`child: ran`）ので、UAT は表 C の手続き、daily は子の終わりまで待つ。KILL の後の `wait` はすぐ返るので、どの失敗でも子の取り下げの期限（30 秒）を待たない。`go` の前の失敗では子は始まらない（I-7）。ロックが残るのは owner が読めないときだけで、状態にそう書く。UAT の T1 は needs-head → D5、daily の T1 は G が空になってから D12。

### 2.6 表 D2: ゾンビ・host の変化・EPERM・空にならない G（20 行、PM 共通の決定 3）

どれも**消さない側**に倒れ、文面で人に知らせる。唯一消すのは daily 自身の記録（D12 の自己の経路は `host=` を読まない）。

| 事象 ＼ 呼び手 | 取得 | daily の EXIT | UAT の trap | `down` |
|---|---|---|---|---|
| `zombie`（記録の pid・G のメンバーがゾンビ） | 断る（`held` に「ゾンビ: 親 P が回収していない」） | 到達しない（daily は長を `wait` で回収してから `lock_drain_group`、回収していない経路は長を `wait` する `lock_stop_gate`。§4.5） | 到達しない（trap は手続きの前に、自分で終わった長を `wait` で回収し、送った後も `wait`。§2.4） | `stop-refused`、文面にゾンビ |
| `host-changed`（記録の `host=` が今の hostname でない） | 断る（「host H で記録された。H がこの機械なら人が `<lock>` を消す」） | `released`（自分の記録） | `deferred`、ロックは残る（D5 の保有者の判定は別の host を alive と読む） | `stop-refused-lock`（holder-alive、host を文面に） |
| `eperm-pid` | 断る（`unknown`、errno=EPERM） | 到達しない（自分の `$$`） | `deferred` | `stop-refused`（長を確かめられない） |
| `eperm-group` | 断る（`unknown`、point=group） | `deferred` | `deferred` | `stop-refused-group` |
| `group-not-emptied`（KILL の後も G が空でない） | 到達しない（取得は送らない） | `deferred`（残った pid を文面に） | `deferred` | `stop-refused-group`（残った pid） |

### 2.7 表 E: 引数・文脈の検査（20 行）

§4.2。表 A の「拒否」の行が指す検査で、試験は「指す検査がその実装で到達の行であること」を全行で確かめる。

### 2.8 行数

| 表 | 列挙 | 行 | 到達 | 拒否 | 到達しない |
|---|---|---|---|---|---|
| A | 呼び手 10 ×（pid だけの形 12 × 3 ＋ `-g` の形 6 × 9） | 900 | 590 | 90 | 220 |
| B | 段 6 × 流れ 2 × 事象 2 | 24 | 14 | 0 | 10 |
| C | 記録 6 × 長 5 × 残り 4 ＋ `t1` × D5 を呼ぶ 5 × D5 の結果 5 | 145 | 77 | 0 | 68 |
| C′ | D5 の結果 6 | 6 | 6 | 0 | 0 |
| D | 流れ 2 × 失敗 12 | 24 | 23 | 0 | 1 |
| D2 | 事象 5 × 呼び手 4 | 20 | 16 | 0 | 4 |
| E | 検査 10 × 実装 2 | 20 | 12 | 0 | 8 |
| 計 | — | **1139** | **738** | **90** | **311** |

表 A の呼び手ごとの到達: `ts-acquire` 45・`ts-inherit` 57・`ts-release` 46・`ts-release-inherited` 81・`sh-acquire` 45・`sh-inherit` 57・`sh-release-held` 65・`sh-release-unheld` 81・`sh-hand-off` 46・`sh-release-as-head` 67。

試験のファイルはこの数を固定する。陽性の対照（この段で実行して確かめた）: (1) 表 A の D5 の `aside-foreign-g` を消すと `tsc` が型の誤り（`satisfies CallerTable`）。(2) D5 の `own-other-g × pid gone × G unknown` を `released(removed)` にすると I-1・I-2 の検査が赤。(3) C′ の `deferred` を `stopped`・0 にすると C′ の検査が赤。上流の 3 回目（os.tmpdir() の写しで実行）: (4) TS の継承の `own-other` を 2 回目の「到達しない」に戻すと、行数と I-11（TS と bash の一致）が赤。(5) `t1` × D5 の `deferred` を `stopped`・0 にすると表 C の検査が赤。(6) `t1` × D5 から `dead × verified` を抜くと、D5 を呼ぶ `t1` の行とちょうど一致する検査と行数が赤。上流の 4 回目（同じく写しで）: (7) 表 D の UAT から `token` を抜くと `tsc` が型の誤り（`satisfies Record<Flow, Record<HandoffFailure, FailCell>>`）。(8) `abort-acked` の子を `never-starts` にすると表 D の検査が赤。(9) `token` の解放を `D12-released` にすると表 D の検査が赤（読めない記録を消す形）。

---

## 3. (c) 外部の呼び出しごとの失敗の倒れ方

「消す側」＝ロック（canonical・退避）を消す・取る・信号を送る方向、「消さない側」＝残す・断る・送らない方向。1 回目の表から変えた行と足した行だけ太字にした。行ごとの期待は表 A・C・D・D2 のセル。

| 呼び出し | 場所 | 失敗 | 倒れる側 | 理由・PR1b の扱い |
|---|---|---|---|---|
| `kill -0 <pid>`・`kill -0 -<G>`（bash） | `lock_obs_kill0` `verify-run.sh:848-857` | ESRCH 以外（EPERM・文面が読めない） | 消さない | unknown。表 D2 `eperm-*` |
| `process.kill(pid, 0)`（TS） | sync `:153-161`、`hooks.kill`（D10） | ESRCH 以外 | 消さない | 同上 |
| 旧い `run_lock_pid_alive` | `run-lock.sh:50-56` | EPERM を生・`ps` の失敗を死 | 消す側にもなる（2 値） | **ロックの判定に使わない**。2 値のまま残す（§4.3 の契約）。`down`・`up` の trap の判定は表 C の手続き（`kill -0` の ESRCH と `ps -o stat=`）で、この関数の「死」で決めない |
| **ゾンビ** | `kill -0` は alive を返す | — | 消さない | 長・メンバーがゾンビなら G は空にならない。daily は長を `wait` で回収した直後に `lock_drain_group`、回収していない経路（INT／TERM・公開の後の失敗）は長を `wait` する `lock_stop_gate`。`up` の trap と `up` の中の生死の判定は、自分で終わった長（`Z`・ESRCH）を先に `wait` で回収し、送ったときは送った後に `wait`（§2.4）。`down` は `ps -o stat=` で見分けて文面に出す（表 D2） |
| **`hostname` の変化** | `LOCK_HOST`（`verify-run.sh:612`）と `lock_holder_state` `:1107` | 記録の `host=` が今と違う | 消さない | 保有者は alive と読まれ、誰も回収しない。文面で知らせる（表 D2）。D12 の自己の経路は host を読まないので daily は自分で消せる |
| `ps -o pgid= -p` | `lock_obs_pgid` `:1055-1060` | 失敗・空・数でない | 消さない | `stage=group`。子は始めない。`down` は `alive-verified` にしない |
| `ps eww -o command=`（`CM_DB_PATH`） | `env_value_of` `run-server.sh:97-99` | 失敗・空（ゾンビも空） | 消さない | `alive-unverified`／`unverified` → 送らない |
| `ps -o etime=` | `lock_pid_start_ms` `:1129-`、sync `:89` | 失敗 | 消さない | 札を外さない |
| **`lsof`（LISTEN の確かめ）** | `find_listen_pids_by_port` `port-pids.sh:33-42` | 無い・失敗 | **送る側**（1 回目は「消さない側」と書いていた。PM Claude P3-7） | 空の一覧は「誰も listen していない」と読まれ、port の条件を素通りする。長への信号は `CM_DB_PATH` と `ps -o pgid=` の条件で守られる（どちらも通らなければ送らない）。今の `stop_recorded:127` と同じ（PR1b で変えない） |
| `mv`（回収の退かし・戻し・引渡しの公開） | `lock_obs_mv`・`lock_recover`・`lock_hand_off` | 各失敗 | 消さない | 1 回目のとおり。引渡しの公開の失敗は表 D `mv` |
| `printf > tmp`（引渡しの tmp） | `lock_hand_off` | 失敗 | 消さない | 表 D `tmp` |
| **owner の読み直し（引渡し）** | `lock_hand_off` の verify | 違う記録・読めない | 消さない | 表 D `verify`・`verify-unreadable`（読めなければロックを残し、状態にそう書く） |
| **合図の `mkdir go`** | `lock_obs_mkdir handoff-signal` | `exists`／それ以外 | 消さない | `abort`（子が取り下げた）／`signal`（作れない）。どちらも子は始まらない（表 D）。`go` が在っても `ack` が在れば子は始まっている（`abort-acked`、`go` の後の扱い。`run_lock_abort_settle` で決めてから） |
| **UAT の `go`／`ack` の名前**（上流の 4 回目） | `$RUN_DIR/handoff-$run_id.*` の fork の前の `rm -rf` | 消せない・残る | 消さない（起こさない） | `stage=arg` で子を起こさず、trap が T0 を D12。前の run の名前には当たらない（§4.5） |
| **子の `mkdir ack`** | `lock_child_wait` | 失敗 | 消さない | 子は exec しない（表 D `ack`） |
| **状態ファイルの書き込み** | `state_set` `run-server.sh` | 失敗 | 消さない | 引き渡さずに exit 1（表 D `state-write`、I-6） |
| owner の排他作成 | `lock_obs_create`・sync `claim` | 書き込みの途中の SIGKILL | **消さない側（取れなくなる）** | 空の owner＝`corrupt` が残り、誰も回収しない。**PR1a-f で tmp→mv に戻して塞ぐ**（PM 共通の決定 1）。それまでは `corrupt` の文面で人に知らせる（§4.6） |
| `mkdir <lock>`・`rmdir`（D3） | `lock_obs_mkdir`・`lock_expire_ownerless` | EEXIST 以外／空でない | 消さない | `ownerless-nonempty` は D3 が効かず断り続ける。**PR1a-f で塞ぐ**。それまでは中身の一覧を文面に出す |
| `rm -rf <lock>` | `machine-lock.sh:241`、`verify-run.sh:1986` | 部分失敗 | 消す側に寄る（他者のロックは消さない） | 1 回目のとおり。空でない残りは `ownerless-nonempty`（上の行） |
| `fs.rmSync(lockPath)`（TS） | sync `:930` | EACCES・EIO | 消さない（例外） | TS の包みが捕まえる |
| 札の `ln`・退避の一覧・owner の読み | 1 回目のとおり | — | 消さない | — |
| `tmux` | `run-server.sh:148-160` | 失敗 | 関係しない | keepalive は G の外（土台 §1.8 の保証の外） |
| 時計 | `lock_now_ms` | `%3N` が無い | 消さない側に寄る | 1 回目のとおり。lstart の TZ は supervisor.lock（PR1c）の話で、PR1a-f で塞ぐ |
| 子の起動（`set -m` の背景ジョブ） | §4.5 | G が親と同じ | 消さない | `stage=group`（または表 E の `handoff-pgid-self`）→ pid だけに KILL・`wait`（すぐ返る。30 秒待たない）（表 D） |

---

## 4. (d) PR の切り方

### 4.1 PR1b は 1 本

| 中身 | ファイル |
|---|---|
| TS の包み（D8・D10・D11、F6 の例外の捕まえ、I-8、pid≠`process.pid` の拒否） | `src/lib/agent-health/run-lock.ts` |
| bash の包み（D1 の kv・D2・D3・D8・D12 の包み〔needs-head なら中で D5〕・D5 の包み・I-6 の `run_lock_set_pid <T0> <pid> <pgid> <go>`〔G の確かめ・T0 の `label=`・`run_dir=` の引き継ぎ・公開・合図の `mkdir go` まで。§4.5〕・表 E の検査・§4.3 の読み込み・§4.6 の文面・`abort` の枝の `run_lock_abort_settle`〔`ack` が在れば `acked`。§4.5〕） | `scripts/uat/run-lock.sh` |
| UAT の呼び手（§4.5 の起動と試験の口の渡し方、run ごとの `go`／`ack` と fork の前の消去・確かめ、`up_handoff_fail`・`fail_up`・`up_on_exit`、`server_pid` の書き込みの確かめ、`lock_token`、表 C の `down`、表 D の trap〔自分で終わった長の `wait` の回収〕、`CM_RUN_LOCK_TOKEN` を消す） | `scripts/uat/run-server.sh` |
| daily の呼び手（§4.5 の子〔exec の前に T1〕・`go`・失敗の枝、取得の後の `export`、回収の後の `lock_drain_group`・回収していない経路の `lock_stop_gate`、D12） | `scripts/agent-health/daily.sh` |
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
- **`up`・`cleanup` は冒頭で `CM_RUN_LOCK_TOKEN` を消す**（run の子ではない。環境に残った token で daily の記録を「継いで」から引渡しで止まる経路を消す。Claude 5 P3）。**`daily.sh` は取得の後に `export CM_RUN_LOCK_TOKEN=<T0>`** し、自分の取得を継承の経路に通さない（F17）。子は引渡しの前に起こすので親からは T1 を渡せない。**子が exec の直前に `CM_RUN_LOCK_TOKEN="$CM_RUN_LOCK_TOKEN-g$$"`**（`bash -c` の `$$`＝子の pid＝G）を作り、`run.ts` は T1 を継ぐ（表 A `ts-inherit × own-other-g`。土台 D9。上流の 3 回目、PM Claude P2-2 (a)・Claude 5 P2-A）
- **T1 は T0 の `label=`・`run_dir=` を引き継ぐ**（PM Claude P3-1）: `lock_hand_off` は `lock_format_owner` で書き直し、呼び手の欄は `LOCK_OWNER_EXTRA` からしか書かない。`run_lock_set_pid` は I-6 の確かめの owner の 1 回の読みのテキストから `label=`・`run_dir=` を取り、`LOCK_OWNER_EXTRA` にして `lock_hand_off` を呼ぶ（呼ぶたびに設定し、呼び終えたら戻す。§4.3 の S10）。`up` の断る文面の `down --run-dir` の案内（§4.6）は T1（`held-group`）でも出る。§4.4 の `:357-378` の新しい期待がこれを固定する
- **daily の EXIT**（上流の 3 回目で分けた。Claude 5 P2-C・PM Claude P3-2）: **通常の終わり**は `wait "$child"` で長を回収した**直後**に `lock_drain_group "$G" 0`（空なら何も送らない。ゲート本体の `:2406` と同じ）を呼び、EXIT ではもう送らない。空になって番号が再利用されたかもしれない G に TERM を送らないため（`lock_stop_gate` は空かを見ずに `-G` へ TERM を送る）。**長をまだ回収していない経路**（`wait` の途中の INT／TERM、公開の後で `go` の前の失敗の枝の前）だけ `lock_stop_gate "$G" "$child"`（長を `wait` してから G を TERM・猶予・KILL。待っていない長に `lock_drain_group` を使うと長がゾンビで残り D12 が `deferred` になる、Claude 5 P2-5）。公開の前（G が無い・子 1 人）は子の pid に KILL して `wait`。どの経路も、その後で `run_lock_release` を 1 回（F16: D12 は最初に `LOCK_HELD_PATH` を消すので、G を空にする前に呼ばない）。INT／TERM は `exit 130／143` で EXIT に落とす。形は §4.5

### 4.3 PR1b と PR1c の契約（PM 共通の決定 4。PR1c の設計にも同じ文を置く）

> `scripts/uat/run-lock.sh` は `scripts/lib/machine-lock.sh` の読み込みに失敗しても `run_lock_field`・`run_lock_pid_alive` を含む自分の関数をすべて定義し、source は成功（0）で返す（読み込みの失敗は、run-lock 自身の取得・引渡し・解放を呼んだときに `RUN_LOCK_ERROR` と 1 で断る）。`run_lock_pid_alive` は 2 値で、今の実装（`run-lock.sh:50-56`: 引数が空か数でなければ 1、`kill -0` が通るか `ps -p` が通れば 0、どちらも通らなければ 1。EPERM の生きた pid は `ps -p` で 0）のまま変えない（3 値が要るなら別名の関数にする）。`scripts/agent-health/product/lib.sh` は `scripts/lib/machine-lock.sh` を自分で source し、その戻り値を自分の変数 `PRODUCT_MACHINE_LOCK_OK` に持ち、run-lock.sh 経由で読まれたかに依らずそれで「取らない・ロックの回収だけ飛ばす」（PR1c の S9）を決める。

上の引用が契約の文で、**PR1c の設計 §5.2 の引用と一字一句同じにする**（上流の 3 回目、PM Claude P3-6）。PR1c の今の文（`495872a60` の `supervisor-lock-machine-lock-4288.md:283`）は `run_lock_pid_alive` を「0＝生きている〔EPERM を含む〕・1＝ESRCH」と書き、`ps -p` の失敗も 1 になる今の実装とずれるので、今の実装に合わせた上の文を正とし、PR1c の §5.2 を同じ文に差し替える（PR1c の worktree は本書の契約の範囲外なので、この回では直さず PM に渡す。§7）。

あわせて（PM Claude P3-11、PR1c の S10）: `run-lock.sh` は `source` の時点で大域の状態を変えない（`lock_note_recovered` の上書きなど run-lock の文面の差し替えは、`run_lock_*` を呼ぶたびにそのロックのパスに限って行う）。`lib.sh` 経由で supervisor のシェルに読み込まれても、supervisor.lock の回収の文面は変わらない。`machine-lock.sh` の読み込みは 1 回だけ（`machine-lock.sh:49-51`）なので、`run-lock.sh` が先でも `lib.sh` が先でも同じ。

### 4.4 既存の試験への影響（PM 個別の決定・PM Claude P1-1）

**意図した変更**（消す側 → 消さない側の狭め。弱めではない。試験のコメントに本書のこの節を書く）:

| 試験 | 今の期待 | 新しい期待 | 根拠の行 |
|---|---|---|---|
| `run-server-3359.test.ts:357-378`「the next up cleans what a killed run left…」 | owner の `pid=` を死んだ pid に書き換え、サーバーは生かしたまま、2 回目の `up` が status 0・前のサーバーを止める・状態 `cleaned` | 2 回目の `up` は **status 1** で断り、文面に `another run holds <dir> (` と **`run-server.sh down --run-dir <1 回目の run dir>`**（§4.6）。その `down` が status 0・前のサーバーが止まる・socket dir が消える・状態 `stopped`。続く 3 回目の `up` が **1 回目と同じ run dir** で status 0（下の行。名前の「次の up が片付ける」は「`down` の後の次の up」として残る） | 記録は T1（`pgid=G`）。pid を死んだ pid にしても G（サーバー）が生きているので保有中（表 A `sh-acquire × foreign-g × pid gone × G alive` → ✕held-group）。`down` は表 C `t1 × alive-verified × none` → D5 `released`・`stopped` |
| `run-server-3359.test.ts:357-378` の続き（足す期待。上流の 4 回目、PM Claude P2-1） | 無い（2 回目の `up` は別の `run2`） | `down` の後の 3 回目の `up` は **1 回目と同じ `--run-dir`** で status 0・状態 `up`・ロックは 3 回目の T1。試験は 3 回目の前に、1 回目の `run_id` の `handoff-<run_id>.go`／`.ack` を run dir に置く（`up` が消し損ねた形）。3 回目の子は 3 回目の `go` の後にだけ始まり（前の `go` で公開の前に始まらない＝I-7）、`up` は返る（`abort` の `wait` で止まらない） | §4.5 の UAT: `go`／`ack` は `handoff-<run_id>.go`／`.ack`（`run_id` は `up` ごとに新しい）で、fork の前に消して無いことを確かめる。同じ run dir の `down` → `up` は PM 個別の決定の断る文面が案内する手順そのもの |
| `run-server-3359.test.ts:430-437`「…and release touches only its own token」の最後の 2 行 | 新しいシェルの `run_lock_release parent` で `<lock>` が消える | 新しいシェルの `run_lock_release parent` は**何もしない**（`<lock>` は残る）。持ち主の記録を消すのは持ち主のシェルの D12 と、保有者が死んだ後の D5（同じ試験の中で、owner の pid を死んだ pid にしてから `run_lock_release_as_head parent` が消すことを示す） | 表 A `sh-release-unheld × own-other × alive` → `none`（F16）。D5 は `own-other × gone` → `rel` |

**台の変更**（期待は変えない）: `daily-sh.test.ts:95`・`metrics-sh.test.ts:42` の種のリポジトリに `scripts/lib/machine-lock.sh` と `.claude/skills/cmate-verify/scripts/verify-run.sh` を写して追跡させる（写さないと読み込みが失敗し、§4.3 の契約で `run_lock_acquire` が 1 → `reason=run-locked:` の期待が `machine-lock not loaded` に変わる）。

**形を変えない**: `uat-yaml-2590.test.ts` の `env -i ` で始まる論理行・代入の位置（F18）は §4.5 の形で保つ（試験の口の配列も `env -i` と `nohup` の間の代入の位置に置く）。試験は変えない。

**呼び手の結果が変わるもの**（上流の 3 回目、PM Claude P3-7）: `down` の exit 1 が増える呼び手 `scripts/agent-health/product/supervisor.sh:269`（`bash "$RUN_SERVER" down --run-dir "$RUN_DIR"` が 1 なら `stage down fail`）。表 C′ の `kept`・`not-head`・`deferred`・`unknown` と `stop-refused-group` で、今は 0 だった停止が 1 になり、日次の製品確認の結果に `down fail` として出る（意図した正直さ。ロックが残ったことを隠さない）。PR1c の設計と運用の文書（`docs/user-guide/agent-health.md` の結果の読み方）に影響する。試験の期待を変えるものは無い（`supervisor.sh` の `down` の失敗を固定した試験は無い。`git grep 'stage down fail' -- tests` で確かめる）

**期待が変わらないことを確かめたもの**（読みで。実行は実装の契約）: `run-lock-3359.test.ts` 全体（TS は `pid: process.pid` だけ、bash の pid≠`$$` の取得は exit 0 のまま・解放しない、`:89-97` の pgid 無しの記録の継承は `inherited` のまま＝表 A `ts-inherit × own-other × alive`。上流の 3 回目で 2 回目の「到達しない」を 1 回目の値に戻したので、表と一致する）、`run-server-3359.test.ts:430-433` の新しいシェルの継承の `GOT`（表 A `sh-inherit × own-other × alive`。§4.4 で変えるのはこの試験の最後の 2 行だけ）、`run-server-3359.test.ts` の他の `it`（`down` が他の owner を止めない・`CM_DB_PATH` が違えば断る・状態ファイル無しで断る・`up` の途中の失敗が自分のものだけ消す〔表 D `child-exits` → D5 `released`・`failed`〕・生きた run が持つ間 `up` が断る・8 者の競争で 1 者・7 件が `another run holds`）。

### 4.5 子の起動の形・合図・失敗の枝・EXIT（PM Claude P3-13・PM 個別の決定。上流の 3 回目で書き直した: PM Claude P2-2・Claude 5 P2-A〜C）

**共通の API**: `run_lock_set_pid <T0> <pid> <pgid> <go>`（main シェルから。表 E の検査が先）。

1. 表 E の検査（`handoff-pid-not-self`・`handoff-pgid-self`〔pgid＝`$$`・pgid＝このシェルの pgid〕・`handoff-twice`・`handoff-subshell`）。外れたら `RUN_LOCK_STAGE=arg`・1（何も書かない）
2. `ps -o pgid= -p <pgid>` が `<pgid>`（子が自分のグループの長）でなければ・言えなければ `RUN_LOCK_STAGE=group`・1（`lock_obs_pgid`。何も書かない）
3. owner を 1 回読み（I-6）、そのテキストの `label=`・`run_dir=` を `LOCK_OWNER_EXTRA` にして `lock_hand_off <lock> <T0> <pid> <pgid>`（§4.2。T1 は T0 の欄を引き継ぐ）。`LHO_STAGE` が `tmp`・`mv` なら `RUN_LOCK_STAGE` にそれ・1。`mv` が通ったら（その後の `verify` の失敗でも）**`RUN_LOCK_G=<pgid>`**（公開した印。EXIT と失敗の枝が `-G` に送ってよいかの前提。公開の前は空）。`LHO_STAGE=token`（最初の読みが T0 でない・読めない）は I-6 の下では owner が読めないときだけ起き、表 D の `token` の行（上流の 4 回目で足した、PM Claude P3-2）。公開の前なので `RUN_LOCK_STAGE=token` で `group` と同じ枝（pid だけ）に入り、D12 は読めなければ `deferred`（ロックは残る。UAT `failed-lock-left`・1、daily sync の失敗・2）。`verify` は読み直しが読めたかで `verify`／`verify-unreadable` に分ける（文面はどちらも `stage=verify`）
4. 通ったら親が合図を作る: `lock_obs_mkdir handoff-signal <go>` を F22 と同じに分ける — `created` → 0（`LOCK_HELD_TOKEN`＝T1）、`exists` → `RUN_LOCK_STAGE=abort`・1、それ以外で `<go>` が無い → `signal`・1（在れば `abort`）。`abort` の呼び手は `run_lock_abort_settle` で、子が始まった（`ack` が在る＝`abort-acked`）か取り下げたかを決めてから枝に入る（下の UAT の注）

`go` を作るのは**この 1 か所だけ**（`lock_child_wait` が期限・親の死で作るのは取り下げ）。だから子は `go` の後にしか始まらず（I-7）、親が生きて引渡しが通れば子は期限（`HANDOFF_WAIT_SEC=30`）を待たずに始まる。

**UAT**（`env -i ` で始まる論理行・代入は `env -i` と最初の `nohup` の間、を保つ。F18）:

```bash
# go／ack は up ごとの名前（run_id は up ごとに新しい: 日時＋乱数）。同じ run dir で down → up し直しても前の run の go／ack に当たらない。
go="$RUN_DIR/handoff-$run_id.go"; ack="$RUN_DIR/handoff-$run_id.ack"
rm -rf "$go" "$ack" 2>/dev/null                                                # fork の前に消して、
[ ! -e "$go" ] && [ ! -e "$ack" ] && [ ! -L "$go" ] && [ ! -L "$ack" ] \
  || fail_up "handoff-failed stage=arg"                                         # 無いと確かめられなければ起こさない（子は居ない → trap が T0 を D12）
deadline=$(( $(date +%s) + HANDOFF_WAIT_SEC ))
test_seams=()   # 試験の口だけを env -i の向こうへ（本番では空。PM Claude P3-5）
for v in CM_VERIFY_TEST_HANDOFF CM_VERIFY_TEST_HANDOFF_DIR CM_VERIFY_TEST_OBS_FAULT CM_VERIFY_TEST_OBS_FAULT_FILE; do
    [ -z "${!v+x}" ] || test_seams+=("$v=${!v}")                              # bash 3.2.57・set -u で確かめた形（§9）
done
set -m
env -i HOME="$HOME" PATH="$PATH" … CM_OPENCODE_PORT_FILE="$RUN_DIR/opencode-ports.json" \
    ${test_seams[@]+"${test_seams[@]}"} \
    nohup /bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; unset CM_VERIFY_TEST_HANDOFF CM_VERIFY_TEST_HANDOFF_DIR CM_VERIFY_TEST_OBS_FAULT CM_VERIFY_TEST_OBS_FAULT_FILE; shift 6; exec "$@"' \
    cm-uat-child "$MACHINE_LOCK_SH" "$go" "$ack" "$deadline" "$$" -- node "$SERVER_ENTRY" >"$RUN_DIR/server.log" 2>&1 </dev/null &
server_pid=$!; child_reaped=0                                                   # (A) forked
set +m
state_set "$UP_STATE" server_pid "$server_pid" \
  || { kill -s KILL "$server_pid"; wait "$server_pid"; child_reaped=1; fail_up state-write-failed; }   # (B) 表 D state-write: pid だけ → exit 1 → trap が D12
run_lock_set_pid "$run_id" "$server_pid" "$server_pid" "$go" \
  || up_handoff_fail "$RUN_LOCK_STAGE"                                          # (C) arg|token|group|tmp|mv|verify|verify-unreadable|signal|abort
UP_PHASE=after-go                                                               # (D) ここから go の後: 子の ack の失敗・exec の後すぐ終わる は、下の生死の判定と trap の回収（§2.4）

fail_up() { # <msg>  — 文面を出して exit 1。状態と解放は EXIT の trap（up_on_exit）がまとめて書く
    log "up: $1"; exit 1
}

up_handoff_fail() { # <stage>  — go の前の失敗の枝。daily_handoff_fail と同じ分け方。どれも 30 秒待たない
    local stage=$1
    if [ "$stage" = abort ]; then                                               # go が既にあった: 子が始まったか取り下げたかを決めてから
        case "$(run_lock_abort_settle "$server_pid" "$ack")" in
            acked) stage=abort-acked ;;                                         # 子は始まっている
            stuck) kill -s KILL "$server_pid" 2>/dev/null ;;                    # 決まらない（止められた子など）: pid だけ
        esac
    fi
    case "$stage" in
        arg|token|group|tmp|mv)                                                 # 公開の前: pid だけ（G は無いか、子 1 人）
            kill -s KILL "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; child_reaped=1 ;;
        verify|verify-unreadable|signal)                                        # 公開の後で go の前: 確かめた -G、でなければ pid だけ
            if [ "$(lock_obs_kill0 pid "$server_pid")" = alive ] && [ "$(lock_obs_pgid handoff-group "$server_pid")" = "$server_pid" ]; then
                kill -s KILL -- "-$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; child_reaped=1
                lock_drain_group "$server_pid" 1                                # 長を確かめた後の G だけ排水する
            else
                kill -s KILL "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; child_reaped=1   # pid だけ。G は排水しない（I-10。D12／D5 は G が空でなければ deferred）
            fi ;;
        abort) wait "$server_pid" 2>/dev/null; child_reaped=1 ;;                # 子は ack を作らずに取り下げて終わった（すぐ返る）。排水しない（G は長 1 人）
        abort-acked) UP_PHASE=after-go ;;                                       # 子は始まっている: wait しない。trap が表 C の手続き（記録 t1）
    esac
    fail_up "handoff-failed stage=${stage%%-*}"                                # verify-unreadable → verify、abort-acked → abort（表 D の文面）
}

up_on_exit() {                                                                  # EXIT（fail_up の exit 1・INT／TERM の exit 130／143 を含む）
    [ "$UP_OK" = 1 ] && return 0                                                # 成功（status up）の後は何もしない（今のまま）
    if [ "$UP_PHASE" = after-go ]; then                                         # go の後と abort-acked: down と同じ手続き（表 C、記録 t1）
        up_reap_if_ended "$server_pid"                                          # Z・ESRCH の長を wait で回収して dead と読む（§2.4）
        down_procedure "$UP_STATE" t1                                           # 送ったら wait。D5 の結果は C′
        [ "$DOWN_STATUS" = stopped ] && st=failed || st=failed-server-left
    else                                                                        # go の前
        if [ -n "$server_pid" ] && [ "$child_reaped" != 1 ]; then              # 枝に来ずに終わる（INT／TERM）: 長は回収していない
            if [ -n "$RUN_LOCK_G" ]; then lock_stop_gate "$RUN_LOCK_G" "$server_pid"   # 公開の後: -G に TERM → 長を wait → 排水
            else kill -s KILL "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null; fi   # 公開の前: pid だけ
        fi
        run_lock_release "$run_id"                                              # D12 を 1 回（T0 は released、T1 は needs-head → 中で D5、読めなければ deferred）
        case "$RUN_LOCK_RESULT" in released|missing|none) st=failed ;; *) st=failed-lock-left ;; esac
    fi
    state_set "$UP_STATE" status "$st"                                          # 状態ファイルが無い（run dir を作る前の失敗）なら今のまま書かない
    remove_socket_dir …                                                         # 今の up_on_exit と同じ（failed-server-left は tmux だけ）
    rm -rf "$go" "$ack" 2>/dev/null                                             # 自分の go／ack だけ（子は回収済みか、go の後で exec 済み）
}
```

`run_lock_abort_settle <child> <ack>`（`run-lock.sh`。UAT と daily の `abort` の枝が呼ぶ）: `go` が既に在るので、子は次の確かめ（50ms）で `go` を見て `ack` を作って始まるか、自分で `go` を作った後の取り下げ（`ack` を作らず exit 75）で既に終わっているかのどちらか（`lock_child_wait`、F21）。そこで「`ack` が在る」→ `acked`、「子が ESRCH か `ps -o stat=` が `Z`」で `ack` が無い → `withdrew` を、短い期限（`HANDOFF_SETTLE_SEC`、数秒）まで 50ms ごとに見て返し、期限までにどちらにもならなければ `stuck`（呼び手は pid だけに KILL して `wait`）。`ack` を 1 回だけ見るのでは、子が `go` を見てから `ack` を作るまでの間に親が見た場合に `abort` と読み、始まったサーバーを `wait` し続ける（P2-1 の事象と同じ形）。`abort-acked` に来るのは、子が取り下げていないのに `go` が在った場合で、名前を run ごとにして fork の前に消した後は、親自身の `mkdir go` が `go` を作ってから失敗を返した場合（F22 の「それ以外で `go` が在る → `abort`」）だけ。`RUN_LOCK_RESULT` は `run_lock_release` が D12（needs-head の後は D5）の結果を置く変数（名前は実装で決めてよい。表 D の `release` と一致すること）。`UP_OK`・`UP_PHASE`・`child_reaped` は `cmd_up` の冒頭で空・`before-go`・`0` にする。

`go`／`ack` の名前に `run_id` を入れ、fork の前に消して無いことを確かめるのは、同じ run dir で `down` → `up` し直したとき（§4.4 の `:357-378` の新しい期待、PM 個別の決定の断る文面の手順）に前の `go` で子が公開の前に始まり（I-7 が破れる）、`up` が `abort` の `wait` で返らなくなるのを塞ぐため（上流の 4 回目、PM Claude P2-1）。daily は `mktemp -d` の新しいディレクトリなので当たらない。`env` → `nohup` → `bash` → `node` は同じ pid のまま exec するので、`server_pid`＝G の長＝記録の pid。`MACHINE_LOCK_SH` は絶対パスで渡す（`env -i` の後に環境から引かない）。試験の口は `env -i` と `nohup` の間の代入として渡り（`uat-yaml-2590` の「代入は `env -i` と最初の `nohup` の間」の検査に触れない位置）、子の `lock_child_wait`（止め所 `acked`・観測の注入）に届き、exec の前に `unset` するのでサーバーには残らない。本番では配列は空で、論理行の形は今と同じ。

**daily**（`npx tsx run.ts` の行を置き換える。pull と `npm install` の後。取得の後に `export CM_RUN_LOCK_TOKEN="$T0"` 済み）:

```bash
hand=$(mktemp -d "${TMPDIR:-/tmp}/cm-daily-hand.XXXXXX") || fail_sync "handoff-failed stage=arg"
go="$hand/go"; ack="$hand/ack"; deadline=$(( $(date +%s) + HANDOFF_WAIT_SEC ))
child=""; child_reaped=0
set -m
/bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; export CM_RUN_LOCK_TOKEN="$CM_RUN_LOCK_TOKEN-g$$"; shift 6; exec "$@"' \
    cm-daily-child "$PWD/scripts/lib/machine-lock.sh" "$go" "$ack" "$deadline" "$$" -- npx tsx scripts/agent-health/run.ts … </dev/null &
child=$!                                                                         # (A) forked
set +m
run_lock_set_pid "$T0" "$$" "$child" "$go" || daily_handoff_fail "$RUN_LOCK_STAGE"   # (C) 通れば go を作って 0（T1: pid＝daily、pgid＝子）
wait "$child"; code=$?; child_reaped=1                                           # (D) 通常の終わり・ack・child-exits
[ -z "$RUN_LOCK_G" ] || lock_drain_group "$RUN_LOCK_G" 0                         # (E) 回収の直後。空なら何も送らない

daily_handoff_fail() { # <stage>  — 失敗の枝。どれも取り下げの期限（30 秒）を待たない（KILL の後の wait はすぐ返る）
    local stage=$1
    if [ "$stage" = abort ]; then                                                 # go が既にあった: 子が始まったか取り下げたかを決めてから
        case "$(run_lock_abort_settle "$child" "$ack")" in
            acked) stage=abort-acked ;;
            stuck) kill -s KILL "$child" 2>/dev/null ;;                           # 決まらない: pid だけ
        esac
    fi
    case "$stage" in
        arg|token|group|tmp|mv)                                                   # 公開の前: pid だけ（G は無いか、子 1 人）
            kill -s KILL "$child" 2>/dev/null; wait "$child" 2>/dev/null; child_reaped=1 ;;
        verify|verify-unreadable|signal)                                          # 公開の後で go の前: 確かめた -G、でなければ pid だけ
            if [ "$(lock_obs_kill0 pid "$child")" = alive ] && [ "$(lock_obs_pgid handoff-group "$child")" = "$child" ]; then
                kill -s KILL -- "-$child" 2>/dev/null; wait "$child" 2>/dev/null; child_reaped=1
                lock_drain_group "$RUN_LOCK_G" 1                                  # 長を確かめた G だけ排水する
            else
                kill -s KILL "$child" 2>/dev/null; wait "$child" 2>/dev/null; child_reaped=1
                # pid だけ: 確かめていない -G には lock_drain_group でも送らない（I-10、上流の 4 回目 PM Claude P3-4）。
                # G が空でなければ (F) の D12 が deferred でロックを残す（安全側）
            fi ;;
        abort) wait "$child" 2>/dev/null; child_reaped=1 ;;                       # 子は ack を作らずに取り下げて終わった。G は長 1 人で、回収の後は排水しない
        abort-acked)                                                              # 子は T1 の下で始まっている: (D)・(E) と同じに終わりまで待って排水
            wait "$child" 2>/dev/null; child_reaped=1
            lock_drain_group "$RUN_LOCK_G" 0 ;;
    esac
    fail_sync "handoff-failed stage=${stage%%-*}"                                 # exit 2 → EXIT。verify-unreadable → verify、abort-acked → abort
}

daily_on_exit() {                                                                 # (F) EXIT（INT／TERM は exit 130／143 でここへ）
    if [ -n "$child" ] && [ "$child_reaped" != 1 ]; then                          # 長をまだ回収していない
        if [ -n "$RUN_LOCK_G" ]; then lock_stop_gate "$RUN_LOCK_G" "$child"       # -G に TERM → 長を wait → 排水
        else kill -s KILL "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi     # 公開の前: pid だけ
    fi                                                                            # 回収済みなら (E) で済んでいて、もう送らない
    run_lock_release "$T0"                                                        # 1 回だけ（F16）。G が空でなければ D12 は deferred
    [ -z "$hand" ] || rm -rf "$hand"
}
```

（関数の定義は実装では使う前に置く。上は読みの順。）`$$` は `bash -c` の単一引用符の中なので子の `bash` の pid＝G で、子は exec の直前に T1＝`<T0>-g<G>` を作る（土台 D9）。`run.ts` はそれを継ぐ（表 A `ts-inherit × own-other-g`）。stdin は `/dev/null`（`set -m` の下で端末から起こしたとき、背景のグループが端末を読んで SIGTTIN で止まり、G が生きたままロックが残るのを避ける。Claude 5 P3-C）。

表 D の各行が起きる所（daily ／ UAT）:

| 表 D | daily | UAT |
|---|---|---|
| `state-write` | 到達しない | (B) |
| `group`・`tmp`・`mv`（と表 E の `arg`。UAT は fork の前の `go`／`ack` の確かめの失敗も `arg` で、子は居ない） | (C) → `daily_handoff_fail`: pid だけ → `wait` → `fail_sync` → (F) で D12 `released` | (C) → `up_handoff_fail`: 同じ分け方 → `fail_up` の exit 1 → `up_on_exit` の go の前の枝が D12 `released` → `failed` |
| `token` | (C) → pid だけ → `wait` → (F) で D12 `deferred`（ロックは残る） | (C) → 同じ → D12 `deferred` → `failed-lock-left` |
| `verify`・`verify-unreadable`・`signal` | (C) → 確かめた `-G` → `wait` → `lock_drain_group`、確かめられなければ pid だけ → `wait`（排水しない）→ (F) で D12 | (C) → 同じ → `up_on_exit` が D12 needs-head → D5（`verify-unreadable` は `deferred` → `failed-lock-left`） |
| `abort` | (C) → `run_lock_abort_settle` が `withdrew` → 送らない → `wait`（排水しない）→ (F) | (C) → 同じ → `up_on_exit` が D12 needs-head → D5 |
| `abort-acked` | (C) → `run_lock_abort_settle` が `acked` → 子の終わりまで `wait` → `lock_drain_group` → (F) で D12 `released` | (C) → `UP_PHASE=after-go` → `fail_up` → `up_on_exit` の go の後の枝（表 C の手続き、記録 `t1`） |
| `ack`・`child-exits` | (D) の `wait` が回収 → (E) → (F) で D12 `released` | go の後の生死の判定・trap が `Z`・ESRCH の長を `wait` で回収 → 表 C `t1 × dead × none`（§2.4） |

子は pull の**後**の `machine-lock.sh` を読み、親は pull の**前**に読んだ版を使う。`go`・`ack`・期限・親の pid の約束は PR1a で決めた名前と意味で、版を跨いでも同じ（変えるときは版の跨ぎを設計する）。子の exit 75 は「取り下げた」で、daily は `handoff-failed stage=abort|ack` として扱う（表 D）。

### 4.6 文面

- **断る文面の頭は今と同じ `another run holds <dir> (`**（`run-server-3359.test.ts:410` が 8 者の競争で 7 件を数え、`daily-sh.test.ts:249` が `reason=run-locked:` を見る）。括弧の中は表 A の文面の種類で変わる: `held`→`pid N, label L, since T[, run_dir]`、`held-group`→`pid N gone, pgid G alive, label L …`、`ticket`→`ticket of pid N ahead`、`unknown`→`cannot tell: point=… path=… errno=…`、`corrupt`→`<lock>/owner has no pid= or token=: check and remove <lock> by hand`、`ownerless-young`→`no owner yet`、`ownerless-nonempty`→`no owner and not empty: <中身>: check and remove <lock> by hand`、`aside`→`a moved-aside record <name> is alive`（PM Claude P3-10）
- **UAT の `up` が断るとき**、記録に `run_dir=` があれば末尾に `; stop it with: scripts/uat/run-server.sh down --run-dir <run_dir>` を足す（PM 個別の決定）。T1 は T0 の `run_dir=` を引き継ぐ（§4.2）ので、生きた G の T1（`held-group`）でも出る。`down` がそれを確実に片付ける行は表 C の `t1` の行
- `corrupt`・`ownerless-nonempty` は PR1a-f で塞ぐまで消さず、上の文面で人に知らせる（PM 共通の決定 1）
- ゾンビ・host の変化・EPERM は表 D2 の文面

### 4.7 断片（PM 共通の決定 5）

- module-reference は PR ごとの名前: `dev-reports/module-reference/issue-4288-pr1b.md`（PR1c は `-pr1c.md`）
- `changelog.d/4288.md` は同じ Issue の 2 本目以降の work item の規則（`scripts/orchestrate/templates/fragment-rules.md` の `second-work-item`）: 既存の 1 項目へ統合し、1 本目の文を消さない。PR1b と PR1c のマージは直列

### 4.8 実装の契約への引継ぎ

- 表は閉じている（§2.8。行の追加は列挙の追加で、型が落ちる）。PM の決定（上流の 2 回目で表が閉じたら実装は sonnet、閉じなければ opus）の判断材料
- 実装の試験は `it.todo`（表 A の呼び手ごと 10 本と I-11 の 1 本・表 B の流れごと 2 本・表 C の 4 本〔`down`・`up` の trap・自分で終わった長の回収・`t1` × D5 の結果〕・表 D の流れごと 2 本と同じ run dir の `down` → `up` の 1 本（§4.4）・表 D2 の 1 本・表 E の 1 本）を `it.each` に置き換える。行の期待は変えない（変えるときは上流に戻す）。pid と G は別々に作る（生きた pid／ESRCH の pid に生きた G のメンバー、など。PM Claude P2-4）
- 表 B・C・D は実プロセスの試験で、#4288 の 1 番の台（`lock-4288-harness.ts`）と止め所（`CM_VERIFY_TEST_HANDOFF=pause:<stage>`）を流用できる。UAT の子へは §4.5 の試験の口の配列で `env -i` を越えて渡す（PM Claude P3-5）
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
2. **daily の EXIT で G を空にする** → 採る。長を `wait` で回収した通常の終わりは、回収の直後の `lock_drain_group`（空なら送らない。ゲート本体と同じ）、回収していない経路だけ長を `wait` する `lock_stop_gate`（1 回目の `run_gate_handoff` の指定は、待っていない長に使うと 7 秒後に失敗する。Claude 5 P2-5。上流の 3 回目で通常の終わりを分けた、Claude 5 P2-C）
3. **`stop-refused-group` の後の手順** → 文面だけ（残った pid と `CM_DB_PATH`）。`up` の断る文面は `down --run-dir` を名指す（PM 個別の決定）。`docs/user-guide/` には足さない（推奨のまま。変えるなら PM）

---

## 7. 本文に無い指摘（直さない）

- `scripts/orchestrate/machine-lock-sync.mjs:680-690` の `cleanupOwnGone` は自分の token の退避を G を見ずに消す（F5）。PR1b では届かない
- `.claude/skills/cmate-verify/scripts/verify-run.sh:1434-1449` の `lock_release_own_gone` は退避の G だけを見て、`pgid=` の無い退避を pid を見ずに消す（F15）。run-lock では退避が gone と判定された記録からしかできないので消してよい形に限られるが、3 実装の規則として pid も見るかは PR1a-f の候補
- `scripts/lib/machine-lock.sh:241` の `rm -rf` と `verify-run.sh:1986` は削除の失敗を見ずに `released` と答える（F13）
- `scripts/lib/machine-lock.sh:168-169` の kv の codec は呼び手の欄を `pgid=` の前に書く（F10）
- `verify-run.sh:1680-1685` の `LOCK_HELD_BY` は JSON の読みで、kv の記録では空になる（F3）
- `scripts/uat/run-server.sh:472` は `state_set server_pid` の失敗を見ない（F12。PR1b で直す側だが、今の develop の穴として記録）
- daily の通常の終わり (E) とゲート本体（`verify-run.sh:2406`）の `lock_drain_group` は、長を `wait` で回収した**後**に G へ送る。G に長以外のメンバーが残っていれば番号は再利用されないので正しいが、長しか居なかった G は回収の時点で空で、`kill -0 -G` までの間に番号が再利用されると他者のグループを非空と読んで送りうる（窓は小さい。上流の 4 回目で P3-4 を直すときに見つけた。PR1b は (E) の形を変えず、`abort` の枝では排水しないようにした。ゲート本体は PR1a の部品なので直さない）
- `scripts/uat/run-server.sh:479`・`:497` の「すぐ終わった」「LISTEN の前に終わった」の判定は 2 値の `run_lock_pid_alive` で、`up` の子のゾンビ（`kill -0` が通る）を生と読む（PR1b で §2.4 の規則に直す側。今の develop の穴として記録）
- PR1c の設計 `docs/design/supervisor-lock-machine-lock-4288.md:283`（`495872a60`）の §5.2 の契約の文は、§4.3 の引用と一字一句同じでない（`run_lock_pid_alive` の定義が今の実装とずれる）。PR1c の worktree は本書の契約の範囲外なので直さず、§4.3 の引用に差し替えるよう PM に渡す

---

## 8. 上流のレビューの処置

### 8.1 上流の 2 回目

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

### 8.2 上流の 3 回目（`pm-return-4288-pr1b-upstream2.md` の直す 1〜6）

直したのは設計の文と表のセルだけ。表の作り（列挙・型）は変えていない。表 C の `t1` × D5 の結果は、既存の列挙（`D5_RESULTS`・`Signals`・`DownCell`）の値で作った行で、`TABLE_C` の `t1` の D5 を呼ぶセルとちょうど一致することを試験で確かめる。

| # | 指摘 | 処置 | 場所 |
|---|---|---|---|
| 1 | 継承の `own-other`・`aside-own` を「到達しない」にしたが到達する（PM Claude P2-1・Claude 5 P3-B） | 1 回目の値に戻した: `own-other` は `In / Rc / ✕unknown`、`aside-own` は `In / Rl / ✕unknown`（TS と bash の両方）。到達の理由（既存の試験 2 本・デプロイの朝の旧い daily の T0・D8 の 2 つ目の文）を注 ³ と試験のコメントに書いた。§4.4 の「`run-lock-3359` は変わらない」と一致。狭めて塞ぐのは本番の呼び手が無い行だけ。行数は 697／323 → 734／311（表 C の 25 行を含む） | §2.2 注 ³、§2.8、F17、§4.4 |
| 2 | daily の子に T1 が渡らない・`go` を誰が作るか・公開の前の失敗の信号の宛先（PM Claude P2-2・Claude 5 P2-A） | 子が exec の直前に `CM_RUN_LOCK_TOKEN="$CM_RUN_LOCK_TOKEN-g$$"`。`run_lock_set_pid <T0> <pid> <pgid> <go>` が通ったら親が `mkdir go`（F22 の分け方）。失敗の枝 `daily_handoff_fail` は公開の前は pid だけ、公開の後は確かめた `-G`、`abort` は送らない。どれも KILL の後の `wait` で 30 秒待たない。表 D の各行が §4.5 のどの行で起きるかの表 | §4.5、§4.2、I-10 |
| 3 | 送らずに長が終わる経路（表 D の `ack`・`child-exits`）でゾンビを回収しない（Claude 5 P2-B） | `up` の trap と `up` の中の生死の判定は、`Z`・ESRCH の長を先に `wait` で回収してから表 C の手続き（`t1 × dead × none`）。表 D・D2・§3 の文と、試験の `stop-then-D5`・D2 の理由の文を揃えた | §2.4、表 D、表 D2、§3 |
| 4 | daily の EXIT の `lock_stop_gate` が空いた G に TERM（Claude 5 P2-C・PM Claude P3-2）、I-10「go の前」と表 D「公開の前」（PM Claude P3-3） | 通常の終わりは回収の直後に `lock_drain_group`（空なら送らない）、`lock_stop_gate` は回収していない経路だけ。I-10 を「公開の前は pid だけ、公開の後は全ての行で確かめた `-G`」に揃えた | §4.2、§4.5、I-10、§6-2 |
| 5 | 表 C の `t1` × D5 の `deferred`・`not-head`・`unknown` が C′ の対応表にしか無い（PM Claude 前回 P2-1 の残り・Claude 5 P3-A） | 表 C の行として持った: D5 を呼ぶ `t1` の 5 セル × D5 の結果 5（`deferred`・`not-head`・`unknown`・`kept`・`missing`）＝ 25 行。状態は C′ のとおり | §2.4、試験 `TABLE_C_T1_D5` |
| 6 | P3（PM Claude P3-1・P3-4〜P3-7、Claude 5 P3-C） | T1 は T0 の `label=`・`run_dir=` を引き継ぐ（§4.2）／旧い形かは状態ファイルの `lock_token` の有無で決める（§2.4）／試験の口は `env -i` と `nohup` の間の配列で渡し、子が exec の前に `unset`（§4.5）／`supervisor.sh:269` の `down` の exit 1 が増える（§4.4）／PR1c との契約の文を今の実装に合わせ、PR1c の §5.2 を同じ文に差し替える（§4.3・§7）／daily の子の stdin を `/dev/null`（§4.5） | 各節 |

### 8.3 上流の 4 回目（`pm-return-4288-pr1b-upstream3.md` の直す 1・2）

PM Claude `pm-review-4288-pr1b-upstream3-claude.md`（P1 0・P2 1・P3 5）。直したのは設計の文と表のセルで、表 D の列挙（`HANDOFF_FAILURES`）に `token`・`abort-acked` の 2 値を足した（型が落ちるので抜けない）。行数は 1135／734 → 1139／738（表 D 20 → 24）。

| # | 指摘 | 処置 | 場所 |
|---|---|---|---|
| 1 | P2-1 UAT の `go`／`ack` が run dir の固定の名前で、同じ run dir の `down` → `up` で前の `go` により子が公開の前に始まり（I-7）、`up` が `abort` の `wait` で返らない | 名前を `handoff-<run_id>.go`／`.ack`（`up` ごと）にし、**かつ** fork の前に `rm -rf` して無いこと（symlink も）を確かめ、確かめられなければ `stage=arg` で起こさない。表 D に `abort-acked`（`ack` が在る＝子は始まっている → `go` の後の扱い。UAT は表 C の手続き、daily は子の終わりまで待つ）。`abort` は `run_lock_abort_settle` で `ack` を待ってから決める（1 回だけ見ると `ack` を作る直前を取り逃す）。§4.4 に `:357-378` の続き（同じ run dir の 3 回目の `up`、前の run の `go`／`ack` を置いた形）の行 | §4.5、表 D、§4.4、§3、I-10 |
| 2-1 | P3-1 §2.4 の段落で表が切れた | 段落を記録の軸の表の後ろへ移した | §2.4 |
| 2-2 | P3-2 `token` の段が `HANDOFF_FAILURES` に無い | 足した: 公開の前・pid だけ・D12 `deferred`・ロックは残る。UAT `failed-lock-left`・1、daily sync の失敗・2（`verify-unreadable` と同じ扱い）。§7 の該当の行は閉じたので消した | 表 D、§4.5 手順 3、試験 |
| 2-3 | P3-3 `up_handoff_fail`・`fail_up` が名前だけ | daily と同じ粒度で本文を書き、状態の値を決める `up_on_exit`（go の前は D12 の結果、go の後は表 C の手続き）も書いた | §4.5 |
| 2-4 | P3-4 daily の pid だけの枝の後の `lock_drain_group` が確かめていない `-G` に送る | pid だけの枝では排水しない（D12 は G が空でなければ `deferred`）。`abort`（取り下げ）も回収の後に排水しない。UAT の `up_handoff_fail` も同じ。I-10 の「守る場所」と試験の型の注に書いた。(E) とゲート本体の同じ形の窓は §7 | §4.5、I-10、§7 |
| 2-5 | P3-5 `${!v+x}` が bash 3.2 で動くか | macOS の `/bin/bash` 3.2.57 で `set -u` の下でも、未設定・空・値ありを分けることを実行して確かめた（§9）。形は変えない | §4.5、§9 |

---

## 9. 確かめたこと・探した対

- 読んだもの（上流の 2 回目で読み直した）: `machine-lock.sh` の D12（`:190-257`）、`verify-run.sh` の `lock_group_state`・`lock_holder_state`・`lock_release_own_gone`・`lock_recover`・`lock_release_as_head`・`lock_child_wait`・ゲートの合図の分け方、`machine-lock-sync.mjs` の `release`、`run-server.sh` の `stop_recorded`・`up_on_exit`・`cmd_up` のサーバーの起動・`cmd_down`、`daily.sh` の取得から最後まで、`run-lock-3359.test.ts`・`run-server-3359.test.ts`・`daily-sh.test.ts`・`metrics-sh.test.ts`・`uat-yaml-2590.test.ts` の該当箇所、PR1c の設計（`commandmate-issue-4288-pr1c` の `f7fc6a837`）の読み込みの行
- 実行したもの: 試験の雛形（`npx vitest run` のこのファイルだけ。PM の今夜の負荷の決まりで広い vitest は走らせていない）、陽性の対照 3 つ（§2.8）、`npm run lint`・`npx tsc --noEmit`。サーバー・tmux・エージェント CLI・`~/.commandmate` には触っていない
- 探した対: `run_lock_*`・`acquireRunLock`・`CM_RUN_LOCK_*` の呼び手と、run-lock を固定する試験（`git grep`）は §4.4 の 5 本と `product/lib.sh`（PR1c）・`supervisor.sh:73` だけ。`docs/en` に run-lock の写しは無い。`src/cli/types/` にロックの型の写しは無い
- 未確認: `set -m` の下の `env -i … nohup … &` が macOS の bash 3.2 で子を新しいグループに置くこと（失敗しても表 D `group` で子は始まらない）、スケジューラ・launchd が daily を止めるときにグループへ送るか（PM Claude P3-12）、サーバーが環境を置き換えて起こした子が G に残るか（Claude 5 P3）
- 上流の 3 回目で読み直したもの: `verify-run.sh` の `lock_stop_gate`・`lock_drain_group`・`rga_handoff_fail`・`run_gate_handoff` の合図と失敗の枝・`lock_child_wait`・`lock_hand_off`・`lock_obs_pgid`、`machine-lock.sh` の `lock_format_owner`（呼び手の欄は `LOCK_OWNER_EXTRA` から）、`run-lock.sh` の `run_lock_pid_alive`（`:50-56`）・今の `run_lock_set_pid`（T0 の `label`・`run_dir` を書き直している）、`run-server.sh` の `cmd_up` のサーバーの起動（`own_home_env` の配列が `env -i` と `nohup` の間にある）と `:479`・`:497`、`daily.sh:88-141`、`supervisor.sh:262-270`、`uat-yaml-2590.test.ts:65-71`・`:187-193`、PR1c の §5.2（`495872a60` の `:283`）。実行したもの: この試験のファイルだけの `npx vitest run`・陽性の対照 3 つ（§2.8 の (4)〜(6)、os.tmpdir() の写しで）・`npm run lint`・`npx tsc --noEmit`
- 上流の 4 回目で確かめたもの（実行）: `/bin/bash` 3.2.57（`bash --version`）で `set -u; v=NAME; [ -z "${!v+x}" ]` が未設定で真・空の値で偽・値ありで偽、`a=(); "${a[@]+"${a[@]}"}"` が空で通る（§4.5 の試験の口の形）。`run_id` は `cmd_up` で `date -u +%y%m%d%H%M%S` と `$RANDOM` から作られ `up` ごとに新しい（`run-server.sh` の `cmd_up`）。`run-server-3359.test.ts` の「the next up cleans …」の 2 回目の `up` は別の `run2` で、3 回目は今は無い（§4.4 の足す行）。`lock_child_wait`（`verify-run.sh:2065-2078`）は `go` が在れば次の確かめで `ack` を作り、期限・親の死では自分で `go` を作って `ack` を作らずに 1 を返す（`run_lock_abort_settle` の前提）。実行したもの: この試験のファイルと `tests/unit/guards`・`tests/unit/docs` の `npx vitest run`、陽性の対照 (7)〜(9)（os.tmpdir() の写しで）、`npm run lint`・`npx tsc --noEmit`・`node scripts/changelog-fragments.mjs check`
- 探した対（上流の 3 回目）: 継承の行を固定する既存の試験（`git grep -n 'CM_RUN_LOCK_TOKEN' -- tests`）は `run-lock-3359.test.ts:89-97` と `run-server-3359.test.ts:430-433`で、どれも本書の表と一致する（`daily-sh.test.ts`・`metrics-sh.test.ts`・`uat-opencode-v1-files-4149.test.ts`・`run-server-3359.test.ts:72` は環境から消すか空にするだけ）。`down` の失敗を固定する試験は無い（`git grep 'stage down fail' -- tests` は 0 件）。`docs/en` に run-lock の写しは無い

---

## 10. 実装の契約で決めたこと・見つけたこと（赤から緑にした回）

設計の表を実装に当てて緑にした。表の行は 1 つを除いて変えていない。

- **表の誤り 1 点（上流へ戻す）**: 継承の `aside-own` × unknown は、上流の表では「断る・`<lock>` は変わらない」だったが、TS（`machine-lock-sync.mjs` の `settleGone`）も bash（`lock_settle_gone`）も、不明な持ち主の退避の記録を先頭が `<lock>` へ戻す（`aside-foreign` と同じ。土台 §2.7）。PR1a の部品なので PR1b は変えず、セルを `restored` に直した（§2.2 の注 ⁱ、試験の `TS_INHERIT`／`SH_INHERIT`）。
- **試験の口 2 つ**: `RUN_LOCK_HEAD_BUDGET`（`run_lock_release_as_head` の先頭になる待ちの秒数。既定 10。D5 の `not-head` の行を 10 秒待たずに試すため）、`acquireRunLock` の `kill`・`fault`（D10。観測の EPERM を注入する）。本番では使わない。
- **`lock_token` は引渡しの前に状態へ書く**（`server_pid` と同じ段、表 D `state-write`）: 公開の後に `up` が死んでも `down` が記録を T1 と読めるように。引渡しが公開の前に失敗した run では、状態の `lock_token` は記録にない token を指す（記録は T0 のまま）が、`down` は記録の token で読む。
- **macOS では、Apple 製のバイナリ（`/bin/bash`・`/bin/sleep`）の環境は `ps eww` に出ない**: 合図を待っている UAT の子（まだ exec していない `/bin/bash`）の `CM_DB_PATH` は読めないので、`down` はそれを `alive-unverified`（`stop-refused`）と読む（表 C の `t0-up-dead × alive-verified` の行は、環境が読める OS でだけその行になる。待っている子は親の死で自分から取り下げる）。`up` の `CM_DB_PATH` の確かめは、子が exec した後のサーバー（node）に対して働くので変わらない。G の残りの確かめ（`CM_DB_PATH` が run dir の下）も、Apple 製のバイナリが G に残るときは「確かめられない」になり消さない側に倒れる。
- **TS の `release()` は結果を返す**（`released`／`deferred`／`kept`／`none`。`needs-head` は pid≠`process.pid` の取得を断るので出ない）。呼び手（`main.ts`）は戻り値を使わない。
- **駆動した範囲**: 表 A の到達の 590 行すべて（TS は同一プロセスで、bash は 1 行 1 プロセスで）、表 E の到達 12 行、UAT の表 D は `group`・`token`・`tmp`・`mv`・`verify-unreadable`・`signal`・`abort`・`ack`・`child-exits` の 9 行、daily の表 D は `token`・`mv`・`signal`・`ack` と通常の終わり・TERM、表 B は UAT の `tmp`・`acked`（親を kill -9）、表 C は `down` の 13 行と `up` の trap（自分で終わった長を回収する）1 本（`t1`×{alive-verified×none／verified、dead×verified／unverified／unknown／none×D5 の unknown・not-head・deferred、alive-unverified}、`t0-up-alive`、`other`、`absent`、`old`）、表 D2 は取得の列と `down` の列の一部。**駆動していない行**: 表 D の `state-write`（`state_set` を外から失敗させられない）・`verify`（読み直せるが T1 でない記録）・`abort-acked`（親の `mkdir go` が `go` を作ってから失敗する形）と daily の残り、表 B の `published`・`signalled`（止め所が無い）と daily の列、表 C の `zombie`（Apple 製のバイナリ以外で長を zombie にする手段が試験に無い。D2 の `zombie × down` は作り物の状態ファイルで駆動した）・`t1 × D5 kept`（`other` の行が同じ経路）・`t1 × alive-verified × unknown`（`ps` の失敗を注入できない）、表 D2 の `uat-trap`・`daily-exit` の列。これらは実装に分岐としてあり、設計の文と一致するが、この回の試験は走らせていない。
