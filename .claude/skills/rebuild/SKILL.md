---
name: rebuild
description: サーバーをリビルドして再起動する。「リビルド」「再起動」「サービス再起動」「本番環境を再起動」「ビルドして起動」などの指示で使用する。
allowed-tools: Bash(./scripts/*), Bash(git worktree list)
---

# Rebuild

サーバーを停止し、ビルドしてバックグラウンドで再起動します。

## 使用方法

```bash
/rebuild                        # 現在のリポジトリで実行
/rebuild feature/235-worktree   # 指定ブランチのWorktreeで実行
```

## パラメータ

- **branch_name**: 対象ブランチ名（省略可）。指定時は `git worktree list` からディレクトリを解決する。

## 実行手順

### Step 1: 実行ディレクトリの決定

1. **ブランチ名が指定された場合**:
   - `git worktree list` を実行し、指定ブランチに対応するディレクトリを取得する
   - 見つからない場合はエラー終了（「ブランチ '{branch_name}' に対応するWorktreeが見つかりません」）
   - 見つかったディレクトリを `TARGET_DIR` とする

2. **ブランチ名が未指定の場合**:
   - 現在の作業ディレクトリ（プロジェクトルート）を `TARGET_DIR` とする

### Step 2: サーバー停止・ビルド・再起動

停止とビルド・再起動を **1回のBash呼び出し** で実行する（ユーザーへの許可確認を1回に抑えるため）。

```bash
cd {TARGET_DIR} && ./scripts/stop.sh && ./scripts/build-and-start.sh --daemon
```

**注意**: ポート競合が発生した場合は `lsof -i :3000 -t` でプロセスを特定し、killしてから再試行する。

## 完了報告形式

```
✅ サーバー再起動完了！

📋 サーバー情報:
  ディレクトリ: {TARGET_DIR}
  ブランチ:     {branch_name}
  PID:          [プロセスID]
  URL:          http://localhost:3000
  ログ:         {TARGET_DIR}/logs/server.log

🔧 操作コマンド:
  ログ確認: tail -f {TARGET_DIR}/logs/server.log
  停止:     cd {TARGET_DIR} && ./scripts/stop.sh
```
