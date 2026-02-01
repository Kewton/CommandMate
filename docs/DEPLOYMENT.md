# CommandMate デプロイメントガイド

本ドキュメントは、CommandMate をプロダクション環境にデプロイする手順を説明します。

## 目次

1. [前提条件](#前提条件)
2. [セットアップ手順](#セットアップ手順)
3. [開発環境セットアップ](#開発環境セットアップ)
4. [環境変数の設定](#環境変数の設定)
5. [ビルドとデプロイ](#ビルドとデプロイ)
6. [プロセス管理](#プロセス管理)
7. [セキュリティ](#セキュリティ)
8. [トラブルシューティング](#トラブルシューティング)

## 前提条件

以下のツールがインストールされている必要があります：

| ツール | バージョン | 必須 | 確認コマンド |
|--------|----------|------|------------|
| Node.js | v20+ | ✓ | `node -v` |
| npm | - | ✓ | `npm -v` |
| Git | - | ✓ | `git --version` |
| tmux | - | ✓ | `tmux -V` |
| openssl | - | ✓ | `openssl version` |
| Claude CLI | - | △ | `claude --version` |

## セットアップ手順

### npm グローバルインストール（推奨）

最も簡単な方法です。

```bash
# インストール
npm install -g commandmate

# 初期設定（対話形式）
commandmate init

# サーバー起動
commandmate start --daemon
```

ブラウザで http://localhost:3000 にアクセスしてください。

### CLI コマンド

| コマンド | 説明 |
|---------|------|
| `commandmate init` | 初期設定（対話形式） |
| `commandmate init --defaults` | 初期設定（デフォルト値） |
| `commandmate start --daemon` | バックグラウンド起動 |
| `commandmate start --port 3001` | ポートを指定して起動 |
| `commandmate stop` | サーバー停止 |
| `commandmate status` | 状態確認 |

詳しくは [CLI セットアップガイド](./user-guide/cli-setup-guide.md) を参照してください。

---

## 開発環境セットアップ

> **Note**: 以下は開発者・コントリビューター向けのセットアップです。一般利用には上記の npm グローバルインストールを推奨します。

### 自動セットアップ

```bash
git clone https://github.com/kewton/CommandMate.git
cd CommandMate
./scripts/setup.sh  # 依存チェック、環境設定、ビルド、起動まで自動実行
```

`setup.sh` は以下を自動実行します：
1. 依存関係のチェック（`preflight-check.sh`）
2. npm 依存関係のインストール
3. 対話式環境設定（`setup-env.sh`）
4. データベース初期化、ビルド、起動（`build-and-start.sh --daemon`）

### 手動セットアップ

カスタマイズが必要な場合は、手動でセットアップできます：

#### 1. リポジトリのクローン

```bash
git clone https://github.com/kewton/CommandMate.git
cd CommandMate
```

#### 2. 依存関係のチェック

```bash
./scripts/preflight-check.sh
```

#### 3. npm 依存関係のインストール

```bash
npm install
```

#### 4. 環境変数の設定

**対話式設定（推奨）**:

```bash
./scripts/setup-env.sh
```

対話式で以下を設定できます：
- `CM_ROOT_DIR`: ワークツリーのルートディレクトリ
- `CM_PORT`: サーバーポート（デフォルト: 3000）
- `CM_BIND`: バインドアドレス（外部アクセス有効時は 0.0.0.0）
- `CM_AUTH_TOKEN`: 認証トークン（外部アクセス有効時に自動生成）

**手動設定**:

```bash
cp .env.production.example .env
# .env を編集
```

**重要**: `CM_AUTH_TOKEN` は必ず安全なランダム値を設定してください：

```bash
openssl rand -hex 32
```

> **Note**: 旧名称の環境変数（`MCBD_*`）も後方互換性のためサポートされていますが、新名称（`CM_*`）の使用を推奨します。

#### 5. データベースの初期化

```bash
npm run db:init
```

#### 6. ビルド

```bash
npm run build
```

> **Note**: `./scripts/*` スクリプトは開発環境（git clone）でのみ使用可能です。グローバルインストールでは `commandmate` CLI を使用してください。

## 環境変数の設定

### 必須変数

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `CM_ROOT_DIR` | ワークツリーのルートディレクトリ | `/home/user/projects` |
| `CM_BIND` | バインドアドレス（本番は `0.0.0.0`） | `0.0.0.0` |
| `CM_AUTH_TOKEN` | API認証トークン（本番必須） | `abc123...` |

### オプション変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `CM_PORT` | サーバーポート | `3000` |
| `CM_DB_PATH` | SQLiteデータベースのパス | `./data/cm.db` |
| `CM_LOG_LEVEL` | ログレベル | `info` |
| `CM_LOG_FORMAT` | ログフォーマット | `json` |

> **Note**: 旧名称（`MCBD_*`）も後方互換性のためサポートされています。詳細は `.env.example` を参照してください。

## ビルドとデプロイ

### プロダクションビルド

```bash
# ビルド
npm run build

# ビルドの確認
npm run start
```

### プロセス管理（PM2推奨）

PM2を使用したデプロイ例：

```bash
# PM2のインストール
npm install -g pm2

# アプリケーションの起動
pm2 start npm --name "commandmate" -- start

# 自動起動の設定
pm2 startup
pm2 save

# ステータス確認
pm2 status

# ログ確認
pm2 logs commandmate

# 再起動
pm2 restart commandmate

# 停止
pm2 stop commandmate
```

### Systemdサービス（オプション）

`/etc/systemd/system/commandmate.service`:

```ini
[Unit]
Description=CommandMate
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/CommandMate
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

起動:

```bash
sudo systemctl enable commandmate
sudo systemctl start commandmate
sudo systemctl status commandmate
```

## セキュリティ

### 認証トークンの生成

安全なトークンを生成:

```bash
openssl rand -hex 32
```

### ファイアウォール設定

必要なポートのみ開放:

```bash
# UFW（Ubuntu/Debian）
sudo ufw allow 3000/tcp

# firewalld（RHEL/CentOS）
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### リバースプロキシ（Nginx）

Nginx設定例:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket サポート
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

### HTTPS設定（Let's Encrypt）

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## トラブルシューティング

### 開発モードでの WebSocket エラー（モバイルアクセス時）

開発モード（`npm run dev`）でモバイルブラウザからアクセスすると、以下のようなエラーが表示されることがあります：

```
⨯ uncaughtException: RangeError: Invalid WebSocket frame: invalid status code XXXXX
```

**原因**: Next.js の HMR (Hot Module Replacement) WebSocket がモバイルブラウザの不正なクローズフレームを受信

**解決策**: モバイルからアクセスする場合は **本番モード** を使用してください：

```bash
npm run build
npm start
```

> **注意**: このエラーはサーバーの動作には影響しません（クラッシュしません）。
> 開発モードでは HMR が有効なため、この種のエラーログは完全には抑制できません。

### サーバーが Ctrl+C で停止しない

WebSocket 接続がアクティブな場合、グレースフルシャットダウンに時間がかかることがあります。

**解決策**:
- 1回目の Ctrl+C でシャットダウン開始（3秒以内に完了）
- 2回目の Ctrl+C で強制終了
- または、以下のコマンドで強制終了：

```bash
lsof -ti:3000 | xargs kill -9
```

### ポートが使用中

```bash
# ポート使用状況の確認
lsof -ti:3000

# プロセスの終了
kill -9 $(lsof -ti:3000)
```

### データベースエラー

```bash
# データベースのリセット
npm run db:reset
```

### ログの確認

```bash
# PM2使用時
pm2 logs commandmate

# Systemd使用時
sudo journalctl -u commandmate -f
```

### パーミッションエラー

```bash
# データディレクトリの権限設定
chmod 755 data
chmod 644 data/db.sqlite
```

## アップデート手順

### npm グローバルインストールの場合

```bash
# サーバー停止
commandmate stop

# 最新版にアップグレード
npm install -g commandmate@latest

# サーバー再起動
commandmate start --daemon
```

### 開発環境（git clone）の場合

```bash
# 最新コードの取得
git pull origin main

# 依存関係の更新
npm install

# ビルド
npm run build

# PM2使用時
pm2 restart commandmate

# Systemd使用時
sudo systemctl restart commandmate
```

## バックアップ

定期的なバックアップを推奨:

```bash
# データベースのバックアップ
cp data/db.sqlite data/db.sqlite.backup.$(date +%Y%m%d)

# 環境変数のバックアップ
cp .env .env.backup
```

## モニタリング

### ヘルスチェック

```bash
curl http://localhost:3000/
```

### PM2モニタリング

```bash
pm2 monit
```

## サポート

問題が発生した場合:

1. [GitHub Issues](https://github.com/kewton/CommandMate/issues)
2. ログファイルの確認
3. 環境変数の確認

---

**注意**: プロダクション環境では必ず認証トークンを設定し、HTTPS を使用してください。
