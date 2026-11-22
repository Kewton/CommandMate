# 1 回の送信の端末の変更を 1 か所の柵に通す（Issue #4534）設計 第 3 版

- 版: 第 3 版（2026-11-22）。設計し直し。第 2 版は [`send-fence-4534-v2.md`](./send-fence-4534-v2.md)（以下 v2。段 2a の測定つき）、第 1 版は `6c495b52b`
- 基準: develop `ad21704ea`（`b59565b28` までに src の差は無い）。正は Issue #4534 の本文（F1〜F5・I1〜I4・受入条件）
- 段: 設計だけ。src・既存の試験は変えていない。§4 の試作は未コミットで戻した
- 書き方: 「事実」は読んだ行か測った結果。「見立て」「未確認」は明記する

## 0. 結論と、人が決めること

**形**: 要求ごとの札を AsyncLocalStorage（ALS）で運ぶ。**札が開いている間は、端末を変える関数の中の門が、変更と同じ同期の一歩で宛先を確かめる。札が無い・範囲が終わった札なら、門は何もしない（今と同じ動き）。** 札の無い経路は検査で赤にする（入口の台帳＋偽の process の境での照合）。argv・呼び出し先・呼び出しの数は変えない。

**I1 の括弧書き「fail-closed」と、I2 の時点は、読みを人に聞いている最中。** 答えはまだ無い。問いは `workspace/orchestration/runs/2026-11-22/s10/redesign-questions-4432a-4534.md` の B1〜B6。この文書は下の「前提」で書いた。別の答えなら右の節だけが変わる。

| # | 問い | この文書の前提 | 別の答えで変わる節 |
|---|---|---|---|
| B1 | I1 をどこで守るか | **未決。リーダーの推奨 (a) 検査で守る／PM の意見 (b) 検知器を足す。** §2.3 に両方を書いた | (a)→§2.3 の (b) の段を消す。(b)→印 6 つ・検知器・試験 3 本・既存の試験 1 ファイルの前置き。(c)→既存の試験 14 ファイルの前置きと、切り離しの一覧（v2 §2.6） |
| B2 | I2 の時点 | (a) 発行の時点 | (b)(c) は別 Issue（§7）。この文書は変わらない |
| B3 | 公開の契約 | (b) 409 `SEND_TARGET_CHANGED`・exit 34 | (a)→PR-B の code・exit・文（v2 §3.3） |
| B4 | 取り下げを通すか | (a) 3 か所だけ通す | (b)→R6 と包みを消し、残るものを §7 に足す |
| B5 | Issue の列挙に無い変更 | (a) 入れる（作成・形の直し・グローバル環境・kill） | (b)→門が 5 つ減り、照合の「読み」に足す |
| B6 | 割り方 | (a) PR 2 本 | (b)→§6 を 1 本に |

## 1. 前の形がなぜ落ちたか

- **第 1 版**: 札が無ければ素通り。「送信ではない書き手」と「札を失った送信」を見分けられない。断った札を範囲の後も粘らせ、札を受け継いだ Auto-Yes の poller を断り続ける。門の箇所は表で数え、漏れの検査は表と同じ語の grep だった。
- **第 2 版**: 送信だけの層 6 つに印を付け、印の下で札が無ければ投げた。印は札と同じ ALS にあるので、印の外の変更は素通りのまま。投げる規則は既存の試験を赤にした。I2 のために足した DB の貸し出しは作れず、ペイン ID は argv を変えた。「送信の外」の宣言・切り離しの一覧・後始末の許可は、規則が書き切れなかった。
- **段 2a の試作（赤 134 本・14 ファイル）**: 赤は全部 `tmux.ts` の外の 3 つの門から出た。原因は門の位置ではなく「札が無いと投げる」規則。既存の単体の試験は、入口を通らずに送信の層を直に呼ぶ（例 `tests/unit/cli-tools/submit-verified-sender.test.ts:547`）。
- **候補 (i) 試験用の札の前置き**: 14 ファイル約 100 行。I4 の字句に触れる。**(iii) `tmux.ts` への寄せ**: mock の factory に新しい export が無く、argv を確かめる 18 本は期待値まで変わる。**(iv) 武装**: 試験と本番で柵の強さが変わる。

衝突は 2 つで、別物だった（PM の読み「I2 と I4 が両立しない」は C2 だけに当たる）。

| # | 衝突する組 | どの構成で | 避け方 |
|---|---|---|---|
| C1 | I1 を実行時に投げて守る × I4「既存の送信器の試験を変えずに緑」 | 送信の層で札が無ければ投げる。134 本は全部これ | B1 の読み。受入条件は「静的**または**実行時の検査」 |
| C2 | I2 を実変更の時点まで閉じる × I4「今と同じ操作の並び」 | ペイン ID（`tmux.ts:60–61` の打ち先が変わる） | B2 の読み。発行の時点なら argv は変わらない |
| C3 | I2 を実変更の時点まで閉じる × 作れるか | DB の貸し出し。名簿の書き手は同期のトランザクションの中（`agent-instances-db.ts:274`、`src/app/api/worktrees/[id]/route.ts:337–340`） | 採らない |
| C4 | 門を `tmux.ts` に寄せる × I4 | `tmux.ts` を factory で mock する試験は 216 ファイル | 寄せない。今の場所に門を 1 行 |

## 2. 形と規則

### 2.1 不変条件（R1〜R8）

| # | 不変条件 | 何で守るか |
|---|---|---|
| R1 | 開いた札の中で、その札の session を変える変更は、必ず門を通る | 作り（門は変更の関数の中）＋実行時の照合（§5 G-境）＋静的検査（G-台帳） |
| R2 | 門の確かめと、spawn・fetch の呼び出しは同じ同期の一歩。間に `await` が無い | 作り＋静的検査（門と呼び出しの間の `await` を探す） |
| R3 | 札が無い・閉じているとき、argv・呼び出し先・呼び出しの数は今と同じ | 作り（門は何もしない）＋既存の試験が無変更で緑 |
| R4 | 一致する札の下でも、argv の列は札なしと同じ | 陽性対照（T8） |
| R5 | 入口は `fn` の Promise をそのまま返す。`await`・`finally` を挟まない | 作り＋既存の試験（挟むと `relay-delivery.test.ts` の 4 本が赤。§4） |
| R6 | 断った札は、範囲の中でその先の変更を全部断る。通すのは取り下げの 3 か所だけ | 作り＋静的検査（包みの呼び手の一覧）＋試験（T4・T13） |
| R7 | 閉じた札は、無いのと同じ。ALS の入れ物は 1 つで、内側の札が勝つ | 作り |
| R8 | 送信の層へ届く production の呼び手は、札を作る入口の中にしか無い | 静的検査（G-入口） |

### 2.2 札・門・入口

- **札**: `requestId`・宛先 `(worktreeId, instanceId, cliToolId)`・`resolvedBy`・`sessionName`・`state`（`open`→`refused`／`closed`）・`refusal`（型つき。`cause` を持つ）・`inputStarted`・`dispatchUnknown`。v2 §2.2 から `changes`・`created`・`paneId` を外した
- **確かめ**（同期。比べ方は v2 §2.2 のまま）: worktree の行がある。`resolvedBy` が `roster` なら名簿の行があり tool が同じ。それ以外は、その instance に別の tool の行が無い。読めなければ `unreadable`
- **門**（`src/lib/session/terminal-fence.ts`、新）:

```
fenceGate(op):                       // op = { sessionName? , what }
  t = 札（ALS）
  if t が無い or t.state == closed: return            // R3・R7
  if 取り下げの包みの中: return                         // R6。確かめない
  if t.state == refused: throw t.refusal               // R6
  if op.sessionName があり t.sessionName と違う: refuse(FenceMisuseError('ticket-mismatch'))
  v = t.confirm()   （例外は refuse('unreadable', cause)）
  if v が不一致: refuse(SendTargetChangedError(v))     // 札に置いて throw
```

- **門を置く所**（B5 が (a) の前提）。どれも今の呼び出しの直前に 1 行。`try` の外に置くか、catch が柵の拒否を包まずに投げ直す（試作で `sendSpecialKeys` の catch が `TmuxSendError` に包んだ。§4）

| 所 | 関数 |
|---|---|
| `src/lib/tmux/tmux.ts` | `sendKeys`・`sendSpecialKeys`（キーごと）・`sendSpecialKey`・`clearInputLine`・`clearComposerLine`・`clearComposerPasteToken`・`reconcileSessionGeometry`・`killSession`・`createSession`（`new-session` の前に 1 回。関数の中の残りは同じ変更として通す。途中で断ると placeholder だけが残るため。v2 §2.7） |
| `tmux.ts` の外 | 送信器の `paste-buffer`（`submit-verified-sender.ts:280`）、claude の `set-environment`（`claude-session.ts:1018`）、OpenCode の `resize-window`（`opencode.ts:449–452`・`opencode-v2.ts:284–287`）、`prompt_async` の POST（`opencode.ts:785`。照合先は v2 §2.8 のまま） |

- **入口**（札を作る所は 4 つ。事実: 送信の層へ届く production の呼び手はこれだけ。`grep` で確かめた）

| 入口 | 範囲 |
|---|---|
| send の route | `startSessionForSend`（`send/route.ts:454`）と `sendUserMessage`（`:508`）を、同じ札で別々に `run` する。間の処理は端末を変えない。札は `handleSend` の `finally` で閉じる。`handleSend` ごとは包まない（§4） |
| relay の配送 | `sendUserMessage`（`relay-delivery.ts:663`） |
| `/terminal` のコマンド送信 | `cliTool.sendMessage`（`terminal/route.ts:246`） |
| timer | `sendUserMessage`（`timer-manager.ts:141`）。確かめは v2 §2.3 の `timer` |

- **取り下げの包み**（B4 が (a) の前提）: `asRetraction(fn)`。呼ぶ所は 3 つに固定する。`withdrawUnsentBody`（`submit-verified-sender.ts:323–336`）、置き換えの消去（`:893–894`）、#4115 の役違いの agent の kill（`base.ts:413–419`）。「この要求が入れたものを戻す」所に字句で置き、帳簿は持たない
- **I3**: 分類の順・入口ごとの表・`cause`・409 の `sendOutcome` は v2 §3.2〜§3.4 のまま。試作でも、ツールの包み直しは `cause` を落とした（§4）。分類は札の `refusal` を先に読む
- **v2 から持ち越す**: OpenCode の照合先（§2.8）、relay の両端・予約・claim（§2.9）、相乗りの launch の拒否の扱い（§2.3）。**外す**: 「送信の外」の宣言・切り離しの一覧・DB の貸し出し・ペイン ID・`tmux.ts` への寄せ

### 2.3 札が無いときの扱い（B1。未決。両方を書く）

**共通（(a) でも (b) でも同じ）**: R1〜R8。札を失った送信を見つける検査は 2 つ。G-入口（札を作らない入口を足すと赤）と G-境（札の下の実送信で、札つきの門を通らない変更があると赤）。

**(a) 検査で守る（リーダーの推奨）**
- 規則: 上の共通だけ。印も検知器も作らない
- 既存の試験: 0 ファイルの変更（§4）
- 残るもの: 本番で、試験が通らない経路で札を失った送信は、門が何もしないので止まらない
- 推す理由: 札が切れる所は今のコードに見つからなかった（§4 の 3）。新しく入れば G-境が CI で赤にする。仕組みが 1 つで済む

**(b) (a) に検知器を足す（PM の意見）**
- 規則: 入口は、札を開くときに `sessionName` ごとの「開いた送信の数」を 1 増やし、閉じるときに減らす（`globalThis`。ALS ではない）。送信だけの層は、入るときに同期で確かめる。**開いた札が ALS に無く、その session の数が 1 以上なら `FenceMisuseError('unticketed')`**。数が 0 なら何もしない（入口を通らない単体の試験の呼び方）
- 印を付ける層（6 つ。production では入口からしか呼ばれない。§4 の 3）: `sendMessageWithSubmitVerification`（`submit-verified-sender.ts:706`）・`typeLaunchLines`（`launch-keys.ts:39`）・`createLaunchPane`（`base.ts:926`）・`startClaudeSession`（`claude-session.ts:897`）・`sendModelCommand`（`copilot.ts:1070`）・`dispatchViaServer`（`opencode.ts:718`）
- **検知器でも止まらない変更**: (1) 印の外の変更（形の直し `base.ts:452`・`opencode.ts:449–452`、起動中の画面への答え `codex.ts:354` ほか、`claude-session.ts:1183`、`copilot.ts:936–963`、kill `claude-session.ts:752–758`）(2) 層に入った後で札を失った変更 (3) 範囲が終わった後の変更。(b) が (a) より多く止めるのは「層の入口より上で札を失い、範囲がまだ開いている送信」だけ
- 既存の試験: 2 本・1 ファイル（`tests/unit/session/instance-input-entries-3945.test.ts`）に前置きが要る。§4。札を作る入口と、札なしの `sendUserMessage` の直呼びを、同じ session に並べる試験だけが当たる
- 増える試験: T-D1 開いた札の中から `AsyncLocalStorage.exit` で層を呼ぶと、変更 0 で `unticketed`（層ごと）／T-D2 開いた送信が無い session では、札なしの直呼びが今と同じ argv／T-D3 別の session の開いた送信は影響しない／印の層の一覧の固定
- PR-A の受入条件の差分: (b) なら「T-D1〜T-D3 が緑」「既存の試験の変更は §4 の 1 ファイルだけ」を足す。(a) の「既存の試験のファイルを 1 つも変えない」は外す

## 3. 比べた形と、捨てた理由

| 形 | 中身 | 既存の試験の赤（§4） | 判定 |
|---|---|---|---|
| 第 2 版 | ALS＋印の下で札が無ければ投げる | 134 本・14 ファイル（段 2a） | 捨てる。C1。印の外は残る |
| **この版 (a)** | ALS。開いた札の中だけ門が確かめる | **0 本** | B1 (a) |
| この版 (b) | (a)＋session ごとの検知器 | 2 本・1 ファイル | B1 (b) |
| 札を引数で運ぶ | 入口から門まで札を引数で渡す | 下限 5 本・1 ファイル。必須の引数にすると、送信器を直に呼ぶ試験の型も直す（`tests/**` は `tsc` の対象） | 捨てる。任意の引数なら渡し忘れは静的検査でしか見つからず、9 ツールの関数の形だけが変わる。別 Issue の候補 |
| ペイン ID で打つ | 札の下で `-t %id` | 0 本。ただし札の下の argv が変わり、R4 の対照が赤（試作） | 捨てる。C2。`=name:`（今の active なペイン）と意味も違う |
| DB の貸し出し／武装／spawn を 1 モジュールに集める | — | 未測定 | 捨てる。順に C3／構成で柵の強さが変わる／`promisify(execFile)` を持つ全モジュールを書き換える |

**I2 を発行の時点で読む理由（B2 (a)）**
- 事実: 確かめから spawn までは同期（`tmux.ts:23`、`sendKeys` `:663–692`、`submit-verified-sender.ts:201–212`）。同じプロセスの名簿の書き手は割り込めない
- 事実: 名簿の書き込みは端末に触れない（`src/app/api/worktrees/[id]/route.ts:337–366`。kill は別の要求）。session 名は `(tool, worktree, instance)` から決まる（`session-name.ts:142–151`）ので、tool が変わった instance の新しいペインには、古い名前への打鍵は届かない
- 見立て: spawn の後・tmux が打つ前に名簿が動いた場合の結果は、「正当な変更の後に名簿が動いた」と同じ。次の門で止まる
- 事実: 入力の lock も同じ時点で守っている（打鍵の直前の `ticket.isCurrent()`）。境界は T9 で固定する

## 4. 測定（試作は未コミット。測った後に戻した）

試作: `terminal-fence.ts` を §2 の規則で書き、門・入口・取り下げの包み・検知器を入れた。入口の札は本物の確かめ（DB の行の読み）を持つ。差分は worktree の `dev-reports/issue-4534-v3-probe.diff`（gitignore）。

**既存の試験の赤**（`npx vitest run <範囲> --maxWorkers=4`）

| 範囲 | 形 | exit | 赤 |
|---|---|---|---|
| 範囲 1: `tests/unit/cli-tools tests/unit/lib/session tests/unit/lib/relay tests/unit/relay tests/unit/api tests/integration`（7,974 本） | 第 2 版（段 2a） | 1 | 134 本・14 ファイル |
| 同 | (a) | 0 | 0 本 |
| 同 | 札を引数で運ぶ（下限） | 1 | 5 本・1 ファイル（`send-user-message.test.ts`） |
| 同 | ペイン ID | 0 | 0 本 |
| 範囲 2: `tests/unit/lib tests/unit/app tests/unit/tmux tests/unit/session tests/unit/polling`（21,234 本） | (a) | 0 | 0 本 |
| 同 | (b) の process 全体の版 | 1 | 2 本・1 ファイル（`tests/unit/session/instance-input-entries-3945.test.ts`） |
| 合わせた範囲（範囲 1＋範囲 2、1,409 ファイル・27,461 本）。門に `killSession`、取り下げの包み、route を §2.2 の形にした版 | (b) の session ごとの版 | 1 | **2 本・1 ファイル**（process 全体の版と同じ 2 本） |
| 同 | (a) | — | **0 本**（導いた値。(b) は (a) に投げる規則を足しただけなので、(a) の赤は (b) の赤の中にしか無い。その 1 ファイルと `tests/unit/lib/brief` を (a) で流して緑。合わせた範囲を (a) で通しては流していない） |

- (b) の 2 本は、`/terminal` の route（札を作る入口）と札なしの `sendUserMessage` の直呼びを、同じ session に並べる試験。直呼びを試験用の札で包むと（2 か所＋import 1 行。期待値は変えない）8 本とも緑（確かめた）
- 入口の形で赤になった 2 例（直して 0 本）: 包みに `await`・`finally` を挟むと `tests/unit/lib/relay/relay-delivery.test.ts` の 4 本（microtask の順）。`handleSend` の呼び出しごと closure で包むと `tests/unit/lib/brief/brief-call-chain-forms-4224.test.ts` の 1 本（呼び出しの形の台帳が「繰り返しうる呼び方」と読む）。R5 と §2.2 の形はこのため
- **既存の試験には、入口の札の下で本物の門まで届く経路が 1 本も無い**（門が札つきで通るたびに記録して流した。既存の試験からの記録は 0 行）。だから「0 本」が示すのは R3 まで。R4 は新しい陽性対照でしか確かめられない
- 流していないもの: `tests/unit` の残り（components・hooks・cli・db・guards ほか）、e2e、`commandmate verify`、precheck

**先に確かめた 4 点**（試作の試験 13 本。本物: 柵・`tmux.ts`・lock・`composer-clear`・送信器・`launch-keys`・copilot と OpenCode のドライバ。偽: `child_process`・`fetch`・OpenCode のポートと購読の読み）

| # | 確かめたこと | 結果（事実） |
|---|---|---|
| — | F1（消去の前）・F3（`typeLaunchLines`）。前回の試作 | どちらも変更 0。F1 は `SEND_TARGET_CHANGED` が型のまま届く。変更の後に名簿が動くと、その先は 0 |
| 1 | **F2: copilot の `/model`**（本物の `CopilotTool.sendModelCommand`） | idle の読みの後に tool が変わる → 変更 0。対照は `/model <id>` が 1 件。投げられるのは `Failed to switch Copilot model …`（`code` だけ残り `cause` は無い） |
| 2 | **F5: OpenCode**（本物の `OpenCodeTool.sendMessage`、`fetch` を偽に） | 行が消えていると POST 0・キーボードへの切り替えの変更 0。対照は POST 1・変更 0。門の拒否は `opencode.ts:811–823` の catch に飲まれたが、断った札が次の変更を断った |
| 3 | 札を失う経路 | 下の表。見つからなかった（読みと grep。実行での網羅ではない） |
| 4 | 取り下げの 3 か所 | 断った札の下で、包みの中の `C-u` と `kill-session` は出て、包みの外の 4 つの変更は断られた。本物の送信器で、貼り付けの後に行が消え本文が載らなかったとき、`C-e C-u` が出て Enter は出ない |
| — | 変異と対照 | 消去の門を外すと F1 と境の照合が赤。札あり・札なしの argv の列は同じ（ペイン ID の下では赤） |

**3 の列挙: 入口から門までで、ALS の文脈が切れうる所**

| 所 | 行 | 切れるか |
|---|---|---|
| lock の待ち行列 | `instance-input-lock.ts:465–502`（解放した側が `admit` を呼ぶ） | 切れない。待ち手は `await acquire()` の続きで、自分の文脈に戻る（第 1 版の codex のレビューが再現で確かめた） |
| launch の相乗り | `session-launch-flight.ts:228–281` | 切れない。launch の本体は最初の呼び手の文脈で走り（`:276`）、相乗りは Promise を待つ。最初の呼び手は必ず入口の中（`startSession(` の呼び手は `send-session-start.ts:98–105` と `base.ts:800` だけ） |
| イベントの listener | 端末を書く 39 ファイルのうち、登録するのは `antigravity.ts:341–356`（`agy agent` の子 process。callback は Promise を決着させるだけ）と `control-mode-tmux-transport.ts`（人の入力。送信の経路ではない） | 切れない |
| `notifyTmuxSessionCreated` | `tmux.ts:617` → `auto-yes-poller.ts:1350–1359` | 切れるのではなく、送信の札を poller が受け継ぐ。範囲の後は閉じた札＝無いのと同じ（R7） |
| timer・`setImmediate`・`nextTick`・`queueMicrotask`・Worker・`setInterval` | 送信の経路の 31 ファイル | `setTimeout` は `await` の待ちだけ（文脈を保つ）。ほかは 0 件 |
| `Promise.race` の負け側 | `prompt-wait-dialog.ts:96`・`submit-verified-sender-lock.ts:33`・`claude-auto-default-nudge.ts:62`・`session-brief.ts:454` | 負け側は読みか、端末に触れない |
| 待たずに始める処理 | `base.ts:1077`（hook の URL の確かめ。読み）・`send-user-message.ts:910`（`startPolling`） | 端末を変えない。poller は範囲の後 |

B1 への材料: 切れる所は 0 か所で、(a) を支える。ただし「読みで見つからない」は「無い」の証明ではない。(b) が足すのは、層の入口より上（入口 → `sendUserMessage` → `cliTool.sendMessage` → 層の `await` の連なり）で切れた場合の実行時の停止。

## 5. 試験の一覧（PR-A で先に書き、直す前の赤を確かめる）

足場: 柵・`tmux.ts`・lock・送信器・ドライバは本物。偽は `child_process`（argv を全部記録。読みの命令以外は「変更」）と `fetch`。各試験は同じ fixture の陽性対照を先に通す。

| # | 受入条件・不変条件 | 試験（案） | 直す前 | 変異 |
|---|---|---|---|---|
| T1 | F1 | 札の後・消去の前に行が消える／tool が変わる → 変更 0（claude・codex・agy は記録した画面） | 赤（消去・本文・Enter が出る） | M1: 門を消去の後へ → 赤 |
| T2 | F2 | copilot `--model`。idle の読みの後に行が消える → 変更 0 | 赤（`/model` が出る） | M1 |
| T3 | F3 | 起動の中で行が消える → 作成・`set-environment`・起動行が 0（claude・codex） | 赤 | M1 |
| T4 | I2・R6 | 起動行の後・消去の後に名簿が動く → その先 0 | 赤 | — |
| T5 | F5 | OpenCode。POST 0・キーボードの変更 0。割当のポートだけが変わる形も | 赤 | 門を外す → 赤 |
| T6 | 札の無い経路（静的）: G-入口・G-台帳 | 下 | 赤（入口が無い） | 写しに門の無い命令・札の無い入口を足す → 赤 |
| T7 | 札の無い経路（実行時）: G-境 | 下 | 赤（門が無い） | 門を 1 つ外す → 赤 |
| T8 | I4・R4 | 一致する札あり・札なしで argv と HTTP の列が同じ（claude・codex・copilot `--model`・OpenCode）。札なしの列は直す前に記録して固定 | 緑（対照） | ペイン ID → 赤 |
| T9 | B2 の境界 | 偽の tmux を spawn 済み・未適用で止めて名簿を変える → 変更 1 件 | — | — |
| T10 | R3・R5 | 既存の試験を無変更で流す（§4 の範囲） | 緑 | 入口に `await` を挟む → 4 本赤 |
| T11 | R7 | 送信の launch で起きた Auto-Yes の poller が、断られた送信の後も答える。入れ子の送信は内側の札で確かめる | — | 閉じた札を断る → 赤 |
| T12 | R2 | 門と spawn の間に `await` が無い（静的） | — | 写しに `await` を挟む → 赤 |
| T13 | R6（B4） | §4 の 4 の 2 本。包みの呼び手が 3 つだけ（静的） | — | 包みを外す → 取り下げが出ない |
| T14〜 | I3・F4（PR-B） | v2 §6.2 の T5・T7・T11 と、T3 の 409・通知 0 件 | 赤 | — |

- **G-境（実行時の照合）**: 偽の process は、変更の命令を受けるたびに「直前の同期の一歩で、開いた札の門が通ったか」を見る。札の下の実送信（入口 4 つ × 代表のツール）で、門を通らない変更が 1 件でもあれば赤。門の無い変更は、名前を知らなくても赤になる
- **G-入口（静的）**: `sendUserMessage(`・`.sendMessage(`・`.sendMessageWithImage(`・`.startSession(`・`sendModelCommand(` の production の呼び手を読み出し、入口 4 つの中にあることを台帳で固定する（`pane-key-writers` の caller の台帳と同じ作り）
- **G-台帳（静的）**: 既存の `RAW_KEY_WRITES`（`tmux.ts` の外で組む `send-keys`・`paste-buffer`）を、読みの一覧に無い tmux の命令全部と `prompt_async` へ広げる。各行は「門あり」（直前に `fenceGate(`、間に `await` 無し）か「送信の外」（理由つき）

## 6. PR の割り方（B6 が (a) の前提。同じファイルなので 1 人のワーカーが直列で）

| 本 | 中身 | 受入条件 | 触るファイル（見込み） |
|---|---|---|---|
| PR-A 柵の本体（I1・I2・I4） | 札・門・入口 4 つ・取り下げの包み。拒否は型つきで投げ、試行の state は札から決める。**公開の値は足さない**（route の code・exit・文は今のまま） | T1〜T13 が緑。直す前の赤と変異の exit を返しに書く。既存の試験のファイルを 1 つも変えない（B1 が (b) なら §2.3 の差分） | src 12: `terminal-fence.ts`（新）・`tmux.ts`・`submit-verified-sender.ts`・`claude-session.ts`・`opencode.ts`・`opencode-v2.ts`・`base.ts`・route 2 つ・`relay-delivery.ts`・`timer-manager.ts`・`send-user-message.ts`。試験: 新しい 4 ファイルと足場、台帳 |
| PR-B 理由と公開の契約（I3・F4） | 分類の順を全入口に。409・`sendOutcome`・CLI の exit・`lastSend.reason`・文書 ja/en。起動の拒否で起動失敗の通知を出さない | 柵の拒否が route で専用の code になり、予約の喪失の答えと区別できる（直す前は赤）。`send-user-message-input-boundary-3957.test.ts:255–267` を変えずに緑。v2 §6.2 の T5・T7・T11 | v2 §8.3 の一覧から、DB の貸し出し・ペイン ID・印の分を除いたもの |

- 大きさ（見立て）: 1 本では 1 日に収まらない。PR-A は 1 日の見込みだが、T3（route から本物のツールの起動まで）の足場の大きさは未確認
- 順: PR-A → PR-B → #4518（柵と拒否の code の上に載る）。#4535（3 値）と #4503 PR-B1（agy の読み戻し）は同じファイルを書くので直列。#4535 と PR-B の値の名前は B3 の席で一緒に決める

## 7. 残る窓・確かめていないこと・別 Issue の候補

**残る窓**

| 窓 | 何で閉じられるか | この版 |
|---|---|---|
| spawn の後・tmux が打つ前に、同じプロセスが名簿を書く | 書き手を変更の決着まで待たせる（B2 (b)） | 閉じない。結果は「変更の後に名簿が動いた」と同じ（§3） |
| 別プロセスが同じ DB を開いて書く（`db-instance.ts:148–151` が「misconfigured」と書く構成）・DB の手編集 | 確かめの前の書き込みは次の読みで見える。同期の一歩の間の書き込みは、どの形でも閉じない | I2 の外（B2 (a)） |
| 人が tmux を直に触る（kill・ペインの分割）、同じ名前でのペインの置き換え・別名の交代 | ペイン ID（B2 (c)） | 閉じない。今も閉じていない |
| 本番で札を失った送信 | B1 (b) の検知器（層の入口より上で、範囲が開いている間だけ） | B1 の答えによる |
| 範囲が終わった後に残った送信の処理が打つ | 打鍵は今の lock の `ticket.isCurrent()` が断る。打鍵以外は無い（§4 の 3） | 柵では閉じない |

**確かめていないこと**
- T3 の形（route から本物のツールの起動まで）と、codex・agy の T1。試作は claude の送信器・起動の打鍵・copilot の `/model`・OpenCode の送信まで
- OpenCode の照合先と 2 回目の POST、I3 の分類（PR-B）。試作に入れていない
- 静的検査（G-入口・G-台帳・T12）は書いていない。G-境は最小の形（変更の数＝札つきの門の数）だけ
- 確かめを何で読むか（route が使う読みの関数か、生の SQL か）。DB を偽にする既存の試験が札の下で門に届けば `unreadable` になる。今は届く試験が無い（§4）
- `tests/unit` の残りと `tests/unit/guards`（試作の包みが台帳の site の名前を変えるので測れない）

**別 Issue の候補**: 札を引数で運ぶ形（`pane-key-writers.test.ts:47–48` の「後で型で狭める」と同じ向き）／同じプロセスの名簿の書き手を待たせる（B2 (b)）／ペイン ID で打つ（B2 (c)。I4 の陽性対照の読み替えが前提）
