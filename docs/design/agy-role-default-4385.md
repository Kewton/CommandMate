# Antigravity のロールを既定で有効にする（Issue #4385）

- 正本: Issue #4385 の本文、実機の記録 `dev-reports/issue/agy-role-2026-11-14/report.md`（主のチェックアウトにある。初回と「再確認」の節、`evidence/` の各ファイル）
- 前の設計: [agent-roles-adapters.md](./agent-roles-adapters.md) §6.6（agy 1.4.12 の一時ホームでの実測）
- 事前レビュー（2-4-4）と原因調査（主のチェックアウトの `workspace/orchestration/runs/2026-11-14/`）: 1 回目 `prereview-4385-reply.md`（P2 4・P3 3）、2 回目 `prereview-4385-2-reply.md`（P2 2: R1・R2。同じ種類の 2 回目）、原因調査 `enabler-return-4385-cause.md`（codex-2、推奨 A）。第 3 版はリーダーの処分（再指示 2）で推奨 A を採った（§12）
- この文書の書き方: **事実**（実測・実コード・agy の同梱文書で確かめたもの）と**見立て**（確かめていないもの）を分けて書く。見立てには「見立て」「未確認」と書く
- この設計ではコードを書かず、agy のセッションも起動していない。読んだのは `agy --version`・`agy --help`・`agy help agent`・`agy changelog` の出力と、`~/.gemini` の一覧（読むだけ）
- 行番号は develop `ff13eeace` の時点

## 0. 最上位の不変条件

> **一度の確認で得た許可は、それを得た世代と、それを使う瞬間の状態の両方に結びつけて使う。** 記録の削除・停止の試行やその失敗・送り直し・内側の await を越えて、許可が生き残ったり拒否が許可に化けたりしない。

第 1 版・第 2 版のレビューで出た穴（取得不明から本文へ進める／不適用の証拠を消すと門の対象外になる／await の後に旧い世代が後継に作用する／ロックの中で照合した後に失効する）は、すべてこの 1 文の破れ（原因調査 §2）。§4 の各不変条件はこの文を場面ごとに言い直したもの。

## 1. 結論

1. 生成物（`~/.gemini/config/agents/<name>/agent.md`）の frontmatter に `tools` を足す。中身は 1.5.8 で確かめた 13 個の定数で、出典を書く（D1）
2. `CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と `isAgentRoleAdapterEnabled` を消し、既定で有効にする。API の `adapterEnabled` は常に `true` で残し、CLI の警告は旧いサーバー向けに残す（D4）
3. **版の範囲で起動を止めない。** 登録に無い道具の名前は agy 自身が exit 3 で止まる（実測）。CommandMate がするのは、その結果のプロセスへ本文を送らないこと（D2）
4. **起動前に `agy agent` の一覧と照合する。** 新しいプロセスを起こす分岐（driver の再利用の return の後、`beginAgentSession` の前）でだけ（D3）
5. **起動後の確認で不適用・期限切れなら、本文を未送信で拒否して理由を見せる。プロセスは残す。CommandMate はセッションを自動では止めない**（Ctrl-D・tmux kill・kill のための記録の破棄をしない）。止めるのは人が既存の停止で行う（D2、原因調査の推奨 A）
6. **拒否は「送信の可否」の状態として世代ごとに保持し、一般の記録の削除（`forgetLaunchRoleEvidence`）では解除しない。** 解除するのは、確実に新しいプロセスを起こした新しい世代が確認を通ったときだけ（D7）
7. **送信の門は通常の send にも置き、本文を実際に入れる境界で同期に再確認する**（D2）
8. 保証の境界: 拒否はサーバーのメモリにだけある。サーバーの再起動を越えた保持は保証しない（§4 の例外 E1）
9. **PR は 2 本に分ける**（推奨。§7）: PR1 = 送信の門と確認（スイッチは残したまま）、PR2 = tools・照合・スイッチの削除

### 受入の言い換え（リーダーの処分。PM へ報告する）

Issue の受入「未知の名前・登録に無い道具のとき、黙ってロールなしで動かない（**止まって理由が見える**）」を、この設計では次の意味とする:

> **CommandMate からの本文が未送信で止まり、理由が見える。プロセスは残り、人が止める。**

画面・CLI には「停止した」とは出さず、「ロールを確認できないため未送信。停止して起動し直す」と出す（§3 D2 の文面）。

## 2. 実コードとの照合（Issue の本文との食い違い）

| # | Issue の本文 | 実コード（正） | この設計の扱い |
|---|---|---|---|
| 1 | 定義の置き場所は `~/.gemini/agents/<name>/agent.md` | `src/lib/agent-roles/artifacts.ts:290` の `resolveArtifactLocation` は `~/.gemini/config/agents/<name>/agent.md`（`artifacts.ts:257`、`src/lib/hooks/sources/antigravity/hooks-config.ts:213`） | 実コードを保つ。1.4.12 では 2 つとも一覧に出た（`agent-roles-adapters.md:255`）。**1.5.8 で `config/agents` が出るかは未確認**。D3 が毎回確かめる。PR2 の受入で一時ホームで確かめる |
| 2 | 生成物に足すのは `tools` だけ | `src/lib/agent-roles/adapters.ts:25` の `ADAPTER_VERSION` は 7 adapter で 1 つ。同じ名前に別の中身が来ると `content-mismatch`（`artifacts.ts:690`） | Antigravity だけ adapter の版を `'2'` に（D5） |
| 3 | （記述なし）起動後の確認 | `src/lib/session/role-launch.ts:724` の `settleLaunchRole` は Antigravity で何もしない。`src/lib/cli-tools/antigravity.ts:374` の `waitForReady` は 30 回（`antigravity.ts:87`）の待ちが尽きても throw しない（`antigravity.ts:427`）。61 秒の起動の実測（`antigravity.ts:355`、`:106`） | 起動中と取得不明を別の状態にし、次の send のプロンプト待ちまで確認を続ける（D2） |
| 4 | 「起動前に `agy agent` の一覧と照合して止める」 | `agy help agent` は名前の一覧を出すだけ（1.5.8）。1 行に 1 つの名前（`evidence/1-list.txt`） | 行ごとの完全一致（D3） |
| 5 | 「登録に無い名前を 1 つでも書くと exit 3」 | 一覧は登録に無い道具を書いた定義も**出す**（`evidence/r2-1-list.txt`） | D3 では拾えない。D2 が拾う |
| 6 | （記述なし）本文を送ってよい条件 | ロール条件の検査（`src/app/api/worktrees/[id]/send/send-role.ts:263`・`:297`）は fingerprint と generation だけで、`launched` を見ない。証拠は `requested` でできる（`role-launch.ts:556`）。条件の無い send は何も見ない（`antigravity.ts:565`） | `requested` を確認の代わりにしない。門は driver の中と本文の境界に置く（D2） |
| 7 | （記述なし）再接続 | 再利用は `antigravity.ts:278`（`if (live) return;`）。`src/lib/cli-tools/base.ts:410` は生成物の拒否があっても動いているプロセスへ再接続する | D3 は再利用の return の後（D3） |
| 8 | （記述なし）停止と記録の削除 | 人の停止 API は、kill が失敗してペインが残っても、後段で全対象に `forgetLaunchRoleEvidence` と起動中の解除をする（`src/app/api/worktrees/[id]/kill-session/route.ts:151`・`:198`）。`forgetLaunchRoleEvidence`（`role-launch.ts:781`）は記録を丸ごと消して epoch を進める | 拒否を記録と同じ場所に置くと、停止の失敗の後に「由来不明の再接続」に化けて門の対象外になる（R1）。拒否は別に持つ（D7） |
| 9 | （記述なし）kill の世代 | 既存の kill は `hasSession`→`requestExit`（Ctrl-D と待機）→tmux kill を await する（`base.ts:974`、`antigravity.ts:604`）。入力のロックの旧い持ち主は失効させられ、失効は callback を止めない（`src/lib/session/instance-input-lock.ts:795`）。新しい起動はこれを呼ぶ（`src/lib/session/agent-session-lifecycle.ts:112`） | ロックの中で照合しても kill の内側で後継に作用しうる（R2）。**新設の自動の kill を外す**ことで、この排他をこの Issue で作る必要をなくす（D2） |

## 3. 決めたこと

### D1 `tools` の一覧

- 定数 `ANTIGRAVITY_ROLE_TOOLS`（13 個、この順）と `ANTIGRAVITY_ROLE_TOOLS_VERIFIED_ON = '1.5.8'`。出典のコメントに実機の記録のパス（「再確認」の節、`evidence/r2-3-tool-registry-probe.txt`・`r2-4-dev-tools13.txt`）と日付（2026-11-14）

```
read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, manage_subagents, write_file, edit_file, search_web, run_workflow, ask_question
```

- `swarm` は入れない（1.5.8 の登録に無い。exit 3、実測）
- 実測と同じブロックの形（`tools:` の下に `  - <name>`）。`excludeDefaultComponents` は書かない
- ロールごとに道具を絞ることは範囲外（§9 Q3）
- `formatProblem`（`artifacts.ts:388`）の Antigravity の検査に「`tools` が定数と同じ配列」を足す

### D2 起動後の確認と送信の門

#### 版への追従（範囲で止めない）

| 案 | 判断 |
|---|---|
| (a) `agy --version` が確かめた範囲の外なら起動しない | **採らない**。更新のたびに全部止まる（1.4.12→1.5.8 で 12 版）。§9 Q1 |
| (b) 起動の後に確かめ、確認するまで本文を送らない | **採る** |
| (c) 起動の前に短い headless を走らせる | **採らない**。起動のたびにモデルを 1 回呼ぶ |

#### 適用の状態（世代ごと）

| 状態 | 意味 | 本文 |
|---|---|---|
| `starting`（起動中） | 起動行を打った。判定の材料がまだ無い（未描画、途中の画面） | 送らない（猶予の中で待つ） |
| `unknown`（取得不明） | 画面を取れなかった | 送らない（猶予の中で待つ） |
| `confirmed`（適用を確認済み） | 今の状態の行に生成物の名前がある | **既存の ready の条件と両方そろったときだけ**送る |
| `refused`（固定の拒否） | 明確な不適用を見た、または猶予が切れた | 送らない。未送信の拒否。D7 の規則で保持 |

`refused` の理由は 2 つに分ける: `not-applied`（明確な不適用）と `not-confirmed`（猶予切れ）。どちらも `RoleLaunchRefusalReason` に足す（`not-applied` は既にある。`not-confirmed` は新設）。**どちらでもプロセスは止めない。**

#### 画面から判定してよい範囲

- 読むのは ANSI を除いた画面の**現在の状態の行**だけ（既存の `readInputBoxStatusRow`、`antigravity.ts:190` と同じく構造で取る）。本文・scrollback・引用・古い `error:` 行は使わない
- `confirmed`: 状態の行が ` · <name> (` を含む（前は ` · `、後ろは ` (` で区切る。接頭辞の違う名前を取り違えない）。実測の形は `auto · cm-role-x (Gemini 4 Hydrogen · high)  /agents`（`evidence/4-tui.txt`、**信頼の前の一例だけ**）
- 明確な不適用は 3 つだけ: (1) ペインの前景が agy でない（`isToolLive`）。起動行より後の行に `unknown component: tool "<x>"` があれば分類を「登録に無い道具」に (2) 入力欄が出た画面（`isAntigravityReady`、`antigravity.ts:238`）で名前が無い (3) 信頼の画面で名前が無い、または別の名前
- 未描画・途中の画面・取得の失敗は不適用にしない

#### 猶予（起動中の 60 秒）

- 起動の中（`settleLaunchRole`、`role-launch.ts:687`）: `waitForReady` が返った後に画面を 1 回読む。`confirmed` か `refused(not-applied)` を決められれば決める。決められなければ `starting`／`unknown` のまま起動を返す。起動は throw しない（プロセスは起きている）。追加の待ちは足さない
- 送信の門（`antigravity.ts:565` の `sendMessage`、`waitForPrompt` の中）: `starting`／`unknown` なら、`waitForPrompt` と**同じ待ちの中で**（足し算にしない）1 秒ごとに読み直す。猶予は `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS`（60 秒、`antigravity.ts:109`）で、**この世代で最初に門に来た send の開始から数える**。猶予が切れたら `refused(not-confirmed)` に固定する
- 繰り越した信頼の Enter（`antigravity-startup-trust`）は既存のとおり 1 回だけ打ち、その後の画面で判定を続ける
- `confirmed` でも、信頼の画面・生成中・モデルの選択の画面なら本文は送らない（既存の ready の条件を省かない）。ready になってから 1 回送る

#### 送信の門の置き場所

1. **driver の中:** `sendMessage` の `requireSession` の後、`waitForPrompt` の中。通常の send・契約の送信・ロール条件つきの send・`requireSession` の起こし直しの後の send が、すべて通る
2. **本文を実際に入れる境界:** 共有の sender（`src/lib/cli-tools/submit-verified-sender.ts`）の本文の直前、`noteInputStart()` を呼ぶ 2 か所（打鍵の経路 `submit-verified-sender.ts:779`、長文の貼り付けの経路 `submit-verified-sender.ts:269`）。ここに同期の再確認（下の「確認の条件」）を置く。driver の待ちが終わった後にも sender の中に await（ロック・画面の読み直し・入力欄の消去・`load-buffer`）があるので、待ちの完了だけで本文を許さない
   - つなぎ方: sender の引数に省略可能な同期の確認 `beforeBody` を足し、`noteInputStart()` の直前で呼ぶ。throw したら本文を入れない（長文の経路は既存と同じく buffer を捨ててから上げる）。driver はこれを自分で渡すので、`send-user-message.ts:654` の `observeInputStart` を通らない直接の呼び出しでも効く。既存の入力の ticket・ロール条件の境界（`send-role.ts:297` の `roleConditionBoundary`、`instance-input-lock.ts:825` の `InputBoundaryHooks`）はそのまま残し、置き換えない
3. **確認の条件（同期、境界で毎回）:** 送ろうとしている世代 G について、(a) 今の証拠の generation が G、(b) D7 の拒否の記録に G 以降の拒否が無い、(c) G の状態が `confirmed`、(d) 期待する注入 fingerprint が G の証拠と同じ。1 つでも外れたら本文 0 で未送信の拒否
4. **門の対象:** このサーバーがロールの注入つきで Antigravity を起動した世代、または D7 の拒否の記録がある対象。ロールの無い起動と、証拠も拒否の記録も無い再接続（サーバーの再起動の後）は今と同じ（例外 E1）
5. **Auto-Yes の応答キーと `respond` は本文ではないので門の外**（決定。§9 Q7）。「本文 0」は「全キー・全操作 0」ではない。利用者向けの説明にもそう書く

#### 未送信の拒否の文面と、届く先

- 文面（API の英文の案）: `The role could not be confirmed for this Antigravity session, so nothing was sent. Stop the session and start it again.` に、分類（登録に無い道具／起動しなかった／ロールを選ばなかった／確認できなかった）を足す。日本語の画面は「ロールを確認できないため未送信。停止して起動し直してください」
- 診断に出してよいもの: 分類、`/^[a-z_][a-z0-9_]{0,63}$/` に合う道具の名前、確かめた版 `1.5.8`、動いている版（`/^\d+\.\d+\.\d+$/` に合うときだけ、外れたら「不明」）、生成物の名前とパス。**agy の `error:` 行をそのまま出さない**
- 届く先: `RoleLaunchRefusedError` の印（`src/lib/agent-roles/launch-errors.ts:40`）を既存の読み手が拾う。`src/lib/session/send-user-message.ts:677` が未送信に、`src/app/api/worktrees/[id]/send/send-failure.ts:82` が `roleRefusal` に、CLI がその表示に。試験は実の send を通して応答の `roleRefusal` と `sendOutcome: not_sent` まで見る
- `agy --version` は、拒否の文面を作るときだけ呼ぶ（5 秒・256 バイト）。判定には使わない

#### 確認の記録と送信の許可を分ける

- 許可（`application`）はメモリの状態で、門だけが読む。記録 `launched`（DB）は表示のためで、門は読まない
- 遅い確認（送信の門の中で `confirmed` になったとき）も、**元の起動の snapshot・生成物・世代**に対して `launched` を書く。そのため `openGeneration`（`role-launch.ts:556`）のときに、記録に要る値（snapshot・prepared・generation）を証拠の項目として残す。最新の設定や後継の `requested` から採り直さない
- 書く直前に世代が今のものでなければ書かない（既存の `recordPhase`、`role-launch.ts:520` の規則）。DB に書けなかったときはログだけ残し、許可も拒否も変えない
- `current-output` の `roleLaunch`、ロールの API の `currentGeneration`、send の応答の notices は世代と fingerprint を読むだけで、適用の確認の証拠に格上げしない

### D3 起動前の照合: `agy agent` の一覧

- 置き場所: `antigravity.ts:269` の `launchSession` の中、`antigravity.ts:278` の `if (live) return;` の**後**、`antigravity.ts:288` の `beginAgentSession` の**前**。新規のペインと、同じペインで tool が終わっていた起こし直しだけが通る
- 今の起動の scope（`role-launch.ts:445` の `runWithLaunchRole`）にロールの注入があるときだけ照合。ロールの無い起動では何もしない
- 再接続（`live`）は照合しない。生成物の拒否があっても動いているプロセスへ再接続する既存の例外（`base.ts:410`）はそのまま。別のサーバーのセッションは `resolveLaunchPane`（`base.ts:878`）が触らずに拒否する
- headless（Schedule、`role-launch.ts:861` → `src/lib/session/claude-executor.ts:202`）には入れない。未知の名前で exit 1、登録に無い道具で exit 3 になり、実行記録は `failed`（`src/lib/job-executor.ts:285`）
- 判定: 出力の行に生成物の名前と完全に一致する行があれば通る。無い・非 0・時間切れ・起動できない → `RoleLaunchRefusedError('artifact-failed', …)`。理由は名前・パス・exit code・時間切れだけ
- **D3 の成功は適用の証拠ではない**（TUI が選んだかは D2 でしか確かめない）
- 子の環境: cwd は worktree。`PATH`・`HOME` はペインが受け取る tmux の環境（`src/lib/agent-roles/pane-env.ts`）に値があればそれ、無ければサーバーのもの。上限は 10 秒で SIGKILL、標準出力 64 KiB、標準エラー 4 KiB（理由に出さない）
- 副作用（事実）: `agy agent` は `~/.gemini/antigravity-cli/` のログを 1 本増やす。ログ以外の変更が無いのは 1.4.12 の観測で、1.5.8 以後の保証ではない
- `CM_UAT_ISOLATION=1`（`src/config/uat-isolation.ts`）: 子を起こす前に拒否する。`own-home` では照合する。`--log-file` が `agy agent` に効くかは**未確認**（§9 Q6）

### D4 有効化のスイッチを消す

- `src/types/agent-roles.ts:38` の `AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR` と `src/types/agent-roles.ts:46` の `isAgentRoleAdapterEnabled` を消す。呼び手: `role-launch.ts:293`、`send-role.ts:188`、`src/lib/agent-roles/management.ts:229`・`:244`・`:407`・`:428`
- API の `adapterEnabled` は常に `true`（`docs/user-guide/cli-operations-guide.md:3616`）。`adapter-disabled`（`launch-errors.ts:28`）は型に残し、コメントを「旧いサーバーの応答を読むため」に
- 画面の注記を消す: `src/components/roles/InstanceRolesSection.tsx:233`・`src/components/roles/RepositoryRoleDefaults.tsx:126`・`src/components/settings/AgentRolesSettings.tsx:537`・`src/components/worktree/AgentAddMenu.tsx:465`、辞書 `locales/ja/common.json:383`・`locales/en/common.json:383`
- CLI の警告（`src/cli/commands/roles.ts:345`、`src/cli/commands/instances.ts:659`）は**残す**（旧いサーバーが `false` を返したときだけ出る）
- 利用者向けの文書: `docs/user-guide/cli-operations-guide.md:3556`・`docs/en/user-guide/cli-operations-guide.md:2691`・`docs/user-guide/webapp-guide.md:484`・`docs/en/user-guide/webapp-guide.md:455` を、「ロールが解決されると `~/.gemini/config/agents/` に定義を書いて起動し、ロールを確かめるまで CommandMate からの本文を送らない。確かめられなければ未送信で理由を出す。プロセスは残るので停止して起動し直す。Auto-Yes の応答キーは本文ではない」に。CLI の警告は旧いサーバーのときだけと書く
- 前の設計の更新: `agent-roles-adapters.md:18` と §6.6 にこの文書への参照

### D5 adapter の版

- Antigravity だけ `'2'`、他の 6 adapter は `'1'`（`adapters.ts:25` を adapter ごとに。`adapters.ts:114` の canonical に入る値と返す `adapterVersion` を同じに）。他の fingerprint は 1 バイトも変えない
- 旧い版で動いているプロセスは旧い証拠のまま「再起動待ち」または「不明」。新しい版で適用済みと書き直さない。旧い定義は消さない

### D6 await の後の世代の照合（自動 kill を外した後に残る部分）

| 場所 | 前の await | 照合 | 外れたとき |
|---|---|---|---|
| D3 の直後、`beginAgentSession` の前 | `agy agent`（10 秒まで） | 起動の scope の epoch が今の epoch、かつ別の起動が世代を開いていない | `RoleLaunchRefusedError('session-stopped')`。ペイン・起動のキー・記録 0 |
| 確認の結果で状態を変える直前（起動の中・門の中） | 画面の取得・`isToolLive`・`agy --version` | **世代と、観測を始めたときの状態の版**の両方が今と同じ（compare-and-set。状態に単調に増える番号を持つ） | 何も変えない。古い観測は捨てる |
| `launched` を書く直前 | 同上 | 世代が今のもの（既存の `isStale`、`role-launch.ts:438`） | 書かない |
| 本文の境界（D2 の確認の条件） | sender の中の全 await | 同期に (a)〜(d) | 本文 0 |

**この Issue は kill を新設しないので、kill の内側の await の排他は作らない。** 既存の人の停止（kill-session API）をこの Issue で直したとも安全にしたとも言わない。その停止が失敗しても、D7 で本文は送らない。

### D7 拒否の寿命（R1 への手当て）

- 拒否の記録は、証拠の記録（`StoredLaunchRoleEvidence`、`role-launch.ts:128`）とは**別の**メモリの表に置く。鍵は証拠と同じ（worktree・ツール・インスタンス）、値は `{ generation, reason }`
- `forgetLaunchRoleEvidence`（`role-launch.ts:781`、人の停止・改名・セッションの消失で呼ばれる）は**この表を消さない**
- 解除するのは次のときだけ: **確実に新しいプロセスを起こす起動**が同じ鍵で新しい世代を開いたとき（`openGeneration`。driver が再利用でない分岐を通り、起動行を打つとき）。新しい世代は `starting` から始め、確認を通るまで本文を送らない。新しい世代の確認が通るまで、門は旧い拒否と新しい世代の状態の両方を見る（(b)）
- 同じ世代の `refused` は、後から来た肯定の観測では戻さない（D6 の compare-and-set）。`confirmed` から `refused` へも、観測の版が合わなければ動かさない
- 代償: 画面の取得の一時的な障害でも、猶予が切れれば固定の拒否になり、人の停止と起動し直しが要る（利用者向けの説明に書く）
- agy が終わってシェルに戻っているときは、次の send の `requireSession`（`antigravity.ts:573`）が起こし直し、新しい世代になる。exit 3 が続く版では、send のたびに起こし直して未送信になる（本文 0 は保つ。見立て: 1 回あたり 30 秒ほど）

## 4. 不変条件

| # | 不変条件（§0 の言い直し） | 何が守るか |
|---|---|---|
| I1 | このサーバーがロールの注入を管理した Antigravity の世代へ本文を渡せるのは、送る世代と期待する注入が一致し、**その世代の適用の確認と既存の ready の条件がともに成り立つ**ときだけ | D2 の門と境界の確認 |
| I2 | 不適用・猶予切れで拒否した対象は、**記録の削除・停止の試行や失敗・送り直しで免除に戻らず**、同じ世代の遅れた肯定でも解除されず、確実に新しく起こした世代が確認を通るまで拒否が続く | D7 |
| I3 | 非同期の観測からの確認の記録・拒否の更新・本文の入力は、**実際の更新・入力の境界で**元の対象と世代と状態に結ぶ。停止や交代で古くなった結果は後継を変えず、消さず、止めない | D6 |
| I4 | CommandMate は Antigravity のセッションを**自動では止めない**（この Issue で足す停止は 0）。止めるのは人の既存の停止 | D2 |
| I5 | 登録に無い道具の名前で動いたプロセスへ本文を送らない。生成物の `tools` は確かめた定数だけ | D1、D2 |
| I6a | CommandMate が利用者のホームに書くのは `~/.gemini/config/agents/` の下の `cm-role-` のディレクトリと `agent.md`（0600、ディレクトリ 0700）だけ。既存のファイルは書き換えず消さない。`CM_UAT_ISOLATION=1` では同じバイトの既存の生成物の再利用だけ（`artifacts.ts:690`） | 既存の規則 |
| I6b | agy の子（`agy agent`）が書くログは別に数え、`CM_UAT_ISOLATION=1` では子を起こさない | D3 |
| I7 | 拒否の理由とログにロールの本文と agy の任意の文字列を入れない | D2 の診断の範囲 |
| I8 | ロールの無い起動・Schedule・他の 6 adapter・再接続の照合（呼ばない）は今と同じ | D3、D5 |

**例外 E1（保証の境界）:** 拒否の記録はサーバーのメモリにだけある。サーバーが再起動すると、拒否も証拠も消え、その後の再接続は「由来不明」として今までどおり門の対象外になる。**再起動を越えた拒否の保持は保証しない。** 保証するなら拒否の永続化か、由来不明のロールの対象の再確認が要る（§9 Q8、別の Issue）。

## 5. 状態と遷移の表

### 5.1 起動（ロールの注入がある Antigravity）

| 状態 | 出来事 | 次 | 書くもの | 見えるもの |
|---|---|---|---|---|
| resolved | 生成物が無い／同じバイトがある | written | `agent.md` の新規作成／なし | なし |
| resolved | 別のバイト・symlink・権限・UAT で書けない | 拒否（ペイン前、`artifact-failed`） | なし | 理由（既存） |
| written | 読み直しの検査（`tools` を含む）に落ちる | 拒否（ペイン前） | なし | `format-invalid` |
| written | driver が動いているプロセスを見つけた | reused | なし（世代を開かない。拒否の記録も触らない） | 今と同じ |
| written | 別のサーバーのセッション | 拒否（既存） | なし | 既存 |
| written | 新しいプロセス、`CM_UAT_ISOLATION=1` | 拒否（ペイン前） | なし | UAT の理由 |
| written | 新しいプロセス、一覧に名前がある | listed | agy のログ 1 本 | なし |
| written | 一覧に無い・非 0・時間切れ | 拒否（ペイン前、`artifact-failed`） | agy のログ | 理由 |
| listed | 照合の待ちの間に停止 | 拒否（`session-stopped`） | なし | 既存の文面 |
| listed | 照合が合う | starting | ペイン・起動行・`requested`・拒否の記録の解除（新しい世代） | 起動中 |
| starting | 画面に名前（信頼の画面でも可） | confirmed | `launched` | 適用済み |
| starting | 明確な不適用 | refused(`not-applied`) | 拒否の記録 | 起動は返る。次の send で理由 |
| starting | 未描画・取得の失敗 | starting / unknown | なし | 起動は返る |

### 5.2 送信（同じ鍵へ）

| 状態 | 出来事 | 次 | 本文 | プロセス |
|---|---|---|---|---|
| confirmed | ready で send | confirmed | 1 回 | 残す |
| confirmed | 信頼の画面・生成中・選択の画面 | confirmed | ready まで 0、その後 1 | 残す |
| starting / unknown | 猶予の中で名前と ready | confirmed | 1 回（`launched` を元の世代に） | 残す |
| starting / unknown | 猶予の中で明確な不適用 | refused(`not-applied`) | 0、未送信 | **残す** |
| starting / unknown | 猶予が切れる | refused(`not-confirmed`) | 0、未送信 | **残す** |
| refused | 送り直し（何度でも） | refused | 0、未送信 | 残す |
| refused | 人が停止 → kill が失敗 → 記録の削除 → 動いているプロセスへ再接続 → send | refused（拒否の記録は残る） | 0、未送信 | 残っている |
| refused | 人が停止 → 確実に消えた → 新しい起動 | starting（新しい世代） | 確認まで 0 | 新しい |
| 任意 | 待ちの間に世代が入れ替わった | — | 0（既存の「入れ替わった」） | 後継に触らない |
| （対象外） | ロールの無い起動・証拠も拒否の記録も無い再接続（E1） | — | 今と同じ | 今と同じ |

## 6. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 成功 | 失敗のとき | 倒れる側 |
|---|---|---|---|
| `~/.gemini/config/agents/` への書き込み | 0600 の新規、または同じバイトの再利用 | 書けない・別の中身・symlink・権限 → `artifact-failed` | **起動を止める**（既存。ペインの前） |
| `agy agent`（一覧） | exit 0 で名前の行 | 無い／非 0／10 秒／64 KiB 超／`agy` が無い → `artifact-failed` | **起動を止める**（ペインの前） |
| agy の起動（TUI） | 状態の行に名前 | 明確な不適用・猶予切れ → `refused` | **本文を止める。プロセスは残す** |
| 画面の取得 | 画面 | 取れない → `unknown`、猶予の中で読み直す | **本文を止める** |
| `agy --version` | `x.y.z` | 非 0・5 秒・形が違う → 「不明」 | **進める**（文面だけ） |
| headless（Schedule） | exit 0 | exit 1 / 3 → `failed`（既存） | agy 自身が止まる。変えない |
| DB への `launched` の記録 | 行 | 書けない → ログだけ | **許可も拒否も変えない** |
| 人の停止（既存の kill-session） | ペインが消え、記録が消える | kill が失敗してプロセスが残る | **拒否は残る**（D7）。本文 0 |

## 7. PR の切り方

### 規模の見積もり（見立て）

1 本にすると、変えるファイルは §10 の一覧で src 約 20・試験 約 20・文書 約 6 の 40 本を超え、行数も試験を含めて千行を超える見込み。`docs/orchestrate/team.md` §6 の 3（目安は数百行・20 ファイル程度、送信の経路を画面の変更と同じ PR に入れない）を大きく超える。

### 推奨: 2 本に分ける（送信の門が先）

| PR | 中身 | スイッチ | 利用者への影響 |
|---|---|---|---|
| **PR1 送信の門** | D2（状態・猶予・門・境界の `beforeBody`・文面・遅い確認の記録）、D6、D7。Antigravity の起動後の確認だけで、tools・照合・スイッチは触らない | **残す**（既定で無効のまま。試験は `vi.stubEnv` で有効にする） | なし（既定で無効なので誰も通らない） |
| **PR2 有効化** | D1（tools）、D5、D3（照合）、D4（スイッチの削除・画面・辞書・文書） | 消す | Antigravity のロールが既定で有効になる |

理由: 送信の経路は高リスクで、画面・辞書・文書と同じ PR に入れない（team.md §6 の 3）。PR1 を先に入れれば、PR2 で有効にした瞬間から門がある。逆の順（有効化が先）は I1 を破る期間を作るので採らない。PR2 は PR1 の develop へのマージの後に作る（PR2 の契約は PR1 の実装を前提にした形で書く）。

選ばない案: 1 本（理由は上の規模）。D2 を外して D1・D3・D4 だけ（原因調査の案 B）は、一覧の照合が TUI の選択と道具の有効性を証明しないので Issue の受入を満たさない。

## 8. 試験の表

### 8.1 二種類の試験を分ける

| 種類 | 何を確かめるか | 何を確かめないか |
|---|---|---|
| **文書の語句の試験**（`tests/unit/docs/agy-role-default-design-4385.test.ts`） | この設計に必要な節・語句・13 個の一覧があり、引いたファイルが実在する | 状態の遷移や割込みが正しいこと。実装の合否 |
| **実の driver を通す試験**（PR1・PR2） | base → 実の driver（`antigravity.ts`）→ settle → 共有の sender まで通し、**本文の回数・本文の Enter の回数・kill と Ctrl-D の回数・証拠と拒否の記録の宛先**を数える | — |

実の driver の試験は `agy` を起動しない（一覧・版・画面・時計・tmux を差し替える）。生成物は `os.tmpdir()` の下（`tests/setup.ts:253` の `CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR`）。各防御を外した変異で赤になることを示す（下の「変異」の列）。正常な場合に 1 回送れることも確かめ、常に拒否するだけの実装を合格にしない。

### 8.2 中心の対照（原因調査 §4。PR1）

| # | 順序・入力 | 期待 | 赤にすべき変異 |
|---|---|---|---|
| C1 | 照合は成功 → TUI は既定の agent で ready → settle の画面の取得だけ失敗 → 通常の send とロール条件つきの send | 本文 0、本文の Enter 0、未送信の理由。`requested` の一致だけでは通らない | 「証拠の fingerprint が合えば送る」 |
| C2 | 明確な不適用／猶予切れ → 送り直しを繰り返す | 拒否が残り本文 0。**自動の Ctrl-D・kill 0** | 「拒否の後に kill する」「送り直しで再判定する」 |
| C3 | C2 → 人が停止 → kill が throw してペインは生きている → 既存の API が記録を消し起動中を解除 → 動いているプロセスへ再接続 → 通常・条件つきの send | 免除にならず本文 0（R1 の中心） | 「証拠が無ければ門の対象外」（拒否を証拠と同じ表に置く） |
| C4 | 同じ世代の確認を保留 → 別の観測で固定の拒否 → 古い肯定を解放 | 拒否の解除 0、本文 0 | 「世代だけを照合して状態の版を見ない」 |
| C5 | 画面・`isToolLive`・版・本文の前の各待ちを保留 → 停止 → 後継 → 旧い処理を解放（短文の打鍵と長文の貼り付けの両方） | 後継の状態の更新・削除・停止 0、旧い send の本文 0 | 「境界の同期の確認を外す」「待ちの完了だけで許す」 |
| C6 | 照合を保留 → 停止 → 照合が成功 | ペイン・起動行・旧い依頼の記録 0。再接続では照合 0 | 「照合の後の epoch の照合を外す」 |
| C7 | 30 秒の窓の終わりは未描画 → 61 秒で名前と ready。別に、名前あり＋信頼の画面・生成中 → ready | 前者は猶予の中で本文 1。後者は ready まで 0、その後 1。繰り越した信頼の Enter は 1 回 | 「名前が見えたら ready を待たない」「一度の画面で不適用」 |
| C8 | 固定の拒否 → 確実な停止 → 新しい正しい世代を確認 | 本文 1。`launched` は元の snapshot・新しい世代で | 「拒否の記録を消さない（永久に送れない）」 |
| C9 | 一覧に名前あり＋登録に無い道具、状態の行の引用・古い scrollback・接頭辞の違う名前、終始取得不能、画面に `error: <本文の印>` | 一覧や任意の文字列を確認としない。本文 0。診断に本文の印が無い | 「200 行から名前を探す」「error 行をそのまま出す」 |
| C10 | 遅い確認（門の中で `confirmed`） | `launched` が元の起動の `requested` と同じ世代・fingerprint で 1 行。DB の書き込みを失敗させても本文の可否は変わらない | 「最新の設定で記録を作る」 |
| C11 | 未送信の拒否が応答に届く | send の応答に `roleRefusal`（`not-applied`／`not-confirmed`）と `sendOutcome: not_sent`、CLI の表示 | — |

### 8.3 PR2 の試験

| # | 種類 | 何を | 期待 | 直す前の実装で |
|---|---|---|---|---|
| P1 | 陽性 | 生成物の frontmatter | `tools` が 13 個とこの順で一致、`swarm` 無し、`subagent: false` | 落ちる |
| P2 | 陽性 | 定数の出典 | コメントに `1.5.8` と実機の記録のパス | 落ちる |
| P3 | 陽性 | `tools` の無い（1 個違う）定義の読み直し | `format-invalid` | 落ちる |
| P4 | 陽性 | 環境変数なしでロールつきの起動 | 起動行に `--agent <name>` | 落ちる |
| P5 | 陽性 | 新しいプロセス、一覧に名前が無い | ペイン・`beginAgentSession`・起動のキー 0、`artifact-failed` | 落ちる |
| P6 | 陽性 | 一覧が非 0・時間切れ・64 KiB 超 | 同じく 0。時間切れで子が止められる | 落ちる |
| P8 | 陽性 | `CM_UAT_ISOLATION=1` | 子を起こさずに拒否 | 落ちる |
| P9 | 陽性 | 一覧に接頭辞の違う名前だけ | 通らない | 落ちる |
| P12 | 陽性 | `git grep -n 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED\|isAgentRoleAdapterEnabled' -- src locales docs/user-guide docs/en tests` | 0 件 | 落ちる |
| P13 | 陽性 | CLI が `adapterEnabled: false`（旧いサーバー）を受けた | 今と同じ警告 | 通る（残すことの固定） |
| N1 | 陰性 | ロールの無い起動と send | 起動行・送信が今とバイト単位で同じ、門も一覧も呼ばない | 通る |
| N2 | 陰性 | Schedule（headless） | 一覧も門も呼ばない。引数は `-p … --dangerously-skip-permissions --agent <name>` | 通る |
| N3 | 陰性 | 他の 6 adapter の注入 fingerprint と生成物のバイト | 直す前と同じ値（試験に値を書く） | 通る |
| N4 | 陰性 | 動いているプロセス、一覧の依存は呼ばれたら throw | 再接続が成功、照合 0、記録は変わらない | 通る |
| N4b | 陰性 | 既存のペインで tool が終わっている | 照合 1 回。失敗なら起動行 0 | — |
| N5 | 陰性 | 証拠も拒否の記録も無い再接続（E1） | 今と同じ | 通る |
| N6 | 陰性 | API の `adapterEnabled` | 7 ツールとも `true` | Antigravity だけ落ちる |
| N7 | 陰性 | 子の環境 | cwd が worktree、`PATH`・`HOME` がペインの環境の値（あれば） | — |

### 8.4 古い動きを固定している試験（実装の契約で変更を許す）

- PR2: `tests/unit/agent-roles/adapters-4115.test.ts:296`（`Antigravity is on only when someone says so`）→ 消して P4 に。`tests/unit/session/role-launch-4115.test.ts:433`（`adapter-disabled`）→ P4・P5 の形へ。`tests/unit/session/role-schedule-4115.test.ts:115`（`the disabled adapter refuses`）→ N2 へ。`tests/unit/app/api/worktrees/send-role-4115.test.ts:185`（`refuses a role on a disabled adapter, saving nothing`）→ 保存して通ることへ。`tests/integration/api-agent-roles-4114.test.ts:335`（`antigravity is settable but marked as not enabled`）→ N6 へ。`tests/integration/fixtures/agent-roles-api-examples.ts:124` → `true`。`tests/setup.ts:252` と `tests/unit/config/codex-home-isolation-4146.test.ts:152` → 対で消す。`tests/unit/components/roles/agent-roles-screen-4117.test.tsx`・`agent-roles-settings-4117.test.tsx` に注記を期待する行があれば `true` の形へ
- PR1: 既存の試験の期待値は変えない（スイッチが残るので）。`tests/unit/agent-roles/artifacts-4114.test.ts:417` は両方の PR で残す

## 9. 未決と人の判断（推奨つき）

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| Q1 | 版の範囲（1.5.8）の外で起動を止めるか | **止めない** | exit 3 は agy 自身が止まり、門が本文を止める |
| Q2 | `adapterEnabled` と `adapter-disabled` を消すか | **残す** | 外のスクリプトと旧いサーバーに繋ぐ CLI を壊さない |
| Q3 | ロールごとに道具を絞るか | **この Issue ではしない** | `run_command` がある限り書き込みは本文頼み |
| Q4 | 置き場所を `~/.gemini/agents/` に移すか | **移さない** | 1.5.8 で出なければ D3 が毎回止める。PR2 の受入で確かめる |
| Q5 | 期限 | 一覧 10 秒、版 5 秒、猶予 60 秒 | 猶予は既存の `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS` |
| Q6 | `CM_UAT_ISOLATION=1` で照合を拒否するか | **拒否する**（`--log-file` が効くと確かめられたら外してよい） | 本物のホームにログが増える |
| Q7 | Auto-Yes の応答キーと `respond` を門に入れるか | **入れない**（決定） | 本文ではない。範囲を広げない |
| Q8 | 拒否を再起動を越えて保つか | **この Issue では保たない**（E1） | 永続化か、由来不明の対象の再確認が要る。別の Issue で |
| Q9 | 不適用のときに自動で止めるか | **止めない**（決定、リーダーの処分） | 世代つきの kill の排他（kill の内側の await まで）を新しく作る必要があり、R2 の穴になった。人の停止に任せる |
| Q10 | PR を分けるか | **2 本**（§7） | 規模と送信の経路の分離 |

## 10. 実装の範囲（契約にできる粒度）

**難度:** 難（送信の門・起動の経路・利用者のホームへの書き込み）。担当は opus、事前レビューは Codex。PR1 の後に PR2。

### PR1 送信の門

- 変えるファイル: `src/lib/agent-roles/antigravity.ts`（新規。状態の行の判定・明確な不適用の分類・診断の文面の純関数）、`src/lib/session/role-launch.ts`（適用の状態、拒否の記録の表、`openGeneration` の記録の値、`settleLaunchRole` の Antigravity、遅い確認の記録）、`src/lib/cli-tools/antigravity.ts`（門と猶予、`beforeBody` を渡す）、`src/lib/cli-tools/submit-verified-sender.ts`（`beforeBody` の引数、2 か所）、`src/lib/agent-roles/launch-errors.ts`（`not-confirmed`）
- 試験: `tests/unit/session/role-launch-4115.test.ts`、`tests/unit/cli-tools/antigravity*.test.ts`（`antigravity-late-trust-3757.test.ts` を含む）、`tests/unit/cli-tools/submit-verified-sender*.test.ts`、新しい試験ファイル（`tests/unit/session/` か `tests/unit/cli-tools/` の下）、send の未送信の応答を見る既存の試験（`tests/unit/app/api/worktrees/**`）
- 受入: C1〜C11 がすべて実の driver で合格し、各変異で赤になる。既存の試験の期待値は変えない。ロールの無い経路・他の adapter は変わらない（N1・N3 を PR1 でも走らせる）。自動の Ctrl-D・kill を足していない（`git diff` で `killSession`・`requestExit` の新しい呼び出し 0）
- 規模（見立て）: src 5・試験 5〜7 本、数百行
- gates: `npx vitest run tests/unit/session/role-launch-4115.test.ts tests/unit/cli-tools tests/unit/app/api/worktrees tests/unit/guards tests/unit/docs`、`npm run lint`、`npx tsc --noEmit`

### PR2 有効化

- 変えるファイル: `src/lib/agent-roles/antigravity.ts`（定数・一覧の照合）、`src/lib/agent-roles/artifacts.ts`、`src/lib/agent-roles/adapters.ts`、`src/lib/agent-roles/launch-errors.ts`（`adapter-disabled` のコメント）、`src/lib/agent-roles/management.ts`、`src/lib/agent-roles/pane-env.ts`（読むだけで足りなければ）、`src/types/agent-roles.ts`、`src/lib/session/role-launch.ts`（`:293` を消す、照合の関数）、`src/lib/cli-tools/antigravity.ts`（照合の呼び出し）、`src/app/api/worktrees/[id]/send/send-role.ts`、画面 4 本と辞書 2 本（D4）、文書 5 本（D4）
- 試験: `tests/unit/agent-roles/**`、`tests/unit/cli-tools/antigravity*.test.ts`、`tests/unit/session/role-launch-4115.test.ts`、`tests/unit/session/role-schedule-4115.test.ts`、`tests/unit/app/api/worktrees/send-role-4115.test.ts`、`tests/unit/config/codex-home-isolation-4146.test.ts`、`tests/unit/components/roles/agent-roles-*.test.tsx`、`tests/unit/cli/utils/agent-roles-4116.test.ts`、`tests/setup.ts`、`tests/integration/api-agent-roles-4114.test.ts`、`tests/integration/fixtures/agent-roles-api-examples.ts`、`tests/unit/docs/**`
- CLI の `src/cli/commands/roles.ts`・`instances.ts` は変えない
- 受入:
  1. P1〜P13・N1〜N7 が合格。P12 の grep が 0 件
  2. 環境変数なしでロールつきの Antigravity が起動し、PR1 の門を通って確認後に本文が 1 回届く（実の driver）
  3. 一時ホーム（`os.tmpdir()` の下、`HOME` を差し替え）で agy 1.5.8 の `agy agent` が `~/.gemini/config/agents/<dir>/agent.md` を一覧に出すこと、`--log-file` が `agy agent` のログを動かすかを 1 回ずつ確かめ、出力をコミットメッセージの本文に書く（認証は要らない。本物の `~/.gemini` には書かない）。出なければ止めて PM に返す
  4. CHANGELOG の断片（`changelog.d/4385.md` に統合、1 項目・1 行）に挙動の変更: Antigravity でロールが既定で有効、`~/.gemini/config/agents/` に定義を書く、確かめた agy の版 1.5.8、起動前の一覧の照合、ロールを確かめるまで本文を送らず未送信で理由を出す（プロセスは残る）、CLI の警告は旧いサーバーのときだけ
  5. （マージの後、PM）信頼済みの worktree の TUI で、ロールつきの起動でロールの本文が守られ、編集・実行ができ、適用状態が「適用済み」になる。存在しない名前の定義では起動が理由つきで止まり、別の名前・未適用では本文が未送信になって理由が見え、プロセスは残る。**信頼の後の状態の行に名前があること**（D2 の見立て）をここで確かめる
- 規模（見立て）: src 約 15・試験 約 15・文書 約 6
- gates: 契約の検証は `npm run test:unit`（`tests/setup.ts` に触るため。手元では上の試験の対象と `tests/unit/guards tests/unit/docs` だけ）、integration の `tests/integration/api-agent-roles-4114.test.ts`、`npm run lint`、`npx tsc --noEmit`、`npm run build`（画面・辞書と client が読む `src/types/agent-roles.ts`）、e2e の `tests/e2e/agent-roles-4117.spec.ts`

## 11. 本文に無い指摘（この設計の範囲の外）

- `antigravity.ts:427` の `waitForReady` は時間切れで throw しない。ロールの無い起動でも、シェルに戻ったペインを起動できたと扱いうる（ロールの無い経路は変えない）
- 確認前の Antigravity のプロンプトに Auto-Yes が答えうる（Q7）
- 人の停止（kill-session API）は kill が失敗しても記録と起動中を解除する（`kill-session/route.ts:198`）。この Issue では D7 で本文を止めるだけで、停止の側は直さない

## 12. 改訂の内容（事前レビューと原因調査への対応）

| 指摘 | 版 | 反映した場所 |
|---|---|---|
| P2-1 取得不明から本文へ | 2 | D2 の状態と門 |
| P2-2 遅い正常な起動を止める | 2 | D2 の猶予、C7 |
| P2-3 照合の置き場所 | 2 | D3、N4・N4b |
| P2-4 await の後の旧い世代 | 2・3 | D6（第 3 版で kill の部分を外した） |
| P3-1〜3 画面と診断・子の隔離・互換 | 2 | D2 の判定と診断、D3 の子、D4 |
| R1 不適用の証拠を消すと門が外れる（P2-1 の 2 回目） | 3 | §0、D7、I2、C3 |
| R2 ロールの中の照合の後に kill の内側で失効（P2-4 の 2 回目） | 3 | 自動の kill を外した（D2、I4、Q9）。D6 は残る部分だけ |
| 再レビュー §5 の補足（confirmed と ready の両方・遅い確認の記録・`not-confirmed` の届く先・範囲の維持） | 3 | D2、C7・C10・C11、Q7 |
| 原因調査の推奨 A と、その条件・保証の境界・試験の軸 | 3 | §0・§1・D7・E1・§8.2・§7 |

## 13. この設計で確かめたこと

- `agy --version` → `1.5.8`、exit 0
- `agy --help` → `--agent` は「Agent for the current CLI session」。サブコマンド `agent`・`agents` は「List available agents」。全体の引数に `--log-file`。出力の形式を選ぶ引数は無い
- `agy help agent` と `agy agent --help` → `Usage: agy agent [flags]`、フラグは `-h` / `--help` だけ
- `agy changelog`（同梱）: 1.1.1 で `--agent` と `agent/agents`、1.1.5 で `subagent: false`、1.1.6 で Markdown の custom agent、1.2.1 で `excludeDefaultComponents`、1.2.7 で `find_by_name` 等は `tools` に書けば使える。`tools` に書ける名前の一覧や未知の名前の扱いの項は見つからなかった
- `~/.gemini/config/agents`・`~/.gemini/agents` は今は無い
- 第 3 版で読んだ実コード: `instance-input-lock.ts:795`（失効）・`:825`（境界のフック）、`submit-verified-sender.ts:269`・`:779`（本文の直前の `noteInputStart`）、`kill-session/route.ts:151`・`:198`、`send-user-message.ts:654`・`:677`、`send-failure.ts:82`

## 改訂の履歴

- 2026-11-14 第 2 版: 1 回目の事前レビュー（P2 4・P3 3）を反映。適用の 4 状態と送信の門、D3 を新しいプロセスの分岐へ、D6、診断と子の範囲、CLI の警告を残す
- 2026-11-14 第 3 版: 再レビュー（R1・R2、同じ種類の 2 回目）と原因調査の推奨 A を採用。最上位の不変条件（§0）、自動の kill を外し未送信の拒否でプロセスを残す、拒否の寿命（D7）、本文の境界の同期の確認、確認の記録と許可の分離、保証の境界 E1、受入の言い換え、試験を文書と実の driver に分けて C1〜C11、PR を 2 本に（§12）
