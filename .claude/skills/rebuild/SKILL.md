---
name: rebuild
description: サーバーをリビルドして再起動する。「リビルド」「再起動」「サービス再起動」「本番環境を再起動」「ビルドして起動」などの指示で使用する。
allowed-tools: Bash(./scripts/*), Bash(git worktree list)
---

# Rebuild

サーバーを停止し、ビルドしてバックグラウンドで再起動します。

## ⚠️ 最初に決めること: ビルドは要るのか（Issue #2132）

**ビルドは「アプリケーションのコードが変わったとき」だけ必要です。**
`npm run build` は `.next/BUILD_ID` を書き換えるため、**開いているブラウザタブが chunk を取得できなくなって壊れます**
（`.commandmate/verify.yaml` が `skipInPrimaryCheckout: true` でビルドを外しているのと同じ理由）。

| 状況 | 使うもの | ビルド |
|------|---------|--------|
| `src/` などコードを変更した | このスキル（`build-and-start.sh --daemon`） | する |
| `.env` / 設定だけ変えた | `./scripts/restart-nobuild.sh` | **しない** |
| クラッシュしたサーバーを復帰させたい | `./scripts/restart-nobuild.sh` | **しない** |
| 停止中のサーバーを起こすだけ | `./scripts/start.sh --daemon` | **しない** |

ビルド不要と判断したら Step 2 の代わりに次を 1 回の Bash 呼び出しで実行し、完了報告形式はそのまま使う:

```bash
cd {TARGET_DIR} && ./scripts/restart-nobuild.sh
cd {TARGET_DIR} && CM_PORT={port} ./scripts/restart-nobuild.sh   # ポート指定あり
```

**手製の `nohup npm start` を使わないこと。** その前に `source scripts/load-env.sh` を叩く形になりますが、
このスクリプトは bash 専用で、zsh から source すると `.env` を 1 変数も読み込みません
（Issue #2132 以降はエラーで失敗しますが、正しい手段は上記の 2 スクリプトです）。

## 使用方法

```bash
/rebuild                        # 現在のリポジトリで実行
/rebuild feature/235-worktree   # 指定ブランチのWorktreeで実行
/rebuild --port 3011            # ポート3011で起動
/rebuild feature/235-worktree --port 3011  # ブランチ指定+ポート指定
```

## パラメータ

- **branch_name**: 対象ブランチ名（省略可）。指定時は `git worktree list` からディレクトリを解決する。
- **--port {number}**: 起動ポート番号（省略可）。指定時は `CM_PORT` 環境変数を設定してサーバーを起動する。未指定時はデフォルト（3000）。

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

**ポート指定なしの場合:**
```bash
cd {TARGET_DIR} && ./scripts/stop.sh && ./scripts/build-and-start.sh --daemon
```

**ポート指定ありの場合:**
```bash
cd {TARGET_DIR} && CM_PORT={port} ./scripts/stop.sh && CM_PORT={port} ./scripts/build-and-start.sh --daemon
```

**注意**: ポート競合が発生した場合は `lsof -i :{port} -t` でプロセスを特定し、killしてから再試行する。

## 完了報告形式

```
✅ サーバー再起動完了！

📋 サーバー情報:
  ディレクトリ: {TARGET_DIR}
  ブランチ:     {branch_name}
  PID:          [プロセスID]
  ポート:       {port} (デフォルト: 3000)
  URL:          http://localhost:{port}
  ログ:         {TARGET_DIR}/logs/server.log

🔧 操作コマンド:
  ログ確認: tail -f {TARGET_DIR}/logs/server.log
  停止:     cd {TARGET_DIR} && CM_PORT={port} ./scripts/stop.sh
```

**注意**:
- `./scripts/stop.sh` / `./scripts/build-and-start.sh` / `./scripts/start.sh` / `./scripts/restart-nobuild.sh` はプロジェクトルートの `.env` ファイルを自動読み込みする（`CM_PORT`, `CM_DB_PATH` 等）。
- `--port` オプションで `CM_PORT` を明示指定した場合、`.env` の値より優先される（環境変数が既にセットされている場合は `.env` で上書きされない仕様）。
- 複数ポートで起動している場合、特定ポートだけ停止するには必ず `CM_PORT={port}` を付けること。
- 起動ログに `[env] ...` の警告が出た場合、`.env` は存在するのに 1 変数も読み込めていない（Issue #2132）。その状態では Web Push・DB パス・worktree ルートがすべて既定値になっているので、報告して原因を潰すこと。
