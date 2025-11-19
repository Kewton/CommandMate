# myCodeBranchDesk

git worktree ごとに SWE CLI tool (Claude Code / Codex / Gemini) / tmux セッションを張り、スマホブラウザからチャット操作できる開発コンパニオンツール。

myCodeBranchDesk は、ローカルの git worktree 単位で 1:1 の tmux + SWE CLI セッションを管理し、
スマホや PC のブラウザから「ブランチごとのチャット UI」として操作できるツールです。
	•	feature/foo ブランチ用の Claude Code セッション
	•	hotfix/bar ブランチ用の Codex セッション
	•	main ブランチ用の Gemini セッション

…といった形で、worktree ごとに独立した「開発用チャットルーム」を持ち、各ワークツリーで異なるCLI toolを使い分けることができます。

**対応CLI tool:**
- Claude Code (デフォルト)
- Codex CLI
- Gemini CLI

Stop フック（CLAUDE_HOOKS_STOP）を活用した イベント駆動アーキテクチャにより、
不安定なポーリングを避けつつ、リアルタイムなチャット更新を実現します。

⸻

# Table of Contents
- Features￼
- Architecture Overview￼
- Requirements
- Installation￼
- Configuration￼
- Usage￼
    1. 起動￼
    1. 画面a-worktree-一覧￼
    1. 画面b-チャット￼
    1. 画面c-ログビューア￼
- How it works (簡易フロー)￼
- Project Structure￼
- Development￼
- Lint & Format￼
- Tests￼
- Roadmap￼
- Contributing￼
- License￼
- For SWE Agents (Claude Code / OpenHands etc.)￼

⸻

# Features
🧠 git worktree aware
- ルートディレクトリ配下の git worktree を自動検出
- 1 worktree = 1 tmux session = 1 SWE CLI session のシンプルな対応
- 🤖 複数の SWE CLI tool サポート (Issue #4で実装)
- Claude Code (デフォルト)
- Codex CLI
- Gemini CLI
- ワークツリーごとに異なる CLI tool を選択可能
- Strategy パターンによる拡張可能な設計
- 📱 スマホ最適なチャット UI
- 画面A: Worktree 一覧（トーク一覧風）
- 画面B: チャット画面（ブランチ専用の会話）
- 画面C: Markdown ログビューア
- ⚡ Stop フックによる非同期応答
- CLI tool側の完了フックで API を叩き、tmux から出力を取得
- WebSocket でチャット画面にプッシュ配信し、リアルタイム更新
- 📝 Markdown ログ保存
- 各 worktree 配下の .claude_logs/ に詳細な Markdown ログを保存
- チャット画面には要約／短縮表示、ログ画面で詳細確認
- 🧩 Claude Code / SWE Agent フレンドリー
- 設計書や構成を docs/ 配下に分離
- SWE エージェント（Claude Code / OpenHands など）にタスクを振りやすい構造
→ 詳細は docs/swe-agents.md￼ を参照

⸻

# Architecture Overview

大まかな構成は次のとおりです。
- フロントエンド: Next.js (App Router) / TypeScript
- バックエンド: Next.js API Routes (Node.js)
- 永続化:
- SQLite (db.sqlite) — Worktree / ChatMessage 管理
- ローカル FS — .claude_logs/*.md（詳細ログ）
- セッション管理:
- tmux — cw_{worktreeId} というセッション名で管理
- Claude CLI — CLAUDE_HOOKS_STOP に Stop フックを設定して起動
- 通信:
- HTTP API — send, hook, logs, worktrees 取得
- WebSocket — チャットメッセージのリアルタイム配信

より詳しいアーキテクチャ図やシーケンスは
docs/architecture.md￼（予定）にまとめます。

⸻

# Requirements
- OS: macOS / Linux
（tmux / Claude CLI が動作するローカル開発環境を想定）
- Node.js: v20 以降を推奨
- git + git worktree
- tmux
- Claude CLI (Claude Code)
- CLAUDE_HOOKS_STOP が利用可能であること

⸻

# Installation

```bash
# 1. Clone this repository
git clone https://github.com/your-account/myCodeBranchDesk.git
cd myCodeBranchDesk

# 2. Install dependencies
npm install
# or
pnpm install
# or
yarn install

# 3. (optional) Build for production
npm run build
```

⸻

# Configuration

myCodeBranchDesk は、環境変数または .env ファイルで設定します。

環境変数

代表的な環境変数は次の通りです。

```bash
MCBD_ROOT_DIR=/Users/you/work/my-monorepo
MCBD_PORT=3000
MCBD_BIND=127.0.0.1
MCBD_AUTH_TOKEN=your-local-token
```

- MCBD_ROOT_DIR<br>
git worktree を管理している ルートディレクトリ
例: モノレポのルート
- MCBD_PORT<br>
Web アプリのポート（デフォルト: 3000）
- MCBD_BIND<br>
バインドアドレス
- デフォルト: 127.0.0.1（ローカルホストのみ）
- スマホから LAN 経由でアクセスしたい場合: 0.0.0.0 を指定し、MCBD_AUTH_TOKEN を必ず設定してください。
- MCBD_AUTH_TOKEN
MCBD_BIND=0.0.0.0 の場合に 必須。
Web UI / API アクセス時に Authorization: Bearer <token> で検証します。

.env ファイル例

```bash
MCBD_ROOT_DIR=/Users/you/work/my-monorepo
MCBD_PORT=3000
MCBD_BIND=0.0.0.0
MCBD_AUTH_TOKEN=local-dev-only-token

※ .env 自体はリポジトリにコミットしないでください（.gitignore 推奨）。
```

⸻

# Usage

1. 起動

開発モードで起動する場合:

```bash
npm run dev

ビルド済みのアプリを起動する場合（任意）:

npm run build
npm start
```

ブラウザから以下にアクセスします。
- PC から: http://localhost:3000
- スマホ（同一 LAN）から: http://<your-pc-ip>:3000
※ MCBD_BIND=0.0.0.0 が必要です。

⸻

2. 画面A: Worktree 一覧
- MCBD_ROOT_DIR 配下の git worktree を検出し、一覧表示します。
- 各 worktree 行には:
- ブランチ名 (main, feature/foo など)
- 最後のメッセージ要約
- 最終更新日時（相対表示：例「5分前」）
- デフォルトでは 最終更新日時の新しい順 に並びます。

⸻

3. 画面B: チャット
- Worktree をタップすると、そのブランチ専用のチャット画面に遷移します。
- ヘッダー:
- Worktree 名（ブランチ名）
- 戻るボタン（Worktree 一覧へ）
- ログ画面へのボタン（画面Cへ）
- フッター:
- メッセージ入力欄
- [送信] ボタン

送信〜応答表示の流れ
1.	入力欄に Claude への指示を入力し、[送信] を押す
1.	UI は即座に「自分のメッセージ」＋「送信中…」バブルを表示（非同期）
1.	Claude CLI 側で処理が完了すると Stop フックが発火し、バックエンドを経由して応答が WebSocket でプッシュされる
1.	UI は「送信中…」バブルを実際の応答メッセージに差し替える

エラー / タイムアウト
- 送信 API がエラーの場合
- 「送信に失敗しました」といったエラーバブルを表示します。
- 一定時間（例: 120 秒）以内に Stop フックが来ない場合
- 「応答の取得に時間がかかっています。ログ画面から状況を確認できます。」等の警告を表示することを想定しています（実装状況に依存）。

⸻

4. 画面C: ログビューア
- チャット画面の [ログ] ボタンから遷移します。
- 対象 worktree の .claude_logs/ 配下にある Markdown ファイル一覧を表示します。
- ログ名をタップすると、Markdown がレンダリングされ、Claude の詳細な出力や実行ログを確認できます。

⸻

How it works (簡易フロー)
1.	ユーザーがブラウザ UI からメッセージ送信
→ POST /api/worktrees/:id/send
1.	バックエンドが該当 worktree 用の tmux セッションを確認
    - 無い場合：
    - tmux new-session -d -s cw_{worktreeId} -c {worktreePath}
    - CLAUDE_HOOKS_STOP を設定し、claude CLI を起動
1.	tmux send-keys でメッセージを Claude CLI に送信
1. Claude CLI が処理を完了し、Stop フックが発火
→ curl により POST /api/hooks/claude-done をコール
1. Hook API が tmux capture-pane で scrollback 全体を取得し、
前回取得位置との差分だけを「新規出力」として切り出す
1. 差分を Markdown ログとして保存し、ChatMessage として DB に保存
1. WebSocket 経由でブラウザに新しい ChatMessage を配信
1. UI が「送信中…」バブルを実際の応答メッセージに置き換える

⸻

# Project Structure

（実装イメージ。実際の構成は今後の開発で調整される可能性があります）

```bash
myCodeBranchDesk/
├─ src/
│  ├─ app/                      # Next.js App Router
│  │  ├─ page.tsx               # 画面A: Worktree一覧
│  │  ├─ worktrees/
│  │  │  ├─ [id]/page.tsx       # 画面B: チャット
│  │  │  ├─ [id]/logs/page.tsx  # 画面C: ログビューア
│  ├─ api/                      # API Routes
│  │  ├─ worktrees/route.ts                     # GET /api/worktrees
│  │  ├─ worktrees/[id]/send/route.ts           # POST /api/worktrees/:id/send
│  │  ├─ worktrees/[id]/messages/route.ts       # GET /api/worktrees/:id/messages
│  │  ├─ worktrees/[id]/logs/route.ts           # GET /api/worktrees/:id/logs
│  │  ├─ hooks/claude-done/route.ts             # POST /api/hooks/claude-done
│  ├─ lib/
│  │  ├─ tmux.ts                # tmux ラッパー (new-session, send-keys, capture-pane ...)
│  │  ├─ worktrees.ts           # git worktree のスキャンと Worktree モデル管理
│  │  ├─ db.ts                  # SQLite 接続
│  │  ├─ ws-server.ts           # WebSocket サーバ／room 管理
│  ├─ types/
│  │  ├─ models.ts              # Worktree / ChatMessage / SessionState 型定義
├─ docs/
│  ├─ architecture.md           # アーキテクチャ詳細（予定）
│  ├─ swe-agents.md             # SWEエージェント向けガイド
├─ LICENSE
├─ README.md
└─ package.json
```

⸻

# Development

Lint & Format

利用するツールに応じて変わりますが、基本的なコマンド例:

```bash
npm run lint
npm run format

（ESLint / Prettier を使う想定）

# Tests

包括的なテストスイートを用意しています:

```bash
# ユニットテスト
npm run test:unit

# 統合テスト
npm run test:integration

# E2Eテスト（Playwright）
npm run test:e2e

# 全テスト
npm test

# カバレッジ付きテスト
npm run test:coverage
```

**テスト構成**:
- **ユニットテスト (75件)**: データベース、ワークツリー管理、認証、パスバリデーション
- **統合テスト (44件)**: API エンドポイント、WebSocket 通信
- **E2Eテスト (24件)**: ブラウザ自動化テスト（Chromium + Mobile Safari）

**総テスト数**: 143件

詳細なテスト戦略については [テストドキュメント](./docs/testing.md) を参照してください

⸻

# Roadmap

今後検討している改善・拡張の方向性（例）:
- SSE 対応（WebSocket の代替／併用）
- マルチ LLM 対応（Claude 以外の CLI 実行）
- ログの自動ローテーション／クリーンアップ CLI
- チャット履歴の検索・フィルタ機能
- mySwiftAgent / myAgentDesk との統合
- 設定 UI（MCBD_ROOT_DIR などをブラウザ側で簡単に変更）

Issue / PR での提案も歓迎です。

⸻

# Contributing

歓迎します 🙌
- バグ報告
- ドキュメント改善
- 新機能提案・実装

をいただける場合は、以下の流れを推奨します。
1.	Issue を立てて背景や課題・提案内容を簡単に共有
1.	必要に応じてディスカッション後、PR を作成
1.	PR テンプレがある場合はそれに従ってください

コントリビュートに関する詳細なガイドラインは
CONTRIBUTING.md（今後追加予定）を参照してください。

⸻

# License

This project is licensed under the MIT License.

Copyright (c) 2025 Kota Maeno

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights  
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell      
copies of the Software, and to permit persons to whom the Software is          
furnished to do so, subject to the following conditions:                       

The above copyright notice and this permission notice shall be included in all 
copies or substantial portions of the Software.                                

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR     
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,       
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE    
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER         
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,  
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE  
SOFTWARE.

詳しくは LICENSE￼ を参照してください。

# For SWE Agents (Claude Code / OpenHands etc.)

Claude Code や OpenHands のような SWE エージェントから
このリポジトリを扱うためのガイドラインは docs/swe-agents.md￼ にまとめています。
- リポジトリ構造
- 守るべき前提（1 worktree = 1 tmux session 等）
- 典型的なタスク例
- 初期プロンプトの例