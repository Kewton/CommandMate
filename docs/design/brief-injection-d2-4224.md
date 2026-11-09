# C の brief を送信の口へ繋ぎ、知らせの受領・フックとの二重・終わり方の表示・実機の受入を決める（Issue #4224 の後半 D2）

親：Epic #4220（決定 D1・D3・D8・D10・D12 を前提にする）。前半：#4274（D1、マージ済み・`docs/design/session-boundary-brief-4274.md`）。
依存：A #4221（`docs/design/mem-store-4221.md`）・B #4222（`docs/design/mem-close-when-4222.md`）・C #4223（`docs/design/brief-4223.md`）。すべて develop にマージ済み。

この文書は**設計の段**の成果物で、`src/`・`tests/` はまだ変えていない。実装は、この設計を Codex が事前に
レビューした後の、同じブランチの別の契約で行う。

**書き方の約束**（D1・C と同じ）：

- **［事実］** 実コード・fixture で確かめたこと。`file:line` は develop `64572168c`（#4223 のマージ）時点
- **［見立て］** 事実から組んだ設計判断。レビューで変わりうる
- **［未確認］** 実機で測っていないこと。§8 の実機の受入で確かめる

以下、D1 の設計書を「D1 設計」、C の設計書を「C 設計」と書く。

---

## 0. 冒頭

### 0.1 食い違う点（止める点）

**止める点は無い。** D1〜D13・A・B・C・D1 の設計と違う作りは要らない。D2 は D1 の口（`BriefRequest`）に欄を**足す**が、
これは C 設計 §11 の U13（「口に worktree の世代を足すかは D2 で決める」）が D2 に預けた判断で、口の形を変えるもの
（欄の削除・意味の変更）ではない。足すのは `BriefRequest.target` の 2 つの欄と `BriefResult.skipReason?`（任意）だけで、`build`・`reserve`・`settle` の
形は変えない（§2.4・§5.3・§7.4）。

事前レビュー（§14）の処置でも止める点は無かった。要求の寿命の固定を `plan()` から要求の入口（route・Timer）へ前へ出すこと（P1）と、
`sendUserMessage` の `brief` の引数を判別の型にすること（`briefPin` の必須化）は、D1 の約束（寿命は最初の await の前に固定する）を
要求の全体へ広げる変更で、D1 の作りと逆向きではない。台帳の形・保持の規則・migration は変えない（P2-3 は台帳に頼らない読み方で受けた）。
取り込みの共通の関数（`recordUserTurn`、P2-6）を変えるのは D1〜D13 の決定の外の既存のファイルで、D10（利用者の本文を黙って削らない）
を履歴の側でも守るための追加である。

実コードを正として扱いを決めた所：

| # | 契約・Issue の書き方 | 実コード［事実］ | この設計での扱い |
|---|---|---|---|
| H1 | 「フックでも brief を出す Agent（どれか、file:line）」 | CommandMate が置くフックは**どれも Agent の文脈へ何も出さない**。中継のスクリプトは POST の応答を捨てる（`scripts/hooks/cmate-agent-event.sh:347` の `curl "$@" >/dev/null`）。Command Code の設定もそれを前提に書かれている（`src/lib/hooks/sources/command-code/hooks-config.ts:87`）。Claude の `SessionStart` もこの中継を呼ぶだけ（`src/lib/hooks/hook-settings-generator.ts:443-466`）。`hookSpecificOutput` を返すのは権限の判断だけ（`src/lib/hooks/sources/claude/source.ts:106`・`codex/source.ts:75,83`）。`commandmate brief` を呼ぶフックも src・scripts・`.claude/` に無い | 今の二重は「利用者が自分で置いたフック」と「これから F（#4226）・H（#4228）が置くフック」だけ。§6 で**送信の側を採り**、フックの側は送信の側が届けるときに黙る口を作る |
| H2 | 「予定していない終わり方の後：前の世代で終わる前の更新（G の終了の流れ、F の促し）が記録されていなければ」 | G（#4227）・F（#4226）は未実装で、「終わる前の更新」の記録の置き場はまだ無い（`mem_items` の列：`src/lib/db/migrations/v66-mem-store.ts:95-127`。終わりの記録の表は無い） | 記録の**読み口**だけを D2 で定め、書き手（G・F）が来るまでは「記録が無い」と読む。文言は「確認できない」で、断定しない（§7） |
| H3 | 「C の provider を getBriefProvider() に繋ぐ」 | `getBriefProvider()` が空の provider を返すことを、C と D1 の既存の試験が固定している（`tests/unit/lib/brief/brief-provider.test.ts:77-81` の `toBe(EMPTY_BRIEF_PROVIDER)`、`tests/unit/lib/session/session-brief-entrances-4274.test.ts:402-411` が `setBriefProviderForTest(null)` を「空の provider」の意味で使う） | 接続は既定を変えることなので、この 2 つの試験の期待は**変わらざるを得ない**。変え方を §10 に挙げ、実装の契約で PM が許すかを決める（作りの食い違いではない） |
| H4 | D1 設計 §4.1「Timer は D2 で `auto` に」 | `tests/unit/lib/timer-manager.test.ts:275` 以降が `sendUserMessage` の引数をまるごと固定している | §10 に挙げる（同上） |

### 0.2 範囲

#4274 の本文「## D2（#4224 に残すもの）」の 5 つと、C のレビューからの申し送り 2 つ（PM の必須項目）：

| 契約の項目 | 節 |
|---|---|
| (1) provider の経路で worktree の世代を要求と照合する | §2（独立の節） |
| (2) 呼び出しの連鎖の走査の網羅を広げる | §3（独立の節） |
| (3) C の provider を `getBriefProvider()` に繋ぐ・空の provider の振る舞いを保つ | §4 |
| (4) B の知らせの受領に、含めた ID と配送の結果を渡す | §5 |
| (5) フックでも brief を出す Agent で二重にしない | §6 |
| (6) 予定していない終わり方の後の先頭の表示 | §7 |
| (7) 実機の受入（Claude Code・Codex・Command Code） | §8 |
| (8) 実装の範囲・全入口の不変条件の表駆動の試験 | §9 |

D2 で**変えない**もの：A・B のファイル（`src/lib/mem/**`・`src/lib/db/mem-db.ts`・`src/lib/db/mem-close-db.ts`・`src/lib/db/agent-instances-db.ts`）、
台帳の表の形（v68、migration を足さない）、`submit-verified-sender*.ts`（到達の確認）、relay の配送（`never` のまま）。

---

## 1. いまの経路（事実の整理）

```
POST /api/worktrees/:id/send            route.ts:390  brief: body.brief ?? 'auto'
  └ sendUserMessage                     send-user-message.ts:355  new SendBrief({ mode: params.brief ?? 'never' })
      ├ sendBrief.plan()                send-user-message.ts:510   ← ロックの外、await あり
      │   ├ getCurrentBoundary / readInstanceLifetime            session-brief.ts:256-264（最初の await の前）
      │   ├ withMemTarget（mode・injectOnStart・所属）              session-brief.ts:280-288
      │   ├ provider = getBriefProvider()                        session-brief.ts:290   ← いまは EMPTY_BRIEF_PROVIDER
      │   └ provider.build(request)（2 秒で打ち切り）               session-brief.ts:296-313・136-147
      ├ withInstanceInputLock
      │   ├ sendBrief.claim()  → withMemTarget の同期の区間で照合・reserve・claimBoundary   session-brief.ts:347-435
      │   ├ 打つ（brief + "\n\n" + 本文）
      │   └ sendBrief.settleInLock / abandonInLock                 send-user-message.ts:682・688
      └ sendBrief.afterLock() → provider.settle?(…)              send-user-message.ts:711、session-brief.ts:482-500
```

C の provider（`src/lib/brief/provider.ts`）［事実］：

- `MEM_BRIEF_PROVIDER`（`:222`）は `build`・`reserve` を持ち、`settle` を持たない（`:200-206`）。受領は別の関数 `settleBriefAttempt`（`:225-227`）
- `build`（`:120-151`）は `buildBrief(db, { …, request, maxLines, onMembershipTimeout: 'throw' })` を呼ぶ。**`pinned` を渡さない**
- `buildBrief`（`src/lib/brief/build.ts:225`）は最初の await の前に `fixMemEvalLifetime`（`:239`、worktree の世代を**その場で**固定。無ければ作る：
  `src/lib/mem/evaluate.ts:104-107` → `src/lib/mem/incarnation.ts:145-161`）。`pinned` があれば照合する（`build.ts:240-246`）。
  request の instance の世代は照らす（`:247-252`）が、**request に worktree の世代は無い**（`src/lib/session/brief-provider.ts:24-31`）

---

## 2. 必須項目 (1)：provider の経路で worktree の世代を要求と照合する

### 2.1 事実

| # | 事実 | 場所 |
|---|---|---|
| F1 | D1 の要求（`BriefRequest.target`）は worktree の ID・instance の ID・instance の世代だけを持ち、worktree の世代を持たない | `src/lib/session/brief-provider.ts:24-31` |
| F2 | C の provider は要求の worktree の世代を照らせないので、`build` を始めた時点の世代を固定する。route の `pinned`（要求全体で 1 回だけ固定、`build.ts:111-128`）と同じ固定が provider に無い | `src/lib/brief/provider.ts:122-133`、`build.ts:239` |
| F3 | 台帳の行は worktree の子で、worktree の削除で消える（`REFERENCES worktrees(id) ON DELETE CASCADE`、D1 設計 §3.2）。worktree の世代の行も同じ（`v66-mem-store.ts:82-86`） | — |
| F4 | `claimInStretch` は、既にある行では `getBoundaryById` が null なら何もしない（`session-brief.ts:376-378`）。**行の無い `force`（明示の口）では、取る区間で新しい行を開く**（`:415-426`）。どちらも worktree の世代を照らさない | `session-brief.ts:364-435` |
| F5 | 改名は台帳の行と世代の行を新しい ID へ移す（`worktree-child-tables.ts` の列挙・`incarnation.ts:163-172` の注記） | — |
| F6 | `plan()`（`send-user-message.ts:510`）より前に await がいくつもある：route の所有の確認（`route.ts:224`）・起動（`:299-322`）、`sendUserMessage` の所有の確認（`:396`）・プロンプトの確認・`/model` の待ち。route は worktree を `:170` で読む。D1 の `SendBrief` の constructor（`session-brief.ts:196-206`）が reset の寿命を読むのは `:355` で、route の await の後 | 事前レビュー P1 |

### 2.2 穴の経路

「計画の読み（最初の await の前）」と「build の固定」と「取る区間」の 3 つの時点が、worktree について同じものを見ている保証が無い。

| # | 順 | 起きること［見立て］ |
|---|---|---|
| P1 | `force` の送信が計画を読む → 同じ ID・同じ path で worktree を削除・作り直し → build が始まり**新しい** worktree の世代を固定 → claim が新しい worktree に `explicit` の行を開いて付ける | 古い要求（作り直しの前に人が出した `--with-brief`）の brief が、作り直した後の worktree の会話に入る。C 設計 §11 U13 の言う「送り先も新しい worktree なので漏洩ではない」が、#4221 の purge・C の route（`pinned`）と同じ型の「世代の照合の漏れ」である |
| P2 | 既にある行の送信が計画 → 作り直し → build | 行は CASCADE で消えているので claim は付けない（F4）。ただし build は新しい worktree で評価（B の D8 の close）を走らせ、memo を残す。close は条件の成立の記録として正しい（C 設計 §5.2）が、**要求の外の worktree で評価を起こす** |
| P3 | 計画 → build → 作り直し → claim | 既にある行は CASCADE で消え付かない。`force` は claim で新しい行を開いて付く（P1 の後半と同じ） |
| P4 | 計画の後に改名 | 行と世代は新しい ID へ移る。計画の `worktreeId` は古い ID のまま。claim の `withMemTarget` は古い ID を引けず `target_unresolved` になるはずだが、照らしているのは所属であって世代ではない |

### 2.3 守る条件

| # | 条件 |
|---|---|
| W1 | 1 回の送信の要求は、**1 つの worktree の寿命と 1 つの instance の寿命**についての要求である。寿命は**要求の入口**（送信の route が worktree を読んだ同期の区間、Timer が timer の行を読んだ同期の区間）で 1 回だけ固定し（`BriefRequestPin`）、`sendUserMessage` → `SendBrief`（計画・取る・reset の境界の公開）→ provider の `build` まで同じ値を運ぶ。途中の await（所有の確認・プロンプトの確認・起動の待ち・`/model`）の後で固定し直さない（事前レビュー P1） |
| W2 | provider の `build` は、要求に載った寿命を `pinned` として使い、自分では固定し直さない。違えば例外（D1 は `provider_failed` で付けない。送信は続く） |
| W3 | 取る区間（`withMemTarget` の同期の callback）で、worktree の寿命が固定の値から続いていることを照らす（§2.4 の「続いていることの証拠」）。続いていなければ取らず、行の状態は書かない。報告の理由は `worktree_changed` |
| W4 | `force` で新しい行を開くのは、W3 を通った後だけ |
| W5 | mode が `off`・`injectOnStart=false` の送信は、`force` も含めて、世代を**作らない**（mem の表を書かない。固定は読むだけで行う。事前レビュー P2-1） |
| W6 | reset のコマンドを送った送信が開く境界（`openResetBoundaryFromSend`）も、同じ固定の instance の寿命と worktree の続きを照らしてから開く。続いていなければ開かない（作り直した後の worktree に、古い要求の reset の境界を公開しない） |

### 2.4 作り［見立て］

**要求の固定（`BriefRequestPin`、`src/lib/session/session-brief.ts` に置く）**：

```ts
/** Issue #4224: what a send request was read for, fixed once at its entrance (W1). Read-only: writes nothing. */
export interface BriefRequestPin {
  worktreeId: string;
  /** `mem_worktree_incarnations` as read at the entrance; null when the worktree has none yet (none is made, W5). */
  worktreeIncarnation: string | null;
  /** The newest ledger row of the worktree (any instance, any state) at the entrance; null when there is none. */
  anchorBoundaryId: string | null;
  instance: InstanceLifetime;
}
/** Step 1, where the worktree is read (before the body, which names the instance, is parsed). */
export function pinBriefWorktree(db: Database.Database, worktreeId: string): BriefWorktreePin;
/** Step 2, where the instance is resolved: the request's pin. */
export function pinBriefRequest(db: Database.Database, worktree: BriefWorktreePin, instanceId: string): BriefRequestPin;
```

- 読むのは `getWorktreeIncarnation`（読むだけ、`incarnation.ts:137`）・台帳の今の行の ID・`readInstanceLifetime` だけ。**何も作らない**（W5）
- 入口：送信の route は 2 段で固定する。worktree の部分は `getWorktreeById`（`src/app/api/worktrees/[id]/send/route.ts:170`）と同じ同期の区間で
  `pinBriefWorktree`（その前の await は `params` の解決 `:165` だけで、状態を読まない）。instance の部分は、本文の解析（`:179` の await）の後、
  instance を解決する `validateSendRequest`（`:183-185`）と同じ同期の区間で `pinBriefRequest`（#4116 の `readRoleRosterMark`、`:188` と同じ置き方）。
  本文の解析の待ちの間の作り直しは worktree の部分が拾う。route の後続の await（所有の確認 `:224`・起動 `:299-322`）と
  `sendUserMessage` の中の await（所有の確認 `send-user-message.ts:396`・プロンプトの確認・`/model` の待ち）は、すべて固定の**後**になる
- Timer（§10 の T-2 を PM が許したとき）は timer の行を読んだ同期の区間で固定する
- `SendUserMessageParams` の `brief` を判別の型にする：`brief` が `'auto'` / `'force'` なら `briefPin: BriefRequestPin` が必須（tsc が呼び出し元の
  付け忘れを拾う）。`'never'`（既定）・`'skip'` は不要。`SendBrief` は計画でも reset の公開でも、自分で寿命を読まず `briefPin` を使う
  （今の `SendBrief` の constructor が読む `entryLifetime`（`session-brief.ts:196-206`）を置き換える）

**続いていることの証拠**（W3・W6。書かずに確かめる）：取る区間・reset の公開の同期の区間で、次のどれかが成り立てば、固定の時点から
worktree は削除も作り直しも改名もされていない（台帳の行と世代の行は worktree の子で CASCADE で消え、改名で ID が移る：F3・F5）。

| 固定の時点 | 証拠 |
|---|---|
| `worktreeIncarnation` が非 null | 今の `getWorktreeIncarnation(db, worktreeId)` が同じ値 |
| null で `anchorBoundaryId` が非 null | その行が今も在り、`worktree_id` が同じ |
| どちらも null | 証拠が無い。付けない（理由 `lifetime_unpinned`）。mode が `derived` / `on` かつ `injectOnStart` のときだけ、その同期の区間で世代を作る（次の要求からは固定できる）。2 回目の事前レビュー ① の処置（下の「入口で世代を作る前判定」）の後に起きるのは、保存されている設定（`repository_path`・`branch` の写し）では無効と読めたのに git の観測では有効だった送信だけ |

**入口で世代を作る前判定**（2 回目の事前レビュー ①）：世代も台帳の行も無い worktree への**通常の初回の `auto`**（送信が起動も行う）では、
入口の固定が両方 null になり、route の起動（`startSessionForSend`）が開く `launch` の行には固定の時点の証拠が無い。これを `lifetime_unpinned`
で落とすと UAT-1 の「新しい起動の 1 通目に付く」に反する。寿命の照合は緩めず、次のとおり**入口の同期の区間で**世代を作る：

- `pinBriefWorktree` は、世代が無いとき、保存されている設定だけで同期に前判定する（`briefMayAttach`：worktree の `repository_path` と
  path が等しい登録の repository（無ければ全 repository）のどれかで、`mem_repository_settings` の `injectOnStart`（上書きを含む）が
  `true` で、かつ mode が `off` 以外になりうる規則・上書きがある）。成り立てば `getOrCreateWorktreeIncarnation` をその区間で呼び、
  固定は作った値になる。成り立たなければ何も書かない（W5：保存された設定が `off`・無効なら `mem_*` を書かない）
- 作る行は A の `fixMemEvalLifetime` が mem の読み（`list`・`check`・`brief`）で作るのと同じ行で、内容を持たない
- 前判定が有効で git の観測が `off` だった場合に行が 1 つ残るのは許す（保存された設定が有効と言っているので「off／無効の先行書込み」ではない）
- 起動の待ちの間の作り直し（T0d）では、作り直した worktree に世代が無い（CASCADE）ので照合が落ち、古い要求は付けない。新しい `launch` の行は
  `pending` のまま、次の要求（自分の入口で新しく世代を作る）に 1 回付く

**provider に渡す世代**：取る区間ではなく**計画**で provider を呼ぶので、計画の `withMemTarget` の callback（同期の区間）で、mode が
`derived` / `on` かつ `injectOnStart` のときだけ、上の証拠を照らしてから `w = getOrCreateWorktreeIncarnation(…)` を読み（固定が非 null なら
同じ値であること）、要求に `worktreeIncarnation = w` を載せる。`off`・無効ではこの作成を通らない（W5。`force` も同じ：事前レビュー P2-1 で
「`force` は最初の await の前に作る」をやめた）。

**口に足す欄**（`src/lib/session/brief-provider.ts` の `BriefRequest.target`）：

```ts
target: {
  worktreeId: string;
  /** Issue #4224: the worktree's lifetime this request was read for (W1). */
  worktreeIncarnation: string;
  cliToolId: CLIToolType;
  instanceId: string;
  instanceIncarnation: string | null;
  /** Issue #4224: whether the instance was on the roster when the request was read. */
  instanceOnRoster: boolean;
};
```

`instanceIncarnation`・`instanceOnRoster` は `briefPin.instance` の値。`instanceOnRoster` は、C の `buildBrief` が要求の instance の世代を
照らすとき在籍を `earlier.onRoster`（build の時点の読み）で補っている（`build.ts:247-252`）のを、要求の時点の値に替えるために足す。

**C の provider（`src/lib/brief/provider.ts` の `build`）**：`buildBrief` に
`pinned: { worktreeIncarnation: request.target.worktreeIncarnation, instance: { incarnation: request.target.instanceIncarnation, onRoster: request.target.instanceOnRoster } }`
を渡す。既存の照合（`build.ts:240-246`）と組み立ての前の同期の再確認（`assertStillSame`、`build.ts:205-223`）がそのまま効く。

**`buildBrief` の入口の規則**：`input.request` があるのに `input.pinned` が無ければ例外（`BriefMembershipChangedError('worktree_lifetime')`）。
型の上では `pinned` は任意のまま（CLI の route は自分で固定して渡す：`src/lib/brief/service.ts`）にし、試験の書き換えを増やさない。

**D1 の取る区間（`claimInStretch`）**：所属の照合（`session-brief.ts:367`）の直後に、上の証拠と、計画で載せた世代
（`getWorktreeIncarnation(db, worktreeId) === plan.worktreeIncarnation`）を照らす（W3）。違えば `report = { state: 'skipped', reason: 'worktree_changed' }`
で `null` を返し、`reserve` を呼ばない（予約を作らないので `settle(discarded)` も空の ID で、C は何もしない：`provider.ts:186`）。

**reset の公開（W6）**：`settleInLock` の `openResetBoundaryFromSend`（`session-brief.ts:464-473`）は、`briefPin.instance` を寿命として渡し、
同じ同期の区間で上の証拠を照らす。続いていなければ開かない（ログだけ）。

### 2.5 対照の試験

試験の置き場：`tests/unit/lib/session/session-brief-worktree-lifetime-4224.test.ts`（新規）。DB は `os.tmpdir()` 配下の
`fs.mkdtempSync`、`afterEach` で削除。作り直しは `deleteWorktreesByIds` ＋ 同じ ID・path で登録し直す（C の `brief-retry-paths-4223.test.ts` の `recreate` と同じ）。
作り直しは「その待ちの間に 1 回だけ」起こす（偽の関数の 1 回目の呼び出しの中で作り直し、2 回目以降は何もしない）。

| # | 場面 | 陽性（直す前の実装で落ちる） | 陰性（変わらない動き） |
|---|---|---|---|
| T0a | P1（事前レビュー）：route の本文の解析（`route.ts:179`）・所有の確認（`checkSessionOwnership`、`:224`）の待ちのそれぞれで 1 回だけ作り直す | 新しい worktree で、B の評価の close・知らせの予約・provider の `build`・台帳の `sent` がどれも 0 件。brief は付かない | 作り直さなければ付く（行 1・`sent`）。利用者の本文はどちらでも今どおり送られる（D2 は本文の配送を変えない） |
| T0b | 同：`sendUserMessage` の所有の確認（`send-user-message.ts:396`）の待ち | 同上 | 同上 |
| T0c | 同：プロンプトの確認（`isPromptWaiting`）の待ち | 同上 | 同上 |
| T0d | 同：起動の待ち（`startSessionForSend`、`route.ts:322`）の間。起動は新しい worktree に `launch` の行を開く | 古い要求の送信は brief を付けず、新しい `launch` の行は `pending` のまま次の要求に 1 回付く | 同上 |
| T0e | W6：`/clear` を送る要求の所有の確認の待ちで作り直す | 新しい worktree に `reset` の行が開かない | 作り直さなければ開く（D1 の試験どおり） |
| T0f | Timer（T-2 を許したとき）：timer の発火の後、`isRunning` の待ちで作り直す | T0a と同じ | 同上 |
| T1 | P1（§2.2）：`force` の計画の後、build の前に作り直す（provider の `build` の最初で作り直す偽の reader） | 送られた本文に brief が無い。台帳に `explicit` の行が無い。B の close・知らせの予約が新しい worktree に 0 件 | 作り直さなければ付く |
| T2 | P2：既にある行の計画の後、build の前に作り直す | provider の `build` が例外になり（`worktree_lifetime`）、新しい worktree の `mem_close_records` が 0 件 | 作り直さなければ評価の close が 1 回 |
| T3 | P3：build の後、ロックの待ちの間に作り直す（`force`） | 本文だけ。報告は `worktree_changed`。`reserve` が 0 回 | ロックを待っても作り直さなければ付く |
| T4 | P4：計画の後に改名 | 付けない（`worktree_changed` か `target_unresolved`）。新しい ID の行は `pending` のまま、次の送信（新しい ID）に 1 回付く | 改名しなければ付く |
| T5 | W5（事前レビュー P2-1）：世代の表が 0 件・境界の行なしの worktree で、mode `off`・`injectOnStart=false` それぞれ `force` / `auto` を送る | — | `mem_*` の表の行の数と内容のハッシュが前後で同じ（`mem_worktree_incarnations` は 0 件のまま）。`never` の送信と打つ本文・記録が同じ |
| T5b | 同：有効（`on`・`injectOnStart=true`）・世代 0 件・行なしで `force`・送信が起動も行う通常の `auto` の 1 通目（2 回目の事前レビュー ①） | 入口の前判定で世代が 1 件作られ、1 回目から付く。要求の待ちで作り直すと付かない（固定が効く。T0d） | 保存された設定が無効なのに git が有効と答える送信は `lifetime_unpinned` で 1 回付かない（照合を緩めない） |
| T6 | 入口の規則 | `request` があり `pinned` の無い `buildBrief` を直に呼ぶと例外（規則を外した版が落ちる） | CLI の route（`pinned` あり）は今と同じ答え（`brief-retry-paths-4223` が変えずに通る） |
| T7 | 型 | `brief: 'auto'` で `briefPin` の無い `sendUserMessage` の呼び出しを書いた試験用のソースが tsc で通らない（`// @ts-expect-error` で固定） | `brief` を書かない呼び出し（relay）は通る |

自己対照：T0〜T4 の陽性は「入口の固定をやめ計画で読み直す版」「`buildBrief` に `pinned` を渡さない版」「取る区間の照合を外した版」を
試験の中で作って落ちることを確かめる（ファイルは書き換えず、`setBriefProviderForTest` に照合を外した provider を渡す・`vi.spyOn` で照合を外す）。

---

## 3. 必須項目 (2)：呼び出しの連鎖の走査の網羅を広げる

### 3.1 事実：今の走査が拾う形・拾わない形

走査は `tests/unit/lib/brief/brief-call-chain.ts`（構文の木で `buildBrief` から呼び出し元を辿る）。表との比較は
`tests/unit/lib/brief/brief-retry-paths-4223.test.ts`（行は `src/app/api/worktrees/[id]/mem/brief/route.ts:GET`・`src/lib/brief/service.ts:briefForRoute`・
`src/lib/brief/provider.ts:build` の 3 つ、`:76,97,147`）。送信の呼び出し元は別のガード `tests/unit/guards/session-brief-send-callers-4274.test.ts`（正規表現）。

| 形 | 例 | 今 | 理由［事実］ |
|---|---|---|---|
| 直接・import の別名・ローカルの別名・再 export・名前空間 | `make(…)`・`ns.buildBrief(…)` | 拾う | `brief-call-chain.ts:111-132`・`:153-162` |
| `for` / `while` / `do` の中・自分を呼ぶ | — | 再試行と判定 | `:66-72`・`:232` |
| **provider 経由** | `getBriefProvider().build(r)`・`plan.provider.build(r)`（`session-brief.ts:143`） | **拾わない** | `obj.name(…)` はメソッドか関数の値のプロパティにだけ当てる（`:229`）。C の `build` は関数宣言で、`{ build, reserve }` の**短縮形のプロパティ**（`provider.ts:200-206`）で載るので、メソッドと見ない（`isMethod`、`:91-95` は `PropertyAssignment`・`PropertyDeclaration` だけ） |
| オブジェクト経由の provider | `const p = { build: buildBrief }; p.build(…)` | 拾わない | 値が識別子の `PropertyAssignment` は関数として数えない（`nameOf` は関数の節だけ、`:74-85`） |
| 要素の参照 | `b['buildBrief'](…)` | 拾わない | 呼ばれる式は `Identifier` と `PropertyAccessExpression` だけ（`:155-156`）。ファイルの選別（`chainSources` の `\bbuildBrief\b`）には当たるので、選ばれても連鎖に入らない |
| 動的 import | `(await import('@/lib/brief/build')).buildBrief(…)`・`const m = await import(…); m.buildBrief(…)` | 拾わない | `import(…)` を名前空間として扱わない（`:111-118` は `ImportDeclaration` だけ） |
| 分割代入の別名 | `const { buildBrief: make } = await import(…)`・`= mod` | 拾わない | 別名は `const a = b` の識別子の初期化だけ（`:130`） |
| `.bind` / `.call` / `.apply` | `const f = buildBrief.bind(null, db); f(…)`・`buildBrief.call(null, …)` | 拾わない | `.bind(…)` の結果は別名にならず、`.call` は `call` という名前のプロパティ呼び出しになる |
| 高階関数の中の繰り返し | `ids.forEach(() => buildBrief(…))`・`map`・`withRetry(() => buildBrief(…))` | 呼び出し元としては拾うが**再試行と判定しない** | 名前の無いコールバックは外側の関数に属し、ループの深さは構文のループだけで数える（`:66-72`・`:144-150`） |
| 値として渡す | `withRetry(buildBrief)`・`[buildBrief].map((f) => f(…))` | 拾わない | 呼び出し式でない参照は見ない |

送信の呼び出し元のガード（`session-brief-send-callers-4274.test.ts:39-55`）も、`\bsendUserMessage\(` の正規表現と
`brief:` の行の取り出しだけなので、別名・分割代入・スプレッド（`{ ...params }` の中の `brief`）を拾わない［事実］。

src に今ある形［事実］：`.build(` は `session-brief.ts:143` の 1 か所だけ。`withRetry` などの再試行の補助関数は src に無い（`git grep -nE "withRetry|pRetry"` が 0 件）。
つまり**今の src で漏れている経路は provider 経由の 1 本**（`SendBrief.plan` → `buildWithTimeout` → `provider.build`）で、D2 の接続でこれが実際に動く経路になる。

### 3.2 守る条件

| # | 条件 |
|---|---|
| R1 | brief を組み立てる経路（`buildBrief` を呼びうる関数）は、構文の形に依らず、すべて表の行になる。表に無い経路が src に現れたら試験が落ちる |
| R2 | 走査が解決できない参照（呼び出し元を決められない形）は、**落とす側に倒す**：「解決できない参照」として列挙し、表の例外（理由つき）に無ければ落ちる |
| R3 | 再試行の判定は、構文のループに加え、配列の繰り返しのメソッド・再試行の補助関数・名前の分からない高階関数のコールバックを含む。1 回しか呼ばないと分かっている高階関数だけを、理由つきの許可の表に置く |
| R4 | 連鎖は「要求の入口で固定した寿命を受け取る入口」で止める。止めてよいのは、その入口が自分で寿命を読み直さず、固定が要求の入口の最初の状態の読みと同じ同期の区間で作られることを、別の検査で確かめた関数だけ（事前レビュー P1） |
| R5 | 固定の値（`pinned`・要求の世代）を作る関数は少数に限り、それを**繰り返しの中で作らない**ことを同じ走査で確かめる。作り直す再試行は、古い要求を新しい worktree へ運ぶ（C の 5-2b P1 と同じ型） |
| R6 | 送信の呼び出し元のガードも同じ走査の上に載せ、`brief` の値を構文で読む |

### 3.3 作り［見立て］

`brief-call-chain.ts` を次のように広げる（試験の補助のファイル。`tests/` の中）。

**(a) 根を足す**：根は `src/lib/brief/build#buildBrief` に加えて、口のメソッド `src/lib/session/brief-provider#BriefProvider.build`
（メソッドとして。`.build(` のプロパティ呼び出しに当たる）と、固定の値を作る関数 `src/lib/brief/build#pinBriefLifetime`（R5 用に別の走査）。

**(b) 形ごとの解決**：

| 形 | 扱い |
|---|---|
| 短縮形のプロパティ `{ build }`・値が識別子の `{ build: fn }`・`{ build: fn.bind(x) }` | 参照する関数（解決した (module, name)）を、プロパティ名でメソッドとして到達できる者として足す |
| `obj['name'](…)`（文字列の定数） | `obj.name(…)` と同じ |
| `obj[expr](…)`（定数でない） | R2 の「解決できない参照」（式の中に連鎖の名前が文字列として現れなくても、`obj` が名前空間・連鎖のモジュールの import なら） |
| `import('x')`（`await` つき・`.then((m) => …)` つき） | 名前空間の import と同じ。`const m = await import('x')` は `m` を名前空間に、`const { a: b } = await import('x')` は `b` を (x, a) の import に |
| 分割代入 `const { a: b } = ns`（名前空間・import したオブジェクト） | `b` を (ns の module, a) の別名に |
| `f.bind(…)` | 別名として扱う（`const g = f.bind(…)` は `g → f`）。`f.call(…)`・`f.apply(…)` は `f` の呼び出し |
| 構文のループの外の繰り返し | 呼び出しを囲む名前の無い関数が、`forEach`・`map`・`flatMap`・`filter`・`reduce`・`some`・`every`・`find`・`findIndex`・`then` の連鎖の中の再帰・`setTimeout`/`setInterval` の再登録、または**許可の表に無い任意の呼び出しの引数**なら、再試行と判定する（R3） |
| 1 回だけ呼ぶ高階関数（許可の表） | `Promise.race`・`Promise.resolve().then`（1 段）・`withinMs`・`withMemTarget`・`withInstanceInputLock`・`runInSendScope`・`Promise.all`（要素ごとに別の要求のとき。理由を表に書く）など。表の各行に「なぜ 1 回か」を書く。表に足すときは、その関数の本体を読んで繰り返しが無いことを確かめる |
| 呼び出しでない参照 | 連鎖の名前に解決する識別子が、呼び出し・import/export・別名の初期化・`.bind/.call/.apply` の受け手・プロパティの値のどれでもない位置（引数として渡す・配列に入れる・`return` する）に現れたら R2 の「解決できない参照」 |
| 相互の再帰 | 連鎖の呼び出しの有向グラフで、ある呼び出し元が自分へ戻る閉路の上にあれば再試行 |

**(c) 連鎖を止める入口（R4）**：`src/lib/session/session-brief.ts:SendBrief.plan` を「要求の固定を受け取る入口」の表に置き、その先
（`sendUserMessage` とその呼び出し元）へは連鎖を伸ばさない。理由：`SendBrief` は送信 1 回に 1 つ（`send-user-message.ts:355`）で、
寿命は要求の入口で固定した `briefPin`（§2.4、事前レビュー P1）を受け取るだけで自分では読まない。送信を繰り返す呼び出し元は**新しい要求**として
入口で固定し直すのが正しい（古い要求を運ばない）。止めてよいことは次の 3 つの検査で確かめる：

- 構文：`SendBrief` の本体（`plan`・`claim`・`settleInLock`）が寿命を読む関数（`readInstanceLifetime`・`getWorktreeIncarnation`）を固定の代わりに呼ばない
  （取る区間・reset の公開の「続いていることの証拠」の照合の読みは許可の表に置く）
- 型：`brief` が `'auto'` / `'force'` の `sendUserMessage` は `briefPin` を必須にする（§2.4、T7）
- 実行：`plan()` を同じ `SendBrief` で 2 回呼ぶと 2 回目は何もしない（実装で入れる柵）

止めた先の網羅は (d)（呼び出し元と `brief` の値）と (e)（固定を作る場所）が受け持つ。

**(d) 送信の呼び出し元のガード（R6）**：`session-brief-send-callers-4274.test.ts` の取り出しを、同じ走査の根 `sendUserMessage` に替え、
引数のオブジェクトの `brief` の欄を構文で読む（オブジェクトの字面・スプレッドは「解決できない値」として R2 に）。表の値は今のまま
（route は `body.brief ?? 'auto'`、relay は無し）。Timer は §10 の決定に従う。

**(e) R5 の走査**：根 `pinBriefLifetime`・`pinBriefWorktree`・`pinBriefRequest`（§2.4）と、provider が `pinned` を組む関数（`provider.ts:build`）の呼び出し元を
同じ規則で辿り、繰り返しの中で固定を作る呼び出し元が 1 つも無いことを表で固定する（今は `service.ts:briefForRoute` がループの前で 1 回。
D2 で足す `send/route.ts` の `handleSend`）。

同期の区間の検査は二段固定（§2.4）に合わせて**2 つに分ける**（2 回目の事前レビュー ⑥）：

| 検査 | 対の呼び出し | 間に置いてはいけないもの |
|---|---|---|
| worktree の固定 | 最初の状態の読み `getWorktreeById` → `pinBriefWorktree` | `await`（本文の解析 `readJsonObjectBody` を含む） |
| instance の固定 | instance の解決 `validateSendRequest` → `pinBriefRequest` | `await`（所有の確認・起動の待ち） |

本文の解析の `await` は worktree の固定と instance の固定の**間**にあってよい（その待ちの間の作り直しは worktree の固定が拾う）。
自己対照：正しい二段固定は通り、`pinBriefWorktree` を本文の解析の後へ移した版・`pinBriefRequest` を所有の確認の後へ移した版がそれぞれ落ちる。

### 3.4 対照の試験

置き場：`tests/unit/lib/brief/brief-call-chain-forms-4224.test.ts`（新規）。自己対照の作法は C と同じく `chainSources(…, extra)` で
選別の前にソースを足し、選別から表の比較まで通す（実リポジトリのファイルは書き換えない）。各陽性は「その形の規則を走査から外すと落ちる」
ことを実装の中で確かめる（C の 12.5 と同じ）。

| # | 形 | 陽性（足したソースが表との比較で落ちる。規則を外すと通ってしまう） | 陰性（呼び出し元にならない・再試行にならない） |
|---|---|---|---|
| C1 | provider 経由 | `getBriefProvider().build(r)` を呼ぶ関数・`const p = getBriefProvider(); p.build(r)`・`plan.provider.build(r)` | `.build` という名前の無関係なメソッドを持つ別のクラスの**宣言だけ**（呼ばない） |
| C2 | オブジェクト経由 | `const port = { build: buildBrief }; port.build(…)`・`{ build }` の短縮形・`{ make: buildBrief.bind(null) }` | 同じ名前の文字列 `'build'` だけ・コメントだけ |
| C3 | 要素の参照 | `b['buildBrief'](…)`（`import * as b`） | `b['other'](…)` |
| C4 | 定数でない要素の参照 | `b[key](…)`（`b` が連鎖のモジュールの名前空間）→ 解決できない参照として落ちる | `localRecord[key](…)`（連鎖のモジュールに由来しない） |
| C5 | 動的 import | `(await import('@/lib/brief/build')).buildBrief(…)`・`const m = await import('./build'); m.buildBrief(…)`・`import('./build').then((m) => m.buildBrief(…))` | `await import('./render')` の `drawText(…)` |
| C6 | 分割代入の別名 | `const { buildBrief: make } = await import('./build'); make(…)`・`const { buildBrief: make } = ns; make(…)` | 別のモジュールからの同名の分割代入 `const { buildBrief } = otherLib`（module が違う） |
| C7 | `.bind`/`.call`/`.apply` | `const f = buildBrief.bind(null, db); f(…)`・`buildBrief.call(null, …)`・`buildBrief.apply(null, args)` | 無関係な関数の `.bind` |
| C8 | 配列の繰り返し | `ids.forEach(() => buildBrief(…))`・`await Promise.all(ids.map(() => buildBrief(…)))` が再試行（`retries: true`） | 許可の表の `withMemTarget(…, () => buildBrief(…))` は再試行にならない |
| C9 | 再試行の補助関数 | `withRetry(() => buildBrief(…))`（表に無い高階関数）が再試行 | 許可の表の `withinMs(buildBrief(…), …)` |
| C10 | 値として渡す | `withRetry(buildBrief)`・`[buildBrief].map((f) => f(…))` → 解決できない参照として落ちる | 型の位置（`typeof buildBrief`）・`export { buildBrief }` |
| C11 | 相互の再帰 | `a` → `b` → `a` で `b` が `buildBrief` を呼ぶ → 両方が再試行 | 再帰の無い 2 段の呼び出し |
| C12 | 止める入口（R4） | `SendBrief.plan` の中で `readInstanceLifetime` を呼んで固定し直すソース → 止める検査が落ちる。route で `pinBriefRequest` を所有の確認の `await` の後へ移したソース → (e) が落ちる | 今の形（入口で固定・`plan` は受け取るだけ）は通る |
| C13 | 固定を繰り返しの中で作る（R5） | `for (…) { const pinned = pinBriefLifetime(…); await buildBrief(…, { pinned }) }` が落ちる | ループの前で 1 回作り、中で使い回す（今の `briefForRoute`） |
| C14 | 送信の呼び出し元（R6） | `const send = sendUserMessage; send(db, { …, brief: 'auto' })`・`sendUserMessage(db, { ...params })` が表との比較で落ちる | 今の 3 つの呼び出し元は表どおり |

表（`brief-retry-paths-4223.test.ts` の `ROWS`）に足す行：`src/lib/session/session-brief.ts:buildWithTimeout`（`retries: false`）と
`src/lib/session/session-brief.ts:SendBrief.plan`（止める入口）。各行の作り直しの対照は §2.5 の T1〜T3 を呼ぶ。

---

## 4. (3) provider を `getBriefProvider()` に繋ぐ・空の provider の振る舞いを保つ

### 4.1 繋ぐ形［見立て］

- 新しい定数 `MEM_BRIEF_PORT`（`src/lib/brief/provider.ts` に足す）＝ `{ ...MEM_BRIEF_PROVIDER, settle: settleBriefAttempt }`。
  `MEM_BRIEF_PROVIDER` そのものは `settle` を持たないまま（C の試験 `brief-provider.test.ts:79` の `settle` が無いことは変えない）
- `getBriefProvider()`（`src/lib/session/brief-provider.ts:113-115`）の既定を `EMPTY_BRIEF_PROVIDER` から `MEM_BRIEF_PORT` へ替える。
  `setBriefProviderForTest(null)` は「既定に戻す」のまま
- **静的な import** にする。登録（起動時に `server.ts` で差し込む）にしない理由：送信の route は Next の bundle の中で動き、
  `server.ts` が import した module の実体と同じとは限らない（同じ module を 2 つの bundle が別に持つ）。登録を忘れると黙って空になり、
  試験と本番で既定が分かれる
- 循環の確認［事実］：`src/lib/brief/provider.ts` の値の import の閉包（型だけの import を除く）は `src/lib/session/send-user-message.ts`・
  `session-brief.ts`・`src/lib/tmux/tmux.ts` に届かない（実装の前の採取で確かめた。237 モジュール）。`brief/provider.ts` →
  `session/brief-provider.ts` は型だけ。C の I9（`tests/unit/guards/brief-no-generation-4223.test.ts`）が tmux に届かないことを固定している

### 4.2 本番で変わること・変わらないこと

| 条件 | 打つ本文 | 書く表 |
|---|---|---|
| mode `off`（既定、D3） | 今と同じ（`plan` が provider を呼ぶ前に返る：`session-brief.ts:287`） | 台帳の `skipped(off)` だけ（D1 の今と同じ） |
| `injectOnStart=false`（既定、`mem-db.ts:44`） | 今と同じ（`:288`） | 台帳の `skipped(disabled)` だけ |
| `derived` / `on` かつ `injectOnStart=true`（人が画面で有効にした：`src/components/mem/RepositoryMemSettings.tsx`） | 境界の後の最初の付けてよい送信に C の brief が 1 回付く | 台帳・B の予約と受領・`mem_worktree_incarnations`（§2.4）・B の評価の close（`on` だけ） |
| 境界の無い instance・対象外のツール・`never` の経路 | 今と同じ | 何も書かない |

### 4.3 対照の試験

| # | 陽性 | 陰性 |
|---|---|---|
| E1 | 既定の provider（`setBriefProviderForTest` を呼ばない）で、mode `on`・`injectOnStart=true`・境界ありの送信の本文が `<<<cmate-brief:` で始まり、利用者の本文がバイト一致で後ろに続く（接続を外すと落ちる） | — |
| E2 | — | **既定の provider のまま**、mode `off` と `injectOnStart=false` の 2 つで、`never` と比べて `cliTool.sendMessage` / `sendMessageWithImage` の引数・`recordSendAttempt` の記録（digest を含む）・route の応答・`chat_messages` の行がすべて等しく、`mem_*` の表の行の数とハッシュが前後で同じ。provider の `build` が 0 回（D1 の (d) と同じ比べ方、場面は本文のみ・画像あり・契約の前文つき） |
| E3 | — | `setBriefProviderForTest(EMPTY_BRIEF_PROVIDER)` で D1 の (d) を明示して走らせ、今と同じく等しい（§10 の書き換えの後も「空の provider で 1 バイトも変わらない」を固定し続ける） |
| E4 | 比べ方が効くことの確認：E2 の観測に 1 バイト足すと等しくない（D1 の (d) の自己対照と同じ） | — |

---

## 5. (4) B の知らせの受領に、含めた ID と配送の結果を渡す

### 5.1 手順［事実の経路 ＋ 見立ての接続］

1. **build**（ロックの外）：C が本文に**実際に入った**知らせの ID だけを `includedNoticeIds` に返す（`provider.ts:140-150`）。受領・予約は書かない
2. **取る区間**（ロックの中・同期）：D1 が `reserve({ boundaryId, claimToken, includedNoticeIds, body })` を呼ぶ（`session-brief.ts:398-413`）。
   C が B の `reserveMemNotices` で予約し、予約できた知らせだけの本文と ID を返す（`provider.ts:153-182`）。D1 はそれを打つ本文にする
3. **決着**（ロックの中）：送信の結果を `outcomeOf`（`session-brief.ts:132-134`：`sent`→`sent`、`not-sent`→`not_sent`、`indeterminate`→`unknown`）で
   台帳に書く（`settleBoundaryClaim`、`:449`）。取ったのに決着しないまま抜けたら `unknown`（`abandonInLock`、`:477-479`）
4. **知らせ**（ロックの外）：`afterLock` が `provider.settle({ boundaryId, outcome, includedNoticeIds })` を 1 回呼ぶ（`:482-500`）。
   取った送信は決着の結果と**打った本文の** ID、予約して取らなかった送信は `discarded` と予約に渡した ID
5. **D2 の接続**：`MEM_BRIEF_PORT.settle = settleBriefAttempt`（§4.1）。C が試行を引き、B の `settleMemNoticeAttempt` を写像で呼ぶ
   （`provider.ts:92-97`：`sent`→`sent`、`not_sent`・`discarded`→`not-sent`、`unknown`→`indeterminate`）

### 5.2 「受領は D の配送の結果だけで確定する」の根拠と守る条件

［事実］B の受領（`settleMemNoticeAttempt`）を呼ぶのは src で `src/lib/brief/provider.ts:192` の 1 か所だけ（`git grep -n settleMemNoticeAttempt -- src`）。
予約（`reserveMemNotices`）も `provider.ts:167` だけ。人の確認（`acknowledgeMemNoticeByHuman`、`src/lib/mem/service.ts:655`）は画面の別の操作で、brief の受領ではない。
`commandmate brief`（C の CLI）は `listMemNoticesFor`（書かない）だけで、予約も受領もしない（C 設計 §5.6）。

| # | 条件 | 試験 |
|---|---|---|
| N1 | `sent` の受領は、打った本文に入った ID だけ。build で選んでも予算・予約で落ちた ID は受領しない | 偽の B（`deps.notices`）で、build の `{n1,n2}` のうち n2 を他の境界に先に取らせる → 本文に n1 だけ、`sent` で n1 だけ受領 |
| N2 | `not_sent`・`discarded` は受領しない（知らせは `pending` に戻り、次の送信で予約し直せる） | プロンプト待ちで `not-sent` → n1 が `pending`、次の送信に付いて `sent` |
| N3 | `unknown` は B の「未確認」（`indeterminate`）で、受領ではない。再送しない（D1） | `indeterminate` の送信 → B の記録が `indeterminate`、次の送信に付かない |
| N4 | 受領を書くのは `settleBriefAttempt` だけ（走査で固定） | `settleMemNoticeAttempt` の呼び出し元を §3 の走査で列挙し、表が `provider.ts:settle` 1 行であること。CLI の `commandmate brief`・preview の経路は 0 回 |
| N5 | サーバの再起動をまたぐ試行は B が戻す（別の boot の予約は古いものとして `pending`＋未確認 1：`src/lib/db/mem-close-db.ts:156-158`）。D1 は他のプロセスの `claimed` を `unknown` に読む（`session-brief.ts:257-260`） | 予約の後に「再起動」（C のメモリと D1 の `liveClaims` を消し、B の boot を替える）→ 台帳は `unknown`、知らせは `pending`・未確認 1。次の送信は台帳の行に付かない（D1）が、別の境界の brief にはその知らせが「未確認」で入りうる（B の規則） |
| N6 | 並行の 2 送信で `build` が 2 回走っても、受領は打った 1 つの本文の ID だけ | D1 設計 §9「provider との分担」を実の provider（`MEM_BRIEF_PORT`）で走らせる |
| N7 | 実の provider と B で、予約できた送信が取れずに `discarded` になる場合（予約の後に新しい境界・世代の変化）・予約に渡した ID と予約できた ID の集合が違う場合・2 つの送信の決着の順の入れ替え（`sent` → `discarded`、`discarded` → `sent`）でも、受領は打った本文の ID だけで、残りは `pending` に戻る（事前レビューの補足） | 偽の B ではなく実の `reserveMemNotices`・`settleMemNoticeAttempt` で、決着の順を入れ替えた 2 通りを走らせる |

### 5.3 `settle` に `claimToken` を足すか（C 設計 §11 U9）

**足さない**［見立て］。理由：C は `declined` を数える規則で、口を変えずに試行を取り違えない（C 設計 §5.3、試験 I12 で順序の入れ替え・
65 件以上の build・一部の予約まで固定済み）。`claimToken` を足すと C の試行の表の鍵を替えることになり、既に固定した規則の書き換えが
観測された失敗なしに D2 の差分へ入る。§9 の全入口の表で N1〜N6 を実の provider で走らせ、規則で足りることを確かめる。足りない場面が
見つかったら、そのとき足す（口の欄を足すだけで済む）。

---

## 6. (5) フックでも brief を出す Agent で二重にしない

### 6.1 事実

- CommandMate が置くフックは Agent の文脈に何も出さない（§0.1 H1）。だから**今の二重は CommandMate の中からは起きない**
- 文脈へ出せる口：Claude Code の `SessionStart` の標準出力は会話の文脈に入る［未確認：Claude Code の仕様で、このリポジトリでは実測の記録が無い。§8 の U-H1］。
  Codex・Command Code の `SessionStart` の出力が文脈に入るか［未確認：U-H2・U-H3］
- 二重が起きうるのは、(i) 利用者が自分で置いた `SessionStart` のフック（Epic の背景の「開始のフックで全文を出す」運用）、(ii) これから
  F（#4226）・H（#4228 の `cmate-handoff`）が置くフック

### 6.2 どちらを採るか：送信の側［見立て］

**送信の側（D1・D2 の差し込み）を主にし、フックの側は送信の側が届けるときに何も出さない。**

| 観点 | 送信の側 | フックの側 |
|---|---|---|
| ツールに依らない | ○（3 ツール。他は明示の口） | ツールごと（出力が文脈に入るか［未確認］） |
| 配送の結果が分かる | ○（`sent` / `not_sent` / `unknown`） | × 出力が届いたか分からない |
| B の受領 | ○（`sent` の ID だけ） | × 受領できない（届いたか分からないものを受領しない：C 設計 C8） |
| 予算と #2464 | ○（利用者の本文と合わせて数える） | 別の経路（フックの出力の上限は［未確認］） |
| Epic の決定 | D10：「Agent のフックの有無に依らない主経路」 | — |

### 6.3 作り［見立て］

- `commandmate brief` に `--session-start` を足す：フックから呼ぶ形。所属の `injectOnStart` が `true` で、ツールが送信の側の対象
  （`BOUNDARY_TOOLS`：`src/lib/session/session-boundary.ts:46`）なら、**stdout に何も出さず exit 0**（stderr に 1 行
  「この会話には送信の側が brief を付けます」）。それ以外は今の `commandmate brief` と同じ本文を出す（予約も受領もしない）
- 判定は route の側（`GET /api/worktrees/:id/mem/brief?…&sessionStart=1`）で、`withMemTarget` の答えと `BOUNDARY_TOOLS` だけで決める
  （台帳を読まない・書かない。フックの時点では送信の側がまだ付けていないので、「付けたか」ではなく「付ける経路があるか」で決める）
- 保証の範囲（文書に書く）：CommandMate が二重にしないのは、**CommandMate が置くフックと `--session-start` を使うフック**まで。
  利用者が `commandmate brief`（旗なし）や手書きの引き継ぎを `SessionStart` で出すのは止められない。利用者向けの説明
  （`docs/user-guide/cli-operations-guide.md` と `docs/en/` の対）に「`injectOnStart` を有効にしたら、`SessionStart` のフックでは `--session-start` を使う」と書く
- ガード：CommandMate が生成するフックの設定（Claude の `hook-settings-generator.ts`・Codex の `codex/hooks-config.ts`・Command Code の
  `command-code/hooks-config.ts`）が、`commandmate brief` を旗なしで呼ばないこと・中継のスクリプトが stdout に書かないことを固定する試験
  （`tests/unit/guards/hook-no-brief-output-4224.test.ts`、新規）

### 6.4 対照の試験

| # | 陽性 | 陰性 |
|---|---|---|
| K1 | `injectOnStart=true`・Claude の instance：`--session-start` の stdout が空・exit 0（判定を外した版は本文を出して落ちる） | `injectOnStart=false`：`--session-start` が今の `commandmate brief` と同じ本文 |
| K2 | — | 対象外のツール（copilot）：`injectOnStart=true` でも本文を出す（送信の側が付けないので） |
| K3 | — | 旗なしの `commandmate brief` は今と同じ（C の `tests/unit/cli/commands/brief.test.ts` が変えずに通る） |
| K4 | 生成したフックの設定に旗なしの `commandmate brief` を足した版がガードで落ちる | 今の生成物は通る |
| K5 | — | `--session-start` は予約・受領をしない（B の偽が 0 回） |

---

## 7. (6) 予定していない終わり方の後の先頭の表示

### 7.1 何を出すか

brief の本文の**データの区画の最初の行**（C の固定の先頭 4 行と区切りの後、`src/lib/brief/render.ts:138-149` の `lines` の先頭）に、次の 1 行を出す：

```
終わる前の更新を確認できない（この instance の最終更新は N 時間前）
```

- この instance の更新が「最終更新」の規則（§7.3）で 1 件も見つからないとき：`終わる前の更新を確認できない（この instance の更新の記録なし）`
- N は整数の時間（切り捨て）。1 時間未満は `1 時間未満`
- 文言は固定のテンプレート（Epic D1：モデルを呼ばない）。**「更新せずに終わった」「更新を忘れた」とは書かない**（経過時間だけで断定しない）
- 1 行は固定の文と数だけで、長さの上限は 128 バイト（§7.4 の予算の計算に使う。第 2 版の 96 は「記録なし」の文（97 バイト）が入らないので実装で直した）

固定の先頭（5 行、`src/types/brief.ts:54` の `BRIEF_TEXT_FIXED_LINES`）に足さない理由［見立て］：固定の部分の最小値（C 設計 §2.6・I14）と、
組み直しの `dropNoticeLines`（`provider.ts:64-71`：先頭 4 行を固定とみなす）を変えずに済む。ただし「後ろの項目と同じに落ちてよい」
項目ではないので、§7.4 で**必須の項目**として扱う（事前レビュー P2-5）。

### 7.2 いつ出すか

すべて満たすとき（どれかが欠ければ出さない）。判定は provider の `build`（計画の時点）で 1 回行う。

| # | 条件 | 根拠・読み方 |
|---|---|---|
| X1 | mode が `on` | 「最終更新」は手で書く項目（S7・S8）の話で、`derived` では読まない（C 設計 §4） |
| X2 | 計画した境界の種類が `launch` か `auto_restart`（プロセスの世代の境界） | reset・resume は会話の操作で、プロセスは終わっていない。`explicit` は境界を知らない（D1 設計 §7.3） |
| X3 | この instance に、その境界の `opened_at` より前の**会話の証拠**がある | 台帳の保持（20 行、種類を問わず古い行を消す：`src/lib/db/session-brief-db.ts:270-272`）には頼らない（事前レビュー P2-3）。証拠は (a) `chat_messages` の利用者の行（`worktree_id`・`cli_tool_id`・`instance_id` が同じ。経路は問わない：送信・relay・transcript の取り込み）、(b) §7.3 の「この instance の更新」のどちらか。instance の世代の `created_at` で下限を切るのは、B の定義（`incarnation.ts:47`）どおり `issued_by='roster'`（新しい組み：削除して足し直した）のときだけ。`lazy`（mem の最初の書き込み・既にある primary の最初の roster 保存）と NULL（v67 より前）の `created_at` は誕生の時刻ではないので下限にしない（2 回目の事前レビュー ②）。worktree の作り直しの前の会話は、`chat_messages` が worktree の子（CASCADE）なので数えない。どちらも無ければ出さない（「初めての起動」と断定するのではなく、前の会話を示す証拠が無いので出さない） |
| X4 | 前の世代について「終わる前の更新」の記録が**確認できない** | 読み口 `readPreEndUpdate(db, { worktreeId, instanceId, before: openedAt })` → `'recorded' \| 'not_recorded'`。G・F が書き手になるまでは常に `not_recorded`（§0.1 H2） |

**送信の中の再起動との関係**（事前レビュー P2-2）。`sendMessage` の中の `requireSession`（Codex は `src/lib/cli-tools/codex.ts:1025`、
共通は `base.ts:774-790`）は、provider の `build` と取る区間の**後**で新しいプロセスを作り、D1 は決着が `sent` のとき記録を新しい行へ写す
（`copyDeliveryToRelaunchBoundaries`、`session-brief.ts:450-452`）。表示の時点を次のとおり決める［見立て］：

| 場合 | 起きること | 表示 |
|---|---|---|
| R-a：起動の行 L1 が `pending`（L1 のプロセスにはまだ何も付いていない）で、送信の前に L1 のプロセスが死んでいた | 計画は L1 で作る。L1 は `launch` で、X3 は L1 より前の会話（前の世代 L0）を見る。打った後、送信の中の再起動の行 L2 へ記録が写り、L2 も `sent` | L1 のための本文に先頭の行が入り（X3 が成り立てば）、それが L2 の会話に届く。行の文言は世代を名指さず、最終更新は instance で決まるので、L2 のための行と同じ文になる。**届く** |
| R-b：L1 が `sent`（一度送ってから死んだ） | 計画の候補が無いので本文だけ。送信の中の再起動で L2 が `pending` で開く | 次の付けてよい送信で、L2 のための本文に入る（X3 は L1 の会話を見る）。**1 通遅れて届く**（D1 設計 §3.5「2 通目に付くことがある」と同じ） |
| R-c：reset の行 R1 が `pending` のまま死んだ（`/clear` の後に送らずに kill） | 計画は R1（`reset`）なので X2 で行を入れない。記録は L2 へ写る | **届かない**（残る危険）。同じ会話に brief を 2 つ入れない D1 の規則（1 つの会話に 1 回）を優先する。ログ `brief-previous-end-not-delivered` を残し、UAT-5 で頻度を見る |
| R-d：生きているプロセスへの再接続 | 行が開かない（D1 設計 §2.2） | 足さない |

### 7.3 「この instance の最終更新」（事前レビュー P2-4）

［事実］更新の書き手は列で分かれる：

| 書き込み | 置き場・列 |
|---|---|
| Agent の項目の更新 | `mem_items.updated_by='agent'`・`updated_by_instance` に instance（`mem-db.ts:906,947`） |
| 人の編集 | `updated_by='human'`（項目）、`session_notes.updated_by='human'`（画面の `now`：`mem-db.ts:1176`） |
| 条件による close | `updated_by='server'`・`updated_by_instance=NULL`・`updated_at=今`（`mem-db.ts:1077-1079`） |
| 今の `now` | `mem_items` ではなく `session_notes`（`worktree_id`・`instance_id` の行、`updated_at`・`updated_by`：v61 の表と v66 の列、`mem-db.ts:646-648`） |
| 退避した `now` | `archiveSlot` が `mem_items` に `closed` で入れる。`updated_by_instance` は NULL、`updated_at` は退避の時刻（`mem-db.ts:489-520`）。作者が最後に書いた時刻は残らない |

規則：最終更新 ＝ 次の最大。作者は A の所有の規則（`mem-db.ts` の `ownedBy`：Agent の更新は `origin_instance_id` と
`origin_incarnation` が自分の項目だけ）と同じく **instance の世代**で決める（2 回目の事前レビュー ②）。

- `session_notes` のこの (worktree, instance) の行で、`updated_by='agent'`、かつ `mem_incarnation` が今の instance の世代と同じものの `updated_at`
- `mem_items` の行で、`updated_by='agent'` かつ `updated_by_instance` がこの instance と等しく、かつ `origin_incarnation` が今の instance の世代と
  **等しい**ものの `updated_at`。同じブランチの別の worktree の同名の primary（例：両方 `claude`）は世代が違うので数えない。
  `origin_instance_id` だけへは寄せない：条件の close の `updated_at` を作者の更新と読まないため
- instance の世代が無いとき（Agent の mem の書き込みは世代を発行するので、書き込みも無い）は「記録なし」

数えないもの：人の編集・条件の close（`server`）・退避した `now`（作者の時刻が分からない）・`updated_by` が NULL の古い `session_notes` の行。
数えないものだけのときは「この instance の更新の記録なし」（分からない過去の時刻を作らない）。A のファイル（`mem-db.ts`）は変えない。

**読む時点**（X-f の一部解消の残り）：条件の close（`mem-db.ts:1077-1079`）は `updated_at` を上書きするので、評価（`buildBrief` の 3）の**前**に読む。
読みは `buildBrief` の 1（最初の await の前の同期の区間）で 1 回行い、mode が `on` と分かった後に使う。評価が close した項目も、その前の
作者の時刻で数える（「72 時間前」のまま）。

**置き場**［見立て。実装で決めた形］：先頭の行は `BriefSourceId` の新しい情報源（S10）にはしない。`BRIEF_SOURCE_IDS` は `--json` の `sources`
の配列と C の試験の固定（9 つ）に出るので、送信の側（provider）だけの行のために CLI の出力を変えない。読み口は **`src/lib/brief/previous-end.ts`**
（`sources.ts` ではない。実装で決めた形、§18 の P3-5）の `readPreviousEnd`（読むだけの SQL）と `readPreEndUpdate`（G・F までは `not_recorded`）・
`previousEndLead` に置き、行は model の `lead`（`BriefModel.lead?: string`）として `drawText` が固定の 4 行の直後に置く。
G の S-C（終わる前の更新の記録）は `previous-end.ts` の `readPreEndUpdate` を差し替える前提で読むこと。
`commandmate brief` は境界を知らない（X2 が成り立たない）ので、CLI のテキスト・`--json` には出ない。

### 7.4 必須の項目としての予算（事前レビュー P2-5）

［事実］`fitText` は先頭の項目も予算に入らなければ 0 件にする（`src/lib/brief/fit.ts:47-58` の `takePrefix`：行数は
`BRIEF_TEXT_FIXED_LINES + taken <= maxLines`）。残り 5 行なら、先頭の行の無い brief が付き、境界は消費される。

規則：先頭の行が要る（§7.2 が成り立つ）build では、その行を**必須**にする。

- provider（テキスト）：`maxLines < BRIEF_TEXT_FIXED_LINES + 1`、または固定の部分＋先頭の行が `maxBytes` に入らないなら、brief を作らない。
  `BriefResult` に任意の欄 `skipReason?: 'over_limit'` を足し（口の追加の欄。§0.1）、D1 はそれを `skipped(over_limit)` として記録する
  （「上限を超えたので brief を付けずに送ったことを記録する」：Issue の本文どおり。利用者の本文は削らない）。先頭の行を落とした brief は付けない
- 入ったときは、先頭の行の後ろの項目だけを C の規則で削る（`fitText` に「先頭の k 項目は必須」の引数を足す）
- `reserve` の組み直し（`dropNoticeLines`）は知らせの行だけを外すので、先頭の行は残る
- CLI のテキスト・`--json`：先頭の行は CLI に出ない（`commandmate brief` は境界を知らず `lead` を組まない）ので、最小値（テキスト 1,024・
  `--json` 4,096）と C の I14 は**数え直さず**そのまま（実装で決めた形、§18 の P3-5）。`fitJson` は `lead` を読まない（必須の先頭の項目は
  `fitText` だけ）。CLI に `lead` を出す変更をするときは、この 2 つ（I14 の数え直し・`fitJson` の必須の項目）を同じ差分で入れる

### 7.5 対照の試験（C の `brief-invariants.test.ts` の個別の表に I18 として足す。送信の中の再起動は D1 の入口の表へ）

| # | 陽性 | 陰性 |
|---|---|---|
| X-a | 前の会話があり、記録が無い → 先頭の項目がこの行。最終更新 3 時間 5 分前 → `3 時間前` | 前の会話の証拠が無い（初めての起動）→ 出ない |
| X-b | この instance の更新が無い → `この instance の更新の記録なし` | 種類が `reset`・`resume`・`explicit` → 出ない |
| X-c | 文言の検査：「更新せずに」「忘れ」を含む版（72 時間前で断定する版）が落ちる | `derived` → 出ない |
| X-d | 読み口 | 読み口が `recorded` を返す偽 → 出ない（G・F が来たときの振る舞いを先に固定） |
| X-e（P2-3） | `/clear` を 25 回（保持の 20 行を超える）繰り返した後に kill して起動 → 出る（台帳に前の `launch` の行が無くても） | 会話の無い worktree の最初の起動 → 出ない。別の世代（同じ ID の削除・再追加）の会話だけがある → 出ない |
| X-f（P2-4） | 72 時間前に Agent が書いた項目を、今回の評価で条件の close（`server`）にする → `72 時間前` のまま（`0 時間前` に変わらない）。1 時間前に Agent が `now` を更新 → `1 時間未満` ではなく `1 時間前`、`now` の更新を拾う | 人だけが編集した項目・退避した `now` だけ → `この instance の更新の記録なし`。`origin_instance_id` に寄せる版が close の時刻を拾って落ちる |
| X-g（P2-5） | 先頭の行が要る build で残り 5 行 → brief は付かず `skipped(over_limit)`、利用者の本文はバイト一致で送られる。先頭の行を落として付ける版が落ちる | 残り 6 行 → 固定の部分＋先頭の行だけの brief が付く。予算が十分 → 先頭の行が先頭にあり後ろの項目が入る。テキスト最小値 1,024 ＋ worst-fixed（C の I14）で先頭の行が入る |
| X-h（P2-2） | R-a：L1 が `pending` のまま偽の CLI を「死んだ」にし、送信の中の再起動を起こす → L2 の会話に先頭の行を含む brief が 1 回、L1・L2 とも `sent` | R-d：生きているプロセスへの送信 → 行が開かず、先頭の行も足されない |
| X-i（P2-2） | R-b：一度送ってから「死んだ」にして送る → その送信は本文だけ、次の送信に先頭の行つきの brief が 1 回 | R-c：残る危険を固定する：先頭の行は届かず、ログ `brief-previous-end-not-delivered` が 1 行、brief は二重にならない |

---

## 8. (7) 実機の受入（Claude Code・Codex・Command Code）

### 8.1 分け方の規則［見立て］

- **自動の試験**：CommandMate の中の判断（境界の台帳・取る・決着・予算・mode・世代・受領・文言）。画面とフックの入力は fixture で与える。D1・C・D2 の単体・結合の試験
- **UAT**：外のプロセスの振る舞いでしか分からないこと（フックが**いつ**届くか、Agent の画面と transcript に brief が**どう見えるか**、
  Agent が区画を**データとして**扱うか、実際の所要時間）。fixture を作れないか、fixture の正しさそのものを確かめるもの
- UAT で確かめたことは、可能なら fixture として採って自動の試験へ戻す（D1 設計 §10 の U1〜U5 の「fixture を採る」）
- UAT の項目は自動の試験の合格では合格にしない。フックの届く時点・実の transcript の形・Agent の解釈・実の所要時間は、UAT の記録
  （手順・capture・ログの抜粋・判定、`dev-reports/issue/4224/uat/`）を残して判定する（事前レビューの補足）

### 8.2 UAT に回す項目

隔離の環境（専用の DB・HOME・tmux のソケット・ポート。`docs/user-guide/uat-isolation.md`）で、3 ツールそれぞれ。mode `on`・`injectOnStart=true` のブランチと、
`off` のブランチを 1 つずつ用意する。

| # | 項目 | Claude Code | Codex | Command Code | 判定 |
|---|---|---|---|---|---|
| UAT-1 | 新しい起動 → 1 通目に brief が 1 回、2 通目は本文だけ。利用者の本文が全文届く（48 KiB 近い本文も） | ○ | ○ | ○ | 画面の capture と transcript で本文の全文、台帳の行 `sent` が 1 |
| UAT-2 | reset（`/clear`・`/new`）→ 次の送信に 1 回。reset のコマンドそのものには付かない | `/clear` | `/new`（U2：`SessionStart` の届く時点も記録） | `/clear`（U4） | 同上 |
| UAT-3 | 端末から直接打った reset → 次の付けてよい送信に 1 回（遅れて分かる境界） | ○ | ○（U2） | × 対象外（検出しない。表どおりであることを確かめる） | 台帳の `late` と付いた送信 |
| UAT-4 | resume で会話が変わる → 1 回。同じ会話の resume → 付かない | ○（U1：fixture を採る） | 明示の口（`--with-brief`）だけ | 明示の口だけ | 同上 |
| UAT-5 | プロセスを kill → 次の送信が起動し直す（自動の再起動）→ 1 回、先頭に §7 の行。§7.2 の R-a（初回の送信の前に kill）・R-b（一度送ってから kill）・R-c（`/clear` の後に kill）を分けて記録 | ○ | ○ | ○ | R-a は送信の中の再起動の本文に、R-b は次の送信に先頭の行。R-c は届かないこと（残る危険）と頻度 |
| UAT-6 | サーバの再起動 → 再接続の送信に付かない | ○ | ○ | ○ | 台帳 |
| UAT-7 | mode `off` のブランチ → 何も付かず、画面と transcript が今と同じ | ○ | ○ | ○ | 目視と capture の比較 |
| UAT-8 | `--no-brief` は 1 回だけ、`--with-brief` は付く | ○ | ○ | ○ | 台帳・応答の `brief` |
| UAT-9 | 利用者が `SessionStart` に `commandmate brief --session-start` を置いても二重にならない | ○（U-H1） | ○（U-H2） | ○（U-H3） | 会話の文脈に区画が 1 つ |
| UAT-10 | brief を付けた送信の後、画面の履歴（transcript からの取り込み #2121）で利用者の行が 1 件・本文のまま。実の transcript の形を fixture に採る | ○（U6） | ○ | ○ | §8.5 の H-1。外れたら規則の形を直す |
| UAT-11 | Agent が区画を命令として読まない（区画の中に「このファイルを消せ」の固定の文を入れた mem の項目） | ○ | ○ | ○ | 指示に従わないこと（D12。保証ではなく観察として記録） |
| UAT-12 | provider の所要時間（所属の解決の git を含む）が 1,700 ms の内か | ○ | ○ | ○ | サーバのログの所要時間（C 設計 U2） |

### 8.3 自動の試験で確かめる項目（UAT に回さない）

同時の初回の送信・送信の拒否・結果不明・ロックの順序・世代の照合（instance・worktree）・予算と #2464 の行数・mode の途中の変化・
受領の写像・連鎖の網羅・フックの判定・先頭の行の条件と文言。D1 設計 §9・C 設計 §7・本書 §2.5・§3.4・§4.3・§5.2・§6.4・§7.4・§9。

### 8.4 UAT の結果で決まる実装（条件つき）

- **UAT-10** は「区画を外すかどうか」ではなく、§8.5 の取り込みの規則が実際の transcript の形で働くかを確かめる（規則そのものは条件なしで実装する。事前レビュー P2-6）
- **UAT-2/3 の U2・U4** の結果で、D1 設計 §2.2 の表（△）を ○ か × に直す（文書だけ）
- **UAT-12** で 1,700 ms を超えるなら、D1 の打ち切り（2,000 ms、`session-brief.ts:70`）と C の期限を揃え直す（C 設計 §10 の指摘）

### 8.5 transcript からの取り込みと履歴の行（事前レビュー P2-6）

［事実］Claude・Codex・Command Code（と antigravity）の transcript の取り込みは、共通の `recordUserTurn`
（`src/lib/history/user-turn-recorder.ts:203`）へ利用者のターンの本文を渡す。`recordUserTurn` は本文を正規化し（`:211`）、
窓の中の鍵の無い利用者の行（`/send` が作った行）のうち**本文が一致する**ものを引き取り（`adoptExistingRow`、`:311-345`・`sameText` `:404`）、
一致しなければ新しい行を INSERT する（`:250-261`）。呼び出し元：`src/lib/hooks/sources/claude/history.ts`・`codex/history.ts:632`・
`command-code/history.ts:638`・`antigravity/history.ts:834`。brief を付けた送信は、transcript には `brief + "\n\n" + 本文` として残る
［未確認：実の transcript の形は UAT-10］ので、元の `/send` の行と一致せず、**brief を含む 2 行目が入る**。D1 設計 §4.3 の
「`chat_messages` は利用者の本文だけ」は送信の側だけの話で、取り込みの側では保たれない。

守る条件：

| # | 条件 |
|---|---|
| H-1 | brief を付けた送信の取り込みの後も、その送信の利用者の行は 1 件で、本文は利用者の本文のまま |
| H-2 | 区画を外すのは、**CommandMate が付けた証拠**と結び付くときだけ。形だけで外さない（利用者が同じ形の区画を自分で送ったときは全文を残す） |
| H-3 | 空の provider・mode `off`・brief を付けなかった送信の取り込みは今と同じ |
| H-4 | 取り込みは何度読み直しても同じ結果（鍵 `request_id` の既存の冪等のまま） |

作り［見立て。2 回目の事前レビュー ③④⑤ で第 2 版を替えた］：`recordUserTurn` の引き取り（`adoptExistingRow`）に、全文で引き取れなかった
ときの 2 段目を足す。**証拠は台帳ではなく、その送信が書いた `/send` の行そのもの**にする。

1. 1 段目は今のまま：全文（正規化）で、窓の中の鍵の無い行を引き取る。利用者が自分で区画ごと送った（手で貼った）送信は、その送信の
   `/send` の行が区画を含む全文を持つので、ここで全文のまま引き取られる（③：同じ長さ・正しい tag の手の再送でも全文が残る）
2. 2 段目：1 段目で引き取れず、本文の先頭が C の区画の形（`<<<cmate-brief:<8 桁の 16 進>` の行で始まり、同じ tag の
   `cmate-brief:<tag>>>>` の行で閉じ、その後に空行）のときだけ、区画と区切りを外した残りで、**同じ窓**（`adoptionFromMs` で広げた窓を含む。⑤）の
   鍵の無い `/send` の行を引き取る。引き取れた行は、利用者の本文だけを持つ行（D1 の送信は `chat_messages` に利用者の本文だけを書く）なので、
   「CommandMate が区画を前に付けて打った送信」の行である。relay の行（`relay:` の鍵）は 2 段目では引き取らず、数えもしない（relay は `never`）
3. 2 段目でも引き取れなければ、**全文のまま** INSERT する（H-2。区画を外した本文を INSERT しない：外してよい証拠が無い）
4. tag は中身から計算し直さない（④：予約で知らせの行を外した本文 `dropNoticeLines` は元の tag を保つので、計算し直すと正当な区画が落ちる）。
   照らすのは開きと閉じの tag が同じことだけ
5. 台帳（`brief_bytes`・`settled_at`）は読まない（③：同じ長さの記録は自動の付加の証拠にならない。⑤：保持の 20 行で消えると証拠を失う）

残る危険（文書に残す）：端末から直接打った（`/send` を通らない）区画つきの本文と、同じ窓の中に区画の後ろと同じ本文の未引き取りの `/send` の行が
あると、2 段目がその行を引き取る。その行の本文（利用者の本文）は変わらず、直接打った方の区画が履歴に出ないだけで、行は増えも消えもしない。

表示はこの DB の行を出すだけなので、表示の側で区画を外す処理は足さない（第 1 版の「表示で外す」をやめた）。

対照の試験（`tests/unit/history/user-turn-recorder-brief-4224.test.ts`、新規。3 つの読み手の fixture の形で `recordUserTurn` を呼ぶ）：

| # | 陽性（直す前の実装で落ちる） | 陰性 |
|---|---|---|
| H-a | brief を付けた送信（台帳 `sent`・`brief_bytes` 一致）の後、transcript の `brief + "\n\n" + 本文` を取り込む → 利用者の行は 1 件、本文は元のまま、`request_id` が付く。Claude・Codex・Command Code の 3 つの読み手で同じ | 同じ取り込みを 2 回 → 行は 1 件のまま（H-4） |
| H-b | — | 利用者が自分で同じ形の区画を送った（その送信の `/send` の行が全文を持つ）→ 全文が残る（H-2）。実際に brief を付けた直後に同じ区画を手で再送しても、両方の行が残り、手の再送の行は全文のまま（③） |
| H-c | — | 空の provider で送った本文の取り込み → 今と同じ（H-3） |
| H-d | — | 区画の後ろと同じ本文の `/send` の行が窓の中に無い → 全文が残る（無関係な古い記録で外さない）。開きと閉じの tag が違う区画 → 全文が残る |
| H-e（④） | 知らせの一部を予約できずに組み直した本文（`dropNoticeLines`、tag は元のまま）の取り込み → 利用者の行が 1 件・元の本文のまま | — |
| H-f（⑤） | キューで 11 分遅れて受理された送信（`adoptionFromMs` で窓を広げる取り込み）と、台帳の保持で行が消えた後の初回の取り込みでも、利用者の行は 1 件 | — |

---

## 9. (8) 実装の範囲と、全入口の不変条件の表駆動の試験

### 9.1 変えるファイル

| ファイル | 変更 |
|---|---|
| `src/lib/session/brief-provider.ts` | `BriefRequest.target` に `worktreeIncarnation`・`instanceOnRoster`（§2.4）、`BriefResult.skipReason?`（§7.4）。`getBriefProvider()` の既定を `MEM_BRIEF_PORT`（§4.1） |
| `src/lib/session/session-brief.ts` | `BriefRequestPin`・`pinBriefWorktree`・`pinBriefRequest`（§2.4）。計画・取る区間・reset の公開が固定を使い、続いていることの証拠を照らす（W1・W3・W6）。報告の理由 `worktree_changed`・`lifetime_unpinned`。`skipReason` の記録（§7.4）。`plan()` の 2 回目を何もしない柵（§3.3 (c)） |
| `src/lib/session/send-user-message.ts` | `brief` を判別の型にし、`'auto'` / `'force'` で `briefPin` を必須に（§2.4）。`SendBrief` へ渡す |
| `src/app/api/worktrees/[id]/send/route.ts` | `:170` で `pinBriefWorktree`、`validateSendRequest` の同期の区間で `pinBriefRequest`、`sendUserMessage` へ `briefPin`（§2.4） |
| `src/lib/brief/provider.ts` | `MEM_BRIEF_PORT`（§4.1）、`build` が `pinned` を渡す（§2.4）、先頭の行を必須にして入らなければ `skipReason`（§7.4） |
| `src/lib/brief/fit.ts` | `fitText` に「先頭の行（`lead`）は必須」（§7.4。`fitJson` は変えない：`lead` は CLI に出ない） |
| `src/lib/history/user-turn-recorder.ts` | `stripDeliveredBrief`（§8.5） |
| `src/lib/brief/build.ts` | 入口の規則：`request` があって `pinned` が無ければ例外（§2.4） |
| `src/lib/brief/previous-end.ts`（新規）・`src/lib/brief/model.ts` | 先頭の行の読み口 `readPreviousEnd`・`readPreEndUpdate`（G・F までは `not_recorded`）・`previousEndLead`、`BriefModel.lead`（§7.3。`sources.ts`・`rank.ts`・`BRIEF_SOURCE_IDS` は変えない：S10 にしない） |
| `src/lib/db/session-brief-db.ts` | 今の行の ID（worktree 全体の最新）・`sent` の行の `brief_bytes`・`settled_at` を読む関数（読むだけ、§2.4・§8.5）。保持の規則と migration は変えない（§7.2 X3 は台帳の保持に頼らない） |
| `src/lib/brief/service.ts`・`src/app/api/worktrees/[id]/mem/brief/route.ts`・`src/cli/commands/brief.ts` | `--session-start`（§6.3）。`--help` |
| `src/cli/types/api-responses.ts` | 応答の `brief.reason` に `worktree_changed`・`lifetime_unpinned`（送信の応答の型の写し） |
| `src/lib/timer-manager.ts` | `brief: 'auto'` と、timer の行を読んだ同期の区間での `pinBriefWorktree`・`pinBriefRequest`（§10 の T-2 を PM が許したときだけ） |
| 説明 | `docs/user-guide/cli-operations-guide.md`・`docs/en/user-guide/cli-operations-guide.md`（`--session-start`・フックとの二重・先頭の行）、D1 設計 §2.2 の表（UAT の結果） |
| 断片 | `changelog.d/4224.md`・`dev-reports/module-reference/issue-4224.md`（実装の契約で書く） |

変えないもの：A・B のファイル、`submit-verified-sender*.ts`、`src/lib/relay/**`、migration、ターミナル・直接入力・回答の route。

### 9.2 全入口の不変条件の表駆動の試験

置き場：`tests/unit/lib/session/brief-injection-entrances-4224.test.ts`（新規）。形は D1 の `session-brief-entrances-4274.test.ts`
（入口を store の側から列挙し、各行に同じ不変条件を当てる）と同じにし、provider は**実の `MEM_BRIEF_PORT`**（B の通知の時計と
`withMemTarget` の git だけ偽）。

**入口の列挙**（表に無い入口が増えたら落ちる）：

| 列挙の元 | 入口 |
|---|---|
| `sendUserMessage` の呼び出し元（§3.3 (d) の走査） | 送信の route（`auto` / `skip` / `force`。CLI の `send`・`ask`・`send --contract`・画面はこの route を通る）・Timer（§10 の決定の値）・relay の配送（`never`） |
| `buildBrief` の連鎖（§3.3） | `commandmate brief`（route `GET`）・`--session-start`・provider（`SendBrief.plan` で止める） |
| B の書き込み（`reserveMemNotices`・`settleMemNoticeAttempt` の呼び出し元） | `provider.ts:reserve`・`provider.ts:settle`（`MEM_BRIEF_PORT.settle`） |
| 台帳を書く関数（D1 の表と同じ） | D1 の入口の表を再利用 |

**不変条件**（各入口 × 場面の表に同じ関数で当てる）：

| # | 不変条件 | 主な場面 |
|---|---|---|
| J1 | 利用者の本文は削られない：打った本文の末尾が `"\n\n" + 本文`（画像の参照を含む `typedBodyFor` の形）にバイト一致、または本文そのもの | 日本語・絵文字・48 KiB 近い本文・画像・契約の前文 |
| J2 | 1 つの境界の行に `sent` は高々 1 回。brief を含む打った本文は境界ごとに高々 1 つ | 同時の初回の送信・拒否・結果不明・再起動・送信の中の再起動 |
| J3 | B の受領（`sent`）は打った本文に入った ID だけ。`not_sent`・`discarded`・`unknown` は受領しない | §5.2 N1〜N6 |
| J4 | mode `off`・`injectOnStart=false`・`never` の経路は、`force` も含めて、打つ本文・記録・応答・`chat_messages` が `never` と同じ（`force` は応答の `brief` の報告だけが違う）で、`mem_*` を書かない | §4.3 E2、§2.5 T5 |
| J5 | worktree・instance を同じ ID で作り直したら（要求の入口の後のどの待ちでも）、古い要求の brief を付けず、B の予約・受領・評価・reset の境界の公開を新しい側に起こさない | §2.5 T0a〜T0f・T1〜T4、D1 の (a) |
| J6 | 最終本文は #2464 の検証済みの大きさ（48 KiB・240 行）の内。超えるなら brief を外し本文は送る | 予算の境目 |
| J7 | 生成を呼ばない・tmux に届かない（`buildBrief` の連鎖） | C の I9 を D2 の入口（`--session-start`・`MEM_BRIEF_PORT`）にも当てる |
| J8 | `--session-start` と送信の側で、同じ会話に区画が 2 つ入らない（CommandMate の経路の中で） | §6.4 K1 |
| J9 | 先頭の行は §7.2 の条件のときだけ・断定の語を含まない。要るときは付けた brief に必ず入る（入らなければ付けずに `over_limit`） | §7.5 |
| J11 | transcript の取り込みの後も、brief を付けた送信の利用者の行は 1 件・本文のまま。証拠の無い区画は外さない | §8.5 H-a〜H-d |
| J10 | `commandmate brief` と `--session-start` は予約・受領・台帳の書き込みをしない | B の偽・台帳の行の数 |

場面の表は D1 の (a)〜(d) の場面に、§2.5・§5.2・§6.4・§7.4 の場面を足したもの。各不変条件に陽性対照（その不変条件を壊した偽の
provider・照合を外した版で落ちる）と陰性対照（壊さなければ通る）を置く。

### 9.3 確認に使うコマンド（実装の契約）

`npx vitest run tests/unit/lib/brief tests/unit/lib/session/session-brief* tests/unit/lib/session/brief-injection-entrances-4224.test.ts tests/unit/cli/commands/brief.test.ts tests/unit/guards tests/unit/docs`・
`npm run lint`・`npx tsc --noEmit`。テスト全体は実行しない（契約の規則）。

---

## 10. 既存の試験の期待が変わる所（実装の契約で PM が決める）

接続（§4）と Timer は、既存の試験が「繋いでいない」「付けない」を固定しているので、期待の書き換え無しには実装できない［事実］。
契約の規則（既存の期待値を変えない）に従い、変えずに報告するか、PM が契約で許すかを決める。

| # | 試験 | 今の期待 | D2 の後の期待（案） | 推奨 |
|---|---|---|---|---|
| T-1 | `tests/unit/lib/brief/brief-provider.test.ts:77-81`（`it('id, minimum and default; no settle (D2 connects settleBriefAttempt); not wired into getBriefProvider')`） | `getBriefProvider()` が `EMPTY_BRIEF_PROVIDER` | `MEM_BRIEF_PROVIDER.settle` が無い（:79）はそのまま。`getBriefProvider()` が `MEM_BRIEF_PORT`。it の名前の「not wired into getBriefProvider」は事実と反するので名前の変更も要る | 許す（D2 の目的そのもの） |
| T-1b | `tests/unit/lib/session/session-brief-entrances-4274.test.ts:402-411` の (d) | `setBriefProviderForTest(null)` ＝ 空の provider | `setBriefProviderForTest(EMPTY_BRIEF_PROVIDER)` に替える（比べる中身は変えない）。null は「既定（実の provider）」に戻る意味になる | 許す（期待値は同じで、空の provider を明示するだけ） |
| T-1c | D1 の他の試験で、偽の provider を置かずに mode `on`・`injectOnStart=true` で「付かない」を見ているもの［未確認：実装の契約で既定を替えて走らせ、落ちたものを列挙する］ | 空の provider で付かない | 偽の provider か `EMPTY_BRIEF_PROVIDER` を明示する | 列挙を見て決める |
| T-2 | `tests/unit/lib/timer-manager.test.ts:275` 以降（`sendUserMessage` の引数をまるごと固定） | `brief` の欄が無い | `brief: 'auto'` が加わる | 許す（#1028「手の送信と同じ経路」、D1 設計 §4.1）。許さないなら Timer は `never` のまま、Timer の後の最初の手の送信に付く（今と同じ） |

代わりの案（採らない）：既定を空のまま残し、試験の共通の準備（`tests/setup.ts`）で空を、本番だけ実の provider を既定にする。
試験と本番で既定が分かれ、「本番で付く」を試験が見なくなるので採らない。

---

## 11. 対になる場所（探した結果）

| 探した対象 | 結果 |
|---|---|
| provider の経路の写し：CLI の route（`briefForRoute`）と provider（`provider.ts:build`）の世代の固定 | route は `pinBriefLifetime` で固定済み（`build.ts:123`）。provider だけが固定していない → §2 で揃える |
| 寿命の照合の写し：D1 の `claimInStretch`（instance）と C の `assertStillSame`（worktree・instance） | D1 の取る区間に worktree の照合が無い → §2.4 W3 で足す。照合の規則は C の `getWorktreeIncarnation` の等しさ、D1 の `isSameInstanceLifetime` を共有（写さない） |
| 走査の写し：`brief-call-chain.ts`（構文の木）と `session-brief-send-callers-4274.test.ts`（正規表現） | 後者も同じ穴（別名・スプレッド）を持つ → §3.3 (d) で同じ走査に載せる |
| B の受領の呼び出し元 | `provider.ts:192` だけ（§5.2）。他に無いことを確かめた |
| フックの出力 | Claude・Codex・Command Code・copilot・antigravity の生成物と中継のスクリプト：文脈に出すものは無い（§0.1 H1）。copilot・antigravity は差し込みの対象外（D1 設計 §2.2） |
| 型の写し（`src/cli/types/`） | 送信の応答の `brief` の型（`src/cli/types/api-responses.ts`）に理由の語を足す（§9.1）。brief の型は `src/types/brief.ts`（C の方針どおり写さない） |
| 説明の ja/en | `docs/user-guide/cli-operations-guide.md` と `docs/en/user-guide/cli-operations-guide.md` の対（§9.1） |
| 古い動きを固定する試験 | §10 の T-1・T-1b・T-2。T-1c は実装の契約で列挙 |
| transcript から履歴を作る読み手 | Claude・Codex・Command Code・antigravity の 4 つが共通の `recordUserTurn` を呼ぶ（§8.5）。共通の 1 か所で直すので、読み手ごとの写しは作らない。第 1 版の「Command Code は対象外（`TRANSCRIPT_READER_TOOLS`）」は誤り：`TRANSCRIPT_READER_TOOLS`（`src/cli/utils/reply-ledger.ts:68`）は `reply` の読み手の一覧で、取り込みは `command-code/history.ts:638` もしている |
| 要求の固定の写し：C の route の `pinBriefLifetime`（`build.ts:123`）と送信の `pinBriefRequest` | 規則（入口で 1 回・読み直さない）は同じ。`pinBriefRequest` は世代を作らない（W5）点だけが違い、理由を §2.4 に書いた |

---

## 12. 本文に無い指摘（この設計の範囲外。直さない）

- `tests/unit/guards/session-brief-send-callers-4274.test.ts:39-55`：`sendUserMessage` の呼び出しの取り出しが正規表現で、別名・分割代入・
  スプレッドの `brief` を拾わない。D2 で直す提案（§3.3 (d)）は入れたが、ガードのファイルの変更は実装の契約の scope に入れる必要がある
- `src/lib/session/session-brief.ts:136-147`：provider の打ち切り（2,000 ms）が `build` を止めない（C 設計 §10 と同じ。C は自分の期限で吸収済み）。
  D2 では揃えず、UAT-12 の実測で決める
- `tests/unit/lib/brief/brief-provider.test.ts:77` の it の名前は D2 の接続で事実と反する（§10 の T-1）

---

## 13. 未確認の一覧

| # | 未確認 | 影響 | 確かめ方 |
|---|---|---|---|
| U-H1 | Claude Code の `SessionStart` のフックの標準出力が会話の文脈に入るか（入る形・上限） | §6 の二重が Claude で起きうるか | UAT-9 |
| U-H2 | Codex の `SessionStart` のフックの出力が文脈に入るか | 同上 | UAT-9 |
| U-H3 | Command Code の `SessionStart` のフックの出力が文脈に入るか | 同上 | UAT-9 |
| U1〜U6 | D1 設計 §10 の U1（Claude の resume の payload）・U2（Codex の `/new` の `SessionStart` の時点）・U3（Codex の `/clear`）・U4（Command Code の `/clear`・resume）・U5（Claude の `/clear` の別名）・U6（履歴への出方） | 境界の表・§8.4・§8.5 | UAT-2〜4・UAT-10 |
| U-T1 | C の 1,700 ms が実機で足りるか（C 設計 U2） | 付かない頻度 | UAT-12 |
| U-T2 | §10 の T-1c の数 | 実装の契約の scope | 実装の契約で既定を替えて走らせる |
| U-P1 | 実の transcript で、brief を付けた利用者のターンが `brief + "\n\n" + 本文` の形のまま残るか（正規化・前後の空白・画像の参照の位置） | §8.5 の区画の判定 | UAT-10 で 3 ツールの fixture を採る |
| U-P2 | §7.2 の R-c（reset の後に kill）の頻度 | 先頭の行が届かない残る危険 | UAT-5 |
| U-X1 | 「終わる前の更新」の記録を G・F がどの表に書くか | §7 の読み口の実装 | G（#4227）・F（#4226）の設計。D2 は読み口の形だけ決め、`not_recorded` を返す |

---

## 14. 事前レビューの処置

Codex の事前レビュー（2026-11-09、P1 1・P2 6。`workspace/orchestration/runs/2026-11-08/prereview/review-4224.md`）。7 件すべて採った。
D1〜D13・A・B・C・D1 と違う作りは要らなかった（§0.1 は止める点なしのまま）。

| # | 指摘 | 処置 | 守る条件・対照の試験（反映先） |
|---|---|---|---|
| P1 | 寿命の固定が送信要求の途中（`plan()`）から始まり、所有の確認・プロンプトの確認・起動の待ちの間の作り直しを覆わない | **採る** | 寿命は要求の入口（route の `:170` と `validateSendRequest` の同期の区間、Timer の発火）で 1 回だけ固定し、`briefPin` として計画・取る・reset の公開・provider まで運ぶ。`brief: 'auto'/'force'` で `briefPin` を型で必須に（W1・W6、§2.4、§3.3 (c)(e)）。陽性：本文の解析・所有の確認 2 か所・プロンプトの確認・起動の待ち・reset・Timer の各待ちで 1 回だけ作り直すと、新しい側の評価・予約・`build`・境界の公開が 0 件（T0a〜T0f）、型の付け忘れが tsc で落ちる（T7）／陰性：作り直さなければ付く・`brief` を書かない呼び出しは通る |
| P2-1 | `force` の先行作成が off／無効の無書き込みに反する | **採る** | 固定は読むだけ（`getWorktreeIncarnation`・台帳の今の行）にし、世代を作るのは mode が `derived`/`on` かつ `injectOnStart` の同期の区間だけ。証拠の無い `force` は `lifetime_unpinned` で 1 回付かない（W5、§2.4 の「続いていることの証拠」）。陽性：有効・世代 0 件・行なしの `force` は 1 回目付かず 2 回目付き、2 回目の待ちの作り直しは拒否（T5b）／陰性：off・無効で `force`・`auto` の前後で `mem_*` の行数と内容が不変（T5） |
| P2-2 | 送信の中の再起動では、先頭の行を作る時点が早すぎる | **採る** | 判定は計画の時点で 1 回、表示の時点を R-a（送信の中の再起動の本文に届く）・R-b（1 通遅れて届く）・R-c（reset の後の kill は届かない＝残る危険、ログを残す）・R-d（再接続は足さない）で決めた（§7.2）。陽性：R-a で L2 の会話に先頭の行つきが 1 回・L1/L2 とも `sent`（X-h）、R-b で次の送信に 1 回（X-i）／陰性：生きているプロセスでは足さない（X-h）、R-c は届かず二重にもならないことを固定（X-i）。UAT-5 で 3 つを分けて記録 |
| P2-3 | 保持 20 行に `launch` が無いことを「初起動」と扱えない | **採る** | X3 を台帳の保持に頼らず、境界の `opened_at` より前の会話の証拠（`chat_messages` の利用者の行・この instance の更新。instance の世代の後だけ）で判定する。証拠が無いときは「初起動」と断定せず出さないだけ（§7.2）。保持の規則・migration は変えない。陽性：`/clear` を 25 回の後に kill して起動しても出る（X-e）／陰性：会話の無い最初の起動・別の世代の会話だけなら出ない（X-e） |
| P2-4 | 「この instance の最終更新」を今の列から正しく求められない | **採る** | Agent の項目の更新（`updated_by='agent'` かつ `updated_by_instance` が等しい。`origin_instance_id` へ寄せない）と今の `now`（`session_notes` の `updated_by='agent'`）だけを数え、人の編集・条件の close・退避した `now`・古い行は数えない。数えるものが無ければ「記録なし」（§7.3）。陽性：72 時間前の項目を今回 close しても `72 時間前`、直近の `now` の更新を拾う、`origin` に寄せる版が落ちる（X-f）／陰性：人だけ・退避だけなら「記録なし」（X-f） |
| P2-5 | 順位 0 だけでは先頭の行が必ず残らない | **採る** | 先頭の行が要る build ではその行を必須にし、入らなければ brief を作らず `BriefResult.skipReason='over_limit'` で D1 が記録する（利用者の本文は削らない）。`fitText`・`fitJson` に必須の先頭の項目、CLI の最小値は I14 を数え直して決める（§7.4）。陽性：残り 5 行で付かず `skipped(over_limit)`、先頭の行を落として付ける版が落ちる（X-g）／陰性：残り 6 行で固定＋先頭の行だけ付く、十分な予算・最小値＋最悪の固定の部分で先頭に残る（X-g） |
| P2-6 | 履歴は表示だけでなく、取り込み（保存・重複の排除）の対応が要る | **採る** | 共通の `recordUserTurn` の前で、CommandMate が付けた証拠（台帳の `sent`・`brief_bytes` の一致・窓の中・tag の一致）があるときだけ区画を外して引き取る。形だけでは外さない。表示で外す案はやめた（§8.5、H-1〜H-4）。第 1 版の「Command Code は対象外」も誤りとして直した（§11）。陽性：取り込みの後も利用者の行は 1 件・本文のまま（3 つの読み手、H-a）／陰性：利用者自身の同じ形の区画・空の provider・窓の外・tag の不一致は全文を残す、2 回の取り込みで行が増えない（H-a〜H-d） |
| 補足 | N1〜N6 を実の provider と B で、予約できた側の `discarded`・違う ID の集合・決着の順の入れ替えも含めて／UAT は自動の試験だけで合格にしない | **採る** | §5.2 の N7、§8.1 の UAT の記録（`dev-reports/issue/4224/uat/`） |

---

## 15. 決定：`derived` で task の title を出すか（C 設計 §11 U12）

決定は「`derived` でも task の title は出す」（人が PM の推奨に委任、2026-11-09）。
理由：task は CommandMate が自分で持つ正本（実行契約）で、Epic の D2「導けるものは正本から読む」に当たり、mem の「手で書いた項目」ではない。
title は C の sanitize（見えない文字の置き換え）と 1 行 512 bytes の上限（`BRIEF_ITEM_MAX_BYTES`）を通る。

---

## 16. 2 回目の事前レビューの処置

Codex の 2 回目の事前レビュー（2026-11-09、`workspace/orchestration/runs/2026-11-08/prereview/review-4224b.md`）。前回 7 件は解消 4・一部解消 3、
追加の指摘は P2 6 件（P1 なし）。すべて採った。A・B・C・D1 と違う作りは要らなかった（§0.1 は止める点なしのまま）。
採った指摘の対照の試験は実装の契約で必ず書く。

### 16.1 一部解消の 3 件

| # | 残り | 処置 | 反映先 |
|---|---|---|---|
| P2-2 | R-c（`/clear` の後に送らずに kill）は先頭の行が届かないまま | **残る危険として受ける**（変えない）。同じ会話に brief を 2 つ入れない D1 の規則を優先する。ログ `brief-previous-end-not-delivered` を実装で残し、UAT-5 で頻度を見る。頻度が高ければ別の Issue で「reset の行の brief に先頭の行を足すか」を決める | §7.2 の R-c、§13 の U-P2 |
| P2-4 | X-f の「close の後も 72 時間前」は、その項目しか無ければ取れない（close が `updated_at` を上書きする） | **採る**：先頭の行の読みを評価の前（`buildBrief` の 1 の同期の区間）へ移す。作者の規則は ② と合わせて instance の世代で決める | §7.3 の「読む時点」 |
| P2-6 | 付加物の識別と正当な配送の認識の条件（③〜⑤） | **採る**：下の ③〜⑤ | §8.5 |

### 16.2 追加の 6 件

| # | 指摘 | 処置 | 守る条件・対照の試験（反映先） |
|---|---|---|---|
| ① | 通常の初回起動（世代・台帳なしの worktree への、起動も行う `auto` の 1 通目）も `lifetime_unpinned` になる | **採る** | 入口の同期の区間で、保存された設定の前判定（`briefMayAttach`）が有効なときだけ世代を作る。寿命の照合は緩めない（§2.4 の「入口で世代を作る前判定」）。陽性：未発行・境界なし・有効で、起動も行う通常の `auto` の 1 通目に付く（T5b）／陰性：起動の待ちで作り直すと付かない（T0d）・保存された設定が off／無効なら何も書かない（T5） |
| ② | instance の寿命・作者を B／D1 と違う規則で判断する（`lazy` の `created_at` を誕生と読む・同名の primary の更新を数える） | **採る** | X3 の下限は `issued_by='roster'` のときだけ。作者は `origin_incarnation` が今の instance の世代と等しい項目（A の `ownedBy` と同じ規則）と、`mem_incarnation` が等しい `now`（§7.2 X3・§7.3）。陽性：既にある primary の最初の roster 保存で `lazy` 発行 → kill しても前の会話を拾う（X-j）。同じブランチの別の worktree の同名の primary の更新を「この instance の更新」に数えない（X-j）／陰性：roster による作り直し（`roster` 発行）では前の会話を拾わない（X-j） |
| ③ | 同じ長さの `sent` の記録は自動の付加の証拠にならない（手で貼った区画を外せる） | **採る** | 証拠を台帳から、その送信の `/send` の行（利用者の本文だけを持つ）の引き取りへ替えた。全文の引き取りを先に試す（§8.5 の 1〜3）。陽性：実際に brief を送った直後に同じ区画を手で再送しても全文が残る（H-b） |
| ④ | 一部予約の後の正当な brief が tag の検証に落ちる | **採る** | tag を計算し直さない。開きと閉じの tag が同じことだけを照らす（§8.5 の 4）。陽性：一部予約 → 実際の最終本文 → 取り込みで利用者の行が 1 件・元の本文（H-e） |
| ⑤ | 履歴の証拠の寿命が既存の遅延取り込みより短い | **採る** | 2 段目は 1 段目と同じ窓（`adoptionFromMs` を含む）を使い、台帳を読まない（§8.5 の 2・5）。陽性：11 分遅れの受理・台帳の保持の削除の後の初回の取り込みでも重複しない（H-f）／陰性：窓の中に後ろの本文と同じ行が無ければ外さない（H-d） |
| ⑥ | 固定の網羅の検査が二段固定の手順と一致しない | **採る** | 同期の区間の検査を worktree の固定（`getWorktreeById` → `pinBriefWorktree`）と instance の固定（`validateSendRequest` → `pinBriefRequest`）の 2 つに分け、R5 の根に `pinBriefWorktree` を足す（§3.3 (e)）。陽性：`pinBriefWorktree` を本文の解析の後へ移した版・`pinBriefRequest` を所有の確認の後へ移した版がそれぞれ落ちる（C12）／陰性：正しい二段固定は通る |

X-j（新規、§7.5 の表に足す）：

| # | 陽性 | 陰性 |
|---|---|---|
| X-j（②） | 既にある primary（世代なし）の最初の roster 保存で `lazy` が発行された後に kill して起動 → 前の会話（世代の `created_at` より前の利用者の行）を証拠に先頭の行が出る。同じブランチの別の worktree の `claude` が 1 時間前に更新した項目は数えず「記録なし」 | roster の削除と足し直し（`roster` 発行）の後は、その前の会話だけでは出ない |

---

## 17. 共通規則の全読者（実装の後に書く。5-2b の前）

D2 で足した、または D2 が新しく読み手になった共通の規則と、それを読むすべての場所（`git grep` で探した。実装 `feature/4224-worktree` 時点）。
規則を変えるときは、この一覧の全員を同じ差分で直す。

| 規則 | 正本（書き手） | 読み手 |
|---|---|---|
| 要求の寿命の固定（`BriefRequestPin`：worktree の世代・台帳の今の行・instance の寿命。入口で 1 回） | `session-brief.ts` の `pinBriefWorktree`・`pinBriefRequest` | 送信の route の `handleSend`（2 段）、`SendBrief`（constructor の reset の寿命・`plan`（instance がまだ入口の寿命か：`instanceAsPinned` を今の行・stale claim の決着より前に照らす、違えば何も書かない。今の寿命が固定どおりで行の世代だけ古ければ `rowOfPinnedIncarnation` で `incarnation_changed` に消費。§18 の P3-1・§19）・`planInStretch`・`claimInStretch`・`settleInLock`）、試験の harness（`session-brief-4274-harness.ts` の `send`・`brief-d2-4224-harness.ts` の `entrance`） |
| CLI の要求の寿命の固定（`BriefPinnedLifetime`：最初の await の前に 1 回、前判定と組み立てで共有） | `build.ts` の `pinBriefLifetime`・`pinnedLifetimeChange` | `service.ts` の `briefForRoute`（`--session-start` の前判定 `sessionStartDeferredTo` の await の後に `pinnedLifetimeChange` で照らす・組み立ては `pinned` を渡す。§18 の Codex P1）、`buildBrief` の入口（同じ比較を自分の形で） |
| worktree が続いていることの証拠（`briefWorktreeContinuity`：世代が同じ／台帳の行が同じ worktree に在る／証拠なし） | `session-brief.ts` | `SendBrief.plan`（最初の読みの前・build の後）・`planInStretch`・`claimInStretch`（`same` 必須）・`settleInLock`（W6。固定のある要求は `same` 必須、証拠なしも公開しない。固定の無い Timer・relay は D1 の instance の照合のまま。§18 の Codex P2）。§20 から、上の読み手の書き込みはすべて門 `SendBrief.write` で読む（`unknown` も書かない。§20 の Codex 再レビュー 2 回目の P2）。`buildBrief` は同じ規則を自分の形で読む（`pinned.worktreeIncarnation` と `getWorktreeIncarnation` の等しさ、作る前に照らす） |
| 書き込みの規則（§20：すべての書き込みは `BRIEF_WRITE_RULES` の行として門 `SendBrief.write`／`writeAtEntrance` を通り、`briefWriteVerdict` が continuity `same`（`same-and-instance` の行は instance の寿命も）を証明したときだけ書く。`unknown`・`changed` は何も書かず報告） | `session-brief.ts` の `BRIEF_WRITE_RULES`・`briefWriteVerdict` | `SendBrief` の全書き込み：`plan`（`plan.stale-claim`・`plan.dead-row`・`plan.consume`）・`planInStretch`（`plan.consume`・`plan.incarnation`）・`claimInStretch`（`claim.consume`・`claim.reserve`・`claim.row`）・`settleInLock`（`settle.claim`・`settle.reset`）・`afterLock`（`after.provider-settle`）・`skip`（呼び手の site を受け取る）、`pinBriefWorktree`（`entrance.incarnation`）。走査の試験 `session-brief-write-rule-4224.test.ts`（書き手の名前・import の分類・表の使用） |
| 入口で世代を作る前判定（`briefMayAttach`：保存された設定で `injectOnStart` と `off` 以外の規則がありうるか） | `session-brief.ts` | `pinBriefWorktree` だけ |
| provider は自分で寿命を固定しない（`request` があれば `pinned` 必須） | `build.ts` の `buildBrief` の入口 | `provider.ts` の `build`（`request.target` から `pinned` を組む）。CLI の route（`service.ts:briefForRoute`）は `request` を渡さず `pinBriefLifetime` で固定 |
| instance の誕生と作者（`issued_by='roster'` だけが誕生の証拠・作者は `origin_incarnation`） | B の `incarnation.ts`（`IncarnationIssuedBy`）・A の `mem-db.ts` の `ownedBy` | D1 の `isSameInstanceLifetime`（`session-brief-db.ts`）、D2 の `previous-end.ts` の `readPreviousEnd` |
| brief の区画の形（`<<<cmate-brief:<tag>` … `cmate-brief:<tag>>>>`、tag は中身から。組み直しでも tag を保つ） | C の `render.ts` の `drawText`・`fenceTag` | `provider.ts` の `dropNoticeLines`（先頭 4 行を固定とみなす。先頭の行 `lead` は 5 行目で外さない）、`user-turn-recorder.ts` の `afterDeliveredBrief`（開きと閉じの tag が同じことだけを見る） |
| 先頭の行（`lead`）は必須（入らなければ brief を作らない） | `fit.ts` の `fitText`（`leadUnfit`） | `provider.ts` の `build`（`skipReason: 'over_limit'`）、`session-brief.ts` の `plan`（`skipped(over_limit)`）。`fitJson` は読まない（`lead` は provider の経路だけで、CLI の `--json` には出ない） |
| ツールへの命令の本文（`isSlashCommandBody`：最初の語が `/` で始まる語すべて・`!` で始まる本文。付けない・境界を消費しない） | D1 の `session-boundary.ts`（§18 の PM P2 で広げた） | `SendBrief.plan` だけ（reset の判定 `isResetCommandBody` は `RESET_COMMANDS` の語の一致で別。constructor） |
| 送信の側の対象のツール（`BOUNDARY_TOOLS`） | D1 の `session-boundary.ts` | `SendBrief` の constructor、`openLaunchBoundary`・`observeHookBoundary`・`openResetBoundaryFromSend`、D2 の `service.ts` の `sessionStartDeferredTo`（`--session-start`） |
| 付けるかの mode と `injectOnStart`（`withMemTarget` の答え） | A の `mem/target.ts` | `SendBrief.planInStretch`・`claimInStretch`（`membershipKey`）、`buildBrief`、`sessionStartDeferredTo` |
| 受領の写像（`sent`→`sent`、`not_sent`・`discarded`→`not-sent`、`unknown`→`indeterminate`） | C の `provider.ts` の `SEND_STATE` | `MEM_BRIEF_PORT.settle`（`settleBriefAttempt`）だけ。呼ぶのは D1 の `SendBrief.afterLock` だけ |

実装で設計から変えた所（理由つき）：

- 先頭の行の上限は 128 バイト（§7.1。96 では「記録なし」の文が入らない）
- 読み口 `readPreviousEnd`・`readPreEndUpdate` は `sources.ts` ではなく `src/lib/brief/previous-end.ts`（§7.3。`sources.ts` の import の一覧を増やさない）。`fitJson` に必須の先頭の項目は足さない（`lead` は CLI に出ない）。CLI の最小値と C の I14 は数え直さない（§7.4）
- Timer（§10 の T-2）は `never` のまま（契約で既存の試験の期待を変えない。`tests/unit/lib/timer-manager.test.ts` が引数を固定）。Timer の後の最初の手の送信に付く（今と同じ）
- 接続（§10 の T-1・T-1b）：`brief-provider.test.ts` の既定の期待を `MEM_BRIEF_PORT` に、D1 の (d) の `setBriefProviderForTest(null)` を `EMPTY_BRIEF_PROVIDER` の明示に替えた（D2 の目的そのもの。it の名前は契約どおり変えていない）。D1 の harness は世界の既定を空の provider に明示した（D1 の試験が書かれた前提を保つ）
- C の試験の要求の作り手（`brief-provider.test.ts`・`brief-retry-paths-4223.test.ts`・`close-entrances-4222.test.ts` の `request()`）に `worktreeIncarnation`・`instanceOnRoster` を足した（口の欄が必須になったため。期待は変えていない）

---

## 18. 実装後のレビューの処置（Codex 5-2b・PM 側 Claude の独立レビュー）

5-2b（Codex、P1 1・P2 1）と PM 側の Claude の独立レビュー（P2 1・P3 5）を、PM の処分に従って 1 つの差分で直した。§17 の読み手も同じ差分で直した。

| # | 指摘 | 処置 | 守る条件・対照の試験（反映先） |
|---|---|---|---|
| Codex P1 | `briefForRoute` の `--session-start` の前判定が所属の判定を await した後に `pinBriefLifetime` を呼ぶ。同 ID・同 path の作り直しを挟むと、新しい世代を固定して本文の生成と評価へ進む | **直す** | 寿命を最初の await の前に 1 回固定し、前判定の後に `pinnedLifetimeChange` で照らす（変わっていれば `lifetime_changed`、何も作らない）。組み立ては同じ `pinned` を渡す。陽性：前判定の await 中に作り直す → exit 52・新しい側の条件を閉じない（deferred の側も gone で答える）。直しを外すと落ちる／陰性：作り直しなし → 本文が出て条件が閉じる（`brief-session-start-4224.test.ts` の K6） |
| Codex P2 | reset の公開（`settleInLock`）が寿命 `unknown` でも instance の照合だけで進む | **直す** | 固定のある要求は `same` を要求する（証拠なしの `unknown` も公開しない＝W6 の作り直しの拒否に揃える）。固定の無い送信（Timer・relay、`never`）は D1 のまま。陽性：mem off・境界なしの入口の後、本文の解析中に作り直す → 古い `/clear` は新しい worktree に reset の行を開かない。直しを外すと落ちる／陰性：入口に行がある（`same`）→ reset の行が開く（T0f）。残る影響：mem off で行も世代も無い worktree の最初の送信が `/clear` のときは reset の行を開かない（起動の行が境界になる） |
| PM P2 | `isSlashCommandBody` の `/^\/[a-z][a-z0-9-]*$/` が狭く、`/plugin:cmd args`・`/mcp__srv__p`・`/prompts:name`・`!cmd` の前に brief が付き境界も消費する | **直す**（D1 のファイル。判定の関数だけ） | 最初の語が `/` で始まる語（`[^\s]+`）すべてと `!` で始まる本文は付けない・消費しない。表駆動（`session-boundary-slash-4224.test.ts`）：命令の表は付けず起動の行が `pending` のまま次の本文に付く、本文の表（`see /model`・`/` だけ等）は今までどおり付く。直しを外すと 14 件落ちる。残る影響：`/Users/...` のようなパスで始まる本文にも付けない（安全側） |
| PM P3-1 | 入口で固定した古い instance の寿命の要求が、新しい世代の launch の行を `provider_failed`／`incarnation_changed` で消費する | **直す** | `plan` で今の行を使う前に、instance がまだ入口の寿命か・行の `instanceIncarnation` が固定と違わないかを照らし、違えば消費せず `skipped(incarnation_changed)` を報告する。陽性：入口の後に instance を作り直して起動 → 古い要求は本文だけ、新しい起動の行は `pending`、次の要求がその行に付ける。直しを外すと落ちる／陰性：作り直しなし → 付く（T0g）。build の待ちの間の作り直し（計画した古い行の消費）は D1 の [review ④] のまま |
| PM P3-2 | `--session-start` がフックの `source`（`compact`・外部起動）を見ずに `deferred:'send'` を返す | **文書だけ** | `cli-operations-guide`（ja/en）の `--session-start` の節に範囲を書いた（`compact` の後・CommandMate を通さない会話には、どちらからも brief が入らない） |
| PM P3-3 | off のブランチで `--session-start` が毎回 exit 50 | **追跡**（#4289） | フックの exit の扱いは F・G のフックの方針と合わせて決める |
| PM P3-4 | `briefMayAttach` の `repository_path` 一致での推定／continuity `unknown` で作り直し後に世代を書ける | **記録だけ** | 想定内（T5b）・新しい側自身の世代で実害小 |
| PM P3-5 | 設計との食い違い（`fitJson` に `lead` 未対応・CLI 最小値の I14 再計算なし・読み口の置き場） | **設計書を実装に合わせた** | §7.3（置き場は `src/lib/brief/previous-end.ts`。G の S-C の前提）・§7.4（CLI の最小値と I14 は数え直さない・`fitJson` は `lead` を読まない）・§9.1・§17 |

---

## 19. 再レビューの処置（Codex codex-2 の再レビュー・PM 側 Claude の再レビュー）

不変条件：**古い要求は新しい側に何も書かない／新しい要求は古い側の残りを放置しない**。§18 の P3-1 の直しの境目を、この 2 件で両側から閉じた。§17 の読み手（`SendBrief.plan`）も同じ差分で直した。

| # | 指摘 | 処置 | 守る条件・対照の試験（反映先） |
|---|---|---|---|
| Codex P2 | 旧 instance の寿命を入口で固定した要求が、待機中の作り直しの後に stale claim を読むと、`settleStaleClaim` が寿命の照合より前に新しい instance の行を `unknown` に決着する | **直す** | `plan` は今の行が `pending`・`claimed`（生きた claim も stale claim も）のとき、決着より前に `instanceAsPinned`（固定の寿命と今の寿命）を照らし、違えば何も書かずに `skipped(incarnation_changed)` を報告する。陽性：入口の後に作り直して起動、新しい起動の行を去ったプロセスの claim にする → 古い要求は本文だけ、行は `claimed` のまま。直しを外すと落ちる／陰性：作り直しなし → stale claim は D1 どおり `unknown`（T0g の claimed の対照）。`session-brief-entrances-4274.test.ts` の `settleStaleClaim` の例外の説明も「決着の前に固定の寿命を照らす」に揃えた |
| PM P3（再） | 固定 = 今 = Y でも行が古い incarnation X のとき消費せず報告だけになり、死んだ instance の起動の行が「今の行」として残る | **直す** | 消費しないのは「固定 ≠ 今」のときだけ。固定 = 今で行の世代だけ古い（`rowOfPinnedIncarnation` が偽。どちらかが null なら照らさない）ときは、P3-1 の前と同じく `skipped(incarnation_changed)` に消費する（`pending` だけ。生きた claim は書かない）。陽性：起動の後に作り直し（起動なし）、その後の入口の要求 → 古い行は `skipped(incarnation_changed)`。直しを外すと落ちる／陰性：作り直しの前の入口（固定 = X・今 = Y）→ 古い行は `pending` のまま（T0g） |

---

## 20. 2 回目の再レビューの処置（Codex codex-2 の 2 回目の再レビュー）：端を 1 つずつ塞ぐのをやめて規則にする

直しのたびに足した書き込みから次の指摘が出ていた（§18 の reset の公開、§19 の stale claim の決着と死んだ起動の行の片付け）。そこで、書き込みの関数の側から全書き込みを列挙して表にし、1 つの門を通す。§17 の読み手（`SendBrief` の全書き込み・`pinBriefWorktree`）も同じ差分で直した。

### 20.1 不変条件（規則）

**`session-brief.ts` のすべての書き込みは、要求が入口で固定した worktree の継続を `same` と証明できたとき（行によって instance の寿命も）だけ書く。`unknown`・`changed` なら何も書かずに報告する（fail-closed）。** §18 の reset の経路（固定のある要求は `same` 必須）と同じ規則を、全書き込みに広げたもの。

- 門：`SendBrief.write(site, db, write)`（入口の書き込みは `writeAtEntrance`）。site の guard を `BRIEF_WRITE_RULES` から引き、`briefWriteVerdict` で判定する。判定は書き込みと同じ同期の区間で読む（間に await を挟まない）
- guard：`entrance`（固定より前・固定の証拠そのものを作る）／`same`（書く行は計画した行で、計画の時点で instance が固定どおりと読んだもの）／`same-and-instance`（`same` に加えて今の instance が固定の寿命）／`reset`（固定のある要求は `same`、固定の無い Timer・relay は D1 の instance の照合）／`settled`（`settle.claim` が決めた結果を provider に渡すだけ。差し止めたときは `unknown`）
- 差し止めの報告：`changed` → `worktree_changed`、`unknown` → `lifetime_unpinned`、instance の寿命が違う → `incarnation_changed`。決着（`settle.claim`）を差し止めたときは `brief.state` を `unknown`（理由つき）にし、provider にも `unknown` を渡す（受領にしない）。残った claim は、次の `same` の要求が stale claim として `unknown` に決着する

### 20.2 全書き込みの表

| site | 書き込み（書き手） | 場所 | guard | 前の守り（直す前） |
|---|---|---|---|---|
| `entrance.incarnation` | `getOrCreateWorktreeIncarnation` | `pinBriefWorktree`（`briefMayAttach` のときだけ） | `entrance` | 同じ |
| `plan.stale-claim` | `settleStaleClaim` | `plan` | `same-and-instance` | instance だけ（`unknown` は通した） |
| `plan.dead-row` | `skipBoundary`（`incarnation_changed`） | `plan` | `same-and-instance` | instance だけ（**今回の P2**） |
| `plan.consume` | `skipBoundary`（`target_unresolved`・`off`・`disabled`・`over_limit`・`empty`・`provider_failed`） | `plan`・`planInStretch` | `same` | `changed` だけ止めた（`unknown` は通した） |
| `plan.incarnation` | `getOrCreateWorktreeIncarnation` | `planInStretch` | `same` | `unknown` でも作った（§18 の PM P3-4「記録だけ」を閉じた） |
| `claim.consume` | `skipBoundary`（`off`・`disabled`・`incarnation_changed`） | `claimInStretch` | `same` | `same`（区間の先頭で照らしていた） |
| `claim.reserve` | `provider.reserve`（知らせの予約） | `claimInStretch` | `same-and-instance` | 同じ（区間の先頭と寿命の照合） |
| `claim.row` | `openBoundary`・`fillBoundaryIncarnation`・`claimBoundary` | `claimInStretch` | `same-and-instance` | 同じ |
| `settle.claim` | `settleBoundaryClaim`・`copyDeliveryToRelaunchBoundaries` | `settleInLock` | `same` | 守りなし（打鍵の間の作り直しで、送信の中の再起動が新しい側に開いた行へ配送を写しうる） 。対照：T0i（打鍵の間の改名 → 行は `claimed` のまま・`unknown`・provider に `unknown`。外すと落ちる／改名なし → `sent`） |
| `settle.reset` | `openResetBoundaryFromSend` | `settleInLock` | `reset` | 同じ（§18 の Codex P2） |
| `after.provider-settle` | `provider.settle`（受領） | `afterLock` | `settled` | 決着の結果をそのまま渡していた |

`skip()` は書き込みの site を呼び手から受け取る（以前の `consume: boolean` は無くなった。型で表の site に限る）。

### 20.3 網羅の検査（`tests/unit/lib/session/session-brief-write-rule-4224.test.ts`）

- 走査：モジュールの本文（コメントを除く）で、書き手の名前（台帳の書き込み関数・世代の作成・reset の公開・provider の `.reserve(`・`.settle(`）が出るすべての所が門の呼び出しの括弧の内側にあること。台帳のモジュール（`session-brief-db`・`incarnation`・`session-boundary`）からの import はすべて書き手か読み手に分類済みで、名前空間・動的 import・別名の import が無いこと。門の site はすべて表にあり、表の site はすべて使われていること
- 自己テストの対照（走査がここで書いた本文に対して）：門の外の呼び出し・値としての別名・provider の受領の直呼び・名前空間／動的／別名の import・未分類の名前・表に無い site・使われない site を見つける（陽性）。門の中の同じ呼び出し・読み手・コメントの中の名前は通す（陰性）
- 規則の表駆動：`briefWriteVerdict` の guard × continuity × instance の行（`unknown`・`changed` の行を含む）

### 20.4 Codex 再レビュー 2 回目の P2 の処置

| # | 指摘 | 処置 | 守る条件・対照の試験（反映先） |
|---|---|---|---|
| Codex P2 | §19 で足した死んだ起動の行の片付け（`plan`）が、worktree の継続を証明できなくても（`unknown`）書く。第 1 段の世代・anchor が null のまま本文の解析中に作り直し → 新しい側で instance を起動（X）→ instance の作り直し（Y）→ 第 2 段の固定、のとき X の `pending` 行を `skipped` にする | **直す**（表の行 `plan.dead-row` として。§20.1 の規則） | 陽性：T0f の 2 段の固定と T0g の古い行を組み合わせた上の手順で、古い要求は本文だけ・X の行は `pending` のまま。直しを外すと落ちる／陰性：同じ寿命で入口に行がある（`same`）→ 今どおり `skipped(incarnation_changed)` に片付ける（`session-brief-worktree-lifetime-4224.test.ts` の T0h） |

残る影響（規則から出るもの）：

- 入口で証拠が無く（世代も行も無い）、計画の時点で設定が有効になった `force` の送信は、世代も作らない（以前は作って次の要求に回した）。次の要求の入口が行を見るか、保存された設定から世代を作れば固定される（T5b の陰性はそのまま通る）
- 打鍵の間に worktree が改名・作り直しされたときは、brief を付けた送信でも台帳と provider は `unknown`（受領にしない）

