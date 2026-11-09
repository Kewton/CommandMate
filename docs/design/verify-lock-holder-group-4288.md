# verify-run.sh の保有者にゲートのグループを記録する（Issue #4288 の 1 番）

- 状態: 設計 第 4 版（Codex〔codex-2〕の事前レビュー 1 回目 `review-4288.md`・2 回目 `review-4288b.md`・3 回目 `review-4288c.md` の処置を反映。実装は同じブランチの別の契約）
- 行番号は 2026-11-09 の `fix/4288-verify-lock-pgid`（`169f5f892`。コードは `a69510b91` から変わっていない）のもの。名前で引くこと
- **事実**＝コード・記録で確かめたこと、**見立て**＝推したが試していないこと、**未確認**＝この段で確かめていないこと
- 第 1 版からの主な変更: owner の公開で **token を新しくする**（§2.2）。G の確認・公開に失敗したら**ゲートを始めない**（§2.3）。**解放は G が空になってから**（§2.5）。取消しの責任と owner の保持を分けた（§2.6）。合図待ちに実時間の期限（§2.4）
- 第 2 版からの主な変更: **読み手を変える**（§2.7。復元に失敗して残った `.gone-*` を「保有中」と読み、取得の `mkdir` をしない）。子は**合図を実際に見たときだけ**、受け取りの印 `ack` を作ってから exec する（§2.4。合図の作成の失敗を競合と取り違えない）。125／124 は `ack` の有無で決め、見張りの timeout は `ack` から数える（§2.4・§2.6）。公開の前に保持の変数（`LOCK_PENDING_TOKEN`）を立て、trap は owner の token を確かめて解放する（§2.6）。bash の読み手の試験は合成の対照と明記（§6）。破損 JSON の行を 2 つに分けた（§4）。末尾の「事前レビューの処置」に 2 回目を足した
- 第 3 版からの主な変更: `.gone-*` は**退避名の形に一致するものだけ**を読む（§2.7 の「退避名の識別」。別の合法な mutex `a.lock.gone-b` の実ロックを取り込まない）。owner の読み取りを**記録・欠損・破損・不明**に分け、不明（EACCES・EIO など）は空きとしない（§2.7 の「owner の読み取りの分類」）。排水に失敗したら**未排水の項目 `LOCK_UNDRAINED` を run の終わりまで保ち**、bash の解放は**owner の pgid のグループが空であることを解放の直前に確かめる**（§2.5・§2.6）。復元の途中（`mkdir <lock>` の後・owner の移動の前、owner の rename の失敗、移動の後）を**次の先頭が完了か回収できる**手順にした（§2.7 の表の 2〜4・6 と「復元の途中の状態」）。§2.7 を「先頭の 1 周の手順」の 1 つの表にまとめた。閉じていない引用の token を「抽出できる不正な JSON」の側へ移した（§4）。末尾の「事前レビューの処置」に 3 回目を足した

## 止める点

**無し。** 止める条件は「札（ticket）の形・#4277 の規約を変えないと塞げない」場合だけ（PM の判断で、読み手を変えてよい範囲に広がった。第 2 版の「同期 JS の変更は PM の止める条件」は撤回）。第 4 版で規則は増えたが、受け渡しの全体は §3 の 1 つの表（行 1〜18）で、読み手の先頭の判断は §2.7 の 1 つの表で説明できると判断したので止めない（範囲を絞る案は使わない。絞るなら「書き手の公開と排水だけ、復元の失敗の扱い〔§2.7〕は別 Issue」が自然な切れ目だが、§2.7 を外すと 2 回目のレビューの P1〔復元の失敗の後の claim〕が開いたままになる）。確かめたこと:

- 直しは `verify-run.sh`（`.claude`／`.agents` の 2 配置。`cmp` 一致）の書き手の側（§2.2〜§2.6）と、**3 実装の読み手の復元の失敗の扱い**（§2.7。bash `lock_acquire`／`lock_recover`／`lock_release`、TS `machine-lock.ts` の `breakStale`・取得のループ・`release`、同期 JS `machine-lock-sync.mjs` の `recoverLock`・取得のループ・`release`）。
- 札の形・中身・`token` は #4277 のまま（`docs/design/merge-queue-fair-lock-4277.md:90`、`docs/design/verification-config.md:533`）。札の token と owner の token を突き合わせる読み手は 3 実装とも無い（事実: bash の札は `lock_mark_done`／`lock_retire_own_ticket` が `$LOCK_TOKEN` だけを見る `verify-run.sh:768`・`:824`、TS・同期 JS の `markDone` も札の中の token だけ）。よって owner の token を取得の途中で 1 回替えても札の規約には触れない。
- #4277 の規約のうち「解放は owner の token が自分のときだけ」「回収は死んだと判定した token のときだけ消す」「戻せなければ退かしたものを消さずに残し、`machine-lock-restore-failed` を出す」（`verification-config.md:536`・`:537`、`merge-queue-fair-lock-4277.md:133`）はそのまま成り立つ。§2.7 は「残した `.gone-*` の記録が死ぬまでは取らない」と「途中で止まった復元を先頭が完了・回収する」を**足す**だけで、残す・消す・戻すの規約は変えない（`.gone-*` の名前の規約 `merge-queue-fair-lock-4277.md:88`・`:96` も変えない。§2.7 は今の 3 実装が実際に作る名前〔`<name>.lock.gone-<token>-<serial>`〕に一致するものだけを読む、という**読む側の絞り込み**で、書く名前は変えない）。説明（`verification-config.md:531`・`:537`、`SKILL.md:286`）に足す文は §5 に書き、実装の契約で行う。

## 1. 今の順序（事実）

`.claude/skills/cmate-verify/scripts/verify-run.sh`:

| 順 | 箇所 | 中身 |
|---|---|---|
| 1 | `:853` `lock_acquire`、`:904`–906 | `mkdir "$LOCK_PATH"` の直後に `printf '{"pid":$$,"host","token","acquiredAt"}' > owner`。**pgid は書かない**。`LOCK_TOKEN` は取得のたびに新しく作る（`:858`） |
| 2 | `:1066`–1068 `run_gate_attempt` | `set -m; ( cd && exec /bin/sh -c "$rga_cmd" ) &; rga_pid=$!; set +m`。ゲートは自分のグループ G（=rga_pid）の長になり、**fork の直後に走り出す** |
| 3 | `:1077`–1078 | `ps -o pgid=` で G=rga_pid を確かめ、取消しの宛先 `rga_target=-G`（確かめられなければ pid） |
| 4 | `:1080`–1086 | 見張り（watchdog）。`sleep timeoutSec` → 印 `$rga_mark` → `kill -TERM -- -G` → `KILL_GRACE_SEC`（`:70`、5 秒） → `kill -KILL -- -G`。見張りは**本体のグループ**に居て、**fork の時点から数える** |
| 5 | `:1089`、`:1103`、`:1109` | `wait` は**グループの長**だけを待つ → 見張りを KILL → `lock_release`。**G に残った子を見ずに解放する** |
| 6 | `:130`、`:960`–963 | EXIT trap（`cleanup_workdir`）→ `lock_cleanup_on_exit` → 持っていれば `lock_release "$LOCK_HELD_PATH" "$LOCK_HELD_TOKEN"`。**G を見ない**。`cleanup_workdir` は `BASH_SUBSHELL` が 0 のときだけ動く（`:125`）ので、fork した子・見張りが signal で死んでも解放は走らない |

`lock_release`（`:946`–955）は、読んだ token が自分のとき**だけでなく、空のときも** `rm -rf` する（`:953` の条件は「空でなく、かつ違う」ときだけ戻る）。TS・同期 JS の `release` は `readOwner(lockPath)?.token !== token` で戻る（`machine-lock.ts:602`、`machine-lock-sync.mjs:407`）ので、owner が欠けている・壊れているときは**消さない**。既存の差異（§4）。

回収の判定と削除:

| 実装 | 判定 | 削除の条件 | 復元に失敗したとき |
|---|---|---|---|
| bash | `:914` で token を読み（`la_token`）、`:917` の `lock_record_gone` が **pid・host・pgid をその順にそれぞれその時点のファイルから読み直す**（`:705`–707） | `lock_recover`（`:833`）: ディレクトリを `.gone-*` へ `mv` し、退かした owner の token が `la_token` と同じときだけ `rm -rf`（`:837`）。違えば戻す | `mkdir "$1"` の失敗で `machine-lock-restore-failed` を出して `return 0`（`:842`–845）。呼び手は `continue`（`:920`）し、次の周回の `mkdir "$LOCK_PATH"`（`:904`）が**成功しうる** |
| TS | `:616` で `readOwner` した**記録をそのまま** `holderGone`（`:302`–306）に渡す | `breakStale`（`:449`）: rename で退かし、`moved.token === owner.token`（`:465`）のときだけ消す | `mkdirSync(lockPath)` の失敗で警告して `return`（`:470`–474）。呼び手は `continue`（`:619`–620）し、次の周回の `claim`（`:432`）が**成功しうる** |
| 同期 JS | `:421` で `readOwner` した記録を `holderGone`（`:157`–161）に渡す | `recoverLock`（`:266`）: 同じ形、`moved.token === dead.token`（`:277`） | `'restore-failed'` を返す（`:282`–286）が、呼び手は戻り値を見ずに `continue`（`:426`–427）。次の `claim`（`:247`）が**成功しうる** |

3 実装とも、**削除の最後の決め手は「退かした owner の token が、判定に使った token と同じか」だけ**。判定に使った記録の中身（pgid の有無）とは突き合わせない。そして**復元の失敗は「次の周回で取ってよい」に化ける**（#4277 は「戻せない＝もう新しいロックが在る（旧版の掃除が入れた）」を前提にしていた。`merge-queue-fair-lock-4277.md:133`。ENOSPC・EACCES・一時的な失敗では新しいロックは無く、`mkdir` が通る）。

repro-1.md の `ps`（bash: holder alive）: 本体 `57531 PGID 57531`、ゲート `57615 PGID 57615 PPID 57531`、見張り `57619 PGID 57531`。本体だけ SIGKILL の後、ゲートは `PPID 1` で生き、**見張り 57619 も生きている**（本体のグループに居て、本体への signal は届かない）。owner は `{"pid":57531,…}`（pgid 無し）のまま。bash も TS（`timeoutMs:0`）も stale として回収し、旧ゲートと新しい保有者が同時に動いた。**本体の pgid（57531）は G と違う**ので、本体の pgid を足しても G を代表しない。

## 2. 設計

### 2.1 何に生存を代表させるか（第 1 版から変えない）

| 案 | 評価 |
|---|---|
| A 本体を新しいグループの長にし、ゲートも同じグループへ | 不採用。bash 3.2・macOS に `setsid(1)` が無く、本体のグループは呼び手が決める。同じグループだと見張りの `kill -- -G` が本体まで殺す |
| B 本体の pgid を書く | 不採用。G と違う（上の ps）。呼び手の非対話シェルのグループなら呼び手が生きる間ずっと「生存」になる |
| C ゲートごとに owner の pgid を G に書き換える（起動の後） | 方向は正しいが、fork から書き換えまでの窓で本体が死ぬと、pgid 無しのまま回収されてゲートが走る |
| D 代表のプロセスを別に置く | 不採用。代表の pid も fork の後にしか分からず C と同じ窓が残る |
| **E（採用）= C ＋ 起動の受け渡し ＋ token の更新 ＋ 復元の失敗を保有中と読む** | ゲートの子を「合図を見て受け取りの印を作るまで exec しない」形で起こし、本体が owner に G を **新しい token で** 公開してから合図を出す。回収者は token の不一致で戻すが、戻せなければ戻せるか記録が死ぬまで取らない |

E は **mutex を持つゲートだけ**に当てる。mutex の無いゲートは今のまま（受け渡しも排水もしない）。§2.7 の読み手の変更は全てのロックの名前に効く（merge-pr・precheck のロックも同じ取得の関数を通る）。

### 2.2 守る条件と、token の更新

**守る条件**: 回収者が削除する owner の記録（＝削除の瞬間の最新の owner）について、死亡の条件（同じ host・pid が ESRCH・pgid があればそのグループも ESRCH）が成立していること。**加えて**、退かした記録が判定に使った token と違うとき、その記録を元へ戻すか、その記録が死ぬまで、誰も `mkdir` で取らないこと（§2.7）。

第 1 版（同じ token のまま pgid を足す）では前半が成り立たない。TS・同期 JS は判定に**読んだ時点の記録**を使い、削除は token の一致だけで決める（§1 の表）。次の順序で、新しい G が生きているのに消える:

1. 待ち手 W が owner `{pid:B, token:T0}`（pgid 無し）を読む（TS `:616`、同期 JS `:421`）。
2. 本体 B が同じ token T0 で `{…, token:T0, pgid:G}` を公開し、合図を出し、ゲートが走る。
3. B だけが死ぬ。
4. W が 1 の記録で `holderGone` → pid は ESRCH、pgid は無い → 死んだと判定。
5. `breakStale`／`recoverLock` が退かした owner の token は T0 ＝判定の token → **G が生きたまま消える**。

**bash は同じ順序を実プロセスでは作れない**（第 2 版の「TS と同じ穴」を直す）。`lock_record_gone`（`:705`–707）は pid を読んで ESRCH を確かめ、その**後で** pgid を読む。pid が ESRCH なら B は死んでいて、B 自身の書き込みはもう起きない。残るのは「B が起こした公開の `mv` のプロセスが、B の死の後に owner を T1 へ置き換える」窓だけで（見立て。`mv` は別プロセスなので親の SIGKILL では止まらない）、そのとき pgid の読みが空でも、`lock_recover` の比較（`:837`）は退かした T1 と `la_token`=T0 が違うので戻す。よって bash の穴は「フィールドの読みがまたがる」形でしか表れず、試験は合成の対照になる（§6）。

**直し: owner の公開で token を新しくする。** 公開する記録は `{"pid":B,"host","token":T1,"acquiredAt","pgid":G}`、`T1 = "$LOCK_TOKEN-g$G"`（`$LOCK_TOKEN` は札の token のまま変えない。保持の変数は §2.6 の順で T1 にする）。

効く理由（3 実装の回収のコードで確かめた）:

- **token と記録の中身が 1 対 1**: 1 つの取得で owner を書くのは本体だけで、T0（pgid 無し）を 1 回、T1（pgid:G）を 1 回。同じ token で中身が変わることが無い。
- **TS**（`breakStale`、`machine-lock.ts:465`）・**同期 JS**（`recoverLock`、`machine-lock-sync.mjs:277`）: 判定に使った記録が T0 で、退かした owner が T1 なら一致しない → 戻す（戻せなければ §2.7）。戻した後の次の周回で T1 を読み、`broken` の Set（`machine-lock.ts:618`、`machine-lock-sync.mjs:423`）に T1 は無いので改めて判定する。G が生きていれば `groupAlive` が真で待つ。G が空になれば T1 で判定し、退かした owner も T1 なので消す。
- **bash**（`lock_recover`、`verify-run.sh:837`）: 比較は `la_token`（`:914` で読んだ値）。退かした owner が T1 なら `la_token`=T0 と一致しない → 戻す。`la_broken`（`:918`）は T0 だけを覚えるので、次の周回の T1 は判定される。退かした owner が T0 なら公開は起きていない（公開は一方向で T1 から T0 へ戻らない）ので、全ての読みは T0 の記録で、判定は T0 について正しい。
- **死亡は単調**: T0 の死亡（pid ESRCH）の後に B が蘇ることは無い。T1 の死亡（pid ESRCH かつ G が ESRCH）の後に G に人が戻ることも無い（空のグループは存在せず、`setpgid` で入れない。同じ番号の新しいグループは pid の再利用で、無関係なプロセス）。よって「判定した token と退かした token が同じ」なら、削除する最新の owner に死亡の条件が成り立つ。
- **公開の途中で本体が死ぬ**: 本体が SIGKILL で死んでも、公開の `mv` のプロセスが後から owner を T1 に置き換えることはありうる。そのとき合図は出ていない（合図は公開の確認の後、§2.3）ので子は exec せず（§2.4）、G は空になる。T0 で判定した待ち手は token の不一致で戻し、T1 で判定し直す（1 周の遅れだけ）。
- **生きている本体の公開を横取りされない**: 新しい実装の待ち手は pid が生きている間は回収しない（3 実装とも `pidAlive`／`kill -0` が先）。公開の直前の token の確かめと `mv` の間にディレクトリが退かされるのは、旧版（#4277 以前）の掃除だけで、それは #4277 §0 B' の「範囲外」。

検討して採らなかった案: (a) 読み手に「退かした記録の pgid も判定に使う」だけを足す — 退かした記録が生きていれば結局戻す必要があり、戻せないときの穴（§2.7）はそのまま残る。token の更新で前半の条件が揃い、後半は §2.7 で塞ぐので、(a) は足さない。(b) 公開の前に owner を消す — 空の owner は bash の解放が消す（`:953`）・TS は待つ、と実装で揃わない。

### 2.3 起動の受け渡し（失敗したらゲートを始めない）

`run_gate_attempt` の mutex ありの経路だけ（見立て、実装で実測）:

1. 試行ごとに一意な合図のパス `go="$rga_log.go"` と受け取りの印 `ack="$rga_log.ack"` を決め、残っていれば消す（`$rga_log` は試行ごとに別名で、`$WORKDIR` は run ごとの `mktemp -d`。`verify-run.sh:109`・`:1149`・`:1178`）。子と見張りに渡す受け渡しの期限 `rga_handoff_deadline=$(( $(date +%s) + HANDOFF_WAIT_SEC ))` を fork の前に本体が決める（絶対時刻。子と見張りで同じ値）。
2. `set -m; ( 待ち ; cd "$CWD" && exec /bin/sh -c "$rga_cmd" ) > "$rga_log" 2>&1 &`。待ちは §2.4。
3. `ps -o pgid=` で G=rga_pid を確かめる。G をグローバルの `LOCK_GATE_GROUP` に置く（trap が読む。§2.6）。
4. 見張りを起こす（§2.6。**公開の前に起こす**が、timeout は `ack` から数える）。
5. `LOCK_PENDING_TOKEN=T1` を立てる（§2.6）→ owner の token が T0（自分）か確かめる → `$LOCK_PATH/.owner-$T1` に T1 の記録を書く → `mv -f` で `owner` へ（同じディレクトリ内の rename。読み手は旧か新のどちらかしか見ない）→ 読み直して token が T1・pgid が G であることを確かめる。
6. `mkdir "$go"`。成功したら合図を出したことになる。失敗したら `[ -d "$go" ]` で区別する: 在る＝子が先に取り下げた（`stage=abort`）、無い＝作成の失敗（`stage=signal`。ENOSPC・EACCES・親の消失）。どちらも合図は出ていない。
7. 合図に成功したら `LOCK_HELD_TOKEN=T1`・`rga_lock_token=T1` にしてから `LOCK_PENDING_TOKEN=""`（§2.6 の順）。

**ゲートを始めない条件**（どれか 1 つで、合図を出さない。出した後でも子が `ack` を作れなければ exec しない）:

| 失敗 | 判定 | stage |
|---|---|---|
| G を確かめられない（`ps` の失敗、job control が効かず pgid≠pid） | 3 | `group` |
| 公開の前の token が T0 でない（読めない・空・他人） | 5 の前段 | `token` |
| tmp の書き込みの失敗（ENOSPC・ディレクトリが無い） | 5 | `tmp` |
| `mv` の失敗 | 5 | `mv` |
| 読み直した owner が T1／G でない（ディレクトリが `.gone-*` へ退かされた場合を含む） | 5 の後段 | `verify` |
| 子が先に `mkdir "$go"` した（期限切れ・本体の死を見た） | 6 | `abort` |
| 本体の `mkdir "$go"` が競合以外で失敗した | 6 | `signal` |
| 合図の後、子が `ack` を作れなかった（子は exec せずに exit 125） | §2.4 | `ack` |

失敗したときの本体の後始末: 見張りを KILL、子のグループ（確かめられなければ子の pid）を KILL して `wait`（子は待ちのループの sh で、何も始めていない。`ack` の失敗のときも exec していない）。解放は**その時点の owner の token** で行う: T1 なら T1、T0 なら T0、それ以外（他人・読めない）なら `lock_release` を呼ばない（空の token でも消すので）。owner が `.gone-*` に在る自分の記録なら §2.7 の「自分の `.gone-*` の片付け」で消す。結果は `RGA_STATUS=handoff-fail`、出力は既存の文法のまま `GATE <id> FAIL exit=125`、stderr に `verify-run: machine-lock-handoff-failed <lock> stage=<group|token|tmp|mv|verify|abort|signal|ack>`。**再試行（`retryOnFail`）の対象にしない**（ゲートは走っていないので、FLAKY に化けさせない）。`SKIP reason=<新しい語>` にしなかったのは、`reason=` の語は CommandMate の読み手が解釈する出力の契約で、語を増やすと別の改訂になるため。

**今の動作に戻さない**: job control が効かない環境では、mutex 付きのゲートは毎回 FAIL 125 になる（黙って排他の無い実行をするより、大きく落ちる方を選ぶ）。mutex の無いゲートは影響を受けない。

### 2.4 合図待ち、受け取りの印、125／124

子の待ちの中身（bash のサブシェル。`$LOCK_SELF_PID`＝本体の pid、`verify-run.sh:622`。bash 3.2 に `BASHPID` は無い）:

```
while :; do
  if [ -d "$go" ]; then break; fi                      # 合図を見た
  if ! kill -0 "$LOCK_SELF_PID" 2>/dev/null || [ "$(date +%s)" -ge "$rga_handoff_deadline" ]; then
    if mkdir "$go" 2>/dev/null; then exit 125; fi      # 取り下げに勝った＝合図は二度と出ない
    if [ -d "$go" ]; then break; fi                    # 負けた＝本体が直前に合図を出した
    exit 125                                           # 作成の失敗（合図を確かめられない）＝exec しない
  fi
  sleep 0.05 2>/dev/null || sleep 1
done
mkdir "$ack" 2>/dev/null || exit 125                   # 受け取りの印。作れなければ exec しない
cd "$CWD" && exec /bin/sh -c "$rga_cmd"
```

- **exec の条件は「`go` がディレクトリとして在るのを見た」かつ「`ack` を作れた」の 2 つ**。`go` を作るのは本体の合図か子の取り下げだけで、子が取り下げたら子は exit するので、子が `go` を見たなら本体が作った（＝公開の確認の後）。子の `mkdir "$go"` の失敗は、`[ -d "$go" ]` が真のとき（競合に負けた）だけ合図と読み、偽のとき（ENOSPC・EACCES・親の消失）は exec しない。第 2 版の `mkdir "$go" && exit 125; break` は失敗を全て「本体が先に作った」と読み、合図なしで exec しえた（2 回目のレビューの P1）。
- **本体が「走ったか」を知るのは `ack` だけ**。子の終了コード 125 では判定しない（ゲート自身が 125 で終わることはある）。本体は長の `wait` の後に `[ -d "$ack" ]` を見る: 無ければゲートは走っていない → `handoff-fail`（`stage=ack`。合図を出していなければ §2.3 の stage）→ **125**。在れば今のまま、見張りの印 `$rga_mark` があれば **124**、無ければゲートの終了コード。`ack` の後の `cd` の失敗は今と同じ（`cd` の失敗はゲートの失敗として出る）。
- **見張りは `ack` を見てから timeout を数える**（§2.6）ので、合図の前に見張りが待ちの子を TERM することは無い。よって「`ack` が無いのに timeout の印がある」は起きず、125 と 124 は重ならない。第 2 版の「見張りは fork から数え、両方立てば 125 を優先」は、合図の前に見張りが子を終わらせた後で本体の `mkdir "$go"` が成功し、本体が合図できたと思い込んで 124 にする経路を残していた（2 回目のレビューの P2）。
- 期限 `HANDOFF_WAIT_SEC` は 30 秒（本体の 3〜6 は通常ミリ秒。負荷の高いときの `ps` の遅さを見込む）。**子が `date +%s` で測る実時間**で、本体の pid が再利用されて `kill -0` が成功し続けても期限で終わる。テストだけが `CM_VERIFY_TEST_HANDOFF_WAIT_SEC` で縮める。
- 期限が解くのは**子の待ち**だけ。owner の pid が再利用されていれば、既存の回収の規約（pid が生きていれば回収しない）によりロックは再利用されたプロセスが終わるまで残る（待つ側。今と同じ）。実機での pid の再利用は**未確認**。
- 子が TERM・KILL で待ちの途中に死んでも、`cleanup_workdir` は `BASH_SUBSHELL` が 0 のときだけ動く（`:125`）ので、子が本体のロックを解放することは無い（事実。Issue #228 の守り）。

### 2.5 解放は G が空になってから

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

- `drain_group` が 1（KILL の後も空にならない: D 状態・権限の違う子）を返したら**解放しない**。owner（T1、pgid:G）は残り、本体が生きている間は誰も回収しない（pid が生きている）。本体が終われば、G が空になった時点で列の先頭が回収する。待つ側に倒す。
- **排水の失敗を忘れない**（3 回目のレビューの P1）。第 3 版は「どの戻り口でも `LOCK_GATE_GROUP` を空にする」としつつ `LOCK_HELD_PATH`／`LOCK_HELD_TOKEN`（T1）を残したので、最後の EXIT trap が G を見ずに token の一致だけで消せた。第 4 版は次の 2 つを両方入れる（どちらか片方が漏れても、もう片方で解放しない）:
  1. **未排水の状態を保つ**: 排水が 1 を返したら、`<lock のパス> <T1> <G>` の 1 行を run のグローバル `LOCK_UNDRAINED`（改行区切り。run の終わりまで消さない）に足し、`LOCK_HELD_PATH`／`LOCK_HELD_TOKEN` はそのまま残す（空にしない）。`LOCK_GATE_GROUP` は試行の変数なので空にするが、G は `LOCK_UNDRAINED` に残る。
  2. **解放の直前に owner の pgid で確かめる**: bash の `lock_release` は、消す前に owner の `pgid` を読み、1 より大きい整数で `kill -0 -- -<pgid>` が成功する（グループに人が居る）なら**消さずに戻る**（stderr に `verify-run: machine-lock-release-deferred <lock> pgid=<pgid>`）。この確かめは呼び手の変数を見ない（trap・通常終了・次のゲート・受け渡しの失敗の全てが `lock_release` を通る）。merge-pr の内側の記録（`machine-lock-sync.mjs` が書く `pgid`）を verify-run.sh が解放することは無い（token が違う）ので、影響は verify-run.sh 自身の T1 だけ。
- 未排水の項目の扱い（経路ごと）:

| 経路 | 動き |
|---|---|
| この run の通常の終了（EXIT trap） | `LOCK_UNDRAINED` の各行について `drain_group <G>` をもう一度行い、`lock_release <path> <T1>`（2 の確かめつき）。空なら解放、空でなければ残す |
| 次のゲート（同じ mutex） | `lock_acquire` の前に、同じパスの行があれば排水し直す。空になれば解放して行を消し、通常の取得へ。空でなければ通常の取得へ進む（owner の pid＝自分が生きているので回収されず、予算切れで `SKIP reason=mutex-wait`。二重には走らない） |
| 次のゲート（別の mutex） | 通常の取得。`LOCK_HELD_*` は新しいロックで上書きされるが、前のロックは `LOCK_UNDRAINED` に残り、trap が 1 行目の扱いをする |
| 本体へ TERM | trap が 1 行目の扱い（`LOCK_GATE_GROUP` の排水の後、`LOCK_UNDRAINED` の各行） |
| 本体だけ SIGKILL | 何も走らない。owner（T1、G）が残り、G が空になるまで 3 実装とも回収しない（§3 の 11） |

- **保証から外すもの**（明示する）: ゲートが自分で別のグループ・セッションへ移した子孫（`setsid`・`set -m` の入れ子・デーモン化）。G に居ないので排水も回収の判定も見ない。今の timeout の取消しと同じ範囲。
- `RGA_DUR`（ゲートの所要）は長の終了までで測り、排水の時間を足さない（`verify-run.sh:1002` の注記と同じ理由）。
- 行動の変化: mutex 付きのゲートが成功の後に背景の子を残していた場合、今は解放後も走り続けたが、新しくは止められる。mutex の無いゲートは変えない。

### 2.6 取消しの責任、見張り、owner の保持

**見張り**（mutex ありの経路。mutex の無い経路は今のまま）:

```
( while [ ! -d "$ack" ]; do
    kill -0 -- "-$G" 2>/dev/null || exit 0     # 子が exec せずに終わった（取り下げ・ack の失敗・KILL）
    sleep 0.05 2>/dev/null || sleep 1
  done
  sleep "$rga_to"; : > "$rga_mark"; kill -TERM -- -G; sleep "$KILL_GRACE_SEC"; kill -KILL -- -G
) &
```

- 起こすのは公開の前（§2.3 の 4）。合図の後に本体だけが SIGKILL されても、`ack` を見た見張りが G を timeout で止める。timeout はゲートが実際に走り出した時点から数えるので、受け渡しにかかった時間がゲートの持ち時間を削らない。
- 本体が `ack` の前に死ぬと、子は取り下げるか期限で exit し、G は空になり、見張りは `kill -0` の失敗で黙って終わる。G の番号の再利用で `kill -0` が成功し続けた場合は待ち続けるが、signal は送らない（`ack` は来ない）。見張りは本体のグループに居るので、本体のグループごとの KILL で終わる（見立て。今の見張りの `sleep` と同じ残り方）。

**取消しの責任**（TERM → 猶予 → KILL を最後まで送るのは誰か）:

| 時点 | 本体が TERM／INT を受けた（EXIT trap が走る） | 本体だけが SIGKILL |
|---|---|---|
| 見張りの起動の前（取得済み〜G の確認） | trap: 子（合図待ちの sh）を KILL。解放 | 子は本体の死を見て取り下げ（exit 125）。ゲートは走らない |
| 見張りの起動後・合図の前（公開の前後を含む） | trap: G を排水（待ちの子は TERM で終わる）、見張りを KILL。owner の token を確かめて解放（下の「trap の解放」） | 同上。見張りは `ack` を見ないまま G が空になって終わる |
| 合図の後（実行中） | trap: `drain_group G`（TERM→猶予→KILL）。空になれば見張りを KILL して解放 | **見張りが**（本体のグループに居て生き残る。repro の 57619）`ack` から timeoutSec の後に TERM→猶予→KILL を送る。それまで owner（T1、G）が生きていて回収されない |
| 排水中（長の終了後） | trap: 続きの `drain_group` | 見張りは既に KILL 済み。G の残りは自然に終わるまで走り、その間ロックは残る（待つ側） |

**保持の変数の順**（2 回目のレビューの P2。公開の後・合図の前の TERM で owner=T1・保持の変数=T0 になる窓を塞ぐ）:

1. 公開の tmp を書く**前**に `LOCK_PENDING_TOKEN=T1`。
2. 合図に成功したら `LOCK_HELD_TOKEN=T1`、`rga_lock_token=T1`、それから `LOCK_PENDING_TOKEN=""`。
3. 受け渡しの失敗・解放・trap の後は `LOCK_PENDING_TOKEN`・`LOCK_GATE_GROUP` を必ず空にする（`run_gate_attempt` のどの戻り口でも）。**ただし排水に失敗した G は、空にする前に `LOCK_UNDRAINED` へ移す**（§2.5）。`LOCK_UNDRAINED` は試行・ゲートをまたいで残り、空にするのは排水し直して解放できた行だけ。

**trap の解放**（`lock_cleanup_on_exit`）: `LOCK_GATE_GROUP` があれば先に `drain_group`（失敗すれば `LOCK_UNDRAINED` へ移す）。次に `LOCK_UNDRAINED` の各行を §2.5 の表の 1 行目のとおり扱う。次に owner の token を読み、`LOCK_HELD_TOKEN` か `LOCK_PENDING_TOKEN` のどちらかと一致すればその token で `lock_release`。どちらとも違う（他人）・読めないなら解放しない（空の token の `lock_release` は消すので呼ばない）。owner が無く、自分の token の `.gone-*` があれば §2.7 の片付け。こうすると、公開の `mv` の前後どちらで TERM が来ても、その時点の owner（T0 か T1）が自分のものなら解放される。

- **retry と次のゲートで前の token を使わない**: 2 回目の試行は `lock_acquire` で新しい `LOCK_TOKEN`（T0'）を作り（`:858`）、T1' はそこから作る。`rga_lock_token` は試行の始めに空にする（`:1019`、今のまま）。`LOCK_PENDING_TOKEN` は 3 で空にする。よって 2 回目の解放・trap は T0'／T1' しか見ない。§6 で固定する。
- trap の解放も `lock_release` を通るので、§2.5 の 2（owner の pgid のグループが空でなければ消さない）が最後の守りになる。`LOCK_HELD_TOKEN` が T1 のまま残っていても、G に人が居れば消えない。
- **owner の保持**（空を確かめられないとき）: trap の `drain_group` が 1 を返したとき、または trap が終わる前に本体が SIGKILL で切られたとき（呼び手が TERM の後に KILL を送るなど）は、owner を**残す**。T1 なら pid が死に G が空になった時点で列の先頭が回収する。T0（合図の前）なら子は取り下げるので、pid の死で回収してよい。
- 本体のグループごと SIGKILL されると見張りも死ぬ。そのとき G は自然に終わるまで走り、ロックはそれまで残る（待つ側に倒れる。保証は「ロックは G が空になるまで回収されない」で、「G が timeout で止まる」までは含めない）。
- 既存の `gate-cancel-2063`・`gate-slot-cancel-3909` は TS の `startVerification` 経由で、bash の EXIT trap を直接は確かめない。§6 で bash の trap を直接に固定する。

### 2.7 復元に失敗した `.gone-*` を保有中と読む（読み手の変更）

2 回目のレビューの P1: 「古い T0 を読む → T1 公開・ゲート開始 → 本体の死 → T1 を退かす → 復元の `mkdir` が一時的に失敗 → 次の claim が成功」で、G が生きたまま 2 者が走る（§1 の表の右の列。3 実装とも）。token の更新でこの復元の経路は新しい実装どうしでも通るので、塞ぐのは読み手。3 回目のレビューで、第 3 版の規則に「別の mutex を取り込む」「読み取りのエラーを空きと読む」「復元の途中で止まると owner の無い `<lock>` が永久に残る」の 3 つの穴が見つかったので、手順を 1 つの表にまとめ直した。

**退避名の識別**（3 実装で同じ。3 回目のレビューの P1-1）:

- 対象は lock root の直下の項目のうち、名前が `<name>.lock.gone-` ＋ **S** で、S が空でなく `^[A-Za-z0-9-]+$` に一致し（**`.` と `_` を含まない**）、`lstat` で**ディレクトリ**（シンボリックリンクでない）のものだけ。bash は `"$LOCK_PATH".gone-*` を展開したあと接頭を外した S を `case "$S" in ''|*[!A-Za-z0-9-]*) 対象外 ;; esac` で絞り、`[ -d ] && [ ! -L ]` を見る。TS・同期 JS は `readdirSync(root)` の名前に同じ正規表現と `lstatSync().isDirectory()`。
- 根拠（事実）: 今の 3 実装が作る退避名は `<lockPath>.gone-<token>-<serial>`（`machine-lock.ts:455`、`machine-lock-sync.mjs:267`、`verify-run.sh:835`）。token は TS・同期 JS が `randomUUID()`（16 進と `-`。`machine-lock.ts:508`、`machine-lock-sync.mjs:339`）、bash が `$$-<epoch>-<数字>`（`verify-run.sh:858`）、serial は数字。どれも S は `[A-Za-z0-9-]` だけで `.` を含まない。
- 別の mutex を取り込まない理由（事実）: mutex の名前は `^[A-Za-z0-9_.-]+$`（`verify-config.ts:230`）なので `a.lock.gone-b` は合法で、その root 直下の項目は `a.lock.gone-b.lock`・`a.lock.gone-b.queue`・`a.lock.gone-b.lock.gone-…` の 3 形だけ（札の一時ファイル `.t-*`・`.d-*` は `.queue/` の中、owner の一時ファイル `.owner-*` は `.lock/` の中）。どれも `a.lock.gone-` の後ろに `.` を含むので、mutex `a` の対象にならない。逆向き（mutex `a.lock.gone-b` が `a` の項目を読む）は、`a` の項目が `a.lock.gone-b.lock.gone-` で始まらないので起きない。`merge-queue-fair-lock-4277.md:96` の「`<name>.lock.gone-*` も衝突しない」は、glob のまま読むと誤り（本文に無い指摘）。名前の規約は変えず、読む側を絞る。
- 解放の片付け（下の表の 7）・回収（4）で自分が作る退避名も同じ形（`<lockPath>.gone-<自分の token>-<serial>`）。

**owner の読み取りの分類**（3 実装で同じ。3 回目のレビューの P1-3）: `.gone-*` の `owner` を読んだ結果を 4 つに分ける。主のロック `<lock>/owner` の今の読み（`readOwner` が null なら待つ）は変えない。

| 分類 | 条件 | 扱い |
|---|---|---|
| 記録 | 読めて、pid が数・token が文字列（TS・同期 JS の `readOwner` と同じ条件。bash は `lock_json_field` で token が空でない） | `holderGone` で生死を決める |
| 欠損 | `.gone-*` が探索可能で、`owner` が無い（Node: `ENOENT`。bash: `[ -x "$g" ] && [ ! -e "$g/owner" ] && [ ! -L "$g/owner" ]`） | 塞がない（第 3 版の規則 5 のまま。#4277 からある「owner を書く前に退かされた」窓の残骸と、下の「復元の途中の状態」の C の残骸） |
| 破損 | 読めたが記録の条件を満たさない | 塞がない。新しい書き手の T1 は `mv` の後に読み直して確かめる（§2.3 の 5）ので、破損した T1 の後でゲートが走ることは無い |
| **不明** | 上のどれでもない: 読み取りのエラー（Node: `ENOENT` 以外の例外。EACCES・EIO・EISDIR・ELOOP など）。bash: `.gone-*` が探索できない（`[ ! -x "$g" ]`）、`owner` が在るのに読めない（`[ -e ] && [ ! -r ]`）、`awk` が 0 以外で終わる。lock root の一覧（`readdirSync`／glob の展開）が失敗した場合も、全体を不明とする | **空きとしない**: その周回は `mkdir` をせずに待つ（`heldBy` は `… (restore pending: <gone> unreadable)`、stderr／警告に `machine-lock-gone-unreadable <gone> <code>` を `.gone-*` ごとに 1 回）。回収も復元もしない。読み取りが回復した周回から、記録・欠損・破損として扱い直す |

- 第 3 版の「T1 は原子的に書くので常に読める」は撤回する。原子的な書き込みは**中身**が欠けないことしか保証せず、権限・I/O のエラーで読めないことはある。今の TS・同期 JS は読み取りのエラーも null にする（`machine-lock.ts:220`、`machine-lock-sync.mjs:96`–108）ので、`.gone-*` の読みには例外の `code` を返す別の関数（`readGoneOwner`）を足し、`readOwner` は変えない。bash は `lock_json_field` の `[ -f ] || return 0` と `2>/dev/null` で同じく区別できないので、`.gone-*` の読みの前に上の `-x`／`-e`／`-r` を見て、`awk` の終了コードを捨てない。

**先頭の 1 周の手順**（3 実装で同じ。#4277 のとおり、列の先頭だけが行う。既存の主のロックの回収〔`lock_recover`／`breakStale`／`recoverLock`〕の前に行う）:

| # | 見たもの（識別した `.gone-*` ごと。複数あれば全部） | すること | その周回の `mkdir <lock>` |
|---|---|---|---|
| 1 | lock root の一覧が失敗、または `.gone-*` の owner が**不明** | 何もしない（警告だけ） | しない（待つ） |
| 2 | 記録・**生きている**（`holderGone` が偽: pid が生きている・G に人が居る・別 host）、`<lock>` が**無い** | **戻す**: `mkdir <lock>` → `rename(<gone>/owner, <lock>/owner)` → `rm -rf <gone>`。`mkdir` が EEXIST なら次の周回で 3 か 4。`mkdir` がそれ以外で失敗したら `.gone-*` は残る（1 周の後にまた 2）。`rename` が ENOENT 以外で失敗したら `rmdir <lock>`（空のときだけ消える）で 2 の前の状態に戻し（`.gone-*` は消さない）、警告 `machine-lock-restore-failed`。ENOENT（別の先頭が先に移した）なら何もしない | しない |
| 3 | 記録・生きている、`<lock>` が在り、`<lock>/owner` が**欠損**で `<lock>` が空 | **復元の途中の完了**（下の A）: `rename(<gone>/owner, <lock>/owner)` → `rm -rf <gone>`。失敗すれば何もしない（次の周回でまた 3） | しない |
| 4 | 記録・**死んでいる**（`holderGone` が真） | `<lock>` が在り、owner が欠損で空なら、先に `rmdir <lock>`（復元の途中の回収、下の A・B。空でなければ消えない）。次に `.gone-*` を回収する: 自分の退避名へ `rename` し、owner の token が 1 で読んだものと同じなら `rm -rf`、違えば戻さずに残す（次の周回で読み直す） | その周回の他の `.gone-*` が 1〜3 に当たらなければする |
| 5 | 記録・生きている、`<lock>` に別の記録の owner | 何もしない。警告 `machine-lock-restore-failed`（旧版が取った場合。#4277 §0 B' の範囲外） | しない（`<lock>` が在るので通らない） |
| 6 | 欠損・破損 | 欠損で `.gone-*` が空なら `rmdir <gone>`（下の C の片付け。空でなければ消えない）。破損は残す | 他の `.gone-*` が 1〜3 に当たらなければする |
| 7 | （解放のとき）`<lock>/owner` が自分でなく、owner の token が自分（bash は `LOCK_HELD_TOKEN`／`LOCK_PENDING_TOKEN`／`LOCK_UNDRAINED` の T1）の `.gone-*` | 4 と同じ退かして確かめる手順で消す（第 3 版の規則 4。保有者が生きている間に復元が失敗し続けたとき、解放の後もロックが塞がり続けるのを防ぐ）。bash では §2.5 の 2 と同じく、その記録の pgid のグループに人が居れば消さない | — |

**復元の途中の状態**（3 回目のレビューの P2）。今の復元は `mkdir <lock>` → owner の `rename` → `.gone-*` の削除の 3 段で、途中で止まると次の 3 つが残る:

| 状態 | 作られ方 | 今 | 新（上の表） |
|---|---|---|---|
| A: `<lock>`（空・owner 無し）＋ `.gone-*`（記録） | 復元した者が `mkdir <lock>` の後・owner の移動の前に死ぬ | 次の先頭は `mkdir <lock>` が EEXIST、owner 無しなので回収しない（`:917` の `-n`、`readOwner` が null で待つ）。G の終了の後に `.gone-*` は回収されても、空の `<lock>` が**永久に残る** | G が生きている間は 3 で完了させる（以後は owner=T1 の通常の保有中）。G が終わっていれば 4 で `<lock>` を `rmdir` してから `.gone-*` を回収し、次の周回で取得 |
| B: A と同じ形 | 復元した者の owner の `rename` が失敗した（`.gone-*` の書き込み権限など） | TS は例外を「owner がまだ無かった」と読んで `.gone-*` を消す（`machine-lock.ts:476`–481。owner ごと消え、`<lock>` は空のまま残る）。bash も `mv -f … \|\| true` の後に `rm -rf`（`verify-run.sh:846`–847） | 失敗した本人が 2 の `rmdir <lock>` で戻す（`.gone-*` は消さない）。本人が戻す前に死ねば A と同じ |
| C: `<lock>`（owner=T1）＋ `.gone-*`（空） | owner の移動の後・`.gone-*` の削除の前に死ぬ | `.gone-*` は塞がない（欠損）が、空のディレクトリが残る | 塞がない（6）。先頭が `rmdir` で片付ける。G が終われば `<lock>` は通常の回収で消え、取得できる |

- 3 と 4 の「`<lock>` が空で owner が欠損」を復元の途中と読んでよい理由（見立て）: 新しい実装の取得者は、生きている記録の `.gone-*` がある間は `mkdir` をしない（1・2・3・5 の行）。よって `.gone-*` に記録がある間に owner の無い `<lock>` を作るのは、復元した者（列の先頭）だけ。先頭は同時に 1 人（#4277 §2.4 の 1）で、前の先頭が札の猶予より長く止まらないことは #4277 §2.4 の前提のまま。旧版が `mkdir` した直後の空の `<lock>` を消しうるのは #4277 §0 B' の範囲外。
- 4 で `<lock>` を `.gone-*` の回収より**先に**消すのは、`.gone-*` を消した後には「この `<lock>` は復元の途中だった」と示すものが無くなり、owner の無い `<lock>` を今の規約どおり待ち続けるため。`rmdir` は空でなければ失敗するので、間に owner が書かれた `<lock>` は消さない。
- 既存の復元（退かした owner の token が違ったとき）の `rename` の失敗の読み「owner がまだ無かった」（`machine-lock.ts:478`、bash `:846` の `[ -f ]`）は **ENOENT のときだけ**に限り、そのときは今のまま（`<lock>` を残し `.gone-*` を消す。保有者は戻した `<lock>` に owner を書く。#4277 の窓）。ENOENT 以外は `rmdir <lock>` で戻して `.gone-*` を残す（B を作らない）。

呼び手の変更: TS `breakStale` は戻り値（`'recovered'|'restored'|'restore-failed'|'gone'`）を返す（同期 JS と揃える）。3 実装とも、`'restore-failed'` の後の周回は上の表で止まる（呼び手が戻り値で分岐する必要は無い。`.gone-*` の存在で決まる）。同期 JS の `recoverLock` の呼び手（`:426`）も同じ。既存の復元（`lock_recover`／`breakStale`／`recoverLock` の中の 3 段）も表の 2 と同じ失敗の扱い（`rename` が ENOENT 以外で失敗したら `rmdir <lock>`）にそろえる。

この規則は #4277 の札・回収・解放の規約を変えない（止める点の 3 つ目）。旧版（#4288 以前）の読み手は `.gone-*` を見ないので、復元の失敗と混在が重なると旧版が取りうる。#4277 の旧版との混在（4277 §0 B'）と同じ扱いで範囲外とし、§4 に書く。

## 3. 経路表（受け渡しの各時点 × 本体の死・取消し × 取得者）

owner の列は公開の状態、「取得者」は bash（`lock_acquire`）・TS（`acquireMachineLock`）・同期 JS（`acquireMachineLockSync`）。「拒否」は本体の死の後も G に人が居る間は取れないこと、「取得」は回収して取れること。

| # | 時点 | owner | 子・G | 本体だけ SIGKILL | 本体へ TERM | 取得者 bash／TS／同期 JS |
|---|---|---|---|---|---|---|
| 1 | 取得待ち（札だけ） | 無し（前の保有者） | 無し | 札は pid の死で外される（#4277 §2.5） | trap が札を done | 3 実装とも今のまま |
| 2 | 取得済み・fork の前 | T0 | 無し | 取得（T0 は死） | trap が解放 | 3 実装とも取得 |
| 3 | fork の後・G 未確認 | T0 | 合図待ち | 子は取り下げて exit 125 → 取得 | trap が子を KILL・解放 | 取得（ゲートは走らない） |
| 4 | G 確認・見張り起動の後・公開の前 | T0 | 合図待ち | 同上（見張りは `ack` を見ずに終わる） | trap が排水＋見張りを KILL・T0 で解放 | 取得 |
| 5 | tmp の書き込み中（`LOCK_PENDING_TOKEN`=T1） | T0（tmp は別名） | 合図待ち | 同上。`.owner-*` の残骸はロックごと消える | trap が owner=T0 を見て T0 で解放 | 取得 |
| 6 | 公開後・合図の前 | T1（G） | 合図待ち | 子は取り下げ → G が空 → 取得。T0 を読んでいた取得者は token の不一致で戻し、T1 で判定し直す（§2.2） | trap が owner=T1＝`LOCK_PENDING_TOKEN` を見て排水・T1 で解放 | G が空になるまで拒否、空で取得 |
| 7 | 合図の後・`ack` の前 | T1（G） | 子が `ack` を作る途中 | 子は `ack` を作って exec（7→8）か、作れずに exit 125。どちらも G が空になるまで拒否 | trap が排水・解放 | 拒否 → G が空で取得 |
| 8 | `ack` の後・実行中 | T1（G） | ゲート | **拒否**（今回の穴を塞ぐ）。見張りが `ack` から timeoutSec で G を止め、空で取得 | trap が排水 → 解放 | 拒否 → G が空で取得 |
| 9 | 長の終了・子が残る（排水中） | T1（G） | 子 | 拒否。子が終わるまで残る | trap が排水を続ける | 拒否 → 空で取得 |
| 10 | timeout（見張りの TERM の後） | T1（G） | 長は終わり、子が TERM を無視 | 拒否 | 同上 | 拒否 → KILL の後に取得 |
| 11 | 9・10 の排水が 1 を返した（KILL の後も空にならない） | T1（G） | 子 | 拒否。owner は残り、G が空になってから回収 | trap が `LOCK_UNDRAINED` の G を排水し直し、空でなければ `lock_release` が owner の pgid を見て消さない（§2.5） | 拒否 → 空で取得。同じ run の次のゲート（同じ mutex）も取れずに `mutex-wait` |
| 12 | 6〜11 で T0 を読んだ取得者が T1 を退かし、**復元に失敗** | `.gone-*` に T1（G） | 6〜11 のまま | **拒否**（§2.7 の表の 2。同じ取得者も後続の先頭も `mkdir` しない）。次の先頭が戻せば 6〜11 に戻る。G が空になれば `.gone-*` を回収して取得 | trap が自分の `.gone-*` を片付ける（§2.7 の表の 7。G に人が居れば消さない） | 拒否 → 復元か G の終了の後に取得 |
| 13 | 12 の復元の途中で復元した者が死ぬ（`mkdir <lock>` の後・owner の移動の前。§2.7 の A） | `<lock>` は空、`.gone-*` に T1（G） | 6〜11 のまま | 拒否。次の先頭が §2.7 の表の 3 で完了させる（以後 6〜11）。G が空なら 4 で `<lock>` を `rmdir` し `.gone-*` を回収して取得 | 本体の trap は 12 と同じ | 拒否 → G が空で取得 |
| 14 | 12 の復元で owner の `rename` が失敗（§2.7 の B） | 本人が `rmdir <lock>` で 12 に戻す。戻す前に死ねば 13 | 6〜11 のまま | 12 か 13 と同じ | 同上 | 同上 |
| 15 | 12 の復元で owner を移した後・`.gone-*` の削除の前に死ぬ（§2.7 の C） | `<lock>` に T1（G）、`.gone-*` は空 | 6〜11 のまま | 6〜11 と同じ（空の `.gone-*` は塞がず、先頭が `rmdir`） | 6〜11 と同じ | 拒否 → G が空で取得 |
| 16 | 12〜15 の `.gone-*` の owner が読めない（EACCES・EIO） | `.gone-*` に T1（読めない） | 6〜11 のまま | **拒否**（§2.7 の表の 1。生死が不明なので待つ）。読めるようになった周回から 12〜15 | 同上 | 拒否 → 読めて、G が空で取得 |
| 17 | retry（2 回目の取得） | 2 回目の T0'→T1' | 1 回目の G は排水済み（失敗なら 11 のまま `LOCK_UNDRAINED` に残る） | 2〜16 と同じ（新しい G'） | 同上（T0'／T1' と `LOCK_UNDRAINED` だけを見る） | 同上 |
| 18 | 解放後・次のゲート | 他人または無し | 無し | 古い T1 を読んでいた取得者は、退かした owner の token が違うので戻す（#4277 の restore。失敗すれば 12） | — | 今のまま |

3 実装の違いが結果に出る所は無い（§2.2 のとおり、どれも退かした token で決め、§2.7 の規則は 3 実装で同じ）。違いは「T0 を読んで判定した周回が 1 回空振りする」の有無だけ（bash は判定のたびに読み直すので空振りしないことが多い）。

## 4. 互換（書き手 × 読み手、3 実装を分ける）

新しい書き手が書く owner は `pgid` が 1 より大きい整数で、3 実装の読みが揃う行に入る。既存の差異は変えない（事実として書く）。

| owner の形 | bash（`lock_json_field`→`lock_record_gone`、`lock_release`） | TS（`readOwner`→`holderGone`、`release`） | 同期 JS（`readOwner`→`holderGone`、`release`） |
|---|---|---|---|
| 旧 `{pid,host,token,acquiredAt}`（旧版 verify-run.sh、TS gate-runner、precheck） | pid が ESRCH なら回収（旧版の保有者の穴は旧版が消えるまで残る） | 同じ | 同じ |
| 新 T0（公開の前） | pid が ESRCH なら回収。子は走らない | 同じ | 同じ |
| 新 T1 `pgid:G` | pid が ESRCH **かつ** `kill -0 -- -G` が ESRCH | `pidAlive` 偽 **かつ** `groupAlive(G)` 偽 | 同じ |
| merge-pr `pgid:<inner pid>`（取得時から入る。`machine-lock-sync.mjs:342`・`:392`） | 今のまま | 今のまま | 今のまま |
| owner が無い・**抽出できない破損**（空ファイル、`token` のキーが無い、値が `null`・`""`、`"token":` の直後が引用・数字・`true`／`false` 以外〔空白・`{`・`[`〕） | token が空 → 回収しない（`:917` の `-n`）。**解放は消す**（`:953`） | `readOwner` が null → 回収しない。解放は消さない（`:602`） | 同じく回収しない・解放は消さない（`:407`） |
| **抽出できる不正な JSON**（末尾の `}` が無い、後ろにごみ。`"pid":123,"host":"h","token":"t"` は残る。**値の引用が閉じていない** `…,"token":"t` — `lock_json_field` は閉じ引用が無ければ行の残りを返す〔`verify-run.sh:654`–657〕ので token は `t`。`"token":123` は数字の `123`） | `lock_json_field` がキーごとに抜くので pid・host・token・pgid を読める → **回収・解放は正しい JSON と同じ結果**（閉じていない引用では、行の残り全体が token になる） | `JSON.parse` が投げて `readOwner` が null → 回収しない・解放は消さない | 同じく null → 回収しない・解放は消さない |
| `pid` が文字列 `"123"` | 数字の接頭を読んで 123 として判定 | `readOwner` が null（数でない）→ 待つ | 同じく null → 待つ |
| `pgid` が文字列 `"123"` | 123 としてグループを見る | `readOwner` が pgid を落とす（`:240`）→ pid だけ | `validPgid` が偽（`:94`）→ pid だけ |
| `pgid` が小数 `12.5` | 数字の接頭 `12` としてグループ 12 を見る | 数として残るが `validPgid`（`:282`）が偽 → pid だけ | `validPgid` が偽 → pid だけ |
| `pgid` が 1 以下・負・数字で始まらない | 空と見なす（`:696`–697） | `validPgid` が偽 → pid だけ | 同じ |
| 正しい JSON だが `:` の後に空白（`"token": "t"`） | `lock_json_field` は `"token":` の直後の 1 文字で型を決めるので空 → 抽出できない破損の行と同じ（回収しない・**解放は消す**） | 正しく読む | 正しく読む |
| 別 host | 生きている扱い | 同じ | 同じ |
| `.gone-*` に読める・死んでいない記録（§2.7） | 新: `mkdir` しない。旧（#4288 以前）: 見ない → 復元の失敗と重なると取る | 同じ | 同じ |
| `.gone-*` の owner が読めない（EACCES・EIO。§2.7 の「不明」） | 新: `mkdir` しない（`-x`／`-e`／`-r` と `awk` の終了コードで判定）。旧: 見ない | 新: `readGoneOwner` が `code` を返し、待つ。旧: 見ない | 同じ |
| 退避名の形でない `<name>.lock.gone-…`（`.` を含む。例 別の mutex `a.lock.gone-b` の `a.lock.gone-b.lock`） | 新: mutex `a` の `.gone-*` として読まない（§2.7 の「退避名の識別」） | 同じ | 同じ |

pid の再利用は 3 実装とも「生きている」側に倒れる（待つだけ）。#4277 以前の読み手は pgid を読まないが、#4277 の札を知らない版との混在は既に範囲外（4277 §0 B'）。#4288 以前の読み手が `.gone-*` を見ないことも同じ扱い（CommandMate 本体の TS・同期 JS は同じリリースで揃う。他のリポジトリの `verify-run.sh` の写しは commandmate-skills への移植で揃う）。抽出できる不正な JSON の行の差（bash だけが回収・解放する）は書き手が壊れた記録を書いた場合だけに表れ、新しい書き手は `printf` と `mv` で完全な記録しか置かない。

## 5. owner を読む・書く全経路

- **書く**: verify-run.sh `lock_acquire`（`:905`–906、T0）・**新たに** `run_gate_attempt` の公開（T1、`mv`）・`lock_recover` の戻し（`:846`、mv で中身ごと）・**新たに** §2.7 の 2 の戻し（3 実装）。machine-lock.ts `claim`（`:430`）・`breakStale` の戻し（`:477`）。machine-lock-sync.mjs `claim`（`:245`）・`recoverLock` の戻し（`:289`）・`setOwnerFields`（`:410`、merge-pr のマージのロックだけ。同じ token のまま `phase` を足すが、pgid は取得時から入っているので §2.2 の順序は起きない）。
- **読む**: verify-run.sh `lock_owner_field`（`:672`）→ 回収（`:914`–920）・解放（`:952`）・待ち表示（`:924`–926）。machine-lock.ts `readOwner` → 回収（`:616`）・解放（`:602`）・`heldBy`（`:539`）。machine-lock-sync.mjs `readOwner`（`:106`）→ 回収・解放・`heldBy`（`:355`）、merge-pr `heldByLine`、precheck の重い段（`precheck.mjs:514`）。**新たに** 3 実装の取得のループと解放が lock root を一覧して退避名の形の `<lock>.gone-*/owner` を読む（§2.7。TS・同期 JS は `readGoneOwner`、bash は `-x`／`-e`／`-r` の確かめつきの `lock_json_field`）・bash の `lock_release` が消す前に owner の `pgid` を読む（§2.5 の 2）。**新たに** 復元の途中の完了（§2.7 の表の 3）が `.gone-*/owner` を `<lock>/owner` へ `rename` する（書く側）。
- 説明: `SKILL.md:286`（.claude／.agents）、`verification-config.md:531`・`:537`。足すのは「verify-run.sh は mutex 付きのゲートの起動時に owner を `pgid` 付き・新しい token で書き直し、G が空になってから解放する」「復元に失敗して残った `<name>.lock.gone-<token>-<serial>`（退避名の形のものだけ）は、記録が生きている・読めない間は保有中と読み、列の先頭が戻すか、記録が死んでから消す。途中で止まった復元は先頭が完了・回収する」「bash の解放は owner の `pgid` のグループに人が居れば消さない」。
- 探して無かったもの: `consistency-review.mjs` の `.lock` は別の規約。`env-snapshot.ts`・`session-kill-ledger.ts` の一致は owner ではない。札の token と owner の token を突き合わせる箇所（3 実装を `token` で grep して確かめた）。`.gone-` を読む箇所は 3 実装の回収の 3 か所だけ（`machine-lock.ts:455`、`machine-lock-sync.mjs:267`、`verify-run.sh:835`。grep で確かめた）。

## 6. テストの設計（実装の契約で書く）

共通: `fs.mkdtempSync(os.tmpdir())` に git repository・`holder.yaml`（`mutex: repro`）を置き、全 actor に `CM_VERIFY_LOCK_ROOT` と TS／同期 JS の `root` を渡す。`afterEach` で自分が起こしたグループだけを `kill(-pgid)` し、一時ディレクトリを消す（chmod した場合は戻してから）。新しいファイル `tests/unit/skills/cmate-verify/verify-run-holder-group-4288.test.ts` と、読み手の §2.7 は `tests/unit/verification/machine-lock-gone-4288.test.ts`（TS と同期 JS）。root で走らせると chmod の注入が効かないので、uid 0 では該当の対照を skip する。

**止め所**（テスト専用。未設定なら何もしない）: `CM_VERIFY_TEST_HANDOFF_DIR` と `CM_VERIFY_TEST_HANDOFF=pause:<stage>,fault:<stage>`。`pause` は `<dir>/<stage>.reached` を作って `<dir>/<stage>.go` を待つ。stage は §3 の時点（`forked`・`group`・`watchdog`・`tmp`・`published`・`signalled`・`acked`・`leader-exited`）と、bash の読み手側の `recover-moved`（`lock_recover` の `mv` の後・token の読みの前）・`restore-mkdir`（復元の `mkdir <lock>` の後・owner の移動の前）・`restore-owner`（owner の移動の後・`.gone-*` の削除の前）。`fault` は §2.3 の失敗（`group`・`token`・`tmp`・`mv`・`verify`・`signal`〔本体の `go` の作成〕）と子の側の `child-go`（取り下げの `mkdir "$go"` を、`go` を作らずに失敗させる）・`child-ack`（`ack` の作成の失敗）・`drain`（`drain_group` を、signal を送らずに 1 を返させる。G はテストの子が生きたまま）を注入する。TS・同期 JS の読み手は既存の `__testHooks`／`hooks` の `pidAlive`（判定の最中）と `onRecover`（`moved` で退かした後）を使い、`onRecover` の stage に `restore-mkdir`・`restore-owner` を足す（hook が例外を投げると、その取得の呼び出しはそこで終わる＝復元した者の死の代わり）。代案の「SIGSTOP と owner のポーリングで窓を狙う」は時点を固定できないので採らない。

| 対照 | 不正な同時実行の拒否（陽性） | 保護対象が消えた後に進む（陰性） |
|---|---|---|
| R（repro-1） | 本体だけ SIGKILL → 旧ゲートが生きている間、bash（`timeoutSec:1`）が exit 22・`mutex-wait`、TS・同期 JS（`timeoutMs:0`）が `acquired:false`。owner に `pgid`＝ゲートの pid と T1 の token | 旧ゲートのグループを KILL → 3 実装とも取れる |
| §2.2 の順序（TS・同期 JS。**実プロセスの順序**） | 読み手の `pidAlive` の中で止め、本体に公開・合図をさせ、本体だけ SIGKILL してから判定を返す → 判定は T0 の snapshot で「死」、退かした owner は T1 で戻され、G が生きている間は取れない。**仕掛けの陽性**: 同じ手順で owner を手で「同じ token のまま pgid を足した形」に書き換えると TS・同期 JS は消してしまう（第 1 版の穴を検出できることを示す） | G が空になれば同じ取得者が取れる |
| §2.2 のフィールドの読み直し（bash。**合成の対照**と明記） | 実プロセスの順序では作れない（§2.2）ので、`recover-moved` で止め、退かした `.gone-*` の owner をテストが手書きの T1（死んだ pid・テストが起こした生きたグループ）に置き換える → `lock_recover` は `la_token` と違うので戻し、グループが生きている間は取れない。仕掛けの陽性: 手書きを「T0 のまま pgid を足した形」にすると bash は消す | グループを KILL すれば取れる |
| §2.7 の復元の失敗（3 実装） | §2.2 の順序（TS・同期 JS は `onRecover('moved')`、bash は `recover-moved`）で T1 を退かした直後に、ロックの root を `chmod 0555` にして復元の `mkdir` を EACCES で落とす → `machine-lock-restore-failed`。root を戻した後、**同じ取得者も、別の取得者（後続の先頭）も**、G が生きている間は取れない（`acquired:false`／exit 22）。**直す前の実装では**、root を戻した次の周回で同じ取得者が取れてしまう（陽性） | 復元（次の先頭が §2.7 の表の 2 で戻す）の後は owner=T1 で拒否が続き、G を KILL すると `.gone-*` も `<lock>` も回収されて取れる。`.gone-*` の記録が初めから死んでいれば待たずに回収して取れる。owner の無い `.gone-*` は今のまま塞がない |
| §2.7 退避名の識別（3 回目の P1-1。3 実装の組合せ） | mutex `a` と mutex `a.lock.gone-b` を同じ root に置く。`a.lock.gone-b` を保有者 X（生きた G_X を pgid に持つ記録）が持ち、`a` は空き → bash・TS・同期 JS のそれぞれが `a` を取得・解放しても、`a.lock.gone-b.lock/owner` の中身と mtime は変わらず、ディレクトリも残り、`a.lock.gone-b` の 3 実装の取得は G_X が生きている間 `acquired:false`／exit 22。逆向き（`a` を生きた保有者が持ち、`a.lock.gone-b` を 3 実装が取得・解放）も `a.lock/owner` が動かない。`.` を含む名前の兄弟（`a.lock.gone-1-2-3-4.lock`、`a.lock.gone-<uuid>-1.queue`）も同じ。**第 3 版の形**（`<lock>.gone-*` をそのまま読む）を写したテスト用の読み手では、`a` の取得が `a.lock.gone-b.lock` の owner を `a.lock/owner` へ移す（陽性） | 本物の退避名（`a.lock.gone-<uuid>-1`、`a.lock.gone-123-1700000000-45678-1`）の生きた記録は `a` の取得を止める。シンボリックリンクの `a.lock.gone-x` は読まない |
| §2.7 読み取りの不明（3 回目の P1-3） | 生きた G の T1 を持つ `.gone-*` を作り、(i) `owner` だけを `chmod 000`（`.gone-*` と root は書き込み可能のまま）、(ii) `.gone-*` を `chmod 000` → 3 実装とも `mkdir <lock>` をしない（`acquired:false`／exit 22、`machine-lock-gone-unreadable`）。**今の `readOwner` を写した読み手**（エラーを null＝欠損と読む）では取れてしまう（陽性）。uid 0 では skip | 権限を戻した周回から: G が生きていれば拒否（記録として読む）、G を KILL すると回収して取れる。`owner` の無い（ENOENT）`.gone-*` は待たずに取れる（欠損と不明を分けたことの対照） |
| §2.7 復元の途中（3 回目の P2。3 つを別々に） | A: `restore-mkdir`（bash は pause の後に取得者を SIGKILL、TS・同期 JS は hook が例外）。B: `.gone-*` を `chmod 0555` にして owner の `rename` を EACCES で落とす（`mkdir <lock>` は通る）。C: `restore-owner`（A と同じ止め方）。どれも G が生きている間は 3 実装とも取れない。A は次の先頭が完了させて `<lock>/owner`＝T1 になる。B は本人が `rmdir <lock>` で戻し `.gone-*` が残る。**今の実装では** A・B の後に G を KILL しても空の `<lock>` が残り、どの取得者も取れない（B の今の TS・同期 JS・bash は owner の `rename` の失敗を「owner がまだ無かった」と読んで owner ごと `.gone-*` を消し、空の `<lock>` だけが残る）（陽性） | 3 つとも、G を KILL した後に 3 実装のどれもが有限の周回（`timeoutMs` 内）で取れ、`<lock>.gone-*` と空の `<lock>` が残らない。A・B・C の形をファイルで直接作った合成の状態（死んだ G）でも同じ。owner の書かれた `<lock>`（空でない）は 4 の `rmdir` で消えない |
| §2.7 の表の 7（自分の `.gone-*` の片付け） | 保有中の自分の記録を `.gone-*` へ退かして root を `0555` にし、root を戻してから `release`／trap → `.gone-*` が消え、次の取得者が取れる | 他人の記録の `.gone-*` は解放で消さない |
| §2.5 排水の失敗（3 回目の P1-2） | `fault:drain`、ゲートは `trap '' TERM; sleep 30` の背景の子を残す → (i) 通常の run の終わり（trap）、(ii) 同じ mutex の次のゲート、(iii) 別の mutex の次のゲートの後の run の終わり、(iv) 排水中の本体へ TERM、のどれでも `<lock>` は残り（owner=T1）、G が生きている間 3 実装とも取れない。(ii) の次のゲートは副作用なしで `SKIP reason=mutex-wait`。stderr に `machine-lock-release-deferred`。**第 3 版の形**（排水の失敗の後に G を忘れ、trap が token だけで解放）を写した版では (i) の後に取れてしまう（陽性）。§2.5 の 1 と 2 を片方ずつ外した版でも、残る片方で取れないこと | G を KILL すると 3 実装とも取れる。`fault:drain` なしでは今の解放の時間のまま |
| §2.3 の失敗 | `fault:group`・`token`・`tmp`・`mv`・`verify`・`signal` のそれぞれで、ゲートの副作用（pid ファイル）が**作られない**・`GATE … FAIL exit=125`・stderr の `machine-lock-handoff-failed stage=…`・retry されない・ロックは解放（`token` の注入では解放しない） | 注入なしでは副作用がちょうど 1 回 |
| §2.4 の合図の作成の失敗（子の側） | `pause:published` で本体を止め、`HANDOFF_WAIT_SEC=1`・`fault:child-go` → 子は期限で取り下げを試み、`go` を作れず、**exec しない**（副作用なし・`ack` 無し）。本体を再開すると本体の `mkdir "$go"` は成功するが `ack` が無いので `stage=ack` の FAIL 125。**直す前の形**（`mkdir "$go" && exit 125; break`）を写したテスト用の子では exec してしまう（陽性） | 注入なしの競合（子の取り下げと本体の合図が同時）では、どちらか一方だけが勝ち、exec は 0 回か 1 回で本体の判定と一致する |
| §2.4 の `ack` の失敗 | `fault:child-ack` → 副作用なし・`stage=ack` の FAIL 125・`$rga_mark` は無い | — |
| §2.4 見張りが先に発火しうる順序 | `timeoutSec:1`・`pause:published` で本体を 2 秒止める → 見張りは `ack` の前は数えないので、待ちの子を TERM しない。再開後、ゲートは走って副作用がちょうど 1 回、終了は `timeoutSec` の後の 124（ゲートが `sleep 5` のとき）か、ゲートの終了コード（すぐ終わるとき）。**直す前の形**（見張りが fork から数える）では、副作用 0 回なのに 124 になる（陽性） | 期限内の合図では exec がちょうど 1 回 |
| §2.4 期限 | `pause:published`（本体は生きて止まる＝`kill -0` は成功し続ける）・`CM_VERIFY_TEST_HANDOFF_WAIT_SEC=1` → 子は期限で exit 125・副作用なし。再開した本体は `stage=abort` の FAIL 125（124 ではない） | 期限内の合図では exec がちょうど 1 回 |
| §2.5 の解放 | 長は `exit 0`、背景の子は `trap '' TERM; sleep 30` → 排水の間は 3 実装とも拒否。timeout でも同じ（長は TERM で終わる） | 子が終わる（KILL）と取れる。背景の子の無いゲートは排水で待たない（解放までの時間が猶予の 5 秒を含まない） |
| §2.6 取消し | `watchdog` の前・`tmp`・**`published`**・`signalled` の後で本体へ TERM: `published` では owner=T1 のまま trap が `LOCK_PENDING_TOKEN` で一致を見て排水・解放する（ロックのディレクトリが消え、G が空）。TERM を無視するゲートは猶予の後 KILL → 空で解放。trap の猶予中に本体を SIGKILL → owner が T1 で残り、G が生きている間は拒否 | TERM に従うゲートは猶予を待たずに解放。G を KILL すれば取れる |
| §2.6 retry と次のゲート | `retryOnFail: 1` の 1 回目を失敗させ、2 回目を `pause:published` で止めて owner を読む → token は 1 回目の T0／T1 と違う。テストが 1 回目の T1 を持つ別ディレクトリを `<lock>` に置いた（合成）状態で 2 回目の解放・trap を走らせても、それは消さない | 通常の 2 回目は自分の T1' で解放される |
| §3 の経路表 | `pause:<stage>` の各時点で本体だけ SIGKILL → §3 の「拒否」の行は 3 実装とも取れない | 「取得」の行は 3 実装とも取れ、ゲートの副作用が無い |
| §4 の互換 | 表駆動（手書きの owner × 3 実装。生きている・死んだ pid とグループの組）。既存の差異（壊れた owner の bash の解放、抽出できる不正な JSON の bash の回収、**閉じていない引用の token〔bash は行の残りを token とする〕**、`"token":123`、`:` の後の空白、文字列・小数の pgid）は**今の値を固定**する（変える Issue ではない） | — |

- **直す前の実装で落ちること**（陽性）は、実装のコミットの前に 1 回走らせて記録する（コミット本文）。
- 既存の期待は変えない: `tests/unit/verification/machine-lock*.test.ts`（`machine-lock-fifo-4277.test.ts` の S1「`.gone-*` が無い」を含む）、`gate-mutex*.test.ts`、`gate-slot-*.test.ts`、`gate-cancel-2063.test.ts`、`tests/unit/skills/cmate-verify/*`（`dual-placement.test.ts` の `cmp` 一致を含む）。`.claude/skills/sync-map.json` の pin は再計算し、`commandmate-skills` への移植は別途。

## 本文に無い指摘（この Issue では直さない）

- `src/lib/verification/gate-runner.ts:715`–724: 製品ランナーもゲートを `detached: true` で別グループに起こし、owner は `pid: process.pid`（`machine-lock.ts:585`）だけ。サーバーが SIGKILL で死ぬと同じ形で回収される（見立て）。TS には `setOwnerFields` に当たる口が無い。
- `scripts/orchestrate/precheck.mjs:514`: 単独で走る precheck の重い段のロックも pgid 無し。precheck だけが死ぬと vitest・tsc の子が残る（見立て）。
- `verify-run.sh:1080`–1086 の見張り: 本体だけが死んだ後も `sleep timeoutSec` の後に `-G` へ signal を送る。G が先に空になり、その番号が別のプロセスのグループとして再利用されていると無関係なグループへ送る（見立て。今の実装にもある窓。§2.6 の見張りも `ack` の後は同じ）。
- bash の `lock_json_field` が数でない `pid`／`pgid` の数字の接頭を読み、抽出できる不正な JSON から値を読む（§4）。TS・同期 JS と判定が揃わない。
- owner の無い `.gone-*`（§2.7 の分類の「欠損」）: 判定と退かしの間に解放と再取得が起き、再取得者が owner を書く前に退かされ、復元にも失敗すると、再取得者は owner を書けない（`<lock>` が無い）まま保有を続け、`<lock>` は空く（見立て。#4277 からある窓で、T1 とは無関係）。

- `docs/design/merge-queue-fair-lock-4277.md:96`: 「`<name>.lock.gone-*` も（名前の規約の下で）衝突しない」は、glob のまま読むと誤り。mutex `a.lock.gone-b` の `a.lock.gone-b.lock` は `a.lock.gone-*` に一致する。今の 3 実装は `.gone-*` を一覧しない（自分が作った名前だけを扱う）ので実害は無く、§2.7 で一覧を足すときに退避名の形で絞る。4277 の文書の訂正はこの Issue では行わない。
- 今の TS・同期 JS・bash の既存の復元（`machine-lock.ts:476`–481、`machine-lock-sync.mjs:288`–293、`verify-run.sh:846`–847）は、owner の `rename` の失敗を全て「owner がまだ無かった」と読み、owner ごと `.gone-*` を消して空の `<lock>` を残す（§2.7 の B）。§2.7 で ENOENT のときだけに限る。
- bash の `lock_json_field` は `"token":` の直後に空白がある正しい JSON を読めない（§4）。新しい書き手は空白を入れないので今は表れない。

## 事前レビューの処置

### 1 回目

レビュー: `workspace/orchestration/runs/2026-11-09/prereview/review-4288.md`（codex-2、静的レビュー）。

| 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|
| P1 更新前の owner を読んだ取得者が、同じ token で pgid を公開した後のロックを消せる | **採る** | 3 実装の回収は退かした token の一致だけで消す（`machine-lock.ts:465`、`machine-lock-sync.mjs:277`、`verify-run.sh:837`）ことをコードで確かめた。「書き換え中は本体が生きている」では、読んでから判定するまでの間の本体の死を除けない | §2.2 を新設。守る条件を「削除する最新の owner に死亡の条件が成立」と書き、公開で token を T1 に替える。token と中身の 1 対 1・死亡の単調性から 3 実装で成り立つことを file:line で示した。対照は §6「§2.2 の順序」（第 1 版の形を手で書いて消えることを示す陽性つき） |
| P1 G の確認・owner の公開に失敗しても exec する経路が残る | **採る** | 「確かめられなければ今の動き」は穴をそのまま残す | §2.3 に「ゲートを始めない条件」の表と後始末、FAIL 125・retry しない・今の動作に戻さないを定義。対照は §6「§2.3 の失敗」 |
| P1 EXIT trap だけ直しても、通常終了・timeout の解放経路が保護されない | **採る** | `wait` は長だけを待ち（`:1089`）、timeout では見張りの KILL より先に見張りを止めて解放する（`:1103`・`:1109`）ことを確かめた | §2.5 を新設。全ての解放経路で `drain_group` の後にだけ解放、空にならなければ解放しない。保証から外すもの（別グループへ移した子孫）を明示 |
| P2 owner を残す判断は安全だが、取消し完了の保証が未定義 | **採る** | 合図の後・見張りの前に本体が死ぬと、TERM を無視するゲートを誰も KILL しない | §2.6 で取消しの責任と owner の保持を分けた。見張りを公開の前に起こす順に変え、窓を無くした |
| P2 合図待ちの期限と、期限切れ時の親側処理 | **採る** | 本体の pid の再利用で無期限に待ちうる | §2.4。子が測る実時間の期限（30 秒）、`mkdir "$go"` での取り合い、125 と 124 の区別 |
| P2 静的な互換表と合図直前の停止だけでは検証できない | **採る** | 「pgid 無し → 同じ token の pgid 付き」の移り変わりは静的な表では表せない | §3 の経路表、§6 の止め所と対照の表 |
| P3 現行コードの事実の相違（空の token の解放、pgid の型） | **採る** | `:953` は空の token でも消す。bash の抽出は文字列・小数の数字の接頭を読む | §1 の解放の記述、§4 を 3 実装に分けた |

### 2 回目

レビュー: `workspace/orchestration/runs/2026-11-09/prereview/review-4288b.md`（codex-2、静的レビュー。前回の P1-3・P2-1・P3 は解消、P1-1・P1-2・P2-2・P2-3 は一部解消との判定）。

| 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|
| P1 token 不一致時の復元に失敗すると、G が生存中でも次の claim が成功しうる | **採る** | 3 実装とも、復元の `mkdir` の失敗で `.gone-*` を残して戻り、呼び手は `continue` して次の周回の `mkdir` が通ることをコードで確かめた（`verify-run.sh:842`–845・`:920`、`machine-lock.ts:470`–474・`:619`–620、`machine-lock-sync.mjs:282`–286・`:426`）。#4277 の「戻せない＝もう新しいロックが在る」の前提は ENOSPC・EACCES では成り立たない。第 2 版の「読み手は変更不要」は撤回 | §2.7 を新設（読み手を変える）: 読める・死んでいない記録の `.gone-*` があれば先頭も `mkdir` しない、先頭が戻す、死んだら回収、自分の `.gone-*` は解放で片付ける。止める点を PM の今の条件に直し、札・#4277 の規約は変えないことを示した。§1 の表に「復元に失敗したとき」の列、§3 に 11 行目、§4 に混在の行。対照は §6「§2.7 の復元の失敗」（root の chmod で EACCES を注入。同じ取得者・後続の両方が取れないこと、直す前は取れてしまうこと、復元と G の終了の後に進むこと） |
| P1 子の `mkdir "$go"` が競合以外で失敗すると、合図なしで exec する | **採る** | `mkdir "$go" && exit 125; break` は失敗を全て競合の負けと読む | §2.4 の子の待ちを書き直した: 失敗の後に `[ -d "$go" ]` で競合と作成の失敗を分け、作成の失敗では exit 125。exec の前に受け取りの印 `ack` を作り、作れなければ exec しない。本体の `mkdir "$go"` の失敗も `[ -d "$go" ]` で分ける（`stage=signal`）。§6 の故障の注入に `child-go`・`child-ack`・`signal` を足した |
| P2 watchdog が合図前に子を終了させる場合、「合図したか」だけでは 125 を判定できない | **採る** | 見張りは fork から数えるので、本体が公開の前後で止まると合図の前に待ちの子を TERM しうる。そのあと本体の `mkdir "$go"` は成功し、合図できたと思い込む | 見張りの起動（公開の前）と timeout の計測の開始（`ack` を見た時点）を分けた（§2.6）。125／124 は `ack` の有無で決める（§2.4）。§6 に「見張りが先に発火しうる順序」の対照（直す前の形では副作用 0 回で 124 になる陽性つき） |
| P2 bash の `reader-before-recover` では L228 の順序を実プロセスのまま作れない | **採る** | `lock_record_gone` は pid の ESRCH を確かめてから pgid を読むので、止めた時点で本体は死んでおり、そこから公開・合図はさせられない。第 2 版 L69 の「TS と同じ穴」は誤り | §2.2 で bash は実プロセスの順序では同じ穴を作れない（公開の `mv` の後残りの窓だけで、それも token の比較で戻す）と書き直した。§6 で TS・同期 JS の snapshot の試験（実プロセスの順序）と、bash のフィールドの読み直しの試験（`recover-moved` で止めて owner を手で書く、**合成の対照**と明記）を分けた。止め所の `reader-before-recover` は `recover-moved` に替えた |
| P2 公開後・go 前の TERM を、token の保持変数まで含めて固定する必要がある | **採る** | 第 2 版は合図の成功の後に保持の変数を T1 にしていたので、公開の後・合図の前の trap は T0 で `lock_release` を呼び、owner=T1 と違うので消さずに残る（安全側だが、解放されないまま本体が終わり、回収まで待たせる） | §2.6 に保持の変数の順（公開の前に `LOCK_PENDING_TOKEN`=T1、合図の後に HELD を T1 にしてから PENDING を消す、どの戻り口でも空にする）と、trap が owner の token を `LOCK_HELD_TOKEN`／`LOCK_PENDING_TOKEN` と突き合わせて解放する規則を書いた。両方（順の更新と trap の owner の確認）を採った。§6 の TERM の試験に `published` を、retry と次のゲートで前の token を使わない対照を足した。札の `LOCK_TOKEN` を T0 のまま保つ方針は変えない |
| P3 破損 JSON の表と、PM の停止条件の記述 | **採る** | `lock_json_field` はキーごとに抜くので、末尾の `}` が欠けただけなら bash は pid・host・token を読め、回収・解放の結果が TS・同期 JS と変わる。L82 の停止条件は今回の依頼と違う | §4 の行を「抽出できない破損」と「抽出できる不正な JSON」に分け、後者の bash の結果（正しい JSON と同じ）を書き、§6 で今の値を固定する。§2.2 の (a) の不採用の理由から PM の停止条件を外し、止める点を今の条件に直した |
| （自分で見つけたもの）見張りの起動から `ack` までの間に子が exec せずに終わったとき、見張りが待ち続ける | **採る** | `ack` を待つ見張りに終わりの条件が要る | §2.6 の見張りは G が空なら黙って終わる。G の番号の再利用で待ち続けても signal は送らない |

### 3 回目

レビュー: `workspace/orchestration/runs/2026-11-09/prereview/review-4288c.md`（codex-2、静的レビュー。前回の P1〔合図なしの exec〕・P2 3 件は解消、P1〔復元の失敗の後の取得〕・P3 は一部解消との判定）。

| 指摘 | 処置 | 理由 | 設計のどこを変えたか |
|---|---|---|---|
| P1 `.gone-*` の探索が、別の合法な mutex のロックを取り込める | **採る** | mutex の名前の規約 `^[A-Za-z0-9_.-]+$`（`verify-config.ts:230`）で `a.lock.gone-b` は合法で、その `a.lock.gone-b.lock` は `a.lock.gone-*` に一致することを確かめた。今の 3 実装が作る退避名は `<lockPath>.gone-<token>-<serial>` で、接尾に `.` を含まない（`machine-lock.ts:455`・`:508`、`machine-lock-sync.mjs:267`・`:339`、`verify-run.sh:835`・`:858`） | §2.7 に「退避名の識別」（接尾が `^[A-Za-z0-9-]+$`・`lstat` でディレクトリ。3 実装で同じ）と、別の mutex の項目が必ず `.` を含むことの説明。§4 に行、§6 に「退避名の識別」の対照（`a` と `a.lock.gone-b` が互いの owner を動かさない。3 実装の組合せ。第 3 版の glob の形を写した読み手で動かしてしまう陽性） |
| P1 排水失敗後に G を忘れると、最後の EXIT trap が解放できる | **採る** | 第 3 版の §2.6 の 3「どの戻り口でも `LOCK_GATE_GROUP` を空にする」と `LOCK_HELD_TOKEN`＝T1 の保持が重なると、trap は `LOCK_GATE_GROUP` が空で排水を飛ばし、token の一致だけで `lock_release` する（`verify-run.sh:953` は token だけを見る） | 両方を採った: 未排水の項目 `LOCK_UNDRAINED` を run の終わりまで保ち（§2.5 の 1、§2.6 の 3）、`lock_release` は消す直前に owner の `pgid` のグループが空かを確かめる（§2.5 の 2。呼び手の変数に依らない最後の守り）。経路ごとの扱いの表（通常の終わり・同じ／別の mutex の次のゲート・TERM・SIGKILL）を §2.5 に、§3 に 11 行目、§6 に `fault:drain` の対照（片方ずつ外した版でも取れないこと、第 3 版の形の陽性） |
| P1 読み取り失敗を「owner の無い昔の残骸」と同じ扱いにしている | **採る** | 今の `readOwner`（`machine-lock.ts:220`–242、`machine-lock-sync.mjs:96`–108）は読み取りのエラーも null にし、bash の `lock_json_field` も `2>/dev/null` で空にする。「原子的に書いたので常に読める」は中身の欠けしか除けない | §2.7 に「owner の読み取りの分類」（記録・欠損・破損・不明）。不明（ENOENT 以外のエラー、bash は `-x`／`-e`／`-r` と `awk` の終了コード、root の一覧の失敗）は `mkdir` をせずに待つ。`.gone-*` だけを `readGoneOwner` で読み、主のロックの `readOwner` は変えない。§3 に 16 行目、§4 に行、§6 に「読み取りの不明」の対照（`owner` だけ・`.gone-*` だけの chmod、回復の後に進む、ENOENT は待たない） |
| P2 復元途中の停止で、owner の無い `<lock>` が永久に残る | **採る** | 今の 3 実装は `mkdir <lock>` の後の死・owner の `rename` の失敗で空の `<lock>` を残し、owner の無い `<lock>` は回収しない（`verify-run.sh:917` の `-n`、`readOwner` の null で待つ）。`rename` の失敗では owner ごと `.gone-*` を消す（`machine-lock.ts:476`–481） | §2.7 に「先頭の 1 周の手順」の表（3 で途中の完了、4 で `<lock>` の `rmdir` を `.gone-*` の回収より先に、6 で空の `.gone-*` の片付け）と「復元の途中の状態」A・B・C の表。`rename` の失敗の「owner がまだ無かった」の読みは ENOENT に限り、それ以外は `rmdir <lock>` で戻す。§3 に 13〜15 行目、§6 に A・B・C を別々に固定する対照（G の終了の後に 3 実装とも取れ、空の `<lock>` も `.gone-*` も残らない） |
| P3 「引用が閉じていない token は抽出できない」という例が誤っている | **採る** | `lock_json_field`（`verify-run.sh:654`–657）は閉じ引用が無ければ行の残りを返すことを確かめた | §4 の「抽出できない破損」の例から外し、「抽出できる不正な JSON」へ移した（`"token":123` も同じ側）。抽出できない側の例を、空・キー無し・`null`・`""`・`:` の後が型を決められない文字、に直した。正しい JSON でも `:` の後に空白があると bash は読めないことを別の行にした（本文に無い指摘）。§6 の表駆動でこれらを固定する |
| （自分で見つけたもの）既存の復元の `rename` の失敗が owner ごと `.gone-*` を消す | **採る** | P2 の B を調べていて、今の 3 実装が失敗を全て「owner がまだ無かった」と読むことを確かめた | §2.7 の最後の注記と「復元の途中の状態」の B の行。本文に無い指摘にも書いた |
