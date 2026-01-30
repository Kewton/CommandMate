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

## リリース手順

### 事前準備

1. **全てのPRがmainにマージされていることを確認**
   ```bash
   git checkout main
   git pull origin main
   git status
   ```

2. **未コミットの変更がないことを確認**
   ```bash
   git status
   # "nothing to commit, working tree clean" を確認
   ```

3. **テストが全てパスすることを確認**
   ```bash
   npm run lint
   npm run test:unit
   npm run build
   ```

### Step 1: バージョン決定

現在のバージョンを確認し、新バージョンを決定します。

```bash
# 現在のバージョンを確認
cat package.json | grep '"version"'
```

### Step 2: package.jsonの更新

```bash
# package.jsonのversionを更新
# 例: 0.1.0 → 0.2.0
```

### Step 3: package-lock.jsonの更新

```bash
npm install --package-lock-only
```

### Step 4: CHANGELOG.mdの更新

1. `[Unreleased]`セクションの内容を新バージョンセクションに移動
2. リリース日を追記（YYYY-MM-DD形式）
3. 比較リンクを追加

**変更前:**
```markdown
## [Unreleased]

### Added
- 新機能の説明

### Fixed
- バグ修正の説明
```

**変更後:**
```markdown
## [Unreleased]

## [0.2.0] - 2026-01-30

### Added
- 新機能の説明

### Fixed
- バグ修正の説明
```

**比較リンクの追加（ファイル末尾）:**
```markdown
[unreleased]: https://github.com/Kewton/CommandMate/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kewton/CommandMate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kewton/CommandMate/releases/tag/v0.1.0
```

### Step 5: コミット作成

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release v0.2.0"
```

### Step 6: タグ作成・プッシュ

```bash
# タグ作成
git tag v0.2.0

# mainブランチとタグをプッシュ
git push origin main
git push origin v0.2.0
```

### Step 7: GitHub Releases作成

```bash
# リリースノートを自動生成
gh release create v0.2.0 --title "v0.2.0" --generate-notes

# または、CHANGELOG.mdの内容を使用
gh release create v0.2.0 --title "v0.2.0" --notes "$(sed -n '/## \[0.2.0\]/,/## \[0.1.0\]/p' CHANGELOG.md | head -n -1)"
```

---

## リリース後の確認

```bash
# タグ一覧の確認
git tag -l

# 最新タグの確認
git describe --tags --abbrev=0

# GitHub Releasesの確認
gh release list

# 特定リリースの詳細確認
gh release view v0.2.0
```

---

## Claude Code Skillを使用したリリース

`/release`スキルを使用すると、上記の手順を自動化できます。

```bash
# パッチバージョンアップ (0.1.0 → 0.1.1)
/release patch

# マイナーバージョンアップ (0.1.0 → 0.2.0)
/release minor

# メジャーバージョンアップ (0.1.0 → 1.0.0)
/release major

# 直接バージョン指定
/release 1.0.0
```

---

## npm versionコマンド（オプション）

npm versionコマンドを使用すると、バージョン更新とタグ作成を一括で行えます。

```bash
# パッチバージョンアップ
npm version patch -m "chore: release v%s"

# マイナーバージョンアップ
npm version minor -m "chore: release v%s"

# メジャーバージョンアップ
npm version major -m "chore: release v%s"

# タグをプッシュ
git push origin main --tags
```

**注意**: npm versionはCHANGELOG.mdを自動更新しないため、別途更新が必要です。

---

## トラブルシューティング

### タグが既に存在する場合

```bash
# エラー: fatal: tag 'v0.2.0' already exists
# 対処: 別のバージョンを指定するか、既存タグを削除

# 既存タグの削除（注意: 履歴を書き換えるため慎重に）
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
```

### リリースのロールバック

リリース後に重大な問題が発覚した場合：

1. **GitHub Releasesの削除**
   ```bash
   gh release delete v0.2.0 --yes
   ```

2. **タグの削除**
   ```bash
   git tag -d v0.2.0
   git push origin :refs/tags/v0.2.0
   ```

3. **修正後、新しいパッチバージョンでリリース**
   ```bash
   /release patch  # v0.2.1 としてリリース
   ```

---

## 関連ドキュメント

- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
- [CHANGELOG.md](../CHANGELOG.md)
