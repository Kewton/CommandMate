# 設計方針書: 多エージェント状態アーキテクチャ（Issue #1915）

- **Issue**: [#1915](https://github.com/Kewton/CommandMate/issues/1915)
- **根拠 Epic**: [#1891](https://github.com/Kewton/CommandMate/issues/1891)（opencode / Copilot CLI 実機監査 38 件）
- **先行設計**: #1720（hooks を機械判断の第一級ソースへ）、#1708（解釈できないフレーム）、#1737（waiting 判定の単一生成者）、#1629（instance → tool 解決）、[discoverability 原則](./discoverability-principle.md)（#1686）
- **ステータス**: Reviewed（Stage 1–4 完了。Stage 1 / 2 / 3 / 4 の指摘を全件反映済み。Stage 4 は develop `90b67eb9` 基準のセキュリティ / OWASP レビュー）
- **棚卸し基準日**: 2026-08-21（develop `90b67eb9`。関数名・ファイルパスで参照し、行番号は原則書かない）

---

## 1. 概要

CommandMate は **7 種類**の Coding Agent CLI（`CLI_TOOL_IDS`: claude / codex / gemini / vibe-local / opencode / copilot / antigravity）を tmux 上で動かす。このうち構造化イベントのソース実装（`src/lib/hooks/sources/`）を持つのは **6 種類**（vibe-local を除く）である。**ツール 7・ソース 6** はこの意味であり、本書では常に書き分ける。

状態は **TUI スクレイピング**と **hooks / SSE の構造化イベント**の 2 層から導出し、`SessionStatus` の **4 値**（`idle` / `ready` / `running` / `waiting`）として消費者に配る。`idle` は「tmux セッションが無い（`session_not_running`）」の意味で既に使われている語であり、本書では他の意味に流用しない（§2 の「未開始」を使う）。

消費者は sidebar（`BranchStatusIndicator`）・`capture --json`・`wait`・Auto-Yes poller・**send guard**・`ls`・Web UI のチップである。Auto-Yes poller だけは `sessionStatus` を経由せず `detectPrompt` を直接読む（§4 D1、DR1-006）。

2026-08-21 の実機監査（#1891）で、opencode 1.18.20 と Copilot CLI 1.0.80 に対して 38 件の不具合が見つかった。個別に見ればパターン文字列の陳腐化や分岐漏れだが、原因をたどると **4 つの構造**に収束する（§3）。本書はその構造に対する設計原則 D1〜D5 を確定し、#1891 の子 Issue がこの方針に沿って実装されること、次のツール更新で同じ症状が再発しないことを目的とする。

**本書が支配する範囲**は Epic #1891 の子 Issue（#1893〜#1914）**＋ 既報 4 件**（#1883 / #1884 / #1885 / #1886。いずれも 2026-08-21 時点で OPEN）である（DR2-015）。特に #1883（opencode の idle composer `Ask anything...` が `hasActivePrompt=true` になり send が全拒否・sidebar が永続 waiting）は §4 D1 決定 5 と §6.1 の `input_prompt` 経路に直撃するため、方針の適用対象に含める。

本書は **方針と境界の文書**である。個々のパターン修正の仕様は子 Issue に、API の詳細仕様は実装 PR に委ねる。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| スクレイパ | `src/lib/detection/`（`detectSessionStatus` / `detectPrompt` / `cli-patterns`）。tmux `capture-pane` の文字列から状態を推定する層 |
| 構造化層 | `src/lib/hooks/sources/*`（`AgentEventSource`）→ `/api/hooks/*` または SSE → `src/lib/session/agent-event-state.ts`。ツール自身が発するイベントから状態を導出する層 |
| 統合判定 | `src/lib/session/current-output-builder.ts` の `mergeStructuredStatus`。2 層の結果を 1 つの `sessionStatus` / `sessionStatusReason` にする |
| waiting 解決 | `src/lib/session/prompt-waiting-composition.ts` の `resolvePromptWaiting`（#1737）。**waiting 判定の唯一の生成者**で、統合判定と send guard の両方が同じ出力を読む |
| ツール抽象 | `src/lib/cli-tools/base.ts` の `BaseCLITool` と各 `*Tool`。起動・送信・中断・停止・セッション名を担う |
| 運用者層 | discoverability 原則で定義される「運用者が読む層」：`capture --json` / `wait` stdout / `ls` / Web UI のチップ |
| turn | ユーザー発話（`user_prompt_submit`）から `stop` までの 1 往復 |
| 未開始（not-started） | セッションはあるが turn が一度も開いていない状態。`SessionStatus` としては `ready`（reason `input_prompt`）。`idle`（セッションが無い）とは別概念 |
| unclassified フレーム | #1708 で**出荷済み**の「解釈できないフレーム」機構。`isUnclassifiedActive`（`current-output-builder`。**ガードの実体は `mergeStructuredStatus` 適用後の merged 値**）/ 型 `UnclassifiedFrameRecord`（**`src/types/models.ts`**）/ 観測 `observeUnclassifiedFrame`（`unclassified-frame-tracker`。server 側 dwell は `UNCLASSIFIED_RECORD_DWELL_MS` = 60 秒）/ `wait` 側 dwell `UNCLASSIFIED_DWELL_MS`（60 秒）と exit 10 `type:'unclassified'` からなる。**60 秒 dwell は server / CLI に独立した 2 本ある**（DR2-019。§4 D1 決定 2 の「新しいタイマーを作らない」は、この 2 本を 3 本にしないという意味） |
| 2 つの `unclassified` の書き分け（DR3-017） | 語が同じで概念が違う。**(a) `BranchWaitingKind='unclassified'`**（`waiting-kind.ts` の `deriveWaitingKind`、#1786/#1787）は **`waiting` のときだけ**動き、`hasActivePrompt` でも `SELECTION_LIST_REASONS` でもない waiting を指す。**(b) `isUnclassifiedActive` / `statusEvidence:'none'`**（本書）は waiting と独立で `(running && default) \|\| (ready && no_recent_output)` 由来。sidebar は両方を同じ画面に出すため、本書では (a) を「**waitingKind の unclassified**」、(b) を「**証拠なし**」と必ず書き分ける。**D1 の拡大は `deriveWaitingKind` に影響しない**（`waiting` でないときは `null` を返すため） |
| 証拠（`statusEvidence`） | 本書で導入する `'positive' \| 'none'`。判定が**肯定的証拠**に基づくか、単に否定パターンに一致しなかっただけかを表す（§4 D1） |
| S / H / L / C 群 | Epic #1891 の子 Issue の群。**S = #1893〜#1897**（スクレイパ）/ **H = #1898〜#1904**（構造化層・hooks）/ **L = #1905〜#1908**（配線・ツール抽象）/ **C = #1909〜#1914**（横断・その他）。定義は Epic 側にしかなかったため本書で明記する |

---

## 3. 現状分析 — 4 つの構造的課題

証拠は #1891 および各子 Issue に実測ログつきで記載済み。ここでは構造だけを述べる。

### P1. 完了判定が「否定の不在」で成立している（スクレイパ）

`detectSessionStatus` のツール別分岐は概ね「処理中の痕跡（`esc interrupt` / thinking 語 / スピナー）が無い → 入力プロンプト or 完了マーカーが見える → `ready`」と進む。処理中の痕跡の**語彙**はツール側の都合で変わるため、変わった瞬間に `ready` が返る。

**実測（DR2-002）**: `cli-patterns.ts` に実在する**完了マーカーは `OPENCODE_RESPONSE_COMPLETE` の 1 件だけ**で、claude / copilot / codex / gemini / antigravity には完了マーカーが 1 つも無い。これらのツールの `ready` は現状**すべて `promptPattern`（`input_prompt`）由来**である。なお `⏺` は `CLAUDE_SPINNER_CHARS` の 1 要素（`CLAUDE_THINKING_PATTERN`）であり、**running 側の証拠**であって完了マーカーではない。

| 実例 | 変わった語彙 | 結果 |
|---|---|---|
| #1894 | opencode `esc interrupt` → `esc again to interrupt`（Esc 1 回目の 5 秒間） | `ready/opencode_response_complete` |
| #1893 | opencode 途中ステップの時間なし `▣ Build · model` | 完了マーカー regex の時間部分が optional で `ready` |
| #1885 | copilot `(Esc to cancel` → `◎ Working · esc interrupt` | 全フレーム `ready/input_prompt` |
| #1895 | copilot `/model` フッタ `Enter to select` → `enter to select` | 既定分岐で `running/default` |

**実装の末尾優先順位（`status-detector.ts`、実測）**は次のとおりで、`ready` を「否定の不在」で作っているのは **`input_prompt` と `no_recent_output` の 2 経路**である。既定分岐（`default`）は `ready` ではなく `running` を返す。**本書は経路を reason 名で参照する**（`status-detector.ts` の docstring は Priority order を 1〜5 で採番しており、本書の (2)(3)(4) は docstring の 3./4./5. に対応する。番号だけが 1 つずれるため、突き合わせは reason 名で行うこと、DR2-018）。

| 経路（reason・本書の番号） | docstring 番号 | 条件 | 返り値 | 性質 |
|---|---|---|---|---|
| `input_prompt`（2） | 3. | `promptPattern` 一致 | `ready` / `input_prompt`（high） | **否定の不在**（composer が見えるだけで、直前 turn の完了は証明していない。#1885） |
| `no_recent_output`（3） | 4. | `lastOutputTimestamp` から 5 秒（`STALE_OUTPUT_THRESHOLD_MS`）経過 | `ready` / `no_recent_output`（low） | **否定の不在**（`wait.ts` が「stalled worker を Completed に化けさせる」と明記した経路） |
| `default`（4） | 5. | 既定 | `running` / `default`（low） | 判定不能（`running` 側に倒れている） |

(3)(4) は既に `isUnclassifiedActive = (running && default) || (ready && no_recent_output)` として #1708 のガード（`wait` の 60 秒 dwell → exit 10、Web UI の `TerminalEscapeHatch`）に使われている。**D1 はこのガードを壊さずに置き換える必要がある**（§4 D1 / §6.1）。

ただしこの値は `mergeStructuredStatus` を通ったあとに上書きされうる（**構造化 `ready` × scraper `running` のとき `false` に潰される**）。現行は scraper が `ready`/`no_recent_output` を返すためこの分岐に入らないが、`no_recent_output` を `running` に倒すと分岐が成立する。**ガードの実体は merged の `isUnclassifiedActive`** であり、scraper 単体の真偽ではない（DR2-003。§5.2 / §6.1 / §11 で pin 対象を merged に統一する）。

さらに、ダイアログ系（permission / ask_user / ピッカー）は「番号リスト」という Claude の形を一般化して検出しており、opencode の横ボタン列（`Allow once  Allow always  Reject`）のように形が違うと**検出手段そのものが無い**（#1893）。逆に、返答本文の番号リストや見出し語をダイアログと誤認する（#1896、#1895）。

### P2. 構造化層の状態機械が Claude の意味論を全ソースで共有している

`agent-event-state.ts` は #1720 で Claude の hooks を前提に設計された。以下の仮定はすべて **Claude では正しく、copilot / opencode では成立しない**。

| 仮定（現行実装） | copilot / opencode の実態 | 症状 |
|---|---|---|
| 最新イベントが verdict（`getStructuredSessionState`） | copilot は `SessionStart` を `UserPromptSubmit` の 12〜15 秒後に送る | 生成中に verdict が null → scraper の ready（#1903） |
| `PreToolUse` の非 allow ＝ ダイアログ予告（`reportPermissionRequestPending`） | copilot は全ツール呼び出しで `PreToolUse` を発火し大半は即実行 | Read 中も `waiting`、`wait` 偽 exit 10（#1901） |
| permission は `post_tool_use` / `stop` で解除 | opencode は `permission.replied` を出す。承認後もツールは長く走る | 承認後も `waiting` 固着（#1898） |
| 同一 (event, detail, session) の 3 秒以内は重複（`isDuplicateAgentEvent`） | opencode は別 id の permission / question を連続で出し、turn-gate が既に重複排除している | 2 件目の承認が永久に未裁定、短い turn の `stop` 消失（#1899） |
| 裁定は記録の後（`ingest` が notification を先に記録） | SSE では自分が裁定者 | 裁定済みでも prompt-waiting が開く（#1898） |
| 再接続は状態を持ち越せる | SSE の再接続は `gate.reset()` で turn の武装を捨てる。**pending の再取得（`resyncPending` → `GET /permission` / `GET /question` の replay）は実装済み**で、未実装なのは **busy/idle の再取得**（`probeActivity` / `fetchOpencodeActivity` ＝ `GET /session/status` に本番の呼び出し元が 0 件）（DR2-011） | turn 途中の再接続で `stop` を合成できない（#1900） |

`AgentEventSource.capabilities`（`src/lib/hooks/sources/types.ts`）には `supportedEvents` / `configScope` / `decisionTimeoutSeconds` しか無く、**状態機械が参照できる意味論の差分が宣言されていない**。既存 3 項目はいずれも **JSON 直列化可能な宣言値**であり、型コメントは「capability はデータで語る」ことを規範として明文化している（D3 の追加項目もこれに従う）。

### P3. ツール抽象を迂回する配線

| 経路 | 迂回の内容 | 症状 |
|---|---|---|
| `src/app/api/worktrees/[id]/kill-session/route.ts` | `lib/tmux` の `killSession` を直接呼ぶ | `OpenCodeTool.killSession` の SSE 解放・port 返却が走らない。`CopilotTool.killSession` は GUI/CLI から dead path（#1905） |
| `src/lib/session/send-user-message.ts`、`terminal/route.ts` | `cliToolId === 'copilot'` の生 `sendKeys` 分岐 | 改行平坦化・submit 検証なし・`SELECTION_LIST_COMMANDS` 不達（#1906） |
| `src/app/api/**` の 11 ファイル | `lib/tmux` を直接 import | ツール固有の前後処理（`invalidateCache`・release・graceful exit）が経路ごとに抜ける |

### P4. tool / instance 解決が経路ごとに実装されている

解決の実装は **1 つではなく 4 つある**（DR2-008 / DR2-009。本書初版の「2 実装」は誤り）。

- **server 側 `resolveInstanceCliTool`**（`src/lib/db/agent-instances-db.ts`。同期・DB 直読み。`send` / `auto-yes` route が使用）: 解決は **4 段**。roster → 明示指定 → **instanceId がツール名（primary anchor、#868）** → シグナル無し（`cliToolId: null`、呼び出し側の既定へ）。
- **CLI 側 `resolveInstanceCliTool`**（`src/cli/commands/instances.ts`。async・`ApiClient` 経由。利用者は **`send` / `capture` / `respond` / `auto-yes` の 4 コマンド**）: 解決は **2 段しかなく、primary anchor の段が無い**。roster 未登録なら `requestedAgent` をそのまま返す。`tsconfig.cli.json` の `paths: {}` 制約下にあり、server 側関数をそのまま import できない。
- **`kill-session` route のインライン解決**（`src/app/api/worktrees/[id]/kill-session/route.ts`）: `(targetCliTool ?? null) ?? (known ? known.cliTool : null) ?? (isCliToolType(instanceParam) ? instanceParam : null)` を直書きしており、**明示 `?cliTool` が roster より優先**。矛盾しても 400 を返さず黙って明示側を採る（#1629 と逆順・conflict 未検出）。
- **`capture` CLI の `resolvePaneCliTool`**（`src/cli/commands/capture.ts`）: pane 解決のためのもう 1 つの実装。

**したがって「規約は同じで、経路ごとに違うのは呼び出し側の既定値だけ」は誤りである**（初版の記述を訂正）。server と CLI は **roster 未登録の instanceId に対して実際に違う答えを返す**（server は「ツール名なら primary へ解決」、CLI は worktree 既定へ落とす）。この実測差が §4 D5 決定 1 で「ローカル解決の残置＋等価性契約テスト」を**採らない**根拠である（等価性テストは初日から赤になる）。

| 経路 | 既定の解決 | 症状 |
|---|---|---|
| `current-output` route | `?cliTool` → worktree 既定 → `'claude'`（`?instance` を見ない） | `wait --instance opencode` が exit 21（#1884） |
| `auto-yes` route | `resolution.cliToolId ?? 'claude'`（worktree 既定を見ない） | 既定 copilot の worktree で claude の poller が走る（#1909） |
| `send` CLI | `--model` を `--agent` で検証してから instance 解決 | `--instance copilot --model` が拒否（#1909） |
| `terminal` route | instanceId を受け取らない | 常に primary へ送る（#1906） |
| `kill-session` route | 明示 `?cliTool` → roster → instanceId がツール名（**#1629 と逆順**・conflict 未検出） | 矛盾しても黙って明示側を採る。`resolveSessionTarget` 置換で roster 優先＋400 に変わる（DR2-009） |
| `send` / `wait` / `capture` | instance → roster → worktree 既定 | 正しい |

---

## 4. 設計原則（決定事項）

### D1. 完了は肯定的証拠でのみ宣言する

**決定 1 — `ready` の条件（DR2-002 で改訂）**: `sessionStatus: 'ready'`（turn 完了）を返してよいのは、次の**肯定的証拠**のいずれかを観測したときだけとする。

1. **ツール固有の完了マーカー（実在するツールのみ）**。現在 `cli-patterns.ts` に実在する完了マーカーは `OPENCODE_RESPONSE_COMPLETE`（時間付き `▣ <Agent> · <model> · <duration>`）の **1 件だけ**である。
2. **肯定確認された idle 証拠（ツール別）**。**そのツールの実フレームで肯定的に確認**した「turn が動いていない」状態。**どの行を読むかはツールごとに違い、「composer が空」はそれ自体では完了証拠にならないツールがある**（本書初版の copilot の例は実測で覆った。#1979 / §15.5）。判定規則はツールごとに定義して fixture で pin する。**完了マーカーを持たない claude / copilot / codex / gemini / antigravity では、この経路が唯一の完了証拠になる**。

   **copilot の実測（1.0.80・200x1000 ペイン・#1885 で着地。fixture: `tests/unit/lib/detection/fixtures/copilot-live-1885/`）**: copilot は代替画面に描き、chrome をペイン下端に固定する。composer `❯` は**下から 3 行目（1000 行ペインの 999 行目）に固定**で、応答本文の最終行の**約 930〜970 行下**にある（実測: `turn-complete.txt` は本文 65 行目 → composer 999 行目、`turn-running-thinking.txt` は 28 行目 → 999 行目）。さらに **composer は生成中も同じ形で描かれる**（4 fixture すべてで `❯ ` の 1 行）。したがって「`●` 応答行の直後に空の composer」という初版の例は 1.0.80 のどのフレームにも存在せず、これを規則にすると**生成中を ready と誤判定する**（#1885 の症状そのもの）。**copilot の肯定的完了証拠はペイン最下行のステータスバー**で、turn 中とその外で同じ 1 行が 2 通りに描き分けられる:
   - idle: `← open sidebar · / commands · ? help · tab next tab`（`COPILOT_IDLE_STATUS_PATTERN`）＝**完了の肯定的証拠**
   - 生成中: `● Working esc interrupt` / `◉ Working · 1.5 KiB esc interrupt`（`COPILOT_WORKING_STATUS_PATTERN`）

   読むのは**最下行のみ**（`readCopilotStatusBar`。下から最初の非空行で走査を止め、どちらでもなければ `null` ＝ 証拠なし）。窓で照合してはならない: `status-vocabulary-in-response.txt` は copilot 自身が ` ● Working esc interrupt` を本文として印字した実フレームで、窓照合だと完了済みセッションが恒久的に `running` に貼りつく。ダイアログ（`permission-dialog.txt`）と `/model` ピッカー（`model-picker.txt`）は最下行が別物なので `null` を返し、既存の `detectPrompt` / 選択リスト分岐へそのまま落ちる。
3. **構造化 `stop`**（自 turn に束縛されたもの、D3）。
4. **未開始（not-started）**: turn が一度も開いていない状態。この場合のみ `ready` / `input_prompt` を返す（`SessionStatus` 値は `ready` のまま。`idle` は「セッションが無い」の意味なので使わない）。

**前提条件とロールアウト順序（DR2-002）**: 本書の初版は「claude は既存の `⏺` + composer が完了マーカー」と書いていたが、**これは実装に存在しない**。`⏺` は `CLAUDE_SPINNER_CHARS` の 1 要素（`CLAUDE_THINKING_PATTERN`）＝ **running 側の証拠**である。したがって:

- **各 detector の「肯定確認された idle 証拠」規則（2 の実装）が D1 適用の前提条件**である。規則が無いツールで `input_prompt` 経路の evidence を `'none'` に倒してはならない。**規則は必ずそのツールの実フレームから起こす**（他ツールからの類推で書かない。copilot の初版の例が実測で覆った、#1979 / §15.5）。
- **ロールアウトはツール単位**とする（§8 Phase 3）。あるツールで (2) の規則と fixture（肯定ケース＋変異ケース）が揃うまで、そのツールの `input_prompt` は**現行どおり `ready` 相当**（`evidence: 'positive'`）として扱う。全ツール一斉に倒すと、通常の idle composer が `evidence: 'none'` に落ち、`TerminalEscapeHatch` が常時開き、`wait` の完了条件（`ready && !isUnclassifiedActive`）が成立しなくなる。
- 対応する子 Issue: opencode の idle composer（`Ask anything...`）は **#1883**、copilot は **#1885 / #1886**（§8 Phase 2）。

**決定 2 — 既存機構との統合（DR1-001 / DR1-003）**: 「証拠が読めない」を表す機構は #1708 で**既に出荷済み**である。本書は**新しい状態値・新しい exit code・新しいタイマーを作らない**。

- `sessionStatus` の値域は **4 値のまま**とし、`unknown` を追加しない。
- 代わりに `StatusVerdict` に **`evidence: 'positive' | 'none'`** を持たせ、`capture --json` には additive な optional フィールド `statusEvidence` として露出する。
- `isUnclassifiedActive` は **`evidence === 'none'` から導出**する互換フィールドに縮退させる。**現行定義 `(running && default) || (ready && no_recent_output)` との関係は経路ごとに異なる**（DR2-001。「すべての経路で真偽が変わらない」という初版の記述は §6.1 行(2) と自己矛盾していたため撤回する）。
  - `no_recent_output`（3）/ `default`（4）経路: **真偽は不変**（現行 `true`／移行後も `true`）。ここは既存 fixture で等価性を pin する。
  - `input_prompt`（2）経路: 現行は常に `false`。移行後は「肯定確認できなければ `true`」となるため、**意図的に `true` の範囲が広がる**。ここで等価性を pin してはならない（設計どおり実装すると必ず落ちる）。新たに `true` になる fixture を**別表で明示列挙**して pin する（§11）。
  - この拡大がガードを「読めないフレームで開く」方向にしか動かさないことは、消費者契約テスト（§11）で確認する。
- **pin の対象は `mergeStructuredStatus` 適用後（merged）の `isUnclassifiedActive` とする**（DR2-003）。`mergeStructuredStatus` は「構造化 `ready` × scraper `running`」のとき `isUnclassifiedActive` を `false` に潰す分岐を持ち、`no_recent_output` を `running` に倒すとこの分岐が新たに成立して真偽が `true` → `false` に反転する。scraper 単体 fixture の pin ではこの反転を検出できない（§5.2 の決定・§6.1・§11）。
- `wait` は既存の `UNCLASSIFIED_DWELL_MS`（60 秒）・**exit 10** ・`{ type: 'unclassified', options: [], status: 'pending' }`・`--on-prompt human` で待機継続、をそのまま使う。**`--unknown-timeout` は新設しない**（dwell を可変にする要求が出たら、既存 unclassified dwell のフラグ化として別 Issue で扱う）。`WAIT_EXIT_CODE_PRIORITY` / `shouldVerify()` / `--stall-timeout` / `--timeout` の関係は**現状のまま変更しない**（DR1-011 が問うた三つ巴は発生しない）。
- `UnclassifiedFrameRecord.sessionStatusReason` には経路ごとの理由コード（`default` / `no_recent_output` / 新設 `unknown_frame`）がそのまま入る。

**却下した代替案**:

| 代替案 | 却下理由 |
|---|---|
| `SessionStatus` に `unknown` を追加する | `src/cli/types/api-responses.ts` は値域を列挙し「CLI は稼働サーバより新しいのが常態」と明記している。今回は**逆向きの版スキュー**（新サーバ × 旧 CLI / 旧 skill）で、値そのものが未知になる。discoverability 規約 6 の「意味変更＝互換性破壊」に該当し、外部リポジトリの消費者（commandmate-skills の `orchestrate-monitor` は `capture --json` を主 signal にする）を壊す。加えて #1708 の `unclassified` と二重化し、運用者に「`unclassified` と `unknown` の違い」を毎回判断させる |
| 既定を `running` にする | 生成が止まったまま永久に running になる（#1900 の症状）。証拠コードごと見せるほうが運用者が判断できる |
| `wait` に専用 exit code を新設する | 上位 skill の分岐（exit 10 = 人間の判断が要る）を変えずに済む既存語彙があり、規約 2 の準拠例をそのまま継承できる |

**決定 3 — 「否定の不在 → ready」3 経路の移行後マッピング（DR1-002）**: §6.1 の表を正とする。要点は **`no_recent_output`（5 秒 stale ヒューリスティック）由来の `ready` を廃止する**こと、および **`default` の wire 値（`running`）は変えない**ことである。

**決定 4 — Auto-Yes との関係（DR1-006）**: Auto-Yes / response 系ポーリングは `sessionStatus` を**経由しない**。`src/lib/polling/response-checker.ts` の `detectPromptWithOptions`（`stripBoxDrawing(stripAnsi(...))` → `detectPrompt`）を直接呼ぶ（`src/lib/polling/` に `detectSessionStatus` / `sessionStatus` の参照は 0 件）。したがって「`unknown` では何もしない」という記述は**何も抑止しない**ため撤回し、次を決定とする。

- Auto-Yes が撃ってよいのは **D2 のツール別 `detectDialog` が肯定的にダイアログを返したとき**だけとする（`detectPrompt` の汎用な番号リスト推定だけでは撃たない）。これが #1896（返答本文の番号リストに `1` を送る）を止める唯一の位置である。
- 汎用推定が真でツール別 `detectDialog` が偽のときは撃たず、既存の露出面 `autoYes.lastSuppression` に **`reason: 'unclassified-frame'`** を載せる（規約 1）。`AutoYesSuppressionReason` は server（`auto-yes-resolver.ts`）と CLI（`api-responses.ts`）の双方向 pin テスト（`tests/unit/cli/config/cross-validation.test.ts`）を持つため、**両方の更新を同一 PR の受入条件**にする。

**決定 5 — send guard（DR1-007）**: `evidence: 'none'`（＝ `isUnclassifiedActive`）は **send をブロックしない**。ブロックするのは `waiting` のみで、その境界は既存 `blocksSend` のまま変更しない。#1901 の「`send` が `blockedBy: 'structured'` で拒否」型の実害を新しい経路で再生産しない。

**決定 6 — `wait` の `NOT_STARTED`(21) を再利用しない（DR1-016）**: 既存 `VerifyExitCode.NOT_STARTED`(21) は「作業証跡ゼロ」であり、`wait.ts` は「一度も running を見ていない」ときにだけ返す。**未開始（not-started）を新たに 21 の材料にしない**。「判定できなかった」と「判定して落ちた」を混ぜない、という同ファイルの設計注記に従う。

**ダイアログ系の肯定検出**: permission / ask_user / trust / ピッカーは**ツールごとに肯定的パターンを持ち**、検出したら必ず `waiting` と `promptDetection.options` を公開する。options を公開できない検出（selection_list 型）は `options: []` の理由を `sessionStatusReason` に載せる（既存規約に従う）。`respond` はその options で応答でき、opencode の permission は構造化 `decisionId` 経由の reply でも応答できる（D3 決定 3）。

### D2. 状態検出はツール別・バージョン付き・実フレーム駆動のモジュールにする

**決定**: `src/lib/detection/` を次の構造に再編する（既存の公開関数名 `detectSessionStatus` / `detectPrompt` / `getCliToolPatterns` は維持し、内部で委譲する）。

```
src/lib/detection/
  index.ts                  # detectSessionStatus / detectPrompt（ファサード、シグネチャ不変）
  shared/                   # stripAnsi / stripBoxDrawing / compactBlankRows / 共通 regex
  tools/
    <tool>/
      patterns.ts           # そのツールの regex。export const VERIFIED_AGAINST = { tool, version, capturedAt }
      detect.ts             # ToolStatusDetector 実装（優先順位つきの肯定検出）
      prompt.ts             # ダイアログ検出（options 抽出）。Auto-Yes もこれを読む（D1 決定 4）
      fixtures/             # 実 TUI キャプチャ（本番 geometry）。*.txt + *.expected.json
```

```ts
export interface ToolStatusDetector {
  readonly tool: CLIToolType;
  readonly verifiedAgainst: { version: string; capturedAt: string };
  /** 肯定的証拠のみで判定。証拠が無ければ { status: 'running', evidence: 'none', reason: 'unknown_frame' } */
  detect(frame: NormalizedFrame): StatusVerdict;
  /** Auto-Yes と共有する肯定的ダイアログ検出（D1 決定 4） */
  detectDialog(frame: NormalizedFrame): DialogVerdict | null;
}
```

- **fixture は実 TUI キャプチャのみ**。pane geometry は本番と同じ（claude / copilot 200x1000、opencode 80x200）。合成フレームは補助（エッジケース）に限り、`synthetic/` に分ける。
- `VERIFIED_AGAINST` と **live probe**: `src/lib/slash-command-catalog.ts` の `VERSION_PROBES` と同型の `DETECTOR_VERSION_PROBES` を持ち、インストール版 > `verifiedAgainst` のとき **`commandmate status`**（`doctor` は存在しないコマンドなので言及しない、DR2-023）と `capture --json` の `detector.staleness` に `{ tool, installed, verifiedAgainst }` を出す（規約 1・5）。CI では `npm run check:detector-freshness`（任意実行）で警告。
- **probe のコスト規約（DR1-018）**: `capture` はポーリング経路なので、`getCatalogStaleness()`（#1476 R3）と同じ **「プロセス内 1 回だけ実行し、in-flight を共有し、結果をキャッシュする」** 規約に従う。既存 `VERSION_PROBES` は claude / codex / antigravity の 3 件しかないため、残る probe コマンドは実装 Issue で確定する。
- **ホットパスでは probe を await しない（DR3-013・決定）**: 既存 `getCatalogStaleness` の呼び出し元は **`slash-commands` route の 1 箇所だけ**（実測）で、これは**運用者が起動した一度きりの操作**である。一方 `capture --json` / `current-output` は **5 秒ポーリング**（`wait` の `POLL_INTERVAL_MS`・tmux capture の `CACHE_TTL_MS` と同じ粒度）で、監視スキルは `MAX_POLLS=0` で回り続ける。`computeCatalogStaleness` と同型の実装は `VERSION_PROBES` の各ツールに対して子プロセスを `Promise.all` で spawn するため、**サーバ再起動直後の最初の 1 回だけが最大 7 プロセスの完了を待つ**ことになる。したがって: (a) `detector.staleness` は**キャッシュが温まるまで `undefined` を返す**（呼び出し側は「まだ分からない」として表示しない）、(b) probe は**バックグラウンドで開始**し、ホットパスは in-flight を待たない、(c) 温まったあとはプロセス内 1 回のキャッシュをそのまま返す。この「露出面ごとに待つ / 待たない を分ける」形は DR2-022（`capabilities` 本体をホットパスに載せない）と同じ方針である。

| ツール | probe コマンド | 実行体の解決（DR4-010） | 出所 |
|---|---|---|---|
| claude | `claude --version` | `which` 解決 → 絶対パスで `execFile` | 既存 `VERSION_PROBES` |
| codex | `codex --version` | 同上 | 既存 `VERSION_PROBES` |
| antigravity | **`agy --version`**（ツール id と実行ファイル名が違う、DR2-023） | 同上 | 既存 `VERSION_PROBES` |
| opencode | `opencode --version` | 同上 | **#1913 で着地済み**（`VERSION_PROBES` / `CATALOG_VERIFIED_AGAINST`。実測 develop `a175767a`） |
| copilot | **`resolveCopilotExecutable()` へ委譲**（解決された copilot 実体に `--version`。**`gh copilot -- --version` は使わない**、DR4-010 訂正） | `PATH` の `copilot` を絶対パス解決 → 実行可能な**通常ファイル**か検査 → `execFile`。無ければ gh 管理コピー（`$XDG_DATA_HOME`（既定 `~/.local/share`）`/gh/copilot`）を `statSync` で検査してから `execFile`。どちらも無ければ **null（子プロセスを 1 つも起動しない）** | **#1907 で着地**（`src/lib/cli-tools/copilot-executable.ts`）。`VERSION_PROBES` への接続は **#1913**（`kind:'delegated'`）。実測 develop `a175767a` |
| gemini | 新規（`gemini --version` 想定、実測で確定） | `which` 解決 → 絶対パスで `execFile` | Phase 3 で実測（#1913 の対象外） |
| vibe-local | 対象外（外部 CLI ではない） | — | — |

- **probe の実行面を広げないための規約（DR4-010・決定）**: probe を 3 → 7 に増やすと、`opencode` / `copilot` / `gemini` という**一般的な名前を PATH から解決して実行する**箇所が増える。サーバの PATH は起動シェル由来で、リポジトリローカルの `node_modules/.bin` を含む構成は珍しくないため、悪意あるリポジトリを worktree として開くだけで cold probe 時にサーバ権限で任意バイナリが走りうる。したがって: (1) **probe は起動に使う実行体と同じ解決方法で行う**（probe 対象と launch 対象を別物にしない）、(2) **コマンドは絶対パスに解決してから `execFile` する。解決できなければ probe をスキップし `detector.staleness` を `undefined` のままにする**（本 D2 の既定と整合）、(3) probe は `sanitizeEnvForChildProcess()` の env で起動する、(4) `timeout` に加えて **`maxBuffer` を明示**する。**加えて (5) probe は環境を変更してはならない**（インストール・ダウンロード・設定ファイル生成のいずれも起こさない）。version を知るためのヒントが副作用を持つと、`DETECTOR_VERSION_PROBES` を「ホットパスで安全に回せる」とした本 D2 の前提そのものが崩れる。PATH が信頼できない外部入力であることは §10 の「外部入力」に記載する。

- **copilot の probe を `gh copilot -- --version` から `resolveCopilotExecutable()` 委譲へ差し替える（DR4-010 訂正・決定。#1979）**: 初版は規約 (1) を「起動実体が `COPILOT_LAUNCH_COMMAND = 'gh copilot'` だから probe も `gh copilot`」と適用したが、**この具体的なコマンドは規約 (5) に違反する**。

  **実測（develop `a175767a`・gh 2.86.0 / copilot 1.0.80・macOS darwin 25.6.0）**:
  - `gh copilot --help` は gh 自身の文言で「`gh` will execute the Copilot CLI found in your `PATH`. **If the Copilot CLI is not installed, it will be downloaded to `~/.local/share/gh/copilot`**」と述べる。つまり未インストール環境で `gh copilot -- --version` を撃つと**リリースのダウンロードが始まる**（#1907 が実測。破壊的なので本 Issue では再実行していない）。
  - **`copilot` は gh の拡張ではない**（gh 2.86.0 に組み込まれた preview コマンド）。したがって `gh extension list` は copilot を**一切列挙しない**（本機で出力 0 行・exit 0）。「`gh extension list` から `github/gh-copilot` の版を読む」案は成立しない。
  - `gh extension list --json` は **`unknown flag: --json`**（gh 2.86.0）。この案も成立しない。

  **採る案**: `src/lib/cli-tools/copilot-executable.ts` の **`resolveCopilotExecutable()` に委譲する**（#1907 で着地、#1913 が `VERSION_PROBES` に `kind:'delegated'` で接続済み）。`PATH` の `copilot` → gh 管理コピー（`$XDG_DATA_HOME/gh/copilot`）の順に**実行可能な通常ファイルであることを `statSync` / `accessSync` で確かめてから**絶対パスで `--version` を撃ち、`GitHub Copilot CLI 1.0.80.` から版を読む。

  **これは DR4-010 の例外ではない。規約 (1) をより強く満たす**: `CopilotTool.isInstalled()` / `startSession()` が**同じ関数の同じ戻り値**で起動先を決めている（`launchExecutable()` は `source==='path'` なら `copilot`、gh 管理コピーなら `gh copilot`）ため、probe と launch が原理的に食い違えない。初版が別物だと見なした「起動実体 `gh copilot` と probe 対象 `copilot`」は、#1907 が起動側を PATH の `copilot` 優先へ移したことで解消している。規約 (2)(3)(4) も充足（絶対パス解決・`sanitizeEnvForChildProcess()`・`timeout` 5000ms・`maxBuffer` 64KiB）。

  **未インストール環境での無害性（使い捨て `PATH` / `HOME` / `XDG_DATA_HOME` で実測）**:

  | 環境 | 結果 | 起動した子プロセス | 副作用 |
  |---|---|---|---|
  | `copilot` も `gh` も PATH に無い | `null`（0 ms） | **0** | 無し |
  | `gh` はあるが `copilot` が PATH にも `$XDG_DATA_HOME/gh/copilot` にも無い | `null`（0 ms） | **0**（`gh` は `findOnPath` のゲートに使うだけで**実行しない**） | 無し。`$XDG_DATA_HOME/gh` は作られない |
  | `copilot` が PATH にある（本機） | `{path:'/opt/homebrew/bin/copilot', version:'1.0.80', source:'path'}`（358 ms） | 1（`copilot --version`） | 無し |

  いずれの scenario でもユーザーの `~/.config/gh`（`config.yml` / `hosts.yml`）は更新されず、`~/.local/share/gh` は作成されなかった。**「解決できなければ probe をスキップし `detector.staleness` を `undefined` のままにする」既定（規約 (2)）にそのまま合流する**ので、copilot だけを probe 対象から外す必要はない。
- **`detector.staleness` は `GET /api/capabilities` に載せない（DR4-008・決定）**: `{ tool, installed, verifiedAgainst }` は**ローカルにインストールされた CLI のバージョン一覧＝ソフトウェアインベントリ**であり、認証必須の `capture --json` / `commandmate status` に限って露出する。capabilities エンドポイントは静的トークン列だけを返す（§10 の「`GET /api/capabilities` の開示範囲」）。

- `ready` フォールバックと「否定の不在」分岐を禁止する **lint ルール**は現実的でないため、代わりに **各 detector の fixture セットに「証拠なし」期待ケース**（処理中語彙を 1 語変えたフレーム）を必須にするテスト規約で担保する（`tests/unit/detection/tools/<tool>/fixtures.test.ts` が全 fixture を走査）。この変異ケースは**受入条件**であり、緑の非空虚性はこれでしか証明できない（DR1-020）。
- **順序制約（DR1-015）**: `cli-patterns.ts` / `status-detector.ts` は S 群（#1893〜#1897）が共有するため、Epic #1891 は「1〜2 本ずつ直列マージ」を制約として置いている。D2 の分割（Phase 3）は **S 群が全てマージされた後に着手する**。

### D3. 構造化層は「ソース capability + 明示ターンモデル」にする

**決定 1 — capability の拡張**（`AgentSourceCapabilities`）: 追加項目は既存 3 項目と同様に **すべて JSON 直列化可能な宣言値**とする（DR1-005）。関数は置かない。

```ts
export interface AgentSourceCapabilities {
  // 既存
  readonly supportedEvents: readonly AgentEventType[];
  readonly configScope: 'per-instance' | 'per-worktree' | 'global-singleton' | 'none';
  readonly decisionTimeoutSeconds: number | null;
  // 追加（すべて宣言値）
  /** 非 allow の permission hook が「この後ダイアログが出る」ことを意味するか（claude: true / copilot, antigravity: false） */
  readonly permissionHookPredictsDialog: boolean;
  /** session_start が user_prompt_submit の後に届きうるか（copilot: true） */
  readonly sessionStartMayArriveLate: boolean;
  /** 承認の送達 / permission.replied が prompt-waiting の release になるか（opencode: true） */
  readonly permissionReplyReleasesPrompt: boolean;
  /** 重複判定に使うフレーム固有 id の【出所】。null なら時間窓 dedup にフォールバック */
  readonly eventIdentity: 'permission-id' | 'tool-call-id' | 'message-id' | null;
  /** 再接続後に状態を取り直す手段（pull 型のみ） */
  readonly resync: 'none' | 'session-status-poll';
}
```

id の**抽出そのもの**は各ソース実装（`sources/<tool>/`）の `AgentEventSource` メソッドに置く。capability は「どれを使うか」だけを宣言し、`capture --json` の `structuredEvents.source.capabilities` にそのまま載る（§7）。

状態機械（`agent-event-state.ts`、`permission-decision-service.ts`、`ingest.ts`）は **ツール名で分岐せず capability で分岐する**。

**受入指標は grep ではない（DR3-006・決定）**: 初版は `grep -n "=== 'copilot'\|=== 'opencode'\|=== 'claude'" src/lib/session src/lib/hooks` の **0 件**を D3 の受入指標に置いていたが、**この grep は着手前から状態機械では 0 件**である（実測: `src/lib/session` ＋ `src/lib/hooks` 全体でツール名の `===` 比較は 7 件、`sources/<tool>/` を除くと 6 件で、`agent-event-state.ts` / `permission-decision-service.ts` / `ingest.ts` には **0 件**）。Claude 前提は分岐ではなく**意味論**として埋め込まれている（最新イベント＝verdict、`PreToolUse` 非 allow ＝ダイアログ予告、3 秒窓 dedup）ため、変更の有無に関係なく緑になる **空虚な緑**である。したがって次を受入指標とする。

1. **`tests/unit/hooks/sources/capabilities.test.ts` が §4 D3 決定 1 の 6×5 宣言値表を完全一致で pin する**（件数ではなく値の全数一致）。
2. **変異ケース**: 各 capability について「宣言値を反転させると `tests/unit/session/turn-model.test.ts` のどのケースが赤になるか」を受入条件として明記する（DR1-020 と同じ形。反転して赤にならない capability は、その時点で状態機械が capability を読んでいない証拠）。
3. **`grep` を残す場合は「進捗指標ではない」と明示する**。0 件であることは着手前から真であり、D3 の実装有無を判定しない。

**ツール名の `===` 比較が実在する 6 箇所（実測・grep ゲートの対象はここ）**: いずれも状態機械の外側にあり、D3 ではなく **D4 / D1 の担当**である。ファイル単位のゲートを掛けるならこの 3 ファイルに掛ける。

| ファイル | 箇所 | 内容 | 帰属 |
|---|---|---|---|
| `src/lib/session/claude-session.ts` | 1 | セッション名の primary anchor（`!instanceId \|\| instanceId === 'claude'`） | **ガード対象外**（#868 の primary anchor 規約。§4 D5 決定 4 のスコープ外＝Claude 固有モジュール） |
| `src/lib/session/send-user-message.ts` | 2 | copilot の生 `sendKeys` 分岐（`copilotModel && cliToolId === 'copilot'` ほか） | **D4 / #1906 が削除する**（`cliTool.sendMessage` へ統一） |
| `src/lib/session/worktree-status-helper.ts` | 3 | `getStatusCaptureLines` の opencode / gemini 分岐（2 件）と Claude 限定 health check（1 件） | **D4 の `captureSpec()` へ寄せる（2 件、DR3-014）／ health check 1 件は §12 で扱いを決める** |

**6 ソース × 5 capability の宣言値（DR1-013）**: `tests/unit/hooks/sources/capabilities.test.ts` はこの表を pin する。「未検証」は Epic #1891 の実測範囲外（claude / codex / gemini / vibe-local は未監査）であることを意味し、既定値は **claude の現行挙動と等価**になるよう選ぶ。

**`permissionHookPredictsDialog` の判定軸（DR2-014）**: 根拠は `supportedEvents` **ではなく**、「そのソースが **permission hook（`PermissionRequest` / `PreToolUse` → `/api/hooks/permission-request`）を登録しており、その非 allow がダイアログの予告になるか**」である。`supportedEvents` は型コメントが「delivered であって emittable ではない」と明記しており、`pre_tool_use` が無いのは gemini だけでなく codex / copilot / antigravity も同じなので判定軸に使えない。permission hook を登録しているのは claude / codex / copilot / antigravity / opencode で、**gemini だけが登録していない**（`reportPendingDialog` は `resolvePermissionRequest` の中でだけ呼ばれる）。

| ソース | permissionHookPredictsDialog（根拠は permission hook の登録有無と予告性） | sessionStartMayArriveLate | permissionReplyReleasesPrompt | eventIdentity | resync | 既存 decisionTimeoutSeconds（＝送達期限。§4 D3 決定 2） |
|---|---|---|---|---|---|---|
| claude | `true`（permission hook を登録。非 allow がダイアログ予告＝実測・現行挙動） | `false` | `false` | `null` | `'none'` | `PERMISSION_REQUEST_TIMEOUT_SECONDS`（5） |
| codex | `true`（permission hook を登録。予告性は未検証／既定＝claude 相当） | `false`（未検証） | `false` | `null` | `'none'` | `5` |
| gemini | `false`（**permission hook 自体を登録していない**＝実測） | `false`（未検証） | `false` | `null` | `'none'` | `0`（＝「hook が verdict を待たない」。即 release の意味ではない） |
| copilot | `false`（permission hook は登録するが全ツール呼び出しで発火し大半は即実行＝#1901 実測） | `true`（#1903 実測） | `false` | `null`（未検証。`tool-call-id` は要実測） | `'none'` | `COPILOT_HOOK_TIMEOUT_SECONDS`（10） |
| opencode | `false`（hooks ではなく SSE。裁定は自分が行う） | `false` | `true`（#1898 実測） | `'permission-id'`（#1899 実測） | `'session-status-poll'`（#1900） | `null`（送達期限なし） |
| antigravity | `false`（permission hook は登録するが裁定は受信側。ダイアログ予告にならない） | `false`（未検証） | `false` | `null` | `'none'` | `ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS`（5） |
| vibe-local | ソース実装なし（ツール 7・ソース 6 の差分） | — | — | — | — | — |

**`configScope: 'global-singleton'` は宣言値であって安全性の保証ではない（DR4-013）**: copilot の `~/.copilot/settings.json` は**全 CommandMate サーバ / 全インスタンスで共有される 1 ファイル**であり、`commandmate start --issue N --auto-port` による複数サーバ同時稼働（CLAUDE.md の公式機能）では**最後に書いた者が勝つ**。capability の宣言値は「設定の粒度」を表すだけで、書き込みの原子性・排他は表さない。書き込み規約は §10「global-singleton 設定ファイルの書き込み規約」に置く。

**決定 2 — ターンモデル**: 「最新イベント＝verdict」を廃し、instance ごとに turn レコードを持つ。

```ts
interface TurnRecord {
  // turnId / sessionId / pendingDecisions[].id はすべて【ソース入口で検証済み】の文字列である（§10「外部入力」）。
  // 検証は長さ上限＋文字種の allowlist で行い、外れた値は【破棄】する（切り詰めない、DR4-001）。
  turnId: string;            // user_prompt_submit の identity（message id / hook の prompt id / 受信時刻）
  sessionId: string | null;  // pull 型では opencode の sessionID。stop はこの sessionId のものだけ受ける
  openedAt: number;
  closedAt: number | null;
  closedBy: 'stop' | 'session_end' | 'stale' | 'scraper_evidence' | 'resync_idle' | 'generation' | null;
  /** この turn を開いた世代（`beginAgentEventGeneration` の `generationStartedAt`）。DR3-003 */
  generationAt: number;
  /** 表示専用（structuredEvents.lastEventType / lastEventDetail）。新規コードで状態導出に使ってはならない
   *  （DR1-019。既存 wait.ts の adoptTurnStart は turnId / openedAt へ移行するまでの経過措置、DR2-007） */
  displayEvent: AgentEventRecord;
  pendingDecisions: PendingDecision[];
  // PendingDecision = { id, toolName, raisedAt, decidedAt?, delivered?, deliveryExpired?, releasedBy?: 'reply' | 'dialog_timeout' | 'policy_rechecked' }
  // PendingDecision は受信 payload を【まるごと保持しない】（現行 opencode payloads.ts の `raw: payload` を引き継がない）。
  // deny パターン照合に要る部分だけを上限つきで切り出して持つ（DR4-009）。
}
```

**前提 — TurnRecord は既存の generation フェンスの配下に置く（DR3-003・必須）**: `agent-event-state.ts` の状態は `(worktreeId, cliToolId, instanceId)` の合成キーで保持され、**再作成されたセッションは同じキーを再利用する**。このため #1723 は `beginAgentEventGeneration` で `generationStartedAt` を打ち、既存 getter（`isAwaitingInstruction` / `getStructuredSessionState` / `getStructuredPromptWaiting` / `getAskUserQuestion`）が **`record.at < generation` のレコードを一律に捨てる**設計になっている（同関数はダイアログ（#1725）とモデル（#1783）も明示的にクリアする）。turn モデルはこのフェンスを**必ず継承する**。

- `beginAgentEventGeneration` は **open turn を `closedBy: 'generation'` で閉じ、`pendingDecisions` を破棄する**（破棄は無言で行わず、§10 の `decision_evicted` と同じ扱いで件数を露出する）。
- **`openedAt < generationStartedAt` の turn は導出に使わない**（`generationAt` が現世代と一致する turn だけを読む）。
- 理由: §5.2 の優先順位 2 は「open turn がある → `running`」を scraper の肯定的証拠より上位に置く。前世代の open turn が残ると、**まだ誰も打鍵していない新規セッションが `turnStaleAfterMs`（＝ `STRUCTURED_STATE_MAX_AGE_MS` の 30 分）にわたって `running` を publish する**。これは #1723 が「`wait` が新品の idle セッションを `--timeout` まで待つ」として塞いだ回帰そのもので、窓が 30 分に伸びる。`tests/unit/session/agent-event-generation-1723.test.ts` は実 `startClaudeSession` / `stopClaudeSession` を駆動しているため、フェンスを踏まえずに実装すると**このテストが赤になる**。

導出規則:

- `running` ⟺ open turn がある（`closedAt === null`）かつ `pendingDecisions` に未裁定が無い**かつ `generationAt` が現世代と一致する**（DR3-003）。
- `waiting` ⟺ 未裁定の decision がある、または（`permissionHookPredictsDialog` なソースで）ダイアログ予告の暫定記録が生きている。裁定済み・送達済みの decision は即 release（`permissionReplyReleasesPrompt`）。
- verdict を持たないイベント（`session_start` / `session_end` / 未知の notification）は **open turn を閉じない**。`sessionStartMayArriveLate` なソースでは turn 開始後の `session_start` を `displayEvent` にもしない（この capability の**残差挙動はこの 1 点のみ**。`false` のときは表示が `session_start` に書き換わるだけで状態は変わらない、DR1-017）。
- `stop` は `sessionId` が一致する turn だけを閉じる（サブエージェント session の idle で親を閉じない）。
- **turn の期限（DR1-004）**: open turn は `turnStaleAfterMs`（既定は現行の 30 分 staleness bound と同値）を過ぎたら `closedBy: 'stale'` で閉じ、以後は scraper 判定に委ねる。
- **scraper 証拠による強制クローズ（DR1-004）**: open turn 中に scraper の**肯定的完了証拠**（`evidence: 'positive'` かつ `ready`）が 3 ポーリング連続で観測され、その間に構造化イベントが 1 件も来ていなければ `closedBy: 'scraper_evidence'` で閉じる。
- **decision の期限は 2 本に分ける（DR1-004 / DR2-004 で改訂）**: 初版は `decisionTimeoutSeconds` を release 期限に流用していたが、この値は**エージェントが verdict を待つ hook 応答の予算**（実測: claude `PERMISSION_REQUEST_TIMEOUT_SECONDS`=5 / codex 5 / gemini 0 / copilot `COPILOT_HOOK_TIMEOUT_SECONDS`=10 / opencode `null` / antigravity `ANTIGRAVITY_PERMISSION_TIMEOUT_SECONDS`=5）であって、**人間がダイアログを見て裁定するまでの時間ではない**。そのまま実装すると push 系の全ソースで permission ダイアログが 5〜10 秒（gemini は 0 秒）で `waiting` から外れ、#1725 が閉じた「ダイアログが出ているのに running」が再発する。
  - **(a) 送達期限 ＝ `decisionTimeoutSeconds`（capability の宣言値）**: CommandMate が**自動裁定を返せる猶予**。過ぎたら `deliveryExpired: true` を立て、自動裁定を諦めて**人間の裁定待ちへ移す**。**`waiting` は維持する**（hook がタイムアウトしても TUI にはダイアログが残るため）。`0`（gemini）は「hook が verdict を待たない」の宣言であって「即 release」ではない。`null`（opencode）は送達期限なし。
  - **(b) 保持期限 ＝ `dialogPendingMaxMs`（新設。CommandMate 側の運用値なので capability には置かない）**: 未裁定ダイアログを `waiting` として保持する上限。既定は**既存の人間向け期限に揃える**。`permissionHookPredictsDialog` 由来の**予告だけの暫定記録**は既存 `STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS`（20 秒）をそのまま使い、**実イベント由来の未裁定 decision** は `turnStaleAfterMs`（＝ `STRUCTURED_STATE_MAX_AGE_MS` の 30 分）と同値とする。超過時の理由コードは `releasedBy: 'dialog_timeout'`（初版の `decision_timeout` は「送達期限」と紛らわしいので改名）。
  - release の第一義は期限ではなく**肯定的な解消**（`reply` / `permission.replied` / `post_tool_use` / `stop` / ポリシー再裁定）である。期限は最後の安全弁として扱う。
- 重複判定は `eventIdentity` が宣言する id で行い、`null` のソースだけ時間窓を使う。**ライフサイクル系イベント（`stop` / `session_end`）は時間窓 dedup の対象外**とする（#1899 の「短い turn の `stop` が 3 秒窓で消える」は固有 id が無いことに起因するため、identity ではなく対象外化で塞ぐ）。**dedup 集合には instance ごとの上限を置く**（既存 `MAX_RECENT_EVENT_KEYS`=512 と同じ定数族。`resyncPending` の契機を一般化すると id の churn が増えるため、DR4-009）。
- 再接続（pull 型）は `resync: 'session-status-poll'` に従い `GET /session/status` と `GET /permission` を読み、busy なら turn を再武装、idle かつ open turn があれば `stop` を合成（`closedBy: 'resync_idle'`）。
- **再接続のたびに identity を確かめてからストリームを信じる（DR4-004・必須）**: 再接続ループは `readOpencodeEventStream` を開く前に **`/global/health` を通し、`version` が前回と一致すること**を確認する。一致しなければ（＝ port に別プロセスが居る）ストリームを開かず scraper へ降格し、理由コード **`port_identity_changed`** を運用者層に出す。**`resync_idle` による `stop` の合成も、この health チェックを通過した後にだけ行う**。health を通さないと、loopback に居る別プロセスが `stop` フレーム 1 本、あるいは `GET /session/status` の `{"ses_x":{"type":"idle"}}` 1 応答だけで `commandmate wait` を exit 0（完了）に化けさせられる（信頼境界の詳細は §10「opencode ポートの信頼境界」）。
- **replay の採用件数に上限を置く（DR4-009）**: `GET /permission` / `GET /question` の replay は 1 回あたりの採用件数に上限（例 50）を持ち、超過分は `decision_evicted` と同じ理由コードで**件数を露出**する（無言で落とさない、DR1-021 と同じ規律）。

**決定 3 — 保留 decision の再裁定と `respond`（DR1-012）**:

- `pendingDecisions` は **ポリシー変更時に再裁定される**。契機は (1) SSE / hooks の再接続、(2) **Auto-Yes の有効化・ポリシー変更**（#1898-2: 後から Auto-Yes を有効にしても保留 permission が裁定されない）、(3) `respond` の到達、(4) roster の変更。`resyncPending` を「再接続時のみ」から「上記契機の一般化」に広げる。
- **`respond` は scraper の `promptData` が無くても `pendingDecisions[].id` で応答できる**（#1898-3）。対象は **`src/app/api/worktrees/[id]/prompt-response/route.ts`**（`src/cli/commands/respond.ts` が実際に叩く経路。pane を再キャプチャして `detectPrompt` を回す ID 不要のルートで、**すでに `getAskUserQuestion`（構造化）を参照する前例がある**）と `src/cli/commands/respond.ts` である（DR2-010）。**初版が挙げていた `respond/route.ts` は `messageId` 必須の Web UI 経路**であり、そこを直しても CLI `respond` は経路が違うため #1898-3 は解消しない。**`respond/route.ts`（Web UI の `messageId` 経路）は Stage 3 で対象に加えた（DR3-007）**: `#1898-3` の実装先は `prompt-response/route.ts` のままだが、`PromptPanel` を構造化 decision の受け皿にする以上、**Web UI から応答できる口（`PromptPanelProps` の `decisionId` と `respond/route.ts` の `messageId` optional 化）を Phase 4 で用意する**（§6.2 / §8 Phase 4 / §12）。番号 / ラベル → id の変換は server 側で行う（§10 のセキュリティ制約：id は SSE で受けたものだけを使う）。
- **`decisionId` の解決スコープは resolve 済み target に閉じる（DR4-003・必須）**: `pendingDecisions` は `(worktreeId, cliToolId, instanceId)` の合成キーで保持されるのに、`respond` の入力は worktreeId ＋ 任意文字列である。したがって **`resolveSessionTarget` が返した (worktreeId, cliToolId, instanceId) の `pendingDecisions` の中だけ**を探す。**全 instance / 全 worktree を横断検索する実装を書いてはならない**（横断検索は worktree A への `respond` が別 instance の permission を承認し、しかも opencode の reply は port 単位なので**別の port へ送られる**）。解決できない id は **404 `decision_not_found`** を返し、`replyOpencodePermission` / 各 `source.deliverVerdict` へ渡さない（「見つからなければそのまま送る」フォールバックを作らない）。同じ規則を Phase 4 の `respond/route.ts` / `PromptPanelProps.decisionId` にも適用する。**既存の `respond/route.ts` は `getMessageById(db, messageId)` を引くだけで `message.worktreeId` と URL の `:id` を照合していない**（実測。所属未照合の前例）。**Phase 4 はこの前例を繰り返さず、併せて既存 `messageId` 経路にも所属照合を追加する**。
- dedup で落としたイベント数は `promptDedup`（#1695 の前例）と同型のカウンタで露出する（§7）。

**互換性（DR2-007 で改訂）**: `getStructuredSessionState` / `getStructuredPromptWaiting` / `getLastStopEventAt` の戻り値型は維持し、内部を turn レコードから導出する。

- **`turnStartedAt` は API のフィールドではない**。実体は `src/cli/commands/wait.ts` のローカル変数で、`adoptTurnStart` が `structuredEvents.lastEventType` が `TURN_OPENING_EVENT_TYPES` に含まれるかを見て決めている。`src/cli/types/api-responses.ts` に存在するのは `lastStopEventAt` と `structuredEvents.lastEventType` / `lastEventAt` である（初版の「`turnStartedAt` 契約（`api-responses.ts`）」という記述は誤り）。
- **`structuredEvents` に turn フィールドを additive に追加する**: `turnId` / `openedAt` / `closedAt` / `closedBy`（および `lastTurn`）。**`wait` の `adoptTurnStart` は採用元をこれらに移行する**（`openedAt` を `turnStartedAt` の出所にし、turn の同一性は `turnId` で判定する）。`lastEventType` / `lastEventAt` は**そのまま残す**（既存 CLI / skill の分岐を壊さないため、削除も意味変更もしない）。
- **DR1-019 の「`displayEvent` を状態導出に使ってはならない」は新規コードに対する規範**であり、出荷済みの `adoptTurnStart`（#1839 の「composer に戻っただけで `Stop` が来ていない turn を完了と呼ばない」ゲート）は **`turnId` / `openedAt` への移行が完了するまでの経過措置**として例外扱いとする。移行前に #1839 のゲートを外してはならない。
- `closedBy` は `wait` の完了出力にも既存 `COMPLETION_BASIS`（`hook_stop` / `session_gone` / `scraper_ready`）と揃えた語彙で出す。

### D4. `CLITool` を唯一のゲートウェイにする

**決定**:

- **`ICLITool` 経由を必須とするのは `killSession` / `sendMessage` / `interrupt` / `isRunning`（＋既存の `startSession` / `getSessionName` / `isInstalled`）である**。route / CLI / poller / job-executor から `src/lib/tmux/**` を import しない。**`capture` は `ICLITool` に存在しないため、初版の 5 メソッド列挙から外す**（DR2-012）。
- **capture の扱い（DR2-012・決定）**: capture の実体は `src/lib/session/cli-session.ts` の `captureSessionOutput` / `captureSessionOutputFresh` である。これを **第 2 の公認ゲートウェイ**とし、`ICLITool.capture` は**追加しない**。ツール固有の capture 挙動（#1910 の alt-screen など）はメソッドではなく**ツールの宣言**として受け取る（`describeComposer()` と同じ形）。§5.1 の図も `tmux capture（captureSessionOutput）` と読む。
- **`ICLITool` に追加するもの**: `describeComposer(): ComposerSpec` / `gracefulExitSequence(): KeySequence` / `captureSpec(): CaptureSpec` は **`ICLITool`（型）に追加**し、`BaseCLITool` に claude 相当の既定実装を置く（消費者が型経由で参照するため、`BaseCLITool` だけに置くのでは足りない、DR2-012）。
- **禁止パターンは実測した 3 綴りを全部押さえる（DR3-001・訂正）**: 禁止する import パスは **`@/lib/tmux/**`・`**/lib/tmux/**`・`./tmux/**`** の **3 つ**とする。初版の 2 つ（`@/lib/tmux/**` と相対 `**/lib/tmux/**`）では、`src/lib` 直下から `'./tmux/tmux'` の形で import している **6 ファイル**（`auto-yes-poller` / `pasted-text-helper` / `prompt-answer-sender` / `session-cleanup` / `session-key-sender` / `ws-server`）が**素通りする**（実測。`no-restricted-imports` は import 文字列に対する glob 一致であり、`./tmux/tmux` は `lib/tmux` を含まない）。**severity は `error`**（DR1-010）。`package.json` の `lint` は `eslint src --ext …` で `--max-warnings` を持たないため、`warn` では #1915 の受入条件「`npm run lint` が検出する」を満たさない。
- **陽性対照を先に撃つ（DR3-001）**: パターンの妥当性は「**allowlist を空にしたとき §16 付録 A の 31 ファイルが全件 error になる**」ことで確認してから allowlist を入れる。31 件に届かないパターンは、届かない分だけ**無音の穴**である。
- **型のみ import の扱い（DR3-001・決定）**: `src/components/worktree/NavigationButtons.tsx` と `src/components/worktree/TerminalEscapeHatch.tsx` は `import type { NavigationKey } from '@/lib/tmux/tmux'` の**型のみ import** である。ESLint コアの `no-restricted-imports` には `allowTypeImports` が**無く**、持っているのは `@typescript-eslint/no-restricted-imports`（`next/typescript` 経由で利用可能）だけである。**本書は「`NavigationKey` を tmux 以外の型モジュールへ移し、コアルールのまま運用する」を採る**。理由: (a) ルール名を差し替えると、ガードテスト（`tmux-import-allowlist.test.ts`）が pin する対象（ルール名・設定形）も変わり、tmux 以外の禁止パターンまで型認識ルールの設定モデルに載せることになる、(b) `allowTypeImports: true` は **client → `lib/tmux` の依存辺を恒久的に正当化**し、「`import type` の `type` を 1 語消すと値 import になる」経路を残す（D4 が消そうとしている層越えそのもの）、(c) 実作業は `NavigationKey`（`src/lib/tmux/tmux.ts` の `NAVIGATION_KEY_VALUES` 由来）を型モジュール（例 `src/types/terminal-keys.ts`）へ移し `lib/tmux` 側がそこから import する **定義 1・参照 2 ファイル**で足りる。**移設が Phase 1 に間に合わなくても lint は緑のまま**である（この 2 ファイルは Phase 1 の baseline allowlist に含まれ、allowlist は減らすことしか許されないため）。
- **`no-restricted-imports` は `no-restricted-syntax` とは別ルール名なので、`overrides` で allowlist を書いても i18n ガード（`no-restricted-syntax`）を失効させない**（DR2-005）。1 ルール 1 severity・`overrides` は置換、という ESLint の制約を受けるのは D5 の `'claude'` ガード側だけである（§4 D5 決定 4）。
- **allowlist は件数ではなく「ソート済みのパス列挙」として pin し、完全一致で検証する**（件数 pin は「1 件解消・1 件追加」で緑になるため不可）。**追加は禁止、削除のみ許可**。
- **Phase 1 は develop を赤くしない（DR3-001・必須）**: `npm run lint` は develop `90b67eb9` で **exit 0 / 出力 0 行**（実測）。したがって Phase 1 で投入するガードの allowlist の**初期値は §16 付録 A の実測 31 ファイル全件**とする（＝投入直後も lint は 0 error）。「あるべき姿の allowlist」を先に書いて既存違反を error にすると、**Epic #1891 の子 Issue 22 本の CI が、その PR と無関係に一斉にブロックされる**（`gh pr list --state open` は 0 件なので今止まる PR は無いが、以後に立つ全 PR が止まる）。allowlist は以後**減らすことだけ**が許される。
- **既存 importer の内訳（実測 31 ファイル・6 カテゴリ。DR3-001 で全面改訂）**: 初版の 2 区分表は `src/app/api` の 11 件と `src/cli/commands/capture.ts` の 1 件しか扱っておらず、**14 ファイルが未計上**だった（`src/lib/session/**` も「`captureSessionOutput` 実装のみ」ではなく実際は 5 ファイル）。全件を次の 6 行に帰属させる（ソート済みパス列挙は §16 付録 A、影響範囲の再掲は §9）。

| カテゴリ | ファイル数 | 対象と使用 API | 区分 | 解消の道筋 |
|---|---|---|---|---|
| routes（`src/app/api/**`） | 11 | assistant 5（`hasSession` / `capturePane`）／ `worktrees/route.ts`・`worktrees/[id]/route.ts`（`listSessions`）／ `worktrees/[id]/{capture,kill-session,special-keys,terminal}`（`capturePane` / `killSession` / `sendKeys` / `invalidateCache`） | 恒久除外 7 ＋ 段階解消 4 | 下の routes 内訳表のとおり。段階解消 4 件は Phase 2 |
| pollers | 4 | `src/lib/auto-yes-poller.ts`（`invalidateCache`）／ `src/lib/polling/assistant-conversation-poller.ts`（`hasSession`）／ `src/lib/polling/global-session-poller.ts`（`hasSession`）／ `src/lib/polling/response-checker.ts`（`CACHE_MAX_CAPTURE_LINES` / `isCaptureWindowSaturated`） | **段階解消（4）** | D4 は禁止対象に poller を名指ししているのに、初版はこの 4 本をどちらの区分にも置いていなかった。**読み取りは第 2 のゲートウェイ（`captureSessionOutput`）と `ICLITool.isRunning` 経由に寄せ、キャッシュ無効化と capture 上限は `session` ファサード**（`src/lib/session/` に `invalidateSessionCache()` / `getCaptureWindow()` を新設し、行数は `ICLITool.captureSpec()` から取る）を通す。Phase 2（#1905 / #1906 と同じ層） |
| ws / broadcast | 6 | `src/lib/ws-server.ts`（control-mode transport / flags / metrics）／ `src/lib/realtime/terminal-broadcast.ts`（`invalidateCache`）／ `src/lib/session-key-sender.ts`・`src/lib/prompt-answer-sender.ts`（`sendKeys` / `sendSpecialKeys` / `invalidateCache`）／ `src/lib/pasted-text-helper.ts`（`capturePane` / `sendKeys`）／ `src/lib/session-cleanup.ts`（`killSession` / `hasSession` / `clearAllCache`） | **恒久除外 1（`ws-server`）＋ 段階解消 5** | キー送出系（`session-key-sender` / `prompt-answer-sender` / `pasted-text-helper`）は `ICLITool.sendMessage` と special-keys 経路へ、`session-cleanup` は `ICLITool.killSession` へ、`terminal-broadcast` のキャッシュ無効化は上記ファサードへ寄せる。**`ws-server` の control-mode transport / flags / metrics は tmux トランスポートそのもの**で対応する `CLITool` メソッドが存在しないため**恒久除外** |
| client（型のみ import ＋ フラグ参照） | 4 | `src/components/worktree/NavigationButtons.tsx`・`src/components/worktree/TerminalEscapeHatch.tsx`（`import type { NavigationKey }`）／ `src/components/Terminal.tsx`・`src/app/worktrees/[id]/terminal/page.tsx`（`isTmuxControlModeEnabledForClient`） | **段階解消（4）** | 型 2 件は `NavigationKey` の型モジュール移設で解消（上記決定。`allowTypeImports` は採らない）。フラグ 2 件は `isTmuxControlModeEnabledForClient` を client 安全モジュール（`src/config/` か `src/lib/browser-compat/`）へ移設して解消 |
| cli（`src/cli/**`） | 1 | `src/cli/commands/capture.ts`（`../../lib/tmux/transcript-squeeze`。`src/cli/**` の違反はこれだけ） | 恒久除外 | tmux プロセスに触れない純粋な文字列関数で、D4 が防ごうとしている「ツール固有の前後処理の迂回」に当たらない。`src/lib/text/` 等へ移設できたら allowlist から外す（別 Issue） |
| session（`src/lib/session/**`） | 5 | `cli-session.ts`（`session-transport` / `polling-tmux-transport` / `tmux-capture-cache`）／ `current-output-builder.ts`（`tmux-capture-cache`）／ `claude-session.ts`（`tmux`）／ `send-user-message.ts`（`tmux` / `tmux-capture-cache`）／ `worktree-session-reconcile.ts`（`tmux` / `control-mode-tmux-transport`） | **恒久除外 3 ＋ 段階解消 2** | **`cli-session`（`captureSessionOutput` の実体）と `current-output-builder`（capture キャッシュの読み手）は第 2 の公認ゲートウェイ本体なので恒久除外**。**`worktree-session-reconcile` も `listSessions` / `renameSession` を使っており、`src/app/api/worktrees/route.ts` と同じ理由（対応する `CLITool` メソッドが無い）で恒久除外**。`send-user-message` の生 `sendKeys` は **#1906 が削除**、`claude-session` は `ICLITool`（`startSession` / `isRunning` / `killSession`）へ寄せる |

**routes 11 件の内訳（初版の 2 区分表を維持）**:

| 区分 | 対象 | 理由 |
|---|---|---|
| 恒久除外 | `src/app/api/assistant/{conversation,current-output,session,start,terminal}/route.ts`（5 件） | `hasSession` / `capturePane`。Assistant Chat のセッションには対応する `CLITool` インスタンスが存在しない |
| 恒久除外 | `src/app/api/worktrees/route.ts`、`src/app/api/worktrees/[id]/route.ts`（2 件） | `listSessions`（tmux セッションの全列挙）に対応する `CLITool` メソッドが無い |
| 段階解消 | `src/app/api/worktrees/[id]/{capture,kill-session,special-keys,terminal}/route.ts`（4 件） | 対応する経路がある（`capture` は `captureSessionOutput`、他は `CLITool` メソッド）。Phase 2 で置換する |

**区分の合計（ファイル単位。allowlist もファイル単位で pin する）**: **恒久除外 12 ファイル**（assistant 5 ／ routes の `listSessions` 2 ／ `cli/commands/capture.ts` 1 ／ `cli-session` + `current-output-builder` + `worktree-session-reconcile` 3 ／ `ws-server` 1）、**段階解消 19 ファイル**（routes 4 ／ pollers 4 ／ ws・broadcast 5 ／ client 4 ／ session 2）。合計 31。**「削除のみ許可」の進捗対象は段階解消の 19 ファイルに限り、恒久除外 12 ファイルは進捗指標に数えない**。区分ごとの全件は **§16 付録 A**。
- **間接迂回の限界を明記する（DR1-010）**: `no-restricted-imports` は import パスしか禁じないため、allowlist 対象（`src/lib/session/**` の一部）を経由すればゲートウェイを迂回できる。lint は迂回の**全数保証をしない**。補完として「`kill-session` route が `CLITool.killSession` を呼ぶ」ことを直接検証する**陽性テスト**を受入条件に置く。
- **動的 import の扱い（DR4-005・訂正。初版の「同じ制限の対象とする」は撤回する）**: **ESLint 8 系（本リポジトリは `^8.57.0` / node_modules 実測 8.57.1）の `no-restricted-imports` は静的 `import` と `export … from` しか検出しない**。隔離環境の実測では、同じ `patterns` 設定に対して `import … from './lib/tmux/tmux'` と `export * from './lib/tmux/tmux'` は error になったが、**`await import('./lib/tmux/tmux')` と `require('./lib/tmux/tmux')` は 1 件も報告されなかった**。コアルールは `ImportExpression` / `CallExpression(require)` を見ないためである。したがって「動的取得も同じ制限の対象」という初版の記述は**成立せず、そのまま出荷するとガードが偽の安心を与える**（本リポジトリは Next.js の ALS 対策で `await import()` を実際に使う方針を持っており、動的化が「ガードを外す作法」として定着する余地がある）。決定は次のとおり。
  - **(a) 動的取得は `no-restricted-syntax` の別セレクタで捕まえる**: `ImportExpression[source.value=/(^|\/)(lib\/)?tmux\//]` と `CallExpression[callee.name='require'][arguments.0.value=/(^|\/)(lib\/)?tmux\//]` を、D5 決定 4 (1) で `error` へ格上げする既存 i18n セレクタと**同じ配列**に足す（1 ルール 1 severity・`overrides` は置換、という制約と両立させるため、`no-restricted-syntax` は base の 1 キーにセレクタを並べる形を保つ）。**現状 0 件なので allowlist は持たせず、例外を作らない**。
  - **(b) 同じ綴りを vitest ガード側にも二重化する**: `tests/unit/guards/tmux-import-allowlist.test.ts` が `import\(\s*['"][^'"]*tmux` / `require\(\s*['"][^'"]*tmux` を検出する（ESLint 設定の改変だけでガードが消えないようにする）。
  - **(c) 陽性対照を 2 つ増やす**: dynamic import 版と require 版の fixture を用意し、**それぞれが赤になることを確認してから** allowlist（静的 import 側の 31 件）を入れる。赤にならないパターンは無音の穴である。
  - **(d) 再エクスポート経由の抜け穴を Phase 1 で閉じる**: `export * from` 自体はコアルールで検出できるが、**allowlist 済みモジュールが tmux シンボルを再エクスポートすると、その先の import は完全に無検出**になる。**`src/lib/session/index.ts` は既に `export * from './claude-session'` を持つ**（`claude-session.ts` は tmux の段階解消対象）ため、これは仮定ではなく実在の経路である。「allowlist 済みモジュールが tmux シンボルを再エクスポートしないこと」を別の pin（陽性対照つき）で担保する。
- ツール固有の挙動はツールクラスに閉じる: copilot の送信（改行の扱い・`SELECTION_LIST_COMMANDS`）、opencode の二度 Esc・`/exit` の本文/Enter 分離、opencode の SSE release。`sendMessageWithSubmitVerification` は **composer 定義**（入力行の認識・プレースホルダ・wrap の扱い）をツールから受け取る。
- `BaseCLITool` に `describeComposer(): ComposerSpec` / `gracefulExitSequence(): KeySequence` / `captureSpec(): CaptureSpec` の既定実装（claude 相当）を置き、**型は `ICLITool` に足す**（上記）。
- **`KeySequence` は「本文」と「キー名」を型で分ける判別可能 union にする（DR4-011・決定）**: `src/lib/tmux/tmux.ts` の `sendKeys` は `tmux send-keys -t <target> <keys> [C-m]` を **`-l`（literal）なしで**発行し（リポジトリ全体で `-l` の使用は実測 0 件）、`tmux send-keys` は引数を**まずキー名として解決**する。したがって本文がちょうど `Escape` / `C-c` / `Enter` / `BSpace` / `Up` などと一致すると、テキストではなく**キーとして着弾**する。キー名を送る専用経路（`sendSpecialKeys` / `sendSpecialKey`）は `ALLOWED_SPECIAL_KEYS` / `ALLOWED_SINGLE_SPECIAL_KEYS` の allowlist を持つのに、本文経路にはこの区別が無い。`gracefulExitSequence()` は「Escape ×2」「`/exit` の本文と Enter の分離」「`C-c` ×2」を同じ抽象に入れるため、要素ごとの区別が無いと必ずどちらかの誤りに倒れる。

  ```ts
  type KeySequence = ReadonlyArray<
    | { kind: 'literal'; text: string }
    | { kind: 'key'; name: AllowedSpecialKey }
  >;
  ```

  - **`kind:'literal'` は必ず `tmux send-keys -l` で送る**（キー名として再解釈させない）。
  - **`kind:'key'` は既存 `ALLOWED_SPECIAL_KEYS` の allowlist を通してから送る**。allowlist を通らない文字列を key として送る経路を新設しない。
  - **本文とキーを 1 回の `send-keys` に混ぜない**。`/exit` の「本文 / Enter 分離」はこの規則の帰結として導かれる（個別のツール都合ではない）。
  - `sendKeys` への `-l` 導入は**既存挙動の変更**（`commandmate send <id> "Escape"` が現在はキーとして着弾する面を含む）なので、Phase と CHANGELOG を明示する（§8 / §13.2）。
- **`gracefulExitSequence()` には後置条件を持たせる（DR4-012 / DR4-004・決定）**: 現行 `OpenCodeTool.killSession` は `releaseOpencodeEventStream`（＝ subscription close ＋ `forgetOpencodePort`）を**最初に**呼び、完了判定は `hasSession` の有無だけを見る。**opencode の HTTP サーバは既定で無認証の loopback API（client.ts の docstring 自身が「loopback 以外に bind すると任意コマンド実行 API をネットワークに公開することになる」と述べている）**であり、`/exit` も tmux kill も効かなかった場合、port の所有記録だけが消えて**無認証 API が 127.0.0.1 に生き残る**。以後 `allocateOpencodePort` はその port を「使用中」として避けるだけで、誰も後始末をしない（運用者からはセッションが消えたように見える）。したがって kill の**完了条件を 2 つ**にする。
  - (a) `hasSession` が false、かつ (b) **割当 port で `/global/health` が応答しない**。
  - **port の forget（`forgetOpencodePort`）は (b) を確認したあとに行う**（release を先に呼ばない）。
  - (b) が満たされないときは force kill まで実行し、それでも残るなら理由コード **`port_orphaned`**（強制終了に至った場合は **`graceful_exit_timeout`**）を運用者層に出す（§7）。無言で諦めない。

### D5. tool / instance 解決は 1 箇所

**決定 1 — 権威は server、CLI は薄いクライアント（DR1-008 / DR2-008 で確定）**: 解決の権威は **server 側 1 実装**とし、`resolveSessionTarget(db, worktreeId, { instanceId, requestedCliTool })` を `src/lib/session/resolve-session-target.ts` に置く（server 側 `resolveInstanceCliTool` を内包）。CLI 側 `resolveInstanceCliTool`（`src/cli/commands/instances.ts`）と `capture.ts` の `resolvePaneCliTool` は、**解決エンドポイント（例 `GET /api/worktrees/:id/resolve-target`）を叩く薄いクライアントに縮退させ、レスポンスの `cliToolId` / `instanceId` / `resolvedBy` をそのまま使う**。

**「ローカル解決を残す＋等価性契約テスト」案は採らない（DR2-008・決定）**。CLI 側の解決は 2 段しかなく **primary anchor の段（instanceId がツール名）が欠落している**ため、roster 未登録の instanceId に対して server と CLI は実際に違う答えを返す。等価性契約テストは初日から赤になり、その赤を消す作業は結局「CLI 側に primary anchor 段を実装する」＝**2 つ目の権威実装を育てる**ことになる。`tsconfig.cli.json` の `paths: {}` 制約下で server 関数を import できない以上、権威を 1 つに寄せる方法は server 委譲しかない。

**版スキュー設計（DR3-004・必須）**: **CLI は稼働サーバより新しいのが常態**である（`src/cli/types/api-responses.ts` が 2 箇所で「`npm i -g` は稼働中のデーモンを再起動しない」と明記し、optional フィールドはすべてこの前提で書かれている）。委譲先の解決エンドポイントは**新サーバにしか存在しない**ため、対策なしに委譲すると **新 CLI × 旧サーバで `send` / `capture` / `respond` / `auto-yes` の 4 コマンドが全滅**する。Next.js App Router の未実装パスは **`code` を持たない 404** を返し、`api-client.ts` の `handleApiError` はそれを一律 `'Resource not found. Check the worktree ID.'` ＋ `ExitCode.UNEXPECTED_ERROR` にマップする（`readErrorPayload` は body に `code` / `error` が無ければ `undefined` を返すため、CLI は「worktree が無い」と「サーバがこのエンドポイントを知らない」を**区別できない**）。これは #1915 が直そうとしている #1884 と同じ形（正しく起動しているのに「無い」と言う）の障害を、より広い経路で再生産する。したがって次を決定する。

1. **まずサーバに問う**: CLI は解決エンドポイント（またはレスポンスの `resolvedTarget` フィールド）を試し、成功したらその `cliToolId` / `instanceId` / `resolvedBy` をそのまま使う。
2. **「本物の 404」だけを「旧サーバ」と解釈してローカル解決へフォールバックする（DR4-007 で厳格化）**: 現行のクライアント側 2 段解決（`instances.ts` の `resolveInstanceCliTool` / `capture.ts` の `resolvePaneCliTool`）を**互換経路としてのみ**残し、使ったときは **`resolvedBy: 'client-fallback'`** を運用者層に出す（規約 1。`ls` / `capture --json` / 各コマンドの `--json` に載せ、`fallback` と同様に**劣化として明示**する）。DR2-008 の「2 つ目の権威実装を育てない」とは、**この経路を機能追加しないこと**（primary anchor 段を CLI 側に実装しない・分岐を増やさない）で両立させる。**「成功しなければローカル解決」と実装してはならない**: `client-fallback` は D5 決定 1 が明示するとおり **primary anchor 段を持たない劣化解決**なので、認証未通過や中間装置の 404 がここに落ちると **`send` / `respond` が roster と食い違う instance に着弾**する（中間装置を制御できる相手なら意図的に誘導できる）。
3. **検出手段（能力プローブ）と応答の判定表（DR4-007・必須）**: 404 の解釈だけに頼らず、**新設する `GET /api/capabilities`**（認証は既存 API と同じ。ネットワークに出ず、`{ serverVersion, capabilities: string[] }` の静的な宣言だけを返す。開示範囲は §10）を一次の判定に使う。プローブは **`Accept: application/json` を付け、`redirect: 'manual'` で発行**する（`src/middleware.ts` は Authorization ヘッダの無い要求を `/login` へ **redirect** し、`/login` は `AUTH_EXCLUDED_PATHS` にあるので **follow すると 200 の HTML に着地して `response.ok` が真のまま `response.json()` が SyntaxError で落ちる**）。CLI はプロセス内 1 回だけ問い合わせて結果をキャッシュする（§4 D2 の probe コスト規約と同じ）。判定は次の 4 分岐に限り、**それ以外は「不明なサーバ」として即終了する**。

   | 応答 | 解釈 | 動作 |
   |---|---|---|
   | 200 ＋ `content-type: application/json` ＋ `capabilities` が配列 | 新サーバ | 解決エンドポイントへ委譲（`resolvedBy` はサーバの値） |
   | **404 ＋ 本文が空または JSON** | 旧サーバ | ローカル解決へフォールバック（`resolvedBy: 'client-fallback'` ＋ **stderr に 1 行の警告**） |
   | 401 / 403 | 認証エラー | **フォールバックしない**。認証エラーとして即終了（exit は既存の認証系に合わせる） |
   | 3xx / `response.redirected` が真 / `content-type` が HTML / JSON パース失敗 | 認証未通過または中間装置（リバースプロキシ・ngrok 等） | **フォールバックしない**。「サーバの能力を判定できない」として即終了 |

   **認証が構成されている（`CM_AUTH_TOKEN_HASH` が設定されている）ときは、判定不能を黙って劣化に倒さない**。`resolvedBy: 'client-fallback'` を出したコマンドは、`--json` の契約を変えずに **stderr へ 1 行の警告**を必ず出す（§7 の警告色と対にする）。旧サーバの版を運用者に見せたいときの補助として `GET /api/app/update-check` の `currentVersion` を使ってよい（常に 200 を返し、GitHub 参照結果は 1 時間の in-memory キャッシュ）。ただし**同経路は GitHub Releases API に出る**ため、毎コマンドの一次プローブには使わない。
4. **Phase 1 の作業に含める**: `GET /api/capabilities` の新設、CLI 側の能力プローブ + フォールバック、`resolvedBy` への `'client-fallback'` 追加（`api-responses.ts` の union と server 側の pin を同時更新）。フォールバック経路は「機能追加しない」規律を **`tests/unit/cli/commands/*-resolve-fallback.test.ts` の受入条件**として書き残す。

**決定 2 — precedence は #1629 の実装に合わせる（DR1-008）**: 既存実装（server / CLI とも）は「**roster が明示指定に勝つ。矛盾はエラー**」であり、本書の初版はこれと逆だった。実装を正とする。

```
instanceId 未指定 → 明示指定（--agent / ?cliTool / body.cliToolId）または null を即返す（roster は見ない）  ※ agent-instances-db の早期 return（DR3-020）
roster（instanceId が登録済みならその tool）
 → 明示指定（--agent / ?cliTool / body.cliToolId）      ※ roster が知らない instance（アドホック send）のみ有効
 → instanceId がツール名そのもの（primary の anchor、#868）
 → worktree 既定（worktrees.cli_tool_id）
 → 'claude'（Phase 1 では baseline として残置。決定 4 を参照）
```

roster と明示指定が矛盾したら **400 / exit 2** とし、これは新しい運用者向け判定なので理由コードと stdout JSON を規約 1・2 に従って定義する: `{ error: 'instance_tool_conflict', instanceId, rosterCliTool, requestedCliTool }`。

**決定 3 — 適用範囲**: `current-output` / `auto-yes` / `send` / `respond` / `interrupt` / `kill-session` / `terminal` / `capture` / `special-keys` の全 route が `resolveSessionTarget` を使う。ツール依存オプションの検証（`--model` 等）は**解決後**に行う。

**conflict の扱いは読み取り / 変更で分ける（DR3-015・決定）**: `instance_tool_conflict` で **400 を返すのは副作用のある経路だけ**とする。

| 区分 | 対象 | conflict 時の挙動 |
|---|---|---|
| 変更（副作用あり） | `send` / `respond` / `interrupt` / `kill-session` / `terminal` / `special-keys` / `auto-yes` **POST** | **400 `instance_tool_conflict`（CLI は exit 2）**。送り先を推測して副作用を起こさない |
| 読み取り | `current-output` / `capture` / `auto-yes` **GET** | **200 を返す**。roster 優先で解決し、`resolvedBy: 'roster'` と **conflict の事実**（`conflict: { requestedCliTool, rosterCliTool }`）をペイロードに載せる（規約 1） |

理由: `.claude/skills/orchestrate-monitor/scripts/monitor.sh` は `capture` が非 0 を返すと「capture failed, skipping poll」で `continue` し、**idle streak を進めない**。運用者の既定は `MAX_POLLS=0`（無限）である。monitor.sh は instance id からエージェントを復元して `--agent` を付けるため、roster と食い違うワーカーでは**毎ポーリング 400 → 無音の無限ループ**になり、停止も完了報告もしない。読み取り経路は「解決して 200 ＋ 矛盾を露出」が discoverability 規約とも整合する。

**`kill-session` は挙動が変わる（DR2-009）**: 現在のインライン解決は明示 `?cliTool` を roster より優先し、矛盾しても黙って明示側を採る。`resolveSessionTarget` へ置換すると **roster 優先**になり、矛盾時は **400 `instance_tool_conflict`** を返す。これは #1909（auto-yes の既定変更）と並ぶ Phase 1 の挙動変化であり、**CHANGELOG に明記する**（§8 Phase 1 / §9）。

**決定 4 — `'claude'` リテラルのガード（DR1-009 / DR2-005 / DR2-006 で改訂）**: 「件数を 0 に pin」は Phase 1 では達成不能である。加えて初版が前提にしていた「既存 `no-restricted-syntax` は `warn` だから CI を落とさない」「allowlist は `overrides` で明示する」は、**ESLint の設定モデル上そのままでは実装できない**（DR2-005）。`.eslintrc.json` は eslintrc 形式で `no-restricted-syntax` を **1 キー・1 severity** しか持てず（JSON にキーの重複は書けない）、`overrides` の `rules` は base の同名ルールを**置換**する（マージしない）。したがって次を決定する。

- **(1) 既存の i18n セレクタを `warn` → `error` に格上げする**。`npm run lint` は現状 **exit 0 / 警告 0 件**なので、格上げしても CI は緑のまま。これで「1 ルール 1 severity」の制約下でも `no-restricted-syntax` を一貫した severity で運用できる（「既存が `warn` だから落ちない」という誤った前提を除去する）。**D4 の動的 import セレクタ（`ImportExpression` / `require` の tmux パス、DR4-005）も同じ base の 1 キーに並べる**。動的 import 側は現状 0 件・allowlist なしなので `overrides` を作らずに済み、i18n セレクタが無音で失効する問題（下記 (2)）を再生産しない。
- **(2) `no-claude-fallback` は ESLint ではなく vitest ガードで実装する**（`tests/unit/guards/no-claude-fallback.test.ts`）。理由: `overrides` で claude セレクタを足すと、そのファイル群で **i18n セレクタが無音で失効**する。スコープ用 override と allowlist 用 override の**すべてに i18n セレクタを複製**しなければならず、複製漏れがガードを静かに殺す（本書 D4 が嫌う「無音の失効」と同型）。allowlist を「ソート済みパス列挙の完全一致 pin」で運用する以上、単体テストのほうが素直である。**`no-restricted-imports`（D4 の tmux ガード）は別ルール名なのでこの制約を受けず、ESLint 側に残す**。
- **(3) ガードの `files` スコープを明示する（DR2-006）**: 対象は **`src/app/api/**/route.ts`・`src/cli/commands/**`・`src/lib/session/**`** の 3 つ（解決結果が実行時の送り先を決める層）に限定する。スコープ外（`src/lib/db/**`（`migrations` を含む）・`src/components/**`・`**/__tests__/**`・`src/lib/hooks/sources/claude/**`・`src/types/**` など）は allowlist ではなく**対象外**とする（§12 非目標）。**さらに `src/lib/session/claude-session.ts` と `src/lib/session/claude-executor.ts` をスコープ外に加える**（DR3-009。`src/lib/hooks/sources/claude/**` を外すのと同じ理由で、これらは Claude 固有モジュールであり、そこにある `'claude'` は解決フォールバックではなくモジュール自身の同一性である）。**検出対象は「解決結果＝実行時の送り先を決める既定」に限る**。次は明示的に対象外とする: (a) **表示 / ラベル用の既定**（`src/cli/commands/wait.ts` の `data.cliToolId || 'claude'`、exit 10 JSON と `NOT_STARTED` メッセージの表示既定。これは `tests/unit/skills/orchestrate-monitor/monitor-session-target.test.ts` が pin する「payload に `cliToolId` が無ければセッション名を捏造しない」規律と表裏で、削ると exit 10 JSON の `cliToolId` が `undefined` になる）、(b) **commander の option 既定・許可リスト配列**（`src/cli/commands/report.ts`）、(c) **コメント行**（`src/cli/commands/capture.ts`）。スコープを切らずに `'claude'` リテラルを `src` 全体で禁じると **231 箇所 / 85 ファイル**が対象になり、allowlist として現実的でない（実測値）。
- **(4) スコープ内 baseline は実測済み ＝ 36 箇所 / 19 ファイル（DR3-009 で確定。初版の「未測定」を差し替え）**。内訳（develop `90b67eb9`）:

| スコープ | 箇所 | ファイル | 中身 |
|---|---|---|---|
| `src/app/api/**/route.ts` | 20 | 13 | 解決フォールバックが中心（`auto-yes/route.ts` の GET 側 `getAutoYesState(id, 'claude')` を含む） |
| `src/cli/commands/**` | 8 | 3 | `report.ts` の許可リスト配列と commander 既定、`wait.ts` の**表示既定 3 件**、`capture.ts` のコメント 1 件 |
| `src/lib/session/**` | 8 | 3 | `claude-session.ts`（primary anchor の `===` 比較・`discardAgentEventState` の引数）、`claude-executor.ts`（`case 'claude'` と既定引数 `cliToolId: string = 'claude'`）、`worktree-status-helper.ts`（Claude 限定 health check の `=== 'claude'`）。**`?? 'claude'` / `\|\| 'claude'` の綴りは 0 件**で、解決フォールバックは 1 件も無い |
| **合計** | **36** | **19** | — |

  なお `src` 全体の 231 箇所 / 85 ファイルという実測値は Stage 3 でも再現した（スコープを切る根拠は維持）。**「削除のみ許可」を機械的に運用すると、上表のうち正しいコード（primary anchor・表示既定・Claude 固有モジュール）まで削除を誘発する**ため、baseline のパス列挙には **1 行ごとに「解決フォールバック / 対象外（理由）」の区分を併記**し、対象外行は削除の進捗指標に数えない。Phase 1 の最初の作業は「測定」ではなく **この区分の確定**である（増加は CI 赤、**減ることだけを許す**は維持）。

  **実測の更新（#1923 着地時点）**: 上表の 36 箇所 / 19 ファイルは `'claude'` の**素の grep** 値であり、`case 'claude':` / `=== 'claude'` / 許可リスト配列 / コメントを含む。本決定が指定する **AST の綴り**で測り直すと **21 箇所 / 13 ファイル**で、内訳は **解決フォールバック 10 件（すべて `src/app/api` 配下の `route.ts`）・対象外 10 件・許可 1 件（`resolve-session-target.ts` の `DEFAULT_SESSION_CLI_TOOL`）**。`src/cli/commands/**` と `src/lib/session/**` の解決フォールバックは **0 件**である（`wait.ts` は表示既定、`report.ts` は commander 既定、`worktree-status-helper.ts` の `=== 'claude'` は綴り対象外）。また綴りは 5 つでは足りず、`{ cliToolId: 'claude' }`（オブジェクト値）と `return 'claude'`（`slash-commands/route.ts` の後方互換既定＝解決フォールバック）が漏れるため **8 綴り**に拡張した。区分と綴りの正本は `tests/unit/guards/no-claude-fallback.test.ts`。
- 検出は AST ベースで行い、次の **5 綴り**を捕まえる: `x ?? 'claude'` / `x || 'claude'` / `cond ? x : 'claude'` / `const D: CLIToolType = 'claude'` / **`f(..., 'claude')`（呼び出し引数の既定。DR3-009。`auto-yes/route.ts` の `getAutoYesState(id, 'claude')` がこれに当たり、4 綴りだけでは捕まらない。これは #1909 の GET 側の双子である）**。
- `resolveSessionTarget` 内部のみ `'claude'` を書いてよい。0 件化は Phase 2 以降の目標として §8 に置く。

**決定 5 — `resolvedBy: 'fallback'` は警告（DR1-022）**: `worktrees.cli_tool_id` が常に非 null なら最終段 `'claude'` は到達不能なはずで、到達したら #1909 型のバグの兆候である。`resolvedBy: 'fallback'` は単なる情報ではなく**警告**として運用者層に出す（§7）。

---

## 5. アーキテクチャ

### 5.1 層と責務（目標状態）

```
 運用者層   capture --json / wait / ls / Web UI チップ      ← 理由コードつきで全判定を露出（D1, discoverability）
              ▲
 統合判定   current-output-builder.mergeStructuredStatus    ← 「waiting > open turn > 肯定的証拠 > 証拠なし」
              ▲                         ▲
              │  waiting のみ resolvePromptWaiting（#1737、唯一の生成者。send guard と共有）
              ▲                         ▲
 構造化層   turn モデル（agent-event-state）   スクレイパ  detection/tools/<tool>（D2）
            capability 駆動（D3）                            肯定的証拠のみ（D1）
              ▲                         ▲
 ソース     hooks sources（push/pull）   tmux capture（captureSessionOutput、D4）
              ▲                         ▲
 ツール抽象 CLITool（唯一のゲートウェイ、D4） ← route / CLI / poller はここだけを呼ぶ
              ▲
 解決       resolveSessionTarget（D5） ← 全経路の入口
```

### 5.2 統合判定の優先順位（`mergeStructuredStatus` の改訂）

**前提（DR1-007）**: waiting の判定は引き続き `resolvePromptWaiting`（`prompt-waiting-composition.ts`、#1737）が**唯一の生成者**であり、`mergeStructuredStatus` はその出力を受け取るだけである。ここに 2 つ目のコピーを作らない（#1737 が閉じた分岐を再び開けない）。`send` guard（`blocksSend`）も同じ出力を読む。

1. `resolvePromptWaiting` が waiting → **`waiting`**（options は scraper 優先、無ければ `pendingDecisions` から合成）。
2. open turn がある（`closedAt === null` かつ期限内）→ **`running`**。
3. scraper の肯定的完了証拠（`evidence: 'positive'` かつ `ready`）→ **`ready`**。
4. scraper の処理中証拠（`evidence: 'positive'` かつ `running`）→ **`running`**。
5. それ以外 → **証拠なし**。`statusEvidence: 'none'` ＝ `isUnclassifiedActive` とする。**この `true` は構造化 `ready` で打ち消さない**（下記補足、DR2-003）。**wire 上の `sessionStatus` は経路ごとに次のとおり確定する（DR3-002・決定）**。証拠なしの識別子は `sessionStatus` ではなく **`statusEvidence` / `isUnclassifiedActive`** であり、消費者はそちらで分岐する。

| 経路（reason） | 証拠なしのときの wire `sessionStatus` | 付随 |
|---|---|---|
| `input_prompt`（2） | **`ready` のまま（`running` に倒さない）** | `statusEvidence:'none'` ＋ merged `isUnclassifiedActive: true` |
| `no_recent_output`（3） | **`running`**（`ready` を廃止） | `statusEvidence:'none'` ＋ `isUnclassifiedActive: true`。reason は診断のため維持 |
| `default`（4） | **`running`**（現行どおり・変更なし） | `statusEvidence:'none'` ＋ `isUnclassifiedActive: true` |

補足:

- 2 が 3 より上位でいられるのは、open turn に**終端規則がある**（`stale` / `scraper_evidence` / `resync_idle`、D3 決定 2）ためである。終端規則が無ければ `stop` を 1 回落とすだけで永久 `running` になり、D1 が却下した代替案と同じ状態を構造化層側で作り直すことになる。
- 現行の「構造化 ready が scraper running を上書き」は、`stop` が自 turn に束縛される（D3）ことで安全になる。
- **`evidence: 'none'` は構造化 `ready` で打ち消さない（DR2-003・決定）**: 現行 `mergeStructuredStatus` にある「`structured.status === 'ready'` かつ `scraper.status === 'running'` なら `isUnclassifiedActive = false`」という上書き分岐は、`no_recent_output` が `running` を返すようになると**新たに成立し、「フレームが読めないのに hooks は ready と言っている」まさにその場面で #1708 のガードを無音で外す**。したがって当該分岐は「**scraper が肯定的証拠を持つ（`evidence: 'positive'`）ときにだけ** `isUnclassifiedActive` を下ろす」に改訂する。`evidence: 'none'` は merged でも `true` のまま残す。
- 上記の帰結として、**#1708 のガードの pin は `current-output-builder`（merged）レベルのテストで行う**。`detectSessionStatus` 単体の fixture ではこの分岐を通らないため、反転を検出できない（§11）。
- **`input_prompt` × `evidence:'none'` を `running` に倒さない理由（DR3-002）**: `running` に倒すと `sessionStatusToActivityFlags`（`status-mapping.ts`）が **`isProcessing: true`** にし、`ls` の状態列（`deriveStatus`）・sidebar 集約・`MessageInput` の「queued (session busy)」トースト・**`.claude/skills/demo-video/scripts/cli-scene.sh` の `wait_until_busy` プローブ**（`status.isProcessing ? 0 : 2` を 6 連続 settled で判定し、attempt 90 で die する）が**同時に変わる**。とくにデモ収録は「idle composer が settled になる」ことを前提にしているため、恒久的に settled へ到達しなくなる。一方 `ready` のままなら、`wait` の完了条件 `sessionStatus === 'ready' && isUnclassifiedActive !== true`（`wait.ts`）は **`isUnclassifiedActive: true` によって成立せず**、既存の 60 秒 dwell → **exit 10 `type:'unclassified'`** に落ちる。これは #1708 が設計した経路そのもので、**新しいタイマーも新しい exit code も増えない**（§4 D1 決定 2）。`no_recent_output`（3）だけを `running` に倒すのは、この経路が「stalled worker を Completed に化けさせる」＝**完了と誤認させる方向**の誤りであり、`ready` を名乗らせないこと自体が目的だからである。
- **send guard の意味論**: 5（証拠なし）は send をブロックしない。ブロックは 1（`waiting`）のみ。

### 5.3 データの流れ（opencode permission の例、目標状態）

```
[接続 / 再接続] GET /global/health（redirect:'manual'・content-type 検証）
  → version が前回と一致しない → ストリームを開かず scraper へ降格（理由 port_identity_changed、§10）
  → 一致 → SSE を開く。resync の stop 合成もこの確認を通った後にだけ行う
SSE permission.asked(per_1)
  → ソース入口の検証: id / sessionId / toolName に長さ上限＋文字種（§10 外部入力(b)）
      → 外れたら decision ごと【破棄】（切り詰めない。切り詰めた id で reply すると別リクエストに当たる）
  → ingest: eventIdentity='permission-id' で dedup → turn.pendingDecisions.push(per_1)
  → 裁定器: policy(allow) → client.reply(per_1, once) 送達（宛先 port は target 由来・127.0.0.1 固定）
  → delivered → decision.decidedAt 設定 → release（waiting にならない）
  → capture --json: structuredEvents.decisions[{id:per_1, behavior:'allow', delivered:true}]
SSE permission.asked(per_2) ＋ Auto-Yes OFF
  → 裁定器: abstain → prompt-waiting 開く（resolvePromptWaiting の source: decision）
  → wait exit 10: { type:'permission', options:['Allow once','Allow always','Reject'], decisionId:'per_2' }
  → respond <id> 1
      → resolveSessionTarget(worktreeId, {instanceId, requestedCliTool}) で target を確定
      → その target の pendingDecisions の中だけで per_2 を探す（横断検索しない、DR4-003）
      → 見つからない → 404 decision_not_found（下流へ渡さない）
      → 見つかる → reply(once) → release
  → （途中で Auto-Yes を有効化した場合）ポリシー変更契機で per_2 を再裁定（D3 決定 3）
```

---

## 6. 実装詳細（子 Issue への指示に相当する部分）

### 6.1 D1/D2（スクレイパ）

**「否定の不在 → ready」3 経路の移行後マッピング（DR1-002）**:

| 現行経路（`status-detector.ts` 末尾。docstring 番号は §3 P1 参照） | 現行の返り値 | 移行後 | merged `isUnclassifiedActive`（DR2-001 / DR2-003） |
|---|---|---|---|
| (2) `promptPattern` 一致（reason `input_prompt`） | `ready` / `input_prompt`（high） | **そのツールの「肯定確認された idle 証拠」規則が実装済みのときだけ**、**そのツールで実測した行**を**肯定的に**読めたときに `ready` / `input_prompt`（＝未開始 or 完了）とする。**「composer が空」を全ツール共通の規則にしてはならない**: copilot は生成中も同じ composer を描くため、証拠はペイン最下行のステータスバーである（§4 D1 決定 1 の実測、#1979）。確認できなければ**証拠なし**へ倒す（**wire 値は `ready` のまま**。`running` に倒さない、DR3-002）。**規則が未実装のツールは現行どおり `ready` ＋ `evidence:'positive'` 扱い**（§4 D1 決定 1 のツール単位ロールアウト、DR2-002） | 肯定確認できたとき `false` / できないとき `true`。**現行は常に `false` なので、これは意図的な拡大**であり等価性 pin の対象にしない（新たに `true` になる fixture を別表で列挙して pin、DR2-001） |
| (3) 5 秒 stale（`STALE_OUTPUT_THRESHOLD_MS`、reason `no_recent_output`） | `ready` / `no_recent_output`（low） | **`ready` を廃止**。`running` ＋ `evidence:'none'` ＋ reason `no_recent_output`（理由コードは診断のため維持） | `true`（**現状と同値**。ただし `mergeStructuredStatus` の上書き分岐を同時に改訂しないと、構造化 `ready` のときに `false` へ反転する。DR2-003） |
| (4) 既定（reason `default`） | `running` / `default`（low） | **wire 値は変更なし**（`running` / `default`）＋ `evidence:'none'` | `true`（現状と同値） |
| ツール別完了マーカー（新規。実在するのは現在 opencode の 1 件のみ） | — | `ready` / `<tool>_response_complete` ＋ `evidence:'positive'` | `false` |

- `StatusVerdict` に `evidence: 'positive' | 'none'` を追加する。`SessionStatus` の値域は**変更しない**。
- `STATUS_REASON.UNKNOWN_FRAME = 'unknown_frame'` を追加（ツール別 detector が証拠を得られなかったときの理由コード）。**Phase 2（Epic #1891）の scope 外だったため未着地である**（`grep -rn 'UNKNOWN_FRAME' src/` は **0 件**。develop `a175767a` で実測。`STATUS_REASON` の現在値は `prompt_detected` / `thinking_indicator` / 各ツールの `*_selection_list` / `opencode_processing_indicator` / `opencode_permission_prompt` / `codex_pager` / `codex_hooks_review` / `opencode_response_complete` / `input_prompt` / `no_recent_output` / `default`）。**追加は Phase 3・#1927 の作業に含まれる**（§8）。
- `current-output-builder.ts` の `isUnclassifiedActive` を **`evidence === 'none'` からの導出**に置き換える。**pin は merged（`mergeStructuredStatus` 適用後）の値に対して行い、「(3)(4) 由来は等価」と「(2) 由来の新規 `true` は明示列挙」の 2 本に分ける**（§11、DR2-001）。
- **`mergeStructuredStatus` の上書き分岐を同時に改訂する（DR2-003、必須）**: 現行の「`structured.status === 'ready'` かつ `scraper.status === 'running'` なら `isUnclassifiedActive = false`」を、「**scraper が `evidence: 'positive'` のときだけ下ろす**」に変える。改訂せずに `no_recent_output` を `running` へ倒すと、この分岐が新たに成立して #1708 のガード（`wait` の 60 秒 dwell → exit 10、`TerminalEscapeHatch`、`unclassified-frame-tracker` の記録）が**無音で外れる**。この反転は scraper 単体 fixture では検出できないため、**ガードの pin は `current-output-builder` レベルのテストで行う**（§11）。
- `capture --json` に `statusEvidence`（optional）・`lastKnownStatus` / `lastKnownStatusAt`（§7、DR1-014）を additive に追加する。
- **契約変更は `current-output` だけでは足りない（DR3-005・必須）**: §7 のうちヘッダチップ / `BranchStatusIndicator` / sidebar / `ls` を受け皿にする行は、`current-output` ではなく **`GET /api/worktrees`（および `GET /api/worktrees/[id]`）が返す `sessionStatusByCli`（`CliToolSessionStatus`）の boolean 3 つ**で駆動されている（`isRunning` / `isWaitingForResponse` / `isProcessing` ＋ `waitingKind` / `waitingSince` / `awaitingInstruction` / `model`。reason も evidence も無い）。したがって **`CliToolSessionStatus` にも additive に `statusEvidence?` / `sessionStatusReason?`（および `lastKnownStatus?` / `lastKnownStatusAt?`）を足す**ことを、`CurrentOutputResponse` と**並ぶ第 2 の契約変更**として立てる。生成元は `src/lib/session/worktree-status-helper.ts`。**`sessionStatusByCli` を実装 PR が場当たりに広げると、`WorktreeItem` を読む 14 ファイル（`CommandPalette` / `RecentSessionsList` / `useWorktreesCache` / `WorktreeSelectionContext` 等）と CLI 契約が同時に動く**ため、追加フィールドは本書で確定した 4 つに限る。
- **`ls` に理由を出す（DR3-005）**: `src/cli/commands/ls.ts` の `deriveStatus` は `isWaitingForResponse → isProcessing → isSessionRunning` の 3 分岐しか持たない。**表の状態列の隣に理由列（`reason`）を追加**し、`--json` には `statusEvidence` / `sessionStatusReason` をそのまま載せる（列が増えることは CHANGELOG に記載する）。`src/cli/types/api-responses.ts` の `CurrentOutputResponse` と `docs/user-guide/cli-operations-guide.md`、および commandmate-skills 側の転写箇所の更新を**同一 Phase の受入条件**に含める。
- Auto-Yes の入口は `src/lib/polling/response-checker.ts` の `detectPromptWithOptions` である。ツール別 `detectDialog` を Auto-Yes と共有し、抑止時は `autoYes.lastSuppression.reason = 'unclassified-frame'` を載せる。**`AutoYesSuppressionReason` に 1 値足すときの同時更新先は 3 箇所（DR3-008）**: (1) server 側 `src/lib/polling/auto-yes-resolver.ts` の union、(2) CLI 側 `src/cli/types/api-responses.ts` の写し、(3) **`src/cli/commands/wait.ts` の `SUPPRESSION_CAUSE`（`Record<AutoYesSuppressionReason, string>` の網羅 Record。足さないと `npx tsc --noEmit` が落ちる）**。`tests/unit/cli/config/cross-validation.test.ts` が (1)(2) を双方向 pin する。なお同ファイルの `suppressionCause()` は未知 reason を verbatim で出す前方互換実装なので、**旧 CLI × 新サーバ**は理由コードをそのまま表示して壊れない（実測）。
- 対象ファイルに `src/lib/session/prompt-waiting-composition.ts`（waiting の唯一の生成者）と `src/lib/detection/unclassified-frame-tracker.ts` を含める。
- `wait --help` に「unclassified dwell（60 秒、exit 10）と `--stall-timeout` の違い」の相互参照を追加する（規約 3）。
- **影響を受ける既存テストは `tests/` 配下だけではない**（DR2-024）: `src/lib/__tests__/status-detector.test.ts`（`reason === 'no_recent_output'` を直接 assert）と `src/lib/__tests__/cli-patterns.test.ts` も対象に含める（§9）。
- #1893 / #1894 / #1895 / #1896 / #1897 に加え、既報の **#1883（opencode の idle composer `Ask anything...`）/ #1885（copilot の生成中フレームが `ready`）/ #1886（copilot の folder-trust ダイアログ）** もこの構造で実装する（DR2-015）。移行前に着手する場合も、**`ready` フォールバックに依存しない**こと。

### 6.2 D3（構造化層）

- `types.ts` に capability 5 項目（すべて宣言値）を追加し、**§4 D3 の 6×5 表**を `tests/unit/hooks/sources/capabilities.test.ts` で pin する。
- `agent-event-state.ts` に `TurnRecord` と `openTurn / closeTurn / recordDecision / settleDecision / expireDecisions` を追加。既存 getter は turn から導出。`closedBy` と `displayEvent`（旧 `lastEvent`、表示専用）を持たせる。
- **`TurnRecord` を既存の generation フェンスに接続する（DR3-003・必須）**: `beginAgentEventGeneration` に「open turn を `closedBy:'generation'` で閉じ、`pendingDecisions` を破棄する」処理を足し（既にダイアログ（#1725）とモデル（#1783）をクリアしている場所）、turn の導出側は既存 getter と**同じ条件**（`record.at < generation` を捨てる）で `generationAt < generationStartedAt` の turn を無視する。**(worktreeId, cliToolId, instanceId) の合成キーは再作成セッションで再利用される**ため、これを落とすと新品セッションが最大 30 分 `running` を publish し、`tests/unit/session/agent-event-generation-1723.test.ts`（実 `startClaudeSession` / `stopClaudeSession` を駆動）が赤になる。
- `ingest.ts`（opencode）: `isDuplicateAgentEvent` を `eventIdentity` ベースに置換（`stop` / `session_end` は dedup 対象外）。裁定 → 記録の順に並べ替え。`permission.replied` を release にマップ。
- `subscription.ts`: **`resyncPending`（`GET /permission` / `GET /question` の replay）は既に実装済み**なので新規に書き起こさない（二重 replay になる、DR2-011）。**追加するのは (a) activity 再取得（`probeActivity` / `fetchOpencodeActivity` ＝ `GET /session/status` に本番の呼び出し元を接続）と (b) 再接続後の turn 再武装**である。順序は `resyncPending` → `GET /session/status`。併せて `resyncPending` の**契機**を「再接続・Auto-Yes 有効化 / ポリシー変更・`respond` 到達・roster 変更」に一般化する。**さらに (c) 再接続ループの先頭に `fetchOpencodeHealth`（`/global/health`）を入れ、`version` の一致を確認してからストリームを開く**（現行 `runStream` は `state.gate.reset()` → `resyncPending(state)` → `readOpencodeEventStream(state.port, …)` を無条件に回しており、health check は初回 attach の `attachOpencodeEventStream` にしか無い）。不一致なら `port_identity_changed` で降格する（DR4-004、§10）。**replay の採用件数上限（例 50）と SSE 1 フレームの上限（例 256 KiB）もここで実装する**（DR4-009）。
- `permission-decision-service.ts`: `reportPendingDialog` を `permissionHookPredictsDialog` で条件化。**期限は 2 本**（送達期限 `decisionTimeoutSeconds` は `deliveryExpired` を立てるだけで `waiting` を維持、保持期限 `dialogPendingMaxMs` 超過で `releasedBy: 'dialog_timeout'`）を実装する（DR2-004）。`decisionTimeoutSeconds` を release 期限に流用しないこと。
- **`src/app/api/worktrees/[id]/prompt-response/route.ts`**（CLI `respond` の実経路。`getAskUserQuestion` を参照する前例あり）と `src/cli/commands/respond.ts`: scraper の `promptData` が無くても `pendingDecisions[].id` で応答できるようにする（#1898-3、DR2-010）。
- **Web UI の応答経路も範囲に入れる（DR3-007・決定。DR2-010 の除外を解除）**: `src/app/api/worktrees/[id]/respond/route.ts`（`messageId` 必須の Web UI 経路）と `PromptPanelProps` に **`decisionId` を受ける口**を足し、`messageId` が無くても構造化 decision に応答できるようにする。**Phase 4 の作業**とし、Phase 4 が着地するまでは §7 の該当 3 行（未裁定 decision / `deliveryExpired` / `dialog_timeout`）の Web UI 欄を「**表示のみ。応答は TUI か CLI `respond`**」と明記して出す。現行の `PromptPanelProps` は `promptData: PanelPromptData | null` / `messageId: string | null` / `onRespond: (answer: string) => Promise<void>` しか持たないため、除外したままだと **「裁定待ちがある」と表示しながらその UI からは応答できない**画面を出荷することになり、discoverability 規約 1（判定を出したら操作手段も出す）に反する。
- copilot source: `parseCopilotPermissionRequest` が文字列 `tool_input` を `{ patch }` に正規化（#1902）。
- **copilot `~/.copilot/settings.json` の書き込みを原子化する（DR4-013）**: `writeCopilotHookSettings` は現行 `readCopilotSettings` → `mergeCopilotHookSettings` → `writeFileSync` の素の read-modify-write（ロックも temp+rename も無い）。**一時ファイル ＋ `rename` の原子的置換**にし、同一プロセス内の書き込みを直列化、プロセス間はロックファイル（`~/.copilot/.cmate.lock`）で排他する。取得できなければ書き込まず hooks なしで起動する（現行 fail-open と同じ方向）。書き込み前に 1 世代のバックアップを残す。**#1904 が URL を port 非依存にしても初回書き込みの競合は残る**（複数サーバ同時稼働は公式機能）。
- dedup / eviction のカウンタを `structuredEvents` に露出（§7）。
- **ソース入口の共通バリデータを 1 つ作る（DR4-001 / DR4-014）**: `src/lib/hooks/sources/event-mapper.ts` に **`readBoundedId`** を追加し（現行 `readStringField` / `readNestedString` は非空判定だけで長さ上限も文字種制約も無い。`boundDetail` のような slice が無い）、`sources/*/` が payload から id / sessionId / toolName を取り出す経路を**すべてこれに通す**。上限値は push 経路（`/api/hooks/agent-event`）の定数を**共有**し、2 箇所に分かれないようにする（§10 外部入力の表）。**不正値は破棄（切り詰めない）**。
- **`payloads.ts` の `raw: payload`（受信 payload の全量保持）をやめる**（`toOpencodePendingPermission` / `toOpencodePendingQuestion`）。deny パターン照合に必要な部分だけを上限つきで切り出して保持する（DR4-009）。
- **`client.ts` の全 fetch を `redirect: 'manual'` にし、`content-type` を検証する**（`requestJson` は `application/json`、`readOpencodeEventStream` は `text/event-stream`）。3xx はエラーとして扱う。現行は `fetch` の既定（`redirect: 'follow'`）で content-type も見ておらず、**loopback 発の SSRF で `CM_ALLOWED_IPS` の IP 制限を迂回できる**（`src/middleware.ts` の IP 制限は `getClientIp` ベースなので、サーバ自身の loopback fetch は素通りする、DR4-004）。
- **`prompt-response/route.ts`（および Phase 4 の `respond/route.ts`）の `decisionId` 解決を resolve 済み target に閉じる**: 横断検索を実装せず、解決できない id は **404 `decision_not_found`**。Phase 4 では併せて既存 `messageId` 経路に **`message.worktreeId` と URL の `:id` の照合**を追加する（現行は未照合、DR4-003）。

### 6.3 D4（ツール抽象）

- ESLint 設定に `no-restricted-imports` を **severity `error`** で追加。禁止パターンは **`@/lib/tmux/**`・`**/lib/tmux/**`・`./tmux/**` の 3 つ**（§4 D4 と同一定義。`./tmux/**` を落とすと `src/lib` 直下の 6 ファイルが素通りする、DR3-001。初版の `**/tmux/tmux` という書き方は使わない、DR2-013）。allowlist は `overrides` で明示してよい（`no-restricted-imports` は `no-restricted-syntax` と別ルール名なので i18n ガードに干渉しない、DR2-005）。**allowlist の初期値は §16 付録 A の 31 ファイル全件**（投入時点で lint 0 error を保つ、DR3-001）。`tests/unit/guards/tmux-import-allowlist.test.ts` が **ソート済みパス列挙を完全一致で pin**（増加禁止・削除のみ許可。**恒久除外 12 ファイルは削除の進捗対象にしない**）。**allowlist を空にすると 31 件が全件 error になる**ことを陽性対照として同テストに含める。
- **動的取得は `no-restricted-imports` では捕まらないので別に塞ぐ（DR4-005）**: `no-restricted-syntax` に `ImportExpression` / `require` の tmux セレクタを足し（i18n セレクタと同じ base の 1 キー・`error`）、`tmux-import-allowlist.test.ts` にも同じ綴りの検出と **dynamic import 版 / require 版の陽性対照 2 件**を入れる。併せて **allowlist 済みモジュールが tmux シンボルを再エクスポートしないこと**を pin する（`src/lib/session/index.ts` が既に `export * from './claude-session'` を持つため、陽性対照が必須）。
- `NavigationKey` を `src/lib/tmux/tmux.ts` から型モジュール（例 `src/types/terminal-keys.ts`）へ移し、`NavigationButtons.tsx` / `TerminalEscapeHatch.tsx` の型のみ import を解消する（`allowTypeImports` を持つ `@typescript-eslint/no-restricted-imports` へは切り替えない、DR3-001）。`isTmuxControlModeEnabledForClient` も client 安全モジュールへ移設する。
- 陽性テスト: `kill-session` route が `CLITool.killSession` を呼ぶことを直接検証する（間接迂回は lint では捕まらないため）。
- `kill-session` route → `cliTool.killSession(id, instanceId)`。`OpenCodeTool.killSession` は **`/exit`（本文/Enter 分離）→ 待機 → force kill → 後置条件の確認（`hasSession` が false かつ割当 port の `/global/health` が無応答）→ port を forget** の順にする（**現行は `releaseOpencodeEventStream` ＝ `forgetOpencodePort` が先頭にあるため、順序を入れ替える**、DR4-012）。後置条件を満たせないときは `port_orphaned` / `graceful_exit_timeout` を理由コードとして出す。`CopilotTool.killSession` は `/exit`（分離送信）または `C-c` 二度、待機 ≥ 1s。
- **`sendKeys` に `-l`（literal）経路を導入する（DR4-011）**: `KeySequence` の `kind:'literal'` は `tmux send-keys -l`、`kind:'key'` は既存 `ALLOWED_SPECIAL_KEYS` の allowlist 経路。本文とキーを 1 回の `send-keys` に混ぜない。現行はリポジトリ全体で `-l` の使用が 0 件で、本文が `Escape` / `C-c` / `Enter` と一致するとキーとして着弾する。**既存挙動の変更なので CHANGELOG に記載**する。
- `send-user-message.ts` / `terminal/route.ts` の copilot 分岐を削除し `cliTool.sendMessage` に統一。`CopilotTool.sendMessage` は `sendMessageWithSubmitVerification` + copilot の `ComposerSpec`。
- `OpenCodeTool.interrupt()` を override（Escape ×2、間隔 300ms）。**担当は #1894**（Phase 2 表では D1・D2 に加えて **D4** を持つ、DR2-016）。
- `captureSessionOutput` は `ICLITool.captureSpec()` を読む（#1910 の alt-screen 対応の受け皿。#1910 自体は本方針の対象外、DR2-012）。
- **`captureSpec()` の消費者は 2 つある（DR3-014）**: `captureSessionOutput` に加えて **`src/lib/session/worktree-status-helper.ts` の `getStatusCaptureLines`**（opencode → `OPENCODE_PANE_HEIGHT` / gemini → `GEMINI_PANE_HEIGHT` / その他 → `STATUS_DETECTION_CAPTURE_LINES`）が**同じ「ツール別 capture 行数」を第 2 の場所で決めている**。この経路は `captureSessionOutput` を通らない（sidebar / 一覧 API の状態検出が使う）。**Phase 3 で `getStatusCaptureLines` を `captureSpec()` に寄せる**（寄せるまでは pane geometry の定義が 2 箇所に残り、#1910 の alt-screen 対応が capture 経路にだけ入ると状態検出の capture 行数と食い違う）。同ファイルの Claude 限定 `isSessionHealthy` 分岐（`isRunning && cliToolId === 'claude'`）は capability でも `captureSpec` でも表せない別関心なので、扱いは §12 で決める。

### 6.4 D5（解決）

- `resolveSessionTarget` を `src/lib/session/resolve-session-target.ts` に新設（server 側 `resolveInstanceCliTool` を内包、precedence は **roster 優先**）。
- 解決エンドポイント（例 `GET /api/worktrees/:id/resolve-target`）を追加し、CLI 側 `resolveInstanceCliTool`（`src/cli/commands/instances.ts`）と `capture.ts` の `resolvePaneCliTool` を**薄いクライアントに縮退**させる（レスポンスの `resolvedBy` をそのまま運用者層へ出す）。**ローカル解決の残置案・等価性契約テスト案は採らない**（DR2-008）。
- `current-output` / `auto-yes` / `terminal` / `send`（`--model` 検証順）を置換。**`auto-yes/route.ts` は POST 側（`resolution.cliToolId ?? 'claude'`）だけでなく GET 側の `getAutoYesState(id, 'claude')` も同時に直す（DR3-010）**。GET 側は「後方互換のためトップレベルにも既定エージェントの状態を載せる」経路で、ここを直さないと**既定 opencode の worktree で `--enable` が opencode の poller を起動しても、状態読み出しと UI のトップレベル表示は claude の（無効な）状態を返す**。#1909 が消そうとした症状が読み出し側に残る。**auto-yes state は `globalThis.__autoYesStates` の in-memory Map（`auto-yes-state.ts`）で DB 永続化が無いため、既定ツール変更にデータ移行は不要**である（実装 PR がマイグレーションを探さないよう CHANGELOG と §9 に明記する）。
- **CLI の版スキュー対応（DR3-004）**: `GET /api/capabilities` を新設し、CLI は「能力プローブ → 解決エンドポイント」の順で問い合わせる。プローブが**本物の 404**（本文が空 or JSON）なら旧サーバと解釈してローカル解決へフォールバックし、`resolvedBy: 'client-fallback'` を運用者層に出す。`resolvedBy` の union（server / `api-responses.ts` の双方）に `'client-fallback'` を追加する。**プローブは `Accept: application/json` ＋ `redirect: 'manual'` で発行し、401/403 と 3xx/HTML はフォールバックせず即終了する**（§4 D5 決定 1 の判定表、DR4-007）。`client-fallback` を採ったコマンドは **stderr に 1 行の警告**を出す（stdout の JSON 契約は変えない）。
- **`GET /api/capabilities` の実装制約（DR4-008）**: 応答は `serverVersion` と**コードに列挙された固定トークンの配列**だけ。実行時の環境（インストール済みツール、`detector.staleness` の installed バージョン、ファイルパス、port、worktree 件数）を一切反映しない。`AUTH_EXCLUDED_PATHS` に入れない（他の API と同じ認証の下に置く）。`Cache-Control: no-store` を付ける。応答キーの完全一致を `tests/unit/api/capabilities.test.ts` で pin し、**キーが増えたら赤にする**。
- **新設ルートのレート制限方針を 1 行残す（DR4-015）**: `GET /api/capabilities` は定数応答で DB / 子プロセスに触れないため `createRequestRateLimiter` を**適用しない（理由あり）**。**`GET /api/worktrees/:id/resolve-target` は DB を引くため適用側に倒す**（既存の適用例は `repositories/validate-path` と `fs/browse` の 2 ルート）。
- **読み取り経路は conflict でも 200（DR3-015）**: `current-output` / `capture` / `auto-yes` GET は roster 優先で解決し、`resolvedBy:'roster'` ＋ `conflict` をペイロードに載せる。400 は副作用のある経路に限る（§4 D5 決定 3 の表）。
- **`kill-session` route のインライン解決（明示優先・conflict 未検出）を撤去**して `resolveSessionTarget` に置換し、**roster 優先への挙動変更と 400 `instance_tool_conflict`** を CHANGELOG に記載する（DR2-009）。
- `instance_tool_conflict` の理由コードと stdout JSON（400 / exit 2）を定義。
- `no-claude-fallback` ガードを **vitest**（`tests/unit/guards/no-claude-fallback.test.ts`）で追加し、`files` スコープ（`src/app/api/**/route.ts`・`src/cli/commands/**`・`src/lib/session/**`）内で Phase 1 に実測したソート済みパス列挙を baseline として pin する。併せて `.eslintrc.json` の i18n `no-restricted-syntax` を `warn` → `error` に格上げする（DR2-005 / DR2-006）。

---

## 7. 発見可能性（discoverability）設計

規約 5 に従い、**各行に Web UI 側の受け皿**を書く。出せないものは出せない理由を書き残す。

**受け皿は「どの API のどのフィールド経由か」まで書く（DR3-005）**: Web UI の受け皿は 1 本の API ではない。**`PromptPanel` / `ActivityPane` / `AgentInstancesPane` / `TerminalEscapeHatch` は `current-output`（`CurrentOutputResponse`）**で駆動されるが、**ヘッダ状態チップ（`WorktreeDetailSubComponents`）・`BranchStatusIndicator`（sidebar）・`ls` は `GET /api/worktrees` / `GET /api/worktrees/[id]` の `sessionStatusByCli`（`CliToolSessionStatus`）**で駆動される。後者は `isRunning` / `isWaitingForResponse` / `isProcessing` / `waitingKind` / `waitingSince` / `awaitingInstruction` / `model` しか持たず、**reason も evidence も無い**。したがって §6.1 / §13 のチェックリストは `CurrentOutputResponse` への追加と `CliToolSessionStatus` への追加を**2 つの契約変更として別々に立てる**。下表の「経由」列がそれを示す。太字の 3 行は Stage 1 で「無言の自動アクション」として指摘されたもの（DR1-014 / DR1-021 / DR1-012）で、理由コードつきの露出を**必須**とする。

| 判定・自動アクション | CLI / 運用者層の露出 | Web UI の受け皿（経由する API） | 理由コード / フィールド |
|---|---|---|---|
| スクレイパが肯定的証拠を得られない | `capture --json` の `statusEvidence` / `sessionStatusReason` / `isUnclassifiedActive`、`wait` の exit 10 `type:'unclassified'`、**`ls` の状態列＋新設の理由列**（`--json` には `statusEvidence` / `sessionStatusReason`、DR3-005） | 既存 `TerminalEscapeHatch`（`isUnclassifiedActive` 駆動）＝ **`current-output` 経由**／ ヘッダ状態チップの tooltip（`WorktreeDetailSubComponents`）＝ **`GET /api/worktrees` の `sessionStatusByCli` に `statusEvidence?` / `sessionStatusReason?` を additive 追加してから**（DR3-005） | `statusEvidence:'none'`、`sessionStatusReason`（`default` / `no_recent_output` / `unknown_frame`）、`lastKnownStatus` / `lastKnownStatusAt` |
| 直前の確定状態（証拠なしの間の表示） | `capture --json` の `lastKnownStatus` / `lastKnownStatusAt`、`ls` の状態列 | ヘッダチップ（`lastKnownStatus` を表示し tooltip に理由）、`BranchStatusIndicator` ＝ **いずれも `sessionStatusByCli` 経由**。`BranchStatusIndicator` は現状 `BranchStatus`（`'idle'\|'ready'\|'running'\|'waiting'\|'generating'`）と `waitingKind` しか受け取らないため、**props の additive 拡張が前提**（DR3-005） | **保持主体は server**。TTL は `turnStaleAfterMs` と同値、サーバ再起動でクリア（`null` を返す） |
| detector が古い | `capture --json` の `detector.staleness`、`commandmate status` | `AgentSettingsPane` の警告行（＋ヘッダチップ tooltip）＝ `current-output` 経由 | `{ tool, installed, verifiedAgainst }`。**キャッシュが温まるまで `undefined`**（ホットパスで probe を await しない、DR3-013） |
| 構造化 decision の裁定結果 | `capture --json` の `structuredEvents.decisions[]`、`capture --prompts` の監査証跡（既存） | `PromptPanel`（未裁定）／`ActivityPane`（裁定済みの履歴行）＝ `current-output` 経由。**Phase 4 で `PromptPanelProps` に `decisionId` を足し `respond/route.ts` を対応させるまでは表示のみ**（応答は TUI か CLI `respond`、DR3-007） | `{ id, toolName, behavior, delivered, releasedBy }` |
| 自動裁定の**送達期限**が切れた（`decisionTimeoutSeconds`） | `capture --json` の `decisions[].deliveryExpired` | `PromptPanel` に「自動裁定は間に合わなかった。TUI か `commandmate respond` で応答してください」を表示（`waiting` は維持）。**Phase 4 までは表示のみ**（DR3-007） | `deliveryExpired: true`（DR2-004） |
| 未裁定ダイアログの**保持期限**が切れて release された（`dialogPendingMaxMs`） | `capture --json` の `decisions[].releasedBy` | `PromptPanel` が消えた理由を tooltip に出す。**Phase 4 までは表示のみ**（DR3-007） | `dialog_timeout`（DR2-004。初版の `decision_timeout` から改名） |
| **再同期で `stop` を合成した** | `capture --json` の `structuredEvents.lastTurn.closedBy`、`wait` 完了行の basis | `ActivityPane` の行 | `resync_idle` |
| turn を期限 / scraper 証拠 / **セッション再作成（generation）** で強制クローズした | `capture --json` の `structuredEvents.lastTurn.closedBy` | ヘッダチップ tooltip | `stale` / `scraper_evidence` / **`generation`**（DR3-003） |
| turn の開始（`wait` の完了ゲートの根拠） | `capture --json` の `structuredEvents.turnId` / `openedAt` / `closedAt`（additive。`wait` の `adoptTurnStart` の移行先。`lastEventType` / `lastEventAt` は互換のため残す） | ヘッダチップ tooltip（経過時間） | `turnId` / `openedAt`（DR2-007） |
| **`pendingDecisions` の上限破棄** | `capture --json` の `structuredEvents.decisionsEvicted { count, lastAt }` | `AgentInstancesPane` の instance 行にバッジ | `decision_evicted` |
| **identity / 時間窓 dedup で落としたイベント** | `capture --json` の `structuredEvents.dedupDropped { skippedCount, lastSkippedAt, by }`（既存 `promptDedup`（#1695）は `{ skippedCount, lastSkippedAt }` なので**フィールド名をそれに揃える**。DR2-020） | `ActivityPane` の診断行 | `by: 'identity' \| 'time-window'` |
| capability による抑止（ダイアログ予告を記録しない等） | `capture --json` の `structuredEvents.source.capabilities`（宣言値をそのまま。**ホットパスの `current-output` では `source` 名と版だけを返し、`capabilities` 本体は `capture --json` の詳細取得時 / `instances` 一覧でのみ返す**、DR2-022） | `AgentInstancesPane` の instance 詳細 | — |
| Auto-Yes を撃たなかった | `capture --json` の `autoYes.lastSuppression`（既存 #1684 の面） | `AutoYesToggle` の tooltip | `unclassified-frame` |
| 解決された tool / instance | 既存の `cliToolId` / `instanceId` に加え `resolvedBy`。**`client-fallback` のときは stderr に 1 行の警告を必ず出す**（stdout の JSON 契約は変えない、DR4-007） | `AgentInstancesPane` の行（`fallback` と `client-fallback` は**警告色**で表示、DR1-022 / DR3-004） | `explicit` / `roster` / `primary` / `worktree-default` / `fallback` / **`client-fallback`**（旧サーバ相手にローカル解決へ退避した、DR3-004） |
| **opencode ポートの identity が変わった / kill 後も port が生きている（DR4-004 / DR4-012）** | `capture --json` の `structuredEvents.source` の降格理由、`kill-session` 応答の JSON | ヘッダチップ tooltip（「構造化ソースを信用せず scraper に降格した」）／ `AgentInstancesPane` の警告行 | `port_identity_changed`（`/global/health` の `version` 不一致で SSE を開かなかった）／ `port_orphaned`（kill 後も割当 port が応答する）／ `graceful_exit_timeout`（`/exit` が効かず force kill に落ちた） |
| **能力プローブが判定不能だった（認証未通過 / 中間装置、DR4-007）** | CLI は**フォールバックせず即終了**し、stderr に理由を 1 行出す | **出さない**（CLI 専用の判定。Web UI は同一オリジンで認証済みのため該当しない。規約 5 の「出せない理由」） | 401 / 403 は認証エラー、3xx / HTML は `capabilities_probe_unavailable` |
| roster と明示指定の矛盾（**変更経路**） | 400 / exit 2 ＋ stdout JSON | インスタンス選択 UI のエラートースト | `instance_tool_conflict`（`instanceId` / `rosterCliTool` / `requestedCliTool` つき） |
| roster と明示指定の矛盾（**読み取り経路**、DR3-015） | `current-output` / `capture` / `auto-yes` GET は **200** ＋ `resolvedBy:'roster'` ＋ `conflict` | ヘッダチップ tooltip に「roster と指定が食い違っている」を表示 | `conflict: { requestedCliTool, rosterCliTool }`（400 にすると監視スキルが無音の無限ループになる） |
| **証拠なしを外部スキルの一次シグナルに昇格させるか（未決、DR3-012）** | `capture --json` の `statusEvidence` | — | `.claude/skills/orchestrate-monitor/scripts/classify-state.sh` は現状 `sessionStatus == 'waiting'` しか見ず、それ以外は **IDLE に落とす**（＝ D1 が製品層で消そうとしている「否定の不在」をスキル側に温存している）。`statusEvidence` を一次シグナルに昇格させるかは Phase 3 の skill 更新で決める |
| lint / ガードテストの違反 | CI の失敗メッセージに「どの原則（D4/D5）に反したか」と代替 API 名を含める | **出さない**（開発時のみの判定であり、実行時に運用者が観測できる事象ではないため。規約 5 の「出せない理由」） | — |

サーバーログにしか出ない判定を新設しない。

---

## 8. 移行計画

| Phase | 内容 | 成果物 / 対応 Issue | 互換性 |
|---|---|---|---|
| 0 | 本書の確定（マルチステージ設計レビュー） | `docs/design/multi-agent-state-architecture.md` へ転記 | — |
| 1 | ガード先行 ＋ 解決の一本化: `no-restricted-imports`（error・**パターン 3 つ**・**allowlist の初期値は実測 31 ファイル全件**）+ パス列挙 pin、`no-claude-fallback`（**vitest ガード**・スコープ内 baseline 36 箇所 / 19 ファイルの区分確定）、i18n `no-restricted-syntax` の `error` 格上げ、`VERIFIED_AGAINST` 雛形、capability 5 項目の型と宣言値、`resolveSessionTarget` 新設、**`GET /api/capabilities` の新設と CLI の版スキュー対応（DR3-004）** | 本 Issue（#1915） | **挙動変化 3 件**: (a) auto-yes の既定ツールが `claude` から worktree 既定に変わる（#1909。**POST 側と GET 側の両方**、DR3-010。in-memory Map なのでデータ移行は不要）、(b) **`kill-session` の解決が明示優先から roster 優先に変わり、矛盾時 400 `instance_tool_conflict`**（DR2-009）、(c) **読み取り経路の conflict は 400 ではなく 200 ＋ `conflict` フィールド**（DR3-015）。いずれも CHANGELOG に明記。**ガード投入時点の `npm run lint` は 0 error を維持する**（DR3-001）。それ以外の経路は挙動不変 |
| 2 | #1891 の子 Issue をこの方針で実装（下表） | #1893〜#1914 | 各 PR ごとに既存テスト緑 |
| 3 | スクレイパのツール別モジュール化・fixture 移行・`evidence` 導入・**`STATUS_REASON.UNKNOWN_FRAME` の追加（#1927。Phase 2 の scope 外だったため未着地。`grep -rn 'UNKNOWN_FRAME' src/` は 0 件・develop `a175767a` 実測、§6.1）**・`no_recent_output` の `ready` 廃止・**ツール単位の idle 証拠の肯定検出（#1928。copilot は composer ではなく最下行ステータスバー、§4 D1 決定 1）**・**live probe（#1929。copilot は `resolveCopilotExecutable()` 委譲、§4 D2）**・**ツール単位のキルスイッチ（DR3-016）**・**`CliToolSessionStatus` / `ls` への reason 露出（DR3-005）**・**リポジトリ内 skill fixture の更新（DR3-012）** | **#1927 / #1928 / #1929** | `SessionStatus` の**値域は不変**。`statusEvidence` / `lastKnownStatus` は additive な optional フィールド。stalled フレームの表示が `ready` → `running` に変わる。**`input_prompt` 経路の evidence 変更はツール単位**で、そのツールの肯定確認規則と fixture が揃ってから行う（DR2-002） |
| 4 | turn モデルへの置換（**generation フェンス配下**、DR3-003）、`resync` 実装、`mergeStructuredStatus` 改訂、**Web UI の構造化 decision 応答（`respond/route.ts` ＋ `PromptPanelProps` の `decisionId`、DR3-007）** | 新規 Issue | 公開 getter の型は不変。`turnId` / `closedBy` は additive。`respond/route.ts` は `messageId` を optional 化する additive 変更（既存の Web UI 応答は不変） |

**Phase 2 の対応（Issue 番号ベース、DR1-015）**: 群記号での対応づけは Epic の実態とずれるため、Issue 番号で書く。

| 子 Issue | 群 | 支配する原則 |
|---|---|---|
| #1893 / #1895 / #1896 / #1897 | S | D1・D2 |
| #1894 | S | **D1・D2・D4**（二度 Esc の `OpenCodeTool.interrupt()` override は §6.3。検出とツール抽象の両方にまたがる、DR2-016） |
| #1883（既報・OPEN） | — | **D1（opencode の idle composer 肯定検出）・D5 send guard**。`Ask anything...` が `hasActivePrompt=true` になり send が全拒否・sidebar が永続 waiting。§6.1 行(2) と §4 D1 決定 5 の直撃対象（DR2-015） |
| #1884（既報・OPEN） | — | **D5**（`current-output` route が `?instance` を見ないため `wait --instance opencode` が exit 21） |
| #1885（既報・OPEN） | — | **D1・D2**（copilot の生成中フレームが全て `ready`/`input_prompt`） |
| #1886（既報・OPEN） | — | **D1 のダイアログ肯定検出・D4**（copilot の folder-trust ダイアログを `waitForReady` が検出できない） |
| #1898 / #1899 / #1900 / #1901 / #1903 / #1904 | H | D3 |
| #1902 | H | D3（copilot source の正規化。状態機械の変更は伴わない） |
| #1905 / #1906 | L | D4 |
| #1909 | C | D5 |
| #1911 | C | **D1**（`OPENCODE_RESPONSE_COMPLETE` / `OPENCODE_SKIP_PATTERNS` を #1893 と共有するため **#1893 → #1911 の順で直列化**する。応答保存の仕様そのものは本方針の対象外、DR2-016） |
| #1913 | C | **本方針の対象外。ただし `DETECTOR_VERSION_PROBES` の前提を提供する**（`VERSION_PROBES` / `CATALOG_VERIFIED_AGAINST` へ opencode / copilot を追加。§4 D2 の probe 表の出所、DR2-017） |
| #1907 / #1908 | L | **本方針の対象外**（`isInstalled` の偽陽性・起動副作用） |
| #1910 / #1912 / #1914 | C | **本方針の対象外**（alt-screen capture・OSC 8 / logs / model-info・docs / i18n）。#1910 の受け皿として §4 D4 の `captureSpec()` を用意する |

**順序制約**:

- Phase 2 は Phase 0 の確定を待たずに着手してよい。**ただし capability の型に依存する #1901 / #1903 は除く**（Phase 1 成果物の `AgentSourceCapabilities` 5 項目が先に要る、DR3-011）。方針と衝突する実装（route に tmux 直叩きを足す・`'claude'` リテラルのフォールバックを足す・`ready` フォールバックに依存する検出を足す）は PR レビューで差し戻す。
- **Epic #1891 の順序制約を転記する（DR3-011。本書 Stage 2 版は 3 件しか書いておらず、Epic 側の 4 件を落としていた）**:
  - **#1885 → #1895**（S3）を先行必須にする。守らないと **copilot の thinking 定数が二重に直る**。
  - **#1883 → #1896**（S4）を先行必須にする。
  - **#1898（H1）と #1899（H2）は `ingest.ts` を共有**するため直列化する。
  - **#1901（H4）と #1903（H6）は `agent-event-state.ts`（1211 行）を共有**するため直列化する。**その上に Phase 4 の turn モデル置換が乗る**ので、この 2 本が同時に走ると正面衝突する。
- **Phase 3 は S 群（#1893〜#1897）が全てマージされた後に着手する**。Epic #1891 は `cli-patterns.ts` / `status-detector.ts` を S 群が共有するため「1〜2 本ずつ直列マージ」を制約としており、D2 の同ファイル分割はこれと衝突する。
- **#1893 → #1911 は直列**にする（`OPENCODE_RESPONSE_COMPLETE` / `OPENCODE_SKIP_PATTERNS` を共有するため。並行させると opencode の完了マーカーが二重に直る、DR2-016）。
- **#1883 / #1885 / #1886 は D1 のツール単位ロールアウトの入口**である。opencode（#1883）と copilot（#1885 / #1886）の肯定確認規則が入るまで、そのツールの `input_prompt` 経路の evidence を `'none'` に倒さない（DR2-002）。
- **ロールアウトには実行時の後退手段と観測条件を付ける（DR3-016・決定）**: コードレベルの前提条件（規則と fixture が揃うまで倒さない）だけでは、**肯定確認規則が実フレームを 1 パターン取りこぼしただけで、そのツールを使う全 worktree の `wait` が exit 0 ではなく exit 10 を返す**（`wait` は 60 秒 dwell 後に exit 10）。`orchestrate-monitor` / `pm-auto-dev` のような「exit 10 ＝ 人間の判断」に分岐する上位が一斉に止まる。したがって:
  - **(a) ツール単位のキルスイッチ**: env または settings で「そのツールの `input_prompt` 経路の evidence 判定を旧挙動（常に `positive`）へ戻す」スイッチを持つ。再デプロイなしで戻せること。
  - **(b) 観測条件**: 倒す前後で**既存 `unclassified_frames` の記録件数（`observeUnclassifiedFrame`）が有意に増えない**ことをロールアウト判断の材料にする。倒す前に同じ規則を「観測だけ」で走らせて件数を採る。**(b) は §11 の実機行の受入条件に含める**。
- `no-claude-fallback` の 0 件化は Phase 2 以降の目標。Phase 1 は**スコープ内 baseline の pin**（減少のみ許可）に留める。

**ロールバック**: Phase 3/4 はファサード（`detectSessionStatus` / `getStructuredSessionState`）のシグネチャを維持するため、問題があれば内部実装だけを戻せる。

---

## 9. 影響範囲とリスク

| カテゴリ | 対象 | 変更 | リスク | 対策 |
|---|---|---|---|---|
| 検出層（**実測 38 ファイル / 1220 ケース**、DR3-021） | `src/lib/detection/**`、`tests/unit/status-detector*.test.ts`、`tests/unit/lib/cli-patterns.test.ts`、`tests/unit/lib/detection/**`、`tests/unit/detection-*.test.ts`、**`src/lib/__tests__/{status-detector,cli-patterns}.test.ts`**（`src` 配下にも `reason === 'no_recent_output'` を直接 assert するテストがある、DR2-024）。**`no_recent_output` を直接 assert するのは 8 ファイル**（`src/lib/__tests__/status-detector.test.ts` 32 中 1・`tests/unit/lib/status-detector.test.ts` 47 中 1・`tests/unit/detection-help-overlay-1497.test.ts` 4 中 2・`tests/unit/lib/current-output-builder.test.ts` 6 中 1・`tests/unit/cli/commands/wait.test.ts` 61 中 3・`tests/unit/session/structured-status-1723.test.ts` 16 中 3・`tests/unit/session/current-output-structured-status-1723.test.ts` 13 中 1・`tests/unit/status-detector-selection.test.ts` 53 中 1（定数 pin）） | 再編・`evidence` 追加・`no_recent_output` の `ready` 廃止・ツール別 idle composer 肯定検出 | 既存テストの期待値（`ready`/`no_recent_output` → `running`）が変わる。`input_prompt` 経路はツール単位で変わる（**wire 値は `ready` のまま**、DR3-002） | fixture 移行を先に行い、差分は明示的に更新。**`isUnclassifiedActive` は「(3)(4) 由来は真偽不変」と「(2) 由来の新規 `true` は明示列挙」の 2 本に分けて merged レベルで pin**（DR2-001 / DR2-003）。**`tests/unit/cli/commands/wait.test.ts` の「`ready` × `no_recent_output` × `isUnclassifiedActive` 無し → exit 0」は旧サーバ互換の pin として残し、`describe` 名に「旧サーバ（Phase 3 以前）」と明記する**（DR3-018。同ファイルの `isUnclassifiedActive` 付き degraded 形の pin とは矛盾しない） |
| 構造化層（**実測 37 ファイル / 546 ケースが `agent-event-state` を参照**、DR3-021） | `src/lib/session/agent-event-state.ts`（1211 行）、`src/lib/hooks/**`、`permission-decision-service.ts` | turn モデル・capability | Claude の既存挙動（#1720〜#1725）の回帰。**generation フェンスを踏まないと #1723 の回帰（新品セッションが最大 30 分 `running`）が再発し `agent-event-generation-1723.test.ts` が赤になる**（DR3-003）。**#1901 / #1903 が同一ファイルで正面衝突する**（DR3-011） | 既存 Claude fixture/テストを全件維持。capability 既定値は Claude の現行挙動。**turn は generation フェンス配下**（§4 D3 決定 2）。**#1901 / #1903 は直列化し、Phase 1 の capability 型着地後に着手**（§8 順序制約） |
| 統合判定 | `current-output-builder.ts`、`prompt-waiting-composition.ts`、`worktree-status-helper.ts` | 優先順位改訂＋**`mergeStructuredStatus` の上書き分岐の改訂**（構造化 `ready` は `evidence:'positive'` のときだけ `isUnclassifiedActive` を下ろす） | sidebar / `wait` の挙動変化。waiting 判定の二重化。**改訂を忘れると #1708 のガードが無音で外れる**（DR2-003） | waiting は `resolvePromptWaiting` の単一生成を維持。証拠なしは既存 `isUnclassifiedActive` 経路に集約し、`wait` の完了条件（`ready && !isUnclassifiedActive`）は変えない。**ガードの pin は merged レベル（`current-output-builder`）のテストで行う** |
| 統合判定（表示） | sidebar / `ls` / ヘッダチップ / **`MessageInput` のトースト**（DR3-023） | `no_recent_output` 由来の stalled フレームが `ready` → `running`。**`input_prompt` 由来は `ready` のまま**（DR3-002） | 「完了に見えていたものが running に見える」ことへの戸惑い。**`running` は `sessionStatusToActivityFlags` で `isProcessing: true` になり、`MessageInput` の「queued (session busy)」トーストが新たに発火する**（DR3-023）。`.claude/skills/demo-video/scripts/cli-scene.sh` の `wait_until_busy` プローブも `isProcessing` で判定する | `lastKnownStatus` と理由コードを tooltip / `--json` に出す。CHANGELOG に明記。**`input_prompt` を `running` に倒さない決定（DR3-002）により、idle composer のトースト誤発火とデモ収録の破綻は起きない** |
| 統合判定（非影響） | **`MessageList`（DR3-022）** | — | — | **`MessageList.tsx` に `sessionStatus` / `sessionStatusReason` / `isUnclassifiedActive` / `isProcessing` の参照は 0 件**（実測）。props は `messages` / `waitingForResponse` / `generatingContent` / `realtimeOutput` / `isThinking` 等で、タイピングインジケータの thinking は `status === 'running' && reason === STATUS_REASON.THINKING_INDICATOR` 限定（`current-output-builder`）。**`no_recent_output` → `running` でも点灯しない**。後続レビューで再調査しないこと |
| 構造化層（終端） | turn の `stale` / `scraper_evidence` / decision の `deliveryExpired`・`dialog_timeout` | 期限規則の新設（**送達期限と保持期限の 2 本**） | **`decisionTimeoutSeconds` を release 期限に流用すると、push 系全ソースで permission ダイアログが 5〜10 秒（gemini は 0 秒）で `waiting` から外れ、#1725 が再発する**（DR2-004） | turn は現行 staleness bound（30 分）。**送達期限＝`decisionTimeoutSeconds`（`deliveryExpired` を立てるだけ・`waiting` は維持）／保持期限＝`dialogPendingMaxMs`（予告は既存 `STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS` 20 秒、実イベント由来は `turnStaleAfterMs` と同値）** と明確に分ける |
| ツール抽象（**`lib/tmux` importer は実測 31 ファイル**、DR3-001） | `src/lib/cli-tools/*` ＋ **カテゴリ別**: routes 11（`src/app/api/**`）／ pollers 4（`auto-yes-poller`・`polling/{assistant-conversation-poller,global-session-poller,response-checker}`）／ ws・broadcast 6（`ws-server`・`realtime/terminal-broadcast`・`session-key-sender`・`prompt-answer-sender`・`pasted-text-helper`・`session-cleanup`）／ client 4（`components/worktree/{NavigationButtons,TerminalEscapeHatch}`（型のみ）・`components/Terminal.tsx`・`app/worktrees/[id]/terminal/page.tsx`）／ cli 1（`cli/commands/capture.ts`）／ session 5（`cli-session`・`current-output-builder`・`claude-session`・`send-user-message`・`worktree-session-reconcile`）。**ソート済み全件は §16 付録 A** | ゲートウェイ化（恒久除外 12 / 段階解消 19） | kill の graceful exit で待ち時間増。**allowlist が実測より狭いと Phase 1 で `npm run lint`（現状 exit 0 / 0 行）が赤になり、Epic の子 Issue 22 本の CI が一斉に止まる**（DR3-001） | 待機上限を tool 定数で管理、force kill は維持。**allowlist の初期値は 31 件全件**、以後は減らすのみ。**禁止パターンは 3 綴り**（`./tmux/**` を含む）で、空 allowlist なら 31 件全件が error になることを陽性対照で確認する |
| 解決 | 9 route ＋ CLI 4 コマンド（`send` / `capture` / `respond` / `auto-yes`）＋ **`GET /api/capabilities`（新設）** | `resolveSessionTarget`（roster 優先）へ一本化。**CLI 側 `resolveInstanceCliTool` と `capture.ts` の `resolvePaneCliTool` は解決エンドポイント経由の薄いクライアントに縮退**（DR2-008）。`kill-session` のインライン解決を撤去。**読み取り経路の conflict は 200 ＋ `conflict`**（DR3-015） | (a) auto-yes の既定が `claude` から worktree 既定に変わる（**GET / POST 両方**、DR3-010）、(b) **`kill-session` の明示 `?cliTool` 優先が roster 優先に変わり、矛盾時 400 `instance_tool_conflict`**（DR2-009）、(c) 読み取り経路は 400 にしない（DR3-015） | 仕様どおり。**すべて CHANGELOG に明記**。precedence は #1629 の実装と一致させる（**`instanceId` 未指定時は roster を見ない早期 return**、DR3-020）。CLI 側は primary anchor 段が無く server と実際に食い違うため、等価性契約テストではなく server 委譲で揃える。**新 CLI × 旧サーバは能力プローブ 404 → `client-fallback`**（DR3-004）。**読み取り経路を 400 にすると `monitor.sh` が「capture failed, skipping poll」で無音の無限ループになる**（`MAX_POLLS=0` が既定、DR3-015） |
| lint / CI | ESLint 設定、ガードテスト | 追加（severity `error`） | **既存違反で CI 赤**（実測: develop の `npm run lint` は exit 0 / 0 行。allowlist が 31 件に満たないと即赤で子 Issue 22 本が止まる、DR3-001） / warn なら偽 PASS / **baseline に正しいコード（primary anchor・表示既定）を混ぜると誤削除を誘発**（DR3-009） | allowlist・baseline をパス列挙で初期化（**tmux は 31 件全件、`'claude'` は 36 箇所 / 19 ファイルに「解決フォールバック / 対象外」の区分を併記**）、増加禁止。`--max-warnings` に依存しない `error` を使う。**ガードの効きは陽性対照（allowlist を空にすると 31 件 error）で確認する** |
| CLI 契約 | `src/cli/types/api-responses.ts`、`docs/user-guide/cli-operations-guide.md`、commandmate-skills（外部リポジトリ）の転写箇所、**`src/cli/commands/wait.ts` の `SUPPRESSION_CAUSE`**（`Record<AutoYesSuppressionReason, string>`。union に 1 値足すと `npx tsc --noEmit` が落ちる第 3 の更新先、DR3-008） | **`sessionStatus` の値域は不変**。optional フィールドの追加のみ。`resolvedBy` に `'client-fallback'` を additive 追加（DR3-004） | 旧 CLI / 旧 skill が新フィールドを知らない。**新 CLI × 旧サーバ**では解決エンドポイントが 404 になる（`handleApiError` は `code` 無し 404 を `UNEXPECTED_ERROR` にマップするため「worktree が無い」と区別できない、DR3-004） | 未知フィールドは無視されるだけで、`sessionStatus` / `isUnclassifiedActive` の既存分岐はそのまま動く（`wait.ts` の `suppressionCause()` は未知 reason を verbatim 表示する前方互換実装）。**旧サーバ対策は能力プローブ ＋ `client-fallback`**（§4 D5 決定 1）。4 箇所の更新を同一 Phase の受入条件に含める |
| skills（**リポジトリ内**、DR3-012） | `tests/unit/skills/orchestrate-monitor/`（**14 テスト / fixtures 17 件**。うち **4 件が `sessionStatusReason:'no_recent_output'`、14 件が `isUnclassifiedActive`** を持つ）、`.claude/skills/orchestrate-monitor/scripts/{classify-state.sh,monitor.sh,verify-completion.sh}`、`.claude/skills/demo-video/scripts/cli-scene.sh`、**`.agents/skills` の写し** | Phase 3 で `no_recent_output` の wire 値が変わるため、**fixture が「製品が二度と出さない payload」になる** | `fixture-fidelity.test.ts` は「製品が出さない payload を fixture が記述する」ことを **#1522 の根本原因として明示的に禁じている**ため、放置すると赤になる。`classify-state.sh` は `sessionStatus == 'waiting'` 以外を IDLE に落とす（**D1 が製品層で消そうとしている「否定の不在」がスキル側に残る**）。`monitor.sh` は `cliToolId` から `mcbd-<cliToolId>-<worktree-id>` を組み立てて介入先ペインを決める。`cli-scene.sh` は `sessionStatusByCli.claude.isProcessing` でプローブし `[ $FIRST_WAIT -eq 10 ]` を hard assert する | **Phase 3 の受入条件に fixture 再採取（実 `capture --json` の生 payload）を含める**。`.claude/skills` と `.agents/skills` は byte-identical に保つ。`statusEvidence` を `classify-state.sh` の一次シグナルへ昇格させるかは §7 の未決行で決める |
| Auto-Yes | `response-checker.ts`、`auto-yes-resolver.ts`、`api-responses.ts`、**`src/cli/commands/wait.ts`（`SUPPRESSION_CAUSE`）**（DR3-008）、**`src/app/api/worktrees/[id]/auto-yes/route.ts` の GET / POST 両方**（DR3-010） | `detectDialog` 共有・抑止理由の追加・既定ツールの解決一本化 | 抑止が広すぎると自動応答が止まる。**GET 側を直さないと「表示は claude・実際に走るのは worktree 既定の poller」という食い違いが残る**（DR3-010） | 抑止時は必ず `lastSuppression` に出す。実機 UAT で誤抑止を確認。**auto-yes state は in-memory Map（`globalThis.__autoYesStates`）で DB 永続化が無いため、既定変更にデータ移行は不要**（CHANGELOG にもそう書く） |
| docs | `docs/module-reference.md`、`docs/architecture.md`、**`docs/design/upstream-fault-turn-boundary-1839.md`**（§1.3 に「経過 × scraper status/reason × `hasActivePrompt` × `isUnclassifiedActive`」の表を持ち、`wait` の完了条件 `!isRunning \|\| (sessionStatus === 'ready' && isUnclassifiedActive !== true)` を逐語で書いている）、**`docs/user-guide/cli-operations-guide.md`**（exit 10 の type 3 種と exit code 表）（DR3-019） | `module-reference` / `architecture` は 1 行ずつ追記。**残り 2 件は該当節を Phase 3 の受入条件として更新**（`no_recent_output` の wire 値変更・exit 10 の type・`ls` の理由列） | CLAUDE.md サイズ制限。**既存設計文書の逐語表が古くなると、次のレビューが古い表を根拠にする** | CLAUDE.md には書かない。更新漏れは Phase 3 の受入条件で塞ぐ |

---

## 10. セキュリティ設計

**基準**: develop `90b67eb9`。Stage 4（セキュリティ / OWASP）の Must 6 / Should 8 を受けて本節は**全面改訂**した。**初版の次の 3 つの記述は撤回する**。

| 撤回する初版の記述 | 理由（実測） | 差し替え先 |
|---|---|---|
| 「イベント id はキーにしか使わず、**ログ・ファイル名・シェルに渡さない**」 | 既に矛盾している。`sources/opencode/source.ts` は `decisionId` を `logger` に渡し、`permission-decision-service.ts` の `recordAllowedPermission` は `summary` に `prompt_id=…` を埋めて `chat_messages` に保存し、`client.ts` は id を reply URL のパスに載せる（`encodeURIComponent` 済み） | §10.2（**検証を前提に「出してよい」へ**。代わりに検証が無いことを塞ぐ） |
| 「#1904 の『port 非依存 URL を env で運ぶ』は**安全性を下げない**」 | 評価軸が外れている。インジェクションの話ではなく、**Bearer トークンの宛先と実行プログラムを実行時 env へ委譲する特権移譲**である | §10.8（**port のみ・数値検証つき**へ） |
| 「**動的 import / require も同じ制限の対象**とする」 | ESLint 8.57.1 の `no-restricted-imports` は `await import()` / `require()` を検出しない（隔離環境で実測） | §4 D4 の動的 import 節 ＋ §10.11 |

受入条件は **§13.2「セキュリティ受入条件」**にある。§10 の決定で §13.2 に降りていないものを作らない（Stage 4 の DR4-006 は「§10 が実装へ降りない」ことを Must Fix として挙げた）。

### 10.1 外部入力 — push 経路と pull 経路の検証を対称にする（DR4-014）

変更対象の入力は **tmux フレーム**（信頼しない文字列）、**hooks / SSE のイベント payload**（ローカルのツールプロセス由来だが、内容はエージェント＝上流の生成物であり信頼しない）、**CLI / API の `instanceId` / `cliToolId` / `worktreeId`**、および **PATH**（子プロセスの実行体を決める、DR4-010）である。入口は 1 つではなく **2 つ**あるので、2 段に分けて書く。初版の「`resolveSessionTarget` の入口で必ず通す」は **(a) しか覆っておらず、pull 経路は `resolveSessionTarget` を通らない**（subscription の target は CommandMate 自身が保持している）。

**(a) API / CLI 入口**: 既存の `isValidInstanceId` / **`isCliToolType`**（server 側の実体。`isCliToolId` は CLI 側の再エクスポート別名なので、`src/lib/session/` に置く `resolveSessionTarget` からは `isCliToolType` を呼ぶ、DR2-021）/ `isValidWorktreeId` を `resolveSessionTarget` の入口で必ず通す。**`isValidWorktreeId`（`WORKTREE_ID_PATTERN=/^[a-zA-Z0-9_-]+$/`）には長さ上限が無い**ので、`MAX_INSTANCE_ID_LENGTH`（64）と揃えた上限を足す（DR4-009）。

**(b) ソース入口**: `AgentEventSource.normalizeEvent` / `listPending` の戻り値に載る **payload 由来文字列すべて**に長さ上限と文字種を適用する。現行の pull 経路は `event-mapper.ts` の `readStringField` / `readNestedString`（非空判定のみ）と `payloads.ts`（`id` / `sessionID` / `kind` / `metadata` を無検証で採用）だけで、**長さ・文字種・件数の検証が 1 つも無い**。一方 push 経路（`/api/hooks/agent-event`）は `isValidInstanceId` / `MAX_SESSION_ID_LENGTH`=256 / `validateHookCwd` / `getWorktreeById` による DB 実在確認 / detail・message の slice を全部通している。**この非対称のまま D3 が pull 側の文字列（`turnId` / `sessionId` / `toolName` / decision id / option label）を状態機械の一級キーへ昇格させてはならない**。

| 対象 | 上限 | 文字種 | 逸脱時 |
|---|---|---|---|
| decision id / permission id / message id / toolCallId / `turnId` | **`MAX_SESSION_ID_LENGTH`（256）**（push 経路と同じ定数を共有する） | `^[A-Za-z0-9._:-]+$` | **その decision / イベントごと破棄**（§10.2） |
| `sessionId` | `MAX_SESSION_ID_LENGTH`（256） | 同上 | 破棄 |
| `toolName` / detail | `MAX_EVENT_DETAIL_LENGTH`（128） | 制御文字を除去 | slice（既存 `boundDetail` と同じ） |
| option label | 既存 `ask-user-question-payload` の上限 | 制御文字を除去 | slice |
| message 本文 | `MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH` | 制御文字を除去 | slice |

**定数は共有する（値を 2 箇所に持たない）**: push 経路の route が使っている定数をそのまま参照する。**id の上限は DR2-021 で決めた 128 ではなく 256（`MAX_SESSION_ID_LENGTH` と同値）に改める**。128 の根拠は `MAX_EVENT_DETAIL_LENGTH` との並びだったが、DR4-014 の要求は push / pull を**同じ値**にすることであり、push 側が 256 で受理する id を pull 側だけ 128 で落とすと、**同じ id が経路によって通ったり落ちたりする**。別名 `MAX_EVENT_ID_LENGTH` を置く場合も同じ定数を参照し、値を複製しない。`MAX_EVENT_DETAIL_LENGTH`（128）は引き続き detail / `toolName` の上限として使う。実装は `event-mapper.ts` の **`readBoundedId`**（共通境界）に置き、ソースごとに書かない（§6.2）。

### 10.2 id の検証・破棄・ログ方針（DR4-001）

1. **検証**: SSE / `GET` replay から取り出した時点で、上表の長さ上限と文字種で検証する。
2. **破棄（切り詰めない）**: 外れた id は **decision / イベントごと破棄**する。**切り詰めてはならない** — 切り詰めた id で reply すると**別のリクエストに当たりうる**（reply は `POST /permission/:id/reply` で id がそのまま宛先になる）。破棄は無言で行わず、`decision_evicted` と同じ扱いで**件数を露出**する（DR1-021 と同じ規律、§7）。
3. **ログ方針（初版の「ログに渡さない」を撤回）**: **検証済みの id はログ・DB summary・運用者 JSON に出してよい**。実装が既にそうなっており（`source.ts` の `decisionId` ログ、`permission-decision-service.ts` の `summary` の `prompt_id=…`、`capture --json` の `structuredEvents.decisions[].id`、`wait` exit 10 の `decisionId`）、これは運用上必要な追跡情報である。**出さないのは prompt 本文 / ツール入力の中身**（`PendingDecision.raw` を保持しないこと、§10.10）であって id ではない。ログ注入は「無制限長・任意文字種の id が入ること」で起きるので、対策は 1. と 2. で足りる。
4. capability は「id の出所」を宣言するだけで（`eventIdentity`）、id 自体の抽出と検証はソース実装 ＋ 共通境界（`readBoundedId`）が担う。

### 10.3 decisionId の解決スコープ（DR4-003・IDOR）

- **`decisionId` の解決は、`resolveSessionTarget` が返した (worktreeId, cliToolId, instanceId) に紐づく `pendingDecisions` の中だけで行う。横断検索を実装してはならない。**
- **解決できない id は 404 `decision_not_found`** を返し、下流（`replyOpencodePermission` / 各 `source.deliverVerdict`）へ**渡さない**。「見つからなければそのまま送る」フォールバックを作らない。
- **Phase 4 の `respond/route.ts` ＋ `PromptPanelProps.decisionId` にも同じ規則を適用する**。併せて、**既存の `messageId` 経路が `getMessageById(db, messageId)` を引くだけで `message.worktreeId` と URL の `:id` を照合していない**（実測）ことを Phase 4 で修正する。**この前例を新しい `decisionId` 経路に持ち込まないこと**が本項の主眼である。
- 危険の形: `pendingDecisions` は合成キー `(worktreeId, cliToolId, instanceId)` で保持されるのに、`respond` の入力は worktreeId ＋ 任意文字列である。横断検索を選ぶと **worktree A への `respond` が別 instance の permission を承認**し、opencode の reply は port 単位なので**別の port へ送られる**。

### 10.4 opencode ポートの信頼境界（DR4-004）

**前提の訂正**: §10.13 の「同一ユーザー」前提は**プロセス / tmux に限る**。**loopback の TCP ポートは同一ユーザー境界の外**であり、127.0.0.1 には同一ホストの任意プロセスが bind できる。D3 は SSE と `GET /session/status` / `GET /permission` の内容を**そのまま状態機械の権威**にする（§5.2 の優先順位 2 は open turn を scraper の肯定的証拠より上位に置く）ため、「port N に居るのが本当にこの pane の opencode か」が完全性リスクに直結する。

決定:

1. **再接続のたびに `/global/health` を通す**。`version` が前回と変わっていたら（＝別プロセス）**ストリームを開かず scraper へ降格**し、理由コード `port_identity_changed` を運用者層に出す（§7）。現行 `subscription.ts` の `runStream` は**再接続ループに health check が無く**、`gate.reset()` → `resyncPending()` → `readOpencodeEventStream()` を無条件に回す（health は初回 attach のみ）。
2. **`resync` 由来の `stop` / idle 合成は、この health チェックを通過した後にだけ行う**。`closedBy:'resync_idle'` は「ストリームの内容ではなくポーリング結果で turn を閉じた」ことを意味するので、identity が確認できないときに使ってはならない。
3. **`client.ts` の全 fetch を `redirect: 'manual'` にし、3xx を失敗として扱う。`content-type` も検証する**（`requestJson` は `application/json`、`readOpencodeEventStream` は `text/event-stream`）。現行は `fetch` 既定の `redirect: 'follow'` で content-type も未検証のため、**rogue が 302 を返せばサーバ側 fetch を任意 URL へ誘導でき、宛先が自分自身の API なら送信元が 127.0.0.1 になって `CM_ALLOWED_IPS` の IP 制限を迂回できる**（`middleware.ts` の IP 制限は `getClientIp` ベース。認証既定 OFF の構成で成立する）。
4. **`isPortFree` の TOCTOU は消せない**。`allocateOpencodePort` は bind して即 close する判定なので、判定と opencode 自身の bind の間に窓がある。したがって**「空いていた」ことを根拠にせず、launch 後に「その port の `/global/health` が応答すること」を確認してから subscription を開く**（現行 attach の順序を規約として固定する）。
5. **kill の後置条件**（§4 D4 / §10.9 の graceful exit）を満たすまで port を forget しない。

**残留リスクの明示**: 上記を入れても、**先に port を奪ったプロセスは「その port の opencode」として振る舞える**。ただし影響は非対称である。

| 偽造できるもの | 偽造できないもの |
|---|---|
| `stop` フレーム / `GET /session/status` の `idle` → **turn を閉じ `commandmate wait` を exit 0（完了）に化けさせる**（`closedBy:'stop'` / `'resync_idle'`） | **承認（permission の裁定）**。裁定は CommandMate 側のポリシーが行い、reply の宛先は target 由来の port なので、rogue は「承認を受け取る」ことはできても**運用者の許可を偽造して CommandMate に何かを実行させることはできない** |

緩和は (1) health ＋ version 確認、(2) **`closedBy:'resync_idle'` を運用者層に出す**（合成 stop であることを隠さない、§7）、(3) 将来の強化として **opencode の `OPENCODE_SERVER_PASSWORD` 対応**（起動時に生成した秘密を CommandMate 側だけが知る）を §15.6 の Consider として記録する。

### 10.5 opencode reply API

- `POST /permission/:id/reply` は **loopback（`127.0.0.1`）固定**。CommandMate は `--hostname` / `--mdns` を渡さず、`client.ts` は `OPENCODE_SERVER_HOST` 定数のみを使う（Stage 4 実測で確認済み、§15.7）。
- **id は SSE / replay で受けたものだけを使う**（`respond` が受け取った任意文字列を id にしない。`respond` は 番号 / ラベル / server が発行した `pendingDecisions[].id` → pending decision に解決する）。path traversal は `client.ts` の `encodeURIComponent(requestId)` で既に塞がれている（§15.7）が、**この encode に依存せず §10.1 / §10.2 の検証を前段に置く**（encode は「壊れた id を安全に送る」だけで、「壊れた id を送らない」ことは保証しない）。
- **tmux フレーム由来の文字列が reply の id になる経路は設計上塞がれている**。Phase 4 で Web UI から `decisionId` を受けるときも同じ制約（§10.3）を適用する。

### 10.6 `GET /api/capabilities` の開示範囲と判定（DR4-008 / DR4-007）

**構成上の前提**: `src/middleware.ts` は `CM_AUTH_TOKEN_HASH` が未設定なら**認証を丸ごとスキップ**し（後方互換）、`src/lib/env.ts` は `CM_BIND='0.0.0.0'` を正当な値として許す（モバイル利用のための LAN 公開）。**「認証 OFF ＋ 0.0.0.0 bind」は実在する構成**なので、新設エンドポイントの開示範囲は §4 の 1 文ではなくここで決定として持つ。

1. 応答は **`serverVersion` と、コードに列挙された固定トークンの配列だけ**。**実行時の環境を一切反映しない**（インストール済みツール一覧、`detector.staleness` の installed バージョン、hook 設定ファイルのパス、port、worktree 件数を載せない）。
2. **`AUTH_EXCLUDED_PATHS` に入れない**（他の API と同じ認証の下に置く）。
3. `Cache-Control: no-store` を付ける。
4. `tests/unit/api/capabilities.test.ts` が**応答キーの完全一致**を pin し、キーが増えたら赤にする。
5. **プローブ側（CLI）は「成功しなければローカル解決」と実装しない**。判定は §4 D5 決定 1 の 4 分岐表に限り、**401 / 403 と 3xx / HTML ではフォールバックしない**。`Accept: application/json` ＋ `redirect: 'manual'` で発行する。`client-fallback` は primary anchor 段を持たない**劣化解決**なので、静かなダウングレードは `send` / `respond` の着弾先を変えうる。
6. `resolvedBy:'client-fallback'` を採ったコマンドは **stderr に 1 行の警告**を出す（stdout の JSON 契約は変えない）。

### 10.7 資格情報・launch env（DR4-002 / DR4-017）

- `CM_AUTH_TOKEN` は hook 側が**プロセス環境の継承**から読む。**本書で新しい secret は増えない**（Stage 4 実測、§15.7）。
- **`AgentLaunchPlan.env` に秘密を載せてはならない（DR4-017・決定）**: `renderAgentLaunchCommand` は `plan.env` を `NAME='value' command` の 1 行として描画し、それを `sendKeys` で pane に打ち込む。**この行は pane の scrollback に残り `capture --json` にも載る**。現状 `plan.env` に入るのは `CM_AGENT_WORKTREE_ID` / `CM_AGENT_INSTANCE_ID` だけで `CM_AUTH_TOKEN` は入っていない（＝ pane には出ない）。#1904 で `plan.env` の中身が増えるときも、**秘密はプロセス環境の継承でのみ渡す**（現行 copilot の作法）。
- **Bearer トークンの宛先を広げない**: `curlArgumentPreamble()` は `CM_AUTH_TOKEN` があれば **宛先と無関係に** `Authorization: Bearer …` を付ける。したがって**宛先が定数のまま**であることがトークン漏洩の防波堤になっている（§10.8）。宛先を可変にする変更は、必ず「Authorization を付けるのは `127.0.0.1` 宛のときだけ」という shell 側条件とセットにする。
- **`CM_HOOK_*` は CommandMate が launch line で必ず上書きする変数**として一覧化し、`tests/unit` で launch line に含まれることを pin する。併せて **`CM_HOOK_*` を、エージェントの子プロセス環境から除去する対象**（`sanitizeSessionEnvironment` / `SENSITIVE_ENV_KEYS` 相当の一覧。現行 `sanitizeSessionEnvironment` が unset するのは `CLAUDECODE` の 1 本だけで、`SENSITIVE_ENV_KEYS` に `CM_HOOK_*` は無い）に加え、**CommandMate が設定しない経路で外から持ち込まれた `CM_HOOK_*` が効かない**ようにする。

### 10.8 #1904 の env 経由 hook 設定（DR4-002・初版の評価を撤回）

**現状の安全性の出所**: copilot の生成コマンドでは、宛先ホストが `hook-settings.ts` のモジュール定数 `HOOK_HOST='127.0.0.1'`、port が `getServerPort()`、relay が `resolveRelayScriptPath()` の **生成時に確定した絶対文字列**で、いずれも `shellQuote` 済みである（`shellQuote` の POSIX 単一引用符エスケープ自体は正しい、§15.7）。**実行時にどれも差し替えられない**ことが安全性の根拠であり、「env 名が固定でクオートしてあるか」ではない。

決定（#1904 の実装制約）:

1. **env で運ぶのは port だけ（`CM_HOOK_PORT`）**。**scheme / host / path は生成時の定数のまま**にする。hook コマンドの先頭で数値検証を通してから URL を組み立てる:

   ```sh
   case "$CM_HOOK_PORT" in ''|*[!0-9]*) exit 0;; esac
   ```

   （検証に落ちたら**発火しない**。`cat >/dev/null; printf '{}'` などツール側が期待する空応答を返してから `exit 0` する形は、各ツールの hook プロトコルに合わせて実装 PR で確定する。）
2. **relay スクリプトの絶対パスを env で運ばない**。これは「hook 発火のたびに実行するプログラム」を実行時 env に委譲する＝**ローカルコード実行の委譲**になる。#1904 が挙げた「checkout が消えると `exit 2`」は、**ファイルに書いた絶対パスが存在しないときに inline curl へフォールバックする既存分岐**で解く。
3. **`${VAR:-default}` の綴りを使わない**。#1904 本文の `"${CM_HOOK_URL:-…}"` は**未設定時に既定へ落ちる**形なので、CommandMate が設定し忘れた経路が**黙って別の宛先を採る**。未設定なら発火せず `exit 0`。
4. **どうしても URL 全体を env で運ぶ場合**は、(3) の既定値なし ＋ **Authorization ヘッダの付与を `127.0.0.1` 宛に限定する shell 側条件**を必ず併記する（§10.7）。`guardPrelude` の `CM_AGENT_WORKTREE_ID` ガードは**env を書ける相手には防壁にならない**（同じ経路で設定できる）ので、ガードの存在を根拠にしない。
5. `CM_HOOK_*` の扱いは §10.7 のとおり（launch line で必ず上書き ＋ 子プロセス環境からの除去）。

### 10.9 global-singleton 設定ファイルの書き込み規約（DR4-013）

対象は copilot の `~/.copilot/settings.json`（`configScope: 'global-singleton'`）。現行 `writeCopilotHookSettings` は `readCopilotSettings` → `mergeCopilotHookSettings` → `writeFileSync` の**素の read-modify-write**で、ロックも temp+rename も無い。CommandMate は `commandmate start --issue N --auto-port` による**複数サーバ同時稼働を公式にサポート**している。

1. 書き込みは**一時ファイル ＋ `rename` の原子的置換**にする（`writeFileSync` の直書きをやめる）。**`writeFileSync` の途中でプロセスが落ちるとユーザー自身の settings.json が切り詰められる**（同モジュールの docstring 自身が「イベントを失うのは回復可能だが、ユーザーの設定を上書きするのは回復不能」と述べている）。
2. 同一プロセス内の書き込みを**直列化**し、プロセス間は**ロックファイル（`~/.copilot/.cmate.lock`）で排他**する。取得できなければ書き込まず hooks なしで起動する（現行の fail-open と同じ方向）。
3. 書き込み前に**既存ファイルのバックアップを 1 世代**残す。
4. #1904 が URL を port 非依存にすると書き換え頻度は下がるが、**初回書き込みの競合は残る**。

### 10.10 DoS / リソース上限（DR4-009 / DR4-015）

初版の上限は turn 数と `pendingDecisions` の evict 規則だけで、**pull 経路の実際の増幅点を覆っていなかった**。D3 決定 3 が `resyncPending` の契機を一般化して replay 頻度を上げるため、次の 6 項目を決定とする。

1. **turn レコード**: instance ごとに上限（例 100）を持ち、古いものから破棄する。**`pendingDecisions` の破棄は無言で行わない**（DR1-021）: (a) 破棄時に `decision_evicted` を理由コードとして記録し件数を `capture --json` に出す（§7）、(b) **未裁定の decision を持つ turn は evict 対象から除外**し、上限に達したら裁定済みの turn から落とす。
2. **SSE の 1 フレーム上限**（例 256 KiB）を `createSseParser` に持たせる。現行は `buffer += chunk` を改行が来るまで**無制限に伸ばす**。超過したらバッファを捨てて再接続する（再接続は §10.4 の health を通る）。
3. **replay の採用件数上限**（例 50）: `GET /permission` / `GET /question` は `asObjectArray` で**件数無制限に受ける**。超過分は `decision_evicted` と同じ理由コードで件数を露出する。
4. **`PendingDecision.raw` を保持しない**: 現行 `toOpencodePendingPermission` / `toOpencodePendingQuestion` は受信 payload を `raw: payload` で**まるごと保持**するため、件数上限だけでは 1 件あたりのサイズが抑えられない。deny パターン照合に必要な部分だけを `MAX_DENY_MATCH_TEXT_LENGTH` 相当で切り出して持つ（**運用者層へ出さないだけでなく、保持もしない**）。
5. **`eventIdentity` の dedup 集合**は既存 `MAX_RECENT_EVENT_KEYS`=512 と同じ定数族に置き、instance ごとに上限を持つ（`MAX_TRACKED_TOOL_CALLS`=256 と併せて既存の良い前例に揃える）。
6. **`isValidWorktreeId` に長さ上限**を足す（`MAX_INSTANCE_ID_LENGTH`=64 と揃える）。
7. **レート制限の方針を 1 行残す（DR4-015）**: 新設ルートは既存 `createRequestRateLimiter` を適用するか、**適用しない理由を書き残す**。`GET /api/capabilities` は定数応答で DB / 子プロセスに触れないので**適用しない（理由あり）**。**`GET /api/worktrees/:id/resolve-target` は DB を引くので適用する**。

### 10.11 lint ガードと子プロセス（DR4-005 / DR4-010）

- **lint ガード自体は外部入力を扱わない**。ただし**ガードが実際には効かない範囲を明記していないと、偽の安心を与える**: ESLint 8.57.1 の `no-restricted-imports` は静的 `import` と `export … from` のみを検出し、`await import()` / `require()` は検出しない（実測）。動的取得は `no-restricted-syntax` のセレクタ ＋ vitest ガードで塞ぐ（§4 D4）。**allowlist 済みモジュールの `export * from` 再エクスポート**（`src/lib/session/index.ts` が実例）も別 pin で塞ぐ。
- **PATH は信頼できる入力ではない**（DR4-010）: `DETECTOR_VERSION_PROBES` の 3 → 7 拡張は、`opencode` / `copilot` / `gemini` という一般的な名前を PATH から解決して**サーバ権限で実行する**箇所を増やす。probe は**起動に使う実行体と同じ解決方法**で、**絶対パスに解決してから `execFile`** する。解決できなければ probe をスキップする。`sanitizeEnvForChildProcess()` の env で起動し、`timeout` に加えて `maxBuffer` を明示する（§4 D2）。
- **probe は環境を変更してはならない**（DR4-010 (5)・#1979 で追加）: `gh copilot -- --version` は **未インストール環境で copilot のリリースをダウンロードする**（gh 自身の help がそう述べる。#1907 実測）。probe が任意のネットワーク取得とインストールを起こすと、供給元の乗っ取り（A08）がそのままサーバ権限のコード実行になる。copilot の probe は **`resolveCopilotExecutable()`（`CopilotTool.startSession` と同じ解決）へ委譲**し、実行可能ファイルが実在するときだけ絶対パスで `--version` を撃つ（§4 D2 の DR4-010 訂正）。

### 10.12 tmux 送出面（DR4-011）

- **ユーザー / エージェント由来のテキストは常に `-l`（literal）経路で送る**。`tmux send-keys` は引数を**まずキー名として解決**するため、`-l` なしでは本文がちょうど `Escape` / `C-c` / `Enter` / `BSpace` / `Up` と一致したときに**キーとして着弾**する（リポジトリ全体で `-l` の使用は実測 0 件）。
- **キー名 allowlist（`ALLOWED_SPECIAL_KEYS` / `ALLOWED_SINGLE_SPECIAL_KEYS`）を通らない文字列を key として送る経路を新設しない**。`KeySequence` を判別可能 union にする決定は §4 D4。
- shell 側は `shellQuote`（POSIX 単一引用符エスケープ）が正しく、tmux は `execFile` 経由でシェルを介さない（§15.7）。**この 2 点は維持する**（`exec` 系を `shell: true` に変える変更を入れない）。

### 10.13 XSS（DR4-016）

**新設フィールド（`statusEvidence` / `sessionStatusReason` / `closedBy` / `decisions[].id` / `toolName` / `conflict` / `resolvedBy`）はすべてエージェント由来の文字列を含みうる。React のテキストノードとしてのみ描画し、`dangerouslySetInnerHTML` / `title` 属性 / ANSI→HTML 変換器へ渡さない。** 現時点では実測でリスク無し（`PromptPanel.tsx` / `ActivityPane.tsx` に `dangerouslySetInnerHTML` も `title=` も無い。`MessageList.tsx` / `TerminalDisplay.tsx` は `innerHTML` を使うが `AnsiToHtml({ escapeXML: true })` を通し、かつ `MessageList` は本設計の消費者ではない＝ Stage 3 の否定的実測）だが、**次に `toolName` / `closedBy` を tooltip や ANSI レンダラへ載せる実装が同じ確認をやり直さないよう**、評価を本節に残す。

### 10.14 権限モデル

- **tmux / プロセスの権限モデルは不変（同一ユーザー）**。
- **この前提を loopback ポートへ延長しない**（§10.4）。127.0.0.1 の TCP ポートは同一ユーザーに閉じていない。
- **opencode server は既定で無認証の loopback API** であり（`client.ts` の docstring が「loopback 以外に bind すると任意コマンド実行 API をネットワークに公開することになる」と明記）、**「pane の寿命 ＝ server の寿命」という前提が破れた場合を検出できる必要がある**（§4 D4 の graceful exit 後置条件 / `port_orphaned`）。
- hooks 受信口（`/api/hooks/agent-event` / `/api/hooks/permission-request`）は `AUTH_EXCLUDED_PATHS` に無く middleware の Cookie / Bearer 検証を通る（§15.7）。**新設の受信口を `AUTH_EXCLUDED_PATHS` に足さない**。

---

## 11. テスト戦略

| 層 | テスト | 要点 |
|---|---|---|
| スクレイパ | `tests/unit/detection/tools/<tool>/fixtures.test.ts` | fixture 全件走査。各ツールに「処理中語彙を 1 語変えたフレーム → 証拠なし（`evidence:'none'`）」を**受入条件**として必須化（変異注入でしか非空虚性を証明できない、DR1-020） |
| スクレイパ（互換 A: 等価） | `tests/unit/session/current-output-unclassified.test.ts`（新規 or 既存に追加。**`current-output-builder` を通した merged 値を検証する**） | `no_recent_output`（3）/ `default`（4）由来の `isUnclassifiedActive` の真偽が新旧定義で一致することを pin。**構造化 `ready` × scraper `running` の組合せを必ず含める**（`mergeStructuredStatus` の上書き分岐で `true` → `false` に反転しないこと。scraper 単体 fixture では検出できない、DR2-003） |
| スクレイパ（互換 B: 拡大） | 同上（**別表として分離**） | `input_prompt`（2）由来で**新たに `true` になる fixture を明示列挙**して pin する。ここは等価性を pin しない（設計どおり実装すると必ず落ちるため、DR2-001）。ツール単位ロールアウトのため、肯定確認規則が未実装のツールは「現行どおり `false`」を pin する |
| 構造化 | `tests/unit/hooks/sources/capabilities.test.ts`、`tests/unit/session/turn-model.test.ts` | §4 D3 の 6×5 表を**完全一致で** pin（**これが D3 の受入指標。grep 0 件は着手前から真なので指標にしない**、DR3-006）。**各 capability の宣言値を反転させると `turn-model.test.ts` のどのケースが赤になるかを受入条件として明記**（変異注入、DR1-020 / DR3-006）。実機で採った SSE 列（`permission.asked → replied → message.updated(user) → idle → message.updated(user)`）、copilot の `UserPromptSubmit → 12s → SessionStart`、別 session の idle、`stop` 欠落 → `stale` / `scraper_evidence` クローズ、`decisionTimeoutSeconds` 超過の release。**セッション再作成をまたいだ turn の非継承**（`beginAgentEventGeneration` 後に前世代の open turn が `running` を作らないこと。既存 `tests/unit/session/agent-event-generation-1723.test.ts` と整合、DR3-003） |
| 統合 | `tests/unit/session/current-output-*.test.ts` | 優先順位 5 段の組合せ表。waiting が `resolvePromptWaiting` の出力とのみ一致すること |
| 消費者契約 | `tests/unit/session/consumer-contract.test.ts`（新規、DR1-020） | 「証拠なし / `waiting` / `ready` を返したとき、`wait` の完了判定・send guard（`blocksSend`）・Auto-Yes・sidebar 集約・`ls` がそれぞれどう振る舞うか」を 1 本の表駆動テストで pin |
| ガード | `tests/unit/guards/{tmux-import-allowlist,no-claude-fallback}.test.ts` | **ソート済みパス列挙の完全一致 pin**（件数 pin は不可）。増加禁止・削除のみ許可（tmux 側の**恒久除外 12 ファイルは削除の進捗対象にしない**、DR2-013 / DR3-001）。**初期値は §16 付録 A の 31 件全件**とし、**allowlist を空にすると 31 件が全件 error になる陽性対照**を同テストに含める（パターンが 3 綴りを押さえていることの証明、DR3-001）。`no-claude-fallback` は **vitest 側が本体**で、`files` スコープ（`src/app/api/**/route.ts`・`src/cli/commands/**`・`src/lib/session/**`）と**スコープ外の Claude 固有モジュール（`claude-session.ts` / `claude-executor.ts`）**を明示し、**5 綴り**（`??` / `\|\|` / 三項 / 変数初期化 / **呼び出し引数の既定**）を検出する（DR2-005 / DR2-006 / DR3-009）。`kill-session` route が `CLITool.killSession` を呼ぶ陽性テストを併設 |
| CLI 契約 | `tests/unit/cli/config/cross-validation.test.ts`（既存） | `AutoYesSuppressionReason`（`unclassified-frame` 追加）の server / CLI 双方向 pin。**`src/cli/commands/wait.ts` の `SUPPRESSION_CAUSE`（網羅 `Record`）が第 3 の更新先**で、漏らすと `npx tsc --noEmit` が落ちる（DR3-008） |
| skills（リポジトリ内） | `tests/unit/skills/orchestrate-monitor/`（14 テスト / fixtures 17 件） | **`fixture-fidelity.test.ts` は「製品が出さない payload を fixture が記述する」ことを禁じる**（#1522 の根本原因）。Phase 3 で `no_recent_output` の wire 値が変わると **4 fixture が製品の出力と食い違う**（`isUnclassifiedActive` を持つのは 14 件）。fixture は実 `capture --json` の生 payload で再採取する。`monitor-session-target.test.ts` の「payload に `cliToolId` が無ければセッション名を捏造しない」pin は `wait.ts` の表示既定と表裏なので壊さない（DR3-009 / DR3-012） |
| **セキュリティ（DR4-006）** | `tests/unit/hooks/sources/event-id-validation.test.ts`（新規）／ `tests/unit/session/turn-model.test.ts`（既定の置き場）／ `tests/unit/api/capabilities.test.ts`（新規）／ opencode の `client` / `subscription` の単体テスト／ `tests/unit/guards/*`／ hook 生成の単体テスト | **§13.2 の受入条件がそのままテストの一覧である**。本リポジトリの既存のやり方（`AUTH_EXCLUDED_PATHS` の完全一致・`SENSITIVE_ENV_KEYS`・`ALLOWED_SPECIAL_KEYS` の allowlist・`MAX_SESSION_ID_LENGTH` の 400 応答・logger の `SENSITIVE_KEY_PATTERN` がいずれも単体テストで pin されている）に倣い、**§10 の決定は必ず機械可読なガードに落とす**。とくに (a) **不正 id は破棄であって切り詰めではない**こと、(b) `redirect:'manual'`、(c) **health を通す前に stop / idle を信じない**こと、(d) **別 target の decisionId は 404**、の 4 件は**変異注入**（規則を外すと赤になること）まで確認する |
| 実機 | 隔離サーバ（別 port + 隔離 DB）で `send / wait / respond / auto-yes` のシナリオ | Epic #1891 の受入条件と同じ。UAT 手順は `docs/design/` の live-verification 文書に追記。**D1 のツール単位ロールアウトは「倒す前後で `unclassified_frames` の記録件数が有意に増えない」ことを受入条件にする**（観測だけを先に走らせて件数を採る、DR3-016）。**キルスイッチで旧挙動へ戻せることも実機で確認する** |

---

## 12. 非目標

- TUI スクレイピングの全廃（hooks の無い環境・ダイアログ本文の取得・モデル表示には引き続き必要）。
- 7 ツールの同時リファクタ。本書の対象は状態導出と配線の共通部分。各ツールのパターン修正は子 Issue。
- Web UI の見た目の変更（§7 の tooltip / バッジ追加を除く）。
- hooks の配送方式（push / pull）の変更。
- `SessionStatus` の値域変更（D1 決定 2 で明示的に却下）。
- Epic #1891 のうち #1907 / #1908 / #1910 / #1912 / #1913 / #1914 の課題（§8 Phase 2 の表で「対象外」と明記した子 Issue。#1911 は D1 の対象に格上げ、#1913 は対象外だが `DETECTOR_VERSION_PROBES` の前提を提供する）。
- **`no-claude-fallback` の `files` スコープ外**（`src/lib/db/**`（`migrations` を含む）・`src/components/**`・`**/__tests__/**`・`src/lib/hooks/sources/claude/**`・`src/types/**` など）の `'claude'` リテラル。これらは allowlist ではなく**ガードの対象外**とする（`src` 全体では 231 箇所 / 85 ファイルあり、allowlist として現実的でないため、DR2-006）。
- ~~`src/app/api/worktrees/[id]/respond/route.ts`（Web UI の `messageId` 経路）の構造化 decision 対応~~ → **除外を解除し Phase 4 の範囲に入れた**（DR3-007）。CLI `respond` の実経路は `prompt-response/route.ts` である（DR2-010）という事実は変わらないが、`respond/route.ts` と `PromptPanelProps` を外したままだと **「裁定待ちを表示するのに応答できない Web UI」**を出荷することになる。Phase 4 で `decisionId` を受ける口を additive に足す。Phase 4 着地までは §7 の当該 3 行を「表示のみ（応答は TUI / CLI `respond`）」と明記して運用する。
- `src/lib/session/worktree-status-helper.ts` の **Claude 限定 `isSessionHealthy` 分岐**（`isRunning && cliToolId === 'claude'`）の一般化（DR3-014）。capability でも `captureSpec()` でも表せない別関心（プロセス健全性）であり、本書では扱わない。**ただし `getStatusCaptureLines`（ツール別 capture 行数）は Phase 3 で `captureSpec()` に寄せる**（同ファイル内だが別の関心）。

---

## 13. 実装チェックリスト（Phase 0-1）

- [ ] 本書を Stage 1〜4 でレビューし、`docs/design/multi-agent-state-architecture.md` に転記する
- [ ] `AgentSourceCapabilities` に 5 項目（**すべて宣言値**、`eventIdentity` は文字列 union）を追加
- [ ] §4 D3 の **6×5 宣言値表**を `tests/unit/hooks/sources/capabilities.test.ts` で pin（「未検証」セルは既定＝claude 相当であることをコメントで残す）
- [ ] `StatusVerdict` に `evidence: 'positive' | 'none'` を追加（**`SessionStatus` の値域は変更しない**）
- [ ] `STATUS_REASON.UNKNOWN_FRAME = 'unknown_frame'` を追加（使用は Phase 3）
- [ ] `isUnclassifiedActive` を `evidence === 'none'` から導出に置き換え、**merged（`mergeStructuredStatus` 適用後）の値**に対して pin を 2 本用意する: (A) `no_recent_output` / `default` 由来は真偽が変わらない（構造化 `ready` × scraper `running` の組合せを含む）、(B) `input_prompt` 由来で新たに `true` になるケースは別表で明示列挙（DR2-001 / DR2-003）
- [ ] `CurrentOutputResponse` に `statusEvidence?` / `lastKnownStatus?` / `lastKnownStatusAt?` を additive 追加し、`src/cli/types/api-responses.ts`・`docs/user-guide/cli-operations-guide.md`・commandmate-skills の転写箇所を同一 Phase で更新
- [ ] **第 2 の契約変更**: `CliToolSessionStatus`（`src/lib/session/worktree-status-helper.ts` 生成、`GET /api/worktrees` / `GET /api/worktrees/[id]` が返す `sessionStatusByCli`）に `statusEvidence?` / `sessionStatusReason?` / `lastKnownStatus?` / `lastKnownStatusAt?` を additive 追加する。**ヘッダチップ / `BranchStatusIndicator` / `ls` はここが受け皿**で、`current-output` への追加だけでは §7 の 4 行が実装できない（DR3-005）
- [ ] `ls` の表に理由列を追加し、`--json` に `statusEvidence` / `sessionStatusReason` を載せる（`deriveStatus` は boolean 3 分岐のままでよい、DR3-005）
- [ ] `AutoYesSuppressionReason` に `unclassified-frame` を追加（**同時更新先は 3 箇所**: `auto-yes-resolver.ts` / `api-responses.ts` / **`src/cli/commands/wait.ts` の `SUPPRESSION_CAUSE`**。server / CLI 双方向 pin テストが緑、`npx tsc --noEmit` も緑、DR3-008）
- [ ] ESLint `no-restricted-imports`（**severity `error`**、パターンは **`@/lib/tmux/**`・`**/lib/tmux/**`・`./tmux/**` の 3 つ**）＋ **§16 付録 A の 31 ファイルを初期値とするソート済み allowlist**（**恒久除外 12 / 段階解消 19 の 2 区分つき**）＋ `tmux-import-allowlist.test.ts`（完全一致 pin ＋ **allowlist を空にすると 31 件が全件 error になる陽性対照**）（DR2-013 / DR3-001）
- [ ] **投入直後に `npm run lint` が exit 0 / 0 error のままであることを確認する**（develop の実測値。赤くすると Epic の子 Issue 22 本の CI が一斉に止まる、DR3-001）
- [ ] `NavigationKey` を `src/lib/tmux/tmux.ts` から型モジュール（例 `src/types/terminal-keys.ts`）へ移し、`NavigationButtons.tsx` / `TerminalEscapeHatch.tsx` の型のみ import を解消する（**`@typescript-eslint/no-restricted-imports` + `allowTypeImports` へは切り替えない**。理由は §4 D4、DR3-001）
- [ ] `kill-session` route が `CLITool.killSession` を呼ぶ**陽性テスト**
- [ ] `no-claude-fallback`: **vitest ガード**（`tests/unit/guards/no-claude-fallback.test.ts`）で実装し、`files` スコープを `src/app/api/**/route.ts`・`src/cli/commands/**`・`src/lib/session/**` に限定（DR2-005 / DR2-006）
- [ ] **スコープ内の `'claude'` リテラル baseline は実測済み（36 箇所 / 19 ファイル: api 20/13・cli 8/3・session 8/3）**。Phase 1 の最初の作業は測定ではなく **1 行ごとの区分（解決フォールバック / 対象外）の確定**とし、そのソート済みパス列挙を pin する（減少のみ許可。対象外行は削除の進捗指標に数えない、DR3-009）
- [ ] `no-claude-fallback` のスコープ外に **`src/lib/session/claude-session.ts` / `src/lib/session/claude-executor.ts`** を加え、**表示 / ラベル用の既定（`wait.ts`）・commander の option 既定（`report.ts`）・コメント行（`capture.ts`）は対象外**と明記する（DR3-009）
- [ ] 検出の綴りに **`f(..., 'claude')`（呼び出し引数の既定）** を加える（`auto-yes/route.ts` の `getAutoYesState(id, 'claude')` を捕まえるため、DR3-009）
- [ ] `.eslintrc.json` の i18n `no-restricted-syntax` を `warn` → `error` に格上げ（現状 `npm run lint` は exit 0 / 警告 0 件なので CI は緑のまま。1 ルール 1 severity の制約への対応、DR2-005）
- [ ] `resolveSessionTarget` の新設（precedence は **roster > 明示指定**、#1629 準拠。**`instanceId` 未指定時は roster を見ずに「明示指定 or null」を即返す**、DR3-020）と `current-output` / `auto-yes` の置換（#1884 / #1909 と同時でもよい）
- [ ] **`auto-yes/route.ts` は POST 側（`resolution.cliToolId ?? 'claude'`）と GET 側（`getAutoYesState(id, 'claude')` ＝ 後方互換トップレベルフィールド）の両方を直す**（DR3-010）
- [ ] **conflict の扱いを読み取り / 変更で分ける**: 400 は `send` / `respond` / `interrupt` / `kill-session` / `terminal` / `special-keys` / `auto-yes` POST のみ。`current-output` / `capture` / `auto-yes` GET は 200 ＋ `resolvedBy:'roster'` ＋ `conflict`（DR3-015）
- [ ] 解決エンドポイント（例 `GET /api/worktrees/:id/resolve-target`）を追加し、CLI 側 `resolveInstanceCliTool` と `capture.ts` の `resolvePaneCliTool` を**薄いクライアント**に縮退（等価性契約テスト案は不採用、DR2-008）
- [ ] **版スキュー対応（DR3-004 / DR4-007 / DR4-008）**: `GET /api/capabilities`（`{ serverVersion, capabilities: string[] }`・ネットワークに出ない・**実行時の環境を反映しない固定トークンのみ**・`AUTH_EXCLUDED_PATHS` に**入れない**・`Cache-Control: no-store`）を新設し、CLI はプロセス内 1 回だけプローブしてキャッシュする。プローブは **`Accept: application/json` ＋ `redirect: 'manual'`** で発行し、**本物の 404（本文が空 or JSON）だけ**を「旧サーバ」と解釈してローカル解決へフォールバックする。**401 / 403 と 3xx / HTML ではフォールバックせず即終了**（§4 D5 決定 1 の判定表）。`resolvedBy: 'client-fallback'` を運用者層に出し（`resolvedBy` の union を server / CLI 双方に追加）、**stderr に 1 行の警告**も出す。フォールバック経路は**機能追加しない**（CLI 側に primary anchor 段を実装しない）ことを受入条件に書く
- [ ] **セキュリティ受入条件（§13.2）を Phase ごとに取り込む**: Phase 1 は S1 / S2 / S6 / S11 / S12 / S15 / S20 と S14(e)。**§10 の決定で §13.2 に行が無いものを作らない**（DR4-006）
- [ ] `kill-session` route のインライン解決を撤去し、**roster 優先への挙動変更と 400 `instance_tool_conflict`** を CHANGELOG に記載（DR2-009）
- [ ] `instance_tool_conflict` の理由コードと stdout JSON（400 / exit 2）を定義
- [ ] auto-yes の既定ツール変更を CHANGELOG に記載（Phase 1 は「挙動変化あり」。**`kill-session` の解決変更・読み取り経路の conflict 扱いと合わせて 3 件**）。**auto-yes state は in-memory Map で DB 永続化が無いためデータ移行は不要**である旨も書き、実装 PR がマイグレーションを探す無駄を消す（DR3-010）
- [ ] `structuredEvents` に turn フィールド（`turnId` / `openedAt` / `closedAt` / `closedBy`）を additive 追加し、`wait.ts` の `adoptTurnStart` の採用元を `lastEventType` からこれらへ移行する計画を Issue 化（`lastEventType` / `lastEventAt` は残す。移行完了まで #1839 のゲートを外さない、DR2-007）
- [ ] `VERIFIED_AGAINST` の雛形と `DETECTOR_VERSION_PROBES`（**プロセス内 1 回キャッシュ・in-flight 共有**。**ホットパスでは await せず、温まるまで `detector.staleness` は `undefined`**、DR3-013）
- [ ] `wait --help` に unclassified dwell（60 秒・exit 10）と `--stall-timeout` の相互参照を追加
- [ ] `docs/module-reference.md` / `docs/architecture.md` に新しい層を 1 行ずつ追記
- [ ] Phase 3 / 4 の Issue を分割して起票（Phase 3 は **S 群マージ後**着手、**#1893 → #1911 は直列**と明記）
- [ ] **Epic #1891 の順序制約を子 Issue の本文 / 起票時に転記**する: **#1885 → #1895**、**#1883 → #1896**、**#1898 ⇄ #1899（`ingest.ts` 共有）**、**#1901 ⇄ #1903（`agent-event-state.ts` 共有）** を直列化し、**#1901 / #1903 は Phase 1 の capability 型着地後に着手**（DR3-011）

### 13.1 Phase 3 / 4 の着手前提（Stage 2 / Stage 3 由来）

- [ ] **ツールごとの「肯定確認された idle 証拠」規則と fixture（肯定＋変異）が揃ってから**、そのツールの `input_prompt` 経路の evidence を `'none'` に倒す（全ツール一斉に倒さない。完了マーカーは opencode の 1 件しか実在しない、DR2-002）。**規則はそのツールの実フレームから起こす**（copilot は composer ではなくペイン最下行のステータスバー、#1979 / §4 D1 決定 1）
- [ ] **`STATUS_REASON.UNKNOWN_FRAME = 'unknown_frame'` を追加する**（Phase 2 の scope 外で未着地。`grep -rn 'UNKNOWN_FRAME' src/` は 0 件・develop `a175767a` 実測。#1927 の作業、§6.1 / §8）
- [ ] **copilot の version probe を `resolveCopilotExecutable()` へ委譲する**（`gh copilot -- --version` は未インストール環境でダウンロードを起こすため使わない。#1929 の作業、§4 D2 / §13.2 S17）
- [ ] **`mergeStructuredStatus` の上書き分岐を「scraper が `evidence:'positive'` のときだけ `isUnclassifiedActive` を下ろす」に改訂**してから `no_recent_output` を `running` に倒す（順序を逆にすると #1708 のガードが無音で外れる、DR2-003）
- [ ] `dialogPendingMaxMs`（保持期限）と `decisionTimeoutSeconds`（送達期限）を**別の値として実装**する。`deliveryExpired` は `waiting` を解除しない（DR2-004）
- [ ] `#1898-3` の実装先は **`prompt-response/route.ts`**（CLI `respond` の実経路、DR2-010）。**Web UI 側の `respond/route.ts` は別項として Phase 4 で対応する**（DR3-007。「実経路の取り違え」と「Web UI 経路の非目標化」を混同しない）
- [ ] opencode の再接続は **`resyncPending` を新規に書き起こさない**（既存）。追加するのは activity 再取得（`GET /session/status`）と turn 再武装（DR2-011）
- [ ] `ICLITool` に `describeComposer()` / `gracefulExitSequence()` / `captureSpec()` を追加（`capture` メソッドは追加しない。capture の公認ゲートウェイは `captureSessionOutput`、DR2-012）
- [ ] **`input_prompt` × `evidence:'none'` の wire 値は `ready` のまま**とする（`running` に倒さない）。`isUnclassifiedActive` が `wait` の 60 秒 dwell → exit 10 を駆動する（DR3-002。`running` に倒すと `isProcessing` 経由で `ls` / sidebar / `MessageInput` トースト / demo-video の `wait_until_busy` プローブが一斉に変わる）
- [ ] **`TurnRecord` を `beginAgentEventGeneration` の generation フェンス配下に置く**（open turn は `closedBy:'generation'` で閉じ、`generationAt < generationStartedAt` の turn は導出に使わない）。`turn-model.test.ts` に「セッション再作成をまたいだ turn の非継承」を入れる（DR3-003）
- [ ] **D3 の受入指標を capability 表の完全一致 pin ＋ 変異ケースに差し替える**（grep 0 件は着手前から真＝空虚な緑。残すなら「進捗指標ではない」と明記する、DR3-006）
- [ ] **Web UI の構造化 decision 応答**（`respond/route.ts` の `decisionId` 対応と `PromptPanelProps` の `decisionId`）を Phase 4 の範囲として起票する。着地までは §7 の 3 行を「表示のみ」と明記（DR3-007）
- [ ] **`getStatusCaptureLines`（`worktree-status-helper.ts`）を `captureSpec()` に寄せる**（ツール別 capture 行数の第 2 の生産者。#1910 の alt-screen 対応と食い違わせない、DR3-014）
- [ ] **ツール単位のキルスイッチ**（env / settings で当該ツールの evidence 判定を旧挙動へ戻す）と、**ロールアウト判断の観測条件**（`unclassified_frames` の記録件数が倒す前後で有意に増えない）を用意する（DR3-016）
- [ ] **リポジトリ内 skill の fixture を再採取する**（`tests/unit/skills/orchestrate-monitor/fixtures/**` の 17 件。うち 4 件が `no_recent_output`・14 件が `isUnclassifiedActive`）。`fixture-fidelity.test.ts` が「製品が出さない payload」を禁じているため、Phase 3 の受入条件に含める（DR3-012）

### 13.2 セキュリティ受入条件（Stage 4 / DR4-006）

**§10 の決定はすべてこの表を経由して実装へ降りる。** 初版は §11 のテスト戦略 9 行にも §13 / §13.1 の 40 項目にもセキュリティ由来の受入条件が **0 件**で、レビューを通しても実装段階で §10 が落ちる形になっていた。各行は「何をテストで固定するか」を具体的に書き、**変異注入（規則を外すと赤になる）で非空虚性を確認する**。

| # | 受入条件（機械可読なガードに落とすこと） | 対象 | Phase | 由来 |
|---|---|---|---|---|
| S1 | **id 検証**: 長さ 256 超過 / 不正文字（`^[A-Za-z0-9._:-]+$` 外）の id を含む `permission.asked` fixture が **decision を作らない**ことを pin。**「切り詰めた id で decision が作られる」実装が赤になる**変異ケースを併設する（切り詰めは別リクエストへの誤爆を生む） | `event-mapper.readBoundedId` / `turn-model.test.ts` | 1（型・定数）／ 4（turn 側） | DR4-001 |
| S2 | **定数の共有**: pull 側 id の上限が push 経路（`/api/hooks/agent-event`）の `MAX_SESSION_ID_LENGTH` と**同じ定数を参照**していることを pin（値の二重定義があれば赤） | 共通バリデータ | 1 | DR4-014 |
| S3 | **破棄の露出**: 検証で落ちた decision の件数が `capture --json` に出る（無言で消えない） | `structuredEvents` | 4 | DR4-001 / DR1-021 |
| S4 | **`redirect:'manual'`**: opencode `client.ts` の `requestJson` / `readOpencodeEventStream` が **3xx を失敗として扱う**ことを pin（302 を返す stub に対してリダイレクト先へ fetch しない）。`content-type` 不一致も失敗 | opencode `client` | 4（先行実装可） | DR4-004 |
| S5 | **health-before-trust**: **再接続ループが `/global/health` を通し、`version` 不一致ならストリームを開かない**ことを pin。併せて **`resync` 由来の `stop` / idle 合成が health 未通過では起きない**ことを pin（health を外すと赤になる変異ケース） | opencode `subscription` | 4 | DR4-004 |
| S6 | **decision スコープ**: **別 instance / 別 worktree の `decisionId` を送ると 404 `decision_not_found`** になり、`deliverVerdict` が呼ばれないことを pin。横断検索実装は赤 | `prompt-response/route.ts` | 1〜2 | DR4-003 |
| S6b | **所属照合**: Phase 4 で `respond/route.ts` の `messageId` 経路に `message.worktreeId === :id` の照合が入ることを pin | `respond/route.ts` | 4 | DR4-003 |
| S7 | **shell スニペットの port 検証**: 生成される hook コマンドに `case "$CM_HOOK_PORT" in ''\|*[!0-9]*) exit 0;; esac` 相当の数値検証が**含まれる**こと、および **scheme / host / relay 絶対パスが env 由来でない**ことを生成物の文字列比較で pin。**`${…:-` の既定値つき綴りが現れたら赤** | `hook-settings.ts` の生成テスト | 2（#1904） | DR4-002 |
| S8 | **env の一覧**: `CM_HOOK_*` が launch line に必ず含まれること、および**子プロセス環境から除去される対象の一覧**（`sanitizeSessionEnvironment` / `SENSITIVE_ENV_KEYS` 相当）に入っていることを pin | launch / env sanitizer | 2 | DR4-002 |
| S9 | **key と literal の型分離**: `KeySequence` が `{kind:'literal'}` / `{kind:'key'}` の判別可能 union であり、**literal が必ず `send-keys -l` を経由する**ことを pin。本文が `Escape` / `C-c` / `Enter` のときに**キーとして着弾しない**ことを実 tmux（または transport スタブ）で確認 | `tmux.ts` / `*Tool` | 2 | DR4-011 |
| S10 | **graceful exit の後置条件**: `/exit` 後に **`hasSession` が false** かつ **割当 port の `/global/health` が無応答**になるまで port を forget しないこと、満たせない場合に `graceful_exit_timeout` / `port_orphaned` を出して force kill することを pin | `OpenCodeTool.killSession` | 2 | DR4-012 / DR4-004 |
| S11 | **capabilities の開示範囲**: `GET /api/capabilities` が `AUTH_EXCLUDED_PATHS` に**入らない**ことと、応答が **`serverVersion` ＋ 固定トークン配列だけ**（キーの完全一致・`Cache-Control: no-store`）であることを pin。キーが増えたら赤 | `tests/unit/api/capabilities.test.ts` | 1 | DR4-008 |
| S12 | **プローブの判定表**: 401/403 と 3xx/HTML で **`client-fallback` に落ちない**ことを pin（認証未通過を「旧サーバ」と誤読しない）。`client-fallback` 時に **stderr へ警告 1 行**が出ることも pin | CLI resolve fallback テスト | 1 | DR4-007 |
| S13 | **loopback 固定**: opencode の宛先が `127.0.0.1` 固定で、CommandMate が `--hostname` / `--mdns` を渡さないことを pin | opencode 起動・client | 2 | DR4-004（Stage 4 実測の維持） |
| S14 | **DoS 上限**: (a) SSE 1 フレーム上限超過でバッファを捨てて再接続、(b) replay の採用件数上限と超過件数の露出、(c) **`PendingDecision` が受信 payload を保持しない**、(d) dedup 集合の instance ごと上限、(e) `isValidWorktreeId` の長さ上限、をそれぞれ pin | client / payloads / path-validator | 4（(e) は 1） | DR4-009 |
| S15 | **動的 import の陽性対照**: `await import('…/tmux/…')` と `require('…/tmux/…')` の fixture が**それぞれ赤になる**ことを確認してから allowlist を入れる。**allowlist 済みモジュールが tmux シンボルを再エクスポートしないこと**も pin（`src/lib/session/index.ts` の `export *` が実例） | `tmux-import-allowlist.test.ts` | 1 | DR4-005 |
| S16 | **設定書き込みの原子性**: `~/.copilot/settings.json` の書き込みが **temp + rename** であり、ロックを取れないときは**書かずに hooks なしで起動**することを pin。既存ファイルが壊れているときに**上書きしない**既存挙動も維持 | `hook-settings.ts` | 2 | DR4-013 |
| S17 | **probe の実行体**: version probe が**絶対パス解決**を経ること、**copilot は `resolveCopilotExecutable()` へ委譲**し **`gh copilot` を子プロセスとして起動しない**こと（`gh copilot -- --version` を綴った実装が赤になる変異ケースを併設）、`copilot` も gh 管理コピーも無い環境で **子プロセスを 1 つも起動せず** probe をスキップして `detector.staleness` が `undefined` のままになることを pin | `DETECTOR_VERSION_PROBES` / `copilot-executable.ts` | 3 | DR4-010（#1979 で訂正） |
| S18 | **秘密を pane に出さない**: `AgentLaunchPlan.env` に `CM_AUTH_TOKEN` などの秘密が入らないことを pin（launch line は scrollback / `capture --json` に載る） | `launch-command.ts` | 2 | DR4-017 |
| S19 | **XSS の非回帰**: `PromptPanel` / `ActivityPane` が新設フィールドを**テキストノードとしてのみ**描画し、`dangerouslySetInnerHTML` / `title` を使わないことを pin | 該当コンポーネントのテスト | 3〜4 | DR4-016 |
| S20 | **レート制限の方針**: `resolve-target` に `createRequestRateLimiter` が適用されていること、`capabilities` に適用しない理由がコードコメント / 本書に残っていることを確認 | 新設 route | 1 | DR4-015 |

---

## 14. レビュー履歴

| 日付 | Stage | 種別 | 指摘数（Must / Should / Consider） | 反映 |
|---|---|---|---|---|
| 2026-08-21 | — | 初版 | — | — |
| 2026-08-21 | Stage 1 | 通常レビュー（設計原則） | 8 / 8 / 6 | 全件反映（§14.1）。判定は conditionally_approved（3/5）→ Stage 2 へ |
| 2026-08-21 | Stage 2 | 整合性レビュー（develop `90b67eb9` との逐語照合） | 7 / 10 / 7 | 全件反映（§14.2）。判定は conditionally_approved（3/5）→ Stage 3 へ。逐語一致が確認された 24 項目（関数名・定数値・precedence・Web UI 受け皿・Stage 1 反映）はそのまま維持 |
| 2026-08-21 | Stage 3 | 影響分析レビュー（develop `90b67eb9` の消費者・importer・テストの実測） | 7 / 9 / 7 | 全件反映（§14.3）。判定は conditionally_approved（3/5）→ Stage 4 へ。**逐語確認された 13 項目と否定的実測（`MessageList` は本設計の消費者ではない）は §15.4 に記録**し、Stage 4 では再確認しない |
| 2026-08-21 | Stage 4 | セキュリティレビュー（OWASP Top 10 / develop `90b67eb9` の実測） | **6 / 8 / 4** | 全件反映（§14.4）。判定は conditionally_approved（3/5）。**§10 を全面改訂**し（初版の 3 記述を撤回）、**§13.2「セキュリティ受入条件」20 行**を新設して §10 の決定を実装へ降ろした。Consider 4 件の採否は §15.6、**実測で問題なしと確認された 8 項目は §15.7**（以後再確認しない） |

### 14.1 レビュー指摘事項サマリー（Stage 1）

レビュー報告書: `dev-reports/review/2026-08-21-issue1915-stage1-architecture-review.md`

| ID | 重要度 | 指摘の要旨 | 反映先 |
|---|---|---|---|
| DR1-001 | Must | `unknown` が #1708 の `isUnclassifiedActive` / dwell 60 秒 / exit 10 と二重化 | §4 D1 決定 2（統合案を採用、新 exit code / 新フラグを作らない）、§6.1、§7、§8 Phase 3 |
| DR1-002 | Must | 「否定の不在 → ready」の主経路 `no_recent_output` が漏れ、`default` の記述も実装と逆。#1708 ガードが失効する | §3 P1（実測の優先順位表）、§4 D1 決定 3、§6.1（3 経路の移行後マッピング表） |
| DR1-003 | Must | `sessionStatus` の値域拡大は additive ではない（逆向き版スキュー・外部 skill） | §4 D1 決定 2（値域不変）、§4 D1 の却下表、§8 Phase 3、§9 CLI 契約行、§13 |
| DR1-004 | Must | open turn に終端規則が無く、`stop` を 1 回落とすと永久 `running` | §4 D3 決定 2（`turnStaleAfterMs` / `scraper_evidence` / decision の期限）、§5.2 補足、§7、§9。**Stage 2 で decision の期限を送達期限と保持期限に分割し、理由コードを `dialog_timeout` に改名**（DR2-004） |
| DR1-005 | Must | `eventIdentity` が関数だと capability の露出・pin と両立しない | §4 D3 決定 1（文字列 union の宣言値へ変更）、§3 P2、§6.2、§7 |
| DR1-006 | Must | Auto-Yes poller は `sessionStatus` を読まない（`detectPrompt` 直呼び） | §1、§4 D1 決定 4（`detectDialog` 共有 ＋ `lastSuppression.reason='unclassified-frame'`）、§6.1、§9 |
| DR1-007 | Must | `resolvePromptWaiting`（#1737）と send guard を無視／証拠なしの send 意味論が未定義 | §2 用語、§4 D1 決定 5、§5.1 図、§5.2 前提、§6.1 対象ファイル |
| DR1-008 | Must | 解決関数は 2 実装。precedence が #1629 と逆 | §3 P4、§4 D5 決定 1・2（roster 優先、server 権威）、§6.4。**Stage 2 で実装は 4 つと判明し、CLI は server 委譲に確定（等価性契約テスト案は却下）**（DR2-008 / DR2-009） |
| DR1-009 | Should | Phase 1「既存挙動不変」が §9 / §13 と矛盾。`'claude'` を 0 に pin できない | §4 D5 決定 4（baseline pin）、§8 Phase 1 互換性欄、§9、§13 |
| DR1-010 | Should | ESLint ガードの severity・allowlist 粒度・間接迂回が未定義 | §4 D4（`error` / パス列挙 pin / 迂回の限界 / 動的 import）、§6.3、§11、§13 |
| DR1-011 | Should | `unknown` タイムアウトの exit code 仕様が未定義 | §4 D1 決定 2（既存 exit 10 を維持し新 code / 新フラグを作らないため消滅）、§6.1（`--help` 相互参照） |
| DR1-012 | Should | capability が #1898-2 / #1898-3 / #1899 の `stop` dedup を覆わない | §4 D3 決定 2（ライフサイクル系は dedup 対象外）・決定 3（再裁定契機・`respond` の decisionId）、§6.2、§7（dedup カウンタ） |
| DR1-013 | Should | 6 ソース × 5 capability の宣言値表が無い | §4 D3 決定 1 の表、§13 |
| DR1-014 | Should | `lastKnownStatus` の保持主体・TTL が未定義／Web UI 露出が 1 行のみ | §7（server 保持・TTL・全行に Web UI 受け皿・`ls` 追加）、§6.1 |
| DR1-015 | Should | Phase 2 の群→原則マッピングが Epic と不整合。群記号が未定義。Phase 3 と S 群の順序が未定義 | §2 用語（S/H/L/C 定義）、§8 Phase 2 の Issue 番号表・順序制約、§4 D2 |
| DR1-016 | Should | 用語の不整合（ツール数、`idle` / 未開始、`NOT_STARTED` の再利用） | §1（ツール 7・ソース 6、4 値）、§2 用語、§4 D1 決定 1・6 |
| DR1-017〜022 | Consider | §15 参照 | §15（各項の採否と理由） |

### 14.2 レビュー指摘事項サマリー（Stage 2 / 整合性）

レビュー報告書: `dev-reports/review/2026-08-21-issue1915-stage2-architecture-review.md`（基準: develop `90b67eb9`）

| ID | 重要度 | 指摘の要旨 | 反映先 |
|---|---|---|---|
| DR2-001 | Must | `isUnclassifiedActive` の「真偽が変わらない」という決定が §6.1 行(2) と自己矛盾（設計どおり実装すると互換テストが必ず落ちる） | §2 用語、§4 D1 決定 2（経路ごとに書き分け・等価性の撤回）、§6.1 表と bullet、§9 検出層行、§11（互換 A / 互換 B の 2 本）、§13 |
| DR2-002 | Must | 「claude は `⏺` + composer が完了マーカー」は実装に存在しない（`⏺` は spinner ＝ running 側）。完了マーカーは 7 ツール中 opencode の 1 件のみ | §3 P1（実測）、§4 D1 決定 1（`ready` の 4 条件へ再定義・前提条件・ツール単位ロールアウト）、§6.1 表、§8 Phase 3 / 順序制約、§13.1 |
| DR2-003 | Must | `mergeStructuredStatus` の上書き分岐により、`no_recent_output` を `running` に倒すと #1708 ガードが無音で解除される | §3 P1、§4 D1 決定 2（merged で pin）、§5.2（決定 1 行＋pin 位置）、§6.1、§9 統合判定行、§11、§13 / §13.1 |
| DR2-004 | Must | `decisionTimeoutSeconds`（hook 応答の予算）を pendingDecisions の release 期限に流用すると waiting が 0〜10 秒で解除される | §4 D3 決定 1 表（送達期限と明記）、§4 D3 決定 2（送達期限 / 保持期限 `dialogPendingMaxMs` の 2 本）、§6.2、§7（2 行に分割・`dialog_timeout` へ改名）、§9、§13.1 |
| DR2-005 | Must | ESLint `no-restricted-syntax` は 1 ルール 1 severity・`overrides` は置換。i18n(warn) と no-claude-fallback(error) は共存できない | §4 D4（別ルール名なので影響を受けないことを明記）、§4 D5 決定 4（i18n を `error` へ格上げ＋claude ガードは vitest）、§6.3、§6.4、§11 ガード行、§13 |
| DR2-006 | Must | `'claude'` baseline の測定範囲が lint 対象より狭い（`src` 全体で 231 箇所 / 85 ファイル） | §4 D5 決定 4（`files` スコープの明示・スコープ内実測を Phase 1 に）、§12 非目標、§13 |
| DR2-007 | Must | `displayEvent` の「状態導出禁止」が出荷済みの `wait.ts` turn ゲート（#1839）と衝突。`turnStartedAt` の所在も誤り | §4 D3 決定 2（`displayEvent` コメント）、§4 D3 互換性（`turnId` / `openedAt` / `closedBy` への移行と経過措置）、§7（turn 露出行）、§13、§15.2（DR1-019 の条件づけ） |
| DR2-008 | Should | CLI 側 `resolveInstanceCliTool` には primary anchor 段が無く、server と実際に解決結果が食い違う（等価性テストは初日から赤） | §3 P4（4 実装の内訳・CLI 利用者を 4 コマンドに訂正）、§4 D5 決定 1（server 委譲を決定・ローカル残置案を却下）、§6.4、§9 解決行、§13、§15.1 |
| DR2-009 | Should | `kill-session` route に第 3 の解決実装（明示優先・conflict 未検出）がインラインで存在する | §3 P4、§4 D5 決定 3（挙動変更を明記）、§6.4、§8 Phase 1 互換性、§9 解決行、§13 |
| DR2-010 | Should | #1898-3 の対象 route が誤り（CLI `respond` は `prompt-response` を叩く） | §4 D3 決定 3、§6.2、§12 非目標、§13.1。**Stage 3 で §12 の `respond/route.ts` 除外は解除**（表示だけできて応答できない Web UI になるため、DR3-007） |
| DR2-011 | Should | opencode の「縮退ポーリング未実装」は不正確。`resyncPending` は実装済みで、未実装なのは activity 再取得 | §3 P2 表、§6.2、§13.1 |
| DR2-012 | Should | D4 の 5 メソッドのうち `capture` は `ICLITool` に存在しない | §4 D4（`capture` を列挙から除外・`captureSessionOutput` を第 2 ゲートウェイに決定・`ICLITool` への追加項目）、§5.1 図、§6.3、§13.1 |
| DR2-013 | Should | `lib/tmux` を import する 11 ファイルの内訳が無く、「削除のみ許可」が達成不能な項目を含む | §4 D4（恒久除外 / 段階解消の 2 区分表）、§6.3（禁止パターンの一本化）、§11 ガード行、§13 |
| DR2-014 | Should | `permissionHookPredictsDialog` の根拠が不整合（gemini の理由が codex にも当てはまる） | §4 D3 決定 1（判定軸を permission hook の登録有無と予告性に統一・表の根拠欄を全面改訂） |
| DR2-015 | Should | Phase 2 の対応表に OPEN の #1883 / #1885 / #1886 が無い（#1883 は D1 決定 5 の中心） | §1（範囲＝子 Issue ＋ 既報 4 件）、§6.1、§8 Phase 2 表（4 行追加）、§8 順序制約 |
| DR2-016 | Should | #1894 の interrupt override と #1911 の完了マーカー共有が Phase 2 表で所有者不在 | §6.3（#1894 を担当と明記）、§8 Phase 2 表（#1894 に D4、#1911 を D1 へ）、§8 順序制約（#1893 → #1911 の直列） |
| DR2-017 | Should | §15.1 の未決「opencode / copilot の probe コマンド」が #1913 と重複 | §4 D2 probe 表（出所を #1913 に）、§8 Phase 2 表（#1913 に前提提供を付記）、§15.1 |
| DR2-018 | Consider | 分岐番号 (2)(3)(4) が `status-detector.ts` docstring の 3./4./5. とずれる | §3 P1（docstring 番号列を追加・reason 名で参照する方針）、§6.1 表 |
| DR2-019 | Consider | `UnclassifiedFrameRecord` の所在が誤り。60 秒 dwell は 2 か所にある | §2 用語 |
| DR2-020 | Consider | `dedupDropped` を `promptDedup` と「同型」としているがフィールド名が違う | §7（`{ skippedCount, lastSkippedAt, by }` に統一） |
| DR2-021 | Consider | id 長さ上限 256 と関数名 `isCliToolId` が既存と揃わない | §10（`MAX_EVENT_ID_LENGTH` = 128・`isCliToolType`） |
| DR2-022 | Consider | `capabilities` を毎ポーリング payload に載せるコスト | §7（ホットパスでは `source` 名のみ・詳細取得時に `capabilities`） |
| DR2-023 | Consider | antigravity の probe は `agy --version`。`commandmate doctor` は存在しない | §4 D2（probe 表・`commandmate status` に一本化） |
| DR2-024 | Consider | 影響テスト列に `src` 配下のテストが入っていない | §6.1、§9 検出層行 |

### 14.3 レビュー指摘事項サマリー（Stage 3 / 影響範囲）

レビュー報告書: `dev-reports/review/2026-08-21-issue1915-stage3-architecture-review.md`（基準: develop `90b67eb9`）

| ID | 重要度 | 指摘の要旨 | 反映先 |
|---|---|---|---|
| DR3-001 | Must | `lib/tmux` の importer は実測 **31 ファイル**で 14 件が未計上。severity `error` を先行投入すると develop（現状 lint exit 0）が赤になり子 Issue 22 本の CI が止まる。型のみ import 2 件はコアルールでは許可できない | §4 D4（3 綴りのパターン・陽性対照・型のみ import の決定・6 カテゴリ表・恒久除外 12 / 段階解消 19）、§6.3、§8 Phase 1、§9 ツール抽象行 / lint 行、§11 ガード行、§13、**§16 付録 A（ソート済み 31 件）** |
| DR3-002 | Must | `input_prompt` × `evidence:'none'` の wire 値が未定義。`running` に倒すと `isProcessing` 経由で `ls` / sidebar / `MessageInput` トースト / demo-video プローブが一斉に変わる | §5.2 の 5 段目（経路別 wire 値の表と理由）、§6.1 行(2)、§9 統合判定（表示）行、§13.1 |
| DR3-003 | Must | `TurnRecord` が #1723 の generation フェンスを踏まえておらず、セッション再作成で open turn を引き継いで最大 30 分 `running` に固着する | §4 D3 決定 2（フェンス配下・`closedBy:'generation'` ・`generationAt`）、§6.2、§7（closedBy 行）、§9 構造化層行、§11 構造化行、§13.1 |
| DR3-004 | Must | 「CLI は解決エンドポイントに委譲」に版スキュー設計が無い（CLI は常にサーバより新しい。`code` 無し 404 は `UNEXPECTED_ERROR` にマップされ区別できない） | §4 D5 決定 1（版スキュー節: 能力プローブ `GET /api/capabilities` → 404 で `client-fallback`）、§6.4、§7（`resolvedBy` 行）、§8 Phase 1、§9 CLI 契約行 / 解決行、§13 |
| DR3-005 | Must | §7 の 4 行の受け皿（ヘッダチップ / `BranchStatusIndicator` / `ls`）は `current-output` ではなく `GET /api/worktrees` の `CliToolSessionStatus` で駆動されており、追加先の契約が足りない | §7（受け皿の経由 API を明記・列見出し変更）、§6.1（第 2 の契約変更・`ls` の理由列）、§8 Phase 3、§13 |
| DR3-006 | Must | D3 の受入 grep は状態機械では着手前から 0 件＝空虚な緑。実際のツール名分岐は別の 3 ファイル 6 箇所にある | §4 D3 決定 1（受入指標の差し替え・6 箇所の実測表）、§11 構造化行、§13.1 |
| DR3-007 | Must | §7 が `PromptPanel` を構造化 decision の受け皿にしているのに、§12 が Web UI の応答経路を非目標にしているため「表示できるが応答できない」 | §6.2（Phase 4 で `respond/route.ts` ＋ `PromptPanelProps` に `decisionId`）、§7（3 行に「Phase 4 までは表示のみ」）、§8 Phase 4、§12（除外の解除）、§13.1 |
| DR3-008 | Should | `AutoYesSuppressionReason` の第 3 の更新先（`wait.ts` の `SUPPRESSION_CAUSE`）が挙がっていない | §6.1、§9 CLI 契約行 / Auto-Yes 行、§11 CLI 契約行、§13 |
| DR3-009 | Should | `no-claude-fallback` の baseline は実測 36 箇所 / 19 ファイルで、相当数は解決フォールバックではない。「削除のみ許可」が正しいコードの削除を誘発する | §4 D5 決定 4（実測表・スコープ外の追加・表示既定の除外・5 綴り目）、§9 lint 行、§11 ガード行、§13 |
| DR3-010 | Should | #1909 の既定変更が POST 側だけだと GET 側の後方互換フィールドが `'claude'` 固定のまま残る | §6.4、§8 Phase 1（挙動変化 3 件）、§9 Auto-Yes 行、§13（データ移行不要の明記つき） |
| DR3-011 | Should | §8 の順序制約が Epic #1891 の先行必須 2 件と H 群の同一ファイル直列を落としている | §8 順序制約（Epic の 4 制約を転記＋capability 型の先行条件）、§9 構造化層行、§13 |
| DR3-012 | Should | commandmate-skills の消費者はリポジトリ内にもある（`tests/unit/skills/orchestrate-monitor` の 17 fixture / 14 テスト） | §7（`statusEvidence` 昇格の未決行）、§8 Phase 3、§9（skills 行を新設）、§11（skills 行）、§13.1 |
| DR3-013 | Should | live probe を `capture --json`（5 秒ポーリング）で await すると再起動直後の初回が最大 7 プロセス spawn を待つ | §4 D2（ホットパスで await しない規約）、§7（detector 行）、§13 |
| DR3-014 | Should | `captureSpec()` を入れてもツール別 capture 行数の第 2 の生産者（`getStatusCaptureLines`）が残る | §6.3、§4 D3 決定 1 の 6 箇所表、§12（health check は非目標）、§13.1 |
| DR3-015 | Should | 読み取り経路にも 400 `instance_tool_conflict` を適用すると監視スキルが無音の無限ループになる | §4 D5 決定 3（読み取り / 変更の表）、§6.4、§7（conflict 行を 2 分割）、§8 Phase 1、§9 解決行、§13 |
| DR3-016 | Should | D1 のツール単位ロールアウトに実行時の後退手段と観測条件が無い | §8 順序制約（キルスイッチ・観測条件）、§8 Phase 3、§11 実機行、§13.1 |
| DR3-017〜023 | Consider | §15.3 参照 | §15.3（各項の採否と理由） |

### 14.4 レビュー指摘事項サマリー（Stage 4 / セキュリティ・OWASP）

レビュー報告書: `dev-reports/review/2026-08-21-issue1915-stage4-architecture-review.md`（基準: develop `90b67eb9`）。判定 conditionally_approved（3/5）。**§10 の書き換えを Phase 1 着手前の条件とする**。

| ID | 重要度 | OWASP | 指摘の要旨 | 反映先 |
|---|---|---|---|---|
| DR4-001 | **Must** | A03（Log Injection）／ A09 | §10 の「id はログ・ファイル名・シェルに渡さない」は実装と矛盾（`source.ts` のログ・`permission-decision-service.ts` の DB summary・reply URL に既に出ている）。かつ **pull 経路の id には長さ・文字種の検証が 1 つも無い**（push は `MAX_SESSION_ID_LENGTH`=256） | **§10.1 の表**（上限・文字種）、**§10.2**（検証 → 破棄 → ログ方針。初版記述を撤回）、§4 D3 決定 2 の `TurnRecord` コメント、§6.2（`readBoundedId`）、§13.2 S1〜S3 |
| DR4-002 | **Must** | A01（SSRF / credential redirection）／ A02 ／ A08 | #1904 の「port 非依存 URL / relay パスを env で運ぶ」は**トークンの宛先と実行プログラムを実行時 env へ委譲する特権移譲**であり、「安全性を下げない」という評価は成り立たない。`curlArgumentPreamble` は宛先と無関係に Bearer を付ける。`"${CM_HOOK_URL:-…}"` は未設定時に既定へ落ちる | **§10.8**（port のみ・数値検証・relay は env で運ばない・既定値なし）、**§10.7**（Bearer の宛先・`CM_HOOK_*` の一覧と除去）、§13.2 S7 / S8 |
| DR4-003 | **Must** | A01（Broken Access Control / IDOR） | `decisionId` の**解決スコープが未定義**。横断検索を選ぶと別 instance / 別 worktree の permission を承認し、別 port へ reply する。既存 `respond/route.ts` に**所属未照合の前例**がある | **§10.3**、§4 D3 決定 3（新規 bullet）、§5.3（フロー）、§6.2、§13.2 S6 / S6b |
| DR4-004 | **Must** | A08 ／ A10（SSRF） | opencode ポートの**信頼境界が未定義**。再接続ループに health check が無く、rogue な loopback リスナが `stop` / `resync_idle` を注入して `wait` を偽完了させられる。`fetch` が `redirect: 'follow'` のため loopback 発 SSRF で IP 制限を迂回しうる。`isPortFree` は TOCTOU | **§10.4**（health+version・`redirect:'manual'`・TOCTOU と残留リスクの表）、§4 D3 決定 2（再接続 bullet）、§4 D4（kill 後置条件）、§6.2、§7（`port_identity_changed`）、§13.2 S4 / S5 / S13 |
| DR4-005 | **Must** | A05 | D4 の「動的 import / require も同じ制限の対象」は **ESLint 8.57.1 では成立しない**（隔離環境で無検出＝偽の安心）。`export * from` 再エクスポート経由の抜け穴も実在（`src/lib/session/index.ts`） | **§4 D4 の動的 import 節**（撤回と `no-restricted-syntax` セレクタ）、§4 D5 決定 4 (1)、§6.3、**§10.11**、§13.2 S15 |
| DR4-006 | **Must** | A04（Insecure Design） | §13 / §13.1 の 40 項目に**セキュリティ受入条件が 0 件**で、§10 の決定が実装へ降りない | **§13.2（新設・20 行）**、§11 に「セキュリティ」行を追加、§10 冒頭に「§13.2 に降りていない決定を作らない」 |
| DR4-007 | Should | A05 ／ A07 | capabilities の 404 判定は、**認証リダイレクト（`/login` へ 307 → 200 HTML）や中間装置の 404 を「旧サーバ」と誤読**して `client-fallback` へ静かに降格させる | **§4 D5 決定 1 の判定表**（4 分岐・`Accept` ＋ `redirect:'manual'`）、**§10.6**、§6.4、§7（`resolvedBy` 行 ＋ 新規行）、§13.2 S12 |
| DR4-008 | Should | A01 ／ A05 | capabilities の**開示範囲を固定する規約が §10 に無い**。認証既定 OFF ＋ `CM_BIND=0.0.0.0` は実在の構成で、インベントリと絶対パスが無認証で読まれうる | **§10.6**（固定トークンのみ・`AUTH_EXCLUDED_PATHS` 非追加・`no-store`・キー完全一致 pin）、§4 D2（`detector.staleness` を載せない）、§6.4、§13.2 S11 |
| DR4-009 | Should | A04（Resource exhaustion） | DoS 上限が turn / `pendingDecisions` だけで、**SSE 行バッファ無制限・replay 件数無制限・`raw` 全量保持・dedup churn・`isValidWorktreeId` の長さ無制限**を覆っていない | **§10.10（7 項目）**、§4 D3 決定 2（dedup 上限 / replay 上限 / `PendingDecision` コメント）、§6.2、§13.2 S14 |
| DR4-010 | Should | A08（untrusted search path） | probe の 3 → 7 拡張が**裸のコマンド名を PATH から実行する面**を広げる。~~copilot は起動実体（`gh copilot`）と probe 対象（`copilot`）が別物~~ → **#1907 が起動側を PATH の `copilot` 優先に移したため別物ではない。実際の欠陥は `gh copilot -- --version` が未インストール環境でダウンロードを起こすこと**（#1979 で訂正） | **§4 D2 の probe 表（解決方法の列）＋ 規約 5 点**（(5) 環境を変更しない、を #1979 で追加）、§10.1（PATH を外部入力に追加）、**§10.11**、§13.2 S17 |
| DR4-011 | Should | A03（Injection） | `sendKeys` は `-l` を付けておらず（リポジトリ全体で 0 件）、**本文が `Escape` / `C-c` / `Enter` と一致するとキーとして着弾**する。`KeySequence` が literal と key を型で分けないと必ずどちらかに倒れる | **§4 D4 の `KeySequence` 判別可能 union**、§6.3、**§10.12**、§13.2 S9 |
| DR4-012 | Should | A05 | graceful exit の**後置条件が未規定**で、無認証の opencode HTTP サーバが loopback に取り残されうる（release が先・完了判定は `hasSession` のみ） | **§4 D4 の後置条件**（`hasSession` false ＋ port 無応答、forget は最後）、§6.3、§7（`port_orphaned` / `graceful_exit_timeout`）、**§10.9 / §10.14**、§13.2 S10 |
| DR4-013 | Should | A04 ／ A05 | copilot `settings.json` への書き込みが**非原子・非排他の read-modify-write**。複数サーバ同時稼働は公式機能で、ユーザーのファイルを壊しうる | **§10.9（新設）**、§4 D3 決定 1 の注記（`global-singleton` は宣言値であって保証ではない）、§6.2、§13.2 S16 |
| DR4-014 | Should | A03 ／ A04 | §10 の「外部入力」が **push / pull の検証の非対称**を吸収していない（pull は `resolveSessionTarget` を通らない） | **§10.1（(a) API/CLI 入口 と (b) ソース入口 の 2 段 ＋ 上限表 ＋ 定数共有）**、§6.2、§13.2 S2 |
| DR4-015〜018 | Consider | — | §15.6 参照 | §15.6（各項の採否と理由） |

---

## 15. 検討事項・未決事項（running list）

本節は Consider 項目の採否と未決事項の**通し台帳**である。Stage が進むごとに行を追加し、決着したものは扱い欄を更新する。

**Stage 1 Consider 項目の採否**:

| ID | 内容 | 採否 | 本書での扱い |
|---|---|---|---|
| DR1-017 | `sessionStartMayArriveLate` は turn モデルに吸収できないか（YAGNI） | **capability を残す**（5 項目のまま） | §4 D3 決定 2 に残差挙動を 1 文で明記した（`false` のとき turn 開始後の `session_start` が `displayEvent` に入るだけで状態は変わらない）。`displayEvent` を廃止できた時点で 4 項目への削減を再検討する |
| DR1-018 | live probe のコスト・キャッシュ・対象ツール | **採用** | §4 D2 に「プロセス内 1 回・in-flight 共有」のキャッシュ規約（`getCatalogStaleness` / #1476 R3 と同型）と 7 ツール分の probe 表を追加。**opencode / copilot の probe は #1913 を出所とし**（Stage 2 / DR2-017）、gemini は Phase 3 で実測確定 |
| DR1-019 | `TurnRecord.lastEvent` の残置と `closedBy` の欠如 | **採用（Stage 2 で条件づけ）** | §4 D3 決定 2 で `lastEvent` → `displayEvent`（表示専用）に改名し、`closedBy`（`stop` / `session_end` / `stale` / `scraper_evidence` / `resync_idle`）を追加。`capture --json` と `wait` の完了出力（`COMPLETION_BASIS` の語彙に整合）に出す（§7）。**「状態導出禁止」は新規コードに対する規範**であり、出荷済みの `wait.ts` `adoptTurnStart`（#1839）は `turnId` / `openedAt` へ移行するまで例外扱いとする（DR2-007、§4 D3 互換性） |
| DR1-020 | 消費者契約テストと変異注入の受入条件 | **採用** | §11 に「消費者契約」行を追加（`wait` / send guard / Auto-Yes / sidebar / `ls` の表駆動）。変異ケース（処理中語彙を 1 語変える）を受入条件に昇格 |
| DR1-021 | DoS 上限による `pendingDecisions` 破棄が無言の自動アクション | **採用（2 段構え）** | §10 で「未裁定 decision を持つ turn は evict 対象外」＋「破棄時は `decision_evicted` を理由コードとして件数つきで `capture --json` に出す」を決定。§7 に露出行を追加 |
| DR1-022 | 最終フォールバック `'claude'` の是非と `resolvedBy:'fallback'` | **採用（警告扱い）** | §4 D5 決定 5 で `resolvedBy: 'fallback'` を「#1909 型のバグの兆候」として警告に格上げ。§7 で Web UI の警告色表示を規定。リテラル自体の撤去は §8 Phase 2 以降の目標（Phase 1 は baseline pin） |

### 15.1 未決事項（現時点）

| 未決事項 | 状態 | 扱い |
|---|---|---|
| opencode / copilot の detector probe コマンド | **決着（Phase 2 で着地・#1979 で訂正）** | **#1913 が `VERSION_PROBES` / `CATALOG_VERIFIED_AGAINST` へ着地済み**（develop `a175767a` で実測）。**opencode は `opencode --version`（`kind:'execFile'`）、copilot は `resolveCopilotExecutable()` への委譲（`kind:'delegated'`）**。`gh copilot -- --version` は未インストール環境でダウンロードを起こすため**採らない**（DR4-010 訂正、§4 D2） |
| gemini の detector probe コマンド | 未決 | #1913 の対象外。Phase 3 で実測（`gemini --version` 想定） |
| copilot の `eventIdentity` | 未決 | `tool-call-id` が使えるかは実測待ち。現状は `null` ＝ 時間窓 dedup。`types.ts` の `toolCallId` コメントが「codex / copilot / gemini / antigravity は mostly absent」と既に実測しているので、既定 `null` はこれを根拠にできる |
| 解決の権威と CLI 側の扱い | **決着（Stage 2）** | **CLI は server の解決エンドポイントに委譲し、レスポンスの `resolvedBy` を使う**。ローカル解決の残置＋等価性契約テスト案は却下（CLI に primary anchor 段が無く実際に食い違うため、DR2-008、§4 D5 決定 1） |
| 解決エンドポイントのパスとレスポンス shape | 未決 | `GET /api/worktrees/:id/resolve-target` は仮。Phase 1 の実装 PR で確定（返す項目は `cliToolId` / `instanceId` / `resolvedBy` / conflict 時 400） |
| `turnStaleAfterMs` の既定値 | 未決 | 現行 staleness bound（30 分）から変える必要があるかは実機 UAT の結果次第 |
| `dialogPendingMaxMs` の既定値 | 未決（Stage 2 で新設） | 予告のみは既存 `STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS`（20 秒）、実イベント由来は `turnStaleAfterMs` と同値を出発点とし、実機 UAT で「ダイアログが出ているのに waiting が外れる / 消えたのに waiting が残る」を確認して確定（DR2-004） |
| `no-claude-fallback` の baseline 実数 | **決着（Stage 3）** | **スコープ内は 36 箇所 / 19 ファイル**（api 20/13・cli 8/3・session 8/3）と実測済み。Phase 1 の作業は測定ではなく **1 行ごとの区分（解決フォールバック / 対象外）の確定**（DR3-009、§4 D5 決定 4） |
| 解決エンドポイントの版スキュー対策 | **決着（Stage 3）** | **`GET /api/capabilities` を新設し、その 404 を「旧サーバ」の検出に使う。フォールバック時は `resolvedBy:'client-fallback'` を出す**（DR3-004、§4 D5 決定 1） |
| `GET /api/capabilities` のレスポンス shape と capability トークンの語彙 | 未決（Stage 3 で新設） | `{ serverVersion, capabilities: string[] }` を出発点とし、トークン名（例 `resolve-target`・`structured-decisions`）は Phase 1 の実装 PR で確定する。**ネットワークに出ないこと**（GitHub 参照は `update-check` の役割）を要件とする |
| ツール単位キルスイッチの実装形（env か settings か） | 未決（Stage 3 で新設） | env は再起動が要る / settings は UI から戻せる。Phase 3 の実装 PR で確定（DR3-016） |
| `statusEvidence` を `classify-state.sh` の一次シグナルに昇格させるか | 未決（Stage 3 で新設） | 現状の skill は `sessionStatus == 'waiting'` 以外を IDLE に落としており、D1 が製品層で消す「否定の不在」がスキル側に残る。Phase 3 の skill 更新で判断（DR3-012、§7） |
| `worktree-status-helper` の Claude 限定 health check の扱い | 未決（Stage 3 で新設） | `getStatusCaptureLines` は `captureSpec()` へ寄せると決めたが、`isSessionHealthy` の Claude 分岐は capability でも `captureSpec` でも表せない。現時点では §12（非目標）に置く（DR3-014） |
| opencode の `OPENCODE_SERVER_PASSWORD` 対応（ポート identity の強化） | 未決（Stage 4 で新設） | §10.4 の緩和は health ＋ version 確認までで、**先に port を奪ったプロセスが `stop` / idle を偽造できる残留リスク**は消えない。opencode 側が起動時パスワードを受け付けるなら、CommandMate が生成した秘密を launch 時に渡して SSE / reply に付ける形で identity を強化できる。**採否は Consider（§15.6 DR4-004 派生）**。実装するなら §10.7 の「秘密を `plan.env` に載せない」規約と衝突しない渡し方（プロセス環境の継承）を先に決める |
| DoS 上限の既定値（SSE 1 フレーム / replay 件数） | 未決（Stage 4 で新設） | §10.10 の「256 KiB」「50 件」は出発点。実機（opencode の巨大 diff permission）で採って確定する（DR4-009） |
| `CM_HOOK_PORT` 検証に落ちたときの hook 応答の綴り | 未決（Stage 4 で新設） | 「発火せず `exit 0`」は決定だが、**ツールが期待する空応答の形（`printf '{}'` を返すか無出力か）はツールごとに違う**。実装 PR で hook プロトコルに合わせて確定する（DR4-002、§10.8） |
| `decision_not_found` の CLI 側 exit code | 未決（Stage 4 で新設） | server は 404 `decision_not_found`（§10.3）。CLI が既存のどの exit code に写すか（`UNEXPECTED_ERROR` に潰さない）は Phase 1〜2 の実装 PR で確定する。**「worktree が無い」と区別できない形にしない**（DR3-004 と同じ失敗を繰り返さない） |

### 15.2 Stage 2 Consider 項目の採否

| ID | 内容 | 採否 | 本書での扱い |
|---|---|---|---|
| DR2-018 | 分岐番号 (2)(3)(4) が `status-detector.ts` docstring の 3./4./5. とずれる | **採用（番号は残し reason 名を正とする）** | §3 P1 の表に docstring 番号列を足し、「突き合わせは reason 名（`input_prompt` / `no_recent_output` / `default`）で行う」と明記。§6.1 の表にも reason 名を併記した。番号を振り直すと Stage 1 で確定した参照（DR1-002）が全て変わるため、番号自体は維持する |
| DR2-019 | `UnclassifiedFrameRecord` の所在が誤り。60 秒 dwell は 2 か所にある | **採用** | §2 用語を「型は `src/types/models.ts`、観測は `observeUnclassifiedFrame`（server 側 `UNCLASSIFIED_RECORD_DWELL_MS`）、CLI 側は `wait` の `UNCLASSIFIED_DWELL_MS`」に訂正し、**既存タイマーが 2 本ある**ことを明記した |
| DR2-020 | `dedupDropped` を `promptDedup` と「同型」としているがフィールド名が違う | **採用（既存名に揃える）** | §7 のフィールドを `{ skippedCount, lastSkippedAt, by }` に変更（既存 `promptDedup` は `{ skippedCount, lastSkippedAt }`） |
| DR2-021 | id 長さ上限 256 と関数名 `isCliToolId` が既存と揃わない | **採用（Stage 4 で上限値のみ 256 へ差し戻し）** | 関数名の `isCliToolType` への訂正は維持（§10.1(a)）。**上限は Stage 4 の DR4-014 により 128 → `MAX_SESSION_ID_LENGTH`（256）に改める**: 128 の根拠は `MAX_EVENT_DETAIL_LENGTH` との並びだったが、要求は push / pull を**同じ値**にすることであり、push 側 route が 256 で受理する id を pull 側だけ 128 で落とすと同じ id が経路によって通ったり落ちたりする。`MAX_EVENT_DETAIL_LENGTH`（128）は detail / `toolName` の上限として維持（§10.1 の表） |
| DR2-022 | `capabilities` を毎ポーリング payload に載せるコスト | **採用（露出面を分ける）** | §7 に「ホットパス（`current-output`）では `source` 名と版のみ。`capabilities` 本体は `capture --json` の詳細取得時 / `instances` 一覧でのみ返す」を注記 |
| DR2-023 | antigravity の probe は `agy --version`。`commandmate doctor` は存在しない | **採用** | §4 D2 の表を `agy --version` と実コマンドで記載し、`doctor` の言及を削除して `commandmate status` に一本化（新設が必要になったら別 Issue） |
| DR2-024 | 影響テスト列に `src` 配下のテストが入っていない | **採用** | §9 検出層行に `src/lib/__tests__/{status-detector,cli-patterns}.test.ts` と `tests/unit/lib/detection/**` / `tests/unit/detection-*.test.ts` を追加し、§6.1 にも「`tests/` 配下だけを見ない」と明記 |

### 15.3 Stage 3 Consider 項目の採否

| ID | 内容 | 採否 | 本書での扱い |
|---|---|---|---|
| DR3-017 | `BranchWaitingKind='unclassified'`（#1786/#1787）と `isUnclassifiedActive` / `statusEvidence:'none'` が同じ語で別概念 | **採用** | §2 用語に「2 つの `unclassified` の書き分け」行を追加し、(a) waitingKind の unclassified（`waiting` のときだけ動く）と (b) 証拠なしを常に書き分けると規定。**D1 の拡大は `deriveWaitingKind` に影響しない**（`waiting` でないときは `null`）ことも明記 |
| DR3-018 | `tests/unit/cli/commands/wait.test.ts` の「`ready` × `no_recent_output` × `isUnclassifiedActive` 無し → exit 0」が Phase 3 以降「製品が出さない payload」への pin になる | **採用（pin は残す）** | §9 検出層行に「**旧サーバ互換の pin として残し、`describe` 名に『旧サーバ（Phase 3 以前）』と明記する**」を追加。新サーバはこの組合せを出さなくなるが、**旧サーバ相手には出る**ため削除しない。同ファイルの `isUnclassifiedActive` 付き degraded 形の pin とは矛盾しない |
| DR3-019 | §9 の docs 行が `module-reference` / `architecture` の 2 件のみ | **採用** | §9 docs 行に `docs/design/upstream-fault-turn-boundary-1839.md`（§1.3 の表と `wait` の完了条件の逐語）と `docs/user-guide/cli-operations-guide.md`（exit 10 の type 3 種・exit code 表）を追加し、Phase 3 の受入条件に含めた |
| DR3-020 | §4 D5 決定 2 の precedence 表に `instanceId` 未指定時の早期 return が無い | **採用** | §4 D5 決定 2 の chain の先頭に「`instanceId` 未指定 → 明示指定 or null（roster は見ない）」を追加（`agent-instances-db.ts` の実装どおり）。§13 のチェックリストにも明記 |
| DR3-021 | §9 の影響範囲表に定量値が無い | **採用** | §9 に実測値を入れた: 検出層 **38 ファイル / 1220 ケース**、`agent-event-state` 参照 **37 ファイル / 546 ケース**、`no_recent_output` を直接 assert **8 ファイル**（内訳つき）、`isUnclassifiedActive` を参照する非 fixture ファイル 20、`lib/tmux` importer **31**。Phase 3 / 4 の Issue 分割の粒度判断に使う |
| DR3-022 | `MessageList` は本設計の消費者ではない（否定的実測） | **採用（非影響として記録）** | §9 に「統合判定（非影響）」行を新設。`MessageList.tsx` に `sessionStatus` / `sessionStatusReason` / `isUnclassifiedActive` / `isProcessing` の参照は **0 件**で、thinking は `THINKING_INDICATOR` 限定のため `no_recent_output` → `running` でも点灯しない。**後続レビューで再調査しない** |
| DR3-023 | `no_recent_output` → `running` は `MessageInput` の「queued (session busy)」トーストも新たに発火させる | **採用** | §9 統合判定（表示）行に `MessageInput` のトーストを追加。**`input_prompt` を `running` に倒さない決定（DR3-002）により、idle composer での誤発火は起きない**ことも併記 |

### 15.4 Stage 3 で逐語確認された整合点（Stage 4 では再確認不要）

Stage 3 が develop `90b67eb9` に対して**実測で一致を確認した 13 項目**。以後のレビューはここを再検証しない（差分が出たら基準日を更新する）。

1. `npm run lint` は develop で **exit 0 / 出力 0 行**（i18n セレクタの `warn` → `error` 格上げが CI を落とさないという DR2-005 の前提は実測どおり）。
2. `package.json` の `lint` は `eslint src --ext …` で `--max-warnings` を持たない（severity `error` が必要という D4 の判断は正しい）。
3. `status-detector.ts` の末尾優先順位（3. `input_prompt` → 4. `no_recent_output`（`STALE_OUTPUT_THRESHOLD_MS`=5000）→ 5. `default`/`running`）は §3 P1 の表と逐語一致。
4. `current-output-builder.ts` の `isUnclassifiedActive` 定義と上書き分岐（構造化 `ready` × scraper `running` → `false`）は DR2-003 の記述と逐語一致。
5. `wait.ts` の完了条件 `sessionStatus==='ready' && isUnclassifiedActive !== true`、`UNCLASSIFIED_DWELL_MS`=60_000、exit 10 の payload `{ type:'unclassified', options: [], status:'pending' }` は §4 D1 決定 2 と一致。
6. `src/cli/types/api-responses.ts` の `sessionStatus` は `'idle'|'ready'|'running'|'waiting'` の閉じた union で、`status-mapping.ts` に `status satisfies never` の網羅チェックがある（値域拡大を却下した D1 決定 2 は妥当）。
7. `agent-instances-db.ts` の precedence（roster 優先・矛盾はエラー・primary anchor・null）と `instances.ts` の CLI 側（roster 優先・矛盾は exit 2）は §4 D5 決定 2 と一致。
8. `probeActivity` / `fetchOpencodeActivity` には本番の呼び出し元が **0 件**（DR2-011 の記述どおり）。
9. `subscription.ts` に `resyncPending` が実装済みで、新規に書き起こす必要が無い（DR2-011 の記述どおり）。
10. §7 が挙げる Web UI コンポーネント 9 件（`BranchStatusIndicator` / `TerminalEscapeHatch` / `WorktreeDetailSubComponents` / `AgentSettingsPane` / `PromptPanel` / `ActivityPane` / `AgentInstancesPane` / `AutoYesToggle` / `MessageList`）はすべて実在する。
11. `getCatalogStaleness` のプロセス内 1 回キャッシュ + in-flight 共有は §4 D2 が引用したとおりの形。
12. auto-yes state は `globalThis.__autoYesStates` の in-memory Map で **DB 永続化が無い**ため、既定ツール変更にデータ移行は不要。
13. `src` 全体の `'claude'` リテラル **231 箇所 / 85 ファイル**という §4 D5 決定 4 の実測値は Stage 3 でも再現した。

**否定的実測（消費者ではないことの確認）**: `MessageList` は本設計の消費者ではない（DR3-022。§9 の「統合判定（非影響）」行）。Stage 3 のレビューコンテキストは消費者として想定していたが、実測で参照 0 件だった。

**セキュリティ観点の所見（Stage 4 への申し送り）**: Stage 3 は §10 について「既存の `isValidInstanceId` / `isCliToolType` / `isValidWorktreeId` を `resolveSessionTarget` 入口で通す」「`MAX_EVENT_ID_LENGTH`=128 を既存定数族に揃える」「opencode reply は loopback 固定・SSE 由来 id 限定」を確認し、**新しい secret も新しい外部入力面も増えない**と評価した（影響分析の観点では追加のセキュリティリスクを検出せず）。Stage 4 はこれを前提に、**Stage 3 で新設した面**（`GET /api/capabilities`・`client-fallback` 経路・読み取り経路の `conflict` 露出・`ls` の理由列）を主対象にできる。

**Stage 4 の結果（上の申し送りの帰結）**: Stage 4 は「新しい secret は増えない」を**追認**した（§15.7）が、**残り 3 点は成立しないと判定した**。(1) 「入口で必ず通す」は **API / CLI 入口しか覆っておらず、pull 経路は `resolveSessionTarget` を通らない**（DR4-014 → §10.1 を 2 段に分割）。(2) `MAX_EVENT_ID_LENGTH`=128 は **push 側の 256 と食い違う**（DR4-014 → 256 へ）。(3) 「新しい外部入力面が増えない」は誤りで、**`GET /api/capabilities` という無認証になりうる新面**（DR4-008）と、**`DETECTOR_VERSION_PROBES` 3 → 7 という PATH 経由の子プロセス実行面**（DR4-010）が増える。**「影響分析で追加リスクを検出せず」は、セキュリティ観点で検出しなかったことを意味しない**（Stage 3 の観点は消費者・importer・テストの実測であり、信頼境界の評価ではない）。

### 15.5 Issue #1915 本文との差分（本書から更新が必要）

Stage 2 の子 Issue 整合性チェックで、**Issue #1915 の GitHub 本文がレビュー前の記述のまま**であることが確認された。本書が正であり、Issue 本文は本書から更新する必要がある（**本書の更新作業では Issue 本文を編集しない**。反映は別作業として行う）。

| Issue #1915 本文の記述 | 本書の決定 | 反映先 |
|---|---|---|
| D1 を `SessionStatus` の `unknown` 追加として記述 | **`unknown` は追加しない**。`evidence: 'positive' \| 'none'` ＋ 既存 `isUnclassifiedActive` / exit 10 に統合（値域は 4 値のまま） | §4 D1 決定 2 の却下表 |
| D5 の precedence を「明示指定 → roster → worktree 既定 → `'claude'`」と記述（本書と逆） | **roster が明示指定に勝つ。矛盾は 400 / exit 2**（#1629 の実装が正） | §4 D5 決定 2 |
| D4 の allowlist を「`cli-tools` と `tmux` のみ」と記述 | allowlist の実体は **`lib/tmux` を import する 31 ファイル全件**（routes 11 / pollers 4 / ws・broadcast 6 / client 4 / cli 1 / session 5）。**恒久除外 12 / 段階解消 19** の 2 区分を持ち、Phase 1 の初期値は 31 件全件（DR3-001） | §4 D4、§16 付録 A |
| D1 の完了マーカーを全ツール前提で記述 | 完了マーカーは **opencode の 1 件のみ**。他ツールは「肯定確認された idle composer」規則の新設が前提で、ロールアウトはツール単位 | §4 D1 決定 1（DR2-002） |
| 対象範囲を子 Issue #1893〜#1914 と記述 | **＋ 既報 4 件（#1883 / #1884 / #1885 / #1886）** | §1、§8 Phase 2 表（DR2-015） |

**Phase 2 の実装・実機受入で覆った実測（#1979。基準 develop `a175767a`）**

本書の初版〜Stage 4 版が**設計レビュー時点の推定で書いていた 3 件**が、Epic #1891 の実装 26 件と実機受入で覆った。いずれも Phase 3 の実装が直接の対象にしている記述なので、**訂正前の本書どおりに実装すると誤りが再生産される**。

| # | 覆った記述（訂正前） | 実測（訂正後） | 出所 | 影響を受ける Issue |
|---|---|---|---|---|
| 1 | §4 D2 probe 表・DR4-010 規約 (1)・§10.11・§13.2 S17 が copilot の probe を **`gh copilot -- --version`** と規定 | **使えない**。`copilot` は gh の拡張ではなく gh 2.86.0 組み込みの preview コマンドで、**未インストール環境ではリリースをダウンロードする**（gh 自身の help が明記）。代替として `gh extension list` は copilot を列挙せず（出力 0 行）、`gh extension list --json` は `unknown flag`。**採る案は `resolveCopilotExecutable()` への委譲**（`kind:'delegated'`）で、これは DR4-010 (1) を**より強く**満たす（`startSession` と同一関数）。未インストール環境では**子プロセスを 1 つも起動せず** `null` を返し、規約 (2) の「probe をスキップし `staleness` を `undefined`」へ合流する。**規約に (5) 環境を変更しない を追加**した | #1907（`copilot-executable.ts` 着地）／ #1913（`VERSION_PROBES` 接続）／ #1979 の使い捨て `PATH`・`HOME`・`XDG_DATA_HOME` 実測 3 scenario | **#1929**（`DETECTOR_VERSION_PROBES`）／ §13.2 S17 |
| 2 | §4 D1 決定 1 の (2) が copilot の idle 例を **「`●` 応答行の直後に空の composer かつステータスバーに `Working` 無し」** と記述 | **1.0.80 のどのフレームにもこの形は存在しない**。composer `❯` は 200x1000 ペインの 999 行目に固定で、応答本文の**約 930〜970 行下**にあり、**生成中も同一の形で描かれる**。肯定的完了証拠は**ペイン最下行のステータスバー**（idle: `← open sidebar · / commands · ? help · tab next tab` ／ 生成中: `● Working esc interrupt`）。窓照合は不可（copilot 自身がこの語彙を本文に印字する実フレームがある）。「否定の不在」でなく「肯定的に読めた 1 行」であることが D1 の要件を満たす根拠 | #1885 の実 TUI キャプチャ 4 件（`tests/unit/lib/detection/fixtures/copilot-live-1885/`・200x1000・copilot 1.0.80）と `readCopilotStatusBar` / `COPILOT_IDLE_STATUS_PATTERN` / `COPILOT_WORKING_STATUS_PATTERN` | **#1928**（ツール別 idle 証拠規則）／ §4 D1 決定 1 |
| 3 | §6.1 が `STATUS_REASON.UNKNOWN_FRAME = 'unknown_frame'` の追加を規定（着地済みとも未着地とも書いていない） | **未着地**。`grep -rn 'UNKNOWN_FRAME' src/` は **0 件**（Phase 2 の scope 外だった）。§8 Phase 3 行に **#1927 の作業**として明記した | develop `a175767a` の実測 | **#1927**（`evidence` 導入と同一 PR） |

**この 3 件に共通する失敗の形**: いずれも「実行体・実フレーム・実定数を見ずに、設計上そうあるべき形を書いた」ものである。probe 表（1）は launch コマンド定数から probe コマンドを演繹し、idle 例（2）は他ツールの composer 挙動から copilot を類推し、（3）は規定を書いたことを着地と混同していた。**Phase 3 / 4 で本書に新しい「実行体・実フレーム・実定数」を書くときは、必ず実測の出所（コミット・fixture パス・コマンド出力）を併記する**。

### 15.6 Stage 4 Consider 項目の採否

| ID | 内容 | 採否 | 本書での扱い |
|---|---|---|---|
| DR4-015 | 新設エンドポイントと hooks 受信口にレート制限が無い（`createRequestRateLimiter` の適用は現状 `repositories/validate-path` と `fs/browse` の 2 ルートのみ） | **採用（適用 / 非適用を明示する形で）** | §10.10 (7) と §6.4 に「**新設ルートは `createRequestRateLimiter` を適用するか、適用しない理由を 1 行残す**」を決定として追加。**`GET /api/capabilities` は定数応答で DB / 子プロセスに触れないため非適用（理由あり）**、**`GET /api/worktrees/:id/resolve-target` は DB を引くため適用**。`/api/hooks/*` の既存受信口へのレート制限追加は本書の範囲外（別 Issue）とし、ここに記録だけ残す |
| DR4-016 | §10 に XSS の記述が無い（実測では新フィールドの受け皿は安全） | **採用（非機能要件として pin）** | **§10.13 を新設**。新設フィールドは React のテキストノードとしてのみ描画し、`dangerouslySetInnerHTML` / `title` 属性 / ANSI→HTML 変換器へ渡さない。実測結果（`PromptPanel` / `ActivityPane` は安全、`MessageList` は本設計の消費者ではない）を本文に残し、**次の実装が同じ確認をやり直さない**ようにした。§13.2 S19 で pin |
| DR4-017 | `plan.env` は launch line として pane の scrollback に描画され `capture --json` に載る。secret を載せない規約が無い | **採用** | **§10.7** に「`AgentLaunchPlan.env` に秘密（`CM_AUTH_TOKEN` を含む）を載せてはならない。秘密はプロセス環境の継承でのみ渡す（現行 copilot の作法）」を決定として追加。#1904 で `plan.env` の中身が増えるときの歯止めにする。§13.2 S18 で pin |
| DR4-018 | 読み取り経路の conflict を 200 に載せる決定（DR3-015）は、`conflict` を読む消費者が当面存在しないため**無音のまま誤った instance を観測し続ける** | **採用（stderr 警告として）** | §4 D5 決定 3 の趣旨（読み取り経路を 400 にしない）は維持したまま、**`client-fallback` と同じ扱いで「stdout の JSON 契約は変えず stderr に 1 行の警告を出す」**を §7 の該当行と §10.6 (6) に接続した。`monitor.sh` のような exit code だけを見る消費者を壊さずに無音を避ける。Web UI 側のチップを警告色にするかは §7 の該当行の運用（`resolvedBy:'fallback'` / `'client-fallback'` と同じ扱い）に合わせる |

**DR4-004 派生の Consider**: opencode の `OPENCODE_SERVER_PASSWORD` によるポート identity 強化は **§15.1 の未決事項**に記録した（採用可否は Phase 4 で判断。health ＋ version 確認だけでは残留リスクが消えないため）。

### 15.7 Stage 4 で実測により「問題なし」と確認された 8 項目（以後再確認不要）

Stage 4 が develop `90b67eb9` に対して実測し、**追加の対処を要しない**と判定した項目。**設計変更でこれらの前提を崩さないこと**が受入条件側の意味である（崩す変更を入れるときは §13.2 に行を足す）。

1. **opencode reply URL の path traversal**: `client.ts` が `encodeURIComponent(requestId)` を適用済み。**port は id から導出されない**ので、id 経由で別 loopback ポートへ SSRF することはできない。（ただし encode に依存せず §10.1 / §10.2 の検証を前段に置く、§10.5）
2. **XSS**: §7 の Web UI 受け皿のうち `PromptPanel.tsx` / `ActivityPane.tsx` に `dangerouslySetInnerHTML` も `title=` も無い。`MessageList.tsx` / `TerminalDisplay.tsx` は `innerHTML` を使うが `AnsiToHtml({ escapeXML: true })` を通し、かつ **`MessageList` は本設計の消費者ではない**（Stage 3 の否定的実測、§15.4）。→ 規約として §10.13 に残した。
3. **shell injection**: `hook-settings-generator.ts` の `shellQuote` は **POSIX 単一引用符エスケープとして正しい**。launch line の env 値も `renderAgentLaunchCommand` が同じ関数で囲む。tmux は `execFile` 経由で**シェルを介さない**。
4. **hooks 受信口の認証**: `/api/hooks/agent-event` と `/api/hooks/permission-request` は `AUTH_EXCLUDED_PATHS` に無く、middleware の Cookie / Bearer 検証を通る。
5. **新しい secret**: 本設計は**新しい資格情報を導入しない**（§10.7 の記述どおり）。新設の理由コードは閉じた enum とカウンタのみで、**prompt 本文を露出しない**。
6. **opencode の loopback 固定**: CommandMate は `--hostname` / `--mdns` を渡さず、`client.ts` は `OPENCODE_SERVER_HOST` 定数のみを使う。copilot の `HOOK_HOST` も `'127.0.0.1'` 定数。（§13.2 S13 でこの状態を pin する）
7. **ESLint 禁止パターン 3 綴りの妥当性**: 隔離環境の実測で `./tmux/tmux` / `./tmux/tmux-capture-cache` / `@/lib/tmux/tmux` / `../../lib/tmux/transcript-squeeze` の 4 件すべてを検出（**静的 import に限る**。動的 import は DR4-005 のとおり別手段、§4 D4）。
8. **version probe のコスト**: `getCatalogStaleness` はプロセス内 1 回キャッシュ ＋ in-flight 共有で、§4 D2 の probe コスト規約はこれを正しく引用している（**ポーリングごとの子プロセス生成は起きない**）。※ 実行体の解決方法は別問題で、DR4-010 として対処した。

---

## 16. 付録

### 付録 A. `lib/tmux` importer のソート済み初期リスト（31 ファイル・実測 develop `90b67eb9`）

**用途**: §4 D4 の ESLint `no-restricted-imports` allowlist の**初期値**であり、`tests/unit/guards/tmux-import-allowlist.test.ts` が完全一致で pin する対象である（DR3-001）。**Phase 1 の最初の commit がこの列挙と完全一致することを受入条件**にする。以後は**削除のみ許可**（段階解消の 19 ファイルが対象。恒久除外の 12 ファイルは進捗指標に数えない）。`src/lib/cli-tools/**` と `src/lib/tmux/**` 自身は対象外（ゲートウェイの実装本体）。

**綴りの分布**: `@/lib/tmux/**` が 24 ファイル、`./tmux/**`（`src/lib` 直下からの相対）が **6 ファイル**、`**/lib/tmux/**`（`../../lib/tmux/…`）が 1 ファイル。**`./tmux/**` を禁止パターンに含めないと 6 ファイルが素通りする**。

| # | パス | 使用している tmux API | import の綴り | カテゴリ | 区分 | 寄せ先 |
|---|---|---|---|---|---|---|
| 1 | `src/app/api/assistant/conversation/route.ts` | `hasSession` | `@/lib/tmux/**` | routes | 恒久除外 | —（Assistant Chat のセッションに対応する `CLITool` インスタンスが無い） |
| 2 | `src/app/api/assistant/current-output/route.ts` | `capturePane` / `hasSession` | `@/lib/tmux/**` | routes | 恒久除外 | 同上 |
| 3 | `src/app/api/assistant/session/route.ts` | `hasSession` | `@/lib/tmux/**` | routes | 恒久除外 | 同上 |
| 4 | `src/app/api/assistant/start/route.ts` | `hasSession` | `@/lib/tmux/**` | routes | 恒久除外 | 同上 |
| 5 | `src/app/api/assistant/terminal/route.ts` | `hasSession` | `@/lib/tmux/**` | routes | 恒久除外 | 同上 |
| 6 | `src/app/api/worktrees/[id]/capture/route.ts` | `hasSession` / `capturePane` | `@/lib/tmux/**` | routes | 段階解消 | `captureSessionOutput`（第 2 のゲートウェイ） |
| 7 | `src/app/api/worktrees/[id]/kill-session/route.ts` | `killSession` | `@/lib/tmux/**` | routes | 段階解消 | `ICLITool.killSession`（#1905。陽性テスト対象） |
| 8 | `src/app/api/worktrees/[id]/route.ts` | `listSessions` | `@/lib/tmux/**` | routes | 恒久除外 | —（`listSessions` に対応する `CLITool` メソッドが無い） |
| 9 | `src/app/api/worktrees/[id]/special-keys/route.ts` | `hasSession` / `isAllowedSpecialKey` / `sendSpecialKeysAndInvalidate` | `@/lib/tmux/**` | routes | 段階解消 | `ICLITool`（special-keys 経路） |
| 10 | `src/app/api/worktrees/[id]/terminal/route.ts` | `hasSession` / `sendKeys` / `sendSpecialKeys` / `invalidateCache` | `@/lib/tmux/**` | routes | 段階解消 | `ICLITool.sendMessage`（#1906） |
| 11 | `src/app/api/worktrees/route.ts` | `listSessions` | `@/lib/tmux/**` | routes | 恒久除外 | —（同上） |
| 12 | `src/app/worktrees/[id]/terminal/page.tsx` | `isTmuxControlModeEnabledForClient` | `@/lib/tmux/**` | client | 段階解消 | client 安全モジュール（`src/config/` か `src/lib/browser-compat/`）へ移設 |
| 13 | `src/cli/commands/capture.ts` | `squeezeTranscript` | `**/lib/tmux/**`（`../../lib/tmux/transcript-squeeze`） | cli | 恒久除外 | tmux に触れない純粋関数。`src/lib/text/` 等へ移設できたら allowlist から外す（別 Issue） |
| 14 | `src/components/Terminal.tsx` | `isTmuxControlModeEnabledForClient` | `@/lib/tmux/**` | client | 段階解消 | 同 12 |
| 15 | `src/components/worktree/NavigationButtons.tsx` | **型のみ** `NavigationKey` | `@/lib/tmux/**` | client（型のみ） | 段階解消 | `NavigationKey` を型モジュールへ移設（`allowTypeImports` は採らない、DR3-001） |
| 16 | `src/components/worktree/TerminalEscapeHatch.tsx` | **型のみ** `NavigationKey` | `@/lib/tmux/**` | client（型のみ） | 段階解消 | 同 15 |
| 17 | `src/lib/auto-yes-poller.ts` | `invalidateCache` | **`./tmux/**`** | pollers | 段階解消 | `session` ファサード（`invalidateSessionCache()`） |
| 18 | `src/lib/pasted-text-helper.ts` | `capturePane` / `sendKeys` | **`./tmux/**`** | ws / broadcast | 段階解消 | `ICLITool.sendMessage` ＋ `captureSessionOutput` |
| 19 | `src/lib/polling/assistant-conversation-poller.ts` | `hasSession` | `@/lib/tmux/**` | pollers | 段階解消 | `ICLITool.isRunning` |
| 20 | `src/lib/polling/global-session-poller.ts` | `hasSession` | `@/lib/tmux/**` | pollers | 段階解消 | `ICLITool.isRunning` |
| 21 | `src/lib/polling/response-checker.ts` | `CACHE_MAX_CAPTURE_LINES` / `isCaptureWindowSaturated` | `@/lib/tmux/**` | pollers | 段階解消 | `captureSpec()` ＋ `session` ファサード（capture 上限） |
| 22 | `src/lib/prompt-answer-sender.ts` | `sendKeys` / `sendSpecialKeys` / `invalidateCache` | **`./tmux/**`** | ws / broadcast | 段階解消 | `ICLITool`（送信 / special-keys）＋ `session` ファサード |
| 23 | `src/lib/realtime/terminal-broadcast.ts` | `invalidateCache` | `@/lib/tmux/**` | ws / broadcast | 段階解消 | `session` ファサード |
| 24 | `src/lib/session-cleanup.ts` | `clearAllCache` / `killSession` / `hasSession` | **`./tmux/**`** | ws / broadcast | 段階解消 | `ICLITool.killSession` ＋ `session` ファサード |
| 25 | `src/lib/session-key-sender.ts` | `hasSession` / `sendKeys` / `capturePane` / `killSession` / `sendSpecialKey…` / `invalidateCache` | **`./tmux/**`** | ws / broadcast | 段階解消 | `ICLITool`（送信 / special-keys / kill） |
| 26 | `src/lib/session/claude-session.ts` | `hasSession` / `createSession` / `sendKeys` / `capturePane` / `killSession` / `reconcileSessionGeometry` | `@/lib/tmux/**` | session | 段階解消 | `ICLITool`（`startSession` / `isRunning` / `killSession`） |
| 27 | `src/lib/session/cli-session.ts` | `SessionTransport` / `getPollingTmuxTransport` / capture キャッシュ一式 | `@/lib/tmux/**` | session | 恒久除外 | **`captureSessionOutput` の実体＝第 2 の公認ゲートウェイ本体** |
| 28 | `src/lib/session/current-output-builder.ts` | `CACHE_MAX_CAPTURE_LINES` / `isCaptureWindowSaturated` | `@/lib/tmux/**` | session | 恒久除外 | capture キャッシュの読み手（統合判定の本体） |
| 29 | `src/lib/session/send-user-message.ts` | `sendKeys` / `sendSpecialKeys` / `invalidateCache` | `@/lib/tmux/**` | session | 段階解消 | `ICLITool.sendMessage`（#1906 が copilot 分岐ごと削除） |
| 30 | `src/lib/session/worktree-session-reconcile.ts` | `listSessions` / `renameSession` / `getControlModeTmuxTransport` | `@/lib/tmux/**` | session | 恒久除外 | —（`listSessions` / `renameSession` に対応する `CLITool` メソッドが無い。`worktrees/route.ts` と同じ理由） |
| 31 | `src/lib/ws-server.ts` | `observeTmuxControlFirstOutputLatency` / `getControlModeTmuxTransport` / `isTmuxControlModeEnabled` | **`./tmux/**`** | ws / broadcast | 恒久除外 | —（control-mode トランスポートそのもの） |

**内訳の再掲**: routes 11 ／ pollers 4 ／ ws・broadcast 6 ／ client 4 ／ cli 1 ／ session 5 ＝ **31**。区分は**恒久除外 12**（#1〜5, 8, 11, 13, 27, 28, 30, 31）／ **段階解消 19**（残り）。

#### 付録 A への追記（#1922 の実装時に再計測。上表は develop `90b67eb9` 時点のスナップショットとして残す）

Phase 1 の実装（`feature/1922-tmux-import-guard`）で棚卸しをやり直したところ、**総数は 31 のままだが中身が 4 件入れ替わっていた**。権威は `.eslintrc.json` の `overrides` と、それを完全一致で pin する `tests/unit/guards/tmux-import-allowlist.test.ts` にある（本表ではない）。

- **追加 2 件**（`90b67eb9` より後に着地した #1879 / #1890 由来）: `src/app/api/worktrees/[id]/clear-composer/route.ts`（`hasSession`）と `src/lib/session/composer-clear.ts`（`capturePane` / `clearComposerLine` / `invalidateCache`）。いずれも**段階解消**に置いた。composer のクリアは D4 が「ツールクラスに閉じる」と決めたツール固有挙動そのものであり、`captureSessionOutput` の実体でもないため恒久除外には当たらない。
- **削除 2 件**: `NavigationButtons.tsx` / `TerminalEscapeHatch.tsx`。D4 が「Phase 1 に間に合わなくてよい」とした `NavigationKey` の型モジュール移設（`src/types/terminal-keys.ts`）を同じ commit で済ませたため、allowlist に載せる必要が無くなった。
- 区分の内訳は結果として不変（**恒久除外 12 ／ 段階解消 19**）。

**禁止パターンは 3 綴りでは足りない（実測）**。`@/lib/tmux/**`・`**/lib/tmux/**`・`./tmux/**` の 3 つは付録 A の 31 件を全件捕まえるが、`ignore` パッケージ（`no-restricted-imports` の実装が使う matcher）で直接測ると **`../tmux/x` と `../../tmux/x` と barrel の `@/lib/tmux` は素通りする**。`../tmux/**` は仮定の綴りではなく `src/lib/cli-tools/*.ts` が実際に使っている綴りであり、`src/lib/tmux/index.ts`（barrel）も実在する。したがって出荷した group は **`**/tmux/**` と `**/tmux` を足した 5 綴り**である（`@/config/tmux-pane-config` や `./tmux-capture-cache` には当たらないことを同時に確認済み）。

**`overrides.files` の `[id]` は minimatch のキャラクタクラスである**。`src/app/api/worktrees/[id]/route.ts` をそのまま書くと `.../i/route.ts` にしか当たらず、**その 5 ファイルが投入直後に error になる**。`\[id\]` とエスケープすること（該当 7 エントリ）。

**動的取得の severity**: DR4-005 の決定どおり `no-restricted-syntax` の base 1 キーに並べ、同時に D5 決定 4 (1) の「i18n セレクタを `warn` → `error` へ格上げ」も本 commit で実施した（実測 `npm run lint` は格上げ後も exit 0 / 出力 0 行）。selector は `(^|/)tmux(/|$)` で bare barrel まで見るように広げてある。

#### 付録 A への追記（#1905 の実装時。allowlist を初めて減らした commit）

**段階解消 19 → 18 / 総数 31 → 30**。削除したのは表の #7 `src/app/api/worktrees/[id]/kill-session/route.ts` の 1 行だけで、恒久除外 12 は不変。route は `ICLITool.killSession(worktreeId, instanceId)` を呼ぶようになり、`lib/tmux` の import を持たない（`getSessionName()` は D4 が公認するゲートウェイの一部なので残す。応答とログのためのセッション名取得にのみ使い、tmux の宛先には使わない）。

D4 が「lint は迂回の全数保証をしない」ことの補完として受入条件に置いた**陽性テスト**は `tests/unit/api/kill-session-cli-tool-gateway-1905.test.ts`。lint が表現できない 2 点をここで測っている: (a) `cliTool.killSession` が**実際に呼ばれる**こと（kill を落とした route も `no-restricted-imports` は通る）、(b) route 自身が tmux を kill **しない**こと（全ツールの `killSession` を stub した状態で tmux `killSession` が 0 回）。加えて opencode の `releaseOpencodeEventStream` が route 経由で呼ばれることを固定した — 症状（SSE 購読と port が解放されない）に一番近い観測点がこれであるため。

**ツール側の実測（2026-08-22・私設 tmux ソケット・200x50）**。route が本メソッド群を迂回していたので、いずれも #1905 まで無症状だった。

- **opencode 1.18.21**: `send-keys '/exit' C-m`（一括）は**終了しない**。`/` がコマンドパレットを開き、同一コマンドの `C-m` をパレットが食う（`/exit` を composer に残したまま 10.8 秒後も稼働、2 回中 2 回）。本文と Enter を分離すると 0.445 / 0.456 / 0.458 秒で終了（n=3）、詰まった状態から Enter 単発でも 0.34 秒。§4 D4 の「本文とキーを 1 回の `send-keys` に混ぜない」の実例。
- **copilot 1.0.80**: Issue #1905 本文の「素の `exit` はチャット送信になる」は**この版では成立しない**。`exit`（一括 / 分離）・`/exit`（一括 / 分離）・`C-c` ×2・`C-d` の 6 綴りすべてが終了する。実際の欠陥は待ち時間で、終了所要は 11 サンプルで 1.006〜2.193 秒＝**全サンプルが `TUI_EXIT_WAIT_MS`(500ms) 超**。tmux kill は必ず終了処理の途中に着弾していた。`COPILOT_EXIT_WAIT_MS`(3000ms) を新設し、送出は `/exit` の本文/Enter 分離に揃えた。
- **未解決（#1906 以降へ）**: copilot の終了確認は今も盲目 sleep である。肯定的証拠（`#{pane_current_command}` / `alternate_on`）を採るには `src/lib/tmux/**` に新しい read が要り、本 Issue の scope 外だった。tmux セッション自体は agent 終了後もシェルが残るので `hasSession` は終了の証拠にならない（opencode の step 4 も同じ理由で常に force kill 側へ落ちる）。

