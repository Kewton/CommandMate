# 1 回の送信の端末の変更を 1 か所の柵に通す（Issue #4534）設計 第 3 版

- 版: 第 3 版・改 3（2026-11-22。人の決定「A2」）。第 3 版の最初の形は `8da8b15de`、改 2 は `aaa6d2a62`。第 2 版は [`send-fence-4534-v2.md`](./send-fence-4534-v2.md)（以下 v2）、第 1 版は `6c495b52b`
- 基準: develop `ad21704ea`。正は Issue #4534 の本文
- 設計だけ。src・既存の試験は変えていない。§4 の試作は未コミットで戻した（差分は worktree の `dev-reports/issue-4534-v3-probe.diff`、gitignore）。「見立て」「未確認」は明記する

**改 3 の処分**（人の決定 A2: 形は変えない。**静的検査が完全だとは約束しない**。改 2 への再確認 r3 の 2 本が、「赤になる」と書いた行のうち 2 つを事実と違うと示した。改 2 の表は `aaa6d2a62`）

| 指摘 | 処分 | 節 |
|---|---|---|
| r3 P2: `export *` の連鎖を通る呼び手は赤にならない（2 本とも） | 表を「赤になると確かめた書き方」だけに直し、直しを PR-A の受入条件にした（試験が先） | §5、§6 |
| r3 P2: 入口の中で値として取り出して呼ぶ形・別の `.run(` の中の呼び出しは赤にならない | 同上 | §5、§6 |
| r3 P3（輪・除く表・入口がメソッド・同名のメソッド・R11 の文・束の受け持ち） | 小さい 3 つは PR-A で直す。残りは静的検査の限界として名指し | §2.1、§5 |
| r2・r3 の、この種類の外の P3 | 追随した（要約の文・OpenCode の `not-sent`・入口ごとの確かめ・貼り付けの門・本文の残り・poller・分類の順・src の一覧・main へ出す条件・測っていない範囲・別の session） | §0、§2.2、§2.4、§4〜§7 |

## 0. 結論と、人の答え

**形**: 要求ごとの札を AsyncLocalStorage（ALS）で運ぶ。**札が開いている間は、端末を変える 1 つ 1 つの変更の直前（同じ同期の一歩）に門がある。門が宛先を確かめるのは、単独の変更と束の先頭（束の続きと取り下げの包みの中は確かめない。R3・R7）。札が無い・閉じた札なら、門は何もしない（今と同じ動き）。** その session に開いた送信があるのに、札なしで送信だけの層に入ったら投げる（検知器）。argv・呼び出し先・呼び出しの数は変えない。

**I1 の読み**: 「札の無い変更は通さない」は、**送信の要求が行う変更についての約束**と読む（Issue は札を「送信の要求ごと」と定義し、F1〜F5 は全部送信の経路）。入口の外の書き手（§2.4）は札が無い＝今と同じ。

| # | 問い | 人の答え（11-22） | この文書 |
|---|---|---|---|
| B1 | I1 をどこで守るか | **(b)** 検査に加えて、session ごとの検知器。既存の試験 1 ファイル 2 本（`instance-input-entries-3945.test.ts`）への前置きを許可。期待値は変えない | §2.3 |
| B2 | I2 の時点 | 発行の時点 | §3、T9 |
| B3 | 公開の契約 | 新しい 409 `SEND_TARGET_CHANGED`・exit 34 | PR-B（v2 §3.3 の案 b） |
| B4 | 取り下げ | 3 か所だけ通す | R7、§2.2 |
| B5 | Issue の列挙に無い変更 | 入れる（作成・形の直し・グローバル環境・kill） | §2.2 |
| B6 | 割り方 | PR 2 本 | §6 |

## 1. 前の形がなぜ落ちたか

- **第 1 版**: 札が無ければ素通り。札を失った送信を見分けられない。断った札を範囲の後も粘らせ、札を受け継いだ Auto-Yes の poller を断り続けた
- **第 2 版**: 送信だけの層の印の下で、札が無ければ常に投げた。既存の試験 134 本（14 ファイル）が赤。DB の貸し出しは作れず、ペイン ID は argv を変えた。宣言・切り離し・後始末の規則が書き切れなかった。候補（試験用の札の前置き・`tmux.ts` への寄せ・武装）も I4 に触れた
- **第 3 版の最初の形（`8da8b15de`）**: 断った札が閉じなかった（第 1 版と同じ失敗）。`createSession` は門 1 回で残りを通し、「変更の直前に門」と境の照合が成り立たなかった。本文の門が境界の通知の後にあり、断った送信が `indeterminate` になった

衝突は 2 つで、別物だった。C1: I1 を「送信の層で札が無ければ常に投げる」で守ること × I4（134 本は全部これ）。C2: I2 を実変更の時点まで閉じること（ペイン ID）× I4。C1 は検知器（開いた送信がある session でだけ投げる）で、C2 は B2（発行の時点）で避ける。

## 2. 形と規則

### 2.1 不変条件

| # | 不変条件 | 何で守るか |
|---|---|---|
| R1 | 開いた札の中の変更は、必ず門を通る | 作り＋G-境（実行時）＋G-台帳（静的） |
| R2 | 門は変更 **1 つずつ**の直前にある。門と spawn・fetch の間に `await` が無い。例外は無い | 作り＋G-境（1 対 1）＋T6 |
| R3 | **INV-束**: 確かめるのは、単独の変更と束の先頭。束の札は束の先頭の門でだけ作られ、束が終わると失効する。単独の門は何も返さない（型が違う）。札は `tmux.ts` の `createSession` と非公開の関数の間だけを渡り、公開の options・signature を越えない。束に入れてよいのは、1 回の `createSession` の中の、その session を作る手順で、途中で止めると placeholder だけの session が残るもの | 型＋G-印＋T12 |
| R4 | 札が無い・閉じているとき、argv・呼び出し先・呼び出しの数は今と同じ | 作り＋既存の試験が緑 |
| R5 | 一致する札の下でも、argv の列は札なしと同じ | 陽性対照（T8） |
| R6 | 入口と取り下げの包みは、`fn` の Promise をそのまま返す | 作り＋既存の試験（挟むと赤。§4） |
| R7 | 断った札は、範囲の中でその先の変更を全部断る。通すのは取り下げの包みの中の打鍵と kill だけ。包みは `fn` が決着すると終わる | 作り＋静的検査（G-印）＋T13 |
| R8 | **`closed` は `refusal` と別の欄で、門が最初に見る**。閉じた札は、断った札でも無いのと同じ。ALS の入れ物は 1 つで、内側の札が勝つ | 作り＋T11 |
| R9 | 境界の通知（`noteInputStart`・`noteDispatchStart`）は、hook より先に確かめる。断ったら hook は走らず、`dispatched` も立たない。柵の拒否は `delivery: 'not-started'` を持つ | 作り＋T1・T5 |
| R10 | 札の宛先は三つ組 `(worktree, instance, tool)`。門は session 名を比べない。検知器だけが名前で数え、札の中で使った名前を足す | 作り＋T-D |
| R11 | **INV-閉包**: 印（`enterSendLayer`）へ届く production の関数の集合は閉じている。集合の外から中を呼べるのは、札を開く入口だけで、それも札の下で走らせる関数の中だけ。集合は検査が自分で作る（名前の一覧を持たない）。門を持つ `tmux.ts` の関数は集合の外（入口の外の書き手も呼ぶ。§2.4） | 検知器（本番）＋G-閉包（**補助**。見る書き方は §5 の表だけ） |

### 2.2 札・門・入口

- **札**: `requestId`・`target`（三つ組）・`resolvedBy`・`kind`（`resolved`／`timer`。v2 §2.3）・`confirm`・`refusal`・`closed`・`bodyStarted`（`noteInputStart` が通った時に立つ）・`dispatchUnknown`（`noteDispatchStart` が通った時に立ち、その dispatch が `not_sent` と決着したら落とす〔`noteDispatchFailed` が `not_sent` を受けた時。呼ぶ所は `opencode.ts:707`。札への記録は、`instance-input-lock.ts:1011` の observer の有無の判定より前に置く〕。v2 §3.2 と同じ分け方。試作は 1 つの欄 `inputStarted` で、POST が断られた後のキーボードの退路で断ると `indeterminate` になる＝読み）・`names`（検知器の鍵）。PR-B で `conditions`（relay の予約・claim。v2 §2.9）を足す。**入口は札の handle を持ち**、`run` の外の catch でも `refusal`・`bodyStarted`・`dispatchUnknown` を読める（分類の順 1。ツールの包み直しは `cause` を落とす）。**順 1 は自分の札だけを、閉じる前に読む**。自分の札に `refusal` があれば、捕まえた例外が別の文でも柵の拒否として分類する（範囲の中で札を受け継いだ poller が先に断った場合を含む。宛先が変わった事実を優先し、元の例外は log に残す）。相乗りの launch で他人の拒否を受けた要求は、自分の札に `refusal` が無いので今の分類に入る（v2 §3.2 の順 4）
- **確かめ**（同期。入口ごと。どれも `getWorktreeById` が空なら `worktree-gone`、例外は `unreadable`）

| 入口 | 確かめ | 試作 |
|---|---|---|
| send の route・`/terminal` | 入口が宛先を解くのに使う `resolveSessionTargetStrict` に、解いた結果の `(instance, tool)` を明示して問い直す（要求の options では解き直さない）。conflict なら `tool-changed`。札が `roster` なのに行が無ければ `target-gone`。判定は v2 §2.2 と同じ。入口と同じ関数で読む理由は §4 | ある |
| relay の配送 | `tryResolveRelayDeliveryTarget(db, relay.from)`（`relay-session-ref.ts:111`）を読み直す。`null` なら `target-gone`、`(instanceId, cliToolId)` が違えば `tool-changed`。札は claim の直前の strict の解決（`resolvedBy` を含む）から作る（v2 §2.2・§2.3） | **無い**（試作の札は `resolvedBy` を持たず、`target-gone` を出さない） |
| timer | worktree の行がある・timer の行が今も `sending`・その instance に別の tool の名簿の行が無い（v2 §2.3。timer は解決の関数を使わない。`timer-manager.ts:120–146`） | **無い** |

- **門**（`src/lib/session/terminal-fence.ts`、新。import は `node:async_hooks` だけ）:

```
fenceGate(kind): void               // 単独の変更。key | kill | geometry | env | paste | dispatch
  t = 札（ALS）
  if t が無い or t.closed: return                               // R4・R8（最初に見る）
  if 取り下げの包みが有効 and kind が key か kill: return        // R7
  if t.refusal: throw t.refusal                                 // R7
  t.confirm()   （例外・不一致は t.refusal に置いて throw）
fenceBatchOpen('create'): FenceBatch // 束の先頭。同じに確かめ、束の札を返す
fenceBatchStep(batch): void          // 束の続き。確かめない・断らない。札でない値・失効した札・別の送信の札は誤用で投げる
fenceBatchEnd(batch)                 // createSession の finally
fenceConfirm(): void                 // R9。確かめるだけ
```

- **門を置く所**。どれも今の呼び出しの直前に 1 行。関数は包まない

| 所 | 門 | 拒否の扱い |
|---|---|---|
| `tmux.ts` `sendKeys`・`sendSpecialKey`・`clearInputLine`・`clearComposerLine`・`clearComposerPasteToken`・`killSession` | `try` の前 | そのまま |
| `tmux.ts` `sendSpecialKeys` | キーごと（`try` の中） | catch が投げ直す |
| `tmux.ts` `createSession`（束） | `new-session` の前が先頭。`set-option`・`new-window`・`respawn-pane`・形の直し 2 つは続き。`finally` で終える | catch が投げ直す（今は包む） |
| `tmux.ts` `reconcileSessionGeometry`（公開。中身は非公開の `reconcileGeometry` へ） | 2 つの変更それぞれで確かめる。束の札を受ける口は無い | catch が投げ直す（今は飲む） |
| 送信器の `paste-buffer`（`submit-verified-sender.ts:280`） | `noteInputStart()`（`:274`）の次の行。buffer を消す `try`（`:272–278`）の中。試作は `try` の後ろ（`:279` の前）に置いていた | catch が buffer を捨てて投げ直す（今の境界の拒否と同じ）。直前の `noteInputStart` の確かめと同じ同期の一歩なので、この門だけが断ることは無い（読み） |
| claude の `set-environment`（`claude-session.ts:1018`。`exec`） | 直前 | `startClaudeSession` の catch が投げ直す |
| OpenCode の `resize-window`（`opencode.ts:449–452`・`opencode-v2.ts:284–287`） | `try` の前（今の `try` は飲む） | そのまま |
| OpenCode の `prompt_async`（`opencode.ts:785`。照合先は v2 §2.8） | 直前 | `opencode.ts:811–823` の catch が投げ直す |
| `instance-input-lock.ts` `noteInputStart`・`noteDispatchStart` | 先頭で `fenceConfirm` | そのまま（hook より前） |

- **束にする理由**（事実）: `new-session` の窓 0 は placeholder で、`new-window -k` が入れ替える。間で断ると placeholder だけの session が残り、次の送信が起動行を `sleep` に打つ（v2 §2.7）。作成の間に名簿が動いても作成は終わらせ、次の門で止める
- **入口**（4 つ。送信の層へ届く呼び手はこれだけ。§5 の G-閉包が今の木で確かめた）

| 入口 | 範囲 |
|---|---|
| send の route | `startSessionForSend`（`send/route.ts:454`）と `sendUserMessage`（`:508`）を、同じ札で別々に `run`。札は `handleSend` の `finally` で閉じる。`handleSend` ごとは包まない（§4） |
| relay の配送 | `sendUserMessage`（`relay-delivery.ts:663`） |
| `/terminal` のコマンド送信 | `cliTool.sendMessage`（`terminal/route.ts:246`） |
| timer | `sendUserMessage`（`timer-manager.ts:141`） |

- **取り下げの包み** `asRetraction(fn)`。呼ぶ所は 3 つ: `withdrawUnsentBody` の中の消去（`submit-verified-sender.ts:329`・`:332`）、置き換えの消去（`:894`）、#4115 の役違いの kill の closure（`base.ts:417` の `kill:` だけ。`:413` の `launchSession` は包まない）。中で通るのは、打鍵（`C-e`・`C-u`、ツールの `killSession` が打つ `/exit`・`/quit`・`C-c`・Enter）と `kill-session`。作成・貼り付け・dispatch は通らない。包みの中で予約した timer は、包みが終わった後は断られる
- **v2 から持ち越す**: I3 の分類の順・入口ごとの表・409 の `sendOutcome`（§3.2〜§3.4。PR-B）、OpenCode の照合先（§2.8）、relay の両端（§2.9）、相乗りの launch の拒否の扱い（§2.3）。**外した**: 「送信の外」の宣言・切り離しの一覧・DB の貸し出し・ペイン ID・`tmux.ts` への寄せ・`ticket-mismatch`

### 2.3 検知器（B1 (b)）

- **規則**: 入口は、札を開くときに「開いた送信の数」を tmux の名前（`resolveSessionName`）で 1 増やし、閉じるときに減らす（`globalThis`）。送信だけの層は、入るときに同期で 1 行確かめる。**開いた札が ALS に無く、その名前の数が 1 以上なら `FenceMisuseError('unticketed')`**。数が 0 なら何もしない。札つきで層に入った名前が札に無ければ、その名前も数える（#2866 の別名が落ちた後の名前を拾う）
- **印の層（6 つ）**: `sendMessageWithSubmitVerification`・`typeLaunchLines`・`createLaunchPane`（`base.ts:926`）・`startClaudeSession`・`sendModelCommand`（`copilot.ts:1070`）・`dispatchViaServer`（`opencode.ts:718`）
- **検知器でも止まらない変更**: (1) 印の外: 再利用するペインの形の直し（`base.ts:452`）、OpenCode の `resize-window`（v1・v2）、起動中の画面への答え（`codex.ts:354` ほか）、claude の送信前の案内への答え（`claude-session.ts:1183`）、copilot の選択の一覧（`copilot.ts:936–963`）、#4115 の kill（`base.ts:417`）(2) 層に入った後で札を失った変更 (3) 範囲が終わった後の変更 (4) 取り下げの包みの中の変更。claude の健康でないペインの kill（`claude-session.ts:752–758`）は `startClaudeSession` の中なので止まる
- **残るもの**: 別名が落ちた後、新しい名前で層に入る前に札を失うと見逃す。最初の呼び手が起動を待たずに範囲を終えると（今のコードに経路は無い）、閉じた札の文脈で続く起動の本体に相乗りした送信が、理由 `unticketed` の起動の失敗を受ける

### 2.4 入口の外の書き手（札が無い＝今と同じ。門は何もしない）

- Auto-Yes・respond・prompt-response・plan review の答え（`prompt-answer-sender.ts`）、special-keys・clear-composer・interrupt・kill-session の route、worktree の削除（どれも `tmux.ts` の関数か HTTP）
- 人の直接のキー（`sendDirectInputAndInvalidate` `tmux.ts:1393`、control mode の stdin `tmux-control-client.ts:129`。どちらも門なし）
- OpenCode のセッション操作の route、起動時の名前の付け直し（`renameSession` `tmux.ts:1056`）、状態の poll（`session-hooks.ts`・`session-status-options.ts`）、schedule（別の process）
- どれも印の層に入らないので、開いた送信があっても `unticketed` にならない
- 送信の launch で起きた Auto-Yes の poller は札を受け継ぐ（`tmux.ts:617` → `auto-yes-poller.ts:1350–1359`）。**範囲の中では送信の札で確かめられ、断られた札なら断られる。範囲が終わると無い（R8）**。範囲の中の拒否は poller のエラー 1 回として数えられ、バックオフが伸びる（`auto-yes-poller.ts:225–249`。止まるのは 20 回続いたとき `auto-yes-config.ts:59`。範囲は短いので止まり続けない＝読み）。G-境の試験は Auto-Yes を止めて流す

## 3. 捨てた形

| 形 | 既存の試験の赤 | 捨てた理由 |
|---|---|---|
| 第 2 版（印の下で常に投げる） | 134 本・14 ファイル | C1。印の外は残る |
| B1 (a) 検査だけで守る | 0 本 | 人の答え。本番で札を失った送信が止まらない |
| `createSession` の変更ごとに確かめる | — | 途中で断ると、作りかけの session を消す kill が要る。断った札の下で通す 4 つ目の場所になる（B4 は 3 か所） |
| `ticket-mismatch`（門が session 名を比べる） | — | 別名が落ちると、正しい起動つきの送信を断る。送信が別の session を打つ経路は見つからない |
| 札を引数で運ぶ／ペイン ID／DB の貸し出し／武装 | 下限 5 本／0 本（札の下の argv は変わる）／未測定 | 9 ツールの関数の形が変わる／C2／同期の書き手を待たせられない／構成で柵の強さが変わる |

**I2 を発行の時点で読む（B2）**: 確かめから spawn までは同期で、同じプロセスの名簿の書き手は割り込めない（`tmux.ts:23`・`:663–692`、`submit-verified-sender.ts:201–212`）。名簿の書き込みは端末に触れず（`src/app/api/worktrees/[id]/route.ts:337–366`）、session 名は tool を含む（`session-name.ts:142–151`）ので、spawn の後に名簿が動いた結果は「正当な変更の後に動いた」と同じ（見立て）。束は先頭の時点。境界は T9 で固定する。

## 4. 測定（試作は未コミット。測った後に戻した）

試作は設計の形そのもの（門は 1 行ずつ）。入口の札は本物の確かめを持つ。**改 3 で設計が試作と違う所**（どれも試作に無い。PR-A で書く）: 札の欄を 2 つに分ける・貼り付けの門を `try` の中へ・relay と timer の確かめ・G-境の宛先の確かめ・(f)〜(k) の直し。

**既存の試験**（`npx vitest run <範囲> --maxWorkers=4`）

| 範囲 | 形 | exit | 赤 |
|---|---|---|---|
| `tests/unit/cli-tools tests/unit/lib/session tests/unit/lib/relay tests/unit/relay tests/unit/api tests/integration`（7,974 本） | 第 2 版（段 2a） | 1 | 134 本・14 ファイル |
| `tests/unit/cli-tools tests/unit/lib tests/unit/relay tests/unit/api tests/unit/app tests/unit/tmux tests/unit/session tests/unit/polling tests/integration`（1,409 ファイル・27,461 本） | 改 1 の形（検知器あり） | 1 | **2 本・1 ファイル**（`instance-input-entries-3945.test.ts`。人が前置きを許した 2 本） |
| `tests/unit/guards`（既存 63 ファイル） | 改 1 の形 | 0 | **0 本**（新しい src のファイルを git に見せた状態でも） |

- 赤の 2 本は、`/terminal` の route と札なしの `sendUserMessage` の直呼びを同じ session に並べる。直呼びを試験用の札で包むと（+4／−2 行。期待値は変えない）8 本とも緑
- **形の選び方で赤になった例**（直して上の数）: 入口の包みに `await`・`finally` を挟む → `relay-delivery.test.ts` の 4 本。`handleSend` ごと closure で包む → `brief-call-chain-forms-4224.test.ts` の 1 本。確かめを生の SQL で読む／入口で `session-name` の別の関数を使う → 3945 のファイルがさらに 2 本（DB と `session-name` を偽にしている）。R6、route の形、確かめの読み方、検知器の鍵はこのため
- **既存の試験が入口の札の下で届く門は、境界の通知の確かめ（R9）だけ**。ほかの門には届かない（最初の形で記録して 0 行）。「赤 2 本」が示すのは R4 と、R9 が今の試験の宛先を通すことまで。R5 は新しい陽性対照でしか確かめられない
- 流していないもの: `tests/unit` の残り、e2e、verify、precheck

**試作の試験**（22 本、全部緑。柵から送信サービス・ドライバまで本物。偽は process の境〔`execFile`・`exec`・`spawn`・同期版・`fetch`〕と OpenCode のポートの読み）

| # | 確かめたこと | 結果（事実） |
|---|---|---|
| 1 | 断った札が閉じる（T11） | 送信の launch で予約した poller の tick は、範囲の中では断られ、範囲の後は打てる。**変異: `refusal` を `closed` より先に見る → 赤** |
| 1 | 取り下げの包み | 包みの中で予約した timer は、包みが返った後は断られる。包みの中の作成は断られる。**変異: 包みを終わらせない → 赤** |
| 2 | 起動の経路の G-境（本物の `startClaudeSession`） | 変更 8 件（作成の 5 つ・`exec` の `set-environment`・起動行 2 つ）が全部、直前の門と 1 対 1。札なしの同じ起動は出口の列が同じ。**変異: `set-environment` の門／束の続きの門を外す → 赤** |
| 2 | `new-session` の直後に行が消える | 作成の 5 つは終わり、その先は 0。拒否は `createSession` と claude の catch を越えて型のまま届く。起動の前なら変更 0 |
| 3 | 打鍵・貼り付け・送信サービス | 消去の後に行が消える → 変更は消去だけ、境界の hook 0 回、carried mark 無し、拒否は `not-started`、記録は `not-sent`。貼り付けは buffer を捨てる。本文の後に断ると `indeterminate` |
| 3 | OpenCode（F5） | POST 0。dispatch の境界は通知されず、失敗の verdict も立たず、キーボードへ切り替えない。対照は POST 1 件で門と 1 対 1 |
| — | F2（copilot の `/model`） | idle の読みの後に tool が変わると変更 0。対照は 1 件 |
| 4 | 静的検査（新しいファイル。既存の走査の helper は変えない） | G-閉包・G-印・G-台帳。結果は §5 の表 |
| 5 | 別名が落ちる送信 | 旧い名前で始まり、範囲の中で名前が変わっても起動は断られない。数は両方の名前で 1、閉じると 0。新しい名前で札を失った層は `unticketed` |
| — | 検知器 | 開いた送信が無ければ直呼びは今と同じ。あれば `unticketed`。別の session は影響なし。reject・throw の後に数が戻る。閉じた札の文脈は、別の開いた送信がある間だけ `unticketed` |

**文脈が切れうる所**（最初の形で列挙。読みと grep）: lock の待ち行列・launch の相乗り・listener・timer 類・`Promise.race` の負け側。0 か所。レビューの再現でも、待ち行列と相乗りは切れなかった。

## 5. 試験と検査

足場は §4 の試作と同じ。各試験は同じ fixture の陽性対照を先に通し、後で検知器の数が 0 であることを見る。

**読みの一覧（G-境・G-台帳で共通）**: tmux の `has-session`・`capture-pane`・`display-message`・`list-*`・`show-*`・`-V` は読み。`load-buffer`・`delete-buffer` は buffer だけ。ほかの tmux の命令は変更。`exec` の行は `tmux <命令>` で分ける。tmux 以外の process は対象外。`fetch` は GET 以外が変更。

| # | 受入条件・不変条件 | 試験 | 直す前 | 変異 |
|---|---|---|---|---|
| T1 | F1・R9 | 札の後・消去の前に行が消える／tool が変わる → 変更 0。消去の後 → `not-sent`、hook 0 回、carried mark 無し（claude・codex・記録した画面の agy） | 赤 | 消去の門を外す |
| T2 | F2 | copilot `--model`。idle の読みの後 → 変更 0 | 赤 | `sendKeys` の門を外す |
| T3 | F3・R2・R3 | 起動の前 → 変更 0。`new-session` の直後 → 作成だけ終わり、その先 0。拒否が型のまま届く（claude・codex） | 赤 | `set-environment` の門・束の続きの門を外す |
| T4 | I2・R7 | 起動行の後・消去の後に名簿が動く → その先 0 | 赤 | — |
| T5 | F5・R9 | OpenCode。POST 0、境界は通知されない、`not-sent`、キーボードの変更 0。ポートだけが変わる形・2 回目の POST。POST が断られた（`rejected`）後のキーボードの退路で断る → `not-sent`（`dispatchUnknown` が落ちる） | 赤 | POST の門を外す |
| T6 | 札の無い経路（静的。補助）・R2・R11 | G-閉包・G-台帳・G-印。門と spawn の間に `await` が無い | 赤 | 下の「確かめた書き方」と (f)〜(k)。写しに命令・`await` |
| T12 | R3 | 単独の門の戻り・失効した札・別の送信の札では続きを呼べない | — | 下の (d)(e) |
| T7 | 札の無い経路（実行時。主） | G-境。入口 4 つ × 代表のツール。起動（claude・codex）を必ず含む。変更の宛先の session が札の `names` にある | 赤 | 門を 1 つ外す |
| T8 | I4・R5 | 一致する札あり・札なしで、出口の列が同じ。起動を含む | 緑 | ペイン ID |
| T9 | B2 の境界 | spawn 済み・未適用で名簿を変える → 変更 1 件 | — | — |
| T11 | R8 | 断られた送信の後、その launch で起きた poller が打てる。範囲の中では断られる。入れ子は内側の札 | — | `refusal` を先に見る |
| T13 | R7 | 包みの中の打鍵と kill は出て、作成は出ない。包みの後の timer は断られる。呼び手は 3 つ（静的） | — | 包みを終わらせない |
| T-D | 検知器・R10 | 札を失って層に入る → `unticketed`（層ごと）／開いた送信が無い → 今と同じ／別の session／reject・throw・早い return で数が戻る／閉じた札の文脈／別名が落ちる形で起動つきの送信が通り、数が合う | — | — |
| T14〜 | I3・F4（PR-B） | v2 §6.2 の T5・T7・T11 と、T3 の 409 | 赤 | — |

**受入条件 4「札の無い経路を足すと赤」の受け持ち**（改 3。Issue の受入条件は「静的または実行時の検査」。静的検査は補助で、完全だとは約束しない）

| 足されたもの | 受け持ち | 位置づけと範囲 |
|---|---|---|
| 入口 4 つの経路の中の、門の無い変更（tmux・`exec`・`fetch`） | G-境（実行時の照合） | **主**。試験が通る経路だけ。起動で門を外すと赤（試作）。`tmux.ts` の中に門の無い変更を足す形・送信の経路の新しい POST は流していない（未確認） |
| 札を失って、または札なしで、印の層に入る | 検知器（本番でも動く） | **主**。その session に開いた送信がある間だけ。層の入口より上で札を失うと `unticketed`（試作） |
| 束の札の誤用: (d) 単独の門の戻りを取っておき、断られた後に続きへ渡す／(e) 束が終わった後の札・別の送信の札で続きを呼ぶ／束の札を別の所で作る・export された関数が受ける・公開の options に載せる・別の関数で続きを呼ぶ | 型（`tsc` が exit 2）・実行時（`not-a-batch`・`batch-ended`・`batch-of-another-send`。変更 0）・G-印 | **主**。試作が全部赤（設計者と r3 の再現） |
| 入口の外から、印の層とその上の関数を呼ぶ新しい呼び手 | G-閉包（静的） | **補助**。下の「確かめた書き方」だけ。見ない書き方で足された呼び手を、試験の時点で赤にする検査は無い（本番では検知器が、開いた送信がある間だけ止める） |
| 印を通らずに `tmux.ts` の打鍵の関数を直に呼ぶ新しい書き手 | 既存の `pane-key-writers.test.ts` の台帳（変えない） | G-閉包の外。新しい参照は今も赤（r3 の読み） |
| `tmux.ts` の外の、打鍵以外の tmux の変更と `prompt_async` | G-台帳（静的） | 補助。HTTP は `prompt_async` だけ |

**G-閉包が赤にすると確かめた書き方**（試作 v5。設計者と r3 の再現のレビューが別々に流した）

| 書き方 | 規則 |
|---|---|
| (a)(b) 入口の外の新しい名前つきの関数が、名前つきの import と素の呼び出しで `sendMessageToSession`／`startSessionForSend` を呼ぶ。実際に src に置いても赤 | R-root |
| (c) 印の層を包む新しい中間の関数を足し（名前はどこにも書かない）、入口の外（`setInterval`）から呼ぶ | R-root |
| モジュールの直下から呼ぶ／名前つきの re-export（`export { x as y } from …`）／`export default` | R-module |
| 入口の中の、札の下でない所に、素の呼び出し（`sendUserMessage(`）を書く | R-run |
| 文字列の literal の `tool()['sendMessage'](…)` | 赤（r3 の再現 F2） |

**今は赤にならない書き方。PR-A で、陽性対照の試験を先に書いてから検査を直す**（(f)〜(h) は人の決定 A2 の条件。(i)〜(k) は同じ検査の小さい直しで、同じ PR に入れる。どれも今の木に該当は 0）

| # | 書き方 | 今の検査の答え | 直す向き |
|---|---|---|---|
| (f) | `export *` の連鎖（2 段）を通して import して呼ぶ | 違反 0 件（r3 F7。2 本とも指摘） | `export *` を再 export として扱う。集合の module を `export *` する所を R-module にするか、import を定義までたどる |
| (g) | 入口の中で値として取り出して呼ぶ（`const early = sendUserMessage; await early(…)`） | 0 件（r3 F4） | R-run は、入口の中の識別子の参照を全部見る（callee に限らない） |
| (h) | 入口の中で、別の `AsyncLocalStorage` の `.run(…)` の中から呼ぶ | 0 件（r3 F5） | 「札の下」を、`openSendTicket(` の戻りを受けた変数の `.run(` と、`runWithSendTicket(` の第 2 引数に限る |
| (i) | 互いに参照し合う関数の輪（外に根が無い） | 0 件（r3 F14） | 「集合の各関数は、呼び手をたどって入口に着く」を規則にする（R-root はその特別な場合） |
| (j) | 除く表（同じ名前の別物）の関数に、本物の呼び出しを足す | 0 件（r3 F10） | 除く行を `{site, member, receiver}` にする（`worktreeApi.sendMessage` だけ） |
| (k) | 入口をクラスのメソッドにする | R-run が黙って効かない（r3 の読み。流していない） | 入口ごとに、札の下の呼び出しを 1 つも見つけなければ赤 |

**静的検査の限界**（直さない。今の木に該当は 0。r3 の 2 本が別々に grep した）

- 集合のメソッドを、呼ばずに値として扱う: `.bind`・`.call`・`.apply`・コールバックで渡す・分割代入（r3 F1・F3・F3b が 0 件）
- 名前が変数の `tool[name]()`、`Reflect`・`Proxy`
- 集合のメソッドと同じ名前の新しいメソッドを、上の見えない呼び方だけで呼ぶ（メソッドは名前でたどるので、入口の中の同名の呼び出しが呼び手に数えられる）
- 札の下の関数の中で予約し、札が閉じた後に走る処理（字句では札の下。r3 F6。§7 の「範囲が終わった後」の窓と同じ）
- (h) を直した後も、札の変数や関数を別の名前へ移してから使う形（データの流れは 1 段しか見ない。見立て）

**PR-A のレビューでの等級**（A2 の読み）: 上の限界の中の新しい見えない書き方は、今の木に実在しなければ P3（この一覧に足す）。「赤になる」と書いた書き方（確かめた表と、直した後の (f)〜(k)）が赤にならなければ P2 以上で、人へ「札を引数で運ぶ形」の判断を返す。

- **G-閉包**（新しい試験のファイル。補助）: 印（`enterSendLayer`）を持つ関数から始め、集合の中の関数を参照する関数を、入口（札を開く関数）に当たるまで足す。入口でないのに誰からも参照されない関数（R-root）、モジュールの直下・名前つきの re-export（R-module）、入口の中の札の下でない所の呼び出し（R-run）は赤。自由関数は参照で、メソッドは名前でたどる（広め）。「札の下か」は字句で見る。同じ名前の別物（ブラウザの `worktreeApi.sendMessage` の 2 行）は理由つきで除く。見る書き方・見ない書き方は上の表。**今の木: 印 6・入口 4（どれも自由関数）・集合 44 関数、赤 0。44 関数は全部、呼び手をたどると入口に着く（r3 の再現）**
- **G-印**（同）: **今の木: 束の札を作る所 1（`createSession`）、受け取る非公開の関数 2（`respawnLoginShell`・`reconcileGeometry`）、続きの門 5、公開の signature・options・`tmux.ts` の外は 0**。取り下げの包みの 3 か所も同じ走査で固定する（書いていない）。静的に許すのは、`tmux.ts` の中で `FenceBatch` 型の引数を持つ関数と、その中の名前の無い関数。その外へ出た札は実行時の `batch-ended` が止める（札が開いている間だけ。閉じた後は今と同じ）。束の中の `await` は全部 `DEFAULT_TIMEOUT` つきで、`finally` は必ず来る（r3 の読み）
- **G-境**: 門が通ると「許可」を 1 つ置き、同じ同期の一歩の次の変更が使う（使われなければ microtask の境で消える）。許可の無い変更があれば赤。束の続き（有効な札だけ）・包みの門も許可を置く。偽の process は、変更の宛先の session 名が札の `names` にあることも見る（札の下で別の session を変えても、門と今の照合は気づかない＝r2 の再現 N5。門には戻さない。`ticket-mismatch` は捨てたまま。試作に無い）。control mode の stdin は G-台帳だけが受け持つ
- **G-台帳**（同。既存の `pane-key-writers.test.ts` は変えない）: `tmux.ts` の外の、打鍵以外の tmux の変更と `prompt_async`。各行は「門あり」か「送信の外」

## 6. PR の割り方（同じファイルなので 1 人のワーカーが直列で）

| 本 | 中身 | 受入条件 |
|---|---|---|
| PR-A 柵の本体（I1・I2・I4） | 札・門・入口 4 つ・取り下げの包み・検知器・境界の通知の確かめ。拒否は型つきで投げ、飲む・包む catch は投げ直す。試行の state は札から決める（reason は今の `send-error`）。**柵の拒否では起動失敗の通知を出さない**（`base.ts:366–376`）。公開の code・exit は足さない | T1〜T9・T11〜T13・T-D と既存の試験が緑。§5 の「確かめた書き方」と (d)(e) が赤になること、直す前の赤、変異の exit を返しに書く。**(f)〜(k) は、陽性対照の試験（「この書き方を足すと検査が違反を返す」）を先にコミットし、検査を直す前はその試験が落ちる（違反 0 件）ことを示してから、検査を直して通す**。既存の試験の変更は `instance-input-entries-3945.test.ts` の前置きだけ（測った範囲は §4） |
| PR-B 理由と公開の契約（I3・F4） | 分類の順を全入口に。409・`sendOutcome`・exit 34・`lastSend.reason`・文書 ja/en。`conditions` | 柵の拒否が route で専用の code になり、予約の喪失の答えと区別できる（直す前は赤）。`send-user-message-input-boundary-3957.test.ts:255–267` を変えずに緑。T14〜 |

- PR-A の src（16）: `terminal-fence.ts`（新。import は `node:async_hooks` だけ）、`send-target-names.ts`（新。札の材料＝確かめと名前。DB・解決・`session-name` を読む）、§2.2 の門の表の 6 ファイル、印の `launch-keys.ts`・`base.ts`・`copilot.ts`、入口の route 2 つ・`relay-delivery.ts`・`timer-manager.ts`、`send-user-message.ts`。PR-B は v2 §8.3 から、DB の貸し出し・ペイン ID の分を除いたもの
- **PR-A だけの間の答え**（公開の値は今のまま。文に `send target changed: <理由>` が入る）: send の起動は 500 `SESSION_START_FAILED` で通知なし。`/model` は今の「モデルの切り替えに失敗」の答え。本文・dispatch・`/terminal` は今の送信失敗の 500。timer・relay は今の失敗の記録と戻し。試行は、`bodyStarted` も `dispatchUnknown` も立っていなければ `not-sent`、どちらかが立っていれば `indeterminate`。送り直しの扱いは誤らない
- **条件**（公開の契約をそろえるため。安全を担う条件ではない。PR-A だけが出ても、上の答えのとおり誤った送り直しは起きない）: PR-A を develop に入れた後、PR-B が入るまで main へ出さない。守る仕組みは今は無い（`/release` と `docs/release-guide.md` に、develop の特定の変更を止める手順は無い。r2 の grep）。PR-A の本文と #4534 のコメントに書き、リリースを決める人と PM が持つ。先に別のリリースが要るときは、PR-A を一緒に出すか戻すかを人が決める
- PR-A は 1 日の見込み（見立て。T7 の足場は未確認）。順: PR-A → PR-B → #4518。#4535 と #4503 PR-B1 は同じファイルなので直列。#4535 と PR-B の値の名前は一緒に決める

## 7. 残る窓・確かめていないこと・別 Issue の候補

| 窓 | 何で閉じられるか | この版 |
|---|---|---|
| spawn の後・tmux が打つ前、または束の間に、同じプロセスが名簿を書く | 書き手を変更の決着まで待たせる（別 Issue） | 閉じない。結果は「変更の後に動いた」と同じ |
| 別プロセスが同じ DB を開く（`db-instance.ts:148–151` の「misconfigured」）・DB の手編集 | どの形でも閉じない | I2 の外 |
| 人が tmux を直に触る。同じ名前でのペインの置き換え | ペイン ID（別 Issue） | 閉じない。今も閉じていない |
| 印の外・層の中で札を失った送信 | G-境（試験が通る経路だけ） | 本番では止まらない（§2.3） |
| 本文の後（Enter の門）で断った送信の本文 | 取り下げの場所を足す（B4 は 3 か所。足すなら人の判断） | 残す。`indeterminate`。取り下げは走らず、本文は入力欄に残る。`clearBeforeSend` の無いツールでは、次の送信の本文の頭に付く（r2 の読み） |
| 範囲が終わった後に残った送信の処理 | lock を持ち続けている処理の打鍵は、今の `ticket.isCurrent()` が断る。**新しく lock を取る処理は断らない** | 閉じない。今のコードに経路は無い（読み） |

**確かめていないこと**
- T7 の全体（入口 4 つ × ツール）、codex・agy の T1・T3。試作は claude の送信器と起動、copilot の `/model`、OpenCode の送信、送信サービスまで
- OpenCode の照合先と 2 回目の POST、timer と relay の配送の札の確かめ（§2.2 の表）、`bodyStarted`・`dispatchUnknown` の分け方、貼り付けの門の置き直し、G-境の宛先の確かめ、I3 の分類、PR-A の答え（通知の抑止を含む）。試作に入れていない
- (f)〜(k) の直し。今の検査の答え（0 件）は r3 の再現。直した後の検査は書いていない
- T9・`await` の静的検査・G-印の包みの分は書いていない。`tests/unit` の残りは流していない

**別 Issue の候補**: 札を引数で運ぶ形（`pane-key-writers.test.ts:47–48` と同じ向き。PR-A のレビューで「赤になる」と書いた書き方が赤にならなければ、人へこの形の判断を返す）／名簿の書き手を待たせる／ペイン ID で打つ
