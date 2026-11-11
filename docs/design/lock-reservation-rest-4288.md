# Issue #4288 の 2〜5 番の設計（run-lock の回収・ready 待ちの実時間・claude-3 の自己予約・素の send）

- 状態: 設計 第 1 版（設計の段。コードは変えない。実装は PM の確認の後、別の契約で行う）。2 番（§1）と §6・§7 の PR1 の行・§8 の supervisor.lock は**第 2 版**（事前レビュー `review-4288f.md` の P1 3・P2 6 の処置と、PM の決定「machine-lock の実装と規約に載せ替える」〔`pm-return-4288-prereview.md` の (a)〕・「supervisor.lock を PR1 に含める」〔`pm-return-4288-design.md` の (c)〕を反映。§1 の行番号は `426ad2661`）。2 番（§1）と §6・§7 の PR1 の行は**改訂 2**（codex-2 の再確認 `review-4288g.md` の新しい P1 2・P2 5 と、PM の決定 `pm-return-4288-design-rev1.md` の (a) を反映。処置は §1.13 の「改訂 2」の行。行番号は `850abbc71`）。**5 番は PM の決定で採らない**（§4 の冒頭）。3・4 番は PR2 で実装済み
- 対象: Issue #4288 の対象 2〜5（1 番は PR #4295 でマージ済み。設計は [verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md)）
- 行番号は `fix/4288-lock-rest` の `ed9b89eac` のもの。名前で引くこと
- 表記: **事実**＝コード・実行で確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 再現はすべて `os.tmpdir()`／scratchpad の下に作った一時ディレクトリで行い、`$CM_RUN_LOCK_DIR`・`reservationDir`・`--state-dir` をそこへ向けた。`~/.commandmate` の実物、サーバー、tmux、エージェント CLI には触っていない

## 結論（一覧）

| 番号 | 直すか | 選んだ案 | 難易度 |
|---|---|---|---|
| 2 run-lock の rename の回収（＋同じ形の supervisor.lock） | **直す**（TS・bash の両方で再現した） | 案 2D（第 2 版）: run-lock と supervisor.lock を machine-lock（#4277 の札・先頭だけの回収・#4288 の 1 番の退避の読みと 3 値の観測）の実装に載せる。載らない差 8 つ（owner の書式・パス・owner の無いディレクトリ・pid の引渡し・持ち主でない者の解放・取得しない回収者・`lstart`・継承）は、既定で働かないオプションと操作として machine-lock に足す。改訂 2 で、保護する実作業（UAT のサーバー・daily の子）のプロセスグループを owner に載せて親の死だけでは回収しない（D9、#4288 の 1 番と同じ形）、TS の観測を 3 値のまま渡す（D10）、時計を数値の ms で渡す（D11）、自己解放の条件（D12）を足した。第 1 版の案 2C は代案として比較に残す | 難（PR を 3 本に分ける） |
| 3 ready 待ちの 90 秒 | **直す**（再現した。95 秒〜最大 5795 秒） | 案 3B: 開始時刻からの実時間の期限＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る | 易 |
| 4 claude-3 の自己予約 | **直す** | 案 4B: `reserve --self`。`commandmate whoami --json` で呼び手が claude-3 のときだけ、状態確認を省いて持ち主 `leader` で取る | 易 |
| 5 素の `commandmate send` | **採らない（PM の決定）** | 案 5C（PreToolUse フック）は作らない。リポジトリの共有の設定（`.claude/settings.json`）を足すと、clone した利用者を含む全 Claude セッションに効くため。`team.md` に理由と送り方（claude-3 へは `claude3-reserve.ts send` だけ）を書く | — |

PR は 2 番が 3 本（PR1a〜PR1c）、3〜5 番が 1 本（PR2）（§7）。

## 重なり（並行するレーンとの関係）

- **#4300（send の送信経路: `src/lib/tmux`・`src/lib/session`・送信の API／CLI・cli-tools の送信前の判定）**: 選んだ案はどれも触らない。5 番は製品の `src/cli/commands/send.ts`・送信 API を**書かない**（案 5C はリポジトリの Claude Code の設定とフックのスクリプトだけ）。
  製品側で止める案（§5 の 5A・5B）を採る場合は `src/cli/commands/send.ts` と `src/app/api/worktrees/[id]/send/` を書くことになり #4300 と重なるので、その場合は **5 番を #4300 のマージの後に回す**（別 PR・別の契約）。今回は採らない。
- **G #4227（`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts`）**: どの番号も触らない。
- 書くファイルの一覧は §6。

## 止める点

**無し。** G のファイルに触る必要は無い。2 番（第 2 版）は machine-lock の実装（`machine-lock-sync.mjs`・`verify-run.sh`・`machine-lock.ts` の owner の排他作成）に足すが、**札の規約（#4277）は変えない**。足すものは既定で働かないので、既存の利用者（gate-runner・precheck・merge-pr・verify-run.sh）の振る舞いと既存の試験の期待は変わらない（§1.6）。PM に決めてほしいことが 3 つある（§1.13 の末尾。どれも止める条件ではない）。

---

## 1. 2 番: agent-health の run-lock の rename による回収

### 1.1 今の振る舞い（事実）

| 箇所 | 中身 |
|---|---|
| `src/lib/agent-health/run-lock.ts:148-191` `acquireRunLock` | `mkdirSync(dir)` で取る。EEXIST なら owner を読み、継承（`CM_RUN_LOCK_TOKEN`）でなく `isStale` なら `takeStale` して最大 5 回やり直す |
| `run-lock.ts:106-114` `isStale` | owner があれば pid の生死だけ。無ければディレクトリの mtime が 60 秒（`OWNERLESS_GRACE_MS`）より古いとき stale |
| `run-lock.ts:117-137` `takeStale` | 判定した token（`judged`）を読み直し → **ディレクトリごと** `<dir>.stale.<pid>.<乱数>` へ `renameSync` → 動かした owner の token が `judged` と違うか生きていれば、`if (!fs.existsSync(dir))` のときだけ戻す。**戻せなかったら退避したまま `return`**（`:127-134`） |
| `run-lock.ts:175-180` | 取れた後の owner は staging に書いて `renameSync` で置く（上書きの rename） |
| `run-lock.ts:186-188` `release` | owner の token が自分のときだけ `rmSync(dir)` |
| `scripts/uat/run-lock.sh:88-100` `run_lock_take_stale` | 同じ形。`mv "$dir" "$aside"` → 違えば `[ -e "$dir" ] \|\| mv "$aside" "$dir"`（`:95`） |
| `run-lock.sh:60-70` `run_lock_write_owner` | tmp に書いて `mv -f`（上書き） |
| `run-lock.sh:149-155` `run_lock_set_pid` | 持ち主が owner を書き直す（UAT がサーバーの pid に替える。`scripts/uat/run-server.sh:473`） |
| 呼び手 | `scripts/agent-health/daily.sh:92`（bash）・`scripts/agent-health/main.ts:226`（TS）・`scripts/uat/run-server.sh:412,567`（bash、UAT と cleanup） |

穴（設計 [claude3-dispatch-exclusion-4243.md](./claude3-dispatch-exclusion-4243.md) §1.4 R4 の静的な割込み例）: A が X を stale と判定 → B が先に X を回収して取る → A が **B の生きたディレクトリ**を退避 → 名前が空いた間に C が `mkdir` で取る → A は C のディレクトリがあるので B を戻さない。B と C が両方「取った」と信じる。

### 1.2 再現（事実）

**TS**（`npx tsx` の一時スクリプト。`fs.renameSync`・`fs.existsSync` を包み、A の退避の直前に B を、A が戻すかを確かめる直前に C を走らせた。pid の生死は `isAlive` の注入で X だけ死）:

```json
{"A":"別の実行がロックを持っている: …/commandmate-run.lock（pid 1003, C, …）","B":"acquired","C":"acquired","ownerAtDir":"C",
 "asides":[{"name":"commandmate-run.lock.stale.<pid>.<rand>","owner":"B"}]}
```

**bash**（`PATH` の先頭に `mv` の shim を置き、A の最初の `mv "$dir" …` の直前に B、直後に C を、shim を外した `PATH` で走らせた。B・C の pid は生きている `sleep 30`）:

```
B GOT
C GOT
A REFUSED: another run holds <tmp>/commandmate-run.lock (pid 47175, label C, …)
owner at lock: C
aside token=B
```

どちらも **B と C が同時に取れ**、B の owner は `.stale.*` に退避されたまま残る（B の `release` は owner の token が違うので何もせず、退避は誰も消さない）。

見立て: 実運用で起きるには「前の持ち主が死んでいる」＋「2 者がほぼ同時に回収に入る」＋「3 者目がその窓に来る」が要り、頻度は低い（daily 08:xx・UAT・手動の run.ts）。ただし起きたときは UAT と日次確認が同時に走り、互いのサーバー・tmux を壊しうる（#3359 がこのロックを入れた理由そのもの）。

### 1.3 直すか: 直す（第 2 版: machine-lock の実装と規約に載せ替える）

再現した。受入基準の「2 者が同時に持つ」に当たる。第 1 版の案 2C は事前レビュー（codex-2 `review-4288f.md`、P1 3・P2 6。処置は §1.13）で、停止した公開者・token の確認と削除の間・公開の失敗の後始末に穴が残ると指摘された。これらは #4277・#4288 の 1 番で machine-lock が札（ticket）・先頭だけの回収・退かしてから確かめる回収・3 値の観測で閉じた論点と同じなので、PM の決定（`pm-return-4288-prereview.md` の (a)）に従い、**run-lock と supervisor.lock を machine-lock の実装と規約の上に載せる**。同じ種類の穴を別の実装で 2 度閉じない。

supervisor.lock（`scripts/agent-health/product/lib.sh`・`deadline-guard.sh`）も同じ rename の形の 2 例目なので、PM の決定（`pm-return-4288-design.md` の (c)）どおりこの番号に含める（第 1 版の §1.8・§8 の「別 Issue を推す」は撤回）。

### 1.4 案の比較（第 2 版）

| 案 | 中身 | 評価 |
|---|---|---|
| **2D machine-lock に載せる（採用）** | 取得・回収・解放・観測は machine-lock の関数をそのまま使う（bash は `verify-run.sh` のロックの節、TS は同期の写し `machine-lock-sync.mjs`）。run-lock・supervisor.lock だけにある差（§1.6 の D1〜D8）は、既定で働かないオプションと 2 つの操作として machine-lock の側に足す | 札の規約（#4277）・退かしてから確かめる回収・`.gone-*` を保有中と読む規則（#4288 の 1 番 §2.7）・3 値の観測（同 §2.8）を、試験ごと流用できる。同じ穴を 2 度閉じない |
| 2C（代案。載せ替えが不可能なときだけ） | ディレクトリを動かさず `owner` だけを回収し、公開と戻しを `link` の排他作成にする（第 1 版 §1.5） | 不採用。事前レビューの P1 3 件（停止した公開者が保有期間の途中で入る・確認の後の `rm -rf`・公開失敗の `rm -rf`）を塞ぐには、取得の順序（札）・回収の担い手の 1 人化・解放の世代の確かめを足すことになり、machine-lock を別に作り直すのと同じになる。加えて bash の `ln` は宛先がディレクトリ・ディレクトリへの symlink なら中へ作って成功する（下の「確かめたこと」）ので、排他の公開の証拠にならない |
| 2A 戻せなかった退避を保有中と読む | 第 1 版のまま | 不採用（第 1 版の理由）。machine-lock の §2.7 はこれを「札で先頭 1 人だけが `mkdir` する」の上で行うので成り立つ。札の無い run-lock に単独で入れても窓が残る |
| 2B 世代ファイル | 第 1 版のまま | 不採用（第 1 版の理由。置き場所の形が変わり、旧版と互いを見ない） |

確かめたこと（事実。scratchpad の一時ディレクトリで、macOS の `/bin/bash` 3.2.57・Node で実行）:

- `ln t L`（L は既存のディレクトリ）は成功し、`L/t` を作る。第 1 版 §1.5 の `ln "$tmp" "$dir/owner"` は、`owner` がディレクトリなら成功してしまう
- `set -C`（noclobber）の `printf … > <d>/owner` は、`owner` が通常のファイル・ディレクトリ・ディレクトリへの symlink・宛先の無い symlink なら拒否し、**`/dev/null` への symlink なら書けたことにする**。Node の `writeFileSync(…, { flag: 'wx' })`（`O_CREAT|O_EXCL`）は 5 つとも `EEXIST`

### 1.5 載せられるかの段ごとの確かめ（事実。行番号は `426ad2661`）

machine-lock の 3 実装は `src/lib/verification/machine-lock.ts`（TS、非同期）・`scripts/orchestrate/machine-lock-sync.mjs`（同期 JS）・`.claude/skills/cmate-verify/scripts/verify-run.sh` のロックの節（bash、`:590` の `# --- machine-wide gate lock` から `:1626` の `# --- gate execution` の前まで）。

| 段 | machine-lock の規則（場所） | run-lock・supervisor.lock の今（場所） | 載るか・差 |
|---|---|---|---|
| 置き場所と名前 | `<root>/<name>.lock`、札 `<root>/<name>.queue/`、退避 `<root>/<name>.lock.gone-<token>-<serial>`（`machine-lock.ts:94`・`:239`、sync `:61-62`、bash `:1351-1352`）。退避の一覧は `<lock>` の親を読む（bash `lock_gone_candidates` `:1135`、TS・sync は `ctx.root`） | run-lock は `$CM_RUN_LOCK_DIR` か `<tmpdir>/commandmate-run.lock` の**フルパス**（`run-lock.ts:56-60`、`run-lock.sh:33-41`）。テストは `CM_RUN_LOCK_DIR=<tmp>/commandmate-test-run-lock/<pid>` で `.lock` で終わらない（`tests/setup.ts:289`）。supervisor.lock は `<base>/supervisor.lock`（`lib.sh:128-130`） | 差 **D2**（パスで渡す口が無い） |
| 取得 | 札を取り（`link` の排他）、生きた札の先頭だけが退避を片付けてから `mkdir <lock>` → `owner` を書く（`machine-lock.ts:883-`・`claim :617-652`、sync `:674-`・`claim :394-425`、bash `lock_acquire :1348-`・owner `:1416`）。予算 0 でも札を取り、先頭なら 1 回試す（`#4277 §2.7` の `precheck-heavy-3884` の行） | 札なしの `mkdir` を 5 回まで。取れたら staging を `rename`／`mv -f` の上書きで `owner` に（`run-lock.ts:157-180`、`run-lock.sh:116-130`・`:60-70`、`lib.sh:167-182`）。待たない（1 回で断る） | 載る（予算 0 ＝ 1 回で断る）。owner の書式は差 **D1** |
| 待ちの順 | 札の順（#4277 §2.3） | 無し（`mkdir` の取り合い） | 載る。全員が予算 0 なので、札は一瞬だけ残る |
| 回収 | 先頭だけ。owner の 1 回の読みから判定し（同じ host・pid が ESRCH・pgid があればグループも ESRCH）、`<lock>` を `.gone-*` へ退かしてから token を確かめ、違えば戻す。戻せなければ退避を残し、先頭は生きた退避を保有中と読む（`breakStale :835-875`、`settleGone :778-812`、sync `recoverLock :624-`、bash `lock_recover :1323-1346`・`lock_settle_gone :1248-`） | 誰でも回収する。`<dir>.stale.*` へ退かし、戻せなければ退避したまま（`run-lock.ts:117-137`、`run-lock.sh:88-100`、`lib.sh:153-164`）＝ §1.2 の穴 | 載る。旧い `.stale.*` は `.gone-` の形でないので machine-lock の読み手は見ない（bash `:1136`・`:1143-1144`） |
| 保有者の判定 | `holderState`（`machine-lock.ts:458-466`、sync `:221`、bash `lock_holder_state :973`・`lock_record_state :985`）。別 host・pid が読めないものは生きている扱い | run-lock は pid だけ（`run-lock.ts:106-108`、`run-lock.sh:75-83`。bash は `run_lock_field` を欄ごとに別々に読む `:44-47`）。supervisor.lock は **pid と `lstart`**（`lib.sh:132-137`、pid の再利用を死と読む） | run-lock は載る（host の無い旧い記録は差 **D1** で「この host」と読む）。supervisor.lock の `lstart` は差 **D7** |
| owner の無いディレクトリ | 回収しない（`owner` が missing なら待つ。TS `:1051-1062`、bash `:1431-1444`）。最初の owner が書けなければ `<lock>` を戻す（P3-2） | 60 秒（mtime。TS は ms、bash は `find -mmin +1`）より古ければ取る（`run-lock.ts:109-111`、`run-lock.sh:77-79`、`lib.sh:143-145`）。テストが固定（`run-lock-3359.test.ts:82`、`product-supervisor-3312.test.ts:603`） | 差 **D3** |
| 解放（持ち主自身） | owner の 1 回の読みで token が自分なら消すだけ。1 回きり。生きた保有者のロックは誰も動かさないので、読みと削除の間に入れ替わらない（#4277 §2.4 の 3、S1。`machine-lock.ts:1022-`、sync `:794-`、bash `lock_release :1500-1525`） | token を読んで `rm -rf`（`run-lock.ts:186-188`、`run-lock.sh:158-164`、`lib.sh:200-205`） | 同期 JS の handle の `release` は載る（1 回きり・token が自分のときだけ消す・missing と不明は消さない）。**bash の `lock_release` はそのままは載らない**（改訂 2。`verify-run.sh:1500-1525` は owner が missing なら `rm -rf <lock>`〔`:1506-1508`〕、token の無い壊れた記録も削除へ進み〔`:1513` の条件が空の token を通す〕、関数に 1 回きりの制御が無い）→ 差 **D12** |
| 解放（持ち主でない者） | 無い（machine-lock の解放は常に持ち主自身） | UAT の `down`（`run-server.sh:534`）と `up` の失敗の trap（`:367`）は、**持ち主（サーバー）を止めた後に**別のプロセスが token を読んで消す | 差 **D5**（S1 の前提「解放者が生きた持ち主」が成り立たない。事前レビュー P1-2） |
| 持ち主の pid の引渡し | 近いもの: bash `lock_publish_group`（`:1848-1870`）が同じ取得の中で owner を**新しい token**（`<T0>-g<G>`）で tmp→`mv`→読み直し。同期 JS の `setOwnerFields`（`:808-816`）は pid と token を変えない欄の更新 | `run_lock_set_pid`（`run-lock.sh:149-155`）が token を読んで `mv -f` で上書き（pid だけ替え、token は同じ） | 差 **D4** |
| 取得しない回収者 | 無い（回収は取得の途中にだけある） | `deadline-guard.sh:85-88` が `product_lock_take_stale` だけを呼ぶ | 差 **D6** |
| 継承 | 無い | `CM_RUN_LOCK_TOKEN` の持ち主が生きていれば自分のもの（`run-lock.ts:164-168`、`run-lock.sh:131-134`） | 差 **D8** |
| 観測 | 3 値（生きている／いない／不明）。不明は取らない・消さない・解放しない（#4288 §2.8。TS `makeObserver :354`、sync `:126`、bash `:700-`） | 2 値（`2>/dev/null` と `|| return 0`） | 載る |
| signal・EXIT | TS・sync: プロセスの終了で残った札・ロックは次の先頭が回収。bash: EXIT trap で札を `done`・解放（`lock_cleanup_on_exit :1597`） | 各スクリプトの EXIT trap が release（`daily.sh:97`、`supervisor.sh:82`、`run-server.sh:417`） | 載る（release の中で自分の札を `done` にする） |
| bash だけで動く | bash の実装は `verify-run.sh` の節の中にある。その節は単独の bash で `eval` して動く（試験がそうしている: `tests/unit/verification/lock-4288-harness.ts:21-34`、`machine-lock-invariants-4277.test.ts`）。節は `set -u` の下で書かれている（`verify-run.sh:55`） | `daily.sh`・`run-server.sh`・`lib.sh` は bash だけで動き、Node を前提にしない（`daily.sh` は Node の前に lock を取る `:90-99`） | 載る（§1.7 の読み込み口）。owner の書き方・読み方と、パスで渡す取得を関数に切り出す、振る舞いを変えない手直しが要る |

結論（事実と、その上の判断）: 札・先頭だけの回収・退かしてから確かめる回収・`.gone-*` の読み・3 値の観測・持ち主自身の解放は、run-lock・supervisor.lock にそのまま載る。載らない差は D1〜D8 の 8 つで、どれも「既定で働かないオプション」か「新しい操作」として machine-lock の側に足せる（§1.6）。**札の規約（#4277）は変えない**（札の形・番号・`done`・GC・外してよい条件に触れない）。

### 1.6 差と、最小の埋め方

既存の machine-lock の利用者（gate-runner・precheck・merge-pr・verify-run.sh）には、どのオプションも既定で働かない（既存の machine-lock の試験の期待は変えない）。

| 差 | 足りないこと | 埋め方（最小） | 足す場所 |
|---|---|---|---|
| **D1 owner の書式** | machine-lock の owner は JSON（`{pid,host,token,acquiredAt,pgid?}`）。run-lock・supervisor.lock は `key=value` の行（`pid`・`started_at`・`label`・`token`・`run_dir`、supervisor は `lstart`）。旧版の取得者（§1.9）は `sed 's/^pid=//'` で読むので、JSON の owner を「pid が無い＝死んだ」と読んで**生きた新しいロックを奪う**（`run-lock.sh:75-83` の `run_lock_pid_alive ''` が偽 → stale） | **owner の書き方と読み方を差し替えられるようにする（codec）**。run-lock・supervisor.lock は `key=value` の行のまま書き、新しい行 `host=` と、実作業のグループを載せた記録では `pgid=`（D9）を足す（旧い読み手は知らない鍵を読まない）。`pgid=` の数の確かめは JSON の `pgidFieldOk`（sync `:111`）・`lock_pgid_field_ok`（bash `:886`）と同じ（鍵があって値が空・数でなければ不明）。読み手は `host=` の無い記録を「この host」と読む（このロックはローカルの tmp と `<base>` に置くので、他 host の記録は来ない）。判定は**1 回の読みのテキストから**全ての欄を取る（bash は `lock_obs_owner` の `cat` 1 回の出力を codec が解く） | sync: オプション `ownerCodec: { parse(text), format(record) }`（既定は今の JSON）。bash: `lock_obs_owner` の欄の取り出しを `lock_parse_owner_text <text>`、`:1416` と `lock_publish_group` の `printf` を `lock_format_owner <pid> <token> <acquiredAt> [<pgid>]` に切り出す（振る舞いは同じ）。run-lock の読み込み口がこの 2 関数を上書きする |
| **D2 パスで渡す** | machine-lock は `<root>/<name>` からパスを作る | 取得・回収・解放に**ロックのパス**を渡す口を足す。札の列は `${lock%.lock}.queue`（`.lock` で終われば外す。既定の `commandmate-run.lock` なら `<tmpdir>/commandmate-run.queue` で、名前で作るときと同じ）。退避は `<lock>.gone-*`、一覧するのは `<lock>` の親（今の `lock_gone_candidates` のまま） | sync: オプション `lockPath`（あれば `root`・`name` より優先）。bash: `lock_acquire_path <lock> <queue> <budget>` を足し、`lock_acquire <name> <budget>` はそれを呼ぶだけにする |
| **D3 owner の無いディレクトリの 60 秒** | machine-lock は回収しない。run-lock・supervisor.lock は 60 秒より古ければ取る（固定する試験 2 本） | オプション `ownerlessGraceMs`（run-lock・supervisor.lock は 60000、既定は無し）。**先頭だけ**が、`settleGone` の後で `<lock>` の owner が missing・中が空・mtime がこの値より古いとき、`rmdir <lock>`（空でなければ失敗する。失敗は不明か「誰かが書いた」で、取らずに周回をやり直す）→ 通常の `mkdir`。年齢は ms（sync: `statSync().mtimeMs`、bash: `stat -f %m`／`stat -c %Y` の秒 ×1000 と `lock_now_ms`）で比べ、`find -mmin` を使わない（事前レビュー P2-5: GNU find は分に丸める）。あわせて **owner の最初の書き込みを排他作成にする**（sync・TS: `flag: 'wx'`、bash: `set -C` の下の `>`）。`EEXIST` は「取れなかった、何も消さない」。それ以外の失敗は、自分が作った owner（open が通ったとき）だけを消し、`<lock>` は `rmdir`（空のときだけ）で戻す。書いた後に owner を読み直し、token が自分でなければ取れなかったことにする（`/dev/null` への symlink の穴を読み直しで塞ぐ） | sync・bash（取得の `claim`）。TS の `claim :617-652` も `'wx'` にそろえる（3 実装の claim の規則を 1 つに保つ。既存の利用者では owner は自分の `mkdir` の直後で無いので振る舞いは同じ） |
| **D4 pid の引渡し（`run_lock_set_pid`）** | 今の `set_pid` は token を変えずに pid だけ上書きする。回収者が「`up` のシェルの pid の記録」を読んで判定し、シェルが終わった後に退かすと、退かした記録の token が同じなので**生きたサーバーのロックを消す**（#4288 の 1 番 §2.2 と同じ形） | **同じ取得の中の別の状態遷移「引渡し」を足す**（改訂 2 で D9 の形にした）。持ち主（`up` のシェル、生きている）だけが呼ぶ。サーバーは D9 の受け渡しで**自分のグループ G の長**として起こし、合図を待たせておく。`LOCK_PENDING_TOKEN=T1` を先に立て（#4288 の 1 番 §2.6 と同じ順）、owner を 1 回読み、token が T0 の記録なら、`pid=<G の長＝サーバー>`・`pgid=<G>`・**token `T1=<T0>-g<G>`**（`lock_publish_group` と同じ名付け）の記録を `<lock>/.owner-<T1>` に書き、`mv` で `owner` を置き換え、読み直して T1・pid・pgid を確かめる。読みが T0 でない・missing・不明なら何もせず失敗。失敗したら合図を出さない（サーバーは起動しない）で失敗の trap へ（D12 の「公開を試みた後」の経路）。成功したら合図 → サーバーが受け取りの印を作って exec。新しい T1 は呼び手に返し、`run-server.sh` が状態ファイルに `lock_token` として書く（書けなくても T1 は在るので、trap は `LOCK_PENDING_TOKEN` で T1 を知る） | sync: handle に `handOff(pid, pgid)`。bash: `lock_hand_off <lock> <T0> <pid> <pgid>`（`LHO_TOKEN` に T1）。`run_lock_set_pid` はこれを呼ぶ |
| **D5 持ち主でない者の解放** | `down`・`up` の失敗の trap はサーバーを止めた後に token を読んで消す。止めた後は持ち主が死んでいるので、読みと削除の間に先頭が回収して取りうる（事前レビュー P1-2） | **札を取り、先頭になってから解放する**操作を足す（予算 10 秒）。先頭である間は、新しい実装の誰も `mkdir`・回収・`rmdir` をしないので、読みと削除の間に後継が入らない。先頭で owner を 1 回読み、token が渡された token のどれか（T0 か T1）で、記録の判定（pid と、`pgid=` があれば G。§1.6 の D9）が `gone` なら `rm -rf <lock>`（G に人が残っている・不明なら消さない＝`release-deferred`。`down` が止め損ねたサーバーのロックを外さない）、missing なら自分の token の退避だけを片付ける（`cleanupOwnGone` と同じ）、他の token・壊れた・不明は何もしない。札は全ての経路で `done`。予算のうちに先頭になれなければ何もしない（持ち主は死んでいるので、次の取得者の先頭が回収する） | sync: `releaseAsHead(lockPath, tokens, options)`。bash: `lock_release_as_head <lock> <queue> <budget> <token>…`。`run-server.sh` の `down` と、`up` の失敗の trap の引渡しの後の枝が使う |
| **D6 取得しない回収者（`deadline-guard.sh`）** | 回収は取得の途中にしかない | **回収だけの操作**を足す。札を取り、先頭になったら `settleGone` → owner を 1 回読み、死んでいれば `breakStale`（退かして確かめ、違えば戻す）、owner が無く空で `ownerlessGraceMs` より古ければ `rmdir`。**`mkdir` はしない**。札は全ての経路で `done`。終状態は「消した」「残した（生きている・不明・予算のうちに先頭になれない）」「退避を残した（戻しの失敗。`restore-failed`）」の 3 つで、ガードの exit code には効かせない（今どおり） | sync: `recoverIfDead(lockPath, options)`（今の利用者は無いが、3 実装の規則をそろえるために置く）。bash: `lock_recover_only <lock> <queue> <budget>` |
| **D7 supervisor.lock の `lstart`** | machine-lock の判定は pid（と pgid）だけ。pid が再利用されると生きている扱いになり、ガードが回収できない（安全側だが、翌朝の supervisor が `busy` になる） | owner に `lstart=` がある記録に限り、pid が生きていて `ps -o lstart=`（`LC_ALL=C`）が読め、記録と**違う**なら死んだと読む。読めなければ不明（取らない）。生きた持ち主の `lstart` は記録と同じなので、生きた保有者のロックを誰も外さない規則（#4277 §2.4 の 3）は崩れない | bash だけ（supervisor.lock は bash だけが触る）。TS・sync には足さない。**改訂 2**: 判定は canonical と退避（`.gone-*`）で同じ関数を通す。今の `lock_settle_gone` は `lock_holder_state` を直に呼ぶ（`verify-run.sh:1269`）ので、包みが退避に届かない（`.gone-*` の同じ pid・違う `lstart` を生きていると読み、戻してその回の取得を断る）。PR1a で `:1269` を `lock_record_state`（同じ `LOB_*` を渡すだけ。振る舞いは同じ）に替え、codec が 1 回の読みから `LOB_LSTART` も取り（記録ごとに空へ戻す）、D7 は `lock_record_state` を包む（`lstart=` のある記録だけに効くので、`scripts/lib/machine-lock.sh` の読み込みで常に入れてよい）。`lock_ticket_retirable`（`:1035`）の `lock_record_gone` は札の判定で、札に `lstart` は無いので替えない |
| **D9 実作業のプロセスグループ（改訂 2、PM の決定）** | owner の pid は取得したシェル（UAT の `up`・`daily.sh`）。守りたいのはその子（UAT のサーバー、daily の子の `run.ts`）で、`up` はサーバーを起こしてから pid を引き渡す（`run-server.sh:470-473`）。親だけが SIGKILL で死ぬと、子が動いたまま記録の pid が死に、次の先頭が正当に回収する（codex-2 `review-4288g.md` の新 P1-1。`daily.sh:92` で取り `:141` で子を起こす daily も同じ） | **#4288 の 1 番（`verify-lock-holder-group-4288.md` §2.1 の案 E）と同じ形を当てる。新しい仕組みは作らない**: (1) 子を `set -m` で自分のグループ G の長として起こし、合図（`go`）を見て受け取りの印（`ack`）を作るまで exec させない（同 §2.4。親の死・期限で取り下げる）。(2) `ps -o pgid=` で G＝子の pid を確かめる（確かめられなければ子を始めない。同 §2.3 の `group`）。(3) owner に `pgid=G` を**新しい token** `T1=<T0>-g<G>` で公開し、読み直す（D4）。(4) 合図。回収の判定は machine-lock に既にある `holderState`／`lock_holder_state`（pid が ESRCH **かつ** G が ESRCH のときだけ死）なので、親の死だけでは回収されず、G が空になってから回収される。解放（D5・D12）も G が空でなければ消さない（`lock_release` の `:1518` と同じ確かめ）。記録の pid は「普段解放する者」に合わせる: **UAT は G の長（サーバー）**（解放は `down`＝持ち主でない者なので D5。旧い読み手は今と同じくサーバーの pid を見る）、**daily は `daily.sh` 自身**（解放は `daily.sh` の EXIT＝持ち主自身なので D12 の自己解放。旧い読み手は今と同じく daily の pid を見る）。daily の子は `CM_RUN_LOCK_TOKEN` を exec の直前に `<T0>-g$$`（G の長の `sh -c` の `$$`＝G）にして継承（D8）する。子を別のグループにすると、`daily.sh` のグループへ送られた INT・TERM（launchd の停止など）が子に届かなくなるので、`daily.sh` の INT・TERM の trap は G へ TERM → 猶予 → KILL（`lock_drain_group` と同じ順）を送ってから解放する（今は同じグループで一緒に受けていた。振る舞いを今に合わせる）。`up` のサーバーは今も `nohup … &` で `up` の後も残る前提なので、この扱いは要らない | bash: 子の待ち `lock_child_wait <go> <ack> <deadline> <parent-pid>` を節の中に足し、今の `lock_handoff_wait`（`:1830`、節の外）はそれを `$LOCK_SELF_PID` で呼ぶ 1 行にする（振る舞いは同じ。観測点の名前 `handoff-self`・`handoff-go`・`handoff-ack` は変えない）。`run-server.sh` の `up` のサーバーの起動（`:459-473`）と `daily.sh` の子（`:141`）をこの形に。TS（`main.ts` の直の起動）は持ち主のプロセス自身が作業するので足さない |
| **D10 TS の観測を 3 値で渡す（改訂 2、PM の決定）** | `run-lock.ts` の `defaultIsAlive`（`:62-70`）は EPERM を生、**それ以外の失敗を全て死**にする。これを sync の `hooks.pidAlive`（boolean。`makeObserver` の `probe` は false を `gone` にする、`machine-lock-sync.mjs:138`）へ渡すと、ESRCH でない失敗（EIO 等）で生きた owner・札を回収しうる（新 P1-2） | **本番の観測は ESRCH だけを死にする**: `run-lock.ts` は既定で `pidAlive`・`groupAlive` を渡さず、machine-lock の `probe`（`process.kill(pid, 0)` の ESRCH → gone、成功 → alive、EPERM・その他 → unknown）をそのまま使う。`defaultIsAlive` は消す。注入は `AcquireRunLockOptions` に `signal0?: (target: number) => void`（`process.kill(target, 0)` と同じく投げる）を足し、sync の `hooks.kill` に渡す（`probe` の中で `process.kill` の代わりに呼ぶ。分類は本番と同じ式を通る）。既存の `isAlive?: (pid) => boolean` は試験の互換のため残し（`run-lock-3359.test.ts:73`・`:77`）、渡されたときだけ `hooks.pidAlive` にする（呼び手が「死んだ」と明示する注入）。`main.ts:226` は `isAlive` を渡さない（事実）ので本番は 3 値。不明は「取らない・回収しない・継承しない」（D8 の継承も `alive` のときだけ） | sync: `makeObserver` に `hooks.kill`（既定 `process.kill`）。`run-lock.ts` |
| **D11 時計（改訂 2）** | 既存の API は `now?: () => Date`（`run-lock.ts:52`）、sync は数の ms（`deadline = startedAt + timeoutMs`、`machine-lock-sync.mjs:705-706`、`t >= deadline` `:837`）。Date をそのまま渡すと `deadline` が文字列の連結になり、`t >= deadline` が常に偽で予算 0 の終わりが来ない（`sleep(NaN)` の周回）。札の `createdAt`・`deadline` も ISO 文字列で書かれ、他者の期限の判定が崩れる（新 P2-3） | `run-lock.ts` が `hooks.now = () => (options.now ?? (() => new Date()))().getTime()` と**数に直して**渡す（札の pid の再利用の判定 `processStartMs(pid, now())`〔`:696`〕も数を前提にする）。owner の `started_at=`（ISO）は codec の `format` が数の `acquiredAt` から作る。owner の無い `<lock>` の年齢（D3）は `now() − statSync().mtimeMs`（どちらも ms） | `run-lock.ts` だけ（sync の契約は今の数のまま） |
| **D12 bash の自己解放（改訂 2）** | §1.5 の「解放（持ち主自身）」の行のとおり、`lock_release` は missing・壊れた記録で canonical を消し、1 回きりの制御も無い。D4 の `mv` の後で読み直し・状態ファイルの書き込みが失敗すると、T1 が在るのに呼び手は「引渡しの前」と思って T0 で解放する（新 P2-4） | run-lock・supervisor.lock の自己解放は `lock_release` を使わず、読み込み口に**`lock_release_held <lock> <token>…`** を置く: (1) 保持の印（`LOCK_HELD_PATH`／`LOCK_HELD_TOKEN`、引渡しを試みた後は `LOCK_PENDING_TOKEN` も）が無ければ何もしない（**1 回きり**: 呼んだら最初に印を消す）。(2) owner を 1 回読む。`unknown` → 消さない（`release-deferred`）。`missing`・`corrupt` → **canonical を消さない**（他者の `mkdir` の直後・書き途中の owner でありうる）。自分の token の退避だけを片付ける（`lock_release_own_gone`）。(3) token が渡された token のどれか（T0、公開を試みた後は T1 も）の記録は、**§1.14 の「D12 の不変条件」に従う**（直接消すのは記録の pid が呼び手自身で、記録に `pgid=` があればその G が空のときだけ。G に人が居れば `deferred`、それ以外の pid は `needs-head` で D5 へ。同期 JS の handle の `release` も同じ表）。(4) 他の token → 退避の片付けだけ。**公開を試みた後**（`LOCK_PENDING_TOKEN` が立った後）の失敗の経路は、まず子のグループを KILL して空にし（同 §2.3 の後始末）、**UAT は D5**（記録の pid はサーバー＝持ち主でない者の解放）、**daily は (1)〜(4)**（記録の pid は daily 自身で生きている） | 読み込み口 `scripts/lib/machine-lock.sh`。`verify-run.sh` の `lock_release` は変えない（本文に無い指摘として §8 に記録） |
| **D8 継承（`CM_RUN_LOCK_TOKEN`）** | machine-lock に無い | run-lock の包みの中で、取得の前に owner を 1 回読み、token が環境変数と同じで判定が「生きている」なら `inherited`（解放しない）。owner が missing なら、退避（`.gone-*`）のうち token が同じで生きた記録も継承と読む（回収者が戻すまでの短い窓で、子の `run.ts` が断られないように） | `run-lock.ts`・`run-lock.sh` の包み（machine-lock には足さない） |

文面（足すだけ）: 取得の失敗は今の文面のまま（TS `別の実行がロックを持っている: <dir>（pid N, <label>, <時刻>[, <run dir>]）`、bash `another run holds <dir> (…)`。`run-server-3359.test.ts:410`・`:426` が固定）。持ち主が札・退避・不明のときは括弧の中を `（列の先頭: pid N）`・`（退避中: <gone>）`・`（不明: <point> <errno>）` にする（新しい枝）。回収の行は bash の `run-lock: took over a stale lock (pid N, label L)`（`run-server-3359.test.ts:421` が固定）を、machine-lock の回収の知らせを関数 `lock_note_recovered <lock> <pid>`（既定は今の `verify-run: broke a stale lock …` の 1 行）に切り出して run-lock の読み込み口で上書きして出す。

### 1.7 共通化の形

**bash: `verify-run.sh` のロックの節を、そのまま読み込む。**

- 新しいファイル `scripts/lib/machine-lock.sh`（読み込み口）。中身は「このリポジトリの `.claude/skills/cmate-verify/scripts/verify-run.sh` から `# --- machine-wide gate lock` の行から `# --- gate execution` の前までを切り出して `eval` する」関数 `machine_lock_load` と、run-lock・supervisor.lock 用の codec（D1）・`lock_note_recovered`（文面）・D7 の包み・D12 の `lock_release_held`。切り出しは試験が今使っているものと同じ（`lock-4288-harness.ts:25`）。印の行が 1 つずつ無ければ読み込みを失敗にする（取得の失敗として扱い、取らない）。**2 度読まれても 1 回だけ読み込む**（`MACHINE_LOCK_LOADED` の印。`lib.sh` が `run-lock.sh` とこのファイルの両方を source する経路があるため。§7 の PR1b・PR1c の依存）
- `scripts/uat/run-lock.sh` は `machine_lock_load` の後に、今の関数名（`run_lock_dir`・`run_lock_acquire`・`run_lock_set_pid`・`run_lock_release`・`run_lock_holder`・`run_lock_pid_alive`・`run_lock_field`）を machine-lock の関数の上の薄い包みとして定義する。`run_lock_field`（欄ごとの読み）は表示（`run_lock_holder`）だけに残し、判定には使わない。`lib.sh` は今どおり `run-lock.sh` を source する（`run_lock_field` の表示・`run_lock_pid_alive` の runner の生存の確かめ `lib.sh:76` に使う。ロックの判定には使わない）のに加えて、**`scripts/lib/machine-lock.sh` を直に source して** `product_lock_*` を machine-lock の包みにする（改訂 2。`run-lock.sh` 経由で読むと、`run-lock.sh` の載せ替え〔PR1b〕が入るまで関数が届かない。§7）
- `verify-run.sh` に入れる手直し（振る舞いを変えない）: `lock_parse_owner_text`・`lock_format_owner`（D1）、`lock_acquire_path`（D2）、`lock_note_recovered`（文面）、D3・D4・D5・D6 の関数、D7 のための `lock_settle_gone` の判定の呼び出しの差し替え（`:1269`、同じ引数）、D9 の子の待ち `lock_child_wait`（`lock_handoff_wait` はそれを呼ぶ 1 行に）。`.agents/skills/cmate-verify/scripts/verify-run.sh` はバイト一致（`tests/unit/skills/cmate-verify/dual-placement.test.ts`）。`.claude/skills/sync-map.json` の pin を計算し直し、rationale に 1 文。skills リポジトリ（`commandmate-skills`）の `verify-run.sh` はバイト一致を保つ運用（sync-map の rationale、#314・#315 の前例）なので、**port の PR が別に要る**（オーケストレーターが追う。それまで skills の写しは新しい関数を持たないが、足すのは既定で働かない関数なので、skills の写しの振る舞いは今と同じ）
- 1 つのシェルが持つ machine-lock は 1 つ（節の大域変数 `LOCK_PATH`・`LOCK_TOKEN`・`LOCK_TICKET`・`LOCK_HELD_*` が 1 組）。今の呼び手も 1 つずつ（`daily.sh`＝run-lock、`run-server.sh` の `up`／`cleanup`＝run-lock、`supervisor.sh`＝supervisor.lock、`deadline-guard.sh`＝supervisor.lock の回収だけ）。2 つ持つ呼び手が増えないことを試験で見る
- `daily.sh` は `git pull`（`:110`）の**前**に `run-lock.sh` を source する（`:90`）。読み込みは source の時点の写しで関数を定義するので、pull で `verify-run.sh` が変わっても、その実行の中の関数は一貫する

採らなかった形:

| 形 | 採らない理由 |
|---|---|
| ロックの節を skill の別ファイル（`.claude/skills/cmate-verify/scripts/machine-lock.sh`）へ移し、`verify-run.sh` もそれを source する | `verify-run.sh` は 1 ファイルで導入先に置かれる前提がある。節を動かすと #4288 の 1 番の試験（`lock-4288-harness.ts` の切り出し、`lock-observation-points-4288.test.ts` の走査、invariants）が読むファイルが変わり、それらの試験を全部書き換えることになる |
| 節の写しを `scripts/lib/` に置き、バイト一致を試験で見る | 写しが 1 つ増える。読み込み口が実体を読む形で足りる（取る価値のある差が無い）。読み込み口が使えない事情が実装で見つかったときの代案として残す |

**TS: `run-lock.ts` は同期の写し `machine-lock-sync.mjs` の関数を使う。**

- `acquireRunLock` の形（同期・`RunLockResult`・`label`／`env`／`pid`／`token`／`isAlive`／`now`）は変えない。中で `acquireMachineLockSync(…, { lockPath, timeoutMs: 0, ownerCodec: kv, ownerlessGraceMs: 60_000, token, ownerPid, hooks: { now: () => clock().getTime(), kill: signal0, ...(isAlive ? { pidAlive: isAlive } : {}) } })` を呼び（改訂 2: 時計は数の ms に直す〔D11〕、観測は既定で machine-lock の 3 値の `probe` をそのまま使い、`isAlive` は試験が渡したときだけ〔D10〕）、`release` は返る handle の `release`。継承（D8）は包みで先に見る
- `machine-lock.ts`（非同期）を使わない理由: `acquireRunLock` は同期で、既存の試験（`run-lock-3359.test.ts:57-123`）が同期で呼ぶ。非同期にすると期待を変えることになる。同期 JS は 3 実装の 1 つで同じ規則（#4277 §2.6、§8.1 の不変条件の表）なので、規約の上では同じものに載る
- `src/` から `scripts/orchestrate/*.mjs` を import する前例は src には無い（`git grep` で 0 件）。試験には有る（`lock-4288-harness.ts:11`）。`tsconfig.json` は `allowJs: true`（`:5`）。`run-lock.ts` を import するのは `scripts/agent-health/main.ts:51` だけで、`tsconfig.server.json`・`tsconfig.cli.json` の対象に入らない（事実）。**未確認**: ESLint の規則が `src/` からの `scripts/` の import を拒むか（実装の契約で `npm run lint` で確かめる。拒むなら、同期 JS を `src/lib/verification/` に移さずに、`run-lock.ts` を `scripts/agent-health/` 側の薄い包みから呼ぶ形に替える）
- `machine-lock-sync.mjs` に足すオプション・操作: `lockPath`・`ownerCodec`・`ownerlessGraceMs`・`token`・`ownerPid`（owner に書く pid。札の pid は今どおり `process.pid`）、`hooks.kill`（D10。`makeObserver` の `probe` が `process.kill` の代わりに呼ぶ）、handle の `handOff(pid, pgid)`、関数 `releaseAsHead`・`recoverIfDead`

### 1.8 操作と状態遷移（全経路）

| 経路 | 操作 | 成功の終状態 | 失敗・中断の終状態 |
|---|---|---|---|
| `main.ts` の取得（`:226`） | `acquireRunLock`（予算 0） | owner＝自分、札は `done` | 断る（`ok:false`、文面は今のまま）。札は `done` |
| `main.ts` の通常の解放・signal | handle の `release`（持ち主自身。S1） | `<lock>` が無い | signal・`kill -9` で解放されない → 持ち主の pid が死んだロックとして次の先頭が回収 |
| `daily.sh` の取得（`:92`）・EXIT（`:97`） | `run_lock_acquire`・D12 `lock_release_held`（持ち主自身。T0、公開の後は T1） | 同上 | 取れなければ `fail_sync`（今のまま）。EXIT で札も `done`。子のグループ G が空でなければ消さない（`release-deferred`。G が空になった後に次の先頭が回収） |
| `daily.sh` の子 `run.ts` の起動（`:141`、改訂 2） | D9: 子を G の長として起こして待たせ → `lock_hand_off`（pid＝`daily.sh`、`pgid=G`、T1）→ 合図 | owner＝T1（pid＝daily、G）。子は `CM_RUN_LOCK_TOKEN=T1` で exec | 公開・合図の失敗 → 子を KILL して G を空にし、D12 で T0／T1 を解放して `fail_sync`（子は始めない） |
| `daily.sh` の子 `run.ts` | 継承（D8） | `inherited`、解放しない | 記録の判定（daily の pid と G）が `gone`・`unknown` なら継承しない（`gone` は通常の取得へ、`unknown` は断る） |
| `daily.sh` だけが SIGKILL（改訂 2） | — | owner（T1、G）が残り、子が G に居る間は誰も回収しない（pid が ESRCH でも G が生きている）。子が終わって G が空になったら次の先頭が回収 | 継承の前（公開の前）に死んだら子は取り下げて始めない（D9 の (1)） |
| UAT `up` の取得（`run-server.sh:412`） | `run_lock_acquire`（pid＝`up` のシェル、token T0＝`run_id`） | owner＝T0 | 断る（`exit 1`、今のまま） |
| UAT `up` のサーバーの起動と引渡し（`:459-473`、改訂 2） | D9: サーバーを G の長として起こして待たせ → `ps` で G を確かめ → `run_lock_set_pid`＝D4（`LOCK_PENDING_TOKEN=T1` を先に立てる）→ 合図 → サーバーが `ack` を作って exec | owner＝T1（pid＝サーバー＝G の長、`pgid=G`）、状態ファイルに `lock_token=T1` | 失敗（G を確かめられない・読みが T0 でない・missing・不明・書き込み・`mv`・読み直し・合図の失敗）は合図を出さずに `exit 1` → 失敗の trap。サーバーは exec しない |
| UAT `up` の失敗の trap（`:358-378`） | `LOCK_PENDING_TOKEN` が立つ前: 持ち主自身の解放（D12、T0）。立った後（`mv` の成否・読み直しの成否によらない）: G を KILL して空にし（サーバーを止めた後）、D5 `release_as_head`（T0・T1） | `<lock>` が無い | サーバー（G）を空にできなければ今どおりロックを残す（`failed-server-left`。D5 も G が空でなければ消さない） |
| UAT `up` だけが SIGKILL（改訂 2） | — | 公開の前: サーバーは合図を待ったまま取り下げて exec しない → owner（T0、pid＝`up`、pgid 無し）は次の先頭が回収。公開の途中・後: owner（T1、G）が残り、G に人が居る間は誰も回収しない。サーバーが終わって G が空になったら次の先頭が回収 | 保証から外すもの: tmux の keepalive（`:454`、`tmux new-session -d` は自分のセッションへ移る）。今と同じく `down`・`cleanup` が止める |
| UAT `down`（`:534`） | D5 `release_as_head`（状態ファイルの `lock_token`、無ければ `run_id`。両方を渡す）。サーバーの停止は今どおり pid の確かめ（`run-server.sh:113-131` の `CM_DB_PATH`・listen の照合）の後で pid に送り、**同じ確かめを通ったときに限り** G の残りも `lock_drain_group`（`verify-run.sh:1530`）と同じ順で空にする（確かめを通らなければ何も送らず、ロックも残す） | `<lock>` が無い | 先頭になれない・不明・G が空でない → 残す（持ち主は死ぬか、G が空になった時点で次の先頭が回収）。exit code は今のまま |
| UAT `cleanup`（`:564-574`） | 取得・持ち主自身の解放 | — | 断る（今のまま） |
| supervisor の取得（`supervisor.sh:78`）・EXIT（`:82`） | `product_lock_acquire`（codec＋`lstart`＋60 秒）・`product_lock_release`（持ち主自身） | owner＝自分 → EXIT で消える | 断る（exit 75 と `busy:` の文面は今のまま）。札は `done` |
| `deadline-guard.sh` の判定・回収（`:85-88`） | D6 `product_lock_recover_only` | 死んだ持ち主のロックが消える／生きていれば残る | 先頭になれない・不明 → 残す。途中で死んだら、退避は先頭が §2.7 で片付け、札は ESRCH で外れる |

守る条件（machine-lock から受け継ぐ。§1.13 の P1-1 への答え）: **異なる token の保有期間は重ならない**。理由: (1) `mkdir`・回収・空の `<lock>` の `rmdir` をするのは生きた札の先頭 1 人だけ（#4277 §2.3）。(2) 生きた持ち主のロックは誰も動かさない（回収の条件は pid が ESRCH ＋ pgid のグループが ESRCH ＋ supervisor は `lstart` の不一致）。(3) 回収は退かしてから token を確かめ、違えば戻す。退かしている間、回収者は先頭なので第三者の `mkdir` は無い。戻せなければ退避の記録が死ぬまで先頭は取らない。(4) 解放は持ち主自身なら S1、持ち主でない者は先頭になってから（D5）。(5) owner の最初の書き込みは排他作成で、取ったと言えるのは読み直しで自分の token を見たときだけ（D3）。(6) 保護する実作業（UAT のサーバー・daily の子）は、owner に G が公開されて合図が出るまで始まらず、始まった後は G が空になるまで記録は死なない（D9。#4288 の 1 番 §2.2 の「token と記録の中身が 1 対 1」「死亡は単調」がそのまま成り立つ: T0 は pgid 無し、T1 は pgid:G で、同じ token で中身が変わらない）。

前提（見立て。#4277 §2.4 と同じ）: 先頭のプロセスが 2 つの syscall の間で、札の期限の猶予（同じ host で 60 秒）より長く止められない。run-lock・supervisor.lock は全員が予算 0 なので、札の期限＝取得の開始で、先頭が開始から 60 秒より長く止まると次の者がその札を外して先頭になりうる。この前提を超える停止は本書も保証しない（machine-lock と同じ範囲）。

事前レビュー P1-1 の反例を新しい形に当てると: A が死んだ X を読んで止まる（A は先頭）→ B・C は A の札が生きているので先頭になれず、予算 0 で断る（`列の先頭: pid A`）。A が 60 秒以内に戻れば、A だけが回収と取得をする。B が先頭になれるのは A の札が外れた後（A の死、または 60 秒の超過）だけで、そのとき A は前提の外に居る。

### 1.9 新旧の混在（読み手・取得者 × ロックの形）

形: (a) 旧い形の生きた owner（`key=value`、`host=` 無し）、(b) 旧い形の死んだ owner、(c) 旧版が退かした `<lock>.stale.*`（生きた記録が残っていることがある＝§1.2 の B）、(d) 新しい形の生きた owner（`key=value`＋`host=`）、(e) 新しい形の死んだ owner、(f) 戻せなかった退避 `<lock>.gone-*`（生きた記録）、(g) 札の列 `.queue/`、(h) owner の無い `<lock>`。

| 読み手・取得者 | (a) | (b) | (c) | (d) | (e) | (f) | (g) | (h) |
|---|---|---|---|---|---|---|---|---|
| 新しい取得者（bash・TS） | 生きている → 断る | 先頭が回収 | 読まない（形が違う）。生きた B の記録は守れない（旧版が作った状態。本書では直せない） | 断る | 先頭が回収 | 先頭は保有中と読む | 札の順 | 60 秒まで断る、その後は先頭が `rmdir`→取得 |
| 新しい継承（`run.ts`） | token が同じで生きていれば継承（デプロイの日の `daily.sh`） | 継承しない | — | 同じ | 継承しない | token が同じで生きていれば継承 | — | 継承しない |
| 新しい解放（D5・持ち主自身） | 自分の token なら消す（旧い `up` → 新しい `down`） | 同じ | — | 同じ | 同じ | 自分の token の退避だけを片付ける | 札を `done` | 消さない |
| 新しいガード（D6） | 生きている → 残す | 回収 | 読まない | 残す | 回収 | §2.7 で片付け・戻し | 札の順 | 60 秒より古ければ `rmdir` |
| **旧い取得者**（旧い `run-lock.sh`・`run-lock.ts`・`lib.sh`） | 断る | 退かして回収（旧い穴） | — | **pid の行が読めるので断る**（D1 で `key=value` を保つ理由） | 退かして回収（旧い穴。新しい先頭の回収と競うと §1.2 の形が残る） | **見えない → `mkdir` する**（2 者が持ちうる） | 見えない（札を抜かす） | 60 秒の後に取る（`mv -f` の上書き） |
| 旧い解放（旧い `down`） | 自分の token なら消す | 同じ | — | 新しい `up` の T1 とは token が違うので消さない（安全側。死んだロックとして次が回収） | 同じ | 見えない | 見えない | token が読めないので消さない |

`pgid=` の行（D9、改訂 2）は旧い読み手には見えない。記録の pid を「普段解放する者」に合わせた（UAT はサーバー、daily は `daily.sh`）ので、旧い取得者・旧い解放が見る pid は今と同じで、旧い読み手に対して今より弱くはならない（`up`・`daily.sh` だけが死んだときに旧い取得者が子の動いている間に取るのは今と同じ穴で、旧版が動く間は残る）。

保証の範囲（#4277 §2.4 と同じ狭め方）: **旧い取得者が動いている間は、排他は「死んだ持ち主のロック・戻せなかった退避・owner の無い `<lock>` が無いとき」に限る**。旧い形の静止した owner（(a)(b)）との互換と、旧いアルゴリズムが動く混在の期間は別で、後者は次の切替で終わらせる。

切替の範囲（見立てと手順。実稼働の混在は**未確認**）:

| 取得者 | 旧版が動く期間 | 終わらせ方 |
|---|---|---|
| `daily.sh`（`agent-health-runner` の worktree） | マージの翌朝の 1 回（旧い `run-lock.sh` を source した後に pull して新しい `run.ts` を起こす。`run.ts` は (a) を継承できる） | 何もしない。翌々朝から新しい |
| UAT の `run-server.sh`（各 worktree のチェックアウトのスクリプトを使う。`run-server.sh:59-61`） | マージより前に分岐した worktree が残る限り、後日も | UAT を起こす worktree はマージの後の develop を取り込んでから起こす（PR1b の受入で `docs/orchestrate/` の UAT の手順に 1 行足すかを PM に伺う）。実装の契約で、残っている worktree の `scripts/uat/run-lock.sh` が新旧どちらかを数える |
| supervisor・ガード（専用ユーザーのチェックアウト、launchd） | そのチェックアウトの同期の前の朝 | 同じチェックアウトの `lib.sh` を両方が source するので、同期の後は一緒に新しくなる |
| skills の `verify-run.sh` | port の PR まで | 足すのは既定で働かない関数だけで、既存の札・回収の規約は同じなので、混在の影響は無い（run-lock・supervisor.lock は skills の写しを読まない） |

### 1.10 テストの設計

新しい試験の台: `tests/unit/lib/agent-health/run-lock-profiles-4288.ts`（新規）。`lock-4288-harness.ts` の `take(impl, root, name, o)` と同じ戻り値（`TakeResult`）の `takeProfile(profile, lockPath, o)` を出す。profile は `run-lock-bash`（`run-lock.sh`）・`run-lock-ts`（`run-lock.ts`）・`supervisor-bash`（`lib.sh`）の 3 つと、陽性の対照・混在の相手に使う**凍結した旧版**（`tests/unit/lib/agent-health/fixtures/` に今の `run-lock.ts`・`run-lock.sh`・`lib.sh` のロックの関数を写して置く。製品のファイルではない）。割込みは machine-lock の既存の口を使う（bash: `CM_VERIFY_TEST_HANDOFF=pause:<stage>`・`CM_VERIFY_TEST_OBS_FAULT`。sync: `hooks.onRecover`・`hooks.fault`・`hooks.beforeLink`）。足す口は D3〜D6 の段の pause（`owner-create`・`owner-written`・`hand-off-tmp`・`release-head-read`・`recover-only-judged`・`recover-only-moved`）と、D9 の子の起動の段（`verify-run.sh` の受け渡しと同じ名前 `forked`・`group`・`tmp`・`published`・`signalled`・`acked`）、D3 の後始末の失敗の注入（`fault:owner-write`〔open の後の書き込み〕・`fault:owner-unlink`・`fault:lock-rmdir`）だけ。TS の観測の注入は D10 の `signal0`、時計は D11 の `now`（Date）で、どちらも**`acquireRunLock` の入口から**渡す。旧版の割込みは §1.2 の `renameSync` の spy と `mv` の shim。

| 流用する既存の対照（場所） | 新しい試験での形（引数化） |
|---|---|
| 2 者・多者の同時: `run-server-3359.test.ts:389-410`（8 者）、`product-supervisor-3312.test.ts:629`（8 者） | 3 profile × 8 者、と **混合**（bash 4 者＋TS 4 者、supervisor 対 ガード）。各者が `acquired <token> <t>`／`released <token> <t>` を 1 行ずつ書き、**異なる token の保有区間が重ならない**ことを判定する（解放の後の正当な取り直しは許す） |
| 3 者の割込み（§1.2 の再現。A の退避の直前に B、直後に C） | 新しい 3 profile で取れるのは 1 者だけ。**陽性**: 凍結した旧版で B・C の 2 者（§1.2 で確認済み） |
| 先頭だけが回収する: `machine-lock-fifo-4277.test.ts:170`、回収の窓（bash の `mkdir` を退避の前後に差す）: `machine-lock-invariants-4277.test.ts:414-450` | `describe.each(PROFILES)`。回収者の `before-move`／`moved`／`restore-mkdir` で止め、もう 1 者の取得を差す → 断られる。再開の後に保有者は 1 者 |
| token の違う記録は戻す: `machine-lock-fifo-4277.test.ts:179` | 引渡し（D4）の後の回収: 回収者が T0（`up` のシェル）を読んで止まる → シェルが終わる → 再開 → 退かした記録は T1 なので戻す。サーバー（生きた子）が持ったまま |
| 停止した公開者（事前レビュー P1-1 の反例の順） | A を `moved` で止め、B・C を予算 0 で差す → 断られる。A の札を生かしたまま 59 秒（TS は `acquireRunLock` の `now: () => Date`、D11）では B は先頭にならない。61 秒で先頭になるのは前提の外として、そのときの振る舞いは固定しない（§1.8 の前提） |
| 解放は 1 回きり・他者のロックを動かさない: `machine-lock-fifo-4277.test.ts:125-157`（S1） | 持ち主自身の解放に同じ形。**D5**: `down` の `release-head-read` で止め、サーバーの pid を殺し、別の取得者を差す → 断られる（`列の先頭: pid down`）。再開 → `<lock>` が消え、取得者がその後に取れる。**陽性**: 今の `run_lock_release` で同じ順にすると後継のロックが消える |
| 取り戻しの失敗の後始末: `machine-lock-gone-4288.test.ts:268-311`（途中の戻しの完了・回収）、`:183`（戻しの失敗を注入） | 3 profile で同じ表の行（A・C と「別の生きた owner を消さない」）。退避の記録は `key=value` |
| 公開の失敗（事前レビュー P1-3。**改訂 2 で前提を分けた**）: `lock-review-fixes-4288.test.ts:260-287`（owner の書き込みの失敗で `<lock>` を戻す） | 前提の違う 2 つに分ける（M の札が生きている間は N は先頭になれず `rmdir` できないので、旧い 1 本の筋書きは成り立たない）。**(a) 全 API の試験**（3 profile）: M を `owner-create` で止め、`<lock>` の mtime を 61 秒前にし、N を予算 0 で差す → N は**断られる**（`列の先頭: pid M`）、`<lock>` は残る。M を再開 → M が取れる。**(b) 排他の公開と後始末の単体**（札を通さず、claim の関数を直に。sync の `claim`・bash の owner の公開の関数）: `owner` を先に置いた状態で M の公開 → `EEXIST` で取れず、置いた owner が残る。注入: `owner-create` の `ENOSPC`・`EACCES`、open の後の書き込みの失敗（部分書込み）、自分の owner の削除の失敗、`rmdir` の失敗 → どれも**取得の成功にならず**、自分が open した owner と空の `<lock>` の外は消さない。owner の削除か `rmdir` に失敗したら `<lock>` が残る（`owner-write-failed …(and it could not be taken out again)`、今の `verify-run.sh:1425-1430` と同じ終状態。誰も回収しない＝2 者は持たない側）。後継の owner を置いた後で M の後始末を走らせても後継が残る。**陽性**: 今の `run-lock.sh:127`・`lib.sh:179` の `rm -rf "$dir"` の形では (b) で置いた owner が消える |
| owner の 1 回の読み: `lock-review-fixes-4288.test.ts:74-105` | `key=value` の記録で、欄の読みの 2 回目だけを失敗させる注入（bash）→ 不明として取らない。owner と退避の併存・token の違う 2 つの退避・壊れた記録（`token` 無し）・`host=` の無い旧い記録 |
| 3 値の観測の注入: `lock-observation-points-4288.test.ts:461-483`（READER_ROWS） | 同じ行を 3 profile で（不明は取らない・消さない・解放しない）。D3〜D7・D9・D12 で増える観測点（D7 の `ps -o lstart=` を含む）は #4288 の 1 番の §2.8 の表に足す（走査の試験は表と突き合わせるので、表を直せば期待は変わらない） |
| 旧版の混在: `machine-lock-invariants-4277.test.ts:369-370`（札を知らない取得者） | §1.9 の表の各列を、凍結した旧版と新しい profile の組で 1 本ずつ。(d) で旧い取得者が断ること（D1 を外して JSON にすると奪う＝陽性） |
| 年齢の境界（事前レビュー P2-5） | owner の無い `<lock>` を 59 秒前・61 秒前にして、bash と TS が同じ答え（取らない・取る）。`run-lock-3359.test.ts:82`・`product-supervisor-3312.test.ts:603` は期待のまま通る |
| 排他の公開（事前レビュー P2-8） | `owner` が既にある通常ファイル・ディレクトリ・ディレクトリへの symlink・`/dev/null` への symlink・親の権限不足 → どれも取れず、何も消さない（`/dev/null` は読み直しで落ちる） |
| 取得しない回収者（D6） | 死んだ → 消える・生きている → 残る・`lstart` の違う再利用 → 消える・supervisor が先頭のとき → ガードは残して終わる・ガードを `recover-only-moved` で `kill -9` → 次の supervisor が退避を片付けて取る（判定後・`mv` の前の差替えは、`recover-only-moved` の後の停止とは別の対照として、判定の後に止める口 `recover-only-judged` で生きた新しいロックに差し替え → 退かした記録の token が違うので戻す、を置く） |
| `set_pid`（事前レビュー P2-4） | 通常の引渡し・退避の前後（回収者の `moved` の前／後に引渡し）・引渡しの途中の回収（`hand-off-tmp` で止める）・後継の token への引渡しの拒否 |
| **D9 親だけの死（改訂 2、新 P1-1）** | 実プロセスで（UAT は偽のサーバー〔`sleep` を exec する小さな sh〕、daily は偽の子）。**公開の前**（`forked`・`group` で止め、親を `kill -9`）→ 子は取り下げて exec しない（`ack` が無い）。別の取得者はその後に取れる。**公開の途中**（`tmp`・`published` で止めて親を `kill -9`）→ 子は exec しないで終わる。G に待ちの子が居る間は別の取得者が断られ、G が空になったら取れる。**公開の後**（`acked` の後で親を `kill -9`、子は動き続ける）→ 別の取得者は**断られる**（記録の pid は ESRCH だが G が生きている。UAT は記録の pid がサーバーなので pid も生きている）。子を終わらせると取れる。daily の**継承の後**（子の `run.ts` の役が `inherited` を返した後で `daily.sh` を `kill -9`）も同じ。**陽性**: 今の `run-server.sh:470-473`（起動してから `set_pid`）で、`set_pid` の前に `up` を `kill -9` → サーバーが動いたまま別の取得者が取れる。今の `daily.sh` で継承の後に `daily.sh` を `kill -9` → 子が動いたまま取れる。**陰性**: 親が生きている通常の経路の取得・引渡し・解放は今と同じ文面・終状態 |
| **D10 TS の観測（改訂 2、新 P1-2）** | `acquireRunLock` の入口から `signal0` で注入: 成功 → 断る。`ESRCH` → 回収して取る。`EPERM`・`EIO`（その他）→ **断る・回収しない**（owner は残り、`.gone-*` を作らない。文面は `（不明: <point> <errno>）`）。継承（D8）でも `EPERM`・`EIO` は継承しない。札の判定（`ticketRetirable`）も同じ `signal0` を通ることを、他者の札を置いて確かめる。**陽性**: 凍結した旧版（`defaultIsAlive`）に `process.kill` の spy で `EIO` を投げる → 死と読んで取る（machine-lock の注入口だけでは見えない変換の誤り）。**陰性**: `isAlive: () => true / false` を渡す既存の 2 本（`run-lock-3359.test.ts:73`・`:77`）は期待のまま |
| **D11 時計（改訂 2、新 P2-3）** | `acquireRunLock` に `now: () => Date` を渡す: busy（生きた持ち主）なら**待たずに戻る**（実時間で 1 秒未満、sleep を呼ばない）。書かれた札の `createdAt`・`deadline` と owner の `acquiredAt` が数であること。owner の無い `<lock>` の 59 秒は取らない・61 秒は取る（`run-lock-3359.test.ts:85-86` の 120 秒は期待のまま）。**陽性**: Date をそのまま `hooks.now` に渡す形では `deadline` が文字列になり、予算 0 で戻らない（試験は周回の上限で打ち切って見る） |
| **D12 自己解放（改訂 2、新 P2-4）** | 通常の解放（消える）・**二重解放**（2 回目は何もしない。間に別の取得者が `mkdir` だけした `<lock>`〔owner missing〕を消さない）・**別 token**（消さない）・**missing**（canonical を消さない、自分の退避だけ片付ける）・**corrupt**（token の無い記録を消さない）・**公開の後の読み直しの失敗**（`fault` で `hand-off` の読み直しを `EIO` にする → T1 が在っても trap は `LOCK_PENDING_TOKEN` で T1 を知り、UAT は G を空にして D5 で消す、daily は D12 で消す）・G に人が居る（消さない）。**陽性**: `verify-run.sh` の `lock_release` をそのまま使うと、missing・corrupt で他者の `<lock>` が消える |
| **D7 の退避（改訂 2、新 P2-5）** | `.gone-*` に「同じ pid（生きている `sleep`）・違う `lstart`」の記録を置く → ガード（D6）と次の supervisor が**1 回で**片付けて取る（回収できる）。同じ `lstart` → 残す（生きている）。`ps` の失敗（`PATH` の shim）→ 不明として残す。canonical にも同じ 3 本。**陽性**: `lock_settle_gone` が `lock_holder_state` を直に呼ぶ今の形では、違う `lstart` の退避を生きていると読んで戻し、その回の取得を断る |

既存の試験の期待: `machine-lock*.test.ts`・`lock-*-4288.test.ts`・`gate-mutex*.test.ts`・`precheck-heavy-3884.test.ts`・`merge-pr-queue-4277.test.ts`・`run-lock-3359.test.ts`・`run-server-3359.test.ts` は**変えない**。`product-supervisor-3312.test.ts` は期待を変えないが、`:647` の 1 本だけ**割込みの口**が変わる: 今は `ps` の stub が pid 999999 の判定の中で入れ替えるが、新しい判定は pid を `kill -0` で見て死んでいれば `ps` を呼ばない（D7 の `lstart` は pid が生きているときだけ）ので、stub が働かず「入れ替えが起きた」の確かめ（`:683`）が落ちる。同じ筋書き（判定と退かしの間に生きた新しいロックが入る）を `pause:recover-only-judged` の口（判定の後・`mv` の前。改訂 2 で `recover-only-moved` から替えた: `mv` の後の停止は「退かした後の差替え」で、同じ筋書きにならない）で作るよう書き換える必要がある（it の名前・`token=new` が残る期待は同じ）。**この 1 本の書き換えは PM の決定が要る**（下の「決めてほしいこと」）。`:687-693` の「ディレクトリが消える」は新しい形でも成り立つ（列の `supervisor.queue/` は残るが、試験は `<lock>` だけを見る）。

### 1.11 書くファイル（§6 の PR1a〜PR1c）

- PR1a（machine-lock の足し算）: `scripts/orchestrate/machine-lock-sync.mjs`、`src/lib/verification/machine-lock.ts`（owner の排他作成だけ）、`.claude/skills/cmate-verify/scripts/verify-run.sh` と `.agents` の写し、`.claude/skills/sync-map.json`、`scripts/lib/machine-lock.sh`（新規）、`docs/design/verification-config.md` §9.2（オプションと操作の行）、`docs/design/verify-lock-holder-group-4288.md` §2.8（観測点の行）、試験 `tests/unit/verification/machine-lock-options-4288.test.ts`（新規）。skills の port は別の PR
- PR1b（run-lock）: `src/lib/agent-health/run-lock.ts`（D10・D11 を含む）、`scripts/uat/run-lock.sh`、`scripts/uat/run-server.sh`（D9 のサーバーの起動、`lock_token` と D5、失敗の trap の D12）、`scripts/agent-health/daily.sh`（改訂 2: D9 の子の起動と D12 の EXIT）、試験の台と試験（新規）と凍結した旧版
- PR1c（supervisor.lock）: `scripts/agent-health/product/lib.sh`（`scripts/lib/machine-lock.sh` を直に source）、`scripts/agent-health/product/deadline-guard.sh`、試験（新規）、`product-supervisor-3312.test.ts:647` の割込みの口（PM の決定の後）

### 1.12 対になる場所

- `supervisor.sh` は関数名が変わらないので書かない。`daily.sh` は改訂 2 で書く（D9 の子の起動。`run_lock_*` の関数名は変わらない）。`daily.sh:14-18` の説明は今のままで正しい
- 改訂 2 で探した対（D10 の 2 値の観測の写し）: `src/lib/agent-health/claude3-reservation.ts:108` の `defaultIsAlive`（同じ形: EPERM を生、他の失敗を死）・`scripts/agent-health/metrics.ts:72` の `isAlive`（失敗を全て死）・bash の `run_lock_pid_alive`（`run-lock.sh:75-83`。`lib.sh:76` の runner の確かめと `run-server.sh` のサーバーの停止の待ちが使う）。どれも run-lock の判定ではない（予約・メトリクスのロック・停止の待ち）ので本書では変えない（§8 に記録）。D9 の対（親が子を起こしてからロックを渡す形）は `run-server.sh` の `up` と `daily.sh` の 2 つだけ（`run_lock_set_pid` の呼び手は `:473` だけ、`CM_RUN_LOCK_TOKEN` を作るのは `daily.sh:91` だけで、読むのは子の `main.ts`（`run-lock.ts`）と、子の下で呼ばれうる bash の `run_lock_acquire`（`run-lock.sh:131`）。どちらも子が exec の前に T1 にした値を継ぐ。`git grep` で確かめた）
- `docs/user-guide/agent-health.md:323-327`（「持ち主の pid が死んでいるロックは取り直す」）は新しい形でも正しい。`docs/module-reference.md:378` の「死んだ持ち主は退避して取り直す」は実装の契約の断片で「machine-lock の札と回収に載せた」に直す
- `.commandmate/uat.yaml:36` の「`mkdir` lock (scripts/uat/run-lock.sh)」は今も正しい（`mkdir` のロックのまま）
- `src/lib/agent-health/claude3-reservation.ts:12` の「unlike run-lock's rename」は、run-lock が rename で回収しなくなった後は古い説明になる（PR1b で 1 語直す。予約の動きには関係しない）
- 探して無かったもの: `run_lock_*`・`product_lock_*`・`acquireRunLock` の他の呼び手（`git grep` で §1.1・§1.5 の場所だけ）。`docs/en` に agent-health・run-lock の写しは無い。`src/cli/types/` にロックの型の写しは無い

### 1.13 事前レビュー（`review-4288f.md`、codex-2）と再確認（`review-4288g.md`、codex-2）の処置

上の 9 行（P1-1〜P2-9）は第 2 版の処置。再確認（`review-4288g.md`）の判定は「解消 5・一部解消 4」で、一部解消の 4 件の残りは新しい指摘と同じ中身なので、その行で処置した（P1-2 → g-P2-4、P2-4 → g-P1-1、P2-5 → g-P1-2・g-P2-3・g-P2-5、P2-9 → g-P2-6）。改訂 2 の行は `g-` を付ける。PM の決定は `pm-return-4288-design-rev1.md` の (a)（改訂 2 を 1 回。この後の再確認で寿命の系統の P1 がまだ出たら (b)〔PR1 を TS と supervisor.lock に絞り、UAT の `up`／`down` は追跡〕に切り替える前に PM に返す）。

| # | 指摘 | 処置 | 理由と、入れた場所 |
|---|---|---|---|
| P1-1 | 2C の規則だけでは、owner 不在を確かめて止まった公開者と退避中の回収者の間で B と C が同時に取れる | 採る（2C をやめ、machine-lock に載せる） | 取得・回収・`rmdir` を札の先頭 1 人に限る規則で、保有期間の全体を守る（§1.8 の守る条件と反例の当てはめ）。前提（60 秒を超える停止）は #4277 §2.4 と同じ範囲として明記。試験は保有区間の重なりで判定（§1.10） |
| P1-2 | token の確認の後の `rm -rf` が、`down` の間に入った新しい保有者を消す | 採る | 持ち主自身の解放は S1 のまま、持ち主でない者（`down`・引渡しの後の失敗の trap）の解放は札の先頭になってから行う（D5、§1.8）。対照: 自己解放・他 token・継承・`down` の割込み（§1.10） |
| P1-3 | 公開の失敗の後始末（`rm -rf "$dir"`）が他者のロックを消す | 採る | owner の最初の書き込みを排他作成にし、`EEXIST` では何も消さない。それ以外の失敗は自分が作った owner と空の `<lock>` だけを戻す。成功は読み直しで自分の token を見たときだけ（D3）。`link` 非対応・権限不足・I/O の失敗を取得の成功にしない。対照は注入と M・N の割込み（§1.10） |
| P2-4 | `run_lock_set_pid` の更新規則が両立しない | 採る | 取得・同じ取得の中の引渡し・解放を別の状態遷移にし、引渡しは新しい token T1 で tmp→`mv`→読み直し（D4、§1.8）。`down` は T0・T1 の両方を渡す。対照: 通常・退避の前後・引渡し中の回収・後継の token への引渡しの拒否 |
| P2-5 | 「同じ持ち主」の読みが未定義（欄ごとの別々の読み、`lstart`、境界） | 採る | 判定は owner の 1 回の読みのテキストから（D1。bash は `lock_obs_owner` の 1 回の `cat`）。不在・死亡・読めないは 3 値（machine-lock §2.8）。supervisor の `lstart` は D7 で残す。年齢は ms で比べ `find -mmin` をやめる（D3）。対照: 併存・複数 token・壊れた記録・59／61 秒 |
| P2-6 | supervisor.lock に「取得しない回収者」の設計が要る | 採る | 回収だけの操作（D6）と、取得・EXIT・ガードの終状態（§1.8）。既存の `:647` の割込みの口は書き換えが要り、PM の決定に回す（§1.10） |
| P2-7 | 旧版との混在は「デプロイの瞬間」に限らない | 採る | 読み手 × 形の表（§1.9）。保証は「死んだ持ち主・戻せなかった退避・owner の無い `<lock>` が無いとき」に狭め、切替の範囲（UAT の worktree が後日も旧版）を書いた。旧い形の静止した owner の互換と、旧いアルゴリズムが動く期間を分けた |
| P2-8 | bash の `ln` は `owner` がディレクトリ・symlink なら中へ作って成功する | 採る（2C の `ln` の公開をやめた） | 実測で確かめた（§1.4）。owner の公開は `wx`／`set -C`＋読み直し（D3）。対照: 既存のファイル・ディレクトリ・symlink・`/dev/null`・権限不足（§1.10）。札の `ln`（#4277）は宛先が「最大の番号＋1」で、ディレクトリができる経路が無いので変えない（本文に無い指摘として記録） |
| P2-9 | 陽性の試験案だけでは安全性を判定できない | 採る | 読み・判定・rename・`mkdir`・`rmdir`・戻し・削除の各段の前後で止める対照を、machine-lock の既存の筋書きの引数化で置き、異なる token の保有区間が重ならないことで判定する。TS 対 bash の混合、supervisor 対ガード、回収者の途中の死を足した（§1.10） |
| g-P1-1（改訂 2。第 2 版の P2-4 の残り） | 親（UAT の `up`・`daily.sh`）だけが死ぬと、動いている子（サーバー・`run.ts`）がロックの保護から外れる | 採る（PM の決定: #4288 の 1 番と同じ形） | 子を自分のグループ G の長として起こし、合図まで exec させず、owner に `pgid=G` を新しい token T1 で公開してから合図する（D9・D4）。判定は machine-lock に既にある `holderState`／`lock_holder_state`（pid と G の両方が ESRCH で死）で、新しい仕組みは作らない。解放も G が空でなければ消さない（D5・D12）。記録の pid は普段解放する者（UAT はサーバー、daily は `daily.sh`）で、旧い読み手が見る pid は今と同じ（§1.9）。対照: 公開の前・途中・後と daily の継承の後に親だけを `kill -9`、子が動く間は断られ、子が終わった後は取れる。陽性は今の起動してから `set_pid` の形（§1.10 の D9 の行）。§1.8 の UAT・daily の行、守る条件 (6) |
| g-P1-2（改訂 2。第 2 版の P2-5 の残り） | TS の boolean の観測をそのまま渡すと、EPERM 以外の失敗が死になる | 採る（PM の決定） | `run-lock.ts` は既定で `pidAlive` を渡さず、machine-lock の 3 値の `probe` を使う（ESRCH だけが死、EPERM・その他は不明＝取らない・回収しない・継承しない）。注入は入口の `signal0` から sync の `hooks.kill` へ（分類は本番と同じ式）。`defaultIsAlive` は消す（D10）。対照は `acquireRunLock` の入口から成功・ESRCH・EPERM・EIO、陽性は凍結した旧版に EIO（§1.10 の D10 の行）。同じ 2 値の写し 3 つは run-lock の判定でないので §8 に記録 |
| g-P2-3（改訂 2。第 2 版の P2-5 の残り） | TS の時計の契約（`() => Date` と数の ms）が合わない | 採る | `run-lock.ts` が `now().getTime()` に直して渡す。札の `createdAt`・`deadline`・owner の `acquiredAt` は数、owner の `started_at=` は codec が作る（D11）。対照: Date の時計で busy なら待たずに戻る、札の時刻が数、59 秒・61 秒（§1.10 の D11 の行） |
| g-P2-4（改訂 2。第 2 版の P1-2 の残り） | bash の自己解放（`lock_release`）は missing・corrupt で canonical を消し、1 回きりでもない。公開の後の読み直しの失敗で呼び手が引渡しの前と取り違える | 採る | run-lock・supervisor.lock は `lock_release` を使わず `lock_release_held` を置く（1 回きり、missing・corrupt・unknown・他 token では canonical を消さない、G が空でなければ消さない）。公開を試みた後は `LOCK_PENDING_TOKEN`（`mv` の前に立てる）で T1 を知り、UAT は G を空にして D5、daily は自己解放（D12、§1.8 の trap の行）。対照: 二重解放・別 token・missing・corrupt・公開の後の読み直しの失敗・通常（§1.10 の D12 の行）。`verify-run.sh` の `lock_release` 自体は変えず §8 に記録 |
| g-P2-5（改訂 2。第 2 版の P2-5 の残り） | D7 の `lstart` の判定が退避済みの owner に届かない（`lock_settle_gone` が `lock_holder_state` を直に呼ぶ） | 採る | `lock_settle_gone` の判定を `lock_record_state` に替え（同じ引数、振る舞いは同じ）、D7 は `lock_record_state` を包む。canonical と退避が同じ判定を通る（D7 の行）。対照: `.gone-*` の同じ pid・違う `lstart` → ガードと次の supervisor が 1 回で回収、同じ `lstart` → 残す、`ps` の失敗 → 不明で残す。観測点の表に D7 を足す（§1.10） |
| g-P2-6（改訂 2。第 2 版の P2-9 の残り） | 公開の失敗の競合の試験は、M の札が生きている前提では成り立たない。後始末の失敗の注入が足りない。ガードの `moved` の後の停止は「判定の後・`mv` の前」の差替えと同じ対照ではない | 採る | 全 API の試験（N は断られる）と、排他の公開・後始末の単体（札を通さない）に前提を分けた。注入に open の後の部分書込み・owner の削除の失敗・`rmdir` の失敗を足し、取得の成功にならず後継の owner を消さないことを見る。ガードは判定の後の口 `recover-only-judged` を足し、`product-supervisor-3312.test.ts:647` の書き換えもその口にした（§1.10） |
| g-P2-7（改訂 2） | PR1c を PR1b と独立にする読み込みの経路が無い（`lib.sh` は `run-lock.sh` 経由で読む） | 採る | `lib.sh` は `scripts/lib/machine-lock.sh` を直に source し（`run-lock.sh` の source は表示と runner の確かめのために残す）、読み込み口は 2 度読まれても 1 回だけ読む（§1.7）。PR1c は PR1a だけに依存し、PR1a＋PR1c（旧い `run-lock.sh` のまま）の組合せで supervisor の取得・EXIT・ガードの回収だけの経路を試験で通す（§6・§7） |

決めてほしいこと（PM へ）:

1. `product-supervisor-3312.test.ts:647` の割込みの口の書き換え（期待は同じ、口だけ）を PR1c で行ってよいか
2. UAT を起こす worktree に develop を取り込んでから起こす、の手順を `docs/orchestrate/` に足すか（§1.9。足さないなら、混在の間の保証の狭まりを受け入れる）
3. PR を 3 本（PR1a → PR1b ∥ PR1c）に分けるか（§7）。skills の port の PR を PR1a の後に起こすこと

### 1.14 PR1a の実装（実装の契約で追記）

PR1a（§6・§7）で machine-lock の 3 実装と読み込み口 `scripts/lib/machine-lock.sh` に入れたもの・設計からの差・操作の終状態。試験は `tests/unit/verification/machine-lock-options-4288.test.ts`（新規）と、観測点の表（`verify-lock-holder-group-4288.md` §2.8）の 4 行。

**入れたもの**: 同期 JS の `lockPath`（D2）・`ownerCodec`（D1）・`ownerlessGraceMs`（D3）・`token`・`ownerPid`・`hooks.kill`（D10）、handle の `handOff(pid, pgid)`（D4）、`releaseAsHead`（D5）・`recoverIfDead`（D6）。TS は owner の排他作成と読み直しだけ（D3）。bash（`verify-run.sh` の節）は `lock_acquire_path`（D2。`lock_acquire` はそれを呼ぶ 1 行）・`lock_parse_owner_text`／`lock_format_owner`（D1）・`LOCK_WANT_TOKEN`／`LOCK_OWNER_PID`・`LOCK_OWNERLESS_GRACE_MS` と `lock_expire_ownerless`（D3）・`lock_obs_create`（D3 の排他作成）・`lock_hand_off`（D4。`lock_publish_group` はそれを `$$` で呼ぶ）・`lock_release_as_head`（D5）・`lock_recover_only`（D6）・`lock_settle_gone` の判定を `lock_record_state` へ（D7）・`lock_child_wait`（D9。`lock_handoff_wait` はそれを `$LOCK_SELF_PID` で呼ぶ 1 行）・`lock_note_recovered`（文面）。読み込み口は 2 度読まれても 1 回、kv の codec（`machine_lock_use_kv_codec`）、D7 の `lstart` の包み、D12 の `lock_release_held`、`machine_lock_queue_of`。

**設計からの差（理由つき）**:

- **bash の codec（D1）**: 既定の JSON は今のまま `lock_obs_owner` の中で読む。#4288 の 1 番の試験が、観測の内側の段（欄の取り出し 4 つと pgid の検査）が `lock_obs_owner` にあることを走査と変異で固定している（`lock-extract-rmdir-4288.test.ts` の自己テスト・`lock-review-fixes-4288.test.ts` の変異）ので、取り出しを別の関数へ移さなかった。codec は `LOCK_OWNER_CODEC` が空でないときだけ `lock_parse_owner_text` を通る（同じ 1 回の読み。0／1＝不明 EUNKNOWN／2＝不明 EINVAL）。既定の `lock_parse_owner_text` は 1（使われない）
- **bash の排他作成（D3）**: `lock_obs_create`（観測の関数）を owner の `printf` の pipeline の最後に置き、終了コードで答える（0 取れた・3 EEXIST・6 他の記録を読み直した・10+i 開けなかった・40+i 開いて書けなかった・70+i 読み直しが不明。i は errno の番号）。既存の陽性の対照（`lock-review-fixes-4288.test.ts` が `if ! lock_test_fault owner && printf` を `if lock_test_fault owner || printf` に替える）が、owner の書き込みが if の条件の 1 つの `printf …` であることを前提にしているため。読み直しは `lock_obs_create` の中（観測点 `owner-readback`）。`/dev/null` への symlink は `set -C` が書かせるが、読み直しが空（壊れた記録）なので 6 で落ちる（§1.4 の実測どおり）
- **止め所の名前**: bash の引渡しの tmp の止め所・注入は既存の `tmp`（`lock_hand_off` はゲートの公開と共有。名前を変えると #4288 の 1 番の試験が変わる）。同期 JS は `hooks.onRecover('hand-off-tmp')`・`fault('handoff-tmp')`。`recover-only-moved` は既存の `recover-moved`（`lock_recover` の中）を使い、`recover-only-judged`・`release-head-read` を足した。D3 の後始末の注入は bash が `CM_VERIFY_TEST_HANDOFF=fault:owner-write|owner-unlink|lock-rmdir`、同期 JS・TS が `fault` の点 `owner-write`・`owner-unlink`・`lock-rmdir`、作成と読み直しは観測点 `owner-create`・`owner-readback`
- **D12 に pid の確かめを足した**: `lock_release_held` の (3) は下の「D12 の不変条件」に従う（PR1a-b で pid の生死を見る形にし、PR1a-c で「呼び手自身の pid だけ」に絞った）。保有者が死んだ記録は、読みと削除の間に先頭が回収して取りうる（P1-2 の形）ため。これで review-4288h の P3（pending の後・`mv` の前の失敗で T0 が残る）は「T0 の記録の pid は `up` 自身で生きているので、持ち主自身として消える」に揃った（下の表）
- **P2-1（停止の猶予）**: `KILL_GRACE_SEC=5` を節の中へ移した（節の外の定義は消した。値は同じ）。読み込み口は節の外の設定を要しない。節が読む大域変数（`LOCK_PATH`・`LOCK_TOKEN`・`LOCK_WAITED`・`LOCK_HELD_BY`）も節の中で空に初期化した（`set -u` の下で取得の前に操作を呼べる）
- **同期 JS の `release`**: `handOff` で公開した T1 の記録は、G が空になってから消す（`'deferred'` を返し、もう一度呼べる）。それ以外の経路は今のまま 1 回きり。戻り値を `'released' | 'deferred' | 'needs-head' | 'kept' | 'none'` にした（今の呼び手は戻り値を見ない）
- **同期 JS の `release` も D12 と同じ規則（PR1a-b、PM レビュー A P2-1・codex P2。PR1a-c で不変条件に書き直した）**: 下の「D12 の不変条件」の表に従う。PR1a は G だけを見て消していたので、owner を読んでから消すまでの間に先頭が回収して取った後継のロックを消しえた（A の再現。`lock-pr1a-review-fixes-4288.test.ts` の陽性の対照）
- **`recoverIfDead` の不明（PR1a-b、codex P3）**: 退避の整理（`settleGone`）の観測が不明だったとき、その `unknown` を戻り値に残す（後の答えが `absent` でも落とさない）。bash の `LRO_UNKNOWN`（`lock_note_unknown` は最初の 1 つを残す）と同じく最初の不明を返す
- **読み込み口は `set -e` の下で読み込まない（PR1a-b、A P3-2・B P3-1）**: 節は `set -u` だけを前提にし、観測と操作は非 0 の終了コードと失敗するコマンド置換で答えるので、errexit の下では取得・回収の途中で呼び手のシェルが黙って終わる。`$-` に `e` があれば読み込みを失敗（return 1、文面つき）にし、ヘッダに書いた。読み込んだ後に `set -e` にしないことも呼び手の規約
- **D7 の観測点 `lstart`**: 読み込み口だけにあるので §2.8 の表（3 実装のソースの走査と突き合わせる）の行にはせず、§2.8 の注記と注入（`CM_VERIFY_TEST_OBS_FAULT=lstart=<ERRNO>`）の試験で固定した
- **held by の表示**: `lock_owner_field`（表示）は JSON のまま。kv の記録の表示は PR1b の `run_lock_holder`（文面は §1.6 の末尾）

**D12 の不変条件（PR1a-c、codex-2 `review-4288-pr1ab.md` P2-1・P2-2、PM の処分 `pm-return-4288-pr1a-b.md`）**: 持ち主自身の解放（bash の `lock_release_held`、同期 JS の handle の `release`、TS の handle の `release`）がロックを**直接消してよいのは、記録の pid が呼び手自身で、かつ記録に `pgid` があればそのグループ G が空のときだけ**。それ以外は消さない。個別の分岐（引渡しの後か・初期の `ownerPid`／`LOCK_OWNER_PID` か・pid が生きているか）はこの表の行に過ぎない。

- 「呼び手自身」: 同期 JS・TS は `process.pid`、bash は `$$`（読み込み口を source したシェル。サブシェルの中で呼んでも `$$` は同じ）
- **bash の自己は main シェル（`BASH_SUBSHELL=0`）かつ `$$` が生きているとき**（PR1a-e で狭めた。消す側から消さない側へ。サブシェルからの解放は常に `needs-head` で、`$$` の確認の後に親が死ぬ窓・pid の再利用・親とサブシェルの二重解放をまとめて塞ぐ。今の呼び手と PR1b の予定の呼び手は main シェルから呼ぶ。試験 5 の窓の再現）。PR1a-d の「`$$` が生きていること」: サブシェルの `$$` は親のもので、親が死んで子のサブシェルだけが残ると `$$` は死んだ pid。記録の pid が `$$` でも `kill -0 $$` が alive でなければ自己と見なさず、(c) の `needs-head` へ進む（先頭が回収して T2 を取った後の解放が T2 を消さない）。試験: `lock-release-invariant-4288.test.ts` の 5
- 順: (a) G（記録に `pgid` があるとき）が空でない・空と示せない（EPERM など）→ `deferred`。(b) pid が呼び手自身 → 直接消す（`released`）。(c) それ以外の pid は、生きていても死んでいても `needs-head`（消さない。1 回きり）。呼び手は D5（`releaseAsHead`／`lock_release_as_head`）で、先頭として保護したうえで token と保有者（pid と G）を確かめてから消す。生きていると確かめた pid が削除までに死に、先頭が回収して取った後継（T2）を消す窓（P2-1）は、(c) で消さないことで無くなる。(c) の pid が観測できない（不明）ときは `deferred`（不明は何とも読まない。§2.8、PR1a-b の表の期待のまま）
- 例外は 1 つ: 記録の pid と `pgid` が**どちらも呼び手自身**（呼び手が自分のグループの長。merge-pr の `pgid: process.pid`）のときは G を判定しない。呼び手は定義上 G に居るので G は空にならず、判定すると自分では二度と解放できない（merge-pr の列は同じプロセスで次の取得へ進む）。この pgid は「呼び手が死んだ後も子が動く間は回収させない」ための印で、呼び手自身の解放を止めるものではない
- **例外の限界（PR1a-d、codex P2-1、PM の処分 `pm-return-4288-pr1a-c.md`）**: 例外は、解放の前に子をすべて待つ呼び手（今は merge-pr の `spawnSync` だけ）を前提にする。子が残っていても自己グループは判定しないので `released` になり、子はロックの保護から外れる（develop〔814d7cf39〕と a99c76c63 から同じ振る舞いで、今回の退行ではない）。背景の子を残す呼び手は、子を別のグループ G（D9）で持ち、自己グループの例外に頼らない（PR1b・PR1c の契約へ引き継ぐ）。例外を外すと merge-pr の `--queue` は自分のロックを解放できず次の実行が待つ。振る舞いは試験で固定（自己だけ・子が残る・観測不明はいずれも `released`: `lock-release-invariant-4288.test.ts` の 4・6、`merge-pr-queue-4277.test.ts` の「#4288 PR1a-d」）
- 3 実装の表（`tests/unit/verification/lock-release-invariant-4288.test.ts`。行は列挙から作る）: {自己 pid, 非自己 alive, 非自己 dead, 非自己 unknown} × {pgid なし, G 空, G 生存} × {初期取得, 引渡し後}。引渡しは必ず G を名乗るので「pgid なし × 引渡し後」の 4 行は存在せず、**20 行**。bash と同期 JS は 20 行とも同じ結果。TS は `ownerPid`・`pgid`・引渡しを持たず（D9）、書く記録は「自己 pid・pgid なし・初期取得」の 1 行だけ（試験で固定）なので、その行（`released`）だけ

| 記録の pid | G（記録の `pgid`） | 初期取得／引渡し後 | 結果 | D5 を呼んだ後 |
|---|---|---|---|---|
| 呼び手自身 | なし・空 | 両方 | `released`（直接消す） | — |
| 呼び手自身 | 生存（呼び手自身のグループを除く） | 両方 | `deferred` | — |
| 呼び手でない・生きている | なし・空 | 両方 | `needs-head` | `deferred`（保有者が死ぬまで消えない。死んだ後は D5 の再実行か次の先頭が回収） |
| 呼び手でない・死んでいる | なし・空 | 両方 | `needs-head` | `released` |
| 呼び手でない・不明 | なし・空 | 両方 | `deferred` | — |
| 呼び手でない（どれも） | 生存 | 両方 | `deferred` | — |

- **`needs-head` を受けた呼び手の扱い（PM Claude A P3-1。ここに 1 か所で書く）**: 今の呼び手は needs-head を受けない。precheck（`precheck.mjs` の `lock?.release()`）は `ownerPid`・`pgid`・引渡しを使わず記録の pid は自分、merge-pr（`merge-pr.mjs` の `takeMergeLock` → `lock.release()`）は pid も `pgid` も自分（上の例外）、gate-runner（TS）は自分だけ、`verify-run.sh` のゲートは `lock_release`（`LOCK_OWNER_PID` を使わず、`lock_hand_off` も pid は `$$`）。どれも戻り値を見ないが `released` か、G が空でないときの `deferred` だけ。**これから needs-head を受けうる呼び手（PR1b の `acquireRunLock` の `release`〔`ownerPid` に試験の偽の pid やサーバーの pid が入る〕・UAT の `run-server.sh`・PR1c の supervisor.lock）は、受けたら D5 を呼ぶ**（`releaseAsHead(lockPath, [T0, T1])`／`lock_release_as_head <lock> <queue> 10 T0 T1`）。呼ばずに放っておいても止まったままにはならない（記録の pid と G が死んだ後に次の先頭が回収する。PM Claude A の E1）が、pid が生きている間は誰も消さないので、呼び手の規約は「D5 を呼ぶ」に揃える。PR1b・PR1c の契約に引き継ぐ
- **`deferred` を受けた後の再試行も D5（PR1a-d、PM Claude A P3-3）**: `deferred`（保有者が生きている・G が空でない・観測が不明）を受けた呼び手が後で再び解放を試みるときも、`lock_release_held`／`release` を呼び直さず D5（`releaseAsHead`／`lock_release_as_head`）を呼ぶ。直接消してよいのは最初の 1 回だけ

**操作の終状態（review-4288h の P2-3・P3 のうち PR1a の操作で決まる部分。PR1b の `run-server.sh`・`daily.sh` はこれを呼ぶ）**:

| 経路 | owner の記録 | 操作 | 終状態 |
|---|---|---|---|
| 引渡しの前に失敗（`stage=token`: 記録が T0 でない・missing・不明） | 他者・不在・不明 | `lock_release_held <lock> T0` | 他の token・missing・壊れた → `kept`（canonical を消さない。自分の退避だけ片付ける）、不明 → `deferred` |
| `tmp` の書き込みの失敗 | T0（pid＝取得したシェル自身） | `lock_release_held`（T0 と `LOCK_PENDING_TOKEN`＝T1） | `released`（`<lock>` が無い） |
| `mv` の失敗 | T0 | 同上 | `released` |
| `mv` の後の読み直しの失敗 | T1 | daily の形（pid＝`daily.sh` 自身）: G を空にして `lock_release_held` | `released` |
| 同上 | T1 | UAT の形（pid＝サーバー＝G の長）: G を KILL して空にし `lock_release_held` | `needs-head`（消さない）→ `lock_release_as_head <lock> <queue> 10 T0 T1` で `released` |
| G が空にならない | T1 | `lock_release_held` | `deferred`（印は 1 回きりで消える）。G が空になり記録の pid が死んだ後、次の先頭が回収する |
| D5 で先頭になれない | 何でも | `lock_release_as_head` | `not-head`、何もしない（持ち主は死んでいるので次の先頭が回収） |
| UAT の長だけが死に G の子が残る（P2-3） | T1（pid＝死んだ長、G 生存） | `lock_release_as_head`・他者の取得・`lock_recover_only` | 全て消さない・取らない（`deferred`／`refused`／`kept`）。ロックは G が空になるまで保護中で、G が空になれば次の先頭か `down` の再実行が消す。`down` の状態の表示と残った G の止め方は PR1b（UAT の `down`）で決める |

---

## 2. 3 番: `/clear` の後の ready 待ちの 90 秒

### 2.1 今の振る舞い（事実）

`scripts/agent-health/dispatch-main.ts:439-447`:

```ts
for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += READY_POLL_MS) {   // 90_000 / 5_000（:105-106）
  await deps.sleep(READY_POLL_MS);
  if (readState().kind === 'ready') { ready = true; break; }
}
```

- `waited` は `sleep` の合計だけを数え、`readState()`（`:347`、`commandmate ls --json` を `spawnSync`。1 回の上限 300 秒、`:108-116`）の時間を含まない
- `<=` なので回数は 19 回（`sleep` は 95 秒）

再現（事実。`main()` に仮想時計を注入し、`sleep` は時計を ms 進め、`/clear` の後の `ls` は 1 回ごとに時計を進めて常に処理中を返す）:

| 1 回の `ls` | `/clear` から失敗まで | `ls` の回数 | 出る文面 |
|---|---|---|---|
| 0 秒 | **95 秒** | 19 | `/clear の後 90 秒で Claude 3 が入力待ちに戻らなかった` |
| 10 秒 | **285 秒** | 19 | 同上 |
| 300 秒（上限） | **5795 秒** | 19 | 同上 |

見立て: 排他の正しさには関係しない（この間 dispatch は予約を持ったまま。#4243 §1.5 の 5）。困るのは、サーバーが重い朝に dispatch が 1 時間以上止まりうることと、文面の「90 秒」が事実と違うこと。

### 2.2 直すか: 直す

小さく直せ、文面と実際を一致させられる。

### 2.3 案の比較

| 案 | 中身 | 評価 |
|---|---|---|
| 3A 開始時刻からの実時間の期限だけ | `deps.now()` で `/clear` の後の時刻を取り、期限を過ぎたら止める | 1 回の `ls` が長いと、最後の 1 回のぶん（最大 300 秒）超える |
| **3B 3A＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る（採用）** | 期限 `deadline = start + READY_TIMEOUT_MS` は**単調増加の時計**（`deps.monotonic`、既定 `performance.now()`）で数え、記録用の壁時計 `deps.now` と分ける（壁時計が戻っても上限が外れない）。各周回で `sleep(min(READY_POLL_MS, 残り))` → **sleep の後にも**残りを照合し 0 以下なら `ls` へ進まず止める → `ls` は `timeout = max(1, floor(残り))` ミリ秒（残りは 90 秒以下。単調時計の差は小数になり、`spawnSync` は小数の timeout を `ERR_OUT_OF_RANGE` で投げるため整数に切り下げる。`sleep` も同じ）で実行。回数の上限 `READY_TIMEOUT_MS / READY_POLL_MS`（18 回）も残す | 実時間の上限が「90 秒＋1 秒程度」になる。回数の上限は、時計を固定した既存の試験（`tests/unit/scripts/agent-health/dispatch.test.ts:243-249`、`now` が固定）が止まるために要る |
| 3C 直さず文面だけ「19 回」に | — | 不採用。実時間の上限が無いままになる |

`Exec` の型（`dispatch-main.ts:69`）に省略できる第 3 引数 `{ timeoutMs?: number }` を足し、`defaultExec` は `spawnSync` の `timeout` に使う（無ければ今の 300 秒）。既存の試験の stub は第 3 引数を無視するので変わらない。`readState` は ready 待ちの中だけ timeout 付きで呼ぶ（`checkState` など他の `ls` は今のまま）。timeout で切れた `ls` は `status: null` → `judgeAgentState(undefined)` → `unknown` で、ready ではないので待ちを続ける（今の `unknown` の扱いと同じ）。

### 2.4 書くファイル・互換

- `scripts/agent-health/dispatch-main.ts` だけ。記録の形（`dispatch/<日付>.json`）と文面（`/clear の後 90 秒で…`）は変えない。`docs/user-guide/agent-health.md:602` の「90 秒まで」は直した後に事実になるので変えない
- 対になる場所: 同じファイルの cold start の再送（`:420-425`、120 秒の 1 回だけで、ループではない）は対象外。`claude3-reserve-main.ts` に待ちのループは無い（探して無かった）

### 2.5 テストの設計

新しいファイル `tests/unit/scripts/agent-health/dispatch-ready-wait-4288.test.ts`（既存の `dispatch.test.ts` の World の stub を写さず、必要なぶんだけ自前で持つ）。

| 種別 | 中身 | 直しを外すと |
|---|---|---|
| 陽性 | 仮想時計。`/clear` の後の `ls` は 1 回 10 秒かかり常に処理中 → exit 2、文面は今のまま、`/clear` から失敗までの仮想時間 ≤ 90 秒＋1 回の `ls` の timeout | 今は 285 秒（§2.1） |
| 陽性 | 同じく `ls` に渡る timeout が、どの回も「期限までの残り」以下 | 今は第 3 引数が無い |
| 陰性 | 時計を固定（既存と同じ）しても回数の上限で止まり、exit 2・同じ文面 | — |
| 陰性 | 2 回目の `ls` で ready → 依頼を送る（送信の順は `/clear` → 依頼） | — |

既存の `dispatch.test.ts` の期待（`sleeps[0] === 120_000` など）は変えない。

---

## 3. 4 番: claude-3 自身が自分の予約を取れない

### 3.1 今の振る舞い（事実）

- `scripts/agent-health/claude3-reserve-main.ts:303-327` `reserve`: 予約が空きなら `claude3Free()`（`:247-265`）で `commandmate ls --json` の claude-3 の状態を見て、処理中（`busy`）なら **exit 4**
- claude-3 自身が Bash でこのコマンドを実行している間、claude-3 は処理中（自分のターンの途中）なので、**claude-3 が呼ぶと必ず exit 4**（見立て: `judgeAgentState`〔`src/lib/agent-health/dispatch.ts:182-211`〕は `isProcessing` を busy と読む。実機の claude-3 では確かめていない＝未確認。ただし Bash の実行中は Claude Code のスピナーが出ていて、`isProcessing=true` になるのが通常の検出）
- 持ち主の種類は `ReservationHolder = 'pm' | 'dispatch'`（`src/lib/agent-health/claude3-reservation.ts:56`）だけで、claude-3 自身を表す値が無い
- 困る場面（見立て）: 利用者が PM を通さず claude-3 に直接 `/orchestrate` を頼んだ run、または PM の予約が外れた後に claude-3 が自分で続ける run。予約が空きのままだと、ターンの合間の入力待ちに 08:30 の dispatch が `/clear` を送り、run の文脈を消す（#4243 §1.5 の 2 と同じ窓）

### 3.2 直すか: 直す

予約の仕組みの抜け（持ち主が自分を守る経路が無い）で、小さく足せる。

### 3.3 案の比較

| 案 | 中身 | 評価 |
|---|---|---|
| 4A `reserve --no-state-check`（状態確認を省くだけ） | 誰でも省ける | 不採用。PM が claude-3 の busy を無視して予約できてしまい、#4243 の「処理中の claude-3 を予約しない」が崩れる |
| **4B `reserve --self`（採用）** | `commandmate whoami --json` の `worktreeId`／`instanceId`／`cliToolId` が予約の送り先（`RESERVATION_TARGET`、`claude3-reservation.ts:50-54`）と一致するときだけ通す。状態確認（`claude3Free`）は省く（呼び手が claude-3 なので busy なのは自分）。持ち主は新しい値 `leader`、token は `leader-<時刻>-<乱数>` | claude-3 の中からしか通らない。予約が `held` なら今どおり exit 3（dispatch の run の中の claude-3 は自分では取れない＝取る必要が無い） |
| 4C PM が代わりに取る（今の手順のまま。直さない） | — | 不採用。PM を通さない run が守られない |

`whoami` は認証ではない（環境変数で偽れる）。予約の token も秘密ではない（#4243 §3.4）。4B の確認は「PM が誤って `--self` を使う」事故を止めるためのもの（見立て）。判定は dispatch の `judgeAgentState` と同じ 3 つ（worktree・インスタンス・cliTool＝`claude`）で、roster で claude-3 が別の tool のときは取れない（exit 2）。

### 3.4 規則

| 操作 | 通る条件 | 作る世代 |
|---|---|---|
| `reserve --self --label <s> [--hours 1-24]` | whoami が `mycodebranchdesk`／`claude-3`（exit 0 かつ JSON が読める）・予約が `released` | `held`・`holder: 'leader'`・新しい token（標準出力） |
| whoami が別のインスタンス・別の tool（roster で claude-3 が codex 等）・失敗（セッション外の exit 3 を含む） | — | 何も作らず **exit 2**（「--self は claude-3 の中からだけ使える」） |
| `send --token <leader の token>` | — | 今どおり exit 3（`beginSend(…, 'pm')`、`claude3-reservation.ts:477-487`。claude-3 は自分へ送らない） |
| `renew`／`release --token` | token の一致（今のまま） | 今のまま |
| `takeover --reason restart` | `holder: 'pm'` だけ（今のまま） | claude-3 は `/clear` の後も `status` で token を読み `release --token` で外せるので、引継ぎは足さない |
| dispatch | `held` なら今どおり `skipped-busy`。`describeHolder` に `leader` の文面「claude-3 を開発リーダー自身が予約中（<label>、<期限> まで）」を足す | — |

### 3.5 書くファイル・互換

- `src/lib/agent-health/claude3-reservation.ts`（`ReservationHolder` に `'leader'`、`parseGeneration` の `holder` の読み〔`:165`〕、`describeHolder`〔`:234-241`〕）
- `scripts/agent-health/claude3-reserve-main.ts`（`--self` の解析、`whoami` の呼び出し、`RESERVE_USAGE`）
- `docs/orchestrate/team.md` §4（開発リーダーが自分の run を守る手順を 1 項目）、`docs/user-guide/agent-health.md` の「claude-3 の予約」（`leader` の持ち主で dispatch が見送ること）
- 互換: 旧版の読み手は `holder: 'leader'` を `null` と読む（`:165`）。旧版の dispatch は `state === 'held'` で見送る（`dispatch-main.ts:328-344`）ので安全側。旧版の `takeover` は `holder` が `pm`／`dispatch` でないので拒否。旧版の `describeHolder` は「自動依頼（-）の run が予約中」と誤った文面を出す（見立て: dispatch は `agent-health-runner` の worktree で毎朝 develop へ同期するので、混在は長くて 1 日）
- 文面の変更は足すだけ（`describeHolder` の新しい枝）。`git grep -l 'PM が予約中' -- tests/integration tests/e2e` は 0 件（単体の `dispatch.test.ts:360`・`:634` は PM の枝で、変えない）
- 対になる場所: dispatch の取得（`dispatch-main.ts:381-385`、`holder: 'dispatch'`）と `takeoverReservation`（`'pm'` 固定）は変えない。`src/cli/types/` に予約の型の写しは無い（探して無かった）

### 3.6 テストの設計

新しいファイル `tests/unit/scripts/agent-health/claude3-reserve-self-4288.test.ts`（`exec` の stub で `commandmate whoami --json` と `ls --json` に答える。予約の置き場所は `mkdtemp` の一時ディレクトリ）。

| 種別 | 中身 | 直しを外すと |
|---|---|---|
| 陽性 | whoami＝`mycodebranchdesk`／`claude-3`、`ls` は claude-3 が処理中 → `reserve --self --label x` が exit 0、世代は `holder: 'leader'`・`state: 'held'`、標準出力が token | 今は `unknown argument: --self` で exit 2 |
| 陽性 | その後 dispatch の `main()` → `/clear` も依頼も送らず `skipped-busy`、`reason` に「開発リーダー自身が予約中」 | 今は予約が取れていないので送る |
| 陰性 | `--self` 無しの `reserve` は claude-3 が処理中なら今どおり exit 4 | — |
| 陰性 | whoami＝`claude`（PM）／exit 3（セッション外）→ exit 2、世代を作らない | — |
| 陰性 | 予約が dispatch の `held` → `--self` も exit 3 | — |
| 陰性 | leader の token で `send --token` → exit 3、送らない | — |

既存の `claude3-reserve.test.ts`・`claude3-reservation.test.ts` の期待は変えない。

---

## 4. 5 番: 素の `commandmate send` で claude-3 へ送る経路が予約を通らない

> **採らない（PM の決定）。** 以下の案 5C（`.claude/settings.json` の PreToolUse フックと `claude3-send-guard.mjs`）は作らない。理由: リポジトリの共有の設定を足すと、clone した利用者を含む全 Claude セッションに効くため。代わりに `docs/orchestrate/team.md` §4 に、理由と送り方（claude-3 へは `npx tsx scripts/agent-health/claude3-reserve.ts send` だけ）を書く。`dev-team-doc-4239.test.ts` が固定する「未対応（追跡）」の語は残す。以降の 4.2〜4.6 は検討の記録で、実装しない。

### 4.1 今の振る舞い（事実）

- `docs/orchestrate/team.md:47` が「素の `commandmate send … --instance claude-3` は使わない」と手順で書き、`:54` が「PM が素の `commandmate send` を打つことを仕組みで止めるのは未対応（追跡）」と書く
- `src/cli/commands/send.ts` に送り先インスタンスの予約は無い（#4243 §1.3）。予約は `scripts/agent-health/` の中の仕組みで、製品は知らない
- `tests/unit/docs/dev-team-doc-4239.test.ts:26` が team.md の「未対応（追跡）」の語を固定している
- このリポジトリに共有の `.claude/settings.json` は無い（`.claude/settings.local.json` は利用者の global ignore）。CommandMate が起動する claude は `--settings` でフックを足すが、`--setting-sources` を絞るのは UAT の隔離のときだけ（`src/lib/session/claude-executor.ts:407`）なので、通常はプロジェクトの設定も読まれる（見立て。Claude Code の設定の重ね方による。**未確認**: CommandMate が起動した PM のセッションで、プロジェクトの `.claude/settings.json` の PreToolUse フックが実際に効くか）

### 4.2 直すか: 事故の防止だけ直す

PM（Claude）が手順を忘れて素の `send` を打つ事故は、Bash の前のフックで止められる。完全な排他（API・他のエージェント・人の手）は製品に予約を持ち込むことになり、直さない（下の 5A・5B の理由）。

### 4.3 案の比較

| 案 | 中身 | 評価 |
|---|---|---|
| 5A 製品の `send` が予約を読む | `send.ts` か送信 API が `~/.commandmate/agent-health/claude3.reservation` を見て、token の無い送信を断る | 不採用。製品に、このリポジトリの開発体制だけの送り先（`mycodebranchdesk`／`claude-3` の定数）を持ち込む。#4300 の送信経路と重なる |
| 5B 製品に一般の「インスタンスの予約」を作る | DB の表・API・`send --reservation-token` | 不採用。#4243 §2 の B と同じ（migration・再ビルド・製品の表と API を内部の手順のために増やす）。作るなら別の機能の Issue で、#4300 の後 |
| **5C Claude Code の PreToolUse フック（採用）** | リポジトリの `.claude/settings.json` に `matcher: "Bash"` のフックを置き、`node scripts/agent-health/claude3-send-guard.mjs` が `tool_input.command` を見て、`commandmate send` の 1 つのコマンドで送り先が `mycodebranchdesk` かつ `--instance claude-3` なら **exit 2**（stderr に「`npx tsx scripts/agent-health/claude3-reserve.ts send --token <t> "<本文>"` を使う」）で止める | 製品を変えない。PM が Claude である限り、手順の忘れを止める。このリポジトリのどの worktree の Claude にも効くが、claude-3 へ素で送ってよい者はいない（dispatch は `dispatch.ts` の子として `spawn` するので Bash のフックを通らない） |
| 5D 直さない（手順のまま） | — | 不採用。実装が小さく、事故の主な経路（PM の打ち忘れ）を止められる |

### 4.4 案 5C の規則

- 判定は純粋関数 `isRawSendToClaude3(command: string): boolean`（同じ `.mjs` から export）。コマンド文字列を `;`・`&&`・`||`・`|`・改行で区切り、各区切りを簡単なシェルの語に分ける（`'…'`・`"…"` を 1 語）。先頭の `K=V`・`command`・`exec`・`npx`（`--yes`／`-y` を含む）を飛ばした最初の語の basename が `commandmate` で、次の語が `send`、その区切りの語に `mycodebranchdesk` と、`--instance claude-3` か `--instance=claude-3` があるとき真
- 止めないもの: `npx tsx scripts/agent-health/claude3-reserve.ts send …`（最初の語が `npx tsx …`）、本文の引用の中にこれらの語があるもの（引用は 1 語なので `--instance` の語にならない）、他のインスタンス（`claude-2` など）、`respond`／`reply`／`wait`／`capture`
- 止められないもの（`team.md` に「未対応（追跡）」として残す）: 変数・エイリアス・`sh -c "…"` の中、API（`curl`）、Claude 以外のエージェント、人の手。`dev-team-doc-4239.test.ts:26` の語は、この残りの記述として残す（期待を変えない）
- フックのスクリプトが無い・落ちたときは Claude Code が止めない側に倒れる（exit 2 以外は止めない）。毎回の Bash の前に走るので、`npx tsx` ではなく素の `node` の `.mjs` にする（起動の時間）

### 4.5 書くファイル・互換

- 新規 `.claude/settings.json`（`hooks.PreToolUse` の 1 件だけ。`command` は `node "$CLAUDE_PROJECT_DIR"/scripts/agent-health/claude3-send-guard.mjs`）
- 新規 `scripts/agent-health/claude3-send-guard.mjs`
- `docs/orchestrate/team.md` §4 の手順 2 と `:54`（フックで止めること・止められないものは未対応（追跡））
- 互換: リポジトリを clone した他の利用者の Claude にもフックが入る。`mycodebranchdesk`／`claude-3` への `send` 以外は止めないので、他の worktree の作業には影響しない（見立て）。`.agents/`（Codex 側）に写しは作らない（PM は Claude）
- 対になる場所: `.claude/settings.json` は新規で、他のレーンが同じファイルを作るかは**未確認**（#4300・G の書くファイルに `.claude/` は無い）

### 4.6 テストの設計

新しいファイル `tests/unit/scripts/agent-health/claude3-send-guard-4288.test.ts`。

| 種別 | 中身 | 直しを外すと |
|---|---|---|
| 陽性 | `commandmate send mycodebranchdesk "x" --instance claude-3`・`--instance=claude-3`・`CM_X=1 commandmate send …`・`cd a && commandmate send …`・`npx commandmate send …` → 真 | 関数が無い |
| 陽性 | スクリプトを `spawnSync('node', [guard])` で、PreToolUse の JSON（`tests/fixtures/hooks/claude/pre-tool-use-bash.json` の形）を stdin に渡して起動 → exit 2、stderr に `claude3-reserve.ts send --token` | — |
| 陽性 | `.claude/settings.json` の `hooks.PreToolUse` に `matcher: "Bash"` で `claude3-send-guard.mjs` を呼ぶ項目がある | 設定から外すと落ちる |
| 陰性 | `npx tsx scripts/agent-health/claude3-reserve.ts send --token t "commandmate send mycodebranchdesk x --instance claude-3"`・`--instance claude-2`・別の worktree・`commandmate wait mycodebranchdesk --instance claude-3`・Bash 以外の tool → 偽／exit 0 | — |
| 陰性 | 壊れた JSON の stdin → exit 0（止めない側） | — |

**未確認**の「CommandMate が起動した PM のセッションで効くか」は単体では確かめられない。実装の後の UAT（ジャッジ）で、隔離した worktree の Claude に素の `send` を打たせて止まることを 1 回見る（本番の claude-3 には送らない。送り先の名前だけ一致させた隔離サーバーで）。

---

## 5. 確かめたこと（この段）

- 2 番: TS・bash ともに §1.2 の割込みで 2 者が同時に取れることを一時ディレクトリで再現した
- 2 番（改訂 2）: 新しい指摘の前提をコードで確かめた（実行はしていない）: `run-server.sh:470-473` はサーバーを起こしてから `set_pid`、`daily.sh:92` で取り `:141` で子を起こす、`run-lock.ts:62-70` の `defaultIsAlive` は EPERM 以外の失敗を死にする、sync の `probe` は boolean の false を `gone` にする（`:138`）、sync の `deadline` は `now()` に数を足す（`:705-706`）、`lock_release` の missing・corrupt の枝（`verify-run.sh:1506-1513`）、`lock_settle_gone` が `lock_holder_state` を直に呼ぶ（`:1269`）、`lib.sh:27` が `run-lock.sh` を source する。子のグループの受け渡し（`lock_handoff_wait` `:1830`・`lock_publish_group` `:1848`）がロックの節（`:590`〜`:1626`）の外にあることも確かめた（D9 で節の中に `lock_child_wait` を足す理由）
- 3 番: 仮想時計で 95／285／5795 秒を再現した
- 4 番: `reserve` の解析が `--self` を知らないこと（`claude3-reserve-main.ts:133-134` の `unknown argument`）と、`claude3Free` が busy で exit 4 を返すこと（`:256-258`）をコードで確かめた。claude-3 の実機の状態は見ていない（未確認）
- 5 番: 製品の送信に予約が無いこと、`.claude/settings.json` が無いこと、`dev-team-doc-4239.test.ts:26` の固定をコードで確かめた

## 6. 書くファイルの一覧（レーンの重なりの判定用）

| PR | ファイル | 番号 |
|---|---|---|
| PR1a | `scripts/orchestrate/machine-lock-sync.mjs`（`lockPath`・`ownerCodec`・`ownerlessGraceMs`・`token`・`ownerPid`・`hooks.kill`〔D10〕、`handOff(pid, pgid)`・`releaseAsHead`・`recoverIfDead`、owner の排他作成） | 2 |
| PR1a | `src/lib/verification/machine-lock.ts`（owner の排他作成だけ） | 2 |
| PR1a | `.claude/skills/cmate-verify/scripts/verify-run.sh`・`.agents/skills/cmate-verify/scripts/verify-run.sh`（振る舞いを変えない切り出しと D3〜D6 の関数、`lock_settle_gone` の判定の `lock_record_state` への差し替え〔D7〕、子の待ち `lock_child_wait`〔D9〕。バイト一致） | 2 |
| PR1a | `.claude/skills/sync-map.json`（pin と rationale。skills への port は別の PR） | 2 |
| PR1a | `scripts/lib/machine-lock.sh`（新規。`verify-run.sh` のロックの節の読み込み口〔2 度読まれても 1 回〕と codec・D7 の包み・D12 の `lock_release_held`） | 2 |
| PR1a | `docs/design/verification-config.md` §9.2、`docs/design/verify-lock-holder-group-4288.md` §2.8（観測点の行） | 2 |
| PR1a | `tests/unit/verification/machine-lock-options-4288.test.ts`（新規） | 2 |
| PR1b | `src/lib/agent-health/run-lock.ts`（D10・D11）、`scripts/uat/run-lock.sh`、`scripts/uat/run-server.sh`（D9 のサーバーの起動・`lock_token`・持ち主でない者の解放・失敗の trap）、`scripts/agent-health/daily.sh`（改訂 2: D9 の子の起動・INT／TERM の trap・D12 の EXIT） | 2 |
| PR1b | `src/lib/agent-health/claude3-reservation.ts`（`:12` のコメントの 1 語だけ。PR2 も同じファイルを書くので、後にマージする側が取り込む） | 2 |
| PR1b | `tests/unit/lib/agent-health/run-lock-profiles-4288.ts`・`run-lock-machine-lock-4288.test.ts`・`fixtures/`（凍結した旧版）（新規） | 2 |
| PR1c | `scripts/agent-health/product/lib.sh`（`scripts/lib/machine-lock.sh` を直に source。`run-lock.sh` の source は表示と runner の確かめのために残す）、`scripts/agent-health/product/deadline-guard.sh` | 2 |
| PR1c | `tests/unit/scripts/agent-health/supervisor-lock-machine-lock-4288.test.ts`（新規）、`product-supervisor-3312.test.ts:647` の割込みの口（PM の決定の後） | 2 |
| PR2 | `scripts/agent-health/dispatch-main.ts` | 3 |
| PR2 | `tests/unit/scripts/agent-health/dispatch-ready-wait-4288.test.ts`（新規） | 3 |
| PR2 | `src/lib/agent-health/claude3-reservation.ts` | 4 |
| PR2 | `scripts/agent-health/claude3-reserve-main.ts` | 4 |
| PR2 | `tests/unit/scripts/agent-health/claude3-reserve-self-4288.test.ts`（新規） | 4 |
| PR2 | `.claude/settings.json`（新規） | 5 |
| PR2 | `scripts/agent-health/claude3-send-guard.mjs`（新規） | 5 |
| PR2 | `tests/unit/scripts/agent-health/claude3-send-guard-4288.test.ts`（新規） | 5 |
| PR2 | `docs/orchestrate/team.md` | 4・5 |
| PR2 | `docs/user-guide/agent-health.md` | 4 |
| 両方 | `changelog.d/4288.md`（既存。1 番のエントリがある。`scripts/changelog-fragments.mjs:46-50` はファイル名を `^\d+\.md$` に限り、本文の `(#N)` とファイル名の一致を見る〔`:89-90`〕。1 ファイル 1 エントリ〔3 行目以降は不可〕なので、`4288b.md` のような別名は作れない。各 PR は既存の 1 行の末尾に自分の直しを書き足す。PR1 と PR2 はこの 1 行で衝突するので、後にマージする側が develop を取り込んでから書き足す） | 2〜5 |
| 両方 | `dev-reports/module-reference/issue-4288.md`（コミットに入らない） | — |

`src/lib/tmux`・`src/lib/session`・`src/cli/commands/send.ts`・送信 API・`src/lib/cli-tools`（#4300）と、`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts`（G）は、どの PR も書かない。PR1（PR1a〜PR1c）と PR2 は `changelog.d/4288.md` の 1 行と `claude3-reservation.ts`（PR1b はコメントの 1 語だけ）を除いて書くファイルが重ならないので並行できる（後のマージ側が取り込んで書き足す）。PR1a〜PR1c も G（`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts`）と #4300（`src/lib/tmux`・`src/lib/session`・送信の API／CLI・`src/lib/cli-tools`）のファイルを書かない。

## 7. PR の分け方と難易度

| PR | 中身 | 難易度 | 見立て |
|---|---|---|---|
| PR1a | 2 番の土台: machine-lock に D1〜D6 のオプションと操作（同期 JS・bash・TS の排他作成）、`verify-run.sh` の切り出し、読み込み口 | **難**（opus） | 3 実装の規則を保ったまま足す。既存の machine-lock の試験の期待は不変。観測点の表（#4288 の 1 番 §2.8）と走査の試験に新しい点が入る。事前レビュー（2-4-4）を推す。後で skills の port |
| PR1b | 2 番: run-lock（TS・bash・UAT の引渡しと `down`・daily の子の起動）を PR1a に載せる | **中〜難**（opus） | 包みは薄いが、混在の表（§1.9）と割込みの試験（§1.10。改訂 2 で D9〜D12 の実プロセスの対照が増えた）の量が多い。**依存は PR1a だけ**（`run-lock.sh` が読み込み口を source する） |
| PR1c | 2 番: supervisor.lock（取得・EXIT・ガードの回収だけ）を PR1a に載せる | **中**（opus） | `lstart`（D7）と取得しない回収者（D6）。**依存は PR1a だけ**（改訂 2）: `lib.sh` は今 `run-lock.sh` 経由でしか読まない（`lib.sh:27`）ので、PR1a で入口のファイルを足すだけでは旧い `run-lock.sh` から関数が届かない。PR1c で `lib.sh` が `scripts/lib/machine-lock.sh` を**直に** source し（`product_lock_*` は `run_lock_*` を呼ばない。`run_lock_field` の表示と `run_lock_pid_alive` の runner の確かめ〔`lib.sh:76`〕だけを旧いまま使う）、PR1a＋PR1c（旧い `run-lock.sh`）の組合せで取得・EXIT・ガードの回収だけの経路を試験で通す（試験は `scripts/uat/run-lock.sh` の版に依らないことを、旧い `run-lock.sh` の写しを置いた一時ディレクトリでも走らせて見る）。PR1b が後で `run-lock.sh` から同じ読み込み口を source しても、読み込みは 1 回だけ（§1.7）。PR1b と PR1c はどちらを先にマージしてもよい。`:647` の書き換えは PM の決定待ち |
| PR2 | 3・4・5 番 | **易〜中**（sonnet） | どれも 1 か所の小さな足し算。5 番だけ実機（UAT）の確かめが残る |

PR1 を 3 本に分けるのは、第 2 版で 1 本の差分が machine-lock の 3 実装・skill の写しと sync-map・run-lock の 2 実装と UAT・supervisor の 2 スクリプトにまたがり、1 本では検証（verify）と事前レビューが重くなりすぎるため（見立て）。分けないなら PR1a＋PR1b を 1 本、PR1c を別にするのが次の切れ目。

PR2 を 3 本に割らないのは、4・5 が同じ `team.md` §4 を書くため（割ると直列になる）。3 番だけは独立しているので、PM が望めば別 PR にできる。

## 8. 本文に無い指摘

- （第 2 版で撤回）`scripts/agent-health/product/lib.sh:153-164` の `supervisor.lock` の回収が run-lock と同じ rename の形、の指摘は、PM の決定（`pm-return-4288-design.md` の (c)）で 2 番に含めた（§1.3・§1.6 の D6・D7・§6 の PR1c）
- `verify-run.sh` の札の公開 `ln "$2" "$1/$ltt_name"`（`lock_take_ticket :1089`）も、宛先がディレクトリなら中へ作って成功する（§1.4 の実測と同じ `ln` の性質）。宛先は「最大の番号＋1」で、ディレクトリを作る経路は無く、作られても後の確かめで札を失ったと読んで取り直すだけ（見立て）。直さない
- `dispatch-main.ts:440` の待ちは `<=` で 19 回（95 秒）。3 番で一緒に直る
- （改訂 2）`verify-run.sh` の `lock_release`（`:1500-1525`）は、owner が missing なら canonical を `rm -rf` し（`:1506-1508`）、token の無い壊れた記録も削除へ進む（`:1513` の条件が空の token を通す）。verify-run.sh の中では、二重解放や、他者の `mkdir` の直後・書き途中の owner に当たったときに他者のロックを消しうる（見立て。呼び手は `LOCK_HELD_*` で 1 回に絞っているので、起きる経路は未確認）。run-lock・supervisor.lock は使わない（D12）。本書では直さない
- （改訂 2）2 値の観測の写し: `src/lib/agent-health/claude3-reservation.ts:108` の `defaultIsAlive`（EPERM を生、他の失敗を死）、`scripts/agent-health/metrics.ts:72` の `isAlive`（失敗を全て死）、`scripts/uat/run-lock.sh:75-83` の `run_lock_pid_alive`（`lib.sh:76` の runner の確かめ・`run-server.sh` の停止の待ちが使う）。どれも run-lock の判定ではないので直さない。予約（`claude3-reservation.ts`）は PR2（4 番）の範囲なので、PR2 の契約で同じ形にするかを PM が決める
