# 決定の画面を「リポジトリ → ブランチ」で選べるようにし、スマホ・PC の操作を直し、決定を読む CLI を足す（Issue #4355）設計

- 段: 設計（この文書だけ）。コードは書かない。実装は PM の確認の後、§6 の PR ごとに別の契約で行う
- 版: 第 4 版（2026-11-13）。第 4 版は作業木の Tools の mem（§11）を追加。第 2 版は事前レビュー（2-4-4、codex、設計 HEAD `e5e7739`）の反映（処置は §9）。第 3 版は CLI の承認を案 B に決定（人、2026-11-13）。履歴は §10
- 基準: develop `10232442d`（2026-11-13）。行番号はこの時点のもの。「事実」は file:line、「見立て」「未確認」は明記する
- 正: Issue #4355 の本文（直すこと 1〜5・受入条件）。上流の 4 つ（`docs/orchestrate/team.md` §6 の 1〜4）は §2・§4・§5・§6
- 関連: #4354（承認の導線: 承認待ちの件数・行き先の必須化・二重の検知）、#4225（決定の画面。設計 `docs/design/mem-promote-4225.md`）、#4353、#4220

## 0. この契約での決定と止める点

### 0.1 決定（PM、この設計の契約）

| 項目 | 決定 |
|---|---|
| 書くもの | この設計書だけ。コードは書かない |
| CLI の読み | `commandmate mem decisions`（一覧・状態・行き先・引用・作成者・承認の有無）と 1 件の差分を読む口は、**先に入れてよい**（PR1） |
| CLI の承認 | 今の安全の前提「エージェントは人の決定を作れない（画面だけ・`screen_only`）」を崩す。入れるなら **TTY での対話の確認を必須**にする案（非対話＝パイプ・エージェントの実行では断る、引用を打ち返す等）を §3.5 に書き、**事前レビュー（2-4-4）で安全を見てから入れるかを決める**とした。この設計では入れると決めない。2-4-4 の答え（§9）: 案 A は人の操作と区別できないので入れず、案 B（画面への案内だけ）を推奨。**案 B に決定（人、2026-11-13）**: CLI は読むだけ、承認は画面。案 A の実装はこの設計から外す。案 B の URL の出力は PR2 のマージの後に足す（§3.1.4） |
| PR の分け方 | PR1 読みの CLI ／ PR2 画面のリポジトリ → ブランチの選択と PC の件数・畳み ／ PR3 スマホのカード・シート・4 手の流れ（e2e 390・1280）／ PR4 作業木の Tools の mem（PC・スマホ、e2e 1280・390、§11。人の追加の要望 2026-11-13 16:2x）／ 承認の CLI は入れない（案 B、§3.5）（§6） |
| 試験 | 各 PR は直す前に赤の試験を置く。UI の PR（PR2・PR3）は e2e を契約に入れ、`--last` でマージする |

### 0.2 止める点

次の 2 つは PM・人の確認待ちだった（2-4-4 の答えは §9）。

1. CLI の承認を案 B（画面への案内だけ）にするか、C（何も足さない）にするか（§3.5）。案 A は外した。→ **案 B に決定（人、2026-11-13）**。CLI は読むだけで、承認は画面
2. 件数の共有関数の所有者。この設計の推奨は **PR1 が作る**（#4354 が PR1 より先にマージされたときだけ #4354 が作り、PR1 はそれを使う）。PR2 と #4354 の件数の表示は所有者の PR の後（§3.1.3・§6）

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
| I1 | 人の承認・反映の確認・照合の処分は、印のある要求でしか起きない。CLI は `mem/decisions` の書き込みの route を呼ばず、印の名を持たない | エージェントが人の決定を作れないことが mem の安全の前提（#4225 D9） | 既存ガード `mem-promote-screen-only-4225.test.ts`（変えない。案 A は外したので、この Issue で変える PR は無い） |
| I2 | 読みの CLI と読みの API は、成功でも失敗でも DB に何も書かない（preview の行を作らない・既存の行を UPDATE しない）、外（`gh`・作業木）にも書かない | 承認できる preview を作るのは画面の操作だけ。読みが preview を作ると、印の無い経路が承認の材料を生む | PR1 の route 試験: 呼ぶ前後で関係する表（`mem_items`・`mem_promote_previews`・`mem_promote_operations` ほか）の**行の内容と version** が同じ、書き込みの関数と `gh` の呼び出しが 0 回。**行数の比較だけでは UPDATE を検出できない**（2-4-4） |
| I3 | 承認されるのは画面が見せた preview そのもの。選択（項目・作業木・効果・引用の確認）が変われば preview を捨てる | #4225 の PM レビュー P2・P3-1 | 既存 `DecisionPromotePanel-4225.test.tsx` の P2・P3-1 の試験を PR3 でも緑のまま通す |
| I4 | URL は `/repositories/<id>/mem/decisions?branch=<name>` の形を保つ。`branch` が無い URL も開ける | 既存のリンク（§1.1 の 2 つの入口・Issue のコメント・mem の促し）の互換 | PR2 の page 試験: 既存の形の URL で、そのリポジトリ・ブランチが選ばれた状態で開く |
| I5 | 差し止めは項目全体で効く: 既存の `findWithheld`（`src/lib/mem/present.ts:69-80`。`text`・`quote`・`evidence`・`promoteTo`・`closeNote` を見る、`:60-67`）で 1 つでも当たれば、本文・引用・行き先のどれも返さない。加えて描画後の本文を `renderPromoteBody` の検査に通す | 読みの口が差し止めの抜け道にならない。本文・引用だけの検査だと、古い検査版で保存され今の規則に当たる行き先を diff が返してしまう（2-4-4 の 1） | PR1 の diff route 試験: 「本文は無害で、引用だけ／evidence だけ／行き先だけが今の規則に当たる」を 1 つずつ作り、どれでも本文・引用・行き先が返らない |
| I6 | 件数は **open の件数**（`decision` かつ `state === 'open'`）と **承認できるか**（mode が `on`）を分けて持つ。mode が `ambiguous` で数を確定できないときは 0 と断定せず「不明」を返す。画面の select・PC の件数・CLI・#4354 の件数が同じ 1 つの関数を使う | 同じ open の項目が CLI では 1 件、select では 0 件になる解釈を残さない（2-4-4 の 3）。画面ごとに数が違うと、人が「承認し終えた」と誤る | 所有者の PR（§3.1.3）の関数の表試験（mode `on`・`off`・`derived`・`ambiguous` × open の有無）。後続の PR は同じ fixture で同じ数を確かめる |
| I7 | `mem decisions --json` の形は `schema: 1` のキーを消さない・型を変えない（足すのは可）。`counts` は**絞り込み（`--pending`）の前**の数 | エージェントが読む形が黙って変わらない。件数が絞り込みの前後のどちらかを固定する（2-4-4 の 4） | PR1 のゴールデン試験（キーの集合と型、`--pending` の有無で `counts` が同じ） |
| I8 | 照合に要る状態を落とさない: operation の `state`・`transitionPending`・`transitionReason`・`concurrentEdit`・`unknownReason`・`decidedBy` を文字の出力と JSON の両方に出す。「人の承認の履歴」「外への書き込みの成功」「今の版の状態」を 1 つの真偽に畳まない | 外へは書けたが項目の遷移が版の競合で終わっていない状態（`succeeded`＋`transitionPending`）がある（既存の試験 `tests/unit/lib/promote/promote-entrances-4225.test.ts:648-660` の T18）。畳むと照合待ちを単なる成功に見せる（2-4-4 の 2） | PR1 の表試験: operation が `failed`・`unknown`・`succeeded`・`succeeded`＋`transitionPending` の 4 つで、文字の出力と JSON の両方を固定 |
| I9 | 絞り込み・畳み・mode の変更で、不明・進行中・遷移待ちの operation を持つ項目を隠さない（「承認待ちだけ」の絞り込みでも例外として出す） | 照合を見落とさない（2-4-4 の寿命・競合の表） | PR2 の page 試験 |

## 3. 設計

### 3.1 リポジトリ → ブランチの順に選ぶ（PR2）

#### 3.1.1 画面の上部

- 文字入力（§1.1）を、**リポジトリの select → ブランチの select** に替える
  - リポジトリの select: 既存の `GET /api/repositories`（`src/app/api/repositories/route.ts:51`）の一覧。選び直すと `router.push('/repositories/<新しい id>/mem/decisions')`（ブランチは外す。別のリポジトリに同名があっても持ち越さない［見立て: 持ち越すと違うリポジトリの決定を同じものと読み違える］）
  - ブランチの select: 新しい読みの API（§3.1.2）が返す、そのリポジトリのブランチ。mode が `on` のものを上に、各行に承認待ちの件数（§3.1.2 の表示の形。不明は 0 と出さない）。選ぶと `?branch=` を付けた同じ形の URL へ（I4）
  - URL の `branch` が一覧に無い（mode が `on` でない・作業木が消えた）ときも、その名前を select の先頭に「（mem が on でない）」の印つきで出して選ばれた状態にする。古いリンクで開いた人が何も見えなくならないため（I4）
- 文字入力は残さない［見立て: 一覧に無いブランチは上の印つきの行で開ける。手で打つ口は打ち間違いで空の画面を出すだけだった（§1.1 の設定からの入口）］
- 案 B（§3.5）の `?item=<id>` を読むのは PR2（§3.1.4）

#### 3.1.2 新しい読みの API

`GET /api/repositories/:id/mem/decisions/branches`（印は要らない。読みだけ）

```json
{ "ok": true, "branches": [ { "branch": "develop", "mode": "on", "approvable": true, "open": 3, "recorded": 1 },
                            { "branch": "feat/x", "mode": "ambiguous", "approvable": false, "open": null, "recorded": null } ] }
```

- ブランチの集合は「そのリポジトリ（同じ Git の root の範囲）の作業木のブランチ」と「`decision` の項目を持つブランチ」の和［見立て: 作業木が消えても承認待ちの決定は残るので、作業木だけでは足りない］
- mode は既存の `decideMemTarget`（`service.ts:1072` が使うもの）で 1 本ずつ決める
- 件数は §3.1.3 の共有関数で数える（I6）。`open`＝open の件数、`approvable`＝mode が `on`（承認できる）。`off`・`derived` は open の件数をそのまま返し `approvable: false`。`ambiguous` は root の間で数を確定できないので `open: null`（画面は「不明」と出し、0 と断定しない）
- 画面の select の行は `develop (承認待ち 3)`、承認できないブランチは `feat/y (open 2・承認できない: mode off)`、不明は `feat/x (件数不明: mode が root で食い違う)`

#### 3.1.3 件数の共有関数と #4354 との関係（所有者と依存）

- 関数: `summarizeDecisionCounts(db, repositoryId, branch) → { mode, approvable, open: number | null, recorded: number | null }`（名は仮置き、置き場所は `src/lib/promote/`）。数え方は I6 の 1 つだけ
- **所有者は PR1**（PR1 の `mem decisions` が `counts` を返すため。2-4-4 の 3）。ただし #4354 が PR1 より先に develop へマージされたときは #4354 が作り、PR1 はそれを使う。どちらになったかは PM が run の順で決め、後続の契約に書く
- 依存: PR2（ブランチの select と PC の件数）と #4354 の件数の表示（ヘッダー・サイドバーの全リポジトリの合計）は、**所有者の PR のマージの後**に始める。§6 の「PR1 と PR2 を並列にできる」は、この関数のファイルを PR2 が書かない限りで成り立つ（PR2 は所有者の PR の後に切る）

#### 3.1.4 `?item=<id>` で開く（PR2、案 B を採ったとき）

案 B は CLI がその項目へ直接開く URL を出す。今のページは `repositoryId` と `branch` しか読まない（`page.tsx:19-20`）ので、PR2 が `?item=` を読む。

| `?item=` の項目 | 画面の結果 |
|---|---|
| そのブランチの open の項目 | その項目の枠へスクロールし、カードを開いた状態にする。**引用の確認・効果の選択・差分の作成はしない**（開いただけで何も選ばない・作らない） |
| 「承認待ちだけ」の絞り込みで隠れる状態（`recorded`・`promoted`） | 絞り込みを外してその項目を出す（畳みも開く） |
| 別のブランチ・別のリポジトリの id | その項目を出さず「このブランチの決定ではありません」と出す（ブランチを勝手に切り替えない） |
| closed・削除済み | 「見つかりません（閉じたか削除されました）」と出す。照合待ちの operation があれば既存の照合待ちの欄（`DecisionPromotePanel.tsx:385-403`）に出る |
| withheld（I5） | 項目は差し止めの表示のまま出す（本文・引用・行き先を出さない） |

- URL の提供時期: PR1 の CLI の URL の出力は、PR2 のマージの後に足す（PR1 では出さない）。PR2 より前に出すと、開いても項目へ飛ばない URL になる

### 3.2 PC（PR2）

- 一覧の上に「承認待ち N 件・反映待ち M 件」を 1 行で出す（§3.1.3 の関数の `open`・`recorded`。`approvable: false` なら「承認できない（mode）」を添え、`null` なら「不明」）
- `recorded`（反映待ち）と `promoted`（反映済み）は、それぞれ `<details>` に畳む。既定は閉じる。`open` は畳まない
- 「承認待ちだけ」の切り替え（§3.3 と同じ部品）を PC にも置く
- I9: 不明・進行中・遷移待ち（`transitionPending`）の operation を持つ項目は、状態にかかわらず畳まず、「承認待ちだけ」の絞り込みでも隠さない。mode が変わっても同じ

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

- 既存の `GET /api/repositories/:id/mem/decisions?branch=` を読む（一覧の新しい route は要らない）。`--worktree`（既定は自分のセッション）のときは作業木からリポジトリとブランチを解く（`mem list` と同じ `readTarget`、`mem.ts:520`）
- **置き場所: 読みのモジュールを `mem.ts` から分ける**（例: `src/cli/commands/` の下の新しいファイル `mem-decisions.ts`。まだ無い）。既存ガード（`tests/unit/guards/mem-promote-screen-only-4225.test.ts:24-29`）は**ファイル全体**で「`mem/decisions` の文字列」と「書き込みのメソッド」の同居を見る。`mem.ts` は add などで `post` を持つので、`mem/decisions` の GET を `mem.ts` に足すとガードが落ちる。ガードは緩めない（2-4-4）
- 「承認」は 1 つの真偽に畳まない（I8）。項目ごとに次の 3 つを分けて出す:
  - `state`: 今の版の状態（`open`・`recorded`・`promoted`）
  - `humanApprovals`: 人が承認した回数＝その項目の operation の数（operation は画面の「承認して書く」でだけ作られ、`approvedAt` を持つ。外への書き込みの成否を問わない）
  - `operations[]`: 各 operation の `state`・`transitionPending`・`transitionReason`・`concurrentEdit`・`unknownReason`・`decidedBy`・`effect`・`destination`・`approvedAt`・`settledAt`（`PromoteOperationView` の照合用の欄を落とさない、`src/lib/promote/model.ts:122-137`）
- 文字の出力は 1 件 1 行の頭と、operation ごとの字下げの行:

```
<id> <state> v<version> by=<agent|human>(<instanceId>) to=<promoteTo|-> quote=<"…"(先頭 40 文字)|-> approvals=<N>
  op <opId> <state>[ pending-transition(<reason>)][ concurrent-edit][ unknown(<reason>)] decided-by=<server|human|-> effect=<spec|record_only>
counts (before --pending): open=<N|unknown> recorded=<M|unknown> approvable=<yes|no>
```

- `--json` は応答をそのまま出さず、`schema: 1` の形に写す（I7）:

```json
{
  "schema": 1, "repositoryId": "…", "branch": "…", "mode": "on",
  "counts": { "open": 1, "recorded": 0, "approvable": true },
  "decisions": [ { "id": "…", "state": "open", "version": 3, "humanApprovals": 1,
    "promoteTo": "issue:#4355", "quote": "…", "quoteAt": "…", "createdBy": "agent",
    "author": { "instanceId": "claude", "worktreeId": "…" }, "withheld": null,
    "operations": [ { "id": "…", "state": "succeeded", "transitionPending": true, "transitionReason": "version_conflict",
      "concurrentEdit": false, "unknownReason": null, "decidedBy": "server", "effect": "spec",
      "destination": { }, "approvedAt": "…", "settledAt": "…" } ] } ],
  "unresolved": [ ]
}
```

（例は T18 の状態: 人が承認し、外へは書けたが、項目の遷移が版の競合で終わっていない。`state: open` のまま `humanApprovals: 1`・`transitionPending: true`）

- `counts` は `--pending` の絞り込みの**前**の数（I7）。`--pending` は `state === 'open'` の項目に加え、I9 の照合待ちの operation を持つ項目も出す
- `withheld` のある項目は本文・引用・行き先・evidence を出さない（I5。`MemItemView` の既存の差し止めの形をそのまま写す）

#### 3.4.2 1 件の差分（参考の表示。承認に使えない）

```
commandmate mem decisions <itemId> [--worktree <id>] [--effect spec|record_only] [--json]
```

- 新しい読みの route `GET /api/repositories/:id/mem/decisions/:itemId/diff?worktreeId=&effect=`（印は要らない）。`renderPromoteBody`（§1.4）で本文を描画する
- **印なしの diff の安全条件**（2-4-4 の 3・1。どれか 1 つでも欠けたら印なしで出さない）:
  1. **リポジトリ所属の確認**: 項目の保存先が、`:id` のリポジトリの同じ Git の root の範囲（`readRepositoryIds`）に入っていること。入っていなければ 404 `not_found`（別のリポジトリの id で本文を読ませない）。`worktreeId` も同じ範囲の作業木であること
  2. **項目全体の差し止め**: 描画の前に `findWithheld`（I5）を通し、当たれば本文・引用・行き先・evidence をどれも返さない（422 `secret_like`、どの欄かの名前だけ）。描画の後の本文も `renderPromoteBody` の検査に通す
  3. **自由入力の安全な表示**: 本文・引用・行き先・パスは利用者や Agent が書いた文字。CLI は端末の制御文字（ESC・C0・C1、`\r`）を見える形（`\x1b` 等）に置き換えて出し、`--json` は JSON の文字列としてだけ出す。画面と同じく見えない文字は `invisibleReplaced` で知らせる
  4. **無書き込み**: I2。preview の行を作らない・既存の行を UPDATE しない・`gh` を呼ばない・作業木のファイルを読む以外に触らない
- **作業木の決め方**（2-4-4 の 4）: 行き先が作業木の文書のとき、文書のパスと HEAD は作業木で決まる（既存の preview は明示の `worktreeId` から解く、`service.ts:426-428`・`:474-486`）。
  - `--worktree <id>`（既定は自分のセッションの作業木）を route の `worktreeId` へ渡す
  - 作業木が渡されない（`--repository` で呼んだ）・その作業木の HEAD が項目のブランチと違う・detached のときは、本文は描くが `destination: { resolved: false, reason: "worktree_required" | "branch_changed" | "branch_unresolved" }` を返し、行き先を推測しない（同じリポジトリに作業木が複数あっても勝手に選ばない）
  - 行き先が Issue・PR のコメントなら作業木は要らない
- **承認の差分との違い**（参考の表示と明示する）: 出力の頭に `REFERENCE ONLY — cannot be approved; approve on the screen` を出し、JSON は `"approvable": false, "reference": true`。画面の preview とは次が違う:
  - operation の id（空の印で描く）と作成の時刻（描いた時刻）
  - 投稿者（`gh` を呼ばないので無い）
  - 引用の出所: 画面は人が確かめた引用を `human` として描く（`service.ts:437-443`）。CLI の GET はその確認を作らないので、引用は常に `agent`（未確認）として描く
  - 期限（preview の行を作らないので無い）
- サブコマンドの名は `decisions`。ガードの正規表現（`promote|approve|confirm-reflected|reconcile`）に当たらず、`GET` だけ（I1）

### 3.5 CLI（承認）— 案 B に決定（人、2026-11-13）

今の前提: 「エージェントは決定を承認できない（画面だけ）」（§1.4・§1.5）。どの案でも、画面の印と同じく**検査であって保証ではない**（同じ OS 権限のプロセスは DB を直接書ける。#4225 §4.2 の「防げないこと」は変わらない）。画面の印も、人の証明ではなく「通常の CLI に承認の口を持たせない」運用の境界である（`src/lib/security/screen-request.ts:3-10`）。

| 案 | 中身 | 判断（2-4-4） |
|---|---|---|
| A: TTY の対話の承認 | 非 TTY（パイプ・エージェントの実行）・セッションの環境変数で断り、引用と確認の語を打ち返させる | **入れない。この設計から外す。** エージェントは PTY を作り（`script`・`expect`）環境変数を消せるうえ、表示された確認の語と引用を同じプロセスが読んで打ち返せる。1 回限りの語は再利用を防いでも、人の操作とエージェントの操作を区別できない。別の印を足しても人の証明にはならない |
| B: 画面への案内だけ | 承認はしない。`mem decisions <id>` の出力の末尾に、その項目へ直接開く URL（`/repositories/<id>/mem/decisions?branch=<name>&item=<id>`）を出す。画面側は §3.1.4 | **採る（人、2026-11-13）**。今の前提を変えない。人の要望（スマホで操作しにくい）は PR3 で画面の側を直すのが本筋。URL の出力は PR2 のマージの後（PR1 では出さない） |
| C: 何も足さない | — | B が不要と PM・人が判断したとき |

- **案 B に決定（人、2026-11-13）**（§0.2）。B を採っても I1 と既存ガードは変えない。skill（`cmate-handoff-dev` 第 5 節）の「承認は人が画面で行う」も変えず、「`mem decisions <id>` が画面の URL を出す」を 1 行足すだけ
- Issue の受入条件「承認を CLI に入れる場合は、非対話では断られる試験がある」は、入れないので対象外。代わりに PR1 で、既存ガードが緑のまま（`mem decisions` が書き込みの route・承認の名・印の名を持たない）ことを保全の対照として置く

## 4. return・throw・書き込みの表

### 4.1 `GET …/mem/decisions/branches`（PR2）

| 入力・状態 | 応答 | 書き込み |
|---|---|---|
| リポジトリが無い | 404 `not_found` | 無し |
| root の membership が定まらない（`MembershipUnsettledError`） | 404 `not_found`（`reason: ambiguous`。`promoteList` の `:1117` と同じ） | 無し |
| ブランチ 0 本 | 200 `branches: []` | 無し |
| あるブランチの mode が `on` | 200（`approvable: true`、`open`・`recorded` は数） | 無し |
| あるブランチの mode が `off`・`derived` | 200（`approvable: false`、`open`・`recorded` は数） | 無し |
| あるブランチの mode が `ambiguous` | 200（`approvable: false`、`open: null`・`recorded: null`。0 と断定しない、I6） | 無し |
| DB の読みで例外 | 500（`memInternalError`、既存の route と同じ） | 無し（ログだけ） |

### 4.2 `GET …/mem/decisions/:itemId/diff`（PR1）

| 入力・状態 | 応答 | 書き込み |
|---|---|---|
| リポジトリが無い・項目が無い・項目が `:id` の root の範囲の外・`decision` でない | 404 `not_found` | 無し |
| `worktreeId` が範囲の外・存在しない | 404 `not_found` | 無し |
| `effect` が `spec`・`record_only` 以外 | 400 `invalid_request`（`field: effect`） | 無し |
| `findWithheld` が当たる（本文・引用・evidence・行き先・closeNote のどれか） | 422 `secret_like`（`field` の名だけ。本文・引用・行き先を返さない） | 無し |
| 描画後の本文が検査に当たる | 422 `secret_like` | 無し |
| 項目が `open` 以外 | 200（本文を描き、`approvable: false`・`reference: true`。`open` でも同じ） | 無し |
| 行き先（`promoteTo`）が無い | 200（`destination: null`、本文だけ） | 無し |
| 行き先が作業木の文書で、作業木が無い・HEAD が別のブランチ・detached | 200（`destination: { resolved: false, reason }`、本文だけ） | 無し |
| mode が `on` でない | 200（`mode` を返す。描画は止めない［見立て: 読みは mode に依らない、`mem list` と同じ］） | 無し |
| 例外 | 500 | 無し |

### 4.3 `commandmate mem decisions`（PR1）

| 入力・状態 | exit | 出力 |
|---|---|---|
| 正常 | 0 | 一覧／`--json` |
| `--repository` だけで `--branch` が無い | 既存の `usage` の exit（`target_required`、`mem.ts:136`） | stderr に 1 行 |
| サーバが 404 | 既存の mem の `not_found` の exit | stderr |
| サーバが 422 `secret_like`（diff） | 既存の mem の `secret_like` の exit | stderr に欄の名だけ |
| サーバに繋がらない | 既存の接続失敗の exit | stderr |
| `<itemId>` と `--pending` を同時に | `invalid_request` | stderr |

### 4.4 画面の承認の流れ（PR3。書くのは既存の API だけ）

| 操作 | 呼ぶ API | 書き込み |
|---|---|---|
| カードを開く・`?item=` で開く・引用の確認・効果の切り替え | 無し | 無し（preview を捨てるだけ、I3） |
| 「差分を作る」 | `POST …/preview`（既存） | preview の行（既存どおり） |
| シートの「承認して書く」 | `POST …/approve`（既存） | 既存どおり |
| シートの「やめる」・シートを閉じる（承認の要求の前） | 無し | 無し（preview を捨てる） |
| 承認の要求の最中に閉じる・移動する | 既存の要求はそのまま走る（取り消さない・再送しない） | 既存どおり。戻ったら operation の結果か照合待ちを出す（§7.1） |

## 5. 入力×状態の表（画面）

mode・項目の状態・行き先・引用の組み合わせで、カード（スマホ）と行（PC）が出すもの。operation が不明・進行中・遷移待ちのときは、どの行でも照合の操作を出し、畳まず、「承認待ちだけ」でも隠さない（I9）。

| mode | 状態 | 行き先 | 引用 | 件数（§3.1.3） | 既定の表示 | 出す操作 |
|---|---|---|---|---|---|---|
| `on` | `open` | 有 | 有 | open に数え、承認できる | 開く | 引用の確認 → 効果 → 差分を作る → 承認して書く |
| `on` | `open` | 有 | 無 | open に数え、承認できる | 開く | 効果 → 差分を作る → 承認して書く（引用の確認を出さない） |
| `on` | `open` | 無 | 有／無 | open に数え、承認できる | 開く | 差分を作るを押せない（既存 `:343` の `!item.promoteTo`）。「行き先がありません」と出す（#4354 の 2 で作成時に防ぐ） |
| `on` | `open`（`succeeded`＋`transitionPending` の operation あり） | — | — | open に数える | 開く・隠さない | 「記録済みとして扱う」（既存 `:216-237`） |
| `on` | `recorded` | — | — | recorded に数える | 畳む | 正本へ反映したことを確かめた |
| `on` | `promoted` | — | — | 数えない | 畳む | 無し |
| `off`／`derived` | `open` | — | — | open に数えるが承認できない | 開く | 既存どおり（`modeNotOn` の警告、`DecisionPromotePanel.tsx:258-262`）。承認の route はサーバが断る |
| `ambiguous` | — | — | — | 不明（0 と出さない） | — | 一覧は空、照合待ちだけ（既存 `:253-256`・`:385-403`） |

## 6. PR の分け方

`docs/orchestrate/team.md` §6 の 3（危険の境目で分ける）に従い、読みの CLI と画面を分け、承認の CLI は入れない（§3.5）。各 PR は**直す前に赤の試験**を置いてから直す。

| PR | 中身 | 赤にできる製品上の条件（先に置く） | 保全の対照（緑のまま） | 主な不変条件 | ゲート |
|---|---|---|---|---|---|
| PR1 読みの CLI | `mem decisions`（一覧・`--json` の `schema: 1`）、`<itemId>` の参考の差分、diff の route、件数の共有関数（所有者のとき、§3.1.3）。読みのモジュールは `mem.ts` から分ける | 新しいコマンドが**実際の応答**から一覧・差分・安定した JSON を返す（今はコマンドも route も無いので赤）。operation が `failed`・`unknown`・`succeeded`・`succeeded`＋`transitionPending` の表で文字と JSON を固定（I8）。`--pending` の有無で `counts` が同じ（I7）。diff が作業木なし・別ブランチで `resolved: false`。件数の関数の mode の表（I6） | 差し止め: 本文は無害で引用だけ／evidence だけ／行き先だけが今の規則に当たる 3 つで、本文・引用・行き先が返らない（I5）。無書き込み: 成功・失敗の両方で行の内容・version が同じで、書き込みの関数と `gh` の呼び出しが 0 回（I2）。別のリポジトリの項目の id で 404。既存ガード `mem-promote-screen-only-4225` が緑（I1） | I1・I2・I5・I6・I7・I8 | lint・tsc・unit（`tests/unit/guards` を含む） |
| PR2 画面の選択と PC | リポジトリ → ブランチの select、branches の route、件数（所有者の関数を使う）、`recorded`・`promoted` の畳み、「承認待ちだけ」、`?item=`（§3.1.4）。案 B の URL を CLI に足すのは PR2 のマージの後 | select と件数（不明の表示を含む）、既存の URL で選ばれた状態で開く（I4）、**応答の逆転**（同名のブランチを持つ 2 リポジトリで、切り替えの前の一覧が後から返っても今の選択だけを出す）、照合待ちが絞り込み・畳みで隠れない（I9）、`?item=` の表（§3.1.4）、e2e 1280: **この PR の時点の操作の手順**で承認まで通り件数が減る | 既存の repository＋branch の key で状態を捨てる（`page.tsx:47`）。P2・P3-1 の既存試験 | I3・I4・I6・I9 | 上に加え **e2e を契約に入れる**。マージは `--last` |
| PR3 スマホ | カード・全画面のシート・4 手・押し場所・文言の分離 | e2e 390: カード → 引用の確認 → 効果 → 差分 → 承認、押し場所 44px、横のはみ出しが無い（`scrollWidth <= clientWidth`）、シートの中だけがスクロールし閉じられる。preview の待ちの間に選択を変える・シートを閉じると古い応答を採らない | 既存 `DecisionPromotePanel-4225.test.tsx` の P2・P3-1（選択が変われば preview を捨てる・引用の確認を別の項目へ持ち越さない）。承認の要求の最中に閉じても再送しない | I3・I9 | 上に加え **e2e を契約に入れる**。マージは `--last` |
| PR4 作業木の Tools の mem（§11） | Tools（PC のヘッダーの道具・スマホの「ツール」のサブタブ）の**末尾**に `mem` を 1 つ。その作業木のブランチの項目を `MemItemsPanel` の再利用で出し、承認待ちの件数（PR1 の `counts`）と決定の画面へのリンク。mode が `on` でなければ「mem は off」と設定への案内だけ | 今の Tools に `mem` が無いので赤: PC 1280・スマホ 390 の e2e で、作業木の Tools から mem を開き、そのブランチの項目と承認待ちの件数が見え、決定の画面（`?branch=` つき）へ 1 回の押下で行ける。mode `off`・`derived`・`ambiguous`・detached の表（§11.5） | 既存の道具の並びと ←/→（PC）の順・スマホのサブタブの並びが末尾の追加の前と同じ（`mem` を除いた列が今の列と一致）。`MemItemsPanel` の既存試験（`MemItemsPanel-4227`・`MemItemsPanel-write-lock-4227`）が緑。決定の承認の route を Tools の側から呼ばない（I1・T1） | I1・I6・TM1〜TM5（§11.2） | lint・tsc・unit（guards を含む）に加え **e2e 1280・390 を契約に入れる**。マージは `--last` |

- PR2 の受入に、PR3 で作るカード・シートを求めない
- 依存と並列: 件数の共有関数の所有者（PR1、または先行する #4354）のマージの後に PR2 を切る（§3.1.3）。PR1 と PR2 は、PR2 が共有関数のファイルを書かない限り書くファイルが重ならない（PR1 は `src/cli/commands/` の新しい読みのモジュール・diff の route・`src/lib/promote/` の件数の関数、PR2 は `page.tsx`・branches の route・`DecisionPromotePanel.tsx` の上部）。PR3 は PR2 と同じ `DecisionPromotePanel.tsx` を書くので PR2 の後
- PR4 の依存: PR1 のマージの後（件数を PR1 が足した一覧の route の `counts` で読むため。新しい件数の route は作らない）。PR2・PR3 とは**並列にできる**: PR4 が書くのは `src/config/activity-bar-config.ts`・`src/components/worktree/WorktreeDetailDesktop.tsx` の activities の表・`src/components/worktree/NotesAndLogsPane.tsx` の `SUB_TABS`・新しい部品（例 `src/components/mem/` の下の新しいファイル `WorktreeMemPane`、まだ無い）・`locales/*/worktree.json`・`docs/UI_UX_GUIDE.md` の Activity Bar の一覧で、PR2・PR3 の `page.tsx`（決定の画面）・`DecisionPromotePanel.tsx`・branches の route と重ならない。重なりうるのは `MemItemsPanel.tsx`（§11.3 の要決定 D2 で「中身を変えない」を採れば重ならない）と `locales/*/common.json` の `mem.*`（PR2・PR3 も足す。同じファイルの別のキーなので、後にマージする方が rebase で解く）
- PR4 の e2e も PR2・PR3 と同じく **`--last`** でマージする。PR4 はヘッダーの道具の数を 9 → 10 に変えるので、並行する PR の e2e が道具の位置・数に依存していないか、契約に「既定に依存しない書き方」を入れる
- e2e は既定（レイアウト・幅）に依存しない書き方にする（記憶: 既定・レイアウトを変える Issue は並行 PR の e2e を壊す）
- 利用者向けの文書（`docs/user-guide/cli-operations-guide.md:3728` と en）は、PR1 で `mem decisions` を、PR2・PR3 で画面の手順を、それぞれ同じ PR で ja・en の両方に書く。PR4 は `docs/UI_UX_GUIDE.md` の Activity Bar の一覧（`tests/unit/docs/ui-ux-guide-activities-2062.test.ts` が `ACTIVITIES` と同じ並びを求める）と、利用者向けの画面の説明（ja・en）に Tools の mem を書く

## 7. 試験の設計

- e2e（PR2・PR3）: 隔離したサーバ・DB（`CM_DB_PATH` を作業木の外の一時ディレクトリへ）で、mem が on のブランチに `decision` を 1 件（引用・行き先つき、行き先は作業木の文書）作る。PR3 は 390×844、PR2 は 1280×800 で、リポジトリの select → ブランチの select（件数が出る）→ 承認まで。各段で `document.documentElement.scrollWidth <= clientWidth`（横スクロール無し）を確かめ、承認の後に件数が減ることを見る。ピンチ無しは viewport の `user-scalable` を変えないことと、押し場所の実寸（44px 以上）で確かめる
- 単体（PR1）: `mem decisions` の出力は fixture の応答から作る（作った文面でなく、PR1 の実装の前に隔離サーバで採った実際の応答を fixture にする。T18 の状態は既存の `promote-entrances-4225` の作り方で作る。記憶: 実際の失敗を直す Issue は記録の出力でテストする）
- 対照: 陽性対照（直す前の実装で落ちる。例: PR2 の page 試験は今の文字入力の画面ではブランチの select が無く落ちる）と陰性対照（今の URL の形・P2・P3-1 の動きは変わらない）を各 PR に置く。§6 の表の列がその一覧

### 7.1 寿命・競合で契約に固定する条件（2-4-4 の表を写す）

| 経路・割り込み | 守る条件 | 対照の試験 |
|---|---|---|
| リポジトリ・ブランチの切り替えの最中に古い一覧が返る | 今の選択の一覧だけを出す | 同名のブランチを持つ 2 リポジトリで、応答の順を逆にする（PR2） |
| preview の待ちの間に選択を変える・シートを閉じる | 古い応答を採らない。既存の repository＋branch の key での状態の破棄（`page.tsx:47`）も保つ | 応答を遅らせ、その間に選択を変える・閉じる（PR3） |
| 項目・作業木・効果・引用の確認の変更 | preview を捨て、引用の確認を別の項目へ持ち越さない | 既存の P2・P3-1 の試験を保つ（PR3） |
| 承認の要求の最中に閉じる・移動する | 外への書き込みを「送っていない」と扱わず、再送しない。戻ったら operation の結果か照合待ちを出す | 承認の応答を遅らせて閉じ、戻ったときの表示と、approve の呼び出しが 1 回のままを確かめる（PR3） |
| 「承認待ちだけ」の絞り込み・畳み・mode の変更 | 不明・進行中・遷移待ちの operation を隠さない（I9。絞り込みの例外） | 遷移待ちの項目が絞り込み・畳みで出たまま（PR2） |
| 読みの API の成功・失敗 | preview・承認の状態・既存の行を変えない | 行の内容・version の比較と、書き込みの呼び出し 0 回（I2。行数だけでは UPDATE を見落とす）（PR1・PR2） |

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


## 9. 事前レビュー（2-4-4）の処置

### 9.1 1 回目（2026-11-13、codex、設計 HEAD `e5e7739`）

| 問い・指摘 | 答え | 処置 |
|---|---|---|
| §9 の 1: TTY・環境変数・打ち返しで足りるか | 足りない。PTY の作成・環境変数の除去に加え、表示された確認の語と引用を同じプロセスが読んで打ち返せる。人の操作と区別できない | 案 A を外し、案 B を推奨に（§3.5）。採否は PM・人の確認待ち（§0.2） |
| §9 の 2: 案 A の印を分けるか | 今回は足さない。別の印だけでは人の証明にならない。画面の印も運用の境界 | §3.5 に書いた |
| §9 の 3: 印なしの diff は `mem list` と同じ水準か | 条件つきで同じ水準にできる（リポジトリ所属・項目全体の差し止め・自由入力の安全な表示・無書き込み） | §3.4.2 の安全条件 1〜4、I2・I5 |
| §9 の 4: `schema: 1` への写し | 賛成。ただし照合に要る状態を落とさない・件数が絞り込みの前後のどちらかを固定 | I7・I8、§3.4.1 |
| 要具体化 1: diff の差し止めを本文・引用に限らない | 必須 | I5（`findWithheld` と描画後の検査の両方）、PR1 の対照 3 つ |
| 要具体化 2: 人の承認・外への書き込みの成功・今の版の状態を分ける | 必須 | I8、§3.4.1（`approved` をやめ `state`・`humanApprovals`・`operations[]` の照合用の欄）。JSON の例を T18 の状態にして定義と揃えた |
| 要具体化 3: 件数の mode の条件と共有関数の所有者 | 必須 | I6（open の件数と承認できるかを分ける、`ambiguous` は不明）、§3.1.3（所有者は PR1、#4354 が先ならそちら。PR2・#4354 の表示は所有者の後） |
| 要具体化 4: 読みの diff の作業木と承認の preview との差 | 必須 | §3.4.2（`--worktree` を渡す、無ければ `resolved: false`、参考の表示で承認に使えない、違いは operation の id・時刻・投稿者・引用の出所・期限） |
| 要具体化 5: `?item=` を読む画面の担当 | 必須（案 B のとき） | §3.1.4（PR2。開いただけで何も選ばない・作らない。隠れる・別ブランチ・closed・削除済み・withheld の結果。URL の出力は PR2 の後） |
| 寿命・競合の表 | 契約に固定する | §7.1 |
| 「直す前に赤」の形 | 製品上の条件で赤にする。差し止め・無書き込み・ガードは保全の対照 | §6 の表の列を分けた |
| 既存ガードはファイル全体を見る | 読みのモジュールを分ける | §3.4.1 |

### 9.2 残り（PM・人の確認待ち）

- 案 B を採るか C か（§3.5）→ 案 B に決定（人、2026-11-13）
- 件数の共有関数の所有者を PR1 と #4354 のどちらにするか（run の順、§3.1.3）

## 11. 作業木の Tools の mem（PR4、人の追加の要望 2026-11-13 16:2x）

出典: Issue #4355 の最後のコメント（人の追加の要望と PM の具体化）。「mem を、リポジトリの画面だけでなく、作業木の Tools（Notes などと同じ並び）からも確認できるようにしてほしい」。受入: 作業木の Tools から mem を開き、そのブランチの項目と承認待ちの件数が見え、決定の画面へ 1 タップで行ける（PC 1280・スマホ 390 の e2e）。

### 11.1 今の作り（事実）

- **PC の Tools**: `src/config/activity-bar-config.ts:61-82` の `ACTIVITIES`（`files`・`git`・`notes`・`schedules`・`agent`・`timer`・`todo`・`skills`・`verification`・`env` の 10 個）。ヘッダーの右に出る道具は `HEADER_TOOLS`（`:99-101`、`verification` を除いた 9 個。`verification` はチップから開く `:91`）。並びは ←/→ キーの順（`src/components/worktree/HeaderToolBar.tsx:103-108`）。狭いヘッダーでは**末尾から**「…」の後ろに畳む（`HeaderToolBar.tsx:77-79`）。`verification`・`env` は「位置で番号を数える利用者と試験があるので、挿入でなく末尾に足した」（`activity-bar-config.ts:74-81`。当時の説明は ArrowUp/ArrowDown、#3591 からは ←/→）
- 各道具の中身は `src/components/worktree/WorktreeDetailDesktop.tsx` の activities の表（`:1010` の `env` ほか）で、`ActivityPane`（`src/components/worktree/ActivityPane.tsx`）が選ぶ。開いた道具は作業木ごとに localStorage に残る（`activity-bar-config.ts` の `ACTIVITY_BAR_STORAGE_KEY_PREFIX`）
- **スマホの Tools**: 下のタブ `src/components/mobile/MobileTabBar.tsx:18` の `memo`（表示名は「ツール」、`locales/ja/worktree.json:895`）。中身は `src/components/worktree/NotesAndLogsPane.tsx` のサブタブ `SUB_TABS`（`:136-153`: `notes`・`logs`・`agent`・`timer`・`todo`・`skills`・`verification`・`env`、型は `:38`）。PC の `ACTIVITIES` とは**別の一覧**で、並びも違う（`activity-bar-config.ts:58-59` が明記）。深いリンク `?pane=` の値（`src/types/ui-state.ts:49` の `DeepLinkPane`）にサブタブの多くは無い
- **mem の部品**: `src/components/mem/MemItemsPanel.tsx`。props は `repositoryId`・`branch`・`worktreeId`（`:218-225`）。読みは `memItemsApi.mode`・`list`・`notices`（`:281-291`、`src/lib/mem/screen-client.ts:150-185`）、書き込み（追加・編集・閉じる）は #4227 の画面の印つきの route だけ。決定の行には決定の画面へのリンク（`:931`、`?branch=` つき）。mode の行と「mode を変える」の切り替えで `RepositoryMemSettings` を開く（`:961-971`）。承認待ちの**件数**は出さない
- **使っているページ**: `src/app/repositories/[id]/mem/page.tsx`（`/repositories/<id>/mem?branch=<name>[&worktree=<id>]`）。ブランチは文字入力（`:22-24`）、部品は `:55`
- **作業木からリポジトリ・ブランチを解く既存の口**: `GET /api/worktrees/:id/mem/mode`（`src/app/api/worktrees/[id]/mem/mode/route.ts`、本体は `src/lib/mem/service.ts:903-919` の `memMode`）が `repositoryIds`（同じ Git の root）・`branch`（detached なら null）・`mode` を返す。root の間で mode が食い違うと 409 `ambiguous`。PR1 の CLI（`src/cli/commands/mem-decisions.ts`）も同じ口でリポジトリ・ブランチを解いている
- **承認待ちの件数**: PR1 が一覧の route（`GET /api/repositories/:id/mem/decisions?branch=`）の応答に `counts`（`decisionCountsOf`、`src/lib/promote/decision-counts.ts`）を足した。画面の読み `promoteApi.list`（`src/lib/promote/screen-client.ts`）で読める
- **並びを固定している試験**（PR4 で期待値が変わる。既存の期待値の変更は契約で PM が許すこと）: `tests/unit/components/worktree/HeaderToolBar-3591.test.tsx:48`・`:61`・`:245`（道具は 9 個）・`:206`（末尾は `env`）、`tests/e2e/header-tools-3591.spec.ts:91`（道具の id の列）、`tests/unit/docs/ui-ux-guide-activities-2062.test.ts`（文書の一覧＝`ACTIVITIES`）、`tests/unit/components/worktree/NotesAndLogsPane.test.tsx`（サブタブ）、`tests/unit/i18n/worktree-git-panels-keys.test.ts`

### 11.2 不変条件（PR4）

| # | 不変条件 | なぜ | 固定する試験 |
|---|---|---|---|
| TM1 | 既存の道具の並びと番号を変えない: `mem` は `ACTIVITIES` と `SUB_TABS` の**末尾**に足す（`env` の後）。PC の ←/→ の順で既存の道具の位置が変わらない | 位置で数える利用者と試験がある（`activity-bar-config.ts:74-81`） | `mem` を除いた `ACTIVITIES`・`HEADER_TOOLS`・`SUB_TABS` の id の列が今の列と一致。`mem` の位置は末尾 |
| TM2 | 書き込みの経路を増やさない: Tools の mem は `MemItemsPanel` を再利用し、新しい書き込みの route・印・承認の口を作らない。**決定の承認は決定の画面だけ**（I1） | エージェントが人の決定を作れない前提（#4225 D9）と、#4227 の画面の書き込みの規則（ロック・照合）を 1 か所に保つ | Tools の部品のソースに `mem/decisions` の書き込み（preview・approve 他）の呼び出しが無い。新しい route のファイルが無い。`MemItemsPanel-4227` の既存試験が緑 |
| TM3 | 承認待ちの件数は PR1 の共有関数の値（一覧の route の `counts`）を出す。`approvable: false` は「承認できない（mode）」を添え、`null` は「不明」と出して 0 と出さない（I6） | 画面ごとに数が違うと「承認し終えた」と誤る | 同じ fixture で CLI（`mem decisions --json` の `counts`）と Tools の件数の表示が一致。`ambiguous` で「不明」 |
| TM4 | mode が `on` でないブランチ（`off`・`derived`）では、項目の一覧と件数の代わりに「mem は off（または derived）」と設定への案内（`/repositories/<id>/mem`）だけを出す。`ambiguous`・detached・未登録も、それぞれの理由と案内だけ（§11.5） | 人の要望（PM の具体化）。off のブランチで空の一覧を出すと「項目が無い」と読み違える | §11.5 の表の行ごとの部品の試験 |
| TM5 | 決定の画面へのリンクは、リポジトリとブランチが選ばれた URL（`/repositories/<id>/mem/decisions?branch=<name>`、I4）。PR2 のマージの後は項目の行から `&item=<id>`（§3.1.4）も使える。リンクを押しても何も選ばない・作らない | 1 タップで承認の場所へ行ける（受入）。`?item=` は開いただけで preview を作らない（§3.1.4） | e2e 1280・390 で 1 回の押下で決定の画面に着き、そのブランチが選ばれている |

PC とスマホの両方で TM1〜TM5 を守る（同じ部品を両方から使う）。

### 11.3 設計

- **入口**: PC は `ACTIVITIES` の末尾に `{ id: 'mem', labelKey: 'activityBar.mem', icon: <lucide の 1 つ> }`。`HEADER_TOOLS` に入る（`verification` だけが除かれる規則は変えない）。スマホは `SUB_TABS` の末尾に `{ id: 'mem', labelKey: 'memTab' }`。どちらも中身は同じ新しい部品 `WorktreeMemPane`（`worktreeId` を受ける）
- **部品の中身**（上から）:
  1. `GET /api/worktrees/:id/mem/mode` で `repositoryIds[0]`・`branch`・`mode` を解く（既存の口。新しい route は作らない）
  2. mode が `on`: 1 行の件数（`承認待ち N 件・反映待ち M 件`。PR1 の `counts`）と「決定の画面へ」のリンク（TM5）。その下に `MemItemsPanel`（`repositoryId`・`branch`・`worktreeId` をそのまま渡す）
  3. mode が `on` でない・解けない: §11.5 の表のとおり、理由の 1 行と設定・決定の画面への案内だけ
- **要決定**（PM・人）:
  - D1 スマホの置き場所: (a) **「ツール」のサブタブの末尾**（推奨。Notes などと同じ並び＝人の言葉どおり、下のタブの数を変えない）／(b) 下のタブに `mem` を足す（タブが 6 つになり 390 幅で押し場所が狭くなる。`MobileTab` と `DeepLinkPane` の変更も要る）
  - D2 `MemItemsPanel` を変えるか: (a) **変えずに外側の部品で件数とリンクを足す**（推奨。PR2・PR3 と書くファイルが重ならない。mode の行の「mode を変える」もそのまま）／(b) props で件数・リンク・設定の切り替えの有無を選べるようにする（中身を 1 か所に寄せられるが、#4227 の試験と PR2・PR3 との重なりが増える）
  - D3 ヘッダーの道具に件数のバッジを出すか: (a) **出さない**（推奨。件数は部品の中だけ。ヘッダー・サイドバーの全体の件数は #4354 の担当で、そちらと二重にしない）／(b) 道具のアイコンに承認待ちの数を出す（#4354 と同じ関数を使い、表示の重複を #4354 と決める）
  - D4 狭い PC のヘッダー: 末尾の道具から「…」に畳む（`HeaderToolBar.tsx:77-79`）ので、`mem` は最初に畳まれる。(a) **そのまま**（推奨。「…」から開ける。e2e 1280 は畳まれない幅）／(b) `mem` を畳まない例外にする（畳みの規則が 2 つになる）
- 深いリンク（`?pane=mem`）は PR4 では足さない［見立て: `DeepLinkPane` に Tools のサブタブの多くが無く、今のサブタブと同じ扱いで足りる］

### 11.4 return・throw・書き込みの表（`WorktreeMemPane`）

| 入力・状態 | 呼ぶ API | 出すもの | 書き込み |
|---|---|---|---|
| 作業木の mode の読みが 200・mode `on` | `GET …/worktrees/:id/mem/mode`、`GET …/repositories/:id/mem/decisions?branch=`（件数）、`MemItemsPanel` の既存の読み | 件数の行・決定の画面へのリンク・`MemItemsPanel` | 無し（`MemItemsPanel` の中の人の操作だけが #4227 の既存の画面の route で書く） |
| mode `off`・`derived` | mode の読みだけ | 「mem は off（derived）」と設定（`/repositories/<id>/mem`）への案内 | 無し |
| mode の読みが 409 `ambiguous` | 同上 | 「root の間で mode が食い違う」と設定への案内。件数は出さない（不明） | 無し |
| detached（`branch: null`） | 同上 | 「ブランチが無い（detached）」だけ | 無し |
| 404（未登録・作業木が無い） | 同上 | 「mem の対象のリポジトリではない」だけ | 無し |
| 件数の読みだけが失敗（mode は `on`） | 件数の route | 件数の行を「不明」にし、`MemItemsPanel` とリンクは出す（0 と出さない、TM3） | 無し |
| 読みの途中で作業木を切り替えた | — | 古い応答を採らない（作業木の id で捨てる） | 無し |

### 11.5 入力×状態の表（PC・スマホ共通）

| mode | ブランチ | 決定 | 件数の行 | 決定の画面へのリンク | `MemItemsPanel` |
|---|---|---|---|---|---|
| `on` | 名前あり | open あり | `承認待ち N 件・反映待ち M 件` | 出す | 出す |
| `on` | 名前あり | 無し | `承認待ち 0 件` | 出す | 出す |
| `off`／`derived` | 名前あり | 何でも | 出さない（「mem は off／derived」） | 出さない［見立て: 承認できないブランチへ誘わない。open の決定があれば設定の案内に件数を添えるかは PR4 の契約で決める］ | 出さない |
| `ambiguous` | 名前あり | — | 「件数不明」 | 出さない | 出さない |
| — | detached | — | 出さない | 出さない | 出さない |

### 11.6 PR の分け方の中の位置

§6 の表の PR4 の行。依存は PR1 のマージの後、PR2・PR3 とは並列にできる（§6 の箇条）。

### 11.7 試験の設計（PR4）

- e2e 1280・390（隔離したサーバ・DB、§7 と同じ作り）: mode `on` のブランチに `decision` を 1 件作り、作業木の画面の Tools（PC はヘッダーの末尾の道具、スマホは「ツール」→ 末尾のサブタブ）から mem を開く → そのブランチの項目と `承認待ち 1 件` が見える → 「決定の画面へ」を 1 回押すと `/repositories/<id>/mem/decisions?branch=<name>` に着く。各段で横スクロール無し（`scrollWidth <= clientWidth`）
- 単体: §11.5 の表の行ごと（mode の応答を返す偽の fetch。陽性対照: 今の `ACTIVITIES` に `mem` が無く赤）。TM1 は `mem` を除いた列が今の列と一致（陰性対照）。TM2 は Tools の部品のソースを読み、書き込みのメソッドと `mem/decisions/…/preview|approve` が無い

## 10. 改訂の履歴

- 2026-11-13 第 3 版: CLI の承認を案 B に決定（人、2026-11-13 16:03）。§0.1・§0.2 の 1・§3.5 を書き換え。PR1 は読みの CLI だけ（`src/cli/commands/mem-decisions.ts`、件数の共有関数は `src/lib/promote/decision-counts.ts`）、URL の出力は PR2 のマージの後。実装で §3.4 に足したもの（I7 の「足すのは可」の範囲）: 一覧の JSON に `text`・`stale`・`pending`、項目の `operations[]` に `resultRef`、diff の `destination` の `reason` に `invalid_destination`（作業木の文書のパスが今の検査に当たる）、一覧の route（`promoteList`）の応答に `counts`
- 2026-11-13 第 4 版: 人の追加の要望（作業木の Tools から mem を確認する、Issue #4355 のコメント 2026-11-13 16:2x）を §11 に足し、§0.1・§6 の PR の分け方に PR4（作業木の Tools の mem、PC・スマホ、e2e 1280・390、`--last`、PR1 の後・PR2・PR3 と並列）を加えた。要決定 D1〜D4 は PM・人の確認待ち
