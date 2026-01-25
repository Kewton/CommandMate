---
name: rebuild
description: サーバー停止→ビルド→再起動を実行するスキル
---

# Rebuild

サーバーを停止し、ビルドして再起動します。

## 実行手順

1. サーバー停止: `./scripts/stop-server.sh`
2. ビルドと再起動: `./scripts/build-and-start.sh -d`

## 完了報告形式

```
✅ サーバー再起動完了！

📋 サーバー情報:
  PID:  [プロセスID]
  URL:  http://localhost:3000
  ログ: logs/server.log

🔧 操作コマンド:
  ログ確認: tail -f logs/server.log
  停止:     ./scripts/stop-server.sh
```
