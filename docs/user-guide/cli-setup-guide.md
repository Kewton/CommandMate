[English](../en/user-guide/cli-setup-guide.md)

# CommandMate CLI セットアップガイド

このガイドでは、CommandMate を npm でインストールして使い始める方法を説明します。

---

## 目次

1. [前提条件](#前提条件)
2. [インストール](#インストール)
3. [初期設定](#初期設定)
4. [サーバーの起動と停止](#サーバーの起動と停止)
5. [CLIコマンドリファレンス](#cliコマンドリファレンス)
6. [トラブルシューティング](#トラブルシューティング)
7. [アップグレード](#アップグレード)
8. [アンインストール](#アンインストール)

---

## 前提条件

CommandMate を使用するには、以下のツールが必要です。

| ツール | バージョン | 必須 | 確認コマンド |
|--------|----------|------|------------|
| Node.js | v20+ | ✓ | `node -v` |
| npm | - | ✓ | `npm -v` |
| Git | - | ✓ | `git --version` |
| tmux | - | ✓ | `tmux -V` |
| openssl | - | ✓ | `openssl version` |
| Claude CLI | - | △（オプション） | `claude --version` |
| gh CLI | - | △（オプション） | `gh --version` |

### 前提条件の確認

```bash
# すべての依存関係を確認
node -v && npm -v && git --version && tmux -V && openssl version
```

### 各ツールのインストール

#### macOS

```bash
# Homebrew を使用
brew install node git tmux openssl
```

#### Ubuntu/Debian

```bash
sudo apt update
sudo apt install nodejs npm git tmux openssl
```

> **注意**: Windows は現在サポートされていません（tmux 依存のため）。WSL2 での動作は未検証です。

---

## インストール

npm を使用してグローバルにインストールします。

```bash
npm install -g commandmate
```

インストールを確認：

```bash
commandmate --version
```

---

## 初期設定

### 対話形式（推奨）

```bash
commandmate init
```

対話形式で以下を設定できます：
- ワークツリーのルートディレクトリ
- サーバーポート（デフォルト: 3000）
- 外部アクセスの許可（モバイルからのアクセス用）
- 認証トークン（外部アクセス有効時に自動生成）

### 非対話形式

デフォルト値で自動設定する場合：

```bash
commandmate init --defaults
```

### 既存設定の上書き

既に設定が存在する場合に上書きするには：

```bash
commandmate init --force
```

---

## サーバーの起動と停止

### サーバーの起動

#### バックグラウンド起動（推奨）

```bash
commandmate start --daemon
```

#### フォアグラウンド起動

```bash
commandmate start
```

#### 開発モード起動

```bash
commandmate start --dev
```

#### ポートを指定して起動

```bash
commandmate start --port 3001
```

### サーバーの状態確認

```bash
commandmate status
```

### サーバーの停止

```bash
commandmate stop
```

#### 強制停止

```bash
commandmate stop --force
```

### ブラウザでアクセス

サーバー起動後、ブラウザで以下にアクセス：

```
http://localhost:3000
```

> **ポート変更時**: `--port` オプションで指定したポートを使用してください。

---

## CLIコマンドリファレンス

### commandmate --version

バージョンを表示します。

```bash
commandmate --version
```

### commandmate init

初期設定を行います。

```bash
commandmate init [options]
```

| オプション | 説明 |
|-----------|------|
| `--defaults` | デフォルト値で非対話形式で設定 |
| `--force` | 既存設定を上書き |

### commandmate start

サーバーを起動します。

```bash
commandmate start [options]
```

| オプション | 説明 |
|-----------|------|
| `--daemon` | バックグラウンドで起動 |
| `--dev` | 開発モードで起動 |
| `--port <port>` | ポートを指定（デフォルト: 3000） |

### commandmate stop

サーバーを停止します。

```bash
commandmate stop [options]
```

| オプション | 説明 |
|-----------|------|
| `--force` | 強制停止 |

### commandmate status

サーバーの状態を表示します。

```bash
commandmate status
```

### commandmate issue

GitHub Issue管理コマンドです（gh CLIが必要）。

```bash
commandmate issue create [options]
commandmate issue search <query>
commandmate issue list
```

| サブコマンド | 説明 |
|-------------|------|
| `create` | 新規Issue作成 |
| `search <query>` | Issue検索 |
| `list` | Issue一覧表示 |

#### create オプション

| オプション | 説明 |
|-----------|------|
| `--title <title>` | Issueタイトル |
| `--body <body>` | Issue本文 |
| `--bug` | Bug Reportテンプレートを使用 |
| `--feature` | Feature Requestテンプレートを使用 |
| `--question` | Questionテンプレートを使用 |
| `--labels <labels>` | ラベル（カンマ区切り） |

### commandmate docs

CommandMateのドキュメントを表示します。

```bash
commandmate docs [options]
```

| オプション | 説明 |
|-----------|------|
| `--section <name>` | 指定セクションの内容を表示 |
| `--search <query>` | ドキュメント内を検索 |
| `--all` | 利用可能なセクション一覧を表示 |

---

## トラブルシューティング

### command not found エラー

`commandmate: command not found` と表示される場合：

```bash
# npm グローバルの bin パスを確認
npm config get prefix

# PATH に追加（bash/zsh）
export PATH="$(npm config get prefix)/bin:$PATH"

# 永続化（~/.bashrc or ~/.zshrc に追加）
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 権限エラー（EACCES）

`npm install -g` で権限エラーが発生する場合：

#### 方法1: npm prefix を変更（推奨）

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH

# 永続化
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc

# 再インストール
npm install -g commandmate
```

#### 方法2: sudo を使用（非推奨）

```bash
sudo npm install -g commandmate
```

### ポート競合

`Error: Port 3000 is already in use` と表示される場合：

```bash
# 別ポートで起動
commandmate start --port 3001

# または使用中のプロセスを確認して停止
lsof -ti:3000 | xargs kill -9
```

### サーバーが起動しない

```bash
# ステータス確認
commandmate status

# 強制停止して再起動
commandmate stop --force
commandmate start --daemon

# ログを確認（設定ディレクトリ内）
tail -f ~/.commandmate/logs/server.log
```

### 依存関係のエラー

```bash
# tmux が見つからない
brew install tmux  # macOS
sudo apt install tmux  # Ubuntu/Debian

# Node.js のバージョンが古い
node -v  # v20 以上が必要
```

### データベースエラー

```bash
# データベースをリセット（データが削除されます）
rm -rf ~/.commandmate/data
commandmate init --force
```

---

## アップグレード

最新バージョンにアップグレードするには：

```bash
npm install -g commandmate@latest
```

アップグレード後、バージョンを確認：

```bash
commandmate --version
```

サーバーを再起動：

```bash
commandmate stop
commandmate start --daemon
```

---

## アンインストール

### 1. サーバーを停止

```bash
commandmate stop
```

### 2. パッケージをアンインストール

```bash
npm uninstall -g commandmate
```

### 3. 設定ファイルを削除（オプション）

```bash
# 設定とデータを完全に削除
rm -rf ~/.commandmate
```

---

## 次のステップ

- [Webアプリ操作ガイド](./webapp-guide.md) - ブラウザからの基本操作
- [クイックスタートガイド](./quick-start.md) - Claude Code コマンドの使い方
- [デプロイガイド](../DEPLOYMENT.md) - 本番環境への展開

---

## 関連ドキュメント

- [README](../../README.md) - プロジェクト概要
- [アーキテクチャ](../architecture.md) - システム設計
- [Trust & Safety](../TRUST_AND_SAFETY.md) - セキュリティと権限
