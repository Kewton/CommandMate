# Auto-Yes の確認ごとの記録（Issue #3820）設計

- 対象: Issue #3820（確認ごとに判断・配送・解消と停止の区間を記録する）
- 状態: **設計のみ**。この文書の時点で `src/` と `tests/` は変えていない。実装は設計のレビューの後に、§7 の PR 分割で別の契約として行う
- 基準: develop `1be6cacfa`（2026-10-21）。行番号はこの時点のもの。実装の前に名前で探し直すこと
- 方針: Auto-Yes の基本方針 第 3 版 第 1 部 4 節（計測）。関連: #3817 #3818。順番は #3820（計測）→ #3821（共通化）→ #3822（答えの意味と契約）→ #3823（未対応ツール）
- 前提として読んだもの（git には無い。リポジトリのルートの `workspace/proposals/2026-10-20/`）:
  `auto-yes-basic-policy-v3.md`・`auto-yes-per-agent-target.md`・`measurements-2026-10-20.md`（ほかに `review-codex.md` の R9 と `auto-yes-basic-policy-v2.md` の 8 節）

**この設計で守ること: 答え方は変えない（記録だけ）。記録の例外で、回答・hook の返事・ポーラーの次の tick を失敗させない。**

---

## 改訂: Codex のレビュー（必須 6・推奨 3）を反映

第 1 版（`941923b91`）への Codex のレビュー（指摘 9 件）と、それに対するオーケストレーターの決定に従って改訂した。各指摘の反映先:

| # | 指摘 | 決定と反映 | 節 |
|---|---|---|---|
| 必須 1 | agy は受信窓の判定で `isPrompt:false` になるので、それを確認の消滅として扱うと同じ停止を tick ごとに割る | 記録の状態を **「画面に存在する／消えた／観測不能」（`presence`）と「自動回答できるか」（`answerability`）の 2 軸**に分けた。消えたと判断するのは門を通さない読み取り（agy は専用リーダー）でも確認が見えないときだけ。受信窓を跨いでも 1 件・1 区間であることを PR 1 の受入基準に足した | §2.2・§4.2・§7 PR 1 |
| 必須 2 | 棄権した hook の要求をいつ閉じるかが無い。OFF→ON で同じ確認を見たときの扱いも無い | **hook の要求（応答の完了）と確認の待ちを別の記録にした。** 棄権した要求は応答を返した時点で閉じ、待ちは画面の確認としてだけ数える（二重に数えない規則）。結び付けられないときは件数だけを数え、時間は数えない。Auto-Yes の OFF→ON は確認を閉じず、停止の区間を有効期間ごとに分ける | §2.3・§2.4・§4.2 |
| 必須 3 | `sent` が最後の値だけでは失敗→再試行の成功で失敗が消える。閉じた後に戻る送信の結果の所属が無い | **送信の試行ごとの記録**（`attemptId`、結果 `ok` / `partial` / `failed` / `no-keys-sent`）を持つ。`confirmationId` と `attemptId` は await の前に取り、閉じた確認へ遅れて戻った結果は元の確認に `late: true` の行として属させる。キーを 1 つも送っていない失敗は `partial-answer` にしない。区間は最初の失敗で始まり、回答の成功の後に再び止まったら新しい区間を開く。既存の `AutoYesSendAttempt`（`auto-yes-poller-state.ts:286-365`）と同じ規則（オブジェクトを持つ・キーを引き直さない）に揃えた | §2.5・§4.2・§7 PR 1 |
| 必須 4 | 画面で見えなかったことを「確認が出なかった」と断定している | `no-dialog` を **`dialogUnobserved`（確認未観測）** に改め、CLI 自身の自動許可とは別に数える。送信の後に消えたものは `resolvedAfterAnswer`（観測の事実）とし、因果を確かめられないときの `resolvedBy` は `unknown` | §2.6・§5.1・§6.2 |
| 必須 5 | `closed` だけでは日次の停止の費用・未完了の件数を正しく出せない。既存の集計は 24 時間より古い行を捨てる | **当日の停止の時間を測る**ことにした。開いている確認について、固定の 1 時間刻み（UTC の時刻の境目。集計の窓に依存しない）で累積の停止時間を持つ `checkpoint` の行を出し、集計は窓の中の区間の長さを区間の開始・終了の行と checkpoint から切り出して足す。再起動で消えた確認は最後の checkpoint までを数え、それ以降は不明として件数だけ出す。計測の有無を示す行（記録のモジュールの起動と 1 時間ごとの生存。ログ水準を含む）を出し、計測があった時間を分母にする。§9 の未決「長い停止を閉じる前に見せるか」はこれで閉じた | §3.3・§4.3・§4.4・§6・§9 |
| 必須 6 | CLI 自身の auto モードを数える入力が無い（claude の `PreToolUse` は `AskUserQuestion` だけ） | **今の hook で観測できる範囲に限る。** 新しい hook は足さない。モードは `PermissionRequest` で見えたときだけ記録し、見えないものは「不明」とする（0 件と書かない）。日次の欄は「観測できた範囲」と明記した。第 1 版の「中継に `permission_mode` を足す」（PR 3）は取り下げた | §3.4・§6.2・§7 PR 3 |
| 推奨 7 | `bootId` をモジュール読み込みの乱数にすると、別の束ね・再読み込みを再起動と誤る | `bootId`・確認の `Map`・連番を**同じ `globalThis` の状態**に置き、再読み込みでは保つ。集計は読み込みの順（最新のログ→ローテート済みのログ）を時系列として扱わず、時刻で並べ直す。その対照を PR 4 の受入基準に足した | §3.3・§4.4・§7 PR 1・PR 4 |
| 推奨 8 | PR の途中の状態と、基準値として使える時点が無い | 生存の行に「記録している経路」（`paths`）を載せ、集計は欠けた経路を**部分計測**として表示する。基準値として使えるのは **PR 1 と PR 4 が入った時点からの画面の経路の数字**、hook・API の経路は PR 2 から、agy の結び付けは PR 3 から。PR 1 で全経路共通のログの仕様を固定し、PR 3 の後に横断テスト（PR 5）を置く | §6.4・§7 |
| 推奨 9 | `catch` の中の二次ログも失敗し得る。console への同期出力は I/O 待ちが無いとは言えない | 二次ログからも例外を出さない（空の `catch` と生存の行の `ledgerErrors` の数）。保証は**実測までは「記録の例外で回答を失敗させない」に留め**、遅延の保証は書かない。記録を固定の大きさに限り、hook と API にも故障注入のテストを置く | §8.1・§7 |
| 参考 | 長期の保存先 | agent-health の日付ごとの結果 **`~/.commandmate/agent-health/metrics/<date>.json`**（`docs/user-guide/agent-health.md:674`）。`metrics-state.json` は前回値で、履歴の置き場所ではない | §3.2 |

### 改訂 2: 再レビュー（残り 5 件）と PR 1 の実装で直したこと

第 2 版への再レビュー（前回の残り 3 件・新しい指摘 2 件）と、オーケストレーターの答えに従って直した。あわせて、PR 1 の実装（`src/lib/polling/auto-yes-confirmation-ledger.ts`）で分かった食い違いを、設計書の側で直した。

| 指摘 | 決定と反映 | 節 |
|---|---|---|
| 必須 5 の残り: checkpoint だけでは内訳を復元できない・区間を選べない・窓の末尾 | checkpoint を**復元できるスナップショット**にした（`confirmationId`・`intervalId`・`cliToolId`・`source`・今の理由・区間の開始・その区間の長さ・累積）。区間の開始・終了の行にも `cliToolId`・`source` を載せる。集計は **`intervalId` 単位**で開始・終了・checkpoint を突き合わせる。窓の終わりは**完了済みの時刻の境目（最後の checkpoint の時刻）**に揃え、その後の未確定の末尾は数えない | §3.3・§4.3 |
| 必須 6 の残り: モード別のインスタンス数の識別と母集団 | モードの観測の行に `worktreeId`・`instanceId`・`sessionEpoch` を持たせる（内部のログだけ。agent-health の `details` には件数だけ）。不明の数の母集団は**窓の中で識別できたインスタンス**（何かの行に `worktreeId`・`instanceId` が出たもの）に限り、母集団が分からなければ数値を出さない | §3.3・§3.4・§6.2 |
| 推奨 8 の残り: 生存点と `paths` の和集合は計測時間を過大に見積もる | 生存の行は `bootId` と**経路ごとの計測区間**（`segments: [{ path, startMs, endMs }]`、区間の始まりは同じ `bootId` の前の生存の行か記録の開始）を持つ。集計は `coveredMsByPath` と欠損の時間で比べられるかを決める。生存の行 1 つで 1 時間を計測済みにしない。`ledgerErrors` が窓の中で増えたら `partial` | §3.3・§4.4・§6.2・§6.4 |
| N1: 遅れた成功を回答の数へ入れる規則の矛盾 | 確認を閉じた時点の状態（`closed` の `answeredAtClose`）と、後から分かった配送の結果（`late: true` の試行の行）を分ける。遅れて戻った `ok` は `answered` に入れず `answeredLate` に数え、**遅れた行の時刻の窓**に入れる。同じ窓の「閉じる → 遅れた `ok`」を PR 4 の対照に足した | §2.5・§6.2・§7 PR 4 |
| N2: 計測の入口の責任と横断テストの期待件数 | **hook の要求の id は hook の route だけが発行する。** API の裁定（`permission-adjudication.ts`、`resolvePermissionRequest()` を呼ぶ）は hook の要求を作らない。PR 2・PR 5 の受入基準に、その対照と、claude の「allow だけ＝確認 1 件」「棄権の後の画面＝1 件」「allow の後の別の画面＝2 件」を分けて書いた | §2.3・§7 PR 2・PR 5 |
| 実装: 時計を張る場所 | サーバーの起動（`server.ts`）は変えない（評価時の import を増やすと Next の起動が壊れる前例がある）。時計は**記録のモジュールが最初に使われたとき**に `globalThis` で 1 つだけ張る。生存の行の意味は「記録のモジュールが動いていた」になり、最初の確認より前の時間は計測なしになる | §4.4・§7 PR 1 |
| 実装: 判断の前に消えた確認 | 1 tick だけ見えて、Auto-Yes が答えも止めもしないうちに消えた確認（Enter の補いの 1 回目の tick、人が先に答えた）を表す `resolution` が無かった。`resolved-before-decision` を足した | §2.6 |
| 実装: 記録だけの停止の理由 | 画面の経路は、方針の抑止のほかに「他のサーバーのセッション」（#2865）と「ID の移動で運ばれた送信を待つ」（#3713）でも答えない。記録だけの理由 `foreign-session`・`moved-send-in-flight` を足した（`send-failed`・`send-no-keys` と同じ扱い） | §2.2 |
| 整合性レビュー P2-1: 重複の抑止で区間が記録されない | 重複の抑止（#306。同じ質問に答えてから 10 秒は答えない）の `duplicate` の早期 return の前に、記録だけの理由 **`answered-recently`** で停止を記録する（答え方は変えない）。答えが画面に届くのを待つ時間なので、`ok` の後にこの理由の区間だけが開いたまま消えた確認は `resolved-after-answer` とし、集計は理由で停止の費用と分けられる | §2.2・§2.6・§7 PR 1 |
| 整合性レビュー P2-2: 本文が違う確認が同じ id になる | #3817 で `partialAnswerScreenKey` は選択肢の行を読めるときだけその行の印・字下げを揃えるようになったが、読めないときは従来どおり全行の印・字下げを消す（部分送信では 2 つを 1 画面と読む方が安全なため）。記録の識別はこれでは足りないので、**`ledgerScreenKey`** を使う: 選択肢の行を読めるときは `partialAnswerScreenKey` と同じ、読めないときは**検出器が読んだ選択肢（`promptData.options` の番号とラベル）に一致する行だけ**印・字下げを消し、ほかの行（番号つきの本文を含む）はそのまま残す。照合は `1.`・`1)`・ピリオドの無い `1  Yes` を区切りの空白の数によらず受け付ける（再レビューの 2 件: 番号つきの本文が 1 件に潰れる・ピリオドの無い選択肢でカーソルが動くと開き直す） | §2.1 |
| 整合性レビュー P2-3: agy の専用リーダーの確認が L4 になる | agy の門は `legacy`（`gated: false`）なので門の判定からは L3 にならない。poller が同じ文字列を agy の専用リーダー（`detectAntigravityNumberedDialogPrompt`。`detectPromptOnCleanFrame` は読めればその結果を返す）で読み直し、読めたら **`L3`**（受信の門を通った確認なので `receiptAccepted: true`）、読めなければ汎用の推定で `L4` とする。読み直しは記録の段のためだけで、答えはその前に決まっている | §7 PR 1 |

### 改訂 3: PR 2 の実装で直したこと

PR 2 の実装（hook・API・`/prompt-response` の経路）で分かった食い違いを、設計書の側で直した。

| 食い違い | 決定と反映 | 節 |
|---|---|---|
| 人の回答の根拠の段が語彙に無い | `/prompt-response` の人の回答を、ブラウザの自動回答（`browser`）と分けて数えるため、`AnswerBasis` に **`human`** を足した（Auto-Yes の回答ではない。`closed` の `decision` は `none`）。PR 4 は知らない値を `(other)` にまとめるので壊れない | §0・§2.6 |
| `/prompt-response` の確認の開閉 | route が受けた 1 リクエストを **1 件の確認（`source: 'prompt-response'`）** とし、試行 1 つと同時に開いて閉じる。画面の経路の確認とは結ばない（同じ画面を poller も見ていれば、別の `source` の 2 件になる。集計は `source` で分ける）。`ok` なら `resolved-after-answer`（人なら `resolvedBy: 'human-ui'`、ブラウザなら `unknown`）、失敗は `unresolved-after-send`。区間は開かない。記録はセッションが動いていると分かった後の応答だけ（それより前の 400・404 は確認に数えない） | §2.1・§2.6 |
| hook の要求を開く時点と、返事を書けなかったとき | 要求は route が worktree を引いた直後に開く（`worktree-unresolved` も 1 件の要求として閉じる）。route の catch-all が書くのは棄権の本文なので、要求は `outcome: 'abstained'`・`abstainReason: 'error'` で閉じ、allow で開いていた確認は試行 `failed`・`unresolved-after-send` で閉じる | §2.3 |
| `afterHookAllow` / `afterHookAbstain` の基準の時刻 | 要求を**閉じた**時刻から `AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS`（8 秒。agy の受信窓と同じ）以内に、同じインスタンスで画面の確認が開いたとき。要求の id は付けない（同じ呼び出しとは断定しない） | §2.3・§2.4 |
| opencode の確認を閉じる契機 | `settled` で閉じる（`resolved-by-reply`・`resolvedBy: 'auto'`）ほかに、Auto-Yes が settle しなかった承認は **`permission.replied`（v2 は決着の通知）** を受けた時点で閉じる（`src/lib/hooks/sources/opencode/ingest.ts`・`opencode-v2/ingest.ts`。誰が答えたかは分からないので `unknown`）。ポーラーの停止（Auto-Yes OFF など）では `unobservable` にしない（画面で見ている確認ではない）。セッションの終了では放棄する | §2.4・§4.2 |
| `permission_mode` | claude だけでなく codex の `PermissionRequest` にも載っている（`tests/fixtures/hooks/codex/permission-request.json`）。どのツールでも本文にあれば記録する。値は語彙の形（英字と `-`、32 文字まで）に限り、外れたら `(other)` | §3.4 |
| PR 1 のテストが固定していた `paths` | PR 1 の `auto-yes-confirmation-ledger-3820.test.ts` は `paths: ['screen']` を固定していた。§6.4 のとおり PR 2 で `screen`・`hook`・`api`・`prompt-response` に変わるので、その 2 か所の期待値だけを直した | §6.4 |

### 改訂 4: PR 2 の整合性レビュー（5 件）で直したこと

PR 2 の実装への Codex の整合性レビュー（`.commandmate/tasks/review-3820-pr2.md`）の 5 件を、実装と設計書の両方で直した。

| 指摘 | 決定と反映 | 節 |
|---|---|---|
| API の停止の区間に Auto-Yes OFF の間の時間が入る | API の確認を開いたまま残すことと、停止の区間を終えることを分けた。セッションを終えない停止（`manual`・`expired`・`not-enabled`・`stop-pattern`・`consecutive-errors`・`shutdown`）では、API の確認は閉じず存在も `present` のまま（返事でまだ決着する）だが、開いている区間は **`end: 'stopped'`**（`WithholdEnd` に足した）で閉じる。OFF の間は区間が無いので checkpoint に時間は入らない。OFF の前に始めた配送が OFF の後に `failed` で戻っても、試行は `failed` と記録するが区間は開き直さない（再レビュー）。ON に戻って再裁定（allow か、方針による停止）したら、その有効期間の区間として扱い、止めるなら同じ確認に新しい区間を開く | §3.3・§4.2 |
| API の遅れた結果が別の確認の通常の回答になる | 画面の経路と同じく、配送の前（await の前）に確認と試行を取る（`beginLedgerApiAdjudication`）。結果はその試行へ返す（`settleLedgerApiAdjudication`）。配送の間に確認が閉じていれば（kill など）、その確認の `late: true` の行だけを書き、決定の id で確認を開き直さない。一度で書く `recordLedgerApiAdjudication` は 2 つを続けて呼ぶ形で残した | §2.4・§2.5 |
| poller の無い API の確認が worktree の削除で放棄されない | 記録の後始末を、動いている poller の列挙に頼らない。`stopAutoYesPollingByWorktree`（worktree の削除・セッションの後始末・全エージェントの OFF が通る）は、poller ごとの停止の後に **`noteLedgerWorktreeStopped`** で、その worktree の開いている確認すべてに同じ停止を伝える（削除なら `abandoned(worktree-deleted)`、OFF なら区間を閉じる）。インスタンス単位の停止（`stopAutoYesPolling`）は、poller が無くても記録へ伝える（PR 1 から） | §4.2 |
| hook の配送のヘルパーが握りつぶした失敗を回答の成功と記録する | `answerPendingDecision` に、既存の配送の受領（receipt）を渡す `onReceipt` を足した（本文は変わらない）。受領が「届いていない」（`decide` が throw した、slot が閉じていた）と言えば、route は要求を `abstained`・`abstainReason: 'delivery-failed'` で閉じ、allow で開いていた確認は試行 `failed`・`unresolved-after-send`（`abandonReason: 'delivery-failed'`）で閉じる。受領が無いときは本文を書いたものとして従来どおり | §2.3 |
| 新しい能力が CLI の型の写しと説明に無い | `src/cli/types/api-responses.ts` の capabilities に `permissionAllowSuppressesDialog`（と、同じく抜けていた `transcriptHistory`・`stopReportsSelfResume`）を任意の項目として足した。CLI ガイド（ja・en）の `capture --json` の例と、`docs/design/multi-agent-state-architecture.md` §4 D3 の能力の表にも足した | — |

残す制限（この PR では直さない）: `respond` / strict `respond` の回答は記録しない（経路の表に無い）。ブラウザの自動回答が `instanceId` を渡さない件は #3821 でブラウザの自動回答をやめるときに扱う。

### 改訂 5: PR 4（日次の集計）の実装で直したこと

| 食い違い | 決定と反映 | 節 |
|---|---|---|
| 窓の終わりだけを境目に揃えると、翌日の窓が今日の窓の終わりから始まらない（集計の時刻 − 24 時間から始まるので、境目から集計の時刻までの末尾がどちらの日にも入らない） | 窓は **`e` = 集計の時刻以前の最後の UTC の時刻の境目、`s` = `e` − 24 時間**。`s` は共有の読み込みの窓の始まりより最大 1 時間前になるので、`addLogLine()` は記録の行に限り 1 時間前まで `auto-yes-observation` へ渡す（ほかの指標の数え方は変えない）。ローテート済みのログを読み飛ばす条件（最終更新が窓より前）も 1 時間前に合わせた | §4.3・§6.1 |
| `details` は数値・文字列・`null` だけ（`MetricResult.details` の型）で、真偽値と入れ子を持てない | `partial` は `1` / `0`、`coveredMsByPath` は `screen 86400000 / hook 0 / …` の文字列、`pathsMissing` はカンマ区切りの文字列。`coveredMs`（最も長い経路の値）を足した | §6.2 |
| `pathsMissing` を「窓より短い経路」にすると、欠損の時間がある日は `screen` まで欠けた経路に入る | `pathsMissing` は **`coveredMs` より短い経路**（途中から加わった・欠けた経路）。欠損は `gapMs` で表す。`partial` はどちらか（と `ledgerErrors` の増加）で `1` | §6.2・§6.4 |
| `lostOnRestart` は「別の `bootId` が現れた」場合だけだと、サーバーが止まったまま窓が終わった確認がどこにも数えられない | 閉じる行も窓の終わりの checkpoint も無い確認を、すべて `lostOnRestart` に数える（時間は最後の行までを数える） | §4.3・§6.2 |
| `resolution` の `resolved-by-reply`・`resolved-before-decision` の欄が §6.2 に無い | `resolvedByReply`・`resolvedBeforeDecision` を足した | §6.2 |
| 開始の行が欠け、理由変更の行（開始の時刻を持たない）だけが残った区間を窓の先頭から数えると、根拠の無い時間が足される（整合性レビュー P2） | 開始を復元できない区間は時間を足さず、`withheldIntervalsUntimed`（`records` は `untimed`）に件数だけ数える | §4.3・§6.2 |
| 生存の行があるだけで ok にすると、窓の始まりの境目の生存の行（直前の 1 時間を表す）だけで「停止 0 分」を正常値として出す（整合性レビュー P2） | skip の判定を「窓の中に計測区間がある（`coveredMs` > 0）か」にした | §4.4・§6.1 |
| 集計が語彙を見分けるには型ではなく値が要る | `auto-yes-confirmation-ledger-types.ts` に語彙の値の一覧（経路・根拠の段・理由・結果・解消・hook の棄権の理由・モード）を足した。型の union と食い違うとコンパイルで落ちる書き方 | §6.1 |

### 改訂 6: PR 2 と PR 4 の統合で直したこと

develop の PR 4（#3834）をこのブランチに取り込んで分かった食い違いを直した。

| 食い違い | 決定と反映 | 節 |
|---|---|---|
| 語彙の値の一覧（`ANSWER_BASES`）に PR 2 の `human` が無い（型が合わず tsc が落ちる。集計では `human` が `(other)` になる） | `auto-yes-confirmation-ledger-types.ts` の一覧に `human` を足した | §0・§6.3 |
| `/prompt-response` の人の回答（basis `human`）も `answeredAtClose` の確認なので、`answered`（Auto-Yes の回答）に入る | `human` で閉じた確認は `answered` に数えず **`answeredByHuman`** に数える。ブラウザの自動回答（`browser`）と API の allow（`L1`）は `answered`。`records` の `answered` は根拠の段ごとの内訳のまま（`basis: 'human'` の行が残る）。試行の数（`attemptsOk` ほか）は人の送信も含む | §6.2 |
| PR 2 の `end: 'stopped'` と経路 `prompt-response` | 集計は区間を `endedAtMs` で終えるので、OFF の後の時間は数えない（API の確認は開いたまま checkpoint に出るが、区間を持たない）。PR 2 の記録は `screen`・`hook`・`api`・`prompt-response` を出すので、`pathsMissing` は `agy-link` だけになる（§6.4 の表のとおり）。PR 4 のテストが PR 1 の経路で固定していた `pathsMissing` の期待値は、この値に直した | §4.3・§6.4 |

### 改訂 7: PR 3（agy の `stepIdx` と結び付け）の実装で直したこと

| 食い違い | 決定と反映 | 節 |
|---|---|---|
| `callId` を agy の解析（`parseAntigravityPermissionRequest()`）の戻り値に足すと、取り込んだ fixture の解析結果を丸ごと固定している既存のテスト（`antigravity-permission-1779.test.ts`）の期待値が変わる | `callId` は `PermissionRequestPayload` の任意の欄として足し、値は **route が本文から読んで payload に添える**（`readAntigravityPermissionCallId()`、`src/lib/hooks/sources/antigravity/source.ts`）。解析の戻り値（裁定が判断に使うもの）は変えない。`stepIdx` が無い・数でない本文は `callId` なし | §2.4 |
| PR 3 で生存の行の `paths` に `agy-link` を足す（§6.4 の表）と、`paths` を固定している PR 1・PR 2・PR 4 のテスト（`auto-yes-confirmation-ledger-3820.test.ts`・`auto-yes-observation-ledger-3820.test.ts`・`auto-yes-observation-pr2-3820.test.ts`）の期待値が変わる | **この PR で `agy-link` を `AUTO_YES_LEDGER_RECORDED_PATHS` に足した**（§6.4 の「＋PR 3」の行のとおり、全経路が揃い `partial: 0`・`pathsMissing` は空になるのが意図した変化）。それらのテストの `paths` / `pathsMissing` / `partial` の期待値だけをこの値に直した。PR 2 の版の生存の行（`agy-link` なし）が混ざる窓は引き続き `partial: 1`・`pathsMissing: agy-link`（`auto-yes-observation-pr3-3820.test.ts`） | §6.4 |
| 同じ画面キーのまま別の呼び出しの確認に替わった（同じコマンドの 2 回目、`gone` の tick を挟まない） | 画面キーより hook の識別を優先する（§2.1）: 開いている確認の `callId` と違う `callId` で見えたら、前の確認を `gone` で閉じて新しく開く。`callId` の無い確認に後から `callId` が来たら、その確認に結ぶ（行は足さない。`opened` の行には付かない） | §2.1・§2.4 |
| `PostToolUse` で閉じた後も、古いフレームに同じ確認が読めることがある（capture の遅れ） | 呼び出しの終わりで閉じた確認は、同じ画面キー（と同じ `callId`）が続く間は開き直さない。読めた tick が途切れたら忘れる。この記憶は**閉じたセッションの世代（`sessionEpoch`）のときだけ**当てる（作り直したセッションの最初の観測は、同じ画面キーで `callId` が無くても新しい確認）。ポーラーの停止（`noteLedgerPollerStopped`）と worktree の停止（`noteLedgerWorktreeStopped`）では、**セッションを終える理由（`session-killed`・`instance-removed`・`worktree-deleted`・`orphan-swept`）のときだけ**捨てる。観測の一時停止（手動の OFF の `manual`・`expired`・`not-enabled`・`stop-pattern` など、知らない理由も含む）では残す（OFF→ON の後に同じ呼び出しの古いフレームを数え直さない。作り直しは世代の判定で見分ける）。インスタンスごとに 1 件、上限 1024 インスタンス（古いものから捨てる） | §2.4 |
| `dialogUnobserved` を要求の行に付ける時点 | 要求の行（`auto-yes-hook-request-closed`）は返事を書いた時点で出るので、`PostToolUse` より先に出る。`dialogUnobserved` は **`auto-yes-hook-request-dialog-unobserved` の行**（`hookRequestId`・`callId`）として後から出す（§3.3 にあった書き方）。同じ呼び出しの 2 回目の `PostToolUse`、要求を聞いていない呼び出し（再起動の後など）は何も出さない | §2.6・§3.3 |
| agent-event の受け口の重複抑止（`isDuplicateAgentEvent`）はインスタンス・イベント・`detail`・会話をキーにするので、同じコマンドの別の呼び出し（`stepIdx` 25 と 27）の `PostToolUse` が 3 秒以内に続くと後者を捨て、route は台帳への通知の前に戻っていた | 重複抑止（キー・判定・状態の更新）は変えない。台帳への呼び出しの終わりの通知（`noteToolCallEndedInLedger()`）だけを**重複判定の前**に移す。同じ `callId` の 2 回目は台帳の側で何もしない（冪等） | §2.4・§2.6 |
| 中継が `stepIdx` を足す範囲 | `post_tool_use` のうち **`--tool antigravity` のときだけ**、数（15 桁まで）として足す。ほかのツール・イベントの本文は変えない（#3330・#3450 の claude だけの欄と同じ書き方） | §2.4 |

---

## 0. 用語

| 語 | 意味 |
|---|---|
| 確認 | エージェントが人に求めた 1 回の許可・選択（1 回のツールの呼び出しにつき 1 件）。画面のダイアログ・hook の要求・API の承認要求のどれで見えたかは問わない |
| hook の要求 | hook の受け口が受けた 1 回のリクエスト。応答を返したら閉じる。**確認とは別の記録**（§2.3）。allow で確認を出さないツールでは、要求がそのまま確認になる |
| 判断 | Auto-Yes がその確認に「答える／止める（答えない）」と決めたこと。根拠の段と、止めたときの理由を持つ |
| 配送 | 決めた答えをエージェントへ届けること。画面ならキー送信、hook なら HTTP の返事、opencode なら API への POST。1 回の配送を**試行**と呼ぶ（§2.5） |
| 存在（`presence`） | 確認が今どう見えているか: `present`（画面・要求にある）／`gone`（消えた）／`unobservable`（見ていない: Auto-Yes OFF でポーラーが止まっている、画面を読めない） |
| 回答可否（`answerability`） | Auto-Yes が今その確認に答えられるか: `answerable`／`withheld`（理由つき）。存在とは独立に動く（§2.2） |
| 解消 | 確認の存在が `gone` になったこと。誰が消したか（`resolvedBy`）は、因果を確かめられたときだけ書き、それ以外は `unknown` |
| 停止の区間 | 1 件の確認について、Auto-Yes が答えられない（`withheld`）と判断してから、答えるか、確認が解消するか、観測できなくなるまでの時間。1 件の確認に複数の区間があり得る（§4.1） |
| 根拠の段 | 基本方針の L1〜L4。L1 = hook / API の判定、L2 = hook の目撃と画面の照合、L3 = ツール専用の規則で認識した画面、L4 = 汎用の文字推定。ほかに今の経路として `enter-fallback`（Enter の補い）と `browser`（ブラウザの自動回答）を別に数える。`human` は `/prompt-response` の人の回答で、Auto-Yes の回答ではない（改訂 3） |
| 計測の有無 | その時間に記録のモジュールが動いていて、ログが出る水準だったか。生存の行で示す（§4.4）。**計測が無い時間を 0 件と扱わない** |

---

## 1. 現状の記録の経路（実コードで確認）

Issue 本文の 3 点は、実コードと合っていた（行番号は 1 か所だけずれていた。下の表の注記）。

### 1.1 止めた記録 = インスタンスごとに最後の 1 件の上書き

| 場所 | 内容 |
|---|---|
| `src/lib/polling/auto-yes-suppression-state.ts:68` | `lastPolicySuppressions`（`globalThis` の `Map<compositeKey, AutoYesPolicySuppression>`） |
| `src/lib/polling/auto-yes-suppression-state.ts:75-86` | `recordPolicySuppression()` が `Map.set` で**上書き**する。持つのは `reason`・`mode`・`promptType`・`pattern`・`at` だけで、確認の識別も開始時刻も無い。`at` は再び止めるたびに更新される（ファイル冒頭の説明 12-16 行のとおり） |
| `src/lib/polling/auto-yes-suppression-state.ts:107` | `forgetPolicySuppression()`（#3796、契約が変わったときに消す） |
| 書き手 | ポーラーの 4 つの出口が共有する `suppressAndWarnOnce()`（`src/lib/polling/auto-yes-prompt-suppression.ts:66-81`、記録は 74 行）。方針による抑止は `resolveAnswerUnderPolicy()`（`src/lib/polling/auto-yes-poller-steps.ts:75-103`）から。agy の受信記録が無いときは `src/lib/polling/auto-yes-poller-receipt-log.ts:138,169,217`、信頼の画面は `auto-yes-prompt-suppression.ts:411`。hook の方針抑止は `src/lib/hooks/permission-decision-service.ts:513-523` |
| 読み手 | `src/lib/session/current-output-builder.ts:762`（`capture --json` の `autoYes.lastSuppression`、WS）・`src/lib/push/prompt-push-gate.ts:351`（通知の保留）。どちらも「今止まっているか」を知るためで、件数や時間は見ていない |

→ 日次の件数も、止まっていた時間も復元できない。`at` は「最後に止めた tick」で、開始ではない。理由が途中で変わっても前の理由は残らない。

### 1.2 回答の記録 = `chat_messages` の `promptData.answeredBy`

`PromptAnsweredBy = 'auto' | 'human' | 'terminal'`（`src/types/models.ts:397`）。書く場所は 5 つ:

| 経路 | 場所 | `answeredBy` | 問題 |
|---|---|---|---|
| サーバーの poller が画面に答えた | `src/lib/auto-yes-poller.ts:607-614`（`finishAnsweredPrompt()` 542 行から。`recordAnsweredPrompt()` は `src/lib/db/chat-db.ts:972`） | `auto` | キーを送った後に 1 行書くだけ。判断（根拠の段）・送信の結果（部分送信）・解消を区別しない。再試行（同じ確認に 10 秒後にもう一度答える、`DUPLICATE_RETRY_EXPIRY_MS` = `src/lib/auto-yes-state.ts:922`）は同じ pending 行を上書きするか新しい行を作るかが行の有無で変わる |
| `/prompt-response`（人の UI と**ブラウザの自動回答**） | `src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts:153-161`（159 行が `answeredBy: 'human'`） | `human` | `src/hooks/useAutoYes.ts:190` のブラウザの自動回答も同じ API を叩くので `human` になる（186-189 行の注記がこれを認めている）。タスクのイベントも `prompt_answered_human`（190 行） |
| `respond` API | `src/app/api/worktrees/[id]/respond/route.ts:271` | `human` | — |
| strict respond（CLI） | `src/app/api/worktrees/[id]/prompt-response/strict/route.ts:115` | 申告どおり（既定 `cli`） | `PromptAnsweredBy` の外の文字列も入る |
| 誰も記録しないまま確認が消えた | `markPendingPromptsAsAnswered()`（`src/lib/db/chat-db.ts:852`、902 行） | `terminal` | 「エージェントが先へ進んだ」ことしか分からない |
| hook の allow | `src/lib/hooks/permission-decision-service.ts:247-292`（281 行が `answeredBy: 'auto'`） | `auto` | 下の 1.3 |

`answeredBy='auto'` だけを数えると、ブラウザの自動回答を落とし、Enter の補い（`poller:auto-yes-enter-fallback-sent`、`src/lib/auto-yes-poller.ts:513`。行は書かない）も落とす。配送の失敗は行を書かない（send が throw すると `finishAnsweredPrompt` に来ない）ので「失敗を回答済みにする」誤りは今は無いが、**部分送信**（#3706、`partial-answer`）は止めた記録の上書きにしか残らない。

### 1.3 hook の allow の監査記録

- `recordAllowedPermission()`（`src/lib/hooks/permission-decision-service.ts:247`）は、allow のたびに `chat_messages` へ「答えた」行を 1 行 INSERT する（`summary` は `PermissionRequest allow · tool=… · prompt_id=…`、267 行。`status: 'answered'`・`answer: 'allow'`・`answeredBy: 'auto'`、279-281 行）
- 前提は説明（229-245 行。Issue が引いた 232-234 行はこの説明の中ほど）の **「allow した要求はダイアログを出さない。だからこの行が唯一の記録」**（233 行）
- agy でもこの関数が呼ばれる。agy の `PreToolUse` は `/api/hooks/permission-request` に来て（`src/app/api/hooks/permission-request/route.ts:224`）、同じ `resolvePermissionRequest()`（`permission-decision-service.ts:460-541`、allow なら 536-538 行で記録）を通る
- **実測（`measurements-2026-10-20.md` §1）では agy 1.4.2 は allow を返しても確認を出す**（1.1.12・1.1.27 と同じ）。画面の poller がその確認に答えて、もう 1 行 `auto` を書く。`auto-yes-per-agent-target.md` の数え方で、hook の allow 564 件は画面でも答えた二重の記録
- 逆に、agy は利用者の許可リストにあるコマンドや作業フォルダ内の `read_file` では確認を出さない（同 §1・§6）。この場合は「hook が allow した」行だけが残り、「CommandMate が許可して実行させた」ように読めるが、実際は agy 自身の設定で実行されている
- ソースの能力の宣言には、この違いを表す欄がまだ無い。近いのは `permissionHookPredictsDialog`（claude `src/lib/hooks/sources/claude/source.ts:159` が true、agy `src/lib/hooks/sources/antigravity/source.ts:241` が false）と `permissionReplyReleasesPrompt`（claude 164 行・agy 244 行とも false）。前者は「答えなかったら確認が出るか」、後者は「配送で待ちの記録を解いてよいか」で、**「allow したら確認が出ないか」ではない**

### 1.4 そのほかの記録（突き合わせに使える既存の材料）

| 材料 | 場所 | 使い道 |
|---|---|---|
| hook の判定のログ `permission-request-decided` / `permission-request-slow` | `src/app/api/hooks/permission-request/route.ts:273-289` | 判定 1 回につき 1 行。`behavior`・`reason`・`suppressedBy`・`elapsedMs` はあるが確認の識別は `promptId`（claude の `prompt_id` はターンの id で、呼び出しの id ではない） |
| hook の棄権の理由 | `PermissionDecisionReason`（`permission-decision-service.ts:80-92`。`ask-user-question`・`auto-yes-disabled`・`policy-suppressed` ほか） | 棄権した要求を理由別に数える語彙（§2.3） |
| opencode の判定の最後の 1 件 | `src/lib/hooks/permission-decision-state.ts:99`（`lastDecisions.set`）、書き手 `src/lib/hooks/permission-adjudication.ts:136` | `delivered` / `releasedPrompt` を持つ。これも上書き |
| poller の送信ログ `poller:response-sent` | `src/lib/auto-yes-poller.ts:575-583` | 送った答えと質問（500 文字まで）。判断の根拠は無い |
| poller の送信の試行 | `AutoYesSendAttempt`・`beginSendAttempt()`・`settleSendAttempt()`（`src/lib/polling/auto-yes-poller-state.ts:286-360`、#3713）。失敗の分岐は `settleFailedTick()`（`src/lib/auto-yes-poller.ts:852-893`） | await の前に登録したオブジェクトを tick が持ち、戻ったら `keysSent` で部分送信を記録する。止まった世代の送信は `poller:auto-yes-answer-abandoned`（`keysSent` つき）。世代が生きている失敗（`poller:detect-respond-error`）でも、#3839 から `keysSent === true` なら途中で止まった答えとして記録する（`settleSendAttempt(attempt, keysSent === true)`。次の tick は打ち直さない）。`keysSent` が分からない throw だけが §2.5 の `failed` |
| agy の受信記録 | `src/lib/polling/antigravity-permission-receipts.ts:72-76`（`{ toolName, at }` だけ）、書き手 `route.ts:213-221` | 8 秒の受信窓。`toolCall.args`・`stepIdx`・`conversationId` は捨てている |
| agy の受信のエピソード | `src/lib/polling/antigravity-receipt-episodes.ts`（`beginAntigravityFrameRead` 195 行・`endAntigravityFrameRead` 221 行・`markAntigravityAnswerSent` 256 行） | 「ダイアログを最初に見た時刻」と「どの受信で受理したか」を既に持っている。agy の確認の識別の土台になる |
| agy の受信窓の外の確認 | `src/lib/auto-yes-poller.ts:739-743`（`isPrompt` が false のとき `logIfWithheldForWantOfReceipt()` が `detectPromptOnCleanFrame()` で門を通さずに読み直す） | **受信窓の外では、確認が画面に残っていても `isPrompt: false` になる**。存在の判断はこの読み直しの結果で行う（§2.2） |
| CLI 自身の許可のモード | `PermissionRequestPayload.permissionMode`（`src/lib/hooks/permission-request-payload.ts:56,109`）。使っているのは `NON_BLOCKING_PERMISSION_MODES`（`permission-decision-service.ts:361,425`）だけ | claude の `PermissionRequest` にしか無い。中継（`scripts/hooks/cmate-agent-event.sh`）は `permission_mode` を送らない。claude の `PreToolUse` / `PostToolUse` の登録は `AskUserQuestion` だけ（`src/lib/hooks/hook-settings-generator.ts:485-491`） |
| 既存の日次の読み込み | `addLogLine()`（`src/lib/agent-health/metrics-perf.ts:147-160`） | 窓（直近 24 時間）の外の行は `oldest` を動かすだけで捨てる。前日以前の行から状態を引き継げない（§4.3 の checkpoint はこのため） |
| 日次の結果の置き場所 | `~/.commandmate/agent-health/metrics/<date>.json`（`docs/user-guide/agent-health.md:674`）と `metrics-state.json`（同 454 行、前回値） | 長期の推移は前者（§3.2） |

---

## 2. 確認の識別と、判断・配送・解消の結び方

### 2.1 識別の作り方（ツール・経路ごと）

確認ごとに、サーバーが `confirmationId`（`<bootId>-<連番>`。§3.3）を振る。何を「同じ確認」とみなすかは、経路ごとに次の**識別の材料**で決める。

| 経路 | 識別の材料 | 同じ確認とみなす範囲 | 別の確認に分ける条件 |
|---|---|---|---|
| 画面（全ツール共通） | `ledgerScreenKey(promptData)`（`src/lib/polling/auto-yes-poller-state.ts`。種類・質問・選択肢・`approvalTarget`、カーソルは除く。選択肢の行を読めるときは `partialAnswerScreenKey` と同じで、読めないときも本文の行は残す）＋ セッションの世代（`sessionEpoch`） | 同じ画面キーが、存在が `gone` の tick を挟まずに続いている間（`unobservable` の間を挟んでもよい。§2.2） | 存在が `gone` の tick・別の画面キー・セッションの作り直し（世代が変わる） |
| hook: claude / codex / copilot | hook の 1 回の要求（route が受けた 1 リクエスト）。`prompt_id` はターンの id なので使わない（claude は `tool_use_id` が `PermissionRequest` に無い: `src/lib/hooks/sources/claude/source.ts:165`） | その 1 リクエスト | 別のリクエスト |
| hook: agy | **(`conversationId`, `stepIdx`)**（`measurements-2026-10-20.md` §2: 会話の中では一意、起動し直すと 2 から始まるので会話の id と組にする） | 同じ組 | 別の組 |
| API: opencode / opencode-v2 | `PendingDecision.id`（`per_…`） | 同じ id | 別の id |
| `/prompt-response` | 送った時点の画面キー（route が再確認したフレームから作る） | — | — |

**`generatePromptKey()`（`type:question`、`src/lib/detection/prompt-key.ts`）を識別に使わない。** 重複の判定（`isDuplicatePrompt()`、`src/lib/polling/auto-yes-poller-generation.ts:198`）はこれを使っているが、claude の「Do you want to proceed?」のように質問が同じでコマンドだけ違う確認を 1 件に潰す。画面キーは `approvalTarget`（承認対象のコマンド）を含むので分けられる（受入基準の陰性「2 つの呼び出しを 1 件に潰さない」）。

**画面だけでは分けられない場合（限界として記録する）**: 同じコマンドの確認が、`gone` の tick（2 秒間隔、`POLLING_INTERVAL_MS` = `src/lib/auto-yes-state.ts:914`）を挟まずに 2 回続くと、画面の材料だけでは 1 件に見える。このとき:
- 答えを送った後も同じ画面キーが 10 秒（`DUPLICATE_RETRY_EXPIRY_MS`）を超えて残り、poller が再試行したら、**同じ確認への 2 回目の試行**として数える（§2.5）。新しい確認にはしない
- 解消が見えないまま終わった確認は `resolution: 'unresolved-after-send'` として別に数え、「答えて解消した」に入れない（陰性「配送の失敗を回答済みにしない」）
- hook の材料（agy の `stepIdx`）があるツールは、画面キーより hook の識別を優先する（§2.4）

### 2.2 存在と回答可否の 2 軸（必須 1）

第 1 版は「確認の無い tick（`noteNoPromptOnScreen()`）＝解消」としていたが、agy は受信窓（8 秒）の外では確認が画面に残っていても `isPrompt: false` で返る（`auto-yes-poller.ts:739-743`）。これを解消と読むと、同じ確認・同じ停止を tick ごとに閉じては開き直す。そこで記録の状態を 2 つの軸に分ける。

| 軸 | 値 | 何で決めるか |
|---|---|---|
| 存在（`presence`） | `present` | 門を通した検出（`isPrompt: true`）か、**門を通さない読み取り**（agy は `detectPromptOnCleanFrame()` の専用リーダー、他のツールは門の前の検出）で、同じ画面キーの確認が見えた |
| | `gone` | 画面を読めた tick で、門を通した検出・通さない読み取りの**どちらにも**確認が無い、または別の画面キーが見えた。hook の要求なら応答の完了（§2.3）、opencode なら `settled` |
| | `unobservable` | Auto-Yes OFF・期限切れ・`stop-pattern` などでポーラーが止まっている。**この間は確認を閉じない**。capture の失敗（画面を読めない tick）は存在を変えない: その tick は確認の行を出さず、次に読めた tick が決める（一時的な失敗のたびに区間を割らないため） |
| 回答可否（`answerability`） | `answerable` | 門が開いていて、方針も止めていない |
| | `withheld` | 理由つき（`AutoYesSuppressionReason` の語彙、`src/lib/polling/auto-yes-suppression-reason.ts:9-76`。加えて記録だけの `send-failed`・`send-no-keys`（§2.5）と `foreign-session`（他のサーバーのセッション、#2865）・`moved-send-in-flight`（ID の移動で運ばれた送信を待つ、#3713）・`answered-recently`（重複の抑止、#306: 同じ質問に答えてから 10 秒は答えない））。agy の `no-hook-receipt`（受信窓の外）もここ |

- 確認を閉じるのは**存在が `gone` になったときだけ**（と §4.2 の放棄）。回答可否が `answerable`↔`withheld` を行き来しても確認は閉じない
- agy の受信窓: 窓の中（`isPrompt: true`、`answerable`）→ 窓の外（`isPrompt: false` だが専用リーダーが確認を見る: `present`・`withheld(no-hook-receipt)`）→ 次の受信で窓の中、と続いても **1 件の確認**。停止の区間は `withheld` の間だけで、同じ理由が続く限り 1 区間（受入基準、§7 PR 1）
- 門を通さない読み取りが無いツール・経路では、今の `noteNoPromptOnScreen()` の判断（`isPrompt: false`）を `gone` とする（今の挙動と同じ）
- 記録の入口は、`isPrompt: false` の分岐でも存在の判断を受け取れるように、`logIfWithheldForWantOfReceipt()` の読み直しの結果（確認を見たか・画面キー）を返り値で受ける（§7 PR 1。答え方は変えない）

### 2.3 hook の要求と確認の待ちを分ける（必須 2）

hook の要求の記録（`hookRequestId`、§3.3）と確認の記録（`confirmationId`）を別にする。**`hookRequestId` は hook の route（`src/app/api/hooks/permission-request/route.ts`）だけが発行し、`resolvePermissionRequest()` には引数で渡す。** API の裁定（`permission-adjudication.ts:103` も `resolvePermissionRequest()` を呼ぶ）は id を渡さないので、hook の要求を作らない（opencode の承認要求は §2.4 の `PendingDecision.id` で確認として開く）。

| hook の結果 | hook の要求の記録 | 確認の記録 | 停止の区間 |
|---|---|---|---|
| allow、ツールが `permissionAllowSuppressesDialog: true`（claude / codex / copilot、§5.1） | 応答を書いた時点で閉じる（`outcome: 'allow'`） | **要求がそのまま確認**。開いて `decide(answer, L1)`・試行 `ok`・`closed(resolved-by-reply, resolvedBy: 'auto')` を同時に書く | なし |
| allow、`permissionAllowSuppressesDialog: false`（agy・command-code） | 応答を書いた時点で閉じる（`outcome: 'allow'`、`allowSuppressesDialog: false`） | 開かない。確認は画面に出たときに画面の経路で開き、結べるときは `hookRequestId` を付ける（agy は PR 3 の `callId`） | 画面の確認の側で数える |
| 棄権: `policy-suppressed`（契約の抑止）・`auto-yes-disabled`・`ask-user-question` | **応答を返した時点で閉じる**（`outcome: 'abstained'`、`abstainReason`）。要求の側では待ちの時間を持たない | 開かない。画面に確認が出たら画面の経路で開き、結べれば `hookRequestId` と `afterHookAbstain: <理由>` を付ける | **画面の確認の側だけで数える**（二重に数えない規則） |
| 判定できない（`unknown-payload`・`worktree-unresolved`） | 閉じる（`outcome: 'abstained'`） | 開かない | — |

**二重に数えない規則**: 待ちの時間（停止の区間）を持つのは確認の記録だけ。hook の要求の記録は「受けた・何を返した・応答に何ミリ秒かかった（`replyMs`）」だけを持ち、集計は要求の記録から停止の時間を足さない。

**結び付けられないとき**:
- 棄権した要求の後に画面の確認を観測できなかった（人がポーラーより先に答えた・Auto-Yes OFF でポーラーが止まっていた・確認を出さないツールの呼び出しだった）: 要求の記録だけが残る。集計は `hookAbstained`（理由別の**件数**）として数え、**時間は数えない**（待ちの長さを観測していないので、0 秒とも書かない）
- 画面の確認を、どの要求の後か結べなかった（agy の PR 3 より前、claude / codex / copilot の allow 後の安全確認など）: 確認は画面の確認として 1 件、要求も 1 件のまま。件数は `hookRequests` と `confirmations` に別々に入り、足し合わせない。`afterHookAllow` / `afterHookAbstain` は、同じインスタンスで直前 8 秒以内に要求があったという**事実だけ**を添え、同じ呼び出しだとは断定しない
- `auto-yes-disabled` の棄権は Auto-Yes の停止ではない（Auto-Yes が止めたのではなく OFF だった）。停止の区間にも `withheld` にも入れない

**Auto-Yes の OFF→ON で同じ確認を見たとき**: OFF（`manual`・`expired`・`not-enabled`）でポーラーが止まっても確認は閉じず、存在を `unobservable` にして、開いている停止の区間を `end: 'unobservable'` で終える。ON に戻ってポーラーが同じセッションの世代・同じ画面キーを見たら、**同じ `confirmationId` のまま**存在を `present` に戻し、止めるなら**新しい区間**を開く（区間は有効期間ごとに分かれる）。ON に戻ったときに確認が無ければ `closed(resolution: 'gone-while-unobservable', resolvedBy: 'unknown')` とする（消えた時刻は分からないので、`unobservableMs` を別に持ち、停止の時間には入れない）。

### 2.4 経路をまたぐ結び付け

| ツール | 結び方 |
|---|---|
| claude / codex / copilot | hook の allow で確認は出ない（`auto-yes-per-agent-target.md`「hook でできること」）。§2.3 の 1 行目のとおり要求がそのまま確認。claude は allow の後に自身の安全確認を出すことがある（`measurements-2026-10-20.md` §4 の 139 件）。この画面の確認は**別の確認**として開き、`afterHookAllow: true` を添える。**同じ呼び出しかどうかは断定しない**（基本方針 第 2 部「claude の L2」は保留。照合は先の Issue） |
| agy | hook の `PreToolUse`（`(conversationId, stepIdx)`）の要求と、画面の確認を `callId` で結ぶ（PR 3）。受信のエピソード（`antigravity-receipt-episodes.ts`）が「この確認はどの受信で受理したか」を既に持っているので、受信記録に `callId`（`conversationId:stepIdx`）を持たせ、エピソードが受理した受信の `callId` を画面の確認に付ける。確認を閉じるのは **(a) 存在が `gone`（§2.2）か (b) その `stepIdx` の `PostToolUse` が来た**のどちらか早い方。「No, cancel」では `PostToolUse` も `Stop` も来ない（`measurements-2026-10-20.md` §2）ので、(b) だけでは閉じない。画面で確認を観測しないまま `PostToolUse` が来たら、要求の記録に `dialogUnobserved: true` を付ける（§2.6。「確認は出なかった」とは書かない） |
| command-code | hook は確認に答えた後に届く（`measurements-2026-10-20.md` §3）。画面の確認だけで識別し、hook は結び付けない（`tool_use_id` を後から添えるのは、この Issue の範囲外） |
| opencode / opencode-v2 | `PendingDecision.id` で開き、`adjudicatePendingPermission()` の `delivered` を試行の結果、`settled` を解消にする |
| gemini / vibe-local | 画面の確認だけ（hook の判定は無い） |

**中継が `stepIdx` を落としている件**: `scripts/hooks/cmate-agent-event.sh` は `pre_tool_use` / `post_tool_use` で `toolCall.name` だけを `detail` に入れ（216-223 行）、本文には `tool`・`event`・`cwd`・`sessionId`（agy は `conversationId`、179-196 行）・`worktreeId`・`instanceId`・`detail` しか載せない。`stepIdx` を本文に足し、受け口（`src/app/api/hooks/agent-event/route.ts` → `readEventDetail()` `src/lib/hooks/agent-event-intake.ts:265`）で読む必要がある（§7 PR 3。既にある hook の本文に欄を足すだけで、hook は足さない）。`PreToolUse` 側は中継を通らず（`src/lib/hooks/sources/antigravity/hooks-config.ts` の説明 51-70 行）、`parseAntigravityPermissionRequest()`（`src/lib/hooks/sources/antigravity/source.ts:122-145`）が `conversationId` を `sessionId` に入れ、`stepIdx` を読んでいないだけなので、`PermissionRequestPayload` に `callId` を足して読む。

### 2.5 送信の試行（必須 3）

確認ごとに試行の列を持つ。最後の値だけを持つと「失敗 → 再試行で成功」の失敗が消えるため。

- **`attemptId` = `<confirmationId>.<n>`**（n は確認の中の連番）。`confirmationId` と `attemptId` は**送信の await の前**に取り、既存の `AutoYesSendAttempt`（`beginSendAttempt()`、`auto-yes-poller-state.ts:323`）に欄として持たせる。結果を書くときは、持っているオブジェクトの id を使い、**キーや画面から引き直さない**（#3713 の「tick はキーではなくオブジェクトを持つ」と同じ規則。worktree の ID が移っても元の確認に属する）
- 試行の結果:

| 結果 | 条件（画面） | 停止の理由 |
|---|---|---|
| `ok` | `sendPromptAnswer()` が戻った | — |
| `partial` | 中断され、`keysSent === true`（キーの一部が画面にある。#3706） | `partial-answer`（今と同じ。`auto-yes-suppression-reason.ts:46`） |
| `no-keys-sent` | 中断・失敗で、`keysSent === false`（キーを 1 つも送っていない） | `send-no-keys`（記録だけの理由）。**`partial-answer` にしない** |
| `failed` | throw して `keysSent` が分からない（`keysSent` を持たない例外。世代が生きている失敗でも、`keysSent === true` なら #3839 から上の `partial`、`false` なら `no-keys-sent` として記録する — `settleFailedTick()` の `attemptResultOfThrow()`） | `send-failed`（記録だけの理由） |

  hook の試行は「応答を書けた → `ok`／書けなかった → `failed`」、opencode は `delivered` で `ok` / `failed`、`/prompt-response` は API の結果（`success: false`・500 は `failed`）。
- **区間**: 最初の `partial` / `no-keys-sent` / `failed` で停止の区間を始める（それより前に `withheld` の区間が開いていれば、理由の変化として続ける）。後の試行が `ok` になったら区間を終える。`ok` の後に同じ確認が再び止められたら（重複の抑止・方針の変化など）、**新しい区間**を開く
- **遅れて戻った結果**: 送信の await の間に確認が閉じた（停止・再有効化・世代交代・`gone`）場合でも、結果は**元の `confirmationId` の試行**として `auto-yes-confirmation-attempt-settled` の行を `late: true` で出す。閉じた確認を開き直さず、解消・停止の時間も変えない。`closed` の行は**閉じた時点の状態**（`answeredAtClose`: 閉じる前に `ok` の試行があったか、`attemptsPending`: 結果が戻っていない試行の数）だけを書き、後から分かった配送の結果は `late` の行が持つ（N1）。集計は、遅れて戻った `ok` を `answered` に入れず `answeredLate` に数え、**`late` の行の時刻の窓**に入れる（確認を閉じた日と別の日になってもよい）
- 既存の `settleSendAttempt()` は、期限切れ（`state: 'expired'`）・世代が変わった試行の部分送信を記録しない（`auto-yes-poller-state.ts:343-360`）。計測の記録はこれと**判断を揃え**、`expired` の試行の結果も `late: true`・`expired: true` で行に残す（キーが画面に届いたかどうかの事実は残すが、`partialAnswers` の扱いは今のまま）

### 2.6 解消と、観測できなかったこと（必須 4）

- **`resolution`**（どう終わったか、観測の事実）: `resolved-after-answer`（`ok` の試行の後に `gone`。開いていた区間が `answered-recently` だけのときも含む）・`resolved-while-withheld`（止めている間に `gone`）・`resolved-by-reply`（hook の allow で確認を出さないツール）・`unresolved-after-send`（試行の後、解消を見ないまま放棄）・`gone-while-unobservable`（§2.3）・`resolved-before-decision`（答えも止めもしないうちに `gone`。Enter の補いの 1 回目の tick、人が先に答えた、など）・`abandoned`（§4.2）
- **`resolvedBy`**（誰が消したか）: 因果を確かめられたときだけ値を書く。`auto` は hook の返事で確認を出さないツールの allow（返事そのものが解消）と、opencode の `delivered` の後の `settled` だけ。`human-ui` は `/prompt-response` が人の答えを送り、その結果が成功だったときだけ。**画面のキー送信の後に消えた場合は `resolution: 'resolved-after-answer'`（観測の事実）とし、`resolvedBy` は `unknown`**（端末で人が先に押した・エージェントが取り消した、と区別できない）
- **`dialogUnobserved`（確認未観測）**: hook の要求の後、画面で確認を観測しないまま呼び出しが終わったもの（agy の `PostToolUse` が先に来た、など）。これは「確認が出なかった」ではない。`PreToolUse` から `PostToolUse` の間に人が確認に答え、ポーラーが画面を取り逃した場合と区別できないため。集計は `dialogUnobserved` として、**CLI 自身の自動許可（§3.4）とも、CommandMate の回答とも別に**数える

---

## 3. 記録の置き場所

### 3.1 選択肢の比較

| 案 | 利点 | 欠点 | migration |
|---|---|---|---|
| A. DB の新しい表（`auto_yes_confirmations` など） | 再起動しても残る。SQL で何日分でも集計できる。将来の UI・API から読める | 書き込みが hook のハンドラ（エージェントが返事を待っている）と poller の tick の中に入る（better-sqlite3 は同期）。保存期間と掃除を新しく決める必要がある。agent-health の metrics が**本番の DB を読む**ことになる（今は本番ログ・`ps`・`GET /api/worktrees` だけ: `docs/user-guide/agent-health.md:416`） | **要**（`CURRENT_SCHEMA_VERSION` 61 → 62、`src/lib/db/migrations/runner.ts:27`） |
| B. 既存の表への列（`chat_messages` の `prompt_data` に欄を足す） | JSON の欄なので migration が要らない。今の `answeredBy` の行に根拠の段を足せる | 止めた区間・理由の変化・配送の失敗は「答えた行」に対応しない（行が無い・1 件に複数の出来事）。`chat_messages` は利用者に見える履歴で、計測のための行を混ぜると History・チャット面（`src/lib/chat/chat-tool-approvals.ts`）の表示が変わる。pending 行の付け替え（`recordAnsweredPrompt`）の規則に縛られる | 不要 |
| C. 構造化ログ＋日次集計 | 書き込みは 1 行の出力だけ。migration が要らない。agent-health は既に本番ログを 1 回読んで `hook-observation`（#3311）を出しており、同じ形に乗る（`src/lib/agent-health/hook-observation.ts`・`metrics-perf.ts:155`・`scripts/agent-health/metrics-runners.ts:696`）。「サーバーが区間の始まりを持ち、終わりに長さつきの 1 行を出す」形も `detection-divergence-resolved` で前例がある | ログはサイズでローテートされ、3 世代しか残らない（`scripts/start.sh:192` の `rotate_logs`。起動時だけ）。再起動で、開いていた確認・区間はメモリと一緒に消える（閉じる行が出ない）。API・UI からは読めない | 不要 |

### 3.2 決定: C（構造化ログ＋日次集計）

理由:
1. 受入基準が求める出力先は agent-health の日次で、agent-health は本番ログを読む仕組みを既に持っている。DB を読ませると、本番の DB に触れる経路が増える（隔離の失敗で本番 DB を掴んだ前例がある）
2. 書き込みが DB の書き込みとして hook の返事・キー送信の経路に入らない。§8 の「記録の例外で回答を失敗させない」を構造で守りやすい（遅延の保証は §8.1 のとおり実測まで書かない）
3. 今は「何件・何分か」を数えたいだけで、過去の任意の日を SQL で引く要件は無い。API・UI から過去の記録を読めないことは、この用途では受け入れる
4. migration が要らないので、記録をやめる・語彙を変えるときの戻しが軽い

**長期の保存先**: agent-health の日付ごとの結果 `~/.commandmate/agent-health/metrics/<date>.json`（`docs/user-guide/agent-health.md:674`）。`metrics-state.json`（同 454 行）は前回値で、履歴の置き場所にはしない。

C の欠点への手当て:
- **再起動**: 開いている確認は 1 時間ごとの checkpoint で途中の累積を残し、最後の checkpoint までの時間は数える（§4.3）
- **ローテート・ログの欠損・ログ水準**: 計測の有無を示す行（§4.4）で、計測があった時間だけを分母にする。計測が無い時間は 0 件ではなく「計測なし」
- **API・UI から読めない**: 「今止まっているか」は今の `lastPolicySuppression` が引き続き答える（§4.5）。表示を変えるのは #3821（判定の結果を事実と判断に分けて共有する）の範囲

`chat_messages` の `answeredBy` は**今の意味のまま残す**（History・`capture --prompts` の表示の正本。計測の正本にはしない）。例外は §5 の agy の allow の行だけ。

**未決（実装の前に決める）**: ログの行を本番の既定（`info`、`src/lib/env.ts:329`）で出すか。`info` で出す前提で書いた。`CM_LOG_LEVEL=warn` の利用者では生存の行も出ないので、集計は「計測なし」と出す（0 件と誤らない。§4.4）。

### 3.3 ログの行（語彙。PR 1 で全経路分を固定する）

ログのモジュール名は `auto-yes-confirmation-ledger`（`AUTO_YES_LEDGER_LOG_MODULE`。poller の他のモジュールと同じ短い名前。書き手は新しいモジュール `src/lib/polling/auto-yes-confirmation-ledger.ts`、§7 PR 1）。`[time] [LEVEL] [tag] event {json}` の形（`src/lib/logger.ts:203` `formatLogEntry`、agent-health の `TEXT_LINE` が読む形）。すべての行に `bootId`・`ledgerVersion`（語彙の版、PR 1 で `1`）・`atMs`（サーバーの時刻、ミリ秒）を載せる。

**`bootId` の持ち方（推奨 7）**: `bootId`・確認の `Map`・連番・hook の要求の `Map` を、**1 つの `globalThis` の状態**（`getOrInitGlobal('__autoYesConfirmationLedger', …)`、`src/lib/global-state.ts`。`auto-yes-poller-state.ts` の `__autoYesSendAttempts` と同じ書き方）に置く。モジュールを読み込むたびに作らないので、`next dev` の別の束ね・再読み込みでは同じ `bootId` が続き、プロセスが変わったときだけ変わる。

| イベント | いつ | 主な項目 |
|---|---|---|
| `auto-yes-ledger-started` | 記録のモジュールが最初に使われ、状態を作った（プロセスで 1 回） | `bootId`・`logLevel`・`paths`（この版が記録する経路: `screen` / `hook` / `api` / `prompt-response` / `agy-link`。§6.4） |
| `auto-yes-ledger-alive` | 1 時間ごと（UTC の時刻の境目） | `bootId`・`logLevel`・`segments`（経路ごとの計測区間 `[{ path, startMs, endMs }]`。`startMs` は同じ `bootId` の前の生存の行か記録の開始、`endMs` はこの行の時刻）・`openConfirmations`・`openIntervals`・`ledgerErrors`（記録の中で握りつぶした例外の、プロセスの中の累計。§8.1） |
| `auto-yes-confirmation-opened` | 確認を初めて見た／受けた | `confirmationId`・`worktreeId`・`cliToolId`・`instanceId`・`source`（`screen` / `hook` / `api` / `prompt-response`）・`promptType`・`callId`（あれば）・`hookRequestId`（結べたとき）・`afterHookAllow` / `afterHookAbstain` |
| `auto-yes-withhold-started` | 停止の区間を開いた | `confirmationId`・`intervalId`（`<confirmationId>#<n>`）・`cliToolId`・`source`・`reason`・`startedAtMs` |
| `auto-yes-withhold-reason-changed` | 区間の中で理由が変わった | `confirmationId`・`intervalId`・`cliToolId`・`source`・`from`・`to` |
| `auto-yes-withhold-ended` | 区間を閉じた | `confirmationId`・`intervalId`・`cliToolId`・`source`・`startedAtMs`・`endedAtMs`・`withheldMs`・`end`（`answered` / `gone` / `unobservable` / `stopped` / `abandoned`。`stopped` は改訂 4）・`lastReason` |
| `auto-yes-confirmation-attempt-settled` | 試行の結果が戻った | `confirmationId`・`attemptId`・`basis`・`result`（`ok` / `partial` / `no-keys-sent` / `failed`）・`late`・`expired` |
| `auto-yes-confirmation-presence-changed` | 存在が `present`↔`unobservable` に変わった | `confirmationId`・`from`・`to`・`cause`（停止の理由など） |
| `auto-yes-confirmation-checkpoint` | 1 時間ごと（UTC の時刻の境目）、開いている確認ごと。**復元できるスナップショット** | `confirmationId`・`cliToolId`・`source`・`presence`・`answerability`・`withheldMsTotal`（その時点までの累積）。区間が開いていれば `intervalId`・`reason`（今の理由）・`intervalStartedAtMs`・`intervalMs`（その区間のその時点までの長さ） |
| `auto-yes-confirmation-closed` | 解消・放棄 | 識別＋`decision`・`basis`・`attempts`（結果別の数）・`attemptsPending`・`answeredAtClose`・`resolution`・`resolvedBy`・`openMs`・`withheldMsTotal`・`unobservableMs`・`intervals`（区間の数）・`abandonReason` |
| `auto-yes-hook-request-closed` | hook の要求に応答を返した | `hookRequestId`・`cliToolId`・`outcome`（`allow` / `abstained`）・`abstainReason`・`allowSuppressesDialog`・`replyMs`・`callId`・`dialogUnobserved`（PR 3 で後から 1 行足すときは `auto-yes-hook-request-dialog-unobserved`） |
| `auto-yes-cli-mode-observed` | §3.4（PR 2） | `worktreeId`・`cliToolId`・`instanceId`・`sessionEpoch`・`mode`・`change`（`first` / `changed`）。識別は内部のログだけで、日次の `details` には件数だけを出す |

- 1 件の確認は、止めなければ `opened` と `closed`（と試行の行）、止めれば区間ごとに 2 行（理由が変わればもう 1 行）。止めている間の tick ごとの行は出さない（今の WARN は `warnOncePerFrame` で 1 画面 1 回、`suppressAndWarnOnce()`）。開いている確認は 1 時間に 1 行の checkpoint を足す
- 各行は固定の大きさに限る: 文字列は語彙か id だけで、質問・コマンド・パスを載せない。配列を持たない（理由の履歴は `reason-changed` の行で表す）
- **集計に使う時間は、サーバーが区間の始まりと終わりの時刻から計算した値（`withhold-ended` の `startedAtMs` / `endedAtMs`、checkpoint の累積）だけ。** ログの行の間隔から停止の時間を推定しない（`review-codex.md` R9 の陰性「ログの一分間隔をそのまま停止時間にする集計」）

### 3.4 CLI 自身の自動許可との区別（必須 6: 観測できる範囲に限る）

- claude の auto モード・`bypassPermissions` では `PermissionRequest` が来ず、確認も出ない（`measurements-2026-10-20.md` §8）。これは CommandMate の Auto-Yes ではないので、**確認として数えない**
- **新しい hook は足さない。** claude の `PreToolUse` は `AskUserQuestion` だけの登録で（`hook-settings-generator.ts:485-491`、答えを出せる hook を広げない理由もそこに書いてある）、Bash などの呼び出しの数は今の hook では数えられない。第 1 版の「`pre_tool_use` の件数を出す」「中継に `permission_mode` を足す」は取り下げる
- 今の hook で取れるイベントだけを定義する:

| イベント | 取れる経路 | 記録 |
|---|---|---|
| モードの観測 | claude の `PermissionRequest` の `permission_mode`（`permission-request-payload.ts:109`） | インスタンスごと・セッションの世代ごとに、最初に見えたとき `auto-yes-cli-mode-observed(change: 'first')` |
| モードの変更 | 同じ。前に見えた値と違う値が来たとき | `change: 'changed'`。**次の `PermissionRequest` が来るまで変更は見えない**（auto / bypass に切り替えた後は `PermissionRequest` 自体が来ないので、切り替えはほぼ見えない） |
| セッションの終了 | hook ではなくサーバーのセッションの世代（`beginAgentSession` の世代交代・kill。§4.2 の放棄と同じ契機） | 覚えていたモードを忘れる（行は出さない。モードは世代に属する） |

- 不明の数の母集団は**窓の中で識別できたインスタンス**（記録の行に `worktreeId`・`instanceId` が出たもの）に限る。母集団が分からない（識別できる行が無い）ときは数値を出さない
- 見えないものは**不明**とする。モードが一度も見えていないインスタンス、codex（`approval_policy`）・command-code（`.commandcode/settings.local.json` の `permissions`・`defaultMode`）・agy は、すべて `unknown` として数え、**0 件とは書かない**。hook が来ないことを auto モードの証拠にしない（基本方針 第 2 部）
- 日次の欄（§6.2）は「**観測できた範囲**」と明記し、CommandMate の回答の件数とは足さない
- codex・command-code のモードを知る方法（hook の本文に載るかの実測）はこの Issue の範囲外とし、§9 に残す

---

## 4. 停止の区間

### 4.1 持ち方

- 区間は**確認に従属する**。1 件の確認は 0 個以上の区間を持つ（必須 2・3: 有効期間ごと、回答の成功の後に再び止めたとき、で分かれる）。確認と別の表は作らない
- メモリの記録（§3.3 の `globalThis` の状態。`Map<confirmationId, LedgerEntry>`、インスタンスごとに開いている確認の索引つき）に、`presence`・`answerability`・開いている区間（`intervalId`・`since`・`currentReason`）・閉じた区間の累積（`withheldMsTotal`）・試行の列（結果別の数と、戻っていない試行の id）を持つ
- `globalThis` に置くのは今の `auto-yes-suppression-state.ts` と同じ理由（書き手が hook の route と poller で、`next dev` では別々に束ねられる: 同ファイル 45-61 行）

### 4.2 開始・終了・理由の変化

| 出来事 | 区間への作用 | 確認への作用 |
|---|---|---|
| 初めて `withheld` と判断 | 区間を開く（`withhold-started`） | — |
| 次の tick も同じ理由で `withheld` | 何もしない（同じ確認の複数 tick は 1 件・1 区間。陽性の受入基準） | — |
| 違う理由で `withheld` | `withhold-reason-changed` を 1 行 | — |
| agy の受信窓の外（`isPrompt: false`、専用リーダーが同じ確認を見る） | `withheld(no-hook-receipt)` として上の 3 行と同じ | 存在は `present` のまま。**閉じない**（必須 1） |
| 試行が `partial` / `no-keys-sent` / `failed` | 区間が無ければ開く。あれば理由の変化（§2.5） | 試行の数を増やす |
| 試行が `ok` | 区間を閉じる（`end: 'answered'`） | — |
| `ok` の後に同じ確認を再び `withheld` | **新しい区間**を開く | — |
| 存在が `gone` | 区間を閉じる（`end: 'gone'`） | 閉じる（§2.6 の `resolution`） |
| Auto-Yes OFF・期限切れ・`stop-pattern`・`consecutive-errors`（`AutoYesPollerStopReason`、`src/config/auto-yes-config.ts:97`） | 区間を閉じる（`end: 'unobservable'`） | 存在を `unobservable` に。閉じない（§2.3 の OFF→ON） |
| 同じ停止の下の API の確認（opencode の承認。画面では見ていない。改訂 4） | 区間を閉じる（`end: 'stopped'`）。OFF の間は区間に入れない（OFF の後に戻った配送の失敗でも開かない。次の再裁定から新しい有効期間） | 存在は `present` のまま。閉じない（返事でまだ決着する） |
| ON に戻り、同じ世代・同じ画面キーを見た | 止めるなら新しい区間 | 存在を `present` に戻す |
| ON に戻り、確認が無い | — | `closed(gone-while-unobservable)` |
| セッションの終了（`session-killed`・`instance-removed`・`worktree-deleted`・`orphan-swept`・`invalid-key`、`src/lib/auto-yes-lifecycle.ts:110-118`）・セッションの世代交代 | 区間を閉じる（`end: 'abandoned'`） | `closed(abandoned)`、`abandonReason` に停止の理由 |
| `unobservable` のまま 24 時間 | — | `closed(abandoned, abandonReason: 'unobservable-timeout')`（記録を持ち続けない） |
| `forgetPolicySuppression()`（契約が変わった、#3796） | 区間は閉じない。次の tick の判断で理由が変わるか答えるかで決まる | — |
| サーバーの停止（`shutdown`） | 行は出せない前提で扱う（§4.3） | — |

### 4.3 当日の停止の時間（必須 5）

**決定: 閉じた確認の集計ではなく、当日（集計の窓）の停止の時間を測る。**

- **checkpoint**: 記録のモジュールは、UTC の時刻の境目（`atMs` が 3,600,000 ms の倍数になる時刻。JST の 0 時もこの格子に乗る）ごとに、開いている確認それぞれについて `auto-yes-confirmation-checkpoint` を 1 行出す。格子は固定で、集計の窓（`PERF_LOG_WINDOW_HOURS` = 24、`metrics-types.ts:95`）の取り方に依存しない。生存の行（§4.4）も同じ時刻に出す
- **窓の終わりを揃える**: 集計の窓 `[s, e]` の `e` は、集計の時刻以前で最後の**完了済みの時刻の境目**（記録が動いていれば最後の checkpoint・生存の行の時刻）に揃え、`s` = `e` − 24 時間とする。その後の未確定の末尾（境目から集計の時刻まで）は数えない（次の日の窓は `e` から始まるので、そこに入る。改訂 5）
- **`intervalId` 単位で突き合わせる**: 集計は窓 `[s, e]` の中の行（`atMs` で判定）だけを使う。`s` は共有の読み込みの窓より最大 1 時間前なので、`addLogLine()` は記録の行だけを 1 時間前まで渡す（改訂 5）。区間ごとに `withhold-started`・`withhold-reason-changed`・`withhold-ended`・checkpoint を `intervalId` で集め、窓の中の長さ =
  - `withhold-ended` がある: `[max(startedAtMs, s), min(endedAtMs, e)]`
  - `withhold-ended` が無く checkpoint がある: `[max(intervalStartedAtMs, s), 最後の checkpoint の時刻]`（窓の終わり `e` は最後の境目なので、これで窓の終わりまで）
  - ツール・`source`・理由はどの行にも載っているので、前日に始まった区間でも窓の中の行だけで内訳に入れられる。理由は区間の最後の理由（`withhold-ended` の `lastReason`、無ければ最後の checkpoint の `reason`）で数える
  - 最後の checkpoint の後に区間が終わり、同じ確認で新しい区間が始まっても、`intervalId` が違うので取り違えない
- **再起動で消えた確認**: 同じ `confirmationId` の `closed` が無く、窓の終わりの checkpoint にも無いもの（その `bootId` の生存の行が途切れた。別の `bootId` が現れない、止まったままのサーバーも含む。改訂 5）。**最後の checkpoint（または最後の行）までの時間は数え**、それ以降は不明として `lostOnRestart`（件数だけ）に出す
- **未完了の件数**: 窓の終わりに開いている確認は `openAtWindowEnd`（件数）と、その窓の中の停止の時間（上の切り出し）を出す。閉じた日に全部の長さが入る第 1 版の案はやめる
- **並べ方（推奨 7）**: 集計は行を `atMs`（なければ行の時刻）で並べ直してから状態を作る。ログを読む順（最新の `server.log` → ローテート済みの `.1`・`.2`）は時系列ではない

### 4.4 計測の有無（必須 5・推奨 8）

導入前・ログ水準の変更・ログの欠損（ローテート・再起動の隙間）を 0 件と扱わないため:

- `auto-yes-ledger-started`（プロセスで 1 回）と `auto-yes-ledger-alive`（1 時間ごと、checkpoint と同じ格子）を出す。生存の行は「その区間、記録のモジュールが動いていた」の意味で、`bootId` と経路ごとの計測区間 `segments` を持つ
- 集計は生存の行の `segments` を経路ごとに足して **`coveredMsByPath`**（窓で切る）とし、窓の長さ `windowMs` との差を欠損の時間として出す。**生存の行 1 つで 1 時間を計測済みにしない**: 区間の始まりは同じ `bootId` の前の生存の行か記録の開始で、途中から始まったプロセスはその時刻から数える。比率・中央値などは計測があった時間を分母にする
- 比べられるか: 経路ごとの計測の時間が窓と違う（途中で経路が増えた・欠損がある）・`ledgerErrors` が窓の中で増えた、のどれかなら `partial: true`
- 窓の中に計測区間が無ければ（`coveredMs` が 0）、`auto-yes-observation` は **skip（計測なし）** にして 0 件と出さない。生存の行は直前の区間を表すので、窓の始まりの境目にある生存の行だけでは窓の中を計測したことにならない（改訂 5）
- 生存の行が来ない原因（ログ水準が `warn` 以上、記録のモジュールが無い版、ログの欠損）は区別しない。どれも「計測なし」
- 生存と checkpoint の時計は、**記録のモジュールが最初に使われたとき**に 1 つだけ張る（次の時刻の境目までの `setTimeout` を繰り返し、`unref` してプロセスの終了を妨げない）。時計は `globalThis` の状態に置き、再読み込み・2 回目の呼び出しで二重にしない。`server.ts` は変えない（評価時の import を増やすと Next の起動が壊れる前例がある）ので、最初の確認より前の時間は計測なしになる。新しいプロセスは起動しない

### 4.5 今の「最後の 1 件」との関係

`recordPolicySuppression()` と `getLastPolicySuppression()` は**消さない**。読み手（`capture --json`・`cmate wait`・通知の保留）の契約で、「今止まっているか・なぜか」を答えている。計測の記録はその隣に足すもので、`suppressAndWarnOnce()` など書き手の共通の入口から両方を呼ぶ。読み手を計測の記録へ移すかは #3821（判定の結果の共有）で決める。

---

## 5. agy の hook の allow の監査記録の意味の直し方

### 5.1 決定

1. **ソースの能力に `permissionAllowSuppressesDialog`（allow を返すと確認が出ないか）を足す。** claude・codex・copilot は `true`、agy は `false`（1.1.12・1.1.27・1.4.2 で実測）、command-code は `false`（hook が確認の後に届く）、opencode / opencode-v2 は API で承認するので `true`、gemini は未実測なので `false`。ツール名での分岐にしない（`reportPendingDialog` が `permissionHookPredictsDialog` で分けているのと同じ書き方: `permission-decision-service.ts:421-433`）
2. `resolvePermissionRequest()` の allow の記録（536-538 行）は、この能力が `true` のときだけ `recordAllowedPermission()` で「答えた」行を書く。**`false` のときは `chat_messages` に行を書かない。** 確認が出れば画面の poller が `auto` の行を書くので、二重の記録が消える。計測の記録には hook の要求（`outcome: 'allow'`、`allowSuppressesDialog: false`）として残し、確認には数えない（§2.3）。**hook に allow を返したことは確認への回答ではない**
3. agy で画面の確認を観測しないまま `PostToolUse` が来た場合（利用者の許可リスト・`read_file`・ポーラーの取り逃し）は、要求の記録に **`dialogUnobserved: true`** を付け、**「CommandMate が答えた」にも「確認が出なかった」にも数えない**（§2.6）
4. ログの `permission-request-decided`（`route.ts:288`）の項目に `allowSuppressesDialog` を足し、ログだけ読んでも「hook が allow した」と「確認への回答」を分けられるようにする

### 5.2 なぜ行を書かないのか（比較した案）

| 案 | 内容 | 判断 |
|---|---|---|
| (a) 行を書かない（採用） | 画面の回答の行が正本になる | 564 件の二重の記録が消える。確認を観測しなかった呼び出しは CommandMate の回答とは言えないので、履歴に「Auto-Yes が許可した」と出さない方が正しい |
| (b) 行を書くが意味を変える（`status: 'answered'` をやめ、`hookVerdict` などの新しい欄） | 履歴に hook の判定が残る | `PromptAnsweredBy` / 表示（`src/components/worktree/ChatToolApprovalGroup.tsx`・`src/lib/chat/chat-tool-approvals.ts:531-545`）・`capture --prompts`（`src/cli/commands/capture.ts:229,272`）の読み方を全部直す必要がある。計測は §3 のログで足りる |
| (c) 今のまま | — | 方針の 4 節に反する |

**注意（実装の契約に書く）**: (a) は利用者に見える履歴から agy の hook の行が消える変更。changelog に書く。確認が出て人が答えた場合は、人の回答の行が残る。

---

## 6. agent-health の日次の集計

### 6.1 出し方

`hook-observation`（#3311）と同じ形の **metrics の指標を 1 つ足す**: `auto-yes-observation`。

- `METRIC_IDS` に足し、category は `process`（`src/lib/agent-health/metrics-types.ts:12-30,58`）。`process` は fail にならず、`candidates` は常に空（Issue を立てない）。何を候補にするかは、2 週間ほど数字を見てから別の Issue で決める（`hook-observation` と同じ扱い: `docs/user-guide/agent-health.md:421-422`）
- 読むのは metrics が既に 1 回読んでいる本番ログ（`metrics-perf.ts` の `addLogLine` が行を配る。`hook-observation` は 155 行で受けている）。同じ読み込みに `addAutoYesObservationLine()` を足す。行は集めてから `atMs` で並べ直して状態を作る（§4.3）
- 窓は直近 24 時間（`PERF_LOG_WINDOW_HOURS`）。窓の中に計測区間が無いときは skip（§4.4）
- 結果は他の指標と同じく `metrics/<date>.json` に残る（長期の推移の置き場所、§3.2）
- 公開リポジトリなので、`details` と `records` に載せるのは**件数・時間・ツール名・根拠の段・理由のコード（列挙された語彙だけ）・モードの語彙**。worktree・インスタンス・確認の id・コマンド・質問の文面は写さない。語彙に無い値は `(other)` にまとめる（`metrics-perf.ts` の扱いと同じ）

### 6.2 中身

`value` = 窓の中の停止の時間の合計（分、`withheldMinutes`）。計測なしなら skip。

`details`（窓の合計）:

| 欄 | 意味 |
|---|---|
| `coveredMsByPath` / `coveredMs` / `windowMs` / `gapMs` / `partial` / `pathsMissing` / `ledgerErrors` | 経路ごとの計測があった時間（`screen 86400000 / hook 0 / …` の文字列）・その最大・窓の長さ（完了済みの境目まで）・欠損の時間（窓 − `coveredMs`）。比べられなければ `partial: 1`（`details` は真偽値を持てないので `1` / `0`）と、`coveredMs` より短い経路（カンマ区切り）。`ledgerErrors` は窓の中で増えた記録の例外の数（§4.4・§6.4） |
| `confirmations` / `confirmationsClosed` / `openAtWindowEnd` | 窓の中で開いていた確認の数・その中で閉じた数・窓の終わりに開いている数 |
| `answered` / `answeredLate` | 閉じる前に `ok` の試行があった確認の数（`closed` の `answeredAtClose`。**`partial` / `no-keys-sent` / `failed` だけの確認は含めない**）と、閉じた後に `ok` が戻った試行の数（`late` の行の時刻の窓で数える。`answered` には足さない） |
| `answeredByHuman` | `/prompt-response` の人の回答（basis `human`）で閉じた確認の数。Auto-Yes の回答ではないので `answered` に足さない（改訂 6） |
| `attemptsOk` / `attemptsPartial` / `attemptsNoKeysSent` / `attemptsFailed` / `attemptsLate` | 試行の結果別の数（遅れて戻った結果を含む。`attemptsLate` はその内数） |
| `resolvedAfterAnswer` / `resolvedWhileWithheld` / `resolvedByReply` / `resolvedBeforeDecision` / `unresolvedAfterSend` / `goneWhileUnobservable` / `abandoned` | §2.6 の `resolution` 別 |
| `resolvedByAuto` / `resolvedByHumanUi` / `resolvedByUnknown` | §2.6 の `resolvedBy` 別 |
| `withheldConfirmations` / `withheldIntervals` / `withheldIntervalsUntimed` | 窓の中に停止の区間があった確認の数・時間を切り出せた区間の数・開始を復元できない区間の数（理由変更の行だけが残った。時間は足さない。改訂 5） |
| `withheldMsTotal` / `withheldMsMedian` / `withheldMsP90` / `withheldMsMax` | 窓の中に切り出した停止の時間（§4.3）の合計と、区間ごとの分布 |
| `lostOnRestart` | 再起動で閉じなかった確認の数（時間は最後の checkpoint までを上に含め、以降は不明） |
| `hookRequests` / `hookAllowed` / `hookAbstained` | hook の要求の数と結果別（`hookAbstained` は理由別の内訳を `records` に。時間は持たない、§2.3） |
| `dialogUnobserved` | 確認未観測（§2.6）。CommandMate の回答とも、CLI 自身の自動許可とも足さない |
| `cliModeObserved` / `cliModeUnknownInstances` | **観測できた範囲**のモード別のインスタンス数（`PermissionRequest` で見えたものだけ。`worktreeId`・`instanceId`・`sessionEpoch` で数え分ける）と、窓の中で識別できたインスタンスのうち見えていない数（不明。0 とは書かない。識別できたインスタンスが無ければ数値を出さない）。CommandMate の回答とは足さない |

`records`（内訳の行。`ci-flaky` と同じく表として持つ）:
- 回答: `{ kind: 'answered', tool, basis, count }`（ツール別・根拠の段別の回答数）
- 試行: `{ kind: 'attempt', tool, basis, result, count }`
- 停止: `{ kind: 'withheld', tool, reason, intervals, totalMs, maxMs, reasonChanged, untimed }`（理由別。区間の最後の理由で数え、理由が変わった区間の数は `reasonChanged`、開始を復元できない区間の数は `untimed` として別に数える）
- hook の棄権: `{ kind: 'hook-abstained', tool, reason, count }`
- モード: `{ kind: 'cli-mode', tool, mode, instances }`（`mode` は観測した語彙か `unknown`）

`summary`（1 行）: `停止 Xm（確認 N 件・区間 N）／回答 N（試行の失敗 N）／計測 Hh/24h[・部分計測]`。`metrics-rules.ts` の `hookObservationSummary` と同じ置き場所（`src/lib/agent-health/metrics-rules.ts:461-464`）に `case 'auto-yes-observation'` を足す。

### 6.3 文書

`docs/user-guide/agent-health.md` の指標の表（391 行の `hook-observation` の行の隣）と説明（421 行からの節の後）、`docs/agent-health/metrics-prompt.md:68`（観測だけの指標の列挙）に足す。英語版の agent-health の文書は無い（`docs/en/` に該当なし）。

### 6.4 部分計測と、基準値として使える時点（推奨 8）

生存の行の `segments` が、その版の記録している経路と計測区間を示す。集計は経路ごとの計測の時間（`coveredMsByPath`）を窓と比べ、欠けた経路・途中から加わった経路を `pathsMissing` に出し、`partial: true` とする（和集合では見ない。23 時間は `screen` だけで最後の 1 時間だけ全経路の日は `partial`）。

| 入った PR | `paths` | 数字の扱い |
|---|---|---|
| PR 1 のみ | `screen` | 画面の経路だけ。PR 4 が無いので集計は無い（ログにだけある） |
| PR 1＋PR 4 | `screen` | **ここから画面の経路の数字を基準値として使える**（停止の時間・試行の失敗・ツール別の回答）。hook・API は `pathsMissing` |
| ＋PR 2 | `screen`・`hook`・`api`・`prompt-response` | hook・API・ブラウザの自動回答の数字が加わる。agy の hook の要求と画面の確認はまだ結べない（`afterHookAllow` の事実だけ）ので、`agy-link` は `pathsMissing` |
| ＋PR 3 | 上＋`agy-link` | agy の確認と要求が 1 件に結ばれ、`dialogUnobserved` が出る。全経路が揃い `partial: false` |

基準値の比較（#3821 以降の効果を見るとき）は、同じ `paths` の日どうしでだけ行う。

---

## 7. 実装の PR 分割

5 本。順序: **PR 1 → (PR 2 と PR 4 は並行可) → PR 3 → PR 5**。

### PR 1: 記録の土台・全経路共通のログの仕様・画面の経路（poller）

- 変更ファイル:
  - 新規 `src/lib/polling/auto-yes-confirmation-ledger.ts`（`globalThis` の状態＋ログの出力。入口はすべて例外を外へ出さない）と `src/lib/polling/auto-yes-confirmation-ledger-types.ts`（§3.3 の**全経路の語彙をこの PR で型として固定**し、hook・API の行は PR 2・3 が同じ記録のモジュールで出す）
  - `src/lib/auto-yes-poller.ts`（`detectAndRespondToPrompt` の開く・判断・試行・解消、`noteNoPromptOnScreen` の存在の判断、`settleFailedTick` の試行の結果、`stopAutoYesPolling` の `unobservable` / 放棄、再試行）
  - `src/lib/polling/auto-yes-poller-state.ts`（`AutoYesSendAttempt` に `confirmationId`・`attemptId`）
  - `src/lib/polling/auto-yes-prompt-suppression.ts`（`suppressAndWarnOnce` から停止を記録。`suppressIfNotOursToAnswer` の `ours` に門の判定を載せて根拠の段を決める）
  - `src/lib/polling/auto-yes-poller-steps.ts`（`resolveAnswerUnderPolicy`・`withheldForEarlierSend`）
  - `src/lib/polling/auto-yes-poller-enter-fallback.ts` / `tryEnterFallback`（根拠 `enter-fallback`）
  - `src/lib/polling/auto-yes-poller-receipt-log.ts`（`logIfWithheldForWantOfReceipt` が読み直しの結果を返し、agy の受信窓の外を `present`・`withheld(no-hook-receipt)` として記録）
  - 時計（生存と checkpoint）は記録のモジュールが最初に使われたときに張る（`server.ts` は変えない）
  - テスト: `tests/unit/polling/auto-yes-confirmation-ledger.test.ts`（新規）、poller の既存テストの隣に経路のテスト
- 根拠の段の決め方（PR 1 の範囲）: 門の判定が `gated && allowed && dialog` なら `L3`、`gated: false`（`legacy` のツール・`yes_no`）なら `L4`、Enter の補いは `enter-fallback`。agy の専用リーダーが読んで受信で受理した確認は、PR 3 までは `L3` とし `receiptAccepted: true` を添える（agy の門は `legacy` なので、poller が同じ文字列を専用リーダーで読み直して決める。読めなければ汎用の推定で `L4`）
- 受入基準:
  - 陽性: 同じ確認が 5 tick 続き、止めたまま解消 → `opened` 1 行・区間 1 つ・`closed` 1 行。区間の長さは最初の判断から解消まで
  - **陽性（必須 1）: agy で同じ確認が「受信窓の中 → 外（`isPrompt: false`、専用リーダーは確認を見る）→ 外 → 次の受信で中」と続く → 確認 1 件・停止の区間 1 つ**（閉じて開き直さない）。陰性: 専用リーダーでも確認が見えない tick → 閉じる
  - **陽性（必須 3）: 試行 1 が `failed`・試行 2 が `ok` → 試行の行 2 つ、区間は試行 1 で始まり試行 2 で終わる。`ok` の後に同じ確認を重複の抑止で止める → 新しい区間**
  - **陰性（必須 3）: `keysSent === false` の中断 → `no-keys-sent`、理由は `send-no-keys`（`partial-answer` にしない）。`keysSent === true` → `partial`**
  - **陽性（必須 3）: 送信の await の間に `stopAutoYesPolling(…, 'session-killed')` で確認が閉じる → 結果は元の `confirmationId` の `late: true` の行。確認は開き直さない。worktree の ID が移っても元の `confirmationId`**
  - **陽性（必須 2）: Auto-Yes OFF（`manual`）→ ON で同じ画面キーを見る → 確認 1 件・区間 2 つ（OFF の間は区間に入れない）。ON に戻ったとき確認が無い → `gone-while-unobservable`**
  - **陽性（必須 5）: 区間が UTC の時刻の境目を 2 回跨ぐ → checkpoint 2 行、累積が単調に増える。時計を 2 回張っても 1 つ（再読み込み）**
  - 陽性（推奨 7）: モジュールを読み込み直しても `bootId` と連番が続く
  - 陰性: 質問が同じで `approvalTarget` が違う 2 つの確認が続く → 2 件
  - 記録の関数・ロガーが throw しても、`detectAndRespondToPrompt` の戻り値・キー送信・既存のログと `lastPolicySuppression` は変わらない（記録とロガーを throw させる差し替えで確かめる。§8.1）
  - 既存の poller のテストは期待値を変えずに通る（答え方は変えない）
- 依存: なし

### PR 2: hook・API・`/prompt-response` の経路と、allow の監査記録の意味

- 変更ファイル:
  - `src/lib/hooks/sources/types.ts`（`AgentSourceCapabilities` に `permissionAllowSuppressesDialog`）（`AgentSourceCapabilities` は 344 行）と各ソース（`claude`・`codex`・`copilot`・`antigravity`・`command-code`・`opencode`・`opencode-v2`・`gemini`、`legacy-relay.ts` も。宣言は `define-source.ts` を通る）
  - `src/lib/hooks/permission-decision-service.ts`（hook の要求の記録と §2.3 の規則、能力が `false` なら `recordAllowedPermission` を呼ばない、`permissionMode` の観測 §3.4）
  - `src/app/api/hooks/permission-request/route.ts`（`permission-request-decided` に `allowSuppressesDialog`、要求を閉じる行）
  - `src/lib/hooks/permission-adjudication.ts`（opencode の試行と解消）
  - `src/hooks/useAutoYes.ts` と `src/app/api/worktrees/[id]/prompt-response/`（本文に `origin: 'auto-yes-browser'` を足し、計測の記録で `browser` と人を分ける。**`answeredBy` は変えない**。#3821 でブラウザの自動回答をやめるまでの基準の数字を取るため）。`origin` の定数は client から読める `src/lib/prompt-response-body-builder.ts` に置き、`useAutoYes.ts` は記録のモジュールを import しない
  - `src/lib/hooks/sources/opencode/ingest.ts`・`opencode-v2/ingest.ts`（`permission.replied` で opencode の確認を閉じる。改訂 3）
  - 整合性レビューの分（改訂 4）: `src/lib/hooks/sources/pending-decisions.ts`（`answerPendingDecision` の `onReceipt`）、`src/lib/auto-yes-poller.ts`（`stopAutoYesPollingByWorktree` から `noteLedgerWorktreeStopped`）、`src/cli/types/api-responses.ts`（capabilities の写し）、CLI ガイド（ja・en）の `capture --json` の例、`docs/design/multi-agent-state-architecture.md` §4 D3 の能力の表
  - テスト: 能力の表のテスト（`tests/unit/hooks/sources/capabilities.test.ts`。全ソースが宣言している）、agy の allow で行を書かないこと、claude の allow で今までどおり行を書くこと（陰性）、**hook の route と `/prompt-response`・opencode の配送で、記録とロガーを throw させても応答の本文・状態コードが変わらない故障注入のテスト（推奨 9）**
- 受入基準:
  - claude / codex / copilot の allow → hook の要求 1 件と確認 1 件（`L1`・`resolved-by-reply`・`resolvedBy: 'auto'`）、`chat_messages` の行 1 行（今と同じ）
  - agy の allow → `chat_messages` に行を書かない。hook の要求（`allowSuppressesDialog: false`）だけが残り、確認には数えない
  - **棄権（`policy-suppressed`・`auto-yes-disabled`・`ask-user-question`）→ 要求は応答の時点で閉じ、時間を持たない。後の画面の確認が停止の区間を持つ。要求と確認の停止の時間を足すと二重になるような行を出さない**
  - `PermissionRequest` の `permission_mode` が来る → `cli-mode-observed(first)`、違う値 → `changed`。来ないツール・インスタンスは `unknown`
  - `/prompt-response` の `origin` 付き → `basis: 'browser'`、無し → 人。配送の失敗（`success: false`・500）は `failed` の試行で、回答に数えない
  - opencode の配送の失敗（`delivered: false`）は `failed` の試行で、回答に数えない
  - Auto-Yes OFF（`manual`）で、止めていた API の確認の区間は `end: 'stopped'` で閉じ、確認は開いたまま。OFF の間は checkpoint の停止の時間に入らない（改訂 4）
  - API の配送の間に確認が閉じたら、戻った結果はその確認の `late: true` で、確認を開き直さない（改訂 4）
  - poller の無い API の確認も、worktree の削除で `abandoned(worktree-deleted)` になる（改訂 4）
  - hook の配送のヘルパーが握りつぶした失敗（`decide` の throw）は、本文はそのままで、要求 `abstained(delivery-failed)`・試行 `failed` と記録する（改訂 4）
  - **陰性（N2）: API の裁定（`permission-adjudication.ts` から `resolvePermissionRequest()`）は hook の要求の行を出さない（`hookRequestId` は hook の route だけが発行する）。opencode の承認要求 1 件 → 確認 1 件・hook の要求 0 件**
- 依存: PR 1（記録のモジュールと語彙）

### PR 3: agy の確認の識別（`stepIdx`）と、hook の要求と画面の確認の結び付け

- 変更ファイル:
  - `src/lib/hooks/permission-request-payload.ts`（`callId` の欄）、`src/lib/hooks/sources/antigravity/source.ts`（`stepIdx` を読み `conversationId:stepIdx` を `callId` に）
  - `src/lib/polling/antigravity-permission-receipts.ts`（受信記録に `callId`）、`src/lib/polling/antigravity-receipt-episodes.ts`（受理した受信の `callId` を返す）
  - `scripts/hooks/cmate-agent-event.sh`（`post_tool_use` で `stepIdx` を本文に。**`permission_mode` は足さない**: 必須 6 の決定）、`src/lib/hooks/agent-event-intake.ts` と受け口（読む）
  - 中継のテスト（`tests/unit/scripts/cmate-agent-event.test.ts` ほか同じ接頭辞のもの）、受け口のテスト、記録の結び付けのテスト
- 受入基準:
  - agy で `PreToolUse(allow, stepIdx=25)` → 画面の確認 → poller が答える → `PostToolUse(stepIdx=25)` が、**hook の要求 1 件と、`callId` で結ばれた確認 1 件**として記録される（今の受信窓のままなので `basis` は `L3` + `callId`。L2 の照合は保留の項目）
  - 陰性: 同じコマンドの 2 回の呼び出し（`stepIdx` 25 と 27）は 2 件
  - 陰性: 確認で「No」→ `PostToolUse` が来ない → 画面から消えた時点で閉じる（`resolvedBy: 'unknown'`）
  - 画面で確認を観測しないまま `PostToolUse` → 要求に `dialogUnobserved: true`。確認は開かない
  - 中継が `stepIdx` の無い古い本文でも今までどおり受け付ける（後方互換）
- 依存: PR 1・PR 2（能力と hook の記録）

### PR 4: agent-health の日次の集計

- 変更ファイル:
  - 新規 `src/lib/agent-health/auto-yes-observation.ts`（純関数: 行 → 測定）
  - `src/lib/agent-health/metrics-types.ts`（`METRIC_IDS`・`METRIC_CATEGORY`）、`metrics-perf.ts`（行を配る）、`metrics-rules.ts`（`summary`）、`scripts/agent-health/metrics-runners.ts`（`fromServerLog`）
  - `docs/user-guide/agent-health.md`・`docs/agent-health/metrics-prompt.md`
  - テスト: 行の fixture から `details` / `records`（`os.tmpdir()` に置いたログで）
- 受入基準:
  - PR 1 の語彙の行から、ツール別・根拠の段別の回答数と、理由別の停止の件数・時間が出る
  - **窓の初めより前に始まり窓の中で閉じた区間・窓の終わりに開いている区間 → 窓の中の長さだけが入る（checkpoint と `withhold-ended` の `startedAtMs` から。前日の行を読まない）**
  - **再起動（`bootId` が変わる）で閉じなかった確認 → 最後の checkpoint までの時間を数え、`lostOnRestart` に件数**
  - **陰性: 窓の中に生存の行が無い → skip（0 件と出さない）。生存の行が窓の半分だけ → `coveredMs` は半分**
  - **陰性（推奨 7）: 最新のログ → ローテート済みのログの順に読んでも、時刻で並べ直した結果と同じ（読み込みの順を逆にした対照）**
  - 陰性: 行の間隔を停止の時間にしない。`failed` / `partial` / `no-keys-sent` だけの確認を回答に数えない。`hookAbstained` に時間を付けない。`details` に id・パス・文面が載らない
  - **陰性（N1）: 同じ窓で「確認が閉じる → 遅れた `ok`」→ `answered` 0・`answeredLate` 1。遅れた `ok` が翌日の窓 → その日の `answeredLate` に入る**
  - **前日に始まり理由が変わらないまま止まり続けた区間 → 窓の中の checkpoint だけでツール別・理由別の内訳に入る。最後の checkpoint の後に区間が終わり新しい区間が始まる → `intervalId` で取り違えない。窓の終わりは最後の境目に揃う**
  - **生存の行の `segments` が 23 時間 `screen` だけ・1 時間だけ全経路 → `partial: true`。境目の直後に始まったプロセスの最初の生存の行 → その時刻からの分だけ計測済み。`ledgerErrors` が窓の中で増えた → `partial: true`**
  - `segments` に `screen` しか無い窓 → `partial: true`・`pathsMissing` に `hook` ほか
  - 知らない根拠の段・理由・モードは `(other)` にまとまる（PR 2・3 が後から足す値で壊れない）
- 依存: PR 1（ログの語彙）。PR 2・3 より先にマージしてよい（部分計測として表示される。§6.4）

### PR 5: 横断テスト（PR 3 の後）

- 変更ファイル: テストだけ（`tests/integration/` に記録の横断テスト。サーバー・tmux は起動せず、route のハンドラと poller の 1 tick を直接呼ぶ）
- 受入基準:
  - agy: hook の要求（allow）→ 画面の確認 → 配送（試行 `ok`）→ 解消（`gone`）が、要求 1 件・`callId` で結ばれた確認 1 件・区間 0 として通しで記録され、PR 4 の集計で 1 件の回答になる
  - **claude の「allow だけ」**: hook の要求（allow）→ 画面に確認が出ない → 要求 1 件・確認 1 件（`resolved-by-reply`、`resolvedBy: 'auto'`）
  - **claude の「棄権の後の画面」**: hook の要求（`policy-suppressed`）→ 画面の確認を止める → 解消 → 要求 1 件（`hookAbstained`、時間なし）・確認 1 件（区間 1 つ、`afterHookAbstain`）
  - **claude の「allow の後の別の画面」**: hook の要求（allow）→ 直後に安全確認が画面に出て poller が答える → 要求 1 件・確認 **2 件**（hook の確認と、`afterHookAllow: true` の画面の確認）
  - **API の裁定**: opencode の承認要求 → 確認 1 件・hook の要求 0 件
  - **人の先行回答**: hook が棄権 → 画面に確認が出る前に人が答える → 要求 1 件（`hookAbstained`、時間なし）・確認 0 件
  - **人の先行回答（画面）**: 確認を止めている間に人が端末で答える → `resolved-while-withheld`・`resolvedBy: 'unknown'`
  - **終了イベントの欠落**: agy で「No」（`PostToolUse` が来ない）・サーバーの再起動（`closed` が出ない）→ それぞれ `gone` での閉じ、`lostOnRestart`
- 依存: PR 1〜4

---

## 8. 影響（動作・性能・DB の書き込み量）と、失敗の扱い

### 8.1 回答を失敗させない（推奨 9）

- 記録の入口はすべて `try { … } catch { … }` で包み、**throw しない**。`catch` の中ではロガーを呼ばず（二次ログも失敗し得る）、`globalThis` の状態の `ledgerErrors` を増やすだけにする。数は生存の行（§3.3）に出す。`catch` の中の数え上げも、例外を出さない演算だけにする
- ログの出力（`logger.info`）自体も記録のモジュールの中で `try` に入れる（`src/lib/logger.ts:252-262` は server 側で `console.log` / `console.warn` を同期に呼ぶ）
- 呼ぶ位置は、判断が決まった後・キー送信が戻った後で、判断の分岐の条件には使わない（記録は読むだけの側。今の `lastPolicySuppression` の説明「Exposure only: nothing reads this to make a decision」と同じ）
- 記録は固定の大きさ（§3.3: 語彙と id だけ、配列を持たない）に限り、1 回の記録で出す行は高々数行
- **保証の範囲**: 実測するまでは「**記録の例外で、回答・hook の返事・tick を失敗させない**」までを保証とする。`console` への同期出力は、標準出力の先（ファイル・パイプ）によっては書き込みを待つので、「I/O 待ちが無い」「遅延が増えない」とは書かない。遅延は §8.3 の手順で実測し、問題があれば別の Issue で非同期の出力を検討する
- 故障注入のテストを poller（PR 1）・hook の route と `/prompt-response` と opencode の配送（PR 2）に置く

### 8.2 ポーラーの動作・性能

- 1 tick あたりの追加はメモリの `Map` の参照と比較だけ。行を出すのは確認の開閉・区間の開閉・理由の変化・試行の結果のときと、1 時間ごとの checkpoint だけで、止めている間の tick ごとには出さない
- メモリ: 開いている確認だけを持ち、閉じたら消す（`unobservable` のままは 24 時間で閉じる、§4.2）。戻っていない試行は id だけを持つ。インスタンスごとに開いている確認は通常 1 件。念のため上限（例: インスタンスあたり 16 件・全体 1,024 件）を置き、超えたら古いものを `abandoned(capacity)` で閉じる
- **未決**: 上限の値。今の稼働（同時のインスタンス数十）では届かない値を置く想定で、実装の PR で決める

### 8.3 書き込み量

- DB への書き込みは**増えない**（§3.2 の C）。PR 2 で agy の allow の行が無くなる分、`chat_messages` への INSERT は減る（`auto-yes-per-agent-target.md` の数え方で 2026-08-01〜10-20 に 564 行）
- ログ: 確認 1 件につき `opened`・`closed`・試行 1 行が基本で、止めれば区間ごとに 2 行。hook の要求は 1 行。過去の件数（同資料: claude の hook 5,461・codex の hook 12,832 が 81 日、画面の回答は多い日で command-code 約 300/日）から、多い日でも 1 日に 1,000 件前後 → 4,000〜5,000 行。checkpoint と生存は 1 時間に（開いている確認の数＋1）行。`LOG_VOLUME_ALERT_LINES`（1 つの名前で 20,000 行/日、`metrics-types.ts`）を 1 つのイベント名で超えない。増え方は `log-volume` で確かめる
- **実機で測る手順（この契約では測らない）**: PR 1 を入れた隔離サーバー（`CM_DB_PATH` と private HOME を `os.tmpdir()` 配下に置き、`lsof` で本番の DB を掴んでいないことを確かめる）で、claude と agy のインスタンスに Auto-Yes を ON にして確認が出る作業を 1 時間させ、(1) `auto-yes-*` の行数、(2) `poller:response-sent` の行数との比、(3) tick の所要時間と hook の `elapsedMs`（既存のログ）の前後差を見る。(3) が §8.1 の遅延の実測になる

---

## 9. 未決の一覧

| 項目 | 選択肢 | 決め方 |
|---|---|---|
| ログの行の水準（§3.2） | `info`（案）/ `warn` | 利用者の `CM_LOG_LEVEL` の実態。今は `info` で進める案。`warn` 以上では生存の行も出ず「計測なし」になる（§4.4）ので、0 件と誤ることは無い |
| codex・command-code・agy の「自身の自動許可」の知り方（§3.4） | hook の本文 / 設定ファイルを読む / 書かない（今は `unknown`） | 別の Issue で hook の本文を測る（私設 tmux `-L cmprobe-*` と scratchpad のフォルダで素の CLI を起動し、自前の受け口で全 hook の本文を保存して、モードを切り替えたときに変わる欄を探す） |
| 開いている確認の上限（§8.2） | 値 | PR 1 で決める |
| claude の安全確認と、直前の hook の allow が同じ呼び出しか（§2.4） | — | 基本方針 第 2 部「claude の L2」で保留。この Issue では `afterHookAllow` を添えるだけ |
| 日次の数字の候補化（§6.1） | — | 2 週間の数字を見てから別の Issue |
| 記録の出力の遅延（§8.1） | 同期のまま / 非同期の出力 | §8.3 の実測の後 |

**閉じた未決**（第 1 版から）:
- 長い停止を閉じる前に見せるか → 1 時間ごとの checkpoint で当日の停止の時間を測る（§4.3、必須 5 の決定）
- CLI 自身の auto モードの件数 → 今の hook で観測できる範囲に限り、見えないものは `unknown`（§3.4、必須 6 の決定）
