# マシンの資源の受付と配分（Issue #4370）— 設計

- 状態: 設計（第 3 版。2-4-4 事前レビュー・再レビュー・原因調査と段 3 の突き合わせ〔`s3-crosscheck.md` X1〜X10〕を反映。末尾の改訂の履歴）。§9.2 の PR1a（設定・純関数・読み取りだけの `status`）を実装した（実装で合わせた点は §10）。PR1b 以降は未着手
- 最上位の不変条件は §3.1 の U1〜U3（観測から決める・足すときだけ判定する・枠は最も内側）
- 親: Epic #4371（流れの計測と制御）の子 4。共通の枠は段 3 のリーダーの決定（`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`、以下「共通の枠」）に従う
- 前提の Issue: #1917（`cpu.heavy`）、#3884（precheck の重い段・待ちの記録）、#4265（`--heavy-to-ci`）、#4277（札の先着順）、#4288（lease の規則と前提 P0・P1）
- 行番号は 2026-11-14 の `origin/develop`（`a334a013f`）のもの。名前で引くこと
- 本書では **事実**（コード・記録・設定で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**を分ける（§8 に一覧）

---

## 0. 結論

| 問い | 決めた向き | 一言の理由 |
|---|---|---|
| 全体の上限 | `~/.commandmate/resource.yaml` の `commandmate_share`（既定 0.4）× 論理 CPU 数を **全体の枠 S** とする。S を「CI の VM の割り当て（`ci_vm.cpus`、既定 0＝不明）」「`cpu.heavy` の予約（`weights.cpu_heavy`）」「ホストの枠 C」に分け、C を新しいセマフォが数える。既定値はどの論理 CPU 数でも C ≥ 1（§2.7） | macOS に cgroup が無い。CI は Docker の VM で硬く、ホストの処理は受付で守る。セマフォが守るのは**宣言した処理の帳簿**で、mutex の無いゲート・エージェント自身などは load の門で間接に見る（§2.1） |
| 枠の仕組み | 既存の machine-lock（`machine-lock-sync.mjs`）を**壊さずに使う**。短い**受付のロック** `cpu.sem.admit` の中でだけ保有者の記録（`<root>/cpu.sem/holders/<token>.json`）を読み・回収し・足す。枠の待ちは優先度つきの札（`waiters/`）。先頭だけが入る。判定に使う C は**同じ受付の臨界区間で一覧した公開済みの参加者の `ownCapacity` の最小**（小さい制約は公開の時点から効く。`state.json` は写しで判定に使わない。読めなければ受付を止める。§2.3.1） | 排他・札・回収・三値の観測・lease の規則（pid と世代）をそのまま再利用できる。保有者の記録の追加と削除が 1 つの臨界区間に入るので「数えてから足す」の競合が無い |
| 既存の `cpu.heavy` | PR1・PR2 では**触らない**（読みもしない）。代わりに `weights.cpu_heavy` を S から**常に予約**する。PR3a・PR3b で取り手をセマフォへ移す間も `cpu.heavy` を先に取り（枠が内側。U3）、予約は `cpu.heavy` だけの取り手が残っていないと確かめた後の PR3c で外す（I13） | `cpu.heavy` は 3 実装（TS・bash・同期 JS）が同じ規約で取る。PR1 でセマフォがそれを数えるだけにすると、セマフォが満ちた後に `cpu.heavy` が取られて S を超える。常の予約なら宣言した処理の帳簿（I1）が成り立つ。予約が 0 になるマシン（既定の ncpu 4）では `cpu.heavy` の分は帳簿の外 |
| 優先度 | P0 マージの判定（ホストでの組み合わせ確認）＞ P1 PR 向けのホストの処理 ＞ P2 ワーカーの検証 ＞ P3 背景。CI（VM の中）・merge のロック・`cpu.heavy` の待ちの間は枠を持たない（枠は最も内側で取り、最初に返す。U3・§7.1）。**始める順だけ**優先し、走っているものは止めない（P0 も走っている P2 の終了は待つ。P0 だけの予約は採らず人の判断へ。§6.2）。後ろの小さい要求が先頭を追い越す「詰め込み」はしない | 詰め込みは重い P0 を飢えさせる。止めないのは Issue の仕様 |
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
<root>/cpu.sem/waiters/<P>-<12 桁>.json   待ち手 1 件 = 1 ファイル（P は 0〜3。tmp → link。使い終わりは done を rename で被せる）
<root>/cpu.sem/state.json                 門の状態と、写し（直近の有効な C・設定のハッシュ・次の番号）。tmp → rename
<root>/cpu.sem/events.jsonl               出来事の記録（追記だけ。#4367 が読む。X3）
<root>/cpu.sem/events.jsonl.1             回転した 1 世代前
```

`<root>` は machine-lock と同じ（`CM_VERIFY_LOCK_ROOT` で移る。`tests/setup.ts:287` が試験の既定を一時 dir にしている）。PR1a はこの形を**読むだけ**で、作るのは PR1b。

**名前の規則（事前レビュー 3 の H1）**: 参加者のファイルは保有者 `holders/<token>.json`（token は UUID。`^[0-9a-f-]{36}\.json$`）、待ち手 `waiters/<P>-<12 桁>.json`（`^[0-3]-\d{12}\.json$`）だけ。書き途中の tmp は先頭を `.` にした名前（例 `.tmp-<token>`）にし、規則に合わないので一覧の対象外（machine-lock の札が `TICKET_PATTERN` で tmp `.t-<token>` を外すのと同じ形）。`resource-sem.mjs` の `HOLDER_NAME_PATTERN`・`WAITER_NAME_PATTERN`。

容量の 2 つの値（C2 の原因調査 §3.3 の区別）:

- **`ownCapacity`**: その参加者が自分の設定から計算した C。**公開する設定上の制約**で、記録に書いた時点（待ち手・保有者の `link`）から他の参加者の受付に効く
- **`admittedCapacity`**: 保有者が受付のときに採った有効な C。**結果**であって、次の受付の入力にしない（低い採用値が引き継がれて上がらなくなるのを避ける）

保有者の記録: `{ v:1, token, pid, host, pgid, leaderStart, createdAt, priority, weight, ownCapacity, admittedCapacity, reason, repo?, waitedMs }`。
- `pid` は書いたプロセス自身（#4288 I1-b）。`pgid` は書いたプロセスの**今のグループ**（`ps -o pgid= -p <pid>` で読む。呼び手が名指すことはできない）。`leaderStart` はグループの先頭（pid＝`pgid` のプロセス）の起動時刻（`processStartMs`。先頭が既に居なければ `null`）
- `reason`・`repo` 以外の欄は呼び手が渡せない（#4288 I1-c と同じ予約の欄に `pgid`・`leaderStart`・`ownCapacity`・`admittedCapacity`・`priority`・`weight` を足す）

待ち手の記録: `{ v:1, token, pid, host, createdAt, deadline, priority, weight, ownCapacity, reason }`。

`state.json`: `{ v:1, gate: 'open'|'closed', copy: { capacity, configHash, next } }`。**判定の根拠にするのは `gate` だけ**（揺れ止めの記憶。読めなければ closed＝安全側）。`copy` は status と events の `capacity` の変化を出すための写しで、受付の判定に使わない。

### 2.3 取得と解放（PR1b。PR1a は §2.3.1 の純関数だけ）

最上位の不変条件（§3 の U1〜U3）が先にあり、手順はそれを満たす 1 つの形。

取得 `acquireSlots({ priority, weight, reason, repo?, timeoutMs })`（`pgid` は受け付けない。渡されたら拒否）:

1. 引数の検査（`priority` ∈ `P0`〜`P3`、`weight` は 1 以上の整数、`timeoutMs` は 0 以上の整数）と設定の読み。外れたら何も書かずに `{ acquired:false, reason:'refused', detail }`
2. 受付のロックを取り（予算 `ADMIT_LOCK_TIMEOUT_MS` = 10 秒）、その中で holders・waiters を一覧し、**有効な C（§2.3.1）を自分の `ownCapacity` も入れて計算**し、`weight` が有効な C を超えるなら公開せずに `refused`。超えなければ番号 `max(既存の待ち手の番号) + 1`（待ち手が無ければ `copy.next` か 1）で待ち手の記録を公開し、ロックを返す
3. 周期ごとに受付のロックを取り（先頭は 1 秒、先頭でない待ち手は 5 秒）、その中で:
   1. holders・waiters を一覧する。一覧そのものが失敗したら、この周期は何もしない
   2. 回収（§2.5）
   3. 保有者の記録と同じ token の待ち手を除いて使用済みにする（入った後に消し損ねた待ち手。ロックの中なら誰が行ってもよい。A）
   4. 有効な C を**この臨界区間で一覧した公開済みの参加者から**計算する（§2.3.1）。`unknown` なら、この周期は入らない
   5. 門を更新（§2.4）
   6. 生きている待ち手を `(priority, 番号)` で並べる
   7. 自分が**先頭**で、`Σ保有者の weight + 自分の weight ≤ 有効な C` で、門が開いているか自分が P0・P1 なら、保有者の記録を `link` の排他で作り（`admittedCapacity` = 有効な C）、自分の待ち手を使用済みにする（入った）
   8. 自分の weight が有効な C を超えていれば、自分の待ち手を使用済みにして `refused`（C が下がった。I10）
4. 期限を過ぎたら、受付のロックの中で自分の待ち手を使用済みにして `{ acquired:false, reason:'timeout', waitedMs }`。受付のロックが期限まで一度も取れなかった・観測が不明のまま期限なら `reason:'unknown'` と `unknown: { point, path, code }`。`timeoutMs` = 0 は 1 周期だけ試す
5. root の作成の失敗（EACCES など）も `unknown`（`point: 'root'`）。`acquireSlots` は**予期した失敗で throw しない**

待ち手の「使用済み」: machine-lock の札と同じく、`{ done:true, token, doneAt }` を tmp → `rename` で被せる（`machine-lock-sync.mjs:431-445` `markDone`）。消せなくても、読み手は `done` を生きた待ち手に数えない。後片付けの削除は受付のロックの中で誰が行ってもよい。

返り値（入れた）: `{ acquired:true, token, waitedMs, capacity, release(): 'released' | 'none' }`。

解放 `release()`: **順は「自分の待ち手（残っていれば）を使用済みにする → 自分の保有者の記録を消す」**（再レビュー P3-1。逆順で待ち手の処理に失敗すると、保有者の無い生きた先頭が残る）。保有者の記録は `token` と `pid` が自分のときだけ消す。1 回きり（2 回目は `none`）。受付のロックは取らない。

#### 2.3.1 有効な C（純関数。PR1a）

`effectiveCapacity({ own, participants })` → `{ state:'ok', capacity }` か `{ state:'unknown', point }`:

- `participants` は、**同じ受付の臨界区間で一覧した**、生きていて `done` でない待ち手と保有者（回収の後）。`own` は呼んだプロセスの `ownCapacity`
- `capacity = min(own, participants の ownCapacity)`。`admittedCapacity` は入力にしない
- 参加者のうち 1 つでも `ownCapacity` が読めない（壊れた記録・欄が無い・数でない）・一覧が不完全なら `unknown`。**`unknown` を `own` や写しの値で置き換えない**（受付を止める）
- `state.json` の `copy.capacity` は入力にしない（写しの欠損・破損・古い値は判定に効かない）
- 下げる: 小さい `ownCapacity` の待ち手が**公開された時点**から、次の誰の受付にも効く（自分の周期を待たない）
- 上げる: 小さい `ownCapacity` を持つ最後の参加者が消えた（回収・解放・使用済み）次の受付から上がる。採用値の低い保有者が残っていても上がる（保有の和は I1-b で別に守る）

`admissible({ capacity, holders, waiter, gate })` → `true | false`: `Σholders.weight + waiter.weight ≤ capacity` かつ（`gate === 'open'` か `waiter.priority` ∈ {P0,P1}）。保有の和に入れる保有者は生きているもの・観測が不明なもの・壊れたもの（壊れたものは `capacity` を占める）。

#### 2.3.2 `run`（PR1b の CLI）

`resource.mjs run --priority P2 --weight 2 --reason <文> [--repo <slug>] [--timeout <秒>] -- <cmd...>`:

- 子は `run` と**同じプロセスグループ**で起こす（`detached` にしない）。呼び手がグループへ送る停止（gate-runner の時間切れは `detached` のゲートのグループへ SIGTERM → SIGKILL。`gate-runner.ts:693`・`:723`）は子にも届く
- `run` が SIGTERM・SIGINT・SIGHUP を受けたら子の pid へ渡し、子の終了を待ってから解放する（`merge-pr.mjs:1148` `FORWARDED_SIGNALS` と同じ 3 つ）
- 保有者の記録は**子の起動の前に、`link` の 1 回で全部を書く**
- exit（再レビュー P3-3 で 1 つに決めた）: **子の終わり方だけで決める**。子が exit code で終われば その値、子がシグナルで終われば 128＋番号。`run` 自身が SIGTERM を受けたかどうかは exit に混ぜない（子が SIGTERM を捕まえて 0 で終われば 0）。`run` 自身の失敗は stderr の決まった 1 行で区別する:

| 場合 | exit | stderr の 1 行 |
|---|---|---|
| 入れた | 子の値／128＋番号 | `resource: admitted <P> weight=<w> waited=<秒>s capacity=<C>` |
| 引数・設定の誤り・C を超える weight | 2 | `resource: refused <理由>` |
| 期限切れ | 3 | `resource: timed out <P> weight=<w> waited=<秒>s` |
| 観測不明のまま期限 | 3 | `resource: unknown point=<点> path=<パス> errno=<符号>` |
| 子の起動の失敗 | 127 | `resource: spawn failed <errno>`（枠は返す） |

exit 3 はこの CLI だけの値で、launch-worker・publish-pr へは伝えない（X4）。

#### 2.3.3 `status`（PR1a。読み取りだけ）

`resource.mjs status [--json]` は、PR1a の純関数の呼び手（team.md §6-4）。

- 読むもの: 設定（`loadResourceConfig`）・`<root>/cpu.sem/` の holders・waiters・`state.json`・`os.loadavg()`・回収の判定に要る観測（`kill -0`・`ps`。`makeObserver` の三値）
- 出すもの: S・自分の C（`own`）・観測した有効な C（`effectiveCapacity` の結果。`unknown` ならその点）・保存された門（`state.gate`）と `gateNext` の結果（別の欄）・load・保有の和・保有者と待ち手の一覧（並べの順 `orderWaiters`・回収の候補 `holderRetirable`／`waiterRetirable`・次に入れる待ち手 `admissible`）・警告
- 警告: `ci_vm.cpus` が既定（0）のまま、`weights.cpu_heavy` が既定で縮んだ（ncpu 4 では 0）、壊れた記録・別の host の記録・`leaderStart: null` の記録・**pid が死にグループが生きる保有者**（再レビュー P3-2）、写し（`copy.capacity`）と観測した有効な C の食い違い
- **しないこと**: ディレクトリの作成、受付のロックの取得、記録の作成・削除・使用済みにする、回収の実行、`state.json` の修復・門の書き込み、events の書き込み・回転。`<root>/cpu.sem/` が無ければ「参加者なし」と表示し（作らない）、一覧が読めなければ「不明」と表示する（空・安全と表示しない）
- この表示は取得の許可ではない（別の時点の写し）。exit: 0 表示できた／2 設定の誤り／3 一覧が不明

### 2.4 load の門

- `gateNext({ prev, load1, ncpu, ceiling, resume })`（純関数。PR1a）: `prev` が open なら `load1 ≥ ceiling × ncpu` で closed、closed なら `load1 < resume × ceiling × ncpu` で open、それ以外は `prev` のまま（揺れ止め）。`prev` が読めない（`state.json` の欠損・破損）なら closed とみなす。`load1` が 0 で全欄 0（Windows の `[0,0,0]`）なら open
- PR1b は受付のロックの中でこれを呼び、`state.gate` に書く。切り替えは `events.jsonl` に 1 行

### 2.5 回収（lease の規則の流用）

判定は純関数（PR1a: `holderRetirable`・`waiterRetirable`、観測は呼び手が渡す）。消すのは PR1b の受付のロックの中だけ。

| 記録 | 消す条件 | 判定 |
|---|---|---|
| 保有者 | 同じ host で、グループ `pgid` が空（`kill -0 -- -<pgid>` が ESRCH） | `groupAlive`・`makeObserver` の `group` |
| 保有者 | 同じ host で、グループは生きているが、pid＝`pgid` のプロセスの起動が `leaderStart + PID_REUSE_SLACK_MS` より後（番号が別の新しいグループに使われた） | `processStartMs`。`leaderStart: null` の記録には使わない |
| 保有者 | （使わない）pid だけの ESRCH・pid だけの `pid-reused` | グループが生きている間は回収しない |
| 待ち手 | `ticketRetirable` が `gone`・`pid-reused`・`expired` | `machine-lock-sync.mjs:462` |
| 待ち手 | `done` が付いている／同じ token の保有者の記録がある | §2.3 の 3-3 |
| どちらも | 別の host の記録 | 保有者は消さない（生きているとみなす）。待ち手は期限＋`OTHER_HOST_GRACE_MS` |
| どちらも | 読めない・壊れた JSON | 消さない。保有者なら C を占めるとみなす。**どちらでも `ownCapacity` が分からないので有効な C は `unknown`＝受付を止める**（U1）。人が `status` の名指しを見て消す |
| どちらも | 観測が不明（EPERM・`ps` の失敗） | 消さない。保有者は生きているとして数える |

**公開済みの参加者はファイルの水準で決める（事前レビュー 3 の H1）**: 読み手が参加者として数えるのは、§2.2 の名前の規則に合い、`link`（使用済みは `rename`）を終えたファイルだけ。書き途中・落ちた書き手の tmp（規則に合わない名前）は参加者にも壊れた記録にも数えず、`status` が警告で名指すだけ（古い tmp の回収は PR1b が受付のロックの中で行う。`TEMP_MAX_AGE_MS` と同じ考え）。一覧の後に読むまでに消えた記録（`readFile` の ENOENT）は「去った」として扱い、壊れた記録にしない。ENOENT 以外の読みの失敗（EIO・EACCES）と、名前が規則に合うのに JSON として読めない記録が「壊れた記録」。

記録は tmp → `link` で公開するので、公開された記録が途中で切れることは通常の経路では無い。壊れた記録は手で書き換えた・ディスクの故障などの外の出来事で、受付を止めて人へ渡す（第 2 版の「壊れた待ち手は並べに入れず続ける」は、`ownCapacity` を読めないまま有効な C を決めることになり U1 に反するので撤回した）。

POSIX では、生きているグループの番号はプロセスの番号として再利用されない。だから「グループが生きている」の間、その番号が別のグループを指すことは無く、上の 2 行目は「元のグループが空になった後に番号が再利用された」ときだけ当たる。

既知の限り（§5 の F6・F7）: `run` が SIGKILL で死に、子も終わったが、呼び手のグループが生き続けると、枠はそのグループの終わりまで返らない。呼び手がエージェントの CLI やサーバーと同じグループなら何時間にもなりうる（Claude Code の Bash ツールが子をどのグループで起こすかは未確認。§8）。`status` が名指す。

### 2.6 ランナーのコントローラー（PR4）

- 1 台のマシンに 1 つ（`scripts/orchestrate/resource-runners.mjs`。X1）。`resource.yaml` の `runners.repos[]`（`name`・`min`・`max`）と `runners.total_max` を読む
- 60 秒ごと: `docker version`（10 秒で打ち切り）→ 落ちていれば何もしない／リポジトリごとに `docker ps --filter name=ephemeral-runner-<repo>-` の数と、`gh api repos/<o>/<r>/actions/runs?status=queued` の待ちの数・最古の待ち
- 望む台数 = `clamp(min, max, 走っている数 + 待ちのジョブの数)`。合計が `total_max` を超えるなら、P0 の待ち（base への push の run、#4369 の train のブランチの run）があるリポジトリ → 最古の待ちが古いリポジトリの順に配る。load の門が閉じていれば最小台数より上は起こさない
- 起こすのは足りない分だけ（`docker run -d --rm --cpus <runners.cpus> --memory <runners.memory> --name ephemeral-runner-<repo>-<秒>-<乱数> <image>`、トークンは `runners.token_cmd`）。**走っているコンテナは止めない**
- コントローラーは**ホストの枠を取らない**（CI の CPU は VM の中で、`ci_vm.cpus` として S から既に引いてある。X10）
- 5 分ごとの健康: `docker version`・online 数・最古の待ちの秒数を `events.jsonl` と #4367 の警報へ。Docker が 3 回続けて落ちていれば警報。再起動は `health.docker_restart`（既定 `notify`）
- 常駐: launchd の LaunchAgent（`KeepAlive: true`、`RunAtLoad: true`）。Docker が落ちている間も生きて待ち、起きた最初の周期で最小台数を起こす → **5 分以内に online**（受入条件。登録まで約 1 分は 2026-10-02 の実測〔運用の記録〕）

### 2.7 `resource.yaml`

既定値の表（PR1a が読む鍵は太字）:

| 鍵 | 単位 | 既定 | 検査 |
|---|---|---|---|
| `version` | — | 1 | 1 以外は exit 2 |
| **`ncpu`** | コア | `auto`（`os.availableParallelism()`） | 1 以上の整数か `auto`。試験はここで論理 CPU 数を決める |
| **`commandmate_share`** | 割合 | 0.4（Issue のまま。0.5 は人の判断。X7） | 0 < x ≤ 1 |
| **`load_ceiling`** | × ncpu | 1.0 | > 0 |
| **`load_resume`** | × `load_ceiling` | 0.85 | 0 < x < 1 |
| **`weights.cpu_heavy`** | 枠 | `min(4, max(0, S − ci_vm.cpus − 1))`（縮んだら `status` が警告。ncpu 4 では 0） | 0 以上の整数。明示した値で C < 1 なら exit 2 |
| **`ci_vm.cpus`** | コア | 0（＝不明。`status` が「VM の割り当てを書いていない」と警告） | 0 以上の整数 |
| `ci_vm.memory_gib` | GiB | 0（不明） | PR4 |
| `runners.*` | — | 無し（コントローラーは動かない） | PR4 |
| `health.*` | — | `interval_sec: 300`・`docker_restart: notify`・`queued_alert_sec: 600` | PR4 |
| `idle.stop_after_min` | 分 | 0（止めない） | PR7 |

`reserve_p0`（P0 だけが使える予約）の鍵は**作らない**（§6.2 の人の判断。§3 の注）。

既定だけのときの C: ncpu 4 → S 1・cpu_heavy 0・C 1／ncpu 8 → S 3・cpu_heavy 2・C 1／ncpu 28 → S 11・cpu_heavy 4・C 7。**予約が 0 になるマシン（ncpu 4）では、`cpu.heavy` の保有者は帳簿の外**（再レビュー P3-4。I13 の注）。

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
- `version` が同じで知らない鍵は警告（`resource: warn unknown key <鍵>`）にとどめる（マシンで 1 つのファイルなので、新しい版が鍵を足しても古い版が止まらないように）
- 場所は `CM_RESOURCE_CONFIG` で移せる（既定 `~/.commandmate/resource.yaml`）。実在の場所を指す `CM_*` なので、#4163 の方針どおり PR1a で `tests/setup.ts` に一時パスの既定を足し、`tests/unit/config/codex-home-isolation-4146.test.ts:122` の `PINNED` に名前を足す
- `configHash` は読んだ設定の正規化した内容（既定を埋めた後）の sha256

---

## 3. 不変条件

### 3.1 最上位（原因調査 §6。以下の I はこの 3 文を満たす形）

1. **U1（観測から決める）** 受付の決定は、同じ root に公開済みの参加者について、設定上の容量制約（`ownCapacity`）・保有量・順番・門を**同じ受付の臨界区間で確定した観測**から作り、写しの欠損や観測不明を自分の大きい容量へ置き換えて取得の根拠にしない
2. **U2（足すときだけ判定し、縮小では止めて待つ）** 新規保有の追加はその時点の有効な C に対して `Σweight＋要求weight ≤ C` の時だけ許し、要求が有効な C を超えるなら公開前または縮小の検出時に拒否し、既存保有量を下回る縮小では横取りせず追加を止めて排出を待つ
3. **U3（保持区間）** CPU 枠は前提資源が揃ったホストの実行区間だけで保持する。**枠は最も内側で取り、持ったまま別のロック・CI・外部の待ちに入らず、最初に返す**。優先度は実行できる待ち手の開始順として扱い、取得の失敗・期限切れ・不明から処理の開始や合格へ進まない

### 3.2 個別

1. **I1-a（新規の受付の判定）** 宣言した処理の帳簿として、保有者を足すのは、その受付の臨界区間で `effectiveCapacity` が `ok` を返し、`Σ生きている保有者の weight（読めない保有者は C、観測が不明の保有者は生きているとして数える）＋要求の weight ≤ 有効な C` のときだけ。範囲は §2.1 の「数える範囲」に限る
2. **I1-b（縮小の後）** 有効な C が下がって保有の和が新しい C を超えている間は、和が `新しい C − 要求の weight` 以下になるまで誰も足さない（走っている保有者は止めない。I5）。「どの瞬間でも和 ≤ C」は主張しない
3. **I2** 保有者の記録の追加は受付のロックの中でだけ、同じ臨界区間の一覧・回収・有効な C・和の計算の後に行う
4. **I3** 入れるのは、生きていて `done` でなく同じ token の保有者を持たない待ち手を `(priority, 番号)` で並べた先頭だけ。後ろの待ち手は先頭が入るまで入らない（詰め込みなし）。同じ優先度は番号の順
5. **I4** 門が閉じている間、P2・P3 は入らない。P0・P1 は門に依らない
6. **I5** セマフォは走っている保有者を止めない・枠を取り上げない。**P0 の優先は始める順だけで、走っている P2・P3 の終了は待つ**（Issue の「新しく始める順だけ優先、動いているものは止めない」と同じ。P0 の待ちに上限を約束しない）
7. **I6** 保有者の記録を消すのは (a) 本人の解放（token と pid が自分）か (b) 受付のロックの中の回収（§2.5 の正の証拠）だけ。pid だけの死・再利用では消さない。観測が不明なら消さない
8. **I7** 記録の `pid` は書いたプロセス自身、`pgid` はその今のグループ。予約の欄は呼び手が書けない（#4288 I1-b・I1-c）
9. **I8** 入ったときは待ちの時間（`waitedMs`）を記録・`events.jsonl`・`run` の stderr に残す。記録の書き込みの失敗は取得を失敗にしない（警告だけ）
10. **I9** 既存の `cpu.heavy` のロック・札・解放の振る舞いを PR1a・PR1b・PR2 は変えない（読みも書きもしない）
11. **I10** `weight` が有効な C を超える要求は、公開の前（§2.3 の 2）に拒否する。待ちの間に C が下がって超えたら、その待ち手を使用済みにして拒否する（永久に入れない先頭を作らない）
12. **I11** 保有者の記録は `link` の 1 回で作り、書き直さない。待ち手は tmp → `link`、使用済みは tmp → `rename`、`state.json` は tmp → `rename`
13. **I12** 保証は #4288 の前提 P0（手順の途中で 10 分を超えて止まらない。スリープを含む）・P1（壁時計）の下で書く。前提の外の交差は §5 の表に行で名指し、直さない
14. **I13（PR3 の条件）** `weights.cpu_heavy` の予約は、マシンに `cpu.heavy` だけを取る取り手（TS・bash・同期 JS のどれか、別のリポジトリや導入済みの古い版を含む）が 1 つも残っていないと確かめられるまで外さない。セマフォへ移した取り手も、移す途中は `cpu.heavy` も取る（**U3 により `cpu.heavy` が先、枠が内側**）。PR3a と PR3b の境目では予約を外さない。予約が 0 になるマシン（既定の ncpu 4）では `cpu.heavy` の保有者は帳簿の外
15. **I14（PR2・PR3 の条件。U3 から出る）** (1) 枠を待ち切ったら、段を走らせずに HELD・exit 3・SKIP（`reason=mutex-wait` と同じ扱いの理由）のどれかにし、合格・飛ばしには倒さない。(2) 取る順は **merge のロック → `cpu.heavy` → 枠**（枠が最も内側）。枠を持ったまま merge のロック・`cpu.heavy`・CI・再試行の待ちに入らない。枠はホストの実行（tsc・影響テストなど）の直前に取り、実行の直後（CI 待ちの前）に返す。(3) merge のロックを持った P0 は枠を待ってよいが、その待ちは走っている保有の終わりで上が決まり、短いとは約束しない（I5）

注（採らないもの）: P0 だけが使える予約 `reserve_p0` は採らない。C=1（既定の ncpu 4・8）で予約 1 なら P2 が永久に入れない、C=2・予約 1 では weight 2 の P0 を保証できない、など予約の数だけでは閉じない（原因調査 §4.2）。入れるかは §6.2 の人の判断。

---

## 4. 状態と遷移の表

### 4.1 1 つの要求（PR1b）

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| 無し | 取得（引数・設定の誤り・`pgid` の指定） | 無し | 何も書かない。`refused`／exit 2 |
| 無し | 取得（weight が有効な C を超える。公開済みの小さい `ownCapacity` を含む） | 無し | 公開しない。`refused`／exit 2 |
| 無し | 取得（正しい） | 待ち | 受付のロックの中で待ち手の記録（`ownCapacity` つき）。この時点から他者の有効な C に効く |
| 無し | 取得（受付のロックが 10 秒取れない） | 待ち（記録なし） | 次の周期で記録を試す。期限まで |
| 無し | root が作れない | 無し | `unknown point=root`／exit 3 |
| 待ち | 周期: 先頭・`admissible`・門が通す | 保有 | 保有者の記録（`link`、`admittedCapacity`）→ 自分の待ち手を使用済み → `events` `admit waitedMs` |
| 待ち | 周期: 先頭でない／空きなし／門が閉じて P2・P3／I1-b の排出待ち | 待ち | なし（先頭でなければ周期 5 秒） |
| 待ち | 周期: 一覧の失敗・壊れた記録・`ownCapacity` 不明 | 待ち | 回収も受付もしない（`effectiveCapacity` が `unknown`）。`events` に `unknown` を 1 回 |
| 待ち | 周期: 保有者 1 件の生死の観測が不明 | 待ち／保有 | その保有者は生きているとして数え、空きがあれば入る |
| 待ち | 周期: 有効な C が自分の weight より小さい | 無し | 自分の待ち手を使用済み。`refused`／exit 2 |
| 待ち | 期限 | 取消し | 自分の待ち手を使用済み。`timeout`（不明のままなら `unknown`）／exit 3。`run` は子を起動しない |
| 待ち | プロセスの死（SIGKILL） | 待ち（記録だけ残る） | 次の周期で他者が `gone` で回収 |
| 保有（待ち手の消し損ね） | 他者の周期 | 保有 | 同じ token の待ち手は他者が使用済みにする |
| 保有 | 解放（本人） | 解放済み | 残った自分の待ち手を使用済み → 保有者の記録を消す。`events` `release heldMs` |
| 保有 | 解放（2 回目） | 解放済み | なし（`none`） |
| 保有 | `run` が SIGTERM・SIGINT・SIGHUP | 保有 → 解放済み | 子へ渡し、子の終了の後に解放。exit は子の終わり方（§2.3.2） |
| 保有 | 呼び手のグループへ SIGKILL | 回収待ち | `run` と子が同時に終わる。グループが空になれば次の周期で回収 |
| 保有 | `run` だけが死に、グループ（子・呼び手）が生きる | 保有 | 回収しない（I6）。`status` が名指す |
| 保有 | グループが空 | 回収待ち | 次の周期で他者が消す。`events` `reclaim` |
| 保有 | グループが空になり、番号が新しいグループの先頭に再利用 | 回収待ち | `leaderStart` との比較で消す |
| 保有 | 記録が外から消された（人の操作） | 保有（記録なし） | 解放は `none`。帳簿はその間崩れうる（§5 F4） |

### 4.2 門（`gateNext`）

| 状態 | 出来事 | 次 | 副作用（PR1b） |
|---|---|---|---|
| open | `load1 ≥ ceiling` | closed | `events` `gate closed load=` |
| open | `load1 < ceiling`（resume と ceiling の間を含む） | open | なし |
| closed | `load1 < resume × ceiling` | open | `events` `gate open load=` |
| closed | `load1 ≥ resume × ceiling`（ちょうど resume を含む） | closed | なし |
| 読めない | どれでも | closed とみなす | P2・P3 を入れない。書き直しは次の受付で |

### 4.3 有効な C（`effectiveCapacity`）

| 参加者（同じ臨界区間で一覧） | 結果 | 備考 |
|---|---|---|
| 無し | `own` | 一覧が完全なときだけ |
| `ownCapacity` が全部読める | `min(own, 全員の ownCapacity)` | 小さい値は公開の時点から効く。写し・`admittedCapacity` は使わない |
| 小さい `ownCapacity` の参加者が全部去った | 残りの最小（上がる） | 低い `admittedCapacity` の保有者が残っていても上がる。和は I1-b |
| 1 つでも `ownCapacity` が読めない・一覧が不完全 | `unknown` | 受付を止める（U1） |
| `state.json` が欠損・破損・古い | 影響しない | 写しなので |

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
| 受付のロック（machine-lock、PR1b） | 10 秒で取れない・unknown | **fail-closed**: その周期は入らない（待ちに数える）。期限まで続けば `unknown` |
| root の作成（PR1b） | EACCES など | fail-closed: `unknown point=root`。throw しない |
| root が無い（`status`） | — | 「参加者なし」と表示。作らない |
| holders／waiters の一覧 | EACCES・EIO | fail-closed: 有効な C は `unknown`、回収も受付もしない。`status` は「不明」と表示し exit 3 |
| 記録の読み（保有者・待ち手） | 壊れている・`ownCapacity` が無い | fail-closed: 有効な C は `unknown`（U1）。保有者は C を占めるとみなす。人が消す |
| 保有者 1 件の生死の観測（`kill -0`・`ps`） | EPERM・ps の失敗 | その保有者は生きているとして数え、他の判定は続ける |
| 待ち手の記録の作成（tmp → `link`） | 失敗 | 自分の tmp だけ消し、次の周期で作り直す |
| 保有者の記録の作成（`link`） | EEXIST・ENOSPC | 入らない。自分の tmp だけ消す |
| 自分の待ち手を使用済みにする（入った後・解放のとき） | 失敗 | 他者が先頭を決める前に同じ token の保有者で除く（入った後）。解放は待ち手を先に処理し、失敗しても保有者を消す前なので先頭に残らない（他者が同じ token で除く）。保有者を消した後に待ち手が残る順は作らない |
| `state.json` の書き込み（tmp → `rename`） | 失敗 | 前の内容が残る。門は前の状態。写しの古さは判定に効かない |
| `state.json` の読み | 壊れている・無い | 門は closed。有効な C・番号には効かない（番号は待ち手の最大＋1） |
| `ps -o pgid=`（取得の前） | 失敗 | 入らない（`unknown point=pgid`） |
| `os.loadavg()` | 0 を返す環境 | **fail-open**（門を開ける）。帳簿は効く |
| `events.jsonl` の追記・回転（PR1b） | 失敗 | **fail-open**: stderr に警告、取得・解放は続ける（I8）。10 MB を超えたら受付のロックの中で `events.jsonl.1` へ `rename`（1 世代） |
| `resource.yaml` | 無い | 既定値（どの ncpu でも C ≥ 1） |
| `resource.yaml` | 壊れている・誤り・明示値で C < 1・違う版 | fail-closed: exit 2 |
| `resource.yaml` | 同じ版で知らない鍵 | 警告して続ける |
| 子のコマンド（`run`） | 起動の失敗 | 枠を返して exit 127 |
| 子のコマンド（`run`） | シグナルで終わる | 枠を返して 128＋番号 |
| `docker version`・`docker run`・`gh api`・launchd（PR4） | 失敗 | §4.4 のとおり |

前提の外・既知の限り（直さない）:

| 行 | 形 | 前提 |
|---|---|---|
| F1 | 受付のロックを持ったまま 10 分を超えて止まった書き手の再開。macOS のスリープは全プロセスを 10 分以上止めて壁時計を進めるので、現実の入口になる（`EMPTY_OWNER_GRACE_MS`、`machine-lock-sync.mjs:58`） | P0 |
| F2 | 先頭の起動から記録までの間の壁時計の後退で、グループの番号の再利用の判定が誤る | P1 |
| F3 | 別の host の記録（同じ `~/.commandmate` を共有する構成）は回収しない | 構成の外 |
| F4 | 人が保有者の記録を手で消した | 運用。`status` が和の変化を出す |
| F5 | `ci_vm.cpus` が Docker Desktop の実際の値と違う | 人の操作の誤り。読み手は VM を見ない |
| F6 | host 名の変化（macOS はネットワークで変わりうる）: 自分の古い記録が「別の host」になり回収されない | 既知の限り。`status` が名指し、人が消す |
| F7 | `run` が SIGKILL で死に子も終わったが呼び手のグループが生き続ける（枠は呼び手の終わりまで返らない）／取得の時に先頭が居なかった（`leaderStart: null`）グループが空になり番号が再利用された | 既知の限り。`status` が「pid が死にグループが生きる保有者」「`leaderStart: null`」を名指す。PR2 で同じプロセスの中から取るときは U3（実行の直後に返す）で寿命を実行区間に限る |

---

## 6. 人の操作・人の判断

### 6.1 人の操作（導入。この run の範囲外）

| # | 操作 | いつ | PR に入れるもの |
|---|---|---|---|
| 1 | Docker Desktop の Resources を `ci_vm` に合わせる（推奨の出発点: CPU 8・メモリ 24 GiB） | PR4 の後 | docs の手順 |
| 2 | Docker Desktop の「サインイン時に起動」を入れる（今 `AutoStart: false`） | PR4 の後 | docs |
| 3 | `~/.commandmate/resource.yaml` を書く（`ci_vm.cpus` を書くまで `status` が警告） | PR1a の後（既定で動く） | 雛形（`docs/orchestrate/ci-merge.md` の例） |
| 4 | LaunchAgent を入れる（`launchctl bootstrap gui/$UID <plist>`） | PR4 の後 | plist の雛形 `scripts/orchestrate/launchd/com.commandmate.runner-controller.plist.template`・docs・雛形の形の試験 |
| 5 | 旧コントローラー（`runner.sh` の 8 リポジトリ分）を止め、新しいコントローラーの `repos` へ移す | 4 の後 | 移行の手順の docs |
| 6 | 壊れた記録・別の host の記録・`leaderStart: null`・pid が死にグループが生きる保有者を確かめて消す（`status` が名指す） | 起きたとき | `status` の出力 |

### 6.2 人の判断（推奨 1 つと理由）

| 問い | 推奨 | 理由 |
|---|---|---|
| `commandmate_share` の値（既定は Issue の 0.4。X7） | **0.5**（S 14） | 0.4 だと今の VM の 16 CPU が入らず、VM を 4 まで削ることになる。0.5 なら VM 8・`cpu_heavy` 4・ホスト 2。#4367 の計測で見直す |
| P0 だけが使える予約（`reserve_p0`）を入れるか | **入れない。#4367 の計測で P0 の待ち（`events` の `admit` の `waitedMs`）を見てから決める** | 予約の数だけでは閉じない反例がある（C=1 で P2 が永久に入れない、C=2・予約 1 で weight 2 の P0 を保証できない、`cpu.heavy` を持つ P2 が専用枠の制約で入れない。原因調査 §4.2）。入れるなら最小の C・優先度ごとの最大の weight・貸し出し・旧い取り手・取れないときの返却を一緒に決める。Issue の要求は始める順の優先で、今の I5 で満たす |
| Docker の自動の再起動 | **既定は通知だけ**（`notify`）。`auto` は「3 回続けて落ち、どのリポジトリにも走っているジョブが無い」ときだけ | 再起動は同じ Docker 上の他のリポジトリのランナーとジョブを巻き込む。11-13 の停止の原因は未確認 |
| E2E を別のマシン・GitHub のランナーへ | **E2E の 2 本の shard だけ GitHub のランナー（`ubuntu-latest`）へ試しに移す**（別の PR。1 週間の所要と揺れを #4367 で比べる） | リポジトリは公開で GitHub のランナーは無料。fork の PR では既に `ubuntu-latest`（`ci-pr.yml:699` の式）。E2E は中央値 6.2 分・最長 16.2 分・時間切れ 30 分（`ci-pr.yml:21-22`） |
| 別のリポジトリの処理をセマフォに通すか | **CommandMate が起こすものはリポジトリを問わず通す。外の処理は load の門で見る** | lock root はマシンで 1 つ。外の処理を強制する仕組みは macOS に無い |
| CI の段を手元の verify の結果で飛ばすか（受入条件 4） | **リポジトリごとの明示（`flow.yaml` の `ci_skip: [unit]`）で、既定は飛ばさない**。同じツリー・同じゲート・全体の実行・同じ lockfile の hash の合格だけ。証拠は commit status、必須チェックの名前は変えない | 手元と CI の環境は違い、必須チェックを弱めうる（共通の枠 §5） |
| CI の中の P0 と P1 の順 | **最初は GitHub の割り当て（先着）のまま**。コントローラーは P0 の待ちがあるリポジトリへ先に台数を配るだけ | 使い捨てのランナーはジョブを選べない。ラベルは train（#4369）の形が決まってから |
| 飢え（P2 が続く間 P3 が入らない） | **仕様として受け入れる**。最長の待ちを #4367 の警報の材料にする | 年齢での繰り上げは P0 の優先を崩す |

---

## 7. 他の子への約束

### 7.1 提供（#4370 → 他）

| 相手 | 提供するもの | 形 | いつから |
|---|---|---|---|
| #4367（計測） | 今の状態 | `resource.mjs status --json` → `{ S, ownC, effectiveC: { state, capacity?, point? }, participantsMin: { state, capacity?, point? }, gateSaved, gateNext, load1, used, holders: [...], waiters: [...], order, next, warnings: [...] }`（`participantsMin` は `status` を動かしたプロセスの設定を入れない参加者だけの最小。参加者が無ければ `capacity: null`。事前レビュー 3 の P3-1）。別の時点の写しで、取得の許可ではない | **PR1a** |
| #4367 | 出来事 | `<root>/cpu.sem/events.jsonl`（と回転した `.1`）の 1 行: `{ at, kind: 'admit'\|'release'\|'reclaim'\|'cancel'\|'refused'\|'gate'\|'capacity'\|'corrupt'\|'unknown'\|'health', priority?, weight?, waitedMs?, heldMs?, load1?, capacity?, reason?, repo? }`。#4367 が読む（X3）。**回転は `rename` なので、読み手は `.1` と今のファイルの両方を読み、読んだ位置は inode と offset の組で持つ**（再レビュー P3-8） | **PR1b**（PR1a では書かない） |
| #4369（merge train） | 枠の取得 | 同期 JS `acquireSlots({ priority, weight, reason, repo?, timeoutMs })` → 入れた `{ acquired:true, token, waitedMs, capacity, release() }`／入れない `{ acquired:false, reason: 'refused' \| 'timeout' \| 'unknown', ... }`。throw しない。CLI `resource.mjs run --priority P0 ...` | **PR1b**。#4369 は PR1a の完了だけでは取得へ移れない。PR2b までは merge のロックと `cpu.heavy` のまま |
| #4369 | 優先度の使い方（X10） | **P0 ＝ train・base の、ホストで走る組み合わせ確認（tsc＋影響テスト）の実行区間だけ**。CI（VM の中）・merge のロック・再試行の待ちの間は枠を持たない（U3）。#4369 の契約に「CI 待ち・merge のロックの待ちの間に `cpu.sem/holders` に自分の記録が無い」行を入れてほしい | PR1b |
| #4369 | 保持区間 | 取る順は merge のロック → `cpu.heavy` → 枠（I14 (2)）。枠は実行の直前に取り、直後に返す。P0 の優先は始める順だけで、走っている P2 の終了は待つ（I5） | PR2b から |
| #4368（WIP） | なし | — | — |

終了コード: `resource.mjs` の 3 はこの CLI だけの値（X4）。

### 7.2 利用（他 → #4370）

| 相手 | 使うもの | 足りないもの（#4370 からの頼み） |
|---|---|---|
| #4367 | 警報の書き手（`alerts.jsonl`） | PR4 の健康の警報を書く口。PR1a・PR1b は使わない（X6） |
| #4367 | `.commandmate/flow.yaml` の読み手（`scripts/flow/config.mjs`。X1） | `ci_skip`（PR6）を同じ読み手へ足す |
| #4369 | train のブランチの名前 | コントローラーが P0 の run を見分けるため、`flow.yaml` の `train` の節にブランチの接頭辞を置いてほしい |
| #4368 | 「動いているブランチ数」の関数（X8 の `countWip`） | PR7 が動いているものを止めないために読む。`complete` が偽なら止めない |

共通の枠 §3 の「#4369 の train の CI 待ち・組み合わせ確認は P0」は、X10 と U3 により「ホストでの組み合わせ確認の実行区間だけ P0、CI 待ちは枠の外」と読む（X10 が後の決定）。`docs/orchestrate/ci-merge.md` は #4369 PR1 と #4370 PR1a がそれぞれ別の節を足す（X5）。

---

## 8. 事実と見立て

- **事実**: §1 の file:line、`runner.sh` の行、Docker Desktop の設定の値、論理 CPU 28、online 6、リポジトリが公開。gate-runner はゲートを `detached` で起こしてグループへ停止を送る（`gate-runner.ts:693`・`:723`）。merge-pr の外側は INT・TERM・HUP を内側へ渡す（`merge-pr.mjs:1148`）。`markDone` は `{done:true}` を tmp → rename で被せる（`machine-lock-sync.mjs:431-445`）。`tests/setup.ts:287` が `CM_VERIFY_LOCK_ROOT` を一時 dir にし、`codex-home-isolation-4146.test.ts:122` の `PINNED` が実在の場所を指す `CM_*` を固定する。実プロセスの試験は `tests/helpers/real-shell-budget.ts` の印と `tests/unit/guards/real-shell-test-budget.test.ts` の予算に乗る
- **見立て**:
  - `cpu.heavy` の重さ 4 枠（測っていない。#4367 の計測で直す）
  - E2E が GitHub のランナーで同じように通ること
  - コントローラーで Docker の起動から 5 分以内に online に戻ること（登録まで約 1 分は 2026-10-02 の 1 回の記録）
  - load の門の 1.0 × ncpu・0.85 が揺れずに効くこと
  - 先頭 1 秒・他 5 秒の周期の `ps` の負荷が無視できること（PR1b で測って記録する）
  - §3.1 の U1〜U3 と §4.3 の表で、C2・G2 の反例（原因調査 §3.2・§4.1）が閉じること（手順の上の推論。実装の後に PR1b・PR2 の対照で確かめる）
- **未確認**:
  - 2026-11-13 18:57 の Docker の停止の原因
  - VM の割り当てを 8 に減らしたときの CI の所要
  - `os.loadavg()` が Docker の VM の vCPU の負荷をどこまで含むか
  - macOS での pid・pgid の再利用の頻度
  - Claude Code の Bash ツール・CommandMate のサーバーが子をどのプロセスグループで起こすか（F7 の寿命。その中で `ps -o pid,pgid,command` を見る）

---

## 9. PR の切り方と、この run で実装する PR1a

### 9.1 PR の切り方（危険の境目で分ける）

| PR | 中身 | 境目の理由・条件 |
|---|---|---|
| **PR1a** | 設定の読み手・純関数（有効な C・門・並べ方・回収の判定・受付の可否）・読み取りだけの `status`・試験の隔離（`tests/setup.ts`）・docs の節・試験 | 何も書かない。呼び手は `status`（team.md §6-4）。取得を公開しないので、容量の意味と寿命の未決が実装へ流れない |
| PR1b | `acquireSlots`・`release`・CLI `run`・待ち手と保有者と `state.json` の書き込み・回収の実行・events の発行と回転 | 受付のロック・プロセス・シグナル。§9.3 の条件と表を満たす |
| PR2a | precheck の重い段が P2 の枠を取る。run-log に `slotSec` | **着手条件**: U3 の保持区間を precheck の全経路（段・再試行・待ち切れ）で表にしてから。順は `cpu.heavy` → 枠（I14 (2)）。待ち切れは HELD・exit 3。試験 G02（旧い `cpu.heavy` の保有者 → `cpu.heavy` を待つ P2 → `cpu.heavy` の要らない P0: P2 の待ちが枠を持たず P0 が入る） |
| PR2b | merge-pr の組み合わせ確認が P0 の枠を取る | **着手条件**: 同上を merge-pr の全経路（merge のロック待ち・refresh・precheck・push・CI 待ち・rerun・merge）で。枠は組み合わせ確認の実行の直前に取り、直後に返す。試験 G01（merge のロックを別のマージが持つ間、待っている merge-pr の枠の記録は無く、実行の準備ができた処理が入る）・G05（CPU の実行が終わって CI 待ちに入ると枠の記録が無い。枠の期限切れ・不明でマージへ進まない）・G03（C=1 で P2 が走っている間に P0 と P2 が待つ: 横取りせず、空いたら P0 が先） |
| PR3a | TS（`machine-lock.ts`・gate-runner）の `mutex: cpu.heavy` を「`cpu.heavy` → 枠（P2）」へ（予約は外さない） | verify の裁定の経路。I13・I14。門が閉じている間の P2 は mutex-wait と同じ SKIP に倒す |
| PR3b | bash（`verify-run.sh` の 2 配置）を同上 | skills の写し・sync-map の pin |
| PR3c | 予約を外す | I13 の確かめが揃ってから。人の判断 |
| PR4 | ランナーのコントローラー・launchd の雛形・健康の確認・docs | マシンの外への作用。コントローラーはホストの枠を取らない |
| PR5 | 製品: `src/lib/flow/resource/**`・`commandmate resource status\|acquire\|release`・`GET /api/resources`・画面の帯 | 製品の API と画面。`acquire`／`release` の分かれた形の保有者のグループの規則はここで決める |
| PR6 | CI の段を同じツリーの verify で飛ばす（`ci_skip`、既定は飛ばさない） | 必須チェックに関わる。人の判断の後 |
| PR7 | 遊んでいるワーカーのセッションを止める・重い全体のテストの時間帯 | kill の経路は明示の instance を必須にし（kill-session の API は query の cliTool・instance が無いと worktree の全セッションを止める〔運用の記録〕）、未送信の入力欄があるセッションを止めない |

### 9.2 PR1a の範囲（そのまま実装の契約にできる粒度）

**変更するファイル**（scope.allow）:

- `scripts/orchestrate/resource-config.mjs`（新規）— `loadResourceConfig({ path, env })` → `{ ncpu, S, C, loadCeiling, loadResume, ciVmCpus, cpuHeavy, configHash, warnings }` か `{ error }`
- `scripts/orchestrate/resource-sem.mjs`（新規）— **純関数だけ**: `effectiveCapacity`（§2.3.1）・`admissible`（§2.3.1）・`gateNext`（§2.4）・`orderWaiters`（`done`・同じ token の保有者を持つ待ち手を除き、`(priority, 番号)` で並べる）・`holderRetirable`・`waiterRetirable`（§2.5。観測は引数で受ける: `{ groupAlive, startOf, pidAlive, host, now }` の結果）。ファイルを書く関数・ロックを取る関数・プロセスを起こす関数を置かない
- `scripts/orchestrate/resource.mjs`（新規）— CLI `status [--json]` だけ（§2.3.3）。`run` は置かない（未実装の口も作らない）
- `tests/unit/scripts/orchestrate/resource-config-4370.test.ts`・`resource-sem-4370.test.ts`・`resource-status-4370.test.ts`（新規）
- `tests/setup.ts`（`CM_RESOURCE_CONFIG` に pid ごとの一時パスの既定を足す。`CM_VERIFY_LOCK_ROOT` の隣）
- `tests/unit/config/codex-home-isolation-4146.test.ts`（`PINNED` に `'CM_RESOURCE_CONFIG'` を足すだけ。既存の `it`／`describe` は変えない）
- `docs/orchestrate/ci-merge.md`（`## 6-1-1 重い検証の資源制御と待ちの記録` の後ろに #4370 の節: `resource.yaml` の既定値の表・`status` の読み方・PR1a では枠を取らないこと。#4369 の節とは別。X5）
- `docs/design/resource-4370.md`（実装で実コードに合わせた点を §10 として足す）
- `changelog.d/4370.md`（既存の 1 項目へ統合）
- 触らない: `machine-lock-sync.mjs`・`machine-lock.ts`・`verify-run.sh`・`precheck.mjs`・`merge-pr.mjs`・`.commandmate/verify.yaml`・`src/**`

**受入基準**（PR1a）:

1. 既定: 設定が無ければ、ncpu 4・8・28 のどれでも C ≥ 1（1・1・7）。明示値で C < 1・壊れた YAML・違う `version`・範囲の外は `{ error }`（`status` は exit 2、`resource: refused …`）。同じ版の知らない鍵は警告
2. 有効な C: `effectiveCapacity` は同じ入力の参加者の `ownCapacity` の最小と `own` の min を返し、`admittedCapacity`・写しを入力にしない。読めない参加者・不完全な一覧では `unknown`
3. 受付の可否: `admissible` は `Σ + w ≤ C` と門（P0・P1 は門に依らない）で決まり、縮小の後の超過（和 > C）では誰も入れない
4. 門: `gateNext` の揺れ止めと、読めない前の状態の closed、`[0,0,0]` の open
5. 並べ: `orderWaiters` は優先度 → 番号、`done` と同じ token の保有者を持つ待ち手を除く
6. 回収の判定: `holderRetirable` はグループが空か番号の再利用だけで真、pid だけの死・再利用・観測不明では偽。`waiterRetirable` は `ticketRetirable` と同じ
7. `status` は読み取りだけ: 試験の前後で一時の root の中身（ファイルの一覧・内容・mtime）が変わらず、root が無ければ作らない。一覧が読めなければ「不明」で exit 3（空と表示しない）。tmp（規則に合わない名前）と一覧の後に消えた記録は壊れた記録にせず、有効な C を `unknown` にしない（§2.5）。警告（`ci_vm.cpus` 未設定・予約の縮小・pid が死にグループが生きる保有者・写しとの食い違いなど）を出す
8. 既存を弱めない: `cpu.heavy.lock` の中身・札は `status` の前後で同じ（I9）

**試験の表**（`it.each` の行の形。陽性の対照は **1 回限りの変異の確認**〔素朴な版を一時に作って赤を見たことをコミットの本文に記録し、製品のコードに切り替えを残さない〕で示す。原因調査 §7 の C01〜C07・G03・G04 を純関数の水準で入れた）:

| # | 関数 | 入力 | 期待 | 対照 |
|---|---|---|---|---|
| A1 | `loadResourceConfig` | ncpu ∈ {4,8,28} × 設定 {無し, share 0.5・ci_vm 8・cpu_heavy 4} | 無し: C 1・1・7、警告（`ci_vm` 未設定、ncpu 4・8 は予約の縮小）／あり: error・error・C 2 | 陽性: yaml の例の値を既定にする変異で 28・無しが error |
| A2 | 同 | 壊れた YAML／`version: 2`／`commandmate_share: 0`・`1.5`／`load_resume: 1` | error、理由を名指す | — |
| A3 | 同 | 同じ版の知らない鍵 | 値は既定、警告 1 件 | 陰性 |
| A4 | 同 | `CM_RESOURCE_CONFIG` が無い場所 | 既定 | 陰性 |
| C01 | `effectiveCapacity`＋`admissible` | own=3（a、P0、w2）、参加者: 保有者 h（own 3・w1）・待ち手 b（own 2、公開直後で b の周期はまだ）。門 open | C=2、`1+2 > 2` で入れない | **陽性**: `min(own, state.capacity=3)` の変異（第 2 版の式）で入る＝赤 |
| C02 | 同 | C01 と同じ参加者、`state.json` が欠損・破損、門 closed、a は P0 | C=2、入れない（写しは入力にしない） | **陽性**: 写しの欠損で `own` へ戻る変異で入る＝赤 |
| C03 | 同 | 全員 own=3／参加者なし（一覧が完全） | C=3、`1+2 ≤ 3` で入る | 陰性（安全側の拒否だけで通さない） |
| C04 | `admissible` | C=2、保有の和 3（縮小の後）、要求 w1 | 入れない。和が 1 になれば入る | 陰性: 和 1・w1 で入る |
| C05 | `effectiveCapacity` | 公開前の weight=3、参加者の最小 own=2 | C=2（呼び手は公開せず拒否。I10 の判定材料） | — |
| C06 | `effectiveCapacity` | 保有者 h（own 3・`admittedCapacity` 2）だけが残り、own=2 の参加者は去った | C=3（上がる） | **陽性**: `admittedCapacity` を入力に戻す変異で 2 のまま＝赤 |
| C07 | `effectiveCapacity` | 一覧が不完全（`complete:false`）／参加者 1 件の `ownCapacity` が null／保有者の生死が unknown | 前の 2 つは `unknown`、生死の unknown は C に影響しない（`admissible` で生きているとして数える） | **陽性**: unknown を `own` に置き換える変異で数を返す＝赤 |
| C08 | `effectiveCapacity` | 参加者の `ownCapacity` が {3,2,4}、own 5 | 2 | — |
| G03 | `orderWaiters`＋`admissible` | C=1、保有者 P2 w1（走っている）、待ち手 P2（番号 1）・P0（番号 2） | 先頭は P0、`admissible` は偽（横取りしない）。保有者が去れば P0 が真 | 陰性 |
| G04 | `admissible` | C=1、保有なし、P2 w1、門 open | 真（予約は無い） | **陽性**: `reserve_p0=1`（非 P0 は C−1 まで）の変異で永久に偽＝予約を採らない理由の対照 |
| O1 | `orderWaiters` | P3(1)・P2(2)・P0(3)・P2(4) | P0(3)・P2(2)・P2(4)・P3(1) | 陽性: 番号だけで並べる変異 |
| O2 | 同 | 待ち手 X（同じ token の保有者あり）・Y | Y だけ | 陽性: 除く処理を外す変異で X が先頭（A の対照） |
| O3 | 同 | `done:true` の待ち手 | 除く | — |
| GT1 | `gateNext` | open・load1 = ceiling | closed | — |
| GT2 | 同 | open・0.9×ceiling／closed・0.9×ceiling／closed・ちょうど resume×ceiling | open／closed／closed | 陽性: 揺れ止めの無い変異 |
| GT3 | 同 | closed・0.8×ceiling | open | — |
| GT4 | 同 | prev 読めない・load 0.1 | closed のまま | — |
| GT5 | 同 | load `[0,0,0]` | open | 陰性 |
| AD1 | `admissible` | 門 closed、P2／P0／P1 | 偽／真／真 | — |
| AD2 | 同 | 壊れた保有者 1 件 | 和に C を足す＝偽 | — |
| R1 | `holderRetirable` | グループ ESRCH | 真 | — |
| R2 | 同 | pid 死・グループ生 | 偽 | 陽性: `ticketRetirable` をそのまま使う変異 |
| R3 | 同 | pid の起動が新しい・グループ生・先頭は記録と同じ | 偽 | 同上 |
| R4 | 同 | グループ生・先頭の起動が `leaderStart` より新しい | 真 | — |
| R5 | 同 | グループの観測が EPERM／`leaderStart: null`・グループ生 | 偽 | — |
| R6 | 同 | 別の host | 偽 | 陰性 |
| W1 | `waiterRetirable` | gone／pid-reused／expired／別 host の猶予内 | 真・真・真・偽 | — |
| S1 | `status` | 一時の root に保有者 2・待ち手 2・`state.json` | 表示に S・own・有効な C・保存の門と `gateNext`・並べの順・回収の候補・次に入れる待ち手。前後で root の一覧・内容・mtime が同じ | — |
| S2 | 同 | root が無い | 「参加者なし」、root を作らない、exit 0 | — |
| S3 | 同 | holders を読めない（`readdir` の注入で EACCES。権限 0000 は root で読めるので使わない。事前レビュー 3 の P3-2） | 「不明」、exit 3 | 陽性: 一覧の失敗を空と読む変異で「参加者なし」＝赤 |
| S4 | 同 | 壊れた記録／別の host／`leaderStart: null`／pid 死・グループ生 の保有者 | それぞれ警告で名指す。有効な C は壊れた記録で「不明」 | — |
| S5 | 同 | `state.json` の `copy.capacity` = 3、観測した有効な C = 2 | 両方を出し、食い違いを警告 | — |
| S6 | 同 | `cpu.heavy.lock` を別に置く | `status` の前後で中身・札が同じ | 陰性（I9） |
| S7 | 同 | 壊れた YAML | exit 2・`resource: refused` | — |
| S8 | setup | `CM_RESOURCE_CONFIG` を外の値にして setup を通す | 一時パス（`PINNED` の既存の試験が固定） | — |
| S9 | `status` | `holders/.tmp-x` に半端な JSON（tmp が残っている） | 参加者に数えず、有効な C は `ok`、tmp は警告だけ。root は変わらない | 陽性: 名前で外さない変異で `unknown`＝赤 |
| S10 | `status` | 一覧と読みの間に記録が消える（`readFile` の注入で ENOENT） | 去ったとして扱い、壊れた記録にしない。exit 0（ENOENT 以外の EIO は壊れた記録＝`unknown`） | 陽性: ENOENT を壊れたと読む変異で `unknown`＝赤 |

試験は `fs.mkdtempSync(os.tmpdir())` の root（`CM_VERIFY_LOCK_ROOT`）と `CM_RESOURCE_CONFIG` で隔離し、`afterEach` で消す（S3 は権限を戻してから消す）。論理 CPU 数は設定の `ncpu` で決める。`status` の観測（`kill -0`・`ps`）は注入点 `hooks`（`pidAlive`・`groupAlive`・`startOf`・`loadavg`・`now`）で置き換え、実プロセスを起こさない。

**gates**: `lint`・`typecheck`・`unit`（`tests/setup.ts` を変えるので全体。共通の枠 §2。事前レビュー 3 の H2 で `unit-related` から直した）、加えて `work-evidence`・`scope`・`env-clean`。確かめのコマンドは `npx vitest run tests/unit/scripts/orchestrate/resource-*-4370.test.ts tests/unit/config/codex-home-isolation-4146.test.ts tests/unit/guards tests/unit/docs`。

**未決（誰が決めるか）**: `commandmate_share` を 0.5 にするか（人）、`weights.cpu_heavy` の 4（#4367 の計測の後にリーダー）、`reserve_p0`（人。計測の後）。どれも PR1a の実装を止めない。

### 9.3 PR1b の条件と表（契約は PR1a の後に書く）

条件:

- U1〜U3・I1-a〜I14 を満たす。公開・取得・解放・異常の復帰を実プロセスで確かめる。純関数の表（§9.2）だけで公開の手順の正しさを主張しない
- 停止点（注入）を「公開の直後」「和の算出の後・`link` の前」「記録の追加の後・待ち手を使用済みにする前」に置く
- 解放の順は「待ち手を使用済み → 保有者を消す」
- `run` の exit は子の終わり方だけで決める（§2.3.2）
- 実プロセスの試験（グループへの SIGKILL・SIGTERM）は、呼び手を `detached` で起こし、送る前に「送り先の pgid が vitest 自身のグループ（`process.pid` のグループ）ではない」ことを確かめる行を置く。`tests/helpers/real-shell-budget.ts` の `REAL_SHELL_MARKERS` に当たる書き方にし、`tests/unit/guards/real-shell-test-budget.test.ts` の予算に乗せる
- events の回転は `rename`、読み手との約束は §7.1
- 待ち手 20 の `ps` の起動の回数と所要を測って PR の本文に記録する（合否には使わない）

表（行だけ。期待は §4.1・§5 による）:

| # | 行 |
|---|---|
| B1 | weight 2 の `run` ×2、C=3: 2 本目は 1 本目の解放まで子を起動しない（陽性: `afterCount` で割り込ませても 2 本とも入らない） |
| B2 | 原因調査 C01 を実受付で: b の公開直後に停止点で止め、a（P0）を動かす → a は入らない |
| B3 | C02 を実受付で: `state.json` を壊し、門 closed、a（P0） → 入らない |
| B4 | C04: 保有の和 3 のときに own=2 の参加者が公開 → 走っているものは止めず、和が 1 になるまで追加しない |
| B5 | C05: 公開前の weight > 有効な C → 公開しない／待ちの間に縮小 → 使用済みにして `refused`、後ろが詰まらない |
| B6 | 入った後の待ち手の使用済みの失敗（`afterAdmitLink`）→ 後ろが入る |
| B7 | 解放のとき待ち手の処理が失敗 → 保有者を消す前なので先頭に残らない（他者が同じ token で除く） |
| B8 | `run` の pid だけが死にグループが生きる／グループが空／番号の再利用 |
| B9 | 呼び手のグループへ SIGKILL で子も終わる（`detached` の変異で子が残る陽性）。`run` への SIGTERM が子へ届き、子が 0 で終われば exit 0、シグナルで終われば 128＋番号 |
| B10 | 期限切れ・`timeoutMs` = 0・受付のロックが取れない（`unknown`）・root を作れない |
| B11 | 一覧の失敗・壊れた記録で受付が止まる・保有者 1 件の生死が EPERM なら生きているとして数えて入る |
| B12 | `events.jsonl` を書けない（同じ名前のディレクトリ）→ 取得は成功・警告。10 MB で `.1` へ |
| B13 | `cpu.heavy.lock` を別に保有していても `run` は入り、`cpu.heavy.lock` は変わらない（I9） |
| B14 | host 名の変化の後の自分の古い記録は回収しない |

**PR1a・PR1b の後に残ること**: precheck・merge-pr・verify の `cpu.heavy` はまだ枠を通らない（PR2a・PR2b・PR3）。受入条件 3（ランナー）・4（CI の段を飛ばす）は PR4・PR6。

---

## 10. 実装（PR1a）で合わせた点と事前レビュー 3 の処分

実装で決めた・実コードに合わせた点:

- `gateNext` は `prev` が読めなければ load に依らず closed を返す（§4.2 の「読めない｜どれでも｜closed」と GT4 に合わせた。§2.4 の文は「closed とみなして揺れ止めを当てる」とも読めたが、表と試験を正とした）。全欄 0 の load だけは prev に依らず open（GT5）
- `effectiveCapacity({ own, participants, complete })`: `complete` が `true` 以外は `unknown`（`point: 'list'`）。参加者は `{ name, record }` で、`record` が null（読めない）か `ownCapacity` が 1 以上の整数でなければ `unknown`（`point: 'ownCapacity'`・`name`）
- `admissible` は和の計算を `heldWeight` に分けた（`status` の `used` と同じ計算）。`weight` が 1 以上の整数でない保有者も C を占める。`priority` が P0〜P3 でない・`weight` が不正な要求は偽
- `orderWaiters` は優先度と番号を**ファイル名**（`<P>-<12 桁>`）から取る。読めない待ち手は並べから外さず `corrupt: true` で残す（生きた札と同じく塞ぐ。どのみち有効な C が `unknown` で誰も入らない）
- `holderRetirable` は `'group-gone' | 'leader-reused' | null`、`waiterRetirable` は `ticketRetirable` をそのまま呼ぶ（`gone`・`pid-reused`・`expired`）。`groupAlive` は三値（`alive`・`gone`・`unknown`）か真偽を受ける
- `loadResourceConfig` は試験用に `availableParallelism` の注入を受ける（`ncpu: auto` の値）。読みの失敗は ENOENT だけが既定、それ以外（EISDIR・EACCES）は誤り。`runners`・`health`・`idle` は対応表であることだけ確かめ、中身は PR4・PR7
- `status` は待ち手の回収の候補に `done`（使用済み）・`admitted`（同じ token の保有者あり）も出す。観測の注入点は `hooks`（`readdir`・`readFile`・`pidAlive`・`groupAlive`・`startOf`・`loadavg`・`now`・`host`・`availableParallelism`）

事前レビュー 3 の P3 の処分（1 行ずつ）:

- P3-1（`status` の有効な C に `status` 自身の `own` が入る）: PR1a で入れた。`--json` に参加者だけの最小 `participantsMin` を別の欄で出す（`effectiveC` は「今この設定で要求したら」の値のまま）
- P3-2（S3 を権限 0000 で作ると root で読める）: PR1a で入れた。S3 は `readdir` の注入で EACCES を作る
- P3-3（他の参加者の小さい制約による拒否が設定の誤りと同じ exit 2・`refused`）: PR1b の条件へ送る（`refused reason=capacity-lowered by=<token>` と区別し、`status` がその参加者を名指す）。PR1a には拒否の口が無い
- P3-4（門が閉じている間、P2 が `cpu.heavy` を持ったまま枠を待つ）: PR2a の着手条件へ送る（門が閉じているときに `cpu.heavy` を返して待ち直すか、待ちの上限を決める行を PR2a の表に入れる）

## 改訂の履歴

- 第 2 版（2026-11-14）: 2-4-4 事前レビュー（claude-5、P2 7・P3 14）とリーダーの突き合わせ（X1〜X7）を反映。A 消し損ねた待ち手を先頭の前に除く、B `run` の子を呼び手のグループに残し記録をグループと先頭の起動時刻で 1 回で書く、C 有効な C を `state.json` で一致させる、D 既定値の表とどの ncpu でも C ≥ 1、E CI 待ちは枠の外、F・G は I13・I14 と PR2a/2b/3a/3b/3c の条件、P3 は PR1 の範囲と試験 T25〜T39 へ（飢えは仕様として受け入れ、PR7 の kill の条件は §9.1）、コントローラーの置き場所を `scripts/orchestrate/` へ（X1）、events は #4367 が読む（X3）
- 第 3 版（2026-11-14）: 再レビュー（C2・G2 が同じ種類の 2 回目）と codex の原因調査（`enabler-return-4370-cause.md`）を反映。最上位の不変条件 U1〜U3 を置き、容量を `ownCapacity`（公開する制約）と `admittedCapacity`（採用値）に分けて有効な C を同じ臨界区間で一覧した参加者の `ownCapacity` の最小から作る（`state.json` は写し、欠損・不明は受付を止める）、I1 を新規の判定と縮小の後の 2 文に、保持区間の規則（枠は最も内側・持ったまま待たない・最初に返す）で I14 と §7.1 の順を「merge のロック → `cpu.heavy` → 枠」に直した。`reserve_p0` は採らず人の判断へ（P0 の優先は始める順だけ）。PR1 を PR1a（設定・純関数・読み取りだけの `status`）と PR1b（取得・`run`）に分け、PR1a の契約と C01〜C08・G03・G04 の対照を書いた。再レビューの P3（解放の順・F7 の名指し・SIGTERM の exit・ncpu 4 の予約 0・実プロセスの試験の安全・events の回転）は PR1b の条件と §2〜§7 へ。壊れた待ち手を並べから外して続ける第 2 版の方針は U1 に反するので撤回した
- PR1a の実装（2026-11-14）: 事前レビュー 3 の H1（公開済みの参加者をファイルの名前の規則で決め、tmp と一覧の後に消えた記録を壊れた記録にしない。§2.2・§2.5・S9・S10）・H2（gates を `unit` に）を入れ、§10 に実装で合わせた点と P3 4 件の処分を書いた
