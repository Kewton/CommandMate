# `tests/fixtures/opencode-web-2052/`

Issue #2052 (Epic #2055 Phase 4) の spike で採った実測証拠。**この Issue は設計書だけが成果物で、
production コードは 1 行も変えていない。** これらのファイルは
[`docs/design/opencode-server-live-verification.md`](../../../docs/design/opencode-server-live-verification.md)
の **§24** が引用する一次証拠であり、テストランナーからは参照されない（`grep -rn 'opencode-web-2052' src tests`
は本 README と §24 以外に当たらない）。後続の実装 Issue が同じ計測をやり直さずに済むように置いてある。

対象: **opencode 1.18.22** / CommandMate `develop` @ `ceb1059d`（2026-08-26 実測）。

## ファイル

| ファイル | 何の証拠か |
|---|---|
| `spa-shell.html` | `opencode serve` の `GET /` が返す 2884 B の SPA シェル。`opencode web` の `GET /` と**バイト一致**。参照アセットが全て絶対パスであることがここで読める |
| `network-direct-4852.txt` | 素の origin で UI を開いたときの Chromium ネットワークログ。SSE は `/global/event`、WebSocket は 0 件 |
| `network-proxied-3052.txt` | `/proxy/oc/` 越しに開いたときのネットワークログ。SPA のファイルが 1 つも読めていない |
| `console-proxied-3052.log` | 同じくコンソール。`/assets/...` の 404 と MIME 拒否 |
| `screenshot-direct-4852.png` | 素の origin: UI が起動している |
| `screenshot-proxied-3052.png` | `/proxy/oc/` 越し: 真っ白 |
| `probe-proxy-paths.txt` | proxy が `/proxy/<prefix>` を**書き換えずに**上流へ渡すこと、その結果 opencode の全パスが SPA シェルに落ちること |
| `probe-proxy-sse-ws.txt` | proxy が SSE を**バッファせずに流す**こと、**WebSocket も通す**こと（陰性対照 403 / 404 つき） |
| `probe-cors-auth.txt` | `--cors` 無しの許可 origin 集合、`OPENCODE_SERVER_PASSWORD` の認証方式、それが proxy 越しに落ちること |

## 再現手順

隔離は設計書 §4「再現環境（ハーネス）」そのまま。**`HOME` ごと差し替える**こと
（差し替えないと `~/.local/share/opencode/opencode.db` を汚す）。本 spike で足したのは
「CommandMate 側も隔離して立てる」部分だけ。

```bash
SP=/path/to/scratchpad
mkdir -p "$SP"/{home/.local/share/opencode,home/.config/opencode,work,logs,capture}

umask 077; cp ~/.local/share/opencode/auth.json "$SP/home/.local/share/opencode/auth.json"; umask 022
cat > "$SP/home/.config/opencode/opencode.jsonc" <<'JSON'
{ "$schema": "https://opencode.ai/config.json", "model": "github-copilot/claude-sonnet-4.6" }
JSON
( cd "$SP/work" && git init -q && echo hello > README.md \
  && git add -A && git -c user.email=a@b -c user.name=a commit -qm init )

# opencode 側（4852 = serve, 4853 = web, 4855 = パスワードつき）
cd "$SP/work"
HOME="$SP/home" opencode serve --port 4852 --hostname 127.0.0.1 --print-logs --log-level INFO &
curl -sS http://127.0.0.1:4852/path     # home/state/config/worktree/directory が全て $SP 配下か確認

# CommandMate 側（3052）。本番の 3000 と本番 DB を絶対に踏まないこと:
#   - シェルに CM_PORT=3000 / CM_DB_PATH=<本番> / NODE_ENV=production が export されている
#   - CM_DB_PATH は /tmp 配下を拒否する（db-path-resolver のシステムディレクトリガード）ので
#     env -u CM_DB_PATH で worktree 既定の ./data/cm.db（gitignore 済）に落とす
cd <this worktree>
env -u CM_DB_PATH NODE_ENV=development CM_PORT=3052 CM_BIND=127.0.0.1 \
    CM_ROOT_DIR="$SP/cmroot" WORKTREE_REPOS="" npx tsx server.ts &

curl -sS -X POST http://127.0.0.1:3052/api/external-apps -H 'Content-Type: application/json' -d '{
  "name":"opencode-web-2052","displayName":"OpenCode Web (spike 2052)","pathPrefix":"oc",
  "targetHost":"127.0.0.1","targetPort":4852,"appType":"other",
  "websocketEnabled":true,"enabled":true}'
# ExternalAppCache の TTL は 30 秒。登録直後の proxy 参照は 404 を返すので待ってから撃つこと。
```

TUI を混ぜる検証は**必ず専用 socket** で（`-L` / `-S` は `$TMUX` より優先される）:

```bash
tmux -L cmate-2052-web new-session -d -s oc-web -x 200 -y 60 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color opencode attach http://127.0.0.1:4852"
tmux -L cmate-2052-web kill-session -t '=oc-web:'   # kill-server は使わない
```

後始末: opencode / CommandMate / echo upstream を PID 指定で kill、`$SP/home/.local/share/opencode/auth.json`
を削除、External App レコードを消す（本 spike の DB はこの worktree の `data/cm.db` で gitignore 済）。
