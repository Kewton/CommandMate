# Antigravity のロールを既定で有効にする（Issue #4385）

- 正本: Issue #4385 の本文、実機の記録 `dev-reports/issue/agy-role-2026-11-14/report.md`（主のチェックアウトにある。初回と「再確認」の節、`evidence/` の各ファイル）
- 前の設計: [agent-roles-adapters.md](./agent-roles-adapters.md) §6.6（agy 1.4.12 の一時ホームでの実測）
- この文書の書き方: **事実**（実測・実コード・agy の同梱文書で確かめたもの）と**見立て**（確かめていないもの）を分けて書く。見立てには「見立て」「未確認」と書く
- この設計ではコードを書かず、agy のセッションも起動していない。読んだのは `agy --version`・`agy --help`・`agy help agent`・`agy changelog` の出力と、`~/.gemini` の一覧（読むだけ）

## 1. 結論

1. 生成物（`~/.gemini/config/agents/<name>/agent.md`）の frontmatter に `tools` を足す。中身は 1.5.8 で確かめた 13 個の定数で、出典を書く（§3 D1）
2. `CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と `isAgentRoleAdapterEnabled` を消し、Antigravity のロールを既定で有効にする。API の `adapterEnabled` は互換のために残し、常に `true` を返す（§3 D4）
3. **版の範囲で起動を止めない。** agy の版が変わって登録に無い道具の名前が出たときは、agy 自身が exit 3 で止まる（fail-closed、実測）。抜けていたのは「止まったことが見えない」ことなので、起動の後の確認で拾い、理由を出してセッションを止める（§3 D2）
4. **起動の前に `agy agent` の一覧と照合する。** 生成物の名前が一覧に無ければ起動しない。agy の TUI は未知の名前でも黙って既定の agent で起動する（実測）ので、これが「黙ってロールなしで動く」を塞ぐ主な手段になる（§3 D3）
5. **起動の後に TUI の状態の行で名前を確かめる。** 名前が見えれば `launched` を記録し、見えなければ止める。これで Antigravity の適用状態は「不明」から「確かめた」に変わる（§3 D2）
6. PR は 1 本（§7）

## 2. 実コードとの照合（Issue の本文との食い違い）

| # | Issue の本文 | 実コード（正） | この設計の扱い |
|---|---|---|---|
| 1 | 定義の置き場所は `~/.gemini/agents/<name>/agent.md` | `src/lib/agent-roles/artifacts.ts:290` の `resolveArtifactLocation` は `~/.gemini/config/agents/<name>/agent.md`（`hooks.json` の隣。`artifacts.ts:257` の `antigravityAgentsDir`、`src/lib/hooks/sources/antigravity/hooks-config.ts:213`） | 実コードの置き場所を保つ。1.4.12 では 2 つとも一覧に出た（`agent-roles-adapters.md:255`）。実機の記録（1.5.8）は `~/.gemini/agents/` だけを試しており、**1.5.8 で `config/agents` が一覧に出るかは未確認**。起動前の照合（D3）がこの差を毎回の起動で確かめるので、置き場所がずれていれば黙らずに止まる。実装の PR で一時ホームの `agy agent` で確かめる（§10 の受入 6） |
| 2 | 生成物に足すのは `tools` だけ | `src/lib/agent-roles/adapters.ts:25` の `ADAPTER_VERSION` は 7 adapter で 1 つ。生成物のバイトが変わるのに注入 fingerprint が同じだと、同じ名前に別の中身が来て `content-mismatch` で拒否される（`artifacts.ts:690` の `writeRoleArtifact`） | Antigravity だけ adapter の版を `'2'` に上げる（D5）。全体の `ADAPTER_VERSION` を上げると他の 6 adapter の fingerprint が動き、稼働中のロールのセッションがすべて「再起動待ち」になる |
| 3 | （記述なし）起動後の確認 | `src/lib/session/role-launch.ts:724` の `settleLaunchRole` は Antigravity を「確認の手段が無い」として何もしない。`src/lib/cli-tools/antigravity.ts:362` の `waitForReady` は時間切れでも throw しない（`antigravity.ts:427` で記録して戻る） | agy が exit 3 で TUI を出られずシェルに戻っても、今のコードは起動できたものとして返す（見立て。TUI での exit 3 は未実測）。その後の send はシェルに本文を打つ。D2 の起動後の確認で塞ぐ |
| 4 | 「TUI で未知の名前のとき、動くなら起動前に `agy agent` の一覧と照合して止める」 | `agy help agent` は `Usage: agy agent [flags]` / `List available agents` だけで、出力の形式の指定（JSON など）は無い（1.5.8、この設計で読んだ）。一覧は 1 行に 1 つの名前（`evidence/1-list.txt`、`r2-1-list.txt`） | 行ごとに完全一致で照合する（D3） |
| 5 | 「登録に無い名前を 1 つでも書くと exit 3」 | 一覧（`agy agent`）は登録に無い道具を書いた定義も**出す**（`evidence/r2-1-list.txt`: `swarm` を含む 14 個の `cm-role-dev` が一覧に出て、その後の起動が exit 3） | 起動前の照合では道具の名前の誤りを見つけられない。版への追従は起動後の確認で拾う（D2） |

## 3. 決めたこと

### D1 `tools` の一覧

- 定数 `ANTIGRAVITY_ROLE_TOOLS`（13 個、この順）と `ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON = '1.5.8'` を持つ。出典のコメントに実機の記録のパス（`dev-reports/issue/agy-role-2026-11-14/report.md` の「再確認」の節、`evidence/r2-3-tool-registry-probe.txt`・`r2-4-dev-tools13.txt`）と日付（2026-11-14）を書く

```
read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, manage_subagents, write_file, edit_file, search_web, run_workflow, ask_question
```

- `swarm` は入れない（1.5.8 の登録に無い。exit 3、実測）
- frontmatter には実測と同じブロックの形（`tools:` の下に `  - <name>` を 1 行ずつ）で書く。インラインの `[a, b]` は実測の定義ファイルでは使っていない
- `excludeDefaultComponents` は書かない（実測でも書いていない。AGENTS.md は守られた）
- ロールごとに道具を絞ること（読むだけのロールなど）はこの Issue の範囲外（§9 Q3）
- `formatProblem`（`artifacts.ts:388`）の Antigravity の検査に「`tools` が定数と同じ配列であること」を足す。中身はバイト列の fingerprint でも決まるが、読み直しの検査（`artifacts.ts:631` の `inspectRoleArtifact`）が「道具の無い定義」をはっきり拒否できるようにする

### D2 版への追従: 範囲で止めず、起動の後に確かめて止める

**採る案: 起動後の確認。** 選ばない案と理由も書く。

| 案 | 中身 | 判断 |
|---|---|---|
| (a) 版の範囲で止める | `agy --version` が確かめた範囲の外なら起動しない | **採らない**（既定）。agy は頻繁に出る（同梱の changelog で 1.4.12 から 1.5.8 まで 12 版）。範囲の外では、道具の一覧が通る版でも毎回ロールの起動が止まる。止まること自体は見えるが、更新のたびに Antigravity のワーカーが全部止まる。人の判断に残す（§9 Q1） |
| (b) 起動の後に確かめる | 起動した TUI の状態の行に名前があり、ペインが agy のままなら `launched`。どちらかが崩れたらセッションを止めて、理由を出す | **採る**。exit 3 は agy 自身の fail-closed なので、CommandMate がすることは「止まったことを見えるようにする」こと |
| (c) 起動の前に短い headless を走らせる | `agy --agent <name> -p …` を 1 回実行する（実機の記録の提案 (b)） | **採らない**。1 回の起動ごとにモデルを 1 回呼ぶ（課金と数十秒）。exit 3 は起動の直後に出るが、成功の判定にはモデルの応答を待つ必要がある |

起動後の確認の規則（`settleLaunchRole`、`role-launch.ts:687` の Antigravity の分岐）:

1. ペインの画面を取る（`src/lib/cli-tools/base.ts:416` の `capture`、200 行）
2. 状態の行に ` · <name> (` が**ある**かつペインが agy のまま（`isAlive`）→ `launched` を記録する
3. 画面に `unknown component: tool "` がある → セッションを止め、`RoleLaunchRefusedError('not-applied', …)`。理由の文面に「agy が道具の名前を受け付けなかった」「確かめた版 1.5.8」「動いている版（`agy --version`、取れなければ『不明』）」と、画面から取った道具の名前（`tool "<x>"` の `<x>`。英数字と `_` だけを取り出す）を入れる。ロールの本文は入れない
4. ペインが agy でない（シェルに戻った、ペインが無い）→ 止めて `not-applied`。理由は「agy が起動しなかった」と、画面の最後の `error:` 行（あれば、200 文字まで）
5. agy は動いているが状態の行に名前が無い → 止めて `not-applied`。理由は「agy がロールを選ばなかった」（未知の名前の TUI の実測と同じ形。`evidence/4-tui.txt`）
6. 画面を取れなかった → `launched` を書かない（「不明」のまま）。止めはしない（取れないのは tmux 側の一時的な失敗でありうる。起動前の照合は通っている）

**事実と見立ての区別:** 状態の行の形（既知の名前で `auto · cm-role-x (Gemini 4 Hydrogen · high)  /agents`、未知の名前で `auto · Gemini 4 Hydrogen · high`）は**信頼のダイアログの前**の画面での実測（`evidence/4-tui.txt`）。信頼の後・入力欄が出た後にも同じ行があるか、TUI で exit 3 がどう見えるか（画面に `error:` が残ってシェルに戻るか）は**未確認**。規則 2〜5 はどちらに転んでも fail-closed になるように置いた: 名前が見えなければ止まるので、見立てが外れたときの症状は「ロールつきの起動が理由つきで止まる」で、「黙ってロールなしで動く」ではない。マージ後の PM の実機確認（§10 の受入 8）でこの見立てを確かめる。

### D3 起動の前の照合: `agy agent` の一覧

- 生成物を書いて読み直した後（`role-launch.ts:370` の `prepareRoleLaunch` の後）、ペインを作る前に `agy agent` を実行し、出力の行（前後の空白を除く）に生成物の名前と完全に一致する行があることを確かめる
- 無ければ起動しない。`RoleLaunchRefusedError('artifact-failed', …)`。理由は「agy がこの定義を見つけなかった」「置いた場所 `<path>`」。名前とパスだけで、本文は入れない
- これで塞ぐもの（事実）: 未知の名前の TUI が黙って既定の agent で起動すること（`evidence/4-tui.txt`）。1.4.12 の実測では、壊れた frontmatter や frontmatter の無い定義は一覧から消える（`agent-roles-adapters.md:256`）ので、それも起動前に止まる。置き場所が agy の探す場所とずれたとき（§2 の 1、`CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR` で別の場所を指したとき）も止まる
- 塞がないもの（事実）: 登録に無い道具の名前（`evidence/r2-1-list.txt`）。これは D2 の起動後の確認が拾う
- 置く場所: TUI の経路だけ（`base.ts:409` の `gateLaunchRole` の後、`base.ts:413` の `launchSession` の前）。headless（Schedule、`role-launch.ts:861` の `resolveScheduleRole` → `src/lib/session/claude-executor.ts:202`）には入れない。headless は未知の名前で exit 1（`evidence/2-headless-q1-flags-first.txt`）、登録に無い道具で exit 3（`evidence/r2-2-dev-tools.txt`）になり、Schedule の実行記録は `failed` と出力の本文を残す（`src/lib/job-executor.ts:285`）。headless は既に黙らない
- 実行の仕方: 非同期の子プロセス（イベントループを止めない）。cwd は worktree、環境はサーバーのもの（生成物の書き手 `artifacts.ts` が `homedir()` で置き場所を決めるのと同じ前提）。時間の上限 10 秒（見立て。実測の `agy agent` はすぐ返ったが時間は記録していない）。依存を差し替えられる形にする（単体試験は `agy` を起動しない）
- 副作用（事実）: `agy agent` は `~/.gemini/antigravity-cli/` のログを 1 本増やす（`agent-roles-adapters.md` §10 の記録）。設定のファイルは書かない（見立て。1.4.12 で「ログ以外の変更は見ていない」）

### D4 有効化のスイッチを消す

- `src/types/agent-roles.ts:38` の `AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR` と `src/types/agent-roles.ts:46` の `isAgentRoleAdapterEnabled` を消す
- 呼び手: `role-launch.ts:293`（起動の拒否）、`src/app/api/worktrees/[id]/send/send-role.ts:188`（send の `role` の拒否、409）、`src/lib/agent-roles/management.ts:229`・`:244`・`:407`・`:428`（API の `adapterEnabled`）
- **API の `adapterEnabled` は残し、常に `true` を返す。** CLI の `--json` の形（`docs/user-guide/cli-operations-guide.md:3616`）と古い画面が読むため。消すかは §9 Q2
- 拒否の理由 `adapter-disabled`（`src/lib/agent-roles/launch-errors.ts:28`）は型に残し、「新しいサーバーは返さない。古いサーバーの応答を CLI が読むため」とコメントを直す。消すかは §9 Q2
- 「無効」の説明を消す: 画面 `src/components/roles/InstanceRolesSection.tsx:233`・`src/components/roles/RepositoryRoleDefaults.tsx:126`・`src/components/settings/AgentRolesSettings.tsx:537`・`src/components/worktree/AgentAddMenu.tsx:465` の注記と、辞書 `locales/ja/common.json:383`・`locales/en/common.json:383` の `adapterDisabledNote`。CLI の警告 `src/cli/commands/roles.ts:345`（`warnAdapterDisabled`）と `src/cli/commands/instances.ts:659`。利用者向けの文書 `docs/user-guide/cli-operations-guide.md:3556`・`docs/en/user-guide/cli-operations-guide.md:2691`・`docs/user-guide/webapp-guide.md:484`・`docs/en/user-guide/webapp-guide.md:455`
- 前の設計の更新: `agent-roles-adapters.md:18`（表の Antigravity 行）と §6.6 に、この文書への参照と「1.5.8 で tools を明示して有効化」を足す

### D5 adapter の版

- Antigravity の adapter の版を `'2'` にし、他の 6 adapter は `'1'` のまま（`adapters.ts:25` を adapter ごとの値にする。`adapters.ts:114` の canonical に入るのはその値）
- 他の 6 adapter の注入 fingerprint は 1 バイトも変わらない（試験 N3 で固定する）
- 版が上がるので、古い形（`tools` なし）の定義が同じ名前で残っていても衝突しない。古い定義は消さない（「消さない」の規則、`artifacts.ts` の先頭のコメント）。`agy agent` の一覧に残るのは既知の制約（`agent-roles-adapters.md` §14 の #4114 の行）

## 4. 不変条件

| # | 不変条件 | 何が守るか |
|---|---|---|
| I1 | **ロールが解決された Antigravity の起動は、黙ってロールなしで動かない。** ロールが効いたと確かめられるか、理由つきで止まるかのどちらか。確かめられないのは「画面を取れなかった」ときだけで、そのときは `launched` を書かない（「不明」） | 起動前の照合（D3）、起動後の確認（D2）、既存の生成物の検査（`artifacts.ts:631`） |
| I2 | **登録に無い道具の名前で起動しない。** 生成物の `tools` は確かめた定数だけで、利用者やロールの本文から足されない。版が変わって定数の名前が登録から消えたら、agy の exit 3 を見て止める | D1 の定数、`formatProblem` の検査、D2 の規則 3 |
| I3 | **利用者のホームに書くのは 1 か所だけ。** `~/.gemini/config/agents/` の下の `cm-role-` で始まるディレクトリと、その中の `agent.md`（0600、ディレクトリは 0700）。`agents` が無ければ 0700 で作る。既存のファイルは書き換えず、消さない。`~/.gemini/config/hooks.json` は #1762 の既存の書き込みで、この Issue では変えない。UAT の隔離（`CM_UAT_ISOLATION=1`）では書かずに拒否する（`artifacts.ts:690` の既存の規則） | `artifacts.ts:290`・`:690` の既存の規則 |
| I4 | **拒否の理由とログにロールの本文を入れない。** 入るのは生成物の名前・パス・agy の版・画面から取った道具の名前（英数字と `_`）・agy の `error:` 行（200 文字まで） | D2・D3 の文面の規則 |
| I5 | **ロールの無い起動の起動行は今とバイト単位で同じ。** 照合も確認も、ロールが解決されたときだけ走る | `role-launch.ts:610` の既存の規則、試験 N1 |
| I6 | **他の 6 adapter の挙動と fingerprint は変わらない** | D5、試験 N3 |

## 5. 状態と遷移の表

起動 1 回（TUI、ロールが解決された Antigravity）の状態。「次」の列の `refused` はペインを作らない拒否、`stopped` はペインを作った後に止める拒否。

| 状態 | 入力・出来事 | 次 | 書くもの | 利用者に見えるもの |
|---|---|---|---|---|
| resolved | 生成物が無い | written | `agent.md` を新規作成 | なし |
| resolved | 同じバイトの生成物がある | written（再利用） | なし | なし |
| resolved | 別のバイトの生成物・symlink・権限・所有者の不一致 | refused（`artifact-failed`） | なし | 未送信のエラーと理由（既存） |
| resolved | UAT の隔離で書けない | refused（`artifact-failed`） | なし | 既存 |
| written | 読み直しの検査（`tools` の不一致を含む）に落ちる | refused（`artifact-failed`） | なし | 理由（`format-invalid`） |
| written | `agy agent` に名前がある | listed | ログ 1 本（agy 側） | なし |
| written | `agy agent` に名前が無い | refused（`artifact-failed`） | なし | 「agy がこの定義を見つけなかった」とパス |
| written | `agy agent` が非 0・時間切れ・起動できない | refused（`artifact-failed`） | なし | 「agy の一覧を読めなかった」と exit code または時間切れ |
| listed | ペインを作り起動行を打つ | started | 記録 `requested`（既存） | 起動中 |
| started | 状態の行に名前があり agy が動いている | launched | 記録 `launched` | 適用状態「適用済み」 |
| started | 画面に `unknown component: tool "<x>"` | stopped（`not-applied`） | 生成物は残す | 「agy が道具の名前 `<x>` を受け付けなかった。確かめた版 1.5.8、動いている版 <v>」 |
| started | ペインが agy でない | stopped（`not-applied`） | 生成物は残す | 「agy が起動しなかった」と `error:` 行 |
| started | agy は動いているが名前が無い | stopped（`not-applied`） | 生成物は残す | 「agy がロールを選ばなかった」 |
| started | 画面を取れない | started のまま（不明） | `launched` を書かない | 適用状態「不明」（既存の表示） |

再接続（既存のプロセスの再利用）は起動行を作らないので、照合も確認もしない（`base.ts:409` の既存の分岐。適用状態は変えない）。

## 6. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 成功 | 失敗のとき | 倒れる側 |
|---|---|---|---|
| `~/.gemini/config/agents/` への書き込み（`writeRoleArtifact`） | 0600 の新規ファイル、または同じバイトの再利用 | ディレクトリが作れない・書けない・別の中身がある・symlink・権限 → `RoleArtifactError` → `artifact-failed` | **止める**（既存の規則。本文は送らない） |
| `agy agent`（一覧） | exit 0 で名前の行がある | 名前が無い／非 0／10 秒の時間切れ／`agy` が無い → `artifact-failed` | **止める**。一覧が読めないときに起動へ進むと、未知の名前の TUI が黙って動く場合と区別できない |
| agy の起動（TUI） | 状態の行に名前 | exit 3（登録に無い道具）／起動しない／名前が無い → セッションを止めて `not-applied` | **止める**。画面を取れないときだけ「不明」に倒す（I1 の例外。D2 の規則 6） |
| `agy --version`（版の取得） | 版の文字列 | 非 0・時間切れ・形が違う → 版は「不明」と書く | **進める**。版は理由の文面に載せるだけで、判定に使わない（D2 で範囲の判定を採らないため）。呼ぶのは起動後の確認で止めるときだけ |
| headless（Schedule の `agy -p … --agent <name>`） | exit 0 | 未知の名前 exit 1、登録に無い道具 exit 3 → 実行記録 `failed` と出力（既存） | **止まる**（agy 自身。CommandMate は変えない） |
| セッションを止める（`kill`） | ペインが消える | 止められない → 警告のログ（`role-not-applied-stop-failed`、`role-launch.ts:711` の既存の扱い）と同じく `not-applied` を返す | **拒否は返す**（止めに失敗しても成功とは言わない） |

## 7. PR の切り方

**1 本。** 理由: D1（生成物）・D2（起動後の確認）・D3（起動前の照合）・D4（スイッチを消す）は、どれか 1 つだけを develop に入れると不変条件 I1 が崩れる組み合わせがある。D4 だけ先に入れると「道具の無い定義で既定で起動する」（実機の記録の初回の不合格）が develop に入る。D1〜D3 だけを先に入れても害は無いが、スイッチが残る間は誰も通らない経路になり、試験の価値が半分になる。変えるファイルの数（§10）は多いが、画面と文書の変更は「注記を消す」だけで、レビューの重さは D2・D3 に集まる。

分けるなら（人が 2 本を望んだとき）: PR1 = D1・D2・D3・D5（スイッチは残す。`CM_AGENT_ROLE_ANTIGRAVITY_ENABLED=1` のときだけ通る）、PR2 = D4。PR1 の後に PR2 を `--last` でマージする。

## 8. 試験の表

単体試験は `agy` を起動しない（一覧・版・画面は差し替える）。生成物は `os.tmpdir()` の下の `fs.mkdtempSync` に書き、`afterEach` で消す（`tests/setup.ts:253` の `CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR` の既存の設定を使う）。

| # | 種類 | 何を | 期待 | 直す前の実装で |
|---|---|---|---|---|
| P1 | 陽性 | 生成物の frontmatter | `tools` が 13 個の定数とこの順で一致、`swarm` が無い、`subagent: false` が残る | 落ちる（`tools` が無い） |
| P2 | 陽性 | 定数の出典 | 定数の横のコメントに `1.5.8` と実機の記録のパスがある | 落ちる |
| P3 | 陽性 | `tools` の無い（または 1 個違う）定義の読み直し | `format-invalid` で拒否 | 落ちる（今は通る） |
| P4 | 陽性 | 環境変数なしでロールつきの Antigravity の起動 | 起動行に `--agent <name>` が付く | 落ちる（`adapter-disabled`） |
| P5 | 陽性 | `agy agent` の一覧に名前が無い | ペインを作らず `artifact-failed`、理由にパス | 落ちる（照合が無い） |
| P6 | 陽性 | `agy agent` が非 0・時間切れ | `artifact-failed`、ペインを作らない | 落ちる |
| P7 | 陽性 | 起動後の画面に `unknown component: tool "swarm" not found in registry` | セッションを止め `not-applied`、理由に `swarm`・`1.5.8`・動いている版 | 落ちる（今は何もしない） |
| P8 | 陽性 | 起動後の画面に名前が無い（`auto · Gemini 4 Hydrogen · high`、`evidence/4-tui.txt` の未知の名前の行） | 止めて `not-applied` | 落ちる |
| P9 | 陽性 | 起動後にペインがシェル | 止めて `not-applied` | 落ちる |
| P10 | 陽性 | 起動後の画面に `auto · <name> (Gemini 4 Hydrogen · high)  /agents` | `launched` を記録 | 落ちる（今は記録しない） |
| P11 | 陽性 | 拒否の理由・ログ | ロールの本文の印（試験用の文字列）を含まない | — （新しい文面の固定） |
| P12 | 陽性 | `git grep -n 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED\|isAgentRoleAdapterEnabled' -- src locales docs/user-guide docs/en tests` | 0 件 | 落ちる |
| N1 | 陰性 | ロールの無い Antigravity の起動 | 起動行が今とバイト単位で同じ、`agy agent` を呼ばない | 通る |
| N2 | 陰性 | Schedule（headless）の Antigravity | `agy agent` を呼ばない。引数は今と同じ形（`-p … --dangerously-skip-permissions --agent <name>`） | 通る（ロールつきは今は拒否なので、形の比較は直した後の固定） |
| N3 | 陰性 | 他の 6 adapter の注入 fingerprint と生成物のバイト | 直す前と同じ値（試験に値を書いて固定） | 通る |
| N4 | 陰性 | 再接続（既存のプロセスの再利用） | 照合も確認もしない、適用状態を変えない | 通る |
| N5 | 陰性 | 画面を取れない | `launched` を書かず、止めない | 通る |
| N6 | 陰性 | API の `adapterEnabled` | 7 ツールとも `true`、項目は残る | Antigravity だけ落ちる（今は false） |

古い動きを固定している試験（実装の契約で変更を許すもの。`it` の名前を変えるか置き換える）:

- `tests/unit/agent-roles/adapters-4115.test.ts:296`（`Antigravity is on only when someone says so`）→ 消して P4 に置き換える
- `tests/unit/session/role-launch-4115.test.ts:433`（`adapter-disabled` を期待）→ P4・P5 の形へ
- `tests/unit/session/role-schedule-4115.test.ts:115`（`the disabled adapter refuses`）→ N2 へ
- `tests/unit/app/api/worktrees/send-role-4115.test.ts:185`（`refuses a role on a disabled adapter, saving nothing`）→ 保存して通ることへ
- `tests/integration/api-agent-roles-4114.test.ts:335`（`antigravity is settable but marked as not enabled`）→ N6 へ
- `tests/integration/fixtures/agent-roles-api-examples.ts:124`（`adapterEnabled: false`）→ `true`
- `tests/setup.ts:252` の `delete process.env.CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と、それを固定する `tests/unit/config/codex-home-isolation-4146.test.ts:152` の行 → 両方を消す（対で直さないと 4146 の試験が落ちる）
- `tests/unit/agent-roles/artifacts-4114.test.ts:417`（`subagent: false` の固定）→ 残す。P1 を足す

## 9. 未決と人の判断（推奨つき）

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| Q1 | agy の版が確かめた範囲（1.5.8）の外のとき、起動を止めるか | **止めない**（D2 の (b)） | exit 3 は agy 自身が止まる。止めると agy の更新のたびに Antigravity のロールのワーカーが全部止まる。版は止めたときの理由に出す。確かめた版の一覧を広げるのは、新しい版で実機の記録と同じ手順（`r2-3`・`r2-4`）を通したとき |
| Q2 | API の `adapterEnabled` と理由 `adapter-disabled` を消すか | **残す**（常に `true`、`adapter-disabled` は古いサーバー向けの型だけ） | CLI の `--json` を読む外のスクリプトと、古いサーバーに繋ぐ新しい CLI を壊さない。消すなら別の Issue で、API の版の変更として |
| Q3 | ロールごとに道具を絞るか（読むだけのロール） | **この Issue ではしない**。全ロール 13 個 | `run_command` がある限り書き込みは本文頼み（実機の記録の「再確認」2）。絞る形を設計するなら別の Issue |
| Q4 | 置き場所を `~/.gemini/agents/` に移すか | **移さない**（`config/agents` のまま） | 1.4.12 では両方が一覧に出た。1.5.8 で `config/agents` が出なければ D3 が毎回止めるので、実装の PR の受入 6 で確かめて、出なければそこで決め直す |
| Q5 | 起動前の照合の時間の上限 | **10 秒** | 見立て。実装の PR で `agy agent` の所要時間を 1 回測って記録する |

## 10. 実装の範囲（契約にできる粒度）

**難度:** 難（セッションの起動の経路と利用者のホームへの書き込み）。担当は opus、事前レビューは Codex（PM のブリーフどおり）。

### 変えるファイル（scope.allow の候補）

- `src/lib/agent-roles/antigravity.ts`（新規。`ANTIGRAVITY_ROLE_TOOLS`・`ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON`、`agy agent` の出力の照合、状態の行と `error:` 行の読み取りの純関数）
- `src/lib/agent-roles/artifacts.ts`（`renderRoleArtifact` の Antigravity に `tools`、`formatProblem` の検査）
- `src/lib/agent-roles/adapters.ts`（adapter ごとの版、Antigravity は `'2'`）
- `src/lib/agent-roles/launch-errors.ts`（`adapter-disabled` のコメント）
- `src/lib/agent-roles/management.ts`（`adapterEnabled: true`）
- `src/types/agent-roles.ts`（環境変数と関数を消す）
- `src/lib/session/role-launch.ts`（`:293` の分岐を消す、起動前の照合の関数を足す、`settleLaunchRole` の Antigravity）
- `src/lib/cli-tools/base.ts`（`launchSessionWithRole` で照合を呼ぶ）
- `src/app/api/worktrees/[id]/send/send-role.ts`
- `src/cli/commands/roles.ts`、`src/cli/commands/instances.ts`
- `src/components/roles/InstanceRolesSection.tsx`、`src/components/roles/RepositoryRoleDefaults.tsx`、`src/components/settings/AgentRolesSettings.tsx`、`src/components/worktree/AgentAddMenu.tsx`、`locales/ja/common.json`、`locales/en/common.json`
- `docs/user-guide/cli-operations-guide.md`、`docs/en/user-guide/cli-operations-guide.md`、`docs/user-guide/webapp-guide.md`、`docs/en/user-guide/webapp-guide.md`、`docs/design/agent-roles-adapters.md`
- `tests/unit/agent-roles/**`、`tests/unit/session/role-launch-4115.test.ts`、`tests/unit/session/role-schedule-4115.test.ts`、`tests/unit/app/api/worktrees/send-role-4115.test.ts`、`tests/unit/config/codex-home-isolation-4146.test.ts`、`tests/setup.ts`、`tests/integration/api-agent-roles-4114.test.ts`、`tests/integration/fixtures/agent-roles-api-examples.ts`、`tests/unit/docs/**`
- `changelog.d/4385.md`（この設計の断片へ統合する。1 項目・1 行）

### 受入基準

1. 生成物に `tools` があり、13 個の一覧と出典（版 1.5.8・実機の記録のパス）が試験で固定されている（P1・P2）
2. 環境変数なしでロールつきの Antigravity が起動する。`git grep -n 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED\|isAgentRoleAdapterEnabled' -- src locales docs/user-guide docs/en tests` が 0 件（P4・P12）
3. 起動前に `agy agent` の一覧と照合し、無ければペインを作らずに理由つきで拒否する（P5・P6）
4. 起動後に状態の行で名前を確かめ、確かめたら `launched`、登録に無い道具・起動しない・名前が無いときはセッションを止めて理由を出す（P7〜P10）
5. ロールの無い起動・Schedule・他の 6 adapter・再接続は変わらない（N1〜N4）
6. 一時ホーム（`os.tmpdir()` の下、`HOME` を差し替え）で agy 1.5.8 の `agy agent` が `~/.gemini/config/agents/<dir>/agent.md` の定義を一覧に出すことを 1 回確かめ、出力をコミットメッセージの本文に書く（認証は要らない。1.4.12 の実測と同じ手順。本物の `~/.gemini` には書かない）。出なければ実装を止めて PM に返す（Q4）
7. CHANGELOG の断片に挙動の変更（Antigravity でロールが既定で有効、`~/.gemini/config/agents/` に定義を書く、確かめた agy の版 1.5.8、起動前の一覧の照合と起動後の確認で止まること）
8. （マージの後、PM）信頼済みの worktree の TUI で、ロールつきの起動でロールの本文が守られ、編集・実行ができ、適用状態が「適用済み」になる。生成物の名前を存在しない名前に変えた定義では起動が理由つきで止まる。D2 の見立て（信頼の後の状態の行）をここで確かめる

### gates

- `npx vitest run tests/unit/agent-roles tests/unit/session/role-launch-4115.test.ts tests/unit/session/role-schedule-4115.test.ts tests/unit/app/api/worktrees/send-role-4115.test.ts tests/unit/config/codex-home-isolation-4146.test.ts tests/unit/guards tests/unit/docs`
- `npx vitest run --config vitest.integration.config.ts tests/integration/api-agent-roles-4114.test.ts`（設定のファイル名は実装の時点で確かめる）
- `npm run lint`、`npx tsc --noEmit`
- `npm run build`（画面のコンポーネントと辞書を変えるため。client が読む `src/types/agent-roles.ts` を変える）
- e2e は `tests/e2e/agent-roles-4117.spec.ts`（`adapterEnabled: true` の形を使う。注記が消えるだけなので UI の既定は変えない）

## 11. この設計で確かめたこと

- `agy --version` → `1.5.8`、exit 0
- `agy --help` → `--agent` は「Agent for the current CLI session」。サブコマンド `agent`・`agents` は「List available agents」。出力の形式を選ぶ引数は無い
- `agy help agent` と `agy agent --help` → `Usage: agy agent [flags]`、フラグは `-h` / `--help` だけ
- `agy changelog`（同梱）: 1.1.1 で `--agent` と `agent/agents`、1.1.5 で `subagent: false` の修正、1.1.6 で Markdown の custom agent、1.2.1 で `excludeDefaultComponents`、1.2.7 で「既定の道具から外した `find_by_name`・`grep_search`・`list_dir` は、`tools` に書いた custom agent では使える」。`tools` に書ける名前の一覧や、未知の名前の扱いを書いた項は見つからなかった
- `~/.gemini/config/` に `agents` ディレクトリは今は無い。`~/.gemini/agents` も無い（実機の記録の片付けのとおり）
- 実コードの行は §2〜§10 に `file:line` で引いた（develop `ff13eeace` の時点）
