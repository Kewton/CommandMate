# Issue #92 レビュー報告書

## 基本情報

| 項目 | 値 |
|------|-----|
| Issue番号 | #92 |
| タイトル | セットアップ手順の簡素化と事前チェック機能の追加 |
| レビューステージ | Stage 1 |
| フォーカスエリア | 通常（整合性・正確性） |
| レビュー日 | 2026-01-30 |

---

## サマリー

Issue #92 は全体的に明確で実装可能な内容だが、既存コード・ドキュメントとの整合性に **3点の要修正事項** がある。特に以下の点について明確化が必要:

1. `.env.production.example` の扱い（旧名称 MCBD_* のみ使用）
2. Claude CLI の必須性判断
3. setup.sh の現在の動作との差異

また、**4点の改善推奨事項** と **4点の任意改善提案** がある。

---

## 要修正事項 (Must Fix)

### MF-1: .env.production.example と環境変数命名の不整合

| 項目 | 内容 |
|------|------|
| カテゴリ | 整合性 |
| 該当箇所 | Issueの「2. scripts/setup-env.sh」セクション |

**問題:**
`.env.production.example` は旧名称（MCBD_*）のみを使用しているが、Issue では CM_* を前提とした `setup-env.sh` を提案している。

**現状のファイル内容（抜粋）:**
```env
# .env.production.example
MCBD_ROOT_DIR=/path/to/your/worktrees
MCBD_PORT=3000
MCBD_BIND=0.0.0.0
MCBD_AUTH_TOKEN=your-secure-token-here-replace-this
```

**推奨:**
- `.env.production.example` の更新も実装内容に含める
- または、`setup-env.sh` で CM_* を使用し、`.env.production.example` は別途更新するタスクとして明記

---

### MF-2: setup.sh の .env コピー元ファイルの不整合

| 項目 | 内容 |
|------|------|
| カテゴリ | 整合性 |
| 該当箇所 | Issueの「現状の課題」セクション |

**問題:**
Issue では現状フローを以下のように記述:
```bash
cp .env.example .env
```

しかし、現在の `setup.sh`（line 27）は `.env.production.example` を使用:
```bash
# setup.sh line 27
cp .env.production.example .env
```

**推奨:**
- Issue 内の現状記述を正確に修正する
- または、どちらのファイルを使うか明確化し、統一方針を決定

---

### MF-3: Claude CLI の必須/任意の判断基準が不明確

| 項目 | 内容 |
|------|------|
| カテゴリ | 完全性 |
| 該当箇所 | Issueの「1. scripts/preflight-check.sh」セクションの表 |

**問題:**
Claude CLI は「任意（警告のみ）」と記載されているが、CommandMate のコア機能（Claude Code セッション管理）は Claude CLI が無いと動作しない。

| 項目 | チェック内容 | 必須/任意 |
|------|-------------|----------|
| Claude CLI | インストール済み | 任意（警告のみ） |

**推奨:**
- Claude CLI 無しで動作可能な範囲を明確化する
- または「必須だが後からインストール可能」といった表現に変更

---

## 改善推奨事項 (Should Fix)

### SF-1: Node.js バージョン表現の統一

| 項目 | 内容 |
|------|------|
| カテゴリ | 整合性 |
| 該当箇所 | Issueの表「Node.js: バージョン20以上」 |

**問題:**
表現に差異がある:
- Issue: 「バージョン20以上」
- README.md: 「Node.js v20+」
- DEPLOYMENT.md: 「Node.js 20.x 以上」

**推奨:**
統一のため「Node.js v20+」や「Node.js 20.x 以上」など既存ドキュメントと表現を揃える。

---

### SF-2: ログ関連環境変数の言及不足

| 項目 | 内容 |
|------|------|
| カテゴリ | 完全性 |
| 該当箇所 | Issueの「2. scripts/setup-env.sh」セクション |

**問題:**
`env.ts` の `ENV_MAPPING` では以下が定義されているが、`setup-env.sh` の対話フローでは言及されていない:
- `CM_LOG_LEVEL`
- `CM_LOG_FORMAT`
- `CM_LOG_DIR`

**推奨:**
ログ関連の設定も対話式で設定できるか、スキップ可能な「高度な設定」として言及を検討。

---

### SF-3: フロー順序の不整合

| 項目 | 内容 |
|------|------|
| カテゴリ | 明確性 |
| 該当箇所 | Issue全体のフロー説明 |

**問題:**
「目標のフロー」と「3. setup.sh の拡張」で順序が異なる:

**目標のフロー:**
```bash
npm install                        # <- npm install が最初
./scripts/preflight-check.sh
./scripts/setup-env.sh
./scripts/build-and-start.sh --daemon
```

**setup.sh の拡張:**
```bash
./scripts/preflight-check.sh || exit 1  # <- preflight-check が最初
npm install
...
```

**推奨:**
依存チェックを先に行う方が論理的なので、「目標のフロー」側を修正推奨。

---

### SF-4: build-and-start.sh の --daemon オプションは既存機能

| 項目 | 内容 |
|------|------|
| カテゴリ | 整合性 |
| 該当箇所 | Issueの「目標のフロー」セクション |

**問題:**
`build-and-start.sh` は既に `--daemon` オプションをサポートしているが、Issue では新規機能のように記載されている。

**現在のスクリプト（build-and-start.sh line 25）:**
```bash
if [ "$1" = "--daemon" ] || [ "$1" = "-d" ]; then
```

**推奨:**
`--daemon` オプションは既存機能であることを明記し、新規実装ではないことを明確化。

---

## 任意改善提案 (Nice to Have)

### NTH-1: バージョン取得コマンドの詳細仕様追加

preflight-check.sh の各ツールのバージョン取得方法（例: `node -v`, `tmux -V`）の詳細仕様を追加。

### NTH-2: トークン生成方式の明記

setup-env.sh でのトークン自動生成方式（`openssl rand -hex 32`）を実装詳細として明記。

### NTH-3: エラーハンドリング関連の受け入れ条件追加

- 既存 .env がある場合のバックアップ
- preflight-check 失敗時の分かりやすいエラーメッセージ

### NTH-4: スクリプト言語とPOSIX互換性の明記

`#!/bin/bash` を使用し、bash 4.0+ 互換を想定などの仕様追加を検討。

---

## 確認した既存ファイル

| ファイル | 確認内容 |
|----------|----------|
| `scripts/setup.sh` | 現在のセットアップフロー、Node.jsチェック、.env.production.example の使用 |
| `scripts/build-and-start.sh` | --daemon オプションが既に実装済み |
| `scripts/start.sh` | PM2 との連携 |
| `README.md` | Quick Start セクションのセットアップ手順 |
| `docs/DEPLOYMENT.md` | 本番環境デプロイ手順 |
| `.env.example` | CM_* 環境変数（新名称） |
| `.env.production.example` | MCBD_* 環境変数（旧名称のみ） |
| `src/lib/env.ts` | ENV_MAPPING 定義、フォールバック機能 |
| `package.json` | npm スクリプト定義 |

---

## 結論

Issue #92 は実装の方向性は適切だが、上記の要修正事項（特に MF-1, MF-2, MF-3）を解決してから実装に着手することを推奨する。
