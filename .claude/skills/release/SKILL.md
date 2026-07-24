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
- `npm run lint && npx tsc --noEmit && npm run test:unit && npm run build` が通ること

## この手順が「なぜこの形か」

| 事実 | 理由 |
|---|---|
| main へ直接 push しない | `.git/hooks/pre-push` が `protected_branch='main'` で拒否する。**PR 経由が唯一の経路** |
| PR は `develop → main` | v0.10.0 以降の実績（#1314 / #1325）。`release/vX.Y.Z` ブランチを切る旧手順（#1202）は使わない |
| squash マージ | 上記 PR は squash される。その結果 **develop の祖先が切れる**ため、マージバックが必須になる |
| マージバックは `-s ours` | squash 後は main の tree が develop と同一なので、内容ではなく**祖先関係だけを復元**する |
| Release ノートは CHANGELOG 転記 | v0.10.0 以降の実績。`--generate-notes` は v0.9.1 までの形式 |
| npm publish しない | `publish.yml` が Release 契機で自動実行する（OIDC / provenance 付き） |

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

---

## Phase 1.5: スラッシュコマンドカタログのリコンサイル（Issue #1489）

版 bump の**前**に、組み込みスラッシュコマンドのカタログを各 CLI の権威ソース
（claude docs table / codex OSS enum @release tag）から最新化する。これにより
カタログ内容と `verifiedAgainst` が**同じ関数で一緒に**更新され、内容と版スタンプの
乖離（#1476 / #1488 の真因）が構造的に解消する。

### 1.5-1. ドリフト検出（書き込みなし）

```bash
npm run catalog:refresh -- --check
```

- 追加候補・`verifiedAgainst` 更新・ソース未掲載（要レビュー）の差分が表示される。
- ソースが到達不能・体裁変更の場合は **fail-soft**（warn を出して既存カタログ据え置き、
  exit 0）。この場合はリコンサイルをスキップしてそのまま Phase 2 へ進む。

### 1.5-2. 差分があれば適用

差分が出たときのみ実行する:

```bash
npm run catalog:refresh -- --write
```

- 書き換わるのは `src/config/slash-commands-catalog.json` と
  `locales/{en,ja}/worktree.json`（新規 description キー）。
- **ja 訳は `[要レビュー]` プレフィックス付きプレースホルダ**。en も docs 由来の
  heuristic 抽出なので、**リリース PR の diff で必ず人手レビュー**する（誤抽出・不要な
  内部コマンド混入がないか。これが安全ゲート）。
- 品質ゲート（下記 2-3）を通してから、変更を**このリリース commit に含める**。

> **注意**: `--write` は `codex` のように版固定できるソースのみ `verifiedAgainst` を
> 更新する。claude docs は版スタンプが無いため `verifiedAgainst.claude` は触らない
> （照合した版のときだけ刻む原則）。

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

全て通ること。1つでも落ちたら修正してから進む。

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run build
```

### 2-4. コミット & push

```bash
git add package.json package-lock.json CHANGELOG.md
# Phase 1.5 でカタログを --write した場合のみ、その差分も同じ commit に含める:
git add src/config/slash-commands-catalog.json locales/en/worktree.json locales/ja/worktree.json
git commit -m "chore: release v${NEXT_VERSION}"
git push origin develop
```

変更は上記3ファイル（**リコンサイルで差分が出た場合はカタログ＋locales の最大3ファイルを追加**）
であること（`git diff --stat` で確認）。リコンサイルで書き込みが無かったときは 3 ファイルのみ。

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
- **DB マイグレーション**: 有無（有る場合は `CURRENT_SCHEMA_VERSION` の遷移）
- **実差分**: `git diff --stat origin/main..origin/develop` の実数。「squash 履歴のため `main..develop` のコミット数は実態より多く表示される」旨を注記
- **対応 Issue** 一覧
- **主な変更**: Added / Changed / Fixed
- **品質チェック**結果

### 3-2. CI 通過を確認

```bash
gh pr checks <PR番号> --repo Kewton/CommandMate --watch
```

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
| 品質ゲート失敗 | 修正してリトライ。3回失敗で中断 |
| main へ push しようとして hook に拒否された | **手順の誤り**。PR 経由に戻る |
| publish ワークフロー失敗 | ユーザーに報告。ローカル `npm publish` で回避しない |
| マージバック後に tree 不一致 | push せずユーザーに報告 |

## 安全ガード

- **main 直 push は行わない**（hook が拒否する。PR が唯一の経路）
- **PR のマージはユーザーに委ねる**（main 向けは承認必須）
- **GitHub Release の作成 = npm publish の実行**。ユーザーの明示的合意を得てから行う
- **`npm publish` をローカル実行しない**（OIDC / provenance が CI 前提）
- タグが既に存在する場合は中断
- マージバック後は必ず tree 一致を検証してから push

## 参考

- [リリースガイド](../../../docs/release-guide.md)
- `.github/workflows/publish.yml` — Release 契機の自動 publish（OIDC）
- `.git/hooks/pre-push` — main 直 push の拒否
- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
