# 1 つの送信の操作の書き込みを 1 要求で確定し、方針で断られたら何も残さない（Issue #4466）設計

- 段: 設計（この文書だけ）。コード・DB・試験は書かない。実装は Sprint 9（設計レビュー 2 本の処分の後）。#4473（`send.ts`・`send-request.ts`）と #4420（`relay-service.ts`）のマージの後に始める（`pm-plan-s8.md` の直列）
- 版: 第 1 版（2026-11-19、イネーブラー claude-5）
- 基準: develop `b8f6e33b8`（v0.53.0）。行番号はこの版のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4466 の本文（背景・原因の読み・やること・不変条件 I1/I2・表の試験）
- 材料: `workspace/orchestration/runs/2026-11-18/review-4449-1.md`・`review-4449-3-codex.md`・`repro-4449-codex.md`・`lead-return-s7-a.md`、#4437 の STOP（`2026-11-17/stop-4437-pr2-2.md`）、`changelog.d` から CHANGELOG 0.53.0 へ入った #4449 の既知の制限
- 筆者の関わり: 筆者（claude-5）は #4449 の指摘の再現（`repro-4449-codex.md`）を担当した。#4449 の実装には関わっていない

---

## 0. 結論（先に）

- **推奨: 案 A「1 要求の操作 API」**。CLI の `send` の 1 操作を、新しい 1 つの要求 `POST /api/worktrees/:id/send-operation` で送る
  - サーバーは次の順で処理する: 読み・判定（await あり）→ **同期の確定の区間**（宛先の再解決・すべての方針の判定・すべての行の書き込みを 1 つのトランザクションで）→ 起動と打鍵
  - 方針の拒否は確定の区間より前にしか起きない。だから断られた操作は何も残さない（I1）
  - 確定の後の失敗（起動の失敗・プロンプト待ち・所有の食い違いなど）は方針の拒否ではない。今と同じ「失敗の記録」（タスクは `failed`、relay は取り消し、grant は戻す）を、サーバーが 1 つのトランザクションで行う
- **捨てた案**:
  - 案 B「取り消しの確定点」（仮の行を書いて最後に確定・破棄する）: 5 種類の表すべてに仮の状態を足し、すべての読み手に「仮を見ない」を守らせる必要がある。1 つでも漏れると、仮の行が効いてしまう（fail-open の形の穴）
  - 案 C「CLI の取り消しを足し続ける」: 同じ種類の穴が 3 回出た今の形そのもの
- **DB の変更は無し**（案 A の基本形）。再送の冪等（`operationKey`）を入れるなら、小さな表を足す追加の migration が要る（§8 Q3）
- **表の試験**: 操作の組み合わせ × 起点 × 申告 × 拒否する段 × **割り込みの点**（サーバーのすべての await の点で、名簿・既定・返信先を変える）の表で、I1・I2 を固定する
  - 変異は、段ごと・入口ごとに 1 つずつ外す。どの判定が要るかを区別できるようにする（codex レビュー 3 の P2 への答え）

---

## 1. 事実: 今の 1 操作の要求の並び

CLI の `send` は、1 つの操作を次の別々の要求に分けて送る（`src/cli/commands/send.ts:1160-1484`）。

| 段 | 要求 | 書くもの | 方針の判定 | 出典 |
|---|---|---|---|---|
| 0 | `GET resolve-target`・`GET instances/roles`・`GET relays の宛先の解決`（読み） | — | — | `send.ts:1172`・`:1213`・`:1234`・`:1252-1254` |
| 1 | `POST /instances/roles`（`--register --role`） | 名簿の行・ロールの設定 | 書き込みの中で判定（#4449） | `send.ts:1256-1260`、`write-tool-policy.ts:104` |
| 2 | `POST /tasks`（`--contract`）、ロールの食い違いのときは `PUT /instances/roles` も | タスクの行・環境の基準（`recordEnvBaseline`、await） | 作成の直前に判定 | `send.ts:1271-1281`、`tasks/route.ts:201-237` |
| 3 | `POST /api/relays`（`--reply-to`、ロールあり） | relay の行 | relay の規則 0 | `send.ts:1318` |
| 4 | `GET /auto-yes` → `POST /auto-yes` | grant（メモリの状態） | 所有の確認（await）の後に再判定（#4449 P2-1 の直し） | `send.ts:1321-1374`、`auto-yes/route.ts:590-631` |
| 5 | `POST /api/relays`（`--reply-to`、ロールなし） | relay の行 | relay の規則 0 | `send.ts:1400-1405` |
| 6 | `POST mem/items`（`--note`） | mem の `waiting` の項目 | — | `send.ts:1411-1417` |
| 7 | `POST /send` | ロールの保存・セッションの起動・打鍵・relay の予約 | 所有の確認の前（`route.ts:294`）と、await の後の読み直し（`:359`） | `send.ts:1431`、`send/route.ts:294-509` |
| 8 | `PATCH /tasks/:id`（running）、`--register`（ロールなし）の名簿の登録、`--model` の後回しの Auto-Yes | タスクの状態・名簿・grant | 名簿は書き込みの判定、grant は auto-yes の判定 | `send.ts:1467-1484` |

- 段の間の失敗は、CLI が取り消す（`failTask`・`cancelRelayQuietly`・`withdrawAutoYes`・`closeSendNote`、`send.ts:1286-1290`・`:1378-1392`・`:1433-1449`）。CLI が途中で止まれば、取り消しは走らない
- 0.53.0 の既知の制限（CHANGELOG 0.53.0、#4466 K1・K2）:
  - K1: 返信先・既定が段の間で変わると、段 2 の後で段 3 か段 4 が断られ、タスクが残る
  - K2: `--model --auto-yes` では Auto-Yes が段 8 に回る。段 1・7 の後で Auto-Yes だけが断られる（警告・exit 0）

### 1.1 同じ種類の穴の履歴（Issue の背景）

| 回 | 場所 | 形 |
|---|---|---|
| 1 | #4437 PR2（STOP） | 事前の照会と書き込みが別の要求。照会の失敗で書き込みが進む |
| 2 | #4449 レビュー 1 P1-1 | 端末からの送信は許され Auto-Yes は断られる。先の書き込み（タスク・登録）が残る（`repro-4449-codex.md` で再現） |
| 3 | #4449 codex レビュー 3 P1 | relay の宛先とタスクの宛先が別々に解決され、relay の拒否の前にタスクが残る |

**原因の読み（Issue と同じ）**: 1 つの操作が別々の要求にまたがり、後の段の拒否と、先の段の書き込みが、同じ確定点を持たない。個々の要求の中の判定をどれだけ正しくしても、要求の間に入る変化（既定・名簿・返信先）は防げない。

---

## 2. 不変条件

Issue の I1・I2 を、この設計の言葉で書き直し、守り方に要る条件を足す。

| # | 不変条件 | 守る場所 |
|---|---|---|
| **I1** | 方針（tool-policy・relay の規則 0・Auto-Yes の方針）で断られる操作は、どの組み合わせ・どの起点・どの割り込みでも、次のどれも残さない: タスクの行・名簿の行・ロールの設定・relay の行・mem の項目・grant・プロセスの起動・打鍵。CLI は exit 33 で終わり、stderr の 1 行目は理由、stdout は空 | §4.3 の確定の区間 |
| **I2** | 判定した値でそのまま実行する。宛先（instance と tool）・relay の両端・起点は、確定の区間で 1 回だけ決める。実行の段はそれを読み直さず、持ち回る | §4.3・§4.4 |
| I3 | 確定の区間の中に `await` を置かない。方針の最後の判定と、すべての行の書き込みは、同じ同期の区間（better-sqlite3 のトランザクション）で行う | §4.3。試験は §6 の割り込みの点 |
| I4 | 事前の照会（`GET …/tool-policy`）を、判定の代わりに使わない。照会の API は残してよいが、CLI は呼ばない（#4449 の I4 を続ける） | §4.1 |
| I5 | 新しい要求を使わない呼び手（画面・`ask`・`respond`・古い CLI）は、今の振る舞いのまま。今の個々の書き込みの API の判定（#4449）も外さない | §4.5 |
| I6 | 確定の後に起きる失敗は、方針の拒否ではない。今の失敗の約束（タスクは `failed`、relay は取り消し、送っていなければ grant を戻す、mem の項目は閉じる）を、サーバーが 1 つのトランザクションで行う。確定の後に方針の判定をし直して断ることはしない（I2） | §4.4 |
| I7 | 新しい CLI と古いサーバーの組み合わせで、黙って柵を弱めない。CLI はサーバーの能力（`GET /api/capabilities`）で新しい要求の有無を確かめる。無いときの扱いは §4.6（人に伺う、§8 Q2） | §4.6 |
| I8 | 方針の判定は今の関数（`decideToolPolicy`・`findRelayToolPolicyDenial`・Auto-Yes の方針）を使う。判定の表そのものは変えない | §4.3 |

**I1 の範囲の外（明記する）**:
- 確定の後、配送の段で relay が方針に断られる場合。例: 確定の後に返信先の名簿の tool が antigravity に変わった。これは relay の pump が配送の時に取り消す（#4456 (5)）。この操作の書き込みの話ではない
- 方針ではない理由（所有の食い違い・起動の失敗・プロンプト待ち・入力欄が空でない）での失敗。I6 で扱う

---

## 3. 案の比較

| | 案 A（推奨）: 1 要求の操作 API | 案 B: 取り消しの確定点（仮の行） | 案 C: CLI の取り消しを強める（今の形の延長） |
|---|---|---|---|
| 中身 | CLI は 1 つの要求で、操作の全部（宛先・本文・契約・登録・ロール・返信先・Auto-Yes・note）を送る。サーバーが読み・判定・確定・実行の順で処理する | 今の別々の要求のまま、各書き込みを `staged`（仮）で作り、最後の `/send` が同期の区間で全部を判定して `active` へ上げるか、全部を消す。放置された仮の行は期限で掃除する | 各段の失敗で CLI が取り消す経路を足し、サーバー側の再判定を各 API に足す |
| I1 の守り方 | 確定の区間より前でしか方針の拒否が起きない（構造で守る） | 仮の行が「効かない」ことを、すべての読み手が守る（約束で守る） | 取り消しが走ることに頼る（CLI の停止・通信の断で破れる） |
| 推測の残り | 無し | 「仮の行を誰も読まない」の網羅（読み手は名簿の解決・relay の pump・tasks の一覧・brief・画面・Auto-Yes のポーラー…）。漏れは fail-open | CLI が最後まで走ること |
| DB の変更 | 無し（冪等を入れるなら追加の表 1 つ） | 5 種類の表に `operation_id`・状態の列、掃除の印。メモリの grant にも仮の状態 | 無し |
| 公開の契約 | 新しい route 1 つ。CLI の exit・stderr・stdout の約束は同じ | 既存の API の本文に `operationId` を足す | 無し |
| 実装の大きさ（見立て） | 中〜大（`/send` の処理を段に分ける作り直し） | 大（読み手の全部） | 小さく見えるが、同じ種類の穴が続く |
| 同じ種類の 4 回目の見込み | 低い（割り込みの点の表で固定できる） | 中（読み手の追加のたびに） | 高い（3 回出た形） |

### 3.1 推奨と、捨てた理由

**推奨は案 A。**
- I1 を「確定の区間より前でしか断らない」という構造で守れる
- 割り込みの点（await）は有限で、列挙できる。表の試験で全部を叩ける
- 宛先の解決が 1 回になるので、I2 も同じ区間で守れる

**案 B を捨てた理由**:
- 仮の行を作る時点で、方針で断られる操作の「行」が一時的にでも DB に入る
- 名簿の行・relay の行・grant を読むすべての経路が「仮を無視する」を守らないと、効いてしまう
- 名簿の解決（`resolveSessionTarget`）が仮の名簿の行を見て宛先を決める、などの漏れは、試験で全部を見つけにくい。#4419・#4430 で出た「外れうる観測に頼る」と同じ形の弱さ

**案 C を捨てた理由**:
- 今の形で 3 回出た種類で、PM の不変条件（3 回目は設計し直し）に当たる

---

## 4. 案 A の設計

### 4.1 要求の形

`POST /api/worktrees/:id/send-operation`（名前は見立て。`/send` を広げる案は §4.5 で比べる）

```jsonc
{
  "message": "…",                       // 打つ本文（--contract なら null。サーバーが契約から作る）
  "target": { "instanceId": "codex-2", "agent": "codex" },   // 名指し。両方省略なら既定
  "origin": "terminal", "originEvidence": "…",               // 今の /send と同じ
  "contract": { "path": ".commandmate/tasks/x.yaml", "content": "…" },  // --contract（今の POST /tasks の本文）
  "register": { "alias": null },        // --register
  "role": { … },                        // --role / --no-role / 条件（今の /send の role の欄と同じ）
  "replyTo": { "worktreeId": "…", "instanceId": "…", "allowRelayChain": false },
  "autoYes": { "durationMs": 3600000, "timing": "before-send" | "after-send", "onlyIfOff": true },
  "note": { "text": "…" },              // --note
  "model": "…", "newConversation": false,
  "expect": { "rosterRevision": 12 }    // 任意。CLI が読んだ名簿の版（下の 4.2）
}
```

- CLI は、事前の読み（段 0）を表示と入力の検査（id の形・別名の長さ・モデルの形）にだけ使う。宛先・relay の両端・タスクの宛先はサーバーが決める
- `contract.content` は CLI が読んで送る（今の `POST /tasks` と同じ。見立て: 今の本文の形を確かめて合わせる）
- 応答（成功）:
  ```jsonc
  { "ok": true, "operationId": "…", "target": {…}, "taskId": "…", "relayId": "…",
    "grant": {…}, "registered": true, "noteItemId": "…", "sent": { … 今の /send の応答 … } }
  ```
- 応答（方針の拒否）: 409 `TOOL_POLICY_DENIED`（relay は `RELAY_TOOL_POLICY_DENIED`）。本文は今の拒否と同じ形で、`policy.stage` を足す（`target`・`relay`・`auto-yes` のどれで断ったか。試験と CLI の表示に使う）
- CLI は、成功の応答を受けてから `Task created: <id>`（stderr）と task の id（stdout）を出す。拒否なら何も出さず、理由を 1 行目に出して exit 33（I1）

### 4.2 サーバーの段

| 段 | すること | await | 書き込み | 方針の拒否 |
|---|---|---|---|---|
| S0 検査 | 本文の形・値の検査（今の `send-request.ts` の検査を共有） | 無し | 無し | — |
| S1 読み | 次を行う（この段では方針を判定しない）:<br>1. 宛先の候補の解決（名簿・既定）<br>2. relay の両端の候補の解決<br>3. 契約の読み込みと検証<br>4. 環境の基準の採取（今の `captureEnvSnapshot`）<br>5. mem の note の対象の解決（`withMemTarget`）<br>6. ロールの条件の読み<br>7. セッションの所有の確認（`checkSessionOwnership`）<br>8. モデルの検査 | 有り | 無し | 無し |
| **S2 確定** | **同期の区間（1 つの `db.transaction`）**。次の順に行う:<br>(a) 宛先と relay の両端を DB から解決し直し、S1 の候補と比べる。違えば 409 `operation_target_changed` で何も書かない（方針ではない。exit は §8 Q4）<br>(b) 起点と申告を読み、宛先への送信・relay・Auto-Yes の方針を全部判定する（I8 の関数）。1 つでも拒否なら、409 で何も書かない<br>(c) 名簿の行 → ロールの設定 → タスク → relay（開く・予約する）→ mem の note の項目、を書く<br>(d) トランザクションを閉じる<br>(e) **同じ同期の流れで、await を挟まずに**、grant（メモリ）を有効にする（`timing: before-send` のとき） | **無し（I3）** | 全部ここ | **ここだけ** |
| S3 実行 | セッションの起動（必要なら）→ 打鍵 → 送信の結果の記録（今の `sendUserMessage` の流れ、宛先は S2 の値を持ち回る）。`after-send` の grant はここで有効にする（判定は S2 で済み） | 有り | 送信の記録・タスクの状態（`running`） | **無し**（I2・I6） |
| S4 失敗の記録 | S3 の失敗のときだけ、1 つのトランザクションで次を行う: タスクを `failed` にする、relay を取り消す、送っていなければ grant を戻す、送っていなければ note を閉じる、名簿の登録とロールの設定は残す（今の CLI の振る舞いと同じ。§8 Q5） | 無し | 失敗の記録 | — |

- S1 の所有の確認は、S2 の前に置く（今の `/send` は方針の判定を所有の確認の前に置く、`route.ts:294`）。この設計では方針の判定を S2 へ動かすが、S1 は何も書かないので、S1 の順番は I1 に効かない。S2 で方針を判定し直す
- S2 (a) の比べ方: 宛先は `instanceId` と `cliToolId` の組。relay の両端は `{worktreeId, instanceId, cliToolId}` の組。CLI が `expect.rosterRevision` を送っていれば、名簿の版も比べる
- S2 の中の書き込みの関数は、今の各 route の中身を、**同期の関数に切り出して**使う（例: `createTask`、名簿の追加の検査 `validateAgentInstanceAddition` と書き込み、`openRelay`（`relay-service.ts:204`、同期）、mem の `createMemItem`）。各 route は同じ関数を呼ぶ（I5）
- 環境の基準（`recordEnvBaseline`、`tasks/route.ts:237` は作成の後の await）は、S1 で採取し、S2 でタスクと同じトランザクションで書く。採取から書き込みまでの間の環境の変化は、今と同じく基準のずれとして扱う（見立て: 今も作成と採取の間に await がある）

### 4.3 割り込みの点（await）の一覧と、その意味

S1 と S3 の await のすべてに、試験の hook を置く（名前つきの点。§6）。

| 点 | 場所 | その間に変わりうるもの | 結果 |
|---|---|---|---|
| p1 | S1 の宛先の解決の後 | 名簿・既定 | S2 (a) で `operation_target_changed`。何も書かない |
| p2 | S1 の relay の両端の解決の後 | 返信先の名簿 | S2 (a) で同じ。または (b) で relay の拒否。何も書かない |
| p3 | S1 の契約の読み・環境の採取の後 | 名簿・既定 | 同上 |
| p4 | S1 の所有の確認の後 | 名簿・既定・返信先 | 同上 |
| p5 | S1 の mem の対象の解決の後 | mode・worktree の世代 | S2 の mem の書き込みが今の検査（`alive()`）で断る。トランザクション全体を戻す（何も書かない） |
| p6 | S3 の起動の後・打鍵の前 | 名簿の tool | S2 で書いた値で実行する（I2）。tool が変わってセッションが合わないときは起動・打鍵の失敗で、S4（I6） |
| p7 | S3 の打鍵の後 | 返信先 | 配送の段の方針（relay の pump）が扱う（§2 の範囲の外） |

- S2 は同期の区間なので、割り込みの点を持たない（I3）
- 割り込みの点の一覧は、実装の契約で**コードの await と一対一**に保つ。点の数を数える試験を置く（新しい await を足すと、名前の無い点が増えて落ちる。見立て: `sendOperationAwaitPoints` の一覧と、試験の hook の呼び出しの数を比べる）

### 4.4 確定の後の失敗（I6）

- 確定の後に方針の判定をし直さない。宛先・両端・起点は S2 の値を持ち回る
- 起動の失敗・所有の食い違い（S1 の後に別のサーバーがセッションを取った）・プロンプト待ち・入力欄が空でない（#4476）・セッションの消滅は、S4 の失敗の記録で終わる。CLI の exit は今の失敗の exit（`send` の既存の約束）のまま
- `after-send` の grant（`--model` の後回し）: 判定は S2 で済んでいるので、S3 で有効にするときに方針では断られない。K2（送った後に Auto-Yes だけが断られる）は起きなくなる。有効にできなかった（所有の食い違い等）ときは、今と同じく警告・exit 0（#4159）

### 4.5 既存の route との関係（I5）

| 案 | 中身 | 判断 |
|---|---|---|
| 新しい route（推奨） | `send-operation` を足し、`/send`・`/tasks`・`/instances/roles`・`/api/relays`・`/auto-yes` は残す。共通の段の関数を、新しい route と既存の route が呼ぶ | ○。画面・`ask`・`respond` は今のまま |
| `/send` を広げる | `/send` の本文に `contract`・`register`・`replyTo`・`autoYes`・`note` を足す | ×。`/send` は画面・`ask`（予約）・relay の配送でも使われ、本文の解釈を広げると今の約束（#4116 の「`/send` に宛先の欄なし」など）と混ざる |

- 既存の個々の書き込みの API の判定（#4449 の `findWriteToolPolicyRefusal`）は外さない。古い CLI と画面のための守りとして残す

### 4.6 古いサーバーと新しい CLI（I7）

- CLI は `GET /api/capabilities` の能力の一覧（`src/cli/utils/server-capabilities.ts`）で `send-operation-v1` を確かめる
- 無いとき（0.53.0 以前のサーバー）の扱いは 2 通り（§8 Q2）:
  - (a) 推奨: 書き込みのフラグ（`--contract`・`--register`・`--role`・`--reply-to`・`--auto-yes`・`--note`）を伴う送信は、**今の別々の要求の形で送り、stderr に「このサーバーでは方針で断られたときに行が残ることがあります。サーバーを同じ版に更新してください」と 1 行出す**
  - (b) 断る（exit 2）。古いサーバーで書き込みのフラグが使えなくなる
- (a) を推奨する理由:
  - 0.53.0 の CHANGELOG が既に「CLI とサーバーは同じ版にそろえる」と告知している
  - 古いサーバーでも、今の守り（#4449）は効く
- 書き込みのフラグを伴わない送信は、新しい route を使わない（今の `/send` のまま）。変化を最小にするため

---

## 5. CLI の変化

- `send.ts` の段 1〜8 の別々の要求と、CLI の取り消し（`failTask`・`withdrawAutoYes`・`cancelRelayQuietly`・`closeSendNote` の方針の拒否の分岐）は、新しい route の経路では使わない（古いサーバーの経路にだけ残す）
- 出力の約束:
  - 方針の拒否は exit 33。stderr の 1 行目は理由、stdout は空、`Task created` は出さない（K1 の「stderr の 1 行目が `Task created`」が無くなる）
  - 成功の stdout は今と同じ（`--contract` なら task の id）
  - `operation_target_changed` は「宛先が送信の途中で変わったので、何もせずに止めました。もう一度送ってください」。exit は §8 Q4
- `--register` の名簿の判定は、#4479（CLI の事前の GET をやめて書き込みの API の 1 要求に寄せる）と同じ方向にある。#4479 をこの route の S2 の名簿の書き込みに含めるかは §8 Q6

---

## 6. 試験の層と陰性対照

### 6.1 表の試験（結合、実サーバーの route を直に呼ぶ。偽の CLI ツールだけ。本物の agy は使わない）

軸:

| 軸 | 値 |
|---|---|
| 操作の組み合わせ | 単独の送信／`--contract`／`--register`／`--register --role`／`--role`（名簿にある instance）／`--contract --role`／それぞれに `--reply-to`・`--auto-yes`・`--model`・`--note` の有無。Issue の要求は「--reply-to・--note・--model を含む組み合わせ全部」 |
| 起点 | `terminal`・`session`・`agent`・`schedule`・`unknown`・`legacy`（本文に origin なし） |
| 申告 | なし・`api-key` |
| 拒否する段 | 宛先（tool-policy）・relay の両端（規則 0）・Auto-Yes・拒否なし |
| 割り込みの点 | なし・p1〜p7 のそれぞれで、名簿の tool／既定の宛先／返信先の名簿を、許す側から断る側へ（と、その逆へ）変える |

- 組み合わせの数は大きいので、**生成した表**（直積）から、同じ結果になる組を畳まずに全部を流す
  - Issue の不変条件「組み合わせ全部」に従う
  - 実行時間が問題になるときは、PM の判断で軸を畳む（畳んだ理由を表の頭に書く）
- 各行で確かめること（観測した値で。「何も起きない」を推測しない）:
  - DB: タスク・名簿・ロールの設定・relay・mem の項目の行の数が、行の前後で同じ（拒否）か期待どおり（許可）
  - grant: `peekAutoYesState` の状態
  - プロセス: 偽のツールの起動の記録（呼ばれた回数）
  - 打鍵: 偽の tmux への送信の記録
  - 応答: HTTP の status・`code`・`policy.stage`・`policy.operation`・送った `origin` の写し
  - CLI を通す行（§6.2）では、exit・stderr の 1 行目・stdout
- 割り込みの行の期待:
  - p1〜p5 は「何も書かない」（拒否か `operation_target_changed`）
  - p6 は「S2 の値で実行、合わなければ S4」
  - p7 は「relay の pump が配送の時に取り消す（送信は済み）」

### 6.2 CLI を通す表（結合、偽のサーバーの中継ではなく実サーバー）

- §6.1 の表から、CLI の組み立て（フラグ → 本文）を確かめる行を選ぶ。起点ごとに 1 行以上、操作の組み合わせごとに 1 行以上
- CLI の起点の判定（`resolveSendOrigin`、`src/cli/utils/send-origin.ts`）の入力（TTY・環境変数）を作る（`repro-4449-codex.md` の方法）

### 6.3 変異（陰性対照）。codex レビュー 3 の P2 への答え

段ごと・入口ごとに 1 つずつ外し、それぞれが表の**特定の行**を赤にすることを確かめる。

| 変異 | 赤になるべき行 |
|---|---|
| S2 (a) の宛先の比較を外す | p1〜p4 で既定・名簿を断る側へ変える行（行が残る） |
| S2 (b) の宛先の方針の判定を外す | 起点 `agent` × antigravity 宛ての全行 |
| S2 (b) の relay の判定を外す | 返信先が antigravity の行 |
| S2 (b) の Auto-Yes の判定を外す | 端末 × `--auto-yes` × antigravity の行（K のもとになった P1-1） |
| S2 の書き込みを、判定より前へ動かす | 拒否の全行（行が残る） |
| S2 の中に await を 1 つ入れる | 点の数の試験（§4.3）と、その点で割り込む行 |
| S3 で方針を判定し直す（I2 に反する） | p6 の行（S4 ではなく 409 になる） |
| 古い CLI の経路を新しい route と取り違える（能力の確認を外す） | 古いサーバーの行（§4.6） |

- **陽性対照**: 今の別々の要求の形（0.53.0 の CLI）で同じ表を流すと、K1・K2 の行が赤になること。表が穴を見つけられることを示す。実装の PR の最初のコミットで、新しい route の前に置く

### 6.4 単体

- S2 の同期の関数（判定と書き込み）の表。DB の行の数で確かめる
- 失敗の記録（S4）の 1 トランザクションの表

---

## 7. PR の分け方（Sprint 9）

| PR | 中身 | 書くファイル（見込み） | 陽性対照 |
|---|---|---|---|
| PR0 表の器 | §6.1 の表の器と割り込みの hook、今の形（0.53.0 の CLI・route）で K1・K2 の行が赤になることを示すコミット（赤の行は `it.fails` で記録し、PR1 で緑へ） | `tests/integration/send-operation-table-4466.test.ts`（新）、試験の helper | K1・K2 の行が今の形で赤 |
| PR1 サーバー | 各 route の書き込みを同期の関数に切り出す（振る舞いは変えない）。新しい route `send-operation`（S0〜S4）と能力 `send-operation-v1` | `src/app/api/worktrees/[id]/send-operation/route.ts`（新）、`send/*.ts`、`tasks/route.ts`、`instances/roles/route.ts`、`src/lib/relay/relay-service.ts`、`auto-yes/route.ts`（共通の関数）、`src/config/server-capabilities.ts`、試験 | §6.1 の表がサーバーの行で緑、§6.3 の変異で赤 |
| PR2 CLI | `send` を新しい route へ（書き込みのフラグを伴うとき）。古いサーバーの経路（§4.6）。docs（cli-operations-guide の日英の既知の制限を消す、K1・K2）| `src/cli/commands/send.ts`、`src/cli/utils/server-capabilities.ts`、docs、`changelog.d` | §6.2 の CLI の表 |
| PR3（任意） | `operationKey` の冪等（§8 Q3 の答えによる）。追加の migration | migration（番号は PM）、route | 同じ key の再送で行が 1 つ |

- PR1 の「切り出し」は、既存の試験が変わらず通ることを条件にする（振る舞いを変えない）
- 高リスク（DB・公開の API/CLI・安全の不変条件）なので、レビューは系統を分けて 2 本。重要な指摘は再現する
- 直列: #4473（`send.ts`・`send-request.ts`）→ #4420（`relay-service.ts`）→ この PR 群。#4479（名簿の登録）と同じファイル（`send.ts`・名簿の書き込み）を書くので、#4479 を先にするか、この PR1 に含めるかを PM が決める（§8 Q6）

---

## 8. 人・PM に伺う点

| # | 問い | 推奨 |
|---|---|---|
| Q1 | 1 要求の API（案 A）にするか、取り消しの確定点（案 B）にするか | **案 A** |
| Q2 | 新しい CLI と古いサーバーの組み合わせ（§4.6）: 今の形で送り、注意を 1 行出す（a）か、書き込みのフラグを断る（b）か | (a) |
| Q3 | 再送の冪等（`operationKey`、追加の表と migration）を入れるか。入れないと、応答が届かずに打ち直したとき、タスクが 2 つできうる（今も同じ） | Sprint 9 では入れない（PR3 として後で） |
| Q4 | `operation_target_changed`（送信の途中で宛先が変わった。何もしていない）の exit。33 は「送り直しても同じ結果」と docs に書いてある（`cli-operations-guide.md:349`）ので使わない。候補: 既存の名簿の競合（`ROSTER_CHANGED`、`src/cli/utils/agent-instances.ts:113`）と同じ扱いにするか、新しい番号（公開の契約の変更で人の了承）か | 新しい番号は足さず、名簿の競合と同じ exit に合わせる（その exit は実装の契約で「全終了コード一覧」から確かめる。未確認） |
| Q5 | 確定の後の失敗（S4）で、名簿の登録とロールの設定を残すか（今の CLI はタスクを `failed` にするだけで、登録とロールは残す） | 残す（今と同じ。方針の拒否ではないため） |
| Q6 | #4479（`--register` の名簿の判定をサーバーの 1 要求へ）を、この route の S2 に含めるか、先に別に直すか | 含める（同じ確定の区間に名簿の書き込みがあるので、重ねて直さない） |
| Q7 | 表の大きさ（直積の全部）で CI の時間が問題になるとき、畳んでよい軸 | 申告（`api-key`）の軸は「全許可」の 1 行に畳んでよい（codex レビュー 3 の「表の省略」の議論と同じ） |

---

## 9. 未確認・レビューで見てほしい点

1. `/send` の S3 の部分（起動・打鍵・relay の予約・ask の予約）を、宛先を持ち回る形で、新しい route から呼べるか。`/send` の route の処理は 585 行で、`handleSend`（`send/route.ts:111`）の切り出しの境目は実装で確かめる
2. `contract.content` を CLI から送る今の形（`POST /tasks` の本文）と、サーバーでの契約の検証の位置
3. mem の note の書き込み（`createMemItem`）が、S2 のトランザクションの中で呼べる同期の関数か（mem の service は準備（async）と書き込み（sync）に分かれている、`src/lib/mem/service.ts:578-579` の `prepared`。見立て）
4. メモリの grant（`setAutoYesEnabled`）とポーラーの開始を、トランザクションの直後に await なしで行えるか。トランザクションが失敗したときに grant を有効にしない順にする
5. 表の直積の行の数と、実行の時間（PR0 で数える）
6. relay の連鎖（#4420 の `RELAY_CHAIN_BLOCKED`）の判定が S2 の relay の書き込みに入るので、#4420 の直しの後の形に合わせる
