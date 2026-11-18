# codex 検出の回帰コーパスと、codex 更新時の確認手順（Issue #2842）

## 目的

codex の画面判定（`src/lib/detection/tools/codex/`）は、codex の版が上がるたびに壊れてきた
（#1154・#2310・#2798・#2818 は、どれも codex の更新で画面の見た目が変わったことが原因）。
これまでは利用者が壊れた画面に気付いて Issue にするまで分からなかった。

この文書は次の 2 つを定める。

1. **回帰コーパス**: リポジトリにある codex の画面キャプチャすべてについて、検出器の判定を 1 つの表で固定する
   （`tests/unit/lib/detection/codex-verdict-corpus.test.ts`）。
2. **更新時の確認手順**: codex を更新したら、決まった 6 画面を新しい版で撮り、同じテストの probe モードで判定を確かめる。

## 1. 回帰コーパス

- 対象は `tests/` 配下で、パスに `codex` を含む `*.txt` / `*.capture` すべて。
- 各ファイルを「撮ったまま」と「`stripAnsi` 後」（Auto-Yes が検出層に渡す形）の 2 通りで判定し、
  `status/reason`（`hasActivePrompt` が真なら末尾に `/prompt`）を表と照合する。
- 表に無い codex キャプチャを `tests/` に足すとテストが落ちる（完全性の確認）。新しい fixture を足したら表に 1 行足す。
- 表の値は「今の検出器の判定」であって、正解の宣言ではない。判定を変える修正は、その Issue の中で表の行も書き換える
  （書き換えた行は PR の説明に列挙する）。

## 2. codex 更新時の確認手順

codex を更新したとき（`codex --version` が `CODEX_VERIFIED_AGAINST` と違うとき）に行う。
所要は 10 分程度。codex の資格情報を複製しないため、手元のマシンで本人が実行する。

### 2-1. 準備

```bash
codex --version                                  # 例: codex-cli 0.156.1
PROBE=$HOME/codex-probe-$(codex --version | awk '{print $2}')
mkdir -p "$PROBE/repo" && cd "$PROBE/repo" && git init -q && echo probe > README.md
# 本番の tmux サーバーに触れないよう、専用ソケット（-L）を使う
# `-a untrusted` は 0.157.1 で廃止。`-a on-request -s read-only` で起動し、trust は画面で承認する
tmux -L codexprobe new-session -d -s probe -x 200 -y 1000 -c "$PROBE/repo" 'codex -a on-request -s read-only'
cap() { tmux -L codexprobe capture-pane -t '=probe:' -p -e -S -1000 > "$PROBE/$1"; }
send() { tmux -L codexprobe send-keys -t '=probe:' -l -- "$1"; tmux -L codexprobe send-keys -t '=probe:' Enter; }
```

画面は `tmux -L codexprobe attach -t probe` で見られる（見終わったら `Ctrl-b d` で抜ける）。

### 2-2. 6 画面を撮る

| ファイル名 | 撮るタイミング | 操作 |
|---|---|---|
| `trust.txt` | 起動直後、フォルダの信頼を訊かれている間 | `cap trust.txt` の後、画面に従って信頼する |
| `idle.txt` | 入力欄だけが出ている間 | `cap idle.txt` |
| `running.txt` | 処理中（`• Working` などが出ている間） | `send 'Run the shell command: sleep 30'` の直後に `cap running.txt` |
| `approval.txt` | コマンド実行の承認を訊かれている間 | 上の依頼で承認画面が出たら `cap approval.txt`、その後 `3`（No）で断る |
| `model-picker.txt` | `/model` の選択画面 | `send '/model'` の後に `cap model-picker.txt`、`Escape` で閉じる |
| `quoted-approval-idle.txt` | 承認画面の文面を**本文で引用した**返答が終わった後 | 下の依頼を送り、返答が終わって入力欄に戻ったら `cap quoted-approval-idle.txt` |

`quoted-approval-idle.txt` のための依頼:

```bash
send 'Reply with exactly the following block and nothing else:
Would you like to run the following command?
  $ npm test
› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel'
```

### 2-3. 判定を確かめる

```bash
cd <CommandMate の checkout>
CODEX_PROBE_DIR="$PROBE" npx vitest run tests/unit/lib/detection/codex-verdict-corpus.test.ts
```

- 6 画面すべてが期待どおりなら、新しい版でも判定は変わっていない。
  `src/lib/detection/tools/verified-against.ts` の `CODEX_VERIFIED_AGAINST` を新しい版に更新する PR を出す。
- 落ちた画面があれば、その画面が新しい版で変わっている。落ちた画面のキャプチャを添えて Issue を起票する
  （キャプチャに私的な内容が無いことを確認してから添付する。このプローブ用リポジトリで撮っていれば含まれない）。

### 2-4. 片付け

```bash
tmux -L codexprobe kill-server   # -L 付き。本番の tmux サーバーには届かない
```

`$PROBE` は、Issue に添付するまで残しておいてよい。

### 2-5. 実施記録

- **0.157.1**（2026-09-27、Issue #2868）: `model-picker.txt` だけが落ちた（フッタが `enter select · esc back` に変わった）。`CODEX_PICKER_FOOTER_PATTERN` で直し、`CODEX_VERIFIED_AGAINST` を 0.157.1 へ。`-a untrusted` が廃止され `-c projects.….trust_level` の上書きも効かなかったので、`-a on-request -s read-only` で起動し trust は画面で承認した（`tests/fixtures/codex-dialogs-0157/README.md`）

## 3. 実運用での検知（Issue #2843）

更新時の確認で拾えない誤判定（特定の会話内容でだけ起きるもの）は、サーバーログ（`logs/server.log`）の
`[WARN] [layer-disagreement] layerDisagreement {…}` 行で拾う。hook がターンの開始と終了を届けるツール
（claude・codex・copilot・gemini・opencode）の画面が「ダイアログが開いている」と読み、同時にそのツールの hook は
「ターンは終わっている（`Stop`）」と言っている回を、ターンごとに 1 行、画面の末尾 40 行つきで記録する。
antigravity と Command Code は、hook がターンの開始を届けず、新しいターンの途中でも最新の hook イベントが前のターンの
`Stop` のまま残るため、対象外にしている。ターンは閉じたが自分で再開する `Stop`（`self_resume_pending`）も記録しない。

```bash
grep '\[layer-disagreement\] layerDisagreement' logs/server.log | tail
```

行の `cliToolId` がどのツールの画面かを示す。

- `kind: approval-after-stop` — ターン終了後に「答えられる承認」が見えている。承認はターンの途中にしか出ないので、
  毎回が検出器の不具合。`frameTail` を元に fixture を作り、Issue を起票する。
- `kind: menu-after-stop` — ターン終了後に選択リストが見えている。利用者が `/model` などを開いた場合にも出るので、
  開いた覚えが無いものだけを調べる。

## 4. 画面の読み方の実測（composer とダイアログ）

判定規則の実体は `src/lib/detection/tools/codex/cli-patterns.ts`（`readCodexGlyphRowKind`）と
`src/lib/detection/composer-text.ts`。ここには、規則を変えるときに外せない観測だけを置く。

### 4-1. `›` の 3 用途はテキストでは区別できない

codex は列 0 の `›`（U+203A）を composer・送信済みメッセージのエコー・ダイアログの選択行の 3 つに使う
（0.148.0〜0.153.2 で観測、200x1000）。`stripAnsi` 後は同じ形なので、`capture-pane -p -e` の SGR で読む。

| 用途 | 生の形 | 手がかり |
|---|---|---|
| composer | `ESC[1m›ESC[0m ` + 本文（空なら dim の placeholder） | グリフの直後で属性がリセットされる |
| エコー | `ESC[1;2m› ESC[0m` + 本文 | **グリフが dim** |
| 選択行（承認・picker・`/keymap`・`/experimental`） | `ESC[1mESC[38;5;6m› …ESC[0m` | **本文が bold** |
| trust ダイアログの選択行（0.151 以降） | `ESC[38;5;6m› 1. Yes, continueESC[39m` | bold でも dim でもなく、グリフと本文が**同じ色の 1 span** |

- 0.155.1 からは空の composer のグリフも bold＋truecolor で着色される。「グリフに色がある＝選択肢」とは読めず、
  本文がグリフと同じ色で続くときだけ選択肢の証拠にする（`tests/fixtures/codex-idle-composer-0155/`）。
- 選択肢は**積極的に認識**し、未知の形・ANSI の無い行は composer 側に倒す。「composer でない」と否定形で書くと
  新しいダイアログの形を composer と読む。番号の regex（`› \d\. `）で弾くのも不可（`1. buy milk` と打った composer を落とす）。
- 誤読のコストは非対称。composer を読み落としても現状維持だが、ダイアログ行を composer と読むと送信前の消去が承認画面へ
  `C-e` / `C-u` を撃ち込み、上限まで回った末に送信自体を拒否する。
- SGR を走査するときは `38;5;N` / `38;2;R;G;B` の引数を読み飛ばす。`ESC[38;5;2m` の `2` を dim と読むと、
  選択肢の色がそのまま dim になって全ダイアログがエコー扱いになる。
- `tmux display-message -p '#{cursor_x}'` は codex では使えない。残存テキストがあっても Home を押していれば
  空の composer と同じ 2 を返す。

claude も同型の罠を持つ（Claude Code 2.1.238 で観測）。空の composer に dim（`ESC[2m`）の suggestion
（`Try "how do I log an error?"`）を描き、`stripAnsi` 後は実際の残存テキストと 1 バイトも変わらない。`C-u` でも消えない
（buffer に無い）ので、テキスト比較で「空か」を判定するループは idle な claude で上限まで回る。`❯` の直後は ASCII 空白ではなく
U+00A0（NBSP）。claude では `cursor_x == 2` が空を意味するが、フレーム単体（WS push・`capture --json`・fixture）には
後付けできないので、判定は SGR の dim で行う。

### 4-2. 番号を持たないダイアログ

`/experimental`（フッタ `Press space to select or enter to save for next conversation`、選択行 `› [ ] Network proxy …`）と
`/keymap`（フッタ `left/right group · enter edit shortcut · … · esc close`）は `1. 2. 3.` を持たず、フッタもダイアログのフッタの
許可リストに当たらない形だった（0.153.2 で観測）。番号ブロックの検出では拾えないので、主判定は 4-1 の SGR に置く。
逆に「フッタが許可リスト外なら ready」でもない。trust ダイアログのように `detectPrompt` が番号を読める画面は別の段で拾われ、
ready に落ちるのは「許可リスト外」かつ「`detectPrompt` も読めない」画面だけ。

採り方は 2-1 と同じ私設 tmux で、`C-u` で入力欄を空にしてから `/<cmd>` + Enter → `capture-pane -p -e` → `Escape`。
生成中のフレームでも composer（`› Ask Codex to do anything`）は描かれたままなので、「最下段の `›` が composer」という規則は
running を巻き込まない。
