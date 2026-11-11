# #4288 PR1a-f: owner の書き込みの原子性・旧版の `owner.tmp.*` の回収・D7 の TZ 依存（設計の 4 つと試験の表）

- Issue: #4288（2 番 run-lock・supervisor.lock の土台の続き）。土台: [lock-reservation-rest-4288.md](./lock-reservation-rest-4288.md) §1.6（D3・D7）・§1.14（PR1a の実装と D12 の不変条件）、[verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md) §2.8（観測点の表）
- PM の決定: `pm-return-4288-upstream.md` の共通の決定 1（PR1b・PR1c の上流のレビューから切り出した小さな PR）。指摘の出典: `prereview/review-4288-pr1c-upstream.md` の P2-2（PM の処分で P2-4 の「corrupt に気づく経路」も含む）・P2-3（EPERM の再利用 pid）、`pm-review-4288-pr1b-upstream-claude.md` の P3-8（G9: 取得の途中の SIGKILL・空でない owner 無し）
- この文書は上流の段（設計の 4 つ・試験の表）。実装は別の契約で、表の雛形 `tests/unit/verification/machine-lock-owner-atomic-4288.test.ts` の `it.todo` を赤から緑にする
- 事実の行番号は `fd2f4a589`（develop、PR1a `c3387cbe7` を含む）

## 0. 今の振る舞い（事実）

| # | 事実 | 場所 |
|---|---|---|
| E1 | bash の owner の作成は `set -C; : > owner`（空のファイルを排他で作る）→ `cat >> owner`（追記）→ 読み直し、の 3 段。1 段目と 2 段目の間で SIGKILL されると **0 バイトの owner** が残る | `verify-run.sh:1014`・`:1019`・`:1023`（`lock_obs_create`） |
| E2 | 同期 JS・TS も `openSync(file, 'wx')` → `writeSync(fd, text)` の 2 段で、間の SIGKILL で 0 バイトの owner が残る | sync `machine-lock-sync.mjs:229`・`:234`、TS `machine-lock.ts:440`・`:445` |
| E3 | 0 バイトや解けない owner は `corrupt`（bash は pid か token が空なら corrupt、JS・TS は parse の失敗も corrupt）。取得は回収せず待ち続け、待ちの終わりに何も名指さない（`LOCK_HELD_BY` は token から作るので空）。回収だけの D6 は `kept`、退避の整理は読み飛ばす | `verify-run.sh:936-937`・`:1660`・`:2027`・`:1401`、sync `:197-199`・`:666`・`:1160`、TS `:409-412`・`:841` |
| E4 | owner の無い `<lock>` の回収（D3）は「owner が missing で**中が空**」のときだけ（`rmdir`）。旧版の取得者（run-lock・supervisor.lock）は `owner.tmp.$$` に書いてから `mv -f` するので、その間の SIGKILL では `<lock>` に `owner.tmp.<pid>` だけが残り、新しい形では誰も回収しない（旧版は「owner が無く 1 分より古い」で中身ごと取っていた） | `verify-run.sh:1293-1307`・`:1501-1532`、sync `:487-501`・`:557-566`、旧版 `scripts/uat/run-lock.sh:62`・`:69`、`scripts/agent-health/product/lib.sh:174-176`（取得）・`:141-144`（`find -mmin +1`） |
| E5 | D7（supervisor.lock の pid の再利用）は、記録の `lstart=` と `LC_ALL=C ps -o lstart=` の**文字列の一致**で判定する。`ps -o lstart=` は地方時で出す（実測: 同じ pid で `TZ=UTC` は `Wed Nov 11 08:53:04 2026`、`TZ=Asia/Tokyo` は `Wed Nov 11 17:53:04 2026`）。書いた側と読む側の TZ が違うと、**生きた持ち主を「違う lstart＝再利用＝死んだ」と読み、ロックを回収する**（消す側） | `machine-lock.sh:83-96`・`:111-127`、書き手 `lib.sh:66-68`（`proc_lstart`） |
| E6 | D7 の包みは元の判定が `alive` のときだけ働く。`kill -0` が EPERM（別ユーザーのプロセス）なら元の判定は `unknown:pid:EPERM` で、死んだ持ち主の pid を別ユーザーが再利用している間、取得も D6 も断り続ける（review-4288-pr1c-upstream P2-3） | `machine-lock.sh:85`、`verify-run.sh:1107-1112` |
| E7 | 札の pid の再利用は既に `ps -o etime=` から起動時刻を出し、`createdAt + LOCK_PID_REUSE_SLACK_MS`（2000）より後に起動していれば再利用と読む。`lstart` の文字列は使わない（TZ に依らない） | `verify-run.sh:625`・`:1129-1151`・`:1168-1173`、sync `:80-96` |
| E8 | 札の公開は「tmp に書く → `ln tmp <name>`（EEXIST なら別の番号）」。`ln` は排他で原子的、この dir の置き場（`$TMPDIR`・`<base>`）で既に使っている | `verify-run.sh:1212-1240`（`:1223`） |
| E9 | 引渡し（D4）の owner の書き直しは `<lock>/.owner-<T1>` に書いてから `mv` する（tmp＋rename）。同期 JS の `setOwnerFields` も `.owner-<uuid>` | `verify-run.sh:1923-1944`、sync `:943-947`・`:960-970` |
| E10 | kv の記録の `started_at=` は `machine_lock_iso`（UTC の ISO、秒）で書く。BSD の `date -u -j -f '%Y-%m-%dT%H:%M:%SZ' <v> +%s` で秒に戻せる（実測 `2026-11-10T00:00:00Z` → `1794268800`） | `machine-lock.sh:167`・`:174-177` |

## 1. (a) 不変条件

変えないもの（土台）:

- **I0-a（D12、PR1a-c）**: 持ち主自身の解放が直接消すのは「記録の pid が呼び手自身、かつ記録に `pgid` があれば G が空」のときだけ。この PR は解放の経路に触れない（`lock_release_held`・`release`・`lock_release_as_head` は変えない）
- **I0-b（札の規約 #4277）**: `mkdir`・回収・owner の無い `<lock>` の片付けは列の先頭だけ。先頭でない者は何も動かさない
- **I0-c（§2.8）**: 不明は何とも読まない（取らない・消さない・解放しない）。生きた保有者のロックは誰も動かさない

足すもの:

- **I1（owner は完全な形でしか現れない）**: どの実装も owner を「`<lock>/.owner-<token>` に全て書いて閉じる → `link(tmp, owner)`（排他。在れば EEXIST）→ 読み直し → tmp を消す」の順で公開する。`<lock>/owner` という名前が見える時点で中身は全て書かれている。よって**どの中断点（SIGKILL）も 0 バイトや書きかけの owner を残さない**（§2 の表 K）
- **I2（排他は今のまま）**: 公開は `link` なので、在る owner（他者の記録・symlink・ディレクトリ）を書き換えない。D3 の「在る名前は上書きしない、他者のものは何も消さない」（`lock_obs_create` の戻り値 3・6）は変わらない。`mv`（`rename`）は在る owner を置き換えるので公開には使わない
- **I3（owner の無い `<lock>` の片付けの範囲）**: 片付けるのは**猶予つきの先頭**（`LOCK_OWNERLESS_GRACE_MS`／`ownerlessGraceMs` を渡した呼び手: run-lock・supervisor.lock）だけ。対象は「owner が missing」かつ「中の名前が全て一時ファイルの形（`.owner-*`〔新しい形・引渡し〕、`owner.tmp.*`〔旧版〕）で、通常ファイル」かつ「`<lock>` と全ての一時ファイルの mtime が猶予より古い」もの。消すのは**その一時ファイルの名前だけ**（`owner` という名前は消さない）と、最後の `rmdir <lock>`（空でなければ失敗する）。途中で誰かが公開すれば `owner` が在るので `rmdir` が失敗し、ロックはそのまま残る
- **I4（壊れた owner は誰も自動で消さない）**: 0 バイト・解けない owner（`corrupt`）は今のまま回収しない。代わりに取得の断り・D6 の結果で **`<lock>/owner` を名指して人に知らせる**（`machine-lock-owner-corrupt <lock>/owner (empty|unparsable)`）。I1 の後は新しく生まれないので、残るのは PR1a（`c3387cbe7`）〜本 PR の間に E1・E2 の窓で生まれたものと外からの書き込みだけ
- **I5（D7 の再利用の判定は 2 つの証拠が揃ったときだけ死に変える）**: `lstart=` の行を持つ記録（D7 の対象。supervisor.lock）に限り、元の判定（pid と G）が `alive` か `unknown:pid:EPERM` のとき、(1) `LC_ALL=C ps -o lstart=` の文字列が記録と**違い**、かつ (2) `ps -o etime=` から出した起動時刻が記録の `started_at=` ＋ `LOCK_PID_REUSE_SLACK_MS` より**後**なら、再利用（gone、その後に G を見る）。それ以外は元の判定のまま（ps が読めなければ、元が alive なら `unknown:lstart:<errno>`／`unknown:etime:<errno>`、元が EPERM なら EPERM のまま）。**D7 は何かを alive に変えることはなく、死に変えるのは 2 つが揃ったときだけ**。`started_at=` が無い・解けない記録（旧版の supervisor.lock の形）は D7 を当てず元の判定（pid だけ）
- **I6（3 実装同じ規則）**: I1〜I4 は bash（`verify-run.sh` の節。`machine-lock.sh` が読み込む）・同期 JS・TS で同じ。I3 は猶予の口を持つ bash・同期 JS だけ（TS は `ownerlessGraceMs` を持たない。呼び手が無い組み合わせは作らない）。I5 は bash の読み込み口だけ（supervisor.lock は bash だけが触る。§1.6 の D7 の行のまま）

I5 が TZ と EPERM の両方を解く理由: TZ が違うだけの生きた持ち主は (1) が成り立っても (2) が成り立たない（持ち主は自分で記録を書いたので、起動は `started_at` より前）。別ユーザーに再利用された pid は `ps` で読めるので (1)(2) が揃う。

## 2. (b) 状態と遷移の表

### 2.1 軸

- **owner の形（11）**:
  - 空・tmp だけ: `empty-dir`（owner も中身も無い。今の D3 の対照）・`tmp-new`（`.owner-<token>` だけ。新しい形の公開の前の中断）・`tmp-old`（`owner.tmp.<pid>` だけ。旧版の `mv` の前の中断）・`tmp-stray`（一時ファイルの形でない名前やディレクトリが混ざる）
  - 壊れ: `empty-owner`（0 バイト。E1・E2 の窓）・`garbage-owner`（解けない中身）
  - 完全（D7 の対象、`lstart=` あり）: `lstart-match`（`ps` の lstart が記録と同じ）・`lstart-tz`（文字列は違い、起動は `started_at` より前＝TZ が違うだけの持ち主）・`lstart-reused`（文字列が違い、起動が `started_at`＋2 秒より後＝再利用）・`lstart-ps-fails`（`ps` が読めない）・`lstart-legacy`（`started_at=` が無い旧版の形、文字列は違う）
  - 完全で `lstart=` の無い記録は D7 の対象外で、この PR で振る舞いが変わらない（PR1a の表のまま）ので軸に入れない
- **呼び手（4）**: `acquire-head-grace`（猶予つきの先頭の取得: run-lock・supervisor.lock）・`acquire-head-nograce`（猶予の無い先頭の取得: verify のゲート・merge-pr・precheck・gate-runner）・`acquire-behind`（先頭でない取得者）・`guard-head`（回収だけの先頭: D6 `lock_recover_only`／`recoverIfDead`）
- **観測の 3 値**: 形ごとに決め手が違う（雛形の `OBS_MEANING`）。空・tmp だけ・壊れは「年齢」（`alive`＝猶予以内、`gone`＝猶予より古い、`unknown`＝一覧・lstat・mtime・owner の読みの失敗）。D7 の形は「`kill -0` の pid」（`alive`、`gone`＝ESRCH、`unknown`＝EPERM。EIO などは表 F の F19）

### 2.2 結果（呼び手ごとに答えうるもの）

- 取得: `acquired`（ロックは `mine`）／`refused`（文面の種類 `rec`〔生きた記録〕・`taking`〔owner の無い若い `<lock>`、または猶予の無い呼び手〕・`queue`〔先頭でない〕・`unk`〔不明〕・`corrupt`〔I4、新〕・`stray`〔I3 の対象外の中身、新〕）
- D6: `removed`／`kept`
- ロックの行方: `unchanged`／`mine`／`absent`

### 2.3 表（11 × 4 × 3 = 132 セル、到達しない 15、到達する 117 行）

| 形 | acquire-head-grace（alive / gone / unknown） | acquire-head-nograce | acquire-behind | guard-head |
|---|---|---|---|---|
| empty-dir | refused(taking) / acquired / refused(unk) | refused(taking)×2 / refused(unk) | refused(queue)×3 | kept / removed / kept |
| tmp-new | 同上（**今: gone も refused で永久に残る**） | 同上 | 同上 | 同上（**今: kept**） |
| tmp-old | 同上（**今: 同上**） | 同上 | 同上 | 同上 |
| tmp-stray | refused(stray)×2 / refused(unk) | refused(taking)×2 / refused(unk) | 同上 | kept×3 |
| empty-owner | refused(corrupt)×2 / refused(unk) | 同左 | 同上 | kept×3 |
| garbage-owner | 同上 | 同上 | 同上 | kept×3 |
| lstart-match | refused(rec) / acquired / refused(unk) | 到達しない | 同上 | kept / removed / kept |
| lstart-tz | refused(rec) / acquired / refused(unk)（**今: alive を acquired＝生きた持ち主のロックを回収**） | 到達しない | 同上 | kept / removed / kept（**今: alive を removed**） |
| lstart-reused | acquired / acquired / acquired（**今: unknown〔EPERM〕は refused(unk) のまま永久**） | 到達しない | 同上 | removed×3（**今: unknown は kept**） |
| lstart-ps-fails | refused(unk) / acquired / refused(unk) | 到達しない | 同上 | kept / removed / kept |
| lstart-legacy | refused(rec) / acquired / refused(unk)（**今: alive を acquired**） | 到達しない | 同上 | kept / removed / kept（**今: alive を removed**） |

- 到達しない 15 セル: `acquire-head-nograce` × `lstart-*`（5 形 × 3 値）。`lstart=` を持つのは kv の記録（supervisor.lock）だけで、猶予の無い呼び手は JSON の owner を別の置き場で使い、読み込み口の D7 を読み込まない
- 太字の「今」は陽性の対照（直す前の実装で表と違う結果になるセル）。それ以外は今と同じ（陰性の対照）

### 2.4 数（雛形の型と試験が固定する）

- 表 T: 11 形 × 4 呼び手 × 3 値 = **132 セル**、到達しない **15**（`acquire-head-nograce` × `lstart-*`）、到達する **117 行**
- 表 K（中断点 × 実装、§2.5）: 5 × 3 = **15 行**
- 表 F（外部の呼び出しの失敗、§3）: **25 行**
- 合計 **157 行**

### 2.5 表 K: 取得の中断点（SIGKILL）× 実装 → 残る形

| 中断点 | 残る形 | 誰が片付けるか |
|---|---|---|
| K1 `mkdir` の後・tmp の作成の前 | `empty-dir` | 猶予つきの先頭が猶予の後（今のまま） |
| K2 tmp の書き込みの途中 | `tmp-new`（中身は書きかけ。読まれない） | 猶予つきの先頭が猶予の後（I3、新） |
| K3 tmp を書いた後・`link` の前 | `tmp-new` | 同上 |
| K4 `link` の後・tmp を消す前 | 完全な owner＋`.owner-<token>` | 通常の回収（pid が死ねば `lock_recover` が `<lock>` ごと退避して `rm -rf`） |
| K5 tmp を消した後 | 完全な owner | 同上 |

3 実装（bash・同期 JS・TS）で同じ 5 行。**どの行も `empty-owner`・`garbage-owner` を残さない**（I1）。陽性の対照: 今の実装は `: >`／`openSync` と追記の間の中断で `empty-owner` を残す。TS（猶予の口が無い）と猶予の無い呼び手は K1〜K3 の残りを片付けない（今の `empty-dir` と同じ。§5 の残る判断 2）。

## 3. (c) 外部の呼び出しの失敗の倒れ方（表 F、25 行）

倒れ方: `keep`＝何も消さない・取らない、`own-only`＝この呼び手が自分で作ったもの（自分の tmp・この `mkdir` が作った空の `<lock>`・この `link` が作った owner）だけを戻す、`residual`＝消す側に倒れうる残り（条件を明記）。

| # | 呼び出し・失敗 | 倒れ方 | 終状態 |
|---|---|---|---|
| F1 | `mkdir <lock>` が EEXIST 以外 | keep | 取らない、何も作らない（`unk`） |
| F2 | tmp の排他作成が EEXIST（同じ token の tmp が在る） | own-only | 開いていないので tmp は消さない。`rmdir <lock>`（空でないので残る）。取らない |
| F3 | tmp の作成がその他の errno（EACCES・ENOSPC） | own-only | `rmdir <lock>`。取らない、点 `owner-create` |
| F4 | tmp の書き込みの失敗（ENOSPC・EIO、注入 `owner-write`） | own-only | 自分の tmp を消し `rmdir <lock>`。取らない（`machine-lock-owner-write-failed`） |
| F5 | `link` が EEXIST（owner が在る） | own-only | 自分の tmp だけ消す。owner と `<lock>` は残す（他者のもの）。取らない（`owner-exists`） |
| F6 | `link` が ENOENT（tmp か `<lock>` が片付けられた） | own-only | 自分の tmp（在れば）を消し、`rmdir <lock>`（空のときだけ）。取らない |
| F7 | `link` がその他（EPERM・ENOTSUP・EIO） | own-only | 自分の tmp を消し `rmdir <lock>`。取らない、点 `owner-publish`（新） |
| F8 | 読み直しが不明（EIO） | own-only | 自分が `link` した owner と tmp を消し `rmdir <lock>`（今の `70+i` と同じ）。取らない |
| F9 | 読み直しが他者の記録 | own-only | 自分の tmp だけ消す。取らない（`owner-not-ours`） |
| F10 | 公開の後の tmp の削除の失敗 | keep | 取った。tmp は owner の隣に残り、解放・回収の `rm -rf` で消える |
| F11 | 戻しの tmp の削除の失敗（注入 `owner-unlink`） | keep | `<lock>` と自分の tmp が残る（`tmp-new`）。猶予つきの先頭が猶予の後に片付ける（I3） |
| F12 | 戻しの `rmdir <lock>` の失敗（注入 `lock-rmdir`） | keep | 空の `<lock>` が残る（今のまま） |
| F13 | owner の無い `<lock>` の一覧の失敗（点 `lock-list`） | keep | その周回は `mkdir` しない（`unk`） |
| F14 | 一時ファイルの lstat の失敗（点 `ownerless-tmp-lstat`、新） | keep | 同上 |
| F15 | `<lock>`・一時ファイルの mtime の失敗（点 `ownerless-mtime`） | keep | 同上 |
| F16 | 片付けの一時ファイルの削除の失敗（点 `ownerless-tmp-unlink`、新） | keep | その周回は `rmdir` も `mkdir` もしない（`unk`） |
| F17 | 片付けの `rmdir` が ENOTEMPTY／EEXIST（途中で誰かが公開した） | keep | 「間に取られた」: 消さず、次の周回で記録として判定する |
| F18 | 片付けの `rmdir` がその他の errno（点 `ownerless-rmdir`） | keep | その周回は `mkdir` しない（`unk`） |
| F19 | `kill -0` が EPERM 以外の失敗（EIO） | keep | 不明のまま（D7 は当てない） |
| F20 | `ps -o lstart=` の失敗・空（点 `lstart`） | keep | 元が alive なら `unknown:lstart:<errno>`、EPERM なら EPERM のまま |
| F21 | `ps -o etime=` の失敗・空・解けない（点 `etime`、新） | keep | 元が alive なら `unknown:etime:<errno>`、EPERM なら EPERM のまま |
| F22 | `started_at=` が無い・`date` で解けない | keep | D7 を当てず元の判定（pid だけ） |
| F23 | `hostname` が記録の `host=` と違う | keep | 他 host の記録は alive（D7 は当てない） |
| F24 | 時計の後退（持ち主の起動から取得までの間に 2 秒より大きく戻る）かつ書き手と読み手の TZ が違う | residual | (1)(2) が揃い、生きた持ち主を再利用と読みうる。2 つの独立な条件が同時に要る。片方だけでは起きない（I5）。Linux の `etime` は起動からの経過なので時計の前進でも同じ（supervisor.lock は macOS の launchd だけが使う） |
| F25 | 0 バイト・解けない owner（読めた） | keep | 誰も消さない。断りと D6 の結果で `<lock>/owner` を名指す（I4） |

`residual` は F24 だけ。他の消す操作は全て own-only（自分の tmp・自分の `mkdir`・自分の `link`）か、I3 の「一時ファイルの名前と空の `<lock>` の `rmdir`」で、どちらも記録（`owner`）を消さない。

流用する既存の部品の倒れ方: `lock_pid_start_ms`（etime、`verify-run.sh:1129`）は読めなければ空を返す（F21 で不明に倒す）。10 秒のキャッシュは pid ごとで、D7 の判定にもそのまま使える。`lock_obs_mv`・`lock_obs_list`・`lock_obs_lstat`・`lock_obs_mtime` は 3 値で答える（§2.8）。`ln` の EEXIST は札と同じく `LC_ALL=C` の文面で読む（`:1223`）。

## 4. (d) PR の切り方

- **1 本（PR1a-f）**。書くファイル:
  - `.claude/skills/cmate-verify/scripts/verify-run.sh`・`.agents/skills/cmate-verify/scripts/verify-run.sh`（バイト一致）の機械ロックの節: `lock_obs_create` の中身（tmp → `ln` → 読み直し → tmp の削除。引数・標準入力・戻り値 0/3/6/10+i/40+i/70+i は変えない）、`lock_ownerless_empty`／`lock_expire_ownerless` の一時ファイルだけの `<lock>`（I3）、取得と D6 の `corrupt` の文面（I4）、`lock_obs_owner` が codec の `LPO_STARTED_AT` を `LOB_STARTED_AT` に写す
  - `scripts/lib/machine-lock.sh`: kv の codec が `started_at=` を読む、D7 の包みを I5 に替える（`machine_lock_lstart_state` は残し、etime の比較を足す）
  - `scripts/orchestrate/machine-lock-sync.mjs`: `makeObserver().create` の中身（`wx` の tmp → `linkSync` → tmp の削除。戻り値の形は同じ）、`expireOwnerless`／`ownerlessEmptyLock` の一時ファイルだけ（I3）、`corrupt` の警告（I4）
  - `src/lib/verification/machine-lock.ts`: `create` の中身（同上）、`corrupt` の警告（I4）。**PM の決定の書くファイルには無いが、I6 の「3 実装」と §2.8 の表（`owner-create` は bash・TS・同期 JS）に合わせて入れる**（§5 の残る判断 1）
  - `docs/design/verify-lock-holder-group-4288.md` §2.8: 点 `owner-publish`・`ownerless-tmp-lstat`・`ownerless-tmp-unlink` を足し、`owner-create` の説明を「tmp の排他作成と書き込み」に直す。読み込み口の点 `etime` は `lstart` と同じく注記と注入の試験で固定する
  - 試験: この雛形を実装で埋める。下の「意図した変更」の既存の試験
- **API は呼び手と同じ PR**: 新しい API は作らない。オプション（`ownerlessGraceMs`／`LOCK_OWNERLESS_GRACE_MS`）の意味を I3 に広げるだけで、今それを渡すのは試験だけ（本番の呼び手は PR1b・PR1c）。猶予の口の無い TS には I3 を足さない（呼び手の無い組み合わせを作らない）
- **PR1b・PR1c との関係**: ファイルは重ならない（PR1b は `run-lock.ts`・`run-lock.sh`・`run-server.sh`・`daily.sh`、PR1c は `lib.sh`・`deadline-guard.sh`）。PR1c の表の `other-lstart` × `unknown`（EPERM）と `corrupt` の文面は、PR1a-f の後は「再利用なら回収」「`corrupt` を名指す」に変わる。**マージは PR1a-f を先**にし、PR1c の表はその後の振る舞いを期待にする（PR1c の設計に「PR1a-f で塞ぐ。それまでは形を区別して文面で人に知らせる（消さない）」と書く、PM の決定 1）
- 難易度: 表が閉じていれば中（sonnet）。I5 の時刻の扱い（BSD/GNU の `date`、etime の解き方の共有）と 3 実装の一致があるので、上流のレビューで表 F が閉じなければ opus

### 4.1 意図した変更（既存の試験）

期待を消す側に変えるものは無い。次の 4 か所は**変異の口か残るものの名前**が変わる（実装の契約で直し、試験のコメントにこの節を書く）:

| 場所 | 今 | 変更 | 理由 |
|---|---|---|---|
| `tests/unit/verification/machine-lock-options-4288.test.ts:272-285`（陽性の対照） | `set -C` を外す・`'wx'` を `'w'` にする変異で「在る owner を上書きする」 | 変異を「公開の `ln`／`linkSync` を `mv -f`／`renameSync` にする」に替える。期待（上書きして取ったと言う）は同じ | 排他は tmp の作成でなく公開の `link` が担う（I2）。tmp は token ごとの名前なので `set -C` を外しても上書きは起きず、今の変異は空振りになる |
| `tests/unit/verification/lock-pr1a-review-fixes-4288.test.ts:206-219`（TS の陽性の対照） | `openSync(file, 'wx')` → `'w'` | 同上（`linkSync` → `renameSync`） | 同上 |
| `tests/unit/verification/machine-lock-options-4288.test.ts:293-295`（bash の `owner-unlink` の注入） | 戻しの削除に失敗すると `<lock>/owner` が残る | `<lock>/.owner-<token>` が残り、`<lock>/owner` は無い | 書きかけは tmp にしか無い（I1）。残りは I3 で片付く（消さない側のまま） |
| `tests/unit/verification/machine-lock-options-4288.test.ts:308-309`（同期 JS の同じ注入） | 同上 | 同上 | 同上 |

固定している注入の点の名前（`owner-create`・`owner-write`・`owner-readback`・`owner-unlink`・`lock-rmdir`）と、`owner-create` の注入の対象（`<lock>/owner`。`lock-pr1a-review-fixes-4288.test.ts:186-198` が注入で後継の owner を置く）は変えない: `owner-create` の注入は tmp を開く前に `<lock>/owner` を対象に走らせ、後継が置かれれば公開の `link` が EEXIST になって取らない（期待どおり）。D7 の既存の試験（`machine-lock-options-4288.test.ts:560-596`）は `started_at=2026-11-10T00:00:00Z` で、生きた `sleep` は今日起動するので「違う lstart → removed」「同じ lstart → kept」「`ps` の失敗 → kept と名指し」は I5 でもそのまま通る（実装の契約で実行して確かめる）。

## 5. 残る判断（PM へ）

1. **TS（`machine-lock.ts`）を PR1a-f に入れるか**: PM の決定の書くファイルには無い。同じ窓（E2）があり、§2.8 の `owner-create` は 3 実装の点なので、入れる案にした
2. **猶予の無い呼び手（verify のゲート・merge-pr・precheck・gate-runner）の K1〜K3 の残り**: 今も owner の無い空の `<lock>` を回収しない（#4277 からの振る舞い）。I1 で `empty-owner` は無くなるが、`empty-dir`／`tmp-new` は人が消すまで残る。既定の猶予を入れるかは別の Issue にする案（この PR では既存の利用者の既定を変えない、§1.6 の方針のまま）
3. **今ある `empty-owner` の扱い**: I4 で名指すだけにした。自動で回収するなら「`<lock>` ごと退避 → 退避先の owner が 0 バイトのままなら消す、書かれていれば戻す」（`lock_recover` の形）が要り、PR1a 版の取得者が退避の後に書き込む経路（bash の `cat >>` は名前で開くので ENOENT、JS・TS は開いた fd に書く）を表に足すことになる。PR1a の窓は数 μs で、残っているのは PR1a のマージ後に SIGKILL された取得だけなので、人が消す案を推す

## 6. 本文に無い指摘

- `scripts/agent-health/product/deadline-guard.sh:55` と `supervisor.sh:105`・`:187`・`:238`（台帳の `lstart`）の `proc_matches` も地方時の `lstart` の文字列の比較で、E5 と同じ TZ 依存がある（台帳の判定で、ロックの外。PR1c か別 Issue）
- `lock_settle_gone`（`verify-run.sh:1400`）は owner の無い退避先を `rmdir` するだけなので、一時ファイルが残った `.gone-*` は空にならず残り続ける（保有中とは読まれないので害は無く、散らかるだけ）
