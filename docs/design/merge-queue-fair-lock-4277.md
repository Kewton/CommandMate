# マージの列（`merge-pr.mjs --queue`）と、machine-lock の先着順の札（Issue #4277）

- 状態: 設計（実装前。Codex の事前レビュー（2-4-4）の後、同じブランチの別の契約で実装する）
- 前提の Issue: #1771（machine-lock と `mutex`）、#3884（precheck の `cpu.heavy`）、#4148 / #4162（merge-pr の CI 待ち・exit 4）、#4265（取り込み後の重い段を CI へ）、#4276（orchestrate.md のサイズ）
- 行番号は 2026-11-09 の `feature/4277-worktree`（`6f3ef08f9` ＝ develop の先頭と同じ）のもの。名前で引くこと

本書では、**事実**（コード・記録で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**（この段で確かめていないこと）を分けて書く。

---

## 0. 結論

| 問題 | 決めた向き | 一言の理由 |
|---|---|---|
| A マージの直列化が自作のシェル頼み | `merge-pr.mjs --queue <issue,...>` が 1 プロセスの中で 1 本ずつ流し、exit 3 / 4 を上限つきで自動でやり直す。base（`<repo>:develop`）ごとの**マージのロック**を machine-lock の規約で取り、別プロセスの merge-pr とも直列にする | 待ち合わせを「プロセスの一覧」ではなく「pid つきのロック」で作れば、自分の行を拾う罠（`pgrep -f`）がそもそも無い |
| B `mkdir` の取り合いに順番が無い | ロックの横に**札の列** `<root>/<name>.queue/` を置く。札は連番のファイルで、`link(2)`（`ln` / `fs.linkSync`）の排他で取る。**列の先頭の札だけ**がロックの `mkdir` を試す | 既存のロック（`<name>.lock` の `mkdir`）は排他の正のまま。札は「誰が試してよいか」だけを決めるので、札を知らない古いランナーと混ざっても排他は崩れない（順番だけが崩れる） |
| C 3 つの実装の規約 | TS（`machine-lock.ts`）・bash（`verify-run.sh` ＋ `.agents` の写し）・同期 JS（`precheck.mjs` の `acquireMachineLockSync`）の 3 つを同じ札の規約に揃え、`verification-config.md` §9.2 の規約表に行を足す | Issue 本文は 2 実装と書くが、実コードは 3 実装（§1.3）。1 つでも取り残すと、その実装が列を飛ばす |
| D orchestrate.md 6-2・6-3 | bash ブロックを `--queue` の 1 呼び出しに置き換え、exit code とやり直しの説明は `docs/orchestrate/ci-merge.md` へ移す。**本文は増やさない**（差し引き 0 以下） | orchestrate.md は今 117,774 bytes で上限 118,000 まで 226 bytes（§1.6）。#4276 のマージが前提 |

---

## 1. 今の作り（事実）

### 1.1 `src/lib/verification/machine-lock.ts`（製品ランナー）

| 項目 | 事実 | 場所 |
|---|---|---|
| パス | `<root>/<name>.lock`。root は `CM_VERIFY_LOCK_ROOT`、無ければ `~/.commandmate/locks` | `machineLockPath` :66、`resolveMachineLockRoot` :74 |
| 取り方 | `mkdirSync(lockPath)`。EEXIST なら取れていない。取れたら `owner` に `{pid,host,token,acquiredAt}` を書く | `claim` :200 |
| 待ち方 | 250ms（`DEFAULT_LOCK_POLL_INTERVAL_MS` :60）ごとに `claim` を試すだけ。**待っている順は記録しない**。空いた瞬間に最初に `mkdir` した者が取る | `acquireMachineLock` :230〜 |
| 死んだ持ち主 | `owner.host === hostname()` かつ `process.kill(pid,0)` が ESRCH のときだけ。読めない `owner` は「生きている」扱い（待つ） | `isStaleOwner` :189、`readOwner` :159 |
| 外し方 | 読み直した `token` が同じときだけ `rmSync`。1 つの token は 1 回しか外さない（`broken` の Set :245） | `breakStale` :212 |
| 解放 | `owner.token` が自分のときだけ消す | `release` in `acquireMachineLock` |
| 取消し・枠 | `shouldAbandon` を claim の前に見る（:252）。最初に claim が失敗した時に 1 回だけ `onWait`（:300。gate-runner が実行枠を返す） | — |
| 呼び出し元 | `gate-runner.ts:910` だけ（`timeoutMs: mutexWaitBudgetSec(gate)*1000`、`shouldAbandon`、`onWait: slot.release`） | — |

### 1.2 `.claude/skills/cmate-verify/scripts/verify-run.sh`（standalone ランナー）

- 規約は TS と同じ: `LOCK_ROOT=${CM_VERIFY_LOCK_ROOT:-$HOME/.commandmate/locks}`（:600-601）、ポーリング 0.25 秒（:603）、`mkdir "$LOCK_PATH"` で取り `owner` に同じ JSON を `printf`（:662-664）。
- 死んだ持ち主: `lock_owner_is_dead`（:636）。host 一致かつ `kill -0` の出力が `No such process`（EPERM は生きている扱い）。
- 外し方: token を読み直して同じなら `rm -rf`、token ごとに 1 回（`la_broken`、:672-683）。
- 解放: `lock_release`（:696）が token を確かめる。呼ぶのは `run_gate_attempt` の後（:847）。
- `.agents/skills/cmate-verify/scripts/verify-run.sh` は**バイト単位で同じ写し**（`cmp` で確認）。skill の自己テストは `.claude/skills/cmate-verify/scripts/tests/run-tests.sh`（:664〜:867 に mutex の assert）。規約の説明は `.claude/skills/cmate-verify/SKILL.md:281`。

### 1.3 3 つ目の実装: `scripts/orchestrate/precheck.mjs` の `acquireMachineLockSync`（:536）

- **Issue 本文に無い事実。** precheck は `spawnSync` で段を回す同期コードなので、machine-lock.ts を呼べず、同じ規約を同期で写している（`readLockOwner` :507、`isStaleOwner` :517、ポーリング `LOCK_POLL_MS` = 250 :135、`Atomics.wait` で sleep :503）。
- 重い段（`related` / `tests` が広いとき）に `cpu.heavy`（`HEAVY_MUTEX` :115）を `HEAVY_LOCK_TIMEOUT_SEC` = **5400 秒**（:134）まで待ち、取れなければ `EXIT_HELD` = 3（:85）。merge-pr はこれをそのまま exit 3 として返す（`merge-pr.mjs:467-470`）。
- 2026-11-08 の飢えは、この 5400 秒の待ちの間に、後から来たワーカーの `unit` ゲート（gate-runner 経由）が空いた瞬間に何度も `mkdir` を先に通したもの（plan-4220-bugs.md「運用の変更」1・3 の記述、§1.7）。
- 既存の対照: `tests/unit/scripts/orchestrate/precheck-heavy-3884.test.ts` の `describe('acquireMachineLockSync: the same lock as machine-lock.ts')`（:295〜。「server runner と互いに待つ」:325、「死んだ持ち主を外す」:338）。

### 1.4 `docs/design/verification-config.md` §9 の規約

§9.2 の表（パス・`mkdir`・`owner` の JSON・待ち・解放・死んだ保有者・名前）が「両ランナーが従う規約」。§9.2.1 の表が「ロックを取る 3 箇所」（gate-runner・verify-run.sh・precheck.mjs）を既に列挙している（つまり §9 は 3 実装を知っているが、§9.2 の表の題は「両ランナー」のまま）。§9.4 は「待ち切れたら SKIP（verify-run.sh は exit 22、製品は exit 99＝裁定不能）」。

### 1.5 `scripts/orchestrate/merge-pr.mjs` と `run-log.mjs`

- `main(argv, deps)` は**同期**で exit code を返す（:285）。sleep は `pr-common.mjs` の `defaultSleep`（`Atomics.wait`、:69）。依存の差し替え口は `run` / `sleep` / `now` / `acquireHeavyLock` / `home` ほか（:270-283 の JSDoc）。
- exit: 0 マージ済み（既にマージ済みも 0、:344-351）/ 1 / 2 / 3 precheck の保留 / 4 CI 待ちの間に base が動いた（`BASE_MOVED_EXIT` :101）/ 124（:62）。**exit 3 と 4 は「同じ引数で再実行すれば続きから進む」**と ci-merge.md「6-2 CI 待ちの間に develop が動いたとき」と orchestrate.md 6-2 が言っている。
- 記録は `record(stage, …)` → `appendRecord`（:310-314）。
- `run-log.mjs` の `STAGES`（:57）は 9 段の固定列で、`readRecords`（:180）は **`STAGES` に無い stage の行を `skipped` に落とす**。`summarize`（:300）は `STAGES` を順にたどって最初の未達の段を `next` にする。→ 新しい stage をそのまま `STAGES` に足すと、全 Issue の `next` がその段で止まる（§3.4 で避ける）。
- `orchestrate-md-calls.test.ts:153-178` が 6-2 の bash ブロックの merge-pr 呼び出しを `parseArgs` に通し、`issue: '$issue'`・`worktree: '$WT_DIR'`・`close: '$issue'` と `--last`・`--close -` を含むことを固定している。

### 1.6 orchestrate.md のサイズ

- `.claude/commands/orchestrate.md` は **117,774 bytes**（上限 118,000、`orchestrate-size-3481.test.ts` と CI の size check）。origin/develop も同じ値。
- 契約の「#4276 の後で約 108,000 bytes」は**まだ成り立っていない**: #4276 の PR #4281 は OPEN（2026-11-09 時点）。実装の契約は #4281 のマージ後に送ること（§4 の前提）。

### 1.7 2026-11-08 の失敗の記録（読むだけ）

- `workspace/orchestration/runs/2026-11-08/merge-one.sh`: run ディレクトリの `.merge-lock` を `mkdir` で 30 秒ごとに取り合い、`trap 'rmdir $L' EXIT` で外す。**pid の記録が無い**ので、`kill -9` やシェルの異常終了で残ると誰も外せない。中では merge-pr を最大 6 回、exit 3 / 4 のときだけ 120 秒おいて回し、出力に `merged` があれば 0。
- `plan-4220-bugs.md`「運用の変更」: 1（マージ待ちの間は新規を送らない）・3（「cpu.heavy が 60 秒空くのを待つ」を 13:58 に外した＝飢えるため。precheck を直接取り合いに入れ exit 3 は再試行）・4（検証の mutex をワーカーごとに `cpu.heavy.b` / `.c` に振り、`cpu.heavy` を merge-pr の precheck 専用にした）。原因の欄: 「#4262 の 109 分のうち 67 分が cpu.heavy の取り合い」。
- **未確認**: Issue 本文の「待ち合わせが `pgrep -f` で自分のコマンド行を拾った」シェルは、run ディレクトリに残っていない（`grep -rn pgrep` で 0 件）。本書はこの事象を Issue 本文の記述として扱う。

---

## 2. 先着順の札（machine-lock）

### 2.1 置き場と札の形

```
<root>/<name>.lock/owner          既存。排他の正（変えない）
<root>/<name>.queue/              新規。札の列
<root>/<name>.queue/000000000042  札。中身は owner と同じ JSON {"pid","host","token","createdAt"}
<root>/<name>.queue/.t-<token>    札を作る途中の一時ファイル
```

- 札の名前は **12 桁の 0 埋めの 10 進**。辞書順＝数値順なので、bash の `ls` の並びと Node の `readdirSync().sort()` が一致する。`^[0-9]{12}$` 以外の名前は札として読まない（一時ファイルと、将来の拡張のため）。
- `<name>.queue` と `<name>.lock` は、名前の規約（`^[A-Za-z0-9_.-]+$`）の下で衝突しない（片方は `.queue`、片方は `.lock` で終わる。ある名前 N の `N.queue` が別の名前 M の `M.lock` と一致するには `.queue` = `.lock` が要る）。
- 置き場は既存の lock root の下なので、env-clean の対象外のまま（`env-snapshot.ts` は `~/.commandmate` の直下の `locks` を数えない。`MACHINE_LOCK_DIR_NAME` :47）。

### 2.2 取り方の原子性

1. 中身を書いた一時ファイル `.t-<token>` を作る（`writeFileSync` / `printf >`）。
2. 列の中の最大の札番号 m を読み（無ければ 0）、`link(.t-<token>, <m+1>)` を試す。**`link(2)` は宛先が在れば EEXIST で失敗する**（Node `fs.linkSync`、bash は `-f` を付けない `ln`）。失敗したら読み直して m+2…と進む（上限 100 回で諦め、ロック待ちとしては「取れない」にせず、札なしで旧来の取り合いに落ちる。§2.6）。
3. 成功したら一時ファイルを消す。

- `mkdir` ではなく `link` にしたのは、**札が生まれた瞬間から中身（pid・host・token）を持つ**ため。`mkdir` → `owner` を書く、の 2 段だと、その間に死んだ札は永遠に「読めない＝生きている扱い」になり、列が詰まる（既存のロックは同じ窓を持つが、ロックは 1 個で待ち手が自分で `timeoutMs` を持つので詰まり切らない。列は全員を止める）。
- **見立て**: macOS（APFS）・Linux（ext4 / tmpfs）で `link` の排他は POSIX どおり。**未確認**: ネットワークの home（NFS）での `link` の排他。§9.2 の「他ホストの pid では判断しない」と同じく、共有 home は順番の保証の外に置き、排他（`mkdir`）だけを保証する。
- 一時ファイルは `.t-<token>` で、`token` の先頭に pid を入れない（TS は `randomUUID`、bash は既存の `$$-$(date +%s)-$RANDOM$RANDOM`）。消し忘れの掃除は §2.4。

### 2.3 札の順にロックを取る規則

ポーリングの 1 回ごとに:

1. 列を読む。**自分より小さい札**それぞれについて、中身を読み、§2.4 の判定で死んでいれば外す。
2. 自分の札が列の先頭なら、既存どおり `claim`（`mkdir <name>.lock`）を試す。既存の「死んだ保有者のロックを外す」もここ（先頭だけ）で行う。
3. `claim` に成功したら、**自分の札を消してから**返す（次の札が先頭になる。ロックはまだ自分が持っているので、次の先頭は `mkdir` に失敗して待つ）。
4. 先頭でない、または `claim` に失敗したら sleep。`onWait` は今と同じく「最初に待つことが決まった時に 1 回」（先頭でない、を含む）。
5. **自分の札が消えていたら**（手で消された、他ホストの誤判定など）、警告を 1 行出して列の末尾に取り直す。札の無いまま `claim` は試さない。

- 期限切れ（`timeoutMs`）・`shouldAbandon` で抜けるときは、自分の札を（token を確かめて）消してから返す。返す値の形（`MachineLockResult`）は変えない。
- bash は `trap` の既存の後始末に札の削除を足す（`verify-run.sh` の EXIT / INT / TERM の経路。実装時に既存の trap の場所を名前で探す）。`kill -9` で残った札は §2.4 で外れる。
- **飢えが無いこと（見立て）**: 札は単調に増え、先頭だけが取りに行くので、後から来た待ち手は先に来た待ち手を抜けない。待ち時間の上限は「自分より前の札の保有時間の和」。`cpu.heavy` の保有者は `unit`（実測 486〜640 秒）や precheck の重い段なので、merge の precheck の前に 3 本並んでも 5400 秒の内に収まる。

### 2.4 死んだ札の外し方

- 判定は既存の死んだ保有者と**同じ関数**を使う: host が自ホストと一致し、pid が ESRCH（bash は `No such process`）。他ホストの札・読めない札は外さない（＝待つ。安全な向き）。
- 外す前に中身を読み直し、token が同じときだけ消す。1 つの token は 1 回しか試さない（既存の `broken` と同じ）。
- 一時ファイル `.t-*`: 中身の pid が死んでいれば、誰でも消してよい（先頭かどうかに関係なく）。
- **pid の再利用**: 死んだ札の pid が別プロセスに再利用されると、その札は生きて見えて列を止める。既存のロックと同じく「待つ」側に倒れるが、列では後ろの全員が止まる。対策として札の `createdAt` から **24 時間**を超えた札は、pid が生きていても外す（`unit` の `timeoutSec` 600、`integration` 5400、precheck 5400 のどれよりも長く、正当な待ち手が 24 時間待つことは無い）。**見立て**: 24 時間の値は Codex のレビューで詰める。

### 2.5 3 つの実装の規約（§9.2 に足す行）

| 項目 | 規約（追加） |
|---|---|
| 列 | `<root>/<name>.queue/`。札は `^[0-9]{12}$` の名前のファイルで、中身は `{"pid":N,"host":"…","token":"…","createdAt":ms}` |
| 札の取り方 | 中身を書いた一時ファイル `.t-<token>` を `link(2)` で「最大の札番号＋1」へ。EEXIST なら次の番号 |
| 取る順 | 列の先頭の札の持ち主だけが `<name>.lock` の `mkdir` を試す。取れたら自分の札を消す |
| 死んだ札 | ロックの死んだ保有者と同じ判定（同じ host・ESRCH）、または `createdAt` から 24 時間。token を読み直してから消す |
| 抜けるとき | 期限切れ・取消し・異常終了の後始末で、自分の札（token が自分のもの）を消す |
| 札を知らない実装 | 札を見ずに `mkdir` してよい（旧版）。排他は保たれ、順番だけが保証されない |

- 3 実装の写し: `machine-lock.ts`（TS・非同期）、`verify-run.sh`（bash 3.2 互換。`.agents` の写しも同じ変更）、`precheck.mjs` の `acquireMachineLockSync`（同期）。**見立て**: TS と同期 JS の重複は、札の列の純粋な部分（番号の計算・先頭の判定・死んだ札の判定）を `src/lib/verification/machine-lock-queue.ts` に置けば TS 側は共有できるが、`scripts/orchestrate/*.mjs` は `src/` の TS を import しない作り（`precheck.mjs` が写している理由）なので、同期 JS は写しのまま。3 実装が同じ列を見て互いに順番を守ることを、§5 の対照（実装をまたぐ）で固定する。
- **scope の外の写し**: `commandmate-skills` リポジトリの `cmate-verify`（skills #223 の出元）にも同じ verify-run.sh がある。本 Issue の実装の後に、skills 側へ同じ変更を出す（別 PR。ここでは直さない）。それまでは skills 版で回る他リポジトリの検証が、札を見ない旧版として列を飛ばしうる（排他は崩れない）。
- **本番サーバー**: 再ビルドまでは旧版の gate-runner で動くので、マージ後・再ビルド前の run では、本番の `wait --verify` が札を見ずに `mkdir` する。順番が効くのは再ビルドの後（再ビルドは利用者に伺う。運用の注意として ci-merge.md に書く）。

### 2.6 既存の mutex のテストとの互換

| テスト | 互換の理由 |
|---|---|
| `tests/unit/verification/machine-lock.test.ts`（:63〜の 11 本） | ロックのパス・`owner`・解放・死んだ保有者・他ホスト・token の確認は変えない。「死んだ保有者のロックを外す」（:148）は札の無いロックを手で作るので、先頭の待ち手が今どおり外す |
| `gate-mutex.test.ts`（:258 直列・:282 別名は並列・:308 待ちの記録） | 別名は別の列。待ち時間の記録の形は不変 |
| `gate-mutex-wait-4162.test.ts`・`gate-slot-mutex-3884.test.ts` | `timeoutMs` の決め方と `onWait` の回数（1 回）は不変 |
| `tests/unit/guards/verify-heavy-gate-mutex.test.ts` | verify.yaml のどのゲートに付くか、だけを見る。不変 |
| `precheck-heavy-3884.test.ts`（:296 `timeoutMs: 0`） | `timeoutMs: 0` でも札を取り、先頭なら `claim` を 1 回試し、駄目なら札を消して返す。「2 人目が予算を待ち切る」は不変 |
| skill の `run-tests.sh`（:763〜:867） | `<root>/<name>.lock` と `owner` の形・解放後に無いこと、は不変。**解放後に `<name>.queue/` が空のディレクトリで残る**ので、「root の下に何も残らない」形の assert があれば影響する（**未確認**: 実装時に run-tests.sh を名前で確かめる） |

- 札が使えないとき（列のディレクトリが作れない、100 回 EEXIST）は、**旧来の取り合いに落ちる**（排他は保つ）。札は公平さのための仕組みで、検証を止める理由にしない。

---

## 3. `merge-pr.mjs --queue`

### 3.1 引数

```bash
node scripts/orchestrate/merge-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --queue "$MERGE_ISSUES"   # 例 4245,4257,4243 / 1 本の PR を名指すなら 3883/d1。最後の 1 本だけ --last。全部に付けるなら --last
```

- `--queue <entry,...>`: entry は `<issue>` か `<issue>/<item>`。`--issue` / `--worktree` / `--pr` / `--branch` / `--item` とは同時に使えない（exit 2）。
- worktree は entry ごとに `git worktree list --porcelain` から引く: branch が `^(feature|fix|hotfix)/<issue>-` に一致する worktree がちょうど 1 つ。0 か 2 以上なら、**列を始める前に** exit 2（どの entry が引けないかを並べる）。**見立て**: `commandmatedev ls --json` を使う案（orchestrate.md の `WT_DIR=` の取り方）はサーバーへの問い合わせになり、merge-pr の今の依存（git と gh だけ）を増やすので採らない。
- `--last`: `--queue` と一緒なら**全 entry** に `--last`（「CI が通れば」の run）。付けなければ**最後の entry だけ**に `--last`（orchestrate.md 6-2「最後の 1 本だけはフル CI を待つ」）。
- `--close -`: 全 entry に渡す。無ければ entry ごとの既定（item なしは Issue を閉じる、item つきは閉じない。今の `parseArgs` の規則）。
- `--ci-timeout` / `--register-timeout` / `--poll` / `--unit-related` / `--base` / `--repo`: 全 entry に同じ値を渡す。
- 新規: `--retry-limit <n>`（既定は §3.3）、`--merge-lock-timeout <sec>`（既定 14400）。

### 3.2 前のマージの終わりを待つ（マージのロック）

- 列は 1 プロセスの中で entry を順に処理する。entry ごとの処理は、今の `main` の本体を `mergeOne(options, deps)` に切り出したもの（今の `main` は parseArgs → validate → `mergeOne`）。**子プロセスとして merge-pr を起動しない。**
- 別プロセスとの直列化: base ごとのマージのロック `merge.<owner>.<repo>.<base>`（`/` を `.` に、規約外の文字を `_` に。64 文字を超えたら末尾を sha1 の先頭 12 桁に置き換える）を、§2 の札つきで取る。root は既存の lock root（`machineLockRoot(home)`）。実装は `acquireMachineLockSync`（同期。merge-pr は同期）。
  - `--queue` は**列の初めに 1 回**取り、最後の entry の後に放す。中の `mergeOne` は取らない（`deps.holdsMergeLock: true`）。
  - `--queue` なしの merge-pr も、`mergeOne` の前に同じロックを取る。手で 1 本流した merge-pr と動いている列が重ならない。
- **自分の待ち合わせで止まらないこと**: 待ちの判定は「ロックの `owner` の pid が生きているか」だけで、プロセスの一覧・コマンド行は一切見ない。列の中の entry は同じプロセスの関数呼び出しで、ロックを取り直さない（再入しない）。→ 2026-11-08 の「待つ側が自分の行を拾う」は、構造的に起こらない。
- 既にマージ済みの entry（`pr.state === 'MERGED'`）は今どおり 0 を返すので、止まった列を同じ引数で流し直せば、済んだ entry は記録だけして次へ進む（再開の作り）。
- ロックが `--merge-lock-timeout` 内に取れない: exit 124、`merge lock merge.… held by pid N on host` と出し、`queue` の記録に `state=lock-timeout`。

### 3.3 exit 3 / 4 の自動のやり直し

| `mergeOne` の exit | 列の扱い | 間隔 | 上限（entry ごと） |
|---|---|---|---|
| 0 | 次の entry へ | — | — |
| 3（precheck の保留＝`cpu.heavy` が 5400 秒取れない） | 同じ entry をやり直す | 60 秒 | 2 回（＝最大 3 回の試行）。§2 の札があれば、保留はほぼ起きない見立て。起きたら負荷の異常なので止めて人に返す |
| 4（CI 待ちの間に base が動いた） | 同じ entry をやり直す（取り込み・precheck・push から） | 0 秒（すぐ） | 5 回。base が動くのは別の run のマージなので、回数で打ち切る。超えたら止める |
| 1 / 2 / 124 | **列を止める**。残りの entry は `waiting` のまま記録し、その exit で終わる | — | — |

- 上限と間隔は `merge-one.sh` の「6 回・120 秒」を、exit ごとの性質で分けたもの。exit 4 は待っても状況が良くならない（すぐ取り込み直すのが最短）、exit 3 は負荷が引くのを待つ意味がある。
- 列の exit code: 全 entry が 0 なら 0、止まったら止めた entry の exit（3 / 4 の上限超えはその 3 / 4）。
- 1 本が止まったら後ろを流さないのは、6-2 の「1 本マージするたびに残りを refresh」の順序（先行のマージを前提に後続を確かめる）を崩さないため。**見立て**: 後ろの entry が独立なら流してよい場面もあるが、独立の判定を merge-pr に持たせない。

### 3.4 列の状態を run の記録に残す

- 新しい stage `queue` を **`run-log.mjs` の受理する stage**（`makeRecord`・`readRecords`）に足し、**`summarize` のたどる列（今の `STAGES`）には入れない**。具体的には `STAGES`（進捗の段）とは別に `LOG_STAGES = ['queue']` を置き、`readRecords` は `[...STAGES, ...LOG_STAGES]` を受理する。`HEAD_BOUND_STAGES` にも入れない（`head` は任意）。
- 1 行の形（entry ごとに状態が変わるたび 1 行）:

```json
{"issue":4257,"stage":"queue","result":"skip","note":"state=running queue=4245,4257,4243 pos=2/3 attempt=1 pid=12345"}
```

| `state` | `result` | 書く時 |
|---|---|---|
| `waiting` | `skip` | 列の初めに全 entry 分 |
| `lock-wait` / `lock-timeout` | `skip` / `fail` | マージのロック待ちの始まり / 期限切れ（先頭の entry に書く） |
| `running` | `skip` | entry の試行を始める時（`attempt=` つき） |
| `retry` | `skip` | exit 3 / 4 でやり直す時（`exit=3 next-in=60s`） |
| `merged` | `ok` | entry が 0 で終わった時 |
| `stopped` | `fail` | 列を止めた時（`exit=` つき）。後ろの entry は `waiting` のまま |

- `run-log.mjs status` との整合: `summarize` は `queue` を見ないので、各 Issue の `reached` / `next` は今と同じ。`status` の人向けの出力に、Issue ごとの最新の `queue` の行を `queue: running 2/3 attempt=1` のように**付け足すだけ**、`status --json` は各 unit に `queue`（最新の記録、無ければ省く）を足す。既存のキーは変えない。
- `queue` の記録を持たない run（今までの全 run）は、今と同じに読める。旧版の `run-log.mjs` で新しい記録を読むと、`queue` の行は `skipped` に数えられる（警告の行が出るだけで、進捗は正しい）。

---

## 4. `/orchestrate` 6-2・6-3 の書き換えの方針

- **前提**: #4276（PR #4281）のマージで orchestrate.md が 108,000 bytes 前後になっていること。実装の契約の最初に `wc -c .claude/commands/orchestrate.md` を確かめる。
- 6-2 の bash ブロック（今の merge-pr 1 本の呼び出しと exit の長いコメント）を、§3.1 の `--queue` の 1 呼び出しと 1 行の exit の要約に置き換える。「1 本マージするたびに、残りの各 PR で merge-pr.mjs を呼ぶ」の段落は「残りの PR を `--queue` で順に流す（refresh・precheck・CI 待ちは entry ごとに今のまま）」に縮める。
- exit 3 / 4 のやり直しの規則・上限・`queue` の記録・マージのロックの説明は `docs/orchestrate/ci-merge.md` に新しい節「6-2 マージの列（--queue）」を作って置き、本文からは `根拠: docs/orchestrate/ci-merge.md#6-2-マージの列--queue` の 1 行で参照する（`orchestrate-doc-links-3481.test.ts` が参照先の存在を見る）。
- 6-3 は「`merge-pr.mjs` がこの判定を行う」のまま。変えるのは「再実行で続きから」の言い回しを「列が自動でやり直す（上限は ci-merge.md）」にするところだけ。
- 自作のシェル（`merge-one.sh` の形）を書かない、を 6-2 に 1 行で置く（「マージの直列化は `--queue` に任せ、待ち合わせのシェルを書かない」）。
- `orchestrate-md-calls.test.ts` の 6-2 の固定（`issue: '$issue'`・`worktree: '$WT_DIR'`・`close: '$issue'`）は、ブロックの呼び出しが `--queue` に変わると成り立たなくなる。**既存の `it` を消したり名前を変えたりしない規則**があるので、実装の契約では次のどちらかを契約の決定として明示する: (a) 6-2 に 1 本用の呼び出し（`--issue "$issue" --worktree "$WT_DIR"`、手で 1 本流すとき）を残し、`--queue` の呼び出しを 2 本目のブロックに足す（テストは 1 本目を読むので不変。バイトは増える）、(b) テストの期待値を `--queue` に合わせて変える（契約の許可が要る）。**推奨は (a)**（テストの意図＝「本文の呼び出しが引数の検査を通る」を保ち、`--queue` の呼び出しには同じ形の `it` を新しく足す）。増えるバイトは exit の長いコメントを ci-merge.md へ移す分で相殺する。
- 対になる説明: `docs/orchestrate/ci-merge.md` の「6-2 CI 待ちの間に develop が動いたとき」「6-3 落ちたジョブの再実行と run の完走」の「再実行すれば」の文、`docs/orchestrate/run-log.md`（stage の一覧）、`.claude/skills/cmate-verify/SKILL.md:281` の規約表（＋ `.agents` の写し）、`verification-config.md` §9.2・§9.2.1。`docs/en`・`docs/ja` に orchestrate・verification・design の対訳は無い（`ls` で確認）。

---

## 5. 実装の範囲と受入基準の対照

### 5.1 実装の範囲（別の契約。scope の見込み）

| 変える | 内容 |
|---|---|
| `src/lib/verification/machine-lock.ts` | §2 の札。`MachineLockResult` / オプションの形は不変 |
| `.claude/skills/cmate-verify/scripts/verify-run.sh` ＋ `.agents/…` | §2 の札（bash 3.2 互換・`ln`・trap の後始末） |
| `.claude/skills/cmate-verify/scripts/tests/run-tests.sh` ＋ `.agents/…` | bash 側の札の自己テスト |
| `scripts/orchestrate/precheck.mjs` | `acquireMachineLockSync` に §2 の札 |
| `scripts/orchestrate/merge-pr.mjs` | `--queue`・`mergeOne` の切り出し・マージのロック・やり直し・`queue` の記録 |
| `scripts/orchestrate/run-log.mjs` | `LOG_STAGES`・`status` の `queue` |
| tests（新規） | `tests/unit/verification/machine-lock-fifo-4277.test.ts`、`tests/unit/scripts/orchestrate/merge-pr-queue-4277.test.ts`、`tests/unit/scripts/orchestrate/precheck-lock-fifo-4277.test.ts`（名前は実装時に決めてよい） |
| docs | `verification-config.md` §9.2、`SKILL.md`（＋写し）、`ci-merge.md`、`run-log.md`、`orchestrate.md` 6-2・6-3、本書の状態 |

変えない: verify.yaml のゲート・`mutex` の割り当て、gate-runner の枠（`MAX_CONCURRENT_VERIFICATIONS`）、`HEAVY_LOCK_TIMEOUT_SEC`、merge-pr の 1 本の中の判定（refresh・precheck・CI・exit 4 の検査）。

### 5.2 受入基準の対照

すべて `os.tmpdir()` 配下に `fs.mkdtempSync` で作った lock root / run dir / fake の git・gh で行い、`afterEach` で消す。実リポジトリ・`~/.commandmate` には触れない。

| 受入条件 | 陽性の対照（直す前の実装で落ちる） | 陰性の対照（今までどおり） |
|---|---|---|
| 先着順（TS） | 保有者 H がロックを持つ間に、待ち手 A（ポーリング 200ms）が先に札を取り、後から B（ポーリング 5ms）が来る。H を放すと **A が先に取る**。今の実装では B が速く回るのでほぼ毎回 B が先（決定的にするため、A の sleep を差し替え口で「H の解放後 50ms 起きない」にする） | 待ち手が 1 人なら今どおり取れる・待ち時間 0 で `onWait` を呼ばない・別名の列は互いに待たない |
| 先着順（実装をまたぐ） | 札を先に取った `verify-run.sh` の待ち手が、後から来た TS（または `acquireMachineLockSync`）の速い待ち手より先に取る。逆向きも 1 本 | 札を見ない旧来の `mkdir` の待ち手と混ざっても、**同時に 2 人が持たない**（排他の対照） |
| 死んだ札 | 死んだ pid（起動して終わらせた子の pid）・同じ host の札が先頭にあると、今は列を作らないので該当しない → 「札の先頭が死んだ pid のとき、後ろの待ち手が `timeoutMs` 内に取れる」を新設（直す前は札の概念が無いので、`<name>.queue` に手で置いた札を無視して取る＝この対照は「直した後で外れること」の確認）。24 時間を超えた生きている pid の札も外れる | 他ホストの札・読めない札は外さず、待ち手は `timeoutMs` で `acquired:false`（今の「他ホストは奪わない」と同じ向き）。期限切れ・取消しで抜けた待ち手の札は残らない |
| 列（merge-pr） | 3 entry を `--queue` で流すと、fake gh の `pr merge` が 1・2・3 の順に 1 回ずつ呼ばれる。2 本目の 1 回目の試行の precheck が exit 3、3 本目の 1 回目の CI 待ちが exit 4 を返すと、どちらもやり直して 0 で終わる（直す前は `--queue` が exit 2） | exit 1 の entry で列が止まり、後ろの entry の `pr merge` は呼ばれない・`queue` に `stopped` と `waiting` が残る。exit 3 / 4 の上限を超えたら止まる。`--queue` なしの 1 本の呼び出しは今の全テスト（`merge-pr.test.ts` ほか）が通ったまま |
| 自分の待ち合わせで止まらない | 列の中で、マージのロックの取得が**1 回だけ**呼ばれ（差し替え口で数える）、2・3 本目は待ち時間 0 で始まる。ロックの `owner` の pid がテストのプロセス自身でも、列の中の entry はそれを待たない（再入しない） | 別プロセス（子として起動した node が保持）がマージのロックを持つ間、`--queue` は始めずに待ち、子が終わると始まる。子を `kill -9` で落とすと、死んだ保有者として外れて始まる |
| run の記録 | `queue` の行が `waiting`→`running`→`retry`→`merged` の順に書かれ、`status --json` の各 unit に最新の `queue` が出る | `queue` の行がある記録でも、`summarize` の `reached` / `next` は行が無い場合と同じ（同じ記録から `queue` 行を抜いたものと比べる） |
| 既存の mutex のテスト | — | `machine-lock.test.ts`・`gate-mutex.test.ts`・`gate-mutex-wait-4162.test.ts`・`gate-slot-mutex-3884.test.ts`・`tests/unit/guards/verify-heavy-gate-mutex.test.ts`・`precheck-heavy-3884.test.ts`・skill の `run-tests.sh` が不変のまま通る |
| orchestrate.md | `--queue` の呼び出しが `parseArgs` を通る（新しい `it`） | 既存の `orchestrate-md-calls.test.ts` が通る・`orchestrate-size-3481.test.ts` が通る（118,000 以下） |

---

## 6. 決めていないこと（Codex のレビューで詰める）

1. 死んだ札の時間の上限（24 時間）の値。短くすると pid の再利用に強いが、正当な長い待ち手を外す危険がある。
2. マージのロックの待ちの期限切れの exit code（124 にしたが、CI の 124 と区別したいなら別の番号）。
3. `--queue` の worktree の引き方（branch 名の規則で引く）で、`--item` の entry の worktree が Issue の worktree と別になる run（#3883 の複数 PR）を扱えるか。**未確認**: 複数 PR の run で worktree をどう分けたか（`--item` の run の記録を読むこと）。
4. 列の公平さに優先度（マージの precheck を検証より先に）を足すか。本書は足さない（先着順だけで 2026-11-08 の飢えは解ける見立て）。`cpu.heavy.b` / `.c` に振り分けた運用（§1.7 の 4）を元に戻せるかは、実装後の run で測る。
