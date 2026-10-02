[English](../en/user-guide/troubleshooting.md)

# トラブルシューティング & FAQ

README から移したものです（Issue #3061）。インストール時のエラー（`command not found`・`EACCES`・
ポートや依存関係の確認）は [CLI セットアップガイド](./cli-setup-guide.md#トラブルシューティング)、
エージェント操作系コマンドの終了コードと失敗は [CLI 操作ガイド](./cli-operations-guide.md#トラブルシューティング)
を参照してください。

---

## Claude CLI が見つからない / パスが変わった？

Claude CLI の npm 版とスタンドアロン版を切り替えるとパスが変わることがあります。CommandMate は次のセッション起動時に自動検出します。カスタムパスを設定するには `.env` に `CLAUDE_PATH=/path/to/claude` を追加してください。

## ポート競合？

```bash
commandmate start -p 3001
```

## セッションが固まっている / 応答がない？

CommandMate 自身のコマンドで確認できます（tmux セッション名は自動で解決されます）：

```bash
# 各 worktree のエージェントの状態と、動いている tmux セッション名
commandmate ls
commandmate ls --json | jq -r '.[] | "\(.id)\t\(.tmuxSession)"'

# attach せずに transcript を読む
commandmate capture <worktree-id> --pane --tail 60
commandmate capture <worktree-id> --pane --follow    # 生成中の応答を追う

# この端末を attach（detach は Ctrl+b → d）
commandmate attach <worktree-id>
commandmate attach <worktree-id> --live              # 端末サイズへ再レイアウト（claude のみ）
```

**素の `tmux attach` が空白に見える理由。** CommandMate のセッションは、状態検出が十分な履歴を
`capture-pane` で取れるように 200 桁 × 1000 行のキャンバスに固定されています。alt-screen の
エージェント（claude / opencode / copilot）は transcript をその上端に、入力欄を下端に描き、
tmux はカーソルを追従表示します。したがって普通のサイズの端末では**入力欄と空白しか見えず、
会話は一行も見えません**。壊れているわけではありません。読むには上記の `capture --pane`、
attach 中なら `prefix + g`、あるいは `attach --live` で窓を端末に合わせてください。

attach せずに tmux 側から見る：

```bash
tmux ls -F '#{session_name} #{@cm_status} #{@cm_tool}/#{@cm_instance}'

# 壊れたセッションを手動で削除（`=name:` は完全一致。zsh は素の `=` を食うのでクォート必須）
tmux kill-session -t '=mcbd-claude-feature-123:'
```

> **注意：** アタッチ中にセッション内で直接入力すると、CommandMate のセッション管理と干渉する可能性があります。`Ctrl+b` → `d` で detach し、CommandMate UI から操作してください。

## Claude Code 内から起動するとセッション開始に失敗する？

Claude Code は `CLAUDECODE=1` を設定してネストを防止しています。CommandMate は自動で除去しますが、問題が続く場合は `tmux set-environment -g -u CLAUDECODE` を実行してください。

## FAQ

**Q: スマホからどうやって使う？**
A: `commandmate remote` を実行してください。1 コマンドで、認証を有効にしたサーバーの起動・公開・QR コードの表示までを行います。スマホのカメラで QR を読めばサインイン完了です。QR に入っているペアリングコードは **1 回限り**で、既定では 10 分で失効します。

```bash
commandmate remote          # 起動 + 公開 + ペアリング（QR）
commandmate remote status   # Provider・URL・期限・ペアリング状態
commandmate remote stop     # 外への口を閉じる（サーバーは止めない）
```

[`tailscale`](https://tailscale.com/) か [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) のインストールが必要です。Cloudflare Quick Tunnel は `https://<random>.trycloudflare.com` というアドレスを公開インターネットに置くため、`commandmate remote` は作る前に警告して確認を求めます。非対話シェルでは「はい」とみなさずに拒否するので、意図して公開するときは `--yes` を付けてください。使える Provider が無い場合は、より露出の大きい手段に切り替えず、依存エラーで止まります。`CM_BIND` の設定はそのまま（サーバーは `127.0.0.1` に bind したまま）で、`remote` はその前に口を 1 つ足すだけです。詳しくは [Webアプリ操作ガイド → モバイルからのアクセス](./webapp-guide.md#モバイルからのアクセス) を参照してください。

**Provider ツールを入れたくない場合**は LAN 内に留める方法もあります。`commandmate init` で外部アクセスを有効にすると `CM_BIND=0.0.0.0` が設定されるので、同じ Wi-Fi のスマホから `http://<PCのIPアドレス>:3000` を開いてください。**これは CommandMate を認証なし・暗号化なしで配信するということです。** そのネットワークにいる誰でも、何も聞かれずに URL を開き、あなたのリポジトリ・ターミナル・エージェントを操作できます。信頼できるネットワークでだけ使い、共用やゲストの Wi-Fi では使わず、終わったら `CM_BIND` を `127.0.0.1` に戻してください。

**Q: 外出先からアクセスできる？**
A: はい。組み込みの方法は上の `commandmate remote` です。Tailscale なら tailnet 上の自分の端末から、Cloudflare Quick Tunnel ならインターネットのどこからでも届き、どちらにも CommandMate はトークン認証つきで応答します。Cloudflare の URL は公開されているので、他人を締め出しているのは URL ではなくペアリングコードだと考えてください。

トンネルを自分で用意する場合は、次のどれでも使えます：

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — 無料、Cloudflare アカウントが必要
- [ngrok](https://ngrok.com/) — 無料枠あり、セットアップが簡単
- [Pinggy](https://pinggy.io/) — サインアップ不要、SSH ベースのシンプルなトンネル

VPN や認証付きリバースプロキシ（Basic 認証、OIDC 等）も利用可能です。**認証なしでインターネットに直接公開しないでください。** 詳しくは [セキュリティガイド](../security-guide.md) を参照してください。

**Q: iPhone / Android で使える？**
A: はい。CommandMate の Web UI はレスポンシブ対応で、Safari・Chrome などのモバイルブラウザで動作します。アプリのインストールは不要です。最低対応バージョンは [Webアプリ操作ガイド](./webapp-guide.md#3-対応ブラウザ) にあります。

**Q: tmux は必須？**
A: CommandMate は内部で tmux を使用して CLI セッションを管理しています。ユーザーが tmux を直接操作する必要はありません。

**Q: Claude Code の権限はどうなる？**
A: Claude Code 自体の権限設定がそのまま適用されます。本ツールが権限を拡張することはありません。詳しくは [Trust & Safety](../TRUST_AND_SAFETY.md) を参照してください。

**Q: 複数人で使える？**
A: 現時点では個人利用を想定しています。複数人での同時利用は未対応です。
