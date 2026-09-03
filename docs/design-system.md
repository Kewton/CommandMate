# デザインシステム

CommandMate の UI デザイン基盤（色トークン・アイコン等）に関する規約をまとめる。

---

## セマンティックトークン（色）

CommandMate の色は **CSS 変数（セマンティックトークン）** で一元管理する。
Tailwind からは `bg-background` / `bg-surface` / `text-accent-500` のようなセマンティック
クラスで参照し、`gray-*` / `cyan-*` / `blue-*` の直書きは原則禁止とする。

- トークン定義: [`src/app/globals.css`](../src/app/globals.css)（`:root` = ライト、`.dark` = ダーク）
- Tailwind への登録: [`src/app/globals.css`](../src/app/globals.css) の `@theme inline`
  （Issue #1178 の Tailwind 4 CSS-first 移行で `tailwind.config.js` は廃止）
- 初出: Issue #1041（基盤導入。既存コンポーネントの一括置換は #1045 で実施）

> **Issue #1178 / `<alpha-value>` の廃止**: Tailwind 3 ではトークンを
> `rgb(var(--token) / <alpha-value>)` として登録していたが、Tailwind 4 は不透明度
> 修飾子（`bg-surface/50`）を `color-mix()` で自前合成するため `<alpha-value>` は不要。
> **RGB チャンネルトリプレット方式（`--surface: 255 255 255`）はそのまま維持**しており、
> `rgb(var(--token) / 0.5)` の手書き参照も従来どおり動作する。
> `@theme` ではなく `@theme inline` を使う点が重要: utility が
> `var(--color-surface)` ではなく `rgb(var(--surface))` を直接出力するため、
> `.dark` での再宣言が要素側で解決され、テーマ切替が壊れない。

> このトークン基盤の導入では **見た目を変えない**。各トークンの値は現行 Tailwind シェードの
> 実効値を写し取っている（例: `--background`(light) = `gray-50`）。

### トークン一覧

値は `rgb(...)` 合成のため **RGB チャンネル値（スペース区切り）** で定義する。
末尾に対応する現行 Tailwind シェードを併記する。

| トークン | ライト（`:root`） | ダーク（`.dark`） | 用途 |
|---------|------------------|------------------|------|
| `--background` | gray-50 | `#0f1117`（旧 `cmd-bg-dark`） | ページ背景 |
| `--foreground` | gray-900 | gray-100 | 基本文字色 |
| `--surface` | white | gray-800 | カード・パネル背景 |
| `--surface-foreground` | gray-900 | gray-100 | サーフェス上の文字色 |
| `--surface-2` | gray-50 | gray-900 | 一段深いサーフェス |
| `--muted` | gray-100 | gray-800 | 補助背景 |
| `--muted-foreground` | gray-500 | gray-400 | 補助文字 |
| `--border` | gray-200 | gray-700 | 境界線 |
| `--input` | gray-300 | gray-600 | フォーム枠 |
| `--ring` | cyan-500 | cyan-500 | フォーカスリング |
| `--accent-50`〜`--accent-950` | cyan-50〜950 | cyan-50〜950 | アクセント（cyan スケール） |
| `--success` | green-500 | green-500 | 成功 |
| `--warning` | amber-500 | amber-500 | 警告 |
| `--danger` | red-500 | red-500 | エラー・破壊的操作 |
| `--info` | blue-500 | blue-500 | 情報 |
| `--success-subtle` / `-border` / `-foreground` | green-50 / 200 / 800 | green-950 / 800 / 300 | 成功アラート面（淡色背景・枠・前景） |
| `--warning-subtle` / `-border` / `-foreground` | amber-50 / 200 / 800 | amber-950 / 800 / 300 | 警告アラート面 |
| `--danger-subtle` / `-border` / `-foreground` | red-50 / 200 / 800 | red-950 / 800 / 300 | エラーアラート面 |
| `--info-subtle` / `-border` / `-foreground` | blue-50 / 200 / 800 | blue-950 / 800 / 300 | 情報アラート面 |
| `--sidebar` | slate-50 | `#141821`（= `--surface`） | サイドバー地色 |
| `--sidebar-foreground` | gray-900 | gray-100 | サイドバー主要テキスト |
| `--sidebar-border` | slate-200 | `#2a303e` | サイドバー境界ヘアライン |
| `--sidebar-hover` | slate-100 | gray-800 | hover / 選択行の背景 |
| `--sidebar-muted` | gray-500 | gray-400 | サイドバー二次テキスト |
| `--terminal-surface` | gray-900 | gray-900（同値） | 常時ダーク島の地色（#1892） |
| `--terminal-foreground` | gray-300 | gray-300（同値） | 常時ダーク島の文字色（#1892） |

`--accent-*` と `--success` / `--warning` / `--danger` / `--info` はライト・ダークで同値だが、
将来のモード別調整を容易にするため両ブロックに明示的に定義している。

`--{status}-subtle/-border/-foreground`（Issue #1112 のステータス tint スケール）は**モード可変**。
ライトは `*-50` の淡色面＋ `*-800` の前景（AA 4.5:1 超）、ダークは `*-950` の低輝度面
（#0a0c12→#141821 のエレベーション階梯から浮かない）＋ `*-300` の前景（AA 8:1 超）。

`--terminal-*`（Issue #1892）は**唯一「テーマに追従しない」ことが定義であるトークン**で、
`@layer base` の `:root` に 1 度だけ宣言し **`.dark` に対を置かない**。常時ダーク島（#1075 分類 (a)）を
「ファイル名が `*Terminal*` である」「コメントにそう書いてある」ではなく**スタイルの型として**表すためで、
値は `TerminalDisplay` が実際に描いている gray-900 / gray-300 に揃えてある。

`--sidebar-*`（Issue #1073）は **standalone なリテラル RGB 値**で定義する（`--surface` 等を
`var()` 参照しない）。理由: `--surface` 階梯の将来改修がサイドバー色に意図せず波及するのを防ぐため。
「テーマ追従」方式のため、ライトは白系パネル（slate-50 + ヘアライン）、ダークは `#141821`
（`--surface` = #1049 の階梯）に整合させる。`ThemeToggle` はサイドバー／ヘッダー共有部品のため
`--sidebar-*` には束縛せず、テーマ中立トークン（`text-muted-foreground` / `hover:bg-muted` /
`focus:ring-ring`）で着色する。

### Tailwind クラス対応

| CSS 変数 | Tailwind クラス例 |
|---------|------------------|
| `--background` | `bg-background` |
| `--foreground` | `text-foreground` |
| `--surface` / `--surface-foreground` / `--surface-2` | `bg-surface` / `text-surface-foreground` / `bg-surface-2` |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` |
| `--border` | `border-border` |
| `--input` | `border-input` |
| `--ring` | `ring-ring` / `focus:ring-ring` |
| `--accent-500` | `bg-accent-500` / `text-accent-500` |
| `--success` / `--warning` / `--danger` / `--info` | `text-success` / `bg-danger` など |
| `--{status}-subtle` / `--{status}-border` / `--{status}-foreground` | `bg-warning-subtle` / `border-warning-border` / `text-warning-foreground` など |
| `--sidebar` / `--sidebar-foreground` / `--sidebar-border` | `bg-sidebar` / `text-sidebar-foreground` / `border-sidebar-border` |
| `--sidebar-hover` / `--sidebar-muted` | `hover:bg-sidebar-hover` / `text-sidebar-muted` |
| `--terminal-surface` / `--terminal-foreground` | `bg-terminal-surface` / `text-terminal-foreground` |

各色は `@theme inline` に `rgb(var(--token))` 形式で登録しており、
`bg-surface/80` のように **透過度指定** がそのまま使える
（Tailwind 4 が `color-mix()` で合成する。Issue #1178 以前は `<alpha-value>` 方式）。

### 使用ルール

1. **新規・変更するスタイルはセマンティックトークン経由で指定する**
   （`bg-white dark:bg-gray-800` ではなく `bg-surface`）。
2. トークンはライト/ダーク両モードで自動的に切り替わるため、**`dark:` バリアントは原則不要**。
3. 新しい意味的な色が必要になったら、直書きを増やさず **まずトークンを追加** する。
4. **淡色アラート面（Toast・エラーフォールバック・PromptPanel 等）は生パレット＋`dark:`ペア禁止**。
   `bg-{status}-subtle` + `border-{status}-border` + `text-{status}-foreground` の tint トークンを使う
   （status = success / warning / danger / info。Issue #1112）。tint 面内のソリッドアクションボタンは
   反転 tint（`bg-{status}-foreground text-{status}-subtle`）とし、両テーマで AA コントラストを確保する。
   常時ダーク島（`TerminalErrorFallback` 等の `*Terminal*` 面）はこのルールの対象外。

### 直書き色の禁止と例外

`gray-*` / `cyan-*` / `blue-*` 等の **直書きカラークラスは原則禁止**。以下は例外として許容する。

- **モードに依存しない固定色**: ブランド固定のシンタックスハイライト（`.prose pre` の
  `#0d1117` 等）、ターミナル配色、`::highlight()` 検索ハイライト。
- **意味的にトークン化されていない一過性の装飾**: 追加のトークン化が過剰と判断できる箇所。
  この場合もライト/ダーク両対応を保つこと。
- **サードパーティ由来のクラス**: xterm.js / highlight.js 等が要求する固定クラス。

例外を用いる場合は、その色がなぜトークン化に馴染まないかを PR で説明すること。

#### アクセント統一（#1045）で維持する直書き例外

`cyan-*` / `blue-*` をセマンティックトークンへ統一する際（Issue #1045）、以下は
意図的に直書きを維持する。これら以外に `cyan-*` / `blue-*` の直書きクラスが残っていないことを
grep で確認する運用とする。

1. **ターミナル ANSI 配色**: `src/components/Terminal.tsx` の xterm `theme` 内の色
   （`blue`/`cyan`/`brightBlue`/`brightCyan` 等の HEX 値）。ANSI パレットのため固定色を維持。
2. **CLI ツールのブランド識別色**: `src/app/worktrees/[id]/terminal/page.tsx` の CLI ツール選択色
   （claude=`bg-purple-600` / codex=`bg-blue-600` / gemini=`bg-green-600` / bash=`bg-gray-600`）。
   ツール識別のためのブランド色として当面維持する。
3. **スクロールバー**: `src/app/globals.css` の `.scrollbar-thin` は **Issue #1082 でトークン化済み**
   （thumb = `rgb(var(--input))` / hover = `rgb(var(--muted-foreground))`）。ライト/ダーク両モードに追従する。
   （なお `MessageList.tsx` は本 Issue で完全にトークン化済みで、直書きの `cyan-*` / `blue-*` は残っていない。）

なお、状態・情報色として使われていた `blue-*` は `info` トークン（= blue-500）へ、
インタラクティブ／アクティブ／フォーカスの `blue-*` は `accent` / `ring` トークンへ統一した。

#### chromatic 色のトークン化（#1116）

`red` / `green` / `yellow` / `amber` / `orange` / `purple` / `violet` / `sky` / `blue` の直書きは
**意味ベースでステータス tint トークンへ移行**する（`bg-{status}-subtle` / `border-{status}-border` /
`text-{status}-foreground` / `bg-{status}`。status = success / warning / danger / info）。
淡色面のペア `text-{c}-a dark:text-{c}-b` はトークンが両テーマを吸収するため `dark:` を撤去する。

| 用途 | 生色（旧） | トークン（新） |
|------|-----------|----------------|
| 成功・完了・追加・healthy | green | `success` |
| 警告・待機・注意・変更・conflict | yellow / amber / orange | `warning` |
| エラー・削除・危険操作 | red | `danger` |
| 情報・レビュー中・カテゴリ識別 | blue / sky / purple / violet | `info` |

**例外（生色のまま許容。CI ガードからも除外）**:

1. `*Terminal*` 面、および `src/app/worktrees/[id]/terminal/` の CLI ブランド識別色
   （`claude=bg-purple-600` / `codex=bg-blue-600` / `gemini=bg-green-600`）。
2. `error/TerminalErrorFallback.tsx` — ターミナル配色に合わせた常時ダーク島（`*Terminal*` 名の別ファイルへ分離済み）。
3. コードブロック／シンタックスハイライトの固定ダーク（`.prose pre` の `#0d1117` 系）。
4. ~~4 ステータスに馴染まない装飾色でトークンが存在しないもの（例: ファイル種別アイコンの
   `text-pink-500`）。grep パターン（上記 9 色）に含まれない色に限り〜~~
   **#1892 で撤回。** この例外は「ガードの grep パターンに含まれない色なら残してよい」と読める形で
   書かれており、実際に `text-pink-500`（TreeNode）/ `text-teal-600`（gitPaneShared）/
   `bg-neutral-900`（VerificationPane）/ `border-t-cyan-500`（FileTreeView）が**ガードに素通りしたまま**
   残っていた。パターンは Tailwind 既定パレット全体を見るようになったので、**「パターン外」は
   もう例外の根拠にならない**。4 ステータスに馴染まない装飾色は `accent` スケール（= cyan、両テーマ同値）
   へ寄せるか、必要ならトークンを新設する。

「完了」は grep 実数ではなく **`node scripts/check-token-discipline.mjs` の exit code** で判定する
（パターン・対象・除外の単一権威ソース。#1882 / #1892）。

### 常時ダーク領域とテーマ追従（#1075）

UI の配色方針は次の 2 分類のみ。曖昧な「暗いまま」の島を新設しないこと。

- **(a) 常時ダーク（意図的固定）**: xterm ターミナル本体の出力領域
  （`src/components/Terminal.tsx` / `TerminalDisplay.tsx` の描画先、`TerminalSearchBar` /
  `LogViewer` 等のターミナル系オーバーレイ）と、シンタックスハイライト付きコードブロック
  （`.prose pre` / `.assistant-md pre` = `#0d1117`。github-dark 系トークンが暗地前提のため）。
  端末・コードの慣例として妥当な固定ダーク。ライトモードでもダークで描画する。
- **(b) テーマ追従（既定）**: 上記以外の**すべての UI**。履歴ペイン・会話カード・Home Chat・
  メモ/ファイル等を含め、`surface` / `surface-2` / `border` / `foreground` /
  `muted-foreground` 等のセマンティックトークンで着色し、ライト/ダーク両モードへ追従する。
  常時ダーク領域を新設・拡張しないこと。

> **hidden-children 注意**: 常時ダーク前提で子孫が `text-gray-300` / `bg-gray-800` 等を
> `dark:` 無しで直書きしていると、テーマ追従化した親の下でライト時に不可視化する。
> コンテナだけでなく**描画サブツリー全体**をトークン化し、ライトの実画面で目視確認する。

#### 常時ダーク島はトークンで表す（#1892）

常時ダーク島は `bg-terminal-surface` / `text-terminal-foreground` を使う。生の `gray-*` / `neutral-*` を
直書きして「コメントで常時ダークだと書く」形は取らない。理由は**その意図を機械が読めない**ことで、
実際 `VerificationPane` はコメントで常時ダークだと宣言しながら生 `neutral-*` を使っており、
ガードのパターンが `neutral` を見ていなかったため誰も気づかなかった。

**判断: `VerificationPane` の `<pre>`（`commandmate verify` のゲートログ抜粋）は常時ダークのまま維持する**

- **テーマ追従にしない理由**: この面は CLI ゲートの生ログ（等幅・ANSI 前提の出力）をそのまま流す
  **ターミナル出力面**であり #1075 の分類 (a) そのもの。同じワークツリー画面に `TerminalDisplay` が
  並ぶため、ライトでここだけ白地になると 1 画面の中でログ面が 2 つの慣例に分かれる。
- **ファイル名規約（`*Terminal*` 除外）に寄せない理由**: ガードの除外は `TERMINAL_FILE_EXCLUDE`
  （パス中の `Terminal`）で効くので、リネームでも通せる。しかしそれは「常時ダークである」という
  **設計上の性質をファイル名の綴りに預ける**ことであり、綴りを外れた瞬間に静かに壊れる
  （まさに今回の `VerificationPane` がそれ）。トークンなら `--terminal-*` は `:root` にだけ宣言され
  `.dark` に対が無い ＝ **「テーマに追従しない」がトークンの定義**になり、置いた場所に依存しない。
- **除外のマーカー方式化（案 3）を採らない理由**: ガード側の仕組みが 1 つ増えるが、常時ダークという
  性質は依然としてマーカー（コメント）であってスタイルではない。トークン化の方が表現として強い。
- **値の変更**: 旧 `neutral-900` / `neutral-100` から `gray-900` / `gray-300`（`TerminalDisplay` の実値）へ
  **意図的に変更**した。同じ「ターミナルのダーク」がコンポーネントごとに別の値へ散るのを止めるため。
  コントラスト比 11.6:1（AA 超）。
- ガードの `*Terminal*` 除外は**据え置き**（`TerminalDisplay` 等は xterm 側の固定テーマと対で
  生ダークユーティリティを使っており、本 Issue では触らない）。

**先例に従った新設: `ChatDialogCard` の画面枠（#2254）**

チャット面のダイアログカードは、TUI ペインの末尾数行を ANSI ごとそのまま描く。#1075 の分類 (a) —
固定 xterm パレット前提の出力面 — なので**両テーマでダークのまま**とし、色は
`bg-terminal-surface` / `text-terminal-foreground` で表す。ファイル名は `ChatDialogCard` であって
`ChatTerminalDialogCard` ではない: 上の「ファイル名規約に寄せない理由」がそのまま当てはまり、
`*Terminal*` 除外に新しい島を足さない（トークンで表せば綴りに依存しない）。

- カードの**中身だけ**がダーク島。枠線・ラベル・下の操作ボタン行はテーマ追従（`border-border` /
  `bg-muted` / `text-muted-foreground`）で、チャット面の他の要素と同じ慣例に載る。
- 操作ボタンは `hover` 表示にしない（タッチでは `@media (hover:none)` により不可視になる）。
  常時表示＋ `min-h/min-w-[44px]`（#1127）。

---

## フォーカス表現 (Issue #1082)

インタラクティブ要素のフォーカスリングは **`focus-visible:`**（`focus:` ではなく）で表現し、
キーボード操作時のみリングを描画する（マウスクリックでリングを出さない）。手本は `Tabs` / `Switch`。

- **ボタン系プリミティブ**（`Button` / `SidebarToggle` / アイコンボタン等）:
  `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background`。
  `ring-offset-background` を必ず付ける（未指定だと Tailwind 既定の白オフセットがダークで白ハローになる）。
- **フォーム系プリミティブ**（`Input` / `Textarea` / `Select` トリガー等）:
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring`（枠が反応するため ring-offset は付けない）。
- 逸脱フォーカス色（`ring-gray-*` / `ring-red-*` / purple / amber）は使わない。既定は `ring-ring`、
  破壊的操作の文脈でのみ `ring-danger`。

### テキスト選択・ツールチップ

- **`::selection`**: `rgb(var(--accent-500) / 0.25)` のアクセント淡色ウォッシュ（`globals.css`、両モード共通）。
- **ツールチップ**: 反転サーフェス `bg-foreground text-background`（Radix `TooltipContent` が基準。
  ライトで暗い吹き出し、ダークで明るい吹き出しにテーマ追従する）。二次テキストは `text-background/70`。

## トークン規律 ガード (Issue #1082 / #1116 / #1882 / #1889 / #1892)

移行済みディレクトリに対して **2 つ** の検査を hard-fail で回す。

1. **不在検査**（#1082 / #1116 / #1892）: 生の直書きカラークラス（`bg-`/`text-`/`border-`/`ring-`）が
   再流入したら落とす。対象は **Tailwind 既定パレットの全ファミリー**（#1892）。
2. **実在検査**（#1889）: 参照しているトークン名が `src/app/globals.css` の `--color-*` に**実在すること**を確認する。
   Tailwind は解決できないクラスを黙って捨てるため、`bg-surface-elevated-typo` のような打ち間違いは
   「背景が消える」「文字色が継承されて読めない」という**視覚だけの silent failure** になり、
   lint も tsc も unit も検出しない（クラス名は単なる文字列）。PR #1881 では `sky-*` → `info` tint の置換で
   1 の検査が PASS し、トークンの実在は**人間が `globals.css` を grep して手で確認**していた。その手作業の自動化。

検査本体は **`scripts/check-token-discipline.mjs` の 1 本だけ**（Issue #1882）。パターン・対象ディレクトリ一覧・
除外はすべてこのファイルが単一の権威ソースで、次の 2 箇所は**それを呼ぶだけ**である。

| 実行元 | 呼び出し |
|--------|----------|
| CI | `.github/workflows/ci-pr.yml` の `token-discipline` ジョブ |
| `commandmate verify` / `wait --verify` | `.commandmate/verify.yaml` の `token-discipline` ゲート（実測 0.1s） |

> #1882 以前は検査本体が `ci-pr.yml` にインラインのシェルで直書きされており、`verify.yaml` は
> lint / typecheck / unit の 3 本しか宣言していなかった。そのため PR #1881 は `wait --verify` が
> **全ゲート exit 0** を返した commit が CI の Token discipline で FAILURE になっている。
> verify.yaml へ `git grep` をコピーすると同じ検査が 2 箇所に増えて静かに乖離するため、
> **スクリプトを共有する**形にしてある。

- **対象カラー（#1892 で全パレットへ拡張）**: Tailwind 既定パレットの**全 26 ファミリー**。
  正規表現は `(bg|text|border|ring)-((x|y|t|r|b|l|s|e|offset)-)?(<全ファミリー>)-[0-9]` で、
  ファミリー一覧は `scripts/check-token-discipline.mjs` の `TAILWIND_PALETTE_FAMILY_NAMES`
  **1 箇所だけ**が持つ。不在検査（正規表現）と実在検査（Tailwind 組み込み配色の判定）が**同じ配列**を
  読むため、両者が「Tailwind の配色とは何か」で食い違うことがない。
  - **列挙漏れが再発しない根拠**: ハードコードした配列を、unit テストが
    `node_modules/tailwindcss/theme.css` の `--color-<family>-<step>` 実宣言と**集合として突き合わせる**
    (`tests/unit/scripts/check-token-discipline.test.ts`)。Tailwind を上げてファミリーが増えれば
    **その時点でテストが赤**になり、黙って穴が広がらない。スクリプト自身が `tailwindcss` を import
    しないのは、CI の `token-discipline` ジョブが `npm install` を行わないため（#1889 の判断と同じ）。
  - **#1116 の 11 ファミリー列挙で何が起きていたか**: `neutral` / `zinc` / `stone` / `pink` / `rose` /
    `fuchsia` / `indigo` / `cyan` / `teal` / `emerald` / `lime`（および Tailwind 4.3 追加の
    `mauve` / `olive` / `mist` / `taupe`）が素通りし、develop 上で 4 箇所の生配色が残ったまま
    ガードが **exit 0（「生配色は無い」）** を返していた。手で選んだ列挙は「誰も足そうと思わなかった色」
    について**構造的に無言**で、その無言はクリーンなツリーと区別できない。
  - **側面・オフセット付きも対象**（#1892）: `border-t-cyan-500` / `ring-offset-slate-900`。
    実在検査は以前からこれらを「Tailwind 組み込み配色」と判定していたため、不在検査が見ていないと
    **同じクラスについて 2 つの検査が食い違う**状態だった（`FileTreeView` のスピナーがそこに居た）。
  - **対象外**: `text-white` / `bg-black`（パレットのステップを持たない。トークン面の上に載せる
    `text-white` が正当なケースが多く、方針判断が別途要る）、`bg-[#123456]` 等の arbitrary value。
- **対象（ホワイトリスト）**: `src/app`（`src/app/worktrees/**` を除く）、
  `src/components/{ui,layout,home,review,repository,common,sidebar,providers,worktree,mobile,external-apps,error,auth}`。
  （worktree/mobile/external-apps は #1061、error/auth は #1116 で追加。）
- **対象外（意図的な常時ダーク島・スコープ外）**:
  - `*Terminal*` ソースファイル（`src/components/Terminal.tsx`、`error/TerminalErrorFallback.tsx` 等）。
    ターミナル出力面は両テーマでダーク維持のため生ダークユーティリティを使う（#1079）。
    **新しい常時ダーク島をこの除外に足さないこと**: ファイル名の綴りに設計を預ける形なので、
    `*Terminal*` に当たらない面（`VerificationPane` がそうだった）は静かに漏れる。
    新設は `bg-terminal-surface` / `text-terminal-foreground` のダーク島トークンで表す（#1892）。
  - `src/app/worktrees/**`（ワークツリー詳細ルート／ターミナルページ。CLI ブランド色
    `claude=bg-purple-600` / `codex=bg-blue-600` / `gemini=bg-green-600` / `bash=bg-gray-600` を含む）。
  - テストファイル（`*.test.*` / `*.spec.*` / `__tests__`）はクラス文字列を検証するため除外。

- **違反時の直し方**: ホワイトリストやパレット一覧をいじらず、`docs/design-system.md` の
  セマンティックトークンへ置換する。
  中立色は `foreground` / `muted` / `muted-foreground` / `border` / `surface` / `input` / `ring`、
  状態色は `bg-{status}-subtle` / `border-{status}-border` / `text-{status}-foreground` / `bg-{status}`
  （status = success / warning / danger / info）、4 ステータスに馴染まない装飾色は `accent` スケール、
  常時ダーク島は `terminal-surface` / `terminal-foreground`（#1892）。

#### 実在検査の判定方法と検出できない範囲（#1889）

判定は `(bg|text|border|ring)-<rest>` の `<rest>` が次の 3 つのどれかに当たるかで行い、どれでもなければ違反とする。

| 分類 | 例 | 扱い |
|------|-----|------|
| Tailwind 組み込みの**非配色**ユーティリティ | `text-xs` / `text-center` / `border-b-2` / `border-dashed` / `bg-gradient-to-br` / `ring-offset-2` / `ring-inset` / `border-collapse` | 許可（スクリプト内の許可リスト） |
| Tailwind 組み込みの**配色** | `text-white` / `bg-black` / `bg-transparent` / `text-current` / `text-pink-500` | 許可（生配色の可否は上記 1 の検査の担当。`text-white` / `bg-black` は #1889 のスコープ外） |
| プロジェクトのトークン | `bg-info-subtle` / `bg-surface` / `ring-offset-background` / `border-t-accent-600` | 許可 |

**なぜ Tailwind に解決させず許可リストなのか**: CI の `token-discipline` ジョブは checkout ＋ `run:` 1 本だけで
`npm install` を行わない（`tests/unit/guards/static-guard-single-source.test.ts` がこの形を固定している）。
`tailwindcss` を import すると、node_modules を用意しないジョブが node_modules に依存することになる。
代償として **Tailwind が将来追加したユーティリティは許可リストを更新するまで偽陽性になる**が、
その失敗は「どのクラスで落ちたか」を出す**大声の失敗**であって、黙って PASS する方向ではない。

**検出できない範囲（意図的。スクリプト冒頭にも同じ一覧がある）**

- **動的クラス名**: `` `bg-${tone}-subtle` `` / `'bg-' + name` / 実行時に引くテーブル。リテラルが無いので検査対象にならない
  （Tailwind 側もこれらは生成しないが、「ガードが通った＝そのコンポーネントの算出クラスが解決する」ではない）。
- **arbitrary value**: `bg-[#123456]` / `text-[11px]` / `border-[var(--x)]` は対象外（1 の検査も見ていない）。
- **4 接頭辞以外の配色ユーティリティ**: `from-` / `via-` / `to-` / `divide-` / `outline-` / `fill-` / `stroke-` /
  `decoration-` / `placeholder-` / `caret-` / `accent-` / `shadow-` は検査しない（1 の検査の対象面と揃えてある）。
- **コメント本文**: 走査前に除去する。除去しないと英文コメント（"a text-entry context" / "the border-trick spinner"）が
  CI 失敗になる — 実測では素朴な実装の偽陽性は**全件**これか組み込みユーティリティだった。
  代わりに、コメント中に書いたトークン名の誤りは報告されない。
- **除外対象**: テストファイル・`*Terminal*` ファイル・`src/app/worktrees/**`、および
  `.ts/.tsx/.js/.jsx/.mjs/.cjs/.css` 以外の拡張子。
- **「実在する」だけ**: `--color-info-subtle` が宣言されていることは、それが**意味的に正しい**トークンかどうかも、
  参照先の RGB チャンネル三つ組が `@layer base` に定義済みかどうかも保証しない。

---

## アイコン (Icons)

### ライブラリ

- UI アイコンは **[lucide-react](https://lucide.dev/)** に統一する。
- 絵文字リテラル(🤖 / ⚡ / ✦ / 💻 / ⭐ / ✨ など)を **UI 表示に使用しない**。
  絵文字は OS・ブラウザで見た目が変わり、モダンな UI トーンを崩すため。
  - 例外: ターミナルストリーム出力(xterm.js に書き込むテキスト)や CLI 出力・
    ログ・検出パターン(`src/lib/detection/**`)は対象外。これらは表示 UI ではなく
    テキストコンテンツのため。

### サイズ規約

アイコンサイズは以下の 3 段階に統一する(`size` prop または `w-*/h-*`)。

| サイズ | 用途 |
|--------|------|
| **16px** | テキストインライン、密度の高いリスト・バッジ内 |
| **20px** | ナビゲーション・ツールバー・タブ(標準) |
| **24px** | 見出し・強調・モーダルヘッダ |

### strokeWidth

- `strokeWidth` は **2**(lucide-react のデフォルト)を基準とする。
- 現行デザインの見た目に合わせて個別調整する場合を除き、変更しない。

### 色

- アイコンの色は原則 `currentColor` を継承させ、親要素のテキスト色
  (セマンティックトークン経由、ライト/ダーク両対応)で制御する。
- ブランド固有色(CLI ツールの claude/codex/gemini 等)は個別指定を許容する。

### アクセシビリティ

- 装飾目的のアイコンには `aria-hidden="true"` を付与し、隣接するテキストラベルや
  `aria-label` を主たるアクセシブルネームとする。
- アイコン単独ボタンには必ず `aria-label` を付与する。

### 実装例

```tsx
import { Bot } from 'lucide-react';

// ナビ・ツールバー(20px 標準)
<Bot size={20} aria-hidden="true" />

// テキストインライン(16px)
<Star size={16} className="inline align-[-2px] mr-1" aria-hidden="true" />
```

---

## UI プリミティブ (Issue #1046)

`src/components/ui/` の共通プリミティブ。すべて `cn()` + セマンティックトークンで
着色し、ライト/ダーク両モードに自動対応する。`@/components/ui` から import する。

- **着色**: セマンティックトークン経由(`bg-surface` / `border-input` / `ring-ring` 等)。直書き色は使わない。
- **SSR**: Radix の Portal 系(Select / Tooltip / DropdownMenu / Switch / Tabs)は `'use client'` 必須。
- **z-index**: Portal コンテンツは `Z_INDEX.POPOVER`(65)で描画され、Modal(50)より前面に出る(`src/config/z-index.ts`)。
- **a11y / キーボード**: Radix 既定のロール・aria 属性・キーボード操作(Tab/矢印/Escape)を壊さない。

### Input / Textarea

ネイティブ要素ベース。`inputSize`(`sm` / `md` / `lg`)で高さを切り替える。

```tsx
import { Input, Textarea } from '@/components/ui';

<Input placeholder="Filter..." value={q} onChange={(e) => setQ(e.target.value)} />
<Input inputSize="sm" aria-label="検索" />
<Textarea rows={4} placeholder="説明" />
```

### Select

`@radix-ui/react-select` ベース。トリガーは `role="combobox"`、項目は `role="option"`。

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';

<Select value={sortKey} onValueChange={setSortKey}>
  <SelectTrigger className="w-40" aria-label="並び替え">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="repositoryName">Repository</SelectItem>
    <SelectItem value="lastSent">Last Sent</SelectItem>
  </SelectContent>
</Select>
```

### Tabs

`underline`(既定)と `pill` の 2 バリアント。`variant` は `Tabs` に渡す。

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';

<Tabs defaultValue="overview" variant="pill">
  <TabsList>
    <TabsTrigger value="overview">概要</TabsTrigger>
    <TabsTrigger value="detail">詳細</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">...</TabsContent>
  <TabsContent value="detail">...</TabsContent>
</Tabs>
```

### Tooltip

`TooltipProvider` でラップして使う(アプリ全体を 1 回で囲ってもよい)。

```tsx
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui';

<TooltipProvider delayDuration={300}>
  <Tooltip>
    <TooltipTrigger aria-label="ヘルプ"><HelpCircle size={16} /></TooltipTrigger>
    <TooltipContent>補足説明</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

### DropdownMenu

`Item` / `CheckboxItem` / `RadioItem` / `Label` / `Separator` を提供。

```tsx
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui';

<DropdownMenu>
  <DropdownMenuTrigger aria-label="操作">…</DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem onSelect={onRename}>名前変更</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={onDelete}>削除</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

### Switch

`role="switch"`。`checked` / `onCheckedChange` で制御する。ラベルは `aria-label` で付与。

```tsx
import { Switch } from '@/components/ui';

<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="通知を有効化" />
```

### Skeleton

`animate-pulse` のローディングプレースホルダ。サイズは `className` で指定。

```tsx
import { Skeleton } from '@/components/ui';

<Skeleton className="h-4 w-32" />
```

---

## 角丸スケール (Border Radius, Issue #1119)

角丸は用途ごとに以下のスケールから選ぶ（Tailwind v3: `sm`=2px / `md`=6px / `lg`=8px）。

| 用途 | クラス | 対象例 |
|------|--------|--------|
| コントロール | `rounded-md` | Button / Input / Select / Textarea / アイコンボタン |
| コンテナ | `rounded-lg` | Card / Modal / Panel |
| ポップアップ面 | `rounded-md` | DropdownMenu / Select content / Tooltip |
| チップ・円形要素 | `rounded-full` | Badge / Switch / StatusDot / RadioGroup / ピル |
| 小型インライン要素 | `rounded-sm` | Checkbox / Kbd / メニュー項目（高さ ~20px 以下） |

- 裸の `rounded`（4px）は**原則禁止**。新規コードでは上記スケールから選択する
- `src/components/ui/` と `src/components/layout/` は本規約に準拠済み。feature 配下に残る
  裸 `rounded` は一括置換せず、該当ファイルを変更する際に随時規約へ寄せる

---

## モーション (Motion, Issue #1050)

マイクロインタラクションは **[`tw-animate-css`](https://github.com/Wombosvideo/tw-animate-css)**
で統一する。`framer-motion` は採用しない（バンドル軽量・Server Components 相性）。

> Issue #1178 で `tailwindcss-animate`（Tailwind 3 専用）から移行した。クラス名の
> 互換性は維持されているため、`animate-in` / `fade-in-0` / `fill-mode-*` などの
> 呼び出し側は変更不要。`src/app/globals.css` の `@import 'tw-animate-css'` で読み込む。

### 規約（duration / easing）

| トークン | 値 | 用途 |
|---------|-----|------|
| `--motion-duration-fast` | 150ms | hover / 状態遷移・小さな要素 |
| `--motion-duration-base` | 200ms | Modal・ドロップダウンの開閉（標準） |
| `--motion-duration-slow` | 300ms | 一覧の stagger 入場など |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 入場（enter）基調 |
| `--motion-stagger-step` | 40ms | 一覧 stagger の 1 件あたり遅延 |

- 定義: [`src/app/globals.css`](../src/app/globals.css) の `:root`（モード非依存のため 1 箇所）。
- Tailwind からは `duration-150` / `duration-200` / `duration-300` で参照する
  （`tw-animate-css` の `duration-*` は `animation-duration` にも適用される）。
- easing は入場を `ease-out` 基調とし、急に現れる印象を避ける。

### enter / exit の標準パターン

- **Modal**（`src/components/ui/Modal.tsx`）: `data-state`（`open` / `closed`）に
  `data-[state=open]:animate-in fade-in-0 zoom-in-95 duration-200`（enter）と
  `data-[state=closed]:animate-out fade-out-0 zoom-out-95 duration-200 fill-mode-forwards`
  （exit）を連動。閉要求後は `useExitAnimation`（Issue #1114）が 200ms 描画を保持し、
  exit アニメ完了後に unmount する。
- **Toast / ContextMenu**: 同じく `useExitAnimation` で unmount を遅延し、Toast は
  `animate-out fade-out-0 slide-out-to-right-full`（200ms）、ContextMenu は
  `animate-out fade-out-0 zoom-out-95`（enter と同じ 100ms）で退場する。JS タイマーは
  `src/config/ui-feedback-config.ts` の `EXIT_ANIMATION_DURATION_MS` /
  `CONTEXT_MENU_EXIT_DURATION_MS` で CSS と同期する。
- **PromptPanel**（`usePromptAnimation`）: `animate-fade-in` / `animate-fade-out`
  （`src/app/globals.css` の `@theme` 内 keyframes、`var(--motion-duration-base)` +
  `var(--motion-ease-out)`）でフェードし、フック内タイマーで unmount を遅延する。
- **MobilePromptSheet**（`src/components/mobile/MobilePromptSheet.tsx`）: 既存の
  `usePromptAnimation` による slide-up（`translate-y-full → 0`）の enter/exit を踏襲。
- **Radix プリミティブ**（Select / DropdownMenu / Tooltip）: Radix の `data-state`
  （`open` / `closed` / Tooltip は `delayed-open`）と `data-side` に連動して
  `animate-in` / `animate-out` + `fade` + `zoom-95` + `slide-in-from-*` を適用。
  Radix が閉時も要素を保持するため exit アニメが再生される。

### 一覧の stagger

`src/lib/utils/stagger.ts` の `STAGGER_ENTER_CLASS` + `staggerDelay(index)` を使う。

- `fill-mode-backwards` で遅延中のみ開始フレーム（不可視）を保持し、入場後は素の
  スタイルへ戻す（後続の hover lift を上書きしない）。
- 最大 10 件程度まで `animation-delay` を段階付与し、それ以降は 0ms。
- **再ポーリングで再発火させない**: 一覧項目は必ず**安定したキー**（例: `wt.id`）を
  付ける。DOM ノードが再利用される限り、CSS アニメは再生されない。`key={index}` の
  ような不安定キーは禁止。

### hover lift / active press

- インタラクティブな **Card** は `interactive` prop（`hover:-translate-y-0.5 hover:shadow-lg`
  + `active:translate-y-0`）。装飾のみの影は従来どおり `hover` prop。
- **Button** は既定で hover lift + active press を持つ（無効時は付与しない）。

### 適用しない領域（重要）

- **ターミナル出力・仮想スクロール領域にはモーションを適用しない**（パフォーマンス優先）。
  xterm.js 描画や `@tanstack/react-virtual` の行にアニメーションクラスを付けないこと。

### `prefers-reduced-motion`

OS の「視差効果を減らす（reduce motion）」設定時は、[`src/app/globals.css`](../src/app/globals.css)
末尾のグローバル `@media (prefers-reduced-motion: reduce)` が全アニメーション/トランジションを
実質無効化する。コンポーネント側でこのメディアクエリを再実装しないこと。
