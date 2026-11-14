# Antigravity のロールを既定で有効にする（Issue #4385）

- 正本: Issue #4385 の本文、実機の記録 `dev-reports/issue/agy-role-2026-11-14/report.md`（主のチェックアウトにある。初回と「再確認」の節、`evidence/` の各ファイル）
- 前の設計: [agent-roles-adapters.md](./agent-roles-adapters.md) §6.6（agy 1.4.12 の一時ホームでの実測）
- 事前レビュー（2-4-4、codex）: `workspace/orchestration/runs/2026-11-14/prereview-4385-reply.md`（主のチェックアウト）。P2 4 件・P3 3 件をすべてこの版で反映した（§12）
- この文書の書き方: **事実**（実測・実コード・agy の同梱文書で確かめたもの）と**見立て**（確かめていないもの）を分けて書く。見立てには「見立て」「未確認」と書く
- この設計ではコードを書かず、agy のセッションも起動していない。読んだのは `agy --version`・`agy --help`・`agy help agent`・`agy changelog` の出力と、`~/.gemini` の一覧（読むだけ）
- 行番号は develop `ff13eeace` の時点

## 1. 結論

1. 生成物（`~/.gemini/config/agents/<name>/agent.md`）の frontmatter に `tools` を足す。中身は 1.5.8 で確かめた 13 個の定数で、出典を書く（D1）
2. `CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と `isAgentRoleAdapterEnabled` を消し、Antigravity のロールを既定で有効にする。API の `adapterEnabled` は互換のために残し、常に `true` を返す。CLI の警告は旧いサーバー向けに残す（D4）
3. **版の範囲で起動を止めない。** agy の版が変わって登録に無い道具の名前が出たときは、agy 自身が exit 3 で止まる（fail-closed、実測）。抜けていたのは「止まったことが見えない」ことなので、起動後の確認で拾う（D2）
4. **起動前に `agy agent` の一覧と照合する。** 今回本当に新しいプロセスを起こす分岐（driver の再利用の return の後、`beginAgentSession` とペインの作成の前）でだけ行う。agy の TUI は未知の名前でも黙って既定の agent で起動する（実測）ので、これを起動前に止める（D3）
5. **起動後の適用は 4 つの状態で持つ**: 起動中／適用を確認済み／明確な不適用／取得不明。**確認済みになるまで本文を送らない。** 確認は有限の期限で、起動の待ち（`waitForReady`）と次の send のプロンプト待ちにつなぐ。プロセスを残すかと本文を送ってよいかは分けて決める（D2）
6. **await の後は世代を照合し直す。** 起動の要求の epoch と generation を持ち、D3 の後の最初の副作用・D2 の kill・記録の破棄の直前で、元の対象と同じかを確かめる。旧い世代の結果で今のセッションを止めず、今の記録を消さない（D6）
7. PR は 1 本（§7）

## 2. 実コードとの照合（Issue の本文との食い違い）

| # | Issue の本文 | 実コード（正） | この設計の扱い |
|---|---|---|---|
| 1 | 定義の置き場所は `~/.gemini/agents/<name>/agent.md` | `src/lib/agent-roles/artifacts.ts:290` の `resolveArtifactLocation` は `~/.gemini/config/agents/<name>/agent.md`（`hooks.json` の隣。`artifacts.ts:257` の `antigravityAgentsDir`、`src/lib/hooks/sources/antigravity/hooks-config.ts:213`） | 実コードの置き場所を保つ。1.4.12 では 2 つとも一覧に出た（`agent-roles-adapters.md:255`）。実機の記録（1.5.8）は `~/.gemini/agents/` だけを試しており、**1.5.8 で `config/agents` が一覧に出るかは未確認**。D3 が毎回の起動で確かめるので、ずれていれば黙らずに止まる。実装の PR の受入 9 で一時ホームで確かめる |
| 2 | 生成物に足すのは `tools` だけ | `src/lib/agent-roles/adapters.ts:25` の `ADAPTER_VERSION` は 7 adapter で 1 つ。生成物のバイトが変わるのに注入 fingerprint が同じだと、同じ名前に別の中身が来て `content-mismatch` で拒否される（`artifacts.ts:690` の `writeRoleArtifact`） | Antigravity だけ adapter の版を `'2'` に上げる（D5） |
| 3 | （記述なし）起動後の確認 | `src/lib/session/role-launch.ts:724` の `settleLaunchRole` は Antigravity を「確認の手段が無い」として何もしない。`src/lib/cli-tools/antigravity.ts:374` の `waitForReady` は 30 回（`antigravity.ts:87`）の待ちが尽きても throw しない（`antigravity.ts:427`）。起動に 61 秒かかった実測がある（`antigravity.ts:355`、`:106`） | 「名前が見えない」を一度の画面で不適用と決めない。起動中と取得不明を別の状態にして、次の send のプロンプト待ちまで確認を続ける（D2） |
| 4 | 「動くなら起動前に `agy agent` の一覧と照合して止める」 | `agy help agent` は `Usage: agy agent [flags]` / `List available agents` だけで、出力の形式の指定は無い（1.5.8、この設計で読んだ）。一覧は 1 行に 1 つの名前（`evidence/1-list.txt`、`r2-1-list.txt`） | 行ごとに完全一致で照合する（D3） |
| 5 | 「登録に無い名前を 1 つでも書くと exit 3」 | 一覧は登録に無い道具を書いた定義も**出す**（`evidence/r2-1-list.txt`: `swarm` を含む 14 個の `cm-role-dev` が一覧に出て、その後の起動が exit 3） | D3 では道具の名前の誤りを見つけられない。D2 が拾う |
| 6 | （記述なし）本文を送ってよい条件 | send の条件（`src/app/api/worktrees/[id]/send/send-role.ts:263` の `checkRunningRole`、`:297` の `roleConditionBoundary`）は fingerprint と generation を比べるだけで、`launched` を要求しない。証拠は `requested` の時点でできる（`role-launch.ts:556` の `openGeneration`）。ロール条件の無い send は何も見ない（`antigravity.ts:565` の `sendMessage`） | Antigravity では、`requested` の fingerprint を適用の確認の代わりにしない。本文の前に「適用を確認済み」を要る条件にする（D2 の送信の門） |
| 7 | （記述なし）再接続 | 既存プロセスの再利用は driver の中の `antigravity.ts:278`（`if (live) return;`）。`src/lib/cli-tools/base.ts:410` は、生成物の拒否があっても動いているプロセスへの再接続を止めない | D3 を base の共通の場所に置くと、再接続が一覧の健康に縛られる。driver の再利用の return の後に置く（D3） |

## 3. 決めたこと

### D1 `tools` の一覧

- 定数 `ANTIGRAVITY_ROLE_TOOLS`（13 個、この順）と `ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON = '1.5.8'` を持つ。出典のコメントに実機の記録のパス（`dev-reports/issue/agy-role-2026-11-14/report.md` の「再確認」の節、`evidence/r2-3-tool-registry-probe.txt`・`r2-4-dev-tools13.txt`）と日付（2026-11-14）を書く

```
read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, manage_subagents, write_file, edit_file, search_web, run_workflow, ask_question
```

- `swarm` は入れない（1.5.8 の登録に無い。exit 3、実測）
- frontmatter には実測と同じブロックの形（`tools:` の下に `  - <name>` を 1 行ずつ）で書く
- `excludeDefaultComponents` は書かない（実測でも書いていない。AGENTS.md は守られた）
- ロールごとに道具を絞ること（読むだけのロールなど）はこの Issue の範囲外（§9 Q3）
- `formatProblem`（`artifacts.ts:388`）の Antigravity の検査に「`tools` が定数と同じ配列であること」を足す。読み直しの検査（`artifacts.ts:631` の `inspectRoleArtifact`）が「道具の無い定義」をはっきり拒否する

### D2 起動後の確認と、本文を送ってよい条件

#### 版への追従（範囲で止めない）

| 案 | 中身 | 判断 |
|---|---|---|
| (a) 版の範囲で止める | `agy --version` が確かめた範囲の外なら起動しない | **採らない**（既定）。agy は頻繁に出る（同梱の changelog で 1.4.12 から 1.5.8 まで 12 版）。道具の一覧が通る版でも更新のたびに止まる。人の判断に残す（§9 Q1） |
| (b) 起動の後に確かめる | 下の 4 つの状態で確かめ、確認済みになるまで本文を送らない | **採る** |
| (c) 起動の前に短い headless を走らせる | `agy --agent <name> -p …` を 1 回 | **採らない**。起動のたびにモデルを 1 回呼ぶ（課金と数十秒） |

#### 適用の 4 つの状態

起動の世代（generation）ごとに 1 つの状態を持つ。置き場所はサーバーのメモリの証拠（`role-launch.ts:128` の `StoredLaunchRoleEvidence`）に足す項目 `application`。

| 状態 | 意味 | プロセス | 本文 |
|---|---|---|---|
| `starting`（起動中） | 起動行を打った。まだ判定の材料が無い（画面が未描画、または信頼の画面の前） | 残す | 送らない（待つ） |
| `confirmed`（適用を確認済み） | 今の状態の行に生成物の名前がある | 残す | 送ってよい。記録 `launched` を書く |
| `not-applied`（明確な不適用） | 下の「明確な不適用」のどれかを見た | 止める（D6 の照合つき） | 送らない。未送信の拒否（`not-applied`） |
| `unknown`（取得不明） | 画面を取れなかった（tmux の失敗） | 残す | 送らない（待つ）。期限までに取れなければ未送信の拒否（`not-confirmed`） |

**画面から判定してよい範囲**（事前レビュー P3-1）:

- 読むのは ANSI を除いた画面の**現在の状態の行**だけ。200 行の中から部分文字列を探さない。状態の行は既存の `readInputBoxStatusRow`（`antigravity.ts:190`）と同じく、入力欄・信頼の画面の下の末尾の行を構造で取る。本文・scrollback・引用・古い `error:` 行は判定に使わない
- `confirmed` の条件: 状態の行が ` · <name> (` を含む。`<name>` の前は ` · `、後ろは ` (` で区切られていること（接頭辞の違う名前 `cm-role-a` と `cm-role-ab` を取り違えない）。実測の形は `auto · cm-role-x (Gemini 4 Hydrogen · high)  /agents`（`evidence/4-tui.txt`、**信頼の前の画面の一例だけ**）
- 明確な不適用（`not-applied`）は次の 3 つだけ:
  1. ペインの前景が agy でない（シェルに戻った、ペインが無い。既存の `isToolLive`）。そのうえで、起動行より後に打ち出された行の中に `unknown component: tool "<x>"` があれば、理由を「登録に無い道具」に分類する（それ以外は「agy が起動しなかった」）
  2. 入力欄が出た画面（`isAntigravityReady`、`antigravity.ts:238`）で、状態の行に生成物の名前が無い（未知の名前の実測と同じ形。`evidence/4-tui.txt` の `auto · Gemini 4 Hydrogen · high`）
  3. 信頼の画面で、状態の行に別の名前、または名前が無い（同じ実測）
- 未描画・途中の画面は `starting`。「名前が見えない」だけでは不適用にしない（事前レビュー P2-2）

**診断に出してよいもの**（I4）: 分類（登録に無い道具／起動しなかった／ロールを選ばなかった／確認できなかった）、`/^[a-z_][a-z0-9_]{0,63}$/` に合う道具の名前、確かめた版 `1.5.8`、動いている版（`/^\d+\.\d+\.\d+$/` に合うときだけ、外れたら「不明」）、生成物の名前とパス。**agy の `error:` 行をそのまま出さない**（任意の文字列は本文を引用しない保証にならない。`artifacts.ts:381` の parser の扱いと同じ考え）

#### 期限と、起動の待ち・プロンプト待ちとのつなぎ

1. **起動の中（`settleLaunchRole`、`role-launch.ts:687`）:** driver の `waitForReady` が返った後、画面を 1 回読んで状態を決める。`confirmed` なら `launched` を書く。`not-applied` なら D6 の照合のうえで止めて拒否を投げる（起動の失敗として返る）。`starting`・`unknown` ならそのまま起動を返す（プロセスは残す。起動の返り値は今と同じく「起動した」）。起動の中では追加の待ちを足さない（今の 30 秒の窓のまま）
2. **送信の門（`antigravity.ts:565` の `sendMessage`、`waitForPrompt` の中）:** 本文とキーの前に、今の世代の `application` を見る
   - `confirmed` → 送る
   - `not-applied` → 送らず、未送信の拒否
   - `starting`・`unknown` → `waitForPrompt` と**同じ待ちの中で**（足し算にしない）1 秒ごとに画面を読み直して状態を進める。期限は `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS`（60 秒、`antigravity.ts:109`。信頼の Enter を繰り越した send と同じ値。61 秒の実測は「起動の窓の終わりから約 27 秒」なので収まる）。期限までに `confirmed` にならなければ、本文を送らずに `RoleLaunchRefusedError('not-confirmed', …)`（新しい理由）。プロセスは残す（利用者は送り直すか止める）
   - 信頼の Enter を繰り越している（`antigravity-startup-trust`）ときは、その Enter を既存のとおり 1 回だけ打ち、その後の画面で判定を続ける（`tests/unit/cli-tools/antigravity-late-trust-3757.test.ts:141` の経路をロールつきでも通す）
3. **門を通る send:** 利用者の send、契約の送信、`requireSession` が tool の終了を見て起こし直したもの（`antigravity.ts:573`。起こし直すと新しい世代になり、状態は `starting` から）。**Auto-Yes の応答キーと `respond` は本文ではないので門の外**（§11 の本文に無い指摘）
4. **門の対象:** このサーバーが Antigravity をロールつきで起動した世代（証拠に Antigravity の注入がある）だけ。ロールの無い起動と、証拠の無い再接続（サーバーの再起動の後など）は今と同じ（I5。適用状態は既存の規則どおり「不明」）
5. **`requested` の fingerprint を確認の代わりにしない。** ロール条件つきの send（`send-role.ts:263`）も、fingerprint と generation が合っていても、Antigravity では `application === 'confirmed'` までは本文へ進まない（門は driver の中にあるので、条件の有無によらず同じ）

### D3 起動前の照合: `agy agent` の一覧

#### 置き場所（事前レビュー P2-3）

- `antigravity.ts:269` の `launchSession` の中、`antigravity.ts:278` の `if (live) return;`（既存プロセスの再利用）の**後**、`antigravity.ts:288` の `beginAgentSession`（最初の副作用）の**前**。ここを通るのは「今回本当に新しいプロセスを起こす」分岐だけ（新規のペイン、または同じペインで tool が終わっていた起こし直し）
- 呼ぶのは role-launch の新しい関数（例 `confirmRoleDiscoverableForLaunch()`）。今の起動の scope（`role-launch.ts:445` の `runWithLaunchRole`）にロールの注入があるときだけ照合する。ロールの無い起動・scope の外では何もしない（I5）
- 再接続（`live`）は照合しない。生成物の拒否があっても動いているプロセスへ再接続する既存の例外（`base.ts:410`）はそのまま。別のサーバーのセッション（`ForeignSessionError`）は `resolveLaunchPane`（`base.ts:878`）が何も触らずに拒否するので、照合まで来ない
- headless（Schedule、`role-launch.ts:861` の `resolveScheduleRole` → `src/lib/session/claude-executor.ts:202`）には入れない。headless は未知の名前で exit 1（`evidence/2-headless-q1-flags-first.txt`）、登録に無い道具で exit 3（`evidence/r2-2-dev-tools.txt`）になり、実行記録は `failed` と出力を残す（`src/lib/job-executor.ts:285`）

#### 判定

- 出力の行（前後の空白を除く）に生成物の名前と完全に一致する行があれば通る。無ければ `RoleLaunchRefusedError('artifact-failed', …)`。理由は「agy がこの定義を見つけなかった」と名前・パス
- 非 0・時間切れ・起動できない → 同じく `artifact-failed`。理由は exit code か「時間切れ」だけ（stderr は出さない）
- **D3 の成功は適用の証拠ではない。** 一覧に出たことは「この環境の agy がこの定義を読める」ことまでで、TUI がそれを選んだことは D2 でしか確かめない

#### 子プロセスの環境と隔離（事前レビュー P3-2）

- cwd は worktree。`PATH` と `HOME` は、ペインが受け取る tmux の環境（既存の `roleEnvReaderForPane`、`src/lib/agent-roles/pane-env.ts`）に値があればそれを使い、無ければサーバーのもの。ペインに打つのは素の `agy`（`antigravity.ts:305` の `executablePath: this.command`）なので、同じ解決になるように寄せる。それでもシェルの初期化で別の版・別のホームになる配置はありうる（見立て、未再現）。その差は D2 が拾う
- 上限: 10 秒で打ち切って子を SIGKILL、標準出力は 64 KiB まで読んで超えたら失敗、標準エラーは 4 KiB まで読んで捨てる（理由に出さない）。`agy --version` は 5 秒・256 バイト
- 副作用（事実）: `agy agent` は `~/.gemini/antigravity-cli/` のログを 1 本増やす（`agent-roles-adapters.md` §10）。ログ以外の変更が無いのは 1.4.12 の観測で、1.5.8 以後の保証ではない。D3 は hooks の設定より前に走るので、後で起動が拒否されても子の副作用は先に起きている
- `CM_UAT_ISOLATION=1`（共有のホームを読むだけ、`src/config/uat-isolation.ts`）: 子を起こす前に拒否する（`UatIsolationLaunchRefusedError`）。agy のログが本物のホームに増えるため。`own-home`（専用の OS ユーザー）では照合する
- `--log-file`（`agy --help` にある全体の引数）を `agy agent` に付けてログを一時ディレクトリへ逃がせるかは**未確認**。実装の PR で一時ホームで 1 回確かめ、効けば通常の起動でも使い、`CM_UAT_ISOLATION=1` の拒否を外すかを PM に返す（§9 Q6）

### D4 有効化のスイッチを消す

- `src/types/agent-roles.ts:38` の `AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR` と `src/types/agent-roles.ts:46` の `isAgentRoleAdapterEnabled` を消す
- 呼び手: `role-launch.ts:293`（起動の拒否）、`send-role.ts:188`（send の `role` の拒否、409）、`src/lib/agent-roles/management.ts:229`・`:244`・`:407`・`:428`（API の `adapterEnabled`）
- **API の `adapterEnabled` は残し、常に `true` を返す**（`docs/user-guide/cli-operations-guide.md:3616` の `--json` の形）。拒否の理由 `adapter-disabled`（`src/lib/agent-roles/launch-errors.ts:28`）は型に残し、コメントを「新しいサーバーは返さない。旧いサーバーの応答を読むため」に直す
- **JSON の形の互換と警告の互換を分ける**（事前レビュー P3-3）:
  - 画面はサーバーと同じ版で配られるので、注記を消す: `src/components/roles/InstanceRolesSection.tsx:233`・`src/components/roles/RepositoryRoleDefaults.tsx:126`・`src/components/settings/AgentRolesSettings.tsx:537`・`src/components/worktree/AgentAddMenu.tsx:465` と、辞書 `locales/ja/common.json:383`・`locales/en/common.json:383` の `adapterDisabledNote`
  - CLI は旧いサーバーにも繋がるので、警告（`src/cli/commands/roles.ts:345` の `warnAdapterDisabled`、`src/cli/commands/instances.ts:659`）は**残す**。`adapterEnabled === false` を返すのは旧いサーバーだけになり、そのときの表示は今と同じ文面。新しいサーバーでは出ない
- 利用者向けの文書: `docs/user-guide/cli-operations-guide.md:3556`・`docs/en/user-guide/cli-operations-guide.md:2691`・`docs/user-guide/webapp-guide.md:484`・`docs/en/user-guide/webapp-guide.md:455` の「有効になるまで拒否」を、「ロールが解決されると `~/.gemini/config/agents/` に定義を書いて起動し、適用を確かめるまで本文を送らない」に直す。CLI の警告は「旧いサーバーに繋いだときだけ」と書く
- 前の設計の更新: `agent-roles-adapters.md:18`（表の Antigravity 行）と §6.6 に、この文書への参照を足す

### D5 adapter の版

- Antigravity の adapter の版を `'2'` にし、他の 6 adapter は `'1'` のまま（`adapters.ts:25` を adapter ごとの値にする）。`adapters.ts:114` の canonical に入る値と、返す `adapterVersion` を同じ値にする
- 他の 6 adapter の注入 fingerprint は 1 バイトも変わらない（N3）
- 旧い版（`tools` なし）で起動して動いているプロセスは、旧い証拠のまま「再起動待ち」または「不明」になる。新しい版で適用済みと書き直さない。旧い定義は消さない（`artifacts.ts` の先頭のコメントの「消さない」）

### D6 await の後の世代の照合（事前レビュー P2-4）

今の規則（`role-launch.ts:438` の `isStale`）: 停止で epoch が動き、起動の世代が今の世代でなくなれば、古い起動は記録も停止もしない。新しい await がこの規則の外に出ないよう、次の 3 か所で照合する。

| 場所 | 前の await | 照合 | 外れたとき |
|---|---|---|---|
| D3 の直後、`beginAgentSession`（`antigravity.ts:288`）の前 | `agy agent`（最大 10 秒） | 起動の scope の epoch が今の epoch と同じ、かつ別の起動が世代を開いていない | `RoleLaunchRefusedError('session-stopped')`。ペイン・起動のキー・記録は 0 |
| D2 の kill の直前（起動の中と送信の門の両方） | 画面の取得・`isToolLive`・`agy --version` | `isStale` が偽、かつ今の証拠の generation がこの判定の generation と同じ | 何もしない（止めない・記録しない・消さない）。起動の中なら起動を返し、送信の門なら「プロセスが入れ替わった」で未送信の拒否（既存の `RoleConditionUnmetError` と同じ） |
| 記録の破棄（`forgetLaunchRoleEvidence`、`role-launch.ts:781`）の直前 | 同上 | 同上 | 消さない。破棄は「この generation のときだけ消す」形の関数にする |

**kill が別の世代を取り違えない条件:** 止める処理は、起動行を打つのと同じインスタンスの入力のロック（起動行は `antigravity.ts:331` の `typeLaunchLines` がロックの中で打つ。#3981）を取ってから、ロックの中でもう一度 generation を照合し、合っているときだけ kill を出す。照合と kill の間に後継の起動行が打たれることは、同じロックで閉じる。

## 4. 不変条件

| # | 不変条件 | 何が守るか |
|---|---|---|
| I1 | **ロールが解決されてこのサーバーが起動した Antigravity の世代へ、適用を確認する前に本文を送らない。** 確かめられないうちは待つか未送信で拒否する。「画面を取れない」も送ってよい理由にしない | D2 の送信の門 |
| I2 | **登録に無い道具の名前で動かさない。** 生成物の `tools` は確かめた定数だけ。版が変わって登録から消えたら、agy の exit 3 を見て止める | D1、`formatProblem`、D2 の明確な不適用 1 |
| I3a | **CommandMate が利用者のホームに書くのは 1 か所だけ。** `~/.gemini/config/agents/` の下の `cm-role-` で始まるディレクトリとその中の `agent.md`（0600、ディレクトリは 0700）。既存のファイルは書き換えず、消さない。`~/.gemini/config/hooks.json` は #1762 の既存の書き込みで変えない。`CM_UAT_ISOLATION=1` では、同じバイトの既存の生成物があれば再利用し、無ければ書かずに拒否する（`artifacts.ts:690` の既存の規則）。`own-home` では専用ユーザーのホームに書く | `artifacts.ts:290`・`:690` |
| I3b | **agy の子プロセスが書くもの**（`agy agent` のログ）は I3a と別に数える。`CM_UAT_ISOLATION=1` では子を起こさない | D3 の隔離 |
| I4 | **拒否の理由とログにロールの本文と、agy の任意の文字列を入れない。** 出すのは D2 の「診断に出してよいもの」だけ | D2 |
| I5 | **ロールの無い起動の起動行と送信は今と同じ。** 照合・確認・門は、ロールの注入がある世代だけ | D2 の門の対象、D3 の置き場所、N1 |
| I6 | **他の 6 adapter と Schedule の挙動・fingerprint は変わらない** | D5、N2・N3 |
| I7 | **旧い世代の結果で今のセッションを止めず、今の記録を消さない。** 停止の後に旧い起動がペインを作らない | D6 |
| I8 | **既存プロセスの再接続は、一覧の取得の健康に縛られない** | D3 の置き場所、N4 |

## 5. 状態と遷移の表

起動 1 回（TUI、ロールの注入がある Antigravity）。「拒否（前）」はペインを作らない拒否、「拒否（後）」はペインの後に止める拒否、「未送信」は send の本文を送らない拒否。

### 5.1 起動

| 状態 | 入力・出来事 | 次 | 書くもの | 利用者に見えるもの |
|---|---|---|---|---|
| resolved | 生成物が無い／同じバイトがある | written | `agent.md` を新規作成／なし | なし |
| resolved | 別のバイト・symlink・権限・所有者の不一致・UAT で書けない | 拒否（前、`artifact-failed`） | なし | 理由（既存） |
| written | 読み直しの検査（`tools` の不一致を含む）に落ちる | 拒否（前、`artifact-failed`） | なし | `format-invalid` |
| written | driver が既存の動いているプロセスを見つけた | reused | なし（世代を開かない） | 今と同じ |
| written | 別のサーバーのセッション | 拒否（前、既存の `ForeignSessionError`） | なし | 既存 |
| written | 新しいプロセスを起こす。`CM_UAT_ISOLATION=1` | 拒否（前） | なし（子を起こさない） | UAT の理由 |
| written | 新しいプロセスを起こす。`agy agent` に名前がある | listed | agy のログ 1 本 | なし |
| written | `agy agent` に名前が無い／非 0／時間切れ | 拒否（前、`artifact-failed`） | agy のログ（起きた範囲で） | 理由（名前・パス、または exit code・時間切れ） |
| listed | D6 の照合が外れる（待ちの間に停止） | 拒否（前、`session-stopped`） | なし | 既存の文面 |
| listed | 照合が合う | starting | `beginAgentSession`、ペイン、起動行、記録 `requested` | 起動中 |
| starting | `waitForReady` の後の画面で名前がある | confirmed | 記録 `launched` | 適用済み |
| starting | 明確な不適用（§3 D2 の 1〜3） | 拒否（後、`not-applied`）※D6 | セッションを止める。生成物は残す | 分類と許された診断 |
| starting | 未描画・途中の画面 | starting | なし | 起動は返る（起動した） |
| starting | 画面を取れない | unknown | なし | 起動は返る |
| 任意 | 起動の待ちの間に停止・後継の起動 | （旧い起動は何もしない） | なし | 後継のまま |

### 5.2 送信（同じ世代へ。送信の門）

| `application` | 出来事 | 次 | 本文 | プロセス |
|---|---|---|---|---|
| confirmed | send | confirmed | 送る | 残す |
| starting / unknown | 期限（60 秒）の中で名前が見える | confirmed | 送る（1 回） | 残す |
| starting / unknown | 期限の中で明確な不適用 | not-applied | 送らない（未送信、`not-applied`） | 止める ※D6 |
| starting / unknown | 期限まで未描画のまま、または画面を取れないまま | starting / unknown のまま | 送らない（未送信、`not-confirmed`） | 残す |
| not-applied | send | — | 送らない | （既に止めた。`requireSession` が起こし直せば新しい世代で starting） |
| 任意 | 待ちの間にプロセスが入れ替わった | — | 送らない（既存の「入れ替わった」） | 後継に触らない |
| （門の対象外） | ロールの無い起動・証拠の無い再接続 | — | 今と同じ | 今と同じ |

## 6. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 成功 | 失敗のとき | 倒れる側 |
|---|---|---|---|
| `~/.gemini/config/agents/` への書き込み（`writeRoleArtifact`） | 0600 の新規ファイル、または同じバイトの再利用 | 書けない・別の中身・symlink・権限 → `artifact-failed` | **止める**（既存） |
| `agy agent`（一覧） | exit 0 で名前の行がある | 名前が無い／非 0／10 秒／出力 64 KiB 超／`agy` が無い → `artifact-failed` | **止める**。一覧が読めないまま起動すると、未知の名前の TUI が黙って動く場合と区別できない |
| agy の起動（TUI） | 状態の行に名前 | 明確な不適用 → 止めて `not-applied`。未描画・取得不明 → プロセスは残し、本文は門で止める | **本文を止める**。プロセスは明確な不適用のときだけ止める |
| 画面の取得（`capturePane`） | 画面 | 取れない → `unknown`。門の期限まで読み直す | **本文を止める**（I1） |
| `agy --version`（版の取得） | `x.y.z` | 非 0・5 秒・形が違う → 「不明」 | **進める**。理由の文面に載せるだけ。呼ぶのは止めるときだけ |
| headless（Schedule の `agy -p … --agent <name>`） | exit 0 | 未知の名前 exit 1、登録に無い道具 exit 3 → 実行記録 `failed`（既存） | **止まる**（agy 自身。変えない） |
| セッションを止める（`kill`） | ペインが消える | D6 の照合が外れる → 何もしない。止められない → 警告のログ（`role-launch.ts:711` と同じ扱い）と `not-applied` を返す | **拒否は返す**。成功とは言わない |

## 7. PR の切り方

**1 本。** D1（生成物）・D2（確認と門）・D3（照合）・D4（スイッチ）・D6（世代）は、どれか 1 つだけを develop に入れると I1 が崩れる組み合わせがある。D4 だけ先に入れると「道具の無い定義で既定で起動する」（実機の記録の初回の不合格）が入る。D1〜D3 だけでは、スイッチが残る間は誰も通らない経路になる。

分けるなら（人が 2 本を望んだとき）: PR1 = D1・D2・D3・D5・D6（スイッチは残し、`CM_AGENT_ROLE_ANTIGRAVITY_ENABLED=1` のときだけ通る。対照はロールつきの実の呼び手で持つ）、PR2 = D4。境目は「起動の防御」と「有効化」。マージの順の指定は、既存のマージの確認（merge-pr の組み合わせ確認）を省く許可ではない。

## 8. 試験の表

単体試験は `agy` を起動しない（一覧・版・画面・時計は差し替える）。生成物は `os.tmpdir()` の下に書く（`tests/setup.ts:253` の `CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR`）。純関数の試験に加え、**base → 実の driver（`antigravity.ts`）→ settle → ロールつきの send** を通し、本文とキーの回数、kill の回数、証拠の宛先を数える。各防御を外した変異で赤になることを確かめる（防御ごとの感度）。

### 8.1 生成物とスイッチ

| # | 種類 | 何を | 期待 | 直す前の実装で |
|---|---|---|---|---|
| P1 | 陽性 | 生成物の frontmatter | `tools` が 13 個の定数とこの順で一致、`swarm` が無い、`subagent: false` が残る | 落ちる |
| P2 | 陽性 | 定数の出典 | コメントに `1.5.8` と実機の記録のパス | 落ちる |
| P3 | 陽性 | `tools` の無い（1 個違う）定義の読み直し | `format-invalid` | 落ちる |
| P4 | 陽性 | 環境変数なしでロールつきの起動 | 起動行に `--agent <name>` | 落ちる（`adapter-disabled`） |
| P12 | 陽性 | `git grep -n 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED\|isAgentRoleAdapterEnabled' -- src locales docs/user-guide docs/en tests` | 0 件 | 落ちる |
| P13 | 陽性 | CLI が `adapterEnabled: false`（旧いサーバー）を受けた | 今と同じ警告 | 通る（残すことの固定） |
| N3 | 陰性 | 他の 6 adapter の注入 fingerprint と生成物のバイト | 直す前と同じ値（試験に値を書く） | 通る |
| N6 | 陰性 | API の `adapterEnabled` | 7 ツールとも `true`、項目は残る | Antigravity だけ落ちる |

### 8.2 起動前の照合（D3）

| # | 種類 | 何を | 期待 |
|---|---|---|---|
| P5 | 陽性 | 新しいプロセス、一覧に名前が無い | ペイン・`beginAgentSession`・起動のキー 0、`artifact-failed`、理由に名前とパス |
| P6 | 陽性 | 一覧が非 0・時間切れ・64 KiB 超 | 同じく 0、`artifact-failed`。時間切れで子が止められる |
| P7 | 陽性 | 一覧の待ちの間に停止 → 一覧が成功 | ペイン・起動のキー 0、`session-stopped` |
| P8 | 陽性 | `CM_UAT_ISOLATION=1` | 子を起こさずに拒否 |
| P9 | 陽性 | 照合の出力に接頭辞の違う名前だけ（`cm-role-a` に対して `cm-role-ab`） | 通らない |
| N4 | 陰性 | 既存の動いているプロセス、一覧の依存は呼ばれたら throw | 再接続が成功、呼び出し 0、記録は変わらない。生成物の拒否があっても再接続する（`base.ts:410`） |
| N4b | 陰性 | 既存のペインで tool が終わっている | 照合 1 回。失敗なら起動行 0 |
| N7 | 陰性 | 子の環境 | cwd が worktree、`PATH`・`HOME` がペインの環境の値（あれば） |

### 8.3 起動後の確認と送信の門（D2）

| # | 種類 | 何を | 期待 |
|---|---|---|---|
| P10 | 陽性 | 状態の行が `auto · <name> (Gemini 4 Hydrogen · high)  /agents` | `confirmed`、`launched`、send で本文 1 回 |
| P14 | 陽性 | 一覧は成功 → TUI は既定の agent で入力欄が出る（状態の行に名前なし） → settle の画面だけ throw → 次の send で入力欄は ready | 本文・Enter 0。期限の中で明確な不適用を見て止める（事前レビューの対照） |
| P15 | 陽性 | 終始画面を取れない | 本文 0、`not-confirmed`、プロセスは残る（kill 0） |
| P16 | 陽性 | 起動の窓（30 秒）の終わりでは未描画、61 秒後に名前と入力欄が出る（偽の時計と画面の列） | 起動は返る、kill 0、次の send が期限の中で `confirmed` にして本文 1 回 |
| P17 | 陽性 | 繰り越した信頼の Enter（`antigravity-late-trust-3757.test.ts:141` の経路）をロールつきで | Enter 1 回、その後に名前を見て本文 1 回 |
| P18 | 陽性 | 完成した TUI で別の名前 | `not-applied`、止める、本文 0 |
| P19 | 陽性 | シェルに戻り、起動行より後に `unknown component: tool "swarm" not found in registry` | `not-applied`、理由の分類が「登録に無い道具」、道具名 `swarm`、`1.5.8`、版 |
| P20 | 陽性 | `unknown component` が起動行より前の scrollback だけにある、または本文の引用の中だけにある | 「登録に無い道具」に分類しない |
| P21 | 陽性 | 状態の行の判定: ANSI つき、折り返し、幅の違い、接頭辞の違う名前、本文だけに期待の名前がある | 状態の行の完全な区切りだけで `confirmed`。本文の中の名前では `confirmed` にしない |
| P11 | 陽性 | 画面に `error: <試験用の本文の印>` を置いて不適用にする | 理由・ログに印が無い |
| P22 | 陽性 | ロール条件つきの send、fingerprint と generation は合うが `application` が `starting` | 本文 0（`requested` を確認の代わりにしない） |
| N1 | 陰性 | ロールの無い起動と send | 起動行・送信が今とバイト単位で同じ、門も一覧も呼ばない |
| N2 | 陰性 | Schedule（headless） | 一覧も門も呼ばない。引数は `-p … --dangerously-skip-permissions --agent <name>` |
| N5 | 陰性 | 証拠の無い再接続（サーバーの再起動の後） | 門の対象外、今と同じ |

### 8.4 世代（D6）

| # | 種類 | 何を | 期待 |
|---|---|---|---|
| P23 | 陽性 | 旧い起動の画面・`isToolLive`・版の待ちの間に停止 → 後継の起動 → 旧い待ちが「不適用」で返る | 後継の kill 0、後継の証拠は残る（`role-launch-4115.test.ts:898` の Copilot の対照を Antigravity の実の経路に） |
| P24 | 陽性 | 送信の門の待ちの間に `requireSession` の起こし直し | 旧い門は後継を止めず、本文 0、「入れ替わった」 |
| P25 | 陽性 | kill の照合をロックの外でだけ行う変異 | 試験が赤になる（照合と kill の間に後継の起動行が入る並びを作る） |

### 8.5 古い動きを固定している試験（実装の契約で変更を許す）

- `tests/unit/agent-roles/adapters-4115.test.ts:296`（`Antigravity is on only when someone says so`）→ 消して P4 に
- `tests/unit/session/role-launch-4115.test.ts:433`（`adapter-disabled`）→ P4・P5 の形へ
- `tests/unit/session/role-schedule-4115.test.ts:115`（`the disabled adapter refuses`）→ N2 へ
- `tests/unit/app/api/worktrees/send-role-4115.test.ts:185`（`refuses a role on a disabled adapter, saving nothing`）→ 保存して通ることへ
- `tests/integration/api-agent-roles-4114.test.ts:335`（`antigravity is settable but marked as not enabled`）→ N6 へ
- `tests/integration/fixtures/agent-roles-api-examples.ts:124`（`adapterEnabled: false`）→ `true`
- `tests/setup.ts:252` の `delete process.env.CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と、それを固定する `tests/unit/config/codex-home-isolation-4146.test.ts:152` → 両方を消す（対で）
- `tests/unit/agent-roles/artifacts-4114.test.ts:417`（`subagent: false`）→ 残す
- 注記を消す画面の読者: `tests/unit/components/roles/agent-roles-screen-4117.test.tsx`・`agent-roles-settings-4117.test.tsx` に注記を期待する行があれば、Antigravity が `true` の形へ

## 9. 未決と人の判断（推奨つき）

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| Q1 | agy の版が確かめた範囲（1.5.8）の外のとき、起動を止めるか | **止めない**（D2 の (b)） | exit 3 は agy 自身が止まり、D2 の門が本文を止める。止めると更新のたびに Antigravity のロールのワーカーが全部止まる。範囲を広げるのは新しい版で実機の記録と同じ手順（`r2-3`・`r2-4`）を通したとき |
| Q2 | API の `adapterEnabled` と理由 `adapter-disabled` を消すか | **残す**（常に `true`。CLI の警告も旧いサーバー向けに残す） | 外のスクリプトと、旧いサーバーに繋ぐ新しい CLI を壊さない。消すなら別の Issue で API の版の変更として |
| Q3 | ロールごとに道具を絞るか | **この Issue ではしない** | `run_command` がある限り書き込みは本文頼み（実機の記録の「再確認」2） |
| Q4 | 置き場所を `~/.gemini/agents/` に移すか | **移さない** | 1.5.8 で `config/agents` が出なければ D3 が毎回止める。受入 9 で確かめ、出なければそこで決め直す |
| Q5 | 期限 | 一覧 10 秒、版 5 秒、送信の門 60 秒 | 門は既存の `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS` に合わせた。一覧の時間は見立てで、実装の PR で 1 回測る |
| Q6 | `CM_UAT_ISOLATION=1` で照合を拒否するか | **拒否する**（`--log-file` が `agy agent` に効くと確かめられたら外してよい） | 本物のホームにログが増える。UAT の規則（共有のホームに書かない）を通常の起動の規則と混ぜない |
| Q7 | Auto-Yes の応答キーと `respond` を送信の門に入れるか | **この Issue では入れない** | 本文ではない。確認前のプロンプトに Auto-Yes が答えうるのは本文に無い指摘として残す（§11） |

## 10. 実装の範囲（契約にできる粒度）

**難度:** 難（セッションの起動の経路・送信の門・利用者のホームへの書き込み）。担当は opus、事前レビューは Codex（PM のブリーフどおり）。

### 変えるファイル（scope.allow の候補）

- `src/lib/agent-roles/antigravity.ts`（新規。`ANTIGRAVITY_ROLE_TOOLS`・`ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON`、一覧の照合、状態の行の判定、明確な不適用の分類、診断の文面の純関数）
- `src/lib/agent-roles/artifacts.ts`、`src/lib/agent-roles/adapters.ts`、`src/lib/agent-roles/launch-errors.ts`（`not-confirmed` を足す、`adapter-disabled` のコメント）、`src/lib/agent-roles/management.ts`、`src/lib/agent-roles/pane-env.ts`（読むだけで足りなければ）
- `src/types/agent-roles.ts`
- `src/lib/session/role-launch.ts`（`:293` の分岐を消す、`application` の状態、照合の関数、`settleLaunchRole` の Antigravity、世代つきの kill と記録の破棄）
- `src/lib/cli-tools/antigravity.ts`（照合の呼び出し、送信の門）、`src/lib/cli-tools/base.ts`（`settleLaunchRole` に渡す kill を世代つきにするなら）
- `src/app/api/worktrees/[id]/send/send-role.ts`
- `src/components/roles/InstanceRolesSection.tsx`、`src/components/roles/RepositoryRoleDefaults.tsx`、`src/components/settings/AgentRolesSettings.tsx`、`src/components/worktree/AgentAddMenu.tsx`、`locales/ja/common.json`、`locales/en/common.json`
- `docs/user-guide/cli-operations-guide.md`、`docs/en/user-guide/cli-operations-guide.md`、`docs/user-guide/webapp-guide.md`、`docs/en/user-guide/webapp-guide.md`、`docs/design/agent-roles-adapters.md`
- 試験: `tests/unit/agent-roles/**`、`tests/unit/cli-tools/antigravity*.test.ts`（`antigravity-late-trust-3757.test.ts` を含む）、`tests/unit/session/role-launch-4115.test.ts`、`tests/unit/session/role-schedule-4115.test.ts`、`tests/unit/app/api/worktrees/send-role-4115.test.ts`、`tests/unit/config/codex-home-isolation-4146.test.ts`、`tests/unit/components/roles/agent-roles-*.test.tsx`、`tests/unit/cli/utils/agent-roles-4116.test.ts`、`tests/setup.ts`、`tests/integration/api-agent-roles-4114.test.ts`、`tests/integration/fixtures/agent-roles-api-examples.ts`、`tests/unit/docs/**`
- `changelog.d/4385.md`（この設計の断片へ統合。1 項目・1 行）
- CLI の `src/cli/commands/roles.ts`・`instances.ts` は**変えない**（警告を残す）

### 受入基準

1. 生成物に `tools` があり、13 個の一覧と出典（1.5.8・実機の記録のパス）が試験で固定されている（P1・P2）
2. 環境変数なしでロールつきの Antigravity が起動する。P12 の grep が 0 件
3. 新しいプロセスを起こすときだけ `agy agent` と照合し、無ければペインを作らずに理由つきで拒否する。再接続は照合しない（P5〜P9・N4・N4b）
4. 適用は 4 つの状態で持ち、確認済みになるまで本文を送らない。画面を取れないことも未描画も「送ってよい」にしない。期限は 60 秒で、過ぎたら未送信の拒否（P10・P14〜P22）
5. 遅い正常な起動（61 秒）を止めない（P16・P17）
6. 旧い世代の結果で後継を止めず、証拠を消さない。停止の後に旧い起動がペインを作らない（P7・P23〜P25）
7. 拒否の理由・ログに本文と agy の任意の文字列が入らない（P11・P19・P20）
8. ロールの無い起動・Schedule・他の 6 adapter・証拠の無い再接続は変わらない（N1〜N5・N3）
9. 一時ホーム（`os.tmpdir()` の下、`HOME` を差し替え）で agy 1.5.8 の `agy agent` が `~/.gemini/config/agents/<dir>/agent.md` の定義を一覧に出すことと、`--log-file` が `agy agent` のログを動かすかを 1 回ずつ確かめ、出力をコミットメッセージの本文に書く（認証は要らない。本物の `~/.gemini` には書かない）。一覧に出なければ実装を止めて PM に返す（Q4）
10. CHANGELOG の断片に挙動の変更（Antigravity でロールが既定で有効、`~/.gemini/config/agents/` に定義を書く、確かめた agy の版 1.5.8、起動前の一覧の照合、適用を確かめるまで本文を送らないこと、CLI の警告は旧いサーバーのときだけ）
11. （マージの後、PM）信頼済みの worktree の TUI で、ロールつきの起動でロールの本文が守られ、編集・実行ができ、適用状態が「適用済み」になる。存在しない名前の定義では起動が理由つきで止まる。**信頼の後の状態の行に名前があること**（D2 の見立て）をここで確かめる

### gates

- 契約の検証: `npm run test:unit`（`tests/setup.ts` に触るため。手元では次の対象だけを走らせ、全体は検証ゲートと CI で）
- 手元: `npx vitest run tests/unit/agent-roles tests/unit/cli-tools/antigravity*.test.ts tests/unit/session/role-launch-4115.test.ts tests/unit/session/role-schedule-4115.test.ts tests/unit/app/api/worktrees/send-role-4115.test.ts tests/unit/config/codex-home-isolation-4146.test.ts tests/unit/components/roles tests/unit/cli/utils/agent-roles-4116.test.ts tests/unit/guards tests/unit/docs`
- integration: `tests/integration/api-agent-roles-4114.test.ts`（設定のファイル名は実装の時点で確かめる）
- `npm run lint`、`npx tsc --noEmit`、`npm run build`（画面と辞書と、client が読む `src/types/agent-roles.ts` を変えるため）
- e2e: `tests/e2e/agent-roles-4117.spec.ts`（`adapterEnabled: true` の形。UI の既定は変えない）

## 11. 本文に無い指摘（この設計の範囲の外）

- `antigravity.ts:427` の `waitForReady` は時間切れで throw しない。ロールの無い起動でも、agy が終わってシェルに戻ったペインを起動できたと扱いうる（ロールつきは D2 の門で塞ぐ。ロールの無い経路は変えない）
- 確認前（`starting`）の Antigravity のプロンプトに Auto-Yes が答えうる。応答キーは本文ではないので門に入れていない（Q7）

## 12. 改訂の内容（事前レビューへの対応）

| 指摘 | 反映した場所 |
|---|---|
| P2-1 画面を取れないことを「送ってよい」に倒していた | D2 の 4 つの状態と送信の門、I1、§5.2、P14・P15・P22 |
| P2-2 遅い正常な起動を「選ばなかった」と止めていた | D2 の「明確な不適用」を 3 つに限定、期限とつなぎ、P16・P17 |
| P2-3 D3 の置き場所が再接続と両立しなかった | D3 の置き場所、I8、N4・N4b |
| P2-4 await の後の停止・世代交代が無かった | D6、I7、P7・P23〜P25 |
| P3-1 画面の判定と診断の範囲 | D2 の「画面から判定してよい範囲」「診断に出してよいもの」、I4、P11・P19〜P21 |
| P3-2 子プロセスの隔離と環境 | D3 の「子プロセスの環境と隔離」、I3a/I3b、Q6、P8・N7 |
| P3-3 互換の残し方と試験の範囲 | D4（CLI の警告を残す）、P13、§10 の試験と gates |

## 13. この設計で確かめたこと

- `agy --version` → `1.5.8`、exit 0
- `agy --help` → `--agent` は「Agent for the current CLI session」。サブコマンド `agent`・`agents` は「List available agents」。全体の引数に `--log-file`（Override CLI log file path）がある。出力の形式を選ぶ引数は一覧には無い
- `agy help agent` と `agy agent --help` → `Usage: agy agent [flags]`、フラグは `-h` / `--help` だけ
- `agy changelog`（同梱）: 1.1.1 で `--agent` と `agent/agents`、1.1.5 で `subagent: false` の修正、1.1.6 で Markdown の custom agent、1.2.1 で `excludeDefaultComponents`、1.2.7 で「既定の道具から外した `find_by_name`・`grep_search`・`list_dir` は、`tools` に書いた custom agent では使える」。`tools` に書ける名前の一覧や、未知の名前の扱いを書いた項は見つからなかった
- `~/.gemini/config/` に `agents` ディレクトリは今は無い。`~/.gemini/agents` も無い

## 改訂の履歴

- 2026-11-14 第 2 版: 事前レビュー（P2 4 件・P3 3 件）を反映。適用の 4 状態と送信の門、D3 を新しいプロセスの分岐へ、D6 世代の照合、診断と子プロセスの範囲、CLI の警告を残す、試験・gates を更新（§12）
