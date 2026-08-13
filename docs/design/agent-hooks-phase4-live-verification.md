# 実機検証: codex / copilot / gemini / antigravity hooks（Phase 4-0a スパイク）

- **Issue**: [#1757](https://github.com/Kewton/CommandMate/issues/1757)（親 Epic [#1720](https://github.com/Kewton/CommandMate/issues/1720)）
- **ステータス**: 実測完了（コード変更なし）
- **検証日**: 2026-08-13
- **対象**: codex-cli **0.147.0** / GitHub Copilot CLI **1.0.77**（途中で 1.0.79 に自動更新）/ Gemini CLI **0.42.0**（途中で 0.55.1 に自動更新）/ Antigravity CLI `agy` **1.1.7**（途中で 1.1.12 に自動更新）
- **プラットフォーム**: macOS (Darwin 25.6.0) / Apple Silicon
- **成果物**: 本書 ＋ [`tests/fixtures/hooks/{codex,copilot,gemini,antigravity}/*.json`](../../tests/fixtures/hooks/)
- **先行スパイク**: Claude Code 版 [`docs/design/agent-hooks-live-verification.md`](./agent-hooks-live-verification.md)（#1721）

> 本書は下流 Issue（#1759 / #1760 / #1761 / #1762）が仕様の根拠として引用することを前提に書かれている。
> **本書に書いてあるのは「公式ドキュメントの記述」ではなく「実際に動かして観測した結果」である。**
> ドキュメント（および Issue #1757 / Epic #1720 本文）と実測が食い違った箇所は [§2](#2-ドキュメントepic-本文と実測の食い違い) にまとめた。

---

## 1. 結論サマリ — 4 ツール × 検証項目 10 マトリクス

**セルはすべて実測結果。**「未計測」には理由を併記した。詳細は各ツールの節へ。

| # | 検証項目 | **codex 0.147.0** | **copilot 1.0.77** | **gemini 0.42.0 / 0.55.1** | **antigravity (agy) 1.1.7** |
|---|---|---|---|---|---|
| **1** | hooks 機構の実在 | **Yes**（`features list` に `hooks stable true`。7 イベント実発火） | **Yes**（`copilot help config` に `hooks` / `disableAllHooks`。6 イベント実発火）**← Issue の「無いかもしれない」は誤り** | **Yes**（`gemini hooks migrate --from-claude` 実在。5 イベント実発火） | **Yes**（バイナリ同梱の公式 doc `agy-customizations/docs/hooks.md`。6 イベント実発火） |
| **2** | 設定ファイルの場所と形 | `$CODEX_HOME/hooks.json` ＋ **project-local `<cwd>/.codex/hooks.json`**（両方実発火）。session 限定注入は `CODEX_HOME` env のみ（`--settings` 相当は無い）。`hooks.managed_dir` は 2 レイアウトとも無効果 | **`~/.copilot/settings.json` の `hooks` キー**。`copilot help config` は「global config.json」と書くが、**実際は config.json から settings.json へ自動移送され config.json は機械管理に戻される**。session 限定注入は `COPILOT_HOME` env のみ | `settings.json` の `hooks` キー。**Workspace スコープ `<worktree>/.gemini/settings.json` が使える**（`gemini hooks migrate` の書き込み先）。user スコープは `$GEMINI_CLI_HOME/.gemini/settings.json` | **`~/.gemini/config/hooks.json`（グローバルのみ）**。doc は workspace `.agents/hooks.json` と書くが**実測では読まれない**。session 限定注入手段は無く、`HOME` 差し替えしかない |
| **3** | ユーザー設定の非汚染 | **証明済み**（`CODEX_HOME` 隔離。`~/.codex/config.toml` は diff 空・sha256 一致。`notify` 行は読み取りのみ） | **証明済み**（`COPILOT_HOME` 隔離。`~/.copilot/{config,settings}.json` は diff 空・sha256 一致） | **証明済み**（`GEMINI_CLI_HOME` 隔離。`~/.gemini/settings.json` は diff 空・sha256 一致） | **証明済み**（`HOME` 差し替え＋APFS clone。`~/.gemini/antigravity-cli/settings.json` / `antigravity_state.pbtxt` diff 空）。ただし**認証は login keychain にあり `~/Library/Keychains` の symlink が要る** |
| **4** | trust / 承認プロンプト | **あり・ブロックする**。TUI 起動時に「Hooks need review / 7 hooks are new or changed」の 3 択。**`codex exec` では未 trust hooks が完全に無言で skip される**。trust は `config.toml` の `[hooks.state."<path>:<event>:i:j"] trusted_hash` に永続化 | **hooks 専用の承認は出なかった**（`-p` 非対話）。フォルダ trust は `trustedFolders`。TUI での挙動は未計測 | **フォルダ trust ダイアログが hooks 発火をブロック**（文面が hooks を明記）。trust 後に**全 hook コマンドを列挙する開示バナー**が出る（承認は求めない）。trust store は `trusted_hooks.json` | **hook 専用の trust は無し**。hooks はグローバル root から読まれるため workspace trust の影響を受けない |
| **5** | 配信方式 | **command / prompt / agent。http 無し**。`type:"http"` を書くと `unknown variant 'http'` で **hooks.json 全体が捨てられる** | **command のみ**（`type:"http"` は無言で発火せず） | **command**（`migrate` が写すのは `type`/`command`/`timeout` のみ）。http は未検証 | **command のみ**（doc 明記: *no HTTP or prompt hooks yet*）。**同期実行でエージェントループをブロックする** |
| **6** | timeout 挙動 | **fail-open**。既定 600s（レビュー画面表示）。`timeout: 2` ＋ 8s 遅延 → `hook: UserPromptSubmit Failed` だがターンは正常完了 | **fail-open**。既定は実測 **≈10s**（PreToolUse→PostToolUse 間隔 10.05s／12s 遅延時）。`timeout: 3` で 5.1s。遅延した `deny` は捨てられツールが走る | **未計測**（認証不能でツール実行ターンを成立させられず。[§5.3.6](#536-gemini-検証項目-6--7--10--未計測とその理由)） | **fail-open**。`timeout: 3` ＋ 12s 遅延で、遅延して届く `deny` は捨てられツールが実行された |
| **7** | 承認裁定の可否 | **可**。`{}` → **TUI 承認ダイアログにフォールバック（fail-safe）**。`decision.behavior=allow` → ダイアログ無しで実行。`deny` → `• PermissionRequest hook (blocked)` ＋ `feedback: <message>` | **可**。Claude 互換の `hookSpecificOutput.permissionDecision`。`deny` → `Denied by preToolUse hook: <reason>`。**`{}` → 通常の許可フローへフォールバック（fail-safe）** | **未計測**（同上）。語彙上の候補は `BeforeTool`。`PermissionRequest` 相当のイベントは存在しない | **可。ただし no-decision が fail-CLOSED。** `{"decision":"deny"}` で拒否、`"allow"` で実行。**`{}`（`decision` 欠落）を返すと全ツール呼び出しが拒否される**（hooks 無しの対照実験で裏取り済み） |
| **8** | 実 payload 採取 | 7 件（[`tests/fixtures/hooks/codex/`](../../tests/fixtures/hooks/codex/)）。Claude 互換 snake_case ＋ `hook_event_name`。`prompt_id` ではなく **`turn_id`**。**`notification` に相当するイベントが無い** | 6 件（[`copilot/`](../../tests/fixtures/hooks/copilot/)）。**4 ツール中もっとも Claude に近い**。`hook_event_name` ＋ `timestamp`。`Notification` は非対話では未発火 | 5 件（[`gemini/`](../../tests/fixtures/hooks/gemini/)）。イベント名が独自（`BeforeTool`/`AfterTool`/`BeforeAgent`/`AfterAgent`/`BeforeModel`/`AfterModel`/`PreCompress`）。ツール名もリマップ（`Bash→run_shell_command`） | 6 件（[`antigravity/`](../../tests/fixtures/hooks/antigravity/)）。**camelCase(protojson)**。**`hook_event_name` に相当するフィールドが存在しない**。**`workspacePaths` が空**で cwd も無い |
| **9** | インスタンス相関 | hook プロセスは**親の環境をそのまま継承するだけ**で codex 固有の env 注入は無い（86 変数すべて呼び出し元由来）。→ **`hooks.json` のコマンド引数**か、codex プロセスに渡す env で焼き込む。payload には `session_id` + `turn_id` | **`COPILOT_CLI` / `COPILOT_CLI_BINARY_VERSION` / `COPILOT_HOME` / `COPILOT_PROJECT_DIR` を注入する**（4 ツール中これだけ）。コマンド引数も併用可 | コマンド引数は機能（タグで確認）。env 注入は未計測。workspace スコープの settings.json 自体が worktree 単位なので**ファイルの場所で相関が取れる** | **コマンド引数しか手段が無い。** payload に cwd も workspace も無く（`workspacePaths: []`）、設定はグローバル 1 本のみ |
| **10** | hooks が発火しない UI | directory trust ダイアログ / 「Hooks need review」ダイアログ / hooks レビュー詳細画面 / `/model` overlay（受信 31→31）。**さらに `SessionStart` はプロセス起動時に来ない**（TUI 起動 08:05:15 → SessionStart 08:06:23、`UserPromptSubmit` の 21ms 前）。**kill されたときは `SessionEnd` が出ない**（`/quit` では出る） | TUI 未計測（非対話 `-p` のみで検証）。非対話では `Notification` が一度も発火しない | フォルダ trust ダイアログ（応答するまで 0 件）／認証方式ピッカー。**`SessionStart` は認証ピッカーより前に発火する** | 非対話のみ。**session/prompt 系イベントが存在しないため、CLI の画面状態は hooks からは一切見えない** |

### 1.1 横展開 Issue の取り下げ提案 — **該当なし（4 ツールすべてに hooks が実在する）**

Issue #1757 は「項目 1 が No なら取り下げ提案を書くこと」と指示しているが、**実測では 4 ツールすべてで hooks が実在し実発火した**。
したがって #1761（copilot）・#1762（gemini / antigravity）とも**取り下げは提案しない**。代わりに、前提の訂正としてスコープ修正を提案する。

| Issue | 提案 | 根拠 |
|---|---|---|
| **#1761（copilot）** | **取り下げない。** ただし前提を差し替えること。「hooks が実在するか調べる」ではなく「**Claude 実装をほぼそのまま移植できる**」が正しい出発点。設定の書き先を `~/.copilot/settings.json` とし、`config.json` に書くと機械管理で消される点だけ注意 | [§5.2](#52-copilot-1077--10079) |
| **#1762（gemini）** | **取り下げない。** ただし**イベント名変換表とツール名変換表**（[§5.3.1](#531-gemini-イベント語彙とツール名の変換表)）を仕様に取り込むこと。`worktree/.gemini/settings.json` が使えるので注入は 4 ツール中もっとも素直 | [§5.3](#53-gemini-0420--0551) |
| **#1762（antigravity）** | **取り下げない。** ただし**「他ツールと同じ抽象に載らない」前提で設計すること**。イベント種別が payload に無い・worktree 特定情報が無い・設定がグローバル 1 本・no-decision が fail-closed の 4 点が他 3 ツールと決定的に違う | [§5.4](#54-antigravity-agy-117--1112) |

### 1.2 下流 Issue が特に依拠すべき結論

| 結論 | 影響する Issue |
|---|---|
| **`type:"http"` は 4 ツールすべてで使えない。** Claude だけの機能。**中継スクリプト（`type:"command"`）が全ツールで必須** | #1759 / #1760 / #1761 / #1762 |
| **Auto-Yes v2 の「黙れば安全」は agy では成立しない。** codex / copilot は空応答で通常の承認フローに戻る（fail-safe）が、**agy は空応答を「拒否」と解釈してツールを全部止める** | #1762（最重要） |
| **timeout はどのツールも fail-open。** CommandMate サーバが落ちてもエージェントは止まらない。ただし copilot の既定は **≈10s** と短く、Claude の 600s 感覚で組むと裁定が届かない | #1759 / #1761 |
| **codex は hook trust をユーザーの `config.toml` に書く。** ユーザー設定を汚さずに hooks を有効化する経路は `--dangerously-bypass-hook-trust`（invocation 限定）か `CODEX_HOME` 差し替えしかない | #1760 |
| **codex の `SessionStart` は「起動した」ではなく「最初のターンが始まった」。** hooks 到着を起動完了 signal にすると永久に待つ | #1760 |
| **copilot は `UserPromptSubmit` → `SessionStart` の順で発火する。** イベント順序に依存した状態機械を書いてはいけない | #1761 |
| **agy の payload にはイベント名も cwd も無い。** 受け口の URL / コマンド引数にイベント種別と worktree ID を焼き込む以外に手段が無い | #1759 / #1762 |
| **`notification` に対応するイベントは codex / agy に存在しない。** 4 ツールで揃う語は `stop` / `session_start` / `pre_tool_use` / `post_tool_use` だけ（[§8.1](#81-agent_event_types-7-語-×-4-ツールの対応表)） | #1759 |
| **`scripts/hooks/cmate-agent-event.sh` は 4 ツールすべてに対して語彙不足。** `--event` は 5 語しか受けず、`map_event_name` は `PreToolUse`/`PostToolUse` も gemini/agy の語も知らない | #1759（修正担当） |

---

## 2. ドキュメント／Epic 本文と実測の食い違い

**本 Issue の最重要成果物。** 下流実装者は下表を先に読むこと。

| # | ドキュメント / Issue #1757・Epic #1720 本文の記述 | 実測 | 影響 |
|---|---|---|---|
| **P1** | Issue #1757: 「`copilot --help`（271 行）に "hook" の語が 1 つも無い。**hooks 機構が 1.0.77 に実在するかどうか自体**が未確認。無ければ Phase 4-3 は取り下げ判断」 | **実在する。** `copilot help config` が `hooks` と `disableAllHooks` を明記し、`copilot plugin --help` は「Plugins extend Copilot CLI with additional skills, agents, **hooks**, MCP servers, and LSP servers」と書く。実際に 6 イベントが発火し、**payload は 4 ツール中もっとも Claude Code に近い** | **#1761 は取り下げるどころか、4 ツール中いちばん実装コストが低い。** 前提が逆転しているので Issue 本文の差し替えが要る |
| **P2** | `copilot help config`: 「`hooks`: inline hook definitions… **In global config.json** these act as user-level hooks」 | **config.json に書いても、copilot が起動時に `hooks` を `settings.json` へ移送し config.json を機械管理形式で書き戻す**（先頭に `// User settings belong in settings.json. // This file is managed automatically.`）。書き先は **`~/.copilot/settings.json`** が正 | #1761 が config.json に書くと**次回起動で設定が消える**。settings.json に書くこと |
| **P3** | codex hooks reference（TUI レビュー画面の説明）: handler type の制限に触れていない | **`type:"http"` は `unknown variant 'http', expected one of 'command', 'prompt', 'agent'` で弾かれ、しかも `hooks.json` 全体が捨てられて全イベントが死ぬ。**警告は stderr に 1 行だけで、TUI には出ない | #1760 が 1 イベントだけ http にしただけで**全 hooks が無言で止まる**。設定生成器は http を出力してはならない |
| **P4** | （記載なし） | **codex は未 trust の hooks を `codex exec` で完全に無言で skip する。** stderr にも stdout にもログにも何も出ない（実測: 同じ hooks.json で `--dangerously-bypass-hook-trust` を付けた時だけ 4 件到着、付けないと 0 件・出力差分ゼロ） | **#1760 の最大の罠。**「設定は通るのにイベントだけ来ない」型の無言失敗。Claude の D1 と同型 |
| **P5** | （記載なし） | **codex の hook trust はユーザーの `~/.codex/config.toml` に書き込まれる**（`[hooks.state."<hooks.json パス>:<event>:0:0"] trusted_hash = "sha256:…"`） | #1760 が「ユーザー設定を汚さない」を守るなら、**trust を取る道は `--dangerously-bypass-hook-trust`（invocation 限定）か `CODEX_HOME` 差し替えのどちらか**しかない |
| **P6** | Epic #1720 / 一般的な想定: `SessionStart` はセッション起動時に発火する | **codex の `SessionStart` は最初のターン送信時に発火する**（TUI プロセス起動 08:05:15、trust 応答 ≈08:06:05、`SessionStart` 08:06:23.616、`UserPromptSubmit` 08:06:23.637 = **21ms 差**）。**copilot は `UserPromptSubmit` のほうが `SessionStart` より先**（20.813Z vs 20.915Z） | #1760 / #1761 は「session_start が最初に来る」を仮定してはいけない。起動完了の signal にも使えない |
| **P7** | Issue #1757: 「gemini は `gemini hooks <command>` 実在。サブコマンドは `migrate` のみ（Epic の `--from-claude` フラグは未確認）」 | **`--from-claude` は実在する**（`gemini hooks migrate --help` に明記）。実装を読むと `.claude/settings.json` → **workspace の `.gemini/settings.json`** へ、イベント名とツール名を変換して書き出す。変換表は [§5.3.1](#531-gemini-イベント語彙とツール名の変換表) | #1762 は変換表を自前で持つ必要がある。CLI 実装と同じ表を使えば整合する |
| **P8** | agy 公式 doc（`agy-customizations/docs/hooks.md`）: 「Hooks are configured in a single `hooks.json` file placed in your customization root directory (e.g., `.agents/hooks.json`)」＋「Workspace Customizations: `.agents/` at the root of your project」 | **CLI (`agy --print`) では workspace の `.agents/hooks.json` は読まれなかった**（`.git` あり・workspace を `trustedWorkspaces` に登録済みでも `loaded 0 named hooks from 0 hooks.json file(s)`）。実際に読まれたのは **`~/.gemini/config/hooks.json`**（および `~/.gemini/antigravity-cli/hooks.json`）。読み込まれるファイルは常に **1 本だけ** | **#1762 は agy の hooks を worktree 単位で出し分けられない。** グローバル 1 本の hooks.json を CommandMate が占有するか、`HOME` ごと差し替えるかの二択 |
| **P9** | agy 公式 doc: 「Supported Event Types」は `PreToolUse` / `PostToolUse` / `PreInvocation` / `PostInvocation` / `Stop` の 5 種 | **`SessionStart` も実際に発火する**（doc に記載なし。バイナリには `SessionStartHookArgs` / `SessionStartHookResult` の proto が実在）。一方 `SessionEnd` / `Notification` / `UserPromptSubmit` は書いても一度も発火しない | #1762 は `SessionStart` を使ってよいが、**未文書化なのでバージョン間で消える可能性を前提にすること** |
| **P10** | agy 公式 doc: PreToolUse の `decision` は **required** | **required を守らないと fail-CLOSED。** `{}` を返すと `run_command` / `list_dir` / `search_web` すべてが拒否される（hooks 無しの対照実験では同じプロンプトが正常実行）。一方 **timeout でハンドラが応答しなかった場合は fail-OPEN**（ツールが走る） | **Auto-Yes v2 の安全側フォールバックが agy では逆に働く。**「判断できないときは空応答」は agy ではエージェントを全停止させる。**無応答（timeout）と空応答（`{}`）で挙動が真逆**である点に注意 |
| **P11** | Issue #1757: 「antigravity のバイナリ名は `agy`。`~/.gemini/antigravity` / `~/.gemini/antigravity-cli` が実在＝gemini の config ツリーを共有」 | **config ツリーの共有は事実だが、認証は共有していない。** agy の資格情報は macOS login keychain（service `gemini` / account `antigravity`）にあり、`HOME` を差し替えると keychain 参照が壊れて OAuth ログインを要求される。`~/Library/Keychains` の symlink で解決した | 隔離ハーネスを書く人向け。#1762 の E2E にも効く |
| **P12** | Epic #1720 の外部 CLI 表: gemini 0.42.0 / copilot 1.0.77 / agy 1.1.7 | **3 ツールとも検証中に自身の auto-update で版が上がった**（gemini 0.42.0→0.55.1、copilot 1.0.77→1.0.79、agy 1.1.7→1.1.12）。agy は `AGY_CLI_DISABLE_AUTO_UPDATE=1` を付けても更新された | **版を固定した検証は現実的でない。** #1759〜#1762 は payload パーサを「未知フィールドは無視」で組むこと。詳細は [§6.2](#62-検証中に発生した本体の自動更新報告) |

---

## 3. 再現環境（ハーネス）

すべての実測は**ツールごとの隔離ホーム**と**専用 tmux socket**の中で行った。

### 3.1 リクエストダンプサーバ

hook の受け側。**稼働中の本番サーバ（port 3000）には 1 件も送っていない**（`stop` が `applyTaskEvent` まで走り本番 DB の `task_events` に書かれるため）。
`ctrl/<tag>.response` / `.delay` / `.status` を置くだけで応答内容・遅延・ステータスを差し替えられる。#1721 の [§3.2](./agent-hooks-live-verification.md) と同じものを使った（`epoch` フィールドを追加）。

```bash
SP=/path/to/scratchpad
mkdir -p "$SP"/{dumps,ctrl,logs,work}
nohup python3 "$SP/dumpserver.py" 8791 > "$SP/logs/server.out" 2>&1 &
curl -sS http://127.0.0.1:8791/ping     # => ok
```

`type:"command"` 側は stdin の payload をそのまま中継し、**ダンプサーバの応答を stdout にそのまま流す**シムを使う
（これにより ctrl ファイルだけで decision を差し替えられる）。

```bash
cat > "$SP/hookpost.sh" <<'SH'
#!/usr/bin/env bash
set -u
TAG="${1:-cmd}"
BODY="$(cat)"
printf '%s' "$BODY" | curl -sS -m 10 -X POST -H 'Content-Type: application/json' \
  --data-binary @- "http://127.0.0.1:8791/hook/${TAG}" 2>/dev/null
exit 0
SH
chmod +x "$SP/hookpost.sh"
```

環境変数の観測（項目 9）には、payload の代わりに `os.environ` を POST する `envprobe.sh` を使った。

### 3.2 ツールごとの隔離

| ツール | 隔離手段 | 認証の持ち込み | 備考 |
|---|---|---|---|
| **codex** | `CODEX_HOME=$SP/codexhome` | `~/.codex/auth.json` を mode 600 でコピー | `config.toml` は最小構成を自前で書く。**ユーザーの `notify`（Computer Use）行は持ち込まない** |
| **copilot** | `COPILOT_HOME=$SP/copilothome` | `COPILOT_GITHUB_TOKEN="$(gh auth token)"` | `trustedFolders` を事前に seed しておく |
| **gemini** | `GEMINI_CLI_HOME=$SP/geminihome`（実体は `$GH/.gemini/` を読む） | `oauth_creds.json` / `google_accounts.json` / `installation_id` をコピー | 認証は**この環境では通らない**（[§5.3](#53-gemini-0420--0551)） |
| **agy** | `HOME=$SP/agyhome` ＋ `cp -Rc ~/.gemini` (APFS clone, 0.7s) ＋ `cp -Rc ~/Library/Application\ Support/Antigravity` | **`ln -sfn ~/Library/Keychains "$AH/Library/Keychains"`**（これが無いと OAuth ログインを要求される） | `--app_data_dir` 相当の公開フラグは無い |

### 3.3 tmux の隔離（必読）

エージェントは tmux ペインの中で動いており `$TMUX` はユーザーの本番サーバを指している。
tmux の解決順は **`-L` / `-S` > `$TMUX` > `TMUX_TMPDIR`** なので、**`TMUX_TMPDIR` では隔離できない**。

```bash
tmux -L cmate-p4spike new-session -d -s cx1 -x 200 -y 50 -c "$SP/work/codex" \
  "env CODEX_HOME='$CH' TERM=xterm-256color codex"
tmux -L cmate-p4spike capture-pane -p -t '=cx1:0.0'
tmux -L cmate-p4spike kill-session -t '=cx1:'      # 完全一致ターゲット
```

- **`kill-server` は書かない。** 専用 socket なら最後の session 終了でサーバも自然終了する（実測: 検証後 `no server running on /private/tmp/tmux-501/cmate-p4spike`）。
- `bind-key` / `unbind-key` / `set-option -g` を既定サーバへ撃たない。
- 検証後、既定 socket 上のユーザーセッション 11 本（`mcbd-*`）は全て健在であることを `tmux list-sessions` で確認済み。

---

## 4. 観測に使った設定ファイル

<details>
<summary>codex <code>$CODEX_HOME/hooks.json</code></summary>

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-session-start" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-session-end" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-user-prompt-submit" } ] } ],
    "PreToolUse":       [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-pre-tool-use" } ] } ],
    "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-post-tool-use" } ] } ],
    "PermissionRequest":[ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-permission-request" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-stop" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cx-notification" } ] } ]
  }
}
```

`Notification` は **無言で捨てられる**（TUI が「7 hooks are new or changed」と数える＝8 件中 7 件しか認識していない）。
</details>

<details>
<summary>copilot <code>$COPILOT_HOME/settings.json</code></summary>

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-session-start" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-session-end" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-user-prompt-submit" } ] } ],
    "PreToolUse":       [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-pre-tool-use", "timeout": 3 } ] } ],
    "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-post-tool-use" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-stop" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh cp-notification" } ] } ]
  }
}
```

`{ "hooks": [ … ] }` でくるむ形と、ハンドラを直接並べる flat 形の**両方が受理される**（両方から実際にリクエストが届いた）。
</details>

<details>
<summary>gemini <code>&lt;workspace&gt;/.gemini/settings.json</code></summary>

```json
{
  "hooks": {
    "SessionStart":  [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-session-start" } ] } ],
    "SessionEnd":    [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-session-end" } ] } ],
    "BeforeAgent":   [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-before-agent" } ] } ],
    "AfterAgent":    [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-after-agent" } ] } ],
    "BeforeTool":    [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-before-tool" } ] } ],
    "AfterTool":     [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-after-tool" } ] } ],
    "BeforeModel":   [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-before-model" } ] } ],
    "AfterModel":    [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-after-model" } ] } ],
    "Notification":  [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-notification" } ] } ],
    "PreCompress":   [ { "hooks": [ { "type": "command", "command": "$SP/hookpost.sh gm-pre-compress" } ] } ]
  }
}
```
</details>

<details>
<summary>antigravity <code>~/.gemini/config/hooks.json</code>（トップレベルは「名前付き hook」のマップ）</summary>

```json
{
  "cmate-probe": {
    "PreToolUse":     [ { "matcher": "*", "hooks": [ { "type": "command", "command": "$SP/hookpost.sh ag-pre-tool-use", "timeout": 20 } ] } ],
    "PostToolUse":    [ { "matcher": "*", "hooks": [ { "type": "command", "command": "$SP/hookpost.sh ag-post-tool-use", "timeout": 20 } ] } ],
    "PreInvocation":  [ { "type": "command", "command": "$SP/hookpost.sh ag-pre-invocation", "timeout": 20 } ],
    "PostInvocation": [ { "type": "command", "command": "$SP/hookpost.sh ag-post-invocation", "timeout": 20 } ],
    "Stop":           [ { "type": "command", "command": "$SP/hookpost.sh ag-stop", "timeout": 20 } ]
  },
  "cmate-undocumented-probe": {
    "SessionStart":     [ { "type": "command", "command": "$SP/hookpost.sh ag-session-start" } ],
    "SessionEnd":       [ { "type": "command", "command": "$SP/hookpost.sh ag-session-end" } ],
    "Notification":     [ { "type": "command", "command": "$SP/hookpost.sh ag-notification" } ],
    "UserPromptSubmit": [ { "type": "command", "command": "$SP/hookpost.sh ag-user-prompt-submit" } ]
  }
}
```

`PreToolUse`/`PostToolUse` は `matcher` + `hooks` の grouped 形、それ以外は flat 形（doc の指定どおり）。
`SessionStart` だけが未文書化イベントとして発火し、他 3 つは発火しなかった。
</details>

---

## 5. ツール別の実測

### 5.1 codex 0.147.0

#### 5.1.1 codex 検証項目 1 — hooks 機構の実在

```bash
codex features list | grep -i hook
# => hooks         stable   true
# => plugin_hooks  removed  false
```

TUI の hooks 画面（`Hooks need review` → `1. Review hooks`）が**サポートするイベントを列挙する**。実測の全文:

```
  Event                 Installed   Active      Review      Description
  PreToolUse            1           0           1           Before a tool executes
  PermissionRequest     1           0           1           When permission is requested
  PostToolUse           1           0           1           After a tool executes
  PreCompact            0           0           0           Before context compaction
  PostCompact           0           0           0           After context compaction
  SessionStart          1           0           1           When a new session starts
  SessionEnd            1           0           1           Right before a session ends
  UserPromptSubmit      1           0           1           When the user submits a prompt
  SubagentStart         0           0           0           When a subagent is created
  SubagentStop          0           0           0           Right before a subagent ends its turn
  Stop                  1           0           1           Right before Codex ends its turn
```

→ **サポートは 11 イベント。`Notification` は存在しない。** `hooks.json` に書いた 8 件のうち 7 件しか `Installed` に数えられていないのがその証拠。

#### 5.1.2 codex 検証項目 2 — 設定ファイルの場所と形

- **`$CODEX_HOME/hooks.json`**（既定 `~/.codex/hooks.json`）— 実発火を確認。
- **project-local `<cwd>/.codex/hooks.json`** — 実発火を確認（user 側 hooks.json を退避した状態で `cx-projectlocal-ups` が到着）。
- `hooks.managed_dir` は config キーとして実在するが、`-c hooks.managed_dir="<dir>"` に `<dir>/hooks.json` / `<dir>/hooks/hooks.json` のどちらを置いても**発火しなかった**（`--dangerously-bypass-hook-trust` 併用でも）。注入点としては使えない。
- **`--settings` 相当のセッション限定注入フラグは無い。** 使える手は 2 つ:
  1. `CODEX_HOME` を差し替える（auth.json ごと持ち回る必要がある）
  2. worktree に `.codex/hooks.json` を置き、`--dangerously-bypass-hook-trust` で起動する
- 形式は Claude 互換（`{"hooks": {"<Event>": [{"hooks": [{"type": "command", "command": "..."}]}]}}`）。

#### 5.1.3 codex 検証項目 4 — trust（**最大の罠**）

TUI 起動直後に出る:

```
 Hooks need review
 7 hooks are new or changed.
 Hooks can run outside the sandbox after you trust them.

› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

 Press enter to confirm or esc to go back
```

個別の詳細画面には source / command / timeout / trust 状態が出る:

```
  [!] Hook 1 · new
  Event     PreToolUse
  Source    User config - <CODEX_HOME>/hooks.json
  Command   <SP>/hookpost.sh cx-pre-tool-use
  Timeout   600s
  Trust     New hook - review required
```

`t` で trust すると、**ユーザーの `config.toml` に書き込まれる**:

```toml
[hooks.state."<CODEX_HOME>/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:a896a2b42f73d75c10963db3aebf884bfc117fe11f7054284753ad93038fca80"
[hooks.state."<CODEX_HOME>/hooks.json:permission_request:0:0"]
trusted_hash = "sha256:a166e3b2e392c4c0c1e984124dd7ab90039e937a6081ff16dd4daf8f7d5c9a6f"
…（イベントごとに 1 エントリ、計 7 件）
```

キーのイベント名は **snake_case**（`pre_tool_use` / `permission_request` / `post_tool_use` / `session_start` / `session_end` / `user_prompt_submit` / `stop`）。

**`codex exec`（非対話）では未 trust hooks が完全に無言で skip される。** 同一 hooks.json での対照実験:

```bash
# trust 無し
CODEX_HOME="$CH" codex exec --skip-git-repo-check "Reply with exactly: PONG-CX-NOTRUST" < /dev/null
# => PONG-CX-NOTRUST / stderr・stdout ともに hook に関する記述ゼロ / ダンプサーバ受信 0 件

# trust バイパス
CODEX_HOME="$CH" codex exec --skip-git-repo-check --dangerously-bypass-hook-trust "Reply with exactly: PONG-CX2" < /dev/null
# => warning: `--dangerously-bypass-hook-trust` is enabled. …
# => hook: SessionStart / UserPromptSubmit / Stop（＋SessionEnd）が到着
```

#### 5.1.4 codex 検証項目 5 — 配信方式（**http は hooks.json 全体を壊す**）

```bash
# hooks.json の UserPromptSubmit に { "type": "http", "url": "…" } を 1 つ足しただけ
RUST_LOG=codex_hooks=trace CODEX_HOME="$CH" codex exec … 2>err.log
grep -i hook err.log
# => warning: failed to parse hooks config <CODEX_HOME>/hooks.json:
#    unknown variant `http`, expected one of `command`, `prompt`, `agent` at line 5 column 55
# ダンプサーバ受信 0 件（http だけでなく command hooks も全部死ぬ）
```

**警告は stderr の 1 行のみ。TUI には出ない。**

#### 5.1.5 codex 検証項目 6 — timeout（fail-open）

`"timeout": 2` を付けた `UserPromptSubmit` hook に対し、ダンプサーバの応答を 8 秒遅延させた。

```
hook: SessionStart
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit Failed      ← 打ち切り
PONG-CX-TIMEOUT                    ← ターンは正常完了
hook: Stop
hook: Stop Completed
```

- セッション全体の所要は **5.90 秒**（8 秒待っていない）。`UserPromptSubmit` → `Stop` の間隔は 3.36 秒。
- **`timeout` の単位は秒**（レビュー画面の既定表示も `600s`）。
- **timeout しても `Failed` になるだけでセッションは進む＝ fail-open。**

#### 5.1.6 codex 検証項目 7 — 承認裁定（`{}` は TUI にフォールバック）

`sandbox_mode = "read-only"` / `approval_policy = "on-request"` の TUI で、workspace 内へのファイル作成を指示した。

| ダンプサーバの応答 | 結果 | 画面 |
|---|---|---|
| `{}` | **TUI 承認ダイアログが出る**（fail-safe） | `Would you like to run the following command?` / `1. Yes, proceed (y)` / `2. Yes, and don't ask again…` / `3. No, and tell Codex what to do differently (esc)` |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | **ダイアログ無しで実行**。ファイルが作られた | `• Ran touch ./cx-allow-marker.txt` |
| `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"denied by CommandMate p4 spike hook"}}}` | **拒否**。ファイルは作られなかった | `• PermissionRequest hook (blocked)` / `  feedback: denied by CommandMate p4 spike hook` |

- `deny` の `message` は**そのままエージェントに見える**（エージェントは「hook に拒否された」と正しく報告した）。
- `• PermissionRequest hook (blocked)` は TUI 上の固定文字列で、**scraper 側の裏取りアンカーに使える**。
- 発火順は **`PreToolUse` → `PermissionRequest`**（08:08:34.690 → 08:08:34.713）。

#### 5.1.7 codex 検証項目 9 — インスタンス相関

`SessionStart` hook を `envprobe.sh` に差し替えて `os.environ` を採取した結果、**86 変数すべてが呼び出し元シェル由来**で、codex が注入した変数は `CODEX_HOME` / `CODEX_MANAGED_BY_NPM` / `CODEX_MANAGED_PACKAGE_ROOT`（＝起動時に既に存在していたもの）のみ。
**Claude の `CLAUDE_PROJECT_DIR` に相当する注入は無い。**

→ 相関手段は (a) `hooks.json` のコマンド引数（実測で `argv1` が届くことを確認）、(b) codex プロセスに CommandMate が渡す env、(c) payload の `session_id` + `turn_id`。

#### 5.1.8 codex 検証項目 10 — hooks が発火しない UI / タイミング

| UI・状況 | hooks | 実測 |
|---|---|---|
| directory trust ダイアログ（`Do you trust the contents of this directory?`） | **無し** | 応答するまで受信 0 |
| 「Hooks need review」ダイアログ | **無し** | 受信 16→16 |
| hooks 一覧／個別レビュー画面 | **無し** | 受信 16→16 |
| `/model` overlay | **無し** | 受信 31→31（Esc で閉じた） |
| **プロセス起動〜最初のターン** | **無し** | TUI 起動 08:05:15 → `SessionStart` 08:06:23.616。**`SessionStart` は起動 signal にならない** |
| `/quit` | `SessionEnd`（`reason: "other"`） | 受信 +1 |
| **tmux `kill-session`（SIGHUP）** | **無し** | 受信 16→16。**強制終了では `SessionEnd` が出ない** |

---

### 5.2 copilot 1.0.77 / 1.0.79

#### 5.2.1 copilot 検証項目 1 — hooks 機構の実在（**Issue の前提が誤り**）

Issue #1757 は「`copilot --help` に hook の語が 1 つも無い」を根拠に不在を疑っていた。それ自体は事実（`copilot --help | grep -ci hook` → `0`）だが、**hooks は別の場所に文書化されている**。

```bash
copilot help config | grep -n -A2 hook
# 204:  `disableAllHooks`: whether to disable all hooks (repo-level and user-level); defaults to `false`.
# 206:  `hooks`: inline hook definitions, keyed by event name (same schema as .github/hooks/*.json).
# 207:    - In global config.json these act as user-level hooks; in repo settings.json they act as repo-level hooks

copilot plugin --help | head -6
# Plugins extend Copilot CLI with additional skills, agents, hooks, MCP servers,
# and LSP servers. …

copilot help commands | grep -n hook
# 65:    /env  Show loaded environment details (instructions, MCP servers, skills, agents, hooks, plugins, LSPs, extensions)
```

そして実際に発火する（1 ターンで 6 イベント）:

```
0275 08:40:20.854 UserPromptSubmit
0277 08:40:20.946 SessionStart
0281 08:40:23.260 PreToolUse
0285 08:40:23.630 PostToolUse
0289 08:40:25.052 Stop
0291 08:40:25.105 SessionEnd
```

#### 5.2.2 copilot 検証項目 2 — 設定ファイル（**doc と実装が食い違う**）

`copilot help config` の言うとおり `$COPILOT_HOME/config.json` に `hooks` を書くと初回は発火する。
**ところが copilot は終了時に config.json を書き戻し、`hooks` を `settings.json` へ移送する。**

```
$ cat $COPILOT_HOME/config.json          # 実行後
// User settings belong in settings.json.
// This file is managed automatically.
{
  "trustedFolders": [ … ],
  "firstLaunchAt": "2026-03-11T00:00:00.000Z"
}

$ cat $COPILOT_HOME/settings.json        # copilot が自分で書いた
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "…" } ] } ], … } }
```

→ **書き先は `~/.copilot/settings.json`。** config.json に書くのは「一度は効くが次回消える」ので不可。

- **repo-level `.github/hooks/*.json` は発火しなかった**（`git init` 済み・`trustedFolders` 登録済みの workspace に `.github/hooks/cmate-probe.json` を置いたが受信 0）。discovery 条件は**未確定**。
- session 限定注入は **`COPILOT_HOME` env のみ**（`--settings` 相当のフラグは無い）。
- イベントキーは `SessionStart` などの CamelCase が正（payload の `hook_event_name` がその綴り）。`sessionStart` / `preToolUse` / `postToolUse` / `sessionEnd` の小文字始まりも受理されたが、`stop` / `userPromptSubmit` は受理されなかった。**CamelCase で書くこと。**
- ハンドラは grouped 形 `{"hooks":[…]}` と flat 形 `{"type":"command","command":"…"}` の**両方が受理される**。

#### 5.2.3 copilot 検証項目 6 — timeout（fail-open・既定 ≈10 秒）

`PreToolUse` の応答を 12 秒遅延させ、遅れて `deny` を返す設定で 2 回測った。

| `timeout` 設定 | `PreToolUse` → `PostToolUse` 間隔 | 結果 |
|---|---|---|
| 未指定（既定） | **10.05 秒**（08:42:52.478 → 08:43:02.527） | 遅延した `deny` は捨てられ、ツールは実行された |
| `"timeout": 3` | **5.12 秒**（08:44:22.518 → 08:44:27.634） | 同上 |

→ **fail-open。既定 timeout は約 10 秒**（Claude の 600 秒とは 2 桁違う）。裁定を返す受け口は 10 秒以内に応答すること。

#### 5.2.4 copilot 検証項目 7 — 承認裁定（Claude 互換・`{}` は fail-safe）

| 応答 | 結果 |
|---|---|
| `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by CommandMate p4 spike hook"}}` | `✗ Write CP-DENY to cp-deny.txt (shell)` / `└ Denied by preToolUse hook: denied by CommandMate p4 spike hook`。**ファイルは作られない** |
| `{}` | 通常の許可フローに落ちる（`--allow-all-tools` 下では実行される）。**fail-safe** |

**Claude Code の `hookSpecificOutput.permissionDecision` がそのまま通る。** 4 ツール中もっとも移植コストが低い。

#### 5.2.5 copilot 検証項目 5 / 9 — 配信方式・環境変数

- `UserPromptSubmit` に `{"type":"http","url":"http://127.0.0.1:8791/hook/cp-ups-http"}` を追加したが**リクエストは 1 件も来なかった**（エラー表示も無し）。**command のみ。**
- hook コマンドには copilot が env を注入する:

```
COPILOT_CLI = 1
COPILOT_CLI_BINARY_VERSION = 1.0.79
COPILOT_HOME = <COPILOT_HOME>
COPILOT_PROJECT_DIR = <CWD>
```

→ **`COPILOT_PROJECT_DIR` が Claude の `CLAUDE_PROJECT_DIR` に相当する。** worktree 相関に使える。

#### 5.2.6 copilot 検証項目 8 / 10 — payload・未計測項目

payload は Claude 互換の snake_case ＋ `hook_event_name` ＋ `timestamp`。fixture は [`tests/fixtures/hooks/copilot/`](../../tests/fixtures/hooks/copilot/)。

- `SessionStart` に `source: "new"` と **`initial_prompt`** が入る。
- `PostToolUse` の結果は `tool_result: { result_type, text_result_for_llm }`。
- `Stop` にだけ `transcript_path` がある（他イベントには無い）。
- **`Notification` は `copilot -p` では一度も発火しなかった。**
- **項目 10（hooks が発火しない UI）は未計測。** 非対話 `-p` のみで検証したため。TUI の trust / login / `/model` 相当画面は次フェーズで測ること。

---

### 5.3 gemini 0.42.0 / 0.55.1

#### 5.3.1 gemini イベント語彙とツール名の変換表

`gemini hooks migrate --from-claude` の実装（bundle 内 `packages/cli/src/commands/hooks/migrate.ts` 相当）が持つ変換表をそのまま引く。**これが gemini のイベント語彙の権威**である。

| Claude Code | Gemini CLI |
|---|---|
| `PreToolUse` | `BeforeTool` |
| `PostToolUse` | `AfterTool` |
| `UserPromptSubmit` | `BeforeAgent` |
| `Stop` | `AfterAgent` |
| `SubAgentStop` | `AfterAgent`（gemini にサブエージェントが無いため） |
| `SessionStart` | `SessionStart` |
| `SessionEnd` | `SessionEnd` |
| `PreCompact` | `PreCompress` |
| `Notification` | `Notification` |

さらに `BeforeModel` / `AfterModel` は Claude に対応語が無い gemini 固有イベント（実発火を確認）。

**ツール名も matcher 用にリマップされる:**

| Claude | Gemini |
|---|---|
| `Edit` | `replace` |
| `Bash` | `run_shell_command` |
| `Read` | `read_file` |
| `Write` | `write_file` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `ls` |

また `$CLAUDE_PROJECT_DIR` は `$GEMINI_PROJECT_DIR` に置換される。移送されるハンドラのフィールドは **`type`(command のみ) / `command` / `timeout`** の 3 つだけ。

#### 5.3.2 gemini 検証項目 2 — 設定ファイル

`migrate` は `settings.setValue("Workspace", "hooks", …)` を呼ぶ。つまり **`<workspace>/.gemini/settings.json` の `hooks` キー**が正規の置き場。実測でも workspace 側に置いた 10 イベントすべてが登録された。

- user スコープは `$GEMINI_CLI_HOME/.gemini/settings.json`（既定 `~/.gemini/settings.json`）。
- **`GEMINI_CLI_HOME` は「`.gemini` の親ディレクトリ」を指す**（`$GEMINI_CLI_HOME/.gemini/settings.json` を読む）。素直に `HOME` 相当と考えてよい。
- **worktree ごとに `.gemini/settings.json` を置けるので、4 ツール中もっとも注入が素直。** ユーザーのグローバル設定に触れる必要が無い。

#### 5.3.3 gemini 検証項目 4 — trust と hook 開示バナー

未 trust のフォルダで起動すると:

```
ℹ Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.

╭──────────────────────────────────────────────────────────────────────────────╮
│ Do you trust the files in this folder?                                       │
│ Trusting a folder allows Gemini CLI to load its local configurations,        │
│ including custom commands, hooks, MCP servers, agent skills, and settings.   │
│ These configurations could execute code on your behalf …                     │
│ ● 1. Trust folder (gemini)                                                   │
│   2. Trust parent folder (work)                                              │
│   3. Don't trust                                                             │
╰──────────────────────────────────────────────────────────────────────────────╯
```

trust すると、**hook コマンドを全件列挙する開示バナー**が出る（承認は求めない・そのまま起動が続く）:

```
     - <SP>/hookpost.sh gm-before-agent
     - <SP>/hookpost.sh gm-after-agent
     …
   These hooks will be executed. If you did not configure these hooks or do not trust this project,
   please review the project settings (.gemini/settings.json) and remove them.
```

trust 状態は `$GEMINI_CLI_HOME/.gemini/trusted_hooks.json`（workspace → hook コマンド文字列の配列）と `trustedFolders.json` に永続化される。

#### 5.3.4 gemini 検証項目 8 — 採取できた payload

trust 直後に `SessionStart` が **v0.42.0 で** 到着（受信 0 → 1）。その後 v0.55.1 でダミー API キーを使い、モデル呼び出しが 400 で落ちるまでの間に 5 イベントを採取した。

```
39 gm-session-start   08:16:33.574
40 gm-before-agent    08:16:33.593
41 gm-pre-compress    08:16:33.612   ← 新規セッションの 1 ターン目でも発火する
42 gm-before-model    08:16:33.799
43 gm-session-end     08:16:33.975
```

payload は Claude 互換 snake_case ＋ `hook_event_name` ＋ **`timestamp`**。`BeforeModel` の `llm_request` には**組み立て済みプロンプト全文（ワークスペースのディレクトリ構造を含む）**が載る。

#### 5.3.5 gemini 検証項目 1・3・9 の結論

- 項目 1: **実在**（`SessionStart` ほか 5 イベントが実発火）。
- 項目 3: `~/.gemini/settings.json` は diff 空・sha256 一致（[§6.1](#61-ユーザーのグローバル設定の-before--after)）。
- 項目 9: コマンド引数は機能（タグで確認）。env 注入は**未計測**。ただし workspace スコープの settings.json 自体が worktree 単位なので、**設定ファイルの置き場所そのものが相関キーになる**。

#### 5.3.6 gemini 検証項目 6 / 7 / 10 — 未計測とその理由

**この環境の Google アカウントでは gemini CLI がモデル呼び出しに到達できない。**

```
Error authenticating: IneligibleTierError: This client is no longer supported for
Gemini Code Assist for individuals. To continue using Gemini, please migrate to the
Antigravity suite of products: https://antigravity.google
  ineligibleTiers: [ { reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier', … } ]
```

これは隔離ホームの副作用ではなく**サーバ側のアカウント/クライアント判定**である（OAuth 自体は成功し、その後の tier 判定で弾かれる）。

**試したこと:**

1. 隔離ホームに `oauth_creds.json` / `google_accounts.json` / `installation_id` を持ち込み `gemini -p` → `IneligibleTierError`（exit 55）
2. TUI 起動 → 認証方式ピッカーに同じ文言が表示される（`Failed to sign in. Message: This client is no longer supported…`）
3. `security.auth.selectedType = "gemini-api-key"` ＋ ダミー `GEMINI_API_KEY` → `400 API_KEY_INVALID`。**ただしモデル呼び出しの手前まで進むので `SessionStart` / `BeforeAgent` / `PreCompress` / `BeforeModel` / `SessionEnd` は採取できた**
4. 有効な `GEMINI_API_KEY` / Vertex AI 資格情報は本環境に無いため入手できず

**その結果、ツール実行を伴うターンが 1 度も成立せず、以下は未計測:**

| 項目 | 状態 | 必要な条件 |
|---|---|---|
| 6（timeout の fail-open/closed） | **未計測** | ツール実行 1 回分のターン |
| 7（承認裁定・no-decision フォールバック） | **未計測** | `BeforeTool` を発火させる必要がある |
| 8 のうち `BeforeTool` / `AfterTool` / `AfterAgent` / `AfterModel` / `Notification` | **未採取** | 同上 |
| 10（hooks が発火しない UI の全体像） | **部分計測** | trust ダイアログと認証ピッカーのみ確認 |

> **「確認できなかった」であって「実在しない」ではない。** gemini の hooks 機構は存在し、SessionStart 系は実発火している。
> #1762 が gemini 分を進めるには、**有効な `GEMINI_API_KEY` を用意して項目 6/7 を先に埋めること**。

---

### 5.4 antigravity (`agy`) 1.1.7 / 1.1.12

#### 5.4.1 agy 検証項目 1 — hooks 機構の実在（公式 doc はバイナリに同梱されている）

agy は自身の builtin skill として hooks の仕様書を配っている。

```
~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md
```

要点（doc の記述）:

- 設定は customization root の `hooks.json` 1 本。トップレベルのキーは**hook 名**。
- イベントは `PreToolUse` / `PostToolUse` / `PreInvocation` / `PostInvocation` / `Stop` の 5 種。
- `PreToolUse` / `PostToolUse` は `matcher` + `hooks` の grouped 形、他は flat 形。
- ハンドラは `type`(command のみ) / `command`(必須) / `timeout`(秒・既定 30)。**cwd は hooks.json のあるディレクトリ**。
- payload は **camelCase（protojson）**。stdin で受け取り stdout に JSON を返す。
- **制限: `type:"command"` のみ（HTTP も prompt hook も無い）／hooks は同期実行でエージェントループをブロックする。**

#### 5.4.2 agy 検証項目 2 — 設定ファイルの場所（**doc と実測が食い違う**）

agy はロード結果をログに 1 行出す。これを使って置き場所を特定した。

```
~/.gemini/antigravity-cli/log/cli-*.log
  hooks_manager.go:53] loaded N named hooks from M hooks.json file(s)
```

候補パスごとに**トップレベルキーの個数を変えた** hooks.json を同時に置き、`N` の値で読まれたファイルを同定した。

| 置いたパス | 結果 |
|---|---|
| `<workspace>/.agents/hooks.json`（**doc が指定する場所**） | **読まれない**（`.git` あり・`trustedWorkspaces` 登録済みでも `0 hooks.json file(s)`） |
| `<workspace>/.agent/` `_agents/` `.antigravity/` `.agy/` `<workspace>/hooks.json` | 読まれない |
| `$HOME/.agents/hooks.json` | 読まれない |
| **`~/.gemini/config/hooks.json`** | **読まれる**（doc の "Global Configuration: `~/.gemini/config/`" と一致） |
| `~/.gemini/antigravity-cli/hooks.json` | 読まれる（`~/.gemini/config/hooks.json` が無いとき） |

- 読み込まれるのは常に **1 ファイルだけ**（`from 1 hooks.json file(s)`）。
- → **agy には worktree 単位の hooks 設定が無い。** `HOME` を差し替えるか、グローバル 1 本を CommandMate が占有するかの二択。

#### 5.4.3 agy 検証項目 8 — 採取できた payload と語彙

```
44 ag-session-start    08:33:09.449   ← doc に無いが発火する
45 ag-pre-invocation   08:33:09.468
46 ag-pre-tool-use     08:33:11.771
47 ag-post-tool-use    08:33:11.796
48 ag-post-invocation  08:33:11.819
…（PreTool→PostTool→PostInvocation→PreInvocation が 1 ステップごとに繰り返す）
79 ag-stop             08:33:37.793
```

- **`SessionStart` は未文書化だが実発火する**（バイナリにも `SessionStartHookArgs` / `SessionStartHookResult` の proto が存在）。
- **`SessionEnd` / `Notification` / `UserPromptSubmit` は設定しても一度も発火しない。**
- payload に **`hook_event_name` に相当するフィールドが無い。** どのイベントかは「どのハンドラが呼ばれたか」でしか判らない。
- **`workspacePaths` が空配列**で `cwd` フィールドも無い。**payload から worktree を特定できない。**
- 共通フィールドは `conversationId` / `workspacePaths` / `transcriptPath` / `artifactDirectoryPath` / `modelName`。
  `PreToolUse`/`PostToolUse` に `toolCall{name,args}` と `stepIdx`、`PostToolUse` に `error`、
  `Pre/PostInvocation` に `invocationNum` / `initialNumSteps`、
  `Stop` に `executionNum` / `terminationReason` / `fullyIdle` / `error`。

#### 5.4.4 agy 検証項目 7 — 承認裁定（**no-decision が fail-CLOSED**）

`PreToolUse` の応答を差し替えて 4 パターン測った。

| 応答 | 結果 |
|---|---|
| `{"decision":"deny","reason":"denied by CommandMate p4 spike hook"}` | `Error invalid tool call: … tool call denied with reason: denied by CommandMate p4 spike hook` |
| `{"decision":"allow"}` | 実行される |
| **`{}`（`decision` 欠落）** | **`run_command` / `list_dir` / `search_web` すべてが拒否される。** エージェントは「all tool executions were denied by the environment's system policy」と報告して代替手段を探し回った |
| （対照）hooks.json を退避して同じプロンプト | **正常実行**（`AG-CONTROL` が出力された）→ 上の拒否が hook 起因であることの裏取り |

doc の `decision` 値は `allow` / `deny` / `ask` / `force_ask`。加えて `permissionOverrides`（一時的な許可付与）と `overwrite`（ツール引数の浅いマージ書き換え）がある。
`Stop` は `{"decision":"continue"}` を返すと**エージェントの停止を阻止して実行ループを再開させる**。

> **これが本スパイクの安全性上いちばん重要な発見。** Claude / codex / copilot はいずれも
> 「黙る＝通常フローに戻す」だが、**agy は「黙る＝拒否」。**
> Auto-Yes v2 が「判断できないときは空応答」で実装されていると、agy では**エージェントが全ツールを失って停止する。**

#### 5.4.5 agy 検証項目 6 — timeout（fail-open。`{}` と挙動が真逆）

`"timeout": 3` を設定し、ダンプサーバの応答を 12 秒遅延させたうえで **`deny` を返す**構成にした。

```
elapsed = 10.48s
→ ツールは実行された（AG-TIMEOUT3 が出力された）
```

遅延して届くはずの `deny` は採用されず、ツールが走った。**＝ timeout は fail-open。**

**したがって agy では「ハンドラが無応答（timeout）」は fail-open、「ハンドラが 200 で `{}` を返す」は fail-closed という真逆の挙動になる。**
中継スクリプトが「サーバに繋がらなかったら空 JSON を返す」実装だと、**サーバ停止時にエージェントが全停止する。**

#### 5.4.6 agy 検証項目 3・4・9・10

- 項目 3: `HOME` 差し替え（APFS clone）で `~/.gemini/antigravity-cli/settings.json` / `~/.gemini/antigravity/antigravity_state.pbtxt` とも diff 空。**ただし `trustedWorkspaces` はグローバル settings.json に追記される仕様**なので、隔離せずに新しい worktree で起動するとユーザー設定が書き換わる。
- 項目 4: hook 専用の trust プロンプトは無い。workspace trust（`trustedWorkspaces`）はあるが、hooks はグローバル root から読まれるため影響を受けない。
- 項目 9: **コマンド引数しか手段が無い**（payload に cwd も workspace も無い）。env 注入は未計測。
- 項目 10: 非対話のみで検証。session/prompt 系イベントが存在しないため、**CLI の画面状態は hooks からは原理的に見えない**。TUI の trust / login / model 選択画面は未計測。

---

## 6. 非汚染の証拠

### 6.1 ユーザーのグローバル設定の before / after

検証開始前にコピーを取り、全検証終了後に `diff` した。**5 ファイルすべて diff 空。**

```bash
diff baseline/codex-config.toml.before            ~/.codex/config.toml                      # => CODEX_CONFIG_TOML_DIFF_EMPTY
diff baseline/gemini-settings.json.before         ~/.gemini/settings.json                   # => GEMINI_SETTINGS_DIFF_EMPTY
diff baseline/copilot-config.json.before          ~/.copilot/config.json                    # => COPILOT_CONFIG_DIFF_EMPTY
diff baseline/copilot-settings.json.before        ~/.copilot/settings.json                  # => COPILOT_SETTINGS_DIFF_EMPTY
diff baseline/agy/antigravity-cli-settings.json.before ~/.gemini/antigravity-cli/settings.json  # => AGY_CLI_SETTINGS_DIFF_EMPTY
diff baseline/agy/antigravity_state.pbtxt.before  ~/.gemini/antigravity/antigravity_state.pbtxt # => AGY_STATE_DIFF_EMPTY
```

sha256 も検証前後で一致:

```
before / after ともに
73a256aa7406c6b2d5072c7adff532b20cd97a153fcf8d325fc743a322b67301  ~/.codex/config.toml
1f0bfcea339660d51d86b4ce37338b7b9e99c3e36e5d9d4d51399302c9809b07  ~/.gemini/settings.json
c4673c490248b2fa0beb9936bea6dc841ec62afcc7be3f0170345759300b3d58  ~/.copilot/config.json
deab2d9530d1cebf33852d8be9e495c4e36906b2f7ed1f02206365d1d4b91995  ~/.copilot/settings.json
```

- **`~/.codex/config.toml` の `notify`（Computer Use / `SkyComputerUseClient`）行は読み取りのみで一切触っていない。**
- ユーザーの config ディレクトリに hooks.json は 1 つも作っていない:

```bash
ls ~/.codex/hooks.json ~/.gemini/config/hooks.json ~/.gemini/antigravity-cli/hooks.json
# => 3 件とも No such file or directory
```

- 受け側は使い捨てダンプサーバ（127.0.0.1:8791）のみ。**本番サーバ（port 3000）へは 1 件も送っていない**ので本番 DB の `task_events` は無変更。
- tmux はすべて `-L cmate-p4spike` の専用 socket 上。`kill-server` は未使用。検証後、既定 socket 上のユーザーセッション 11 本（`mcbd-*`）は全て健在。
- 隔離ホームに書き出した認証情報（`auth.json` / `oauth_creds.json`）は mode 600 で作成した。

### 6.2 検証中に発生した本体の自動更新（報告）

**設定ファイルは 1 バイトも変えていないが、3 ツールが検証中に自分自身を自動更新した。**隠さず記録する。

| ツール | 検証前 | 検証後 | 経緯 |
|---|---|---|---|
| gemini | 0.42.0 | **0.55.1** | 隔離ホームで TUI 起動時に「Update successful! The new version will be used on your next run.」が出た。更新先は**グローバル npm install**（`/opt/homebrew/lib/node_modules/@google/gemini-cli`）。無効化する env 変数は bundle 内に見つけられなかった |
| copilot | 1.0.77 | **1.0.79** | 既定で auto-update 有効（`COPILOT_AUTO_UPDATE=false` / `--no-auto-update` で抑止可能。今回は指定しなかった） |
| agy | 1.1.7 | **1.1.12** | **`AGY_CLI_DISABLE_AUTO_UPDATE=1` を全実行に付けていたが更新された**（`~/.local/bin/agy` が置き換わった） |

- codex は 0.147.0 のまま変化なし。
- **含意**: 外部 CLI の版は実質的に固定できない。#1759〜#1762 は payload パーサを「未知フィールドは無視 / 未知イベント名は refuse」で組み、版レンジを狭く仮定しないこと。
- 本書の各観測がどの版のものかは各節に明記した（gemini の `SessionStart` のみ 0.42.0 と 0.55.1 の双方で確認）。

---

## 7. 未検証・積み残し

下流実装者が「実測済み」と誤解しないよう明示する。

| 項目 | ツール | 状態 | 理由 |
|---|---|---|---|
| 項目 6 / 7（timeout・承認裁定） | **gemini** | **未計測** | `IneligibleTierError` でモデル呼び出しに到達できず、ツール実行ターンを成立させられなかった（[§5.3.6](#536-gemini-検証項目-6--7--10--未計測とその理由)） |
| `BeforeTool` / `AfterTool` / `AfterAgent` / `AfterModel` / `Notification` の payload | gemini | **未採取** | 同上 |
| 項目 10（hooks が発火しない UI） | **copilot / agy** | **未計測** | 非対話 `-p` / `--print` のみで検証した |
| `Notification` の発火条件 | copilot | **未確認** | 登録済み・非対話では 0 回。TUI で idle / 承認待ちを作れば出る可能性 |
| repo-level `.github/hooks/*.json` の discovery 条件 | copilot | **未確定** | `git init` 済み・`trustedFolders` 登録済みでも読まれなかった |
| `hooks.managed_dir` の正しい使い方 | codex | **未確定** | `<dir>/hooks.json` / `<dir>/hooks/hooks.json` のどちらでも発火せず |
| `prompt` / `agent` handler type | codex | **未検証** | `command` のみ検証した |
| hook コマンドへの env 注入 | gemini / agy | **未計測** | codex（注入なし）・copilot（注入あり）のみ実測 |
| `PermissionRequest` を返さなかったときの codex の deny ルート | codex | **未検証** | TUI で「3. No」を選んだときの hook は測っていない |
| PreCompact / PostCompact / SubagentStart / SubagentStop | codex | **未採取** | 本 Issue のスコープ外 |
| hooks の実行順序の保証 | 全ツール | **1 回の観測のみ** | 順序に依存する実装をしないこと |
| Windows / Linux での挙動 | 全ツール | **未検証** | macOS のみ |

---

## 8. Phase 4-1（#1759 抽象抽出）への要求事項リスト

**本スパイクの最重要成果物。** 4 ツール（＋ Claude / opencode）の payload 形を並べ、`AgentEventSource` が何を可変にすべきかを列挙する。

### 8.1 `AGENT_EVENT_TYPES` 7 語 × 4 ツールの対応表

| `AGENT_EVENT_TYPES` | Claude Code (#1721) | codex 0.147.0 | copilot 1.0.77 | gemini 0.42/0.55 | antigravity 1.1.x |
|---|---|---|---|---|---|
| `session_start` | `SessionStart` | `SessionStart`※1 | `SessionStart`※2 | `SessionStart` | `SessionStart`（**未文書化**） |
| `session_end` | `SessionEnd` | `SessionEnd`※3 | `SessionEnd` | `SessionEnd` | **無し** |
| `user_prompt_submit` | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit`※2 | `BeforeAgent` | **無し** |
| `stop` | `Stop` | `Stop` | `Stop` | `AfterAgent`（**未計測**） | `Stop`※4 |
| `notification` | `Notification`（`notification_type` で判別） | **無し** | `Notification`（非対話では未発火） | `Notification`（**未計測**） | **無し** |
| `pre_tool_use` | `PreToolUse` | `PreToolUse` | `PreToolUse` | `BeforeTool`（**未計測**） | `PreToolUse` |
| `post_tool_use` | `PostToolUse` | `PostToolUse` | `PostToolUse` | `AfterTool`（**未計測**） | `PostToolUse` |
| （承認裁定） | `PermissionRequest` | `PermissionRequest` | `PreToolUse` の戻り値 | （相当イベント無し） | `PreToolUse` の戻り値 |
| （対応語の無い固有イベント） | — | `PreCompact` / `PostCompact` / `SubagentStart` / `SubagentStop` | — | `BeforeModel` / `AfterModel` / `PreCompress` | `PreInvocation` / `PostInvocation` |

※1 codex の `SessionStart` は**最初のターン開始時**に出る（プロセス起動時ではない）。
※2 copilot は `UserPromptSubmit` → `SessionStart` の順。
※3 codex の `SessionEnd` は `/quit` では出るが**強制終了では出ない**。
※4 agy の `Stop` は「停止しようとしている」の通知で、`{"decision":"continue"}` を返すと**停止を阻止できる**（純粋な観測イベントではない）。

**4 ツール（＋Claude）すべてで揃うのは `session_start` / `pre_tool_use` / `post_tool_use` / `stop` の 4 語だけ。**
`notification` は codex / agy に存在せず、`session_end` / `user_prompt_submit` は agy に存在しない。

### 8.2 `AgentEventSource` が可変にすべきもの（実測に基づく要求）

| # | 可変にすべき軸 | なぜ（実測） | 最小要件 |
|---|---|---|---|
| **R1** | **イベント名の綴りとイベント語彙そのもの** | Claude/codex/copilot は CamelCase の同一語彙に近いが、gemini は `BeforeTool`/`BeforeAgent`/`PreCompress`、agy は `PreInvocation`/`PostInvocation`。存在しないイベントもある | ツールごとに「CommandMate 語 → ツール語」の**双方向テーブル**を持つ。**存在しない語は「未対応」として明示的に落とす**（無言で別イベントに割り当てない） |
| **R2** | **イベント種別の取得元** | Claude/codex/copilot/gemini は payload の `hook_event_name` に入る。**agy は payload にイベント名が一切無い** | イベント種別を **(a) payload のフィールド or (b) 中継の引数** のどちらからでも取れるようにする。agy は (b) 必須 |
| **R3** | **payload のキー命名規約** | codex/copilot/gemini は snake_case、**agy は camelCase(protojson)** | フィールド抽出をツールごとのアダプタに逃がす。共通 DTO へは正規化してから渡す |
| **R4** | **セッション ID のフィールド名** | `session_id`(Claude/codex/copilot/gemini) / **`conversationId`**(agy) | フィールド名をアダプタ設定に |
| **R5** | **ターン ID のフィールド名** | Claude は `prompt_id`、**codex は `turn_id`**、copilot/gemini は無し、agy は `stepIdx` / `invocationNum` | optional 扱い。相関に必須としない |
| **R6** | **worktree の特定手段** | Claude/codex/copilot/gemini は payload に `cwd` がある。**agy は `cwd` も `workspacePaths`(空配列) も使えない** | **worktree ID / instance ID は必ず中継コマンドの引数に焼き込む。** payload の `cwd` は補助にとどめる |
| **R7** | **配信方式** | **4 ツールとも `type:"http"` は使えない**（codex は http を書くと hooks.json 全体が死ぬ） | `type:"command"` の中継スクリプト一本に統一する。http 出力は設定生成器から**削除**する |
| **R8** | **設定ファイルの場所とスコープ** | codex: `$CODEX_HOME/hooks.json` ＋ `<cwd>/.codex/hooks.json` / copilot: `~/.copilot/settings.json` / gemini: `<worktree>/.gemini/settings.json` / **agy: `~/.gemini/config/hooks.json` グローバル 1 本のみ** | 「worktree スコープが使えるか」をツール能力として持つ。使えない agy 用に**グローバル 1 本を占有する経路**を別に用意する |
| **R9** | **設定ファイルの構造** | Claude/codex/copilot/gemini: `{"hooks": {"<Event>": [...]}}` / **agy: `{"<hook 名>": {"<Event>": [...]}}` の 2 階層** | 設定シリアライザをツールごとに |
| **R10** | **grouped / flat のハンドラ形** | agy は `PreToolUse`/`PostToolUse` のみ grouped、他は flat。copilot は両方受理 | ハンドラ配列の包み方をイベント単位で切り替えられるように |
| **R11** | **trust の取得手段** | codex: TUI ダイアログ必須＋`config.toml` に永続化＋`--dangerously-bypass-hook-trust`。gemini: フォルダ trust ダイアログ＋開示バナー。copilot/agy: hook 専用 trust 無し | 起動コマンドに**ツール固有の trust バイパス引数**を差し込めるようにする。trust 待ちで無音になる時間があることを起動シーケンスに織り込む |
| **R12** | **no-decision の意味（最重要）** | Claude/codex/copilot: 空応答＝通常フローへ（fail-safe）。**agy: 空応答＝拒否（fail-closed）** | **裁定を返さない場合の「無害な応答」をツールごとに定義する。** agy では空 JSON を返してはならない（`{"decision":"allow"}` か、そもそも hook を張らない） |
| **R13** | **timeout の既定値と単位** | codex 600s / copilot **≈10s** / agy 30s(doc) / Claude 600s・UserPromptSubmit は 30s。単位はすべて秒 | 受け口の応答期限をツールごとに設定。**copilot に合わせるなら裁定は 10 秒以内**に返す |
| **R14** | **エージェント側 env の注入有無** | **copilot のみ** `COPILOT_PROJECT_DIR` / `COPILOT_CLI` などを注入。codex は注入なし（親環境の丸ごと継承） | env に依存しない設計を既定にし、copilot では補助的に使う |
| **R15** | **裁定レスポンスのスキーマ** | Claude/codex: `hookSpecificOutput.{permissionDecision or decision.behavior}` / copilot: `hookSpecificOutput.permissionDecision` / **agy: トップレベル `{"decision":"allow\|deny\|ask\|force_ask","reason":…}`** | 裁定シリアライザをツールごとに。`deny` の理由文字列がエージェントに見える点は 4 ツール共通 |
| **R16** | **ライフサイクルの意味論** | codex の `session_start` は「最初のターン」、copilot は `user_prompt_submit` が先、agy は `Stop` が「停止を阻止できる」制御イベント | **`session_start` を起動完了 signal にしない**（#1721 の結論を全ツールに拡張）。`stop` を「観測」として扱えないツール（agy）があることを型で表現する |

### 8.3 `scripts/hooks/cmate-agent-event.sh` への具体的な修正要求（#1759 担当）

本スパイク中、この中継は**そのままでは 4 ツールのどれにも使えなかった**（ダンプサーバ直で回避した）。実害:

1. **`--event` の allowlist が 5 語しかない**（`scripts/hooks/cmate-agent-event.sh:145`）。
   `pre_tool_use` / `post_tool_use` を渡すと `die` する。**#1726 で `AGENT_EVENT_TYPES` に 7 語入っているのに中継が追随していない。**
2. **`map_event_name`（同 64-73 行）が知らない綴りが多すぎる。**
   `PreToolUse` / `PostToolUse`（Claude・codex・copilot・agy）、`BeforeTool` / `AfterTool` / `BeforeAgent` / `AfterAgent`（gemini）が
   すべて未マップで、`unrecognized hook event name` で死ぬ。
3. **payload からイベント名を取れないツールがある。** agy には `hook_event_name` に相当するフィールドが無いので、
   **`--event` を明示的に渡す経路が必須**（現状の「JSON から推定」フォールバックは agy では常に失敗する）。
4. **`session_id` の抽出が `session_id` / `turn-id` の 2 つしか見ていない**（同 134-140 行）。
   agy は `conversationId`、codex のターン相関は `turn_id`（ハイフンではなくアンダースコア）。
5. **cwd のフォールバックが `CLAUDE_PROJECT_DIR` → payload `cwd` → `$PWD`。**
   copilot は `COPILOT_PROJECT_DIR`、agy は payload に `cwd` が無い。**`--cwd` / `--worktree-id` を必須で渡す運用に倒すのが安全。**

> 本 Issue はスパイクなので**この修正は行っていない**（#1759 の担当）。

---

## 9. 関連

- Epic: [#1720](https://github.com/Kewton/CommandMate/issues/1720)
- Claude 版スパイク: [#1721](https://github.com/Kewton/CommandMate/issues/1721) / [`docs/design/agent-hooks-live-verification.md`](./agent-hooks-live-verification.md)
- opencode 版スパイク: #1758（server API + SSE のため別手法）
- 下流: #1759（抽象抽出）/ #1760（codex）/ #1761（copilot）/ #1762（gemini・antigravity）
- 既存の受け口: `src/app/api/hooks/agent-event/route.ts`
- 既存の中継スクリプト: `scripts/hooks/cmate-agent-event.sh`（[§8.3](#83-scriptshookscmate-agent-eventsh-への具体的な修正要求1759-担当)）
- イベント語彙: `src/lib/hooks/agent-event-types.ts`
- fixture: [`tests/fixtures/hooks/codex/`](../../tests/fixtures/hooks/codex/) / [`copilot/`](../../tests/fixtures/hooks/copilot/) / [`gemini/`](../../tests/fixtures/hooks/gemini/) / [`antigravity/`](../../tests/fixtures/hooks/antigravity/)
- agy 公式 doc（バイナリ同梱）: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`
- copilot 公式 doc: `copilot help config` / `copilot plugin --help` / https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins
