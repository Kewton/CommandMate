# マージの列（`merge-pr.mjs --queue`）と、machine-lock の先着順の札（Issue #4277）

- 状態: 実装済み（`feature/4277-worktree` の実装コミット）。Codex の事前レビュー 2 回（1 回目 P1 2・P2 4、2 回目の残り 3 件と新しい 4 件）を反映済み（§7）。実装で実コードに合わせた点と、全経路の不変条件・全読者の一覧は §8
- 前提の Issue: #1771（machine-lock と `mutex`）、#3884（precheck の `cpu.heavy`）、#4148 / #4162（merge-pr の CI 待ち・exit 4）、#4265（取り込み後の重い段を CI へ）、#4276（orchestrate.md のサイズ）
- 行番号は 2026-11-09 の `feature/4277-worktree`（`6f3ef08f9` ＝ develop の先頭と同じ）のもの。名前で引くこと

本書では、**事実**（コード・記録で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**（この段で確かめていないこと）を分けて書く。

---

## 0. 結論

| 問題 | 決めた向き | 一言の理由 |
|---|---|---|
| A マージの直列化が自作のシェル頼み | `merge-pr.mjs --queue <entry,...>` が entry を順に流し、exit 3 / 4 を上限つきで自動でやり直す。base（`<repo>:develop`）ごとの**マージのロック**を machine-lock の規約で取り、別プロセスの merge-pr とも直列にする。ロックの持ち主は**専用のプロセスグループの先頭**で、グループに 1 つでもプロセス（git・gh・precheck の子）が残る間は死んだと見なさない（§3.2、R2） | 待ち合わせを「プロセスの一覧」ではなく「pid とプロセスグループつきのロック」で作れば、自分の行を拾う罠（`pgrep -f`）が無く、親だけが死んで子の push・merge が残る重なりも防げる |
| B `mkdir` の取り合いに順番が無い | ロックの横に**札の列** `<root>/<name>.queue/` を置く。札は連番のファイルで、`link(2)` の排他で取り、**番号は再利用しない**（最大の番号のファイルを消さない＋取った後の確かめ。§2.2、R3）。**列の先頭の札だけ**がロックの `mkdir` を試す。札の無いまま `mkdir` に落ちる道は作らない | 既存のロック（`<name>.lock` の `mkdir`）は排他の正のまま。札は「誰が試してよいか」だけを決める |
| B' 死んだ保有者の回収 | 回収は**列の先頭の待ち手だけ**が、**ディレクトリを rename で退かしてから**中身を確かめて行う。新しい実装どうしでは、古い掃除が新しい保有者を消せない（§2.4、R1）。**解放は退かさない**: token を読んで自分のものなら消すだけで、1 つの取得の解放は 1 回きり（§2.4 の 3、S1）。札を知らない旧版との混在は「排他は死んだ保有者が無いときだけ保証」と範囲を狭めて書く | token の読み直しと削除が別の操作である限り、読み直しの後に止まった掃除が新しい保有者を消せる。解放まで退かすと、古い handle の 2 回目の解放が生きた保有者を退かせる |
| B'' 生きている札の期限 | 年齢だけの 24 時間は採らない。札は**自分の期限（`deadline`）**を書き、期限を過ぎた待ち手は自分で `mkdir` を試さない。他者が外してよいのは、同じ host の ESRCH・pid の再利用（`ps -o etime=` で起動時刻が札より新しい）・期限＋猶予のどれか（§2.5、R4） | 待ちの予算は `mutexWaitSec` で最大 86400 秒（`verify-config.ts` `MAX_MUTEX_WAIT_SEC`）。年齢では正当な長い待ち手と区別できない |
| C 3 つの実装の規約 | TS（`machine-lock.ts`）・bash（`verify-run.sh` ＋ `.agents` の写し）・同期 JS（`precheck.mjs` の `acquireMachineLockSync`、merge-pr のマージのロックも同じ関数）の 3 つを同じ札と回収の規約に揃え、`verification-config.md` §9.2 の規約表に行を足す。取得・取消し・期限切れ・回収・解放・signal の終了を 1 つの表で固定する（§2.6） | Issue 本文は 2 実装と書くが、実コードは 3 実装（§1.3）。1 つでも取り残すと、その実装が列を飛ばす |
| D entry の解決と run の記録 | entry `<issue>[/<item>][@<pr>]` を、run の記録の `pr` 段（`pr=#N`）→ `gh pr view` の `headRefName` → その branch の worktree の順に**変更の前に**全部解決する。曖昧なら exit 2（§3.1、R5）。重複は解決した PR で判定し、旧 run の同じ Issue の 2 本は `@<pr>` で名指せる（S4）。`queue` の記録は `readRecords().records` に入れず別の `logRecords` で返し、進捗の計算（`headsOf`・`latestByStage`・`summarize` の unit の列挙・`envCleanShared`）からは構造的に見えない（§3.4、R6） | `3883/d1` と `3883/d2` は同じ Issue 番号の別 worktree（2026-10-24 の tasks.tsv:4・:12）。`headsOf` は stage を問わず `head` を持つ全記録を読む |
| E orchestrate.md 6-2・6-3 | bash ブロックに `--queue` の呼び出しを足し、exit code とやり直しの説明は `docs/orchestrate/ci-merge.md` へ移す。**本文は増やさない**（差し引き 0 以下） | orchestrate.md は今 117,774 bytes で上限 118,000 まで 226 bytes（§1.6）。#4276 のマージが前提 |

`R1`〜`R6` は事前レビュー（`workspace/orchestration/runs/2026-11-08/prereview/review-4277.md`）の指摘の番号、`S1`〜`S4` は 2 回目（`review-4277b.md`）の新しい指摘の番号。処置の一覧は §7。

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
<root>/<name>.lock/owner              既存。排他の正（作り方は変えない）
<root>/<name>.lock.gone-<token>       回収・解放の途中で退かしたロック（§2.4。すぐ消える）
<root>/<name>.queue/                  新規。札の列（消さない）
<root>/<name>.queue/000000000042      札。中身は {"pid","host","token","createdAt","deadline","pgid"?}
<root>/<name>.queue/000000000041      使い終わった札。中身は {"done":true,"token",…}（§2.2 の GC まで残る）
<root>/<name>.queue/.t-<token>        札を作る途中の一時ファイル
```

- 札の名前は **12 桁の 0 埋めの 10 進**。辞書順＝数値順なので、bash の `ls` と Node の `readdirSync().sort()` が一致する。`^[0-9]{12}$` 以外の名前は札として読まない。
- `<name>.queue` と `<name>.lock` は名前の規約（`^[A-Za-z0-9_.-]+$`）の下で衝突しない（`.queue` と `.lock` で終わる）。`<name>.lock.gone-*` も同じ。
- 置き場は既存の lock root の下なので、env-clean の対象外のまま（`MACHINE_LOCK_DIR_NAME` :47）。
- `owner`・札に `pgid` を任意の欄として足す（§3.2）。読み手は知らない欄を無視するので、今の `owner` を読む実装は壊れない。

### 2.2 札の取り方と、番号を再利用しない規則（R3）

1. 中身（`done` なし）を書いた一時ファイル `.t-<token>` を作る。
2. 列の**全ファイル**（生きている札も `done` の札も）の最大の番号 m を読み、`link(.t-<token>, <m+1>)` を試す（Node `fs.linkSync`、bash は `-f` を付けない `ln`。宛先が在れば EEXIST）。EEXIST なら 2 をやり直す。回数の上限は置かず、自分の `deadline` まで。EEXIST 以外の失敗（EACCES・ENOSPC など）は、今の `claim` の `mkdir` と同じく例外にする。**札の無いまま `mkdir` に落ちる道は作らない**（レビュー R3 の「100 回の失敗の後の札なし mkdir が既存の待ち手を抜かせる」への処置）。
3. **取った後の確かめ**: 列を読み直し、自分の番号 n より大きい番号のファイルが 1 つでもあれば、自分の札を `done` にして（§2.3 の書き方）2 へ戻る。無ければ札は有効。**順番を決める時点は、この確かめが終わった時**とする。
4. 一時ファイルを消す。

- **使い終わった札を消してよいのは、列の最大の番号より小さいものだけ**（GC）。最大の番号のファイルは `done` でも消さない。GC はロックを取った者が、自分の札を `done` にした直後に行う。
- 遅れて公開する待ち手（レビューの B: 空の列を読んで止まり、後で「1」を link する）は、link に成功しても 3 の確かめで最大の番号のファイル（C や A の札、または GC で残した `done` の札）を見て取り下げる。最大の番号のファイルは消えないので、**確かめは必ず自分より大きい番号を見つける**。
- 保証（見立て。§5.2 の対照で固定）: 待ち手 A の 1〜3 が終わった後に待ち手 B が 2 を始めたなら、B の有効な札の番号は A より大きい。ほぼ同時に来た 2 人は、両方が 3 で取り下げてやり直すことがある（同時に来た者どうしの順は決めない）。
- `link` にしたのは、**札が生まれた瞬間から中身（pid・host・token・deadline）を持つ**ため。`mkdir` → 中身を書く、の 2 段だと、その間に死んだ札は読めないまま残り、列の全員を止める。
- **未確認**: ネットワークの home（NFS）での `link` の排他。§9.2 の「他ホストの pid では判断しない」と同じく、共有 home は順番の保証の外に置く。

### 2.3 札の順にロックを取る規則

ポーリングの 1 回ごとに:

1. 自分の `deadline` を過ぎていたら、`mkdir` を**試さずに**自分の札を `done` にして `acquired:false` で返す（期限後の claim の禁止。R4）。`shouldAbandon` も同じ。
2. 列を読む。自分より小さい生きている札それぞれについて §2.5 の判定を行い、外してよいものを `done` にする。
3. 自分の札が生きている札の先頭なら、既存どおり `claim`（`mkdir <name>.lock`）を試す。**死んだ保有者のロックの回収（§2.4）も先頭だけが行う。**
4. `claim` に成功したら、自分の札を `done` にし、GC をして返す。
5. 先頭でない、または `claim` に失敗したら sleep。`onWait` は今と同じく「最初に待つことが決まった時に 1 回」（先頭でない、を含む）。
6. 自分の札が消えていた・他者に `done` にされていたら、警告を 1 行出して §2.2 から取り直す（列の末尾に付く）。

- 札を `done` にするのは、`{"done":true,"token":<元の token>}` を書いた一時ファイルを札の名前へ `rename` で被せる（原子的に置き換わる）。外す者は、その直前に中身を読み直して token が同じことを確かめる。札の番号に新しく link する者は居ない（ファイルが在るので EEXIST）ので、確かめと置き換えの間に別の待ち手の札へ入れ替わることは無い。
- 返す値の形（`MachineLockResult`）・オプション（`timeoutMs` / `shouldAbandon` / `onWait` / `pollIntervalMs` / `root`）は変えない。`deadline` は `startedAt + timeoutMs`。
- **飢えが無いこと（見立て）**: 有効な札の番号は §2.2 の保証で取った順に並び、先頭だけが取りに行くので、後から来た待ち手は先に来た待ち手を抜けない。待ち時間の上限は「自分より前の札の保有時間の和」。

### 2.4 死んだ保有者のロックの回収と、解放（R1）

今の回収は「token を読み直す」と「`rm -rf`」が別の操作で、読み直しの後に止まった掃除が、その間に新しく取った保有者のロックを消せる（レビュー R1。`machine-lock.ts` `breakStale` :212、`verify-run.sh` :678-679、`precheck.mjs` :564）。次の 3 つで閉じる。

1. **回収するのは列の先頭の札の持ち主だけ**（§2.3 の 3）。先頭は同時に 1 人なので、新しい実装どうしでは回収する者が 2 人にならない。回収と `mkdir` を同じプロセスが順に行うので、「読み直した後に別の回収者が消して、別の待ち手が取る」の並びが新しい実装どうしでは起こらない。
2. **消す前に退かす**: `rename(<name>.lock, <name>.lock.gone-<自分の token>)`（原子的）→ 退かしたディレクトリの `owner` を読み、token が死んだと判定した token と同じなら `rm -rf`。違えば（＝旧版の掃除が間に入って新しい保有者が居た）`rename` で元へ戻す。戻せなければ（もう新しいロックが在る）、退かしたものを消さずに残し、`machine-lock-restore-failed` を警告に出す（排他が崩れた可能性を人に知らせる）。
3. **生きている保有者のロックは誰も外さない**: ロックの回収の条件は「同じ host で pid が ESRCH、かつ `pgid` があればそのグループが空（§3.2）」だけ。§2.5 の期限・pid の再利用の規則は**札にだけ**当て、ロックには当てない。よって保有者は自分のロックが回収されることが無く、解放（token を確かめて消す）は今の形で安全。
   - **解放は退かさない（S1）**: 前の版はここで「対称にするため、解放も退かしてから確かめる」としたが、それは誤り。A の解放の後に B が取り、A の handle の 2 回目の解放が B のディレクトリを退かすと、退かした直後の空きに先頭の C が `mkdir` して B と C が同時に持つ（token が違うと分かって戻そうとしても手遅れ）。解放は **token を読んで自分のものなら消すだけ**（今の `release` と同じ）にし、handle に「解放済み」の印を持たせて 2 回目以降は何もしない。生きている保有者のロックは誰にも動かされないので、読みと削除の間に別の保有者へ入れ替わることは無い（入れ替わるのは自分が死んだと判定された時だけで、そのとき自分は解放を呼べない）。

- **旧版との混在（保証の範囲を狭める）**: 札と回収の規則を知らない実装（再ビルド前の本番サーバーの gate-runner、`commandmate-skills` の verify-run.sh）が同じ root で動く間は、**排他の保証は「死んだ保有者のロックが無いとき」に限る**。死んだ保有者が居て、旧版の掃除が同時に走ると、R1 の並びが残る（旧版の側の `rm -rf` は直せない）。移行の手順として、このリポジトリの 3 実装は同じ PR で変え、本番の再ビルドと skills 側の PR を続けて行う（ci-merge.md に書く）。
- **前提（見立て）**: 「1 つのプロセスが 2 つの syscall の間で、札の期限の猶予（§2.5。同じ host で 60 秒）より長く止められない」。先頭の待ち手が回収の途中で止められて期限を過ぎ、別の待ち手が先頭になると、2 の「退かして戻す」間の短い窓に第三者の `mkdir` が入りうる。この前提はリースの方式に共通のもので、本書はこれ以上を保証しない。

### 2.5 札を外してよい条件（R4）

| 札 | 外してよい | 外さない |
|---|---|---|
| 同じ host・`pid` が ESRCH（`pgid` があればグループも空） | ○ | — |
| 同じ host・`pid` が生きているが**再利用**されている: `ps -o etime= -p <pid>` から求めた起動時刻が札の `createdAt` より 2 秒以上新しい | ○ | `ps` が失敗・読めない（生きている扱い） |
| 自分の `deadline` を過ぎた札 | 同じ host: `deadline` ＋ 60 秒、他 host: `deadline` ＋ 600 秒（時計のずれの分）を過ぎたら ○ | それより前 |
| 他 host の札で `deadline` 前 | — | ○（pid では判断しない。今の規約と同じ） |
| 読めない・壊れた札 | — | ○（待つ側に倒す。後ろの待ち手は自分の期限で `acquired:false` になり、`heldBy` に札のパスを出す） |

- 年齢だけの「24 時間」は採らない。待ちの予算は `mutexWaitSec` で最大 86400 秒（`verify-config.ts` `MAX_MUTEX_WAIT_SEC`）なので、年齢では正当な長い待ち手と区別できない。札が自分の期限を書き、期限を過ぎた待ち手は §2.3 の 1 で自分から `mkdir` を試さない、という対で決める。`--merge-lock-timeout`（§3.2）の上限も 86400 秒にする。
- `etime` を使うのは、`ps -o etime=`（`[[dd-]hh:]mm:ss`）が macOS と Linux の両方にあり、bash 3.2 の awk で読めるため（`lstart` は日付の書式が `date` の実装で分かれる）。

### 2.6 3 つの実装の規約（§9.2 に足す表）

経路: gate-runner → TS（`machine-lock.ts`）、`verify-run.sh` → bash（`.claude` と `.agents` の両方）、precheck → 同期 JS（`acquireMachineLockSync`）、merge-pr の 1 本と `--queue` → 同期 JS（同じ関数。名前は `merge.<owner>.<repo>.<base>`）。

| 操作 | 規約（3 実装で同じ） |
|---|---|
| 札を取る | §2.2 の 1〜4。EEXIST は期限までやり直す。札なしの `mkdir` は無い |
| ロックを取る | 先頭の札の持ち主だけが `mkdir <name>.lock`。取れたら `owner`（`pgid` を含みうる）を書き、自分の札を `done`、GC |
| 取消し（`shouldAbandon`・bash の INT/TERM） | 自分の札を（token を確かめて）`done` にしてから返る。ロックを持っていれば解放 |
| 期限切れ | `mkdir` を試さず、自分の札を `done` にして `acquired:false`（bash は SKIP / exit 22、製品は exit 99。§9.4 のまま） |
| 札の回収 | §2.5。token を読み直してから `rename` で `done` を被せる |
| ロックの回収 | 先頭だけ。同じ host・ESRCH・グループが空。§2.4 の「退かしてから確かめる」 |
| 解放 | §2.4 の 2 の形。token が自分のものでなければ戻して何もしない |
| signal の終了 | TS: 製品サーバーの終了で残った札・ロックは死んだ保有者として次が回収。bash: 既存の EXIT trap（`cleanup_workdir` :128 の経路）に札の `done` と解放を足す。`kill -9` は回収に任せる。同期 JS: merge-pr の外側のプロセスが INT/TERM/HUP をグループへ送る（§3.2） |
| 札を知らない実装 | 札を見ずに `mkdir` してよい（旧版）。排他は死んだ保有者が無いときだけ保証、順番は保証しない（§2.4） |

- **見立て**: TS と同期 JS の重複は、札の列の純粋な部分（番号の計算・先頭の判定・外してよいかの判定・`etime` の読み）を `src/lib/verification/machine-lock-queue.ts` に置けば TS 側は共有できるが、`scripts/orchestrate/*.mjs` は `src/` の TS を import しない作り（`precheck.mjs` が写している理由）なので、同期 JS は写しのまま。3 実装が同じ列を見て互いに順番を守ることを §5.2 の「実装をまたぐ」対照で固定する。
- **scope の外の写し**: `commandmate-skills` リポジトリの `cmate-verify` にも同じ verify-run.sh がある。本 Issue の実装の後に skills 側へ同じ変更を出す（別 PR）。
- **本番サーバー**: 再ビルドまでは旧版の gate-runner で動く。順番が効き、§2.4 の旧版の窓が閉じるのは再ビルドの後（再ビルドは利用者に伺う）。

### 2.7 既存の mutex のテストとの互換

| テスト | 互換の理由 |
|---|---|
| `tests/unit/verification/machine-lock.test.ts`（:63〜の 11 本） | ロックのパス・`owner`・解放・死んだ保有者・他ホスト・token の確認は変えない。「死んだ保有者のロックを外す」（:148）は札の無いロックを手で作るので、先頭の待ち手が §2.4 の形で外す。「外して取り直された下のロックを消さない」（:190）は §2.4 の 3 でも成り立つ |
| `gate-mutex.test.ts`（:258 直列・:282 別名は並列・:308 待ちの記録） | 別名は別の列。待ち時間の記録の形は不変 |
| `gate-mutex-wait-4162.test.ts`・`gate-slot-mutex-3884.test.ts` | `timeoutMs` の決め方と `onWait` の回数（1 回）は不変 |
| `tests/unit/guards/verify-heavy-gate-mutex.test.ts` | verify.yaml のどのゲートに付くか、だけを見る。不変 |
| `precheck-heavy-3884.test.ts`（:296 `timeoutMs: 0`） | `timeoutMs: 0` でも札を取り、先頭なら `claim` を 1 回試し、駄目なら札を `done` にして返す。「2 人目が予算を待ち切る」は不変 |
| skill の `run-tests.sh`（:763〜:867） | `<root>/<name>.lock` と `owner` の形・解放後に無いこと、は不変。解放後も `<name>.queue/` に最大の番号の `done` の札が 1 つ残るので、「root の下に何も残らない」形の assert があれば影響する（**未確認**: 実装時に run-tests.sh を名前で確かめる） |
| `tests/setup.ts:287` | `CM_VERIFY_LOCK_ROOT` を一時領域へ分けているので、テストの中の merge-pr・precheck が本番のマージのロックや `cpu.heavy` を待つことは無い（レビューでも確認済み） |

---

## 3. `merge-pr.mjs --queue`

### 3.1 引数と entry の解決（R5）

```bash
node scripts/orchestrate/merge-pr.mjs --run-dir "workspace/orchestration/runs/$DATE" --issues "$RUN_ISSUES" \
  --queue "$MERGE_ISSUES"   # 例 4245,4257,4243 / 3883/d1,3883/d2 / 3883@3889。最後の 1 本だけ --last。全部に付けるなら --last
```

- `--queue <entry,...>`: entry は `<issue>[/<item>][@<pr>]`。`--issue` / `--worktree` / `--pr` / `--branch` / `--item` とは同時に使えない（exit 2）。
  - **重複の判定（S4）**: 同じ `(issue, item, pr)` が 2 回、または `@<pr>` の無い entry と同じ `(issue, item)` の別の entry があれば exit 2。`@<pr>` で別々の PR を名指した同じ `(issue, item)` は**別の entry**（旧 run の `3883@3889,3883@3895`）。解決の後に、同じ PR 番号を 2 つの entry が指したら exit 2。
  - **Issue を閉じる entry**: その Issue の**最後の entry だけ**（item なしで `--close -` でないとき）。それより前の同じ Issue の entry は閉じない。
- entry ごとに `(issue, item)` → PR → branch → worktree の対応を、**列を始める前に、どの entry にも何も変えないうちに**全部決める:
  1. PR: `@<pr>` があればそれ。無ければ run の記録の `pr` 段のうち、その unit（`item` が一致。item なしの entry は `item` を持たない記録だけ、`inItem(record, null)`）の記録の `note` の `pr=#N`。**異なる N が 2 つ以上**あれば曖昧（2026-10-24 の #3883 は item なしの `pr` 記録が #3889 と #3895 の 2 本）→ exit 2 で `@<pr>` を求める。記録が無ければ exit 2（`publish-pr.mjs` が先）。
  2. `gh pr view <N> --json state,headRefName,headRefOid,number`。`MERGED` なら worktree を引かない（今の step 1 のとおり記録と close だけ。worktree が片付いた後の再開でも止まらない）。`OPEN` 以外・`MERGED` 以外は exit 2。
  3. worktree: `git worktree list --porcelain` のうち、`branch refs/heads/<headRefName>` の worktree がちょうど 1 つ。0 か 2 以上なら exit 2。branch 名の規則（`feature/<issue>-…`）からは引かない（`commandmate-issue-3883-d1` と `-d2` のように同じ Issue 番号の worktree が並ぶため）。
- 解決の結果（entry・PR・branch・worktree）を `queue` の `waiting` の記録に書く（§3.4）。止まった列を同じ引数で流し直すと、マージ済みの entry は 2 で `MERGED` と分かり、記録だけして次へ進む。
- `--last`: `--queue` と一緒なら**全 entry** に `--last`（「CI が通れば」の run）。付けなければ**最後の entry だけ**に `--last`。
- `--close -`: 全 entry に渡す。無ければ entry ごとの既定（item なしは Issue を閉じる、item つきは閉じない。今の `parseArgs` の規則。同じ Issue の entry が複数あれば最後だけ）。`--close <N>` は `--queue` と一緒には使えない（exit 2）。
- `--ci-timeout` / `--register-timeout` / `--poll` / `--unit-related` / `--base` / `--repo`: 全 entry に同じ値。
- 新規: `--merge-lock-timeout <sec>`（既定 14400、上限 86400）。

### 3.2 前のマージの終わりを待つ（マージのロックと、操作の寿命。R2）

- 列は entry を順に処理する。entry ごとの処理は、今の `main` の本体を `mergeOne(options, deps)` に切り出したもの。列の中で merge-pr を子プロセスとして起動し直すことはしない。
- **プロセスグループ**: `merge-pr.mjs` の入口（外側）は、自分自身を `spawn(process.execPath, [script, ...argv], { detached: true, stdio: 'inherit', env: { ...process.env, CM_MERGE_PR_INNER: '1' } })` で起動して終わりを待つ。**親の環境は丸ごと継ぎ、印を 1 つ足すだけ**（S3。前の版の `env: { CM_MERGE_PR_INNER: '1' }` は PATH・gh の認証・`CM_VERIFY_LOCK_ROOT` を落とす。`pr-common.mjs` の `defaultRun` も親の環境を保つ）。内側は起動直後に印を自分の環境から消し、子へは継がせない。内側は新しいプロセスグループの先頭（`pgid` = 内側の pid）になり、`defaultRun` の `spawnSync`（`pr-common.mjs:58`）で起こす git・gh・precheck の子（vitest・tsc）はすべてこのグループに入る。外側は INT / TERM / HUP をグループ（`-pgid`）へ送り直す。
- **マージのロック**: 内側が `merge.<owner>.<repo>.<base>`（`/` を `.` に、規約外の文字を `_` に。64 文字を超えたら末尾を sha1 の先頭 12 桁に置き換える）を §2 の札つきで取る。`owner` に `pgid` と `phase`・`entry` を書く。
  - 回収の条件は §2.4 の 3 のとおり「pid が ESRCH **かつ** `kill(-pgid, 0)` が ESRCH（グループに 1 つも残っていない）」。親（内側）だけが `kill -9` で死んでも、push 中の `git` や `gh pr merge` が残る間はロックは生きている扱いで、次の列は重ならない。
  - 外側だけが死んだ場合（ターミナルを閉じた等）、内側は動き続けロックも有効。正しい（重ならない）。
  - `--queue` は**列の初めに 1 回**取り、最後の entry の後に放す。中の `mergeOne` は取らない（`deps.holdsMergeLock: true`）。`--queue` なしの merge-pr も同じロックを取るので、手で 1 本流した merge-pr と動いている列は重ならない。
- **書込みの到達が分からないとき**: 内側は外へ書く操作の前後で `owner` の `phase` を書き換える（同じディレクトリの一時ファイルから `rename`）: `refresh` → `precheck` → `push` → `ci-wait` → `merge` → `close` → `idle`。次の列が死んだ保有者のロックを回収したとき、その `phase` が `push` / `merge` / `close` なら:
  - その entry が自分の列にあれば、**それを最初に**処理する（`mergeOne` は再実行で続きから進む作り: `MERGED` なら記録と close、`OPEN` なら `pushHead` が `ls-remote` で届いたかを読み直す）。
  - 自分の列に無ければ、**何も変えずに exit 1** で止まり、`前の列が #<issue> の <phase> の途中で落ちた — その entry を流し直してから` と出す。`queue` に `state=recovered-stop` を記録する。
  - **止まる理由を保持する（S2）**: 回収した者は、死んだ持ち主のロックを消す**前に** `<root>/<ロック名>.unresolved/<死んだ token>.json`（死んだ持ち主の `owner` の中身＋回収の時刻）を書く。止まる理由はロックではなくこのファイルが持つので、回収した B が止まった後に C を流しても、C も同じ理由で止まる（前の版は B が回収して消すと、C を止めるものが残らなかった）。回収者が書いた後・消す前に死んでも、ファイルは残る。マージのロックを取った merge-pr はどれも（1 本の呼び出しも列も）このファイルを読み、**そこに書かれた PR を自分が扱わないなら何も変えずに exit 1**。扱うなら最初に処理し、その entry が 0 で終わったときにだけファイルを消す。人が確かめて解消したときは、ファイルを消せばよい（ci-merge.md に書く）。
  - `phase` が `refresh` / `precheck` / `ci-wait` / `idle`（ローカルか読むだけ）なら、`state=recovered` を記録して続ける。
- **自分の待ち合わせで止まらないこと**: 待ちの判定は「ロックの `owner` の pid とグループが生きているか」だけで、プロセスの一覧・コマンド行は見ない。列の中の entry は同じプロセスの関数呼び出しで、ロックを取り直さない（再入しない）。
- **未確認**: `gh` や git の credential helper が自分で `setsid` してグループを抜けるか。抜ける子があれば、その子だけはグループの判定から漏れる（実装時に `ps -o pgid` で 1 回見る）。
- ロックが `--merge-lock-timeout` 内に取れない: exit 124、`merge lock merge.… held by pid N (pgid M) on host, phase <p>` と出し、`queue` に `state=lock-timeout`。

### 3.3 exit 3 / 4 の自動のやり直し

| `mergeOne` の exit | 列の扱い | 間隔 | 上限（entry ごと） |
|---|---|---|---|
| 0 | 次の entry へ | — | — |
| 3（precheck の保留＝`cpu.heavy` が 5400 秒取れない） | 同じ entry をやり直す | 60 秒 | 2 回（＝最大 3 回の試行）。§2 の札があれば、保留はほぼ起きない見立て。起きたら負荷の異常なので止めて人に返す |
| 4（CI 待ちの間に base が動いた） | 同じ entry をやり直す（取り込み・precheck・push から） | 0 秒（すぐ） | 5 回。超えたら止める |
| 1 / 2 / 124 | **列を止める**。残りの entry は `waiting` のまま記録し、その exit で終わる | — | — |

- 上限と間隔は `merge-one.sh` の「6 回・120 秒」を、exit ごとの性質で分けたもの。
- 列の exit code: 全 entry が 0 なら 0、止まったら止めた entry の exit（3 / 4 の上限超えはその 3 / 4）。
- 1 本が止まったら後ろを流さないのは、6-2 の「1 本マージするたびに残りを refresh」の順序を崩さないため。

### 3.4 列の状態を run の記録に残す（進捗との分離。R6）

`headsOf`（`run-log.mjs:274`）は stage を問わず `head` を持つ全記録を読み、`summarize`（:300）は全記録から unit を列挙し、`latestByStage`（:227）も stage を絞らない。`STAGES` から外すだけでは `queue` の行が進捗に混ざる（レビュー R6）。次の 3 つで分ける。

1. **`queue` の記録は `head` / `workHead` を持たない**: `makeRecord` は `LOG_STAGES = ['queue']` の stage に `head` / `workHead` が渡されたら不合格にする（PR の HEAD は `note` の `pr=#N` と `merge` 段の記録で足りる）。
2. **`readRecords` は進捗の記録と分けて返す**: `{ file, records, logRecords, skipped }`。`records` は今どおり `STAGES` の記録だけ、`logRecords` は `LOG_STAGES` の記録だけ。`headsOf`・`latestByStage`・`summarize`（unit の列挙を含む）・`envCleanShared`・`findLatest` を呼ぶ既存の全経路（merge-pr・publish-pr・precheck・wait-verify・pr-common）は `records` しか受け取らないので、**コードを変えずに** `queue` を見ない。`queue` しか持たない item・Issue は unit に現れない。
3. **`status` の表示を分ける**: `--json` は今のキー（`file`・`summary`・`skipped`・`envCleanShared`）を変えず、トップレベルに `queue`（`[{ issue, item?, state, pos, attempt, exit?, pr, at }]`、unit ごとの最新）を足す。人向けは summary の後に `queue:` の段落を別に出す。

- 1 行の形（entry ごとに状態が変わるたび 1 行）:

```json
{"issue":4257,"stage":"queue","result":"skip","note":"state=running queue=4245,4257,4243 pos=2/3 attempt=1 pr=#4263 pid=12345"}
```

| `state` | `result` | 書く時 |
|---|---|---|
| `waiting` | `skip` | 列の初めに全 entry 分（解決した `pr=`・`branch=`・`worktree=` つき） |
| `lock-wait` / `lock-timeout` | `skip` / `fail` | マージのロック待ちの始まり / 期限切れ（先頭の entry に書く） |
| `recovered` / `recovered-stop` | `skip` / `fail` | 死んだ前の列のロックを回収した時（§3.2。`from=`・`phase=` つき） |
| `running` | `skip` | entry の試行を始める時（`attempt=` つき） |
| `retry` | `skip` | exit 3 / 4 でやり直す時（`exit=3 next-in=60s`） |
| `merged` | `ok` | entry が 0 で終わった時 |
| `stopped` | `fail` | 列を止めた時（`exit=` つき）。後ろの entry は `waiting` のまま |

- 今までの run（`queue` の記録が無い）は今と同じに読める。旧版の `run-log.mjs` で新しい記録を読むと、`queue` の行は `skipped` に数えられる（警告の行が出るだけで、進捗は正しい）。

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
| `src/lib/verification/machine-lock.ts` | §2 の札・§2.4 の回収と解放・`pgid` の欄。`MachineLockResult` / オプションの形は不変 |
| `.claude/skills/cmate-verify/scripts/verify-run.sh` ＋ `.agents/…` | §2 の札と回収（bash 3.2 互換・`ln`・`mv`・`ps -o etime=`・EXIT trap の後始末） |
| `.claude/skills/cmate-verify/scripts/tests/run-tests.sh` ＋ `.agents/…` | bash 側の札・回収の自己テスト |
| `scripts/orchestrate/precheck.mjs` | `acquireMachineLockSync` に §2 の札と回収 |
| `scripts/orchestrate/merge-pr.mjs` | `--queue`・entry の解決・`mergeOne` の切り出し・外側／内側のプロセスグループ・マージのロック・`phase`・やり直し・`queue` の記録 |
| `scripts/orchestrate/run-log.mjs` | `LOG_STAGES`・`makeRecord` の `head` の拒否・`readRecords` の `logRecords`・`status` の `queue` |
| tests（新規） | `tests/unit/verification/machine-lock-fifo-4277.test.ts`、`tests/unit/scripts/orchestrate/merge-pr-queue-4277.test.ts`、`tests/unit/scripts/orchestrate/precheck-lock-fifo-4277.test.ts`、`tests/unit/scripts/orchestrate/run-log-queue-4277.test.ts`（名前は実装時に決めてよい） |
| docs | `verification-config.md` §9.2、`SKILL.md`（＋写し）、`ci-merge.md`、`run-log.md`、`orchestrate.md` 6-2・6-3、本書の状態 |

変えない: verify.yaml のゲート・`mutex` の割り当て、gate-runner の枠（`MAX_CONCURRENT_VERIFICATIONS`）、`HEAVY_LOCK_TIMEOUT_SEC`、merge-pr の 1 本の中の判定（refresh・precheck・CI・exit 4 の検査）。

### 5.2 受入基準の対照

すべて `os.tmpdir()` 配下に `fs.mkdtempSync` で作った lock root / run dir / fake の git・gh で行い、`afterEach` で消す。実リポジトリ・`~/.commandmate` には触れない。「止めて再開」は、実装に差し込み口（各段の直前に呼ぶ `deps.hooks?.<段>()`。TS は `options.__testHooks`、bash は環境変数で名前を指定した fifo を読んで待つ）を置いて作る。

| 受入条件 | 陽性の対照（直す前の実装で落ちる・直した後で守られる） | 陰性の対照（今までどおり・壊さない） |
|---|---|---|
| 先着順（TS） | 保有者 H がロックを持つ間に、待ち手 A（ポーリング 200ms）が先に札を取り、後から B（ポーリング 5ms）が来る。H を放すと **A が先に取る**（直す前は B がほぼ毎回先。A の sleep を差し込み口で「H の解放後 50ms 起きない」にして決定的にする） | 待ち手が 1 人なら今どおり取れる・待ち時間 0 で `onWait` を呼ばない・別名の列は互いに待たない |
| 先着順（実装をまたぐ） | 札を先に取った `verify-run.sh` の待ち手が、後から来た TS（と `acquireMachineLockSync`）の速い待ち手より先に取る。逆向きも 1 本 | 札を見ない旧来の `mkdir` の待ち手と混ざっても、死んだ保有者が無ければ同時に 2 人が持たない |
| R3 番号の再利用 | B が空の列を読んだ直後（link の直前）で止め、C が 1・A が 2 を取り、C が取って放す（1 を `done`・GC）。B を再開すると、B の 1 は §2.2 の 3 で取り下げられ、**A が B より先に取る** | 空の列・単独の待ち手・`timeoutMs: 0` は今どおり（取って放した後に、最大の番号の `done` の札が 1 つ残るだけ） |
| R3 札なしの道が無い | `link` が EEXIST を返し続ける差し込みでも、待ち手は `mkdir` を試さず、期限で `acquired:false` になる（先に居る待ち手を抜かない） | EEXIST 以外の失敗（root を読み取り専用にする）は今の `claim` と同じく例外になる |
| R1 回収の競合 | 死んだ保有者 D のロックに対し、旧版の掃除 X（テストの中の「token を読み直して止まり、再開で `rm -rf`」の手書きの再現）が読み直しで止まる → 新しい実装の待ち手 B が §2.4 で回収して取る → X を再開すると B のロックは消える（**旧版の窓が残ることを固定する対照**）。同じ並びを新しい実装どうしで作ると（先頭でない待ち手は回収しない）、B のロックは残る | 本当に死んだ保有者のロックは回収されて取れる（今の `breaks a lock whose recorded holder is gone` と同じ）。回収の途中で `rename` した中身の token が違えば元へ戻る |
| R2 子が残る親の死 | merge-pr の内側に、`git push` の代わりに 5 秒 sleep する子を spawnSync させ、その間に内側の pid だけを `kill -9`。子が生きている 5 秒の間、次の `--queue` はロックを取らない（グループが空でない）。子が終わると回収して始まる | 子も残らない死（内側を子の無い段で `kill -9`）なら、次の列はすぐ回収して始まる |
| R2 書込みの到達が不明 | `phase=merge` のまま死んだロックを置いて、その entry を含まない `--queue` を流すと、何も変えずに exit 1・`recovered-stop`。その entry を含む `--queue` なら、その entry を最初に流し、fake gh が `MERGED` を返せば記録と close だけして次へ進む | `phase=ci-wait` で死んだロックなら `recovered` を書いて続ける |
| R4 札の期限 | `deadline` が先（`mutexWaitSec` 相当の長い予算）で pid が生きている札は、`createdAt` から何時間たっていても外さない（時計を進める差し込みで 25 時間後を作る） | ESRCH の札は外れて列が進む。pid の再利用（`etime` を差し込みで新しく返す）の札は外れる。他 host の札・読めない札は `deadline`＋猶予まで外さず、後ろの待ち手は自分の期限で `acquired:false`。期限を過ぎた待ち手は `mkdir` を試さない |
| R5 entry の解決 | 同じ Issue の 2 PR を `3883/d1,3883/d2` で流すと、それぞれの `pr` 記録（item つき）から別々の PR・branch・worktree に解決して順にマージする。d1 のマージの後で止めて同じ引数で流し直すと、d1 は `MERGED` で記録だけ、d2 から進む | item なしの `pr` 記録が 2 つの PR を指す（2026-10-24 の形）・worktree が 0 / 2 以上・同じ entry が 2 回、のどれかなら、**どの entry にも何も変えずに**（fake の git・gh に書く呼び出しが 0 回）exit 2 |
| 列（merge-pr） | 3 entry を `--queue` で流すと、fake gh の `pr merge` が 1・2・3 の順に 1 回ずつ呼ばれる。2 本目の 1 回目の試行の precheck が exit 3、3 本目の 1 回目の CI 待ちが exit 4 を返すと、どちらもやり直して 0 で終わる（直す前は `--queue` が exit 2） | exit 1 の entry で列が止まり、後ろの entry の `pr merge` は呼ばれない・`queue` に `stopped` と `waiting` が残る。exit 3 / 4 の上限を超えたら止まる。`--queue` なしの 1 本の呼び出しは今の全テスト（`merge-pr.test.ts` ほか）が通ったまま |
| 自分の待ち合わせで止まらない | 列の中で、マージのロックの取得が**1 回だけ**呼ばれ（差し込み口で数える）、2・3 本目は待ち時間 0 で始まる | 別プロセス（子として起動した node が保持）がマージのロックを持つ間、`--queue` は始めずに待ち、子が終わると始まる |
| R6 進捗との分離 | 既存の記録に、別の `head` を名指そうとする `queue` 行（`makeRecord` が拒むことも確かめる）と、`queue` しか持たない item の行を足しても、`summarize` の全 unit の `head` / `workHead` / `reached` / `next` と unit の数が、足す前と同じ | 本当の `verify` / `precheck` の HEAD の変更は今どおり `next` を動かす。`status --json` の既存のキーは不変で、`queue` がトップレベルに足される |
| 既存の mutex のテスト | — | `machine-lock.test.ts`・`gate-mutex.test.ts`・`gate-mutex-wait-4162.test.ts`・`gate-slot-mutex-3884.test.ts`・`tests/unit/guards/verify-heavy-gate-mutex.test.ts`・`precheck-heavy-3884.test.ts`・skill の `run-tests.sh` が不変のまま通る |
| orchestrate.md | `--queue` の呼び出しが `parseArgs` を通る（新しい `it`） | 既存の `orchestrate-md-calls.test.ts` が通る・`orchestrate-size-3481.test.ts` が通る（118,000 以下） |

---

## 6. 決めていないこと

1. マージのロックの待ちの期限切れの exit code（124 にしたが、CI の 124 と区別したいなら別の番号）。
2. 列の公平さに優先度（マージの precheck を検証より先に）を足すか。本書は足さない（先着順だけで 2026-11-08 の飢えは解ける見立て）。`cpu.heavy.b` / `.c` に振り分けた運用（§1.7 の 4）を元に戻せるかは、実装後の run で測る。
3. §2.4 の前提（1 つのプロセスが 2 つの syscall の間で猶予より長く止められない）の猶予の値（同じ host 60 秒・他 host 600 秒）。
4. `gh`・git の credential helper がプロセスグループを抜けるか（§3.2 の未確認）。抜けるなら、その子の分だけ R2 の保護が漏れる。

---

## 7. 事前レビューの処置

レビュー: `workspace/orchestration/runs/2026-11-08/prereview/review-4277.md`（Codex、P1 2・P2 4）。

| # | 指摘 | 処置 | 理由と、採った守る条件・対照 |
|---|---|---|---|
| R1 | P1 旧ランナーとの混在で、古い掃除が新しい保有者を消せる | 採る（混在の保証は範囲を狭めて明記） | 回収は列の先頭だけ・`rename` で退かしてから token を確かめ、違えば戻す・生きている保有者のロックは誰も外さない（§2.4）。旧版が混ざる間は「死んだ保有者が無いときだけ排他」と書き、窓が残ることも対照で固定（§5.2 R1） |
| R2 | P1 親の pid の死だけでは、子の git・gh を含むマージの終わりを確かめられない | 採る | merge-pr の内側を専用のプロセスグループで動かし、ロックの回収を「pid が ESRCH かつグループが空」にする。`owner` に `phase` を書き、`push`/`merge`/`close` の途中で死んだ列は、その entry を先に流すか、無ければ何も変えずに止める（§3.2、§5.2 R2） |
| R3 | P2 残っている札の最大値では番号が単調にならない。100 回失敗の後の札なしの `mkdir` が抜かせる | 採る | 最大の番号のファイルを消さない＋link の後の確かめで、遅れて公開した番号を取り下げる。札なしの道を削り、EEXIST は期限までやり直す（§2.2、§5.2 R3） |
| R4 | P2 年齢 24 時間だけで生きている札を外す根拠が無い | 採る | 24 時間をやめ、札に `deadline` を書く。期限後の claim を禁止し、外してよいのは ESRCH・`etime` による pid の再利用・`deadline`＋猶予（他 host は 600 秒）だけ。`--merge-lock-timeout` の上限を 86400 に（§2.5、§5.2 R4） |
| R5 | P2 `3883/d1` の worktree を Issue 番号だけで引くと曖昧になる | 採る | `(issue,item)` → run の `pr` 記録 → `gh pr view` の `headRefName` → その branch の worktree、の順に変更の前に全部解決し、item なしの記録が複数の PR を指すときは `@<pr>` を求めて exit 2。`MERGED` は worktree を引かずに再開できる（§3.1、§5.2 R5） |
| R6 | P2 `STAGES` から外すだけでは `headsOf`・unit の列挙・`latestByStage`・status に混ざる | 採る | `queue` は `head` を持てない・`readRecords` が `logRecords` として別に返す・`status --json` はトップレベルの `queue` に足す。既存の進捗の経路は `records` しか見ないので変えずに済む（§3.4、§5.2 R6） |

### 7.1 2 回目の事前レビューの処置

レビュー: `workspace/orchestration/runs/2026-11-08/prereview/review-4277b.md`（Codex。前回 6 件のうち解消 3・一部解消 3、新しい指摘 P1 2・P2 2）。一部解消の 3 件（R1・R2・R5）の残りは、それぞれ S1・S2・S4 と同じものなので、そこで処置する。

| # | 指摘 | 処置 | 理由と、採った守る条件・対照（テスト） |
|---|---|---|---|
| S1（R1 の残り） | P1 token を確かめる前の解放（退かしてから確かめる）が、生きた別の保有者を退かせる | 採る | 解放は退かさず、token を読んで自分のものなら消すだけ。handle は 1 回しか解放しない（§2.4 の 3）。対照: `machine-lock-fifo-4277.test.ts`「S1」— A の解放 → B が取る → A の 2 回目の解放の後も B のロックが残り、`.gone-*` が無く、3 人目は取れない（TS と同期 JS の両方。同期 JS は `setOwnerFields` も 2 回目は書かない） |
| S2（R2 の残り） | P1 到達不明による停止が一度の再実行で失われる | 採る | 回収者がロックを消す前に `.unresolved/<token>.json` を書き、ファイルが止まる理由を持つ。その PR を扱わない merge-pr はどれも exit 1、扱う列は最初に流して 0 で消す（§3.2）。対照: `merge-pr-queue-4277.test.ts`「S2」— B が止まった後 C も止まり、1 本の呼び出しも止まる。その PR を含む列が記録と close を先に済ませて消す。`ci-wait` で死んだ持ち主は `recovered` で続く（陰性） |
| S3 | P2 専用プロセスの起動で親の環境を失う | 採る | `env: { ...process.env, CM_MERGE_PR_INNER: '1' }`（`innerSpawnOptions`）。内側は印を消して子へ継がせない（§3.2）。対照:「S3」— PATH・GH_TOKEN・`CM_VERIFY_LOCK_ROOT` がそのまま渡る、`runOuter` が自分のスクリプトを起動して exit を返す、本物のコマンドの使い方の誤りが内側の exit 2 で返る |
| S4（R5 の残り） | P2 旧 run の複数 PR を明示しても重複扱いで拒否する | 採る | 重複は `(issue, item, pr)` と解決後の PR 番号で判定し、`@<pr>` の付いた同じ unit は別の entry。Issue を閉じるのはその Issue の最後の entry だけ（§3.1）。対照:「S4」— `3883@3889,3883@3895` が順にマージされ、閉じるのは 2 本目の後の 1 回だけ。`3883,3883`・同じ PR の 2 回は exit 2（陰性） |

---

## 8. 実装の記録（#4277 の実装コミット）

### 8.1 不変条件の表（ロックの札とロックを読む・書く全経路）

(a) 札を先に取った待ち手が先にロックを取る、(b) 生きた持ち主の札・ロックを誤って外さない（pid の再利用・別 host を含む）、(c) 死んだ持ち主の札は外れて列が進む、(d) 自分自身を待って止まらない。表駆動のテストは `tests/unit/verification/machine-lock-invariants-4277.test.ts`（`describe.each` で実装ごとに同じ行を回す）。

| 経路 | 実装 | (a) | (b) | (c) | (d) | テスト |
|---|---|---|---|---|---|---|
| 製品ランナーの取得・解放・死んだ札の回収（`gate-runner.ts` → `acquireMachineLock`） | `src/lib/verification/machine-lock.ts` | ○ 別プロセスの遅い待ち手が先 | ○ 25 時間前の生きた札・別 host の札・生きた／別 host のロック・再利用に見えない pid・ps が読めない pid・グループが生きている保有者 | ○ ESRCH・pid の再利用・期限＋60 秒／600 秒・死んだ保有者のロック | ○ 自分の札と自分が放したロックで待たない | invariants（`ts`）、fifo（S1・R3・実装をまたぐ） |
| precheck の重い段（`cpu.heavy`。merge-pr の中の precheck も同じ） | `precheck.mjs` `acquireMachineLockSync` → `machine-lock-sync.mjs` | ○ | ○（差し込み口なしの行） | ○（実際に終了した pid） | ○ | invariants（`precheck`）、`precheck-heavy-3884.test.ts`（期待は不変） |
| merge-pr のマージのロック（1 本の呼び出しと `--queue` の各段: 解決 → ロック → 未解決の確認 → entry ごとの `phase` → 解放） | `merge-pr.mjs` → `machine-lock-sync.mjs` | ○ | ○ グループが生きている保有者（実プロセスの孫） | ○ 子の無い死・`ci-wait` で死んだ保有者 | ○ ロックの取得は列で 1 回・`pgrep -f` の自己一致（陰性の対照）では待たない | invariants（`sync`・pgrep）、`merge-pr-queue-4277.test.ts`（R2・(d)・S2） |
| `verify-run.sh` の取得・解放（standalone） | bash（`.claude` と `.agents` の写し） | **×（未追従）** | 既存のまま | 既存のまま | 既存のまま | invariants「札を知らない経路」— 札を持つ待ち手と `mkdir` だけの取り手が同時に持たない |

### 8.2 共通規則の全読者

| 共通の規則 | 書く経路 | 読む経路 | 追従 |
|---|---|---|---|
| 札の規約（`<name>.queue/<12 桁>`、中身、`link` で公開、取り下げ、`done`、GC、外してよい条件） | `machine-lock.ts` `takeTicket`／`markDone`／`collectGarbage`、`machine-lock-sync.mjs` の同名の関数 | 同じ 2 つ（`listQueue`・`ticketRetirable`） | 2 実装は追従。`verify-run.sh`（＋ `.agents`）は未追従＝札を読まずに `mkdir` する旧版として扱う（§2.4 の混在の範囲）。`commandmate-skills` の `verify-run.sh` も同じ |
| ロックの取り方（先頭だけ `mkdir`、`owner` の JSON、`pgid`、回収は退かしてから、解放は 1 回で token を確かめる） | `machine-lock.ts` `claim`／`breakStale`／`release`、`machine-lock-sync.mjs` `claim`／`recoverLock`／`release`／`setOwnerFields` | 同じ 2 つ＋`verify-run.sh` の `lock_owner_is_dead`（`owner` の `pid`・`host`・`token` を読む。足した `pgid`・`phase` は無視する）＋merge-pr の `heldByLine`（`phase`・`pgid` を表示） | `verify-run.sh` は `pgid` を見ないので、merge-pr のロックの子が残る保有者を死んだと読むが、`verify-run.sh` は `merge.*` を取らない（`cpu.heavy` 等の `mutex` だけ） |
| マージのロックの `owner` の `phase`・`entry`・`pr` と `.unresolved/` | merge-pr `takeMergeLock`（`onStaleHolder` → `persistUnresolved`）・`mergeOne` の `phase` | merge-pr `runOne`（`beforeWrite`）・`runQueue`（並べ替えと `recovered-stop`）・`readUnresolved` | merge-pr だけ。人が手で消す手順は ci-merge.md |
| 列の状態の記録（`queue` の行） | merge-pr `runQueue` の `record`（`appendRecord`。`makeRecord` が `head` を拒む） | `run-log.mjs` `readRecords`（`logRecords` に分ける）・`queueSummary`・`status`。進捗の読者（`headsOf`・`latestByStage`・`summarize`・`envCleanShared`・`findLatest`、それを呼ぶ merge-pr・publish-pr・precheck・wait-verify・pr-common・consistency-review）は `records` しか受け取らない | 追従（コードを変えずに `queue` を見ない）。`readRecords` の戻り値を丸ごと比べる読者は無い（`git grep` で確認） |

### 8.3 実装で実コードに合わせた点（設計からの差）

- **bash（`verify-run.sh`）は変えていない。** 実装の契約の scope は `.claude/skills/cmate-verify/**` を含むが `.agents/skills/cmate-verify/**` を含まない。`tests/unit/skills/cmate-verify/dual-placement.test.ts` が 2 つの写しのバイト一致を固定しているので、片方だけ変えると必ず赤になる。§2.4 の「札を知らない実装」として扱い（排他は死んだ保有者が無いときだけ保証、順番は保証しない）、移すのは別の Issue（`.agents` と skills 側を含む scope）にする。2026-11-08 の飢えは gate-runner と precheck の取り合いで、2 つとも追従した。
- 札の `link` は 1 回のポーリングで 32 回まで試し、それでも EEXIST なら 1 回待ってから続ける（同期 JS の busy loop と、TS のイベントループの占有を避ける）。待ち手の期限まで続けるのは設計どおり。
- 最後の `mkdir` の試行は、期限ちょうどに起きた回の 1 回まで（期限の後の回は無い）。他者が札を外すのは期限＋60 秒からなので重ならない。
- `parseArgs` は `--queue` の中身を読まない（`main` が `parseQueue` で読む）。orchestrate.md の `--queue "$MERGE_ISSUES"` を書いたまま検査できるようにするため（`--issue "$issue"` と同じ扱い）。
- TS の差し込み口は `AcquireMachineLockOptions.__testHooks`（時計・host・pid とグループの生死・起動時刻・`link`）。merge-pr の差し込み口は `deps.acquireMergeLock`・`deps.mergeOne`・`deps.lockRoot`・`deps.repoDir`。
- `phase` は PR が決まった時に `refresh`、以降 `precheck` → `push` → `ci-wait` → `merge` → `close`、entry の後に `idle`。
- orchestrate.md は 1 本の呼び出しのブロックを残し（`orchestrate-md-calls.test.ts` の期待は不変）、同じブロックに `--queue` の 1 行を足した。exit の長いコメントと共有ファイルの衝突の段落を縮めて、本体は 107,937 → 107,868 bytes（#4276 の余裕のテストの 108,000 以下）。

### 8.4 残り

- `verify-run.sh`（`.claude` と `.agents`）と `commandmate-skills` の写しへの札の移植（別の Issue）。それまで standalone の検証は先着順に入らない。
- 本番サーバーの再ビルド（gate-runner が札を知るのは再ビルドの後。利用者に伺う）。
- §6 の未決（124 と CI の 124 の区別、優先度、猶予の値、credential helper のグループ）は変えていない。
