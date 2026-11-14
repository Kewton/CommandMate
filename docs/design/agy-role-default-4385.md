# Antigravity のロールを既定で有効にする（Issue #4385）

- 正本: Issue #4385 の本文、実機の記録 `dev-reports/issue/agy-role-2026-11-14/report.md`（主のチェックアウトにある。初回と「再確認」の節、`evidence/` の各ファイル）
- 前の設計: [agent-roles-adapters.md](./agent-roles-adapters.md) §6.6（agy 1.4.12 の一時ホームでの実測）
- 事前レビュー（2-4-4）と原因調査（主のチェックアウトの `workspace/orchestration/runs/2026-11-14/`）: 1 回目 `prereview-4385-reply.md`、2 回目 `prereview-4385-2-reply.md`（R1・R2）、原因調査 `enabler-return-4385-cause.md`（codex-2、推奨 A）、3 回目 `prereview-4385-3-reply.md`（R3。「不在を免除に変える」の同じ種類の 3 回目）、4 回目 `prereview-4385-4-reply.md`（R4）。第 4 版はリーダーの処分（再指示 3）で、送信の判定を「拒否の記録」から「許可の記録」へ反転した（§12）。第 5 版は PR1 の実装の契約で、R4 の処分（対象外の判定も本文の直前で読み直す）と P3 の補足を入れた
- この文書の書き方: **事実**（実測・実コード・agy の同梱文書で確かめたもの）と**見立て**（確かめていないもの）を分けて書く。見立てには「見立て」「未確認」と書く
- この設計ではコードを書かず、agy のセッションも起動していない。読んだのは `agy --version`・`agy --help`・`agy help agent`・`agy changelog` の出力と、`~/.gemini` の一覧（読むだけ）
- 行番号は develop `ff13eeace` の時点

## 0. 最上位の規則

### 0.1 送信の門（1 文）

> **ロールが設定された（DB の roster・既定の解決の結果がロールあり）Antigravity のインスタンスへ CommandMate が本文を送ってよいのは、今の生きている世代について「適用を確認した」正の記録があるときだけ。記録が無い・消えた・不明・読めないは、どれも未送信で拒否する**（「ロールを確認できないため未送信。停止して起動し直す」）。

- **門の対象かどうか**は、消える記録（証拠・拒否）ではなく、**永続のロールの設定**から決める。記録の削除（forget）・停止の失敗・サーバーの再起動のどれでも対象から外れない
- **送ってよいかどうか**は、正の記録が**ある**ことだけで決める。拒否の記録が**無い**ことを許可の代わりにしない
- ロールの設定が無いインスタンスは、今までどおり門の対象外

### 0.2 なぜこの形か

第 1〜3 版のレビューの穴（取得不明から本文へ／不適用の証拠を消すと対象外／固定の拒否になる前に証拠を消すと対象外）は、どれも**記録の不在を免除に変えた**こと。対象を消える記録で決め、許可を拒否の不在で決めている限り、記録が消える経路の数だけ穴が出る。対象を永続の設定で、許可を正の記録の存在で決めれば、記録が消える経路はすべて「拒否」に倒れる（種類ごと閉じる）。

### 0.3 最上位の不変条件

> **一度の確認で得た許可は、それを得た世代と、それを使う瞬間の状態の両方に結びつけて使う。** 記録の削除・停止の試行やその失敗・送り直し・内側の await を越えて、許可が生き残ったり、不在が許可に化けたりしない。

## 1. 結論

1. 生成物（`~/.gemini/config/agents/<name>/agent.md`）の frontmatter に `tools` を足す。1.5.8 で確かめた 13 個の定数で、出典を書く（D1）
2. `CM_AGENT_ROLE_ANTIGRAVITY_ENABLED` と `isAgentRoleAdapterEnabled` を消し、既定で有効にする。API の `adapterEnabled` は常に `true` で残し、CLI の警告は旧いサーバー向けに残す（D4）
3. **版の範囲で起動を止めない。** 登録に無い道具の名前は agy 自身が exit 3 で止まる（実測）。CommandMate はその結果のプロセスへ本文を送らない（D2）
4. **起動前に `agy agent` の一覧と照合する**（新しいプロセスを起こす分岐だけ、D3）
5. **送信の門は §0.1 の 1 文。** 門は driver の中（通常の send にも）と、本文を実際に入れる境界の両方に置く（D2）
6. **CommandMate はセッションを自動では止めない。** 不適用・猶予切れ・正の記録が無いときは、本文を未送信で拒否して理由を見せる。プロセスは残し、止めるのは人の既存の停止（D2）
7. 正の記録は、新しく起こした世代を確認したときにだけ作られ、その世代が今の生きている世代である間だけ有効（D7）
8. **PR は 2 本**: PR1 = 送信の門・正の記録・起動後の確認（スイッチは残す）、PR2 = tools・スイッチの削除・起動前の照合・画面と文書（§7）

### 受入の言い換え（リーダーの処分。PM へ報告する）

Issue の受入「未知の名前・登録に無い道具のとき、黙ってロールなしで動かない（**止まって理由が見える**）」を、次の意味とする:

> **CommandMate からの本文が未送信で止まり、理由が見える。プロセスは残り、人が止める。**

画面・CLI には「停止した」とは出さず、「ロールを確認できないため未送信。停止して起動し直す」と出す。

### 影響（利用者に見える変化）

| 誰 | PR1 の後 | PR2 の後 |
|---|---|---|
| Antigravity にロールを設定していない利用者 | 変化なし | 変化なし |
| ロールを設定したが環境変数で有効にしていない利用者（既定） | **変化なし**（PR1 の門はスイッチが有効なときだけ対象にする。§7） | ロールつきで起動する。確認するまで本文は未送信 |
| 環境変数 `CM_AGENT_ROLE_ANTIGRAVITY_ENABLED=1` で有効にしていた利用者 | **未確認の送信が拒否され始める。** 今動いているロールつきのセッション（PR1 より前に起動したもの）には正の記録が無いので、「停止して起動し直す」が要る | 同じ |
| ロールを設定してから、ロールなしで動いていたセッションへ送る | スイッチが有効なら拒否（停止して起動し直す） | 拒否（停止して起動し直す）。他の adapter の「再起動待ちのまま送れる」とは違う |
| サーバーの再起動・再ビルドの後、ロールつきで動いていたセッション | スイッチが有効なら拒否 | **拒否。停止して起動し直す**（正の記録はメモリにあり、再起動で消える。§9 Q8） |

Antigravity のロールは今まで既定で無効だったので、既存の利用者への影響は小さい（見立て）。運用の影響は最後の行で、サーバーを再起動するたびに、ロールつきの Antigravity のセッションを起動し直す必要がある。

## 2. 実コードとの照合（Issue の本文との食い違い）

| # | Issue の本文 | 実コード（正） | この設計の扱い |
|---|---|---|---|
| 1 | 定義の置き場所は `~/.gemini/agents/<name>/agent.md` | `src/lib/agent-roles/artifacts.ts:290` の `resolveArtifactLocation` は `~/.gemini/config/agents/<name>/agent.md`（`artifacts.ts:257`、`src/lib/hooks/sources/antigravity/hooks-config.ts:213`） | 実コードを保つ。1.4.12 では両方とも一覧に出た（`agent-roles-adapters.md:255`）。**1.5.8 で `config/agents` が出るかは未確認**。D3 が毎回確かめる。PR2 の受入で一時ホームで確かめる |
| 2 | 生成物に足すのは `tools` だけ | `src/lib/agent-roles/adapters.ts:25` の `ADAPTER_VERSION` は 7 adapter で 1 つ。同じ名前に別の中身は `content-mismatch`（`artifacts.ts:690`） | Antigravity だけ adapter の版を `'2'` に（D5） |
| 3 | （記述なし）起動後の確認 | `src/lib/session/role-launch.ts:724` の `settleLaunchRole` は Antigravity で何もしない。`src/lib/cli-tools/antigravity.ts:374` の `waitForReady` は 30 回（`antigravity.ts:87`）の待ちが尽きても throw しない（`antigravity.ts:427`）。61 秒の起動の実測（`antigravity.ts:355`、`:106`） | 起動中・取得不明を別の状態にし、次の send のプロンプト待ちまで確認を続ける（D2） |
| 4 | 「起動前に `agy agent` の一覧と照合して止める」 | `agy help agent` は名前の一覧だけ（1.5.8）。1 行に 1 つ（`evidence/1-list.txt`） | 行ごとの完全一致（D3） |
| 5 | 「登録に無い名前を 1 つでも書くと exit 3」 | 一覧は登録に無い道具を書いた定義も**出す**（`evidence/r2-1-list.txt`） | D3 では拾えない。D2 が拾う |
| 6 | （記述なし）本文を送ってよい条件 | ロール条件の検査（`src/app/api/worktrees/[id]/send/send-role.ts:263`・`:297`）は fingerprint と generation だけ。証拠は `requested` でできる（`role-launch.ts:556`）。条件の無い send は何も見ない（`antigravity.ts:565`） | 門は §0.1。`requested` を確認の代わりにしない |
| 7 | （記述なし）再接続 | 再利用は `antigravity.ts:278`（`if (live) return;`）。`src/lib/cli-tools/base.ts:410` は生成物の拒否があっても動いているプロセスへ再接続する | D3 は再利用の return の後。再接続でも送信の門は通る（対象は設定で決まる） |
| 8 | （記述なし）停止と記録の削除 | 人の停止 API は kill が失敗しても、後段で全対象に `forgetLaunchRoleEvidence` と起動中の解除をする（`src/app/api/worktrees/[id]/kill-session/route.ts:151`・`:198`）。`forgetLaunchRoleEvidence`（`role-launch.ts:781`）は証拠を丸ごと消す | 証拠が消えれば正の記録も消え、門は拒否に倒れる（§0.2）。停止の側は直さない |
| 9 | （記述なし）kill の世代 | 既存の kill は `hasSession`→`requestExit`（Ctrl-D と待機）→tmux kill を await する（`base.ts:974`、`antigravity.ts:604`）。入力のロックの旧い持ち主は失効させられ、失効は callback を止めない（`src/lib/session/instance-input-lock.ts:795`、`src/lib/session/agent-session-lifecycle.ts:112`） | **新設の自動の kill を作らない**（R2 を種類ごと外す） |
| 10 | （記述なし）設定がロールを与えるか | `role-launch.ts:769` の `settingsGiveRole` は設定を解決して「ロールあり」かを返すが、曖昧（`ambiguous`）や拒否も `false` に畳む | 門の対象の判定は 3 値（ロールあり／なし／読めない）の新しい関数にし、曖昧・拒否・DB の失敗は「読めない」→拒否（D2） |

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
| (b) 起動の後に確かめ、正の記録ができるまで本文を送らない | **採る** |
| (c) 起動の前に短い headless を走らせる | **採らない**。起動のたびにモデルを 1 回呼ぶ |

#### 門の対象の判定（永続の設定から）

- 新しい関数（例 `resolveRoleSendTarget(target, worktreePath)`）が 3 値を返す: `role`（設定がロールを与える）／`none`（与えない）／`unreadable`（DB が読めない、所属が曖昧、解決の拒否）
- 中身は既存の解決（`role-launch.ts:235` の `resolveLaunchRole`、`settingsGiveRole` と同じ入力）。ロールの設定が DB のどこにも無ければ同期に `none`（`role-launch.ts:348` の `hasAnyRoleSetting` の速い道と同じ）
- `role` と `unreadable` は門の対象。`none` だけが対象外
- PR1 の間だけ、対象は **`enabled && (role || unreadable)`** とする（`enabled` はスイッチが有効なこと。無効なら設定の有無にかかわらず今の動きのまま。スイッチが無効なら Antigravity はロールつきで起動できないので、今の動きを変えない）。PR2 でスイッチを消すと、対象は §0.1 の形（設定だけ）になる
- **対象外（`none`）の判定にも有効期間がある（R4、第 5 版）:** `none` と決めた送信も、本文を入れる直前（下の「門の置き場所」の 2 の境界）で、判定に使った永続の設定を同期に読み直す（ロールの設定がどこにも無かったか、読んだ所属で解決し直して `none` のままか）。設定が変わっていれば（読めないときも）その送信は未送信で拒否し（分類「送信の途中で設定が変わった」、理由 `not-confirmed`）、次の send に委ねる（次の send は門の対象として判定される）。設定を変えなければロールなしで本文 1（今と同じ）。設定の書き込みを入力のロックに入れる改修はしない

#### 正の記録

- 置き場所: サーバーのメモリの証拠（`role-launch.ts:128` の `StoredLaunchRoleEvidence`）の項目 `application`。値は `starting`／`unknown`／`confirmed`／`refused`。**正の記録とは `application === 'confirmed'` のこと**で、それ以外（項目が無い・証拠が無いを含む）はすべて「正の記録が無い」
- 作られる時: その世代の画面で生成物の名前を見たとき（下の「画面から判定してよい範囲」）。起動行を作ったとき（`openGeneration`、`role-launch.ts:556`）は `starting` で、正の記録ではない
- 消える時: 証拠と一緒に消える（`forgetLaunchRoleEvidence`、新しい世代の `openGeneration` による置き換え、サーバーの再起動）。消えたら門は拒否に倒れる（§0.2）。**消えることを解除の手段にしない**
- 「今の生きている世代」: 送る時点の証拠の generation が、正の記録を作った generation と同じこと。プロセスが入れ替わると generation が変わる（既存の規則）

#### 状態（同じ世代の中）

| 状態 | 意味 | 本文 |
|---|---|---|
| `starting`（起動中） | 起動行を打った。判定の材料がまだ無い | 送らない（猶予の中で待つ） |
| `unknown`（取得不明） | 画面を取れなかった | 送らない（猶予の中で待つ） |
| `confirmed`（適用を確認済み＝正の記録） | 今の状態の行に生成物の名前がある | **既存の ready の条件と両方そろったときだけ**送る |
| `refused`（明確な不適用・猶予切れ） | 不適用を見た、または猶予が切れた | 送らない。同じ世代の中では、後から来た肯定の観測で `confirmed` に戻さない（D6 の compare-and-set） |

`refused` の理由は `not-applied`（明確な不適用。既存の理由）と `not-confirmed`（猶予切れ、または正の記録が無い。新設）。**どの状態でもプロセスは止めない。**

#### 画面から判定してよい範囲

- 読むのは ANSI を除いた画面の**現在の状態の行**だけ（既存の `readInputBoxStatusRow`、`antigravity.ts:190` と同じく構造で取る）。本文・scrollback・引用・古い `error:` 行は使わない
- `confirmed`: 状態の行が ` · <name> (` を含む（前は ` · `、後ろは ` (` で区切る）。実測の形は `auto · cm-role-x (Gemini 4 Hydrogen · high)  /agents`（`evidence/4-tui.txt`、**信頼の前の一例だけ**）
- 明確な不適用は 3 つだけ: (1) ペインの前景が agy でない（`isToolLive`）。起動行より後の行に `unknown component: tool "<x>"` があれば分類を「登録に無い道具」に (2) 入力欄が出た画面（`isAntigravityReady`、`antigravity.ts:238`）で名前が無い (3) 信頼の画面で名前が無い、または別の名前
- 未描画・途中の画面・取得の失敗は不適用にしない

#### 猶予（60 秒）

- 起動の中（`settleLaunchRole`、`role-launch.ts:687`）: `waitForReady` が返った後に画面を 1 回読み、決められれば `confirmed` か `refused(not-applied)`。決められなければ `starting`／`unknown` のまま起動を返す。起動は throw しない。追加の待ちは足さない。**実装（第 5 版）:** 画面の判定は driver が持つ（入力欄の構造の読み取りは `antigravity.ts` にあり、`role-launch.ts` から読むと循環する。`settleLaunchRole` に読み手を渡す `base.ts` は PR1 の範囲の外）ので、driver の `launchSession` の最後（`waitForReady` の後、同じ起動の scope の中）で `role-launch.ts` の `observeLaunchRoleApplication` を呼ぶ。時点と規則は同じ
- 送信の門（`antigravity.ts:565` の `sendMessage`、`waitForPrompt` の中）: `starting`／`unknown` なら、`waitForPrompt` と**同じ待ちの中で**（足し算にしない）1 秒ごとに読み直す。猶予は `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS`（60 秒、`antigravity.ts:109`）で、**この世代で最初に門に来た send の開始から数える**。切れたら `refused(not-confirmed)`
- 繰り越した信頼の Enter は既存のとおり 1 回だけ打ち、その後の画面で判定を続ける
- `confirmed` でも、信頼の画面・生成中・モデルの選択の画面なら本文は送らない。ready になってから 1 回

#### 門の置き場所

1. **driver の中:** `sendMessage` の `requireSession`（`antigravity.ts:573`）の後、`waitForPrompt` の前と中。まず対象を判定し（`none` なら今と同じ）、対象なら上の状態で待つか拒否する。通常の send・契約の送信・ロール条件つきの send・起こし直しの後の send がすべて通る
2. **本文を実際に入れる境界:** 共有の sender の本文の直前、`noteInputStart()` を呼ぶ 2 か所（打鍵 `src/lib/cli-tools/submit-verified-sender.ts:779`、長文の貼り付け `submit-verified-sender.ts:269`）。引数 `SubmitVerifiedSendParams`（定義は `src/lib/cli-tools/submit-verified-sender-shared.ts:112`。二重に定義しない）に省略可能な同期の確認 `beforeBody` を足し、`noteInputStart()` の直前で呼ぶ。throw したら本文を入れない（長文は buffer を捨ててから上げる）。driver が自分で渡すので、`src/lib/session/send-user-message.ts:654` の `observeInputStart` を通らない直接の呼び出しでも効く。既存の入力の ticket・ロール条件の境界（`send-role.ts:297`、`instance-input-lock.ts:825`）は残す
3. **境界の確認（同期）:** driver が門で決めた世代 G について、(a) 今の証拠があり generation が G、(b) G の `application` が `confirmed`、(c) G の注入 fingerprint が門で見たものと同じ。1 つでも外れたら本文 0 で未送信の拒否。**「拒否の記録が無い」はどこにも条件に入れない**。門が `none`（対象外）と決めた送信では、同じ境界で設定を同期に読み直し、`none` のままでなければ本文 0 で未送信（R4、上の「門の対象の判定」）。最初の判定を閉包に残して境界で使わない
4. **Auto-Yes の応答キーと `respond` は本文ではないので門の外**（決定。§9 Q7）。「本文 0」は「全キー・全操作 0」ではない

#### 設定の変更と門

- 動いている間にロールの設定が**無くなった**（`none`）: 門の対象外になり送れる（利用者が外した。プロセスが旧いロールを持っていても害は無い）
- 動いている間に**別のロール**に変わった: 正の記録は起動したときの注入に対するものなので、門は通す。既存のとおり「再起動待ち」と表示する（他の adapter と同じ）
- ロールなしで動いていたセッションに、後からロールを設定した: 正の記録が無いので拒否（§1 の影響の表）
- 送信の途中（門が `none` と決めた後、本文の前の await の間）にロールが設定された: その送信は未送信で拒否し、次の send に委ねる（R4）。本文が設定の変更より前に既に入っていた送信は、送信済みのまま（未送信に書き換えない）

#### 未送信の拒否の文面と届く先

- 文面（API の英文の案）: `The role could not be confirmed for this Antigravity session, so nothing was sent. Stop the session and start it again.` に分類（登録に無い道具／起動しなかった／ロールを選ばなかった／確認できなかった／確認の記録が無い／設定を読めなかった）を足す。日本語の画面は「ロールを確認できないため未送信。停止して起動し直してください」
- 診断に出してよいもの: 分類、`/^[a-z_][a-z0-9_]{0,63}$/` に合う道具の名前、確かめた版 `1.5.8`、動いている版（`/^\d+\.\d+\.\d+$/` に合うときだけ）、生成物の名前とパス。**agy の `error:` 行をそのまま出さない**
- 届く先: `RoleLaunchRefusedError` の印（`src/lib/agent-roles/launch-errors.ts:40`）を既存の読み手が拾う（`send-user-message.ts:677` が未送信に、`src/app/api/worktrees/[id]/send/send-failure.ts:82` が `roleRefusal` に、CLI がその表示に）
- `agy --version` は拒否の文面を作るときだけ呼ぶ（5 秒・256 バイト）。判定には使わない

#### 確認の記録（DB）と送信の許可を分ける

- 許可は正の記録（メモリ）で、門だけが読む。記録 `launched`（DB）は表示のためで、門は読まない
- 遅い確認（門の中で `confirmed`）も、元の起動の snapshot・生成物・世代に対して `launched` を書く。そのため `openGeneration` のときに記録に要る値を証拠に残す。最新の設定や後継の `requested` から採り直さない
- 書く直前に世代が今のものでなければ書かない（`role-launch.ts:520` の `recordPhase` の規則）。DB に書けなかったときはログだけで、許可は変えない
- `current-output` の `roleLaunch`、ロールの API の `currentGeneration`、send の応答の notices を適用の確認に格上げしない

### D3 起動前の照合: `agy agent` の一覧

- 置き場所: `antigravity.ts:269` の `launchSession` の中、`antigravity.ts:278` の `if (live) return;` の**後**、`antigravity.ts:288` の `beginAgentSession` の**前**。新規のペインと、同じペインで tool が終わっていた起こし直しだけが通る
- 今の起動の scope（`role-launch.ts:445` の `runWithLaunchRole`）にロールの注入があるときだけ照合する
- 再接続（`live`）は照合しない（既存の例外 `base.ts:410` もそのまま）。別のサーバーのセッションは `resolveLaunchPane`（`base.ts:878`）が触らずに拒否する
- headless（Schedule、`role-launch.ts:861` → `src/lib/session/claude-executor.ts:202`）には入れない。未知の名前で exit 1、登録に無い道具で exit 3、実行記録は `failed`（`src/lib/job-executor.ts:285`）
- 判定: 出力の行に生成物の名前と完全に一致する行があれば通る。無い・非 0・時間切れ・起動できない → `RoleLaunchRefusedError('artifact-failed', …)`。理由は名前・パス・exit code・時間切れだけ
- **D3 の成功は正の記録ではない**
- 子の環境: cwd は worktree。`PATH`・`HOME` はペインが受け取る tmux の環境（`src/lib/agent-roles/pane-env.ts`）にあればそれ、無ければサーバーのもの。上限は 10 秒で SIGKILL、標準出力 64 KiB、標準エラー 4 KiB（理由に出さない）
- 副作用（事実）: `agy agent` は `~/.gemini/antigravity-cli/` のログを 1 本増やす。ログ以外の変更が無いのは 1.4.12 の観測で、1.5.8 以後の保証ではない
- `CM_UAT_ISOLATION=1`（`src/config/uat-isolation.ts`）: 子を起こす前に拒否する。`own-home` では照合する。`--log-file` が `agy agent` に効くかは**未確認**（§9 Q6）

### D4 有効化のスイッチを消す（PR2）

- `src/types/agent-roles.ts:38` の `AGENT_ROLE_ANTIGRAVITY_ENABLED_ENV_VAR` と `src/types/agent-roles.ts:46` の `isAgentRoleAdapterEnabled` を消す。呼び手: `role-launch.ts:293`、`send-role.ts:188`、`src/lib/agent-roles/management.ts:229`・`:244`・`:407`・`:428`、PR1 で足す門の対象の判定
- API の `adapterEnabled` は常に `true`（`docs/user-guide/cli-operations-guide.md:3616`）。`adapter-disabled`（`launch-errors.ts:28`）は型に残し、コメントを「旧いサーバーの応答を読むため」に
- 画面の注記を消す: `src/components/roles/InstanceRolesSection.tsx:233`・`src/components/roles/RepositoryRoleDefaults.tsx:126`・`src/components/settings/AgentRolesSettings.tsx:537`・`src/components/worktree/AgentAddMenu.tsx:465`、辞書 `locales/ja/common.json:383`・`locales/en/common.json:383`
- CLI の警告（`src/cli/commands/roles.ts:345`、`src/cli/commands/instances.ts:659`）は**残す**（旧いサーバーが `false` を返したときだけ出る）
- 利用者向けの文書: `docs/user-guide/cli-operations-guide.md:3556`・`docs/en/user-guide/cli-operations-guide.md:2691`・`docs/user-guide/webapp-guide.md:484`・`docs/en/user-guide/webapp-guide.md:455` を、「ロールが設定されると `~/.gemini/config/agents/` に定義を書いて起動し、ロールを確かめるまで CommandMate からの本文を送らない。確かめられない・記録が無い（サーバーの再起動の後を含む）ときは未送信で理由を出す。プロセスは残るので停止して起動し直す。Auto-Yes の応答キーは本文ではない」に。CLI の警告は旧いサーバーのときだけと書く
- 前の設計の更新: `agent-roles-adapters.md:18` と §6.6 にこの文書への参照

### D5 adapter の版（PR2）

- Antigravity だけ `'2'`、他の 6 adapter は `'1'`（`adapters.ts:25` を adapter ごとに。`adapters.ts:114` の canonical に入る値と返す `adapterVersion` を同じに）。他の fingerprint は 1 バイトも変えない
- 旧い版で動いているプロセスは、正の記録が無ければ拒否される（§0.1）。新しい版で適用済みと書き直さない。旧い定義は消さない

### D6 await の後の照合

| 場所 | 前の await | 照合 | 外れたとき |
|---|---|---|---|
| D3 の直後、`beginAgentSession` の前 | `agy agent`（10 秒まで） | 起動の scope の epoch が今の epoch、かつ別の起動が世代を開いていない | `RoleLaunchRefusedError('session-stopped')`。ペイン・起動のキー・記録 0 |
| 状態を変える直前（起動の中・門の中） | 画面の取得・`isToolLive`・`agy --version` | **世代と、観測を始めたときの状態の版**の両方が今と同じ（compare-and-set。状態に単調に増える番号を持つ） | 何も変えない。古い観測は捨てる |
| `launched` を書く直前 | 同上 | 世代が今のもの（既存の `isStale`、`role-launch.ts:438`） | 書かない |
| 本文の境界 | sender の中の全 await | D2 の境界の確認 (a)〜(c) | 本文 0 |

**この Issue は kill を新設しないので、kill の内側の await の排他は作らない。** 既存の人の停止を直したとも安全にしたとも言わない。その停止が失敗しても、証拠が消えれば正の記録も消え、門は拒否する。

### D7 正の記録の寿命（§0.1 から導けるものだけ）

第 3 版の「固定の拒否の表」と「忘却で解除しない」規則は**消した**。許可が正の記録の存在だけで決まるので、拒否を別に覚える必要が無い。残る規則は次の 3 つだけ:

1. **作る:** 新しく起こした世代（`openGeneration` で開いた世代）の画面で名前を見たときだけ、その世代に作る。D3 の成功・`requested`・ready・設定の解決の結果では作らない
2. **使う:** 送る時点で、今の証拠の generation が記録の generation と同じときだけ有効
3. **拒否を解除する時点（1 つの表現）:** **新しい世代の確認で正の記録ができたとき**。それまでは、旧い世代の状態・証拠の有無にかかわらず未送信（`openGeneration` で世代を開いただけでは解除しない）

agy が終わってシェルに戻っているときは、次の send の `requireSession` が起こし直して新しい世代になる。exit 3 が続く版では、send のたびに起こし直して未送信になる（本文 0 は保つ。見立て: 1 回あたり 30 秒ほど）。

## 4. 不変条件

| # | 不変条件 | 何が守るか |
|---|---|---|
| I1 | §0.1 の 1 文（ロールが設定された Antigravity へは、今の生きている世代の正の記録があるときだけ本文。無い・消えた・不明・読めないは未送信） | D2 の門と境界、D7 |
| I2 | 門の対象は永続の設定で決まり、forget・停止の失敗・サーバーの再起動で外れない | D2 の対象の判定 |
| I3 | 非同期の観測からの状態の更新・記録・本文の入力は、実際の更新・入力の境界で元の世代と状態に結ぶ。古くなった結果は後継を変えず、消さず、止めない | D6 |
| I4 | CommandMate は Antigravity のセッションを**自動では止めない**（この Issue で足す停止は 0） | D2 |
| I5 | 登録に無い道具の名前で動いたプロセスへ本文を送らない。生成物の `tools` は確かめた定数だけ | D1、D2 |
| I6a | CommandMate が利用者のホームに書くのは `~/.gemini/config/agents/` の下の `cm-role-` のディレクトリと `agent.md`（0600、ディレクトリ 0700）だけ。既存のファイルは書き換えず消さない。`CM_UAT_ISOLATION=1` では同じバイトの既存の生成物の再利用だけ（`artifacts.ts:690`） | 既存の規則 |
| I6b | agy の子（`agy agent`）が書くログは別に数え、`CM_UAT_ISOLATION=1` では子を起こさない | D3 |
| I7 | 拒否の理由とログにロールの本文と agy の任意の文字列を入れない | D2 |
| I8 | ロールの設定が無いインスタンス・Schedule・他の 6 adapter は今と同じ。再接続では照合を呼ばない | D2 の対象の判定、D3、D5 |

第 3 版の例外 E1（再起動を越えた拒否は保証しない）は**無くなった**。再起動の後は正の記録が無いので拒否される（§1 の影響の表の最後の行が、その代償）。

## 5. 状態と遷移の表

### 5.1 起動（ロールの注入がある Antigravity）

| 状態 | 出来事 | 次 | 書くもの | 見えるもの |
|---|---|---|---|---|
| resolved | 生成物が無い／同じバイトがある | written | `agent.md` の新規作成／なし | なし |
| resolved | 別のバイト・symlink・権限・UAT で書けない | 拒否（ペイン前、`artifact-failed`） | なし | 理由（既存） |
| written | 読み直しの検査（`tools` を含む）に落ちる | 拒否（ペイン前） | なし | `format-invalid` |
| written | driver が動いているプロセスを見つけた | reused | なし（世代を開かない） | 今と同じ |
| written | 別のサーバーのセッション | 拒否（既存） | なし | 既存 |
| written | 新しいプロセス、`CM_UAT_ISOLATION=1` | 拒否（ペイン前） | なし（子を起こさない） | UAT の理由 |
| written | 新しいプロセス、一覧に名前がある | listed | agy のログ 1 本 | なし |
| written | 一覧に無い・非 0・時間切れ | 拒否（ペイン前、`artifact-failed`） | agy のログ | 理由 |
| listed | 照合の待ちの間に停止 | 拒否（`session-stopped`） | なし | 既存の文面 |
| listed | 照合が合う | starting（新しい世代 G） | ペイン・起動行・`requested`・証拠（G、`starting`） | 起動中 |
| starting | 画面に名前（信頼の画面でも可） | confirmed（正の記録） | `launched` | 適用済み |
| starting | 明確な不適用 | refused(`not-applied`) | 状態だけ | 起動は返る。次の send で理由 |
| starting | 未描画・取得の失敗 | starting / unknown | なし | 起動は返る |

### 5.2 送信（門の対象のインスタンスへ）

「正の記録」の列が「無い」ものは、すべて本文 0。

| 対象の判定 | 証拠と状態 | 正の記録 | 出来事 | 本文 | プロセス |
|---|---|---|---|---|---|
| role | G・confirmed | ある | ready で send | 1 回 | 残す |
| role | G・confirmed | ある | 信頼の画面・生成中・選択の画面 | ready まで 0、その後 1 | 残す |
| role | G・starting / unknown | 無い | 猶予の中で名前と ready | 確認の後に 1 回（`launched` を G に） | 残す |
| role | G・starting / unknown | 無い | 猶予の中で明確な不適用、または猶予切れ | 0（`not-applied`／`not-confirmed`） | **残す** |
| role | G・refused | 無い | 送り直し（何度でも） | 0 | 残す |
| role | 証拠なし（forget の後。停止の kill が失敗してプロセスは生きている） | 無い | 動いているプロセスへ再接続して send | 0（`not-confirmed`、確認の記録が無い） | 残っている |
| role | 証拠なし（サーバーの再起動の後） | 無い | send | 0（同上） | 残す |
| role | 証拠なし（ロールなしで動いていたセッションに後からロールを設定） | 無い | send | 0（同上） | 残す |
| role | 旧い世代の証拠 → 確実な停止 → 新しい起動 H | H で確認の後にある | send | 確認の後に 1 回 | 新しい |
| unreadable | 任意 | — | send | 0（設定を読めなかった） | 残す |
| none | 任意 | — | send | 今と同じ | 今と同じ |
| none → 本文の前に role | 任意 | — | `none` の判定の後の await の間に設定が完了 | 0（設定が変わった。次の send に委ねる） | 残す |
| 任意 | 待ちの間に世代が入れ替わった | — | — | 0（既存の「入れ替わった」） | 後継に触らない |

## 6. 外部の呼び出しごとの失敗の倒れ方

| 呼び出し | 成功 | 失敗のとき | 倒れる側 |
|---|---|---|---|
| `~/.gemini/config/agents/` への書き込み | 0600 の新規、または同じバイトの再利用 | 書けない・別の中身・symlink・権限 → `artifact-failed` | **起動を止める**（既存。ペインの前） |
| `agy agent`（一覧） | exit 0 で名前の行 | 無い／非 0／10 秒／64 KiB 超／`agy` が無い → `artifact-failed` | **起動を止める**（ペインの前） |
| 設定の解決（門の対象の判定） | `role`／`none` | DB の失敗・曖昧・拒否 → `unreadable` | **本文を止める** |
| 設定の読み直し（`none` の送信の本文の直前、同期） | `none` のまま | 変わった・読めない | **本文を止める**（次の send に委ねる） |
| agy の起動（TUI） | 状態の行に名前 → 正の記録 | 明確な不適用・猶予切れ | **本文を止める。プロセスは残す** |
| 画面の取得 | 画面 | 取れない → `unknown`、猶予の中で読み直す | **本文を止める** |
| `agy --version` | `x.y.z` | 非 0・5 秒・形が違う → 「不明」 | **進める**（文面だけ） |
| headless（Schedule） | exit 0 | exit 1 / 3 → `failed`（既存） | agy 自身が止まる。変えない |
| DB への `launched` の記録 | 行 | 書けない → ログだけ | **許可は変えない** |
| 人の停止（既存の kill-session） | ペインが消え、証拠が消える | kill が失敗してプロセスが残り、証拠は消える | **正の記録が無いので本文 0** |

## 7. PR の切り方

### 規模の見積もり（見立て）

1 本にすると、変えるファイルは src 約 20・試験 約 20・文書 約 6 の 40 本を超え、試験を含めて千行を超える見込み。`docs/orchestrate/team.md` §6 の 3（目安は数百行・20 ファイル程度、送信の経路を画面の変更と同じ PR に入れない）を大きく超える。分けたこと自体を受入の根拠にはしない。

### 2 本に分ける（送信の門が先）

| PR | 中身 | スイッチ | 利用者への影響 |
|---|---|---|---|
| **PR1 送信の門** | D2（対象の判定・正の記録・状態・猶予・門・境界の `beforeBody`・文面・遅い確認の記録）、D6、D7。起動後の確認 | **残す**。門の対象は「設定が `role`（または `unreadable`）かつスイッチが有効」 | **既定では変化なし。** 環境変数で有効にしている利用者では、未確認の送信の拒否が始まる（§1 の影響の表） |
| **PR2 有効化** | D1、D5、D3、D4（スイッチの削除で門の対象が設定だけになる）、画面・辞書・文書 | 消す | Antigravity のロールが既定で有効になり、§0.1 がそのまま効く |

逆の順（有効化が先）は I1 を破る期間を作るので採らない。PR2 の契約は、PR1 が develop に入った後の実装を基準に書き直す。

## 8. 試験の表

### 8.1 二種類の試験を分ける

| 種類 | 何を確かめるか | 何を確かめないか |
|---|---|---|
| **文書の語句の試験**（`tests/unit/docs/agy-role-default-design-4385.test.ts`） | この設計に必要な節・語句・13 個の一覧があり、引いたファイルが実在する | 状態の遷移や割込みが正しいこと。実装の合否 |
| **実の driver を通す試験**（PR1・PR2） | base → 実の driver（`antigravity.ts`）→ settle → 共有の sender まで通し、**本文の回数・本文の Enter の回数・kill と Ctrl-D の回数・証拠の宛先**を数える | — |

実の driver の試験は `agy` を起動しない（一覧・版・画面・時計・tmux を差し替える）。生成物は `os.tmpdir()` の下（`tests/setup.ts:253`）。各防御を外した変異で赤になることを示す。正常な場合に 1 回送れることも確かめ、常に拒否するだけの実装を合格にしない。

### 8.2 PR1: 正の記録が無いすべての状態で本文 0

ロールを設定し（スイッチは `vi.stubEnv` で有効）、実の停止 API（`kill-session/route.ts`）の後処理と実の driver の通常の send を通す。どの行も「本文 0・本文の Enter 0・未送信の理由あり・自動の Ctrl-D と kill 0」。

| # | 正の記録が無い状態 | 作り方 |
|---|---|---|
| Z1 | `starting` | 起動の窓の後も未描画のまま、猶予の前に send |
| Z2 | `unknown` | 画面の取得がずっと失敗 |
| Z3 | `refused(not-applied)` | 入力欄が出た画面で名前が無い |
| Z4 | `refused(not-confirmed)` | 猶予切れ |
| Z5 | forget の後（`starting`／`unknown` から） | Z1・Z2 の後に人が停止 → kill が throw してペインは生きている → API が forget と起動中の解除 → 動いているプロセスへ再接続して send（R3 の中心） |
| Z6 | forget の後（`refused` から） | Z3 の後に同じ停止の失敗（R1） |
| Z7 | サーバーの再起動の後 | 証拠のメモリを空にして（試験用のリセット）、動いているプロセスへ send |
| Z8 | ロールなしで動いていたセッションに後からロールを設定 | ロールなしで起動 → 実の roles API で設定 → send。**R4:** `none` の判定の後の await の間（共有の sender の画面の取得、長文の `load-buffer`）に実の roles API で設定が完了 → 実の driver → 共有の sender。短文・長文とも本文 0・本文の Enter 0・未送信（`not_sent`）。ロールの設定がどこにも無い（速い道）と、別の所に設定がある（所属を読む）の両方。設定を変えなければ本文 1 |
| Z9 | 設定が読めない | DB の失敗・所属の曖昧を差し替え |
| Z10 | 世代の入れ替わり | 門で G を見た後、本文の境界の前に起こし直して H にする（短文と長文の両方） |

**必須の変異（赤になること）:**

- 「正の記録が**ある**ことを、拒否の記録が**無い**ことに置き換える」 → Z5・Z7・Z8 が赤になる
- 「門の対象を証拠の有無で決める」 → Z5・Z6・Z7 が赤になる
- 「境界の同期の確認を外す」 → Z10 が赤になる
- 「対象外という最初の判定を閉包に残す」（`none` の送信の境界で設定を読み直さない） → Z8 の R4 の行が赤になる

### 8.3 PR1: 正の記録がある場合と、その他の対照

| # | 順序・入力 | 期待 | 赤にすべき変異 |
|---|---|---|---|
| C1 | 照合は成功 → TUI は既定の agent で ready → settle の画面の取得だけ失敗 → 通常の send とロール条件つきの send | 本文 0。`requested` の一致だけでは通らない | 「証拠の fingerprint が合えば送る」 |
| C2 | 明確な不適用／猶予切れ → 送り直しを繰り返す | 本文 0。**自動の Ctrl-D・kill 0** | 「拒否の後に kill する」 |
| C4 | 同じ世代の確認を保留 → 別の観測で `refused` → 古い肯定を解放 | `confirmed` に戻らない、本文 0 | 「世代だけを照合して状態の版を見ない」 |
| C5 | 画面・`isToolLive`・版・本文の前の各待ちを保留 → 停止 → 後継 → 旧い処理を解放（短文と長文） | 後継の状態の更新・削除・停止 0、旧い send の本文 0 | 「待ちの完了だけで許す」 |
| C7 | 30 秒の窓の終わりは未描画 → 61 秒で名前と ready。別に、名前あり＋信頼の画面・生成中 → ready | 前者は猶予の中で本文 1。後者は ready まで 0、その後 1。繰り越した信頼の Enter は 1 回 | 「名前が見えたら ready を待たない」「一度の画面で不適用」 |
| C8 | 未送信 → 確実な停止 → 新しい正しい世代を確認 | 本文 1。`launched` は新しい世代で | 「拒否を永久に残す」 |
| C9 | 一覧に名前あり＋登録に無い道具、状態の行の引用・古い scrollback・接頭辞の違う名前、画面に `error: <本文の印>` | 確認としない。本文 0。診断に本文の印が無い | 「200 行から名前を探す」「error 行をそのまま出す」 |
| C10 | 遅い確認（門の中で `confirmed`） | `launched` が元の起動の `requested` と同じ世代・fingerprint で 1 行。DB の書き込みを失敗させても本文の可否は変わらない | 「最新の設定で記録を作る」 |
| C11 | 未送信の拒否が応答に届く | send の応答に `roleRefusal`（`not-applied`／`not-confirmed`）と `sendOutcome: not_sent`、CLI の表示 | — |
| C12 | スイッチが無効（PR1 の既定）で、設定が `none` と `role` の両方（ロールなしで動いているセッションに後から `role` を設定した場合を含む） | 今と同じ（門の対象外。正の記録を作らない）。どちらも本文 1。常に拒否する実装・スイッチを無視する実装は落ちる | 「スイッチによらず門をかける」 |
| C13 | 動いている間に設定を別のロールに変える（正の記録あり） | 本文 1、「再起動待ち」の表示 | — |

（第 3 版の C3 は Z5・Z6 に、C6 は PR2 の P7 に移した）

### 8.4 PR2 の試験

| # | 種類 | 何を | 期待 | 直す前の実装で |
|---|---|---|---|---|
| P1 | 陽性 | 生成物の frontmatter | `tools` が 13 個とこの順で一致、`swarm` 無し、`subagent: false` | 落ちる |
| P2 | 陽性 | 定数の出典 | コメントに `1.5.8` と実機の記録のパス | 落ちる |
| P3 | 陽性 | `tools` の無い（1 個違う）定義の読み直し | `format-invalid` | 落ちる |
| P4 | 陽性 | 環境変数なしでロールつきの起動 | 起動行に `--agent <name>`。PR1 の門を通って確認の後に本文 1 回 | 落ちる |
| P5 | 陽性 | 新しいプロセス、一覧に名前が無い | ペイン・`beginAgentSession`・起動のキー 0、`artifact-failed` | 落ちる |
| P6 | 陽性 | 一覧が非 0・時間切れ・64 KiB 超 | 同じく 0。時間切れで子が止められる | 落ちる |
| P7 | 陽性 | 照合を保留 → 停止 → 照合が成功 | ペイン・起動行・旧い依頼の記録 0（`session-stopped`） | 落ちる |
| P8 | 陽性 | `CM_UAT_ISOLATION=1` | 子を起こさずに拒否 | 落ちる |
| P9 | 陽性 | 一覧に接頭辞の違う名前だけ | 通らない | 落ちる |
| P10 | 陽性 | `git grep -n 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED\|isAgentRoleAdapterEnabled' -- src locales docs/user-guide docs/en tests` | 0 件 | 落ちる |
| P11 | 陽性 | CLI が `adapterEnabled: false`（旧いサーバー）を受けた | 今と同じ警告 | 通る（残すことの固定） |
| P12 | 陽性 | スイッチが無い状態で Z1〜Z10 を再び | すべて本文 0（門の対象が設定だけになったこと） | — |
| N1 | 陰性 | ロールの設定が無いインスタンスの起動と send | 起動行・送信が今とバイト単位で同じ、門も一覧も呼ばない | 通る |
| N2 | 陰性 | Schedule（headless） | 一覧も門も呼ばない。引数は `-p … --dangerously-skip-permissions --agent <name>` | 通る |
| N3 | 陰性 | 他の 6 adapter の注入 fingerprint と生成物のバイト | 直す前と同じ値（試験に値を書く） | 通る |
| N4 | 陰性 | 動いているプロセス、一覧の依存は呼ばれたら throw | 再接続が成功、照合 0（送信の門は別に効く） | 通る |
| N5 | 陰性 | 既存のペインで tool が終わっている | 照合 1 回。失敗なら起動行 0 | — |
| N6 | 陰性 | API の `adapterEnabled` | 7 ツールとも `true` | Antigravity だけ落ちる |
| N7 | 陰性 | 子の環境 | cwd が worktree、`PATH`・`HOME` がペインの環境の値（あれば） | — |

番号は欠番なし（P1〜P12、N1〜N7、Z1〜Z10、C1・C2・C4・C5・C7〜C13。C3・C6 は上の注のとおり移した）。

### 8.5 古い動きを固定している試験（実装の契約で変更を許す）

- PR1: `tests/unit/session/role-launch-4115.test.ts:553`（`Command Code and a disabled-then-enabled Antigravity stay unknown: nothing confirms them`）。偽の画面に名前が無ければ今の期待（`launched` が null）のまま通る見込み。名前を出す画面に変えるなら Antigravity を別の `it` に分ける（名前の変更を許す）。他の既存の期待値は変えない
- PR2: `tests/unit/agent-roles/adapters-4115.test.ts:296`（`Antigravity is on only when someone says so`）→ 消して P4 に。`tests/unit/session/role-launch-4115.test.ts:433`（`adapter-disabled`）→ P4・P5 の形へ。`tests/unit/session/role-schedule-4115.test.ts:115`（`the disabled adapter refuses`）→ N2 へ。`tests/unit/app/api/worktrees/send-role-4115.test.ts:185`（`refuses a role on a disabled adapter, saving nothing`）→ 保存して通ることへ。`tests/integration/api-agent-roles-4114.test.ts:335`（`antigravity is settable but marked as not enabled`）→ N6 へ。`tests/integration/fixtures/agent-roles-api-examples.ts:124` → `true`。`tests/setup.ts:252` と `tests/unit/config/codex-home-isolation-4146.test.ts:152` → 対で消す。`tests/unit/components/roles/agent-roles-screen-4117.test.tsx`・`agent-roles-settings-4117.test.tsx` に注記を期待する行があれば `true` の形へ。`tests/unit/agent-roles/artifacts-4114.test.ts:417` は残す

## 9. 未決と人の判断（推奨つき）

| # | 決めること | 推奨 | 理由 |
|---|---|---|---|
| Q1 | 版の範囲（1.5.8）の外で起動を止めるか | **止めない** | exit 3 は agy 自身が止まり、門が本文を止める |
| Q2 | `adapterEnabled` と `adapter-disabled` を消すか | **残す** | 外のスクリプトと旧いサーバーに繋ぐ CLI を壊さない |
| Q3 | ロールごとに道具を絞るか | **この Issue ではしない** | `run_command` がある限り書き込みは本文頼み |
| Q4 | 置き場所を `~/.gemini/agents/` に移すか | **移さない** | 1.5.8 で出なければ D3 が毎回止める。PR2 の受入で確かめる |
| Q5 | 期限 | 一覧 10 秒、版 5 秒、猶予 60 秒 | 猶予は既存の `ANTIGRAVITY_STARTUP_PROMPT_WAIT_TIMEOUT_MS` |
| Q6 | `CM_UAT_ISOLATION=1` で照合を拒否するか | **拒否する**（`--log-file` が効くと確かめられたら外してよい） | 本物のホームにログが増える |
| Q7 | Auto-Yes の応答キーと `respond` を門に入れるか | **入れない**（決定） | 本文ではない |
| Q8 | サーバーの再起動の後、動いているロールつきのセッションを画面から確認し直して正の記録を作るか | **この Issue ではしない**（拒否して停止と起動し直しを求める） | 再起動の後は「どの起動の世代か」を知らない。画面の名前だけで正の記録を作ると、§0.1 の「今の生きている世代について」を満たす根拠が無い。運用の負担（再起動のたびに起動し直す）が大きければ別の Issue で設計する |
| Q9 | 不適用のときに自動で止めるか | **止めない**（決定、リーダーの処分） | 世代つきの kill の排他を新しく作る必要があり、R2 の穴になった |
| Q10 | PR を分けるか | **2 本**（§7） | 規模と送信の経路の分離 |

## 10. 実装の範囲（契約にできる粒度）

**難度:** 難（送信の門・起動の経路・利用者のホームへの書き込み）。担当は opus、事前レビューは Codex。PR1 の後に PR2。

### PR1 送信の門・正の記録・起動後の確認

- 変えるファイル（scope.allow の候補）:
  - `src/lib/agent-roles/antigravity.ts`（新規。状態の行の判定・明確な不適用の分類・診断の文面の純関数）
  - `src/lib/session/role-launch.ts`（門の対象の判定の 3 値の関数、`application` と状態の版、`openGeneration` の記録の値、`settleLaunchRole` の Antigravity、遅い確認の記録、境界の確認の関数）
  - `src/lib/cli-tools/antigravity.ts`（門と猶予、`beforeBody` を渡す）
  - `src/lib/cli-tools/submit-verified-sender.ts`（`beforeBody` を 2 か所で呼ぶ）
  - `src/lib/cli-tools/submit-verified-sender-shared.ts`（`SubmitVerifiedSendParams` に `beforeBody` を足す。型を二重に定義しない）
  - `src/lib/agent-roles/launch-errors.ts`（`not-confirmed`）
- 試験: `tests/unit/session/role-launch-4115.test.ts`、`tests/unit/cli-tools/antigravity*.test.ts`（`antigravity-late-trust-3757.test.ts` を含む）、`tests/unit/cli-tools/submit-verified-sender*.test.ts`、新しい試験ファイル（Z1〜Z10・C1〜C13。`tests/unit/session/` か `tests/unit/cli-tools/` の下）、send の未送信の応答と停止 API を通す既存の試験（`tests/unit/app/api/worktrees/**`）、`tests/unit/docs/**`
- 受入:
  1. Z1〜Z10 がすべて本文 0・本文の Enter 0・未送信の理由あり・自動の Ctrl-D と kill 0。§8.2 の 3 つの変異でそれぞれ赤
  2. C1・C2・C4・C5・C7〜C13 が合格し、各変異で赤
  3. 正の記録があり ready なら本文 1（C7・C8・C10・C13）。常に拒否する実装では落ちる
  4. スイッチが無効（既定）のとき、ロールの設定の有無にかかわらず今と同じ（C12 で `role`／`none` × 無効を展開する。有効の側は Z・C の各行。N1・N3 を PR1 でも走らせる）。PR1 で有効化済みの利用者に拒否が始まることと、サーバーの再起動の後に起動し直しが要ることは、§1 の影響の表のとおり「無影響」とは扱わず、PR1 の説明と CHANGELOG にも残す
  5. 自動の Ctrl-D・kill を足していない（`git diff` で `killSession`・`requestExit` の新しい呼び出し 0）
  6. 既存の試験の期待値は §8.5 の PR1 の 1 件の扱いを除いて変えない
- 規模（見立て）: src 6・試験 5〜7 本、数百行
- gates: `npx vitest run tests/unit/session/role-launch-4115.test.ts tests/unit/cli-tools tests/unit/app/api/worktrees tests/unit/guards tests/unit/docs`、`npm run lint`、`npx tsc --noEmit`

### PR2 有効化（PR1 が develop に入った後の実装を基準に書き直す）

- 変えるファイル: `src/lib/agent-roles/antigravity.ts`（定数・一覧の照合）、`src/lib/agent-roles/artifacts.ts`、`src/lib/agent-roles/adapters.ts`、`src/lib/agent-roles/launch-errors.ts`（`adapter-disabled` のコメント）、`src/lib/agent-roles/management.ts`、`src/lib/agent-roles/pane-env.ts`（読むだけで足りなければ）、`src/types/agent-roles.ts`、`src/lib/session/role-launch.ts`（`:293` と門の対象のスイッチを消す、照合の関数）、`src/lib/cli-tools/antigravity.ts`（照合の呼び出し）、`src/app/api/worktrees/[id]/send/send-role.ts`、画面 4 本と辞書 2 本（D4）、文書 5 本（D4）
- 試験: `tests/unit/agent-roles/**`、`tests/unit/cli-tools/antigravity*.test.ts`、`tests/unit/session/role-launch-4115.test.ts`、`tests/unit/session/role-schedule-4115.test.ts`、`tests/unit/app/api/worktrees/send-role-4115.test.ts`、`tests/unit/config/codex-home-isolation-4146.test.ts`、`tests/unit/components/roles/agent-roles-*.test.tsx`、`tests/unit/cli/utils/agent-roles-4116.test.ts`、`tests/setup.ts`、`tests/integration/api-agent-roles-4114.test.ts`、`tests/integration/fixtures/agent-roles-api-examples.ts`、`tests/unit/docs/**`
- CLI の `src/cli/commands/roles.ts`・`instances.ts` は変えない
- 受入:
  1. P1〜P12・N1〜N7 が合格。P10 の grep が 0 件
  2. 一時ホーム（`os.tmpdir()` の下、`HOME` を差し替え）で agy 1.5.8 の `agy agent` が `~/.gemini/config/agents/<dir>/agent.md` を一覧に出すこと、`--log-file` が `agy agent` のログを動かすかを 1 回ずつ確かめ、出力をコミットメッセージの本文に書く（認証は要らない。本物の `~/.gemini` には書かない）。出なければ止めて PM に返す
  3. CHANGELOG の断片（`changelog.d/4385.md` に統合、1 項目・1 行）に挙動の変更: Antigravity でロールが既定で有効、`~/.gemini/config/agents/` に定義を書く、確かめた agy の版 1.5.8、起動前の一覧の照合、ロールを確かめた記録があるときだけ本文を送り、無ければ未送信で理由を出す（プロセスは残る。サーバーの再起動の後も起動し直しが要る）、CLI の警告は旧いサーバーのときだけ
  4. （マージの後、PM）信頼済みの worktree の TUI で、ロールつきの起動でロールの本文が守られ、編集・実行ができ、適用状態が「適用済み」になる。存在しない名前の定義では起動が理由つきで止まり、別の名前・未適用では本文が未送信になって理由が見え、プロセスは残る。**信頼の後の状態の行に名前があること**（D2 の見立て）と、**サーバーの再起動の後に未送信になること**をここで確かめる
- 規模（見立て）: src 約 15・試験 約 15・文書 約 6
- gates: 契約の検証は `npm run test:unit`（`tests/setup.ts` に触るため。手元では上の試験の対象と `tests/unit/guards tests/unit/docs` だけ）、integration の `tests/integration/api-agent-roles-4114.test.ts`、`npm run lint`、`npx tsc --noEmit`、`npm run build`、e2e の `tests/e2e/agent-roles-4117.spec.ts`

## 11. 本文に無い指摘（この設計の範囲の外）

- `antigravity.ts:427` の `waitForReady` は時間切れで throw しない。ロールの無い起動でも、シェルに戻ったペインを起動できたと扱いうる（ロールの無い経路は変えない）
- 確認前の Antigravity のプロンプトに Auto-Yes が答えうる（Q7）
- 人の停止（kill-session API）は kill が失敗しても証拠と起動中を解除する（`kill-session/route.ts:198`）。この Issue では門が拒否に倒れるだけで、停止の側は直さない
- `moveLaunchRoleEvidence`（`role-launch.ts:827`）は証拠と epoch を移す。正の記録は証拠の項目なので一緒に移る（見立て。実装で確かめる）

## 12. 改訂の内容（事前レビューと原因調査への対応）

| 指摘 | 版 | 反映した場所 |
|---|---|---|
| P2-1 取得不明から本文へ | 2・4 | D2 の状態と門。第 4 版で正の記録の存在に反転 |
| P2-2 遅い正常な起動を止める | 2 | D2 の猶予、C7 |
| P2-3 照合の置き場所 | 2 | D3、N4・N5 |
| P2-4 await の後の旧い世代 | 2・3 | D6（第 3 版で kill の部分を外した） |
| P3-1〜3 画面と診断・子の隔離・互換 | 2 | D2 の判定と診断、D3 の子、D4 |
| R1 不適用の証拠を消すと門が外れる | 3・4 | 第 3 版は拒否の表で手当て。第 4 版で反転し、拒否の表は消した（D7） |
| R2 ロックの中の照合の後に kill の内側で失効 | 3 | 自動の kill を外した（D2、I4、Q9） |
| R3 固定の拒否になる前の忘却で対象外に（同じ種類の 3 回目） | 4 | §0.1・§0.2、門の対象を永続の設定で決める（D2）、Z5・Z7・Z8 と必須の変異 |
| 再レビュー 3 §6: 2 本に分ける | 4 | §7（「分けたこと自体を受入の根拠にしない」も） |
| 同: `SubmitVerifiedSendParams` の定義元を scope に | 4 | D2 の門の置き場所、§10 PR1 |
| 同: 拒否の解除の時点を 1 つの表現に | 4 | D7 の 3（新しい世代の確認で正の記録ができたとき） |
| 同: PR1 の影響の記述 | 4 | §1 の影響の表、§7 |
| 同: 試験の番号の欠番 | 4 | §8 を振り直した（P1〜P12、N1〜N7、Z1〜Z10、C の移動の注） |
| 再起動の例外 E1 | 3・4 | 第 3 版で例外として明記、第 4 版で無くなった（代償は §1 の影響の表と Q8） |
| R4 対象外（`none`）の判定が本文の前の設定の変更を越えて残る | 5 | D2 の門の対象の判定・門の置き場所 3・設定の変更と門、§5.2、§6、Z8 と必須の変異（リーダーの処分: 本文の直前で同期に読み直し、変わっていれば未送信で次の send へ） |
| 再レビュー 4 §6 の P3: 対象の表現・C12 の展開・PR1 の影響 | 5 | D2 の門の対象の判定（`enabled && (role \|\| unreadable)`）、C12、§10 PR1 の受入 4 |

## 13. この設計で確かめたこと

- `agy --version` → `1.5.8`、exit 0
- `agy --help` → `--agent` は「Agent for the current CLI session」。サブコマンド `agent`・`agents` は「List available agents」。全体の引数に `--log-file`。出力の形式を選ぶ引数は無い
- `agy help agent` と `agy agent --help` → `Usage: agy agent [flags]`、フラグは `-h` / `--help` だけ
- `agy changelog`（同梱）: 1.1.1 で `--agent` と `agent/agents`、1.1.5 で `subagent: false`、1.1.6 で Markdown の custom agent、1.2.1 で `excludeDefaultComponents`、1.2.7 で `find_by_name` 等は `tools` に書けば使える。`tools` に書ける名前の一覧や未知の名前の扱いの項は見つからなかった
- `~/.gemini/config/agents`・`~/.gemini/agents` は今は無い
- 第 3・4 版で読んだ実コード: `instance-input-lock.ts:795`・`:825`、`submit-verified-sender.ts:269`・`:779`、`submit-verified-sender-shared.ts:112`、`kill-session/route.ts:151`・`:198`、`send-user-message.ts:654`・`:677`、`send-failure.ts:82`、`role-launch.ts:157`（`launchRoleDatabase`）・`:769`（`settingsGiveRole`）

## 改訂の履歴

- 2026-11-14 第 2 版: 1 回目の事前レビュー（P2 4・P3 3）を反映。適用の 4 状態と送信の門、D3 を新しいプロセスの分岐へ、D6、診断と子の範囲、CLI の警告を残す
- 2026-11-14 第 3 版: 再レビュー（R1・R2）と原因調査の推奨 A を採用。自動の kill を外す、拒否の寿命、境界の同期の確認、記録と許可の分離、保証の境界 E1、受入の言い換え、試験の C1〜C11、PR を 2 本に
- 2026-11-14 第 5 版: PR1 の実装の契約。再レビュー 4 の R4 をリーダーの処分で反映（`none` の送信も本文の直前で設定を読み直す。Z8 の割込みと変異）、P3 の補足（対象の表現の統一、C12 の展開、PR1 の影響）、起動の中の確認を driver の `launchSession` の最後で行う実装の注
- 2026-11-14 第 4 版: 再レビュー 3（R3、同じ種類の 3 回目）にリーダーの処分で対応。送信の判定を正の記録の存在へ反転し（§0.1）、門の対象を永続の設定で決める。拒否の表と E1 を消し、影響の表・PR1 の影響・`SubmitVerifiedSendParams` の定義元・解除の時点の 1 表現・試験の Z1〜Z10 と変異・番号の振り直し（§12）
