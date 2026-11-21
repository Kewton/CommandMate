# 1 つの送信の操作の書き込みを 1 要求で確定し、方針で断られたら何も残さない（Issue #4466）設計

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は Sprint 9。人の決定（§8.1、11-19、mem 91b25c73）を受けて始める。#4473（`send.ts`・`send-request.ts`）と #4420（`relay-service.ts`）のマージの後に始める（`pm-plan-s8.md` の直列）
- 版: 第 3.1 版（2026-11-19、イネーブラー claude-5）
  - PR1a の更新（2026-11-21）: 「今」の記述 7 か所を develop `d21e23870`（#4449・#4496・#4498 の後）に合わせて直し、PR1b の前に決める未確定を §8.3 に一覧した。設計の決定は変えていない
  - PR1a r1（2026-11-21）: PR1a のレビュー 2 本（`s9/review-4466-pr1a-codex.md`・`review-4466-pr1a-opus.md`）の処分。K1 の「今」を戻し、端の解決の失敗を条件ごとに分け、旧案（既存の作成は fallback・新しい `resolveRelaySessionStrict`）に履歴の印をつけ、§1 の表の行番号を #4128 と PR1a の後に直し、§4.2 に PR1a の到達点を書き、U2 の根拠を限定した
  - 第 3.1 版: 第 3 版の確かめ（`verify-4466-v2.md` の「## 第 3 版」。表の漏れ V3-1・V3-2、新しい穴 V3-N1、記録 1）の処分。§10.4
  - 第 3 版: 第 2 版の確かめ（`workspace/orchestration/runs/2026-11-19/s8/verify-4466-v2.md`。塞がった 1・一部 2・新しい穴 5・表の漏れ 5）の処分。処分は §10.3
  - 第 3 版の前提（PM の確かめ、`check-agy-relay-fence.md`）: N1 の形は、今のコード（v0.53.0）では「relay は開くが、打鍵は exit 33 で断られ、同じ要求の中で relay は `cancelled` になる」。打鍵には届かない。ただし relay の行と system line は残る。この設計では、それも残さない形で塞ぐ
  - 第 2 版: 設計レビュー 2 本（A: 安全の不変条件、`workspace/orchestration/runs/2026-11-19/s8/review-4466-a.md`／B: 公開の契約・互換・PR の分け方、`review-4466-b.md`）の処分を反映した。処分の表は §10
  - 第 2 版: PM の指示（`pm-req-4466-review-disposition.md`）を反映した。#4420 は既存の `RELAY_HOPS_EXCEEDED` を使い、往復の数え方は同期で読む。内部の設計は推奨で決め、人へは公開の契約の変更だけを伺う
  - 第 1 版: `67ff60445`
- 基準: develop `b8f6e33b8`（v0.53.0）。行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4466 の本文（背景・原因の読み・やること・不変条件 I1/I2・表の試験）
- 材料:
  - `workspace/orchestration/runs/2026-11-18/review-4449-1.md`・`review-4449-3-codex.md`・`repro-4449-codex.md`・`lead-return-s7-a.md`
  - #4437 の STOP（`2026-11-17/stop-4437-pr2-2.md`）
  - CHANGELOG 0.53.0 の #4449 の既知の制限
- 前の設計の根拠: #4437・#4449 の設計書は `docs/design` に無い。根拠は次のとおり（レビュー B P2-4）:
  - #4437: Issue と PR #4445・#4451 の本文
  - #4449: PR #4475 の本文と、上のレビューの記録
- 筆者の関わり: 筆者（claude-5）は #4449 の指摘の再現（`repro-4449-codex.md`）を担当した。#4449 の実装には関わっていない

---

## 0. 結論（先に）

- **推奨は案 A「1 要求の操作 API」**（PM の範囲の判断。§3）。CLI の `send` の 1 操作を、新しい 1 つの要求 `POST /api/worktrees/:id/send-operation` で送る。サーバーは次の順で処理する:
  1. S0 検査と、DB だけを読む早い判定
  2. S1 読み（await あり、書かない）
  3. **S2 確定**（1 つの `IMMEDIATE` トランザクション）
     - 方針の入力をすべて DB から読み直す
     - (c) の書き込みが断りうることを、すべて (b) で同じ解決の関数で判定する
     - 書く
     - **S2 の中の拒否はすべて例外でトランザクションを戻す**
  4. S3 実行（try/finally）
  5. S4 失敗の記録（必ず通る）
- **安全の根拠は「await の点を数え尽くすこと」ではない**。「S2 が方針の入力をトランザクションの中で読み直し、S1 の値は比べるだけに使う」ことに置く（レビュー A P2-2）
- 契約は今と同じく `contractPath` をサーバーが `loadTaskContract` で読む。本文の中身は受けない（レビュー B P1-1）
- 古いサーバー: 能力の確認に失敗したら断る。黙って古い経路へ落とさない（I7）。能力の一覧にトークンが無い古いサーバーでの扱いは、公開の契約なので人に伺う（§8）
- **公開の契約の変更**は §5.1 の一覧表にまとめた。人に伺うのは次の 4 つだけ（§8）:
  - 宛先の食い違いの exit
  - mem の拒否の結果の変化
  - 古いサーバーでの扱い
  - 新しい API の追加
- DB の変更は無し（冪等は後の PR3）

---

## 1. 事実: 今の 1 操作の要求の並び

CLI の `send` は、1 つの操作を次の別々の要求に分けて送る（`src/cli/commands/send.ts:259-522`）。行番号は develop `d21e23870`（#4128 で `send.ts` を `send-*.ts` に分けた後）と PR1a の後の位置（PR1a r1 で直した。v0.53.0 の行番号は `1e1367867` の版を見る）。

| 段 | 要求 | 書くもの | 方針の判定 | 出典 |
|---|---|---|---|---|
| 0 | 読み: `resolveCommandTarget`・`pinCommandTarget`・`roleAssignmentFromFlag`・`resolveRelayEndpoints` | — | — | `send.ts:263`・`:294`・`:302`・`:320` |
| 1 | `POST /instances/roles`（`--register --role`） | 名簿の行・ロールの設定 | 書き込みの中で判定（#4449）。拒否は例外でトランザクションを戻す | `send.ts:324`、`instances/roles/route.ts:130` → `role-write.ts` の `createInstanceRole` |
| 2 | `POST /tasks`（`--contract`）。ロールが食い違えば `PUT /instances/roles` も | タスクの行、環境の基準（**ファイル**、`saveEnvSnapshot`） | 早い判定 `:173`、遅い判定と `createTask` は `createTaskIfAllowed` `:186`（`tasks/task-create.ts`）、`recordEnvBaseline`（await）`:194`。契約は `contractPath` をサーバーが `loadTaskContract` で読む（`readTaskContractForCreate` `:143`） | `send.ts:341`、`tasks/route.ts`、`src/lib/verification/env-snapshot.ts:618-631` |
| 3 | `POST /api/relays`（`--reply-to`、ロールあり） | relay の行、transcript の system line（`chat_messages`） | relay の規則 0 | `send.ts:386`、`relay-service.ts:422`（`openRelay` = `judgeRelayCreation` `:323` → `recordOpenedRelay` `:380`） |
| 4 | `GET /auto-yes` → `POST /auto-yes` | grant（メモリ） | 方針 `:525`、最初の relay の判定 `:545`、所有の確認 `:560`、その後は `armAutoYesGrant` `:567`（`auto-yes-arm.ts`: shutdown の 503 `:126`、`onlyIfOff` の 409 `:132`、最後の relay の判定 `:142`、`setAutoYesEnabled` `:149`） | `send.ts:390`・`:412`、`auto-yes/route.ts` |
| 5 | `POST /api/relays`（`--reply-to`、ロールなし） | relay の行 | relay の規則 0 | `send.ts:453` |
| 6 | `POST mem/items`（`--note`） | mem の `waiting` の項目 | mem の拒否（50・2・56 など） | `send.ts:465`、`send-messages.ts:78` |
| 7 | `POST /send` | ロールの保存・セッションの起動・打鍵・relay の予約 | 方針の判定の呼び出しは所有の確認の前（`send/route.ts:317`）、束ねた relay の規則 0（`:336`、#4496）、await の後の読み直し（`rereadWorktreeForRole` `:393`） | `send.ts:479` |
| 8 | `PATCH /tasks/:id`（running）、`--register`（ロールなし）の登録、`--model` の後回しの Auto-Yes | タスクの状態・名簿・grant | — | `send.ts:506`・`:513`・`:521` |

**`openRelay` の中の判定（レビュー A P1-1）**:
- `openRelay`（`relay-service.ts:204-246`）は、自分でも規則 0（`decideRelayCreation`、`:220-229`）・連鎖・open の数・worktree の不在を判定する
- 断るときは例外を投げず、`{ ok: false, refusal }` を返す
- 端の解決は `resolveRelaySession` を使う。例外のときは `FALLBACK_CLI_TOOL` に倒す（`relay-session-ref.ts:62-77`）
- これは `findWriteToolPolicyRefusal` の解決（`resolveSessionTarget`。例外なら規則 0 を飛ばす、`write-tool-policy.ts:119-128`）と別の関数
- **PR1a 時点の今（develop `d21e23870`）**: 上の 2 行は v0.53.0 の事実で、今は違う。端の解決が失敗したときの扱いは、経路と条件で次のように分かれる（PR1a r1 で条件ごとに直した）:
  - **既存の作成**（`openRelay`＝`POST /api/relays`、書き込みの API の `findWriteToolPolicyRefusal`。#4496）: 端は `resolveRelayEndpointTool`（`relay-session-ref.ts`）で解決する。読みが例外なら `null` で、規則 0 は `null` を「すべての tool の候補」として判定する（`relay-policy.ts` の `findRelayToolPolicyDenial`）。申告が既定の `personal` なら antigravity の候補で断る（409 `RELAY_TOOL_POLICY_DENIED`）。`api-key`・`enterprise` なら断る候補が無く、通る。例外は無く、共有の resolver が最後の推測（`resolvedBy: 'fallback'`。worktree に使える tool の宣言が無く claude とみなす）を返したときは、作成の側はその tool で判定する。`openRelay` は `to` を、送信が名指した tool（`toCliToolId`）と名簿の解決の両方で判定する
  - **配送**（#4498）: `tryResolveRelayDeliveryTarget` は、読みの例外でも `resolvedBy: 'fallback'` でも `null` を返し、配送は保留する（推測した tool に打たない）
  - **新しい route の S2**（PR1b）: 同じ #4498 の `tryResolveRelaySession` で `from` を解決し、`null`（例外・`resolvedBy: 'fallback'` のどちらでも）を 503 `RELAY_ENDPOINT_UNRESOLVED` で断る（C15）。既存の作成より条件が広い（推測の claude でも断る）
  - fallback つきの `resolveRelaySession` は、規則 0 の判定と配送の宛先には使われない。残るのは、system line の表示（`relay-service.ts`・`relay-delivery.ts` の注記）、連鎖の読み（`findParentRelayHops`）、送った後の評価で観測した tool が無いときの worker の tool（`relay-delivery.ts:231` の `evaluateRelayAfterSend`）、束ねた返信の送り手の表示（`relay-bound-reply.ts:156`）
  - PR1a で `openRelay` を判定（`judgeRelayCreation`、読みだけ）と書き込み（`recordOpenedRelay`）に分けた

**mem の書き込みの拒否**: `memAddItem` 系は、拒否を `MemOutcome` で返す（`mem/service.ts:398-421`）。

**S1 にできない読み**: mem の書き手の解決（`lookupActor`）は、判定の前に incarnation の行を作る（`getOrCreateWorktreeIncarnation`、`mem/service.ts:226-230`）。

**0.53.0 の既知の制限（#4466 K1・K2）**:
- K1: 返信先・既定が段の間で変わると、段 2 の後で段 3 か段 4 が断られ、タスクが残る
  - **PR1a 時点の今**（PR1a r1 で直した）: 返信先と既定の両方が、今も当たる。#4449 で送信と grant はタスクの記録した宛先（`taskId`、`send/task-target.ts`）へ行き、既定を解決し直さない。ただし既存の `POST /api/relays` は、名簿に無い ad-hoc の `to` を、名指しの tool と worktree の既定の両方で判定する（#4496、`relay-service.ts` の `judgeRelayCreation`）。このため返信先を変えず、送信先の worktree の既定だけを段 2 の後に antigravity へ変えても、タスクは許されたまま、段 3 の relay の作成が `to` の側の `RELAY_TOOL_POLICY_DENIED` で断られ、タスクが残る（CLI は `failed` にする）。既定で断る形は `tests/integration/cli-relay-adhoc-tool-4496.test.ts` の「fix1」の行にもある
- K2: `--model --auto-yes` では Auto-Yes が段 8 に回る。段 1・7 の後で Auto-Yes だけが断られる（警告・exit 0）
  - **PR1a 時点の今**: `--register --role` と `--contract` の形は、#4449 で最初の書き込み（段 1・段 2）が Auto-Yes も判定して断る（`write-tool-policy.ts` の `autoYes`）。残るのは、最初の書き込みが `/send`（段 7）の形と、ロールなしの `--register`（段 8 の登録。送れた後に名簿の行が残る）

### 1.1 同じ種類の穴の履歴

| 回 | 場所 | 形 |
|---|---|---|
| 1 | #4437 PR2（STOP） | 事前の照会と書き込みが別の要求。照会の失敗で書き込みが進む |
| 2 | #4449 レビュー 1 P1-1 | 端末からの送信は許され、Auto-Yes は断られる。先の書き込みが残る（`repro-4449-codex.md` で再現） |
| 3 | #4449 codex レビュー 3 P1 | relay の宛先とタスクの宛先が別々に解決され、relay の拒否の前にタスクが残る |

**原因の読み**: 1 つの操作が別々の要求にまたがり、後の段の拒否と先の段の書き込みが、同じ確定点を持たない。

---

## 2. 不変条件

| # | 不変条件 | 守る場所 |
|---|---|---|
| **I1** | 方針（tool-policy・relay の規則 0・Auto-Yes の方針）で断られる操作は、どの組み合わせ・どの起点・どの割り込みでも、次のどれも残さない: タスクの行・名簿の行・ロールの設定・relay の行と transcript の system line・mem の項目・incarnation の行・環境の基準のファイル・grant・ポーラー・プロセスの起動・打鍵。CLI は exit 33 で終わり、stderr の 1 行目は理由、stdout は空 | §4.2 S2・S3 の頭 |
| **I2** | 判定した値でそのまま実行する。宛先（instance と tool）・relay の両端・起点は、S2 で 1 回だけ決める。S3 はそれを読み直さず、持ち回る | §4.2・§4.4 |
| **I2a** | **送信の宛先にあたる relay の端（`to`）の規則 0 と、打鍵の方針は、「実際に打つ tool」1 つで判定する**。その tool は S2 で決めた送信の tool で、名簿から解決し直した値ではない。名簿に無い ad-hoc の instance に `--agent` を付けた送信でも同じ。返信先の端（`from`）は、名簿にある既存のセッションなので、名簿から解決した tool で判定する（確かめ N1） | §4.2 (b)、§6.1 |
| **I3** | S2 の中に `await` を置かない。方針の最後の判定と、すべての行の書き込みは、同じ同期の区間（better-sqlite3 の `IMMEDIATE` トランザクション）で行う | §4.2 |
| **I3a** | **S2 の中のすべての拒否は、型付きの例外を投げてトランザクションを戻す**。方針・非方針を問わない。対象は次のとおり。route はトランザクションの外で、それを HTTP の応答へ写す（レビュー A P1-1）:<br>- `openRelay` の `ok:false`<br>- mem の拒否<br>- 名簿の検査<br>- 宛先の食い違い<br>- Auto-Yes の shutdown | §4.2 |
| **I3b** | (c) の書き込みの関数が断りうることは、すべて (b) で、(c) と**同じ解決の関数・同じ DB の状態**を使って先に判定する（§4.2 の順: 名簿・ロールの DB の書き込み → (b) → 残りの書き込み）。(c) の中の判定は、二重の守り（I3a の例外）として残す。**端の解決の失敗は値で返す関数（`resolveRelaySessionStrict`。PR1a 時点では新しく作らず #4498 の `tryResolveRelaySession` を使う、§4.2 (b)2 の注）で受け、S2 では断る**（fallback の tool で判定しない。fail-closed） | §4.2 |
| **I3c** | S2 は、方針の入力（宛先の tool・relay の両端の tool・既定・名簿・起点・申告）を、すべてトランザクションの中で DB と env から読み直す。S1 の値は、比べることにしか使わない。これが割り込み（S1・S2 の間の変化）への守りの根拠で、await の数に依存しない（レビュー A P2-2） | §4.2 (a)(b) |
| I4 | 事前の照会（`GET …/tool-policy`）を、判定の代わりに使わない。照会の API は残す。CLI は呼ばない | §4.1 |
| I5 | 新しい要求を使わない呼び手（画面・`ask`・`respond`・`/terminal`・古い CLI）は、今の振る舞いのまま。今の個々の書き込みの API の判定（#4449）も外さない | §4.5 |
| I6 | 確定の後に起きる失敗は、方針の拒否ではない。S3 は try/finally で包み、送ったかどうか不明を含めて必ず S4 を通す。S4 は 1 トランザクションで今の失敗の約束を行う（タスクは `failed`、relay は取り消し、送っていなければ grant を戻し、note を閉じる）。確定の後に方針の判定をし直さない（I2） | §4.4 |
| I7 | 新しい CLI と古いサーバーの組み合わせで、黙って柵を弱めない。能力の確認に失敗したら断る。新しい route の失敗の応答（404・5xx を含む）で、古い経路へ切り替えない。**端末以外の起点（`session`・`agent`・`schedule`・`unknown`）は、H3 の答えにかかわらず古い経路を使わない**（確かめ N4）。H3 は端末の起点の扱いだけを伺う | §4.6 |
| I10 | S2 の中で起きる DB の外の副作用（WebSocket の配信・ログ）は、コミットの後へ回す。S2 の中では集めるだけで、戻したら捨てる（確かめ N2） | §4.2 (c)(d) |
| I8 | 方針の判定は今の関数（`decideToolPolicy`・`decideRelayCreation`・Auto-Yes の方針）を使う。判定の表は変えない。#4420 の往復の数の読み（設計し直しの後は `readRelaySessionRounds(db, from)`、`relay_session_rounds` の 1 行の同期の SELECT。`docs/design/relay-rounds-db-4420.md` §3.3）は、S2 の中でそのまま呼べる | §4.2 |
| I9 | 拒否の優先順位を今と同じに保つ。方針の拒否（exit 33）は、非方針の拒否（所有・ロールの条件・モデル・契約の不正）より先に返す（レビュー A P3-1） | §4.2 S0 |

**I1 の範囲の外（明記する）**:
- 確定の後、配送の段で relay が方針に断られる場合（返信先の tool が確定の後に antigravity へ変わった）。relay の pump が配送の時に取り消す（#4456 (5)）
- 方針ではない理由での、確定の後の失敗。I6 で扱う
- **新しい CLI と古いサーバーの組み合わせ**で、古い経路を使う場合（§4.6。人の答えによる）。古い CLI と新しいサーバーでも、古い CLI は今の別々の要求を使うので K1・K2 が残る（docs に書く。レビュー B P2-2）
- 同じ操作の打ち直し（応答を待つあいだに CLI をもう一度打つ）。1 回目の S3 と並んで 2 回目が S2 を通り、二重に書き・打ちうる。今も同じ。冪等は PR3（§7、レビュー A P3-4）
- プロセスが S2 のコミットの後・S4 の前に落ちたときの残り。今も CLI の途中の停止で同じ形が残る。詳しくは §4.4

---

## 3. 案の比較（PM の範囲の判断。推奨で決める）

| | 案 A（推奨）: 1 要求の操作 API | 案 B: 取り消しの確定点（仮の行） | 案 C: CLI の取り消しを強める |
|---|---|---|---|
| 中身 | CLI は 1 つの要求で操作の全部を送る。サーバーが読み・判定・確定・実行の順で処理する | 各書き込みを `staged` で作り、最後に全部を判定して上げるか消す。放置は期限で掃除 | 各段の失敗で CLI が取り消す経路を足す |
| I1 の守り方 | 確定の区間の中の判定と、例外による巻き戻し（構造で守る） | 仮の行を誰も読まないこと（約束で守る） | 取り消しが走ること（CLI の停止で破れる） |
| 推測の残り | 無し | 「仮を読む経路」の網羅。漏れは fail-open | CLI が最後まで走ること |
| DB の変更 | 無し | 5 種類の表に状態の列、掃除の印 | 無し |
| 実装の大きさ（見立て） | 中〜大 | 大 | 小に見えるが、同じ種類が続く |

**案 B を捨てた理由**:
- 仮の行が一時的にでも DB に入る
- 名簿の解決・relay の pump・tasks の一覧・brief・画面・Auto-Yes のポーラーのすべてが「仮を無視する」を守る必要がある。漏れは試験で見つけにくい（#4419・#4430 と同じ形の弱さ）

**案 C を捨てた理由**: 今の形で 3 回出た種類で、PM の不変条件（3 回目は設計し直し）に当たる。

---

## 4. 案 A の設計

### 4.1 要求の形

`POST /api/worktrees/:id/send-operation`

```jsonc
{
  "message": "…",                          // 打つ本文（--contract なら省略。サーバーが契約から作る）
  "target": { "instanceId": "codex-2", "agent": "codex" },   // 名指し。両方省略なら既定
  "origin": "terminal", "originEvidence": "…",               // 今の /send と同じ
  "contract": { "path": ".commandmate/tasks/x.yaml" },       // サーバーが loadTaskContract で読む（今の POST /tasks の contractPath と同じ）
  "register": { "alias": null },           // --register
  "role": { … },                           // --role / --no-role / 条件（今の /send の role の欄と同じ）
  "replyTo": { "worktreeId": "…", "instanceId": "…", "allowRelayChain": false },
  "autoYes": { "durationMs": 3600000, "timing": "before-send" | "after-send", "onlyIfOff": true,
               "answerMode": "recommended", "stopPattern": null },
  "note": { "text": "…", "author": { "worktreeId": "…", "instanceId": "…" } },  // 書き手は CLI が whoami で解決（今と同じ）。サーバーは推測しない
  "model": "…", "newConversation": false,
  "brief": "skip" | "force" | "decline", "briefDetail": "short" | "full", "briefBoundary": "…",  // 今の /send の欄
  "expect": { "rosterRevision": 12 }       // 任意。CLI が読んだ名簿の版
}
```

- `message` と `contract` の両方があれば 400 `invalid_request`（exit 2）で、何もしない。契約の送信の本文は、今と同じくサーバーが契約から作るもの（`composeContractMessage`、`tasks/route.ts:240`）だけ（確かめ N3）
- **契約の中身は受けない**。今と同じく、サーバーが S1 で worktree の中のパスを `loadTaskContract` で読み、検証する（`tasks/route.ts:117-150`。パスの検証と信頼の境界は今のまま。レビュー B P1-1）
- `target` の欄を持つ理由: 今の `/send` は「宛先の欄なし」（#4116）で、既定の解決をサーバーに任せている。新しい route は、その操作で S2 が決める宛先の出発点として、CLI が名指したものだけを受ける。名指しが無ければ、今と同じく既定（S2 で解決）。`/send` の約束は変えない（レビュー B P3-3）
- 能力の名前は `send-operation-v1`。欄を足すだけの変更は同じ版のまま。意味の変わる変更は `v2` を足す（`v1` は残す）（レビュー B P3-1）
- 応答（成功）: `{ ok: true, target, taskId?, relayId?, grant?, registered?, noteItemId?, sent: { … 今の /send の応答（brief を含む）… } }`
  - **PM 決定 11-21（§8.3 の U1）。PR0 の表が置いた形**: 成功の応答にも `policy` を載せる。`policy.target.tool`（実際に打つ tool。I2a）と、relay があれば `policy.relay.from` / `policy.relay.to`（規則 0 がそれぞれの端を判定した tool）。§6.1 の ad-hoc の `--agent codex` の対照が「`to` を名簿の既定で判定した」と「打つ tool で判定した」を見分けるのに要る
  - `operationId` は出さない（使い道が無い。レビュー B P3-2）
- 応答（拒否）: §5.1 の表

### 4.2 サーバーの段

| 段 | すること | await | 書き込み |
|---|---|---|---|
| S0 検査と早い判定 | 本文の形・値の検査（今の `send-request.ts` を共有）。**DB と env だけを読む早い判定**: 宛先の解決と方針の判定を 1 回行い、方針の拒否ならここで 409 を返す。結果は捨て、S2 で判定し直す（I9） | 無し | 無し |
| S1 読み | 次を、**読みだけの関数**で行う。incarnation の作成など、読みの関数の中の書き込みは S2 へ移す（レビュー A P2-5）:<br>1. 宛先の候補の解決<br>2. relay の両端の候補の解決<br>3. 契約の読み込みと検証（`loadTaskContract`）<br>4. 環境の基準の採取（`captureEnvSnapshot`。メモリに持つだけで、ファイルに書かない）<br>5. mem の note の対象の解決（読みだけの版）<br>6. ロールの条件の読み（`runningRoleProblem`・`contractRoleWarning`）<br>7. モデルの検査（`isRunning`）<br>8. セッションの所有の確認 | 有り | 無し |
| **S2 確定** | **1 つの `db.transaction(…).immediate()`**（レビュー A P3-2）。次の (a)〜(e) | **無し** | 全部ここ |
| S3 実行 | try/finally で包む。中身は次の順:<br>1. 集めておいた配信・ログを出す（I10）<br>2. 環境の基準のファイルを書く（タスクがあれば。失敗は今と同じく warn）<br>3. 起動（必要なら）<br>4. **打鍵の直前**（`sendUserMessage` の入力の境目）で、要求の中断（`request.signal.aborted`）を見る。中断なら not_sent として S4 へ（確かめ N5。起動の長い await の後に確かめる）<br>5. 打鍵<br>6. 送信の記録（今の `sendUserMessage` の流れ。宛先は S2 の値）<br>7. タスクを `running` にする<br>8. ロールなしの `--register` の名簿の登録（今と同じく送れた後だけ。方針は S2 で判定済み。§5.1 C13）<br>9. `after-send` の grant を有効にする | 有り | 送信の記録・ロールなしの登録 |
| S4 失敗の記録 | S3 の finally で、成功でなければ必ず通る。1 つのトランザクションで次を行う:<br>1. タスクを `failed` にする<br>2. relay を取り消す<br>3. 送っていなければ grant を戻す<br>4. 送っていなければ note を閉じる<br>S2 で書いた名簿の登録（ロールあり）とロールの設定は残す（今の CLI と同じ。§8 の PM の決定）。ロールなしの登録は S3 の送れた後だけなので、失敗では書かれない<br>失敗の応答には `taskId`・`relayId`・`roleSettings`・`sendOutcome` を載せる（§5.1 C12） | 無し | 失敗の記録 |

**S2 の中身（順に）**:
- **(a) 宛先の読み直し（I3c）**:
  - 宛先・relay の両端を、トランザクションの中で DB から解決し直す
  - S1 の候補と、`expect.rosterRevision`（あれば）と比べる
  - 違えば `OperationTargetChanged` を投げる
- **(c1) 名簿とロールの書き込み（DB だけ）**: ロールありの名簿の行（`--register --role`）→ ロールの設定。(b) が (c2) と同じ DB の状態を見るために、先に書く。断るときは例外で戻るので、行は残らない（I3a）。DB の外の副作用は無い
- **(b) 判定（I3b）**: (c1) の後の DB の状態で、次を全部判定する。どれか 1 つで断るなら、型付きの例外を投げる
  - **判定の順（PM 決定 11-21、§8.3 の U2）**: 下の 2（relay の作成）を 1（宛先への送信の方針）より先に判定する。両方が断るときは relay の拒否（`RELAY_TOOL_POLICY_DENIED`）を返す（今の書き込みの API の判定 `findWriteToolPolicyRefusal` と同じ順・同じ code）。番号は下の参照（「1 の実際に打つ tool」など）のために残し、判定の集合は変えない
  1. 宛先への送信の方針: `decideToolPolicy`。tool は (a) で決めた**実際に打つ tool**。起点は本文、申告は env
  2. relay の作成: `decideRelayCreation` を、(c2) の `openRelay` と同じ関数・同じ入力で呼ぶ。入力の決め方:
     - `to`（送信の宛先の端）の tool は、**1 の実際に打つ tool をそのまま渡す**（I2a）。名簿から解決し直さない
     - 〔履歴: 第 3.1 版の案。PR1a 時点の形は下の注〕`from`（返信先の端）の tool は、新しい関数 `resolveRelaySessionStrict(db, endpoint)` で解決する。この関数は、解決の失敗を `{ ok: false, reason }` の値で返し、例外を中で受けて fallback を返すことはしない
     - `resolveRelaySessionStrict` が失敗を返したら断る（I3b。`FALLBACK_CLI_TOOL` で判定しない）
     - 〔履歴: 第 3.1 版の案。既存の作成が fallback で判定するという前提は、#4496 で当たらなくなった〕strict を使うのは新しい route の S2 だけ。既存の `POST /api/relays` の `openRelay` は、今の fallback のまま変えない（I5、確かめ V3-2。`openRelay` は strict を使う口を引数で選ぶ）
     - 〔履歴: 第 3.1 版の案。配送は #4498 で `tryResolveRelayDeliveryTarget` に移った〕今の `resolveRelaySession`（`relay-session-ref.ts:58-85`、fallback つき）は配送（`relay-delivery.ts`）のために残す。中身は strict の版を包むだけにする
     - **PR1a 時点の今**（PR1a r1 で条件ごとに直した）: 上の履歴の 3 行の前提（既存の `openRelay` は fallback で判定し、配送も fallback を使う）は古い。条件ごとの今の扱いは §1 の注のとおり: 既存の作成は、読みの例外を `null`（すべての tool の候補）として規則 0 で判定し、既定の申告（`personal`）では 409 `RELAY_TOOL_POLICY_DENIED` で断る（`api-key`・`enterprise` では断らない）。共有の resolver の `resolvedBy: 'fallback'` には、作成の側はその tool で判定する。配送（#4498）はどちらの場合も `null` で保留する。`resolveRelaySessionStrict` は新しく作らず、#4498 の `tryResolveRelaySession`／`tryResolveRelayDeliveryTarget` を使う（同じ役割の関数を 2 つ作らない）。新しい route の S2 は、その `null`（例外・`resolvedBy: 'fallback'`）を例外に変えて 503 `RELAY_ENDPOINT_UNRESOLVED`（C15）で断る。既存の `POST /api/relays` は変えない（I5）。`/send` の束ねた relay の判定（`findBoundRelayToolPolicyRefusal`、#4496）が打鍵の前にもう一度判定する
     - #4420 の `replyRounds`（`readRelaySessionRounds`、1 行の同期の読み。`relay-rounds-db-4420.md`）も含む
     - 結果: 名簿に無い ad-hoc の id ＋ `--agent antigravity` ＋ `--reply-to` は、`to` の tool が antigravity なので規則 0 で断られる（exit 33）。relay の行も system line も書かれない（N1）
  3. Auto-Yes: 方針、shutdown（`isAutoYesShutdownStarted()`）、`onlyIfOff`
     - `onlyIfOff` に当たったら、断らない。「既に on」として扱い、`after-send` に回す（今の CLI の扱い、`send.ts:1363-1368`。レビュー A P2-3）
  4. 名簿の追加の検査（`validateAgentInstanceAddition`）
  5. ロールの設定の検査
  6. mem の note: mode・`alive()`・件数の上限（`limit_exceeded`）など、`createMemItem` の `storeFailure` になりうるもの（確かめ N2。(c2) の後ろで断られると、先の書き込みが戻ることは I3a で守られるが、ここで先に判定する）
- **(c2) 残りの書き込み**: incarnation（mem の書き手）→ タスク → relay（開く・予約する）→ mem の note の項目
  - `openRelay` には `{ toTool }`（(b) の 1 の tool）と、strict の解決を使う口を足す。内部の関数の口で、公開の API ではない
  - `writeRelaySystemLine` の WebSocket の配信（`relay-system-line.ts:86-90`）とログは、S2 の中では集めるだけにする（I10）。行そのもの（`chat_messages`）は同じトランザクションで書くので、戻れば残らない
  - (c2) の書き込みの関数が値で断った場合（`openRelay` の `ok:false`、mem の `MemOutcome` の拒否）は、その場で例外に変えて投げる（I3a。二重の守り）
- **(d)** トランザクションを閉じる。例外ならトランザクションは戻り、route はその例外を §5.1 の応答へ写す
  - 戻したときは、集めておいた配信とログを捨て、`send-operation-rolled-back` の 1 行だけを出す（I10、レビュー A P3-5）
  - その 1 行に、拒否の要約を載せる: 拒否の code（例 `RELAY_TOOL_POLICY_DENIED`）・段（`target`・`relay`・`auto-yes`・`roster`・`mem`）・端（`from`・`to`）・判定した tool・起点。方針の拒否の監査の記録（`relay-tool-policy-denied` などで今残しているもの）が、戻しても消えないようにする（確かめ V3-N1）
- **(e)** 同じ同期の流れで、await を挟まずに、grant を有効にする（`before-send` のとき）
  - (b) で shutdown と `onlyIfOff` を判定済みなので、(e) は失敗しない書き込みだけ
  - 失敗したとき（予期しない例外）は、S4 と同じ始末をして 500 を返す

**S3 が `/send` の処理を呼ぶときの扱い（レビュー B P2-4）**:
- 新しい route は、`/send` の段の関数（起動・打鍵・relay の予約・ask の予約）を、S2 で決めた宛先と判定を持ち回って呼ぶ
- その関数の中では方針の判定をし直さない（I2）
- `/send` の route 自身の判定（`send/route.ts:297`・`:361`）は、`/send` の route に残す（I5）。共通の関数は「判定済みの宛先」を受けるだけにする

**PR1a の到達点（PR1a r1）**: 既存の route の判定と書き込みを、同期の関数と読みだけの関数に分けた（`judgeRelayCreation`・`recordOpenedRelay`・`createTaskIfAllowed`・`createInstanceRole`・`armAutoYesGrant`・`saveSendRole`・`readMemActor` など。§7）。ただし S2 の中でそのまま呼べる形ではない:
- `recordOpenedRelay` と `armAutoYesGrant` は判定をせずに書く。判定（`judgeRelayCreation`、方針の判定 `findAutoYesToolPolicyRefusal`）の後でだけ呼ぶ
- `recordOpenedRelay` は system line の配信とログを中で出し、`armAutoYesGrant` はポーラーを中で始める。`judgeRelayCreation` は `from` を自分で解決し、`to` を名指しの tool と既定の両方で判定する（既存の route の形）。PR1b で、判定済みの両端（I2a）を受け、配信・ログ・ポーラーをコミットの後に出す口に変える（I10・(e)）

### 4.3 割り込みへの守りと、試験の hook

- 守りの根拠は I3c（S2 が方針の入力を読み直す）。S1・S3 の await の数に依存しない
- 試験の hook（レビュー A P2-2）:
  - **h-S2**: S2 に入る直前の 1 点。ここで方針の入力（名簿の tool・既定・返信先の名簿・申告）を変える。S1 のどの await の後で変わっても、S2 から見れば同じ
  - **h-S3**: S3 の起動の後・打鍵の前の 1 点（I2 の確認）
  - **h-S3b**: 打鍵の後の 1 点（配送の段。範囲の外の確認）
- await の網羅は、安全の根拠にしない。網羅の確認が要るなら、静的な検査にする（route と段の関数の `await` を AST で数え、一覧と比べる）。Sprint 9 では入れない（PM の範囲の判断で推奨）

### 4.4 確定の後の失敗（I6）

- 確定の後に方針の判定をし直さない。宛先・両端・起点は S2 の値を持ち回る
  - S3 で、起動の後に名簿の tool が変わっても、S2 の tool の pane にしか打たない（session の名前は tool ごと、`cli-tools/base.ts:226-227`）
  - 合わなければ起動・打鍵の失敗で S4
- 次の失敗は、すべて S4 で終わる:
  - 起動の失敗
  - 所有の食い違い
  - プロンプト待ち
  - 入力欄が空でない（#4476）
  - セッションの消滅
  - 要求の中断
  - 予期しない例外（finally）
- `after-send` の grant:
  - 判定は S2 で済んでいる。判定の入力（宛先の tool・起点・申告）は持ち回るので、S2 と S3 の間に変わらない（レビュー B P2-5）
  - 返信先の tool の変化は、配送の段の話（範囲の外）
  - 所有の食い違いなどで有効にできなかったときは、今と同じく警告・exit 0（#4159）
- **プロセスの停止**（S2 のコミットの後・S4 の前にサーバーが落ちる。レビュー A P2-4）:
  - 残るもの: `pending` のタスク・open の relay・note の項目・名簿・ロール。grant はメモリなので消える
  - 今の CLI の途中の停止でも、同じ形が残る
  - Sprint 9 では既知の制限として docs に書く（PM の範囲の判断で推奨）。起動の時の照合（操作の記録を持ち、`pending` のまま S3 に入らなかった操作を始末する）は、冪等の表（PR3）と一緒に考える

### 4.5 既存の route との関係（I5）

- 新しい route を足し、`/send`・`/tasks`・`/instances/roles`・`/api/relays`・`/auto-yes` は残す。共通の段の関数を、新しい route と既存の route が呼ぶ
- 既存の個々の書き込みの API の判定（#4449）は外さない
- **画面（`/send`・`/terminal`）・`ask`・`respond` は変更なし**（レビュー B P3-4）
- `/send` を広げる案を採らない理由: `/send` は画面・`ask`（予約）・relay の配送でも使われ、本文の解釈を広げると今の約束と混ざるため（#4116 の「`/send` に宛先の欄なし」など）

### 4.6 能力の確認と古いサーバー（I7）

- CLI は `GET /api/capabilities` で `send-operation-v1` を確かめる。形は `serverResolvesSessionTargets`（`src/cli/utils/server-capabilities.ts:183-187`）と同じにする。確認の失敗（通信・認証・proxy・HTML の応答）は throw で exit し、古い経路へ落とさない（レビュー A P2-6）
  - 似た関数 `serverReportsPromptAnswerReason`（`:207-214`）は失敗で `false` に倒すので、その形は使わない
- 古い経路を使ってよいのは、能力の一覧が届き、そこにトークンが無いとき（古いサーバーと確かめられたとき）で、かつ**起点が端末のとき**だけ。端末以外の起点は、H3 の答えにかかわらず断る（I7、確かめ N4）。端末のときの扱いは公開の契約なので、人に伺う（§8 H3）
- 新しい route が 404・5xx を返しても、古い経路で送り直さない（二重に書くおそれ）
- 書き込みのフラグ（`--contract`・`--register`・`--role`・`--reply-to`・`--auto-yes`・`--note`）を伴わない送信は、新しい route を使わない（今の `/send` のまま）

---

## 5. CLI と公開の契約

### 5.1 公開の契約の変更の一覧（レビュー B P1-2）

| # | 項目 | 今（0.53.0） | 新しい形 | 人の了承 |
|---|---|---|---|---|
| C1 | 新しい API `POST /api/worktrees/:id/send-operation`、能力 `send-operation-v1`、応答の欄 `policy.stage` | 無し | 足す（既存の API は変えない） | 要（API の追加。§8 H4） |
| C2 | 方針の拒否（書き込みのフラグを伴う送信） | exit 33。stderr の 1 行目は理由のこと、`Task created: …` のこと（K1）がある。stdout に task の id が出ること（K1）がある | exit 33。stderr の 1 行目は必ず理由。stdout は空。何も書かれていない | 不要（約束の「理由が 1 行目」に揃う直し） |
| C3 | 送信の途中で宛先が変わった（`operation_target_changed`、何も書いていない、再送してよい） | 無し（今は行が残る） | 409 `OPERATION_TARGET_CHANGED`。exit は H1 で決める | **要（exit の番号。§8 H1）** |
| C4 | `--note` の mem の拒否（50・2・56 など） | 何も送らず、契約の task を `failed` にし（行は残る）、grant と relay を取り下げ、mem の終了コードで終わる（`cli-operations-guide.md:308`） | S2 の中の拒否なので、全部を戻す。**task の行も残らない**。exit は mem の終了コードのまま。stdout は空 | **要（結果の変化。§8 H2）** |
| C5 | relay の方針以外の拒否（`RELAY_CHAIN_BLOCKED`・`RELAY_HOPS_EXCEEDED`・`RELAY_DUPLICATE_PENDING`・`RELAY_SELF_TARGET`・`RELAY_WORKTREE_NOT_FOUND`、`src/cli/commands/relays.ts:70-76`） | relay の段で exit 2 と固有の文面。それより前の段の行（タスク・登録）は残る | 同じ code・同じ文面・exit 2。S2 の中の拒否なので、何も残らない。#4420 は新しい code を作らない（PM の決定） | 不要（code と exit は同じ。行が残らなくなるのは I1 の直し） |
| C6 | 名簿の拒否（`--register`、上限・id） | exit 2（送る前）または警告・exit 0（送った後） | `--register` の名簿の検査は S2 で行う。名簿が断る行は、何も書かず送らず exit 2。**応答の code は 400 `invalid_request`**（PM 決定 11-21、§8.3 の U3。新しい code は足さない） | 不要（#4458 の CLI の判定と同じ結果。#4479 の方向） |
| C7 | 古いサーバー（能力の一覧にトークンが無い） | — | H3 で決める | **要（§8 H3）** |
| C8 | 能力の確認に失敗した | — | exit（`serverResolvesSessionTargets` と同じ exit）。古い経路へ落とさない | 不要（既存の能力の確認の約束と同じ） |
| C9 | 確定の後の失敗（起動の失敗など） | CLI が `failTask` 等で取り消す。CLI が止まれば残る | サーバーが S4 で始末する。exit は今の失敗の exit のまま | 不要 |
| C10 | `--model --auto-yes`（K2） | 送った後で Auto-Yes だけが方針で断られる（警告・exit 0） | 方針の拒否は S2 で、何も送らず exit 33 | 不要（I1 の直し。既知の制限の解消） |
| C11a | 名簿に無い ad-hoc の id ＋ `--agent antigravity` ＋ `--reply-to`、**AI の起点**（`session`・`agent`・`unknown`・`schedule`。N1） | relay は開き、打鍵は `/send` の柵で exit 33 で断られ、同じ要求の中で relay は `cancelled`。relay の行（`cancelled`）と `requested` の system line（とその配信）が残る（PM の確かめ `check-agy-relay-fence.md`）。**PR1a 時点の今**: #4496 で `POST /api/relays` が `to` を `--agent` の tool で判定するので、relay は開かず exit 33、何も残らない（`tests/integration/cli-relay-adhoc-tool-4496.test.ts`） | S2 の規則 0 で、実際に打つ tool（antigravity）で断る。exit 33。relay の行も system line も配信も、何も残らない | 不要（exit は同じ。I1 の直し） |
| C11b | 同じ形で、**端末の起点**（N1。確かめ V3-1） | `/send` の柵は端末の起点の antigravity への送信を許す（`policy.ts:95-98`）。relay の規則 0 は名簿の既定の tool（例: claude）で判定されて通る。**relay が開いたまま打鍵され、exit 0**。規則 0（どの起点でも antigravity の端の relay を断る、`relay-policy.ts:128-139`）が破れている。**PR1a 時点の今**: #4496 で直っている（exit 33、relay の行も打鍵も無い。同じ試験の terminal の行） | S2 の規則 0 で、実際に打つ tool（antigravity）で断る。**exit 33**。何も残らず、何も打たない | **要（成功から拒否へ変わる。§8 H6）** |
| C12 | 確定の後の失敗の出力（表の漏れ 2） | `--contract` は送る前に `Task created:`（stderr）と task の id（stdout）を出すので、失敗でも id が残る。応答には `roleSettings` がある（`send/route.ts:118-121`） | 失敗の応答に `taskId`・`relayId`・`roleSettings`・`sendOutcome` を載せる。CLI は、失敗のときも `Task created:` と task の id を、今と同じ順で失敗の文の前に出す。方針の拒否・S2 の拒否では、タスクが無いので出さない | 不要（今の出力の約束を保つ） |
| C13 | ロールなしの `--register`（表の漏れ 1） | 送れた後にだけ登録する（`send.ts:1470-1477`）。失敗では行が残らない | 同じ（S3 の送れた後に登録。方針は S2 で判定済み） | 不要（今と同じ） |
| C14 | CLI の中断（Ctrl-C・接続の切断。表の漏れ 3） | CLI が `/send` の前で止まれば、打鍵は起きない | 要求を送った後は、サーバーが S3 まで進みうる。打鍵の直前に中断を確かめ、届いていれば打たない（not_sent で S4）。届かない（`request.signal` が切断を反映しない）ときは打つ | **要（§8 H5）** |
| C15 | 端の解決の失敗（I3b の fail-closed。表の漏れ 4） | `resolveRelaySession` が fallback の tool（claude）で判定し、relay を開く。**PR1a 時点の今**（PR1a r1 で条件ごとに直した）: #4496 で既存の `openRelay`・書き込みの API の判定は、読みの例外の端を `null`（すべての tool の候補）として規則 0 で判定する。既定の申告（`personal`）では 409 `RELAY_TOOL_POLICY_DENIED` で断り、`api-key`・`enterprise` では断らずに開く。共有の resolver の `resolvedBy: 'fallback'`（例外ではない最後の推測）には、作成の側はその tool（claude）で判定する。配送（#4498）はどちらも `null` で保留する（§1 の注・§4.2 (b)2 の注） | **新しい route だけ**: 503 `RELAY_ENDPOINT_UNRESOLVED`。何も書かない。新しい CLI は exit 99（`UNEXPECTED_ERROR`、再送してよい）。新しい exit の番号は足さない<br>既存の `POST /api/relays`（古い CLI・`ask`・`send` の古い経路）は**今の fallback のまま変えない**（I5。確かめ V3-2）。その経路の端の解決の失敗は、今と同じく fallback で判定され、打鍵は `/send` の柵、配送は relay の pump の規則 0（#4456 (5)）が受け持つ（PR1a の注: 「fallback のまま」は第 3.1 版の時点の記述で、履歴として残す。今の既存の経路は「今」の列のとおりで、変えないのはその形） | **要（新しい code。§8 H4）** |
| C16 | `IMMEDIATE` のトランザクションの busy（表の漏れ 4） | — | 503 `OPERATION_BUSY`。何も書かない。CLI は exit 99（再送してよい） | **要（新しい code。§8 H4）** |
| C17 | `--note` で Auto-Yes の状態が読めない（表の漏れ 5） | 送る前に止めて exit 99（`send.ts:1333-1341`） | サーバーが同じプロセスの中で状態を読むので、この終わり方は無くなる | 不要（終わり方が 1 つ減るだけ） |
| C18 | `message` と `contract` の両方（N3） | CLI はサーバーが作った本文だけを打つ | 新しい route は 400 `invalid_request`（exit 2）で、何もしない | 不要（新しい route の入力の検査。CLI はこの形を送らない） |

- C2・C5・C10 は、0.53.0 の既知の制限（K1・K2）が無くなる変化で、exit の番号は変わらない
- **docs の直す場所**（レビュー B P1-2 (e)。PR2 の範囲）:
  - `docs/user-guide/cli-operations-guide.md`: ja の 341〜349 行（書き込みの判定・既知の制限・#4449 より前のサーバーの注意）、308 行（`--note` の拒否、C4）、全終了コード一覧の 33（と H1 の番号）
  - `docs/en/user-guide/cli-operations-guide.md`: 348〜350 行、exit の表 3730 行付近
  - `docs/orchestrate/exit-codes.md`
  - `src/cli/docs` の埋め込み
  - API の節（C1）
- 再送してよいかの表（レビュー B P3-5）を docs に置く:

  | 結果 | 再送 |
  |---|---|
  | exit 33 | 同じ結果になる |
  | `OPERATION_TARGET_CHANGED` | 何も書いていないので、再送してよい |
  | 確定の後の失敗 | 今の約束のまま |
  | 応答が届かなかった | 冪等が無いので、`commandmate tasks` で確かめてから再送する |

### 5.2 CLI の変化

- 新しい route の経路では、`send.ts` の段 1〜8 の別々の要求と、CLI の取り消し（`failTask`・`withdrawAutoYes`・`cancelRelayQuietly`・`closeSendNote`）を使わない（古い経路にだけ残す）
- `Task created: <id>`（stderr）と task の id（stdout）は、成功の応答を受けてから出す
- 応答の写し方:
  - 拒否は応答の code ごとに、§5.1 の表の exit と文面へ写す
  - mem の拒否は今の mem の終了コードへ
  - relay の拒否は `RELAY_REFUSAL_CODES` の文面と exit 2 へ
- `--register` の名簿の判定は、#4479 と同じ方向。この route の S2 に名簿の書き込みがあるので、#4479 は PR1b に含める（PM の範囲の判断で推奨。§7）

---

## 6. 試験の層と陰性対照

### 6.1 表の試験（結合、実サーバーの route を直に呼ぶ。偽の CLI ツールだけ。本物の agy は使わない）

| 軸 | 値 |
|---|---|
| 操作の組み合わせ | 単独の送信／`--contract`／`--register`／`--register --role`／`--role`（名簿にある instance）／`--no-role`／`--contract --role`（ロールの食い違いで `PUT /instances/roles` に当たる形を含む）。それぞれに `--reply-to`・`--auto-yes`（`--auto-yes-answer-mode`・`--duration`）・`--model`・`--note`・`--new-conversation`・`--no-brief`/`--with-brief` の有無、`--instance`＋`--agent` の組（レビュー B P2-5） |
| 起点 | `terminal`・`session`・`agent`・`schedule`・`unknown`・`legacy` |
| 申告 | なし・`api-key` |
| 拒否する段 | 宛先の方針・relay の規則 0・Auto-Yes の方針・relay の方針以外（C5）・名簿・mem（C4）・宛先の食い違い（C3）・拒否なし |
| 割り込み | なし・h-S2（名簿の tool／既定／返信先の名簿／申告を、許す側から断る側へ、と断る側から許す側へ）・h-S3・h-S3b |
| 解決の食い違い | 名簿に無い ad-hoc の id ＋ `--agent antigravity` ＋ `--reply-to`（`--register` あり・なし、起点は端末を含む全部）。**期待: exit 33。stderr の 1 行目は規則 0 の理由。何も残らない（relay の行・system line・名簿・タスク・grant が 0）。何も打たない。配信の記録が 0**（N1・I2a）。同じ形で `--agent codex`（既定は claude）は、許可され、relay の `to` の判定に codex が使われる（応答の `policy` で確かめる） |
| 端の解決の失敗 | `from`（返信先）の解決で、名簿の読みの失敗を注入する（DB の読みの例外）。期待: 503 `RELAY_ENDPOINT_UNRESOLVED`。何も残らない |

- 生成した直積を全部流す。実行時間が問題になったら、申告ありの軸を「全許可」の 1 行に畳む（PM の範囲の判断で推奨。理由を表の頭に書く）
- **観測は、対象の表の中身の snapshot の差分**（レビュー A P2-1）:
  - DB: `tasks`・agent instances と role の表・`session_relays`・`chat_messages`・mem の表・incarnation の表
  - DB の外: `peekAutoYesState`、ポーラーの登録、env-snapshot のディレクトリ、偽の tmux への送信の記録、偽のツールの起動の記録、**偽の WebSocket の配信の記録**（N2）
  - 応答: HTTP の status・`code`・`policy.stage`・`policy.operation`・送った `origin` の写し
  - CLI を通す行では、exit・stderr の 1 行目・stdout
- S1 の「書き込み無し」も、同じ snapshot の差分で確かめる（S1 の後に止める hook）

### 6.2 CLI を通す表

- §6.1 から、CLI の組み立て（フラグ → 本文）を確かめる行を選ぶ。起点ごとに 1 行以上、操作の組み合わせごとに 1 行以上
- 起点の入力（TTY・環境変数）は `repro-4449-codex.md` の方法で作る
- 能力の確認の行:
  - 確認の失敗で exit し、古い経路の要求が 0 回
  - 新しい route の 404・5xx で古い経路へ切り替えない
  - 能力の一覧にトークンが無いときは、H3 の答えどおり

### 6.3 変異（陰性対照）。それぞれ特定の行を赤にする（レビュー A P2-1・B P2-5）

| 変異 | 赤になるべき行 |
|---|---|
| **（陽性対照）S2 の中の拒否を `return` にする（例外にしない）** | 拒否の全行（コミットされて行が残る） |
| (c) の `openRelay` の `ok:false` を例外に変えない | 解決の食い違いの行で、(b) の relay の判定を外した変異と組み合わせた行（`openRelay` だけが断る形） |
| (b) の relay の判定を外す | 返信先が antigravity の行（(c) の例外でまだ守られることも、別の行で確かめる） |
| `from` の解決に、strict でなく fallback の `resolveRelaySession` を使う | 端の解決の失敗の行（例外を注入した行。fallback の claude で通り、relay が開いて赤）。第 2 版の「ad-hoc の端」の行は、例外が起きないので等価変異だった（確かめ A P1-1 の残り 3） |
| `to` の tool を、実際に打つ tool でなく名簿から解決し直す | 解決の食い違いの行（antigravity の ad-hoc が既定の claude で判定され、relay が開いて赤。I2a） |
| 配信を S2 の中で出す（集めない） | mem の `limit_exceeded` で戻る行（配信の記録が 1 になり赤。I10） |
| (c1) の後でなく前に (b) を走らせる（`--register --role` の名簿を見ずに判定する） | `--register --role --instance adhoc --agent antigravity --reply-to` の行。I2a の `to` はこの変異でも守られるので、赤になるのは名簿の検査（上限・id）を (b) で見る行（確かめ A P1-1 の残り 2） |
| 判定をトランザクションの外（コミットの後）へ出す | 拒否の全行 |
| 書き込みを S1（トランザクションの前）へ出す | 拒否の全行（とくにロールの UPDATE・incarnation の行） |
| DB の外の副作用（grant・ポーラー・env-snapshot のファイル）を判定の前へ出す | 拒否の行で、DB の外の観測が増える |
| S2 で名簿・既定を読み直さず、S1 の値を使う（I3c） | h-S2 で断る側へ変える行 |
| S2 (a) の比較を外す | h-S2 で**許す側へ**変える行（S1 の所有・ロールの確認と違う宛先へ送る。期待は `OPERATION_TARGET_CHANGED`） |
| S3 で宛先を名簿から解決し直す（I2 に反する） | h-S3 の行（別の tool の pane に打つ） |
| (b) の Auto-Yes の判定を外す | 端末 × `--auto-yes` × antigravity の行 |
| (b) の shutdown・`onlyIfOff` の読みを外す | shutdown の行（(e) で 503 になり行が残る） |
| ロールの設定の判定を外す・ロールの設定を (c) の外で書く | `--role`・`--contract --role`（`PUT` 相当）の行 |
| 能力の確認の失敗を `false` に倒す | 能力の確認の失敗の行（古い経路の要求が 1 以上） |
| S0 の早い判定を外す | 方針と非方針の両方で断る行（I9。exit 33 でなく非方針の exit が出る） |

- **今の形の陽性対照**: 今の別々の要求の形（0.53.0 の CLI）で同じ表の CLI の行を流すと、K1・K2 の行が赤になる

### 6.4 単体

- S2 の同期の関数（判定と書き込み）の表。snapshot の差分で確かめる
- S4 の 1 トランザクションの表。finally（予期しない例外）・要求の中断の行を含む

---

## 7. PR の分け方（Sprint 9。PM の範囲の判断で推奨）

| PR | 中身 | 陽性対照・revert |
|---|---|---|
| PR0 表の器 | §6.1 の表の器と hook。`it.fails` を 2 種に分ける（レビュー B P2-3）:<br>(i) 新しい route の行（PR1b で外す）<br>(ii) CLI を通す K1・K2 の行（PR2 で外す） | 今の形で K1・K2 の行が赤 |
| PR1a 切り出し | 各 route の書き込みと判定を、同期の関数と「読みだけ」の関数に切り出す（振る舞いを変えない）。対象: `send`・`tasks`・`instances/roles`・`relays`・`auto-yes`・mem の書き手の解決 | 既存の試験が変わらず通る。単独で revert できる |
| PR1b 新しい route | `send-operation`（S0〜S4）、能力 `send-operation-v1`、#4479（名簿の登録の判定を S2 へ） | §6.1 の (i) の行が緑、§6.3 の変異で赤。PR1b を revert すると、能力が消えて CLI（PR2）が H3 の扱いに戻る。それを PR2 の試験に入れる |
| PR2 CLI | `send` を新しい route へ（書き込みのフラグを伴うとき）、能力の確認、古いサーバーの扱い（H3）、docs（§5.1 の一覧） | §6.2・(ii) の行が緑。PR2 を revert しても PR1 は安全（呼び手が無い） |
| PR3（後で） | 冪等（`operationKey`）の表と migration、起動の時の照合（§4.4）。`POST /instances/roles` の既存の冪等の key（`instances/roles/route.ts:158-161`）を参考にする | 同じ key の再送で行が 1 つ。migration は戻しにくいので、追加の表だけにする |

- 直列: #4473 → #4420 → PR0 → PR1a → PR1b → PR2
- #4420 の往復の数え方（同期）は PR1a の切り出しの対象に入る
- 高リスクなので、各 PR のレビューは系統を分けて 2 本。重要な指摘は再現する

---

## 8. 伺う点

### 8.1 人の決定（11-19、mem 91b25c73）

人の答えは「推奨で」（2026-11-19、mem の決定 91b25c73）。H1〜H6 はすべて推奨どおり。

| # | 決定 |
|---|---|
| H1 | 送信の途中で宛先が変わった（`OPERATION_TARGET_CHANGED`、何も書いていない、再送してよい）は **exit 31 を流用**する。31（`RoleExitCode.CONFLICT`）の docs の定義を「送信の宛先の食い違いを含む」と書き換える（C3） |
| H2 | `--note` の mem の拒否では、契約の task の行も**残らない**（全部を戻す）。exit は mem の終了コードのまま（C4） |
| H3 | 新しい CLI と古いサーバー（能力の一覧にトークンが無い）: **起点で分ける**。端末の起点は今の別々の要求の形で送り、stderr に 1 行の注意を出す。端末以外の起点は断る（exit 2、I7 で固定）。能力の確認の失敗は、どの起点でも断る（C7・C8） |
| H4 | 新しい公開 API `POST /api/worktrees/:id/send-operation`・能力 `send-operation-v1`・応答の欄 `policy.stage`・応答の code `RELAY_ENDPOINT_UNRESOLVED`（新しい route だけ）・`OPERATION_BUSY`（どちらも exit 99、再送してよい）を**足す**（C1・C15・C16） |
| H5 | CLI の中断の意味の変化を**この形でよい**とする（要求を送った後は、サーバーが打鍵まで進みうる。打鍵の直前に中断を確かめ、届いていれば打たない。C14） |
| H6 | 端末から ad-hoc の instance へ `--agent antigravity --reply-to` で送る形を**直す**（今の exit 0 → exit 33。relay の規則 0 の破れの直し。C11b）。docs の既知の制限と CHANGELOG に、直ったことを書く。**PR1a 時点の今**: #4496 で既に exit 33・何も残らない（C11b の注）。決定はそのまま |

以下は、人に伺ったときの問いの記録（決定の根拠として残す）。

#### 伺った問い（公開の契約の変更だけ。§5.1 の表とあわせて）

| # | 問い | 選択肢 | 推奨 |
|---|---|---|---|
| H1 | 送信の途中で宛先が変わった（何も書いていない・再送してよい）の exit（C3） | (a) **31 を流用する**。31 の定義（`RoleExitCode.CONFLICT`、`src/cli/types/index.ts:705`: 「誰かが先に変えた。断られた書き込みは何も変えていない」）の docs を「送信の宛先の食い違いを含む」と書き換える<br>(b) 新しい番号を足す | (a)。意味（先に誰かが変えた・何も変えていない・再送してよい）が今の 31 と同じで、エージェントの分岐を増やさない |
| H2 | `--note` の mem の拒否で、契約の task の行が残らなくなる（C4。今は `failed` で残る） | (a) 残らない（全部を戻す）<br>(b) 今と同じく `failed` で残す（S2 の外で書く） | (a)。I1 と同じく「断られた操作は何も残さない」にそろう。exit は mem の終了コードのまま |
| H3 | 新しい CLI と古いサーバー（能力の一覧にトークンが無い）で、**端末の起点の**書き込みのフラグを伴う送信をどうするか（C7）。端末以外の起点は、答えにかかわらず断る（I7） | (a) 断る（exit 2。「サーバーを同じ版に更新してください」）<br>(b) 今の別々の要求の形で送り、stderr に 1 行の注意<br>(c)（第 2 版の案。第 3 版では I7 に固定した）起点で分ける。端末（人）は (b)、それ以外（エージェント・Schedule・不明。stderr を読まない呼び手）は (a) | (c)。エージェントからの送信で、既知の穴（K1・K2）の形を黙って使わない。人の端末は使い続けられる。能力の確認の失敗は、どれでも断る（C8） |
| H4 | 新しい公開 API `POST /api/worktrees/:id/send-operation` と能力 `send-operation-v1`、応答の欄 `policy.stage`、新しい応答の code `RELAY_ENDPOINT_UNRESOLVED`（新しい route だけ。既存の `POST /api/relays` は変えない）・`OPERATION_BUSY`（どちらも CLI は exit 99、再送してよい）を足してよいか（C1・C15・C16） | 足す／足さない（足さないなら案 A は取れない） | 足す |
| H5 | CLI の中断の意味の変化（C14）。要求を送った後に Ctrl-C しても、サーバーが打鍵まで進みうる（打鍵の直前に中断を確かめ、届いていれば打たない） | (a) この形でよい<br>(b) 中断を届けるため、CLI が要求の取り消しの要求を別に送る（新しい API がもう 1 つ要る） | (a)。今の `/send` を送った後の Ctrl-C も、サーバーが打鍵まで進む（新しい route でも、打つかどうかの境目が `/send` から操作の全体へ広がるだけ） |
| H6 | 端末から、名簿に無い ad-hoc の instance へ `--agent antigravity --reply-to` で送る形（C11b）が、今は成功（exit 0。relay が開き打鍵される）で、新しい形では exit 33 になる（伺った時点の記録。PR1a 時点では #4496 で既に exit 33）。relay の規則 0（どの起点でも antigravity の端の relay を断る、#4437 の決定）の破れを直す変化 | (a) 直す（exit 33）<br>(b) 端末の起点だけ今のまま（規則 0 の破れを既知の制限として docs に書く） | (a)。規則 0 は起点を問わない決まりで、今の成功は判定する tool の取り違えによるもの。docs の既知の制限（0.53.0 の CHANGELOG）にも、直ったことを書く |

### 8.2 PM が範囲の中で決めること（推奨）

| # | 事項 | 推奨 |
|---|---|---|
| P1 | 案 A か案 B か | 案 A |
| P2 | 冪等（`operationKey`）を Sprint 9 に入れるか | 入れない（PR3。打ち直しの二重は I1 の範囲の外として docs に書く） |
| P3 | 確定の後の失敗で、名簿の登録（ロールあり）とロールの設定を残すか | 残す（今と同じ）。ロールなしの登録は今と同じく送れた後だけ（C13） |
| P4 | #4479 を PR1b に含めるか | 含める |
| P5 | 表が大きすぎるときに畳む軸 | 申告ありの軸 |
| P6 | プロセスの停止の残りを、Sprint 9 では既知の制限とするか（§4.4） | する（起動の時の照合は PR3 と一緒に） |
| P7 | 打鍵の前の要求の中断を not_sent にするか（§4.2 S3） | する |
| P8 | await の網羅の静的な検査を入れるか（§4.3） | Sprint 9 では入れない（安全の根拠は I3c） |

### 8.3 PR1b の前に決める未確定（PR1a で一覧し、PM が 11-21 に決めた）

PR0 の表とそのレビュー（`s9/review-4466-pr0-codex-r2.md` の新規 P1 1・2）で、設計が決めていない点が出た。各項目に推奨と根拠を書き、PM の決定（11-21）を最後の列に書いた。3 つとも推奨の (a)。

| # | 未確定 | 選択肢 | 推奨 | 根拠 | PM 決定 11-21 |
|---|---|---|---|---|---|
| U1 | §4.1 の成功の応答の `policy` の形 | (a) PR0 の表の案: `policy.target.tool` と、relay があれば `policy.relay.from` / `policy.relay.to`（判定した tool）<br>(b) 成功では `policy` を出さない（§4.1 のまま） | (a) | §6.1 の ad-hoc の `--agent codex` の対照（`to` の判定に codex が使われる）と §6.3 の変異「`to` を名簿から解決し直す」は、応答に判定した tool が無いと観測できない（打鍵先の instance だけでは、`to` の規則 0 がどの tool で判定されたかを見分けられない）。(b) なら §6.1 の期待を DB の外の観測に書き換える必要がある | **(a)**。成功の応答に `policy.target.tool` と、relay があれば `policy.relay.from` / `policy.relay.to` を載せる（§4.1） |
| U2 | 同じ要求で宛先の方針（`TOOL_POLICY_DENIED`）と relay の規則 0（`RELAY_TOOL_POLICY_DENIED`）の両方が断るとき、どちらの code を返すか（§4.2 (b) は 1 宛先 → 2 relay の順、§6.1 の解決の食い違いの行は「規則 0 の理由」を期待） | (a) relay を先（`RELAY_TOOL_POLICY_DENIED`）<br>(b) 宛先を先（`TOOL_POLICY_DENIED`。§4.2 (b) の番号のまま） | (a) | 今の書き込みの API の判定（`findWriteToolPolicyRefusal`、`write-tool-policy.ts`）は relay を先に判定する（CLI が relay を打鍵の前に開く順）。(a) なら C11a と、この共通の書き込みの判定（tasks・roles）と同じ code になり、§6.1 の期待とも合う（PR1a r1 で根拠を限定した: 旧 CLI のすべての経路と同じになるわけではない。ロールなし・契約なしで先に Auto-Yes を有効にする経路は、Auto-Yes の route の方針が先に断るので `TOOL_POLICY_DENIED` になる）。exit はどちらも 33 で変わらない。(a) を採るなら §4.2 (b) の 1 と 2 の順を入れ替える（判定の集合は同じ） | **(a)**。relay を先に判定し、両方が断るときは `RELAY_TOOL_POLICY_DENIED`（今の経路と同じ code）。§4.2 (b) の 1 と 2 の順を入れ替えた（§4.2 (b) の「判定の順」） |
| U3 | §5.1 C6 の名簿の拒否の応答の code | (a) `invalid_request`（PR0 の表の案）<br>(b) 新しい code（例 `ROSTER_LIMIT_EXCEEDED`）を足す | (a) | 今の `POST /instances/roles` は上限で 400 を返し、同じ値を `error` の欄に載せる（`roleErrorResponse`）。新しい code を足すと H4 の公開 API の追加が増え、CLI の写し（exit 2）も同じ。ただし欄の名前が `error` から `code` に変わるので、PR2 の CLI の写しで両方を読むことを確かめる | **(a)**。`invalid_request`。新しい code は足さない。PR2 の CLI の写しで、`error` の欄（今の `POST /instances/roles`）と `code` の欄（新しい route）の両方を読むことを確かめる（§5.1 C6） |

---

## 9. 未確認・レビューで見てほしい点

1. `/send` の段の関数（起動・打鍵・relay の予約・ask の予約）を、判定済みの宛先を受ける形で切り出せるか。`handleSend`（`send/route.ts:111`）の境目は PR1a で確かめる
2. mem の書き手の解決の「読みだけ」の版（incarnation を作らない）を作れるか（`mem/service.ts:226-230`）。作れないなら、S1 では書き手を解決せず、S2 で解決する
3. `resolveRelaySession` を S2 の中で同期に呼べるか（`relay-session-ref.ts:62-77`）
4. 表の直積の行の数と、実行の時間（PR0 で数える）
5. `request.signal` が、Next.js の route で CLI の切断を反映するか（S3 の中断の確認）
6. **既知の限界（記録）**: relay の行は端を `{worktreeId, instanceId}` だけで持ち、`toTool` を記録しない。配送（`relay-delivery.ts`）は名簿から tool を解決し直す。このため I2 の「決めた値を持ち回る」は、作成と打鍵までで、配送には届かない。ad-hoc の `--agent codex`（既定は claude）の relay は、配送では claude の pane を見る。方針の破れではない（antigravity なら配送の規則 0 が取り消す、#4456 (5)）。relay の行に tool を記録するかは、別の Issue で考える（PM が追跡を決める）

---

## 10. 設計レビューの処分（第 2 版）

- 処分の語: 採用（設計を直した）・却下（理由つき）・未解決（次の手つき）
- P1 は全部を設計で塞いだ

### 10.1 レビュー A（安全の不変条件）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P1-1 S2 (c) の書き込み関数の拒否がロールバックに結び付かない（規則 0 を含む） | 採用（I3a: S2 の拒否は全部例外で戻す。I3b: (c) が断りうることを (b) で同じ解決の関数で先に判定し、端の解決の例外は断る。試験に解決の食い違いの行と、`return` にする陽性対照） | §2、§4.2、§6.1、§6.3 |
| P2-1 変異が等価になる・観測が行の数だけ | 採用（変異を「赤になる形」に置き換えた。観測を表の中身の snapshot の差分と DB の外に広げた） | §6.1、§6.3 |
| P2-2 await の数の試験は自己参照 | 採用（安全の根拠を I3c に置き、hook は S2 の直前の 1 点に。網羅は静的な検査で、Sprint 9 では入れない） | §2 I3c、§4.3、§8.2 P8 |
| P2-3 grant の (e) はコミットの後で断られうる | 採用（shutdown と `onlyIfOff` を (b) へ。`onlyIfOff` は断らず「既に on」として扱う） | §4.2 (b)・(e) |
| P2-4 確定の後のクラッシュ・例外・中断が I6 の外 | 採用（S3 を try/finally にし、必ず S4。中断は打鍵の前に not_sent。プロセスの停止は Sprint 9 の既知の制限で、照合は PR3 と一緒に） | §2 I6、§4.2、§4.4、§8.2 P6・P7 |
| P2-5 env の基準はファイル、S1 は書き込み無しではない | 採用（env はコミットの後の S3 の頭で書く。S1 は読みだけの関数にし、incarnation の作成は S2 へ） | §4.2、§1 |
| P2-6 能力の確認の失敗を古い経路への格下げにしない | 採用（`serverResolvesSessionTargets` と同じ形。失敗は exit。新しい route の失敗で切り替えない） | §2 I7、§4.6、§5.1 C8 |
| P3-1 拒否の優先順位（33 を先に） | 採用（S0 の早い判定。I9） | §2 I9、§4.2 S0、§6.3 |
| P3-2 `IMMEDIATE` | 採用 | §4.2 |
| P3-3 note の書き手の欄 | 採用 | §4.1 |
| P3-4 冪等の材料と打ち直しの二重 | 採用（I1 の範囲の外に明記。PR3 で既存の key を参考にする） | §2、§7 |
| P3-5 行番号・範囲の外・ロールバックの後のログ | 採用 | §1、§2、§4.2 (d) |

### 10.2 レビュー B（公開の契約・互換・PR の分け方）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| P1-1 契約の中身を受けるのは実コードと食い違う | 採用（`contract: { path }`。サーバーが `loadTaskContract` で読む今の形） | §4.1、§1 |
| P1-2 契約の変更の一覧が無い・mem の拒否の結果が変わる | 採用（§5.1 の表 C1〜C10。人の了承の要否つき。docs の直す場所を列挙） | §5.1、§8.1 |
| P2-1 Q4 の推奨が不整合 | 採用（31 の流用か新しい番号かを人に伺う H1。流用なら 31 の docs の定義を書き換える契約の変更として扱う） | §8.1 H1 |
| P2-2 古いサーバーの経路 (a) は I7 に反する | 採用（能力の確認の失敗は断る。トークンが無い古いサーバーは H3 で人に伺う。推奨は起点で分ける。逆向き（古い CLI）は K1・K2 が残ると明記） | §2、§4.6、§8.1 H3 |
| P2-3 PR0 の `it.fails` と PR1 が合わない・PR1 が大きい | 採用（`it.fails` を 2 種に。PR1 を切り出しと新しい route に分け、revert の扱いを書いた） | §7 |
| P2-4 #4420・他の設計との接続 | 採用（#4420 は既存の code・同期の数え方。PM の決定。#4479 は PR1b。#4437・#4449 の根拠の場所。`/send` の判定の持ち回り） | 冒頭、§2 I8、§4.2、§5.1 C5、§7 |
| P2-5 Issue の組み合わせの漏れ | 採用（軸と本文の欄を足した。brief の応答は持ち回る。ロールの保存の変異を足した。after-send の判定の入力は持ち回るので変わらない） | §4.1、§4.4、§6.1、§6.3 |
| P3-1 能力の版の上げ方 | 採用 | §4.1 |
| P3-2 `operationId` の使い道 | 採用（出さない） | §4.1 |
| P3-3 `target` の欄の正当化 | 採用 | §4.1 |
| P3-4 画面は変更なし | 採用 | §4.5 |
| P3-5 再送してよいかの表 | 採用 | §5.1 |
| P3-6 ファイル名の確認 | 確認として受けた（変更なし） | — |

- 却下 0 件・未解決 0 件

### 10.3 第 2 版の確かめ（`verify-4466-v2.md`）の処分（第 3 版）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| A P1-1 の残り 1（`resolveRelaySession` は例外を中で受けて fallback を返す） | 採用（失敗を値で返す `resolveRelaySessionStrict` を足し、作成の経路（S2 と `POST /api/relays`）は strict を使う。配送は今の fallback の版のまま） | §2 I3b、§4.2 (b)2、§5.1 C15 |
| A P1-1 の残り 2（(b) と (c) が見る名簿が違う） | 採用（S2 の順を「(c1) 名簿・ロールの DB の書き込み → (b) → (c2)」に変え、(b) が (c2) と同じ DB の状態を見る） | §2 I3b、§4.2 |
| A P1-1 の残り 3（変異が等価） | 採用（例外を注入する行に替えた） | §6.1、§6.3 |
| A P1-1 の残り 4（食い違いの行の期待が無い） | 採用 | §6.1 |
| N1（P1）ad-hoc＋`--agent antigravity`＋`--reply-to` で規則 0 が別の tool を判定 | 採用（I2a: `to` の規則 0 と打鍵の判定は、実際に打つ tool 1 つで決める。`openRelay` に `toTool` を渡す。PM の確かめでは、今のコードは打鍵には届かないが relay の行と system line が残る。この設計では何も残さない） | §2 I2a、§4.2 (b)・(c2)、§5.1 C11、§6.1、§6.3 |
| N2 system line の配信がロールバックで戻らない | 採用（I10: S2 の中の配信・ログは集めて、コミットの後に出す。mem の `storeFailure` も (b) で先に判定。観測に配信の記録） | §2 I10、§4.2、§6.1、§6.3 |
| N3 `message` と `contract` の両方 | 採用（400 `invalid_request`） | §4.1、§5.1 C18 |
| N4 H3 (b) で端末以外の起点が古い経路へ落ちる | 採用（I7 に固定。H3 は端末だけを伺う） | §2 I7、§4.6、§8.1 H3 |
| N5 中断の確認が打鍵の直前でない | 採用（打鍵の直前の入力の境目で確かめる） | §4.2 S3 |
| 表の漏れ 1 ロールなしの `--register` | 採用（今と同じく、送れた後に S3 で登録。P3 を直した） | §4.2 S3・S4、§5.1 C13、§8.2 P3 |
| 表の漏れ 2 確定の後の失敗の出力 | 採用（失敗の応答に `taskId` などを載せ、CLI は今と同じ順で出す） | §4.2 S4、§5.1 C12 |
| 表の漏れ 3 CLI の中断の意味 | 採用（人に伺う H5） | §5.1 C14、§8.1 H5 |
| 表の漏れ 4 新しい code（端の解決の失敗・busy） | 採用（`RELAY_ENDPOINT_UNRESOLVED`・`OPERATION_BUSY`、exit 99。H4 に入れた） | §5.1 C15・C16、§8.1 H4 |
| 表の漏れ 5 `--note` と Auto-Yes の状態 | 採用 | §5.1 C17 |

- 却下 0・未解決 0

### 10.4 第 3 版の確かめ（`verify-4466-v2.md` の「## 第 3 版」）の処分（第 3.1 版）

| 指摘 | 処分 | 反映した節 |
|---|---|---|
| V3-1 C11 の「今」と人の了承が、端末の起点で誤り | 採用（C11 を AI の起点（C11a、了承不要）と端末の起点（C11b、今は exit 0 で規則 0 の破れ → exit 33、了承が要る）の 2 行に分けた。人への問い H6 を足した） | §5.1、§8.1 H6 |
| V3-2 C15 が既存の `POST /api/relays` を変え、I5 と食い違う | 採用（strict は新しい route だけ。`POST /api/relays` は今の fallback のまま。古い CLI・`ask` の exit と文面は今と同じ。H4 を直した） | §4.2 (b)2、§5.1 C15、§8.1 H4 |
| V3-N1（P3）戻すと方針の拒否の監査の記録が消える | 採用（`send-operation-rolled-back` に code・段・端・tool・起点を載せる） | §4.2 (d) |
| 記録: relay の行に `toTool` が無く、配送で解決し直す | 採用（§9 に既知の限界として書いた。追跡は PM） | §9 の 6 |
| N1 の事実の訂正（確かめ側） | 確認として受けた（C11a・C11b に反映） | §5.1 |

- 人への問いは H6 が増えた（H1〜H6）。ほかの問いの形は変わらない
