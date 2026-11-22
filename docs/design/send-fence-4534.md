# 1 回の送信の端末の変更を 1 か所の柵に通す（Issue #4534）設計 第 3 版

- 版: 第 3 版・改 1（2026-11-22）。第 3 版の最初の形は `8da8b15de`。第 2 版は [`send-fence-4534-v2.md`](./send-fence-4534-v2.md)（以下 v2）、第 1 版は `6c495b52b`
- 基準: develop `ad21704ea`。正は Issue #4534 の本文
- 設計だけ。src・既存の試験は変えていない。§4 の試作は未コミットで戻した（差分は worktree の `dev-reports/issue-4534-v3-probe.diff`、gitignore）。「見立て」「未確認」は明記する

**改 1 の処分**（レビュー 2 本: 再現つき P1 2・P2 2・P3 5／読み P2 4・P3 11。全部採った。採らなかったものは無い）

| 指摘 | 処分 | 節 |
|---|---|---|
| 再現 P1-1 `createSession` と G-境の矛盾、`exec` が見えない | 門を変更 1 つずつの直前に。作成は「束」。偽の process は全部の出口を見る | R2・R3、§5 |
| 再現 P1-2 断った札が閉じない | `closed` を別の欄にし、門が最初に見る | R8、T11 |
| 再現 P2-1・読み P3-6 拒否を包む・飲む catch | 所ごとに決めた | §2.2 の表 |
| 再現 P2-2・P3-5、読み P3-7 別名で名前が変わる | 札は三つ組。`ticket-mismatch` は捨てた。検知器は使った名前を足して数える | R10、§2.3 |
| 読み P2-1 門が境界の通知の後 | 通知の中で、hook より先に確かめる | R9、T1・T5 |
| 読み P2-2 G-入口の名前が足りない | 印の 6 層と中間の関数まで広げた。受け持ちの表 | §5 |
| 読み P2-3 PR-A 単独の答え | 通知の抑止と投げ直しを PR-A に。PR-B まで main に出さない | §6 |
| 読み P2-4 guards | 測った（0 本）。台帳は新しいファイル | §4、§5 |
| 再現 P3-1〜P3-4、読み P3-1・P3-2・P3-5 | 検知器の一覧・相乗り・poller・包みの範囲と中身・G-境の定義と読みの一覧 | §2.2〜§2.4、§5、§7 |
| 読み P3-3・P3-4・P3-8〜P3-11 | 札の欄と handle、I1 の読みと入口の外の書き手、試験、触るファイル、数の漏れ | §0、§2、§5、§6 |

## 0. 結論と、人の答え

**形**: 要求ごとの札を AsyncLocalStorage（ALS）で運ぶ。**札が開いている間は、端末を変える 1 つ 1 つの変更の直前（同じ同期の一歩）で門が宛先を確かめる。札が無い・閉じた札なら、門は何もしない（今と同じ動き）。** その session に開いた送信があるのに、札なしで送信だけの層に入ったら投げる（検知器）。argv・呼び出し先・呼び出しの数は変えない。

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
| R3 | 門が宛先を**確かめる**のは、単独の変更と、束（`createSession`）の先頭。束の続きは、先頭の門が返した札を渡して通す（確かめない・断らない） | 作り（札は関数の中の値）＋静的検査（G-印） |
| R4 | 札が無い・閉じているとき、argv・呼び出し先・呼び出しの数は今と同じ | 作り＋既存の試験が緑 |
| R5 | 一致する札の下でも、argv の列は札なしと同じ | 陽性対照（T8） |
| R6 | 入口と取り下げの包みは、`fn` の Promise をそのまま返す | 作り＋既存の試験（挟むと赤。§4） |
| R7 | 断った札は、範囲の中でその先の変更を全部断る。通すのは取り下げの包みの中の打鍵と kill だけ。包みは `fn` が決着すると終わる | 作り＋静的検査（G-印）＋T13 |
| R8 | **`closed` は `refusal` と別の欄で、門が最初に見る**。閉じた札は、断った札でも無いのと同じ。ALS の入れ物は 1 つで、内側の札が勝つ | 作り＋T11 |
| R9 | 境界の通知（`noteInputStart`・`noteDispatchStart`）は、hook より先に確かめる。断ったら hook は走らず、`dispatched` も立たない。柵の拒否は `delivery: 'not-started'` を持つ | 作り＋T1・T5 |
| R10 | 札の宛先は三つ組 `(worktree, instance, tool)`。門は session 名を比べない。検知器だけが名前で数え、札の中で使った名前を足す | 作り＋T-D |
| R11 | 送信の層へ届く production の呼び手は、札を作る入口の中にしか無い | G-入口（静的）＋検知器 |

### 2.2 札・門・入口

- **札**: `requestId`・`target`（三つ組）・`resolvedBy`・`kind`（`resolved`／`timer`。v2 §2.3）・`confirm`・`refusal`・`closed`・`inputStarted`（境界の通知が通った時に立つ）・`names`（検知器の鍵）。PR-B で `conditions`（relay の予約・claim。v2 §2.9）を足す。**入口は札の handle を持ち**、`run` の外の catch でも `refusal`・`inputStarted` を読める（分類の順 1。ツールの包み直しは `cause` を落とす）
- **確かめ**（同期）: 入口が宛先を解くのに使う `resolveSessionTargetStrict` に、解いた結果の `(instance, tool)` を明示して問い直す（要求の options では解き直さない）。conflict なら `tool-changed`。札が `roster` なのに行が無ければ `target-gone`。`getWorktreeById` が空なら `worktree-gone`。例外は `unreadable`。判定は v2 §2.2 と同じ。入口と同じ関数で読む理由は §4
- **門**（`src/lib/session/terminal-fence.ts`、新。import は `node:async_hooks` だけ）:

```
fenceGate(kind, batch?):            // kind: key | kill | create | geometry | env | paste | dispatch
  t = 札（ALS）
  if t が無い or t.closed: return 素通り                       // R4・R8（最初に見る）
  if 取り下げの包みが有効 and kind が key か kill: return 通す   // R7
  if batch があり、その札が t: return batch                     // R3（束の続き）
  if t.refusal: throw t.refusal                                 // R7
  v = t.confirm()   （例外・不一致は t.refusal に置いて throw）
  return { t }                                                  // 束の先頭なら、これを続きへ渡す
fenceConfirm():                     // R9。確かめるだけ。t が無い・closed なら何もしない
```

- **門を置く所**。どれも今の呼び出しの直前に 1 行。関数は包まない

| 所 | 門 | 拒否の扱い |
|---|---|---|
| `tmux.ts` `sendKeys`・`sendSpecialKey`・`clearInputLine`・`clearComposerLine`・`clearComposerPasteToken`・`killSession` | `try` の前 | そのまま |
| `tmux.ts` `sendSpecialKeys` | キーごと（`try` の中） | catch が投げ直す |
| `tmux.ts` `createSession`（束） | `new-session` の前で確かめ、`set-option`・`new-window`・`respawn-pane`・形の直し 2 つは続き | catch が投げ直す（今は包む） |
| `tmux.ts` `reconcileSessionGeometry`（単独で呼ぶとき） | `set-window-option`・`resize-window` それぞれで確かめる | catch が投げ直す（今は飲む） |
| 送信器の `paste-buffer`（`submit-verified-sender.ts:280`） | `try` の前 | そのまま |
| claude の `set-environment`（`claude-session.ts:1018`。`exec`） | 直前 | `startClaudeSession` の catch が投げ直す |
| OpenCode の `resize-window`（`opencode.ts:449–452`・`opencode-v2.ts:284–287`） | `try` の前（今の `try` は飲む） | そのまま |
| OpenCode の `prompt_async`（`opencode.ts:785`。照合先は v2 §2.8） | 直前 | `opencode.ts:811–823` の catch が投げ直す |
| `instance-input-lock.ts` `noteInputStart`・`noteDispatchStart` | 先頭で `fenceConfirm` | そのまま（hook より前） |

- **束にする理由**（事実）: `new-session` の窓 0 は placeholder で、`new-window -k` が入れ替える。間で断ると placeholder だけの session が残り、次の送信が起動行を `sleep` に打つ（v2 §2.7）。作成の間に名簿が動いても作成は終わらせ、次の門で止める
- **入口**（4 つ。送信の層へ届く呼び手はこれだけ。§5 の G-入口の今の 61 行で確かめた）

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
- 送信の launch で起きた Auto-Yes の poller は札を受け継ぐ（`tmux.ts:617` → `auto-yes-poller.ts:1350–1359`）。**範囲の中では送信の札で確かめられ、断られた札なら断られる。範囲が終わると無い（R8）**。G-境の試験は Auto-Yes を止めて流す

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

試作は設計の形そのもの（門は 1 行ずつ）。入口の札は本物の確かめを持つ。

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
| 4 | 静的検査（新しいファイル。既存の走査の helper は変えない） | G-入口は今の呼び手 61 行、G-台帳は 11 行（送信の経路は 3 行）を読み出す。足した呼び手・命令を見つける対照が緑 |
| 5 | 別名が落ちる送信 | 旧い名前で始まり、範囲の中で名前が変わっても起動は断られない。数は両方の名前で 1、閉じると 0。新しい名前で札を失った層は `unticketed` |
| — | 検知器 | 開いた送信が無ければ直呼びは今と同じ。あれば `unticketed`。別の session は影響なし。reject・throw の後に数が戻る。閉じた札の文脈は、別の開いた送信がある間だけ `unticketed` |

**文脈が切れうる所**（最初の形で列挙。読みと grep）: lock の待ち行列・launch の相乗り・listener・timer 類・`Promise.race` の負け側。0 か所。レビューの再現でも、待ち行列と相乗りは切れなかった。

## 5. 試験と検査

足場は §4 の試作と同じ。各試験は同じ fixture の陽性対照を先に通し、後で検知器の数が 0 であることを見る。

**読みの一覧（G-境・G-台帳で共通）**: tmux の `has-session`・`capture-pane`・`display-message`・`list-*`・`show-*`・`-V` は読み。`load-buffer`・`delete-buffer` は buffer だけ。それ以外の tmux の命令は変更。`exec` の行は `tmux <命令>` を同じ表で分ける。tmux 以外の process は端末の変更ではない。`fetch` は GET 以外が変更。

| # | 受入条件・不変条件 | 試験 | 直す前 | 変異 |
|---|---|---|---|---|
| T1 | F1・R9 | 札の後・消去の前に行が消える／tool が変わる → 変更 0。消去の後 → `not-sent`、hook 0 回、carried mark 無し（claude・codex・記録した画面の agy） | 赤 | 消去の門を外す |
| T2 | F2 | copilot `--model`。idle の読みの後 → 変更 0 | 赤 | `sendKeys` の門を外す |
| T3 | F3・R2・R3 | 起動の前 → 変更 0。`new-session` の直後 → 作成だけ終わり、その先 0。拒否が型のまま届く（claude・codex） | 赤 | `set-environment` の門・束の続きの門を外す |
| T4 | I2・R7 | 起動行の後・消去の後に名簿が動く → その先 0 | 赤 | — |
| T5 | F5・R9 | OpenCode。POST 0、境界は通知されない、`not-sent`、キーボードの変更 0。ポートだけが変わる形・2 回目の POST | 赤 | POST の門を外す |
| T6 | 札の無い経路（静的）・R2 | G-入口・G-台帳・G-印。門と spawn の間に `await` が無い | 赤 | 写しに呼び手・命令・`await` を足す |
| T7 | 札の無い経路（実行時） | G-境。入口 4 つ × 代表のツール。起動（claude・codex）を必ず含む | 赤 | 門を 1 つ外す |
| T8 | I4・R5 | 一致する札あり・札なしで、出口の列が同じ。起動を含む | 緑 | ペイン ID |
| T9 | B2 の境界 | spawn 済み・未適用で名簿を変える → 変更 1 件 | — | — |
| T11 | R8 | 断られた送信の後、その launch で起きた poller が打てる。範囲の中では断られる。入れ子は内側の札 | — | `refusal` を先に見る |
| T13 | R7 | 包みの中の打鍵と kill は出て、作成は出ない。包みの後の timer は断られる。呼び手は 3 つ（静的） | — | 包みを終わらせない |
| T-D | 検知器・R10 | 札を失って層に入る → `unticketed`（層ごと）／開いた送信が無い → 今と同じ／別の session／reject・throw・早い return で数が戻る／閉じた札の文脈／別名が落ちる形で起動つきの送信が通り、数が合う | — | — |
| T14〜 | I3・F4（PR-B） | v2 §6.2 の T5・T7・T11 と、T3 の 409 | 赤 | — |

**受入条件 4「札の無い経路を足すと赤」を、何が捕まえるか**

| 足されたもの | 静的（CI） | G-境（実行時・CI） | 検知器（本番） |
|---|---|---|---|
| 入口の外から、送信の層・中間の関数を呼ぶ新しい呼び手 | **G-入口が赤** | — | その session に開いた送信がある間だけ |
| `tmux.ts` の外の、門の無い新しい tmux の変更・POST | **G-台帳が赤** | 試験が通る経路なら赤 | — |
| `tmux.ts` の中の、門の無い新しい変更 | — | 試験が通る経路なら赤。断る札の下で全 export を呼ぶ検査（v2 §5 の G1）も置く | — |
| 入口から門までの間で札を失う作り | — | 試験が通る経路なら赤 | 層の入口より上なら止める |

- **G-境**: 門が通ると「許可」を 1 つ置く。同じ同期の一歩の次の変更が 1 つ使う。使われなければ microtask の境で消える。許可の無い変更が 1 件でもあれば赤。束の続き・取り下げの包みの門も許可を置く。control mode の stdin は process の境に見えないので、G-台帳だけが受け持つ
- **G-入口**（新しい試験のファイル）: `sendUserMessage`・印の 6 層・`sendMessageToClaude` と、メソッド `sendMessage`・`sendMessageWithImage`・`startSession`・`trySendViaServer`・`launchSession`・`launchSessionWithRole`・`requireSession`・`relaunchIfToolExited` の呼び手を「名前 ← ファイル#関数」で固定する（ブラウザの API の同名 2 行は「送信の外」）
- **G-台帳**（新しい試験のファイル。既存の `pane-key-writers.test.ts` は変えない）: `tmux.ts` の外の、打鍵以外の tmux の変更と `prompt_async`。各行は「門あり」か「送信の外」。**G-印**: 印の 6 層・束の続きの門・包みの場所

## 6. PR の割り方（同じファイルなので 1 人のワーカーが直列で）

| 本 | 中身 | 受入条件 |
|---|---|---|
| PR-A 柵の本体（I1・I2・I4） | 札・門・入口 4 つ・取り下げの包み・検知器・境界の通知の確かめ。拒否は型つきで投げ、飲む・包む catch は投げ直す。試行の state は札から決める（reason は今の `send-error`）。**柵の拒否では起動失敗の通知を出さない**（`base.ts:366–376`）。公開の code・exit は足さない | T1〜T9・T11・T13・T-D と既存の試験が緑。直す前の赤と変異の exit を返しに書く。既存の試験の変更は `instance-input-entries-3945.test.ts` の前置きだけ |
| PR-B 理由と公開の契約（I3・F4） | 分類の順を全入口に。409・`sendOutcome`・exit 34・`lastSend.reason`・文書 ja/en。`conditions` | 柵の拒否が route で専用の code になり、予約の喪失の答えと区別できる（直す前は赤）。`send-user-message-input-boundary-3957.test.ts:255–267` を変えずに緑。T14〜 |

- PR-A の src（15）: `terminal-fence.ts`（新）、§2.2 の門の表の 6 ファイル、印の `launch-keys.ts`・`base.ts`・`copilot.ts`、入口の route 2 つ・`relay-delivery.ts`・`timer-manager.ts`、`send-user-message.ts`。PR-B は v2 §8.3 から、DB の貸し出し・ペイン ID の分を除いたもの
- **PR-A だけの間の答え**（公開の値は今のまま。文に `send target changed: <理由>` が入る）: send の起動は 500 `SESSION_START_FAILED` で通知なし。`/model` は今の「モデルの切り替えに失敗」の答え。本文・dispatch・`/terminal` は今の送信失敗の 500。timer・relay は今の失敗の記録と戻し。試行は、本文の前なら `not-sent`、後なら `indeterminate`。送り直しの扱いは誤らない
- **条件**: PR-A を develop に入れた後、PR-B が入るまで main へ出さない
- PR-A は 1 日の見込み（見立て。T7 の足場は未確認）。順: PR-A → PR-B → #4518。#4535 と #4503 PR-B1 は同じファイルなので直列。#4535 と PR-B の値の名前は一緒に決める

## 7. 残る窓・確かめていないこと・別 Issue の候補

| 窓 | 何で閉じられるか | この版 |
|---|---|---|
| spawn の後・tmux が打つ前、または束の間に、同じプロセスが名簿を書く | 書き手を変更の決着まで待たせる（別 Issue） | 閉じない。結果は「変更の後に動いた」と同じ |
| 別プロセスが同じ DB を開く（`db-instance.ts:148–151` の「misconfigured」）・DB の手編集 | どの形でも閉じない | I2 の外 |
| 人が tmux を直に触る。同じ名前でのペインの置き換え | ペイン ID（別 Issue） | 閉じない。今も閉じていない |
| 印の外・層の中で札を失った送信 | G-境（試験が通る経路だけ） | 本番では止まらない（§2.3） |
| 範囲が終わった後に残った送信の処理 | lock を持ち続けている処理の打鍵は、今の `ticket.isCurrent()` が断る。**新しく lock を取る処理は断らない** | 閉じない。今のコードに経路は無い（読み） |

**確かめていないこと**
- T7 の全体（入口 4 つ × ツール）、codex・agy の T1・T3。試作は claude の送信器と起動、copilot の `/model`、OpenCode の送信、送信サービスまで
- OpenCode の照合先と 2 回目の POST、timer と relay の配送の札の確かめ、I3 の分類、PR-A の答え（通知の抑止を含む）。試作に入れていない
- T9・`await` の静的検査・G-印は書いていない。`tests/unit` の残りは流していない

**別 Issue の候補**: 札を引数で運ぶ形（`pane-key-writers.test.ts:47–48` と同じ向き）／名簿の書き手を待たせる／ペイン ID で打つ
