# 設計: #4503 agy 送信器の読み戻し（第 3 版の写し）

> **状態: Sprint 10 へ持ち越し（#4535 で送信器全体として決め直す）。** PR-B2（画面の unknown）は Sprint 9 で別に入る。この設計の §2 の入力枠の読み方（R1〜R6）と実フレームは資産、読み戻しの判定（提出の帰属）は未解決。
>
> レビュー（いずれも workspace の中にあり git に入らない）: `review-4503-claude5.md`（第 1 版）・`review-4503-codex.md`（第 1 版）・`review-4503-v2-claude5.md`（第 2 版）・`review-4503-v3-codex.md`（第 3 版）・`review-4503-v3-claude5.md`（第 3 版、P1 1・P2 5・P3 7。P1: 入力枠の包みの意味が未定で、文のとおりだと文字入りの枠 6 枚でゲート・状態が ready になり typed-spoof も閉じない。P2: submitted-0s でゲートが開き遅れた前の試行の echo・esc を証拠と読む／echo を 12 行の窓で数えると偽の増加／paste 経路に規則なし／赤・緑の分類の誤り（N-4・N-6 は今も緑、P-2 は赤）／規則 1 の Enter の再送の前に証拠 (i) を見ない。D11 は採らない＋記録の条件。処分は Sprint 10）。
> - v3 の codex P1-2: 位置が正しい echo・フッターでも、今回の提出に帰属できない。先頭一致では ` and no other words` を足した別の文も一致し、前回の `esc to cancel` も成功の根拠になる。これが未解決の中心
> - v3 の codex P2-1: ロックの中で readiness を必須にしないと、空欄でも生成中の画面に打てる
> - v3 の codex P1-1: 空欄が `pending`、案内文が無関係な文字になり、提出済みの画面を見失う（判定の順の問題）
> - v3 の codex P1-3: 本物の案内文と、その文字列を打った本文の扱いが衝突する
> - v3 の codex P2-2: 長文の paste 経路に、Enter 前の echo 基準と読み戻しの扱いが定義されていない
> - 実フレーム 14 枚は `tests/fixtures/antigravity-live-4503/`（下の本文の `workspace/temp/agy-frames-4503/` はそこに取り込み済み）

---

# 設計: #4503 agy への送信が見かけ上失敗して裏で届き、再試行で 2〜3 重に送られる（第 3 版）

- 段: 設計 1 枚。読むだけで作った（コード・試験・agy には触れていない。agy は --version も実行していない）
- 基準:
  - develop = origin/develop `192f9dca1`（v0.54.0）。§1・§3・§4 の行番号はこの版のもの
  - §2 の枠の読み手は、#4504 のブランチ `fix/4504-agy-generating-word`（PR #4542、マージ待ち）の `src/lib/detection/tools/antigravity/patterns.ts` `readAntigravityInputBoxStatusRow` を土台にする。develop では `antigravity.ts:196-235` `readInputBoxStatusRow`
- 区分:
  - **確定**: コードで経路を確かめた。または実フレームで確かめた
  - **推定**: 経路は確かだが、agy 側の挙動が未計測。時間・Enter が早すぎたときの扱い・枠の高さの上限など
- 材料:
  - Issue: #4503・#4466・#4417・#4504・#4495
  - レビュー（第 1 版へ）: `laneB/review-4503-claude5.md`（R5）・`review-4503-codex.md`（RC）
  - レビュー（第 2 版へ）: `laneB/review-4503-v2-claude5.md`（R5v2）
  - リーダー・PM: `lead-wait-4503-design.md`・`lead-stop-4503-pr-b1.md`・`s9/pm-reply-4503-frames.md`
  - **実フレーム 14 枚**: `workspace/temp/agy-frames-4503/`。agy 1.5.13（Gemini 4 Neon）、`tmux capture-pane -p -e -S - -E -`、200x1000、伏せ済み
  - 人の観察: `laneB/human-agy-frames-notes.md`

## 版

- 第 3 版（2026-11-21）: §2（PR-B1）を実フレーム 14 枚に基づいて書き直した。§5・§6・§9 も書き直し、§3.1・§4 は小さく直した。R5v2 の指摘を処分した
- 第 2 版: レビュー 2 本（R5・RC）の P1・P2 を反映した。案 X の鍵の直し、PR の順、PR-B2 の unknown の範囲
- 第 1 版: 結論は案 X を推奨

### 第 3 版の変更点

1. **枠の特定を 1 つの関数にまとめた**（§2.0）: `readAntigravityInputBoxStatusRow` を広げた `readAntigravityInputBox` にする。枠の中の全行・ステータス行・「空か」を返す
   - 送信のゲート・ロールの判定・状態の検出・送信器の 4 か所が、同じ読み方をする
   - 罫線は「1 桁目から始まり、上下が同じ長さで、61 字以上」とする。履歴の 60 字の罫線とはここで区別する
   - 枠の中の 2 行目以降は、2 字下げか空行だけを認める。本文の罫線と `>` は 2 字下げで描かれる（実フレームで確かめた）ので、枠の偽装はできない
   - 3 行の高さの枠・生成中の枠・案内文の枠を、実フレームと既存の fixture で確かめた
2. **案内文（モードのバナー）は「空」とする**（§2.0 R5）。agy 1.5.13 では既定の auto のモードでも案内文が出る（`idle-empty.txt:15`）。第 2 版のままだと、**すべての送信が断られていた**
3. **読み戻しで規則 A（生成中の語）を agy では使わない**（§2.2）。送信済みの証拠は、本文では偽れない 2 つだけにする
   - (i) 履歴の echo（60 字の罫線の直下の、1 桁目の `> 本文`）が、Enter の前より増えた
   - (ii) 枠が空で、ステータス行が `esc to cancel`
   
   「本文を見た後に空」だけでは送信済みにしない（R5v2 P2-3）
4. **本文の照合**（§2.1）: 枠の全行と本文全体の一致。C-j（LF）は agy で改行であり、提出にはならないことを人が確かめた
5. **§6 を作り直した**: 14 枚を `tests/fixtures/antigravity-live-4503/` に取り込む前提で、各 fixture の期待の表を作った。表の中身は、枠の特定の結果と、読み戻しの判定
6. 推定のまま残るもの（§9）:
   - Enter が早すぎたときの agy の扱い（`enter-too-early` は採っていない）
   - 全文が描かれるまでの時間
   - 枠の高さの上限
   - `submitted-0s` の位置づけ: 中身からは「Enter の直後、echo の前」と読める（下の §2.6）

### 第 2 版の再レビュー（R5v2）の処分

| 指摘 | 中身 | 処分 | 反映先 |
|---|---|---|---|
| P1-1 | モードのバナーを文字と読み、全送信を断る | 採用。バナーは空とする。1.5.13 では auto のバナーも既定で出ることを `idle-empty.txt:15` で確かめた。本文がバナーと同じ文字のときの扱いも決めた | §2.0 R5、§2.4、§6 F1・F3・F4 |
| P1-2 | 3 行の枠・生成中の枠・既存の `readInputBoxStatusRow` を見落とした | 採用。既存の関数を広げた 1 つの関数にする。3 行（2478 `after-tool-turn.txt:27-31`）・生成中（`submitted-1s.txt:27-30`、`ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13`）を陽性の入力にする | §2.0、§6 F10・F11・L1〜L3 |
| P2-1 | 本文の罫線と `>` で枠を偽装できる。提出の途中の画面 | 採用。罫線は 1 桁目・同じ長さ・61 字以上、続きの行は 2 字下げ。本文の罫線は 2 字下げの 60 字で描かれる（`typed-spoof.txt:16-17`）。途中の画面は推定の形として試験に入れる | §2.0 R2〜R4、§6 F9・S1 |
| P2-2 | 文字を入れた枠の fixture が無い | 採用。実フレームで閉じた。1 行・日本語・2 行・折り返し・バナーのモード・語・偽装・ツールのターンの後の 8 形がある。LF は改行（人の観察）。残りの推定（時間・高さの上限・Enter が早すぎたとき）は §9 | §2.1、§6 |
| P2-3 | 守りが枠の特定だけ。「本文を見た後」は常に成り立つ | 採用。空の枠を送信済みにするには、証拠 (i) か (ii) を要るようにした。枠の特定は単体の陽性・陰性の表で独立に試す | §2.2、§5 N1、§6 |
| P3-1 | §3.1 の判定の順 | 採用。`sendOutcome` があればそれで決め、無いときだけステータスで決める | §3.1 |
| P3-2 | 知らない欄は断られない。冪等が効いているかを画面が知れない | 採用。応答に `clientSendId` を返す | §4.1 |
| P3-3 | agy の規則は `classifySubmitWithRule` の中に入れる | 採用 | §2.2 |
| P3-4 | 提出の直後の許可のダイアログで unknown になる | 既知の制限として書く。枠が消えていても (i) があれば送信済みにする案は、PM の裁定（入力枠を特定できなければ unknown）に反するので採らない。PM の判断の項（D11）に残す | §2.2、§9、§8 D11、§6 F2 |
| P3-5 | `>` を外すのは 1 行目だけ | 採用 | §2.0 R5 |
| 範囲外 D | `trim()` の照合で、送信のゲートも偽装を ready と読む | 採用。1 つの関数にしたので、ゲートも同じ規則になる | §2.0 |

---

## 0. 結論（先に）

- 原因は 4 層ある。
  - (1) 送信器の読み戻しが agy で 2 方向に誤る。
    - 1a: 本文の描画を待たず、約 1 秒で「未確定」を投げる（主因。agy の速さは推定）
    - 1b: 生成中の語や裸の `>` だけで「送信済み」と読む（確定・再現済み）
  - (2) 失敗は indeterminate（500・`sendOutcome:'unknown'`）として正しく返る
  - (3) 画面は unknown も時計切れも一律「送信に失敗しました」＋［再試行］にする
  - (4) `/send` に重複を断る仕組みが無い
- PR は 3 本。
  - **PR-B2 画面の束（#4503 の画面＋#4417）**: 先に出してよい
  - **PR-B1 サーバー（agy の読み戻しを、実フレームで確かめた入力枠と、本文では偽れない証拠で読む）**: #4504（#4542）のマージの後に develop から切る
  - **PR-B3 送信 ID**: 案 X のとき。PR-B1 と #4466 PR1a・#4498 の後
- 送信 ID は **案 X を推奨する**（鍵は `(worktreeId, clientSendId)`、メモリに保存、migration なし）。
  - #4466 PR3 の `operationKey` は CLI の `send-operation` だけが対象で、画面の `/send` は対象外（`send-atomic-4466.md:102`・§4.5）
  - RC の再現: 同じ ID なら、飛行中でも unknown の記録の後でも提出は 1 件。案 Y のモデルでは 3 本目まで提出された
- 案 X は「誤った成功」も記録して再掲する（RC）。だから **PR-B1 を必ず PR-B3 より先に入れる**。

---

## 1. 事象と原因

経路は次のとおり。
1. 画面 `MessageInput.submitMessage`
2. 楽観経路 `onOptimisticSend`（`MessageInput.tsx:733-746`）
3. `usePendingMessages.dispatchSend`（`usePendingMessages.ts:455-523`）
4. `POST /api/worktrees/:id/send`（`route.ts:104`）
5. `sendUserMessage`（`route.ts:489`）
6. `deliver()`（`send-user-message.ts:648-697`）
7. `AntigravityTool.sendMessage`（`antigravity.ts:792-832`）: `requireSession` → `openRoleGate` → `waitForPrompt` → `sendMessageWithSubmitVerification`

### 層 1a 送信器: agy の短い本文の描画を待たずに「未確定」を投げる【経路は確定（RC 再現）／agy の取り込みの遅さは推定】

| 段 | 事実（行） |
|---|---|
| 512 B 以下は打鍵 | `submit-verified-sender.ts:764`（超えると paste）。打鍵は `:802`。`LITERAL_SEND_MAX_BYTES=512`（`-shared.ts:28`） |
| Enter の前の描画待ちは呼び手の旗しだい | `:816-818` `shouldAwaitTypedBody` → `report.ts:203-205`（旗かつ `SUPPORTED_COMPOSER_TOOLS`）。`SUPPORTED_COMPOSER_TOOLS = {claude, codex}`（`src/lib/detection/composer-text.ts:590`）。旗を立てるのは `codex.ts:1043` だけ。agy は旗を渡さず（`antigravity.ts:820-826`、既定 false `submit-verified-sender.ts:730`）、100 ms の床だけ |
| 描画待ちの読み手が agy を読めない | `confirmTypedBodyLanded`（`:535-584`）は codex なら全体照合、それ以外は `extractComposerText`。agy では `unsupported_tool`（`composer-text.ts:629`） |
| Enter と読み戻し | Enter `:826-834`、読み戻し `:844-934`。200 ms × 最大 5 回で、うち 4 回は Enter を再送（`:926-933`） |
| 判定 | agy は `input-line-marker`（`composer-spec.ts:71`、`clearBeforeSend:false`）。窓の中で一番下の `>` 行 1 行だけを読む（`submit-composer-read.ts:180-186`・`findInputLine :261-269`）。取り込み途中は規則 D `pending`（`:670`） |
| 投げる | `:936-940` `… (typed but unsent)` |

RC の再現（偽の画面。1,400 ms で提出）:
- 本文は 1 回、Enter は 100〜900 ms に 5 回。約 1,100 ms で `indeterminate / submit-unconfirmed` になり、その時点の提出は 0 件
- 後で 1 件届く。同じ送信を 2 回やり直すと提出は計 3 件

### 層 1b 送信器: Enter が効いていなくても「送信済み」と読む【確定。RC が develop と #4504 の後（659ffedcc）の両方で再現】

- 規則 A が入力欄より先にある（`submit-composer-read.ts:642`）。agy の A は `ANTIGRAVITY_THINKING_PATTERN = /[⠀-⣿]|Generating|esc to cancel/`（`detection/tools/antigravity/patterns.ts:71`）で、窓の文字列全体（`windowStr :636`）から探す。次の 3 つの形で、本文が `>` 行に残ったまま 1 回目の読みで `submitted / A` になった。
  - 本文に `Generating` を含む
  - 本文に点字の文字を含む
  - 前のターンの見出し「Generating …」が窓に残る
- 入力枠の位置を確かめない: Enter の後に入力欄が隠れ、履歴に裸の `>` が 1 行残る形では、提出 0 件でも `submitted / B-empty`（`:650-655`）になった。
- 影響:
  - 201 が返り、user 行が作られる。人は送り直さない（**未送信を送信済みにする**）
  - 案 X はこの成功を記録し、同じ ID に再掲するので、誤りが固定される（RC の試験）
- #4504 は状態の判定（`detect.ts:228`）と送信のゲート（`antigravity.ts:273`）を直す。読み戻しの規則は直さない。本文に語を含む形は、#4504 では原理的に直らない。

### 層 2 indeterminate の扱い【確定】
- 分類は `send-attempt-state.ts:378-380`（`indeterminate / submit-unconfirmed`）。応答は 500 で、本文に `[send state: indeterminate … do not resend before checking the pane …]` が付く（`:438-443`）。`sendOutcome:'unknown'`（`route.ts:125-131`、`:201-204`）。
- 失敗時は user 行を作らない（`send-user-message.ts:825`）。
- 文言が食い違う（S8 P3-2）: 送信器は “(typed but unsent)” と言い、記録は「確かめる前に送り直すな」と言う。

### 層 3 画面: unknown を一律「失敗＋再試行」にする【確定】
- `dispatchSend` の catch は `isNotSent` とロールの拒否以外をすべて `failPending` に流す（`usePendingMessages.ts:516`）。`error.data.sendOutcome` を読んでいない（読むことはできる。`api-client.ts:580-588`）。
- 状態の型は `'sending' | 'error'` だけ（`types/models.ts:718`）。バブルは「送信に失敗しました」＋［再試行］（`ChatMessageBubble.tsx:1216-1238`）。
- 30 秒の時計（`usePendingMessages.ts:70`）が切れても同じ表示になる。要求は `getSendTimeoutMs()`（`api-timeout-config.ts:84-86`）まで生きている。
- ［再試行］は新しい `POST /send` を出す（`:547-575`）。前の試行が飛行中でも押せる。
- await の経路も 2 つある（RC P2-1）。
  - (a) 楽観の送り先が無いとき（スマホの端末表示など。`WorktreeDetailRefactored.tsx:188-200・240-253` が `undefined` を渡す）。`MessageInput.tsx:749-776` で下書きを残して `setError`。
  - (b) brief の選択の送信 `sendWithBriefChoice`（`MessageInput.tsx:785-852`）。楽観経路のある画面でも常に await で、汎用の失敗はダイアログを閉じ、下書きを残す（`:843-846`）。
  - どちらも Enter 1 回で同じ本文が再送される。
- #4417: 古い試行の遅い応答が tempId で新しい行に当たる。成功（`:467-471`）と 500（`:516`）がそう。

### 層 4 `/send` に重複の断りが無い【確定】
- `SendMessageRequest`（`send-request.ts:36-`）に送信 ID が無い。ID の予約は `ask` にだけある（`lib/ask/ask-send.ts:41-88`、`reserveAsk` `lib/db/ask-correlation-db.ts:109`）。
- 入力ロックは並べるだけ。2 本目は `waitForPrompt`（15 s、`antigravity.ts:117`）の後に打たれる。

---

## 2. サーバー側の直し（PR-B1。#4504（#4542）のマージの後に develop から切る。PR-B3 より必ず先）

この節の「F 名」は §6 の fixture の名前。`<file>:<行>` は `workspace/temp/agy-frames-4503/` の行番号で、取り込んだ後の fixture でも同じ行になる。

### 2.0 入力枠の特定: `readAntigravityInputBox`（`readAntigravityInputBoxStatusRow` を広げた 1 つの関数）

**入力と出力**
- 入力: ANSI を外した行。末尾の空行は落とす。今の関数と同じ前提
- 出力（枠を特定できたとき）: `{ statusRow, rows, empty }`
  - `rows`: 枠の中の各行の本文
  - `empty`: 空の枠か
- 出力（特定できなかったとき）: `null`

**使う場所**
- 今の `readAntigravityInputBoxStatusRow` は、この関数の `statusRow` を返す薄い包みにする
- 送信のゲート `isAntigravityReady`、ロールの判定 `readAntigravityRoleFrame`、#4504 の状態の検出、送信器の 4 か所が同じ読み方をする（R5v2 P1-2・範囲外 D）

#### 規則

| # | 規則 | 確かめたフレーム・行 |
|---|---|---|
| R1 | 一番下の行が罫線でなければ、それをステータス行とする。行は 1 つだけで、中身は問わない（空白だけでもよい） | `idle-empty:17`（`? for shortcuts … auto · Gemini 4 Neon · high`）、`typed-oneline:17`（右寄せの `auto · …`）、`submitted-0s:27`（右寄せの `Gemini 4 Neon · high`）、`submitted-1s:30`（`esc to cancel …`）、`mode-banner-typed:17`（`plan · …`）、2478 `after-tool-turn.txt:32`（空白だけ）。ステータス行の中身では空か文字ありかを決めない。空の枠でも `Gemini 4 Neon · high` になる（`submitted-0s:27`）ため |
| R2 | ステータス行のすぐ上（空行を飛ばす）が**下の罫線**。下の罫線は次をすべて満たす<br>・1 桁目から始まる（字下げなし。`trim()` しない）<br>・`─` だけ<br>・61 字以上 | 14 枚すべてで、枠の罫線は 1 桁目・200 字。旧版も同じ（2364 `idle-after-deny.txt:41・43`、2478 `after-tool-turn.txt:27・31`、2592 `antigravity-plan.txt:17・19`、`ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13`）。履歴の区切りは 1 桁目・60 字（`generating-empty:10・17`、`submitted-1s:24`、`typed-wrapped:10・17・24`、2364 `idle-after-deny:29`）。人の観察「枠の罫線は 1 桁目から画面の幅いっぱい」 |
| R3 | 下の罫線から上へ読む。**2 字以上の字下げの行**と**空行**は枠の続きの行とする。最初に出会う 1 桁目の非空行は、印の行でなければならない。印の行は `>` だけ、または `> ` で始まる行 | 2 行目以降が 2 字下げ: `typed-multiline:16`、`typed-wrapped:31-32`、`typed-spoof:16-17`。空行: 2478 `after-tool-turn.txt:29-30`（3 行の高さ）。印の行: 14 枚の枠のすべてで 1 桁目 |
| R4 | 印の行のすぐ上が**上の罫線**。上の罫線は 1 桁目から始まり、`─` だけで、下の罫線と同じ長さであること。上の罫線に着く前に次のどれかに出会えば `null` とする<br>・1 桁目の他の行（履歴の echo・spinner・長さの違う罫線）<br>・上の罫線が無い | `typed-spoof:16`: 本文の罫線は 2 字下げの 60 字なので、R3 で続きの行になり、罫線にはならない（人の観察と一致）。履歴の `> 依頼文` は 1 桁目だが、60 字の罫線の下にある（`submitted-done:24-25`）ので、上の罫線にならない。RC の「裸の `>`」の形は、全幅の罫線が無いので `null` |
| R5 | `rows`（各行の本文）の作り方:<br>・印の行は先頭の `>` と空白 1 つを外す（**1 行目だけ**。R5v2 P3-5）<br>・続きの行は 2 字の字下げだけを外す<br>・行末の空白を外す<br><br>`empty`: 次の両方を満たすとき真<br>・1 行目が空、または案内文（`ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN`。新しい正規表現は書かない）<br>・残りの行がすべて空 | 空: `submitted-0s:25`・`submitted-1s:28`・`submitted-done:30`（`>` だけ）、2478 3 行（`>`＋空行 2）<br>案内文: `idle-empty:15`（`> Auto mode: … (shift+tab to cycle)`、**既定の auto のモードでも出る**）・`mode-banner-empty:15`（Plan）・2592 `antigravity-plan.txt:18`。文字を打つと案内文は消える（`mode-banner-typed:15` `> hello`）<br>続きの行の `>` を残す例: `typed-spoof:17` |
| R6 | 枠の下に 2 行以上あるもの（ポップアップ・選択の画面）は、R1・R2 で `null` | 今の関数と同じ。`generating-empty:22-35` は許可のダイアログで、全幅の罫線（:23）の下に十数行がある。一番下は `esc to cancel`（:35）で、その上（:34 `↑/↓ Navigate…`）は罫線ではない。だから `null` |

**R5 の補足（本文が案内文と同じ文字のとき）**
- 打鍵の前（§2.4）は、案内文の形の行を空と読む
- §2.1・§2.2 で本文と比べるときは、`rows` が本文と一致すれば、案内文の形でも「本文がある」と扱う
- ANSI では、案内文は `\x1b[90m`（淡色）で、打った文字は既定の色（`idle-empty:15`・`mode-banner-empty:15` と `typed-oneline:15` の比較）。ただし旧版の fixture（2592・2478）は ANSI を持たないので、判定の条件には使わない。観察として残すだけ

**推定として残るもの**
- 枠の高さの上限（agy が枠の中をスクロールするか）は未計測。`typed-wrapped` は 3 行。上限は設けず、外れたら §2.1 の一致が成り立たず `body-not-landed` になる（安全側）
- 画面の幅が 60 字以下のときの区別。CommandMate はセッションを 200x1000 で作るので、対象外とする

### 2.1 Enter の前: 本文全体が枠に描かれたのを確かめる

- `ComposerSpec` に「打鍵した本文の確かめ方」の欄を足す。agy は `agy-input-box`
  - 待ちの骨組み（50 ms 間隔・上限・投げ方・引き上げ・持ち越しの印）は codex と共通にし、判定だけを分ける
  - codex・claude は変えない
- 受け付けの条件: 次の両方を満たすとき
  - `readAntigravityInputBox` が枠を特定し、`empty` が偽
  - `compactText(rows.join('\n')) === compactText(本文)`
  - 「止まった」だけでは受け付けない（RC P2-2）

  確かめた形:
  - 1 行: `typed-oneline:15`
  - 日本語: `typed-japanese:15`
  - 2 行（本文の LF＝C-j は改行で、提出にならない。人の観察）: `typed-multiline:15-16`
  - 折り返し（続きの行は 2 字下げ）: `typed-wrapped:30-32`
  - 本文に `Generating` と点字: `typed-generating-word:15`
  - 偽装: `typed-spoof:15-17`
  - バナーのモード: `mode-banner-typed:15`
  - ツールのターンの後: `after-tool-turn-typed:25`
- 受け付けたときに、**echo の基準**を記録する。その読みの中の、本文の echo（§2.2 (i)）の数
- 上限は本文の長さに比例させる（案: 2 s ＋ 20 ms/B）。**推定**: 人の採取に時間の計測は無い。上限まで一致しなければ、Enter を押さずに投げる（`body-not-landed`、indeterminate）
  - 投げる文の「Enter was not pressed, so nothing was submitted」は事実と合う。Enter を押しておらず、LF は改行なので、一部だけが提出されることもない

### 2.2 Enter の後: agy の読み戻しの規則（`classifySubmitWithRule` の agy の枝。R5v2 P3-3）

読み戻しのすべての読みに、次の順を agy だけ入れる。対象は今の 5 回・延長の読み・§2.3 の読み直し。agy では規則 A（`detectThinking` の窓の語）を使わない。

**送信済みの証拠（どちらも本文では偽れない）**
- (i) **echo の増加**: 1 桁目・61 字未満（実測 60 字）の罫線の直下にある、1 桁目の `> ` の行を echo とする。echo の行の本文を詰めた文字列が、本文の 1 行目を詰めた文字列の先頭であって、長さが `min(20, 1 行目の長さ)` 以上のとき、その echo を数える。その数が §2.1 の基準より増えたら、証拠とする
  - 確かめた行: `submitted-1s:24-25`・`submitted-done:24-25`（`> Reply with exactly: OK one` が増える）、`generating-empty:17-18`
  - 本文の行は、枠の中では 2 字下げか印の行の後にある。だから「60 字の罫線の直下の 1 桁目」には出ない（`typed-spoof:16-17`）
- (ii) **枠が空で、ステータス行が `esc to cancel`**（`ANTIGRAVITY_CANCEL_FOOTER_PATTERN` をステータス行にだけ当てる）
  - 確かめた行: `submitted-1s:30`
  - ステータス行は下の罫線の下にあるので、本文は届かない

**規則の順**

| 順 | 読み | 判定 | Enter |
|---|---|---|---|
| 1 | 枠を特定でき、`rows` に本文の一部がある（`compactText(本文)` が `compactText(rows)` で始まる、または等しい） | `pending`（D） | 前回より伸びていれば押さない。本文全体と等しく、前回から変わっていなければ 1 回押す（Enter が飲まれた） |
| 1' | 1 のうち、`rows` が案内文の形で本文と等しい | (i) があれば `submitted`、無ければ 1 と同じ | 同上 |
| 2 | 枠を特定でき、`rows` が本文と関係ない文字 | `/…` なら `replaced`（今の E）、それ以外は `indeterminate` | 押さない |
| 3 | 枠を特定でき、`empty` | (i) か (ii) があれば `submitted`。無ければ `awaiting`（新しい状態。送信済みにしない） | 押さない |
| 4 | 枠を特定できない（`null`） | `indeterminate`（`U-unlocated`）。(i) があっても送信済みにしない（PM の裁定「入力枠を特定できなければ unknown」）。提出の直後に許可のダイアログが出た形（`generating-empty`）も unknown になる（既知の制限、§9。R5v2 P3-4） | 押さない |

**補足**
- `awaiting`・`indeterminate` のまま窓が尽きたら、§2.3 へ進む
- 窓の長さ: agy は伸びている間・`awaiting` の間は延長する。合計の上限は §2.1 と同じ式
- 読む範囲: agy の `verifyCaptureLines` を広げ、枠の全行とその上の履歴が入るようにする。目安は画面全体（今は 12 行）。§2.1 と同じ範囲で数えないと、echo の基準が比べられない
  - 履歴がスクロールして echo が窓から消えると、(i) が増えて見えないことがある。その場合は (ii) か unknown に倒れる（安全側）

### 2.3 確定できずに終わるとき: 1 回だけ読み直す

- 入力ロックを持ったまま、案 3 s 待って 1 回読む。§2.2 の表で `submitted` なら、201 と user 行を返す。それ以外は `submit-unconfirmed` で投げる（500・`unknown`）
- 文言: “(typed but unsent)” を「Enter は送った。後から提出されることがある。確かめる前に送り直さない」に変える。分類の句 `submit could not be confirmed` は残す
- 3 s は推定の値

### 2.4 打鍵の前: 枠が空でなければ打たない（打ち足しの防止）

- 打鍵の前の読み直し（`recheckComposerBeforeInput` の後）で、`readAntigravityInputBox` の結果を見る
  - 枠を特定でき、`empty` が偽のとき: 打たずに `not-sent / composer-not-empty` で断る
    - 対象: 枠に前の本文が残っている（Enter なしで投げた後に、遅れて入った本文など）
    - 文言は、`classifySendFailure` の既存の句に合わせる
  - 案内文は空（R5）なので、どのモードでも送れる: `idle-empty`・`mode-banner-empty`・2592 `antigravity-plan`
  - 枠を特定できないとき: readiness の扱いに任せる。`waitForPrompt` が同じ関数で ready を決めるので、通常は特定できる
- 自動で `C-u` して進めることはしない（第 2 版と同じ。消したかを読めないため）

### 2.5 書くファイル（#4542 のマージ後の develop で）

| ファイル | 変えること |
|---|---|
| `src/lib/detection/tools/antigravity/patterns.ts` | `readAntigravityInputBox` を足し、`readAntigravityInputBoxStatusRow` を包みにする |
| `src/lib/cli-tools/antigravity.ts` | ゲート・ロールの判定は包みのまま。792-832 の呼び出しに確かめ方を渡す |
| `src/lib/cli-tools/submit-composer-read.ts` | agy の枝、echo の数え方 |
| `src/lib/cli-tools/submit-verified-sender.ts` | 確かめ方の骨組み、echo の基準、`awaiting`、§2.4 |
| `src/lib/cli-tools/submit-verified-sender-report.ts` | 確かめ方の骨組み（§2.1）、Enter の保留 |
| `src/lib/cli-tools/composer-spec.ts` | 欄、`verifyCaptureLines` |
| `src/types/cli-tool-contracts.ts` | `ComposerSpec` の欄 |
| `src/lib/session/send-attempt-state.ts` | 文言 |
| `tests/fixtures/antigravity-live-4503/` | 新しく作る。14 枚と README |
| 試験 | §6 |

- 状態の検出（#4504 の `detect.ts`）は包みを通して自動で新しい規則になる。陰性対照の fixture で、変わらないことを確かめる（§6 L3）

### 2.6 推定として明記するもの

- **`submitted-0s` の位置づけ**: 中身は次のとおり（確定）
  - 枠は空の `>`（:25）
  - ステータス行は `Gemini 4 Neon · high`（:27）
  - 履歴には `Run ls…` の 2 ターンだけがあり（:10-22）、送った `Reply with exactly: OK one` の echo も返事も無い
  
  よって「返事まで進んだ」ではない。「Enter の直後、枠は空になったが、echo はまだ描かれていない」と読む（推定）。この形は §2.2 の 3 で `awaiting`（送信済みにしない）になり、続く読み（`submitted-1s` の形）で (i)・(ii) により `submitted` になる
- **Enter が早すぎたとき**（本文の取り込みの途中の Enter）の agy の扱いは採っていない（`enter-too-early` は無い）。§2.1 は全文の一致の前に Enter を押さないので、正常な経路では起きない。§2.2 の 1 の再送も、全文と等しく止まっているときだけ押す
- **`generating-empty.txt` の名前と中身が違う**: 名前と人の観察は「`⣯ Generating...` と空の枠」。しかし中身は許可のダイアログ（:23-35、入力枠は無い）。生成中の枠の実例は `submitted-1s:26-30`（`⣻  Working...`・空の枠・`esc to cancel`）。fixture の README にこの食い違いを書く。1.5.13 の生成中の語は `Working...` で、#4504 の `ANTIGRAVITY_GENERATING_ELLIPSIS_PATTERN`（`Generating…` だけ）には当たらない（spinner の行の規則には当たる）。#4504 のレビューに伝える

---

## 3. 画面側の直し（PR-B2「#4503 の画面＋#4417」の束。先に出してよい）

### 3.1 状態の決め方
`OptimisticSendState` に `'unknown'` を足す。時計切れの「応答待ち」は `'sending'` ＋印でもよい。

判定の順（R5v2 P3-1）: 応答に `sendOutcome` があればそれだけで決める（`not_sent` → `error`、`unknown` → `unknown`）。無いときだけ、下の表でステータスと fetch の種類で決める。

| 応答 | 状態 |
|---|---|
| 201 | 今と同じ（エコーで消える） |
| `sendOutcome` の無い 4xx（ロールの 409・`isNotSent` の柵など、今の個別の扱いを含む） | `error`（再試行してよい） |
| `sendOutcome` の無い 5xx（プロキシ・トンネルの 502/504 を含む） | `unknown` |
| fetch の拒否（`ApiError.kind` が `network`・`timeout`・`aborted`）。要求がサーバーに届いたか分からない | `unknown` |
| fetch の前に断られた（`kind:'offline'`＝`api-client.ts:380` の「No network connection」、`isNotSent` の柵） | 要求は出ていない。オフラインの保留（#2503）か `error` |
| 30 秒の時計切れで、その試行がまだ飛行中（`inFlightRef`） | 「応答待ち」。応答が来たらその種類に従う |

- オフライン復帰の自動再送（#2503）は、`kind:'offline'` で保留された（要求が出ていない）ものだけを対象にする。`unknown` は対象にしない。
  - 案 X の後: 自動再送が同じ ID なら、`network` の失敗も自動再送の対象に戻してよい（サーバーが断るため）

### 3.2 ［再試行］を出す条件

| 状態 | 案 Y（ID なし） | 案 X（PR-B3 の後） |
|---|---|---|
| `error`（`not_sent`・4xx・要求が出ていない） | 出す | 出す（同じ ID） |
| 応答待ち | 出さない | 出さない |
| `unknown` | 出さない。［ターミナルを確かめる］と「確かめたうえで送り直す」（確認の一言の後、新しい送信）を出す | 同じ。ただし「送り直す」は新しい ID。応答の無い失敗（`network`・`timeout`・5xx で `sendOutcome` なし）に限り、同じ ID の［再試行］を出してよい（サーバーが飛行中・送信済み・`unknown` を断るため） |

- `unknown` の文言は「届いたかどうか分かりません。ターミナルを確かめてから、必要なら送り直してください」。既存の `locales/ja/worktree.json:681` `sendFailed` に寄せ、新しいキーで ja/en を足す。

### 3.3 await の 2 経路（RC P2-1）
- (a) ふつうの await（`MessageInput.tsx:749-776`、スマホの端末表示ほか）と (b) brief の選択（`:785-852`）で、`describeSendError` の前に §3.1 と同じ判定をする。`unknown` なら次のとおりにする。
  - 下書きは残す。消すと、本当に届いていなかったときに本文が失われる
  - 入力欄の上に `unknown` の案内を出す
  - 同じ下書きの次の送信（Enter・ボタン・brief の選択）の前に、確認の一言を挟む
  - 下書きを編集したら確認を解く。別の送信として扱う。案 X では新しい ID
- (b) の brief のダイアログは、今と同じく閉じる（境目の選択は済んでいる）。確認は (a) と同じ印で持つ。

### 3.4 #4417 との関係（古い試行の遅い応答）
- すべての応答（成功・500・`unknown`・409）は、`attemptsRef.current.get(p.tempId) === p` のときだけ行に当てる。古い試行の応答は、行を変えずに「その試行がどう終わったか」だけを記録する。
- 古い試行の成功は「同じ本文が届いた」ことの証拠になる。新しい試行が飛行中なら、行に「前の送信が届きました」と出す。案 X なら新しい試行は同じ ID なので、サーバーが断る。
- 添付の戻し（#4417 の 2）と、起動に時間のかかる 409 の間の表示も束に入れる。

### 3.5 書くファイル
- `src/hooks/usePendingMessages.ts`
- `useOptimisticPaneMessages.ts`
- `src/components/sessions/SessionTile.tsx`（同じフック）
- `src/components/worktree/ChatMessageBubble.tsx`（1216-1238）
- `MessageInput.tsx`（733-776・785-852・添付の戻し）
- `src/types/models.ts`（718）
- `locales/{ja,en}/worktree.json`

送信器とは重ならない。#4501（ChatMessageBubble・locales）はこの後。

---

## 4. 送信 ID の 2 案の比較

### 4.1 案 X の形（第 2 版。第 3 版で応答の欄を足した）
- 応答（R5v2 P3-2）: ID を受け付けたサーバーは、成功・失敗のどちらの応答にも `clientSendId` を返す。返らなければ、画面は「冪等が効いていない古いサーバー」とみなし、§3.2 の案 Y の列の振る舞いにする（`validateSendRequest` は知らない欄を断らない。`send-request.ts:193-196`、R5v2 の確認）
- 欄: `/send` の要求に任意の `clientSendId`（16〜128 字の英数・`_`・`-`。`instances/roles` の key の形に合わせる）。ID の無い要求は今と同じ。
- **鍵は `(worktreeId, clientSendId)`**（R5 P2-2）。記録に持つもの:
  - 解決した宛先 `(cliToolId, instanceId)`
  - 本文の digest（`sendMessageDigest`）
  - 状態（飛行中・`sent`・`unknown`・`not_sent`）と、`sent` なら応答の本文
- 2 回目の同じ ID への応答:

| 1 回目の状態 | 2 回目 |
|---|---|
| 宛先か本文が違う | 409 `SEND_ID_CONFLICT`（打たない） |
| 飛行中 | 409 `SEND_IN_PROGRESS`（`sendOutcome:'unknown'`、打たない） |
| `sent` | 200 で前の結果（打たない） |
| `unknown` | 409 `SEND_OUTCOME_UNKNOWN`（打たない） |
| `not_sent` | 新しい試行として進む（記録を上書き） |

- 予約の位置: 宛先の解決（`validateSendRequest`、`route.ts:251`）と方針の判定（`:298`）の後、`sendUserMessage`（`:489`）の前。方針で断られた送信は予約を残さない（#4466 I1）。ask・relay の予約との順は、PR1a の切り出しの後の形で決める。
- 寿命（R5 P3-1）: 状態が確定した時刻から 30 分。飛行中は消さず、件数の上限で追い出すときも飛行中は追い出さない。
- **配る経路**（RC P2-1）。ID は「試行の束」ごとに 1 つ:
  - 楽観のバブル: 行の［再試行］・自動再送は同じ ID
  - ふつうの await: 下書きの同じ送信の再送は同じ ID、編集・確認の後の送り直しは新しい ID
  - brief の選択の送信: 同じ
- 保存はメモリ（新しいファイル `src/lib/session/send-idempotency.ts`）。DB にするなら v76 で追加の表だけ（`ask_correlations` の形を参考にする。#4490 の分類は「worktree と消す状態」）。推奨はメモリ。
- `route.ts` への差分は予約 1 か所と、POST の最後の記録 1 か所だけ。PR3 が後で `operationKey` を作るときに、同じモジュールを名前空間を分けて使える形にする。

### 4.2 比較

| 軸 | 案 X（/send に `clientSendId`） | 案 Y（#4466 PR3 に寄せる） |
|---|---|---|
| 二重送信をどこまで防げるか | §2・§3 に加え、同じ試行の束の重複をサーバーで断る（RC: 飛行中でも unknown の後でも提出 1 件） | §2・§3 だけ（RC のモデル: `/send` に止める層が無く、3 本目まで提出） |
| 残る経路 | (1) unknown を確かめたうえで送り直す（新しい ID、意図した送信）(2) 再読み込み・別の端末での打ち直し (3) サーバーの再起動で記録が消える（§4.3）(4) ID の無い呼び手（CLI の `send`・Timer・relay 配送・古い画面）(9) §2.4 の残りへの打ち足し（冪等では塞がらない。§2.4 で塞ぐ） | (1)(2)(4)(9) に加えて (5)〜(8) が残る<br>(5) 画面の取り違えで再試行が出る<br>(6) 応答が失われ、サーバーはまだ処理中（PR-B2 で unknown にするが、人が送り直せば二重）<br>(7) 2 タブ<br>(8) PR3 が入っても画面の `/send` は対象外 |
| 誤った成功の固定 | PR-B1 の前に入れると、層 1b の誤った成功を記録して再掲する（RC）。**PR-B1 の後なら起きない** | 関係なし |
| 本当に未送信のとき再送できるか | できる（`not_sent` は同じ ID でも進む。RC: 打鍵前の capture 失敗 → 同じ ID で提出 1 件） | できる |
| 保存先 | メモリ（推奨）／DB なら v76 | なし（PR3 で DB、番号は PR3 のとき） |
| 公開の API 契約 | 追加だけ: 要求の任意の欄 1 つ、409 の code 3 つ、送信済みの 2 回目は 200。docs・CHANGELOG・人の了承（公開の API の追加） | #4503 では変わらない |
| #4466（レーン A）との衝突・直列 | `send/route.ts`・`send-request.ts` を触る。#4466 PR1a・#4498 の後に直列にし、#4518 PR1 とは同時に開かない（`send-request.ts`） | 衝突なし |
| 工数（見立て） | サーバー M、画面 S〜M（3 経路の配線） | 0（ただし Issue の受入条件 3 を外す） |
| 試験 | §6 の X1〜X6 | なし |

### 推奨: 案 X（PR-B3 として、PR-B1・#4466 PR1a・#4498 の後）
- 寄せ先の PR3 は画面の `/send` を対象にしない。#4503 の事象（画面からの二重・三重）に直接効くのは X だけ。
- 経路 (5)(6)(7) は、画面の表示だけでは閉じられない。
- メモリで足り、v76 を使わない。欄は任意なので、古い呼び手は今と同じ。
- 衝突は「PR1a・#4498 の後、#4518 PR1 と別の時期」に並べれば消える。PR-B1・PR-B2 は X を待たない。

案 Y を選ぶ場合: PR-B3 は無くなる。#4503 の受入条件 3 を外し、#4466 PR3 の範囲に「画面の `/send`」を足す（行き先を残すため）。§3.2 の案 Y の列を最終形とする。

### 4.3 既知の制限（案 X）
- サーバーの再起動で記録が消える。agy の遅い取り込みの最中に再起動すると、1 回目は後で提出され、同じ ID の再試行は新しい試行として通りうる。
- 起動直後に ID つきの要求を断る案は採らない。起動の前の ID を見分けられず、正当な送信まで断るため。docs と CHANGELOG に既知の制限として書く。

---

## 5. 不変条件（壊してはいけない）

| # | 不変条件 | どこで守るか |
|---|---|---|
| N1 | **未送信を送信済みにしない**（PM の裁定）<br>(a) 入力枠を特定できなければ unknown<br>(b) 本文の `Generating`・点字・裸の `>`・罫線だけでは送信済みにならない（陰性対照。直す前に赤になることを示す）<br>(c) 空の枠を送信済みにするのは、本文では偽れない証拠 (i) か (ii) があるときだけ<br>守りは 2 段: §2.0 の枠の特定と、§2.2 の証拠 | §2.0・§2.2、§6.3 N-1〜N-6 |
| N1' | **本当に提出されたら送信済み**（陽性対照） | §2.2、§6.3 P-1・P-2 |
| N2 | 送信済みを再送しない<br>・`unknown` と応答の無い失敗に、直接の［再試行］（案 Y）や自動再送を出さない<br>・案 X では同じ ID の 2 回目を打たない<br>・Enter の再送は、枠が本文全体と等しく止まっているときだけ | §2.2・§3・§4 |
| N3 | Enter を押していない本文を `not-sent` と言わない（`body-not-landed` は indeterminate）。枠に文字が残っていれば次の送信を打たない（案内文は空として扱い、文字とは数えない） | §2.1・§2.4 |
| N4 | 送信の確認を緩めない<br>・#4466 の I1・I2（案 X の予約は、方針の判定の後に置く。宛先が違えば 409）<br>・claude/codex の読み戻しの回数・規則・hook の確かめ（#4035）・`composer-residue`（#3759）を変えない | §2・§4.1 |
| N5 | `classifySendFailure` の句と `sendOutcome` の意味を変えない | §2.3・§2.4 |
| N6 | ID の無い要求は今と同じ | §4.1 |
| N7 | 案 X の `sent` の記録は、PR-B1 の読み戻しが確かめた成功だけにする。PR-B3 は PR-B1 の後 | §7 |
| N8 | 送れる状態の agy への送信を止めない（#2478・#2592 の回帰を起こさない）<br>・どのモードの案内文の枠でも、3 行の枠でも、ステータス行がモデル名だけの枠でも、打鍵まで進む | §2.0・§2.4、§6.3 G-1〜G-3 |

---

## 6. 試験の計画（本物の agy は使わない）

AI は agy を実行しない（--version も、11-16 の決定）。`~/.gemini` にも触らない。取り込みと試験は PR-B1 のワーカーが書く。

### 6.0 fixture の取り込み

- 置き場: `tests/fixtures/antigravity-live-4503/`。14 枚をバイトのまま置く（ANSI もそのまま）
- README に書くこと:
  - 由来の表（ファイル・採った形・人の操作）
  - 版: agy 1.5.13、Gemini 4 Neon、Google AI Pro
  - 採り方: `tmux capture-pane -p -e -S - -E -`、200x1000、2026-11-21、人が採取
  - 伏せた語: メール → `dev@example.com`、ホームのパス → `/Users/dev/agy4503-probe`、シェルのプロンプト → `dev@host`。PM が置き換えた。ほかのバイトと ANSI は変えていない
  - `generating-empty.txt` の名前と中身の食い違い（§2.6）
  - `submitted-0s` の読み（§2.6）
  - 採っていない形: `enter-too-early`
- 1 行目のシェルの行（`env HOME=/tmp/agyhome-4503.… agy`）は残してよい。枠の特定は下から読むので、影響しない

### 6.1 枠の特定の単体試験（純粋な関数 `readAntigravityInputBox`）

期待の列:
- 特定: 枠を特定できたか
- empty: 空の枠か
- rows: 枠の中の各行の本文
- status: ステータス行

| fixture | 特定 | empty | rows | status | 根拠の行 |
|---|---|---|---|---|---|
| F1 `idle-empty` | ○ | 真（auto の案内文） | — | `? for shortcuts … auto · …` | 14-17 |
| F2 `generating-empty` | ×（許可のダイアログ） | — | — | — | 22-35 |
| F3 `mode-banner-empty` | ○ | 真（plan の案内文） | — | `? for shortcuts … plan · …` | 14-17 |
| F4 `mode-banner-typed` | ○ | 偽 | `hello` | `plan · …` | 14-17 |
| F5 `typed-oneline` | ○ | 偽 | `Reply with exactly: OK one` | `auto · …` | 14-17 |
| F6 `typed-japanese` | ○ | 偽 | `日本語の本文です。返事は OK だけ` | `auto · …` | 14-17 |
| F7 `typed-multiline` | ○ | 偽 | `line one` / `line two` | `auto · …` | 14-18 |
| F8 `typed-wrapped` | ○ | 偽 | `Reply with exactly: OK` / `abc…`（2 行） | `Gemini 4 Neon · high` | 29-34。上の 60 字の罫線（:10・17・24）は枠にならない |
| F9 `typed-spoof` | ○ | 偽 | `x` / `─`×60 / `>` | `auto · …` | 14-19。本文の罫線（:16）は続きの行 |
| F10 `typed-generating-word` | ○ | 偽 | `Generating のテストを直して ⠋` | `auto · …` | 14-17 |
| F11 `submitted-0s` | ○ | 真 | — | `Gemini 4 Neon · high` | 24-27 |
| F12 `submitted-1s` | ○ | 真 | — | `esc to cancel … ` | 27-30。上の `⣻  Working...`（:26）は枠の外 |
| F13 `submitted-done` | ○ | 真 | — | `? for shortcuts` | 29-32 |
| F14 `after-tool-turn-typed` | ○ | 偽 | `next` | `Gemini 4 Neon · high` | 24-27 |
| L1 2478 `after-tool-turn.txt` | ○ | 真（3 行の高さ） | — | 空白だけ | 27-32 |
| L2 2478 `after-plain-turns.txt` | ○ | 真 | — | — | — |
| L3 2364 `idle-after-deny.txt` | ○ | 真 | — | `? for shortcuts` | 41-44 |
| L4 `ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13` | ○ | 真 | — | `esc to cancel …` | `model-info-captures.ts:63` |
| L5 2592 `antigravity-plan`・`-accept-edits` | ○ | 真（案内文） | — | `? for shortcuts` | 17-20 |
| L6 2364 のダイアログ・trust・picker・popup・`dialog-feedback-category`・`survey-after-deny.reconstructed` | × | — | — | — | R5v2 P2-3 の陰性の一覧 |
| S1 合成: 提出の途中（60 字の罫線＋`> 本文`＋全幅の罫線 1 本だけ）。F12 を切って作る | × | — | — | — | 推定の形 |
| S2 合成: RC の裸の `>`（枠を消し、履歴の `> ` だけを残す）。F13 の 29-32 行を消して作る | × | — | — | — | — |

- L1〜L5 は今の `readAntigravityInputBoxStatusRow` と同じ結果になること（回帰の試験）
- 送信のゲート・ロールの判定・#4504 の状態の検出の既存の試験が変わらず通ること

### 6.2 読み戻しの単体試験（`classifySubmitWithRule` の agy の枝。echo の基準を引数で渡す）

| 入力 | 文脈 | 期待 |
|---|---|---|
| F5（F6・F7・F8・F14 も同じ形） | 打鍵の後、Enter の前（§2.1） | 本文と一致すれば受け付け。本文の末尾が欠けた合成のフレームは受け付けない |
| F5 | Enter の後で、そのまま残る | `pending`（D）。前回と同じなら Enter 1 回 |
| F9 `typed-spoof` | Enter の後で残る（本文は `x\n` ＋ `─`×60 ＋ `\n>`） | `pending`。`submitted` にしない |
| F10 | Enter の後で残る | `pending`。規則 A で `submitted` にしない |
| F4 | Enter の後で残る | `pending` |
| F11 `submitted-0s` | 本文 `Reply with exactly: OK one`、基準 0 | `awaiting`（送信済みにしない。Enter も押さない） |
| F12 `submitted-1s` | 同、基準 0 | `submitted`（(i) と (ii) の両方） |
| F13 `submitted-done` | 同、基準 0 | `submitted`（(i)） |
| F13 | 同、基準 1（同じ本文の echo が前からあった） | `awaiting`。(i) が増えていないため |
| F1・F3 | Enter の後に案内文の空の枠。基準 0、echo なし | `awaiting` |
| F2 | 本文 `Run ls with the shell tool, then reply OK`、基準 1 | `indeterminate`（枠なし。PM の裁定。§9 の既知の制限） |
| S1・S2 | 任意 | `indeterminate` |
| S3 合成: 案内文と同じ文字の本文が枠に残る（F3 の 15 行のまま） | 本文＝案内文、基準 0 | `pending`。基準より増えていれば `submitted` |

### 6.3 送信器の試験（時刻で進む偽の画面。RC P3-1）

**偽の画面の作り方**
- 実フレームを型にする: 空の枠は F1、打鍵の途中・後は F5 の枠の行を本文で置き換えたもの、提出の後は F11 → F12 → F13 の並び
- Vitest の fake timers で、時刻の関数として作る
  - 打鍵の時刻から r 文字/ms で枠に描く
  - Enter は時刻つきで列に積む
  - 提出の時刻は「最初の Enter と全文の時刻の遅いほう＋δ」
  - 送信器が戻った後も時計を進めれば、提出が起きる
- 数えるもの: `sendKeys`（本文）の回数、Enter の回数、提出の回数、送信器の結果

**現象の再現（今のコードで通る）**
- R1: 1,400 ms で提出する偽の画面で、`submit-unconfirmed` を投げる。その時点で提出 0、その後 1。同じ本文の送信を 2 回やり直すと提出は計 3

**受入の試験（直す前に赤）**

| # | 条件 | 期待 |
|---|---|---|
| N-1 | F10 の本文（`Generating`・点字）で、Enter を飲む | 成功を返さない。提出 0 |
| N-2 | F9 の本文（罫線と `>`）で、Enter を飲む | 成功を返さない |
| N-3 | S2（裸の `>`）が Enter の後に出る | 成功を返さない |
| N-4 | 本文が罫線の行だけ（`─`×60 を 2 行）で、Enter を飲む | 成功を返さない |
| N-5 | Enter の後に枠が空になるが、echo も `esc to cancel` も出ない（誰かが消した） | 成功を返さない（unknown） |
| N-6 | 本文が案内文と同じ文字で、Enter を飲む | 成功を返さない |
| A-1 | 遅く描く短い本文 | 全文の前の Enter 0、提出 1、成功 |
| A-2 | 上限を超えて描く → Enter なしで投げる → 後で旧本文が枠に入る → 次の送信 | 次は `composer-not-empty`。本文の打鍵は計 1 回 |

**陽性対照（直す前も後も緑。壊さないことを固定する）**

| # | 条件 | 期待 |
|---|---|---|
| P-1 | F11 → F12 → F13 の並びで本当に提出される | 成功。user 行 1 |
| P-2 | 窓の後に提出される（§2.3 の読み直しで F12 の形） | 成功 |
| G-1 | 送れる状態の枠（N8）: F1（auto の案内文） | 打鍵まで進み、成功 |
| G-2 | 同じく F3（plan の案内文） | 同上 |
| G-3 | 同じく L1（3 行の枠） | 同上 |
| U-1 | 本当に未送信（打鍵の前の capture が失敗） | `not-sent / recheck-failed`。続く送信は提出 1（再送できる） |
| C-1 | codex・claude の既存の試験（3366・3880・`submit-verified-sender.test.ts`） | 変わらず通る |

- 結合（偽の `tmux`、`tests/helpers/fake-agy-path.ts` の `extraBinaries`）は、単体で足りれば省く

### 6.4 画面（PR-B2）・送信 ID（PR-B3）
第 2 版のとおり（U1〜U5、X1〜X6）。加えて X7: 応答に `clientSendId` が返ること（R5v2 P3-2）。

### 6.5 人の確かめ（本物の agy、AI は行わない）
- 全文が描かれるまでの時間（§2.1 の上限の式）
- Enter が早すぎたときの扱い（`enter-too-early`）
- 枠の高さの上限
- 提出の直後の 1 枚が `submitted-0s` の形になるか
- PR-B1 の後に画面から 100/300/500 B を送り、1 回だけ届き、結果が成功か unknown になること

---

## 7. PR の分け方と順

| 順 | PR | 前提 | 書くファイル | 担当の目安 |
|---|---|---|---|---|
| 1（先行可） | PR-B2 画面の束（#4503 の画面＋#4417） | PM の判断（§8 D4・D5）。送信器には依存しない | §3.5 ＋ U1〜U5 | opus（束ねるため） |
| 2 | PR-B1 サーバー（§2: 枠の特定の 1 関数・証拠つきの読み戻し・全文の照合・Enter の保留・読み直し・打ち足しの防止・文言・fixture 14 枚の取り込み） | #4504（#4542）のマージの後に develop から切る（`antigravity.ts`・`patterns.ts` の共有） | §2.5 ＋ §6.1〜§6.3 | opus（未送信を送信済みにしない境目） |
| 3 | PR-B3 送信 ID（案 X のとき） | **PR-B1 のマージ**、#4466 PR1a・#4498 のマージ。#4518 PR1 と同時に開かない | （新）`src/lib/session/send-idempotency.ts`、`send/route.ts`（2 か所）、`send-request.ts`、`src/lib/api-client.ts`、`usePendingMessages.ts`・`MessageInput.tsx`（3 経路の ID）、docs・CHANGELOG ＋ X1〜X6 | opus |
| 後 | #4495 | PR-B1 | 送信器 | — |
| 後 | #4501 | PR-B2 | ChatMessageBubble・locales | — |

- PR-B1 と PR-B2 の両方が同じレーン（claude-4）なら、PR-B2 → PR-B1 の順を推奨する。PR-B2 は効果が早く、#4504 を待たない。
- 各 PR は高リスクなので、レビューを系統を分けて 2 本。`docs/module-reference.md` は断片で渡す。`changelog.d/4503.md`。
- Sprint 9 に #4466 PR1a が間に合わない場合: PR-B2・PR-B1 だけ入れ、#4503 は開けたままにする。PR-B3 は Sprint 10 の先頭にする。

---

---

## 8. PM に決めてほしいこと（推奨つき）

| # | 事項 | 推奨 |
|---|---|---|
| D1 | 送信 ID を #4503 で入れるか（案 X）、#4466 PR3 に寄せるか（案 Y） | **案 X**。鍵は `(worktreeId, clientSendId)`、宛先と本文が違えば 409。PR-B3 として、PR-B1・#4466 PR1a・#4498 の後 |
| D2 | 順の前提: PR-B1 を PR-B3 より必ず先に。PR-B2 は先に出してよい | この順 |
| D3 | 案 X の保存先と寿命 | メモリ。確定から 30 分、飛行中は消さず追い出さない。v76 は使わない（#4492 に回せる） |
| D4 | 画面の `unknown` の範囲: `sendOutcome:'unknown'`・`sendOutcome` の無い 5xx・fetch の拒否・時間切れ。`error`＋［再試行］は `not_sent` と 4xx だけ。await の 2 経路も同じ | この範囲 |
| D5 | `unknown` の振る舞い: 直接の［再試行］なし、［ターミナルを確かめる］と「確かめたうえで送り直す」（確認つき・新しい送信）。30 秒の時計切れは「応答待ち」 | この形。文言は既存の `sendFailed`（ja 681）に寄せる |
| D6 | 案 X の公開の契約の追加（任意の欄 1 つ・409 の code 3 つ・送信済みの 2 回目は 200） | 足す（人の了承を Issue に書く） |
| D7 | 案 X の再起動の扱い | 既知の制限として docs・CHANGELOG に書く（起動直後に断る案は採らない） |
| D8 | agy の打ち足しの防止: 枠に文字があれば打たずに `not-sent / composer-not-empty`（自動で消さない） | この形 |
| D9 | 送信器の agy の待ちの上限（2 s ＋ 20 ms/B、読み直し 3 s）を推定の値で入れ、人の確かめで直す | 入れる。CHANGELOG に「推定の値」と書く |
| D10 | 案 Y を選ぶ場合: #4503 の受入条件 3 を外し、#4466 PR3 の範囲に画面の `/send` を足す | 案 Y なら必須 |

| D11 | 枠を特定できない画面（提出の直後の許可のダイアログ）でも、echo の増加 (i) があれば送信済みにするか | しない（PM の裁定「入力枠を特定できなければ unknown」のまま）。unknown が増える形は既知の制限として docs に書く。実際に unknown が多ければ、後で裁定を見直す材料にする |
| D12 | fixture `generating-empty.txt` の名前（中身は許可のダイアログ）| 名前は人の採取のまま残し、README に食い違いを書く。生成中の枠の例は `submitted-1s` とする |

## 9. 未確認・既知の制限（人の確かめ・レビューで見てほしい点）
- 推定（§2.6・§6.5）: 全文が描かれるまでの時間、Enter が早すぎたときの扱い、枠の高さの上限、提出の直後の 1 枚の形
- 既知の制限: 提出の直後に許可のダイアログが出ると、枠が消えるので unknown になる（`generating-empty` の形。D11）。ダイアログに答えた後の 1.5.13 の枠の形は採っていない
- 1.5.13 の生成中の語は `Working...`（`submitted-1s:26`）。#4504 の `ANTIGRAVITY_GENERATING_ELLIPSIS_PATTERN` は `Generating` だけを見る。PR-B1 は規則 A を使わないので影響しない。状態の検出には #4504 のレビューで伝える
- §2.3 の読み直しで sent にしたときの、bound relay の generation（`relay-bind.ts:323-331`、R5 P3-3）。読んでいない
- 他の tool の `B-absent` を送信済みと読む件（R5 範囲外）。別 Issue の候補
- 案 X の予約と ask・relay の予約の順。PR1a の後の形で決める
