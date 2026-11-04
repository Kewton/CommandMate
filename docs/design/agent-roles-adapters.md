# 各 CLI へロールを渡す方法: 実機確認と adapter 契約（Issue #4113）

- 親: Epic #4112（決定 D1〜D5 はそちらが正）。この文書を読む後続: #4114（DB・生成物）、#4115（起動処理と Schedule）
- 状態: **調査と契約の確定のみ。`src/` と `tests/` は変えていない**
- 基準: develop `d5c581231`、CommandMate 0.49 系、schema v63。検証日 2026-11-03
- 改訂: 整合性レビューの指摘を受けて追試し、§1・§2・§3・§4・§5・§6.7・§7・§8・§9 を直し §14 を足した。追試の記録は `evidence/round2.json`。再レビューを受けて fingerprint を §5 で定義し、局所モデルを全文の判定で測り直した（`evidence/round3.json`）。3 回目の再レビューを受けて、修正の課題の判定基準を `sh verify.sh` の出力から `calc.sh` の出力へ変えた（§9。新しい計測はしていない）
- 生の記録: [`agent-roles-adapters/evidence/`](./agent-roles-adapters/evidence/)、再現用の harness: [`agent-roles-adapters/harness/`](./agent-roles-adapters/harness/)（§10）

## 1. 結論

| adapter | 渡し方（契約） | ロールの層 | 既定の指示 | 判定 |
|---|---|---|---|---|
| Claude Code | `--append-system-prompt-file <abs>` | system | 残る（追加） | **要求への到達まで成立**。API キー経路で確認 |
| Codex | `$CODEX_HOME/cm-role-<id>.config.toml` + `-p cm-role-<id>`。既存の `developer_instructions` を合成して書く | developer | 残る（追加）。ただし既存の `developer_instructions` は上書きされる | **要求への到達まで成立**（合成が必須）。独自プロバイダ経路で確認 |
| Command Code | 生成した mod + `--mod <abs>`（`appendSystemPrompt`） | system | 残る（追加） | **要求への到達まで成立**。BYOK 経路で確認 |
| OpenCode V1 | `OPENCODE_CONFIG_CONTENT={"instructions":[<abs>]}`（利用者の env と合成） | system | 残る（追加） | **要求への到達まで成立**。独自プロバイダ経路で確認 |
| OpenCode V2 | `OPENCODE_CONFIG_CONTENT={"agents":{<実効 agent>:{"system":"{file:<abs>}"}}}`。利用者の env と合成。本文は「共通指示 + ロール」 | system | **provider の基礎プロンプトは置換される** | **条件つき成立**（§7。判断 1） |
| Antigravity | `~/.gemini/config/agents/cm-role-<id>/agent.md` + `--agent` | 未確認 | 未確認 | **未確定**（認証の複製が要る。判断 2） |
| Copilot CLI | `$COPILOT_HOME/agents/cm-role-<id>.agent.md`（`infer: false`）+ `--agent` | system | 残る（追加）。ツールが 1 つ増える | **要求への到達まで成立**。BYOK 経路で確認 |

「要求への到達まで成立」は、実 CLI が本文をモデルへの要求に載せ、ツールの実行まで動いたことを指す。本物のモデルが従うかは別で、§9・§12 のとおり局所モデルでしか見ていない。

設計に効く発見は次の 5 つ。Issue 本文の見立てと違うものを含む。

1. **失敗しても CLI はロールなしで動き続ける経路が多い。** Codex の未知プロファイル、Command Code の欠落・不正な mod、OpenCode V1 の欠落した instructions、V2 の不正な env は、対照との画面の差が無いまま動く。Copilot TUI は未知 agent に `✗` を出すが、そのまま既定で続ける（§8）。「失敗時は止める」（#4112）は CLI の終了コードに頼れず、**起動前の検査が必須**。
2. **OpenCode V2 の `OPENCODE_CONFIG_DIR` は使えない。** 大域設定のディレクトリを追加ではなく置換するので、利用者のプロバイダ・モデル・agent が消える（§7.3）。#4112 の設計案の渡し方を変更する。
3. **OpenCode V2 の `default_agent` より、実効 agent の `system` 上書きが安全。** `default_agent` は利用者の既定を奪い、明示 `--agent` と既存の会話では無言で効かない。上書きならいずれでも効く（§7.1）。
4. **再開時の挙動はツールで正反対。** Claude / Codex は旧ロールを保持し続け、Copilot は明示すれば切り替わるが省略では保持、Command Code / V1 / V2（上書き方式）は起動ごとに差し替わる（§3）。CommandMate が再開するのは現状 V1 だけ。
5. **確かめた範囲で、ロールは検出と検証の結果を変えなかった。** send・hook・approval・`wait --verify`・契約タスクの結果は、確かめられた項目についてロールの有無で一致した（§4）。対象は Antigravity を除く 6 adapter で、V1 の `wait --verify` と契約タスク、V2 の approval、継承元の違いは確かめられていない。

## 2. 判断を仰ぐこと

**判断 1（OpenCode V2）。** provider の基礎プロンプトが置換され、開発の一般指針 13 行が要求から消える（§7.2）。ツール一覧は同じで、確定モデルでは修正から検証まで動いた。局所モデルの計測では、全文の判定で測り直しても、ロールだけでも共通指示つきでもロールと `AGENTS.md` の両方を 5/5 守った。**差は出ていないので、置換の害も共通指示の効果も確かめられていない**（1 モデル、短い問い）。推奨は、消える指針を補う保険として「CommandMate の短い共通指示 + ロール」を本文にし、UI と文書で「既定の指示の置き換え」と明示して出荷すること。効果の根拠があっての推奨ではない。代替は V2 を初回の対象から外すこと（D3 の変更）。公式文書の `instructions`（追加）は 2.0.18 では効かなかったので、版が上がって効くようになれば切り替える。

**判断 2（Antigravity）。** 本物のモデルへ届く確認には、ログイン済みのホームが要る。一時ホームは「not signed in」で止まり、認証の複製は禁止なので、一覧と失敗応答しか確かめていない。推奨は #4115 で Antigravity の adapter を**無効のまま実装**し、次のどちらかの後に有効化すること。

- (a) 利用者の了承のもとで専用の OS ユーザーで一度ログインし、§6.6 の手順を流す（`CM_UAT_ISOLATION=own-home` の方式に乗る）
- (b) 利用者が本人のホームで §6.6 の手順を実行してよいと決める（`~/.gemini/config/agents/` に新規ファイルを置くのは D4 の範囲）

成立しない場合の代替は §6.6。

## 3. ライフサイクル（すべて実 TUI。`evidence/lifecycle-resume.json`）

本文を V1→編集版 V2→なし と変えて 1 プロセスずつ起動した。セルは次のターンの要求に載っていた本文。OpenCode V2 は採用方式（`agents.build.system` の上書き）の結果（`evidence/round2.json` の `lifecycleV2Overlay`。`default_agent` 方式の結果は `lifecycle-resume.json`）。

| 手順 | Claude | Codex | Command Code | Copilot | OpenCode V1 | OpenCode V2 |
|---|---|---|---|---|---|---|
| 新規 + V1 | V1 | V1 | V1 | V1 | V1 | V1 |
| 再開 + V1 | V1 | V1 | V1 | V1 | V1 | V1 |
| 再開 + 編集版 V2 | **V1 のまま** | **V1 のまま** | V2 | V2 | V2 | V2 |
| 再開 + なし | **V1 のまま** | **V1 のまま** | なし | **V2 のまま** | なし | なし |
| 新規 + なし | なし | なし | なし | なし | なし | なし |
| 新規 + V2 | V2 | V2 | V2 | V2 | V2 | V2 |
| なしの会話を再開 + ロール | － | － | － | － | 効く | 上書きは効く（`default_agent` 方式は**効かない**） |

- 履歴はどの再開でも保たれた（`users` の数が増える。`history` の欄は最初の発言の語で判定しており、V2 の追試では対象の発言が別の会話にあるので false になる）。2 通目は Antigravity を除く 6 adapter で同じロールが載った（`evidence/tui-flows.json` の `turn2`）。
- Claude の保持は仕様。`--system-prompt-snapshot` の既定 `on` は初回の system prompt を記録し、圧縮まで再利用する（`claude --help`）。
- **CommandMate の起動行で再開するのは V1 だけ**（`-s`、`opencode.ts` の `recoverOpencodeSessionId`）。Claude / Codex / Command Code / Copilot / Antigravity の起動行に再開の引数は無く（`grep` で確認）、`launch.sh` も `-s` を渡さないので V2 も新規の会話になる。上の太字は、#4115 が再開を足すときの制約である。
- **サーバー再起動:** tmux の中のプロセスは生き続け、再起動後の send でも同じロールが載った（Antigravity を除く 6 adapter、`send-path.json` の `mock3`。V2 は `round2.json` の `sendPathV2Overlay` でも確認）。再接続ではロールを再注入しないので、適用状態は記録が無ければ「不明」とする（#4112 の方針どおり）。
- **ロール編集:** 稼働中のプロセスには届かない。生成物を不変にして新しい版を作る前提で、次の起動から効く。上の表のとおり、再開つきの Claude / Codex では効かない。
- **明示的になし:** 起動行に何も足さないだけで、新規の会話からは消える。

## 4. send 経路と自動処理（`evidence/send-path.json`）

隔離した CommandMate（`tsx server.ts`、別ポート、私設 tmux、一時 DB）の実 API と実 CLI で、起動行にロールを足す PATH シムを挟んで流した。シムは #4115 の起動行の代わりで、コードは未変更。`launchLinesViaShim` に実際の引数がある。下の表の V2 列は採用方式（上書き + 共通指示。`round2.json` の `sendPathV2Overlay`）の結果で、`default_agent` 方式でも同じ結果だった（`send-path.json`）。

| 確認 | Claude | Codex | Command Code | Copilot | V1 | V2 |
|---|---|---|---|---|---|---|
| 1 通目のロールの層 | system | developer | system | system | system | system |
| `wait` の完了の根拠 | `hook_stop` | `hook_stop` | `hook_stop` | `hook_stop` | **124**（下記） | `hook_stop` |
| approval を検出（`wait --on-prompt agent` が exit 10） | はい | はい | はい | はい | はい（外部ディレクトリ） | 確認が出ない |
| 検証コマンドが成功（ツール結果 `VERIFY_OK`） | 承認後 | 承認後 | 承認後 | 承認後 | 確認なしで実行 | 確認なしで実行 |
| `wait --verify` | 0 | 0 | 0 | 0 | `verify` 単体で 0 | 0 |
| サーバー再起動後の send にロール | はい | はい | はい | はい | はい | はい |
| 契約タスク（`send --contract`）→ `wait --verify` | 0 | 0 | 0 | 0 | **未確認**（`wait` が完了しない） | 0 |
| ロールなしの対照と結果が一致 | はい | はい | はい | はい（ツール数は 21 / 20） | はい | はい |

- Claude の `fix` 段の exit 99 は harness の `verify.yaml` に `baseRef` が無かったため（両対照とも同じ）。直した後の契約タスクは 0。
- **V1 の `wait` は、ロールの有無によらず exit 124 になった**（§11 の指摘 1）。状態は `ready` / `hook_stop` まで進み、画面だけが `unknown_frame` で止まる。`commandmate verify` は exit 0（契約なしの実行）。`respond --default` は構造化された承認に答えられず exit 99 で、V1 の承認から実行までの流れは通していない（ロールの有無によらず同じ。`approvalExternalDirectory`）。
- **V1 の `prompt_async`:** 2 通目以降は `opencode-send-delivered-via-api` のログのとおり API で届き、ロールが載った。persona `plan` と併用しても、起動行 `--agent plan`、3 通とも role と repo と plan の指示が同時に載った（`persona`）。
- **V2 の serve と TUI:** 設定を読むのは **serve だけ**。serve にだけ env を渡すと効き、TUI にだけ渡すと効かない（`v2-env-and-resume.json`）。`launch.sh` は両方へ env を継ぐので、起動行の env で足りる。
- **V2 の approval:** `external_directory` の外部参照でも確認が出ず（ロールの有無によらず）、ダイアログの検出は比較できていない。
- **リポジトリとシステムのどちらの既定を継いでも同じか:** adapter の入力は解決済みの `ResolvedRole` だけで、渡し方は継承元に依存しない（#4112）。継承元ごとの実機確認は解決関数のある #4115 の受入条件とする。

### Schedule（`evidence/round2.json` の `scheduleEntry`）

現行の入口 `executeClaudeCommand` を実 CLI と確定モデルで通した。ロールは PATH シムが足す（入口は未変更）。実行したのは入口が組む `getCommandForTool` + `buildCliArgs` の通りで、Copilot は **`gh copilot …`** である。

| 入口の実行内容 | ロール | 検証コマンド | status / exit | 備考 |
|---|---|---|---|---|
| `claude -p <M> --output-format text --permission-mode bypassPermissions` | system | `VERIFY_OK` | completed / 0 | |
| `claude -p … --permission-mode acceptEdits`（既定） | system | **両対照とも実行されない** | completed / 0 | 変数を含むコマンドの確認。ロールと無関係 |
| `codex exec <M> --sandbox workspace-write` | developer | **両対照とも実行拒否** | completed / 0 | ロールと無関係。`-p` は `exec` の前 |
| `commandcode -p <M> --output-format json --yolo --no-auto-update` | system | `VERIFY_OK` | completed / 0 | 確定モデル用に `--local-only -m` をシムが足した |
| `opencode run --format json [--agent plan] <M>` | system | `VERIFY_OK` | completed / 0 | |
| `opencode2 run --standalone --format json [--agent plan] -- <M>` | system | `VERIFY_OK` | completed / 0 | 実効 agent の上書き |
| `gh copilot -p <M> --allow-all-tools` | system | `VERIFY_OK` | completed / 0 | 実行ファイルは PATH の `copilot`。`--agent` は `gh copilot --agent <id> -p …` の形でも通り、未知は exit 1（`No such agent`） |

- **`gh copilot` の前提:** `gh` 2.86.0。PATH に `copilot` が無いと `! Copilot CLI not installed` で exit 1。`gh` のログインなしで BYOK の確定モデルへ届いた。
- 前回の `evidence/schedule-headless.json` は入口を通さず手で組んだ argv で（Copilot は `copilot` の直接実行、Command Code は `cmd`、Claude は `bypassPermissions` を明示）、形の参考に残す。未知の名前などの失敗応答はそちらの記録である。
- `continueSession`（V1・V2 の `-c`）は入口を通していない。再開の挙動は §3。
- Antigravity の headless は認証で止まる（未確認）。明示 `agent` の規則は §7.1 と各節。

## 5. 共通の契約（#4114・#4115 向け）

**fingerprint は 3 種類に分ける。** 比べる相手が違うので混ぜない。いずれも SHA-256。

| 名前 | 入力 | 計算する所 | 持つ所 | 比べる相手 | 用途 |
|---|---|---|---|---|---|
| **本文 fingerprint** | ロールの本文の UTF-8 バイト列だけ | #4114 の解決関数 | `ResolvedRole`、起動の記録 | 起動の記録の本文 fingerprint | 「本文が変わった」の表示と、注入 fingerprint の入力。**起動前の検査と再起動待ちの判定には直接使わない** |
| **注入 fingerprint** | adapter の ID と版、wrapper の版、本文 fingerprint、合成の入力（Codex の既存の `developer_instructions`、V2 の実効 agent、明示 `agent`）。ロール名、role ID、継承元、パス、利用者の env の他のキーは入れない | #4115 の純粋な変換処理 | effectiveNext、`requested`、`launched` | effectiveNext と `launched` の差、同時起動どうし、実入力の直前の確認 | 再起動待ち、起動の合流の可否、`send --role` の条件。生成物の名前のハッシュ |
| **生成物 fingerprint** | 生成するファイルの全バイト（Codex の TOML、Command Code の mod、Copilot / Antigravity の frontmatter つき定義、V1 / V2 の本文ファイル） | #4114 の書き込み処理が、書く前のバイト列で | 起動の記録 | 同名の既存ファイル、起動直前に読み直したファイル（Codex は全バイトが違うとき、`developer_instructions` から作り直した内容。#4136） | 再利用か拒否か、起動前の検査 1 |

- **生成物の名前は注入 fingerprint から作る**（`cm-role-<namespace>-<role ID>-<注入 fingerprint の先頭>`）。生成物 fingerprint を名前に使うと、名前を含む frontmatter との間で循環する。
- 本文が同じでも、合成の入力や adapter・wrapper の版が変われば、注入 fingerprint も生成物も変わる。これは正しい動きで、起動は拒否しない。
- role ID は生成物の名前と frontmatter に入るが注入 fingerprint には入らないので、本文が同じ別のロールへ替えても再起動待ちにならない。
- 合成の入力を読めず注入 fingerprint を計算できないときは、再起動待ちを「不明」にする。起動なら未送信のエラーにする。
- 合成後の `OPENCODE_CONFIG_CONTENT` のファイル（§7.1）は秘密を含みうる起動ごとのファイルで、生成物に数えず、ハッシュも記録しない。
- **ここまでは設計で、実装が無いので未実測。**

**生成物。** 不変で、注入 fingerprint ごとに別の名前。親 0700、ファイル 0600。新規排他作成か一時ファイルからの rename で公開する。同名の既存ファイルは、生成物 fingerprint が同じなら再利用し、違えば拒否する（Codex の例外は §6.2。Codex 自身がプロファイルへ書くため）。symlink を辿らない。worktree に置かない。ホーム解決は既存の resolver を使う（`CODEX_HOME`、`COPILOT_HOME`）。削除しない（#4112）。

**本文を起動行に出さない。** 起動行はパスと ID だけ。Antigravity を除く 6 adapter で実際にこの形で動かした（`{file:}` は V2 2.0.18 で動いた）。Antigravity は `--agent` だけの形で、モデルまでは未確認。利用者の `OPENCODE_CONFIG_CONTENT` と合成するときは §7.1 の注意を守る。

**起動前の検査（必須）。** 次を確かめ、失敗したら本文を送らず起動失敗にする。CLI に任せない（§8）。

1. 生成物が在り、読め、読み直したバイト列のハッシュが、書き込み処理の返した**生成物 fingerprint** と一致する。Codex は全バイトが違えば、`developer_instructions` の値から作り直した内容のハッシュで比べる（§6.2）。本文 fingerprint とは比べない（合成があるので一致しない）
2. 形式の検査（Codex は TOML を読み直す。Command Code は構文の確認。Copilot / Antigravity は frontmatter を読み直す。V1 / V2 は JSON を読み直す）
3. 本文が空なら「ロールなし」扱いにせず拒否する（Claude は空ファイルで素のまま動いた）

**適用の確認。** 起動行に足しただけでは `launched` にしない。起動を確認した証拠が無ければ「不明」と表示する。手段は §14 の表に adapter ごとに書く。実測できたのは V2 の `GET /api/config`（解決後の本文を含む。`/api/agent` は本文を含まない）と Copilot の画面の `✗`、Claude / Codex の起動失敗の exit だけで、Command Code の受領ファイルと V1 の設定 API は未実測。

**本文の形式。** §8 のとおり、Antigravity を除く 6 adapter で要求への一致を確かめた。

**上限。** CommandMate の上限は #4114 の 16 KiB（16,384 バイト）とする。CLI 側の上限は見つけていない（16,385 バイトも届いた）。それより大きい本文は試していない。合成後の生成物（V2 の共通指示、Codex の既存の指示）はこの上限を超えうるので、上限は本文に対して掛け、生成物には掛けない。

**ロールの強さ。** ロールは system / developer に入るので、後から user メッセージで届く契約と衝突しうる。#4115 の共通 wrapper に「現在の依頼とリポジトリの指示を優先する」を入れる案は、局所モデルの計測で効果を確かめられていない（§7.2）。V2 以外の adapter には wrapper をかけた実測が無い。プロンプトだけの保証にはしない。ゲートはこれまでどおり証拠で判定する。

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

- **起動行（#4115）:** ロールがある起動だけ、先頭に `CODEX_HOME=<生成物のホーム>` を付ける。未知のプロファイルは素のまま動くので、CLI が生成物と別のホームを読まないようにするため。ロールなしの起動行は変わらない。下の表は #4113 の実測時のもの。
- **渡し方:** `-p cm-role-<id>`。サブコマンドより前に置く（`codex -c features.daemon_auto_start=false [--no-daemon] -p <id>`、`codex -p <id> exec …`）。生成物は TOML で、本文は基本文字列（JSON の文字列表現で可。`"""` を含んでも一致した）。
- **合成（実測）:**
  - `model` など他のキーは `config.toml` から継ぐ。
  - **`config.toml` の `developer_instructions` はプロファイルの同名キーに上書きされる。** 生成物に「既存の本文 + ロール」を書く。
  - `-p a -p b` は **exit 2**（`cannot be used multiple times`）。
  - **未決事項の結論:** CommandMate の起動行に `-p` は無いので、合成すべきは `config.toml` の `developer_instructions` だけ。既存プロファイルを使いたい利用者には、`<name>.config.toml` と `developer_instructions` を合成した生成物で両立できることを確認した（`merged-generated-profile`: モデルと両方の本文が残る）。ラッパーが `-p` を足す運用は exit 2 で起動失敗になるので気づける。`-c developer_instructions=…` でも両立するが本文が argv に出るので不採用。`model_instructions_file` は置換なので不採用。TOML の読み書きは新規の依存が要る（現在の依存に TOML は無い）。
- **再開:** `resume --last` では旧本文を保持（§3）。CommandMate は再開しない。
- **Codex が書き込む（#4136）:** `-p` で起動すると、フォルダの信頼は `config.toml` ではなくプロファイルに保存される（`[projects."<path>"]`、0.166.0 で実測）。CommandMate は書き戻さず、Codex の生成物に限り `developer_instructions` の一致で判定する。信頼はこのプロファイルに閉じるので、別のロールやロールなしのセッション、本文を変えた後の新しい版では再度訊かれる。
- **失敗時:** **未知のプロファイル → 素のまま動く（TUI は対照との画面の差なし、`exec` は exit 0）**。不正な TOML → exit 1（行番号つき）。読めない → exit 1。

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
- **合成:** 配列は既存の `instructions` と**足される**。persona（`--agent plan`、`prompt_async` の `agent`）と併用可。`model` は既存の設定を継ぐ。利用者が同名の env を持つ場合は §7.1 と同じ手順で合成する。env だけに `model` / `provider`、`default_agent`、`instructions` を持つ場合に、合成後も `model-b`、`Plan`、利用者の指示とロールの両方が効くことを確かめた（`round2.json` の `compose`）。JSON の誤りは exit 1 だが、合成の段で未送信のエラーにする。
- **再開（未決事項の結論）:** `-s` で再開すると、**ロールは新しい本文へ差し替わり、履歴は残る**。ロールなしの会話に後からロールを付けても効く。

  **既定は「続ける」**とし、次回の起動でロールが変わるなら、画面と `send` の応答で「旧ロールの発言が履歴に残ったまま続く」ことを伝える。新しい会話を選べるようにし、選んだときは記憶している会話 ID（`opencode-session-store`）だけを捨てる。履歴は消さない。無断で新しい会話へ切り替えない。
- **失敗時:** **`instructions` の欠落 → 対照との画面の差なしで素のまま。読めないファイルも要求にロールが載らない（画面の比較はしていない）**。JSON の誤り → exit 1（入力の全文を画面に出す。ゆえに本文も秘密も env に入れない）。
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

契約は §7。下の記録は採用方式（`round2.json` の `flowsV2Overlay`）。

| 項目 | 記録 |
|---|---|
| 版 | opencode v2.0.18 |
| argv | `bash scripts/opencode-v2/launch.sh --port 18211 --password-file <D>/home/pw --directory <D>/repo --executable /opt/homebrew/bin/opencode2` |
| env | `OPENCODE_CONFIG_CONTENT={"agents":{"build":{"system":"{file:<D>/home/.cmrole/role-x.md}"}}}` |
| 生成物 | `role-x.md`（この記録は本文のみ。共通指示つきは §4 の send 経路と §7.2） |
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

**実行する手順（判断 2 の後）:** `agent-roles-adapters/harness/` の Q1・Q2 と同じ問いを、`--agent cm-role-x` あり／なしで流し、`AGENTS.md` と本文の両方が守られるか、修正後の `sh calc.sh` の出力が `2` か、元の verify.sh（`git show HEAD:verify.sh`）の exit を比べる。応答は `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` でも確かめる。

**成立しない場合の代替:** 定義が既定を置換すると判明したら、V2 と同じく「共通指示 + ロール」にする。`--agent` が TUI で効かないなら、Antigravity を対象から外すことを判断してもらう（D3 の変更）。`~/.gemini/config` の既存ファイルは書き換えない。

### 6.7 Copilot CLI

- **起動行（#4115）:** ロールがある起動だけ、先頭に `COPILOT_HOME=<生成物のホーム>` を付ける。ロールなしの起動行は変わらない。下の表は #4113 の実測時のもの。
- **渡し方:** `$COPILOT_HOME/agents/cm-role-<id>.agent.md` + `--agent cm-role-<id>`。frontmatter は `name`、`description`、`infer: false`。**ホーム配置は実測で動いた**（Issue の未確認を解消）。
- **合成:** `.github/copilot-instructions.md`・`AGENTS.md` と同時に載る。base は 100% 残存。ツールは `update_todo` が 1 つ増える（対照 20 → 21）。
- **他のセッションへの影響:** `infer: false` なら `--agent` なしの別セッションの要求に名前も本文も出ない。`infer: true` と省略は名前が出る（本文は出ない）。**`infer: false` は必須。**
- **再開:** `--continue --agent <新>` は新しい本文へ替わる。**`--agent` を省くと前のロールを保持する**ので「明示的になし」にならない。CommandMate は再開しない。
- **失敗時:** **TUI は未知 agent と壊れた frontmatter で `✗ Custom agent … not found` / `✗ Failed to select agent…` を画面に出し、既定の agent のまま続ける（exit しない）。** 前回は画面の末尾しか見ておらず「無言」と書いたが、誤りだった。headless は未知 agent で exit 1（`No such agent`）。
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

**実効 agent を決める順序（実測）。** 上ほど強い。

1. Schedule の明示 `agent`（`--agent`）
2. 利用者の `OPENCODE_CONFIG_CONTENT` の `default_agent`
3. プロジェクトの設定の `default_agent`（`opencode.jsonc`、`.opencode/opencode.jsonc`）
4. 大域の設定の `default_agent`
5. `build`

`order-*` で 2 > 3 > 4 を確かめた。両方のプロジェクト設定が同時にある場合の優先は見ていない。設定が JSONC なので読取りには JSONC のパーサーが要る。**順序の解決に失敗したら（読めない、JSONC として不正）推測せず未送信のエラーにする。**

**利用者の既存の `OPENCODE_CONFIG_CONTENT` との合成（V1・V2 共通の手順）。**

1. 起動するペインの環境の値を読む。無ければ合成なしで生成する
2. JSONC として読む（V2 はコメントつきを受け付けた）。**不正なら未送信のエラー。** 渡すと V1 は exit 1 だが、**V2 は無言で無視してロールなしで動く**（`invalid-user-env-unmerged`）
3. 値を保ったまま足す。V1 は `instructions` の配列の末尾へ追加。V2 は `agents.<実効 agent>.system` だけを足し、同じ agent の他のキーは残す。`model`、`provider(s)`、`default_agent` などに触れない
4. **実効 agent に利用者の `system`（env、大域、プロジェクト）か Markdown 本文があれば未送信のエラー。** 上書きすると利用者の本文は要求から消える（`env-user-system-overwritten`、`overlay-over-user-system`、`overlay-on-user-markdown`）
5. 合成しないと env の値は全部失われる（`env-replaces-not-merged`）ので、丸ごと置き換えない

**env に秘密が入りうる。** 利用者の値には API キーが入りうるので、合成後の値を起動行へ書かない（tmux の画面に残る）。生成物と同じ権限のファイルに書き、`OPENCODE_CONFIG_CONTENT="$(cat <file>)"` の形で渡す（**この形は未実測**。#4115 で確かめる）。利用者の値が無いときは、パスだけの JSON なので起動行に書いてよい。

**読むべき env の所在。** ペインは tmux サーバーの環境を継ぐので、CommandMate のプロセスの環境と一致するとは限らない。対話起動は tmux の環境、Schedule は `sanitizeEnvForChildProcess` の結果を読む（**どちらも未実測**）。

**確かめたこと（確定モデルの TUI。`round2.json` の `compose`）。**

| 利用者の設定 | 合成の結果 |
|---|---|
| env だけに `model` + `providers`（大域の設定は空） | `model-b` で動き、ロールが載る |
| env に `default_agent: plan` | `Plan` のままロールが載る |
| env に `default_agent: mine` + `agents.mine` | `Mine` のままロールが載る |
| 大域の `agents.build.model` | `model-b` のままロールが載る（`overlay-keeps-other-keys`） |
| 大域の `default_agent: plan`、明示 `--agent plan` | `Plan` のままロールが載る（`overlay-user-default-plan`、§4） |
| なしで作った会話の再開 | ロールが載る（§3） |

**足りないもの:** 組み込み以外の agent を実効 agent にした場合の開発能力、`.opencode/agents/*.md` の検出。

**採らなかった案。**

| 案 | 結果 |
|---|---|
| `instructions`（CONTENT、DIR、大域ファイル、`~/`、glob、URL） | 2.0.18 では**どの形でも本文が届かない**（公式文書と不一致） |
| `OPENCODE_CONFIG_DIR` | 大域設定を置換する（§7.3） |
| `default_agent` + `agents.x` | 動くが、利用者の既定を奪い（`role-with-user-default`）、`--agent` と既存の会話で無言で消える |
| `~/.config/opencode/AGENTS.md` | 届いて既定の指示も残るが、既存ファイルの書き換えになり D4 に反する |
| `agents.x.hidden: true` | `default_agent` が無言で `build` へ戻る |
| `mode: subagent` | 同上 |

### 7.2 開発能力（未決事項の結論）

文書のとおり provider の基礎プロンプトが置換される。採用方式でも要求から一般指針 13 行が消えた（残存率 84.3%。`round2.json` の `flowsV2Overlay`）。環境情報、Code Mode の説明、ツール一覧、`AGENTS.md` は残った。

- `You are an AI agent running in OpenCode…`
- `Prefer dedicated tools over shell commands…`
- `Treat unfamiliar files or changes as potential user work…` など

**計測（qwen3-coder:30b、「2+2」を 5 回。§9 と同じ条件。`round3.json`）。** 衝突しない指示で、最終回答の全文の先頭の語が `ROLESTAMP`、末尾の語が `REPOSTAMP` かを数えた。修正の課題は 1 回で、作業ツリーを戻してから出した。修正の判定は §9 のとおり、記録された `calc.sh` の出力が元の条件の `2` か。

| 本文（`agents.build.system`） | 先頭 = ロール | 末尾 = `AGENTS.md` | 両方 | 修正後の `calc.sh` の出力 |
|---|---|---|---|---|
| ロールのみ | 5/5 | 5/5 | **5/5** | `2`（成功） |
| 共通指示 + ロール | 5/5 | 5/5 | **5/5** | `2`（成功） |
| なし（対照 1 回目） | 0/5 | 4/5 | 0/5 | `2`（成功） |
| なし（対照 2 回目） | 0/5 | 4/5 | 0/5 | `100`（**失敗**） |

対照は同じ構成を 2 度測ったもので、2 回目は「2+2」の 1 回が exit 1 で、修正の課題は失敗した（`calc.sh` は `echo "100"`、`sh verify.sh` の出力は元の verify.sh に無い `VERIFY_FAIL`。verify.sh も書き換えられたと推定する。§9）。同じ構成でもこの程度は揺れる。

**結論。** 共通指示の有無で差は無かった。**基礎プロンプトの置換で指示の保持が落ちる証拠も、共通指示で良くなる証拠も無い。**

**訂正。** 前回の表は「ロールのみ 0/3、共通指示 3/3」として共通指示の効果を示したが、ロールと `AGENTS.md` がどちらも「末尾を自分の語で終える」という両立しない指示で、判定も `includes` だった。回答は `REPOSTAMP` で終わり `ROLESTAMP` は途中にあるので、同時遵守の根拠にならない。この結果は取り下げる（`real-model-local.json` と `harness/v2w.mjs.txt` は経緯として残す）。

**結論（開発能力）。** 確定モデルと局所モデルの範囲では能力の低下を確かめていない。難しい課題、長い作業、本物のモデルでの差は未確認。本文は `harness/realmodel.mjs.txt` の `COMMON` に当たる共通指示 + ロールを推奨する（判断 1）。「既定の指示と同等」とは表示しない。

### 7.3 `OPENCODE_CONFIG_DIR` が使えない根拠

`opencode2 debug config` の情報源の一覧で、指定すると大域の `~/.config/opencode/opencode.jsonc` が消える。実際に、プロバイダの設定を失ったセッションは既定のモデルへ落ちた（`user-dir-lost`、`opencode-v2-agent-md-x`）。

### 7.4 失敗時

| 入力 | 応答 |
|---|---|
| `{file:}` の先が無い | TUI が exit 1（スタックトレース、500） |
| JSON の誤り | **無言で無視してロールなしで動く**（`invalid-user-env-unmerged`）。前回の「要求が出ない」は待ち時間が足りなかった誤りで、訂正する |
| 未知の `default_agent` | **対照との画面の差なしで `build` へ戻る** |
| `hidden`、`mode: subagent` の agent を `default_agent` に | `build` へ戻り、ロールが載らない（画面の比較はしていない） |
| `run --agent` の未知 agent | exit 1 `Agent not found` |

**注意:** `opencode2 debug config` などは常駐の service に繋ぐので、最初に起動した環境の設定を返す。検証では `service stop` を挟むこと。

## 8. 失敗時の応答の一覧（`evidence/fail-format-compose.json`、`schedule-headless.json`、`round2.json` の `silent`）

「差なし」は、同じ操作をしたロールなしの対照と全画面（履歴 1000 行）を比べ、失敗を示す行が無かったもの。Codex の画面の `⚠ 1 warning` は対照にも出たので、中身までは見ていない。一時ホームの `*.log` にも該当する行は無かった。

| adapter | 欠落 | 不正 | 読めない | 未知の名前 |
|---|---|---|---|---|
| Claude | exit 1 | － | exit 1 | － |
| Codex | **差なし** | exit 1 | exit 1 | **差なし**（TUI）、**exit 0**（`exec`） |
| Command Code | **差なし** | **差なし** | － | － |
| OpenCode V1 | **差なし** | exit 1（env の JSON） | 対照との比較なし（要求にロールなし） | － |
| OpenCode V2 | exit 1（`{file:}`） | **差なし**（env の JSON。無視される） | － | **差なし** |
| Copilot | － | `✗` を出して既定で続行（TUI） | － | `✗` を出して既定で続行（TUI）/ exit 1（`-p`） |
| Antigravity | － | 一覧から消える | － | exit 1（`-p`）/ TUI は未確認 |

書き込み不可は生成の段階で失敗するので CLI へ渡らないはずだが、生成処理が無いので未実測。#4114 で「未送信のエラー」にする。すでに在る定義は、親が読み取り専用でも読める（Copilot `unwritable-home`）。

**形式の対象。** Antigravity を除く 6 adapter（Claude、Codex、Command Code、V1、V2、Copilot）。Antigravity は未確認。

**本文。** 改行、`"`、`'`、バッククォート、`"""`、`'''`、行だけの `---`、`$HOME`、`$(…)`、`{file:…}`、`{env:…}`、`<tag>`、日本語を含む本文に、埋め草を足して次のサイズに揃えた（`round2.json` の `format`）。

| 本文 | バイト数 | 比較 | 結果 |
|---|---|---|---|
| 末尾の改行なし | 16,384 | 要求の system + developer が本文を**そのまま部分文字列として含む**（trim なし） | 6 adapter とも一致 |
| 末尾に改行 | 16,384 | 同上（末尾の改行まで含めて） | 6 adapter とも一致 |
| 末尾の改行なし | 16,385 | 同上 | 6 adapter とも一致 |

**比較の範囲。** 復号した JSON の文字列の比較であり、ネットワーク上のバイト列の比較ではない。本文の前後に CLI が付ける文字（見出しなど）は問わない。Copilot と V2 の Markdown / `{file:}` でも本文は保たれた。前回の `fmt-*` は 16,319 バイトと trim 後の比較で、`round2.json` に置き換える。

**空白入りのパス。** Claude、Command Code、V1、V2 はファイルのパス、Codex と Copilot はホームのパスで確かめた。本文は短いもの。

## 9. 指示の保持と開発能力の判定

**判定の材料。** モデルの申告は使わない。

- CLI が実際に送った要求（system / developer / user の各層）を確定モデルで記録し、ロールと `AGENTS.md` の層、ツール一覧、ロールなしの対照との行単位の残存率を比べた
- 確定モデルがシェルツール呼び出しを返し、CLI が実行した結果と、`calc.sh` の実際の変化を見た
- 実モデルの代わりに手元の Ollama（課金なし、認証なし）で、応答の文字列と、修正後の `calc.sh` の出力を見た（`round3.json`）

**局所モデル（qwen3-coder:30b）。** ロールは「最初の語を `ROLESTAMP` にする」、`AGENTS.md` は「最後の語を `REPOSTAMP` にする」で、両立する。「2+2」を 5 回。**判定は最終回答の全文を英数字の語に分けた先頭と末尾**で、途中に出ても数えない。表示用の切り詰めは判定の後に別に行う（`answersForDisplay`）。最終回答は、V1 / V2 が最後の text part、Copilot が `--output-format json` の最後の `assistant.message`、Command Code が `finalText`、Claude / Codex が標準出力の全文。反復ごとに作業ツリーを戻し、修正の課題も戻した状態から 1 回出した。「2+2」の exit は、V2 の対照 2 回目の 1 回（exit 1）を除いて 0。

**測り直しの理由。** 前回の判定は JSON でない出力（Copilot）の末尾 200 文字を見ており、先頭を見ていなかった。全ツールを測り直した。また前回は「2+2」の反復の間に作業ツリーを戻しておらず、問いの途中でモデルが `calc.sh` を直すと修正の課題の結果が汚れた（Copilot のロールなしは今回も 5 回中 2 回、Command Code のロールなしは 1 回、問いの最中にリポジトリを変えた。`q1ChangedRepo`）。

| ツール | ロールあり: 先頭 / 末尾 / 両方 | なし: 先頭 / 末尾 | 修正の成否（あり／なし） |
|---|---|---|---|
| OpenCode V1 | 0 / 4 / **0** | 0 / 5 | 成功 / 成功 |
| OpenCode V2（ロールのみ） | 5 / 5 / **5** | 0 / 4 | 成功 / 成功 |
| OpenCode V2（共通指示 + ロール） | 5 / 5 / **5** | 0 / 4 | 成功 / **失敗**（`100`） |
| Copilot | 0 / 5 / **0** | 0 / 5 | 成功 / **失敗**（`3`） |
| Codex | 2 / 5 / **2** | 0 / 5 | 成功 / 成功 |
| Command Code | 0 / 5 / **0** | 0 / 5 | 成功 / 成功 |
| Claude Code | 0 / 5 / **0** | 0 / 5 | 成功 / 成功 |

**修正の判定基準（今回変えた）。** `round3.json` の `calc`（課題の後の `calc.sh` の中身）を `sh` で実行し、出力が元の条件（`harness/lib.mjs.txt` の `repoSeed` の verify.sh が求める `2`）なら成功とする。14 件を判定し直した。新しい計測はしていない。

**前の基準の誤り。** 前の版の表は harness が実行した `sh verify.sh` の出力（`verifyAfter`）で判定していたが、モデルは verify.sh も書き換えられるので、修正の証拠にならない。

- Copilot のロールなし: `calc.sh` は `echo 3` のままなのに `VERIFY_OK` で、前の版は OK と書いていた。
- V2 の対照 2 回目: `calc.sh` は `echo "100"`、出力は元の verify.sh に無い `VERIFY_FAIL`。exit も 0。

どちらも verify.sh が書き換えられたというのは **`calc` と出力からの推定**で、課題の後の verify.sh の中身は記録に無い。出力が `2` の 12 件も、verify.sh が書き換えられていないとは確かめていない。`calc.sh` の出力だけを見ている。また `verifyAfter` はこの限界があるので、今後の計測では元の verify.sh を `git show HEAD:verify.sh` で取り直して実行する（`realmodel.mjs` は未変更）。

**前回との差。** Claude のロールありの先頭が 1 → 0、V2 のロールなしの末尾が 5 → 4（2 回とも）。Claude と V2 の回答はどちらの回も短く切り詰めの影響を受けないので、反復の揺れと読む。切り詰めの影響を受けていた Copilot は、全文で測っても 0 / 5 / 0 と 0 / 5 で数字は変わらなかった。結論は変わらない。

- **同時遵守を確かめられたのは V2 だけ。** Claude、Command Code、Copilot、V1 は 0/5、Codex は 2/5 で、確定モデルでは本文が要求に届いているのに、この局所モデルはロールにほとんど従わなかった。`AGENTS.md` はロールありの全構成で 4/5 以上（V1 が 4/5、他は 5/5）。
- **これは CLI の渡し方の失敗とは言えない。** 1 モデル、5 回、短い問いの結果で、追加型の長い system prompt の中の 1 行が弱い可能性はあるが、切り分けていない。**本物のモデルで従うかは未確認**（§12）で、追加型の 5 adapter は判断の材料が足りない。#4115 の手動の受入で確かめる。
- 切り分けの試み: Claude の要求の system（6,445 文字の部分）とロールを Ollama へ直接渡すと、文脈長の指定によらず 6/6 従った（`claudeDiag`）。ただしツール定義と会話の前置きを含まないので、CLI 経由の結果の原因は説明できていない。
- 修正の課題は、ロールありの 7 構成がすべて成功し、ロールなしは 7 回中 2 回失敗した（Copilot、V2 の対照 2 回目）。ロールがあると修正が良くなるとは読まない。各 1 回で、失敗した 2 回は課題の最中に検証の側まで変えたと推定され、モデルの揺れと区別できない。ロールが修正の能力を落とした例はこの範囲に無いが、能力が同等とまでは言えない。
- 最初の表（`real-model-local.json`）は両立しない指示と `includes` の判定で、「両方」の列は同時遵守を示さない。取り下げる。`round2.json` の `realNonConflicting` は末尾 200 文字の判定を含むので、`round3.json` に置き換える。

## 10. 検証の方法と隔離

- **追試の harness:** `round2.mjs`（合成、形式、全画面）、`entry.ts`（Schedule の入口）、`realmodel.mjs`（両立する指示）、`claudediag.mjs`、`v2api.mjs`。`cm.mjs` と `lib.mjs` は採用方式へ更新した。
- **実 CLI + 確定モデル:** `harness/mock-model.mjs.txt` は Anthropic Messages / OpenAI Chat Completions / OpenAI Responses を話す小さなサーバーで、CLI の要求を全部記録する。`CMRUN<<…>>` を見るとシェルツールの呼び出しを返す。各 CLI の公式の差し替え口（`ANTHROPIC_BASE_URL`、`model_providers`、`providers.json`、`provider`/`providers`、`COPILOT_PROVIDER_BASE_URL`）で向けた。課金なし、認証の複製なし。
- **画面の採取:** 前回は失敗の判定に画面の末尾しか使わず、Copilot の `✗` を見落とした。追試は全画面を対照と比べた。
- **限界:** 確定モデルは「CLI が何を送り、ツールを実行できるか」を確かめるもので、モデルが従うかは確かめない。Claude は API キー経路で、製品の OAuth 経路ではない（起動時のダイアログが 1 枚増えた）。Command Code は BYOK 経路で、`--local-only` と架空のキーを足した。Copilot は `COPILOT_OFFLINE` の BYOK 経路。
- **隔離:** `HOME`、`XDG_*`、`CODEX_HOME`、`COPILOT_HOME`、`CM_DB_PATH`（`data/role-probe-4113.db`、`lsof` で確認）、`CM_OPENCODE_V2_DIR`、tmux は `-L cmrole4113*`。認証は一切複製していない。作業物は OS の一時ディレクトリ。終了時にサーバー・tmux・ポート・DB を片付けた。
- **隔離の外へ出た 2 件:** (1) 調査の初めに `agy agent` と各 CLI の `--help` / `--version` を本物のホームで実行した。`agy` は `~/.gemini/antigravity-cli/` のログを 1 本増やした（`cli.log` のリンク先。ログ以外の変更は見ていない。消していない）。(2) V2 の `OPENCODE_CONFIG_DIR` の試験と `user-dir-lost` で、プロバイダの設定が消えて試験の文面（`CASE=…`、修正のコマンド。秘密は含まない）が OpenCode の既定の無料モデルへ送られた。課金も認証もなし。
- **実行:** `PROBE_ROOT=<tmp> node flow.mjs <tool> <variant>` のように動かす。`*.mjs.txt` は lint の対象から外すための拡張子で、パスは `<WORKTREE>` / `<HOME>` に置き換えてある。

## 11. 本文に無い指摘（直していない）

1. **OpenCode V1 の `wait` が exit 124 になる。** ロールの有無によらず、確定モデルの構成で `status=ready`、`reason=hook_stop` のまま `isUnclassifiedActive=true`（`scraperReason=unknown_frame`）となり、`wait` が完了しない（`--on-prompt agent` は exit 10 `unclassified`）。ペインは 80 桁。短いパスでも同じ。実モデルでの再現は見ていない。`src/lib/detection` の V1 の待機画面の判定を要確認。
2. **新規の `CODEX_HOME` で `CM_CODEX_HOOK_TRUST` が既定（`auto`）のとき、hook の確認画面で send が exit 99。** ロールの有無によらず。`bypass` で回避して計測した。`src/lib/cli-tools/codex.ts` の確認画面の判定を要確認（0.166.0）。
3. **API キー経路の Claude で「Make auto mode your default permission mode?」のダイアログに `send` が 60 秒待って exit 99。** `hasSeenAutoDefaultNudge` が無いホームで出る。製品の OAuth 経路で出るかは未確認。
4. **公式文書との不一致:** OpenCode V2 の `instructions`（§7.1）。

1〜3 は #4134 で直した。

- 1 の原因は 1 秒未満のターンの `▣  Build · <model> · 836ms`。検出が `ms` の形（と `1h 5m`・`2d 3h`）を読まなかった。確定モデルは応答が速いので必ず当たる。局所モデル（Ollama の gemma4:26b）でも 2 ターン目が `637ms` だった。`wait` は exit 0 になった。`respond --default` の exit 99 の残りは別の理由で、構造化された承認に既定の答えが無いことをエラーの本文が述べる（番号なら通る）。
- 2 の原因は codex 0.166.0 の画面の変更。確認の 1 枚目とフォルダの信頼は数字でカーソルが動くだけになり、一覧と詳細のフッターの文面が変わり、`t` の後も閉じない。
- 3 は API キーの経路に限らない。2.1.318 の実行ファイルの条件は利用者の設定の `permissions.defaultMode`（`auto` 以外）で、認証の経路を見ていない。OAuth の経路では実機で確かめていない。起動は `No` を答える（`Yes` は利用者の設定の既定を書き換える）。

## 12. 未確認の一覧

#4114〜#4117 の実装の時点で更新した。

| 項目 | 理由 |
|---|---|
| Antigravity の注入以降の全部（§6.6） | 認証の複製が要る |
| Claude / Codex / Copilot / Command Code の**本物のモデル**がロールと `AGENTS.md` を同時に守るか | 認証の複製が要る。代わりに局所モデルで計測（§9）。要求への到達は確定モデルで確認済み。OpenCode V1・V2 も局所モデルだけ |
| Claude の `--system-prompt-snapshot off` での再開 | CommandMate が再開しないので省いた |
| OpenCode V2 の approval ダイアログの検出 | 確定モデルの課題で確認が出なかった |
| Command Code の mod による受領ファイル | 確認の手段が無く、適用状態は「不明」のまま（#4115）。V1 の設定 API は確定モデルで確認した（§14） |
| V1 の `wait --verify`、契約タスク | 計測の時点では `wait` が完了しなかった（§4、§11）。#4134 で `wait` と番号の `respond` からの実行は確かめたが、この 2 つは測り直していない |
| Schedule の env の読み取りの実機確認 | テストだけ。`OPENCODE_CONFIG_CONTENT="$(cat <file>)"` の形とペインの env の読み取り（`tmux show-environment`）は #4115 で実機で確認した（確定モデル、私設 tmux） |
| 実際のドライバを通した起動（待ちとダイアログの処理）、`gh copilot` の形、hooks 有効の起動行 | #4115 の実機確認は同じ関数を確認用の手順でつないだもの。Copilot は `copilot` の直接起動、起動行は hooks 無効で確かめた |
| V2 の `continueSession`、Schedule の `-c` | 入口を通していない。再開の挙動は TUI で確認（§3） |
| 生成物の書き込み不可の実機確認 | テストだけ（#4114・#4115） |
| 2 サーバーの同時生成の実機確認 | 2 プロセスを同時に動かしては確かめていない。同名・同内容の生成物を再利用する規則はテストで固定（#4114） |
| 起動中の既定変更の実機確認 | テストだけ（#4115） |
| リポジトリ既定とシステム既定の継承の実機確認 | テストだけ（#4114・#4115） |

## 13. Issue 本文の表との差分

| Issue の記載 | 今回の結果 |
|---|---|
| Copilot 1.0.98 | 1.0.105 で確認 |
| Antigravity・Copilot のホーム配置は未確認 | Copilot は動く。Antigravity は一覧まで確認 |
| V2 は `OPENCODE_CONFIG_DIR` + `default_agent` で読まれた | 読まれるが、大域設定を置換するので採らない |
| V2 の `instructions` は読まれない | 大域ファイル、`~/`、glob でも読まれない |
| V2 の `agents.x.system` | 読まれる。`{file:}` も動く。組み込みの `build`・`plan` の上書きも動く |
| OpenCode V2 の `default_agent`（「既存セッションは置き換わらない」） | 実測でも置き換わらない（なしの会話の再開） |

## 14. Issue 本文との食い違い（#4112・#4114・#4115）

`gh issue view` で 2026-11-03 に読んだ本文との差。Issue は編集していない。

### #4112（Epic）

| 本文の記載 | この文書の結論 | 本文をどう直すか |
|---|---|---|
| 「ロールは追加の指示」「既存の `plan` などを無言で取り消さない」 | V2 では実効 agent の `system` を置換する（基礎プロンプトが消える）。`plan` のまま使えるが、追加ではない（§7） | 「V2 だけは実効 agent の `system` の置換」と例外を書く（判断 1） |
| D3: 7 ツールすべてが対象 | V2 は条件つき、Antigravity は未確定で、有効化は判断待ち（§2） | D3 に「Antigravity は実機確認まで無効、V2 は判断 1 の結論に従う」を足す |
| 全体の完了条件「D1〜D5 が画面と CLI の両方で成り立つ」 | Antigravity の確認ができるまで満たせない | 完了条件を判断 2 の結論に合わせる |
| D4: 「Codex / Antigravity / Copilot のホームに生成」 | 一致。残りの 4 つ（Claude、Command Code、V1、V2）はホームに置く必要が無く、データディレクトリでよい。Codex は既存の `config.toml` を読むが書かない | 「読むだけなら既存ファイルを読む」を足す |
| 失敗時は「hook の『失敗したら素のまま起動』に乗せない」 | 方針は一致。CLI 自身が素のまま動く経路があるので、起動前の検査まで要る（§5、§8） | 「CLI の終了コードに頼らず起動前に検査する」を足す |
| 適用状態「証拠がなければ『不明』」 | 一致。ただし確認の手段が無い adapter があり、起動の多くが「不明」になりうる（下の #4115） | 「起動直後は不明が普通にありうる」と表示の前提に書く |

### #4114（DB・API・生成物）

| 本文の記載 | この文書の結論 | 本文をどう直すか |
|---|---|---|
| 生成物の「ルートは差し替えられる。既定はデータディレクトリの下」 | Codex は `$CODEX_HOME/<name>.config.toml`、Copilot は `$COPILOT_HOME/agents/`、Antigravity は `~/.gemini/config/agents/<dir>/` でないと発見されない（§6）。データディレクトリに置けるのは Claude、Command Code、V1、V2 の 4 つ | adapter ごとの置き場所の表を足し、ルートの差し替えはホームの差し替えと分ける |
| 「CLI のホームは既存の解決関数を再利用する（codex、copilot）」 | Antigravity の agents ディレクトリの解決関数は無い（`getAntigravityHooksConfigPath` は `hooks.json` のパスだけ） | Antigravity の解決関数を新設すると書く |
| 名前は「server namespace、role ID、ハッシュから」 | 方向は一致。ハッシュは**注入 fingerprint** の先頭とする（§5）。名前は Codex の `-p`、Copilot の `--agent`、Antigravity の `name` になる。実測は `cm-role-x` などの短い名前だけで、長さと文字種は未確認。V2 / V1 / Claude / Command Code の名前は CLI に見えない | 英数字とハイフンに限り、長さの上限を置き、実機で確かめる受入条件を足す |
| 「同じ内容・同じ所有なら再利用」 | 一致。ただし**生成物の内容はロールの本文だけで決まらない**（Codex は既存の `developer_instructions`、V2 は共通指示、Copilot と Antigravity は frontmatter） | 同じ内容の判定を**生成物 fingerprint**（書く全バイト）で行うと書く（§5） |
| `ResolvedRole` が「注入内容の fingerprint」を持つ | 注入内容は起動の時点の利用者の設定（Codex の `config.toml`、V2 の実効 agent）に依存し、解決関数からは決まらない | `ResolvedRole` が持つのは**本文 fingerprint** だけにする。**注入 fingerprint** は #4115 の変換処理が返し、**生成物 fingerprint** は書き込み処理が返す（§5 の表を写す） |
| 起動の記録の項目（本文の版とハッシュ、生成物、adapter と wrapper の版など） | 「ハッシュ」が 1 種類では足りない。V2 の実効 agent と、Codex の合成の元の fingerprint も足りない | **本文 fingerprint、注入 fingerprint、生成物 fingerprint** を別の欄で持つ。合成の元は値でなく fingerprint で持つ。本文や秘密を入れない |
| 本文は「UTF-8 で 16KB まで」 | 16,384 バイトまで 6 adapter で確認。CLI の上限ではなく CommandMate の上限（§5） | 「16,384 バイト。本文に掛け、合成後の生成物には掛けない」と書く |
| 本文の検証は上限のみ | Claude は空ファイルで素のまま動く（§6.1） | 空や空白だけの本文を API で拒否する |
| 生成物の検査は「symlink、権限、同一内容」 | 書いた後の読み直しの検査も要る（§5） | Codex の TOML、Copilot / Antigravity の frontmatter、Command Code の構文を読み直して検査する、を足す |
| TOML の依存に言及なし | Codex の合成に TOML の読み書きが要り、今の依存に無い（`yaml` のみ） | 依存の追加か、基本文字列の生成と読取りだけの実装かを決める |
| 自動削除はしない | 一致。ただし Copilot の `/agent` や `agy agent` の一覧に生成物が溜まる。`infer: false`・`subagent: false` は候補を減らすが一覧からは消さない | 一覧に残ることを既知の制約として書く |

### #4115（起動処理と Schedule）

| 本文の記載 | この文書の結論 | 本文をどう直すか |
|---|---|---|
| 「#4113 の文書に従い、7 adapter を実装する」 | Antigravity は無効のまま実装し、V2 は判断 1 に従う（§2） | 「Antigravity は既定で無効」を足す |
| 「Copilot の生成定義は `infer: false`。Antigravity は #4113 の結論に従う」 | Copilot は `infer: false` で別セッションの要求から名前が消えた（実測）。Antigravity は `subagent: false` を付ける（changelog の記載で、効果は未確認）。`hidden: true` は一覧から消えない | Antigravity の `subagent: false` と、効果が未確認であることを書く |
| OpenCode V2 の渡し方（#4112 の設計案: `OPENCODE_CONFIG_DIR` + `default_agent`） | **`OPENCODE_CONFIG_DIR` は採らない。** `OPENCODE_CONFIG_CONTENT` で実効 agent の `system` を上書きする（§7）。`hidden` を付けない | 変換の節に V2 の形を書き、実効 agent の解決（§7.1 の順序）をスコープに足す |
| V2 の共通 wrapper の扱いに区別なし | V2 の本文は共通指示 + ロール（判断 1） | V2 の共通指示の版を wrapper の版として記録し、注入 fingerprint の入力にする |
| 「ロール本文を、個別の依頼と実行契約を尊重する旨の共通 wrapper で包む」 | 局所モデルでは効果が確かめられず（§7.2）、V2 以外で wrapper をかけた実測が無い | 全 adapter の実機確認（到達と形式）を受入条件に足す |
| 「注入する env は、利用者の同名 env を無断で上書きしない」 | 合成の手順を決めた。不正なら未送信のエラー。V2 は不正な値を無言で無視する。合成後の値を起動行に書かない（§7.1） | §7.1 の手順と、env の読み先（tmux、sanitized env）の確認をスコープに足す |
| Schedule の明示 `agent`「規則は #4113 の結論に従う」 | V1 と Claude は併用。V2 は `agents.<明示 agent>.system` を上書きし、その agent に利用者の本文があれば未送信のエラー。Copilot は `gh copilot --agent <id>`（`buildCliArgs` に明示 `agent` は無い）（§4、§7.1） | 規則を本文へ写す |
| `buildCliArgs` に足す位置の指定なし | Codex の `-p` は `exec` の前。Copilot は `gh copilot` の後（`['copilot', '--agent', <id>, …]`）。V2 の明示 agent は env の内容に影響する | 引数の順序をテストの受入条件に足す |
| 「起動を確認したあとで `launched` を確定する」（手段の指定なし） | 手段は adapter ごとに違う（下の表）。証拠が無ければ `launched` は「不明」のまま | 下の表を本文へ写す |
| 「ロールの準備失敗は本文を送らず起動失敗」 | 一致。準備だけでは足りず、CLI が読まなかった場合も検出が要る。起動前の検査の項目は §5 | §5 の検査をスコープに足す |
| 「再起動待ちは、effectiveNext と launched の fingerprint の差」 | 比べるのは**注入 fingerprint**。本文、adapter・wrapper の版に加え、Codex の既存の `developer_instructions` や V2 の実効 agent が変わっても待ちになる。ロール名、継承元、本文が同じ別のロールでは待ちにならない。計算できなければ「不明」（§5） | 「fingerprint」を「注入 fingerprint」に直し、合成の入力の変更でも待ちになる場合を受入基準に足す |
| 「実入力の直前に世代と fingerprint で確かめる」「`runSessionLaunch` はロールも比較する」 | どちらも**注入 fingerprint** で比べる（§5） | 用語を直す |
| 再開の扱いに言及なし（Claude / Codex / Copilot） | Claude と Codex は再開すると旧本文を保持し、Copilot は `--agent` なしの再開で保持する（§3）。現在は再開しないので問題にならない | 「再開を足すときは §3 を確かめる」を逸脱時の扱いに足す |
| OpenCode V1 の再開の扱いに言及なし | 既定は「続ける」。ロールが変わるなら伝え、新しい会話を選べる。会話 ID だけを捨て、履歴は消さない（§6.4） | V1 の再開の仕様をスコープに足す |
| 手動の基準「各ツールを実機で起動し、小さな修正から検証まで」 | 確定モデルでは Antigravity を除いて確認した。本物のモデルは認証のある環境でだけできる | 手動の基準のままとし、Antigravity を判断 2 に結びつける |
| V1 の契約付きの依頼 | V1 の `wait` は今もロールの有無によらず完了しなかった（§11 の 1） | 実モデルで再現を確かめる。再現すれば別 Issue |

**適用確認の手段（`launched` の証拠）。**

| adapter | 手段 | 実測 |
|---|---|---|
| Claude | 起動失敗は exit。読めたことの積極的な証拠は無い | exit のみ |
| Codex | 起動失敗は exit。未知のプロファイルは検出できないので起動前の検査だけ | exit のみ |
| Command Code | mod の factory が受領ファイルを書く | 未実測。hook の例外は無言なので factory で書く |
| OpenCode V1 | サーバーの `GET /config` の `instructions` が生成物のパスを含む | 実測（#4115、確定モデル） |
| OpenCode V2 | `GET /api/config?directory=…` は 1 つの統合オブジェクトではなく設定元の配列（`[{type,path,info},…]`）を返し、env の分が最後に来る。その `info.agents.<実効 agent>.system` のハッシュを**生成物 fingerprint** と比べ、本文はログに出さない。`/api/agent` には本文が含まれない | 実測（#4115、バイト一致を確認。serve のみ） |
| Copilot | 画面の `✗ Custom agent` / `✗ Failed to select agent` が無いこと（否定の証拠）。`-p` は exit 1 | 実測 |
| Antigravity | 未確認 | 未確認 |
