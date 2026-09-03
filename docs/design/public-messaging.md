# 公開面 発信仕様（Public Messaging）

CommandMate の公開面（LP `website/` ・ README ・ チュートリアル ・ product-highlights ・ デモ動画）が
使う文言の **単一ソース**。Issue #1808（Epic #1807 Step A）で確定した。

- 各面はこのファイルから **コピーして使う**。独自に言い換えない
- 言い換えたくなったら、まずこのファイルを直し、その差分で各面を追随させる
- ここに無い項目を新しく発明するより、ここに追記してから使うほうが速い
- 概念の正本（Vision / Mission / 中核原則 / 実装）は [docs/concept.md](../concept.md) ・
  [docs/en/concept.md](../en/concept.md)。このファイルは **その公開面向けの文言表** である

ガードは [`tests/unit/docs/public-messaging.test.ts`](../../tests/unit/docs/public-messaging.test.ts)。

---

## 1. Hero（LP 冒頭）

**採用案: 案 1（対比型）**。Epic #1807 D6 の既定どおり。案 2（宣言型）は不採用。

理由: 軸語 "Vibe Engineering" は既出語（§10）であり、単体で置くと読み手に意味が渡らない。
`From vibe coding to Vibe Engineering.` は **出発点（vibe coding）を否定せず、その次を示す**
という Epic の決定（「否定ではなく出発点として書く」）を H1 の一行で満たす唯一の形である。

| 項目 | 文言 |
|---|---|
| H1（en / LP 本番） | From vibe coding to Vibe Engineering. |
| H1（ja / README ja ・ 日本語面） | vibe coding から、Vibe Engineering へ。 |
| lede 1 文目（en） | CommandMate builds the engineering discipline into the workflow: a contract before the work, verification gates after it, evidence throughout. |
| lede 2 文目（en） | Any coding agent turns your requirement into a verified result. |
| lede 1 文目（ja） | CommandMate は、エンジニアリングの規律をワークフローそのものに組み込みます。作業の前に契約を、作業の後に検証ゲートを、その全体に証跡を。 |
| lede 2 文目（ja） | どのコーディングエージェントでも、あなたの要求を検証済みの成果物に変えられます。 |

> **原案からの変更点**: 案 1 の lede は em dash を 2 つ含む 1 文だったため、意味を変えずに 2 文へ分割した
> （制約「lede は 2 文以内」の範囲内）。H1 は原案のまま 1 文字も変えていない。

---

## 2. 定義文

**この 2 文は逐語で固定する**。concept.md（ja / en）と LP が同じ文字列を持つことをテストで固定している。

下の表の en 行は `def:en` の HTML コメントマーカーで囲ってある。LP のガード
（[`tests/unit/website/landing-page.test.ts`](../../tests/unit/website/landing-page.test.ts)）は
マーカーの中身を読んで `website/index.html` と突き合わせるので、**マーカーを外さないこと**
（外すとテストは「照合対象が無い」で落ちる。文言を直したいときはマーカーの中を直す）。

| 言語 | 定義文 |
|---|---|
| en | <!-- def:en -->Vibe Engineering — the AI does the building; the system, not your expertise, guarantees the engineering.<!-- /def:en --> |
| ja | Vibe Engineering — 作るのは AI。エンジニアリングを保証するのは、あなたの専門知識ではなく仕組み。 |

添える一節（芯）:

| 言語 | 一節 |
|---|---|
| en | We do not make the AI smarter. We make the software-engineering ability its user needed into a system. |
| ja | AI を賢くするのではなく、AI を使う側に必要だったソフトウェアエンジニアリング能力を仕組み化する。 |

---

## 3. 4 カード（タイトル + 1 文）

| # | タイトル（en） | 1 文（en） | タイトル（ja） | 1 文（ja） |
|---|---|---|---|---|
| 1 | Method as a system | The method is not in someone's head — it is installed as Skills and read by the agent. | 方法論を仕組みに | 方法論は誰かの頭の中ではなく、Skill として導入され、エージェントが読む形になる。 |
| 2 | Verified, not vibe-checked | Gates you declared decide whether the work is done, and the exit code is the verdict. | 「たぶん動く」ではなく検証済み | 完了を決めるのはあなたが宣言したゲートで、判定は実 exit code である。 |
| 3 | Any agent, in parallel | One worktree and one contract per task, across seven agent CLIs and local models. | どのエージェントでも、並列で | タスクごとに worktree 1 つと契約 1 つ。7 種のエージェント CLI とローカルモデルに対応する。 |
| 4 | Stay in control, anywhere | When an agent needs you, it reaches you — badge, toast, tab title, push — and you answer from your phone. | どこからでも、手綱は自分に | エージェントがあなたを必要としたら、バッジ・トースト・タブタイトル・通知で届き、スマホから応答できる。 |

---

## 4. With / Without CommandMate（競合比較の置き換え）

**競合製品名は書かない**（§9）。比較対象は製品ではなく **やり方** である。
右列の各セルは実装済み機能に対応している（根拠は §11）。

### en（LP / README）

| Dimension | Vibe coding | Vibe Engineering with CommandMate |
|---|---|---|
| What "done" means | The agent says it's done | A verification run says so — exit 0 / 20 / 21 |
| Scope of change | Whatever the agent touched | Declared in the contract, enforced by the scope gate |
| Method | In someone's head | Installed as Skills from the Catalog (`cmate-task-contract`, `cmate-verify`, …) |
| Evidence | A chat transcript | Commits, gate logs, `verify history`, `report metrics` |
| Parallel work | Terminal tabs | One worktree and one contract per task |
| When it stops | You notice, eventually | Waiting is surfaced: badge, toast, tab title, push |
| Which agent | Locked to one | Claude Code, Codex, Gemini CLI, Copilot, OpenCode, Antigravity, local models |

### ja（README ja / チュートリアル）

| 観点 | vibe coding（丸投げ） | Vibe Engineering with CommandMate |
|---|---|---|
| 「完了」の意味 | エージェントが「できた」と言ったとき | 検証ランがそう言ったとき — exit 0 / 20 / 21 |
| 変更範囲 | エージェントが触った範囲すべて | 契約で宣言し、scope ゲートで強制する |
| 方法論 | 誰かの頭の中 | Catalog から Skill として導入する（`cmate-task-contract` / `cmate-verify` ほか） |
| 証跡 | チャットの履歴 | commit ・ ゲートログ ・ `verify history` ・ `report metrics` |
| 並列作業 | ターミナルのタブ | タスクごとに worktree 1 つと契約 1 つ |
| 止まったとき | そのうち気づく | 入力待ちが届く: バッジ ・ トースト ・ タブタイトル ・ 通知 |
| 使えるエージェント | 1 つに固定 | Claude Code ・ Codex ・ Gemini CLI ・ Copilot ・ OpenCode ・ Antigravity ・ ローカルモデル |

---

## 5. LP デモ 4 本のキャプション

4 本は §3 の 4 カードと 1 対 1 に対応させる。
**キャプションには映像に映っていることだけを書く**。撮影後、実際の映像と突き合わせて確認すること。

| # | 対応カード | 内容（撮影対象） | キャプション（en） | キャプション（ja） |
|---|---|---|---|---|
| 1 | Method as a system | ターミナル: `commandmate send <id> --contract .commandmate/tasks/<name>.yaml` を実行し、契約の goal と scope がエージェントへ渡る | Hand the agent a contract before the work starts. | 作業を始める前に、エージェントへ契約を渡す。 |
| 2 | Verified, not vibe-checked | ターミナル: `commandmate wait <id> --verify` の `GATE` 行と `RESULT` 行、そして終了コード | Gates run, and the exit code is the verdict. | ゲートが走り、判定は exit code で返る。 |
| 3 | Any agent, in parallel | ブラウザ: 複数 worktree のセッションが同時に走り、サイドバーの状態が個別に変わる | One session per worktree, running in parallel. | worktree ごとに 1 セッション、並列で走る。 |
| 4 | Stay in control, anywhere | ブラウザ / スマホ: 入力待ちがバッジ・トースト・タブタイトルに出て、スマホから応答する | Waiting reaches you, and you answer from your phone. | 入力待ちが届き、スマホから応答する。 |

> **旧デモとの差分**: 旧 4 本目 `tmux-in-browser`（"Your tmux session, driven from the browser."）は
> 廃止し、入力待ち通知デモへ置き換える（Epic #1807 D1）。検証は Web UI を待たず
> ターミナル映像で見せる（同 D5）。

---

## 6. デモのテロップ

制約は `.claude/skills/demo-video/scripts/storyboard.ts` の検証規則そのもの
（`record`: ja 20 文字 / en 8 語以内、`card`: ja 40 文字 / en 12 語以内）。
下の値はテストで実際にこの上限に照らしている。

| デモ | 種別 | telop.ja | telop.en |
|---|---|---|---|
| 1 | card | 作業の前に、契約を渡す | Hand the agent a contract before the work. |
| 1 | record | 契約つきで送信する | Send with a contract. |
| 2 | card | 終わりを決めるのは検証。exit 0 / 20 / 21 | A verification run decides done, not the agent. |
| 2 | record | GATE と RESULT を読む | Gates run; the exit code judges. |
| 3 | card | worktree ごとに 1 セッション。7 種の CLI から選べる | One session per worktree, across seven agent CLIs. |
| 3 | record | 並列で走る worktree | Worktrees running side by side. |
| 4 | card | 入力待ちは、バッジ・トースト・タブ・通知で届く | Waiting reaches you: badge, toast, tab title, push. |
| 4 | record | スマホから応答する | Answer from your phone. |

---

## 7. チュートリアル導入文

必須要素: **15 分** / **fork してから始める** / **契約 → 検証を体験する**。

| 言語 | 導入文 |
|---|---|
| ja | わざとバグを 2 つ残したサンプルリポジトリを使って、CommandMate の中核を 15 分ほどで一通り体験します。サンプルリポジトリを fork してから始めるので、あなたの操作が元のリポジトリ（upstream）に影響することはありません。作業の前に契約を渡し、作業の後に検証ゲートで判定するところまでを、実際の exit code で確かめます。 |
| en | Use a sample repository with two bugs left in on purpose to work through the core of CommandMate in about fifteen minutes. You fork the sample repository before you start, so nothing you do can touch the original repository (upstream). You hand the agent a contract before the work and let the verification gates judge it afterwards, and you read the verdict off the real exit code. |

---

## 8. Footer タグライン

`local control plane` は使わない（§9）。

| 言語 | タグライン |
|---|---|
| en | The method, built in — for any coding agent. |
| ja | 方法論を、仕組みに。どのコーディングエージェントでも。 |

---

## 9. 禁止語リスト

公開面の新しい文章に書かない語。**この表がテスト側の配列と一致していること**を
`tests/unit/docs/public-messaging.test.ts` で固定している（片方だけ更新されるのを防ぐ）。

現時点でテストが適用されている対象は `docs/concept.md` と `docs/en/concept.md` のみ。
LP / README / チュートリアルは各面の Issue（#1812 / #1814 / #1813）で改稿してから対象に加える。

<!-- banned-terms:start -->

| 禁止語 | 代わりに | 理由 |
|---|---|---|
| `control plane` | §1 の hero / §8 の footer タグライン | 「複数のエージェント CLI を便利に操作するツール」という旧軸の語。方法論を提供する側面が落ちる |
| `コントロールプレーン` | §1 の hero（ja） | 同上（日本語面） |
| `Orchestrate your agent CLIs, not your terminal tabs` | §1 の H1 | 旧 LP の H1。操作対象がターミナルタブになっており、軸が「操作」に留まる |
| `Vibe Coder` | vibe coding（行為）または「AI とプロダクトを作る人」 | 人の属性でセグメントを切る旧軸。CommandMate は属性ではなく仕組みで結果を揃える |
| `Remote Control` | §4 の With / Without 表 | 競合製品名。新しい文章に他社製品名を書かない（Epic #1807 D4） |
| `Happy Coder` | §4 の With / Without 表 | 同上 |
| `claude-squad` | §4 の With / Without 表 | 同上 |
| `Omnara` | §4 の With / Without 表 | 同上 |

<!-- banned-terms:end -->

---

## 10. 出典 — "vibe engineering" の一次情報確認

**確認済み**。2026-08-18 に一次情報（本文）を実際に取得して確認した。

| 項目 | 内容 |
|---|---|
| 語 | vibe engineering |
| 出典 | Simon Willison, "Vibe engineering", 2025-10-07, https://simonwillison.net/2025/Oct/7/vibe-engineering/ |
| 確認状況 | 確認済み（2026-08-18 に本文を取得） |
| 原文の定義 | "the other end of the spectrum, where seasoned professionals accelerate their work with LLMs while staying proudly and confidently accountable for the software they produce" |
| 原文が vibe coding と対比する形 | "This feels very different from classic vibe coding, where I outsource a simple, low-stakes task to an LLM and accept the result if it appears to work." |
| 原文のトーン | 著者自身が "with my tongue only partially in my cheek" と書いており、半ば冗談として提案された語である |
| 原文が挙げる必要な実践 | 自動テスト / 事前の計画 / 網羅的なドキュメント / 堅実なバージョン管理 / 自動化 / コードレビュー文化 / 手動 QA / 調査能力 / プレビュー環境 / AI を使う勘所 / 見積もりの更新 |
| CommandMate の用法との整合 | **整合する**。原文の実践一覧（テスト・計画・レビュー・自動化）は、CommandMate の実装 7 項目とほぼ同じ範囲を指している |
| ただし異なる前提 | 原文の主語は "seasoned professionals"（経験を積んだプロ）で、規律は**人が持っている**ことが前提。CommandMate はその規律を**仕組み側に置く**ので、主語が「専門知識を持たない人」まで広がる。定義文（§2）が "the system, not your expertise" と明示しているのはこの差分のためである |
| LP の脚注 | **置く**。既出語を自社造語のように見せないため |
| 脚注の文言（en） | The term "vibe engineering" was coined by Simon Willison (2025). |
| 脚注の文言（ja） | "vibe engineering" は Simon Willison 氏が 2025 年に提唱した語です。 |

---

## 11. 実装との突合（With / Without 右列の根拠）

§4 の右列は、すべて実装済み機能に対応している。存在しない機能は書いていない。

| §4 の主張 | 実装 | 根拠 |
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
| 8 種のエージェント CLI とローカルモデル | `CLI_TOOL_IDS`（claude / codex / gemini / vibe-local / opencode / copilot / antigravity / command-code） | `src/lib/cli-tools/types.ts` の `CLI_TOOL_IDS` |
| `wait --verify` | `commandmate wait --verify` オプション | `src/cli/commands/wait.ts` |

---

## 12. 後続 Issue との対応

| Issue | 面 | このファイルから使う節 |
|---|---|---|
| #1810 | デモ新シーン | §5 ・ §6 |
| #1811 | 特徴デモ 12 本 | §3 ・ §6 |
| #1812 | LP v2 | §1 ・ §2 ・ §3 ・ §4 ・ §5 ・ §8 ・ §9 ・ §10 |
| #1813 | チュートリアル v2 | §2 ・ §7 ・ §9 |
| #1814 | README 整合 | §1 ・ §2 ・ §3 ・ §4 ・ §9 |
| #1815 | README GIF | §5 ・ §6 |
