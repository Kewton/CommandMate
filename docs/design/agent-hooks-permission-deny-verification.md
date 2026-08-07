# `permissions.deny` 実機検証（Issue #1739）

`--settings` に注入する `permissions.deny` が、**Auto-Yes が裁定する前に**拒否することの実測記録。
対象は `claude` **2.1.223**（macOS 26.6 / arm64）、実施日 **2026-08-07**。

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
