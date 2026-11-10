# Issue #4288 の 2〜5 番の設計（run-lock の回収・ready 待ちの実時間・claude-3 の自己予約・素の send）

- 状態: 設計 第 1 版（設計の段。コードは変えない。実装は PM の確認の後、別の契約で行う）。2 番（§1）と §6・§7 の PR1 の行・§8 の supervisor.lock は**第 2 版**（事前レビュー `review-4288f.md` の P1 3・P2 6 の処置と、PM の決定「machine-lock の実装と規約に載せ替える」〔`pm-return-4288-prereview.md` の (a)〕・「supervisor.lock を PR1 に含める」〔`pm-return-4288-design.md` の (c)〕を反映。§1 の行番号は `426ad2661`）
- 対象: Issue #4288 の対象 2〜5（1 番は PR #4295 でマージ済み。設計は [verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md)）
- 行番号は `fix/4288-lock-rest` の `ed9b89eac` のもの。名前で引くこと
- 表記: **事実**＝コード・実行で確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 再現はすべて `os.tmpdir()`／scratchpad の下に作った一時ディレクトリで行い、`$CM_RUN_LOCK_DIR`・`reservationDir`・`--state-dir` をそこへ向けた。`~/.commandmate` の実物、サーバー、tmux、エージェント CLI には触っていない

## 結論（一覧）

| 番号 | 直すか | 選んだ案 | 難易度 |
|---|---|---|---|
| 2 run-lock の rename の回収（＋同じ形の supervisor.lock） | **直す**（TS・bash の両方で再現した） | 案 2D（第 2 版）: run-lock と supervisor.lock を machine-lock（#4277 の札・先頭だけの回収・#4288 の 1 番の退避の読みと 3 値の観測）の実装に載せる。載らない差 8 つ（owner の書式・パス・owner の無いディレクトリ・pid の引渡し・持ち主でない者の解放・取得しない回収者・`lstart`・継承）は、既定で働かないオプションと操作として machine-lock に足す。第 1 版の案 2C は代案として比較に残す | 難（PR を 3 本に分ける） |
| 3 ready 待ちの 90 秒 | **直す**（再現した。95 秒〜最大 5795 秒） | 案 3B: 開始時刻からの実時間の期限＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る | 易 |
| 4 claude-3 の自己予約 | **直す** | 案 4B: `reserve --self`。`commandmate whoami --json` で呼び手が claude-3 のときだけ、状態確認を省いて持ち主 `leader` で取る | 易 |
| 5 素の `commandmate send` | **一部直す**（事故の防止だけ。完全な排他は直さない） | 案 5C: Claude Code の PreToolUse フック（リポジトリの `.claude/settings.json`）で、Bash の `commandmate send mycodebranchdesk … --instance claude-3` を止める。製品の send は変えない | 易〜中 |

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
| 解放（持ち主自身） | owner の 1 回の読みで token が自分なら消すだけ。1 回きり。生きた保有者のロックは誰も動かさないので、読みと削除の間に入れ替わらない（#4277 §2.4 の 3、S1。`machine-lock.ts:1022-`、sync `:794-`、bash `lock_release :1500-1525`） | token を読んで `rm -rf`（`run-lock.ts:186-188`、`run-lock.sh:158-164`、`lib.sh:200-205`） | 載る（daily の EXIT・main.ts・supervisor の EXIT・cleanup・`up` の handoff 前の失敗は、解放するのが持ち主のプロセス自身） |
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
| **D1 owner の書式** | machine-lock の owner は JSON（`{pid,host,token,acquiredAt,pgid?}`）。run-lock・supervisor.lock は `key=value` の行（`pid`・`started_at`・`label`・`token`・`run_dir`、supervisor は `lstart`）。旧版の取得者（§1.9）は `sed 's/^pid=//'` で読むので、JSON の owner を「pid が無い＝死んだ」と読んで**生きた新しいロックを奪う**（`run-lock.sh:75-83` の `run_lock_pid_alive ''` が偽 → stale） | **owner の書き方と読み方を差し替えられるようにする（codec）**。run-lock・supervisor.lock は `key=value` の行のまま書き、新しい行 `host=` を足す（旧い読み手は知らない鍵を読まない）。読み手は `host=` の無い記録を「この host」と読む（このロックはローカルの tmp と `<base>` に置くので、他 host の記録は来ない）。判定は**1 回の読みのテキストから**全ての欄を取る（bash は `lock_obs_owner` の `cat` 1 回の出力を codec が解く） | sync: オプション `ownerCodec: { parse(text), format(record) }`（既定は今の JSON）。bash: `lock_obs_owner` の欄の取り出しを `lock_parse_owner_text <text>`、`:1416` と `lock_publish_group` の `printf` を `lock_format_owner <pid> <token> <acquiredAt> [<pgid>]` に切り出す（振る舞いは同じ）。run-lock の読み込み口がこの 2 関数を上書きする |
| **D2 パスで渡す** | machine-lock は `<root>/<name>` からパスを作る | 取得・回収・解放に**ロックのパス**を渡す口を足す。札の列は `${lock%.lock}.queue`（`.lock` で終われば外す。既定の `commandmate-run.lock` なら `<tmpdir>/commandmate-run.queue` で、名前で作るときと同じ）。退避は `<lock>.gone-*`、一覧するのは `<lock>` の親（今の `lock_gone_candidates` のまま） | sync: オプション `lockPath`（あれば `root`・`name` より優先）。bash: `lock_acquire_path <lock> <queue> <budget>` を足し、`lock_acquire <name> <budget>` はそれを呼ぶだけにする |
| **D3 owner の無いディレクトリの 60 秒** | machine-lock は回収しない。run-lock・supervisor.lock は 60 秒より古ければ取る（固定する試験 2 本） | オプション `ownerlessGraceMs`（run-lock・supervisor.lock は 60000、既定は無し）。**先頭だけ**が、`settleGone` の後で `<lock>` の owner が missing・中が空・mtime がこの値より古いとき、`rmdir <lock>`（空でなければ失敗する。失敗は不明か「誰かが書いた」で、取らずに周回をやり直す）→ 通常の `mkdir`。年齢は ms（sync: `statSync().mtimeMs`、bash: `stat -f %m`／`stat -c %Y` の秒 ×1000 と `lock_now_ms`）で比べ、`find -mmin` を使わない（事前レビュー P2-5: GNU find は分に丸める）。あわせて **owner の最初の書き込みを排他作成にする**（sync・TS: `flag: 'wx'`、bash: `set -C` の下の `>`）。`EEXIST` は「取れなかった、何も消さない」。それ以外の失敗は、自分が作った owner（open が通ったとき）だけを消し、`<lock>` は `rmdir`（空のときだけ）で戻す。書いた後に owner を読み直し、token が自分でなければ取れなかったことにする（`/dev/null` への symlink の穴を読み直しで塞ぐ） | sync・bash（取得の `claim`）。TS の `claim :617-652` も `'wx'` にそろえる（3 実装の claim の規則を 1 つに保つ。既存の利用者では owner は自分の `mkdir` の直後で無いので振る舞いは同じ） |
| **D4 pid の引渡し（`run_lock_set_pid`）** | 今の `set_pid` は token を変えずに pid だけ上書きする。回収者が「`up` のシェルの pid の記録」を読んで判定し、シェルが終わった後に退かすと、退かした記録の token が同じなので**生きたサーバーのロックを消す**（#4288 の 1 番 §2.2 と同じ形） | **同じ取得の中の別の状態遷移「引渡し」を足す**。持ち主（`up` のシェル、生きている）だけが呼ぶ。owner を 1 回読み、token が T0 の記録なら、`pid=<server>`・**token `T1=<T0>-p<server>`** の記録を `<lock>/.owner-<T1>` に書き、`mv` で `owner` を置き換え、読み直して T1 と pid を確かめる（`lock_publish_group` と同じ形）。読みが T0 でない・missing・不明なら何もせず失敗（`up` は `exit 1` → 失敗の trap）。新しい T1 は呼び手に返し、`run-server.sh` が状態ファイルに `lock_token` として書く | sync: handle に `handOff(pid)`。bash: `lock_hand_off <lock> <T0> <pid>`（`LHO_TOKEN` に T1）。`run_lock_set_pid` はこれを呼ぶ |
| **D5 持ち主でない者の解放** | `down`・`up` の失敗の trap はサーバーを止めた後に token を読んで消す。止めた後は持ち主が死んでいるので、読みと削除の間に先頭が回収して取りうる（事前レビュー P1-2） | **札を取り、先頭になってから解放する**操作を足す（予算 10 秒）。先頭である間は、新しい実装の誰も `mkdir`・回収・`rmdir` をしないので、読みと削除の間に後継が入らない。先頭で owner を 1 回読み、token が渡された token のどれか（T0 か T1）なら `rm -rf <lock>`、missing なら自分の token の退避だけを片付ける（`cleanupOwnGone` と同じ）、他の token・壊れた・不明は何もしない。札は全ての経路で `done`。予算のうちに先頭になれなければ何もしない（持ち主は死んでいるので、次の取得者の先頭が回収する） | sync: `releaseAsHead(lockPath, tokens, options)`。bash: `lock_release_as_head <lock> <queue> <budget> <token>…`。`run-server.sh` の `down` と、`up` の失敗の trap の引渡しの後の枝が使う |
| **D6 取得しない回収者（`deadline-guard.sh`）** | 回収は取得の途中にしかない | **回収だけの操作**を足す。札を取り、先頭になったら `settleGone` → owner を 1 回読み、死んでいれば `breakStale`（退かして確かめ、違えば戻す）、owner が無く空で `ownerlessGraceMs` より古ければ `rmdir`。**`mkdir` はしない**。札は全ての経路で `done`。終状態は「消した」「残した（生きている・不明・予算のうちに先頭になれない）」「退避を残した（戻しの失敗。`restore-failed`）」の 3 つで、ガードの exit code には効かせない（今どおり） | sync: `recoverIfDead(lockPath, options)`（今の利用者は無いが、3 実装の規則をそろえるために置く）。bash: `lock_recover_only <lock> <queue> <budget>` |
| **D7 supervisor.lock の `lstart`** | machine-lock の判定は pid（と pgid）だけ。pid が再利用されると生きている扱いになり、ガードが回収できない（安全側だが、翌朝の supervisor が `busy` になる） | owner に `lstart=` がある記録に限り、pid が生きていて `ps -o lstart=`（`LC_ALL=C`）が読め、記録と**違う**なら死んだと読む。読めなければ不明（取らない）。生きた持ち主の `lstart` は記録と同じなので、生きた保有者のロックを誰も外さない規則（#4277 §2.4 の 3）は崩れない | bash だけ（supervisor.lock は bash だけが触る）: `lock_record_state` を supervisor の読み込みで包む。TS・sync には足さない |
| **D8 継承（`CM_RUN_LOCK_TOKEN`）** | machine-lock に無い | run-lock の包みの中で、取得の前に owner を 1 回読み、token が環境変数と同じで判定が「生きている」なら `inherited`（解放しない）。owner が missing なら、退避（`.gone-*`）のうち token が同じで生きた記録も継承と読む（回収者が戻すまでの短い窓で、子の `run.ts` が断られないように） | `run-lock.ts`・`run-lock.sh` の包み（machine-lock には足さない） |

文面（足すだけ）: 取得の失敗は今の文面のまま（TS `別の実行がロックを持っている: <dir>（pid N, <label>, <時刻>[, <run dir>]）`、bash `another run holds <dir> (…)`。`run-server-3359.test.ts:410`・`:426` が固定）。持ち主が札・退避・不明のときは括弧の中を `（列の先頭: pid N）`・`（退避中: <gone>）`・`（不明: <point> <errno>）` にする（新しい枝）。回収の行は bash の `run-lock: took over a stale lock (pid N, label L)`（`run-server-3359.test.ts:421` が固定）を、machine-lock の回収の知らせを関数 `lock_note_recovered <lock> <pid>`（既定は今の `verify-run: broke a stale lock …` の 1 行）に切り出して run-lock の読み込み口で上書きして出す。

### 1.7 共通化の形

**bash: `verify-run.sh` のロックの節を、そのまま読み込む。**

- 新しいファイル `scripts/lib/machine-lock.sh`（読み込み口）。中身は「このリポジトリの `.claude/skills/cmate-verify/scripts/verify-run.sh` から `# --- machine-wide gate lock` の行から `# --- gate execution` の前までを切り出して `eval` する」関数 `machine_lock_load` と、run-lock・supervisor.lock 用の codec（D1）・`lock_note_recovered`（文面）・D7 の包み。切り出しは試験が今使っているものと同じ（`lock-4288-harness.ts:25`）。印の行が 1 つずつ無ければ読み込みを失敗にする（取得の失敗として扱い、取らない）
- `scripts/uat/run-lock.sh` は `machine_lock_load` の後に、今の関数名（`run_lock_dir`・`run_lock_acquire`・`run_lock_set_pid`・`run_lock_release`・`run_lock_holder`・`run_lock_pid_alive`・`run_lock_field`）を machine-lock の関数の上の薄い包みとして定義する。`run_lock_field`（欄ごとの読み）は表示（`run_lock_holder`）だけに残し、判定には使わない。`lib.sh` は今どおり `run-lock.sh` を source し、`product_lock_*` を同じ形の包みにする
- `verify-run.sh` に入れる手直し（振る舞いを変えない）: `lock_parse_owner_text`・`lock_format_owner`（D1）、`lock_acquire_path`（D2）、`lock_note_recovered`（文面）、D3・D4・D5・D6 の関数。`.agents/skills/cmate-verify/scripts/verify-run.sh` はバイト一致（`tests/unit/skills/cmate-verify/dual-placement.test.ts`）。`.claude/skills/sync-map.json` の pin を計算し直し、rationale に 1 文。skills リポジトリ（`commandmate-skills`）の `verify-run.sh` はバイト一致を保つ運用（sync-map の rationale、#314・#315 の前例）なので、**port の PR が別に要る**（オーケストレーターが追う。それまで skills の写しは新しい関数を持たないが、足すのは既定で働かない関数なので、skills の写しの振る舞いは今と同じ）
- 1 つのシェルが持つ machine-lock は 1 つ（節の大域変数 `LOCK_PATH`・`LOCK_TOKEN`・`LOCK_TICKET`・`LOCK_HELD_*` が 1 組）。今の呼び手も 1 つずつ（`daily.sh`＝run-lock、`run-server.sh` の `up`／`cleanup`＝run-lock、`supervisor.sh`＝supervisor.lock、`deadline-guard.sh`＝supervisor.lock の回収だけ）。2 つ持つ呼び手が増えないことを試験で見る
- `daily.sh` は `git pull`（`:110`）の**前**に `run-lock.sh` を source する（`:90`）。読み込みは source の時点の写しで関数を定義するので、pull で `verify-run.sh` が変わっても、その実行の中の関数は一貫する

採らなかった形:

| 形 | 採らない理由 |
|---|---|
| ロックの節を skill の別ファイル（`.claude/skills/cmate-verify/scripts/machine-lock.sh`）へ移し、`verify-run.sh` もそれを source する | `verify-run.sh` は 1 ファイルで導入先に置かれる前提がある。節を動かすと #4288 の 1 番の試験（`lock-4288-harness.ts` の切り出し、`lock-observation-points-4288.test.ts` の走査、invariants）が読むファイルが変わり、それらの試験を全部書き換えることになる |
| 節の写しを `scripts/lib/` に置き、バイト一致を試験で見る | 写しが 1 つ増える。読み込み口が実体を読む形で足りる（取る価値のある差が無い）。読み込み口が使えない事情が実装で見つかったときの代案として残す |

**TS: `run-lock.ts` は同期の写し `machine-lock-sync.mjs` の関数を使う。**

- `acquireRunLock` の形（同期・`RunLockResult`・`label`／`env`／`pid`／`token`／`isAlive`／`now`）は変えない。中で `acquireMachineLockSync(…, { lockPath, timeoutMs: 0, ownerCodec: kv, ownerlessGraceMs: 60_000, token, ownerPid, hooks: { pidAlive: isAlive, now } })` を呼び、`release` は返る handle の `release`。継承（D8）は包みで先に見る
- `machine-lock.ts`（非同期）を使わない理由: `acquireRunLock` は同期で、既存の試験（`run-lock-3359.test.ts:57-123`）が同期で呼ぶ。非同期にすると期待を変えることになる。同期 JS は 3 実装の 1 つで同じ規則（#4277 §2.6、§8.1 の不変条件の表）なので、規約の上では同じものに載る
- `src/` から `scripts/orchestrate/*.mjs` を import する前例は src には無い（`git grep` で 0 件）。試験には有る（`lock-4288-harness.ts:11`）。`tsconfig.json` は `allowJs: true`（`:5`）。`run-lock.ts` を import するのは `scripts/agent-health/main.ts:51` だけで、`tsconfig.server.json`・`tsconfig.cli.json` の対象に入らない（事実）。**未確認**: ESLint の規則が `src/` からの `scripts/` の import を拒むか（実装の契約で `npm run lint` で確かめる。拒むなら、同期 JS を `src/lib/verification/` に移さずに、`run-lock.ts` を `scripts/agent-health/` 側の薄い包みから呼ぶ形に替える）
- `machine-lock-sync.mjs` に足すオプション・操作: `lockPath`・`ownerCodec`・`ownerlessGraceMs`・`token`・`ownerPid`（owner に書く pid。札の pid は今どおり `process.pid`）、handle の `handOff(pid)`、関数 `releaseAsHead`・`recoverIfDead`

### 1.8 操作と状態遷移（全経路）

| 経路 | 操作 | 成功の終状態 | 失敗・中断の終状態 |
|---|---|---|---|
| `main.ts` の取得（`:226`） | `acquireRunLock`（予算 0） | owner＝自分、札は `done` | 断る（`ok:false`、文面は今のまま）。札は `done` |
| `main.ts` の通常の解放・signal | handle の `release`（持ち主自身。S1） | `<lock>` が無い | signal・`kill -9` で解放されない → 持ち主の pid が死んだロックとして次の先頭が回収 |
| `daily.sh` の取得（`:92`）・EXIT（`:97`） | `run_lock_acquire`・`run_lock_release`（持ち主自身） | 同上 | 取れなければ `fail_sync`（今のまま）。EXIT で札も `done` |
| `daily.sh` の子 `run.ts` | 継承（D8） | `inherited`、解放しない | 持ち主が死んでいれば継承しない（通常の取得へ） |
| UAT `up` の取得（`run-server.sh:412`） | `run_lock_acquire`（pid＝`up` のシェル、token T0＝`run_id`） | owner＝T0 | 断る（`exit 1`、今のまま） |
| UAT `up` の引渡し（`:473`） | `run_lock_set_pid`＝D4 | owner＝T1（pid＝サーバー）、状態ファイルに `lock_token=T1` | 失敗（読みが T0 でない・missing・不明・書き込み・`mv`・読み直しの失敗）で `exit 1` → 失敗の trap |
| UAT `up` の失敗の trap（`:358-378`） | 引渡しの前: 持ち主自身の解放（S1）。引渡しの後（サーバーを止めた後）: D5 `release_as_head`（T0・T1） | `<lock>` が無い | サーバーを止められなければ今どおりロックを残す（`failed-server-left`） |
| UAT `down`（`:534`） | D5 `release_as_head`（状態ファイルの `lock_token`、無ければ `run_id`。両方を渡す） | `<lock>` が無い | 先頭になれない・不明 → 残す（持ち主は死んでいるので次の先頭が回収）。exit code は今のまま |
| UAT `cleanup`（`:564-574`） | 取得・持ち主自身の解放 | — | 断る（今のまま） |
| supervisor の取得（`supervisor.sh:78`）・EXIT（`:82`） | `product_lock_acquire`（codec＋`lstart`＋60 秒）・`product_lock_release`（持ち主自身） | owner＝自分 → EXIT で消える | 断る（exit 75 と `busy:` の文面は今のまま）。札は `done` |
| `deadline-guard.sh` の判定・回収（`:85-88`） | D6 `product_lock_recover_only` | 死んだ持ち主のロックが消える／生きていれば残る | 先頭になれない・不明 → 残す。途中で死んだら、退避は先頭が §2.7 で片付け、札は ESRCH で外れる |

守る条件（machine-lock から受け継ぐ。§1.13 の P1-1 への答え）: **異なる token の保有期間は重ならない**。理由: (1) `mkdir`・回収・空の `<lock>` の `rmdir` をするのは生きた札の先頭 1 人だけ（#4277 §2.3）。(2) 生きた持ち主のロックは誰も動かさない（回収の条件は pid が ESRCH ＋ pgid のグループが ESRCH ＋ supervisor は `lstart` の不一致）。(3) 回収は退かしてから token を確かめ、違えば戻す。退かしている間、回収者は先頭なので第三者の `mkdir` は無い。戻せなければ退避の記録が死ぬまで先頭は取らない。(4) 解放は持ち主自身なら S1、持ち主でない者は先頭になってから（D5）。(5) owner の最初の書き込みは排他作成で、取ったと言えるのは読み直しで自分の token を見たときだけ（D3）。

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

保証の範囲（#4277 §2.4 と同じ狭め方）: **旧い取得者が動いている間は、排他は「死んだ持ち主のロック・戻せなかった退避・owner の無い `<lock>` が無いとき」に限る**。旧い形の静止した owner（(a)(b)）との互換と、旧いアルゴリズムが動く混在の期間は別で、後者は次の切替で終わらせる。

切替の範囲（見立てと手順。実稼働の混在は**未確認**）:

| 取得者 | 旧版が動く期間 | 終わらせ方 |
|---|---|---|
| `daily.sh`（`agent-health-runner` の worktree） | マージの翌朝の 1 回（旧い `run-lock.sh` を source した後に pull して新しい `run.ts` を起こす。`run.ts` は (a) を継承できる） | 何もしない。翌々朝から新しい |
| UAT の `run-server.sh`（各 worktree のチェックアウトのスクリプトを使う。`run-server.sh:59-61`） | マージより前に分岐した worktree が残る限り、後日も | UAT を起こす worktree はマージの後の develop を取り込んでから起こす（PR1b の受入で `docs/orchestrate/` の UAT の手順に 1 行足すかを PM に伺う）。実装の契約で、残っている worktree の `scripts/uat/run-lock.sh` が新旧どちらかを数える |
| supervisor・ガード（専用ユーザーのチェックアウト、launchd） | そのチェックアウトの同期の前の朝 | 同じチェックアウトの `lib.sh` を両方が source するので、同期の後は一緒に新しくなる |
| skills の `verify-run.sh` | port の PR まで | 足すのは既定で働かない関数だけで、既存の札・回収の規約は同じなので、混在の影響は無い（run-lock・supervisor.lock は skills の写しを読まない） |

### 1.10 テストの設計

新しい試験の台: `tests/unit/lib/agent-health/run-lock-profiles-4288.ts`（新規）。`lock-4288-harness.ts` の `take(impl, root, name, o)` と同じ戻り値（`TakeResult`）の `takeProfile(profile, lockPath, o)` を出す。profile は `run-lock-bash`（`run-lock.sh`）・`run-lock-ts`（`run-lock.ts`）・`supervisor-bash`（`lib.sh`）の 3 つと、陽性の対照・混在の相手に使う**凍結した旧版**（`tests/unit/lib/agent-health/fixtures/` に今の `run-lock.ts`・`run-lock.sh`・`lib.sh` のロックの関数を写して置く。製品のファイルではない）。割込みは machine-lock の既存の口を使う（bash: `CM_VERIFY_TEST_HANDOFF=pause:<stage>`・`CM_VERIFY_TEST_OBS_FAULT`。sync: `hooks.onRecover`・`hooks.fault`・`hooks.beforeLink`）。足す口は D3〜D6 の段の pause（`owner-create`・`hand-off-tmp`・`release-head-read`・`recover-only-moved`）だけ。旧版の割込みは §1.2 の `renameSync` の spy と `mv` の shim。

| 流用する既存の対照（場所） | 新しい試験での形（引数化） |
|---|---|
| 2 者・多者の同時: `run-server-3359.test.ts:389-410`（8 者）、`product-supervisor-3312.test.ts:629`（8 者） | 3 profile × 8 者、と **混合**（bash 4 者＋TS 4 者、supervisor 対 ガード）。各者が `acquired <token> <t>`／`released <token> <t>` を 1 行ずつ書き、**異なる token の保有区間が重ならない**ことを判定する（解放の後の正当な取り直しは許す） |
| 3 者の割込み（§1.2 の再現。A の退避の直前に B、直後に C） | 新しい 3 profile で取れるのは 1 者だけ。**陽性**: 凍結した旧版で B・C の 2 者（§1.2 で確認済み） |
| 先頭だけが回収する: `machine-lock-fifo-4277.test.ts:170`、回収の窓（bash の `mkdir` を退避の前後に差す）: `machine-lock-invariants-4277.test.ts:414-450` | `describe.each(PROFILES)`。回収者の `before-move`／`moved`／`restore-mkdir` で止め、もう 1 者の取得を差す → 断られる。再開の後に保有者は 1 者 |
| token の違う記録は戻す: `machine-lock-fifo-4277.test.ts:179` | 引渡し（D4）の後の回収: 回収者が T0（`up` のシェル）を読んで止まる → シェルが終わる → 再開 → 退かした記録は T1 なので戻す。サーバー（生きた子）が持ったまま |
| 停止した公開者（事前レビュー P1-1 の反例の順） | A を `moved` で止め、B・C を予算 0 で差す → 断られる。A の札を生かしたまま 59 秒（sync は `hooks.now`）では B は先頭にならない。61 秒で先頭になるのは前提の外として、そのときの振る舞いは固定しない（§1.8 の前提） |
| 解放は 1 回きり・他者のロックを動かさない: `machine-lock-fifo-4277.test.ts:125-157`（S1） | 持ち主自身の解放に同じ形。**D5**: `down` の `release-head-read` で止め、サーバーの pid を殺し、別の取得者を差す → 断られる（`列の先頭: pid down`）。再開 → `<lock>` が消え、取得者がその後に取れる。**陽性**: 今の `run_lock_release` で同じ順にすると後継のロックが消える |
| 取り戻しの失敗の後始末: `machine-lock-gone-4288.test.ts:268-311`（途中の戻しの完了・回収）、`:183`（戻しの失敗を注入） | 3 profile で同じ表の行（A・C と「別の生きた owner を消さない」）。退避の記録は `key=value` |
| 公開の失敗（事前レビュー P1-3）: `lock-review-fixes-4288.test.ts:260-287`（owner の書き込みの失敗で `<lock>` を戻す） | 3 profile × `owner-create` の `ENOSPC`・`EACCES`・`EEXIST` の注入。M を `mkdir` の後で止め、`<lock>` の mtime を 61 秒前にし、N が `rmdir`→取得 → M を再開 → M は `EEXIST` で取れず、N の owner が残る。**陽性**: 今の `run-lock.sh:127`・`lib.sh:179` の `rm -rf "$dir"` の形では N のロックが消える |
| owner の 1 回の読み: `lock-review-fixes-4288.test.ts:74-105` | `key=value` の記録で、欄の読みの 2 回目だけを失敗させる注入（bash）→ 不明として取らない。owner と退避の併存・token の違う 2 つの退避・壊れた記録（`token` 無し）・`host=` の無い旧い記録 |
| 3 値の観測の注入: `lock-observation-points-4288.test.ts:461-483`（READER_ROWS） | 同じ行を 3 profile で（不明は取らない・消さない・解放しない）。D3〜D6 で増える観測点は #4288 の 1 番の §2.8 の表に足す（走査の試験は表と突き合わせるので、表を直せば期待は変わらない） |
| 旧版の混在: `machine-lock-invariants-4277.test.ts:369-370`（札を知らない取得者） | §1.9 の表の各列を、凍結した旧版と新しい profile の組で 1 本ずつ。(d) で旧い取得者が断ること（D1 を外して JSON にすると奪う＝陽性） |
| 年齢の境界（事前レビュー P2-5） | owner の無い `<lock>` を 59 秒前・61 秒前にして、bash と TS が同じ答え（取らない・取る）。`run-lock-3359.test.ts:82`・`product-supervisor-3312.test.ts:603` は期待のまま通る |
| 排他の公開（事前レビュー P2-8） | `owner` が既にある通常ファイル・ディレクトリ・ディレクトリへの symlink・`/dev/null` への symlink・親の権限不足 → どれも取れず、何も消さない（`/dev/null` は読み直しで落ちる） |
| 取得しない回収者（D6） | 死んだ → 消える・生きている → 残る・`lstart` の違う再利用 → 消える・supervisor が先頭のとき → ガードは残して終わる・ガードを `recover-only-moved` で `kill -9` → 次の supervisor が退避を片付けて取る |
| `set_pid`（事前レビュー P2-4） | 通常の引渡し・退避の前後（回収者の `moved` の前／後に引渡し）・引渡しの途中の回収（`hand-off-tmp` で止める）・後継の token への引渡しの拒否 |

既存の試験の期待: `machine-lock*.test.ts`・`lock-*-4288.test.ts`・`gate-mutex*.test.ts`・`precheck-heavy-3884.test.ts`・`merge-pr-queue-4277.test.ts`・`run-lock-3359.test.ts`・`run-server-3359.test.ts` は**変えない**。`product-supervisor-3312.test.ts` は期待を変えないが、`:647` の 1 本だけ**割込みの口**が変わる: 今は `ps` の stub が pid 999999 の判定の中で入れ替えるが、新しい判定は pid を `kill -0` で見て死んでいれば `ps` を呼ばない（D7 の `lstart` は pid が生きているときだけ）ので、stub が働かず「入れ替えが起きた」の確かめ（`:683`）が落ちる。同じ筋書き（判定と退かしの間に生きた新しいロックが入る）を `pause:recover-only-moved` の口で作るよう書き換える必要がある（it の名前・`token=new` が残る期待は同じ）。**この 1 本の書き換えは PM の決定が要る**（下の「決めてほしいこと」）。`:687-693` の「ディレクトリが消える」は新しい形でも成り立つ（列の `supervisor.queue/` は残るが、試験は `<lock>` だけを見る）。

### 1.11 書くファイル（§6 の PR1a〜PR1c）

- PR1a（machine-lock の足し算）: `scripts/orchestrate/machine-lock-sync.mjs`、`src/lib/verification/machine-lock.ts`（owner の排他作成だけ）、`.claude/skills/cmate-verify/scripts/verify-run.sh` と `.agents` の写し、`.claude/skills/sync-map.json`、`scripts/lib/machine-lock.sh`（新規）、`docs/design/verification-config.md` §9.2（オプションと操作の行）、`docs/design/verify-lock-holder-group-4288.md` §2.8（観測点の行）、試験 `tests/unit/verification/machine-lock-options-4288.test.ts`（新規）。skills の port は別の PR
- PR1b（run-lock）: `src/lib/agent-health/run-lock.ts`、`scripts/uat/run-lock.sh`、`scripts/uat/run-server.sh`（`lock_token` と D5）、試験の台と試験（新規）と凍結した旧版
- PR1c（supervisor.lock）: `scripts/agent-health/product/lib.sh`、`scripts/agent-health/product/deadline-guard.sh`、試験（新規）、`product-supervisor-3312.test.ts:647` の割込みの口（PM の決定の後）

### 1.12 対になる場所

- `scripts/agent-health/daily.sh`・`supervisor.sh` は関数名が変わらないので書かない。`daily.sh:14-18` の説明は今のままで正しい
- `docs/user-guide/agent-health.md:323-327`（「持ち主の pid が死んでいるロックは取り直す」）は新しい形でも正しい。`docs/module-reference.md:378` の「死んだ持ち主は退避して取り直す」は実装の契約の断片で「machine-lock の札と回収に載せた」に直す
- `.commandmate/uat.yaml:36` の「`mkdir` lock (scripts/uat/run-lock.sh)」は今も正しい（`mkdir` のロックのまま）
- `src/lib/agent-health/claude3-reservation.ts:12` の「unlike run-lock's rename」は、run-lock が rename で回収しなくなった後は古い説明になる（PR1b で 1 語直す。予約の動きには関係しない）
- 探して無かったもの: `run_lock_*`・`product_lock_*`・`acquireRunLock` の他の呼び手（`git grep` で §1.1・§1.5 の場所だけ）。`docs/en` に agent-health・run-lock の写しは無い。`src/cli/types/` にロックの型の写しは無い

### 1.13 事前レビュー（`review-4288f.md`、codex-2）の処置

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

決めてほしいこと（PM へ）:

1. `product-supervisor-3312.test.ts:647` の割込みの口の書き換え（期待は同じ、口だけ）を PR1c で行ってよいか
2. UAT を起こす worktree に develop を取り込んでから起こす、の手順を `docs/orchestrate/` に足すか（§1.9。足さないなら、混在の間の保証の狭まりを受け入れる）
3. PR を 3 本（PR1a → PR1b ∥ PR1c）に分けるか（§7）。skills の port の PR を PR1a の後に起こすこと

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
| **3B 3A＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る（採用）** | 期限 `deadline = start + READY_TIMEOUT_MS`。各周回で `sleep(min(READY_POLL_MS, 残り))` → 残りが 0 なら止める → `ls` は `timeout = max(1 秒, 残り)` で実行。回数の上限 `READY_TIMEOUT_MS / READY_POLL_MS`（18 回）も残す | 実時間の上限が「90 秒＋1 秒程度」になる。回数の上限は、時計を固定した既存の試験（`tests/unit/scripts/agent-health/dispatch.test.ts:243-249`、`now` が固定）が止まるために要る |
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
| **4B `reserve --self`（採用）** | `commandmate whoami --json` の `worktreeId`／`instanceId` が予約の送り先（`RESERVATION_TARGET`、`claude3-reservation.ts:50-54`）と一致するときだけ通す。状態確認（`claude3Free`）は省く（呼び手が claude-3 なので busy なのは自分）。持ち主は新しい値 `leader`、token は `leader-<時刻>-<乱数>` | claude-3 の中からしか通らない。予約が `held` なら今どおり exit 3（dispatch の run の中の claude-3 は自分では取れない＝取る必要が無い） |
| 4C PM が代わりに取る（今の手順のまま。直さない） | — | 不採用。PM を通さない run が守られない |

`whoami` は認証ではない（環境変数で偽れる）。予約の token も秘密ではない（#4243 §3.4）。4B の確認は「PM が誤って `--self` を使う」事故を止めるためのもの（見立て）。

### 3.4 規則

| 操作 | 通る条件 | 作る世代 |
|---|---|---|
| `reserve --self --label <s> [--hours 1-24]` | whoami が `mycodebranchdesk`／`claude-3`（exit 0 かつ JSON が読める）・予約が `released` | `held`・`holder: 'leader'`・新しい token（標準出力） |
| whoami が別のインスタンス・失敗（セッション外の exit 3 を含む） | — | 何も作らず **exit 2**（「--self は claude-3 の中からだけ使える」） |
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
- 3 番: 仮想時計で 95／285／5795 秒を再現した
- 4 番: `reserve` の解析が `--self` を知らないこと（`claude3-reserve-main.ts:133-134` の `unknown argument`）と、`claude3Free` が busy で exit 4 を返すこと（`:256-258`）をコードで確かめた。claude-3 の実機の状態は見ていない（未確認）
- 5 番: 製品の送信に予約が無いこと、`.claude/settings.json` が無いこと、`dev-team-doc-4239.test.ts:26` の固定をコードで確かめた

## 6. 書くファイルの一覧（レーンの重なりの判定用）

| PR | ファイル | 番号 |
|---|---|---|
| PR1a | `scripts/orchestrate/machine-lock-sync.mjs`（`lockPath`・`ownerCodec`・`ownerlessGraceMs`・`token`・`ownerPid`、`handOff`・`releaseAsHead`・`recoverIfDead`、owner の排他作成） | 2 |
| PR1a | `src/lib/verification/machine-lock.ts`（owner の排他作成だけ） | 2 |
| PR1a | `.claude/skills/cmate-verify/scripts/verify-run.sh`・`.agents/skills/cmate-verify/scripts/verify-run.sh`（振る舞いを変えない切り出しと D3〜D6 の関数。バイト一致） | 2 |
| PR1a | `.claude/skills/sync-map.json`（pin と rationale。skills への port は別の PR） | 2 |
| PR1a | `scripts/lib/machine-lock.sh`（新規。`verify-run.sh` のロックの節の読み込み口と codec） | 2 |
| PR1a | `docs/design/verification-config.md` §9.2、`docs/design/verify-lock-holder-group-4288.md` §2.8（観測点の行） | 2 |
| PR1a | `tests/unit/verification/machine-lock-options-4288.test.ts`（新規） | 2 |
| PR1b | `src/lib/agent-health/run-lock.ts`、`scripts/uat/run-lock.sh`、`scripts/uat/run-server.sh`（`lock_token`・持ち主でない者の解放） | 2 |
| PR1b | `src/lib/agent-health/claude3-reservation.ts`（`:12` のコメントの 1 語だけ。PR2 も同じファイルを書くので、後にマージする側が取り込む） | 2 |
| PR1b | `tests/unit/lib/agent-health/run-lock-profiles-4288.ts`・`run-lock-machine-lock-4288.test.ts`・`fixtures/`（凍結した旧版）（新規） | 2 |
| PR1c | `scripts/agent-health/product/lib.sh`、`scripts/agent-health/product/deadline-guard.sh` | 2 |
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
| PR1b | 2 番: run-lock（TS・bash・UAT の引渡しと `down`）を PR1a に載せる | **中〜難**（opus） | 包みは薄いが、混在の表（§1.9）と割込みの試験（§1.10）の量が多い。PR1a の後 |
| PR1c | 2 番: supervisor.lock（取得・EXIT・ガードの回収だけ）を PR1a に載せる | **中**（opus） | `lstart`（D7）と取得しない回収者（D6）。PR1a の後で PR1b と並行できる（`lib.sh` は `run-lock.sh` を source するが、使う関数は PR1a の読み込み口にある）。`:647` の書き換えは PM の決定待ち |
| PR2 | 3・4・5 番 | **易〜中**（sonnet） | どれも 1 か所の小さな足し算。5 番だけ実機（UAT）の確かめが残る |

PR1 を 3 本に分けるのは、第 2 版で 1 本の差分が machine-lock の 3 実装・skill の写しと sync-map・run-lock の 2 実装と UAT・supervisor の 2 スクリプトにまたがり、1 本では検証（verify）と事前レビューが重くなりすぎるため（見立て）。分けないなら PR1a＋PR1b を 1 本、PR1c を別にするのが次の切れ目。

PR2 を 3 本に割らないのは、4・5 が同じ `team.md` §4 を書くため（割ると直列になる）。3 番だけは独立しているので、PM が望めば別 PR にできる。

## 8. 本文に無い指摘

- （第 2 版で撤回）`scripts/agent-health/product/lib.sh:153-164` の `supervisor.lock` の回収が run-lock と同じ rename の形、の指摘は、PM の決定（`pm-return-4288-design.md` の (c)）で 2 番に含めた（§1.3・§1.6 の D6・D7・§6 の PR1c）
- `verify-run.sh` の札の公開 `ln "$2" "$1/$ltt_name"`（`lock_take_ticket :1089`）も、宛先がディレクトリなら中へ作って成功する（§1.4 の実測と同じ `ln` の性質）。宛先は「最大の番号＋1」で、ディレクトリを作る経路は無く、作られても後の確かめで札を失ったと読んで取り直すだけ（見立て）。直さない
- `dispatch-main.ts:440` の待ちは `<=` で 19 回（95 秒）。3 番で一緒に直る
