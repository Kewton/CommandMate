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
（欄の削除・意味の変更）ではない。足すのは 2 つの欄だけで、`build`・`reserve`・`settle` の形は変えない（§2.4・§5.3）。

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
| W1 | 1 回の送信の要求は、**1 つの worktree の世代**についての要求である。世代は計画の最初の await の前（instance の寿命を読むのと同じ同期の区間）に固定し、要求に載せる |
| W2 | provider の `build` は、要求に載った世代を `pinned` として使い、自分では固定し直さない。違えば例外（D1 は `provider_failed` で付けない。送信は続く） |
| W3 | 取る区間（`withMemTarget` の同期の callback）で、今の worktree の世代が要求の世代と同じでなければ取らない。行の状態は書かない（行は消えたか、別の世代のもの）。報告の理由は `worktree_changed` |
| W4 | `force` で新しい行を開くのは、W3 を通った後だけ |
| W5 | mode が `off`・`injectOnStart=false` の送信は、世代を**作らない**（今と同じく mem の表を書かない。§4.3 の陰性対照） |

### 2.4 作り［見立て］

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

`instanceOnRoster` は、C の `buildBrief` が要求の instance の世代を照らすとき在籍を `earlier.onRoster`（build の時点の読み）で
補っている（`build.ts:247-252`）のを、要求の時点の値に替えるために足す。D1 の `isSameInstanceLifetime` は在籍も見るので
（D1 設計 §3.7）、要求と build の両方が同じ 2 つの値で照らすことになる。

**D1 の計画（`SendBrief.plan`）**：

1. 最初の await の前に `w0 = getWorktreeIncarnation(db, worktreeId)`（読むだけ、`incarnation.ts:137`）
2. `force` で行が無いとき（P1）は、最初の await の前に `w0 = getOrCreateWorktreeIncarnation(…)`（明示の操作なので作ってよい）
3. `withMemTarget` の callback（同期の区間、`target.ts` の約束）の中で、mode が `derived` / `on` かつ `injectOnStart` のときだけ：
   - 既にある行なら、`getBoundaryById(plan.boundary.id)` が在り、その `worktreeId` が今の `worktreeId` と同じこと（F3・F5：
     行が残っていれば、await の間に削除も改名も無かった）
   - `w1 = getOrCreateWorktreeIncarnation(…)`。`w0 !== null && w1 !== w0` なら付けない（`worktree_changed`）
   - 要求の `worktreeIncarnation = w1`
4. mode が `off`・`injectOnStart=false` なら 3 の作成を通らない（W5）

**C の provider（`src/lib/brief/provider.ts` の `build`）**：`buildBrief` に
`pinned: { worktreeIncarnation: request.target.worktreeIncarnation, instance: { incarnation: request.target.instanceIncarnation, onRoster: request.target.instanceOnRoster } }`
を渡す。既存の照合（`build.ts:240-246`）と組み立ての前の同期の再確認（`assertStillSame`、`build.ts:205-223`）がそのまま効く。

**`buildBrief` の入口の規則**：`input.request` があるのに `input.pinned` が無ければ例外（`BriefMembershipChangedError('worktree_lifetime')`）。
型の上では `pinned` は任意のまま（CLI の route は自分で固定して渡す：`src/lib/brief/service.ts`）にし、試験の書き換えを増やさない。
この規則で、provider の経路を通る**どんな形の呼び出し**（§3 で網羅を広げる対象）でも、固定の無い build は動かない。

**D1 の取る区間（`claimInStretch`）**：所属の照合（`session-brief.ts:367`）の直後に
`getWorktreeIncarnation(db, worktreeId) === plan.worktreeIncarnation` を照らす（W3）。違えば `report = { state: 'skipped', reason: 'worktree_changed' }`
で `null` を返し、`reserve` を呼ばない（予約を作らないので `settle(discarded)` も空の ID で、C は何もしない：`provider.ts:186`）。

### 2.5 対照の試験

試験の置き場：`tests/unit/lib/session/session-brief-worktree-lifetime-4224.test.ts`（新規）。DB は `os.tmpdir()` 配下の
`fs.mkdtempSync`、`afterEach` で削除。作り直しは `deleteWorktreesByIds` ＋ 同じ ID・path で登録し直す（C の `brief-retry-paths-4223.test.ts` の `recreate` と同じ）。

| # | 場面 | 陽性（直す前の実装で落ちる） | 陰性（変わらない動き） |
|---|---|---|---|
| T1 | P1：`force` の計画の後、build の前に作り直す（provider の `build` の最初で作り直す偽の reader） | 送られた本文に brief が無い。台帳に `explicit` の行が無い。B の close・知らせの予約が新しい worktree に 0 件 | 作り直さなければ付く（行 1・`sent`） |
| T2 | P2：既にある行の計画の後、build の前に作り直す | provider の `build` が例外になり（`worktree_lifetime`）、新しい worktree の `mem_close_records` が 0 件 | 作り直さなければ評価の close が 1 回 |
| T3 | P3：build の後、ロックの待ちの間に作り直す（`force`） | 本文だけ。報告は `worktree_changed`。`reserve` が 0 回 | ロックを待っても作り直さなければ付く |
| T4 | P4：計画の後に改名 | 付けない（`worktree_changed` か `target_unresolved`）。新しい ID の行は `pending` のまま、次の送信（新しい ID）に 1 回付く | 改名しなければ付く |
| T5 | W5 | — | mode `off`・`injectOnStart=false` の送信の前後で `mem_worktree_incarnations` の行数が同じ。`never` の送信と打つ本文・記録が同じ |
| T6 | 入口の規則 | `request` があり `pinned` の無い `buildBrief` を直に呼ぶと例外（規則を外した版が落ちる） | CLI の route（`pinned` あり）は今と同じ答え（`brief-retry-paths-4223` が変えずに通る） |

自己対照：T1〜T4 の陽性は「`buildBrief` に `pinned` を渡さない版」「取る区間の照合を外した版」を試験の中で作って落ちることを確かめる
（ファイルは書き換えず、`setBriefProviderForTest` に照合を外した provider を渡す・`vi.spyOn` で照合を外す）。

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
| R4 | 連鎖は「要求の寿命を自分で固定する入口」で止める。止めてよいのは、その入口が**最初の await の前に**固定することを、別の検査で確かめた関数だけ |
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

**(c) 連鎖を止める入口（R4）**：`src/lib/session/session-brief.ts:SendBrief.plan` を「寿命を固定する入口」の表に置き、その先
（`sendUserMessage` とその呼び出し元）へは連鎖を伸ばさない。理由：`SendBrief` は送信 1 回に 1 つ（`send-user-message.ts:355`）で、
`plan` は最初の await の前に台帳・instance の寿命・worktree の世代（§2.4）を読み、送信を繰り返す呼び出し元は**新しい要求**として
読み直すのが正しい（古い要求を運ばない）。止めてよいことは次の 2 つの検査で確かめる：

- 構文：入口の本体で、寿命を読む呼び出し（`readInstanceLifetime`・`getWorktreeIncarnation`／`getOrCreateWorktreeIncarnation`）が最初の `await` より前にある
- 実行：`plan()` を同じ `SendBrief` で 2 回呼ぶと 2 回目は何もしない（実装で入れる柵）

止めた先の網羅は (d) が受け持つ。

**(d) 送信の呼び出し元のガード（R6）**：`session-brief-send-callers-4274.test.ts` の取り出しを、同じ走査の根 `sendUserMessage` に替え、
引数のオブジェクトの `brief` の欄を構文で読む（オブジェクトの字面・スプレッドは「解決できない値」として R2 に）。表の値は今のまま
（route は `body.brief ?? 'auto'`、relay は無し）。Timer は §10 の決定に従う。

**(e) R5 の走査**：根 `pinBriefLifetime` と、§2.4 で provider が `pinned` を組む関数（`provider.ts:build`）の呼び出し元を同じ規則で辿り、
繰り返しの中で固定を作る呼び出し元が 1 つも無いことを表で固定する（今は `service.ts:briefForRoute` がループの前で 1 回だけ）。

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
| C12 | 止める入口（R4） | 入口の本体で寿命の読みを最初の `await` の後へ移したソース → 止める検査が落ちる | 今の `SendBrief.plan` は通る |
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
終わる前の更新を確認できない（最終更新は N 時間前）
```

- 最終更新の記録が無いとき：`終わる前の更新を確認できない（最終更新の記録なし）`
- N は整数の時間（切り捨て）。1 時間未満は `1 時間未満`
- 文言は固定のテンプレート（Epic D1：モデルを呼ばない）。**「更新せずに終わった」「更新を忘れた」とは書かない**（経過時間だけで断定しない）

固定の先頭（5 行、`src/types/brief.ts:54` の `BRIEF_TEXT_FIXED_LINES`）に足さない理由［見立て］：固定の部分の最小値（C 設計 §2.6・I14）と、
組み直しの `dropNoticeLines`（`provider.ts:64-71`：先頭 4 行を固定とみなす）を変えずに済む。データの区画の項目にすれば予算・省略・
`--json` の形を C の規則のまま通る。

### 7.2 いつ出すか

すべて満たすとき（どれかが欠ければ出さない）：

| # | 条件 | 根拠・読み方 |
|---|---|---|
| X1 | mode が `on` | 「最終更新」は手で書く項目（S7・S8）の話で、`derived` では読まない（C 設計 §4） |
| X2 | 今の境界の種類が `launch` か `auto_restart`（プロセスの世代の境界） | reset・resume は会話の操作で、プロセスは終わっていない。`explicit` は境界を知らない（D1 設計 §7.3） |
| X3 | 同じ (worktree, instance) の台帳に、今の行より前の `launch` / `auto_restart` の行がある（前の世代があった） | 台帳の保持の 20 行（D1 設計 §3.2）の中で読む。無ければ「初めての起動」で出さない |
| X4 | 前の世代について「終わる前の更新」の記録が**確認できない** | 読み口 `readPreEndUpdate(db, { worktreeId, instanceId, previousBoundary })` → `'recorded' \| 'not_recorded'`。G・F が書き手になるまでは常に `not_recorded`（§0.1 H2） |

「最終更新」：所属（repository・ブランチ）の手で書く項目のうち、この instance が書いた最後の更新の時刻
（`mem_items.updated_at` の最大。`updated_by_instance` がこの instance、無ければ `origin_instance_id`。状態は問わない：閉じた項目も
「更新」なので数える）。読むだけの SQL を C の情報源の 1 つ（新しい S10 `previous_end`、`src/lib/brief/sources.ts`）に置く。
A のファイル（`mem-db.ts`）は変えない。

### 7.3 順位と予算

- 順位は最上位（新しい順位 0）。予算が足りなければ C の規則どおり後ろの項目から落ち、この行は最後まで残る
- 自由入力を含まない（固定の文と数）ので、出口の検査（C 設計 §3.3）を通しても変わらない
- `--json` では `{ "src": "server", "kind": "previous_end", "state": "unconfirmed", "lastUpdateAt": … }` の 1 項目

### 7.4 対照の試験（C の `brief-invariants.test.ts` の個別の表に I18 として足す）

| # | 陽性 | 陰性 |
|---|---|---|
| X-a | 前の `launch` の行があり、記録が無い → 先頭の項目がこの行。最終更新 3 時間 5 分前 → `3 時間前` | 前の世代が無い（最初の `launch`）→ 出ない |
| X-b | 最終更新の記録が無い → `最終更新の記録なし` | 種類が `reset`・`resume`・`explicit` → 出ない |
| X-c | 文言の検査：「更新せずに」「忘れ」を含む版（72 時間前で断定する版）が落ちる | `derived` → 出ない |
| X-d | 予算 1,024 バイトで項目 40 件 → この行が残り、後ろが落ちる | 読み口が `recorded` を返す偽 → 出ない（G・F が来たときの振る舞いを先に固定） |

---

## 8. (7) 実機の受入（Claude Code・Codex・Command Code）

### 8.1 分け方の規則［見立て］

- **自動の試験**：CommandMate の中の判断（境界の台帳・取る・決着・予算・mode・世代・受領・文言）。画面とフックの入力は fixture で与える。D1・C・D2 の単体・結合の試験
- **UAT**：外のプロセスの振る舞いでしか分からないこと（フックが**いつ**届くか、Agent の画面と transcript に brief が**どう見えるか**、
  Agent が区画を**データとして**扱うか、実際の所要時間）。fixture を作れないか、fixture の正しさそのものを確かめるもの
- UAT で確かめたことは、可能なら fixture として採って自動の試験へ戻す（D1 設計 §10 の U1〜U5 の「fixture を採る」）

### 8.2 UAT に回す項目

隔離の環境（専用の DB・HOME・tmux のソケット・ポート。`docs/user-guide/uat-isolation.md`）で、3 ツールそれぞれ。mode `on`・`injectOnStart=true` のブランチと、
`off` のブランチを 1 つずつ用意する。

| # | 項目 | Claude Code | Codex | Command Code | 判定 |
|---|---|---|---|---|---|
| UAT-1 | 新しい起動 → 1 通目に brief が 1 回、2 通目は本文だけ。利用者の本文が全文届く（48 KiB 近い本文も） | ○ | ○ | ○ | 画面の capture と transcript で本文の全文、台帳の行 `sent` が 1 |
| UAT-2 | reset（`/clear`・`/new`）→ 次の送信に 1 回。reset のコマンドそのものには付かない | `/clear` | `/new`（U2：`SessionStart` の届く時点も記録） | `/clear`（U4） | 同上 |
| UAT-3 | 端末から直接打った reset → 次の付けてよい送信に 1 回（遅れて分かる境界） | ○ | ○（U2） | × 対象外（検出しない。表どおりであることを確かめる） | 台帳の `late` と付いた送信 |
| UAT-4 | resume で会話が変わる → 1 回。同じ会話の resume → 付かない | ○（U1：fixture を採る） | 明示の口（`--with-brief`）だけ | 明示の口だけ | 同上 |
| UAT-5 | プロセスを kill → 次の送信が起動し直す（自動の再起動）→ 1 回、先頭に §7 の行 | ○ | ○ | ○ | 先頭の行の文言 |
| UAT-6 | サーバの再起動 → 再接続の送信に付かない | ○ | ○ | ○ | 台帳 |
| UAT-7 | mode `off` のブランチ → 何も付かず、画面と transcript が今と同じ | ○ | ○ | ○ | 目視と capture の比較 |
| UAT-8 | `--no-brief` は 1 回だけ、`--with-brief` は付く | ○ | ○ | ○ | 台帳・応答の `brief` |
| UAT-9 | 利用者が `SessionStart` に `commandmate brief --session-start` を置いても二重にならない | ○（U-H1） | ○（U-H2） | ○（U-H3） | 会話の文脈に区画が 1 つ |
| UAT-10 | brief が画面の履歴（Claude の transcript からの履歴 #2121、Codex の履歴）に利用者の発言として出るか | ○（U6） | ○ | ○ | 出るなら §8.4 |
| UAT-11 | Agent が区画を命令として読まない（区画の中に「このファイルを消せ」の固定の文を入れた mem の項目） | ○ | ○ | ○ | 指示に従わないこと（D12。保証ではなく観察として記録） |
| UAT-12 | provider の所要時間（所属の解決の git を含む）が 1,700 ms の内か | ○ | ○ | ○ | サーバのログの所要時間（C 設計 U2） |

### 8.3 自動の試験で確かめる項目（UAT に回さない）

同時の初回の送信・送信の拒否・結果不明・ロックの順序・世代の照合（instance・worktree）・予算と #2464 の行数・mode の途中の変化・
受領の写像・連鎖の網羅・フックの判定・先頭の行の条件と文言。D1 設計 §9・C 設計 §7・本書 §2.5・§3.4・§4.3・§5.2・§6.4・§7.4・§9。

### 8.4 UAT の結果で決まる実装（条件つき）

- **UAT-10 で brief が履歴に出る**なら：transcript から履歴を作る読み手（Claude：`src/lib/hooks/sources/claude/transcript.ts` 系、Codex：`src/lib/hooks/sources/codex/history.ts` 系）で、
  利用者のターンの**先頭**が C の区画の形（`<<<cmate-brief:<8 桁の 16 進>` で始まり `cmate-brief:<同じ tag>>>>` の行で閉じ、空行が続く）に
  一致するときだけ、その区画を外して表示する。形が一致しなければ何もしない。DB の `chat_messages` は元から利用者の本文だけ（D1 設計 §4.3）
- **UAT-2/3 の U2・U4** の結果で、D1 設計 §2.2 の表（△）を ○ か × に直す（文書だけ）
- **UAT-12** で 1,700 ms を超えるなら、D1 の打ち切り（2,000 ms、`session-brief.ts:70`）と C の期限を揃え直す（C 設計 §10 の指摘）

---

## 9. (8) 実装の範囲と、全入口の不変条件の表駆動の試験

### 9.1 変えるファイル

| ファイル | 変更 |
|---|---|
| `src/lib/session/brief-provider.ts` | `BriefRequest.target` に `worktreeIncarnation`・`instanceOnRoster`（§2.4）。`getBriefProvider()` の既定を `MEM_BRIEF_PORT`（§4.1） |
| `src/lib/session/session-brief.ts` | 計画で worktree の世代を固定（§2.4 の 1〜4）、取る区間の照合（W3）、報告の理由 `worktree_changed`、`plan()` の 2 回目を何もしない柵（§3.3 (c)） |
| `src/lib/brief/provider.ts` | `MEM_BRIEF_PORT`（§4.1）、`build` が `pinned` を渡す（§2.4） |
| `src/lib/brief/build.ts` | 入口の規則：`request` があって `pinned` が無ければ例外（§2.4） |
| `src/lib/brief/sources.ts`・`src/types/brief.ts`・`src/lib/brief/rank.ts` | S10 `previous_end`・順位 0・`--json` の項目（§7）。読み口 `readPreEndUpdate`（G・F までは `not_recorded`） |
| `src/lib/db/session-brief-db.ts` | 前の世代の行を読む関数（読むだけ、§7.2 X3）。migration は足さない |
| `src/lib/brief/service.ts`・`src/app/api/worktrees/[id]/mem/brief/route.ts`・`src/cli/commands/brief.ts` | `--session-start`（§6.3）。`--help` |
| `src/cli/types/api-responses.ts` | 応答の `brief.reason` に `worktree_changed`（送信の応答の型の写し） |
| `src/lib/timer-manager.ts` | `brief: 'auto'`（§10 の T-2 を PM が許したときだけ） |
| 条件つき | §8.4 の履歴の読み手（UAT-10 の結果による） |
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
| J4 | mode `off`・`injectOnStart=false`・`never` の経路は、打つ本文・記録・応答・`chat_messages` が `never` と同じで、`mem_*` を書かない | §4.3 E2 |
| J5 | worktree・instance を同じ ID で作り直したら、古い要求の brief を付けず、B の予約・受領・評価を新しい側に起こさない | §2.5 T1〜T4、D1 の (a) |
| J6 | 最終本文は #2464 の検証済みの大きさ（48 KiB・240 行）の内。超えるなら brief を外し本文は送る | 予算の境目 |
| J7 | 生成を呼ばない・tmux に届かない（`buildBrief` の連鎖） | C の I9 を D2 の入口（`--session-start`・`MEM_BRIEF_PORT`）にも当てる |
| J8 | `--session-start` と送信の側で、同じ会話に区画が 2 つ入らない（CommandMate の経路の中で） | §6.4 K1 |
| J9 | 先頭の行は §7.2 の条件のときだけ・断定の語を含まない | §7.4 |
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
| transcript から履歴を作る読み手 | Claude・Codex の 2 系統（§8.4、UAT-10 の結果による）。Command Code は transcript の読み手が無い（C の `TRANSCRIPT_READER_TOOLS`、`src/cli/utils/reply-ledger.ts:68`）ので対象外 |

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
| U1〜U6 | D1 設計 §10 の U1（Claude の resume の payload）・U2（Codex の `/new` の `SessionStart` の時点）・U3（Codex の `/clear`）・U4（Command Code の `/clear`・resume）・U5（Claude の `/clear` の別名）・U6（履歴への出方） | 境界の表・§8.4 | UAT-2〜4・UAT-10 |
| U-T1 | C の 1,700 ms が実機で足りるか（C 設計 U2） | 付かない頻度 | UAT-12 |
| U-T2 | §10 の T-1c の数 | 実装の契約の scope | 実装の契約で既定を替えて走らせる |
| U-X1 | 「終わる前の更新」の記録を G・F がどの表に書くか | §7 の読み口の実装 | G（#4227）・F（#4226）の設計。D2 は読み口の形だけ決め、`not_recorded` を返す |
