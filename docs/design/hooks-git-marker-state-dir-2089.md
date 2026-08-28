# hooks-git.sh の once-per-worker マーカー置き場（Issue #2089）

- 対象: `.claude/skills/orchestrate-monitor/scripts/hooks-git.sh`
- 実測日: 2026-08-27 / develop `786e4765` / macOS Darwin 25.6.0 / bash 3.2.57
- 状態: **テスト側は #2089 で、本番（standalone）側は #2119 で修正済み**（#2089 で見送った理由は §4「なぜ本 Issue で入れなかったか」、着地の実測は §6）

---

## 1. 事象と、Issue 本文との差

Issue #2089 は「並列フル `test:unit` のときだけ stderr 診断が落ちる」「高負荷下で
診断が出ない条件は何か」と書いている。**負荷ともタイムアウトとも無関係**である。
決定的に再現でき、3 回の観測すべてがバイト一致で再現する。

観測された失敗はすべて次の 2 形だった。どちらも assertion diff であって、
`Test timed out in …` でも `status: 141` でもない。

```
AssertionError: expected '' to contain 'status --porcelain\' failed (exit 130)'
AssertionError: expected [] to have a length of 1 but got +0
AssertionError: expected '' to contain 'monitor hooks WARN:'
```

## 2. 機構

`hooks-git.sh` の診断は `<worktree-id>.<cause>` ごとに 1 回だけ出る。「もう出した」の
記録は**ファイル**である（`monitor.sh` はカウンタを `$(...)` の subshell で呼ぶので、
シェル変数では次のポールまで生き残らない — これは設計として正しい）。

```sh
MONITOR_HOOKS_STATE_DIR=${MONITOR_HOOKS_STATE_DIR:-${STATE_DIR:-${TMPDIR:-/tmp}/cm-monitor-hooks-$$}}
...
[ -f "$mh__marker" ] && return 0        # mh_report_once()
```

壊れているのは**フォールバックの同一性**で、3 つの事実が噛み合って起きる。

1. **`$$` は再利用される。** macOS の PID 空間は約 10 万で周回する。無関係な 2 つの
   `bash -c` が同じ pid を引けば、同じディレクトリを共有する。
2. **誰も掃除しない。** `monitor.sh` 経由なら自分の `STATE_DIR` を EXIT trap で消すが、
   素の `. hooks-git.sh` にはオーナーがいない。実測: `$TMPDIR` に
   `cm-monitor-hooks-*` が **4102 ディレクトリ / マーカー 4163 個**。
3. **キーがテスト固定値。** 残っていたマーカーのキーはすべてテスト fixture の id
   （`myrepo-feature-x.status` / `nope-nope.no-checkout` /
   `shared-name.ambiguous-basename` …）で、次の run が出そうとするキーそのもの。

結果、再利用 pid を引いた run は**自分が書いていない** `warned-…` を見つけ、
`mh_report_once` が黙って `return 0` する。#1614 と #1728 が「絶対に消えない診断」に
したはずの 1 行が消える。

**並列でだけ落ちて見えた理由**は、並列実行が pid を速く消費して再利用域へ早く回り込む
ため。ディレクトリ数は単調増加するので確率も単調に悪化する。

### 再現（本 Issue の修正前）

```sh
D=$(mktemp -d); : > $D/warned-myrepo-feature-x.status
MONITOR_HOOKS_STATE_DIR=$D npx vitest run tests/unit/skills/orchestrate-monitor/monitor-exit-codes.test.ts
# → expected '' to contain 'status --porcelain\' failed (exit 130)'   （観測 2・3）
# → expected [] to have a length of 1 but got +0
```

さらに `MONITOR_HOOKS_STATE_DIR` を 1 つに固定して**空**で回すだけでも
`prints the git failure a single time across a multi-poll run` が落ちた。
**テストどうしが既に干渉していた**（既定では pid が別なので露見しなかっただけ）。

## 3. 本 Issue で入れた修正（テスト側）

`tests/helpers/hooks-git-diagnostics.ts` の `useIsolatedHooksStateDir()` が
**テストごとに** state dir を切り、`hooks-git.sh` を source する 3 つの suite
（`monitor-exit-codes` / `hooks-git-resolution` / `monitor-observability`）が
spawn env に明示的に渡す。`$TMPDIR` のフォールバックはもう参照されない。

**粒度は「テストごと」であって「呼び出しごと」ではない。** マーカーの目的は 1 回の
run の中で複数回の呼び出しを跨いで生き残ることなので、`monitor.sh --max-polls 4` は
今も警告を 1 回だけ出さねばならない。呼び出しごとに隔離すると被試験挙動の逆を
assert することになる。ファイルごとでも足りない（§2 末尾の干渉が残る）。

副次効果として `$TMPDIR` への堆積が止まる。上記 3 suite が litter の**生産者**
だったため（フル run ごとに約 15 ディレクトリ）。実測: 修正後は 3 suite を 3 回
フル実行してもディレクトリ数 4102 のまま増えない。

診断の失敗メッセージも分離した（Issue 本文の依頼 3）。stderr が空のときは
`expected '' to contain '…'` ではなく「**診断が 1 行も出ていない**」と明言し、
「文言が変わった」ケースとは別の文面にする。文言そのものを
`tests/unit/skills/orchestrate-monitor/hooks-git-diagnostics.test.ts` が pin している。

## 4. standalone 経路（本番側）— #2089 時点では未修正、#2119 で着地

`monitor.sh` を介さず `hooks-git.sh` を source したオペレーターは、いまも
`$TMPDIR` に残った他人の（あるいは過去の自分の）マーカーで本物の WARN / ERROR を失う。
テスト側が litter を作らなくなったので**新たな毒の供給は止まる**が、既に堆積した
4102 ディレクトリと、standalone 同士の pid 衝突は残る。

推奨する修正（`hooks-git.sh` :47-54 のコメントに書かれた `$$` の設計意図
— subshell を越えて残ること・monitor.sh 配下では STATE_DIR に相乗りすること —
はどちらも保たれる）:

```sh
# 現在
MONITOR_HOOKS_STATE_DIR=${MONITOR_HOOKS_STATE_DIR:-${STATE_DIR:-${TMPDIR:-/tmp}/cm-monitor-hooks-$$}}

# 案: pid を鍵にするのをやめ、衝突しない名前を一度だけ作る
if [ -z "${MONITOR_HOOKS_STATE_DIR:-}" ]; then
  if [ -n "${STATE_DIR:-}" ]; then
    MONITOR_HOOKS_STATE_DIR=$STATE_DIR          # monitor.sh 配下: 従来どおり相乗り
  else
    MONITOR_HOOKS_STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cm-monitor-hooks-XXXXXXXX" 2>/dev/null) \
      || MONITOR_HOOKS_STATE_DIR=${TMPDIR:-/tmp}/cm-monitor-hooks-$$
    MONITOR_HOOKS_STATE_DIR_OWNED=1             # 掃除の可否を判定するため
  fi
fi
```

`mktemp -d` は既存ディレクトリを再利用しないので、**pid 再利用による誤抑止は消える**。
残るのはディスクのリークだけで、それは「診断を失う」より桁違いに軽い。
掃除まで入れるなら、`MONITOR_HOOKS_STATE_DIR_OWNED=1` のときだけ EXIT trap で自分の
ディレクトリを消す（他プロセスが使用中のディレクトリには触れない）。ただし sourced
ファイルが EXIT trap を張るとオペレーターの trap を潰しうるので、`trap -p EXIT` が
空のときだけ張ること。

### なぜ本 Issue で入れなかったか

**scope 外のファイルを巻き込まないと `npm run test:unit` が緑にならないため。**

`.claude/skills/sync-map.json` が `.claude/skills/orchestrate-monitor/` 配下の
**全ファイルの sha256 を pin** している（`tests/unit/skills/sync-map.test.ts`、
Issue #1612 のクロスリポジトリ drift ゲート）。実測:

```
pinned : 096e9c12f3aff269fdebaa2a217958f9c20895884ab8c629358080584549dff4
actual : 096e9c12f3aff269fdebaa2a217958f9c20895884ab8c629358080584549dff4
```

pin と現行バイトが一致しているので、`hooks-git.sh` を **1 バイトでも**変えると
`sync-map.test.ts > … hooks-git.sh matches its pinned digest` が赤になる。
ファイル追加でも同じ（`lists every file under a mapped package` が
working tree と map の不一致を落とす）。緑に戻すには
`node scripts/skills-sync-map.mjs update` で `.claude/skills/sync-map.json` を
再生成する必要があるが、これは本タスクの `scope.allow`
（`.claude/skills/orchestrate-monitor/**`）の**外側**にある。

本 Issue の変異注入 M4 でこれは実測済み: `hooks-git.sh` の `mh_report_once` の条件を
1 文字反転しただけで `sync-map.test.ts` が赤になった。

**したがって `scope.allow` の 1 番目の項目
（`.claude/skills/orchestrate-monitor/**`）は、`.claude/skills/sync-map.json` を
伴わない限り実際には使用不能である。** 後続で本番側を直すときは、scope に
`.claude/skills/sync-map.json` を足して `send --contract` で切り直すこと
（scope は send 時スナップショットなので yaml を直すだけでは変わらない）。
移植先 `Kewton/commandmate-skills` への port も必要（policy は `port-required`）。

## 5. 触らなかったもの

### `REAL_SHELL_CONCURRENT_FULL_RUNS`（`tests/helpers/real-shell-budget.ts:201`）

Issue 本文の依頼 2 だが、**今回の原因と無関係**なので触っていない。

1. この定数が支配するのは `REAL_SHELL_SUBPROCESS_TIMEOUT_MS` などの**時間予算**で、
   それが効くのは `Test timed out in …` と `status: 141` の 2 形だけ（#1950 の記述）。
   #2089 で観測された 3 件はいずれも assertion diff で、どちらの形でもない。
2. 並列数を変えても pid 再利用の**確率が動くだけ**で、機構は消えない。堆積が単調増加
   する以上、確率はいずれ戻る。
3. この定数は測定済みのサイジング表（`REAL_SHELL_LOAD_SWEEP`）と結び付いており、
   `tests/unit/guards/real-shell-test-budget.test.ts` がサイジング規則を再計算する。
   `scripts/measure-real-shell-budget.mjs` を回さずに動かすと、根拠のない数字になる。

### `$TMPDIR/cm-monitor-hooks-*` の 4102 ディレクトリ

**消していない。** 消すと flake 率が下がり「直った」のか「証拠を消しただけ」なのかが
区別できなくなるため、まず再現を確認した。そのうえで修正が `$TMPDIR` の状態に
依存しないことを、**堆積したまま**の対照実行（44/44 緑）で示した。

なお #2103 のワーカーが同時に走っている間の一括削除は避けた。使用中のディレクトリを
消すと `mh_report_once` が再度出力し、`warns once per worker` 系の assertion を
別の理由で赤にしうるため。修正後は新たな堆積が起きないので、既存分は任意の
静穏時に `find "$TMPDIR" -maxdepth 1 -name 'cm-monitor-hooks-*' -type d -mtime +1 -exec rm -rf {} +`
で消してよい。

---

## 6. #2119 での着地（実測 2026-08-27 / bash 3.2.57 / macOS Darwin 25.6.0）

§4 の案をほぼそのまま入れた。差分は `.claude/skills/orchestrate-monitor/scripts/hooks-git.sh`
（`MONITOR_HOOKS_STATE_DIR` の決定と EXIT trap）・同 `SKILL.md`（挙動の記述）・
`.claude/skills/sync-map.json`（`update` による pin 再生成と note 追記）の 3 ファイル。

### 6-1. 入れたもの

- 置き場の決定を 3 分岐にした。`MONITOR_HOOKS_STATE_DIR` 指定 → その値／`STATE_DIR` あり
  （`monitor.sh` 配下）→ 相乗り／どちらも無い → `mktemp -d "${TMPDIR:-/tmp}/cm-monitor-hooks-XXXXXXXX"`。
  `mktemp` が答えられなかったときだけ旧来の `-$$` へ落ちる（マーカーを諦めて毎ポール警告する方が悪い）。
- 掃除は `MONITOR_HOOKS_STATE_DIR_OWNED=1`（＝自分で `mktemp` した）かつ
  `trap -p EXIT` が空のときだけ EXIT trap を張る。bash の EXIT trap は 1 本しかなく、
  source されたファイルが無条件に張るとオペレータの後始末を黙って潰す。
  `rm -rf` の対象は `*/cm-monitor-hooks-*` にマッチする名前に限定した。
- `monitor.sh` 配下は分岐に入らない（`STATE_DIR` があり、`trap cleanup EXIT` も
  hooks を source する前に張られている）ので、相乗り・once-per-worker・exit 時の同時削除は不変。

### 6-2. 対照実験（PID 衝突を確率でなく決定的に作る）

PID は選べないので、**spawn した shell 自身に自分の `$$` でマーカーを書かせてから** hooks を
source する。`$$` は旧フォールバックが次の行で計算する値そのものなので、これは再利用 PID の
シミュレーションではなく再現である。同一サンドボックス・同一コマンド（`mh_resolve nope-nope`）で:

| hooks-git.sh | `$TMPDIR` | stderr | 実行後の `$TMPDIR` |
|---|---|---|---|
| 修正前（`HEAD`） | 自 PID のマーカーあり | **空（＝欠陥）** | 残る |
| 修正前（`HEAD`） | 空 | ERROR 1 行 | `cm-monitor-hooks-<pid>` が**残る**（litter の生産） |
| 修正後 | 自 PID のマーカーあり | ERROR 1 行 | 他人のディレクトリだけ残る（触らない） |
| 修正後 | 空 | ERROR 1 行 | **何も残らない** |

`tests/unit/skills/orchestrate-monitor/hooks-git-state-dir.test.ts` がこの 4 象限と、
「1 run で 3 回呼んでも 1 行」「与えられた置き場は消さない」「オペレータの EXIT trap を潰さない」
「`STATE_DIR` 相乗り時は `mktemp` しない・trap も張らない」「実 `monitor.sh` の 4 ポールで 1 行、
終了後に `$TMPDIR` が空」を固定する。各テストは自前の `$TMPDIR` を持つので、開発機に実在する
堆積（4129 ディレクトリ / 4214 マーカー）は読みも消しもしない。

### 6-3. 既存の堆積について

**消していない。** 新規の堆積は止まったが、既存分を消すと「直った」のか「証拠を消しただけ」なのかが
区別できなくなる（§5 と同じ理由）。使用中のディレクトリを消すと `mh_report_once` が再度出力して
`warns once per worker` 系を別の理由で赤にしうるという危険も変わらない。静穏時に
`find "$TMPDIR" -maxdepth 1 -name 'cm-monitor-hooks-*' -type d -mtime +1 -exec rm -rf {} +` で消してよい。

### 6-4. counterpart

`hooks-git.sh` / `SKILL.md` とも policy は `port-required`。`Kewton/commandmate-skills` の
`skills/cmate-orchestrate-monitor` への移植は**未了**で、オーケストレーターが別途行う。
逐語コピーではなく上記の挙動（3 分岐・所有時のみ掃除・既存 EXIT trap を尊重）を再表現すること。

