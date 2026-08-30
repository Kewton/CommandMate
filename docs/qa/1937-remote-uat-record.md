# 実機確認記録: `commandmate remote`（QR ペアリング / Epic #1937 R12）

**本書は記録であって手順書ではない。** 対象は Issue #1937 の R1〜R11（develop 着地済み）が
実機で何をしたかであり、設計上どうなっているはずかではない。設計は
[docs/design/remote-qr-pairing-1937.md](../design/remote-qr-pairing-1937.md)、
利用者向け手順は [webapp-guide.md](../user-guide/webapp-guide.md) と
[cli-operations-guide.md](../user-guide/cli-operations-guide.md) にある。

書き方のルール（[2002-push-uat-record.md](./2002-push-uat-record.md) に倣う）:

1. **実施 1 回につき §3 以降に 1 節を足す。** 過去の節は書き換えない（訂正は新しい節に書き、
   古い節から `→ 訂正: §N` と 1 行で指す）。
2. **未実施を「合格」と書かない。** 表の既定値は `未実施` で、埋めるのは実際に実行した人だけ。
   ユニットテストが緑であることは、この表のどの行の根拠にもならない。
3. **不成立は §3.6 の形（事象 → 実測 → 原因 → 影響 → 直し方）で書く。**
   「動かなかった」だけでは次の Issue が書けない。
4. **ペアリングコードとセッショントークンを本書に書かない。** 生ログは
   `dev-reports/issue/1937/uat/evidence/`（追跡対象外）に伏字化して置く。

---

## 1. 現況

| 対象 | 最新の実施 | 判定 |
|---|---|---|
| A. Cloudflare Quick Tunnel | 2026-08-29（§3.3）／再確認 2026-08-29（§6） | **全項目合格**。実施 1 回目は公開 URL の疎通が不合格（D-1）だったが、#2148 の修正を実物の cloudflared で再確認して解消（§6.5） |
| B. Tailscale Serve | 2026-08-29（§3.4） | **全項目合格**（非破壊確認・パス占有時の拒否を含む） |
| C. 終了時の後始末 | 2026-08-29（§3.5） | **合格** |
| スマホ実機（QR 読取 → PWA → Push） | **未実施** | — （§4 のチェックリストを人間が実施する） |

**この 1 回の実施で分かったいちばん大きいこと**:

- **`commandmate remote --provider cloudflare` は現状スマホから使えない。**
  `cloudflared` が `commandmate remote` の終了と同時に死に、払い出された公開 URL が
  即座に HTTP 530 になる（**D-1**、§3.6）。原因は Provider 側の spawn 形（stderr を
  パイプに繋いだまま親が `process.exit()` する）で、変異実験で確定させた。
  **→ #2148 で修正され、§6 の実機再確認で合格した**（`up` 返却後 t+22.6／+56.7／+60.3 秒で非 530、`stop` 後 2.3 秒で 530）。
- **Tailscale Serve は実装も非破壊性も期待どおり動く。** 利用者自身の serve マッピングを
  1 本も壊さず、CommandMate が作った 1 本だけを撤去する。
- **利用者ドキュメントが R3 の着地に追いついていない。** 4 ファイルが今も
  「Tailscale は未実装のスタブ」と書いている（**D-5**）。

---

## 2. 実施記録テンプレート（コピーして使う）

> 以下をそのまま複製し、`## N. 実施 M 回目（YYYY-MM-DD）` のように節を起こす。
> **このテンプレート節自体は埋めないこと。**

```markdown
## N. 実施 M 回目（YYYY-MM-DD）

### N.1 実施環境と隔離

| 項目 | 値 |
|---|---|
| 実施日 | YYYY-MM-DD HH:MM〜HH:MM（TZ） |
| 実施者 | @github-id |
| OS / arch | |
| サーバ版 | `/api/app/update-check` の `currentVersion`（`--version` は CLI の版なので不可） |
| ブランチ / commit | |
| `cloudflared` / `tailscale` の版 | |
| 隔離インスタンスのポート / DB / HOME | |
| 隔離が効いていることの証拠 | 隔離側と本番側の `/api/worktrees` 件数 |

### N.2 開始時スナップショット（触ってはいけないものの控え）

| 項目 | 開始時 |
|---|---|
| 既存 named tunnel（`cloudflared`） | pid= / etime= |
| `tailscale serve status --json` | |
| 稼働 tmux `mcbd-*` セッション数 | |
| 本番 `http://127.0.0.1:3000/` | |

### N.3 A. Cloudflare Quick Tunnel

| # | 確認内容 | 実行 | 実測 | 判定 |
|---|---|---|---|---|
| A-0 | 公開前の明示承認 | | | 合格 / 不合格 / 未実施 |
| A-1 | `remote up` | | | |
| A-2 | 公開 URL の疎通 | | | |
| A-3 | 未認証クライアントの遮断 | | | |
| A-4 | WebSocket | | | |
| A-5 | `remote status` に秘匿値が出ない | | | |
| A-6 | `remote stop` 後に URL 失効 | | | |
| A-7 | 既存 named tunnel の生存 | | | |

### N.4 B. Tailscale Serve

| # | 確認内容 | 実行 | 実測 | 判定 |
|---|---|---|---|---|
| B-1 | 利用者役マッピングの作成 | | | |
| B-2 | `remote up --provider tailscale` | | | |
| B-3 | tailnet 内疎通 / インターネットに出ない | | | |
| B-4 | 未認証遮断 / WS / ペアリング | | | |
| B-5 | **`remote stop` の非破壊**（利用者役が残る） | | | |
| B-6 | 占有済みパスへの `up` が拒否される | | | |
| B-7 | 検証用マッピング撤去後 `{}` | | | |

### N.5 C. 終了時の後始末

| 項目 | 終了時 | 開始時と一致 |
|---|---|---|
| `tailscale serve status --json` | | |
| 既存 named tunnel | | |
| tmux `mcbd-*` セッション数 | | |
| 本番 3000 | | |
| 隔離インスタンス / 使い捨て DB・HOME | | |

### N.6 不成立の記録

なし ／ あれば 1 件 1 ブロックで「事象 → 実測 → 原因 → 影響 → 直し方」。

### N.7 気づき（次の Issue の種）

- 手順書のほうを直すべき点
- 仕様として決め直すべき点
- **合格だが気になった点**（合否表に入らないので、ここに書かないと消える）
```

---

## 3. 実施 1 回目（2026-08-29）

### 3.1 実施環境と隔離

| 項目 | 値 |
|---|---|
| 実施日 | 2026-08-29 17:20〜17:47（JST） |
| 実施者 | Claude Code（@Kewton の環境で実行）。スマホ操作は含まない |
| OS / arch | macOS 26.6.2（25G83）/ arm64、Node v24.1.0 |
| サーバ版 | **0.28.0**（隔離インスタンスの `/api/app/update-check` の `currentVersion`） |
| ブランチ / commit | `docs/1937-r12-uat`（`fde8f5ee` = develop の R3 着地直後） |
| `cloudflared` | 2025.4.0 |
| `tailscale` | 1.102.3（`BackendState: Running` / `CertDomains: [maenomac-studio.taile4f402.ts.net]`） |

**隔離インスタンス**（本番を晒さないため、使い捨てを 1 台立てた）:

| 項目 | 値 |
|---|---|
| ポート | `3210`（本番は 3000。`3211` は手動 tunnel の metrics 用） |
| DB | `<work>/home/.commandmate/data/uat.db`（新規作成。本番 DB には**一度も書いていない**） |
| `HOME` | `<work>/home`（`~/.commandmate/.env` が明示 env を上書きするため必須） |
| cwd（＝`getConfigDir()`） | `<work>/inst`（`.env` / PID / `remote.json` / ペアリングハンドオフはすべてここ） |
| `WORKTREE_REPOS` | 使い捨ての空リポジトリ 1 本のみ |
| 起動 | `env -u CM_PORT -u CM_BIND -u CM_DB_PATH -u CM_ROOT_DIR -u WORKTREE_REPOS HOME=<work>/home node <worktree>/bin/commandmate.js …` |

`<work>` は `/Users/maenokota/.commandmate-uat-1937r12`。**scratchpad（`/private/tmp` 配下）は使えない** —
`validateDbPath()` が `/tmp` を system directory として拒否し、サーバが
`Invalid CM_DB_PATH: Security error: DB path cannot be in system directory` で DB を開けず
`/api/worktrees` が 500 になる。最初にそこで 1 度躓いたので記録しておく。

**隔離が効いていることの確認（公開する前に実施）**:

```
隔離 GET http://127.0.0.1:3210/api/worktrees → 200 / worktrees = 1
    ["/Users/maenokota/.commandmate-uat-1937r12/repos/uat-sandbox"]
本番 GET http://127.0.0.1:3000/api/worktrees → 200 / worktrees = 68
本番 http://127.0.0.1:3000/ → 200（稼働継続）
```

さらに**公開後**にも、tunnel 越しの認証済み `GET /api/worktrees` が
`worktrees = 1` / `uat-sandbox` を返すことを確認した（§3.3 A-5b・§3.4 B-4d）。
**tunnel の向き先が隔離インスタンスであって本番ではないことの、いちばん強い証拠はこれ。**

### 3.2 開始時スナップショット（触ってはいけないものの控え）

| 項目 | 開始時（17:20 JST） |
|---|---|
| 既存 named tunnel | `pid=819` / `etime=09-16:08:38` / `cloudflared tunnel run --token …`（launchd 常駐、利用者自身のサービス） |
| `tailscale serve status --json` | `{}` |
| 稼働 tmux `mcbd-*` セッション数 | **27** |
| 本番 `http://127.0.0.1:3000/` | 200（worktrees 68） |

### 3.3 A. Cloudflare Quick Tunnel

| # | 確認内容 | 判定 |
|---|---|---|
| A-0 | 公開 Tunnel の明示承認（非対話 + `--yes` 無し） | **合格** |
| A-1 | `remote up`（Provider 選択・認証つきサーバ起動・URL 払い出し・状態記録） | **合格** |
| A-1b | 認証つきで稼働中のサーバに対する `up` の拒否 | **合格** |
| A-2 | **公開 URL の疎通** | **不合格（D-1）** |
| A-3 | 未認証クライアントの遮断（API） | **合格** |
| A-4 | WebSocket（未認証不可 / 認証済み可） | **合格** |
| A-5 | `remote status` にコードもトークンも出ない | **合格** |
| A-6 | `remote stop` 後に公開 URL が失効する | **合格**（D-1 のため 2 段構えで確認。下記） |
| A-7 | 既存 named tunnel（pid 819）の生存 | **合格** |

#### A-0 公開前の明示承認

```
$ commandmate remote --provider cloudflare -p 3210     # 非対話・--yes なし
[✓] Provider: cloudflare-quick
[ERROR] Creating a public Quick Tunnel requires explicit approval.
        Re-run with --yes to approve it, or use --provider tailscale.
exit 2 (CONFIG_ERROR)
```

このあと `cloudflared` プロセスは pid 819（利用者の named tunnel）**1 本のみ**、
ポート 3210 に listener 無し。**承認前には tunnel もサーバも作られない。**
※ 対話 TTY での y/n プロンプト自体は PTY を使っていないため未実施（§4 の C-1）。

#### A-1 `remote up`

```
$ commandmate remote --provider cloudflare --yes --expires 1h --pairing-expires 20m -p 3210 --json
[✓] Provider: cloudflare-quick
[✓] Server: http://127.0.0.1:3210 (pid 39644)
[✓] URL: https://bay-passenger-aaron-unto.trycloudflare.com
{ "action": "up", "provider": "cloudflare-quick",
  "url": "https://bay-passenger-aaron-unto.trycloudflare.com",
  "pairingUrl": ".../login#code=<26文字>",
  "expiresAt": "2026-08-29T09:28:12.000Z",
  "pairing": { "expiresAt": "2026-08-29T08:48:03.911Z" },
  "server": { "pid": 39644, "port": 3210, "url": "http://127.0.0.1:3210" } }
exit 0
```

**`server.port` が 3210 であること（3000 でないこと）を、これ以上先へ進む前に確認した。**
ここが 3000 になっていたら Provider は本番を公開する。

状態ファイル `<work>/inst/remote.json`（mode 0600）に
`handle.owned = { pid: <cloudflared>, revert: null }` / `preexisting: null` が記録される。

#### A-1b 認証つきサーバが既に動いているとき

```
$ commandmate remote --provider cloudflare --yes -p 3210
[✓] Provider: cloudflare-quick
[ERROR] A CommandMate server is already running with authentication enabled (PID: 17013).
[INFO] Its token was fixed at startup and CommandMate did not keep the plaintext, …
[INFO] Stop it with "commandmate stop" and run "commandmate remote" again.
```

tunnel は作られない。**合格。**

#### A-2 公開 URL の疎通 — **不合格**

```
$ curl -o /dev/null -w '%{http_code}' https://bay-passenger-aaron-unto.trycloudflare.com/
530
```

`remote up` が返した直後にはもう 530。詳細と原因は §3.6 の **D-1**。

#### A-3〜A-6 の実測方法についての但し書き

D-1 のため CLI が作った tunnel は生きていない。A-3 以降は
**`buildQuickTunnelArgs()` と同一の argv**（`cloudflared tunnel --url http://127.0.0.1:3210
--no-autoupdate --metrics 127.0.0.1:3211 --pidfile <path>`）で手動起動した Quick Tunnel を
隔離インスタンスの前に置いて実測した。**サーバ側の受入条件（遮断・WS・ペアリング）は
これで正しく測れる。測れないのは Provider の寿命だけで、それが D-1 そのものである。**

#### A-3 未認証クライアントの遮断（tunnel 越し）

| リクエスト | 実測 | 備考 |
|---|---|---|
| `GET /login` | **200** | 認証除外パス。ペアリング画面が出るべき経路なので 200 が正 |
| `GET /api/worktrees`（ヘッダ無し） | **307** → `location: https://localhost:3210/login` | データは 1 バイトも返らない。リダイレクト先は D-2 |
| `GET /api/worktrees`（`Authorization: Bearer <偽>`） | **401** `{"error":"Unauthorized"}` | |
| `GET /api/worktrees`（`Cookie: cm_auth_token=<偽>`） | **307** → `/login` | |
| `GET /api/sessions`（ヘッダ無し） | **307** → `/login` | |

**200 が返った未認証リクエストは 1 件も無い。合格。**
受入条件は「401/403 になること」だが、ブラウザ形のリクエストは `src/middleware.ts` の設計どおり
**307 リダイレクト**（CLI 形＝`Authorization` つきだけが 401 JSON）。**遮断はされているので合格とし、
ステータスの内訳をここに残す。**

#### A-4 WebSocket（tunnel 越し）

| クライアント | Upgrade 応答 |
|---|---|
| Cookie 無し | **401**（`socket.destroy()` 前に `HTTP/1.1 401` を書いて切断） |
| ペアリングで得た Cookie | **101 Switching Protocols** |
| 1 文字改竄した Cookie | **401** |

**合格。**

#### A-5 ペアリングと `remote status`

| # | 実行 | 実測 |
|---|---|---|
| A-5a | `POST /api/remote/pair`（誤ったコード） | **401** `{"error":"Invalid pairing code."}` |
| A-5b | `POST /api/remote/pair`（正しいコード） | **200** `{"success":true}` + `Set-Cookie: cm_auth_token=…; Path=/; Max-Age=3494; HttpOnly; SameSite=strict`（**`Secure` は付かない** → D-3） |
| A-5c | 同じコードで再送 | **410** `{"error":"Pairing is no longer available."}` = **一度きり** |
| A-5d | Cookie つき `GET /api/worktrees` | **200** / `worktrees = 1` / `uat-sandbox`（＝本番ではない） |
| A-5e | ペアリング後のハンドオフファイル | **消滅**（`<work>/inst/remote-pairing.json` が無い） |

```
$ commandmate remote status
[INFO] Provider:        cloudflare-quick
[INFO] URL:             https://bay-passenger-aaron-unto.trycloudflare.com
[INFO] Remote expires:  2026-08-29T09:28:12.000Z (in 58m)
[INFO] Pairing:         consumed
[INFO] Server:          running (pid 39644, http://127.0.0.1:3210, auth: on)
```

出力を**実際のトークン文字列・実際のペアリングコードと文字列比較**して、いずれも
含まれないことを確認（`contains session token: False` / `contains pairing code: False` /
`'code=' in output: False`）。**合格。**

#### A-6 `remote stop` 後の URL 失効

2 段構えで確認した。

1. **CLI が記録した session に対する `remote stop`**:
   ```
   $ commandmate remote stop --json
   { "action": "stop", "cleaned": true, "provider": "cloudflare-quick",
     "skipped": [], "warnings": [], "error": null }   exit 0
   $ curl -o /dev/null -w '%{http_code}' https://bay-passenger-aaron-unto.trycloudflare.com/
   530
   ```
   状態ファイルとペアリングハンドオフが消え、サーバは動いたまま。
   ただし D-1 のため URL は `stop` の前から 530 だったので、**これだけでは「stop が失効させた」証拠にならない。**
2. **生きている tunnel に対して、`cloudflareQuickProvider.stop()` が撃つのと同じ SIGTERM**:
   ```
   before SIGTERM : GET /api/worktrees (認証済み) → 200
   kill -TERM <cloudflared pid>
   t+2s           : GET /api/worktrees → 530
   ```
   **SIGTERM から 2 秒以内に公開 URL が 530 になる。** `stop()` の実装はこの SIGTERM 1 発だけなので、
   これが「`remote stop` 後に URL が失効する」の実測にあたる。**合格。**

#### A-7 既存 named tunnel

セクション A の全操作を通じて `pid=819` は生存（`etime` が単調増加し再起動していない）。
`cloudflared` プロセスは常に本数を数え、CommandMate 由来のもの以外を止めていない。**合格。**

### 3.4 B. Tailscale Serve

| # | 確認内容 | 判定 |
|---|---|---|
| B-1 | 「利用者の既存設定」役のマッピング作成 | 前提（成功） |
| B-2 | `remote up --provider tailscale` | **合格** |
| B-2b | `--provider` 無しで Tailscale が優先される | **合格** |
| B-3 | tailnet 内疎通 / インターネットに出ない | **合格** |
| B-4 | 未認証遮断 / WS / ペアリング（Serve 越し） | **合格** |
| B-5 | **`remote stop` の非破壊**（利用者役が残る） | **合格** |
| B-6 | 占有済みパスへの `up` が拒否される | **合格** |
| B-7 | 検証用マッピング撤去後 `serve status --json` が `{}` | **合格** |

#### B-1 「利用者の既存設定」役

```
$ tailscale serve --bg --https=443 --set-path /r12-existing-user 'text:R12 existing user handler'
Available within your tailnet:
https://maenomac-studio.taile4f402.ts.net/r12-existing-user
|-- text  "R12 existing user..."
To disable the proxy, run: tailscale serve --https=443 off     ← D-4
```

```json
{"TCP":{"443":{"HTTPS":true}},
 "Web":{"maenomac-studio.taile4f402.ts.net:443":
   {"Handlers":{"/r12-existing-user":{"Text":"R12 existing user handler"}}}}}
```

#### B-2 / B-2b `remote up`

```
$ commandmate remote --provider tailscale --yes -p 3210 --expires 1h --pairing-expires 20m --json
[✓] Provider: tailscale-serve
[✓] URL: https://maenomac-studio.taile4f402.ts.net
exit 0
```

```json
{"TCP":{"443":{"HTTPS":true}},
 "Web":{"maenomac-studio.taile4f402.ts.net:443":{"Handlers":{
   "/":                  {"Proxy":"http://127.0.0.1:3210"},
   "/r12-existing-user": {"Text":"R12 existing user handler"}}}}}
```

**2 本が共存する。** CommandMate は `/` を、利用者役は `/r12-existing-user` を保持。

`--provider` を付けずに `commandmate remote --yes -p 3210 --json` を実行しても
`"provider": "tailscale-serve"` が選ばれ、**新しい `cloudflared` は 1 本も起きなかった**
（`cloudflared` は pid 819 のみ）。**「Tailscale が優先される」「勝手に公開 Tunnel へ落ちない」の実測。**

状態ファイルには、`owned` と `preexisting` が分けて記録される:

```json
"owned": { "pid": null,
           "revert": {"maenomac-studio.taile4f402.ts.net:443/": "http://127.0.0.1:3210"} },
"preexisting": { "keys": ["maenomac-studio.taile4f402.ts.net:443/r12-existing-user"], "raw": {…} }
```

#### B-3 tailnet の中に閉じていること

| 確認 | 実測 |
|---|---|
| `dig +short maenomac-studio.taile4f402.ts.net A` | `100.86.0.12`（CGNAT 100.64.0.0/10 = tailnet 内アドレス） |
| `tailscale funnel status` | `https://maenomac-studio.taile4f402.ts.net **(tailnet only)**` |

**Serve はインターネットに出ない。** `tailscale funnel` は本 UAT では一度も実行していない。

#### B-4 Serve 越しの遮断・WS・ペアリング

| # | リクエスト | 実測 |
|---|---|---|
| B-4a | `GET /`（未認証） | 307 → `https://localhost:3210/login`（D-2） |
| B-4b | `GET /api/worktrees`（未認証 / `Authorization` つき） | 307 / **401** `{"error":"Unauthorized"}` |
| B-4c | WS Upgrade（Cookie 無し / ペアリング後の Cookie） | **401** / **101** |
| B-4d | `POST /api/remote/pair`（正しいコード）→ Cookie つき `GET /api/worktrees` | 200 + `Set-Cookie` → **200 / worktrees = 1 / uat-sandbox** |
| B-4e | `GET /r12-existing-user`（利用者役） | **200** `R12 existing user handler`（CommandMate と同居しても壊れない） |

#### B-5 `remote stop` の非破壊 — **本セクションの本体**

```
$ commandmate remote stop --json
{ "action": "stop", "cleaned": true, "provider": "tailscale-serve",
  "skipped": [], "warnings": [], "error": null }
```

```json
{"TCP":{"443":{"HTTPS":true}},
 "Web":{"maenomac-studio.taile4f402.ts.net:443":
   {"Handlers":{"/r12-existing-user":{"Text":"R12 existing user handler"}}}}}
```

**CommandMate が作った `/` だけが消え、利用者役の `/r12-existing-user` は残った**
（`GET /r12-existing-user` → 200 で内容も同じ）。CommandMate の URL は 404（`/` ハンドラ無し）。
サーバは動いたまま。**合格。**

#### B-6 占有済みパスへの `up`

利用者役として `/`（CommandMate が使いたいパス）を先に押さえた状態で `up` を実行:

```
$ commandmate remote --provider tailscale --yes -p 3210
[✓] Provider: tailscale-serve
[✓] Server: http://127.0.0.1:3210 (pid 26481)
[ERROR] Provider tailscale-serve failed to start: tailscale-serve:
        maenomac-studio.taile4f402.ts.net:443/ is already served (by an existing handler).
        CommandMate will not overwrite a handler it did not create;
        remove it yourself, or free the path first.
exit 3 (START_FAILED)
```

- `serve status --json` は **拒否の前後でバイト単位まで同一**（Python で dict 比較 → `True`）
- 拒否のために起動していたサーバは**ロールバックで停止**（`Status: Stopped` / 3210 に listener 無し）

**「CommandMate が作成していない設定を削除しない」を、削除側（B-5）と作成側（B-6）の両方で確認した。**

#### B-7 後始末

```
$ tailscale serve --https=443 --set-path / off
$ tailscale serve --https=443 --set-path /r12-existing-user off
$ tailscale serve status --json
{}
```

`reset` / `clear` / `drain` / `set-config --all` は一度も実行していない。

### 3.5 C. 終了時の後始末

| 項目 | 開始時（17:20） | 終了時（17:47） | 一致 |
|---|---|---|---|
| `tailscale serve status --json` | `{}` | **`{}`** | ✅ |
| `tailscale funnel status` | — | `No serve config` | ✅ |
| 既存 named tunnel | pid 819 / etime 09-16:08:38 | **pid 819 / etime 09-16:32:56**（同一プロセス） | ✅ |
| `cloudflared` プロセス総数 | 1 | **1** | ✅ |
| 残留 Quick Tunnel | — | **NONE** | ✅ |
| tmux `mcbd-*` セッション数 | 27 | **27** | ✅ |
| 本番 `http://127.0.0.1:3000/` | 200 / worktrees 68 | **200 / worktrees 68** | ✅ |
| ポート 3210 / 3211 | 空き | **空き** | ✅ |
| 隔離インスタンス / 使い捨て DB・HOME | — | **削除済み**（`<work>` ごと `rm -rf`） | ✅ |

本 UAT が本番インスタンスに対して行ったのは `GET /` と `GET /api/worktrees` のみ（読み取り専用）。
検証用に立てた私設 tmux サーバ（`tmux -L uat1937r12`）も削除済みで、
共有 tmux サーバの `mcbd-*` セッションには一度も触れていない。

### 3.6 不成立の記録

#### D-1（**不合格**）Cloudflare Quick Tunnel が `commandmate remote` の終了と同時に死ぬ

→ 訂正: §6（**#2148 で修正済み。2026-08-29 に実物の cloudflared で再確認し合格**。以下は修正前の実測としてそのまま残す）

- **事象**: `remote up` が払い出した公開 URL が、コマンドが返った直後にはもう HTTP 530
  （Cloudflare Tunnel error）。**QR を読む時間が無い。**
- **実測 1（プロセスの寿命）**: `remote up` を長命な shell（私設 tmux セッション）の中で実行し、
  0.5 秒間隔で `cloudflared` を観測した:

  | 時刻（JST） | 状態 |
  |---|---|
  | 17:28:03.7 | NONE |
  | 17:28:05.5 | ALIVE pid=40775 |
  | **17:28:12.5** | **NONE** |

  `up` の `startedAt` は `08:28:12.000Z` = **17:28:12 JST**。
  **CLI が終了した瞬間に子プロセスが消えている。** 対話 shell が生きていても死ぬので、
  ハーネス由来の現象ではない。
- **実測 2（自然死ではない）**: **まったく同じ argv**（`--pidfile` 込み）で `cloudflared` を
  spawn し、親を 70 秒生かしたまま観測 → 子は 70 秒間生存し、`--pidfile` も正しく書かれた。
  つまり cloudflared 自身が数秒で落ちているのではない。
- **原因（変異実験で確定）**: `src/lib/remote/cloudflare.ts:451` の spawn 形。

  ```ts
  const child = deps.spawn(CLOUDFLARED_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  ```

  親が `process.exit()` すると **stderr パイプの読み口が閉じ**、cloudflared（Go）が次に
  fd 2 へ書いた時点で SIGPIPE で終了する。`detached: true` も `child.unref()` も無い。

  | 変異 | 親の終了タイミング | 子の生死 |
  |---|---|---|
  | **A**: `stdio: ['ignore','ignore','pipe']`（出荷形） | 起動 6.5 秒後（＝`up` が終わるのと同じ、ログが噴いている最中） | **2 秒以内に死亡** |
  | **B**: `stdio: ['ignore','ignore','ignore']` | 同上 | **生存**（10 秒観測して生存、SIGTERM で後始末） |
  | A | 起動 12 秒後（ログの噴出が収まった後） | 生存（12 秒観測） |

  **A と B の差が原因の証明**であり、A の 6.5 秒版と 12 秒版の差が
  「最初の観測では生き残ったように見えた」理由。`up` は URL を metrics API から
  約 6.5 秒で取って終了するので、**実運用ではちょうど噴出中に当たる。**
- **影響**: `commandmate remote`（既定）および `--provider cloudflare` は、
  **Tailscale が使えない環境では実質使えない**。受入条件
  「`commandmate remote` だけで Remote セットアップを開始できる」が Cloudflare 経路で満たせない。
  Tailscale Serve Provider は `owned.pid` を持たない（設定であってプロセスではない）ので影響しない。
- **直し方（案）**: URL を取り終えた時点で子の stderr を切り離す（`child.stderr.destroy()` では
  なく、そもそも `--logfile` かファイル記述子に向ける）か、`stdio` の 3 番目を `'ignore'` にして
  診断は `--loglevel` + `--logfile` から読む。あわせて `detached: true` + `child.unref()` を付け、
  CLI のプロセスグループから外す。**`stop()` は `owned.pid` への SIGTERM なので、
  detach しても撤収は今のまま成立する。**
- **回帰テストの案**: 単体では捕まらない（`deps.spawn` がモックされるため）。
  「spawn オプションに `detached: true` があり、stderr が `'pipe'` でない」ことを
  `buildQuickTunnelArgs()` と同じ粒度で固定するか、実プロセスを使う統合テストにする。

#### D-2（要修正・中）未認証リダイレクト先が内部ホスト（`https://localhost:3210/login`）になる

- **事象**: tunnel 越しの未認証リクエストが `307` で
  `location: https://localhost:3210/login` に飛ばされる。**スマホからは到達不能な URL。**
- **実測**: Cloudflare Quick Tunnel でも Tailscale Serve でも同じ
  （どちらの Provider も upstream の Host に書き換えて転送するため）。
- **影響**: 主導線は壊れない — QR が指すのは `/login#code=…` の**直リンク**で、`/login` は
  認証除外パスなので 200 が返る。壊れるのは「公開 URL のルートを先に開いた」場合と、
  ペアリング前に任意の画面 URL を開いた場合。
- **直し方（案）**: `src/middleware.ts` のリダイレクト URL を `X-Forwarded-Host` /
  `X-Forwarded-Proto` から組む。ただし**これらは前段が信頼できるときだけ**なので、
  `CM_TRUST_PROXY` の扱いと合わせて設計が要る（無条件に信じるとオープンリダイレクトになる）。
  相対 `Location`（`/login`）に落とすだけでも直る。

#### D-3（観察・仕様どおり）ペアリングで発行される Cookie に `Secure` が付かない

- **実測**: `Set-Cookie: cm_auth_token=…; Path=/; Max-Age=3494; HttpOnly; SameSite=strict`
  （curl の cookie jar でも secure 列 = `FALSE`）。
- これは `buildAuthCookieOptions()` が `CM_HTTPS_CERT` を見る仕様の結果で、
  [webapp-guide.md](../user-guide/webapp-guide.md) にも「正しい挙動」として書かれている（U-6）。
  **設計どおりだが、実測として残す。** tunnel の外側は HTTPS なので経路上の露出は無い。

#### D-4（観察・ドキュメント案件）tailscale 自身が案内する `off` は当該ポートを全消しする

- **実測**: `tailscale serve` の成功時メッセージが
  `To disable the proxy, run: tailscale serve --https=443 off` と案内する。
  この形（`--set-path` を伴わない `off`）は **443 のハンドラを全部消す**（R3 の実測どおり）。
- CommandMate は常に `--set-path` つきの `off` を撃つので影響しないが、
  **利用者が案内どおりに打つと、利用者自身の他のマッピングまで消える。**
- **直し方（案）**: `remote up`（tailscale）の出力に「撤収は `commandmate remote stop` を使うこと。
  tailscale が案内する `serve --https=443 off` はポート全体を消す」の 1 行を足す。

#### D-5（要修正・ドキュメント）R3 の着地後もドキュメントが「Tailscale は未実装」と書いている

- **実測**: 本 UAT で Tailscale Serve Provider は**実際に動いた**（§3.4）。にもかかわらず:

  | ファイル | 行 | 記述 |
  |---|---|---|
  | `docs/user-guide/webapp-guide.md` | 421 | 「CommandMate が使う Provider は現在 **Cloudflare Quick Tunnel のみ**です」 |
  | `docs/user-guide/webapp-guide.md` | 432-433 | 「**Tailscale はまだ使えません。** …中身は未実装のスタブで、実行すると `DEPENDENCY_ERROR`（exit 1）になります」 |
  | `docs/user-guide/webapp-guide.md` | 496 | 「`--provider tailscale` はすべての OS で使えません（未実装のスタブのため）」 |
  | `docs/user-guide/cli-operations-guide.md` | 2496 | 「`tailscale-serve` … **未実装のスタブ**。`detect()` は常に `available: false` を返し…」 |
  | `docs/TRUST_AND_SAFETY.md` | 42 | 「Tailscale を CommandMate が代行して設定する Provider（`tailscale-serve`）は**未実装**です」 |
  | `CLAUDE.md` | 278 | 「`--provider cloudflare`   # Provider 指定（tailscale は未実装）」 |

- **原因**: R11（docs、`72814d91` 他）が R3（`fde8f5ee`）より先に着地したため。
  設計の依存図では `R11 → R12` だが、**R3 は R11 と並列で走っていて docs に反映されていない。**
- **影響**: 受入条件「セキュリティガイドとユーザーガイドが更新される」は、
  **現状の記述が出荷物と食い違っている**ため満たしていない。
  D-1 と合わせると被害が大きい —「Cloudflare しか使えない」と書かれた唯一の Provider が動かず、
  実際に動く Provider は「使えません」と書かれている。
- **直し方**: 上表の 6 箇所を R3 の実測に合わせて書き換える。
  §3.4 の OS 表（`webapp-guide.md:486-490`）の「公開 Tunnel の疎通」列も、
  macOS 行を本記録の結果（Cloudflare ✗ / Tailscale ✅）で埋める。
  **本 Issue（R12）は `docs/qa/**` と `dev-reports/**` しか触れない契約なので、
  修正は別 Issue に切る。**

### 3.7 気づき（次の Issue の種）

- **`remote status` は Provider が生きているかを確認しない。** D-1 の状況で
  `remote status` は URL を「有効」であるかのように表示し続けた（`expired: false`）。
  Cloudflare なら `owned.pid` の生存確認、Tailscale なら `serve status --json` に
  自分のキーが在るかの確認が、1 行で足せる。**D-1 に利用者が自力で気づけるかを分ける。**
- **`--pidfile` が使われていない。** `start()` は `--pidfile` を渡すが、
  `stop()` も `status` も読まない（`owned.pid` を使う）。読むようにすれば上の生存確認が安く済む。
- **`CM_DB_PATH` は `/tmp` 配下を拒否する。** UAT ハーネスを scratchpad に組もうとすると
  必ず躓く（§3.1）。使い捨て環境の作り方をどこかに 1 行書いておくと次回が速い。
- **合格だが気になった点**: `remote up` は `runStart` の進捗行（dotenv のヒント行を含む）を
  そのまま stdout に出すので、`--json` でも純 JSON ストリームにならない。
  実装コメントに明記されている既知の割り切りだが、`--json` を機械が食う前提なら
  `--quiet` か stderr への振り分けが要る。

---

## 4. スマホ実機チェックリスト（**人間が実施する。本記録の実施 1 回目では未実施**）

実デバイスが要るため R12 の自動実行では触れていない。**以下を埋めるまで、
Issue #1937 の受入条件のうち §5 で「未実施」と書いた行は閉じられない。**

### 4.0 前提

- **D-1 が直るまで Cloudflare 経路では実施できない**（URL が即失効するため QR を読む時間が無い）。
  **先に Tailscale 経路で実施すること**（スマホを同じ tailnet に入れる必要がある）。
- 実施は**使い捨てインスタンス**に対して行う（§3.1 の隔離手順。本番 3000 を公開しない）。
- 記録欄には「合格 / 不合格 / 未実施」と、**実際に見た文言・スクリーンショット・時刻**を書く。

### 4.1 チェックリスト

| # | 手順 | 期待結果 | 対応する受入条件 | 結果 | 記録欄（実測） |
|---|---|---|---|---|---|
| P-1 | PC で `commandmate remote --provider tailscale --yes -p <port>` を実行 | 端末に QR が表示され、その下に「Scan this with your phone. The code works once, and only until it expires.」が出る | `remote` だけで開始できる | 未実施 | |
| P-2 | 端末幅を 40 桁程度まで狭めて P-1 を再実行 | QR の代わりに「This terminal is too narrow…」と **URL がテキストで**出る | （QR レンダラの折返し） | 未実施 | |
| P-3 | スマホのカメラで QR を読む | `/login#code=…` が開き、**ペアリング中である旨の表示**が出る | QR 読取でペアリング画面が開く | 未実施 | |
| P-4 | そのまま待つ | **トークンを 1 文字も入力せずに**ログインが完了し、アプリ画面に入る | トークンを手入力せず接続できる | 未実施 | |
| P-5 | 同じ QR をもう一度読む（別端末でも可） | ペアリングが**拒否**される（`410`／画面に失効の旨） | ペアリングコードは一度だけ | 未実施 | |
| P-6 | `--pairing-expires 2m` で起動し、3 分待ってから QR を読む | 拒否される。PC 側 `remote status` は `Pairing: expired` | 設定時間後に失効する | 未実施 | |
| P-7 | スマホで worktree 一覧・ターミナル画面を開き、エージェントに 1 行送る | 一覧が出て、**ターミナルがリアルタイムに更新される**（＝WS が張れている） | 認証済みスマホから API と WS | 未実施 | |
| P-8 | ペアリングしていない別のスマホ／シークレットタブで同じ URL を開く | ログイン画面から先へ進めない。API も WS も通らない | 未認証端末から API/WS 不可 | 未実施 | |
| P-9 | スマホの「ホーム画面に追加」で PWA として追加し、起動する | スタンドアロン表示で起動し、ログイン状態が維持されている | （PWA 導線） | 未実施 | |
| P-10 | PWA で通知を許可し、エージェントを要対応状態にする | Push 通知が届く（VAPID 設定が要る。[#2123](https://github.com/Kewton/CommandMate/issues/2123) 参照） | （Push 導線／#2002 系） | 未実施 | |
| P-11 | PC で `commandmate remote stop` を実行し、スマホを再読み込み | **つながらなくなる**（tailnet URL が 404／tunnel URL が 530） | `remote stop` で終了できる | 未実施 | |
| P-12 | P-11 の後、スマホの PWA から操作を試す | 操作できない | 停止時に一時認証情報が失効する | 未実施 | |
| C-1 | PC の**対話ターミナル**で `commandmate remote --provider cloudflare`（`--yes` なし） | 公開の警告文が出て y/n を訊かれ、**n で何も作られない** | 公開 Tunnel 前に説明と明示承認 | 未実施 | 自動実行では非対話経路（exit 2）のみ確認済み（§3.3 A-0） |
| O-1 | Linux（ベアメタル）で §3.3 / §3.4 を実施 | — | macOS/Linux/WSL2 の対応可否 | 未実施 | R11 の表は docker コンテナでの検出のみ |
| O-2 | WSL2 で §3.3 / §3.4 を実施 | — | 同上 | 未実施 | `127.0.0.1` が WSL2 内部か Windows 側かが構成依存 |

### 4.2 記録の書き方

実施したら **§3 と同じ形で新しい節（`## 6. 実施 2 回目（YYYY-MM-DD）`）を起こし**、
上の表をそこへ複製して埋める。**§4 の表そのものは空のまま残す**（チェックリストの原本なので）。

---

## 5. 受入条件の充足状況（2026-08-29 時点）

Issue #1937 の受入条件 20 項目に対する、**本記録だけを根拠にした**判定。

| # | 受入条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `commandmate remote` だけで Remote セットアップを開始できる | **部分**（Tailscale ✅ / Cloudflare ✗） | §3.4 B-2 ／ **D-1** |
| 2 | Tailscale が利用可能な場合、Tailscale Serve が優先される | **合格** | §3.4 B-2b |
| 3 | Tailscale が利用できない場合、公開 Tunnel 作成前に説明と明示承認 | **合格（非対話）／対話 y/n は未実施** | §3.3 A-0 ／ §4 C-1 |
| 4 | QR コードをスマホで読み取るとペアリング画面が開く | **未実施** | §4 P-3。QR の表示（23 行 × 45 桁）と `/login` の 200 は確認済み |
| 5 | 利用者が認証トークンを手入力せずに接続できる | **合格（プロトコル）／実機は未実施** | §3.3 A-5b・§3.4 B-4d ／ §4 P-4 |
| 6 | ペアリングコードは**一度だけ**使用できる | **合格** | §3.3 A-5c（再送 410） |
| 7 | ペアリングコードは設定時間後に失効する | **合格** | `--pairing-expires 2m` で 2 分後に `Pairing: expired`、その後の `POST` が **410**（401 ではない＝失効判定が検証より先） |
| 8 | QR／ペアリング URL に長期認証トークンが含まれない | **合格** | URL に載るのは 26 文字の一度きりコードのみ。セッショントークンは `Set-Cookie` でしか出ない。ハンドオフファイル（mode 0600）のキーは `expiresAt` / `pairingHash` / `sessionToken` で**コードの平文は持たない**。旧 `QrCodeGenerator.tsx` は R7 で削除済み（ファイル不在を確認） |
| 9 | 認証済みスマホから HTTP API と WebSocket を利用できる | **合格（クライアント一般）／実機スマホは未実施** | §3.3 A-4/A-5d・§3.4 B-4c/B-4d ／ §4 P-7 |
| 10 | **未認証端末から API と WebSocket へアクセスできない** | **合格** | §3.3 A-3/A-4・§3.4 B-4b/B-4c。**200 が返った未認証リクエストは 0 件** |
| 11 | `CM_BIND` の既定を壊さない | **合格** | `remote` 稼働中の `lsof` が `TCP 127.0.0.1:3210 (LISTEN)` のみ（`*:3210` / `0.0.0.0:3210` 無し）。稼働サーバの env に `remote` が足したのは `CM_AUTH_TOKEN_HASH` / `CM_AUTH_EXPIRE` / `CM_REMOTE_PAIRING_FILE` の 3 つだけで **`CM_BIND` は含まない**。Serve の proxy 先も `http://127.0.0.1:3210` |
| 12 | `remote status` で Provider・URL・有効期限・接続状態を確認できる | **合格** | §3.3 A-5。`Pairing:` は `unused` → `consumed` / `expired` の 3 状態を実測 |
| 13 | `commandmate remote stop` で Remote 接続を終了できる | **合格** | §3.3 A-6・§3.4 B-5 |
| 14 | 停止時に一時認証情報が失効する | **合格** | `stop` 後にハンドオフファイル（唯一のトークン平文）が消滅、Provider の口も閉じる |
| 15 | **CommandMate が作成していない Tailscale／Tunnel 設定を削除しない** | **合格** | §3.4 B-5（撤収側）・B-6（作成側）。既存 named tunnel pid 819 も全工程で無傷 |
| 16 | Quick Tunnel のプロセス終了後に一時 URL が利用できなくなる | **合格** | §3.3 A-6。SIGTERM から 2 秒以内に 530 |
| 17 | Remote 利用時の Auto Yes は既定で無効になる | **合格** | 稼働サーバの env に Auto-Yes 関連キーが 1 つも無い（`grep -c 'AUTO_YES\|AUTOYES'` = 0）。`remote` に有効化フラグも無い |
| 18 | 既存 QR ログイン（#383）の扱いが決定され、記録される | **合格** | 決定 A（撤去）が設計 §2 に記録済み。`src/components/auth/QrCodeGenerator.tsx` と同テストの不在を確認 |
| 19 | セキュリティガイドとユーザーガイドが更新される | **不合格** | **D-5**。6 箇所が「Tailscale は未実装のスタブ」のまま |
| 20 | macOS／Linux／WSL2 について対応可否と制約が明記される | **部分** | macOS の「公開 Tunnel の疎通」を本記録で確定（Cloudflare ✗ / Tailscale ✅）。表への反映は D-5 の修正に含める。**Linux（ベアメタル）と WSL2 は未実施**（§4 O-1 / O-2） |

**未充足のまま残るもの**:

1. **D-1**（受入条件 1 / 16 の Cloudflare 側）— 修正が要る。**これが最優先。**
   → 訂正: §6（#2148 で修正され、実機で合格。受入条件 1 は Cloudflare 側も満たすようになった）
2. **D-5**（受入条件 19、および 20 の表の更新）— ドキュメント修正が要る。
3. **受入条件 4 / 5 / 9 の実機部分**（§4 P-1〜P-12）— 人間がスマホで実施しないと閉じられない。
4. **受入条件 20 の Linux（ベアメタル）／WSL2**（§4 O-1 / O-2）— 検証環境が要る。
5. **受入条件 3 の対話 y/n**（§4 C-1）— 対話ターミナルでの目視が要る。

**D-2 / D-3 / D-4 は受入条件の可否を左右しない**が、D-2 は実機の体験に効くので
§4 の実施前に直しておくと P-3 以降が測りやすい。

---

## 6. 実施 2 回目（2026-08-29）— **#2146（PR #2148）の修正を実物の cloudflared で再確認**

**この節が扱うのは §3.3 の A-2（公開 URL の疎通）＝ §3.6 の D-1 だけ。** 他の行は再測定していない
（§3 の判定はそのまま生きている）。§4 のスマホチェックリストも未実施のまま。

**なぜ 1 点だけを測り直したか**: PR #2148 は cloudflared の fd 2 をパイプではなく**ファイル記述子**へ
向け、`detached: true` + `unref()` を併用する修正で、回帰テスト
（`tests/unit/lib/remote/cloudflare-child-survival.test.ts`）は**stand-in プロセス**で
「親の終了後も子が生きる」を固定している。**stand-in は cloudflared ではない。**
D-1 は Go ランタイムの SIGPIPE 挙動に依存した不具合なので、実物で測らないと閉じられない。

### 6.1 実施環境と隔離

| 項目 | 値 |
|---|---|
| 実施日 | 2026-08-29 20:19〜20:26（JST） |
| 実施者 | Claude Code（@Kewton の環境で実行）。スマホ操作は含まない |
| OS / arch | macOS 26.6.2（25G83）/ arm64、Node v24.1.0 |
| サーバ版 | **0.28.0**（隔離インスタンスの `/api/app/update-check` の `currentVersion`） |
| ブランチ / commit | `docs/2146-live-verify`（`6b66e3b0` = develop の **#2148 着地直後**） |
| `cloudflared` | 2025.4.0（`--version` 実測。§3 と同一） |
| `tailscale` | **触っていない**（本確認に不要。コマンドを 1 度も実行していない） |

**隔離インスタンス**（本番 3000 は worktree 70 本・tmux 29 セッションを抱えている。晒さない）:

| 項目 | 値 |
|---|---|
| ポート | `3210`（本番は 3000） |
| `CM_DB_PATH` | `<work>/home/.commandmate/data/uat.db`（新規作成。本番 DB には**一度も書いていない**） |
| `HOME` | `<work>/home` |
| cwd（＝`getConfigDir()`） | `<work>/inst`（`.env` / PID / `remote.json` はここ。`cloudflared.pid` と `cloudflared.log` は `resolveStateDir()` が `homedir()` を見るので `<work>/home/.commandmate/`） |
| `WORKTREE_REPOS` | `<work>/repos/uat-sandbox`（使い捨ての空リポジトリ 1 本） |
| ラッパ | `cd <work>/inst && env -u CM_PORT -u CM_BIND -u CM_DB_PATH -u CM_ROOT_DIR -u WORKTREE_REPOS HOME=<work>/home node <worktree>/bin/commandmate.js "$@"` |

`<work>` は `/Users/maenokota/.commandmate-uat-2146v`。§3.1 と同じ理由で **scratchpad（`/private/tmp` 配下）は使えない**。

**隔離が効いていることの確認（`remote up` を実行する前のゲート）**:

```
隔離 GET http://127.0.0.1:3210/api/worktrees → 200 / worktrees = 1
    ["/Users/maenokota/.commandmate-uat-2146v/repos/uat-sandbox"]
本番 GET http://127.0.0.1:3000/api/worktrees → 200 / worktrees = 70
```

**件数が一致したら `up` を実行しない**と決めて臨み、1 対 70 で不一致を確認してから公開した。
公開後にも tunnel 越しの認証済み `GET /api/worktrees` が `worktrees = 1` / `uat-sandbox` を
返すことを確認している（6.3 の A-2d）。**tunnel の向き先が隔離インスタンスであることの一番強い証拠はこれ。**

### 6.2 開始時スナップショット（触ってはいけないものの控え）

| 項目 | 開始時（20:19 JST） |
|---|---|
| 既存 named tunnel | `pid=819` / `etime=09-19:09:04`（launchd 常駐、利用者自身のサービス。**シグナルを送っていない**） |
| `cloudflared` プロセス総数（`ps -o comm= -ax \| grep -c 'cloudflared$'`） | **1** |
| 稼働 tmux `mcbd-*` セッション数 | **29** |
| 本番 `http://127.0.0.1:3000/` | 200（worktrees 70） |

プロセス数は `comm`（バイナリ名）で数えている。`pgrep -f 'cloudflared'` は**検査文字列を自分の argv に
含むシェル自身にマッチする**ので使わない。

### 6.3 A-2 の再測定 — **合格**

実行した argv（1 回だけ）:

```
cd <work>/inst && env -u CM_PORT -u CM_BIND -u CM_DB_PATH -u CM_ROOT_DIR -u WORKTREE_REPOS \
  HOME=<work>/home node <worktree>/bin/commandmate.js \
  remote --provider cloudflare --yes --expires 1h --pairing-expires 20m -p 3210 --json
```

| 事象 | 時刻（JST） | 実測 |
|---|---|---|
| `remote up` 開始 | 20:24:08.988 | |
| cloudflared が URL を払い出し | 20:24:13（`cloudflared.log`） | `https://percentage-weblogs-postcard-bin.trycloudflare.com` |
| **`remote up` が返った** | **20:24:14.161** | exit 0 / 所要 5.17 秒 / `server = { pid: 61156, port: 3210 }` |

**`server.port` が 3210（3000 でない）ことを、公開 URL に触る前に確認した。**

#### A-2a `remote up` が返った**後**の公開 URL（本題）

| # | 時刻（JST） | `up` 返却からの経過 | パス | HTTP |
|---|---|---|---|---|
| 1 | 20:24:36.776 | **t+22.62s** | `/` | **307** |
| 2 | 20:24:37.0 | t+約22.8s | `/login` | **200** |
| 3 | 20:25:10.865 | **t+56.70s** | `/` | **307** |
| 4 | 20:25:10.941 | t+56.78s | `/login` | **200** |
| 5 | 20:25:14.411 | **t+60.25s** | `/` | **307** |
| 6 | 20:25:14.484 | t+60.32s | `/login` | **200** |

**6 点すべてで 530 ではない。** `/` の 307 は未認証リダイレクト（既知の **D-2**、`location` が
内部ホストになる件）で、`/login` の 200 は認証除外パス。**どちらも「tunnel が生きている」ことを示す。**
§3.3 A-2 では**同じ `/` への curl が `up` 返却直後にすでに 530** だったので、
これは D-1 の直接の反証にあたる。

> **測定の但し書き（隠さず書く）**: 最初の probe は計画では「返却直後」だったが、実際は **t+22.62 秒**に
> なった。ドライバスクリプトが `remote up` の stdout から JSON を抜くのに貪欲な `\{.*\}` を使っていて、
> 先行する dotenv のヒント行（`{ path: ... }` を含む）に食いついて例外で落ち、URL を取り直してから
> 手で撃ち直したため。**修正前は返却時点ですでに死んでいた**ので、t+22.6 秒での生存は
> 「返却直後の生存」より弱い主張ではない。ただし t+0〜22 秒の間は測っていない。

#### A-2b 子プロセスの生存

| 項目 | 実測 |
|---|---|
| `remote.json` の `handle.owned.pid` | `61399` |
| `ps -o pid=,etime=,comm= -p 61399`（t+約60s） | `61399 01:00 cloudflared` = **生存**（etime 1 分） |
| `cloudflared` プロセス総数（公開中） | **2**（`819`＝利用者の named tunnel、`61399`＝Quick Tunnel） |

#### A-2c fd 2 がファイルであることの直接証拠

修正で新設された `<work>/home/.commandmate/cloudflared.log`（28 行、3414 バイト、mode 0600）:

```
2026-08-29T11:24:10Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-08-29T11:24:13Z INF |  https://percentage-weblogs-postcard-bin.trycloudflare.com  |
2026-08-29T11:24:14Z INF Registered tunnel connection connIndex=0 … location=nrt16
        ← ここで親（commandmate remote）が 20:24:14.161 に終了。以降 60 秒間ログは静か
2026-08-29T11:25:14Z INF Initiating graceful shutdown due to signal terminated ...
2026-08-29T11:25:14Z INF Tunnel server stopped
2026-08-29T11:25:14Z INF Metrics server stopped
```

**親の終了から 60 秒後（`11:25:14Z` = 20:25:14 JST）に、同じ fd 2 へ書き込みが起きている。**
出荷前の `stdio: ['ignore','ignore','pipe']` ではこの行は存在しえない
（その時点でプロセスは SIGPIPE で死んでいる）。**ファイル化と detach が実物で効いている。**

#### A-2d tunnel の向き先が隔離インスタンスであること（公開中に実測）

| 実行 | 実測 |
|---|---|
| `POST <公開URL>/api/remote/pair`（`up` が出したコード） | **200**（`Set-Cookie` でトークン受領） |
| Cookie つき `GET <公開URL>/api/worktrees` | **200** / `worktrees = 1` / `uat-sandbox` |

**本番（70 本）ではない。** ペアリングコードとトークンは本書に書かない（生ログは
`dev-reports/issue/2146/uat/evidence/` に伏字化して置いた）。

#### A-2e `remote stop` 後の失効

```
$ commandmate remote stop --json     # 20:25:14.701
{ "action": "stop", "cleaned": true, "provider": "cloudflare-quick",
  "skipped": [], "warnings": [], "error": null }   exit 0
```

| 時刻（JST） | `stop` からの経過 | パス | HTTP |
|---|---|---|---|
| 20:25:16.956 | stop+2.26s | `/` | **530** |
| 20:25:24.971 | stop+10.27s | `/` | **530** |
| 20:25:34.783 | stop+20.08s | `/` | **530** |
| 20:25:34.841 | stop+20.14s | `/login` | **530** |

**修正は「消えない tunnel」を作っていない。** §3.3 A-6 が SIGTERM を手で撃って測った失効を、
今回は `remote stop` そのもので測れた（D-1 が直ったので 2 段構えが要らなくなった）。
`remote.json` と `remote-pairing.json` はどちらも消えている。

**公開していた時間は約 61 秒**（URL 払い出し 20:24:13 → `stop` 20:25:14）。

### 6.4 C. 終了時の後始末

| 項目 | 開始時（20:19） | 終了時（20:26） | 一致 |
|---|---|---|---|
| `cloudflared` プロセス総数（comm ベース） | 1 | **1** | ✅ |
| 既存 named tunnel | pid 819 / etime 09-19:09:04 | **pid 819 / etime 09-19:16:35**（同一プロセス、単調増加＝再起動していない） | ✅ |
| 残留 Quick Tunnel | — | **NONE** | ✅ |
| tmux `mcbd-*` セッション数 | 29 | **29** | ✅ |
| 本番 `http://127.0.0.1:3000/` | 200 / worktrees 70 | **200 / worktrees 70** | ✅ |
| ポート 3210 | 空き | **空き**（隔離サーバも停止済み） | ✅ |
| 隔離インスタンス / 使い捨て DB・HOME | — | **削除済み**（`<work>` ごと `rm -rf`） | ✅ |

本確認が本番インスタンスに対して行ったのは `GET /` と `GET /api/worktrees` のみ（読み取り専用）。
`tailscale` 系コマンド・`tmux kill-server`・他の `mcbd-*` セッションには一度も触れていない。
本番の `.next` / `dist` も上書きしていない（ビルドは worktree
`commandmate-issue-2146v` 内で完結）。

### 6.5 判定

| # | 確認内容 | 判定 |
|---|---|---|
| A-2 | **`remote up` が返った後も公開 URL が応答する** | **合格**（t+22.6 / +56.7 / +60.3 秒の 3 時点 × 2 パスすべてで非 530） |
| A-6 | `remote stop` 後に公開 URL が失効する | **合格**（stop+2.3 秒で 530、+20 秒でも 530） |
| A-7 | 既存 named tunnel（pid 819）の生存 | **合格** |
| — | 本番 3000 / `mcbd-*` の無傷 | **合格** |

**総合: 合格。** §3.6 の **D-1 は #2148（`6b66e3b0`）で解消**していることを、stand-in ではなく
**実物の cloudflared 2025.4.0** で確認した。

### 6.6 気づき（次の Issue の種）

- **`cloudflared.log` は `remote stop` で消えない。** 状態ファイル（`remote.json` /
  `remote-pairing.json`）と `cloudflared.pid` は片付くのに、ログだけが `HOME/.commandmate/` に残る。
  診断のために残すのは妥当だが、**次の `up` で追記なのか切り詰めなのかは本確認では測っていない**。
  「1 セッションぶんだけ残る」ことを期待するなら明示が要る。
- **`cloudflared.pid` も残る。** 中身は死んだ pid（`61399`）。`status` はこれを読まないので実害は無いが、
  §3.7 の「`--pidfile` を読むようにすれば生存確認が安い」を実装するなら、**古い pidfile を掴まない
  手当（`stop` での削除、または `remote.json` の pid との突合）が同時に要る**。
- **状態ファイルの置き場が 2 つに割れている。** `remote.json` は `getConfigDir()`（＝ローカル導入では cwd）、
  `cloudflared.pid` / `cloudflared.log` は `resolveStateDir()`（＝`homedir()/.commandmate`）。
  同じ「1 つの remote セッションの状態」が cwd と HOME に分かれるので、
  隔離環境を組むときに両方を差し替える必要がある（本確認でも一度探した）。
- **`--json` は今も純 JSON ストリームではない**（§3.7 の再確認）。本確認のドライバは
  貪欲な `\{.*\}` で dotenv のヒント行に食いついて落ちた（6.3 の但し書き）。
  **`--json` を機械が食う前提なら `--quiet` か stderr への振り分けが要る**という §3.7 の指摘は、
  実際に人を転ばせたので優先度を 1 段上げてよい。
