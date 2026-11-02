# 各 CLI へロールを渡す方法: 実機確認と adapter 契約（Issue #4113）

- 親: Epic #4112（決定 D1〜D5 はそちらが正）。この文書を読む後続: #4114（DB・生成物）、#4115（起動処理と Schedule）
- 状態: **調査と契約の確定のみ。`src/` と `tests/` は変えていない**
- 基準: develop `d5c581231`、CommandMate 0.49 系、schema v63。検証日 2026-11-03
- 生の記録: [`agent-roles-adapters/evidence/`](./agent-roles-adapters/evidence/)、再現用の harness: [`agent-roles-adapters/harness/`](./agent-roles-adapters/harness/)（§10）

## 1. 結論

| adapter | 渡し方（契約） | ロールの層 | 既定の指示 | 判定 |
|---|---|---|---|---|
| Claude Code | `--append-system-prompt-file <abs>` | system | 残る（追加） | **成立** |
| Codex | `$CODEX_HOME/cm-role-<id>.config.toml` + `-p cm-role-<id>`。既存の `developer_instructions` を合成して書く | developer | 残る（追加）。ただし既存の `developer_instructions` は上書きされる | **成立**（合成が必須） |
| Command Code | 生成した mod + `--mod <abs>`（`appendSystemPrompt`） | system | 残る（追加） | **成立**（BYOK 経路で確認。§9） |
| OpenCode V1 | `OPENCODE_CONFIG_CONTENT={"instructions":[<abs>]}` | system | 残る（追加） | **成立** |
| OpenCode V2 | `OPENCODE_CONFIG_CONTENT={"agents":{<実効 agent>:{"system":"{file:<abs>}"}}}`。本文は「共通指示 + ロール」 | system | **provider の基礎プロンプトは置換される** | **条件つき成立**（§7。判断 1） |
| Antigravity | `~/.gemini/config/agents/cm-role-<id>/agent.md` + `--agent` | 未確認 | 未確認 | **未確定**（認証の複製が要る。判断 2） |
| Copilot CLI | `$COPILOT_HOME/agents/cm-role-<id>.agent.md`（`infer: false`）+ `--agent` | system | 残る（追加）。ツールが 1 つ増える | **成立** |

設計に効く発見は次の 5 つ。Issue 本文の見立てと違うものを含む。

1. **失敗しても CLI は黙って素で動く経路が多い。** Codex の未知プロファイル、Command Code の欠落・不正な mod、OpenCode の欠落した instructions、Copilot TUI の未知 agent は、いずれも画面に何も出さずロールなしで動く（§8）。「失敗時は止める」（#4112）は CLI の終了コードに頼れず、**起動前の検査が必須**。
2. **OpenCode V2 の `OPENCODE_CONFIG_DIR` は使えない。** 大域設定のディレクトリを追加ではなく置換するので、利用者のプロバイダ・モデル・agent が消える（§7.3）。#4112 の設計案の渡し方を変更する。
3. **OpenCode V2 の `default_agent` より、実効 agent の `system` 上書きが安全。** `default_agent` は利用者の既定を奪い、明示 `--agent` と既存の会話では無言で効かない。上書きならいずれでも効く（§7.1）。
4. **再開時の挙動はツールで正反対。** Claude / Codex は旧ロールを保持し続け、Copilot は明示すれば切り替わるが省略では保持、Command Code / V1 / V2（上書き方式）は起動ごとに差し替わる（§3）。CommandMate が再開するのは現状 V1 だけ。
5. **ロールは検出と検証を変えない。** send → hook → approval → `wait --verify` → 契約タスクの結果は、Antigravity を除く 6 adapter でロールありとなしが一致した（§4）。

## 2. 判断を仰ぐこと

**判断 1（OpenCode V2）。** provider の基礎プロンプトが置換され、開発の一般指針 13 行が失われる（§7.2）。ツール一覧は同じで修正から検証まで動き、局所モデルの計測では共通指示を足すと差が埋まった。推奨は「CommandMate の短い共通指示 + ロール」を本文にし、UI と文書で「既定の指示の置き換え」と明示して出荷すること。代替は V2 を初回の対象から外すこと（D3 の変更）。公式文書の `instructions`（追加）は 2.0.18 では効かなかったので、版が上がって効くようになれば切り替える。

**判断 2（Antigravity）。** 本物のモデルへ届く確認には、ログイン済みのホームが要る。一時ホームは「not signed in」で止まり、認証の複製は禁止なので、一覧と失敗応答しか確かめていない。推奨は #4115 で Antigravity の adapter を**無効のまま実装**し、次のどちらかの後に有効化すること。

- (a) 利用者の了承のもとで専用の OS ユーザーで一度ログインし、§6.6 の手順を流す（`CM_UAT_ISOLATION=own-home` の方式に乗る）
- (b) 利用者が本人のホームで §6.6 の手順を実行してよいと決める（`~/.gemini/config/agents/` に新規ファイルを置くのは D4 の範囲）

成立しない場合の代替は §6.6。

## 3. ライフサイクル（すべて実 TUI。`evidence/lifecycle-resume.json`）

本文を V1→編集版 V2→なし と変えて 1 プロセスずつ起動した。セルは次のターンの要求に載っていた本文。

| 手順 | Claude | Codex | Command Code | Copilot | OpenCode V1 | OpenCode V2 |
|---|---|---|---|---|---|---|
| 新規 + V1 | V1 | V1 | V1 | V1 | V1 | V1 |
| 再開 + V1 | V1 | V1 | V1 | V1 | V1 | V1 |
| 再開 + 編集版 V2 | **V1 のまま** | **V1 のまま** | V2 | V2 | V2 | V2 |
| 再開 + なし | **V1 のまま** | **V1 のまま** | なし | **V2 のまま** | なし | なし |
| 新規 + なし | なし | なし | なし | なし | なし | なし |
| 新規 + V2 | V2 | V2 | V2 | V2 | V2 | V2 |
| なしの会話を再開 + ロール | － | － | － | － | 効く | `default_agent` は**効かない** / 上書きは効く |

- 履歴はどの再開でも保たれた（`history: true`）。2 通目は全 adapter で同じロールが載った（`evidence/tui-flows.json` の `turn2`）。
- Claude の保持は仕様。`--system-prompt-snapshot` の既定 `on` は初回の system prompt を記録し、圧縮まで再利用する（`claude --help`）。
- **CommandMate の起動行で再開するのは V1 だけ**（`-s`、`opencode.ts` の `recoverOpencodeSessionId`）。Claude / Codex / Command Code / Copilot / Antigravity の起動行に再開の引数は無く（`grep` で確認）、`launch.sh` も `-s` を渡さないので V2 も新規の会話になる。上の太字は、#4115 が再開を足すときの制約である。
- **サーバー再起動:** tmux の中のプロセスは生き続け、再起動後の send でも同じロールが載った（6 adapter、`send-path.json` の `mock3`）。再接続ではロールを再注入しないので、適用状態は記録が無ければ「不明」とする（#4112 の方針どおり）。
- **ロール編集:** 稼働中のプロセスには届かない。生成物を不変にして新しい版を作る前提で、次の起動から効く。上の表のとおり、再開つきの Claude / Codex では効かない。
- **明示的になし:** 起動行に何も足さないだけで、新規の会話からは消える。

## 4. send 経路と自動処理（`evidence/send-path.json`）

隔離した CommandMate（`tsx server.ts`、別ポート、私設 tmux、一時 DB）の実 API と実 CLI で、起動行にロールを足す PATH シムを挟んで流した。シムは #4115 の起動行の代わりで、コードは未変更。`launchLinesViaShim` に実際の引数がある。

| 確認 | Claude | Codex | Command Code | Copilot | V1 | V2 |
|---|---|---|---|---|---|---|
| 1 通目のロールの層 | system | developer | system | system | system | system |
| `wait` の完了の根拠 | `hook_stop` | `hook_stop` | `hook_stop` | `hook_stop` | **124**（下記） | `hook_stop` |
| approval を検出（`wait --on-prompt agent` が exit 10） | はい | はい | はい | はい | はい | 確認が出ない |
| 承認後に検証コマンドが成功（ツール結果 `VERIFY_OK`） | はい | はい | はい | はい | はい | はい |
| `wait --verify` | 0 | 0 | 0 | 0 | `verify` 単体で 0 | 0 |
| サーバー再起動後の send にロール | はい | はい | はい | はい | はい | はい |
| 契約タスク（`send --contract`）→ `wait --verify` | 0 | 0 | 0 | 0 | 下記 | 0 |
| ロールなしの対照と結果が一致 | はい | はい | はい | はい | はい | はい |

- Claude の `fix` 段の exit 99 は harness の `verify.yaml` に `baseRef` が無かったため（両対照とも同じ）。直した後の契約タスクは 0。
- **V1 の `wait` は、ロールの有無によらず exit 124 になった**（§11 の指摘 1）。状態は `ready` / `hook_stop` まで進み、画面だけが `unknown_frame` で止まる。`commandmate verify` は exit 0。
- **V1 の `prompt_async`:** 2 通目以降は `opencode-send-delivered-via-api` のログのとおり API で届き、ロールが載った。persona `plan` と併用しても、起動行 `--agent plan`、3 通とも role と repo と plan の指示が同時に載った（`persona`）。
- **V2 の serve と TUI:** 設定を読むのは **serve だけ**。serve にだけ env を渡すと効き、TUI にだけ渡すと効かない（`v2-env-and-resume.json`）。`launch.sh` は両方へ env を継ぐので、起動行の env で足りる。
- **V2 の approval:** `external_directory` の外部参照でも確認が出ず（ロールの有無によらず）、ダイアログの検出は比較できていない。
- **リポジトリとシステムのどちらの既定を継いでも同じか:** adapter の入力は解決済みの `ResolvedRole` だけで、渡し方は継承元に依存しない（#4112）。継承元ごとの実機確認は解決関数のある #4115 の受入条件とする。

### Schedule（`evidence/schedule-headless.json`）

`buildCliArgs` の実 argv にロールを足して確定モデルへ向けた。

| ツール | ロール | 検証コマンド | exit | 備考 |
|---|---|---|---|---|
| claude `-p` | system | `VERIFY_OK` | 0 | |
| codex `-p <p> exec` | developer | **両対照とも実行拒否** | 0 | `-p` は `exec` の前。拒否はロールと無関係（`workspace-write` の sandbox） |
| commandcode `-p` | system | `VERIFY_OK` | 0 | |
| opencode `run` | system | `VERIFY_OK` | 0 | `--agent plan` と併用可 |
| opencode2 `run --standalone` | system | `VERIFY_OK` | 0 | `default_agent` だと `--agent plan` で**役割が無言で消える**。`agents.plan.system` の上書きなら載る |
| copilot `-p` | system | `VERIFY_OK` | 0 | |

Antigravity の headless は認証で止まる（未確認）。Schedule の明示 `agent` の扱いは §7.1 と各節に書く。

## 5. 共通の契約（#4114・#4115 向け）

**生成物。** 不変で、版ごとに別の名前。親 0700、ファイル 0600。新規排他作成か一時ファイルからの rename で公開し、同名が同内容なら再利用、違えば拒否する。symlink を辿らない。worktree に置かない。ホーム解決は既存の resolver を使う（`CODEX_HOME`、`COPILOT_HOME`）。削除しない（#4112）。

**本文を起動行に出さない。** 起動行はパスと ID だけ。全 adapter で満たせる（`{file:}` は V2 2.0.18 で動いた）。

**起動前の検査（必須）。** 次を確かめ、失敗したら本文を送らず起動失敗にする。CLI に任せない（§8）。

1. 生成物が在り、読め、内容のハッシュが `ResolvedRole` と一致する
2. 形式の検査（Codex は TOML を読み直す。Command Code は構文の確認。Copilot / Antigravity は frontmatter を読み直す。V1 / V2 は JSON を読み直す）
3. 本文が空なら「ロールなし」扱いにせず拒否する（Claude は空ファイルで素のまま動いた）

**適用の確認。** 起動行に足しただけでは `launched` にしない。起動を確認した証拠が無ければ「不明」と表示する。手段の候補は Claude / Codex / Copilot の起動失敗の検出（exit）と、V2 の `/api/agent`、Command Code の mod が読み込み時に書く受領ファイル（いずれも未実測）。

**本文の形式。** §8 の特殊文字と 16 KiB の本文は、全 adapter で要求に**バイト単位で一致**して届いた。

**上限。** 16 KiB までは全 adapter で確認した。

**ロールの強さ。** ロールは system / developer に入るので、後から user メッセージで届く契約と衝突しうる。共通の前置きに「現在の依頼とリポジトリの指示を優先する」を入れる（V2 の計測で効果あり。§7.2）。プロンプトだけの保証にはしない。ゲートはこれまでどおり証拠で判定する。

## 6. adapter ごとの契約

各節の「記録」は、受入基準の項目（版・argv・env・生成物・質問・応答・ツール結果・終了コード）を 1 回分書き写したもの。共通の質問は次の 2 つ。

- Q1: `CASE=<id> first turn. Say hello.`
- Q2: `CASE=<id> second turn. CMRUN<<sed -i.bak s/1+2/1+1/ calc.sh; rm -f calc.sh.bak; sh verify.sh; echo RC=$?>>`（確定モデルが `CMRUN` を見てシェルツール呼び出しを返す。§10）

共通の env は `HOME` と `XDG_*` を一時へ向けたもの。全行は `tui-flows.json`。

### 6.1 Claude Code

- **渡し方:** `--append-system-prompt-file <abs>`。生成物は本文そのまま。
- **合成:** `CLAUDE.md`（user 層）、`--agent`（system 層）と同時に載る。base の 98% 超が残り、差は記憶ディレクトリのパス 1 行のみ。ツールは同一。
- **再開:** `--continue` では旧本文を保持（§3）。CommandMate は再開しない。#4115 で足すなら `--system-prompt-snapshot off` を別途確かめる（**未確認**）。
- **失敗時:** 欠落 → exit 1 `Append system prompt file not found`。読めない → exit 1 `EACCES`。**空ファイル → 素のまま動く**。
- **Schedule の明示 agent:** `--agent` と併用可（system に両方載る）。

| 項目 | 記録 |
|---|---|
| 版 | Claude Code 2.1.316 |
| argv | `claude --permission-mode default --append-system-prompt-file <D>/home/.cmrole/role-x.md` |
| env | `ANTHROPIC_BASE_URL=http://127.0.0.1:18113`、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_TELEMETRY=1`（API キーは架空） |
| 生成物 | `role-x.md`: `ROLE_MARKER_K3: You are a test role. End every answer with ROLESTAMP.` |
| Q1 → 要求・応答 | ロール=system、`AGENTS.md`=user、ツール 13（対照と同一）、応答 `MOCK_OK` |
| Q2 → ツール結果 | 承認ダイアログ → `VERIFY_OK` / `RC=0`、`calc.sh` は実際に修正された |
| 終了コード | `/exit` で 0 |

### 6.2 Codex

- **渡し方:** `-p cm-role-<id>`。サブコマンドより前に置く（`codex -c features.daemon_auto_start=false [--no-daemon] -p <id>`、`codex -p <id> exec …`）。生成物は TOML で、本文は基本文字列（JSON の文字列表現で可。`"""` を含んでも一致した）。
- **合成（実測）:**
  - `model` など他のキーは `config.toml` から継ぐ。
  - **`config.toml` の `developer_instructions` はプロファイルの同名キーに上書きされる。** 生成物に「既存の本文 + ロール」を書く。
  - `-p a -p b` は **exit 2**（`cannot be used multiple times`）。
  - **未決事項の結論:** CommandMate の起動行に `-p` は無いので、合成すべきは `config.toml` の `developer_instructions` だけ。既存プロファイルを使いたい利用者には、`<name>.config.toml` と `developer_instructions` を合成した生成物で両立できることを確認した（`merged-generated-profile`: モデルと両方の本文が残る）。ラッパーが `-p` を足す運用は exit 2 で起動失敗になるので気づける。`-c developer_instructions=…` でも両立するが本文が argv に出るので不採用。`model_instructions_file` は置換なので不採用。TOML の読み書きは新規の依存が要る（現在の依存に TOML は無い）。
- **再開:** `resume --last` では旧本文を保持（§3）。CommandMate は再開しない。
- **失敗時:** **未知のプロファイル → 無言で素のまま（TUI も `exec` も exit 0）**。不正な TOML → exit 1（行番号つき）。読めない → exit 1。

| 項目 | 記録 |
|---|---|
| 版 | codex-cli 0.166.0 |
| argv | `codex -c features.daemon_auto_start=false -p cm-role-x` |
| env | `CODEX_HOME=<D>/home/.codex` |
| 生成物 | `cm-role-x.config.toml`: `developer_instructions = "ROLE_MARKER_K3: …"` |
| Q1 → 要求・応答 | ロール=developer、`AGENTS.md`=user、ツール 13（対照と同一）、base は 100% 残存、`MOCK_OK` |
| Q2 → ツール結果 | `Would you like to run` → `y` → `VERIFY_OK` / `RC=0` |
| 終了コード | `/exit` で 0 |

### 6.3 Command Code

- **渡し方:** `--mod <abs>.ts`。生成物は `export default function (cmd) { cmd.hooks({ appendSystemPrompt: () => <JSON 文字列> }); }`。実行されるコードなので、本文は `JSON.stringify` 以外で埋め込まない。
- **合成:** 利用者の mod（`~/.commandcode/mods/`）と両方載る。`AGENTS.md` は system 層で共存。ツールは同一。
- **再開:** `-c` では起動ごとに差し替わる。CommandMate は再開しない。
- **失敗時:** **欠落・構文エラー・factory の例外・hook の例外のいずれも、画面にも終了コードにも出ず素のまま動く。** 起動前の検査が唯一の防御。`--safe-mode` を足す経路は無いことを確認する。

| 項目 | 記録 |
|---|---|
| 版 | Command Code 1.88.2 |
| argv | `cmd --trust --skip-onboarding --no-auto-update --local-only -m mock-model --mod <D>/home/.cmrole/cm-role-x.ts`（製品の実行ファイル名は `commandcode`。§4 ではそちらで通した） |
| env | `CMD_LOCAL_ONLY=1`、`CMD_DISABLE_REMOTE_MODEL_CATALOG=1`（架空のキー） |
| 生成物 | 上記の `.ts` と `~/.commandcode/providers.json`（確定モデル用。製品では作らない） |
| Q1 → 要求・応答 | ロール=system、`AGENTS.md`=system、ツール 13、`MOCK_OK` |
| Q2 → ツール結果 | `Execute Shell Command` → Enter → `VERIFY_OK` / `RC=0` |
| 終了コード | `/exit` で 0 |

### 6.4 OpenCode V1

- **渡し方:** 起動行の env `OPENCODE_CONFIG_CONTENT={"instructions":["<abs>"]}`。`--port` と同じ行。**キーは `instructions` だけ**（permission / model / provider を混ぜない。#2053 が避けた事故）。
- **合成:** 配列は既存の `instructions` と**足される**。persona（`--agent plan`、`prompt_async` の `agent`）と併用可。`model` は既存の設定を継ぐ。利用者が同名の env を持つ場合は上書きしてしまうので、その値を読んで配列へ合成する（合成後の形は `user-env-content+role` で確認）。
- **再開（未決事項の結論）:** `-s` で再開すると、**ロールは新しい本文へ差し替わり、履歴は残る**。ロールなしの会話に後からロールを付けても効く。

  **既定は「続ける」**とし、次回の起動でロールが変わるなら、画面と `send` の応答で「旧ロールの発言が履歴に残ったまま続く」ことを伝える。新しい会話を選べるようにし、選んだときは記憶している会話 ID（`opencode-session-store`）だけを捨てる。履歴は消さない。無断で新しい会話へ切り替えない。
- **失敗時:** **`instructions` の欠落・読めないファイル → 無言で素のまま**。JSON の誤り → exit 1（入力の本文を画面に出す。ゆえに本文を env に入れない）。
- **サーバー再起動:** プロセスは生存。再接続後の `prompt_async` にロールが載る。

| 項目 | 記録 |
|---|---|
| 版 | opencode 1.18.35 |
| argv | `opencode --port 18201 --hostname 127.0.0.1` |
| env | `OPENCODE_CONFIG_CONTENT={"instructions":["<D>/home/.cmrole/role-x.md"]}`、`OPENCODE_DISABLE_AUTOUPDATE=1` |
| 生成物 | `role-x.md`（本文そのまま） |
| Q1 → 要求・応答 | ロール=system、`AGENTS.md`=system、ツール 11（対照と同一）、base は 100% 残存、`MOCK_OK` |
| Q2 → ツール結果 | 確認なしで実行 → `VERIFY_OK` / `RC=0`。外部ディレクトリ参照では `Permission required` を検出 |
| 終了コード | `/exit` で 0 |

### 6.5 OpenCode V2

§7 に分ける。

| 項目 | 記録 |
|---|---|
| 版 | opencode v2.0.18 |
| argv | `bash scripts/opencode-v2/launch.sh --port 18211 --password-file <D>/home/pw --directory <D>/repo --executable /opt/homebrew/bin/opencode2` |
| env | `OPENCODE_CONFIG_CONTENT={"agents":{"build":{"system":"{file:<D>/home/r.md}"}}}`（`overlay-*`）または `default_agent` 版（`agent-inline`、`send-path`） |
| 生成物 | `r.md`（共通指示 + 本文） |
| Q1 → 要求・応答 | ロール=system、`AGENTS.md`=system、ツール 12（対照と同一）、base は 84.3% 残存（下記）、`MOCK_OK` |
| Q2 → ツール結果 | 確認なしで実行 → `VERIFY_OK` / `RC=0` |
| 終了コード | `/exit` で 0 |

### 6.6 Antigravity

**確かめたもの（一時ホーム、認証なし）。** 版 agy 1.4.12。`evidence` には無く、ここに記録する。

```
$ HOME=<tmp> agy agent         # exit 0
cm-hid  cm-nosub  cm-role-gem  cm-role-home  cm-space
$ HOME=<tmp> agy -p hello --agent cm-role-nope --print-timeout 15s    # exit 1
error: unknown agent "cm-role-nope" (available: cm-role-gem, cm-role-home, cm-role-repo)
$ HOME=<tmp> agy -p hello --agent cm-role-home --print-timeout 15s    # timeout 124（認証待ち）
Waiting for authentication (timeout 60s)...
$ HOME=<tmp> agy --agent cm-role-home    # TUI
Welcome to the Antigravity CLI. You are currently not signed in.
```

- **ホーム配置（Issue の未確認を解消）:** `~/.gemini/config/agents/<dir>/agent.md` と `~/.gemini/agents/<dir>/agent.md` は一覧に出る。`~/.agents/agents/` と `~/.gemini/antigravity/agents/` は出ない。リポジトリの `.agents/agents/` は `agy agent` に出ず、`--agent` の候補には出た（上のエラーの `cm-role-repo`）。ID はディレクトリ名でなく frontmatter の `name`。
- **不正な定義:** frontmatter が壊れたものと無いものは一覧から消える。`agy agent` で起動前に検査できる。
- **未決事項（メインセッション以外の候補に見えるか）:** 見える。`agy agent` の一覧はセッションによらず定義の全部を返す。抑止の手段は同梱の changelog にあり、`subagent: false` は「利用可能なサブエージェント一覧に出ない・呼べない」、`mainAgent: false` は一覧からも消える（これは実測）。`hidden: true` は一覧から消えない（実測）。**生成物には `subagent: false` を付ける。** サブエージェント候補から実際に消えるかは未確認（モデルへの要求が見えないため）。
- **既定の指示:** changelog によれば Markdown の agent は既定のスキル・ルール・サブエージェントを継ぎ、`excludeDefaultComponents: true` を書いたときだけ既定を外す。実機では**未確認**。
- **失敗時:** headless は exit 1（上記）。TUI は changelog によれば `Agent Not Found` の警告のうえ既定へ戻る（**未確認**）。起動前の検査が要る。

**未確認（理由: 認証の複製が要る）:** 注入、指示の保持、開発能力、send、ライフサイクル、hook の相関、approval の検出、形式。

**実行する手順（判断 2 の後）:** `agent-roles-adapters/harness/` の Q1・Q2 と同じ問いを、`--agent cm-role-x` あり／なしで流し、`AGENTS.md` と本文の両方が守られるか、`calc.sh` の実際の変更、`sh verify.sh` の exit を比べる。応答は `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` でも確かめる。

**成立しない場合の代替:** 定義が既定を置換すると判明したら、V2 と同じく「共通指示 + ロール」にする。`--agent` が TUI で効かないなら、Antigravity を対象から外すことを判断してもらう（D3 の変更）。`~/.gemini/config` の既存ファイルは書き換えない。

### 6.7 Copilot CLI

- **渡し方:** `$COPILOT_HOME/agents/cm-role-<id>.agent.md` + `--agent cm-role-<id>`。frontmatter は `name`、`description`、`infer: false`。**ホーム配置は実測で動いた**（Issue の未確認を解消）。
- **合成:** `.github/copilot-instructions.md`・`AGENTS.md` と同時に載る。base は 100% 残存。ツールは `update_todo` が 1 つ増える（対照 20 → 21）。
- **他のセッションへの影響:** `infer: false` なら `--agent` なしの別セッションの要求に名前も本文も出ない。`infer: true` と省略は名前が出る（本文は出ない）。**`infer: false` は必須。**
- **再開:** `--continue --agent <新>` は新しい本文へ替わる。**`--agent` を省くと前のロールを保持する**ので「明示的になし」にならない。CommandMate は再開しない。
- **失敗時:** **TUI は未知 agent と壊れた frontmatter で無言のまま既定へ戻る。** headless は未知 agent で exit 1（`No such agent`）。
- **版:** Issue の 1.0.98 に対し 1.0.105 で確かめた。ホーム配置と `infer` 以外の差は見ていない。

| 項目 | 記録 |
|---|---|
| 版 | GitHub Copilot CLI 1.0.105 |
| argv | `copilot --agent cm-role-x` |
| env | `COPILOT_HOME=<D>/home/.copilot`、`COPILOT_OFFLINE=true`、`COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:18113/v1`、`COPILOT_MODEL=mock-model`、`COPILOT_AUTO_UPDATE=false` |
| 生成物 | `agents/cm-role-x.agent.md`（`infer: false`） |
| Q1 → 要求・応答 | ロール=system、`AGENTS.md`=system、ツール 21、`MOCK_OK` |
| Q2 → ツール結果 | 確認ダイアログ → Enter → `VERIFY_OK` / `RC=0` |
| 終了コード | `/exit` で 0 |

## 7. OpenCode V2 の契約

### 7.1 渡し方

`OPENCODE_CONFIG_CONTENT` で**実効 agent の `system` を上書きする。**

```json
{"agents":{"build":{"system":"{file:/abs/path/cm-role-x.md}"}}}
```

- **実効 agent:** Schedule の明示 `agent` → 利用者の `default_agent` → `build`
- 利用者の `default_agent` が `plan` のとき、上書きなら `plan` のまま役割が載った（`overlay-user-default-plan`）
- なしで作った会話を上書きで再開しても効いた（`overlay-build-resume-of-none`）
- **上書き先に利用者の `system` があると失われる**（`overlay-over-user-system`）。実効 agent に `system` または Markdown 本文があるときは、合成せず**未送信のエラー**にする
- `model` は既存の設定を継ぐ

**採らなかった案。**

| 案 | 結果 |
|---|---|
| `instructions`（CONTENT、DIR、大域ファイル、`~/`、glob、URL） | 2.0.18 では**どの形でも本文が届かない**（公式文書と不一致） |
| `OPENCODE_CONFIG_DIR` | 大域設定を置換する（§7.3） |
| `default_agent` + `agents.x` | 動くが、利用者の既定を奪い、`--agent` と既存の会話で無言で消える |
| `~/.config/opencode/AGENTS.md` | 届くが既存ファイルの書き換えになり、D4 に反する |
| `agents.x.hidden: true` | `default_agent` が無言で `build` へ戻る |
| `mode: subagent` | 同上 |

### 7.2 開発能力（未決事項の結論）

文書のとおり provider の基礎プロンプトが置換される。失われるのは次のような一般指針 13 行で（`tui-flows.json` の `opencode-v2-agent-inline-x` の `baseLinesLost`）、環境情報、Code Mode の説明、ツール一覧、`AGENTS.md` は残った。

- `You are an AI agent running in OpenCode…`
- `Prefer dedicated tools over shell commands…`
- `Treat unfamiliar files or changes as potential user work…` など

**計測（qwen3-coder:30b、Q「2+2」3 回。§10）。** ロールを `AGENTS.md` と同時に守るかを、応答の文字列で数えた。

| 本文 | ロール | `AGENTS.md` | 両方 | 修正後 `sh verify.sh` |
|---|---|---|---|---|
| なし | 0/3 | 3/3 | 0/3 | OK |
| ロールのみ | 3/3 | **0/3** | 0/3 | OK |
| **共通指示 + ロール** | 3/3 | 3/3 | **3/3** | OK |

標本は小さく局所モデルなので、方向の確認として読む。結論: **本文は `harness/v2w.mjs.txt` の `COMMON` に当たる共通指示 + ロールとする。** 「既定の指示と同等」とは表示しない。

### 7.3 `OPENCODE_CONFIG_DIR` が使えない根拠

`opencode2 debug config` の情報源の一覧で、指定すると大域の `~/.config/opencode/opencode.jsonc` が消える。実際に、プロバイダの設定を失ったセッションは既定のモデルへ落ちた（`user-dir-lost`、`opencode-v2-agent-md-x`）。

### 7.4 失敗時

| 入力 | 応答 |
|---|---|
| `{file:}` の先が無い | TUI が exit 1（スタックトレース、500） |
| JSON の誤り | TUI は描画するが要求が出ない（送信は届かない） |
| 未知の `default_agent`、`hidden`、`subagent` | **無言で `build` へ戻る** |
| `run --agent` の未知 agent | exit 1 `Agent not found` |

**注意:** `opencode2 debug config` などは常駐の service に繋ぐので、最初に起動した環境の設定を返す。検証では `service stop` を挟むこと。

## 8. 失敗時の応答の一覧（`evidence/fail-format-compose.json`、`schedule-headless.json`）

| adapter | 欠落 | 不正 | 読めない | 未知の名前 |
|---|---|---|---|---|
| Claude | exit 1 | － | exit 1 | － |
| Codex | **無言** | exit 1 | exit 1 | **無言**（TUI、`exec`） |
| Command Code | **無言** | **無言** | － | － |
| OpenCode V1 | **無言** | exit 1（env の JSON） | **無言** | － |
| OpenCode V2 | exit 1 | 送信が届かない | － | **無言** |
| Copilot | － | **無言**（TUI） | － | **無言**（TUI）/ exit 1（`-p`） |
| Antigravity | － | 一覧から消える | － | exit 1（`-p`）/ TUI は未確認 |

書き込み不可は生成の段階で失敗するので、CLI へ渡らない（#4114 で「未送信のエラー」にする）。すでに在る定義は、親が読み取り専用でも読める（Copilot `unwritable-home`）。

**形式（全 adapter で要求とバイト一致）:** 改行、`"`、`'`、バッククォート、`"""`、`'''`、行だけの `---`、`$HOME`、`$(…)`、`{file:…}`、`{env:…}`、`<tag>`、日本語、16,384 バイトの本文。空白入りのパス（Claude、Command Code、V1、V2 はファイル、Codex と Copilot はホーム）。

## 9. 指示の保持と開発能力の判定

**判定の材料。** モデルの申告は使わない。

- CLI が実際に送った要求（system / developer / user の各層）を確定モデルで記録し、ロールと `AGENTS.md` の層、ツール一覧、ロールなしの対照との行単位の残存率を比べた
- 確定モデルがシェルツール呼び出しを返し、CLI が実行した結果と、`calc.sh` の実際の変化を見た
- 実モデルの代わりに手元の Ollama（課金なし、認証なし）で、応答の文字列・ファイルの変化・`sh verify.sh` の exit を見た（`evidence/real-model-local.json`）

**局所モデル（qwen3-coder:30b）。** 「2+2」を 3 回。修正の課題は 1 回で、`sh verify.sh` を harness が実行した。

| ツール | ロールあり: role / repo / 両方 | なし: role / repo | 修正後の verify（あり／なし） |
|---|---|---|---|
| OpenCode V1 | 2 / 2 / 2 | 0 / 2 | OK / OK |
| OpenCode V2（ロールのみ） | 3 / 0 / 0 | 0 / 3 | OK / OK |
| Copilot | 2 / 2 / 2 | 0 / 0 | OK / **NG** |
| Codex | 1 / 3 / 1 | 0 / 3 | OK / OK |
| Command Code | 2 / 3 / 2 | 0 / 3 | OK / OK |
| Claude Code | **0** / 3 / 0 | 0 / 3 | OK / OK |

- ロールが能力を落とした例は無い（Copilot の NG は**なし**の側で、局所モデルの揺れ）。
- Claude は要求の system に本文が届いているが、局所モデルは従わなかった。Claude Code の長い system prompt と Ollama の文脈長の影響を切り分けていない。**本物のモデルで従うかは未確認**（§12）。Issue の合言葉テストは `-p` で読まれたと記録している。

## 10. 検証の方法と隔離

- **実 CLI + 確定モデル:** `harness/mock-model.mjs.txt` は Anthropic Messages / OpenAI Chat Completions / OpenAI Responses を話す小さなサーバーで、CLI の要求を全部記録する。`CMRUN<<…>>` を見るとシェルツールの呼び出しを返す。各 CLI の公式の差し替え口（`ANTHROPIC_BASE_URL`、`model_providers`、`providers.json`、`provider`/`providers`、`COPILOT_PROVIDER_BASE_URL`）で向けた。課金なし、認証の複製なし。
- **限界:** 確定モデルは「CLI が何を送り、ツールを実行できるか」を確かめるもので、モデルが従うかは確かめない。Claude は API キー経路で、製品の OAuth 経路ではない（起動時のダイアログが 1 枚増えた）。Command Code は BYOK 経路で、`--local-only` と架空のキーを足した。Copilot は `COPILOT_OFFLINE` の BYOK 経路。
- **隔離:** `HOME`、`XDG_*`、`CODEX_HOME`、`COPILOT_HOME`、`CM_DB_PATH`（`data/role-probe-4113.db`、`lsof` で確認）、`CM_OPENCODE_V2_DIR`、tmux は `-L cmrole4113*`。認証は一切複製していない。作業物は OS の一時ディレクトリ。終了時にサーバー・tmux・ポート・DB を片付けた。
- **隔離の外へ出た 2 件:** (1) 調査の初めに `agy agent` と各 CLI の `--help` / `--version` を本物のホームで実行した。`agy` は `~/.gemini/antigravity-cli/` のログを 1 本増やした（`cli.log` のリンク先。ログ以外の変更は見ていない。消していない）。(2) V2 の `OPENCODE_CONFIG_DIR` の試験と `user-dir-lost` で、プロバイダの設定が消えて試験の文面（`CASE=…`、修正のコマンド。秘密は含まない）が OpenCode の既定の無料モデルへ送られた。課金も認証もなし。
- **実行:** `PROBE_ROOT=<tmp> node flow.mjs <tool> <variant>` のように動かす。`*.mjs.txt` は lint の対象から外すための拡張子で、パスは `<WORKTREE>` / `<HOME>` に置き換えてある。

## 11. 本文に無い指摘（直していない）

1. **OpenCode V1 の `wait` が exit 124 になる。** ロールの有無によらず、確定モデルの構成で `status=ready`、`reason=hook_stop` のまま `isUnclassifiedActive=true`（`scraperReason=unknown_frame`）となり、`wait` が完了しない（`--on-prompt agent` は exit 10 `unclassified`）。ペインは 80 桁。短いパスでも同じ。実モデルでの再現は見ていない。`src/lib/detection` の V1 の待機画面の判定を要確認。
2. **新規の `CODEX_HOME` で `CM_CODEX_HOOK_TRUST` が既定（`auto`）のとき、hook の確認画面で send が exit 99。** ロールの有無によらず。`bypass` で回避して計測した。`src/lib/cli-tools/codex.ts` の確認画面の判定を要確認（0.166.0）。
3. **API キー経路の Claude で「Make auto mode your default permission mode?」のダイアログに `send` が 60 秒待って exit 99。** `hasSeenAutoDefaultNudge` が無いホームで出る。製品の OAuth 経路で出るかは未確認。
4. **公式文書との不一致:** OpenCode V2 の `instructions`（§7.1）。

## 12. 未確認の一覧

| 項目 | 理由 |
|---|---|
| Antigravity の注入以降の全部（§6.6） | 認証の複製が要る |
| Claude / Codex / Copilot / Command Code の**本物のモデル**がロールと `AGENTS.md` を同時に守るか | 認証の複製が要る。代わりに局所モデルで計測（§9）。到達は確定モデルで確認済み |
| Claude の `--system-prompt-snapshot off` での再開 | CommandMate が再開しないので省いた |
| OpenCode V2 の approval ダイアログの検出 | 確定モデルの課題で確認が出なかった |
| Command Code の mod による受領ファイル、V2 の `/api/agent` による適用確認 | #4115 で実装時に確かめる |
| 2 サーバーの同時生成、起動中の既定変更 | 実装が無い。#4114・#4115 の受入条件 |
| リポジトリ既定とシステム既定の継承 | 解決関数が無い。#4115 の受入条件 |

## 13. Issue 本文の表との差分

| Issue の記載 | 今回の結果 |
|---|---|
| Copilot 1.0.98 | 1.0.105 で確認 |
| Antigravity・Copilot のホーム配置は未確認 | Copilot は動く。Antigravity は一覧まで確認 |
| V2 は `OPENCODE_CONFIG_DIR` + `default_agent` で読まれた | 読まれるが、大域設定を置換するので採らない |
| V2 の `instructions` は読まれない | 大域ファイル、`~/`、glob でも読まれない |
| V2 の `agents.x.system` | 読まれる。`{file:}` も動く。組み込みの `build`・`plan` の上書きも動く |
