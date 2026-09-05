# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](../../README.md) | [日本語](./README.md)

**[CommandMate 公式サイト（英語）→](https://kewton.github.io/CommandMate/)**

<p align="center">
  <img src="../images/demo-desktop.gif" width="600" alt="契約つきで送信し、ゲートが走り、exit code が RESULT passed を返す" />
</p>

> **vibe coding から、Vibe Engineering へ。**

Vibe Engineering — 作るのは AI。エンジニアリングを保証するのは、あなたの専門知識ではなく仕組み。

```bash
npx commandmate@latest
```

**インストールから最初のセッションまで 60 秒。** macOS / Linux / Windows (WSL2) · Node.js v22+ · npm · git · tmux

---

CommandMate は、既に使っているエージェント CLI の上に**仕組み**を足します。作業の前に契約を、作業の後に検証ゲートを、方法論は Skill として。
tmux も Git worktree もターミナルもエージェント CLI も置き換えません。それらに枠をかけ、成果物が「終わった」ではなく「検証済み」で返るようにします。

<p align="center">
  <img src="../images/demo-mobile.gif" width="300" alt="入力待ちが届き、スマホから応答する" />
</p>

デスクトップでもモバイルでも使えます。あらゆるブラウザからセッションを監視・操作できます。

このワークフローに共感したら、ぜひ[リポジトリに Star](https://github.com/Kewton/CommandMate) をお願いします。

---

## 主な機能

| 機能 | できること | なぜ重要か |
|------|-----------|-----------|
| **実行契約（Task Contract）** | 作業を始める前に goal・変更してよい scope・検証ゲートを宣言し、`send --contract` でエージェントへ渡す | エージェントは推測ではなく、書かれた完了定義に向かって働く |
| **検証ゲート** | `.commandmate/verify.yaml` に宣言したゲートを `verify` / `wait --verify` で実行し、exit `0` / `20` / `21` を返す | 「完了」はエージェントの申告ではなく、検証ランが返した裁定になる |
| **証跡とメトリクス** | 組み込みの work-evidence / scope ゲートに加え、`verify history`・`task show`・`report metrics` | commit・ゲートログ・数値が残り、次の判断の材料になる |
| **Skills カタログ** | 公式 Catalog の Skill を worktree ごとに導入・更新（Web UI / `commandmate skill`） | 方法論は誰かの頭の中ではなく、エージェントが読む形で導入される |
| **入力待ちを見逃さない** | 入力待ちがバッジ・トースト・タブタイトル・PWA の App Badge・push 通知で届く | エージェントがあなたを必要とした瞬間に、席を外していても気づける |
| **Git Worktree セッション** | worktree ごとに独立したセッション、並列実行 | 複数の Issue が干渉なく同時に進む |
| **マルチエージェント対応** | worktree ごとに Claude Code / Codex / Gemini CLI / Copilot / OpenCode / Antigravity / Command Code / ローカルモデルを選択 | タスクに最適なエージェントを使い分け |
| **Auto Yes モード** | 確認なしでエージェントが動き続ける | 信頼できるワークフロー向けのオプショナル自動実行モード |
| **Web UI（デスクトップ & モバイル）** | あらゆるブラウザからセッションを操作 | デスクからでもスマホからでも監視・指示が可能 |
| **ファイルビューワ & Markdown エディタ** | ブラウザからファイルの閲覧・編集 | IDE を開かずにコード確認や AI への指示更新 |
| **スクリーンショット指示** | プロンプトに画像を添付 | バグ画面を撮影 →「これ直して」— エージェントが画像を認識 |
| **スケジュール実行** | CMATE.md に cron 式を定義して自動実行 | 毎朝レビュー、毎晩テスト — エージェントが定期的に働く |
| **トークン認証** | SHA-256 ハッシュ + HTTPS + レート制限 | 安全なリモートアクセス — 認証情報の漏洩なし、総当たり攻撃を防止 |

### 対応エージェント

8 種すべてが第一級。CommandMate の内部ではどれも同じ扱い（専用の起動経路・hook ソース・ステータス検出）を受けるため、worktree セッション・実行契約・検証ゲート・証跡の挙動は、どのエージェントを選んでも変わらない。

- **Claude Code** ・ **Codex** ・ **Gemini CLI** ・ **Copilot** ・ **Antigravity** — worktree ごと、タスクごとに選ぶ。
- **OpenCode** — オープンソースのターミナルエージェント。他と同じ契約とゲートの経路で動かせる。
- **Command Code** — 同じ経路で動かせる。hooks と transcript の取り込みにも対応。
- **ローカルモデル**（`vibe-local`） — 自分でホストするモデルで、同じループを回す。

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

## アプリとしてインストール（PWA）

CommandMate は Progressive Web App です。モバイルブラウザの**ホーム画面に追加**から全画面（standalone）で起動でき、外出先でエージェントを監視するのに向いています。Service Worker が静的アセットを事前キャッシュし、オフライン時はフォールバック画面を表示します。API レスポンス・ログイン画面・WebSocket 通信はキャッシュしません。

> **インストールには HTTPS が必要です。** ブラウザが Service Worker を登録する（＝インストールを提示する）のは `https://` か `http://localhost` の場合だけです。LAN 上の平文 HTTP（例: `http://192.168.x.x:3000`）でアクセスしている間は、ブラウザ側の制約でインストールとオフライン対応が無効になります。有効にするにはトンネルか HTTPS のリバースプロキシを使ってください（上のセキュリティ節を参照）。PWA レイヤーなしでもアプリ本体は完全に利用できます。

### スマホ通知（プッシュ通知）

インストール後は、**アプリを閉じていてもスマホに通知**を出せます（応答待ち・検証ゲートの不合格・セッションの起動失敗など）。

**VAPID 鍵を作るまで通知は出ません。** `commandmate init` が鍵ペアを生成し、`CM_VAPID_PUBLIC_KEY` / `CM_VAPID_PRIVATE_KEY` / `CM_VAPID_SUBJECT` を `.env` に書き込みます。未設定のときは起動ログと `commandmate status` に 1 行出ます。iOS / iPadOS は上記のホーム画面追加も必須です（Safari のタブでは購読できません）。HTTPS 要件や「届かないとき」を含む手順は [Webアプリ基本操作ガイド → スマホ通知](user-guide/webapp-guide.md#スマホ通知プッシュ通知) を参照してください。

---

## ブラウザ対応

Web UI は Tailwind CSS 4 で構築しており、配色・テーマの層で `@property` と `color-mix()` を使うため、
モダンブラウザを対象としています。最低対応バージョンは次のとおりです。

| ブラウザ | 最低バージョン |
|---------|--------------|
| Safari (macOS / iOS) | 16.4+ |
| Chrome / Edge | 111+ |
| Firefox | 128+ |

これより古いブラウザでも読み込めますが、配色と余白が劣化した状態で表示されます。
CommandMate はローカルの開発者向けツールなので、現行の開発マシンやスマートフォンに
入っているブラウザとこの範囲は一致します。

---

## 仕組み

```mermaid
flowchart LR
    A["ブラウザ / スマホ"] -->|HTTP| B["CommandMate Server"]
    B --> C["Session Manager"]
    G["Task Contract\n.commandmate/tasks/*.yaml"] --> C
    C -->|"spawn / attach"| D["tmux sessions\n(worktree ごと)"]
    D --> E["Agent CLI"]
    C <-->|"read / write"| F[("Local DB\n& State")]
    E --> H["Verification Gates\n.commandmate/verify.yaml"]
    H -->|"exit 0 / 20 / 21"| B
```

Git worktree ごとに専用の tmux セッションが割り当てられるため、複数タスクを干渉なく並列実行できます。
契約はセッションを起動する前に入り、ゲートはセッションが止まった後に走ります。その exit code が裁定です。

---

<details>
<summary><strong>Quick Start（詳細）</strong></summary>

```bash
# まず試すならワンコマンドで（ガイド付きセットアップ）
npx commandmate@latest

# または、継続的に使うならグローバルインストール（推奨）
npm install -g commandmate
commandmate init
commandmate start --daemon
```

`npx` を使うときは必ず `npx commandmate@latest` と書いてください。CommandMate をグローバル
インストール済みの環境では、`@latest` なしの `npx commandmate` はレジストリを一切参照せず、
既存のバイナリをそのまま実行します。そのため古いバージョンで動き続けていることに気づけません。
`@latest` を付けると npx が最新リリースを解決します。これは `npx` だけの話で、
`npm install -g commandmate` は `@latest` なしでも常にレジストリから解決します。

お試し以外の用途ではグローバルインストールを推奨します。`npx` は CommandMate を npm キャッシュ
に展開するため、`commandmate start --daemon` のバックグラウンドサーバーもそのキャッシュ
ディレクトリ上で動きます。後から `npx` を再実行したりキャッシュを削除すると、稼働中のサーバーの
足元のファイルが消える可能性があります。

引数なしで `commandmate` を実行すると、初回セットアップから起動までを一気に案内します。
依存関係をチェックし、初回のみ設定を対話で質問し、サーバーをバックグラウンドで起動して
起動完了を待ってから、ブラウザで UI を開きます。

2 回目以降は質問されず、UI を開くだけ（またはサーバー稼働中である旨の案内）になります。
Node.js 22 以上が必要です。

- `.env` が既にある場合、設定の質問はスキップされます
- ブラウザを開きたくない場合は `commandmate --no-open`（CI・ヘッドレス環境では自動的にスキップ）
- 手動でアクセスする場合は http://127.0.0.1:3000 を開いてください。CommandMate は既定で
  `127.0.0.1` に bind します。`localhost` は環境によって `::1`（IPv6）を先に解決しますが、
  そこは CommandMate が listen していないアドレスで、別プロセスが掴んでいることがあります

詳しくは [CLI セットアップガイド](../user-guide/cli-setup-guide.md) を参照してください。
Windows の場合は [WSL2 セットアップガイド](../user-guide/wsl2-setup.md) を参照してください。CommandMate は tmux に依存するため、Windows では WSL2 上で動作します（ネイティブ Windows は非対応）。

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
| `commandmate update` | 最新版に更新 |

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
<summary><strong>アップデート</strong></summary>

グローバルインストール（`npm install -g commandmate`）の場合、1 コマンドで完結します。
サーバーを停止し、最新版をインストールし、再起動して、応答することまで確認します。

```bash
# 更新の有無を確認（何も変更しない）
commandmate update --check

# 更新（確認プロンプトあり）
commandmate update

# 非対話環境（CI・スクリプト等）では --yes が必須
commandmate update --yes
```

**データは保持されます。** サーバー起動時にデータベースのマイグレーションが自動実行されるため、
worktree・セッション・設定はそのまま引き継がれます。手動でのマイグレーション作業は不要です。

**手動アップデート（fallback）** — `commandmate update` が使えない場合:

```bash
commandmate stop
npm install -g commandmate@latest
commandmate start --daemon
```

注意事項:

- 再起動後は `.env` の設定のみで起動します。`--auth` / `--cert` / `--key` / `--allowed-ips` /
  `--trust-proxy` / `--port` などを付けて起動していた場合は、update 後に手動で起動し直してください
  （`--auth` は起動のたびに新しいトークンが生成されます）。
- worktree 用サーバー（`--issue`）は自動停止されません。update **前**に
  `commandmate stop --issue <number>` で停止してください。
- 権限エラー（EACCES）時は `sudo` で再実行せず、[CLI セットアップガイド](../user-guide/cli-setup-guide.md)
  の手順で npm のグローバルディレクトリ権限を修正してください。

終了コードなどの詳細は [デプロイガイド](../DEPLOYMENT.md) を参照してください。

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
<summary><strong>With / Without CommandMate</strong></summary>

比べるべき相手は他の製品ではなく、**やり方**です。

| 観点 | vibe coding（丸投げ） | Vibe Engineering with CommandMate |
|---|---|---|
| 「完了」の意味 | エージェントが「できた」と言ったとき | 検証ランがそう言ったとき — exit 0 / 20 / 21 |
| 変更範囲 | エージェントが触った範囲すべて | 契約で宣言し、scope ゲートで強制する |
| 方法論 | 誰かの頭の中 | Catalog から Skill として導入する（`cmate-task-contract` / `cmate-verify` ほか） |
| 証跡 | チャットの履歴 | commit ・ ゲートログ ・ `verify history` ・ `report metrics` |
| 並列作業 | ターミナルのタブ | タスクごとに worktree 1 つと契約 1 つ |
| 止まったとき | そのうち気づく | 入力待ちが届く: バッジ ・ トースト ・ タブタイトル ・ 通知 |
| 使えるエージェント | 1 つに固定 | Claude Code ・ Codex ・ Gemini CLI ・ Copilot ・ OpenCode ・ Antigravity ・ Command Code ・ ローカルモデル |

</details>

---

## Vibe Engineering ワークフロー

<a id="issue-driven-development"></a>

AI を賢くするのではなく、AI を使う側に必要だったソフトウェアエンジニアリング能力を仕組み化する。
その仕組みは、どのエージェントにも渡せる 3 つで構成されます。**方法論**は導入された Skill として、
**契約**は作業の前に宣言するものとして、**ゲート**は作業の後に完了を裁定するものとして。

```
要求 → 契約 → エージェントが実行（任意の CLI・worktree ごと） → 検証済みの成果物
```

### 1. 方法論を Skill として導入する

Skill は公式 Catalog（[Kewton/commandmate-skills](https://github.com/Kewton/commandmate-skills)）から
取得し、選んだ worktree に導入します。Web UI（`/skills`、または worktree 詳細の Skills pane）からでも、
CLI からでも実行できます。

```bash
commandmate skill list
commandmate skill install cmate-task-contract --worktree <worktree-id> --version <version> --yes
```

| Skill | 扱う範囲 |
|-------|---------|
| `cmate-issue-authoring` | Feature 記述から実装可能な Issue 群を起案する |
| `cmate-issue-refinement` | 曖昧な Issue を read-only で実装可能な仕様へ精緻化する |
| `cmate-task-contract` | Issue から `.commandmate/tasks/<name>.yaml`（goal・scope・ゲート）を起案する |
| `cmate-verify` | `.commandmate/verify.yaml` にゲートを宣言し、実 exit code で判定する |
| `cmate-verify-advisor` | 検証の実行履歴から verify.yaml の改善案を出す |
| `cmate-worker-development` | ワーカーが進める 6 段（読取・調査・計画・実装・検証・証拠） |
| `cmate-acceptance-test` | Issue の受入条件を証跡付きで検証し Go / Conditional Go / No-Go を返す |
| `cmate-orchestrate` | 複数 Issue を並列に計画し、契約付きで dispatch して exit code で裁定する |

Catalog にはこのほか `cmate-repository-analysis` / `cmate-orchestrate-monitor` /
`cmate-worktree-setup` / `cmate-worktree-cleanup` も公開されています。support matrix・install root・
rollback の扱いは [Skills 配布ガイド](../user-guide/skills.md) を参照してください。

### 2. 契約を宣言し、ゲートに裁定させる

```bash
# .commandmate/tasks/issue-123.yaml に goal・scope.allow / scope.deny・実行するゲートを宣言する
commandmate send <worktree-id> --contract .commandmate/tasks/issue-123.yaml
commandmate wait <worktree-id> --verify
```

`--contract` がメッセージを供給するため、メッセージ引数は渡しません。`wait --verify` は
エージェントが停止した後にゲートを実行し、裁定を exit code で返します。**0** は全ゲート合格、
**20** はいずれかのゲートが不合格、**21** は work-evidence ゲートが commit も未 commit の変更も
見つけられなかった場合です。

契約の書式は [実行契約 仕様](../design/task-contract.md)、ゲートの書式は
[検証ゲート設定 仕様](../design/verification-config.md) が正準です。

### 次に読むもの

| ドキュメント | 得られるもの |
|-------------|------------|
| [コンセプト](../concept.md) | Vision・Mission と、各実装項目がどの機能に対応するか |
| [チュートリアル](../user-guide/tutorial.md) | サンプルリポジトリを fork し、契約から検証までを 15 分ほどで一通り体験する |
| [プロダクトの特徴](../features/product-highlights.md) | 機能ごとの紹介 |
| [CLI 操作ガイド](../user-guide/cli-operations-guide.md) | エージェント操作系コマンドの詳細 |

> **CommandMate 自体を開発する場合。** `.claude/commands` 配下の `/work-plan` `/pm-auto-dev` などの
> スラッシュコマンドは**このリポジトリ専用**です。あなたのリポジトリには導入されません。可搬な
> 代替は上の Catalog Skill です。詳細は [コマンド利用ガイド](../user-guide/commands-guide.md) を
> 参照してください。

---

## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [CLI セットアップガイド](../user-guide/cli-setup-guide.md) | インストールと初期設定 |
| [チュートリアル](../user-guide/tutorial.md) | サンプルリポジトリを fork し、契約から検証済みの成果物までを 15 分ほどで体験する |
| [Webアプリ操作ガイド](../user-guide/webapp-guide.md) | Webアプリの基本操作 |
| [クイックスタート](../user-guide/quick-start.md) | Claude Code コマンドの使い方 |
| [コンセプト](../concept.md) | Vision・Mission・中核原則の正本と、各実装項目と機能の対応 |
| [プロダクトの特徴](../features/product-highlights.md) | 機能ごとの紹介 |
| [Skills 配布ガイド](../user-guide/skills.md) | 公式 Catalog の Skill を worktree へ導入する |
| [アーキテクチャ](../architecture.md) | システム設計 |
| [デプロイガイド](../DEPLOYMENT.md) | 本番環境構築手順 |
| [UI/UXガイド](../UI_UX_GUIDE.md) | UI 実装の詳細 |
| [Trust & Safety](../TRUST_AND_SAFETY.md) | セキュリティと権限の考え方 |

## Contributing

バグ報告・機能提案・ドキュメント改善を歓迎します。詳しくは [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## License

[MIT License](../../LICENSE) - Copyright (c) 2026 Kewton
