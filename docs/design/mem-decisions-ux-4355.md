# 決定の画面を「リポジトリ → ブランチ」で選べるようにし、スマホ・PC の操作を直し、決定を読む CLI を足す（Issue #4355）設計

- 段: 設計（この文書だけ）。コードは書かない。実装は PM の確認の後、§6 の PR ごとに別の契約で行う
- 版: 第 5 版（2026-11-13）。第 5 版は Tools の mem の 2-4-4 と PM の処分の反映、第 4 版は作業木の Tools の mem（§11）を追加。第 2 版は事前レビュー（2-4-4、codex、設計 HEAD `e5e7739`）の反映（処置は §9）。第 3 版は CLI の承認を案 B に決定（人、2026-11-13）。履歴は §10
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
| PR の分け方 | PR1 読みの CLI ／ PR2 画面のリポジトリ → ブランチの選択と PC の件数・畳み ／ PR3 スマホのカード・シート・4 手の流れ（e2e 390・1280）／ PR4 作業木の Tools の mem（PC・スマホ、e2e 1280・1440・390、§11。人の追加の要望 2026-11-13 16:2x）／ 承認の CLI は入れない（案 B、§3.5）。順は PR1 → (PR2 → PR3) と PR4 を並列（§6、確定版） |
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
| PR4 作業木の Tools の mem（§11） | Tools（PC のヘッダーの道具・スマホの「ツール」のサブタブ）の**末尾**に `mem` を 1 つ。その作業木のブランチだけを、作業木を固定した `MemItemsPanel`（props で絞る、§11.3）で出す。mode は変えさせず設定への案内だけ。承認待ちの件数（PR1 の `counts`）と決定の画面へのリンク。`derived` は読むだけ（凍結の印）、`off` は案内だけ（open の決定があれば件数とリンクを添える） | 今の Tools に `mem` が無いので赤: e2e 1280・390 で作業木の Tools から mem を開き、そのブランチの項目と承認待ちの件数が見え、決定の画面（`?branch=` つき）へ行ける（1280 は `mem` が見えていれば 1 回、畳まれていれば「…」から 2 回、390 はサブタブの列の中でスクロールしてから 1 回）。既存の `tests/e2e/header-tools-3591.spec.ts` の `TOOL_IDS` に `mem` を足し、1440 のサイドバーの開閉どちらでも 10 個すべてが見え「…」が 0 個（#3591、TM1）。mode `off`・`derived`・`ambiguous`・detached・読みの間の mode の変化の表（§11.5） | 既存の道具の並びと ←/→（PC）の順・スマホのサブタブの並びが末尾の追加の前と同じ（`mem` を除いた列が今の列と一致）。`MemItemsPanel` の既存試験（`MemItemsPanel-4227`・`MemItemsPanel-write-lock-4227`）が props を渡さない今の使い方で緑。Tools から別の作業木への書き込み・リポジトリの mem の設定の書き込み・決定の承認に届かない（TM2） | I1・I6・TM1〜TM5（§11.2） | lint・tsc・unit（guards を含む）に加え **e2e 1280・1440・390 を契約に入れる**。マージは `--last`。PR4 の前に幅の余りを測る（§11.7） |

- PR2 の受入に、PR3 で作るカード・シートを求めない
- 依存と並列: 件数の共有関数の所有者（PR1、または先行する #4354）のマージの後に PR2 を切る（§3.1.3）。PR1 と PR2 は、PR2 が共有関数のファイルを書かない限り書くファイルが重ならない（PR1 は `src/cli/commands/` の新しい読みのモジュール・diff の route・`src/lib/promote/` の件数の関数、PR2 は `page.tsx`・branches の route・`DecisionPromotePanel.tsx` の上部）。PR3 は PR2 と同じ `DecisionPromotePanel.tsx` を書くので PR2 の後
- **順（確定版）**: PR1 → (PR2 → PR3) と PR4 を並列。PR2 と PR3 は同じ `DecisionPromotePanel.tsx` を書くので直列。PR4 は PR1 のマージの後（件数を PR1 が足した一覧の route の `counts` で読む。新しい件数の route は作らない）に始め、PR2・PR3 と並列にできる
- **PR4 が書くファイル**: `src/config/activity-bar-config.ts`（`ActivityId` と `ACTIVITIES` の末尾）、`src/components/worktree/ActivityPane.tsx`（`ERROR_BOUNDARY_NAMES` は `Record<ActivityId, string>` なので `mem` の行が要る、`:51`）、`src/components/worktree/WorktreeDetailDesktop.tsx`（activities の表）、`src/components/worktree/NotesAndLogsPane.tsx`（`SubTab` の型 `:38` と `SUB_TABS` の末尾）、`src/components/mem/MemItemsPanel.tsx`（Tools 用の props、§11.3）、新しい部品（例 `src/components/mem/` の下の新しいファイル `WorktreeMemPane`、まだ無い）、`locales/*/worktree.json`（PC の道具の名 `activityBar.mem`）、`locales/*/schedule.json`（スマホのサブタブの名 `memTab`。サブタブは `useTranslations('schedule')`、`NotesAndLogsPane.tsx:187`）、`locales/*/common.json`（`mem.*` の Tools の文言）、`docs/UI_UX_GUIDE.md`（Activity Bar の一覧）、利用者向けの画面の説明（ja・en）と、§11.1 の並び・数を固定する試験
- **PR2・PR3 との重なり**: PR2・PR3 が書くのは決定の画面の `page.tsx`・`DecisionPromotePanel.tsx`・branches の route で、PR4 と重ならない。`MemItemsPanel.tsx` は PR2・PR3 が書かない（§8.1、PR2 は設定の入口を直さない）。重なるのは `locales/*/common.json` の `mem.*`（別のキー）だけで、後にマージする方が rebase で解く
- **既存の期待値の変更を契約で許す範囲（PR4）**: §11.1 の「並び・数を固定する試験」の表の行に限る（道具の数 9 → 10・末尾の id・サブタブの列・i18n のキー）。並び・数以外の期待値は変えない
- **`header-tool-*` に依存する e2e の PR は PR4 の後にマージする**: PR4 は道具の数を 9 → 10 に変え、狭い幅で畳み方が変わる。並行する PR の e2e のうち `header-tool-*` を読むもの（§11.1 の表）を持つ PR は PR4 のマージの後に回すか、契約に「`mem` の有無・畳みに依存しない書き方」を入れる
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

出典: Issue #4355 の最後のコメント（人の追加の要望と PM の具体化）。「mem を、リポジトリの画面だけでなく、作業木の Tools（Notes などと同じ並び）からも確認できるようにしてほしい」。受入: 作業木の Tools から mem を開き、そのブランチの項目と承認待ちの件数が見え、決定の画面へ行ける（PC 1280・スマホ 390 の e2e）。事前レビュー（2-4-4、claude-5、`prereview-4355-tools-reply.md`）の必須 2・推奨 3・質問 2 と PM の処分（2026-11-13）を反映した（第 5 版）。

### 11.0 決定（PM の処分、2026-11-13）

| # | 問い | 決定 |
|---|---|---|
| P1 | 2-4-4 の推奨 1: `MemItemsPanel` をそのまま使うと、Tools から別の作業木の選択と「mode を変える」（`RepositoryMemSettings`、リポジトリ全体の設定の書き込み）に届く | **(b)**: Tools では作業木を固定する（その作業木のブランチだけ。作業木の選択を出さない）。mode は変えさせず、設定への案内（リンク）だけ。人の要望は「確認できるように」 |
| P2 | 質問 1: `derived` のブランチ | **項目を読むだけで出す**。書く操作は出さず、凍結の印を付ける |
| P3 | 質問 2: `off` のブランチに open の決定があるとき | **件数と決定の画面へのリンクを添える**（項目の一覧は出さない） |

### 11.1 今の作り（事実）

- **PC の Tools**: `src/config/activity-bar-config.ts:61-82` の `ACTIVITIES`（`files`・`git`・`notes`・`schedules`・`agent`・`timer`・`todo`・`skills`・`verification`・`env` の 10 個）。ヘッダーの右に出る道具は `HEADER_TOOLS`（`:99-101`、`verification` を除いた 9 個。`verification` はチップから開く `:91`）。並びは ←/→ キーの順（`src/components/worktree/HeaderToolBar.tsx:103-108`）。畳みは実際の幅を測って決め（`src/components/worktree/WorktreeDetailSubComponents.tsx:1133-1134` が `useDesktopHeaderFit` に `HEADER_TOOLS.length` を渡す）、**末尾から**「…」（`header-tool-more`）の後ろに畳む（`HeaderToolBar.tsx:77-79`）。`verification`・`env` は「位置で番号を数える利用者と試験があるので、挿入でなく末尾に足した」（`activity-bar-config.ts:74-81`。当時の説明は ArrowUp/ArrowDown、#3591 からは ←/→）
- **#3591 の約束**: `tests/e2e/header-tools-3591.spec.ts:113-131` が、1440×900 でサイドバーを開いた場合と閉じた場合の両方で `TOOL_IDS`（`:91`）のすべてが見え、`header-tool-more` が 0 個であることを求める。1280 で畳まれないかを確かめた e2e は無い（未確認）
- 各道具の中身は `src/components/worktree/WorktreeDetailDesktop.tsx` の activities の表（`:1010` の `env` ほか）で、`ActivityPane`（`src/components/worktree/ActivityPane.tsx`、`ERROR_BOUNDARY_NAMES: Record<ActivityId, string>` が `:51`）が選ぶ
- **スマホの Tools**: 下のタブ `src/components/mobile/MobileTabBar.tsx:18` の `memo`（表示名は「ツール」、`locales/ja/worktree.json:895`）。中身は `src/components/worktree/NotesAndLogsPane.tsx` のサブタブ `SUB_TABS`（`:136-153`: `notes`・`logs`・`agent`・`timer`・`todo`・`skills`・`verification`・`env`、型は `:38`）。ラベルは `useTranslations('schedule')`（`:187`）で `locales/*/schedule.json` から引く。サブタブの列は横にスクロールし（`overflow-x-auto`、`:222-228`）、選んだサブタブを見える位置へ寄せる（`:215`）。PC の `ACTIVITIES` とは**別の一覧**で、並びも違う（`activity-bar-config.ts:58-59`）
- **mem の部品**: `src/components/mem/MemItemsPanel.tsx`。props は `repositoryId`・`branch`・`worktreeId`（`:218-225`）。読みは `memItemsApi.mode`・`list`・`notices`（`:281-291`）で、mode を**自分で**読む（`:285`）。作業木の選択（`:974-990`、リポジトリの全作業木から選べる）、mode の行と「mode を変える」で `RepositoryMemSettings` を開く（`:961-971`）。`derived` は書き込みを凍結し `off` は何も並べない（`:5-6`）、凍結の印（`:898`）。書き込み（追加・編集・閉じる）は #4227 の画面の印つきの route だけ。決定の行には決定の画面へのリンク（`:931`）。承認待ちの**件数**は出さない
- **使っているページ**: `src/app/repositories/[id]/mem/page.tsx`（`/repositories/<id>/mem?branch=<name>[&worktree=<id>]`）。ブランチは文字入力（`:22-24`）、部品は `:55`
- **作業木からリポジトリ・ブランチを解く既存の口**: `GET /api/worktrees/:id/mem/mode`（`src/app/api/worktrees/[id]/mem/mode/route.ts`、本体は `src/lib/mem/service.ts:903-919` の `memMode`）が `repositoryIds`（同じ Git の root。2 つ以上ありうる）・`branch`（detached なら null）・`mode` を返す。root の間で mode が食い違うと 409 `ambiguous`。PR1 の CLI（`src/cli/commands/mem-decisions.ts`）も同じ口で解く
- **承認待ちの件数**: PR1 が一覧の route（`GET /api/repositories/:id/mem/decisions?branch=`）の応答に `counts`（`decisionCountsOf`、`src/lib/promote/decision-counts.ts`。`counts.mode` を含む）を足した
- **並び・数を固定する試験**（`git grep` で `HEADER_TOOLS`・`ACTIVITIES`・`SUB_TABS`・`header-tool-` を探した結果、2026-11-13）:

| 試験 | 固定しているもの | PR4 で |
|---|---|---|
| `tests/unit/components/worktree/HeaderToolBar-3591.test.tsx` | 道具は 9 個（`:48`・`:61`・`:245`）、末尾は `env`（`:206`） | 10 個・末尾 `mem` に変える（契約で許す） |
| `tests/unit/components/worktree/DesktopHeader-tools-3591.test.tsx` | 見える道具の数＝`HEADER_TOOLS.length`（`:137`）、`focusActivityEntry('env')`（`:245`） | 数は追従。末尾を使う箇所は `mem` を許す |
| `tests/unit/components/worktree/DesktopHeader-layout-4218.test.tsx` | 畳み無しで `HEADER_TOOLS` すべてが見える（`:421` 付近） | そのまま緑を求める |
| `tests/unit/config/activity-bar-icons-3632.test.ts` | アイコンの重複の禁止 | `mem` のアイコンは既存 10 個と別のもの。緑を求める |
| `tests/unit/components/worktree/verification-surface-parity-2064.test.tsx` | PC とスマホの対応 | `mem` を両方に足して緑 |
| `tests/unit/components/worktree/NotesAndLogsPane.test.tsx` | サブタブの列 | 末尾に `mem` |
| `tests/unit/docs/ui-ux-guide-activities-2062.test.ts` | `docs/UI_UX_GUIDE.md` の一覧＝`ACTIVITIES` | 文書に `mem` を足して緑 |
| `tests/unit/i18n/worktree-git-panels-keys.test.ts`、`tests/unit/i18n/skills-tab-keys.test.ts`（サブタブの名の ja・en の型） | 辞書のキー | `activityBar.mem`（worktree）・`memTab`（schedule）の ja・en を求める試験を足す |
| `tests/e2e/header-tools-3591.spec.ts` | `TOOL_IDS`（`:91`）、1440 で畳まれない（`:113-131`） | `TOOL_IDS` に `mem` を足し緑を求める（TM1） |
| `header-tool-*` を読むほかの e2e: `activity-pane-overlay-3589`・`activity-pane-side-4219`・`file-maximize-portal-2294`・`file-tree-operations`・`markdown-editor`・`recursive-delete`・`split-header-in-bar-3592`・`verification-pane`・`worktree-header-one-row-3590` の各 spec と `tests/e2e/fixtures/terminal-split-helpers.ts` | 特定の道具を押す。狭い幅では畳みに依存 | 変えない。PR4 の後もそのまま緑を求める（§6: これらに触れる並行の PR は PR4 の後） |

（2-4-4 は「`header-tool-more` を読む e2e は 10 本」とした。こちらの検索では `header-tool-more` の文字は e2e では `header-tools-3591.spec.ts` だけで、`header-tool-` を読む e2e が上の 11 ファイル。`action-bar-overflow-sidebar-3651.spec.ts` は分割の操作の列の畳み（`split-action-bar-items-overflow`）を見るもので、ヘッダーの道具の畳みは読まない）

### 11.2 不変条件（PR4）

| # | 不変条件 | なぜ | 固定する試験 |
|---|---|---|---|
| TM1 | 既存の道具の並びと番号を変えない: `mem` は `ACTIVITIES` と `SUB_TABS` の**末尾**に足す（`env` の後）。PC の ←/→ の順で既存の道具の位置が変わらない。**1440 ではサイドバーの開閉どちらでも 10 個すべてが見え、畳まれない（#3591）**。1280 の経路は「`mem` が見えていれば 1 回、畳まれていれば『…』から 2 回」（どちらも許す） | 位置で数える利用者と試験がある（`activity-bar-config.ts:74-81`）。#3591 の約束 | `mem` を除いた `ACTIVITIES`・`HEADER_TOOLS`・`SUB_TABS` の id の列が今の列と一致。`tests/e2e/header-tools-3591.spec.ts` の `TOOL_IDS` に `mem` を足して緑（赤なら PR4 に幅の対策を入れる） |
| TM2 | 書き込みの経路を増やさない: Tools の mem は `MemItemsPanel` を再利用し、新しい書き込みの route・印・承認の口を作らない。**決定の承認は決定の画面だけ**（I1）。P1 により、Tools からは**別の作業木への書き込み**と**リポジトリの mem の設定の書き込み**に届かない（作業木は固定、mode は設定への案内のリンクだけ）。その作業木での項目の追加・編集・閉じる（mode `on`）は #4227 の既存の route のまま | エージェントが人の決定を作れない前提（#4225 D9）。人の要望は「確認」で、Tools を設定の書き込みの入口にしない | 新しい部品のソースに書き込みの呼び出しが無い（§11.7）。Tools の表示に作業木の選択（`mem-items-worktree`）と `RepositoryMemSettings` が無い |
| TM3 | 承認待ちの件数は PR1 の共有関数の値（一覧の route の `counts`）を出す。`approvable: false` は「承認できない（mode）」を添え、`null` は「不明」と出して 0 と出さない（I6）。**mode は 1 つの読みに揃える**: 件数の行は、`MemItemsPanel` が読んだ mode（パネルの読みを正とする）と `counts.mode` が一致したときだけ数を出し、食い違えば「不明」にして読み直しを待つ | 画面ごとに数が違うと「承認し終えた」と誤る。読みの間に mode が変わると件数の行とパネルの mode の行が食い違う（2-4-4 推奨 2） | 同じ fixture で CLI（`mem decisions --json` の `counts`）と Tools の件数の表示が一致。mode の読みが 1 回目 `on`・2 回目 `off` を返す偽の fetch で、件数の行が数を出さない（「不明」） |
| TM4 | mode ごとの表示（P2・P3）: `on` は項目・件数・リンク。`derived` は項目を**読むだけ**（追加・編集・閉じるを出さない、凍結の印）と件数・リンク。`off` は「mem は off」と設定への案内、open の決定があれば件数と決定の画面へのリンクを添える（項目の一覧は出さない）。`ambiguous`・detached・未登録は理由と案内だけ（§11.5） | 人の要望「確認できるように」と PM の具体化。off のブランチで空の一覧を出すと「項目が無い」と読み違える | §11.5 の表の行ごとの部品の試験 |
| TM5 | 決定の画面へのリンクは、リポジトリとブランチが選ばれた URL（`/repositories/<id>/mem/decisions?branch=<name>`、I4）。PR2 のマージの後は項目の行から `&item=<id>`（§3.1.4）も使える。リンクを押しても何も選ばない・作らない | 承認の場所へ行ける（受入）。`?item=` は開いただけで preview を作らない（§3.1.4） | e2e 1280・390 で決定の画面に着き、そのブランチが選ばれている |

PC とスマホの両方で TM1〜TM5 を守る（同じ部品を両方から使う）。

### 11.3 設計

- **入口**: PC は `ACTIVITIES` の末尾に `{ id: 'mem', labelKey: 'activityBar.mem', icon: <lucide の 1 つ、既存 10 個と別> }`。`HEADER_TOOLS` に入る（`verification` だけが除かれる規則は変えない）。スマホは `SUB_TABS` の末尾に `{ id: 'mem', labelKey: 'memTab' }`（`schedule.json`）。どちらも中身は同じ新しい部品 `WorktreeMemPane`（`worktreeId` を受ける）
- **部品の中身**（上から）:
  1. `GET /api/worktrees/:id/mem/mode` で `repositoryIds`・`branch`・`mode` を解く（既存の口。新しい route は作らない）
  2. 件数の行: 一覧の route の `counts`（`repositoryIds[0]` で読む。一覧は同じ Git の root すべてを読むので、どの root の id でも同じ数）。TM3 のとおり、パネルが読んだ mode と `counts.mode` が一致したときだけ数を出す
  3. 決定の画面へのリンク（TM5）と、`MemItemsPanel`（作業木を固定）
  4. mode が `off`・解けない: §11.5 の表のとおり、理由の 1 行と案内だけ
- **`MemItemsPanel` を props で絞る**（P1。包むだけでは中の作業木の選択と設定の切り替えを隠せない）: 例 `fixedWorktree: true`（作業木の選択を出さず `worktreeId` に固定）、`settingsHref: string`（「mode を変える」の切り替えと `RepositoryMemSettings` の代わりに設定へのリンク）、`onModeRead(mode)`（パネルが読んだ mode を外へ渡す、TM3）。props を渡さない今の使い方（`/repositories/[id]/mem`）は何も変わらない（既存試験が緑）。`derived` で書く操作を出さないのは今の部品の動き（`:5-6`）で、Tools でも同じ
- **`repositoryIds` が 2 つ以上のとき**: 読み（mode・一覧・件数）は同じ Git の root すべてを読むので `repositoryIds[0]` でよい。設定への案内は**root ごとのリンクを並べ**、「同じ Git の root の設定は揃えること（1 つだけ変えると `ambiguous` になる）」を添える（2-4-4 推奨 2）
- **スマホ 390**（2-4-4 推奨 3）: サブタブが 9 個になり `mem` は列の末尾。はみ出しはサブタブの列の中の横スクロールだけに限り（今の `overflow-x-auto`）、ページ全体は `scrollWidth <= clientWidth` を保つ。押す場所は 44px 以上
- **要決定**（PM・人、残り）:
  - D1 スマホの置き場所: (a) **「ツール」のサブタブの末尾**（推奨。Notes などと同じ並び＝人の言葉どおり、下のタブの数を変えない）／(b) 下のタブに `mem` を足す（タブが 6 つになり 390 幅で押し場所が狭くなる。`MobileTab` と `DeepLinkPane` の変更も要る）
  - D2 `MemItemsPanel` を変えるか → **P1 により (b) props で絞るに決定**
  - D3 ヘッダーの道具に件数のバッジを出すか: (a) **出さない**（推奨。件数は部品の中だけ。ヘッダー・サイドバーの全体の件数は #4354 の担当で、そちらと二重にしない）／(b) 道具のアイコンに承認待ちの数を出す
  - D4 狭い PC のヘッダー: 末尾の道具から「…」に畳むので `mem` は最初に畳まれる。(a) **そのまま**（推奨。1280 は TM1 の 2 つの経路を許す）／(b) `mem` を畳まない例外にする。どちらでも **1440 で畳まれない**（TM1）は必須で、測った結果が足りなければ PR4 に幅の対策を入れる（§11.7）
- 深いリンク（`?pane=mem`）は PR4 では足さない［見立て: `DeepLinkPane` に Tools のサブタブの多くが無く、今のサブタブと同じ扱いで足りる］

### 11.4 return・throw・書き込みの表（`WorktreeMemPane`）

| 入力・状態 | 呼ぶ API | 出すもの | 書き込み |
|---|---|---|---|
| 作業木の mode の読みが 200・mode `on` | `GET …/worktrees/:id/mem/mode`、`GET …/repositories/:id/mem/decisions?branch=`（件数）、`MemItemsPanel` の既存の読み | 件数の行・決定の画面へのリンク・`MemItemsPanel`（作業木固定・設定はリンク） | 無し（`MemItemsPanel` の中の人の操作だけが #4227 の既存の画面の route で、その作業木へ書く） |
| mode `derived` | 同上 | 件数の行・リンク・`MemItemsPanel`（読むだけ、凍結の印） | 無し |
| mode `off`・open の決定あり | mode の読み・件数 | 「mem は off」と設定への案内、件数と決定の画面へのリンク | 無し |
| mode `off`・open の決定なし | 同上 | 「mem は off」と設定への案内だけ | 無し |
| mode の読みが 409 `ambiguous` | mode の読み | 「root の間で mode が食い違う」と root ごとの設定への案内。件数は「不明」 | 無し |
| detached（`branch: null`） | 同上 | 「ブランチが無い（detached）」だけ | 無し |
| 404（未登録・作業木が無い） | 同上 | 「mem の対象のリポジトリではない」だけ | 無し |
| 件数の読みだけが失敗 | 件数の route | 件数の行を「不明」にし、`MemItemsPanel` とリンクは出す（0 と出さない、TM3） | 無し |
| 読みの間に mode が変わった（パネルの mode ≠ `counts.mode`） | — | 件数の行を「不明」にし、次の読みで揃うのを待つ（TM3） | 無し |
| 読みの途中で作業木を切り替えた | — | 古い応答を採らない（作業木の id で捨てる） | 無し |

### 11.5 入力×状態の表（PC・スマホ共通）

| mode | ブランチ | 決定 | 件数の行 | 決定の画面へのリンク | `MemItemsPanel` |
|---|---|---|---|---|---|
| `on` | 名前あり | open あり | `承認待ち N 件・反映待ち M 件` | 出す | 出す（作業木固定・設定はリンク） |
| `on` | 名前あり | 無し | `承認待ち 0 件` | 出す | 出す |
| `derived` | 名前あり | 何でも | `open N 件・承認できない（mode derived）` | 出す | 読むだけ（凍結の印、書く操作なし）（P2） |
| `off` | 名前あり | open あり | `open N 件・承認できない（mode off）` と設定への案内 | 出す（P3） | 出さない |
| `off` | 名前あり | 無し | 出さない（「mem は off」と設定への案内） | 出さない | 出さない |
| `ambiguous` | 名前あり | — | 「件数不明」 | 出さない | 出さない |
| — | detached | — | 出さない | 出さない | 出さない |
| 読みの間に変化 | — | — | 「不明」 | 前の表示のまま | 新しい読みのとおり |

### 11.6 PR の分け方の中の位置

§6 の表の PR4 の行。PR1 のマージの後、PR2・PR3 と並列（§6 の「順（確定版）」）。

### 11.7 試験の設計（PR4）

- **PR4 の前に幅を測る**: 隔離した環境（§7 と同じ作り）で、作業木の画面を 1280×800 と 1440×900、サイドバーの開閉それぞれで開き、ヘッダーの道具の列の幅の余り（`useDesktopHeaderFit` が使う幅と、道具 1 つの幅）を測り、10 個目が畳まれずに入るかを記録する。1440 で入らなければ、PR4 の契約に幅の対策（道具の間隔・アイコンの大きさ等）を入れる
- **e2e 1440**（TM1）: 既存の `tests/e2e/header-tools-3591.spec.ts` の `TOOL_IDS` に `mem` を足し、サイドバーの開閉どちらでも 10 個すべてが見え、`header-tool-more` が 0 個
- **e2e 1280・390**（隔離したサーバ・DB）: mode `on` のブランチに `decision` を 1 件作り、作業木の画面の Tools から mem を開く → そのブランチの項目と `承認待ち 1 件` が見える → 「決定の画面へ」を押すと `/repositories/<id>/mem/decisions?branch=<name>` に着く。1280 は `header-tool-mem` が見えているか（`header-tool-more` があるか）を**読んで分岐**し、見えていれば 1 回、畳まれていれば「…」→ `mem` の 2 回で開く（既定の幅に依存しない）。390 はサブタブの列の中で `mem` を見える位置へスクロールしてから押し、押す場所が 44px 以上、ページ全体の `scrollWidth <= clientWidth`
- **単体**: §11.5 の表の行ごと（mode の応答を返す偽の fetch。陽性対照: 今の `ACTIVITIES` に `mem` が無く赤）。TM1 は `mem` を除いた列が今の列と一致（陰性対照）。TM3 は mode の読みを 2 回とも返す偽の fetch で 1 回目 `on`・2 回目 `off` を返し、件数の行が数を出さない（「不明」）。i18n は `activityBar.mem`（worktree）・`memTab`（schedule）の ja・en。アイコンの重複の試験に `mem` を含めて緑
- **TM2（書き込みに届かない）**: (1) 新しい部品（`WorktreeMemPane` 等、Tools のために足したファイル）**だけ**を対象に、ソースに書き込みのメソッドと `mem/decisions/…/preview|approve` の呼び出しが無い（`MemItemsPanel` は #4227 の書き込みを含むので対象にしない。含めると常に赤）。(2) P1 の試験: Tools の表示に作業木の選択（`mem-items-worktree`）と「mode を変える」の切り替え・`RepositoryMemSettings` が無く、設定は `<a href>` のリンクだけ。`derived` で追加・編集・閉じるのボタンが無い。(3) 陰性対照: props を渡さない `/repositories/[id]/mem` では作業木の選択と設定の切り替えが今のまま出る

## 10. 改訂の履歴

- 2026-11-13 第 3 版: CLI の承認を案 B に決定（人、2026-11-13 16:03）。§0.1・§0.2 の 1・§3.5 を書き換え。PR1 は読みの CLI だけ（`src/cli/commands/mem-decisions.ts`、件数の共有関数は `src/lib/promote/decision-counts.ts`）、URL の出力は PR2 のマージの後。実装で §3.4 に足したもの（I7 の「足すのは可」の範囲）: 一覧の JSON に `text`・`stale`・`pending`、項目の `operations[]` に `resultRef`、diff の `destination` の `reason` に `invalid_destination`（作業木の文書のパスが今の検査に当たる）、一覧の route（`promoteList`）の応答に `counts`
- 2026-11-13 第 4 版: 人の追加の要望（作業木の Tools から mem を確認する、Issue #4355 のコメント 2026-11-13 16:2x）を §11 に足し、§0.1・§6 の PR の分け方に PR4（作業木の Tools の mem、PC・スマホ、e2e 1280・390、`--last`、PR1 の後・PR2・PR3 と並列）を加えた。要決定 D1〜D4 は PM・人の確認待ち
- 2026-11-13 第 5 版: Tools の mem（§11）に事前レビュー（2-4-4、claude-5）の必須 2（1440 で畳まれない #3591 の約束と 1280 の経路・幅の実測、PR4 の書くファイルに `schedule.json`・`ActivityPane.tsx`・`SubTab` の型、並び・数を固定する試験の表）と推奨 2・3（mode の読みを 1 つに・`repositoryIds` が 2 つ以上、390 のサブタブの列の中のスクロール）を反映。PM の処分 3 点（Tools は作業木固定・mode は設定へのリンクだけ／`derived` は読むだけ／`off` に open の決定があれば件数とリンク）を §11.0 に決定として書き、D2 を (b) に。§6 を確定版に（PR1 → (PR2 → PR3) と PR4 を並列、`header-tool-*` に依存する e2e の PR は PR4 の後）
- 2026-11-13 PR2 の実装: branches の route は `src/lib/promote/decision-branches.ts` の `listDecisionBranches`（ブランチの集合＝member の root の作業木のブランチ ∪ 閉じていない `decision` を持つブランチ。件数は PR1 の `summarizeDecisionCounts` から切り出した `decisionCountsUnder`＝`decisionCountsOf`、`on` を上に名前順）。§3.1.4 の「別のブランチ・別のリポジトリ」と「閉じた・削除済み」を画面が分けられるよう、同じ route が `?item=<id>&branch=<name>` で `item: { id, where: here|elsewhere|gone }` を返す（読みだけ。別のリポジトリの項目は何も返さず `elsewhere`）。PC の「承認待ちだけ」の既定は切（§3.3 の「既定で入」はスマホの PR3）。I9 で畳まない・隠さない operation は `unknown`・`in_flight`・`approved`・`transitionPending`。e2e（`tests/e2e/mem-decisions-4355.spec.ts`）は `mem-ui-4227.spec.ts` と同じく決定の API を browser context で stub する（隔離サーバの DB・gh・作業木に触らない。サーバの答えは単体の表 `tests/unit/lib/promote/decision-branches-4355.test.ts` で固定）
