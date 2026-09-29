# Skill Agent 互換 matrix（実測 evidence）

CommandMate が Skill を install したあと、その Skill を **どの Agent が発見し、どう呼び出せるか** の実測記録。

manifest の `compatibility.agents` は **提供元の申告**であり、本ページの matrix は **CommandMate 側の実測**である。両者は別物として扱い、UI では併記する。実装は `src/lib/skills/compatibility-matrix.ts`（データ本体）と `src/lib/skills/compatibility.ts` の `reconcileAgentSupport()`（申告と実測の突き合わせ）。

---

## 1. install root 集合（前提）

`commandmate skill install` は #1460 以降、payload を **2 つの root へ byte-identical に配置**する（定数 `SKILL_INSTALL_ROOT_PREFIXES`）。

| root | 定数 | 位置づけ |
|------|------|---------|
| `.agents/skills/<id>/` | `SKILL_INSTALL_ROOT_PREFIX` | primary。atomic rename の commit point、receipt の `install_root` |
| `.claude/skills/<id>/` | `SKILL_CLAUDE_INSTALL_ROOT_PREFIX` | secondary。primary から前方収束させる |

receipt の `install_roots` に両方が記録される。`install_roots` を持たない旧 receipt は単一 root として読む後方互換がある（`src/lib/skills/installed-state.ts`）。

---

## 2. 実測 matrix

**発見（discovery）と呼出（slash command 露出）は別軸**として記録する。Codex CLI 0.145.0 は前者のみ成立するため、単一の native / unsupported 値では表現できない。

| Agent | 実測 version | 読み取る root | 発見 | 呼出（slash palette） | 証跡の性質 | 計測日 |
|-------|-------------|--------------|------|---------------------|-----------|-------|
| Claude Code | `2.1.220` | `.claude/skills` のみ | ✅ 確認済み | ✅ 確認済み | 機械的（palette 完全一致・`(project)` scope 表示） | 2026-07-26 |
| Codex CLI | `0.145.0` | `.agents/skills` | ✅ 確認済み | ❌ 露出しない | 発見は self-report / 呼出は機械的 | 2026-07-26 |
| Gemini | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし（発見軸のみ [§9.1](#91-gemini--gemini-skills-list---all) に記録） | — |
| OpenCode | `1.18.22` | `.agents/skills` と `.claude/skills`（project / global の両方） | ✅ 確認済み | ✅ 確認済み（ただし opencode 自身の palette には出ない） | 機械的（`GET /skill` が絶対 path を返し、`/<name>` 送信で Skill 本文が読み込まれ probe token が返る） | 2026-08-25 |
| Vibe Local | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| Copilot | `1.0.83` | `.agents/skills` と `.claude/skills`（`.github/skills` も） | ✅ 確認済み | ✅ 確認済み（Copilot 自身の palette に出る） | 機械的（`copilot skill list` の列挙と composer 補完。陽性対照 `/hel`・陰性対照 `/zzzznotacommand`） | 2026-09-05 |
| Antigravity | — | — | ❔ 未計測 | ❔ 未計測 | 実測なし | — |
| Command Code | `1.49.0` | `.agents/skills` のみ（`.claude/skills` は読まない） | ✅ 確認済み | ✅ 確認済み（Command Code 自身の palette に `[skill]` 行として出る） | 機械的（`cmd skills list -d` が読み取る root を列挙し probe Skill を載せる／`cmd -p "/<name>"` が `skill_loaded` イベントを出して token を返す） | 2026-09-05 |
| OpenCode V2 | `2.0.18` | `.agents/skills` と `.claude/skills`（project / global の両方。`.opencode/skills` 等も） | ✅ 確認済み | ✅ 確認済み（ただし v2 自身の `/` 補完・`ctrl+p` には出ない。`@` 補完には出る） | 機械的（`GET /api/skill` が絶対 path を返し、`/<name>` 送信で `skill` tool part が `input.id` と Skill の directory つきで記録され probe token が返る） | 2026-09-29 |

計測環境（Claude / Codex 行）: 専用 port・専用 DB・skills 未導入の新規 git repository / CommandMate 0.15.0 / macOS 26.5.2 / Node v24.1.0。
証跡: <https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5083878264>

計測環境（OpenCode 行, Issue #2037）: 同じ形の隔離 — 専用 port（4903 / 4904）・skills 未導入の新規 git repository・**`HOME` ごと差し替えた scratchpad**。手順は `docs/design/opencode-server-live-verification.md` §4、生の測定結果は同 §12。model は config で固定し、TUI の model picker は一度も開いていない。

計測環境（Command Code 行, Issue #2302）: 同じ形の隔離 — **`HOME` ごと差し替えた scratchpad**（`auth.json` / `config.json` だけを持ち込む）・skills 未導入の新規 git repository・`--no-auto-update`（計測中に binary が入れ替わらないようにする）。手順は `dev-reports/qa/issue-2302-command-code-skill-probe.sh`、生の測定結果は本ページ [§8](#8-command-code-probe-log-issue-2302)。

計測環境（Copilot 行, Issue #2302）: 同じ形の隔離（専用の `HOME`・skills 未導入の新規 git repository・root ごとに固有 token の probe Skill）。手順は `dev-reports/qa/issue-2302-other-agents-skill-probe.sh`、生の測定結果は本ページ [§9](#9-gemini--copilot-probe-log-issue-2302)。model 呼出は伴わない — `copilot skill list` も composer 補完も sign-in 前に動く CLI 自身の面である。同じ probe で Gemini 0.58.0 の発見軸も測ったが、行としては未計測のままにしてある（理由は下記）。

計測環境（OpenCode V2 行, Issue #2975）: 同じ形の隔離 — 専用 port（4975）・skills 未導入の新規 git repository・**`HOME` ごと差し替えた scratchpad**（`env -i` で起動し、利用者の `~/.local/share/opencode` などは読まない）・私設 tmux socket。model は server 既定の無料 model（`opencode/longcat-2.5-preview-free`、credential 不要）のままで、model picker は開いていない。手順と生の測定結果は本ページ [§10](#10-opencode-v2-probe-log-issue-2975)。

### 読み取り方

- **Claude Code は `.agents/skills` を読まない。** 公式 catalog の旧エントリは evidence として「Standard SKILL.md discovery from `.agents/skills`」を挙げて `claude: native` と宣言していたが、**結論は正しく根拠が誤り**である。実際には #1460 が `.claude/skills` にも配置することで成立している。
- **Codex が palette に出ないのは配置先の問題ではない。** 対照実験で `/mo` → `/model` はマッチし、`~/.codex/skills` の既存 skill もマッチしないことを確認済み。当該 CLI version の制約である。
- **Antigravity の「未計測」は CommandMate の palette 挙動と別物。** CommandMate の slash loader は `.agents/skills` のエントリを antigravity session にも供給する（#1504）が、これは CommandMate がコマンドを注入しているのであって Agent 自身が Skill を発見しているわけではない。native discovery の evidence にはならない。
- **OpenCode の行は「公式 docs にそう書いてあるから」ではない。** Issue #2037 は「実測すれば `native` になる可能性が高い」と書いていたが、根拠にしたのは実測だけである。候補 root ごとに 1 個ずつ、固有 token を返すよう指示した probe Skill を 6 個植え、`GET /skill` が 6 個すべてを**絶対 `SKILL.md` path つきで**返すことを確認した（project の `.opencode/skills` / `.claude/skills` / `.agents/skills`、global の `~/.config/opencode/skills` / `~/.claude/skills` / `~/.agents/skills`）。呼出軸は `/probe-agents-root` を送って Skill 本文が読み込まれ `PROBE_OK_probe-agents-root` が返ることで確認し、`.claude/skills` 側でも同じ結果を得た。
- **OpenCode は「呼べるが palette には出ない」。** `/probe-agents-root` を composer に打ち込むと補完は **`No matching items`** になる（陽性対照 `/status` は自分の行にマッチし、陰性対照 `/zzzznotacommand` は何にもマッチしない）。opencode 自身の slash palette は `source: "command"` の行だけを載せるためで、Skill への入口は `/skills` picker しかない。**CommandMate の palette が `.agents/skills` / `.claude/skills` のエントリを opencode session にも供給する理由がこれである**（#1504 と同型、Issue #2037）。
- **OpenCode に送る trigger は末尾の空白まで含めて 1 つ。** `POST /tui/append-prompt` に裸の `/name` を渡すと補完 dropdown が開き、開いている間は `POST /tui/submit-prompt` が `true` を返して**何も送信しない**。空白を 1 つ足すと dropdown が閉じて Skill が走る。`MessageInput` は元から `` `${trigger} ` `` を入れるため palette 経路は安全。
- **Command Code は `.claude/skills` を読まない。** Claude Code と同型の TUI を持つが root は別で、読むのは project の `.commandcode/skills` と `.agents/skills`、および `$HOME` 配下の同じ 2 つである（`cmd skills list -d` が「Looking in:」として列挙する）。probe Skill は 4 つの root へ**同時に**植えたので、`.commandcode/skills`（陽性対照）と `.agents/skills` が列挙され `.claude/skills` が列挙されないのは配置の差ではない。CommandMate の 2 root install（#1460）は**片方だけ読まれて成立している**。
- **Command Code は自分の palette に Skill を出す。** composer に `/probe` と打つと `[skill]` タグつきの行が出て、`/skills` picker は「Project skills (.commandcode/skills or .agents/skills)」の下に `[.agents]` バッジつきで並べる。codex（palette に出ない）とも opencode（走るが palette に出ない）とも違うため、呼出軸に known limitation は付けていない。
- **`finalText` にトークンが返ることは発見の証拠にならない。** `.claude/skills` の陰性対照は `skill_loaded` を出さないまま `PROBE_OK_probe-claude-root` を返した — Skill としてではなく**ただのファイルとして読んだ**からで、モデル自身の推論も「`activate_skill` の enum に無い」と述べていた。機械的な判別子は `cmd -p ... --output-format json` の `{"type":"skill_loaded","name":…}` イベントであり、同じ prompt を `--no-skills` で撃つとこのイベントが消えることを陰性対照として確認している。
- **Command Code の palette 行は CommandMate 側がまだ出していない。** `loadAgentsSkills` の `cliTools` は `['codex','antigravity']` のままなので、CommandMate の palette は command-code セッションに `.agents/skills` の行を供給しない。Command Code 自身が発見も呼出もするため利用者は詰まらないが、palette parity としては欠けている（本 Issue は実測のみのため未対応。`tests/unit/lib/skills/agent-discovery-regression.test.ts` の `palette parity` suite が現状を pin しており、配線を入れると赤くなる）。
- **Gemini の project Skill は「信頼したフォルダ」でしか見えない。** 信頼していない folder では `Skipping project agents due to untrusted folder.` と出て built-in だけが並ぶ。**install は成功しているのに listing が空に見える**ので、実測でも再計測でもここを最初に確認すること（`~/.gemini/trustedFolders.json` に `"<repo>": "TRUST_FOLDER"` を書くか、対話で信頼する）。
- **Gemini は発見軸だけ測れて、行には入れていない。** `gemini skills list --all` は `.agents/skills` を絶対 path つきで返し、同時に植えた `.claude/skills` は返さない（[§9.1](#91-gemini--gemini-skills-list---all)）。一方で呼出軸は sign-in 自体が `This client is no longer supported for Gemini Code Assist for individuals` で失敗し、TUI が composer に到達しないため**まったく測れていない**。発見軸が verified だからといって呼出軸を埋めるのはこの表が拒否している推論なので、片側だけの行を作らず `unknown` のままにした（`tests/integration/skills-agent-discovery-probe.test.ts` が gemini を「実測の無い Agent」の例に使っており、行を起こすとそこも直す必要がある。次に測る人はこの §9.1 から始められる）。
- **Copilot は 2 つの install root を両方読む唯一の実測行。** `copilot skill list` が `.github/skills`（陽性対照）・`.agents/skills`・`.claude/skills` の 3 つを返し、#1460 の byte-identical な 2 root install は **1 行**にまとまる。`copilot skill --help` も同じ root を謳っているが、根拠にしたのは help ではなく root ごとに固有 token を持たせた probe Skill である。
- **Copilot の呼出は palette まで。** composer に `/probe` と打つと 4 つの probe がすべて出る（陰性対照 `/zzzznotacommand` は 0 行、陽性対照 `/hel` は built-in にマッチ）。Claude 行と同じ「palette 一致」水準であり、model が実際に Skill を読み込むところまでは見ていない（計測時は未 sign-in）。
- **Command Code / Copilot の palette 行も CommandMate 側は出していない。** 下の command-code の項と同じ欠けが Copilot にも当てはまる。Copilot は 2 root とも読むのに CommandMate からは 1 行も出ない（`.claude/skills` のエントリは `cliTools` 未指定＝Claude 専用のため）。
- **OpenCode V2 は v1 と同じ 2 root を読むが、値は v1 の行を共有していない。** 版（2.0.18）と日付が違ううえ、呼出が成立する経路も違う（次項）。v1 の 6 root に加えて project の `.opencode/skill`・global の `~/.config/opencode/skill`（単数形）も読み、`$HOME/.opencode/skills` と `.github/skills` は読まない（[§10.2](#102-発見軸--get-apiskill)）。
- **OpenCode V2 の `/<name>` は model が `skill` tool を呼んで成立する。** v1 は server が Skill を command として展開したが、v2 の TUI は `/probe-agents-root ` を**そのままの文字列**で送る（markdown command の `/probe-cmd` は template に展開されて送られるのと対照的）。判別子は `GET /api/session/{id}/message` の `skill` tool part（`input.id` と `metadata.directory`）であり、**返ってきた token ではない** — 発見されない root に植えた `/probe-home-dotopencode-root` は、model が似た名前の `probe-home-opencode-root` を読んで**そちらの token を返した**（[§10.3](#103-呼出軸--skill-tool-part-が判別子)）。
- **OpenCode V2 は `/` では出ないが `@` では出る。** composer の `/probe-agents-root` は `No matching commands`、`ctrl+p` の検索 `probe` は `No results found`。一方 `@probe` は発見済みの Skill を `skill` タグつきで全部並べ、`/skills` picker で選ぶと composer に `@name` が入る。v2 自身の入口はあるが slash command ではないので、呼出軸には v1 と同じ `NO_SLASH_COMMAND` を付けてある。
- **OpenCode V2 は再起動なしで拾う。** v1（起動時に一度だけ走査）と逆で、稼働中に植えた Skill は数秒で `GET /api/skill` に載り、同じセッションのまま `/name` で走った（[§10.5](#105-reload)）。表示上の手順は既存の語彙で一番近い「新しいセッションを開始する」（`SESSION_RESTART`）にしてある — 必要以上ではあるが誤りではない。
- **未計測は `unsupported` ではない。** 「動かないと確認した」ではなく「確認していない」であり、UI では `unknown` と skip 理由を表示する。

---

## 3. 申告と実測の突き合わせ

`reconcileAgentSupport()` は提供元の申告を実測で **下方向にのみ**制限する。

| 状況 | 表示される support | verification |
|------|------------------|-------------|
| 申告 = 実測 | 申告どおり | `CONFIRMED` |
| 実測 < 申告 | **実測の値**（申告は併記） | `RESTRICTED` |
| 実測 > 申告 | 申告どおり（実測を併記） | `STALE_DECLARATION` |
| 実測なし | 申告どおり | `UNVERIFIED` |

上方向に引き上げないのは、package が何を対応と主張するかを決めるのは提供元だからである。実測のほうが強い場合は「申告が追いついていない」と表示するにとどめる。

support 値の強さ順は `unsupported` < `unknown` < `commandmate_runtime` < `native`。`unknown` が `unsupported` より強いのは、「判定できなかった」が「動かないと確認した」より余地を残すため。

支援値そのものは discovery 軸だけで決まる。Codex のように呼出軸が `unsupported` でも support は `native` のまま、呼出の制約は **known limitation** として併記する。palette に出ないことは「動かない」ではないため。

---

## 4. evidence の陳腐化

実測には計測日を記録し、`SKILL_EVIDENCE_MAX_AGE_DAYS`（180 日）を超えたものは UI で経過日数つきに警告表示する。未計測の Agent は「陳腐化」ではなく `unknown` のままとする（失効する実測が存在しないため）。

---

## 5. reload 手順

| Agent | 手順 |
|-------|------|
| Claude Code | 当該 repository で新しいセッションを開始する。Skill はセッション開始時に走査される |
| Codex CLI | 新しいセッションを開始したうえで、Skill を**名前で指定**して呼び出す（slash command には出ない） |
| OpenCode | 新しいセッションを開始する。server は起動時に一度だけ command / Skill を走査して cache するため、install 直後の Skill は**再起動するまで出ない**（実測）。呼び出しは `/<name>`（CommandMate の palette、または opencode 自身の `/skills` picker から） |
| Command Code | 新しいセッションを開始する。`/skills` picker は開くたびに再走査するので稼働中に足した Skill も出るが、composer の slash 補完はセッション開始時に作られるため**再起動するまで出ない**（実測）。呼び出しは `/<name>` |
| Copilot | reload 手順は未計測。セッション再起動が安全な前提 |
| OpenCode V2 | 新しいセッションを開始する（表示される手順）。実測では**再起動も新しいセッションも要らない** — server は稼働中に足した Skill を数秒で拾い、同じセッションの `/<name>` で走った。呼び出しは `/<name>`（CommandMate の palette）または v2 自身の `@` 補完・`/skills` picker（`@name` を挿入する） |
| 未計測の Agent | 実測していない。セッション再起動が安全な前提 |

---

## 6. 再計測の運用

自動 sweep は `tests/integration/skills-agent-discovery-probe.test.ts` にある。既定では skip され、`CM_SKILL_DISCOVERY_PROBE=1` を付けたときのみ実行する。

```bash
CM_SKILL_DISCOVERY_PROBE=1 npx vitest run tests/integration/skills-agent-discovery-probe.test.ts
```

このプローブが行うのは **`<cli> --version` による version 差分の検出のみ**で、Agent の対話 TUI は操作しない。TUI へ入力する自動計測は、無関係な global 設定を書き換える事故を起こした実績があるためテスト経路では行わない。palette 露出の再計測は隔離環境での手動作業とし、結果は本ページと `compatibility-matrix.ts` を同時に更新する。

CLI が未導入の場合、プローブは失敗ではなく `unknown` と skip 理由を記録する。

---

## 7. 関連

- `docs/user-guide/skills.md` — 利用者向けの導入手順
- `docs/design/agent-skills-distribution.md` — 配布方式の ADR（D-8: Agent 互換性は 4 値 + 根拠）
- `tests/unit/lib/skills/compatibility-matrix.test.ts` — matrix の不変条件
- `tests/unit/lib/skills/agent-discovery-regression.test.ts` — matrix と CommandMate slash loader の整合

---

## 8. Command Code probe log (Issue #2302)

Command Code 1.49.0 / macOS 26.5.2 / 2026-09-05。ハーネスは `dev-reports/qa/issue-2302-command-code-skill-probe.sh`（`bash issue-2302-command-code-skill-probe.sh [workdir]`）。以下の `$WORK` は使い捨ての作業 dir で、`$WORK/home` を `HOME` に差し替えて走らせている（持ち込むのは `auth.json` / `config.json` だけ）。

### 8.1 隔離

| 項目 | 値 |
|------|-----|
| `HOME` | `$WORK/home`（`.commandcode/{auth.json,config.json}` のみ複製。skills root は空） |
| repository | `$WORK/repo`。`git init` した直後で Skill は 1 つも無い |
| binary | `--no-auto-update`。**付けないと計測の途中で 1.47.1 → 1.49.0 に入れ替わる**（実際に一度起きたので全計測を 1.49.0 で取り直した） |
| model | `config.json` の既定のまま。model picker は開いていない |

### 8.2 発見軸 — 読み取る root は CLI 自身が列挙する

Skill を 1 つも置かない状態の `cmd skills list -d`:

```
No skills installed.

Looking in:
  $WORK/home/.commandcode/skills (global)
  $WORK/home/.agents/skills (global, .agents)
  $WORK/repo/.commandcode/skills (project)
  $WORK/repo/.agents/skills (project, .agents)
```

`.claude/skills` は候補にすら入っていない。次に、固有 token を返すよう指示した probe Skill を 4 root へ**同時に**植えて再実行する（`.commandcode/skills` が陽性対照、`.claude/skills` が陰性対照）:

```
 Skills  4 installed

Project (3)
  probe-commandcode-root · CommandMate Issue
  probe-agents-root · CommandMate Issue
  probe-dual-root · CommandMate Issue

Global (1)
  probe-home-agents-root · CommandMate Issue
```

`probe-claude-root` だけが出ない。`probe-dual-root` は #1460 と同じ形（2 root へ byte-identical に配置、`shasum -a 256` の distinct digests = 1）で置いたもので、**1 行にしか出ない** — 二重に見えることはない。

### 8.3 呼出軸 — `skill_loaded` が判別子

`cmd -p "/<name>" --output-format json --no-session --trust --skip-onboarding --no-auto-update`:

| prompt | `skill_loaded` | `finalText` |
|--------|---------------|-------------|
| `/probe-agents-root` | `probe-agents-root` | `PROBE_OK_probe-agents-root` |
| `/probe-commandcode-root`（陽性対照） | `probe-commandcode-root` | `PROBE_OK_probe-commandcode-root` |
| `/probe-dual-root`（2 root install） | `probe-dual-root` | `PROBE_OK_probe-dual-root` |
| `/probe-claude-root`（陰性対照） | **なし** | `Found it — that skill lives under \`.claude/skills/\`. …\nPROBE_OK_pr…` |
| `/probe-agents-root --no-skills`（陰性対照） | **なし** | `Let me try reading it with the directory tool instead.` |

4 行目が**このページで一番効く実測**である。`.claude/skills` の probe は Skill として読み込まれていないのに token を返した。モデルの思考にはこう出ている:

> in my available skills manifest, only the `.commandcode`, `.agents`, and home `.agents` ones are listed … the `.claude` one isn't registered in my manifest but it exists in the repo … the enum only has: probe-commandcode-root, probe-agents-root, probe-home-agents-root, agent-browser, …

つまり `activate_skill` の enum に無いと自分で述べたうえで、SKILL.md を**ただのファイルとして読んで**指示に従っただけである。`finalText` を合否にすると `.claude/skills` が読まれていると誤判定する。5 行目の `--no-skills` は、`skill_loaded` が prompt の文字列ではなく discovery を指していることの対照。

### 8.4 Command Code 自身の palette

TUI（200x50、私設 tmux server、同じ隔離 `HOME`）で composer に `/probe` と打った状態:

```
❯ /probe
 /probe-commandcode-ro…  [skill] CommandMate Issue
 /probe-agents-root      [skill] CommandMate Issue
 /probe-dual-root        [skill] CommandMate Issue
 /probe-hotreload        [skill] CommandMate Issue
 /probe-home-agents-ro…  [skill] CommandMate Issue
```

`/claude` で絞り込むと候補は 0 行（`probe-claude-root` は palette にも出ない）。`/skills` picker は root ごとに見出しを付けて並べる:

```
Skills 11 skills
Project skills (.commandcode/skills or .agents/skills)
[on]   probe-agents-root [.agents] · ~5 tokens
[on]   probe-commandcode-root · ~5 tokens
[on]   probe-dual-root [.agents] · ~5 tokens
[on]   probe-hotreload [.agents] · ~5 tokens
User skills (~/.commandcode/skills or ~/.agents/skills)
[on]   probe-home-agents-root [.agents] · ~5 tokens
```

`[.agents]` バッジが `.agents/skills` 由来を示す。opencode の `No matching items` とは逆で、**Command Code は自分の palette に Skill を載せる**。

### 8.5 reload

`probe-hotreload` は TUI が**動いている最中に** `.agents/skills` へ置いた Skill である。

- `/skills` picker: 開き直すと出る（開くたびに再走査している）
- composer の slash 補完: 同じセッションでは `/probe-hot` が 1 行も出ない。新しいセッションを起こすと上の capture のとおり出る

したがって reload 手順は「セッションを開始し直す」で、`AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART` が正しい。

### 8.6 この計測が触れていないこと

- CommandMate の palette 側の配線（`loadAgentsSkills` の `cliTools`）は変えていない。command-code セッションに `.agents/skills` の行は今も供給されない
- `allowed-tools` などの frontmatter 差異、Skill の大きさによる skip 挙動は測っていない
- Gemini / Antigravity / Vibe Local は未計測のまま（Gemini は発見軸だけ §9.1 に記録してある）

---

## 9. Gemini / Copilot probe log (Issue #2302)

Gemini CLI `0.58.0` / GitHub Copilot CLI `1.0.83` / macOS 26.5.2 / 2026-09-05。ハーネスは `dev-reports/qa/issue-2302-other-agents-skill-probe.sh`。§8 と同じ形で、`$WORK/repo` は `git init` 直後の空リポジトリ、root ごとに固有 token の probe Skill を植えてある。

| 植えた場所 | 名前 | 役割 |
|-----------|------|------|
| `.agents/skills` | `probe-agents-root` | CommandMate primary |
| `.claude/skills` | `probe-claude-root` | CommandMate secondary |
| `.gemini/skills` | `probe-gemini-root` | Gemini の陽性対照 |
| `.github/skills` | `probe-github-root` | Copilot の陽性対照 |
| 両 install root | `probe-dual-root` | #1460 と同じ byte-identical 2 root install（digest 一致を確認） |

### 9.1 Gemini — `gemini skills list --all`

```
Discovered Agent Skills:

probe-agents-root [Enabled]
  Location:    $WORK/repo/.agents/skills/probe-agents-root/SKILL.md

probe-dual-root [Enabled]
  Location:    $WORK/repo/.agents/skills/probe-dual-root/SKILL.md

probe-gemini-root [Enabled]
  Location:    $WORK/repo/.gemini/skills/probe-gemini-root/SKILL.md

antigravity-support [Enabled] [Built-in]
skill-creator [Enabled] [Built-in]
```

`.agents/skills` は絶対 path つきで出る。`.claude/skills` と `.github/skills` は同時に植えたのに出ない。`probe-dual-root` は 1 行だけで、location は `.agents/skills` 側。

**先に踏む罠**: folder を信頼していないと同じコマンドがこう返る。

```
Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.
Discovered Agent Skills:

antigravity-support [Enabled] [Built-in]
skill-creator [Enabled] [Built-in]
```

project Skill が丸ごと落ちるだけで、install の失敗とは区別が付かない。ハーネスは `~/.gemini/trustedFolders.json` に `{"<repo>": "TRUST_FOLDER"}` を書いてから測っている。

**呼出軸は測れていない**。TUI を起こすと sign-in ダイアログが出て `Failed to sign in. Message: This client is no longer supported for Gemini Code Assist for individuals.` で止まり、composer に到達しない。したがって matrix の Gemini 行は **未計測のまま**にしてある — 発見軸だけの行を起こすと `tests/integration/skills-agent-discovery-probe.test.ts` （gemini を「実測の無い Agent」の例に使っている）まで巻き込むためで、これは Issue #2302 の scope 外である。ここに残した測定結果が、その行を起こすときの出発点になる。

### 9.2 Copilot — `copilot skill list`

```
Project skills:
  probe-github-root - CommandMate Issue
  probe-agents-root - CommandMate Issue
  probe-dual-root - CommandMate Issue
  probe-claude-root - CommandMate Issue
```

CommandMate の 2 root を**両方**読む。`probe-dual-root` は 1 行にまとまる（二重化しない）。

composer に `/probe` と打ったところ:

```
  ❯ /probe-github-root                  CommandMate Issue
    /probe-agents-root                  CommandMate Issue
    /probe-dual-root                    CommandMate Issue
    /probe-claude-root                  CommandMate Issue
```

対照: `/zzzznotacommand` は 0 行、`/hel` は `/help` などの built-in にマッチする（palette は絞り込んでいて、全部を並べているのではない）。

**claim していないこと**: 計測時の Copilot は未 sign-in（`Please use /login to sign in to use Copilot`）だったため、model が実際に Skill を読み込むところまでは見ていない。Copilot 行の呼出 `verified` は Claude 行と同じ「palette 一致」水準である。

### 9.3 この計測が触れていないこと

- Copilot の reload 手順（稼働中に足した Skill の扱い）は未計測。matrix の `reloadKey` は `UNKNOWN`（＝「再起動が安全な前提」）にしてある
- Antigravity / Vibe Local は CLI が入っておらず未計測のまま
- CommandMate の palette は Copilot セッションに 2 root のどちらの行も供給していない（§2 の読み取り方の項と同じ欠け。Gemini も同様）

---

## 10. OpenCode V2 probe log (Issue #2975)

opencode2 `2.0.18` / macOS 26.5.2 / 2026-09-29。以下の `$WORK` は使い捨ての作業 dir（scratchpad）で、`$WORK/home` を `HOME` に、`$WORK/repo` を project にしている。

### 10.1 隔離

| 項目 | 値 |
|------|-----|
| `HOME` | `$WORK/home`。**何も複製していない**（credential も不要。下の model 行を参照） |
| 起動 | `env -i PATH=… HOME=$WORK/home OPENCODE_SERVER_PASSWORD=<使い捨て> OPENCODE_DISABLE_AUTOUPDATE=1 COREPACK_ENABLE_AUTO_PIN=0 opencode2 serve --hostname 127.0.0.1 --port 4975`。TUI は `opencode2 --server http://127.0.0.1:4975 $WORK/repo`（CommandMate の `scripts/opencode-v2/launch.sh` と同じ serve + `--server` の形）。`env -i` なので利用者の `TMUX` / XDG 変数は漏れない |
| tmux | 私設 socket `tmux -L cm2975`（200x50）。後始末は `kill-session -t '=tui:'` / `'=srv:'` のみ |
| repository | `$WORK/repo`。`git init` 直後で Skill は 1 つも無い状態から植えた |
| model | server 既定の `opencode/longcat-2.5-preview-free`（`GET /api/model/default`、`apiKey: "public"`）。model picker は開いていない |
| 非汚染 | 計測前後で `ls -a $HOME`・`ls -a ~/.commandmate`・既定 tmux server の session 一覧が一致。port 4975 は後始末後に LISTEN なし。稼働中の self-hosted-runner の v2 には触れていない |

植えた probe Skill（本文はすべて「`PROBE_OK_<name>` の 1 行だけを返せ」）:

| 植えた場所 | 名前 | 役割 |
|-----------|------|------|
| `$WORK/repo/.agents/skills` | `probe-agents-root` | CommandMate primary |
| `$WORK/repo/.claude/skills` | `probe-claude-root` | CommandMate secondary |
| 両 install root | `probe-dual-root` | #1460 と同じ byte-identical 2 root install（`shasum -a 256` 一致） |
| `$WORK/repo/.opencode/skills` | `probe-opencode-root` | v2 固有 root（陽性対照） |
| `$WORK/repo/.opencode/skill` | `probe-opencode-singular-root` | 単数形 root |
| `$WORK/home/.agents/skills` | `probe-home-agents-root` | global |
| `$WORK/home/.claude/skills` | `probe-home-claude-root` | global |
| `$WORK/home/.config/opencode/skills` | `probe-home-opencode-root` | global |
| `$WORK/home/.config/opencode/skill` | `probe-home-opencode-singular-root` | global 単数形 |
| `$WORK/home/.opencode/skills` | `probe-home-dotopencode-root` | 陰性対照（#2944 で不検出） |
| `$WORK/repo/.github/skills` | `probe-github-root` | 陰性対照 |

あわせて markdown command `$WORK/repo/.opencode/commands/probe-cmd.md`（`CUSTOM_CMD_OK` を返せ）を palette の陽性対照として置いた。

### 10.2 発見軸 — `GET /api/skill`

`GET /api/skill`（Basic `opencode:<password>`）の返り値の `data[]` を `id | path` に要約したもの:

```
opencode | /builtin/opencode.md
report | /builtin/report.md
probe-home-claude-root | $WORK/home/.claude/skills/probe-home-claude-root/SKILL.md
probe-claude-root | $WORK/repo/.claude/skills/probe-claude-root/SKILL.md
probe-dual-root | $WORK/repo/.agents/skills/probe-dual-root/SKILL.md
probe-home-agents-root | $WORK/home/.agents/skills/probe-home-agents-root/SKILL.md
probe-agents-root | $WORK/repo/.agents/skills/probe-agents-root/SKILL.md
probe-home-opencode-singular-root | $WORK/home/.config/opencode/skill/probe-home-opencode-singular-root/SKILL.md
probe-home-opencode-root | $WORK/home/.config/opencode/skills/probe-home-opencode-root/SKILL.md
probe-opencode-singular-root | $WORK/repo/.opencode/skill/probe-opencode-singular-root/SKILL.md
probe-opencode-root | $WORK/repo/.opencode/skills/probe-opencode-root/SKILL.md
```

`location` は `{"directory": "$WORK/repo"}`。植えた 11 個のうち 9 個が絶対 path つきで返り、`probe-github-root`（`.github/skills`）と `probe-home-dotopencode-root`（`$HOME/.opencode/skills`）は返らない。`probe-dual-root` は `.agents/skills` 側の 1 行だけ（二重化しない）。

| root | project | global（`$HOME`） |
|------|---------|------------------|
| `.agents/skills`（CommandMate primary） | ✅ | ✅ |
| `.claude/skills`（CommandMate secondary） | ✅ | ✅ |
| `.opencode/skills` | ✅ | ❌（`$HOME/.opencode/skills`） |
| `.opencode/skill` | ✅ | — |
| `.config/opencode/skills` | — | ✅ |
| `.config/opencode/skill` | — | ✅ |
| `.github/skills` | ❌ | — |

v1 と違い **`GET /api/command` は Skill を含まない**（返るのは `init` / `review` / `probe-cmd` の 3 行だけ。v1 の `GET /command` は Skill を `source: "skill"` で載せていた）。

### 10.3 呼出軸 — `skill` tool part が判別子

TUI の composer に入力して Enter、`GET /api/session/{id}/message` で結果を読んだ（新しいセッションごとに 1 入力）:

| 入力 | user message の text | `skill` tool part | 返答 |
|------|---------------------|------------------|------|
| `/probe-agents-root ` | `/probe-agents-root ` | `input.id: "probe-agents-root"`・completed・`metadata.directory: $WORK/repo/.agents/skills/probe-agents-root` | `PROBE_OK_probe-agents-root` ✅ |
| `/probe-claude-root ` | `/probe-claude-root ` | `probe-claude-root`・completed・`.claude/skills` | `PROBE_OK_probe-claude-root` ✅ |
| `/probe-dual-root `（2 root install） | 同左 | `probe-dual-root`・completed・`.agents/skills` | `PROBE_OK_probe-dual-root` ✅ |
| `/probe-home-agents-root ` | 同左 | `probe-home-agents-root`・completed・`$WORK/home/.agents/skills` | `PROBE_OK_probe-home-agents-root` ✅ |
| `@probe-claude-root ` | 同左 | `probe-claude-root`・completed | `PROBE_OK_probe-claude-root` ✅ |
| `/probe-github-root `（陰性対照） | 同左 | `probe-github-root`・**error** | `The skill \`probe-github-root\` doesn't exist in this environment. …` |
| `/probe-home-dotopencode-root `（陰性対照） | 同左 | **`probe-home-opencode-root`**（別の Skill）・completed | **`PROBE_OK_probe-home-opencode-root`** |
| `/probe-cmd `（markdown command の対照） | **`Reply with exactly CUSTOM_CMD_OK`**（template に展開済み） | なし | `CUSTOM_CMD_OK` |

読み方:

- Skill の `/name` は TUI が展開せず、文字列のまま model に届く。model がそれを見て `skill` tool を呼ぶ。markdown command（最終行）は TUI が template に置き換えて送るので、**v2 の `/name` は command と Skill で経路が違う**。
- `skill` tool の候補は発見された Skill に限られる。`.github/skills` の名前は tool が error を返す。
- **token は判別子にならない。** 7 行目は発見されない root の名前を送ったのに、model が似た名前の発見済み Skill を読んで**その token を返した**。合否は `input.id` が送った名前と一致し `metadata.directory` が植えた root を指すことで判定している。

### 10.4 OpenCode V2 自身の palette

| 入力 | 結果 |
|------|------|
| composer に `/probe` | `/probe-cmd`（markdown command）だけ。Skill は 1 行も出ない |
| composer に `/probe-agents-root` | `No matching commands` |
| composer に `/rev`（陽性対照） | `/review` にマッチ |
| composer に `/zzzznotacommand`（陰性対照） | `No matching commands` |
| `ctrl+p` → `probe` | `No results found` |
| `ctrl+p` → `skill`（陽性対照） | `Skills` の行が出る |
| `ctrl+p` → `zzzznotacommand`（陰性対照） | `No results found` |
| composer に `@probe` | 発見済みの 9 個が `skill` タグつきで並ぶ（`.opencode/commands/probe-cmd.md` はファイル参照として並ぶ） |
| composer に `@zzzznotaskill`（陰性対照） | `No matching files, agents, or references` |
| `/skills` picker | `OpenCode` / `Report` と発見済みの 9 個。選ぶと composer に **`@probe-agents-root`** が入る |

`@probe` の capture:

```
┃ @probe-dual-root CommandMate Issue 2975 probe skill (probe-dual-  skill ┃
┃ @probe-agents-root CommandMate Issue 2975 probe skill (probe-age  skill ┃
┃ @probe-claude-root CommandMate Issue 2975 probe skill (probe-cla  skill ┃
┃ @probe-opencode-root CommandMate Issue 2975 probe skill (probe-o  skill ┃
┃ @probe-home-claude-root CommandMate Issue 2975 probe skill (prob  skill ┃
┃ @probe-home-agents-root CommandMate Issue 2975 probe skill (prob  skill ┃
┃ @probe-home-opencode-root CommandMate Issue 2975 probe skill (pr  skill ┃
┃ @probe-opencode-singular-root CommandMate Issue 2975 probe skill  skill ┃
┃ @probe-home-opencode-singular-root CommandMate Issue 2975 probe   skill ┃
┃ .opencode/commands/probe-cmd.md                                         ┃
```

v1 は Skill への入口が `/skills` picker だけだったが、v2 は `@` 補完にも載せる。ただし slash command としては出ないため、呼出軸の limitation は v1 と同じ `NO_SLASH_COMMAND` とした。

### 10.5 reload

server が動いている最中に Skill を植えた:

| 手順 | 結果 |
|------|------|
| `$WORK/repo/.agents/skills/probe-hotreload` を植えて 3 秒後に `GET /api/skill` | `probe-hotreload` が載る（再起動なし） |
| 新しいセッションで `@probe-hot` | `@probe-hotreload … skill` が出る |
| 既存セッション（直前に 1 ターン済み）のまま `$WORK/repo/.claude/skills/probe-hotreload-claude` と `$WORK/home/.agents/skills/probe-hotreload-home` を植えて `@probe-hotreload-` | 両方 `skill` タグつきで出る |
| 同じセッションのまま `/probe-hotreload-home ` を送信 | `skill` tool `input.id: "probe-hotreload-home"`・completed → `PROBE_OK_probe-hotreload-home` |

**v1 と逆で、v2 は server の再起動もセッションの開き直しも要らない。** matrix の `reloadKey` は既存の語彙で最も近い `SESSION_RESTART`（新しいセッションを開始する）にしてある。「稼働中に拾う」ことを表す key は無く、locale の追加は Issue #2975 の scope 外である。

### 10.6 この計測が触れていないこと

- CommandMate の palette 側（`loadOpencodeV2Skills` の root 集合）は変えていない。§10.2 の project 4 root / global 4 root は #2944 の root 集合と一致している
- CommandMate 経由（`commandmate send`）での送信は測っていない。TUI の composer に直接入力している
- `allowed-tools` などの frontmatter 差異、Skill の大きさによる skip 挙動は測っていない
