# verify-run.sh の保有者にゲートのグループを記録する（Issue #4288 の 1 番）

- 状態: 設計（実装は Codex の事前レビューの後、同じブランチの別の契約）
- 行番号は 2026-11-09 の `fix/4288-verify-lock-pgid`（`55b8192e0`）のもの。名前で引くこと
- **事実**＝コード・記録で確かめたこと、**見立て**＝推したが試していないこと、**未確認**＝この段で確かめていないこと

## 止める点

無し。直しは owner の任意の欄 `pgid`（#4277 で規約済み: `docs/design/merge-queue-fair-lock-4277.md:98`・`:134`、`docs/design/verification-config.md:537`）を **verify-run.sh も書く**だけで、札（ticket）の形・回収と解放の規約・読み手（bash／TS／同期 JS）は変えない。verify.yaml とゲートの定義も変えない。

## 1. 今の順序（事実）

`.claude/skills/cmate-verify/scripts/verify-run.sh`（`.agents` の写しと `cmp` 一致）:

| 順 | 箇所 | 中身 |
|---|---|---|
| 1 | `:904`–906 `lock_acquire` | `mkdir "$LOCK_PATH"` の直後に `printf '{"pid":$$,"host","token","acquiredAt"}' > owner`。**pgid は書かない** |
| 2 | `:1066`–1070 `run_gate_attempt` | `set -m; ( cd && exec /bin/sh -c "$rga_cmd" ) &; rga_pid=$!; set +m`。ゲートは自分のグループ G（=rga_pid）の長になる |
| 3 | `:1077`–1078 | `ps -o pgid=` で G=rga_pid を確かめ、取消しの宛先 `rga_target=-G`（確かめられなければ pid） |
| 4 | `:1080`–1086 | 見張り（watchdog）。`sleep timeoutSec` → `kill -TERM -- -G` → 猶予 → `kill -KILL -- -G`。見張りは**本体のグループ**に居る |
| 5 | `:1089`、`:1103`、`:1109` | `wait` → 見張りを KILL → `lock_release`（token が自分のときだけ `rm -rf`、`:946`–955） |
| 6 | `:130`、`:960`–963 | EXIT trap（`cleanup_workdir`）→ `lock_cleanup_on_exit` → 持っていれば `lock_release` |

回収の判定は `lock_record_gone`（`:705`–708）＝`lock_owner_is_dead`（同 host・`kill -0` が ESRCH）**かつ** `lock_group_is_empty`（`:695`–703。pgid が無い・1 以下なら空と見なす）。`:917`–920 で `lock_recover` へ進む。TS は `readOwner`（`src/lib/verification/machine-lock.ts:229`–242）・`holderGone`（`:302`–306）・`:616`–620、同期 JS は `scripts/orchestrate/machine-lock-sync.mjs:106`・`:157`–161・`:421`–427 で同じ判定。

repro-1.md の `ps`（bash: holder alive）: 本体 `57531 PGID 57531`、ゲート `57615 PGID 57615 PPID 57531`、見張り `57619 PGID 57531`。本体だけ SIGKILL の後、ゲートは `PPID 1` で生き、owner は `{"pid":57531,…}`（pgid 無し）のまま。bash も TS（`timeoutMs:0`）も stale として回収し、旧ゲートと新しい保有者が同時に動いた。**本体の pgid（57531）は G と違う**ので、本体の pgid を足しても G を代表しない。

## 2. 何に生存を代表させるか

| 案 | 評価 |
|---|---|
| A 本体を新しいグループの長にし、ゲートも同じグループへ | 不採用。bash 3.2・macOS に `setsid(1)` が無く、本体のグループは呼び手が決める。ゲートと本体が同じグループだと見張りの `kill -- -G` が本体まで殺す |
| B 本体の pgid を書く | 不採用。G と違う（上の ps）。呼び手の非対話シェルのグループなら呼び手が生きる間ずっと「生存」になり、死んだロックが外れない |
| C ゲートごとに owner の pgid を G に書き換える（起動の後） | 方向は正しいが、fork から書き換えまでの窓で本体が死ぬと pgid 無しのまま回収され、ゲートは走る |
| D 代表のプロセスを別に置く | 不採用。代表の pid も fork の後にしか分からず C と同じ窓が残る。プロセスが 1 つ増える |
| **E（採用）= C ＋ 起動の受け渡し** | ゲートの子を「合図が出るまで exec しない」形で起こし、本体が owner に G を書いてから合図を出す |

E の手順（`run_gate_attempt` の中だけ。見立て、実装で実測）:

1. `$WORKDIR` に合図のパス `go=$rga_log.go` を決める（作らない）。
2. `set -m; ( until [ -e "$go" ]; do kill -0 "$LOCK_SELF_PID" 2>/dev/null || exit 125; sleep 0.05 2>/dev/null || sleep 1; done; cd "$CWD" && exec /bin/sh -c "$rga_cmd" ) > "$rga_log" 2>&1 &`（`$$` はサブシェルでも本体の pid。bash 3.2 に `BASHPID` は無いので使わない）。
3. `ps -o pgid=` で G=rga_pid を確かめる（子は待っているので、速いゲートが先に終わって pid 扱いになる今の揺れも無くなる）。
4. mutex を持っていて G を確かめられたときだけ、owner を **`$LOCK_PATH/.owner-$LOCK_TOKEN` に `{"pid":$$,"host","token","acquiredAt","pgid":G}` を書いて `mv -f` で `owner` へ**（同じディレクトリ内の rename で原子的。読み手は旧か新のどちらかしか見ない。前例 `machine-lock-sync.mjs:410`–418 の `setOwnerFields`）。書く前に token が自分のものか確かめる。本体が生きている間は誰も回収しない（pid が生きている）ので、確かめてから rename までに横取りされない。
5. `: > "$go"` で合図。以降は今の 4〜6 のまま。

本体が死ぬ時点ごとの結果: 2 の前／2〜4 の間＝owner は pgid 無しだが子は合図を待ち、本体の死を見て exit 125 で消える（ゲートは走らない）→ 回収してよい。4〜5 の間＝owner は G を指し、子が生きている間は回収されない。子は exit 125 → G が空 → 回収。5 の後＝G のゲートが生きている間は回収されない（今回の穴を塞ぐ）。G を確かめられなかった（job control が効かない）ときは pgid を書かず今と同じ動き。待ちの間に本体の pid が再利用されると子が待ち続けて G が空にならない（待つ側に倒れる）。待ちに上限（例 10 秒で exit 125、本体はゲートの失敗として記録）を置くかは事前レビューで決める（未確認）。

取消し・timeout は変えない: `rga_target=-G` と見張りは今のまま。解放は token だけで判定し、グループの生存を見ない（今のまま。正常終了の後に G に孤児が残っても解放する）。

**同じ理由の別の条件（見立て、要固定）**: TERM／INT を本体だけに送ると、EXIT trap（6）が G の生存を見ずに解放する。/bin/bash 3.2.57 で「`wait` 中に TERM を受けると EXIT trap が走る」ことは手元の 1 行の実験で確かめた（rc=143、trap の出力あり）。G は別グループなので TERM は届かず、ゲートが走ったまま次の保有者が入る。直し: 走っているゲートの G を変数に持ち、`lock_cleanup_on_exit` は G が空でなければ `kill -TERM -- -G` を送り、`KILL_GRACE_SEC` まで空になるのを待ち、空になったときだけ解放する（空にならなければ owner を残し、G が空になった後の回収に任せる）。取消しの意味（止めたら止まる）は強まる方向で、今の TERM の後に残るゲートは見張りの timeout まで走っていた。

## 3. 新旧の互換（読み手 × owner の形）

| owner の形 | bash `lock_record_gone` | TS `holderGone`（同期 JS も同じ） |
|---|---|---|
| 旧 `{pid,host,token,acquiredAt}`（旧版 verify-run.sh、TS gate-runner、precheck） | pid が ESRCH なら回収（今のまま。旧版の保有者の穴は旧版が消えるまで残る） | 同じ（`validPgid` が偽 → pid だけで判定） |
| 新 verify-run.sh、合図の前（pgid 無し） | pid が ESRCH なら回収。子は合図を待つだけで走らないので安全 | 同じ |
| 新 verify-run.sh、`pgid:G` | pid が ESRCH **かつ** `kill -0 -- -G` が ESRCH のときだけ回収 | `pidAlive` 偽 **かつ** `groupAlive(G)` 偽のときだけ |
| merge-pr `pgid:<inner pid>` | 今のまま（読み手は変えない） | 今のまま |
| `pgid` が 1 以下・数でない | 空と見なす（`:696`–697） | `validPgid` が偽 → pid だけ |

別 host は読み手 2 つとも「生きている」扱い、pid の再利用は「生きている」側に倒れる（待つだけ）。どちらも今のまま。#4277 以前の読み手は pgid を読まないが、#4277 の札を知らない版との混在は既に「範囲外」（4277 §0 B'）。

## 4. owner を読む・書く全経路

- **書く**: verify-run.sh `lock_acquire`（`:904`–906）・**新たに** `run_gate_attempt` の書き換え／`lock_recover` の戻し（`:846`、mv で中身ごと）。machine-lock.ts `claim`（`:430`–438）・`breakStale` の戻し（`:477`）。machine-lock-sync.mjs `claim`（`:245`）・`recoverLock`（`:289`）・`setOwnerFields`（`:410`、merge-pr `:908`・`:922` が使う）。
- **読む**: verify-run.sh `lock_owner_field`（`:672`）→ 回収（`:914`–920）・解放（`:952`）・待ち表示（`:924`–926）。machine-lock.ts `readOwner` → 回収（`:616`）・解放（`:602`）・`heldBy`（`:540`）。machine-lock-sync.mjs `readOwner`（`:106`）→ 回収・解放・`heldBy`、merge-pr `heldByLine`（`:889`）、precheck の重い段（`precheck.mjs:514`、同じ関数）。
- 説明: `SKILL.md:286`（.claude／.agents）、`verification-config.md:537`。`pgid` の意味は既にここにあり、「verify-run.sh はゲートのグループを書く」を足す。
- 探して無かったもの: `consistency-review.mjs` の `.lock` は別の規約（machine-lock ではない）。`env-snapshot.ts`・`session-kill-ledger.ts` の一致は owner ではない。

## 5. テストの設計（実装の契約で書く）

- 新しい `tests/unit/skills/cmate-verify/verify-run-holder-group-4288.test.ts`。`fs.mkdtempSync(os.tmpdir())` に git repository・`holder.yaml`（`mutex: repro`、ゲートは pid ファイルを書いて `exec /bin/sleep 30`）を置き、全 actor に `CM_VERIFY_LOCK_ROOT` と TS の `root` を渡す。`afterEach` で自分が起こしたグループだけを `kill(-pgid)` し、一時ディレクトリを消す。
- 筋書き（repro-1.md と同じ）: 本体を `spawn(..., { detached: true })` → ゲートの pid ファイルを待つ → **対照**: 本体が生きている間は bash（`timeoutSec:1`）が exit 22・`mutex-wait`、TS `acquireMachineLock(..., { root, timeoutMs: 0 })` が `acquired:false` → owner に `pgid` = ゲートの pid があること → **本体だけ** `process.kill(bodyPid, 'SIGKILL')` → 旧ゲートが生きている間は bash・TS とも取れない → 旧ゲートのグループを KILL → bash・TS とも取れる。
- **陽性の対照**: 直す前の verify-run.sh でこのテストが落ちることを、実装のコミットの前に 1 回走らせて記録する（コミット本文）。テストの中にも「pgid 無しの旧形の owner を手で書き、生きたゲート役のプロセスを置く → bash・TS とも回収する」を置き、検出の仕掛けが回収を実際に見分けられることを示す。
- 受け渡しの窓: 本体が合図の前に死ぬと、ゲートの pid ファイルが作られず（ゲートが走らず）、子が消えた後に取れること。窓に確実に入るための止め所（テスト専用の環境変数で合図の直前に止める等）を足すかは事前レビューで決める（**未確認**: 足さずに窓を狙えるか）。
- TERM の経路: 本体へ TERM → ゲートのグループが空になってから解放、空にならないゲート（TERM を無視）は owner が残り、グループが空になると回収できる。
- 互換の表駆動: §3 の 5 行 × bash／TS（＋同期 JS）を、生きている・死んだ pid とグループの組で回す（TS は `__testHooks` の `pidAlive`／`groupAlive`、bash は実プロセス）。
- 既存の期待は変えない: `tests/unit/verification/machine-lock*.test.ts`、`gate-mutex*.test.ts`、`tests/unit/skills/cmate-verify/*`（`dual-placement.test.ts` の .claude／.agents の `cmp` 一致を含む）。`.claude/skills/sync-map.json` の pin は再計算し、`commandmate-skills` への移植（counterpart）は別途。

## 本文に無い指摘（この Issue では直さない）

- `src/lib/verification/gate-runner.ts:715`–724: 製品ランナーもゲートを `detached: true` で別グループに起こし、owner は `pid: process.pid`（`machine-lock.ts:585`）だけ。サーバーが SIGKILL で死ぬと同じ形で回収される（見立て）。TS には `setOwnerFields` に当たる口が無い。
- `scripts/orchestrate/precheck.mjs:514`: 単独で走る precheck の重い段のロックも pgid 無し。precheck だけが死ぬと vitest・tsc の子が残る（見立て。merge-pr の内側から呼ばれるときはマージのロックがグループを持つ）。
