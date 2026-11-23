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
| 4 Issue、PM → 開発リーダー → ワーカーの 3 層（2026-10-02） | PM・開発リーダーとも Claude Code | Command Code × 4 | スマホ幅の Web UI からメッセージ 2 通＋タップ 3 回、依頼から報告まで 9 分 48 秒、検証 4/4 合格、PR は CI 緑でマージ、UAT 4/4 GO。リポジトリは公開の使い捨て `Kewton/commandmate-team-demo` | [#3058 のコメント](https://github.com/Kewton/CommandMate/issues/3058#issuecomment-5945597304) |

- 表を載せるときは、表の直下に `as observed`（ja: `as observed（実測した範囲）`）を添える。表だけを切り出して使わない
- lead としての実測は Claude Code と Command Code の 2 つ、worker としての実測は Codex ・ Claude Code ・ Antigravity ・ Command Code の 4 つ（§5）

### そのほかの数字

| 数字 | 値 | 出典 |
|---|---|---|
| 対応エージェント | 8 種 | §2 の数え方 |
| Auto Yes の有効時間 | 1〜24 時間から 1 時間刻みで選ぶ（1 ・ 3 ・ 8 時間はボタン、既定 1 時間）。時間切れか停止パターンの一致で自動で無効になる | `src/config/auto-yes-duration.ts` の `AUTO_YES_DURATIONS` ・ `PRESET_AUTO_YES_DURATIONS` ・ `DEFAULT_AUTO_YES_DURATION`、`src/lib/auto-yes-state.ts` の `disableAutoYes`（理由 `expired` / `stop_pattern_matched`） |
| 公式 Catalog の Skill | 15 件（2026-09-16 時点） | `gh api repos/Kewton/commandmate-skills/contents/skills`、`commandmate skill list`。増減するので、見出しに件数を書かない |
| 対応 OS | macOS ・ Linux ・ Windows（WSL2）。ネイティブ Windows は非対応 | CommandMate は tmux に依存する |
| ライセンス | MIT | `LICENSE` |

### hero の数字は実測 run（LP ・ README ・ llms.txt、Issue #3162）

LP ・ README（en / ja）・ `website/llms.txt` の hero に置く数字は、上の表の **3 層 run の行**から採る。
表記はこのとおりに書き、3 つの面で同じものを使う（`tests/unit/website/landing-page.test.ts` が LP ・ README ・
llms.txt の一致を見ている）。

| en | ja | 上の表のどこから |
|---|---|---|
| 4 issues, 4 workers (Command Code), PM and dev lead on Claude Code | 4 Issue、ワーカー 4 つ（Command Code）、PM と開発リーダーは Claude Code | Run ・ Lead ・ Workers の列 |
| 2 messages and 3 taps from a phone-width web UI | スマホ幅の Web UI からメッセージ 2 通＋タップ 3 回 | 結果の列 |
| 4/4 checks passed, PRs merged with CI green, UAT 4/4 GO | 検証 4/4 合格、PR は CI 緑でマージ、UAT 4/4 GO | 結果の列 |
| 9 min 48 s from request to report | 依頼から報告まで 9 分 48 秒 | 結果の列 |

- 直下に必ず注記を添える。en: `As observed: one run, recorded on 2026-10-02. Not a benchmark.` /
  ja: `as observed（実測した範囲）: 2026-10-02 に記録した 1 回の run。ベンチマークではない。`
- 「1 request」「1 通で」とは書かない。記録はメッセージ 2 通＋タップ 3 回である
- 記録はスマホ幅の Web UI での操作なので、「スマホ幅の Web UI から」と書く（実機のスマホとは書かない）
- 1 回の run なので、速さの主張（always ・ every time ・ under 10 minutes など）に広げない

### 作者の数字（hero には置かない）

作者個人の実績で、製品の性能の主張ではない。Issue #3060 で hero に置いたが、作者の活動量の印象が強く
製品の能力を示さないため、Issue #3162 で hero から外した。

- 置いてよい場所は、LP の Level 3（月額だけ。PM と worker でプランを分けたチーム編成の証拠として、作者の実費と書く）と、
  作者の名前で書く面（作者の投稿 ・ 作者の節）に限る。どこに置くときも作者の数字だと分かるように書く
- 表記はこのとおりに書く。phone の割合は感覚値なので、置くなら必ず「estimate」と書く

| 表記 | 出典 |
|---|---|
| 10+ PRs a day, solo | 作者の申告（2026-10-02）。根拠: 2026-09 のマージ PR は全リポジトリで 689 本 |
| $110–$210 a month: Claude Max + Command Code Goat | 作者の実費（Claude Max $100 か $200、Command Code Goat $10） |
| ~80% of my instructions sent from a phone (my estimate) | 作者の感覚値。必ず「estimate」と書く |
| 689 PRs merged in September 2026, across my repositories | GitHub search `author:Kewton is:pr is:merged merged:2026-09-01..2026-09-30` |

### リポジトリ規模と Milestone 実測（as observed）

CommandMate 本体のリポジトリを CommandMate 自身で開発したときの規模と運用の記録（Issue #4568）。製品の性能の主張ではない。
上の表や hero の数字とは別物で、hero には置かない。数字ごとに **測った版・日付が違う**ので、版や日付と切り離して書かない。

| 数字 | 値 | 測った対象 | 出典 |
|---|---|---|---|
| `src/` の TypeScript / TSX | 1,788 ファイル ・ 468,652 行 | `v0.55.0` タグ（commit `337be86e5`）。空行・コメントも数えた物理行。develop の作業ツリーの値ではない | `v0.55.0` タグに対する `git ls-tree` ・ `git show` ・ `wc -l`（コマンドは表の下） |
| テスト | 3,223 ファイル ・ 59,177 試験 | `v0.54.0` の #4488 の変更前に測った数（#4488 のガードを足した後は +1 ファイル ・ +2 試験）。`tests/unit` + `tests/integration` を `workspace/` の無い状態で `vitest list` した数。`v0.55.0` の数ではなく、E2E（Playwright）は含まない | `CHANGELOG.md` の `## [0.54.0]` にある #4488 の項 |
| PR の CI | Lint（ESLint と `shellcheck` の `lint:sh`）・ Type Check ・ Unit Tests（4 shard）・ Integration Tests ・ E2E Tests（Playwright、2 shard）・ Build ・ Security Audit。ほかにサイズ・制御文字・token・route export・旧 tmux のガードのジョブがある | `v0.55.0` タグと develop（`19ef66dd6`）で同じ内容 | `.github/workflows/ci-pr.yml` のジョブ `lint` ・ `type-check` ・ `test-unit`（`matrix.shard: [1, 2, 3, 4]`）と `test-unit-result` ・ `test-integration` ・ `test-e2e`（`matrix.shard: [1, 2]`）と `test-e2e-result` ・ `build` ・ `security-audit` |

| Milestone | closed / open の Issue | Milestone を閉じた日 | リリース（版の日付） | 出典 |
|---|---|---|---|---|
| Sprint 7（#2） | closed 9 ・ open 1 | 2026-11-19 | `v0.53.0`（2026-11-19） | GitHub Milestones API、`CHANGELOG.md` の `## [0.53.0]` |
| Sprint 8（#3） | closed 15 ・ open 0。受け入れは 46 項目中 44 が合格、不合格 0 | 2026-11-20 | `v0.54.0`（2026-11-21） | GitHub Milestones API、`CHANGELOG.md` の `## [0.54.0]` の Highlight（受け入れの数） |
| Sprint 9（#4） | closed 9 ・ open 0 | 2026-11-22 | `v0.55.0`（2026-11-22） | GitHub Milestones API、`CHANGELOG.md` の `## [0.55.0]` |

- コードの規模は次のコマンドで再現できる（作業ツリーではなくタグの中身を読む）:

  ```bash
  git ls-tree -r --name-only v0.55.0 -- src | grep -E '\.(ts|tsx)$' | wc -l      # 1788
  git ls-tree -r --name-only v0.55.0 -- src | grep -E '\.(ts|tsx)$' \
    | while read -r f; do git show "v0.55.0:$f"; done | wc -l                    # 468652
  ```

- Milestone の数は `gh api 'repos/Kewton/CommandMate/milestones?state=all'` の `closed_issues` ・ `open_issues` ・ `closed_at`（UTC の日付）を
  2026-11-23 に取得した値。Issue があとで Milestone に足し引きされると変わるので、取得日を添えて書く
- Milestone を閉じた日とリリースの日は別の事実である。Sprint 8 は Milestone を 2026-11-20 に閉じ、`v0.54.0` は 2026-11-21 に出した
- 範囲は Sprint 7〜9 だけ。Sprint 10 以降はここに無いので書かない（§5「未計測の数字」）
- 表を載せるときは、表の直下に `as observed`（ja: `as observed（実測した範囲）`）と、上の「測った対象」（版 ・ 計測条件）を添える。
  表だけを切り出して使わない。1 つのリポジトリでの記録なので、ほかのリポジトリでの速さ ・ 規模の主張に広げない

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
| 入力待ちが届く（バッジ / トースト / タブタイトル / 通知） | App Badge ・ Toast ・ `document.title` ・ Web Push。Web Push は VAPID の鍵（`CM_VAPID_PUBLIC_KEY` ・ `CM_VAPID_PRIVATE_KEY`）ができるまで無効で、鍵は `commandmate init` が作る（加えてブラウザ側の購読が要る） | `src/hooks/useAttentionBadge.ts` ・ `src/lib/pwa/attention-badge.ts` ・ `src/components/common/Toast.tsx` ・ `src/lib/push/waiting-push-notifier.ts` ・ `src/cli/commands/init.ts`（VAPID の鍵の生成） |
| 8 種のエージェント | `CLI_TOOL_IDS`（9 件。opencode と opencode-v2 を 1 種と数える。§2） | `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS` |
| `wait --verify` | `commandmate wait --verify` オプション | `src/cli/commands/wait.ts` |
| plan → dispatch → merge → uat | 4 つの runner が別々の起動で動き、どれも次の phase を勝手に始めない。mutation は `--approve` を付けた起動だけ | `cmate-orchestrate` Skill の `SKILL.md` |
| 別のエージェントへレビューに出す | `commandmate ask`、`cmate-delegate` Skill | `src/cli/commands/ask.ts` ・ 公式 Catalog の `cmate-delegate` |
| `commandmate mem`（型付きのメモ。`now` ・ `add` ・ `--close-when`） | kind は `now` ・ `waiting` ・ `decision` ・ `next` ・ `external` ・ `note` の 6 つ。`--close-when` は書くときに構文と kind の組を確かめて保存し、閉じるかどうかは `mem list` ・ `mem check` ・ brief ・ 画面のプレビューが呼ばれたときにその場で評価する（タイマーも常駐も無い）。mem の mode（`off` ・ `derived` ・ `on`）が `on` のブランチで書ける。mode の既定は `off` で、`off` ・ `derived` では exit 50 で何も保存しない。mode は画面でだけ変える | `src/cli/commands/mem.ts` の `createMemCommand`（`now <text>` ・ `add` の `--close-when`）・ `src/types/mem.ts` の `MEM_KINDS` ・ `MEM_MODES` ・ `src/lib/mem/service.ts` の `memWriteNow` ・ `memAddItem` ・ `src/lib/mem/close-when.ts` の `parseCloseWhen` ・ `finalizeCloseWhen` ・ `src/lib/mem/evaluate.ts` の `evaluateMemConditions` ・ `src/lib/db/mem-db.ts`（設定が無いときの fallback は mode `off`） |
| `brief` で再起動の後に続きを渡す | `commandmate brief` が派生した状態と mem の項目をバイト数の上限内でまとめる。mode が `derived` のときは派生した状態だけを出し、手で書いた項目は出さない（`off` は何も出さず exit 50）。send への自動の注入は、mode が `derived` か `on` で、**かつ** 機能 `injectOnStart` が有効なときだけ（既定は無効。画面の mem の設定で切り替える）で、会話の境目（起動 ・ 自動再起動 ・ reset ・ resume ・ 明示）の後の最初の send の前に一度だけ brief を置く。それ以外では何も足さず、send の本文はそのまま送る | `src/cli/commands/brief.ts` の `createBriefCommand`（`--budget` ・ `--session-start`）・ `src/lib/mem/present.ts` の `presentMemItem` ・ `src/lib/brief/sources.ts` の `BRIEF_DERIVED_SOURCES` ・ `src/lib/session/brief-provider.ts` の `BriefBoundaryKind` ・ `getBriefProvider` ・ `src/lib/session/session-brief.ts`（`target.mode === 'off'` と `target.features.injectOnStart` が偽なら注入を skip）・ `src/types/mem.ts` の `MEM_FEATURE_KEYS` ・ `src/lib/db/mem-db.ts` の `NO_FEATURES`（`injectOnStart: false`）・ `src/lib/mem/settings-service.ts`（`PUT …/mem-settings/branches` の `injectOnStart`） |
| 決定の反映は画面からだけ承認する（`screen_only`）。エージェントの指示ファイルへは書かない | promote の preview ・ approve などは画面からのリクエストでなければ 403 `screen_only` で断る。行き先の `path:` は `CLAUDE.md` ・ `AGENTS.md` ・ `.claude/` などエージェントの指示ファイル（大文字小文字を区別しない）と `.md` でないファイルを断る。反映する決定（`mem add --kind decision`）は mem の mode が `on` のブランチでしか書けない（既定は `off`） | `src/lib/promote/service.ts` の `promotePreview` ・ `promoteApprove`（`isScreenRequest` が偽なら `promoteError('screen_only')`）・ `src/lib/promote/destination.ts` の `checkDocPath` と、そこから再 export する `AGENT_INSTRUCTION_PATHS`（定義は `src/lib/promote/promote-to-rule.ts`） |
| ロールを決めて起動する（`commandmate roles` ・ `send --role`、exit 32） | ロールは起動時に固定。`send --role` は条件で、合わない ・ 起動の記録が無いときは何も打たずに exit 32（設定は保存済み）。使用中のロールの削除などは exit 31 | `src/cli/commands/roles.ts` の `createRolesCommand`（`list` ・ `show` ・ `add` ・ `edit` ・ `rm` ・ `default` ・ `defaults`）・ `src/cli/commands/send.ts` の `--role` ・ `--no-role` ・ `src/cli/commands/send-validation.ts`（`role` ・ `expectedRole` を送信本文に載せる）・ `src/cli/types/index.ts` の `RoleExitCode.NOT_SENT`（32）・ `RoleExitCode.CONFLICT`（31）・ `src/cli/utils/role-failure.ts`（`ROLE_CONDITION_UNMET` などを 32 に対応づける） |
| 1 画面で完結する UI（ターミナルとチャットの切替 ・ チャットのファイルリンク ・ File Tree ・ 画像 / 動画ビューア ・ Notes） | 表示面は `terminal` / `chat` の 2 つ（既定は `terminal`）。チャットの返答の中のパスはファイルを開くリンクになる。ファイルツリー、ファイル ・ 画像 ・ 動画のビューア、Notes などのサブタブを同じ画面に持つ | `src/types/ui-state.ts` の `SurfaceMode` ・ `DEFAULT_SURFACE_MODE` ・ `src/components/worktree/ChatSurface.tsx` の `ChatSurface` ・ `src/lib/chat/chat-file-link-scope.ts` の `ChatFileLinkProvider` ・ `src/components/worktree/FileTreeView.tsx` の `FileTreeView` ・ `FileViewer.tsx` の `FileViewer` ・ `ImageViewer.tsx` の `ImageViewer` ・ `VideoViewer.tsx` の `VideoViewer` ・ `NotesAndLogsPane.tsx` の `NotesAndLogsPane`（`SubTab` の `notes`） |
| `commandmate remote`（`--provider tailscale` / `cloudflare` と `--auth all` / `remote-only`） | provider は自動で選ぶか `--provider` で指定する。公開の tunnel（Cloudflare Quick Tunnel）は承認（非対話なら `--yes`）が要る。`--auth` は認証の範囲で、既定は `all`。`remote-only` はローカルの listener を認証なしにするので、loopback 以外に bind するサーバーでは断る | `src/cli/commands/remote.ts` の `createRemoteCommand`（`--provider` ・ `--auth` ・ `--yes`）・ `REMOTE_PROVIDER_ALIASES` ・ `PUBLIC_TUNNEL_PROVIDERS` ・ `REMOTE_AUTH_SCOPES` ・ `DEFAULT_REMOTE_AUTH_SCOPE` ・ `parseAuthScope` ・ `src/lib/remote/tailscale.ts` の `tailscaleProvider` ・ `src/lib/remote/cloudflare.ts` の `cloudflareProvider` |
| Auto Yes（画面のトグルと `commandmate auto-yes`） | 既定は無効で、有効にするのは人（画面では確認のダイアログを通す）。有効な時間は 1〜24 時間（§1）で、時間切れか停止パターンの一致で自動で無効になる。Antigravity には `CM_ANTIGRAVITY_USAGE` の宣言が無いと有効にできない | `src/lib/auto-yes-state.ts` の `setAutoYesEnabled` ・ `disableAutoYes` ・ `src/components/worktree/AutoYesConfirmDialog.tsx` ・ `src/cli/commands/auto-yes.ts` ・ `src/config/auto-yes-duration.ts` ・ `src/lib/tool-policy/policy.ts` の `TOOL_POLICY_TABLE`（`auto-yes` の許可が空） |

### 既定で無効・承認の要る機能（公開面で有効にする条件を書く）

公開面に次の機能を書くときは、有効にする条件を**同じ表の行 ・ 同じ箇条 ・ 同じ段落**に書く（隣の行や次の段落に頼らない）。
書けないなら書かない。ここに無い既定で無効な機能を公開面に足すときは、先にこの表に行を足す。
[`tests/unit/docs/public-docs-default-off-conditions-4569.test.ts`](../../tests/unit/docs/public-docs-default-off-conditions-4569.test.ts) の登録表はこの表と同じ ID ・ 同じ扱いで、食い違うと落ちる。

| ID | 機能 | 既定と、有効にする条件 | 公開面の扱い | 根拠 |
|---|---|---|---|---|
| F1 | mem に書く（`mem now` ・ `mem add`、kind `decision` を含む） | mode の既定は `off`。書けるのは mode が `on` のブランチだけで、`off` ・ `derived` では exit 50 で何も保存しない。mode は画面でだけ変える | 条件を書く | `src/lib/db/mem-db.ts` の fallback ・ `src/cli/commands/mem.ts` の help ・ `src/lib/mem/service.ts` |
| F2 | `commandmate brief`（コマンド） | mode が `off`（既定）なら何も出さず exit 50。`derived` は派生した状態だけを出す | 条件を書く | `src/cli/commands/brief.ts` の help |
| F3 | brief の自動の注入（send の前） | mode が `derived` か `on`、**かつ** `injectOnStart` が有効なときだけ（既定は無効。画面の mem の設定） | 条件を書く | `src/lib/session/session-brief.ts` ・ `src/lib/db/mem-db.ts` の `NO_FEATURES` |
| F4 | 決定の反映（promote） | 画面からのリクエストだけを受ける（`screen_only`）。反映する決定は F1 と同じく mode が `on` のブランチでしか書けない | 条件を書く（mode が `on`） | 上の表の promote の行 |
| F5 | Auto Yes | 既定は無効。人が有効にする（画面は確認のダイアログ、時間は 1〜24 時間） | 条件を書く（既定で無効 ・ opt-in ・ 有効にする前の確認のどれか） | 上の表の Auto Yes の行 |
| F6 | `commandmate remote` の公開の tunnel（Cloudflare Quick Tunnel） | 公開の provider は承認が要り、非対話では `--yes` が無いと断る。Tailscale は承認なし | 条件を書く（承認） | `src/cli/commands/remote.ts` の `PUBLIC_TUNNEL_PROVIDERS` ・ `--yes` |
| F7 | `remote --auth remote-only` | 既定は `all`。`remote-only` はローカルの listener を認証なしにする | 条件を書く（認証なしになること） | 上の表の remote の行 |
| F8 | push 通知（Web Push） | `commandmate init` が VAPID の鍵を作るまで無効。加えてブラウザ側の購読が要る | 条件を書く（`commandmate init` か、有効にしたとき） | 上の表の「入力待ちが届く」の行 |
| F9 | ロール（`commandmate roles` ・ `send --role`） | 既定ではロール無しで起動する。ロールは起動時に固定で、`send --role` が合わなければ exit 32 | 求めない（既定で無効な機能ではなく、ロールを付けたときの振る舞い。上の表のロールの行に従って書く） | 上の表のロールの行 |
| F10 | Antigravity をエージェント ・ 自動から使う | `CM_ANTIGRAVITY_USAGE` が無い ・ 個人向けの宣言なら、send ・ ask ・ respond ・ relay は人の起動だけ、Schedules ・ Auto Yes は全部断る。サーバーは起動時にだけ読む | 条件を書く（`CM_ANTIGRAVITY_USAGE` か、個人向けのプランでは断ること）。README の Antigravity の注意節は、それ自体が条件の説明なので対象外 | `src/lib/tool-policy/policy.ts` の `TOOL_POLICY_TABLE` ・ `src/lib/tool-policy/declaration.ts` |
| F11 | スケジュール実行（Schedules） | `CMATE.md` に書いた分だけ動く（書かなければ何も動かない） | 求めない（「あなたが決めた時刻」「`CMATE.md` に書く」で、書いた人が有効にすることが読める） | `src/lib/schedule-manager.ts` |
| F12 | 確認つきの CLI（`skill install` ・ `update`） | 対話では確認を出し、非対話では `--yes` が無いと断る | 求めない（対話では確認が出て、非対話では CLI が `--yes` を案内する） | `src/cli/commands/skill.ts` ・ `src/cli/commands/update.ts` |

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

---

## 10. Level 名と人間の役割（Issue #3153）

Level は「機能の高度さ」ではなく「**人間が AI 開発組織にどこまで関与するか**」で切る。README（en / ja）・LP ・
`website/llms.txt` は、hero と Level 名をこの表のとおりに揃える（説明文は面ごとに自由に書いてよい）。

| 項目 | 内容 |
|---|---|
| hero（en / ja 共通の主張） | Run multiple coding agents in parallel — even away from your desk. / 複数のコーディングエージェントを並列に。机を離れていても。 |
| 定義文（hero の直下に置く） | CommandMate puts the coding agents you already use in one place on your own machine, so you can run them side by side, hand them work one issue at a time, and let your own checks decide when the work is done. |

| Level | CommandMate がすること | 人間の役割 |
|---|---|---|
| Level 1 — Parallel | 複数のコーディングエージェントを 1 か所から並列に動かす | Operator（各エージェントに応える） |
| Level 2 — Delegate | Issue 単位で渡し、完了はエージェントの申告ではなく利用者のチェック（lint ・ テスト）の結果で決める | Product / Tech lead（タスクを書き、合格したものを受け取る） |
| Level 3 — Manage | PM 役のエージェントが計画 ・ 割り当て ・ 確認をまとめ、人は PM と話して承認する | Owner（方向を決めて承認する） |
| Next — Learn | 未実装。方向のみ（下の上限を守る） | なし（未実装のため役割を書かない） |

- **Anywhere（横軸）**: スマホは Level 1 の機能ではなく、全 Level を横断する軸として 1 行で書く（PC に張り付かなくても回せる）
- **「多くの人は Level 2 で十分」と書く**。Level 3 へ誘導しない。階段の図を使っても「上るほど良い」とは書かない
- Level 3 の「人は PM と話して承認する」は §7 の 4 行目（承認は人に来る）と同じ意味で書く。「人が要らない」方向に広げない
- Level 3 の作者の運用（日次の自動修正）の但し書きは、Level の本文ではなく脚注か My setup 側に置く
- 「安い worker」はモデルの安さの序列（§5）としてではなく、**作者の実費**（§1 の $110–$210: Claude Max + Command Code Goat）として書く

### Next — Learn の書き方の上限

| 上限 | 理由 |
|---|---|
| 未実装であることが分かるように書く（en: Not built yet / ja: まだ作っていない） | 機能が在ることの根拠（§4）が無い |
| 方向だけを書く。README は 1〜2 文、LP は置くなら 1 行 | 方向以上のことは実装も実測も無い |
| 数字を書かない（成功率 ・ 改善率 ・ 件数など） | §5「未計測の数字」 |
| エージェントやモデルを比べない（「エージェント X は成功率 N%」のような例示も書かない） | §5「モデルの安さ・賢さの序列」 |
| `loop` ・ `self-managing` ・ `runs 24/7` ・ `no supervision` を使わない | §5 ・ §7（常駐ではなく、承認は人に来る） |

#### 実装済みと未実装の境目（Issue #4568）

Next — Learn は「記録から次の作業を良くする」方向である。その材料になる機能のうち、次は**実装済み**で、§4 に根拠がある。
公開面でこれらを Next — Learn の一部として「まだ作っていない」と書かない。逆に、これらがあることを Learn が出来ている証拠としても書かない。

- `commandmate mem`（型付きのメモと `--close-when` の評価）・ `commandmate brief`（再起動の後の引き継ぎ）・ 決定の反映を画面からだけ承認する promote（`screen_only`）
- `commandmate verify history` ・ `commandmate report metrics`（記録を読むだけ）

**未実装**なのは次の 2 つで、Next — Learn と書くときは上の 5 つの上限をそのまま守る。

- dreaming（Issue #4248、設計 [docs/design/mem-dreaming-4248.md](./mem-dreaming-4248.md)）: 作業の外でエージェントが mem をまとめ直し、
  人が画面で承認する提案として出す。設計だけがあり、`src/` に実装は無い（2026-11-23、develop `19ef66dd6` で確認。Issue #4248 は open）
- 検証の履歴や STOP の傾向から、エージェントが自分で振り返って次の作業を変えること。方向だけで、§4 に根拠のある実装は無い
