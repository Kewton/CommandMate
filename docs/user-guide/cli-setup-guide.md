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
6. [エージェント側の設定](#エージェント側の設定)
7. [トラブルシューティング](#トラブルシューティング)
8. [アップグレード](#アップグレード)
9. [アンインストール](#アンインストール)

---

## 前提条件

CommandMate を使用するには、以下のツールが必要です。

| ツール | バージョン | 必須 | 確認コマンド |
|--------|----------|------|------------|
| Node.js | v22+ | ✓ | `node -v` |
| npm | - | ✓ | `npm -v` |
| Git | - | ✓ | `git --version` |
| tmux | - | ✓ | `tmux -V` |
| Claude CLI | - | △（オプション） | `claude --version` |
| gh CLI | - | △（オプション） | `gh --version` |

### 前提条件の確認

```bash
# すべての依存関係を確認
node -v && npm -v && git --version && tmux -V
```

### 各ツールのインストール

#### macOS

```bash
# Homebrew を使用
brew install node git tmux
```

#### Ubuntu/Debian

```bash
sudo apt update
sudo apt install nodejs npm git tmux
```

> **注意**: ネイティブ Windows は tmux 依存のためサポートしていません。Windows では WSL2 上で CommandMate を実行してください（[WSL2 セットアップガイド](./wsl2-setup.md) を参照）。

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
commandmate status              # メインサーバーの状態
commandmate status --all        # 全サーバー（main + worktree）の状態
commandmate status --issue 135  # Issue #135用worktreeサーバーの状態
```

### サーバーの停止

```bash
commandmate stop                # メインサーバーを停止
commandmate stop --issue 135    # Issue #135用worktreeサーバーを停止
```

#### 強制停止

```bash
commandmate stop --force
```

### ブラウザでアクセス

サーバー起動後、ブラウザで以下にアクセス：

```
http://127.0.0.1:3000
```

> **ポート変更時**: `--port` オプションで指定したポートを使用してください。

> **`localhost` ではなく `127.0.0.1`**: CommandMate は既定で `127.0.0.1` に bind します（`CM_BIND`）。
> macOS などでは `localhost` が `::1`（IPv6）を先に解決しますが、CommandMate はそのアドレスを listen
> していません。別プロセスが `::1:3000` を掴んでいると、ブラウザは黙ってそちらに繋がります。
> 起動時のセルフチェックがこれを検出すると、起動ログと `commandmate status` の両方に警告が出ます。

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
| `-p, --port <number>` | ポートを指定（デフォルト: 3000） |
| `-i, --issue <number>` | 指定Issueのworktree用サーバーを起動（Issue #136） |
| `--auto-port` | worktree用サーバーのポートを自動割当（Issue #136） |
| `--auth` | トークン認証を有効化（Issue #331） |
| `--auth-expire <duration>` | トークン有効期限（例: `24h`, `7d`, `90m`） |
| `--https` | HTTPSを有効化 |
| `--cert <path>` | TLS証明書ファイルのパス |
| `--key <path>` | TLS秘密鍵ファイルのパス |
| `--allow-http` | 証明書なしで `--auth` を使う際のHTTPS警告を抑制 |
| `--allowed-ips <cidrs>` | 許可するIP/CIDR（カンマ区切り、Issue #331） |
| `--trust-proxy` | リバースプロキシの `X-Forwarded-For` ヘッダーを信頼 |

#### Worktree並列開発（Issue #136）

worktree ごとに独立したサーバーを起動できます。

```bash
commandmate start --issue 135 --auto-port  # Issue #135用サーバーを起動（ポート自動割当）
commandmate start --issue 135 --port 3135  # 特定ポートで起動
```

#### 認証・外部公開（Issue #331）

```bash
commandmate start --auth --auth-expire 24h          # トークン認証（有効期限24h）
commandmate start --auth --allowed-ips 192.168.1.0/24  # IP制限付き
commandmate start --https --cert ./cert.pem --key ./key.pem  # HTTPS
```

### commandmate stop

サーバーを停止します。

```bash
commandmate stop [options]
```

| オプション | 説明 |
|-----------|------|
| `-f, --force` | 強制停止（SIGKILL） |
| `-i, --issue <number>` | 指定Issueのworktree用サーバーを停止（Issue #136） |

### commandmate status

サーバーの状態を表示します。

```bash
commandmate status [options]
```

| オプション | 説明 |
|-----------|------|
| `-i, --issue <number>` | 指定Issueのworktree用サーバーの状態を表示（Issue #136） |
| `-a, --all` | 全サーバー（main + worktree）の状態を表示 |

### commandmate update

最新バージョンに更新します（停止 → `npm install -g commandmate@latest` → 再起動）。

```bash
commandmate update [options]
```

| オプション | 説明 |
|-----------|------|
| `--check` | 更新の有無を確認するだけ（インストール・停止・再起動を行わない） |
| `-y, --yes` | 確認プロンプトをスキップ（非対話環境では必須） |

詳細と注意事項は [アップグレード](#アップグレード) を参照してください。

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

## エージェント側の設定

### Codex の更新ダイアログ（`CM_CODEX_UPDATE_DIALOG`、Issue #2068）

codex は TUI を開く前に新しいリリースを確認し、`$CODEX_HOME/version.json` に
`latest_version` がキャッシュされていると（＝ 2 回目以降の起動で）次のダイアログを出します。

```
  ✨ Update available! 0.149.1 -> 0.151.0
  Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version
  Press enter to continue
```

CommandMate がこれにどう答えるかは `CM_CODEX_UPDATE_DIALOG` で選べます。
サーバー（`commandmate start`）の環境変数として設定してください。

| 値 | 送るキー | 挙動 |
|---|---|---|
| `skip` | `2` | ダイアログを閉じるだけ。**何も記録されないので次回起動でまた出ます** |
| `skip-until-next-version`（**既定**） | `3` | `version.json` に `dismissed_version` が書かれ、**次の版が出るまで二度と出ません** |
| `update` | `1` | codex が `npm install -g @openai/codex` に置き換わって終了 → **インストール完了後に CommandMate が同じ pane へ起動コマンドを送り直します** |
| `ask` | （送らない） | ダイアログをそのまま残し、**人がプロンプトパネルで選びます** |

値を認識できない場合（綴り間違いなど）は既定にフォールバックします。`updates` が
`update` として解釈されることはありません。

```bash
# 既定を明示する
CM_CODEX_UPDATE_DIALOG=skip-until-next-version commandmate start --daemon

# 起動のたびに最新へ上げる（npm のグローバル領域に書き込みます）
CM_CODEX_UPDATE_DIALOG=update commandmate start --daemon

# 自分で選ぶ
CM_CODEX_UPDATE_DIALOG=ask commandmate start --daemon
```

#### 既定が `3` である理由

codex-cli 0.149.1 で実測した結果です（隔離した `CODEX_HOME`、2026-08-31）。

| キー | 実行後の `version.json` | 次回起動 |
|---|---|---|
| `2` | `dismissed_version: null`（変化なし） | **またダイアログが出る** |
| `3` | `dismissed_version: "0.151.0"` | 出ない |
| `1` | 変化なし。codex は `npm install` に置き換わって終了 | — |

`2` は「閉じた」だけで何も覚えないため、CommandMate 経由では毎回ダイアログが出て、
しかも毎回サーバーが勝手に閉じるので**利用者が更新を選べません**。これが Issue #2068 の
報告内容です。

#### `ask` を選んだときの注意

- ダイアログが残っている間、その pane はプロンプト待ちです。`commandmate wait` は
  exit 10（プロンプト検出）で返り、`commandmate send` は「まだ入力できない」として失敗します。
- **Auto-Yes はこのダイアログには答えません**（Issue #1829 のガード）。`1` は codex を
  終了させるため、機械が選んでよい選択肢ではないからです。
- パネルで `1`（Update now）を選ぶと codex は終了し、pane にシェルが残ります。
  セッション起動の待ち時間内であれば CommandMate が起動コマンドを送り直しますが、
  それより後に選んだ場合は **Stop → Start でセッションを起こし直してください**。

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
node -v  # v22 以上が必要
```

### データベースエラー

```bash
# データベースをリセット（データが削除されます）
rm -rf ~/.commandmate/data
commandmate init --force
```

---

## アップグレード

グローバルインストール（`npm install -g commandmate`）の場合は、`commandmate update` の 1 コマンドでアップグレードできます。

```bash
commandmate update
```

グローバルインストール環境では、次の順で実行されます。

1. npm registry に最新バージョンを問い合わせ、現在のバージョンと比較する
2. 更新がある場合のみ、注意事項を表示して確認を求める（デフォルトは「いいえ」）
3. サーバーが稼働中であれば停止する
4. `npm install -g commandmate@latest` を実行する
5. インストールされたバージョンが最新版と一致するか検証する
6. 停止したサーバーを再起動し、応答を確認する（最大 30 秒）

更新前に稼働していなかった場合、サーバーは再起動されません（勝手に起動しません）。
すでに最新の場合・ローカルの方が新しい場合・プレリリース版の場合は、更新せずに終了します。

### 更新の有無だけを確認する

`--check` を付けると、バージョンを表示するだけで何も変更しません。

```bash
commandmate update --check
```

```
Current: v0.9.0
Latest: v0.10.0
Update available: yes
```

### 非対話環境での実行

確認プロンプトをスキップするには `--yes` を付けます。

```bash
commandmate update --yes
```

TTY のない環境（CI・スクリプト等）で `--yes` を付けずに実行した場合、更新は実行されず終了コード `2` で終了します。

### アップグレード時の注意

- **起動オプションは復元されません**: 再起動後は `.env` の設定のみで起動します。`--auth` / `--auth-expire` / `--cert` / `--key` / `--allow-http` / `--allowed-ips` / `--trust-proxy` / `--port` / `--dev` を付けて起動していた場合は、update 後に手動で起動し直してください（`--auth` は起動のたびに新しいトークンが生成されるため、既存のトークンは無効になります）。
- **worktree 用サーバー（`--issue`）は自動で停止・再起動されません**: `npm install -g` はパッケージディレクトリ（`dist/` / `.next/`）を置換するため、稼働中の worktree サーバーは異常終了する可能性があります。update **前**に `commandmate stop --issue <number>` で停止し、update 後に `commandmate start --issue <number>` で再起動してください（稼働中の場合は update が警告を表示します）。
- **権限エラー（EACCES）**: `sudo` で再実行しないでください。[権限エラー（EACCES）](#権限エラーeacces) の手順で npm のグローバルディレクトリの権限を修正してから、再度 `commandmate update` を実行します。
- **認証が有効な場合**: 再起動後の応答確認が「サーバー応答の確認のみ」に緩和され、警告付きで成功終了します。厳密に確認するには `CM_AUTH_TOKEN` を設定して実行してください（IP 制限・自己署名証明書の環境でも同様に緩和されます）。
- **更新に失敗した場合**: 更新前のバージョンに戻すコマンド（`npm install -g commandmate@<更新前のバージョン>`）が表示されます。サーバーの停止に失敗した場合は、何も変更せずに中止されます。

### 手動でアップグレードする（fallback）

`commandmate update` を使えない場合は、従来どおり手動でアップグレードできます。

```bash
commandmate stop
npm install -g commandmate@latest
commandmate start --daemon
```

git clone した開発環境（グローバルインストールではない環境）では、`commandmate update` は更新を実行せず次の手順を案内して終了します。

```bash
git pull
npm install
npm run build:all
commandmate stop && commandmate start --daemon   # または npm start
```

> `npm run build` ではなく `npm run build:all` を実行してください。`npm run build` は Next.js のビルドのみで、サーバー本体（`dist/server`）と CLI（`dist/cli`）が更新されません。

アップグレード後、バージョンを確認：

```bash
commandmate --version
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
