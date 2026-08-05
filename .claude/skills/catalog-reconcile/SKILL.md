---
name: catalog-reconcile
description: "組み込みスラッシュコマンドのカタログを各 CLI の権威ソースへリコンサイルする（--check で規模把握 → --write → 人手レビュー → ガードテスト更新 → 検証）"
disable-model-invocation: true
allowed-tools: "Bash, Read, Edit, Write, WebFetch"
argument-hint: "[--codex-ref <tag>] (任意。codex のソースを特定の release タグに固定する)"
---

# スラッシュコマンドカタログ リコンサイル スキル

`src/config/slash-commands-catalog.json` と `locales/{en,ja}/worktree.json` を、
各 CLI の権威ソース（claude docs / codex OSS enum @release タグ）へ合わせるスキルです。

> **このスキルは「機械が出した差分を人が確定させる」手順である。**
> `npm run catalog:refresh -- --write` は追加候補を流し込むだけで、
> **ja 訳・説明衝突・過去の除外判断の 3 点は決められない**（Phase 4）。
> そこを埋めずに commit すると、`[要レビュー]` 混じりの ja 辞書と
> 「/btw — btw」のような説明が出荷される。

## 使用方法

```bash
/catalog-reconcile                        # 通常。codex は latest release タグを取る
/catalog-reconcile --codex-ref rust-v0.146.0   # codex のソースを特定タグに固定
```

## 前提条件

- **`npm run build` を primary checkout で実行しない。** このスキルはリリース手順の一部として
  develop（＝稼働サーバの cwd）で走ることがある。build は `.next` を作り替えて `BUILD_ID` を
  変えるため、配信中の成果物を壊す（開いているタブの chunk が 404 になり遷移で client-side
  exception。**過去 3 回発生**）。build の検証は PR の CI に委ねる。
- 作業ツリーが（このスキルが触る 3 ファイル以外）クリーンであること。**stash しない**
  （他エージェント稼働中だと破損の恐れ）。
- ネットワークが通ること。通らなくても壊れはしないが、**「差分 0 件」と
  「調べられなかった」が同じ見た目になる**（Phase 1-3）。

## このスキルが触るファイル

| ファイル | 誰が書くか |
|---|---|
| `src/config/slash-commands-catalog.json` | `--write`（追加は自動。除外は人間） |
| `locales/en/worktree.json` | `--write` が heuristic 抽出した英文 → **人手で文体を正す** |
| `locales/ja/worktree.json` | `--write` が `[要レビュー]` プレースホルダを置く → **人手で全件翻訳** |
| `tests/unit/lib/standard-commands.test.ts` | 人間（件数固定テスト。禁止系ガードは触らない） |
| `tests/unit/lib/slash-command-catalog.test.ts` | 人間（`verifiedAgainst` を固定している箇所） |

---

## Phase 1: ドリフト検出（書き込みなし）

### 1-1. `--check` を実行する

```bash
npm run catalog:refresh -- --check > /tmp/catalog-check.log 2>&1; echo "CHECK=$?"
```

**exit code で判定してはいけない。** このスクリプトは正常実行なら常に exit 0 を返す
（ドリフトが 104 件あっても 0、全ソースが到達不能でも 0）。非 0 になるのは想定外の例外だけ。
判定は**出力の中身**で行う。

実測の出力例（2026-08-06 / develop 相当）:

```
Slash-command catalog reconcile
================================

Warnings (fail-soft — affected sources left untouched):
  ! antigravity provider not implemented yet (Issue #1489 Phase 2)

Not added / needs review (by category):
  [removed-row] (2)
    - [claude] /pr-comments: documented as removed; not added
    - [claude] /vim: documented as removed; not added
  [alias-row] (2)
    - [claude] /cost: alias for /usage; not added
    - [claude] /stats: alias for /usage; not added
  [suspect-description] (1)
    - [claude] /ultraplan: dropped a marker-like description: "Removed"

New commands (3):
  + [claude] /agents — As of v2.1.198, running /agents prints a reminder to ask Claude to ...
  + [claude] /schedule — Create, update, list, or run routines, which execute on Anthropic-...
  + [claude] /ultraplan — (needs description)

verifiedAgainst updates:
  ~ codex: 0.146.0 -> 0.146.1

(check mode — no files written; run with --write to apply)
```

### 1-2. 出力の 5 ブロックの読み方

| ブロック | 意味 | 対応 |
|---|---|---|
| `Warnings (fail-soft …)` | そのソースは**取得できなかった／形が変わった**。そのツールのエントリは一切触られない | Phase 1-3 へ。**無視して先へ進まない** |
| `Not added / needs review (by category)` | エンジンが分類した「そのままでは足せない行」 | 下表参照 |
| `New commands (N)` | カタログに追加される `(tool, name)` の件数 | **これが規模。Phase 2 の判断材料** |
| `verifiedAgainst updates` | 版スタンプの更新。**版固定できるソース（codex）だけ**が出る。claude docs は版スタンプが無いので `verifiedAgainst.claude` は動かない | Phase 5-2 のテストを直す |
| `In catalog but not in source (review — not auto-deleted)` | カタログにあるがソースに無い＝**削除候補**。自動削除はしない | 幻コマンドの疑い。実機で完全入力しても一致行が出ないものだけ手で消す（#1503） |

`Not added / needs review` の 4 カテゴリ（`src/lib/slash-command-reconcile/engine.ts` の
`NOTICE_CATEGORY_ORDER` が出力順）:

| カテゴリ | 何が起きたか |
|---|---|
| `removed-row` | ソースが「削除済み」と書いている行。**追加しない** |
| `alias-row` | ソースが「/X の別名」と書いている行。**追加しない** |
| `suspect-description` | 説明が `Removed` / `Alias for` / `Skill` のような行マーカーだった。**コマンドは追加されるが説明は捨てられ**、`(needs description)` になる |
| `description-conflict` | 同じ名前を 2 ツールが別の意味で持っている（Phase 4-2） |

> ⚠️ **見出しの `Not added` はこの 4 つ全部に掛かるわけではない。**
> `suspect-description` と `description-conflict` の行は**追加される**（説明だけが
> プレースホルダに落ちる）。`New commands` 側にも同じ名前が出ているかを必ず見ること。
> 上の実測例で `/ultraplan` が両方に出ているのはこのため。

### 1-3. 「0 件」と「調べられなかった」を区別する

`Warnings` にツールが挙がっていたら、**そのツールについては何も分かっていない**。
そのツールの追加候補が 0 件なのは「差分が無い」からではなく「見ていない」から。
上の実測例では antigravity provider が未実装（#1489 Phase 2）なので、
**antigravity のカタログ 13 件は今回のリコンサイルで一切照合されていない。**

報告に書くときは必ず分けること:

```
claude:      新規 3 件 / 要レビュー 5 件      ← 照合した
codex:       新規 0 件、verifiedAgainst 更新のみ ← 照合した
antigravity: 未照合（provider 未実装）          ← 「0 件」ではない
```

---

## Phase 2: リリースに載せるか、別 PR に切り出すか

**判断材料は `New commands` の件数ではなく、新規 locale キーの件数。**
人手作業の総量はここで決まる（1 キー = ja 訳 1 本 + en 文体チェック 1 本）。

```bash
# 新規 locale キー数 = 追加名のうち、まだ en 辞書に無いもの
npm run --silent catalog:refresh -- --check --json 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const j = JSON.parse(s);
  const en = require('./locales/en/worktree.json').slashCommands.descriptions;
  const names = [...new Set(j.diff.added.map(a => a.name))];
  const fresh = names.filter(n => !(n in en));
  console.log('added(tool,name)=' + j.diff.added.length,
              'uniq names=' + names.length,
              'new locale keys=' + fresh.length);
});"
```

`--json` は `{changed, diff, warnings, notices}` を返す。`npm run --silent` を使うこと
（付けないと npm のバナー 3 行が JSON の前に混ざって `JSON.parse` が落ちる）。

| 新規 locale キー | 判断 |
|---|---|
| **0〜10** | リリース commit に同梱してよい（`/release` Phase 1.5 の流れ） |
| **11 以上** | **patch リリースに載せない。** 別 PR に切り出す |

根拠（実測 2 点）:

- **v0.21.2 は 104 件 / 新規キー 86 件**だった（`#1503` 以降リコンサイルされておらず、
  カタログ 56 件に対して実コマンドが 104 件不足）。commit `ea02c9d9` の実差分は
  **5 files / 1226 insertions**。これをリリース PR に混ぜると版上げ・CHANGELOG の
  差分がカタログ 1032 行に埋もれてレビューできない。**v0.21.1 のリリースから外し、
  独立した commit にした**のはこの理由。
- 今日の 3 件のような規模は同梱してよい。

切り出す場合は `fix/<issue>-catalog-reconcile` を切り、このスキルの Phase 3 以降を
そこで回してから develop へ PR を出す。リリースは待たせない。

---

## Phase 3: 適用

```bash
npm run catalog:refresh -- --write > /tmp/catalog-write.log 2>&1; echo "WRITE=$?"
git diff --stat
```

書き換わるのは冒頭の表の 3 ファイルだけ。それ以外に差分が出たら止めて調べること。

**`--write` は追加専用。** ソースに無くなったコマンドを消すことはない
（一時的な fetch 失敗でカタログが削られるのを防ぐため）。削除は常に人間の判断。

---

## Phase 4: 機械が決められない 3 点（このスキルの本体）

`--write` の直後の状態は**出荷できない**。ここを埋めるのが人間の仕事。

### 4-1. `[要レビュー]` を全件翻訳する

`--write` は ja 辞書に `[要レビュー] <英文>` を置く（`engine.ts` の `JA_REVIEW_PREFIX`）。
**これは翻訳ではなくプレースホルダ**。全件を手で訳す。

```bash
# 残存件数（0 になるまで終わらない）
node -e "
const ja = require('./locales/ja/worktree.json').slashCommands.descriptions;
const left = Object.entries(ja).filter(([,v]) => String(v).includes('要レビュー'));
console.log('残り', left.length);
for (const [k,v] of left) console.log(' ', k, '|', v);
"
```

**文体規約**（`locales/**` の実測 130 件から。en/ja とも例外 0 件）:

| | 規約 | 例 |
|---|---|---|
| en | **大文字始まりの命令形・句点なし** | `Show session cost, plan usage limits, and activity stats` |
| ja | **簡潔な体言止め・句点なし** | `セッションのコスト・プラン使用量・アクティビティ統計を表示` |

en 側も `--write` が docs から heuristic 抽出したものなので、**そのまま信用しない**。
小文字始まりの断片（codex の enum 由来に多い。v0.21.2 では 21 件）や
句点付きの文が混ざる。同じ規約へ正規化する。

**説明に `<...>` を書かないこと。** 説明の安全ガードが
`dangerousPatterns = [/<[^>]+>/, /javascript:/i, /onerror=/i, /onclick=/i]` で
**en/ja 両辞書のテキストを検査する**（`tests/unit/lib/standard-commands.test.ts:377`）。
v0.21.2 では `/sandbox-add-read-dir` の説明が `<absolute_path>` を含んでいて実際に赤くなった。
**角括弧で書く**:

```
✗ Let sandbox read a directory: /sandbox-add-read-dir <absolute_path>
✓ Let sandbox read a directory: /sandbox-add-read-dir [absolute-path]
✓ サンドボックスに読み取り可能なディレクトリを追加: /sandbox-add-read-dir [絶対パス]
```

### 4-2. 説明がコマンド名そのものになっている衝突を直す

**仕組み**: 説明は `slashCommands.descriptions.<name>` という**名前由来の 1 キー**に
解決される。claude と codex が同名で別の意味を持つと、両者が同じキーを共有してしまう。
`engine.ts` は先勝ちで片方の文を出荷することを拒み、**両方を捨てて
「コマンド名そのもの」をプレースホルダに置く**。結果、パレットには `/btw — btw` と出る。

`--check` / `--write` の出力では `[description-conflict]` カテゴリに現れる:

```
[description-conflict] (1)
  - /btw: tools disagree on the description ("..." vs "..."); left as a review placeholder
```

**直し方**: 両ツールの意味を含む 1 文に書き直す。片方の文をコピーしないこと
（もう一方のツールで嘘になる）。v0.21.2 では 6 件（`/btw` `/copy` `/ide` `/rename`
`/stop` `/theme`）がこれに該当した。

```bash
# 説明がコマンド名と同一になっていないか（衝突の残骸の検出）
node -e "
const en = require('./locales/en/worktree.json').slashCommands.descriptions;
const bad = Object.entries(en).filter(([k,v]) => k === v);
console.log(bad.length ? bad.map(([k]) => k).join(', ') : 'なし');
"
```

### 4-3. 過去の除外判断と突き合わせる

**ツールは curation の履歴を知らない。** 過去に意図的に外したものを毎回また足してくる。
除外判断が 1 箇所にまとまったリストは**まだ無い**（Issue #1706 本文の `#B1`）。
現時点の在り処は 2 つ:

```bash
# 1) テストのコメント（何を禁止しているか＋その理由）
grep -n "does not add\|must not be\|phantom\|Issue #150" tests/unit/lib/standard-commands.test.ts

# 2) 過去のリコンサイル commit の本文（判断の記録はここが最も詳しい）
git log --format="%h %s%n%b" --grep="リコンサイル\|reconcile\|幻コマンド" -i -- src/config/slash-commands-catalog.json
```

現在有効な除外（2026-08-06 時点の実測）:

| 対象 | 理由 |
|---|---|
| `/ultraplan` | claude docs の説明が `Removed` マーカー。#1502/#1503 で除いた幻コマンドと同型 |
| `/schedule` | #1488 で対象外と判断済み |
| `/agents` の claude entry | #1503 が除いた `(removed)` スタブ。opencode の 1 件のみ残す |
| `/compact` `/status` `/review` の antigravity 露出 | agy 1.1.3 に存在しない（#1502）。露出すると send で誤実行する |
| `/vim` の **claude** 露出 | claude 2.1.92 で上流削除。**codex には残す**（下記） |

#### リストに無いのに怪しいものは、上流ソースを実際に取得して裏取りする

「怪しいから外す」で済ませない。**過去の判断が、当時見ていた範囲でしか正しくないことがある。**

v0.21.2 の実例: テストは `/vim` を**名前ごと**禁止していた。claude だけを見ていた時点では
正しい。しかし codex の enum を実際に取得すると `SlashCommand::Vim` が実在し、
名前で禁じると**実在する codex コマンドを隠していた**。禁止を「claude に出さない」へ狭めた。

裏取りのコマンド（実測済み。HTTP 200 / `SlashCommand::Vim` を確認）:

```bash
# codex: enum を release タグ固定で生で取る
TAG=rust-v0.146.1     # verifiedAgainst.codex に対応するタグ
curl -sS "https://raw.githubusercontent.com/openai/codex/${TAG}/codex-rs/tui/src/slash_command.rs" \
  -o /tmp/slash_command.rs -w "HTTP=%{http_code}\n"
grep -n "SlashCommand::Vim" /tmp/slash_command.rs

# claude: provider が読んでいるドキュメントそのもの
curl -sS https://code.claude.com/docs/en/commands.md -o /tmp/claude-commands.md -w "HTTP=%{http_code}\n"
grep -n "^| \`/vim\`" /tmp/claude-commands.md
```

ソース URL は provider に定義されている（`src/lib/slash-command-reconcile/providers/{claude,codex}.ts`）。
**手で URL を組み立てず、そこから読むこと。**

判定の型:

- ソースに**実在した** → 禁止をそのツールに限定する（名前ごと禁止しない）
- ソースに**無い / `Removed` と書かれている** → 除外を維持し、テストのコメントに
  「どのソースのどの版でどう書かれていたか」を残す

---

## Phase 5: ガードテストの更新

### 5-1. 件数を固定しているテスト（curated set の実数に合わせる）

| ファイル:行 | 何を固定しているか | 述語 |
|---|---|---|
| `tests/unit/lib/standard-commands.test.ts:48` | 総数 | `STANDARD_COMMANDS.length` |
| `…:210` | codex 可視数 | `cliTools?.includes('codex')` |
| `…:338` | claude 可視数 | `!cliTools \|\| cliTools.includes('claude')` |
| `…:136` | antigravity 可視数 | `cliTools?.includes('antigravity')` |
| `…:201` | opencode 可視数 | `cliTools?.includes('opencode')` |

> **⚠️ 件数の数え方はツールごとに述語が違う。揃えて数えると実数とずれる。**
> claude だけが `!cliTools ||`（＝ `cliTools` 未指定を claude 扱いする）で、
> 他は `cliTools?.includes(...)` の厳密一致。この非対称は
> `engine.ts` の `entryHasTool()`（「undefined cliTools = claude」）と同じ規約。
>
> **実測（2026-08-06 のカタログ 159 件）**:
>
> | 数え方 | 結果 |
> |---|---|
> | codex `cliTools?.includes('codex')` | **53** ← 正 |
> | codex `!cliTools \|\| includes('codex')` | 58 ← 誤り |
> | claude `!cliTools \|\| includes('claude')` | **97** ← 正 |
> | `cliTools` 未指定のエントリ | 5（この 5 件が 53 と 58 の差） |
>
> v0.21.2 で実際にこの取り違えをして codex を 58 と報告し、正は 53 だった。
> **必ずテスト本体と同じ述語で数えること**:

```bash
node -e "
const c = require('./src/config/slash-commands-catalog.json').commands;
console.log('total ', c.length);
console.log('claude', c.filter(x => !x.cliTools || x.cliTools.includes('claude')).length);
for (const t of ['codex','opencode','antigravity'])
  console.log(t.padEnd(6), c.filter(x => x.cliTools?.includes(t)).length);
"
```

コメントは「何がその数を守っているか」を残す形で更新する。数字だけ書き換えない:

```ts
// Issue #1503: -2 codex phantoms (approvals/undo) removed → 23.
// v0.21.2: reconciled against the codex 0.146.0 enum → 53.
it('should have 53 commands available for Codex', () => {
```

### 5-2. `verifiedAgainst` を固定しているテスト

`verifiedAgainst updates` が出たら `tests/unit/lib/slash-command-catalog.test.ts:316`
（`getCatalogStaleness` の期待値）も直す。ここを忘れると、赤の原因がカタログ件数ではなく
staleness 判定側にあることに気づくまで時間を溶かす。

```bash
grep -n "verifiedAgainst: '" tests/unit/lib/slash-command-catalog.test.ts
```

### 5-3. 触ってはいけないガード

**「何を入れてはいけないか」を守っているテストは、赤くなっても数字を合わせない。**
赤いなら Phase 4-3 の除外判断が漏れている。

| ファイル:行 | 守っているもの |
|---|---|
| `standard-commands.test.ts:112` | 幻コマンド（`compact`/`status`/`review`）を antigravity に露出しない（#1502） |
| `…:472` | `/schedule` を足さない・`/vim` を claude に出さない |
| `…:360` | コマンド名が `/^[a-z][a-z0-9-]*$/` に一致する |
| `…:377` | 説明に HTML タグ・`javascript:` 等を含まない（4-1 の `<...>` はここで落ちる） |
| `…:344` | `/agent`（codex）と `/agents`（opencode）の説明が別テキストである |

これらが赤いときの正しい対応は**カタログか辞書を直すこと**であって、期待値を緩めることではない。

---

## Phase 6: 検証

```bash
npm run lint      > /tmp/cat-lint.log 2>&1; echo "LINT=$?"
npx tsc --noEmit  > /tmp/cat-tsc.log  2>&1; echo "TSC=$?"
npm run test:unit > /tmp/cat-unit.log 2>&1; echo "UNIT=$?"
```

**`> ファイル 2>&1; echo $?` の形を崩さないこと。** `| grep` に繋ぐと exit code が grep の
ものに化け、失敗を成功として読む。全テスト緑に見えて Unhandled Rejection で exit 1、という
形もある。**3 つとも 0 であること。**

**`npm run build` は回さない**（「前提条件」参照）。build の検証は PR の CI に委ねる。

マシン負荷が高いと full suite で無関係なテストが偽失敗することがある。落ちたテストが
カタログと無関係なら単独実行で確認し、その旨を報告する:

```bash
npx vitest run tests/unit/lib/standard-commands.test.ts tests/unit/lib/slash-command-catalog.test.ts \
  > /tmp/cat-unit-single.log 2>&1; echo "SINGLE=$?"
```

---

## Phase 7: commit

```bash
git add src/config/slash-commands-catalog.json locales/en/worktree.json locales/ja/worktree.json \
        tests/unit/lib/standard-commands.test.ts tests/unit/lib/slash-command-catalog.test.ts
git commit
```

commit message に**必ず残すこと**（次にリコンサイルする人が Phase 4-3 で読む唯一の記録）:

- ドリフト規模（新規 `(tool, name)` 件数 / 新規 locale キー数）
- **除外したものと、その理由**（どのソースのどの版でどう書かれていたか）
- **過去の判断を変えたものと、変えた根拠**（上流ソースの実測結果）
- 件数固定テストの遷移（`56 -> 159` のように）
- `verifiedAgainst` の遷移

`ea02c9d9` がこの形の実例。

---

## エラー時の対応

| 症状 | 対応 |
|---|---|
| `--check` が exit 0 なのに何も出ない | **正常**（差分なし）とは限らない。`Warnings` にツールが挙がっていないかを見る。挙がっていれば「未照合」であって「0 件」ではない |
| `Warnings` に全ソースが挙がる | ネットワーク／ソースの体裁変更。カタログは触られていないので、そのままリコンサイルをスキップしてよい |
| `--json` が `JSON.parse` で落ちる | `npm run` のバナーが混ざっている。`npm run --silent` を使う |
| 件数テストが赤い | 5-1 の述語どおりに数え直す。**揃えて数えない** |
| 説明の安全ガードが赤い | 4-1 の `<...>`。角括弧に直す |
| 幻コマンド禁止／antigravity 非露出が赤い | **期待値を直さない。** 除外し損ねたものが入っている（4-3） |
| `getCatalogStaleness` が赤い | 5-2 の `verifiedAgainst` 期待値 |
| 別のツールの件数まで動いた | `--write` は追加専用。想定外の減少は差分を読んで原因を特定する |

## 安全ガード

- **primary checkout で `npm run build` を回さない**（稼働サーバの `.next` を壊す。過去 3 回発生）
- **`--check` の exit code で判定しない**（ドリフトがあっても 0）
- **fail-soft 警告を無視しない**（「0 件」と「未照合」を混同しない）
- **`--write` の出力をそのまま commit しない**（Phase 4 の 3 点が必ず残っている）
- **禁止系ガードの期待値を緩めない**（赤いのは除外漏れのサイン）
- **除外判断を消さない**（テストのコメントと commit message が唯一の記録）

## 参考

- [`/release` スキル](../release/SKILL.md) Phase 1.5 — リリース時にこの手順を呼ぶ箇所
- `scripts/refresh-slash-command-catalog.ts` — ランナー（`--check` / `--write` / `--json` / `--codex-ref`）
- `src/lib/slash-command-reconcile/engine.ts` — 追加・拒否・衝突の判定本体
- `src/lib/slash-command-reconcile/providers/` — 各ソースの URL とパース
- `src/lib/slash-command-reconcile/sanitize.ts` — 名前の allowlist と説明の正規化
- Issue #1489（リコンサイル基盤） / #1502・#1503（幻コマンド） / #1603（history / alias 行の拒否）
