---
name: catalog-reconcile
description: "組み込みスラッシュコマンドのカタログを各 CLI の権威ソースへリコンサイルする（--check で規模把握 → --write → 人手レビュー → attestation の採り直し → 検証）"
disable-model-invocation: true
allowed-tools: "Bash, Read, Edit, Write, WebFetch"
argument-hint: "[--codex-ref <tag>] (任意。codex のソースを特定の release タグに固定する)"
---

# スラッシュコマンドカタログ リコンサイル スキル

`src/config/slash-commands-catalog.json` と `locales/{en,ja}/worktree.json` を、
各 CLI の権威ソース（claude docs / codex OSS enum @release タグ）へ合わせ、
**その読み取りを `src/config/slash-commands-attestations.json` に記録し直す**スキルです。

> **このスキルは「機械が出した差分を人が確定させる」手順である。**
> `npm run catalog:refresh -- --write` は追加候補を流し込むだけで、
> **ja 訳・説明衝突・過去の除外判断の 3 点は決められない**（Phase 4）。
> そこを埋めずに commit すると、`[要レビュー]` 混じりの ja 辞書と
> 「/btw — btw」のような説明が出荷される。

> **attestation は機械が書かない（Issue #2026）。**
> 「版 V で source S は tool T についてこの集合を列挙した」という記録は
> `--write` の対象外で、**人がソースを読んで書くときだけ動く**。
> カタログ側の pin が守る不変条件は
> `catalog(tool) ≡ attested(tool) \ excluded(tool)` なので、`--write` だけを適用すると
> `[<tool>] /<name> is in the catalog but not attested` で赤くなる。
> **それが審査ゲートである。** カタログからコピーして緑にするとゲートが恒真になり、
> 「ソースがこう言っていた」が「カタログがこうなっている」の言い換えに退化する。

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
| `src/config/slash-commands-exclusions.json` | 人間（除外の**意図**＝「ソースに在るが載せない」。engine はここを読んで再提案をやめる） |
| `src/config/slash-commands-attestations.json` | **人間だけ**（Issue #2026。「ソースが列挙した集合そのもの」＋版＋採取日。`--write` は触らない） |
| `tests/unit/lib/standard-commands.test.ts` | 原則**触らない**（Issue #2026 で件数 pin は撤去され、期待値は attestation から導出される）。禁止系ガードは絶対に触らない |
| `tests/unit/lib/slash-command-catalog.test.ts` | 人間（attestation の `version` を上げたときだけ。`verifiedAgainst` リテラルを持つ箇所） |

---

## Phase 1: ドリフト検出（書き込みなし）

### 1-1. `--check` を実行する

```bash
npm run catalog:refresh -- --check > /tmp/catalog-check.log 2>&1; echo "CHECK=$?"
```

**exit code で判定してはいけない。** このスクリプトは正常実行なら常に exit 0 を返す
（ドリフトが 104 件あっても 0、全ソースが到達不能でも 0）。非 0 になるのは想定外の例外だけ。
判定は**出力の中身**で行う。

実測の出力例（2026-08-24 / Issue #2026 のブランチ。codex の attestation が
まだ 0.149.0 を記録していた時点のもの。説明文は横幅のため一部省略）:

```
Slash-command catalog reconcile
================================

Honoring 4 exclusion(s) from src/config/slash-commands-exclusions.json
Holding 5 attestation(s) from src/config/slash-commands-attestations.json:
  = claude: 104 command(s) read off claude 2.1.218 on 2026-08-24 (#2026)
  = codex: 56 command(s) read off codex 0.149.0 on 2026-08-24 (#2026)
  = antigravity: 13 command(s) read off antigravity 1.1.3 on 2026-07-24 (#1502)
  = copilot: 68 command(s) read off copilot 1.0.80 on 2026-08-22 (#1913)
  = opencode: 18 command(s) read off opencode 1.18.21 on 2026-08-22 (#1913)

Warnings (fail-soft — affected sources left untouched):
  ! antigravity provider not implemented yet (Issue #1489 Phase 2)

Not added / needs review (by category):
  [excluded] (2)
    - [claude] /schedule: excluded as out-of-scope (#1488): Real upstream with a ...
    - [claude] /ultraplan: excluded as phantom (#1503): The claude docs row carries ...
  [removed-row] (2)
    - [claude] /pr-comments: documented as removed; not added
    - [claude] /vim: documented as removed; not added
  [alias-row] (2)
    - [claude] /cost: alias for /usage; not added
    - [claude] /stats: alias for /usage; not added

No new commands to add.

verifiedAgainst updates (not applied — re-attest by hand):
  ~ codex: 0.149.0 -> 0.149.1

(check mode — no files written; run with --write to apply)
```

**この実測が示していること**: 追加は 0 件だが「やることなし」ではない。上流の codex は
rust-v0.149.1 まで進んでおり、attestation が記録している版は 0.149.0 である。
#2026 より前ならこの版差は `--write` が黙って書き込んでいた（＝誰も読み直していない版に
対してスタンプだけが進んだ）。今は人が読み直して attestation を採り直す（Phase 5-1）。

集合そのものが食い違ったときは、もう 1 ブロック出る。実測（コミット済み fixture
`tests/unit/lib/slash-command-reconcile/fixtures/check-attestation-drift-2026-08-24.txt`。
codex の attestation を 1 版・1 コマンドだけ戻して採ったもの）:

```
Attestation drift (the recorded reading no longer matches the source):
  * [codex] source now lists /pwd; source no longer lists /zzz-retired
```

### 1-2. 出力ブロックの読み方

| ブロック | 意味 | 対応 |
|---|---|---|
| `Honoring N exclusion(s) …` | いま engine が honor している「載せない」判断の件数 | 中身は Phase 4-3 |
| `Holding N attestation(s) …` | いま pin が拠っている読み取り（tool / 件数 / 版 / 採取日 / Issue） | ここが古いなら Phase 5-1 |
| `Warnings (fail-soft …)` | そのソースは**取得できなかった／形が変わった**。そのツールのエントリは一切触られない | Phase 1-3 へ。**無視して先へ進まない** |
| `Not added / needs review (by category)` | エンジンが分類した「そのままでは足せない行」 | 下表参照 |
| `New commands (N)` | カタログに追加される `(tool, name)` の件数 | **これが規模。Phase 2 の判断材料** |
| `verifiedAgainst updates (not applied — re-attest by hand)` | **報告のみ**。ソースの版が attestation の `version` より進んでいる。版固定できるソース（codex）だけが出る（claude docs は版スタンプが無いので出ない） | Phase 5-1 で attestation を採り直すか、据え置く判断をする。**適用するものは存在しない**（#2026） |
| `Attestation drift (…)` | 記録した**集合**とソースの現状の差。`source now lists /X`＝ソースが増えた、`source no longer lists /X`＝ソースから消えた | Phase 5-1。**上流の削除は追加 0 件でここだけが出る** |
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
claude:      新規 3 件 / 要レビュー 5 件            ← 照合した
codex:       新規 0 件、ソースの版だけ先行（要 re-attest） ← 照合した
antigravity: 未照合（provider 未実装）              ← 「0 件」でも「attestation が正しい」でもない
```

**antigravity / copilot / opencode の attestation は `--check` が一切検証しない。**
provider が無いので `Attestation drift` にも出ない（Phase 4-4 で手で照合する）。

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

書き換わるのは `src/config/slash-commands-catalog.json` と
`locales/{en,ja}/worktree.json` の 3 ファイルだけ。それ以外に差分が出たら止めて調べること。
**`src/config/slash-commands-attestations.json` はここでは動かない**（Issue #2026。
記録し直すのは Phase 5-1 で、人が読んでからである）。

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
**en/ja 両辞書のテキストを検査する**
（`tests/unit/lib/standard-commands.test.ts` の
`should have all descriptions without HTML tags or dangerous patterns`）。
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
判断の正本は **`src/config/slash-commands-exclusions.json`**（Issue #1704）で、engine は
これを読んで再提案をやめる。**この手順書に一覧をコピーしない** — 過去にコピーを置いた結果、
`/agents` の行が #1767 / #2024 で覆されたあとも「opencode の 1 件のみ残す」と書き続けていた。
その場で実物を読むこと:

```bash
# 1) 判断の正本（name / cliTools / kind / reason / issue が全部入っている）
node -e "
for (const e of require('./src/config/slash-commands-exclusions.json').exclusions)
  console.log(\`/\${e.name}\`.padEnd(18), e.cliTools.join(',').padEnd(10), e.kind.padEnd(13), '#'+e.issue, e.reason);
"

# 2) 判断の全文（なぜ pin を緩めないか、何がこのファイルで表現**できない**か）
node -e "console.log(require('./src/config/slash-commands-exclusions.json').\$comment.join('\n'))"

# 3) exclusions.json に無い禁止（テストだけが守っているもの）
grep -n "does not add\|must not be\|must stay off\|must be gone\|NOT expose" tests/unit/lib/standard-commands.test.ts

# 4) 過去のリコンサイル commit の本文
git log --format="%h %s%n%b" --grep="リコンサイル\|reconcile\|幻コマンド" -i -- src/config/slash-commands-catalog.json
```

`kind` の 2 値は再判断コストが桁違いなので混ぜない:

| kind | 意味 | 誰が解除できるか |
|---|---|---|
| `phantom` | そのツールに実在しない（履歴行・マーカー・スタブ） | **上流が変われば自動決着**。実在し始めたら行を消す |
| `out-of-scope` | 上流に実在し説明も正しいが、方針として載せない | **人の再判断だけ** |

`out-of-scope` は「上流に実在」の意味なので、当該 tool の attestation が必ずその名前を
列挙していなければならない（`backs every out-of-scope exclusion with an attestation that
lists it` が固定している）。`phantom` にはこの制約が無い — `/ultraplan` は docs のスタブ行を
パーサが active と読むので attested、`/streamer-mode` は copilot のどの面にも無いので
attested でない。どちらも正しく phantom である。

**exclusions.json に無い禁止**（テストだけが守っている。上の grep 3 で確認できる）:

| テスト | 守っているもの |
|---|---|
| `should NOT expose phantom commands (compact/status/review) to Antigravity` | agy 1.1.3 に無い 3 件（#1502）。露出すると send で誤実行する |
| `does not add /schedule, and keeps /vim off claude` | `/vim` は claude 2.1.92 で上流削除（docs が `Removed` と書くので attested でもない）。**codex には実在するので残す** |
| `does not carry the Issue #1503 phantom commands` | 幻 5 件（cost / lazy / todos / pr-comments / approvals）と、`/undo` の **codex** 露出（#1503）。**copilot の `/undo` は実在するので残す** |

#### リストに無いのに怪しいものは、上流ソースを実際に取得して裏取りする

「怪しいから外す」で済ませない。**過去の判断が、当時見ていた範囲でしか正しくないことがある。**

v0.21.2 の実例: テストは `/vim` を**名前ごと**禁止していた。claude だけを見ていた時点では
正しい。しかし codex の enum を実際に取得すると `SlashCommand::Vim` が実在し、
名前で禁じると**実在する codex コマンドを隠していた**。禁止を「claude に出さない」へ狭めた。

裏取りのコマンド（実測済み。HTTP 200 / `SlashCommand::Vim` を確認）:

```bash
# codex: enum を release タグ固定で生で取る
# 対応するタグは attestation の codex 行から取る:
#   node -e "console.log(require('./src/config/slash-commands-attestations.json')
#     .attestations.find(a => a.tool === 'codex').version)"
TAG=rust-v0.149.1     # attestation の codex.version に対応するタグ
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

## Phase 4-4: provider が無いツール（copilot / opencode）を手で照合する

`src/lib/slash-command-reconcile/providers/` にあるのは **claude / codex / antigravity(stub)** だけである。
**copilot と opencode は `--check` / `--write` に一切現れない。** `Warnings` にも出ない
（provider が無いので「そのツールが存在しない」のと同じ扱いになる）。Phase 1-3 の
「0 件と未照合を区別する」がここでは効かないので、**この 2 ツールは毎回手で照合する**。

Issue #1913 でこの手順を実測した。以下はそのときのレシピと結果である。

### copilot: 2 面ある。両方を採る

```bash
copilot help commands            # 面 A: 公称の一覧（1.0.80 で 67 行）
```

`help commands` は**隠しエイリアスを落とす**。1.0.80 では `/undo` が help に無いのに
パレットには居た（`/rewind` と同じ説明）。逆に `/footer` と `/rewind` は help にあるのに
パレットのスクロール一覧には出ず、**完全入力したときだけ**行が出る。したがって
**採用集合は「help ∪ パレット」**であって、どちらか片方ではない。

面 B（パレット）は私設ソケットの実 TUI で採る:

```bash
tmux -L cmcat new-session -d -s cp -x 200 -y 50 -c /tmp/probe 'bash -l'
tmux -L cmcat send-keys -t cp 'gh copilot' Enter; sleep 12
tmux -L cmcat send-keys -t cp -l '/'; sleep 1.5
for i in $(seq 1 160); do
  tmux -L cmcat capture-pane -p -t cp | grep -oE '/[a-z][a-z0-9-]*  +[^ ]'
  tmux -L cmcat send-keys -t cp Down; sleep 0.2
done | grep -oE '^/[a-z][a-z0-9-]*' | sed 's|/||' | sort -u
tmux -L cmcat kill-server
```

**`-L` を必ず付ける。** 素の `tmux` はユーザーの本番セッションに届く。

### 幻の判定は「`/` を打ってから 1 文字ずつ」でしか成立しない

**`send-keys -l '/streamer-mode'` のように一括で流し込むとドロップダウンが開かない。**
開いていない画面を見て「候補が無い＝幻」と読むと、**実在するコマンドまで幻に見える**
（`/undo` `/statusline` `/footer` で実際にそうなった）。正しい撃ち方:

1. `C-u` で composer を空にする
2. `/` を単独で送る（ここでドロップダウンが開く）
3. 残りを **1 文字ずつ** 送る（`sleep 0.1` 程度）
4. 陰性対照 `/zzzz`（行が出ない）と陽性対照（実在コマンド）を**同じ手順で必ず撃つ**

opencode 側の罠は別方向で、**候補の絞り込みが説明文へのファジーマッチ**である。
`/compact` は `/review` の説明（`… defaults to uncommitted`）に部分列一致して
1 行返す。**行が出たことではなく、`/<name>` の行が出たことを見る。**

### opencode: パレットは循環スクロールで 1 画面 10 行

```bash
tmux -L cmcat new-session -d -s oc -x 200 -y 60 -c /tmp/probe 'bash -l'
tmux -L cmcat send-keys -t oc 'opencode' Enter; sleep 10
tmux -L cmcat send-keys -t oc -l '/'; sleep 2
for i in $(seq 1 25); do
  tmux -L cmcat send-keys -t oc Down; sleep 0.35
  tmux -L cmcat capture-pane -p -t oc | grep -E '┃ /[a-z]' | sed -E 's/^ *┃ //; s/ *┃ *$//'
done | sort -u
tmux -L cmcat kill-server
```

一覧は末尾で先頭へ戻るので、**Down の回数が行数を超えても止まらない**。
`sort -u` が増えなくなるまで回すこと（1.18.21 は 18 行）。

### 版は起動実体で採る

attestation の `version` に入れる版は **CommandMate が起動する実行体**から採る
（`CATALOG_VERIFIED_AGAINST` はここから導出されるので、陳腐化判定が比べる相手と
同じ実行体でなければ意味を成さない）。copilot は
`COPILOT_LAUNCH_COMMAND = 'gh copilot'` なので `gh copilot -- --version` であって、
PATH 上の裸の `copilot` ではない（`VERSION_PROBES` も同じ規約。
docs/design/multi-agent-state-architecture.md §4 D2 / DR4-010）。

```bash
gh copilot -- --version     # GitHub Copilot CLI 1.0.80.
opencode --version          # 1.18.21
```

**起票時の版を信用しない。** #1913 は opencode 1.18.20 で起票されたが、着手時には
1.18.21 に上がっており、`/variants` が 1 件増えていた。

---

## Phase 5: attestation を採り直す（審査の本体）

**Issue #2026 でこのフェーズの中身が入れ替わった。** かつてはここで「件数を固定しているテストの
数字を直す」ことをしていた（`toBe(244)` / `toBe(56)` / `toBe(102)` …）。その数字の根拠は
commit message にしか残らず、次のリリースで同じ調査をやり直すことになっていた。

いまカタログ pin が守る不変条件は

```
catalog(tool) ≡ attested(tool) \ excluded(tool)
```

で、期待値は `src/config/slash-commands-attestations.json` から導出される。
**直すのはテストではなくこのファイル**である。

### 5-1. `slash-commands-attestations.json` を書き直す

**やる条件**（1 つでも当てはまれば必須）:

- `--write` で `New commands` を適用した
- `--check` の `Attestation drift (…)` に行が出た
- `--check` の `verifiedAgainst updates …` に行が出て、その版で読み直す判断をした
- Phase 4-4 で copilot / opencode を手で照合した（provider が無いので `--check` は何も言わない）

**やり方**: 当該 tool の `source` フィールドが指す先を**実際に開いて読み**、

| フィールド | 書くもの |
|---|---|
| `commands` | ソースが列挙した名前の**全集合**。ソート済み・重複なし（ローダが強制する）。**curation は引かない** — `/schedule` のように「実在するが載せない」ものも入れる（引き算は exclusions.json 側の仕事） |
| `version` | Phase 4-4 の「版は起動実体で採る」に従った版。`major.minor.patch` |
| `observedAt` | **実際に読んだ日**（`YYYY-MM-DD`）。claude docs のように版固定できないソースでは、これだけが再現座標になる |
| `source` | 同じ測定をもう一度やるための**指示**。引用ではない（20 文字未満はローダが弾く） |
| `issue` | その読み取りを行った Issue 番号 |

`commands` は「ソースが現に配っているコマンド」＝ **active かつ canonical な行だけ**。
claude docs の表は履歴行（`Removed in vX`）と `Alias for /X` 行を含むが、それらはコマンドではない。

claude / codex は provider が同じ抽出をしているので、突き合わせに使える:

```bash
# provider が読んだ active/canonical 集合をそのまま出す（--check と同じ経路）
npx tsx -e "
import { fetchClaudeCommands } from './src/lib/slash-command-reconcile/providers/claude';
import { fetchCodexCommands } from './src/lib/slash-command-reconcile/providers/codex';
(async () => {
  for (const [tool, r] of [['claude', await fetchClaudeCommands({})],
                           ['codex',  await fetchCodexCommands({})]]) {
    const active = r.commands.filter(c => c.status !== 'removed' && !c.aliasOf).map(c => c.name).sort();
    console.log(tool, r.ok, r.sourceVersion ?? '(版スタンプ無し)', active.length);
    console.log(JSON.stringify(active));
  }
})();
"
```

> **これをコピペで済ませない。** provider は「ソースの読み方」の実装であって、
> ソースそのものではない。パーサの取りこぼし（#1603 の履歴行、#1704 の説明衝突）は
> まさにこの経路で起きてきた。**ソースを開いて件数と境界を目視してから**貼ること。
> copilot / opencode / antigravity には provider が無いので、Phase 4-4 の実 TUI 採取が唯一の手段。

### 5-2. `verifiedAgainst` リテラルを持つテスト

attestation の `version` を上げたときだけ直す（`--check` の `verifiedAgainst updates` が
出ただけでは直さない。**版を上げるのは人の判断**であり、上げなければテストは緑のまま）。

```bash
grep -n "verifiedAgainst: '" tests/unit/lib/slash-command-catalog.test.ts
```

現状のリテラル（2026-08-24 実測）:

| テスト | 持っているリテラル |
|---|---|
| `marks a tool stale when the installed CLI is newer than verifiedAgainst` | claude の版（codex 側は `CATALOG_VERIFIED_AGAINST.codex` を読むので直さなくてよい） |
| `reports opencode and copilot against their catalog verifiedAgainst` | opencode / copilot の版 |
| `getCatalogStalenessSnapshot` の describe 内 | claude の版 |

ここを忘れると、赤の原因が attestation ではなく staleness 判定側にあることに気づくまで
時間を溶かす。

### 5-3. 触ってはいけないガード

**「何を入れてはいけないか」を守っているテストは、赤くなっても期待値を合わせない。**
赤いなら Phase 4-3 の除外判断か Phase 5-1 の attestation が漏れている。

| テスト（`tests/unit/lib/standard-commands.test.ts`） | 守っているもの |
|---|---|
| `ships exactly the attested command set for every tool` | `catalog ≡ attested \ excluded`。赤いときは**カタログか attestation か exclusions のどれかが実態とずれている** |
| `should NOT expose phantom commands (compact/status/review) to Antigravity` | agy 1.1.3 に無い 3 件を露出しない（#1502） |
| `does not add /schedule, and keeps /vim off claude` | `/schedule` を足さない・`/vim` を claude に出さない |
| `does not carry the Issue #1503 phantom commands` | 幻 5 件を足さない・`/undo` を **codex** に出さない（copilot には出す） |
| `should have all command names matching allowed pattern /^[a-z][a-z0-9-]*$/` | コマンド名の allowlist |
| `should have all descriptions without HTML tags or dangerous patterns` | 説明に HTML タグ・`javascript:` 等を含まない（4-1 の `<...>` はここで落ちる） |
| `agent (Copilot) and agents (OpenCode/Claude/Codex) have distinct descriptions` | 同名・別意味のコマンドが説明を共有しない |
| `keeps the version stamp out of the catalog file` | `verifiedAgainst` を `slash-commands-catalog.json` へ書き戻さない（二重管理の復活） |

これらが赤いときの正しい対応は**カタログ・辞書・attestation・exclusions のどれかを直すこと**
であって、期待値を緩めることではない。

`ships exactly the attested command set for every tool` の失敗メッセージは
どちら向きにずれたかを名指しする:

| メッセージ | 意味 | 対応 |
|---|---|---|
| `/X is in the catalog but not attested` | `--write` を適用したが attestation を採り直していない、または幻が入った | 5-1（実在するなら）／カタログから消す（幻なら＋exclusions.json に記録） |
| `/X is attested but missing from the catalog` | ソースに在るのにカタログに無い | カタログへ追加する。**意図的に載せないなら exclusions.json に行を足す**（それが不在の正当な理由になる） |
| `/X is in the catalog although it is excluded` | 除外したはずのものが入っている | カタログから消す |
| `no attestation covers this tool` | カタログが配っている tool の attestation が無い | その tool の読み取りを 5-1 の手順で新規に採る |

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
  tests/unit/lib/slash-command-reconcile/ \
  > /tmp/cat-unit-single.log 2>&1; echo "SINGLE=$?"
```

attestation を編集したなら、**ローダが読めることを先に確かめる**と原因の切り分けが速い
（不正行は skip されず throw するので、import しているテストが軒並み赤くなる）:

```bash
npx tsx -e "
import { DEFAULT_ATTESTATIONS } from './src/lib/slash-command-reconcile/attestations';
for (const a of DEFAULT_ATTESTATIONS)
  console.log(a.tool.padEnd(12), a.version.padEnd(9), a.observedAt, String(a.commands.length).padStart(4));
"
```

---

## Phase 7: commit

```bash
git add src/config/slash-commands-catalog.json locales/en/worktree.json locales/ja/worktree.json \
        src/config/slash-commands-attestations.json
# 除外を足した／狭めたなら:
git add src/config/slash-commands-exclusions.json
# 5-2 で staleness テストのリテラルを直したなら:
git add tests/unit/lib/slash-command-catalog.test.ts
git commit
```

> `tests/unit/lib/standard-commands.test.ts` は**原則ここに出てこない**（Issue #2026）。
> 出てくるなら、期待値を直しにいっていないか確認すること — 直すべきは
> attestation か exclusions かカタログである。

commit message に**必ず残すこと**:

- ドリフト規模（新規 `(tool, name)` 件数 / 新規 locale キー数）
- **除外したものと、その理由**（どのソースのどの版でどう書かれていたか）
- **過去の判断を変えたものと、変えた根拠**（上流ソースの実測結果）
- **attestation の遷移**（tool ごとに `version` / `observedAt` / 件数がどう動いたか）

attestation を導入する前は、この最後の 1 点が commit message にしか残らないことが問題だった
（次のリリースで同じ調査をやり直す羽目になる）。いまは
`src/config/slash-commands-attestations.json` が正本なので、commit message は
**その diff を読む人向けの補足**である。判断の実体をここだけに書かないこと。

`ea02c9d9` が（attestation 導入前の形ではあるが）記述の粒度の実例。

---

## エラー時の対応

| 症状 | 対応 |
|---|---|
| `--check` が exit 0 なのに何も出ない | **正常**（差分なし）とは限らない。`Warnings` にツールが挙がっていないかを見る。挙がっていれば「未照合」であって「0 件」ではない |
| `Warnings` に全ソースが挙がる | ネットワーク／ソースの体裁変更。カタログは触られていないので、そのままリコンサイルをスキップしてよい |
| `--json` が `JSON.parse` で落ちる | `npm run` のバナーが混ざっている。`npm run --silent` を使う |
| `is in the catalog but not attested` で赤い | **数字合わせではない。** 5-1 で attestation を採り直す（実在するなら）／カタログから消す（幻なら＋ exclusions.json に記録） |
| `is attested but missing from the catalog` で赤い | カタログに足す。載せない判断なら exclusions.json に行を足す（5-3 の表） |
| `no attestation covers this tool` で赤い | その tool の attestation が無い。5-1 で新規に採る |
| `slash-command attestations: …` という例外で軒並み赤い | attestations.json の形式違反（ソート漏れ・重複・`observedAt` の書式など）。ローダは skip せず throw する。Phase 6 の `DEFAULT_ATTESTATIONS` 出力で切り分ける |
| 説明の安全ガードが赤い | 4-1 の `<...>`。角括弧に直す |
| 幻コマンド禁止／antigravity 非露出が赤い | **期待値を直さない。** 除外し損ねたものが入っている（4-3） |
| `getCatalogStaleness` が赤い | 5-2。attestation の `version` を上げたなら staleness テストのリテラルも直す |
| `keeps the version stamp out of the catalog file` が赤い | `verifiedAgainst` を catalog.json へ書き戻している。版の在処は attestation だけ（#2026） |
| 別のツールの件数まで動いた | `--write` は追加専用。想定外の減少は差分を読んで原因を特定する |

## 安全ガード

- **primary checkout で `npm run build` を回さない**（稼働サーバの `.next` を壊す。過去 3 回発生）
- **`--check` の exit code で判定しない**（ドリフトがあっても 0）
- **fail-soft 警告を無視しない**（「0 件」と「未照合」を混同しない）
- **`--write` の出力をそのまま commit しない**（Phase 4 の 3 点が必ず残っている）
- **禁止系ガードの期待値を緩めない**（赤いのは除外漏れのサイン）
- **除外判断を消さない**（`src/config/slash-commands-exclusions.json` が正本）
- **attestation をカタログからコピーして緑にしない**（ゲートが恒真になり審査が消える。#2026）
- **`--write` が attestation を書いたと思い込まない**（書かない。人が書くまで pin は赤いまま）

## 参考

- [`/release` スキル](../release/SKILL.md) Phase 1.5 — リリース時にこの手順を呼ぶ箇所
- `scripts/refresh-slash-command-catalog.ts` — ランナー（`--check` / `--write` / `--json` / `--codex-ref`）
- `src/lib/slash-command-reconcile/engine.ts` — 追加・拒否・衝突の判定本体
- `src/lib/slash-command-reconcile/providers/` — 各ソースの URL とパース
- `src/lib/slash-command-reconcile/sanitize.ts` — 名前の allowlist と説明の正規化
- `src/lib/slash-command-reconcile/exclusions.ts` — 「載せない」判断の読み込みと検証
- `src/lib/slash-command-reconcile/attestations.ts` — 「ソースが列挙した集合」の読み込み・検証・突き合わせ
- Issue #1489（リコンサイル基盤） / #1502・#1503（幻コマンド） / #1603（history / alias 行の拒否）
  / #1704（exclusions） / #2024（pin を緩めない判断） / #2026（attestation）
