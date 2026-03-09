# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](../../README.md) | [日本語](./README.md)

<p align="center">
  <img src="../images/demo-desktop.gif" width="600" alt="CommandMate デスクトップデモ" />
</p>

> **ターミナルをさばくな。エージェント CLI をオーケストレーションしよう。**

CommandMate は、エージェント CLI のローカルコントロールプレーンです。

```bash
npx commandmate
```

**インストールから最初のセッションまで 60 秒。** macOS / Linux · Node.js v20+ · npm · git · tmux · openssl

---

CommandMate は、既存のエージェント CLI の上にオーケストレーションと可視性を追加します。
tmux、Git worktree、ターミナルを置き換えません。大規模な管理を容易にします。

<p align="center">
  <img src="../images/demo-mobile.gif" width="300" alt="CommandMate モバイルデモ" />
</p>

デスクトップでもモバイルでも使えます。あらゆるブラウザからセッションを監視・操作できます。

このワークフローに共感したら、ぜひ[リポジトリに Star](https://github.com/Kewton/CommandMate) をお願いします。

---

## 主な機能

| 機能 | できること | なぜ重要か |
|------|-----------|-----------|
| **Git Worktree セッション** | worktree ごとに独立したセッション、並列実行 | 複数の Issue が干渉なく同時に進む |
| **マルチエージェント対応** | Issue ごとに Claude Code、Codex、Gemini、ローカルモデルを選択 | タスクに最適なエージェントを使い分け |
| **Auto Yes モード** | 確認なしでエージェントが動き続ける | 信頼できるワークフロー向けのオプショナル自動実行モード |
| **Web UI（デスクトップ & モバイル）** | あらゆるブラウザからセッションを操作 | デスクからでもスマホからでも監視・指示が可能 |
| **ファイルビューワ & Markdown エディタ** | ブラウザからファイルの閲覧・編集 | IDE を開かずにコード確認や AI への指示更新 |
| **スクリーンショット指示** | プロンプトに画像を添付 | バグ画面を撮影 →「これ直して」— エージェントが画像を認識 |
| **スケジュール実行** | CMATE.md に cron 式を定義して自動実行 | 毎朝レビュー、毎晩テスト — エージェントが定期的に働く |
| **トークン認証** | SHA-256 ハッシュ + HTTPS + レート制限 | 安全なリモートアクセス — 認証情報の漏洩なし、総当たり攻撃を防止 |

---

## ユースケース

| シナリオ | CommandMate でできること |
|----------|------------------------|
| **Issue 並列開発** | 複数の Issue を別々の worktree で同時に進行、各セッションに専用エージェント |
| **Issue の精緻化** | Issue を定義し、AI が不足を補い、コードを書く前に方向性を確認 |
| **夜間自律実行** | スケジュール実行で Issue をキュー — 朝に進捗を確認 |
| **モバイルレビュー** | AI が生成した変更をスマホから確認・方向修正 |
| **ビジュアルバグ修正** | スマホで UI バグを撮影 →「これ直して」で送信 |

---

## セキュリティ

**100% ローカル実行**。外部サーバーなし、クラウド中継なし、アカウント登録不要。ネットワーク通信は Claude CLI 自体の API 呼び出しのみ。

- フルオープンソース（[MIT License](../../LICENSE)）
- ローカルデータベース、ローカルセッション
- リモートアクセスはトンネリングサービス（[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)、[ngrok](https://ngrok.com/)、[Pinggy](https://pinggy.io/)）、VPN、または認証付きリバースプロキシを推奨

詳細は[セキュリティガイド](../security-guide.md)と [Trust & Safety](../TRUST_AND_SAFETY.md) を参照してください。

---

## 仕組み

```mermaid
flowchart LR
    A["ブラウザ / スマホ"] -->|HTTP| B["CommandMate Server"]
    B --> C["Session Manager"]
    C -->|"spawn / attach"| D["tmux sessions\n(worktree ごと)"]
    D --> E["Claude Code CLI"]
    C <-->|"read / write"| F[("Local DB\n& State")]
```

Git worktree ごとに専用の tmux セッションが割り当てられるため、複数タスクを干渉なく並列実行できます。

---

<details>
<summary><strong>Quick Start（詳細）</strong></summary>

```bash
# インストール & 起動をワンコマンドで
npx commandmate

# またはグローバルインストール
npm install -g commandmate
commandmate init
commandmate start --daemon
```

ブラウザで http://localhost:3000 にアクセスしてください。

詳しくは [CLI セットアップガイド](../user-guide/cli-setup-guide.md) を参照してください。

</details>

<details>
<summary><strong>CLI コマンド</strong></summary>

### 基本

| コマンド | 説明 |
|---------|------|
| `commandmate init` | 初期設定（対話形式） |
| `commandmate init --defaults` | 初期設定（デフォルト値） |
| `commandmate init --force` | 既存設定を上書き |
| `commandmate start` | サーバー起動（フォアグラウンド） |
| `commandmate start --daemon` | バックグラウンド起動 |
| `commandmate start --dev` | 開発モードで起動 |
| `commandmate start -p 3001` | ポート指定で起動 |
| `commandmate stop` | サーバー停止 |
| `commandmate stop --force` | 強制停止（SIGKILL） |
| `commandmate status` | 状態確認 |

### Worktree 並列開発

Issue/worktree ごとにサーバーを分離起動し、自動ポート割当で並列開発が可能です。

| コマンド | 説明 |
|---------|------|
| `commandmate start --issue 123` | Issue #123 用サーバー起動 |
| `commandmate start --issue 123 --auto-port` | 自動ポート割当で起動 |
| `commandmate start --issue 123 -p 3123` | 特定ポートで起動 |
| `commandmate stop --issue 123` | Issue #123 用サーバー停止 |
| `commandmate status --issue 123` | Issue #123 用サーバー状態確認 |
| `commandmate status --all` | 全サーバー状態確認 |

### GitHub Issue 管理

[gh CLI](https://cli.github.com/) のインストールが必要です。

| コマンド | 説明 |
|---------|------|
| `commandmate issue create` | Issue を作成 |
| `commandmate issue create --bug` | バグ報告テンプレートで作成 |
| `commandmate issue create --feature` | 機能リクエストテンプレートで作成 |
| `commandmate issue create --question` | 質問テンプレートで作成 |
| `commandmate issue create --title <title>` | タイトルを指定 |
| `commandmate issue create --body <body>` | 本文を指定 |
| `commandmate issue create --labels <labels>` | ラベルを追加（カンマ区切り） |
| `commandmate issue search <query>` | Issue を検索 |
| `commandmate issue list` | Issue 一覧 |

### ドキュメント参照

| コマンド | 説明 |
|---------|------|
| `commandmate docs` | ドキュメント表示 |
| `commandmate docs -s <section>` | 特定セクションを表示 |
| `commandmate docs -q <query>` | ドキュメント検索 |
| `commandmate docs --all` | 全セクション一覧 |

全オプションは `commandmate --help` で確認できます。

</details>

<details>
<summary><strong>トラブルシューティング & FAQ</strong></summary>

### Claude CLI が見つからない / パスが変わった？

Claude CLI の npm 版とスタンドアロン版を切り替えるとパスが変わることがあります。CommandMate は次のセッション起動時に自動検出します。カスタムパスを設定するには `.env` に `CLAUDE_PATH=/path/to/claude` を追加してください。

### ポート競合？

```bash
commandmate start -p 3001
```

### セッションが固まっている / 応答がない？

tmux セッションを直接確認できます。CommandMate は `mcbd-{ツール名}-{worktree名}` の形式でセッションを管理しています：

```bash
# CommandMate が管理しているセッション一覧を確認
tmux list-sessions | grep mcbd

# 特定セッションの出力を確認（アタッチせずに）
tmux capture-pane -t "mcbd-claude-feature-123" -p

# セッションにアタッチして確認（detach は Ctrl+b → d）
tmux attach -t "mcbd-claude-feature-123"

# 壊れたセッションを手動で削除
tmux kill-session -t "mcbd-claude-feature-123"
```

> **注意：** アタッチ中にセッション内で直接入力すると、CommandMate のセッション管理と干渉する可能性があります。`Ctrl+b` → `d` で detach し、CommandMate UI から操作してください。

### Claude Code 内から起動するとセッション開始に失敗する？

Claude Code は `CLAUDECODE=1` を設定してネストを防止しています。CommandMate は自動で除去しますが、問題が続く場合は `tmux set-environment -g -u CLAUDECODE` を実行してください。

### FAQ

**Q: スマホからどうやってアクセスする？**
A: CommandMate は PC 上で Web サーバーを起動します。スマホと PC が同じネットワーク（Wi-Fi）にいる状態で、`commandmate init` で外部アクセスを有効にすると `CM_BIND=0.0.0.0` が設定されます。スマホのブラウザで `http://<PCのIPアドレス>:3000` を開いてください。

**Q: 外出先からアクセスできる？**
A: はい。トンネリングサービスを使えば、ルーターのポート開放なしにローカルサーバーを安全に公開できます：

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — 無料、Cloudflare アカウントが必要
- [ngrok](https://ngrok.com/) — 無料枠あり、セットアップが簡単
- [Pinggy](https://pinggy.io/) — サインアップ不要、SSH ベースのシンプルなトンネル

VPN や認証付きリバースプロキシ（Basic 認証、OIDC 等）も利用可能です。**認証なしでインターネットに直接公開しないでください。**

**Q: iPhone / Android で使える？**
A: はい。CommandMate の Web UI はレスポンシブ対応で、Safari・Chrome などのモバイルブラウザで動作します。アプリのインストールは不要です。

**Q: tmux は必須？**
A: CommandMate は内部で tmux を使用して CLI セッションを管理しています。ユーザーが tmux を直接操作する必要はありません。

**Q: Claude Code の権限はどうなる？**
A: Claude Code 自体の権限設定がそのまま適用されます。本ツールが権限を拡張することはありません。詳しくは [Trust & Safety](../TRUST_AND_SAFETY.md) を参照してください。

**Q: 複数人で使える？**
A: 現時点では個人利用を想定しています。複数人での同時利用は未対応です。

</details>

<details>
<summary><strong>開発者向けセットアップ</strong></summary>

コントリビューターや開発環境を構築する場合：

```bash
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
./scripts/setup.sh  # 依存チェック、環境設定、ビルド、起動まで自動実行
```

### 手動セットアップ（カスタマイズしたい場合）

```bash
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
./scripts/preflight-check.sh          # 依存チェック
npm install
./scripts/setup-env.sh                # 対話式で .env を生成
npm run db:init
npm run build
npm start
```

> **Note**: `./scripts/*` スクリプトは開発環境でのみ使用可能です。グローバルインストール（`npm install -g`）では `commandmate` CLI を使用してください。

</details>

---

<details>
<summary><strong>競合比較</strong></summary>

| 機能 | CommandMate | Remote Control（公式） | Happy Coder | claude-squad | Omnara |
|------|:-----------:|:---------------------:|:-----------:|:------------:|:------:|
| Auto Yes モード | あり | なし | なし | あり（TUI のみ） | なし |
| Git Worktree 管理 | あり | なし | なし | あり（TUI のみ） | なし |
| 並列セッション | あり | **なし（1つのみ）** | あり | あり | なし |
| モバイル Web UI | あり | あり（claude.ai） | あり | **なし** | あり |
| ファイルビューワ | あり | なし | なし | なし | なし |
| Markdown エディタ | あり | なし | なし | なし | なし |
| スクリーンショット指示 | あり | なし | なし | 不可能 | なし |
| スケジュール実行 | あり | なし | なし | なし | なし |
| PC を閉じても継続 | あり（デーモン） | **なし（ターミナル必須）** | あり | あり | あり |
| トークン認証 | あり | N/A（Anthropic アカウント） | N/A（アプリ） | なし | N/A（クラウド） |
| 無料 / OSS | あり | Pro/Max 必須 | 無料+有料 | あり | $20/月 |
| 完全ローカル実行 | あり | Anthropic API 経由 | サーバー経由 | あり | クラウドフォールバック |

</details>

---

## オプショナルワークフローレイヤー

<a id="issue-driven-development"></a>

チームでより構造的な開発を行いたい場合、CommandMate は Issue の精査、設計レビュー、
計画立案、実装、受け入れチェックの標準化もサポートします。
これらのワークフローは同じ CLI セッションと worktree の上に構築されます。利用は任意です。

CommandMate は、ファイルを直接編集する時間よりも、Issue を定義し、方向性を確認し、コーディングエージェントの成果を受け入れる時間の方が長い開発者のために作られています。以下のコマンドは、そのワークフローを再現可能なプロセスに変えます。

```
Issue 定義 → AI で補強 → 方向性レビュー → 計画生成 → エージェントが実行
```

| ステップ | コマンド | 実行内容 |
|---------|---------|---------|
| Issue を補強 | `/issue-enhance` | AI が不足情報を質問し、Issue を補完 |
| Issue レビュー | `/multi-stage-issue-review` | 多段階レビュー（整合性・影響範囲）と指摘の自動対応 |
| 設計レビュー | `/multi-stage-design-review` | 4 段階レビュー（通常 → 整合性 → 影響分析 → セキュリティ） |
| 作業計画 | `/work-plan` | タスク分割と依存関係を生成 |
| TDD 実装 | `/tdd-impl` | Red-Green-Refactor サイクルを自動実行 |
| 受入テスト | `/acceptance-test` | Issue の受入基準を検証 |
| PR 作成 | `/create-pr` | タイトル・説明・ラベルを自動生成 |
| 開発（一括） | `/pm-auto-dev` | TDD 実装 → 受入テスト → リファクタリング → 進捗レポート |
| Issue → 実装（一括） | `/pm-auto-issue2dev` | Issue レビュー → 設計レビュー → 作業計画 → TDD 実装 → 受入テスト → リファクタリング → 進捗レポート |
| 設計 → 実装（一括） | `/pm-auto-design2dev` | 設計レビュー → 作業計画 → TDD 実装 → 受入テスト → リファクタリング → 進捗レポート |

詳細は CommandMate リポジトリの [Issues](https://github.com/Kewton/CommandMate/issues)、[開発レポート](../../dev-reports/issue/)、[ワークフロー例](../user-guide/workflow-examples.md) を参照してください。

---

## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [CLI セットアップガイド](../user-guide/cli-setup-guide.md) | インストールと初期設定 |
| [Webアプリ操作ガイド](../user-guide/webapp-guide.md) | Webアプリの基本操作 |
| [クイックスタート](../user-guide/quick-start.md) | Claude Code コマンドの使い方 |
| [コンセプト](../concept.md) | ビジョンと解決する課題 |
| [アーキテクチャ](../architecture.md) | システム設計 |
| [デプロイガイド](../DEPLOYMENT.md) | 本番環境構築手順 |
| [UI/UXガイド](../UI_UX_GUIDE.md) | UI 実装の詳細 |
| [Trust & Safety](../TRUST_AND_SAFETY.md) | セキュリティと権限の考え方 |

## Contributing

バグ報告・機能提案・ドキュメント改善を歓迎します。詳しくは [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## License

[MIT License](../../LICENSE) - Copyright (c) 2026 Kewton
