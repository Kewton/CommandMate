# Issue #4288 の 2〜5 番の設計（run-lock の回収・ready 待ちの実時間・claude-3 の自己予約・素の send）

- 状態: 設計 第 1 版（設計の段。コードは変えない。実装は PM の確認の後、別の契約で行う）。**5 番は PM の決定で採らない**（§4 の冒頭）。3・4 番は PR2 で実装済み
- 対象: Issue #4288 の対象 2〜5（1 番は PR #4295 でマージ済み。設計は [verify-lock-holder-group-4288.md](./verify-lock-holder-group-4288.md)）
- 行番号は `fix/4288-lock-rest` の `ed9b89eac` のもの。名前で引くこと
- 表記: **事実**＝コード・実行で確かめたこと、**見立て**＝事実からの推論で試していないこと、**未確認**＝この段で確かめていないこと
- 再現はすべて `os.tmpdir()`／scratchpad の下に作った一時ディレクトリで行い、`$CM_RUN_LOCK_DIR`・`reservationDir`・`--state-dir` をそこへ向けた。`~/.commandmate` の実物、サーバー、tmux、エージェント CLI には触っていない

## 結論（一覧）

| 番号 | 直すか | 選んだ案 | 難易度 |
|---|---|---|---|
| 2 run-lock の rename の回収 | **直す**（TS・bash の両方で再現した） | 案 2C: ディレクトリを動かさず、`owner` ファイルだけを回収する（取り戻しと公開は `link` の排他作成） | 中〜難 |
| 3 ready 待ちの 90 秒 | **直す**（再現した。95 秒〜最大 5795 秒） | 案 3B: 開始時刻からの実時間の期限＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る | 易 |
| 4 claude-3 の自己予約 | **直す** | 案 4B: `reserve --self`。`commandmate whoami --json` で呼び手が claude-3 のときだけ、状態確認を省いて持ち主 `leader` で取る | 易 |
| 5 素の `commandmate send` | **採らない（PM の決定）** | 案 5C（PreToolUse フック）は作らない。リポジトリの共有の設定（`.claude/settings.json`）を足すと、clone した利用者を含む全 Claude セッションに効くため。`team.md` に理由と送り方（claude-3 へは `claude3-reserve.ts send` だけ）を書く | — |

PR は 2 本（§7）。

## 重なり（並行するレーンとの関係）

- **#4300（send の送信経路: `src/lib/tmux`・`src/lib/session`・送信の API／CLI・cli-tools の送信前の判定）**: 選んだ案はどれも触らない。5 番は製品の `src/cli/commands/send.ts`・送信 API を**書かない**（案 5C はリポジトリの Claude Code の設定とフックのスクリプトだけ）。
  製品側で止める案（§5 の 5A・5B）を採る場合は `src/cli/commands/send.ts` と `src/app/api/worktrees/[id]/send/` を書くことになり #4300 と重なるので、その場合は **5 番を #4300 のマージの後に回す**（別 PR・別の契約）。今回は採らない。
- **G #4227（`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts`）**: どの番号も触らない。
- 書くファイルの一覧は §6。

## 止める点

**無し。** G のファイルに触る必要は無く、machine-lock（#4277）の規約にも触れない（2 番は `run-lock`〔UAT・daily・run.ts の共通ロック〕で、`machine-lock.ts`・`verify-run.sh` とは別のロック）。

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

### 1.3 直すか: 直す

再現した。受入基準の「2 者が同時に持つ」に当たる。

### 1.4 案の比較

| 案 | 中身 | 評価 |
|---|---|---|
| 2A 戻せなかったら退避を「保有中」と読む（#4277・#4288 1 番の `.gone-*` と同じ考え） | 読み手が `<dir>.stale.*` の生きた記録を保有中と読み、`mkdir` しない | 不採用。C の「`.stale.*` を見る → `mkdir`」と A の退避の間に窓が残る（見た時点では退避が無く、`mkdir` の時点では名前が空いている）。読み手の順序で塞ぐには取得そのものを 2 段にする必要があり、2C より大きい |
| 2B 世代ファイル（#4243 の予約と同じ `link` の比較交換） | ロックをディレクトリから `gen-<N>` の列に作り替える | 不採用。置き場所の形が変わり、bash（`run-server.sh` の `run_dir` の読み、`daily.sh`、product の `lib.sh` が `run_lock_field` を使う）を全部書き替える。旧版との混在期間に互いを見ない |
| **2C ディレクトリを動かさず、`owner` だけを回収する（採用）** | 名前（ディレクトリ）は持ち主の `release` 以外で消えない。回収は `owner` を自分の名前の退避ファイルへ `rename` し（同じ源の rename は 1 者しか通らない）、新しい owner は `link` の排他作成で置く | 生きた持ち主の置き場（ディレクトリ）を空けないので、C の `mkdir` が通る窓が無い。owner の書式・置き場所・`release` は今のまま |

### 1.5 選んだ案 2C の規則

TS（`run-lock.ts`）と bash（`run-lock.sh`）で同じ手順にする。owner の書式（`pid=`／`started_at=`／`label=`／`token=`／`run_dir=`）と置き場所は変えない。

1. **取得**: `mkdir <dir>` が通れば、owner を staging（`owner.tmp.<pid>`）に書き、**`link(staging, <dir>/owner)`**（bash は `ln "$tmp" "$dir/owner"`。`-f` を付けない）で置き、staging を消す。EEXIST（下の 4 で他者が先に置いた。自分が 60 秒以上止まっていたとき）は取れなかったことにして周回をやり直す（今は `rename` の上書きで他者の owner を消していた）
2. **持ち主の読み**: `<dir>/owner` を読む。無ければ `<dir>/owner.reclaim.*` を一覧し、**生きている記録（pid が生きている・読めない）があればそれを持ち主とする**（回収者が生きた owner を一時的に退避している最中。下の 3）
3. **回収**（持ち主の pid が死んでいる）: 判定した token を `judged` とし、`rename(<dir>/owner, <dir>/owner.reclaim.<自分の token>)`。ENOENT なら他者が先に動かしたので周回をやり直す。
   - 動かした記録の token が `judged` で、まだ死んでいる: 自分の owner を 1 と同じ `link` で置く。EEXIST なら負け（退避した死んだ記録は消して周回をやり直す）。置けたら退避した記録を消して取得完了。stderr の `run-lock: took over a stale lock (…)`（bash）は今の文面のまま出す（`tests/unit/scripts/uat/run-server-3359.test.ts:421` が固定）
   - 違う（判定の後に別の者が取り直していた）か生きている: **`link(退避, <dir>/owner)` で戻す**。通れば退避を消す。EEXIST なら、今の owner の token が退避と同じ（持ち主の `run_lock_set_pid` が書き直した）なら退避を消し、違えば退避を残す（2 の読みで、その記録が死ぬまで保有中と読まれる）
4. **owner の無いディレクトリ**: 2 で生きた退避が無く、ディレクトリの mtime が 60 秒より古ければ、1 と同じ `link` で自分の owner を置く（ディレクトリは消さない）。60 秒以内なら「作成中」で取らない（今と同じ）。退避の rename・link はディレクトリの mtime を新しくするので、回収の途中のディレクトリは「作成中」に見える（見立て: macOS の APFS・Linux の ext4 で、ディレクトリ内の rename・link・unlink は親の mtime を更新する。実装の契約で一時ディレクトリで確かめる）
5. **継承**（`CM_RUN_LOCK_TOKEN`）: 2 の持ち主（owner か生きた退避）の token と比べる（今は owner だけ）
6. **解放**: owner の token が自分なら `rm -rf <dir>`（今のまま）。加えて、owner が無く `owner.reclaim.*` に自分の token の記録があるとき（回収者が自分の owner を退避したまま死んだ）も自分のものとして消す。回収者の `link` での戻しと競っても、`rm -rf` の後の `link` は ENOENT で失敗し、回収者は周回をやり直すだけ
7. 旧版が残した `<dir>.stale.*` は読まない・消さない（今も誰も消さない。今と同じ）

なぜ塞がるか（見立て。§1.7 の試験で確かめる）: `<dir>` は `release` の `rm -rf` 以外で消えないので、回収の途中に第三者の `mkdir` は通らない。owner を置く操作は全て `link` の排他作成なので、2 者が同じ `<dir>/owner` を置けない。生きた owner を誤って退避しても、戻すまでの間は 2 の読みで保有中と見え、4 の「作成中」でも守られる。

### 1.6 互換

- owner の書式・置き場所・`release` の条件は変えない。`run_lock_field`（`run-server.sh` の `run_dir`、`scripts/agent-health/product/lib.sh:27` が source して使う）と `readRunLockOwner` の読み手はそのまま
- `owner.reclaim.*` と `owner.tmp.*` は `<dir>` の中にだけ作るので、`release` の `rm -rf` で一緒に消える
- 旧版との混在（入れ替えの瞬間に走っている旧版の回収）は旧い穴をそのまま持つ。呼び手はすべてこのリポジトリのチェックアウトから source／import するので、混在はデプロイの瞬間に走っている実行だけ（見立て）
- 文面: 取得の失敗の文面（`別の実行がロックを持っている: …`・`another run holds …`）は変えない。持ち主が退避中のときも同じ文面で、`describeHolder` は退避の記録を使う

### 1.7 テストの設計

新しいファイル `tests/unit/lib/agent-health/run-lock-reclaim-4288.test.ts`（TS）と、bash の試験を同じファイルか `tests/unit/scripts/uat/run-lock-reclaim-4288.test.ts` に置く。既存の `run-lock-3359.test.ts`・`run-server-3359.test.ts`・`product-supervisor-3312.test.ts` の期待は変えない。

| 種別 | 中身 | 直しを外すと |
|---|---|---|
| 陽性（TS） | §1.2 の割込み: `vi.spyOn(fs, 'renameSync')` で、A の最初の「ロックのパス（`<dir>` か `<dir>/owner`）を源とする rename」の直前に B の `acquireRunLock`、直後に C の `acquireRunLock` を走らせる。期待: A・B・C の `ok && how==='acquired'` は 1 つだけ、かつその token が `<dir>/owner` の token | 今の実装では B・C の 2 つ（§1.2 で確認済み） |
| 陽性（bash） | §1.2 の `mv` の shim と同じ割込み（shim は旧版の `mv "$dir"` と新版の `mv "$dir/owner"` の両方を最初の 1 回だけ捕まえる）。B・C の pid は試験の中で生かした子。期待: `GOT` は 1 つだけ | 今の実装では `B GOT`・`C GOT`（§1.2） |
| 陽性（戻し） | 回収者 A が生きた B の owner を退避した直後（spy の中）に、C が `acquireRunLock` → 拒否され、文面に B の pid が出る。その後 A が戻し、`<dir>/owner` の token が B | 今の実装では C が取る |
| 陽性（作成中の上書き） | `mkdir` の後・owner を置く前で止めた取得者 M（spy）の間に、mtime を 61 秒前にしたディレクトリへ N が owner を置く → M は取れない（`ok:false` か周回のやり直し） | 今の実装は M の `rename` が N の owner を上書きし、M・N の 2 者が取る |
| 陰性 | 死んだ持ち主は回収される・生きた持ち主は回収されない・60 秒以内の owner の無いディレクトリは取らない・継承・`release` は自分の token だけ（既存の 3359 の試験をそのまま通す） | — |
| 陰性（`set_pid`） | 回収者が生きた owner を退避している間に持ち主が `run_lock_set_pid` で書き直す → 戻しが EEXIST、同じ token なので退避を消し、持ち主は持ったまま | — |

割込みは注入の口（新しいテスト用のフック）を足さず `vi.spyOn` と PATH の shim で行う。新しい口を足すと、旧い実装に同じ試験を当てて「直しを外すと落ちる」ことを示せないため。

### 1.8 対になる場所

- `scripts/agent-health/product/lib.sh:150-162` `product_lock_take_stale`（`supervisor.lock`）が**同じ rename の形**を持つ。さらに `scripts/agent-health/product/deadline-guard.sh` が同じロックを消す側に居る（`tests/unit/scripts/agent-health/product-supervisor-3312.test.ts:647-694` が「回収でロックが消える」を固定）。**この Issue の実装では直さない**（本文に無い指摘として別 Issue に。消す側の規則が 3 者目に居て 2C をそのまま当てられず、試験の期待〔`:694` の「消える」〕も変わるため）
- `docs/user-guide/agent-health.md:323-327` の説明は「持ち主の pid が死んでいるロックは取り直す」で 2C でも正しい。変えない。`docs/module-reference.md:378` の「死んだ持ち主は退避して取り直す」は「owner だけを回収して取り直す」に直す（断片で）
- 探して無かったもの: `run-lock` を import／source する他の呼び手（`git grep -n "acquireRunLock\|run_lock_acquire"` は §1.1 の 4 か所だけ）。ja／en の写し（`docs/en` に agent-health の写しは無い）

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
| **3B 3A＋回数の上限＋1 回の `ls` の timeout を残り時間に絞る（採用）** | 期限 `deadline = start + READY_TIMEOUT_MS` は**単調増加の時計**（`deps.monotonic`、既定 `performance.now()`）で数え、記録用の壁時計 `deps.now` と分ける（壁時計が戻っても上限が外れない）。各周回で `sleep(min(READY_POLL_MS, 残り))` → **sleep の後にも**残りを照合し 0 以下なら `ls` へ進まず止める → `ls` は `timeout = max(1 秒, 残り)`（残りは 90 秒以下）で実行。回数の上限 `READY_TIMEOUT_MS / READY_POLL_MS`（18 回）も残す | 実時間の上限が「90 秒＋1 秒程度」になる。回数の上限は、時計を固定した既存の試験（`tests/unit/scripts/agent-health/dispatch.test.ts:243-249`、`now` が固定）が止まるために要る |
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
- 3 番: 仮想時計で 95／285／5795 秒を再現した
- 4 番: `reserve` の解析が `--self` を知らないこと（`claude3-reserve-main.ts:133-134` の `unknown argument`）と、`claude3Free` が busy で exit 4 を返すこと（`:256-258`）をコードで確かめた。claude-3 の実機の状態は見ていない（未確認）
- 5 番: 製品の送信に予約が無いこと、`.claude/settings.json` が無いこと、`dev-team-doc-4239.test.ts:26` の固定をコードで確かめた

## 6. 書くファイルの一覧（レーンの重なりの判定用）

| PR | ファイル | 番号 |
|---|---|---|
| PR1 | `src/lib/agent-health/run-lock.ts` | 2 |
| PR1 | `scripts/uat/run-lock.sh` | 2 |
| PR1 | `tests/unit/lib/agent-health/run-lock-reclaim-4288.test.ts`（新規。bash の試験も含めるか `tests/unit/scripts/uat/run-lock-reclaim-4288.test.ts` に分ける） | 2 |
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

`src/lib/tmux`・`src/lib/session`・`src/cli/commands/send.ts`・送信 API・`src/lib/cli-tools`（#4300）と、`src/lib/handoff`・`src/components/mem`・`src/hooks/useWorktreeDetailController.ts`（G）は、どの PR も書かない。PR1 と PR2 は `changelog.d/4288.md` の 1 行を除いて書くファイルが重ならないので並行できる（その 1 行は後のマージ側が書き足す）。

## 7. PR の分け方と難易度

| PR | 中身 | 難易度 | 見立て |
|---|---|---|---|
| PR1 | 2 番（run-lock の TS・bash） | **中〜難**（opus） | 2 実装を同じ手順に揃え、割込みの試験を TS（spy）と bash（PATH の shim）の両方で書く。並行の推論が要る。事前レビュー（2-4-4）を推す |
| PR2 | 3・4・5 番 | **易〜中**（sonnet） | どれも 1 か所の小さな足し算。5 番だけ実機（UAT）の確かめが残る |

PR2 を 3 本に割らないのは、4・5 が同じ `team.md` §4 を書くため（割ると直列になる）。3 番だけは独立しているので、PM が望めば別 PR にできる。

## 8. 本文に無い指摘

- `scripts/agent-health/product/lib.sh:150-162` の `supervisor.lock` の回収が run-lock と同じ rename の形（§1.8）。消す側に `deadline-guard.sh` が居る。別 Issue を推す
- `dispatch-main.ts:440` の待ちは `<=` で 19 回（95 秒）。3 番で一緒に直る
