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

## 履歴の先頭に、codex / vibe-local の起動画面の吹き出しが残っている？

以前の版では、codex と vibe-local の起動画面（`>_ OpenAI Codex (v…)` や vibe-local のバナー）が、返答の行として履歴に保存されていました（Issue #3293 で止めました）。既に保存された行は自動では消しません。消すときは、リポジトリの clone（`npm install` 済み）で次の手順を実行してください。`sqlite3` コマンドを使います（macOS には入っています）。

**必ずサーバーを止めてから行ってください。** DB は WAL モードで、書き込みの一部は `cm.db-wal` にあります。`cp` で `cm.db` だけを写すと、その分が抜けた写しになり、件数が本体と違ったり、復元で履歴が欠けたりします。バックアップと復元は、SQLite のバックアップ機能（`.backup`）で行います。WAL の内容も含んだ、単独で整合したファイルができます。

```bash
# 1. サーバーを止める
commandmate stop

# 2. バックアップを取る（DB の場所: グローバルインストールは ~/.commandmate/data/cm.db、
#    CM_DB_PATH を設定していればその値）
DB=~/.commandmate/data/cm.db
sqlite3 "$DB" ".backup '$DB.bak-3335'"

# 3. 写しで試す。バックアップから試行用の写しを作り、dry-run と --apply を写しに対して行う
sqlite3 "$DB.bak-3335" ".backup '/tmp/cm-3335-try.db'"
node scripts/cleanup-startup-banner-rows.mjs --db /tmp/cm-3335-try.db
node scripts/cleanup-startup-banner-rows.mjs --db /tmp/cm-3335-try.db --apply

# 4. 本体で dry-run（既定）。DB は読み取り専用で開き、候補の件数と id だけを出す。
#    件数と id が 3 と同じであることを確かめる
node scripts/cleanup-startup-banner-rows.mjs --db "$DB"

# 5. 本体で --apply。候補だけを消す
node scripts/cleanup-startup-banner-rows.mjs --db "$DB" --apply

# 6. サーバーを起動する
commandmate start --daemon
```

- 候補は、codex / vibe-local の `assistant` 行のうち、次をすべて満たす行だけです: 転写の保存が付ける `request_id` が無い／利用者の発言のエコーを含まない／中身が起動画面の行だけで、返答の本文が無い／保存した経路の形（色の制御文字が残っている、または直後の発言のちょうど 1 ms 前の時刻）に合う
- 起動画面の文字はあるが条件に合わない行は「left」として id と理由（`keyed-row`・`holds-echo`・`has-body`・`no-path-match`）だけを出し、消しません。必要なら中身を見て判断してください
- 元に戻すときは、サーバーを止めてから、バックアップを本体へ戻します: `sqlite3 "$DB" ".restore '$DB.bak-3335'"`

## アップデート後に DB を migration の前へ戻したい？

起動時に DB の migration（スキーマの更新）が 1 本以上残っていると、CommandMate は**最初の migration の前に** DB の複製を作ります（Issue #3985）。新しい版の DB は古い版の CommandMate では開けないため、アップデートを戻すときは、実行ファイルと一緒にこの複製を戻します。

- **作られる条件:** 未適用の migration があるときだけ。最新の版の DB、新規に作った DB（表がまだ無い）では作りません
- **置き場所:** DB と同じディレクトリの `db-backups/`（グローバルインストールは `~/.commandmate/data/db-backups/`、`CM_DB_PATH` を設定していればその隣）。ディレクトリは 0700、ファイルは 0600
- **名前:** `<DB のファイル名>.v<元の版>-to-v<目標の版>.<UTC の時刻>.<短い ID>.sqlite`（例: `cm.db.v61-to-v62.20261029T010203456Z.1a2b3c4d.sqlite`）。作成中のファイルは `.partial` で終わり、完了済みとは見なしません
- **世代:** 完了済みを 3 つまで残します。古いものは、新しい複製の確認が済んだ後にだけ消します
- **中身:** SQLite の `VACUUM INTO` で作る、WAL の確定済みの内容も含んだ一時点の複製です。作った後に `integrity_check` と版を確かめます
- **失敗したとき:** 複製を作れない・確かめられないときは、migration を始めずに起動を止めます。空き容量が足りないなどで複製を省いて起動するときは `CM_DB_SKIP_MIGRATION_BACKUP=1` を設定します（既定は省きません）

**戻すと、複製を取った後の更新（会話の履歴・設定の変更など）は失われます。** 戻す手順:

```bash
# 1. サーバーを止める
commandmate stop

# 2. 戻す複製を選ぶ（DB の場所: グローバルインストールは ~/.commandmate/data/cm.db、
#    CM_DB_PATH を設定していればその値）
DB=~/.commandmate/data/cm.db
ls -l "$(dirname "$DB")/db-backups/"

# 3. 今の DB を念のため退避してから、複製を DB の場所へ戻し、-wal と -shm を消す
mv "$DB" "$DB.before-restore"
cp "$(dirname "$DB")/db-backups/cm.db.v61-to-v62.<時刻>.<ID>.sqlite" "$DB"
chmod 600 "$DB"
rm -f "$DB-wal" "$DB-shm"

# 4. 複製と同じ版の CommandMate に戻してから起動する
commandmate start --daemon
```

- `-wal`・`-shm` を残したまま戻すと、別の DB の WAL が複製に重なり、壊れる・更新が混ざる原因になります。必ず消してください
- 複製は単独で整合したファイルなので、`cp` で戻せます（サーバーが止まっていることが前提です）

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
