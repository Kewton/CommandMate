---
name: release
description: "Create a new release with version bump, CHANGELOG update, Git tag, and GitHub Release. Use when releasing a new version of the project."
disable-model-invocation: true
allowed-tools: "Bash, Read, Edit, Write"
argument-hint: "[version-type] (major|minor|patch) or [version] (e.g., 1.2.3)"
---

# リリーススキル

新しいバージョンをリリースします。バージョン更新、CHANGELOG更新、Gitタグ作成、GitHub Releases作成を自動化します。

## 使用方法

```bash
/release patch      # パッチバージョンアップ (0.1.0 → 0.1.1)
/release minor      # マイナーバージョンアップ (0.1.0 → 0.2.0)
/release major      # メジャーバージョンアップ (0.1.0 → v1.0.0)
/release 1.0.0      # 直接バージョン指定
```

## 実行手順

### 1. 事前チェック

以下を確認してください：

```bash
# 現在のブランチがmainであることを確認
git branch --show-current

# 未コミットの変更がないことを確認
git status

# リモートと同期していることを確認
git fetch origin
git status
```

**エラーケースの対応:**

| 状況 | 対応 |
|------|------|
| mainブランチでない | `git checkout main` を実行 |
| 未コミットの変更がある | コミットまたはスタッシュを促す |
| リモートと差分がある | `git pull origin main` を促す |

### 2. 現在のバージョン取得

```bash
# package.jsonからバージョンを取得
current_version=$(node -p "require('./package.json').version")
echo "Current version: $current_version"
```

### 3. 新バージョンの計算

引数に基づいて新バージョンを計算します：

- `patch`: PATCH部分を+1 (例: 0.1.0 → 0.1.1)
- `minor`: MINOR部分を+1、PATCHを0に (例: 0.1.1 → 0.2.0)
- `major`: MAJOR部分を+1、MINOR/PATCHを0に (例: 0.2.0 → 1.0.0)
- 直接指定: 指定されたバージョンをそのまま使用

### 4. タグ存在チェック

```bash
# タグが既に存在しないことを確認
if git rev-parse "v$new_version" >/dev/null 2>&1; then
  echo "Error: Tag v$new_version already exists"
  exit 1
fi
```

### 5. package.json更新

```bash
# package.jsonのversionを更新
# Editツールを使用して "version": "x.y.z" を "version": "新バージョン" に変更
```

### 6. package-lock.json更新

```bash
npm install --package-lock-only
```

### 7. CHANGELOG.md更新

1. `[Unreleased]`セクションが空でないことを確認
2. `[Unreleased]`の下に新バージョンセクションを追加
3. 日付を`YYYY-MM-DD`形式で追記

**注意:** `[Unreleased]`セクションが空の場合は警告を表示し、続行するか確認します。

### 8. コミット作成

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v$new_version"
```

### 9. タグ作成・プッシュ

```bash
git tag "v$new_version"
git push origin main
git push origin "v$new_version"
```

### 10. GitHub Releases作成

```bash
gh release create "v$new_version" --title "v$new_version" --generate-notes
```

## 完了確認

リリース完了後、以下を確認します：

```bash
# タグ一覧
git tag -l

# 最新タグ
git describe --tags --abbrev=0

# GitHub Releases
gh release list
```

## エラーハンドリング

| エラーケース | 対応 |
|-------------|------|
| 未コミットの変更がある | エラー表示し、コミットまたはスタッシュを促す |
| リモートとの差分がある | `git pull`を促す |
| タグが既に存在する | エラー表示し、別バージョンの指定を促す |
| CHANGELOG.mdが存在しない | 新規作成するか確認 |
| [Unreleased]セクションが空 | 警告を表示し、続行するか確認 |

## 参考

- [リリースガイド](../../docs/release-guide.md)
- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
