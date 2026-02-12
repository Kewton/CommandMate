[English](./en/migration-to-commandmate.md)

# CommandMate 移行ガイド

このドキュメントでは、MyCodeBranchDesk から CommandMate への移行手順を説明します。

## 概要

MyCodeBranchDesk は **CommandMate** にリネームされました。このリネームはブランディングの更新であり、機能の変更は含まれません。

### 主な変更点

- プロジェクト名: `MyCodeBranchDesk` → `CommandMate`
- 環境変数プレフィックス: `MCBD_*` → `CM_*`
- package.json の name: `mycodebranch-desk` → `commandmate`

### 後方互換性

フォールバック機能により、旧名称（`MCBD_*`）の環境変数は引き続き動作します。ただし、起動時に deprecation 警告がログに出力されます。

---

## 環境変数の変更

環境変数名が `MCBD_*` から `CM_*` に変更されました。

> **Note**: 環境変数マッピングの正式な定義は `src/lib/env.ts` の `ENV_MAPPING` を参照してください。

### サーバー基本設定（7種類）

| 旧名称 | 新名称 | 用途 | デフォルト値 |
|--------|--------|------|-------------|
| `MCBD_ROOT_DIR` | `CM_ROOT_DIR` | ワークツリールートディレクトリ | カレントディレクトリ |
| `MCBD_PORT` | `CM_PORT` | サーバーポート | `3000` |
| `MCBD_BIND` | `CM_BIND` | バインドアドレス | `127.0.0.1` |
| `MCBD_LOG_LEVEL` | `CM_LOG_LEVEL` | ログレベル | `info`（本番）/ `debug`（開発） |
| `MCBD_LOG_FORMAT` | `CM_LOG_FORMAT` | ログフォーマット | `text` |
| `MCBD_LOG_DIR` | `CM_LOG_DIR` | ログディレクトリ | `./data/logs` |
| `MCBD_DB_PATH` | `CM_DB_PATH` | DBファイルパス | `./data/cm.db` |

> **Note**: `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN` / `NEXT_PUBLIC_CM_AUTH_TOKEN` は Issue #179 で廃止されました。外部公開時はリバースプロキシでの認証を推奨します。詳細は [セキュリティガイド](./security-guide.md) を参照してください。

---

## 移行手順

### 1. 環境変数の移行

`.env` ファイルを更新して、新しい環境変数名を使用します。

```bash
# オプション1: sedで一括置換
sed -i '' 's/MCBD_/CM_/g' .env

# オプション2: 手動で編集
# .env ファイルを開き、MCBD_ プレフィックスを CM_ に変更
```

**例:**
```bash
# 変更前
MCBD_ROOT_DIR=/path/to/repos
MCBD_PORT=3000
MCBD_BIND=127.0.0.1

# 変更後
CM_ROOT_DIR=/path/to/repos
CM_PORT=3000
CM_BIND=127.0.0.1
```

> **Note**: フォールバック機能により、旧名称も引き続き動作しますが、deprecation 警告が出力されます。

### 2. Git remote の更新（Issue #80 完了後）

> **重要**: この手順は Issue #80（GitHubリポジトリ名変更）完了後に実施してください。

```bash
# HTTPS の場合
git remote set-url origin https://github.com/Kewton/CommandMate.git

# SSH の場合
git remote set-url origin git@github.com:Kewton/CommandMate.git

# 確認
git remote -v
```

### 3. ローカルディレクトリ名の更新（任意）

ディレクトリ名を変更する場合：

```bash
# 親ディレクトリに移動
cd ..

# ディレクトリをリネーム
mv MyCodeBranchDesk commandmate

# 新しいディレクトリに移動
cd commandmate
```

> **Note**: この手順は任意です。ディレクトリ名を変更しなくても、アプリケーションは正常に動作します。

### 4. Docker 環境の更新（該当する場合）

Docker を使用している場合、`docker-compose.yml` の環境変数を更新します。

```yaml
# 変更前
environment:
  - MCBD_ROOT_DIR=/app/repos
  - MCBD_PORT=3000

# 変更後
environment:
  - CM_ROOT_DIR=/app/repos
  - CM_PORT=3000
```

---

## systemd サービスの移行

本番環境で systemd を使用している場合、以下の手順でサービス名を移行してください。

> **Note**: サービス名は環境によって異なる場合があります。以下の例では `mycodebranch-desk` を使用していますが、実際のサービス名に合わせて読み替えてください。

### 1. 現在のサービスを停止

```bash
sudo systemctl stop mycodebranch-desk
sudo systemctl disable mycodebranch-desk
```

### 2. サービスファイルをリネーム

```bash
sudo mv /etc/systemd/system/mycodebranch-desk.service \
        /etc/systemd/system/commandmate.service
```

### 3. サービスファイル内の設定を更新

`/etc/systemd/system/commandmate.service` を編集し、以下を更新:

- `Description=`: `MyCodeBranchDesk` → `CommandMate`
- `WorkingDirectory=`: ディレクトリ名を変更した場合は更新
- `Environment=`: `MCBD_*` → `CM_*`（任意、フォールバックあり）

**セキュリティ推奨事項:**

外部公開時はリバースプロキシでの認証を設定してください。詳細は [セキュリティガイド](./security-guide.md) を参照してください。

### 4. systemd をリロードして新サービスを開始

```bash
sudo systemctl daemon-reload
sudo systemctl enable commandmate
sudo systemctl start commandmate
sudo systemctl status commandmate
```

### 5. 旧サービスファイルの削除（任意）

```bash
# 旧ファイルが残っている場合
sudo rm /etc/systemd/system/mycodebranch-desk.service
sudo systemctl daemon-reload
```

---

## Claude Code 設定の更新

> **Note**: ディレクトリ名を変更しなかった場合、Claude Code 設定の更新は不要です。

`.claude/settings.local.json` にプロジェクトパスが含まれている場合、更新が必要です：

```bash
# ディレクトリ名を変更した場合のみ実行
sed -i '' 's/MyCodeBranchDesk/commandmate/g' .claude/settings.local.json
```

**更新が必要なケース:**
- プロジェクトディレクトリ名を `MyCodeBranchDesk` から `commandmate` 等に変更した場合

**更新が不要なケース:**
- ディレクトリ名をそのまま維持している場合
- `.claude/settings.local.json` が存在しない場合

> **Note**: 絶対パスは環境依存のため、各開発者が個別に確認してください。

---

## 後方互換サポート

### フォールバック機能

旧名称（`MCBD_*`）の環境変数は、フォールバック機能により引き続き動作します。

- 新名称（`CM_*`）が設定されている場合: 新名称の値を使用
- 新名称が未設定で旧名称が設定されている場合: 旧名称の値を使用（警告出力）
- 両方未設定の場合: デフォルト値を使用

### Deprecation 警告

旧名称を使用すると、以下のような警告がログに出力されます：

```
[DEPRECATED] MCBD_ROOT_DIR is deprecated, use CM_ROOT_DIR instead
```

> **Note**: 同一キーに対する警告は、アプリケーション起動時に1回のみ出力されます（ログ汚染防止）。

### サポート終了予定

| 項目 | 内容 |
|------|------|
| 現行サポート | `MCBD_*` 環境変数はフォールバック機能により動作 |
| **サポート終了予定** | **次のメジャーバージョン（v2.0.0）** で旧名称のサポートを終了 |
| フォールバック期間 | 正式リリース後、1メジャーバージョンの間サポート継続 |

> **重要**: v2.0.0 以降、旧名称（`MCBD_*`）を使用し続けた場合、アプリケーションは環境変数が未設定として扱い、デフォルト値を使用します。必ず v2.0.0 アップグレード前に `CM_*` への移行を完了してください。

### DATABASE_PATH の廃止

`DATABASE_PATH` 環境変数は廃止され、`CM_DB_PATH` に統一されました。

**移行手順**:

1. `.env` ファイルで `DATABASE_PATH` を `CM_DB_PATH` に変更
2. 旧DBファイル（`db.sqlite`）は自動的に新パス（`cm.db`）にマイグレーションされます
3. `commandmate init` を再実行すると、絶対パスで `CM_DB_PATH` が設定されます

**例:**
```bash
# 変更前
DATABASE_PATH=./data/db.sqlite

# 変更後（グローバルインストール）
CM_DB_PATH=~/.commandmate/data/cm.db

# 変更後（ローカルインストール）
CM_DB_PATH=/path/to/project/data/cm.db
```

> **Note**: `DATABASE_PATH` を使用すると deprecation 警告が出力されます。v2.0.0 で完全に削除されます。

---

## トラブルシューティング

### よくある問題

#### 1. アプリケーションが起動しない

**原因**: 必須の環境変数が設定されていない可能性があります。

**対処法**:
```bash
# 環境変数を確認
env | grep -E '^(CM_|MCBD_)'

# .env ファイルの内容を確認
cat .env
```

#### 2. Deprecation 警告が大量に出力される

**原因**: 複数の旧名称環境変数が設定されています。

**対処法**: `.env` ファイルを `CM_*` に更新してください。

```bash
sed -i '' 's/MCBD_/CM_/g' .env
```

#### 3. 外部アクセスのセキュリティ

`CM_BIND=0.0.0.0` で外部公開する場合は、リバースプロキシでの認証を設定してください。

**対処法**:
- Nginx + Basic認証、Cloudflare Access、Tailscale などを使用
- 詳細は [セキュリティガイド](./security-guide.md) を参照

### ログの確認方法

```bash
# アプリケーションログを確認
tail -f data/logs/app.log

# systemd を使用している場合
journalctl -u commandmate -f
```

---

## 関連リンク

- [CHANGELOG](../CHANGELOG.md) - 変更履歴
- [README](../README.md) - プロジェクト概要
- [アーキテクチャ](./architecture.md) - システム設計
- [デプロイメントガイド](./DEPLOYMENT.md) - 本番環境へのデプロイ

---

*最終更新: 2026-01-29*
