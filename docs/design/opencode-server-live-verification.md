# 実機検証: opencode server API / SSE（Phase 4-0b スパイク）

- **Issue**: [#1758](https://github.com/Kewton/CommandMate/issues/1758)（親 Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720)）
- **ステータス**: 実測完了（**`src/` の変更なし**）
- **検証日**: 2026-08-13
- **対象**: opencode **1.18.3**（`opencode --version`）
- **プラットフォーム**: macOS (Darwin 25.6.0) / `~/.opencode/bin/opencode`
- **provider / model**: `github-copilot` / `claude-sonnet-4.6`（LM Studio でも一部実行）
- **成果物**: 本書 ＋ [`tests/fixtures/hooks/opencode/*.json`](../../tests/fixtures/hooks/opencode/)（19 件）
- **一次証拠**: サーバ自身が返す OpenAPI（`GET /doc`、3.1.0 / 89 種の Event union）と、`GET /event` に張った SSE tap 計 471 フレーム

> 本書は下流 Issue（[#1759](https://github.com/Kewton/CommandMate/issues/1759) 抽象抽出 / [#1763](https://github.com/Kewton/CommandMate/issues/1763) opencode 対応）が仕様の根拠として引用することを前提に書いている。
> 先行する Claude 版スパイク [`agent-hooks-live-verification.md`](./agent-hooks-live-verification.md) と体裁を揃えた。
> **本書に書いてあるのは「ドキュメントの記述」ではなく「実際に動かして観測した結果」である。**
> Issue 本文の起票時前提と食い違った箇所は [§3](#3-issue-本文公式挙動と実測の食い違い) にまとめた。**食い違いは 6 件あり、うち 2 件は設計の形を変える。**

---

## 1. 結論サマリ

| # | 検証項目 | 実測結果 | 証拠 |
|---|---|---|---|
| 1 | serve + attach の実用性 | **成立する**（`attach` した TUI は素の `opencode` と同等に使える）。**ただし serve+attach は不要だった** — **素の `opencode` TUI 自身が同じ HTTP サーバを内蔵しており、`opencode --port <N>` を足すだけで `/event` SSE と permission REST の全経路が使える**（実測）。**Go**。ただし採用すべき構成は serve+attach ではなく「既存の TUI 起動 + `--port`」 | [§2](#2-検証項目-1-の-gono-go-判断), [§5.1](#51-項目-1--serve--attach-の実用性と素の-tui-が持つサーバ) |
| 2 | イベント語彙 | `/doc` の Event union は **89 種**。本スパイクで実際に流れたのは **20 種**。`AGENT_EVENT_TYPES` の 7 語に **1:1 対応するのは 3 語だけ**（`stop`←`session.idle` / `session_start`←`session.created` / `session_end`←`session.deleted`、ただし最後は意味が違う）。`notification` に相当する単一入口は**無く**、`idle_prompt` 相当（放置検知）は**存在しない**。`pre_tool_use` / `post_tool_use` は専用イベントではなく `message.part.updated` の `part.state.status` を見る | [§5.2](#52-項目-2--イベント語彙), [fixtures](../../tests/fixtures/hooks/opencode/) |
| 3 | 完了（idle）の意味 | **`session.idle` は Claude の `Stop` と同じ「ターンが終わった」である。「セッションが暇」ではない。** 承認待ち 10 分 19 秒・質問待ち 40 秒の間、**当該セッションに `session.idle` は 1 件も出ていない**（`session.status` も `busy` のまま）。**`wait` の完了判定に使ってよい。** ただし **error / abort 経路では 1 ターンで 2 回発火**し、payload は `sessionID` **のみ**（ターン識別子なし）なので、**busy を観測してから最初の idle を取る + 冪等化**が必須 | [§5.3](#53-項目-3--完了idleの意味-wait-の完了判定に使ってよいか) |
| 4 | 承認要求の受信 | **`permission.asked` が SSE に流れる。** payload に `id`(=permissionID) / `sessionID` / `permission`(種別) / `patterns` / `metadata.command` / `always` / `tool.{messageID,callID}`。`GET /permission` で同じものをポーリング取得もできる。**`permission.v2.asked` は型定義にあるが 1.18.3 では流れなかった** | [§5.4](#54-項目-4--承認要求の受信) |
| 5 | 承認裁定の応答 | **`POST /session/:id/permissions/:permissionID` に `{"response":"once"}` で 200 `true`（4.8ms）、TUI ダイアログは消え、コマンドが実行された。** **タイムアウトは存在しない**（**10 分 19 秒**放置して無変化・自動裁定なし）。「no-decision で TUI 承認に落ちる」のではなく、**TUI ダイアログは `permission.asked` と同時に無条件で出ており、REST と TUI は最初に答えた方が勝つレース**である。**Auto-Yes は fail-open しない（CommandMate が黙ればエージェントは永久に止まる）** | [§5.5](#55-項目-5--承認裁定の応答と-no-decision-の実際の意味) |
| 6 | インスタンス相関 | **1 サーバに複数 session を載せられる**（2 session 同時 busy を実測）。だが **`GET /session` は「このサーバの session」ではなく「同一 HOME / 同一 project の全 session」**を返す（別ポートの serve が作った session まで見える＝ `opencode.db` 共有）。**推奨は 1 インスタンス = 1 TUI プロセス = 1 ポート**。この構成なら当該ポートの `session.created` が一意に自分のものなので対応表は自動で決まる。`-s <sessionID>` による事前バインドも実測で成立 | [§5.6](#56-項目-6--インスタンス相関) |
| 7 | 接続の生存管理 | `/event` は **10 秒ごとに `server.heartbeat`** を送る（60 サンプル、gap 10.00〜10.03 秒）＝これが死活監視の signal。サーバ消滅で SSE は即 close（`curl (18)`）、以後の接続は **1ms 未満で `ECONNREFUSED`**。`attach` した TUI は**サーバが死んでも画面に何も出さず**、同ポートで再起動すると**無言で自動再接続して復帰した**。**`GET /api/session/:id/event?after=<seq>` は 1 バイトも返さず（再接続時リプレイは使えない）**、**`GET /api/event` は 1 ターンの先頭 3 件で沈黙する** | [§5.7](#57-項目-7--接続の生存管理と再接続) |
| 8 | 認証 | 既定は**無認証**（stderr に `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`）。`OPENCODE_SERVER_PASSWORD` を与えると **HTTP Basic**（`WWW-Authenticate: Basic realm="Secure Area"`、user 既定 `opencode` / `OPENCODE_SERVER_USERNAME`）。`--hostname` 既定 `127.0.0.1` で **LAN IP からは接続不可**（実測）。`CM_AUTH_TOKEN` とは無関係な別系統 | [§5.8](#58-項目-8--認証) |
| 9 | ポート衝突 | **`--port 0` は「OS に空きポートを訊く」ではない。まず 4096 を試し、埋まっていたら ephemeral に落ちる**（1 本目 → 4096、2 本目 → 58153 を実測）。**実ポートを知る手段は stdout の 1 行（`opencode server listening on http://127.0.0.1:<port>`）か `lsof` しかない**（ポートファイル・ロックファイルは書かれない）。したがって **CommandMate 側で明示的にポートを割り当てるのが唯一の安全策** | [§5.9](#59-項目-9--ポート衝突と実ポートの知り方) |
| 10 | plugin 方式との比較 | ローカル JS plugin は動く（`init` / `event` / `tool.execute.before` / `tool.execute.after` を実測）。しかし **plugin の `event` フックが受け取る語彙は SSE と同一で情報が増えない**うえ、**承認を裁定する plugin フックは存在しない**（`permission.ask` という文字列自体が 1.18.3 のバイナリに無い。`tool.execute.*` / `command.execute.before` / `event` のみ）。**server API が唯一の接点。plugin は採用しない** | [§5.10](#510-項目-10--plugin-方式との比較) |

### 1.1 下流 Issue が特に依拠すべき結論

| 結論 | 影響する Issue |
|---|---|
| **`opencode serve` / `opencode attach` は使わない。既存の TUI 起動に `--port <N>` を足すだけでよい。** 起動経路の変更（`opencode.ts:136`）は「引数 1 個の追加」に縮む。`killSession` の `/exit` 送出・初期化待ちループは**そのまま使える** | #1763 |
| **`AgentEventSource` は push（hooks）だけでなく pull（SSE 購読 + REST 応答）を表現できなければならない。** 具体 I/F 案は [§9](#9-phase-4-1-1759-抽象抽出への要求事項最重要) | **#1759** |
| `session.idle` は `Stop` と同義。**`wait` の完了判定に使ってよい**が、**busy 観測後の最初の idle** を取り、**2 回目以降を無視**すること | #1763 |
| **承認は fail-open しない。** CommandMate が裁定を返さない限りエージェントは無限に待つ（10 分 19 秒で無変化を実測）。hooks 側の「黙れば安全」という前提は opencode には**通用しない** | #1763 / #1724 との差分 |
| **`question.asked` は質問文と選択肢を構造化して配ってくる**うえ `POST /question/:id/reply` で答えられる。Claude で scraper に残さざるを得なかった `AskUserQuestion`（#1708 / #1726）が、opencode では**完全に構造化イベントで扱える** | #1763 / #1726 の対称 |
| **`session_end` に相当するものが無い。** TUI の `/exit` はイベントを 1 件も出さず、`session.deleted` は明示 DELETE のときだけ。**プロセス終了の検知は tmux 側に残す** | #1759 / #1763 |
| **購読先は legacy `/event` 一本。`/api/event` と `/api/session/:id/event` は 1.18.3 では実用にならない**（前者は 3 件で沈黙、後者は 0 バイト） | #1763 |
| **`GET /session` を「自分の instance の一覧」として使ってはいけない。** 同一 HOME / project の全 session が返る | #1763 |
| SSE の購読は Next.js サーバプロセス内に持つことになる。**`globalThis` を経由しない in-memory 状態は dev で無言に壊れる**（#1736 の前例）。購読レジストリは `globalThis` に置くこと | #1759 / #1763 |

---

## 2. 検証項目 1 の Go/No-Go 判断

### 判断: **Go**（ただし採用する構成は Issue の想定と違う）

Issue は「`opencode serve --port N` を別プロセスで立て、tmux 内で `opencode attach http://127.0.0.1:N` した TUI が通常の `opencode` と同等に使えるか」を問うている。

**答えは「使える」。** [§5.1.1](#511-serve--attach-は成立する) のとおり `attach` した TUI で通常のプロンプト送信・tool 実行・承認ダイアログ・`question` の選択画面がすべて機能し、
REST 経由の承認・質問応答も反映された。この構成でも Phase 4-5 は成立する。

**しかし採用すべきではない。** [§5.1.2](#512-しかし-serveattach-は要らない--素の-tui-が同じサーバを内蔵している) のとおり、

> **素の `opencode` TUI（`opencode [project]`、CommandMate が今まさに起動しているもの）が、同じ HTTP サーバを自プロセス内に持っている。**
> `opencode --port 4791` で起動した TUI に対して `/global/health` / `/event` / `GET /permission` /
> `POST /session/:id/permissions/:permissionID` のすべてが serve と同一に応答した。

これにより Issue が「hooks には無い問題」として挙げた 3 つの困難のうち **2 つが消える**。

| Issue が想定した困難 | serve + attach | **素の TUI + `--port`（推奨）** |
|---|---|---|
| 接続の生存管理 | serve プロセスと TUI プロセスの**2 つ**を別々に監視する必要がある | **サーバの寿命 = TUI プロセスの寿命**。CommandMate は既に tmux で TUI の生死を管理している。監視対象が増えない |
| serve プロセスが落ちたときの縮退 | TUI が無言のゾンビになる（[§5.7.3](#573-attach-した-tui-はサーバの死を画面に出さない)）。**画面に何も出ないので scraper では検知できない** | **落ちるときは TUI ごと落ちる**。tmux セッション消滅＝既存の検知経路そのまま |
| サーバ未起動時の縮退 | 「serve は居ないが TUI は生きている」という中間状態が存在する | **中間状態が存在しない**。ポートに繋がらなければ TUI も居ない |
| 起動経路の変更 | `sendKeys(sessionName, 'opencode', true)` → serve 起動 + attach の 2 段。`killSession` の `/exit` や初期化待ちループとの整合を再設計 | **`'opencode'` → `'opencode --port <N>'` の 1 箇所**。`/exit`・初期化待ちはそのまま |

> **なお「サーバが居なければ scraper に落ちる」という Issue の縮退設計は、素の TUI 構成では意味が変わる。**
> サーバは TUI と同一プロセスなので「サーバだけが居ない」状態は起こらない。
> 縮退が必要なのは **`--port` を付けずに起動された既存セッション**（バージョン混在・ユーザーが手で起動した pane）に対してであり、
> その場合は従来どおり scraper のみで動く。**構造化イベントは「あれば使う」加算的な機構として設計すべきで、`--port` の有無で 2 モードを持つ。**

### No-Go だった場合の代替案（記録のため）

項目 1 が成立しなかった場合の代替は「素の TUI + scraper 継続」（現行 `src/lib/cli-tools/opencode.ts` のまま、`src/lib/detection/` のスクレイピングで status / prompt を判定）だった。
**実測では serve+attach も素の TUI+`--port` も成立したので、この代替案は採らない。**
ただし上記のとおり **`--port` 無しセッション向けのフォールバックとして scraper 経路は残す**必要がある（削除してはいけない）。

---

## 3. Issue 本文・公式挙動と実測の食い違い

**下流実装者は下表を先に読むこと。** D1 / D2 は設計の形を変える。

| # | Issue #1758 本文・`--help` の記述 | 実測 | 影響 |
|---|---|---|---|
| **D1** | 「opencode は **`opencode serve` が立てる HTTP サーバに CommandMate 側から繋ぐ**」「既存の CommandMate 実装は素の TUI として起動している。serve/attach は使っていない」→ **serve/attach への移行が前提** | **素の TUI がすでに同じサーバを内蔵している。** `opencode --port 4791` で `/event` SSE・permission REST が完全に動いた（[§5.1.2](#512-しかし-serveattach-は要らない--素の-tui-が同じサーバを内蔵している)）。**serve/attach への移行は不要** | **最重要。** #1763 の作業量とリスクが大幅に下がる。「起動経路の変更」ではなく「引数 1 個の追加」。Issue の「既知の罠」1 番目（`killSession` / 初期化待ちループとの整合）は**問題にならない** |
| **D2** | 「応答しなかった場合に**通常の TUI 承認へ落ちる**か（＝ no-decision フォールバック）」→ hooks と同じ「黙れば TUI に落ちる」モデルを想定 | **フォールバックという段階は存在しない。** TUI ダイアログは `permission.asked` と**同時に無条件で描かれ**、REST と TUI は並行して開いている。先に答えた方が勝つ**レース**。そして**タイムアウトが無い**（10 分 19 秒放置で無変化） | **最重要。** Auto-Yes の安全性の形が Claude と逆になる。Claude は「CommandMate が黙る＝安全（fail-open）」だったが、opencode は「**CommandMate が黙る＝エージェントが永久停止**」。逆に「CommandMate が誤って allow を返す＝人間が読む前にダイアログが消える」レースが生じる（[§5.5](#55-項目-5--承認裁定の応答と-no-decision-の実際の意味)） |
| **D3** | `--help`: `--port` の `[default: 0]` ＋ Issue「`--port 0`（自動）で立てた場合の実ポートの知り方」→ **0 = OS 任せの自動割当**という理解 | **`0` は「まず 4096、埋まっていたら ephemeral」のセンチネル。** 1 本目は必ず 4096 を掴む。ポートファイル等は書かれず、実ポートは **stdout 1 行か `lsof`** しか手がかりが無い | #1763 は**必ず `--port` を明示**する。既に worktree ごとにポートを扱う仕組み（`--auto-port`）があるので、そこに相乗りすれば二重管理にならない（[§5.9](#59-項目-9--ポート衝突と実ポートの知り方)） |
| **D4** | Issue「`permission.asked` 相当が SSE に流れるか」／`/doc` は `permission.asked` と **`permission.v2.asked`** の両方を宣言 | **流れるのは `permission.asked` / `permission.replied`（v1）だけ。** v2 系（`permission.v2.asked` / `question.v2.asked` 等）は 1 件も観測されなかった | #1763 は v1 のみを実装する。v2 は将来の移行先として型定義だけ存在すると理解しておく |
| **D5** | `/doc` の Event union（89 種） | **`server.heartbeat` が union に含まれていない**のに 10 秒ごとに実際に流れる。つまり**死活監視に使う最重要イベントが自サーバの OpenAPI に載っていない** | 生成型（openapi → TS）に頼ると `server.heartbeat` が unknown で落ちる。**パーサは未知の `type` を捨てずに無視する**設計にすること |
| **D6** | Issue「`POST /session/:id/permissions/:permissionID`」 | 成立する。**ただしボディのキーは `response`**（`{"response":"once"}`）。別経路の `POST /permission/:requestID/reply` はキーが **`reply`** で、加えて `message` を渡せる（拒否理由がエージェントに見える）。**2 つの endpoint でキー名が違う** | #1763 はどちらを使うか決めて固定すること。**拒否理由を伝えたいなら `/permission/:id/reply`**（`message` 対応）。fixture [`message-part-updated-tool-error.json`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-error.json) に `message` がエージェントへ届いた実物がある |

---

## 4. 再現環境（ハーネス）

すべての実測は**隔離 HOME**と**専用 tmux socket**の中で行った。以下をそのまま再実行すれば同じ観測ができる。

### 4.1 隔離 HOME

opencode は `$HOME` から config（`~/.config/opencode`）・state（`~/.local/state/opencode`）・
データ（`~/.local/share/opencode`、**`opencode.db` を含む**）を解決する。
セッションを 1 回動かすだけで `opencode.db` に書き込むため、**`HOME` ごと差し替えないとユーザーのデータを汚す。**

```bash
SP=/path/to/scratchpad
mkdir -p "$SP"/{home/.local/share/opencode,home/.config/opencode,work,logs,sse}

# 認証情報（provider の credential）。mode 600 で複製し、検証後に削除する
umask 077
cp ~/.local/share/opencode/auth.json "$SP/home/.local/share/opencode/auth.json"
umask 022

# model を固定する（TUI のモデルピッカーを触らずに済む）
cat > "$SP/home/.config/opencode/opencode.jsonc" <<'JSON'
{ "$schema": "https://opencode.ai/config.json", "model": "github-copilot/claude-sonnet-4.6" }
JSON

# project として認識させる
( cd "$SP/work" && git init -q && echo hello > README.md \
  && git add -A && git -c user.email=a@b -c user.name=a commit -qm init )
```

隔離できていることは `GET /path` で確認する（**すべて scratchpad 配下を指していること**）。

```bash
curl -sS http://127.0.0.1:4788/path
# {"home":"…/scratchpad/home","state":"…/scratchpad/home/.local/state/opencode",
#  "config":"…/scratchpad/home/.config/opencode","worktree":"…/scratchpad/work","directory":"…/scratchpad/work"}
```

> **`opencode` は TUI のモデルピッカーで既定モデルを書き換える。** Claude の `/model` overlay と同じ罠なので、
> 隔離 HOME の外でピッカーを開かないこと。本スパイクでは**ピッカーを一度も開いていない**（config で固定した）。

### 4.2 ポート

**3000 番は絶対に使わない**（ユーザーの稼働中 CommandMate 本番サーバ）。本スパイクは 4788 / 4789 / 4790 / 4791 / 4792 と、
`--port 0` の挙動確認で 4096 / 58153 を使った。すべて `--hostname 127.0.0.1`。

```bash
cd "$SP/work"
HOME="$SP/home" nohup opencode serve --port 4788 --hostname 127.0.0.1 --print-logs --log-level INFO \
  > "$SP/logs/serve.out" 2>&1 &
echo $!            # ← PID を控える。後始末は必ず PID 指定 kill（pkill -f opencode は使わない）
```

### 4.3 タイムスタンプ付き SSE tap

**`curl -N` だけでは時刻が取れず、`session.idle` が「承認待ちの間に出ていないこと」を示せない。**
1 フレーム 1 行の JSONL に時刻を付けて落とす。

```python
# $SP/ssetap.py — 使い捨て SSE tap
import json, sys, time, urllib.request

url, out = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
f = open(out, "a", buffering=1)
with urllib.request.urlopen(req) as r:
    ev = None
    for raw in r:
        line = raw.decode("utf-8", "replace").rstrip("\n")
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            rec = {"ts": time.strftime("%H:%M:%S") + ".%03d" % (int(time.time() * 1000) % 1000),
                   "sse_event_field": ev}
            try:
                rec["data"] = json.loads(line[5:].strip())
            except Exception:
                rec["raw"] = line[5:].strip()
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            ev = None
```

```bash
nohup python3 "$SP/ssetap.py" http://127.0.0.1:4788/event "$SP/sse/tap.jsonl" > /dev/null 2>&1 &
```

**観測 471 フレームすべてで `sse_event_field` は `null` だった。** つまり `event:` 行は一度も来ておらず、
**イベント種別は `data` の JSON の `type` にしか入っていない。**
`EventSource#addEventListener("session.idle", …)` では 1 件も拾えない（`onmessage` で受けて `type` を見る）。

### 4.4 tmux の隔離（必読）

エージェントは tmux ペインの中で動いており `$TMUX` はユーザーの本番サーバを指している。
tmux の解決順は **`-L` / `-S` > `$TMUX` > `TMUX_TMPDIR`** なので、**`TMUX_TMPDIR` では隔離できない**。

```bash
tmux -L cmate-p4spike-oc new-session -d -s oc-attach -x 200 -y 60 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color opencode attach http://127.0.0.1:4788"

tmux -L cmate-p4spike-oc capture-pane -p -t '=oc-attach:0.0'

# 後始末（kill-server は絶対に使わない。完全一致ターゲットで session だけ落とす）
tmux -L cmate-p4spike-oc kill-session -t '=oc-attach:'
```

- **`kill-server` は書かない。** 専用 socket なら最後の session 終了でサーバも自然終了する。
- `bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。
- 並行して走る #1757 のワーカーは socket `cmate-p4spike` を使う。**混ぜない。**

### 4.5 一次証拠としての OpenAPI

opencode は**自分自身の OpenAPI を配る**。イベント語彙の全列挙はここから取れる（推測不要）。

```bash
curl -sS http://127.0.0.1:4788/doc -o openapi.json     # 478,613 bytes / OpenAPI 3.1.0
python3 - <<'PY'
import json
d = json.load(open("openapi.json"))
sch = d["components"]["schemas"]
for v in sch["Event"]["anyOf"]:
    n = v["$ref"].split("/")[-1]
    t = sch[n]["properties"]["type"]
    print(t.get("const") or t["enum"][0])
PY
# => 89 行
```

---

## 5. 検証項目ごとの実測

### 5.1 項目 1 — serve + attach の実用性と、素の TUI が持つサーバ

#### 5.1.1 serve + attach は成立する

`opencode serve --port 4788` を立て、専用 socket の tmux で `opencode attach http://127.0.0.1:4788` を起動した。

```
opencode server listening on http://127.0.0.1:4788
```

```bash
tmux -L cmate-p4spike-oc new-session -d -s oc-attach -x 200 -y 60 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color opencode attach http://127.0.0.1:4788"
sleep 8
tmux -L cmate-p4spike-oc capture-pane -p -t '=oc-attach:0.0'
```

**trust プロンプト・update プロンプト・login プロンプトは一切出なかった**（Claude の folder trust に相当するものが無い）。
素の TUI と同じスプラッシュとコンポーザが描かれ、フッタも同じ。

観測できたこと（すべて `attach` した TUI 上）:

| 操作 | 結果 |
|---|---|
| プロンプト送信 | `PONG-A` を **2.6 秒**で返した。`session.created` → … → `session.idle` が SSE に流れた |
| tool 実行（`bash`） | 実行された。承認ダイアログも通常どおり描かれた |
| 承認ダイアログ | `△ Permission required` ＋ `Allow once / Allow always / Reject` の 3 択が描かれた |
| `question` tool | 選択肢つきのピッカーが描かれた（`↑↓ select  enter submit  esc dismiss`） |
| REST での承認 | ダイアログが消えてコマンドが実行された |
| REST での質問応答 | ピッカーが消えてエージェントが続行した |
| `/exit` | TUI が終了し tmux セッションも終了した（＝既存 `killSession` と整合） |

**結論: serve + attach で Phase 4-5 は成立する。**

#### 5.1.2 しかし serve/attach は要らない — 素の TUI が同じサーバを内蔵している

`--port` / `--hostname` は `serve` 専用のオプションではなく、**`opencode` のグローバルオプション**である
（`opencode --help` の `Options:` に載っている）。素の TUI に付けて起動した。

```bash
tmux -L cmate-p4spike-oc new-session -d -s oc-plain -x 200 -y 50 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color opencode --port 4791 --hostname 127.0.0.1"
sleep 12
lsof -nP -iTCP:4791 -sTCP:LISTEN
# opencode 96057 … TCP 127.0.0.1:4791 (LISTEN)      ← TUI プロセス自身が listen している
curl -sS http://127.0.0.1:4791/global/health
# {"healthy":true,"version":"1.18.3"}
curl -sS -N -m 4 http://127.0.0.1:4791/event
# data: {"id":"evt_…","type":"server.connected","properties":{}}
```

**serve と同一のサーバである。** 全経路を素の TUI 上で通した。

| 手順 | 実測 |
|---|---|
| TUI に `touch /private/tmp/cmate-oc-plain.txt` を打たせる | `08:17:38.056 permission.asked` が SSE に流れた |
| `GET http://127.0.0.1:4791/permission` | pending 1 件、`metadata.command` に実コマンドが入っていた |
| `POST /session/<sid>/permissions/<per> {"response":"once"}` | `200` / body `true` |
| pane | ダイアログが消え、`Done. The file /private/tmp/cmate-oc-plain.txt has been created.` / `Build · Claude Sonnet 4.6 · 31.5s` |
| ファイル | `-rw-r--r--@ 1 … /private/tmp/cmate-oc-plain.txt` が実在 |
| SSE | `08:18:04.524 permission.replied once` → `08:18:06.655 session.status idle` → `08:18:06.655 session.idle` |

→ **#1763 の起動経路変更は `opencode` → `opencode --port <N>` だけで足りる。**
`src/lib/cli-tools/opencode.ts:136` の `sendKeys(sessionName, 'opencode', true)` に引数を足すだけであり、
`killSession`（`/exit` 送出）・`OPENCODE_INIT_WAIT_MS` の初期化待ちループ・`reconcileExistingSession` は**一切変えなくてよい**。

---

### 5.2 項目 2 — イベント語彙

#### 5.2.1 全列挙と実観測

`GET /doc` の `components.schemas.Event` は **89 variant の anyOf**。全 89 種の名前は [§4.5](#45-一次証拠としての-openapi) のコマンドで再取得できる。
族ごとに整理すると:

| 族 | 種類数 | 代表 |
|---|---|---|
| `session.next.*`（v2 の細粒度ストリーム） | 30 | `session.next.tool.called` / `.text.delta` / `.step.started` / `.reasoning.*` |
| `session.*`（v1） | 10 | `session.created` / `.updated` / `.deleted` / `.idle` / `.status` / `.error` / `.diff` / `.compacted` |
| `message.*` | 5 | `message.updated` / `message.part.updated` / `message.part.delta` |
| `permission.*` | 4 | `permission.asked` / `.replied` / `.v2.asked` / `.v2.replied` |
| `question.*` | 6 | `question.asked` / `.replied` / `.rejected` ＋ v2 |
| `pty.*` / `tui.*` / `workspace.*` / `worktree.*` / その他 | 34 | `installation.update-available` / `plugin.added` / `lsp.updated` / `todo.updated` … |

**本スパイクで実際に流れたのは 20 種**（全 tap 合計、`plugin.added` を含む）。

```
   16  catalog.updated          360  plugin.added
    8  integration.updated        8  reference.updated
   68  message.part.delta         6  server.connected
   85  message.part.updated     153  server.heartbeat        ← /doc に型定義が無い（D5）
   87  message.updated            5  session.created
    4  permission.asked           1  session.deleted
    4  permission.replied        26  session.diff
    1  question.asked             2  session.error
    1  question.replied          13  session.idle
                                 56  session.status
                                 43  session.updated
```

**`session.next.*` は 1 件も流れなかった**（`/event` には来ない。[§5.2.2](#522-legacy-event-と-apievent-の違いと-apievent-が使えない理由) 参照）。

#### 5.2.2 legacy `/event` と `/api/event` の違い（と `/api/event` が使えない理由）

envelope が違う。

```jsonc
// GET /event（legacy）
{ "id": "evt_…", "type": "message.updated", "properties": { … } }

// GET /api/event（v2）
{ "id": "evt_…", "type": "message.updated",
  "durable": { "aggregateID": "ses_…", "seq": 26, "version": 1 },
  "location": { "directory": "…" },
  "data": { … } }                                     // ← properties ではなく data
```

**`/api/event` は 1 ターンの先頭 3 件で無言に沈黙する。** 独立に 2 回再現した（python tap / `curl -N` の両方）。

```
# 同一サーバ・同一ターンを両方で購読した結果
### /event (legacy) ###          ### /api/event (v2) ###
08:03:59.806 message.updated     08:03:59.806 message.updated       (seq 26)
08:03:59.807 message.part.updated 08:03:59.807 message.part.updated (seq 27)
08:03:59.807 session.updated     08:03:59.807 session.updated       (seq 28)
…（合計 41 件、session.idle まで到達）           …（以降 0 件。接続は開いたまま）
```

別ターン（`TICK`）でも同じ: legacy **22 件**（`session.idle` 到達）に対し v2 は **3 件（seq 50/51/52）で停止**。
接続自体は `curl` が `--max-time` で切られるまで開いたままで、エラーもクローズも起きない。

`GET /api/session/:id/event?after=<seq>`（「durable event を seq 以降からリプレイして継続する」と宣言されている）は
**ヘッダすら返らず 0 バイト**だった。ターンを実行中に開いていても 0 バイトのまま。

```bash
curl -sS -i -N --max-time 6 "http://127.0.0.1:4788/api/session/ses_…/event?after=0"
# curl: (28) Operation timed out after 6002 milliseconds with 0 bytes received
```

→ **購読は legacy `/event` 一本にする。** seq ベースのリプレイによる再接続は 1.18.3 では使えない（[§5.7](#57-項目-7--接続の生存管理と再接続) の代替を採る）。

#### 5.2.3 `AGENT_EVENT_TYPES` 7 語へのマッピング

| `AGENT_EVENT_TYPES` | opencode | 判定条件 | 対応度 |
|---|---|---|---|
| `stop` | `session.idle` | そのまま | **1:1**（ただし 2 回発火しうる。[§5.3](#53-項目-3--完了idleの意味-wait-の完了判定に使ってよいか)） |
| `session_start` | `session.created` | そのまま | **1:1**。ただし「セッションレコードの生成」であり TUI 起動ではない。`-s` で事前バインドすると**発火しない** |
| `user_prompt_submit` | `message.updated` | `properties.info.role === "user"` | **複合**。本文は続く `message.part.updated`（`part.type === "text"`）に入る |
| `pre_tool_use` | `message.part.updated` | `part.type === "tool" && part.state.status === "running"` | **部分一致**。`matcher` 相当は無いので購読側で `part.tool` を見て絞る |
| `post_tool_use` | `message.part.updated` | `part.type === "tool" && part.state.status ∈ {"completed","error"}` | **部分一致**。相関キーは `part.callID` |
| `notification` | `permission.asked` / `question.asked` / `session.error` | 用途別に 3 つ | **相当なし**。単一入口が無い。**`idle_prompt` 相当（放置検知）は存在しない** |
| `session_end` | `session.deleted` | そのまま | **意味が違う**。[§5.6.3](#563-exit-はイベントを出さないsession_end-の不在) |

tool part のライフサイクルは実測でこの順（`callID` で相関）。

```
07:58:37.392  bash  status=pending    state keys = input, raw, status
07:58:37.665  bash  status=running    state keys = input, status, time              ← pre_tool_use
07:59:24.819  bash  status=completed  state keys = input, metadata, output, status, time, title  ← post_tool_use
08:10:26.253  bash  status=error      state keys = error, input, status, time       ← post_tool_use（拒否）
```

fixture: [`…-tool-pending`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-pending.json) /
[`-running`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-running.json) /
[`-completed`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-completed.json) /
[`-error`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-error.json)

#### 5.2.4 `question.asked` — Claude の `AskUserQuestion` が構造化で取れる

opencode は `question` という tool を持つ（`GET /experimental/tool/ids` →
`['invalid','question','bash','read','glob','grep','edit','write','task','webfetch','todowrite','websearch','skill','apply_patch']`）。
これを誘発すると **質問文・ヘッダ・選択肢ラベル・選択肢説明がすべて構造化されて SSE に流れる。**

```json
{ "id": "evt_…", "type": "question.asked",
  "properties": {
    "id": "que_…", "sessionID": "ses_…",
    "questions": [ { "question": "Which colour do you prefer?", "header": "Colour preference",
                     "options": [ { "label": "Red",  "description": "The colour red" },
                                  { "label": "Blue", "description": "The colour blue" } ] } ],
    "tool": { "messageID": "msg_…", "callID": "toolu_…" } } }
```

そして **REST で答えられる。**

```bash
curl -sS -X POST -H 'Content-Type: application/json' -d '{"answers":[["Blue"]]}' \
  "http://127.0.0.1:4788/question/que_…/reply"
# => true / HTTP 200
```

pane では選択肢ピッカーが消え、`Which colour do you prefer? / Blue` の後にエージェントが `You prefer blue.` と続行した。

> **これは Claude との最大の差であり、opencode 側の明確な優位点である。**
> Claude では `AskUserQuestion` の選択画面に構造化イベントが無く、
> `PermissionRequest` に `allow` を返しても選択画面が残るため **scraper に依存せざるを得なかった**（#1708 / #1726）。
> opencode では **質問の内容も回答も完全に構造化されており、scraper が不要**。

`answers` は `string[][]`（質問ごとに選んだラベルの配列）。`POST /question/:id/reject` で拒否もできる。

---

### 5.3 項目 3 — 完了（idle）の意味。`wait` の完了判定に使ってよいか

### 結論: **使ってよい。`session.idle` は Claude の `Stop` と同じ「ターンが終わった」である。**

ただし **(a) busy を観測してから最初の idle を取る**、**(b) 2 回目以降を無視する** の 2 つが必須。

#### 5.3.1 「暇」ではなく「ターン終了」である証拠

`session.idle` / `session.status(idle)` / `permission.*` / `question.*` だけを時系列に並べた（tap から抽出、2 セッション混在）。

```
07:57:47.525  st=idle    ses_…001                                   ← ターン終了（PONG-A、2.6s）
07:58:37.682  permission.asked  ses_…001  per_…A
07:59:24.806  permission.replied ses_…001 per_…A  once
07:59:27.659  st=idle    ses_…001                                   ← 承認後にツールが走り終わってから idle
07:59:27.659  IDLE       ses_…001
08:00:07.155  permission.asked  ses_…001  per_…B                    ┐
08:02:36.919  question.asked    ses_…002  que_…C                    │ この 10 分 19 秒のあいだ
08:03:17.310  question.replied  ses_…002  que_…C                    │ ses_…001 の idle は 0 件
08:03:19.483  IDLE       ses_…002                                   │ （ses_…002 の idle は出ている）
08:04:04.659  IDLE       ses_…002                                   │
08:06:13.473  IDLE       ses_…002                                   ┘
08:10:26.253  permission.replied ses_…001 per_…B  reject
08:10:28.773  st=idle    ses_…001                                   ← 裁定してから初めて idle
08:10:28.773  IDLE       ses_…001
```

- **承認待ちの 10 分 19 秒**（`08:00:07.155` → `08:10:26.253`）、当該セッションに `session.idle` は **1 件も無い**。
- **質問待ちの 40 秒**（`08:02:36.919` → `08:03:17.310`）も同様に **0 件**。
- ポーリング側も一致する。承認 pending 中の `GET /session/status` は `busy` を返した。

```bash
curl -sS http://127.0.0.1:4788/session/status
# {"ses_…001":{"type":"busy"}}                     ← 承認ダイアログが出たまま放置している最中
# {"ses_…001":{"type":"busy"},"ses_…002":{"type":"busy"}}   ← 2 セッション同時
```

→ **`session.idle` は「人間の入力を待っている状態」を含まない。** 承認・質問はどちらも `busy`。
`wait` が「エージェントが手を止めて人間を待っている」を検知したいなら、
`session.idle` ではなく **`permission.asked` / `question.asked`** を見ること（`--on-prompt` の意味論はこちらに乗る）。

#### 5.3.2 error / abort では 1 ターンで 2 回発火する（**`wait` の冪等化が必須**）

**(a) provider エラー**（LM Studio に model 未ロード）:

```
server.connected -> session.created -> session.status -> session.status -> session.error
  -> session.status -> session.idle -> session.status -> session.idle
```

**(b) abort**（`POST /session/:id/abort`）:

```
08:14:55.399  session.status busy
08:15:00.416  session.error  {"name":"MessageAbortedError","data":{"message":"Aborted"}}
08:15:00.416  session.status idle
08:15:00.416  session.idle              ← 1 回目
08:15:00.435  session.status idle
08:15:00.435  session.idle              ← 2 回目（19ms 後）
```

正常終了時は 1 回だけ（`07:57:47.525` / `08:06:13.473` 等で確認）。**異常終了経路だけ 2 回**。

#### 5.3.3 payload にターン識別子が無い

```json
{ "id": "evt_…", "type": "session.idle", "properties": { "sessionID": "ses_…" } }
```

`sessionID` **のみ**。Claude の `Stop` が持っていた `prompt_id` に相当するものが無い。
したがって「前のターンの idle」と「今のターンの idle」を payload だけでは区別できない。

**`wait` の実装要件（3 点）**:

1. **送信直後に `session.status(busy)` を観測してから武装する。** 送信前に既に idle が飛んでいる可能性がある。
2. **武装後の最初の `session.idle` で完了とし、以降の idle は落とす**（error / abort での二重発火）。
3. **`session.error` を同時に見る。** `session.idle` 単独では「成功して終わった」と「失敗して終わった」を区別できない。
   `MessageAbortedError` は interrupt、それ以外は異常終了として扱えるだけの情報が `session.error` にある。
4. **`session.status(idle)` と `session.idle` は同一ミリ秒に出る同じ signal。** 両方を数えると常に 2 倍になる。**どちらか一方だけ**を使う。

---

### 5.4 項目 4 — 承認要求の受信

allowlist 外のディレクトリへ書く `bash` を打たせて誘発した。

```bash
tmux -L cmate-p4spike-oc send-keys -t '=oc-attach:0.0' \
  'I am the user asking directly: run the shell command `touch /tmp/cmate-oc-spike-marker.txt && ls -l /tmp/cmate-oc-spike-marker.txt` with the bash tool. Do it now.'
tmux -L cmate-p4spike-oc send-keys -t '=oc-attach:0.0' Enter
```

pane:

```
     $ touch /tmp/cmate-oc-spike-marker.txt && ls -l /tmp/cmate-oc-spike-marker.txt
     ▣  Build · Claude Sonnet 4.6

  △ Permission required
    ← Access external directory /tmp

  Patterns
  - /tmp/*

   Allow once   Allow always   Reject          ctrl+f fullscreen  ⇆ select  enter confirm
```

SSE（`08:00:07.155` 相当のフレーム。fixture [`permission-asked.json`](../../tests/fixtures/hooks/opencode/permission-asked.json)）:

```json
{ "id": "evt_…", "type": "permission.asked",
  "properties": {
    "id": "per_…",                                  // ← permissionID。REST の path に使う
    "sessionID": "ses_…",
    "permission": "external_directory",             // ← 承認の種別
    "patterns": ["/tmp/*"],
    "metadata": { "command": "touch /tmp/cmate-oc-spike-marker.txt && ls -l …",
                  "directories": ["/tmp"], "patterns": ["/tmp/*"] },
    "always": ["/tmp/*"],                           // ← "always" を選んだときに保存されるルール
    "tool": { "messageID": "msg_…", "callID": "toolu_…" } } }
```

- **ツール名は入っていない。** `tool.callID` で `message.part.updated`（`part.type === "tool"`、`part.tool === "bash"`）と突き合わせる必要がある。
  Auto-Yes が「どのツールか」で判断するなら **`callID` の相関が必須**（`metadata.command` は `bash` のときだけある）。
- **同じものを `GET /permission` でポーリング取得できる**（SSE を取り逃しても回収可能。[§5.7](#57-項目-7--接続の生存管理と再接続) の再接続戦略の土台）。

```bash
curl -sS http://127.0.0.1:4788/permission
# [{"id":"per_…","sessionID":"ses_…","permission":"external_directory","patterns":["/tmp/*"], …}]
```

- **`permission.v2.asked` は 1 件も来なかった**（型定義にはある。D4）。
- `GET /api/permission/saved` は `{"data":[]}` の形（legacy `/permission` は素の配列）。**同じ族の endpoint で envelope が違う。**

---

### 5.5 項目 5 — 承認裁定の応答と、no-decision の実際の意味

#### 5.5.1 REST で裁定できる（Issue 記載の endpoint はそのまま使える）

```bash
curl -sS -w "HTTP %{http_code} time=%{time_total}\n" \
  -X POST -H 'Content-Type: application/json' -d '{"response":"once"}' \
  "http://127.0.0.1:4788/session/ses_…/permissions/per_…"
# true
# HTTP 200 time=0.004788
```

| 結果 | 実測 |
|---|---|
| pane | `△ Permission required` が消え、`$ touch …` の下に `-rw-r--r--@ 1 … /tmp/cmate-oc-spike-marker.txt` が出た |
| ファイル | 実際に作成された |
| SSE | `07:59:24.806 permission.replied { requestID, reply: "once" }` → `07:59:27.659 session.idle` |
| `GET /permission` | `[]`（pending から消えた） |

**裁定は 3 値**（`once` / `always` / `reject`）。Claude の `allow` / `deny` の 2 値に対して `always` が増えている。

| 応答 | 実測 |
|---|---|
| `{"response":"once"}` | 実行される。次に同じことをすれば再び訊かれる |
| `{"response":"always"}` | 実行される。`always` の pattern が以降許可される。**ただし `GET /api/permission/saved` は空のままだった**（永続化されているのは別の場所か、プロセス内のみ） |
| `{"response":"reject"}` | 実行されない。tool part が `status: "error"` になる |

#### 5.5.2 拒否理由はエージェントに届く（endpoint によってはキー名が違う — D6）

別経路 `POST /permission/:requestID/reply` はボディのキーが **`reply`** で、`message` を添えられる。

```bash
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"reply":"reject","message":"rejected by CommandMate spike"}' \
  "http://127.0.0.1:4788/permission/per_…/reply"
# true / HTTP 200
```

pane:

```
     $ touch /private/tmp/cmate-oc-nodecision.txt
     The tool call was rejected — permission was denied by CommandMate spike.
     ▣  Build · Claude Sonnet 4.6 · 10m 23s
```

SSE の tool part（fixture [`message-part-updated-tool-error.json`](../../tests/fixtures/hooks/opencode/message-part-updated-tool-error.json)）:

```json
"state": { "status": "error",
           "input": { "command": "touch /private/tmp/cmate-oc-nodecision.txt" },
           "error": "The user rejected permission to use this specific tool call with the following feedback: rejected by CommandMate spike" }
```

→ Claude の `deny` の `message` と同じく、**渡した文字列がそのままエージェントに見える。**
ファイルは作成されなかった（`ls: /private/tmp/cmate-oc-nodecision.txt: No such file or directory`）。

| endpoint | ボディ | `message` |
|---|---|---|
| `POST /session/:sessionID/permissions/:permissionID` | `{"response": "once"\|"always"\|"reject"}` | **渡せない** |
| `POST /permission/:requestID/reply` | `{"reply": "once"\|"always"\|"reject", "message"?: string}` | 渡せる |
| `POST /api/session/:sessionID/permission/:requestID/reply` (v2) | `{"reply": …, "message"?: string}` | 型定義のみ（v2 は未観測） |

#### 5.5.3 **no-decision の実際の意味 — タイムアウトは無い。TUI へ「落ちる」のではなく最初から並行している**

**Issue の想定（hooks 型の「黙れば TUI に落ちる」）は成立しない。** 実測は次のとおり。

1. **TUI ダイアログは `permission.asked` と同時に無条件で描かれる。** CommandMate の応答を待ってから出るのではない。
   [§5.4](#54-項目-4--承認要求の受信) の pane capture は、REST で何も返していない時点のものである。
2. **タイムアウトは存在しない。** `08:00:07.155` に発火した承認要求を放置し、
   `08:10:26.253` に裁定するまで **10 分 19 秒**、`GET /permission` は pending 1 件のまま、
   SSE にタイムアウトイベント・自動裁定イベントは**一切出なかった**。TUI 側は経過時間を数え続け、最終的に `10m 23s` と表示した。
3. **したがって「no-decision フォールバック」という段階は無く、REST と TUI は最初から並行して開いている。**
   先に答えた方が勝つ **レース**である（REST で答えると TUI のダイアログが消えることを [§5.5.1](#551-rest-で裁定できるissue-記載の-endpoint-はそのまま使える) で確認済み）。

**#1763 の Auto-Yes 安全性への含意（Claude と逆になる 2 点）**:

| | Claude（hooks / #1721） | **opencode（本スパイク）** |
|---|---|---|
| CommandMate が黙ったとき | `{}` を返す・timeout する・接続不能 — **すべて fail-open**。TUI ダイアログに落ちてエージェントは進める | **エージェントは無限に待つ。** ダイアログは出ているので**人間が居れば**答えられるが、**無人運転では永久停止** |
| CommandMate が誤って allow したとき | `AskUserQuestion` は allow しても選択画面が残る＝人間の確認を突破できない | **`once` を返した瞬間にダイアログが消える。** 人間が読む前に消える競合が起こりうる |

→ **Auto-Yes v2 の opencode 実装では「判断できないときは黙る」が安全側ではない。**
`stop-pattern` に当たった等で裁定を見送る場合、**「見送った」ことを利用者に見せる**（`wait` の出力・UI）必要がある。
黙って落ちると、hooks 側と違って**セッションが静かに止まる**。
（Claude 側で `denyPatterns` が pane scrollback を汚染して worker が 1 時間沈黙した #1699 と同型の事故が、
opencode では**より簡単に**起きる。あちらは抑止理由の出力で解決している。）

---

### 5.6 項目 6 — インスタンス相関

#### 5.6.1 1 サーバに複数 session を載せられる（実測）

同一 serve（4788）に対して 2 つ目の TUI を `attach` し、それぞれ別のプロンプトを流した。

```bash
curl -sS http://127.0.0.1:4788/session/status
# {"ses_…001":{"type":"busy"},"ses_…002":{"type":"busy"}}      ← 同時に busy
```

SSE 上でも `sessionID` で完全に分離されている（[§5.3.1](#531-暇ではなくターン終了である証拠) のタイムラインで
`ses_…001` の承認待ちと `ses_…002` の質問・idle が混ざりながら別々に追えている）。

**2 つ目の `attach` は既存 session に勝手に参加しない。** セッション未選択の空の状態で起動し、
最初のプロンプトで新しい session を作る（＝ラウンド 1 の pending 承認ダイアログは 2 つ目の TUI には出なかった）。

#### 5.6.2 対応表の作り方 — 2 通りとも実測で成立

**(A) 事前に session を作って `-s` でバインドする**

```bash
SID=$(curl -sS -X POST -H 'Content-Type: application/json' -d '{"title":"cmate-instance-2"}' \
        http://127.0.0.1:4788/session | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# attach でも素の TUI でも同じ
opencode attach http://127.0.0.1:4788 -s "$SID"
opencode --port 4792 --hostname 127.0.0.1 -s "$SID"
```

TUI の右パネルに指定した `title`（`cmate-instance-2`）が出た。プロンプトを流すと**すべてのイベントが `$SID` に落ちた**
（`session.created` は**発火しない**）。

```
08:18:50.060 message.updated ses_007bae2e1ffeXvQxEqEEtNLUBz     ← 事前に作った SID そのもの
08:18:50.060 session.status  ses_007bae2e1ffeXvQxEqEEtNLUBz
…
```

**(B) 1 インスタンス = 1 ポートにして、そのポートの `session.created` を自分のものとみなす**（**推奨**）

素の TUI に `--port` を付ける構成では 1 プロセス 1 ポートなので、
**当該ポートの `/event` に流れる `session.created` は一意に自分の instance のもの**になる。
事前作成が要らず、サーバ未起動時の順序問題（POST する相手が居ない）も起きない。

#### 5.6.3 **`GET /session` は「このサーバの session」ではない**（重要な落とし穴）

4788 で `GET /session` を叩くと、**4790 の serve が作った session まで返ってきた。**

```
ses_…  | Greeting          ← 4790 で作った
ses_…  | plugin-probe      ← 4790 で作った
ses_…  | PONG-A            ← 4788 で作った
ses_…  | cmate-instance-2  ← 4788 で作った
```

同一 `HOME` かつ同一 project directory なので `~/.local/share/opencode/opencode.db` を共有しており、
**session はサーバプロセスではなく (HOME, project) に属する。**

→ **`GET /session` を「自分の instance 一覧」として使ってはいけない。**
CommandMate は自前で `instanceId ↔ sessionID` を持つこと（既存の instance roster に列を足す）。

#### 5.6.4 `/exit` はイベントを出さない（`session_end` の不在）

attach した TUI に `/exit` を送った。

| 観測 | 結果 |
|---|---|
| tmux セッション | 終了した（既存 `killSession` と整合） |
| SSE（heartbeat 以外） | **0 件** |
| `GET /session` | 当該 session は**残っている** |

`session.deleted` が出るのは `DELETE /session/:id` を明示的に呼んだときだけ。

```bash
curl -sS -X DELETE http://127.0.0.1:4788/session/ses_…
# true / HTTP 200
# => 08:12:57.043 session.deleted { sessionID, info: { … } }
```

→ **`session_end` に相当する「エージェントが終わった」イベントは存在しない。** プロセス終了の検知は tmux 側に残す。
逆に、CommandMate が instance を破棄するときに `DELETE /session/:id` を呼ぶかどうかは**設計判断**
（呼ばないと `opencode.db` に session が溜まり続ける。`opencode session list` / `opencode session delete <id>` という CLI もある）。

---

### 5.7 項目 7 — 接続の生存管理と再接続

#### 5.7.1 `server.heartbeat` が 10 秒周期の死活 signal

10 分間の tap から heartbeat だけ抜いて間隔を測った。

```
heartbeats: 60  first: 07:57:27.902  last: 08:07:18.393
gap histogram: [(10.01, 28), (10.00, 20), (10.02, 10), (10.03, 1)]
```

**きれいに 10 秒周期。** これが「SSE が生きている」ことの signal。
ただし [§5.2.1](#521-全列挙と実観測) のとおり **`server.heartbeat` は `/doc` の Event union に含まれていない**（D5）ので、
生成型に頼ると unknown で落ちる。

→ **`wait` / 監視側は「25〜30 秒 heartbeat が来なければ購読が死んだ」と判定できる。**

#### 5.7.2 サーバ消滅時の挙動

| 状況 | 実測 |
|---|---|
| 購読中に serve を SIGTERM | SSE が即 close。`curl: (18) transfer closed with outstanding read data remaining`。**クリーンな EOF ではない** |
| サーバ不在で接続 | `curl: (7) Failed to connect to 127.0.0.1 port 4789 after 0 ms`。HTTP `000`。**1ms 未満で失敗** |

→ **不在判定はほぼ無コスト。** ポーリング間隔ごとに `GET /global/health` を撃っても負荷にならない。

```bash
curl -sS http://127.0.0.1:4788/global/health
# {"healthy":true,"version":"1.18.3"}       ← 版まで取れる
```

#### 5.7.3 `attach` した TUI はサーバの死を画面に出さない

serve を kill してから attach 済み TUI の pane を見た。

```
        （スプラッシュのまま。エラーも警告も再接続バナーも無い）
  ┃  Ask anything... "What is the tech stack of this project?"
  ┃  Build · Claude Sonnet 4.6 GitHub Copilot
   …/scratchpad/work:master
```

プロンプトを打って Enter を押しても**何も起きない**（テキストはコンポーザに残り、エラーも出ない）。
つまり **pane からは「正常に入力待ち」と区別できない。**

**そして同じポートで serve を再起動すると、同じ TUI が無言で自動再接続して復帰した。**

```
（4790 で serve 再起動 → 同じ pane で Enter）
     Yes, I'm here. How can I help you?
     ▣  Build · Claude Sonnet 4.6 · 4.8s
```

→ 良い面: **serve の再起動を TUI が生き延びる。** 悪い面: **scraper ではサーバの死を検知できない。**
[§2](#2-検証項目-1-の-gono-go-判断) で serve+attach を採らない理由がこれ（素の TUI 構成なら「サーバが死ぬ = TUI が死ぬ」になり、この中間状態が消える）。

#### 5.7.4 再接続戦略（`?after=<seq>` が使えないので）

[§5.2.2](#522-legacy-event-と-apievent-の違いと-apievent-が使えない理由) のとおり durable replay は 1.18.3 では 0 バイトなので、
**取りこぼしは REST スナップショットで埋める**。

| 埋めたいもの | 再接続直後に叩く |
|---|---|
| 未処理の承認要求 | `GET /permission`（pending 一覧。**これがあるので承認は取りこぼしても回収できる**） |
| 未処理の質問 | `GET /question` |
| 各 session の busy/idle | `GET /session/status` → `{"ses_…":{"type":"busy"|"idle"}}` |
| session 一覧 | `GET /session`（ただし [§5.6.3](#563-get-session-はこのサーバの-session-ではない重要な落とし穴) の注意） |

**`session.idle` の取りこぼしだけは回収できない**（イベントであってステートではない）。
`GET /session/status` が `idle` を返せば「今は idle」は分かるが、「切断中にターンが終わった」との区別はつかない。
→ **`wait` は SSE 断を「不明」として扱い、`session.status` の polling へ縮退すること。**

---

### 5.8 項目 8 — 認証

#### 5.8.1 既定は無認証（stderr に警告）

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:4788
```

**この警告は毎回 stderr の第 1 行に出る。** ポート番号の行と一緒に来るので、
stdout/stderr をパースして実ポートを取るコードは**警告行を読み飛ばす**必要がある（[§5.9](#59-項目-9--ポート衝突と実ポートの知り方)）。

#### 5.8.2 `OPENCODE_SERVER_PASSWORD` を渡すと HTTP Basic

```bash
HOME="$SP/home" OPENCODE_SERVER_PASSWORD='spike-pw-1234' opencode serve --port 4789 --hostname 127.0.0.1 &
```

| リクエスト | 結果 |
|---|---|
| 資格情報なし | `HTTP 401` ＋ `www-authenticate: Basic realm="Secure Area"` |
| `-u opencode:wrong` | `HTTP 401` |
| `-u opencode:spike-pw-1234` | `{"healthy":true,"version":"1.18.3"}` |
| `-u opencode:spike-pw-1234` で `/event` | `data: {"id":"evt_…","type":"server.connected",…}`（**SSE も Basic で通る**） |

- user 名の既定は **`opencode`**（`OPENCODE_SERVER_USERNAME` で変更可）。`attach` 側も `-u` / `-p` を持つ。
- **`CM_AUTH_TOKEN` とは無関係な別系統。** opencode サーバは CommandMate の認証機構を知らない。

#### 5.8.3 外部露出しないことの確認

`--hostname` 既定 `127.0.0.1` で LAN IP から接続不可（実測）。

```bash
ipconfig getifaddr en0            # 192.168.11.6
curl -m 4 http://192.168.11.6:4788/global/health
# curl: (7) Failed to connect to 192.168.11.6 port 4788 after 1 ms
```

→ **#1763 は `--hostname` を指定しない（既定の `127.0.0.1` に任せる）か、明示的に `127.0.0.1` を渡すこと。**
`--mdns` は「hostname を `0.0.0.0` に既定変更する」と `--help` に書かれている。**絶対に付けない**（無認証のサーバが LAN に出る）。
CommandMate サーバと opencode サーバは同一ホスト上なので、`OPENCODE_SERVER_PASSWORD` は
「ローカルの他プロセスからの誤接続を防ぐ」目的なら意味があるが、必須ではない（loopback + パスワード無しが opencode の既定運用）。

---

### 5.9 項目 9 — ポート衝突と実ポートの知り方

#### 5.9.1 `--port 0` は「自動割当」ではない

`--help` は `--port [number] [default: 0]` と書いているが、**0 は「OS に空きを訊く」意味ではない。**

```bash
HOME="$SP/home" opencode serve --port 0 --hostname 127.0.0.1 &
# opencode server listening on http://127.0.0.1:4096          ← 1 本目は 4096
lsof -nP -iTCP:4096 -sTCP:LISTEN
# opencode 37343 … TCP 127.0.0.1:4096 (LISTEN)

HOME="$SP/home" opencode serve --port 0 --hostname 127.0.0.1 &
# opencode server listening on http://127.0.0.1:58153         ← 2 本目は ephemeral に落ちた
```

→ **`--port 0` の意味は「まず 4096 を試し、埋まっていたら OS に任せる」。**
複数 worktree × 複数インスタンスで無指定に立てると、**1 本目だけが 4096 を掴み、残りは予測不能なポートに散る。**

#### 5.9.2 実ポートを知る手段は 2 つだけ

隔離 HOME 配下を検索したが、**ポートファイル・ロックファイル・PID ファイルは書かれていない**
（`~/.local/state/opencode/locks/` は空。他は `model.json` と `prompt-history.jsonl` のみ）。

| 手段 | 内容 |
|---|---|
| **stdout の 1 行** | `opencode server listening on http://127.0.0.1:<port>`。ただし **stderr に警告行が先に出る**（[§5.8.1](#581-既定は無認証stderr-に警告)） |
| **`lsof`** | `lsof -nP -p <pid> -a -iTCP -sTCP:LISTEN`（`-a` を忘れると全プロセスが出る） |

→ **結論: CommandMate 側で明示的にポートを割り当てる。** これが唯一の安全策で、
既に `commandmate start --issue N --auto-port` でポートを割り当てる仕組みがあるので、そこに相乗りする。
**opencode 側の自動割当に依存すると、CommandMate は自分の立てたサーバのポートを知る信頼できる手段を持たない。**

（Issue の「既知の罠」が懸念する二重管理は、**CommandMate 側の一元管理に寄せることで解消する** — opencode 側の
割当を読む経路を作らなければ二重にならない。）

---

### 5.10 項目 10 — plugin 方式との比較

### 結論: **server API を採る。plugin は採用しない。**

#### 5.10.1 plugin は動く（ローカル JS ファイルで可）

`opencode plugin <module>` は npm モジュールを config に書き込むコマンドだが、**config に直接ローカルパスを書ける。**

```jsonc
// $SP/home/.config/opencode/opencode.jsonc
{ "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/claude-sonnet-4.6",
  "plugin": ["./plugin/cmate-probe.js"] }
```

```bash
curl -sS http://127.0.0.1:4790/config | python3 -c 'import json,sys;print(json.load(sys.stdin)["plugin"])'
# ['file:///…/home/.config/opencode/plugin/cmate-probe.js']     ← 解決されている
```

<details>
<summary>使用した probe plugin（<code>cmate-probe.js</code>）</summary>

```js
import { appendFileSync } from "node:fs";
const LOG = process.env.CMATE_PLUGIN_LOG || "/tmp/cmate-plugin-probe.log";
const w = (tag, obj) => { try { appendFileSync(LOG, JSON.stringify({ tag, at: new Date().toISOString(), obj }) + "\n"); } catch {} };
export const CmateProbe = async (input) => {
  w("init", { keys: Object.keys(input ?? {}), directory: input?.directory, worktree: input?.worktree });
  return {
    event: async ({ event }) => w("event", { type: event?.type }),
    "permission.ask": async (permission, output) => w("permission.ask", { permission, output }),
    "tool.execute.before": async (input, output) => w("tool.execute.before", { input }),
    "tool.execute.after": async (input, output) => w("tool.execute.after", { input }),
  };
};
```
</details>

観測できた invocation:

```
23:07:49.021  init                  keys = [client, project, worktree, directory,
                                            experimental_workspace, serverUrl, $]
23:08:18.100  tool.execute.before   { tool: "bash", sessionID: "ses_…", callID: "toolu_…" }
23:11:00.035  tool.execute.after    { tool: "bash", sessionID: "ses_…", callID: "toolu_…",
                                      args: { command: "touch /private/tmp/cmate-oc-plugin.txt" } }
```

`init` の引数に **`client`（SDK クライアント）と `serverUrl` が入っている**ので、plugin から REST を叩くこともできる。

#### 5.10.2 しかし採用しない理由（3 つ、いずれも実測）

**(1) `event` フックの語彙は SSE と同一で、情報が 1 つも増えない**

plugin が受け取ったイベント種別（`plugin.added` を除く）:

```
2 catalog.updated   1 integration.updated   4 message.part.updated   3 message.updated
1 permission.asked  1 reference.updated     1 session.created        1 session.diff
2 session.status    3 session.updated
```

SSE で見えるものと**完全に同じ**。plugin にしかない情報は無い。

**(2) 承認を裁定する plugin フックが存在しない**

`permission.ask` を登録したが **`permission.asked` イベントが出ているのに 0 回**しか呼ばれなかった。
バイナリを調べると、**`"permission.ask"` という文字列自体が 1.18.3 に存在しない。**

```bash
strings -a ~/.opencode/bin/opencode | grep -c 'permission\.ask"'
# 0
strings -a ~/.opencode/bin/opencode | grep -oE '"[a-z]+\.execute\.(before|after)"'
# "command.execute.before"
# "tool.execute.after"
# "tool.execute.before"
```

**plugin の hook 面は `event` / `tool.execute.before` / `tool.execute.after` / `command.execute.before` だけで、
承認の裁定は含まれない。** 承認を返せるのは REST endpoint のみ。
→ Phase 4-5（Auto-Yes）の中核が plugin では実装できない。**これが決定的な理由。**

**(3) 導入コストと非汚染性で劣る**

| | plugin | server API |
|---|---|---|
| 導入 | `opencode.jsonc` の `plugin` 配列に書き込む＝**ユーザーの設定ファイルを書き換える** | **書き換え不要**。`--port` 引数だけ |
| 配布 | JS ファイルを worktree か config dir に置く。opencode の版差でフックの signature が変わる | HTTP/JSON。OpenAPI が付いてくる |
| プロセス | opencode プロセス内。plugin の例外が opencode に影響しうる | 別プロセス。CommandMate が落ちても opencode は動く |
| CommandMate との通信 | plugin から CommandMate へ HTTP を張り直すことになる（結局 HTTP） | 直接 |

`ensureOpencodeConfig()`（`src/lib/cli-tools/opencode-config.ts`）は既に `opencode.json` を生成しているので
plugin を書き込む前例はある。**しかし (2) だけで plugin は候補から外れる。**

---

## 6. 未実施・積み残し

「実測済み」と誤解されないよう明示する。**検証項目 1〜10 のセルはすべて埋まっている**（[§1](#1-結論サマリ)）が、
その内側で確認しきれなかったものが以下。

| 項目 | 状態 | 理由 |
|---|---|---|
| `permission.v2.*` / `question.v2.*` / `session.next.*` の payload | **未採取** | 1.18.3 の legacy `/event` に流れず、`/api/event` は 3 件で沈黙する（[§5.2.2](#522-legacy-event-と-apievent-の違いと-apievent-が使えない理由)）。**v2 が使えないという事実自体が成果物** |
| `installation.update-available`（update banner 相当） | **未計測** | 更新保留状態を作れなかった（#1721 の update banner と同じ理由）。型定義には `{version}` があるので**存在は確実**だが発火条件は未確認 |
| `session.compacted` / `/session/:id/summarize` | **未計測** | context 溢れを起こす必要があり本スパイクの尺に合わない |
| `--port 0` の 3 本目以降 / ephemeral 範囲 | **2 本まで** | 4096 → 58153 を確認。**明示指定に寄せる**結論が出たため深追いしていない |
| `always` の永続化先 | **未特定** | `always` を返すと許可は効くが `GET /api/permission/saved` は空だった（[§5.5.1](#551-rest-で裁定できるissue-記載の-endpoint-はそのまま使える)）。プロセス内のみか別ストアかは未確認。**Auto-Yes は `always` を使わず `once` を使うのが安全** |
| `--pure` / MCP / LSP 有効時のイベント差 | **未計測** | LSP は `LSPs are disabled` の状態で全実測を行った |
| Ollama / LM Studio provider での挙動差 | **一部のみ** | LM Studio では model 未ロードで `session.error` になった（これ自体は §5.3.2 の証拠として使った）。CommandMate の既定は Ollama / LM Studio なので、**#1763 は local provider でも 1 度は通すこと** |
| dev モードでの購読二重化 | **未検証** | Next.js 側の話でコード変更を伴うため #1763 のスコープ。#1736 の前例（`globalThis` 非経由の in-memory 状態が dev で無言に壊れる）を踏まえること |
| 複数 worktree（別 project）での `opencode.db` 共有 | **未検証** | 同一 project で共有されることは確認した（[§5.6.3](#563-get-session-はこのサーバの-session-ではない重要な落とし穴)）。別 project 間でどう分離されるかは未確認 |
| 対応バージョンレンジ | **1.18.3 のみ** | 手元に 1 版しかない。**「1.18.3 で動作」を前提とし、レンジを広く仮定しないこと** |

---

## 7. 非汚染の証拠

### 7.1 opencode のユーザー設定（before / after diff が空）

全検証（serve 6 プロセス ＋ TUI 5 セッション ＋ REST 呼び出し多数 ＋ plugin ロード）を通して、
**すべて隔離 HOME（`$SP/home`）で実行した。**

```bash
# ~/.config/opencode/opencode.jsonc
diff "$SP/baseline/opencode.jsonc.before" ~/.config/opencode/opencode.jsonc && echo "OPENCODE_JSONC_DIFF_EMPTY"
# => OPENCODE_JSONC_DIFF_EMPTY
```

```bash
# sha256（検証前 / 検証後で完全一致）
4e901f9e457c8d52ab31f9fb4ea637a8c9104ebdbf23fe8b3600f35ad46d4a61  ~/.config/opencode/opencode.jsonc
b6ebd9719f8c08ec08e82386fa70b3f7bdaf2be4ca0a570c7ec9bd95ffbdd201  ~/.config/opencode/package.json
eec9856e414d105f1026abd4322f340f2ef3d7b568b7521ca86dc7de6ec5e482  ~/.local/share/opencode/auth.json
```

```bash
# ディレクトリ構成の diff（log/ を除く）
diff share-listing.before share-listing.after && echo "SHARE_LISTING_DIFF_EMPTY"    # => SHARE_LISTING_DIFF_EMPTY
diff config-listing.before config-listing.after && echo "CONFIG_LISTING_DIFF_EMPTY" # => CONFIG_LISTING_DIFF_EMPTY
```

```bash
# mtime（すべて検証開始 2026-08-13 07:54 より前のまま）
ls -lT ~/.local/share/opencode/opencode.db ~/.local/share/opencode/auth.json ~/.config/opencode/opencode.jsonc
# 7月 19 23:54:56 2026  ~/.config/opencode/opencode.jsonc
# 3月  6 09:23:02 2026  ~/.local/share/opencode/auth.json
# 7月 19 23:56:37 2026  ~/.local/share/opencode/opencode.db        ← 58MB の実 DB。1 バイトも触っていない
```

**`~/.config/opencode/opencode.jsonc` と `~/.local/share/opencode/` の before/after diff は空。**
隔離が効いていることは `GET /path` の応答（[§4.1](#41-隔離-home)）でも裏取りしてある。
モデルピッカーは**一度も開いていない**（config で固定した）。
隔離 HOME に複製した `auth.json`（mode 600）は検証後に scratchpad ごと破棄される。

### 7.2 tmux

- すべて `tmux -L cmate-p4spike-oc` の**専用 socket 上**（#1757 の `cmate-p4spike` とは別 socket）。
- **`kill-server` は使用していない。** 後始末は `kill-session -t '=<name>:'`（完全一致）のみ。
- 検証後、専用 socket は `no server running on /private/tmp/tmux-501/cmate-p4spike-oc`。
- **既定 socket 上のユーザーセッション（`mcbd-*` 10 本）は全て健在**であることを `tmux list-sessions` で確認済み。
- `bind-key` / `unbind-key` / `set-option -g` は撃っていない。

### 7.3 プロセスとポート

- **3000 番（ユーザーの稼働中 CommandMate 本番サーバ）には 1 リクエストも送っていない。**
  検証後の確認: `node 21576 … TCP 127.0.0.1:3000 (LISTEN)` / `curl 127.0.0.1:3000 → HTTP 200`。
- 立てた serve は **PID を控えて個別 kill**（`pkill -f opencode` のような広域 kill は使用していない）。
  検証後 `ps -eo pid,command | grep -E 'opencode (serve|attach|--port)'` → **NONE**、4096/4788/4789/4790/4791/4792 すべて解放。
- probe で作った `/tmp/cmate-oc-*.txt` は削除済み。

### 7.4 リポジトリ

- **`src/` 配下の変更は 0 件。** 本コミットで触るのは `docs/design/` と `tests/fixtures/hooks/opencode/` と `CHANGELOG.md` のみ。
- fixture は実 ID / 実パス / ユーザー名がプレースホルダに置換されていることを `grep` で確認済み
  （`grep -rlE 'maenokota|ses_007|per_ff|que_ff|msg_ff|prt_ff|evt_ff|toolu_bdrk|/private/tmp/claude-501'` → 該当なし）。

---

## 8. Issue #1758 の「既知の罠」への回答

| Issue が挙げた罠 | 実測を踏まえた回答 |
|---|---|
| 「serve/attach へ変えるのは**起動経路の変更**であり、既存の `killSession`（`/exit` 送出）や初期化待ちループとの整合を確認する必要がある」 | **serve/attach へ変えないので問題にならない**（[§2](#2-検証項目-1-の-gono-go-判断) / D1）。素の TUI に `--port <N>` を足すだけで、`killSession` の `/exit`・`OPENCODE_INIT_WAIT_MS` の初期化待ち・`reconcileExistingSession` は変更不要。なお `attach` した TUI でも `/exit` は正常に効き tmux セッションが終了することを実測済み（[§5.1.1](#511-serve--attach-は成立する)） |
| 「`opencode --port` の既定は 0（自動割当）。CommandMate は既に worktree ごとにポートを扱う仕組みを持つので、二重管理にならないか確認する」 | **既定 0 は自動割当ではなく「4096 優先 + ephemeral 退避」**（D3）。**CommandMate 側で明示指定すれば二重管理は起きない**（opencode の割当を読む経路を作らないため）。逆に**明示しないと実ポートを知る信頼できる手段が無い**（[§5.9](#59-項目-9--ポート衝突と実ポートの知り方)） |
| 「SSE の購読は Next.js のサーバプロセス内に持つことになる。dev モードでモジュールが再評価されると購読が二重化・消失する（#1736 の前例）」 | **実測していない（#1763 のスコープ）が、懸念は妥当。** 購読レジストリは `globalThis` 経由で持つこと。加えて **`/event` は同一サーバに複数の購読を許す**（本スパイクで legacy と v2 を同時に張れた）ので、**二重購読はサーバ側では検出されず、イベントが 2 倍で届く形で顕れる**。購読の重複排除は CommandMate 側の責務 |

---

## 9. Phase 4-1（#1759 抽象抽出）への要求事項（**最重要**）

**本スパイクの最重要成果物。** `AgentEventSource` は push 型（hooks）だけでなく **pull 型（SSE 購読 + REST 応答）も表現できなければならない。**
実測から導かれる制約と、それを満たす I/F 案を示す。

### 9.1 実測から導かれる 8 つの制約

| # | 制約 | 根拠 |
|---|---|---|
| **C1** | **イベントの到着方向が逆。** hooks は「エージェント → CommandMate の HTTP POST」で、受け口は `route.ts` 1 本あればよい。opencode は「CommandMate → エージェントへ長時間の GET を張る」。**購読の開始・停止・再接続というライフサイクルが抽象に要る** | [§5.2](#52-項目-2--イベント語彙) |
| **C2** | **裁定の返し方が違う。** hooks は「受け取った HTTP リクエストのレスポンス body」で返す（同期・1 往復）。opencode は**別の REST 呼び出し**で返す（非同期・別コネクション）。**「イベントに対して答える」ことを、レスポンス body に限定しない形で表現する必要がある** | [§5.5](#55-項目-5--承認裁定の応答と-no-decision-の実際の意味) |
| **C3** | **fail 方向が逆。** hooks は無応答が fail-**open**（エージェントは進む）。opencode は無応答が **無限待ち**（タイムアウト無し、10 分 19 秒実測）。**「答えないことの意味」がソースごとに違うので、抽象がそれを宣言できなければならない** | [§5.5.3](#553-no-decision-の実際の意味--タイムアウトは無いtui-へ落ちるのではなく最初から並行している) |
| **C4** | **7 語への写像が 1:1 でない。** `pre_tool_use` / `post_tool_use` は「同一イベント種別の状態フィールド違い」、`user_prompt_submit` は「複数イベントの合成」、`notification` は「3 つの別イベントの束」、`session_end` は**不在**。**変換は「名前の対応表」では足りず、述語つきのマッパが要る** | [§5.2.3](#523-agent_event_types-7-語へのマッピング) |
| **C5** | **相関キーがソースごとに違う。** Claude は `session_id`（`/clear` で変わる）＋ `prompt_id`。opencode は `sessionID`（安定）＋ tool は `callID`。**instance への紐付けは抽象の外（レジストリ）で決める必要がある**。加えて opencode では `GET /session` が他プロセスの session まで返す | [§5.6](#56-項目-6--インスタンス相関) |
| **C6** | **接続の健全性という概念が opencode にだけある。** `server.heartbeat` 10 秒周期、断は `ECONNREFUSED`。**「このソースは今生きているか」を問える必要がある**（hooks は常に「不明」でよい） | [§5.7](#57-項目-7--接続の生存管理と再接続) |
| **C7** | **取りこぼしの回収手段がソースごとに違う。** hooks は取りこぼしたら失われる。opencode は `GET /permission` / `GET /question` / `GET /session/status` でステートを引き直せる（が `session.idle` は引き直せない）。**「再同期」を任意操作として持てる形が要る** | [§5.7.4](#574-再接続戦略-aftersecq-が使えないので) |
| **C8** | **未知のイベントを捨ててはいけない。** `/doc` の Event union に `server.heartbeat` が無いのに実際は流れる。opencode の 89 種は今後も増える。**未知の `type` は例外にせず無視する（そして数える）** | [§5.2.1](#521-全列挙と実観測) / D5 |

### 9.2 I/F 案

```ts
// src/lib/agents/agent-event-source.ts（#1759 で新設される想定）

/**
 * どちらの向きでイベントが届くか。C1。
 *
 * - 'push' … エージェントが CommandMate へ POST する（Claude / codex / gemini / copilot / agy の hooks）。
 *            受け口は既存の route。ソースは「登録されている」だけで、開始も停止もない。
 * - 'pull' … CommandMate がエージェントの HTTP サーバへ購読を張る（opencode の GET /event）。
 *            開始・停止・再接続・健全性というライフサイクルを持つ。
 */
export type AgentEventTransport = 'push' | 'pull';

/**
 * 裁定しなかったとき何が起きるか。C3。**この 1 フィールドが Auto-Yes の安全性設計を決める。**
 *
 * - 'proceeds'      … エージェントは通常フローへ進む（Claude: 空応答 / timeout / 接続不能すべてこれ）。
 *                     「判断できないときは黙る」が安全側に倒れる。
 * - 'blocks'        … エージェントは無期限に待つ（opencode: タイムアウト無し、10m19s 実測）。
 *                     黙るとセッションが静かに止まる。**見送りを利用者に見せる責務が呼び出し側に生じる。**
 * - 'blocksUntil'   … 待つが上限がある（該当ソースは現時点で無い。将来 opencode が付けたとき用）。
 */
export type NoDecisionBehavior =
  | { kind: 'proceeds' }
  | { kind: 'blocks' }
  | { kind: 'blocksUntil'; timeoutMs: number };

/** 正規化済みイベント。7 語 + ソース固有の生 payload。 */
export interface NormalizedAgentEvent {
  event: AgentEventType;              // AGENT_EVENT_TYPES の 7 語
  detail: string | null;              // extractClaudeEventDetail 相当（tool 名 / reason / notification 種別）
  /** instance を引くための、ソース内での会話単位の ID。Claude: session_id / opencode: sessionID。C5 */
  conversationId: string | null;
  /** tool 呼び出しの相関キー。Claude: tool_use_id（無い場合あり）/ opencode: part.callID。C5 */
  toolCallId: string | null;
  /** 検証・fixture 化のために捨てない生データ。 */
  raw: Record<string, unknown>;
  receivedAt: number;
}

/** 人間の判断を求められている、という 1 件。承認と質問を同じ形で扱う。 */
export interface PendingDecision {
  kind: 'permission' | 'question';
  /** 裁定 REST の path に入る ID。opencode: per_… / que_…。push 型では hook の呼び出し ID。 */
  id: string;
  conversationId: string;
  /** 承認: 実行しようとしているもの（opencode の metadata.command 等）。質問: 質問文と選択肢。 */
  subject: PermissionSubject | QuestionSubject;
  raw: Record<string, unknown>;
  askedAt: number;
}

/** 裁定。opencode の 3 値（once/always/reject）と Claude の 2 値（allow/deny）を包含する。 */
export type Verdict =
  | { kind: 'allowOnce' }
  | { kind: 'allowAlways' }                       // opencode の "always"。Claude には対応が無い
  | { kind: 'deny'; message?: string }            // message は opencode の /permission/:id/reply と Claude の deny 双方で使う
  | { kind: 'answer'; answers: string[][] }       // question 用（opencode の QuestionAnswer[]）
  | { kind: 'abstain' };                          // 裁定しない。**意味は noDecision で決まる。C3**

/** 購読の健全性。C6。 */
export type SourceLiveness =
  | { state: 'unknown' }                                   // push 型は常にこれ
  | { state: 'live'; lastHeartbeatAt: number }             // opencode: server.heartbeat（10s 周期）
  | { state: 'lost'; since: number; reason: string };      // ECONNREFUSED / SSE close

export interface AgentEventSource {
  readonly cliToolId: CLIToolType;
  readonly transport: AgentEventTransport;                 // C1
  readonly noDecision: NoDecisionBehavior;                 // C3

  /**
   * 購読を開始する。
   * push 型は no-op に近い（登録を確認して返す）。pull 型は SSE を張る。
   *
   * onEvent には**正規化済みイベントだけ**が渡る。7 語に写らない生イベントは
   * ここで落ちるが、**未知の type は例外にせず捨てて数える**（C8）。
   */
  subscribe(target: AgentInstanceRef, onEvent: (e: NormalizedAgentEvent) => void): Promise<Subscription>;

  /**
   * 裁定を返す。C2。
   * push 型は「保留している HTTP レスポンスに body を書く」実装、
   * pull 型は「REST を叩く」実装になり、**呼び出し側はどちらか知らない**。
   *
   * abstain は push 型では「空応答を返す」、pull 型では「何もしない」に落ちる。
   * **その意味の違いは noDecision が宣言している。**
   */
  decide(target: AgentInstanceRef, decision: PendingDecision, verdict: Verdict): Promise<void>;

  /**
   * いま人間の判断を待っているものを引き直す。C7。
   * pull 型は GET /permission + GET /question。push 型は in-memory の保留分。
   * **再接続直後の取りこぼし回収に使う。**
   */
  listPending(target: AgentInstanceRef): Promise<PendingDecision[]>;

  /**
   * 会話の busy/idle を引き直す。C7。
   * pull 型は GET /session/status。**push 型は null を返してよい**（引き直せない）。
   * `session.idle` はイベントであってステートではないので、これは「今 busy か」しか答えない。
   */
  probeActivity(target: AgentInstanceRef): Promise<'busy' | 'idle' | null>;

  /** C6。push 型は常に { state: 'unknown' }。 */
  liveness(target: AgentInstanceRef): SourceLiveness;
}

export interface Subscription {
  close(): Promise<void>;
  readonly liveness: SourceLiveness;
}
```

### 9.3 マッパの形（C4 — 名前の表では足りない）

Claude 側は `CLAUDE_HOOK_EVENT_NAMES`（`Record<string, AgentEventType>`）で足りていた。
opencode は**述語**が要る。

```ts
type EventMapper = (rawType: string, payload: Record<string, unknown>) => NormalizedAgentEvent | null;

// opencode の例（実測に基づく。src/lib/hooks/agent-event-types.ts と同じ「fixture が正」の原則で書く）
const OPENCODE_MAPPERS: ReadonlyArray<EventMapper> = [
  // 1:1
  t('session.idle',    'stop'),
  t('session.created', 'session_start'),
  t('session.deleted', 'session_end'),      // ただし DELETE のときだけ。/exit では出ない（§5.6.4）

  // 複合: role を見る
  (ty, p) => ty === 'message.updated' && role(p) === 'user' ? ev('user_prompt_submit', p) : null,

  // 部分一致: 同一 type の state.status で pre/post に分かれる
  (ty, p) => ty === 'message.part.updated' && toolStatus(p) === 'running'
    ? ev('pre_tool_use', p, { detail: toolName(p), toolCallId: callId(p) }) : null,
  (ty, p) => ty === 'message.part.updated' && ['completed', 'error'].includes(toolStatus(p) ?? '')
    ? ev('post_tool_use', p, { detail: toolName(p), toolCallId: callId(p) }) : null,

  // 束: 3 つの別イベントが notification に集まる。detail で区別する
  t('permission.asked', 'notification', 'permission_prompt'),
  t('question.asked',   'notification', 'question_prompt'),
  t('session.error',    'notification', 'error'),
];
```

**`detail` の値域はソース横断で決めること。** Claude は `notification_type`（`permission_prompt` / `idle_prompt`）を
そのまま使っている。opencode に `idle_prompt` は無く、代わりに `question_prompt` が要る。
**`detail` を横断的な enum にするか、ソースごとの自由文字列のままにするかは #1759 の判断事項**だが、
`wait --on-prompt` が両ソースで同じ意味になるためには、少なくとも
**「人間の入力を待って止まっている」を表す値が共通化されていなければならない。**

### 9.4 #1759 が守るべきこと（チェックリスト）

- [ ] `AgentEventSource` が `transport: 'push' | 'pull'` を持ち、**`subscribe` / `close` が push 型でも意味を持つ**（no-op でよいが呼べる）
- [ ] **`decide()` が「レスポンス body に書く」実装と「別の REST を叩く」実装の両方を隠せる**（C2）
- [ ] **`noDecision` が型として存在し、`abstain` の意味がソースごとに違うことを呼び出し側が読める**（C3）。
      **これが欠けると Auto-Yes v2 が opencode でセッションを静かに止める**
- [ ] `Verdict` が **3 値（once / always / reject）と question の `answers`** を表現できる
- [ ] マッパが **述語つき**（`Record<string, AgentEventType>` では opencode を写せない）（C4）
- [ ] `liveness()` / `listPending()` / `probeActivity()` があり、**push 型では `unknown` / in-memory / `null` を返してよい**（C6 / C7）
- [ ] **未知の `type` で throw しない**（C8）
- [ ] `session_end` が**来ないソースがある**ことを前提に、instance の終了検知を tmux 側に残す
- [ ] 購読レジストリを **`globalThis` 経由**で持つ（dev のモジュール再評価で消える #1736 の前例）
- [ ] `conversationId` を**永続キーにしない**（Claude は `/clear` で変わる。opencode は安定だが他プロセスの session が混ざる）

---

## 10. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720)
- 先行スパイク（Claude hooks）: [`agent-hooks-live-verification.md`](./agent-hooks-live-verification.md) / [#1721](https://github.com/Kewton/CommandMate/issues/1721)
- 並行スパイク（codex / gemini / copilot / agy hooks）: [#1757](https://github.com/Kewton/CommandMate/issues/1757)
- 下流: [#1759](https://github.com/Kewton/CommandMate/issues/1759)（抽象抽出）/ [#1763](https://github.com/Kewton/CommandMate/issues/1763)（opencode 対応）
- fixtures: [`tests/fixtures/hooks/opencode/`](../../tests/fixtures/hooks/opencode/)（[README](../../tests/fixtures/hooks/opencode/README.md) にマッピング表あり）
- 既存の 7 語定義: `src/lib/hooks/agent-event-types.ts`
- 既存の opencode 起動: `src/lib/cli-tools/opencode.ts`（`:136` の `sendKeys(sessionName, 'opencode', true)` に `--port` を足す）
- 既存の opencode config 生成: `src/lib/cli-tools/opencode-config.ts`（`ensureOpencodeConfig()`）
- opencode 自身の API 定義: 稼働中のサーバの `GET /doc`（OpenAPI 3.1.0）。**推測せずここを見ること**

---

## 11. 追加スパイク: メッセージ送信の API 化（Issue #2035 / opencode 1.18.22）

> **この節は #2035 が追記したものです。§1〜§10（#1758、1.18.3）は書き換えていません。**
> §1〜§10 と食い違う記述がある場合は、**版が違う**（1.18.3 と 1.18.22）ことを先に疑ってください。

### 11.1 結論サマリ

| 検証項目 | 結果 |
|---|---|
| `/tui/append-prompt` → `/tui/submit-prompt` が composer に反映され**送信される** | **可（ただし条件つき）**。[§11.3](#113-tui-系の実測) |
| `/tui/clear-prompt` で残存が消える | **可**。キーストロークで打ち込んだ残存も、開いてしまったコマンドパレットも消える |
| `/` 始まり本文が改変されない | **`/tui/*` では不可**。**先頭トークンが実在コマンドに前方一致すると palette が開き、submit が食われる**（`200 true` を返して何も送られない）。`prompt_async` では**可** |
| 複数行本文が改変されない | **両経路とも可**（`\n` がそのまま） |
| 長文（wrap 超）が改変されない | **両経路とも可**（266 文字 / 80 桁 pane で 4 行に折り返して表示、送信テキストは完全一致） |
| submit 検証に使える positive evidence | **可**。SSE `message.updated(role:user)` / `message.part.updated(text)`（submit の 10〜21 ms 後）。**加えて `messageID` 指定 + read-back という、購読なしで済む手段がある**（[§11.5](#115-送信の-positive-evidence)） |
| 画像添付（`POST /session/:id/prompt_async` の file part） | **可**。実モデルが画像を読んで回答するところまで確認 |

**採用**: `OpenCodeTool.sendMessage` / `sendMessageWithImage` は **`POST /session/:id/prompt_async` を一次**とし、
**キーストローク経路を fallback** とする。`/tui/*` は**採らない**（理由は [§11.4](#114-tui-系を採らない理由)）。

### 11.2 ハーネスと非汚染の証拠

[§4](#4-再現環境ハーネス) のとおり。差分だけ記す。

| 項目 | 値 |
|---|---|
| 版 | **1.18.22**（`GET /global/health` → `{"healthy":true,"version":"1.18.22"}`） |
| 隔離 HOME | scratchpad 配下。`GET /path` の `home` / `state` / `config` / `worktree` / `directory` **5 つすべてが scratchpad 配下**であることを確認済み |
| tmux socket | `tmux -L cmate-i2035-oc`（専用）。後始末は `kill-session -t '=<name>:'`。**`kill-server` は使っていない** |
| ポート | **4835**（素の TUI + `--port`）/ **4836**（比較用の headless `opencode serve`）。3000 は使っていない |
| provider | `lmstudio`。既定は「モデル未ロード」状態で `session.error APIError` になるが、**ユーザーメッセージは正常に作られる**ので大半の検証はこれで足りる。実ターンを 1 本通すため `qwen/qwen3-vl-4b` を **TTL 900 秒つきでロードし、検証後に unload**（検証前後とも loaded モデルは 0 件） |
| モデルピッカー | **一度も開いていない**。モデルは隔離 HOME の `opencode.jsonc` で固定した（TUI の picker は既定モデルを書き換えるため） |
| `auth.json` | mode 600 で複製し、**検証後に削除**（削除確認済み） |
| ユーザー HOME 非汚染 | 検証終了時点で `~/.local/share/opencode/opencode.db` の mtime は **検証開始（14:49）より前の 8/25 14:16 のまま**、`~/.config/opencode/opencode.jsonc` は 7/19 のまま。**1 バイトも触っていない** |

### 11.3 `/tui/*` 系の実測

`GET /doc` に存在するルート（1.18.22）:
`POST /tui/append-prompt {text}` / `POST /tui/submit-prompt`（body なし）/ `POST /tui/clear-prompt`（body なし）/
`POST /tui/execute-command {command}` / `POST /tui/open-help` / `POST /tui/open-models` ほか。

#### 11.3.1 動く（画面で確認した）

| 操作 | HTTP | 画面 | 同一サーバの `/event` に流れるフレーム |
|---|---|---|---|
| `append-prompt {"text":"hello from api"}` | `200 true` | composer が `Ask anything...` から `hello from api` に変わる | `tui.prompt.append {"text":"hello from api"}` |
| `append-prompt` を 2 回（`AAA` → `BBB`） | `200 true` | **`AAABBB`**（連結。区切りは入らない） | 各 1 件 |
| `clear-prompt` | `200 true` | composer が空（placeholder に戻る） | `tui.command.execute {"command":"prompt.clear"}` |
| tmux `send-keys` で打った残存 → `clear-prompt` | `200 true` | **残存が消える**（キーストローク由来でも消せる） | 同上 |
| `/exit` を入れて palette が開いた状態 → `clear-prompt` | `200 true` | **palette ごと閉じて composer も空になる** | 同上 |
| `submit-prompt` | `200 true` | 送信される | `tui.command.execute {"command":"prompt.submit"}` → 10〜21 ms 後に `message.updated(role:user)` |

`/tui/*` を投げても `session` が無ければ `submit-prompt` が**新しい session を作る**（`session.created` が流れる）。

#### 11.3.2 本文の改変（3 ケース）

いずれも `clear-prompt` → `append-prompt` → `submit-prompt` の順で送り、SSE の
`message.part.updated(part.type=text)` の `text` と**完全一致（`===`）**することを確認した。

| ケース | 本文 | 長さ | 一致 |
|---|---|---|---|
| `/` 始まり | `/tmp/spike-2035.txt の中身を1行で答えて` | 30 | **一致**（palette は開かない） |
| 3 行 | `line one about the spike\nline two has 日本語 text\nline three ends here` | 67 | **一致**（`\n` 保持。composer にも 3 行で表示される） |
| 長文 | `D:[001]…[052]:END` | 266 | **一致**（80 桁 pane で 4 行に折り返して表示されるが送信テキストは無傷） |

#### 11.3.3 **`200 true` は「受理された」であって「composer に入った」ではない**（#2038 の注意が 1.18.22 でも成立）

3 通りの反例を実測した。**いずれも `200 true` を返し、メッセージは 1 件も作られない。**

| 反例 | 実測 |
|---|---|
| **TUI が 1 つも繋がっていない headless サーバ**（`opencode serve` 単独、4836） | `append-prompt` / `submit-prompt` / `clear-prompt` すべて `200 true`。`GET /session/status` は `{}` のまま |
| **composer が空のまま `submit-prompt`** | `200 true`、`tui.command.execute {"command":"prompt.submit"}` は流れるが `message.updated` は**来ない** |
| **本文が実在コマンドに前方一致**（`/exit`） | `append-prompt` `200 true` → **画面に palette が開く**（`/exit  Exit the app` / `/export  Export session transcript` の 2 行）。`submit-prompt` `200 true` → **メッセージは作られず、TUI も終了しない**。composer には `/exit` が残り palette も開いたまま |

なお **サーバをまたいだ混線は無い**：4836（headless）へ `append-prompt {"text":"XLEAKPROBE2035X"}` を投げても、
4835 の `/event` にもその TUI の画面にも一切現れない。

### 11.4 `/tui/*` 系を採らない理由

**Issue が挙げた制約 2「`/` 始まりの本文がパレットを開く」を `/tui/*` は解決しない**（[§11.3.3](#1133-200-true-は受理されたであってcomposer-に入ったではない2038-の注意が-11822-でも成立)）。
`/tui/append-prompt` は TUI の **composer** を操作するので、composer の状態をそのまま引き継ぐ。結果:

1. **先頭トークンが実在コマンドに前方一致すると submit が palette に食われる。** `/exit` で実測。
   `/tmp/…` が通ったのは「一致するコマンドが無く palette が閉じたから」であって、`/` が安全だからではない。
2. **利用者が書きかけの下書きを壊す。** `append-prompt` は連結（`AAA`+`BBB`=`AAABBB`）なので、
   CommandMate の本文を下書きに継ぎ足すか、`clear-prompt` で下書きを消すかの二択になる。

`POST /session/:id/prompt_async` は composer を経由しない。同じ本文で比較した:

| 本文 | 長さ | `prompt_async` の `message.part.updated(text)` |
|---|---|---|
| `/exit` | 5 | **一致**（コマンドとして解釈されない。TUI も終了しない） |
| `/tmp/spike-2035.txt の中身を1行で答えて` | 30 | 一致 |
| 3 行本文 | 67 | 一致 |
| 266 文字本文 | 266 | 一致 |
| `--force を付けずに実行して` | 17 | 一致（`-` 始まりも無傷） |
| `Escape と C-c と ; と $(whoami) を含む本文` | 34 | 一致（tmux/シェルのメタ文字も無傷） |

**TUI の画面にも通常どおり描画される**（transcript に本文が出る）。`prompt_async` を使っても
「利用者が TUI を見て会話を追える」性質は失われない。

### 11.5 送信の positive evidence

#### 11.5.1 SSE（購読がある場合）

`tui.command.execute {"command":"prompt.submit"}` の **10 / 12 / 21 ms 後**に
`message.updated(role:user)` と `message.part.updated(part.type=text)` が届いた（3 ケース）。
Issue が候補に挙げた `message.updated(role:user)` は**そのまま使える**。

#### 11.5.2 `messageID` 指定 + read-back（採用したのはこちら）

`POST /session/:id/prompt_async` の body は **`messageID`（schema: `pattern: "^msg"`）を呼び出し側が指定できる**。
`msg_cmate2035probe0001` を指定して投げ、`GET /session/:id/message/msg_cmate2035probe0001` を引くと
`200` + `info.role: "user"` + `parts[0].text` が**送った本文と完全一致**した。

| 計測 | 結果 |
|---|---|
| `204` から read-back が `200` になるまで | **5 回中 5 回とも 1 回目の `GET` で `200`**。POST 開始から 8 / 11 / 13 / 20 / 23 ms。つまり `prompt_async` は**メッセージ作成後に `204` を返す** |
| **反証（落ちたメッセージを検出できるか）** | file part の `url` に**スキーム無しの絶対パス**を入れると `204` → `GET` は **`404 NotFoundError`**。read-back は「受理されたが落ちた」を実際に検出する |

**`204` は「受理」であって「届いた」ではない**ことの直接証拠も取れている:
`HOME` と project を共有する**別サーバ**（4836）へ、4835 の session ID を指定して `prompt_async` を投げると **`204`** が返るが、
そのメッセージは **4835 の `/event` にも 4835 の TUI 画面にも現れない**（`opencode.db` 経由で session が共有されているため受理はされる。§5.6.3 の落とし穴の続き）。

### 11.6 画像添付（`FilePartInput`）

`POST /session/:id/prompt_async` の `parts` に `{"type":"file","mime","filename","url"}` を混ぜる。

| 実測 | 結果 |
|---|---|
| `url: "file:///…/blue.png"` | **`204`**。SSE では `part.type=file` が **`data:image/png;base64,…` に再エンコードされて**流れる。TUI は `File  blue.png` と描画。`text` part も同じメッセージに同居する |
| `url: "data:image/png;base64,…"`（直接） | **`204`**、同様に届く |
| `url: "/…/blue.png"`（**スキーム無し**） | **`204` を返した上で `session.error UnknownError: TypeError: "/…/blue.png" cannot be parsed as a URL. at SessionPrompt.resolveUserPart` となり、<br>**text part を含むメッセージ全体が破棄される**（read-back は `404`）。**`file://` は必須** |
| 実モデルでの動作 | `qwen/qwen3-vl-4b`（LM Studio）に 64x64 の純青 PNG を添付して「何色か」と聞くと **`画像の色名は blue です。`** と返った。**画像は実際に読まれている** |

1.18.22 は file part を解決するとき、利用者の text part の隣に
`Called the Read tool with the following input: {"filePath":"…"}` という **合成 text part を自分で足す**。
read-back で本文を照合するときは「唯一の text part であること」ではなく「**送った本文が text part 群に含まれること**」を見ること。

### 11.7 その他の実測

| 項目 | 実測 |
|---|---|
| **ダイアログが開いている最中の送信** | `POST /tui/open-help` で Help ダイアログを出したまま `clear` → `append` → `submit` を投げると、**本文はそのまま送信された**（`message.part.updated(text)` が 42 ms 後に一致）。キーストロークが吸われる状態でも API は通る。**したがって「ダイアログ中は送らない」判断は CommandMate 側（`isPromptWaiting`）が持ち続ける必要がある**。API 経路はガードにならない |
| **ターン実行中（busy）の送信** | 実行中の session へ `prompt_async` を投げると **`204` で受理され、メッセージも作られる**（read-back `200`）。assistant のメッセージがもう 1 本作られ、最後に `session.idle` が 1 回。**取りこぼしは起きなかった** |
| **存在しない session への `prompt_async`** | **`404 {"name":"NotFoundError","data":{"message":"Session not found: …"}}`**。`/tui/*` と違い、**本物の negative signal が返る** |
| **`GET /session`** | 同一 HOME + project の**他プロセスの session も返る**（§5.6.3 のとおり 1.18.22 でも成立。検証中に 3 件並んだ） |

### 11.8 未計測（推測で埋めていない項目）

- **`POST /api/session/:id/prompt`（v2）の `delivery: "steer" | "queue"`** — busy 中の配送を明示制御できる可能性があるが、
  v2 の `/api/event` が使えない（§5.2.2）ため今回は v1 の `prompt_async` に絞った。**未計測**
- **`prompt_async` の `model` / `agent` / `system` / `tools` フィールド** — `model` のみ「存在しないモデル ID は
  `session.error ProviderModelNotFoundError`」を確認。他は**未計測**（CommandMate は指定しない）
- **`/tui/select-session`** — TUI が別 session を表示しているときに `prompt_async` の宛先を合わせる用途で使えそうだが**未計測**
- **画像以外の file part（PDF 等）** — `mime` は任意文字列を受けるが、画像以外は**未計測**
- **`prompt_async` を秒間多数投げたときの挙動 / レート制限** — **未計測**

### 11.9 CommandMate 側の実装（#2035 で入れたもの）

```
OpenCodeTool.sendMessage(worktreeId, message, instanceId)
  ├─ hasSession()                        … 無ければ従来どおり throw（変更なし）
  ├─ trySendViaServer()                  … ★一次
  │    ├─ getAssignedOpencodePort()      … null → false
  │    ├─ getOpencodeLiveness()          … 'live' 以外 → false
  │    ├─ getOpencodePrimarySession()    … null → false（初回ターン前の pane）
  │    ├─ POST /session/:id/prompt_async … messageID は CommandMate が採番
  │    └─ GET  /session/:id/message/:id  … found かつ text 一致で初めて true
  └─ sendMessageWithSubmitVerification() … ★fallback（#1471 の従来経路そのまま）
```

- **`trySendViaServer` が false を返す道はすべて fallback に落ちる。** ポート未割当（`CM_AGENT_HOOKS_INJECT=0` や
  `--port` を知らない旧版）、購読が live でない、session 未確定、POST 拒否、read-back 不一致 —— すべて従来のキーストローク経路になる。
  **これは #2034（abort）と同じ設計。**
- **read-back の `404`（`missing`）は「作られていない」ことの確定情報**なので、そこから再送しても二重送信にならない。
  read-back が**取れなかった**場合（`unknown`）も fallback するが、この窓では二重送信になりうるため
  `opencode-send-unverified` を warn で残す。
- 画像は `supportsImage(): true` + `sendMessageWithImage()`。サーバ経路が使えないときは
  従来どおり `[添付画像: <path>]` に劣化する（文言は `formatImagePathFallbackMessage` に一本化し、
  `src/lib/session/send-user-message.ts` の汎用分岐もそれを使う）。
- **`composer-spec.ts` の `clearBeforeSend: false` は変えていない。** `prompt_async` は composer を経由しないので
  クリアが要らず、`C-e`+`C-u`（`clearComposer` が撃つキー列）を opencode の入力枠に対して実測していないため。
  なお `/tui/clear-prompt` なら残存を消せることは [§11.3.1](#1131-動く画面で確認した) で実測済み。

### 11.10 Issue #2035 が挙げた 4 つの制約への回答

| Issue が挙げた制約 | 実測を踏まえた回答 |
|---|---|
| composer クリアが不可（`clearBeforeSend: false`） | **一次経路では問題にならない**。`prompt_async` は composer を経由しないので、利用者の書きかけを壊さないし残存とも結合しない。fallback 経路では従来どおり残る |
| `/` 始まりの本文がパレットを開く（`key-sequence.ts` の `/exit` 事例） | **一次経路で解決**。`/exit` が literal text として届くことを実測。**`/tui/*` では解決しないことも実測**（[§11.3.3](#1133-200-true-は受理されたであってcomposer-に入ったではない2038-の注意が-11822-でも成立)） |
| 画像が `[添付画像: path]` テキストに劣化 | **一次経路で解決**。file part で実画像が届き、モデルが読んで回答するところまで確認。サーバが無い pane では従来の劣化に落ちる |
| 複数行が wrap の影響を受ける | **一次経路で解決**。3 行 / 266 文字とも `message.part.updated(text)` と完全一致 |

## 12. Issue 2036 / 2037: opencode 1.18.22 (2026-08-25)

§4 のハーネスをそのまま再実行して取った追加計測。目的は 2 つ。

1. **#2036** — palette を `GET /command` から動的に作れるか。`/compact` ほかの phantom 判定を 1.18.22 で取り直す。
2. **#2037** — `commandmate skill install` の install root（`.agents/skills` / `.claude/skills`）を opencode が
   **発見できるか / 呼び出せるか**の 2 軸。

### 12.1 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4904/path
# home      …/scratchpad/oc2036/home
# state     …/scratchpad/oc2036/home/.local/state/opencode
# config    …/scratchpad/oc2036/home/.config/opencode
# worktree  …/scratchpad/oc2036/work
# directory …/scratchpad/oc2036/work
curl -sS http://127.0.0.1:4904/global/health   # {"healthy":true,"version":"1.18.22"}
```

5 つとも scratchpad 配下。TUI は `tmux -L cmate-2036-oc` の専用 socket 上でだけ動かし、後始末は
`kill-session -t '=oc2036:'`（`kill-server` は使っていない）。model は config で固定し、**model picker は一度も開いていない**。
検証後、複製した `auth.json` は削除済み。ユーザ実データ（`~/.local/share/opencode/opencode.db`、`auth.json`、
`~/.config/opencode/opencode.jsonc`）の mtime はいずれも検証開始より前のまま。

### 12.2 `GET /command` は palette ではない（#2036 の前提が半分崩れる）

Issue #2036 は「palette 目視を `GET /command` に置換する」と書いていたが、**置換できない**。

```bash
curl -sS http://127.0.0.1:4904/command | jq -r '.[] | "\(.name)\t\(.source)"'
# init                        command
# review                      command
# test                        command      ← .opencode/commands/test.md
# customize-opencode          skill        ← opencode 組込みの Skill
# probe-…                     skill        ← 植えた probe Skill 6 個
```

| palette の行 | `GET /command` にある？ |
|---|---|
| `/init` `/review` | **ある**（`source: "command"`） |
| `/agents` `/connect` `/debug` `/diff` `/editor` `/exit` `/help` `/mcps` `/models` `/move` `/new` `/sessions` `/skills` `/status` `/themes` `/variants` | **ない** |

残り 16 個は **TUI クライアント側のコマンド**で、server は存在すら知らない。TUI を attach した状態で
取り直しても 10 件のまま変わらない。したがって:

- `GET /command` は **その project が足したもの**（`.opencode/commands/*.md` と発見された Skill 全部）について権威である。
- 組込み 18 個のうち 16 個については何も言わない。attestation の当該 16 個は **palette 読みのまま**残す。

各行のフィールド: `name` / `description` / `source`（`command` \| `skill`）/ `hints`（`["$ARGUMENTS"]`）/
`agent` / `subtask` / `template`。**`description` と `hints` が #2036 の「説明・引数ヒント」の実体**である。

**server は起動時に一度だけ走査して cache する。** `.opencode/commands/test.md` を置いて同じ process の
`GET /command` を読み直しても古いまま。再起動した server は新しいリストを返す。ポーリングしても意味がない。

### 12.3 phantom 再計測（陽性・陰性対照つき）

palette を `/` で開いて 40 回スクロールし全行を採取 → **19 行**。18 行は 1.18.21 と同一
（`/agents` … `/variants`）。19 行目は probe の `/test`（`Issue 2036 probe custom command` という
**frontmatter の description つき**で出た）。

| 入力 | 結果 |
|---|---|
| `/status`（**陽性対照**） | 自分の行にマッチ。Enter で Status 画面が開く |
| `/zzzznotacommand`（**陰性対照**） | 1 行もマッチしない |
| `/compact`（対象） | `/review` の**説明文**にファジーマッチするだけ。`/compact` の行は出ない |

`/compact` はさらに悪い。**この状態で Enter を押すと composer が `/review` に置き換わる。**
つまり `/compact` を palette に出すと「押した名前と違うコマンドを渡す」ことになる。
exclusion は据え置き、理由をこの実測に更新した（`src/config/slash-commands-exclusions.json`）。

### 12.4 Skill の発見（#2037 discovery 軸）— 機械的

候補 root ごとに probe Skill を 1 個ずつ、計 6 個植えて server を再起動した。

```bash
curl -sS http://127.0.0.1:4904/skill | jq -r '.[] | "\(.name)\t\(.location)"'
```

| 植えた場所 | `GET /skill` が返した？ |
|---|---|
| `<project>/.agents/skills/` （**CommandMate primary install root**） | ✅ 絶対 path つき |
| `<project>/.claude/skills/` （**CommandMate secondary install root**） | ✅ 絶対 path つき |
| `<project>/.opencode/skills/` | ✅ 絶対 path つき |
| `$HOME/.agents/skills/` | ✅ 絶対 path つき |
| `$HOME/.claude/skills/` | ✅ 絶対 path つき |
| `$HOME/.config/opencode/skills/` | ✅ 絶対 path つき |

TUI の `/skills` picker も同じ 6 個を列挙した。`location` が実 path を返すので、これは self-report ではなく **機械的証跡**である。

### 12.5 Skill の呼出（#2037 invocation 軸）— 動くが palette には出ない

| 入力 | 結果 |
|---|---|
| `/probe-agents-root`（`/skills` picker が composer に挿入 → 送信） | Skill 本文が読み込まれ、agent が `PROBE_OK_probe-agents-root` を返す ✅ |
| `/probe-claude-root`（同上） | `PROBE_OK_probe-claude-root` ✅ |
| `/probe-opencode-root ` | `PROBE_OK_probe-opencode-root` ✅ |
| `/probe-agents-root` を **composer に直接タイプ** | 補完が **`No matching items`** |

つまり **`/`+名前は動く呼出経路だが、opencode 自身の palette からは発見できない**。
palette は `source: "command"` の行しか載せない。opencode 自身の入口は `/skills` picker だけである。
**CommandMate の palette が install 済み Skill を opencode session に供給する意味がここにある**（#2037）。

### 12.6 `/` 始まりの prompt は dropdown に submit を吸われる（実装上の罠）

CommandMate が送信に使う経路そのもので再現する。

| 手順 | 結果 |
|---|---|
| `POST /tui/append-prompt {"text":"/probe-claude-root"}` → `POST /tui/submit-prompt` | 両方 `true`。**しかし送信されない**（`No matching items` の dropdown が開いており Enter/submit を吸う） |
| composer に空の dropdown が無い状態で `POST /tui/submit-prompt` | 送信される ✅ |
| `POST /tui/append-prompt {"text":"/probe-opencode-root "}`（**末尾に空白 1 つ**）→ submit | dropdown が閉じて送信される ✅ |
| `POST /tui/append-prompt {"text":"/test hello"}` → submit | custom command の template が展開され `CUSTOM_CMD_OK` が返る ✅ |

`/tui/*` の `true` は「TUI 制御チャネルに受理された」であって「送信された」ではない（§5 の既知事項と同じ）。
`MessageInput` は元から `` `${trigger} ` `` を入れるので palette 経路は安全。**trigger を手で組む呼び出し側は
末尾の空白を落とさないこと。**

### 12.7 プログラム的な呼出経路（未採用・記録のみ）

`POST /session/{sessionID}/command {"command","arguments"}` が OpenAPI にある。TUI を経由せずに
command / Skill を起動できるはずで、12.6 の dropdown 問題を丸ごと回避する。#2036 では**採用していない**
（`src/lib/cli-tools/opencode.ts` は #2035 が触っている）。`GET /experimental/tool/ids` に `skill` が
実在することも確認済み。

### 12.8 この節が変えたもの

- `src/lib/slash-command-reconcile/providers/opencode.ts`（新規）— `GET /command` provider。12.2 の限界を docblock に持つ
- `src/app/api/worktrees/[id]/slash-commands/opencode-live.ts`（新規）— cache + 背景 refresh（hot path で await しない）
- `src/lib/slash-commands.ts` — `loadOpencodeSkills()` / `opencodeLiveCommandsToSlashCommands()`
- `src/lib/skills/compatibility-matrix.ts` — opencode 行を `unmeasuredEntry` から 12.4 / 12.5 の実測へ
- `src/config/slash-commands-attestations.json` — opencode を 1.18.22 / 2026-08-25 に（18 個の名前は不変）
- `src/config/slash-commands-exclusions.json` — `/compact` の理由を 12.3 に

---

## 13. Issue 2041: 会話履歴を SSE / `GET /session/:id/message` から生成する（opencode 1.18.22 / 2026-08-25）

**計測は実施した。** §4 のハーネスをそのまま使い、隔離 HOME 上の `opencode serve --port 4881` に対して
3 ターン（プレーン Markdown / tool 呼び出しあり / 967 文字 1 行の段落）を流し、SSE tap と
`GET /session/:id/message` の両方を採取した。以下はすべてその実測である。

### 13.1 隔離の確認（先に撃つ）

```
$ curl -sS http://127.0.0.1:4881/global/health
{"healthy":true,"version":"1.18.22"}

$ curl -sS http://127.0.0.1:4881/path
{"home":"…/scratchpad/oc2041/home",
 "state":"…/scratchpad/oc2041/home/.local/state/opencode",
 "config":"…/scratchpad/oc2041/home/.config/opencode",
 "worktree":"…/scratchpad/oc2041/work",
 "directory":"…/scratchpad/oc2041/work"}
```

5 値すべて scratchpad 配下。`auth.json` は mode 600 で複製し、検証後に削除済み。TUI は一度も起動して
おらず（`prompt_async` で REST から流した）、**モデルピッカーは開いていない**。ユーザーの
`~/.local/share/opencode/opencode.db` の mtime は計測前後で不変。tmux は一切使っていない。

### 13.2 assistant の本文はどのフレームに乗るか（**Issue 本文と食い違う**）

Issue 本文は「assistant の text part を messageID 単位で集約」と書いているが、1.18.22 の実際は違う。

| フレーム | 実測 |
|---|---|
| `message.part.updated`（text part の**開始**） | `part.text` が **空文字** で 1 回 |
| `message.part.delta` | 増分が `{partID, field:"text", delta}` で N 回。**1.18.3 の fixture には存在しないイベント** |
| `message.part.updated`（text part の**終了**） | `part.text` に **本文全体**。`time.end` つき |

3 ターン 142 フレーム中 **95 が `message.part.delta`**。text part ごとの `message.part.updated` は
必ず 2 回（空 → 全文）で、**途中経過の `message.part.updated` は 1 度も来ない**。

→ **本文は `message.part.updated` から取り、delta は 1 件も読まない。**
これが「境界フレームが byte 同一で再送される」（#1763 / #1899）への答えでもある。
part id をキーに last-write-wins で上書きするので、**再送は同じ値を同じスロットに書くだけ**であり、
dedup セットを持たずに冪等になる。

#### delta は内容で dedup できない（重要な反証）

tap 中に **byte 同一の delta が 3 組**あった（`","` ×2 / `"."` ×2 / `" without"` ×2）。
しかし全 88 delta を連結した文字列は最終 `message.part.updated` の 967 文字と**完全一致**した。
つまり**この 3 組は再送ではなく実際の本文**であり、delta を溜めて重複除去していたら
967 文字の段落から 3 文字が黙って消えていた。

```
prt_…PcFwgDisX9SZKY deltas=88 joined=967 final=967 MATCH=True
```

### 13.3 1 ターンは assistant メッセージ 1 通とは限らない（**Issue 本文と食い違う**）

tool を使ったターンは assistant メッセージを **2 通**生んだ。

| id | `finish` | parts |
|---|---|---|
| `msg_…bdd3` | `tool-calls` | `step-start`, `tool(bash)`, `step-finish` |
| `msg_…c52d` | `stop` | `step-start`, `text`, `step-finish` |

両方の `parentID` は同じ **user メッセージ id**。よって**ターンの identity は `parentID`**であり、
assistant の messageID ではない。messageID で束ねると 1 つの返答が 2 行に割れ、
再取得時に割れ方が変わって冪等にならない。

`chat_messages.request_id` に `oc-turn:<parentID>` を書くのはこのため（`src/types/agent-transcript.ts`）。

### 13.4 `Part` は 12 種（`GET /doc` 一次証拠）

```
Part => TextPart SubtaskPart ReasoningPart FilePart ToolPart StepStartPart
        StepFinishPart SnapshotPart PatchPart AgentPart RetryPart CompactionPart
```

本文になるのは `text` / `reasoning` / `tool` の 3 種のみ。`step-start` / `step-finish` /
`snapshot` / `patch` は**明示的な無視リスト**にした（allow ではなく deny にしたのは、
将来 opencode が増やした variant を「未知 part」としてログに出すため。C8 と同じ規則）。

`TextPart` は `synthetic` / `ignored` フラグを持つ（schema 上）。今回の計測では 1 件も観測していない。

**`reasoning` part は今回のプロバイダ（`github-copilot` / `claude-sonnet-4.6`）では 1 件も出なかった。**
形は `GET /doc`（§4.5 の一次証拠）から取っており、**実機での観測はしていない**。推測で埋めていない。

### 13.5 再接続はイベントを 1 件も replay しない → REST 補完が必須

3 ターン完了後に **2 本目の SSE を張った**。受け取ったのは:

```
server.connected   ← これ 1 件のみ。以後は heartbeat だけ
```

`?after=<seq>` が効かない（§5.2.2）ことと合わせて、**落ちている間に走ったターンはストリームからは
永久に取れない**。`GET /session/:id/message` が唯一の経路。

### 13.6 `GET /session/status` は静かなサーバでは `{}` を返す

ターンが全部終わったサーバに対して:

```
$ curl -sS http://127.0.0.1:4881/session/status
{}
```

**「今なにかしている」セッションしか載らない。** したがって CommandMate 再起動後の補完で
「どのセッションを読むか」を `/session/status` から取ることはできない。
`recoverHistory()` は **turn-gate の primarySession → #2038 の永続化 sessionID** の順で解決する。

### 13.7 保存された本文と `GET /session/:id/message` の一致（受入条件）

3 ターンぶんの実測を fixture に落とし、テストで突き合わせている（**環境固有値は置換済み**）。

| fixture | 中身 |
|---|---|
| `tests/fixtures/hooks/opencode/history-turns-1-18-22.json` | SSE tap から `message.*` / `session.idle` の 142 フレーム（到着順） |
| `tests/fixtures/hooks/opencode/session-messages-1-18-22.json` | 同セッションの `GET /session/:id/message` 応答（7 メッセージ） |

この 2 つは**同じ 3 ターンの 2 つの見え方**なので、「保存された本文が REST の text と一致する」は
テストで検証できる性質になる:

- `tests/unit/hooks/sources/opencode-transcript-2041.test.ts`
- `tests/integration/opencode-history-2041.test.ts`

実測された 3 ターンの保存結果:

| ターン | 保存された本文 |
|---|---|
| 1（tool なし） | `## Heading A\n\n- item one\n- item two\n\n**bold** and \`code\``（56 文字、そのまま） |
| 2（tool あり） | `- \`bash\` — echo CMATE-2041-TOOL-MARKER\n\nIt printed \`CMATE-2041-TOOL-MARKER\`.` |
| 3（967 文字 1 行） | 967 文字が **1 行のまま**。scrape 版は 200 桁でハードラップされている |

### 13.8 未計測（推測で埋めていない項目）

- **`reasoning` part の実物**（13.4）。折りたたみ表現の判断は形からしており、実機で見ていない。
- **`message.part.removed` / `message.removed`**。`Event` union にあるが 1 件も観測していない。
  part の削除は現在の実装では反映されない（削除されたはずの part が残る）。
- **`compaction` 後のセッション**。`GET /session/:id/message` が compaction 前のメッセージを
  どう返すかは未確認。`MAX_OPENCODE_SESSION_MESSAGES` は新しい方 500 件で切る。
- **sub-agent のセッション**。`parentID` を持つ session の履歴は今回の対象外（#2040 の
  telemetry 側で除外している判断と揃えてある）。

### 13.9 この節が変えたもの

- `src/lib/hooks/sources/opencode/transcript.ts`（新規）— part 蓄積と Markdown 化。純関数、DB も fetch も持たない
- `src/lib/hooks/sources/opencode/history.ts`（新規）— `chat_messages` への writer と REST 補完
- `src/lib/hooks/sources/opencode/client.ts` — `fetchOpencodeSessionMessages()` を**末尾に追加**（既存 export は不変）
- `src/lib/hooks/sources/opencode/subscription.ts` — `deliver()` の #2040 と同じ位置で `message.*` を読み、
  `session.idle` で flush、接続時に `recoverHistory()`
- `src/lib/polling/structured-history-gate.ts`（新規）／`src/lib/polling/response-checker.ts` — port 接続中は scrape 保存を止める
- `src/lib/db/chat-db.ts` — `findMessageByRequestId()`（冪等性の判定。**migration は追加していない**）
- `src/types/agent-transcript.ts`（新規）— `request_id` に載せる provenance マーカーと turn key
- `src/components/worktree/ConversationPairCard.tsx` — 当該行だけ Markdown 描画（`rehype-raw` は使わない）

## 14. Issue 2042: コンテキスト使用率とコスト（opencode 1.18.22 / 2026-08-25）

§4 のハーネスをそのまま再実行して取った追加計測。目的は 1 つだけ。

**#2042** — ヘッダに出す `cost · N tokens (x%)` の **x% の算出方法を決める**。
Issue 本文は「footer の `6.4K (1%)` と突き合わせて算出方法を決める（モデルの context 上限は
`GET /config/providers` から）」としか書いていない。

> **結論を先に**: `#2040` が publish している `structuredEvents.session.tokens` **からは x% を出せない**。
> `Session.tokens` は**セッション累計**で、footer の `(1%)` は**直近の assistant メッセージ 1 通**が
> 母数である。合計してしまうと opencode 自身が `1%` と出しているところで `2%` と表示し、
> ターンを重ねるほど乖離が開く。

### 14.1 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4942/path
# home      …/scratchpad/oc2042/home
# state     …/scratchpad/oc2042/home/.local/state/opencode
# config    …/scratchpad/oc2042/home/.config/opencode
# worktree  …/scratchpad/oc2042/work
# directory …/scratchpad/oc2042/work
curl -sS http://127.0.0.1:4942/global/health   # {"healthy":true,"version":"1.18.22"}
```

5 つとも scratchpad 配下。TUI は `tmux -L cmate-2042-oc` の専用 socket 上でだけ動かし、後始末は
`kill-session -t '=oc2042:'`（`kill-server` は使っていない）。model は config で
`github-copilot/claude-sonnet-4.6` に固定し、**model picker は一度も開いていない**。
検証後、複製した `auth.json` は削除済み。ユーザ実データ（`~/.local/share/opencode/opencode.db` は
`8月 25 14:16`、`auth.json` は `3月 6 09:23`、`~/.config/opencode/opencode.jsonc` は `7月 19 23:54`）の
mtime はいずれも**検証開始（18:02）より前のまま**。

### 14.2 算出式は一次ソースから取った（推測していない）

opencode の TUI は Go ではなく JS で、**バイナリに bundle がそのまま入っている**。
`strings` で当該コンポーネントを引くと式が読める。

```bash
strings -n 6 ~/.opencode/bin/opencode | grep -o '.\{700\}% used'
```

```js
const J = N1(() => Q()?.cost ?? 0)                      // ← Session.cost（累計）
const Y = N1(() => {
  const W = X().findLast((K) => K.role === "assistant" && K.tokens.output > 0)
  if (!W) return { tokens: 0, percent: null }
  const H = W.tokens.input + W.tokens.output + W.tokens.reasoning
          + W.tokens.cache.read + W.tokens.cache.write
  const q = B.api.state.provider.find((K) => K.id === W.providerID)?.models[W.modelID]
  return { tokens: H, percent: q?.limit.context ? Math.round(H / q.limit.context * 100) : null }
})
// …<b>Context</b> {H} tokens / {percent}% used / {MD0.format(J)} spent
// MD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
```

読み取れることが 4 つあり、**どれも実測なしには当てられない**。

| 決めるべきこと | opencode の答え | 間違えやすい候補 |
|---|---|---|
| 母数（分子） | **直近の assistant メッセージ**の 5 項目の和 | `Session.tokens` の和（＝累計） |
| 分母 | `model.limit.context` | `model.limit.input`（同じ document に載っている） |
| 丸め | `Math.round` | `Math.ceil` |
| cost の出所 | `Session.cost`（累計）、USD 2 桁 | 直近メッセージの cost |

`findLast` の `tokens.output > 0` 条件は、**ターン開始直後の assistant メッセージ**（カウントが全部 0）を
飛ばすためのもの。これを落とすと、ターンが始まるたびに実測値の上に `0 (0%)` が一瞬かぶる。

### 14.3 実測（2 ターン）— 累計と「いま載っている量」は別物

`Reply with exactly one word: PONG` → `Now reply with exactly one word: PING` の 2 ターンを
TUI から流し、`GET /event` の SSE tap と TUI の capture-pane を突き合わせた。

| | ターン 1 後 | ターン 2 後 |
|---|---|---|
| `session.updated` の `tokens` | `input 3 / output 6 / reasoning 0 / cache.read 0 / cache.write 8482` | `input 6 / output 11 / reasoning 0 / cache.read 8482 / cache.write 8500` |
| 上の和 | 8,491 | **16,999** |
| `session.updated` の `cost` | 0.0319065 | 0.0346026 |
| assistant `message.updated` の `tokens.total` | 8,491 | **8,508** |
| TUI サイドパネル | `8,491 tokens` / `1% used` / `$0.03 spent` | `8,508 tokens` / `1% used` / `$0.03 spent` |
| TUI フッタ | — | `8.5K (1%) · $0.…` |

**`Session.tokens` は累計である。** ターン 2 の `input` が `3+3=6`、`output` が `6+5=11`、
`cache.write` が `8482+18=8500` になっている。いっぽう TUI が出すのは 8,508 ＝ **ターン 2 の
assistant メッセージ 1 通**の total であって、16,999 ではない。

`opencode stats` は**累計のほう**を印字する:

```
Input 6 / Output 11 / Cache Read 8.5K / Cache Write 8.5K
Avg Tokens/Session 17.0K        ← 16,999
Total Cost $0.03                ← 0.0346026
```

つまり **Issue #2042 の受入条件 2 本は別々の数を指している**:

- 「`opencode stats --project <path>` の値と一致する」→ **累計**（`session.tokens` の和 16,999 / `cost` 0.0346026）
- 「footer の `6.4K (1%)` と突き合わせ」→ **直近ターンのフットプリント**（8,508 / 1%）

両方出す。ただし**同じ行に混ぜない**。chip は footer と同じ 3 値（`$0.03 · 8.5K (1%)`）、
累計は tooltip に `Spent this session: 16,999 tokens` として別の言葉で置く。

### 14.4 上限の取り方 — `limit.context` であって `limit.input` ではない

```bash
curl -sS http://127.0.0.1:4942/config/providers | jq '.providers[]|select(.id=="github-copilot")|.models["claude-sonnet-4.6"].limit'
# { "context": 1000000, "input": 936000, "output": 64000 }
```

`limit.input` は `limit.context - limit.output` にちょうど一致する（1,000,000 − 64,000 = 936,000）。
**実測 1 点では判別できない**: 8,508 / 1,000,000 = 0.85% も 8,508 / 936,000 = 0.91% も、
`Math.round` すればどちらも `1%` になる。判別には 44,000 トークン規模のセッションを回すか、
14.2 の bundle を読むかのどちらかが要る。**後者を採った。**

shape は `{ providers: [{ id, models: { <modelID>: { limit: { context } } } }] }`。
`models` は配列ではなく**オブジェクト**。

### 14.5 直近ターンのトークン数の取り方

`GET /session/{sessionID}/message?limit=N` は **末尾 N 件**を時系列順で返す（実測）。

```bash
curl -sS "http://127.0.0.1:4942/session/$SID/message?limit=1"   # 1,510 bytes、最後の 1 件だけ
curl -sS "http://127.0.0.1:4942/session/$SID/message?limit=3"   # 3,468 bytes、末尾 3 件
```

各要素は `{ info, parts }` で、カウントは `info.tokens` にある。`limit=4`（＝ user/assistant 2 往復）を
採った理由は 2 つ: ターン進行中で最新 assistant が `output === 0` のとき 1 つ前の完了ターンに
落とせること、そして会話全体を毎回引かずに済むこと。

`info.tokens.total` は opencode 自身の 5 項目の和で、実測 2 通とも 5 項目の和と一致した（8,491 / 8,508）。
**CommandMate は `total` を読まず 5 項目を足している**: `total` はターンが終わるまで現れないので
「進行中は null、終わったら数字」という揺れを避けるため。

**`GET /api/session/{sessionID}/context`（v2）は使えない。** 説明は
"Retrieve the active context messages for a session (all messages after the last compaction)" だが、
実測では 2 ターン走ったセッションに対して `{"data":[]}` を返した（§5.2.2 の v2 全般の不調と同じ傾向）。

### 14.6 CommandMate 側の実装（#2042 で入れたもの）

- `src/lib/hooks/sources/opencode/client.ts`（末尾に追記のみ）
  - `fetchOpencodeModelContextLimit(port, providerId, modelId)` — 14.4
  - `fetchOpencodeContextTokens(port, sessionId)` — 14.5。opencode 自身の `findLast` 条件をそのまま実装
- `src/lib/hooks/agent-session-telemetry.ts` — `AgentSessionContextUsage` と、
  `ensureAgentSessionContextUsage()`（**cache 読みだけで await しない**／stale 判定は `record.at`）。
  `#2040` の `AgentSessionRecord` は 1 バイトも変えていない（verbatim のまま。`tokens.total` も null のまま）
- `src/lib/session/current-output-builder.ts` — `structuredEvents.sessionContext` として publish
- `src/cli/types/api-responses.ts` — CLI 側ミラー
- UI — pane header に `agent · model` と `$0.03 · 8.5K (1%)` の 2 chip、
  desktop header の instance pill は **tooltip のみ**（`MAX_HEADER_AGENT_PILLS` の幅予算を動かさないため）

refresh が 1 ターンに 1 回で済むのは、stale 判定を時計ではなく `record.at` にしているから。
`session.updated` は 1 ターンに数フレームしか来ないので、誰も喋っていないセッションは 1 リクエストも出さない。

### 14.7 実測で確認したもの / していないもの

**したもの**（すべて隔離ハーネス上の 1.18.22 実機）:

- `GET /path` の 5 パスが scratchpad 配下であること
- `session.updated` / `message.updated` の tokens・cost（2 ターン分、SSE tap の JSONL）
- TUI サイドパネルとフッタの表示（`capture-pane`）
- `opencode stats --models` の出力
- `GET /config/providers` の `limit` 3 値
- `GET /session/:id/message?limit=1|2|3|4` の件数と順序
- `GET /api/session/:id/context` が空配列を返すこと
- 実装した `fetchOpencodeContextTokens` / `fetchOpencodeModelContextLimit` を**動いているサーバに撃って**
  `{tokens: 8508, limit: 1000000, percent: 1}` を得たこと
- `ports → client → cache → percent` のサーバ側一連を実機に対して通し、
  1 回目の poll が `null`（＝ await していない）、2 回目が上記の値になること

**していないもの**（推測で埋めていない）:

- **CommandMate の Web UI 実画面での目視**。dev サーバ＋実 worktree＋tmux を立てての UAT は行っていない。
  chip の文字列はユニットテストで実辞書に対して固定してあるが、「画面で見た」証拠ではない。
- **claude / codex で `session.updated` 相当が出ないことの再確認**。#2040 の測定に依拠している。
- **コンテキストが実際に大きいセッション**（44K トークン超）での百分率。14.4 のとおり分母は bundle から
  確定させたので不要と判断したが、`Math.round` の境界（0.5% 付近）は実データでは踏んでいない。
- **`limit.context` を持たないモデル**の実例。`percent: null` の経路はフィクスチャでしか通していない。

### 14.8 この節が変えたもの

- `src/lib/hooks/sources/opencode/client.ts` — 末尾に 2 関数（既存 export は不変）
- `src/lib/hooks/agent-session-telemetry.ts` — 派生レコードとその cache
- `src/lib/session/current-output-builder.ts` — `structuredEvents.sessionContext`
- `src/cli/types/api-responses.ts` — ミラー
- `src/types/agent-session.ts`（新規）— ブラウザ側の型と `sumAgentSessionTokens()`
- `src/components/worktree/*` / `src/hooks/useTerminalPanePolling.ts` — 表示
- `locales/{en,ja}/worktree.json` — `agentSession.*` と `detail.statusPillWithUsage`
- `tests/fixtures/hooks/opencode/{config-providers,session-message-window}-2042.json`（新規）— 14.4 / 14.5 の実応答

## 15. Issue 2044: `run --format json` / cost 集計 / schedule 引数 (opencode 1.18.22, 2026-08-25)

§4 のハーネスをそのまま再実行して取った実測。目的は 3 つ。

1. **日次レポート参加** — `opencode run --format json` の stdout から「本文」を機械的に取り出せるか。
2. **cost 集計** — `session.updated`（#2040 が保持している `{cost, tokens}`）を worktree × 日で足したとき、
   `opencode stats --project` と**一致するのか**。一致の根拠がなければ「照合できる形」とは言えない。
3. **schedule 引数** — `--agent` / `--variant` / `--continue` / `--title` が実際に効くのか
   （`opencode run --help` に載っていることと、セッションに反映されることは別）。

### 15.1 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4877/path
```

返り値（全項目が scratchpad 配下）:

```json
{"home":"…/scratchpad/oc2044/home",
 "state":"…/scratchpad/oc2044/home/.local/state/opencode",
 "config":"…/scratchpad/oc2044/home/.config/opencode",
 "worktree":"…/scratchpad/oc2044/work",
 "directory":"…/scratchpad/oc2044/work"}
```

`auth.json` は `umask 077` で複製し、検証後に削除した。モデルは
`opencode.jsonc` の `"model": "github-copilot/claude-sonnet-4.6"` で固定し、**TUI のモデルピッカーは一度も開いていない**
（この節の計測は TUI をまったく使っていない。tmux も使っていない）。ポートは 4877 のみ、`--hostname 127.0.0.1`。

### 15.2 `run --format json` は NDJSON である（`event:` も配列もない）

```bash
opencode run --format json "Reply with exactly this text and nothing else: hello-2044"
```

stdout（1 行 1 JSON、3 行）:

```text
{"type":"step_start","timestamp":…,"sessionID":"ses_fc7d2c1daffeoHDeorpPDSsbrN","part":{…,"type":"step-start"}}
{"type":"text","timestamp":…,"sessionID":"ses_…","part":{"id":"prt_…","messageID":"msg_0382d42c800146obXtj88Cj4Tr","type":"text","text":"hello-2044","time":{…}}}
{"type":"step_finish","timestamp":…,"part":{…,"type":"step-finish","tokens":{"total":8086,"input":3,"output":7,"reasoning":0,"cache":{"write":8076,"read":0}},"cost":0.030399}}
```

観測された `type`: **`step_start` / `text` / `tool_use` / `step_finish` / `error`**。
`text` の本文は `part.text`。**SSE の `/event` とは別語彙**（§4.3 の 89 語とは重ならない）ので、
`session.updated` の写像を流用してはいけない。

ツールを使う実行では**アシスタントメッセージが 2 通**になる:

```bash
opencode run --format json --agent plan --variant high --title cm-2044-probe \
  "Read README.md and reply with its exact contents."
```

| # | `type` | `part.messageID` | 中身 |
|---|--------|------------------|------|
| 1 | `step_start` | `msg_0382da04a0…` | |
| 2 | `tool_use` | `msg_0382da04a0…` | `part.tool = "read"` |
| 3 | `step_finish` | `msg_0382da04a0…` | `cost 0.03372225` |
| 4 | `step_start` | `msg_0382dafbd0…` | |
| 5 | `text` | `msg_0382dafbd0…` | 答え |
| 6 | `step_finish` | `msg_0382dafbd0…` | `cost 0.0038181` |

**「最後の `text` イベント」ではなく「最後の messageID に属する `text` 群」を取る**のはこれが理由。
1 通目は「ツールを呼ぶと決めた」メッセージであって答えではない。

失敗時（`-m bogusprovider/nope`）は **exit 1 / stderr 空 / stdout に `error` フレーム 1 行**:

```json
{"type":"error","sessionID":"ses_…","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_35bf9864"}}}
```

`-c`（`--continue`）は**直近のセッションを再利用**した（`sessionID` が 1 回目と同じ `ses_fc7d263fdffe…`、exit 0）。

これらの stdout は `tests/fixtures/opencode-run-json-2044/*.jsonl` に**そのまま**置いてある（加工なし）。

### 15.3 cost は「セッション累計」で、足すと `opencode stats` に一致する（**この Issue の核心**）

`step_finish.part.cost` は**ステップごと**、`Session.cost`（SSE `session.updated` / `GET /session`）は
**セッション累計**。実測（同じ project の 2 セッション）:

| session | agent | variant | `GET /session` の `cost` | step の内訳 |
|---------|-------|---------|--------------------------|-------------|
| `ses_fc7d263fdffe…` | `plan` | `high` | `0.03754035` | `0.03372225 + 0.0038181` |
| `ses_fc7d2c1daffe…` | `build` | `default` | `0.030399` | `0.030399` |

そして `opencode stats --project ""`:

```text
Sessions 2 / Messages 5 / Days 1
Total Cost $0.07   Input 6   Output 181   Cache Read 8.4K   Cache Write 16.7K
```

突き合わせ:

| 項目 | セッション累計の和 | `opencode stats` |
|------|--------------------|------------------|
| cost | `0.03754035 + 0.030399 = 0.06793935` | `$0.07` |
| input | `3 + 3 = 6` | `6` |
| output | `174 + 7 = 181` | `181` |
| cache read | `8367 + 0 = 8367` | `8.4K` |
| cache write | `8643 + 8076 = 16719` | `16.7K` |

**結論**: 「セッションごとに最新のスナップショットを 1 行だけ持ち、日で足す」と `opencode stats` に一致する。
逆に言えば、サンプルを**加算してはいけない**（累計値を何度も足すことになる）。
これが migration v58 が `session_id` を PRIMARY KEY にし、`ON CONFLICT DO UPDATE` で**上書き**する理由。
サンプリング周期は正しさに影響しない（最後の 1 回が取れていればよい）。

`Session.tokens` に `total` は無い（`input` / `output` / `reasoning` / `cache.{read,write}` のみ）。
#2040 の `AgentSessionTokenUsage.total` が常に null なのはこのため、という記述と一致した。

### 15.4 `--agent` / `--variant` / `--title` / `-c` はセッションに反映される

`--help` に載っていることと効くことは別なので、`GET /session` で確認した:

```bash
opencode run --format json --agent plan --variant high --title cm-2044-probe "…"
curl -sS http://127.0.0.1:4877/session
```

```json
{"id":"ses_fc7d263fdffe…","title":"cm-2044-probe","agent":"plan",
 "model":{"id":"claude-sonnet-4.6","providerID":"github-copilot","variant":"high"}, …}
```

- `--agent plan` → `Session.agent === "plan"`
- `--variant high` → `Session.model.variant === "high"`（既定は `"default"`）
- `--title cm-2044-probe` → `Session.title`（無指定だとプロンプトを要約した題が付く）
- `-c` → 直近セッションの再利用（15.2）

`--title` は値必須の string option なので、値を省くと**次の引数を食う**。CMATE.md の列でも常に値付きで書く。

### 15.5 `commandmate report generate --tool opencode` の実機実行（受入条件 1）

隔離 HOME のまま、CommandMate 側も隔離して 1 回だけ通した。

```bash
# DB は /tmp 配下を env.ts が system directory として拒否するので worktree の data/ に置く
HOME="$SP/home" CM_DB_PATH="$WT/data/cm-uat-2044.db" CM_PORT=3077 CM_HOST=127.0.0.1   NODE_ENV=development WORKTREE_REPOS="$SP/work" npx tsx server.ts
# worktree 1 件 + chat_messages 2 件 + agent_session_costs 2 件（§15.3 の実測値）を seed
HOME="$SP/home" CM_PORT=3077 npx tsx src/cli/index.ts report generate --date 2026-08-25 --tool opencode
```

結果: **exit 0**。本文は装飾のない Markdown で、`step_start` などのイベント語は 1 つも出ていない。
末尾に cost 節が additive に付き、§15.3 の実測どおりの数字になった:

```markdown
## Agent session cost (2026-08-25)

| Worktree | Sessions | Cost (USD) | Input | Output | Reasoning | Cache read | Cache write |
|---|---:|---:|---:|---:|---:|---:|---:|
| feature/2044-opencode | 2 | 0.067939 | 6 | 181 | 0 | 8367 | 16719 |
| **Total** | 2 | 0.067939 | 6 | 181 | 0 | 8367 | 16719 |
```

**「本文が JSON イベントの最終 text と一致する」は目視ではなくバイト比較で確認した。**
生成に使われた opencode セッション（`ses_fc7bb6007ffe5k7qrsRUH7bLQn` / title `opencode 日次レポート実装まとめ`）を
`GET /session/{id}/message` で引き、最後の assistant message の `text` part 群と、
保存されたレポート本文（cost 節を除いた部分）を突き合わせた結果は **完全一致**。

```text
assistant text parts: 1
final message id: msg_03844a47e001apSWELa3noLKWE
MATCH: True
```

executor 単体でも同じことを確かめてある（`executeClaudeCommand(..., 'opencode', ...)` の返り値と、
同じ argv を手で実行した stdout に `extractOpencodeFinalText()` を当てた結果が一致）。

後始末: CommandMate サーバと opencode serve を PID 指定で停止、`auth.json` を削除、
`data/cm-uat-2044.db` と seed スクリプトを削除。実 tmux は**一度も触っていない**。

### 15.6 未計測 / 計測しなかったこと（推測で埋めていない箇所）

- **`--fork` / `--share` / `-s <id>` は触っていない。** #2038 が `-s` を扱っている。
- **`opencode stats --days` の日境界がローカル日かどうかは未確認。** 本 Issue の `date` 列は
  「エージェントが最後に喋った瞬間のローカル日」で、`daily_reports.date` と同じ綴りに揃えてある。
  `stats --days 1` と厳密に同じ窓である保証は取っていない。§15.3 の突き合わせは `--days` 無し
  （all time）で、たまたま `Days 1` だったケースである。
- **`session.updated` を SSE で受けながらサンプラが台帳へ書く経路は、実 opencode ペインでは踏んでいない。**
  #2040 の記録側（`recordAgentSessionTelemetry`）から台帳までは unit test で通してあるが、
  「TUI ペインを立てて会話し、60 秒サンプラが拾う」ところまでは実測していない。
  §15.3 の数値は `GET /session` から直接取ったもので、写経ではない。
- **スケジュール実行そのものは踏んでいない。** 理由は §15.7。

### 15.7 スケジュール実行への配線（完了）

> **この節は 2 回書かれている。** 初回の #2044 では `src/lib/job-executor.ts` が scope.allow に
> 無く、`executeSchedule()` が `resolveModelOption()`（`{ model }` しか返せない）を呼び続けたため、
> **CMATE.md に書いた `--agent` / `--variant` / `--continue` / `--title` が実行に届いていなかった**。
> 後続の契約で当該ファイルが scope に入り、配線した。以下が現在の姿である。

`job-executor.ts` の `resolveModelOption()` を **`resolveScheduleExecuteOptions()` に改名**し、
CMATE.md 側の規則を `resolveScheduleCommandOptions()`（`cmate-cli-tool-parser.ts`）へ委譲した:

```ts
export function resolveScheduleExecuteOptions(
  entry: ScheduleEntry,
  worktree: WorktreeRow
): ExecuteCommandOptions | undefined {
  const fromCmate = resolveScheduleCommandOptions(entry);
  if (fromCmate) return fromCmate;

  if (entry.cliToolId === 'vibe-local' && worktree.vibe_local_model) {
    return { model: worktree.vibe_local_model };
  }
  return undefined;
}
```

- **委譲であって再実装ではない。** 旧実装は `if (entry.model && TOOLS_WITH_MODEL_SUPPORT.has(...))`
  を**この層に書き写して**いた。1 オプションしか表現できない形だったため #2044 の 4 フラグが落ちた。
  列の文法はパーサの担当で、呼び出し側がその一部でも言い直せば必ずずれる（#1914 が
  `cliToolId === 'copilot'` のハードコードで踏んだのと同じ穴を、1 フィールド後ろで踏んだ）。
- **vibe-local の DB 由来モデルは維持。** そのモデルは worktree row にあり CMATE.md には無いので、
  この分岐は `resolveScheduleExecuteOptions()` 側に残っている。
  `resolveScheduleCommandOptions()` は vibe-local に対して常に `undefined` を返す（どちらの Set にも
  入っていない）ので、2 つの源は実際には交わらない。順序（CMATE.md が先）は旧実装のまま。
- **改名は装飾ではない。** `{ model }` しか返せなかった頃は「model option」で正しかった。
  agent やセッションタイトルまで運ぶ関数には、読み手が信用できる名前が要る。

#### 検証

受入条件「CMATE.md に `opencode --agent plan --variant high` を書いたスケジュールが該当引数で起動する」は
**`executeSchedule()` の入口から** `child_process.execFile` が受け取る argv までを
`tests/integration/schedule-opencode-run-options-2044.test.ts` が固定している
（差し替えているのは `child_process` と DB だけで、`resolveScheduleExecuteOptions` /
`resolveScheduleCommandOptions` / `executeClaudeCommand` / `buildCliArgs` はすべて本物）:

```text
command: 'opencode'
argv:    ['run','--format','json','--agent','plan','--variant','high',"Review today's diff"]
```

同ファイルは claude / codex / gemini / copilot / antigravity / vibe-local の argv を**リテラルの表**で
固定している（導出した期待値は、固定したいコードと一緒に動いてしまう）。

**空振りでないことは変異注入で確認した**（2 回とも実施後に復元済み）:

| 変異 | 結果 |
|------|------|
| `resolveScheduleExecuteOptions()` が `{ model }` だけを返すよう縮退 | 9 件が赤 |
| `executeSchedule()` の呼び出しを削除（＝初回 #2044 が出荷した姿） | **integration の 5 件だけが赤**、unit 2 本は緑のまま |

2 つ目が要点で、**パーサ単体のテストはこの欠陥を検出できない**（両端を検証しても、その間の線については
何も言っていない）。だから scheduler 入口からの integration テストを別に置いてある。

#### §15.6 の「スケジュール実行そのものは踏んでいない」について

その項目は**今も有効**である。ここで固定したのは `execFile` が受け取る argv であって、
`croner` が実際に発火して実機の `opencode` が起動するところまでは踏んでいない
（`child_process` を差し替えている）。実機で確かめてあるのは §15.4 の
「その argv を渡すと `Session.agent` / `Session.model.variant` / `Session.title` がそう変わる」側で、
両者を合わせると経路全体が実測とテストで挟まれている、という状態である。
§15.6 の当該行が指す「理由」は本節の変異注入の結果に置き換わったと読んでほしい。

このほか本節が変えたファイルは `src/lib/job-executor.ts` の 1 関数（改名＋委譲）と
その呼び出し 1 行だけで、`src/lib/cmate-cli-tool-parser.ts` は docblock のみ更新した。

### 15.8 この節が変えたもの

- `src/config/review-config.ts` — `SUMMARY_ALLOWED_TOOLS` に `opencode` を**末尾**追加（既定は `claude` のまま）
- `src/config/opencode-constants.ts`（新規）— `--agent` / `--variant` / `--title` の許容形と長さ
- `src/lib/session/claude-executor.ts` — opencode を `run --format json …` に。`extractOpencodeFinalText()` を追加
- `src/lib/cmate-cli-tool-parser.ts` — CLI Tool 列に opencode のフラグ列を追加（quote 対応 tokenizer / `resolveScheduleCommandOptions()`）
- `src/lib/cmate-parser.ts` / `cmate-validator.ts` / `cmate-writer.ts` — 同オプションの読み書きと検証
- `src/lib/db/migrations/v58-agent-session-costs.ts`（新規）— cost 台帳。`session_id` PK / 上書き（15.3）
- `src/lib/db/agent-session-cost-db.ts` / `agent-session-cost-sampler.ts`（新規）— 台帳 CRUD と in-memory からの写し取り
- `src/lib/daily-summary-generator.ts` — レポート末尾に cost 節を **additive** に追記（プロンプトは不変）
- `src/components/review/ReportTab.tsx` / `worktree/schedules/ScheduleEditDialog.tsx` — 選択肢と入力欄

---

## 16. Issue 2043: このターンの変更ファイル / revert / unrevert（opencode 1.18.22 / 2026-08-26）

### 16.0 結論サマリ（**Issue 本文の前提は実測で崩れた**）

Issue #2043 は「`session.diff` を保持して『このターンの変更ファイル』を出す」と書いている。
**1.18.22 の `session.diff` はそれを運んでいない。**

| 問い | Issue の前提 | 実測 |
|---|---|---|
| `session.diff` は何を運ぶか | このターンが変えたファイル | **revert が現在せき止めている変更**。通常ターン中は常に `diff: []` |
| このターンのファイルはどこから取るか | `session.diff` | `GET /session/:id/diff?**messageID**=<user msg>` のみ |
| `GET /session/:id/diff`（messageID なし） | — | **常に `[]`**。ターン前も後も |
| `POST /revert` の引数 | （記載なし） | `{ messageID }` が**必須**。省略は 400 |
| revert 失敗の見分け方 | （記載なし） | **200 が失敗を意味しうる**。body の `Session.revert` を見るしかない |

Issue 本文が引く「#1758 で 26 通観測」は本リポジトリに証跡が残っていないため、
本節はすべて 2026-08-26 に取り直した一次実測である。**推測値は 1 つも入れていない。**

### 16.1 隔離の確認（先に撃つ）

§4 のハーネスをそのまま使い、`HOME` ごと scratchpad へ差し替えて port 4843 で `opencode serve`。
`auth.json` は mode 600 で複製し、検証後に削除した。TUI のモデルピッカーは一度も開いていない（config で固定）。

```console
$ curl -sS http://127.0.0.1:4843/path
{"home":"…/scratchpad/oc2043/home","state":"…/scratchpad/oc2043/home/.local/state/opencode",
 "config":"…/scratchpad/oc2043/home/.config/opencode","worktree":"…/scratchpad/oc2043/work",
 "directory":"…/scratchpad/oc2043/work"}
```

5 つとも scratchpad 配下。**tmux は本節では一度も使っていない**（REST と SSE tap だけで足りた）ので、
既定 tmux サーバには一切触れていない。後始末は PID 指定 kill（`pkill -f` は使っていない）。
検証後、ユーザーの `~/.local/share/opencode/opencode.db` の mtime が spike 開始前のままであることを確認した。

### 16.2 語彙とスキーマは `GET /doc` から取った（推測していない）

`Event` の 89 種のうち diff / revert 系は 4 種:

```
session.diff                  -> EventSessionDiff
session.next.revert.staged    -> EventSessionNextRevertStaged
session.next.revert.cleared   -> EventSessionNextRevertCleared
session.next.revert.committed -> EventSessionNextRevertCommitted
```

ルートは 3 本（`/api/session/:id/revert/{stage,clear,commit}` は別系統で本 Issue では未使用）:

```
GET  /session/{sessionID}/diff        （query: directory / workspace / messageID）
POST /session/{sessionID}/revert      （body: { messageID: ^msg (required), partID?: ^prt }）
POST /session/{sessionID}/unrevert    （body なし）
```

`SnapshotFileDiff` の **required は `additions` / `deletions` の 2 つだけ**である。
`file` / `patch` / `status` は optional。したがって「`file` は必ずある」と書いたコードは
opencode がその自由を行使した瞬間に `undefined` をファイル名として描画する。
`status` の enum は `added` / `deleted` / `modified` の 3 値。

`Session` 側には `revert?: { messageID, partID?, snapshot?, diff? }` と
`summary?: { additions, deletions, files, diffs? }` がある。

### 16.3 `session.diff` は通常ターンでは**常に空**（本節の中心的な実測）

ファイルを 1 つ作り 1 つ書き換えるターンを 2 回流した。SSE tap の全フレーム内訳（1 ターン目）:

```
45 plugin.added / 20 message.part.updated / 14 message.updated / 8 session.status
 7 session.updated / 4 server.heartbeat / 4 session.diff / 2 file.edited / 1 session.idle …
```

`session.diff` は 4 通来た。**4 通とも `diff: []`。** 時系列は次のとおりで、
**編集が着地した後・`session.idle` と同一ミリ秒のフレームすら空**である。

```
00:58:16.329 file.edited  sample.txt
00:58:17.141 file.edited  added.txt
00:58:19.495 session.idle
00:58:19.495 session.updated  summary={"additions":0,"deletions":0,"files":0}
00:58:19.495 session.diff     diff_len=0        ← 編集 2 件の後、idle と同時刻
```

2 ターン目も同じ（4 通すべて `diff_len=0`）。**合計 8 通 / 空 8 通。**
`Session.summary` も同じ間ずっと `{0,0,0}` だった。

一方、同時刻のファイル系は確かに変わっている:

```console
$ cat work/sample.txt          $ git -C work status --porcelain
line1                           M sample.txt
LINE-TWO-EDITED                ?? added.txt
line3
```

### 16.4 ターンの変更ファイルは `?messageID=` でしか取れない

```console
$ curl -sS "http://127.0.0.1:4843/session/$SES/diff"
[]

$ curl -sS "http://127.0.0.1:4843/session/$SES/diff?messageID=$USER_MSG"
[{"file":"added.txt","patch":"Index: added.txt\n…@@ -0,0 +1,1 @@\n+banana\n…",
  "additions":1,"deletions":0,"status":"added"},
 {"file":"sample.txt","patch":"Index: sample.txt\n…@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE-TWO-EDITED\n line3\n",
  "additions":1,"deletions":1,"status":"modified"}]
```

`messageID` は**ターンを開いた user メッセージの id**（`^msg`）。`^msg` でない値は **400 BadRequest**、
`^msg` だが存在しない値は **200 `[]`**。
`patch` は素の unified diff なので、既存の `DiffViewer` にそのまま渡せる（実装はそうしている）。

**この応答は履歴であって現況ではない。** そのターンを revert した後も同じ 2 件を返し続ける（16.5）。

### 16.5 revert / unrevert の実測

`POST /session/:id/revert {"messageID": <2 ターン目の user msg>}` → **200**。

```json
"revert": {"messageID":"msg_cmateab46…","snapshot":"f920e809…",
           "diff":"diff --git a/sample.txt b/sample.txt\n…-SECOND-TURN"}
"summary": {"additions":1,"deletions":0,"files":1}
```

- ファイルは戻る（`SECOND-TURN` の行が消えた）。
- **直後に `session.diff` が `diff_len=1` で飛んでくる**（それまで 8 通連続で空だったもの）。
  内容は「revert がせき止めているファイル」そのもの。`session.updated` の `revert.messageID` も同時に立つ。
- `GET /diff?messageID=<そのターン>` は**依然として非空**（履歴だから）。
- `GET /diff`（messageID なし）は revert の前後とも `[]` なので、
  **受入条件の「revert で `GET /session/:id/diff` が空になる」は前後とも空という意味で空虚**である。
  意味のある観測は上の `session.diff` と `Session.revert` の方。

**revert は破壊的である。**1 ターン目の user msg を指定して revert すると、
`sample.txt` はセッション前の内容に戻り、**エージェントが作った `added.txt` は削除された**。
さらに、`.gitignore` を commit した後で 1 ターン目へ revert したところ、
**commit 済みの変更まで作業ツリー上で巻き戻り**、`git status` が ` D added.txt` / ` M sample.txt` になった。
revert は git snapshot 台帳からの復元であって「未 commit 分の取り消し」ではない。

`POST /session/:id/unrevert`（body 不要）→ **200**、`Session.revert` が `null` になり `SECOND-TURN` が戻った。
**このとき `session.diff` は 1 通も飛んでこない。** 出たのは `session.updated`（`revert: null`）だけ。
`session.diff` が空になるのを待つ実装は永久に待つ。

#### 16.5.1 200 が失敗を意味する 2 つの形（**実装が最も落ちやすい所**）

| 状況 | HTTP | body の `Session.revert` | 実際に起きたこと |
|---|---|---|---|
| 未 revert 状態で存在しない `msg_…` を指定 | **200** | `null` | 何もしていない |
| **既に revert 中**に存在しない `msg_…` を指定 | **200** | **既存の revert がそのまま** | 何もしていない |
| 正常な revert | 200 | 指定した `messageID` が入る | 実行された |
| `^msg` でない値 | 400 | — | `{"name":"BadRequest","data":{…,"kind":"Payload"}}` |
| ターン実行中 | **409** | — | `{"_tag":"SessionBusyError","sessionID":…}`（revert / unrevert 両方） |
| 何も revert されていない状態での unrevert | 200 | `null` | no-op |

2 行目が厄介で、**`revert === null` かどうかだけを見る実装は「成功」と誤読し、しかも直前の revert の
messageID を成功として報告する。** 本実装はこれを実サーバ相手のプローブで踏んで直した
（`revert.messageID === 要求した id` で判定する）。
なお revert 中に別のターンへ revert し直すことはでき、その場合 `revert.messageID` は差し替わる。

### 16.6 opencode の diff は git の死角を見ない（work-evidence への含意）

`.gitignore` に `ignored/` を書いて commit したうえで、エージェントに `ignored/secret.txt` を作らせた。

```console
$ git -C work status --porcelain      # 空（ignore が効いている）
$ cat work/ignored/secret.txt
hidden
$ curl -sS ".../diff?messageID=$MSG"
[]
```

**opencode 側も `[]`。** opencode の台帳は git snapshot なので git と同じ死角を持つ。
したがって「`session.diff` を work-evidence の証跡に使うと git より広く見える」という期待は**成り立たない**。
それでも additive にする価値があるのは 16.5 の方で、
**この Issue が足す revert ボタン自体が、作業ツリーを git から見て「何もしていない」状態にしうる**からである。

### 16.7 CommandMate 側の実装（#2043 で入れたもの）

- `src/lib/hooks/sources/opencode/client.ts`（末尾に追記）— `readOpencodeFileDiffs()` /
  `fetchOpencodeMessageDiff()` / `revertOpencodeMessage()` / `unrevertOpencodeSession()`。
  戻り値は `OpencodeRevertOutcome`（`reverted` / `restored` / `no_op` / `busy` / `rejected` / `unreachable`）で、
  16.5.1 の 200 を `no_op` として分離している。
- `src/lib/hooks/sources/opencode/diff.ts`（新規）— インスタンスごとの diff 状態。
  `session.diff`（せき止め分）・`session.updated`（`Session.revert`）・
  `message.updated` role=user（`messageID`）の 3 種から組み立て、
  `ensureOpencodeSessionDiff()` が #2042 と同じく**ターンが動いたときだけ** REST を 1 回撃つ。
- `src/lib/hooks/sources/opencode/subscription.ts` — `deliver()` に**独立した 1 ブロック**を追加（#2041 の直後）。
- `structuredEvents.sessionDiff` — `session`（#2040）/ `sessionContext`（#2042）に次ぐ 3 つ目。**additive**。
- `src/app/api/worktrees/[id]/opencode/diff/route.ts`（新規）— `GET`（強制再読）と `POST`（`revert` / `unrevert`）。
  revert の対象 `messageID` は**サーバ側の記録から取る**（ブラウザからは受け取らない）。
- `src/components/worktree/OpencodeTurnDiffPanel.tsx`（新規）— opencode 限定・空なら非表示。
  ファイル名クリックで既存 `DiffViewer` を開き、revert / unrevert は確認ダイアログ必須。
- `src/lib/verification/gate-runner.ts` — `work-evidence` に第 2 証跡を additive に追加。
  **git が何も見つけなかった分岐でしか呼ばれない**、かつ**opencode インスタンスを名指しした run でしか呼ばれない**。

### 16.8 実測で確認したもの / していないもの

確認したもの: 16.2〜16.6 の全て（`GET /doc` の schema / `session.diff` 8 通の中身 / `?messageID=` の応答 /
revert・unrevert の 200・400・409 / 破壊性 / 200 の 2 つの失敗形 / gitignore の死角）。
実装コードそのものを稼働中サーバへ当てて 6 通りの `OpencodeRevertOutcome` を確認した（`tsx` で直接実行）。

**計測していないもの**（推測で埋めていない）:

- `POST /revert` の `partID`。ターンの途中まで戻す用途と読めるが撃っていない。実装も送っていない。
- `session.next.revert.staged` / `.cleared` / `.committed` の 3 イベントと
  `/api/session/:id/revert/{stage,clear,commit}`。別系統で、本 Issue の UI からは触っていない。
- `GET /diff` の `directory` / `workspace` query。
- CommandMate の UI を通した実機の end-to-end（隔離サーバ + ブラウザ）。
  検証したのは REST / SSE の層と、実装関数を稼働サーバへ当てた層まで。UI 側は unit test で挟んである。

## 17. Issue 2045: `question.asked` / `session.error` / `installation.update-available` を push に繋ぐ（opencode 1.18.22 / 2026-08-25）

> **この節は #2045 が追記したものです。§1〜§16 は書き換えていません。**
> §11 と同様、§1〜§10（1.18.3）と食い違う記述があれば **版が違う**ことを先に疑ってください。

### 17.1 結論サマリ

| 検証項目 | 結果 |
|---|---|
| `question.asked` の payload が 1.18.3 の fixture と同形か | **一致**（[§17.2](#172-questionasked-の実測)） |
| `question.asked` のあと `session.idle` が来ないこと | **来ない**。20 秒後も `GET /session/status` は `busy` のまま |
| `session.error`（provider エラー）を隔離サーバで発生させられるか | **可**。LM Studio に model 未ロードで `APIError`（[§17.3](#173-sessionerror-の実測)） |
| `session.error` が 1 ターンで何回出るか | **1 回**（`session.idle` は 2 回。§5.3.2 の再確認） |
| `session.error` の `error.name` の全列挙 | **8 種**（`GET /doc` 一次情報。[§17.3](#173-sessionerror-の実測)） |
| `installation.update-available` の payload | **`{ version }` のみ。`sessionID` は無い**（`GET /doc` 一次情報） |
| `installation.update-available` の発火 | **未計測**。保留中の更新を作れなかった（[§17.4](#174-installationupdate-available-は発火を計測できていない)） |
| push が 1 通ずつ届くこと | **単体では実測できていない**（[§17.5](#175-受入条件のうち実測できた範囲とできなかった範囲)） |

### 17.2 `question.asked` の実測

§4 のハーネス（隔離 HOME・専用 socket・`--port 4795`）で、
`POST /session/:id/prompt_async` に「`question` tool を 1 回だけ呼べ」と指示して誘発した。
**TUI のモデルピッカーは一度も開いていない**（モデルは隔離 HOME の `opencode.jsonc` で固定）。

```text
01:00:57.396 session.created
01:00:57.544 session.status  busy
01:00:59.689 message.part.updated
01:01:00.596 question.asked          ← ここで止まる
01:01:00.596 message.part.updated
（以降 20 秒間、このセッションのフレームは 1 件も無い）
```

```json
{"id":"evt_…","type":"question.asked","properties":{
  "id":"que_…","sessionID":"ses_…",
  "questions":[{"question":"Which colour do you prefer?","header":"Colour preference",
    "options":[{"label":"Red","description":"The colour red"},
               {"label":"Blue","description":"The colour blue"}]}],
  "tool":{"messageID":"msg_…","callID":"toolu_…"}}}
```

**`tests/fixtures/hooks/opencode/question-asked.json`（1.18.3 採取）と構造が完全に一致**したので、
fixture は差し替えていない。

20 秒後の `GET /session/status`:

```json
{"ses_fc658bfcfffefpZkL5Uy1uPLJ2":{"type":"busy"}}
```

→ **§5.3.1 が 1.18.22 でも成立する。** 質問は `busy` のままで `session.idle` を出さない。
加えて **このリポジトリには opencode の質問を自動応答する経路が無い**（コードで確認）:

- `replyOpencodeQuestion` の呼び出し元は `source.ts` の `decision.kind === 'question'` 分岐 1 箇所のみ。
  そこへ到達するのは `answerPendingDecisionWithReceipt` の 4 呼び出し元のうち、
  **人間が起点の 2 つ**（`respond` の構造化 decision、`structured-decision-response`）だけである。
- 残る 2 つは Auto-Yes 側で、どちらも質問に掛からない。`permission-adjudication` は
  `ingest` の **`permission.asked` 分岐**からしか呼ばれず、
  `pending-decision-recheck` は `pending.filter(d => d.kind === 'permission')` で
  **質問を明示的に落としている**。
- 陰性対照ではなく**陽性対照**で確かめてある: 同じ grep が `replyOpencodePermission` については
  自動経路（`permission-adjudication` 経由）を見つける。
**だから質問は人間が触るまで無期限に止まる**というのが、この Issue が push を
「status プローブが観測する waiting edge」ではなく **ingest から直接**上げる根拠である。

### 17.3 `session.error` の実測

同じハーネスで、`lmstudio`（model 未ロード）を指定して 1 ターン投げた。

```text
01:00:26.104 session.status  busy
01:00:26.120 session.error           ← 1 回だけ
01:00:26.120 session.status  idle
01:00:26.120 session.idle            ← 1 回目
01:00:26.144 session.idle            ← 2 回目（24 ms 後）
```

**`session.error` は 1 回、`session.idle` は 2 回。** §5.3.2 (a) と同じ形が 1.18.22 でも再現した。
payload も `tests/fixtures/hooks/opencode/session-error.json`（1.18.3）と同形。

`GET /doc` の `EventSessionError.properties.error` は **8 つの anyOf**（一次情報）:

| `error.name` | `data` に `message` があるか | push で failure として通知するか |
|---|---|---|
| `APIError` | あり（＋ `statusCode` / `isRetryable` / `responseBody` …） | する |
| `ProviderAuthError` | あり（＋ `providerID`） | する |
| `UnknownError` | あり（＋ `ref`） | する |
| `MessageOutputLengthError` | **無い**（`data` は空オブジェクト） | する（本文は `error.name` にフォールバック） |
| `StructuredOutputError` | あり（＋ `retries`） | する |
| `ContextOverflowError` | あり（＋ `responseBody`） | する |
| `ContentFilterError` | あり | する |
| `MessageAbortedError` | あり（`"Aborted"`） | **しない**（interrupt。§5.3.2 (b)） |

**`upstream-fault`（既存の `FailurePushReason`）を再利用しなかった理由**はこの表にある。
上流由来と言い切れるのは `APIError` / `ProviderAuthError` の 2 つだけで、
残り 5 つはローカル側の失敗（§11.4 の `UnknownError: TypeError: … cannot be parsed as a URL` が実例）。
「上流APIの障害で停止しています」は**フレームが立証していないことを断言する文言**になるので、
`agent-session-error` を新設して「エージェントがエラーで停止しました: {excerpt}」とし、
どの失敗かは excerpt（＝ `error.data.message`）に語らせる。

`MessageOutputLengthError` に `message` が無いことは実装に効いている：
`describeNotification()` の `error.data.message ?? error.name` のフォールバックは、
**8 種のうちこの 1 種のためだけに必要**である。

### 17.4 `installation.update-available` は発火を計測できていない

**payload の形は一次情報**（`GET /doc`、1.18.22）:

```json
{"type":"object","properties":{
  "id":{"type":"string","pattern":"^evt_"},
  "type":{"type":"string","enum":["installation.update-available"]},
  "properties":{"type":"object","properties":{"version":{"type":"string"}},
                "required":["version"],"additionalProperties":false}},
 "required":["id","type","properties"],"additionalProperties":false}
```

**`properties` は `version` だけで、`sessionID` は無い。**

**発火は再現できなかった。** 手元の opencode は 1.18.22 で最新（`GET /global/health` →
`{"healthy":true,"version":"1.18.22"}`）であり、**保留中の更新という状態を作れない**。
§6 が `installation.update-available` を「未計測（更新保留状態を作れなかった）」と書いたのと同じ理由で、
この Issue でも計測できていない。**推測で埋めていない。**

実装上の帰結は 2 つある。

1. **Issue 本文の「1 セッション 1 回に抑える」は、opencode の chat session では実現できない。**
   フレームに `sessionID` が無いので、写像できる単位は**購読（＝ SSE 接続）**しかない。
   実装は `OpencodeSubscriptionState.announcedUpdates: Set<string>`（version をキー）で、
   接続が生きているあいだ同じ version を 1 回しか通知しない。接続が閉じれば忘れる。
2. **fixture は実測ではない。** `tests/fixtures/hooks/opencode/installation-update-available.json` は
   上のスキーマから起こしたもので、README にもそう明記してある。
   **実フレームが来たら差し替えること**（`version` 以外のキーが増えていないかを最初に確認する）。

### 17.5 受入条件のうち実測できた範囲とできなかった範囲

Issue の受入条件は「隔離サーバで question / provider エラーを発生させ、**push が 1 通ずつ届く**」である。

| 受入条件の部分 | 実測 |
|---|---|
| 隔離サーバで question を発生させる | **済**（§17.2） |
| 隔離サーバで provider エラーを発生させる | **済**（§17.3） |
| **端末に push が 1 通ずつ届く** | **未実施**。VAPID 鍵つきの CommandMate サーバと実際に購読済みの端末（iOS/Android）が要るため、この作業では踏んでいない |
| claude / codex の発火回数が変更前と一致する | **済**（テスト。`tests/integration/opencode-push-parity-2045.test.ts`） |

**「1 通ずつ」は端末の代わりに `web-push` の直前で数えた。**
`tests/unit/hooks/sources/opencode-push-2045.test.ts` は実 SQLite・実 `notifyPushSubscribers`・
実 dedup で走り、`webpush.sendNotification` の呼び出し回数だけを見る。
そこで押さえた性質は 4 つ:

- question 1 件 → 1 通。**その後 status プローブが同じ待ちを報告しても 2 通目は出ない**
  （`waitingSince` を frame の `receivedAt` に揃えてあるので `shouldSendWaitingPush` が重複と判定する）。
- 同じフレームの二重配送 → 1 通（#1899 の identity ガードの後ろに居るため）。
- `session.error` 1 件 → 1 通。`MessageAbortedError` → **0 通**。
- `installation.update-available` → 接続あたり version ごとに 1 通。

**残った既知の限界**（テストにも明記した）: `session.error` は per-frame id を持たないので
`classifyAgentEventDelivery` の 3 秒窓（`AGENT_EVENT_DEDUP_WINDOW_MS`）に掛かる。
**3 秒以内に届いた別種のエラー 2 件は 1 通に潰れる。**
これは push 側ではなく ingest 側の配送ガードの性質で、#1898 が確立した
「裁定・記録が push より先」という順序を崩さないかぎり動かせない。動かしていない。

### 17.6 非汚染の証拠

| 項目 | 値 |
|---|---|
| 版 | **1.18.22**（`GET /global/health` → `{"healthy":true,"version":"1.18.22"}`） |
| 隔離 HOME | `GET /path` の `home` / `state` / `config` / `worktree` / `directory` **5 つすべてが scratchpad 配下**であることを確認済み |
| ポート | **4795**。3000 は使っていない。`--hostname 127.0.0.1` |
| tmux | **使っていない**（TUI を起動せず REST + SSE tap だけで完結した。既定 tmux サーバには 1 コマンドも撃っていない） |
| モデルピッカー | **一度も開いていない**（隔離 HOME の `opencode.jsonc` で固定） |
| `auth.json` | mode 600 で複製し、**検証後に削除**（削除確認済み） |
| ユーザー HOME 非汚染 | 検証終了時点で `~/.local/share/opencode/opencode.db` の mtime は **検証開始（8/26 00:59）より前の 8/25 14:16 のまま**、`~/.config/opencode/opencode.jsonc` は 7/19 のまま |
| 後始末 | `opencode serve` と SSE tap を **PID 指定で kill**（`pkill -f opencode` は使っていない）。質問で止まったセッションは `POST /session/:id/abort` で閉じた |

### 17.7 変更ファイル

- `src/lib/hooks/sources/opencode/push.ts`（新規）— opencode に閉じた 3 つの通知プロデューサ
- `src/lib/hooks/sources/opencode/ingest.ts` — `question.asked` / `session.error` から上記を呼ぶ
- `src/lib/hooks/sources/opencode/subscription.ts` — `installation.update-available` を `deliver()` で読む（7 語に写像されないため）＋ 接続スコープの重複抑止
- `src/lib/push/push-sender.ts` — `FailurePushReason` に `agent-session-error`、`NotificationEvent.updateAvailable`
- `locales/{en,ja}/notifications.json` — `failureAgentSession*` / `updateAvailable`

---

## 18. Issue 2050: 検出カナリアに opencode を入れる（opencode 1.18.22 / 2026-08-26）

**目的**: `scripts/canary/` は #1727 以来 claude 専用で、`docs/qa/detection-canary.md` にも
「claude 以外のツール（codex / gemini / antigravity / copilot / opencode）は未対応」と書いてあった。
`src/lib/detection/tools/opencode/detect.ts` の規則は 1.18.21 の capture から読んだきりで、
**インストール済みは 1.18.22** だった。本節は 1.18.22 で 5 状態を実測し直し、
`OPENCODE_VERIFIED_AGAINST` を更新するまでの記録。

### 18.1 ハーネス

§4 の手順**そのまま**。新しい隔離方法は発明していない。

- 使い捨て `HOME`（`mkdtemp`）。`~/.local/share/opencode/auth.json` を **mode 600 で複製**し、
  実行後に HOME ごと削除
- `~/.config/opencode/opencode.jsonc` で model を固定（**モデルピッカーは事前調査で一度も確定していない**）
- 私設 tmux socket（`tmux -L cmate-canary-<pid>-<run>`）。`kill-server` は
  `PrivateTmuxServer.killServer()` 経由でしか到達できず、必ず `-L` が前に付く
- pane は本番と同じ **80 x `OPENCODE_PANE_HEIGHT`(200)**（`launchSession()` が実セッションを
  resize する値）。`capture-pane -p -e -S -200`

§4 に無い追加が 2 点ある。どちらも「§4 の隔離を弱めない追加」である:

1. **XDG 変数を子環境から落とす**（`XDG_{CONFIG,DATA,STATE,CACHE}_HOME` / `OPENCODE_CONFIG*`）。
   HOME を差し替えても、これらが残っていると使い捨て HOME の中から実ディレクトリへ戻れる
2. **実ファイルの before/after 照合**を canary の guard に追加。
   `~/.config/opencode/opencode.json{,c}` と `auth.json` は sha256、
   `~/.local/share/opencode/opencode.db` は **size+mtime**（58MB あり、シナリオごとに 2 回ハッシュすると
   実行そのものより重くなる）。違反は exit 3

### 18.2 実測: 5 状態と検出結果（opencode 1.18.22, 80x200, 2026-08-26）

`detect.ts` の**陽性分岐 A0 / A / C / D / E に 1 本ずつ**。この 5 本が opencode の status detector が
言えることの全部なので、5 本緑＝「その版で規則がまだ成り立っている」になる。

| branch | 画面 | `detectSessionStatus(frame,'opencode')` | `evidence` | Auto-Yes |
|---|---|---|---|---|
| E | 起動直後 `┃  Ask anything...` | `ready` / `input_prompt` | positive | 沈黙 |
| A | 生成中 `⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt` | `running` / `opencode_processing_indicator` | positive | 沈黙 |
| A0 | `┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter con` | `waiting` / `opencode_permission_prompt`（`hasActivePrompt=false`） | positive | **見えない** |
| C | `/models`（ヘッダ `Select model … esc`） | `waiting` / `opencode_selection_list` | positive | **見えない** |
| D | `▣  Build · Claude Sonnet 4.6 · 12.8s` | `ready` / `opencode_response_complete` | positive | 沈黙 |

**1.18.21 からの差分は無い。** 5 分岐すべてが 1.18.21 と同じ答えを返した。よって別 Issue への切り出しは不要。

### 18.3 実測でわかった 4 点（推測ではない）

1. **既定の permission では承認ダイアログが出ない。** 素の 1.18.22 に
   「`ls -la` を実行して」と頼むと**そのまま実行され**、`▣ Build · … · 4.6s` で終わる。
   A0 を観測するには使い捨て config に `permission: { bash: "ask", edit: "ask", webfetch: "ask" }` が要る。
   claude の `--permission-mode manual`（#1847）と**同じ性質の固定**であり、
   カナリアについての言明であって CommandMate のセッションがこうなるという話ではない。
2. **`Ask anything...` はホーム画面だけ。** 1 ターン走ったあとの composer は素の `┃` になり、
   完了フレームの `ready` は branch E ではなく **branch D（完了マーカー）**から出る。
   よって `opencode-idle` と `opencode-turn-complete` は `reason` が異なる別状態である。
3. **承認ダイアログは Escape で reject できる。** 押した直後のフレームは
   duration の無い `▣  Build · Claude Sonnet 4.6` だけが残り、`running` / `unknown_frame` になる
   （`turn-aborted-no-duration` と同じ形）。canary の `resetKeys: ['Escape']` はこれ。
4. **`/models` picker は Escape で「確定せずに」閉じる。** 閉じたあとの config は複製したままで、
   model は書き換わっていない（隔離 config を diff して確認）。

補助データ: `▣ Build` の duration は 12.8s / 4.6s / 20.7s を観測。
`opencode --version` は 1.18.22、TUI は起動から約 3.6 秒で composer に到達（#1908 の実測と一致）。

### 18.4 版ずれ検出（`opencode --version` × `verifiedAgainst`）

preflight が実行する `<tool> --version` を**そのまま陳腐化プローブに使う**。出力は
`src/lib/detection/version-probes.ts` と同じ `parseCliVersion` を通り、
`commandmate status` / `npm run check:detector-freshness` が読むのと同じ
`DETECTOR_VERIFIED_AGAINST` と突き合わされる（子プロセスは増えない）。

更新前（stamp = 1.18.21）の実出力:

```
opencode 1.18.22 · tmux 3.5a · pane 80x200
VERSION DRIFT: opencode 1.18.22 is installed, rules read off 1.18.21 @ 80x200
  — re-capture fixtures and update tools/verified-against.ts
```

更新後（stamp = 1.18.22）:

```
rules     : opencode 1.18.22 · rules read off 1.18.22 @ 80x200
```

既定は**警告のみ**で exit code に影響しない。`--strict-version` のときだけ exit 5 になる。
版が上がった当日でも全シナリオが緑のことはあり、版番号だけで赤くなるカナリアは
「無視してよいもの」として学習されて仕組みごと死ぬため。
赤が出たときはサマリ直後にも drift を再掲する（「検出回帰か、昨日上げただけか」を同じ画面で判別させる）。

pane geometry も一緒に報告する。**別の幅で採った fixture は本番が見ている画面の fixture ではない**ため
（今回は 80 桁のみ採取。120 / 200 桁は #2047 の担当で、互いの幅に触らない）。

### 18.5 非空振りの証明（3 段構え）

| 何を壊したか | どう壊したか | 結果 |
|---|---|---|
| **本番パターン 1 つ** | `OPENCODE_PERMISSION_PATTERN` の `Allow once` → `Approve once`（gutter アンカーと他 2 ラベルは温存） | `opencode-permission` が **181 秒 timeout で FAIL**（`running` / `unknown_frame`）、exit 1。パターンは実行後に復元 |
| **ハーネスの期待値** | `npm run canary -- --tool opencode --mutate` | **5/5 赤** → `mutation self-test PASSED`（exit 0）、180.7 秒 |
| **commit 済みフレームの 1 行** | `tests/unit/canary/canary-opencode-2050.test.ts` の `frame mutation` ブロック（ボタン列ラベル / ボタン列 gutter / busy フッタの語 / picker ヘッダ / 完了マーカーの duration / composer プレースホルダ） | 各期待値が不一致になることを CI で保持 |

**変異はすべて構造を保つもの**にしてある。gutter 行ごと削除するような変異は、
後段が gutter を境界に使っている場合に別の理由で赤くなり、何を証明したのか分からなくなる。
1 段目の gutter 変異だけは gutter を**空白に置換**（削除ではない）しており、行の幅と位置は保たれる。

mutant の選び方には落とし穴がある: `--mutate` は「mutant で緑になったら空振り」と報告するので、
**シナリオが自然に流れ着く状態を mutant にしてはならない**。
`opencode-generating` の mutant に `opencode-turn-complete` を当てるのは駄目で、
実測のターンは 12.8 秒 —— `--mutate` の 30 秒時計に収まるので mutant が真になり誤報になる。
現行 5 本の mutant はどれも「そのシナリオが決して描かない行」を要求している。

### 18.6 非汚染の証拠

| 項目 | 実測 |
|---|---|
| tmux | 全呼び出しが `-L cmate-canary-*`。既定サーバへは `guards.listUserTmuxSessions()` の `list-sessions`（読み取り専用）だけ |
| `mcbd-*` セッション | 31 本を実行前後で照合、増減なし（違反なら exit 3） |
| モデルピッカー | 隔離 HOME 内でのみ開き、**Escape で閉じて一度も確定していない** |
| 実 `~/.config/opencode/opencode.jsonc` | 実行前後で sha256 一致（`4e901f9e…`） |
| 実 `~/.local/share/opencode/auth.json` | 実行前後で sha256 一致（`eec9856e…`） |
| 実 `~/.local/share/opencode/opencode.db` | size 58531840 / mtime 8/25 14:16 のまま（本作業より前） |
| `auth.json` の複製 | 使い捨て HOME に mode 600 で作り、HOME ごと削除 |
| 事前調査用セッション | `tmux -L cmate-canary-2050 kill-session -t '=<name>:'` で個別に終了（`kill-server` は使っていない） |

### 18.7 未実施・積み残し

- **codex / gemini / antigravity / copilot は未対応のまま。** canary は `tool-profiles.ts` に
  1 エントリ足せば増やせる形になったが、実測は各ツールで別途必要
- **opencode の hooks シナリオは無い。** #1847 の 2 本は claude の `PermissionRequest` 契約を見るもので、
  opencode の `AgentEventSource` には裁定して返す相当物が無い。`--mutate-verdict` に
  `--tool opencode` を渡すと「mutate するものが無い」と拒否する
- **`ctrl+p` コマンドパレットはシナリオにしていない。** `OPENCODE_SELECTION_LIST_PATTERN` が
  名前を持たずフレームは `running` / `default`（証拠なし）に落ちる —— #1896 で実測済みの既知の穴で、
  既知の穴を緑の期待値に固定するとカナリアが恒常的に赤になり signal として死ぬ
- **120 / 200 桁の fixture は採っていない**（#2047 の担当）

### 18.8 変更ファイル

- `scripts/canary/tool-profiles.ts`（新規）— ツールごとの実行形。geometry / capture 行数 /
  起動完了行 / 起動オーバーレイ / 起動フラグ
- `scripts/canary/opencode-scenarios.ts`・`opencode-expectations.ts`（新規）— 5 シナリオと純関数の期待値
- `scripts/canary/{types,probe,session,isolated-home,guards,cli,scenarios,fixtures,runner}.ts` —
  ツール次元の導入、opencode の HOME シード、実ファイル guard の一般化、`--tool` / `--strict-version`、版ずれ報告
- `src/lib/detection/tools/verified-against.ts` — opencode を 1.18.22 / 2026-08-26 に更新
- `tests/unit/canary/canary-opencode-2050.test.ts`（新規）・`canary-cli-fixtures.test.ts`
- `tests/fixtures/canary/opencode-*.{ts,raw.txt}`（新規、5 状態 × 2）
- `docs/qa/detection-canary.md`・`scripts/canary/README.md`
## 19. Issue 2049: 端末ビューの空行圧縮を opencode に開く（opencode 1.18.22 / 2026-08-26）

### 19.1 結論サマリ

| | |
|---|---|
| Issue 本文の前提 | 「opencode の端末ビューには空行圧縮が無い」 |
| **実測** | **圧縮機構は Issue #1172 で既にある。`claude` / `codex` 限定になっていただけ**（宣言は PC / モバイルの 2 箇所） |
| 素直に opencode を足すと何が起きるか | **picker / command palette のパネル帯が消える。** 実測フレームで 8 行中 7 行しか残らない |
| なぜ消えるか | opencode のオーバーレイは**背景色で塗ったパネル**で、区切り行に**グリフが 1 つも無い**（70 桁のスペースに `ESC[48;2;20;20;20m`）。`stripAnsi(row).trim() === ''` なので #1172 の規則が layout padding と読む |
| 採った規則 | **「桁を塗っていて（`stripAnsi(line) !== ''`）かつ背景色 SGR を持つ空行」は構造**。それ以外の空行はこれまでどおり畳む |
| composer / 承認ダイアログ | **何もしなくてよい。** どちらも `┃`（U+2503）を持つのでそもそも空行ではない。テストは「そう仮定する」のではなく**そう assert する** |
| 圧縮率（実測） | boot idle 201 行 → **16 行** / 2 ターン完了 201 行 → **43 行** / palette 展開 201 行 → **58 行** |

### 19.2 隔離の確認（先に撃つ）

§4 のハーネスをそのまま使った。TUI を起動する必要があったので tmux も使っている。

```bash
SP=…/scratchpad/oc2049
# §4.1 のとおり HOME ごと差し替え、auth.json は umask 077 で複製、model は config で固定
HOME="$SP/home" opencode serve --port 4796 --hostname 127.0.0.1 &
curl -sS http://127.0.0.1:4796/path
```

`GET /path` の返り値（`home` / `state` / `config` / `worktree` / `directory` の **5 つすべて**）が
`…/scratchpad/oc2049/` 配下であることを確認してから 1 打鍵目を送った。

TUI は**専用 socket** で、CommandMate の本番ジオメトリ（80 桁 × `OPENCODE_PANE_HEIGHT` = 200 行）:

```bash
tmux -L cmate-2049-oc new-session -d -s oc2049 -x 80 -y 200 -c "$SP/work" \
  "env HOME='$SP/home' TERM=xterm-256color opencode"
tmux -L cmate-2049-oc capture-pane -p -e -t '=oc2049:0.0' -S -0 -E -
tmux -L cmate-2049-oc kill-session -t '=oc2049:'     # kill-server は使っていない
```

**モデルピッカーは一度も開いていない。** opencode はピッカーで既定モデルを書き換えるため、
同じパネル chrome を持つ `ctrl+p` command palette（読むだけのコマンド一覧）で代替し、`Esc` で閉じた。

### 19.3 空行は 3 種類しかない（これが規則の根拠）

リポジトリ内の opencode 実キャプチャ全 22 本＋今回の 1.18.22 の 3 本について、
`stripAnsi(row).trim() === ''` な行を「桁を塗っているか」×「背景色 SGR を持つか」で分類した:

| 分類 | 実例 | 出現数 | 正体 |
|---|---|---|---|
| 桁なし・SGR なし | `''` | 1 フレームあたり 114〜188 | **layout padding** |
| 桁なし・背景 SGR あり | `ESC[38;2;255;255;255m ESC[48;2;4;4;4m` | **1 フレームにちょうど 1** | フレーム全体の色初期化 |
| **桁あり・背景 SGR あり** | `ESC[48;2;20;20;20m` ＋ 70 桁スペース ＋ `ESC[48;2;4;4;4m` | オーバーレイのフレームだけ 8〜9 | **パネル本体** |

**「桁あり・背景 SGR なし」は 1 行も存在しない。** 2 条件を AND にしても OR にしても
このコーパスでは同じ判定になるが、AND を採った（「帯を塗っている」ほうが「たまたま空白が残っている」より
パネルの定義として素直で、padding を過剰に守らない）。

「桁なし・背景 SGR あり」を除外するために条件 1（桁を塗っていること）が要る。
これを落とすと**全フレームの先頭 1 行が構造扱いになり、leading trim が効かなくなる**。

### 19.4 `ctrl+p` の実測フレーム（1.18.22）

`tests/fixtures/opencode-live-2049/command-palette-11822.txt` の行番号:

```
   1  空行（桁なし・背景 SGR あり）    ← フレーム色初期化
   2..50  空行（桁なし・SGR なし）      ← layout padding（49 行）
  51  ★ パネル帯（70 桁・ESC[48;2;20;20;20m）
  52  '              Commands                                         esc    '
  53  ★ パネル帯
  54  '              Search                                                  '
  55  ★ パネル帯
  …
  93  ★ パネル帯
  94..98  コマンド項目
  99..104 composer（`┃` 行）とその下の `╹▀▀▀…`
 105..196 空行（layout padding）
 197..199 パス／版表示（`1.18.22`）
```

**行 2..51 は #1172 の規則から見れば「50 行連続の空行」で、1 行に畳まれる。**
その 1 行は `extractAnsiSequences()` の結果なので**桁を持たない**——つまり
**パネルの上端がフレームから消える。** これが Issue #2049 の実体。

| 規則 | 出力行数 | 残ったパネル帯 | `┃` 行 | `╹` 行 |
|---|---|---|---|---|
| 生キャプチャ | 201 | 8 | 4 | 1 |
| #1172（素直に opencode を足した場合） | 57 | **7** | 4 | 1 |
| **#2049** | 58 | **8** | 4 | 1 |

他の 2 フレーム（`boot-idle-11822` / `two-turn-idle-11822`）はパネルを持たないので
**両規則の出力がバイト一致**する（201 → 16 行 / 201 → 43 行）。
`┃` は boot idle で 4 行、2 ターン完了フレームで 24 行、いずれも**全数が残る**。

### 19.5 実測できなかったもの（推測で埋めていない）

- **1.18.22 の承認ダイアログのフレームは採れていない。** 隔離 config の下で
  1.18.22 は `ls -la` の実行も `probe.txt` の書き込みも**ダイアログを出さずに実行した**
  （12 回 × 3 秒のポーリングで `Permission required` は 1 度も出現せず）。
  そのため承認ダイアログの行は、リポジトリに既にある 1.18.20 / 1.18.21 の実キャプチャ
  （`tests/unit/lib/detection/fixtures/opencode-live-1893/`、`…/opencode-live-1896/permission-over-numbered.txt`）
  に対して assert している。**版が違うことを承知のうえでの代替**であり、
  1.18.22 で採れたことにはしていない。
- **モデルピッカーのフレームは 1.18.22 では採っていない**（既定モデルを書き換える罠を避けたため）。
  同じパネル chrome を持つ `ctrl+p` で代替した。1.18.21 のピッカー実キャプチャ
  （`…/opencode-live-1896/model-picker.txt`）もテストに入れてある。
- **`copilot` の padding 量は測っていない。** よって copilot は圧縮対象に**入れていない**
  （Issue の受入条件「claude / codex / copilot の端末ビューは不変」とも一致する）。
- **「履歴タブを既定にする」UI 設定（Issue 本文の任意項目）は入れていない。** 設定の描画面
  （`AgentSettingsPane.tsx` / `WorktreeDetailSubComponents.tsx`）は並行する Issue #2048 の所有物で、
  本 Issue の scope 外。UI の無い設定値だけを足すのは半端なので見送った。

### 19.6 非汚染の証拠

| 項目 | 値 |
|---|---|
| 版 | **1.18.22**（フレーム右下の版表示、および `capture-pane` の行 197） |
| 隔離 HOME | `GET /path` の 5 項目すべてが scratchpad 配下であることを確認済み |
| ポート | **4796**。3000 は使っていない。`--hostname 127.0.0.1` |
| tmux | **専用 socket `cmate-2049-oc` のみ**。既定サーバへは 1 コマンドも撃っていない。後始末は `kill-session -t '=oc2049:'`（`kill-server` は使っていない） |
| モデルピッカー | **一度も開いていない** |
| `auth.json` | mode 600 で複製し、**検証後に削除**（削除確認済み） |
| ユーザー HOME 非汚染 | 検証終了時点で `~/.local/share/opencode/opencode.db` の mtime は**検証開始（8/26 09:57）より前の 8/25 14:16 のまま**、`~/.config/opencode/opencode.jsonc` は 7/19 のまま |
| 後始末 | `opencode serve` は **PID 指定で kill**（`pkill -f opencode` は使っていない）。ポート 4796 の LISTEN が無いことを確認済み |

### 19.7 変更ファイル

- `src/lib/terminal-display-normalize.ts`（新規）— パネル対応の圧縮規則。`compactBlankRuns()` が共有エンジン
- `src/config/terminal-display-compaction.ts`（新規）— どのツールをどう圧縮するかの**唯一の宣言**
- `src/components/worktree/TerminalDisplay.tsx` — `preservePaintedPanelRows` prop
- `src/components/worktree/TerminalSplitPaneContent.tsx` / `MobileTerminalTab.tsx` — 手書きのツール列挙をやめ、config を読む
- `tests/fixtures/opencode-live-2049/` — 1.18.22 の実キャプチャ 3 本と README

### 19.8 この節が変えたもの

- 「opencode には空行圧縮が無い」→ **ある。claude / codex 限定だっただけ。**
- 「opencode を足せば済む」→ **足すだけだと picker / palette の帯が消える。**
- **PC とモバイルで圧縮の宣言が 2 箇所に割れていた**（`TerminalSplitPaneContent.tsx:260` /
  `MobileTerminalTab.tsx:53`）。同じセッションが画面によって別の見え方をしうる形だったので、
  config 1 箇所に集約し、ソースを読むテストで再発を止めた。
## 20. Issue 2048: instance ごとの agent / model / variant（opencode 1.18.22 / 2026-08-26）

Issue #2048 は「instance 設定に `model` / `agent` / `variant` を追加し、launch plan に反映し、
ヘッダに `agent · model · variant` を出す」。**Issue 本文の想定のうち 1 つは実測で崩れ、
1 つは実測で裏付けられ、1 つは Issue が想定していなかった既存欠陥として出てきた。**

| Issue 本文の想定 | 実測 |
|---|---|
| 候補は `GET /config/providers` と `GET /agent` から取れる | **取れる**（§20.1）。ただし `models` も `variants` も **配列ではなくオブジェクト** |
| variant は launch plan に反映できる | **できない**（§20.3）。TUI に `--variant` が無く、渡すと usage を出して終了する |
| variant が `message.updated` の payload に載るか（要実測） | **載る**（§20.4）。`info.variant` / `Session.model.variant` |
| （言及なし） | `prompt_async` に `agent` を載せないと、`--agent plan` で起動したペインでもそのターンは `build` で走る（§20.5） |

### 20.0 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4848/path
```

返り値（全項目が scratchpad 配下）:

```json
{"home":"…/scratchpad/oc2048/home",
 "state":"…/scratchpad/oc2048/home/.local/state/opencode",
 "config":"…/scratchpad/oc2048/home/.config/opencode",
 "worktree":"…/scratchpad/oc2048/work",
 "directory":"…/scratchpad/oc2048/work"}
```

`auth.json` は `umask 077` で複製し、検証後に削除した（削除確認済み）。モデルは `opencode.jsonc` の
`"model": "github-copilot/claude-sonnet-4.6"` で固定し、**TUI のモデルピッカーは一度も開いていない**。
ポートは 4848 / 4849 / 4850 / 4851 のみ、`--hostname 127.0.0.1`。3000 は使っていない。
tmux は専用 socket `cmate-2048-oc` のみ（既定サーバには 1 コマンドも撃っていない。後始末は
`kill-session -t '=<name>:'` で、`kill-server` は使っていない）。

### 20.1 候補の取り方 — `models` も `variants` も **オブジェクト**

`GET /config/providers` は `{ default, providers }`。`providers` は配列だが、その中の `models` は
**model id をキーにしたオブジェクト**である（#2042 が `limit.context` を読むときに踏んだのと同じ形）。
さらに各 model の `variants` も **variant 名をキーにしたオブジェクト**で、値が `effort` /
`reasoningEffort` を持つ。

```jsonc
// providers[] の 1 要素（github-copilot / claude-sonnet-4.6 を抜粋）
{ "id": "github-copilot", "name": "GitHub Copilot",
  "models": {
    "claude-sonnet-4.6": {
      "id": "claude-sonnet-4.6", "name": "Claude Sonnet 4.6",
      "limit": { "context": 1000000, "input": 936000, "output": 64000 },
      "variants": {
        "low":    { "thinking": { "type": "adaptive" }, "effort": "low" },
        "medium": { "thinking": { "type": "adaptive" }, "effort": "medium" },
        "high":   { "thinking": { "type": "adaptive" }, "effort": "high" },
        "max":    { "thinking": { "type": "adaptive" }, "effort": "max" } } } } }
```

- 計測機の 4 provider 20 model のうち **`variants: {}`（バリアント無し）が実在する**（`kimi-k2.7-code`）。
  「キーが無い」ではなく「空オブジェクト」なので、`variants` の有無で判定してはいけない。
- 観測された variant 名は `low` / `medium` / `high` / `max` / `minimal` / `none` / `xhigh` の 7 種。
  **列挙ではなく model ごとの `variants` のキー**として扱うこと（model により集合が違う）。
- model id には `/` と `:` が入る（`lmstudio/qwen/qwen3-coder-30b`、`ollama-cloud/deepseek-v4-flash:0731`）。
  `provider/model` を分解するときは **最初の `/`** で切る。

`GET /agent` は**配列**（`/config/providers` と形が違う）。

```jsonc
[ {"name":"build","mode":"primary","description":"The default agent. …"},
  {"name":"compaction","mode":"primary","hidden":true},
  {"name":"explore","mode":"subagent","description":"…"},
  {"name":"general","mode":"subagent","description":"…"},
  {"name":"plan","mode":"primary","description":"Plan mode. Disallows all edit tools."},
  {"name":"summary","mode":"primary","hidden":true},
  {"name":"title","mode":"primary","hidden":true} ]
```

素の 1.18.22 で 7 件。`hidden: true` が 3 件（可視な agent には `hidden` キー自体が無い）、
`mode: "subagent"` が 2 件。**起動時に指定できるのは `primary` かつ非 hidden の 2 件＝`build` / `plan`**
で、これは Issue #2048 の受入条件が名指ししている組と一致する。

### 20.2 TUI が受け付ける起動フラグ

`opencode --help`（1.18.22、TUI = `opencode [project]`）の Options に在るもの:

```text
  -m, --model      model to use in the format of provider/model      [string]
      --agent      agent to use                                      [string]
  -c, --continue / -s, --session / --fork / --prompt / --auto / --mini …
```

`--agent` / `-m` はどちらも効く。実測（`--agent plan --model github-copilot/claude-haiku-4.5`）で
composer のフッタが `Plan · Claude Haiku 4.5 (latest) GitHub Copilot` になり、
`message.updated.info` も `agent: "plan"` / `modelID: "claude-haiku-4.5"` になった。

### 20.3 **`--variant` は TUI に無い。渡すと起動しない**（Issue 本文と食い違う）

`--variant` は **`opencode run` のフラグ**であって TUI のフラグではない。

```text
$ opencode run --help
      --variant      model variant (provider-specific reasoning effort, e.g., high, max, minimal)
```

TUI に渡すと yargs が **usage バナーを出して終了**する。実測 2 回（tmux 内 / 直接実行の両方）で、
どちらもプロセスが即終了し `GET /global/health` は接続拒否だった＝**ペインにエージェントが 1 つも立たない**。

```bash
# tmux 内。18 秒後に session ごと消えている
tmux -L cmate-2048-oc new-session -d -s oc-tui … "opencode --port 4849 --hostname 127.0.0.1 \
  --agent plan --model github-copilot/claude-haiku-4.5 --variant high"
# => no server running on …/cmate-2048-oc、curl 4849 は Failed to connect
```

`opencode.jsonc` の `"agent": { "plan": { "variant": "high" } }` も試したが、**ターンに届かなかった**
（`--agent plan` で起動して 1 ターン回し、`message.updated.info.variant` は**キーごと不在**）。
`--model github-copilot/claude-sonnet-4.6/high` という綴りも試したが、5 分以上応答が返らず
**サーバ側ログに 1 行も届かなかった**（サポートされない綴り）。

→ **結論: variant は起動引数では渡せない。** CommandMate の launch plan は `--agent` と `--model` だけを付ける。

### 20.4 variant は `message.updated` に**載る**（Issue の要実測項目への回答）

`AssistantMessage` は `variant` を宣言している（`GET /doc`。`required` には無い＝任意）。
実測でも載った。

| 経路 | `message.updated.info.variant` |
|---|---|
| `opencode run --agent plan --variant high --model …` | `"high"` |
| `POST /session/:id/prompt_async` に `{"variant":"high"}` | `"high"` |
| 何も指定しない（モデル既定） | **キーごと不在** |
| `opencode.jsonc` の `agent.plan.variant` | **キーごと不在**（§20.3） |

`session.updated` 側は `Session.model` が `ModelRef`（`{id, providerID, variant?}`）なので
**`info.model.variant`** に入る。つまり読み手は 2 つの綴りを持つ必要がある。

```jsonc
// session.updated（variant あり）
"info": { "agent": "build", "model": { "id":"claude-sonnet-4.6", "providerID":"github-copilot", "variant":"high" } }
// message.updated（variant あり）— こちらは info 直下のフラットなキー
"info": { "role":"assistant", "agent":"build", "mode":"build", "variant":"high",
          "modelID":"claude-sonnet-4.6", "providerID":"github-copilot" }
```

**ペインには出ない。** variant を効かせたターンでも step 行は `▣  Build · Claude Sonnet 4.6 · 2.3s`、
composer フッタは `Plan · Claude Haiku 4.5 (latest) GitHub Copilot` のままで、
どちらにも variant は現れなかった。`src/lib/detection/model-info-extractor.ts` の
「opencode は reasoning effort をペインのどこにも出さない」は 1.18.22 でも成立している。
**画面に無いだけで、構造化イベントには在る** — これが #2048 が effort 表示を埋められる理由。

未検証（推測で埋めていない）: variant を指定したときに実際に推論量が変わるか（トークン数の比較はしていない）。
opencode は**未知の variant も検証せず受け付ける**（`"totally-not-a-variant"` を送って `204`、
`message.updated.info.variant` にそのまま反射。`session.error` も出ない）ので、
`variants` に無い名前を送っても壊れないが、効いている保証も無い。

### 20.5 `prompt_async` に `agent` を載せないと `build` に戻る（既存欠陥）

`POST /session/:id/prompt_async` の body は `{ messageID, model:{providerID,modelID}, agent, variant, parts, … }`。
**`agent` を省いたリクエストは、`--agent plan` で起動したペインでも `build` でターンを回す。**

```text
# ペインは --agent plan で起動。TUI からタイプした 1 ターン目 => agent: "plan"
# 2 ターン目を prompt_async（agent 無し・variant:"high"）で投げる
=> message.updated.info: {"agent":"build","mode":"build","variant":"high", …}
=> ペインの step 行も  ▣  Build · Claude Sonnet 4.6 · 2.3s
```

TUI から打った場合に `plan` が保たれるのは、TUI が自分の agent を body に載せているから。
CommandMate は #2035 以降 `agent` を載せずに `prompt_async` を使っているので、
**`--agent plan` のペインは CommandMate が送信するたび `build` に戻っていた。**
#2048 で instance 設定の `agent` を body に載せることで解消する（未設定の instance は
キーごと省くので、従来の body とバイト一致のまま）。

### 20.6 受入条件の実測（`plan` / model / `high`）

Issue の受入条件は `plan` / `openai/gpt-5` / `high`。計測機に openai provider が無いため
**model は `github-copilot/claude-haiku-4.5` で代用**した（provider/model の解決経路は同一）。
起動行は CommandMate が組み立てる文字列そのものを使った。

```bash
'opencode' --port 4851 --hostname 127.0.0.1 --agent 'plan' --model 'github-copilot/claude-haiku-4.5'
```

| 観測点 | 値 |
|---|---|
| composer フッタ | `Plan · Claude Haiku 4.5 (latest) GitHub Copilot` |
| step 行（`prompt_async` のターン） | `▣  Plan · Claude Haiku 4.5 (latest) · 3.0s` |
| `message.updated.info` | `{"agent":"plan","mode":"plan","modelID":"claude-haiku-4.5","providerID":"github-copilot","variant":"high"}` |

**agent と model はフッタと `message.updated` が一致する。variant はフッタに存在しない**
（§20.4 のとおり、opencode 側の非対称であって CommandMate の読み落としではない）。

### 20.7 非汚染の証拠

| 項目 | 値 |
|---|---|
| 版 | **1.18.22**（`GET /global/health`） |
| 隔離 HOME | `GET /path` の 5 項目すべてが scratchpad 配下であることを確認済み |
| ポート | 4848 / 4849 / 4850 / 4851。3000 は使っていない。`--hostname 127.0.0.1` |
| tmux | 専用 socket `cmate-2048-oc` のみ。`kill-server` / `set-option -g` / `bind-key` は使っていない |
| モデルピッカー | **一度も開いていない**（`opencode.jsonc` で固定。`tab` / `ctrl+t` / `/models` も押していない） |
| `auth.json` | mode 600 で複製し、**検証後に削除**（削除確認済み） |
| ユーザー HOME 非汚染 | 検証終了時点で `~/.local/share/opencode/opencode.db` の mtime は検証開始より前の **8/25 14:16** のまま |
| 後始末 | serve / SSE tap を **PID 指定で kill**（`pkill -f opencode` は使っていない）。tmux は `kill-session -t '=<name>:'` |

### 20.8 この節が変えたもの

- `src/types/opencode-instance-settings.ts`（新規）— 3 設定の語彙とパターン検証（シェル行に載るため）
- `src/lib/hooks/sources/opencode/client.ts` — `GET /config/providers` の読み手を 1 本化し
  （#2042 の `limit.context` もそこから派生）、`GET /agent` の読み手と `prompt_async` の
  `agent` / `model` / `variant` を追加
- `src/lib/hooks/sources/opencode/launch-settings.ts`（新規）— 起動行が同期で読めるミラー
- `src/lib/hooks/sources/opencode/source.ts` — `prepareOpencodeLaunch` に `--agent` / `--model`
  （**`--variant` は付けない**）
- `src/lib/hooks/sources/opencode/mappers.ts` / `subscription.ts` — `frameVariant` と effort ラッチへの記録
- `src/lib/session/agent-event-state.ts` / `src/lib/detection/model-info-extractor.ts` —
  「エージェント自身が申告した effort」を第 3 の情報源として `mergeModelInfo` に追加
- `src/lib/db/migrations/v59-opencode-instance-settings.ts` / `src/lib/db/agent-instances-db.ts` — 保存先
- `src/app/api/worktrees/[id]/instances/opencode/route.ts`（新規）— 設定の読み書きと候補配布
- `src/components/worktree/AgentSettingsPane.tsx` — `OpencodeInstanceSettings`

---

## 21. Issue 2047: ペイン幅をツール別設定にする（opencode 1.18.22 / 2026-08-26）

Issue #2047 は「幅 80 のベタ書きを `OPENCODE_PANE_WIDTH` / `CM_OPENCODE_PANE_WIDTH` に寄せ、
120 桁 / 200 桁の実 fixture で scraper を再検証し、**全部緑なら既定を 200 に上げる**」。

**上げなかった。** 200 桁は緑ではない。理由は 1 行で言える:

> **opencode 1.18.22 は 121 桁以上で右サイドバーを描き、120 桁以下では描かない。
> サイドバーは capture の行を transcript と共有するので、121 桁以上では
> 1 行が `<transcript>   …   <sidebar>` になる。**

`launchSession()` に昔から書かれていた `// Resize tmux window to 80 columns (hide sidebar for
clean capture-pane output)` というコメントは、**正しかった**。#2047 はそれを数値で確定させ、
定数と env var と回帰テストに変えた作業である。

| Issue 本文の想定 | 実測 |
|---|---|
| 幅 80 は `opencode.ts` に 2 箇所ベタ書き、高さだけ定数 | **そのとおり**（`:253` の reconcile と `:294` の resize） |
| `CM_OPENCODE_PANE_WIDTH` は repo に 0 件 | **そのとおり**。#2047 が新設した |
| `enter confirm` は 80 桁で `enter con` に切れる | **そのとおり**（§21.3）。120 / 200 では切れない。アンカーは 3 ラベル側なので幅に依存しない |
| 再検証が全部緑なら既定を 200 へ | **緑にならなかった**（§21.4）。既定は 80 のまま、**計測された安全上限は 120** |
| 既定を 200 にするならカナリアも動かす（(a)/(b) の選択） | **どちらも不要になった**。既定が動かないのでカナリアの 80×200 は本番と一致したまま（§21.6） |

### 21.0 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4789/path
```

返り値（全項目が scratchpad 配下）:

```json
{"home":"…/scratchpad/oc2047/home",
 "state":"…/scratchpad/oc2047/home/.local/state/opencode",
 "config":"…/scratchpad/oc2047/home/.config/opencode",
 "worktree":"…/scratchpad/oc2047/work",
 "directory":"…/scratchpad/oc2047/work"}
```

`auth.json` は `umask 077` で複製し、検証後に削除した（削除確認済み）。モデルは `opencode.jsonc` の
`"model": "github-copilot/claude-sonnet-4.6"` で固定し、**TUI のモデルピッカーは一度も開いていない**。
ポートは 4788 / 4789 のみ、`--hostname 127.0.0.1`。3000 は使っていない。
tmux は専用 socket `cmate-2047-oc` のみで、後始末は `kill-session -t '=ocw:'`。**`kill-server` は
使っていない**（専用 socket なので最後の session 終了でサーバも自然終了した）。
検証後にユーザーの `~/.local/share/opencode/opencode.db` の mtime が 8/25 のまま（＝書かれていない）
ことと、既定 tmux サーバの 32 session が全部生きていることを確認している。

### 21.1 サイドバー境界 — **121 桁**（1 桁刻みで両方向に再現）

同一セッションの window を `resize-window -x <W> -y 200` で振り、
`capture-pane` にサイドバー見出し（`Context` / `N tokens` / `LSP`）が現れるかを見た。

```
 80x200 -> no-sidebar     121x200 -> sidebar
100x200 -> no-sidebar     122x200 -> sidebar
110x200 -> no-sidebar     ...
119x200 -> no-sidebar     130x200 -> sidebar
120x200 -> no-sidebar     200x200 -> sidebar
```

120 → 121 → 120 → 121 と往復させても同じ。**120 が「サイドバーが出ない最大幅」**である。

サイドバーは右端 ~40 桁に、セッションタイトル・`Context` / トークン数 / 使用率 / 課金額・`LSP` 状態を
描く。**別リージョンではない**: capture の同じ行の右側に載る。

```
# 200 桁での 1 フレーム（ANSI 除去、右端まで）
  ┃                                    ... Ask anything... is the placeholder   ← セッションタイトル
  ┃  Output exactly this one line ...      Context
                                           9,174 tokens
     1                                     1% used
     2                                     $0.04 spent
```

### 21.2 fixture — 同一セッションを 3 幅で採った

`tests/fixtures/opencode-live-2047/{w80,w120,w200}/` に 13 フレーム × 3 幅。
**会話を撃ち直したのではなく、同じ状態のまま window を resize して撮った**ので、
3 ファイルの差は幅の差だけである。`w80/` は対照であって置き換えではない
（#1883 / #1893 / #1894 / #1896 が持つ 80 桁 fixture は 1 バイトも触っていない）。

frames: `boot-idle` / `composer-residual` / `turn-running` / `esc-again-window` /
`double-esc-interrupted` / `turn-complete` / `permission-bash` / `permission-edit` /
`numbered-answer` / `phrase-in-response` / `sidebar-title-phrase` /
`turn-aborted-after-complete` / `command-palette`

### 21.3 120 桁 — **13 フレームすべてで verdict が 80 桁と一致**

`detectSessionStatus` / `detectPrompt` / `resolvePromptWaiting` /
`OPENCODE_IDLE_COMPOSER_PATTERN` / `OPENCODE_PERMISSION_PATTERN` /
`OPENCODE_PROCESSING_INDICATOR` / `isOpenCodeComplete` を 1 オブジェクトにまとめて
`toEqual` で比較（期待値を書かない比較なので、想定していない依存も落ちる）。**全 13 フレーム一致。**

- `enter confirm`: 80 桁では `enter con` に切れ、120 / 200 では切れない。
  `OPENCODE_PERMISSION_PATTERN` が **アンカーにしていない**のはこの truncation のため、という
  docblock の判断がここで裏付けられた。アンカーである `Allow once  Allow always  Reject` は
  3 幅ともバイト一致。
- 保存される reply（`sliceOpenCodeTurn` → `cleanOpenCodeResponse`）は**改行位置だけ**が違う。
  opencode が本文をペインに合わせて hard wrap するためで、空白を全部除けば一致する。
  ただし 200 行の窓に入る本文量は幅で変わるので、**同一ではなく前方一致**が正しい比較。
- `findOpenCodeChromeStart` は **80 桁で 190、120 / 200 桁で 192**。cwd フッタが 80 桁では 3 行、
  120 桁以上では 1 行になるぶんだけ chrome が 2 行短い。#1911 がこのアンカーを
  「下端からの固定オフセット」ではなく構造探索にしたのは、まさにこの動きのためである。

### 21.4 200 桁 — 3 つの reader が壊れる

| # | 壊れるもの | 80 / 120 | 200 | ユーザー入力に依存するか |
|---|---|---|---|---|
| 1 | `sliceOpenCodeTurn` + `cleanOpenCodeResponse` | reply は空文字列 | **サイドバーが reply として保存される**（`8,501 tokens` / `$0.00 spent` / `LSP` / `LSPs are disabled`） | **しない**（構造的） |
| 2 | `detectSessionStatus`（branch D） | `ready` / `opencode_response_complete` | **`running` / `unknown_frame`** | しない |
| 3 | `OPENCODE_IDLE_COMPOSER_PATTERN` | false | **true（誤検出）** | する（セッションタイトル依存） |

1. **サイドバーが reply になる。** #1911 の turn region は「行の範囲」なので、
   その行の右端に載っているサイドバーごと保存する。`phrase-in-response` は 80 / 120 では
   空文字列に落ちる（本文が echo と marker の間に無い）ターンだが、200 では
   サイドバーだけが本文として保存された。
   なお `numbered-answer` は 200 でも clean に取れる — turn region の開始行(26)が
   サイドバー最終行より下だったため。**つまり被害はターンがペインのどこに来たかで決まる**。
   設定ごとに一定ではなくターンごとに不定という意味で、これは「常に壊れる」より悪い。
2. **中断ターンの verdict が反転する。** branch D は content 行を末尾から一定本数だけ見る。
   サイドバーが content 行を増やすので、80 / 120 では窓の中にあった**前のターンの
   `▣ … · 36.1s`** が 200 では窓から外れる。同じセッションの同じ瞬間に別の答えが出る。
3. **セッションタイトルが idle composer に化ける。** `OPENCODE_IDLE_COMPOSER_PATTERN` は
   `^\s*┃\s*Ask anything\.\.\.` — 「gutter が先、次が phrase、間には空白しかない」。
   これが「入力ボックスの行だ」と言えるのは **1 行が 1 ペインに属している間だけ**である。
   121 桁以上ではサイドバーが transcript の gutter と同じ行にセッションタイトルを描くので、
   タイトルに phrase が入っていれば #1883 が立てたアンカーをそのまま通り抜ける。

副次的なコスト: 200 行 1 フレームは 80 桁で ~2.5 KB、200 桁で ~40 KB。
サイドバーが触る行の全幅に背景色を塗るため。`capturePane` は tmux を `maxBuffer: 10 MB` で
回している（`TMUX_HISTORY_LIMIT` の docblock 参照）。

### 21.5 結論 — 既定は 80、上限は 120、env で開ける

- `OPENCODE_PANE_WIDTH = 80`（既定、`src/config/tmux-pane-config.ts`）
- `OPENCODE_SIDEBAR_MIN_WIDTH = 121`（計測値。ここ以上でサイドバーが出る）
- `CM_OPENCODE_PANE_WIDTH` で上書き可。受理範囲 `[40, 400]`、10 進整数のみ。
  範囲外・非整数は**既定に落とす**（`Number('0x50')` を 80 桁と読むような偶然を作らない）。
  121 以上を指定した場合は `opencode-pane-width-sidebar-visible` を warn するが**拒否はしない**
  （ブラウザで読むだけの運用者には選ばせてよい。黙って通さないだけ）。
- **`opencode.ts` の 2 箇所は両方ともこの 1 本から読む。** 片方だけ直すと
  「新規作成は 200 / 再接続は 80」になり、その差はサーバ再起動のあとにしか出ない。
  `tests/unit/cli-tools/opencode-pane-width-2047.test.ts` が両経路を実 `OpenCodeTool` で撃つ。

### 21.6 カナリア（#2050）との結合 — 既定が動かないので (a)/(b) は発生しない

Issue 本文は「既定を 200 にするならカナリアも 200 へ移す (a) か、80 に留める理由を書く (b)」と
言っていた。**既定を上げなかったので、カナリアの 80×200 は本番と一致したままである。**
`tests/fixtures/canary/opencode-*.raw.txt` の 5 本は採り直していない（採り直す理由が無い）。

ただし**将来ずれる形**は潰した:

- `scripts/canary/tool-profiles.ts` の `paneWidth` はリテラル `80` から `OPENCODE_PANE_WIDTH` に変えた。
  **`resolveOpencodePaneWidth()` ではない** — 運用者の `CM_OPENCODE_PANE_WIDTH` は自分のペインの話であって、
  それがカナリアに届くと「fixture を採った幅と違う幅で撃つ」ことになる。
- `tests/unit/canary-opencode-geometry-2047.test.ts` が、既定が動いた瞬間に赤くする。
  赤はバグではなくチェックリスト（fixture 5 本の採り直しと
  `OPENCODE_VERIFIED_AGAINST.paneGeometry` の押し直しが要る、という通知）。
- `OPENCODE_VERIFIED_AGAINST.paneGeometry` は `'80x200'` のまま。同テストが
  `${OPENCODE_PANE_WIDTH}x${OPENCODE_PANE_HEIGHT}` と一致することを固定する。

### 21.7 モバイルの折返し（表示のみ・TUI 幅とは独立）

opencode のペインは固定桁で組まれているので、スマホ幅で再折返しすると入力ボックス・
権限ダイアログのボタン列・フッタが全部 2 行に割れる。#2049 が作った端末ビューのポリシー宣言
（`src/config/terminal-display-compaction.ts`）に 3 つ目のフィールドを足した:

- `mobileWrapMode: 'viewport' | 'frame'` — `frame` はフレーム自身の桁数を `ch` で与えて横スクロールさせる。
  **opencode だけ** `frame`。claude / codex / copilot は `viewport`（＝#2047 以前と同じ）。
- 桁数は `measureTerminalFrameColumns(output)` が**フレームから実測**する。
  `OPENCODE_PANE_WIDTH` を読まないので、`CM_OPENCODE_PANE_WIDTH` を変えても配線ゼロで追従し、
  幅を変える前に採ったフレームは採ったときの幅で描かれる。SGR を除いてから測り、
  行末は trim する（opencode は全行を背景色つき空白でペイン幅まで埋めるので、
  trim しないと**どのフレームもぴったりペイン幅**になって計測にならない）。
- PC（`TerminalSplitPaneContent`）は読まない。PC のペインはどのみち幅が足りている。

### 21.8 未計測・積み残し

- **モデルピッカーは開いていない**ので、`model-picker` フレームの幅依存は測っていない
  （ピッカーは既定モデルを書き換えるため、§4 の規則どおり触っていない）。
  `command-palette` は `ctrl+p` で開けるので 3 幅とも採ってある。
- `esc-again-after-marker`（#1894 の 2 つ目の window フレーム）は 3 幅では採っていない。
  前ターンの marker と新ターンの echo と `⠦ Thinking:` が同時に窓に入る瞬間を
  resize しながら 3 回捕まえる必要があり、5 秒の window では安定して撮れなかった。
- 121〜199 桁のあいだで **サイドバーの列数が幅とともに変わるか**は測っていない（121 と 200 のみ）。
  既定を上げない以上、上げるときに測ればよい。

### 21.9 この節が変えたもの

- `src/config/tmux-pane-config.ts` — `OPENCODE_PANE_WIDTH` / `OPENCODE_SIDEBAR_MIN_WIDTH` /
  `OPENCODE_PANE_WIDTH_ENV` / `OPENCODE_PANE_WIDTH_MIN` / `OPENCODE_PANE_WIDTH_MAX` /
  `resolveOpencodePaneWidth()`
- `src/lib/cli-tools/opencode.ts` — ベタ書き 2 箇所を `resolveOpencodePaneWidthChecked()` へ
  （警告はここ。config module は import ゼロを保つ）
- `src/config/terminal-display-compaction.ts` — `mobileWrapMode` と `measureTerminalFrameColumns()`
- `src/components/worktree/TerminalDisplay.tsx` — `wrapMode` prop
- `src/components/worktree/MobileTerminalTab.tsx` — ポリシーから `mobileWrapMode` を渡す
- `scripts/canary/tool-profiles.ts` — `paneWidth` を定数へ
- `tests/fixtures/opencode-live-2047/**` — 13 フレーム × 3 幅 ＋ 採取手順の README

## 22. Issue 2046: ターミナルのクイックキーをツール別宣言にする（opencode 1.18.22 / 2026-08-26）

Issue #2046 は「キー allowlist をグローバル定数から `ICLITool` のツール別宣言へ移し、
opencode 用クイックキー列（PC / モバイル）を足す」。宣言への移行は入れた。
**キー列からは 2 つのキーを外した。`ctrl+x b`（サイドバー）と `F2`（model 巡回）である。**
外した理由はどちらも実測で、下の §22.3 と §22.7 に書く。

| Issue 本文の想定 | 実測 |
|---|---|
| `ICLITool.navigationKeys()` は新規追加 | **そのとおり**（`describeComposer()` / `captureSpec()` と同じ形にした） |
| leader は `ctrl+x` | **そのとおり**（1.18.22 のバイナリに `leader: "ctrl+x"` / `leader_timeout: 2000`） |
| footer の `tab agents` / `ctrl+p commands` | **そのとおり**。Tab は Build ⇄ Plan を実測（§22.2） |
| leader ＋ b / l / m / a / n / u / r / c / g / t | **キーバインドは 10 個とも実在**。ただし **b は採らない**（§22.3）。u / r / c / g は**セッション成立後だけ**有効（§22.4） |
| `F2` で model recent 巡回 | **バインドは実在**。**計測できなかったので採らない**（§22.7） |
| `ctrl+t` で variant | **そのとおり**。ステータス行が `… GitHub Copilot · low` になるところまで実測 |
| PgUp / PgDn / Home / End | **そのとおり**。しかも**既存語彙のまま**（#1017 が入れた 4 つ）で足りる。transport 変更ゼロ |
| `/tui/open-models` などを一次経路に | **1 つも採らなかった**（§22.6） |

### 22.0 隔離の確認（先に撃つ）

```bash
curl -sS http://127.0.0.1:4790/path
```

返り値（全 5 項目が scratchpad 配下）:

```json
{"home":"…/scratchpad/oc2046/home",
 "state":"…/scratchpad/oc2046/home/.local/state/opencode",
 "config":"…/scratchpad/oc2046/home/.config/opencode",
 "worktree":"…/scratchpad/oc2046/work",
 "directory":"…/scratchpad/oc2046/work"}
```

`GET /global/health` は `{"healthy":true,"version":"1.18.22"}`。
`auth.json` は `umask 077` で複製し検証後に削除（削除確認済み）。モデルは隔離 `opencode.jsonc` の
`"model": "github-copilot/claude-sonnet-4.6"` で固定。ポートは 4790 のみ、`--hostname 127.0.0.1`。
3000 は使っていない。tmux は専用 socket `cmate-2046-oc` のみで、後始末は
`kill-session -t '=ocw:'` と `kill-session -t '=bytes:'`。**`kill-server` は使っていない**
（専用 socket なので最後の session 終了でサーバも自然終了した）。
検証後、ユーザーの `~/.local/share/opencode/opencode.db` の mtime は開始前と同じ 8/25 14:16:54、
`~/.config/opencode/opencode.jsonc` は 7/19 のまま。既定 tmux サーバのセッション数は
検証前後とも 33 で不変。

### 22.1 キーバインドの一次ソースはバイナリの既定テーブル

opencode 1.18.22 の実行ファイルには既定キーバインド表がそのまま入っている。
画面から読み取るより網羅的で、版が変われば差分が出る。

```bash
strings -a ~/.opencode/bin/opencode > oc.strings
# leader の既定
python3 - <<'PY'
import re; d=open('oc.strings','rb').read()
print(re.search(rb'M9="ctrl\+x",H=\(_,J\)=>\(\{default:_,description:J\}\),x_=\{leader:H\(M9', d) is not None)
PY
# 個々のバインド（H("<default>","<description>") 形式）
```

これで確定したもの（本 Issue に関係するものだけ抜粋）:

| 内部名 | 既定 | 説明 |
|---|---|---|
| `leader` | **`ctrl+x`** | leader key |
| `leader_timeout` | **2000**（ms） | leader を押してから次のキーまでの猶予 |
| `agent_cycle` / `agent_cycle_reverse` | `tab` / `shift+tab` | エージェント切替 |
| `command_list` | `ctrl+p` | コマンドパレット |
| `variant_cycle` | `ctrl+t` | model variant 巡回 |
| `agent_list` / `session_list` / `session_new` / `model_list` / `theme_list` | `<leader>a` / `l` / `n` / `m` / `t` | ダイアログ |
| `session_timeline` / `messages_undo` / `messages_redo` / `session_compact` | `<leader>g` / `u` / `r` / `c` | セッション操作 |
| `sidebar_toggle` | `<leader>b` | サイドバー |
| `model_cycle_recent` / `model_cycle_recent_reverse` | `f2` / `shift+f2` | 直近モデル巡回 |
| `messages_page_up` / `messages_page_down` | `pageup` / `pagedown` | 1 ページスクロール |
| `messages_first` / `messages_last` | `ctrl+g,home` / `ctrl+alt+g,end` | 先頭 / 末尾 |
| `app_exit` | `ctrl+c,ctrl+d,<leader>q` | 終了 |

**PgUp / PgDn / Home / End が opencode でもそのまま効く**ことがここで確定した。
この 4 つは #1017 が codex pager 用に `NAVIGATION_KEY_VALUES` へ入れてあるので、
opencode に開くのに transport 側の変更は要らない。

### 22.2 Tab — Build ⇄ Plan（受入条件）

80x200 の実ペインで `tmux send-keys Tab` を 2 回。composer のステータス行だけが動く。

```
before : ┃  Build · Claude Sonnet 4.6 GitHub Copilot
after 1: ┃  Plan  · Claude Sonnet 4.6 GitHub Copilot
after 2: ┃  Build · Claude Sonnet 4.6 GitHub Copilot
```

footer の `tab agents` は静的なヒント行で、切り替わるのは composer のステータス行のほう。
fixture は `tests/fixtures/opencode-live-2046/w80/agent-{build,plan}.txt`。
**2 回押した後のフレームは押す前とバイト一致**（`agent-build.txt` と `sidebar-off.txt` が同一ファイル）。
ラベルが戻っただけでなく、検出が読む他の何も動いていない。

### 22.3 `ctrl+x b`（サイドバー）— **採らない**。80 桁で検出が壊れる

これが本 Issue の中心的な実測である。

#### 22.3.1 明示トグルは #2047 の 121 桁ゲートを**無視する**

#2047 は「opencode は 121 桁以上でサイドバーを描き、120 桁以下では描かない」を 1 桁刻みで確定させた。
そこから「既定 80 桁では `ctrl+x b` を押しても見えるものが無い」という予想が立つ。**違った。**

| 幅 | セッション | `ctrl+x b` の結果 |
|---|---|---|
| 200 | 無し（ホーム画面） | **`b` が composer に入る**（バインドが不活性） |
| 200 | 有り | サイドバー ON ⇄ OFF（3 マーカー行 ⇄ 0 行） |
| **80** | **有り** | **サイドバー ON**（`Context` / `8,498 tokens` / `1% used` / `$0.03 spent` / `LSP` / `LSPs are disabled` が出る） |

つまり**自動表示の閾値は 121 桁だが、明示トグルには閾値が無い**。
200 桁で ON にしてから 80 桁へ resize しても ON のまま残った。

80 桁で ON にしたフレーム（`w80/sidebar-on.txt`、ANSI 除去）:

```
  ┃                                     OK2046
  ┃  Reply with exactly this one line          ← 本文がここで切れる
  ┃                                     Context
                                        8,498 tokens
     OK2046                             1% used
                                        $0.03 spent
     ▣  Build · Claude Sonnet 4.6 · 2.          ← ターンフッタも切れる
                                        LSP
                                        LSPs are disabled
```

サイドバーが 80 桁のうち ~37 桁を取るので、transcript 側は ~37 桁に潰れる。

#### 22.3.2 その状態で検出が壊れる（#2047 が 200 桁で見たものが 80 桁で起きる）

`tests/unit/detection-opencode-quick-key-frames-2046.test.ts` が同じセッションの
2 フレームを実 detector に通した結果:

| | `sidebar-off`（対照） | `sidebar-on` |
|---|---|---|
| `detectSessionStatus` | `ready` / `opencode_response_complete` | **`running` / `unknown_frame`** |
| `isOpenCodeComplete` | `true` | **`false`** |
| 保存される reply | `OK2046` | **`8,498 tokens OK2046 1% used $0.03 spent LSP LSPs are disabled`** |

**終わったターンが永久に `running` に見える。** `commandmate wait` は返らない。
そして **Escape ×2 でも元に戻らない**（実測）。復帰手段は同じ `ctrl+x b` をもう一度押すことだけで、
それは「壊れていると気づいた人」にしか押せない。

#### 22.3.3 セッション成立前は composer にゴミが入る

ホーム画面（そのペインの初回ターンが終わるまで）では `sidebar_toggle` が不活性で、
leader が次のキーを**食わない**。`b` が composer に literal で入る。
`w80/home-leader-b-fallthrough.txt`:

| | `home-idle` | `home-leader-b-fallthrough` |
|---|---|---|
| `detectSessionStatus` | `ready` / `input_prompt` | **`running` / `unknown_frame`** |
| `OPENCODE_IDLE_COMPOSER_PATTERN` | `true` | **`false`** |

#### 22.3.4 判断

**どちらの枝も害がある。効く枝では検出が壊れ、効かない枝では composer が汚れる。
「安全な幅」は存在しない**（見えるにはサイドバーが要り、安全であるにはサイドバーが無いことが要る）。
`resolveOpencodePaneWidth() >= 121` のときだけ出す、という案も成り立たない —— #2047 が
測ったとおり 121 以上こそ検出が壊れる領域だからである。

よって **`b` は `OPENCODE_LEADER_CHORD_VALUES` に入れない**。ボタンも出さないし、
route も `{cliToolId:"opencode", keys:["C-x","b"]}` に **400** を返す
（`tests/unit/api/special-keys-per-tool-vocabulary-2046.test.ts` が固定）。

**正直に書いておく限界**: `ctrl+p` のコマンドパレットには `sidebar_toggle` も登録されているので、
パレットを開いて検索すれば到達はできる。本 Issue が消したのは「ワンクリックで置く」ことであって、
opencode 自身の機能ではない。パレット経由でこの状態に入った pane をどう検出するかは**未対応**（§22.8）。

### 22.4 セッション成立前に落ちるのは b だけではない

ホーム画面で leader ＋ 各キーを撃ち、composer に literal が入るかを見た。

| キー | ホーム画面（セッション前） | セッション有り |
|---|---|---|
| `a` / `l` / `n` / `t` / `m` | **ダイアログが開く**（食われる） | 同左 |
| `b` / `u` / `r` / `c` / `g` | **literal が composer に入る** | `g` はタイムラインが開く（実測）。u / r / c はバインド表による |

つまり **`u` / `r` / `c` / `g` は session-scoped** で、b と同じ取りこぼし方をする。
b と違うのは「効いたときに検出を壊さない」点なので、**採るが初回ターンまで disabled** にした。

ゲートに使う信号は `agentSession.session !== null`（`useTerminalPanePolling` が
`/current-output` の `structuredEvents.session` から作る、#2042 の値）。
**イベント購読が張れていない pane では常に disabled になる**という偽陰性がある。
見えていて押せないのは可視で可逆な劣化なので、黙ってゴミを打ち込むより良いほうを取った。

### 22.5 chord は 1 リクエスト 2 エントリ。100 ms で通る

`['C-x','b']` のように**1 回の special-keys リクエストに 2 エントリ**として渡す。
`sendSpecialKeys()` が `SPECIAL_KEY_DELAY_MS`（100 ms）を挟んで 1 つずつ送るので、
`runKeySequence` の逐次送出規約と同じ形になる（literal / key の区別だけは
special-keys transport に無い）。

opencode の `leader_timeout` 既定は 2000 ms。**本番と同じ 100 ms 間隔で `C-x` `a` を 3 回撃ち、3/3 でダイアログが開いた。**
（300 ms でも同じ。tmux が送るバイトは `send-keys C-x` = `0x18`、`send-keys a` = `a`。
`send-keys -H 18` と `send-keys C-x` は同一挙動であることも A/B で確認した。）

### 22.6 `/tui/*` は 1 つも採らなかった

Issue 本文は `/tui/open-models` などを一次経路にと書いていた。**採っていない。** 理由:

1. **`200 true` は「起きた」ではない**（§11.3.3）。TUI が 1 つも繋がっていない headless サーバでも
   `/tui/open-*` は全部 `200 true` を返す。したがって「HTTP が通った」は配線の根拠にならない。
2. 本 Issue が実測したダイアログ（agents / sessions / timeline / commands）は**すべてキーストロークで開いた**もので、
   HTTP 経路では 1 度も開いていない。**確認していない経路を「たぶん動く」で配線しない**という
   オーケストレーターの指示どおり、キーストロークだけを配線した。
3. そもそもキーストローク経路には `/tui/*` に無い利点がある: **route を増やさない**。
   `POST /api/worktrees/[id]/special-keys` は既にあり、認証・IP 制限・instance 解決・
   キャプチャキャッシュ無効化・スナップショット broadcast が既に通っている。
   ダイアログ 1 つごとに opencode 専用 route を足すと、その全部を再実装することになる。

なお `/tui/open-sessions` は #2038 が `OpencodeSessionControls` で既に使っている。
本 Issue はそれを取り上げも増やしもしていない（`ctrl+x l` は同じダイアログへの別経路で、
キーストロークのほうは実測済み、という状態）。

### 22.7 `F2`（model recent 巡回）— **計測できなかったので採らない**

`model_cycle_recent: f2` はバインド表に実在する。しかし:

- **ダイアログを出さずにその場でモデルを切り替える。**確認も取り消しも無い。
- **計測するには recent リストに 2 個目のモデルを入れる必要があり、それはピッカーで選ぶということ**である。
  §4 の規則（ピッカーは既定モデルを書き換えるので開かない）に真正面からぶつかる。

よって `F2` は `TERMINAL_KEY_VALUES` に入れていない。route は 400 を返す。
バインド自体は §22.1 に記録したので、計測できる形が見つかったときに足せばよい。

**逸脱の報告**: leader の取りこぼしを網羅する probe ループに `m` を入れてしまい、
**モデルピッカーを 1 度開いた**。隔離 HOME の中で、Escape で何も選ばずに閉じ、直後に
①隔離 `opencode.jsonc` が `github-copilot/claude-sonnet-4.6` のままであること
②ステータス行が `Claude Sonnet 4.6` のままであること
③ユーザーの `~/.config/opencode/opencode.jsonc`（7/19）と `~/.local/share/opencode/opencode.db`（8/25 14:16:54）の
mtime が検証開始前と同一であることを確認した。**ユーザー側への書き込みは無い。**
`ctrl+x m`（`model_list`）は「ダイアログが開き、Escape で何も選ばずに閉じ、設定が書かれない」ところまで
これで実測できてしまったので、**採用した**。選択した場合に既定モデルが書き換わることは §4 のとおりで、
それは利用者が opencode 自身のダイアログの中で行う操作であり、CommandMate が代行するものではない。

### 22.8 未計測・積み残し

- **`ctrl+x u` / `ctrl+x r` / `ctrl+x c` をセッション有りで押していない。** undo / redo は
  メッセージを巻き戻し、compact は API を消費する圧縮ターンを起こす。バインド表（§22.1）と
  「ホーム画面では落ちる」ことだけが実測で、**効いたときの画面は未計測**。
- **`F2` / `shift+f2` / `shift+tab`** — `shift+tab`（`BTab`）はバインド表にあり transport も
  #2032 以来通るが、**実 TUI で押していない**（`Tab` のみ実測）。
- **パレット経由でサイドバーを ON にした pane の検出** — §22.3.4 の残り。
  サイドバーが出ている frame を検出して警告する、という手当ては本 Issue では入れていない。
- **121〜199 桁でのサイドバー列数** — #2047 の積み残しのまま。本 Issue は既定幅しか触らない。

### 22.9 この節が変えたもの

- `src/types/terminal-keys.ts` — `OPENCODE_LEADER_KEY` / `OPENCODE_LEADER_CHORD_VALUES` /
  `OPENCODE_DIRECT_KEY_VALUES` / `OPENCODE_NAVIGATION_KEY_VALUES` / `TERMINAL_KEY_VALUES` / `TerminalKey`
- `src/types/cli-tool-contracts.ts` — `NavigationKeySpec`
- `src/lib/cli-tools/types.ts` — `ICLITool.navigationKeys()`
- `src/lib/cli-tools/base.ts` — 既定実装（＝ #2046 以前のグローバル集合そのまま。6 ツールは差分ゼロ）
- `src/lib/cli-tools/opencode.ts` — `navigationKeys()` の override **のみ**（幅 / geometry は #2047 のまま）
- `src/lib/tmux/tmux.ts` — `ALLOWED_SPECIAL_KEYS` に `C-x` / `C-p` / `C-t` と chord letters を追加、
  `isAllowedSpecialKey(key, vocabulary)` の第 2 引数
- `src/app/api/worktrees/[id]/special-keys/route.ts` — 検証をツール別宣言に
- `src/components/worktree/OpencodeQuickKeys.tsx` — PC / モバイル共通のクイックキー列
- `src/components/worktree/TerminalSplitPaneContent.tsx` / `MobileTerminalTab.tsx` — 配線
- `src/app/worktrees/[id]/terminal/page.tsx` — 未リンクページのツール一覧に opencode
- `locales/{en,ja}/worktree.json` — `opencodeQuickKeys`
- `tests/fixtures/opencode-live-2046/**` — 10 フレーム ＋ 採取手順の README

---

## 24. Issue 2052: opencode 同居 Web UI を External Apps proxy 越しに開けるか（opencode 1.18.22 / 2026-08-26）

Epic #2055 Phase 4 の spike。成果物はこの節だけで、**production コードは 1 行も変えていない。**
一次証拠は `tests/fixtures/opencode-web-2052/`（採取手順は同ディレクトリの README）。

### 24.0 結論サマリ

| # | 問い | 実測 |
|---|---|---|
| 1 | `GET /` は本当に Web UI か | **Yes。** `opencode serve` も `opencode web` も同じ 2884 B の SPA シェルを返し、`index-K3ryTWVK.js`（2,738,995 B）が読み込まれて UI が起動する。`serve` と `web` の HTML / JS は**バイト一致**（sha256 `51ee4d8f…`） |
| 2 | アセットの参照は絶対か | **絶対のみ。** `/assets/…`・`/site.webmanifest`・`/favicon-*`。バンドル内の `/assets/…` 文字列リテラル 10 件はすべて絶対で、相対 `./assets/…` は **0 件**、`import.meta.env.BASE_URL` 相当の間接も **0 件** |
| 3 | UI が生きるのに要る transport | **SSE 1 本（`GET /global/event`）だけ。** 初回描画〜アイドルで WebSocket は **0 本**。`new WebSocket` はバンドル中 1 箇所で、呼出元は組込み PTY ターミナル（`/api/pty`）専用 |
| 4 | `--cors` 無しで別 origin から動くか | **loopback origin だけ許可される。** `http://127.0.0.1:3052` / `http://localhost:3052` には ACAO が返るが、`http://192.168.1.50:3000`・`https://evil.example.com`・`null` には**返らない** |
| 5 | TUI と同時操作でセッションが同期するか | **する（双方向・リロード不要）。** ただしホーム画面の「最近のセッション」一覧だけは、他所で作られたセッションを live 更新しない |

**判定: 現状の External Apps proxy 越しには不可。** 理由は 1 点に切り分けられる ——
**proxy が `/proxy/<prefix>` を剥がさない（path rewrite が無い）こと**と、
**opencode 側に basePath を持たせる手段が無いこと**の噛み合わせ。
**WebSocket 非対応でも CORS でもない**（下記 24.5 / 24.7 で両方とも「原因ではない」ことを実測で外した）。

### 24.1 Issue 本文とブリーフィングの誤りを 2 件訂正する

- **「proxy は現状 WebSocket を運べない」は誤り。** `proxyWebSocket()`（`src/lib/proxy/handler.ts:194`）が
  426 を返すだけなのは事実だが、それは `@deprecated` の防御的 fallback で、実際の upgrade は
  `handleProxyUpgrade()`（`src/lib/ws-server.ts:148`、Issue #671）が **raw TCP pass-through** で通す。
  `server.on('upgrade')` の `pathname.startsWith('/proxy/')` 分岐（`src/lib/ws-server.ts:363`）がそれ。
  実測でも proxy 越しの WS は往復した（24.5）。
- **「未知ルートの `200 text/html` は Web UI が同居している証拠ではなく 404 を返さないだけかもしれない」は、
  前半が正しく後半が外れ。** 実際に Web UI が同居しており、SPA シェルはブラウザで起動する（24.2）。
  ただし「未知ルートにも同じシェルを返す」ことは事実で、それが 24.5 の実害の直接原因になる。

### 24.2 隔離の確認（先に撃つ）

§4 のハーネスをそのまま使用。`opencode serve --port 4852`／`opencode web --port 4853`／
`OPENCODE_SERVER_PASSWORD` つき `--port 4855`。3 台とも `GET /path` が

```
home      …/scratchpad/home
state     …/scratchpad/home/.local/state/opencode
config    …/scratchpad/home/.config/opencode
worktree  …/scratchpad/work
directory …/scratchpad/work
```

を返すことを確認してから計測した。**モデルピッカーは一度も開いていない**（config で
`github-copilot/claude-sonnet-4.6` に固定）。Web UI のフォルダピッカーが列挙したホーム直下も
`.cache / .config / .local / Library` の 4 件のみで、実ホーム（`.claude`・`.codex`・`.commandmate` ほか
多数）とは一致しない ＝ Web UI 側から見ても隔離できている。非汚染の実測は 24.11。

CommandMate 側も隔離した（**本番 3000 と本番 DB を踏まないこと**）:
`env -u CM_DB_PATH NODE_ENV=development CM_PORT=3052 CM_BIND=127.0.0.1 npx tsx server.ts`。
シェルには `CM_PORT=3000` / `CM_DB_PATH=<本番>` / `NODE_ENV=production` が export されているので
明示上書きが必須。`CM_DB_PATH` を scratchpad に向けるとシステムディレクトリガードに弾かれる
（`Invalid CM_DB_PATH: … cannot be in system directory`）ので、`env -u` で worktree 既定の
`./data/cm.db`（gitignore 済、検証後に削除）に落とした。

### 24.3 `GET /` は本物の Web UI（`opencode web` と同一物）

`opencode serve` の `GET /` は 2884 B / `text/html`、`Content-Length: 2884`。
**同じバイト列が未知ルートでも返る**（`/this/route/does/not/exist` と `cmp` して一致）。
中身は `tests/fixtures/opencode-web-2052/spa-shell.html`。参照しているのは:

| 種別 | 参照 |
|---|---|
| JS | `/assets/index-K3ryTWVK.js`（`type="module" crossorigin`、2,738,995 B、`text/javascript`） |
| CSS | `/assets/index-CMLUT3g5.css`（482,527 B） |
| manifest | `/site.webmanifest`（487 B、`application/manifest+json`） |
| favicon | `/favicon-96x96-v3.png` / `/favicon-v3.svg` / `/favicon-v3.ico` / `/apple-touch-icon-v3.png` |
| inline | テーマ先読み `<script id="oc-theme-preload-script">`（opencode 自身の CSP に sha256 が入っている） |

Chromium で `http://127.0.0.1:4852/` を開くと UI が起動し（`screenshot-direct-4852.png`）、
コンソールエラー **0 件**。日本語ロケールで「プロジェクト」「最近のセッション」等が描画される。
遅延 import される追加チャンク（`/assets/ja-vqBZHfTW.js`・`/assets/ja-BaAAHI8J.js`・`/assets/Inter.ttf`）も
すべて絶対パス。全リクエストは `network-direct-4852.txt`。

`opencode web --port 4853` は **同じ HTML（`cmp` 一致）と同じ JS（sha256 一致）** を返し、違いは
「起動時に既定ブラウザを開く」ことだけだった（本検証では `open` を PATH shim で無効化して確認）。
**つまり「`opencode web` の UI」と「`--port` つき TUI に同居する UI」は同一物**で、
CommandMate が opencode ペインごとに立てている `127.0.0.1:42xx`（`OPENCODE_PORT_RANGE`、
`src/lib/hooks/sources/opencode/ports.ts:59`）でも同じ UI が出る。

opencode の CSP は `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-…'; …; connect-src *`。
`connect-src *` なので **opencode 自身は API 先の origin を縛っていない**（縛っているのは 24.7 の CORS 側）。

### 24.4 UI が要る transport は SSE 1 本。WebSocket は PTY 専用

初回描画で開くのは `GET /global/event` の 1 本きり:

```
Content-Type: text/event-stream / Cache-Control: no-cache, no-transform
x-accel-buffering: no / Transfer-Encoding: chunked
data: {"payload":{"id":"evt_…","type":"server.connected","properties":{}}}
```

`§4.3` の実測どおり `event:` 行は無く、種別は `data` の JSON の `type` にしか入らない。
バンドル側も `EventSource` を **0 回**しか使わず、`fetch` + 手書きの `text/event-stream` リーダで読む。

`new WebSocket` はバンドル中 **1 箇所**だけで、周辺の識別子は
`terminal.connectTicket.csrfError` / `binaryType="arraybuffer"` / cursor 復帰 ＝ **組込み PTY ターミナル**
（`/api/pty` 系）。**チャット UI・セッション一覧・diff の描画に WebSocket は要らない。**
（未計測: PTY パネルを実際に開いてはいない。開けば WS が 1 本増えるはずだが撃っていない。）

その他の REST は `/global/health`・`/api/health`・`/api/session?limit=…`・`/global/config`・
`/provider`・`/path`・`/session/status`・`/project` ほか、**すべて絶対パス**。
プロジェクトを開いた後は `?directory=<絶対パス>` つきのクエリが大量に飛ぶ。

### 24.5 CommandMate の proxy が実際にできること・できないこと（実測）

すべて `develop@ceb1059d` の実コード（`proxyHttp` / `handleProxyUpgrade`）に対する実測。
echo upstream を External App として登録して素性を切り分けた（`probe-proxy-sse-ws.txt`）。

| 能力 | 実測 | 根拠 |
|---|---|---|
| path rewrite | **無い。** `/proxy/echo/hello?x=1` を投げると upstream は `receivedUrl:"/proxy/echo/hello?x=1"` を受け取る | `buildUpstreamUrl()` は `http://host:port${path}` を組むだけ（`src/lib/proxy/handler.ts:50`）。docblock も「上流を `basePath: '/proxy/{pathPrefix}'` で構成せよ」と要求している |
| SSE | **通る。バッファしない。** 500 ms 間隔で吐く upstream の各フレームが `+0.416 / +0.916 / +1.418 / …` と 500 ms 刻みで到達 | 同上 |
| WebSocket | **通る。** `ws://127.0.0.1:3052/proxy/echo/socket` が 101 → 往復メッセージ成功。upstream は `receivedUrl:"/proxy/echo/socket"` を受ける（WS でも path は無加工） | `handleProxyUpgrade()`（Issue #671） |
| WS の陰性対照 | `websocketEnabled=false` → **403**、未知 prefix → **404** | 3 通りが撃ち分けられている ＝ 応答しているのは確かに `ws-server.ts` の分岐であって Next の 404 ではない |
| `authorization` の転送 | **剥がされる。** 直叩き 200 / proxy 越し 401 | `SENSITIVE_REQUEST_HEADERS`（`src/lib/proxy/config.ts:38`）に `authorization` / `cookie` |
| 上流 CSP / CORS ヘッダ | **剥がされ、CommandMate 自身のものに差し替わる。** proxy 応答の CSP は `connect-src 'self' data: ws: wss:` | `SENSITIVE_RESPONSE_HEADERS`（同 `:94`）に `content-security-policy` と `access-control-*` |
| ExternalAppCache | TTL **30 秒**。登録直後の proxy 参照は 404 を返す | `src/lib/external-apps/cache.ts:30` |

**したがって「WS が無いから不可」ではない。SSE も WS も通る。**

### 24.6 実測: proxy 越しに開くと真っ白（`screenshot-proxied-3052.png`）

External App `oc`（`pathPrefix=oc` → `127.0.0.1:4852`、`websocketEnabled=true`）を登録し、
Chromium で `http://127.0.0.1:3052/proxy/oc/` を開いた結果:

```
1. GET /proxy/oc/                    => 200  (SPA シェル。直叩きと cmp 一致)
2. GET /assets/index-K3ryTWVK.js     => 404
3. GET /assets/index-CMLUT3g5.css    => ERR_ABORTED (404 本文が text/html で MIME 拒否)
4. GET /site.webmanifest             => 404
8. GET /favicon-v3.ico               => 404   (以下 favicon 3 件も 404)
```

**SPA のファイルが 1 つも読めないので JS が一度も走らず、API 呼出は 1 本も発生しない。**
`#root` は空のまま（アクセシビリティスナップショットが空）。

壊れ方は二重で、**片方だけ直しても動かない**:

1. **シェルの参照が絶対なので、ブラウザは mount point を捨てて origin ルートに取りに行く。**
   `/proxy/oc/assets/…` ではなく `/assets/…` を要求し、そこは CommandMate の Next.js が 404 を返す
   （しかも `/_next/static/...` という CommandMate 自身の名前空間と同じ根に生えることになる）。
2. **仮にクライアント側で `/proxy/oc/assets/…` に書き換えても届かない。**
   proxy は prefix を剥がさないので上流は `/proxy/oc/assets/index-K3ryTWVK.js` を受け取り、
   opencode はそれを未知ルートとして **SPA シェル（2884 B / text/html）** で返す。
   同じ理由で `/proxy/oc/api/event` も `/proxy/oc/path` も **全部 2884 B の HTML**（`probe-proxy-paths.txt`）。
   `GET /doc` の `ServerConfig` は `port` / `hostname` / `mdns` / `mdnsDomain` / `cors` の 5 キーのみで、
   **basePath に相当する設定は存在しない**（一次証拠。`opencode serve --help` にも無い）。

### 24.7 CORS: 既定は loopback origin だけ（`--cors` は効く）

`--cors` を渡さない 4852 に `Origin` を変えて撃った結果:

| Origin | `Access-Control-Allow-Origin` |
|---|---|
| `http://127.0.0.1:3052` | 返る（同値を反射） |
| `http://localhost:3052` | 返る（同値を反射） |
| `http://192.168.1.50:3000` | **返らない** |
| `https://evil.example.com` | **返らない** |
| `null` | **返らない** |

`--cors http://192.168.1.50:3000` を付けた 4855 では同 origin に ACAO が返り、
`https://evil.example.com` には返らない（陽性・陰性対照そろい）。preflight は
`204` ＋ `Allow-Methods: GET, HEAD, PUT, PATCH, POST, DELETE`、`Allow-Credentials` は返らない。

**この spike の構成（proxy で同一 origin に載せる）では CORS は最初から関与しない**ので、
**CORS は不可の原因ではない。** 関与するのは「proxy をやめて別 origin の opencode を直接叩く」案
（24.9）で、そのときは `--cors` が必須になる。

なお SPA には `/server/<base64(サーバURL)>/session/<id>` というクライアントルートがあり
（UI 内のセッションリンクの `href` がそれ）、`http://127.0.0.1:4852` を base64 した
`aHR0cDovLzEyNy4wLjAuMTo0ODUy` が実際に入る。ただし **4853 でそのパスを開いても API 呼出は
すべて 4853（自 origin）に飛び、4852 へは 1 本も飛ばず、main は空のまま**だった。
「UI を別 origin にホストして任意の opencode サーバへ向ける」機能としては**成立を確認できていない**
（この 1 通りしか撃っていない。24.10 参照）。

### 24.8 認証

- **opencode 側**: `OPENCODE_SERVER_PASSWORD` を設定すると全パスが **HTTP Basic**
  （`WWW-Authenticate: Basic realm="Secure Area"`）になる。SPA シェル `GET /` も 401。
  **ユーザ名は `opencode` 固定**（`opencode:pw` → 200、`x` / `admin` / 空 / 任意文字列 → いずれも 401）。
  `Authorization: Bearer <pw>` は 401。`GET /doc` の `securitySchemes` は空で、OpenAPI には現れない。
  CommandMate が起動する opencode ペインはこの変数を設定していないので、**`127.0.0.1:42xx` は無認証**
  （起動行は `--port <n> --hostname 127.0.0.1` のみ ＝ `src/lib/hooks/sources/opencode/source.ts:306`）。
- **CommandMate 側**: `/proxy/**` は middleware の matcher に入るので、認証を有効にした環境では
  proxy 経由もログイン必須になる。ただし matcher は `.svg|.png|.jpg|.jpeg|.gif|.webp|.ico` で終わるパスを
  除外しているので、opencode の `/assets/sprite-*.svg` 等は**認証を通らずに抜ける**（今回の構成では
  そもそも 404 なので実害は出ていないが、root マウント案を採るなら効いてくる）。
- **組み合わせ**: proxy は `authorization` を剥がすので、**パスワード保護した opencode は
  proxy 越しに開けない**（直叩き 200 / proxy 越し 401 を実測）。
  「CommandMate 認証で包む」と「opencode 側にもパスワードを掛ける」は現状**両立しない**。

### 24.9 TUI と Web の同時操作（項目 5）

`tmux -L cmate-2052-web` の専用 socket で `opencode attach http://127.0.0.1:4852` を起動し、
Web UI（4852 直叩き、リロードなし）と突き合わせた。

| 操作 | 結果 |
|---|---|
| TUI で送信 → Web のセッション画面 | **live で反映**（`LIVE-SYNC-2052` の user / assistant 両方が、リロード無しで追加された） |
| Web で送信 → TUI ペイン | **live で反映**（`WEB-TO-TUI-2052` が TUI に出た。再 attach 不要） |
| TUI で新規セッション作成 → Web のホーム「最近のセッション」 | **live 更新されない。** リロードすると出る |
| REST で作ったセッション（`POST /session`） | プロジェクトを追加した後のホーム一覧に出る。中身も Web から読める |

つまり**会話状態は 1 つの実体で、TUI と Web はその 2 つのビュー**。
ホーム一覧だけが「開いた時点のスナップショット」で、他所発のセッション追加を拾わない。

### 24.10 不可の切り分けと、次にやるなら何を直すか

**不可の原因は「proxy の path 書き換えが無い」の 1 点。** 以下は原因ではないことを実測で外した:
WebSocket 非対応（→ 通る）、SSE のバッファリング（→ しない）、CORS（→ 同一 origin なので無関係）。

取りうる形は 3 つで、コストが違う:

| 案 | 必要な変更 | 実測から言える難所 |
|---|---|---|
| A. proxy に prefix ストリップを足す | `buildUpstreamUrl` に「`/proxy/<prefix>` を剥がす」オプション（App ごとのフラグ）。WS 側は `buildUpstreamUpgradeRequest` の request-line も同様に書き換え | **これだけでは足りない。** シェルの `<script src="/assets/…">` が絶対なので、ブラウザは prefix を付けずに取りに行く。HTML / JS の書き換えまでやらないと閉じない |
| B. root マウント（別ホスト名 / 別ポートで丸ごと前段に置く） | `/proxy/<prefix>` ではなく、CommandMate が opencode 専用のリスナ（または `Host` ベースの分岐）を持つ | 絶対パスがそのまま成立するので**アセットも API も無改造で通る**。SSE も WS も通ることは実測済み。CommandMate の `/assets`・`/_next` と名前空間が衝突しないことが条件 |
| C. proxy をやめて別 origin を直接開く | 「OpenCode Web で開く」を `http://127.0.0.1:42xx/` へのリンクにするだけ | **同一ホストのブラウザからしか成立しない。** ペインは `--hostname 127.0.0.1` で立つので、外出先のスマホからは到達不能。LAN に出すには `--hostname 0.0.0.0` ＋ `--cors <CommandMate の origin>` ＋ `OPENCODE_SERVER_PASSWORD` が要り、Issue の動機（CommandMate 認証で包む）とは別物になる |

Issue の動機（外出先のスマホから同一セッションを開く）を満たすのは **B のみ**。
A は中途半端に見えて実は HTML/JS 書き換えを伴うので、B より高くつく可能性が高い。
C は「PC で開発中に手元のブラウザで diff を見る」用途なら最小コストで成立する。

後続 Issue の本文案は `dev-reports/issue-2052-followup.md`。

### 24.11 非汚染の証拠

- 検証前に採った `~/.local/share/opencode/{opencode.db, opencode.db-wal, auth.json}` と
  `~/.config/opencode/*` の mtime 一覧を検証後に取り直し、**diff が空**であることを確認した。
  一方、隔離 HOME 側の `opencode.db` は 278,528 B に育っている（＝書き込みは確かにそちらへ行った）。
- 複製した `auth.json`（mode 600）は検証後に削除済み。
- tmux は専用 socket `cmate-2052-web` のみを使い、`kill-server` は撃っていない。
  既定サーバのセッション一覧は検証後も無傷（並走中の他ワーカーのセッションが残っている）。
- 使ったポートは 3052 / 4852 / 4853 / 4854 / 4855。**3000 は触っていない**（検証後も本番の
  node が LISTEN したまま）。全プローブプロセスは PID 指定で停止済みで、5 ポートとも LISTEN 0。
- CommandMate 側の検証 DB は worktree 既定の `./data/cm.db`（gitignore 済）で、検証後に削除した。

### 24.12 未計測（推測で埋めていない箇所）

- **PTY パネル（`/api/pty`）を実際に開いていない。** WS の呼出元がそこだと**バンドルの静的解析**で
  特定しただけで、開いたときに何本 WS が張られるか、proxy 越しに通るかは撃っていない。
  proxy が WS を通すこと自体は echo upstream で実測済み。
- **`/server/<base64>` ルートの意味を確定していない。** 別 origin で開くと自 origin へフォールバック
  したところまでしか観測しておらず、「任意サーバに向ける機能」として使えるかは不明。
- **prefix ストリップを実装して試していない。** 24.10 の A / B は「実測から導ける帰結」であって、
  実装して動かした結果ではない。
- **スマホ実機・LAN 越しは撃っていない。** 24.7 の LAN origin は `Origin` ヘッダを詐称した
  curl による CORS 応答の観測のみで、実機からの到達性は測っていない。
- **CommandMate 認証を有効にした状態での proxy 経由アクセス**は測っていない（本検証は認証無効の dev）。
- **diff / レビュー画面**（`レビューの切り替え` ボタン）は開いていない。Issue が動機に挙げた
  「リッチな diff」が実際にどう見えるかは未確認。

### 24.13 この節が変えたもの

- `docs/design/opencode-server-live-verification.md` — 本節（§24）
- `tests/fixtures/opencode-web-2052/**` — 一次証拠 9 ファイル ＋ 採取手順の README
- **production コードの変更は無い**（この Issue は spike で、受入条件は実測の記録だけ）
## 25. Issue 2054: `liveness` / `probeActivity` を実際に読む（opencode 1.18.22 / 2026-08-26）

Phase 4 は `AgentEventSource` に `liveness()` と `probeActivity()` を生やしたが、
**本番の呼び出し元を 1 つも作らなかった**。`.probeActivity(` / `.liveness(` を `src/` 全体で
検索すると定義箇所以外 0 件で、`port_identity_changed` を立てるコード（`subscription.ts`）は
存在するのに、その結果を読む画面が存在しない。本節はそれを塞いだ実測記録である。

### 25.1 Issue 本文と実装の食い違い（実測を正とした）

| Issue 本文 | 実際 | 採用 |
|---|---|---|
| `structuredEvents.source` を新設 | #1924 が `{cliToolId, capabilities}` で既に存在 | **既存 2 フィールドを保ったまま additive 拡張**。`tests/unit/session/status-evidence-1924.test.ts` の `toEqual` は網羅性を保ったまま新フィールドを足して更新 |
| `source.ts:361-362` | 実際は `source.ts:384-385`。中身は実装済み | 行番号は陳腐化。足りないのは呼び出し元だけ、という読みで正しい |
| `liveness` を `worktree-status-helper` から読む | 同ファイルに `liveness` / `degraded` は 0 件 | 新規配線。`CliToolSessionStatus.eventSource` を追加 |

### 25.2 `getOpencodeLiveness` の直接読み手を増やさない、という判断

既に 3 箇所が `getOpencodeLiveness` を直接呼んでいる
（`api/worktrees/[id]/instances/opencode/route.ts` / `lib/cli-tools/opencode.ts` /
`lib/hooks/sources/opencode/runtime.ts`）。本 Issue は **4 人目を作らず、source I/F 経由に寄せた**。

- `current-output-builder` と `worktree-status-helper` はどちらも
  `getAgentEventSource(cliToolId).liveness(target)` を呼ぶ。**ツール名を書かない。**
- 畳み込みは `define-source.ts` の `describeAgentEventSource()` **1 箇所だけ**。
  ヘッダチップの tooltip とロスターの警告行が同じ pane を別々に説明することが構造上できない。
- 理由: 上記 3 箇所は「opencode の port に HTTP を投げてよいか」を判断する opencode 固有の
  ゲートで、`sources/opencode/` の中か、その直接の利用者（`cli-tools/opencode.ts`）にある。
  対して本 Issue の 2 つの読み手は **全ツール共通のステータス組み立て層**で、そこにツール名が
  出た時点で 7 ツール分の分岐が始まる。同じ関数を呼ぶが、呼び方を分けたのはそのため。

`probeActivity` だけは例外で、`runtime.ts`（＝ opencode 固有層）から
`opencodeAgentEventSource.probeActivity(target)` を呼ぶ。`client.fetchOpencodeActivity` を
直接呼べる場所だが、**I/F 経由にした**（port 解決・no-port の null・タイムアウトを二重に持たない）。

### 25.3 実測ハーネス

§4 のとおり。**新しい隔離方法は発明していない。**

- `HOME` ごと差し替え。`GET /path` で `home` / `state` / `config` / `worktree` / `directory` が
  **すべて scratchpad 配下**であることを確認済み。
- `auth.json` は `umask 077` で複製し、検証後に削除した（`ls -l` で確認）。
  ユーザーの実 `~/.local/share/opencode/auth.json` は mtime も変わっていない。
- モデルは `opencode.jsonc` で固定。**TUI のモデルピッカーは一度も開いていない**
  （そもそも TUI を起動していない。後述）。
- ポートは **4818**。3000 も §4 の 4788–4792 も使っていない（並行ワーカーと衝突しないため）。
- **tmux はいっさい触っていない。** 本節の観測対象は「CommandMate 側の購読がポート奪取を
  どう報告するか」で、pane の描画ではない。したがって `openOpencodeSubscription({ port })` を
  `tsx` から直接叩いており、既定 tmux サーバに 1 コマンドも送っていない。
  `-L` を忘れて本番サーバを壊す経路そのものが無い。
- `CM_DB_PATH` も scratchpad に差し替え（`recoverHistory` が DB に触る可能性への保険）。

ポート奪取は「opencode を `SIGTERM` → 同じ 4818 に別プロセスの HTTP サーバを bind し、
`GET /global/health` に `{"healthy":true,"version":"9.9.9-squatter"}` を返させる」で再現した。
これは `verifyServerIdentity()` が version 差を見る #1900 の経路そのものである。

生ログは `tests/fixtures/opencode-liveness-2054/live-probe.json`（2 ラン分）。

### 25.4 実測結果

**`subscription.ts` の `degradeToScraper` は実際に通った。** サーバログ:

```
opencode-subscription-port-identity-changed
  {"port":4818,"reason":"port_identity_changed",
   "expectedVersion":"1.18.22","observedVersion":"9.9.9-squatter"}
```

公開される 4 状態（`describeAgentEventSource` の出力、実測値そのまま）:

| 状態 | `kind` | `liveness` | `degradedReason` |
|---|---|---|---|
| ストリーム生存 | `sse` | `live` | — |
| ポート奪取後 | `scraper` | `stale` | `port_identity_changed` |
| 購読なし（port 未割当 / hooks 無効） | `scraper` | — | `not_subscribed` |
| pane を閉じた後 | `scraper` | — | `not_subscribed` |

タイミング（2 ラン一致）:

- opencode を kill してから degraded が観測されるまで **1,071 ms**。
  内訳は `OPENCODE_RECONNECT_BACKOFF_MS[0] = 1000 ms` ＋ health probe。
- ハートビート間隔: **9,997 / 10,002 / 10,005 / 9,993 / 10,006 ms**（5 サンプル）。
  10 s メトロノームは 1.18.22 でも変わらない。`AGENT_SOURCE_STALE_AFTER_MS = 30_000` は
  **3 拍落ち**であり、`OPENCODE_HEARTBEAT_TIMEOUT_MS` と同じ数であることを
  `opencode-liveness-2054.test.ts` が assert している（両者は互いを import できない）。

### 25.5 実測で見つかった欠陥 2 件（本 Issue で修正）

1. **`degradeToScraper` が理由を捨てていた。**
   `state.liveness = {state:'lost', reason:'port_identity_changed'}` を立てた**次の行**で
   `subscriptions.delete(state.key)` しており、以後 `getOpencodeLiveness` は
   `{state:'unknown'}` を返す。つまり受入条件が求める `port_identity_changed` は
   **どの画面からも観測不可能**だった。落とした購読の最後の liveness を残す tombstone
   （`droppedLiveness`）を追加した。`lost` しか書かないので、`state === 'live'` を見る
   既存 3 箇所の判断は 1 つも変わらない（`unknown` → `lost` はどちらも「live でない」）。
2. **`closeOpencodeSubscription` が tombstone を消せなかった。**
   1 ラン目の `after-close` が `port_identity_changed` のままだった（実測）。
   tombstone を持つのは「既に map から消された」インスタンスだけなので、
   `if (!state) return` の**手前**で消す必要がある。修正後の 2 ラン目で
   `after-close` が `{state:'unknown'}` に戻ることを確認した。

### 25.6 `probeActivity` の接続先

`runtime.attachOpencodeEventStream()` が `subscribe()` 成功直後に 1 回だけ呼ぶ。
**Phase 4-1 以来はじめての本番呼び出し元。**

埋めている穴: ストリームがターンの途中で開くと、**最初のフレームはそのターンが終わったとき**に
来る。長いターンなら数分間、「この pane はいま働いているか」に答えられるのは画面だけになる。
`GET /session/status` はその答えを持っており、これがそれを聞く唯一の呼び出しである。

`subscription.recoverTurnState()` の per-session 読み取りとは別物で、置き換えでもない
（あちらは turn gate を再武装する。こちらはインスタンス単位の集約で、画面が描ける）。
結果は `structuredEvents.source.probedActivity = {activity, at}` として publish する。
`at` を必ず添えるのは、これが**一瞬の記録であって現在値ではない**からで、
ここから status を導出しているコードは無い。

### 25.7 計測していないこと（推測で埋めていない）

- **ブラウザ上のチップの実描画。** 隔離 dev サーバを立てて実 opencode pane を tmux で
  起動する UAT は行っていない。並行して 2 ワーカーが走っており、tmux 既定サーバと
  ポートに触るリスクに見合わないと判断した。代わりに、
  - サーバが publish する値は上記のとおり**実 opencode で実測**、
  - その値からチップ / 警告行が何を描くかは `agent-source-display-2054.test.tsx` が
    **実辞書（`locales/en`）で** assert、
  という 2 段で担保している。「チップに `port_identity_changed` が出る」の
  サーバ側半分は実測、描画側半分はユニットである。**この切り分けは意図的で、
  描画側を実測したとは書かない。**
- **`heartbeat_stale`（30 s 無音）の実観測。** 実測したのは 10 s 周期の方で、
  「30 s 落ちたら stale」は周期からの導出。opencode を止めると SSE が即座に閉じ、
  watchdog より先に `stream-ended` で `lost` になるため、`live` のまま 30 s 沈黙する状態を
  実サーバで作るのは容易ではない（プロセス停止 `SIGSTOP` が要る）。今回は行っていない。
- **`AgentInstancesPane` の自前ポーリングの実負荷。** roster に opencode が居るときだけ
  `GET /api/worktrees/:id` を 10 s 間隔で読む設計だが、実サーバでの負荷は測っていない。
  claude / codex だけの roster では 1 リクエストも出ないことはユニットで assert 済み。

### 25.8 この節が変えたもの

- `src/lib/hooks/sources/types.ts` — `AgentEventSourceKind` / `AgentEventSourceLiveness` /
  `AgentEventSourceStatus`
- `src/lib/hooks/sources/define-source.ts` — `AGENT_SOURCE_STALE_AFTER_MS` /
  `declaredAgentSourceKind()` / `describeAgentEventSource()`
- `src/lib/hooks/sources/opencode/subscription.ts` — `droppedLiveness` tombstone /
  `recordOpencodeProbedActivity()` / `getOpencodeProbedActivity()` / close の消去順
- `src/lib/hooks/sources/opencode/runtime.ts` — `probeAttachedActivity()`（attach 直後の probe）
- `src/lib/session/current-output-builder.ts` — `StructuredSourcePayload` に
  `kind` / `degradedReason?` / `liveness?` / `probedActivity`
- `src/cli/types/api-responses.ts` — 同じ 4 つ。#1924 と同じ理由で**文字列型のまま**
- `src/lib/session/worktree-status-helper.ts` — `CliToolSessionStatus.eventSource`
- `src/types/models.ts` — `AgentEventSourceView`、`sessionStatusByInstance` に `eventSource`
- `src/components/worktree/WorktreeDetailSubComponents.tsx` — `formatAgentSourceLabel()` /
  `isAgentSourceDegraded()` / ヘッダピルの tooltip
- `src/components/worktree/AgentInstancesPane.tsx` — 警告行と `useAgentSourceByInstance()`
- `src/components/worktree/MobileAgentInstancesPane.tsx` — `sourceByInstance` の受け渡し
- `src/config/agent-source-config.ts` — `AGENT_SOURCE_POLL_INTERVAL_MS`
- `locales/{en,ja}/worktree.json` — `agentSource` / `detail.statusPillWithSource`
- `tests/fixtures/opencode-liveness-2054/live-probe.json` — 実測 2 ラン

---

## 26. Issue 2053: Auto-Yes の deny を `OPENCODE_CONFIG_CONTENT` で注入できるか（opencode 1.18.22 / 2026-08-26）

> **この節は #2053 が追記したものです。§1〜§25 は書き換えていません。**
> 食い違う記述があれば**版が違う**（§1〜§10 は 1.18.3、本節は 1.18.22）ことを先に疑ってください。

Issue #2053 は「`permission` の `deny` を起動時に inline 注入すれば `permission.asked` の往復ごと
消せるのではないか」という提案である。**機構は実在し、狙いどおりに効いた。**
それでもなお**採らない**と決めた。裁定と理由は
[`agent-event-source-interface.md` §3.4](./agent-event-source-interface.md#34-configscope-none-を維持する裁定2053)
に置き、本節はその根拠となる実測だけを記す。

### 26.1 結論サマリ

| 測ったこと | 結果 |
|---|---|
| `OPENCODE_CONFIG_CONTENT` は 1.18.22 に実在し、読まれるか | **実在する**（[26.3](#263-precedence-4-層から-5-層へ実測)）。repo 側の参照は 0 件だった＝**未検証の外部ドキュメント由来という Issue 本文の前提は正しかった** |
| Issue の言う「inline は project config より上位」 | **正しい。** 5 層の**最上位**（4 層すべてに勝つ） |
| 受入条件: `rm -rf` を含む bash が**ダイアログなしで拒否**され `permission.asked` が発生しない | **満たす。** `permission.asked` **0 件**、tool part は `error`、4.3 秒後に `session.idle`（[26.4](#264-受入条件の実測-deny-はダイアログを消す)） |
| `share: "disabled"` も同じ経路で入るか（論点 1） | **入る。** `GET /config` に `"share":"disabled"` が出る |
| CommandMate の stop-pattern を写せるか（論点 2） | **写せない。** 定義域・言語・効果・**決まる時刻**の 4 つが違う（[26.6](#266-論点-2-stop-pattern-との写像は存在しない)） |
| 利用者の既存 `permission` 設定との併存（論点 3） | **併存しない。2 通りの経路で黙って壊す**（[26.5](#265-論点-3-利用者設定を黙って壊す-2-つの経路実測)） |
| 注入が壊れたときの失敗の出方 | **TUI は起動を拒否して exit 0**（ポートが開かない）。`serve` は `/global/health` だけ `healthy` を返し続ける（[26.7](#267-注入が壊れたときの失敗の出方)） |

### 26.2 ハーネスと非汚染の証拠

[§4](#4-再現環境ハーネス) のとおり。差分だけ記す。

| 項目 | 値 |
|---|---|
| 版 | **1.18.22**（`GET /global/health` → `{"healthy":true,"version":"1.18.22"}`） |
| 隔離 HOME | scratchpad 配下。**計測のたびに `GET /path` を撃ち**、`home` / `state` / `config` / `worktree` / `directory` の 5 つが自分の scratchpad 配下であることをゲートにした（`probe.sh` が一致しなければ `exit 90` で止まる）。#2051 / #2052 の「lsof は次の瞬間の保証にならない」への対応 |
| ポート | **4731〜4742**（`47xx` 帯。`48xx` は使っていない。3000 も使っていない）。すべて `--hostname 127.0.0.1` |
| provider / model | `github-copilot/claude-sonnet-4.6`。隔離 HOME の `opencode.jsonc` で固定し、**モデルピッカーは一度も開いていない** |
| 送信経路 | `POST /session` → `POST /session/:id/prompt_async`（[§11.4](#114-tui-系を採らない理由) の裁定に従い `/tui/*` は使わない）。TUI を立てないので**ピッカーに触れる経路自体が無い** |
| tmux | `tmux -L cmate-i2053-oc`（専用 socket）。[26.7](#267-注入が壊れたときの失敗の出方) の TUI 起動確認 1 回だけ。後始末は `kill-session -t '=oc-bad:'`。**`kill-server` は使っていない。`set-option -g` / `bind-key` も既定サーバへ撃っていない** |
| `auth.json` | mode 600 で複製し、**検証後に削除**（削除確認済み） |
| ユーザー HOME 非汚染 | 検証終了時点で `~/.local/share/opencode/opencode.db` の mtime は **8/26 16:54:44**（計測開始 17:38 より前）、`~/.config/opencode/opencode.jsonc` は **7/19 23:54** のまま。**1 バイトも触っていない** |

### 26.3 precedence: 4 層から 5 層へ（実測）

#1908 が `opencode debug config` で測った 4 層（`src/lib/cli-tools/opencode-config.ts:20-28`）に
**`OPENCODE_CONFIG_CONTENT` の行が無い**。同じ手順を 1.18.22 で回し、5 行に更新した。

`username` という単一スカラーキーを 5 層それぞれに別の値で置き、上から順に足していった:

| # | layer | 読む | 勝つ相手 | 実測 `username` |
|---|---|---|---|---|
| L1 | `$XDG_CONFIG_HOME/opencode/opencode.json(c)` | yes | （最下位） | `L1-global` |
| L2 | `$OPENCODE_CONFIG` | yes | L1 | `L2-envfile` |
| L3 | `<worktree>/opencode.json` | yes | L1 / L2 | `L3-project-json` |
| L4 | `<worktree>/opencode.jsonc` | yes | L1 / L2 / L3 | `L4-project-jsonc` |
| L5 | **`$OPENCODE_CONFIG_CONTENT`** | **yes** | **L1〜L4 すべて** | `L5-inline` |

対照（層を 2 つだけ立てた場合）も撃った: `L1+L2` → `L2-envfile` / `L1+L5` → `L5-inline` /
`L2+L5` → `L5-inline`。**#1908 の 4 層の順序はそのまま再現し、inline がその上に乗る。**
Issue 本文の「inline は project config より上位」は**正しい**（「precedence 6 位」という順位の
数え方だけは、この 5 層の数え方と一致しない）。

**マージは深い。** `permission.bash` のようなマップは層をまたいで**キー単位で合流**する
（`{"gl *","ev *","pj *","jc *","in *"}` が全部残る）。衝突したキーだけが上位層の値になる。

**解決後のルールは「層の順に並んだ平坦なリスト」で、後勝ち。**
拒否された tool call の `error` 文字列がそのリストを丸ごと吐くので、順序を直接読める:

```text
The user has specified a rule which prevents you from using this specific tool call.
Here are some of the relevant rules
[{"permission":"*","action":"allow","pattern":"*"},                    ← 組み込み既定
 {"permission":"bash","pattern":"*","action":"ask"},                   ← L3（利用者）
 {"permission":"bash","pattern":"rm -rf ./victim","action":"allow"},   ← L3（利用者）
 {"permission":"bash","pattern":"rm *","action":"deny"}]               ← L5（inline）
```

### 26.4 受入条件の実測: `deny` はダイアログを消す

対照を先に撃った。**対照が `permission.asked` を出せることを示さないと、注入後の 0 件は空振りと区別できない。**

| # | 層構成 | コマンド | `permission.asked` | tool part | `session.idle` | 結果 |
|---|---|---|---|---|---|---|
| A | 素（`permission` 無し） | `touch /tmp/…` | **1**（`permission: "external_directory"`） | `running` で停止 | **0** | 承認待ちで固着（§5.4 の再現） |
| B | inline `{"permission":{"external_directory":"deny"}}` | 同上 | **0** | `error` | **1**（3.9 秒後） | ダイアログ無しで拒否、ターン完走 |
| C0b | L3 `{"permission":{"bash":"ask"}}` | `rm -rf ./victim` | **1**（`permission: "bash"`、`patterns:["rm -rf ./victim"]`、`always:["rm *"]`） | `running` で停止 | **0** | 承認待ちで固着 |
| C1 | C0b ＋ inline `{"permission":{"bash":{"rm *":"deny"}}}` | 同上 | **0** | `error` | **1**（4.3 秒後） | **受入条件を満たす** |

- C1 の `error` 本文は
  `The user has specified a rule which prevents you from using this specific tool call.` で、
  **拒否理由がエージェントに届く**（§5.5.2 と同じ性質）。`./victim` は残っていた。
- **§5.5 の「タイムアウト無しで無限待ち」が消える。** 承認要求が発生しないので、
  CommandMate が黙っても止まらない。**Issue の狙いは実測として成立している。**
- 注意: A / B の承認種別は `bash` ではなく **`external_directory`** だった。
  Issue 本文の `bash: {"rm *": "deny"}` は**この種別には当たらない**。
  `permission` の種別は `read` / `edit` / `glob` / `grep` / `list` / `bash` / `task` /
  `external_directory` / `todowrite` / `question` / `webfetch` / `websearch` / `lsp` /
  `doom_loop` / `skill`（`GET /doc` の `PermissionConfig`）。**「危険な bash を止める」つもりで
  `bash` だけ書くと、実際に出るダイアログの多くを外す。**

### 26.5 論点 3: 利用者設定を黙って壊す 2 つの経路（実測）

Issue が「いちばん重要な判断」と書いた論点である。**壊れ方は 2 通りあり、両方とも実測した。**

#### 26.5.1 型が違うと層ごと消える（`ask` が `allow` に降格する）

利用者が `permission.bash` を**文字列**で書き、CommandMate が**オブジェクト**を注入すると、
深いマージは働かず**利用者の層が丸ごと置き換わる**。

| # | L3（利用者の `opencode.json`） | L5（inline） | 解決後の `permission` |
|---|---|---|---|
| F | `{"permission":{"bash":"ask"}}` | なし | `{"bash":"ask"}` |
| E | 同上 | `{"permission":{"bash":{"rm *":"deny"}}}` | **`{"bash":{"rm *":"deny"}}`** ← `"ask"` が消えた |

同じコマンド `echo hello-2053` を同じ層構成で撃った結果:

| # | `permission.asked` | 実行 | 意味 |
|---|---|---|---|
| F（対照） | **1**（`patterns:["echo hello-2053"]`） | されない（承認待ち） | 利用者の「全部訊いて」が効いている |
| E（注入後） | **0** | **された**（`exit 0` / `output: "hello-2053\n"`） | 利用者の「全部訊いて」が**消え、既定の `*: allow` に落ちた** |

**安全のための機能が、利用者の安全設定を黙って引き下げる。**
警告は出ない。`GET /config` は合流後の 1 個のオブジェクトしか返さないので、
**どのキーが CommandMate 由来かを利用者も CommandMate も後から言えない。**

#### 26.5.2 順序が具体性に勝つ（利用者の例外指定が広い glob に負ける）

両方がオブジェクトで、深いマージが正しく働いた場合でも壊れる。
[26.3](#263-precedence-4-層から-5-層へ実測) のとおりルールは**平坦なリストで後勝ち**なので、
**より具体的な利用者のルールが、より広い CommandMate のルールに負ける。**

| # | L3（利用者） | L5（inline） | コマンド | 結果 |
|---|---|---|---|---|
| D | `{"bash":{"*":"ask","rm -rf ./victim":"allow"}}` | `{"bash":{"rm *":"deny"}}` | `rm -rf ./victim` | **拒否**（`permission.asked` 0 件、`error`、`session.idle`） |

利用者は `rm -rf ./victim` を**完全一致で明示的に許可**していた。CommandMate の `rm *` が後に
並んだだけで、それが無効になる。**より下の層へ逃がすこともできない**:
CommandMate が持てる最下位は L2（`$OPENCODE_CONFIG`）だが、**L2 は利用者のマシン全体設定 L1 に勝つ**
（実測: `L1+L2` → `L2-envfile`）。しかも `$OPENCODE_CONFIG` は #1908 が
「操作者が設定を所有している証拠」として読む変数で、CommandMate が上書きする先ではない。

**#1908 との違い。** #1908 は「自分が書こうとしているファイルの隣に、操作者のファイルがあるか」を
`fs` で見て降りられた。ここで衝突するのは**ファイルではなく opencode のマージ結果**で、
CommandMate からは見えない。降りる判断を下せる場所が無い。

### 26.6 論点 2: stop-pattern との写像は存在しない

| 軸 | CommandMate の `stopPattern` / `denyPatterns` | opencode の `permission` ルール |
|---|---|---|
| 言語 | **JS `RegExp`**（`validateStopPattern` が safe-regex2 で ReDoS を弾く。`src/config/auto-yes-config.ts:101`） | **glob**（`rm *` / `*`） |
| 定義域 | `stopPattern` は **ANSI 除去済みのペイン全文**（`checkStopCondition`、`src/lib/auto-yes-state.ts:421`）。`denyPatterns` はプロンプトの表示テキスト群（`src/lib/polling/auto-yes-resolver.ts:175`） | **1 回の tool call の command 文字列**（`metadata.command`） |
| 効果 | `stopPattern` は**ラッチ**: そのインスタンスの Auto-Yes を丸ごと止め、`stop_pattern_matched` と一致箇所の抜粋を利用者に見せる。`denyPatterns` は「この 1 件を自動応答しない」＝**人間に返す** | **その 1 回を拒否してターンは続く**（26.4 の `error` → `session.idle`）。人間には何も返らない |
| 決まる時刻 | **`send` のたび**（`commandmate send --auto-yes --stop-pattern` / `POST /api/worktrees/:id/auto-yes`）。稼働中に切り替わる | **プロセス起動時**。`OPENCODE_CONFIG_CONTENT` は env なので再起動しないと変わらない |

正規表現から glob への変換は全域写像ではないし、変換できる部分集合でも**効果が変わる**
（人間に返していたものが、人間に見えない自動拒否になる）。
そして最後の行が決定的で、**起動時に固定される値に、`send` ごとに変わる値は載らない。**

**実行時に差し替える経路も無い**（両方測った）:

| endpoint | 実測 |
|---|---|
| `PATCH /config` | `200` で**リクエストボディをそのままエコーする**が、直後の `GET /config` は**変わらない**。ファイルも 1 つも書かれない（`work/opencode.json` と `~/.config/opencode/opencode.jsonc` の md5 が不変）。**無効** |
| `PATCH /global/config` | `200`。**即座に効く**（`GET /config` にルールが最下位で現れる）が、**`~/.config/opencode/opencode.jsonc` を書き換える**（md5 変化。1 行の JSONC が整形済み JSON 164 バイトに再出力され、**コメントが消える形式**）。これは #1908 が潰した破壊そのもので、しかもマシン全体 |

### 26.7 注入が壊れたときの失敗の出方

CommandMate が JSON を作る以上、壊れた JSON を渡す可能性が生まれる。その挙動を測った。

| 入力 | `opencode debug config` | `opencode serve` | TUI（`opencode --port`） |
|---|---|---|---|
| 壊れた JSON（`{not json`） | **exit 1**、パースエラー | **プロセスは生きる。`GET /global/health` は `{"healthy":true}` を返し続ける**が、`GET /path` も `GET /config` も **`ConfigJsonError`** | **起動を拒否してエラーを出し終了。exit status は 0。ポートは開かない** |
| schema 違反（`{"permission":{"bash":"nonsense"}}`） | **exit 1**（`Expected PermissionActionConfig`） | 同上と推定（未実測） | 未実測 |
| 未知のトップレベルキー | exit 0（**無警告で無視**） | — | — |
| 未知の `permission` 種別キー | exit 0（**無警告で無視**） | — | — |
| 空文字列 / `{}` | exit 0（未設定と同じ） | — | — |
| JSONC コメント / 末尾カンマ | exit 0（**受理される**。JSONC なので） | — | — |

2 つの含意がある。

1. **`prepareLaunch` の「throw しない＝ fail-open」規約では守れない。** 失敗するのは
   `prepareLaunch` ではなく**子プロセス**で、TUI は**ポートを開かずに消える**。
   `configScope: 'none'` の現状では CommandMate がこの故障を作ることが**構造的にできない**。
2. **`healthy` は嘘をつく。** `serve` 形態では `/global/health` だけが通り、
   #2054 が UI に繋いだ `liveness` / `probeActivity` は**「生きている」と報告する**一方で、
   セッション系は全滅する。**注入の失敗が、いちばん見えにくい形で出る。**

そして逆向きの静かな失敗もある: **種別キーの綴り間違いは無警告で無視される**ので、
注入したつもりのルールが 1 つも効いていない状態と、効いている状態が**外から区別できない**。
効いた証拠はどこにも出ない（唯一の証拠が「拒否された tool call の `error` 文字列」）。

### 26.8 計測していないこと

- **schema 違反 JSON での `serve` / TUI の挙動。** `debug config` の exit 1 は測ったが、
  サーバ形態・TUI 形態は撃っていない。壊れた JSON の 2 形態から**同じだろうと書かない。**
- **`permission` を `agent` ごとに上書きしたときの precedence。** Issue 本文が触れている
  per-agent 上書きは、採否の判断に効かないので測っていない。
- **`share:"disabled"` 下の `POST /share`。** #2051 が測った（コードを持たない HTTP 500）ものを
  再測していない。本節が測ったのは「inline 経由で `share` が `GET /config` に載る」ところまで。
- **1.18.21 以前での `OPENCODE_CONFIG_CONTENT` の有無。** 測ったのは 1.18.22 だけ。
  #1908 の 4 層表が 1.18.21 で 5 行目を持たなかったのが「機構が無かった」のか
  「測っていなかった」のかは**判らない**。

### 26.9 この節が変えたもの

- `docs/design/agent-event-source-interface.md` — §3.4（**裁定本体**）
- `src/lib/cli-tools/opencode-config.ts` — 冒頭 docblock の precedence 表を **4 行 → 5 行**に更新
- `src/lib/hooks/sources/opencode/source.ts` — `configScope: 'none'` の docblock に #2053 の裁定を追記
- `tests/unit/hooks/sources/opencode-config-scope-2053.test.ts` — 裁定の pin（**不採用も固定する**）
