# CommandMate デプロイメントガイド

本ドキュメントは、CommandMate をプロダクション環境にデプロイする手順を説明します。

## 目次

1. [前提条件](#前提条件)
2. [セットアップ手順](#セットアップ手順)
3. [環境変数の設定](#環境変数の設定)
4. [データベースの初期化](#データベースの初期化)
5. [ビルドとデプロイ](#ビルドとデプロイ)
6. [プロセス管理](#プロセス管理)
7. [セキュリティ](#セキュリティ)
8. [トラブルシューティング](#トラブルシューティング)

## 前提条件

- Node.js 20.x 以上
- npm または yarn
- Git
- tmux（ワークツリーのtmuxセッション管理用）
- Claude CLI（オプション）

## セットアップ手順

### 1. リポジトリのクローン

```bash
git clone https://github.com/kewton/CommandMate.git
cd CommandMate
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. 環境変数の設定

プロダクション環境用の `.env` ファイルを作成します：

```bash
cp .env.production.example .env
```

`.env` ファイルを編集して、以下の値を設定します：

```env
MCBD_ROOT_DIR=/path/to/your/worktrees
MCBD_PORT=3000
MCBD_BIND=0.0.0.0
MCBD_AUTH_TOKEN=$(openssl rand -hex 32)
DATABASE_PATH=/path/to/production/data/db.sqlite
NODE_ENV=production
```

**重要**: `MCBD_AUTH_TOKEN` は必ず安全なランダム値を設定してください。

### 4. データベースの初期化

```bash
npm run db:init
```

### 5. ビルド

```bash
npm run build
```

## 環境変数の設定

### 必須変数

| 変数名 | 説明 | 例 |
|--------|------|-----|
| `MCBD_ROOT_DIR` | ワークツリーのルートディレクトリ | `/home/user/projects` |
| `MCBD_BIND` | バインドアドレス（本番は `0.0.0.0`） | `0.0.0.0` |
| `MCBD_AUTH_TOKEN` | API認証トークン（本番必須） | `abc123...` |

### オプション変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `MCBD_PORT` | サーバーポート | `3000` |
| `DATABASE_PATH` | SQLiteデータベースのパス | `./data/db.sqlite` |

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
