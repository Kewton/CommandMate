---
name: video-to-gif
description: 録画済みの mp4 / webm / mov を、GitHub の markdown ビューアが実際に再生できる GIF に変換する。バイト予算を指定すると解像度・fps・パレットを段階的に落として収まるまで再試行し、収まらなければ書かずに落ちる。「GIF を作って」「GIF 化」「mp4 を GIF に」「README に貼れる動画」等の指示で使う。
allowed-tools: Bash(.claude/skills/video-to-gif/scripts/*), Bash(.agents/skills/video-to-gif/scripts/*), Bash(ffmpeg *), Bash(ffprobe *), Read, Glob
---

# video-to-gif

録画済みの動画を GIF にする。`to-gif.sh` 一発で、**バイト予算に収まる GIF** が出る。

```bash
.claude/skills/video-to-gif/scripts/to-gif.sh demo.mp4                 # demo.gif を隣に出す
.claude/skills/video-to-gif/scripts/to-gif.sh *.mp4 --out docs/images/features
.claude/skills/video-to-gif/scripts/to-gif.sh clip.mp4 --max-bytes 500k
.claude/skills/video-to-gif/scripts/to-gif.sh --ladder                 # 再試行の段取りだけ表示（ffmpeg 不要）
.claude/skills/video-to-gif/scripts/to-gif.sh --report docs/images/features/*.gif
.claude/skills/video-to-gif/scripts/to-gif.sh --check                  # 依存確認のみ
```

## なぜ GIF なのか

GitHub の **markdown ビューアは `<video>` を描画しない**。HTML 許可リストに含まれておらず、
動画添付が再生されるのは issue / PR / discussion の**コメント**だけである。リポジトリ内の
`.md` に貼って動く動画は GIF しかない。

例外は **GitHub Pages**（`website/`）で、そちらは素の HTML がそのまま配信されるので
`<video>` が使える。LP に置くなら GIF ではなく mp4 の方が軽い（実測 GIF 1.02MB に対し
mp4 0.56MB）。**GIF が要るのは docs 配下の markdown だけ**。

## なぜ demo-video の `compose.sh --gif` と別なのか

`compose.sh --gif` は合成パイプラインの途中でしか発火せず、720px / 12fps / `sierra2_4a` を
ハードコードしている。docs に載せるときに要るのは「**完成済みの mp4 から**、**リポジトリが
背負えるサイズの** GIF を作る」ことで、しかも収まったかどうかは**測って**判断する必要がある。
この 2 点は合成の関心事ではないので別スキルにした。

## 設計判断: dither は既定で切る

同一素材（20 秒 / 1280x800 の UI キャプチャ）を、無劣化リファレンスに対する SSIM で実測した。

| 設定 | バイト数 | SSIM (All) |
|------|---------|-----------|
| `colors=256 dither=none` ← **既定** | 1,073,725 | **0.99653** |
| `colors=128 dither=none` | 883,912 | 0.99439 |
| `colors=128 dither=sierra2_4a` | 1,271,671 | 0.99160 |
| `colors=128 dither=bayer` | 998,339 | 0.99149 |
| `colors=64 dither=none` | 736,163 | 0.99202 |

**ディザは 2 軸とも悪化させる。** 空間ノイズを撒くので GIF が圧縮に使う LZW の run が壊れ、
かつ画面録画の大半を占める**平坦な UI パネルには均すべきグラデーションが無い**。
`colors=64` + `sierra2_4a` は 1,472,301 バイトで `colors=128` の同ディザより**大きい** —
パレットが粗いほど誤差拡散が遠くまで広がるためである。

グラデーションが実在する素材（写真・動画コンテンツ）では `--dither sierra2_4a` を
**意識して**渡すこと。既定で有効にはしない。

`--stats-mode diff` も測ったが誤差の範囲で、むしろ僅かに大きくなった（`full` のまま）。

## バイト予算とラダー

`--max-bytes`（既定 1.5M）に収まるまで、3 軸を**ラウンドロビンで**一段ずつ落として再試行する。
fps を底まで落としてから解像度に手を付ける、という順序にはしない。4fps 等倍も 360px 30fps も
中間の妥協より見た目が悪く、**画面の文字が読めること**が UI デモの目的だからである。

```
$ to-gif.sh --ladder
to-gif: budget 1.50MB per file; floors 360px / 6fps / 32 colors
rung    width    fps   colors
1         600     10      256
2         600      8      256
3         480      8      256
4         480      8      128
5         480      6      128
6         384      6      128
7         384      6       64
8         360      6       64
9         360      6       32
```

`--ladder` は **ffmpeg を 1 度も呼ばない**。段取りの算術だけを検証できるようにしてあり、
`tests/unit/skills/video-to-gif/ladder.test.ts` がここを固定している。

底まで行っても収まらなければ **exit 1 で、ファイルを書かない**。到達した最小サイズと
その設定を stderr に出す。知った上で書きたいときだけ `--allow-oversize`（それでも exit 1）。

## 主なオプション

| オプション | 既定 | 説明 |
|-----------|------|------|
| `--out PATH` | 入力の隣 | `.gif` で終われば出力ファイル、それ以外はディレクトリ（自動作成） |
| `--width PX` | 600 | 開始幅。高さはアスペクト比に従う |
| `--fps N` | 10 | 開始フレームレート |
| `--colors N` | 256 | パレット数 2..256 |
| `--dither MODE` | `none` | `sierra2_4a` 等を明示指定可 |
| `--max-bytes SIZE` | `1.5M` | `1500000` / `1500k` / `1.5M` / `none` |
| `--no-fit` | — | ラダーを歩かず 1 回だけ試す |
| `--start SEC` / `--duration SEC` | — | トリミング |
| `--loop N` | `0` | `0` = 無限ループ、`-1` = 1 回だけ再生 |
| `--min-width` / `--min-fps` / `--min-colors` | 360 / 6 / 32 | ラダーの下限 |

## 落とし穴（実際に踏んだもの）

- **サイズは `wc -c` で測る。`du` は使わない。** APFS では `du -h` が 1,536,216 バイトの
  ファイルを 2.3M と報告した。ブロック割り当てであって中身ではない。**git が保存するのは
  `wc -c` の方**で、この差で総量を 38MB と 25.8MB に読み違えかけた。
- **`-t` は `-i` の前に置く。** 引数列の末尾に足すとパレット入力（2 本目の `-i`）の
  入力オプションとして解釈され、トリムが黙って効かなくなる。`--duration 6` が 16 秒の
  GIF を吐いた。
- **動画は git の delta 圧縮が効かない。** 作り直すたび全部を再コミットしないこと。
  出力の最後に「コミットすれば何バイト増えるか」を出しているのはこのため。
- **`scale=W:-1` は奇数の高さを作りうる**（600 幅 → 375）。GIF は問題ないが、同じ式で
  h264 に渡すと `height not divisible by 2` で落ちる。比較用のリファレンスを作るときは
  `-2` か可逆コーデックを使う。
- 引数の検証は ffmpeg の存在確認**より先**に行っている。逆順だと、ffmpeg の無い環境
  （= 全 CI ランナー）で引数の誤りがすべて `required command not found: ffmpeg` になり、
  開発機では踏めず CI でだけ落ちる（`compose.sh` で実際に起きた。PR #1562）。

## 構成

```
video-to-gif/
├── SKILL.md
└── scripts/
    └── to-gif.sh      # 変換・ラダー・計測・依存確認をモードで持つ単一スクリプト
```

テストは `tests/unit/skills/video-to-gif/` にあり `npm run test:unit` に含まれる
（`.claude/skills/**` に置くと CI では 1 度も実行されない。root tsconfig が `.claude/**` を
除外しており、`npm run lint` は `eslint src` にスコープされているため）。

スキルは `.claude/skills/` と `.agents/skills/` の**両方に byte-identical で置く**。
公式の install 先は `.agents/skills` のみ（Codex / Antigravity が読む）で、Claude は
`.claude/skills` しか読まない。片方だけに置くと**何のエラーも出ないまま**もう一方の
エージェントから不可視になる。`mirror.test.ts` が差分を落とす。

## 制約

- bash 3.2 互換（`declare -A` / `mapfile` を使わない）。macOS が同梱しているのは 3.2 である。
- ffmpeg / ffprobe が要る。無ければ `--check` が `brew install ffmpeg` を提示して exit 1。
- 出力先が `.gif` で終わらないファイル名（`hero.png` 等）は**ディレクトリとして扱わず拒否する**。
  タイプミスで `hero.png/` というフォルダを作る方が黙って困る。
