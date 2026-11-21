# antigravity-live-4503 — agy 1.5.13 の入力枠の実フレーム 14 枚

Issue #4503（agy への送信が見かけ上失敗して裏で届き、再試行で多重に送られる）の読み戻しを設計するために、人が採った agy 1.5.13 の実フレーム。空の枠・文字の入った枠・提出の途中・生成中・許可のダイアログ・モードのバナーを含む。

**まだどの試験もこの fixture を読まない。** 送信器の読み戻しは Sprint 10 の #4535 で決め直し、そのときに使う。設計は `docs/design/agy-submit-readback-4503.md`（第 3 版の §2・§6）。

**These files are raw on purpose. Do not strip ANSI from them.** ANSI も改行も採取したままのバイト。agy は上詰めなので、先頭の数十行の後ろは 1000 行目までの空白の詰め物（2364 と同じ。詰め物の無い fixture は本番の窓と違う読みになる）。

## Provenance

| | |
|---|---|
| Captured | 2026-11-21、人が MacBook Air で採取 |
| Agent | Antigravity CLI 1.5.13 (`agy`)、Gemini 4 Neon、Google AI Pro |
| Pane geometry | 200x1000 |
| Capture | `tmux capture-pane -p -e -S - -E -`（ANSI あり） |
| Session | 私的な tmux サーバー・使い捨ての HOME・使い捨ての git ディレクトリ。CommandMate のサーバーは使っていない（agy を直接起動。hooks なし） |

Redacted（これ以外のバイト・ANSI は不変）:

| 元 | 置き換え |
|---|---|
| アカウントのメールアドレス | `dev@example.com` |
| ホームのパス | `/Users/dev/agy4503-probe` |
| シェルのプロンプト | `dev@host` |

## The frames

手順は人への依頼（採る形の表）に従う。読みは設計書の §2・§6 の表。

| file | 画面 |
|---|---|
| `idle-empty.txt` | 起動直後の空の入力枠（基準）。枠の下は `? for shortcuts`。既定の auto のモードでも空の枠に案内文が出る |
| `typed-oneline.txt` | 1 行の本文 `Reply with exactly: OK one` を打った（Enter 前） |
| `submitted-0s.txt` | 上の状態で Enter の直後。echo も返事も無く、Enter の直後と読んだ（推定） |
| `submitted-1s.txt` | 1 秒後。生成中（`Working...`、枠の下は `esc to cancel`） |
| `submitted-done.txt` | 返答が終わった後の空の枠。履歴に `> 本文` の echo が残る |
| `typed-wrapped.txt` | 260 文字ほどの 1 行が折り返した本文（Enter 前） |
| `typed-multiline.txt` | C-j で改行した 2 行の本文（`line one` / `line two`）。C-j は改行で、送信されない |
| `typed-japanese.txt` | 全角の本文（幅の確認） |
| `typed-spoof.txt` | 本文に罫線（60 字）と `>` を含めた形。本文の罫線は 2 字下げで、枠の罫線（1 桁目から全幅）と見分けられる |
| `typed-generating-word.txt` | 本文に `Generating` と点字を含めた形 |
| `mode-banner-empty.txt` | plan のモードの空の枠。`> Plan mode: research & plan only (shift+tab to cycle)` が本文と同じ位置に出る |
| `mode-banner-typed.txt` | 上のモードで `hello` を打った形（バナーは消え、枠の下は `plan · …`） |
| `after-tool-turn-typed.txt` | ツールのターンの後に `next` を打った形 |
| `generating-empty.txt` | 許可のダイアログ（下の注意を見ること） |

## 注意

- `generating-empty.txt` は名前に反して、生成中ではなく**ツールの許可のダイアログ**（`Requesting permission for: …`、`> 1. Yes, run command`）。入力枠は無い
- `submitted-0s.txt` は echo も返事も無く、Enter の直後と読んだ。これは推定
- `enter-too-early`（Enter が早すぎたとき）は採っていない
- 1.5.13 の生成中の語は `Working...`（旧版の `Generating...` ではない）
- 既定の auto のモードでも、空の枠に案内文が出る（`idle-empty.txt`）。案内文を文字と読むと、すべての送信を断ることになる
- 履歴の過去のターンも 1 桁目の `>` と 60 字の罫線で描かれる。今の入力枠は全幅（200 字）の罫線の間。裸の `>` だけで枠と読んではならない
- 枠の下の右寄せは、モードで変わる（`auto · …` / `plan · …` / 接頭なし）
