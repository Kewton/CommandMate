# CommandMate 動作確認ガイド

このガイドでは、CommandMate の動作確認方法を説明します。

## 📋 目次

1. [環境準備](#環境準備)
2. [開発サーバーの起動](#開発サーバーの起動)
3. [基本動作確認](#基本動作確認)
4. [API エンドポイントのテスト](#api-エンドポイントのテスト)
5. [WebSocket のテスト](#websocket-のテスト)
6. [UI の動作確認](#ui-の動作確認)
7. [トラブルシューティング](#トラブルシューティング)

## 環境準備

### 1. 環境変数の設定

開発環境用の `.env` ファイルを作成します：

```bash
# .env ファイルを作成
cat > .env << 'EOF'
# Development環境設定
CM_ROOT_DIR=/Users/yourname/projects
CM_PORT=3000
CM_BIND=127.0.0.1
CM_DB_PATH=./data/cm.db
NODE_ENV=development
EOF
```

**重要**: `CM_ROOT_DIR` を実際の git worktree があるディレクトリに変更してください。

> **Note**: 旧名称の環境変数（`MCBD_*`）も後方互換性のためサポートされていますが、新名称（`CM_*`）の使用を推奨します。

### 2. データベースの初期化

```bash
# データディレクトリを作成
mkdir -p data

# データベースを初期化
npm run db:init
```

### 3. 依存関係の確認

```bash
# 依存関係がインストールされているか確認
npm list --depth=0
```

## 開発サーバーの起動

### 方法1: 通常起動（フォアグラウンド）

```bash
# 開発サーバーを起動
npm run dev
```

起動後、以下のメッセージが表示されます：
```
WebSocket server initialized
> Ready on http://localhost:3000
> WebSocket server ready
```

### 方法2: バックグラウンド起動

```bash
# バックグラウンドで起動
npm run dev > dev.log 2>&1 &

# ログを確認
tail -f dev.log
```

### サーバーの確認

```bash
# ポートが使用されているか確認
lsof -i:3000

# プロセスを確認
ps aux | grep "tsx server.ts"
```

## 基本動作確認

### 1. HTTP エンドポイントの確認

```bash
# ホームページにアクセス
curl http://localhost:3000/

# ステータスコードのみ確認
curl -I http://localhost:3000/
```

成功すると HTTP 200 が返ります。

### 2. ヘルスチェック

```bash
# 基本的なヘルスチェック
curl -s http://localhost:3000/ | grep -q "<!DOCTYPE html" && echo "✓ Server is healthy" || echo "✗ Server error"
```

## API エンドポイントのテスト

### 1. Worktree 一覧の取得

```bash
# Worktree 一覧を取得
curl -s http://localhost:3000/api/worktrees | jq .
```

**期待される出力**:
```json
[
  {
    "id": "worktree-id",
    "path": "/path/to/worktree",
    "branch": "main",
    "sessionId": null,
    "lastActivity": "2025-01-17T12:00:00.000Z"
  }
]
```

### 2. メッセージの取得

```bash
# 特定の worktree のメッセージを取得
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/messages" | jq .
```

### 3. メッセージの送信

```bash
# メッセージを送信
WORKTREE_ID="your-worktree-id"
curl -X POST http://localhost:3000/api/worktrees/${WORKTREE_ID}/send \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, Claude!",
    "summary": "Test message"
  }' | jq .
```

### 4. ログファイルの一覧取得

```bash
# ログファイル一覧を取得
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/logs" | jq .
```

## WebSocket のテスト

### Node.js スクリプトを使用

`test-websocket.js` というファイルを作成：

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('✓ WebSocket connected');

  // Worktree に subscribe
  ws.send(JSON.stringify({
    type: 'subscribe',
    worktreeIds: ['your-worktree-id']
  }));

  console.log('✓ Subscribed to worktree');
});

ws.on('message', (data) => {
  console.log('✓ Received message:', JSON.parse(data.toString()));
});

ws.on('error', (error) => {
  console.error('✗ WebSocket error:', error);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

// 10秒後に接続を閉じる
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 10000);
```

実行：

```bash
node test-websocket.js
```

### wscat を使用（オプション）

```bash
# wscat をインストール
npm install -g wscat

# WebSocket に接続
wscat -c ws://localhost:3000

# 接続後、以下を送信
{"type":"subscribe","worktreeIds":["your-worktree-id"]}
```

## UI の動作確認

### 1. ブラウザでアクセス

ブラウザで以下の URL にアクセス：

```
http://localhost:3000
```

### 2. Worktree 一覧ページの確認

以下を確認します：

- [ ] ページヘッダーが表示される
- [ ] "CommandMate" というタイトルが表示される
- [ ] Worktree の一覧が表示される（データがある場合）
- [ ] 検索ボックスが表示される
- [ ] ソートボタン（Name、Updated、Path）が表示される
- [ ] リフレッシュボタンが表示される

### 3. Worktree 詳細ページの確認

Worktree カードをクリックして詳細ページに移動：

```
http://localhost:3000/worktrees/[worktree-id]
```

以下を確認します：

- [ ] 戻るボタンが表示される
- [ ] タブ（Messages、Log Files）が表示される
- [ ] メッセージ入力フォームが表示される
- [ ] サイドバーに情報が表示される
- [ ] Quick Actions が表示される

### 4. メッセージ送信のテスト

1. メッセージ入力欄に「Hello, Claude!」と入力
2. [Send Message] ボタンをクリック
3. メッセージが送信され、チャット画面に表示されることを確認

### 5. ログビューアのテスト

1. [Log Files] タブをクリック
2. ログファイル一覧が表示されることを確認
3. ログファイルをクリックして内容が表示されることを確認

## 自動テストの実行

### ユニットテスト

```bash
# ユニットテストを実行
npm run test:unit

# カバレッジ付きで実行
npm run test:coverage
```

**期待される結果**:
- 75件のテストがパス
- カバレッジ: 80%以上

### 統合テスト

```bash
# 統合テストを実行
npm run test:integration
```

**期待される結果**:
- 40件以上のテストがパス
- API エンドポイントが正しく動作

### E2E テスト

```bash
# E2E テストを実行
npm run test:e2e

# 特定のブラウザで実行
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=webkit
```

**期待される結果**:
- 24件のテストがパス
- UI が正しく表示される

## トラブルシューティング

### サーバーが起動しない

```bash
# ポートが使用中の場合
lsof -ti:3000 | xargs kill -9

# 依存関係を再インストール
rm -rf node_modules package-lock.json
npm install

# ビルドをクリーンアップ
rm -rf .next
npm run build
```

### データベースエラー

```bash
# データベースをリセット
rm -f data/db.sqlite
npm run db:init
```

### Worktree が検出されない

`CM_ROOT_DIR` が正しく設定されているか確認：

```bash
# 環境変数を確認
cat .env | grep CM_ROOT_DIR

# ディレクトリが存在するか確認
ls -la $CM_ROOT_DIR

# Git worktree があるか確認
cd $CM_ROOT_DIR && git worktree list
```

### WebSocket 接続エラー

```bash
# WebSocket サーバーが起動しているか確認
curl -I \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  http://localhost:3000/

# ブラウザのコンソールでエラーを確認
# 開発者ツール > Console タブ
```

### 外部アクセスのセキュリティ

外部公開する場合はリバースプロキシでの認証を設定してください。
詳細は [セキュリティガイド](../../docs/security-guide.md) を参照してください。

## パフォーマンスチェック

### ページ読み込み時間

ブラウザの開発者ツールで確認：

1. F12 キーを押して開発者ツールを開く
2. Network タブを開く
3. ページをリロード
4. DOMContentLoaded、Load の時間を確認

**目標**:
- DOMContentLoaded: < 1秒
- Load: < 2秒

### メモリ使用量

```bash
# Node.js プロセスのメモリ使用量を確認
ps aux | grep "tsx server.ts" | awk '{print $6}'
```

**目標**: < 500MB

### データベースサイズ

```bash
# データベースサイズを確認
du -h data/db.sqlite
```

## 完了チェックリスト

すべての動作確認が完了したら、以下を確認してください：

- [ ] 開発サーバーが起動する
- [ ] HTTP エンドポイントにアクセスできる
- [ ] Worktree 一覧が取得できる
- [ ] メッセージの送受信ができる
- [ ] WebSocket 接続ができる
- [ ] ユニットテストがパスする
- [ ] 統合テストがパスする
- [ ] E2E テストがパスする
- [ ] UI が正しく表示される
- [ ] ブラウザのコンソールにエラーがない

## 次のステップ

動作確認が完了したら：

1. **本番環境へのデプロイ**
   - [デプロイメントガイド](./DEPLOYMENT.md) を参照
   - [プロダクションチェックリスト](./PRODUCTION_CHECKLIST.md) を確認

2. **カスタマイズ**
   - UI コンポーネントのカスタマイズ
   - Claude CLI の設定調整
   - tmux の設定カスタマイズ

3. **モニタリング**
   - ログの監視
   - パフォーマンスの追跡
   - エラーの監視

---

問題が発生した場合は、[GitHub Issues](https://github.com/kewton/CommandMate/issues) で報告してください。
