# #4518 `send --instance-id <id>` — 設計 v3（不変条件と赤の試験）

- 段: 段 1（不変条件の表と、赤の試験を先に）。`src` は変えていない。実装は段 2
- 基準: develop `192f9dca1`。行番号はこの版のもの
- 経緯: v1・v2（`workspace/orchestration/runs/2026-11-21/s9/design-4518{,-v2}.md`）は指摘への文の足し算で閉じなかった（A2・A4 が 2 回、N1・N2 が新規）。PM の裁定で、v3 は不変条件と、今のコードで赤になる試験の一覧で書く
- 公開の契約（人の了承 11-21、Issue #4518 のコメント）: 名簿の行と完全一致だけ・fallback なし・無ければ exit 2 未送信／Q2 #4518 より前のサーバーへは端末からも送らない（exit 2）／Q3 不一致はすべて exit 2／既存の `--instance` は変えない
- 試験: 単体 `tests/unit/cli/commands/send-instance-id-4518.test.ts`、結合 `tests/integration/send-instance-id-4518.test.ts`（実 route・メモリ DB・偽のツールと偽の agy、本物の tmux・agy は使わない）。緑＝今の欠陥や今の状態の機械を固定、`it.fails`（印 `// #4518 stage2`）＝段 2 で外す

---

## 1. 経路の比較と選択

| | A: 新しい route（`/send-exact`・`/api/relays/exact`、v2） | **B: 既存の `/send`・`POST /api/relays` に完全一致の条件を足す（採る）** |
|---|---|---|
| 完全一致の渡し方 | route が exact を強制 | `instanceId`（relay は `to.instanceId`）を**オブジェクト** `{ id, exact: true, cliToolId }` にする。上位の `cliToolId` は期待の tool のまま |
| Q2 古いサーバー | 404（パスが無い） | **#4518 より前のサーバーは文字列でない `instanceId` を検証の段で 400 にする**（`send-request.ts:259`、`relays/route.ts:75`）。予約・試行の記録・起動の前なので何も残らない。今の handler で緑の試験が固定（下の I11） |
| 起点の付与（N1） | `send-origin.ts:189` は `isSendFamilyRoute` だけを付与する。新しいパスは付与されない（単体の緑の試験）。正規表現を 2 か所直す必要 | パスが `/send` のままなので**今の付与と exit 33 の変換がそのまま効く**（単体の緑の試験） |
| 方針の変換（exit 33） | `tool-policy-failure.ts:63` に新パスを足す必要 | 不要 |
| 入力の境界・relay の予約・状態の機械 | handler の共有の形（`check-route-exports.mjs` の制限）を別に決める | 今の `handleSend` の中。新しい関数の差し込み口は `validateSendRequest` の解決と、送信サービスの境界 |
| 弱点 | 起点・方針・入力の境界の写しが 2 本になる（N1 の型の穴） | オブジェクトの `instanceId` を検証の後に生の値で読む箇所があると壊れる（段 2 で `validateSendRequest` が正規化し、以降は生の `body.instanceId` を読まない。`readRoleRosterMark`・`planAskForSend` を確かめる）。`#868` より前のサーバーは `instanceId` を読まない（その版は `resolve-session-target` 能力を持たないので CLI の能力の確認で先に断る。段 2 で確かめる） |

選択: **B**。理由は N1・A2 の穴が「写しの経路」から出ていたこと（v2 のレビュー）。B は起点・方針・入力の境界・relay の予約を今の 1 本の経路で共有し、Q2 は今のサーバーの実際の 400 で満たす。

---

## 2. 意味

```
commandmate send <worktree-id> "<本文>" --instance-id <id> [--agent <tool>] [--reply-to …] [--note …] …
```

- 一致の対象: その worktree の名簿の行で `id === <id>` のもの**だけ**。別名・主インスタンス（#868、行の無い tool 名の id）・ad-hoc・worktree の既定・既定の claude へ落とさない
- 期待の tool: `--agent` があればそれ、無ければ CLI が読んだ行の tool。サーバーは名簿の行の tool と照合する
- worktree ID: 引数が今の ID であること（旧 ID は exit 2、今の ID を示す）
- 同じ宛先: (worktree, id, tool) の組が同じこと。同じ組で消して作り直したものは同じ宛先（v2 §3.3 の決定を保つ。名簿の行には #4221 の incarnation がある（`agent-instances-db.ts:297`）ので、作り直しを別の宛先とする案はレビューで決めてよい。試験 `I1 (design §2, v2 §3.3 kept)` がこの決定を固定する）
- 併用: `--instance` と同時は exit 2。`--note` は併用してよい（#4418 の pm-send が使う。B では note の経路は今と同じ順序で、未送信の証明があるときだけ閉じる。閉じられない形は見つからなかったので WAIT にしない）
- 不一致・古いサーバー: exit 2・未送信。応答を解釈できないときは「不明」（I9）

---

## 3. 不変条件

「破れる場所」は今のコードで `--instance` が同じ手順で誤った宛先へ送る、または型・状態を失う箇所。試験名は先頭の識別子（`describe` の中の `it` の名の頭）。

| # | 意味 | 今のコードのどこで破れるか | 赤にする試験（結合 = I / 単体 = U）と今の結果 |
|---|---|---|---|
| **I1** | 判定した ID と打つ ID は同じ。別名を追わない | `--instance` は selector: CLI が `resolve-target` で別名を解く（`send.ts:1205` → `resolve-target/route.ts:144-171`、別名は `:164`） | I `I1 / Sprint 6・8 P2-1 … types into codex-2`（緑）／I `I1 / Sprint 6・8 P2-1 … the alias is not followed`（it.fails）／I `I1 positive`（it.fails）／I `I1 control`（緑） |
| **I2** | fallback なし（worktree-default・行の無い主インスタンス・既定の claude を受けない） | 行が消えても `resolveSessionTargetStrict`（`send-request.ts:291`）が `worktree-default`（`resolve-session-target.ts:217`）で同じ ID を返し、CLI が tool を付ければ `explicit` になる | I `I2 / Sprint 8 r2 P2-1・P2-2`（緑）・I `I2 / codex repro (S8 r2 P2-2)`（緑、`../commandmate-review-4518/dev-reports/repro-4518-codex.test.ts` を写した）／I `I2 / Sprint 8 r2: … before its first write`・`I2: no row at all`・`I2: a tool-named id`（it.fails） |
| **I3** | 今の worktree ID だけ（旧 ID は exit 2） | route が旧 ID を黙って今の ID に替える（`send/route.ts:231` → `git-route-worktree.ts:62-71`） | I `I3 / Sprint 6 … followed to the current worktree`（緑）／I `I3 / Sprint 6: an old worktree id — exit 2`（it.fails） |
| **I4** | 打つ tool は期待の tool（名簿の行の tool と一致） | 同じ ID が別の tool で登録し直されると、CLI がその tool を読み直して打つ（`send.ts:1205`） | I `I4 / T5 … types into codex`（緑）／I `I4 / T5: judged as claude (--agent claude)`（it.fails） |
| **I5** | 起動の途中・打鍵の前の変化でも止まる（確かめは最初の端末の変更の直前まで） | 確かめは解決の 1 回だけ。起動（`send/route.ts:435`）の後に照合が無い | I `I5: the row goes while the session starts … the body is typed`（緑）／I `I5 … exit 2`（it.fails） |
| **I6**（A2） | 打鍵 0 の範囲は本文だけでなく、入力欄の消去・copilot の `/model` を含む端末への全ての変更 | 境界の `beforeInput` は本文の `noteInputStart`（`submit-verified-sender.ts:800`）でだけ走る。消去は前（`:758`）、`/model` は `observeInputStart` の外（`send-user-message.ts:533`） | I `A2: copilot --model — /model goes out before any boundary hook`（緑）・I `A2: a beforeInput refusal … comes after the composer clear`（緑）／I `A2: the row goes right before the first terminal change`・`A2: copilot --model, the row re-registered`（it.fails） |
| **I7**（A2） | 再確認の拒否の型は送信結果まで保つ（予約の喪失と区別し、409 の code を保つ） | `runBoundaryHook`（`instance-input-lock.ts:958-963`）が `InputBoundaryRefusedError` に包み、型と `cause` を落とす。送信サービスは包まれたものを全部 `relay-reservation-lost` にする（`send-user-message.ts:683`） | U `A2: … wraps whatever beforeInput throws`（緑）／U `A2 stage 2 … keeps its type`（it.fails） |
| **I8**（N1） | 起点の付与と exit 33 の変換は、新しい指定を含む全ての変更系の入口で効く。agent・session・schedule・unknown の起点から antigravity へ打たない・relay を作らない | パスで選ぶ（`send-origin.ts:189`、`tool-policy-failure.ts:41,63`）。新しいパスは外れる（A の弱点） | U `N1: … keyed on the path`（緑 3 本）・I `N1 control (unchanged)` 2 本（緑）／U `N1 stage 2` 2 本・I `N1:` 3 本（it.fails。端末からの relay も規則 0 で断る） |
| **I9**（N2） | 「未送信」と言えるのはサーバーの実行前の拒否の証明（JSON の code と `sendOutcome`、または #4518 より前のサーバーの検証の 400 の本文）だけ。応答の破損・切断・素の 4xx の頁は「不明」で、再送・relay の取り下げ・note の close をしない | 素の 4xx を not_sent と読む（`message-dispatch.ts:136`、`send.ts:636`）。`--instance` では今のまま（変えない） | U `N2: today a bare 4xx page is read as "not sent"`（緑）・U `(control) a non-JSON 200 …`（緑）・I `N2 control` 2 本（緑）／U `N2 stage 2` 2 本・I `N2: delivered, the answer lost …`（it.fails） |
| **I10**（A4） | relay の終端と waiting の閉じ方は今の状態の機械のまま（§4 の表）。新しい終端・新しい system line を作らない | — （今の機械を固定する。v2 は「サーバーが not_sent で閉じる」と書いたが、今の `binding.finish` は `send_state=failed` だけで `state` は `pending`（`relay-bind.ts:348`）） | I `#4518 A4:` 5 本（緑）／I `I2 / A4: the row goes between the relay and the send`（it.fails） |
| **I11**（Q2） | #4518 より前のサーバーへは打たない（端末からも）。能力の確認の後に入れ替わっても | 今の `/send` は知らない欄を無視する（`send-request.ts:195`）ので、欄を足すだけでは古いサーバーが打つ。B は文字列でない `instanceId` が今のサーバーで 400 になることに頼る（`send-request.ts:259`、`relays/route.ts:75`） | I `#4518 the pre-#4518 server … refuses a non-string instance id` 3 本（緑、前提の固定）／I `Q2:` 3 本（it.fails。`asPre4518` の模型＝192f9dca1 の route 表・本文の欄・その 400） |
| **I12** | 既存の `--instance` の振る舞いは変えない | — | 上の緑の試験すべて（段 2 でも緑のまま）と既存の試験 |
| **I13** | claude-3 の予約の排他を弱めない | — （予約は `scripts/agent-health/claude3-reserve-main.ts:362` が `sendArgv`（`agent-health/dispatch.ts:220`、`--instance claude-3`）で子を起動する。段 2 は触らない） | I4 の it.fails（期待の tool `claude` と違う行へは打たない）。予約の分岐の試験は PR3（`feature/4418-pm-send-relay` の上、v2 §9 の T13） |

---

## 4. relay の終端と waiting の閉じ方（I10、今の機械）

`--reply-to` の順は relay → mem の note（`--note`）→ `/send`（`send.ts` の `registerRelay` → `writeSendNote` → `postMessage`）。mem の `waiting` は `closeWhen: relay:<id>` で、relay の `state` が終端のときだけ閉じる（`condition-evaluators.ts:74-83`）。

| 段 | relay の行 | `send_state` | 閉じる主体 | CLI が落ちたとき | 試験 |
|---|---|---|---|---|---|
| (a) relay の作成の前に断る（CLI の早い断り・規則 0・exact の 409・古いサーバーの 400） | 無い | — | — | 何も残らない | I `refused before creation`（緑） |
| (b1) note を mem が断る | `pending` | null | CLI が取り下げ → `cancelled` | `pending` のまま期限（既定 24h）で `expired` | `send-note-4226.test.ts`（既存） |
| (b2) `/send` が予約の前に断る（検証の 400・exact の 1 回目の 409） | `pending` | null | CLI（4xx → `not_sent` → `…/cancel`）→ `cancelled`、note は `send_not_sent` で close | `pending`・note は開いたまま期限まで | I `I2 / A4: … between the relay and the send`（it.fails、`send_state` は null か failed） |
| (b3) 予約の後・打鍵の前に断る（foreign・起動失敗・境界の拒否・exact の再確認） | `pending`（サーバーは `state` を変えない） | `failed`（`relay-bind.ts:348`） | CLI が取り下げ → `cancelled`、waiting は met(failure) | `pending`・waiting は not-met（relay-open） | I `refused after the reservation …`・`the CLI then withdraws it`・`the CLI path end to end`（緑） |
| (b4) 予約の後に方針が断る | サーバーが `withdrawRelay`（`send/route.ts:141` → `relay-service.ts:418`）→ `cancelled` | `failed` | サーバー。取り下げの system line は書かれない | 同左 | I `withdrawn by the server …`（緑） |
| (c) 届いた後に応答が壊れる | `pending` | `sent` | CLI は `GET /api/relays/:id` で sent と読めば成功扱い。読めなければ不明で何もしない | 同左 | I `N2 control` 2 本（緑）・I `N2: delivered …`（it.fails） |

段 2 の exact の拒否は (a)・(b2)・(b3) のどれかに入り、新しい終端・新しい system line を足さない。

---

## 5. 段 2 への引き継ぎ（実装の形。レビューで変わりうる）

- サーバー: `validateSendRequest` がオブジェクトの `instanceId` を読んで正規化し、`requestedWorktreeId`（`canonicalWorktreeId` の前の文字列）が今の ID であること、名簿の行が在り tool が `cliToolId` であることを同期で確かめる（`resolvedBy` が `roster` 以外は拒否）。拒否は 409 `EXACT_TARGET_MISMATCH`。`POST /api/relays` の `readEndpoint`・`openRelay` も同じ関数で
- 再確認: 起動の後、入力欄の消去・`/model` を含む最初の端末の変更の直前に同じ関数を呼ぶ口（今は無い。結合の偽のツールはその口を本物の送信器と同じ位置で呼ぶように直す）。拒否の型は `runBoundaryHook` で `cause` に保ち、送信サービスは `relay-reservation-lost` と区別する
- CLI: `--instance-id`、名簿の読み（`resolve-target` は呼ばない）、`instanceId`・`to.instanceId` をオブジェクトで、409 `EXACT_TARGET_MISMATCH` と #4518 より前のサーバーの 400 を exit 2。解釈できない応答は I9 のとおり。`send.ts` は #4128 で分割中なので、段 2 の前に develop を取り込む
- 段 2 で外すもの: `// #4518 stage2` の `it.fails` の `.fails`、単体の `(control) today --instance-id is an unknown option`。I11 の前提の緑の 3 本は今の handler（＝#4518 より前のサーバー）を固定しているので、段 2 で `asPre4518` の模型への試験に置き換える（模型の 400 の本文はこの 3 本が固定した文字列）

---

## 6. 残る不確かさ

- #868 より前のサーバー（`instanceId` を読まない）が能力の確認で必ず先に断られるか。段 2 で `resolve-session-target` 能力の導入版と照合する
- 偽のツールは本物の送信器の順序（消去 → `noteInputStart` → 本文）を写している。I6 の段 2 の実装には、本物の `submit-verified-sender`・copilot の `sendModelCommand` の上での単体の試験も要る
- 別の対応済みサーバーへの入れ替わり（同じ URL）は閉じない（v2 §10 のまま。接続先の固定は呼び手）
