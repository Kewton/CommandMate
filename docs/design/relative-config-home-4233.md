# 相対の `CODEX_HOME` / `XDG_CONFIG_HOME` を、書き手と読み手で 1 つの実体に揃える（Issue #4233）

- 状態: 設計（実装は Codex の事前レビューの後、別の契約で行う）
- 前提の Issue: #4191（`CM_AGENT_HOOKS_DIR`）、#4210（PR #4216。`COPILOT_HOME`・ロールの指示ファイル・OpenCode V2 の記録）、#2069（PR #2172。codex の版表示）
- 行番号は 2026-11-08 の `fix/4233-worktree`（`bbfadb387`）のもの。Issue 本文の行番号（PR #4216 のマージ時点）とは一部ずれるので、名前で引く

本書では、**事実**（コード・git log で確かめたこと）、**見立て**（事実から推したが試していないこと）、**未確認**（外部 CLI の挙動など、この段で確かめていないこと）を分けて書く。

---

## 0. 結論

| 問題 | 決めた向き | 一言の理由 |
|---|---|---|
| 1 `CODEX_HOME` | **サーバーの cwd で絶対化して 1 つの実体に寄せる**（#4191・#4210 と同じ向き） | CommandMate は起動行に `CODEX_HOME` を自分で載せている。載せる値を絶対にすれば、サーバーが書いた・読んだファイルと codex が読むファイルが構造的に一致する |
| 2 `XDG_CONFIG_HOME`（V2 のロール判定） | **pane の cwd（worktree）で解決する**＝opencode と同じ基準で読む | この値は CommandMate が渡していない（pane の環境は tmux 由来）。読むだけの側なので、読み手である opencode の解決に合わせる。起動行に載せて絶対化する案は `launch-command.ts` の「`XDG_CONFIG_HOME` は決して載せない」に反する |
| 3 説明の追従 | `child-process-env-scope-1996.md` と `env-sanitizer.ts` のコメントを #4210 の宣言（`AGENT_LAUNCH_CONDITIONAL_CONFIG_ENV_VARS`）に合わせる。当時の実測の記録は残し、今の仕様を別に書く | — |

2 つの向きは「どちらが正しいか」ではなく、共通の規則 **「値を相手に渡す側がこちらなら、こちらの cwd で絶対化して渡す。渡していない値を読むときは、相手の cwd で解決して読む」** の 2 つの場合である。#4191・#4210 で採った向きはどれも前者に当たる。

---

## 1. 経路（問題 1・2）と、#4191・#4210 で採った向き

### 1.1 前提: 2 つの cwd（事実）

| プロセス | cwd | 根拠 |
|---|---|---|
| サーバー（daemon） | package root | `src/cli/utils/daemon.ts:300-301` `spawn('npm', ['run', …], { cwd: packageRoot })` |
| エージェントの pane（codex・opencode V2 ほか） | worktree | `src/lib/cli-tools/base.ts:920-925` `createLaunchPane` が `workingDirectory: worktreePath`。codex は `src/lib/cli-tools/codex.ts:323`、opencode V2 は `src/lib/cli-tools/opencode-v2.ts:278` から呼ぶ |

`npm run dev` で起動したときのサーバーの cwd はリポジトリの checkout である。どちらでも worktree とは一致しない。

### 1.2 問題 1: 相対の `CODEX_HOME`（事実）

値の出どころはサーバーの `process.env.CODEX_HOME`、または `CodexHookOptions.codexHome`。

1. **解決**: `src/lib/hooks/sources/codex/hooks-config.ts:426-432` `getCodexHome()` は `resolveSafeDirectory()` を通すだけで、相対値をそのまま返す（`src/config/safe-directory.ts:88-115`。`/proc` の判定だけ絶対形で行う）。
2. **サーバーの cwd での書き込み・読み出し**（`fs` は相対パスをサーバーの cwd で解決する）
   - `hooks.json`: `getCodexHooksPath()`（`:435-437`）→ `writeCodexHookSettings()`（`:663`・`:669-675`）が `<serverCwd>/<rel>/hooks.json` と relay の実体 `<serverCwd>/<rel>/…relay` を書く。
   - 共有 hooks の点検: `inspectCodexSharedHooksReadOnly()`（`:752-756`）も同じ相対パスを読む。
   - ロールのプロファイル: `src/lib/agent-roles/artifacts.ts:280-281` `resolveArtifactLocation('codex')` が `join(getCodexHome(), '<name>.config.toml')` を書く。
   - ロールの合成: `src/lib/agent-roles/composition.ts:74` `readCodexDeveloperInstructions(getCodexHome())` が `config.toml` を読む。
   - 共有状態の判定: `artifacts.ts:218-226` `knownSharedStatePaths()` が `getCodexHome()` を絶対パスの一覧に混ぜ、`isSameOrInside()` で前方一致を取る（相対値は何にも一致しない）。
3. **worktree の cwd での解決**（codex の pane に渡る値）
   - 起動環境: `hooks-config.ts:895` `[CODEX_HOME_ENV_VAR]: getCodexHome(options)` が相対の文字列のまま pane に載る。
   - `hooks.json` の中の relay のパス: `:466-469` `resolveCodexRelayCommandPath()` → `getInstalledCodexRelayPath(getCodexHome())`、`:484-489` で hook のコマンド文字列に埋める。codex の hook はエージェント側で実行される。
   - ロールの起動: `src/lib/agent-roles/adapters.ts:205` `{ CODEX_HOME: dirname(artifact.path) }`（`artifact.path` は 2 の相対パス）と `-p <name>`。

→ サーバーは `<serverCwd>/<rel>/` に書き、codex は `<worktree>/<rel>/` を読む。hooks・relay・ロールのプロファイルのいずれも届かない。

**見立て**: hooks を受け取れないので、codex の構造化イベントがゼロになる（2026-08-13 に `hooks-config.ts:885-894` のコメントが記録している「tmux の環境で別の home を読み、エラーも出ずにイベントがゼロ」と同じ形）。
**未確認**: codex が相対の `CODEX_HOME` を自分の cwd で解決すること、および存在しないディレクトリを拒否することは、codex の実装（`find_codex_home` が `canonicalize()` する）からの推測で、実機では試していない。

### 1.3 問題 2: V2 のロール判定の `XDG_CONFIG_HOME`（事実）

1. **出どころ**: pane の環境。`src/lib/agent-roles/pane-env.ts:23` `tmuxPaneEnvReader()` が `tmux show-environment -t =<session>`、次に `-g` を読む。tmux サーバーが無いときだけサーバーの `process.env`。
2. **サーバーの cwd での解決**: `composition.ts:207-210` `loadOpencodeV2Agent()` が `join(configHome, 'opencode')` を作り、`readConfigLevel()` と `existsSync()` で読む。相対の `configHome` はサーバーの cwd で解決される。
3. **worktree の cwd での解決**: opencode V2 は `createLaunchPane`（worktree）の pane で `scripts/opencode-v2/launch.sh` から起動する（`launch.sh` は `cd` しない）。

→ 相対の `XDG_CONFIG_HOME` では、ロール判定は `<serverCwd>/<rel>/opencode/opencode.json` の `default_agent` や `system` を見て、opencode は `<worktree>/<rel>/opencode/` を見る。判定（どの agent に役割を載せるか、`system` を持つ agent を拒否するか）が実際と食い違う。

**未確認**: opencode が相対の `XDG_CONFIG_HOME` をそのまま `path.join` してプロセスの cwd で解決すること（XDG の仕様は相対値を無効として無視するよう求めている。opencode が仕様どおりに無視するなら、正しい読み先は `HOME/.config` になる）。実装の契約で opencode 2.x の挙動を確かめ、結果に合わせて §3.2 の 2 行目を選ぶ。

### 1.4 #4191・#4210 で採った向きと理由（事実）

| 設定 | 採った向き | 理由（コミット本文・コードのコメント） |
|---|---|---|
| `CM_AGENT_HOOKS_DIR`（#4191） | サーバーの cwd で絶対化（`resolveSafeAbsoluteDirectory`、`safe-directory.ts:137-143`） | `--settings <path>` を claude に渡すのはこちら。daemon は package root、claude は worktree で解決する（`safe-directory.ts:117-136` のコメント） |
| `COPILOT_HOME`（#4210） | 絶対化。ロールなしの起動でも、相対のときだけ起動環境に絶対の `COPILOT_HOME` を載せる（`copilot/hook-settings.ts:304` `getCopilotHomeDirectory`、`:1044` `copilotHomePin`） | サーバーが `settings.json` を書き、copilot は起動環境の `COPILOT_HOME` で読む。載せる値を絶対にすれば一致する |
| ロールの指示ファイル（#4210） | 絶対化（`artifacts.ts:178` `dataRootFor`） | `--append-system-prompt-file <path>` などでパスを渡すのはこちら |
| OpenCode V2 の記録（#4210） | 絶対化（`opencode-v2/secrets.ts:72` `getOpencodeV2StateDir`） | `--password-file <file>` を `launch.sh` に渡すのはこちら |

いずれも「値を相手に渡すのはこちら」の場合で、「worktree 側に書く」向きを採ったものは無い。PR #4216 は `CODEX_HOME` と `XDG_CONFIG_HOME` だけを「未対応の経路（追跡）」として残した（`docs/design/virtual-filesystem-directory-guard.md:132`・`:136`）。理由は、#2069 のテストが「相対のまま渡す」を固定していることと、向きが 2 通りあることである。

---

## 2. 問題 1 の 2 つの向きの比較

| 観点 | A: サーバーの cwd で絶対化（採用） | B: 相対の意図どおり worktree 側で書く・読む |
|---|---|---|
| 実体の数 | 1 つ（`<serverCwd>/<rel>`）。既定の `~/.codex` と同じく全 worktree で共有 | worktree ごとに 1 つ |
| 書き手の変更 | `getCodexHome()` を `resolveSafeAbsoluteDirectory()` に替えるだけ。呼び出し元は全部そのまま絶対になる | `getCodexHome()` に worktree を渡す引数が要る。`writeCodexHookSettings`・relay の設置・ロールのプロファイル・`readCodexDeveloperInstructions`・`knownSharedStatePaths` のすべてに worktree を通す |
| worktree の汚れ | なし | サーバーが worktree の中に `<rel>/hooks.json`・relay・`<name>.config.toml` を書く。`git status` に出る（`.gitignore` に無い） |
| codex の認証・状態 | 1 か所の `auth.json` などを全 worktree が使う | worktree ごとに `auth.json` が無く、worktree ごとにログインが要る（**見立て**） |
| #2315 の「`hooks.json` は `$CODEX_HOME` だけの関数」 | 保たれる（home が 1 つ） | home ごとには保たれるが、relay の設置と hook の信頼（`Modified since last trusted`）が worktree の数だけ要る |
| サーバー側の読み手（`history.ts:196-199` `resolveCodexHome`、`transcript.ts`） | サーバーの cwd で相対を解決しているので、絶対化した home と同じ場所を読む。**変更なしで一致する** | 読み手も worktree ごとに切り替える必要がある |
| 先例 | #4191・#4210 の 4 件と同じ | 先例なし |

**A を選ぶ。** B は相対値の文字どおりの意味に近いが、「worktree ごとの codex home」を CommandMate が作ることになり、変更範囲と利用者への副作用（汚れ・再ログイン）が大きい。相対の `CODEX_HOME` を付けてサーバーを起動した人が、worktree ごとの home を意図していたという根拠も見つからない（**事実**: `git grep -n 'CODEX_HOME=\.' -- docs` は 0 件で、docs に相対の `CODEX_HOME` の使い方は書かれていない。`.gitignore` にも `.codex` の行は無い）。

### 2.1 #2069 の意図との関係（事実）

`git log -S"forwards it verbatim"` は `9aaf28247`（#2069、PR #2172）の 1 件だけで、`tests/unit/updates/codex-home-parity-2069.test.ts` はこのコミットで新規に作られた。コミット本文の該当箇所は次のとおり。

> `src/lib/updates/codex-version.ts`（新規）: … `$CODEX_HOME` は絶対パスのときだけ採用（codex は自分の cwd 基準で解決するため）。`hooks-config.getCodexHome()` は import しない

つまり #2069 が決めたのは **版の読み手（`codex-version.ts`）が相対値のとき推測せず「不明」と答えること**である。`hooks-config` が相対値をそのまま渡すことは #2069 の決定ではなく、当時の既存の挙動を「読み手が `null` を返す理由」として記述・固定したものである。

- `getCodexHome()` の相対値の素通しは #1774（`6be9f5486`、`git log -S"resolveSafeDirectory(process.env[CODEX_HOME_ENV_VAR]"`）で `resolveSafeDirectory()` を通したときからの挙動で、そこでも相対値の扱いは論点になっていない。
- テストのコメント「the file lands under whichever worktree the agent is running in」は、codex 自身が書くファイル（`version.json` など）には当てはまるが、**サーバーが書く `hooks.json`・relay には当てはまらない**（サーバーの cwd に書く）。#2069 の時点で既にこの食い違いがあった。

### 2.2 #2069 のテストの期待をどう変えるか

| テスト | 今の期待 | 実装の契約での期待 | 理由 |
|---|---|---|---|
| `codex-home-parity-2069.test.ts:80-85` `hooks-config forwards it verbatim — codex resolves it against ITS cwd` | `getCodexHome({ codexHome: '.codex-shared' })` が `'.codex-shared'` | `resolve(process.cwd(), '.codex-shared')`（絶対） | A の決定そのもの。テスト名も事実と合わなくなるので、実装の契約で**名前の変更を明示的に許す**必要がある（案: `hooks-config makes it absolute against the server cwd and pins that on the launch line`） |
| 同 `:87-96` `the version reader answers UNKNOWN instead of guessing ~/.codex` | `null` | **変えない** | #2069 の決定。版の読み手はサーバーだけでなく `commandmate agents versions`（CLI。任意の cwd で動く）からも呼ばれる。CLI の cwd で絶対化するとサーバーの cwd と食い違い、#2069 が避けた「別の install の版を自信をもって出す」が起きる |
| 同 `describe('[#2069] the one deliberate divergence: a relative $CODEX_HOME')` | — | 名前は変えない。分岐（hooks-config は絶対化、版の読み手は不明）は残る | — |
| `tests/unit/updates/codex-version-2069.test.ts:126-134` | `null` | **変えない**。コメント（「`hooks-config` forwards a relative value to codex verbatim …」）だけ今の事実に直す | 同上 |

`src/lib/updates/codex-version.ts:35-70` のモジュールのコメントの表（relative 行の `passed through **verbatim**`）と `:136-146` の JSDoc も、「hooks-config はサーバーの cwd で絶対化して codex に渡す。版の読み手はその cwd を知らないプロセス（CLI）からも呼ばれるので不明と答える」に書き換える。

**見立て**: A の後も、サーバーから呼ぶ版の読み手だけは絶対化すれば版を出せるが、CLI との差が生まれるので本 Issue では入れない（入れるなら別 Issue）。

---

## 3. 選んだ向きで変わる読み手・書き手と、対照のテスト

### 3.1 問題 1（A: 絶対化）で変わるもの

`getCodexHome()` を `resolveSafeAbsoluteDirectory()` に替えると、次がすべて絶対パスになる。呼び出し元のコードは変えない。

| 種類 | 場所 | 今（相対の設定） | A の後 |
|---|---|---|---|
| 書き手 | `hooks-config.ts:663`・`:669-675` `writeCodexHookSettings`（`hooks.json`・relay の設置） | `<serverCwd>/<rel>/`（fs の解決） | 同じ実体（パスの表記が絶対になるだけ） |
| 起動環境 | `hooks-config.ts:895` の `CODEX_HOME` | 相対の文字列 → codex は `<worktree>/<rel>` | `<serverCwd>/<rel>` の絶対パス |
| `hooks.json` の中身 | `:466-469`・`:484-489` relay のパス | 相対 → hook は worktree で解決 | 絶対 |
| ロールの書き手 | `artifacts.ts:280-281` `<name>.config.toml` | `<serverCwd>/<rel>/` | 同じ実体 |
| ロールの起動環境 | `adapters.ts:205` `CODEX_HOME: dirname(artifact.path)` | 相対 | 絶対（`artifact.path` が絶対になるため。`adapters.ts` は変えない） |
| ロールの読み手 | `composition.ts:74` `readCodexDeveloperInstructions` | `<serverCwd>/<rel>/config.toml` | 同じ実体 |
| 共有状態の判定 | `artifacts.ts:218-226` `knownSharedStatePaths` | 相対の要素が何にも一致しない | 絶対で前方一致が効く |
| 共有 hooks の点検 | `hooks-config.ts:752-756` | `<serverCwd>/<rel>/` | 同じ実体 |
| 変えない読み手 | `history.ts:196-199` `resolveCodexHome`、`updates/codex-version.ts:148` | — | 前者はサーバーの cwd で相対を解決するので A と一致する。後者は §2.2 のとおり `null` のまま |

起動環境のキーの宣言（`launch-command.ts:193-196` `AGENT_LAUNCH_CONFIG_ENV_VARS` の `CODEX_HOME`）は変わらない。`CODEX_HOME` は既定の起動でも常に載るので、`COPILOT_HOME` のような条件つきの宣言は要らない。

### 3.2 問題 2（pane の cwd で解決）で変わるもの

| 種類 | 場所 | 今 | 変更後 |
|---|---|---|---|
| 読み手 | `composition.ts:208-210` `loadOpencodeV2Agent` の `configHome`（global の `opencode.json(c)` と `agents/*.md`） | `join(configHome, 'opencode')` をサーバーの cwd で解決 | `configHome` が相対なら `resolve(context.worktreePath, configHome)`。§1.3 の未確認で opencode が相対値を無視すると分かったら、相対値は未設定と同じに扱う（`join(home, '.config')`） |
| 同じ関数の `HOME` | `composition.ts:208` | 相対の `HOME` も同じ問題を持つ | 同じ規則を当てる（**見立て**: 相対の `HOME` は実用上まず無い。実装の契約で同時に扱う） |
| 変えないもの | `pane-env.ts:23` `tmuxPaneEnvReader`、`launch-command.ts:177-188`（`XDG_CONFIG_HOME` は `plan.env` に載せない） | — | — |

### 3.3 対照のテスト（生成と起動の cwd を対にする。#4191・#4210 の形）

#4191 の `tests/unit/lib/hooks/hook-settings-relative-dir-4191.test.ts` と同じく、`os.tmpdir()` の下に `fs.mkdtempSync` で `serverCwd` と `launchCwd`（worktree）を作り、`vi.spyOn(process, 'cwd').mockReturnValue(serverCwd)` で生成側の cwd を差し替え、`afterEach` で 2 つとも消す。**相対の検証は書き込みの前に置く**（直す前の実装では `fs` が本物の cwd＝checkout に書いてしまうため。最初の `expect(isAbsolute(...))` で落ちて、checkout に `rel-*/` を作らない）。

`tests/unit/lib/hooks/codex-home-relative-dir-4233.test.ts`（新規）

| # | 種類 | 内容 | 直す前 |
|---|---|---|---|
| 1 | 陽性 | `getCodexHome({ codexHome: 'rel-codex' })` が `join(serverCwd, 'rel-codex')` | 落ちる（`'rel-codex'`） |
| 2 | 陽性 | `CODEX_HOME=rel-codex`（`vi.stubEnv`）で同じ | 落ちる |
| 3 | 陽性 | `buildCodexLaunchPlan()` の `env.CODEX_HOME` を `launchCwd` から `resolve` したパスの `hooks.json` が、書かれた `settingsPath` と同じファイルで、存在する | 落ちる |
| 4 | 陽性 | 書かれた `hooks.json` のコマンドに含まれる relay のパスが絶対で、`launchCwd` から解決しても存在する | 落ちる |
| 5 | 陰性 | 絶対値の `CODEX_HOME` はそのまま。起動環境のキーは従来の集合のまま | 通る |
| 6 | 陰性 | 未設定は `tests/setup.ts` の既定（`CODEX_HOME ??= …`）または `~/.codex` のまま | 通る |
| 7 | 陰性 | `/proc/x` などの相対でない仮想 FS の値は従来どおり拒否（#1774） | 通る |

`tests/unit/lib/agent-roles/codex-role-relative-home-4233.test.ts`（新規。`role-artifacts-relative-dir-4210.test.ts` に倣う）

| # | 種類 | 内容 | 直す前 |
|---|---|---|---|
| 8 | 陽性 | `resolveArtifactLocation('codex', name, { codexHome: 'rel-codex' })` の `path` が絶対で `serverCwd` の下 | 落ちる |
| 9 | 陽性 | `buildRoleLaunchArguments` の `env.CODEX_HOME` を `launchCwd` から解決したディレクトリに、書いた `<name>.config.toml` がある | 落ちる |
| 10 | 陰性 | 絶対値の `codexHome` は従来と同じ `path` と `CODEX_HOME` | 通る |

`tests/unit/lib/agent-roles/opencode-v2-xdg-relative-4233.test.ts`（新規。書き込みの無い読み取りだけ）

| # | 種類 | 内容 | 直す前 |
|---|---|---|---|
| 11 | 陽性 | `fixedEnvReader({ XDG_CONFIG_HOME: 'rel-xdg', HOME: <tmp> })`、`<launchCwd>/rel-xdg/opencode/opencode.json` に `default_agent: "plan"`、`<serverCwd>/rel-xdg/opencode/opencode.json` に `default_agent: "other"` を置き、`loadRoleComposition('opencode-v2', { worktreePath: launchCwd, … })` の `opencodeV2EffectiveAgent` が `plan` | 落ちる（`build`。直す前は本物の cwd の `rel-xdg` を見るので、どちらのファイルも見えない） |
| 12 | 陽性 | `<launchCwd>/rel-xdg/opencode/agents/build.md` があるとき `RoleCompositionError`（opencode が見る Markdown の定義を拒否に数える） | 落ちる |
| 13 | 陰性 | 絶対の `XDG_CONFIG_HOME` は従来どおりそのディレクトリを読む | 通る |
| 14 | 陰性 | 未設定は `HOME/.config/opencode` を読む | 通る |

既存テストの変更は §2.2 の 1 件（`codex-home-parity-2069.test.ts:80-85` の期待と名前）だけ。`tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` の起動環境のキーの完全一致は、`CODEX_HOME` が常に載るので変わらない（実装の契約で確認する）。

---

## 4. 問題 3 と `virtual-filesystem-directory-guard.md` の更新の範囲

### 4.1 問題 3（事実）

- `docs/design/child-process-env-scope-1996.md:45`: 「`AGENT_LAUNCH_CONFIG_ENV_VARS` は `CODEX_HOME` の 1 個」「後ろ 2 つ（`COPILOT_HOME` / `XDG_CONFIG_HOME`）は読み出し専用で `plan.env` には入らない」。#2403 で `CM_PORT` が足されて 2 個になり、#4210 で `COPILOT_HOME` が相対のときだけ載るようになった（`launch-command.ts:198-215` `AGENT_LAUNCH_CONDITIONAL_CONFIG_ENV_VARS`）。
- `src/lib/security/env-sanitizer.ts:104-105`: drift guard の説明が「`AGENT_CORRELATION_ENV_VARS` plus `AGENT_LAUNCH_CONFIG_ENV_VARS`」のまま。条件つきの宣言と、相対設定での完全一致（`agent-launch-plan-secrets-1933.test.ts`）に触れていない。同じ文面は `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts:36-37` のヘッダーと `tests/unit/security/child-process-agent-env-1996.test.ts:18-24` のヘッダーにもある。

更新の範囲（実装の契約）:

1. `child-process-env-scope-1996.md:45` の段落はそのまま残し、見出しで「#1996 当時の実測（2026-08 時点）」と明示する。その直後に「今の仕様」の段落を足す: 既定の起動が載せるのは `AGENT_LAUNCH_CONFIG_ENV_VARS`（`CODEX_HOME`・`CM_PORT`）、設定が相対の `COPILOT_HOME` のときだけ `AGENT_LAUNCH_CONDITIONAL_CONFIG_ENV_VARS` が加わる、`XDG_CONFIG_HOME` は今も載らない、本書の決定で `CODEX_HOME` の値は常に絶対になる。
2. `env-sanitizer.ts:104-105` のコメントに条件つきの宣言を足す（コードは変えない）。
3. テストのヘッダー 2 件はコメントだけ合わせる（期待値は変えない）。
4. en 版は無い（`docs/en/design/` に該当なし。確認済み）。

### 4.2 `docs/design/virtual-filesystem-directory-guard.md`（相対パスの表）

- `:132` `CODEX_HOME / CodexHookOptions.codexHome` の行: 「相対のまま。未対応の経路（追跡）」を「**絶対化**（#4233）。起動環境の `CODEX_HOME`・`hooks.json` の relay のパス・ロールの `CODEX_HOME` がすべて絶対になる。版の読み手（`updates/codex-version.ts`）は相対値で不明と答えたまま（#2069）」に替える。
- `:136` `XDG_CONFIG_HOME` の行: 「未対応の経路（追跡）」を「ロール判定は pane の cwd（worktree）で解決する（#4233）」に替える。`opencodeGlobalConfigDir()` の書き込み先の注記は §6 の指摘として残す。
- `:107` の resolver の表の `CODEX_HOME` の行は、resolver が `resolveSafeAbsoluteDirectory` に替わることだけ反映する。

---

## 5. 実装の範囲（次の契約）

scope に入れるもの:

- `src/lib/hooks/sources/codex/hooks-config.ts`（`getCodexHome` を絶対化。コメント）
- `src/lib/agent-roles/composition.ts`（`loadOpencodeV2Agent` の `configHome`・`home` を pane の cwd で解決）
- `src/lib/updates/codex-version.ts`（コメントだけ）
- `src/lib/security/env-sanitizer.ts`（コメントだけ）
- `tests/unit/updates/codex-home-parity-2069.test.ts`（`:80-85` の期待と `it` の名前。**契約で名前の変更を明示的に許す**）
- `tests/unit/updates/codex-version-2069.test.ts`・`tests/unit/lib/agent-launch-plan-secrets-1933.test.ts`・`tests/unit/security/child-process-agent-env-1996.test.ts`（コメントだけ）
- 新規テスト 3 件（§3.3）
- `docs/design/child-process-env-scope-1996.md`、`docs/design/virtual-filesystem-directory-guard.md`、本書（決定の結果を追記）
- `changelog.d/4233.md`、`dev-reports/module-reference/issue-4233.md`

scope に入れないもの: `adapters.ts`・`artifacts.ts`（`getCodexHome()` が絶対を返せば変更不要）、`history.ts`・`transcript.ts`（§3.1 のとおり一致する）、`launch-command.ts`（宣言は変わらない）。

実装の契約の最初に確かめること（未確認の解消）:

1. opencode 2.x が相対の `XDG_CONFIG_HOME` をどう扱うか（cwd で解決／無視）。隔離 HOME の下で `opencode2 debug config` などを使い、実機で確かめる。結果で §3.2 の分岐を決める。
2. codex が相対の `CODEX_HOME` を cwd で解決するか（A の正しさには影響しない。A は codex に絶対パスしか渡さない）。

---

## 6. 本文に無い指摘（この Issue の範囲外）

- `src/lib/cli-tools/opencode-config.ts:453-456` `opencodeGlobalConfigDir()`: global モードの `opencode.json` の書き込み先を**サーバーの** `process.env.XDG_CONFIG_HOME` から決め、相対ならサーバーの cwd で解決する。opencode は**pane の**環境（tmux 由来）の値を worktree の cwd で読む。値の出どころ（サーバーの env と tmux の env）からして違いうるので、相対値の扱いだけでは揃わない。別 Issue で扱う。
- `src/lib/agent-health/tmux-command.ts:39` `KEPT_CHILD_ENV_VARS` が `CODEX_HOME` を子へ素通しする。相対値なら子の cwd で解決される。agent-health の子の cwd がサーバーと同じかは確かめていない（**未確認**）。
- `src/lib/hooks/sources/codex/history.ts:196-199` `resolveCodexHome()` は `resolveSafeDirectory()` を通らず、`/proc` などを拒否しない（#1774 のガードの外）。読むだけなのでハングは起きない（**見立て**）。
