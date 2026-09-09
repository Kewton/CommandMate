# `permissions.deny` 実機検証（Issue #1739 / #2442）

`--settings` に注入する `permissions.deny` の実測記録。2 回分ある。

| 節 | Issue | 何を測ったか | CLI | 実施日 |
|---|---|---|---|---|
| §1〜§5 | #1739 | deny が **Auto-Yes より先の層**であること（`pkill` / `killall` / `kill -9`） | `claude` **2.1.223** | 2026-08-07 |
| §6 | #2442 | socket 未指定の tmux 破壊コマンドを拒否する規則の**照合規則そのもの** | `claude` **2.1.266** | 2026-09-09 |

どちらも macOS / arm64。§6 は §1〜§5 の結論を前提にせず、照合器の挙動を独立に測り直している
（版が 43 リリース離れているため）。結論 1〜3（deny が hook より先・`flagSettings` に併存・
`allow` に勝つ）は §6 では再測していない。§6 が上書きするのは**結論 4 の精度**である
（「フラグまで含めた前方一致」は正しいが、**語単位かつ隣接**である点まで測れていなかった）。

関連: [agent-hooks-live-verification.md](./agent-hooks-live-verification.md)（#1721。`--settings` そのものの挙動）

---

## 1. 結論

| # | 検証項目 | 結果 |
|---|---|---|
| 1 | deny は `PermissionRequest` より**先**に効くか | **効く**。deny されたコマンドで hook は **0 回**発火した。**Auto-Yes は突破できない** |
| 2 | `--settings` の `permissions` はユーザー／プロジェクト設定と併存するか | **併存**。独立の宛先 `flagSettings` に入る（hooks と同じく置換ではない） |
| 3 | ユーザー設定の `permissions.allow` は deny を開け直せるか | **開け直せない**。より優先度の高い `localSettings` の allow でも deny が勝った |
| 4 | フラグつき前方一致は素のコマンドまで巻き込むか | **巻き込まない**。`Bash(kill -9:*)` 相当は `kill <pid>` に当たらない |
| 5 | コマンド合成（`&&` / `\|` / `;`）で回避できるか | **できない**。行が分解され区間ごとに照合される |

これを実装に落としたのが `PERMISSION_DENY_RULES`（`src/lib/hooks/hook-settings-generator.ts`）。

---

## 2. 方法

### 2.1 危険なペイロードを使わない設計

検証したいのは「deny がどの層で効くか」であって「プロセスが本当に死ぬか」ではない。
そこで**実ルール（`pkill` / `killall` / `kill -9`）はファイルに載せたまま一度も打たず**、
同じ**ルール形**を持つ無害なコマンドを stand-in にした。

| 実ルール | stand-in | 共有する形 |
|---|---|---|
| `Bash(pkill:*)` | `Bash(sw_vers:*)` | 素のコマンド名の前方一致 |
| `Bash(kill -9:*)` | `Bash(uname -a:*)` | **フラグつき**前方一致 |

`sw_vers` / `uname` は読み取り専用で副作用が無い。照合器から見て両者は同じ経路を通るので、
stand-in の結果はそのまま実ルールの結果である。

### 2.2 隔離

- 専用 tmux socket `-L cmate-deny-probe`（`$TMUX` はユーザーの本番セッションを指すため必須）。
  後始末は `kill-session -t '=dp2:'`。**`kill-server` は使っていない**
- 作業ディレクトリは scratchpad 配下のみ。`$HOME` / `~/.commandmate/` には何も作っていない
- 隔離 HOME は**使えなかった**: `HOME` / `CLAUDE_CONFIG_DIR` のどちらを差し替えても
  `Not logged in · Please run /login` になる（credential は macOS Keychain 側にあり、
  2.1.223 では隔離 HOME から自動フォールバックしない）。
  そのため実 HOME で起動し、競合させる `allow` は**プロジェクト側**
  （`.claude/settings.local.json`）に置いた。優先度は
  `--settings` > `settings.local.json` > プロジェクト > **ユーザー設定**なので、
  `settings.local.json` の allow に勝てばユーザー設定の allow には当然勝つ

### 2.3 Auto-Yes を「最大強度」で置く

生成器の出力をそのまま使い、`PermissionRequest` だけを**無条件 allow を返し全リクエストを記録する
command hook** に差し替えた。現実の Auto-Yes より強い（条件も期限も契約抑止も無い）。
これが 1 度でも呼ばれていれば、そのコマンドは実行されていた。

```bash
# $SP/hook-allow.sh — 受けた payload を記録し、必ず allow を返す
BODY="$(cat)"; printf '%s\n' "$BODY" >> "$SP/permission-hook.log"
printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
```

投入した設定:

```jsonc
// --settings（flagSettings）
"deny": ["Bash(pkill:*)","Bash(killall:*)","Bash(kill -9:*)","Bash(sw_vers:*)","Bash(uname -a:*)"]
// .claude/settings.local.json（localSettings）— わざと競合させる
"allow": ["Bash(sw_vers:*)","Bash(uname:*)","Bash(hostname:*)"]
```

---

## 3. 観測

### 3.1 起動時のマージ

```
[DEBUG] Applying permission update: Adding 3 allow rule(s) to destination 'localSettings':
        ["Bash(sw_vers:*)","Bash(uname:*)","Bash(hostname:*)"]
[DEBUG] Applying permission update: Adding 5 deny rule(s) to destination 'flagSettings':
        ["Bash(pkill:*)","Bash(killall:*)","Bash(kill -9:*)","Bash(sw_vers:*)","Bash(uname -a:*)"]
[DEBUG] Watching for changes in setting files ~/.claude/settings.json, …/.claude/settings.json,
        …/.claude/settings.local.json
```

`--settings` 由来は `flagSettings` という**別の宛先**に **Adding** される。
ユーザー設定もプロジェクト設定も読まれ続けている（→ 結論 2）。

### 3.2 コマンドごとの結果

| # | コマンド | ルール状況 | `PermissionRequest` | 結果 |
|---|---|---|---|---|
| 1 | `sw_vers` | **deny**（flag）＋ allow（local） | **0 回** | 拒否。`Permission to use Bash with command sw_vers has been denied.` |
| 2 | `uname -a` | **deny**（flag）＋ allow `Bash(uname:*)` | **0 回** | 拒否 |
| 3 | `uname -s` | allow のみ | 0 回 | 実行（`Darwin`） |
| 4 | `hostname` | allow のみ | 0 回 | 実行 |
| 5 | `arch` / `id -un` | ルール無し（自動許可） | 0 回 | 実行 |
| 6 | `mkdir -p probe-scratch-dir` | ルール無し・**承認が要る** | **1 回 → allow** | 実行（ディレクトリ生成を確認） |
| 7 | `cd /tmp && sw_vers` | deny | 0 回 | 拒否 |
| 8 | `sw_vers \| cat` | deny | 0 回 | 拒否 |
| 9 | `echo start; sw_vers` | deny | 0 回 | 拒否 |

- **#6 が空振り防止の対照実験**。「hook が 0 回」だけでは「deny が先に効いた」と
  「この構成では hook がそもそも発火しない」を区別できない。承認が必要な唯一のコマンドで
  hook は**確かに発火し allow を返し実行された**。それでも #1/#2/#7/#8/#9 では 1 度も呼ばれていない
  → **deny は Auto-Yes より先の層である**（結論 1）
- **#1**: `localSettings` の allow を持っていても拒否された（結論 3）
- **#2 vs #3**: `uname -a` は拒否、`uname -s` は実行。前方一致はフラグまで見る（結論 4）。
  これが `Bash(kill -9:*)` を入れても `kill "$(cat pidfile)"` が残る根拠
- **#7〜#9**: 合成しても拒否（結論 5）
- デバッグログ側は `Bash tool permission denied` が **5 行**（#1/#2/#7/#8/#9）。
  hook 呼び出しログは全期間で **1 行**（#6 のみ）

### 3.3 拒否メッセージ

エージェントに見えるのは `Permission to use Bash with command <cmd> has been denied.`。
ダイアログは描かれない。
なお**パイプの場合だけ `<cmd>` に該当区間のみが載る**（`sw_vers | cat` → `sw_vers`）。
`&&` / `;` は行全体が載った。**メッセージ文面に依存した実装をしないこと。**

---

## 4. 実装との対応

- `PERMISSION_DENY_RULES` は結論 4/5 に依存している。`kill -9` を含めても
  PID 指定の停止手段（`kill "$(cat pidfile)"`）は残る
- ユーザーの実 `~/.claude/settings.json` には**そもそも `permissions` ブロックが無い**
  （検証時点で確認）。結論 3 と併せて、既存ユーザーの設定と衝突する経路は無い
- ロールバックは `CM_AGENT_HOOKS_INJECT=0`（注入全体）。deny だけを外すスイッチは設けていない

## 5. 非汚染

- probe セッション終了後、`tmux -L cmate-deny-probe list-sessions` → `no server running`
- `$HOME` 直下・`~/.commandmate/` への生成物なし。作業物はすべて scratchpad 配下
- ユーザーの本番サーバ（3000）と global インスタンス（60301）には一切触れていない

---

## 6. socket 未指定の tmux 破壊コマンド（Issue #2442）

`claude` **2.1.266** / macOS **26.6.2** / arm64、実施日 **2026-09-09**。
実装は `TMUX_UNPINNED_DENY_RULES`（`src/lib/hooks/hook-settings-generator.ts`）、
モデル化したテストは `tests/unit/hooks/hook-settings-generator-tmux-deny-2442.test.ts`。

### 6.1 なぜ測り直したか

2026-09-08 22:53 JST、既定 tmux サーバの `mcbd-*` セッション 42 本が socket 未指定の
`tmux kill-server` で消えた（2026-08-02 の #1624 に続く 2 度目）。deny 規則で塞ぐには
**「どの綴りに一致するのか」を版に対して確定する**必要がある。旧記載の
「複数行の 2 行目には前方一致が効かない可能性が高い」は根拠に採らず、実測で置き換えた。

### 6.2 安全な代役（本番破壊コマンドは 1 度も打っていない）

規則形が同じで**読み取り専用**の tmux サブコマンドを代役にした。`tmux` という語も、
サブコマンド前に置く大域オプション（`-L` / `-S`）という argv 構造も本物と同一なので、
照合器から見て両者は同じ経路を通る。

| 実規則 | 代役 | 共有する形 |
|---|---|---|
| `Bash(tmux kill-server:*)` / `Bash(tmux kill-session:*)` | `Bash(tmux list-sessions:*)` | `tmux <サブコマンド>` |
| `Bash(tmux set-option -g:*)` | `Bash(tmux show-options -g:*)` | **フラグつき**の `tmux <サブコマンド> -g` |
| `Bash(tmux bind-key:*)` / `Bash(tmux unbind-key:*)` | `Bash(tmux list-keys:*)` | `tmux <サブコマンド>` |

隔離: 対照用の socket は `-L cmate-2442-probe` のみで、**そこにサーバを起動していない**
（`error connecting to /private/tmp/tmux-501/cmate-2442-probe` が全ラン共通の応答）。
`kill-server` は代役でも実規則でも 1 度も打っていない。後始末は不要（サーバが存在しない）。
実測後に既定サーバの `mcbd-*` セッションを数え直して 9/9 健在を確認している。

### 6.3 ハーネス

`claude -p --settings <probe> --output-format stream-json --verbose --max-turns 2` に
「この bash コマンドを 1 回だけ実行して止まれ」と渡し、`tool_result` を読む。3 状態を
区別できる:

| 観測した `tool_result` | 意味 |
|---|---|
| `Permission to use Bash with command <cmd> has been denied.` | **deny 規則に一致** |
| コマンドの実行結果（tmux 自身のエラー等） | allow 規則に一致して**実行された** |
| `This command requires approval` | **どの規則にも一致せず**、通常の承認経路に落ちた（`-p` では自動拒否） |

3 状態目が在ることが空振り防止の対照になっている。「hook が 0 回」だけでは
「deny が効いた」と「そもそも何も起きていない」を区別できない（#1739 §3.2 の #6 と同じ役割）。
投入した allow は `Bash(tmux -L cmate-2442-probe:*)` と `Bash(echo:*)` の 2 本だけで、
`echo hello-positive-control` が実行されることを毎回確認している。

### 6.4 結果

代役規則（`list-sessions` / `show-options -g` / `list-keys`）を deny に載せた状態。

| # | 打ったコマンド | 結果 | 読み取り |
|---|---|---|---|
| A | `tmux list-sessions` | **拒否** | 素の `tmux <サブコマンド>` は一致する |
| B | `tmux -L cmate-2442-probe list-sessions` | 実行 | **`-L` つきは一致しない**（allow で実行された） |
| C | `tmux show-options -g` | **拒否** | フラグつき前方一致が効く |
| D | `tmux -L cmate-2442-probe show-options -g` | 実行 | 同上の対照 |
| E | `tmux list-keys` | **拒否** | — |
| F | `cd /tmp && tmux list-sessions` | **拒否** | `&&` で合成しても分解される |
| G | `tmux list-sessions \| cat` | **拒否** | パイプ |
| H | `echo start; tmux list-sessions` | **拒否** | `;` |
| I | `false \|\| tmux list-sessions` | **拒否** | `\|\|` |
| J | `export CM_PROBE_MARKER=1`＋改行＋`tmux list-sessions` | **拒否** | **2026-09-08 の事故と同じ形**。改行後の行も照合される |
| N | `env CM_PROBE=1 tmux list-sessions` | **拒否** | 先頭の `env VAR=…` は剥がされる |
| T | `echo "$(tmux list-sessions)"` | **拒否** | コマンド置換の中も照合される |
| L | `echo hello-positive-control` | 実行 | ハーネスの陽性対照 |
| K | `/opt/homebrew/bin/tmux list-sessions` | **要承認** | **一致しない** |
| M | `bash -c 'tmux list-sessions'` | **要承認** | **一致しない** |
| P | `tmux -S <path> list-sessions` | **要承認** | `-S` つきも一致しない（B と同じ結論、allow 無しで確認） |
| U | `tmux -u list-sessions` | **要承認** | **サブコマンド前の別の大域オプションで外れる** |
| V | `tmux ls` | **要承認** | tmux 自身の alias は別語 |
| W | `tmux list-sess` | **要承認** | tmux の「一意な前置」省略形は別語 |
| X | 規則 `Bash(tmux list-p:*)` に対し `tmux list-panes` | **要承認** | **語の途中までの前方一致は効かない** |
| Y | 規則 `Bash(tmux list:*)` に対し `tmux list-keys` | **要承認** | 同上 |
| Z1 | 規則 `Bash(tmux show-options -g:*)` に対し `tmux show-options -gv history-limit` | **要承認** | **結合フラグは別語** |
| Z2 | 同規則に対し `tmux show-options -t 0 -g` | **要承認** | **隣接していない `-g` は外れる** |
| Z3 | 同規則に対し `tmux show-options -g history-limit` | **拒否** | Z1/Z2 の隣接対照 |

実規則（`kill-session` / `set-option -g`）についても、`-L` つきの対照だけは実物の綴りで打った
（存在しないサーバ宛なので無害）:

| # | 打ったコマンド | 結果 |
|---|---|---|
| R | `tmux -L cmate-2442-probe kill-session -t '=cmate-2442-nonexistent:'` | 実行（`error connecting to …`） |
| R2 | `tmux -L cmate-2442-probe set-option -g history-limit 10000` | 実行（同上） |

### 6.5 結論

1. **照合は語単位かつ隣接**である（X / Y / Z1 / Z2）。`Bash(tmux kill-s:*)` のような
   短縮 1 本で family を覆うことは**できない**。書いてもエラーにならず、何にも一致しない。
   だから tmux 自身の alias（`set` / `bind` / `unbind`）には**それぞれ独立の行**が必要で、
   `TMUX_UNPINNED_DENY_RULES` はその 8 行になっている。
   `kill-server` / `kill-session` に alias は無い（tmux 3.5a の man を確認）。
2. **`-L` / `-S` つきは一致しない**（B / D / P / R / R2）。隔離 probe のレシピは壊れない。
   「一致しない」は**自動許可ではない** — 通常の承認経路に落ちるだけである。
3. **合成では回避できない**（F / G / H / I / T）。**改行後の行も照合される**（J）ので、
   2026-09-08 の事故の形（`TMUX_TMPDIR` 設定 → 改行 → 素の `kill-server`）は塞がる。
4. **未防御の形**（K / M / U / V / W / Z1 / Z2）。この層は事故を狭めるがクラスを閉じない:

   | 綴り | 状態 |
   |---|---|
   | 絶対パス（`/opt/homebrew/bin/tmux kill-server`） | 未防御 |
   | `bash -c '…'` / 別言語・ファイル経由の実行 | 未防御 |
   | サブコマンド前の別の大域オプション（`tmux -u kill-server`） | 未防御 |
   | tmux の省略形（`tmux kill-serv`） | 未防御 |
   | 結合された大域フラグ（`tmux set -ga …`）／隣接しない `-g` | 未防御 |
   | 他 CLI（codex / copilot / gemini / opencode / antigravity）の実行 | **対象外**（この設定は Claude のみ） |

   未防御の綴りは「防止済み」に数えない。後追い検知は `env-clean` ゲート
   （[task-contract.md](./task-contract.md) §2.6）が担い、リポジトリ内のレシピは
   静的ガード `tests/unit/config/tmux-live-test-safety.test.ts` が拒否する。
   3 層のどれも単独では十分ではない。

### 6.6 既存の設定を壊していないこと

- 既存 3 規則（`pkill` / `killall` / `kill -9`）は先頭のまま順序も内容も変えていない
  （`hook-settings-generator-tmux-deny-2442.test.ts` が配列の分解で固定）。
- `allow` は依然として**書かない**。§6.3 の allow は probe 用の一時ファイルだけに載せたもので、
  生成器の出力には入っていない（`never emits an allow list` が固定）。
- hooks 側の 8 イベントは 1 つも増減していない。ロールバックは従来どおり
  `CM_AGENT_HOOKS_INJECT=0`（注入全体。deny だけを外すスイッチは無い）。
- `tmux kill-session -t '=name:'` は静的ガードでは許容されるが、**この deny では拒否される**。
  エージェント向けのレシピは `-L` / `-S` つきで書くこと（B / R が実行される形）。
