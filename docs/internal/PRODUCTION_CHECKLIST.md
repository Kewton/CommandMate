# CommandMate プロダクション環境チェックリスト

本番環境にデプロイする前に、このチェックリストを確認してください。

## 📦 インストール方法の選択

### npm グローバルインストール（推奨）

```bash
npm install -g commandmate
commandmate init
commandmate start --daemon
```

詳しくは [CLI セットアップガイド](../user-guide/cli-setup-guide.md) を参照してください。

### 開発環境（git clone）

コントリビューターや自前でビルドする場合は、[デプロイガイド](../DEPLOYMENT.md#開発環境セットアップ) を参照してください。

---

## 📋 デプロイ前チェックリスト

### 1. 環境設定

- [ ] `.env` ファイルが作成され、適切な値が設定されている
- [ ] `CM_ROOT_DIR` がワークツリーのルートディレクトリを正しく指している
- [ ] `CM_BIND=0.0.0.0` が設定されている（外部アクセスを許可する場合）
- [ ] 外部公開時はリバースプロキシでの認証が設定されている（推奨、詳細: `docs/security-guide.md`）
- [ ] `CM_DB_PATH` が適切な場所を指している
- [ ] `NODE_ENV=production` が設定されている
- [ ] `.env` ファイルが `.gitignore` に含まれている（セキュリティ）

### 2. システム要件

- [ ] 依存関係チェックが成功する
  ```bash
  # npm グローバルインストールの場合
  commandmate init  # 依存関係を自動チェック

  # 開発環境（git clone）の場合のみ
  ./scripts/preflight-check.sh
  ```
- [ ] Node.js 20.x 以上がインストールされている
  ```bash
  node -v
  ```
- [ ] npm がインストールされている
- [ ] Git がインストールされている
- [ ] tmux がインストールされている
- [ ] openssl がインストールされている
- [ ] Claude CLI (Claude Code) がインストールされている（オプション）
  ```bash
  claude --version
  ```

### 3. 依存関係とビルド

- [ ] 依存関係がインストールされている
  ```bash
  npm install
  ```
- [ ] プロダクションビルドが成功する
  ```bash
  npm run build
  ```
- [ ] TypeScript のコンパイルエラーがない
- [ ] ESLint の警告・エラーがない
  ```bash
  npm run lint
  ```

### 4. データベース

- [ ] データディレクトリが作成されている
  ```bash
  mkdir -p data
  ```
- [ ] データベースが初期化されている
  ```bash
  npm run db:init
  ```
- [ ] データベースファイルのパーミッションが適切
  ```bash
  chmod 755 data
  chmod 644 data/db.sqlite
  ```
- [ ] データベースのバックアップ戦略が決まっている

### 5. テスト

- [ ] ユニットテストがすべて成功する
  ```bash
  npm run test:unit
  ```
- [ ] 統合テストが成功する
  ```bash
  npm run test:integration
  ```
- [ ] E2Eテストが成功する（オプション）
  ```bash
  npm run test:e2e
  ```

### 6. セキュリティ

- [ ] 外部公開時はリバースプロキシ認証が設定されている（詳細: `docs/security-guide.md`）
- [ ] ファイアウォールが適切に設定されている
  ```bash
  # UFW (Ubuntu/Debian)
  sudo ufw allow 3000/tcp

  # firewalld (RHEL/CentOS)
  sudo firewall-cmd --permanent --add-port=3000/tcp
  sudo firewall-cmd --reload
  ```
- [ ] HTTPS を使用する場合、SSL証明書が設定されている
- [ ] Nginx などのリバースプロキシが設定されている（推奨）

### 7. プロセス管理

#### PM2を使用する場合

- [ ] PM2 がインストールされている
  ```bash
  npm install -g pm2
  ```
- [ ] アプリケーションが PM2 で起動する
  ```bash
  ./scripts/start.sh
  ```
- [ ] PM2 の自動起動が設定されている
  ```bash
  pm2 startup
  pm2 save
  ```

#### Systemdを使用する場合

- [ ] Systemd サービスファイルが作成されている
- [ ] サービスが有効化されている
  ```bash
  sudo systemctl enable commandmate
  sudo systemctl start commandmate
  ```

### 8. モニタリングとログ

- [ ] ログの出力先が確認できる
  ```bash
  ./scripts/logs.sh
  ```
- [ ] ヘルスチェックが動作する
  ```bash
  ./scripts/health-check.sh
  ```
- [ ] ステータス確認が動作する
  ```bash
  ./scripts/status.sh
  ```
- [ ] ログのローテーション設定がされている（オプション）

### 9. バックアップ

- [ ] データベースのバックアップスクリプトが設定されている
  ```bash
  # 例: crontab
  0 2 * * * cp /path/to/data/db.sqlite /path/to/backup/db.sqlite.$(date +\%Y\%m\%d)
  ```
- [ ] `.env` ファイルのバックアップがある
- [ ] バックアップの復元手順が文書化されている

### 10. ネットワークとアクセス

- [ ] アプリケーションがローカルホストで起動する
  ```bash
  curl http://localhost:3000
  ```
- [ ] 外部からアクセスできる（必要な場合）
  ```bash
  curl http://<your-ip>:3000
  ```
- [ ] WebSocket 接続が動作する
- [ ] モバイルデバイスからアクセスできる（必要な場合）

### 11. ドキュメント

- [ ] README.md が最新の状態
- [ ] デプロイメントガイド（`docs/DEPLOYMENT.md`）を確認した
- [ ] アーキテクチャドキュメント（`docs/architecture.md`）を確認した
- [ ] 運用手順書が用意されている

### 12. パフォーマンス

- [ ] ビルドサイズが適切（First Load JS < 300kB）
- [ ] ページの読み込みが高速
- [ ] WebSocket の接続が安定している
- [ ] メモリ使用量が適切

## 🚀 デプロイ手順

チェックリストをすべて確認したら、以下の手順でデプロイします：

### npm グローバルインストール（推奨）

#### 初回デプロイ

```bash
# インストール
npm install -g commandmate

# 初期設定（対話形式）
commandmate init

# サーバー起動
commandmate start --daemon

# ステータス確認
commandmate status
```

#### 更新デプロイ

```bash
# サーバー停止
commandmate stop

# アップグレード
npm install -g commandmate@latest

# サーバー起動
commandmate start --daemon
```

---

### 開発環境（git clone）の場合

> **Note**: 以下は開発者向けです。`./scripts/*` スクリプトは git clone 環境でのみ使用可能です。

#### 初回デプロイ

1. **セットアップスクリプトを実行**
   ```bash
   ./scripts/setup.sh
   ```

2. **環境変数を設定**
   ```bash
   vi .env
   # 必要な値を設定
   ```

3. **アプリケーションを起動**
   ```bash
   ./scripts/start.sh
   ```

4. **ステータスを確認**
   ```bash
   ./scripts/status.sh
   ```

5. **ヘルスチェック**
   ```bash
   ./scripts/health-check.sh
   ```

#### 更新デプロイ

1. **最新のコードを取得**
   ```bash
   git pull origin main
   ```

2. **依存関係を更新**
   ```bash
   npm install
   ```

3. **ビルド**
   ```bash
   npm run build
   ```

4. **再起動**
   ```bash
   ./scripts/restart.sh
   ```

5. **ステータスを確認**
   ```bash
   ./scripts/status.sh
   ```

## 🔍 トラブルシューティング

### アプリケーションが起動しない

- [ ] ログを確認
  ```bash
  ./scripts/logs.sh
  ```
- [ ] ポートが使用中でないか確認
  ```bash
  lsof -ti:3000
  ```
- [ ] 環境変数が正しく設定されているか確認
  ```bash
  cat .env
  ```

### データベースエラー

- [ ] データベースファイルが存在するか確認
- [ ] パーミッションが正しいか確認
- [ ] データベースを再初期化（注意：データが削除されます）
  ```bash
  npm run db:reset
  ```

### 外部アクセスの問題

- [ ] リバースプロキシ認証が設定されているか確認（外部公開時）
- [ ] ファイアウォール設定を確認

## 📊 本番環境の監視

### 定期的に確認すべき項目

- [ ] **日次**
  - アプリケーションのステータス
  - ディスク使用量
  - エラーログ

- [ ] **週次**
  - データベースのバックアップ
  - セキュリティアップデート
  - パフォーマンスメトリクス

- [ ] **月次**
  - ログのクリーンアップ
  - 依存関係の更新
  - バックアップの復元テスト

## ✅ デプロイ完了後の確認

すべてのチェックが完了したら、以下を確認してください：

- [ ] アプリケーションが正常に起動している
- [ ] ヘルスチェックが成功する
- [ ] ブラウザからアクセスできる
- [ ] WebSocket 接続が動作する
- [ ] 認証が機能している
- [ ] Worktree の一覧が表示される
- [ ] メッセージの送受信が動作する
- [ ] ログファイルが正しく保存される

## 📞 サポート

問題が発生した場合：

1. [トラブルシューティングガイド](./DEPLOYMENT.md#トラブルシューティング)を確認
2. [GitHub Issues](https://github.com/kewton/CommandMate/issues) で報告
3. ログファイルを添付して質問

---

**重要**: プロダクション環境では、セキュリティを最優先してください。認証トークンを必ず設定し、HTTPS を使用することを強く推奨します。
