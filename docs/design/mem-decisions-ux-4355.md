# 決定の画面を「リポジトリ → ブランチ」で選べるようにし、スマホ・PC の操作を直し、決定を読む CLI を足す（Issue #4355）設計

- 段: 設計（この文書だけ）。コードは書かない。実装は PM の確認と事前レビュー（2-4-4）の後、§6 の PR ごとに別の契約で行う
- 基準: develop `10232442d`（2026-11-13）。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4355 の本文（直すこと 1〜5・受入条件）。上流の 4 つ（`docs/orchestrate/team.md` §6 の 1〜4）は §2・§4・§5・§6
- 関連: #4354（承認の導線: 承認待ちの件数・行き先の必須化・二重の検知）、#4225（決定の画面。設計 `docs/design/mem-promote-4225.md`）、#4353、#4220

## 0. この契約での決定と止める点

### 0.1 決定（PM、この設計の契約）

| 項目 | 決定 |
|---|---|
| 書くもの | この設計書だけ。コードは書かない |
| CLI の読み | `commandmate mem decisions`（一覧・状態・行き先・引用・作成者・承認の有無）と 1 件の差分を読む口は、**先に入れてよい**（PR1） |
| CLI の承認 | 今の安全の前提「エージェントは人の決定を作れない（画面だけ・`screen_only`）」を崩す。入れるなら **TTY での対話の確認を必須**にする案（非対話＝パイプ・エージェントの実行では断る、引用を打ち返す等）を §3.5 に書き、**事前レビュー（2-4-4）で安全を見てから入れるかを決める**。この設計では入れると決めない |
| PR の分け方 | PR1 読みの CLI ／ PR2 画面のリポジトリ → ブランチの選択と PC の件数・畳み ／ PR3 スマホのカード・シート・4 手の流れ（e2e 390・1280）／ 承認の CLI は 2-4-4 の後（§6） |
| 試験 | 各 PR は直す前に赤の試験を置く。UI の PR（PR2・PR3）は e2e を契約に入れ、`--last` でマージする |

### 0.2 止める点

なし。ただし次の 2 つは 2-4-4 の答えを待つ（§9）。

1. CLI の承認を入れるか（§3.5 の案 A・B・C）
2. 承認待ちの件数を #4354 と同じ関数で数えるとき、どちらの PR が先にその関数を作るか（§3.1.3）

## 1. 今の作り（事実）と Issue 本文との照合

### 1.1 画面の上部（事実）

- ページは `src/app/repositories/[id]/mem/decisions/page.tsx`。リポジトリはパスの `[id]` で決まり（`:19`）、ブランチは `?branch=` で決まる（`:20`）。上部はブランチ名の**文字入力**（`:34-42`、`data-testid="decision-branch-input"`）と「表示」ボタン（`:43-45`）で、送ると `router.push` で同じ形の URL へ行く（`:27-33`）。リポジトリを画面から選ぶ口は無い（Issue 本文どおり）
- ブランチが空なら下の部品を出さない（`:47`）。見出しは `mem.decisions.title`（「決定の記録（{branch}）」、`:26`）
- 入口は 2 つ: リポジトリの mem の設定（`src/components/mem/RepositoryMemSettings.tsx:156`、**`?branch=` なし**で開く＝ブランチ名を手で打たないと何も出ない）と、作業木の mem の欄（`src/components/mem/MemItemsPanel.tsx:931`、`?branch=` つき）

### 1.2 決定の一覧と承認の手順（事実）

- 部品は `src/components/mem/DecisionPromotePanel.tsx`。作業木の select（`:264-278`）の下に、決定を 1 件 1 枠の `<li>` で並べる（`:280-384`）。件数・承認待ちの数・状態の絞り込みは無い。承認済み（`recorded`）・反映済み（`promoted`）も open と同じ並びに同じ大きさで出る（一覧は `closed` だけを除く: `src/lib/promote/service.ts:1091`）
- 1 件の承認は、Issue 本文の「4 手」より実際は **5 手**: ①項目の「差分を作る」（`:298-308`。中身は選択の切り替えで、差分はまだ作らない）→ ②効果の select（`:322-328`）→ ③引用の確認のチェック（`:337-340`、引用があるときだけ）→ ④もう一度「差分を作る」（`:343-345`）→ ⑤「承認して書く」（`:363-373`）。①と④は**同じ文言**（`mem.decisions.makePreview`＝「差分を作る」）で、押す前に区別できない［事実。食い違いとして記録］
- 差分は一覧の中に展開され（`:346-379`）、本文は `max-h-80 overflow-auto` の `<pre>`（`:357`）で、ページのスクロールの中にもう一段のスクロールがある。照合で見つけた本文も `max-h-60 overflow-auto`（`:180`・`:186`）
- 文字はすべて `text-xs`、ボタンは `size="sm"`（`:197`・`:299`・`:343`・`:363` ほか）。ページは `max-w-3xl p-4`（`page.tsx:25`）
- 選んだものが変わると差分を捨てる（`:59-67`。#4225 の PM レビュー P2・P3-1）。承認は画面が見た preview を送り返すだけ（`:366-370`）

### 1.3 サイドバー（事実。Issue 本文と一部食い違う）

- Issue 本文は「サイドバー（ブランチの一覧）が左に常にあり、スマホでは本文が狭い」。実コードでは、幅 768px 未満（`src/hooks/useIsMobile.ts:36` の `MOBILE_BREAKPOINT`）は `AppShell` の携帯の分岐（`src/components/layout/AppShell.tsx:199`）で、サイドバーは**閉じた引き出し**（`:227` の `-translate-x-full`）。390 幅で左に常駐はしない
- 768px 以上（タブレット横・PC）では左に常駐する（`:278`）
- 見立て: スマホで「狭い・操作しにくい」の主因はサイドバーではなく、`text-xs` と `size="sm"` の小さな押し場所、入れ子のスクロール（§1.2）、上から下へ一度に並ばない手順（①を押してから下に開く欄で②〜⑤）。未確認: 390 幅で横スクロールが出るか（PR3 の赤の e2e で実測する。§7）
- 判断: Issue の「サイドバーを畳んだ状態で使える」は、768 未満では既に満たす。768 以上では既存の畳み（`SidebarRail`、Mod+B）で使えることを PR2 の e2e（1280）で確かめるだけにし、新しい畳みは作らない

### 1.4 API（事実）

| API | 印（`screen_only`） | 書くもの |
|---|---|---|
| `GET /api/repositories/:id/mem/decisions?branch=`（`src/app/api/repositories/[id]/mem/decisions/route.ts:13-23`） | 要らない | 無し。`branch` が無いと 400 `invalid_request`（`:16`） |
| `POST …/:itemId/preview`（`src/lib/promote/service.ts:424`） | 要る | **preview の行を DB に作る**（`insertPromotePreview`、`:545`）。行き先が Issue なら `gh` で投稿者を読む（`:457-467`） |
| `POST …/:itemId/approve`・`confirm-reflected`・`operations/:opId/{reconcile,abandon,accept-found,settle-transition}` | 要る（`:570`・`:771`・`:830`・`:923`・`:952`・`:988`） | 外への書き込み・状態の遷移 |

- 印は `isScreenRequest`（`src/lib/security/screen-request.ts:52`）。`X-CommandMate-Client: screen` と `Origin` の一致で、**検査であって保証ではない**（同ファイル冒頭の説明、`docs/design/mem-promote-4225.md` §4.2 の「防げないこと」）
- 本文の描画は `renderPromoteBody`（`src/lib/promote/render.ts:76`）。入力は operation の id・項目・効果・作者・引用で、行き先の今の中身（基準の指紋）は描画に使わない［事実: `service.ts:504-515` の呼び出しの引数］

### 1.5 CLI（事実）

- `commandmate mem` のサブコマンドは now（`src/cli/commands/mem.ts:398`）・add（`:418`）・update（`:468`）・close（`:499`）・list（`:514`）・check（`:544`）・mode（`:578`）・purge（`:602`）。決定の一覧（状態・行き先・承認の有無）と差分を読む口は無い（Issue 本文どおり）
- 読みのサブコマンドは `--worktree`・`--json`・`--token` と、作業木が無いときの `--repository <id>`（＋`--branch`）を持つ（`withTargetOptions`、`:223-231`）。`mem list` は `GET` で読んで `--json` なら応答をそのまま出す（`:519-532`）
- ガード `tests/unit/guards/mem-promote-screen-only-4225.test.ts:24-31` が、`src/cli/**` に「`mem/decisions` と書き込みのメソッドが同居」「`promote|approve|confirm-reflected|reconcile` で始まるサブコマンド」「`X-CommandMate-Client` の名」のどれかがあれば落とす。**`GET` での読みは許す**（陰性対照 `:41-44`）
- skill（`.claude/skills/cmate-handoff-dev/SKILL.md:134`・`:162`）は「CLI に promote・approve の口は無い」「承認は人が画面で行う」と書く。利用者向けの文書は `docs/user-guide/cli-operations-guide.md:3728`（「決定を正本へ記録する（画面だけ、Issue #4225）」）と en の同じ節

### 1.6 試験が固定している今の動き（事実）

- `tests/unit/components/mem/DecisionPromotePanel-4225.test.tsx` が部品の操作（選択・差分・承認・照合の各ボタン）を固定している。PR3 で手順の並びを変えると、この試験のうち押す順・文言で探す箇所が変わる。既存の `it` は消さず名前も変えない。期待値を変える必要が出たら、変えずに PM へ伺う（§8.3）
- e2e に決定の画面を開くものは無い（`git grep 'decision-branch-input\|mem/decisions' -- tests/e2e` は 0 件、2026-11-13）

## 2. 不変条件

PR1〜PR3 のどれも、次を崩さない。各 PR の試験はこの表のどれを守るかを名指しする。

| # | 不変条件 | なぜ | 固定する試験 |
|---|---|---|---|
| I1 | 人の承認・反映の確認・照合の処分は、印のある要求でしか起きない。CLI は `mem/decisions` の書き込みの route を呼ばず、印の名を持たない | エージェントが人の決定を作れないことが mem の安全の前提（#4225 D9） | 既存ガード `mem-promote-screen-only-4225.test.ts`（変えない。案 A を採るときだけ 2-4-4 の後に別の PR で変える） |
| I2 | 読みの CLI と読みの API は DB に何も書かない（preview の行も作らない）、外（`gh`・作業木）にも書かない | 承認できる preview を作るのは画面の操作だけ。読みが preview を作ると、印の無い経路が承認の材料を生む | PR1 の route 試験: 呼ぶ前後で `mem_promote_previews` の行数と全テーブルの行数が同じ |
| I3 | 承認されるのは画面が見せた preview そのもの。選択（項目・作業木・効果・引用の確認）が変われば preview を捨てる | #4225 の PM レビュー P2・P3-1 | 既存 `DecisionPromotePanel-4225.test.tsx` の P2・P3-1 の試験を PR3 でも緑のまま通す |
| I4 | URL は `/repositories/<id>/mem/decisions?branch=<name>` の形を保つ。`branch` が無い URL も開ける | 既存のリンク（§1.1 の 2 つの入口・Issue のコメント・mem の促し）の互換 | PR2 の page 試験: 既存の形の URL で、そのリポジトリ・ブランチが選ばれた状態で開く |
| I5 | 秘密に見える本文（`secret_like`）は CLI でも画面と同じく差し止める | 読みの口が差し止めの抜け道にならない | PR1 の diff route 試験 |
| I6 | 「承認待ち」の数え方は 1 つ（`decision` かつ `state === 'open'`）で、画面の select・PC の件数・CLI・#4354 の件数が同じ関数を使う | 画面ごとに数が違うと、人が「承認し終えた」と誤る | PR2 の関数の表試験＋CLI の試験で同じ fixture を使う |
| I7 | `mem decisions --json` の形は `schema: 1` のキーを消さない・型を変えない（足すのは可） | エージェントが読む形が黙って変わらない | PR1 のゴールデン試験（キーの集合と型） |

## 3. 設計

### 3.1 リポジトリ → ブランチの順に選ぶ（PR2）

#### 3.1.1 画面の上部

- 文字入力（§1.1）を、**リポジトリの select → ブランチの select** に替える
  - リポジトリの select: 既存の `GET /api/repositories`（`src/app/api/repositories/route.ts:51`）の一覧。選び直すと `router.push('/repositories/<新しい id>/mem/decisions')`（ブランチは外す。別のリポジトリに同名があっても持ち越さない［見立て: 持ち越すと違うリポジトリの決定を同じものと読み違える］）
  - ブランチの select: 新しい読みの API（§3.1.2）が返す、そのリポジトリのブランチ。mode が `on` のものを上に、各行に承認待ちの件数（`(3)` の形）。選ぶと `?branch=` を付けた同じ形の URL へ（I4）
  - URL の `branch` が一覧に無い（mode が `on` でない・作業木が消えた）ときも、その名前を select の先頭に「（mem が on でない）」の印つきで出して選ばれた状態にする。古いリンクで開いた人が何も見えなくならないため（I4）
- 文字入力は残さない［見立て: 一覧に無いブランチは上の印つきの行で開ける。手で打つ口は打ち間違いで空の画面を出すだけだった（§1.1 の設定からの入口）］

#### 3.1.2 新しい読みの API

`GET /api/repositories/:id/mem/decisions/branches`（印は要らない。読みだけ）

```json
{ "ok": true, "branches": [ { "branch": "develop", "mode": "on", "pending": 3, "recorded": 1 } ] }
```

- ブランチの集合は「そのリポジトリ（同じ Git の root の範囲）の作業木のブランチ」と「`decision` の項目を持つブランチ」の和［見立て: 作業木が消えても承認待ちの決定は残るので、作業木だけでは足りない］
- mode は既存の `decideMemTarget`（`service.ts:1072` が使うもの）で 1 本ずつ決める。`ambiguous` はそのまま返す（承認はできないが照合は出す、#4225 5-2c P2-1）
- `pending`＝I6 の数え方、`recorded`＝`state === 'recorded'`（承認済みで未反映）

#### 3.1.3 #4354 との関係

#4354 の「承認待ちの決定 N 件」をヘッダー・サイドバーに出す件は、全リポジトリの合計で、この API とは別の入口になる。数え方（I6）は 1 つの関数（`countPendingDecisions` の名を仮置き、置き場所は `src/lib/promote/`）に置き、先にマージされる側が作り、後の側は使う。どちらが先かは PM が run の順で決める（§0.2 の 2）

### 3.2 PC（PR2）

- 一覧の上に「承認待ち N 件・反映待ち M 件」を 1 行で出す（`pending`・`recorded` と同じ数え方）
- `recorded`（反映待ち）と `promoted`（反映済み）は、それぞれ `<details>` に畳む。既定は閉じる。`open` は畳まない。不明・進行中の operation を持つ項目は、状態にかかわらず畳まない（照合を見落とさないため）
- 「承認待ちだけ」の切り替え（§3.3 と同じ部品）を PC にも置く

### 3.3 スマホ（PR3）

- 1 件 1 枚のカード。カードの中は上から次の順で、1 画面の縦の流れで終える（4 手）:
  1. 本文と、引用（あれば）。その下に「引用を原文と照らして確かめた」のチェック（押し場所 44px 以上）
  2. 効果（`spec`／`record_only`）を 2 つの大きなボタンの切り替えで（select をやめる）
  3. 「差分を作る」1 つ（§1.2 の①と④を 1 つにする。①はカードの展開で、文言を「この決定を確かめる」に分ける）→ 差分は**全画面のシート**で開く。シートの中だけがスクロールする（入れ子のスクロールを作らない）。行き先・投稿者・期限はシートの上端に固定
  4. シートの下端に固定の「承認して書く」「やめる」
- 「承認待ちだけ」の切り替えを一覧の上に置き、承認待ちが 1 件以上なら既定で入にする
- 文字は `text-sm` 以上、押し場所は 44×44px 以上［見立て: iOS の推奨の大きさ］
- シートは既存の `ui/Modal` を使う。背景のクリックで閉じない作りにする（記憶: ui/Modal の背景クリックは届かない・直し方を間違えやすい。承認のシートは「やめる」で閉じれば足り、背景で閉じる必要が無い）
- 横スクロールを出さない: 行き先・パス・引用は `break-all`／`break-words` を保ち、`<pre>` は `whitespace-pre-wrap`（既存の `:357` と同じ）

### 3.4 CLI（読み、PR1）

#### 3.4.1 一覧

```
commandmate mem decisions [--worktree <id> | --repository <id> --branch <name>] [--pending] [--json] [--token <t>]
```

- 既存の `GET /api/repositories/:id/mem/decisions?branch=` を読む（新しい route は要らない）。`--worktree`（既定は自分のセッション）のときは作業木からリポジトリとブランチを解く（`mem list` と同じ `readTarget`、`mem.ts:520`）
- 文字の出力は 1 件 1 行: `<id> <state> v<version> approved=<yes|no> by=<agent|human>(<instanceId>) to=<promoteTo|-> quote=<"…"(先頭 40 文字)|-> ops=<operation の state の列>`。最後に `pending: N  recorded: M`
- 「承認の有無」は `approved = state が recorded か promoted、または succeeded の operation がある`
- `--json` は応答をそのまま出さず、`schema: 1` の形に写す（I7）:

```json
{
  "schema": 1, "repositoryId": "…", "branch": "…", "mode": "on",
  "counts": { "pending": 1, "recorded": 0 },
  "decisions": [ { "id": "…", "state": "open", "version": 2, "approved": false,
    "promoteTo": "issue:#4355", "quote": "…", "quoteAt": "…", "createdBy": "agent",
    "author": { "instanceId": "claude", "worktreeId": "…" }, "withheld": null,
    "operations": [ { "id": "…", "state": "succeeded", "effect": "spec", "destination": { }, "decidedBy": "server", "approvedAt": "…", "settledAt": "…" } ] } ],
  "unresolved": [ ]
}
```

- `withheld` のある項目は本文・引用を出さない（I5。`MemItemView` の既存の差し止めの形をそのまま写す）

#### 3.4.2 1 件の差分

```
commandmate mem decisions <itemId> [--effect spec|record_only] [--json]
```

- 新しい読みの route `GET /api/repositories/:id/mem/decisions/:itemId/diff?effect=` を作る（印は要らない）。`renderPromoteBody`（§1.4）で本文を描画するが、**preview の行を作らない・`gh` を呼ばない・承認に使える id を返さない**（I2）。operation の id の欄は空の印で描く［見立て: 承認の差分と見分けられ、承認に流用できない］
- 返すもの: 行き先（解決後の形。`destinationText` と同じ規則、`DecisionPromotePanel.tsx:32-38`）・本文の全文・`invisibleReplaced`・`secret_like` の差し止め（I5）
- 投稿者（`poster`）は返さない（`gh` を呼ばないため）。画面の差分とは投稿者の行だけが違うことを出力の末尾に 1 行で書く
- サブコマンドの名は `decisions`。ガードの正規表現（`promote|approve|confirm-reflected|reconcile`）に当たらず、`GET` だけなので既存ガードは変えない（I1）

### 3.5 CLI（承認）— 入れるかは 2-4-4 の後に決める

今の前提: 「エージェントは決定を承認できない（画面だけ）」（§1.4・§1.5）。CLI に承認を足すと、この前提を「画面か、人の端末」に変える。どの案でも、印と同じく**検査であって保証ではない**（同じ OS 権限のプロセスは DB を直接書ける。#4225 §4.2 の「防げないこと」は変わらない）。問いは「エージェントがうっかり、または指示を誤読して承認する道を増やすか」。

| 案 | 中身 | エージェントの実行で起きること | 残る穴（見立て） |
|---|---|---|---|
| A: TTY の対話の承認 | `commandmate mem decisions <id> --approve`（サブコマンドにしない）。(1) `process.stdin.isTTY && process.stdout.isTTY` でなければ断る、(2) `CM_INSTANCE_ID`・`CM_AGENT_INSTANCE_ID`・`CM_WORKTREE_ID` のどれかが環境にあれば断る（CommandMate のセッションの中）、(3) 差分の全文を出し、引用の先頭 20 文字と画面に出した 4 桁の確認の語を人が打ち返す、(4) サーバ側は新しい印（端末の承認）を受ける route を別に作り、1 回限りの確認の語をサーバが発行して照合する | パイプ・Bash の道具の実行は (1) で、セッションの中の端末は (2) で断られる | `script`・`expect` で疑似端末を作り環境変数を消せば通る。印の偽造（`curl`）と同じ水準の意図が要るが、`--help` に載ることで道が見つけやすくなる |
| B: 画面へ渡す口だけ | 承認はしない。`mem decisions <id>` の出力の末尾に、その項目へ直接開く URL（`?branch=<name>&item=<id>`）を出す。`--qr` で端末に QR | 何も承認しない | 無し（今の前提のまま） |
| C: 何も足さない | — | — | 無し |

- 推奨（見立て）: **B を PR1 に入れ、A は入れない**。人の要望の「スマホから操作しにくい」は PR3 で画面の側を直すのが本筋で、端末の承認が要る場面（画面を開けない）は報告されていない。A を採るなら、ガード `mem-promote-screen-only-4225.test.ts` の変更（`--approve` を許す例外）と skill の第 5 節・利用者向け文書の書き換えが同じ PR に要る
- A を採ると決まったときの試験（Issue の受入条件）: 非 TTY（`stdin` がパイプ）・`stdout` がパイプ・`CM_INSTANCE_ID` あり・`CM_AGENT_INSTANCE_ID` あり・確認の語の不一致・引用の不一致の 6 つで、**サーバへ何も送らずに**断る（送った要求の数が 0）。陽性対照は 6 つとも満たした疑似端末で承認の route が 1 回呼ばれること
- 2-4-4 で見てほしい点は §9

## 4. return・throw・書き込みの表

### 4.1 `GET …/mem/decisions/branches`（PR2）

| 入力・状態 | 応答 | 書き込み |
|---|---|---|
| リポジトリが無い | 404 `not_found` | 無し |
| root の membership が定まらない（`MembershipUnsettledError`） | 404 `not_found`（`reason: ambiguous`。`promoteList` の `:1117` と同じ） | 無し |
| ブランチ 0 本 | 200 `branches: []` | 無し |
| あるブランチの mode が `ambiguous` | 200（その行は `mode: 'ambiguous'`、`pending` は数えない＝0） | 無し |
| DB の読みで例外 | 500（`memInternalError`、既存の route と同じ） | 無し（ログだけ） |

### 4.2 `GET …/mem/decisions/:itemId/diff`（PR1）

| 入力・状態 | 応答 | 書き込み |
|---|---|---|
| 項目が無い・別のリポジトリ・`decision` でない | 404 `not_found` | 無し |
| `effect` が `spec`・`record_only` 以外 | 400 `invalid_request`（`field: effect`） | 無し |
| 項目が `open` 以外 | 200（本文は描くが `approvable: false` を付ける） | 無し |
| 行き先（`promoteTo`）が無い | 200（`destination: null`、本文だけ） | 無し |
| 本文か引用が `secret_like` | 422 `secret_like`（preview と同じ） | 無し |
| mode が `on` でない | 200（`mode` を返す。描画は止めない［見立て: 読みは mode に依らない、`mem list` と同じ］） | 無し |
| 例外 | 500 | 無し |

### 4.3 `commandmate mem decisions`（PR1）

| 入力・状態 | exit | 出力 |
|---|---|---|
| 正常 | 0 | 一覧／`--json` |
| `--repository` だけで `--branch` が無い | 既存の `usage` の exit（`target_required`、`mem.ts:136`） | stderr に 1 行 |
| サーバが 404 | 既存の mem の `not_found` の exit | stderr |
| サーバに繋がらない | 既存の接続失敗の exit | stderr |
| `<itemId>` と `--pending` を同時に | `invalid_request` | stderr |

### 4.4 画面の承認の流れ（PR3。書くのは既存の API だけ）

| 操作 | 呼ぶ API | 書き込み |
|---|---|---|
| カードを開く・引用の確認・効果の切り替え | 無し | 無し（preview を捨てるだけ、I3） |
| 「差分を作る」 | `POST …/preview`（既存） | preview の行（既存どおり） |
| シートの「承認して書く」 | `POST …/approve`（既存） | 既存どおり |
| シートの「やめる」・シートを閉じる | 無し | 無し（preview を捨てる） |

## 5. 入力×状態の表（画面）

mode・項目の状態・行き先・引用の組み合わせで、カード（スマホ）と行（PC）が出すもの。operation が不明・進行中のときは、どの行でも照合の操作を出し、畳まない（§3.2）。

| mode | 状態 | 行き先 | 引用 | 承認待ちに数える | 既定の表示 | 出す操作 |
|---|---|---|---|---|---|---|
| `on` | `open` | 有 | 有 | 数える | 開く | 引用の確認 → 効果 → 差分を作る → 承認して書く |
| `on` | `open` | 有 | 無 | 数える | 開く | 効果 → 差分を作る → 承認して書く（引用の確認を出さない） |
| `on` | `open` | 無 | 有／無 | 数える | 開く | 差分を作るを押せない（既存 `:343` の `!item.promoteTo`）。「行き先がありません」と出す（#4354 の 2 で作成時に防ぐ） |
| `on` | `recorded` | — | — | 数えない（反映待ちに数える） | 畳む | 正本へ反映したことを確かめた |
| `on` | `promoted` | — | — | 数えない | 畳む | 無し |
| `off`／`derived` | どれでも | — | — | 数えない | 開く | 既存どおり（`modeNotOn` の警告、`DecisionPromotePanel.tsx:258-262`）。承認の route はサーバが断る |
| `ambiguous` | — | — | — | 数えない | — | 一覧は空、照合待ちだけ（既存 `:253-256`・`:385-403`） |

## 6. PR の分け方

`docs/orchestrate/team.md` §6 の 3（危険の境目で分ける）に従い、読みの CLI と画面を分け、承認の CLI は別にする。各 PR は**直す前に赤の試験**を置いてから直す。

| PR | 中身 | 赤の試験（先に置く） | 主な不変条件 | ゲート |
|---|---|---|---|---|
| PR1 読みの CLI | `mem decisions`（一覧・`--json` の `schema: 1`）、`<itemId>` の差分、diff の route、案 B の URL（2-4-4 で B が採られたとき） | CLI の一覧の文字・`--json` のゴールデン、diff の route の §4.2 の表、DB の行数が変わらない試験、ガードは既存のまま緑 | I1・I2・I5・I7 | lint・tsc・unit（`tests/unit/guards` を含む） |
| PR2 画面の選択と PC | リポジトリ → ブランチの select、branches の route、件数、`recorded`・`promoted` の畳み、「承認待ちだけ」 | page の試験（既存の URL で選ばれた状態で開く、I4）、branches の route の §4.1 の表、数え方の関数の表（I6）、e2e 1280（件数が見える・承認まで） | I3・I4・I6 | 上に加え **e2e を契約に入れる**。マージは `--last` |
| PR3 スマホ | カード・全画面のシート・4 手・押し場所・文言の分離 | e2e 390（リポジトリ → ブランチ → 承認待ちの 1 件を、`scrollWidth <= clientWidth` のまま承認まで）を先に赤で置く、既存 `DecisionPromotePanel-4225.test.tsx` の P2・P3-1 は緑のまま | I3 | 上に加え **e2e を契約に入れる**。マージは `--last` |
| （後）承認の CLI | §3.5 の案 A を採ると 2-4-4 で決まったときだけ | §3.5 の 6 つの断る試験と陽性対照 | I1 を書き換える | 2-4-4 の後に別の Issue |

- 並列: PR1 と PR2 は書くファイルが重ならない（PR1 は `src/cli/commands/mem*.ts`・新しい diff の route、PR2 は `page.tsx`・新しい branches の route・`DecisionPromotePanel.tsx` の上部）ので並列にできる。PR3 は PR2 と同じ `DecisionPromotePanel.tsx` を書くので PR2 の後
- e2e は既定（レイアウト・幅）に依存しない書き方にする（記憶: 既定・レイアウトを変える Issue は並行 PR の e2e を壊す）
- 利用者向けの文書（`docs/user-guide/cli-operations-guide.md:3728` と en）は、PR1 で `mem decisions` を、PR2・PR3 で画面の手順を、それぞれ同じ PR で ja・en の両方に書く

## 7. 試験の設計

- e2e（PR2・PR3）: 隔離したサーバ・DB（`CM_DB_PATH` を作業木の外の一時ディレクトリへ）で、mem が on のブランチに `decision` を 1 件（引用・行き先つき、行き先は作業木の文書）作る。390×844 と 1280×800 で、リポジトリの select → ブランチの select（件数が `(1)`）→ カード → 引用の確認 → 効果 → 差分を作る → 承認して書く。各段で `document.documentElement.scrollWidth <= clientWidth`（横スクロール無し）を確かめ、承認の後に件数が 0 になることを見る。ピンチ無しは viewport の `user-scalable` を変えないことと、押し場所の実寸（44px 以上）で確かめる
- 単体（PR1）: `mem decisions` の出力は fixture の応答から作る（作った文面でなく、PR1 の実装の前に隔離サーバで採った実際の応答を fixture にする。記憶: 実際の失敗を直す Issue は記録の出力でテストする）
- 対照: 陽性対照（直す前の実装で落ちる。例: PR2 の page 試験は今の文字入力の画面ではブランチの select が無く落ちる）と陰性対照（今の URL の形・P2・P3-1 の動きは変わらない）を各 PR に置く

## 8. 対になる場所・未確認・本文に無い指摘

### 8.1 対になる場所（探した結果）

- 画面の入口: §1.1 の 2 つ（`RepositoryMemSettings.tsx:156`・`MemItemsPanel.tsx:931`）。PR2 で `RepositoryMemSettings` の入口に `?branch=` を足す必要は無くなる（ブランチの select で選べる）。`MemItemsPanel` の入口は `?branch=` つきのまま（I4）
- CLI の型の写し: `src/cli/types/` に mem の決定の型は無い（`git grep -n 'Promote' -- src/cli` は 0 件、2026-11-13）。PR1 で `--json` の `schema: 1` の型を置く場所を決める（`src/cli/commands/mem` の隣が既存の形）
- 文書: ja `docs/user-guide/cli-operations-guide.md:3728` の節と en `docs/en/user-guide/cli-operations-guide.md` の同じ節。skill `.claude/skills/cmate-handoff-dev/SKILL.md` §5 と `.agents/skills/cmate-handoff-dev/SKILL.md`（写し）。読みの CLI は skill の「承認は画面」を変えないので、PR1 では skill に「一覧は `mem decisions` で読める」を 1 行足すだけ
- 古い動きを固定している試験: §1.6

### 8.2 未確認

- U1: 390 幅で今の画面に横スクロールが出るか（PR3 の赤の e2e で実測）
- U2: リポジトリの一覧に mem の無いリポジトリを出すか（見立て: 出すが、ブランチの select が空で「mem が on のブランチがありません」）
- U3: branches の route の重さ（ブランチごとに `decideMemTarget` を回す）。作業木が数十本のリポジトリで 1 秒を超えないか、PR2 で隔離サーバで測る

### 8.3 本文に無い指摘（この Issue では直さない）

- `src/components/mem/DecisionPromotePanel.tsx:306` と `:344`: 項目の選択と差分の作成が同じ文言「差分を作る」（§1.2）。PR3 で分ける
- `src/components/mem/RepositoryMemSettings.tsx:156`: 設定からの入口が `?branch=` なしで開き、ブランチを手で打つまで何も出ない（§1.1）。PR2 で解消する

## 9. 事前レビュー（2-4-4）で見てほしい点

1. §3.5 の案 A は、今の「エージェントは決定を承認できない」を実質で弱めるか。TTY・環境変数・打ち返しの組み合わせが、エージェントの誤読・うっかりの承認を防ぐのに足りるか。足りないなら B か C
2. 案 A のサーバ側の印（1 回限りの確認の語）は、画面の印と別に持つべきか、同じ `isScreenRequest` を広げるべきか（見立て: 別に持つ。画面の印を CLI が名指しするとガード I1 の意味が無くなる）
3. diff の route（§3.4.2）が印なしで本文を返すことは、`secret_like` の差し止めを保つ限り、`mem list` が本文を返すのと同じ水準か
4. `--json` を応答そのままでなく `schema: 1` に写すこと（I7）は、`mem list --json` の流儀（応答そのまま、`mem.ts:527-530`）と違う。揃えるべきか
