---
name: release
description: "git worktree + commandmatedev でリリースを自動実行"
disable-model-invocation: true
allowed-tools: "Bash, Read, Edit, Write"
argument-hint: "[version-type] (major|minor|patch) or [version] (e.g., 1.2.3)"
---

# リリーススキル

git worktree 環境を作成し、commandmatedev 経由でエージェントにリリース準備を委譲、完了後にマージ・タグ・push を実行してリリースを完了するスキルです。

## 使用方法

```bash
/release patch      # パッチバージョンアップ (0.4.9 → 0.4.10)
/release minor      # マイナーバージョンアップ (0.4.9 → 0.5.0)
/release major      # メジャーバージョンアップ (0.4.9 → 1.0.0)
/release 1.0.0      # 直接バージョン指定
```

## 前提条件

- `main` ブランチが最新であること
- commandmatedev サーバが起動していること
- `npm run lint && npx tsc --noEmit && npm run test:unit && npm run build` が通る状態であること

## 実行内容

あなたはリリースマネージャーです。以下の3フェーズでリリースを実行してください。

---

### Phase 1: worktree 作成 & 登録確認

#### 1-1. commandmatedev サーバ疎通確認

```bash
commandmatedev ls 2>&1
```

失敗した場合はエラーメッセージを表示して中断：
```
Error: commandmatedev server is not running.
Run `commandmatedev start --daemon` first.
```

#### 1-2. 現在バージョンの取得 & 次バージョン計算

```bash
CURRENT_VERSION=$(node -p "require('./package.json').version")
```

引数（patch/minor/major）に応じて次バージョンを計算する。

セマンティックバージョニングのルール：
- `patch`: `0.4.9` → `0.4.10`
- `minor`: `0.4.9` → `0.5.0`
- `major`: `0.4.9` → `1.0.0`

計算結果を `NEXT_VERSION` 変数に格納する。

#### 1-3. main ブランチを最新化

```bash
git checkout main
git pull origin main
```

#### 1-4. release ブランチ & worktree 作成

```bash
RELEASE_BRANCH="release/v${NEXT_VERSION}"
WORKTREE_DIR="../commandmate-release-v${NEXT_VERSION}"
git worktree add -b "$RELEASE_BRANCH" "$WORKTREE_DIR" main
```

worktree内で依存関係をインストール:

```bash
cd "$WORKTREE_DIR" && npm install
```

#### 1-5. worktree 登録確認

worktree が commandmatedev に認識されるまで待つ。認識されない場合はリポジトリ同期を実行する。

```bash
# 同期を試行
curl -s -X POST http://localhost:3000/api/repositories/sync

# 登録確認
commandmatedev ls --branch "release/v${NEXT_VERSION}" --quiet
```

WT ID を取得できない場合は、ユーザーに commandmatedev のブラウザ UI で worktree を確認するよう案内する。

---

### Phase 2: エージェントによるリリース準備

#### 2-1. リリースタスクをエージェントに送信

```bash
WT=$(commandmatedev ls --branch "release/v${NEXT_VERSION}" --quiet)
```

以下のプロンプトを送信する：

```bash
commandmatedev send "$WT" "v${NEXT_VERSION} のリリース準備を実行してください。

以下の手順を順番に実行してください：

1. package.json の version を \"${NEXT_VERSION}\" に更新
2. npm install --package-lock-only で package-lock.json を更新
3. git log でmainの直近の変更内容を確認し、CHANGELOG.md に v${NEXT_VERSION} のエントリを追加
   - feat, fix, refactor, docs 等のカテゴリ別に整理
   - 既存のCHANGELOGのフォーマットに合わせる
4. 以下の品質チェックを実行し、全てパスすることを確認：
   - npm run lint
   - npx tsc --noEmit
   - npm run test:unit
   - npm run build
5. 全パスしたら以下でコミット：
   git add package.json package-lock.json CHANGELOG.md
   git commit -m 'chore: release v${NEXT_VERSION}'
6. 失敗した場合は修正してリトライ

完了したら「リリース準備完了」と報告してください。" \
  --auto-yes --duration 1h
```

#### 2-2. 完了待ち

```bash
commandmatedev wait "$WT" --timeout 600 --on-prompt agent
```

**exit code による分岐:**

| exit code | 状況 | 対応 |
|---|---|---|
| `0` | 完了 | Phase 3 に進む |
| `10` | プロンプト検知 | `commandmatedev capture "$WT" --json` で内容確認し、ユーザーに判断を委ねる |
| `124` | タイムアウト | `commandmatedev capture "$WT"` で状況確認し、ユーザーに報告 |

#### 2-3. 結果確認

```bash
commandmatedev capture "$WT"
```

出力を確認し、コミットが完了しているか検証する。コミットが確認できない場合はユーザーに報告して中断する。

---

### Phase 3: マージ & タグ & push

#### 3-1. main にマージ

```bash
git checkout main
git merge "release/v${NEXT_VERSION}" --no-ff -m "release: v${NEXT_VERSION}"
```

#### 3-2. タグ打ち

```bash
git tag -a "v${NEXT_VERSION}" -m "v${NEXT_VERSION}"
```

#### 3-3. push（main + タグ）

```bash
git push origin main
git push origin "v${NEXT_VERSION}"
```

#### 3-4. develop に逆マージ

```bash
git checkout develop
git pull origin develop
git merge main --no-ff -m "chore: merge release v${NEXT_VERSION} to develop"
git push origin develop
```

#### 3-5. GitHub Releases 作成

```bash
gh release create "v${NEXT_VERSION}" --title "v${NEXT_VERSION}" --generate-notes
```

#### 3-6. worktree クリーンアップ

```bash
git worktree remove "$WORKTREE_DIR"
git branch -d "$RELEASE_BRANCH"
```

#### 3-7. CommandMate 同期

```bash
curl -s -X POST http://localhost:3000/api/repositories/sync
```

---

## 完了報告

以下の形式で報告する：

```
Release v${NEXT_VERSION} completed!

  Tag:      v${NEXT_VERSION}
  Release:  https://github.com/Kewton/CommandMate/releases/tag/v${NEXT_VERSION}

  Worktree: cleaned up
  Branches: main ✓, develop ✓ (synced)
```

## エラー時の対応

| エラー | 対応 |
|---|---|
| commandmatedev サーバ未起動 | `commandmatedev start --daemon` を案内して中断 |
| worktree が登録されない | ブラウザ UI での確認を案内 |
| エージェントがタイムアウト | `commandmatedev capture` で状況確認し報告 |
| 品質チェック失敗 | エージェントが自動修正を試みる。3回失敗で中断 |
| マージコンフリクト | ユーザーに手動解消を依頼 |
| タグが既に存在する | エラー表示し、別バージョンの指定を促す |

## 安全ガード

- main ブランチ以外からのリリースは拒否
- worktree 作成前に既存の同名 worktree がないか確認
- タグが既に存在する場合は中断
- Phase 3 に進む前にエージェントのコミットを検証

## 参考

- [リリースガイド](../../docs/release-guide.md)
- [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)
- [Semantic Versioning](https://semver.org/lang/ja/)
