# マシンの資源の受付と配分（Issue #4370）— 設計

- 状態: 設計（第 1 版）。実装は未着手。この run で実装するのは §9 の PR1 だけ
- 親: Epic #4371（流れの計測と制御）の子 4。共通の枠は段 3 のリーダーの決定（`workspace/orchestration/runs/2026-11-14/s3-common-frame.md`、以下「共通の枠」）に従う
- 前提の Issue: #1917（`cpu.heavy`）、#3884（precheck の重い段・待ちの記録）、#4265（`--heavy-to-ci`）、#4277（札の先着順）、#4288（lease の規則と前提 P0・P1）
- 行番号は 2026-11-14 の `origin/develop`（`a334a013f`）のもの。名前で引くこと
- 本書では **事実**（コード・記録・設定で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**を分ける（§8 に一覧）

---

## 0. 結論

| 問い | 決めた向き | 一言の理由 |
|---|---|---|
| 全体の上限 | `~/.commandmate/resource.yaml` の `commandmate_share`（既定 0.4）× 論理 CPU 数を **全体の枠 S** とする。S を「CI の VM の割り当て（`ci_vm.cpus`）」「`cpu.heavy` の予約（`weights.cpu_heavy`）」「ホストの枠 C」に分け、C を新しいセマフォが数える | macOS に cgroup が無い。CI は Docker の VM で硬く、ホストの処理は受付で、両方を同じ S の内訳にすれば合計が S を超えない |
| 枠の仕組み | 既存の machine-lock（`machine-lock-sync.mjs`）を**壊さずに使う**。短い**受付のロック** `cpu.sem.admit` の中でだけ保有者の記録（`<root>/cpu.sem/holders/<token>.json`）を読み・回収し・足す。枠の待ちは優先度つきの札（`waiters/`）。先頭だけが入る | 排他・札・回収・三値の観測・lease の規則（pid と世代）をそのまま再利用できる。保有者の記録の追加と削除が 1 つの臨界区間に入るので「数えてから足す」の競合が無い |
| 既存の `cpu.heavy` | PR1・PR2 では**触らない**（読みもしない）。代わりに `weights.cpu_heavy` を S から**常に予約**する。PR3 で verify の `mutex: cpu.heavy` をセマフォの P2 の取得へ移し、予約を外す | `cpu.heavy` は 3 実装（TS・bash・同期 JS）が同じ規約で取る。PR1 でセマフォがそれを数えるだけにすると、セマフォが満ちた後に `cpu.heavy` が取られて S を超える。常の予約なら PR1 から不変条件 I1 が成り立つ |
| 優先度 | P0 マージの判定 ＞ P1 PR の CI ＞ P2 ワーカーの検証 ＞ P3 背景。**始める順だけ**優先し、走っているものは止めない。後ろの小さい要求が先頭を追い越す「詰め込み」はしない | 詰め込みは重い P0 を飢えさせる。止めないのは Issue の仕様 |
| load の上限 | 1 分の load が `load_ceiling`（既定 1.0 × 論理 CPU 数）を超えたら門を閉じ、P2・P3 を入れない。`load_resume`（既定 0.85）倍を下回るまで開けない（門の状態は受付のロックの中で持つ） | 2026-11-13 の load 50〜78（Epic #4371）は CommandMate の外の処理も含む。枠だけでは外の負荷に気づけない |
| 死んだ持ち主 | #4288 の lease の規則を流用: 同じ host で pid が ESRCH（pgid があればグループも空）か、pid が再利用された（起動が記録より `PID_REUSE_SLACK_MS` 以上後）ときだけ回収。不明は回収しない。前提 P0・P1 の下で保証 | 既存の `holderState`・`ticketRetirable` の判定と同じ。保有は 90 分級なので心拍の lease にしない |
| ランナー | CommandMate のリポジトリにマシンで 1 つの**コントローラー**（`scripts/resource/runner-controller.mjs`）を置き、全リポジトリの合計の上限・待ちと load で台数を決める。launchd（KeepAlive）で常駐し、Docker が落ちている間は待って、起きたら 1 周期で最小台数を起こす。5 分ごとに健康を記録 | 今のコントローラーは別リポジトリの `runner.sh` でリポジトリごとに独立（合計の上限なし・常駐なし・Docker と一緒に落ちたまま） |
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
S = floor(ncpu × commandmate_share)            全体の枠
C = S − ci_vm.cpus − weights.cpu_heavy          セマフォが数えるホストの枠（PR3 で − cpu_heavy が外れる）
C < 1 なら設定の誤り（exit 2）
```

例（見立て）: ncpu 28・share 0.5 → S 14、ci_vm 8、cpu_heavy 4 → C 2。今の VM（16 CPU）は share 0.4（S 11）を一人で超えるので、VM の割り当ての見直しが要る（§6 の人の操作 1）。

### 2.2 セマフォの置き場所と記録

```
<root>/cpu.sem.admit.lock/owner           受付のロック（machine-lock そのもの）
<root>/cpu.sem.admit.queue/<12 桁>        受付のロックの札（machine-lock そのもの）
<root>/cpu.sem/holders/<token>.json       保有者 1 件 = 1 ファイル
<root>/cpu.sem/waiters/<P>-<12 桁>.json   待ち手 1 件 = 1 ファイル（P は 0〜3）
<root>/cpu.sem/state.json                 門の状態（open/closed）・次の札の番号
<root>/cpu.sem/events.jsonl               出来事の記録（追記だけ。§7 の約束で #4367 が集める）
```

`<root>` は machine-lock と同じ（`CM_VERIFY_LOCK_ROOT` で移る。試験は一時 dir）。

保有者の記録: `{ v:1, token, pid, host, pgid?, createdAt, started_at, priority, weight, reason, repo?, waitedMs }`。待ち手の記録: `{ v:1, token, pid, host, createdAt, deadline, priority, weight, reason }`。`pid` は書いたプロセス自身（#4288 I1-b）、`reason`・`repo` 以外の欄は呼び手が渡せない。

### 2.3 取得と解放

取得 `acquireSlots({ priority, weight, reason, timeoutMs, pgid? })`:

1. 引数の検査（`priority` ∈ P0〜P3、`1 ≤ weight ≤ C`、`timeoutMs ≥ 0`）。外れたら何も書かずに拒否
2. 受付のロックを取り（予算 `ADMIT_LOCK_TIMEOUT_MS` = 10 秒）、`state.json` の番号で待ち手の記録を書き、ロックを返す
3. 周期（1 秒）ごとに受付のロックを取り、その中で:
   - 保有者・待ち手を一覧し、回収できるもの（§2.5）を消す
   - 門の状態を load で更新（§2.4）
   - 生きている待ち手を `(priority, 番号)` で並べ、**自分が先頭**で、`Σ保有者の weight + 自分の weight ≤ C` で、門が開いているか自分が P0・P1 なら、保有者の記録を `link` の排他で作って待ち手の記録を消す（入った）
   - 入れなければ何もせずロックを返す
4. 期限を過ぎたら自分の待ち手の記録を消して `acquired: false`（取消し）
5. 受付のロックが取れない・観測が不明の周期は「入らない」で次の周期へ（待ちに数える）

解放 `release()`: 自分の保有者の記録を読み、`token` と `pid` が自分のときだけ消す。1 回きり（2 回目は `none`）。受付のロックは取らない（自分の token のファイル名だけを消すので、他の保有者に触れない）。

`run` の形（PR1 の CLI）: `resource.mjs run --priority P2 --weight 2 --reason <文> [--timeout <秒>] -- <cmd...>`。枠を取ってから子を**自分のプロセスグループ**で起動し、保有者の記録に `pgid` を書く（merge-pr の内側のプロセスと同じ考え）。子の終了で解放し、子の exit code を返す。親が SIGKILL で死んでも、グループが残る間は回収されない。

### 2.4 load の門

- 受付のロックの中で `os.loadavg()[0]` を読み、`closed` は `load1 ≥ load_ceiling × ncpu` で、`open` は `load1 < load_resume × load_ceiling × ncpu` で切り替える。間は前の状態のまま（揺れ止め）
- `os.loadavg()` が `[0,0,0]` を返す環境（Windows）では門を常に開ける（枠の上限は効く。fail-open の理由は §3）
- 門の切り替えは `events.jsonl` に 1 行（#4367 の警報の材料）

### 2.5 回収（lease の規則の流用）

受付のロックの中でだけ、次のどれかの記録を消す。

| 記録 | 消す条件 | 判定 |
|---|---|---|
| 保有者 | 同じ host で `holderState` が `gone` | `machine-lock-sync.mjs:349` |
| 保有者 | 同じ host で pid の起動が `createdAt + PID_REUSE_SLACK_MS` より後 | `ticketRetirable` の `pid-reused` と同じ |
| 待ち手 | `ticketRetirable` が `gone`・`pid-reused`・`expired` | `machine-lock-sync.mjs:462` |
| どちらも | 別の host の記録 | 保有者は消さない（生きているとみなす）。待ち手は期限＋`OTHER_HOST_GRACE_MS` |
| どちらも | 読めない・壊れた JSON | 消さない。保有者なら `weight = C`（満杯）とみなす。`events.jsonl` に `corrupt` を 1 回 |

壊れた保有者の記録で全体が止まるのは安全側の倒れ方で、人が `resource.mjs status` で名指しを見て消す（§6 の人の操作）。

### 2.6 ランナーのコントローラー（PR4）

- 1 台のマシンに 1 つ。`resource.yaml` の `runners.repos[]`（`name`・`min`・`max`）と `runners.total_max` を読む
- 60 秒ごと: `docker version`（10 秒で打ち切り）→ 落ちていれば何もしない／リポジトリごとに `docker ps --filter name=ephemeral-runner-<repo>-` の数と、`gh api repos/<o>/<r>/actions/runs?status=queued` の待ちの数・最古の待ち
- 望む台数 = `clamp(min, max, 走っている数 + 待ちのジョブの数)`。合計が `total_max` を超えるなら、P0 の待ち（base への push の run、#4369 の train のブランチの run）があるリポジトリ → 最古の待ちが古いリポジトリの順に配る。load の門が閉じていれば最小台数より上は起こさない
- 起こすのは足りない分だけ（`docker run -d --rm --cpus <runners.cpus> --memory <runners.memory> --name ephemeral-runner-<repo>-<秒>-<乱数> <image>`、トークンは `runners.token_cmd`）。**走っているコンテナは止めない**。ランナーは使い捨てで 1 ジョブで終わるので、台数は入れ替わりの時に望む台数へ寄る
- 5 分ごとの健康: `docker version`・online 数（`gh api .../actions/runners`）・最古の待ちの秒数を `events.jsonl` と #4367 の警報へ。Docker が 3 回続けて落ちていれば警報。再起動は `health.docker_restart`（既定 `notify`）
- 常駐: launchd の LaunchAgent（`KeepAlive: true`、`RunAtLoad: true`）。コントローラーが死んでも launchd が起こし直す。Docker が落ちている間も生きて待ち、起きた最初の周期で最小台数を起こす → **5 分以内に online**（受入条件。登録まで約 1 分は 2026-10-02 の実測〔運用の記録〕）

### 2.7 `resource.yaml`

```yaml
version: 1
commandmate_share: 0.4        # 0 < x ≤ 1
load_ceiling: 1.0             # × ncpu（1 分の load）
load_resume: 0.85             # × load_ceiling
weights:
  cpu_heavy: 4                # PR3 まで S から常に予約
ci_vm:
  cpus: 8                     # Docker Desktop に人が設定した値と同じにする（読み手は検査できない）
  memory_gib: 24
runners:                      # PR4
  total_max: 4
  cpus: 2
  memory_gib: 6
  image: my-ephemeral-runner:latest
  token_cmd: ["python3", "/path/to/get_runner_token.py"]
  repos:
    - { name: Kewton/CommandMate, min: 2, max: 4 }
health:                       # PR4
  interval_sec: 300
  docker_restart: notify      # notify | auto
  queued_alert_sec: 600
idle:                         # PR7
  stop_after_min: 0           # 0 = 止めない
```

- 無い → すべて既定。読めない・形が違う・知らない鍵・`C < 1` → **exit 2**（設定の誤りを黙って既定に倒さない）。PR1 で読むのは `commandmate_share`・`load_ceiling`・`load_resume`・`weights`・`ci_vm` だけ。他の節は鍵の名前だけ検査し、値は読み手の PR で検査する
- 場所は `CM_RESOURCE_CONFIG` で移せる（試験は一時 dir。`tests/setup.ts` は PR1 では触らない: 既定の場所が無ければ既定値で動くので）

---

## 3. 不変条件

1. **I1** どの受付の瞬間でも、生きている保有者の `weight` の和 ≤ C（＝ S − `ci_vm.cpus` − `weights.cpu_heavy`）。読めない保有者は C を占める
2. **I2** 保有者の記録の追加は受付のロックの中でだけ、同じ臨界区間の回収と和の計算の後に行う
3. **I3** 入れるのは、生きている待ち手を `(priority, 番号)` で並べた先頭だけ。後ろの待ち手は先頭が入るまで入らない（詰め込みなし）
4. **I4** 門が閉じている間、P2・P3 は入らない。P0・P1 は門に依らない
5. **I5** セマフォは走っている保有者を止めない・枠を取り上げない
6. **I6** 保有者の記録を消すのは (a) 本人の解放（token と pid が自分）か (b) 受付のロックの中の回収（§2.5 の正の証拠）だけ。観測が不明なら消さない
7. **I7** 記録の `pid` は書いたプロセス自身。予約の欄は呼び手が書けない（#4288 I1-b・I1-c）
8. **I8** 入ったときは待ちの時間（`waitedMs`）を記録と `events.jsonl` に残す。記録の書き込みの失敗は取得を失敗にしない（警告だけ）
9. **I9** 既存の `cpu.heavy` のロック・札・解放の振る舞いを PR1・PR2 は変えない（読みも書きもしない）
10. **I10** `weight` が C を超える・設定が誤っている要求は、待ち手の記録を書く前に拒否する（永久に入れない待ちを作らない）
11. **I11** コントローラーは走っているランナーのコンテナを止めない。合計は `total_max` を超えて起こさない
12. **I12** 保証は #4288 の前提 P0（手順の途中で 10 分を超えて止まらない）・P1（壁時計）の下で書く。前提の外の交差は §5 の表に行で名指し、直さない

---

## 4. 状態と遷移の表

### 4.1 1 つの要求

| 状態 | 出来事 | 次の状態 | 副作用 |
|---|---|---|---|
| 無し | 取得（引数の誤り・C < 1） | 無し | 何も書かない。exit 2 |
| 無し | 取得（正しい） | 待ち | 受付のロックの中で待ち手の記録 |
| 無し | 取得（受付のロックが 10 秒取れない） | 待ち（記録なし） | 次の周期で記録を試す。期限まで |
| 待ち | 周期: 先頭・空きあり・門が通す | 保有 | 保有者の記録（`link`）→ 待ち手の記録を消す → `events` `admit waitedMs` |
| 待ち | 周期: 先頭でない／空きなし／門が閉じて P2・P3 | 待ち | なし |
| 待ち | 周期: 観測が不明（一覧の失敗・EPERM） | 待ち | 回収も受付もしない。`events` に不明を 1 回 |
| 待ち | 期限 | 取消し | 自分の待ち手の記録を消す。`acquired:false`。`run` は子を起動せず exit 3 |
| 待ち | プロセスの死（SIGKILL） | 待ち（記録だけ残る） | 次の周期で他者が `gone` で回収 |
| 保有 | 解放（本人） | 解放済み | 自分の記録を消す。`events` `release heldMs` |
| 保有 | 解放（2 回目） | 解放済み | なし（`none`） |
| 保有 | プロセスとグループの死 | 回収待ち | 次の受付の周期で他者が `gone` で消す。`events` `reclaim` |
| 保有 | pid が死に、グループが残る | 保有 | 回収しない（子が走っている） |
| 保有 | 記録が外から消された（人の操作） | 保有（記録なし） | 解放は `none`。I1 はその間崩れうる（§5 F4） |

### 4.2 門

| 状態 | 出来事 | 次 | 副作用 |
|---|---|---|---|
| open | `load1 ≥ ceiling` | closed | `events` `gate closed load=` |
| open | それ以外 | open | なし |
| closed | `load1 < resume × ceiling` | open | `events` `gate open load=` |
| closed | それ以外 | closed | なし |
| どちらも | `state.json` が読めない | closed とみなす | P2・P3 を入れない。書き直しは次の受付で |

### 4.3 コントローラー（PR4）

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
| 受付のロック（machine-lock） | 10 秒で取れない・unknown | **fail-closed**: その周期は入らない（待ちに数える） |
| holders／waiters の一覧（`readdir`） | EACCES・EIO | fail-closed: 回収も受付もしない |
| 記録の読み（JSON） | 壊れている | 保有者は満杯とみなす（fail-closed）、待ち手は消さない |
| 保有者の記録の作成（`link`） | EEXIST・ENOSPC | 入らない。自分の tmp だけ消す |
| 待ち手の記録の削除（入った後） | 失敗 | 入ったまま（保有者の記録が正）。残った待ち手は自分の pid の記録なので、自分が先頭でなくなる以外の害は無く、解放のときに自分の待ち手も消す |
| `kill -0`・`ps -o etime=` | EPERM・ps の失敗 | unknown → 回収しない（#4288 と同じ） |
| `os.loadavg()` | 0 を返す環境 | **fail-open**（門を開ける）。枠の上限 I1 は効くので、外の負荷への備えだけが外れる |
| `events.jsonl` の追記 | 失敗 | **fail-open**: stderr に警告、取得・解放は続ける（I8） |
| `resource.yaml` | 無い | 既定値 |
| `resource.yaml` | 壊れている・誤り | fail-closed: exit 2 |
| 子のコマンド（`run`） | 起動の失敗 | 枠を返して exit 127 相当 |
| `docker version`（PR4） | 失敗・10 秒 | 起こさない（Docker 待ち） |
| `docker run`（PR4） | 失敗 | その周期は諦め、次の周期で数え直す（二重起動しない: 毎周期 `docker ps` で数え直す） |
| `gh api`（PR4） | 5xx・レート | 最小台数だけ守る。3 回で警報 |
| launchd（PR4） | コントローラーの死 | KeepAlive で起こし直す。plist が入っていなければ常駐しない（人の操作） |
| #4367 の記録の書き手 | 無い（PR1 時点） | `events.jsonl` にだけ書く |

前提の外（直さない）:

| 行 | 形 | 前提 |
|---|---|---|
| F1 | 受付のロックを持ったまま 10 分を超えて止まった書き手の再開 | P0 |
| F2 | 保有者の起動から記録までの間の壁時計の後退で `pid-reused` が誤る | P1 |
| F3 | 別の host の記録（同じ `~/.commandmate` を共有する構成）は回収しない | 構成の外（1 台のマシンの設計） |
| F4 | 人が保有者の記録を手で消した | 運用。`status` が消した記録の和の変化を出す |
| F5 | `ci_vm.cpus` が Docker Desktop の実際の値と違う | 人の操作の誤り。読み手は VM を見ない（§6） |

---

## 6. 人の操作・人の判断

### 6.1 人の操作（導入。この run の範囲外）

| # | 操作 | いつ | PR に入れるもの |
|---|---|---|---|
| 1 | Docker Desktop の Resources を `ci_vm` に合わせる（推奨の出発点: CPU 8・メモリ 24 GiB） | PR4 の後 | docs の手順。値の推奨は `docs/orchestrate/ci-merge.md` |
| 2 | Docker Desktop の「サインイン時に起動」を入れる（今 `AutoStart: false`） | PR4 の後 | docs |
| 3 | `~/.commandmate/resource.yaml` を書く | PR1 の後（既定で足りれば不要） | 雛形（`docs/orchestrate/ci-merge.md` の例） |
| 4 | LaunchAgent を入れる（`launchctl bootstrap gui/$UID <plist>`） | PR4 の後 | plist の雛形 `scripts/resource/launchd/com.commandmate.runner-controller.plist.template`・入れ方の docs・雛形の形の試験 |
| 5 | 旧コントローラー（`runner.sh` の 8 リポジトリ分）を止め、新しいコントローラーの `repos` へ移す | 4 の後 | 移行の手順の docs |
| 6 | 壊れた保有者の記録を消す（`status` が名指す） | 起きたとき | `status` の出力 |

### 6.2 人の判断（推奨 1 つと理由）

| 問い | 推奨 | 理由 |
|---|---|---|
| `commandmate_share` の値 | **0.5**（S 14） | 0.4 だと今の VM の 16 CPU が入らず、VM を 4 まで削ることになる。0.5 なら VM 8・`cpu_heavy` 4・ホスト 2 で、残り 14 コアを別のリポジトリと人の作業に残す。#4367 の計測で見直す |
| Docker の自動の再起動 | **既定は通知だけ**（`notify`）。`auto` は「3 回続けて落ち、どのリポジトリにも走っているジョブが無い（`gh api` で busy 0）」ときだけ | 再起動は同じ Docker 上の他のリポジトリのランナーとジョブを巻き込む（運用の記録で利用者に確かめてから行ってきた）。11-13 の停止の直接の原因は未確認で、自動の再起動が悪化させない保証が無い |
| E2E を別のマシン・GitHub のランナーへ | **E2E の 2 本の shard だけ GitHub のランナー（`ubuntu-latest`）へ試しに移す**（ワークフローを変える別の PR。1 週間の所要と揺れを #4367 で比べて決める） | リポジトリは公開で GitHub のランナーは無料。fork の PR では既に `ubuntu-latest` で走る（`ci-pr.yml:699` の式）ので動く見込みが高い（見立て）。E2E は中央値 6.2 分・最長 16.2 分・時間切れ 30 分（`ci-pr.yml:21-22` の実測の表）で、ブラウザを起こす重いジョブ |
| 別のリポジトリの処理をセマフォに通すか | **CommandMate が起こすもの（verify のゲート・orchestrate のスクリプト・コントローラー）はリポジトリを問わず通す。CommandMate の外で人や別のツールが起こすもの（cargo など）は通さず、load の門で見る** | lock root はマシンで 1 つ（`~/.commandmate/locks`）なので、CommandMate が管理するリポジトリは設定なしで同じ枠に入る（`verify.yaml:212-214` の狙いと同じ）。外の処理を強制する仕組みは macOS に無い |
| CI の段を手元の verify の結果で飛ばすか（受入条件 4） | **リポジトリごとの明示（`flow.yaml` の `ci_skip: [unit]`）で、既定は飛ばさない**。飛ばすのは「同じツリー（`HEAD^{tree}`）・同じゲート・全体の実行（related でない）・同じ lockfile の hash」の合格だけ。証拠は commit status で CI へ渡し、必須チェックの名前は変えない | 手元と CI のコンテナは環境が違い、必須チェックを弱めうる（共通の枠 §5）。だから既定は今のまま、受入条件を満たす仕組みだけを用意し、使うかは人が決める |
| CI の中の P0 と P1 の順 | **最初は GitHub の割り当て（先着）のまま**。コントローラーは P0 の待ちがあるリポジトリへ先に台数を配るだけ | 使い捨てのランナーはどのジョブを取るかを選べない。ラベル（`runs-on: [self-hosted, p0]`）はワークフローの変更で、train（#4369）の形が決まってから |

---

## 7. 他の子への約束

### 7.1 提供（#4370 → 他）

| 相手 | 提供するもの | 形 | いつから |
|---|---|---|---|
| #4369（merge train） | 枠の取得 | 同期 JS `acquireSlots({ priority: 'P0', weight, reason, timeoutMs, pgid? })` → `{ acquired, waitedMs, heldBy, release(): 'released' \| 'none' }`（`scripts/orchestrate/resource-sem.mjs`）。CLI `node scripts/orchestrate/resource.mjs run --priority P0 --weight <n> --reason train:<id> -- <cmd>` | PR1。**PR2 までは #4369 は merge のロックと `cpu.heavy` のままでよい**（共通の枠 §3） |
| #4369 | train の組み合わせ確認・base の CI 待ちは P0、PR の CI 待ちは P1 | 優先度の語 `P0`〜`P3`（文字列）。単位は枠（≒ コア） | PR1 |
| #4368（WIP） | なし（WIP の数は使わない） | — | — |
| #4367（計測） | 出来事 | `<root>/cpu.sem/events.jsonl` の 1 行: `{ at, kind: 'admit'\|'release'\|'reclaim'\|'cancel'\|'gate'\|'corrupt'\|'unknown'\|'health', priority?, weight?, waitedMs?, heldMs?, load1?, reason?, repo? }` | PR1 |
| #4367 | 今の状態 | `resource.mjs status --json` → `{ S, C, used, gate, load1, holders: [...], waiters: [...] }` | PR1 |

### 7.2 利用（他 → #4370）

| 相手 | 使うもの | 足りないもの（#4370 からの頼み） |
|---|---|---|
| #4367 | 流れの記録の書き手・警報の書き手（`alerts.jsonl`） | マシンの単位の出来事の置き場所。`<repo-slug>` の代わりに `_machine` を受け付けるか、#4367 が `events.jsonl` を集めるかのどちらかを #4367 の設計で決めてほしい（#4370 はどちらでも `events.jsonl` を書き続ける） |
| #4367 | `.commandmate/flow.yaml` の読み手 | `ci_skip`（PR6）を同じ読み手へ足す |
| #4369 | train のブランチの名前 | コントローラーが P0 の run を見分けるため、`flow.yaml` の `train` の節にブランチの接頭辞を置いてほしい（無ければ base への push だけを P0 とみなす） |
| #4368 | 「動いているブランチ数」の関数 | 遊んでいるセッションを止める PR7 が、動いているものを止めないために読む |

---

## 8. 事実と見立て

- **事実**: §1 の file:line、`runner.sh` の行、Docker Desktop の設定の値、論理 CPU 28、online 6、リポジトリが公開
- **見立て**:
  - `cpu.heavy` の重さ 4 枠（vitest の全体の実行が何コア使うかは測っていない。#4367 の計測で直す）
  - E2E が GitHub のランナーで同じように通ること（fork の PR で通っている実績は見ていない）
  - コントローラーで Docker の起動から 5 分以内に online に戻ること（登録まで約 1 分は 2026-10-02 の 1 回の記録）
  - load の門の 1.0 × ncpu・0.85 が揺れずに効くこと
  - 受付のロックを 1 秒ごとに取る負荷が無視できること（待ち手 20 程度を想定）
- **未確認**:
  - 2026-11-13 18:57 の Docker の停止の原因（Epic #4371: 内部のプロセスが SIGTERM、OOM の記録なし）
  - VM の割り当てを 8 に減らしたときの CI の所要
  - `os.loadavg()` が Docker の VM の vCPU の負荷をどこまで含むか（macOS のハイパーバイザーのスレッドとして数えられる見立て）

---

## 9. PR の切り方と、この run で実装する PR1

### 9.1 PR の切り方（危険の境目で分ける）

| PR | 中身 | 境目の理由 |
|---|---|---|
| **PR1** | セマフォの核（同期 JS）・`resource.yaml` の読み手・CLI `status`／`run`・docs の節・試験 | 新しいファイルだけ。既存の取得の経路に入らない |
| PR2 | precheck の重い段・merge-pr の組み合わせ確認が枠を取る（merge-pr の下は P0、他は P2）。run-log に `slotSec` | 既存の呼び手に入る。`cpu.heavy` はそのまま（I9） |
| PR3a | `machine-lock.ts` の TS 版のセマフォと gate-runner の `mutex: cpu.heavy` を P2 の取得へ（予約を外す） | verify の裁定の経路。3 実装の一致の試験 |
| PR3b | bash（`verify-run.sh` の 2 配置）の `cpu.heavy` をセマフォへ | skills の写し・sync-map の pin |
| PR4 | ランナーのコントローラー・launchd の雛形・健康の確認・docs | マシンの外への作用（Docker・GitHub） |
| PR5 | 製品: `src/lib/flow/resource/**`・`commandmate resource status\|acquire\|release`・`GET /api/resources`・画面の資源の帯 | 製品の API と画面。`acquire`／`release` の分かれた形は保有者の pid を CLI の外のプロセスにする規則（`--holder-pid` は呼び手の親だけ、起動時刻つき）が要るので、ここで決める |
| PR6 | CI の段を同じツリーの verify で飛ばす（`ci_skip`、既定は飛ばさない） | 必須チェックに関わる。人の判断の後 |
| PR7 | 遊んでいるワーカーのセッションを止める・重い全体のテストの時間帯（P3） | セッションの停止は利用者の作業に触れる |

### 9.2 PR1 の範囲（そのまま実装の契約にできる粒度）

**変更するファイル**（scope.allow）:

- `scripts/orchestrate/resource-sem.mjs`（新規）— `acquireSlots`・`readSemState`・`computeCapacity`・`gateNext`（門の純関数）・`orderWaiters`（並べの純関数）・`retirable`（回収の判定。`holderState`／`ticketRetirable` を呼ぶ）
- `scripts/orchestrate/resource-config.mjs`（新規）— `loadResourceConfig({ path, env, ncpu })` → `{ S, C, loadCeiling, loadResume, ... }` か `{ error }`
- `scripts/orchestrate/resource.mjs`（新規）— CLI `status [--json]`・`run --priority --weight --reason [--timeout] -- <cmd>`。exit: 0 子の 0／子の exit code／2 引数・設定の誤り／3 期限切れで入れず
- `tests/unit/scripts/orchestrate/resource-sem-4370.test.ts`・`resource-config-4370.test.ts`・`resource-cli-4370.test.ts`（新規）
- `docs/orchestrate/ci-merge.md`（`## 6-1-1 重い検証の資源制御と待ちの記録` の節に「マシンの枠（`resource.mjs`）」の項を足す）
- `docs/design/resource-4370.md`（実装で実コードに合わせた点を §10 として足す）
- `changelog.d/4370.md`（既存の 1 項目へ統合）
- 触らない: `machine-lock-sync.mjs`・`machine-lock.ts`・`verify-run.sh`・`precheck.mjs`・`merge-pr.mjs`・`.commandmate/verify.yaml`・`tests/setup.ts`・`src/**`

**受入基準**（PR1）:

1. 枠の和: 一時 root で weight 2 の `run` を C=3 で 2 本同時に起こすと、2 本目は 1 本目の解放まで子を起動しない（子が書く開始・終了の時刻で重ならないことを確かめる）
2. 優先度: P2 の待ち手が先にいても、後から来た P0 が先に入る。P0 が入るまで後ろの P3 は入らない（詰め込みなし）
3. 門: `loadavg` を注入して ceiling 以上にすると P2・P3 は入らず P0・P1 は入る。resume を下回ると P2 が入る。間の値では前の状態のまま
4. 回収: SIGKILL した保有者（グループも死）の枠は次の周期で回収され、`events` に `reclaim`。グループが生きていれば回収しない。`kill -0` が EPERM（注入）なら回収しない
5. 待ちの記録: 入ったときの `waitedMs` が保有者の記録・`events.jsonl`・`run` の stderr の 1 行（`resource: admitted P2 weight=2 waited=<秒>s`）に出る
6. 拒否: `weight > C`・`C < 1`・知らない鍵・壊れた YAML は exit 2 で、待ち手・保有者の記録を書かない
7. 解放の 1 回きり: 2 回目は `none`、他人の token の記録を消さない
8. 既存を弱めない: `cpu.heavy.lock` を別に取っている間も `run` は入れ、`cpu.heavy.lock` の中身・札は変わらない（I9）

**試験の表**（`it.each` の行の形。陽性＝直す前・素朴な実装で赤になる対照、陰性＝変わらない動き）:

| # | 入力 | 状態 | 期待 | 対照 |
|---|---|---|---|---|
| T1 | P2 w2 ×2、C=3 | 空 | 2 本目は待ち、1 本目の解放の後に入る | 陽性: 受付のロックの外で和を数える版（2 本とも入る）を注入で作り赤 |
| T2 | P2 w1 ×3、C=3 | 空 | 3 本とも入る | 陰性 |
| T3 | P3 → P2 → P0 の順に到着、C=1、保有者 1 | 満杯 | 解放の後 P0 → P2 → P3 | 陽性: 到着順だけの版で赤 |
| T4 | P0 w3・後ろに P3 w1、C=3、保有 w1 | 2 空き | P3 も入らない | 陽性: 詰め込みの版で赤 |
| T5 | P2、load1 = ceiling | open | closed、入らない | — |
| T6 | P0／P1、load1 = 2×ceiling | closed | 入る | 陰性 |
| T7 | load1 = 0.9×ceiling | closed | closed のまま | 陽性: 揺れ止め無しの版で赤 |
| T8 | load1 = 0.8×ceiling | closed | open、P2 が入る | — |
| T9 | `loadavg` = [0,0,0] | — | 門は open | 陰性 |
| T10 | 保有者 SIGKILL（グループ空） | 保有 | 回収 | — |
| T11 | 保有者の pid は死、グループ生 | 保有 | 回収しない | 陽性: pid だけを見る版で赤 |
| T12 | `kill -0` EPERM（注入） | 保有 | 回収しない、`events` `unknown` | — |
| T13 | 保有者の pid が再利用（`startOf` 注入で起動が新しい） | 保有 | 回収 | — |
| T14 | 壊れた保有者の記録 | — | 満杯とみなし入らない、`corrupt` 1 回 | 陽性: 読めない記録を飛ばす版で赤 |
| T15 | 別の host の保有者 | — | 回収しない | 陰性 |
| T16 | `timeoutMs` 切れ | 待ち | 待ち手の記録が消え `acquired:false`、`run` exit 3、子は起動しない | — |
| T17 | 解放 ×2 | 保有 | `released` → `none` | — |
| T18 | 他人の token の記録が自分の名前に（作為） | — | 消さない | — |
| T19 | `weight` = C+1・0・小数 | — | exit 2、記録なし | — |
| T20 | `resource.yaml` 無し | — | 既定（share 0.4） | 陰性 |
| T21 | 知らない鍵／壊れた YAML／`C < 1` | — | exit 2 | — |
| T22 | `events.jsonl` が書けない（root を 0555） | — | 取得は成功、stderr に警告 | — |
| T23 | `cpu.heavy.lock` を別に保有 | — | `run` は入る、`cpu.heavy.lock` の owner・札は前後で同じ | 陰性（I9） |
| T24 | `ownerFields` 相当の予約の欄を `--reason` などで渡そうとする | — | 記録の `pid` は自分のまま | 陰性（I7） |

試験は `fs.mkdtempSync(os.tmpdir())` の root と `CM_RESOURCE_CONFIG` で隔離し、`afterEach` で消す。`loadavg`・`startOf`・`pidAlive`・`groupAlive`・`now`・`sleep` は注入する。子プロセスを使う試験（T1・T10・T11・T16）は `sleep` の短い子で、終了を待ってから消す。

**gates**: `lint`・`typecheck`・`unit-related`（scope は上のファイル）、加えて `work-evidence`・`scope`・`env-clean`。確かめのコマンドは `npx vitest run tests/unit/scripts/orchestrate/resource-*-4370.test.ts tests/unit/guards tests/unit/docs`。

**PR1 の後に残ること**: 呼び手は CLI `run` だけで、precheck・merge-pr・verify の `cpu.heavy` はまだ枠を通らない（PR2・PR3）。受入条件 3（ランナー）・4（CI の段を飛ばす）は PR4・PR6。
