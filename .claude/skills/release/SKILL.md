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
| Release ノートは CHANGELOG 転記 | v0.10.0 以降の実績。`--generate-notes` は v0.9.1 までの形式 |
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

`## [Unreleased]` の直後に新セクションを挿入する。

```markdown
## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

> **Highlight**: このリリースの中心を2〜4文で。何が問題で、何を変えたか。可能なら実測値を入れる。

### Added
- feat(scope): **要点**。詳細説明 (#Issue番号)

### Changed
- ...

### Fixed
- ...

## [前のバージョン] - ...
```

規約:

- **リンク参照（`[X.Y.Z]: https://github.com/...compare/...`）は追加しない**。0.5.2 で止まっており、近年のリリースでは付けていない
- 日付は JST 基準
- 該当が無いカテゴリの見出しは書かない
- 各項目末尾に Issue 番号を `(#1234)` 形式で入れる

`templates/changelog-entry.md` も参照。

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
git add package.json package-lock.json CHANGELOG.md
# Phase 1.5-2 でカタログを --write した場合のみ:
git add src/config/slash-commands-catalog.json locales/en/worktree.json locales/ja/worktree.json
# Phase 1.5-3 で attestation を採り直した場合のみ（--write はこのファイルを書かないので、
# 1.5-2 の直後に足すものではない。人が編集したときだけ差分が出る）:
git add src/config/slash-commands-attestations.json
git commit -m "chore: release v${NEXT_VERSION}"
git push origin develop
```

変更は上記 3 ファイル（**リコンサイルで差分が出た場合はカタログ＋locales の 3 ファイル、
attestation を採り直した場合はさらに 1 ファイル**）であること（`git diff --stat` で確認）。
リコンサイルで書き込みが無く attestation も動かさなかったときは 3 ファイルのみ。

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
