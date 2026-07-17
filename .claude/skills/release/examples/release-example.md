# リリース実行例

`/release` スキルの実行例です。**v0.10.1 の実際のリリース記録**を題材にしています（2026-07-17 実施）。

## 例: パッチリリース (v0.10.0 → v0.10.1)

### コマンド

```
/release patch
```

### Phase 1: 事前確認

```
📋 事前チェック
  ✅ develop ブランチで実行中
  ✅ 未コミットの変更なし
  ✅ origin/develop と同期済み (0  0)
  ✅ main..develop に tree 差分あり (15 files, +559 -92)

📊 バージョン情報
  現在: 0.10.0
  新規: 0.10.1
  種別: patch

🏷️ タグチェック
  ✅ v0.10.1 は存在しません
```

> `git log origin/main..origin/develop` は squash の影響で 136 件と表示されるが、**tree 差分（15 files）が正**。コミット数で判断しないこと。

### Phase 2: バージョン更新（develop 上）

```
📝 ファイル更新
  ✅ npm version 0.10.1 --no-git-tag-version
       package.json      0.10.0 → 0.10.1
       package-lock.json root と packages[""] の2箇所を同時更新
  ✅ CHANGELOG.md に [0.10.1] セクションを追加
       （比較リンクは追加しない）

✅ 品質ゲート
  lint  PASS
  tsc   PASS
  test  PASS (581 files / 9888 tests)
  build PASS

📤 コミット & push
  ✅ chore: release v0.10.1  (1873dcf1)
  ✅ 変更は3ファイルのみ (CHANGELOG.md / package.json / package-lock.json)
  ✅ git push origin develop
```

### Phase 3: リリース PR

```
🔀 PR 作成
  ✅ release: v0.10.1  (develop → main)
     https://github.com/Kewton/CommandMate/pull/1325

⏳ CI
  ✅ 全9チェック通過

⚠️ main 向け PR はレビュー承認が必須です。
   マージはユーザーが行ってください。CI 通過を報告してここで待機します。
```

### Phase 4: マージ後

```
✅ マージ確認
  7edcb567 release: v0.10.1 (#1325)   ← squash (parents=1)
  main package.json = 0.10.1
  tree 一致検証: main == develop ✅

🏷️ タグ
  ✅ git tag -a v0.10.1 7edcb567 -m "v0.10.1"
  ✅ git push origin v0.10.1

🎉 GitHub Release
  ✅ CHANGELOG の [0.10.1] セクションを転記して作成
     https://github.com/Kewton/CommandMate/releases/tag/v0.10.1

  ⚠️ この時点で publish.yml が発火 → npm publish が自動で始まる

📦 publish ワークフロー
  ✅ run 29546342769  conclusion=success
  ✅ npm view commandmate version → 0.10.1
     unpackedSize 20.1 MB / tarball 5.2 MB / provenance あり

🔄 マージバック（祖先復元）
  ✅ git merge -s ours origin/main -m "chore: merge release v0.10.1 to develop (restore ancestry)"
  ✅ tree 一致検証 OK
  ✅ git push origin develop  (0d4398c8)
  ✅ merge-base --is-ancestor origin/main origin/develop → 祖先切れ解消
```

### 完了報告

```
Release v0.10.1 completed!

  Tag:      v0.10.1 → 7edcb567
  Release:  https://github.com/Kewton/CommandMate/releases/tag/v0.10.1
  npm:      0.10.1 (tarball 5.2 MB, provenance あり)

  Branches: main ✓, develop ✓ (ancestry restored, tree一致検証済み)
```

---

## エラー例

### develop 以外で実行した場合

```
📋 事前チェック
  ❌ 現在のブランチ: main

リリースは develop 基点です。develop に切り替えてください:
  git checkout develop && git pull origin develop

リリースを中断しました。
```

### 未コミットの変更がある場合

```
📋 事前チェック
  ❌ 未コミットの変更があります

  M src/lib/env.ts
  ?? new-file.ts

対処方法:
  1. 変更をコミット: git add . && git commit -m "..."
  2. 変更を破棄: git checkout .

⚠️ git stash は避けてください。他のエージェントが同じ作業ツリーで
   稼働している場合、作業内容を破損させます。

リリースを中断しました。
```

### タグが既に存在する場合

```
🏷️ タグチェック
  ❌ タグ v0.10.1 は既に存在します

対処方法:
  1. 別のバージョンを指定: /release 0.10.2
  2. 既存タグを削除（非推奨・publish 済みなら不可）:
     git tag -d v0.10.1 && git push origin :refs/tags/v0.10.1

リリースを中断しました。
```

### main へ push しようとした場合

```
$ git push origin main

❌ Error: Direct push to 'main' is not allowed.
   Please create a Pull Request instead.
```

これは `.git/hooks/pre-push` による正しい拒否です。**`--no-verify` で回避しないでください。**
PR 経由（Phase 3）に戻ってください。

### publish ワークフローが失敗した場合

```
📦 publish ワークフロー
  ❌ run 29546342769  conclusion=failure
     失敗ステップ: Security audit

ユーザーに報告して指示を仰いでください。

⚠️ npm publish をローカル実行して回避しないこと。
   この構成は OIDC (npm Trusted Publishers) で CI からのみ publish します。
   ローカルには認証が無く、provenance も付きません。
```

### main..develop に差分が無い場合

```
📋 事前チェック
  ❌ main..develop の tree 差分が空です

リリースする変更がありません。リリースを中断しました。
```
