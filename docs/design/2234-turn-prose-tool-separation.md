# Issue #2234 — prose と tool 実行の分離（生成側）

転写リーダー（#2041 / #2121 / #2197 / #2198）が `chat_messages` に書く assistant
本文は、**冒頭がツール呼び出しの列**になることがある。#2232 のチャット面は本文を
全文表示するので、その吹き出しは毎回ツールログで始まる。

このドキュメントは、**実装より先に採った実測**と、その実測が決めた設計を記録する。
測定は 2026-09-02、`362b6814`（`feature/2234-tool-log-separation` の分岐元）の
コードで実施した。

---

## 1. どれくらい起きているのか

計測対象は測定機の `~/.claude/projects` にある 714 本の Claude Code transcript の
うち**新しい 400 本**。各 turn を production の
`parseClaudeTranscript` → `buildClaudeTurns` → `renderClaudeTurn` に通し、本文の
**1 行目**を分類した。

| | 件数 |
|---|---|
| 本文が空でない turn | 586 |
| 1 行目が tool 行（`- \`Bash\` — …`） | **141（24 %）** |
| 1 行目が prose | 445 |
| 1 行目が `Thinking` の引用 | 0 |
| 本文が空（tool も prose も無い） | 12 |

Issue 本文が実データから引いている「冒頭が `- \`Bash\` — …` の列」という形は、
4 turn に 1 本の割合で出ている。

`Thinking` が 0 件なのは、claude の `thinking` ブロックが
`thinking: ""`（`signature` だけ）で届き `renderClaudeTurn` が空をスキップするため
で、#2121 が既に測って書いている挙動。**したがって「冒頭を占領しているのは
ツールログだけ」であり、`Thinking` を動かす必要はない。**

opencode 側は #2041 の実キャプチャ（1.18.22、`history-turns-1-18-22.json`）の 3 turn
のうち 1 turn が同じ形をしている:

    - `bash` — echo CMATE-2041-TOOL-MARKER

    It printed `CMATE-2041-TOOL-MARKER`.

---

## 2. 保存済みの本文を「読み直して」分離できるか → **できない**

分離を保存済み行にも遡って効かせるなら、`chat_messages.content` の Markdown から
tool 行を見分ける関数が要る。**その判別が実データで成立するかを先に測った。**

母数は §1 と同じ 400 本。prose ブロック（`type: "text"`）の全行と、
tool ブロックが実際に描画される行を突き合わせた。

### 2.1 素直なパターン

`^- \`[^\`]+\`(?: — .*)?$`

| | 件数 |
|---|---|
| prose の行（総数） | 18,914 |
| うちこのパターンに**一致**してしまう | **94** |
| tool 行（総数） | 39,093 |
| うち一致 | 39,093（100 %） |

94 件は本物の prose。実例（いずれも実データ）:

    - `src/lib/auto-yes-poller.ts:433` — **bare `catch {}`**（エラー値すら捕まえていない）。…
    - `docs/module-reference.md` — 194 行目の既存行を更新（追記ではなく更新）。…
    - `manager.ts:130-143` — `getAllToolsInfo()` は `tools.map(...)` + `Promise.all` で 7 本並列 ✅

### 2.2 ツール名らしさで絞ったパターン

バッククォートの中身を裸の識別子に限る `^- \`[A-Za-z][A-Za-z0-9_]*\`(?: — |$)`。
実測されたツール名は 29 種（`Bash` / `Edit` / `Read` / `Skill` / `Task*` /
`mcp__playwright__*` …）で、すべてこの形に収まる。

| | 件数 |
|---|---|
| prose の行（総数） | 18,914 |
| うち一致してしまう | **2** |
| tool 行（総数） | 39,098 |
| うち一致 | 39,098（100 %） |

残った 2 件も本物の prose:

    - `OPENCODE_PERMISSION_PATTERN` — gutter-anchored button strip (positive evidence, D1), …
    - `f1116bfd` — implementation, 16 files, all inside `scope.allow`, …

> tool 行の総数が 39,093 → 39,098 と動いているのは、2 回の census の間も測定機が
> transcript を追記していたため。母数の prose 行数は動いていない。

### 2.3 結論

**テキストからの再分類は無損失にできない。** 0 件にならない以上、保存済み行に
遡って適用すれば実際の文章が数十行単位でツールログ側へ移動する。よって:

- **生成側の分離は構造で行う。** リーダーはブロックの種別を知っているので、
  テキストを読み直す必要がそもそも無い（`TurnRenderBlock.kind`）。
- **保存済み行は書き換えない。** §6。

`grep` の 0 件で「無い」と言っていないことの陽性対照は上の 2 表そのもの
（同じ grep が tool 行 39,098 件を 100 % 引いている）。

---

## 3. 表現は何なら生き残るのか

描画は `ConversationPairCard` / `ChatSurface` の
`remarkGfm` + `rehypeSanitize` + `rehypeHighlight`、**`rehypeRaw` は無し**。
実際に `react-markdown` を通して測った（`tests/unit/hooks/sources/turn-separation-2234.test.ts`
に同じ測定が回帰テストとして入っている）。

| 入力 | 出力 |
|---|---|
| `<details><summary>Tool calls</summary> … </details>` | **`<details>` も `<summary>` も消える。ラベル文字列ごと消えて、裸の `<ul>` だけが残る** |
| `> **Tool calls (2)**` + `> - …` | `<blockquote><p><strong>…</strong></p><ul><li>…</li></ul></blockquote>` |
| `---` + `**Tool calls (2)**` + `- …` | `<hr/>` + `<p><strong>…</strong></p>` + `<ul>` |
| `<span class="x">y</span>` | `<p>… y …</p>`（タグだけ落ちる） |

`<details>` は**折りたたみにならないどころかラベルまで失う**ので使えない。
`rehypeRaw` を足せば通るが、それは #2041 が明示的に拒否した取引（ふつうの散文中の
`<T>` が HTML パーサに食われる）で、しかも `src/components/**` は本 Issue の
scope.deny。

採用したのは blockquote。既に 4 リーダーが `Thinking` に使っている形と同じで、
CSS クラスも React も足さずに「従属」を表現できる。

---

## 4. 設計

`src/lib/hooks/sources/turn-body.ts` に `separateTurnBody()` を置き、
4 リーダーの `render*Turn` がすべてここを通る。各リーダーは
`{ kind: 'prose' | 'aside' | 'tool', text }` を積むだけになり、
4 箇所にコピーされていた `joinTurnBlocks` は消えた。

規則は 2 つ:

1. **prose が先頭。** agent が書いた文と、その間に挟まる `Thinking` の引用
   (`aside`) は転写順のまま先頭に来る。
2. **ツールログは末尾に 1 セクション。** 呼び出し順のまま、ラベル付き
   blockquote に畳む。

出力例:

    Batch 1: **3/3 exit 0** …

    Batch 1 green 3/3. …

    > **Tool calls (3)**
    >
    > - `Bash` — SP=… cat $SP/vr3.txt …
    > - `Bash` — SP=… cat $SP/vr3.txt
    > - `Monitor` — SP=… prev="" while true; …

### 4.1 何を捨てたか

#2041 / #2121 は「順序こそが唯一の記録」として厳密な転写順を守っていた。
**種別の中の順序は今も守られている**（ツールは呼び出し順、段落は書かれた順）。
捨てたのは**種別をまたぐ interleave**、つまり「どの段落の下でどの呼び出しが
起きたか」だけ。この行を読む面はチャットの吹き出しであり、1 行目が
`- \`Bash\` — git status` の吹き出しは順序の議論に入る前に読者を失っている、
というのが取引の根拠。

### 4.2 `Thinking` を動かさない理由

`Thinking` は agent 自身の言葉であって tool 実行ではない。既に引用に畳まれており、
§1 の実測でも claude では 1 行目に来ていない（0/586）。Issue のスコープも
「prose とツール実行」。よって `aside` は prose 側に残す。

### 4.3 ツールを 1 本も呼ばなかった turn

`separateTurnBody` はセクションを出さず、本文は**変更前とバイト単位で同一**。
History に既にある tool 無し行と、今リーダーが書く行が食い違わない。

---

## 5. scraper 由来の `Ran N shell commands` を扱わない理由

Issue の受入基準は「同じ規則で扱える、**または扱わない理由が明記されている**」。
扱わない。理由は 2 つで、どちらも単独で決定的:

1. **その行は Markdown として描画されない。** scraper 経路の行は
   `request_id` が無いか `req_…`（`parseClaudeOutput`）で、
   `isAgentAuthoredMarkdown()`（`src/types/agent-transcript.ts`）が false を返す。
   カードは `whitespace-pre-wrap` で**逐語表示**する。`> **Tool calls (3)**` を
   差し込めば、その記号がそのまま文字として見える。
2. **分離すべき構造が無い。** `Ran 3 shell commands` は Claude の TUI が
   **自分で畳んだ要約行 1 行**であって、呼び出しごとのログではない。
   scraper が受け取るのは端末の *rendering* で、そこから 3 件の呼び出しを
   復元することはできない（できるなら転写リーダーは要らない）。

scraper 行の冒頭がツール要約になる問題は、**その worktree で転写リーダーが
効いていない**ことの症状であって、本文レイアウトの問題ではない。

---

## 6. 保存済み行の扱い — **新規行だけ**

`writeClaudeTurn` / `writeOpencodeTurn` / codex / antigravity のいずれも
`findMessageByRequestId` でヒットしたら**何も書かずに降りる**。既存行の
`content` は書き換わらない。§2 の実測どおりテキストからの再分類は無損失に
できないので、移行も行わない。

したがって History には 2 つの形が混在する:

- 分離前に保存された行 — `- \`Bash\` — …` が先頭に来たままの Markdown
- 本 Issue 以降に保存される行 — prose が先頭、末尾にツールセクション

どちらも同じ Markdown パイプラインで壊れずに描画される。混在は
`tests/fixtures/turn-separation-2234/claude-tool-first-turn.before.md`
（`362b6814` が実際に生成した本文）を実際にレンダリングして確認している。

---

## 7. 変異注入（空振りでないことの確認）

`separateTurnBody` に規則を無効化する変異を入れ、赤を目視した。母数は
`turn-separation-2234` / `claude-transcript-2121` / `opencode-transcript-2041` /
`codex-transcript-2197` / `antigravity-transcript-2198` /
`claude-transcript-progress-2199` の 6 ファイル 161 テスト。

| 変異 | 結果 |
|---|---|
| 1. 種別を無視して全ブロックを転写順に流す（＝分離を殺す） | **18 failed** / 143 passed |
| 2. セクションのラベルと引用を落とし、tool 行を裸で末尾に置く | **17 failed** / 144 passed |
| 3. セクションを prose の**前**に戻す | **9 failed** / 152 passed |
| 変異なし | 954 passed（`tests/unit/hooks/sources/` 全 48 ファイル） |

---

## 8. 触っていないもの

- `src/components/**` / `src/app/globals.css` — 1 バイトも変更していない。
  分離は Markdown 本文の中だけで完結し、描画は既存の
  `remark-gfm` + `rehype-sanitize` + `rehype-highlight` 経路をそのまま通る。
- `request_id` の prefix（`claude-turn:` / `oc-turn:` …）— 新しい意味を載せていない。
- `CLAUDE_TRANSCRIPT_TAIL_BYTES`（末尾 4 MiB の窓）— 広げていない。分離は
  読み終わったブロックの並べ替えだけで、追加の読み込みが要らない。
