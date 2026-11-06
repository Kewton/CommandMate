# Issue #4187 設計方針: OpenCode V2 の返信を画面の読み取りで保存するか

- 対象: Issue #4187（#4175 の項目 3a を外した理由の残り）
- 基準: develop `45963ac7b`（行番号はこの時点で確認したもの）
- 段: 設計のみ。`src/` と `tests/` は変えない。実装は 2-4-4（Codex の事前レビュー）の後、別の契約で行う
- 表記: **［事実］** は file:line を読んで確かめたこと。**［見立て］** は推論。**［未確認］** は確かめていないこと

---

## 0. 結論

**画面の読み取り（`isTurnComplete`）では V2 の返信を保存しない。今の動き（V2 は画面では完了を返さない）を設計として確定する。**
live でない間の返信は、画面ではなく **V2 自身のサーバーの文書（`GET /api/session/{id}/message`）を後から読む既存の経路**に任せ、その経路の穴（再接続した後にターンの終わりが来ないと読まれない）を 1 つ塞ぐ。`--standalone`（サーバーが無い）の返信は記録しないことを仕様とし、利用者に見える形で残す。

理由の要点（詳細は §1）:

1. live でない状態のうち `lost`（切断・再接続待ち）は、後で V2 の文書から **同じターンが `oc-turn:<user message id>` の鍵で書かれる**。画面で保存した行には この鍵が無いので、両方が書くと**同じターンが 2 行になる**（受入基準「同じターンを両方の経路で保存しない」を、ゲートの時点では満たせない）。
2. 画面で保存するには Issue の問題 1〜3（開始位置・echo の境界・長い返信の頭）を全部直す必要があり、どれも V2 の実測で「本文の引用」に負ける形をしている。得られるのは `--standalone` の返信だけで、`--standalone` は本番の起動では劣化（`opencode-v2-launch-degraded-to-standalone` の warn、agent-health が不合格にする）として扱われている。
3. 画面の読み取りで V2 が完了を返さないことは、状態検出（`endsWithTurnComplete`）・`wait` とは独立している。保存しないと決めても `wait` や状態表示は壊れない。

---

## 1. 現状の事実

### 1.1 画面の読み取りの保存の経路

- ［事実］`isTurnComplete` に V2 の分岐が無い: `src/lib/polling/response-checker-extraction-steps.ts:599-653`。完了の判定は claude / codex / gemini / vibe-local / antigravity / copilot / command-code / opencode（V1）だけ。
- ［事実］V2 の chrome の境界（#4175 の 3b）は入っているが、届くのは部分の抽出だけ: 同 `:83-91` のコメント「opencode-v2 has no rule in `isTurnComplete`, so today this boundary reaches only the partial reading, which the poller does not save」。
- ［事実］V2 が画面で完了しないことはテストで固定されている: `tests/unit/detection/tools/opencode-v2/pattern-anchors-4175.test.ts:136`（`3a is not taken here`。実測 13 画面 × cursor 2 通り）。同じ describe で状態検出（`endsWithTurnComplete`）は完了と読むことも固定。
- ［事実］保存に進むのは `extractResponse` の結果が `isComplete` のときだけ: `src/lib/polling/response-checker.ts:756-796`（`!result.isComplete` で `return false`）。
- ［事実］対話のプロンプトの経路で完了になる可能性: `response-checker.ts:536-554` の早期確認は claude / codex / copilot / command-code だけで V2 を含まない。`:575` の後段（`cliToolId !== 'opencode'`）は V2 も通るが、#4184 のコミット本文の実測（V2 の fixture 52 枚 × cursor 3 通りで完了 0 件）で完了にならないことを確認済み（このとき `detectPromptWithOptions` ＋ `isNumberedDialogVouched` が V2 の画面で通らない）。［見立て］V2 の承認・質問は SSE（ingest）側で扱われるため、ここで通らないのは正しい。

### 1.2 Issue の問題 1〜3 の実コードとの照合

| # | Issue の記述 | 実コード | 判定 |
|---|---|---|---|
| 1 | `response-extractor.ts:215` の alternate screen の分岐に V2 が無い | `src/lib/response-extractor.ts:215` `if (cliToolId === 'opencode' \|\| cliToolId === 'copilot')`。V2 は `:229` 以降の枝（`captureWindowSaturated` → 既定の 3/4）へ落ちる | 合っている |
| 1 | `ALTERNATE_SCREEN_CLI_TOOLS` に V2 は既にある、`lineCountIsCursor` は false | `src/lib/cli-tools/types.ts:42-53`（`'opencode-v2'` あり、#2934）、`response-checker.ts:815` | 合っている。**#4184 のコミット本文の「本文に無い指摘」（`types.ts:42` に opencode-v2 が無い）は誤り**。Issue 本文が正 |
| 2 | echo の境界 `findOpencodeV2UserEchoEnd` | develop に無い（#4184 で外した）。`findRecentUserPromptIndexInFrame`（`response-checker-extraction-steps.ts:123`）に V2 の分岐は無い | 合っている |
| 3 | 蓄積は opencode・copilot だけ | `response-checker.ts:747-755`（`accumulateTuiContent`、V1 は `sliceOpenCodeTurn`） | 合っている |
| 3 | `openCodeCleanLines` は opencode だけ | `response-checker.ts:500`。`turnHeadTruncated` は `openCodeCleanLines` があるときだけ: `response-checker-extraction-steps.ts:794-799` | 合っている |
| 3 | 先頭の補完 | `cleanCompletedResponse` の V2 の分岐は無い: `response-checker.ts:1095-1116`（opencode だけが `turnHeadTruncated && accumulated`） | 合っている |

### 1.3 イベントストリームの経路（V2 の構造化履歴）

- ［事実］画面の保存は、push の書き手が live の間は止まる: `response-checker.ts:1423-1458`（`isStructuredHistoryWriterLive(...) || captureStructuredHistoryTurn(...)`）、`:1490`（`suppressScrapedHistory`）。V2 の probe は `src/lib/polling/structured-history-gate.ts:460-464`、判定は `:482` 以降（`push` 以外は false）。
- ［事実］V2 の「live」は `liveness.state === 'live'` だけ: `src/lib/hooks/sources/opencode-v2/subscription.ts:134-136`。
- ［事実］V2 の返信は、ストリームのターン終了（`session.execution.succeeded|failed|interrupted`）を合図に、文書を読んで書く: `src/lib/hooks/sources/opencode-v2/history.ts:86-90`、`subscription.ts:505-515`（`recordOpencodeV2TurnEnd`）、`:439-453`（`deliver` が毎フレームで呼ぶ）。
- ［事実］書くのは **その session の閉じた全ターンのうち、まだ無いもの**（新しい 50 本まで）: `history.ts:385-452`（`:429` closed、`:432` `MAX_OPENCODE_V2_SYNCED_TURNS`）。鍵は `oc-turn:<user message id>`、既にあれば書かない: `history.ts:337-345`（`findMessageByRequestId`）。モジュール冒頭 `history.ts:20-25`「A turn that ended while the connection was down is in the document the next time any turn of the session ends.」
- ［事実］画面の保存は `requestId` に `claudeMetadata?.requestId` を渡す（V2 では undefined）: `response-checker.ts:1351-1361`（保留の経路も `:1313`）。つまり **画面の行と文書の行は鍵で突き合わせられない**。
- ［事実］状態の遷移（`SubscriptionState.liveness`、`subscription.ts:82-93`）:
  - 開いた直後 `unknown`（`:176`）→ 接続できたら `live`（`markAlive`、`:247`、`:318`・`:329`）→ ストリームが切れたら `lost`（`:339`）→ 再接続で `live` に戻る（`runStream` のループ）。
  - 自分で終わる（パスワードのファイルが無い・port の持ち主が変わった）と `lost` のまま `endedLiveness` に残る（`:223-237`）。閉じると消えて `unknown`（`closeOpencodeV2Subscription`）。
- ［事実］`--standalone` の起動: port の割り当てが無いとき、または launch.sh / パスワードのファイルが無いときに落ちる: `src/lib/hooks/sources/opencode-v2/source.ts:104-126`。port が null のとき `subscribe` は購読を開かず `{ state: 'unknown' }` を返す: `source.ts:327-330`。agent-health は `--standalone` の起動行を不合格にする: `src/lib/agent-health/server-events.ts:101-115`。

### 1.4 live でない状態の分類

| 状態 | どう起きるか | 返信を後で書く者 | 画面で保存したら |
|---|---|---|---|
| A. `lost`（再接続待ち） | サーバーが一時的に応答しない、ストリームが切れた | **ある**: 再接続後、その session の次のターン終了で文書から書く（§1.3） | 次の同期で `oc-turn:` の行が別に書かれ、**同じターンが 2 行** |
| A'. `lost` のまま再接続後にターンが来ない | 最後のターンの途中で切れ、その後に送信が無い | **無い**（現状の穴。§2.2 で塞ぐ） | 1 行（ただし後で送信すると A と同じく 2 行） |
| B. `unknown`（開いた直後） | `openOpencodeV2Subscription` から最初の接続まで | ある（接続後の同期） | A と同じ |
| C. `--standalone`（port null） | port の範囲切れ・状態 dir に書けない | **無い**（サーバーが無い） | 1 行 |
| C'. `--standalone`（port あり・launch.sh / パスワード欠け） | `source.ts:117-125` | 無い。購読は死んだ port に向いて `lost` を繰り返す［見立て］ | 1 行 |
| D. 自分で終わった `lost`（`endedLiveness`） | パスワードのファイルが消えた・port の持ち主が変わった | 無い | 1 行 |

［見立て］A/B と C/C'/D は、poller から見える `liveness` だけでは区別できない（どれも `live` でない）。C は `unknown`、C' と D は `lost`。画面で保存するなら「後で書く者がいない」ことを別の手段で知る必要があり、それは §3 の B 案の追加の設計になる。

---

## 2. 決定（A 案: 画面では保存しない）

### 2.1 画面の読み取り

- `isTurnComplete` に V2 の分岐を**足さない**。`pattern-anchors-4175.test.ts:136` の固定をそのまま仕様とする（describe の名前の「3a is not taken here」は実装の契約で意味が合うかを見直してよいが、消さない）。
- Issue の問題 1〜3 は**直さない**（画面で保存しないので、保存の経路に V2 が来ない）。直さないことを、該当の 3 か所のコメントで V2 を名指しして書く（実装の契約で）:
  - `response-extractor.ts:215` の枝のコメント: V2 は alternate screen だが、完了の抽出に来ないのでこの枝に入れない（#4187）。
  - `response-checker.ts:747` の蓄積: V2 は完了を返さないので蓄積しても読まれない（#4187）。
  - `response-checker-extraction-steps.ts:83-91` のコメント: 既に「partial only」と書いてある。#4187 の決定を参照に足す。

### 2.2 live でない間の返信の扱い

| 状態 | 扱い |
|---|---|
| A / B（再接続できる） | 既存の同期に任せる。**穴 A' を塞ぐ**: 再接続して `live` に戻った時点で、その購読が最後に見た session を 1 回同期する（下の「再接続時の同期」） |
| C / C' / D（書く者がいない） | **記録しない**を仕様とする。利用者が気づけるようにする（下の「記録されないことを見せる」） |

**再接続時の同期（実装の範囲）**

- `SubscriptionState`（`subscription.ts:82-93`）に `lastSessionId: string | null` を足す。`deliver`（`:439-453`）でフレームの `frameSessionId(frame)` が null でなければ更新する。
- `runStream`（`:288-`）で、`lost` から `live` に戻った接続（初回の接続ではなく、2 回目以降。`attempt > 0` か「一度 `lost` を通った」印で判定）の `resyncOpencodeV2Pending` の後に、`lastSessionId` があれば `syncOpencodeV2History(target, port, lastSessionId, isCurrent)` を 1 回呼ぶ（`void`、待たない。`deliver` と同じ扱い）。
- 寿命と消える条件:
  - 生まれる: その購読で session id を持つフレームを最初に受けたとき。
  - 変わる: 別の session id のフレームを受けたとき（新しい session に切り替わった）。
  - 消える: 購読と一緒（`closeOpencodeV2Subscription` / `endSubscription` で `subscriptions` から外れる）。`endedLiveness` には残さない。サーバーの再起動で購読を開き直した（`reattach.ts`）場合は null から始まる。
- 二重にならない理由: 同期は `oc-turn:<user message id>` を鍵に既にある行を書かない（`history.ts:345`）。同じ session を通常のターン終了と再接続の両方で読んでも行は 1 本。直列化は `serialize(opencodeV2KeyOf(target))`（`history.ts:391`）で既にある。
- 同じ値を読む他の経路: `lastSessionId` は新設で、読むのは再接続の同期だけ。usage の更新（`refreshOpencodeV2UsageOnFrame`）は今どおりフレームの session id を読む（変えない）。
- ［未確認］サーバー（2.0.18）に「最新の session」を一覧で引ける API があるか。あれば reattach 直後（`lastSessionId` が null）の穴も塞げるが、今回は入れない（§5）。

**記録されないことを見せる（C / C' / D）**

- 既にあるもの［事実］: 起動時の warn `opencode-v2-launch-degraded-to-standalone`（`source.ts:120`）、自分で終わったときの warn `opencode-v2-subscription-ended`（`subscription.ts:231`）、agent-health の不合格（`server-events.ts:101-115`）。
- 足すもの（実装の契約）: なし、を推す。［見立て］History に「記録されない」行を書く案は、行の種類・i18n・表示の設計が要り、劣化モードのためだけに入れる重さに見合わない。代わりに docs（`docs/user-guide/` の OpenCode V2 の節、ja/en）に「`--standalone` で起動したとき・購読が終わったときは返信が History に残らない。ターミナルとチャット面の画面には出る」を書く。候補は `docs/user-guide/opencode-v2.md`（`standalone` の語が既にある。en 版の有無は実装時に確かめる）。

### 2.3 状態の遷移（決定後）

```
           open                connect ok                stream ends
 (none) ─────────▶ unknown ─────────────────▶ live ─────────────────▶ lost
                     │                          ▲                      │
                     │                          │  reconnect ok        │
                     │                          └──────────────────────┘
                     │                             + lastSessionId があれば 1 回同期（新）
                     │ port null（standalone）
                     ▼
             購読なし（unknown のまま）── 返信は記録しない（仕様）
 lost ── password 無し / port の持ち主が変わった ──▶ ended（endedLiveness、lost）── 記録しない
```

画面の読み取り（poller）は、どの状態でも V2 の返信を保存しない（`isTurnComplete` が false）。`live` の間は今までどおり `structured-history-scrape-suppressed` にも到達しない（完了しないので）。

---

## 3. 退けた案（B 案: 画面で保存する）と、その場合に要るもの

B 案を採るなら、次を全部満たす必要がある。どれかが欠けると、壊れ方は「History の行が 2 本」「返信の頭が欠ける」で、どちらも黙って起きる。

1. **live でない状態の区別**（§1.4）: A/B では保存せず、C/C'/D だけ保存する。`liveness` では区別できないので、起動の形（`--standalone` か）を session ごとに記録し、poller が読める場所に置く必要がある。［見立て］A' の穴は画面で埋められるが、その後の送信で同期が `oc-turn:` の行を書くので 2 行になる。画面の行に V2 の user message id を付ける方法は画面から読めない（［事実］画面には id が出ない。`grep -lE 'msg_|ses_' tests/fixtures/opencode-v2-live-4175/*.txt` は 0 件）。
2. 問題 1: `resolveExtractionStartIndex`（`response-extractor.ts:215`）に V2 を足し、`findRecentUserPromptIndexInFrame`（`response-checker-extraction-steps.ts:123`）に V2 の echo（`┃  <text>` の gutter）を読む分岐を足す。cursor は内容の重複検出（`isDuplicateResponse`、`response-dedup.ts:150`）に頼るので、初回と 2 回目で本文が変わらないことが条件。
3. 問題 2: echo の境界を、本文が引用した完了行（`Build · … · 28.9s`）や tool の枠で取り違えない読み方。#4184 で試した「前のターンの完了行・最初の gutter のブロック」は `quote-footer-done.txt` の形に負ける。［見立て］位置（列・SGR）で読む必要があり、V1 の `resolveOpenCodeTurnRegion` を流用できるかは未確認。
4. 問題 3: 蓄積（`response-checker.ts:747`）と `openCodeCleanLines`（`:500`）と `cleanCompletedResponse`（`:1095`）に V2 を足し、`turnHeadTruncated` を返す。`long-done.txt` は echo が画面の外に出た実測なので、頭の欠けを必ず通る。

この重さに対して得られるのは C/C'/D の返信だけで、どれも本番の既定では起きない劣化モードなので、A 案を採る。

---

## 4. 実装の範囲（次の契約）

| ファイル | 変更 | 根拠 |
|---|---|---|
| `src/lib/hooks/sources/opencode-v2/subscription.ts:82-93` | `SubscriptionState.lastSessionId` を足す | §2.2 |
| `src/lib/hooks/sources/opencode-v2/subscription.ts:439-453` | `deliver` で `lastSessionId` を更新 | §2.2 |
| `src/lib/hooks/sources/opencode-v2/subscription.ts:288-350` | 再接続（2 回目以降の `markAlive`）の後に 1 回同期 | §2.2 |
| `src/lib/response-extractor.ts:208-218` | コメントだけ（V2 を入れない理由、#4187） | §2.1 |
| `src/lib/polling/response-checker.ts:745-755` | コメントだけ（V2 を蓄積しない理由、#4187） | §2.1 |
| `src/lib/polling/response-checker-extraction-steps.ts:83-91` | コメントに #4187 の決定を参照で足す | §2.1 |
| `docs/user-guide/opencode-v2.md`（と en 版があればそれも） | `--standalone` と購読が終わったときは返信が History に残らない | §2.2 |
| `changelog.d/4187.md` | 1 エントリ（`<!-- ### Added -->`） | 契約 |

scope の外（直さない）: `src/lib/cli-tools/types.ts`（V2 は既に alternate screen）、`history.ts`（同期の中身は変えない）、poller の保存の経路。

---

## 5. 確かめるテスト（陽性と陰性）

置き場所は既存の `tests/unit/hooks/sources/opencode-v2/subscription.test.ts`（または `history.test.ts`）に倣い、新しいファイルを足す（例 `subscription-reconnect-sync-4187.test.ts`）。サーバーは既存のテストと同じく fetch のモックで、DB は既存の history のテストの作り方に合わせる。

### 5.1 再接続時の同期

| # | 種類 | 手順 | 期待 |
|---|---|---|---|
| R1 | 陽性（直す前に落ちる） | live で session `ses_A` のフレームを受ける → ストリームが切れる（`lost`）→ 切れている間に `ses_A` のターン 2 が閉じる（文書にだけある）→ 再接続（`live`）、その後フレームは来ない | ターン 2 の `oc-turn:` の行が 1 本書かれる（直す前は 0 本） |
| R2 | 陰性（二重にならない） | R1 の後、`ses_A` のターン終了フレームが来て通常の同期が走る | 行は増えない（ターン 1・2 とも 1 本ずつ） |
| R3 | 陰性 | 初回の接続（`unknown` → `live`） | 再接続の同期は呼ばれない（フレームによる同期だけ） |
| R4 | 陰性 | 再接続したが、その購読で session id を持つフレームを一度も受けていない（`lastSessionId` が null） | 文書を読まない（fetch 0 回） |
| R5 | 陰性（寿命） | `closeOpencodeV2Subscription` → 同じ target で開き直し → 切断 → 再接続 | 前の購読の `lastSessionId` を使わない（fetch 0 回） |
| R6 | 陰性（session の切り替え） | `ses_A` のフレーム → `ses_B` のフレーム → 切断 → 再接続 | 読むのは `ses_B` だけ |
| R7 | 陰性（購読の入れ替わり） | 再接続の同期の読みの最中に購読を閉じる | 行は書かれる・model の latch はしない（`isCurrent`、#3733 と同じ） |

### 5.2 画面の読み取りが V2 を保存しない（poller の層で固定）

既存の固定は `extractResponse` の層（`pattern-anchors-4175.test.ts:136`）だけなので、`checkForResponse` の層で 1 本足す。実測の画面を使う。

| # | 種類 | 画面 | liveness | 期待 |
|---|---|---|---|---|
| S1 | 陰性 | `tests/fixtures/opencode-v2-live-4175/long-done.txt`（echo が画面の外） | `lost` | `createMessage` 0 回・保留（pending scrape）0 件 |
| S2 | 陰性 | `quote-footer-done.txt`（本文が footer を引用） | `unknown`（standalone） | 同上 |
| S3 | 陰性 | `interrupted.txt` | `lost` | 同上 |
| S4 | 陰性 | `idle-after-turn.txt`（タブ行が先頭、echo なし） | `unknown` | 同上 |
| S5 | 陰性 | `tests/fixtures/opencode-v2-live-2945/turn-done-after-approval.txt`・`question-answered.txt`（tool の枠の画面） | `lost` | 同上 |
| S6 | 陰性（同じ画面の取り直し） | S1 の画面を cursor 0 → 行数で 2 回 | 任意 | 2 回とも 0 回 |

［見立て］S1〜S6 は今のコードで通る（陽性の対照は無い。仕様の固定）。陽性の対照を見せるには、一時的に `isTurnComplete` に V2 を入れたときに S1 が `createMessage` 1 回になることを、実装の契約の作業中に確かめてコミット本文に書く（ファイルは戻す）。

### 5.3 Issue の受入基準 2 の順（保存の件数と本文）について

受入基準 2（cursor=0 の初回 → 取り直し → 次のターン → live でない → live への復帰）は「保存するなら」の条件つきで、A 案では画面の保存は 0 件で一定。代わりに R1〜R6 が「live でない → live への復帰」の件数と本文（`oc-turn:` の行の `content` が文書の描画 `renderOpencodeTurn` と一致すること）を確かめる。

---

## 6. 未確認・残り

- ［未確認］V2 2.0.18 の文書 API で、閉じたターンの判定（`idle` の後）が、切断の間に終わったターンでも同じに見えるか。`tests/fixtures/opencode-v2-history-2940` は接続中の実測。
- ［未確認］reattach 直後（サーバー再起動の後、`lastSessionId` が null）の穴。session の一覧の API があれば塞げる。今回は入れない。
- ［未確認］relay（`src/lib/relay/relay-bound-reply.ts:144` の `'opencode-v2': true`）が、live でない間の V2 の返信をどう待つか。画面で完了しないので relay の完了の知らせは構造化の経路だけ［見立て］。この設計では変えない。
- ［見立て］C' の状態（port あり・launch.sh 欠け）で購読が `lost` を繰り返すのは、`probeOpencodeV2Server` が `unreachable` を返し続けるため。実機では見ていない。
