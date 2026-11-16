# Issue #4418 L2: relay の見張りを `flow tick` に置く（設計）

- 状態: 設計＋実装（L2）。L1（PM の送信の入口を relay つきに限る）・L3（team.md・雛形）は別 PR
- 目的: PM の依頼の返しの見張りを PM のセッションの外（launchd で 15 分ごとの `node scripts/flow/flow.mjs tick`）に置く。PM が忘れても・落ちても効く
- 実装: `scripts/flow/relay-watch.mjs`（判定・記録）、`scripts/flow/relay-io.mjs`（サーバーの読み・PM への 1 行）、`scripts/flow/flow.mjs`（tick から呼ぶ）、`scripts/flow/config.mjs`（`relayWatch`）、`scripts/flow/runner.mjs`（許可する呼び出し）。試験は `tests/unit/scripts/flow/relay-watch-4418.test.ts`

## 1. 前提（事実。実コードで確かめた）

- relay は `commandmate send --reply-to` / `ask --async` で開き、`from`（依頼元）・`to`（受け手）・`state`（`pending`・`prompt`・`delivered`・`expired`・`cancelled`）・`inputBoundaryAt`（受け手の入力欄に打ち始めた時刻）・`holdReason`・`deliveryHold`・`expiresAt` を持つ（`src/cli/types/api-responses.ts` の `RelayView`）
- `GET /api/relays?worktree=<pm>&instance=<pm>` の `awaiting` は PM が待っている開いた relay、`held` は保留、`closedBlocked` は期限切れの知らせが届いていない閉じた relay。閉じた relay の一覧は無く、1 本ずつ `GET /api/relays/:id` で読む
- **受け手の履歴（`chat_messages`）は送り手を持たない**（`SendMessageRequest` に送り手の欄が無い）。relay つきの送信では、受け手の行の `timestamp` が relay の `inputBoundaryAt` と同じ入力の開始時刻になる（`send-user-message.ts` の `userMessageTimestamp`）
- 依頼元に配送された返事は依頼元の履歴に `requestId: relay:<id>`、relay の system 行は `relay-sys:<id>:…` で残る
- CommandMate 本体の relay・API・DB の形は変えない。読むのは API だけ（DB のファイルを開かない。サーバーが止まっていれば「未知」）

## 2. 設定（`.commandmate/flow.yaml` の `relayWatch`）

```yaml
relayWatch:
  pm: { worktreeId: mycodebranchdesk, instanceId: claude }   # PM のセッション（必須）
  receivers:                                                 # PM だけが送る受け手（1〜32、必須）
    - { worktreeId: mycodebranchdesk, instanceId: claude-2 }
    - { worktreeId: mycodebranchdesk, instanceId: claude-3 }
  pendingMinutes: 60     # 既定 60（1〜1440）
  screenMinutes: 20      # 既定 20（1〜1440）
  notifyNoRelay: false   # 検査 1 を PM へ知らせるか。既定 false（記録だけ。§5.1）
  # url: http://localhost:3000   # 省略時 http://localhost:${CM_PORT:-3000}。localhost 以外は exit 2（token を送るため）
```

- 節が無ければ tick は今までと同じ（子を起こさない・見張りの記録を書かない）。知らないキー・型の誤りは今までの設定と同じく exit 2（排他の前、何も書かない）
- token は環境の `CM_AUTH_TOKEN`（引数に載せない）

## 3. 『PM から届いた依頼』の決め方

- 受け手の履歴は送り手を持たないので、**送り手の見分けはセッションで行う**: `receivers` は team.md §1・§2 で PM だけが依頼を送るセッション（ジャッジ `claude-2`・開発リーダー `claude-3`）。そこに届いた依頼の行を PM からの依頼とみなす
- 依頼の行: `role: user`・`messageType: normal`・本文が `[from ` で始まらない（受け手自身の relay の返事の配送）・`/` で始まらない（`/clear` などの命令）・`requestId` が `relay:`／`relay-sys:` でない・直近 24 時間
- **限界（未解決）**: PM 以外の送り手（agent-health の dispatch が `claude-3` に送る朝の依頼、人の直接の入力）も同じ行になり区別できない。知らせに本文の先頭 40 文字を入れ、PM が判断する。送り手を記録する変更は本体の形を変えるのでこの PR ではしない

## 4. 3 つの検査（`evaluateWatch`、純関数）

### 4.1 relay の無い依頼（`noRelay`）
- relay の無い依頼 = 依頼の行に、`from = pm`・`to = その受け手` の relay が結び付かない。結び付き: `|inputBoundaryAt − 行の時刻| ≤ 5 秒`、`inputBoundaryAt` が無い古い relay は `createdAt ≤ 行の時刻 ≤ createdAt + 120 秒`
- 突き合わせる relay: 今の `awaiting`・`held`・`closedBlocked`、PM の履歴（直近 200 行）の `relay:`／`relay-sys:` の ID を 1 本ずつ読んだもの、前の tick の記録が覚えている relay（26 時間）。開いたまま 15 分以上生きた relay は tick が見て覚え、15 分より早く閉じた relay は返事が PM の履歴に残る
- 0 件は `unobserved`（「未観測」。0 件の確定ではない）。受け手の履歴を読めなければ `unknown`
- **当面は記録だけで、知らせない**（§5.1）。PM は #4420 が入るまで素の `send` を使うため、知らせると毎回の誤報になる

### 4.2 進まない relay（`stall`）
- `from = pm` で `state: pending`、`inputBoundaryAt`（無ければ `createdAt`）から `pendingMinutes` 以上、かつ受け手の画面が `screenMinutes` 以上変わらない
- 画面の変化: `GET /api/worktrees/:id/current-output` の `fullOutput` から ANSI を除き、数字の並びを `#` に置き換えた後の sha256。前の tick の記録の `screens[<wt>/<inst>]` と同じなら `since` を引き継ぎ、違えば今にする。**tick の観測の間だけ**を見るので、最初の観測からは鳴らない（15 分ごとなら早くて 3 回目）。経過時間の表示だけの変化は進みに数えない
- 画面を読めない受け手の候補があり見つからなければ `unknown`
- **(A) 動いている証拠があれば STALL にしない**（PM の観測: 開発リーダーの画面が 30 分変わらず手作りの見張りが STALL と出したが、実際はバックグラウンドの shell 2 本で検証を待つ正常な待機だった）。画面が不変でも、次のどれかがあれば `stall.waiting` に証拠つきで記録し、知らせない。読むのは既存の API だけ（本体は変えない）:
  - `session-running`: `current-output` の `sessionStatus` が `running`（処理中）
  - `thinking`: `current-output` の `thinking`
  - `background-pending`: hook の最後のイベントが `stop` で detail が `self_resume_pending`（claude が背景の shell・task を残してターンを終えた。`SELF_RESUME_PENDING_DETAIL`）
  - `background-footer`: 画面の末尾 6 行（空行を除く）に背景の shell・task の数（`2 shells`・`1 background task` など）。本文の途中の「3 tasks」は数えない
  - `recent-hook-event`: `stop`・`session_end` 以外の hook のイベントが `screenMinutes` 以内（終わりのイベントは仕事の証拠ではない）
  - `verify-running`: 受け手の worktree の `GET /api/worktrees/:id/verify/runs?limit=5` に `running` の run がある
  - 欄が無い（古いサーバー）・読めないときは証拠なしとして扱う（鳴る側に倒す）
  - 限界: リーダーがワーカーの worktree の検証を待つ場合、その run はワーカーの worktree にあり受け手の worktree の run としては見えない。そのときの証拠は背景の shell（`background-pending`・`background-footer`）だけ
- **(B) 誤検出の扱い**: 知らせる文に根拠を書く（`STALL の疑い … 根拠: pending N 分・画面 M 分不変・動いている証拠なし。待機中の可能性は残る。capture で確かめて`）。同じ relay は鍵 `stall:<id>` で 1 回だけ。証拠つきの待機が `4 × pendingMinutes`（既定 240 分）を超えたら、別の鍵 `stall-long:<id>` で証拠の名前を添えて 1 回だけ知らせる（終わらない待機を黙らせない、2 段目）

### 4.3 保留・期限切れ（`heldOrExpired`）
- 保留: `held` の `deliveryHold.state = uncertain`（`held:<id>:<payloadId>`）、`awaiting` の `holdReason`（`hold:<id>:<理由>`）
- 期限切れ: `expiresAt` を過ぎた開いた relay、`closedBlocked`、id で読んで `state: expired`（直近 24 時間）
- `attempting`・`delivered`・`cancelled`・PM が依頼元でない relay は鳴らさない

## 5. 知らせ先と繰り返さないこと

- PM の入力欄へ relay の返事と同じ形（`[from <alias> / <worktree>]` の見出し）で **1 行**: `[from flow-watch / <pm の worktree>] relay の見張り（flow tick）で新しく N 件: …（記録: <file>）`。5 件まで名前を出し、残りは件数。`POST /api/worktrees/:pm/send`（既存の送信。配送の安全は既存の `send` に任せる。今動いている PM の世代に固定して送る: §5.2）
- 各件は鍵（`no-relay:<行 id>`・`stall:<relay id>`・`stall-long:<relay id>`・`held:…`・`hold:…`・`expired:<relay id>`）を持つ。記録の `reported` にある鍵は送らない（同じ件を tick ごとに繰り返さない）。今も続く鍵と、**その tick で読めずに決められなかった鍵**を `reported` に残す。忘れるのは「読めて、条件を外れた」（解消）ときだけ（消えてまた出たら、もう一度知らせる）
- 読めなかった（unknown）と解消を分ける: 受け手の画面だけが読めない（`current-output` の 500 など）ときは、その画面の hash と「いつから同じか」を前の tick から引き継いで `unread` の印を付け、その受け手への relay の STALL はその tick では決めない（`stall` は `unknown`。`stall:<id>`・`stall-long:<id>` を残す）。受け手の履歴が読めなければ `no-relay:*`、保留・期限切れの一覧が読めなければ `held:*`・`expired:*`、id で読めなかった relay（上限 50 件を超えた分を含む）は `expired:<id>` を残す。子全体の失敗は今までどおり前の状態をそのまま引き継ぐ
- 送る前に見張りの行（試行の印）を書く。書けなければ送らない。結果が分からない送信（時間切れ・サーバー停止）も送ったものとして繰り返さない（#4367 の PR-N の条件に合わせた）。サーバーが送らなかったと答えた送信（`not_sent`: PM が止まった・入れ替わった・固定の根拠が無い）は、次の tick がその `relay-watch-notice` 行を読んで鍵を `reported` から外し、もう一度送る
- PM のセッションが動いていない（`current-output` の `isRunning` が真でない）ときは送らず、鍵を `reported` に入れない（次の tick で送る）。送信でセッションを起こさない（§5.2）

### 5.2 送信で PM を起こさない（Codex レビュー P2-1）

- 問題: `isRunning` を読んでから送るまでに PM が止まると、素の `POST /send` は停止中のセッションを起動する（`src/app/api/worktrees/[id]/send/route.ts` の `if (!running)` → `startSessionForSend`）
- 既存の API だけで閉じる経路: send の `expectedRole: { injectionFingerprint, sessionGeneration }`（#4116。何も保存しない条件）。`sessionGeneration` を付けた送信は、PM が動いていなければ起動の**前**に `refuseGonePinnedProcess` が 409 `role_condition_unmet` で断り（何も打たず、起動もしない）、別の世代に入れ替わっていれば最初のキーの直前（`roleConditionBoundary`）で断る
- 手順（`relay-io.mjs notify`）: `GET /api/worktrees/:pm/instances/roles` で PM の `application.launched`（今の世代と一致するときだけ返る起動の記録）を読み、その `sessionGeneration`・`injectionFingerprint` を `expectedRole` に入れて送る。409 等は `not_sent`（次の tick で再送）
- claude だけに送る: claude の送信（`sendMessageToClaude`）はセッションを起動・再起動しない。ほかの多くの tool の送信は `requireSession({ relaunch: true })` で、route の確認とサービスの間に tool が終わると再起動しうる（キーは打たれないが起動は起きる）。そのため PM の tool が claude でなければ送らない（`pm-tool-not-pinnable`）
- 送らない（`not_sent`、次の tick で再び試す）とき: roles API が読めない（`pin-<why>`）・PM が roster に無い・`launched` が無い（`pm-launch-unknown`。**サーバーの再起動の後は、PM を CommandMate から起動し直すまで知らせは届かない**。記録には残る）・PM の役割の設定が起動時と変わった（サーバーが 409 で断る。PM を起動し直すまで届かない）
- **送信の結果の分け方**（Codex 再レビュー P2。`relay-io.mjs` の `sendAnswerOutcome`）: API が明示した結果を尊重する。「何も打っていない」と API が言うときだけ `not_sent`（次の tick で再送）にし、届いたかもしれない送信は `unknown`（送ったものとして繰り返さない）にする。send API は記録した試行の失敗に `sendOutcome` を付ける（`route.ts` の `unboundSendOutcome`: 試行が `not-sent` なら `not_sent`、それ以外は `unknown`）。試行を記録しない断り（入力の誤りの 400 など）には付けない

| API の答え | 分け方 | 理由 |
|---|---|---|
| 2xx（`sendOutcome` 無し・`sent`） | `sent` | 送った |
| 状態によらず `sendOutcome: "not_sent"`（例: 409 `role_condition_unmet`。PM が止まった・入れ替わった） | `not_sent`・再送 | API が何も打っていないと言う |
| 状態によらず `sendOutcome: "unknown"`（例: 500。本文を打った後の確認に失敗） | `unknown`・再送しない | 届いたかもしれない |
| 4xx・読める JSON の本文・`sendOutcome` 無し（入力の誤り・見つからない・認証） | `not_sent`・再送 | キーより前の断り（試行を記録しない） |
| 5xx・`sendOutcome` 無し（本文が無い・読めないを含む） | `unknown`・再送しない | 何が起きたか分からない |
| 本文が読めない 4xx（間の proxy 等） | `unknown`・再送しない | API の答えと確かめられない |
| 時間切れ・接続できない・子の失敗 | `unknown`（子の失敗は `fail`）・再送しない | 届いたかもしれない |
| POST の前に止めたもの（roles が読めない・`launched` 無し・claude 以外・roster に無い） | `not_sent`・再送 | POST していない |

- 本体（API・relay・DB）は変えていない。この保証は上の既存の振る舞いに依る。試験はその振る舞いの置き場所（route の順序・send-role の条件・claude の送信）を読んで、変わったら落ちるようにした

### 5.1 検査 1 は #4420 まで記録だけ（人の決定・PM 経由）

- 検査 1（relay の無い依頼）は、#4420（relay 本体の直し・段 7）が入るまで**知らせない・記録だけ**にする。当面 PM は素の `send` で依頼するので、知らせると毎回の誤報になる。検査 2（STALL）と検査 3（保留・期限切れ）は今のとおり知らせる
- 記録: 見張りの行の `checks.noRelay` に今までどおり残る。知らせていない鍵は tick ごとに `notice.recordOnly` に入り、`notice.keys`（送る鍵）には入らない。検査 1 だけが新しいときは `notice.why: "record-only"` で、送らない
- 記録だけの鍵は `reported` に入れない（知らせていないので）
- **戻し方（1 か所）**: #4420 が入った後、`.commandmate/flow.yaml` の `relayWatch.notifyNoRelay` を `true` にする。コードは変えない。キーを省いたときの既定は `scripts/flow/config.mjs` の `NO_RELAY_TOLD_BY_DEFAULT`（今は `false`）
- 戻した最初の tick では、その時点で続いている（直近 24 時間の）検査 1 の件がまとめて 1 行で知らされる（5 件まで名前、残りは件数）。その後は今までどおり 1 回だけ
- 送信は既存の `POST /api/worktrees/:pm/send` を `relay-io.mjs` から直接呼ぶ。レーン a（pm-send）の入口には依存しない（a が無くても見張りと試験は完結する）

## 6. 記録の形（既存の読み手を壊さない）

- 置き場所: `<flowDir>/<repo-slug>/relay-watch/<YYYY-MM-DD>.jsonl`（`tz` の日付）。計測の記録と同じ dir の**下の dir**。`reconstruct`・`report`・`status` の読み手は `<YYYY-MM-DD>.jsonl` の名前のファイルしか読まないので、見張りの行は読み手に入らない（壊れた行にも数えない）。tick の行（`kind: "tick"`）の形・2 つの値は変えない
- 行の境界・書き手の規則は計測の記録と同じ（改行で終わらない末尾には書かない・補修しない・消さない）
- 見張りの行: `{ v: 1, kind: "relay-watch", tickId, at, repo, base, pm, previousAt, status: "ok" | "unknown", why?, checks: { noRelay, stall, heldOrExpired }（各 { state: "found" | "unobserved" | "unknown", count, items }。`stall` は加えて `waiting`: 証拠つきで除いた relay）, screens, relays, reported, lookupFailed, notice: { keys, attempt, why, recordOnly }, durationMs }`
- 送った後: `{ v: 1, kind: "relay-watch-notice", tickId, at, repo, base, keys, outcome: "sent" | "not_sent" | "unknown" | "fail", why }`
- 次の tick の状態は、最新の 3 ファイルの最後の `relay-watch` 行から読む（読めなければ空から。そのときは同じ件をもう一度知らせうる）

### 6.1 記録の上限をまたいでも状態を読む（Codex レビュー P2-3）

- 問題: 書き手はサイズによらず追記するが、状態の読み手は 16 MiB（`MAX_FILE_BYTES`）を超えた日のファイルを丸ごと飛ばしていた。受け手 32 × 履歴 100 行を毎 tick 記録できる設定では、正常な記録だけで超えうる。飛ばすと状態が空になり、続いている件を毎 tick 知らせ直す
- 方式: **末尾から読む**。ファイルの最後の 256 KiB を読み、`relay-watch` 行が無ければ窓を 4 倍ずつ広げ、末尾 16 MiB まで探す（ファイル全体は読まない）。窓の先頭の切れた行と、改行で終わらない末尾は行として読まない。記録は消さない・上書きしない・書き手は変えない
- 限界: 最新の状態の行がファイルの末尾 16 MiB より前にしか無いとき（1 行がそれ以上の大きさ）は読めず、1 つ前のファイルへ進む
- 計測の記録の読み手（`readTicks`：`reconstruct`・`report`・`status`）は変えていない（tick の行の扱いは不変。上限を超えた日は今までどおり `truncatedFiles`）

## 7. 変えないもの・時間・失敗

- launchd の常駐の動き（15 分ごと・1 回動いて終わる・記録を消さない）、tick の 2 つの値とその行、ロック（見張りは同じ排他の中、計測の行を書いた後）
- 見張りの読みは子プロセス 1 本（`node scripts/flow/relay-io.mjs read '<json>'`）を共有の runner で起こす（上限 45 秒・SIGKILL）。送信は 1 本（上限 15 秒）。見張り全体の締め切りは開始から 60 秒。各要求は 10 秒で打ち切る。runner は「この Node・このファイル・`read`／`notify`・JSON の 1 引数」だけを許す
- 見張りの失敗（時間切れ・子の失敗・サーバー停止・形の誤り）は `status: "unknown"` の行と stderr の 1 行に残し、前の状態（`screens`・`relays`・`reported`）を引き継ぐ。計測の行と tick の exit は変わらない
- 試験（`relay-watch-4418.test.ts`）: 1〜3 の検出と陽性対照（relay あり・画面が進んでいる・閉じた relay）、画面が不変でも背景の待ち・処理中・最近の hook・検証の実行中なら鳴らない（陰性）と、終わった直後の `stop`・証拠の欄が無いときは鳴る（陽性対照）、長い待機の 2 段目、検査 1 は記録されるが知らせない（既定）・`notifyNoRelay: true` で知らせる、0 件で `unobserved`、2 回目の tick で繰り返さない、画面だけの取得失敗（500）を挟んでも同じ STALL を知らせ直さない（陽性対照: 閉じた relay は忘れる）、16 MiB を超えた日のファイルでも重複しない、送信は世代に固定し、根拠が無ければ POST しない、送信の結果は上の表で分け、500＋`sendOutcome: unknown` は再送しない（陽性対照: 409 は再送する）、検査の失敗でも計測の行が書かれる、設定の誤りは exit 2、`relay-io.mjs` は偽の `fetch` で。本物のサーバー・`~/.commandmate`・DB・tmux は使わない
