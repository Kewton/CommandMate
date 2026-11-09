# verify-run.sh の保有者にゲートのグループを記録する（Issue #4288 の 1 番）

- 状態: 設計 第 2 版（Codex〔codex-2〕の事前レビュー `review-4288.md` の処置を反映。実装は同じブランチの別の契約）
- 行番号は 2026-11-09 の `fix/4288-verify-lock-pgid`（`7cfb9293c`）のもの。名前で引くこと
- **事実**＝コード・記録で確かめたこと、**見立て**＝推したが試していないこと、**未確認**＝この段で確かめていないこと
- 第 1 版からの主な変更: owner の公開で **token を新しくする**（§2.2）。G の確認・公開に失敗したら**ゲートを始めない**（§2.3）。**解放は G が空になってから**（§2.5）。取消しの責任と owner の保持を分けた（§2.6）。合図待ちに実時間の期限（§2.4）。経路表（§3）と互換表（§4）を作り直した。末尾に「事前レビューの処置」

## 止める点

**無し。** 確かめたこと:

- 直しは `verify-run.sh`（`.claude`／`.agents` の 2 配置。`cmp` 一致）の**書き手の側だけ**で済む。読み手（bash `lock_acquire`／`lock_recover`、TS `machine-lock.ts` の `breakStale`、同期 JS `machine-lock-sync.mjs` の `recoverLock`）は変えない。`scripts/orchestrate/machine-lock-sync.mjs`・`machine-lock.ts` に手を入れる必要は無い（§2.2 の検証）。
- 札（ticket）の形・中身・`token` は #4277 のまま（`docs/design/merge-queue-fair-lock-4277.md:90`、`docs/design/verification-config.md:533`）。札の token と owner の token を突き合わせる読み手は 3 実装とも無い（事実: bash の札は `lock_mark_done`／`lock_retire_own_ticket` が `$LOCK_TOKEN` だけを見る `verify-run.sh:768`・`:824`、TS・同期 JS の `markDone` も札の中の token だけ）。よって owner の token を取得の途中で 1 回替えても札の規約には触れない。
- #4277 の規約のうち「解放は owner の token が自分のときだけ」「回収は死んだと判定した token のときだけ消す」（`verification-config.md:536`・`:537`）はそのまま成り立つ。「自分の token」を、公開の後は新しい token と読むだけ。説明（`verification-config.md:531` の保有者記録、`SKILL.md:286`）に「verify-run.sh はゲートの起動時に `pgid` を足し、token を替えて書き直す」を足すのは実装の契約で行う。

## 1. 今の順序（事実）

`.claude/skills/cmate-verify/scripts/verify-run.sh`:

| 順 | 箇所 | 中身 |
|---|---|---|
| 1 | `:853` `lock_acquire`、`:905`–906 | `mkdir "$LOCK_PATH"` の直後に `printf '{"pid":$$,"host","token","acquiredAt"}' > owner`。**pgid は書かない** |
| 2 | `:1066`–1068 `run_gate_attempt` | `set -m; ( cd && exec /bin/sh -c "$rga_cmd" ) &; rga_pid=$!; set +m`。ゲートは自分のグループ G（=rga_pid）の長になり、**fork の直後に走り出す** |
| 3 | `:1077`–1078 | `ps -o pgid=` で G=rga_pid を確かめ、取消しの宛先 `rga_target=-G`（確かめられなければ pid） |
| 4 | `:1080`–1086 | 見張り（watchdog）。`sleep timeoutSec` → `kill -TERM -- -G` → `KILL_GRACE_SEC`（`:70`、5 秒） → `kill -KILL -- -G`。見張りは**本体のグループ**に居る |
| 5 | `:1089`、`:1103`、`:1109` | `wait` は**グループの長**だけを待つ → 見張りを KILL → `lock_release`。**G に残った子を見ずに解放する** |
| 6 | `:130`、`:960`–963 | EXIT trap（`cleanup_workdir`）→ `lock_cleanup_on_exit` → 持っていれば `lock_release`。**G を見ない** |

`lock_release`（`:946`–955）は、読んだ token が自分のとき**だけでなく、空のときも** `rm -rf` する（`:953` の条件は「空でなく、かつ違う」ときだけ戻る）。第 1 版の「token が自分のときだけ」は誤りで、ここで直す。TS・同期 JS の `release` は `readOwner(lockPath)?.token !== token` で戻る（`machine-lock.ts:602`、`machine-lock-sync.mjs:407`）ので、owner が欠けている・壊れているときは**消さない**。既存の差異（§4）。

回収の判定と削除:

| 実装 | 判定 | 削除の条件 |
|---|---|---|
| bash | `:914` で token を読み（`la_token`）、`:917` の `lock_record_gone` が **pid・host・pgid をそれぞれその時点のファイルから読み直す**（`:705`–707） | `lock_recover`（`:833`）: ディレクトリを `.gone-*` へ `mv` し、退かした owner の token が `la_token` と同じときだけ `rm -rf`（`:837`）。違えば戻す |
| TS | `:616` で `readOwner` した**記録をそのまま** `holderGone`（`:302`–306）に渡す | `breakStale`（`:449`）: rename で退かし、`moved.token === owner.token`（`:465`）のときだけ消す |
| 同期 JS | `:421` で `readOwner` した記録を `holderGone`（`:157`–161）に渡す | `recoverLock`（`:266`）: 同じ形、`moved.token === dead.token`（`:277`） |

3 実装とも、**削除の最後の決め手は「退かした owner の token が、判定に使った token と同じか」だけ**。判定に使った記録の中身（pgid の有無）とは突き合わせない。

repro-1.md の `ps`（bash: holder alive）: 本体 `57531 PGID 57531`、ゲート `57615 PGID 57615 PPID 57531`、見張り `57619 PGID 57531`。本体だけ SIGKILL の後、ゲートは `PPID 1` で生き、**見張り 57619 も生きている**（本体のグループに居て、本体への signal は届かない）。owner は `{"pid":57531,…}`（pgid 無し）のまま。bash も TS（`timeoutMs:0`）も stale として回収し、旧ゲートと新しい保有者が同時に動いた。**本体の pgid（57531）は G と違う**ので、本体の pgid を足しても G を代表しない。

## 2. 設計

### 2.1 何に生存を代表させるか（第 1 版から変えない）

| 案 | 評価 |
|---|---|
| A 本体を新しいグループの長にし、ゲートも同じグループへ | 不採用。bash 3.2・macOS に `setsid(1)` が無く、本体のグループは呼び手が決める。同じグループだと見張りの `kill -- -G` が本体まで殺す |
| B 本体の pgid を書く | 不採用。G と違う（上の ps）。呼び手の非対話シェルのグループなら呼び手が生きる間ずっと「生存」になる |
| C ゲートごとに owner の pgid を G に書き換える（起動の後） | 方向は正しいが、fork から書き換えまでの窓で本体が死ぬと、pgid 無しのまま回収されてゲートが走る |
| D 代表のプロセスを別に置く | 不採用。代表の pid も fork の後にしか分からず C と同じ窓が残る |
| **E（採用）= C ＋ 起動の受け渡し ＋ token の更新** | ゲートの子を「合図が出るまで exec しない」形で起こし、本体が owner に G を **新しい token で** 公開してから合図を出す |

E は **mutex を持つゲートだけ**に当てる。mutex の無いゲートは今のまま（受け渡しも排水もしない）。

### 2.2 守る条件と、token の更新（P1-1）

**守る条件**: 回収者が削除する owner の記録（＝削除の瞬間の最新の owner）について、死亡の条件（同じ host・pid が ESRCH・pgid があればそのグループも ESRCH）が成立していること。

第 1 版（同じ token のまま pgid を足す）では成り立たない。TS・同期 JS は判定に**読んだ時点の記録**を使い、削除は token の一致だけで決める（§1 の表）。次の順序で、新しい G が生きているのに消える:

1. 待ち手 W が owner `{pid:B, token:T0}`（pgid 無し）を読む（TS `:616`、同期 JS `:421`）。
2. 本体 B が同じ token T0 で `{…, token:T0, pgid:G}` を公開し、合図を出し、ゲートが走る。
3. B だけが死ぬ。
4. W が 1 の記録で `holderGone` → pid は ESRCH、pgid は無い → 死んだと判定。
5. `breakStale`／`recoverLock` が退かした owner の token は T0 ＝判定の token → **G が生きたまま消える**。

bash の待ち手も同じ穴を持つ: `la_token` は `:914` で読み、`lock_record_gone` が別の時点で読み直す。`lock_record_gone` の pgid の読み（最後に読む）が公開の前なら空と読み、`lock_recover` の比較（`:837`）は T0 で一致する。

**直し: owner の公開で token を新しくする。** 公開する記録は `{"pid":B,"host","token":T1,"acquiredAt","pgid":G}`、`T1 = "$LOCK_TOKEN-g$G"`（`$LOCK_TOKEN` は札の token のまま変えない。保持する変数は `LOCK_HELD_TOKEN`／`rga_lock_token` だけを T1 にする）。

効く理由（3 実装の回収のコードで確かめた。どれも読み手の変更は要らない）:

- **token と記録の中身が 1 対 1**: 1 つの取得で owner を書くのは本体だけで、T0（pgid 無し）を 1 回、T1（pgid:G）を 1 回。同じ token で中身が変わることが無い。
- **TS**（`breakStale`、`machine-lock.ts:465`）・**同期 JS**（`recoverLock`、`machine-lock-sync.mjs:277`）: 判定に使った記録が T0 で、退かした owner が T1 なら一致しない → 戻す。戻した後の次の周回で T1 を読み、`broken` の Set（`machine-lock.ts:618`、`machine-lock-sync.mjs:423`）に T1 は無いので改めて判定する。G が生きていれば `groupAlive` が真で待つ。G が空になれば T1 で判定し、退かした owner も T1 なので消す。
- **bash**（`lock_recover`、`verify-run.sh:837`）: 比較は `la_token`（`:914` で読んだ値）。公開が判定より先なら、退かした owner は T1 で `la_token`=T0 と一致しない → 戻す。`la_broken`（`:918`）は T0 だけを覚えるので、次の周回の T1 は判定される。`lock_record_gone` のフィールドの読みが T0 と T1 にまたがっても、退かした owner が T0 である限り（＝公開は起きていない）全ての読みは T0 の記録だったので、判定は T0 について正しい（公開は一方向で、T1 から T0 へ戻ることは無い）。
- **死亡は単調**: T0 の死亡（pid ESRCH）の後に B が蘇ることは無い。T1 の死亡（pid ESRCH かつ G が ESRCH）の後に G に人が戻ることも無い（空のグループは存在せず、`setpgid` で入れない。同じ番号の新しいグループは pid の再利用で、無関係なプロセス）。よって「判定した token と退かした token が同じ」なら、削除する最新の owner に死亡の条件が成り立つ。
- **公開の途中で本体が死ぬ**: 公開は本体が生きている間に始まる。本体が SIGKILL で死んでも、子の `mv` が後から owner を T1 に置き換えることはありうる。そのとき合図は出ていない（合図は公開の確認の後、§2.3）ので子は exec せず、G は空になる。T0 で判定した待ち手は token の不一致で戻し、T1 で判定し直す（1 周の遅れだけ）。
- **生きている本体の公開を横取りされない**: 新しい実装の待ち手は pid が生きている間は回収しない（3 実装とも `pidAlive`／`kill -0` が先）。公開の直前の token の確かめと `mv` の間にディレクトリが退かされるのは、旧版（#4277 以前）の掃除だけで、それは #4277 §0 B' の「範囲外」。

検討して採らなかった案: (a) 読み手に「退かした記録の pgid も判定に使う」を足す — 3 実装の読み手を変えることになり、PM の止める条件（同期 JS の変更）に当たる。token の更新で足りるので採らない。(b) 公開の前に owner を消す — 空の owner は bash の解放が消す（`:953`）・TS は待つ、と実装で揃わない。

### 2.3 起動の受け渡し（P1-2。失敗したらゲートを始めない）

`run_gate_attempt` の mutex ありの経路だけ（見立て、実装で実測）:

1. 合図のパス `go="$rga_log.go"` を決める（作らない）。
2. `set -m; ( 待ち ; cd "$CWD" && exec /bin/sh -c "$rga_cmd" ) > "$rga_log" 2>&1 &`。待ちは §2.4。
3. `ps -o pgid=` で G=rga_pid を確かめる。
4. 見張りを起こす（今の 4 と同じ中身。**公開の前に起こす**ので、合図の後に本体だけが SIGKILL されても G を timeout で止める者が居る。§2.6）。
5. owner の token が T0（自分）か確かめる → `$LOCK_PATH/.owner-$T1` に T1 の記録を書く → `mv -f` で `owner` へ（同じディレクトリ内の rename。読み手は旧か新のどちらかしか見ない）→ 読み直して token が T1・pgid が G であることを確かめる。
6. `mkdir "$go"` が成功したら合図を出したことになる（§2.4 の取り合い）。`LOCK_HELD_TOKEN`／`rga_lock_token` を T1 にする。

**ゲートを始めない条件**（どれか 1 つで、合図を出さない）:

| 失敗 | 判定 |
|---|---|
| G を確かめられない（`ps` の失敗、job control が効かず pgid≠pid） | 3 |
| 公開の前の token が T0 でない（読めない・空・他人） | 5 の前段 |
| tmp の書き込みの失敗（ENOSPC・ディレクトリが無い） | 5 |
| `mv` の失敗 | 5 |
| 読み直した owner が T1／G でない | 5 の後段 |
| 子が先に `mkdir "$go"` した（期限切れ・本体の死を見た） | 6 |

失敗したときの本体の後始末: 見張りを KILL、子のグループ（確かめられなければ子の pid）を KILL して `wait`（子は待ちのループの sh で、何も始めていない）。解放は**その時点の owner の token** で行う: T1 なら T1、T0 なら T0、それ以外（他人・読めない）なら解放しない（`lock_release` は空の token でも消すので、読めないときは呼ばない）。結果は `RGA_STATUS=handoff-fail`、出力は既存の文法のまま `GATE <id> FAIL exit=125`、stderr に `verify-run: machine-lock-handoff-failed <lock> stage=<group|token|tmp|mv|verify|abort>`。**再試行（`retryOnFail`）の対象にしない**（ゲートは走っていないので、FLAKY に化けさせない）。`SKIP reason=<新しい語>` にしなかったのは、`reason=` の語は CommandMate の読み手が解釈する出力の契約で、語を増やすと別の改訂になるため。

**今の動作に戻さない**: job control が効かない環境では、mutex 付きのゲートは毎回 FAIL 125 になる（黙って排他の無い実行をするより、大きく落ちる方を選ぶ）。mutex の無いゲートは影響を受けない。

### 2.4 合図待ちの実時間の期限と 125／124（P2-2）

子の待ちの中身（bash のサブシェル。`$LOCK_SELF_PID`＝本体の pid、`verify-run.sh:622`。bash 3.2 に `BASHPID` は無い）:

```
deadline=$(( $(date +%s) + HANDOFF_WAIT_SEC ))
while [ ! -d "$go" ]; do
  if ! kill -0 "$LOCK_SELF_PID" 2>/dev/null || [ "$(date +%s)" -ge "$deadline" ]; then
    mkdir "$go" 2>/dev/null && exit 125   # 取り合いに勝った＝合図は二度と出ない
    break                                  # 負けた＝本体が直前に合図を出した
  fi
  sleep 0.05 2>/dev/null || sleep 1
done
```

- **取り合いは `mkdir "$go"` 1 つ**: 本体の合図も子の取り下げも同じパスの `mkdir` で、先に作った側の意味になる（原子的）。子の期限切れと本体の合図が同時でも、「子は exec しないのに本体は走ったと思う」「子は exec したのに本体は失敗と思う」は起きない。本体は自分の `mkdir` が失敗したら `stage=abort` の handoff-fail。
- 期限 `HANDOFF_WAIT_SEC` は 30 秒（本体の 3〜6 は通常ミリ秒。負荷の高いときの `ps` の遅さを見込む）。**子が自分の `date +%s` で測る実時間**で、本体の pid が再利用されて `kill -0` が成功し続けても期限で終わる。テストだけが `CM_VERIFY_TEST_HANDOFF_WAIT_SEC` で縮める。
- 期限が解くのは**子の待ち**だけ。owner の pid が再利用されていれば、既存の回収の規約（pid が生きていれば回収しない）によりロックは再利用されたプロセスが終わるまで残る（待つ側。今と同じ）。ロックの回収までは保証しない。実機での pid の再利用は**未確認**。
- 終了コードの区別: 受け渡しの失敗は **125**（`RGA_STATUS=handoff-fail`）、実行の timeout は今のまま **124**（見張りの印 `$rga_log.timedout`）。両方が立ったら（受け渡しの待ちの間に見張りが発火）、ゲートは走っていないので **125 を優先**する。125 の判定は本体が持つ「合図を出したか」で行い、子の終了コード 125 だけでは判定しない（ゲート自身が 125 で終わることはある）。

### 2.5 解放は G が空になってから（P1-3）

mutex を持つゲートの全ての解放経路で、解放の前に G の**排水**を行う:

```
drain_group G:
  空なら終わり
  （まだ TERM を送っていなければ）kill -TERM -- -G
  KILL_GRACE_SEC まで 0.05 秒ごとに空を見る
  kill -KILL -- -G
  1 秒まで空を見る
  空なら 0、そうでなければ 1
```

| 経路 | 今 | 新 |
|---|---|---|
| 通常終了（長が終わった） | 見張りを KILL → 解放 | 見張りを KILL → `drain_group` → 空なら解放。**長が終わって背景の子が残る場合**も子を止めてから解放する。stderr に `verify-run: gate <id> left processes in group G; stopped them before releasing <mutex>` |
| timeout（見張りが TERM、長だけ終わる） | 長の終了で見張りを KILL（**見張りの KILL より先**）→ 解放。TERM を無視する子が残る | 見張りを KILL（以後は本体が責任を持つ）→ `drain_group`（TERM は送り済みなので猶予と KILL から）→ 空なら解放 |
| 受け渡しの失敗 | — | §2.3。子は合図待ちの sh なので KILL で空にしてから解放 |
| EXIT trap | G を見ずに解放 | §2.6 |

- `drain_group` が 1（KILL の後も空にならない: D 状態・権限の違う子）を返したら**解放しない**。owner（T1、pgid:G）は残り、本体が生きている間は誰も回収しない（pid が生きている）。この run の同じ mutex の後のゲートは自分のロックを待って `SKIP reason=mutex-wait` になりうる。本体が終われば、G が空になった時点で列の先頭が回収する。待つ側に倒す。
- **保証から外すもの**（明示する）: ゲートが自分で別のグループ・セッションへ移した子孫（`setsid`・`set -m` の入れ子・デーモン化）。G に居ないので排水も回収の判定も見ない。今の timeout の取消しと同じ範囲。
- `RGA_DUR`（ゲートの所要）は長の終了までで測り、排水の時間を足さない（待ちを足さないのと同じ理由。`verify-run.sh:1002` の注記）。
- 行動の変化: mutex 付きのゲートが成功の後に背景の子を残していた場合、今は解放後も走り続けたが、新しくは止められる。mutex の無いゲートは変えない。

### 2.6 取消しの責任と owner の保持を分ける（P2-1）

**取消しの責任**（TERM → 猶予 → KILL を最後まで送るのは誰か）:

| 時点 | 本体が TERM／INT を受けた（EXIT trap が走る） | 本体だけが SIGKILL |
|---|---|---|
| 見張りの起動の前（取得済み〜G の確認） | trap: 子（合図待ちの sh）を KILL。解放 | 子は本体の死を見て取り下げ（exit 125）。ゲートは走らない |
| 見張りの起動後・合図の前 | trap: 子を KILL、見張りを KILL。解放 | 同上。見張りは残るが、`sleep timeoutSec` の後に空の G へ signal を送るだけ（G の番号が再利用されていれば無関係なグループへ送る — 今の見張りにもある窓。§本文に無い指摘） |
| 合図の後（実行中） | trap: `drain_group G`（TERM→猶予→KILL）。空になれば見張りを KILL して解放 | **見張りが**（本体のグループに居て生き残る。repro の 57619）timeoutSec の後に TERM→猶予→KILL を送る。それまで owner（T1、G）が生きていて回収されない |
| 排水中（長の終了後） | trap: 続きの `drain_group` | 見張りは既に KILL 済み。G の残りは自然に終わるまで走り、その間ロックは残る（待つ側） |

**owner の保持**（空を確かめられないとき）: trap の `drain_group` が 1 を返したとき、または trap が終わる前に本体が SIGKILL で切られたとき（呼び手が TERM の後に KILL を送るなど）は、owner を**残す**。T1 なら pid が死に G が空になった時点で列の先頭が回収する。T0（合図の前）なら子は取り下げるので、pid の死で回収してよい。

- 見張りを公開の前に起こす（§2.3 の 4）ことで、「合図の後・見張りの前に本体だけが SIGKILL」の窓（第 1 版にあった、TERM を無視するゲートを誰も止めない窓）を無くす。
- 本体のグループごと SIGKILL されると見張りも死ぬ。そのとき G は自然に終わるまで走り、ロックはそれまで残る（待つ側に倒れる。保証は「ロックは G が空になるまで回収されない」で、「G が timeout で止まる」までは含めない）。
- 既存の `gate-cancel-2063`・`gate-slot-cancel-3909` は TS の `startVerification` 経由で、bash の EXIT trap を直接は確かめない。§5 で bash の trap を直接に固定する。

## 3. 経路表（受け渡しの各時点 × 本体の死・取消し × 取得者）

owner の列は公開の状態、「取得者」は bash（`lock_acquire`）・TS（`acquireMachineLock`）・同期 JS（`acquireMachineLockSync`）。「拒否」は本体の死の後も G に人が居る間は取れないこと、「取得」は回収して取れること。

| # | 時点 | owner | 子・G | 本体だけ SIGKILL | 本体へ TERM | 取得者 bash／TS／同期 JS |
|---|---|---|---|---|---|---|
| 1 | 取得待ち（札だけ） | 無し（前の保有者） | 無し | 札は pid の死で外される（#4277 §2.5） | trap が札を done | 3 実装とも今のまま |
| 2 | 取得済み・fork の前 | T0 | 無し | 取得（T0 は死） | trap が解放 | 3 実装とも取得 |
| 3 | fork の後・G 未確認 | T0 | 合図待ち | 子は取り下げて exit 125 → 取得 | trap が子を KILL・解放 | 取得（ゲートは走らない） |
| 4 | G 確認・見張り起動の後・公開の前 | T0 | 合図待ち | 同上（見張りは空振り） | 同上＋見張りを KILL | 取得 |
| 5 | tmp の書き込み中 | T0（tmp は別名） | 合図待ち | 同上。`.owner-*` の残骸はロックごと消える | 同上 | 取得 |
| 6 | 公開後・合図の前 | T1（G） | 合図待ち | 子は取り下げ → G が空 → 取得。T0 を読んでいた取得者は token の不一致で戻し、T1 で判定し直す（§2.2） | trap が子を KILL・解放（T1） | G が空になるまで拒否、空で取得 |
| 7 | 合図の後・実行中 | T1（G） | ゲート | **拒否**（今回の穴を塞ぐ）。見張りが timeoutSec で G を止め、空で取得 | trap が排水 → 解放 | 拒否 → G が空で取得 |
| 8 | 長の終了・子が残る（排水中） | T1（G） | 子 | 拒否。子が終わるまで残る | trap が排水を続ける | 拒否 → 空で取得 |
| 9 | timeout（見張りの TERM の後） | T1（G） | 長は終わり、子が TERM を無視 | 拒否 | 同上 | 拒否 → KILL の後に取得 |
| 10 | retry（2 回目の取得） | 2 回目の T0'→T1' | 1 回目の G は排水済み | 2〜9 と同じ（新しい G'） | 同上 | 同上 |
| 11 | 解放後・次のゲート | 他人または無し | 無し | 古い T1 を読んでいた取得者は、退かした owner の token が違うので戻す（#4277 の restore） | — | 今のまま |

3 実装の違いが結果に出る所は無い（§2.2 のとおり、どれも退かした token で決める）。違いは「T0 を読んで判定した周回が 1 回空振りする」の有無だけ（bash は判定のたびに読み直すので空振りしないことが多い）。

## 4. 互換（書き手 × 読み手、3 実装を分ける）

新しい書き手が書く owner は `pgid` が 1 より大きい整数で、3 実装の読みが揃う行に入る。既存の差異は変えない（事実として書く）。

| owner の形 | bash（`lock_json_field`→`lock_record_gone`、`lock_release`） | TS（`readOwner`→`holderGone`、`release`） | 同期 JS（`readOwner`→`holderGone`、`release`） |
|---|---|---|---|
| 旧 `{pid,host,token,acquiredAt}`（旧版 verify-run.sh、TS gate-runner、precheck） | pid が ESRCH なら回収（旧版の保有者の穴は旧版が消えるまで残る） | 同じ | 同じ |
| 新 T0（公開の前） | pid が ESRCH なら回収。子は走らない | 同じ | 同じ |
| 新 T1 `pgid:G` | pid が ESRCH **かつ** `kill -0 -- -G` が ESRCH | `pidAlive` 偽 **かつ** `groupAlive(G)` 偽 | 同じ |
| merge-pr `pgid:<inner pid>`（取得時から入る。`machine-lock-sync.mjs:342`・`:392`） | 今のまま | 今のまま | 今のまま |
| owner が無い・JSON が壊れている | token が空 → 回収しない（`:917` の `-n`）。**解放は消す**（`:953`） | `readOwner` が null → 回収しない。解放は消さない（`:602`） | 同じく回収しない・解放は消さない（`:407`） |
| `pid` が文字列 `"123"` | 数字の接頭を読んで 123 として判定 | `readOwner` が null（数でない）→ 待つ | 同じく null → 待つ |
| `pgid` が文字列 `"123"` | 123 としてグループを見る | `readOwner` が pgid を落とす（`:240`）→ pid だけ | `validPgid` が偽（`:94`）→ pid だけ |
| `pgid` が小数 `12.5` | 数字の接頭 `12` としてグループ 12 を見る | 数として残るが `validPgid`（`:282`）が偽 → pid だけ | `validPgid` が偽 → pid だけ |
| `pgid` が 1 以下・負・数字で始まらない | 空と見なす（`:696`–697） | `validPgid` が偽 → pid だけ | 同じ |
| 別 host | 生きている扱い | 同じ | 同じ |

pid の再利用は 3 実装とも「生きている」側に倒れる（待つだけ）。#4277 以前の読み手は pgid を読まないが、#4277 の札を知らない版との混在は既に範囲外（4277 §0 B'）。

## 5. owner を読む・書く全経路

- **書く**: verify-run.sh `lock_acquire`（`:905`–906、T0）・**新たに** `run_gate_attempt` の公開（T1、`mv`）・`lock_recover` の戻し（`:846`、mv で中身ごと）。machine-lock.ts `claim`（`:430`）・`breakStale` の戻し（`:477`）。machine-lock-sync.mjs `claim`（`:245`）・`recoverLock` の戻し（`:289`）・`setOwnerFields`（`:410`、merge-pr のマージのロックだけ。同じ token のまま `phase` を足すが、pgid は取得時から入っているので §2.2 の順序は起きない）。
- **読む**: verify-run.sh `lock_owner_field`（`:672`）→ 回収（`:914`–920）・解放（`:952`）・待ち表示（`:924`–926）。machine-lock.ts `readOwner` → 回収（`:616`）・解放（`:602`）・`heldBy`。machine-lock-sync.mjs `readOwner`（`:106`）→ 回収・解放・`heldBy`、merge-pr `heldByLine`、precheck の重い段（`precheck.mjs:514`）。
- 説明: `SKILL.md:286`（.claude／.agents）、`verification-config.md:531`・`:537`。足すのは「verify-run.sh は mutex 付きのゲートの起動時に owner を `pgid` 付き・新しい token で書き直し、G が空になってから解放する」。
- 探して無かったもの: `consistency-review.mjs` の `.lock` は別の規約。`env-snapshot.ts`・`session-kill-ledger.ts` の一致は owner ではない。札の token と owner の token を突き合わせる箇所（3 実装を `token` で grep して確かめた）。

## 6. テストの設計（実装の契約で書く）

共通: `fs.mkdtempSync(os.tmpdir())` に git repository・`holder.yaml`（`mutex: repro`）を置き、全 actor に `CM_VERIFY_LOCK_ROOT` と TS／同期 JS の `root` を渡す。`afterEach` で自分が起こしたグループだけを `kill(-pgid)` し、一時ディレクトリを消す。新しいファイル `tests/unit/skills/cmate-verify/verify-run-holder-group-4288.test.ts`。

**止め所**（テスト専用。未設定なら何もしない）: `CM_VERIFY_TEST_HANDOFF_DIR` と `CM_VERIFY_TEST_HANDOFF=pause:<stage>,fault:<stage>`。`pause` は `<dir>/<stage>.reached` を作って `<dir>/<stage>.go` を待つ。stage は §3 の時点（`forked`・`group`・`watchdog`・`tmp`・`published`・`signalled`・`leader-exited`）と、読み手側の `reader-before-recover`（bash の `lock_record_gone` の後・`lock_recover` の前）。`fault` は §2.3 の失敗（`group`・`token`・`tmp`・`mv`・`verify`）を注入する。TS・同期 JS の読み手は既存の `__testHooks`／`hooks` の `pidAlive`（判定の最中）と `onRecover`（退かす前後）を使う。代案の「SIGSTOP と owner のポーリングで窓を狙う」は時点を固定できないので採らない。

| 対照 | 不正な同時実行の拒否（陽性） | 保護対象が消えた後に進む（陰性） |
|---|---|---|
| R（repro-1） | 本体だけ SIGKILL → 旧ゲートが生きている間、bash（`timeoutSec:1`）が exit 22・`mutex-wait`、TS・同期 JS（`timeoutMs:0`）が `acquired:false`。owner に `pgid`＝ゲートの pid と T1 の token | 旧ゲートのグループを KILL → 3 実装とも取れる |
| P1-1 の順序 | 読み手の `pidAlive` の中で（TS・同期 JS）／`reader-before-recover` で止めて（bash）、本体に公開・合図をさせ、本体だけ SIGKILL してから判定を返す → 退かした owner が T1 で戻され、G が生きている間は取れない。**仕掛けの陽性**: 同じ手順で owner を手で「同じ token のまま pgid を足した形」に書き換えると 3 実装とも消してしまう（第 1 版の穴を検出できることを示す） | G が空になれば同じ取得者が取れる |
| P1-2 の失敗 | `fault:group`・`token`・`tmp`・`mv`・`verify` のそれぞれで、ゲートの副作用（pid ファイル）が**作られない**・`GATE … FAIL exit=125`・stderr の `machine-lock-handoff-failed stage=…`・retry されない・ロックは解放（`token` の注入では解放しない） | 注入なしでは副作用がちょうど 1 回 |
| P1-3 の解放 | 長は `exit 0`、背景の子は `trap '' TERM; sleep 30` → 排水の間は 3 実装とも拒否。timeout でも同じ（長は TERM で終わる） | 子が終わる（KILL）と取れる。背景の子の無いゲートは排水で待たない（解放までの時間が猶予の 5 秒を含まない） |
| P2-1 取消し | `watchdog` の前・`signalled` の後で本体へ TERM: TERM を無視するゲートは猶予の後 KILL → 空で解放。trap の猶予中に本体を SIGKILL → owner が T1 で残り、G が生きている間は拒否 | TERM に従うゲートは猶予を待たずに解放。G を KILL すれば取れる |
| P2-2 期限 | `pause:published`（本体は生きて止まる＝`kill -0` は成功し続ける）・`CM_VERIFY_TEST_HANDOFF_WAIT_SEC=1` → 子は期限で exit 125・副作用なし。再開した本体は `stage=abort` の FAIL 125（124 ではない） | 期限内の合図では exec がちょうど 1 回 |
| §3 の経路表 | `pause:<stage>` の各時点で本体だけ SIGKILL → §3 の「拒否」の行は 3 実装とも取れない | 「取得」の行は 3 実装とも取れ、ゲートの副作用が無い |
| §4 の互換 | 表駆動（手書きの owner × 3 実装。生きている・死んだ pid とグループの組）。既存の差異（壊れた owner の bash の解放、文字列・小数の pgid）は**今の値を固定**する（変える Issue ではない） | — |

- **直す前の実装で落ちること**（陽性）は、実装のコミットの前に 1 回走らせて記録する（コミット本文）。
- 既存の期待は変えない: `tests/unit/verification/machine-lock*.test.ts`、`gate-mutex*.test.ts`、`gate-slot-*.test.ts`、`gate-cancel-2063.test.ts`、`tests/unit/skills/cmate-verify/*`（`dual-placement.test.ts` の `cmp` 一致を含む）。`.claude/skills/sync-map.json` の pin は再計算し、`commandmate-skills` への移植は別途。

## 本文に無い指摘（この Issue では直さない）

- `src/lib/verification/gate-runner.ts:715`–724: 製品ランナーもゲートを `detached: true` で別グループに起こし、owner は `pid: process.pid`（`machine-lock.ts:585`）だけ。サーバーが SIGKILL で死ぬと同じ形で回収される（見立て）。TS には `setOwnerFields` に当たる口が無い。
- `scripts/orchestrate/precheck.mjs:514`: 単独で走る precheck の重い段のロックも pgid 無し。precheck だけが死ぬと vitest・tsc の子が残る（見立て）。
- `verify-run.sh:1080`–1086 の見張り: 本体だけが死んだ後も `sleep timeoutSec` の後に `-G` へ signal を送る。G が先に空になり、その番号が別のプロセスのグループとして再利用されていると無関係なグループへ送る（見立て。今の実装にもある窓。§2.6 で見張りを公開の前に起こしても広がらない）。
- bash の `lock_json_field` が数でない `pid`／`pgid` の数字の接頭を読む（§4）。TS・同期 JS と判定が揃わない。

## 事前レビューの処置

レビュー: `workspace/orchestration/runs/2026-11-09/prereview/review-4288.md`（codex-2、静的レビュー）。

| 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|
| P1 更新前の owner を読んだ取得者が、同じ token で pgid を公開した後のロックを消せる | **採る** | 3 実装の回収は退かした token の一致だけで消す（`machine-lock.ts:465`、`machine-lock-sync.mjs:277`、`verify-run.sh:837`）ことをコードで確かめた。「書き換え中は本体が生きている」では、読んでから判定するまでの間の本体の死を除けない | §2.2 を新設。守る条件を「削除する最新の owner に死亡の条件が成立」と書き、公開で token を T1 に替える。token と中身の 1 対 1・死亡の単調性から 3 実装で成り立つことを file:line で示した。読み手・札は変えない（止める点は無し）。対照は §6「P1-1 の順序」（第 1 版の形を手で書いて消えることを示す陽性つき） |
| P1 G の確認・owner の公開に失敗しても exec する経路が残る | **採る** | 「確かめられなければ今の動き」は穴をそのまま残す | §2.3 に「ゲートを始めない条件」の表（group・token・tmp・mv・読み直し・取り下げ）と後始末、FAIL 125・retry しない・今の動作に戻さないを定義。対照は §6「P1-2 の失敗」 |
| P1 EXIT trap だけ直しても、通常終了・timeout の解放経路が保護されない | **採る** | `wait` は長だけを待ち（`:1089`）、timeout では見張りの KILL より先に見張りを止めて解放する（`:1103`・`:1109`）ことを確かめた | §2.5 を新設。全ての解放経路で `drain_group` の後にだけ解放、空にならなければ解放しない。保証から外すもの（別グループへ移した子孫）を明示。第 1 版の「正常終了の後に G に孤児が残っても解放する」を撤回 |
| P2 owner を残す判断は安全だが、取消し完了の保証が未定義 | **採る** | 合図の後・見張りの前に本体が死ぬと、TERM を無視するゲートを誰も KILL しない | §2.6 で取消しの責任（時点 × TERM／SIGKILL の表）と owner の保持を分けた。見張りを公開の前に起こす順に変え、窓を無くした。本体のグループごとの SIGKILL は「ロックは残る、G は timeout で止まらない」と範囲を明記。bash の trap を直接確かめる対照を §6 に置いた |
| P2 合図待ちの期限と、期限切れ時の親側処理 | **採る** | 本体の pid の再利用で無期限に待ちうる | §2.4。子が測る実時間の期限（30 秒）、`mkdir "$go"` 1 つでの取り合い、125（受け渡し）と 124（timeout）の区別と優先。期限が解くのは子の待ちだけで、ロックの回収は保証しないことも書いた。pid の再利用は実機未確認のまま |
| P2 静的な互換表と合図直前の停止だけでは検証できない | **採る** | 「pgid 無し → 同じ token の pgid 付き」の移り変わりは静的な表では表せない | §3 の経路表（11 時点 × SIGKILL／TERM × 3 実装）。§6 に止め所（`CM_VERIFY_TEST_HANDOFF`、読み手は既存の `__testHooks`）と、拒否／進むの対照の表 |
| P3 現行コードの事実の相違（空の token の解放、pgid の型） | **採る** | `:953` は空の token でも消す。bash の抽出は文字列・小数の数字の接頭を読む。TS・同期 JS は数の整数だけ | §1 の解放の記述を直した。§4 を 3 実装に分け、欠損・破損の owner と pid／pgid の型の行を足した。差異は変えず、テストで今の値を固定する。§2.3 の後始末で「読めない token では `lock_release` を呼ばない」に反映 |
