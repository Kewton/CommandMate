# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](../../README.md) | [日本語](./README.md)

**[CommandMate 公式サイト（英語）→](https://kewton.github.io/CommandMate/)**

> **複数のコーディングエージェントを並列に。机を離れていても。**

CommandMate は、いつも使っているコーディングエージェントを自分のマシンの 1 か所にまとめ、並べて動かし、Issue 単位で仕事を渡し、終わったかどうかを自分のチェックで決められるようにするツールです。

| Level | CommandMate がすること | あなたの役割 |
|-------|------------------------|--------------|
| 1 — Parallel | 複数のコーディングエージェントを 1 か所から並べて動かす | Operator: 各エージェントに応える |
| 2 — Delegate | Issue 単位で仕事を渡し、完了はエージェントの申告ではなく、あなたのチェック（lint・テスト）の結果で決める | Product / Tech lead: タスクを書き、結果を受け取る |
| 3 — Manage | PM 役のエージェントが計画・割り当て・確認をまとめる。あなたは PM と話して承認する | Owner: 方向を決めて承認する |
| Next — Learn | まだ作っていない。方向だけ: 過去の作業の記録から、仕事の進め方を良くしていく | — |

**Anywhere:** どの Level でも、スマホのブラウザから応答・承認できる。机を離れても仕事が止まらない。

多くの人は Level 2 で十分です。自分に合う Level で止めてかまいません。上を目指す必要はありません。

記録した 1 回の run（PM → 開発リーダー → ワーカー）:

- 4 Issue、ワーカー 4 つ（Command Code）、PM と開発リーダーは Claude Code
- スマホ幅の Web UI からメッセージ 2 通＋タップ 3 回
- 検証 4/4 合格、PR は CI 緑でマージ、UAT 4/4 GO
- 依頼から報告まで 9 分 48 秒

as observed（実測した範囲）: 2026-10-02 に記録した 1 回の run。ベンチマークではない。

<p align="center">
  <img src="../images/demo-hero.ja.gif" width="560" alt="4 つの Issue の一覧、lead セッションへ打ち込まれた 1 通、サイドバーに並ぶ 4 つの worktree セッション、テストファイルを書く worker、そしてフェーズごとの表がついた最終報告" />
</p>

オープンソース（MIT） · あなたのマシンで動く · macOS / Linux / Windows（WSL2） · アプリのインストールは不要

---

## 困りごと

- エージェントは何時間でも働ける。あなたは何時間も机に張り付いて応えられない。
- 外から見ると、手が空いたエージェントと、あなたを待っているエージェントの区別がつかない。
- エージェントの「やりました」は、やった証拠ではない。

---

## 各レベル

### Level 1 — Parallel

Claude Code ・ Codex ・ Gemini CLI ・ Copilot ・ OpenCode（1.x と V2） ・ Antigravity ・ Command Code ・ ローカルモデルを並べて動かす。タスクごとに、Git worktree（リポジトリの作業用コピー）とセッションを 1 つずつ割り当てるので、2 つのエージェントが同じファイルを同時に書き換えることはない。どのエージェントがあなたを待っているかはバッジやプッシュ通知で届き、チャットのように応答できる。

あなたの役割: Operator。各エージェントの質問を読み、応える。

### Level 2 — Delegate

チャットの 1 通ではなく、Issue を渡す。Issue はタスク定義つきで渡る。タスク定義はリポジトリに置く短いファイルで、目的・エージェントが変更してよいファイル・通るべきチェックを書く。エージェントが止まると、CommandMate があなた自身のチェック（lint・型チェック・テスト）を実行し、エージェントの要約ではなくその結果で合否が決まる。

```text
Issues → Task contracts → Worktrees → Agents × N → Checks → PR
```

あなたの役割: Product / Tech lead。何を作るかを決め、合格したものを受け取る。セッションの成果を別のエージェントに渡してレビューさせることもできる。結果の返り方は [CLI 操作ガイド](../user-guide/cli-operations-guide.md#commandmate-verify) にあります。

### Level 3 — Manage

エージェント 1 体ずつではなく、PM 役のエージェント 1 体と話す。PM に 1 通送ると、Issue を計画し、Level 2 と同じようにそれぞれをエージェントに渡し、チェックに合格したものだけが PR になる。何かを書き換える手順はどれもあなたの承認を待つ。決めた時刻に PM を起動して、席を外している間に進めることもできる。[^author]

あなたの役割: Owner。方向を決め、PM に応え、承認する。

### Next — Learn

まだ作っていない。方向だけを示す: 1 つひとつの作業が残す記録を使って、次の作業の進め方を良くしていく。

各レベルの詳細は [公式サイト](https://kewton.github.io/CommandMate/) に、長い版は [CommandMate のしくみ](../user-guide/how-it-works.md) にあります。

[^author]: 作者は、これらの部品と決まった時刻の起動を組み合わせて、毎日の自動修正を回している。これは作者自身の使い方であって、製品のスイッチではない。

---

## エージェントにセットアップさせる

いつも使っているエージェント CLI（Claude Code、Codex など）に、次の 1 文を貼ってください:

```text
https://kewton.github.io/CommandMate/setup.md を読んで、このマシンに CommandMate をセットアップするのを手伝ってください。各手順は実行する前に説明し、何かをインストールする前と、インターネットからのアクセスを開ける前には私に確認してください。
```

### 手で入れる場合

macOS / Linux / Windows（WSL2）、Node.js v22 以上、npm、git、tmux が必要です。

```bash
npm install -g commandmate
commandmate init
commandmate start --daemon
```

- ブラウザで http://127.0.0.1:3000 を開きます。`localhost` ではなく `127.0.0.1` を使う理由は [CLI セットアップガイド](../user-guide/cli-setup-guide.md#ブラウザでアクセス) にあります。
- インストールせずに試すなら `npx commandmate@latest`（必ず `@latest` を付ける）。理由と WSL2・アップデート・ソースからのビルドは [CLI セットアップガイド](../user-guide/cli-setup-guide.md) にあります。
- スマホ通知は `commandmate init` が設定します。届かないときは [Webアプリ操作ガイド → スマホ通知](../user-guide/webapp-guide.md#スマホ通知プッシュ通知) を参照してください。
- スマホから使うには `commandmate remote` を実行します。Tailscale か Cloudflare でサーバーを公開し（公開インターネットに出す前に確認します）、ペアリング用の QR コードを表示します。

### 最初に使うコマンド

あなたにも、エージェントにも。Level ごとに分けています。

**Level 1 — Parallel**

| コマンド | すること |
|---------|---------|
| `commandmate status` | サーバーが動いているか、プッシュ通知が設定済みか |
| `commandmate remote` | QR コードでスマホとペアリングする |
| `commandmate ls` | すべての worktree と、そのセッションの状態 |
| `commandmate send <id> "Issue #101 を実装して" --instance codex` | 1 つのエージェントのセッションにメッセージを送る |
| `commandmate capture <id>` | セッションの現在の出力を読む |
| `commandmate respond <id> "yes"` | エージェントが待っているプロンプトに応答する |
| `commandmate update` | グローバルインストールを更新し、サーバーを再起動する |

**Level 2 — Delegate**

| コマンド | すること |
|---------|---------|
| `commandmate send <id> --contract .commandmate/tasks/issue-101.yaml --instance codex` | タスク定義を渡す |
| `commandmate wait <id> --instance codex --verify` | エージェントを待ち、あなたのチェックを実行して合否を返す |

**Level 3 — Manage**

| コマンド | すること |
|---------|---------|
| `commandmate skill list` | worktree ごとに導入できる公式 Catalog の Skill（PM 役のエージェントが使う Skill を含む） |
| `commandmate docs --section agent-operations` | エージェントに読ませるコマンドガイド全文 |

すべてのコマンドとフラグは [CLI 操作ガイド](../user-guide/cli-operations-guide.md) に、オプション一覧は `commandmate --help` にあります。

---

## やらないこと

- 裏で勝手に動き続けるものではない。1 つひとつの作業には始まりと終わりがあり、あなたが承認するまでリポジトリは書き換わらない。
- コードを代わりに読んではくれない。チェックが捕まえるのは、あなたのテストと lint が捕まえる範囲だけである。
- 別のエージェントによるレビューは、あなたが足す 1 ステップであって、CommandMate が代わりにやってくれるものではない。
- 承認はいまも人のところに来る。Auto Yes は opt-in で、時間の上限つきで、あなたが指定したパターンで止まる。
- tmux ・ Git worktree ・ ターミナル ・ エージェント CLI を置き換えるものではない。OS を再起動すればプロセスは終わる。残るのは記録である。

---

## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [CommandMate のしくみ](../user-guide/how-it-works.md) | 長い版を Level 順に: Parallel・Delegate（契約・ゲート・Skill）・Manage・Next、続いて Anywhere・対応エージェント・セキュリティ・実測 |
| [チュートリアル](../user-guide/tutorial.md) | サンプルリポジトリを fork し、タスク定義から、チェックに合格した成果物までを 15 分ほどで体験する |
| [クイックスタート](../user-guide/quick-start.md) | どのエージェントでも回る「タスク定義を渡してチェックで確かめる」最小の流れと、5 分の開発フロー |
| [CLI セットアップガイド](../user-guide/cli-setup-guide.md) | インストール、`npx`、初期設定、アップデート、ソースからのビルド |
| [CLI 操作ガイド](../user-guide/cli-operations-guide.md) | CLI からのセッション操作: タスク定義（実行契約）、チェック（検証ゲート）、Skill、エージェントインスタンス |
| [Webアプリ操作ガイド](../user-guide/webapp-guide.md) | Web UI、スマホからのアクセス、アプリとしてのインストール（PWA）、プッシュ通知、対応ブラウザ |
| [トラブルシューティング & FAQ](../user-guide/troubleshooting.md) | 固まったセッション、空白に見える `tmux attach`、ポート競合、スマホ・外出先からのアクセス |
| [Skills 配布ガイド](../user-guide/skills.md) | 公式 Catalog の Skill を worktree へ導入する |
| [OpenCode V2 ガイド](../user-guide/opencode-v2.md) | OpenCode V2 を OpenCode 1.x と並べて使う |
| [Agent Event Hooks](../user-guide/agent-event-hooks.md) | 画面の読み取りではなく、構造化されたエージェントイベント |
| [コンセプト](../concept.md) | Vision・Mission・中核原則の正本と、各実装項目と機能の対応 |
| [プロダクトの特徴](../features/product-highlights.md) | 機能ごとの紹介 |
| [セキュリティガイド](../security-guide.md) | テレメトリなし・アカウント不要。認証とリモートアクセス |
| [Trust & Safety](../TRUST_AND_SAFETY.md) | セキュリティと権限の考え方 |
| [アーキテクチャ](../architecture.md) | システム設計 |
| [デプロイガイド](../DEPLOYMENT.md) | 本番環境構築手順 |

## Contributing

バグ報告・機能提案・ドキュメント改善を歓迎します。詳しくは [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## License

[MIT License](../../LICENSE) - Copyright (c) 2026 Kewton
