# 上流障害と「ターン成立」の判定根拠（Issue #1839）

`commandmate wait` は「エージェントのターンが成立したか」を見ていなかった。上流 API 障害で
エージェントが何も実行せず即プロンプトに戻ると `wait` は exit 0 を返し、`--verify` は
work-evidence ゼロ（exit 21）を返す。呼び出し側はこれを「ターンは成立したが成果物が無い」と
読む — 実測 #1834 では上流 529 × 13 に対して exit 21 が 12 回。10 分待って再送したら 1 回で
完走した。

本書は**どの信号を一次ソースに選んだか**と、その選択を決めた実測を残す。

---

## 1. 実測（2026-08-20）

### 1.1 手法

実 API は一切叩いていない。

| 要素 | 隔離 |
|---|---|
| 上流 | ローカル stub HTTP サーバ。全リクエストに `529 {"type":"error","error":{"type":"overloaded_error"}}` を返す。子プロセスの `ANTHROPIC_BASE_URL` としてのみ渡し、シェルには export しない |
| 認証 | ダミーの `ANTHROPIC_API_KEY`。keychain も実 `~/.claude` も読まない |
| hooks 受信側 | ローカル stub HTTP サーバ。`writeAgentHookSettings()`（CommandMate が実際に注入するのと同じ生成器）に `port` だけ差し替えて向けた |
| tmux | 専用ソケット（`scripts/canary/tmux-private.ts` の `PrivateTmuxServer`、`-L cmate-canary-1839`）。後始末は `kill-session -t '=<name>:'` |
| HOME | 使い捨ての一時 HOME。onboarding と trust dialog のみ事前承認 |
| エージェント | 実 `claude` 2.1.236、200×50 ペイン |

送信内容は `Say the single word: ping`（1 ターンで終わるはずの最小要求）。

### 1.2 (a) hooks は何を送ったか

`structuredEvents.lastEventType` に相当する生イベントの到達順:

| 送信からの経過 | イベント | 備考 |
|---|---|---|
| −1.8 s | `SessionStart` | 起動 |
| **+0.6 s** | **`UserPromptSubmit`** | ターン開始の報告 |
| +0.6〜2.3 s | （上流へ POST × 4、すべて 529） | エージェント自身のリトライ |
| — | **`Stop` は 1 度も届かない** | 120 秒観測して 0 件 |
| **+62.3 s** | **`Notification(idle_prompt)`** | message は `Claude is waiting for your input` |
| +121.6 s | `SessionEnd` | こちらの teardown |

**これが本 Issue の中心的な発見**である。上流障害でターンが崩れたとき、Claude は
`Stop` を送らない。したがって「`Stop` が来ていない」は、上流障害を pane の文言に依存せずに
検出できる唯一の構造化信号になる。

### 1.3 (b) sessionStatus / sessionStatusReason

スクレイパー（`detectSessionStatus`）は 2 秒間隔・60 回の観測で **2 状態しか出していない**:

| 経過 | scraper status / reason | `hasActivePrompt` | `isUnclassifiedActive` |
|---|---|---|---|
| +3 s 〜 最後まで | `ready` / `input_prompt` | false | false |

つまりスクレイパーから見ると、このセッションは**送信の 3 秒後には完了している**。

`mergeStructuredStatus()` を通した公開値（`capture --json` の `sessionStatus`）は次のとおり:

| 経過 | 公開される sessionStatus / sessionStatusReason | 決めた層 |
|---|---|---|
| +0.6 〜 +62 s | `running` / `hook_prompt_submit` | 構造化（`user_prompt_submit` → running） |
| +62 s 以降 | `ready` / `hook_idle_prompt` | 構造化（`notification(idle_prompt)` → ready） |
| （hooks 無効時） | `ready` / `input_prompt`（+3 s から） | スクレイパー |

### 1.4 (c) wait の終了コードと所要秒数

`wait` の完了条件は `!isRunning || (sessionStatus === 'ready' && isUnclassifiedActive !== true)`。
上の遷移を当てると（`--verify` は work-evidence ゼロなので 21）:

| セッションの構成 | 本 Issue 以前の `wait` | `wait --verify` | 送信からの所要 |
|---|---|---|---|
| hooks 無効 | **exit 0** | **exit 21** | 約 3 秒 |
| hooks 有効 | **exit 0** | **exit 21** | 約 62 秒（`hook_idle_prompt` が `ready` を作った時点） |

hooks を有効にしても誤完了は消えず、62 秒遅れるだけだった。#1834 が見た「12 回の exit 21」は
この形である。

### 1.5 (d) pane の署名

pane は空白にならず、次の 1 行が最後まで残った（187 UTF-8 バイト）:

```
⏺ API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check your inference gateway (127.0.0.1:53892).
```

既存の署名表では `overloaded`（`/\b5\d{2}\s+Overloaded\b/i`）と `api-error` の両方が一致し、
先頭の `overloaded` が採用される（`selfRetrying: true` を持つので、そちらが有用）。

ただし #1834 が報告した「pane が空白になる」ケースは**本実測では再現していない**。stub が
即座に 529 を返したためエージェントが 4 回で諦めたのに対し、#1834 は上流が断続的に応答した
可能性がある。したがって pane 署名は「効くことがある」証拠であって、「常に効く」証拠ではない。

---

## 2. 判定根拠として何を一次ソースにしたか

| 信号 | 採否 | 理由 |
|---|:---:|---|
| `Stop` hook（`lastStopEventAt`） | **一次** | 1.2 の実測どおり、崩れたターンでは届かない。pane の文言に依存しない唯一の構造化信号 |
| `user_prompt_submit` / `pre_tool_use` / `post_tool_use` | 一次（ターン開始側） | 「このターン」を特定する時刻。`wait` は `send` の時刻を知らないので、これが最も近い代理 |
| `Notification(idle_prompt)` | **不採用** | 1.2 のとおり、**何も実行しなかったターンでも +62 s で届く**。ターン終端として扱うと同じ誤判定が 1 分遅れで再現する |
| pane の署名（`upstreamFault`） | 二次（理由の説明） | 効くときは 3 秒で理由まで分かる。ただし空白 pane・未知の文言では黙る。単独の完了判定には使わない |
| `sessionStatus === 'ready'` | 従来どおり必要条件 | ただし**十分条件ではない**ことが 1.3 で確定した |

### 2.1 Issue 記載の推奨からの逸脱

Issue #1839 本文は「最後の send より新しい `stop` **/ `idle_prompt`** が無い間は完了とみなさない」
を推奨していた。1.2 の実測により **`idle_prompt` を終端から外した**。
実装箇所: `src/cli/commands/wait.ts` の `TURN_OPENING_EVENT_TYPES`（`notification` を含めない）と
`turnSettled()`（`lastStopEventAt` のみを見る）。

もう 1 点、`--fail-on-upstream-fault` の発火位置を「ポーリング中に非 null になった瞬間」ではなく
**「composer に戻った時点のフレーム」**にした。途中で 529 を踏んで自力復帰したセッション
（`selfRetrying: true` の署名はまさにそれ）を中断させないため。ラッチも持たない。

---

## 3. 実装の形

| 層 | 変更 |
|---|---|
| `src/lib/detection/upstream-faults.ts` | 署名表 `UPSTREAM_FAULTS` と `findUpstreamFault()` / `matchUpstreamFault()`。定義はリポジトリ内で**ここ 1 箇所** |
| `scripts/canary/expectations.ts` | 上記を re-export するだけ（`runner.ts` / `session.ts` の import 元は不変） |
| `src/lib/session/current-output-builder.ts` | `realtimeSnippet` を判定して `upstreamFault: {id, matchedText, at} \| null` を publish |
| `src/cli/types/index.ts` | `WaitExitCode.UPSTREAM_FAULT = 11`、`WAIT_EXIT_CODE_PRIORITY` は 10 の直後 |
| `src/cli/commands/wait.ts` | ターン成立ゲート（既定 on・hooks 有効時のみ作動）、`--fail-on-upstream-fault`（opt-in）、完了行の `basis=` |

### 3.1 既定挙動を変えない範囲

- hooks が来ていないインスタンスは `turnStartedAt` が立たないので**完全に従来どおり**
- `wait` の開始より古いターン開始イベントは採用しない。サーバー側の構造化イベントは
  `structuredEvents` へ出る経路で世代フェンスを通らないため、前プロセスの残骸で待ちが
  固まることを防ぐ
- exit 11 は `--fail-on-upstream-fault` を明示したときだけ。skills 側 dispatch の既存 case を壊さない

### 3.2 残る失敗モード（意図的）

hooks が有効で `Stop` が来ないまま上流署名も出ない場合、`wait` は `--timeout` まで待って
exit 124 を返す。exit 0 で通すより安全という判断であり、`--timeout` を付けない運用は
この Issue 以降より強く推奨される。
