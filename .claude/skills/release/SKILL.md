---
name: release
description: "develop → main の PR 経由でリリースを実行する（版上げ・CHANGELOG・タグ・GitHub Release・マージバック）"
disable-model-invocation: true
allowed-tools: "Bash, Read, Edit, Write"
argument-hint: "[version-type] (major|minor|patch) or [version] (e.g., 1.2.3)"
---

# リリーススキル

`develop` でバージョンを上げ、`develop → main` の PR 経由で main へ反映し、タグ・GitHub Release・develop へのマージバックまでを実行するスキルです。

> **npm publish は行いません。** `.github/workflows/publish.yml` が GitHub Release の `published` を契機に OIDC（npm Trusted Publishers）で自動 publish します。ローカルには publish 用の認証が無いため、`npm publish` を手元で実行してはいけません。

## 使用方法

```bash
/release patch      # パッチバージョンアップ (0.10.0 → 0.10.1)
/release minor      # マイナーバージョンアップ (0.10.0 → 0.11.0)
/release major      # メジャーバージョンアップ (0.10.0 → 1.0.0)
/release 1.0.0      # 直接バージョン指定
```

## 前提条件

- **`develop` ブランチ**が最新で、`origin/develop` と同期していること（リリースは develop 基点。main 基点ではない）
- 作業ツリーがクリーンであること
- 検証ゲートが通ること（Phase 2-3 参照）。**`npm run build` は primary checkout で回さない** —
  稼働サーバの `.next` を壊すため。build の検証はリリース PR の CI が行う

## 全体の流れ

```
develop ──PR (squash)──> main ──annotated tag──> GitHub Release 作成
                                                        │
                                                        └─> publish.yml (OIDC) ──> npm
develop <──merge -s ours── main      （祖先復元。squash で切れるため必須）
```

**`release/*` ブランチは経由しない。** `origin/release/v*` は v0.5.x までしか存在せず、
`release` ブランチを切る手順（#1202）は v0.10.0 で廃止されている。`publish.yml` のトリガーは
`on: release: types: [published]` ＝ **GitHub Release オブジェクトの公開**であって、
ブランチへの push ではない。

**このスキルは `develop` からしか実行できない**（Phase 1-1 で確認し、それ以外は中断する）。

## この手順が「なぜこの形か」

| 事実 | 理由 |
|---|---|
| main へ直接 push しない | `.git/hooks/pre-push` が `protected_branch='main'` で拒否する。**PR 経由が唯一の経路** |
| PR は `develop → main` | v0.10.0 以降の実績（#1314 / #1325）。`release/vX.Y.Z` ブランチを切る旧手順（#1202）は使わない |
| squash マージ | 上記 PR は squash される。その結果 **develop の祖先が切れる**ため、マージバックが必須になる |
| マージバックは `-s ours` | squash 後は main の tree が develop と同一なので、内容ではなく**祖先関係だけを復元**する |
| CHANGELOG の節は `apply` で生成 | エントリは PR ごとの断片（`changelog.d/<N>.md`）で develop に入る。並列の PR が `## [Unreleased]` で衝突しないようにするため（#2641） |
| Release ノートは CHANGELOG 転記 | v0.10.0 以降の実績。`--generate-notes` は v0.9.1 までの形式 |
| アプリ内の「新機能と改善」は `release-notes/X.Y.Z.json` | 画面の言語（ja / en）に合わせて出すため。CHANGELOG は日本語だけなので、そのままは出せない（2-2b） |
| npm publish しない | `publish.yml` が Release 契機で自動実行する（OIDC / provenance 付き） |
| リリース後も稼働サーバは旧 bundle のまま | primary checkout で build しないので `.next` は据え置き。**これは正常**（Phase 4-7 参照） |

---

## Phase 1: 事前確認

### 1-1. develop を最新化し、クリーンか確認

```bash
git checkout develop
git pull origin develop
git status --porcelain          # 空であること
git rev-list --left-right --count develop...origin/develop   # 0  0 であること
```

### 1-2. 次バージョンの計算

```bash
CURRENT_VERSION=$(node -p "require('./package.json').version")
```

引数（patch/minor/major）に応じて `NEXT_VERSION` を計算する。

- `patch`: `0.10.0` → `0.10.1`
- `minor`: `0.10.0` → `0.11.0`
- `major`: `0.10.0` → `1.0.0`

### 1-3. 安全ガード

```bash
# タグが既に存在したら中断
git fetch origin --tags
git tag -l "v${NEXT_VERSION}"   # 空であること。あればエラー表示して中断
```

以下を確認し、満たさなければ中断する:

- 現在のブランチが `develop` であること
- `main` に未反映の変更が実際に存在すること（`git diff --stat origin/main..origin/develop` が空でない）

> **注意**: `git log origin/main..origin/develop` は squash の影響で実態より遥かに多くのコミットを表示する。**tree 差分（`git diff`）が正**。

### 1-4. Vibe メトリクス定点観測

前リリースからの期間の Eval メトリクス（#1551）を取り、リリース PR 本文に貼る。
**これはリリースをブロックしない** — 取れなければ「メトリクスなし」と明記してスキップし、次へ進む。

```bash
# 前リリースタグからの日数。--days は 1..90 の整数しか受け付けず、
# 範囲外は「クランプされずに exit 2 で失敗する」ため、渡す前にここで丸める。
PREV_TAG=$(git describe --tags --abbrev=0 --match 'v*' origin/main 2>/dev/null)
METRICS_DAYS=7
if [ -n "$PREV_TAG" ]; then
  METRICS_DAYS=$(( ( $(date +%s) - $(git log -1 --format=%ct "$PREV_TAG") ) / 86400 + 1 ))
fi
[ "$METRICS_DAYS" -lt 1 ] && METRICS_DAYS=1
[ "$METRICS_DAYS" -gt 90 ] && METRICS_DAYS=90

commandmate report metrics --days "$METRICS_DAYS" --json > /tmp/vibe-metrics.json 2>&1; echo $?
```

> `> ファイル 2>&1; echo $?` の形を崩さないこと。`| grep` に繋ぐと exit code が grep のものに化け、
> 失敗を成功として読む。このリポジトリでは開発版エイリアス `commandmatedev` も同じ CLI を指す。

**判定は exit code で行う。JSON をパースしてから判断してはいけない** — 失敗時の
`/tmp/vibe-metrics.json` には JSON ではなくエラー文（`Error: Server is not running.` 等）が入る。

| exit | 意味 | 対応 |
|---|---|---|
| `0` | 取得成功 | 下の要約を PR 本文に貼る |
| `1` | サーバ未稼働・無応答（`Server is not running. Start it with: commandmate start`） | **「Vibe Metrics: メトリクスなし（サーバ未稼働）」と明記してスキップ。リリースは続行する** |
| `2` | 認証エラー（`CM_AUTH_TOKEN` 未設定）／`--days` が範囲外 | 同上。スキップして続行する |
| `127` | `commandmate` が PATH に無い | 同上。スキップして続行する |
| その他 | 想定外 | 同上。スキップして続行する |

exit 0 でも `tasks.total` が `0`（＝ `tasks.successRate` が `null`）なら**対象期間に記録が無い**。
「Vibe Metrics: メトリクスなし（対象期間に記録なし）」と明記してスキップする。
分母ゼロの比率は `0` ではなく `null` で返る仕様なので、**`null` を `0%` と読み替えてはいけない**
（「12 件中 0 件成功」と「そもそも 0 件」が同じ文字列になる）。

取得できたら PR 本文に `## Vibe Metrics` 節として 1 ブロック貼る:

- **タスク成功率**: `tasks.successRate`（`succeeded / total`）
- **検証 pass 率**: `verification.passRate`（`passed / runs`）
- **gateFailBreakdown 上位**: `failCount` 降順・`gateId` 昇順で最大 10 件
- **人間介入回数**: `intervention.humanResponds`（対比として `autoAnswered`）

`--json` を外すと同じ数字が整形済みで出るので、その 5 行をそのまま貼ってもよい:

```
Vibe Metrics (last 7 days)
Tasks:        3 total / 1 succeeded / 1 failed / 1 not-started  (success 33.3%)
Verification: 6 runs, pass 66.7%  (top fails: lint x1, work-evidence x1)
Intervention: 0 human responds / 1 auto answered
Retry loops:  avg 0.0 per failed task
```

> しきい値による自動ブロック（成功率 X% 未満でリリース中止等）は**まだ設けない**。
> 運用データが貯まるまでは定点観測のみで、判断は人間が行う。

---

## Phase 1.5: スラッシュコマンドカタログのリコンサイル（Issue #1489 / #2026）

版 bump の**前**に、組み込みスラッシュコマンドのカタログを各 CLI の権威ソース
（claude docs table / codex OSS enum @release tag）から最新化する。

このフェーズは **2 つの作業**からなる。混ぜないこと:

| | 誰がやるか | 触るファイル |
|---|---|---|
| **A. カタログにコマンドを足す** | `--write`（機械） | `src/config/slash-commands-catalog.json`, `locales/{en,ja}/worktree.json` |
| **B. 「版 V で source S はこの集合を列挙した」を記録し直す** | **人間だけ**（Issue #2026） | `src/config/slash-commands-attestations.json` |

**B を機械にやらせない設計であることが重要**（#2026）。A だけを適用するとカタログが
attestation より先に進み、`tests/unit/lib/standard-commands.test.ts` の
`ships exactly the attested command set for every tool` が
`[<tool>] /<name> is in the catalog but not attested` で落ちる。**それは審査ゲートであって
欠陥ではない。** 正しい対応は B（ソースを読み直して attestation を書き直す）であって、
テストの期待値を緩めることではない。

`verifiedAgainst` は #2026 で `slash-commands-catalog.json` から**削除**され、
attestation の `version` フィールドが唯一の在処になった（`CATALOG_VERIFIED_AGAINST` は
そこから導出される）。したがって**版スタンプを自動で動かすものは無い** — 版が動くのは
B を人がやったときだけである。

### 1.5-1. ドリフト検出（書き込みなし）

```bash
npm run catalog:refresh -- --check
```

- 冒頭に `Holding N attestation(s) from …` として、いま pin が拠っている読み取り
  （tool / 件数 / 版 / 採取日 / Issue）が出る。
- `New commands (N)` が A の規模。
- `verifiedAgainst updates (not applied — re-attest by hand)` は
  「attestation に記録した版よりソースが先に進んでいる」の**報告のみ**。#2026 以降、
  これを適用するものは存在しない。
- `Attestation drift (…)` は「記録した**集合**とソースの現状が食い違っている」。
  **上流でコマンドが削除された場合、追加は 0 件のままこれだけが出る** ので、
  「New commands 0 件＝やることなし」と読まないこと。
- **幻コマンド確認（#1503）**: 「In catalog but not in source（review — not auto-deleted）」に
  出た項目は、現行 CLI に存在しない幻コマンドの候補。自動削除はされない（隠しエイリアスの
  誤検出があるため）ので、実機で「完全入力してもポップアップに一致行が出ない」ものは
  カタログ・`locales/{en,ja}/worktree.json`・`frequentlyUsed` から手動除去を検討する。
- ソースが到達不能・体裁変更の場合は **fail-soft**（warn を出して既存カタログ据え置き、
  exit 0）。この場合はリコンサイルをスキップしてそのまま Phase 2 へ進む。

### 1.5-2. 差分があれば適用（A: 機械の担当）

差分が出たときのみ実行する:

```bash
npm run catalog:refresh -- --write
```

- 書き換わるのは `src/config/slash-commands-catalog.json` と
  `locales/{en,ja}/worktree.json`（新規 description キー）の **2 種類だけ**。
  `slash-commands-attestations.json` は**書かれない**。
- **ja 訳は `[要レビュー]` プレフィックス付きプレースホルダ**。en も docs 由来の
  heuristic 抽出なので、**リリース PR の diff で必ず人手レビュー**する（誤抽出・不要な
  内部コマンド混入がないか。これが安全ゲート）。
- 品質ゲート（下記 2-3）を通してから、変更を**このリリース commit に含める**。

### 1.5-3. attestation を採り直す（B: 人間の担当）

**次のいずれかが出たら必須**:

- `--write` で `New commands` を適用した
- `Attestation drift (…)` に行が出た
- `verifiedAgainst updates …` に行が出て、その版で読み直す判断をした

やること: ソース（`source` フィールドが指す URL / タグ / CLI）を**実際に読み**、
`src/config/slash-commands-attestations.json` の当該 tool の
`commands` / `version` / `observedAt` を書き直す。手順の詳細と各ツールの採取レシピは
[`/catalog-reconcile` スキル](../catalog-reconcile/SKILL.md) Phase 5 にある。

**カタログからコピーして緑にしない。** それをやると「ソースがこう言っていた」という
主張が「カタログがこうなっている」の言い換えになり、審査そのものが消える。

---

## Phase 2: バージョン更新（develop 上で直接）

### 2-1. package.json / package-lock.json

```bash
npm version "${NEXT_VERSION}" --no-git-tag-version
```

`npm version` は package.json と package-lock.json の**2箇所（root と `packages[""]`）を同時に整合**させる。手で書き換えないこと。

### 2-2. CHANGELOG.md

各 Issue のエントリは、PR ごとに `changelog.d/<N>.md` の断片として develop に入っている（形式は
`changelog.d/README.md`）。`## [Unreleased]` は空のまま保たれている（`tests/unit/scripts/changelog-fragments.test.ts`
のガード）。**`## [X.Y.Z]` の節は手で書かず**、次の 3 手順で断片から生成する。

1. 入る内容を確認する

   ```bash
   node scripts/changelog-fragments.mjs check; echo "CHECK=$?"   # 0 であること
   node scripts/changelog-fragments.mjs preview                    # 生成される節をそのまま表示する
   ```

   - `CHECK=0` でなければ、出力に出たファイル名の断片を直してから進む（`apply` は不正な断片が 1 つでもあると何も書かずに止まる）
   - `preview` の Issue 番号を、リリース PR に載せる対応 Issue と突き合わせる。断片が無い Issue は節に載らない

2. 節を生成する（日付は JST）

   ```bash
   node scripts/changelog-fragments.mjs apply --version "${NEXT_VERSION}" --date "$(TZ=Asia/Tokyo date +%F)"; echo "APPLY=$?"
   git status --short -- CHANGELOG.md changelog.d   # CHANGELOG.md の M と、断片ごとの D だけであること
   ```

   - `APPLY=0` であること。`apply` は `## [Unreleased]` の直後に `## [X.Y.Z] - YYYY-MM-DD` の節を挿入し、
     集約した断片（`changelog.d/README.md` 以外）を削除する。節は Added → Changed → … → Fixed … の順、節の中は Issue 番号の降順
   - `## [Unreleased]` に行が残っていると `Unreleased is not empty` で止まり、何も書き換えない。残っていた行は
     断片（`changelog.d/<N>.md`）に移してからやり直す

3. 生成された節の見出しの直後に `> **Highlight**: …` を書き足す

   ```markdown
   ## [Unreleased]

   ## [X.Y.Z] - YYYY-MM-DD

   > **Highlight**: このリリースの中心を2〜4文で。何が問題で、何を変えたか。可能なら実測値を入れる。

   ### Added

   - **feat(scope): 要点** (#Issue番号): 詳細説明

   ### Fixed

   - **fix(scope): 要点** (#Issue番号): 詳細説明

   ## [前のバージョン] - ...
   ```

規約:

- **リンク参照（`[X.Y.Z]: https://github.com/...compare/...`）は追加しない**。0.5.2 で止まっており、近年のリリースでは付けていない
- 日付は JST 基準（上の `TZ=Asia/Tokyo date +%F`）
- 該当が無いカテゴリの見出しは書かない（`apply` は断片の無い節を出さない）
- 各項目に Issue 番号を `(#1234)` 形式で入れる（断片の形式では要約の `**` を閉じた直後。`check` が確かめる）

`templates/changelog-entry.md` も参照。

### 2-2a. LP の版行（website/index.html）

LP の hero には、prereq 行の下に版行が**静的に**書いてある（Issue #2552。ページ読み込み時に API は叩かない）:

```html
<p class="release-line">vX.Y.Z · released YYYY-MM-DD · N+ releases</p>
```

リリースのたびにこの 1 行を書き換える。`tests/unit/website/landing-page.test.ts` が
**版を package.json の `version` と、日付を CHANGELOG の `## [X.Y.Z] - YYYY-MM-DD` 見出しと**
突き合わせるので、書き換え忘れは 2-3 の `npm run test:unit` で落ちる。

```bash
# 日付は 2-2 の apply が CHANGELOG に書いた見出しから取る（JST で書き直さない。二重管理になる）
RELEASE_DATE=$(awk -v v="## [${NEXT_VERSION}] - " 'index($0, v) == 1 { print substr($0, length(v) + 1); exit }' CHANGELOG.md)
# Release の総数。これから作る v${NEXT_VERSION} の 1 本を足し、10 の位で切り捨てる（"N+" は下限の概数）
RELEASE_COUNT=$(gh api repos/Kewton/CommandMate/releases --paginate --jq '.[].tag_name' | wc -l | tr -d ' ')
RELEASE_FLOOR=$(( (RELEASE_COUNT + 1) / 10 * 10 ))
echo "date=${RELEASE_DATE} count=${RELEASE_COUNT} floor=${RELEASE_FLOOR}"

node -e '
const fs = require("fs");
const [version, date, floor] = process.argv.slice(1);
if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[1-9]\d*0$/.test(floor)) {
  console.error(`refusing to write: version=${version} date=${date} floor=${floor}`);
  process.exit(1);
}
const file = "website/index.html";
const html = fs.readFileSync(file, "utf8");
const line = /<p class="release-line">[^<]*<\/p>/g;
const found = html.match(line) || [];
if (found.length !== 1) {
  console.error(`expected exactly one release-line in ${file}, found ${found.length}`);
  process.exit(1);
}
fs.writeFileSync(file, html.replace(line, () => `<p class="release-line">v${version} · released ${date} · ${floor}+ releases</p>`));
' "${NEXT_VERSION}" "${RELEASE_DATE}" "${RELEASE_FLOOR}"; echo "RELEASE_LINE=$?"

git diff -- website/index.html   # 版行の 1 行だけが変わっていること
```

- `RELEASE_LINE=0` であること。`RELEASE_DATE` が空（2-2 の見出しが無い／形式違い）や
  `gh api` の失敗で `floor` が `0` になった場合、スクリプトは**書かずに exit 1** で止まる。
  値を手で埋めて進めず、原因（CHANGELOG の見出し・`gh auth status`）を直してから再実行する
- `git diff` が版行の 1 行以外を含んでいたら中断する（置換対象のマークアップが変わっている）

### 2-2b. リリースノート（release-notes/X.Y.Z.json）

画面の「新機能と改善」ダイアログ（Issue #2651）が読むファイル。UI の言語に合わせて出すため、
**日本語（`ja`）と英語（`en`）の両方**を書く。CHANGELOG の転記ではない（CHANGELOG は日本語だけで、
開発者向けの詳細を含むため）。形式の正本は `src/lib/app-update/release-notes.ts`（Issue #2646）。

作り方:

1. 2-2 で書いた `## [X.Y.Z]` の節を読む
2. **利用者が画面や CLI で気づく変更だけ**を選ぶ。次は入れない
   - 先頭が `fix(test` / `test(` / `docs(` / `chore(` / `ci(` / `refactor(` / `build(` / `style(` の項目
   - テスト・CI・検証ゲート・開発用スキル（`.claude/` / `.agents/`）・内部の整理だけの変更
3. 分類する: `### Added` → `added`、`### Changed` → `improved`、`### Fixed` と `### Security` → `fixed`。
   `### Removed` / `### Deprecated` は `improved` に「〜を廃止しました。」の形で入れる
4. 1 項目を 1 文にする
   - 利用者の目線で、何ができるようになったか・何が直ったかを書く
     （例: 「狭い画面でもファイル名が表示されるようになりました。」 / "File names now stay visible in a narrow panel."）
   - **プレーンテキスト**で書く。Markdown（`**` やバッククォート）・HTML・URL・Issue 番号・関数名・
     ファイルパス・testid は書かない（画面はそのまま文字として出す）
   - `ja` は 80 字以内、`en` は 160 字以内を目安にする（上限は 500 文字）
   - `ja` と `en` は同じ内容にする（片方にだけ情報を足さない）
   - 1 区分 30 件まで。超えるときは近い項目をまとめる
5. `highlight` は CHANGELOG の `> **Highlight**:` を 1〜2 文に要約する（書き方は 4 と同じ）
6. 利用者向けの項目が 1 つも無いリリースでもファイルは作る。そのときは 3 つの配列を空にし、
   `highlight` を「内部の改善のみのリリースです。」 / "This release contains internal improvements only." にする
7. Write ツールで `release-notes/${NEXT_VERSION}.json` を作る（`release-notes/` が無ければ作る）。
   `version` は `NEXT_VERSION`、`date` は 2-2a の `RELEASE_DATE`（CHANGELOG の見出しの日付）にする

```json
{
  "version": "0.39.0",
  "date": "2026-09-20",
  "highlight": {
    "ja": "更新があるとき、画面右上の「Update」ボタンからそのまま更新できるようになりました。",
    "en": "When an update is available, you can now start it from the Update button at the top right."
  },
  "added": [
    {
      "ja": "更新のあとに、新機能と改善の一覧が表示されるようになりました。",
      "en": "After an update, a list of what is new is now shown."
    }
  ],
  "improved": [],
  "fixed": [
    {
      "ja": "情報画面を閉じると、更新後にページが再読み込みされない問題を直しました。",
      "en": "Fixed the page not reloading after an update when the info dialog had been closed."
    }
  ]
}
```

| 項目 | 規則 |
|---|---|
| ファイル名 | `X.Y.Z.json`（`v` を付けない） |
| `version` | ファイル名の版と同じ文字列 |
| `date` | `YYYY-MM-DD` |
| `highlight` | `{ "ja", "en" }`。無ければ `null` |
| `added` / `improved` / `fixed` | `{ "ja", "en" }` の配列。各 30 件まで。無ければ `[]` |
| `ja` / `en` | 空白だけは不可。500 文字以内 |

規則に反するファイルは、画面ではファイルごと無視される（エラーは出ず、何も表示されない）。
**書いたら必ず次で検査する**:

```bash
npx vitest run tests/unit/release-notes/release-notes-files.test.ts > /tmp/rel-notes.log 2>&1; echo "NOTES=$?"
```

- `NOTES=0` であること。0 以外なら `/tmp/rel-notes.log` に出たファイル名と理由を見て直し、再実行する
- 2-3 の `npm run test:unit` もこのテストを含むが、ノートの誤りはここで先に潰す
- GitHub Release のノート（4-3）はこれまでどおり CHANGELOG の転記。このファイルは使わない

### 2-3. 品質ゲート

**`npm run build` をここで実行してはいけない。**

このスキルは develop、すなわち**稼働中サーバの cwd** で走る。`npm run build` は `.next` を
作り替えて `BUILD_ID` を変えるため、**配信中の成果物を壊す**（開いているタブは chunk が 404 になり、
遷移で client-side exception。過去 3 回発生）。同じ理由で `.commandmate/verify.yaml` は
`skipInPrimaryCheckout: true` で build を除外している。**スキルだけ素で build を回すと矛盾する。**

**`commandmate verify` もここでは使えない。** `options.skipInPrimaryCheckout: true` は
build だけを外すのではなく、**worktreePath がサーバプロセスの cwd と一致する場合に宣言ゲートを
すべてスキップする run 単位のオプション**である（実測）:

```
GATE lint     SKIP (skipped: worktreePath is the server process working directory and
                    options.skipInPrimaryCheckout is true.)
GATE typecheck SKIP (同上)
GATE unit     SKIP (同上)
RESULT error → exit 99
```

したがって develop で `verify` を叩くと**何も検証されないまま exit 99 が返る**。

**手動で以下の 3 つを回す。`npm run build` は含めない。**

```bash
npm run lint      > /tmp/rel-lint.log 2>&1; echo "LINT=$?"
npx tsc --noEmit  > /tmp/rel-tsc.log  2>&1; echo "TSC=$?"
npm run test:unit > /tmp/rel-unit.log 2>&1; echo "UNIT=$?"
```

`> ファイル 2>&1; echo $?` の形を崩さないこと。`| grep` に繋ぐと exit code が grep のものに
化け、失敗を成功として読む。3 つとも 0 であること。1 つでも落ちたら修正してから進む（3 回失敗で中断）。

**build の検証は CI に委ねる。** リリース PR の `ci-pr.yml` に Build ジョブがあり、
別マシンで実行されるので稼働サーバに影響しない。どうしても手元で build を確認したい場合は
**linked worktree を作ってそこで回す**（primary checkout では絶対に回さない）。

### 2-4. コミット & push

```bash
git add package.json package-lock.json CHANGELOG.md website/index.html
git add "release-notes/${NEXT_VERSION}.json"
# 2-2 の apply が削除した断片（changelog.d/<N>.md）の削除もこのコミットに含める:
git add changelog.d
# Phase 1.5-2 でカタログを --write した場合のみ:
git add src/config/slash-commands-catalog.json locales/en/worktree.json locales/ja/worktree.json
# Phase 1.5-3 で attestation を採り直した場合のみ（--write はこのファイルを書かないので、
# 1.5-2 の直後に足すものではない。人が編集したときだけ差分が出る）:
git add src/config/slash-commands-attestations.json
git commit -m "chore: release v${NEXT_VERSION}"
git push origin develop
```

変更は上記 5 ファイル（package.json ・ package-lock.json ・ CHANGELOG.md ・ website/index.html ・
release-notes/X.Y.Z.json。**リコンサイルで差分が出た場合はカタログ＋locales の 3 ファイル、
attestation を採り直した場合はさらに 1 ファイル**）と、2-2 で削除した断片（`changelog.d/<N>.md`。
`changelog.d/README.md` は残る）であること（commit の前に `git diff --cached --stat` で確認）。
リコンサイルで書き込みが無く attestation も動かさなかったときは基本 5 ファイルのみ＋断片の削除
（website/index.html は 2-2a の版行 1 行、release-notes/X.Y.Z.json は 2-2b で作った新規ファイル）。

> `git status` に `src/config/slash-commands-attestations.json` が出ているのに
> `New commands` が 0 件だった場合、それは**上流の削除か版の採り直し**である。
> 正常な状態なので add してよい（commit message にどのソースをいつ読んだかを残す）。

---

## Phase 3: リリース PR

### 3-1. PR 作成

```bash
gh pr create --repo Kewton/CommandMate --base main --head develop \
  --title "release: v${NEXT_VERSION}" \
  --body-file <(...)
```

PR 本文に含める要素:

- **リリース概要**: 何のためのリリースか
- **バージョン**: `X.Y.Z → X.Y.Z+1`（patch/minor/major の別）
- **DB マイグレーション**: 下記 3-1a で判定した結果
- **実差分**: `git diff --stat origin/main..origin/develop` の実数。「squash 履歴のため `main..develop` のコミット数は実態より多く表示される」旨を注記
- **対応 Issue** 一覧
- **主な変更**: Added / Changed / Fixed
- **品質チェック**結果
- **UAT**: 実施済みならレポートのパス（`dev-reports/uat/…/acceptance-test-report.html`）、未実施なら「未実施」と 1 行。**そのリリースが実機で検証されたかを PR から辿れるようにする**
- **Vibe Metrics**: 1-4 で取得した要約。取れなかった場合は「メトリクスなし」とその理由（サーバ未稼働／対象期間に記録なし）を 1 行で書く

### 3-1a. DB マイグレーションの判定

```bash
git diff origin/main..origin/develop -- src/lib/db/migrations/runner.ts | grep CURRENT_SCHEMA_VERSION
git diff --name-only origin/main..origin/develop -- 'src/lib/db/migrations/v*.ts'
```

差分があれば PR 本文とリリースノートに **`CURRENT_SCHEMA_VERSION` の遷移**（例 51 → 52）を書く。

**データを削除する migration が含まれる場合は、それを必ず明記する。** 利用者のサーバは
**次回起動時に自動で migration が走る**ので、何が消えるのかを事前に知らせる必要がある。
可能なら影響行数を実測して書く（例: v52 は `verification_runs` 25 件 / `tasks` 18 件の孤児行を削除した）。

```bash
# 削除系 migration の影響見積り（読み取りのみ・本番 DB を書き換えない）
sqlite3 "file:$PWD/data/db.sqlite?mode=ro" \
  "SELECT COUNT(*) FROM verification_runs WHERE worktree_id NOT IN (SELECT id FROM worktrees);"
```

### 3-2. CI 通過を確認

CI は実測で **10 分前後**かかる（2026-08-03 の計測: 10 分 23 秒）。`--watch` はその間ブロックし
続けるため、実行環境によってはタイムアウトに当たる。**ポーリング形式を推奨する。**

```bash
for i in $(seq 1 20); do
  N=$(gh pr view <PR番号> --repo Kewton/CommandMate --json statusCheckRollup \
      -q '[.statusCheckRollup[]?|select((.conclusion // .state)=="")]|length')
  echo "未完チェック: $N"
  [ "$N" = "0" ] && break
  sleep 45
done
gh pr view <PR番号> --repo Kewton/CommandMate --json mergeable,statusCheckRollup \
  -q '"mergeable=\(.mergeable) 非SUCCESS: " + ([.statusCheckRollup[]?|select((.conclusion // .state)!="SUCCESS")|"\(.name // .context)=\(.conclusion // .state)"]|join(" "))'
```

**CI 限定の赤を反射的に flake 扱いしないこと。** ローカル緑・CI 赤は、ロケールや OS 差など
実在の移植性欠陥であることがある（#1623 で awk のロケール依存を実際にこの形で検出した）。

### 3-3. マージはユーザーに委ねる

**main 向け PR はレビュー1名以上の承認が必須**（CLAUDE.md のルール）。スキルからマージしてはいけない。CI 通過を報告し、ユーザーの承認・マージを待つ。

---

## Phase 4: マージ後（タグ・Release・マージバック）

> ここから先は**ユーザーが PR をマージした後**に実行する。

### 4-1. マージ確認と tree 一致検証

```bash
git fetch origin --tags
MERGE_SHA=$(gh pr view <PR番号> --repo Kewton/CommandMate --json mergeCommit -q '.mergeCommit.oid')

# main と develop の tree が一致していること（内容ドリフトが無いことの証明）
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse origin/develop^{tree})" ] \
  && echo "tree 一致 OK" || echo "tree 不一致 — 調査すること"
```

### 4-2. annotated タグを main の squash コミットに作成

```bash
git tag -a "v${NEXT_VERSION}" "$MERGE_SHA" -m "v${NEXT_VERSION}"
git push origin "v${NEXT_VERSION}"
```

lightweight ではなく **annotated**（`-a`）であること。過去タグは全て annotated。

### 4-3. GitHub Release 作成 → **これが npm publish のトリガー**

ノートは CHANGELOG の該当セクションを転記する（`--generate-notes` は使わない）。

```bash
awk '/^## \['"${NEXT_VERSION}"'\]/{f=1} /^## \['"${CURRENT_VERSION}"'\]/{f=0} f' CHANGELOG.md > /tmp/release-notes.md

gh release create "v${NEXT_VERSION}" --repo Kewton/CommandMate \
  --title "v${NEXT_VERSION}" \
  --notes-file /tmp/release-notes.md
```

> ⚠️ **この時点で `publish.yml` が発火し npm publish が始まる。** Release 作成は「npm への公開を実行する」ことと等価。**ユーザーの明示的な合意なしに Release を作成してはいけない。**

### 4-4. publish ワークフローの完走を確認

```bash
gh run list --repo Kewton/CommandMate --workflow=publish.yml --limit 1
# status=completed conclusion=success になるまで待つ
npm view commandmate version    # NEXT_VERSION になること
```

失敗した場合はユーザーに報告する。**`npm publish` を手元で実行して回避しようとしないこと**（OIDC は CI 内でしか成立せず、provenance も付かない）。

> **README のバージョンバッジは publish 成功後もしばらく古いまま**になる。shields.io と
> GitHub camo のキャッシュによる表示遅延で、publish の失敗ではない。**慌てて再実行しないこと。**
> 判定は上記 `npm view commandmate version` の実測値で行う。

### 4-4a. publish 後に問題が見つかった場合（ロールバック）

**npm は同一バージョンの再 publish を許さない。** `0.19.0` を publish した後に `0.19.0` を
差し替えることはできないので、取れる手は以下に限られる。

| 状況 | 対応 |
|---|---|
| 重大な不具合（起動しない・データを壊す等） | `npm deprecate commandmate@X.Y.Z "理由と回避策"` で警告を出し、**修正版を次パッチとして即座にリリース**する。`npm unpublish` は 72 時間以内かつ依存されていない場合のみ可能だが、**原則使わない**（利用者の lockfile が壊れる） |
| 軽微な不具合 | 次のリリースで直す。deprecate はしない |
| GitHub Release のノートの誤り | `gh release edit vX.Y.Z --notes-file …` で修正可能（publish は再実行されない） |
| publish 前（Release 作成前）に気づいた | タグを消してやり直せる（`git push --delete origin vX.Y.Z` + `git tag -d`）。**Release を作る前なら安全** |

**したがって Phase 4-3（Release 作成）が実質的な point of no return。** ここへ進む前に
UAT と CI の結果を確認し、ユーザーの明示的合意を得ること。

### 4-5. main を develop へマージバック（祖先復元）

**必須。** squash により main のコミットは develop の祖先ではなくなっており、放置すると次回の develop → main PR で幻コンフリクトが出る。

```bash
git checkout develop
git pull origin develop
git merge -s ours origin/main -m "chore: merge release v${NEXT_VERSION} to develop (restore ancestry)"

# tree が壊れていないことを検証（-s ours は develop の tree を保持する）
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse develop^{tree})" ] \
  && echo "tree 一致 OK" || echo "tree が壊れた — push しないこと"

git push origin develop
```

### 4-6. 効果検証

```bash
git fetch origin
git merge-base --is-ancestor origin/main origin/develop \
  && echo "祖先切れ解消 OK" || echo "まだ切れている"
```

### 4-7. 稼働サーバの版は「まだ上がっていない」（Issue #2271）

**ここまでで稼働サーバが新版になることはない。** 2-3 の通り primary checkout では build しないので、
`.next` はリリース前のままである。つまり:

| 見えるもの | 実測の出どころ |
|---|---|
| `commandmate --version` | グローバル CLI の版。**稼働サーバの版ではない** |
| `/api/app/update-check` の `currentVersion` | package.json を実行時に読む＝**bump 済みの新版**を返す |
| 画面が実際に動かしている bundle | `.next` に焼かれた版＝**旧版** |

この 3 つが食い違うのは手順上の定常状態であって不具合ではない。#2271 以前は版ズレバナー
（`VersionMismatchBanner`）が package.json と bundle を突き合わせていたため、**リリースのたびに
全利用者へ恒久的にバナーが出ていた**。現在の判定は `resolveBundleDrift()`（`src/lib/version-checker.ts`）
が `.next/required-server-files.json` に焼かれた版を読むので、**bump だけではバナーは出ない**。

**稼働サーバを実際に新版で動かしたい場合は、リリース完了後に `/rebuild` スキルを使う**
（再ビルド＋再起動）。そのときだけ、開いたままの古いタブにバナーが出る — これが本来の用途である。

---

## 完了報告

```
Release v${NEXT_VERSION} completed!

  Tag:      v${NEXT_VERSION} → <squash SHA>
  Release:  https://github.com/Kewton/CommandMate/releases/tag/v${NEXT_VERSION}
  npm:      <npm view commandmate version の実測値>

  Branches: main ✓, develop ✓ (ancestry restored, tree一致検証済み)
```

## エラー時の対応

| エラー | 対応 |
|---|---|
| `develop` 以外で実行 | 中断。develop に切り替えてもらう |
| 作業ツリーが汚れている | 中断。**stash しない**（他エージェント稼働中だと破損の恐れ） |
| タグが既に存在 | 中断。別バージョンの指定を促す |
| `main..develop` の tree 差分が空 | リリースする変更が無い。中断 |
| 品質ゲート失敗（`verify` が exit 20） | `--json` の失敗ゲートと `logTail` を見て修正。3回失敗で中断 |
| main へ push しようとして hook に拒否された | **手順の誤り**。PR 経由に戻る |
| CI だけが赤（ローカルは緑） | **flake と決めつけない。** ロケール・OS 差による実在の欠陥のことがある（#1623 実例）。CI と同じ条件を手元で再現してから直す |
| publish ワークフロー失敗 | ユーザーに報告。ローカル `npm publish` で回避しない |
| publish 成功後に不具合が発覚 | 4-4a のロールバック表に従う。**同一版の再 publish はできない** |
| マージバック後に tree 不一致 | push せずユーザーに報告 |

## 安全ガード

- **main 直 push は行わない**（hook が拒否する。PR が唯一の経路）
- **primary checkout で `npm run build` を回さない**（稼働サーバの `.next` を壊す。2-3 参照）
- **リリース完了 = 稼働サーバが新版になった、ではない**（`.next` は据え置き。新版で動かすなら
  `/rebuild` スキル。4-7 参照）
- **PR のマージはユーザーに委ねる**（main 向けは承認必須）
- **GitHub Release の作成 = npm publish の実行 = point of no return**。ユーザーの明示的合意を得てから行う
- **`npm publish` をローカル実行しない**（OIDC / provenance が CI 前提）
- タグが既に存在する場合は中断
- マージバック後は必ず tree 一致を検証してから push

## 参考

> **このファイルがリリース手順の正本。** [docs/release-guide.md](../../../docs/release-guide.md) は
> 背景説明として残っているが、手順が二重管理になっており片方だけ更新されて腐るリスクがある。
> 食い違いを見つけたら**このスキルを正**とし、ガイド側を直すこと。

- [リリースガイド](../../../docs/release-guide.md)（背景説明。手順の正本ではない）
- `.github/workflows/publish.yml` — Release 契機の自動 publish（OIDC）
- `.git/hooks/pre-push` — main 直 push の拒否
- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
