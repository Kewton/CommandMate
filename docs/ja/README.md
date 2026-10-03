# CommandMate

[![GitHub Stars](https://img.shields.io/github/stars/Kewton/CommandMate?style=social)](https://github.com/Kewton/CommandMate)
![npm version](https://img.shields.io/npm/v/commandmate)
![npm downloads](https://img.shields.io/npm/dm/commandmate)
![license](https://img.shields.io/github/license/Kewton/CommandMate)
![CI](https://img.shields.io/github/actions/workflow/status/Kewton/CommandMate/ci-pr.yml)
**Status: Beta**

[English](../../README.md) | [日本語](./README.md)

**[CommandMate 公式サイト（英語）→](https://kewton.github.io/CommandMate/)**

> **まとまった時間がなくても、スマホから AI チームを動かす。**

- 1 人で 1 日 10 本以上の PR
- 月 $110〜$210: Claude Max + Command Code Goat
- 指示の約 8 割をスマホから送信（作者の概算）
- 2026 年 9 月にマージした PR 689 本（作者のリポジトリ合計）

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

## 3 つのレベル

### Level 1 — 何体ものエージェントを 1 か所に、ポケットに

タスクごとに Git worktree とセッションを 1 つずつ。エージェントは合うものを選ぶ: Claude Code ・ Codex ・ Gemini CLI ・ Copilot ・ OpenCode（1.x と V2） ・ Antigravity ・ Command Code ・ ローカルモデル。入力待ちは画面からの推測ではなくエージェント自身の hook から読み、バッジやプッシュ通知としてスマホに届く。応答はブラウザから。

### Level 2 — チャットではなく、チームとして働かせる

タスクは契約（goal・変更してよい範囲・ゲート）つきで渡り、裁定つきで戻ってくる。裁定はエージェントの要約ではなくゲートの exit code（`0` 合格・`20` 不合格・`21` 作業の証跡なし）。セッションの成果を別のエージェントに渡してレビューさせることもできる。

### Level 3 — 作って、保守までする AI チーム

lead セッションに 1 通送ると、複数の Issue を計画し、それぞれを契約つきで worker に渡し、ゲートを通ったものだけが PR になる。スケジュール実行で、席を外している間も仕事が進む。作者が毎日回している自動修正ループは、これらの部品で組んだ作者の運用例であって、製品のスイッチではない。

各レベルの詳細は [公式サイト](https://kewton.github.io/CommandMate/) に、長い版は [CommandMate のしくみ](../user-guide/how-it-works.md) にあります。

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

- ブラウザで http://127.0.0.1:3000 を開きます。CommandMate は既定で `127.0.0.1` に bind します。`localhost` は環境によって `::1`（IPv6）を先に解決しますが、そこは CommandMate が listen していないアドレスで、別プロセスが掴んでいることがあります。
- インストールせずに試すなら `npx commandmate@latest`（必ず `@latest` を付ける）。理由と WSL2・アップデート・ソースからのビルドは [CLI セットアップガイド](../user-guide/cli-setup-guide.md) にあります。
- スマホ通知は、`commandmate init` が `CM_VAPID_PUBLIC_KEY` / `CM_VAPID_PRIVATE_KEY` / `CM_VAPID_SUBJECT` を `.env` に書き込むまで出ません。[Webアプリ操作ガイド → スマホ通知](../user-guide/webapp-guide.md#スマホ通知プッシュ通知) を参照してください。
- スマホから使うには `commandmate remote` を実行します。Tailscale か Cloudflare でサーバーを公開し（公開インターネットに出す前に確認します）、ペアリング用の QR コードを表示します。

最初に使うコマンド（あなたにも、エージェントにも）:

| コマンド | すること |
|---------|---------|
| `commandmate status` | サーバーが動いているか、プッシュ通知が設定済みか |
| `commandmate remote` | QR コードでスマホとペアリングする |
| `commandmate ls` | すべての worktree と、そのセッションの状態 |
| `commandmate send <id> "Issue #101 を実装して" --instance codex` | 1 つのエージェントのセッションにメッセージを送る |
| `commandmate send <id> --contract .commandmate/tasks/issue-101.yaml --instance codex` | 実行契約を渡す |
| `commandmate wait <id> --instance codex --verify` | エージェントを待ち、ゲートを実行する: exit `0` / `20` / `21` |
| `commandmate capture <id>` | セッションの現在の出力を読む |
| `commandmate respond <id> "yes"` | エージェントが待っているプロンプトに応答する |
| `commandmate skill list` | worktree ごとに導入できる公式 Catalog の Skill |
| `commandmate update` | グローバルインストールを更新し、サーバーを再起動する |
| `commandmate docs --section agent-operations` | エージェントに読ませるコマンドガイド全文 |

すべてのコマンドとフラグは [CLI 操作ガイド](../user-guide/cli-operations-guide.md) に、オプション一覧は `commandmate --help` にあります。

---

## やらないこと

- これは常駐エージェントではなく、1 回のランである。永久に回り続けるものは無く、明示的な承認なしに何かが書き換わることも無い。
- コードを代わりに読んではくれない。ゲートが捕まえるのは、あなたのテストとチェックが捕まえる範囲だけである。
- 別のエージェントによるレビューは、あなたが足す 1 ステップであって、ランナーが代わりにやってくれるものではない。
- 承認はいまも人のところに来る。Auto Yes は opt-in で、時間の上限つきで、あなたが指定したパターンで止まる。
- tmux ・ Git worktree ・ ターミナル ・ エージェント CLI を置き換えるものではない。OS を再起動すればプロセスは終わる。残るのは記録である。

---

## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [CommandMate のしくみ](../user-guide/how-it-works.md) | 長い版: 実測、機能一覧、ユースケース、対応エージェント、セキュリティ、Vibe Engineering ワークフロー |
| [チュートリアル](../user-guide/tutorial.md) | サンプルリポジトリを fork し、契約から検証済みの成果物までを 15 分ほどで体験する |
| [クイックスタート](../user-guide/quick-start.md) | どのエージェントでも回る契約と検証の最小ループと、5 分の開発フロー |
| [CLI セットアップガイド](../user-guide/cli-setup-guide.md) | インストール、`npx`、初期設定、アップデート、ソースからのビルド |
| [CLI 操作ガイド](../user-guide/cli-operations-guide.md) | CLI からのセッション操作: 実行契約、検証ゲート、Skill、エージェントインスタンス |
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
