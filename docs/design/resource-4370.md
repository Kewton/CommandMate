# マシンの資源の受付と配分（Issue #4370）— 設計

- 状態: 設計（第 2 版。2-4-4 事前レビューと段 3 の突き合わせ〔`s3-crosscheck.md` X1〜X7〕を反映。末尾の改訂の履歴）。実装は未着手。この run で実装するのは §9 の PR1 だけ
- 親: Epic #4371（流れの計測と制御）の子 4。共通の枠は段 3 のリーダーの決定（`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`、以下「共通の枠」）に従う
- 前提の Issue: #1917（`cpu.heavy`）、#3884（precheck の重い段・待ちの記録）、#4265（`--heavy-to-ci`）、#4277（札の先着順）、#4288（lease の規則と前提 P0・P1）
- 行番号は 2026-11-14 の `origin/develop`（`a334a013f`）のもの。名前で引くこと
- 本書では **事実**（コード・記録・設定で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**を分ける（§8 に一覧）

---

## 0. 結論

| 問い | 決めた向き | 一言の理由 |
|---|---|---|
| 全体の上限 | `~/.commandmate/resource.yaml` の `commandmate_share`（既定 0.4）× 論理 CPU 数を **全体の枠 S** とする。S を「CI の VM の割り当て（`ci_vm.cpus`、既定 0＝不明）」「`cpu.heavy` の予約（`weights.cpu_heavy`）」「ホストの枠 C」に分け、C を新しいセマフォが数える。既定値はどの論理 CPU 数でも C ≥ 1（§2.7） | macOS に cgroup が無い。CI は Docker の VM で硬く、ホストの処理は受付で守る。セマフォが守るのは**宣言した処理の帳簿**で、mutex の無いゲート・エージェント自身などは load の門で間接に見る（§2.1） |
| 枠の仕組み | 既存の machine-lock（`machine-lock-sync.mjs`）を**壊さずに使う**。短い**受付のロック** `cpu.sem.admit` の中でだけ保有者の記録（`<root>/cpu.sem/holders/<token>.json`）を読み・回収し・足す。枠の待ちは優先度つきの札（`waiters/`）。先頭だけが入る。判定に使う C は `state.json` で全プロセスの間で 1 つ（小さい方へだけ即座に効く。§2.3.1） | 排他・札・回収・三値の観測・lease の規則（pid と世代）をそのまま再利用できる。保有者の記録の追加と削除が 1 つの臨界区間に入るので「数えてから足す」の競合が無い |
| 既存の `cpu.heavy` | PR1・PR2 では**触らない**（読みもしない）。代わりに `weights.cpu_heavy` を S から**常に予約**する。PR3a・PR3b で取り手をセマフォへ移す間も `cpu.heavy` を一緒に取り、予約は `cpu.heavy` だけの取り手が残っていないと確かめた後の PR3c で外す（I13） | `cpu.heavy` は 3 実装（TS・bash・同期 JS）が同じ規約で取る。PR1 でセマフォがそれを数えるだけにすると、セマフォが満ちた後に `cpu.heavy` が取られて S を超える。常の予約なら PR1 から不変条件 I1 が成り立つ |
| 優先度 | P0 マージの判定（ホストでの組み合わせ確認）＞ P1 PR 向けのホストの処理 ＞ P2 ワーカーの検証 ＞ P3 背景。CI（VM の中）の待ちは枠を取らない（§7.1）。**始める順だけ**優先し、走っているものは止めない。後ろの小さい要求が先頭を追い越す「詰め込み」はしない | 詰め込みは重い P0 を飢えさせる。止めないのは Issue の仕様 |
| load の上限 | 1 分の load が `load_ceiling`（既定 1.0 × 論理 CPU 数）を超えたら門を閉じ、P2・P3 を入れない。`load_resume`（既定 0.85）倍を下回るまで開けない（門の状態は受付のロックの中で持つ） | 2026-11-13 の load 50〜78（Epic #4371）は CommandMate の外の処理も含む。枠だけでは外の負荷に気づけない |
| 死んだ持ち主 | #4288 の lease の規則（pid と世代）を流用し、保有者は**グループ**で見る: 記録は `link` の 1 回で「pid・グループの番号・グループの先頭の起動時刻」を書き、回収は「グループが空」か「先頭の起動時刻が違う（番号の再利用）」ときだけ。グループが生きている間は pid の死・再利用で回収しない。不明は回収しない。`run` の子は呼び手のグループに残す。前提 P0・P1 の下で保証 | 子が走っている間に枠が外れる経路と、子が呼び手のグループ停止から逃げる経路を塞ぐ。保有は 90 分級なので心拍の lease にしない |
| ランナー | CommandMate のリポジトリにマシンで 1 つの**コントローラー**（`scripts/orchestrate/resource-runners.mjs`。X1）を置き、全リポジトリの合計の上限・待ちと load で台数を決める。launchd（KeepAlive）で常駐し、Docker が落ちている間は待って、起きたら 1 周期で最小台数を起こす。5 分ごとに健康を記録 | 今のコントローラーは別リポジトリの `runner.sh` でリポジトリごとに独立（合計の上限なし・常駐なし・Docker と一緒に落ちたまま） |
| 決まっていない 3 つ | Docker の自動の再起動は**既定は通知だけ**／E2E は **GitHub のランナーへ試しに移す**（公開リポジトリ）／別のリポジトリの処理は **CommandMate が起こすものだけ**セマフォを通す（§6） | §6 に理由 |

---

## 1. 今の作り（事実）

### 1.1 `cpu.heavy`（マシンで 1 本の重い処理）

- 宣言: `.commandmate/verify.yaml:197-200`（`integration`）・`:201-224`（`unit`）が `mutex: cpu.heavy`。名前を資源名にした理由は同 `:212-214`（別のリポジトリの重いゲートも同じ枠を宣言できる）。契約のゲート `unit-related` も同じ（`scripts/orchestrate/contract.mjs:80-85` `UNIT_RELATED_GATE`）
- 取る実装は 3 つ: TS（`src/lib/verification/machine-lock.ts:1152` `acquireMachineLock`、gate-runner が使う `gate-runner.ts:71`）、bash（`.claude/skills/cmate-verify/scripts/verify-run.sh:1926` `lock_acquire`。`.agents` に写し）、同期 JS（`scripts/orchestrate/machine-lock-sync.mjs:1080` `acquireMachineLockSync`。precheck と merge-pr が使う）。3 つは「バイト単位で同じ規約」（`machine-lock-sync.mjs:1-37`）
- 置き場所: `<root>/<name>.lock/owner`、札は `<root>/<name>.queue/<12 桁>`（`machine-lock-sync.mjs:7-10`）。root は `~/.commandmate/locks`（`machine-lock.ts:79` `MACHINE_LOCK_DIR_NAME`、`:102`）で、`CM_VERIFY_LOCK_ROOT` で移せる（`:89`・`:106-111`）
- precheck は広い `related`／`tests` の段だけ `cpu.heavy` を取り（`precheck.mjs:20-28`・`:115` `HEAVY_MUTEX`・`:713-745`）、待ち切ったら段を走らせず exit 3。`--heavy-to-ci` では取らずに CI へ回す（`:718-723`、merge-pr が自分の取り込みの HEAD にだけ渡す `merge-pr.mjs:22-26`・`:604-605`）
- verify の実行枠 `MAX_CONCURRENT_VERIFICATIONS = 2`（`gate-runner.ts:154`）は**サーバーの 1 プロセスの中**の上限で、マシン全体の枠ではない
- `cpu.heavy` が保証するのは「同時に 1 本」だけで、**重さ（何コア使うか）も、CI・別のリポジトリ・ワーカーの検証以外の処理も数えない**

### 1.2 lease の規則（#4288）

- 記録の予約の欄: `pid`・`host`・`token`・`acquiredAt`・`started_at`・`pgid`・`v`・`lstart`・`done`（`machine-lock-sync.mjs:63` `RESERVED_OWNER_FIELDS`）。呼び手は書けない（`:1070-1072`、I1-c）
- 「世代」: 取得ごとの `token`（`machine-lock.ts:119-125` の `LockOwner.token` の注記: 古い保有者の解放が次の保有者を消さないため）と、pid の起動時刻（`ps -o etime=`、`machine-lock-sync.mjs:118` `processStartMs`）による pid の再利用の判定（`:52` `PID_REUSE_SLACK_MS` = 2000、`:462-475` `ticketRetirable` の `pid-reused`）
- 死んだ判定は三値: 同じ host で pid が ESRCH、pgid があればグループも ESRCH のときだけ `gone`（`:349-356` `holderState`）。観測は `makeObserver`（`:180`）を通り、EPERM などは `unknown` で、unknown は取らない・消さない（`:24-32`）
- 前提: 手順の途中で 10 分を超えて止まらない（P0）・壁時計を 2 秒より大きく変えない（P1）（`docs/design/machine-lock-owner-atomic-4288.md` の「前提 P0」）

### 1.3 待ちの記録と結果の再利用

- run の記録は `queueSec`・`mutexSec`・`runSec` を持てる（`scripts/orchestrate/run-log.mjs:33-37`）。gate-runner は `[timing] queue= mutex= run=` を `log_tail` に書く（`gate-runner.ts:220-230`）
- precheck は同じ HEAD で verify が合格したゲートの段を飛ばす（`precheck.mjs:93-97` `COVERED_BY_GATE`、`:670`・`:706-710`）。**CI の側で手元の結果を使って段を飛ばす仕組みは無い**（`ci-pr.yml` の `test-unit:`（`:548`）・`test-e2e:`（`:689`）に該当の段は無い）

### 1.4 ランナー

- 事実（CommandMate の外。読んだのはスクリプトと設定だけ）: コントローラーは別リポジトリ `self-hosted-runner/docker_self-hosted-runner/runner.sh`（`0696b89`）。`run_controller`（`:115-153`）がリポジトリごとに 10 秒ごとに `docker ps` で数え、最大数（既定 `DEFAULT_MAX_RUNNERS=5`、`:19`）未満なら `get_runner_token.py` でトークンを取って `docker run -d --rm`（`:141-147`）。**`--cpus`・`--memory` を付けない**。`nohup` で起動し pid ファイル（`:189-200`）。`pids/` にリポジトリ 8 つ分。**合計の上限は無い**
- 2026-11-14 の読み取り: 論理 CPU 28・メモリ 256 GiB（`sysctl`）。Docker Desktop の設定（`settings-store.json`）は `Cpus: 16`・`MemoryMiB: 49664`・`AutoStart: false`。`~/Library/LaunchAgents` にランナー・Docker・CommandMate の項目は無い。`gh api repos/Kewton/CommandMate/actions/runners` は online 6
- `ci-pr.yml` の重いジョブは同じリポジトリの PR・push で `self-hosted`、fork の PR で `ubuntu-latest`（`:134` などの `runs-on` の式。E2E は `:699`）。リポジトリは PUBLIC（`gh repo view`）
- 運用の記録（Epic #4371 の本文）: Docker の再起動の後は `runner.sh start CommandMate` も要る（コントローラーは Docker と一緒に落ちる）

### 1.5 計測

- `commandmate report metrics`（`src/cli/commands/report.ts:282`）は `/api/metrics/vibe`（`src/lib/metrics/vibe-metrics.ts`）を読む Eval の指標で、資源は扱わない
- `git grep -n loadavg -- src scripts` は 0 件（load を読む既存のコードは無い。grep の 0 件で、別名の読み方は確かめていない）
- 流れの記録（`~/.commandmate/flow/<repo-slug>/<日付>.jsonl`）と警報（`alerts.jsonl`）は #4367 が作る（共通の枠 §2）。まだ無い

### 1.6 再利用の可否

| 既存 | 使い方 | 可否 |
|---|---|---|
| `machine-lock-sync.mjs` `acquireMachineLockSync` | 受付のロック `cpu.sem.admit` をこれで取る（札・回収・三値の観測をそのまま） | 可。`ownerFields` に予約の欄を入れない |
| 同 `holderState`・`ticketRetirable`・`processStartMs`・`makeObserver` | 保有者・待ち手の記録の回収の判定 | 可（export 済み）。記録の形を札と同じ欄（`pid`・`host`・`token`・`createdAt`・`deadline`・`pgid`）にする |
| `machine-lock.ts`（TS） | 製品の段（PR5）で同じ規約の TS 版を書く | PR5 で。PR1 では使わない（`scripts/` は `src/` の TS を import しない、`machine-lock-sync.mjs:34-36`） |
| `precheck.mjs`・`merge-pr.mjs` | 枠の呼び手（PR2） | 可。`HEAVY_MUTEX` の段に枠の取得を足す |
| `run-log.mjs` | 枠の待ちを `slotSec` として記録（PR2） | 可。省略可能な欄を足す（無い行は今までどおり） |
| `gate-runner.ts` の `RunSlot` | サーバーの中の枠。マシン全体の枠ではない | 置き換えない。PR3 でゲートの `mutex` をセマフォに通すときも残す |
| `runner.sh` | 1 台の起動の手順（トークン・イメージ・名前）を写す | 写す（別リポジトリなので import しない）。名前の接頭辞 `ephemeral-runner-<repo>-` を揃え、`runner.sh status` が同じ数を数えられるようにする |
| `src/lib/metrics`・`report metrics` | 資源の計測の入口 | 不可（Eval の指標）。資源は #4367 の流れの記録へ |
| `.commandmate/verify.yaml` の読み手（`src/lib/verification/verify-config.ts`） | `mutex` の名前の検査 | PR3 で `cpu.heavy` の扱いを変えるときの読み手。宣言の形は変えない |

---

## 2. 設計

### 2.1 3 段の守り

1. **受付（セマフォ）**: CommandMate が起こす重いホストの処理は、始める前に枠を取る
2. **Docker の VM の割り当て**: CI は VM の CPU・メモリで硬く制限する（人の操作。§6）
3. **実測と監視**: load の門（§2.4）と 5 分ごとの健康（§2.6）。超えたら受付を止め、#4367 の警報へ

枠の内訳（1 枠 ≒ CPU 1 コア）:

```
S = max(1, floor(ncpu × commandmate_share))     全体の枠
C = S − ci_vm.cpus − weights.cpu_heavy          セマフォが数えるホストの枠（PR3 の条件が揃うまで − cpu_heavy を外さない。I13）
```

- 既定値（§2.7 の表）では、どの論理 CPU 数でも C ≥ 1 になる（`ci_vm.cpus` の既定は 0、`weights.cpu_heavy` の既定は `min(4, S − 1)`）
- 設定で明示した値で C < 1 なら設定の誤り（exit 2、`resource: refused config C=<値> (S=<値> ci_vm.cpus=<値> weights.cpu_heavy=<値>)`）
- 例（見立て。設定を書いたとき）: ncpu 28・share 0.5 → S 14、ci_vm 8、cpu_heavy 4 → C 2。今の VM（16 CPU）は share 0.4（S 11）を一人で超えるので、VM の割り当ての見直しが要る（§6 の人の操作 1）

**数える範囲**: セマフォが守るのは「枠を取ると宣言した処理（`run` で包んだもの・`acquireSlots` の呼び手）の帳簿」だけ。mutex を付けない検証ゲート（`verify.yaml` の `token-discipline`・`route-exports`・`lint` など）、手元の E2E、エージェントの CLI 自身、CommandMate の外の処理は数えない（それらは load の門 §2.4 で間接に見る）。だから「全体の枠 S を実際の CPU が超えない」とは言わない（I1 の言葉はこの範囲に限る）。

### 2.2 セマフォの置き場所と記録

```
<root>/cpu.sem.admit.lock/owner           受付のロック（machine-lock そのもの）
<root>/cpu.sem.admit.queue/<12 桁>        受付のロックの札（machine-lock そのもの）
<root>/cpu.sem/holders/<token>.json       保有者 1 件 = 1 ファイル（tmp → link の 1 回で作る。書き直さない）
<root>/cpu.sem/waiters/<P>-<12 桁>.json   待ち手 1 件 = 1 ファイル（P は 0〜3。tmp → link）
<root>/cpu.sem/state.json                 門の状態・次の札の番号・C・設定のハッシュ（tmp → rename）
<root>/cpu.sem/events.jsonl               出来事の記録（追記だけ。#4367 が読む。X3）
<root>/cpu.sem/events.jsonl.1             回転した 1 世代前
```

`<root>` は machine-lock と同じ（`CM_VERIFY_LOCK_ROOT` で移る。`tests/setup.ts:287` が試験の既定を一時 dir にしている）。

保有者の記録: `{ v:1, token, pid, host, pgid, leaderStart, createdAt, priority, weight, capacity, reason, repo?, waitedMs }`。
- `pid` は書いたプロセス自身（#4288 I1-b）。`pgid` は書いたプロセスの**今のグループ**（`ps -o pgid= -p <pid>` で読む。呼び手が名指すことはできない）。`leaderStart` はグループの先頭（pid＝`pgid` のプロセス）の起動時刻（`processStartMs`。先頭が既に居なければ `null`）
- `capacity` はこの受付で使った C。`reason`・`repo` 以外の欄は呼び手が渡せない（#4288 I1-c と同じ予約の欄に `pgid`・`leaderStart`・`capacity`・`priority`・`weight` を足す）

待ち手の記録: `{ v:1, token, pid, host, createdAt, deadline, priority, weight, capacity, reason }`。

`state.json`: `{ v:1, gate: 'open'|'closed', next: <番号>, capacity: <C>, configHash: <sha256 の先頭 12>, corruptNoted: [<名前>...] }`。

### 2.3 取得と解放

取得 `acquireSlots({ priority, weight, reason, repo?, timeoutMs })`（PR1 は `pgid` を受け付けない。渡されたら拒否。§9 の §6-4）:

1. 引数の検査（`priority` ∈ `P0`〜`P3`、`weight` は 1 以上の整数で自分の C 以下、`timeoutMs` は 0 以上の整数）と設定の読み。外れたら何も書かずに `{ acquired:false, reason:'refused', detail }`
2. 受付のロックを取り（予算 `ADMIT_LOCK_TIMEOUT_MS` = 10 秒）、`next = max(state.next, 既存の待ち手の最大の番号 + 1)` で待ち手の記録を作り、`state.next` を進めてロックを返す
3. 周期ごとに受付のロックを取り（先頭は 1 秒、先頭でない待ち手は 5 秒。P3-11）、その中で:
   1. holders・waiters を一覧する。一覧そのものが失敗したら、この周期は何もしない
   2. 回収（§2.5）
   3. **保有者の記録と同じ token の待ち手を除いて消す**（入った後に消し損ねた待ち手。ロックの中なら誰が消してもよい。A）
   4. 有効な C を決める（§2.3.1）
   5. 門を更新（§2.4）
   6. 生きている待ち手のうち読めるものを `(priority, 番号)` で並べる（壊れた待ち手は並べに入れず、消さない。自分の記録が壊れていれば作り直す）
   7. 自分が**先頭**で、`Σ保有者の weight ≤ C − 自分の weight` で、門が開いているか自分が P0・P1 なら、保有者の記録を `link` の排他で作り、自分の待ち手を消す（入った）。和には読めない保有者を C として、観測が不明の保有者を生きているとして数える（P3-7）
   8. 自分の weight が有効な C を超えていれば、自分の待ち手を消して `refused`（C が下がった。T32）
4. 期限を過ぎたら、受付のロックの中で自分の待ち手を消して `{ acquired:false, reason:'timeout', waitedMs }`。受付のロックが期限まで一度も取れなかった・観測が不明のまま期限なら `reason:'unknown'` と `unknown: { point, path, code }`（machine-lock と同じ形）。`timeoutMs` = 0 は 1 周期だけ試す
5. root の作成の失敗（EACCES など）も `unknown`（`point: 'root'`）。`acquireSlots` は**予期した失敗で throw しない**（P3-12）

返り値（入れた）: `{ acquired:true, token, waitedMs, capacity, release(): 'released' | 'none' }`。

解放 `release()`: 自分の保有者の記録を読み、`token` と `pid` が自分のときだけ消す。同じ token の待ち手が残っていれば、それも消す。1 回きり（2 回目は `none`）。受付のロックは取らない（自分の token の名前だけを消すので、他の記録に触れない）。

#### 2.3.1 有効な C（C）

- 各プロセスは自分の設定から自分の C を計算する（`own`）。受付のロックの中で、有効な C は `min(own, state.capacity)`（`state.capacity` が無ければ `own`）
- `state.capacity` を**下げる**のは即座（`own < state.capacity` を見たプロセスが書く）
- **上げる**のは、生きている保有者・待ち手の記録の `capacity` がどれも `own` 以上で、かつ `Σ保有者の weight ≤ own` のときだけ。古い設定・既定値の違う版・別の環境変数を継いだプロセスが 1 つでも小さい C で生きている間は上がらない
- 変わったら `events` に `{ kind:'capacity', from, to, configHash }`

#### 2.3.2 `run`（PR1 の CLI）

`resource.mjs run --priority P2 --weight 2 --reason <文> [--repo <slug>] [--timeout <秒>] -- <cmd...>`:

- 子は `run` と**同じプロセスグループ**で起こす（`detached` にしない。B）。呼び手がグループへ送る停止（gate-runner の時間切れは `detached` のゲートのグループへ SIGTERM → SIGKILL を送る。`gate-runner.ts:693`・`:723`）は子にも届く
- `run` が SIGTERM・SIGINT・SIGHUP を受けたら子の pid へ渡し、子の終了を待ってから解放する（merge-pr の外側と同じ 3 つ。`merge-pr.mjs:1148` `FORWARDED_SIGNALS`）
- 保有者の記録の `pgid` は `run` のグループ、`leaderStart` はその先頭の起動時刻。**子の起動の前に、`link` の 1 回で全部を書く**ので、書き直しが無い
- exit: 子の exit code、子がシグナルで終われば 128＋番号。`run` 自身の失敗は stderr の決まった 1 行で区別する（P3-6）:

| 場合 | exit | stderr の 1 行 |
|---|---|---|
| 入れた | 子の値 | `resource: admitted <P> weight=<w> waited=<秒>s capacity=<C>` |
| 引数・設定の誤り | 2 | `resource: refused <理由>` |
| 期限切れ | 3 | `resource: timed out <P> weight=<w> waited=<秒>s` |
| 観測不明のまま期限 | 3 | `resource: unknown point=<点> path=<パス> errno=<符号>` |
| 子の起動の失敗 | 127 | `resource: spawn failed <errno>`（枠は返す） |

exit 3 はこの CLI だけの値で、launch-worker・publish-pr へは伝えない（突き合わせの決定 X4）。

`status [--json]`: S・C（自分の C と有効な C）・門・load・保有者と待ち手の一覧（壊れた記録・別の host の記録・`leaderStart: null` の記録を名指し）・`ci_vm.cpus` が既定（0）のままなら警告・`weights.cpu_heavy` が既定で縮んでいれば警告。

### 2.4 load の門

- 受付のロックの中で `os.loadavg()[0]` を読み、`closed` は `load1 ≥ load_ceiling × ncpu` で、`open` は `load1 < load_resume × load_ceiling × ncpu` で切り替える。間は前の状態のまま（揺れ止め）
- `os.loadavg()` が `[0,0,0]` を返す環境（Windows）では門を常に開ける（枠の帳簿は効く。fail-open の理由は §5）
- `state.json` が読めないときは closed とみなし、次の受付で書き直す
- 門の切り替えは `events.jsonl` に 1 行（#4367 の警報の材料）

### 2.5 回収（lease の規則の流用）

受付のロックの中でだけ、次のどれかの記録を消す。

| 記録 | 消す条件 | 判定 |
|---|---|---|
| 保有者 | 同じ host で、グループ `pgid` が空（`kill -0 -- -<pgid>` が ESRCH） | `machine-lock-sync.mjs` の `groupAlive`・`makeObserver` の `group` |
| 保有者 | 同じ host で、グループは生きているが、pid＝`pgid` のプロセスの起動が `leaderStart + PID_REUSE_SLACK_MS` より後（グループの番号が別の新しいグループに使われた） | `processStartMs`。`leaderStart: null` の記録には使わない |
| 保有者 | （使わない）pid だけの ESRCH・pid だけの `pid-reused` | グループが生きている間は回収しない（B） |
| 待ち手 | `ticketRetirable` が `gone`・`pid-reused`・`expired` | `machine-lock-sync.mjs:462` |
| 待ち手 | 同じ token の保有者の記録がある | §2.3 の 3-3（A） |
| どちらも | 別の host の記録 | 保有者は消さない（生きているとみなす）。待ち手は期限＋`OTHER_HOST_GRACE_MS` |
| どちらも | 読めない・壊れた JSON | 消さない。保有者なら C を占めるとみなす。待ち手なら並べに入れない。`events.jsonl` に `corrupt` を記録ごとに 1 回（`state.json` の `corruptNoted` で全体で 1 回） |
| どちらも | 観測が不明（EPERM・`ps` の失敗） | 消さない。保有者は生きているとして数える |

POSIX では、生きているグループの番号はプロセスの番号として再利用されない。だから「グループが生きている」の間、その番号が別のグループを指すことは無く、上の 2 行目は「元のグループが空になった後に番号が再利用された」ときだけ当たる。壊れた保有者の記録で全体が止まるのは安全側の倒れ方で、人が `status` の名指しを見て消す（§6 の人の操作 6）。

既知の限り（§5 の前提の外の表 F6・F7）: `run` が SIGKILL で死に、子も終わったが、呼び手のグループ（merge-pr の内側など）が生き続けると、枠はそのグループの終わりまで返らない（帳簿は安全側）。

### 2.6 ランナーのコントローラー（PR4）

- 1 台のマシンに 1 つ（`scripts/orchestrate/resource-runners.mjs`。置き場所は突き合わせの決定 X1）。`resource.yaml` の `runners.repos[]`（`name`・`min`・`max`）と `runners.total_max` を読む
- 60 秒ごと: `docker version`（10 秒で打ち切り）→ 落ちていれば何もしない／リポジトリごとに `docker ps --filter name=ephemeral-runner-<repo>-` の数と、`gh api repos/<o>/<r>/actions/runs?status=queued` の待ちの数・最古の待ち
- 望む台数 = `clamp(min, max, 走っている数 + 待ちのジョブの数)`。合計が `total_max` を超えるなら、P0 の待ち（base への push の run、#4369 の train のブランチの run）があるリポジトリ → 最古の待ちが古いリポジトリの順に配る。load の門が閉じていれば最小台数より上は起こさない
- 起こすのは足りない分だけ（`docker run -d --rm --cpus <runners.cpus> --memory <runners.memory> --name ephemeral-runner-<repo>-<秒>-<乱数> <image>`、トークンは `runners.token_cmd`）。**走っているコンテナは止めない**。ランナーは使い捨てで 1 ジョブで終わるので、台数は入れ替わりの時に望む台数へ寄る
- コントローラーは**ホストの枠を取らない**（CI の CPU は VM の中で、`ci_vm.cpus` として S から既に引いてある。E）
- 5 分ごとの健康: `docker version`・online 数（`gh api .../actions/runners`）・最古の待ちの秒数を `events.jsonl` と #4367 の警報へ。Docker が 3 回続けて落ちていれば警報。再起動は `health.docker_restart`（既定 `notify`）
- 常駐: launchd の LaunchAgent（`KeepAlive: true`、`RunAtLoad: true`）。コントローラーが死んでも launchd が起こし直す。Docker が落ちている間も生きて待ち、起きた最初の周期で最小台数を起こす → **5 分以内に online**（受入条件。登録まで約 1 分は 2026-10-02 の実測〔運用の記録〕）

### 2.7 `resource.yaml`

既定値の表（D。PR1 が読む鍵は太字）:

| 鍵 | 単位 | 既定 | 検査 |
|---|---|---|---|
| `version` | — | 1 | 1 以外は exit 2 |
| **`ncpu`** | コア | `auto`（`os.availableParallelism()`） | 1 以上の整数か `auto`。試験はここで論理 CPU 数を決める |
| **`commandmate_share`** | 割合 | 0.4（Issue のまま。0.5 は人の判断。X7） | 0 < x ≤ 1 |
| **`load_ceiling`** | × ncpu | 1.0 | > 0 |
| **`load_resume`** | × `load_ceiling` | 0.85 | 0 < x < 1 |
| **`weights.cpu_heavy`** | 枠 | `min(4, max(0, S − ci_vm.cpus − 1))`（縮んだら `status` が警告） | 0 以上の整数。明示した値で C < 1 なら exit 2 |
| **`ci_vm.cpus`** | コア | 0（＝不明。`status` が「VM の割り当てを書いていない」と警告） | 0 以上の整数 |
| `ci_vm.memory_gib` | GiB | 0（不明） | PR4 |
| `runners.*` | — | 無し（コントローラーは動かない） | PR4 |
| `health.*` | — | `interval_sec: 300`・`docker_restart: notify`・`queued_alert_sec: 600` | PR4 |
| `idle.stop_after_min` | 分 | 0（止めない） | PR7 |

既定だけのときの C（T33 の陰性の行）: ncpu 4 → S 1・cpu_heavy 0・C 1／ncpu 8 → S 3・cpu_heavy 2・C 1／ncpu 28 → S 11・cpu_heavy 4・C 7。

書いたときの例:

```yaml
version: 1
commandmate_share: 0.5
weights: { cpu_heavy: 4 }
ci_vm: { cpus: 8, memory_gib: 24 }   # Docker Desktop に人が設定した値と同じにする（読み手は VM を見ない）
runners:                             # PR4
  total_max: 4
  cpus: 2
  memory_gib: 6
  image: my-ephemeral-runner:latest
  token_cmd: ["python3", "/path/to/get_runner_token.py"]
  repos:
    - { name: Kewton/CommandMate, min: 2, max: 4 }
```

- 無い → すべて既定
- 読めない・形が違う・値が範囲の外・明示した値で C < 1・`version` が違う → **exit 2**（設定の誤りを黙って既定に倒さない）
- `version` が同じで**知らない鍵**は警告（`resource: warn unknown key <鍵>`）にとどめる（P3-9: `resource.yaml` はマシンで 1 つなので、新しい版が鍵を足した瞬間に古い版が全部止まらないように）
- 場所は `CM_RESOURCE_CONFIG` で移せる（既定 `~/.commandmate/resource.yaml`）。実在の場所を指す `CM_*` なので、#4163 の方針どおり PR1 で `tests/setup.ts` に一時パスの既定を足し、`tests/unit/config/codex-home-isolation-4146.test.ts:122` の `PINNED` に名前を足す（P3-13）
- `configHash` は読んだ設定の正規化した内容（既定を埋めた後）の sha256

---

## 3. 不変条件

1. **I1** 宣言した処理の帳簿として、どの受付の瞬間でも、生きている保有者の `weight` の和（読めない保有者は C、観測が不明の保有者は生きているとして数える）≤ 有効な C（§2.3.1）。範囲は §2.1 の「数える範囲」に限る
2. **I2** 保有者の記録の追加は受付のロックの中でだけ、同じ臨界区間の回収・有効な C・和の計算の後に行う
3. **I3** 入れるのは、生きていて読める待ち手（同じ token の保有者を持つものを除く）を `(priority, 番号)` で並べた先頭だけ。後ろの待ち手は先頭が入るまで入らない（詰め込みなし）。同じ優先度は番号の順
4. **I4** 門が閉じている間、P2・P3 は入らない。P0・P1 は門に依らない
5. **I5** セマフォは走っている保有者を止めない・枠を取り上げない
6. **I6** 保有者の記録を消すのは (a) 本人の解放（token と pid が自分）か (b) 受付のロックの中の回収（§2.5 の正の証拠: グループが空、またはグループの番号の再利用）だけ。pid だけの死・再利用では消さない。観測が不明なら消さない
7. **I7** 記録の `pid` は書いたプロセス自身、`pgid` はその今のグループ。予約の欄は呼び手が書けない（#4288 I1-b・I1-c）
8. **I8** 入ったときは待ちの時間（`waitedMs`）を記録・`events.jsonl`・`run` の stderr に残す。記録の書き込みの失敗は取得を失敗にしない（警告だけ）
9. **I9** 既存の `cpu.heavy` のロック・札・解放の振る舞いを PR1・PR2 は変えない（読みも書きもしない）
10. **I10** `weight` が有効な C を超える・設定が誤っている要求は、待ち手の記録を書く前に拒否する。待ちの間に C が下がって超えたら、その待ち手を消して拒否する（永久に入れない先頭を作らない）
11. **I11** 保有者の記録は `link` の 1 回で作り、書き直さない。`state.json` は tmp → `rename`、待ち手は tmp → `link`
12. **I12** 保証は #4288 の前提 P0（手順の途中で 10 分を超えて止まらない。スリープを含む）・P1（壁時計）の下で書く。前提の外の交差は §5 の表に行で名指し、直さない

後の PR の条件（今の設計で約束する。F・G）:

13. **I13（PR3 の条件）** `weights.cpu_heavy` の予約は、マシンに `cpu.heavy` だけを取る取り手（TS・bash・同期 JS のどれか、別のリポジトリや導入済みの古い版を含む）が 1 つも残っていないと確かめられるまで外さない。セマフォへ移した取り手も、移す途中は `cpu.heavy` も一緒に取る（「同時に 1 本」を崩さない）。PR3a と PR3b の境目では予約を外さない
14. **I14（PR2・PR3 の条件）** (1) 枠を待ち切ったら、段を走らせずに HELD・exit 3・SKIP（`reason=mutex-wait` と同じ扱いの理由）のどれかにし、合格・飛ばしには倒さない。(2) 取る順はマシンで 1 つ: **枠 → `cpu.heavy` → merge のロック**。持ったまま別の待ちに入るのは、この順の後ろだけ。(3) P0 は他のロック（merge のロック）を持ったまま P2・P3 の保有の終わりを待たない＝merge-pr は merge のロックを取る前に枠を取る

---

## 4. 状態と遷移の表

### 4.1 1 つの要求

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| 無し | 取得（引数・設定の誤り・`pgid` の指定） | 無し | 何も書かない。`refused`／exit 2 |
| 無し | 取得（正しい） | 待ち | 受付のロックの中で待ち手の記録（番号は `max(state.next, 最大+1)`） |
| 無し | 取得（受付のロックが 10 秒取れない） | 待ち（記録なし） | 次の周期で記録を試す。期限まで |
| 無し | root が作れない | 無し | `unknown point=root`／exit 3 |
| 待ち | 周期: 先頭・空きあり・門が通す | 保有 | 保有者の記録（`link`、グループと先頭の起動時刻つき）→ 自分の待ち手を消す → `events` `admit waitedMs` |
| 待ち | 周期: 先頭でない／空きなし／門が閉じて P2・P3 | 待ち | なし（先頭でなければ周期 5 秒） |
| 待ち | 周期: 一覧の失敗 | 待ち | 回収も受付もしない。`events` に `unknown` を 1 回 |
| 待ち | 周期: 保有者 1 件の観測が不明 | 待ち／保有 | その保有者は生きているとして数え、空きがあれば入る |
| 待ち | 周期: 有効な C が自分の weight より小さい | 無し | 自分の待ち手を消す。`refused`／exit 2 |
| 待ち | 周期: 自分の待ち手の記録が壊れている | 待ち | 同じ番号で作り直す |
| 待ち | 期限 | 取消し | 自分の待ち手を消す。`timeout`（不明のままなら `unknown`）／exit 3。`run` は子を起動しない |
| 待ち | プロセスの死（SIGKILL） | 待ち（記録だけ残る） | 次の周期で他者が `gone` で回収 |
| 保有（待ち手の消し損ね） | 他者の周期 | 保有 | 同じ token の待ち手は他者が消す（A） |
| 保有 | 解放（本人） | 解放済み | 自分の記録（と残った同じ token の待ち手）を消す。`events` `release heldMs` |
| 保有 | 解放（2 回目） | 解放済み | なし（`none`） |
| 保有 | `run` が SIGTERM・SIGINT・SIGHUP | 保有 → 解放済み | 子へ渡し、子の終了の後に解放。exit 128＋番号 |
| 保有 | 呼び手のグループへ SIGKILL | 回収待ち | `run` と子が同時に終わる。グループが空になれば次の周期で回収 |
| 保有 | `run` だけが死に、グループ（子・呼び手）が生きる | 保有 | 回収しない（I6） |
| 保有 | グループが空 | 回収待ち | 次の周期で他者が消す。`events` `reclaim` |
| 保有 | グループが空になり、番号が新しいグループの先頭に再利用 | 回収待ち | `leaderStart` との比較で消す |
| 保有 | 記録が外から消された（人の操作） | 保有（記録なし） | 解放は `none`。I1 はその間崩れうる（§5 F4） |

### 4.2 門

| 状態 | 出来事 | 次 | 副作用 |
|---|---|---|---|
| open | `load1 ≥ ceiling` | closed | `events` `gate closed load=` |
| open | `load1 < ceiling`（resume と ceiling の間を含む） | open | なし |
| closed | `load1 < resume × ceiling` | open | `events` `gate open load=` |
| closed | `load1 ≥ resume × ceiling`（ちょうど resume を含む） | closed | なし |
| どちらも | `state.json` が読めない | closed とみなす | P2・P3 を入れない。番号は待ち手の最大＋1。書き直しは次の受付で |

### 4.3 有効な C

| 状態 | 出来事 | 次 | 副作用 |
|---|---|---|---|
| `state.capacity` 無し | 受付 | `own` | 書く |
| `state.capacity` = K | `own < K` | `own` | 即座に下げる。`events` `capacity` |
| `state.capacity` = K | `own > K`、生きている記録の `capacity` がどれも `own` 以上、`Σ ≤ own` | `own` | 上げる |
| `state.capacity` = K | `own > K`、上の条件の外 | K | なし（小さい C のプロセスが居る間は上げない） |

### 4.4 コントローラー（PR4）

| 状態 | 出来事 | 次 | 副作用 |
|---|---|---|---|
| Docker 待ち | `docker version` 成功 | 稼働 | 同じ周期で最小台数まで起こす |
| Docker 待ち | 失敗・10 秒切れ | Docker 待ち | 連続回数を数え、3 回で警報。`auto` なら §6 の条件で再起動 |
| 稼働 | 失敗 | Docker 待ち | 起こさない |
| 稼働 | 待ちと台数が分かった | 稼働 | 足りない分を起こす（合計の上限・門） |
| 稼働 | `gh api` の失敗 | 稼働 | 待ちを 0 とみなさず、最小台数だけ守る。3 回で警報 |
| 稼働 | トークンの取得の失敗 | 稼働 | そのリポジトリは 60 秒後に再試行（`runner.sh` と同じ） |
| どれも | プロセスの死 | （launchd が起こす） | 走っているコンテナは残る |

---

## 5. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 失敗・時間切れ・部分的な成功 | 倒れ方 |
|---|---|---|
| 受付のロック（machine-lock） | 10 秒で取れない・unknown | **fail-closed**: その周期は入らない（待ちに数える）。期限まで続けば `unknown` |
| root の作成 | EACCES など | fail-closed: `unknown point=root`。throw しない |
| holders／waiters の一覧（`readdir`） | EACCES・EIO | fail-closed: 回収も受付もしない |
| 保有者の記録の読み | 壊れている | C を占めるとみなす（fail-closed） |
| 保有者 1 件の観測（`kill -0`・`ps`） | EPERM・ps の失敗 | その保有者は生きているとして数え、他の判定は続ける（P3-7） |
| 待ち手の記録の読み | 壊れている | 並べに入れない・消さない。自分のものなら作り直す（P3-5） |
| 待ち手の記録の作成（tmp → `link`） | 失敗 | 自分の tmp だけ消し、次の周期で作り直す |
| 保有者の記録の作成（`link`） | EEXIST・ENOSPC | 入らない。自分の tmp だけ消す |
| 自分の待ち手の削除（入った後） | 失敗 | 入ったまま（保有者の記録が正）。同じ token の待ち手は他者が先頭を決める前に除いて消し（A）、本人の解放でも消す |
| `state.json` の書き込み（tmp → `rename`） | 失敗 | 前の内容が残る。門は前の状態、番号は待ち手の最大＋1 で補う（P3-4） |
| `state.json` の読み | 壊れている・無い | 門は closed、番号は待ち手の最大＋1、C は `own` |
| `ps -o pgid=`（取得の前） | 失敗 | 入らない（`unknown point=pgid`）。グループの分からない記録を作らない |
| `os.loadavg()` | 0 を返す環境 | **fail-open**（門を開ける）。帳簿の I1 は効くので、外の負荷への備えだけが外れる |
| `events.jsonl` の追記・回転 | 失敗 | **fail-open**: stderr に警告、取得・解放は続ける（I8）。10 MB を超えたら受付のロックの中で `events.jsonl.1` へ回す（1 世代。P3-10） |
| `resource.yaml` | 無い | 既定値（どの ncpu でも C ≥ 1） |
| `resource.yaml` | 壊れている・誤り・明示値で C < 1 | fail-closed: exit 2 |
| `resource.yaml` | 同じ版で知らない鍵 | 警告して続ける |
| 子のコマンド（`run`） | 起動の失敗 | 枠を返して exit 127 |
| 子のコマンド（`run`） | シグナルで終わる | 枠を返して 128＋番号 |
| `docker version`（PR4） | 失敗・10 秒 | 起こさない（Docker 待ち） |
| `docker run`（PR4） | 失敗 | その周期は諦め、次の周期で数え直す（二重起動しない: 毎周期 `docker ps` で数え直す） |
| `gh api`（PR4） | 5xx・レート | 最小台数だけ守る。3 回で警報 |
| launchd（PR4） | コントローラーの死 | KeepAlive で起こし直す。plist が入っていなければ常駐しない（人の操作） |

前提の外・既知の限り（直さない）:

| 行 | 形 | 前提 |
|---|---|---|
| F1 | 受付のロックを持ったまま 10 分を超えて止まった書き手の再開。**macOS のスリープ**は全プロセスを 10 分以上止めて壁時計を進めるので、現実の入口になる（空の owner の猶予 `EMPTY_OWNER_GRACE_MS`、`machine-lock-sync.mjs:58` が過ぎ、臨界区間に 2 者が入りうる）（P3-14） | P0 |
| F2 | 先頭の起動から記録までの間の壁時計の後退で、グループの番号の再利用の判定が誤る | P1 |
| F3 | 別の host の記録（同じ `~/.commandmate` を共有する構成）は回収しない | 構成の外（1 台のマシンの設計） |
| F4 | 人が保有者の記録を手で消した | 運用。`status` が消した記録の和の変化を出す |
| F5 | `ci_vm.cpus` が Docker Desktop の実際の値と違う | 人の操作の誤り。読み手は VM を見ない（§6） |
| F6 | **host 名の変化**（macOS はネットワークで変わりうる）: 自分の古い記録が「別の host」になり回収されず、枠が漏れ続ける。1 台の中で起きる（P3-8） | 既知の限り。`status` が「今の host と違う記録」を名指しし、人が消す（人の操作 6） |
| F7 | `run` が SIGKILL で死に子も終わったが、呼び手のグループが生き続ける／取得の時に先頭が既に居なかった（`leaderStart: null`）グループが空になり番号が再利用された | 既知の限り。前者は呼び手の終わりまで返らない（安全側）。後者は `status` が `leaderStart: null` の記録を名指す |

---

## 6. 人の操作・人の判断

### 6.1 人の操作（導入。この run の範囲外）

| # | 操作 | いつ | PR に入れるもの |
|---|---|---|---|
| 1 | Docker Desktop の Resources を `ci_vm` に合わせる（推奨の出発点: CPU 8・メモリ 24 GiB） | PR4 の後 | docs の手順。値の推奨は `docs/orchestrate/ci-merge.md` |
| 2 | Docker Desktop の「サインイン時に起動」を入れる（今 `AutoStart: false`） | PR4 の後 | docs |
| 3 | `~/.commandmate/resource.yaml` を書く（`ci_vm.cpus` を書くまで `status` が警告） | PR1 の後（既定で動く） | 雛形（`docs/orchestrate/ci-merge.md` の例） |
| 4 | LaunchAgent を入れる（`launchctl bootstrap gui/$UID <plist>`） | PR4 の後 | plist の雛形 `scripts/orchestrate/launchd/com.commandmate.runner-controller.plist.template`・入れ方の docs・雛形の形の試験 |
| 5 | 旧コントローラー（`runner.sh` の 8 リポジトリ分）を止め、新しいコントローラーの `repos` へ移す | 4 の後 | 移行の手順の docs |
| 6 | 壊れた記録・別の host の記録・`leaderStart: null` の記録を消す（`status` が名指す） | 起きたとき | `status` の出力 |

### 6.2 人の判断（推奨 1 つと理由）

| 問い | 推奨 | 理由 |
|---|---|---|
| `commandmate_share` の値（既定は Issue の 0.4。X7） | **0.5**（S 14） | 0.4 だと今の VM の 16 CPU が入らず、VM を 4 まで削ることになる。0.5 なら VM 8・`cpu_heavy` 4・ホスト 2 で、残り 14 コアを別のリポジトリと人の作業に残す。#4367 の計測で見直す |
| Docker の自動の再起動 | **既定は通知だけ**（`notify`）。`auto` は「3 回続けて落ち、どのリポジトリにも走っているジョブが無い（`gh api` で busy 0）」ときだけ | 再起動は同じ Docker 上の他のリポジトリのランナーとジョブを巻き込む（運用の記録で利用者に確かめてから行ってきた）。11-13 の停止の直接の原因は未確認で、自動の再起動が悪化させない保証が無い |
| E2E を別のマシン・GitHub のランナーへ | **E2E の 2 本の shard だけ GitHub のランナー（`ubuntu-latest`）へ試しに移す**（ワークフローを変える別の PR。1 週間の所要と揺れを #4367 で比べて決める） | リポジトリは公開で GitHub のランナーは無料。fork の PR では既に `ubuntu-latest` で走る（`ci-pr.yml:699` の式）ので動く見込みが高い（見立て）。E2E は中央値 6.2 分・最長 16.2 分・時間切れ 30 分（`ci-pr.yml:21-22` の実測の表）で、ブラウザを起こす重いジョブ |
| 別のリポジトリの処理をセマフォに通すか | **CommandMate が起こすもの（verify のゲート・orchestrate のスクリプト）はリポジトリを問わず通す。CommandMate の外で人や別のツールが起こすもの（cargo など）は通さず、load の門で見る** | lock root はマシンで 1 つ（`~/.commandmate/locks`）なので、CommandMate が管理するリポジトリは設定なしで同じ枠に入る（`verify.yaml:212-214` の狙いと同じ）。外の処理を強制する仕組みは macOS に無い |
| CI の段を手元の verify の結果で飛ばすか（受入条件 4） | **リポジトリごとの明示（`flow.yaml` の `ci_skip: [unit]`）で、既定は飛ばさない**。飛ばすのは「同じツリー（`HEAD^{tree}`）・同じゲート・全体の実行（related でない）・同じ lockfile の hash」の合格だけ。証拠は commit status で CI へ渡し、必須チェックの名前は変えない | 手元と CI のコンテナは環境が違い、必須チェックを弱めうる（共通の枠 §5）。だから既定は今のまま、受入条件を満たす仕組みだけを用意し、使うかは人が決める |
| CI の中の P0 と P1 の順 | **最初は GitHub の割り当て（先着）のまま**。コントローラーは P0 の待ちがあるリポジトリへ先に台数を配るだけ | 使い捨てのランナーはどのジョブを取るかを選べない。ラベル（`runs-on: [self-hosted, p0]`）はワークフローの変更で、train（#4369）の形が決まってから |
| 飢え（P2 が続く間 P3 が入らない） | **仕様として受け入れる**。最長の待ちを #4367 の警報の材料にする（`events` の `waitedMs`） | Issue の仕様は「始める順だけ優先」。年齢での繰り上げは P0 の優先を崩す |

---

## 7. 他の子への約束

### 7.1 提供（#4370 → 他）

| 相手 | 提供するもの | 形 | いつから |
|---|---|---|---|
| #4369（merge train） | 枠の取得 | 同期 JS `acquireSlots({ priority, weight, reason, repo?, timeoutMs })` → 入れた `{ acquired:true, token, waitedMs, capacity, release(): 'released' \| 'none' }`／入れない `{ acquired:false, reason: 'refused' \| 'timeout' \| 'unknown', detail?, waitedMs?, unknown? }`。予期した失敗で throw しない（`scripts/orchestrate/resource-sem.mjs`）。CLI `node scripts/orchestrate/resource.mjs run --priority P0 --weight <n> --reason train:<id> -- <cmd>` | PR1。**PR2b までは #4369 は merge のロックと `cpu.heavy` のままでよい**（共通の枠 §3） |
| #4369 | 優先度の使い方 | **P0 ＝ train・base の、ホストで走る組み合わせ確認（tsc＋影響テスト）の間だけ**。P1 ＝ ホストで走る PR 向けの処理（あれば）。**CI（VM の中）の待ちの間は枠を取らない**（CI の CPU は `ci_vm.cpus` として S から引いてある。E、狭めて塞ぐ）。#4369 の契約に「CI 待ちの間に `cpu.sem/holders` が増えない」行を入れてほしい | PR1 |
| #4369 | 取る順 | 枠 → `cpu.heavy` → merge のロック（I14）。merge のロックを持ったまま枠を待たない | PR2b から |
| #4368（WIP） | なし（WIP の数は使わない） | — | — |
| #4367（計測） | 出来事 | `<root>/cpu.sem/events.jsonl`（と回転した `.1`）の 1 行: `{ at, kind: 'admit'\|'release'\|'reclaim'\|'cancel'\|'refused'\|'gate'\|'capacity'\|'corrupt'\|'unknown'\|'health', priority?, weight?, waitedMs?, heldMs?, load1?, capacity?, reason?, repo? }`。#4367（PR2 以降）がこれを読む。`_machine` の slug は作らない（突き合わせの決定 X3） | PR1 |
| #4367 | 今の状態 | `resource.mjs status --json` → `{ S, C, ownC, gate, load1, holders: [...], waiters: [...], warnings: [...] }` | PR1 |

終了コード: `resource.mjs` の 3（期限切れ・不明）はこの CLI だけの値で、launch-worker・publish-pr の帯（#4368 の 60／61）とは別（X4）。

### 7.2 利用（他 → #4370）

| 相手 | 使うもの | 足りないもの（#4370 からの頼み） |
|---|---|---|
| #4367 | 警報の書き手（`alerts.jsonl`） | PR4 の健康の警報を書く口。PR1 は使わない（#4370 PR1 は #4367 に依存しない。X6） |
| #4367 | `.commandmate/flow.yaml` の読み手（`scripts/flow/config.mjs`。X1） | `ci_skip`（PR6）を同じ読み手へ足す |
| #4369 | train のブランチの名前 | コントローラーが P0 の run を見分けるため、`flow.yaml` の `train` の節にブランチの接頭辞を置いてほしい（無ければ base への push だけを P0 とみなす） |
| #4368 | 「動いているブランチ数」の関数 | 遊んでいるセッションを止める PR7 が、動いているものを止めないために読む |

`docs/orchestrate/ci-merge.md` は #4369 PR1 と #4370 PR1 がそれぞれ別の節を足す。後に入る方が develop を取り込んで足す（X5）。

---

## 8. 事実と見立て

- **事実**: §1 の file:line、`runner.sh` の行、Docker Desktop の設定の値、論理 CPU 28、online 6、リポジトリが公開。gate-runner はゲートを `detached` で起こしてグループへ停止を送る（`gate-runner.ts:693`・`:723`）。merge-pr の外側は INT・TERM・HUP を内側へ渡す（`merge-pr.mjs:1148`）。`tests/setup.ts:287` が `CM_VERIFY_LOCK_ROOT` を一時 dir にし、`codex-home-isolation-4146.test.ts:122` の `PINNED` が実在の場所を指す `CM_*` を固定する
- **見立て**:
  - `cpu.heavy` の重さ 4 枠（vitest の全体の実行が何コア使うかは測っていない。#4367 の計測で直す）
  - E2E が GitHub のランナーで同じように通ること（fork の PR で通っている実績は見ていない）
  - コントローラーで Docker の起動から 5 分以内に online に戻ること（登録まで約 1 分は 2026-10-02 の 1 回の記録）
  - load の門の 1.0 × ncpu・0.85 が揺れずに効くこと
  - 先頭 1 秒・他 5 秒の周期の `ps` の負荷が無視できること（待ち手 20 を想定。PR1 で測って記録する）
- **未確認**:
  - 2026-11-13 18:57 の Docker の停止の原因（Epic #4371: 内部のプロセスが SIGTERM、OOM の記録なし）
  - VM の割り当てを 8 に減らしたときの CI の所要
  - `os.loadavg()` が Docker の VM の vCPU の負荷をどこまで含むか（VM の中で負荷を回し、ホストの `sysctl vm.loadavg` と比べて確かめる）
  - macOS での pid・pgid の再利用の頻度（B の直しは頻度に依らない正しさの条件として入れた）

---

## 9. PR の切り方と、この run で実装する PR1

### 9.1 PR の切り方（危険の境目で分ける）

| PR | 中身 | 境目の理由・条件 |
|---|---|---|
| **PR1** | セマフォの核（同期 JS）・`resource.yaml` の読み手・CLI `status`／`run`・試験の隔離（`tests/setup.ts`）・docs の節・試験 | 新しいファイルと試験の既定だけ。既存の取得の経路に入らない |
| PR2a | precheck の重い段が P2 の枠を取る。run-log に `slotSec` | 既存の呼び手（ワーカー側）。`cpu.heavy` はそのまま（I9）。**I14**: 取る順は枠 → `cpu.heavy`、待ち切れは HELD・exit 3 |
| PR2b | merge-pr の組み合わせ確認が P0 の枠を取る | マージの判定の経路。**I14 (3)**: merge のロックの前に枠を取る。待ち切れでマージしない。試験「枠の待ち切れで precheck の段が HELD になり merge-pr はマージしない」「merge のロックを持った状態で枠を待たない（順序の検査）」 |
| PR3a | `machine-lock.ts` の TS 版のセマフォと gate-runner の `mutex: cpu.heavy` を P2 の取得へ（**`cpu.heavy` も一緒に取る。予約は外さない**） | verify の裁定の経路。3 実装の一致の試験。**I13**。試験「TS の取り手が枠で入っている間、`cpu.heavy` だけの取り手（同期 JS・bash）は入らない」。門が閉じている間の P2 は mutex-wait と同じ SKIP に倒し、合格にしない（I14 (1)） |
| PR3b | bash（`verify-run.sh` の 2 配置）の `cpu.heavy` をセマフォへ（同上） | skills の写し・sync-map の pin |
| PR3c | 予約を外す | **I13 の確かめ**（`cpu.heavy` だけの取り手がマシンに残っていない。`status` が「予約を外した設定で旧い取り手がいる」を警告する試験）が揃ってから。人の判断（別のリポジトリ・導入済みの版の更新の確認） |
| PR4 | ランナーのコントローラー・launchd の雛形・健康の確認・docs | マシンの外への作用（Docker・GitHub）。コントローラーはホストの枠を取らない |
| PR5 | 製品: `src/lib/flow/resource/**`・`commandmate resource status\|acquire\|release`・`GET /api/resources`・画面の資源の帯 | 製品の API と画面。`acquire`／`release` の分かれた形は保有者のグループを CLI の外のプロセスにする規則（呼び手のグループだけ・先頭の起動時刻つき）が要るので、ここで決める |
| PR6 | CI の段を同じツリーの verify で飛ばす（`ci_skip`、既定は飛ばさない） | 必須チェックに関わる。人の判断の後 |
| PR7 | 遊んでいるワーカーのセッションを止める・重い全体のテストの時間帯（P3） | セッションの停止は利用者の作業に触れる。**kill の経路は明示の instance を必須にし**（kill-session の API は query の cliTool・instance が無いと worktree の全セッションを止める〔運用の記録〕）、未送信の入力欄があるセッションを止めない条件を設計に書く |

### 9.2 PR1 の範囲（そのまま実装の契約にできる粒度）

**変更するファイル**（scope.allow）:

- `scripts/orchestrate/resource-sem.mjs`（新規）— `acquireSlots`・`readSemState`・`effectiveCapacity`（§2.3.1 の純関数）・`gateNext`（門の純関数）・`orderWaiters`（並べの純関数。同じ token の保有者を持つ待ち手・壊れた待ち手を除く）・`holderRetirable`（§2.5 の保有者の判定。グループと先頭の起動時刻）・`waiterRetirable`（`ticketRetirable` を呼ぶ）。試験の注入点 `hooks`（`now`・`sleep`・`loadavg`・`startOf`・`pidAlive`・`groupAlive`・`pgidOf`・`fault`・`afterCount`〔和を数えた後・`link` の前。`machine-lock-sync.mjs` の `beforeLink` と同じ形〕・`afterAdmitLink`〔入った後・待ち手を消す前〕）
- `scripts/orchestrate/resource-config.mjs`（新規）— `loadResourceConfig({ path, env })` → `{ S, C, ncpu, loadCeiling, loadResume, configHash, warnings }` か `{ error }`
- `scripts/orchestrate/resource.mjs`（新規）— CLI `status [--json]`・`run --priority --weight --reason [--repo] [--timeout] -- <cmd>`（§2.3.2 の exit と stderr の表）
- `tests/unit/scripts/orchestrate/resource-sem-4370.test.ts`・`resource-config-4370.test.ts`・`resource-cli-4370.test.ts`（新規）
- `tests/setup.ts`（`CM_RESOURCE_CONFIG` に pid ごとの一時パスの既定を足す。`CM_VERIFY_LOCK_ROOT` の隣）
- `tests/unit/config/codex-home-isolation-4146.test.ts`（`PINNED` に `'CM_RESOURCE_CONFIG'` を足すだけ。既存の `it`／`describe` は変えない）
- `docs/orchestrate/ci-merge.md`（`## 6-1-1 重い検証の資源制御と待ちの記録` の後ろに #4370 の節を足す。#4369 の節とは別。X5）
- `docs/design/resource-4370.md`（実装で実コードに合わせた点を §10 として足す）
- `changelog.d/4370.md`（既存の 1 項目へ統合）
- 触らない: `machine-lock-sync.mjs`・`machine-lock.ts`・`verify-run.sh`・`precheck.mjs`・`merge-pr.mjs`・`.commandmate/verify.yaml`・`src/**`

**受入基準**（PR1。範囲は §2.1 の「宣言した処理の帳簿」）:

1. 帳簿: weight 2 の `run` を C=3（設定 `ncpu`・`share`・`ci_vm`・`cpu_heavy` で作る）で 2 本同時に起こすと、2 本目は 1 本目の解放まで子を起動しない（子が書く開始・終了の時刻で重ならない）
2. 優先度: P2 の待ち手が先にいても、後から来た P0 が先に入る。P0 が入るまで後ろの P3 は入らない（詰め込みなし）。同じ優先度は番号の順
3. 門: `loadavg` の注入で ceiling 以上なら P2・P3 は入らず P0・P1 は入る。resume を下回ると P2 が入る。間の値では前の状態のまま
4. 回収: グループが空になった保有者は次の周期で回収され `events` に `reclaim`。グループが生きていれば、`run` の pid が死んでも、pid が再利用されても回収しない。観測が不明なら回収しない
5. 待ちの記録: 入ったときの `waitedMs` が保有者の記録・`events.jsonl`・`run` の stderr の 1 行に出る
6. 拒否: `weight > C`・明示値で `C < 1`・壊れた YAML・違う `version`・`pgid` の指定は exit 2（`resource: refused …`）で、待ち手・保有者の記録を書かない。同じ版の知らない鍵は警告で続く
7. 解放の 1 回きり: 2 回目は `none`、他人の token の記録を消さない
8. 既存を弱めない: `cpu.heavy.lock` を別に取っている間も `run` は入れ、`cpu.heavy.lock` の中身・札は変わらない（I9）
9. 消し損ねた待ち手: 入った後の待ち手の削除が失敗しても、後ろの待ち手は空きがあれば入る（A）
10. グループ: `run` の子は `run` と同じグループで、呼び手のグループへの SIGKILL で子も終わる。`run` への SIGTERM は子へ届き、終了の後に枠が返る（B）
11. C の一致: C の違う 2 つのプロセスが混ざっても、和は小さい方の C を超えない（C）
12. 既定: 設定が無ければ、ncpu 4・8・28 のどれでも C ≥ 1 で `run` が入る（D）
13. 測る: 待ち手 20 を一時の root で回したときの `ps` の起動の回数と所要を、PR の本文に記録する（合否には使わない。P3-11）

**試験の表**（`it.each` の行の形。陽性の対照は**注入点で競合・失敗を起こす**か、**1 回限りの変異の確認**〔素朴な版を一時に作って赤を見たことをコミットの本文に記録し、製品のコードに切り替えを残さない〕で示す。P3-2）:

| # | 入力 | 状態 | 期待 | 対照 |
|---|---|---|---|---|
| T1 | P2 w2 ×2、C=3 | 空 | 2 本目は待ち、1 本目の解放の後に入る | 陽性: `afterCount` で 2 本目の受付を 1 本目の `link` の前に割り込ませても 2 本とも入らない（ロックの外で数える変異は 1 回限りの確認） |
| T2 | P2 w1 ×3、C=3 | 空 | 3 本とも入る | 陰性 |
| T3 | P3 → P2 → P0 の順に到着、C=1、保有者 1 | 満杯 | 解放の後 P0 → P2 → P3 | 陽性: 到着順だけの変異（1 回限り） |
| T3b | 同じ P2 ×3 | 満杯 | 番号の順 | — |
| T4 | P0 w3・後ろに P3 w1、C=3、保有 w1 | 2 空き | P3 も入らない | 陽性: 詰め込みの変異（1 回限り） |
| T5 | P2、load1 = ceiling | open | closed、入らない | — |
| T6 | P0／P1、load1 = 2×ceiling | closed | 入る | 陰性 |
| T6b | 門 closed で先頭が P2、後ろに P0 が来る | closed | P0 が先頭になって入る | 陰性 |
| T7 | load1 = 0.9×ceiling | closed | closed のまま | 陽性: 揺れ止め無しの変異（1 回限り） |
| T7b | load1 = 0.9×ceiling | open | open のまま | — |
| T7c | load1 = ちょうど resume×ceiling | closed | closed のまま | — |
| T8 | load1 = 0.8×ceiling | closed | open、P2 が入る | — |
| T9 | `loadavg` = [0,0,0] | — | 門は open | 陰性 |
| T10 | 保有者のグループが空（`groupAlive` ESRCH） | 保有 | 回収 | — |
| T11 | 保有者の pid は死、グループ生 | 保有 | 回収しない | — |
| T12 | `kill -0` EPERM（注入）の保有者 1 件、他に空き | 保有 | その保有者は生きているとして数え、空きがあれば入る。回収しない | — |
| T13 | 保有者の `run` の pid が再利用（`startOf` で新しい）、グループ生 | 保有 | 回収しない | 陽性: `ticketRetirable` をそのまま保有者に使う変異（1 回限り） |
| T14 | 壊れた保有者の記録 | — | C を占めるとみなし入らない、`corrupt` は全体で 1 回 | — |
| T15 | 別の host の保有者・待ち手 | — | 保有者は回収しない、待ち手は期限＋`OTHER_HOST_GRACE_MS` で回収 | 陰性 |
| T16 | `timeoutMs` 切れ | 待ち | 待ち手が消え `reason:'timeout'`、`run` exit 3・stderr `resource: timed out`、子は起動しない | — |
| T16b | `timeoutMs` = 0、空きあり／なし | — | 1 周期で入る／`timeout` | — |
| T16c | 受付のロックが期限まで取れない（`fault`） | — | `reason:'unknown'`・exit 3・stderr `resource: unknown` | — |
| T17 | 解放 ×2 | 保有 | `released` → `none` | — |
| T18 | 他人の token の記録が自分の名前に（作為） | — | 消さない | — |
| T19 | `weight` = C+1・0・小数・`pgid` の指定 | — | `refused`・exit 2、記録なし | — |
| T20 | `resource.yaml` 無し | — | 既定（share 0.4）で入る | 陰性 |
| T21 | 壊れた YAML／違う `version`／明示値で `C < 1`／範囲の外の値 | — | exit 2、理由を名指す | — |
| T21b | 同じ版の知らない鍵 | — | 警告で続く | 陰性 |
| T22 | `events.jsonl` の名前に同じ名前のディレクトリを置く | — | 取得は成功、stderr に警告（P3-3） | — |
| T22b | `events.jsonl` が 10 MB 超 | — | `.1` へ回して新しく書く | — |
| T23 | `cpu.heavy.lock` を別に保有 | — | `run` は入る、`cpu.heavy.lock` の owner・札は前後で同じ | 陰性（I9） |
| T24 | 予約の欄を `--reason` などで渡そうとする | — | 記録の `pid`・`pgid` は自分のまま | 陰性（I7） |
| T25 | 待ち手 X の記録が残り、同じ token の保有者 X がいる | 保有 X | 後ろの Y は空きがあれば入り、X の待ち手は消える | 陽性: `afterAdmitLink` で X の待ち手の削除を失敗させ、除く処理を外した変異で Y が入らない（1 回限り）（A） |
| T26 | `run` が入った直後・子の起動の前に死ぬ（注入）、呼び手のグループは生 | 保有 | 回収しない。グループが空になってから回収 | —（B） |
| T27 | 親は死、グループ生、親の pid の起動が新しい | 保有 | 回収しない | —（B） |
| T28 | グループが空になり、同じ番号の先頭の起動が `leaderStart` より新しい | 保有 | 回収する | —（B） |
| T29 | 実プロセス: `run` の呼び手のグループへ SIGKILL | 保有 | 子も終わる | 陽性: 子を `detached` で起こす変異で子が残る（1 回限り）（B） |
| T30 | 実プロセス: `run` へ SIGTERM | 保有 | 子へ届き、子の終了の後に枠が返る。exit 143 | —（B） |
| T30b | 子がシグナルで終わる・子の起動の失敗 | 保有 | 128＋番号・127（`resource: spawn failed`）、どちらも枠は返る | — |
| T31 | プロセス a は C=3、b は C=2。a が w2 を保有、b の待ち手 w1・a の次の待ち手 w1 | — | どちらも入らない（有効な C は 2） | 陽性: 各自の C で入る変異（1 回限り）（C） |
| T31b | 小さい C のプロセスが居なくなった後 | — | 有効な C が `own` へ上がる | —（C） |
| T32 | 待ち手の weight が新しい（小さい）C を超える | 待ち | その待ち手は `refused` で消え、後ろが詰まらない | —（C） |
| T33 | `ncpu` ∈ {4, 8, 28} × 設定 {無し, share 0.5・ci_vm 8・cpu_heavy 4} | — | 無し: C = 1・1・7 で入る／あり: exit 2・exit 2・C 2 | 陽性: yaml の例の値を既定にする変異で 28 が exit 2（1 回限り）（D） |
| T34 | `state.json` が壊れている | 待ち手あり | 門は closed、新しい待ち手の番号は既存の最大＋1、同じ優先度の先客を追い越さない | —（P3-4） |
| T35 | 壊れた待ち手の記録が番号の先頭にある | — | 並べに入らず後ろが入る。消さない。自分の記録なら作り直す | —（P3-5） |
| T36 | holders の一覧の失敗（`fault`） | — | 回収も受付もしない、`unknown` 1 回 | — |
| T37 | 保有者の `link` が EEXIST（`fault`） | 待ち | 入らない、自分の tmp だけ消す | — |
| T38 | host 名が変わった後の自分の古い記録 | — | 回収しない、`status` が名指す（F6） | — |
| T39 | `CM_RESOURCE_CONFIG` を外から渡した値のまま setup を通す | — | setup の後は一時パス（`PINNED` の既存の試験が固定） | —（P3-13） |

試験は `fs.mkdtempSync(os.tmpdir())` の root（`CM_VERIFY_LOCK_ROOT`）と `CM_RESOURCE_CONFIG` で隔離し、`afterEach` で消す。論理 CPU 数は設定の `ncpu` で決める（CLI に別の口を作らない）。`loadavg`・`startOf`・`pidAlive`・`groupAlive`・`pgidOf`・`now`・`sleep`・`fault` は `acquireSlots` の `hooks` で注入する。子プロセスを使う試験（T1・T26 の一部・T29・T30・T30b）は短い `sleep` の子で、終了を待ってから消す。

**gates**: `lint`・`typecheck`・`unit-related`（scope は上のファイル）、加えて `work-evidence`・`scope`・`env-clean`。確かめのコマンドは `npx vitest run tests/unit/scripts/orchestrate/resource-*-4370.test.ts tests/unit/config/codex-home-isolation-4146.test.ts tests/unit/guards tests/unit/docs`。

**未決（誰が決めるか）**:

- `commandmate_share` を 0.5 にするか（人。§6.2。PR1 は 0.4 の既定で動く）
- `weights.cpu_heavy` の 4 が妥当か（#4367 の計測の後にリーダー。PR1 は既定の式で動く）
- 先頭以外の周期 5 秒が十分か（受入基準 13 の測りの後にリーダー）

**PR1 の後に残ること**: 呼び手は CLI `run` だけで、precheck・merge-pr・verify の `cpu.heavy` はまだ枠を通らない（PR2a・PR2b・PR3）。受入条件 3（ランナー）・4（CI の段を飛ばす）は PR4・PR6。

---

## 改訂の履歴

- 第 2 版（2026-11-14）: 2-4-4 事前レビュー（claude-5、P2 7・P3 14）とリーダーの突き合わせ（X1〜X7）を反映。A 消し損ねた待ち手を先頭の前に除く、B `run` の子を呼び手のグループに残し記録をグループと先頭の起動時刻で 1 回で書く、C 有効な C を `state.json` で一致させる、D 既定値の表とどの ncpu でも C ≥ 1、E CI 待ちは枠の外、F・G は I13・I14 と PR2a/2b/3a/3b/3c の条件、P3 は PR1 の範囲と試験 T25〜T39 へ（飢えは仕様として受け入れ、PR7 の kill の条件は §9.1）、コントローラーの置き場所を `scripts/orchestrate/` へ（X1）、events は #4367 が読む（X3）
