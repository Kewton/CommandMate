[English](./en/release-guide.md)

# リリースガイド

このドキュメントでは、CommandMateのバージョンアップとリリース手順を説明します。

## セマンティックバージョニング

本プロジェクトは[セマンティックバージョニング](https://semver.org/lang/ja/)に従います。

### バージョン形式

```
MAJOR.MINOR.PATCH
```

| 種別 | 更新タイミング | 例 |
|------|---------------|-----|
| **MAJOR** | 破壊的変更（後方互換性のない変更） | v1.0.0 → v2.0.0 |
| **MINOR** | 後方互換性のある機能追加 | v1.0.0 → v1.1.0 |
| **PATCH** | 後方互換性のあるバグ修正 | v1.0.0 → v1.0.1 |

### バージョン判断基準

| 変更内容 | バージョン種別 |
|---------|---------------|
| APIの削除・変更 | MAJOR |
| 設定ファイル形式の変更 | MAJOR |
| 環境変数名の変更（フォールバックなし） | MAJOR |
| 新機能の追加 | MINOR |
| 新APIの追加 | MINOR |
| 新しい設定オプションの追加 | MINOR |
| バグ修正 | PATCH |
| ドキュメント修正 | PATCH |
| リファクタリング（動作変更なし） | PATCH |
| 依存関係のアップデート（動作変更なし） | PATCH |

---

## リリースフロー全体像

```
develop でバージョン更新（package.json / package-lock.json / CHANGELOG.md）
   ↓  chore: release vX.Y.Z
PR "release: vX.Y.Z"（develop → main）※レビュー承認必須
   ↓  squash マージ
main にタグ vX.Y.Z（annotated）
   ↓
GitHub Release 作成  ──→  publish.yml が発火 ──→ npm publish（自動・OIDC）
   ↓
main を develop へマージバック（-s ours・祖先復元）
```

### 押さえるべき3つの前提

| 前提 | 根拠 |
|---|---|
| **main へ直接 push できない** | `.git/hooks/pre-push` が `protected_branch='main'` で拒否する。PR が唯一の経路 |
| **GitHub Release の作成 = npm への公開** | `.github/workflows/publish.yml` が `release: [published]` で発火し `npm publish` する。Release 作成は公開の実行と等価 |
| **マージバックが必須** | develop → main の PR は squash されるため develop の祖先が切れる。放置すると次回 PR で幻コンフリクトが出る |

---

## リリース手順

### 事前準備

1. **`develop` を最新化**（リリースは develop 基点。main 基点ではない）

   ```bash
   git checkout develop
   git pull origin develop
   git rev-list --left-right --count develop...origin/develop   # 0  0 であること
   ```

2. **未コミットの変更がないことを確認**

   ```bash
   git status --porcelain    # 空であること
   ```

   > `git stash` は避けてください。他のエージェントが同じ作業ツリーで稼働している場合、作業内容を破損させます。

3. **品質チェックが全てパスすることを確認**

   ```bash
   npm run lint
   npx tsc --noEmit
   npm run test:unit
   npm run build
   ```

4. **main に未反映の変更が実際にあることを確認**

   ```bash
   git fetch origin
   git diff --stat origin/main..origin/develop
   ```

   > **注意**: `git log origin/main..origin/develop` は squash の影響で実態より遥かに多くのコミットを表示します（実差分15ファイルに対し136コミット等）。**tree 差分（`git diff`）が正**です。

### Step 1: バージョン決定

```bash
node -p "require('./package.json').version"
```

上記の判断基準に従って次バージョンを決定します。

### Step 2: package.json / package-lock.json の更新

```bash
npm version 0.10.1 --no-git-tag-version
```

`npm version` は package.json と package-lock.json の**2箇所（root と `packages[""]`）を同時に整合**させます。手で書き換えないでください。

`--no-git-tag-version` は必須です。これが無いと npm がタグを打ち、後段の PR フローと衝突します。

### Step 3: CHANGELOG.md の更新

`## [Unreleased]` の直後に新セクションを挿入します。

```markdown
## [Unreleased]

## [0.10.1] - 2026-07-17

> **Highlight**: このリリースの中心を2〜4文で。何が問題で、何を変えたか。実測値があれば入れる。

### Added

- feat(scope): **要点を太字で**。補足説明 (#1234)

### Changed

- fix(docs): **要点**。補足説明 (#1234)

### Fixed

- fix(cli): **要点**。補足説明 (#1234)

## [0.10.0] - 2026-07-16
```

規約:

- **比較リンク（`[X.Y.Z]: https://github.com/.../compare/...`）は追加しない**。`0.5.2` で止まっており、以降のリリースでは付けていません（既存の古いリンクはそのまま残す）
- Issue 番号は **`(#1234)` 形式**。`(Issue #1234)` は v0.9.1 以前の旧表記
- conventional prefix（`feat(scope):` / `fix(scope):` 等）を付ける
- 日付は JST 基準
- 該当が無いカテゴリの見出しは書かない

詳細は [`templates/changelog-entry.md`](../.claude/skills/release/templates/changelog-entry.md) を参照。

### Step 4: コミット & push

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.10.1"
git push origin develop
```

変更は**この3ファイルのみ**であることを `git diff --stat` で確認してください。

### Step 5: リリース PR（develop → main）

```bash
gh pr create --repo Kewton/CommandMate --base main --head develop \
  --title "release: v0.10.1" \
  --body-file <(...)
```

PR 本文に含める要素:

- **リリース概要**: 何のためのリリースか
- **バージョン**: `0.10.0 → 0.10.1`（patch/minor/major の別）
- **DB マイグレーション**: 有無（有る場合は `CURRENT_SCHEMA_VERSION` の遷移）
- **実差分**: `git diff --stat origin/main..origin/develop` の実数。「squash 履歴のため `main..develop` のコミット数は実態より多く表示される」旨を注記
- **対応 Issue** 一覧
- **主な変更**: Added / Changed / Fixed
- **品質チェック**結果

CI 通過を確認します。

```bash
gh pr checks <PR番号> --repo Kewton/CommandMate --watch
```

> **main 向け PR はレビュー1名以上の承認が必須**です（[CLAUDE.md](../CLAUDE.md) のルール）。承認後に **squash** でマージします。

### Step 6: タグ作成・プッシュ

マージ後に実行します。

```bash
git fetch origin --tags
MERGE_SHA=$(gh pr view <PR番号> --repo Kewton/CommandMate --json mergeCommit -q '.mergeCommit.oid')

# main と develop の tree が一致していること（内容ドリフトが無いことの証明）
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse origin/develop^{tree})" ] && echo "tree 一致 OK"

git tag -a "v0.10.1" "$MERGE_SHA" -m "v0.10.1"
git push origin "v0.10.1"
```

**annotated タグ（`-a`）**であること。過去のタグは全て annotated です。

### Step 7: GitHub Releases 作成 → npm publish のトリガー

リリースノートは **CHANGELOG の該当セクションを転記**します（`--generate-notes` は v0.9.1 までの形式）。

```bash
awk '/^## \[0\.10\.1\]/{f=1} /^## \[0\.10\.0\]/{f=0} f' CHANGELOG.md > /tmp/release-notes.md

gh release create "v0.10.1" --repo Kewton/CommandMate \
  --title "v0.10.1" \
  --notes-file /tmp/release-notes.md
```

> ⚠️ **この時点で `publish.yml` が発火し npm publish が始まります。** Release の作成は「npm への公開を実行する」ことと等価です。取り消しは効きません（後述）。

### Step 8: publish ワークフローの完走確認

```bash
gh run list --repo Kewton/CommandMate --workflow=publish.yml --limit 1
# status=completed conclusion=success になるまで待つ

npm view commandmate version    # 新バージョンになること
```

### Step 9: main を develop へマージバック（祖先復元）

**必須。** squash により main のコミットは develop の祖先ではなくなっています。放置すると次回の develop → main PR で幻コンフリクトが出ます。

```bash
git checkout develop
git pull origin develop
git merge -s ours origin/main -m "chore: merge release v0.10.1 to develop (restore ancestry)"

# tree が壊れていないことを検証（-s ours は develop の tree を保持する）
[ "$(git rev-parse origin/main^{tree})" = "$(git rev-parse develop^{tree})" ] && echo "tree 一致 OK"

git push origin develop
```

効果を確認します。

```bash
git fetch origin
git merge-base --is-ancestor origin/main origin/develop && echo "祖先切れ解消 OK"
```

---

## npm への公開について

**`npm publish` を手元で実行しないでください。**

`.github/workflows/publish.yml` が GitHub Release の `published` を契機に、npm Trusted Publishers（OIDC 認証）で `npm publish --provenance --access public` を実行します。

- ローカルには publish 用の認証がありません
- OIDC は GitHub Actions 実行時にしか成立しません
- ローカル実行では provenance（来歴証明）が付きません

ワークフローが失敗した場合も、ローカル publish で回避せず、原因を修正してください。

### ワークフローの内容

`npm ci` → `npm audit --audit-level=critical` → `npm run test:unit` → `npm run build` → `npm run build:cli` → `npm run build:server` → パッケージサイズ確認 → `npm publish --provenance --access public`

---

## リリース後の確認

```bash
# タグ一覧の確認
git tag -l --sort=-v:refname | head -3

# GitHub Releases の確認
gh release view v0.10.1

# npm の反映確認
npm view commandmate version
npm view commandmate@0.10.1 dist --json    # サイズ・provenance

# クリーンな環境で実際に取得できるか（中立ディレクトリで実行すること）
cd $(mktemp -d) && npx --yes commandmate@latest --version
```

> `npx` の検証は**リポジトリ外の中立ディレクトリ**で行ってください。CommandMate のリポジトリ内で実行すると、npx がローカルの `bin` を解決してしまい、公開物を検証したことになりません。

---

## Claude Code Skillを使用したリリース

[`/release`](../.claude/skills/release/SKILL.md) スキルを使用すると、上記の手順を実行できます。

```bash
/release patch      # パッチバージョンアップ (0.10.0 → 0.10.1)
/release minor      # マイナーバージョンアップ (0.10.0 → 0.11.0)
/release major      # メジャーバージョンアップ (0.10.0 → 1.0.0)
/release 1.0.0      # 直接バージョン指定
```

スキルも PR のマージは行いません（承認が必須のため）。

---

## トラブルシューティング

### main へ push しようとして拒否された

```
❌ Error: Direct push to 'main' is not allowed.
   Please create a Pull Request instead.
```

`.git/hooks/pre-push` による正しい拒否です。**`--no-verify` で回避しないでください。** Step 5 の PR フローに戻ってください。

### タグが既に存在する場合

```bash
# エラー: fatal: tag 'v0.10.1' already exists
# 対処: 別のバージョンを指定する
```

既存タグの削除は、**npm へ publish 済みの場合は無意味**です（下記参照）。

### publish ワークフローが失敗した場合

```bash
gh run view <run-id> --repo Kewton/CommandMate --log-failed
```

原因を修正し、新しいパッチバージョンでリリースし直してください。**同一バージョン番号での再公開はできません。**

### リリースのロールバック

> ⚠️ **npm へ publish 済みの場合、実質的にロールバックできません。**
>
> - npm は公開済みバージョンの unpublish を厳しく制限しています（72時間以内などの条件付き）
> - **一度使ったバージョン番号は、unpublish しても再利用できません**
> - **GitHub Release やタグを削除しても、npm 上のパッケージは消えません**
>
> したがって、問題が見つかった場合の正しい対処は **修正して新しいパッチバージョンをリリースする**ことです。

publish 前（Release 作成前）であれば、以下で巻き戻せます。

```bash
git tag -d v0.10.1
git push origin :refs/tags/v0.10.1
```

publish 後は、修正後に次のパッチバージョンでリリースしてください。

---

## 関連ドキュメント

- [`/release` スキル](../.claude/skills/release/SKILL.md) — 手順の自動化
- [CHANGELOGエントリテンプレート](../.claude/skills/release/templates/changelog-entry.md)
- `.github/workflows/publish.yml` — Release 契機の自動 publish（OIDC）
- `.git/hooks/pre-push` — main 直 push の拒否
- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
- [CHANGELOG.md](../CHANGELOG.md)
