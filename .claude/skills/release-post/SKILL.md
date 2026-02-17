---
name: release-post
description: リリース情報をX（Twitter）投稿用の文面として生成する。「Xに投稿」「リリース告知」「SNS投稿」などの指示で使用する。
disable-model-invocation: true
allowed-tools: Bash(git tag*), Bash(git log*), Read
argument-hint: [from-version] [to-version] (e.g., v0.2.4 v0.2.9)
---

# リリース投稿スキル

リリース情報をX（Twitter）投稿用の文面として生成します。

## 使用方法

```bash
/release-post v0.2.4 v0.2.9    # v0.2.4〜v0.2.9の範囲で生成
/release-post v0.2.9            # 直前バージョンからv0.2.9までの範囲で生成
/release-post                   # 最新リリースの投稿を生成
```

## 実行手順

### 1. バージョン範囲の特定

$ARGUMENTS から開始バージョンと終了バージョンを特定する。

- 引数が2つ: `from-version` と `to-version` として使用
- 引数が1つ: そのバージョンを `to-version` とし、1つ前のタグを `from-version` とする
- 引数なし: 最新タグを `to-version`、1つ前のタグを `from-version` とする

```bash
# タグ一覧から特定
git tag -l --sort=-v:refname
```

### 2. CHANGELOG.mdから変更内容を収集

`CHANGELOG.md` を読み、対象バージョン範囲のセクションからすべての変更内容を収集する。

### 3. 投稿文面の生成

以下のフォーマットルールに従って投稿文を生成する。

#### フォーマットルール

- **文字数**: 280文字以内（URLを除く）
- **言語**: 日本語
- **トーン**: カジュアルだがプロフェッショナル
- **構成**:
  1. タイトル行: `CommandMate v{to-version} リリース 🎉`（複数バージョンの場合は `v{from}〜v{to}`）
  2. サブタイトル: 前バージョンからの進化を簡潔に
  3. 主要変更の箇条書き（各項目に絵文字アイコン付き）
  4. プロジェクト説明の固定行
  5. GitHubリンク
  6. ハッシュタグ

#### 絵文字の使い方

変更カテゴリに応じた絵文字を使用する:

| カテゴリ | 絵文字例 |
|---------|---------|
| 新機能 | ✨, 🆕, 📁, 🔔, 🌐 |
| バグ修正 | 🩹, 🔧, 🐛 |
| セキュリティ | 🔒, 🛡️ |
| パフォーマンス | ⚡, 🚀 |
| UI/UX | 🎨, 📱 |
| CLI | 💻, ⌨️ |
| AI/LLM | 🤖 |

#### 固定フッター

```
Git worktree × Claude Code/Codex CLI × tmux の統合ツール
github.com/Kewton/CommandMate

#CommandMate #ClaudeCode #git #Tmux #codex
```

#### 箇条書きのルール

- 各項目は機能の**ユーザー向けメリット**を簡潔に記載（実装詳細は不要）
- 1項目は20文字程度を目安に
- 最大6項目まで（多い場合は主要なものに絞る）
- 優先順位: 新機能 > バグ修正 > リファクタリング

### 4. 出力

生成した投稿文をコードブロックで表示し、文字数（URL除く概算）を併記する。
