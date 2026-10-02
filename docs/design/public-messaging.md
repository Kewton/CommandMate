# 公開面の事実と、言わないこと（Public Messaging）

公開面（LP `website/` ・ README ・ concept ・ チュートリアル ・ product-highlights ・ デモ動画）を書くときの
**参考資料**。ここにあるのは、どの面で書いても **実装や実測とずれてはいけない事実** と、**書かないこと** だけである。

- **文言の単一ソースではない**。各面はこのファイルから文をコピーしなくてよく、面ごとの役割に合わせて自由に書いてよい
- 数字 ・ 数え方 ・ exit code ・ 通信の範囲を書くときは、ここと（ここが指す実装と）食い違わないこと
- 実装や実測が変わったら、公開面より先にこのファイルを直す
- 概念の正本（Vision / Mission / 中核原則 / 実装）は [docs/concept.md](../concept.md) ・
  [docs/en/concept.md](../en/concept.md)

> **経緯**: Issue #1808 で「各面はこのファイルから文言を逐語でコピーし、テストで一致を固定する」運用を決めたが、
> 軸を変えるたびに元文書 → README en / ja → LP → テストを全部書き換えることになり（2026-09 だけで 4 回）、
> LP と README が面ごとの役割を持てなくなった。Issue #3057（2026-10-02 に利用者が決定）でこの運用を撤廃し、
> 文言表を外して事実と禁止事項の一覧に縮めた。旧版の文言表は git の履歴で辿れる。

テストが見ているのは文言ではなく「壊れていないか」「嘘を書いていないか」である。

| テスト | 見ていること |
|---|---|
| [`tests/unit/docs/public-messaging.test.ts`](../../tests/unit/docs/public-messaging.test.ts) | §8 の禁止語表とテスト側の配列の一致、§3 の exit code と §2 の CLI id が実装とずれないこと、concept ・ README に禁止語が無いこと |
| [`tests/unit/website/landing-page.test.ts`](../../tests/unit/website/landing-page.test.ts) | `website/**` に §8 の禁止語 ・ §5 の言えない主張 ・ §6 の撤回した通信表現が無いこと、LP の通信の列挙が §6 の根拠表と同じ数であること |
| [`tests/unit/docs/opencode-v2-public-docs-2976.test.ts`](../../tests/unit/docs/opencode-v2-public-docs-2976.test.ts) | 公開面が対応エージェントを 8 より多く数えないこと（§2） |

---

## 1. 数字とその出典

公開面に書いてよい数字は、出典のあるものだけである。**ここに無い数字を足さない**（§5「未計測の数字」）。

### 実測した run（as observed）

| Run | Lead | Workers | 結果 | 出典 |
|---|---|---|---|---|
| 4 Issue、1 通 | Claude Code | Claude Code × 4 | ゲート 4/4 合格、2 wave、PR マージ、UAT go、8 分 39 秒 | #2494 の CHANGELOG エントリ（収録記録との突合） |
| 4 Issue、1 通 | Command Code | Command Code × 4 | ゲート 4/4 合格、7 分 46 秒。そのあと人が develop を pull して 47/47 テスト | 同上 |
| 1 Issue、レビュー 1 段つき | Command Code | Codex が実装、Claude Code がテスト、Antigravity がレビュー | レビュー REJECT → 修正 → APPROVE、RESULT passed | 同上 |

- 表を載せるときは、表の直下に `as observed`（ja: `as observed（実測した範囲）`）を添える。表だけを切り出して使わない
- lead としての実測は Claude Code と Command Code の 2 つ、worker としての実測は Codex ・ Claude Code ・ Antigravity ・ Command Code の 4 つ（§5）

### そのほかの数字

| 数字 | 値 | 出典 |
|---|---|---|
| 対応エージェント | 8 種 | §2 の数え方 |
| Auto Yes の有効時間 | 1 ・ 3 ・ 8 時間から選ぶ（既定 1 時間）。時間切れか停止パターンの一致で自動で無効になる | `src/config/auto-yes-config.ts` の `ALLOWED_DURATIONS` ・ `DEFAULT_AUTO_YES_DURATION`、`src/lib/auto-yes-state.ts` の `disableAutoYes`（理由 `expired` / `stop_pattern_matched`） |
| 公式 Catalog の Skill | 15 件（2026-09-16 時点） | `gh api repos/Kewton/commandmate-skills/contents/skills`、`commandmate skill list`。増減するので、見出しに件数を書かない |
| 対応 OS | macOS ・ Linux ・ Windows（WSL2）。ネイティブ Windows は非対応 | CommandMate は tmux に依存する |
| ライセンス | MIT | `LICENSE` |

### 作者の数字（LP ・ README の hero、Issue #3060）

表記はこのとおりに書く。作者個人の実績で、製品の性能の主張ではない。

| 表記 | 出典 |
|---|---|
| 10+ PRs a day, solo | 作者の申告（2026-10-02）。根拠: 2026-09 のマージ PR は全リポジトリで 689 本 |
| $110–$210 a month: Claude Max + Command Code Goat | 作者の実費（Claude Max $100 か $200、Command Code Goat $10） |
| ~80% of my instructions sent from a phone (my estimate) | 作者の感覚値。必ず「estimate」と書く |
| 689 PRs merged in September 2026, across my repositories | GitHub search `author:Kewton is:pr is:merged merged:2026-09-01..2026-09-30` |

---

## 2. 対応エージェントの数え方

公開面での対応エージェントは **8 種** と数える。

- 数えるのは `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS`（claude / codex / gemini / vibe-local / opencode / copilot /
  antigravity / command-code / opencode-v2 の 9 件）。ローカルモデル（`vibe-local`）はその 1 つとして数える
- **v1 と v2 は 1 種と数える**: OpenCode の v1（`opencode`）と v2（`opencode-v2`）は同じ OpenCode の版なので、
  `CLI_TOOL_IDS` は 9 件でも公開面は 8 のまま（Issue #2976 の決定・案 A）
- 版を書き分けるときは「OpenCode（1.x と V2）」/「OpenCode (1.x and V2)」と書く
- 版ごとに数えて 8 を超える数を書かない。「8 + ローカルモデル」「8 種のエージェント CLI とローカルモデル」とは書かない
- 「8 種のどれでも worker になれる」は**対応の主張**である。worker として実測したのは §1 の 4 つ

---

## 3. exit code

`commandmate verify` ・ `commandmate wait --verify` の判定。値は `src/cli/types/index.ts` の `VerifyExitCode`。

| 値 | 名前 | 意味 |
|---|---|---|
| 0 | `SUCCESS` | すべてのゲートが通った |
| 20 | `VERIFY_FAILED` | ゲートが落ちた |
| 21 | `NOT_STARTED` | 作業の証跡がまったく無い（commit も未 commit の変更も無い） |

組み込みゲートは work-evidence（commit か未 commit の変更を要求する）と scope（変更したファイルを契約と突き合わせる）の 2 つで、
どの契約でも必ず走る（`src/lib/verification/gate-runner.ts` ・ `src/lib/verification/scope-gate.ts`）。人の承認はゲートではない。

---

## 4. 実装との突合（機能が在ることの根拠）

公開面が機能の名前を出すときの根拠。**ここに無い機能は書かない**。

| 主張 | 実装 | 根拠 |
|---|---|---|
| exit 0 / 20 / 21 | `VerifyExitCode`（SUCCESS 0 / VERIFY_FAILED 20 / NOT_STARTED 21） | `src/cli/types/index.ts` の `VerifyExitCode` |
| 契約で宣言する | `.commandmate/tasks/<name>.yaml` と `commandmate send --contract <path>` | `src/lib/tasks/contract-parser.ts` の `TASK_CONTRACT_DIR` ・ `src/cli/commands/send.ts` の `--contract` |
| scope ゲートで強制する | scope ゲート実装 | `src/lib/verification/scope-gate.ts` ・ `src/lib/verification/gate-runner.ts` |
| Catalog から Skill を導入する | `commandmate skill list` / `install` / `update` | `src/cli/commands/skill.ts` ・ [docs/user-guide/skills.md](../user-guide/skills.md) |
| `cmate-task-contract` / `cmate-verify` は実在する | 公式 Catalog `Kewton/commandmate-skills` の skill ディレクトリ | Catalog リポジトリの `skills/` 直下に両 ID が存在 |
| commit / ゲートログ | work-evidence ゲート（commit も未 commit の変更も証跡として数える） | `VerifyExitCode.NOT_STARTED` の説明（"no commits and no uncommitted changes"） |
| `verify history` | `commandmate verify history` サブコマンド | `src/cli/commands/verify.ts` |
| `report metrics` | `commandmate report metrics` サブコマンド | `src/cli/commands/report.ts` |
| worktree 1 つと契約 1 つ | worktree ごとの独立セッション + 契約ファイル | `src/lib/session/` ・ `.commandmate/tasks/` |
| 入力待ちが届く（バッジ / トースト / タブタイトル / 通知） | App Badge ・ Toast ・ `document.title` ・ Web Push | `src/hooks/useAttentionBadge.ts` ・ `src/lib/pwa/attention-badge.ts` ・ `src/components/common/Toast.tsx` ・ `src/lib/push/waiting-push-notifier.ts` |
| 8 種のエージェント | `CLI_TOOL_IDS`（9 件。opencode と opencode-v2 を 1 種と数える。§2） | `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS` |
| `wait --verify` | `commandmate wait --verify` オプション | `src/cli/commands/wait.ts` |
| plan → dispatch → merge → uat | 4 つの runner が別々の起動で動き、どれも次の phase を勝手に始めない。mutation は `--approve` を付けた起動だけ | `cmate-orchestrate` Skill の `SKILL.md` |
| 別のエージェントへレビューに出す | `commandmate ask`、`cmate-delegate` Skill | `src/cli/commands/ask.ts` ・ 公式 Catalog の `cmate-delegate` |

---

## 5. 言えること / 言えないこと（実測の範囲）

公開面に書いてよい主張の**上限**。§4 が「機能が在ること」の根拠表であるのに対し、
この節は「**どこまで実測したか**」の範囲表である。ここに無い強さの主張は書かない（Issue #2493）。

### 言えること（実測がある）

| 主張 | 実測の内容 |
|---|---|
| lead として動かせる | Claude Code と Command Code で実測（4 Issue → 4/4 完了、8m39s / 7m46s） |
| worker として動かせる | Codex ・ Claude Code ・ Antigravity ・ Command Code で実測 |
| 別 CLI のレビューが効いた | 別 CLI のレビューで REJECT → 修正 → APPROVE まで到達した |
| plan は破壊しない | plan は dry-run。mutation は `--approve` を付けた invocation だけ |
| ゲート不合格で止まる | gate が不合格ならそこでランが停止する |
| 修正ループは有限 | 修正ループに上限がある |

### 言えないこと（未計測 / 事実に反する）

`website/**` は、この表の backtick で囲った表現を含まないことをテストで見ている（`loop` と `the only …` は
LP に「The loop」節があり、後者は形であって文字列ではないため、部分一致の走査からは外している）。

| 書かない表現 | 理由 |
|---|---|
| `your orchestrator` | 「orchestrator」を製品の名詞にしない。動詞・形容（orchestrated）で使う |
| `runs 24/7` | 常駐ではなく、承認つきで 1 回通すランである |
| `self-managing backlog` | backlog を自律管理する機能は無い |
| `loop` | 永久に回り続けるものは無い（§7 の 1 行目） |
| `orchestrate with any agent as the lead` | lead としての実測は Claude Code / Command Code の 2 つだけ |
| `review by a fresh agent is built in` | cross-model review はランナーの外。利用者が足すステップである（§7 の 3 行目） |
| `the only …` | 唯一性を検証していない |
| `no supervision` | 承認は人のところに来る（§7 の 4 行目） |
| モデルの安さ・賢さの序列 | 計測していない。公開面でモデルに順位を付けない |
| 未計測の数字 | 実測のない数値は書かない |

---

## 6. 通信の範囲

「どこへ何が出ていくか」を公開面が言うときの事実。README の `## Security` 節、LP の「Runs on your machine」、
FAQ の「コードはどこへ行くのか」は、どう書くにしてもこの範囲を超えない・欠かさない。

Issue #2549 で、README（en / ja）と LP にあった
"Runs 100% locally. No external server, no cloud relay, no account required. The only network traffic is the agent CLI's own API calls."
を撤回した。Web Push を有効にすれば push サービスを、`commandmate remote` を使えば
Tailscale か Cloudflare を通り、Web UI の更新確認と Skills Catalog は GitHub へ出るので、元の文は成立しない。

書き分けの規則:

- **本体の性質**（テレメトリ無し ・ アカウント不要 ・ 動かすのに外部サーバ不要）と、**機能ごとの通信**を分けて書く。
  前者を「外部と通信しない」「外部サーバ無し」に広げない
- 機能ごとの通信は、**いつ起きるか**（使っている間 ・ 有効にしたとき ・ 動かしている間）を添えて列挙する。
  列挙から 1 つでも落とすなら、下の根拠表で「その通信が無くなった」ことを確かめてからにする
  （LP の列挙の数は、テストがこの表の行数と突き合わせている）

### 機能ごとの通信（根拠）

| 通信 | いつ | 行き先 | 根拠 |
|---|---|---|---|
| エージェント CLI 自身の API 呼び出し | エージェントを動かしている間 | 各 CLI の提供元（ローカルモデルなら自分でホストしている先） | CommandMate は CLI を tmux のセッションで起動するだけで、CLI の API 通信を中継しない |
| 新しいリリースの確認 | Web UI が版情報を取りに行くとき（サーバ側で 1 時間キャッシュ） | GitHub Releases API。送るのは `User-Agent: CommandMate/<version>` つきの GET 1 本 | `src/lib/version-checker.ts` の `GITHUB_API_URL` ・ `src/hooks/useUpdateCheck.ts` |
| 公式 Skills Catalog | Skill を一覧 ・ 導入 ・ 更新するとき | `raw.githubusercontent.com` の `Kewton/commandmate-skills` | `src/config/skill-catalog-config.ts` ・ `src/lib/skills/catalog-client.ts` |
| Web Push | VAPID 鍵を作り、ブラウザが通知を購読したとき | ブラウザの push サービス | `src/lib/push/push-sender.ts`（`web-push`） |
| `commandmate remote` | `remote` を動かしている間 | Tailscale（tailnet 内）または cloudflared（Cloudflare Quick Tunnel） | `src/lib/remote/tailscale.ts` ・ `src/lib/remote/cloudflare.ts` ・ `src/lib/remote/provider-registry.ts` |

> **公開文に列挙しないもの**: 利用者が行き先を名指しして起動する操作 —— git の clone / fetch / push
> （行き先は利用者自身の remote）、`commandmate update` の npm registry、`commandmate issue` の `gh`。
> 操作そのものが通信なので「動かすのに外部サーバは要らない」とは矛盾しない。
> ここに入らない通信を足す機能ができたら、この表を直す。

### 書かない表現

| 書かない表現 | 理由 |
|---|---|
| `The only network traffic is the agent CLI's own API calls` | 撤回した（#2549）。Web Push ・ `remote` ・ 更新確認 ・ Skills Catalog の通信を含めると成立しない |
| `100% locally` ・ `100% ローカル` | 同上。`remote` を使えば接続は tunnel を通る |
| `No external server`（無条件） | 機能ごとの通信を消してしまう。「動かすのに外部サーバは要らない」と書く |
| `no cloud relay` ・ `クラウド中継なし` | `commandmate remote` の cloudflared は Cloudflare を中継に使う |

---

## 7. やらないこと

公開面で、これを超える約束をしない。

1. 常駐エージェントではなく、1 回のランである。永久に回り続けるものは無く、明示的な承認（`--approve`）なしに何かが書き換わることも無い
2. コードを代わりに読んではくれない。ゲートが捕まえるのは、利用者のテストとチェックが捕まえる範囲だけである
3. 別のエージェントによるレビューは、利用者が足す 1 ステップであって、ランナーが代わりにやってくれるものではない
4. 承認はいまも人のところに来る。Auto Yes は opt-in で、時間の上限つきで、指定したパターンで止まる
5. tmux ・ Git worktree ・ ターミナル ・ エージェント CLI を置き換えるものではない。OS を再起動すればプロセスは終わる。残るのは記録である

---

## 8. 禁止語

公開面に書かない語。**競合製品名**だけを置く（計測していない主張は §5、撤回した通信表現は §6）。
新しい文章に他社製品名を書かない（Epic #1807 D4）。比較するなら製品ではなく **やり方** と比べる。

**この表がテスト側の配列と一致していること**を `tests/unit/docs/public-messaging.test.ts` で固定している
（片方だけ更新されるのを防ぐ）。走査の対象は 2 系統ある。`tests/unit/docs/public-messaging.test.ts` が
`docs/concept.md` ・ `docs/en/concept.md` ・ `README.md` ・ `docs/ja/README.md` を、
`tests/unit/website/landing-page.test.ts` がこの表と自分の `LP_BANNED_TERMS` の和集合で `website/**` を走査する。
競合名をこの表に足すときは、同じ PR で `LP_BANNED_TERMS` にも足す（テストが両方向で突き合わせる）。

<!-- banned-terms:start -->

| 禁止語 | 理由 |
|---|---|
| `Remote Control` | 競合製品名 |
| `Happy Coder` | 同上 |
| `claude-squad` | 同上 |
| `Omnara` | 同上 |
| `Orca` | 同上（Epic #2548 の競合調査で追加） |
| `Herdr` | 同上（Epic #2548 の競合調査で追加） |
| `Lanes` | 同上（Epic #2548 の競合調査で追加） |

<!-- banned-terms:end -->

> **走査は大文字小文字を無視した部分一致**である。たとえば `Lanes` は `planes` ・ `swimlanes` にも当たる。
> 新しい文章でこれらの語が必要になったら、語を言い換える（禁止語の行は緩めない）。
>
> Issue #3057 で、旧軸の語（`control plane` ・ `control layer` ・ `Vibe Coder` ・ 旧 LP の H1 など）を禁止語から外した。
> 軸の言葉の選び方は各面に任せ、ここでは事実と競合名だけを縛る。

---

## 9. 出典 — "vibe engineering"

公開面で "Vibe Engineering" を使うときは、既出語を自社造語のように見せないため出典を添える。

| 項目 | 内容 |
|---|---|
| 出典 | Simon Willison, "Vibe engineering", 2025-10-07, https://simonwillison.net/2025/Oct/7/vibe-engineering/ |
| 確認状況 | 確認済み（2026-08-18 に本文を取得） |
| 原文の定義 | "the other end of the spectrum, where seasoned professionals accelerate their work with LLMs while staying proudly and confidently accountable for the software they produce" |
| 原文のトーン | 著者自身が "with my tongue only partially in my cheek" と書いており、半ば冗談として提案された語である |
| CommandMate の用法との差 | 原文の主語は "seasoned professionals" で、規律は**人が持っている**ことが前提。CommandMate はその規律を**仕組み側に置く**ので、主語が「専門知識を持たない人」まで広がる |
| 脚注の例（en） | The term "vibe engineering" was coined by Simon Willison (2025). |
| 脚注の例（ja） | "vibe engineering" は Simon Willison 氏が 2025 年に提唱した語です。 |
