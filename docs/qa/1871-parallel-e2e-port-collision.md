# 並列 worktree の e2e ポート衝突が env 注入で消えることの実機記録（Issue #1871）

Epic #1848（v0.26.0）の受入条件のうち唯一未達で残っていた 1 件の回収記録である。

Issue #1771 の env 注入（`CM_WORKTREE_ID` / `CM_WORKTREE_INDEX`）は v0.26.0 で出荷済みだが、
**それを使う配線がどのリポジトリにも入っておらず、症状が消えたことが一度も確認されていなかった**。
本書はその確認そのものであり、成果物の中心はコードではなくこの表である。

---

## 1. 着手前の裏取り（Issue 本文 vs 実装）

| Issue 本文の主張 | 実測 | 一致 |
|---|---|---|
| `gate-runner.ts` の `runCommand` が env を注入済み | `src/lib/verification/gate-runner.ts:1009-1010`（`executeRun` 内の `gateEnv()`。`runCommand` という名の関数は無く、実体は `spawn` する `runGateAttempt`） | ほぼ一致（関数名のみ相違） |
| 採番は `~/.commandmate/worktree-index/<n>` へ `O_EXCL` | `src/lib/verification/worktree-index.ts:96-106`（`writeFileSync(..., {flag:'wx'})`） | 一致 |
| index 0〜41 の 42 件が採番済み | 42 件。**ただし 0〜39 の 40 件は `wt-*` ＝ テストの漏れ**で、実在 worktree は 40/41 の 2 件のみ（§6 参照） | 部分的に一致 |
| 単体テストあり（`gate-mutex.test.ts:181`） | 同ファイル `describe('gate environment (Issue #1771)')` に 4 件 | 一致 |
| CommandMate の `verify.yaml` に e2e ゲートが無い | lint / typecheck / unit のみ | 一致 |
| `playwright.config.ts` は `CM_E2E_PORT` 対応済み・3000 は拒否・`CM_WORKTREE_INDEX` は見ていない | 一致 | 一致 |
| 3177〜3218 は空き | 実測では 3000 以外に 3xxx の LISTEN 無し | 一致 |

**乖離 1 件**: 実在 worktree の index は 40/41 から始まるので、本記録のポートは Issue 本文が想定した
`3177+0,1` ではなく `3177+42,43` = **3219 / 3220** になった。導出式は同じで、値が違うだけである。

---

## 2. 採用した配線 — (b) `playwright.config.ts` 側で導出

Issue は (a) `verify.yaml` のコマンドで `CM_E2E_PORT=$((3177+${CM_WORKTREE_INDEX:-0}))` と
(b) `playwright.config.ts` の `resolveE2EPort()` が `CM_WORKTREE_INDEX` を見る、の 2 案を挙げていた。
**(b) を採った。理由は 3 つ**:

1. **verify 経由でなくても効く。** (a) は verify.yaml のゲートを通ったときだけ働く。CommandMate は
   その e2e ゲートを常設しない（§5）ので、(a) だと配線が存在しない状態に戻る。
2. **既定値と検証が型のある場所に置ける。** `${CM_WORKTREE_INDEX:-0}` の既定値は必須だが、シェル
   算術は不正値（`abc`）を 0 として黙って評価する ＝ **全 worktree が 3177 に潰れる、まさに直そうと
   している衝突が再発する**。(b) は不正値を例外にできる（`tests/e2e/fixtures/e2e-port.ts`）。
   未設定・空文字だけがオフセット 0 で、これは #1871 以前の挙動と同一。
3. **単体テストで固定できる。** 導出規則を `tests/e2e/fixtures/e2e-port.ts` に分離したので
   `tests/unit/config/e2e-port.test.ts` が 9 ケースで固定する（`playwright.config.ts` 自体は import
   時に `~/.commandmate-e2e` を mkdir して git を起動するため、テストから読めない）。

優先順位は **`CM_E2E_PORT`（明示） > `CM_WORKTREE_INDEX`（導出） > 3177（既定）**。
明示を上に置いたのは、§4 の**対照実験がそれ無しには書けない**ためでもある。

---

## 3. 実験計画

3 ラウンドとも **2 つの linked worktree で同時に** `commandmate verify --gates <id>` を起動し、
ゲートの実 exit code・CLI の実 exit code・**実際に LISTEN したポート**（1 秒間隔の
`lsof -nP -iTCP -sTCP:LISTEN` サンプリング）を記録した。3 ゲートは同一の 1 spec
（`tests/e2e/worktree-list.spec.ts`、10 passed / 1 skipped）を走らせ、**ポートの決め方だけが異なる**。

| ラウンド | ゲート | ポートの決め方 | 仮説 |
|---|---|---|---|
| R1 治療群 | `e2e` | `CM_WORKTREE_INDEX` から導出 | 両方 PASS・互いに別ポート |
| R2 対照群 | `e2e-fixed` | `CM_E2E_PORT=3177` 固定 | 衝突して片方が FAIL |
| R3 mutex | `e2e-mutex` | 固定 3177 ＋ `mutex: cm-e2e-probe.3177` | 両方 PASS・直列化・`waited=` |

**R2 が落ちて初めて R1 の緑が主張になる。** 両方緑では「env 注入が効いた」のか「そもそも重なって
いなかった」のか区別できないため、対照群は必須である。

環境: 2026-08-21 / macOS (Darwin 25.6.0) / CommandMate サーバ 0.26.0（`/api/app/update-check` の
`currentVersion` で確認。ポート 3000 で稼働中、停止も再起動もしていない）。ゲートはサーバプロセスが
`spawn(shell:true, {...process.env, CI:'true', ...gateEnv})` で実行するため `CI=true` ＝
`workers:1` / `retries:2` で走っている。

計測用 worktree（**削除していない。削除の可否は人間が判断する**）:

- `/Users/maenokota/share/work/github_kewton/commandmate-e2e-probe-a` — branch `probe/1871-e2e-a`、index **43**
- `/Users/maenokota/share/work/github_kewton/commandmate-e2e-probe-b` — branch `probe/1871-e2e-b`、index **42**

いずれも `0c7e26f6`（develop 相当）から作り、本 PR の `playwright.config.ts` と
`tests/e2e/fixtures/e2e-port.ts` を置き、3 ゲートを宣言した**一時的な** `.commandmate/verify.yaml`
を置いてある（コミットしていない）。`node_modules` は `cp -al` のハードリンクなので実消費は 0。

---

## 4. 結果

### R1 治療群 — `CM_WORKTREE_INDEX` から導出

| worktree | index | 実 LISTEN ポート | ゲート | exit | duration | CLI exit |
|---|---|---|---|---|---|---|
| `commandmate-e2e-probe-b` | 42 | **3219** (`Ready on http://127.0.0.1:3219`) | `e2e` PASS | 0 | 18.1s | **0** |
| `commandmate-e2e-probe-a` | 43 | **3220** (`Ready on http://127.0.0.1:3220`) | `e2e` PASS | 0 | 16.9s | **0** |

**両方 PASS・互いに異なるポート。** ポートはサーバが保存した `log_tail`（run 294 / 295）から
読み取っており、「そう設定したはず」ではない。両ポートが**同時に**LISTEN していたことも
サンプリングで確認済み: 3219 は 11:15:35–11:15:47、3220 は 11:15:35–11:15:46、
**両方が同一サンプルに写った秒が 11 秒**。重なりは仮定ではなく観測である。

### R2 対照群 — 両方 `CM_E2E_PORT=3177` 固定

| worktree | 要求ポート | 実 LISTEN | ゲート | exit | duration | CLI exit |
|---|---|---|---|---|---|---|
| `commandmate-e2e-probe-a` | 3177 | 3177 (pid 84441) | `e2e-fixed` PASS | 0 | 13.0s | **0** |
| `commandmate-e2e-probe-b` | 3177 | **バインドできず** | `e2e-fixed` **FAIL** | **1** | 3.9s | **20** |

probe-b の log_tail 実文:

```
[WebServer] Port 3177 is already in use
Error: Process from config.webServer was not able to start. Exit code: 1
```

**対照は落ちた。** しかも落ち方が `GATE e2e-fixed FAIL (exit=1, 3.9s)` ＝
**変更の欠陥とまったく同じ綴り**であり、これが #1771 の動機そのものである。
R1 と R2 の差は「ポートをどう決めたか」だけなので、緑にしたのは env 注入である。

### R3 — `mutex:` の直列化と `waited=`

| worktree | ゲート | exit | duration | waited | CLI exit | 3177 を掴んでいた時刻 |
|---|---|---|---|---|---|---|
| `commandmate-e2e-probe-b` | `e2e-mutex` PASS | 0 | 14.2s | **0.0s** | 0 | 11:17:25–11:17:35 (pid 96915) |
| `commandmate-e2e-probe-a` | `e2e-mutex` PASS | 0 | 12.8s | **14.3s** | 0 | 11:17:39–11:17:47 (pid 2700) |

保存された marker（`verification_gate_results.log_tail` の行頭）:

```
[mutex] name=cm-e2e-probe.3177 waited=0.0s  lock=/Users/maenokota/.commandmate/locks/cm-e2e-probe.3177.lock
[mutex] name=cm-e2e-probe.3177 waited=14.3s lock=/Users/maenokota/.commandmate/locks/cm-e2e-probe.3177.lock
```

**`waited` は `duration` に足されていない**（probe-a: duration=12.8s / waited=14.3s が別々に立つ）＝
#1771 の契約どおり。2 つのポート占有区間が**重なっていない**ことも観測しており、直列化は実際に
起きている。

### 3 ラウンドの比較 — 何が買えて何を払うか

| | R1 導出ポート | R2 固定ポート | R3 mutex |
|---|---|---|---|
| 裁定 | PASS / PASS | PASS / **FAIL(偽の赤)** | PASS / PASS |
| 並列度 | **保たれる** | — | **失われる（直列）** |
| 2 worktree の wall-clock | 20s / 20s | 15s / 5s | 15s / **30s** |
| N worktree の所要 | O(1) | 破綻 | O(N) |

**#1771 の 2 段構えのうち、並列度を保てるのは env 注入だけ**という設計上の主張が、
そのまま数字で出ている（R3 の probe-a は R1 の 1.5 倍の wall-clock を払っている）。

---

## 5. 判断: e2e ゲートは**常設しない**

CommandMate 自身の `.commandmate/verify.yaml` に e2e ゲートを**足さなかった**。根拠:

1. **`verify.yaml` に宣言したゲートは既定で毎回走る。** スキーマに「宣言はするが既定では走らない」
   フラグは無い（`src/lib/verification/verify-config.ts` の `VerifyGate` は
   `id` / `command` / `timeoutSec` / `mutex` / `retryOnFail` / `flakyIsPass` のみ）。
   `gateIds` 省略時は **work-evidence ＋ verify.yaml の全ゲート**が選ばれる。
2. **その代償が大きすぎる。** フル e2e は CI 実績で 5m16s〜5m39s。常設すると
   `wait --verify` の所要が 1 ワーカーあたり 5 分以上伸び、**並列オーケストレーションの裁定時間に
   直結する**（現行 3 ゲートの合計より長い）。
3. **重複している。** フル e2e は `ci-pr.yml` が PR ごとに回している。verify のゲートは
   「ワーカーの完了を裁定する」ためのもので、PR CI の複製ではない。

代わりに**配線だけを常設した**（`playwright.config.ts`）。配線はコストゼロで、
必要になったときに以下のどちらかを足すだけで効く:

```yaml
# .commandmate/verify.yaml — 一時的に、または特定リポジトリで常設する場合
gates:
  - id: e2e
    command: "npm run test:e2e"
    timeoutSec: 1800
```

```yaml
# タスク契約側で 1 回だけ要求する場合（リポジトリ全体の所要を伸ばさない）
verify:
  gates: [lint, typecheck, unit, e2e]
```

`CM_WORKTREE_INDEX` はサーバが注入するので、**どちらの書き方でもコマンド側に算術は要らない**。

---

## 6. 副次観測（本 PR では直していない）

`~/.commandmate/worktree-index/` の 42 件のうち **0〜39 の 40 件は実在しない worktree** である
（`wt-pass` / `wt-window` / `wt-conformance-*` / `wt-counters-*` など）。出所は
`tests/unit/verification/gate-runner.test.ts` と `tests/unit/verification/gate-runner-timestamps.test.ts`
で、この 2 本は `gate-mutex.test.ts:153` / `gate-flaky.test.ts:181` と違い
`CM_VERIFY_WORKTREE_INDEX_ROOT` を stub していないため、**開発者の HOME のレジストリに直接採番して
いる**（`tests/unit/api/hooks-agent-event.test.ts` 由来の `wt-agent-event` も 1 件）。

実害は「実在 worktree の index が 40 番台から始まる」ことだけで（本記録のポートが 3219/3220 に
なった理由）、`MAX_WORKTREE_INDEX = 1024` に対して余裕はある。ただし `env-clean` ゲートが
`~/.commandmate` を見る設計である以上、テストが HOME を汚す経路は塞ぐべきである。
**本 Issue のスコープ外なので別 Issue に切ることを推奨する**（修正自体は 2 ファイルへの
`vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir(...))` 追加で済む見込み）。

---

## 7. 再現手順

```bash
# 1. 計測用 worktree（既に存在する）に本 PR の 2 ファイルを置き、
#    e2e ゲートを宣言した一時 verify.yaml を置く
# 2. 2 つ同時に起動し、exit code はファイルに落とす（grep への pipe は偽 PASS を作る）
for p in a b; do
  ( cd ~/share/work/github_kewton/commandmate-e2e-probe-$p \
    && commandmatedev verify commandmate-e2e-probe-$p --gates e2e > r_$p.log 2>&1
    echo $? > r_$p.exit ) &
done
# 3. 走っている間、実際に LISTEN したポートを観測する
while :; do lsof -nP -iTCP -sTCP:LISTEN | grep -E ':3[0-9]{3} '; sleep 1; done
```

`--gates e2e-fixed` に替えれば対照群、`--gates e2e-mutex` に替えれば mutex ラウンドになる。
