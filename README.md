# MyCodeBranchDesk

> 「入力待ちを見逃さない、開発の相棒。」
> 「軽量。その場で完結。Claude Codeを、どこからでも動かす。」

![PC表示](./docs/images/screenshot-desktop.png)

## これは何か

Git worktree ごとに Claude Code / Codex / Gemini CLI セッションを管理し、ブラウザから指示を送れる開発コンパニオンツールです。

通勤中・育児中・昼休み――メールに返信する感覚で「次の指示」を出し、個人開発を前に進められます。

## 何ではないか

- ターミナルの代替ではありません。Claude Code を**補完**するツールです
- CLI の全機能を再現するものではなく、「入力待ち/未確認を見逃さず、すぐ指示を出す」ことに特化しています

## 想定ユーザー

Claude Code での開発経験があり、本業の傍らで個人開発を続けたい方。

## 主な機能

- **入力待ち/未確認検知** — サイドバーでリアルタイムにステータス表示（idle/ready/running/waiting）
- **ブラウザから指示送信** — スマホ・PCどちらからでもチャットUIで操作
- **チャット履歴・メモ** — ブランチごとの会話履歴を保持、メモ機能付き
- **Markdownログビューア** — Claude の詳細出力をMarkdownで閲覧
- **ファイルビュー** — ワークツリー内のファイルをブラウザから確認
- **Auto Yes モード** — 確認ダイアログ付きで自動承認を制御
- **マルチCLIツール対応** — Claude Code / Codex CLI / Gemini CLI を切替可能
- **レスポンシブUI** — デスクトップは2カラム、モバイルはタブベースで最適表示

![スマホ表示](./docs/images/screenshot-mobile.png)

## Quick Start

### 前提条件

- macOS / Linux（tmux 依存のため Windows は非対応）
- Node.js v20+、git、tmux
- Claude CLI（CLAUDE_HOOKS_STOP 対応）

### セットアップ

```bash
git clone https://github.com/Kewton/MyCodeBranchDesk.git
cd MyCodeBranchDesk
npm install
cp .env.example .env   # MCBD_ROOT_DIR を編集
npm run db:init
npm run build
npm start
```

ブラウザで http://localhost:3000 にアクセスしてください。

スマホから利用する場合は `.env` で `MCBD_BIND=0.0.0.0` と `MCBD_AUTH_TOKEN` を設定し、同一LAN内から `http://<PCのIP>:3000` にアクセスします。

## FAQ

**Q: どこまでローカルで動く？**
A: アプリ本体・DB・セッションはすべてローカルで完結します。外部通信は Claude CLI 自体の API 呼び出しのみです。

**Q: Cloudflare 依存は何？**
A: 外出先からアクセスしたい場合に Cloudflare Tunnel を利用できます。必須ではありません。

**Q: Claude Code の権限はどうなる？**
A: Claude Code 自体の権限設定がそのまま適用されます。本ツールが権限を拡張することはありません。詳しくは [Trust & Safety](./docs/TRUST_AND_SAFETY.md) を参照してください。

**Q: Windows で使える？**
A: 現時点では非対応です。tmux に依存しているため macOS / Linux が必要です。WSL2 上での動作は未検証です。

**Q: Codex CLI / Gemini CLI はどこまで動く？**
A: 基本的なセッション管理と指示送信は対応しています。ただし Stop フック等の一部機能は CLI ツールの対応状況に依存します。

**Q: 複数人で使える？**
A: 現時点では個人利用を想定しています。複数人での同時利用は未対応です。

## ドキュメント

| ドキュメント | 説明 |
|-------------|------|
| [コンセプト](./docs/concept.md) | ビジョンと解決する課題 |
| [アーキテクチャ](./docs/architecture.md) | システム設計 |
| [デプロイガイド](./docs/DEPLOYMENT.md) | 本番環境構築手順 |
| [UI/UXガイド](./docs/UI_UX_GUIDE.md) | UI実装の詳細 |
| [クイックスタート](./docs/user-guide/quick-start.md) | Claude Codeコマンドの使い方 |
| [Trust & Safety](./docs/TRUST_AND_SAFETY.md) | セキュリティと権限の考え方 |

## Contributing

バグ報告・機能提案・ドキュメント改善を歓迎します。詳しくは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## License

[MIT License](./LICENSE) - Copyright (c) 2025 Kota Maeno
