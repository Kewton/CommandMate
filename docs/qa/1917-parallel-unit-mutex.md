# 並列 worktree のフル `test:unit` を `mutex` が直列化することの実機記録（Issue #1917）

`/orchestrate` はワーカーの完了を `wait --verify` の **exit code だけ**で裁定する（#1544 / #1882）。
その exit code が**マシンの負荷で反転**していた、というのが本 Issue である。

本書は「宣言を足した」ことの記録ではなく、**足した結果 `unit` が実際に重ならなくなったことの実測**である。
Issue #1871 の記録（[docs/qa/1871-parallel-e2e-port-collision.md](./1871-parallel-e2e-port-collision.md)）と
同じ立場で、成果物の中心はコードではなく §4 の表である。

---

## 1. 着手前の裏取り（Issue 本文 vs 実コード）

Issue #1917 は起票時「マシングローバルなロックを実装する」前提で書かれ、2026-08-21 に
「**#1771 で実装済み。作らないこと**」と訂正された。訂正後の本文を実コードで裏取りした結果:

| 訂正後の本文の主張 | 実コード | 一致 |
|---|---|---|
| ロック本体（Node）は `src/lib/verification/machine-lock.ts` | `acquireMachineLock` / `machineLockPath` / `resolveMachineLockRoot` を export | 一致 |
| ロック本体（bash）は `verify-run.sh` のロック部 | `lock_acquire` / `lock_release` / `lock_owner_is_dead`（`LOCK_ROOT=${CM_VERIFY_LOCK_ROOT:-$HOME/.commandmate/locks}`） | 一致 |
| ゲートからの利用は `gate-runner.ts` | `runGateAttempt` が `acquireMachineLock(mutex, { timeoutMs: gate.timeoutSec * 1000 })` | 一致 |
| 宣言方法は `verify.yaml` の `mutex: <name>` | `GATE_KEYS` に `mutex`、`GATE_MUTEX_PATTERN` / `MAX_GATE_MUTEX_LENGTH` で検証 | 一致 |
| **どのゲートも `mutex` を宣言していない** | `.commandmate/verify.yaml` の 6 ゲートすべてに `mutex` 無し | 一致 |

**乖離は無い。** よって本 Issue の実装は #1771 の**設定適用**に閉じており、
`machine-lock.ts` と `verify-run.sh` のロック部には 1 バイトも触れていない。

---

## 2. 名前を `cpu.heavy` にした理由（§9.2 の命名規約との突き合わせ）

§9.2 は mutex 名を **「ゲート ID ではなく資源の名前」** と規定し、
`^[A-Za-z0-9_.-]+$` / 64 文字以内、そして
「別リポジトリのゲート同士が `port.60303` のような名前で排他し合ってよい」と書いている。

ここで奪い合っている資源は**固定ポートでも DB でもエミュレータでもない**。
`unit` が専有するのは **CPU と実時間**、言い換えれば「このマシンで重いスイートを走らせる枠」である。
9.1 の env 注入（`CM_WORKTREE_INDEX`）で**分けられる対象が存在しない**ので、
9 が「分けられるなら 9.1 を優先」と書いているケースには当たらず、`mutex` が正しい道具になる。

| 候補 | 採否 | 理由 |
|---|---|---|
| **`cpu.heavy`** | **採用** | 資源（重いスイート 1 枠）をそのまま名指す。`<資源クラス>.<限定子>` は §9.2 が例示する `port.60303` と同じ形。他リポジトリの重いスイートが同じ名前を宣言するだけで同じ枠に入れる |
| `unit` / `test-unit` | 却下 | **ゲート ID そのもの**で §9.2 に反する。加えて、同じ CPU を食う**別リポジトリ**の `test` ゲートと排他できない ＝ 症状が残る |
| `cpu` | 却下 | 広すぎる。5s の `lint` までこの枠を取りに来ると、秒で失敗を返すという #1882 の設計意図が消える。`heavy` は入場条件そのものを名前にしている |
| `machine.cpu` | 却下 | 意味は同じだが「どの CPU 利用者を排除するのか」を言っていない。`cpu.heavy` のほうが宣言する側の判断基準になる |

---

## 3. 実測環境

**稼働中の並列オーケストレーションを一切汚さないこと**が実測の前提である
（§9.2: 実 `~/.commandmate/locks` を使う検証は稼働中ランと排他して偽の赤を作る）。

| 項目 | 値 |
|---|---|
| マシン | 28 コア / 256GB（macOS） |
| 対象 worktree | 使い捨ての linked worktree 2 本 × 3 セット。**別リポジトリへの `git clone --local` 配下**に作り、本番リポジトリの `git worktree list` を汚さない。置き場所は実測 1 が `/private/tmp` 配下、実測 2・3 が `/Users/Shared` 配下（理由は §4.3） |
| `node_modules` | 本番 checkout からの**ハードリンク複製**（`cp -Rl`、各 20s） |
| ランナー | **製品の経路**。隔離した CommandMate サーバ（`tsx server.ts`）に 2 worktree を登録し、`commandmate verify <id>` を**同時に起動** |
| DB | `/Users/Shared/cm-1917-probe/data/cm.db`（本番 DB とは別ファイル。起動直後に `lsof` で本番 DB を掴んでいないことを確認済み） |
| ロックルート | `CM_VERIFY_LOCK_ROOT` をスクラッチへ差し替え（§9.2 の指示どおり、稼働中の並列ランと排他しない） |
| `HOME` | サーバに隔離 `HOME` を与える。**`/private/tmp` 配下に置くと path 系テストが落ちる**ので実測 3 では `/Users/Shared` 配下（§4.3） |
| ポート | 3917（本番 3000 には触れない） |

> **踏んだ罠**: シェルに `CM_DB_PATH` / `CM_PORT` / `CM_ROOT_DIR` が**本番値で export されている**。
> 最初の起動はそれを継承して**本番 DB を開いた**（`lsof` で発覚、90 秒で停止。本番 DB への worktree 登録は
> 発生していないことを API の 68 件で確認済み）。以後は `CM_DB_PATH` / `CM_ROOT_DIR` を明示上書きし、
> **起動直後に `lsof` で本番 DB を掴んでいないことを確認してから**次の操作へ進む手順にした。
> `CM_DB_PATH` を `/private/tmp` 配下に置くことはできない（`isSystemDirectory` が拒否する）。

---

## 4. 実測結果

### 4.1 機構の陽性対照 — 宣言が無ければ本当に重なるのか

「重ならなかった」という観測は、**重なりを検出できる仕掛けであることを先に示さない限り**
何も証明しない。そこで stub ゲート（開始・終了の epoch を共有ログへ追記して 12s 眠るだけ）を
2 つの使い捨てリポジトリに置き、standalone runner で同時に起動した。

| 条件 | `heavy-stub` の実時刻 | 判定 |
|---|---|---|
| **`mutex` 無し** | a: `…981.107 → …993.226` / b: `…981.107 → …993.226` | **ミリ秒まで完全に同時**。`waited=` は出力されない |
| **`mutex: cpu.heavy`** | b: `…005.935 → …018.043` / a: `…018.305 → …030.416` | **重なり 0**。GATE 行は b が `duration=13s waited=0s`、a が `duration=12s waited=13s` |

同じ `mutex` あり実行の中で、mutex を宣言していない `static-stub` は
**a/b とも `…005.488 → …005.805` で完全に同時**だった ——
**ロックはゲート単位に効き、宣言していないゲートは直列化されない**ことがそのまま出ている。

### 4.2 製品経路 — `commandmate verify` を 2 worktree で同時起動

実 `.commandmate/verify.yaml`・実 `npm run test:unit` で、CommandMate サーバ経由の
`commandmate verify` を同時に走らせた。重なりの判定は GATE 行の文言ではなく
**DB の `verification_gate_results.started_at` / `finished_at`（epoch ms）**で行う。

**実測 1（run 2 / run 3）**

| ゲート | 先行側 | 後発側 | 重なり |
|---|---|---|---|
| `unit` | `22:59:14.123 → 23:08:23.773`（549.6s, `waited=0.0s`） | `23:08:23.954 → 23:17:30.287`（546.3s, **`waited=549.6s`**） | **無し**（間隙 0.181s） |
| `lint` | 5.2s | 5.4s | **5.169s**（ほぼ全長） |
| `typecheck` | 10.6s | 10.8s | **10.564s**（ほぼ全長） |

**実測 2（run 4 / run 5）**

| ゲート | 先行側 | 後発側 | 重なり |
|---|---|---|---|
| `unit` | `23:20:18.259 → 23:29:54.321`（576.1s, `waited=0.0s`） | `23:29:54.533 → 23:38:34.120`（519.6s, **`waited=576.3s`**） | **無し**（間隙 0.212s） |
| `lint` | 5.2s | 5.2s | **5.139s** |
| `typecheck` | 10.8s | 10.8s | **10.731s** |
| `token-discipline` | 0.1s | 0.1s | **0.090s** |
| `control-chars` | 0.1s | 0.1s | **0.079s** |
| `claudemd-size` | 0.0s | 0.0s | **0.018s** |

読み取れること:

1. **`unit` は一度も重ならなかった。** 後発側の `unit` が始まるのは、先行側が終わった
   **0.2 秒後**である（ロック解放 → ポーリング間隔 250ms の範囲内）。
2. **`waited=` は先行側の所要とほぼ一致する**（549.6s ↔ 549.6s / 576.3s ↔ 576.1s）。
   待ちの正体が「相手の `unit`」であることが数字で言えている。
3. **`waited=0.0s` も出る。** §9.3 が要求する「排他されていて待たなかった」と
   「mutex が無い」の区別が、実出力で成立している。
4. **`duration` に `waited` は足されていない。** run 3 の `unit` は
   `started_at 23:08:23.954 → finished_at 23:17:30.287` ＝ 546.3s ＝ `duration` であり、
   549.6s の待ちは `started_at` より**前**にある（§9.3 準拠）。
5. **静的ガード 3 本と `lint` / `typecheck` は重なった。** 実測 2 では 5 本すべてが
   自分の所要のほぼ全長にわたって重なっている ＝ **直列化されていない**。

> 実測 1 で静的ガード 3 本が「重なり無し」と出ているのは直列化ではない。
> 2 ランの開始ずれ（0.24s）が **0.1s のゲートより長かった**だけである。
> 実測 2 では開始ずれが 0.01s に収まったので、同じ 3 本がそのまま重なっている。
> **0.1s のゲートで重なりを論じるには、ずれより長いゲートが要る** —— それが 4.1 の stub の役目である。

### 4.3 `unit` が赤かったこと（本件と無関係、全件を実測で帰属）

上記 4 ラン（run 2〜5）の `unit` はすべて `exit=1` である。**すべて probe 環境に帰属し、
本変更とも負荷とも無関係**であることを陽性対照で確認した。

| 失敗 | 実測 1（`/private/tmp` 配下） | 実測 2（`/Users/Shared` 配下） | 原因 | 反証 |
|---|---|---|---|---|
| 8 files / 50 tests | 発生 | 消失 | `process.cwd()` から `temp/` を導出するテスト群が、`/private/tmp` を `isSystemDirectory()` に弾かれる | 同じ 8 ファイルを `/Users/...` の checkout で実行 → **276/276 PASS** |
| `db-migration-path.test.ts` ×2 | 発生 | 発生 | サーバの隔離 `HOME` が `/private/tmp` 配下で、同じ system-directory 判定に当たる | 自分の worktree で `HOME` だけを probe の値に差し替えて実行 → **同じ 2 件が再現** |
| `codex-hooks-config-1760.test.ts` ×1 | 発生 | 発生 | 「生成されたフック command に `wt-` が含まれないこと」を検査する assert に、**probe worktree のディレクトリ名 `wt-c` / `wt-d` 自身**が当たった | ディレクトリ名を `alpha` / `beta` に変えた実測 3 で消失（§4.4） |

**この赤自体が本 Issue の主張の傍証でもある。** 同時実行した 2 ランは
**同一のファイル・同一の件数で落ちた**（実測 1: 8 files / 50 tests ×2、実測 2: 2 files / 3 tests ×2）。
本 Issue が問題にしている症状は「**同時実行のときだけ、片方で、diff と無関係のテストが落ちる**」
という非決定性であり、直列化された `unit` はその非決定性を示さなかった。

### 4.4 実測 3 — 環境要因を全部潰した状態での 2 本同時

実測 1・2 の赤の原因（`/private/tmp` の cwd、`/private/tmp` の `HOME`、`wt-` を含む
ディレクトリ名）をすべて潰した状態 —— worktree を `/Users/Shared/cm-1917-probe/run3/{alpha,beta}`、
サーバの `HOME` も `/Users/Shared` 配下 —— で、もう一度 2 本同時に起動した。

| ゲート | `beta`（先行） | `alpha`（後発） | 重なり |
|---|---|---|---|
| `unit` | `23:41:49.536 → 23:51:01.474`（**551.9s, PASS**, `waited=0.0s`） | `23:51:01.573 → 00:00:00.729`（**539.2s, PASS**, `waited=552.0s`） | **無し**（間隙 0.099s） |
| `lint` | 5.3s PASS | 5.5s PASS | **5.319s** |
| `typecheck` | 10.9s PASS | 10.9s PASS | **10.864s** |
| 静的ガード 3 本 | 各 0.1s / 0.0s PASS | 同 | 開始ずれ 0.18s のほうが長く不成立（§4.2 の注記と同じ） |

```
beta : RESULT passed  EXIT=0
alpha: RESULT passed  EXIT=0
```

**2 つの `commandmate verify` を同時に起動して、両方が `RESULT passed` / exit 0 を返した。**
`unit` は 1 ミリ秒も重ならず、後発側は `waited=552.0s`（先行側の 551.9s とほぼ一致）を報告している。
これが本 Issue の受入条件そのものである。

代償も数字で出ている: 後発側 `alpha` の run 全体は
`23:41:32.745 → 00:00:00.729` ＝ **1108.0s**（うち 552.0s がロック待ち）。
2 本並列なら片方の裁定は約 2 倍待つ。**それでも決定的な裁定のほうが価値が高い**、
というのが本 Issue の立場であり、`unit` の `timeoutSec: 3600` はこの待ちを十分に飲み込む。


---

## 5. `lint` / `typecheck` に付けないという決定

`lint` / `typecheck` には `mutex` を**付けない**。実測は §4.2 の表そのものである。

| ゲート | 2 worktree 同時での所要 | 同時実行時の結果 | 偽の赤の実績 |
|---|---|---|---|
| `lint` | 5.2 / 5.4s（実測 1）、5.2 / 5.2s（実測 2）、5.3 / 5.5s（実測 3） | **同時実行 6 ラン中 6 回 PASS** | 無し |
| `typecheck` | 10.6 / 10.8s（実測 1）、10.8 / 10.8s（実測 2）、10.9 / 10.9s（実測 3） | **同時実行 6 ラン中 6 回 PASS** | 無し |
| 静的ガード 3 本 | 各 0.1s / 0.0s | **同時実行 18 ゲート中 18 回 PASS** | 無し |

**同時実行の代償は「測れるほどの遅延」ですらない。** 上の表の `typecheck` 10.6〜10.9s は
**キャッシュが冷えている初回**の値で、同時実行のせいではない。キャッシュを揃えて A/B を取ると:

| 条件 | `lint` | `typecheck` |
|---|---|---|
| 単独（warm） | 5.3s | 2.5s |
| **2 worktree 同時（warm）** | **5.2s / 5.2s** | **2.4s / 2.4s** |

差は測定誤差の範囲である。28 コアのマシンでは、5s の ESLint と 2.5s の `tsc` を 2 本並べても
互いを待たせるほどのものにならない。

判断の根拠は「速いから」ではなく、**取引が割に合わないから**である:

- **得るもの**: 実測で一度も起きていない偽陽性の予防。
- **失うもの**: `mutex` を宣言したゲートは、ロックが空かないまま `timeoutSec` に達すると
  `SKIP reason=mutex-wait` ＝ run 全体が `error` ＝ **exit 99（裁定不能、§9.4）** になりうる。
  今は存在しない「裁定が得られない」経路を、**5 秒で終わるゲートに新設する**ことになる。
- 加えて静的ガード 3 本は「失敗を秒で返す」ために置かれている（#1882）。
  他 worktree の 500s のスイートの後ろに並ばせると、その設計意図が消える。

**`unit` だけは取引が逆向き**である。偽陽性は実測で 1 回起きており（#1889、640.5s の回）、
失う並列度は「もともと安全に並列実行できていなかったもの」でしかない。


---

## 6. 待ちの上限と `wait --verify` の `--timeout` の整合

- ロック待ちの上限は**そのゲートの `timeoutSec`**（`gate-runner.ts` が `gate.timeoutSec * 1000` を
  `acquireMachineLock` に渡す）。`unit` は `3600`。
- **`wait --timeout` は verify にかからない。** `wait` の `--timeout` は完了検知のポーリング
  （`pollWorktree`）にだけ効き、検証は完了検知の**後**に `verifyAfterWait` が走らせる。
  `verifyAfterWait` は `runVerification` に `timeoutSec` を渡さない（渡すのは
  `commandmate verify --timeout` だけ）。したがってロック待ちで `wait` がタイムアウトすることはない。
- 3 ワーカーが同時に完了した場合、最後の 1 本は 2 本ぶん待ってから自分で走る。
  遅い実測値 640s を使っても 3 × 640s = 1920s < 3600s で収まる。
  `commandmate verify --timeout` を使う呼び出し側だけは、この直列化を織り込む必要がある。

---

## 7. 適用範囲の限界（正直な但し書き）

- **ゲート定義は実行時に読まれる。** `gate-runner.ts` は `loadVerifyConfig(input.worktreePath)` を
  run ごとに呼び、契約（`.commandmate/tasks/*.yaml`）はゲート**定義**ではなくゲート **ID の選択**しか
  持たない。よってこの宣言は**送信済みの契約にも即座に効く**（scope が send 時スナップショットなのとは違う）。
- **効くのは、その worktree の `verify.yaml` にこの宣言が在るときだけ。** 宣言を持たないブランチで
  動いているワーカーはロックを取りに行かないので、こちらの `unit` と重なりうる。
  **develop に入り、各 worktree が取り込むまでは症状が完全には消えない。**
- **CI は影響を受けない**（1 ジョブ 1 マシン）。本件はローカル並列オーケストレーション固有である。
- **catalog 経由で導入した standalone runner には版の問題が残りうる**（本項は §9.5 の記述に依る。
  配布版の再確認はしていない）。`mutex` を受理するのは
  commandmate-skills #225 以降で、配布中の `cmate-verify` 0.4.2 はそれより前 ＝ この `verify.yaml` を
  食わせると `unknown gate key: mutex` で **exit 2** になる。CommandMate リポジトリ内の
  vendored copy（`.claude/skills/` / `.agents/skills/`）は #1861 時点で受理するので、
  **このリポジトリで動く 2 ランナーはどちらも問題ない**（本記録の実測もそれで行っている）。

---

## 8. 再現手順

```bash
S=/path/to/scratch
# 1) 本番の worktree 一覧を汚さないため、ローカルクローンの下に使い捨て worktree を 2 本作る
git clone --local --no-checkout <repo> "$S/repo"
git -C "$S/repo" checkout develop
for d in a b; do
  git -C "$S/repo" worktree add --detach "$S/wt-$d" <branch>
  cp -Rl <repo>/node_modules "$S/wt-$d/node_modules"   # ハードリンク複製（数十秒）
done

# 2) 隔離サーバ。CM_DB_PATH / CM_ROOT_DIR は**必ず明示上書き**する（シェルに本番値が export されている）
cd "$S/repo" && HOME="$S/home" NODE_ENV=development CM_PORT=3917 CM_BIND=127.0.0.1 \
  CM_DB_PATH=/Users/Shared/cm-1917-probe/data/cm.db \
  CM_ROOT_DIR="$S" WORKTREE_REPOS="$S/repo" CM_VERIFY_LOCK_ROOT="$S/locks" \
  npx tsx server.ts &

# 3) 本番 DB を掴んでいないことを確認してから先へ進む
p=$(lsof -nP -iTCP:3917 -sTCP:LISTEN -t | head -1)
lsof -p "$p" | grep -q "<repo>/data/db.sqlite" && { echo "ABORT"; kill "$p"; }

# 4) 登録して同時起動
curl -s -X POST http://127.0.0.1:3917/api/repositories/sync
env -u CM_DB_PATH -u CM_ROOT_DIR HOME="$S/home" CM_PORT=3917 npx tsx src/cli/index.ts verify wt-a &
env -u CM_DB_PATH -u CM_ROOT_DIR HOME="$S/home" CM_PORT=3917 npx tsx src/cli/index.ts verify wt-b &
wait

# 5) 重なりは GATE 行ではなく DB の実時刻で判定する
sqlite3 /Users/Shared/cm-1917-probe/data/cm.db \
  "SELECT run_id,gate_id,started_at,finished_at FROM verification_gate_results ORDER BY id"
```
