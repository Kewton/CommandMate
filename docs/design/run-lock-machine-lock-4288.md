# Issue #4288 PR1b: run-lock を machine-lock に載せる（上流の段: 設計の 4 つと試験の表）

- 状態: 上流の段（設計と試験の表だけ。`src/`・`scripts/`・既存の試験は変えない）。実装は、この表が上流のレビューで P2 0 になった後の「赤から緑にする」契約で行う（PM の依頼 `pm-brief-claude3-upstream-1111.md` の段 1・2）
- 対象: run-lock（`src/lib/agent-health/run-lock.ts`・`scripts/uat/run-lock.sh`・`scripts/uat/run-server.sh`・`scripts/agent-health/daily.sh`）を、PR1a（#4309、develop `b57c2aba6`）でマージ済みの machine-lock（`scripts/lib/machine-lock.sh`・`scripts/orchestrate/machine-lock-sync.mjs`・`.claude/skills/cmate-verify/scripts/verify-run.sh` のロックの節）に載せる部分だけ。supervisor.lock は PR1c（別の上流の段）
- 土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) の §1（D1〜D12）・§1.8・§1.9・§1.11・§1.14（D12 の不変条件）・§7。本書はそれを**置き換えない**。D 番号・§1.14 の表はそのまま引く
- 行番号は develop `b57c2aba6` のもの。名前で引くこと
- 表記: **事実**＝コードを読んで（または実行して）確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 試験の表: [`tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts`](../../tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts)（§2 の 3 表を列挙から作り、`satisfies Record<…>` で足し忘れを型で落とす。§1 の不変条件を全行に当てる。実装を呼ぶ所は `it.todo`）

## 結論（一覧）

| 段 | 中身 | 節 |
|---|---|---|
| (a) 不変条件 | 11 本（I-1〜I-11）。消すのは 3 つの経路だけ・不明は空きと読まない・needs-head は D5・bash は main シェル・自己グループの例外は使わない・引渡しは自分の T0 から・子は合図の後だけ・token と欄の字・down は確かめた G だけに送る ほか | §1 |
| (b) 状態と遷移の表 | 表 A（記録の形 14 × 呼び手 8 × 観測 3 = **336 行**）、表 B（D9 の段 6 × 流れ 2 × 事象 2 = **24 行**、review-4288h P2-2）、表 C（UAT `down`: 長 4 × 残り 4 = **16 行**、同 P2-3）。**計 376 行**（到達できる 311 行・呼び手の無い 65 行） | §2 |
| (c) 失敗の倒れ方 | kill -0・ps・mv・rm・rmdir・mkdir・owner の作成・ln・fs の一覧・tmux・時計の失敗を、消す側／消さない側で 1 表に。消す側に倒れるのは 2 か所（rm の部分失敗→owner の無い `<lock>` が 60 秒後に先頭に消される・TS の `rmSync` の例外）で、どちらも「他者のロックを消す」には倒れない | §3 |
| (d) PR の切り方 | PR1b を 1 本（TS と bash を分けると develop に新旧混在の期間を作る）。引数で拒否するもの 6 つ（token の字・欄の改行・引渡しの pid とサブシェル・TS の handOff を出さない・回収だけの操作を出さない・D5 の呼び手を `down` と trap に限る） | §4 |

review-4288h の残り（P2 3・P3 1）は §5 で閉じた。PM に決めてほしいことは §6 の 3 つ（どれも止める条件ではない）。

---

## 0. 前提の確かめ（事実。この段で読んだもの）

土台の設計と PR1a の実装を突き合わせて、本書が依る事実と、土台の文と違っていた点。

| # | 事実 | 場所 | 本書での扱い |
|---|---|---|---|
| F1 | 停止の猶予 `KILL_GRACE_SEC=5` は節の中にある（節は `:591` の `# --- machine-wide gate lock` から）。読み込み口のヘッダもそう書く | `verify-run.sh:611`、`machine-lock.sh:29-31` | review-4288h P2-1 は PR1a で閉じている（§5） |
| F2 | bash の取得の owner の pid は `${LOCK_OWNER_PID:-$$}`、token は `LOCK_WANT_TOKEN`（空なら `$$-<秒>-<乱数>`） | `verify-run.sh:1620`、`:1549-1553` | run-lock.sh の包みは `LOCK_OWNER_PID=<pid 引数>`・`LOCK_WANT_TOKEN=<token 引数>` で呼ぶ |
| F3 | 取得に失敗したときの `LOCK_HELD_BY` は JSON の欄の読み（`lock_owner_field`）で作る。kv の記録では空になり、札の先頭・退避・不明の文面に落ちる | `verify-run.sh:1680-1685`、`:719` | 文面（`another run holds <dir> (pid N, label L, since T…)`、`run-server-3359.test.ts:410` が固定）は PR1b の `run_lock_holder` が kv から作る（土台 §1.14 の「held by の表示」のとおり） |
| F4 | 退避の名前は `<lock>.gone-<取得者の token>-<連番>` で、読み手は接尾辞が `[A-Za-z0-9-]` だけのものしか読まない | bash `:1461`・`:1278`、sync `:630`・`:704`・`:129` | 取得者の token に `.`・`_`・`/`・空白があると、戻せなかった退避が**誰にも見えなくなる**（保有中と読まれない）。I-8 で token の字を限り、引数で拒否する（§4） |
| F5 | 同期 JS の `cleanupOwnGone` は自分の token の退避を G を見ずに消す。bash の `lock_release_own_gone` は G が空でなければ残す | sync `:680-690`、bash `:1434-1449` | TS の run-lock は pgid を書かない（D9 は bash だけ）ので PR1b では届かない。§7 に記録 |
| F6 | 同期 JS の取得は `mkdir` の不明・owner の作成の失敗・札の `link` の失敗で**例外を投げる**。今の `acquireRunLock` は投げずに `{ ok: false }` を返す | sync `:450-453`・`:474-476`・`:392`・`:805`、`run-lock.ts:160-163` | TS の包みは例外を捕まえて `{ ok: false, error }` にする（API の形を変えない。§3・§4） |
| F7 | macOS の `/bin/bash` は 3.2.57 で `BASHPID` が無い（実行して確かめた: `${BASHPID:-none}` → `none`） | — | daily の子は `( … ) &` のサブシェルでなく `bash -c` で起こし、自分の pid を `$$` で知る（T1＝`<T0>-g$$` を exec の前に作る、土台 D9） |
| F8 | `stop_recorded` は記録の pid が生きていなければ「止めた」と同じ 0 を返す | `run-server.sh:110-112` | 長だけが死んで G の子が残ると、今の形では `down` が「停止完了」と読む（review-4288h P2-3）。表 C で決める |
| F9 | 既存の試験は bash の取得に `$$` でない pid を渡す（`run_lock_acquire uat <node の pid> sh-token /r`）。期待は exit 0 | `run-lock-3359.test.ts:114-121` | 取得の pid 引数は `$$` 以外も受ける（拒否すると既存の期待が変わる）。代わりに**引渡し**を「記録の pid が `$$`」に限る（I-6） |
| F10 | kv の codec は呼び手の欄（`LOCK_OWNER_EXTRA`）を `pgid=` の行の**前**に書き、読みは各鍵の最初の行を取る | `machine-lock.sh:168-169`、`:146-150` | `run_dir`・`label` に改行と `pgid=…` を入れると、本物より先の偽の `pgid=` が読まれる（数でなければ不明＝誰も回収できない）。I-8 で欄の改行を引数で拒否する |
| F11 | D5（`lock_release_as_head`／`releaseAsHead`）は退避を片付けない（`settleGone` を呼ばない）。owner の無い `<lock>` は `missing` で、canonical を消さない | bash `:1955-2003`、sync `:1109-1131` | 表 A の D5 の列 |
| F12 | UAT の `up` は今も `state_set … server_pid` を `run_lock_set_pid` の**前**に書く | `run-server.sh:472-473` | この順を I-6 の条件にする（`down` が T1＝`<run_id>-g<server_pid>` を名指せる） |
| F13 | D12・D5 の削除は `rm -rf … 2>/dev/null \|\| true` で、失敗しても `released` と答える。同期 JS は `fs.rmSync` で、失敗は例外 | `machine-lock.sh:241`、`verify-run.sh:1986`、sync `:930`・`:1127` | §3 の rm の行。§7 に記録 |
| F14 | 壊れた記録（`pid=` か `token=` が無い owner）は、新しい取得では回収されない（記録でないので保有者の判定に入らない）。今の bash は `pid` が空なら即 stale、今の TS は owner の無いものと同じく 60 秒で取る | sync `:981-984`、bash `:1660`（`LOB_CLASS = record` のときだけ判定）、`run-lock.sh:75-83`、`run-lock.ts:106-111` | 振る舞いが変わる（取れる側→取れない側）。表 A の `corrupt` は全呼び手で「消さない・取らない」。§6 の判断 1 |

食い違い: 土台 §1.14 の「操作の終状態」の `UAT の長だけが死に G の子が残る（P2-3）` は「`down` の状態の表示と残った G の止め方は PR1b で決める」としていた。本書 §2.4（表 C）がそれ。土台の他の文と実コードの食い違いは見つからなかった。

---

## 1. (a) 不変条件

PR1a の D12（土台 §1.14）を土台に、run-lock のどの経路でも成り立つ文。表 A〜C の各行は、試験のファイルでこの文に当てて確かめる（I-1・I-2・I-3・I-6・I-7・I-10 は行ごとの検査がある）。

| # | 不変条件 | 根拠（事実）と、守る場所 |
|---|---|---|
| **I-1 消す経路は 3 つ** | canonical の `<lock>` を消すのは次の 3 つだけ: (i) **持ち主自身の解放**（D12）: 記録の token が自分のもので、記録の pid が呼び手自身（TS は `process.pid`、bash は main シェルの `$$` で `kill -0 $$` が alive）、かつ記録に `pgid=` があればその G が空。(ii) **先頭としての解放**（D5）: 札の先頭で、記録の token が渡された自分の token のどれかで、保有者の判定（pid、`pgid=` があれば G も）が `gone`。(iii) **先頭の回収**: 札の先頭が、保有者が `gone` の記録を退かしてから token を確かめて消す／owner が無く空で 60 秒を超えた `<lock>` を `rmdir` する（D3）。missing・corrupt・不明・他の token の記録は、どの解放でも消さない | D12 `machine-lock.sh:198-257`・sync `:906-940`、D5 `verify-run.sh:1955-2003`・sync `:1109-1131`、回収 `:1459-1489`・sync `:703-731`、D3 `:1501-1535`・sync `:487-504`。表 A の `after = removed` の行は (i)(ii) のどちらかに当たる（試験の `removalAllowed`） |
| **I-2 不明は空きと読まない** | 観測が不明（ESRCH でない kill -0 の失敗・読めない owner・一覧の失敗）のとき、取らない・継がない・消さない・引き渡さない。不明は `refused`／`deferred`／`kept`／`unknown`／`refused-arg` のどれかで、後の先頭に残す | 3 値の観測（`verify-run.sh:848-857`、sync `:153-161`）。D10 で TS も 3 値（`isAlive` を渡されたときだけ 2 値）。表 A の `obs = unknown` の全行を試験で確かめる |
| **I-3 needs-head は D5、再試行も D5** | 解放が `needs-head` を返したら、呼び手は同じ実行の中で D5（`releaseAsHead(lockPath, [T0, T1])`／`lock_release_as_head <lock> <queue> 10 <T0> <T1>`）を呼ぶ。`deferred`・`not-head`・`unknown` は消さずに残し、保有者（pid と G）が死んだ後に次の先頭か D5 の再実行が消す。`lock_release_held`／`release` を 2 度呼ばない（2 度目は何もしない） | 土台 §1.14 の「needs-head を受けた呼び手の扱い」「deferred を受けた後の再試行も D5」。TS の包みは `release()` の中で needs-head を受けたら `releaseAsHead` を 1 回呼ぶ（呼び手の main.ts は今のまま `lock.release()` を呼ぶだけ） |
| **I-4 bash の呼び手は main シェル** | `run_lock_acquire`・`run_lock_set_pid`・`run_lock_release`（D12）・D5 は main シェル（`BASH_SUBSHELL=0`）から呼ぶ。サブシェルからの解放は D12 が `needs-head` にし（`machine-lock.sh:240`）、引渡しは包みが拒否する（I-6）。1 つのシェルが持つ run-lock は 1 つ（土台 §1.7） | 今の呼び手（`daily.sh:92-97`、`run-server.sh:412`・`:417`・`:534`・`:567-573`）はどれも main シェル。`run_lock_dir` の `$(…)` はパスを作るだけ |
| **I-5 自己グループの例外は使わない** | D12 の例外（記録の pid と `pgid` がどちらも呼び手自身なら G を判定しない、土台 §1.14）は、子をすべて待つ呼び手（merge-pr）だけのもの。run-lock はその形の記録を作らない: daily の T1 は pid＝`daily.sh`・pgid＝子の G（pid ≠ pgid）、UAT の T1 は pid＝pgid＝サーバーで呼び手（`up`・`down`）ではない。背景の子は必ず別のグループ G（D9）で持ち、G が空になるまで記録は死なない | `machine-lock.sh:229`、sync `:910`。試験: 表 A の `own-self-g` で G が生きていれば `deferred`（例外が効かない） |
| **I-6 引渡しは自分の T0 から、仕事の前に** | `run_lock_set_pid`（D4）は、owner を 1 回読んで「token が T0・記録の pid が `$$`・main シェル・`kill -0 $$` が alive」のときだけ `lock_hand_off` を呼ぶ。token が T0 でなければ `stage=token`、pid が `$$` でない・サブシェル・自分が alive と示せなければ `refused-arg`（何も書かない）。T1＝`<T0>-g<G>`。UAT は `server_pid` を状態ファイルへ書いてから引き渡す（F12） | この条件で、退避の中に**生きた自分の token の記録**ができる経路が無くなる: 回収者が退かすのは `gone` と判定した記録だけで、判定と `mv` の間に記録を書き換えられるのは持ち主自身（引渡し）だけ、持ち主自身の pid の記録は `gone` と判定されない。`own-other`（pid ≠ `$$`）の T0 を引き渡すと、pid の死で回収者が T0 を退かした直後に T1 が公開され、戻しの失敗で T1 の記録が退避に残りうる（F5 の `cleanupOwnGone` と合わさると G の生きた記録を消しうる）。だから `own-other` の引渡しは引数で拒否する（表 A `sh-hand-off/own-other`） |
| **I-7 子は合図の後だけ働く** | 保護する実作業（UAT のサーバー、daily の `run.ts`）は、自分のグループ G の長として起こされ、`go` を見て `ack` を作るまで exec しない。親が死んだ・期限を過ぎたら自分で `go` を作って取り下げる（先に `go` を作った方が勝つ）。`go` は T1 の読み直しが通った後にだけ親が作る | `lock_child_wait`（`verify-run.sh:2065-2078`）。表 B: 公開（`published`）より前は記録が T0（G を名乗らない）なので親の死の後に次の先頭が回収してよい。子は始まらない（P2-2） |
| **I-8 token と欄の字** | token は `[A-Za-z0-9-]+`（退避の名前に入るため、F4）。`label`・`run_dir` は改行を含まない（kv の行の注入、F10）。外れたら取得しない（TS は `{ ok: false }`、bash は `RUN_LOCK_ERROR` で 1） | 今の token: `run_id`（`run-server.sh:411`）・`daily-$$-…-$RANDOM`（`daily.sh:91`）・`cleanup-$$-$RANDOM`（`:566`）・TS の既定 `<label>-<pid>-<16 進>`（`run-lock.ts:153`）。どれも字の中。TS の既定は label の字を `-` に置き換えて作る（label は表示の欄で、字を限らない） |
| **I-9 保有区間は重ならない** | 異なる token の保有区間は重ならない（土台 §1.8 の「守る条件」(1)〜(6) をそのまま受け継ぐ。前提も同じ: 先頭が 2 つの syscall の間で 60 秒より長く止まらない） | 取得・回収・`rmdir` は札の先頭 1 人（`verify-run.sh:1544-`・sync `:833-1012`）。本書の追加（I-6・I-7・I-10）はこの条件の前提（保有者の死は単調、token と記録の中身が 1 対 1）を崩さない |
| **I-10 down は確かめた G だけに送る** | `down` が G に信号を送るのは、(1) 長（サーバー）が生きていて、今の確かめ（`CM_DB_PATH` が run dir の下・port の LISTEN が長だけ・`ps -o pgid=` が G）を通ったとき、または (2) 長が死んでいて、G の残りの**全員**の `CM_DB_PATH` が run dir の下のときだけ。どちらでもなければ何も送らず、ロックを残し、状態を `stop-refused-group`・exit 1 にする（「停止完了」と書かない） | (1): 長が G の中で生きている間、G の番号は再利用されない（グループに 1 人でも居る間はその番号は使われる）ので、長を確かめた時点の G の残りは長の子孫（見立て。setpgid は同じセッションの中でしかできない）。(2): 長が死んだ後は、G が一度空になって番号が新しい長に再利用されうるので、残りを 1 人ずつ確かめる（P2-3） |
| **I-11 1 つの run-lock に 1 つの実装** | TS と bash は同じ `<lock>`・`<lock の .lock を外した名>.queue`・`<lock>.gone-*` を、同じ規則（札・先頭だけの回収・退かしてから確かめる・3 値）で扱う。表 A の取得と継承の列は TS と bash で同じセル | 試験: `TABLE_A['ts-acquire']` と `['sh-acquire']`、`['ts-inherit']` と `['sh-inherit']` が等しい |

全経路で成り立つ理由（経路 → 効く不変条件）:

| 経路（土台 §1.8 の行） | 効く不変条件 |
|---|---|
| `main.ts` の取得・解放・signal | I-1 (i)（pid は `process.pid`）・I-2・I-8・I-9。signal・`kill -9` は解放しない→次の先頭が (iii) で回収 |
| `daily.sh` の取得・引渡し・子・EXIT・INT／TERM | I-4（main シェル）・I-6（T0 の pid は `$$`）・I-7（子は `go` の後）・I-5（pid≠pgid）・I-1 (i)（G が空のときだけ）・I-3 |
| `run.ts` の継承 | I-2（不明は継がない）・D8（土台）。`own-other-g` の `gone` は到達しない（継ぐ者は G の中） |
| UAT `up` の取得・引渡し・失敗の trap | I-6・I-7・I-1 (i)（T0 の記録＝`up` 自身）／(ii)（T1 の記録＝サーバーは needs-head→D5）・I-3 |
| UAT `down` | I-10・I-1 (ii)・I-3 |
| UAT `cleanup` | I-1 (i)・I-4。G が生きた T1 が残っていれば取得を断る（表 A `sh-acquire/foreign-g/alive`） |

---

## 2. (b) 状態と遷移の表

### 2.1 列挙

**記録の形（14）**。「own」は token が呼び手のもの（T0・T1・継承の token）。

| 形 | 中身 | 観測するもの（3 値の意味） |
|---|---|---|
| `none` | `<lock>` も退避も前の札も無い | 退避の候補の一覧（`list-root`）。alive・gone は「見えた」、unknown は一覧の失敗 |
| `ticket-ahead` | `<lock>` は無く、他者の札が前に居る | 札の持ち主（`ticketRetirable`: ESRCH なら札を外す） |
| `ownerless-young` | owner の無い空の `<lock>`、mtime ≤ 60 秒 | owner・一覧・mtime の観測。alive・gone は「見えた」 |
| `ownerless-old` | 同じで 60 秒を超える | 同上（`rmdir` の失敗も unknown） |
| `unreadable` | owner が読めない（EIO・EACCES・数でない `pgid=`） | なし（3 値とも同じセル） |
| `corrupt` | owner は読めたが `pid=` か `token=` が無い | なし（3 値とも同じセル） |
| `own-self` | 自分の token・記録の pid が呼び手自身・`pgid=` 無し | bash: `kill -0 $$`。TS: 観測しない（alive の行だけが到達する） |
| `own-self-g` | 自分の T1・pid が呼び手自身・`pgid=G`（daily の引渡しの後） | 解放: G（`kill -0 -G`）。D5・継承: 保有者の判定（pid、ESRCH なら G） |
| `own-other` | 自分の token・pid が呼び手でない・`pgid=` 無し（TS の `pid` 指定、bash の `$$` でない pid 引数、継ぐ者から見た T0） | 記録の pid |
| `own-other-g` | 自分の T1・pid が呼び手でない・`pgid=G`（UAT の T1＝サーバー、継ぐ者から見た daily の T1） | 解放: G（UAT は pid が G の長なので G が空なら pid も死）。D5・継承: 保有者の判定 |
| `foreign` | 他の token・`pgid=` 無し（`host=` の無い旧い記録を含む） | 保有者の判定（pid） |
| `foreign-g` | 他の token・`pgid=` あり | 保有者の判定（pid、ESRCH なら G） |
| `aside-own` | `<lock>` は無く、自分の token の退避 `<lock>.gone-*` がある | 取得・継承・D5 以外の解放: 退避の記録の保有者の判定。bash の解放: 退避の G（`lock_release_own_gone` は G だけを見る） |
| `aside-foreign` | `<lock>` は無く、他の token の退避がある | 退避の記録の保有者の判定 |

**呼び手（8）**: `ts-acquire`（`acquireRunLock`、継承の token 無し）・`ts-inherit`（同、`CM_RUN_LOCK_TOKEN` あり。D8）・`ts-release`（handle の `release()`。needs-head なら中で `releaseAsHead`）・`sh-acquire`（`run_lock_acquire`）・`sh-inherit`（同、`CM_RUN_LOCK_TOKEN` あり）・`sh-release-held`（D12 `lock_release_held`）・`sh-hand-off`（`run_lock_set_pid`→`lock_hand_off`、I-6 の確かめつき）・`sh-release-as-head`（D5）。

**観測（3）**: `alive`・`gone`（ESRCH）・`unknown`（それ以外の失敗）。

**結果**: 取得系 `acquired`・`recovered-acquired`（死んだ記録を退かして確かめて消してから取った）・`expired-acquired`（D3）・`reclaimed-acquired`（死んだ退避を消してから取った）・`refused`・`inherited`。解放系 `released`・`needs-head`・`deferred`・`kept`・`missing`・`unknown`・`not-head`。引渡し `handed`・`stage-token`・`refused-arg`。後の `<lock>`: `mine`・`removed`・`unchanged`・`restored`（生きた退避を戻した）・`aside-removed`（自分の退避だけ消した）・`t1`。次: `D5`（needs-head）・`next-head`（残して次の先頭へ）。

### 2.2 表 A: 記録の形 × 呼び手 × 観測 → 結果（336 行）

セルは `alive / gone / unknown` の順。`—` は呼び手の無い組み合わせ（理由は下の注と試験の `never(…)`）。後の `<lock>` は括弧、次は `→`。TS と bash の取得・継承は同じ列（I-11）。

| 形 ＼ 呼び手 | 取得（ts-acquire・sh-acquire） | 継承（ts-inherit・sh-inherit） | ts-release | sh-release-held（D12） | sh-hand-off | sh-release-as-head（D5） |
|---|---|---|---|---|---|---|
| `none` | acquired(mine) / acquired(mine) / refused | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | missing ×3 |
| `ticket-ahead` | refused / acquired(mine) / refused | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | not-head→next / missing / not-head→next |
| `ownerless-young` | refused ×3 | 取得と同じ | kept ×3 | kept ×3（canonical を消さない） | stage-token ×3 | missing ×3（消さない） |
| `ownerless-old` | expired-acquired(mine) ×2 / refused | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | missing ×3 |
| `unreadable` | refused ×3 | refused ×3 | deferred→next ×3 | deferred→next ×3 | stage-token ×3 | unknown→next ×3 |
| `corrupt` | refused ×3（F14） | refused ×3 | kept ×3 | kept ×3 | stage-token ×3 | kept ×3 |
| `own-self` | — ×3 ¹ | — ×3 ² | released(removed) / — ³ / — ³ | released(removed) / needs-head→D5 / deferred→next | handed(t1) / refused-arg / refused-arg | deferred→next / released(removed) / deferred→next |
| `own-self-g` | — ×3 ¹ | — ×3 ² | — ×3 ⁴ | deferred→next / released(removed) / deferred→next | stage-token ×3 | deferred→next / released(removed) / deferred→next |
| `own-other` | — ×3 ¹ | inherited / recovered-acquired(mine) / refused | needs-head→D5 ×2 / deferred→next | needs-head→D5 ×2 / deferred→next | refused-arg ×3（I-6） | deferred→next / released(removed) / deferred→next |
| `own-other-g` | — ×3 ¹ | inherited / — ⁵ / refused | — ×3 ⁴ | deferred→next / needs-head→D5 / deferred→next | stage-token ×3 | deferred→next / released(removed) / deferred→next |
| `foreign` | refused / recovered-acquired(mine) / refused | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | kept ×3 |
| `foreign-g` | refused / recovered-acquired(mine) / refused | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | kept ×3 |
| `aside-own` | — ×3 ¹ | inherited / reclaimed-acquired(mine) / refused | kept(aside-removed) ×3 | kept / kept(aside-removed) / kept | stage-token ×3 | missing / missing(aside-removed) / missing |
| `aside-foreign` | refused(restored) / reclaimed-acquired(mine) / refused(restored) | 取得と同じ | kept ×3 | kept ×3 | stage-token ×3 | missing ×3 |

注（呼び手の無い組み合わせ、計 52 行）: ¹ 取得の token は毎回新しいので、自分の token の記録は取得の前に無い（5 形 × 3 × TS・bash＝30）。² 継ぐ者は記録の pid ではない（2 形 × 3 × 2＝12）。³ Node は自分の pid を観測しない（`process.pid` は呼び手そのもの。sync の `release` は pid の一致だけを見る、`:910`〜`:930`）（2）。⁴ TS は `pgid` を書かない（6）。⁵ 継ぐ者は G の中に居るので、記録の pid と G がともに ESRCH にはならない（2）。

読み方の要点（事実は §0 と §3 の file:line）:

- **D12 が消すのは `own-self` の alive と `own-self-g` の gone だけ**（I-1 (i)）。`own-other`・`own-other-g` は生きていても死んでいても needs-head（G が生きていれば deferred）で、D5 に回る（I-3）
- **D5 が消すのは own の 4 形の gone だけ**（I-1 (ii)）。D5 は退避を片付けないので（F11）、`ownerless-*` は `missing` で canonical を残し、次の先頭が D3 で消す
- **引渡しが書くのは `own-self` の alive だけ**（I-6）。`own-other` は引数で拒否（`refused-arg`）、`own-self-g`（2 度目の引渡し）・他の形は `stage-token`
- **`ticket-ahead` の `gone`** は札が外れて先頭になれる行（取得は `acquired`、D5 は `missing`）
- **`aside-foreign` の alive・unknown** は先頭が退避を `<lock>` へ戻し（`restored`）、その回は取らない（§2.7 の土台の規則）

### 2.3 表 B: D9 の引渡しの段 × 流れ × 事象（24 行、review-4288h P2-2）

段は `verify-run.sh` の受け渡しと同じ止め所: `forked`（子を G の長として起こした）→ `group`（`ps -o pgid=` で G を確かめた）→ `tmp`（`.owner-T1` を書いた、`mv` の前）→ `published`（`mv` と読み直しが通った、`go` の前）→ `signalled`（`go` を作った）→ `acked`（子が `ack` を作って exec した）。事象は「親（`up`・`daily.sh`）だけを `kill -9`」と「G の長だけが終わり、G の他のメンバーが残る」。

| 段 | 事象: 親だけ `kill -9` | 事象: 長だけ終わり、メンバーが残る |
|---|---|---|
| `forked`・`group`・`tmp` | 記録 **T0**（pid＝親、`pgid=` 無し）。子は始まらない（親の死で取り下げ）。別の取得者は G に待ちの子が居る間も**取れる**（親が死んだ T0 は正当に回収される。子は `go` を自分で作って exec しない）。G が空の後も取れる | —（`ack` の前の G は待っている長 1 人だけ） |
| `published` | 記録 **T1**（`pgid=G`）。子は始まらない。G に待ちの子が居る間は**断られる**、子が取り下げて G が空になったら取れる | — |
| `signalled` | 記録 T1。子は始まる（`go` は親が作った）。G が生きている間は断られ、空になったら取れる | — |
| `acked` | 同上 | 記録 T1。子は始まっている。長が死んでも G のメンバーが居る間は断られる（UAT: 記録の pid＝長は ESRCH だが G が生きている＝pgid の判定を試す行。daily: 記録の pid＝`daily.sh` も生きている）。G が空になったら取れる（daily は EXIT が G を空にして D12 で消す） |

UAT と daily はセルが同じで、違うのは T1 の記録の pid（UAT はサーバー＝G の長、daily は `daily.sh`）。「UAT は記録の pid がサーバーなので、親を殺すだけでは pgid の判定を試せない」（P2-2 の後半）は、`acked × 長だけ終わる` の行が受け持つ（長＝サーバーを終わらせ、同じ G の子を残す）。

### 2.4 表 C: UAT `down` — 長 × G の残り（16 行、review-4288h P2-3）

`down` は状態ファイルの `run_id`（T0）・`server_pid`（G）・`lock_token`（T1。無ければ `<run_id>-g<server_pid>` を作る。F12・I-6）を読み、D5 に `T0 T1` を渡す。

| 長（`server_pid`） ＼ G の残り | `none`（ESRCH） | `verified`（全員の `CM_DB_PATH` が run dir の下） | `unverified`（1 人でも違う・読めない） | `unknown`（`kill -0 -G`・`ps` が言えない） |
|---|---|---|---|---|
| `alive-verified`（今の確かめを通る＋`ps -o pgid=` が G） | 長に TERM → D5 released、`stopped`、0 | 長に TERM → G を `lock_drain_group` の順で空に → released、`stopped`、0 | 同左（長を確かめた時点の G は run のもの、I-10 (1)） | 長に TERM → G を空と示せない → ロックを残す、`stop-refused-group`、1 |
| `alive-unverified` | 何も送らない・残す・`stop-refused`・1（今のまま） | 同左 | 同左 | 同左 |
| `dead`（`stop_recorded` は今 0 を返す、F8） | 何も送らない → D5 released、`stopped`、0 | G だけを空に → released、`stopped`、0（I-10 (2)） | **何も送らない・残す・`stop-refused-group`・1**（残った pid を文面に出す） | 同左 |
| `unrecorded`（`up` が `server_pid` を書く前に死んだ） | 何も送らない → D5(T0) released（記録は `up` の T0、`up` は死んでいる）、`stopped`、0 | —（G を名指せない） | — | — |

`stop-refused-group` の後の扱い: ロックは G が空になるまで保護中（I-9）。G が空になった後に `down` をもう一度呼ぶか、次の取得者の先頭が回収する。`cleanup` は G が生きている間は取得を断る（表 A `sh-acquire/foreign-g/alive`）ので、生きた子を止めない。人が G の残りを確かめて止めるときの手順を `docs/user-guide/` に書くかは §6 の判断 3。`up` の失敗の trap も同じ規則（`go` の前は G＝待っている自分の子だけなので直に KILL、`go` の後は `stop_recorded` の確かめを通ったときだけ G を空にする。通らなければ今の `failed-server-left`）。

### 2.5 行数

| 表 | 列挙 | 行 | 呼び手の無い行 | 到達する行 |
|---|---|---|---|---|
| A | 形 14 × 呼び手 8 × 観測 3 | 336 | 52 | 284 |
| B | 段 6 × 流れ 2 × 事象 2 | 24 | 10 | 14 |
| C | 長 4 × 残り 4 | 16 | 3 | 13 |
| 計 | — | **376** | 65 | **311** |

試験のファイルはこの数を固定する（`toHaveLength`）。列挙に値を足すと行が増え、`satisfies Record<…>` がセルの書き忘れを型の誤りにする（陽性の対照: 表 A の `sh-release-as-head` の `aside-foreign` を消すと `tsc` が `TS2741`、`ts-release` の `foreign` を `released(removed)` にすると I-1 の検査が 3 行赤。この段で実行して確かめた）。

---

## 3. (c) 外部の呼び出しごとの失敗の倒れ方

「消す側」＝ロック（canonical・退避）を消す・取る方向、「消さない側」＝残す・断る方向。PR1b の包みが流用する部品の倒れ方を file:line で示す。

| 呼び出し | 場所（流用する部品） | 失敗 | 倒れる側 | 理由・PR1b の扱い |
|---|---|---|---|---|
| `kill -0 <pid>`・`kill -0 -<G>`（bash） | `lock_obs_kill0` `verify-run.sh:848-857`（`LC_ALL=C` の文面で ESRCH を判定） | ESRCH 以外（EPERM・文面が読めない） | 消さない | unknown。取らない・回収しない・D12 は deferred・D5 は deferred・引渡しは refused-arg（`kill -0 $$`） |
| `process.kill(pid, 0)`（TS） | sync `makeObserver` の `probe` `:153-161`、`hooks.kill`（D10） | ESRCH 以外 | 消さない | 同上。`isAlive` を試験が渡したときだけ 2 値（`run-lock-3359.test.ts:73`・`:77` の期待のため）。本番（`main.ts:226`）は渡さない |
| 旧い `run_lock_pid_alive`（`kill -0 \|\| ps -p`） | `run-lock.sh:50-56` | EPERM を `ps` で生と読む／`ps` の失敗を死と読む | **消す側にもなる**（2 値） | ロックの判定には使わない（土台 §1.7）。`stop_recorded`（`run-server.sh:110`・`:134`・`:138`）と `lib.sh:76` は停止の待ちと runner の確かめに使う。表 C の `dead` は `kill -0` の ESRCH で決め、この関数の「死」では決めない（§4 の PR1b の差分） |
| `ps -o pgid= -p`（G の確かめ） | `lock_obs_pgid` `verify-run.sh:1055-1060` | 失敗・空・数でない | 消さない | unknown → D9 の `stage=group`。子は始めない（`go` を作らない）。`down` は `alive-verified` にしない |
| `ps eww -o command=`（`CM_DB_PATH` の確かめ） | `env_value_of` `run-server.sh:97-99` | 失敗・空 | 消さない | 確かめを通らない → 何も送らない・ロックを残す（今の `stop_recorded:117-124` と同じ。表 C の `unverified`） |
| `ps -o etime=`（札の pid の再利用） | `lock_pid_start_ms` `verify-run.sh:1129-`、sync `processStartMs` `:89` | 失敗 | 消さない | 空 → 再利用と読まない（札は外さない、待つ） |
| `lsof`（LISTEN の確かめ） | `find_listen_pids_by_port` `scripts/lib/port-pids.sh:33-42` | 無い・失敗 | **消さない側（今のまま）**。見立て: 空の一覧は「誰も listen していない」と読まれ、`stop_recorded:127` の照合を素通りする | 今の振る舞い（PR1b で変えない）。長の確かめの残りの条件（`CM_DB_PATH`・`ps -o pgid=`）で G の名指しは守られる |
| `mv`（回収の退かし） | `lock_obs_mv` `:989-1000`、`lock_recover` `:1459-1489`、sync `recoverLock` `:703-731` | ENOENT | 消さない | `absent`（もう無い）。それ以外 unknown → 何もしない、canonical は残る |
| `mv`（戻し） | `lock_move_owner_in`・`lock_restore_from_gone`、sync `moveOwnerIn` `:573-584` | 失敗 | 消さない | 退避を残す（`restore-failed`）。先頭は生きた退避を保有中と読む（§2.7 の土台） |
| `mv`（引渡しの公開） | `lock_hand_off` `:1923-1945` | 失敗 | 消さない | `stage=mv`、tmp だけ消す。記録は T0 のまま。trap は D12 で T0 を消す（記録の pid＝`up` 自身、表 A `own-self/alive`） |
| `printf > tmp`（引渡しの tmp） | 同 `:1931-1935` | 失敗 | 消さない | `stage=tmp`。同上 |
| owner の排他作成（`set -C`・`wx`）と読み直し | `lock_obs_create` `:1010-1037`、sync `claim` `:447-477` | EEXIST・他の記録の読み直し | 消さない | 何も消さない（取れなかった） |
| 同上 | 同上 | open の後の書き込み・読み直しの不明 | 自分が開けた owner と空の `<lock>` だけ消す | 自分が `mkdir` した直後で、先頭なので他者は居ない（土台 D3）。`rmdir` の失敗は `<lock>` を残す（誰も回収しない＝2 者は持たない側）。**sync は例外を投げる**（F6）→ TS の包みが捕まえて `{ ok: false }` |
| `mkdir <lock>` | `lock_obs_mkdir` `:976-987`、sync `claim:448-454` | EEXIST 以外 | 消さない | unknown。bash は記録して断る、sync は例外（F6） |
| `rmdir`（D3 の owner の無い `<lock>`） | `lock_expire_ownerless` `:1501-1535`、sync `expireOwnerless` `:487-504` | 空でない・失敗 | 消さない | unknown → その回は `mkdir` しない |
| `rm -rf <lock>`（D12・D5・回収の後の退避） | `machine-lock.sh:241`、`verify-run.sh:1986`、`:1472` | 部分失敗（owner は消えた、ディレクトリが残る） | **消す側に寄る**（ただし他者のロックは消さない） | 結果は `released` と答える（F13）。残った owner の無い `<lock>` は 60 秒は誰も取らず（`ownerless-young`）、その後に先頭が D3 で `rmdir` する。消したのは自分の記録だけなので I-1 は崩れない |
| `fs.rmSync(lockPath)`（TS の D12・D5） | sync `:930`・`:1127` | EACCES・EIO | 消さない（例外） | `release()` が投げる。TS の包みは捕まえて何もしない（記録は残り、pid が死んだ後に次の先頭が回収する）。`main.ts` の `lock.release()`（`:271`・`:487`）は投げられない前提なので、包みで捕まえる |
| 札の `ln`／`link` | `lock_take_ticket` `:1212-1241`、sync `takeTicket` `:377-404` | EEXIST 以外 | 消さない | bash は `cannot publish a ticket` で断る（取らない）。sync は例外（F6）→ 包みが `{ ok: false }` |
| 退避の候補の一覧（`ls -1A`・`readdirSync`）と `lstat` | `lock_gone_candidates` `:1267-1291`、sync `goneCandidates` `:536-551` | ENOENT 以外 | 消さない | unknown → `settleGone` が block（その回は取らない）。解放の後片付け（`release-list`）では片付けを飛ばすだけ |
| owner の読み（`cat`・`readFileSync`）と kv の解き | `lock_obs_owner` `:905-946`、`machine_lock_use_kv_codec` `machine-lock.sh:135-171`、sync `obs.owner` | ENOENT 以外・数でない `pgid=` | 消さない | unknown（`unreadable`）。ENOENT かつ symlink でない → `missing`（D12・D5 は canonical を消さない） |
| `tmux`（UAT の keepalive の `kill-server`） | `remove_socket_dir` `run-server.sh:148-160`、`remove_socket_dir_tmux_only` `:380-384` | 失敗（`\|\| true`） | 関係しない | ロックの判定に tmux を使わない。keepalive は `tmux new-session -d`（`:454`）で自分のセッションへ移るので G に入らず、D9 の保護の外（土台 §1.8 の保証の外）。`down`・`cleanup` が止める（今のまま） |
| 時計（`date +%s%3N`・`Date`） | `lock_now_ms` `:676-682`、TS の `now: () => Date` を ms に直す（D11） | `%3N` が無い（macOS） | 消さない側に寄る | 秒×1000 に落ちる。D3 の 60 秒の境目が最大 1 秒ずれるだけ（`rmdir` の側には 1 秒遅れる方向: `mtime` も秒） |
| 子の起動（`set -m` の背景ジョブ、`bash -c`） | daily・UAT の D9（F7） | `set -m` が効かず G が親と同じ | 消さない | `ps -o pgid=` が子の pid と違う → `stage=group` → 子を KILL（pid だけ）して始めない（`rga_handoff_fail` `:2300-2331` と同じ形） |

---

## 4. (d) PR の切り方

### 4.1 PR1b は 1 本

| 中身 | ファイル |
|---|---|
| TS の包み（D8・D10・D11、I-3 の needs-head→`releaseAsHead`、F6 の例外の捕まえ、I-8） | `src/lib/agent-health/run-lock.ts` |
| bash の包み（D1 の kv・D2 のパス・D3 の 60 秒・D8・D12・D5 の包み・I-6 の `run_lock_set_pid`・I-8・F3 の文面） | `scripts/uat/run-lock.sh` |
| UAT の呼び手（D9 のサーバーの起動と `server_pid` の順、`lock_token`、`down` の表 C、失敗の trap） | `scripts/uat/run-server.sh` |
| daily の呼び手（D9 の子、INT／TERM と EXIT の G の drain、D12） | `scripts/agent-health/daily.sh` |
| 試験（この雛形を実装に当てる・profiles の台・凍結した旧版） | `tests/unit/lib/agent-health/run-lock-machine-lock-4288.test.ts`・`run-lock-profiles-4288.ts`・`fixtures/` |
| コメントの 1 語 | `src/lib/agent-health/claude3-reservation.ts:12`（土台 §1.12） |
| UAT を起こす worktree に develop を取り込む手順の 1 行（PM の決定 `pm-return-4288-design-rev2.md` の追記 (3)。本文から参照を張る） | `docs/orchestrate/` の該当文書 |

**API は呼び手と同じ PR**: `run_lock_set_pid` の新しい意味（I-6）・D5 の包み（`run_lock_release_as_head`）・TS の `release()` の needs-head の扱いは、呼び手（`run-server.sh`・`daily.sh`・`main.ts`）と同じ PR に入れる。呼び手の無い API は足さない。

**TS と bash を分けない理由**（見立て）: 同じ `<lock>` を TS と bash の両方が取るので、片方だけを新しくすると develop の上に土台 §1.9 の新旧混在（旧い取得者は札と `.gone-*` を見ない）を自分で作る。混在の保証は「死んだ持ち主・戻せなかった退避・owner の無い `<lock>` が無いとき」に狭まり、日次確認（08:xx）と UAT が同じ朝に動くので避けたい。分けるなら「TS と bash の包み（呼び手は変えない）」→「D9・表 C の呼び手」の順で、前者だけで I-11 が成り立つことを試験で示す（PR1b の契約で行数が多すぎると判断されたときの代案）。

PR1b に**入れない**もの: `scripts/lib/machine-lock.sh`・`verify-run.sh`・`machine-lock-sync.mjs` の変更（PR1a の部品はそのまま使える。§7 の指摘は直さない）、supervisor.lock（PR1c）、`run_lock_pid_alive` の 3 値化（停止の待ちと runner の確かめに使う。土台 §8）。

### 4.2 呼び手の無い組み合わせは引数で拒否する

| 拒否するもの | どこで | 理由 |
|---|---|---|
| token が `[A-Za-z0-9-]+` でない | TS `acquireRunLock`（`token` 指定）→ `{ ok: false }`、bash `run_lock_acquire` → 1 | I-8・F4（退避が見えなくなる）。札の tmp `.t-<token>`（sync `:379`、bash `:1560`）のパスにも入る |
| `label`・`run_dir` に改行 | 同上 | I-8・F10（`pgid=` の注入） |
| 引渡しで記録の pid が `$$` でない・サブシェル・`kill -0 $$` が alive でない | `run_lock_set_pid` → `refused-arg`（何も書かない、`LOCK_PENDING_TOKEN` も立てない） | I-6（表 A `sh-hand-off/own-other`） |
| TS の handOff | `acquireRunLock` の戻り値に出さない | TS の呼び手（`main.ts`）は子を起こしてロックを渡さない（表 A の `own-*-g` は TS で到達しない） |
| 回収だけの操作（D6） | run-lock の包みに出さない | 呼び手はガード（supervisor.lock、PR1c）だけ |
| D5 の包み | `run_lock_release_as_head <token>…` を `down` と `up` の失敗の trap（needs-head を受けた後）からだけ呼ぶ。`daily.sh` は D12 だけ（記録の pid は自分、表 A `own-self-g`） | I-3。daily が deferred を受けても D5 は pid が生きている間は deferred なので呼ばない（次の先頭が回収） |

### 4.3 実装の契約への引継ぎ

- 表 A〜C は閉じている（§2.5。行の追加は列挙の追加で、型が落ちる）。PM の依頼の段 4 の基準（表が閉じていれば中＝sonnet）に当たる見立て。ただし表 B・C は実プロセス（偽のサーバー・偽の子・`kill -9`）の試験で、#4288 の 1 番の試験の台（`lock-4288-harness.ts`）と止め所（`CM_VERIFY_TEST_HANDOFF=pause:<stage>`）を流用できる
- 実装の試験は、この雛形の `it.todo`（呼び手ごと 8 本・流れごと 2 本・`down` 1 本）を `it.each` に置き換える。行の期待は変えない（変えるときは上流に戻す）
- 陽性の対照（土台 §1.10）: 凍結した旧版で §1.2 の 3 者の割込みが 2 者を通す・今の `run-server.sh:470-473` で `set_pid` の前に `up` を `kill -9` するとサーバーが動いたまま取れる・今の `stop_recorded` で長だけが死ぬと `down` が `stopped` を書く（表 C の `dead × unverified`）

---

## 5. review-4288h（codex-2 の最後の再確認）の処置

| # | 指摘 | 処置 | 場所 |
|---|---|---|---|
| P2-1 | 読み込み口だけでは `KILL_GRACE_SEC` が初期化されない | **PR1a で閉じている**（事実 F1: `KILL_GRACE_SEC=5` は節の中 `verify-run.sh:611`、読み込み口のヘッダ `machine-lock.sh:29-31`）。PR1b の対照: 猶予の変数を与えずに読み込み、TERM を無視する子に猶予の後で KILL が届き、G が空になるまで解放しない（daily の INT／TERM の行、表 B の `acked`） | 土台 §1.14 の P2-1、本書 §3 |
| P2-2 | D9 の `tmp` 段では待機中の G があっても回収できる（期待が成り立たない）。UAT は親を殺すだけでは pgid の判定を試せない | **採る**。公開の前（`forked`・`group`・`tmp`）と後（`published` 以降）で期待を分けた: 前は「次の取得を許す・子は始まらない」、後は「G が残る間は断る」。UAT の pgid の判定は「長だけ終わり、メンバーが残る」の事象（`acked`）で試す | 表 B（§2.3）、I-7 |
| P2-3 | UAT の長が死に G の子だけ残ったときの `down` が未完 | **採る**。長 4 × 残り 4 の表 C。長が死んでいれば G の残りを 1 人ずつ確かめ、全員が run のものなら空にして D5、そうでなければ何も送らず `stop-refused-group`・exit 1（停止完了と書かない）。`lock_token` が保存されなかった場合は `<run_id>-g<server_pid>` を作る（`server_pid` を引渡しの前に書く順、F12・I-6）。`server_pid` も無ければ記録は T0 で D5 が消す | 表 C（§2.4）、I-10 |
| P3 | pending の後・`mv` の前の失敗で D5 は T0 を消さない | **PR1a で閉じている**（土台 §1.14 の「操作の終状態」: `tmp`・`mv` の失敗は T0 の記録＝`up` 自身なので D12 が `released`、`mv` の後の読み直しの失敗は T1＝サーバーなので needs-head → D5）。表 A の `sh-release-held/own-self/alive` と `own-other-g` の行 | 表 A |

---

## 6. 決めてほしいこと（PM へ。どれも止める条件ではない）

1. **壊れた記録（`corrupt`）を回収しない**（F14）。今は bash が即、TS が 60 秒で取っていた。新しい形では誰も消さず、取得は断り続ける（安全側。壊れた owner は排他作成と読み直しの後は作られないが、電源断などの書きかけは残りうる＝見立て）。推奨: このまま（machine-lock の規則に合わせる）。断るときの文面に「owner が壊れている: `<lock>/owner`」を出し、人が消す
2. **daily の EXIT で G を空にする**（表 B の `acked × 長だけ終わる`）。`run.ts` が背景に残したプロセスを、EXIT の trap で TERM → `KILL_GRACE_SEC` → KILL してから D12 で解放する（verify-run.sh のゲートと同じ、`run_gate_handoff` `:2406-2414`）。今は `daily.sh` と同じグループで残り、ロックの外で動き続ける。空にしないなら D12 は G が空になるまで deferred（ロックが翌朝の UAT を止めうる）。推奨: 空にする
3. **`stop-refused-group` の後の手順**（表 C）。`down` の文面に残った pid と `CM_DB_PATH` を出すだけにするか、`docs/user-guide/`（UAT の手順）に「G の残りを確かめて止め、`down` をもう一度」の段落を足すか。推奨: 文面だけ（PR1b の範囲を広げない）

---

## 7. 本文に無い指摘（直さない）

- `scripts/orchestrate/machine-lock-sync.mjs:680-690` の `cleanupOwnGone` は自分の token の退避を G を見ずに消す。bash の `lock_release_own_gone`（`verify-run.sh:1434-1449`）は G が空でなければ残す。3 実装の規則が 1 か所ずれている（F5）。TS の run-lock は pgid を書かないので PR1b では届かない。同期 JS の `handOff` を使う呼び手が出たら当たる
- `scripts/lib/machine-lock.sh:241` の `rm -rf` と `verify-run.sh:1986` は削除の失敗を見ずに `released` と答える（F13）。他者のロックは消さないが、呼び手は「消えた」と思う
- `scripts/lib/machine-lock.sh:168-169` の kv の codec は呼び手の欄を `pgid=` の前に書く（F10）。PR1b は引数で改行を拒否するが、codec 自体は守らない
- `verify-run.sh:1680-1685` の `LOCK_HELD_BY` は JSON の読みで、kv の記録では空になる（F3）。run-lock は自前で文面を作るが、他に kv で読み込む呼び手が出たら当たる

## 8. 確かめたこと・探した対

- 読んだもの: 土台の設計の全文（§1〜§8）、`scripts/lib/machine-lock.sh` 全文、`verify-run.sh` のロックの節（`:591`〜`:2079`）のうち観測・取得・回収・解放・引渡し・D5・D6・子の待ち、`machine-lock-sync.mjs` の観測・札・`claim`・`settleGone`・`acquireMachineLockSync`・`releaseAsHead`・`recoverIfDead`、`run-lock.ts`・`run-lock.sh` 全文、`run-server.sh` の停止・`up`・`down`・`cleanup`、`daily.sh` 全文、`run-lock-3359.test.ts` 全文、review-4288h、PM の決定 rev2
- 実行したもの: `/bin/bash -c 'echo ${BASHPID:-none}'`（F7）、試験の雛形の陽性の対照 2 つ（§2.5）。サーバー・tmux・エージェント CLI・`~/.commandmate` には触っていない
- 探した対: `run_lock_*`・`acquireRunLock`・`CM_RUN_LOCK_*` の呼び手（`git grep`）は §1 の表の経路と `scripts/agent-health/product/lib.sh`（PR1c）・`supervisor.sh:73`（`CM_RUN_LOCK_DIR` を `<base>/run.lock` にする。`.lock` で終わるので札は `<base>/run.queue`）だけ。`docs/en` に run-lock の写しは無い。`src/cli/types/` にロックの型の写しは無い
- 未確認: `set -m` の下の `nohup … &` が macOS の bash 3.2 で子を新しいグループに置くこと（verify-run.sh のゲートは `set -m` の背景ジョブで同じことをしている `:2197` が、`nohup` との組み合わせは試していない）。PR1b の試験で `ps -o pgid=` を見る（§3 の最後の行の倒れ方で、失敗しても子は始まらない）
