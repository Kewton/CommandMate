# #4288 PR1a-f: owner の書き込みの原子性・旧版の `owner.tmp.*` の回収・D7 の TZ 依存（設計の 4 つと試験の表）

- Issue: #4288（2 番 run-lock・supervisor.lock の土台の続き）。土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) §1.6（D3・D7）・§1.9・§1.10・§1.14（PR1a の実装と D12 の不変条件）、[verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md) §2.8（観測点の表）
- PM の決定: `pm-return-4288-upstream.md` の共通の決定 1（PR1b・PR1c の上流のレビューから切り出した小さな PR）。上流 1 回目の指摘: `prereview/review-4288-pr1af-upstream.md`（codex、P1 1・P2 4・P3 1）・`pm-review-4288-pr1af-upstream-claude.md`（PM Claude、P2 6・P3 15）。PM の処分: `pm-return-4288-pr1af-upstream.md`（直す 1〜9。対応は §7）。上流 2 回目の指摘: `prereview/review-4288-pr1af-upstream2.md`（codex、P1 1・P2 2・P3 1）・`pm-review-4288-pr1af-upstream2-claude.md`（PM Claude、P2 2・P3 7）。PM の処分: `pm-return-4288-pr1af-upstream2.md`（決定 1〜6。上流 3 回目で全て入れた。対応は §7.1）。上流 3 回目の指摘: `prereview/review-4288-pr1af-upstream3.md`（codex、P2 3・P3 1）・`pm-review-4288-pr1af-upstream3-claude.md`（PM Claude、P2 0・P3 6）。PM の処分: `pm-return-4288-pr1af-upstream3.md`（直す 1〜4。**この版（上流 4 回目）で全て入れた。対応は §7.2**。PM Claude の P3-3〜6 は実装の最後の回）。上流 4 回目の指摘: `pm-review-4288-pr1af-upstream4-claude.md`（PM Claude の一点見、名前で消す経路 13 件・漏れ 3・P2 1・P3 5）。PM の処分: `pm-return-4288-pr1af-upstream4.md`（直す 1〜5。**この版（上流 5 回目）で全て入れた。対応は §7.3**。codex の 4 回目は来たら別に追記する）
- この文書は上流の段（設計の 4 つ・試験の表）。実装は別の契約で、表の雛形 `tests/unit/verification/machine-lock-owner-atomic-4288.test.ts` の `it.todo` を赤から緑にする
- 骨格は 1 回目のまま: **I1 tmp → `link`**、**I3 一時ファイルの名前だけ消して `rmdir`**、**I5 再利用は証拠が揃ったときだけ死**。D12（持ち主自身の解放）は触らない
- 3 回目で変えたこと: 不変条件を「新版どうし」と「混在の間」に分けた（§1 の I8、旧い写しの長い停止からの再開は既知の限界として表 F の `limit` の行に置き、終わる条件を §6.1 に書いた）、空の owner・空の `<lock>` の回収の猶予を 10 分にした、D7 の「TZ の差は 15 分の倍数」の推定をやめた（`started_at` があれば etime の起動の時刻と比べ、`lstart=` だけの記録は一致で alive・不一致で unknown）、§4 の関数は「消すか消さないか」の判定専用と書いた、表 F を実際の呼び手 × 実装に展開した
- 4 回目で変えたこと: 最初の取得で**自分でない pid を記録しない**（I1-b。他者の pid を記録するのは引渡し D4 だけ）、確認の後に**名前で消す**経路を「自分だけの名前へ `rename` → その inode を確かめる → 消す／`link` で戻す」に替え、残った経路を §3.1 に列挙した（I2-b・F56〜F62）、`now` を `ps` の**前と後**で取り、観測の間の時計の後退・遅い観測を `unknown:etime:ECLOCK` に寄せた（I5・§4.1・F65。寄せられない形は P1 の行）、新版の記録に書き手の版 `v=1` を足し、混在の終わりを「旧い写しを実行中のプロセスが無い（`ps` の手順）」かつ「7 日間 `v=` の無い記録を観測しない」で観測できる条件にした（I9・§6.1・F66）、D6 の `absent`・`restore-failed` を表 F の行にした（F63・F64）
- 5 回目で変えたこと（PM Claude 4 回目の一点見 `pm-review-4288-pr1af-upstream4-claude.md`・PM の処分 `pm-return-4288-pr1af-upstream4.md` の直す 1〜5。対応は §7.3）: 退避の owner の **put-back を `link` で戻す**形にし、EEXIST なら退避を残して `machine-lock-restore-failed` で名指す（I2-c・F67）、bash `lock_release` の `missing)` の枝は `<lock>` を消さない（`lock_release_held` と揃える）、`setOwnerFields` は `<lock>` が無い・書けないとき例外でなく `false`、§3.1 の列挙を閉じた（put-back・take-back-half・自分の名前の退避・退避の整理の `rmdir`・札の置き換えの理由）、§5.1 に `lock-release-invariant-4288.test.ts` の 4 か所を名指しで足した。put-back の空の `<lock>` の窓に K1 から再開した新版の書き手が入る形は `link` でも 2 者が持ちうるので、§8 の 4 で PM に判断を伺った（その後の PM 決定で前提 P0 の外、F69）
- 5 回目の追加（PM の決定 `pm-decision-4288-pr1af-lease-premise.md`、再指示 `reinstruct-4288-pr1af-lease-premise.md`）: 保証を**停止の前提 P0 の下**で書く（下の「前提 P0」の節）。混在の間の既知の限界は P0 の特別な場合として 1 つにまとめた。codex 4 回目の P2 のうち 3 件（戻しの EEXIST に新版の K1 の停止、壁時計の後退と読み手の停止の相殺、汎用シェルで止まった旧書き手）は**前提の外**の行（F69〜F71、直さない）。前提に依らない 1 件（`ownerFields`／`LOCK_OWNER_EXTRA` で予約の欄を書ける）は**拒んで塞ぐ**（I1-c・F68）。put-back の `link`＋EEXIST（I2-c）はそのまま。I の不変条件と §4 の契約は変えない
- 事実の行番号は `fd2f4a589`（develop、PR1a `c3387cbe7` を含む）

## 前提 P0（停止の前提。PM 決定 2026-11-11）

- **P0（停止の前提）**: ロックの手順（取得・公開・戻し・回収・解放。put-back と退避の整理を含む）の途中で、**どの書き手も猶予（10 分。`LOCK_EMPTY_OWNER_GRACE_MS`=600000・本番の呼び手の `LOCK_OWNERLESS_GRACE_MS`=600000）を超えて止まらない**。新版・旧版の別なく、読み手（先頭・D6 のガード・D5）も同じ
- **P1（壁時計の前提。§1 の P1 の本文）**: 書き手の起動から読み手の観測の終わりまで、壁時計が `LOCK_PID_REUSE_SLACK_MS`（2 秒）より大きく変わらない。観測の間の後退のうち `now_before`／`now_after` で見えるものは `unknown:etime:ECLOCK` に寄せる（F65）が、見えないもの（読み手の停止と相殺した後退: F70）は前提の外
- **なぜ前提が要るか**: `mkdir`・`link`・`rename` だけで作るロックには、止まった書き手の古い操作を後から無効にする手段（フェンシングの token をファイルシステムが検査する仕組み）が無い。だから手順の途中で任意に長く止まった書き手の再開を、どの手順でも完全には排除できない（リースのロック一般の前提と同じ）。上流 2〜4 回目の P2 の大半は「ある書き手が手順の途中で 10 分を超えて止まり、再開する」交差で、直すたびに次の交差が見つかった（PM 決定の経緯）
- **保証（P0 と P1 の下）**: **新版どうしでも新旧の混在の間でも、生きた保有者のロックは消えず、2 者が同時に持たない**（§1 の I0〜I9 が P0・P1 の下で成り立つ）。札が期限＋60 秒で外れた後の再開（60 秒〜10 分の停止）は P0 の内で、I8 (a) の `link` の排他と inode の確かめで安全
- **混在の間の既知の限界は P0 の特別な場合**: 3 回目から「混在の間だけの限界」として書いてきた F49・F50・F51・F55・F58 は、どれも旧い形の書き手が手順の途中で**猶予を超えて止まり再開した**ときだけ起きる（F55 は P1 の外も重なる）。P0 の下では起きない。新版の書き手の 10 分を超える停止（F69: K1 から再開した新版の書き手が戻し・put-back の空いた名前へ公開する）も同じ P0 の外で、旧版か新版かは前提の外で起きうることの違いでしかない。§6.1 の混在の終わりは「前提の外で起きうることのうち旧い書き手の分が無くなる条件」で、P0 の下の保証は混在の終わりに依らない
- **前提の外の扱い**: 前提が破られたとき（猶予を超える停止・壁時計の変更）に起きうることは、表 F の `limit` の行で**名指して直さない**。各行は `outside`（`P0`・`P1`・`P0+P1`）を持つ（雛形の `Limit.outside`）。前提の外の行は F42・F49・F50・F51・F55・F58・F69・F70・F71 の 9 行。実装の後のレビューで同じ種類（猶予を超える停止・壁時計の変更を含む交差）が見つかったら、この表に行を足すだけで P2 にしない（PM 決定 4）
- **前提に依らないものは直す**: 停止も時計の変更も無しに崩れる形は前提の外にしない。5 回目の追加では `ownerFields`／`LOCK_OWNER_EXTRA` の予約の欄（I1-c・F68）がそれ
- **D7 の `reused` は残す**（PM 決定の追記 2）: ESRCH だけにすると、死んだ保有者の pid が長生きのプロセスに再利用されたロックが永久に残る（可用性の退行。PR1c の表 F8・F9 も `reused` を前提に固まっている）。`reused` の判定は P0・P1 の下で使い、前提の外は F42・F70 で名指す
- **戻しはやめない**（PM 決定の追記 1）: 戻し（put-back）は生きた保有者を誤って退かしたときに記録を戻すためのもので、戻さないと生きた保有者の `<lock>` が空いて他者が取り、前提の内でも 2 者が持つ。形は I2-c の `link`＋EEXIST

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
| E12 | PR1a 版の取得者は作成の間ずっと**自分の札を持つ**（札を退かすのは公開の成功の後、`lock_retire_own_ticket`）。ただし札は持ち主が生きていても外れる: `lock_ticket_retirable` は pid が死んだ（`gone`）・再利用された（`pid-reused`）・**今が期限＋`LOCK_SAME_HOST_GRACE_MS`（60000）を過ぎた（`expired`）**のどれかで札を退かす。期限は取得の開始＋予算で、run-lock・supervisor.lock・D6 のガードは予算 0 なので**期限＝開始**。作成の途中で 60 秒より長く止まった書き手の札は外れ、次の者が先頭になる（先頭が 1 人なのは「60 秒を超えて止まらない」前提の内だけ。親 §1.8 の前提）。PR1a 版の書き込みの失敗の後始末は `rm -f "$LOCK_PATH/owner"`（名前で）→ `rmdir` | `verify-run.sh:1619-1650`（`:1624`・`:1645`）、札 `:1154-1182`（`:1177`）・`:623`、期限 `:1559` |
| E13 | 旧版の run-lock・supervisor.lock の取得者は札を持たない（`mkdir` を直に試す）。`mv` の失敗の後始末は `rm -rf "$dir"`（`lib.sh:178`、`run-lock.sh:127`）。旧版の読み手は「owner が無く 1 分より古い `<lock>`」を中身ごと取る（`lib.sh:141-144`） | `lib.sh:166-185`、`run-lock.sh:60-79` |
| E14 | `lock_parse_owner_text`（kv の codec）は読みの最初に `LPO_*` を空に戻すが、`started_at=` は読まない。`lock_holder_state` は pid が gone でも G が生きていれば `alive` を返す | `machine-lock.sh:135-160`、`verify-run.sh:1107-1112` |

## 1. (a) 不変条件

変えないもの（土台）:

- **I0-a（D12、PR1a-c）**: 持ち主自身の解放が直接消すのは「記録の pid が呼び手自身、かつ記録に `pgid` があれば G が空」のときだけ。この PR は解放の経路に触れない（`lock_release_held`・`release`・`lock_release_as_head` は変えない）
- **I0-b（札の規約 #4277）**: `mkdir`・回収・owner の無い `<lock>` の片付け・空の owner の回収は列の先頭だけ。先頭でない者は何も動かさない
- **I0-c（§2.8）**: 不明は何とも読まない（取らない・消さない・解放しない）。生きた保有者のロックは誰も動かさない

前提:

- **P0-t（札を持つ書き手と停止の長さ。4 回目までの P0。上の停止の前提 P0 の内訳）**: 保証は #4277 の札の規約に従う書き手（この repo の #4277 以降の `verify-run.sh`・skills の cmate-verify 0.7.0 以降・同期 JS・TS）の間で成り立つ。札は持ち主が生きていても**期限＋60 秒で外れる**（E12）ので、「作成の途中で止まった書き手の札が生きている間は他の誰も先頭にならない」は 60 秒を超えない停止の間だけ言える。60 秒を超える停止の後に再開した書き手でも壊れないことは、**新しい形の書き手**については札に頼らずに示す（I8 の (a)。公開が `link` の排他で、止まった書き手は ENOENT／EEXIST で断り自分の tmp しか消さない）。旧い形の書き手（札を持たない旧版の run-lock・supervisor.lock、名前で書き・名前で消す PR1a 版とそれより前の写し）については示せない（I8 の (b)、既知の限界）。cmate-verify 0.7.0 より前の写し（札の規約そのものを知らない）は今も先頭の規約を無視して `mkdir` するので、親 §1.9 の「旧い取得者が動く間」と同じく保証の外。§5 の skills の port・sync-map.json の pin・§6.1 の写しの更新で減らす
- **P1（壁時計）**: 持ち主のプロセスの起動から取得（`started_at` を書く時）までの間に、壁時計が `LOCK_PID_REUSE_SLACK_MS`（2 秒）より大きく戻らない。D7 の `reused` の証拠（§4.1 の 6）と旧版の tmp の pid の再利用の証拠（I3）はこの前提に依る。前提の外の振る舞いは表 F の F42（`limit`・`premise`）に書く（PM Claude の PR1c 上流 3 回目の申し送り B の 2）
  - **観測の間（4 回目、codex 3 回目 P2）**: 読み手が `now` を取ってから `ps -o etime=` を読むまでの間の時計の変更は、前提に**含めず unknown に寄せる**。`now` を `ps` の前（`now_before`）と後（`now_after`）に取り、`now_after < now_before`（観測の間に時計が戻った）か `now_after − now_before ≥ 1000`（観測が 1 秒以上: 間の後退を見分けられない）なら `unknown:etime:ECLOCK`（消さない。§4.1 の 5）。どちらでもなければ起動の時刻は `now_before − etime` で、観測の間に隠れた後退（`now_after` が `now_before` を下回らない大きさ）が足す誤差は観測の長さ（1 秒未満）より小さく、遅い側の誤差の合計（`started_at` の秒の切り捨て 1 秒未満＋観測 1 秒未満）は 2 秒の余裕に収まる（F65）
  - **寄せられない形（前提として残る）**: (1) 持ち主の起動から取得までの後退（上の本文。`started_at` が起動より前の時刻で書かれ、後から読んでも見分けられない）。(2) GNU の `ps` の `etime`（起動からの経過を単調な時計で数える）では、取得の後・観測の前に壁時計が 2 秒より大きく**進む**と `now − etime` が遅れて出る（BSD〔macOS〕の `etime` は起動の壁時計の値から数えるので、取得の後の変更は打ち消し合う）。どちらも F42 の行

足すもの:

- **I1（owner は完全な形でしか現れない。SIGKILL の範囲）**: どの実装も owner を「`<lock>/.owner-<token>` に**全て書き**（JS・TS は `writeSync` の戻り値の合計が `Buffer.byteLength(text)` と同じ、bash は標準入力を一度だけ変数に読み〔`lco_text=$(cat)`。`$(…)` は末尾の改行を落とす〕、`printf '%s\n' "$lco_text"` で tmp に書き、tmp を同じ `$(cat -- "$tmp")` で読み直した文字列が `$lco_text` と同じ。比べる 2 つを同じ取り方にするので、末尾の改行の差で正しく書けた tmp を短い書き込みと読まない: PM Claude P3-5）、**閉じ**（`closeSync` が成功）→ `link(tmp, owner)`（排他。在れば EEXIST）→ 読み直し → tmp を消す」の順で公開する。`<lock>/owner` という名前が見える時点で中身は全て書かれている。よって**どの中断点（SIGKILL）も 0 バイトや書きかけの owner を残さない**（§2.6 の表 K）。fsync はしないので、停電・カーネルの停止の後は `link` 済みの 0 バイトの owner が残りうる。それは I4 の空の owner の回収で扱う（書いた者はもう居ない）
- **I1-b（最初の取得は自分の pid だけを記録する。4 回目、codex 3 回目 P2・PM 処分 1）**: 公開（I1）で owner に書く pid は取得するプロセス自身（bash は `$$`、同期 JS は `process.pid`。TS は `ownerPid` を持たず既に自分だけ）。bash の `LOCK_OWNER_PID` が空でも `$$` でもない、同期 JS の `ownerPid` が `process.pid` と違うときは、**札を取る前・`mkdir` の前に断る**（bash は stderr `machine-lock-owner-pid-not-self <lock> pid=<p>` と `LOCK_UNKNOWN` の `point=owner-pid errno=EINVAL` で 1 を返す。同期 JS は `{ acquired: false, waitedMs: 0, heldBy: null, unknown: { point: 'owner-pid', path: <lock>, code: 'EINVAL' } }` と同じ文面の warn。F56）。他者の pid を記録するのは**引渡し（D4）だけ**で、それは「生きた持ち主が自分の取得の中で書き直す」別の遷移（新しい token T1、`pgid` 必須）。本番の呼び手は全て自分の pid で取る（merge-pr・precheck・gate-runner・`verify-run.sh` のゲート、PR1b の `daily.sh`・UAT の `up`、PR1c の supervisor）。理由: 記録の pid が取得したプロセス自身なら、そのプロセスが公開の途中で止まっている間は pid が生きているので誰も回収しない。他者の pid（死にうる）を最初から記録すると、確認の後の名前の削除（F13 の戻し）が後継の owner に当たりうる（codex 3 回目 P2 の順序）。bash は公開がパイプラインのサブシェルで走り、`$$`（親）だけが先に死ぬ形が残るので、戻し自体も I2-b の rename の形にする（F61）
- **I1-c（記録の予約の欄は呼び手が書けない。5 回目の追加、codex 4 回目 P2・PM 決定 3。前提に依らないので塞ぐ）**: I1-b は入口の `ownerPid`／`LOCK_OWNER_PID` だけを見ていたので、同期 JS の `ownerFields`（`machine-lock-sync.mjs:877` で記録の**最後に**展開され、`{ pid: deadPid }` が `pid` を上書きする）と bash の kv の `LOCK_OWNER_EXTRA`（`scripts/lib/machine-lock.sh:168`。読み手 `lock_parse_owner_text` は同じ鍵の**最初の行**を採るので、`pid=` の後に足された `pgid=` の行が節の書く `pgid=` より先に来て勝つ）から、最終の記録の予約の欄を書けた。停止も時計の変更も無しに I1-b の前提（記録の pid は取得したプロセス自身）を崩すので、**拒む**（狭めて塞ぐ）。予約の欄: `pid`・`host`・`token`・`acquiredAt`・`started_at`・`pgid`・`v`・`lstart`・`done`（札の欄）。実装ごと:
  - **同期 JS**: `ownerFields` に予約の鍵が 1 つでもあれば、札を取る前・`mkdir` の前に断る（`{ acquired: false, waitedMs: 0, heldBy: null, unknown: { point: 'owner-fields', path: <lock>, code: 'EINVAL' } }`、warn `machine-lock-owner-field-reserved <lock> key=<k>`。F68）。`setOwnerFields(fields)` も予約の鍵があれば書かずに `false`（今は `pid`・`token` だけ後ろで上書きし直しているが、`pgid`・`host`・`acquiredAt`・`v` は書き換えられた）。記録は「節が書く予約の欄」＋「呼び手の欄」の順に組み、呼び手の欄が予約の欄を上書きできない形にする
  - **bash**: `LOCK_OWNER_EXTRA` の各行の鍵（`=` の前）が `pid`・`host`・`token`・`started_at`・`pgid`・`v` なら、`lock_acquire_path` の冒頭（I1-b の検査の隣、札の前）で断る（stderr `machine-lock-owner-field-reserved <lock> key=<k>`、`LOCK_UNKNOWN` の `point=owner-fields errno=EINVAL`、1 を返す。F68）。引渡し（`lock_hand_off`）も同じ検査をし `LHO_STAGE=fields`。**`lstart` だけは例外**: bash の kv の記録では `lstart=` は呼び手（supervisor）が自分の起動を D7 に渡す唯一の欄で、節は書かない（PM 決定の列挙には `lstart` があるが、拒むと D7 が働かなくなる）。そこで `lstart=` は**1 行だけ**許し、2 行以上なら同じ文面で断る（最初の行が勝つ形で別の値を紛れ込ませない）。`lstart=` の値が `$$` の起動であることは今どおり呼び手の義務（I5 の前提）。JSON の codec（`verify-run.sh` のゲート）は `LOCK_OWNER_EXTRA` を書かないので、検査は codec に依らず走らせて害が無い
  - **TS**: 呼び手の欄を受け取る口が無い（`ownerFields`・`setOwnerFields`・extra の無い `create`）ので到達しない。口を足すときは同じ予約の鍵を拒む（§5 の申し送り）
  - 今の本番の呼び手は予約の欄を渡さない（merge-pr の `ownerFields: { phase, repo, base }`、`LOCK_OWNER_EXTRA` は supervisor の `lstart=`・`label=`・`run_dir=`〔PR1c〕）。既存の試験で `LOCK_OWNER_EXTRA=pgid=…` を使うものは §5.1 の意図した変更
- **I2（排他は今のまま。公開は link(2) の意味）**: 公開は `link(2)` なので、在る owner（他者の記録・symlink・ディレクトリ・ディレクトリへの symlink）を書き換えない・その中に作らない。bash は `ln` でなく `LC_ALL=C /bin/link -- "$tmp" "$lock/owner"` を使う（E11。`ln` は宛先がディレクトリなら中に作って成功する）。EEXIST・ENOENT は `lock_errno_of` で読む。`mv`（`rename`）は在る owner を置き換えるので公開には使わない。札の `ln`（E8）は宛先にディレクトリができる経路が無いので変えない
- **I2-b（戻しは自分のものだけ。名前で確かめて名前で消さない）**: 公開の後の戻し（読み直しが不明: F13）は、**確かめてから `<lock>/owner` を名前で消さない**（確かめと削除の間に名前の指す先が後継の owner に替わりうる: codex 3 回目 P2。4 回目で替えた）。手順: (1) `rename(<lock>/owner, <lock>/.undo-<自分の token>)`（自分だけの名前へ。ENOENT なら owner はもう無く、自分の tmp だけ消して `rmdir` しない: F59。その他の errno は不明で何も消さない: F60）、(2) **rename した先**が自分の tmp と同じ inode かを確かめる（bash は `[ ! -L "$undo" ] && [ "$undo" -ef "$tmp" ]`。`-ef` は symlink を辿るので `! -L` を前に置く: PM Claude P3-4。JS・TS は `lstat(undo)` と **`lstat(tmp)`** の `dev`・`ino`。tmp は公開の前に閉じている〔I1〕ので `fstat` は使えない: PM Claude P3-3）、(3) 同じなら `.undo-<token>` と tmp を消して `rmdir <lock>`（F13）、(4) 違う・symlink・tmp が無い（I3 で消された・後継の回収で `<lock>` ごと退かされた）・lstat が失敗して比べられないなら、`link(.undo-<token>, <lock>/owner)` で**戻し**、成功すれば `.undo-<token>` を消す（戻した owner は他者のもの。F14・F61）。戻しの `link` が EEXIST（間に誰かが owner を作った。混在の間の旧い書き手だけが作りうる: F58）なら戻さず `.undo-<token>` を残し、stderr／warn `machine-lock-undo-restore-failed <lock> kept=<lock>/.undo-<token>` で人に知らせる。`.undo-<token>` は I3 の述語で一時ファイルの形でない名前（`stray`）なので、在る間は誰もその `<lock>` を片付けない（F57）。rename の名前は token ごとで、同じ token の取得は 1 つだけなので、(2) で確かめた名前を (3) の削除までに他者が替えることは無い（新版どうし）。`link` が ENOENT（F11: 自分の `<lock>` か tmp が片付けられた）なら、今ある `<lock>` は他者のものなので `rmdir` しない。確かめの後に名前で消す経路の全体は §3.1
- **I2-c（退避の owner の put-back も `link`。5 回目、PM Claude 4 回目 P2-1・PM 処分 1）**: 退避（`<lock>.gone-*`）の記録を `<lock>/owner` へ戻す put-back（bash `lock_move_owner_in`。呼び手は `lock_recover` の戻しと `lock_restore_from_gone` の `created`・`exists` の枝。同期 JS の `moveOwnerIn` と `recoverLock` の戻し、TS の同じ 2 か所）は、「`<lock>` を自分で `mkdir` した（`created`）」か「owner が無く中が空（`lock_ownerless_empty` が `yes`）」を確かめた後に `rename(gone/owner, <lock>/owner)` で名前へ入れていた。`rename` は在る owner を置き換えるので、確かめと `rename` の間に誰かが公開した owner を上書きする（確かめてから名前で上書きする経路）。PR1a-f の後は **`link(gone/owner, <lock>/owner)`**（bash は I2 と同じ `LC_ALL=C /bin/link --`、JS・TS は観測の口 `obs` に `link` を足して `linkSync`。観測の点は今の `restore-rename` の**名前を保ち**〔既存の注入の試験 `lock-observation-points-4288.test.ts:380` が名前を固定している〕、観測するものが `rename` から `link` に替わり、答えに EEXIST が加わる）: (1) 成功したら退避の dir を消す（`rm -rf gone`／`rmSync`。`gone/owner` の名前を消しても `<lock>/owner` は同じ inode の別の名前で残る）→ `restored`。(2) ENOENT（退避に owner が無い）は今の `absent` と同じ。(3) **EEXIST（間に誰かが `<lock>` に owner を公開した）なら戻さず、退避を残し、`<lock>` も `rmdir` しない**（中に他者の owner がある）。stderr／warn `machine-lock-restore-failed <lock>: kept <gone> (EEXIST)`、結果は `restore-failed`（F67）。退避の記録は今の `restore-failed` と同じく、生きている間は全ての先頭が保有中と読む（§2.7）。(4) その他の errno は今の `restore-failed`（この put-back が作った空の `<lock>` を `rmdir` して退避を残す）。I2-b の戻しと同じ形で、確かめの後に名前を書き換えない。混在の間は、旧い書き手（札も退避も知らない）の `: >`／`mv -f` が put-back の空の `<lock>` に書く形が残る（I8 (b)、親 §1.9 の (f)）。新版どうしで残る形（K1 から 10 分を超えて止まった書き手が再開して put-back の空の `<lock>` に公開し、退避の記録の持ち主と 2 者になる）は `link` でも塞げず、上書きの代わりに `restore-failed` で名指されるだけ。これは前提 P0 の外（F69。PM 決定で直さない）
- **I3（owner の無い `<lock>` の片付けの範囲）**: 片付けるのは**猶予つきの先頭**（`LOCK_OWNERLESS_GRACE_MS`／`ownerlessGraceMs` を渡した呼び手: run-lock・supervisor.lock、と D6 のガード）だけ。**本番の呼び手が渡す猶予は 600000（10 分）**（PM 決定 1。空の `<lock>` は旧版の書き手の K1〔`mkdir` の後・tmp の前〕でも生まれ、その窓は通常ミリ秒なので 10 分は十分長い。猶予はオプションの値で、節の既定は変えない。今それを渡すのは試験だけで、本番の呼び手は PR1b・PR1c が 600000 を渡す。PR1a の試験が渡す 60000 は規則を駆動する値でそのまま）。判定は**新しい述語** `lock_ownerless_temps_only`（bash）／`ownerlessTempsOnly`（同期 JS）で、呼ぶのは片付け `lock_expire_ownerless`／`expireOwnerless` **だけ**。既存の `lock_ownerless_empty`／`ownerlessEmptyLock`（「owner が無く中が**空**」）は意味を変えない（途中の戻し §2.7 の `lock_restore_from_gone` の `exists` の枝 `verify-run.sh:1338`、take-back-half `:1360`、D6 の `absent` の確かめ `:2030`、sync `:597`・`:622`・`:1164`、TS `:778`・`:800` が使うので）。新しい述語の答えは `no`（owner が在る）・`empty`・`temps:<names>`・`stray`・`absent`・`unknown:<point>:<path>:<errno>`。対象は「owner が missing」かつ「中の名前が全て一時ファイルの形で通常ファイル」かつ「`<lock>` と全ての一時ファイルの mtime が猶予より古い」かつ「**`owner.tmp.<pid>` の全てについて、その pid が書き手でないと示せた**」のもの。書き手でないと示せるのは、pid が `kill -0` で gone（ESRCH）か、pid が生きていて `ps -o etime=` から求めた起動の時刻（§4.1 の `machine_lock_etime_ms`、`now` は `ps` の前と後に取り、観測の間の後退・1 秒以上の観測は不明: P1 の「観測の間」）が**その tmp の mtime ＋ `LOCK_PID_REUSE_SLACK_MS`（2 秒）より後**（書き手は tmp を書く前に起動している。再利用した別のプロセス: PM Claude P3-1。P1 の壁時計の前提に依る）のとき。`.owner-<token>` は新しい形と引渡しの tmp で、年齢だけで足りる。理由は札ではなく公開の形: 止まった新しい書き手が再開しても、`<lock>` が片付けられていれば `link` が ENOENT（F11、`rmdir` しない）、後継が公開していれば EEXIST（F7）で断り、自分の tmp しか消さない。再開した書き手が後継より先に `link` すれば、後継の `link` が EEXIST になり 1 人だけが持つ（I8 の (a)、PM Claude 2 回目 §2 の検査）。`owner.tmp.<pid>` の pid が生きていて起動が tmp より前（書き手かもしれない）なら回収せず `machine-lock-ownerless-old-taker <lock> pid=<pid>` と名指す（旧版の書き手が猶予を超えて止まっている。再開すれば自分で `mv` する）。pid が EPERM・EIO（unknown）や etime が読めない・形が不正でも回収しない。pid が数字でなければ `stray`。戻しの途中の `.undo-<token>`（I2-b）も一時ファイルの形でないので `stray`（片付けない）。消すのは**その一時ファイルの名前だけ**（`owner` という名前は消さない）と、最後の `rmdir <lock>`（空でなければ失敗する）。一時ファイルの unlink が ENOENT なら「もう無い」と読んで次へ進む（旧版の片付けと同時。F23）。途中で誰かが公開すれば `owner` が在るので `rmdir` が失敗し、ロックはそのまま残る
- **I4（壊れた owner）**: 解けない owner（`garbage-owner`）は今のまま**誰も自動で消さない**。取得の断り・D6 の結果で `<lock>/owner` を名指す（`machine-lock-owner-corrupt <lock>/owner unparsable`）。**0 バイトの owner（`empty-owner`）は回収する**: 列の先頭（取得の先頭・猶予の無い取得の先頭・D6 のガード。D5 と同じ「先頭になってから」）が、owner の mtime が `LOCK_EMPTY_OWNER_GRACE_MS`（**固定 600000＝10 分**。PM 決定 1。書き手の `: >` と `cat >>` の窓〔μs〕より十分長い。呼び手の猶予のオプションとは別で、猶予の無い呼び手にも効く）より古いことを確かめ、`<lock>` を `<lock>.gone-<自分の token>-<serial>` へ `mv` で退かし、退かした先の owner が**まだ 0 バイト**で mtime も古いことを確かめてから `rm -rf`。0 バイトでなくなっていれば（書き手が退かす間に書き終えた）退避を残し、次の周回で `lock_settle_gone` が記録として判定する（生きていれば戻す。既存の §2.7）。若い（10 分以内の）空の owner は消さず、文面は `taking`（書いている途中）。新しい形の書き手は空の owner を見せない（I1）。空の owner を生むのは旧い形の書き手（PR1a 版の E1・E2 の窓、PR1a より前の `printf > owner`）と停電だけ。旧い形の書き手が 10 分を超えて止まり（札は期限＋60 秒で外れている。E12）、回収の後に再開すると、名前で追記・名前で消すので後継の owner を壊しうる（I8 の (b)、表 F の F50・F51。既知の限界）。旧い写し（PR1a 版・skills の port の前）は今後も生むので、回収は一度きりの掃除でなく恒常の規則
- **I5（D7 の再利用の判定は、起動の時刻の証拠があるときだけ死に変える。TZ に依らない）**: `lstart=` の行を持つ記録（D7 の対象。supervisor.lock）に限り、元の判定（`lock_holder_state`）のうち **`kill -0` の pid の観測が alive か EPERM** のとき（G だけで alive の記録には当てない: F44）、`machine_lock_pid_identity`（§4）を呼び、`reused` のときだけ gone（その後に G を見る）。関数は (0) 記録と `ps` の `lstart` の**文字列が同じなら `alive`**（今の判定と同じ）。違うとき、(1) 記録に **`started_at=`（エポックに戻せる UTC の時刻。E10）がある**なら、**`ps -o etime=` から求めた起動の時刻（`now − etime`）を `started_at` と比べる**: `started_at` ＋ `LOCK_PID_REUSE_SLACK_MS`（2000）より後なら `reused`、そうでなければ `alive`（TZ に依らない: どちらもエポックの時刻）。(2) `started_at=` が**無い・解けない**記録（旧版の supervisor.lock）は、文字列が違えば **`unknown`（消さない）**。`lstart` の文字列は地方時なので、違いが TZ の違いか再利用かを示せない（「TZ の差は 15 分の倍数」の推定はやめた: TZ の offset は分・秒の単位も取りうる。codex 2 回目 P2、`tzset(3)`）。読めなければ `unknown:<point>:<errno>`（元が EPERM なら EPERM のまま）。**D7 は何かを alive に変えることはなく、死に変えるのは `started_at` と etime の証拠があるときだけ**。前提: `lstart=`・`started_at=` は記録の pid のもので、その pid は `started_at` より前に起動した（呼び手の義務: `started_at` はその pid が起動した**後**の時刻）、と P1（壁時計が起動と取得の間に 2 秒より大きく戻らない）。D4 の引渡し（pid が後で起動した子に替わる。E9）はこの前提を崩すので、`LOCK_OWNER_EXTRA` に `lstart=` の行があれば**拒む**（`LHO_STAGE=lstart`、owner を書き直さない。F45。本番の呼び手は無い: supervisor は引き渡さない）
  - `started_at=` が無い旧い記録（`lstart-legacy*`）は、pid が死ねば（ESRCH）今どおり回収する。生きた pid が別のプロセスに再利用されている間は `unknown` で回収されず、文面 `machine-lock-holder-unknown … lstart:EMISMATCH` で名指す（消さない側の生存性の残り。旧版の supervisor の記録は PR1c が `started_at=` を書く形に替えるので、その後は生まれない）。2 回目の「owner の mtime を `started_at` の代わりに使う」はやめた（PM 決定 2: reused は `started_at`／etime の証拠があるときだけ）
  - `started_at=` が `date` で解けない記録は「無い」と同じ扱い（文字列が違えば `unknown`。F39）
  - `LOB_STARTED_AT` は**読みごとに空へ戻す**（`lock_parse_owner_text` の冒頭と `lock_obs_owner_fail`）。`lock_settle_gone` は退避を続けて読むので、戻さないと前の記録の時刻が `started_at=` の無い記録に持ち越され、無い記録を `reused` と読みうる（F40）
  - 時刻: `now` は `ps -o etime=` の**前**（`now_before`）に取り、起動の時刻は `now_before − etime`（`ps` の遅れが計算値を早める＝生きている側に倒れる）。`ps` の**後**にも取り（`now_after`）、`now_after < now_before` か `now_after − now_before ≥ 1000` なら `unknown:etime:ECLOCK`（観測の間の時計の後退を消す側に読まない。P1 の「観測の間」、F65。codex 3 回目 P2 の例: 起動 100 秒・取得 110 秒・`now_before`=1000 秒の後に時計が 970 秒へ戻ると BSD の `etime` は 870 秒で、前の手順は起動を 130 秒と出して `reused` にした。今は `now_after` が 970 秒台で `now_before` を下回るので unknown）。macOS の `lock_now_ms` は秒単位で、生きた持ち主の計算値は `started_at` ＋ 1 秒以下（`started_at` は秒に切り捨て）、観測の間に隠れた後退の誤差は 1 秒未満。閾値 2 秒に収まる。秒の境目を跨いだ観測（`now_after − now_before` が 1000）は unknown になり次の周回で読み直す（消さない側）
  - 用途: `alive` は「再利用と示せなかった」で、「同じプロセス」の証明ではない。**消すか消さないか**（ロックの D7）にだけ使う。止める判定には使わない（§4.2）
- **I6（3 実装の分担）**: I1・I2・I2-b・I4 は bash（`verify-run.sh` の節。`machine-lock.sh` が読み込む）・同期 JS・TS で同じ。I3 は猶予の口を持つ bash・同期 JS だけ（TS は `ownerlessGraceMs` も D6 のガードも持たない。呼び手が無い組み合わせは作らない）。I5 は bash の読み込み口だけ（supervisor.lock は bash だけが触る）。表は実装の軸を持ち、適用しない組み合わせは理由つきで「到達しない」（§2）
- **I7（例外は限界の行として名前と終わる条件を持つ）**: 表 F に「消す側に倒れうる残り（residual）」という倒れ方は無い（型で持たない）。解けない形は「回収しない＋文面」に倒す（旧版の tmp の生きた／不明な pid、`lstart=` だけの記録の不一致）。消す側に倒れうるのは前提の外だけで、倒れ方 `limit` の行（`mixed`＝混在の間だけ: F49〜F51、`premise`＝P1 の外: F42）として書き、どの行も「何が起きると前提が崩れるか」と「いつ消えるか」を持つ（§6.1。`premise` の行は終わらず前提として残る）。`mixed` の行が当たるのは **`v=` の無い記録・書き手**だけ（I9。新版の書き手の記録は `v=1` を持つ）。新版どうし・前提の内に `limit` の行は無い
- **I8（不変条件の範囲: 新版どうしと混在の間）**（PM 決定 1）:
  - (a) **新版どうし**（この PR の後の 3 実装と、PR1b・PR1c の後の run-lock・supervisor.lock の書き手だけが動く間）: **P0・P1 の内で**、生きた保有者のロックは誰も消さない・2 者が同時に持たない（I0〜I5）。P1（壁時計）の外では新版どうしでも F42・F70（`premise`）が起きうる（PM Claude 3 回目 P3-3。I7 のとおり `premise` の行は終わらず前提として残る）。60 秒を超えて止まり札が外れた書き手が再開しても成り立つ: 新しい書き手は名前で書かず名前で消さず（`link` の排他と同じ inode の確かめだけ）、片付けられた `<lock>` では ENOENT、後継が公開した `<lock>` では EEXIST で断る（I3 の理由）。F3 の戻しの `rmdir` が他の先頭の K1 の空の `<lock>` を消すことはあるが、相手は tmp の作成か `link` が ENOENT になって断るだけ（安全側。F3）。**前提 P0 の外（5 回目に見つけた。F69。PM 決定で直さない）**: K1（`mkdir` の後・tmp の前）で 10 分を超えて止まった書き手 W は、再開すると今その名前にある `<lock>` に tmp を作れる（`<lock>` が自分の `mkdir` したものかを確かめる手段が無い）。put-back（I2-c）の空の `<lock>` の窓（µs）に当たると、W の公開は成功し、退避の記録の持ち主（生きている）と W の 2 者が持ちうる。I2-c の `link` は W の owner を上書きしないので、`restore-failed` で名指される（4 回目までの `rename` では W の記録が黙って消えた）。W の K1 での 10 分超の停止（P0 の外）と µs の窓の重なりが要る。codex 4 回目 P2 の戻し（I2-b）の順序も同じ形（F69）
  - (b) **混在の間**（旧い写し: 旧版の `lib.sh`・`run-lock.sh`、PR1a 版とそれより前の `verify-run.sh` が残る間）: 旧い形の書き手が `mkdir`〜tmp〜`mv`／`: >`〜`cat >>` の途中で**猶予（10 分）を超えて止まり、回収の後に再開した**ときと、戻しの `link` の EEXIST（F58: 旧い書き手が戻しの間の owner の無い瞬間に書いた）のときだけ、2 者が持ちうる・後継の owner が壊れうる（F49〜F51・F55・F58）。当たるのは `v=` の無い書き手だけ（I9）。これは親 §1.8 の「60 秒を超える停止は前提の外」と同じ扱いの**既知の限界**。新版の側では、空の owner・空の `<lock>` の回収の猶予を 10 分にして窓を狭め（旧版の書き手の `mkdir`〜`mv` は通常ミリ秒）、旧版の tmp は pid が書き手でないと示せたときだけ消す（I3）ことで、残る窓を「10 分を超える停止からの再開」に限る。旧い写しが無くなれば（§6.1 の終わる条件）この限界は消える
- **I9（書き手の版 `v=`。4 回目、codex 3 回目 P2・PM 処分 3）**: 新版（PR1a-f 以降）の書き手は owner の記録に**書き手の版** `v=1` を足す（kv は `v=1` の行、JSON は `"v":1`。`lock_format_owner`・同期 JS・TS の `create` と、引渡し〔D4〕・`setOwnerFields` の書き直しは元の記録の `v` を保つ）。`v=1` は「I1 の形（tmp → `link`）・I1-b（自分の pid）・I2-b（rename の戻し）で書いた」の意味で、読み手の判定は `v` で変えない（振る舞いは記録の形と観測で決まる）。読み手（取得・D6 のガード・退避の整理）は `v` の無い記録（解けた記録で `v` が無い）と旧版の一時ファイル `owner.tmp.<pid>` を見たら、**プロセスごと・ロックごとに 1 回** `machine-lock-legacy-writer <lock> pid=<pid>`（`owner.tmp.*` は `pid=<名前の pid>`）を stderr／warn に出す（F66）。これは混在の終わりを観測する口で（§6.1 の (b)）、判定を変えない。0 バイトの owner・解けない owner は `v` を読めないので出さない（それぞれ I4 の文面で名指す）。**PR1c への影響**: supervisor.lock の kv の記録にも節の書式が `v=1` の行を足すので、PR1c の設計の記録の形（と字面で比べる試験）は `v=1` の行を含めて読む（PR1c の設計の直しはリーダーが別に指示する）。PR1b の run-lock の記録も同じ

`lstart` だけで TZ を解かない理由: `ps -o lstart=` は起動の瞬間の壁時計の値を地方時で出すので、同じプロセスでも読み手の TZ で文字列が変わる（E5）。地方時の差から TZ を推す方法（2 回目の「15 分の倍数」）は、分・秒の単位の offset（`UTC0` と `XXX-0:01` は 60 秒ずれる）を「違う起動」と読み、時計の後退と重なると生きた持ち主を消しうる（codex 2 回目 P2）。`started_at` はエポック（UTC）で書かれ、`now − etime` もエポックなので、2 つの比較は TZ に依らない。`lstart` は「同じなら確かに同じ起動」の速い道（0）にだけ使う。別ユーザーに再利用された pid も `ps` で読めるので、`started_at` があれば (1) で `reused` になる。

## 2. (b) 状態と遷移の表

### 2.1 軸

- **実装（3）**: `bash`・`sync`（同期 JS）・`ts`
- **owner の形（17）**:
  - 空・tmp だけ（9）: `empty-dir`（owner も中身も無い。D3 の対照）・`tmp-new`（`.owner-<token>` だけ）・`tmp-old-young`（`owner.tmp.<pid>` だけで猶予の内）・`tmp-old`（`owner.tmp.<pid>` だけで猶予を過ぎた。観測は名前の pid。pid が生きていて起動が tmp の mtime ＋ 2 秒より後〔再利用〕は gone と同じ答え: 表 F の F52）・`tmp-stray`（一時ファイルの形でない名前やディレクトリが混ざる）・`tmp-new+gone-dead`（canonical に `tmp-new`、死んだ記録の `.gone-*` がある。codex P2 の組。途中の戻しの述語を広げる変異の対照）・`tmp-new+gone-alive`（canonical に `tmp-new`、生きた記録の `.gone-*`）
  - 壊れ（2）: `empty-owner`（0 バイト）・`garbage-owner`（解けない中身）
  - 完全で D7 の対象（8、`lstart=` あり）: `lstart-match`・`lstart-tz`（`started_at=` あり、TZ が違うだけの生きた持ち主。etime の起動が `started_at` 以前）・`lstart-reused`（`started_at=` あり、再利用。etime の起動が `started_at` ＋ 2 秒より後）・`lstart-fails`（`ps -o lstart=` が読めない）・`etime-fails`（lstart は違い、`etime` が読めない・形が不正）・`lstart-same-etime-fails`（lstart は同じ、`etime` は読めない＝読まないので alive）・`lstart-legacy`（`started_at=` 無し、TZ が違うだけの生きた持ち主。文字列が違うので unknown）・`lstart-legacy-reused`（`started_at=` 無し、再利用。同じく unknown＝消さない。PM 決定 2）
  - 完全で `lstart=` の無い記録は D7 の対象外で、この PR で振る舞いが変わらない（PR1a の表のまま）ので軸に入れない
- **呼び手（4）**: `acquire-head-grace`（猶予つきの先頭の取得: run-lock・supervisor.lock）・`acquire-head-nograce`（猶予の無い先頭の取得: verify のゲート・merge-pr・precheck・gate-runner）・`acquire-behind`（先頭でない取得者）・`guard-head`（回収だけの先頭: D6 `lock_recover_only`／`recoverIfDead`）
- **観測の 3 値**: 形ごとに決め手が違う（雛形の `OBS_MEANING`）。空・tmp だけ（`tmp-old*` を除く）・壊れは「年齢」（`alive`＝猶予以内、`gone`＝猶予より古い。猶予は本番の値 10 分〔猶予つきの呼び手の `LOCK_OWNERLESS_GRACE_MS`=600000、空の owner の固定の `LOCK_EMPTY_OWNER_GRACE_MS`=600000〕で駆動する。`unknown`＝一覧・lstat・mtime・owner の読みの失敗）。`tmp-old*` は「名前の pid の `kill -0`」（`tmp-old-young` は年齢が先なので読まない）。`tmp-new+gone-alive` は退避の記録が生きているので canonical の年齢を読まない。D7 の形は「記録の pid の `kill -0`」（`alive`、`gone`＝ESRCH、`unknown`＝EPERM。EIO などは表 F の F32）

### 2.2 結果

- 取得: `acquired`（ロックは `mine`）／`refused:<文面>`（`rec`〔生きた記録〕・`taking`〔owner の無い若い `<lock>`・若い空の owner、または猶予の無い呼び手〕・`queue`〔先頭でない〕・`unk`〔不明〕・`corrupt`〔解けない owner、新〕・`stray`〔I3 の対象外の中身、新〕・`old-taker`〔旧版の tmp の pid が生きている、新〕）
- D6: `removed`／`kept`（表 T の形で到達するのはこの 2 つ。D6 の `absent`〔F63〕・`not-head`〔F48〕・`restore-failed`〔F64・F67〕は表 F の行で固定する。4 回目で `absent`・`restore-failed` の行を足した: codex 3 回目 P3。5 回目で put-back の `link` の EEXIST を F67 に足した）
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
| lstart-legacy | **unk**（→今 acquired） / acquired / unk | 到達しない | **kept**（→今 removed） / removed / kept |
| lstart-legacy-reused | **unk**（→今 acquired） / acquired / unk | 到達しない | **kept**（→今 removed） / removed / kept |

`acquire-behind` は全ての形・値で `refused:queue`（I0-b）。

3 回目で変わったセル: `lstart-legacy` × alive は `rec` → `unk`、`lstart-legacy-reused` × alive は `acquired` → `unk`・`removed` → `kept`、`lstart-legacy-reused` × unknown は `acquired` → `unk`・`removed` → `kept`（今の実装と同じになり、陽性の対照から外れた）。`lstart=` だけの記録の不一致は TZ か再利用かを示せないので消さない（I5 の (2)）。

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
- 表 F（外部の呼び出しの失敗、§3）: **71 行**。実装 × 結果の欄の呼び手に展開して **331 件**、到達しない **42**（TS の `AG` は `ts-no-grace`、TS の `GH`・`GB` は `ts-no-guard`）、到達する **289 件**（1 件ごとに `it.todo`。3 回目の 55 行・250 件・220 件に 4 回目の F56〜F66 の 11 行・51 件〔到達しない 7・到達する 44〕、5 回目の F67 の 1 行・9 件〔到達しない 2（TS の `AG`・`GH`）・到達する 7〕、5 回目の追加の F68〜F71 の 4 行・21 件〔到達しない 3・到達する 18〕を足した）
- 合計 **646 行**（T 342・K 15・F 289。雛形の `it.todo` は、これに表 K の陽性の対照 3 本〔実装ごとに今の実装が `empty-owner` を残すこと、§2.6〕を足した 649）

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

## 3. (c) 外部の呼び出しの失敗の倒れ方（表 F、71 行・実装 × 呼び手で 331 件、到達する 289 件）

倒れ方は 3 つ（I7）: `keep`＝何も消さない・取らない（I3・I4 の規則どおりの片付けは「規則」で、失敗の倒れ方ではない）、`own-only`＝この呼び手が自分で作ったもの（自分の tmp・この `mkdir` が作った空の `<lock>`・この `link` が作った owner〔同じ inode を確かめて〕）だけを戻す、`limit`＝前提の外で消す側に倒れうる既知の限界（`mixed`＝混在の間だけ、`premise`＝P1 の外。どの行も終わる条件を持つ。I7・I8）。

**呼び手は操作名でなく実際の呼び手**（codex 2 回目 P2。表 T の呼び手と同じ名前）: `AG`＝猶予つきの先頭の取得（`acquire-head-grace`）、`AN`＝猶予の無い先頭の取得（`acquire-head-nograce`）、`GH`＝D6 のガードの先頭（`guard-head`。`lock_recover_only`／`recoverIfDead`）、`GB`＝先頭になれない D6 のガード（`guard-behind`）、`TR`＝札の退かし（`lock_ticket_retirable`／`ticketRetirable`／`retirable`。全ての呼び手の列の待ちの中）、`HO`＝引渡し（`lock_hand_off`）、`RH`＝持ち主でない者の先頭としての解放（D5 `lock_release_as_head`／`releaseAsHead`。bash・同期 JS だけ。4 回目）。結果の型は呼び手ごと: 取得は `acquired`／`refused:<文面>`、D6 は `removed`／`kept`／`absent`／`restore-failed`（**`kept` を持つ**。不明は `LRO_UNKNOWN`／結果の `unknown` で名指す）、`GB` は `not-head`、`TR` は `retired`／`kept`、`HO` は `handed`／`failed`、`RH` は `released`／`missing`／`deferred`／`kept`／`unknown`／`not-head`。同じ失敗を取得とガードが通るとき、両方の結果を行に書く（取得の `acquired` ⇔ ガードの `removed` は雛形が検査する）。

実装の列は呼び出しが在る実装。行は「実装 × 結果の欄に書いた呼び手」に展開され（雛形の `F_CASES`）、TS の `AG` は `ts-no-grace`、TS の `GH`・`GB` は `ts-no-guard` で到達しない。D7 の行の `AN` は `no-kv-for-nograce`、片付けの行の `AN` は猶予が無いので片付けを呼ばない（結果の欄に書かない）。

| # | 実装 | 呼び出し・失敗（点） | 倒れ方 | 呼び手ごとの結果 | ロックの行方 |
|---|---|---|---|---|---|
| F1 | 3 | `mkdir <lock>` が EEXIST 以外（`mkdir-lock`） | keep | AG・AN `refused:unk` | 何も作らない |
| F2 | 3 | tmp の排他作成が EEXIST（同じ token の tmp が在る。`owner-create`） | own-only | AG・AN `refused:unk` | 変わらない（tmp は開いていないので消さない。`rmdir` は空でないので残る） |
| F3 | 3 | tmp の作成がその他の errno（EACCES・ENOSPC・ENOENT。`owner-create`） | own-only | AG・AN `refused:unk` | この `mkdir` が作った `<lock>` を `rmdir` で戻す（空のときだけ）。札が期限＋60 秒で外れた後の再開なら、`rmdir` が他の先頭の K1 の空の `<lock>` を消すことがある。そのとき相手は tmp の作成か `link` が ENOENT で断る（F3・F11）だけで、誰も持たない（安全側。PM Claude P3-2。「先頭は自分なので他者の `<lock>` ではない」は 60 秒の内だけ） |
| F4 | 3 | tmp の書き込みの失敗（ENOSPC・EIO。`owner-write`） | own-only | AG・AN `refused:write-failed` | 自分の tmp と `<lock>` を戻す |
| F5 | 3 | 短い書き込み（JS・TS は戻り値の合計が足りない、bash は I1 の同じ取り方で読み直した文字列が違う。`owner-write-short`） | own-only | AG・AN `refused:write-failed` | 同上 |
| F6 | sync・ts | `closeSync` の失敗（`owner-close`。bash はリダイレクトの閉じの失敗を F5 の読み直しで捕まえる） | own-only | AN `refused:write-failed`、sync は AG も | 同上 |
| F7 | 3 | `link` が EEXIST: owner が通常ファイル（`owner-publish`） | own-only | AG・AN `refused:owner-exists` | 変わらない（自分の tmp だけ消す） |
| F8 | 3 | `link` が EEXIST: owner がディレクトリ | own-only | 同上 | 変わらない。**ディレクトリの中に何も作らない**（`ln` なら作る。E11） |
| F9 | 3 | `link` が EEXIST: owner がディレクトリへの symlink（`<lock>` の外を指す） | own-only | 同上 | 変わらない。symlink の先に何も作らない |
| F10 | 3 | `link` が EEXIST: owner がファイルへの symlink | own-only | 同上 | 変わらない |
| F11 | 3 | `link` が ENOENT（自分の tmp か `<lock>` が片付けられた） | own-only | AG・AN `refused:unk` | 変わらない。自分の tmp を（在れば）消し、**`rmdir` しない**（今ある `<lock>` は他者のもの） |
| F12 | 3 | `link` がその他（EPERM・ENOTSUP・EIO。`owner-publish`） | own-only | AG・AN `refused:unk` | 自分の tmp と `<lock>` を戻す |
| F13 | 3 | 読み直しが不明（EIO。`owner-readback`）、owner を `.undo-<token>` へ rename した先が自分の tmp と同じ inode（I2-b） | own-only | AG・AN `refused:unk` | `.undo-<token>` と tmp を消し `rmdir`（今の `70+i` と同じ結果。名前の `owner` は消さない: 4 回目） |
| F14 | 3 | 読み直しが不明、rename した先が自分の tmp と違う inode・symlink・tmp が無く比べられない | own-only | AG・AN `refused:unk` | 変わらない（`link` で `<lock>/owner` に戻し `.undo-<token>` を消す。自分の tmp だけ消す） |
| F15 | 3 | 読み直しが他者の記録（`owner-readback`） | own-only | AG・AN `refused:not-ours` | 変わらない（自分の tmp だけ消す） |
| F16 | 3 | 公開の後の tmp の削除の失敗（`owner-unlink`） | keep | AG・AN `acquired` | 取った。tmp は owner の隣に残り、解放・回収の `rm -rf` で消える |
| F17 | 3 | 戻しの tmp の削除の失敗（`owner-unlink`） | keep | AG・AN `refused:write-failed` | `<lock>` と自分の tmp が残る（`tmp-new`）。猶予つきの先頭が猶予の後に片付ける（I3） |
| F18 | 3 | 戻しの `rmdir <lock>` の失敗（`lock-rmdir`） | keep | AG・AN `refused:write-failed` | 空の `<lock>` が残る（今のまま） |
| F19 | bash・sync | 片付けの一覧の失敗（`lock-list`） | keep | AG `refused:unk`、GH `kept` | 変わらない。その周回は `mkdir` しない |
| F20 | bash・sync | 一時ファイルの lstat の失敗（`ownerless-tmp-lstat`） | keep | AG `refused:unk`、GH `kept` | 同上 |
| F21 | bash・sync | `<lock>`・一時ファイルの mtime の失敗（`ownerless-mtime`） | keep | AG `refused:unk`、GH `kept` | 同上 |
| F22 | bash・sync | 一時ファイルの削除の失敗（ENOENT 以外。`ownerless-tmp-unlink`） | keep | AG `refused:unk`、GH `kept` | その周回は `rmdir` も `mkdir` もしない |
| F23 | bash・sync | 一時ファイルの削除が ENOENT（旧版の片付けと同時） | keep | AG `acquired`、GH `removed` | 「もう無い」と読み、次の名前・`rmdir` へ（規則どおりの片付けが続く） |
| F24 | bash・sync | `rmdir` が ENOTEMPTY／EEXIST（途中で誰かが公開した。`ownerless-rmdir`） | keep | AG `refused:rec`、GH `kept` | 消さず、公開された owner を記録として判定する |
| F25 | bash・sync | `rmdir` がその他の errno（`ownerless-rmdir`） | keep | AG `refused:unk`、GH `kept` | 変わらない。その周回は `mkdir` しない |
| F26 | bash・sync | 旧版の tmp の pid の `kill -0` が EPERM・EIO（`owner-tmp-pid`） | keep | AG `refused:unk`、GH `kept` | 変わらない |
| F27 | bash・sync | 旧版の tmp の pid が生きていて、起動が tmp の mtime ＋ 2 秒以前（書き手かもしれない） | keep | AG `refused:old-taker`、GH `kept` | 変わらない。名指す。書き手が再開すれば自分で `mv` する |
| F28 | bash・sync | 旧版の tmp の名前の pid が数字でない | keep | AG `refused:stray`、GH `kept` | 変わらない |
| F29 | 3 | 空の owner の mtime が 10 分以内 | keep | AG・AN `refused:taking`、GH `kept` | 変わらない（書いている途中かもしれない） |
| F30 | 3 | 空の owner を退かす `mv` の失敗（`empty-owner-move`） | keep | AG・AN `refused:unk`、GH `kept` | 変わらない |
| F31 | 3 | 退かした先の owner が 0 バイトでなくなった（書き手が間に書き終えた。**回収を確かめた後に止まった古い先頭が、後継の生きた `<lock>` を退かした**形も同じ行: PM Claude 3 回目 P3-4） | keep | AG・AN `refused:rec`、GH `kept` | 退避を残す。次の周回で `lock_settle_gone` が記録として判定する（生きていれば戻す、§2.7）。実装の試験は割込みの口 `empty-owner-moved`（bash の pause、同期 JS・TS の `onRecover`）で退避の owner に書く |
| F32 | bash | D7: `kill -0` が EPERM 以外の失敗（EIO。`pid`） | keep | AG `refused:unk`、GH `kept` | 不明のまま（D7 は当てない） |
| F33 | bash | D7: `ps -o lstart=` の失敗・空（`lstart`） | keep | AG `refused:unk`、GH `kept` | 元が alive なら `unknown:lstart:<errno>`、EPERM なら EPERM のまま |
| F34 | bash | D7: `started_at=` の無い記録で、`lstart` の文字列が 60 秒違う（`UTC0` と `XXX-0:01` の読み手。生きた持ち主） | keep | AG `refused:unk`、GH `kept` | `unknown:lstart:EMISMATCH`。2 回目の「15 分の倍数でない＝違う起動」をやめた（codex 2 回目 P2。PM 決定 2 の「60 秒差の行は unknown」） |
| F35 | bash | D7: `ps -o etime=` の失敗・空（`etime`） | keep | AG `refused:unk`、GH `kept` | 元が alive なら `unknown:etime:<errno>`、EPERM なら EPERM のまま |
| F36 | bash | D7: `etime` の形が不正（`bad:bad`・`1:99`・`-1:00`・欄が 4 つ。`etime`） | keep | AG `refused:unk`、GH `kept` | 同上（不正を経過 0 秒と読まない） |
| F37 | 3 | 札の pid の `etime` の形が不正 | keep | TR `kept` | 札を退かさない。bash の `lock_pid_start_ms` は新しい厳しい解き方を使い、JS・TS の `parseEtime` は範囲を足す。`now` の前後の取り方（P1 の「観測の間」）も 3 実装の札の起動の時刻に同じく当てる（観測の間の後退は退かさない） |
| F38 | bash | D7: `started_at=` の無い記録の pid が、別のプロセスに再利用されて生きている | keep | AG `refused:unk`、GH `kept` | 消さない（`unknown:lstart:EMISMATCH` で名指す）。pid が死ねば回収。2 回目の owner の mtime の代用はやめた（PM 決定 2）。文面は人の手順つき（PM Claude 3 回目 P3-5）: `machine-lock-holder-unknown <lock> pid=<p> lstart:EMISMATCH (… the lock is kept until pid <p> ends. By hand: if the command of pid <p> is not the holder the record names, the record is an older one: remove <lock> by hand)` |
| F39 | bash | D7: `started_at=` が `date` で解けない、`lstart` の文字列が違う | keep | AG `refused:unk`、GH `kept` | 「無い」と同じ（F34） |
| F40 | bash | D7: `started_at=` のある記録の後に、無い記録を読む（`lock_settle_gone` の続けての読み）、文字列が違う | keep | AG `refused:unk`、GH `kept` | `LOB_STARTED_AT` は読みごとに空。前の記録の時刻で `reused` と読まない |
| F41 | bash | D7: `hostname` が記録の `host=` と違う | keep | AG `refused:rec`、GH `kept` | 他 host の記録は alive（D7 は当てない） |
| F42 | bash | D7: 持ち主の起動から取得までの間に壁時計が 2 秒より大きく戻り、かつ書き手と読み手の TZ が違う（文字列が違う） | limit（premise） | AG `acquired`、GH `removed` | **生きた持ち主を `reused` と読む**（P1 の外）。GNU の `etime` で取得の後・観測の前に 2 秒より大きく進んだ時計も同じ（P1 の「寄せられない形」(2)）。観測の間（`now` を取ってから `ps` まで）の変更はこの行でなく F65（unknown に寄せた）。TZ が同じなら文字列が一致して起きない。当たるのは新版の書き手も（`v=` によらない）。終わる条件: 無し（前提として残す。親 §1.8 と同じ扱い。PM Claude 申し送り B の 2） |
| F43 | bash | D7: launchd の環境（`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`TZ`・`LC_ALL` 未設定）で書いた記録を `TZ=UTC`・`TZ=Asia/Tokyo` の読み手が読む | keep | AG `refused:rec`、GH `kept` | `started_at` と etime の比較で alive。`lstart-tz` の具体の 1 行 |
| F44 | bash | D7: 記録に `pgid=` と `lstart=` の両方、pid は gone・G は生（元の判定が G で alive） | keep | AG `refused:rec`、GH `kept` | D7 を当てない（`kill -0` の pid が gone）。本番の記録には無い形 |
| F45 | bash | 引渡し: `LOCK_OWNER_EXTRA` に `lstart=` の行がある `lock_hand_off` | keep | HO `failed` | owner を書き直さない（`LHO_STAGE=lstart`）。I5 の前提を守る |
| F46 | 3 | 解けない owner（読めた） | keep | AG・AN `refused:corrupt`、GH `kept` | 誰も消さない。断りと D6 の結果で `<lock>/owner` を名指す（I4） |
| F47 | bash・sync | D6 の故障: ガードの「owner が無く中が空か」の確かめ（`lock_ownerless_empty`、`verify-run.sh:2030`）が不明（`lock-list`） | keep | GH `kept` | 変わらない。`LRO_UNKNOWN` で名指す（取得者はこの確かめを通らない） |
| F48 | bash・sync | D6 の故障: ガードが予算のうちに先頭になれない（生きた札が前に居る） | keep | GB `not-head` | 何も動かさない（I0-b） |
| F49 | bash・sync | 旧版の run-lock・supervisor.lock の書き手（札なし）が `mkdir` の後・`owner.tmp.<pid>` の前（旧版の K1。pid がどこにも無い）で 10 分を超えて止まり、先頭が `empty-dir` を回収して取った後に再開する | limit（mixed） | AG `acquired`、GH `removed` | 再開した書き手が後継の `<lock>` に tmp を書き `mv -f` で後継の owner を置き換える＝**2 者が持ちうる**（codex 2 回目 P1）。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の 1・3 と (a)(b) |
| F50 | 3 | PR1a 版の書き手（`: >` → 名前で `cat >>`、失敗で名前で `rm -f owner`）の pid は生きているが札は期限＋60 秒で外れ、空の owner のまま 10 分を超えて止まり、先頭が空の owner を回収して取った後に再開する | limit（mixed） | AG・AN `acquired`、GH `removed` | 再開した書き手が後継の owner に追記（解けない owner になり誰も消さず止まる）か、名前で後継の owner を消す＝**2 者が持ちうる**（PM Claude 2 回目 P2-A）。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の 2・3 と (a)(b) |
| F51 | 3 | PR1a より前の写し（`printf > owner`、cmate-verify の旧い写し）が owner を開いた後・pid を書く前に 10 分を超えて止まり、先頭が空の owner を回収して取った後に再開する | limit（mixed） | AG・AN `acquired`、GH `removed` | 書き込みは消された inode に届き、書き手は取ったと思いうる＝**2 者が持ちうる**（読み直しの無い写し）。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の 2・3 と (a)(b) |
| F52 | bash・sync | 旧版の tmp の pid が生きているが、起動が tmp の mtime ＋ 2 秒より後（再利用。PM Claude P3-1） | keep | AG `acquired`、GH `removed` | 規則どおりの片付け（書き手でないと示せた）。2 回目は永久に `old-taker` だった |
| F53 | bash・sync | 旧版の tmp の pid が生きていて、その `ps -o etime=` が読めない・形が不正、または観測の間に時計が戻った・観測が 1 秒以上（`etime`、`ECLOCK`） | keep | AG `refused:unk`、GH `kept` | 変わらない |
| F54 | bash | D7: `started_at=` のある記録で、`lstart` の文字列が 60 秒違う（分の単位の TZ の差の生きた持ち主） | keep | AG `refused:rec`、GH `kept` | etime の起動が `started_at` 以前なので alive（文字列の差の大きさは読まない） |
| F55 | bash・sync | 旧版の書き手の起動から tmp の書き込みまでの間に壁時計が 2 秒より大きく戻り、書き手が tmp と `mv` の間で 10 分を超えて止まる | limit（mixed） | AG `acquired`、GH `removed` | 生きた書き手の tmp を F52 の再利用と読んで片付け、再開した `mv -f` が ENOENT → 書き手の `rm -rf "$dir"` が後継の `<lock>` を消しうる。P1 の外かつ混在の間。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の 1・3 と (a)(b) |
| F56 | bash・sync | 最初の取得の `LOCK_OWNER_PID`／`ownerPid` が自分でない（`owner-pid`。4 回目、I1-b） | keep | AG・AN `refused:unk` | 何も作らない（札も取らない・`mkdir` しない）。`machine-lock-owner-pid-not-self`。他者の pid は引渡し（D4）だけ |
| F57 | 3 | F13・F14 の戻しの途中で止まる: `rename` の後・inode の確かめの前、または確かめの後・`unlink`／戻しの `link` の前に 60 秒を超えて（**確認の直後の割込み**。4 回目） | own-only | AG・AN `refused:unk` | 間は `<lock>` に owner が無く `.undo-<token>` があり、どの先頭も `stray` で片付けない（I3）・回収しない。再開した書き手は自分の名前 `.undo-<token>` だけを確かめ・消す・戻す（名前の `owner` を消さない）。書き手が死ねば `<lock>` は `stray` のまま人が見る（消す側に倒れない） |
| F58 | 3 | 戻しの `link(.undo-<token>, <lock>/owner)` が EEXIST（`owner-undo-link`。戻しの間の owner の無い瞬間に旧い書き手の `: >`／`printf >` が owner を作った） | limit（mixed） | AG・AN `refused:unk` | 戻さず `.undo-<token>` を残し `machine-lock-undo-restore-failed` で人に知らせる。退かした記録の持ち主と旧い書き手の **2 者が持ちうる**。新版の書き手は `mkdir` した自分の `<lock>` にしか `link` せず、後継の `<lock>` では tmp が無く ENOENT（F11）なので作らない。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の 2・3 と (a)(b) |
| F59 | 3 | 戻しの `rename(<lock>/owner, .undo-<token>)` が ENOENT（`owner-undo-rename`。owner がもう無い） | own-only | AG・AN `refused:unk` | 変わらない。自分の tmp だけ消し、`rmdir` しない（今ある `<lock>` は自分のものと示せない） |
| F60 | 3 | 戻しの `rename` がその他の errno（`owner-undo-rename`） | own-only | AG・AN `refused:unk` | 変わらない（owner を消さない。自分の tmp だけ）。不明として名指す |
| F61 | 3 | 読み直しが不明の後・戻しの `rename` の前に止まり、その間に記録の pid（bash は公開がパイプラインのサブシェルで走るので親 `$$` だけが死ぬ形）が死んで札も外れ、後継が回収して取った後に再開する（codex 3 回目 P2 の順序。新版どうし・時計は正常） | own-only | AG・AN `refused:unk` | 再開した書き手の `rename` は後継の owner を `.undo-<token>` へ動かすが、自分の tmp は回収で `<lock>` ごと退かされて無いので比べられず、`link` で後継の owner を戻す（同じ inode）。後継の owner は消えない。間の owner の無い瞬間は F57 と同じく誰も片付けない（後継の読み直し・解放がその瞬間に当たれば不明・missing で消さない側） |
| F62 | bash・sync | D5（持ち主でない者の先頭の解放）が記録を gone と判定した後に止まり、札が外れ、別の先頭が回収して取った後に再開する（4 回目。今は `rm -rf <lock>`／`rmSync(lockPath)` で名前で消す） | keep | RH `kept` | 名前で消さず、`lock_recover`／`recoverLock` の形（自分の名前へ退かし → 退かした記録の token を確かめ → 違えば戻す）で消す。後継の token は渡された T0・T1 と違うので戻す |
| F63 | bash・sync | D6 のガードが先頭になったとき `<lock>` が無い | keep | GH `absent` | 変わらない（何も無い。codex 3 回目 P3） |
| F64 | bash・sync | D6 のガードが退かした記録の token が違い（間に後継が取った）、戻しの `mkdir` が失敗する（`restore-mkdir`） | keep | GH `restore-failed` | 退避を残す（§2.7。退避の記録が生きている間は全ての先頭が保有中と読む）。`machine-lock-restore-failed`（codex 3 回目 P3） |
| F65 | bash | D7: `now` を取ってから `ps -o etime=` を読むまでに時計が戻った（`now_after < now_before`）、または観測が 1 秒以上（4 回目、codex 3 回目 P2） | keep | AG `refused:unk`、GH `kept` | `unknown:etime:ECLOCK`（消さない）。次の周回で読み直す。隠れた小さな後退は誤差 1 秒未満で 2 秒の余裕に収まる（P1 の「観測の間」） |
| F66 | 3 | 解けた記録に `v=` が無い（PR1a 版とそれより前の写し・旧版の run-lock・supervisor.lock の書き手）、または旧版の `owner.tmp.<pid>` を見た | keep | AG・AN `refused:rec`、GH `kept`（生きた記録のとき） | 判定は変えない。プロセスごと・ロックごとに 1 回 `machine-lock-legacy-writer <lock> pid=<pid>`（§6.1 の (b) の観測の口。I9） |
| F67 | 3 | 退避の owner の put-back（I2-c。bash `lock_move_owner_in`、同期 JS・TS の `moveOwnerIn` と `recoverLock` の戻し）の確かめ（`created`／`lock_ownerless_empty` が `yes`）の直後、`link(gone/owner, <lock>/owner)` の前に owner が公開される（`restore-rename` の点の `link` が EEXIST。割込みの口は `pause:restore-mkdir` の後。5 回目、PM Claude 4 回目 P2-1） | keep | AG・AN `refused:rec`、GH `restore-failed` | 戻さず退避を残し、`<lock>` も `rmdir` しない（中は公開した者の owner）。`machine-lock-restore-failed <lock>: kept <gone> (EEXIST)`。公開された owner は上書きされない（4 回目までの `rename` は上書きした）。公開したのが K1 から 10 分を超えて止まり再開した新版の書き手なら、退避の記録の持ち主と 2 者が持ちうる（前提 P0 の外、F69） |
| F68 | bash・sync | 呼び手の欄（同期 JS の `ownerFields`、bash の `LOCK_OWNER_EXTRA`）に記録の予約の鍵（`pid`・`host`・`token`・`acquiredAt`／`started_at`・`pgid`・`v`。同期 JS は `lstart`・`done` も、bash は `lstart=` の 2 行目以降）がある（`owner-fields`。5 回目の追加、codex 4 回目 P2・PM 決定 3） | keep | AG・AN `refused:unk` | 何も作らない（札も取らない・`mkdir` しない）。`machine-lock-owner-field-reserved <lock> key=<k>`。同期 JS の `setOwnerFields` は `false`。TS は呼び手の欄の口が無く到達しない（I1-c）。前提に依らないので塞ぐ |
| F69 | 3 | **前提の外（P0）**: 新版の書き手 C が K1（`mkdir` の後・tmp の前）で 10 分を超えて止まり、A が回収して公開 → F61 の順序で A の親が死に B が取る → C が再開して B の `<lock>` の中に tmp を作る → A の戻しが B の owner を `.undo-<A>` へ動かした空いた名前へ C が `link` して取る → A の戻しの `link` は EEXIST（codex 4 回目 P2）。put-back（I2-c）の空の `<lock>` に K1 から再開した書き手が公開する形（F67）も同じ | limit（premise） | AG・AN `refused:unk` | B と C の **2 者が持ちうる**（A は `.undo-<A>` を残し `machine-lock-undo-restore-failed`／`machine-lock-restore-failed` で名指す）。新版どうしでも起きる。直さない（ファイルシステムだけのロックにフェンシングの手段が無い。前提 P0）。終わる条件なし（P0 として残る） |
| F70 | bash | **前提の外（P1）**: D7: 読み手が `now_before` を取った後に壁時計が戻り、`ps -o etime=` の後に読み手が止まって、`now_after` が `now_before` と同じ所まで戻る（BSD の etime の例: 起動 100 秒・取得 110 秒、`now_before`=1000 秒 → 時計が 970 秒へ → etime=870 秒 → 読み手が 30 秒止まる → `now_after`=1000 秒。差 0 で検査を通り、起動を 130 秒と出す。codex 4 回目 P2） | limit（premise） | AG `acquired`、GH `removed` | `lstart` の文字列が違う（TZ の差の）生きた持ち主を `reused` と読んで回収しうる＝**生きた保有者を消しうる**。壁時計 2 回の差では観測の実の経過を縛れない。直さない（P1: 書き手の起動から読み手の観測の終わりまで壁時計が 2 秒より大きく変わらない）。終わる条件なし（P1 として残る） |
| F71 | 3 | **前提の外（P0）・混在**: 旧い関数を読み込んだ汎用のシェル（`bash -s`・対話シェル）や汎用の node が、旧い写しの手順の途中（書く前を含む）で 10 分を超えて止まっている。`ps` の command 欄に §6.1 の (a) の名前が無いので絞り込みから落ち、書く前に止まっているので (b) の `machine-lock-legacy-writer` にも出ない（codex 4 回目 P2） | limit（mixed） | AG・AN `acquired`、GH `removed` | 再開した旧い書き手が後継の owner を `mv -f`／名前で消す＝**2 者が持ちうる**（F49〜F51 と同じ形）。当たるのは `v=` の無い書き手だけ（I9）。終わる条件: §6.1 の (c) **配備のあとの再起動**（`ps` の絞り込みは補助の最善の手順） |

消す操作は全て own-only（自分の tmp・自分の `mkdir`・同じ inode を確かめた自分の `link`）か、規則（I3 の「書き手でないと示せた旧版の tmp・猶予を過ぎた新しい tmp の名前と空の `<lock>` の `rmdir`」、I4 の「先頭が退かして 0 バイトのままと確かめた空の owner」、I5 の「`started_at` と etime が示した再利用」）。新版どうし・前提の内では、どれも生きた記録（`owner`）を消さない。`limit` の 9 行（F42・F49・F50・F51・F55・F58・F69・F70・F71）だけが前提の外で消す側に倒れうる（I7・I8。どれも前提 P0 か P1 の外: 冒頭の「前提 P0」）。F67 は消す側に倒れない（`keep`）。公開したのが K1 から 10 分を超えて止まった新版の書き手のときの 2 者は前提 P0 の外で、F69 で名指す。`mixed` の 6 行（F49・F50・F51・F55・F58・F71）は `v=` の無い書き手にだけ当たる（I9）。F69・F70 は新版の書き手にも当たる `premise` の行（前提として残る）。確認の後に名前で消す経路は §3.1。

流用する既存の部品の倒れ方: `lock_obs_mv`・`lock_obs_list`・`lock_obs_lstat`・`lock_obs_mtime` は 3 値で答える（§2.8）。`lock_pid_start_ms` の解き方は使わない（E7）: §4 の `machine_lock_etime_ms` に替え、札の退かしもそれを使う（F37）。10 秒のキャッシュは `$(…)` のコマンド置換の中では親に残らない（効かないだけで害は無い）ので D7 は使わない。

### 3.1 確認の後に名前で消す経路（4 回目、codex 3 回目 P2・PM 処分 1）

「確かめてから名前で消す（書き換える）」は、確かめと操作の間に名前の指す先が後継のものに替わると後継を消す。PR1a-f が書く 3 実装の機械ロックの節（`verify-run.sh` の節・`machine-lock.sh`・`machine-lock-sync.mjs`・`machine-lock.ts`）を `rm`／`rmSync`／`unlinkSync`／`rmdir`／`mv`／`renameSync` で洗い、ロックの名前（`<lock>`・`<lock>/owner`）に当たるものと、退避（`<lock>.gone-*`）の名前に当たるものを次に分けた（5 回目に PM Claude 4 回目の grep の 13 件と突き合わせて閉じた）。札（`lock_mark_done`・札の公開と取り下げ・`lock_ticket_retirable` の退かし、sync・TS の同じ関数）は外した。理由は「自分だけの名前」ではない（`lock_mark_done` は `lock_ticket_retirable` の後に**他の待ち手の札**も token を確かめてから `mv -f` で `done` の札に置き換える）: **札の置き換えは列の順だけを変え、ロックの owner・`<lock>`・退避を消さない**ので、ここで扱う「後継のロックを消す」には当たらない。札の確かめと置き換えの間の割込みは #4277 の札の規約の話で、この PR では変えない（PM Claude 4 回目 P3-5）。

| 経路 | 今 | PR1a-f の後 | 理由・残る条件 |
|---|---|---|---|
| 公開の後の戻し（F13・F14、3 実装） | 同じ inode を確かめて `<lock>/owner` を名前で消す（3 回目の設計）・今の develop は確かめずに名前で消す（`verify-run.sh:1645`、sync `:471`、TS `:685`） | **替えた**: `rename` で自分の名前 `.undo-<token>` へ → その inode を確かめる → 消す／`link` で戻す（I2-b、F57〜F61） | 戻しの EEXIST は混在の間だけ（F58、`limit`） |
| 書き込みの失敗の後始末（F4〜F6・F12、3 実装） | 名前で `owner` を消す（今の develop） | 消すのは自分の tmp（`.owner-<token>`）と、自分の `mkdir` の空の `<lock>` の `rmdir`（空でなければ失敗する）だけ。`owner` の名前は公開の前には在らない（I1） | `rmdir` が他の先頭の K1 の空の `<lock>` に当たることは F3（安全側） |
| D5 持ち主でない者の先頭の解放（bash `lock_release_as_head` の `rm -rf "$lrah_lock"`、sync `releaseAsHead` の `rmSync(lockPath)`） | 記録を gone と判定してから名前で `<lock>` を消す | **替えた**: `lock_recover`／`recoverLock`（自分の名前へ退かし、退かした記録の token が渡された T0・T1 なら消し、違えば戻す。F62） | 札が外れた後の再開でも後継の `<lock>` は戻る |
| 空の owner の回収（I4、3 実装） | — | 退かしてから 0 バイトのままを確かめて `rm -rf`（自分の退避の名前） | 確かめの後の操作は自分の名前だけ |
| 死んだ持ち主の回収（`lock_recover`・`recoverLock`、D6 を含む） | 退かしてから token を確かめる（#4277・#4288 §2.7） | 変えない | 同上 |
| owner の無い `<lock>` の片付け（I3、bash・sync） | — | 一覧で見た一時ファイルの名前を `unlink` してから `rmdir` | 消すのは一時ファイルの名前だけで `owner` は消さない。後継が公開していれば `rmdir` が ENOTEMPTY（F24）、後継の K1 の空の `<lock>` を消すのは F3 と同じ安全側（I8 (a)）。旧版の `owner.tmp.<pid>` の名前が確かめの後に別の書き手のものに替わるのは同じ pid の旧版の書き手が同じ `<lock>` を作り直したときだけで、その書き手は `mv` が ENOENT で失敗して `rm -rf "$dir"` する（F55 と同じ `mixed` の窓） |
| 持ち主自身の解放（D12: bash `lock_release_held`・`lock_release`、sync・TS の `release`） | 記録の pid が自分（bash は main シェルかつ `$$` が生きている）でグループが空のときだけ名前で消す | 変えない（I0-a）。ただし下の行の `lock_release` の `missing)` の枝だけ狭める | 記録の pid が呼び手自身なので、呼び手が止まっている間も pid は生きていて誰も回収しない。I1-b で最初の記録の pid も自分だけになり、この前提が取得の最初から成り立つ。missing・corrupt は消さない（bash `lock_release_held`・sync・TS） |
| bash `lock_release`（ゲートの JSON の解放。呼び手は `verify-run.sh` のゲートの終わり）の `missing)`・`corrupt` の枝 | 記録を**読めないまま**名前で `rm -rf <lock>`（`verify-run.sh:1727-1732`）してから自分の退避を片付ける | **狭めた（5 回目、PM Claude 4 回目 P3-1）**: `lock_release_held` の `missing\|corrupt)` と同じく `<lock>` を消さず、自分の退避（`lock_release_own_gone`）と保有の記憶（`lock_forget_held`）だけ片付けて 0 を返す | owner の無い `<lock>` は自分のものと示せない（古い先頭の退かしの窓・put-back の途中・他者の K1）。消さずに残った空の `<lock>` は I3 の片付け・take-back-half が扱う。新版どうしでこの枝に後継の公開が当たる経路は人の手の削除しか見当たらないが、D12 の「missing は消さない」に揃えて理由の例外を無くす。**実装後 1 回目（codex P2-1／PM Claude P3-2）**: `corrupt`（解けない・0 バイトの owner）も `case` を抜けて token の空の比較から `rm -rf` に落ちていたので、`missing\|corrupt)` に揃えた（I4: 解けない owner を名前で消さない。0 バイトの古い owner は先頭の I4 の回収だけが扱う） |
| `setOwnerFields`（sync、merge-pr の `phase` の書き直し） | 記録の token を確かめてから tmp を名前の `owner` へ `renameSync`（上書き）。`writeFileSync`・`renameSync` に try が無い | **狭めた**: 引渡し（`handOff`）の後は `false` を返して書かない（記録の pid が自分でなくなった後の上書きをしない）。今の呼び手 merge-pr は引渡しを使わない。5 回目（PM Claude 4 回目 P3-3）: tmp の書き込みと `renameSync` の失敗（古い先頭の退かしの窓で `<lock>` が無い ENOENT など）は**例外を投げず `false`** を返し、自分の tmp（`.owner-<uuid>`）を消す（ENOENT は無視）。merge-pr は `false` を「欄を書けなかった」と読み、今どおり続ける | 引渡しの前は記録の pid が自分で、止まっている間は誰も回収しない（D12 と同じ理由）。退かしの窓で退避から戻った owner が書いた欄を古い記録で上書きすることはあるが、同じ持ち主の記録なので保有は変わらない（欄が消えるだけ） |
| 引渡し（D4）の公開（`lock_hand_off`・`handOff` の `mv`） | 記録の token が T0 と確かめてから tmp を名前の `owner` へ `mv`（上書き） | 変えない | 呼び手は生きた持ち主自身（記録の pid は自分）。D4 の失敗で消すのは自分の tmp だけ。D4 の後の戻しは D5（上の行）を通る |
| 退避の owner の put-back（bash `lock_move_owner_in`〔呼び手は `lock_recover` の戻しと `lock_restore_from_gone` の `created`・`exists`〕、sync・TS の `moveOwnerIn` と `recoverLock` の戻し） | `created` か `lock_ownerless_empty` が `yes` を確かめてから `rename(gone/owner, <lock>/owner)`（在れば上書き） | **替えた（5 回目、PM Claude 4 回目 P2-1）**: `link(gone/owner, <lock>/owner)`。EEXIST は戻さず退避を残し `<lock>` も `rmdir` しない（I2-c、F67） | 公開された owner を上書きしない。K1 から 10 分を超えて止まり再開した新版の書き手が空の `<lock>` の窓に入る形は前提 P0 の外（F69） |
| take-back-half（bash `lock_reclaim_gone` の `<take-back-half>` 1、sync・TS の同じ枝）の `<lock>` の `rmdir` | `lock_ownerless_empty` が `yes` を確かめてから `rmdir <lock>` | 変えない | `rmdir` は空のときだけ成功する（確かめと `rmdir` の間に誰かが公開すれば ENOTEMPTY で失敗し、退避を残して 1 を返す）。それ自体が確かめで、名前の指す先が替わっても空でない `<lock>` は消えない |
| 退避を自分の名前へ `rename` → token を確かめ → 自分の退避を `rm -rf`（bash `lock_reclaim_gone`、sync・TS の同じ処理） | 退かした先（`<lock>.gone-<自分の token>-<serial>`）の記録の token が判定した token のときだけ消す | 変えない | 確かめも削除も自分だけの名前（token と自分の通し番号）に対して行うので、確かめと削除の間に他者がその名前を替えることは無い（I2-b と同じ理由） |
| 退避の整理の `missing)` の枝（bash `lock_settle_gone` の `rmdir "$lsg_g"`、sync・TS の同じ枝） | owner の無い他者の退避の名前を `rmdir` | 変えない | `rmdir` は空のときだけ成功する。owner の無い退避に何かが残っていれば消さない（§9 の 2 行目: 散らかるだけ）。他者の退避の記録は消さない |

## 4. TZ に依らない比較の関数（PR1c が D7 経由で使う）

PM の決定（案 A）: PR1c は独自の tz の包み（記録の `tz=` と読み手の `${TZ-}` の比較）を持たず、この関数を呼ぶ。マージの順は **PR1a-f → PR1c**。PR1c の設計の S3・§2.1 の tz の包み・F8・F9・前提 P3 は、この節を参照して直す（PR1c の上流 3 回目で済み）。**名前と 3 値の契約（`machine_lock_pid_identity` → `alive`／`reused`／`unknown`）は 2 回目から変えない**（PM 決定 6。PR1c の upstream-4 がこれを前提にしている）。3 回目で変えたのは中の比べ方（15 分の倍数の推定をやめた）と、3 つ目の引数が空でもよいこと（空なら `lstart=` だけの記録の規則）だけ。4 回目は `unknown` の errno の欄に `ECLOCK`（観測の間の時計の後退・遅い観測）を足しただけで、名前・引数・3 値・終了コードは変えない。

**この関数は「消すか消さないか」の判定専用**（PM 決定 3）: `alive` は「再利用と示せなかった（同じ起動か、示す証拠が無い）」の意味で、ロックを**残す**側に倒した値。「同じプロセス」の証明ではないので、プロセスを**止める**判定（台帳の `proc_matches` など）には使わない（逆向きに倒れ、再利用された他人のプロセスを止めうる。codex 2 回目 P3・PM Claude 2 回目 P2-B）。

### 4.1 bash（`scripts/lib/machine-lock.sh`）

```sh
machine_lock_pid_identity <pid> <recorded-lstart> <started-at-ms>
# 標準出力に 1 行: alive | reused | unknown:<point>:<errno>   （<point> は lstart か etime）
# 終了コードは常に 0。呼び手は kill -0 の pid の観測が alive か EPERM のときだけ呼ぶ。
# <started-at-ms> は空でもよい（started_at= の無い・解けない記録）。
```

手順（この順）:

1. `now_before=$(lock_now_ms)`（**`ps` の前**）
2. `cur=$(LC_ALL=C ps -o lstart= -p <pid>)` を空白を詰めて読む。失敗・空なら `unknown:lstart:<errno>`（注入 `CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO>`）
3. `cur` が `<recorded-lstart>`（同じく詰めたもの）と同じなら `alive`
4. `<started-at-ms>` が空なら `unknown:lstart:EMISMATCH`（文字列は地方時で、違いが TZ か再利用かを示せない。消さない。PM 決定 2）
5. `et=$(ps -o etime= -p <pid>)` を `machine_lock_etime_ms` で解く。失敗・空・形が不正なら `unknown:etime:<errno>`（注入 `etime=<ERRNO>`、形の不正は `EINVAL`）。`machine_lock_etime_ms` は `^([0-9]+-)?([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}$` だけを受け（日の欄があるときは時の欄も要る）、時 < 24・分 < 60・秒 < 60 を確かめる。日の無い形で時の欄が 24 以上も不正
   - 続けて `now_after=$(lock_now_ms)`。`now_after < now_before`（観測の間に時計が戻った）か `now_after - now_before >= 1000`（観測が 1 秒以上で、間の後退を見分けられない）なら `unknown:etime:ECLOCK`（4 回目。`EMISMATCH` と同じく errno の欄に置く名前。注入 `etime=ECLOCK`、試験は `lock_now_ms` を差し替えて前後の値を与える。P1 の「観測の間」、F65）
6. `now_before - et > <started-at-ms> + LOCK_PID_REUSE_SLACK_MS` なら `reused`、そうでなければ `alive`（どちらもエポックの時刻で、TZ に依らない）

2 回目の手順 4・5（`machine_lock_lstart_naive_s` で地方時の付かない秒に直し、差が 900 の倍数かつ 26 時間以内なら TZ の違い）は消した。`machine_lock_lstart_naive_s` も足さない（BSD／GNU の `date` の違いを持ち込まない）。

読み込み口の包み（`lock_record_state` の D7）の写像: 元の判定 `alive`（`kill -0` の pid が alive）→ 関数の答えをそのまま（`reused` は G を見る）。元の判定 `unknown:pid:EPERM` → `reused` なら G を見る、それ以外は EPERM のまま。`<started-at-ms>` は記録の `started_at=` を `date -u -j -f '%Y-%m-%dT%H:%M:%SZ'`（BSD。GNU は `date -u -d`）で秒に直した ×1000。無い・解けなければ空で呼ぶ（2 回目の owner の mtime の代用はやめた）。

### 4.2 3 実装の対応と呼び手

| 実装 | 関数 | 呼び手（今もこれからも） | 備考 |
|---|---|---|---|
| bash | `machine_lock_pid_identity`（新）・`machine_lock_etime_ms`（新） | **D7 経由のロックの判定だけ**: 読み込み口の包み（`lock_record_state` の D7）を通る取得（supervisor.lock の `acquire-head-grace`）・退避の片付け（`lock_settle_gone`）・D6 のガード。PR1c もこの包みを通して使うだけ。**止める判定（`scripts/agent-health/product/lib.sh`・`deadline-guard.sh`・`supervisor.sh` の `proc_matches` など）からは呼ばない** | `verify-run.sh` の `lock_pid_start_ms` も `machine_lock_etime_ms` と同じ規則の解き方に替える（節の中に写しを置く: `verify-run.sh` は `machine-lock.sh` を読み込まない）。I3 の旧版の tmp の pid の再利用（F52）も同じ解き方 |
| sync | 足さない。`parseEtime` に範囲の検査を足す | 札の退かし（`ticketRetirable`）・I3 の旧版の tmp の pid の再利用 | `lstart=` の記録を読む JS の呼び手が無い（I6）。生まれたら、その PR で `pidIdentity(pid, recordedLstart, startedAtMs, hooks)` を同じ 3 値・同じ用途の制限で足す |
| ts | 足さない。`parseEtime` に範囲の検査を足す | 札の退かし（`retirable`） | 同上 |

止める判定に TZ に依らない本人確認が要るなら、それは別の作業（`same | other | unknown` の厳しい版、`unknown` は止めない。止めないときに回収と確定も飛ばすかを一緒に決める: PM Claude の PR1c 上流 3 回目の申し送り B の 1。PM が #4288 に記録）で、この関数の意味を広げない。雛形は「`lib.sh` の `proc_matches` の本体と `deadline-guard.sh`・`supervisor.sh` が `machine_lock_pid_identity` を呼ばない」を読みで固定する（今の版で緑。PR1c の後も緑のまま）。

## 5. (d) PR の切り方

- **1 本（PR1a-f）**。書くファイル:
  - `.claude/skills/cmate-verify/scripts/verify-run.sh`・`.agents/skills/cmate-verify/scripts/verify-run.sh`（バイト一致）の機械ロックの節: `lock_obs_create` の中身（tmp → 読み直し → `/bin/link` → 読み直し → tmp の削除。引数・標準入力・戻り値 0/3/6/10+i/40+i/70+i は変えない）、K の割込みの口 5 つ、F13 の `-ef`、F11 の `rmdir` をしない、新しい述語 `lock_ownerless_temps_only` と `lock_expire_ownerless` からの呼び出し（`lock_ownerless_empty` は変えない）、空の owner の回収（I4、固定 600000）、旧版の tmp の pid の再利用の確かめ（I3、etime と tmp の mtime。F52・F53）、I2-b の `[ ! -L … ] && [ … -ef … ]`、I1 の bash の読み直しの比べ方、取得と D6 の文面（`corrupt`・`stray`・`old-taker`・`taking`）、`lock_obs_owner` が codec の `LPO_STARTED_AT` を `LOB_STARTED_AT` に写す（読みごとに空）、`lock_pid_start_ms` の解き方、`lock_hand_off` の `lstart=` の拒否、`lock_recover` の `:1486` のコメント（「owner が無い退避は、持ち主の tmp が退かした先にあり、持ち主の `link` は ENOENT で断る」に直す）。4 回目: `lock_acquire_path` の冒頭の `LOCK_OWNER_PID` の検査（I1-b、F56）、戻しの rename の形（I2-b、F57〜F61）、`lock_release_as_head` の削除を `lock_recover` に（F62）、`lock_format_owner` の `v=1`／`"v":1`（I9）と `machine-lock-legacy-writer`（F66）、I3・札の `now` の前後の取り方（F37・F53）。5 回目: `lock_move_owner_in` の put-back を `/bin/link` に（I2-c、F67。EEXIST は `<lock>` を `rmdir` しない）、`lock_release` の `missing)` の枝は `<lock>` を消さない（§3.1）。5 回目の追加: `lock_acquire_path` の冒頭と `lock_hand_off` の `LOCK_OWNER_EXTRA` の予約の鍵の検査（I1-c、F68。`lstart=` は 1 行だけ許す）
  - `scripts/lib/machine-lock.sh`: kv の codec が `started_at=` を読む、§4 の 2 関数（`machine_lock_pid_identity`・`machine_lock_etime_ms`）、D7 の包みを I5 に替える（`machine_lock_lstart_state` は残す）。kv の codec の書式に `v=1` の行（I9）、`machine_lock_pid_identity` の `now_before`／`now_after`（F65）
  - `scripts/orchestrate/machine-lock-sync.mjs`: `makeObserver().create` の中身（`wx` の tmp → 全量の書き込み → `closeSync` → `linkSync` → 読み直し → tmp の削除。戻り値の形は同じ）、`hooks.onOwnerStage`、新しい述語 `ownerlessTempsOnly` と `expireOwnerless` からの呼び出し、空の owner の回収、文面、`parseEtime` の範囲。4 回目: `ownerPid` の検査（I1-b、F56）、戻しの rename の形（F57〜F61）、`releaseAsHead` の削除を `recoverLock` に（F62）、`setOwnerFields` は引渡しの後に書かない（§3.1）、`create` と `handOff` の `v`（I9）と `machine-lock-legacy-writer`（F66）、札の `processStartMs` の `now` の前後。5 回目: `moveOwnerIn` と `recoverLock` の戻しを `linkSync` に（I2-c、F67）、`setOwnerFields` は書き込み・`renameSync` の失敗で `false`（§3.1）。5 回目の追加: `ownerFields` の予約の鍵を断り（F68）、記録を「節の予約の欄が後」に組む、`setOwnerFields` も予約の鍵で `false`（I1-c）
  - `src/lib/verification/machine-lock.ts`: `create` の中身（同上）、`__testHooks.onOwnerStage`、空の owner の回収、文面、`parseEtime` の範囲（I3 は足さない）。4 回目: 戻しの rename の形（F57〜F61）、`create` の `v`（I9）と `machine-lock-legacy-writer`（F66）、札の起動の時刻の `now` の前後。5 回目: `moveOwnerIn` と `recoverLock` の戻しを `linkSync` に（I2-c、F67）
  - `.claude/skills/sync-map.json`: `verify-run.sh` の pin を再計算し、rationale に PR1a-f を足す（PR1a と同じ書き方、親 §1.11）
  - `docs/design/verify-lock-holder-group-4288.md` §2.8: 点 `owner-write-short`・`owner-close`・`owner-publish`・`ownerless-tmp-lstat`・`ownerless-tmp-unlink`・`owner-tmp-pid`・`empty-owner-move`・`owner-pid`・`owner-undo-rename`・`owner-undo-link`（4 回目）を足し（5 回目: put-back の点 `restore-rename` は名前を保ち、説明を「`link` 退避/owner → `<lock>`/owner（戻し）。EEXIST は退避を残し `<lock>` を `rmdir` しない」に直す。I2-c）（2 回目の `owner-mtime` は owner の mtime の代用をやめたので足さない）、`owner-create` の説明を「tmp の排他作成」に直す。読み込み口の点 `etime` は `lstart` と同じく注記と注入の試験で固定する
  - 試験: この雛形を実装で埋める。下の「意図した変更」の既存の試験
- **PR1b・PR1c への申し送り（猶予の値）**: 本番の猶予つきの呼び手（PR1b の run-lock、PR1c の supervisor.lock と D6 のガード）は `ownerlessGraceMs`／`LOCK_OWNERLESS_GRACE_MS` に **600000** を渡す（I3、PM 決定 1）。親 §1.6 の D3・`lock-reservation-rest-4288.md:157` の「60000」はこの値に読み替える（親の文の直しは PR1b・PR1c の実装の契約で。この PR の scope の外）。節の既定（未設定＝片付けない）と、PR1a の試験が渡す 60000 は変えない
- **PR1b・PR1c への申し送り（4 回目）**: (1) 最初の取得の `ownerPid`／`LOCK_OWNER_PID` は自分の pid だけ（I1-b）。PR1b の `acquireRunLock` の `pid` オプション（`run-lock.ts:150`。今の本番の呼び手 `scripts/agent-health/main.ts:226` は渡さない）は、自分でない値なら取得を始めずに断るか、`handOff` へ回す形にする。UAT の `up` のサーバーへの引渡しは今どおり D4（`run_lock_set_pid`）。(2) 記録に `v=1` の行が足される（I9）ので、記録の形・字面で比べる試験は `v=1` を含めて読む。PR1b・PR1c の設計の直しはリーダーが別に指示する
- **呼び手の欄の口の申し送り（5 回目の追加、I1-c）**: TS（`machine-lock.ts`）や PR1b の `run-lock.ts` に呼び手の欄の口（`ownerFields` 相当）を足すときは、同じ予約の鍵（`pid`・`host`・`token`・`acquiredAt`・`started_at`・`pgid`・`v`・`lstart`・`done`）を拒む。PR1c の supervisor の `LOCK_OWNER_EXTRA` は `lstart=`・`label=`・`run_dir=` だけにする（`pgid=` は拒まれる。グループは D4 の引渡しで書く）
- **skills の port の追跡**: `verify-run.sh` の変更は skills 側（cmate-verify）へ移植する PR を**作るところまで**（公開は伺う）。それまで skills の写しは E1 の窓を持つので、空の owner は生まれ続ける（I4 の回収は恒常の規則）。pin の rationale に「移植は別 PR、それまで byte-identical でない」と書く
- **文面の持ち主**: `machine-lock-owner-corrupt`・`machine-lock-ownerless-stray`・`machine-lock-ownerless-old-taker`・`machine-lock-empty-owner-removed` の文面は PR1a-f が節の中で出す。PR1c の上流の設計が lib.sh で出すとしていた `corrupt`・`ownerless-tmp` の文面は、PR1a-f の後は節の文面を伝えるだけにする（二重にしない）
- **API は呼び手と同じ PR**: 新しい公開の API は作らない（`machine_lock_pid_identity` の呼び手は同じ PR の D7 の包み）。オプション（`ownerlessGraceMs`／`LOCK_OWNERLESS_GRACE_MS`）の意味を I3 に広げるのは PR1a で入れたオプションの意味の拡張で、新しい API ではない（今それを渡すのは試験だけ。本番の呼び手は PR1b・PR1c）。空の owner の回収はオプションではなく既定の規則（I4）
- **PR1b・PR1c との関係**: ファイルは重ならない（PR1b は `run-lock.ts`・`run-lock.sh`・`run-server.sh`・`daily.sh`、PR1c は `lib.sh`・`deadline-guard.sh`）が、D7（§4）・K の口（§2.6）・文面は PR1a-f が持ち、PR1b・PR1c は使うだけ。**マージは PR1a-f を先**にし、PR1b・PR1c の表はその後の振る舞いを期待にする
- 難易度: **opus**（PM 決定の「次」: 混在の扱い〔I8・表 F の `limit` の行〕と I5 の時刻の扱い、3 実装の一致があるので sonnet にしない）。PR1c の実装はこの PR の実装の上に積む（sonnet）

### 5.1 意図した変更（既存の試験）

期待を消す側に変えるものは無い。次の 4 か所は**変異の口か残るものの名前**が変わり、4 回目の 3 か所（表の下の 3 行）は**記録の置き方**が変わる（実装の契約で直し、試験のコメントにこの節を書く）:

| 場所 | 今 | 変更 | 理由 |
|---|---|---|---|
| `tests/unit/verification/machine-lock-options-4288.test.ts:272-285`（陽性の対照） | `set -C` を外す・`'wx'` を `'w'` にする変異で「在る owner を上書きする」 | 変異を「公開の `/bin/link`／`linkSync` を `mv -f`／`renameSync` にする」に替える。期待（上書きして取ったと言う）は同じ | 排他は tmp の作成でなく公開の `link` が担う（I2） |
| `tests/unit/verification/lock-pr1a-review-fixes-4288.test.ts:206-219`（TS の陽性の対照） | `openSync(file, 'wx')` → `'w'` | 同上（`linkSync` → `renameSync`） | 同上 |
| `tests/unit/verification/machine-lock-options-4288.test.ts:293-295`（bash の `owner-unlink` の注入） | 戻しの削除に失敗すると `<lock>/owner` が残る | `<lock>/.owner-<token>` が残り、`<lock>/owner` は無い | 書きかけは tmp にしか無い（I1） |
| `tests/unit/verification/machine-lock-options-4288.test.ts:308-309`（同期 JS の同じ注入） | 同上 | 同上 | 同上 |
| `tests/unit/verification/machine-lock-options-4288.test.ts:148`・`:174`・`:485`（他者の pid の記録を最初の取得の `ownerPid`／`LOCK_OWNER_PID` で作る） | 最初の取得で生きた他者の pid を記録する | 記録は、その pid のプロセス自身に取らせる（`bash -c` の取得を待たせる子）か、試験が owner を直に置く（旧い写し・手で置いた記録の形）。期待（生きた持ち主で断る・needs-head）は同じ。最初の取得に他者の pid を渡す行は**新しい行**（F56: 断る）にする | I1-b（4 回目） |
| `tests/unit/verification/lock-release-invariant-4288.test.ts:104`・`:150`（`syncRace`／bash の競合。`ownerPid`／`LOCK_OWNER_PID` に死んだ pid） | 最初の取得で死んだ pid を記録して解放の競合を作る | 試験が `token: 'T0'` の記録を直に置き（pid は死んだ pid）、解放の競合だけを駆動する。期待（後継を消さない）は同じ | 同上（5 回目に PM Claude 4 回目 P3-2 と突き合わせた: 4 回目の版にもこの行と下の行はあり、`:190`・`:206` は下の行の `:187-206` に含まれる。名指しを足した） |
| `tests/unit/verification/lock-release-invariant-4288.test.ts:187-206`（`:190` の同期 JS `ownerPid: g, pgid: g`、`:206` の bash `LOCK_OWNER_PID=${g}`。生きたグループの pid で deferred を見る）・`:235-281`（20 行の表の「初期取得 × 非自己」の 9 行 × bash・同期 JS、`ownerPid: p`・`LOCK_OWNER_PID=${p}`） | 最初の取得で非自己の pid（alive・dead・unknown）を記録してから解放を見る | その 9 行と `:190`・`:206` は「記録を試験が直に置く」（`token: 'T0'`・pid・`pgid` を書いた owner。`pgid` のある記録は D12 の deferred の形）か「自分で取った後に `handOff(p, g)` する」（D4 の経路。`pgid` 必須）に替え、解放の期待（`needs-head`・`deferred`）は同じ。20 行の数と D12 の表は変えない。最初の取得に非自己の pid を渡すと断ることは F56 の行で固定する | 同上 |

5 回目の追加（I1-c）の意図した変更: 最初の取得で `LOCK_OWNER_EXTRA` に `pgid=` を渡して `pgid` のある記録を作る既存の試験は断られる。`tests/unit/verification/lock-release-invariant-4288.test.ts:206`・`:281`（上の 2 行に含まれる）に加え、**自分の pid の** `pgid=$$` を渡す `:331`・`:338`・`:471`・`:478` も対象。期待（解放の deferred・needs-head・released、観測の故障の倒れ方）は同じで、記録の置き方を「試験が `pgid` のある owner を直に置く（`token` は `LOCK_TOKEN` と同じ）」か「取った後に `lock_hand_off "$$" <g>` する（D4、新しい token）」に替える。同期 JS で `ownerFields` に予約の鍵を渡す既存の試験は無い（`git grep -n ownerFields tests` は 0 件。merge-pr の `phase`・`repo`・`base` は予約でない）。

5 回目に足した意図した変更（期待を消す側に変えない）: `tests/unit/verification/lock-observation-points-4288.ts:36` の `restore-rename` の `observes` の文（`rename` → `link`）と、同じファイルの `:138`・`:140`（`moveOwnerIn`・`recoverLock` の原始操作の表。`link` を観測の口 `obs` に足せば直の原始操作は増えない。直に `linkSync` を呼ぶなら行を足す）。`lock-observation-points-4288.test.ts:380` の注入（EIO）の期待（`<lock>` が無く退避が残る）は I2-c の (4) で同じ。`lock_release` の `missing)` の枝は、`tests/unit/verification/machine-lock-options-4288.test.ts:693-697`（`positive control: verify-run.sh's lock_release on a missing owner removes the other taker's <lock>`。`rm -f "$LK/owner"` の後の `lock_release` で `<lock>` が消えることを期待）が今の振る舞いを固定している。これは D12 の「`lock_release_held` は missing を消さない」の陽性の対照（`lock_release` との違いを示す）なので、5 回目の狭めで**期待が反転する唯一の既存の試験**（消す側から消さない側へ。期待を消す側に変えるものではない）。実装の契約で、`it` の名前は変えずに期待を「`<lock>` が残る」に替え、試験のコメントにこの節を書くか、名前の変更をその契約の決定で許す（PM へ: §8 の 5）。`git grep -n 'lock_release "' tests` の他の 3 か所（`lock-4288-harness.ts:31`・`machine-lock-gone-4288.test.ts:141`・`machine-lock-invariants-4277.test.ts:55`）は自分の owner がある `<lock>` を解放するので変わらない。

既存の D3 の試験（`machine-lock-options-4288.test.ts:246-247`、owner がディレクトリ・ディレクトリへの symlink）は変えない。ただし「ディレクトリ」の行は `isDirectory()` しか見ないので、実装の契約で「ディレクトリの中が空のまま」の検査を**新しい行**（表 F の F8）として足す（既存の期待は変えない）。

固定している注入の点の名前（`owner-create`・`owner-write`・`owner-readback`・`owner-unlink`・`lock-rmdir`）と、`owner-create` の注入の対象（`<lock>/owner`。`lock-pr1a-review-fixes-4288.test.ts:186-198` が注入で後継の owner を置く）は変えない: `owner-create` の注入は tmp を開く前に `<lock>/owner` を対象に走らせ、後継が置かれれば公開の `link` が EEXIST になって取らない（期待どおり）。D7 の既存の試験（`machine-lock-options-4288.test.ts:560-596`）は、記録を `kvRecord`（`:80-81`。**必ず `started_at=2026-11-10T00:00:00Z` を書く**）で置き、生きた `sleep` はその後に起動するので、「違う lstart（`Thu Jan  1 00:00:00 1970`）→ removed」の行は I5 の (1)（etime の起動が `started_at` ＋ 2 秒より後）で `reused` になりそのまま通る（3 回目に確かめた）。`started_at=` の無い記録を置く既存の試験は無い（`git grep -l 'lstart=' tests/unit tests/integration` は 4 ファイル。`product-supervisor-3312.test.ts` は旧い `lib.sh` の読み手を駆動し、PR1a-f の読み込み口を通らない。`process-inspector.test.ts` はロックの外）。

## 6. 新旧の混在

| 書き手（旧） | 新しい読み手が見る形 | 新しい読み手の動き | 判定 |
|---|---|---|---|
| PR1a 版の `lock_obs_create`（`: >` → `cat >>`）が書いている途中 | 0 バイトの owner（若い） | 10 分以内は `taking` で待つ。書き手の札は期限＋60 秒で外れる（E12）が、空の owner は 10 分を過ぎるまで回収しない。10 分を超えて止まった書き手が回収の後に再開すると後継の owner を壊しうる | ○（10 分以内）。10 分を超える停止は F50（`limit`・`mixed`） |
| PR1a 版・PR1a より前の写し（`printf > owner`、`cfffb31c9:1416`）が SIGKILL で残した 0 バイトの owner | 古い `empty-owner` | 先頭が退かして 0 バイトのままを確かめて回収（I4）。猶予の無い呼び手（ゲート）も回収する | ○（書き手が死んでいれば）。開いたまま 10 分を超えて止まった書き手の再開は F51（`limit`・`mixed`） |
| 新しい `link` と旧い `set -C` の取り合い | どちらも名前 `owner` の排他（EEXIST）で、上書きしない | ○ | ○ |
| 旧い読み手（PR1a 版・#4277 版）が新しい K2・K3 の `.owner-<token>` だけの `<lock>` を見る | 空でない、owner 無し | 旧い読み手は待つだけ（今の `empty-dir` と同じく取らない） | ○ |
| 旧い `lib.sh`・`run-lock.sh`（札なし、`owner.tmp.$$` → `mv -f`、失敗で `rm -rf "$dir"`） | `tmp-old` | 名前の pid が書き手でないと示せたとき（gone、または起動が tmp の mtime ＋ 2 秒より後: F52）だけ回収（I3）。書き手が猶予を超えて止まっていても生きていれば回収しない（`old-taker`）ので、再開した書き手の `rm -rf "$dir"` が後継の `<lock>` を消す経路は生まれない（codex 1 回目 P1） | ○。壁時計の後退と重なると F55（`limit`・`mixed`） |
| 同上（旧版の K1: `mkdir` の後・tmp の前。pid がどこにも無い） | `empty-dir` | 猶予（本番 10 分）の後に回収（D3）。10 分を超えて止まった書き手が再開すると、後継の `<lock>` に tmp を書き `mv -f` で後継の owner を置き換える | ○（10 分以内）。10 分を超える停止は F49（`limit`・`mixed`。codex 2 回目 P1） |
| 旧い `lib.sh` の読み手（`find -mmin +1` で owner の無い `<lock>` を中身ごと取る） | 新しい取得者の K1〜K3 で 1 分を超えて止まった `<lock>` | 旧い読み手が取ると、新しい取得者の `link` は ENOENT（F11）で断り、何も消さない | ○（親 §1.9 の範囲） |
| 旧い `lib.sh` の退避 `<lock>.stale.*` | 読まない | 結果を変えない | ○ |
| 旧い読み手が新しい戻しの途中（F57: owner 無し・`.undo-<token>` あり）の `<lock>` を見る（4 回目） | 空でない、owner 無し | PR1a 版・#4277 版の読み手は待つだけ。旧い `lib.sh` の読み手は 1 分を超えると中身ごと取りうる（上の `find -mmin +1` の行と同じ） | 親 §1.9 の範囲（`v=` の無い読み手。§6.1 の (a) で終わる） |
| 旧い読み手が `v=1` の記録を読む（4 回目） | 知らない鍵 | kv・JSON の読みは知らない鍵を読み飛ばす（`lock_parse_owner_text`、`lock_json_field`、旧い `lib.sh` の `sed -n 's/^pid=//p'`、`run-lock.ts` の `parseOwner`） | ○（実装の契約で 3 実装と旧い読み手の対照を 1 行ずつ） |
| 旧い supervisor.lock の記録（`pid lstart label token`、`host=`・`started_at=` 無し） | `lstart-legacy*` | 文字列が同じなら alive、違えば unknown（消さない。TZ か再利用かを示せない。I5 の (2)）。pid が死ねば回収 | ○（消さない側。再利用された pid の間は止まる: F38） |
| PR1a 版の `machine-lock.sh` を読む旧いチェックアウト（同期の前のガード） | 新しい記録 | `lstart=` の文字列だけで判定するので TZ の穴は旧いチェックアウトの同期まで残る | 範囲の文（§8 の 3） |
| cmate-verify 0.7.0 より前の写し（札を知らない） | — | 札を無視して `mkdir` する。P0-t の外（親 §1.9） | 範囲の文 |

### 6.1 混在を終わらせる条件（I8 の (b) が消える条件。PM 決定 1）

混在の間の限界（F49・F50・F51・F55）は、旧い形の書き手が動きうる写しが残る間だけある。次の 3 つが揃うと、動く書き手は全て新しい形になり、限界の行は消える（行は「終わった後は到達しない」として表に残し、消したことを試験で確かめるのは各条件の PR）。

1. **旧版の run-lock・supervisor.lock の書き手が無くなる**: PR1b（`run-lock.sh`・`run-lock.ts` を machine-lock に載せる）と PR1c（`lib.sh` の supervisor.lock を machine-lock に載せる）が develop にマージされる（F49・F55）
2. **skills の cmate-verify の写しが新しい形になる**: `verify-run.sh` の skills 側への移植の PR（§5。作るところまで。**公開は人に伺う**）が公開され、sync-map.json の pin が byte-identical に戻る（F50・F51）
3. **古い worktree の写しを更新する**: PR1a-f・PR1b・PR1c のマージより前に分岐した worktree（`git worktree list` で見る。常駐の `../commandmate-agent-health`〔`agent-health-runner`。supervisor.lock を使う日次の Schedule〕と `../commandmate-main` を含む）の `verify-run.sh`・`lib.sh`・`run-lock.sh` を、develop（常駐は main のリリース）に合わせる。常駐の worktree は片付けず、ブランチを進めて更新する（CLAUDE.md の恒久 worktree）。PR1c の切替の手順に入れる（§8 の 3）

3 つが揃うまでの窓は「旧い書き手が `mkdir`〜`mv`（通常ミリ秒）の途中で 10 分を超えて止まり、ちょうどその間に新しい先頭が回収して取る」ときだけ開く。

**混在の終わりの宣言は前提 P0 に依らない**（5 回目の追加、PM 決定 2・追記 4）: 前提 P0 の下では混在の間も保証が成り立つ（冒頭の「前提 P0」）。混在の終わりは「前提の外で起きうることのうち、旧い書き手の分（`mixed` の行）が無くなる」時点で、それを**配備のあとの再起動**で決める。下の (a) の `ps` の絞り込みと (b) の 7 日の観測は補助の**最善の手順**で、汎用のシェル・node に読み込まれて書く前に止まった旧い書き手（F71）は両方から落ちうる。

**ファイルの更新だけでは混在は終わらない**（4 回目、codex 3 回目 P2）: 旧い関数を読み込み済みのシェル（`supervisor.sh:52` のように `lib.sh` を `.` で読む常駐）・旧い `machine-lock-sync.mjs` を import 済みの node・旧いビルドの CommandMate サーバー（TS の `machine-lock.ts`）は、ファイルが替わった後も旧いコードを実行する。止まっている（`SIGSTOP`・`stat` が `T`）旧い書き手も同じ。そこで混在の終わりを、上の 1〜3 が揃った時刻 `T_UPDATE` の後の **(c) 配備のあとの再起動**で決め、(a)(b) を補助の観測として添える。(c) が済み、(a)(b) に取りこぼしの兆し（旧い起動・`v=` の無い記録）が無い時点で `mixed` の行（F49〜F51・F55・F58・F71）は終わる。

- **(c) 配備のあとの再起動（終わりの条件。5 回目の追加）**: `T_UPDATE` の後に、旧い写しを読み込みうるプロセスを**一度すべて起動し直す**: tmux の中のエージェントのセッション（その子のシェルを含む）、agent-health の日次（`daily.sh`）と supervisor・常駐のシェル（`../commandmate-agent-health` の Schedule）、旧いビルドの CommandMate サーバー（再ビルド・再起動は人に伺う）、手で開いた対話シェル。起動し直した時刻 `T_RESTART` を記録に残す。`T_RESTART` より前に起動したプロセスが残っていないことを、`ps -axo pid=,etime=` で**名前で絞らずに**数えて確かめる（絞り込みは (a) の補助）

- **(a) 旧い写しを実行中のプロセスが無い（補助の最善の手順）**: `T_UPDATE` より前に起動したプロセスで、ロックの書き手のコードを実行しうるものが 1 つも無い（止まっているものを含む）。手順（読むだけ。止める・消すのは人が判断する）:
  ```sh
  T_UPDATE=<1〜3 が揃った時刻のエポック秒>
  now=$(date +%s)
  ps -axo pid=,stat=,etime=,command= |
    grep -E 'verify-run\.sh|run-lock\.sh|run-server\.sh|agent-health/product/(supervisor|deadline-guard|daily|lib)\.sh|scripts/agent-health/(daily\.sh|main\.ts)|merge-pr\.mjs|precheck\.mjs|commandmate|next-server|dist/server' |
    grep -v grep
  # 各行の etime を machine_lock_etime_ms（§4.1）で秒に直し、now - etime < T_UPDATE の行（T_UPDATE より前の起動）を数える
  ```
  1 行でもあれば (a) は成り立たない（その行の pid・stat・command を記録に残す）。CommandMate サーバー（本番）は PR1a-f の後の再ビルド・再起動で替わる（再ビルド・再起動は人に伺う）。tmux の中のエージェントが起動したシェルの子も `ps -ax` に出るので同じ手順で数える
- **(b) 7 日間、`v=` の無い記録を観測しない（補助の最善の手順）**: `T_UPDATE` の後、連続 7 日（日次の Schedule と週の作業を一巡する長さ）のあいだ、新版の読み手が出す `machine-lock-legacy-writer`（I9、F66。`v=` の無い記録と旧版の `owner.tmp.<pid>`）が 1 行も無い。見る場所: agent-health の日次の記録（supervisor・`daily.sh` の stderr）、merge-pr・precheck・`verify-run.sh` の stderr を残す run の記録。1 行でもあれば、その `pid` のプロセスを (a) の手順で確かめ、7 日を数え直す

(c) が済む前に `limit`（`mixed`）の行を「終わった」と書かない（(a)(b) だけでは宣言しない。汎用のシェルで止まった旧書き手 F71 を拾えない）。揃った後も表の行は「終わった後は到達しない」として残す（試験は (a)(b) を見ない。観測は人の手順）。(a) は `v=` を書かない旧い書き手を、(b) は (a) の取りこぼし（`T_UPDATE` の時刻の誤り、`ps` の grep の形に合わない起動の仕方）を捕まえる。`v=` の無い書き手が書く前に止まっている形（F49 の旧版の K1・F51 の書く前の停止）は記録を残さないので (b) では見えず、(a) が受け持つ。

## 7. 処分（pm-return-4288-pr1af-upstream）の対応

| 処分 | 入れた場所 |
|---|---|
| 1 旧版の再開で生きた後継のロックを消す（codex P1） | I3（`owner.tmp.<pid>` は pid が gone のときだけ）、表 T `tmp-old`・`tmp-old-young`、F26〜F28、§6 |
| 2 I4 の前提の誤り（PM Claude P2-6） | P0、I4（空の owner は 60 秒を過ぎ先頭として退かして確かめて回収。3 回目で 10 分に）、表 T `empty-owner`、F29〜F31、§5 の sync-map.json と skills の port |
| 3 I3 は別の述語（PM Claude P2-2・codex P2） | I3 の `lock_ownerless_temps_only`／`ownerlessTempsOnly`、表 T `tmp-new+gone-dead`・`tmp-new+gone-alive` |
| 4 bash の公開は link(2) の意味（PM Claude P2-1） | I2（`/bin/link --`、errno の読み）、I2-b（`-ef`）、E11、F7〜F11・F13・F14 |
| 5 etime のパーサー（codex P2）ほか | I5、§4.1 の `machine_lock_etime_ms`、F35〜F37、F38〜F40、F45 |
| 6 F24 の例外 | I5 の (1) を TZ の違いを同じ起動と読む比較にし、F42 を keep に。I7 と型（`residual` を持たない）。**3 回目で置き換えた**（§7.1 の 2: 15 分の倍数の推定をやめ、F42 は `limit`・`premise`） |
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

### 7.1 上流 2 回目の処分（pm-return-4288-pr1af-upstream2）の対応

| 決定 | 入れた場所 |
|---|---|
| 1 不変条件を「新版どうし」と「混在の間」に分ける（codex P1・PM Claude P2-A） | I8（新設）、P0（札は期限＋60 秒で外れる事実に直した）、E12、I3（`.owner-*` の理由を札でなく公開の形に）、I4・I3 の猶予を 10 分（`LOCK_EMPTY_OWNER_GRACE_MS`=600000、本番の呼び手の `LOCK_OWNERLESS_GRACE_MS`=600000、§5 の PR1b・PR1c への申し送り）、表 F の F49〜F51・F55（`limit`・`mixed`）、§6 の行、§6.1（混在を終わらせる条件: PR1b・PR1c のマージ、skills の port の公開〔伺う〕、古い worktree の写しの更新） |
| 2 TZ（codex P2） | I5（`started_at` があれば etime の起動の時刻と比べる、`lstart=` だけは一致で alive・不一致で unknown、reused は `started_at`／etime の証拠があるときだけ）、§4.1 の手順（2 回目の 4・5 と `machine_lock_lstart_naive_s` を消した）、表 T の `lstart-legacy*`、F34（60 秒差・`started_at` 無し → unknown）・F54（60 秒差・`started_at` あり → etime で alive）・F38〜F40、P1 と F42（壁時計の後退。`limit`・`premise`。PM Claude 申し送り B の 2） |
| 3 §4 は「消すか消さないか」の判定専用（codex P3・PM Claude P2-B） | §4 の冒頭、§4.2 の呼び手の欄（D7 経由のロックの判定だけ、止める判定からは呼ばない）、I5 の「用途」、§9 の 1 行目（`proc_matches` の置き換えの提案を削った）、雛形の `PID_IDENTITY.use`・`never` と読みの試験 |
| 4 表 F を Caller × Impl に展開（codex P2） | §3（呼び手は `AG`・`AN`・`GH`・`GB`・`TR`・`HO`、結果の型は呼び手ごと、D6 は `kept` を持つ、D6 の故障の行 F47・F48）、雛形の `FailureRow.results`・`F_CASES`（実装 × 呼び手ごとに 1 本の `it.todo`。2 回目の `impls` を並べた 1 行の todo をやめた） |
| 5 PM Claude P3 | P3-1 旧版の tmp の pid の再利用: I3（etime の起動が tmp の mtime ＋ 2 秒より後なら書き手でない）、F52・F53・F55。P3-2 F3 の理由: F3。P3-3 I2-b は `lstat(tmp)`: I2-b。P3-4 bash の `-ef` に `! -L`: I2-b。P3-5 短い書き込みの末尾の改行: I1。P3-6 PR1c の順: §4 の冒頭（PR1c の上流 3 回目で済み）。P3-7 `TS_K` の型: `byGraced: By \| 'no-grace-caller'` は `KillRow` の型にあり、`npx tsc --noEmit` で確かめた |
| 6 §4 の名前と 3 値は変えない | §4 の冒頭。変えたのは中の比べ方と、3 つ目の引数が空でもよいことだけ |

### 7.2 上流 3 回目の処分（pm-return-4288-pr1af-upstream3）の対応

| 処分 | 入れた場所 |
|---|---|
| 1 確認と名前の削除の間で後継を消す（codex 3 回目 P2） | I1-b（最初の取得は自分の pid だけ。F56）、I2-b（`rename` で `.undo-<token>` へ → inode → 消す／`link` で戻す、EEXIST は戻さず文面）、表 F の F13・F14 の文と F57〜F61（確認の直後の割込み F57、codex の順序 F61、戻しの EEXIST F58 は `limit`・`mixed`）、§3.1（残った経路の列挙。D5 の `rm -rf` を `lock_recover` に替えた F62、`setOwnerFields` を引渡しの後は書かないに狭めた）、§5.1（最初の取得に他者の pid を渡す既存の試験の置き方）、§5 の PR1b への申し送り |
| 2 時刻を読む途中の時計の後退（codex 3 回目 P2） | P1 の「観測の間」と「寄せられない形」、I5 の時刻、§4.1 の 5・6（`now_before`／`now_after`、`unknown:etime:ECLOCK`）、F65、F42 の文（GNU の `etime` の進み）、F37・F53（札・旧版の tmp の pid にも同じ取り方） |
| 3 ファイルの更新だけでは混在は終わらない（codex 3 回目 P2） | I9（`v=1`、`machine-lock-legacy-writer`）、F66、§6.1 の (a)（`ps` の手順）・(b)（7 日間）、I7・I8 (b)・F49〜F51・F55・F58（`v=` の無い書き手にだけ当たる）、雛形の `Limit.writer`、§5 の PR1c への影響の 1 行（I9） |
| 4 P3（D6 の `absent`／`restore-failed`。codex 3 回目 P3） | F63・F64、§2.2 |
| §4 の契約は変えない | §4 の冒頭（名前・引数・3 値・終了コードは同じ。`unknown` の errno の欄に `ECLOCK` を足しただけ） |

### 7.3 上流 4 回目の処分（pm-return-4288-pr1af-upstream4、PM Claude の一点見）の対応

codex の 4 回目の結果は来たら別の契約で追記する。§4 の契約は変えない。

| 処分 | 入れた場所 |
|---|---|
| 1 退避の owner の put-back が「確かめてから名前へ rename（上書き）」（P2-1） | I2-c（`link` で戻す、EEXIST は退避を残し `<lock>` を `rmdir` しない、点は `restore-rename` の名前を保つ）、表 F の F67（3 実装・`AG`・`AN`・`GH`、割込みの口は `pause:restore-mkdir` の後）、§3.1 の put-back の行、§2.2・§2.5 の数（67 行・310 件・到達する 271 件・合計 628）、§5 の 3 実装の 5 回目、§5.1（`lock-observation-points-4288.ts` の説明）、I8 (a) の例外と §8 の 4（`link` でも塞げない形） |
| 2 bash `lock_release` の `missing)` の枝（P3-1） | §3.1 の行（狭めた: `<lock>` を消さず自分の退避と保有の記憶だけ片付ける）、§5 の bash、§5.1（反転する既存の陽性の対照 `machine-lock-options-4288.test.ts:693-697`、§8 の 5） |
| 3 `lock-release-invariant-4288.test.ts` :104・:150・:190・:206（P3-2） | §5.1 の 2 行（4 回目の版にも `:104`・`:150` の行と `:187-206` の行はあった。`:190`・`:206` を名指しし、置き方に `handOff` を足した） |
| 4 `setOwnerFields` の `renameSync` に try が無い（P3-3） | §3.1 の `setOwnerFields` の行（書き込み・`renameSync` の失敗は `false`、自分の tmp を消す）、§5 の同期 JS |
| 5 take-back-half・自分の名前・退避の整理の `rmdir`・札の理由（P3-4・P3-5） | §3.1 の冒頭（札の置き換えは列の順だけでロックの owner を消さない）と 3 行（take-back-half の `rmdir`、自分の名前への `rename` と `rm -rf`、退避の整理の `rmdir`） |

### 7.4 停止の前提（pm-decision-4288-pr1af-lease-premise、再指示 reinstruct-4288-pr1af-lease-premise）の対応

| 決定 | 入れた場所 |
|---|---|
| 1 保証を前提 P0 の下で書き、混在の限界を P0 の特別な場合にまとめる | 冒頭の「前提 P0」の節（P0・P1・理由・保証・混在の限界・前提の外の扱い）、§1 の P0 は P0-t（札の内訳）に改名、I8 (a) の 5 回目の文、§3 の `limit` の 9 行の文、雛形の `Limit.outside` |
| 2 codex 4 回目の P2 のうち前提の外の 3 件 | F69（戻し・put-back の EEXIST に新版 C の K1 の 10 分超の停止。`premise`・P0）、F70（壁時計の後退と読み手の停止の相殺。`premise`・P1）、F71（汎用シェルで止まった旧書き手。`mixed`・P0、終わりは §6.1 の (c) 配備のあとの再起動、`ps` は補助）。§8 の 4 は閉じた |
| 3 予約の欄を拒む（前提に依らない） | I1-c（同期 JS の `ownerFields`・`setOwnerFields`、bash の `LOCK_OWNER_EXTRA`、TS は口が無い）、F68、§5 の 3 実装と申し送り、§5.1（`LOCK_OWNER_EXTRA=pgid=…` の既存の試験 6 か所）、雛形の `RESERVED_FIELDS` と対照。`lstart` は bash の kv で D7 の唯一の口なので 1 行だけ許した（PM の列挙からの逸脱。理由は I1-c） |
| 4 put-back の `link`＋EEXIST | I2-c（5 回目のまま） |
| 追記 1・2（戻しはやめない・D7 の `reused` は残す） | 冒頭の「前提 P0」の最後の 2 行 |
| 追記 4（再起動を終わりの条件に） | §6.1 の (c) |

### 7.5 実装の契約（PR1a-f の実装）での判断

雛形の表の期待は変えていない。設計の文から実装で決めたこと・足したもの:

| 項目 | 判断 |
|---|---|
| bash `lock_obs_create` の終了コード | 0/3/6/10+i/40+i/70+i は意味を保ち、足したのは 85+i（`link` の失敗〔F12〕: tmp を消し、呼び手が `rmdir`）・99（`link` の ENOENT〔F11〕: `rmdir` しない）・100+i（読み直しが不明で、戻しが自分のものと示せなかった〔F14・F58〜F60〕: `rmdir` しない）。tmp の片付けは関数の中で行い、呼び手は `rmdir` の要否だけを決める。tmp の排他作成の EEXIST（F2）は 3（owner-exists）ではなく 10+i（不明） |
| 文面 | 開いていない作成の失敗（F2・F3）は `machine-lock-owner-create-failed`、公開の失敗は `machine-lock-owner-publish-failed`、読み直しの不明は `machine-lock-owner-readback-unknown`（3 実装）。`machine-lock-owner-write-failed` は書き込み・短い書き込み・閉じの失敗（F4〜F6・F17・F18）だけに使う（表の `write-failed` と `unk` を分けるため）。`(taken out again; not acquired)`／`(and it could not be taken out again)` の後半は今のまま |
| 観測点（§2.8 の表） | 設計の列挙に加え、戻しの inode の確かめを点 `owner-undo-lstat`（3 実装。bash は `lock_test_obs_fault` で注入して `[ ! -L ] && [ -ef ]` を「比べられない」に倒す）、tmp の書き込みを `owner-write`、自分の一時ファイルの unlink を `owner-unlink`、戻しの `rmdir` を `lock-rmdir` として表の行にした（どれも既存の試験の注入の名前のまま。`owner-write`・`owner-unlink`・`lock-rmdir` は `CM_VERIFY_TEST_HANDOFF=fault:` の口も残す）。`owner-pid`・`owner-fields` は観測でなく選択肢の検査だが、注入で同じ断りを返す口を持たせて表の行にした（走査の網羅の規則に揃える）。`etime`・`lstart` は読み込み口だけの点で、表の行にしない（§5 のとおり） |
| bash の held by | kv の記録（読み込み口の codec）は JSON の `lock_owner_field` で読めないので、その周回の 1 回の読み（`lock_obs_owner`）の pid・host を `pid <p> on <host>` に出す（表示だけ。判断は変えない） |
| `lock_pid_start_ms` | 10 秒のキャッシュをやめた（コマンド置換の中では効かない: §3 の末尾）。`now` を `ps` の前後で取り、厳しい解き方 `lock_etime_ms`（`machine_lock_etime_ms` はこれを呼ぶ）を使う |
| 割込みの口 | 表 K の 5 つに加え、試験のために bash `lock_release_as_head` の判定の後（`release-head-judged`、F62）と、空の owner の退かしの後（bash `empty-owner-moved`、同期 JS・TS の `onRecover('empty-owner-moved')`、F31）を足した |
| 実装後 1 回目の揃え（PM 処分 pm-return-4288-pr1af-impl-1） | 同期 JS の I3 も通常ファイルだけを一時ファイルと読む（FIFO などは bash と同じく `stray`。codex P2-2）。bash の `lock_obs_owner` は改行だけの owner を「空」（`LOB_EMPTY`）でなく解けない owner と読む（JS と同じく `machine-lock-owner-corrupt`。I4 は 0 バイトだけ）。I3 の旧版の tmp の pid の観測の間の時計の後退・遅い観測は `etime ECLOCK`（F53。`ps` が言えないのは `EINVAL` のまま。bash は `lock_pid_start_ms` の戻り値 3、同期 JS は `processStartMs` の `why.code`）。`setOwnerFields`・`handOff` の自分の tmp の後始末の失敗は投げず `machine-lock-tmp-left <tmp> (<errno>; …)` で名指す。`LOCK_OWNER_EXTRA` は環境から継がない（読み込み後に呼び手が置く）。`lock_obs_create` の終了コードの帯は `LOCK_ERRNOS` が 14 個以下で重ならない（試験で固定） |
| GNU `date -d` の緩い解き方（記録だけ、PM Claude P3-9） | `scripts/lib/machine-lock.sh` の `machine_lock_epoch_ms` は文字の種類だけ確かめて GNU の `date -u -d` に渡すので、Linux では `1`・`2026` のような壊れた `started_at=` も時刻に解け、D7 の `reused` の証拠になりうる。対象の macOS は BSD の `-j -f` が先で厳しく、この経路を通らない。直すなら `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$` を先に確かめる（この PR では直さない） |
| D6 のガード | 退避の整理が「保有中」（生きた・不明の退避の記録）で止まった周回は、owner の無い `<lock>` の片付け（I3）をしない（表 T の `tmp-new+gone-alive` × `guard-head` が `kept`）。死んだ記録の回収と `absent` の判定は今のまま |
| 表 F の駆動 | 289 件のうち F69・F71 の 12 件は駆動していない（`it.todo` のまま）（試験の `F_NOT_DRIVEN` に理由: 前提の外）。F57・F61 の 10 件は実装後 1 回目で駆動した（新しい口は足さない: 同期 JS・TS は `hooks.fault` を `owner-undo-rename`〔rename の前〕・`owner-undo-lstat`〔rename の後・確かめの前〕で副作用に使い、bash は `lock_test_obs_fault` を包んで `lock_test_pause` を呼ぶ。他のプロセス〔記録の pid の死・後継の回収と取得、札の期限切れ〕は F62・F67 と同じく残す状態で模す）。F61 は TS の戻しが tmp の無いのを同じ inode と読む変異（M3）を、F57 は bash の I3 が `.undo-*` を一時ファイルと読む変異（M4）を捕まえる。F2 は注入でなく実物の同じ token の tmp で EEXIST を作る。`limit` の行のうち F42・F49〜F51・F55・F58・F70 は、前提の外で起きることを再現して結果の欄を確かめる |

## 8. 残る判断（PM へ）

1. **TS（`machine-lock.ts`）を PR1a-f に入れるか**: 1 回目のまま入れる案（同じ窓 E2、§2.8 の `owner-create` は 3 実装の点）。1 回目の PM Claude は賛成
2. **猶予の無い呼び手の K1〜K3 の残り（`empty-dir`・`tmp-new`）**: 今も人が消すまで残る（#4277 からの振る舞い）。空の owner は I4 で回収するようになったが、owner の無い `<lock>` の既定の猶予は別の Issue にする案（この PR では既存の利用者の既定を変えない、§1.6 の方針のまま）
3. **PR1a 版の `machine-lock.sh` を読む旧いチェックアウト**: TZ の穴は同期まで残る。supervisor.lock を使う常駐（`../commandmate-agent-health`）を PR1a-f のマージの後に同期する手順を PR1c の切替の手順に入れる案。切替の朝に `started_at=` の無い旧い記録が残り、その pid が別のプロセスに再利用されて生きている間は止まったままになる（F38）。その手順に「`machine-lock-holder-unknown … lstart:EMISMATCH` が出たら、記録の pid のプロセスが supervisor でないことを確かめ、旧い記録なら `<lock>` を手で消す」の 1 行を入れる（PM Claude 3 回目 P3-5）

4. **（閉じた: PM 決定 `pm-decision-4288-pr1af-lease-premise.md` で前提 P0 の外。F69 で名指し、直さない）put-back の空の `<lock>` の窓に K1 から再開した新版の書き手（5 回目に見つけた）**: PM Claude 4 回目 P2-1 の順序（W が K1 で 10 分超止まる → D3 で片付け → R が取る → 札の外れた古い先頭 A が R の `<lock>` を退かし、token が違うので put-back の `mkdir` → その間に W が再開して A の `<lock>` に tmp を作り `link` して読み直しで自分の token を見る）は、I2-c の `link` でも 2 者が持つ（W は `<lock>` の owner、R は退避の記録。違いは W の記録が黙って上書きされず `restore-failed` で名指されること）。新しい書き手は `mkdir` した `<lock>` が今その名前にある `<lock>` と同じかを確かめられない（bash は作ったディレクトリの inode を原子的に取れない。`mkdir` の後の `lstat` も K1 の内側）ので、書き手の側では塞げない。塞ぐなら put-back の側で空の `<lock>` の窓を無くす: 自分だけの名前 `<lock>.put-<token>` を `mkdir` して `link(gone/owner, <lock>.put-<token>/owner)` し、`rename(<lock>.put-<token>, <lock>)`（rename(2)。宛先が無ければ原子的に現れ、空のディレクトリ〔他者の K1〕なら置き換え、相手の `link` は EEXIST で断る。空でなければ ENOTEMPTY で退避を残す）。JS・TS は `renameSync` で書けるが、bash の `mv` は宛先がディレクトリなら中へ動かす（`-T` は macOS に無い）ので、bash だけ rename(2) を直に呼ぶ手段（`perl -e rename` など）が要る。案: (a) この PR で put-back を `.put-<token>` → `rename` に替える（bash は依存を足す）、(b) F67 の 2 者の形を `limit`（新しい `kind`: 長い停止 2 つの重なり。終わる条件なし）として I7・I8 (a) の文を直す、(c) 別の Issue。リーダーの推しは (a) の JS・TS と (b) の bash（bash の依存を足さない）だが、I7 の「新版どうしに `limit` は無い」を崩すので PM の判断
5. **反転する既存の陽性の対照の名前**: `machine-lock-options-4288.test.ts:693-697` の `it` の名前は「`lock_release` は missing で他者の `<lock>` を消す」の陽性の対照として書かれている。5 回目の狭め（§3.1）で期待が反転するので、実装の契約で名前の変更を許すか、名前を保ってコメントで「PR1a-f で消さないに揃えた」と書くかを決める（案: 名前を保ちコメント。既存の `it` の名前を変えない規則に合う）

## 9. 本文に無い指摘

- `scripts/agent-health/product/deadline-guard.sh:55`・`lib.sh:217`・`lib.sh:294`（台帳の `lstart`）の `proc_matches` も地方時の `lstart` の文字列の比較で、E5 と同じ TZ 依存がある（台帳の止める判定で、ロックの外）。§4 の関数は消すか消さないかの判定専用なので、これには使わない（§4.2。2 回目のここにあった「§4 を呼べば塞げる」の提案は削った: PM 決定 3）。止める判定の TZ は別の作業（PM が #4288 に記録）
- `lock_settle_gone`（`verify-run.sh:1400`）は owner の無い退避先を `rmdir` するだけなので、一時ファイルが残った `.gone-*` は空にならず残り続ける（保有中とは読まれないので害は無く、散らかるだけ）
- `verify-run.sh:1129-1151` の `lock_pid_start_ms` は `etime` の形を確かめず、不正な出力を「今起動した」と読む（E7）。札の退かしで、生きた札を再利用と読みうる（消す側。ロックではなく列の順を崩す）。PR1a-f で同じ規則の解き方に替える（F37）が、今の develop にある欠陥として記録する
- `lock_release_as_head`（`verify-run.sh:1986`）・`releaseAsHead`（sync `:1127`）は記録を gone と判定してから `<lock>` を名前で `rm -rf` する。D5 は先頭として動くので札の 60 秒の内では起きないが、札が外れた後の再開で後継のロックを消しうる（今の develop の欠陥。PR1a-f で `lock_recover` の形に替える: §3.1・F62）
- `setOwnerFields`（sync `:941-948`）は token を確かめてから名前の `owner` へ `renameSync` で上書きする。今の呼び手 merge-pr は引渡しを使わないので記録の pid は自分で起きないが、引渡しの後に呼べば後継の owner を上書きしうる（PR1a-f で引渡しの後は書かないに狭める: §3.1）
- PR1a 版の書き込みの失敗の後始末 `rm -f "$LOCK_PATH/owner"`（`verify-run.sh:1645`）は名前で消すので、`cat >>` が失敗するまでの間に owner が他者のものに替わっていれば他者の owner を消す。P0-t の札で先頭は 1 人なので今の develop では起きないが、PR1a-f で消える形（I2-b の `-ef`）
- bash `lock_release`（`verify-run.sh:1727-1732`）の `missing)` の枝は記録を読めないまま `<lock>` を名前で `rm -rf` する。`lock_release_held`・sync・TS の `release` は missing を消さない（今の develop の食い違い。PR1a-f で揃える: §3.1）
- `setOwnerFields`（sync `:941-948`）の `writeFileSync`・`renameSync` は try が無く、古い先頭の退かしの窓で `<lock>` が無いと ENOENT を merge-pr に投げる（今の develop の欠陥。PR1a-f で `false` に: §3.1）
- 札の `lock_mark_done`（`verify-run.sh:1196-1205`）は他の待ち手の札も token を確かめてから `mv -f` で置き換える（確かめと置き換えの間の割込みで後から来た札を `done` にしうる。列の順だけでロックの owner は消さない。#4277 の札の規約の話でこの PR の外）
