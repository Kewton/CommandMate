# 子プロセス env から剥がす集合の定義（Issue #1996）

**位置づけ**: `docs/design/multi-agent-state-architecture.md` §10.7（資格情報・launch env / DR4-002・DR4-017）と §13.2 S8 の実装確定。#1942 が入れた `CM_HOOK_` prefix 判定の適用範囲を、実測に合わせて定義し直す。

---

## 1. 定義（1 文）

> **CommandMate のプロセスは、自分の子プロセスに「資格情報」も「自分を起動したエージェントの身元」も渡さない。**

`sanitizeEnvForChildProcess()` が剥がすのはこの 2 つだけであり、それ以外は残す。

| 半分 | 中身 | 何が守られるか |
|---|---|---|
| **資格情報** | `SENSITIVE_ENV_KEYS` | 子がこのサーバーとして振る舞う／DB を読むこと |
| **エージェントの身元** | `AGENT_CORRELATION_ENV_KEYS`（＝ launch line が持つ「どのサーバーへ・どのインスタンスとして報告するか」） | 子から発火した relay が、別のセッションの出来事として着弾すること |

**剥がさないもの**: per-tool の設定リダイレクト（`CODEX_HOME`）。「そのツールが自分の設定をどこから読むか」であって資格情報でも身元でもない。運用者自身の設定（`CM_PORT` / `CM_AGENT_HOOKS_INJECT` / `CM_AGENT_HOOKS_DIR` など）も同様に残す。

---

## 2. 実測（本 Issue でやり直したもの）

7 ソースの `prepareLaunch` を実際に組んで `env` を読み出した結果。grep ではなく実行結果である。

| tool | `plan.env` のキー |
|---|---|
| claude | （空。`--settings <path>` のみ） |
| codex | `CODEX_HOME` / `CM_AGENT_TOOL` / `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` / `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` |
| gemini | `CM_HOOK_URL` |
| vibe-local | （空。legacy-relay の bare command） |
| opencode | （空） |
| copilot | `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` / `CM_HOOK_PORT` |
| antigravity | `CM_HOOK_URL` / `CM_PERMISSION_HOOK_URL` |

**和集合 = 相関 6 個 ＋ 設定リダイレクト 1 個 = 7 個。** #1933 の報告（相関 6 個・うち `CM_HOOK_` は 2 個）は正しい。

### Issue 本文の下調べとの食い違い（実測を正とする）

- **`CM_AGENT_HOOKS_INJECT` / `CM_OPENCODE_PORT_FILE` / `CM_CODEX_HOOK_TRUST` / `CM_PORT` は launch line に載らない。** grep が拾うのは *読み出し*と*生成される設定ファイル内のリテラル*である。
  - `CM_AGENT_HOOKS_INJECT` — 運用者スイッチ。`copilot/hook-settings.ts` が `process.env` から読む。
  - `CM_OPENCODE_PORT_FILE` — port 割当ファイルの置き場所の上書き。`opencode/ports.ts` が読む。
  - `CM_CODEX_HOOK_TRUST` — `codex/hooks-config.ts` が読み、起動フラグ（`--dangerously-bypass-…`）を足すかどうかを決める。
  - `CM_PORT` — `codex/hooks-config.ts` が **生成する hooks.json の中に `${CM_PORT:-3000}` という文字列として**書く。エージェントのプロセス env で展開される。
- **`AGENT_LAUNCH_CONFIG_ENV_VARS` は `CODEX_HOME` の 1 個。** #1933 のテストが持っていたローカル allowlist は `CODEX_HOME` / `COPILOT_HOME` / `XDG_CONFIG_HOME` の 3 個だったが、後ろ 2 つは *読み出し*専用で `plan.env` には入らない。allowlist を広く取ると「あるソースがそれを書き始めた」変化を素通しするので、実測の 1 個に絞った。

### `CM_AUTH_TOKEN`（優先度高・実測で確認）

**渡っていた。** `SENSITIVE_ENV_KEYS` に在るのは `CM_AUTH_TOKEN_HASH` だけで、平文の `CM_AUTH_TOKEN` は無い。実際に環境変数を置いて `sanitizeEnvForChildProcess()` の env で子プロセスを起こすと、平文トークンが読み出せた（`{"tok":"PROBE-1996-PLAINTEXT","hash":null}`）。

- 変数がサーバーの env に居ることは**想定内**である。`src/cli/utils/api-client.ts` が `--token` より env var を勧める警告を出し、§10.7 が「hook 側がプロセス環境の継承から読む」と決めている。
- 経路は 5 つ: `session/claude-executor`（Assistant Chat の `claude -p`）、`lib/slash-command-catalog` の probe、`cli-tools/copilot-executable`、`detection/version-probes`、`assistant/non-interactive-runner`。**いずれも子に hook を設定していない**ので、剥がしても壊れない。
- `lib/slash-command-catalog` の docblock は既に「probe は CommandMate の auth token を third-party CLI に渡さない」と書いていた。実態が追いついた形。
- **エージェントの pane は影響を受けない。** tmux はサーバーの env をそのまま継承し、この関数を通らない（`src/lib/tmux/*.ts` に `env:` の上書きは無い）。hook 内の `$CM_AUTH_TOKEN` はこれまでどおり展開される。

---

## 3. なぜ「相関キーは全部」なのか（「hook の宛先だけ」を採らない理由）

#1942 が問題としたのは「相手は別サーバ、相関キーは他インスタンスのもの」。この失敗は**宛先**と**帰属**の 2 経路で独立に起きる。実測した 2 例:

1. **`CM_AGENT_TOOL` — 宛先が正しくなるぶん、むしろ悪い。**
   `scripts/hooks/cmate-agent-event.sh:131` は `TOOL="${CM_AGENT_TOOL:-claude}"` と env から読み、`:247` は `CM_HOOK_URL` が無いとき `http://127.0.0.1:${CM_PORT:-3000}/api/hooks/agent-event` に**フォールバックする**。`CM_HOOK_` だけ剥がすと、宛先は既定＝たいてい稼働中の本番サーバーになり、帰属だけが他インスタンスのまま残る。イベントは**着弾する**。
2. **`CM_PERMISSION_HOOK_URL` — 「CommandMate 起動かどうか」の判定そのもの。**
   生成される antigravity の `PreToolUse` コマンドは `[ -z "${CM_PERMISSION_HOOK_URL:-}" ]` でガードしている。`~/.gemini/config/hooks.json` は machine-global singleton（`configScope: 'global-singleton'`）なので、CommandMate の子プロセス配下で起動した agy は、**別インスタンスのサーバーに許可を尋ねて、その答えに従う**。

`CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` は copilot / codex の生成コマンドに `$`-参照として埋め込まれ、クエリパラメータになる。同じ帰属の誤りを起こす。

---

## 4. なぜ prefix を `CM_AGENT_` へ広げないのか

**`CM_AGENT_` は CommandMate の書き込み専用名前空間ではない。** `CM_HOOK_` prefix の根拠は `env-sanitizer.ts` が書いているとおり「ここに運用者の価値は無い」だが、その文は `CM_AGENT_` には成り立たない:

- `CM_AGENT_HOOKS_INJECT` — 運用者が hooks 注入を止めるスイッチ（`copilot/hook-settings.ts:898`）。
- `CM_AGENT_HOOKS_DIR` — 生成先ディレクトリの上書き（`hook-settings-generator.ts`）。

#1942 自身のテストがこの形を pin している（`CM_HOOKS_DIRECTORY_LOOKALIKE` は残る／「trailing underscore is load-bearing」）。さらに `CM_PERMISSION_HOOK_URL` はどの名前空間にも属さないので、**prefix 規則では原理的に集合を覆えない**。

### 検討して却下した別解: 4 個を `CM_HOOK_*` に改名する

prefix だけで済むようになるが、

- `CM_AGENT_TOOL` は同梱 relay の `--help` に載る**公開インターフェース**で、#1549 の手書き hook が依存する。`scripts/` は本 Issue の scope 外でもある。
- `~/.copilot/settings.json` と `~/.gemini/config/hooks.json` は**既にディスク上にある machine-global ファイル**で、旧名を持っている。改名すると、書き直されるまで既存セッションの相関が黙って切れる。

---

## 5. 採った形 — 列挙 ＋ prefix ＋ 実測 drift ガード

```
SENSITIVE_ENV_KEYS ∪ AGENT_CORRELATION_ENV_KEYS ∪ (key.startsWith('CM_HOOK_'))
```

prefix は**残す**。名前空間の内側では今も列挙より強い（来年生えた `CM_HOOK_*` は誰も気づかなくても落ちる）。列挙は名前空間の外側を覆う。

### import しない結合の維持

`lib/security` → `lib/hooks` の import は作らない（依存は既に hooks → security に流れており、逆流は 4 つの子プロセス起動器の下に循環を敷く）。よって `AGENT_CORRELATION_ENV_KEYS` は `lib/hooks/sources/launch-command` の `AGENT_CORRELATION_ENV_VARS` の**2 つ目のコピー**であり、結合はテストが持つ。#1942 が選んだ形をそのまま拡張した。

| ガード | 場所 | 何を捕まえるか |
|---|---|---|
| 実測 == 宣言（両方向の完全一致） | `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` | あるソースが launch line に**名前空間を問わず**新しい変数を書き始めた／宣言した変数を書かなくなった |
| 宣言 == sanitizer の列挙 | `tests/unit/security/child-process-agent-env-1996.test.ts` | 2 つのコピーが食い違った |
| 実際の子プロセスが読めない | 同上 | 関数の戻り値ではなく**実挙動**。陽性対照つき |
| `lib/security` が `lib/hooks` を import しない | `tests/unit/guards/security-no-hooks-import.test.ts` | 「重複リストを import で消す」編集。`import` / `export … from` / `await import()` / `require()` の 4 綴りすべて |

**prefix が失ったものは無い。** prefix は自分の名前空間の外側の名前を最初から一切覆っていなかった。実測 drift ガードはそれを覆う。

### 変異注入で確認したこと

| 変異 | 結果 |
|---|---|
| `CM_AGENT_INSTANCE_ID` / `CM_AGENT_TOOL` / `CM_AGENT_WORKTREE_ID` / `CM_PERMISSION_HOOK_URL` を列挙から 1 個ずつ落とす | 赤。実子プロセスがその名前だけを読み返す |
| `CM_HOOK_PORT` / `CM_HOOK_URL` を列挙から落とす ＋ prefix 節も落とす | 赤（prefix 節を残すと正しく捕まるので、両方外さないと変異にならない） |
| `CM_AUTH_TOKEN` を `SENSITIVE_ENV_KEYS` から落とす | 赤。実子プロセスの env ダンプに平文値が出る |
| 宣言から書かれている変数を落とす／書かれていない変数を宣言に足す／設定 allowlist を 3 個に戻す | 赤（drift ガード、両方向） |
| `lib/security` に `lib/hooks` の import を足す | 赤 |
